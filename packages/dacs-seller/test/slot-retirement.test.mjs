import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSellerTransportStore, sellerStoreInternals, SELLER_CONTEXT_PATH } from '../src/dacs/seller-transport-auth.mjs';
import { FIXTURE_PROFILE } from './helpers/wire-authority-fixture.mjs';
import { accountingFixture, BUYER, SELLER, JOB, JOB2, PIN, T0, CONTEXT, PROPOSALS } from './helpers/reservation-accounting-fixture.mjs';

const HOUR = 3600000;
const LIVE_JOB = '01' + '3'.repeat(24), NEXT_JOB = '01' + 'Z'.repeat(24), CHALLENGE_JOB = '01' + '5'.repeat(24);
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'slot-retirement-'));
  const path = join(directory, 'transport.sqlite');
  let time = T0, store, session = null, reads = 0, sequence = 0;
  const open = () => createSellerTransportStore({ path, now: () => time, maxRecords: 1000, maxJobs: 3, maxNoncesPerBuyerPerWindow: 1000,
    contextSessionState: ({ jobId }) => { reads++; return jobId === JOB ? session : null; }, ...options });
  store = open();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const payload = (jobId = JOB, change = {}) => ({ path: PROPOSALS, method: 'POST', jobId, buyer: BUYER.claim, seller: SELLER.claim,
    listingPin: PIN, agreementHash: 'a'.repeat(64), bodyHash: 'b'.repeat(64), nonce: String(++sequence), expiresAt: time + 60000, ...change });
  return { path, get store() { return store; }, payload, advance: ms => { time += ms; }, terminal: value => { session = value; },
    reads: () => reads, reopen: () => { store.close(); store = open(); }, now: () => time };
}

test('completed proposal and payment retries stay cached with spare job capacity after restart', t => {
  const w = fixture(t), first = w.payload();
  w.store.finish(w.store.reserve(first, {}, { keepProfile: FIXTURE_PROFILE }), 200, '{"proposal":"kept"}');
  const payment = w.payload(JOB, { path: '/dacs/v1/payments' });
  w.store.finish(w.store.reserve(payment, { txHash: 'c'.repeat(64) }, { keepProfile: FIXTURE_PROFILE }), 200, '{"payment":"received"}');
  w.terminal('finalised'); w.advance(61000);
  w.store.reserve(w.payload(JOB2), {}, { keepProfile: FIXTURE_PROFILE });
  w.terminal(null); w.reopen();
  assert.deepEqual(w.store.reserve(w.payload(), {}, { keepProfile: FIXTURE_PROFILE }), { disposition: 'cached', status: 200, text: '{"proposal":"kept"}' });
  assert.deepEqual(w.store.reserve(w.payload(JOB, { path: payment.path }), { txHash: 'c'.repeat(64) }, { keepProfile: FIXTURE_PROFILE }), { disposition: 'cached', status: 200, text: '{"payment":"received"}' });
});

test('retired jobs reject fresh work after restart with unknown session state', t => {
  const w = fixture(t), first = w.payload();
  w.store.finish(w.store.reserve(first, {}, { keepProfile: FIXTURE_PROFILE }), 200, '{}');
  w.terminal('finalised'); w.advance(61000);
  const port = sellerStoreInternals(w.store);
  port.transaction(() => port.retireSlotsWithin(w.now(), JOB));
  w.terminal(null); w.reopen();
  assert.throws(() => w.store.reserve(w.payload(), {}, { keepProfile: FIXTURE_PROFILE }), { code: 'context_session_terminal', status: 409 });
});

test('one reserve below capacity does not read every finished job session', t => {
  const w = fixture(t, { maxJobs: 1000 });
  for (let i = 0; i < 300; i++) {
    const jobId = '01' + i.toString(16).padStart(24, '0').toUpperCase();
    w.store.finish(w.store.reserve(w.payload(jobId), {}, { keepProfile: FIXTURE_PROFILE }), 200, '{}');
  }
  w.advance(2 * HOUR);
  const before = w.reads();
  w.store.reserve(w.payload(JOB2), {}, { keepProfile: FIXTURE_PROFILE });
  assert.equal(w.reads() - before, 1);
});

