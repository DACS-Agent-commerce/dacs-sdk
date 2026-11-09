import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { completeWireEffect, inspectWireOperation, wireOperationId, wireRequestHash } from '@kynesyslabs/dacs/wire';
import { RESERVATION_LEDGER, SellerTransportError, createSellerTransportStore, sellerContextChallengeScope, sellerContextScopeHash } from '../src/dacs/seller-transport-auth.mjs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { createReservationAccounting } from '../src/dacs/seller-reservation-accounting.mjs';
import DatabaseSync from 'better-sqlite3';
import { listingPin } from '../src/dacs/purchase-protocol.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { accountingFixture, T0, JOB, JOB2, BUYER, SELLER, OTHER, PIN, PROPOSALS, PAYMENTS, PAYMENT_TX, CONTEXT, nonceKey } from './helpers/reservation-accounting-fixture.mjs';
import { FIXTURE_PROFILE } from './helpers/wire-authority-fixture.mjs';
import { world as contextWorld, presentContext } from './helpers/d5-http-fixture.mjs';

const refused = (code, status) => ({ code, ...(status === undefined ? {} : { status }) });
const cause = new Error('TEST interrupted process');
const crash = async () => { throw cause; };
const claimCount = (f) => f.payments().length;
const casFailure = (f) => f.db.exec("CREATE TRIGGER stop_result BEFORE UPDATE ON kit_reservations BEGIN SELECT RAISE(ABORT, 'TEST result write failed'); END");
const dropCasFailure = (f) => f.db.exec('DROP TRIGGER stop_result');
const JOB3 = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
const jobAt = index => '01ARZ3NDEKTSV4RRFFQ69G5F' + ['AA', 'AB', 'AC', 'AD', 'AE', 'AF', 'AG', 'AH'][index];
const BUYER_COPY = '/dacs/v1/bundles/buyer-copy';
const STATE_ROUTE = '/dacs/v1/agreements/state';
// A read route takes no effect slot, so it shares a job with an old-path proposal.
const readOf = (f, change = {}) => f.payload({ path: BUYER_COPY, ...change });
// The retained context admission the old path wrote; its table exists only after a first admission commits.
const admitContextRecord = (f, jobId) => {
  f.db.exec(`CREATE TABLE peer_context_admissions (job TEXT PRIMARY KEY, buyer TEXT NOT NULL, seller TEXT NOT NULL,
    listing_pin TEXT NOT NULL, scope_hash TEXT NOT NULL, effect TEXT NOT NULL, admitted_at INTEGER NOT NULL)`);
  f.db.prepare('INSERT INTO peer_context_admissions VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(jobId, BUYER.claim, SELLER.claim, JSON.stringify(PIN), sha256Hex('context scope'), sha256Hex('context effect'), T0);
};
const contextPayload = (f, change = {}) => f.payload({ path: CONTEXT, agreementHash: sha256Hex('context scope'), ...change });
// The old path's requests, as a route runs them: a context step leaves one admission and no job row or tuple.
const oldReserve = (f, p) => f.store().reserve(p, p.path === CONTEXT ? { scope: { jobId: p.jobId } } : {},
  p.path === CONTEXT ? { admit: f.now } : { keepProfile: FIXTURE_PROFILE });
const oldContextStep = (f, jobId = JOB) => f.store().finish(oldReserve(f, contextPayload(f, { jobId })), 200, '{}');
const admissionOnly = (f, jobId = JOB) => {
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM peer_context_admissions WHERE job = ?').get(jobId).n, 1);
  assert.equal(f.jobRows().length, 0); assert.equal(f.tuples(), 0);
};

test("P11b1-T01 a buyer's 121st reservation in the window is refused with no row or file, and admitted when the window moves", async t => {
  const f = await accountingFixture(t);
  for (let i = 0; i < 120; i++) {
    const input = await f.admit();
    if (i === 0) assert.equal((await f.reserve(input)).state, 'new');
    else await assert.rejects(f.reserve(input), refused('seller_effect_pending', 503));
  }
  const input = await f.admit();
  await assert.rejects(f.reserve(input), refused('peer_buyer_nonce_limit', 429));
  assert.equal(f.rows().length, 120); assert.equal(f.nonces().length, 120);
  f.setTime(T0 + 60000);
  await assert.rejects(f.reserve(await f.admit()), refused('seller_effect_pending'));
  assert.equal(f.rows().length, 121); assert.equal(f.nonces().length, 121);
});

test('P11b1-T02 a full job capacity refuses a new job and admits a retry for an existing job', async t => {
  const f = await accountingFixture(t, { maxJobs: 1 });
  await f.reserve(await f.admit());
  await assert.rejects(f.reserve(await f.admit(f.payload({ jobId: JOB2 }))), refused('peer_job_capacity', 503));
  assert.equal(f.rows().length, 1); assert.equal(f.nonces().length, 1);
  await assert.rejects(f.reserve(await f.admit()), refused('seller_effect_pending'));
  assert.equal(f.rows().length, 2); assert.equal(f.nonces().length, 2); assert.equal(f.tuples(), 1);
});

// A wrong binding that reaches the wire: the context start of a job, presented again with another scope hash. (A changed
// Agreement on a job that has its job row is refused by the store, before a row; see the job Agreement tests.)
const otherScope = f => f.payload({ path: CONTEXT, agreementHash: sha256Hex('changed context scope') });

test('P11b1-T03 120 wrong-binding reservations through the real wire are each counted with one file, and the 121st is refused before a row or file', async t => {
  const f = await accountingFixture(t);
  await f.reserve(await f.admitContext());
  f.setTime(T0 + 60000);
  for (let i = 0; i < 120; i++) {
    const input = await f.admitContext(otherScope(f));
    await assert.rejects(f.reserve(input), refused('peer_operation_mismatch', 409));
  }
  const rows = f.rows().slice(1);
  assert.equal(rows.length, 120); assert.ok(rows.every(row => row.class === 'general' && row.code === 'peer_operation_mismatch'));
  assert.equal(f.nonces().length, 121);
  await assert.rejects(f.reserve(await f.admitContext(otherScope(f))), refused('peer_buyer_nonce_limit'));
  assert.equal(f.rows().length, 121); assert.equal(f.nonces().length, 121);
});

test('P11b1-T04 wrong-binding requests and pending polls are each counted as general, files equal rows', async t => {
  const f = await accountingFixture(t);
  await f.reserve(await f.admitContext());
  for (let i = 0; i < 20; i++) {
    await assert.rejects(f.reserve(await f.admitContext(otherScope(f))), refused('peer_operation_mismatch'));
    await assert.rejects(f.reserve(await f.admitContext()), refused('seller_effect_pending'));
  }
  assert.equal(f.rows().length, 41); assert.equal(f.nonces().length, 41);
  assert.ok(f.rows().every(row => row.class === 'general' && row.allocationId === null));
});

test('P11b1-T05 an unsafe clock or lease sum refuses with no row or file; the largest safe clock is admitted', async t => {
  const f = await accountingFixture(t);
  const input = await f.admit();
  for (const time of [-1, -0, NaN, 1.5, 2 ** 53, Number.MAX_SAFE_INTEGER - 299999, Number.MAX_SAFE_INTEGER - 1]) {
    f.setTime(time);
    await assert.rejects(f.reserve(input), refused('peer_clock_invalid', 503)); f.assertEmpty();
  }
  // The real journal gets its largest safe lease; admission's request clock is independent.
  f.setTime(Number.MAX_SAFE_INTEGER - 300000);
  const effect = await f.reserve(input);
  assert.equal(effect.leaseUntil, Number.MAX_SAFE_INTEGER); assert.equal(f.rows().length, 1); assert.equal(f.nonces().length, 1);
});

test('P11b1-T06 a reservation past both expiries ends refused{peer_expired}, keeps its unit and publishes no file', async t => {
  const f = await accountingFixture(t);
  let elapsed = 0;
  const monotonic = mock.method(performance, 'now', () => elapsed);
  t.after(() => monotonic.mock.restore());
  const input = await f.admit(f.payload(), { artifacts: [{ jobId: JOB, listingRef: PIN,
    parties: [{ role: 'buyer', primaryClaim: BUYER.claim }, { role: 'seller', primaryClaim: SELLER.claim }], terms: { deadline: T0 + 60000 } }] }, true);
  elapsed = 60000;
  await assert.rejects(f.reserve(input), refused('peer_expired', 408));
  assert.equal(f.rows()[0].state, 'refused'); assert.equal(f.rows()[0].code, 'peer_expired');
  f.reopen(); assert.equal(f.rows().length, 1); assert.equal(f.files().length, 0);
});

test('P11b1-T07 a crash after the row commits keeps the row and its unit across restart, with no file', async t => {
  const f = await accountingFixture(t);
  await assert.rejects(f.reserve(f.args(undefined, { checked: { reserve: crash } })), error => error === cause);
  f.reopen(); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].state, 'reserving'); assert.equal(f.files().length, 0);
});

