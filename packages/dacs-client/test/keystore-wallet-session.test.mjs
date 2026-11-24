// P49s1 part b: the buyer's keystore wallet entry. Keystores are written here the way the plugin's writer does
// (dacs-plugin stdio-mcp/src/keystore.ts:33-52, :127-129 at 980c45b): JSON.stringify(ks, null, 2) + '\n', base64 members, mode 0600, create only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { api, mnemonicBytes, scriptedNode } from './helpers/tp1-node-fixture.mjs';
import { finalizedWorld } from './helpers/finalized-node-world.mjs';
import { causeChain } from './helpers/node-wallet-signing-spy.mjs';
import { confirmThroughFacade, sha, signedTransaction, signingWallet } from './helpers/seller-facade-confirm.mjs';
// After the fixture installed the admission hook (test/helpers/purchase-admission-hook.mjs): src/ modules load dynamically.
const { createKeystoreWalletOpener, JOURNAL_METHODS } = await import('../src/wallet/keystore-wallet-opener.mjs');
const { passContext } = await import('../src/wallet/pass-context.mjs');
const { OWNER_AUTHORITY, OWNER_ENDPOINT } = await import('./helpers/queued-owner.mjs');

const PASSPHRASE = 'TEST-keystore-passphrase';
const PHRASE = new TextDecoder().decode(mnemonicBytes());
const OTHER_ADDRESS = '0x' + 'ab'.repeat(32);
const N_TEST = 2 ** 14;

const scryptKey = (passphrase, salt, N) => scryptSync(passphrase.normalize('NFKC'), salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 + 1024 * 1024 });

/** The plugin's encryptMnemonic (keystore.ts:33-52), with `plaintext` encrypted as given (the plugin trims it first). */
function keystoreOf(plaintext, { passphrase = PASSPHRASE, N = N_TEST, address } = {}) {
  const salt = randomBytes(32), iv = randomBytes(12), key = scryptKey(passphrase, salt, N);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { version: 1, kdf: 'scrypt', kdfparams: { N, r: 8, p: 1, salt: salt.toString('base64') }, cipher: 'aes-256-gcm',
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), ...(address ? { address } : {}) };
}

