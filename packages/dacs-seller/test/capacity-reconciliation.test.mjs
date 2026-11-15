// Startup reconciliation of the accounting store with the real wire journal: a charge cut before, inside or after its journal steps,
// a slot whose operation completed before its return, a terminal purchase, and a journal whose nonce keys do not match the rows.
// The store, the purchase capacity, the reservation coordinator and the journal are real; a request is cut by failing its reserve step.
// The purchase is the card fixture: `maxRecords` 100, one allocation of four routes (68 units), the context slot already returned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, generateCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_DISCOVERY_PATH, DACS_SELLER_HTTP_PATHS as PATHS, completeWireEffect, inspectWireOperation, wireOperationBinding, wireRequestHash } from '@kynesyslabs/dacs/wire';
import { journalStore, reserveEffect } from '../../../dist/wire/journal.js';
import { createAccountingReconciler } from '../src/dacs/accounting-reconciliation.mjs';
import { createPurchaseCapacity } from '../src/dacs/seller-purchase-capacity.mjs';
import { createReservationCoordinator, requestNonceKey } from '../src/dacs/seller-reservation-accounting.mjs';
import { TERMINAL_CONTEXT_STATES, sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
import { KIT_TP1_VET_MODE, startSellerHost } from '../src/host.mjs';
import { commitmentFixture } from './helpers/commitment-fixture.mjs';
import { NOW, buyer, seller } from './helpers/protocol-fixture.mjs';
import { BUYER, JOB, JOB2, OTHER, PIN, SELLER, T0, accountingFixture } from './helpers/reservation-accounting-fixture.mjs';
import { testNetwork } from './helpers/wire-authority-fixture.mjs';
import { FIXTURE_ENDPOINT, wireBuyer } from './helpers/wire-buyer.mjs';

const MISMATCH = 'kit_journal_accounting_mismatch';
const CUTS = 17, PAST_LEASE_MS = 300001;
const OUTCOME = { status: 200, text: '{"disposition":"present"}' };
const cutError = new Error('TEST cut');
const hash = text => sha256Hex(String(text));
const labelOf = result => (result === null ? 'unclassified' : result.kind === 'not-published' ? 'not-published' : result.attempt === null ? result.effectState : `${result.effectState}/${result.attempt}`);

// The card fixture on real storage. `restart()` closes and reopens the store, builds the capacity on it (with a new `maxRecords` when
// given) and runs the reconciliation, as host startup does. `fillers` are completed accounting rows of other work that still count.
async function purchase(t, { maxRecords = 100, fillers = 33, commitOnSignature = false } = {}) {
  const control = { state: () => null }, f = await accountingFixture(t, { leaveCapacityToTest: true, contextSessionState: input => control.state(input) });
  const w = { f, control, limit: maxRecords, inspect: target => inspectWireOperation(f.journal, target) };
  w.build = () => {
    w.store = f.store(); w.internals = sellerStoreInternals(w.store);
    w.capacity = createPurchaseCapacity({ store: w.store, now: f.now, maxRecords: w.limit, commitOnSignature, sessionState: w.internals.sessionState });
    w.coordinator = createReservationCoordinator({ accounting: w.store.reservationAccounting, capacity: w.capacity, inspectOperation: target => w.inspect(target) });
    w.reconciler = createAccountingReconciler({ store: w.store, capacity: w.capacity, journal: f.journal, inspectOperation: target => w.inspect(target) });
  };
  w.restart = async (limit = w.limit) => { w.limit = limit; f.reopen(); w.build(); return w.reconciler.reconcileStartup(); };
  w.within = work => w.internals.transaction(work);
  // Completed accounting rows of other buyers' jobs, one job each so none is superseded by another: every one keeps counting against `maxRecords`.
  w.fill = count => {
    const { db } = f;
    const base = db.prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n;
    for (let n = 0; n < count; n++) {
      const jobId = generateCanonicalJobId({ timestamp: T0, entropy: Buffer.from(hash(`filler job ${base + n}`), 'hex').subarray(0, 10) });
      db.prepare('INSERT INTO kit_job_holds VALUES (?, ?, ?, ?, 0)').run(jobId, OTHER.claim, SELLER.claim, canonicalize(PIN));
      db.prepare(`INSERT INTO kit_reservations (key, buyer, jobId, operationId, route, allocationId, class, requestHash, at, state, rev)
        VALUES (?, ?, ?, ?, ?, NULL, 'general', ?, ?, 'completed', 2)`).run(hash(`filler ${base + n}`), OTHER.claim, jobId, hash('filler operation'), PATHS.proposals, hash('filler request'), T0);
    }
  };
  w.build();
  const held = w.within(() => w.capacity.allocateWithin({ jobId: JOB, buyer: BUYER.claim, seller: SELLER.claim, listingPin: PIN }));
  w.within(() => w.capacity.returnRouteSlotWithin({ allocationId: held.allocationId, allocationRev: held.rev, route: PATHS.context }));
  w.fill(fillers);
  return w;
}

// One request on `route`, charged through the coordinator and reserved in the real journal. `cut` stops it: 'accounting' before the journal
// is touched, 'nonce' after the nonce key with the attempt not published, 'attempt' after the attempt, and none runs it to its result.
async function request(w, route, cut = null, { retainedWork = true } = {}) {
  const payload = w.f.payload({ path: route }), op = w.f.args(payload);
  let effect = null;
  const checked = { ...op.checked, reserve: async () => {
    if (cut === 'accounting') throw cutError;
    effect = reserveEffect(journalStore(w.f.journal), { key: requestNonceKey(payload), binding: wireOperationBinding(payload), requestHash: wireRequestHash(payload), seller: payload.seller, jobId: payload.jobId, path: route });
    if (cut === 'nonce' || cut === 'attempt') throw cutError;
    return effect;
  } };
  const input = { ...op, checked, retainedWork };
  if (cut === null) return { payload, effect: await w.coordinator.reserveCoordinated(input) };
  await assert.rejects(w.coordinator.reserveCoordinated(input), cutError);
  if (cut === 'nonce') rmSync(join(w.f.journalDir, `o-${op.operationId}-0`));
  return { payload, effect };
}
const finish = (w, route, effect) => { completeWireEffect(w.f.journal, effect, OUTCOME); return giveBack(w, route); };
function giveBack(w, route) {
  w.within(() => { const held = w.capacity.allocationWithin(JOB); w.capacity.returnRouteSlotWithin({ allocationId: held.allocationId, allocationRev: held.rev, route }); });
}
const totals = w => { const { used, allotted, free } = w.capacity.capacityReport(); return { used, allotted, free }; };
const slot = (w, route) => w.capacity.capacityReport().allocations.find(allocation => allocation.jobId === JOB).slots[route];
const allocationId = w => w.capacity.capacityReport().allocations.find(allocation => allocation.jobId === JOB).allocationId;
const results = w => w.f.db.prepare('SELECT k.route, k.state, x.result FROM kit_reservations k LEFT JOIN kit_reservation_results x ON x.key = k.key WHERE k.state = ? ORDER BY k.rowid')
  .all('reserving').map(row => ({ route: row.route, label: labelOf(row.result === null ? null : JSON.parse(row.result)) }));
const labels = (w, route) => results(w).filter(row => row.route === route).map(row => row.label);
const fileBytes = w => new Map(readdirSync(w.f.journalDir).map(name => [name, readFileSync(join(w.f.journalDir, name)).toString('hex')]));
const nonceFiles = w => readdirSync(w.f.journalDir).filter(name => name.startsWith('k-'));
const reconciliationRow = w => w.f.db.prepare('SELECT * FROM kit_accounting_reconciliation').get();
// Two further restarts must change nothing: the counters, each slot, the files and the classifications.
async function assertStable(w, restarts = 2) {
  const before = { totals: totals(w), id: allocationId(w), results: results(w), files: fileBytes(w), allocations: JSON.stringify(w.capacity.capacityReport().allocations) };
  for (let n = 1; n <= restarts; n++) {
    assert.equal((await w.restart()).ready, true, `restart ${n}`);
    assert.deepEqual({ totals: totals(w), id: allocationId(w), results: results(w), files: fileBytes(w), allocations: JSON.stringify(w.capacity.capacityReport().allocations) }, before, `restart ${n}`);
  }
}
const CARD_START = { used: 33, allotted: 51, free: 16 };

test('a charge cut before the journal call is not-published after each restart, and the retry spends the same slot', async t => {
  const w = await purchase(t), id = allocationId(w);
  await request(w, PATHS.proposals, 'accounting');
  assert.deepEqual(totals(w), { used: 34, allotted: 50, free: 16 });
  for (let n = 0; n < 2; n++) {
    assert.equal((await w.restart()).ready, true);
    assert.deepEqual(labels(w, PATHS.proposals), ['not-published']); assert.deepEqual(totals(w), { used: 34, allotted: 50, free: 16 });
    assert.equal(allocationId(w), id); assert.deepEqual(readdirSync(w.f.journalDir), []);
  }
  const { effect } = await request(w, PATHS.proposals);
  assert.equal(effect.state, 'new'); assert.equal(effect.attempt, 0); assert.equal(slot(w, PATHS.proposals).spent, 2);
  finish(w, PATHS.proposals, effect);
  assert.deepEqual(totals(w), { used: 35, allotted: 34, free: 31 });
});

test('a charge cut after the nonce key and before the attempt is no-attempt, and its nonce file is kept', async t => {
  const w = await purchase(t);
  await request(w, PATHS.proposals, 'nonce');
  const files = fileBytes(w);
  assert.equal(nonceFiles(w).length, 1);
  for (let n = 0; n < 2; n++) {
    assert.equal((await w.restart()).ready, true);
    assert.deepEqual(labels(w, PATHS.proposals), ['no-attempt']); assert.deepEqual(totals(w), { used: 34, allotted: 50, free: 16 }); assert.deepEqual(fileBytes(w), files);
  }
  const { effect } = await request(w, PATHS.proposals);
  assert.equal(effect.attempt, 0); finish(w, PATHS.proposals, effect);
  assert.deepEqual(totals(w), { used: 35, allotted: 34, free: 31 });
});

test('a charge cut after the attempt and before its result is published{new, attempt 0}, and after the lease the retry recovers from the same slot', async t => {
  const w = await purchase(t);
  await request(w, PATHS.proposals, 'attempt');
  for (let n = 0; n < 2; n++) {
    assert.equal((await w.restart()).ready, true);
    assert.deepEqual(labels(w, PATHS.proposals), ['new/0']); assert.deepEqual(totals(w), { used: 34, allotted: 50, free: 16 });
  }
  w.f.setTime(T0 + PAST_LEASE_MS);
  const { effect } = await request(w, PATHS.proposals);
  assert.equal(effect.state, 'recover'); assert.equal(effect.attempt, 1);
  finish(w, PATHS.proposals, effect);
  assert.deepEqual(totals(w), { used: 35, allotted: 34, free: 31 });
});

// An operation completed in the journal whose slot was never returned: the row is saved, the outcome published, and the process is gone.
for (const [label, dropOutcomeFile] of [['the outcome file', false], ['the end record alone, with no outcome file', true]]) {
  test(`a completion that reached the journal before the slot return, with ${label}, returns the slot once`, async t => {
    const w = await purchase(t), { effect, payload } = await request(w, PATHS.proposals);
    completeWireEffect(w.f.journal, effect, OUTCOME);
    if (dropOutcomeFile) rmSync(join(w.f.journalDir, `o-${w.f.args(payload).operationId}.done`));
    assert.deepEqual(totals(w), { used: 34, allotted: 50, free: 16 });
    assert.equal((await w.restart()).ready, true);
    assert.deepEqual(totals(w), { used: 34, allotted: 34, free: 32 }); assert.equal(slot(w, PATHS.proposals).state, 'returned');
    await assertStable(w);
    const replay = await request(w, PATHS.proposals, null, { retainedWork: false });
    assert.equal(replay.effect.state, 'completed'); assert.deepEqual(totals(w), { used: 35, allotted: 34, free: 31 });
  });
}

test('a restart after the slot return changes nothing and returns nothing more', async t => {
  const w = await purchase(t), { effect } = await request(w, PATHS.proposals);
  finish(w, PATHS.proposals, effect);
  assert.deepEqual(totals(w), { used: 34, allotted: 34, free: 32 });
  await assertStable(w);
  assert.deepEqual(totals(w), { used: 34, allotted: 34, free: 32 });
});

test('a terminal purchase stays released after each restart and starts no new effect', async t => {
  const w = await purchase(t), id = allocationId(w);
  w.within(() => { const held = w.capacity.allocationWithin(JOB); w.capacity.releaseAllWithin({ allocationId: held.allocationId, allocationRev: held.rev }); });
  assert.deepEqual(totals(w), { used: 33, allotted: 0, free: 67 });
  await assertStable(w);
  const released = w.capacity.capacityReport().allocations.find(allocation => allocation.jobId === JOB);
  assert.equal(released.state, 'released'); assert.equal(released.allocationId, id);
  w.control.state = () => [...TERMINAL_CONTEXT_STATES][0];
  await assert.rejects(request(w, PATHS.proposals), { code: 'context_session_terminal' });
  assert.deepEqual(readdirSync(w.f.journalDir), []);
});

test('a payment that completed in the journal before the allocation was released releases the allocation once', async t => {
  const w = await purchase(t), { effect } = await request(w, PATHS.payments);
  completeWireEffect(w.f.journal, effect, OUTCOME);
  assert.deepEqual(totals(w), { used: 34, allotted: 50, free: 16 });
  assert.equal((await w.restart()).ready, true);
  const released = w.capacity.capacityReport().allocations[0];
  assert.equal(released.state, 'released'); assert.deepEqual(totals(w), { used: 34, allotted: 0, free: 66 });
  await assertStable(w);
});

// The state after each cut, then the same state after a first and a second restart, then the purchase continues.
const CUT_STATES = { accounting: ['not-published', 50], nonce: ['no-attempt', 50], attempt: ['new/0', 50] };
test('each cut leaves the same allocation, counters, slots and files after a first and a second restart, and the purchase then continues', async t => {
  for (const [cut, [label, allotted]] of Object.entries(CUT_STATES)) {
    const w = await purchase(t), id = allocationId(w);
    await request(w, PATHS.proposals, cut);
    assert.equal((await w.restart()).ready, true);
    assert.deepEqual(labels(w, PATHS.proposals), [label], cut); assert.equal(totals(w).allotted, allotted, cut); assert.equal(allocationId(w), id, cut);
    await assertStable(w);
    w.f.setTime(T0 + PAST_LEASE_MS);
    const { effect } = await request(w, PATHS.proposals);
    finish(w, PATHS.proposals, effect);
    assert.deepEqual(totals(w), { used: 35, allotted: 34, free: 31 }, `${cut} continues to delivery`);
  }
});

test('a charge cut after the nonce key and the attempt reconciles to the same counts after each restart', async t => {
  const w = await purchase(t);
  await request(w, PATHS.proposals, 'attempt');
  const counts = () => ({ rows: w.f.rows().length, files: readdirSync(w.f.journalDir).length, nonces: nonceFiles(w).length, ...totals(w) });
  const before = counts();
  for (let n = 0; n < 2; n++) { await w.restart(); assert.deepEqual(counts(), before); }
  assert.deepEqual(labels(w, PATHS.proposals), ['new/0']);
});

test('a charge cut after its row, before the wire call, stays counted and adds no capacity', async t => {
  const w = await purchase(t), before = totals(w);
  await request(w, PATHS.proposals, 'accounting');
  const counted = totals(w);
  assert.equal(counted.used, before.used + 1);
  for (let n = 0; n < 2; n++) {
    await w.restart();
    assert.deepEqual(totals(w), counted); assert.equal(totals(w).used + totals(w).allotted + totals(w).free, 100);
    assert.equal(w.f.db.prepare('SELECT COUNT(*) AS n FROM kit_allocations').get().n, 1);
  }
  const { effect } = await request(w, PATHS.proposals);
  assert.equal(slot(w, PATHS.proposals).spent, 2); assert.equal(effect.attempt, 0);
});

// ------------------------------------------------------------------ journal evidence that does not match

const plantNonce = (w, key, { operationId = hash('planted operation'), binding = hash('planted binding'), requestHash = hash('planted request') } = {}) =>
  writeFileSync(join(w.f.journalDir, `k-${key}`), canonicalize({ key, operationId, binding, requestHash }), { mode: 0o600 });

test('a nonce key with no accounting row sets ready false with the mismatch code, and nothing is deleted', async t => {
  const w = await purchase(t);
  await request(w, PATHS.proposals, 'accounting');
  const orphan = hash('orphan');
  plantNonce(w, orphan);
  const before = { files: fileBytes(w), rows: JSON.stringify(w.f.rows()), totals: totals(w) };
  const outcome = await w.restart();
  assert.equal(outcome.ready, false); assert.equal(outcome.code, MISMATCH); assert.match(outcome.cause.message, new RegExp(orphan));
  assert.deepEqual({ files: fileBytes(w), rows: JSON.stringify(w.f.rows()), totals: totals(w) }, before);
  assert.equal(reconciliationRow(w).state, 'mismatch');
  assert.deepEqual(results(w), [{ route: PATHS.proposals, label: 'unclassified' }], 'the charge is left as it was');
});

test('readiness is false while a step cannot finish, which keeps its row and cause, and a later restart finishes it', async t => {
  const w = await purchase(t);
  await request(w, PATHS.proposals, 'attempt');
  const failure = Object.assign(new Error('TEST journal unreadable'), { code: 'EIO' });
  w.inspect = () => { throw failure; };
  const outcome = await w.restart();
  assert.deepEqual({ ready: outcome.ready, code: outcome.code, cause: outcome.cause.message }, { ready: false, code: MISMATCH, cause: 'TEST journal unreadable' });
  assert.equal(outcome.cause.code, 'operation_uncertain'); assert.deepEqual(results(w), [{ route: PATHS.proposals, label: 'unclassified' }]);
  assert.deepEqual(totals(w), { used: 34, allotted: 50, free: 16 });
  w.inspect = target => inspectWireOperation(w.f.journal, target);
  assert.equal((await w.restart()).ready, true);
  assert.deepEqual(labels(w, PATHS.proposals), ['new/0']); assert.equal(reconciliationRow(w).state, 'consistent');
});

test('a nonce key whose operation or request differs from its row, or whose operation is bound to another request, is a mismatch', async t => {
  const w = await purchase(t);
  const { payload } = await request(w, PATHS.proposals, 'attempt'), key = requestNonceKey(payload);
  const file = join(w.f.journalDir, `k-${key}`), original = readFileSync(file);
  const record = JSON.parse(original.toString());
  for (const change of [{ requestHash: hash('another request') }, { operationId: hash('another operation') }]) {
    writeFileSync(file, canonicalize({ ...record, ...change }));
    const outcome = await w.restart();
    assert.equal(outcome.ready, false, JSON.stringify(change)); assert.equal(outcome.code, MISMATCH);
  }
  writeFileSync(file, canonicalize({ ...record, binding: hash('another binding') }));
  const bound = await w.restart();
  assert.equal(bound.ready, false); assert.match(bound.cause.message, /another request binding/);
  writeFileSync(file, original);
  assert.equal((await w.restart()).ready, true);
});

const manyKeys = (w, count, { as = 'matched' } = {}) => {
  const { db } = w.f;
  db.prepare('INSERT OR IGNORE INTO kit_job_holds VALUES (?, ?, ?, ?, 0)').run(JOB2, OTHER.claim, SELLER.claim, canonicalize(PIN));
  const base = db.prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n;
  for (let n = 0; n < count; n++) {
    const key = hash(`matched key ${base + n}`), operationId = hash('matched operation'), requestHash = hash('matched request');
    if (as === 'matched') db.prepare(`INSERT INTO kit_reservations (key, buyer, jobId, operationId, route, allocationId, class, requestHash, at, state, rev)
      VALUES (?, ?, ?, ?, ?, NULL, 'general', ?, ?, 'completed', 2)`).run(key, OTHER.claim, JOB2, operationId, PATHS.proposals, requestHash, T0);
    plantNonce(w, key, { operationId, requestHash, binding: hash('matched binding') });
  }
};

test('the complete nonce-key list is checked against every accounting row, past 256 keys, and one key more than the rows refuses', async t => {
  const w = await purchase(t, { fillers: 0 });
  manyKeys(w, 300);
  const files = fileBytes(w);
  for (let scan = 0; scan < 2; scan++) { assert.equal((await w.restart()).ready, true); assert.deepEqual(fileBytes(w), files); }
  manyKeys(w, 1, { as: 'orphan' });
  const outcome = await w.restart();
  assert.equal(outcome.ready, false); assert.equal(outcome.code, MISMATCH); assert.equal(outcome.cause.code, 'seller_replay_guard_invalid'); assert.match(outcome.cause.message, /STORE-ENUMERATION-INCOMPLETE/);
  assert.equal(fileBytes(w).size, files.size + 1, 'nothing was deleted');
  const [name] = [...fileBytes(w).keys()].filter(file => file.startsWith('k-') && !files.has(file));
  rmSync(join(w.f.journalDir, name));
  const [matched] = [...files.keys()].filter(file => file.startsWith('k-'));
  rmSync(join(w.f.journalDir, matched)); plantNonce(w, hash('replacement orphan'));
  const swapped = await w.restart();
  assert.equal(swapped.ready, false, 'the count fits, but one key names no row'); assert.match(swapped.cause.message, /names no accounting row/);
});

test('a corrupt nonce entry, or one the journal cannot read, refuses before any staged accounting or slot return', async t => {
  for (const damage of [file => writeFileSync(file, 'not a nonce record'), file => mkdirSync(file)]) {
    const w = await purchase(t);
    await request(w, PATHS.proposals, 'attempt');
    const { effect } = await request(w, PATHS.commitments); completeWireEffect(w.f.journal, effect, OUTCOME);
    manyKeys(w, 2, { as: 'matched' });
    damage(join(w.f.journalDir, `k-${hash('damaged')}`));
    const before = { rows: JSON.stringify(w.f.rows()), allocations: JSON.stringify(w.capacity.capacityReport().allocations), results: results(w) };
    const outcome = await w.restart();
    assert.equal(outcome.ready, false); assert.equal(outcome.code, MISMATCH); assert.equal(outcome.cause.code, 'seller_replay_guard_invalid');
    assert.deepEqual({ rows: JSON.stringify(w.f.rows()), allocations: JSON.stringify(w.capacity.capacityReport().allocations), results: results(w) }, before);
    assert.equal(slot(w, PATHS.commitments).state, 'open', 'a completed operation keeps its slot while the list is incomplete');
  }
});

test('an empty nonce-key directory is the complete empty list at no rows, repeatedly, and any key then refuses', async t => {
  const w = await purchase(t, { fillers: 0 });
  for (let scan = 0; scan < 3; scan++) { const outcome = await w.restart(); assert.deepEqual({ ready: outcome.ready, code: outcome.code, cause: outcome.cause }, { ready: true, code: null, cause: null }); }
  assert.equal(reconciliationRow(w).state, 'consistent');
  plantNonce(w, hash('first key'));
  const refused = await w.restart();
  assert.equal(refused.ready, false); assert.match(refused.cause.message, /STORE-ENUMERATION-INCOMPLETE/);
});

test('a complete list that fails on a later record applies none of the planned rows or slot returns', async t => {
  const w = await purchase(t);
  await request(w, PATHS.proposals, 'attempt');
  const { effect } = await request(w, PATHS.commitments); completeWireEffect(w.f.journal, effect, OUTCOME);
  for (let n = 0; n < 5; n++) plantNonce(w, hash(`valid later key ${n}`), { operationId: hash(`op ${n}`) });
  writeFileSync(join(w.f.journalDir, `k-${'f'.repeat(64)}`), '{"key":');
  const before = { rows: JSON.stringify(w.f.rows()), allocations: JSON.stringify(w.capacity.capacityReport().allocations), results: results(w), table: w.f.db.prepare('SELECT COUNT(*) AS n FROM kit_reservation_results').get().n };
  const outcome = await w.restart();
  assert.equal(outcome.ready, false);
  assert.deepEqual({ rows: JSON.stringify(w.f.rows()), allocations: JSON.stringify(w.capacity.capacityReport().allocations), results: results(w), table: w.f.db.prepare('SELECT COUNT(*) AS n FROM kit_reservation_results').get().n }, before);
});

// ------------------------------------------------------------------ plan against commit

test('a row or allocation that moves between planning and commit discards the plan, and nothing is half applied', async t => {
  for (const [what, move] of [['a charged row', w => w.f.db.prepare("UPDATE kit_reservations SET rev = rev + 1 WHERE state = 'reserving'").run()],
    ['the allocation', w => w.f.db.prepare('UPDATE kit_allocations SET rev = rev + 1').run()]]) {
    const once = await purchase(t), twice = await purchase(t);
    for (const w of [once, twice]) {
      await request(w, PATHS.proposals, 'attempt');
      const { effect } = await request(w, PATHS.commitments); completeWireEffect(w.f.journal, effect, OUTCOME);
    }
    // One move: the plan is read again and then commits.
    let moves = 0; once.inspect = target => { if (moves++ === 0) move(once); return inspectWireOperation(once.f.journal, target); };
    assert.equal((await once.restart()).ready, true, `${what} moved once`);
    assert.deepEqual(labels(once, PATHS.proposals), ['new/0']); assert.equal(slot(once, PATHS.commitments).state, 'returned');
    // A move on every plan: no plan commits, the restart fails, and the rows and slots are as they were.
    twice.inspect = target => { move(twice); return inspectWireOperation(twice.f.journal, target); };
    await assert.rejects(twice.restart(), { code: 'peer_reconciliation_conflict' });
    assert.deepEqual(results(twice), [{ route: PATHS.proposals, label: 'unclassified' }], what);
    assert.equal(slot(twice, PATHS.commitments).state, 'open', what);
    assert.equal(twice.f.db.prepare('SELECT COUNT(*) AS n FROM kit_reservation_results').get().n, 0, what);
  }
});

// ------------------------------------------------------------------ a request that no longer shows its attempt

test('an older charge whose attempt the journal no longer shows is attempt-unresolved, keeps its charge and does not block readiness', async t => {
  const w = await purchase(t), first = await request(w, PATHS.proposals, 'attempt'), id = allocationId(w);
  w.f.setTime(T0 + PAST_LEASE_MS);
  await request(w, PATHS.proposals, 'attempt');
  const requestHashes = w.f.db.prepare('SELECT requestHash FROM kit_reservations WHERE state = ? ORDER BY rowid').all('reserving').map(row => row.requestHash);
  assert.equal(requestHashes[0], wireRequestHash(first.payload));
  for (let n = 0; n < 3; n++) {
    const outcome = await w.restart();
    assert.equal(outcome.ready, true);
    assert.deepEqual(labels(w, PATHS.proposals), ['attempt-unresolved', 'recover/1']);
    assert.deepEqual(totals(w), { used: 35, allotted: 49, free: 16 }); assert.equal(allocationId(w), id);
    assert.deepEqual(w.f.db.prepare('SELECT requestHash FROM kit_reservations WHERE state = ? ORDER BY rowid').all('reserving').map(row => row.requestHash), requestHashes);
  }
  w.f.setTime(T0 + 2 * PAST_LEASE_MS);
  const { effect } = await request(w, PATHS.proposals);
  assert.equal(effect.state, 'recover'); assert.equal(effect.attempt, 2);
});

test('a charge whose operation completed with no recorded request is attempt-unresolved, and one with no attempt at all is no-attempt', async t => {
  const completed = await purchase(t);
  await request(completed, PATHS.proposals, 'attempt');
  completed.f.setTime(T0 + PAST_LEASE_MS);
  const other = await request(completed, PATHS.proposals);
  completeWireEffect(completed.f.journal, other.effect, OUTCOME);
  assert.equal((await completed.restart()).ready, true);
  assert.deepEqual(labels(completed, PATHS.proposals), ['attempt-unresolved']);
  const none = await purchase(t); await request(none, PATHS.proposals, 'nonce');
  assert.equal((await none.restart()).ready, true); assert.deepEqual(labels(none, PATHS.proposals), ['no-attempt']);
});

test('an operation bound to a different request binding, or one that cannot be read, is a mismatch and not attempt-unresolved', async t => {
  const w = await purchase(t); await request(w, PATHS.proposals, 'attempt');
  w.inspect = target => ({ ...inspectWireOperation(w.f.journal, target), binding: hash('foreign binding') });
  const foreign = await w.restart();
  assert.equal(foreign.ready, false); assert.equal(foreign.code, MISMATCH); assert.deepEqual(results(w), [{ route: PATHS.proposals, label: 'unclassified' }]);
  w.inspect = () => { throw new Error('TEST unreadable operation'); };
  assert.equal((await w.restart()).ready, false);
  w.inspect = () => ({ state: 'unknown' });
  assert.equal((await w.restart()).ready, false, 'an operation view of no known state');
});

// ------------------------------------------------------------------ the exhausted slot

const filesSnapshot = w => new Map([...fileBytes(w)]);
const unchanged = (earlier, now) => { for (const [name, bytes] of earlier) assert.equal(now.get(name), bytes, `${name} is byte-identical`); };
// Alternating cuts on `route`: accounting before the journal call, then nonce key before the attempt, a restart after each, then two more.
async function exhaustSlot(w, route, base, { cuts = CUTS } = {}) {
  const id = allocationId(w), baseFiles = filesSnapshot(w), baseNonces = nonceFiles(w).length;
  let earlier = baseFiles;
  for (let i = 1; i <= cuts; i++) {
    await request(w, route, i % 2 === 1 ? 'accounting' : 'nonce');
    assert.equal((await w.restart()).ready, true, `cut ${i}`);
    assert.deepEqual(totals(w), { used: base.used + i, allotted: base.allotted - i, free: base.free }, `cut ${i}`);
    assert.equal(slot(w, route).spent, i, `cut ${i}`); assert.equal(allocationId(w), id);
    assert.deepEqual([labels(w, route).filter(label => label === 'not-published').length, labels(w, route).filter(label => label === 'no-attempt').length], [Math.ceil(i / 2), Math.floor(i / 2)], `cut ${i}`);
    assert.equal(nonceFiles(w).length - baseNonces, Math.floor(i / 2), `cut ${i}`);
    assert.equal([...fileBytes(w).keys()].filter(name => name.startsWith('o-')).length, [...baseFiles.keys()].filter(name => name.startsWith('o-')).length, `cut ${i} publishes no attempt`);
    unchanged(earlier, fileBytes(w)); earlier = filesSnapshot(w);
  }
  await w.restart(); await w.restart();
  return { id, baseFiles, baseNonces };
}
const newPurchase = w => () => w.within(() => w.capacity.allocateWithin({ jobId: generateCanonicalJobId({ timestamp: T0, entropy: Buffer.alloc(10, 7) }), buyer: BUYER.claim, seller: SELLER.claim, listingPin: PIN }));
const NOT_READY = { code: 'seller_not_ready' };

test('seventeen alternating cuts on the first execution of a stage exhaust its slot, keep every state, and the authorized retry is admitted as general', async t => {
  const w = await purchase(t);
  assert.deepEqual(totals(w), CARD_START);
  const { baseNonces } = await exhaustSlot(w, PATHS.proposals, CARD_START);
  assert.deepEqual(totals(w), { used: 50, allotted: 34, free: 16 }); assert.equal(slot(w, PATHS.proposals).spent, 17);
  assert.equal(results(w).length, 17); assert.equal(nonceFiles(w).length - baseNonces, 8);
  assert.equal(inspectWireOperation(w.f.journal, { seller: SELLER.claim, jobId: JOB, path: PATHS.proposals }).state, 'none');
  const { effect } = await request(w, PATHS.proposals);
  assert.equal(effect.state, 'new'); assert.equal(effect.attempt, 0);
  assert.deepEqual(totals(w), { used: 51, allotted: 34, free: 15 }); assert.equal(nonceFiles(w).length - baseNonces, 9);
  finish(w, PATHS.proposals, effect);
  assert.deepEqual(totals(w), { used: 51, allotted: 34, free: 15 }, 'completion returns nothing');
  assert.throws(newPurchase(w), NOT_READY);
});

test('with maxRecords raised after the exhaustion and a restart, the retry is admitted as general and no file is deleted', async t => {
  const w = await purchase(t);
  await exhaustSlot(w, PATHS.proposals, CARD_START);
  const files = filesSnapshot(w);
  await w.restart(120);
  assert.deepEqual(totals(w), { used: 50, allotted: 34, free: 36 }); assert.equal(w.capacity.capacityReport().ready, false);
  const { effect } = await request(w, PATHS.proposals);
  assert.deepEqual(totals(w), { used: 51, allotted: 34, free: 35 }); assert.equal(effect.attempt, 0);
  assert.throws(newPurchase(w), NOT_READY);
  unchanged(files, fileBytes(w)); assert.ok(fileBytes(w).size > files.size);
});

// A purchase whose proposals completed: one more row, and the proposals slot's unspent units returned.
async function afterProposals(t, options) {
  const w = await purchase(t, options), { effect } = await request(w, PATHS.proposals);
  finish(w, PATHS.proposals, effect);
  return w;
}

test('the same sequence on the commitments stage after proposals completed, and on commitments with signature in its real order, keeps every state', async t => {
  const commitments = await afterProposals(t);
  assert.deepEqual(totals(commitments), { used: 34, allotted: 34, free: 32 });
  const proposalFiles = filesSnapshot(commitments);
  await exhaustSlot(commitments, PATHS.commitments, { used: 34, allotted: 34, free: 32 });
  assert.deepEqual(totals(commitments), { used: 51, allotted: 17, free: 32 }); assert.equal(slot(commitments, PATHS.commitments).spent, 17);
  unchanged(proposalFiles, fileBytes(commitments));
  const retry = await request(commitments, PATHS.commitments);
  assert.equal(retry.effect.attempt, 0); assert.deepEqual(totals(commitments), { used: 52, allotted: 17, free: 31 });
  assert.throws(newPurchase(commitments), NOT_READY);

  const signature = await afterProposals(t, { commitOnSignature: true, fillers: 16 });
  assert.deepEqual(totals(signature), { used: 17, allotted: 51, free: 32 });
  await exhaustSlot(signature, PATHS.commitmentSignature, { used: 17, allotted: 51, free: 32 });
  assert.deepEqual(totals(signature), { used: 34, allotted: 34, free: 32 });
  await request(signature, PATHS.commitmentSignature);
  assert.deepEqual(totals(signature), { used: 35, allotted: 34, free: 31 });
  assert.throws(newPurchase(signature), NOT_READY);
});

test('with no general capacity the retry is refused peer_store_capacity with its exhaustion record, and admitted as general once maxRecords is raised', async t => {
  const w = await afterProposals(t);
  w.fill(32);
  assert.deepEqual(totals(w), { used: 66, allotted: 34, free: 0 });
  const proposalFiles = filesSnapshot(w);
  await exhaustSlot(w, PATHS.commitments, { used: 66, allotted: 34, free: 0 });
  assert.deepEqual(totals(w), { used: 83, allotted: 17, free: 0 }); assert.equal(slot(w, PATHS.commitments).spent, 17);
  const files = filesSnapshot(w), rows = w.f.rows().length;
  await assert.rejects(request(w, PATHS.commitments), { code: 'peer_store_capacity', status: 503 });
  assert.equal(w.f.rows().length, rows); assert.deepEqual(fileBytes(w), files); unchanged(proposalFiles, fileBytes(w));
  assert.deepEqual(w.capacity.capacityReport().exhausted.map(({ jobId, route, cause }) => ({ jobId, route, cause })), [{ jobId: JOB, route: PATHS.commitments, cause: 'peer_store_capacity' }]);
  await w.restart(120);
  assert.equal(totals(w).free, 20);
  await request(w, PATHS.commitments);
  assert.deepEqual(totals(w), { used: 84, allotted: 17, free: 19 });
});

// ------------------------------------------------------------------ the host

test('a host over an existing store stays not ready while a nonce key names no accounting row, and is ready once the journal and the store agree', async t => {
  const f = await commitmentFixture(t, { vetMode: KIT_TP1_VET_MODE, publicEndpoint: FIXTURE_ENDPOINT });
  const dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-host-reconciliation-'));
  const { durableDirectory, commitOnSignature, nativeArtifactAnchor, ...config } = f.config;
  delete config.vetMode; delete config.challengeLedger;
  const options = { ...config, artifactAnchor: nativeArtifactAnchor, dataDirectory, tp1Network: testNetwork() }, hosts = [];
  t.after(async () => { for (const host of hosts) await host.close().catch(() => {}); await rm(dataDirectory, { recursive: true, force: true }); });
  const readiness = async () => {
    const host = await startSellerHost(options); hosts.push(host);
    const buyerWire = await wireBuyer({ buyer: { claim: buyer.claim, sign: buyer.signBytes }, seller: { claim: seller.claim, sign: seller.signBytes }, listingPin: host.listingPin, clock: () => NOW });
    const served = await fetch(`${host.url}${DACS_SELLER_DISCOVERY_PATH}`), proof = await buyerWire.verifyDiscovery(Buffer.from(await served.arrayBuffer()));
    await host.close(); hosts.pop();
    return proof.ready;
  };
  assert.equal(await readiness(), true, 'a new store over an empty journal');
  const orphan = join(dataDirectory, 'wire-journal', `k-${hash('orphan')}`);
  writeFileSync(orphan, canonicalize({ key: hash('orphan'), operationId: hash('operation'), binding: hash('binding'), requestHash: hash('request') }), { mode: 0o600 });
  assert.equal(await readiness(), false, 'the existing store meets a key that names no row');
  assert.equal(readFileSync(orphan, 'utf8').includes(hash('operation')), true, 'the key is kept');
  rmSync(orphan);
  assert.equal(await readiness(), true, 'the journal and the store agree again');
});
