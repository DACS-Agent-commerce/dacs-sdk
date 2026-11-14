import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import DatabaseSync from 'better-sqlite3';

const readStore = (directory, file, read) => {
  const db = new DatabaseSync(join(directory, file), { readonly: true });
  try { return read(db); } finally { db.close(); }
};
const transportRows = directory => readStore(directory, 'transport/transport.sqlite', db => ({
  retired: db.prepare('SELECT job, job_retired FROM kit_slot_retirements ORDER BY job').all(),
  jobs: db.prepare('SELECT job FROM peer_jobs ORDER BY job').all(),
  holds: db.prepare('SELECT * FROM kit_job_holds ORDER BY jobId').all(),
}));
const retainedRows = directory => readStore(directory, 'seller/seller-state.sqlite', db => ({
  jobs: db.prepare('SELECT * FROM seller_jobs ORDER BY job').all(),
  settlements: db.prepare('SELECT * FROM seller_settlements ORDER BY id').all(),
}));
const effectCounts = w => ({
  creates: w.node.creates.length,
  payments: w.effects.signCreate.length,
  deliveries: w.effects.deliverySubmit.length,
  publications: w.effects.published.length,
  agreements: w.effects.componentSigns.filter(bytes => bytes.startsWith('dacs-payee-bound-agreement:v1:')).length,
});
const savedSession = (directory, job) => JSON.parse(retainedRows(directory).jobs.find(row => row.job === job).value).payload.body.session;
// Payment claims cut off with work left over: what stays unfinished, the lifecycle readings and
// restarts to cover, and the fault that leaves it so.
const UNFINISHED_PAYMENTS = [
  ['its payment evidence is unsigned', ['finalised'], [false, true], async (w, first, claim) => {
    w.faults.signCreate.push('throw');
    assert.equal((await claim()).status, 'held');
    assert.equal(savedSession(w.dataDirectory, first.jobId).nativeEvidenceWork.anchorOutcome, 'not-sent');
  }],
  ['its payment evidence is sent and unread', ['aborted-by-other', 'finalised'], [false, true], async (w, first, claim) => {
    w.faults.broadcast.push('drop');
    const held = await claim();
    assert.deepEqual([held.status, held.readback], ['held', 'indeterminate'], JSON.stringify(held));
    const session = savedSession(w.dataDirectory, first.jobId);
    assert.deepEqual([session.stage, session.nativeEvidenceWork.anchorOutcome], ['native-payment-evidence-held', 'sent']);
  }],
  ['its verified payment has no evidence yet', ['aborted-by-other'], [true], async (w, first, claim) => {
    w.faults.sign.push('throw-evidence');
    const answer = await claim();
    assert.deepEqual([answer.status, answer.reason], ['indeterminate', 'seller_native_evidence_not_started'], JSON.stringify(answer));
    assert.equal(savedSession(w.dataDirectory, first.jobId).nativeEvidenceWork, undefined);
    assert.equal(retainedRows(w.dataDirectory).settlements.length, 1, 'the payment is bound to its job');
  }],
  ['its delivery evidence is unpublished', ['finalised'], [false], async (w, first, claim) => {
    w.faults.artifactPublish.push('SettlementEvidence');
    assert.equal((await claim()).delivery?.evidencePublication, 'held-readback-only');
  }],
  ['its delivery is unsubmitted', ['finalised'], [true], async (w, first, claim) => {
    w.faults.deliverySubmit.push('fail');
    assert.equal((await claim()).error, 'seller_unavailable');
  }],
];

