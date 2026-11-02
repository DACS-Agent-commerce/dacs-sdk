// The public protocol factory composed into the public purchase service.
// In the repository the hold constant is flipped by the test resolve hook; from
// a packed switched-copy archive (DACS_PACKED_COMPOSITION=1) the constant is
// already admitted, and this file runs there unchanged (packed-consumer.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

const packed = process.env.DACS_PACKED_COMPOSITION === '1';
let setAdmission = () => {};
if (!packed) {
  const { installPurchaseAdmissionHook, loadAdmissionDouble } = await import('./helpers/purchase-admission-hook.mjs');
  installPurchaseAdmissionHook();
  ({ setPurchaseAdmission: setAdmission } = await loadAdmissionDouble());
}
const { compositionWorld, assertComplete, SellerTlsUnusableError, ACCOUNT_ID, SELLER_ENDPOINT } = await import('./helpers/public-composition-world.mjs');

const admitted = (t) => { setAdmission('testnet-tp1'); t.after(() => setAdmission('held')); };
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function untilContextRead(world) {
  for (let attempts = 0; world.contextReads.count < 1; attempts++) {
    assert.ok(attempts < 200, 'the plan step reads the operator context');
    await settle();
  }
}

test('the public protocol factory composed into the public purchase service prepares a purchase whose saved terms and state are complete (no undefined protocol terms or state)', async (t) => {
  admitted(t);
  const world = await compositionWorld(t);
  const { operation, created } = await world.prepare();
  assert.equal(created, true);
  assert.equal(operation.status, 'agreement_pending');
  assert.equal(typeof operation.terms.protocol.jobId, 'string');
  assert.equal(typeof operation.state.protocol.stage, 'string');
  assertComplete(operation.terms, 'terms');
  assertComplete(operation.state, 'state');
  assertComplete(world.ops.get(ACCOUNT_ID, operation.id).terms.protocol, 'saved terms.protocol');
});

test('a rejected seller admission during prepare creates no purchase row, no coordinates and no event', async (t) => {
  admitted(t);
  let lookups = 0;
  const world = await compositionWorld(t, { sellerEndpoint: () => {
    if (++lookups > 1) throw new SellerTlsUnusableError('TEST-seller-tls-unusable');
    return SELLER_ENDPOINT;
  } });
  const before = world.tableCounts();
  await assert.rejects(world.prepare(), { code: new SellerTlsUnusableError('x').code });
  assert.equal(lookups, 2, 'the service rechecks admission after its own funds read');
  assert.deepEqual(world.tableCounts(), before);
});

test('agreementPlan with no running flight (runningPlan resolves null) starts exactly one plan', async (t) => {
  admitted(t);
  const world = await compositionWorld(t);
  const args = await world.preparedWithIdentity();
  const result = await world.service.agreementPlan(args);
  assert.ok(result.request, 'a plan request was returned');
  assert.ok(result.operation.state.protocol.planned, 'the plan is saved');
  assert.equal(world.contextReads.count, 1);
});

test('a second agreementPlan with the same signatures joins the running flight once and resolves the same plan, and one with other signatures rejects plan_in_progress; planRequest runs once', async (t) => {
  admitted(t);
  let release;
  const world = await compositionWorld(t, { contextGate: new Promise((resolve) => { release = resolve; }) });
  const args = await world.preparedWithIdentity();
  const first = world.service.agreementPlan(args);
  await untilContextRead(world);
  const joined = world.service.agreementPlan({ ...args });
  await assert.rejects(world.service.agreementPlan({ ...args, signature: 'TEST-other-signature' }), { code: 'plan_in_progress' });
  release();
  const [firstPlan, joinedPlan] = await Promise.all([first, joined]);
  assert.deepEqual(joinedPlan, firstPlan);
  assert.ok(firstPlan.request);
  assert.equal(world.contextReads.count, 1, 'one flight ran one plan step');
});

test('the service\'s planRunning stays synchronous and boolean: true during a flight, false after it and false while held, never a Promise and never a throw', async (t) => {
  admitted(t);
  let release;
  const world = await compositionWorld(t, { contextGate: new Promise((resolve) => { release = resolve; }) });
  const args = await world.preparedWithIdentity();
  const running = () => world.service.planRunning(world.ops.get(ACCOUNT_ID, args.operationId));
  const plan = world.service.agreementPlan(args);
  await untilContextRead(world);
  assert.strictEqual(running(), true);
  release();
  await plan;
  assert.strictEqual(running(), false);
  setAdmission('held');
  const heldWorld = await compositionWorld(t);
  const heldOperation = (await heldWorld.ops.createIdempotent({ accountId: ACCOUNT_ID, kind: 'purchase', idempotencyKey: 'TEST-held', request: {}, status: 'agreement_pending',
    terms: { protocol: {} }, termsHash: 'TEST', state: { protocol: {} }, expiresAt: new Date(2e12).toISOString() })).operation;
  assert.strictEqual(heldWorld.service.planRunning(heldOperation), false);
});

test('completionRequest rejects native_completion_held and never resolves an object holding a pending Promise', async (t) => {
  admitted(t);
  const world = await compositionWorld(t);
  const { operation } = await world.prepare();
  const token = world.ops.handoffTokenFor(operation.id);
  world.db.prepare('UPDATE operations SET status = ? WHERE id = ?').run('settled_verified', operation.id);
  await assert.rejects(world.service.completionRequest({ operationId: operation.id, token }), { code: 'native_completion_held' });
});