test('a context-first challenge retires an ended old-route slot without other traffic', t => {
  const w = fixture(t, { maxContextRecords: 1 });
  const p = w.payload(JOB, { path: SELLER_CONTEXT_PATH });
  w.store.finish(w.store.reserve(p, { scope: { jobId: JOB } }, { admit: w.now }), 200, '{}');
  w.terminal('finalised'); w.advance(HOUR + 61000);
  const store = createSellerTransportStore({ path: w.path, now: w.now, maxContextRecords: 1,
    contextSessionState: ({ jobId }) => jobId === JOB ? 'finalised' : null });
  try {
    assert.ok(store.challenges.issue({ jobId: JOB2, buyer: BUYER.claim }, 'c'.repeat(64)).sessionNonce);
    assert.equal(sellerStoreInternals(store).admissionCounts().contextRecords, 0);
  } finally { store.close(); }
});

test('an accounted context start retires an ended old-route slot without other traffic', async t => {
  const f = await accountingFixture(t, { maxContextRecords: 1, contextSessionState: ({ jobId }) => jobId === JOB ? 'finalised' : null });
  // Start with an unknown session, then reopen with terminal evidence after completion.
  const seed = createSellerTransportStore({ path: f.path, now: f.now, maxContextRecords: 1 });
  const p = f.payload({ path: CONTEXT });
  seed.finish(seed.reserve(p, { scope: { jobId: JOB } }, { admit: f.now }), 200, '{}'); seed.close();
  f.setTime(T0 + HOUR + 61000);
  const next = f.payload({ path: CONTEXT, jobId: JOB2 });
  const result = await f.reserve(f.args(next));
  assert.equal(result.state, 'new');
});

