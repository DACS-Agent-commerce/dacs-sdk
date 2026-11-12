import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS, inspectWireOperation } from '@kynesyslabs/dacs/wire';
import { createPurchaseCapacity } from '../src/dacs/seller-purchase-capacity.mjs';
import { createReservationCoordinator } from '../src/dacs/seller-reservation-accounting.mjs';
import { createOrdinaryCompletionPort, endWireAttempt } from '../src/dacs/seller-http.mjs';
import { sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
import { BUYER, JOB, JOB2, PIN, SELLER, T0, accountingFixture, nonceKey } from './helpers/reservation-accounting-fixture.mjs';

// The ordinary completion port runs on the real reservation coordinator, purchase capacity, SQL store and wire journal: no route
// calls it here, so each test issues a request through the coordinator, captures its receipt and ends it directly.
const ANSWER = Object.freeze({ status: 200, text: '{"answer":"first"}' });
const SLOT_UNITS = 17;
const ROUTE_END = Object.freeze({ kind: 'outcome', outcome: ANSWER, cleanup: 'route' });
const FINAL_END = Object.freeze({ kind: 'outcome', outcome: ANSWER, cleanup: 'purchase-final' });
const NO_EFFECT_END = Object.freeze({ kind: 'no-effect' });
const OPEN_END = Object.freeze({ kind: 'open' });
const refusal = (code, status) => error => error.code === code && error.status === status;

async function completionWorld(t, { commitOnSignature = false } = {}) {
  const f = await accountingFixture(t, { leaveCapacityToTest: true });
  const store = f.store(), internals = sellerStoreInternals(store);
  const capacity = createPurchaseCapacity({ store, now: f.now, maxRecords: 1000, commitOnSignature, sessionState: internals.sessionState });
  const coordinator = createReservationCoordinator({ accounting: store.reservationAccounting, capacity,
    inspectOperation: target => inspectWireOperation(f.journal, target) });
  const port = createOrdinaryCompletionPort({ journal: f.journal, store, capacity });
  const w = { f, store, internals, capacity, port };
  internals.transaction(() => capacity.allocateWithin({ jobId: JOB, buyer: BUYER.claim, seller: SELLER.claim, listingPin: PIN }));
  w.allocation =(jobId = JOB) => capacity.capacityReport().allocations.find(allocation => allocation.jobId === jobId);
  // Any route but the proposal refuses a job the host has not seen, so a job is first made known by its proposal.
  w.issue = async (path = PATHS.proposals, { retainedWork = true, jobId = JOB } = {}) => {
    if (path !== PATHS.proposals && !f.jobRows().some(row => row.job === jobId)) await w.issue(PATHS.proposals, { retainedWork, jobId });
    const input = { ...(await f.admit(f.payload({ path, jobId }))), contextStart: false, paymentTx: null, retainedWork };
    return { effect: await coordinator.reserveCoordinated(input), key: nonceKey(input.payload), path, jobId };
  };
  w.capture = async (...args) => { const issued = await w.issue(...args); return { ...issued, reservation: port.capture(issued) }; };
  w.view = (path = PATHS.proposals, jobId = JOB) => inspectWireOperation(f.journal, { seller: SELLER.claim, jobId, path });
  w.figures = () => { const { used, allotted, free } = capacity.capacityReport(); return { used, allotted, free }; };
  w.records = () => f.db.prepare('SELECT * FROM kit_ordinary_completions ORDER BY rowid').all().map(row => ({ ...row }));
  w.release = jobId => internals.transaction(() => { const held = capacity.allocationWithin(jobId); return capacity.releaseAllWithin({ allocationId: held.allocationId, allocationRev: held.rev }); });
  // Everything an end can change: the journal's files, the capacity figures, the allocation and the completion records.
  w.state = (jobId = JOB) => ({ files: f.files(), figures: w.figures(), allocation: w.allocation(jobId), records: w.records() });
  return w;
}

test('capture reads the persisted purchase-stage class and the general class from the committed row', async t => {
  const w = await completionWorld(t), allocation = w.allocation();
  const staged = await w.capture(PATHS.proposals);
  assert.deepEqual(staged.reservation.capacityClass, { class: 'purchase-stage', allocationId: allocation.allocationId, route: PATHS.proposals });
  assert.equal(staged.reservation.effect, staged.effect);
  assert.ok(Object.isFrozen(staged.reservation) && Object.isFrozen(staged.reservation.capacityClass));
  const general = await w.capture(PATHS.proposals, { jobId: JOB2 });
  assert.deepEqual(general.reservation.capacityClass, { class: 'general' });
  w.f.setTime(T0 + 300000);
  const recovered = await w.capture(PATHS.proposals);
  assert.equal(recovered.effect.state, 'recover');
  assert.equal(recovered.reservation.capacityClass.class, 'purchase-stage');
});

test('capture refuses an effect its accounting row does not match', async t => {
  const w = await completionWorld(t), first = await w.issue(PATHS.proposals), other = await w.issue(PATHS.proposals, { jobId: JOB2 });
  const before = w.state();
  assert.throws(() => w.port.capture({ effect: first.effect, key: sha256Hex('no such request') }), refusal('wire_input_invalid', 500));
  assert.throws(() => w.port.capture({ effect: first.effect, key: other.key }), refusal('wire_input_invalid', 500));
  assert.throws(() => w.port.capture({ effect: { ...first.effect, state: 'recover' }, key: first.key }), refusal('wire_input_invalid', 500));
  for (const input of [null, {}, { effect: first.effect }, { effect: first.effect, key: 7 }, { effect: { state: 'new' }, key: first.key }]) {
    assert.throws(() => w.port.capture(input), TypeError);
  }
  assert.deepEqual(w.state(), before);
});

test('capture gives a completed answer no receipt', async t => {
  const w = await completionWorld(t), first = await w.capture();
  endWireAttempt(w.port, first.reservation, ROUTE_END);
  const replay = await w.issue();
  assert.equal(replay.effect.state, 'completed');
  assert.throws(() => w.port.capture(replay), TypeError);
});

test('a forged, copied or foreign receipt fails with TypeError before any journal or SQL work', async t => {
  const w = await completionWorld(t), { reservation } = await w.capture();
  const foreignPort = createOrdinaryCompletionPort({ journal: w.f.journal, store: w.store, capacity: w.capacity });
  const before = w.state();
  const forged = [{ ...reservation }, { effect: reservation.effect, capacityClass: { class: 'general' } }, Object.freeze({ ...reservation }), null, 'receipt'];
  for (const bad of forged) assert.throws(() => endWireAttempt(w.port, bad, ROUTE_END), TypeError);
  assert.throws(() => endWireAttempt(foreignPort, reservation, ROUTE_END), TypeError);
  assert.throws(() => endWireAttempt({ capture: () => reservation }, reservation, ROUTE_END), TypeError);
  assert.deepEqual(w.state(), before);
  assert.equal(w.view().state, 'pending');
});

test('an invalid end decision fails with TypeError before any journal or SQL work', async t => {
  const w = await completionWorld(t), { reservation } = await w.capture();
  const before = w.state();
  const invalid = [null, 'outcome', {}, { kind: 'finished' }, { kind: 'outcome', outcome: ANSWER }, { kind: 'outcome', outcome: ANSWER, cleanup: 'both' },
    { kind: 'outcome', cleanup: 'route' }];
  for (const decision of invalid) assert.throws(() => endWireAttempt(w.port, reservation, decision), TypeError);
  assert.deepEqual(w.state(), before);
  assert.equal(w.view().state, 'pending');
});

test('an open decision completes nothing and returns no slot', async t => {
  const w = await completionWorld(t), { reservation } = await w.capture();
  const before = w.state();
  endWireAttempt(w.port, reservation, OPEN_END);
  assert.deepEqual(w.state(), before);
  assert.equal(w.view().state, 'pending');
});

test('a no-effect end publishes a null end and returns no slot', async t => {
  const w = await completionWorld(t), { reservation } = await w.capture();
  const before = w.state();
  endWireAttempt(w.port, reservation, NO_EFFECT_END);
  assert.equal(w.view().state, 'ended');
  assert.equal(w.view().superseded, 0);
  const after = w.state();
  assert.equal(after.files.length, before.files.length + 1);
  assert.deepEqual({ ...after, files: null }, { ...before, files: null });
});

test('the completion record names the operation, attempt, request hash, route, status and cleanup', async t => {
  const w = await completionWorld(t), { reservation, key, effect } = await w.capture();
  endWireAttempt(w.port, reservation, ROUTE_END);
  const { requestHash } = w.f.db.prepare('SELECT requestHash FROM kit_reservations WHERE key = ?').get(key);
  assert.deepEqual(w.records(), [{ operationId: effect.operationId, attempt: effect.attempt, requestHash, route: PATHS.proposals, status: 200, cleanup: 'route' }]);
});

test('NEW-C1-route-slot-return', async t => {
  for (const commitOnSignature of [false, true]) {
    const routes = [PATHS.proposals, PATHS.commitments, ...(commitOnSignature ? [PATHS.commitmentSignature] : [])];
    for (const route of routes) {
      await t.test(`a new ${route} completion returns exactly its own slot, commit-on-signature ${commitOnSignature}`, async () => {
        const w = await completionWorld(t, { commitOnSignature }), { reservation } = await w.capture(route);
        const before = w.state();
        endWireAttempt(w.port, reservation, ROUTE_END);
        const after = w.state();
        assert.equal(w.view(route).state, 'completed');
        assert.equal(after.figures.used, before.figures.used, 'used never decreases');
        assert.equal(after.figures.allotted, before.figures.allotted - (SLOT_UNITS - 1));
        assert.equal(after.figures.free, before.figures.free + (SLOT_UNITS - 1));
        assert.deepEqual(after.allocation.slots[route], { spent: 1, state: 'returned' });
        assert.equal(after.allocation.rev, before.allocation.rev + 1);
        for (const other of Object.keys(before.allocation.slots).filter(name => name !== route)) {
          assert.deepEqual(after.allocation.slots[other], before.allocation.slots[other], `${other} stays as it was`);
        }
        assert.equal(after.records.length, 1);
      });
    }
  }

  await t.test('a recover completion returns its own slot, with both of its spent units kept', async () => {
    const w = await completionWorld(t), lapsed = await w.issue();
    w.f.setTime(T0 + 300000);
    const { reservation, effect } = await w.capture();
    assert.equal(effect.state, 'recover');
    const before = w.state();
    endWireAttempt(w.port, reservation, ROUTE_END);
    assert.equal(w.state().figures.allotted, before.figures.allotted - (SLOT_UNITS - 2));
    assert.deepEqual(w.allocation().slots[lapsed.path], { spent: 2, state: 'returned' });
  });

  await t.test('a general receipt has no purchased slot to return', async () => {
    const w = await completionWorld(t), { reservation } = await w.capture(PATHS.proposals, { retainedWork: false });
    const before = w.state();
    endWireAttempt(w.port, reservation, ROUTE_END);
    assert.deepEqual({ ...w.state(), records: null, files: null }, { ...before, records: null, files: null });
    assert.equal(w.records().length, 1);
  });

  await t.test('a final purchase returns its own slot, then releases the rest with the fresh revision', async () => {
    const w = await completionWorld(t), { reservation } = await w.capture();
    const before = w.state();
    endWireAttempt(w.port, reservation, FINAL_END);
    const after = w.state();
    assert.equal(after.allocation.state, 'released');
    assert.ok(Object.values(after.allocation.slots).every(slot => slot.state === 'returned'));
    assert.equal(after.allocation.rev, before.allocation.rev + 2, 'one revision for the route return, one for the release');
    assert.deepEqual(after.figures, { used: before.figures.used, allotted: 0, free: before.figures.free + before.figures.allotted });
  });

  await t.test('a final purchase on a general receipt releases its matching allocation', async () => {
    const w = await completionWorld(t), { reservation } = await w.capture(PATHS.proposals, { retainedWork: false });
    const before = w.state();
    endWireAttempt(w.port, reservation, FINAL_END);
    assert.equal(w.allocation().state, 'released');
    assert.equal(w.allocation().rev, before.allocation.rev + 1);
    assert.equal(w.state().figures.used, before.figures.used);
  });

  await t.test('a repeated end returns nothing more and adds no record', async () => {
    const w = await completionWorld(t), { reservation } = await w.capture();
    endWireAttempt(w.port, reservation, ROUTE_END);
    const once = w.state();
    endWireAttempt(w.port, reservation, ROUTE_END);
    assert.deepEqual(w.state(), once);
  });

  await t.test('a completion the journal refuses as superseded returns nothing and records nothing', async () => {
    const w = await completionWorld(t), { reservation } = await w.capture();
    w.f.setTime(T0 + 300000);
    await w.issue();
    const before = w.state();
    assert.throws(() => endWireAttempt(w.port, reservation, ROUTE_END), refusal('seller_effect_superseded', 500));
    assert.deepEqual(w.state(), before);
  });

  await t.test('a different outcome after publication is refused as a conflict and returns nothing more', async () => {
    const w = await completionWorld(t), { reservation } = await w.capture();
    endWireAttempt(w.port, reservation, ROUTE_END);
    const once = w.state();
    assert.throws(() => endWireAttempt(w.port, reservation, { ...ROUTE_END, outcome: { status: 200, text: '{"answer":"second"}' } }), refusal('seller_effect_conflict', 500));
    assert.deepEqual(w.state(), once);
  });
});

test('a cleanup after the allocation was released changes nothing', async t => {
  const w = await completionWorld(t), { reservation } = await w.capture();
  w.release(JOB);
  const before = w.state();
  endWireAttempt(w.port, reservation, ROUTE_END);
  const after = w.state();
  assert.deepEqual({ ...after, records: null, files: null }, { ...before, records: null, files: null });
  assert.equal(w.view().state, 'completed');
});

test('a cleanup whose allocation does not match the receipt fails closed and changes nothing', async t => {
  const w = await completionWorld(t), { reservation } = await w.capture();
  const stored = JSON.parse(w.f.db.prepare('SELECT record FROM kit_allocations WHERE jobId = ?').get(JOB).record);
  w.f.db.prepare('UPDATE kit_allocations SET record = ? WHERE jobId = ?').run(JSON.stringify({ ...stored, buyer: SELLER.claim }), JOB);
  const before = w.state();
  assert.throws(() => endWireAttempt(w.port, reservation, ROUTE_END), refusal('wire_input_invalid', 500));
  assert.deepEqual(w.state().figures, before.figures);
  assert.equal(w.state().allocation.rev, before.allocation.rev);
  assert.deepEqual(w.records(), []);
  assert.equal(w.view().state, 'completed', 'the published outcome stands');
});

test('a failure inside the cleanup transaction leaves no completion record and no slot change', async t => {
  const w = await completionWorld(t), { reservation } = await w.capture();
  w.f.db.exec("CREATE TRIGGER TEST_cut BEFORE UPDATE ON kit_allocations BEGIN SELECT RAISE(ABORT, 'TEST cleanup cut'); END");
  const before = w.state();
  assert.throws(() => endWireAttempt(w.port, reservation, ROUTE_END), /TEST cleanup cut/);
  assert.deepEqual(w.records(), []);
  assert.deepEqual(w.state().figures, before.figures);
  assert.deepEqual(w.state().allocation, before.allocation);
});

test('a failure of the cleanup after publication keeps the outcome and a second end returns the slot once', async t => {
  const w = await completionWorld(t), { reservation } = await w.capture();
  w.f.db.exec("CREATE TRIGGER TEST_cut BEFORE UPDATE ON kit_allocations BEGIN SELECT RAISE(ABORT, 'TEST cleanup cut'); END");
  const before = w.state();
  assert.throws(() => endWireAttempt(w.port, reservation, ROUTE_END), /TEST cleanup cut/);
  assert.deepEqual(w.view(), { state: 'completed', binding: w.view().binding, outcome: ANSWER });
  w.f.db.exec('DROP TRIGGER TEST_cut');
  endWireAttempt(w.port, reservation, ROUTE_END);
  assert.equal(w.state().figures.allotted, before.figures.allotted - (SLOT_UNITS - 1));
  assert.equal(w.records().length, 1);
  const once = w.state();
  endWireAttempt(w.port, reservation, ROUTE_END);
  assert.deepEqual(w.state(), once);
});

test('a completion port needs the capacity built on its own store and a journal', async t => {
  const w = await completionWorld(t), other = await completionWorld(t);
  assert.throws(() => createOrdinaryCompletionPort({ journal: w.f.journal, store: w.store, capacity: other.capacity }), TypeError);
  assert.throws(() => createOrdinaryCompletionPort({ journal: undefined, store: w.store, capacity: w.capacity }), TypeError);
  assert.throws(() => createOrdinaryCompletionPort({ journal: w.f.journal, store: {}, capacity: w.capacity }), TypeError);
  assert.throws(() => createOrdinaryCompletionPort(), TypeError);
});
