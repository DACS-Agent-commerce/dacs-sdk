// K6: the held admission wrapper. The hold constant is flipped only through the
// test resolve hook (DC-CW1); timers use mock.timers (no sleeps, no wall clock).
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD, TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES } from '@kynesyslabs/dacs/wire';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './helpers/purchase-admission-hook.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';

installPurchaseAdmissionHook();
const { setPurchaseAdmission } = await loadAdmissionDouble();
const { admitPublicFactory, AUTHORITY_READ_DEADLINE_MS } = await import('../src/public-admission.mjs');
const { assertPurchaseActionsAdmitted } = await import('../src/dacs/action-admission.mjs');
const client = await import('../src/index.mjs');

const [FIXTURE_CHAIN_IDENTITY] = TP1_REFUSED_FIXTURE_CHAIN_IDENTITIES;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// A factory whose object records every call with its receiver and arguments.
function recordingFactory() {
  const calls = [], made = [];
  const failure = new Error('TEST-original-failure');
  const factory = () => {
    const inner = {
      available: true,
      completionRequest(...args) { calls.push({ name: 'completionRequest', receiver: this, args }); return 7; },
      asyncAction: async function (...args) { calls.push({ name: 'asyncAction', receiver: this, args }); return { ok: 1 }; },
      throwing(...args) { calls.push({ name: 'throwing', receiver: this, args }); throw failure; },
      rejecting: async function (...args) { calls.push({ name: 'rejecting', receiver: this, args }); throw failure; },
      passiveReader(value) { calls.push({ name: 'passiveReader' }); return value + 1; },
    };
    made.push(inner);
    return inner;
  };
  return { factory, calls, made, failure };
}

async function admittedWorld(t, { construct = true } = {}) {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const world = { ...recordingFactory(), ...await bindFixture() };
  world.admission = { binding: world.binding, currentLocal: world.currentLocal };
  world.wrapped = construct ? admitPublicFactory(world.factory, { passive: ['passiveReader'] })({ admission: world.admission }) : null;
  return world;
}
const refusal = (cause) => (error) => error.code === 'profile_not_admitted' && (cause === undefined || error.cause?.code === cause);

test('held: completionRequest, synchronous inside, returns a rejected Promise profile_not_admitted and is not called (K6-W1)', async (t) => {
  const world = await admittedWorld(t, { construct: false });
  setPurchaseAdmission('held');
  const wrapped = admitPublicFactory(world.factory, { passive: ['passiveReader'] })({ admission: world.admission });
  const result = wrapped.completionRequest({});
  assert.ok(result instanceof Promise);
  await assert.rejects(result, refusal());
  assert.equal(world.calls.length, 0);
});

test('held: an async action rejects profile_not_admitted and is not called (K6-W2)', async (t) => {
  const world = await admittedWorld(t, { construct: false });
  setPurchaseAdmission('held');
  const wrapped = admitPublicFactory(world.factory, { passive: ['passiveReader'] })({ admission: world.admission });
  await assert.rejects(wrapped.asyncAction(), refusal());
  assert.equal(world.calls.length, 0);
});

test('admitted: a synchronous original runs once after the binding check with the protocol object as receiver and its value resolves (K6-W3)', async (t) => {
  const world = await admittedWorld(t);
  const events = [];
  world.authority.state.gate = async () => { events.push('binding-check'); };
  const value = await world.wrapped.completionRequest();
  assert.equal(value, 7);
  assert.equal(world.calls.length, 1);
  assert.equal(world.calls[0].receiver, world.made[0]);
  assert.equal(events.length, 1, 'the binding was checked for this call');
});

test('admitted: an async original\'s resolved object is returned unchanged (K6-W4)', async (t) => {
  const world = await admittedWorld(t);
  assert.deepEqual(await world.wrapped.asyncAction(), { ok: 1 });
  assert.equal(world.calls.length, 1);
});

test('admitted: a thrown or rejected original error keeps its identity (K6-W5)', async (t) => {
  const world = await admittedWorld(t);
  await assert.rejects(world.wrapped.throwing(), (error) => error === world.failure);
  await assert.rejects(world.wrapped.rejecting(), (error) => error === world.failure);
  assert.equal(world.calls.length, 2);
});

test('admitted: a structuredClone of the binding is refused with cause tp1_binding_required and the action is not called (K6-W6)', async (t) => {
  const world = await admittedWorld(t, { construct: false });
  const wrapped = admitPublicFactory(world.factory, {})({ admission: { binding: structuredClone(world.binding), currentLocal: world.currentLocal } });
  await assert.rejects(wrapped.completionRequest(), refusal('tp1_binding_required'));
  assert.equal(world.calls.length, 0);
});

test('admitted: currentLocal naming another connectionId is refused with cause tp1_local_binding_changed (K6-W7)', async (t) => {
  const world = await admittedWorld(t);
  world.current.connectionId = 'vector-conn-2';
  await assert.rejects(world.wrapped.completionRequest(), refusal('tp1_local_binding_changed'));
  assert.equal(world.calls.length, 0);
});

