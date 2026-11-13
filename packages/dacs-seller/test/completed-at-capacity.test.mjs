// A completed operation answered while the store has no free capacity, and the reader of completed operations that reserves nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createCompletedOutcomeReader } from '../src/dacs/seller-http.mjs';
import { SellerTransportError, sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
import { BUYER, PATHS, PIN, SELLER, jobFor, proposeJob, statementsDuring, world } from './helpers/wire-routes-world.mjs';
import { operationOf } from './helpers/route-recovery-world.mjs';

// Another purchase holds one allotment, and two records are left: a signed request completes a proposal and a repeat of it uses the
// second, so `free` is 0 while the store still has room for records.
const ALLOTMENT_UNITS = 85;
const MAX_RECORDS = ALLOTMENT_UNITS + 2;
const WRITING = /^\s*(INSERT|UPDATE|DELETE|REPLACE)/i;

/** A world whose store has another purchase's allotment held. */
async function crowdedWorld(t) {
  const w = await world(t, { maxRecords: MAX_RECORDS });
  assert.equal(w.handle.capacity.capacityReport().allotment, ALLOTMENT_UNITS);
  sellerStoreInternals(w.handle.store).transaction(() => w.handle.capacity.allocateWithin({ jobId: jobFor('other-purchase'), buyer: BUYER.claim, seller: SELLER.claim, listingPin: PIN }));
  assert.equal(w.handle.capacity.capacityReport().allotted, ALLOTMENT_UNITS);
  return w;
}

async function completedAtZeroFree(t, label) {
  const w = await crowdedWorld(t), job = await proposeJob(w, label);
  const first = await job.post();
  assert.equal(first.status, 200);
  assert.equal((await job.post()).text, first.text);
  assert.equal(w.handle.capacity.capacityReport().free, 0);
  return { w, job, first };
}

const snapshot = (w) => ({ rows: w.rows(), files: w.journalFiles(), capacity: w.handle.capacity.capacityReport(), effects: w.effects() });

/** Makes `revalidateCompletedAnswer` record each stored outcome it is given and throw `watch.failure` while one is set. */
function watchRevalidation(w) {
  const watch = { outcomes: [], failure: null };
  w.agent.revalidateCompletedAnswer = async ({ outcome }) => {
    watch.outcomes.push(outcome);
    if (watch.failure !== null) throw watch.failure;
  };
  return watch;
}

const sourceUnavailable = (cause) => new SellerTransportError('seller_source_unavailable', 503, { cause });

test('at zero free capacity a poll inside a live lease is general and refused peer_store_capacity with no row and no file', async (t) => {
  const w = await crowdedWorld(t), job = await proposeJob(w, 'live-lease');
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; }), held = new Promise((resolve) => { release = resolve; });
  const receive = w.agent.receiveProposal;
  w.agent.receiveProposal = async (...args) => { enter(); await held; return receive(...args); };
  const running = job.post();
  try {
    await entered;
    const poll = await job.post();
    assert.deepEqual({ status: poll.status, error: poll.body.error }, { status: 503, error: 'seller_effect_pending' });
    assert.equal(w.handle.capacity.capacityReport().free, 0);
    const before = snapshot(w);
    const refused = await job.post();
    assert.deepEqual({ status: refused.status, error: refused.body.error }, { status: 503, error: 'peer_store_capacity' });
    assert.deepEqual(snapshot(w), before, 'the refused poll left no row, file or unit');
  } finally { release(); }
  assert.equal((await running).status, 200);
});

