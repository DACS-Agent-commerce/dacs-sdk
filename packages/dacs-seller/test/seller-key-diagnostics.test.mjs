// Seller key custody and lifetime diagnostics (P20a/P20b): failures keep their
// real causes internally and emit only fixed codes and nonsecret context.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync } from 'node:fs';
import fsPromises, { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';
import { privateModule } from './helpers/private-module.mjs';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';
import { composeSellerApproval, createExactOperatorApproval } from '../src/devnet-demo/operator-approval.mjs';
import * as policyFixture from './helpers/d5-policy-fixtures.mjs';
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

// P20b secrets are generated at runtime, including every encoding K10-S8 names.
const runtimeEncodings = encodingsOf(randomBytes(32));
const runtimeFailure = () => Object.assign(new Error(runtimeEncodings.join(' | '), {
  cause: new Error(runtimeEncodings.join(' | ')),
}), { code: runtimeEncodings[0], category: runtimeEncodings[1] });
function assertClosed(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const encoding of runtimeEncodings) assert.ok(!text.includes(encoding), 'a runtime secret encoding was emitted');
  assert.ok(!text.includes('secret-destroyed'));
}
function assertDiagnosticLines(lines) {
  assertClosed(lines.join(''));
  const codes = ['party_vet_writer_failed', 'party_vet_store_failed', 'seller_policy_ledger_unreadable', 'seller_policy_sign_authorization_failed'];
  for (const line of lines) {
    const entry = JSON.parse(line.slice(line.indexOf(': ') + 2));
    assert.ok(codes.includes(entry.code));
    assert.ok(Object.keys(entry).every(key => ['code', 'jobId', 'role', 'operation', 'writerCause', 'ledgerLine'].includes(key)));
  }
}
function stderrCapture(t) {
  const lines = [];
  let unreadable;
  const ledgerWait = new Promise(resolve => { unreadable = resolve; });
  t.mock.method(process.stderr, 'write', line => {
    lines.push(String(line));
    if (String(line).startsWith('seller-policy-ledger unreadable')) unreadable();
    return true;
  });
  return { lines, ledgerWait };
}

test('a failure after the loader is destroyed logs only the closed projection and keeps the original as an internal cause', async t => {
  loaderSpy.reset();
  const key = await openSellerKey(openOptions(keyFixture(t)));
  t.after(() => key.close());
  assert.ok(loaderSpy.calls[0].events.includes('destroy'));
  const { durableOperationStore } = await privateModule(new URL('../src/devnet-demo/agreement-context.mjs', import.meta.url), ['durableOperationStore']);
  const { sellerDiagnostic } = await import('../src/seller-diagnostics.mjs');
  for (const stage of ['signer construction', 'listener construction']) {
    const job = { jobId: JOB, binding: {}, incarnation: stage }, cause = runtimeFailure();
    if (stage === 'listener construction') Object.assign(cause, { code: 'conflict', category: 'substrate' });
    let row = { binding: {}, lifecycle: { incarnation: stage, state: 'open' }, ops: { buyer: { steps: {}, signing: {} } } };
    const state = { serializeStep: (_job, _role, _key, work) => work(), update: async (_job, change) => { row = change(row) ?? row; } };
    const { operationStore } = durableOperationStore(state, job, 'buyer', { now: () => 0, clock: {} });
    let calls = 0;
    const input = { operationKey: stage, operationHash: 'TEST operation', inputHash: 'TEST input', step: 'composite', execute: () => { calls++; throw cause; } };
    const failed = await refusalOf(() => operationStore.runOnce(input));
    assert.equal(failed.error.cause, cause);
    assert.ok(!Object.keys(failed.error).includes('cause'));
    if (stage === 'listener construction') assert.equal(failed.error.category, 'substrate');
    const line = JSON.stringify(sellerDiagnostic(failed.code, { jobId: JOB, error: cause }));
    assertClosed(line);
    assertClosed(row);
    const replayed = await refusalOf(() => operationStore.runOnce(input));
    assert.equal(replayed.code, failed.code);
    assertClosed(replayed.error);
    // A retained failure from an older writer may still contain raw text.
    for (const step of Object.values(row.ops.buyer.steps)) Object.assign(step.error, {
      name: runtimeEncodings[0], message: cause.message, cause: { message: cause.message },
    });
    const legacy = await refusalOf(() => operationStore.runOnce(input));
    assert.equal(legacy.code, failed.code);
    assertClosed(legacy.error.message);
    assertClosed(legacy.error.cause);
    assert.equal(calls, 1, 'the failed step is replayed without executing again');
  }
});