/** The plugin's writeKeystore (keystore.ts:127-129): create only, mode 0600. */
function writeKeystore(path, ks) {
  writeFileSync(path, typeof ks === 'string' ? ks : JSON.stringify(ks, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return path;
}

function keystoreDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'keystore-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  return { dir, file: (ks = keystoreOf(PHRASE)) => writeKeystore(join(dir, `ks-${n++}.json`), ks) };
}

// The fixture phrase's address, read once from a composition made the existing way.
let fixtureAddress;
async function addressOfFixture(t) {
  if (!fixtureAddress) { const w = await finalizedWorld(t); await w.build(); fixtureAddress = w.session.wallet.getPublicAccount().address; await w.close(); }
  return fixtureAddress;
}

/**
 * A finalized world whose session is composed by openKeystoreWalletSession over `keystorePath`, with a synchronous stop check. Its owner is
 * the exported transport owner over the world's scripted node (`passOwner`), because an effect pass needs a lease the composition's own owner made.
 */
async function keystoreWorld(t, keystorePath, input = {}) {
  const expectedAddress = await addressOfFixture(t), node = scriptedNode();
  const passOwner = api.createNodeTransportOwner({ endpoint: OWNER_ENDPOINT, transportAuthority: OWNER_AUTHORITY, fetchImpl: node.fetch });
  const w = await finalizedWorld(t, { node, input: { owner: passOwner, keystorePath, passphrase: PASSPHRASE, expectedAddress, stopped: () => false, ...input },
    compose: options => api.openKeystoreWalletSession(Object.fromEntries(Object.entries(options).filter(([name]) => name !== 'key'))) });
  t.after(() => passOwner.close());
  return Object.assign(w, { passOwner });
}

/** Counts the transaction-hash signatures made inside the session's SDK sign, as test/helpers/node-wallet-signing-spy.mjs does. */
async function buildCountingSigns(t, w) {
  const { Demos } = await (await import('../src/wallet/node-demos-loading.mjs')).loadNodeDemos();
  const connect = Demos.prototype.connectWallet;
  let instance;
  t.mock.method(Demos.prototype, 'connectWallet', function spyConnect(...args) { instance = this; return Reflect.apply(connect, this, args); });
  await w.build();
  const sdkCrypto = Object.getPrototypeOf(instance.crypto), innerSign = sdkCrypto.sign, proto = Object.getPrototypeOf(instance), sign = proto.sign;
  const counts = { inner: 0, inSign: 0 };
  t.mock.method(sdkCrypto, 'sign', function spyInner(...args) { counts.inner += 1; return Reflect.apply(innerSign, this, args); });
  t.mock.method(proto, 'sign', async function spySign(...args) {
    const before = counts.inner;
    try { return await Reflect.apply(sign, this, args); } finally { counts.inSign += counts.inner - before; }
  });
  return counts;
}

/** Runs `work` in a plain effect pass (passContext(), no job class) on the owner's fence. */
async function inPlainPass(w, work) {
  const lease = await w.passOwner.acquireConnectionFence();
  try {
    const handle = w.session.effectPass({ fence: lease, deadline: w.clock.now() + 5000, refreshAuthority: () => {}, finalStop: () => {},
      synchronousChecks: [], feeCeilingOs: '50000000000', context: passContext() });
    return await w.session.runInEffectPass(handle, work);
  } finally { lease.release(); }
}

const fakeJournal = () => Object.fromEntries(JOURNAL_METHODS.map(name => [name, async () => undefined]));

/** Valid opener options over `keystorePath` with a synchronous stop and a fake journal; nothing in them opens anything. */
const openerOptions = (keystorePath, extra = {}) => ({ keystorePath, passphrase: PASSPHRASE, expectedAddress: fixtureAddress ?? OTHER_ADDRESS,
  owner: {}, journal: fakeJournal(), approve: async () => true, stopped: () => false, feeCeilingOs: '50000000000', ...extra });

/** A compose double that records each key it receives (never writing to it) and its bytes at the time of the call. */
function composeDouble({ address = () => fixtureAddress, reject = null } = {}) {
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

test("openKeystoreWalletSession composes the buyer's Node wallet from a version-1 keystore, the plugin's own file included, and the composed wallet signs as the keystore's address", async t => {
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
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(counts.inSign, 1);
  assert.equal(w.node.broadcasts.length, 1);
  assert.equal(w.node.broadcasts[0].content.from, address);
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
  assert.equal(Object.keys(manifest.exports).length, 5);
  for (const [entry, path] of Object.entries(manifest.exports)) {
    const names = Object.keys(await import(new URL('../' + path, import.meta.url).href));
    assert.ok(!names.includes('readKeystorePhrase') && !names.includes('createKeystoreWalletOpener'), entry);
  }
  assert.ok(manifest.files.includes('src/wallet/keystore-file.mjs') && manifest.files.includes('src/wallet/keystore-wallet-opener.mjs'), 'both modules ship in the package');
});

test("a buyer session opened through openKeystoreWalletSession refuses a native transaction signature and each confirmTx and broadcastTx body with no current effect pass (effect_pass_required), with zero signatures and zero transport calls, while the same send inside runInEffectPass with a plain pass is signed and sent once; composeNodeWalletSession still sends without a pass; and a pass-rule option is refused before the keystore is read", async t => {
  const files = keystoreDir(t), file = files.file();
  const passRequired = error => causeChain(error).some(cause => cause.code === 'effect_pass_required');
  // A native send: refused outside any pass, signed and sent once inside a plain pass.
  const w = await keystoreWorld(t, file);
  const counts = await buildCountingSigns(t, w);
  const refused = await w.send();
  assert.equal(refused.success, false, JSON.stringify(refused));
  assert.equal(refused.error.code, 'effect_pass_required', JSON.stringify(refused));
  assert.deepEqual({ signs: counts.inSign, effects: w.effects().length, confirms: w.node.confirms.length, broadcasts: w.node.broadcasts.length }, { signs: 0, effects: 0, confirms: 0, broadcasts: 0 });
  const sent = await inPlainPass(w, () => w.send());
  assert.equal(sent.success, true, JSON.stringify(sent));
  assert.deepEqual({ signs: counts.inSign, confirms: w.node.confirms.length, broadcasts: w.node.broadcasts.length }, { signs: 1, confirms: 1, broadcasts: 1 });
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
