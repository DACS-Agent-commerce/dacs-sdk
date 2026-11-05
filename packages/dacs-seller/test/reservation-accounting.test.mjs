import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { completeWireEffect, inspectWireOperation, wireOperationId, wireRequestHash } from '@kynesyslabs/dacs/wire';
import { createSellerTransportStore } from '../src/dacs/seller-transport-auth.mjs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { SellerTransportError } from '../src/dacs/seller-transport-auth.mjs';
import { createReservationAccounting } from '../src/dacs/seller-reservation-accounting.mjs';
import { accountingFixture, T0, JOB, JOB2, BUYER, SELLER, OTHER, PIN, PAYMENTS, CONTEXT, nonceKey } from './helpers/reservation-accounting-fixture.mjs';
import { FIXTURE_PROFILE } from './helpers/wire-authority-fixture.mjs';

const refused = (code, status) => ({ code, ...(status === undefined ? {} : { status }) });
const cause = new Error('TEST interrupted process');
const crash = async () => { throw cause; };
const claimCount = (f) => f.payments().length;
const casFailure = (f) => f.db.exec("CREATE TRIGGER stop_result BEFORE UPDATE ON kit_reservations BEGIN SELECT RAISE(ABORT, 'TEST result write failed'); END");
// The retained context admission the old path wrote; its table exists only after a first admission commits.
const admitContextRecord = (f, jobId) => {
  f.db.exec(`CREATE TABLE peer_context_admissions (job TEXT PRIMARY KEY, buyer TEXT NOT NULL, seller TEXT NOT NULL,
    listing_pin TEXT NOT NULL, scope_hash TEXT NOT NULL, effect TEXT NOT NULL, admitted_at INTEGER NOT NULL)`);
  f.db.prepare('INSERT INTO peer_context_admissions VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(jobId, BUYER.claim, SELLER.claim, JSON.stringify(PIN), sha256Hex('context scope'), sha256Hex('context effect'), T0);
};
const dropCasFailure =(f) => f.db.exec('DROP TRIGGER stop_result');

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

test('P11b1-T03 120 wrong-binding reservations through the real wire are each counted with one file, and the 121st is refused before a row or file', async t => {
  const f = await accountingFixture(t);
  await f.reserve(await f.admit());
  f.setTime(T0 + 60000);
  for (let i = 0; i < 120; i++) {
    const input = await f.admit(f.payload({ agreementHash: sha256Hex('changed retained agreement') }));
    await assert.rejects(f.reserve(input), refused('peer_operation_mismatch', 409));
  }
  const rows = f.rows().slice(1);
  assert.equal(rows.length, 120); assert.ok(rows.every(row => row.class === 'general' && row.code === 'peer_operation_mismatch'));
  assert.equal(f.nonces().length, 121);
  await assert.rejects(f.reserve(await f.admit(f.payload({ agreementHash: sha256Hex('changed retained agreement') }))), refused('peer_buyer_nonce_limit'));
  assert.equal(f.rows().length, 121); assert.equal(f.nonces().length, 121);
});

test('P11b1-T04 wrong-binding requests and pending polls are each counted as general, files equal rows', async t => {
  const f = await accountingFixture(t);
  await f.reserve(await f.admit());
  for (let i = 0; i < 20; i++) {
    await assert.rejects(f.reserve(await f.admit(f.payload({ agreementHash: sha256Hex('other binding') }))), refused('peer_operation_mismatch'));
    await assert.rejects(f.reserve(await f.admit()), refused('seller_effect_pending'));
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
      const input = await f.payment(jobId);
      input.paymentTx = sha256Hex('one payment transaction');
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
  const input = await f.payment(); input.paymentTx = sha256Hex('first claim');
  const effect = await f.reserve(input); let intake = 1;
  completeWireEffect(f.journal, effect, { status: 200, text: '{"status":"delivered"}' });
  const retry = await f.payment(); retry.paymentTx = sha256Hex('second claim');
  const result = await f.reserve(retry); if (result.state !== 'completed') intake++;
  assert.equal(result.state, 'completed'); assert.equal(intake, 1);
  assert.equal(f.rows()[1].class, 'general'); assert.equal(f.rows()[1].state, 'completed'); assert.equal(f.nonces().length, 2);
});

test('P11b1-T12 the ported job and nonce capacity cases pass at accounting level', async t => {
  const f = await accountingFixture(t, { maxJobs: 2, maxNoncesPerBuyerPerWindow: 2, maxContextRecords: 1 });
  const old = f.store().reserve(f.payload(), {}, { keepProfile: FIXTURE_PROFILE });
  f.store().finish(old, 200, '{}'); // One legacy job and its tuple count as one job.
  await f.reserve(f.args()); await f.reserve(f.args());
  await assert.rejects(f.reserve(f.args()), refused('peer_buyer_nonce_limit'));
  // Independent buyer, same job, then another distinct job consumes the last job slot.
  await f.reserve(f.args(f.payload({ buyer: OTHER.claim })));
  f.setTime(T0 + 60000);
  await f.reserve(f.args(f.payload({ jobId: JOB2 })));
  await assert.rejects(f.reserve(f.args(f.payload({ jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' }))), refused('peer_job_capacity'));
  assert.equal(f.tuples(), 2);
  // Context records share the legacy counter and are not inferred from reservation files.
  const context = await accountingFixture(t, { maxContextRecords: 1 });
  admitContextRecord(context, JOB2);
  await assert.rejects(context.reserve(context.args(context.payload({ path: CONTEXT }), { contextStart: true })), refused('peer_context_capacity', 503));
  context.reopen(); context.assertEmpty();
});

test('accounting admits a context retry for a job whose context record is already counted', async t => {
  const f = await accountingFixture(t, { maxContextRecords: 1 });
  admitContextRecord(f, JOB);
  f.db.prepare('INSERT INTO peer_jobs VALUES (?, ?)').run(JOB, canonicalize({ retained: 'TEST job context' }));
  f.db.prepare('INSERT INTO kit_purchase_profiles VALUES (?, ?, ?)').run(JOB, canonicalize(FIXTURE_PROFILE), T0);
  assert.equal((await f.reserve(f.args(f.payload({ path: CONTEXT }), { contextStart: true }))).state, 'new');
  assert.equal(f.rows().length, 1); assert.equal(f.tuples(), 1); assert.equal(f.jobRows().length, 1);
});

test('accounting refuses step 4 for a context start on an existing job that has no context record at capacity', async t => {
  const f = await accountingFixture(t, { maxContextRecords: 1 });
  await f.reserve(f.args());
  admitContextRecord(f, JOB2);
  await assert.rejects(f.reserve(f.args(f.payload({ path: CONTEXT }), { contextStart: true })), refused('peer_context_capacity', 503));
  f.reopen(); assert.equal(f.rows().length, 1); assert.equal(f.tuples(), 1); assert.equal(f.jobRows().length, 1);
});

test('accounting writes no job row or tuple for a context start, so a later proposal for the job is not a conflict', async t => {
  const f = await accountingFixture(t);
  const scope = f.payload({ path: CONTEXT, agreementHash: sha256Hex('context scope') });
  assert.equal((await f.reserve(f.args(scope, { contextStart: true, newJob: true }))).state, 'new');
  assert.equal(f.rows().length, 1); assert.equal(f.jobRows().length, 0); assert.equal(f.tuples(), 0);
  assert.doesNotThrow(() => f.store().reserve(f.payload(), {}, { keepProfile: FIXTURE_PROFILE }));
});

test('accounting admits an accounted proposal as a new job after a context start for the same job', async t => {
  const f = await accountingFixture(t);
  await f.reserve(f.args(f.payload({ path: CONTEXT, agreementHash: sha256Hex('context scope') }), { contextStart: true }));
  assert.equal((await f.reserve(f.args(f.payload(), { newJob: true }))).state, 'new');
  assert.equal(f.jobRows().length, 1); assert.equal(f.tuples(), 1); assert.equal(f.rows().length, 2);
});

// The old path's context step, as a route runs it: it leaves one admission and no job row or tuple.
const oldContextStep = (f, jobId = JOB) => {
  const scope = f.payload({ path: CONTEXT, jobId, agreementHash: sha256Hex('context scope') });
  f.store().finish(f.store().reserve(scope, { scope: { jobId } }, { admit: f.now }), 200, '{}');
};
const admissionOnly = (f, jobId = JOB) => {
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM peer_context_admissions WHERE job = ?').get(jobId).n, 1);
  assert.equal(f.jobRows().length, 0); assert.equal(f.tuples(), 0);
};

test('accounting admits an accounted proposal for a job whose only record is the old context admission', async t => {
  const f = await accountingFixture(t); oldContextStep(f); admissionOnly(f);
  assert.equal((await f.reserve(f.args(f.payload()))).state, 'new');
  assert.equal(f.rows().length, 1); assert.equal(f.jobRows().length, 1); assert.equal(f.tuples(), 1);
});

test('accounting admits an accounted proposal with newJob true for a job whose only record is the old context admission', async t => {
  const f = await accountingFixture(t); oldContextStep(f); admissionOnly(f);
  assert.equal((await f.reserve(f.args(f.payload(), { newJob: true }))).state, 'new');
  assert.equal(f.rows().length, 1); assert.equal(f.jobRows().length, 1); assert.equal(f.tuples(), 1);
  await assert.rejects(f.reserve(f.args(f.payload(), { newJob: true })), refused('wire_input_invalid', 500));
});

test('accounting admits a context retry for a job whose only record is the old context admission, and keeps no job row', async t => {
  const f = await accountingFixture(t, { maxContextRecords: 1 }); oldContextStep(f); admissionOnly(f);
  const retry = f.payload({ path: CONTEXT, agreementHash: sha256Hex('context scope') });
  assert.equal((await f.reserve(f.args(retry, { contextStart: true }))).state, 'new');
  admissionOnly(f); assert.equal(f.rows().length, 1);
  assert.doesNotThrow(() => f.store().reserve(f.payload(), {}, { keepProfile: FIXTURE_PROFILE }));
});

test('an admission-only job already holds its job slot: its proposal is admitted at full capacity and another job is refused', async t => {
  const f = await accountingFixture(t, { maxJobs: 1 }); oldContextStep(f);
  await assert.rejects(f.reserve(f.args(f.payload({ jobId: JOB2 }))), refused('peer_job_capacity', 503));
  assert.equal((await f.reserve(f.args(f.payload()))).state, 'new');
  await assert.rejects(f.reserve(f.args(f.payload({ jobId: JOB2 }))), refused('peer_job_capacity', 503));
  f.reopen(); assert.equal(f.rows().length, 1); assert.equal(f.jobRows().length, 1); assert.equal(f.tuples(), 1);
});

test('accounting still refuses a proposal whose tuple differs after the old context admission and a first proposal', async t => {
  const f = await accountingFixture(t); oldContextStep(f);
  await f.reserve(f.args(f.payload()));
  const other = { ...FIXTURE_PROFILE, revision: 'other-revision' };
  await assert.rejects(f.reserve(f.args(f.payload(), { keepProfile: other })), refused('tp1_purchase_profile_mismatch', 500));
  assert.equal(f.rows().length, 1); assert.equal(f.tuples(), 1);
});

test('accounting refuses a context-start flag that disagrees with the route before any row', async t => {
  const f = await accountingFixture(t);
  await assert.rejects(f.reserve(f.args(f.payload({ path: CONTEXT }))), refused('wire_input_invalid', 500));
  await assert.rejects(f.reserve(f.args(f.payload(), { contextStart: true })), refused('wire_input_invalid', 500));
  f.reopen(); f.assertEmpty();
});

test('accounting keeps a fresh job row and its tuple together, with the identity the old reserve path compares', async t => {
  const f = await accountingFixture(t);
  const payload = f.payload();
  await f.reserve(f.args(payload, { newJob: true }));
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

test('accounting leaves no job row when the tuple write after it fails', async t => {
  const f = await accountingFixture(t);
  f.db.exec("CREATE TRIGGER no_tuple BEFORE INSERT ON kit_purchase_profiles BEGIN SELECT RAISE(ABORT, 'TEST tuple write failed'); END");
  await assert.rejects(f.reserve(f.args(undefined, { newJob: true })), /TEST tuple write failed/);
  f.reopen(); f.assertEmpty();
});

test('accounting leaves no tuple or reservation when the job row write fails', async t => {
  const f = await accountingFixture(t);
  f.db.exec("CREATE TRIGGER no_job BEFORE INSERT ON peer_jobs BEGIN SELECT RAISE(ABORT, 'TEST job write failed'); END");
  await assert.rejects(f.reserve(f.args(undefined, { newJob: true })), /TEST job write failed/);
  f.reopen(); f.assertEmpty();
});

test('accounting refuses a newJob that disagrees with the store before any row', async t => {
  const f = await accountingFixture(t);
  await assert.rejects(f.reserve(f.args(undefined, { newJob: false })), refused('wire_input_invalid', 500));
  f.reopen(); f.assertEmpty();
  await f.reserve(f.args(undefined, { newJob: true }));
  await assert.rejects(f.reserve(f.args(undefined, { newJob: true })), refused('wire_input_invalid', 500));
  assert.equal(f.rows().length, 1); assert.equal(f.tuples(), 1);
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
    const input = f.args(undefined, { newJob: true, checkCapacityWithin: check.hook });
    await assert.rejects(f.reserve(input), typeof check.code === 'string' ? refused(check.code) : check.code);
    f.reopen(); f.assertEmpty();
  }
  const f = await accountingFixture(t, { maxJobs: 1, maxNoncesPerBuyerPerWindow: 1 });
  await f.reserve(f.args()); assert.equal(f.tuples(), 1);
  await assert.rejects(f.reserve(f.args(f.payload({ jobId: JOB2 }))), refused('peer_buyer_nonce_limit'));
  f.reopen(); assert.equal(f.tuples(), 1);
  f.setTime(T0 + 60000);
  await assert.rejects(f.reserve(f.args(f.payload({ jobId: JOB2 }), { newJob: true })), refused('peer_job_capacity'));
  f.reopen(); assert.equal(f.tuples(), 1);
  const changed = { ...FIXTURE_PROFILE, pinVersion: 'TEST-other-pin' };
  await assert.rejects(f.reserve(f.args(undefined, { keepProfile: changed })), refused('tp1_purchase_profile_mismatch'));
  assert.equal(f.tuples(), 1); assert.equal(f.rows().length, 1);
  const context = await accountingFixture(t, { maxContextRecords: 1, contextRecords: () => 1 });
  await assert.rejects(context.reserve(context.args(context.payload({ path: CONTEXT }), { contextStart: true })), refused('peer_context_capacity'));
  context.reopen(); context.assertEmpty();
});

test('accounting-payment-tuple-commit-cuts', async t => {
  for (const table of ['kit_payment_transactions', 'kit_reservations', 'kit_purchase_profiles']) {
    const f = await accountingFixture(t);
    f.db.exec(`CREATE TRIGGER cut_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'TEST insert cut'); END`);
    await assert.rejects(f.reserve(f.args(undefined, { paymentTx: sha256Hex('payment commit cut') })), /TEST insert cut/);
    f.reopen(); f.assertEmpty(); assert.equal(claimCount(f), 0);
  }
  // Deferred FK violation reaches COMMIT after all step-6 statements succeeded.
  const f = await accountingFixture(t);
  f.db.exec('CREATE TABLE commit_guard (job TEXT REFERENCES kit_purchase_profiles(job) DEFERRABLE INITIALLY DEFERRED)');
  await assert.rejects(f.reserve(f.args(undefined, { paymentTx: sha256Hex('commit failure'), checkCapacityWithin: ({ run }) => {
    run('INSERT INTO commit_guard VALUES (?)', 'TEST-missing-job'); return { class: 'general', allocationId: null };
  } })), /FOREIGN KEY constraint failed/);
  f.reopen(); f.assertEmpty(); assert.equal(claimCount(f), 0);
});

test('accounting-unpublished-row-repeat', async t => {
  const f = await accountingFixture(t); const input = f.args(undefined, { checked: { reserve: crash } });
  await assert.rejects(f.reserve(input), error => error === cause); f.reopen();
  let calls = 0; input.checked.reserve = async () => { calls++; return { state: 'new' }; };
  await assert.rejects(f.reserve(input), refused('peer_request_replayed', 409));
  assert.equal(calls, 0); assert.equal(f.rows().length, 1); assert.equal(f.files().length, 0); assert.equal(f.rows()[0].state, 'reserving');
});

test('accounting-nonce-only-publication-cut', async t => {
  const f = await accountingFixture(t); const input = await f.admit(); casFailure(f);
  // SQLite commit has happened; journal's own clock throws after publishing the nonce.
  const original = input.checked.reserve;
  input.checked.reserve = async () => { f.setTime(NaN); return original(); };
  await assert.rejects(f.reserve(input), /seller_configuration_invalid/);
  f.setTime(T0); f.reopen();
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0].state, 'reserving');
  assert.equal(f.nonces().length, 1); assert.equal(f.files().length, 1);
  assert.equal(inspectWireOperation(f.journal, input.payload).state, 'none');
  assert.equal(JSON.parse(readFileSync(join(f.journalDir, f.nonces()[0]), 'utf8')).requestHash, wireRequestHash(input.payload));
});

test('accounting-refusal-before-result-cas', async t => {
  const f = await accountingFixture(t); casFailure(f);
  const expired = new SellerTransportError('peer_expired', 408);
  const input = f.args(undefined, { checked: { reserve: async () => { throw expired; } } });
  await assert.rejects(f.reserve(input), error => error === expired && /TEST result write failed/.test(String(error.cause)));
  f.reopen(); assert.equal(f.rows()[0].state, 'reserving'); assert.equal(f.rows().length, 1); assert.equal(f.files().length, 0);
  dropCasFailure(f);
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
  assert.throws(() => createReservationAccounting({ store: {}, now: () => T0, limits: {}, contextRecords: () => 0 }), TypeError);
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
