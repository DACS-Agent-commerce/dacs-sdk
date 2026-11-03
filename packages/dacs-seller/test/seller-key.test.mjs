// Seller key custody (P20a): the key loads only through loadDacsSecretV1 from
// one absolute file in the kit's private data directory, every owned copy is
// zeroed, and the claim must be the Listing's seller. Cases 20-1 to 20-11, 20-19
// and 20-20. The loader runs for real; a pass-through spy records its calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUYER, KEY_FORMAT, SELLER, allZero, cryptoCalls, derivationDouble, importSellerKey, keyFixture, keyRecordBytes, loaderSpy, mnemonicFor, openOptions,
  refusalOf, validateMnemonic, verifiesUnder,
} from './helpers/seller-key-fixture.mjs';

const { openSellerKey, parseSellerKeyRecord } = await importSellerKey();
const guard = await import('../src/kit-operation-guard.mjs');
const sourceDirectory = fileURLToPath(new URL('../src/', import.meta.url));
const MAX_SECRET_BYTES = 65_536;
const KEY_FILE_NAME_LIMIT = 255;

const ownerOtherThanThisProcess = () => process.getuid() + 1;
async function withProcessVersion(version, run) {
  const original = Object.getOwnPropertyDescriptor(process, 'version');
  Object.defineProperty(process, 'version', { value: version, configurable: true });
  try { return await run(); } finally { Object.defineProperty(process, 'version', original); }
}
async function withProcessUserId(userId, run) {
  const original = process.getuid;
  process.getuid = () => userId;
  try { return await run(); } finally { process.getuid = original; }
}
/** Opens with the DER buffers of the open watched; returns the key or the refusal, plus those buffers. */
async function openWatched(options) {
  cryptoCalls.derBuffers.length = 0;
  cryptoCalls.watching = true;
  try {
    const refusal = await refusalOf(() => openSellerKey(options));
    return { refusal, derBuffers: [...cryptoCalls.derBuffers] };
  } finally { cryptoCalls.watching = false; }
}
function assertEveryOwnedBufferZeroed({ derivation, derBuffers }) {
  const [call] = loaderSpy.calls;
  assert.equal(call.copies.length, 1, 'bytes() is called once');
  assert.ok(call.copies.every(allZero), 'the loader copy is zeroed');
  assert.ok(derivation.record.privateKeys.every(allZero), 'the derived private key is zeroed');
  assert.ok(derivation.record.retained.every(allZero), 'the derivation instance buffers are zeroed through cleanup');
  assert.equal(derivation.record.cleanups, derivation.record.privateKeys.length, 'cleanup runs once per derivation');
  assert.ok(call.events.includes('destroy'), 'the loader is destroyed');
  for (const der of derBuffers) assert.ok(allZero(der), 'the PKCS8 DER buffer is zeroed');
}

test('openSellerKey loads a 0600 key file only through loadDacsSecretV1 with exactly name, live-demos and the absolute filePath', async (t) => {
  loaderSpy.reset();
  const fixture = keyFixture(t);
  const key = await openSellerKey(openOptions(fixture));
  t.after(() => key.close());
  assert.equal(loaderSpy.calls.length, 1);
  assert.deepEqual(loaderSpy.calls[0].options, { name: 'dacs-seller-key', mode: 'live-demos', filePath: fixture.filePath });
  assert.deepEqual(loaderSpy.calls[0].events, ['bytes', 'destroy']);
  assert.equal(key.claim, SELLER.claim);
});