test('after startup, signer, provider-store and approval-ledger failures log only the closed projection', async t => {
  loaderSpy.reset();
  const key = await openSellerKey(openOptions(keyFixture(t)));
  t.after(() => key.close());
  assert.ok(loaderSpy.calls[0].events.includes('destroy'));
  const capture = stderrCapture(t);
  for (const site of ['signer', 'writer throw', 'writer refusal', 'provider-store']) {
    const f = productionFixture();
    t.after(() => f.base.close());
    delete f.config.log; // Exercise the shipped default stderr path.
    const cause = runtimeFailure();
    if (site === 'signer') f.config.wallet.signBytes = () => { throw cause; };
    if (site === 'writer throw') f.anchor.publish = async () => { throw cause; };
    if (site === 'writer refusal') f.anchor.publish = async () => ({ status: 'rejected', reason: cause.message, cause });
    const provider = await f.provider(), before = capture.lines.length;
    let failure;
    if (site === 'provider-store') {
      f.config.store.update = async () => { throw cause; };
      failure = await refusalOf(() => provider.release({ jobId: JOB, generatedAt: f.input().scope.generatedAt }));
      assert.equal(failure.error, cause, 'store failure keeps its identity');
    } else {
      failure = await refusalOf(() => provider.jobVet(f.input().scope, f.input().buyerIdentityBundle, () => true));
    }
    assert.ok(failure, site);
    if (site !== 'provider-store') assertClosed(failure.error.message);
    if (site !== 'signer') assert.ok(capture.lines.length > before, `${site} emitted a diagnostic`);
    assertDiagnosticLines(capture.lines);
    assertClosed(await f.base.entries());
  }
  const { address, seller, sourceBinding, artifactAuthority, pin, T0, requestFor } = policyFixture;
  const ledgerDirectory = await mkdtemp(join(tmpdir(), 'TEST-ledger-'));
  t.after(() => rm(ledgerDirectory, { recursive: true, force: true }));
  const policy = createExactOperatorApproval({ maxTotalOs: '10000000000', evidencePath: join(ledgerDirectory, 'ledger.jsonl'),
    now: () => T0, sellerApproval: { mode: 'policy' },
    policy: { address, seller, sourceBinding, artifactAuthority, listingPin: () => pin, resolvePurchase: () => null } });
  const cause = runtimeFailure();
  const read = t.mock.method(fsPromises, 'readFile', async () => { throw cause; });
  syncBuiltinESMExports();
  t.after(() => { read.mock.restore(); syncBuiltinESMExports(); });
  const pending = refusalOf(() => policy.decide(requestFor({ artifactKind: 'CompositeVerificationRecord' })));
  await capture.ledgerWait;
  await policy.stop();
  assert.equal((await pending).code, 'seller_approval_stopped');
  read.mock.restore();
  syncBuiltinESMExports();
  assertDiagnosticLines(capture.lines);
  let decisions = 0;
  const request = requestFor({ artifactKind: 'CompositeVerificationRecord' });
  const composed = composeSellerApproval({ mode: 'policy', manual: () => true, policy: {
    decide: async () => ++decisions === 1 ? { outcome: 'held', reason: 'seller-record-missing', attemptId: 'TEST attempt', requestBytes: JSON.stringify(request) } : { outcome: 'refused' },
    authorizeHeld: async () => 'unsigned', pause: async () => {}, releaseHeld: async () => {},
  } });
  await composed(request);
  assert.equal(decisions, 2);
  assert.ok(capture.lines.some(line => line.startsWith('seller-policy-sign-authorization failed:')));
  assertDiagnosticLines(capture.lines);
});

