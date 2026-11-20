import test from 'node:test';
import assert from 'node:assert/strict';
import { durableFixture } from './helpers/durable-state-fixture.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';

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
