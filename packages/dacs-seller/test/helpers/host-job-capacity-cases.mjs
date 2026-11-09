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
    w.advanceTime(2 * 60 * 60 * 1000);
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
}