test('P11b1-T08 a crash after the reservation published keeps the row reserving, with its file present after restart', async t => {
  const f = await accountingFixture(t); casFailure(f);
  const input = await f.admit();
  await assert.rejects(f.reserve(input), /TEST result write failed/);
  f.reopen(); assert.equal(f.rows()[0].state, 'reserving'); assert.equal(f.rows()[0].rev, 1);
  assert.equal(f.nonces().length, 1); assert.equal(f.files().length, 2);
  assert.equal(inspectWireOperation(f.journal, input.payload).state, 'pending');
});

test('P11b1-T09 two connections accounting for the last unit give one row and one refusal', async t => {
  const f = await accountingFixture(t);
  const second = createSellerTransportStore({ path: f.path, now: f.now });
  const checkCapacityWithin = ({ get }) => {
    if (get('SELECT COUNT(*) AS n FROM kit_reservations').n >= 1) throw new SellerTransportError('peer_store_capacity', 503);
    return { class: 'general', allocationId: null };
  };
  t.after(() => second.close());
  let release; const barrier = new Promise(resolve => { release = resolve; });
  const pending = f.reserve(f.args(undefined, { checkCapacityWithin, checked: { reserve: async () => { await barrier; return { state: 'new' }; } } }));
  await assert.rejects(second.reservationAccounting.reserveAccounted(f.args(undefined, { checkCapacityWithin })), refused('peer_store_capacity'));
  assert.equal(f.rows().length, 1); release(); await pending;
  assert.equal(f.rows()[0].state, 'new'); assert.equal(f.files().length, 0);
});

test('P11b1-T10 one payment transaction for two jobs suspends credit for both in either order and after restart; an inadmissible claim gains nothing', async t => {
  for (const jobs of [[JOB, JOB2], [JOB2, JOB]]) {
    const f = await accountingFixture(t);
    const durableDir = join(f.dir, 'seller');
    const config = { dir: durableDir, signer: { claim: SELLER.claim, sign: SELLER.signBytes }, listingPin: PIN };
    let durable = await createSellerDurableState(config);
    t.after(() => durable.close());
    let intake = 0;
    for (const [index, jobId] of jobs.entries()) {
      const input = await f.payment(jobId, {}, sha256Hex('one payment transaction'));
      const effect = await f.reserve(input);
      assert.equal(effect.state, 'new'); intake++;
      assert.equal(await durable.withJob(jobId, () => durable.bindSettlement(input.paymentTx, jobId, { phaseIndex: 0, jobId, evidenceHash: sha256Hex(jobId) })), index === 0);
      if (index === 0) {
        // Correctly signed but not admitted against the host's own retained job.
        await assert.rejects(f.payment(jobs[1], { retained: { buyer: BUYER.claim, seller: SELLER.claim, jobId, agreementHash: input.payload.agreementHash } }), refused('peer_job_mismatch'));
        assert.equal(f.rows().length, 1); assert.equal(durable.settlementJob(input.paymentTx), jobId);
      }
      f.reopen(); durable.close(); durable = await createSellerDurableState(config);
    }
    assert.equal(intake, 2); assert.equal(f.rows().length, 2); assert.equal(f.nonces().length, 2); assert.equal(claimCount(f), 1);
    assert.equal(f.payments()[0].jobId, jobs[0]); assert.equal(durable.settlementJob(sha256Hex('one payment transaction')), null);
    for (const jobId of jobs) assert.equal(await durable.withJob(jobId, () => durable.bindSettlement(sha256Hex('one payment transaction'), jobId)), false);
  }
});

test('P11b1-T11 a second payment claim after the operation completed is accounted as general and runs no intake', async t => {
  const f = await accountingFixture(t);
  const input = await f.payment(JOB, {}, sha256Hex('first claim'));
  const effect = await f.reserve(input); let intake = 1;
  completeWireEffect(f.journal, effect, { status: 200, text: '{"status":"delivered"}' });
  const retry = await f.payment(JOB, {}, sha256Hex('second claim'));
  const result = await f.reserve(retry); if (result.state !== 'completed') intake++;
  assert.equal(result.state, 'completed'); assert.equal(intake, 1);
  assert.equal(f.rows()[1].class, 'general'); assert.equal(f.rows()[1].state, 'completed'); assert.equal(f.nonces().length, 2);
});

test('P11b1-T12 the ported job and nonce capacity cases pass at accounting level', async t => {
  const f = await accountingFixture(t, { maxJobs: 2, maxNoncesPerBuyerPerWindow: 2, maxContextRecords: 1 });
  const old = f.store().reserve(f.payload(), {}, { keepProfile: FIXTURE_PROFILE });
  f.store().finish(old, 200, '{}'); // One legacy job and its tuple count as one job, and its nonce as one unit.
  await f.reserve(f.args(readOf(f)));
  await assert.rejects(f.reserve(f.args()), refused('peer_buyer_nonce_limit'));
  // An independent buyer has its own window; its job consumes the last job slot.
  await f.reserve(f.args(f.payload({ buyer: OTHER.claim, jobId: JOB2 })));
  f.setTime(T0 + 60000);
  await f.reserve(f.args(readOf(f)));
  await assert.rejects(f.reserve(f.args(f.payload({ jobId: JOB3 }))), refused('peer_job_capacity'));
  assert.equal(f.tuples(), 2);
  // Context records share the old path's admissions and are not inferred from reservation files.
  const context = await accountingFixture(t, { maxContextRecords: 1 });
  admitContextRecord(context, JOB2);
  await assert.rejects(context.reserve(context.args(contextPayload(context))), refused('peer_context_capacity', 503));
  context.reopen(); context.assertEmpty();
});

test('accounting admits a context retry for a job whose context record is already counted', async t => {
  const f = await accountingFixture(t, { maxContextRecords: 1 });
  admitContextRecord(f, JOB);
  const { jobId, buyer, seller, listingPin, agreementHash } = f.payload();
  f.db.prepare('INSERT INTO peer_jobs VALUES (?, ?)').run(JOB, canonicalize({ jobId, buyer, seller, listingPin, agreementHash }));
  f.db.prepare('INSERT INTO kit_purchase_profiles VALUES (?, ?, ?)').run(JOB, canonicalize(FIXTURE_PROFILE), T0);
  assert.equal((await f.reserve(f.args(contextPayload(f)))).state, 'new');
  assert.equal(f.rows().length, 1); assert.equal(f.tuples(), 1); assert.equal(f.jobRows().length, 1);
});

test('accounting refuses step 4 for a context start on an existing job that has no context record at capacity', async t => {
  const f = await accountingFixture(t, { maxContextRecords: 1 });
  await f.reserve(f.args());
  admitContextRecord(f, JOB2);
  await assert.rejects(f.reserve(f.args(contextPayload(f))), refused('peer_context_capacity', 503));
  f.reopen(); assert.equal(f.rows().length, 1); assert.equal(f.tuples(), 1); assert.equal(f.jobRows().length, 1);
});

test('accounting writes no job row or tuple for a context start, so a later proposal for the job is not a conflict', async t => {
  const f = await accountingFixture(t);
  assert.equal((await f.reserve(f.args(contextPayload(f)))).state, 'new');
  assert.equal(f.rows().length, 1); assert.equal(f.jobRows().length, 0); assert.equal(f.tuples(), 0);
  assert.deepEqual(f.holds(), [{ jobId: JOB, buyer: BUYER.claim, seller: SELLER.claim, listing_pin: canonicalize(PIN), context: 1 }]);
  assert.doesNotThrow(() => f.store().reserve(f.payload(), {}, { keepProfile: FIXTURE_PROFILE }));
});

test("a context start's scope hash never becomes the job's Agreement: the first proposal keeps its own identity and tuple", async t => {
  const f = await accountingFixture(t);
  await f.reserve(f.args(contextPayload(f)));
  const proposal = f.payload();
  assert.equal((await f.reserve(f.args(proposal))).state, 'new');
  const { jobId, buyer, seller, listingPin, agreementHash } = proposal;
  assert.deepEqual(f.jobRows(), [{ job: JOB, context: canonicalize({ jobId, buyer, seller, listingPin, agreementHash }) }]);
  assert.equal(f.tuples(), 1); assert.equal(f.rows().length, 2); assert.equal(f.holds().length, 1); assert.equal(f.holds()[0].context, 1);
});

test('accounting admits an accounted proposal for a job whose only record is the old context admission', async t => {
  const f = await accountingFixture(t); oldContextStep(f); admissionOnly(f);
  assert.equal((await f.reserve(f.args(f.payload()))).state, 'new');
  assert.equal(f.rows().length, 1); assert.equal(f.jobRows().length, 1); assert.equal(f.tuples(), 1);
});

