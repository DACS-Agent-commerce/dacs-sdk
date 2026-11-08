import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@kynesyslabs/dacs';
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
  assert.deepEqual(f.rows(), rows); assert.deepEqual(f.holds(), holds); assert.deepEqual(f.jobRows(), jobs);
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
  assert.deepEqual(f.rows(), rows);
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
  if (['pending', 'unknown', 'reader-throws'].includes(state)) {
    retire(f); await assert.rejects(next(f), capacity); assert.deepEqual(proof(f), before);
  } else {
    assert.equal((await next(f)).state, 'new'); assert.equal(retired(f)[0].job_retired, 1);
  }
});
}