test('a commitment failure answer to the buyer carries its code only, never wallet error text', async t => {
  const f = await commitmentFixture(t), { agent } = await f.prepare(), cause = runtimeFailure();
  f.native.publish = async () => { throw cause; };
  const failed = await refusalOf(() => agent.commit({ jobId: JOB }));
  assert.equal(failed.code, 'commitment_failed');
  assert.equal(failed.error.status, 503);
  assert.equal(failed.error.message, 'commitment_failed');
  assert.equal(failed.error.cause.cause, cause, 'the SDK submission wrapper keeps the original wallet cause');
  const { createSellerHttpHandler } = await import('../src/dacs/seller-http.mjs');
  const handler = createSellerHttpHandler({ ...agent, commit: async () => { throw failed.error; } });
  const request = Readable.from([Buffer.from(JSON.stringify({ jobId: JOB }))]);
  Object.assign(request, { url: '/dacs/v1/commitments', method: 'POST', headers: { 'content-type': 'application/json' }, socket: { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1' } });
  let status, body;
  await handler(request, { writeHead: value => { status = value; }, end: value => { body = value; } });
  assert.equal(status, 503);
  assert.deepEqual(JSON.parse(body), { error: 'operation_uncertain', message: 'The seller operation outcome is unavailable; no completion or finality is established.' });
  assertClosed(body);
});

test('closed seller diagnostics refuse unknown codes and hostile context without inspecting secret objects', async () => {
  const { sellerDiagnostic } = await import('../src/seller-diagnostics.mjs');
  let inspected = 0;
  const inspect = () => { inspected++; throw runtimeFailure(); };
  const hostile = new Proxy({}, { get: inspect, getOwnPropertyDescriptor: inspect });
  const context = { jobId: JOB, role: 'buyer', operation: 'release', ledgerLine: 2, message: hostile, cause: hostile, key: hostile };
  assert.deepEqual(sellerDiagnostic('seller_key_closed', context), { code: 'seller_key_closed', jobId: JOB, role: 'buyer', operation: 'release', ledgerLine: 2 });
  for (const code of [runtimeEncodings[0], hostile, null, undefined]) {
    assert.deepEqual(sellerDiagnostic(code, { jobId: runtimeEncodings[1], role: hostile, ledgerLine: Infinity }), { code: 'seller_diagnostic_unknown' });
  }
  assert.deepEqual(sellerDiagnostic('seller_key_closed', hostile), { code: 'seller_key_closed' });
  assert.deepEqual(sellerDiagnostic('seller_key_closed', { get jobId() { inspected++; throw runtimeFailure(); } }), { code: 'seller_key_closed' });
  assert.deepEqual(sellerDiagnostic('seller_key_closed', { jobId: 'x'.repeat(1_000_000), category: hostile, message: hostile }), { code: 'seller_key_closed' });
  for (const code of ['seller_key_unavailable', 'seller_key_location_invalid', 'seller_key_format_invalid', 'seller_key_derivation_failed', 'seller_key_claim_mismatch', 'seller_key_role_refused', 'runtime_unsupported']) {
    assert.deepEqual(sellerDiagnostic(code), { code });
  }
  assert.equal(inspected, 0);
});

test('no environment variable turns message output on in the approval module', async () => {
  const source = await readFile(new URL('../src/devnet-demo/operator-approval.mjs', import.meta.url), 'utf8');
  assert.ok(!source.includes('DACS_TEST_TRACE'));
  assert.ok(!/process\.env/.test(source));
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