test('the store decides a new job and a context start: caller-supplied newJob and contextStart flags change nothing', async t => {
  const f = await accountingFixture(t, { maxContextRecords: 1 });
  admitContextRecord(f, JOB2);
  // A context route call flagged as no context start is still one, and still needs a context record.
  await assert.rejects(f.reserve(f.args(contextPayload(f), { contextStart: false, newJob: false })), refused('peer_context_capacity', 503));
  assert.equal(f.rows().length, 0);
  assert.equal((await f.reserve(f.args(f.payload(), { contextStart: true, newJob: false }))).state, 'new');
  assert.equal((await f.reserve(f.args(f.payload(), { newJob: true }))).state, 'new');
  assert.equal(f.jobRows().length, 1); assert.equal(f.tuples(), 1); assert.equal(f.holds()[0].context, 0);
});

test('accounting refuses a context retry for a job whose only record is the old context admission: the old effect holds the slot', async t => {
  const f = await accountingFixture(t, { maxContextRecords: 1 }); oldContextStep(f); admissionOnly(f);
  await assert.rejects(f.reserve(f.args(contextPayload(f))), refused('peer_operation_conflict', 409));
  admissionOnly(f); f.reopen(); assert.equal(f.rows().length, 0); assert.equal(f.holds().length, 0); assert.equal(f.files().length, 0);
  assert.doesNotThrow(() => f.store().reserve(f.payload(), {}, { keepProfile: FIXTURE_PROFILE }));
});

test('an admission-only job already holds its job slot: its proposal is admitted at full capacity and another job is refused', async t => {
  const f = await accountingFixture(t, { maxJobs: 1 }); oldContextStep(f);
  await assert.rejects(f.reserve(f.args(f.payload({ jobId: JOB2 }))), refused('peer_job_capacity', 503));
  assert.equal((await f.reserve(f.args(f.payload()))).state, 'new');
  await assert.rejects(f.reserve(f.args(f.payload({ jobId: JOB2 }))), refused('peer_job_capacity', 503));
  f.reopen(); assert.equal(f.rows().length, 1); assert.equal(f.jobRows().length, 1); assert.equal(f.tuples(), 1);
});

test('an admission-only job progresses at full job and context capacity: its proposal and first tuple, with its context retry refused, before and after restart', async t => {
  for (const restart of [false, true]) {
    const f = await accountingFixture(t, { maxJobs: 1, maxContextRecords: 1 }); oldContextStep(f);
    if (restart) f.reopen();
    await assert.rejects(f.reserve(f.args(contextPayload(f))), refused('peer_operation_conflict', 409));
    if (restart) f.reopen();
    assert.equal(f.tuples(), 0);
    assert.equal((await f.reserve(f.args(f.payload()))).state, 'new');
    assert.equal(f.tuples(), 1); assert.equal(f.jobRows().length, 1);
    if (restart) f.reopen();
    await assert.rejects(f.reserve(f.args(contextPayload(f))), refused('peer_operation_conflict', 409));
    await assert.rejects(f.reserve(f.args(contextPayload(f, { jobId: JOB2 }))), refused('peer_job_capacity', 503));
    assert.equal(f.rows().length, 1); assert.equal(f.holds().length, 1);
  }
});

test('accounting still refuses a proposal whose tuple differs after the old context admission and a first proposal', async t => {
  const f = await accountingFixture(t); oldContextStep(f);
  await f.reserve(f.args(f.payload()));
  const other = { ...FIXTURE_PROFILE, revision: 'other-revision' };
  await assert.rejects(f.reserve(f.args(f.payload(), { keepProfile: other })), refused('tp1_purchase_profile_mismatch', 500));
  assert.equal(f.rows().length, 1); assert.equal(f.tuples(), 1);
});

test('accounting keeps a fresh job row and its tuple together, with the identity the old reserve path compares', async t => {
  const f = await accountingFixture(t);
  const payload = f.payload();
  await f.reserve(f.args(payload));
  const { jobId, buyer, seller, listingPin, agreementHash } = payload;
  assert.deepEqual(f.jobRows(), [{ job: JOB, context: canonicalize({ jobId, buyer, seller, listingPin, agreementHash }) }]);
  assert.equal(f.tuples(), 1);
  f.reopen();
  await f.reserve(f.args(f.payload({ path: PAYMENTS })));
  assert.equal(f.jobRows().length, 1); assert.equal(f.tuples(), 1);
});

test('a charged accounting job is not reclaimed by the old reserve path at job capacity', async t => {
  const f = await accountingFixture(t, { maxJobs: 1 });
  await f.reserve(f.args());
  assert.throws(() => f.store().reserve(f.payload({ jobId: JOB2 }), {}, { keepProfile: FIXTURE_PROFILE }), refused('peer_job_capacity', 503));
  f.reopen();
  assert.equal(f.jobRows().length, 1); assert.equal(f.tuples(), 1); assert.equal(f.rows().length, 1);
});

test("the old path retires a safe charged hold and keeps a context record whose wire operation is missing", async t => {
  // The job also has a completed old-path effect, so only the terminal branch could select it.
  let terminal = false;
  const contextSessionState = ({ jobId }) => terminal && jobId === JOB ? 'finalised' : null;
  const f = await accountingFixture(t, { maxJobs: 1, contextSessionState });
  f.store().finish(oldReserve(f, f.payload()), 200, '{}');
  await f.reserve(f.args(readOf(f)));
  terminal = true; f.setTime(T0 + 30000);
  assert.throws(() => oldReserve(f, f.payload({ buyer: OTHER.claim, jobId: JOB2 })), refused('peer_job_capacity', 503));
  terminal = false; f.setTime(T0 + 7200000); f.reopen();
  assert.throws(() => oldReserve(f, f.payload({ buyer: OTHER.claim, jobId: JOB2 })), refused('peer_job_capacity', 503));
  assert.equal(f.jobRows().length, 1); assert.equal(f.tuples(), 1); assert.equal(f.holds().length, 1);
  terminal = true;
  assert.equal(oldReserve(f, f.payload({ buyer: OTHER.claim, jobId: JOB2 })).disposition, 'perform');
  assert.deepEqual(f.jobRows().map(row => row.job), [JOB2]);
  assert.equal(f.tuples(), 1); assert.equal(f.holds().length, 1);
  terminal = false;
  const c = await accountingFixture(t, { maxContextRecords: 1, contextSessionState });
  oldContextStep(c);
  await c.reserve(c.args(c.payload()));
  c.setTime(T0 + 7200000); c.reopen(); terminal = true;
  assert.throws(() => oldReserve(c, contextPayload(c, { buyer: OTHER.claim, jobId: JOB2 })), refused('peer_context_capacity', 503));
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM peer_context_admissions WHERE job = ?').get(JOB).n, 1);
});

test('the old path still retires a terminal admission-only job to free a job slot it now counts', async t => {
  let terminal = false;
  const f = await accountingFixture(t, { maxJobs: 1, contextSessionState: ({ jobId }) => terminal && jobId === JOB ? 'finalised' : null });
  oldContextStep(f);
  assert.throws(() => oldReserve(f, f.payload({ buyer: OTHER.claim, jobId: JOB2 })), refused('peer_job_capacity', 503));
  f.setTime(T0 + 7200000); terminal = true;
  assert.doesNotThrow(() => oldReserve(f, f.payload({ buyer: OTHER.claim, jobId: JOB2 })));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM peer_context_admissions').get().n, 0);
  assert.deepEqual(f.jobRows().map(row => row.job), [JOB2]);
});

// A (admission only) and B (a job row) are held, with any live jobs beside them; the host then restarts with a cap of one.
const JOB4 = '01ARZ3NDEKTSV4RRFFQ69G5FAX';
const overCap = async (t, terminalJobs, live = []) => {
  let terminal = [];
  const options = { maxJobs: 4, maxContextRecords: 4, contextSessionState: ({ jobId }) => terminal.includes(jobId) ? 'finalised' : null };
  const f = await accountingFixture(t, options);
  oldContextStep(f, JOB);
  for (const jobId of [JOB2, ...live]) f.store().finish(oldReserve(f, f.payload({ jobId })), 200, '{}');
  Object.assign(options, { maxJobs: 1, maxContextRecords: 1 });
  f.setTime(T0 + 7200000); f.reopen(); terminal = terminalJobs;
  return f;
};
const ledgerJobs = (f) => f.db.prepare(`SELECT job FROM peer_jobs UNION SELECT job FROM peer_context_admissions
  UNION SELECT jobId FROM kit_job_holds ORDER BY job`).all().map(row => row.job);
const startC = (f, extra = {}) => f.store().reserve(contextPayload(f, { buyer: OTHER.claim, jobId: JOB3 }), { scope: { jobId: JOB3 } }, { admit: f.now, ...extra });

