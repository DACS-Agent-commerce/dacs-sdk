// The buyer's keystore wallet entry and its paid-write refusal and preview. Keystores are written the way the plugin's writer does
// (test/helpers/keystore-world.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agreementRequest, api, mnemonicBytes } from './helpers/tp1-node-fixture.mjs';
import { finalizedWorld } from './helpers/finalized-node-world.mjs';
import { causeChain } from './helpers/node-wallet-signing-spy.mjs';
import { confirmThroughFacade, sha, signedTransaction, signingWallet } from './helpers/seller-facade-confirm.mjs';
import { addressOfFixture, buildCountingSigns, inPlainPass, keystoreDir, keystoreOf, keystoreWorld, knownFixtureAddress, N_TEST, PASSPHRASE, PHRASE, scryptKey } from './helpers/keystore-world.mjs';
// After the fixture installed the admission hook (test/helpers/purchase-admission-hook.mjs): src/ modules load dynamically.
const { createKeystoreWalletOpener, JOURNAL_METHODS } = await import('../src/wallet/keystore-wallet-opener.mjs');
const { nativeWalletLaneKey } = await import('../src/wallet/devnet-native-transport.mjs');

const OTHER_ADDRESS = '0x' + 'ab'.repeat(32);

const fakeJournal = () => Object.fromEntries(JOURNAL_METHODS.map(name => [name, async () => undefined]));

/** Valid opener options over `keystorePath` with a synchronous stop and a fake journal; nothing in them opens anything. */
const openerOptions = (keystorePath, extra = {}) => ({ keystorePath, passphrase: PASSPHRASE, expectedAddress: knownFixtureAddress() ?? OTHER_ADDRESS,
  owner: {}, journal: fakeJournal(), approve: async () => true, stopped: () => false, feeCeilingOs: '50000000000', ...extra });

/** A compose double that records each key it receives (never writing to it) and its bytes at the time of the call. */
function composeDouble({ address = knownFixtureAddress, reject = null } = {}) {
  const calls = [], counts = { close: 0, sent: 0 };
  const compose = async options => {
    calls.push({ options, key: options.key, seen: Buffer.from(options.key).toString('utf8') });
    if (reject) throw reject;
    return { wallet: { getPublicAccount: () => ({ address: address() }), request: async () => { counts.sent += 1; } }, close: async () => { counts.close += 1; } };
  };
  return { compose, calls, counts };
}

const hasCode = code => error => error?.code === code;
const isZeros = bytes => bytes.every(byte => byte === 0);

test("openKeystoreWalletSession composes the buyer's Node wallet from a version-1 keystore and refuses an unpermitted send before signing or execute", async t => {
  const files = keystoreDir(t), address = await addressOfFixture(t);
  // The plugin's write: the default N = 2^17, the trimmed phrase, the informational address and the onboarding member.
  const pluginFile = files.file({ ...keystoreOf(PHRASE, { N: 2 ** 17, address: OTHER_ADDRESS }), onboarding: { createdAt: '2026-11-21T00:00:00.000Z' } });
  const text = readFileSync(pluginFile, 'utf8'), parsed = JSON.parse(text);
  assert.equal(text, JSON.stringify(parsed, null, 2) + '\n');
  assert.deepEqual(Object.keys(parsed), ['version', 'kdf', 'kdfparams', 'cipher', 'iv', 'tag', 'ciphertext', 'address', 'onboarding']);
  const w = await keystoreWorld(t, pluginFile);
  const counts = await buildCountingSigns(t, w);
  assert.equal(w.session.wallet.getPublicAccount().address, address, 'the keystore address the host bound, not the file\'s informational one');
  assert.equal(typeof w.session.binding, 'object');
  const result = await inPlainPass(w, () => w.send());
  assert.equal(result.error?.code, 'paid_approval_required', JSON.stringify(result));
  assert.deepEqual({ signs: counts.inner, effects: w.effects().length, broadcasts: w.node.broadcasts.length }, { signs: 0, effects: 0, broadcasts: 0 });
  // NFKC: a passphrase written as the plugin normalizes it opens with its compatibility form too.
  const nfkc = files.file(keystoreOf(PHRASE, { passphrase: 'TEST-passﬁ-phrase' }));
  for (const passphrase of ['TEST-passﬁ-phrase', 'TEST-passfi-phrase']) {
    const double = composeDouble();
    await createKeystoreWalletOpener({ compose: double.compose })(openerOptions(nfkc, { passphrase }));
    assert.equal(double.calls[0].seen, PHRASE, passphrase);
  }
});

