// The payment and bundle routes on the wire journal: a host that dies at each cut of an attempt and reopens over the same store and journal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DELIVERED, PATHS, completions, continuingWorld, operationOf, reconcilingWith } from './helpers/wire-routes-world.mjs';

const WAIT_TURNS = 200;
const REPEATED_ROUTES = [PATHS.commitments, PATHS.bundleRequest, PATHS.bundleCountersignature];
const never = () => new Promise(() => {});

const waitUntil = async (reached) => {
  for (let turn = 0; turn < WAIT_TURNS && !reached(); turn++) await new Promise(setImmediate);
  assert.ok(reached(), 'the awaited step was never reached');
};
// The agent's payment intake, counting each run; the reconciliation after a restart reads what it kept and never runs it again.
const countingIntake = (w, counts) => { w.agent.submitPayment = async () => { counts.intake++; return DELIVERED; }; };
const paymentCompletions = (w) => completions(w).filter((row) => row.route === PATHS.payments);

test('crash between reserve and effect: the lease holds the restarted request, then recovery runs the payment once and completes it', async t => {
  const w = await continuingWorld(t), counts = { entered: 0, intake: 0, reconciled: 0 };
  w.agent.submitPayment = async () => { counts.entered++; return never(); };
  void w.request(PATHS.payments);
  await waitUntil(() => counts.entered === 1);
  assert.equal(operationOf(w, w.jobId, PATHS.payments).state, 'pending', 'the attempt was reserved and the host died before the intake finished');
  w.reopen();
  countingIntake(w, counts);
  w.agent.reconcileTransport = reconcilingWith(PATHS.payments, async ({ body }) => { counts.reconciled++; return { answer: await w.agent.submitPayment(body) }; });
  assert.equal((await w.request(PATHS.payments)).body.error, 'seller_effect_pending', 'a live lease holds the operation across the restart');
  assert.deepEqual({ intake: counts.intake, reconciled: counts.reconciled }, { intake: 0, reconciled: 0 }, 'nothing ran while the lease was live');
  w.state.time += w.leaseMs;
  assert.deepEqual((await w.request(PATHS.payments)).body, DELIVERED);
  assert.deepEqual({ intake: counts.intake, reconciled: counts.reconciled }, { intake: 1, reconciled: 1 },'the payment was taken once, through the reconciliation and not as a fresh route run');
  assert.deepEqual(paymentCompletions(w), [{ route: PATHS.payments, attempt: 1, status: 200, cleanup: 'route' }], 'completed once, on the recovery attempt');
});

test('crash between effect and complete: a payment taken but never completed is reconciled after the restart, never taken again', async t => {
  const w = await continuingWorld(t), counts = { intake: 0 };
  countingIntake(w, counts);
  w.signing.failures = 2;
  assert.equal((await w.request(PATHS.payments)).signed, false, 'the answer could not be signed, so nothing was completed');
  assert.equal(counts.intake, 1);
  assert.deepEqual(paymentCompletions(w), []);
  w.reopen();
  let reconciled = 0;
  w.agent.reconcileTransport = reconcilingWith(PATHS.payments, () => { reconciled++; return { answer: DELIVERED }; });
  assert.equal((await w.request(PATHS.payments)).body.error, 'seller_effect_pending', 'a live lease holds the operation across the restart');
  w.state.time += w.leaseMs;
  assert.deepEqual((await w.request(PATHS.payments)).body, DELIVERED);
  assert.deepEqual({ intake: counts.intake, reconciled }, { intake: 1, reconciled: 1 }, 'the kept payment was reconciled, never taken again');
  assert.deepEqual(paymentCompletions(w), [{ route: PATHS.payments, attempt: 1, status: 200, cleanup: 'route' }], 'completed once');
});

for (const path of REPEATED_ROUTES) {
  test(`a repeat of a completed request on ${path} answers the retained bytes after a restart, with no second effect`, async t => {
    const w = await continuingWorld(t);
    const first = await w.request(path);
    assert.equal(first.status, 200);
    const effects = w.effects(), files = w.journalFiles().length, recorded = completions(w);
    w.reopen();
    const repeated = await w.request(path);
    assert.equal(repeated.text, first.text, 'the retained answer, byte for byte');
    assert.equal(w.effects(), effects, 'the agent ran no second effect');
    assert.equal(w.journalFiles().length, files + 1, 'only the repeat\'s nonce key was added: no new attempt');
    assert.deepEqual(completions(w), recorded, 'no second completion and no second slot return');
  });
}

test('a restart with a pending effect: two requests after the lease start one recovery, and the other is told the effect is pending', async t => {
  const w = await continuingWorld(t), counts = { intake: 0, reconciled: 0 };
  countingIntake(w, counts);
  w.signing.failures = 2;
  await w.request(PATHS.payments);
  w.reopen();
  w.state.time += w.leaseMs;
  let release;
  w.agent.reconcileTransport = reconcilingWith(PATHS.payments, () => new Promise((resolve) => { counts.reconciled++; release = () => resolve({ answer: DELIVERED }); }));
  const recovering = w.request(PATHS.payments);
  await waitUntil(() => release !== undefined);
  assert.equal((await w.request(PATHS.payments)).body.error, 'seller_effect_pending', 'the claimed recovery excludes a second claimant');
  release();
  assert.deepEqual((await recovering).body, DELIVERED);
  assert.deepEqual(counts, { intake: 1, reconciled: 1 }, 'one effect and one recovery');
  assert.deepEqual(paymentCompletions(w), [{ route: PATHS.payments, attempt: 1, status: 200, cleanup: 'route' }], 'completed once, returning the slot once');
});
