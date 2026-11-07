import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import DatabaseSync from 'better-sqlite3';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { durableFixture } from './helpers/durable-state-fixture.mjs';
import { JOB, buyer } from './helpers/protocol-fixture.mjs';
const otherJob = JOB.slice(0, -1) + 'B';
const connect = path => { const db = new DatabaseSync(path); db.exec('PRAGMA busy_timeout=0'); return db; };

test('authenticated context and sessions survive close/reopen with independent copies', async t => {
  const f = await durableFixture(t); await f.store.withJob(JOB, () => { f.store.saveSession({ jobId: JOB, TEST: 'saved' }); }); f.store.close();
  const reopened = await f.reopen(); assert.equal(reopened.loadSession(JOB).TEST, 'saved');
  const copy = reopened.loadSession(JOB); copy.TEST = 'changed'; assert.equal(reopened.loadSession(JOB).TEST, 'saved'); reopened.close();
});
for (const damage of ['dropped jobs', 'truncated file', 'missing context', 'extra trigger']) test(`reopening refuses ${damage} without repairing it`, async t => {
  const f = await durableFixture(t); await f.store.withJob(JOB, () => f.store.saveSession({ jobId: JOB })); f.store.close();
  if (damage === 'truncated file') await writeFile(f.path, '');
  else { const db = connect(f.path); db.exec(damage === 'dropped jobs' ? 'DROP TABLE seller_jobs' : damage === 'missing context' ? "DELETE FROM seller_meta WHERE key='context'" : "CREATE TRIGGER TEST_discard BEFORE INSERT ON seller_jobs BEGIN SELECT RAISE(IGNORE); END"); db.close(); }
  await assert.rejects(f.reopen(), error => error.code === 'seller_state_corrupt');
});
test('blocked COMMIT leaves the acquisition revision retryable', async t => {
  const f = await durableFixture(t), reader = connect(f.path);
  await f.store.withJob(JOB, () => {
    reader.exec('BEGIN; SELECT * FROM seller_jobs');
    assert.throws(() => f.store.saveSession({ jobId: JOB, TEST: 'rolled-back' }), /locked/);
    reader.exec('ROLLBACK'); assert.equal(f.store.loadSession(JOB), null);
    f.store.saveSession({ jobId: JOB, TEST: 'committed' });
  });
  reader.close(); assert.equal(f.store.loadSession(JOB).TEST, 'committed'); f.store.close();
});
test('failed lock release is retried before reacquisition and close', async t => {
  const f = await durableFixture(t), blocker = connect(f.path);
  await assert.rejects(f.store.withJob(JOB, () => blocker.exec('BEGIN IMMEDIATE')), /locked/);
  blocker.exec('ROLLBACK');
  await f.store.withJob(JOB, () => f.store.saveSession({ jobId: JOB }));
  assert.equal(f.store.inspectLocks().length, 0);
  await assert.rejects(f.store.withJob(JOB, () => blocker.exec('BEGIN IMMEDIATE')), /locked/);
  blocker.exec('ROLLBACK'); f.store.close(); blocker.close();
  const reopened = await f.reopen(); assert.equal(reopened.inspectLocks().length, 0); reopened.close();
});
for (const actionFails of [false, true]) test(`a task started by a job whose lock release failed is fenced (action ${actionFails ? 'throws' : 'returns'})`, async t => {
  const f = await durableFixture(t), blocker = connect(f.path); let open; const gate = new Promise(resolve => { open = resolve; });
  let save, assertHeld;
  await assert.rejects(f.store.withJob(JOB, () => {
    save = gate.then(() => f.store.saveSession({ jobId: JOB, TEST: 'after the job ended' }));
    assertHeld = gate.then(() => f.store.assertHeld(JOB));
    blocker.exec('BEGIN IMMEDIATE'); if (actionFails) throw new Error('TEST action failed');
  }), actionFails ? /TEST action failed/ : /locked/);
  blocker.exec('ROLLBACK'); open();
  await assert.rejects(save, e => e.code === 'seller_state_fenced'); await assert.rejects(assertHeld, e => e.code === 'seller_state_fenced');
  assert.equal(f.store.loadSession(JOB), null);
  await f.store.withJob(JOB, () => f.store.saveSession({ jobId: JOB, TEST: 'next acquisition' }));
  assert.equal(f.store.loadSession(JOB).TEST, 'next acquisition'); assert.equal(f.store.inspectLocks().length, 0);
  blocker.close(); f.store.close();
});
test('cleanup contention preserves the original action error', async t => {
  const f = await durableFixture(t), blocker = connect(f.path), cause = new Error('TEST action failed');
  await assert.rejects(f.store.withJob(JOB, () => { blocker.exec('BEGIN IMMEDIATE'); throw cause; }), error => error === cause);
  blocker.exec('ROLLBACK'); f.store.close(); blocker.close();
});
test('cleanup contention preserves falsy action failures', async t => {
  const f = await durableFixture(t), blocker = connect(f.path);
  try {
    for (const cause of [undefined, null, false, 0, '']) {
      try {
        await assert.rejects(f.store.withJob(JOB, () => { blocker.exec('BEGIN IMMEDIATE'); throw cause; }), error => Object.is(error, cause));
      } finally { blocker.exec('ROLLBACK'); }
    }
  } finally { blocker.close(); f.store.close(); }
});
test('capacity, canonical IDs and active acquisition ownership fail closed', async t => {
  const f = await durableFixture(t, { maxJobs: 1 });
  await assert.rejects(f.store.withJob('bad:job', () => {}), e => e.code === 'seller_state_job_invalid');
  assert.throws(() => f.store.saveSession({ jobId: JOB }), e => e.code === 'seller_state_fenced');
  await f.store.withJob(JOB, async () => {
    await assert.rejects(f.store.withJob(JOB, () => {}), e => e.code === 'seller_state_busy');
    f.store.saveSession({ jobId: JOB });
  });
  await assert.rejects(f.store.withJob(otherJob, () => {}), e => e.code === 'seller_state_capacity'); f.store.close();
});
test('a lost exact owner row fences subsequent saves', async t => {
  const f = await durableFixture(t), db = connect(f.path);
  await f.store.withJob(JOB, () => { db.prepare('DELETE FROM seller_locks WHERE job=?').run(JOB); assert.throws(() => f.store.saveSession({ jobId: JOB }), e => e.code === 'seller_state_fenced'); });
  db.close(); f.store.close();
});
test('wrong signer, listing context and tampered session signatures refuse', async t => {
  const f = await durableFixture(t); await f.store.withJob(JOB, () => f.store.saveSession({ jobId: JOB })); f.store.close();
  await assert.rejects(createSellerDurableState({ ...f.config, signer: { claim: buyer.claim, sign: buyer.signBytes } }), e => e.code === 'seller_state_corrupt');
  await assert.rejects(createSellerDurableState({ ...f.config, listingPin: { contentHash: 'b'.repeat(64) } }), e => e.code === 'seller_state_corrupt');
  const db = connect(f.path), row = db.prepare('SELECT value FROM seller_jobs WHERE job=?').get(JOB), value = JSON.parse(row.value); value.payload.body.session.TEST = 'tampered';
  db.prepare('UPDATE seller_jobs SET value=? WHERE job=?').run(JSON.stringify(value), JOB); db.close();
  const reopened = await f.reopen(); assert.throws(() => reopened.loadSession(JOB), e => e.code === 'seller_state_corrupt'); reopened.close();
});