test("every copy of the phrase the entry makes is zero-filled on success, on a composition failure and on an address mismatch, even when the compose function leaves its key untouched, and nothing reachable from the result holds the phrase, the passphrase or the derived key", async t => {
  const files = keystoreDir(t), ks = keystoreOf(PHRASE), file = files.file(ks);
  await addressOfFixture(t);
  const failure = new Error('TEST-compose-failed');
  const outcomes = [
    ['success', composeDouble(), result => assert.equal(typeof result.close, 'function')],
    ['a composition failure', composeDouble({ reject: failure }), error => assert.equal(error, failure)],
    ['an address mismatch', composeDouble({ address: () => OTHER_ADDRESS }), error => assert.equal(error.code, 'keystore_address_mismatch')],
  ];
  for (const [name, double, check] of outcomes) {
    let outcome;
    try { outcome = await createKeystoreWalletOpener({ compose: double.compose })(openerOptions(file)); } catch (error) { outcome = error; }
    check(outcome);
    assert.equal(double.calls.length, 1, name);
    const { key, seen, options } = double.calls[0];
    assert.equal(seen, PHRASE, `${name}: compose received the phrase bytes`);
    assert.ok(key instanceof Uint8Array && key.length === PHRASE.length && isZeros(key), `${name}: the opener zero-filled the key compose left untouched`);
    assert.deepEqual(['keystorePath', 'passphrase', 'expectedAddress'].filter(member => member in options), [], `${name}: compose gets no keystore option`);
  }
  // The real composition: walk every own data property reachable from the result.
  const w = await keystoreWorld(t, file);
  const session = await w.build();
  const derived = scryptKey(PASSPHRASE, Buffer.from(ks.kdfparams.salt, 'base64'), N_TEST), phraseBytes = Buffer.from(PHRASE);
  const seen = new Set(), queue = [session];
  while (queue.length) {
    const value = queue.shift();
    if (typeof value === 'string') { assert.ok(!value.includes(PASSPHRASE) && !value.includes(PHRASE), 'a reachable string holds a secret'); continue; }
    if (ArrayBuffer.isView(value)) {
      const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      assert.ok(!bytes.equals(phraseBytes) && !bytes.equals(derived) && bytes.indexOf(derived) === -1 && bytes.indexOf(phraseBytes) === -1, 'a reachable array holds a secret');
      continue;
    }
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null || seen.has(value)) continue;
    seen.add(value);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if ('value' in descriptor) queue.push(descriptor.value);
  }
  assert.ok(seen.size > 5, 'the walk reached the composition');
});