export function hostJobCapacityTests(world) {
  for (const restart of [false, true]) test(`the shipped host admits a new job after paid work retires (restart=${restart})`, async t => {
    const ended = new Set();
    const w = await world(t, { maxJobs: 1, deliveryEvidenceEnabled: true,
      contextSessionState: ({ jobId }) => ended.has(jobId) ? 'finalised' : null });
    const first = await w.purchase(), tx = first.pay(), delivered = await first.claim(tx);
    assert.equal(delivered.status, 'payment-evidenced');
    assert.equal(delivered.delivery?.status, 'delivered');
    const before = retainedRows(w.dataDirectory);
    assert.equal(before.jobs.length, 1);
    assert.ok(before.settlements.length > 0);
    ended.add(first.jobId);
    w.advance(2 * 60 * 60 * 1000);
    if (restart) await w.restart();

    const second = await w.purchase({ commit: false });
    const transport = transportRows(w.dataDirectory);
    assert.ok(transport.retired.some(row => row.job === first.jobId && row.job_retired === 1));
    assert.ok(transport.jobs.every(row => row.job !== first.jobId));
    assert.deepEqual(retainedRows(w.dataDirectory).jobs.map(row => row.job), [first.jobId, second.jobId]);
    assert.deepEqual(retainedRows(w.dataDirectory).jobs[0], before.jobs[0], 'the finished session remains intact');
    assert.deepEqual(retainedRows(w.dataDirectory).settlements, before.settlements);
    assert.ok(transport.holds.some(row => row.jobId === first.jobId), 'payment accounting is retained');

    ended.clear();
    await w.restart();
    const rows = retainedRows(w.dataDirectory), effects = effectCounts(w);
    await assert.rejects(w.purchase({ commit: false }), { code: 'peer_job_capacity', status: 503 });
    assert.deepEqual(retainedRows(w.dataDirectory), rows, 'live work stays counted after restart');
    assert.deepEqual(effectCounts(w), effects, 'refusal creates no work');
    assert.deepEqual(await first.client().propose(first.proposalRequest), first.proposalAnswer, 'the finished proposal returns its saved answer');
    const retry = await first.claim(tx);
    assert.equal(retry.status, 'payment-evidenced');
    assert.equal(retry.delivery?.status, 'delivered');
    assert.equal(retry.delivery.contentHash, delivered.delivery.contentHash);
    assert.equal(retry.settlementId, delivered.settlementId);
    assert.deepEqual(effectCounts(w), effects, 'retries neither charge nor run again');
    assert.deepEqual(retainedRows(w.dataDirectory).settlements, before.settlements);
    assert.deepEqual(transportRows(w.dataDirectory), transport, 'retries do not reclaim a retired slot');
  });

  for (const [work, states, restarts, interrupt] of UNFINISHED_PAYMENTS) for (const state of states) for (const restart of restarts) {
    test(`a job stays counted while ${work}, and its retry finishes (${state}, restart=${restart})`, async t => {
      const ended = new Map();
      const w = await world(t, { maxJobs: 1, deliveryEvidenceEnabled: true,
        contextSessionState: ({ jobId }) => ended.get(jobId) ?? null });
      const first = await w.purchase(), tx = first.pay();
      await interrupt(w, first, () => first.claim(tx));
      const kept = retainedRows(w.dataDirectory);
      ended.set(first.jobId, state);
      w.advance(2 * 60 * 60 * 1000);
      if (restart) await w.restart();

      await assert.rejects(w.purchase({ commit: false }), { code: 'peer_job_capacity', status: 503 });
      assert.deepEqual(transportRows(w.dataDirectory).retired, [], 'unfinished paid work is not retired');
      assert.deepEqual(retainedRows(w.dataDirectory), kept, 'the refused job saves nothing');

      ended.clear();
      await w.restart();
      let answer;
      for (let claim = 0; claim < 3 && answer?.delivery?.status !== 'delivered'; claim++) answer = await first.claim(tx);
      assert.equal(answer.status, 'payment-evidenced', JSON.stringify(answer));
      assert.equal(answer.delivery?.status, 'delivered', JSON.stringify(answer));
      assert.equal(w.effects.signed.length, 1, 'the payment evidence is signed once');
      assert.equal(w.createsAt(`dacs4:deliverable:${first.jobId}`), 1, 'the order is delivered once');

      ended.set(first.jobId, state);
      w.advance(2 * 60 * 60 * 1000);
      const second = await w.purchase({ commit: false });
      assert.ok(transportRows(w.dataDirectory).retired.some(row => row.job === first.jobId && row.job_retired === 1));
      assert.deepEqual(retainedRows(w.dataDirectory).jobs.map(row => row.job), [first.jobId, second.jobId]);
    });
  }

  for (const restart of [false, true]) test(`a job whose only claim found no payment frees its slot once its session ends (restart=${restart})`, async t => {
    const ended = new Set();
    const w = await world(t, { maxJobs: 1, deliveryEvidenceEnabled: true,
      contextSessionState: ({ jobId }) => ended.has(jobId) ? 'aborted-by-other' : null });
    const first = await w.purchase(), unpaid = await first.claim('f'.repeat(64));
    assert.deepEqual(unpaid, { status: 'indeterminate', reason: 'demos-not-found' });
    assert.deepEqual(retainedRows(w.dataDirectory).settlements, [], 'no payment is recorded');
    await assert.rejects(w.purchase({ commit: false }), { code: 'peer_job_capacity', status: 503 });
    ended.add(first.jobId);
    w.advance(2 * 60 * 60 * 1000);
    if (restart) await w.restart();

    const second = await w.purchase({ commit: false });
    assert.ok(transportRows(w.dataDirectory).retired.some(row => row.job === first.jobId && row.job_retired === 1));
    assert.deepEqual(retainedRows(w.dataDirectory).jobs.map(row => row.job), [first.jobId, second.jobId]);
  });
}
