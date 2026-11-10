import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createSellerTransportStore, sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
import { durableFixture } from './helpers/durable-state-fixture.mjs';
import { JOB, NOW, buyer, seller } from './helpers/protocol-fixture.mjs';

const secondJob = JOB.slice(0, -1) + 'B';
const thirdJob = JOB.slice(0, -1) + 'C';

test('retired sessions stay readable while saved and unsaved live jobs hold capacity', async t => {
  const retired = new Set();
  const f = await durableFixture(t, { maxJobs: 1, jobSlotReleased: jobId => retired.has(jobId) });
  t.after(() => f.store.close());
  await f.store.withJob(JOB, () => f.store.saveSession({ jobId: JOB, answer: 'saved' }));
  retired.add(JOB);
  await f.store.withJob(secondJob, async () => {
    await assert.rejects(f.store.withJob(thirdJob, () => {}), { code: 'seller_state_capacity' });
    f.store.saveSession({ jobId: secondJob, answer: 'live' });
  });
  await assert.rejects(f.store.withJob(thirdJob, () => {}), { code: 'seller_state_capacity' });
  await f.store.withJob(JOB, session => assert.equal(session.answer, 'saved'));
  f.store.close();
  const reopened = await f.reopen();
  try {
    assert.equal(reopened.loadSession(JOB).answer, 'saved');
    assert.equal(reopened.loadSession(secondJob).answer, 'live');
    await assert.rejects(reopened.withJob(thirdJob, () => {}), { code: 'seller_state_capacity' });
  } finally { reopened.close(); }
});

test('a terminal session without transport release still holds capacity', async t => {
  const f = await durableFixture(t, { maxJobs: 1 });
  try {
    await f.store.withJob(JOB, () => f.store.saveSession({ jobId: JOB, state: 'finalised' }));
    await assert.rejects(f.store.withJob(secondJob, () => {}), { code: 'seller_state_capacity' });
  } finally { f.store.close(); }
});

test('transport retirement cannot release a durable slot while an active holder remains', async t => {
  let transport;
  const f = await durableFixture(t, { maxJobs: 1, jobSlotReleased: jobId => transport.jobSlotReleased(jobId) });
  transport = createSellerTransportStore({ path: join(f.dir, 'transport.sqlite'), now: () => NOW });
  try {
    await f.store.withJob(JOB, () => f.store.saveSession({ jobId: JOB }));
    const request = { version: '1', kind: 'request', method: 'POST', path: '/dacs/v1/agreements/proposals',
      bodyHash: 'a'.repeat(64), jobId: JOB, buyer: buyer.claim, seller: seller.claim,
      listingPin: { listingId: 'capacity', version: 1, contentHash: 'b'.repeat(64) }, agreementHash: 'c'.repeat(64),
      nonce: Buffer.alloc(16, 1).toString('base64url'), expiresAt: NOW + 30000 };
    transport.finish(transport.reserve(request, {}), 200, '{}');
    const { db } = sellerStoreInternals(transport);
    // A retirement sweep can mark accounted holds before removing the Agreement row.
    db.prepare('INSERT INTO kit_slot_retirements(job, job_retired) VALUES (?, 1)').run(JOB);
    await assert.rejects(f.store.withJob(secondJob, () => {}), { code: 'seller_state_capacity' });
    db.prepare('DELETE FROM peer_jobs WHERE job = ?').run(JOB);
    await f.store.withJob(secondJob, () => f.store.saveSession({ jobId: secondJob }));
    assert.ok(f.store.loadSession(JOB));
  } finally { f.store.close(); transport.close(); }
});