test("malformed options, a runtime below the floor and a stopped host are refused before the keystore file is opened", async t => {
  const absent = join(mkdtempSync(join(tmpdir(), 'keystore-absent-')), 'missing.json');
  t.after(() => rmSync(join(absent, '..'), { recursive: true, force: true }));
  const double = composeDouble(), open = createKeystoreWalletOpener({ compose: double.compose });
  assert.throws(() => createKeystoreWalletOpener({}), { name: 'TypeError', message: 'compose_required' });
  // Control: the valid options reach the read, which answers keystore_unreadable for the absent file.
  await assert.rejects(open(openerOptions(absent, { expectedAddress: OTHER_ADDRESS })), hasCode('keystore_unreadable'));
  const typeRows = [
    ['a key option', { key: mnemonicBytes() }], ['passRequired', { passRequired: true }], ['jobContextRequired', { jobContextRequired: false }], ['requirePass', { requirePass: true }],
    ['a relative path', { keystorePath: 'wallet.keystore.json' }], ['a numeric path', { keystorePath: 7 }], ['an absent path', { keystorePath: undefined }],
    ['an empty passphrase', { passphrase: '' }], ['a numeric passphrase', { passphrase: 12345678 }],
    ['a malformed address', { expectedAddress: 'TEST-not-an-address' }], ['no address', { expectedAddress: undefined }],
    ['no stopped', { stopped: undefined }], ['a boolean stopped', { stopped: false }], ['no approve', { approve: undefined }],
    ['a zero fee ceiling', { feeCeilingOs: '0' }], ['a decimal fee ceiling', { feeCeilingOs: '1.5' }], ['a numeric fee ceiling', { feeCeilingOs: 5 }],
    ['a journal without its methods', { journal: { get: async () => undefined } }],
  ];
  for (const [name, change] of typeRows) {
    await assert.rejects(open(openerOptions(absent, { expectedAddress: OTHER_ADDRESS, ...change })), error => error instanceof TypeError, name);
  }
  await assert.rejects(open(null), TypeError, 'null options');
  const original = Object.getOwnPropertyDescriptor(process, 'version');
  t.after(() => Object.defineProperty(process, 'version', original));
  for (const version of ['v20.19.0', 'v22.22.1', 'v24.14.0']) {
    Object.defineProperty(process, 'version', { value: version, configurable: true });
    await assert.rejects(open(openerOptions(absent, { expectedAddress: OTHER_ADDRESS })), hasCode('runtime_unsupported'), version);
  }
  Object.defineProperty(process, 'version', original);
  const thrown = new Error('TEST-stop-check');
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const stopRows = [
    ['a stopped host', () => true, 'writes_stopped'], ['a throwing stop check', () => { throw thrown; }, 'stop_check_failed'],
    ['a non-boolean answer', () => 'no', 'stop_check_invalid'], ['a resolving promise', () => Promise.resolve(false), 'stop_check_invalid'],
    ['a rejecting promise', () => Promise.reject(thrown), 'stop_check_invalid'],
  ];
  for (const [name, stopped, code] of stopRows) {
    await assert.rejects(open(openerOptions(absent, { expectedAddress: OTHER_ADDRESS, stopped })), error => error.code === code && (code !== 'stop_check_failed' || error.cause === thrown), name);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, [], 'a refused promise from stopped() leaves no unhandled rejection');
  assert.equal(double.calls.length, 0, 'nothing was composed');
});

