import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@kynesyslabs/dacs';
import { completeWireEffect } from '@kynesyslabs/dacs/wire';
import { sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
import { accountingFixture, JOB, JOB2, CONTEXT } from './helpers/reservation-accounting-fixture.mjs';
import { FIXTURE_PROFILE } from './helpers/wire-authority-fixture.mjs';

const refused = (code, status) => ({ code, status });
// A request admitted at `at` has expired by `at` plus this, so its accounting row can no longer stand for a live request.
const REPLAY_WINDOW_MS = 60000;
const HOUR_MS = 3600000;
const SETTLED_STATES = ['new', 'recover', 'completed'];

// A fixture whose store reads JOB's session from `session.state`, so a test ends the job by setting it to `finalised`.
async function fixtureWithSession(t, options = {}) {
  const session = { state: null };
  const f = await accountingFixture(t, { ...options, contextSessionState: ({ jobId }) => (jobId === JOB ? session.state : null) });
  return { f, session };
}
const settleJob = async (f) => completeWireEffect(f.journal, await f.reserve(await f.admit()), { status: 200, text: '{"proposal":"kept"}' });
const retireJob = (f, session) => {
  session.state = 'finalised'; f.setTime(f.now() + HOUR_MS);
  const port = sellerStoreInternals(f.store());
  port.transaction(() => port.retireSlotsWithin(f.now(), JOB));
  assert.equal(port.db.prepare('SELECT job_retired FROM kit_slot_retirements WHERE job = ?').get(JOB).job_retired, 1);
};
const used = (f) => f.store().boundCapacity.capacityReport().used;
const oldProposal = (f, jobId) => f.store().reserve(f.payload({ jobId }), {}, { keepProfile: FIXTURE_PROFILE });

for (const restart of [false, true]) {
  const after = restart ? ' after restart' : '';

  test(`a retired job's expired settled rows stop counting toward used and free${after}`, async t => {
    const { f, session } = await fixtureWithSession(t);
    await settleJob(f);
    assert.equal(used(f), 1);
    retireJob(f, session);
    if (restart) f.reopen();
    assert.equal(used(f), 0);
    const { free, allotted } = f.store().boundCapacity.capacityReport();
    assert.equal(free, 10000 - allotted);
    assert.equal(f.rows().length, 1, 'the row is kept');
  });

  test(`a retired job's expired witness row frees the store record limit for the accounting path${after}`, async t => {
    const { f, session } = await fixtureWithSession(t, { maxRecords: 1, maxJobs: 5 });
    await settleJob(f);
    f.setTime(f.now() + HOUR_MS);
    await assert.rejects(f.reserve(await f.admit(f.payload({ jobId: JOB2 }))), refused('peer_store_capacity', 503), 'an open job keeps its witness counted');
    retireJob(f, session);
    if (restart) f.reopen();
    assert.equal((await f.reserve(await f.admit(f.payload({ jobId: JOB2 })))).state, 'new');
  });

  test(`a retired job's expired witness row frees the store record limit for the old reserve path${after}`, async t => {
    const { f, session } = await fixtureWithSession(t, { maxRecords: 1, maxJobs: 5 });
    await settleJob(f);
    f.setTime(f.now() + HOUR_MS);
    assert.throws(() => oldProposal(f, JOB2), refused('peer_store_capacity', 503), 'an open job keeps its witness counted');
    retireJob(f, session);
    if (restart) f.reopen();
    assert.equal(oldProposal(f, JOB2).disposition, 'perform');
  });
}

test('every settled state of a retired job\'s witness row stops counting once expired', async t => {
  for (const state of SETTLED_STATES) {
    const { f, session } = await fixtureWithSession(t);
    await settleJob(f);
    f.db.prepare('UPDATE kit_reservations SET state = ?').run(state);
    assert.equal(used(f), 1, state);
    retireJob(f, session);
    assert.equal(used(f), 0, state);
  }
});

test('a job that is not retired keeps its witness row counted after expiry', async t => {
  const f = await accountingFixture(t);
  await settleJob(f);
  f.setTime(f.now() + HOUR_MS);
  assert.equal(used(f), 1);
});

test('a retired job\'s replay counts until its request has expired and is then uncounted, with no row deleted', async t => {
  const { f, session } = await fixtureWithSession(t);
  await settleJob(f);
  retireJob(f, session);
  const replayed = await f.reserve(await f.admit());
  assert.equal(replayed.state, 'completed');
  assert.equal(used(f), 1, 'the replay counts while its request can still be repeated');
  f.setTime(f.now() + REPLAY_WINDOW_MS - 1);
  assert.equal(used(f), 1);
  f.setTime(f.now() + 1);
  assert.equal(used(f), 0);
  assert.deepEqual(f.rows().map(row => row.state), ['new', 'completed'], 'no row is deleted');
});

test('a reserving row of a retired job still counts', async t => {
  const { f, session } = await fixtureWithSession(t);
  await settleJob(f);
  retireJob(f, session);
  f.db.prepare("INSERT INTO kit_reservations SELECT 'k-left-reserving', buyer, jobId, operationId, route, allocationId, class, requestHash, at, 'reserving', NULL, rev FROM kit_reservations LIMIT 1").run();
  assert.equal(used(f), 1);
});

test('a retired job\'s rows on every route stop counting, one witness per route', async t => {
  const { f, session } = await fixtureWithSession(t);
  await settleJob(f);
  f.db.prepare(`INSERT INTO kit_reservations SELECT 'k-context-witness', buyer, jobId, ?, ?, allocationId, class, ?, at, 'completed', NULL, rev FROM kit_reservations`)
    .run(sha256Hex('context operation'), CONTEXT, sha256Hex('context request'));
  assert.equal(used(f), 2);
  retireJob(f, session);
  assert.equal(used(f), 0);
});