test('a job count above the cap after a restart counts a retired admission-only job once: the context start is refused with nothing retired', async t => {
  const f = await overCap(t, [JOB]);
  const before = ledgerJobs(f);
  assert.deepEqual(before, [JOB, JOB2].sort());
  assert.throws(() => startC(f), refused('peer_job_capacity', 503));
  assert.deepEqual(ledgerJobs(f), before);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM peer_context_admissions WHERE job = ?').get(JOB3).n, 0);
});

test('a dry check of a context start above the cap after a restart is refused the same way and writes nothing', async t => {
  const f = await overCap(t, [JOB]);
  const before = ledgerJobs(f);
  assert.throws(() => startC(f, { dryRun: true }), refused('peer_job_capacity', 503));
  assert.deepEqual(ledgerJobs(f), before);
});

test('a retirable job is not skipped when an admission-only job is also in the plan: both leave and the context start is admitted', async t => {
  const f = await overCap(t, [JOB, JOB2]);
  assert.equal(startC(f).disposition, 'perform');
  assert.deepEqual(ledgerJobs(f), [JOB3]);
});

test('a ledger over the cap by two with only one job able to leave still refuses a context start', async t => {
  const f = await overCap(t, [JOB], [JOB4]);
  const before = ledgerJobs(f);
  assert.equal(before.length, 3);
  assert.throws(() => startC(f), refused('peer_job_capacity', 503));
  assert.deepEqual(ledgerJobs(f), before);
});

test('a retired admission-only job frees its slot at the limit without a restart: the context start is admitted beside the live job', async t => {
  let terminal = false;
  const f = await accountingFixture(t, { maxJobs: 2, maxContextRecords: 1, contextSessionState: ({ jobId }) => terminal && jobId === JOB ? 'finalised' : null });
  oldContextStep(f, JOB);
  f.store().finish(oldReserve(f, f.payload({ jobId: JOB2 })), 200, '{}');
  f.setTime(T0 + 7200000); terminal = true;
  assert.equal(startC(f).disposition, 'perform');
  assert.deepEqual(ledgerJobs(f), [JOB2, JOB3].sort());
});

test('accounting-payment-tuple-commit-cuts', async t => {
  for (const table of ['kit_job_holds', 'kit_payment_transactions', 'kit_reservations', 'peer_jobs', 'kit_purchase_profiles']) {
    const f = await accountingFixture(t);
    f.db.exec(`CREATE TRIGGER cut_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'TEST insert cut'); END`);
    await assert.rejects(f.reserve(f.args(f.payload({ path: PAYMENTS }))), /TEST insert cut/);
    f.reopen(); f.assertEmpty(); assert.equal(claimCount(f), 0);
  }
  // Deferred FK violation reaches COMMIT after all step-6 statements succeeded.
  const f = await accountingFixture(t);
  f.db.exec('CREATE TABLE commit_guard (job TEXT REFERENCES kit_purchase_profiles(job) DEFERRABLE INITIALLY DEFERRED)');
  await assert.rejects(f.reserve(f.args(f.payload({ path: PAYMENTS }), { checkCapacityWithin: ({ run }) => {
    run('INSERT INTO commit_guard VALUES (?)', 'TEST-missing-job'); return { class: 'general', allocationId: null };
  } })), /FOREIGN KEY constraint failed/);
  f.reopen(); f.assertEmpty(); assert.equal(claimCount(f), 0);
});

test('a payment reservation carries its own transaction claim and no other route carries one', async t => {
  const f = await accountingFixture(t);
  const pay = f.payload({ path: PAYMENTS });
  const wrong = sha256Hex('another transaction');
  await assert.rejects(f.reserve(f.args(pay, { paymentTx: null })), refused('wire_input_invalid', 500));
  await assert.rejects(f.reserve(f.args(pay, { paymentTx: undefined })), refused('wire_input_invalid', 500));
  await assert.rejects(f.reserve(f.args(pay, { paymentTx: wrong })), refused('wire_input_invalid', 500));
  await assert.rejects(f.reserve(f.args(pay, { checked: { reserve: async () => ({ state: 'new' }), body: {} } })), refused('wire_input_invalid', 500));
  await assert.rejects(f.reserve(f.args(pay, { checked: { reserve: async () => ({ state: 'new' }), body: { txHash: 'not a transaction' }, }, paymentTx: 'not a transaction' })), refused('wire_input_invalid', 500));
  for (const path of [f.payload().path, CONTEXT, BUYER_COPY]) {
    await assert.rejects(f.reserve(f.args(f.payload({ path }), { paymentTx: PAYMENT_TX })), refused('wire_input_invalid', 500));
  }
  f.assertEmpty(); assert.equal(claimCount(f), 0);
});

test('an admitted payment reservation records its transaction row, in the form the transport store keeps', async t => {
  const f = await accountingFixture(t);
  const pay = f.payload({ path: PAYMENTS });
  const upper = '0x' + PAYMENT_TX.toUpperCase();
  assert.equal((await f.reserve(f.args(pay, { checked: { reserve: async () => ({ state: 'new' }), body: { payerPayingKey: pay.buyer, txHash: upper } }, paymentTx: upper }))).state, 'new');
  assert.deepEqual(f.payments(), [{ tx: PAYMENT_TX, jobId: JOB, operationId: wireOperationId(pay) }]);
  assert.equal(f.rows().length, 1);
});

test('a charged hold cannot be deleted while a reservation references it', async t => {
  const f = await accountingFixture(t);
  await f.reserve(f.args(contextPayload(f)));
  assert.throws(() => f.db.prepare('DELETE FROM kit_job_holds').run(), /FOREIGN KEY constraint failed/);
  assert.equal(f.holds().length, 1); assert.equal(f.rows().length, 1);
});

test('accounting leaves no job row when the tuple write after it fails', async t => {
  const f = await accountingFixture(t);
  f.db.exec("CREATE TRIGGER no_tuple BEFORE INSERT ON kit_purchase_profiles BEGIN SELECT RAISE(ABORT, 'TEST tuple write failed'); END");
  await assert.rejects(f.reserve(f.args()), /TEST tuple write failed/);
  f.reopen(); f.assertEmpty();
});

test('accounting keeps a charged row reserving when the reservation fails with a system error code', async t => {
  const f = await accountingFixture(t);
  const systemError = Object.assign(new Error('TEST disk failure'), { code: 'EIO' });
  await assert.rejects(f.reserve(f.args(undefined, { checked: { reserve: async () => { throw systemError; } } })), error => error === systemError);
  assert.equal(f.rows()[0].state, 'reserving'); assert.equal(f.rows()[0].code, null);
});

test('P11b1-T13 with the shipped guard off, accounting refuses before any row', async t => {
  const f = await accountingFixture(t);
  const source = `import { createSellerTransportStore } from ${JSON.stringify(new URL('../src/dacs/seller-transport-auth.mjs', import.meta.url).href)};
    const store = createSellerTransportStore({path:process.argv[1]});
    const input = new Proxy({}, {get() {throw new Error('TEST options read before guard');}});
    try { await store.reservationAccounting.reserveAccounted(input); process.exitCode=1; }
    catch(error) { if(error.code!=='kit_operation_guard_off') throw error; }
    finally { store.close(); }`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, f.path], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.equal(result.status, 0, result.stderr); f.assertEmpty();
});

test('P11b1-T14 with maxJobs full and ready true, fresh-job refusals at steps 1–5 (job capacity, buyer rate, context records, the step-5 hook) and a failed commit each leave the tuple count unchanged, also after restart; an admitted new job keeps exactly one tuple in step 6; an absent keepProfile, on the context route as on the others, is refused before step 1 with no row, unit or file', async t => {
  for (const path of [CONTEXT, PAYMENTS]) {
    const f = await accountingFixture(t); f.setTime(NaN);
    await assert.rejects(f.reserve(f.args(f.payload({ path }), { keepProfile: undefined })), refused('tp1_purchase_profile_mismatch', 500));
    f.reopen(); f.assertEmpty();
  }
  const checks = [
    { time: -1, code: 'peer_clock_invalid' },
    { sql: "CREATE TRIGGER no_tuple BEFORE INSERT ON kit_purchase_profiles BEGIN SELECT RAISE(ABORT, 'TEST tuple write failed'); END", code: /TEST tuple write failed/ },
    { hook: () => { throw new SellerTransportError('peer_store_capacity', 503); }, code: 'peer_store_capacity' },
  ];
  for (const check of checks) {
    const f = await accountingFixture(t);
    if (check.sql) f.db.exec(check.sql);
    if (check.time !== undefined) f.setTime(check.time);
    const input = f.args(undefined, { checkCapacityWithin: check.hook });
    await assert.rejects(f.reserve(input), typeof check.code === 'string' ? refused(check.code) : check.code);
    f.reopen(); f.assertEmpty();
  }
  const f = await accountingFixture(t, { maxJobs: 1, maxNoncesPerBuyerPerWindow: 1 });
  await f.reserve(f.args()); assert.equal(f.tuples(), 1);
  await assert.rejects(f.reserve(f.args(f.payload({ jobId: JOB2 }))), refused('peer_buyer_nonce_limit'));
  f.reopen(); assert.equal(f.tuples(), 1);
  f.setTime(T0 + 60000);
  await assert.rejects(f.reserve(f.args(f.payload({ jobId: JOB2 }))), refused('peer_job_capacity'));
  f.reopen(); assert.equal(f.tuples(), 1);
  const changed = { ...FIXTURE_PROFILE, pinVersion: 'TEST-other-pin' };
  await assert.rejects(f.reserve(f.args(undefined, { keepProfile: changed })), refused('tp1_purchase_profile_mismatch'));
  assert.equal(f.tuples(), 1); assert.equal(f.rows().length, 1);
  const context = await accountingFixture(t, { maxContextRecords: 1 });
  admitContextRecord(context, JOB2);
  await assert.rejects(context.reserve(context.args(contextPayload(context))), refused('peer_context_capacity'));
  context.reopen(); context.assertEmpty();
});