test("a keystore that is absent, linked, shared, oversized, malformed, of another version or kdf, or outside the KDF bounds is refused keystore_unreadable, and a wrong passphrase or a changed ciphertext, iv or tag is refused keystore_unlock_failed, with nothing composed", async t => {
  const files = keystoreDir(t), good = keystoreOf(PHRASE);
  const valid = files.file(good);
  const changed = (edit) => { const ks = structuredClone(good); edit(ks); return files.file(ks); };
  const flip = (b64, at = 0) => { const bytes = Buffer.from(b64, 'base64'); bytes[at] ^= 1; return bytes.toString('base64'); };
  const sized = n => randomBytes(n).toString('base64');
  const linked = join(files.dir, 'linked.json'); symlinkSync(valid, linked);
  const directory = join(files.dir, 'directory.json'); mkdirSync(directory, { mode: 0o700 });
  const shared = mode => { const path = files.file(good); chmodSync(path, mode); return path; };
  const text = JSON.stringify(good, null, 2) + '\n';
  const unreadable = [
    ['absent', join(files.dir, 'missing.json')], ['a symbolic link to a valid keystore', linked], ['a directory', directory],
    ['group-readable', shared(0o640)], ['other-readable', shared(0o604)], ['group-writable', shared(0o620)],
    ['over 65,536 bytes', files.file(text + ' '.repeat(65_537 - Buffer.byteLength(text)))],
    ['not JSON', files.file('TEST-not-json\n')], ['a JSON array', files.file('[]\n')], ['JSON null', files.file('null\n')],
    ['no tag', changed(ks => { delete ks.tag; })], ['no kdfparams', changed(ks => { delete ks.kdfparams; })], ['no salt', changed(ks => { delete ks.kdfparams.salt; })],
    ['N as a string', changed(ks => { ks.kdfparams.N = String(N_TEST); })], ['iv as a number', changed(ks => { ks.iv = 12; })],
    ['an address that is not a string', changed(ks => { ks.address = 7; })], ['an onboarding that is not an object', changed(ks => { ks.onboarding = 'yes'; })],
    ['version 2', changed(ks => { ks.version = 2; })], ['version "1"', changed(ks => { ks.version = '1'; })],
    ['kdf pbkdf2', changed(ks => { ks.kdf = 'pbkdf2'; })], ['cipher aes-128-gcm', changed(ks => { ks.cipher = 'aes-128-gcm'; })],
    ['N 2^13', changed(ks => { ks.kdfparams.N = 2 ** 13; })], ['N 2^21', changed(ks => { ks.kdfparams.N = 2 ** 21; })],
    ['N not a power of two', changed(ks => { ks.kdfparams.N = 3 * 2 ** 14; })], ['N not an integer', changed(ks => { ks.kdfparams.N = 16384.5; })],
    ['r 16', changed(ks => { ks.kdfparams.r = 16; })], ['p 2', changed(ks => { ks.kdfparams.p = 2; })],
    ['a 16-byte iv', changed(ks => { ks.iv = sized(16); })], ['a 12-byte tag', changed(ks => { ks.tag = sized(12); })],
    ['a 16-byte salt', changed(ks => { ks.kdfparams.salt = sized(16); })], ['a salt without its base64 padding', changed(ks => { ks.kdfparams.salt = ks.kdfparams.salt.replace(/=+$/, ''); })],
    ['an iv in base64url', changed(ks => { ks.iv = Buffer.from('fbfffbfffbfffbfffbfffbff', 'hex').toString('base64url'); })],
    ['an empty ciphertext', changed(ks => { ks.ciphertext = ''; })],
  ];
  const unlock = [
    ['a wrong passphrase', valid, 'TEST-wrong-passphrase'], ['a changed ciphertext', changed(ks => { ks.ciphertext = flip(ks.ciphertext); })],
    ['a changed iv', changed(ks => { ks.iv = flip(ks.iv); })], ['a changed tag', changed(ks => { ks.tag = flip(ks.tag, 15); })],
  ];
  const double = composeDouble(), open = createKeystoreWalletOpener({ compose: double.compose });
  await addressOfFixture(t);
  const refusedWithout = (path, code, name) => error => {
    assert.equal(error.code, code, name);
    assert.equal(error.name, 'OperationError', name);
    assert.equal(error.cause, undefined, `${name}: no underlying error is carried`);
    for (const secret of [path, PASSPHRASE, 'TEST-wrong-passphrase', files.dir]) assert.ok(!error.message.includes(secret), `${name}: the message echoes nothing`);
    return true;
  };
  for (const [name, path] of unreadable) await assert.rejects(open(openerOptions(path)), refusedWithout(path, 'keystore_unreadable', name));
  for (const [name, path, passphrase] of unlock) await assert.rejects(open(openerOptions(path, passphrase ? { passphrase } : {})), refusedWithout(path, 'keystore_unlock_failed', name));
  assert.equal(double.calls.length, 0, 'nothing was composed');
  // Control: the unchanged file opens.
  await open(openerOptions(valid));
  assert.equal(double.calls.length, 1);
});

test("a decrypted phrase of the wrong shape is refused invalid_mnemonic, and a keystore whose wallet is not the expected address is refused keystore_address_mismatch after the composition is closed", async t => {
  const files = keystoreDir(t), words = PHRASE.split(' ');
  await addressOfFixture(t);
  const wrongShape = [
    ['11 words', words.slice(0, 11).join(' ')], ['13 words', words.slice(0, 13).join(' ')], ['25 words', [...words, words[0]].join(' ')],
    ['an upper-case word', [words[0].toUpperCase(), ...words.slice(1)].join(' ')], ['a digit', [words[0] + '1', ...words.slice(1)].join(' ')],
    ['a non-ASCII letter', ['café', ...words.slice(1)].join(' ')], ['only whitespace', ' \n '], ['a NUL between words', words.join('\u0000')],
  ];
  const double = composeDouble(), open = createKeystoreWalletOpener({ compose: double.compose });
  for (const [name, plaintext] of wrongShape) {
    await assert.rejects(open(openerOptions(files.file(keystoreOf(plaintext)))), error => error.code === 'invalid_mnemonic' && !error.message.includes(words[0]), name);
  }
  assert.equal(double.calls.length, 0, 'nothing was composed for a wrong shape');
  // The plugin's reader normalises whitespace (validateMnemonic, keystore.ts:79-85): surrounding and repeated whitespace reaches compose single-spaced.
  await open(openerOptions(files.file(keystoreOf(`\n ${words.slice(0, 6).join('  ')}\t${words.slice(6).join(' \r\n')} \n`))));
  assert.equal(double.calls[0].seen, PHRASE);
  for (const [name, address] of [['another address', () => OTHER_ADDRESS], ['an unreadable address', () => { throw new Error('TEST-no-account'); }]]) {
    const other = composeDouble({ address });
    await assert.rejects(createKeystoreWalletOpener({ compose: other.compose })(openerOptions(files.file())), hasCode('keystore_address_mismatch'), name);
    assert.deepEqual({ composed: other.calls.length, close: other.counts.close, sent: other.counts.sent }, { composed: 1, close: 1, sent: 0 }, name);
  }
});