test('at zero free capacity a replay of a completed proposals operation gets the stored outcome after revalidation with no row, file or attempt', async (t) => {
  const { w, job, first } = await completedAtZeroFree(t, 'replay');
  const watch = watchRevalidation(w), before = snapshot(w), attempts = operationOf(w, job.jobId, PATHS.proposals);
  let answer;
  const writes = (await statementsDuring(async () => { answer = await job.post(); })).filter((sql) => WRITING.test(sql));
  assert.equal(answer.status, 200);
  assert.equal(answer.text, first.text, 'the stored bytes are answered');
  assert.deepEqual(watch.outcomes, [{ status: 200, text: first.text }], 'the source was revalidated once, with the stored outcome');
  assert.deepEqual(writes, [], 'no statement wrote');
  assert.deepEqual(snapshot(w), before);
  assert.deepEqual(operationOf(w, job.jobId, PATHS.proposals), attempts, 'the operation gained no attempt');
  watch.failure = sourceUnavailable('changed');
  const refused = await job.post();
  assert.deepEqual({ status: refused.status, error: refused.body.error, cause: refused.body.cause }, { status: 503, error: 'seller_source_unavailable', cause: 'changed' });
  assert.notEqual(refused.text, first.text, 'a failed revalidation withholds the stored text');
  assert.deepEqual(snapshot(w), before, 'a failed revalidation changed nothing');
  assert.deepEqual(operationOf(w, job.jobId, PATHS.proposals), attempts);
});

test('a completed operation answered at zero free capacity is refused peer_expired when the request expired before the answer, without revalidating', async (t) => {
  const { w, job } = await completedAtZeroFree(t, 'expired');
  const watch = watchRevalidation(w), reserve = w.handle.wire.reservations.reserveCoordinated, rows = w.rows();
  // The signed request lives 30 s; 40 s pass between its admission and its reservation, less than the 60 s the two earlier records count.
  w.handle.wire.reservations.reserveCoordinated = (...args) => { w.state.time += 40_000; return reserve(...args); };
  const refused = await job.post();
  assert.deepEqual({ status: refused.status, error: refused.body.error }, { status: 408, error: 'peer_expired' });
  assert.deepEqual(watch.outcomes, [], 'an expired request revalidates nothing');
  assert.deepEqual(w.rows(), rows);
});

test('the settled-outcome reader returns a completed outcome only after its revalidator passes; a failing revalidator gives seller_source_unavailable; a non-completed operation gives null', async (t) => {
  const { w, job, first } = await completedAtZeroFree(t, 'reader');
  const reader = createCompletedOutcomeReader({ journal: w.handle.wire.journal, seller: SELLER.claim });
  const { binding } = operationOf(w, job.jobId, PATHS.proposals), before = snapshot(w), seen = [];
  const read = (change = {}) => reader.completedOutcomeWithoutReservation({ path: PATHS.proposals, jobId: job.jobId, binding, revalidate: async (outcome) => { seen.push(outcome); }, ...change });
  assert.deepEqual(await read(), { status: 200, text: first.text });
  assert.deepEqual(seen, [{ status: 200, text: first.text }], 'the revalidator receives the stored status and text');
  const cause = new Error('TEST source unreadable');
  const failed = await read({ revalidate: async () => { throw cause; } }).catch((error) => error);
  assert.deepEqual({ type: failed.constructor, code: failed.code, status: failed.status, cause: failed.cause }, { type: SellerTransportError, code: 'seller_source_unavailable', status: 503, cause });
  const named = sourceUnavailable('absent');
  assert.equal(await read({ revalidate: async () => { throw named; } }).catch((error) => error), named, 'a named source refusal keeps its own cause');
  let called = 0;
  assert.equal(await read({ jobId: jobFor('reader-unknown'), revalidate: async () => { called++; } }), null, 'an operation that never started gives null');
  assert.equal(called, 0, 'a null answer revalidates nothing');
  const foreign = await read({ binding: 'f'.repeat(64) }).catch((error) => error);
  assert.deepEqual({ code: foreign.code, status: foreign.status }, { code: 'peer_operation_mismatch', status: 409 }, 'a foreign binding is refused, never answered or read as absent');
  assert.deepEqual(snapshot(w), before, 'the reader reserved and recorded nothing');
});

test('the settled-outcome reader gives null for an operation whose attempt is still pending', async (t) => {
  const w = await world(t), job = await proposeJob(w, 'reader-pending');
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; }), held = new Promise((resolve) => { release = resolve; });
  const receive = w.agent.receiveProposal;
  w.agent.receiveProposal = async (...args) => { enter(); await held; return receive(...args); };
  const running = job.post();
  try {
    await entered;
    const view = operationOf(w, job.jobId, PATHS.proposals);
    assert.equal(view.state, 'pending');
    let called = 0;
    const reader = createCompletedOutcomeReader({ journal: w.handle.wire.journal, seller: SELLER.claim });
    assert.equal(await reader.completedOutcomeWithoutReservation({ path: PATHS.proposals, jobId: job.jobId, binding: view.binding, revalidate: async () => { called++; } }), null);
    assert.equal(called, 0);
  } finally { release(); }
  await running;
});