function retainedContextProof(t, options = {}) {
  const w = fixture(t, { maxJobs: 2, maxContextRecords: 2, ...options });
  const first = w.payload(JOB, { path: CONTEXT });
  w.store.finish(w.store.reserve(first, { scope: { jobId: JOB } }, { admit: w.now }), 200, '{}');
  w.advance(HOUR + 61000);
  w.store.reserve(w.payload(LIVE_JOB, { path: CONTEXT }), { scope: { jobId: LIVE_JOB } }, { admit: w.now });
  w.terminal('finalised');
  w.store.challenges.issue({ jobId: CHALLENGE_JOB, buyer: BUYER.claim }, 'c'.repeat(64));
  const db = sellerStoreInternals(w.store).db;
  assert.deepEqual(db.prepare('SELECT job_retired, context_retired FROM kit_slot_retirements WHERE job = ?').get(JOB),
    { job_retired: 1, context_retired: 1 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_context_admissions WHERE job = ?').get(JOB).n, 1);
  return w;
}

test('a retained retired context proof cannot free a job slot twice', t => {
  const w = retainedContextProof(t);
  w.store.reserve(w.payload(NEXT_JOB), {}, { keepProfile: FIXTURE_PROFILE });
  assert.throws(() => w.store.reserve(w.payload(JOB2, { path: CONTEXT }), { scope: { jobId: JOB2 } }, { admit: w.now }),
    { code: 'peer_job_capacity', status: 503 });
  assert.equal(sellerStoreInternals(w.store).admissionCounts().contextRecords, 1);
});

test('a retained retired context proof cannot free a context slot twice', async t => {
  const w = retainedContextProof(t, { maxJobs: 10 });
  const f = await accountingFixture(t, { maxJobs: 10, maxContextRecords: 2 });
  f.setTime(w.now());
  const next = f.payload({ jobId: NEXT_JOB, path: CONTEXT });
  assert.equal((await w.store.reservationAccounting.reserveAccounted(f.args(next))).state, 'new');
  assert.equal(sellerStoreInternals(w.store).admissionCounts().contextRecords, 2);
  assert.throws(() => w.store.reserve(w.payload(JOB2, { path: CONTEXT }), { scope: { jobId: JOB2 } }, { admit: w.now }),
    { code: 'peer_context_capacity', status: 503 });
});

test('one reserve reuses a genuinely reclaimable job and context slot', t => {
  const w = fixture(t, { maxJobs: 1, maxContextRecords: 1 });
  const first = w.payload(JOB, { path: CONTEXT });
  w.store.finish(w.store.reserve(first, { scope: { jobId: JOB } }, { admit: w.now }), 200, '{}');
  w.advance(HOUR + 61000); w.terminal('finalised');
  assert.equal(w.store.reserve(w.payload(JOB2, { path: CONTEXT }), { scope: { jobId: JOB2 } }, { admit: w.now }).disposition, 'perform');
  const port = sellerStoreInternals(w.store);
  assert.equal(port.admissionCounts().contextRecords, 1);
  assert.deepEqual(port.db.prepare('SELECT job FROM peer_context_admissions').all(), [{ job: JOB2 }]);
  assert.equal(port.db.prepare('SELECT job_retired FROM kit_slot_retirements WHERE job = ?').get(JOB).job_retired, 1);
});

function retainedProofBeforeReclaimableContext(t) {
  const terminal = new Set();
  const w = fixture(t, { maxJobs: 10, maxContextRecords: 2,
    contextSessionState: ({ jobId }) => terminal.has(jobId) ? 'finalised' : null });
  const context = jobId => w.store.reserve(w.payload(jobId, { path: CONTEXT }), { scope: { jobId } }, { admit: w.now });
  for (const jobId of [JOB, JOB2]) w.store.finish(context(jobId), 200, '{}');
  w.advance(HOUR + 61000); terminal.add(JOB);
  assert.ok(w.store.challenges.issue({ jobId: LIVE_JOB, buyer: BUYER.claim }, 'c'.repeat(64)).sessionNonce);
  assert.deepEqual(context(JOB), { disposition: 'cached', status: 200, text: '{}' });
  assert.equal(context(LIVE_JOB).disposition, 'perform');
  w.advance(61000); terminal.add(JOB2);
  assert.equal(sellerStoreInternals(w.store).admissionCounts().contextRecords, 2);
  return w;
}

for (const restart of [false, true]) {
  for (const caller of ['challenge', 'accounting']) {
    test(`${caller} retires an active context beyond a kept retired proof${restart ? ' after restart' : ''}`, async t => {
      const w = retainedProofBeforeReclaimableContext(t);
      if (restart) w.reopen();
      const before = sellerStoreInternals(w.store).db.prepare('SELECT * FROM kit_slot_retirements WHERE job = ?').get(JOB);
      assert.equal(before.context_retired, 1);
      assert.equal(JSON.parse(before.owner).buyer, BUYER.claim);
      if (caller === 'challenge') {
        assert.ok(w.store.challenges.issue({ jobId: NEXT_JOB, buyer: BUYER.claim }, 'd'.repeat(64)).sessionNonce);
      } else {
        const f = await accountingFixture(t);
        f.setTime(w.now());
        const next = f.payload({ path: CONTEXT, jobId: NEXT_JOB });
        assert.equal((await w.store.reservationAccounting.reserveAccounted(f.args(next))).state, 'new');
      }
      const port = sellerStoreInternals(w.store);
      assert.equal(port.admissionCounts().contextRecords, caller === 'challenge' ? 1 : 2);
      assert.equal(port.db.prepare('SELECT context_retired FROM kit_slot_retirements WHERE job = ?').get(JOB2).context_retired, 1);
      assert.deepEqual(port.db.prepare('SELECT * FROM kit_slot_retirements WHERE job = ?').get(JOB), before);
      assert.deepEqual(port.db.prepare('SELECT job FROM peer_context_admissions WHERE job IN (?, ?) ORDER BY job').all(JOB, JOB2),
        [JOB, JOB2].sort().map(job => ({ job })));
    });
  }
}

for (const maxContextRecords of [1, 2]) test(`capacity retirement finds an active terminal job beyond a retired proof with context limit ${maxContextRecords}`, t => {
  const w = retainedContextProof(t);
  w.store.finish(w.store.reserve(w.payload(NEXT_JOB), {}, { keepProfile: FIXTURE_PROFILE }), 200, '{}');
  w.advance(HOUR + 61000);
  // The terminal job is separate from the retained context proof.
  const store = createSellerTransportStore({ path: w.path, now: w.now, maxJobs: 2, maxContextRecords,
    contextSessionState: ({ jobId }) => [JOB, NEXT_JOB].includes(jobId) ? 'finalised' : null });
  t.after(() => store.close());
  const port = sellerStoreInternals(store);
  port.transaction(() => port.retireSlotsWithin(w.now(), undefined, { capacity: true, keepContexts: true }));
  assert.equal(port.db.prepare('SELECT COUNT(*) AS n FROM peer_jobs WHERE job = ?').get(NEXT_JOB).n, 0);
});
