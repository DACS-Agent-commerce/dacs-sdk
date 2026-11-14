import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCanonicalJobId, identityBundleHash } from '@kynesyslabs/dacs';
import { completeWireEffect, inspectWireOperation, openWireRequestJournal } from '@kynesyslabs/dacs/wire';
import { journalStore, reserveEffect } from '../../../dist/wire/journal.js';
import { AGREEMENT_CONTEXT_SOURCE } from '../src/dacs/agreement-context-consumer.mjs';
import { DEM_RAIL, purchaseSupport } from '../src/dacs/listing.mjs';
import { listingPin } from '../src/dacs/purchase-protocol.mjs';
import { createSellerContextRecords } from '../src/dacs/seller-context-route.mjs';
import { SELLER_CONTEXT_PATH, sellerContextScopeHash } from '../src/dacs/seller-transport-auth.mjs';
import { fixtureIdentityBundle, fixtureListing } from './fixtures/listings.mjs';
import { testWallet } from './helpers/protocol-fixture.mjs';

const T = 1793102400000;
const hash = (text) => createHash('sha256').update(String(text)).digest('hex');
const jobAt = (index) => generateCanonicalJobId({ timestamp: T, entropy: Buffer.alloc(10, index) });
const JOB = jobAt(1), OTHER_JOB = jobAt(2);
const buyer = testWallet(12), seller = testWallet(17), otherParty = testWallet(23);
const listing = fixtureListing(seller, { now: T });
const pin = listingPin(listing);
const support = purchaseSupport(listing);
const bundle = fixtureIdentityBundle(buyer, T);
const ELIGIBLE_STATES = ['admitted', 'running', 'settled'];
const INELIGIBLE_STATES = ['intent', 'compensating', 'aborted'];

// The scope the route admits for a job: the seller's own terms plus the buyer's bundle hash and generatedAt.
const scopeOf = (jobId, { presentedBy = buyer.claim, bundleHash = identityBundleHash(bundle), generatedAt = T } = {}) => ({
  source: AGREEMENT_CONTEXT_SOURCE, wallet: buyer.address, jobId, buyer: presentedBy, buyerBundleHash: bundleHash, seller: seller.claim, listingPin: pin,
  rail: { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion }, payee: support.payee, price: support.price, generatedAt });
// The part of K1's admission row the records read.
const rowOf = (jobId, state, scope = scopeOf(jobId)) => ({ jobId, buyer: scope.buyer, seller: seller.claim, listingPin: pin, contextScopeHash: sellerContextScopeHash(scope), state });
const presentAnswer = (scope) => ({ status: 200, text: JSON.stringify({ disposition: 'present', value: { scope, input: { jobId: scope.jobId } } }) });
const exactInput = (jobId = JOB) => ({ jobId, buyerBundle: bundle, generatedAt: T });

// A journal opened on a real directory, and the contextOutcome reader the host gives the records: the completed outcome from inspectWireOperation, else null.
function journalWorld(t) {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-context-records-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const open = () => openWireRequestJournal(directory, { leaseMs: 1000, clock: () => T });
  let journal = open(), requests = 0;
  // Each request carries its own key, so a second reservation of one job is a recovery, not a replay.
  const reserve = (jobId) => reserveEffect(journalStore(journal), { key: hash(`key-${++requests}`), seller: seller.claim, jobId, path: SELLER_CONTEXT_PATH, binding: hash('binding'), requestHash: hash(`request-${requests}`) });
  const reader = () => (jobId) => { const view = inspectWireOperation(journal, { seller: seller.claim, jobId, path: SELLER_CONTEXT_PATH }); return view.state === 'completed' ? view.outcome : null; };
  const files = () => readdirSync(directory, { recursive: true }).sort().map((name) => { const path = join(directory, String(name)); return [String(name), statSync(path).isFile() ? hash(readFileSync(path)) : 'dir']; });
  return { directory, reserve, files, complete: (effect, outcome) => completeWireEffect(journal, effect, outcome), reopen: () => { journal = open(); return reader(); }, contextOutcome: reader() };
}
function recordsOver({ rows = new Map(), contextOutcome = () => null } = {}) {
  const calls = { admission: 0, contextOutcome: 0 };
  const records = createSellerContextRecords({ listing,
    admission: (jobId) => { calls.admission++; return rows.get(jobId) ?? null; },
    contextOutcome: (jobId) => { calls.contextOutcome++; return contextOutcome(jobId); } });
  return { records, calls, rows };
}

