// Seller key custody diagnostics (P20a, cases 20-12 and 20-14): a failure keeps
// its real cause internally and emits only a fixed code and nonsecret context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { inspect } from 'node:util';
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
  assert.deepEqual({ code: refusal?.code, details: refusal?.details }, { code: 'seller_key_derivation_failed', details: 'derive' });
  assert.equal(refusal.error.cause, undefined, 'a failure of a step that handles the mnemonic keeps no raw cause, which inspect would print');
  assert.deepEqual(sink.lines.map((line) => JSON.parse(line)), [{ code: 'seller_key_derivation_failed', details: 'derive' }]);
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

// V8's JSON errors quote about ten characters of the text, so the mnemonic's first ten are what a leak shows.
const MNEMONIC_FRAGMENT = mnemonic.slice(0, 10);
const quotingInput = (step) => (input) => new Error(`${step} refused ${input}`);

test('an error from a step that handles the key record or mnemonic prints no mnemonic text: inspect, String(cause) and an uncaught error show only the fixed code and step, for a bare-mnemonic file, a malformed record, bytes that are not UTF-8, and a validator, derivation or cleanup that quotes its input', async (t) => {
  const record = keyRecordBytes(mnemonic).toString();
  const cases = {
    'a bare-mnemonic file': [{ record: Buffer.from(mnemonic) }, {}, 'seller_key_format_invalid', 'json'],
    'a record with an unquoted mnemonic': [{ record: Buffer.from(record.replace(`"${mnemonic}"`, mnemonic)) }, {}, 'seller_key_format_invalid', 'json'],
    'a record that is not UTF-8': [{ record: Buffer.concat([Buffer.from(mnemonic), Buffer.from([0xff])]) }, {}, 'seller_key_format_invalid', 'utf8'],
    'a validator that throws with its input': [{}, { validateMnemonic: (value) => { throw quotingInput('validate')(value); } }, 'seller_key_format_invalid', 'validate'],
    'a derivation that throws with its input': [{}, { derivation: derivationDouble({ fail: quotingInput('derive') }) }, 'seller_key_derivation_failed', 'derive'],
    'a cleanup that throws with the mnemonic': [{}, { derivation: derivationDouble({ cleanupError: quotingInput('cleanup')(mnemonic) }) }, 'seller_key_derivation_failed', 'cleanup'],
  };
  for (const [name, [fixtureOptions, overrides, code, details]] of Object.entries(cases)) {
    loaderSpy.reset();
    const refusal = await refusalOf(() => openSellerKey(openOptions(keyFixture(t, fixtureOptions), overrides)));
    assert.deepEqual({ code: refusal?.code, details: refusal?.details }, { code, details }, name);
    for (const shown of [inspect(refusal.error, { showHidden: true, depth: null }), String(refusal.error.cause)]) {
      assert.ok(!shown.includes(MNEMONIC_FRAGMENT), `${name} prints mnemonic text: ${shown}`);
    }
  }
  const fixtureUrl = new URL('./helpers/seller-key-fixture.mjs', import.meta.url).href;
  const script = `
    const fixture = await import(${JSON.stringify(fixtureUrl)});
    const { openSellerKey } = await fixture.importSellerKey();
    const cleanups = [];
    process.on('exit', () => { for (const cleanup of cleanups) cleanup(); });
    await openSellerKey(fixture.openOptions(fixture.keyFixture({ after: (cleanup) => cleanups.push(cleanup) }, { record: Buffer.from(fixture.mnemonicFor(2)) })));`;
  const child = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 60_000 });
  assert.notEqual(child.status, 0, 'the open fails uncaught');
  assert.match(child.stderr, /seller_key_format_invalid/);
  assert.ok(!child.stderr.includes(MNEMONIC_FRAGMENT), `the uncaught error prints mnemonic text: ${child.stderr}`);
});

test('a log sink that throws never replaces the custody failure it reports', async (t) => {
  loaderSpy.reset();
  const log = () => { throw new Error('TEST sink failed'); };
  const refusal = await refusalOf(() => openSellerKey(openOptions(keyFixture(t, { record: keyRecordBytes(mnemonic, { extra: 1 }) }), { log })));
  assert.equal(refusal?.code, 'seller_key_format_invalid');
});