test('accounting-unpublished-row-repeat', async t => {
  const f = await accountingFixture(t); const input = f.args(undefined, { checked: { reserve: crash } });
  await assert.rejects(f.reserve(input), error => error === cause); f.reopen();
  let calls = 0; input.checked.reserve = async () => { calls++; return { state: 'new' }; };
  await assert.rejects(f.reserve(input), refused('peer_request_replayed', 409));
  assert.equal(calls, 0); assert.equal(f.rows().length, 1); assert.equal(f.files().length, 0); assert.equal(f.rows()[0].state, 'reserving');
});

test('accounting-nonce-only-publication-cut', async t => {
  // The journal publishes the nonce key, then fails on its own clock: no attempt exists, and the charge stays.
  // K5 step 8 (amend1 D19) records the coded failure as refused{code}; it is not proof that nothing was published.
  const f = await accountingFixture(t); const input = await f.admit();
  const original = input.checked.reserve;
  input.checked.reserve = async () => { f.setTime(NaN); return original(); };
  await assert.rejects(f.reserve(input), refused('seller_configuration_invalid', 500));
  f.setTime(T0); f.reopen();
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].state, 'refused'); assert.equal(f.rows()[0].code, 'seller_configuration_invalid');
  assert.equal(f.nonces().length, 1); assert.equal(f.files().length, 1); assert.equal(f.holds().length, 1);
  assert.equal(inspectWireOperation(f.journal, input.payload).state, 'none');
  assert.equal(JSON.parse(readFileSync(join(f.journalDir, f.nonces()[0]), 'utf8')).requestHash, wireRequestHash(input.payload));
});

test('accounting-refusal-before-result-cas', async t => {
  const f = await accountingFixture(t); casFailure(f);
  const expired = new SellerTransportError('peer_expired', 408);
  const input = f.args(undefined, { checked: { reserve: async () => { throw expired; } } });
  await assert.rejects(f.reserve(input), error => error === expired && /TEST result write failed/.test(String(error.cause)));
  f.reopen(); assert.equal(f.rows()[0].state, 'reserving'); assert.equal(f.rows().length, 1); assert.equal(f.files().length, 0);
});

test('accounting result CAS refuses a stale worker and preserves the newer row', async t => {
  const f = await accountingFixture(t); const input = f.args();
  input.checked.reserve = async () => {
    f.db.prepare("UPDATE kit_reservations SET state='refused', code='TEST-newer-result', rev=rev+1 WHERE key=?").run(nonceKey(input.payload));
    return { state: 'new' };
  };
  await assert.rejects(f.reserve(input), refused('peer_reconciliation_conflict', 503));
  assert.equal(f.rows()[0].code, 'TEST-newer-result'); assert.equal(f.rows()[0].rev, 2);
});

test('accounting retains an uncoded authority failure and its original cause without declaring success', async t => {
  const f = await accountingFixture(t); const input = f.args(undefined, { checked: { reserve: crash } });
  await assert.rejects(f.reserve(input), error => error === cause);
  assert.equal(f.rows()[0].state, 'reserving'); assert.equal(f.rows()[0].requestHash, wireRequestHash(input.payload));
  assert.equal(f.rows()[0].key, nonceKey(input.payload)); assert.equal(f.rows()[0].operationId, wireOperationId(input.payload));
});

test('accounting rejects incomplete limits and missing step-5 decisions', async t => {
  assert.throws(() => createReservationAccounting({ store: {}, now: () => T0, limits: {} }), TypeError);
  for (const decision of [null, undefined, {}, { class: 'unknown', allocationId: null }]) {
    const f = await accountingFixture(t);
    await assert.rejects(f.reserve(f.args(undefined, { checkCapacityWithin: () => decision })), refused('wire_input_invalid', 500));
    f.reopen(); f.assertEmpty();
  }
});

test('accounting records recovery and replay without replacing an operation or refunding a unit', async t => {
  const f = await accountingFixture(t); const first = await f.admit();
  await f.reserve(first); f.setTime(T0 + 300000);
  const retry = await f.admit();
  assert.equal((await f.reserve(retry)).state, 'recover'); assert.equal(f.rows()[1].state, 'recover');
  assert.equal(f.rows().length, 2); assert.equal(f.nonces().length, 2);
  await assert.rejects(f.reserve(retry), refused('peer_request_replayed', 409));
  assert.equal(f.rows().length, 2); assert.equal(f.nonces().length, 2);
});

test('accounting refuses an unknown wire result and keeps its uncertain charge', async t => {
  const f = await accountingFixture(t);
  await assert.rejects(f.reserve(f.args(undefined, { checked: { reserve: async () => ({ state: 'unknown' }) } })), refused('wire_input_invalid', 500));
  f.reopen(); assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].state, 'reserving'); assert.equal(f.files().length, 0);
});

test('accounting preserves a timeout cause when recording its refusal also fails', async t => {
  const f = await accountingFixture(t); casFailure(f);
  const timeout = new Error('TEST authority deadline'), failure = new SellerTransportError('tp1_authority_timeout', 503, { cause: timeout });
  await assert.rejects(f.reserve(f.args(undefined, { checked: { reserve: async () => { throw failure; } } })), error => error === failure && error.cause === timeout);
  f.reopen(); assert.equal(f.rows()[0].state, 'reserving'); assert.equal(f.rows().length, 1);
});

// One ledger for both paths: each limit counts every record either path writes.
test('the reservation ledger lists the sources and writers the matrix below covers', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(RESERVATION_LEDGER).map(([kind, sources]) => [kind, sources.length])),
    { buyerUnits: 2, jobs: 4, contextRecords: 3, owners: 6 });
  const source = ['seller-transport-auth.mjs', 'seller-reservation-accounting.mjs', 'seller-admission-transaction.mjs']
    .map(name => readFileSync(new URL(`../src/dacs/${name}`, import.meta.url), 'utf8')).join('\n');
  const writers = table => source.match(new RegExp(`INSERT (?:OR \\w+ )?INTO ${table}\\b`, 'g'))?.length ?? 0;
  assert.equal(writers('kit_slot_retirements'), 2, 'the store retirement writer keeps terminal flags and open ownership');
  assert.equal([...RESERVATION_LEDGER.jobs, ...RESERVATION_LEDGER.contextRecords].some(sql => /kit_purchase_profiles|kit_slot_retirements/.test(sql)), false, 'tuples and ownership proofs hold no slots');
  // peer_nonce_retention: the legacy-row upgrade and the old reservation (K1 refusals live in the challenge ledger);
  // peer_jobs: the old proposal and accounting's first purchase; K1 admissions retain their own intent before a tuple.
  assert.deepEqual(Object.fromEntries(['peer_nonce_retention', 'peer_jobs', 'peer_context_admissions', 'kit_job_holds', 'kit_reservations', 'kit_context_admissions']
    .map(table => [table, writers(table)])), { peer_nonce_retention: 2, peer_jobs: 2, peer_context_admissions: 1, kit_job_holds: 1, kit_reservations: 1, kit_context_admissions: 1 });
});

