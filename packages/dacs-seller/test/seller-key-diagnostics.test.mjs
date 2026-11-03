// Seller key custody diagnostics (P20a, cases 20-12 and 20-14): a failure keeps
// its real cause internally and emits only a fixed code and nonsecret context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import {
  BUYER, SELLER, capturedLog, derivationDouble, importSellerKey, keyFixture, keyRecordBytes, loaderSpy, mnemonicFor, openOptions, refusalOf,
} from './helpers/seller-key-fixture.mjs';

const { openSellerKey } = await importSellerKey();

const encodingsOf = (bytes) => [bytes.toString('hex'), bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('utf8')];
const mnemonic = mnemonicFor(2);
const SECRETS = [Buffer.from(mnemonic), SELLER.seed, keyRecordBytes(mnemonic)];
const secretEncodings = SECRETS.flatMap(encodingsOf);
const withSecrets = (label) => new Error(`${label}: ${secretEncodings.join(' | ')}`, { cause: new Error(`nested ${secretEncodings.join(' | ')}`) });

test('a startup failure while the loader is live retains the original cause internally and emits only a fixed code and nonsecret context, sanitized by the loader\'s redact before destroy (K10-S4), never arbitrary error text or the parsed mnemonic; whole-file redact tokens are not relied on to sanitize individual JSON fields', async (t) => {
  loaderSpy.reset();
  const fixture = keyFixture(t);
  const cause = withSecrets('derivation failed');
  const sink = capturedLog();
  const refusal = await refusalOf(() => openSellerKey(openOptions(fixture, { derivation: derivationDouble({ fail: () => cause }), sink })));
  assert.equal(refusal?.code, 'seller_key_derivation_failed');
  assert.equal(refusal.error.cause, cause, 'the original failure is kept internally');
  assert.deepEqual(sink.lines.map((line) => JSON.parse(line)), [{ code: 'seller_key_derivation_failed' }]);
  const { events } = loaderSpy.calls[0];
  assert.ok(events.includes('redact'), 'the diagnostic went through redact');
  assert.ok(events.indexOf('redact') < events.indexOf('destroy'), 'redact ran while the loader was live, before destroy');
  const secret = await loaderSpy.loadDacsSecretV1({ name: 'dacs-seller-key', mode: 'live-demos', filePath: fixture.filePath });
  assert.equal(secret.redact(mnemonic), mnemonic, 'the whole-file token does not redact the mnemonic field alone');
  secret.destroy();
  assert.ok(!sink.lines.join('\n').includes(mnemonic));
});

test('no mnemonic, derived secret, key-record object or its hex/base64/base64url/UTF-8 encoding appears in captured diagnostics on any custody failure path, nested causes included; mnemonic strings remain an acknowledged non-zeroable limit and arbitrary causes stay internal', async (t) => {
  const paths = {
    'an invalid record': () => openOptions(keyFixture(t, { record: keyRecordBytes(mnemonic, { algorithm: withSecrets('algorithm').message }) })),
    'a loader refusal': () => { const fixture = keyFixture(t); chmodSync(fixture.filePath, 0o644); return openOptions(fixture); },
    'a derivation failure': () => openOptions(keyFixture(t), { derivation: derivationDouble({ fail: () => withSecrets('derive') }) }),
    'a malformed derivation': () => openOptions(keyFixture(t), { derivation: derivationDouble({ privateKeyLength: 31 }) }),
    'a claim mismatch': () => openOptions(keyFixture(t), { listingSeller: BUYER.claim }),
    'a cleanup failure': () => openOptions(keyFixture(t), { derivation: derivationDouble({ cleanupError: withSecrets('cleanup') }) }),
    'a location failure': () => { const fixture = keyFixture(t); chmodSync(fixture.dataDirectory, 0o755); return openOptions(fixture); },
    'a format failure': () => openOptions(keyFixture(t), { keyFormat: withSecrets('format').message }),
  };
  for (const [name, optionsFor] of Object.entries(paths)) {
    loaderSpy.reset();
    const sink = capturedLog();
    const refusal = await refusalOf(() => openSellerKey({ ...optionsFor(), log: sink.log }));
    assert.ok(refusal, `${name} refuses`);
    const visible = [...sink.lines, refusal.error.message, String(refusal.error.code), String(refusal.error.details), JSON.stringify(refusal.error)].join('\n');
    for (const encoding of secretEncodings) assert.ok(!visible.includes(encoding), `${name} leaks ${encoding.slice(0, 12)}`);
    assert.ok(!Object.keys(refusal.error).includes('cause'), `${name}: the cause is not an enumerable property`);
    assert.ok(sink.lines.length >= 1, `${name} logged its fixed code`);
  }
});