test('construction: a profile, record, identityRecord or actionsAdmitted option throws admission_input_untrusted before any component is built (K6-W8)', async (t) => {
  const world = await admittedWorld(t, { construct: false });
  for (const name of ['profile', 'record', 'identityRecord', 'actionsAdmitted']) {
    assert.throws(() => admitPublicFactory(world.factory, {})({ admission: world.admission, [name]: {} }),
      (error) => error instanceof TypeError && error.message === 'admission_input_untrusted', name);
  }
  assert.equal(world.made.length, 0);
});

test('held: passive protocol methods and purchase-service readers keep their signatures and run (K6-W9)', async (t) => {
  const world = await admittedWorld(t);
  setPurchaseAdmission('held');
  assert.equal(world.wrapped.passiveReader(1), 2);
  assert.equal(world.wrapped.available, true);
  assert.equal(world.calls.length, 1);
});

test('held: Listing verification rejects profile_not_admitted before any Directory or chain read (K6-W10)', async (t) => {
  const world = await admittedWorld(t, { construct: false });
  setPurchaseAdmission('held');
  let reads = 0;
  const forbidden = () => { reads++; throw new Error('unexpected resolution'); };
  const verifier = client.createListingVerifier({ directory: { findSummary: forbidden }, chain: { readStorageProgram: forbidden }, admission: world.admission });
  await assert.rejects(verifier.verify({ listingId: 'TEST-listing', version: 1, seller: 'TEST-seller' }), refusal());
  assert.equal(reads, 0);
});

test('admitted at construction and held at call: rejected and not called (K6-W11)', async (t) => {
  const world = await admittedWorld(t);
  setPurchaseAdmission('held');
  await assert.rejects(world.wrapped.completionRequest(), refusal());
  assert.equal(world.calls.length, 0);
});

test('the original action receives the same argument objects (K6-W12)', async (t) => {
  const world = await admittedWorld(t);
  const first = { id: 1 }, second = ['two'];
  await world.wrapped.completionRequest(first, second);
  assert.equal(world.calls[0].args.length, 2);
  assert.equal(world.calls[0].args[0], first);
  assert.equal(world.calls[0].args[1], second);
});

test('actionsAdmitted is the construction-time snapshot and never authorizes (K6-W13)', async (t) => {
  const world = await admittedWorld(t);
  assert.equal(world.wrapped.actionsAdmitted, true);
  setPurchaseAdmission('held');
  assert.equal(world.wrapped.actionsAdmitted, true, 'the snapshot does not change');
  await assert.rejects(world.wrapped.completionRequest(), refusal());
  const heldWrapped = admitPublicFactory(world.factory, {})({ admission: world.admission });
  setPurchaseAdmission('testnet-tp1');
  assert.equal(heldWrapped.actionsAdmitted, false);
  assert.equal(await heldWrapped.completionRequest(), 7, 'a later change of the constant changes only per-call results');
});

test('admitted: an authority reader that never answers rejects at 10,000 ms with cause tp1_authority_timeout and its late answer invokes nothing (K6-W15, K6-W23)', async (t) => {
  const world = await admittedWorld(t);
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let answer;
  world.authority.state.gate = () => new Promise((resolve) => { answer = resolve; });
  let settled = false;
  const result = world.wrapped.completionRequest().finally(() => { settled = true; });
  const outcome = assert.rejects(result, refusal('tp1_authority_timeout'));
  mock.timers.tick(AUTHORITY_READ_DEADLINE_MS - 1);
  await flush();
  assert.equal(settled, false);
  mock.timers.tick(1);
  await outcome;
  answer();
  await flush();
  assert.equal(world.calls.length, 0);
  assert.equal(AUTHORITY_READ_DEADLINE_MS, 10000);
});

test('admitted: an authority reader rejection is the cause with its identity kept (K6-W16)', async (t) => {
  const world = await admittedWorld(t);
  world.authority.state.failure = new Error('TEST-reader-down');
  await assert.rejects(world.wrapped.completionRequest(), (error) => error.code === 'profile_not_admitted' && error.cause === world.authority.state.failure);
  assert.equal(world.calls.length, 0);
});

test('admitted: a reader naming another chain or a revoked participant is refused with tp1_connection_unverified or tp1_participant_profile_mismatch (K6-W17)', async (t) => {
  const world = await admittedWorld(t);
  world.authority.state.chainIdentity = FIXTURE_CHAIN_IDENTITY;
  await assert.rejects(world.wrapped.completionRequest(), refusal('tp1_connection_unverified'));
  world.authority.state.chainIdentity = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
  world.authority.state.participants = 1;
  await assert.rejects(world.wrapped.completionRequest(), refusal('tp1_participant_profile_mismatch'));
  assert.equal(world.calls.length, 0);
});