const WRITERS = [
  { name: 'an old proposal', job: true, context: false, write: f => { oldReserve(f, f.payload()); } },
  { name: 'an old context admission', job: true, context: true, write: f => oldContextStep(f) },
  { name: 'an old refusal record', job: false, context: false,
    write: f => assert.throws(() => f.store().reserve(contextPayload(f), { scope: { jobId: JOB } }, { admit: f.now, verdict: 'TEST-refused' }), refused('TEST-refused', 409)) },
  { name: 'an accounted proposal', job: true, context: false, write: f => f.reserve(f.args()) },
  { name: 'an accounted context start', job: true, context: true, write: f => f.reserve(f.args(contextPayload(f))) },
  { name: 'an accounted context start that crashes before its reservation', job: true, context: true,
    write: f => assert.rejects(f.reserve(f.args(contextPayload(f), { checked: { reserve: crash } })), error => error === cause) },
  { name: 'an accounted proposal that crashes after publication', job: true, context: false, write: async f => {
    const input = await f.admit(); const publish = input.checked.reserve;
    input.checked.reserve = async () => { await publish(); throw cause; };
    await assert.rejects(f.reserve(input), error => error === cause);
  } },
  { name: 'an accounted context start whose result write fails', job: true, context: true, write: async f => {
    casFailure(f); await assert.rejects(f.reserve(f.args(contextPayload(f))), /TEST result write failed/); dropCasFailure(f);
  } },
];
const LIMITS = [
  { name: 'buyer window', options: { maxNoncesPerBuyerPerWindow: 1 }, contender: f => f.payload({ jobId: JOB2 }), counts: () => true, refusal: refused('peer_buyer_nonce_limit', 429) },
  { name: 'jobs', options: { maxJobs: 1 }, contender: f => f.payload({ buyer: OTHER.claim, jobId: JOB2 }), counts: w => w.job, refusal: refused('peer_job_capacity', 503) },
  { name: 'context records', options: { maxContextRecords: 1 }, contender: f => contextPayload(f, { buyer: OTHER.claim, jobId: JOB2 }),
    counts: w => w.context, refusal: refused('peer_context_capacity', 503) },
  { name: 'job owner', options: {}, contender: f => f.payload({ buyer: OTHER.claim }), counts: w => w.job, refusal: refused('peer_job_conflict', 409) },
  // Only a job row fixes the Agreement; a context admission or an accounting hold carries none.
  { name: 'job Agreement', options: {}, contender: f => f.payload({ agreementHash: sha256Hex('other agreement') }), counts: w => w.job && !w.context,
    refusal: refused('peer_job_conflict', 409) },
];
const READERS = [
  { name: 'old', read: (f, p) => Promise.resolve().then(() => oldReserve(f, p)) },
  { name: 'accounted', read: (f, p) => f.reserve(f.args(p)) },
];
for (const writer of WRITERS) for (const limit of LIMITS) for (const reader of READERS) {
  test(`ledger matrix: after ${writer.name} and a restart, the ${reader.name} path ${limit.counts(writer) ? 'counts it against' : 'leaves free'} the ${limit.name}`, async t => {
    const f = await accountingFixture(t, limit.options);
    await writer.write(f); f.reopen();
    const read = reader.read(f, limit.contender(f));
    if (limit.counts(writer)) await assert.rejects(read, limit.refusal);
    else await read;
  });
}

test('F1: a context start that crashed after its commit holds its job slot after restart against both paths, and its own retry needs no second slot', async t => {
  const f = await accountingFixture(t, { maxJobs: 1 });
  await assert.rejects(f.reserve(f.args(contextPayload(f), { checked: { reserve: crash } })), error => error === cause);
  f.reopen();
  await assert.rejects(f.reserve(f.args(f.payload({ jobId: JOB2 }))), refused('peer_job_capacity', 503));
  assert.throws(() => oldReserve(f, f.payload({ jobId: JOB2 })), refused('peer_job_capacity', 503));
  assert.equal((await f.reserve(f.args(contextPayload(f)))).state, 'new');
  assert.equal((await f.reserve(f.args(f.payload()))).state, 'new');
  assert.equal(f.holds().length, 1); assert.equal(f.rows().length, 3);
});

test('F1c: a second accounted context start for another job is refused at one context record; a retry for the first is not', async t => {
  const f = await accountingFixture(t, { maxContextRecords: 1 });
  await f.reserve(f.args(contextPayload(f)));
  await assert.rejects(f.reserve(f.args(contextPayload(f, { jobId: JOB2 }))), refused('peer_context_capacity', 503));
  assert.equal((await f.reserve(f.args(contextPayload(f)))).state, 'new');
  f.reopen(); assert.equal(f.rows().length, 2); assert.equal(f.holds().length, 1);
});

test('F2: one buyer window counts both paths in either order and interleaved; other buyers stay independent; the exact window end admits again', async t => {
  const orders = [['old', 'accounted'], ['accounted', 'old'], ['old', 'accounted', 'old', 'accounted']];
  for (const order of orders) {
    const limit = order.length / 2;
    const f = await accountingFixture(t, { maxNoncesPerBuyerPerWindow: limit });
    const send = (path, p) => path === 'old' ? Promise.resolve().then(() => oldReserve(f, p)) : f.reserve(f.args(p));
    // Each request is its own job: one job and route takes one effect, whichever path reserves it.
    let jobs = 0;
    const fresh = (change = {}) => f.payload({ jobId: jobAt(jobs++), ...change });
    for (const path of order.slice(0, limit)) await send(path, fresh());
    for (const path of order.slice(limit)) await assert.rejects(send(path, fresh()), refused('peer_buyer_nonce_limit', 429));
    for (const path of order.slice(limit)) await send(path, fresh({ buyer: OTHER.claim }));
    f.setTime(T0 + 59999);
    await assert.rejects(send(order.at(-1), fresh()), refused('peer_buyer_nonce_limit', 429));
    f.setTime(T0 + 60000);
    await send(order.at(-1), fresh());
  }
});

test("D-9: another buyer's accounted proposal cannot take over a job held by an admission or an accounted context start, also after restart and while pending", async t => {
  const holders = [
    { name: 'old context admission', hold: f => oldContextStep(f) },
    { name: 'accounted context start', hold: f => f.reserve(f.args(contextPayload(f))) },
    { name: 'pending accounted context start', hold: f => assert.rejects(f.reserve(f.args(contextPayload(f), { checked: { reserve: crash } })), error => error === cause) },
  ];
  for (const holder of holders) for (const restart of [false, true]) {
    const f = await accountingFixture(t);
    await holder.hold(f);
    if (restart) f.reopen();
    await assert.rejects(f.reserve(f.args(f.payload({ buyer: OTHER.claim }))), refused('peer_job_conflict', 409), holder.name);
    await assert.rejects(f.reserve(f.args(contextPayload(f, { buyer: OTHER.claim }))), refused('peer_job_conflict', 409), holder.name);
    assert.equal(f.jobRows().length, 0); assert.equal(f.tuples(), 0);
    assert.ok(f.holds().every(hold => hold.buyer === BUYER.claim));
    assert.equal((await f.reserve(f.args(f.payload()))).state, 'new', holder.name);
    assert.equal(JSON.parse(f.jobRows()[0].context).buyer, BUYER.claim);
  }
});

test("the old path refuses another buyer's request for a job an accounted context start holds", async t => {
  const f = await accountingFixture(t);
  await f.reserve(f.args(contextPayload(f)));
  assert.throws(() => oldReserve(f, f.payload({ buyer: OTHER.claim })), refused('peer_job_conflict', 409));
  assert.throws(() => oldReserve(f, contextPayload(f, { buyer: OTHER.claim })), refused('peer_job_conflict', 409));
  assert.equal(f.jobRows().length, 0);
  assert.doesNotThrow(() => oldReserve(f, f.payload()));
});

// Exercise presentation decisions through the D21 context route and its retained challenge ledger.
async function presentedContextFixture(t, options = {}) {
  const limits = { maxStartsPerHour: 100, maxStartsPerBuyerPerHour: 100 };
  const w = await contextWorld(t, { ...options, limits, recover: presentContext });
  const input = await w.wire({ jobId: JOB }), p = w.auth.readRequest(input.header), body = JSON.parse(input.text);
  let store = w.store;
  t.after(() => store.close());
  return { w, p, body, store: () => store, reopen() {
    store.close();
    store = createSellerTransportStore({ path: w.path, now: w.now, contextStartLimits: limits, ...options });
  } };
}
const issueChallenge = (f, jobId = JOB) => f.store().challenges.issue({ jobId, buyer: f.p.buyer },
  sellerContextScopeHash(sellerContextChallengeScope({ ...f.body.scope, jobId })));
const presented = (f) => () => f.w.route.reserve(f.p, f.body, f.store());

test('a context start refused at full job capacity consumes its challenge, so the presentation cannot be tried again', async t => {
  const f = await presentedContextFixture(t, { maxJobs: 1 });
  f.store().reserve({ ...f.p, jobId: JOB2, path: PROPOSALS, nonce: sha256Hex('full-job prior nonce') }, {});
  const challenge = issueChallenge(f), start = presented(f);
  await assert.rejects(start(), refused('peer_job_capacity', 503));
  const retained = f.store().challenges.retained(challenge.sessionNonce);
  assert.equal(retained.state, 'failed');
  assert.equal(retained.failure.code, 'peer_job_capacity');
  await assert.rejects(start(), error => error.code === 'context_challenge_failed' && error.cause === 'peer_job_capacity');
  const db = new DatabaseSync(f.w.path);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_nonces').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'peer_context_admissions'").get().n, 0);
  // The same dry store decision refuses without a second nonce or an admission.
  assert.throws(() => f.store().reserve(f.p, f.body, { admit: f.w.now, dryRun: true }), refused('peer_job_capacity', 503));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM peer_nonces').get().n, 1);
});