test('a relative key path refuses seller_key_location_invalid before the loader; NUL, missing, wrong-mode, symlink, broken-symlink, directory, empty and oversized paths refuse at the layer that rejects them, with the loader\'s reason code only when a loader call counter shows the loader ran', async (t) => {
  const cases = [
    ['relative', () => 'seller.key', 'seller_key_location_invalid', undefined],
    ['NUL', (f) => `${f.filePath}\0`, 'seller_key_unavailable', 'secret-file-path-invalid'],
    ['missing', (f) => join(f.dataDirectory, 'missing.key'), 'seller_key_unavailable', 'secret-not-found'],
    ['wrong-mode', (f) => { chmodSync(f.filePath, 0o644); return f.filePath; }, 'seller_key_unavailable', 'secret-file-permissions-unsafe'],
    ['symlink', (f) => { symlinkSync(f.filePath, join(f.dataDirectory, 'link.key')); return join(f.dataDirectory, 'link.key'); }, 'seller_key_unavailable', 'secret-file-symlink'],
    ['broken-symlink', (f) => { symlinkSync(join(f.dataDirectory, 'gone.key'), join(f.dataDirectory, 'broken.key')); return join(f.dataDirectory, 'broken.key'); }, 'seller_key_unavailable', 'secret-file-symlink'],
    ['directory', (f) => { mkdirSync(join(f.dataDirectory, 'dir.key')); return join(f.dataDirectory, 'dir.key'); }, 'seller_key_unavailable', 'secret-file-not-regular'],
    ['empty', (f) => { writeFileSync(join(f.dataDirectory, 'empty.key'), '', { mode: 0o600 }); return join(f.dataDirectory, 'empty.key'); }, 'seller_key_unavailable', 'secret-empty'],
    ['oversized file', (f) => { writeFileSync(join(f.dataDirectory, 'big.key'), Buffer.alloc(MAX_SECRET_BYTES + 1, 1), { mode: 0o600 }); return join(f.dataDirectory, 'big.key'); }, 'seller_key_unavailable', 'secret-too-large'],
    ['oversized path', (f) => join(f.dataDirectory, 'k'.repeat(KEY_FILE_NAME_LIMIT + 1)), 'seller_key_unavailable', 'secret-file-unavailable'],
  ];
  for (const [name, pathFor, code, reason] of cases) {
    loaderSpy.reset();
    const fixture = keyFixture(t);
    const derivation = derivationDouble();
    const refusal = await refusalOf(() => openSellerKey(openOptions(fixture, { derivation, filePath: pathFor(fixture) })));
    assert.equal(refusal?.code, code, name);
    assert.equal(refusal?.details, reason, name);
    assert.equal(loaderSpy.calls.length, reason === undefined ? 0 : 1, `${name}: the loader ran only for the layers after the location check`);
    if (reason !== undefined) assert.equal(refusal.error.cause.reasonCode, reason, `${name}: the loader's error is kept as the cause`);
    assert.deepEqual(derivation.record.received, [], `${name}: nothing was derived`);
  }
});

test('a key file owned by another user refuses secret-file-owner-mismatch', async (t) => {
  loaderSpy.reset();
  loaderSpy.controls.loaderUserId = ownerOtherThanThisProcess();
  t.after(() => loaderSpy.reset());
  const refusal = await refusalOf(() => openSellerKey(openOptions(keyFixture(t))));
  assert.deepEqual({ code: refusal?.code, details: refusal?.details }, { code: 'seller_key_unavailable', details: 'secret-file-owner-mismatch' });
  assert.equal(loaderSpy.calls.length, 1);
});

test('a key file replaced between lstat and open refuses secret-file-changed-during-open', async (t) => {
  loaderSpy.reset();
  const fixture = keyFixture(t);
  const originalOpen = fsPromises.open;
  let swapped = false;
  fsPromises.open = async (path, ...rest) => {
    if (path === fixture.filePath && !swapped) {
      swapped = true;
      writeFileSync(`${path}.next`, keyRecordBytes(mnemonicFor(2)), { mode: 0o600 });
      renameSync(`${path}.next`, path);
    }
    return originalOpen(path, ...rest);
  };
  syncBuiltinESMExports();
  t.after(() => { fsPromises.open = originalOpen; syncBuiltinESMExports(); });
  const refusal = await refusalOf(() => openSellerKey(openOptions(fixture)));
  assert.deepEqual({ code: refusal?.code, details: refusal?.details }, { code: 'seller_key_unavailable', details: 'secret-file-changed-during-open' });
});

test('a missing key file fails to start even when an environment variable is set', async (t) => {
  loaderSpy.reset();
  const fixture = keyFixture(t);
  const names = ['DACS_SELLER_KEY', 'DACS_SELLER_KEY_FILE', 'SELLER_KEY'];
  for (const name of names) process.env[name] = keyRecordBytes(mnemonicFor(2)).toString();
  t.after(() => { for (const name of names) delete process.env[name]; });
  const refusal = await refusalOf(() => openSellerKey(openOptions(fixture, { filePath: join(fixture.dataDirectory, 'missing.key') })));
  assert.deepEqual({ code: refusal?.code, details: refusal?.details }, { code: 'seller_key_unavailable', details: 'secret-not-found' });
  assert.deepEqual(Object.keys(loaderSpy.calls[0].options).sort(), ['filePath', 'mode', 'name'], 'no environment option is ever passed');
});

