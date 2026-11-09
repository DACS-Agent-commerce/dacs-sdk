import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { createContextAdmissionTransaction } from '../../src/dacs/seller-admission-transaction.mjs';
import { SELLER_PROFILE } from '../../src/dacs/session-admission.mjs';
import { sellerStoreInternals, SellerTransportError } from '../../src/dacs/seller-transport-auth.mjs';
import { T0, JOB, JOB2, OTHER, CONTEXT } from './reservation-accounting-fixture.mjs';
import { FIXTURE_PROFILE } from './wire-authority-fixture.mjs';

export function holdReleaseProbes({ accountingFixture, completeWireEffect }) {
const HOUR = 3600000;
const capacity = { code: 'peer_job_capacity', status: 503 };
const outcome = { status: 200, text: '{"status":"done"}' };
const internals = f => sellerStoreInternals(f.store());
const retire = (f, jobId) => internals(f).transaction(() => internals(f).retireSlotsWithin(f.now(), jobId));
const retired = f => f.db.prepare('SELECT * FROM kit_slot_retirements ORDER BY job').all();
const proof = f => ({ holds: f.holds(), rows: f.rows(), jobs: f.jobRows(), retired: retired(f), files: f.files() });
const next = async f => f.reserve(await f.admit(f.payload({ jobId: JOB2 })));
const fixture = async (t, options = {}) => {
  const session = { state: null };
  const f = await accountingFixture(t, { maxJobs: 1, maxContextRecords: 1, ...options,
    contextSessionState: ({ jobId }) => jobId === JOB ? session.state : null });
  return [f, session];
};
const completed = async (f, context = false) => {
  const input = context ? await f.admitContext() : await f.admit();
  const effect = await f.reserve(input);
  completeWireEffect(f.journal, effect, outcome);
  return input;
};

function contextStart(f, jobId) {
  const { buyer, seller, listingPin } = f.payload({ jobId });
  const challengeScopeHash = sha256Hex('challenge scope');
  const { sessionNonce: nonce } = f.store().challenges.issue({ jobId, buyer }, challengeScopeHash);
  const bundle = { presentedBy: buyer, sessionNonce: nonce, presentation: { proof: 'TEST-fixture' } };
  const presentationHash = sha256Hex(canonicalize(bundle)), buyerBundleHash = identityBundleHash(bundle);
  const { owner } = f.store().challenges.attempt({ nonce, jobId, buyer, challengeScopeHash, presentationHash, path: 'context' });
  return { jobId, buyer, seller, listingPin, nonce, presentationHash, owner, contextScopeHash: sha256Hex('context scope'),
    sellerBundlePresentedBy: seller, delegationExpiresAt: null, purchaseProfile: FIXTURE_PROFILE,
    accepted: { buyerBundleText: canonicalize(bundle), buyerBundleHash,
      admission: { disposition: 'admitted', jobId, buyer, buyerBundleHash, listingPin,
        participants: [{ role: 'buyer', claim: buyer, ...SELLER_PROFILE }, { role: 'seller', claim: seller, ...SELLER_PROFILE }] },
      firstAdmission: { challengeExpiresAt: f.now() + 600000, generatedAt: f.now(), checkedAt: f.now() } } };
}
function contextTransaction(f, calls) {
  return createContextAdmissionTransaction({ store: f.store(), now: f.now, ready: () => true, deadlines: { policyMs: 10000 },
    policy: { reserve: async () => { calls.reserve++; return null; }, release: async () => { calls.release++; } },
    effectEvidence: async () => [], inspectContextOutcome: () => ({ state: 'none' }), completeWire: () => {} });
}

for (const limit of ['context records', 'jobs']) test(`hold-release refuses a retired context start and preserves the limit on ${limit}`, async t => {
  const [f, session] = await fixture(t, { maxJobs: 2 });
  await completed(f);
  session.state = 'finalised'; f.setTime(T0 + 2 * HOUR); retire(f, JOB);
  assert.equal(retired(f)[0]?.job_retired, 1);
  session.state = null; f.reopen();
  const calls = { reserve: 0, release: 0 }, admission = contextTransaction(f, calls);
  const before = proof(f);
  const error = await admission.begin(contextStart(f, JOB)).then(() => null, cause => cause);
  const refused = proof(f);
  await admission.begin(contextStart(f, JOB2));
  const admissions = f.db.prepare("SELECT jobId FROM kit_context_admissions WHERE state <> 'aborted'").all();
  const job3 = '01M5YKPJG068H248H248H248H3', job4 = '01M5YKPJG088H248H248H248H4';
  if (limit === 'context records') {
    assert.equal(admissions.length, 1);
    assert.equal(internals(f).admissionCounts().contextRecords, 1);
    assert.throws(() => contextStart(f, job3), { code: 'peer_context_capacity', status: 503 });
  } else {
    assert.equal((await f.reserve(await f.admit(f.payload({ jobId: job3 })))).state, 'new');
    const liveJobs = new Set([...admissions.map(row => row.jobId), ...f.holds().filter(row => row.jobId !== JOB).map(row => row.jobId)]);
    assert.equal(liveJobs.size, 2);
    await assert.rejects(f.reserve(await f.admit(f.payload({ jobId: job4 }))), capacity);
  }
  assert.equal(error?.code, 'context_session_terminal'); assert.equal(error.status, 409);
  assert.deepEqual(refused, before); assert.deepEqual(calls, { reserve: 1, release: 0 });
});

test('hold-release admits a context start on a non-retired accounted job', async t => {
  const [f] = await fixture(t, { maxJobs: 2 });
  await completed(f);
  const calls = { reserve: 0, release: 0 }, admission = contextTransaction(f, calls);
  assert.equal((await admission.begin(contextStart(f, JOB))).jobId, JOB);
  assert.equal(admission.admissionRecord(JOB).state, 'admitted');
  assert.equal(internals(f).admissionCounts().contextRecords, 1);
  assert.equal(retired(f).length, 0); assert.deepEqual(calls, { reserve: 1, release: 0 });
});

for (const [name, elapsed, state, nonceWindowMs] of [
  ['nonce window', HOUR + 1, 'finalised', 2 * HOUR],
  ['context-start window', 60001, 'finalised', 60000],
  ['nonterminal session', 2 * HOUR + 1, 'committed', 60000],
  ['unknown session', 2 * HOUR + 1, null, 60000],
]) test(`hold-release probe keeps rows during ${name}, then admits the next job`, async t => {
  const [f, session] = await fixture(t, { nonceWindowMs });
  await completed(f, true); await completed(f);
  f.setTime(T0 + elapsed); session.state = state;
  const before = proof(f);
  await assert.rejects(next(f), capacity); assert.deepEqual(proof(f), before);
  session.state = 'finalised'; f.setTime(T0 + 2 * HOUR + 1);
  assert.equal((await next(f)).state, 'new');
  assert.deepEqual(f.holds().find(row => row.jobId === JOB), before.holds[0]);
  assert.deepEqual(f.rows().filter(row => row.jobId === JOB), before.rows);
  assert.equal(retired(f)[0].job_retired, 1); assert.equal(retired(f)[0].context_retired, 1);
  assert.equal(internals(f).admissionCounts().contextRecords, 0);
});

test('hold-release uncertain charge survives restart and keeps capacity', async t => {
  for (const published of ['absent', 'pending', 'completed']) {
    const [f, session] = await fixture(t);
    const input = await f.admit(), reserve = input.checked.reserve;
    input.checked = { ...input.checked, reserve: async () => {
      if (published !== 'absent') {
        const effect = await reserve();
        if (published === 'completed') completeWireEffect(f.journal, effect, outcome);
      }
      throw new Error('crash after charge');
    } };
    await assert.rejects(f.reserve(input), /crash after charge/);
    session.state = 'finalised'; f.setTime(T0 + 2 * HOUR);
    const before = proof(f);
    retire(f); assert.deepEqual(proof(f), before); f.reopen();
    retire(f); await assert.rejects(next(f), capacity);
    assert.deepEqual(proof(f), before); assert.equal(f.rows()[0].state, 'reserving');
  }
});

test('hold-release committed retirement survives unknown-session restart', async t => {
  const [f, session] = await fixture(t);
  await completed(f, true); await completed(f);
  session.state = 'finalised'; f.setTime(T0 + HOUR + 1); retire(f, JOB);
  assert.equal(retired(f)[0]?.job_retired, 1);
  const rows = f.rows(), holds = f.holds(), retirement = retired(f);
  session.state = null; f.reopen(); retire(f);
  assert.deepEqual(retired(f), retirement); assert.deepEqual(f.rows(), rows); assert.deepEqual(f.holds(), holds);
  assert.equal(internals(f).admissionCounts().contextRecords, 0);
  assert.equal((await next(f)).state, 'new');
});

test('hold-release retirement rollback survives restart and retries', async t => {
  for (const cut of ['insert', 'after-write']) {
    const [f, session] = await fixture(t);
    await completed(f, true); await completed(f);
    session.state = 'finalised'; f.setTime(T0 + HOUR + 1);
    const before = proof(f);
    if (cut === 'insert') f.db.exec("CREATE TRIGGER hold_release_cut BEFORE INSERT ON kit_slot_retirements BEGIN SELECT RAISE(ABORT, 'retirement-cut'); END");
    assert.throws(() => internals(f).transaction(() => {
      internals(f).retireSlotsWithin(f.now(), JOB);
      assert.equal(internals(f).db.prepare('SELECT job_retired FROM kit_slot_retirements WHERE job = ?').get(JOB)?.job_retired, 1);
      if (cut === 'after-write') throw new Error('retirement-cut');
    }), /retirement-cut/);
    assert.deepEqual(proof(f), before); f.reopen();
    assert.equal(internals(f).admissionCounts().contextRecords, 1);
    if (cut === 'insert') {
      await assert.rejects(next(f), /retirement-cut/);
      f.db.exec('DROP TRIGGER hold_release_cut');
    }
    retire(f, JOB); assert.equal((await next(f)).state, 'new');
  }
});

test('hold-release preserves used, buyer-window units and every reservation row', async t => {
  const [f, session] = await fixture(t);
  f.db.exec('CREATE TABLE test_budget (used INTEGER NOT NULL); INSERT INTO test_budget VALUES (0)');
  const input = await f.admitContext();
  input.checkCapacityWithin = ({ run }) => {
    run('UPDATE test_budget SET used = used + 1'); return { class: 'general', allocationId: null };
  };
  completeWireEffect(f.journal, await f.reserve(input), outcome);
  session.state = 'finalised'; f.setTime(T0 + HOUR + 1);
  const units = () => f.db.prepare('SELECT COUNT(*) AS n FROM kit_reservations WHERE buyer = ? AND at > ?').get(input.payload.buyer, T0 - 60000).n;
  const rows = f.rows(), holds = f.holds(), count = units();
  retire(f);
  assert.equal(retired(f)[0]?.job_retired, 1);
  assert.equal(f.db.prepare('SELECT used FROM test_budget').get().used, 1);
  assert.equal(units(), count); assert.deepEqual(f.rows(), rows); assert.deepEqual(f.holds(), holds);
});

test('hold-release keeps the owner on both reserve paths and replays the stored result', async t => {
  const [f, session] = await fixture(t);
  await completed(f);
  session.state = 'finalised'; f.setTime(T0 + HOUR + 1); retire(f);
  assert.equal(retired(f)[0]?.job_retired, 1);
  const before = proof(f), foreign = f.payload({ buyer: OTHER.claim });
  await assert.rejects(f.reserve(f.args(foreign)), { code: 'peer_job_conflict', status: 409 });
  assert.throws(() => f.store().reserve(foreign, {}, { keepProfile: FIXTURE_PROFILE }), { code: 'peer_job_conflict', status: 409 });
  assert.deepEqual(proof(f), before);
  assert.equal((await next(f)).state, 'new');
  const rows = f.rows(), holds = f.holds(), jobs = f.jobRows();
  const result = await f.reserve(await f.admit());
  assert.equal(result.state, 'completed'); assert.deepEqual(result.outcome, outcome);
  assert.deepEqual(f.rows().slice(0, -1), rows); assert.equal(f.rows().at(-1).state, 'completed');
  assert.deepEqual(f.holds(), holds); assert.deepEqual(f.jobRows(), jobs);
});

test('hold-release retired jobs reject fresh work after restart with unknown session state', async t => {
  const [f, session] = await fixture(t);
  await completed(f); session.state = 'finalised'; f.setTime(T0 + HOUR + 1); retire(f);
  assert.equal(retired(f)[0]?.job_retired, 1);
  session.state = null; f.reopen(); const before = proof(f);
  await assert.rejects(f.reserve(await f.admitContext()), { code: 'context_session_terminal', status: 409 });
  assert.deepEqual(proof(f), before);
});

test('hold-release old reserve reclaims a completed accounted hold', async t => {
  const [f, session] = await fixture(t);
  await completed(f); session.state = 'finalised'; f.setTime(T0 + HOUR + 1);
  const rows = f.rows(), holds = f.holds();
  assert.equal(f.store().reserve(f.payload({ jobId: JOB2 }), {}, { keepProfile: FIXTURE_PROFILE }).disposition, 'perform');
  assert.equal(retired(f)[0]?.job_retired, 1); assert.deepEqual(f.rows(), rows); assert.deepEqual(f.holds(), holds);
});

test('hold-release a stored completed operation proves completion without a current wire view', async t => {
  const [f, session] = await fixture(t, { wireOperationView: () => null });
  await completed(f);
  assert.equal((await f.reserve(await f.admit())).state, 'completed');
  assert.equal(f.rows()[1].state, 'completed');
  session.state = 'finalised'; f.setTime(T0 + HOUR + 1);
  assert.equal((await next(f)).state, 'new'); assert.equal(retired(f)[0]?.job_retired, 1);
  const rows = f.rows();
  assert.equal((await f.reserve(await f.admit())).state, 'completed');
  await assert.rejects(f.reserve(await f.admit(f.payload({ agreementHash: sha256Hex('another agreement') }))), { code: 'peer_operation_mismatch', status: 409 });
  assert.deepEqual(f.rows().slice(0, -2), rows);
  assert.deepEqual(f.rows().slice(-2).map(row => row.state), ['completed', 'refused']);
});

for (const state of ['pending', 'unknown', 'reader-throws', 'no-effect', 'absent', 'refused']) test(`hold-release checks every operation: ${state}`, async t => {
  const [f, session] = await fixture(t, state === 'unknown' ? { wireOperationView: () => null } : state === 'reader-throws' ? { wireOperationView: () => { throw new Error('unavailable'); } } : {});
  await completed(f);
  if (state === 'absent') {
    await f.reserve(f.args(f.payload({ path: CONTEXT })));
  } else if (state === 'refused') {
    await assert.rejects(f.reserve(f.args(f.payload({ path: CONTEXT }), { checked: { reserve: async () => { throw new SellerTransportError('context_refused', 409); } } })), { code: 'context_refused' });
  } else {
    const input = await f.admitContext(), effect = await f.reserve(input);
    if (state === 'no-effect') completeWireEffect(f.journal, effect, null);
  }
  session.state = 'finalised'; f.setTime(T0 + HOUR + 1);
  const before = proof(f);
  if (['pending', 'unknown', 'reader-throws', 'absent'].includes(state)) {
    retire(f); await assert.rejects(next(f), capacity); assert.deepEqual(proof(f), before);
  } else {
    assert.equal((await next(f)).state, 'new'); assert.equal(retired(f)[0].job_retired, 1);
  }
});

test('hold-release refused work stays closed on the old path after an unknown-session restart', async t => {
  const [f, session] = await fixture(t);
  await assert.rejects(f.reserve(f.args(f.payload(), { checked: { reserve: async () => {
    throw new SellerTransportError('proposal_refused', 409);
  } } })), { code: 'proposal_refused' });
  session.state = 'finalised'; f.setTime(T0 + HOUR + 1); retire(f);
  assert.equal(retired(f)[0]?.job_retired, 1);
  session.state = null; f.reopen(); const before = proof(f);
  assert.throws(() => f.store().reserve(f.payload(), {}, { keepProfile: FIXTURE_PROFILE }), { code: 'context_session_terminal', status: 409 });
  assert.deepEqual(proof(f), before);
});

test('hold-release a retired context job cannot create an uncounted accounted hold', async t => {
  const [f, session] = await fixture(t);
  const p = f.payload({ path: CONTEXT });
  const record = { jobId: JOB, buyer: p.buyer, seller: p.seller, listingPin: p.listingPin, state: 'settled', admittedAt: T0, rev: 1 };
  f.db.prepare('INSERT INTO kit_context_admissions VALUES (?, ?, ?, ?, ?, ?)').run(JOB, p.buyer, T0, 'settled', 1, JSON.stringify(record));
  session.state = 'finalised'; f.setTime(T0 + 2 * HOUR); retire(f);
  assert.equal(retired(f)[0]?.job_retired, 1); assert.equal(f.holds().length, 0);
  session.state = null; f.reopen(); const before = proof(f);
  await assert.rejects(f.reserve(await f.admit()), { code: 'context_session_terminal', status: 409 });
  assert.deepEqual(proof(f), before);
  assert.equal((await next(f)).state, 'new');
  await assert.rejects(f.reserve(await f.admit(f.payload({ jobId: '01ARZ3NDEKTSV4RRFFQ69G5FAW' }))), capacity);
});

test('hold-release a published context operation with no wire record keeps context capacity', async t => {
  const [f, session] = await fixture(t, { maxJobs: 2 });
  await f.reserve(f.args(f.payload({ path: CONTEXT })));
  await assert.rejects(f.reserve(f.args(f.payload({ path: CONTEXT }), { checked: { reserve: async () => {
    throw new SellerTransportError('context_refused', 409);
  } } })), { code: 'context_refused' });
  session.state = 'finalised'; f.setTime(T0 + 2 * HOUR);
  const before = proof(f); retire(f);
  assert.equal(internals(f).admissionCounts().contextRecords, 1);
  await assert.rejects(f.reserve(await f.admitContext(f.payload({ jobId: JOB2, path: CONTEXT }))), { code: 'peer_context_capacity', status: 503 });
  assert.deepEqual(proof(f), before);
});

test('hold-release completed replays still consume the buyer nonce window', async t => {
  const [f, session] = await fixture(t, { maxNoncesPerBuyerPerWindow: 3 });
  await completed(f);
  session.state = 'finalised'; f.setTime(T0 + HOUR + 1); retire(f);
  let accepted = 0, refused = 0;
  for (let i = 0; i < 20; i++) {
    const input = await f.admit();
    input.checkCapacityWithin = () => { assert.fail('a replay must not spend capacity'); };
    if (i < 3) {
      assert.equal((await f.reserve(input)).state, 'completed'); accepted++;
      if (i === 0) {
        const rows = f.rows();
        await assert.rejects(f.reserve(input), { code: 'peer_request_replayed', status: 409 });
        assert.deepEqual(f.rows(), rows);
      }
    }
    else { await assert.rejects(f.reserve(input), { code: 'peer_buyer_nonce_limit', status: 429 }); refused++; }
  }
  assert.equal(accepted, 3); assert.equal(refused, 17);
  assert.equal(f.rows().length, 4); assert.equal(f.holds().length, 1); assert.equal(f.jobRows().length, 0);
  f.reopen(); await assert.rejects(f.reserve(await f.admit()), { code: 'peer_buyer_nonce_limit', status: 429 });
});

for (const state of ['new', 'recover']) test(`hold-release a retired replay refuses an unexpected wire ${state} result`, async t => {
  const [f, session] = await fixture(t, { wireOperationView: () => null });
  await completed(f); assert.equal((await f.reserve(await f.admit())).state, 'completed');
  session.state = 'finalised'; f.setTime(T0 + HOUR + 1); retire(f);
  const input = f.args(f.payload(), { checked: { reserve: async () => ({ state }) } });
  input.checkCapacityWithin = () => { assert.fail('a replay must not spend capacity'); };
  await assert.rejects(f.reserve(input), { code: 'wire_input_invalid', status: 500 });
  assert.equal(f.rows().at(-1).state, 'reserving');
});
}