test("keystore-file.mjs and keystore-wallet-opener.mjs import no file-writing, SQLite, journal or network module, and no package entry exports readKeystorePhrase or createKeystoreWalletOpener", async () => {
  const allowed = {
    'keystore-file.mjs': { 'node:crypto': ['createDecipheriv', 'scryptSync'], 'node:fs': ['closeSync', 'constants', 'fstatSync', 'lstatSync', 'openSync', 'readSync'], '../client-errors.mjs': ['OperationError'] },
    'keystore-wallet-opener.mjs': { 'node:path': ['isAbsolute'], '../client-errors.mjs': ['OperationError'], '../public-admission.mjs': ['assertPurchaseRuntime'],
      '../signatures.mjs': ['normalizeDemosAddress'], './keystore-file.mjs': ['readKeystorePhrase'] },
  };
  for (const [file, imports] of Object.entries(allowed)) {
    const source = readFileSync(new URL(`../src/wallet/${file}`, import.meta.url), 'utf8');
    const found = Object.fromEntries([...source.matchAll(/^import\s+\{([^}]*)\}\s+from\s+'([^']+)';$/gm)].map(([, names, from]) => [from, names.split(',').map(name => name.trim()).sort()]));
    assert.deepEqual(found, imports, file);
    assert.equal([...source.matchAll(/^import\b/gm)].length, Object.keys(imports).length, `${file}: every import is a named import listed above`);
    assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(|\bfetch\s*\(|\bconsole\.|process\.std(out|err)|writeFile|appendFile|sqlite|journal\.(put|appendUnderLock)/i, file);
  }
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(manifest.exports).length, 6);
  for (const [entry, path] of Object.entries(manifest.exports)) {
    const names = Object.keys(await import(new URL('../' + path, import.meta.url).href));
    assert.ok(!names.includes('readKeystorePhrase') && !names.includes('createKeystoreWalletOpener'), entry);
  }
  assert.ok(manifest.files.includes('src/wallet/keystore-file.mjs') && manifest.files.includes('src/wallet/keystore-wallet-opener.mjs'), 'both modules ship in the package');
});