test('construction without admission throws admission_required with zero SQLite, journal and custody opens for each factory (K6-W18)', () => {
  let opens = 0;
  const touched = () => new Proxy({}, { get() { opens++; return () => {}; } });
  const options = { db: touched(), store: touched(), ops: touched(), coordinates: touched(), journal: touched(), custody: touched() };
  const refuseWith = (error) => error instanceof TypeError && error.message === 'admission_required';
  for (const factory of [client.createProtocolPurchases, client.createPurchaseService, client.createListingVerifier]) {
    assert.throws(() => factory(options), refuseWith, factory.name);
    assert.throws(() => factory({ ...options, admission: { binding: {} } }), refuseWith, factory.name);
    assert.throws(() => factory({ ...options, admission: { binding: {}, currentLocal: () => ({}), extra: true } }), refuseWith, factory.name);
  }
  assert.equal(opens, 0);
});

test('admitted: a currentLocal throw is the cause (K6-W19)', async (t) => {
  const world = await admittedWorld(t);
  const failure = new Error('TEST-local-unreadable');
  const throwing = admitPublicFactory(world.factory, {})({ admission: { binding: world.binding, currentLocal: () => { throw failure; } } });
  await assert.rejects(throwing.completionRequest(), (error) => error.code === 'profile_not_admitted' && error.cause === failure);
  assert.equal(world.calls.length, 0);
});

test('admitted: currentLocal changes at a barrier inside the binding check and the call is refused tp1_local_binding_changed (K6-W21)', async (t) => {
  const world = await admittedWorld(t);
  world.authority.state.gate = async () => { world.current.connectionId = 'vector-conn-2'; };
  await assert.rejects(world.wrapped.completionRequest(), refusal('tp1_local_binding_changed'));
  assert.equal(world.calls.length, 0);
});

test('admitted: the constant flips to held at the same barrier and the call is refused profile_not_admitted (K6-W22)', async (t) => {
  const world = await admittedWorld(t);
  world.authority.state.gate = async () => { setPurchaseAdmission('held'); };
  await assert.rejects(world.wrapped.completionRequest(), refusal());
  assert.equal(world.calls.length, 0);
});

test('two concurrent calls on one wrapped factory each run their own check and the original at most once each', async (t) => {
  const world = await admittedWorld(t);
  world.authority.state.calls = 0;
  assert.deepEqual(await Promise.all([world.wrapped.completionRequest(), world.wrapped.completionRequest()]), [7, 7]);
  assert.equal(world.authority.state.calls, 2);
  assert.equal(world.calls.length, 2);
});

test('no option, environment variable or argument selects an identity: a self-made record, a mainnet-network record and the fixture chain never yield an admitted binding (K7-BIND-3/4/5)', async (t) => {
  setPurchaseAdmission('held');
  const world = await bindFixture();
  const local = { endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', connectionId: 'vector-conn-1' };
  const bind = (record) => bindTp1Profile({ record, local, readAuthority: world.authority.read });
  await assert.rejects(bind({ ...TP1_APPROVED_IDENTITY_RECORD, recordId: 'self-made/2026-01-01' }), { code: 'tp1_identity_unapproved' });
  await assert.rejects(bind({ ...TP1_APPROVED_IDENTITY_RECORD, network: 'demos-mainnet' }), { code: 'tp1_identity_record_invalid' });
  await assert.rejects(bind({ ...TP1_APPROVED_IDENTITY_RECORD, chainIdentity: FIXTURE_CHAIN_IDENTITY }), { code: 'tp1_identity_fixture' });
  const saved = process.env.DACS_PURCHASE_ADMISSION;
  process.env.DACS_PURCHASE_ADMISSION = 'testnet-tp1';
  t.after(() => { if (saved === undefined) delete process.env.DACS_PURCHASE_ADMISSION; else process.env.DACS_PURCHASE_ADMISSION = saved; });
  const { factory, calls } = recordingFactory();
  const wrapped = admitPublicFactory(factory, {})({ admission: { binding: world.binding, currentLocal: world.currentLocal } });
  await assert.rejects(wrapped.completionRequest(), refusal());
  assert.equal(calls.length, 0);
});

test('every internal admission assertion follows the one constant', async (t) => {
  t.after(() => setPurchaseAdmission('held'));
  setPurchaseAdmission('held');
  assert.throws(() => assertPurchaseActionsAdmitted(), { code: 'profile_not_admitted' });
  setPurchaseAdmission('testnet-tp1');
  assert.equal(assertPurchaseActionsAdmitted(), undefined);
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.mjs') ? [join(dir, entry.name)] : []);
  const refusers = walk(srcDir).filter((path) => readFileSync(path, 'utf8').includes("new OperationError('profile_not_admitted'")).map((path) => path.slice(srcDir.length)).sort();
  assert.deepEqual(refusers, ['public-admission.mjs'], 'every refusal is built by the one helper the constant drives');
});