test('parseSellerKeyRecord accepts only the closed record {format:dacs-seller-key/v1, algorithm:ed25519, mnemonic} with an injected valid BIP-39 mnemonic; malformed JSON, missing/extra/wrong fields, a wrong format or algorithm, an invalid mnemonic, a raw 32-byte file or a different seller.json keyFormat refuse seller_key_format_invalid; one loader bytes() copy is zero-filled on every path; injected derive receives exactly the parsed mnemonic', async (t) => {
  const mnemonic = mnemonicFor(2);
  const record = { format: KEY_FORMAT, algorithm: 'ed25519', mnemonic };
  assert.deepEqual(parseSellerKeyRecord(Buffer.from(JSON.stringify(record)), validateMnemonic), record);
  const without = (field) => Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(record).filter(([name]) => name !== field))));
  const malformed = {
    'malformed JSON': Buffer.from('{"format"'), 'a JSON array': Buffer.from('[]'), 'JSON null': Buffer.from('null'), 'bytes that are not UTF-8': Buffer.alloc(32, 0xff),
    'a raw 32-byte file': Buffer.alloc(32, 7), 'a missing format': without('format'), 'a missing algorithm': without('algorithm'), 'a missing mnemonic': without('mnemonic'),
    'an extra field': keyRecordBytes(mnemonic, { note: 'extra' }), 'a wrong format': keyRecordBytes(mnemonic, { format: 'dacs-seller-key/v2' }),
    'a wrong algorithm': keyRecordBytes(mnemonic, { algorithm: 'secp256k1' }), 'a mnemonic that is not text': keyRecordBytes(mnemonic, { mnemonic: 5 }),
    'an invalid mnemonic': keyRecordBytes('not a test mnemonic'),
  };
  for (const [name, bytes] of Object.entries(malformed)) {
    loaderSpy.reset();
    const derivation = derivationDouble();
    const refusal = await refusalOf(() => openSellerKey(openOptions(keyFixture(t, { record: bytes }), { derivation })));
    assert.equal(refusal?.code, 'seller_key_format_invalid', name);
    assert.deepEqual(derivation.record.received, [], `${name}: nothing was derived`);
    assert.equal(loaderSpy.calls[0].copies.length, 1, `${name}: one bytes() copy`);
    assert.ok(loaderSpy.calls[0].copies.every(allZero), `${name}: the copy is zeroed`);
  }
  loaderSpy.reset();
  const otherFormat = await refusalOf(() => openSellerKey(openOptions(keyFixture(t), { keyFormat: 'raw-seed/v0' })));
  assert.equal(otherFormat?.code, 'seller_key_format_invalid');
  assert.equal(loaderSpy.calls.length, 0, 'a different keyFormat refuses before the loader');
  const derivation = derivationDouble();
  const key = await openSellerKey(openOptions(keyFixture(t), { derivation }));
  key.close();
  assert.deepEqual(derivation.record.received, [mnemonic], 'derive receives exactly the parsed mnemonic');
});

test('a derived claim that differs from the Listing\'s seller refuses seller_key_claim_mismatch and zero-fills every copy', async (t) => {
  loaderSpy.reset();
  const derivation = derivationDouble();
  const { refusal, derBuffers } = await openWatched(openOptions(keyFixture(t), { derivation, listingSeller: BUYER.claim }));
  assert.equal(refusal?.code, 'seller_key_claim_mismatch');
  assert.equal(derBuffers.length, 1, 'the key was built before the Listing check');
  assertEveryOwnedBufferZeroed({ derivation, derBuffers });
});