test("a keystore buyer refuses unpermitted sends inside and outside a plain pass while confirmTx and broadcastTx still require a pass and a non-keystore buyer keeps its Base path", async t => {
  const files = keystoreDir(t), file = files.file();
  const passRequired = error => causeChain(error).some(cause => cause.code === 'effect_pass_required');
  // A native send without an approval: refused outside any pass and inside a plain pass, with nothing signed or sent.
  const w = await keystoreWorld(t, file);
  const counts = await buildCountingSigns(t, w);
  for (const send of [() => w.send(), () => inPlainPass(w, () => w.send())]) {
    const refused = await send();
    assert.deepEqual({ success: refused.success, code: refused.error?.code }, { success: false, code: 'paid_approval_required' }, JSON.stringify(refused));
  }
  assert.deepEqual({ signs: counts.inner, effects: w.effects().length, confirms: w.node.confirms.length, broadcasts: w.node.broadcasts.length }, { signs: 0, effects: 0, confirms: 0, broadcasts: 0 });
  // A confirmTx body on the session's transport outside any pass (its own world: the refused call leaves its signature lease to expire).
  const c = await keystoreWorld(t, files.file());
  await c.build();
  const cWallet = await signingWallet(c);
  await assert.rejects(confirmThroughFacade(c, cWallet, signedTransaction(cWallet, c.request().params[0])), passRequired, 'confirmTx outside a pass');
  assert.deepEqual({ confirms: c.node.confirms.length, effects: c.effects().length }, { confirms: 0, effects: 0 });
  // A broadcastTx body outside any pass, after its confirmTx was acknowledged inside a plain pass.
  const f = await keystoreWorld(t, files.file());
  await f.build();
  const wallet = await signingWallet(f), tx = signedTransaction(wallet, f.request().params[0]);
  const { answer, lease } = await inPlainPass(f, () => confirmThroughFacade(f, wallet, tx));
  assert.equal(answer.response.data.valid, true, 'confirmTx inside a plain pass');
  await f.session.transport.binding({ phase: 'broadcast', address: wallet.address, leaseId: lease.leaseId, hash: tx.hash });
  const identity = 'ed25519:' + wallet.address, timestamp = String(f.clock.now() + 2);
  const headers = { identity, timestamp, signature: wallet.signBytes(Buffer.from(sha(`${identity}:${timestamp}`))).toString('hex') };
  await assert.rejects(f.session.transport.rpc({ method: 'execute', params: [{ extra: 'broadcastTx', data: answer }] }, headers), passRequired, 'broadcastTx outside a pass');
  assert.deepEqual({ confirms: f.node.confirms.length, broadcasts: f.node.broadcasts.length }, { confirms: 1, broadcasts: 0 });
  // Other hosts keep today's rule: composeNodeWalletSession sends without a pass.
  const control = await finalizedWorld(t);
  await control.build();
  assert.equal((await control.send()).success, true);
  assert.equal(control.node.broadcasts.length, 1);
  // The pass rule has no option: each is refused TypeError before the (absent) keystore is read.
  const absent = join(files.dir, 'missing.json');
  for (const change of [{ passRequired: false }, { jobContextRequired: false }, { requirePass: false }, { key: mnemonicBytes() }]) {
    await assert.rejects(api.openKeystoreWalletSession(openerOptions(absent, change)), error => error instanceof TypeError, JSON.stringify(Object.keys(change)));
  }
  await assert.rejects(api.openKeystoreWalletSession(openerOptions(absent)), hasCode('keystore_unreadable'), 'control: without the option the read is reached');
});

const FEE = { feeCeilingOs: '50000000000' };
const records = async w => JSON.stringify(await w.journal.entries());
const stateReads = w => w.node.calls.filter(row => ['getAddressNonce', 'getNetworkParameters', 'getNetworkInfo'].includes(row.body?.params?.[0]?.message)).length;

test('a real keystore native and CREATE request without a permit refuse before every key signature and execute call', async t => {
  const w = await keystoreWorld(t, keystoreDir(t).file());
  const counts = await buildCountingSigns(t, w);
  const create = await agreementRequest(w), signs = counts.inner, reads = stateReads(w);
  const views = [w.session.wallet, w.session.walletFactory({ anchorJournal: w.journal })];
  for (const view of views) {
    for (const request of [w.request(), create]) {
      for (const send of [() => view.request(request), () => view.request(request, { paidApproval: {} }), () => inPlainPass(w, () => view.request(request, { paidApproval: {} }))]) {
        assert.deepEqual(await send(), { success: false, data: null, error: { code: 'paid_approval_required', message: 'a keystore paid write needs a one-use approval of its prepared content; nothing was signed or sent' } });
      }
    }
  }
  // An unsupported transaction shape is refused the same way, before the provider could look at it.
  assert.equal((await w.session.wallet.request({ method: 'sendTransaction', params: [{ content: { type: 'TEST-unsupported' } }] })).error.code, 'paid_approval_required');
  assert.deepEqual({ signs: counts.inner, effects: w.effects().length, reads: stateReads(w), confirms: w.node.confirms.length, broadcasts: w.node.broadcasts.length },
    { signs, effects: 0, reads, confirms: 0, broadcasts: 0 });
});

test('a missing malformed zero or above-session preview fee ceiling refuses without a handle key call or execute', async t => {
  const w = await keystoreWorld(t, keystoreDir(t).file());
  const counts = await buildCountingSigns(t, w);
  const rows = [
    ['no options', undefined, 'invalid_params'], ['empty options', {}, 'invalid_params'], ['an undefined ceiling', { feeCeilingOs: undefined }, 'invalid_params'],
    ['a zero ceiling', { feeCeilingOs: '0' }, 'invalid_params'], ['a leading zero', { feeCeilingOs: '050' }, 'invalid_params'], ['a decimal ceiling', { feeCeilingOs: '1.5' }, 'invalid_params'],
    ['a numeric ceiling', { feeCeilingOs: 5 }, 'invalid_params'], ['an extra option', { ...FEE, retry: true }, 'invalid_params'],
    ['a ceiling above the session ceiling', { feeCeilingOs: '50000000001' }, 'fee_ceiling_above_session'],
  ];
  for (const [name, options, code] of rows) await assert.rejects(w.session.preparePaidWrite(w.request(), options), hasCode(code), name);
  assert.deepEqual({ signs: counts.inner, effects: w.effects().length, reads: stateReads(w) }, { signs: 0, effects: 0, reads: 0 });
  // Control: the session ceiling itself, and a lower one, are accepted.
  for (const feeCeilingOs of ['50000000000', '1']) assert.equal((await w.session.preparePaidWrite(w.request(), { feeCeilingOs })).content.content.feeCeilingOs, feeCeilingOs);
});