test('the settled-outcome reader refuses a malformed path, job, binding or revalidator before it reads anything', async (t) => {
  const w = await world(t), reader = createCompletedOutcomeReader({ journal: w.handle.wire.journal, seller: SELLER.claim });
  const valid = { path: PATHS.proposals, jobId: jobFor('reader-input'), binding: 'a'.repeat(64), revalidate: async () => {} };
  for (const change of [{ path: PATHS.state }, { path: '/dacs/v1/other' }, { jobId: 'job' }, { binding: 'A'.repeat(64) }, { binding: 'a'.repeat(63) }, { revalidate: undefined }]) {
    await assert.rejects(reader.completedOutcomeWithoutReservation({ ...valid, ...change }), TypeError, JSON.stringify(Object.keys(change)));
  }
  assert.throws(() => createCompletedOutcomeReader({ journal: null, seller: SELLER.claim }), TypeError);
  assert.throws(() => createCompletedOutcomeReader({ journal: w.handle.wire.journal, seller: '' }), TypeError);
});

test('an attempt whose end record carries the outcome with no outcome file answers completed', async (t) => {
  const { w, job, first } = await completedAtZeroFree(t, 'end-record');
  const directory = w.state.journals[0], outcomes = readdirSync(directory).filter((name) => name.endsWith('.done'));
  assert.equal(outcomes.length, 1, 'the journal publishes the outcome as a file of its own');
  rmSync(join(directory, outcomes[0]));
  const reader = createCompletedOutcomeReader({ journal: w.handle.wire.journal, seller: SELLER.claim });
  const { binding } = operationOf(w, job.jobId, PATHS.proposals);
  assert.equal(operationOf(w, job.jobId, PATHS.proposals).state, 'completed', 'the end record alone completes the operation');
  const files = readdirSync(directory).length;
  assert.deepEqual(await reader.completedOutcomeWithoutReservation({ path: PATHS.proposals, jobId: job.jobId, binding, revalidate: async () => {} }), { status: 200, text: first.text });
  assert.equal(readdirSync(directory).length, files, 'inspection does not publish the outcome file');
});

test('inspection-only completed branches may answer the identical signed request twice without a reservation nonce or effect', async (t) => {
  const { w, job, first } = await completedAtZeroFree(t, 'twice');
  const watch = watchRevalidation(w), signed = await w.buyerWire.signRequest(PATHS.proposals, job.body, { jobId: job.jobId, agreementHash: job.agreementHash });
  const before = snapshot(w);
  const answers = [await w.send(PATHS.proposals, signed), await w.send(PATHS.proposals, signed)];
  assert.deepEqual(answers.map((answer) => [answer.status, answer.text]), [[200, first.text], [200, first.text]], 'both answers are the stored bytes');
  assert.equal(watch.outcomes.length, 2, 'each answer revalidated the source');
  assert.deepEqual(snapshot(w), before, 'no nonce file, row, unit or effect');
  watch.failure = sourceUnavailable('timeout');
  for (let n = 0; n < 2; n++) assert.equal((await w.send(PATHS.proposals, signed)).body.error, 'seller_source_unavailable', 'a failed revalidation withholds the answer on each call');
  assert.deepEqual(snapshot(w), before);
  const reader = createCompletedOutcomeReader({ journal: w.handle.wire.journal, seller: SELLER.claim }), { binding } = operationOf(w, job.jobId, PATHS.proposals);
  for (let n = 0; n < 2; n++) assert.deepEqual(await reader.completedOutcomeWithoutReservation({ path: PATHS.proposals, jobId: job.jobId, binding, revalidate: async () => {} }), { status: 200, text: first.text });
  assert.deepEqual(snapshot(w), before, 'the reader reserves nothing either');
});