test('a job that already holds the only context record retries its retained challenge; another job is not issued one', async t => {
  for (const accounted of [false, true]) for (const restart of [false, true]) {
    const f = await presentedContextFixture(t, { maxContextRecords: 1 });
    const challenge = issueChallenge(f);
    if (accounted) {
      const payload = { ...f.p, profile: FIXTURE_PROFILE };
      await f.store().reservationAccounting.reserveAccounted({ checked: { body: {}, reserve: async () => ({ state: 'new' }) },
        payload, route: CONTEXT, operationId: wireOperationId(payload), keepProfile: FIXTURE_PROFILE });
    } else {
      const reservation = await presented(f)();
      f.store().finish(reservation, 200, JSON.stringify(await presentContext(f.body)));
    }
    if (restart) f.reopen();
    assert.equal(challenge.expiresAt, f.w.now() + 600000);
    assert.throws(() => issueChallenge(f, JOB2), refused('peer_context_capacity', 503));
    if (accounted) {
      assert.equal(issueChallenge(f).sessionNonce, challenge.sessionNonce);
      await assert.rejects(presented(f)(), refused('peer_operation_conflict', 409));
    } else {
      // K1 closes fresh issuance once a presentation has been accepted; the accepted nonce alone retries.
      assert.throws(() => issueChallenge(f), refused('context_job_closed', 409));
      assert.equal((await presented(f)()).disposition, 'cached');
    }
  }
});

// One job identity rule for both paths: a job row fixes the job's Agreement, so another Agreement for the job is refused
// before any charge, unit, file or write.
const OTHER_AGREEMENT = sha256Hex('other agreement');
const state = f => ({ rows: f.rows().length, files: f.files(), jobs: f.jobRows(), tuples: f.tuples(), holds: f.holds().length });

test('a proposal that crashed after its commit keeps the job on its Agreement: another Agreement is refused before any charge, also after restart, and the same one is admitted', async t => {
  const f = await accountingFixture(t);
  await assert.rejects(f.reserve(f.args(f.payload(), { checked: { reserve: crash } })), error => error === cause);
  for (const restart of [false, true]) {
    if (restart) f.reopen();
    const before = state(f);
    await assert.rejects(f.reserve(await f.admit(f.payload({ agreementHash: OTHER_AGREEMENT }))), refused('peer_job_conflict', 409));
    assert.deepEqual(state(f), before);
  }
  assert.equal(JSON.parse(f.jobRows()[0].context).agreementHash, f.payload().agreementHash);
  assert.equal((await f.reserve(await f.admit())).state, 'new');
});

test('the old path wrote the job with its Agreement: an accounted request for another Agreement is refused with no row or file, and the old path agrees', async t => {
  const f = await accountingFixture(t);
  f.store().finish(oldReserve(f, f.payload()), 200, '{}');
  const before = state(f);
  await assert.rejects(f.reserve(await f.admit(f.payload({ agreementHash: OTHER_AGREEMENT }))), refused('peer_job_conflict', 409));
  assert.deepEqual(state(f), before); assert.deepEqual(f.files(), []);
  assert.throws(() => oldReserve(f, f.payload({ agreementHash: OTHER_AGREEMENT })), refused('peer_job_conflict', 409));
});

test('a completed accounted proposal fixes the Agreement for the job\'s payment on another route, which publishes no file', async t => {
  const f = await accountingFixture(t);
  const pin = listingPin(fixtureListing(SELLER, { now: T0 }));
  assert.equal((await f.reserve(await f.admit(f.payload({ listingPin: pin })))).state, 'new');
  const before = state(f);
  await assert.rejects(f.reserve(await f.payment(JOB)), refused('peer_job_conflict', 409));
  assert.deepEqual(state(f), before);
});

test('a proposal refused before publication still holds the job on its Agreement', async t => {
  const f = await accountingFixture(t);
  const expired = Object.assign(new Error('TEST expired'), { code: 'peer_expired', status: 408 });
  await assert.rejects(f.reserve(f.args(f.payload(), { checked: { reserve: async () => { throw expired; } } })), error => error === expired);
  assert.equal(f.rows()[0].code, 'peer_expired');
  const before = state(f);
  await assert.rejects(f.reserve(await f.admit(f.payload({ agreementHash: OTHER_AGREEMENT }))), refused('peer_job_conflict', 409));
  assert.deepEqual(state(f), before);
});

test('another Agreement is refused while the first proposal is still awaiting its reservation, and the first then completes', async t => {
  const f = await accountingFixture(t);
  let open; const gate = new Promise(resolve => { open = resolve; });
  const first = f.reserve(f.args(f.payload(), { checked: { reserve: async () => { await gate; return { state: 'new' }; } } }));
  const before = state(f);
  await assert.rejects(f.reserve(await f.admit(f.payload({ agreementHash: OTHER_AGREEMENT }))), refused('peer_job_conflict', 409));
  assert.deepEqual(state(f), before);
  open();
  assert.equal((await first).state, 'new');
  assert.equal(f.rows()[0].state, 'new');
});

test('a job with a job row still admits its own context start, the same Agreement, and a full-window refusal comes before the Agreement check', async t => {
  const f = await accountingFixture(t, { maxNoncesPerBuyerPerWindow: 3 });
  assert.equal((await f.reserve(f.args(f.payload()))).state, 'new');
  assert.doesNotThrow(() => oldReserve(f, contextPayload(f)));
  assert.equal((await f.reserve(f.args(contextPayload(f, { jobId: JOB2 })))).state, 'new');
  assert.equal(f.jobRows().length, 1);
  await assert.rejects(f.reserve(f.args(f.payload({ agreementHash: OTHER_AGREEMENT }))), refused('peer_buyer_nonce_limit', 429));
});

// One rule per refusal of the old reserve path that reads journal state: both paths apply it before any write.
const terminalFixture = async (t, options = {}) => {
  const session = { state: null };
  const f = await accountingFixture(t, { ...options, contextSessionState: ({ jobId }) => jobId === JOB ? session.state : null });
  return [f, session];
};
const slots = f => f.db.prepare('SELECT COUNT(*) AS n FROM peer_slots').get().n;
const txHash = 'ab'.repeat(32);
const oldPayment = (f, p) => f.store().reserve({ ...p, nonce: f.payload().nonce }, { txHash }, { keepProfile: FIXTURE_PROFILE });
const wireRefusal = Object.assign(new Error('TEST refused'), { code: 'TEST-refused', status: 409 });
const refuses = async () => { throw wireRefusal; };

test('a fresh accounted proposal or context start for a terminal session is refused with nothing written, as the old path refuses it', async t => {
  for (const start of ['proposal', 'context']) for (const restart of [false, true]) {
    const [f, session] = await terminalFixture(t);
    session.state = 'finalised';
    if (restart) f.reopen();
    await assert.rejects(start === 'proposal' ? f.reserve(await f.admit()) : f.reserve(await f.admitContext()), refused('context_session_terminal', 409), start);
    f.assertEmpty();
    assert.throws(() => oldReserve(f, start === 'proposal' ? f.payload() : contextPayload(f)), refused('context_session_terminal', 409), start);
  }
});

// An operation is the seller, job and route, so a retry is a request on a route that job already reserved.
test('a session that turns terminal after an accounted proposal refuses the job\'s context start and still answers the proposal retry', async t => {
  const [f, session] = await terminalFixture(t);
  await f.reserve(await f.admit());
  session.state = 'finalised';
  await assert.rejects(f.reserve(await f.admitContext()), refused('context_session_terminal', 409));
  assert.equal(f.rows().length, 1);
  f.setTime(T0 + 400000);
  assert.equal((await f.reserve(await f.admit())).state, 'recover');
  assert.equal(f.rows().length, 2);
});

test('a refused accounted reservation does not make its operation a retry for a terminal session', async t => {
  const [f, session] = await terminalFixture(t);
  await assert.rejects(f.reserve(f.args(f.payload(), { checked: { reserve: refuses } })), refused('TEST-refused', 409));
  session.state = 'finalised';
  await assert.rejects(f.reserve(f.args()), refused('context_session_terminal', 409));
  assert.equal(f.rows().length, 1);
});