test('real keystore native and CREATE previews permit completed retained rows and refuse uncertain rows without a key call or journal write', async t => {
  const w = await keystoreWorld(t, keystoreDir(t).file());
  const counts = await buildCountingSigns(t, w);
  const create = await agreementRequest(w), signs = counts.inner, address = w.session.wallet.getPublicAccount().address;
  const { network, chainIdentity } = w.session.wallet.getWriteProfile().transportBinding;
  const nativeLane = nativeWalletLaneKey({ network, chainIdentity }, address), anchorLane = JSON.stringify([network, chainIdentity, address]);
  const prepares = async request => typeof (await w.session.preparePaidWrite(request, FEE)).prepared === 'object';
  const unchanged = async (step, name) => { const before = await records(w); await step(); assert.equal(await records(w), before, `${name}: no record was written`); };
  await unchanged(async () => assert.ok(await prepares(w.request()) && await prepares(create)), 'empty lanes');
  for (const stage of ['observed', 'failed']) {
    await w.journal.put(nativeLane, { stage, hash: 'a'.repeat(64), nonce: 1 });
    await unchanged(async () => assert.ok(await prepares(w.request()) && await prepares(create)), `a native ${stage} row`);
  }
  await w.journal.put(anchorLane, { lane: anchorLane, stage: 'broadcast-accepted', nonce: 1, hash: 'b'.repeat(64) });
  await unchanged(async () => assert.ok(await prepares(create)), 'a CREATE broadcast-accepted row');
  await w.journal.put(anchorLane, { lane: anchorLane, stage: 'broadcast-started', nonce: 1, hash: 'b'.repeat(64) });
  await unchanged(() => assert.rejects(w.session.preparePaidWrite(create, FEE), hasCode('outcome_unknown')), 'a CREATE broadcast-started row');
  await w.journal.put(nativeLane, { stage: 'broadcast-started', hash: 'a'.repeat(64), nonce: 1 });
  await unchanged(() => assert.rejects(w.session.preparePaidWrite(w.request(), FEE), hasCode('outcome_unknown')), 'a native broadcast-started row');
  assert.deepEqual({ signs: counts.inner, effects: w.effects().length }, { signs, effects: 0 });
});

test('a missing source or locked wallet refuses preview without a handle key call journal write or execute', async t => {
  const w = await keystoreWorld(t, keystoreDir(t).file());
  const counts = await buildCountingSigns(t, w);
  const before = await records(w), request = w.request();
  // The source transport is closed: the lane inspection refuses before any read.
  await w.session.transport.close();
  await assert.rejects(w.session.preparePaidWrite(request, FEE), hasCode('transport_closed'));
  // A locked wallet is refused before any lane or node read.
  w.session.wallet.lock();
  await assert.rejects(w.session.preparePaidWrite(request, FEE), hasCode('locked'));
  assert.deepEqual({ signs: counts.inner, effects: w.effects().length, reads: stateReads(w), records: await records(w) }, { signs: 0, effects: 0, reads: 0, records: before });
  // A wallet locked while the preview reads the node is refused once the reads end, with no handle and nothing written.
  const v = await keystoreWorld(t, keystoreDir(t).file());
  await v.build();
  const lockedRequest = v.request(), lockedBefore = await records(v);
  v.node.intercept = row => { if (row.body?.params?.[0]?.message === 'getNetworkInfo') v.session.wallet.lock(); return null; };
  await assert.rejects(v.session.preparePaidWrite(lockedRequest, FEE), hasCode('locked'));
  assert.deepEqual({ effects: v.effects().length, records: await records(v) }, { effects: 0, records: lockedBefore });
});
