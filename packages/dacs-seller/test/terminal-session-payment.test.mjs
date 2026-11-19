// A paid native job whose recorded payment did not finish, on a host whose session-state port names a terminal DACS-5 state for the
// job: the buyer's retry of that payment finishes it once, and a later retry answers from the stored outcome.
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePaymentWorld } from './helpers/native-payment-wire-fixture.mjs';

const TERMINAL = 'settle-failed';

// A native world whose session-state port names TERMINAL for each job in `terminal` and answers unknown for every other job.
async function terminalWorld(t) {
  const terminal = new Set();
  const w = await nativePaymentWorld(t, { contextSessionState: ({ jobId }) => (terminal.has(jobId) ? TERMINAL : null) });
  return { w, terminal };
}
// The payment evidence CREATEs, Deliverables and delivery evidence records the node holds for the job.
const delivered = (w, p) => [w.evidenceCreates(p), w.deliverableWrites(p), w.deliveryEvidenceWrites(p)];
const walletSteps = (w) => [w.counts.walletSignatures, w.counts.walletBroadcasts];

// The payment work is saved and the wallet signs the evidence CREATE, which the journal keeps, but its broadcast fails: the attempt ends
// with no outcome and the node holds nothing.
async function cutAtBroadcast(w, p, txHash) {
  w.faults.walletBroadcast = 1;
  const cut = await p.send(txHash);
  assert.notEqual(cut.body.status, 'payment-evidenced');
  assert.equal(w.wireState(p).state, 'ended', 'the attempt ends with no outcome');
  assert.deepEqual([...walletSteps(w), ...delivered(w, p)], [1, 1, 0, 0, 0], 'the evidence CREATE is signed and kept; the node has not received it');
}

async function retryDeliversOnce(w, p, txHash) {
  const retry = await p.send(txHash);
  assert.deepEqual([retry.status, retry.body.status], [200, 'payment-evidenced'], JSON.stringify(retry.body));
  assert.deepEqual(delivered(w, p), [1, 1, 1], 'one evidence CREATE, one Deliverable and one delivery evidence');
  return retry;
}

test('a payment retry after the session reads terminal sends the kept evidence CREATE once and delivers', async (t) => {
  const { w, terminal } = await terminalWorld(t), p = await w.purchase(), txHash = p.pay();
  await cutAtBroadcast(w, p, txHash);
  terminal.add(p.jobId);
  await retryDeliversOnce(w, p, txHash);
  assert.deepEqual(walletSteps(w), [1, 2], 'the kept bytes are sent again; nothing new is signed');
  assert.equal(w.closure(p), null, 'the retry writes no closure');
});

test('a payment retry after a restart finishes the recorded payment when the job is already closed as terminal', async (t) => {
  const { w } = await terminalWorld(t), p = await w.purchase(), txHash = p.pay();
  await cutAtBroadcast(w, p, txHash);
  assert.deepEqual(await w.closeJob(p, TERMINAL), { terminal: true, state: TERMINAL });
  assert.equal(w.closure(p), TERMINAL, 'the closure is kept across the restart');
  await retryDeliversOnce(w, p, txHash);
  assert.deepEqual(walletSteps(w), [1, 2], 'the kept bytes are sent again; nothing new is signed');
});

test('a payment retry after the session reads terminal signs and sends the saved payment work once', async (t) => {
  const { w, terminal } = await terminalWorld(t), p = await w.purchase(), txHash = p.pay();
  w.faults.walletSignature = 1;
  const cut = await p.send(txHash);
  assert.notEqual(cut.body.status, 'payment-evidenced');
  assert.equal(w.wireState(p).state, 'ended', 'the attempt ends with no outcome');
  assert.deepEqual([...walletSteps(w), ...delivered(w, p)], [0, 0, 0, 0, 0], 'the work is saved; the wallet signed and sent nothing');
  terminal.add(p.jobId);
  await retryDeliversOnce(w, p, txHash);
  assert.deepEqual(walletSteps(w), [1, 1], 'the evidence CREATE is signed and sent once');
});

test('a second payment retry under a terminal session answers the delivered payment again with no new effect', async (t) => {
  const { w, terminal } = await terminalWorld(t), p = await w.purchase(), txHash = p.pay();
  await cutAtBroadcast(w, p, txHash);
  terminal.add(p.jobId);
  const first = await retryDeliversOnce(w, p, txHash);
  const settled = { wallet: walletSteps(w), evidenceSignatures: w.counts.evidenceSignatures, sources: w.snapshot(p).sources, outcome: w.wireState(p) };
  assert.equal(settled.outcome.state, 'completed');
  const again = await p.send(txHash);
  assert.deepEqual([again.status, again.body], [200, first.body], 'the stored answer is given again');
  assert.deepEqual({ wallet: walletSteps(w), evidenceSignatures: w.counts.evidenceSignatures, sources: w.snapshot(p).sources, outcome: w.wireState(p) }, settled,
    'no second evidence CREATE, Deliverable or delivery evidence, and nothing is signed or sent');
});