test('the key file must sit in the kit\'s private data directory: real path, owned, exactly mode 0700; 0500, 0600, 0710 and 0755 refuse, 0700 passes, and wrong-owner and non-real paths refuse', async (t) => {
  for (const mode of [0o500, 0o600, 0o710, 0o755]) {
    loaderSpy.reset();
    const fixture = keyFixture(t);
    chmodSync(fixture.dataDirectory, mode);
    const refusal = await refusalOf(() => openSellerKey(openOptions(fixture)));
    assert.equal(refusal?.code, 'seller_key_location_invalid', mode.toString(8));
    assert.equal(loaderSpy.calls.length, 0, `${mode.toString(8)}: refused before the loader`);
  }
  const fixture = keyFixture(t);
  (await openSellerKey(openOptions(fixture))).close();
  const refusedPaths = {
    'another owner': () => withProcessUserId(ownerOtherThanThisProcess(), () => openSellerKey(openOptions(fixture))),
    'a symlinked directory': () => { symlinkSync(fixture.dataDirectory, `${fixture.dataDirectory}-link`); return openSellerKey(openOptions(fixture, { dataDirectory: `${fixture.dataDirectory}-link`, filePath: join(`${fixture.dataDirectory}-link`, 'seller.key') })); },
    'a path that is not the real path': () => openSellerKey(openOptions(fixture, { dataDirectory: `${fixture.dataDirectory}/` })),
    'a key file outside the directory': () => { mkdirSync(join(fixture.dataDirectory, 'sub'), { mode: 0o700 }); return openSellerKey(openOptions(fixture, { filePath: join(fixture.dataDirectory, 'sub', 'seller.key') })); },
    'a relative directory': () => openSellerKey(openOptions(fixture, { dataDirectory: '.' })),
  };
  for (const [name, run] of Object.entries(refusedPaths)) assert.equal((await refusalOf(run))?.code, 'seller_key_location_invalid', name);
});

test('a runtime below 22.13 or in 23.0–23.3 refuses runtime_unsupported before the key file is opened', async (t) => {
  for (const version of ['v20.19.0', 'v22.12.0', 'v23.0.0', 'v23.3.0']) {
    loaderSpy.reset();
    const refusal = await withProcessVersion(version, () => refusalOf(() => openSellerKey(openOptions(keyFixture(t)))));
    assert.deepEqual({ code: refusal?.code, details: refusal?.details }, { code: 'runtime_unsupported', details: version });
    assert.equal(loaderSpy.calls.length, 0, `${version}: no file was opened`);
  }
  for (const version of ['v22.13.0', 'v23.4.0', 'v24.0.0']) {
    const key = await withProcessVersion(version, () => openSellerKey(openOptions(keyFixture(t))));
    assert.equal(key.claim, SELLER.claim, `${version} is admitted`);
    key.close();
  }
});

test('on a Node 20 runtime the key fixtures report a supported version, so keys open on the seller\'s Node 20 CI leg', () => {
  const fixtureUrl = new URL('./helpers/seller-key-fixture.mjs', import.meta.url).href;
  const script = `
    Object.defineProperty(process, 'version', { value: 'v20.19.0', configurable: true });
    const fixture = await import(${JSON.stringify(fixtureUrl)});
    const { openSellerKey } = await fixture.importSellerKey();
    const cleanups = [];
    const key = await openSellerKey(fixture.openOptions(fixture.keyFixture({ after: (cleanup) => cleanups.push(cleanup) })));
    key.close();
    for (const cleanup of cleanups) cleanup();
    process.stdout.write(key.claim === fixture.SELLER.claim ? 'opened' : 'wrong claim');`;
  const child = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(child.stdout, 'opened', child.stderr);
});

test('every transferred or allocated mutable buffer (loader copy, derived private key and seed, the PKCS8 DER buffer, the derivation instance\'s buffers through cleanup) is zero-filled after success, construction failure, claim mismatch and close, and the signer refuses use after close', async (t) => {
  loaderSpy.reset();
  const derivation = derivationDouble();
  const opened = await openWatched(openOptions(keyFixture(t), { derivation }));
  assert.equal(opened.refusal, null);
  assert.equal(opened.derBuffers.length, 1);
  assert.equal(opened.derBuffers[0].length, 48, 'a named 48-byte PKCS8 buffer');
  assertEveryOwnedBufferZeroed({ derivation, derBuffers: opened.derBuffers });
  const key = await openSellerKey(openOptions(keyFixture(t)));
  assert.equal(key.sign(Buffer.from('before close')).length, 64);
  key.close();
  assertEveryOwnedBufferZeroed({ derivation, derBuffers: opened.derBuffers });
  assert.equal((await refusalOf(() => key.sign(Buffer.from('after close'))))?.code, 'seller_key_closed');
  loaderSpy.reset();
  const shortKey = derivationDouble({ privateKeyLength: 31 });
  const construction = await openWatched(openOptions(keyFixture(t), { derivation: shortKey }));
  assert.equal(construction.refusal?.code, 'seller_key_derivation_failed');
  assertEveryOwnedBufferZeroed({ derivation: shortKey, derBuffers: construction.derBuffers });
  loaderSpy.reset();
  const unclaimed = derivationDouble({ claimOf: () => BUYER.claim });
  const mismatch = await openWatched(openOptions(keyFixture(t), { derivation: unclaimed }));
  assert.equal(mismatch.refusal?.code, 'seller_key_claim_mismatch');
  assert.equal(mismatch.derBuffers.length, 1);
  assertEveryOwnedBufferZeroed({ derivation: unclaimed, derBuffers: mismatch.derBuffers });
});