test("exactRequest is true only for the job's K1 admission row of this buyer, Listing and exact scope, and false once compensation aborted it", () => {
  const { records, rows } = recordsOver({ rows: new Map([[JOB, rowOf(JOB, 'admitted')]]) });
  assert.equal(records.exactRequest(exactInput()), true);
  assert.equal(records.exactRequest({ ...exactInput(), generatedAt: T + 1 }), false);
  assert.equal(records.exactRequest({ ...exactInput(), buyerBundle: { ...bundle, sessionNonce: 'f'.repeat(64) } }), false);
  assert.equal(records.exactRequest(exactInput(OTHER_JOB)), false, 'no admission row for the job');
  for (const [field, value] of [['buyer', otherParty.claim], ['seller', otherParty.claim], ['listingPin', { ...pin, version: pin.version + 1 }]]) {
    rows.set(JOB, { ...rowOf(JOB, 'admitted'), [field]: value });
    assert.equal(records.exactRequest(exactInput()), false, `a row with another ${field}`);
  }
  for (const state of ELIGIBLE_STATES) { rows.set(JOB, rowOf(JOB, state)); assert.equal(records.exactRequest(exactInput()), true, state); }
  for (const state of INELIGIBLE_STATES) { rows.set(JOB, rowOf(JOB, state)); assert.equal(records.exactRequest(exactInput()), false, state); }
});

test('completedScope returns the scope only from a completed context outcome whose scope hashes to the admitted one; none, pending, ended or a mismatched scope give null', (t) => {
  const world = journalWorld(t);
  const scope = scopeOf(JOB);
  const { records, rows } = recordsOver({ rows: new Map([[JOB, rowOf(JOB, 'running')]]), contextOutcome: world.contextOutcome });
  assert.equal(records.completedScope({ jobId: JOB, buyer: buyer.claim }), null, 'no operation in the journal');
  const effect = world.reserve(JOB);
  assert.equal(records.completedScope({ jobId: JOB, buyer: buyer.claim }), null, 'pending operation');
  world.complete(effect, null);
  assert.equal(records.completedScope({ jobId: JOB, buyer: buyer.claim }), null, 'ended with no outcome');
  const recovery = world.reserve(JOB);
  assert.equal(recovery.state, 'recover');
  world.complete(recovery, presentAnswer({ ...scope, generatedAt: T + 1 }));
  assert.equal(records.completedScope({ jobId: JOB, buyer: buyer.claim }), null, 'the outcome scope hashes to another scope than the admitted one');
  rows.set(JOB, rowOf(JOB, 'running', { ...scope, generatedAt: T + 1 }));
  assert.deepEqual(records.completedScope({ jobId: JOB, buyer: buyer.claim }), { ...scope, generatedAt: T + 1 }, 'the same outcome under the row that admitted that scope');
});

test("completedScope answers only for an eligible row and the row's own buyer, and returns a frozen copy", () => {
  const scope = scopeOf(JOB), outcome = presentAnswer(scope);
  const { records, rows } = recordsOver({ rows: new Map([[JOB, rowOf(JOB, 'settled')]]), contextOutcome: () => outcome });
  const answer = records.completedScope({ jobId: JOB, buyer: buyer.claim });
  assert.deepEqual(answer, scope);
  assert.equal(Object.isFrozen(answer) && Object.isFrozen(answer.rail) && Object.isFrozen(answer.listingPin), true);
  assert.equal(records.completedScope({ jobId: JOB, buyer: otherParty.claim }), null, 'another buyer');
  for (const state of ELIGIBLE_STATES) { rows.set(JOB, rowOf(JOB, state)); assert.deepEqual(records.completedScope({ jobId: JOB, buyer: buyer.claim }), scope, state); }
  for (const state of INELIGIBLE_STATES) { rows.set(JOB, rowOf(JOB, state)); assert.equal(records.completedScope({ jobId: JOB, buyer: buyer.claim }), null, state); }
  rows.delete(JOB);
  assert.equal(records.completedScope({ jobId: JOB, buyer: buyer.claim }), null, 'no admission row');
});

test('malformed job ids are refused before either reader is called', () => {
  const { records, calls } = recordsOver();
  for (const jobId of ['', 'job-1', JOB.toLowerCase(), `${JOB} `, null, undefined, 7]) {
    assert.throws(() => records.exactRequest({ ...exactInput(), jobId }), { code: 'peer_job_invalid', status: 409 });
    assert.throws(() => records.completedScope({ jobId, buyer: buyer.claim }), { code: 'peer_job_invalid', status: 409 });
  }
  assert.deepEqual(calls, { admission: 0, contextOutcome: 0 });
});

test('a reader that throws makes exactRequest false and completedScope null', async () => {
  const rows = new Map([[JOB, rowOf(JOB, 'running')]]), outcome = presentAnswer(scopeOf(JOB));
  const boom = () => { throw new Error('reader failed'); };
  const rejected = () => Promise.reject(new Error('reader rejected'));
  const answers = (records) => [records.exactRequest(exactInput()), records.completedScope({ jobId: JOB, buyer: buyer.claim })];
  const make = (admission, contextOutcome) => createSellerContextRecords({ listing, admission, contextOutcome });
  assert.deepEqual(answers(make((jobId) => rows.get(jobId), () => outcome)), [true, scopeOf(JOB)]);
  assert.deepEqual(answers(make(boom, () => outcome)), [false, null]);
  assert.deepEqual(answers(make((jobId) => rows.get(jobId), boom)), [true, null]);
  assert.deepEqual(answers(make(() => rows.get(JOB), () => ({ then() {} }))), [true, null], 'a thenable outcome');
  assert.deepEqual(answers(make(() => ({ then() {} }), () => outcome)), [false, null], 'a thenable row');
  const unhandled = [], record = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  assert.deepEqual(answers(make(rejected, rejected)), [false, null]);
  await new Promise((resolve) => setImmediate(resolve));
  process.off('unhandledRejection', record);
  assert.deepEqual(unhandled, [], 'a rejected promise from a reader is observed');
});

