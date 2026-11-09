import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSellerTransportStore, sellerStoreInternals, SELLER_CONTEXT_PATH } from '../src/dacs/seller-transport-auth.mjs';
import { FIXTURE_PROFILE } from './helpers/wire-authority-fixture.mjs';
import { accountingFixture, BUYER, SELLER, JOB, JOB2, PIN, T0, CONTEXT, PROPOSALS } from './helpers/reservation-accounting-fixture.mjs';

const HOUR = 3600000;
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