test('two concurrent opens of one key file each zero-fill their own copies, and a reopen after close loads again', async (t) => {
  loaderSpy.reset();
  const fixture = keyFixture(t);
  const [first, second] = [derivationDouble(), derivationDouble()];
  const [a, b] = await Promise.all([openSellerKey(openOptions(fixture, { derivation: first })), openSellerKey(openOptions(fixture, { derivation: second }))]);
  assert.equal(loaderSpy.calls.length, 2);
  for (const call of loaderSpy.calls) assert.ok(call.copies.length === 1 && call.copies.every(allZero), 'each open zeroed its own loader copy');
  assert.notEqual(loaderSpy.calls[0].copies[0].buffer, loaderSpy.calls[1].copies[0].buffer);
  for (const derivation of [first, second]) assert.ok(derivation.record.privateKeys.every(allZero) && derivation.record.retained.every(allZero));
  a.close();
  assert.equal(b.sign(Buffer.from('still open')).length, 64, 'closing one open leaves the other usable');
  b.close();
  const reopened = await openSellerKey(openOptions(fixture));
  assert.equal(loaderSpy.calls.length, 3, 'a reopen after close loads again');
  assert.equal(reopened.claim, SELLER.claim);
  reopened.close();
});

test('no shipped module calls openSellerKey at this head', () => {
  const callers = readdirSync(sourceDirectory, { recursive: true }).filter((name) => name.endsWith('.mjs') && name !== 'seller-key.mjs')
    .filter((name) => readFileSync(join(sourceDirectory, name), 'utf8').includes('openSellerKey'));
  assert.deepEqual(callers, []);
});

test('a signer opened while admitted signs once (control); after a re-hold the same retained capability refuses kit_operation_guard_off with zero signer calls', async (t) => {
  loaderSpy.reset();
  const key = await openSellerKey(openOptions(keyFixture(t)));
  t.after(() => { guard.setKitOperationGuardForTest('testnet-tp1'); key.close(); });
  const message = Buffer.from('effect bytes');
  const before = cryptoCalls.signs;
  assert.ok(verifiesUnder(SELLER, message, key.sign(message)), 'the control signature verifies under the claim');
  assert.equal(cryptoCalls.signs - before, 1);
  guard.setKitOperationGuardForTest('off');
  const refusal = await refusalOf(() => key.sign(message));
  assert.equal(refusal?.code, 'kit_operation_guard_off');
  assert.equal(refusal?.error.entry, 'sellerKey.sign');
  assert.equal(cryptoCalls.signs - before, 1, 'the refused call made no cryptographic signer call');
});

test('custody-reopen-after-rehold: a key reopened after a restart while the guard is re-held loads again, but its effect sign refuses and a signing grant of the earlier open is not restored', async (t) => {
  loaderSpy.reset();
  const fixture = keyFixture(t);
  const message = Buffer.from('effect bytes');
  const earlier = await openSellerKey(openOptions(fixture));
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  assert.equal(earlier.sign(message).length, 64, 'the earlier open signs while admitted');
  earlier.close();
  guard.setKitOperationGuardForTest('off');
  const before = cryptoCalls.signs;
  const reopened = await openSellerKey(openOptions(fixture));
  assert.equal(loaderSpy.calls.length, 2, 'the restart loads the key file again');
  assert.equal(reopened.claim, SELLER.claim, 'opening is not an effect, so it works while off');
  assert.equal((await refusalOf(() => reopened.sign(message)))?.code, 'kit_operation_guard_off');
  assert.equal((await refusalOf(() => earlier.sign(message)))?.code, 'kit_operation_guard_off', 'the closed earlier capability gains nothing from the re-hold');
  assert.equal(cryptoCalls.signs - before, 0, 'no cryptographic signer call while off');
  guard.setKitOperationGuardForTest('testnet-tp1');
  assert.equal(reopened.sign(message).length, 64, 'the reopened key checks the current admission at each call');
  reopened.close();
});