test('the records refuse a missing or non-callable reader at construction', () => {
  const reader = () => null;
  for (const [admission, contextOutcome] of [[undefined, reader], [reader, undefined], ['admission', reader], [reader, {}]]) {
    assert.throws(() => createSellerContextRecords({ listing, admission, contextOutcome }), TypeError);
  }
  assert.throws(() => createSellerContextRecords({ listing, store: () => null }), TypeError);
});

test('NEW-C2-running-completed-reopen', (t) => {
  const world = journalWorld(t);
  const scope = scopeOf(JOB), effect = world.reserve(JOB);
  world.complete(effect, presentAnswer(scope));
  // The process died after the outcome committed and before settlement: the row is still `running`.
  const before = world.files();
  const fresh = recordsOver({ rows: new Map([[JOB, rowOf(JOB, 'running')]]), contextOutcome: world.reopen() });
  assert.deepEqual(fresh.records.completedScope({ jobId: JOB, buyer: buyer.claim }), scope);
  assert.equal(fresh.records.exactRequest(exactInput()), true);
  assert.deepEqual(world.files(), before, 'reading wrote nothing to the journal');
  assert.deepEqual(fresh.calls, { admission: 2, contextOutcome: 1 });
});

test('NEW-C2-reader-change', (t) => {
  const world = journalWorld(t);
  const scope = scopeOf(JOB), rows = new Map([[JOB, rowOf(JOB, 'running')]]);
  world.complete(world.reserve(JOB), presentAnswer(scope));
  let served = world.contextOutcome;
  const { records } = recordsOver({ rows, contextOutcome: (jobId) => served(jobId) });
  const ask = () => records.completedScope({ jobId: JOB, buyer: buyer.claim });
  assert.deepEqual(ask(), scope);
  const served200 = (value) => () => ({ status: 200, text: JSON.stringify(value) });
  const wrongScopes = { another_job: { ...scope, jobId: OTHER_JOB }, another_buyer: { ...scope, buyer: otherParty.claim }, extra_key: { ...scope, extra: 1 }, missing_key: Object.fromEntries(Object.entries(scope).filter(([key]) => key !== 'price')) };
  const unreadable = [() => ({ status: 200, text: '{not json' }), () => ({ status: 200, text: 'null' }), () => ({ status: 503, text: presentAnswer(scope).text }),
    served200({ disposition: 'rejected', reason: 'no' }), served200({ disposition: 'present', value: {} }), served200({ disposition: 'present' }),
    ...Object.values(wrongScopes).map((wrong) => served200({ disposition: 'present', value: { scope: wrong } }))];
  for (const reading of unreadable) { served = reading; assert.equal(ask(), null); }
  served = world.contextOutcome;
  assert.deepEqual(ask(), scope, 'the durable outcome is unchanged and answers again');
  rows.set(JOB, rowOf(JOB, 'aborted'));
  assert.equal(ask(), null, 'a row compensation aborted no longer answers');
  assert.equal(records.exactRequest(exactInput()), false);
  rows.set(JOB, { ...rowOf(JOB, 'running'), contextScopeHash: hash('another scope') });
  assert.equal(ask(), null, 'a row for another scope hash');
});

test('NEW-C2-advisory-presenter', () => {
  // The bundle is presented by an equivalent spelling of the buyer's claim, and the admitted scope names the claim the row holds.
  const advisory = `${buyer.claim}?jurisdiction=GB`;
  const advisoryBundle = { ...bundle, presentedBy: advisory };
  const input = { jobId: JOB, buyerBundle: advisoryBundle, generatedAt: T };
  const admitted = scopeOf(JOB, { bundleHash: identityBundleHash(advisoryBundle) });
  const { records, rows } = recordsOver({ rows: new Map([[JOB, rowOf(JOB, 'admitted', admitted)]]), contextOutcome: () => presentAnswer(admitted) });
  assert.equal(records.exactRequest(input), true, 'the scope names the row buyer, and the bundle presenter is the same identity');
  assert.deepEqual(records.completedScope({ jobId: JOB, buyer: advisory }), admitted, 'the caller may spell the same identity differently');
  // A scope built with the presenter's spelling is another scope: it is never rebuilt to match.
  const rebuilt = scopeOf(JOB, { presentedBy: advisory, bundleHash: identityBundleHash(advisoryBundle) });
  rows.set(JOB, { ...rowOf(JOB, 'admitted', admitted), contextScopeHash: sellerContextScopeHash(rebuilt) });
  assert.equal(records.exactRequest(input), false);
  rows.set(JOB, rowOf(JOB, 'admitted', admitted));
  assert.equal(records.exactRequest({ ...input, buyerBundle: { ...bundle, presentedBy: otherParty.claim } }), false, 'a presenter that is another identity');
});