// An operation is only {seller, jobId, path}: a start with another context scope hash or Agreement hash shares the operation of
// an earlier row, and only the wire's recorded binding tells it from a retry. It is refused before any charge, not by the wire after one.
test('a terminal session refuses a start whose binding differs from the one the wire holds, before any charge, on a new or a reserving row', async t => {
  for (const state of ['new', 'reserving']) for (const restart of [false, true]) {
    const [f, session] = await terminalFixture(t);
    if (state === 'reserving') casFailure(f);
    const first = f.reserve(await f.admitContext());
    if (state === 'reserving') { await assert.rejects(first, /TEST result write failed/); dropCasFailure(f); } else await first;
    session.state = 'finalised';
    if (restart) f.reopen();
    assert.equal(f.rows()[0].state, state);
    const files = f.files(), view = inspectWireOperation(f.journal, f.payload({ path: CONTEXT }));
    const other = await f.admitContext(contextPayload(f, { agreementHash: sha256Hex('other scope') }));
    f.setTime(T0 + 400000);
    await assert.rejects(f.reserve(other), refused('context_session_terminal', 409), `${state} ${restart}`);
    assert.equal(f.rows().length, 1); assert.deepEqual(f.files(), files); assert.equal(f.holds().length, 1);
    assert.deepEqual(inspectWireOperation(f.journal, other.payload), view);
    // The same binding is still the retry.
    assert.equal((await f.reserve(await f.admitContext())).state, 'recover', `${state} ${restart}`);
    assert.equal(f.rows().length, 2);
  }
});

test('a terminal session refuses a proposal with another Agreement hash for the job without charging it', async t => {
  const [f, session] = await terminalFixture(t);
  await f.reserve(await f.admit());
  session.state = 'finalised';
  f.setTime(T0 + 400000);
  await assert.rejects(f.reserve(await f.admit(f.payload({ agreementHash: OTHER_AGREEMENT }))), refused('peer_job_conflict', 409));
  assert.equal(f.rows().length, 1);
});

test('a terminal session refuses a retry the wire cannot show a binding for, on a row the wire answered', async t => {
  for (const view of [() => null, () => ({ state: 'none' })]) {
    const [f, session] = await terminalFixture(t, { wireOperationView: view });
    await f.reserve(await f.admit());
    session.state = 'finalised';
    await assert.rejects(f.reserve(await f.admit()), refused('context_session_terminal', 409));
    assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].state, 'new');
  }
});

// A `reserving` row is a retry only when the wire's own record holds the operation. Each start goes through the real wire.
const starts = {
  proposal: { first: f => f.args(), retry: f => f.admit() },
  context: { first: f => f.args(contextPayload(f)), retry: f => f.admitContext() },
};

test('a crash after the row commits but before the reservation publishes does not make a terminal session\'s fresh start a retry', async t => {
  for (const start of Object.keys(starts)) for (const restart of [false, true]) {
    const [f, session] = await terminalFixture(t);
    await assert.rejects(f.reserve({ ...starts[start].first(f), checked: { reserve: crash } }), error => error === cause);
    session.state = 'finalised';
    if (restart) f.reopen();
    const input = await starts[start].retry(f), files = f.files();
    await assert.rejects(f.reserve(input), refused('context_session_terminal', 409), start);
    assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].state, 'reserving'); assert.deepEqual(f.files(), files);
    assert.equal(inspectWireOperation(f.journal, input.payload).state, 'none');
  }
});

test('a crash after the reservation published but before the row moved on still answers the terminal session\'s retry with recover', async t => {
  for (const start of Object.keys(starts)) for (const restart of [false, true]) {
    const [f, session] = await terminalFixture(t); casFailure(f);
    await assert.rejects(f.reserve(await starts[start].retry(f)), /TEST result write failed/);
    dropCasFailure(f); session.state = 'finalised';
    if (restart) f.reopen();
    assert.equal(f.rows()[0].state, 'reserving');
    f.setTime(T0 + 400000);
    assert.equal((await f.reserve(await starts[start].retry(f))).state, 'recover', start);
    assert.equal(f.rows().length, 2);
  }
});

test('a wire refusal whose refused write failed does not make a terminal session\'s fresh start a retry', async t => {
  for (const start of Object.keys(starts)) {
    const [f, session] = await terminalFixture(t); casFailure(f);
    await assert.rejects(f.reserve({ ...starts[start].first(f), checked: { reserve: refuses } }), error => error === wireRefusal && error.cause?.message.includes('TEST result write failed'));
    dropCasFailure(f); session.state = 'finalised'; f.reopen();
    assert.equal(f.rows()[0].state, 'reserving');
    const input = await starts[start].retry(f);
    await assert.rejects(f.reserve(input), refused('context_session_terminal', 409), start);
    assert.equal(f.rows().length, 1); assert.equal(inspectWireOperation(f.journal, input.payload).state, 'none');
  }
});

test('a terminal session with no wire reader refuses a fresh start whose only row is reserving', async t => {
  const [f, session] = await terminalFixture(t, { wireOperationView: () => null });
  await assert.rejects(f.reserve({ ...f.args(), checked: { reserve: crash } }), error => error === cause);
  session.state = 'finalised';
  await assert.rejects(f.reserve(f.args()), refused('context_session_terminal', 409));
  assert.equal(f.rows().length, 1);
});

test('an accounted proposal holds its job and route against the old path: reserve and classify refuse, also after restart and a crash', async t => {
  for (const mode of ['new', 'restart', 'crash']) {
    const f = await accountingFixture(t);
    if (mode === 'crash') await assert.rejects(f.reserve(f.args(f.payload(), { checked: { reserve: crash } })), error => error === cause);
    else await f.reserve(f.args());
    if (mode === 'restart') f.reopen();
    assert.throws(() => oldReserve(f, f.payload()), refused('peer_operation_conflict', 409), mode);
    assert.throws(() => f.store().classify(f.payload(), {}, { keepProfile: FIXTURE_PROFILE }), refused('peer_operation_conflict', 409), mode);
    assert.equal(slots(f), 0); assert.equal(f.rows().length, 1);
  }
});

for (const route of ['proposal', 'context']) {
  const request = f => route === 'proposal' ? f.payload() : contextPayload(f);
  test(`the old ${route} holds its job and route against an accounted one: nothing is charged, held or published, also after restart`, async t => {
    for (const restart of [false, true]) {
      const f = await accountingFixture(t);
      oldReserve(f, request(f));
      if (restart) f.reopen();
      const tuples = f.tuples();
      await assert.rejects(f.reserve(f.args(request(f))), refused('peer_operation_conflict', 409), route);
      assert.equal(f.rows().length, 0); assert.equal(f.holds().length, 0); assert.equal(f.files().length, 0); assert.equal(f.tuples(), tuples);
    }
  });
  test(`an accounted ${route} holds its job and route against the old one, also after restart`, async t => {
    for (const restart of [false, true]) {
      const f = await accountingFixture(t);
      await f.reserve(f.args(request(f)));
      if (restart) f.reopen();
      assert.throws(() => oldReserve(f, request(f)), refused('peer_operation_conflict', 409), route);
      assert.equal(slots(f), 0); assert.equal(f.rows().length, 1);
    }
  });
}

test('an accounted payment and an old payment for the same job hold one effect between them, in either order', async t => {
  const first = await accountingFixture(t);
  const input = await first.payment();
  await first.reserve(input);
  assert.throws(() => oldPayment(first, input.payload), refused('peer_operation_conflict', 409));
  assert.equal(slots(first), 0);
  const second = await accountingFixture(t);
  const next = await second.payment();
  const { agreementHash, listingPin: pin } = next.payload;
  second.store().finish(oldReserve(second, second.payload({ agreementHash, listingPin: pin })), 200, '{}');
  oldPayment(second, next.payload);
  second.reopen();
  await assert.rejects(second.reserve(next), refused('peer_operation_conflict', 409));
  assert.equal(second.rows().length, 0); assert.equal(second.payments().length, 0); assert.equal(second.files().length, 0);
});

test('a refused accounted reservation holds no slot, and a read route takes none', async t => {
  const f = await accountingFixture(t);
  await assert.rejects(f.reserve(f.args(f.payload(), { checked: { reserve: refuses } })), refused('TEST-refused', 409));
  assert.equal(f.rows()[0].state, 'refused');
  assert.doesNotThrow(() => oldReserve(f, f.payload()));
  assert.equal((await f.reserve(f.args(readOf(f)))).state, 'new');
  assert.doesNotThrow(() => oldReserve(f, readOf(f)));
});

test('an accounted read of an unknown job is refused before any charge, and the proposal that follows is admitted', async t => {
  for (const path of [STATE_ROUTE, BUYER_COPY]) for (const restart of [false, true]) {
    const f = await accountingFixture(t, { maxJobs: 1 });
    await assert.rejects(f.reserve(f.args(f.payload({ path }))), refused('peer_unknown_job', 404), path);
    if (restart) f.reopen();
    f.assertEmpty();
    assert.equal((await f.reserve(f.args())).state, 'new', path);
    assert.equal(f.jobRows().length, 1);
  }
  const f = await accountingFixture(t);
  assert.throws(() => oldReserve(f, f.payload({ path: BUYER_COPY })), refused('peer_unknown_job', 404));
});
