// Purchase allocations, accounting, returns and restart recovery on the shared transport store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { canonicalize, generateCanonicalJobId, identityBundleHash } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS, TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION, completeWireEffect, inspectWireOperation, wireOperationBinding, wireOperationId } from '@kynesyslabs/dacs/wire';
import { privateModule } from './helpers/private-module.mjs';
const { retainedFor } = await privateModule(new URL('../src/dacs/seller-wire-requests.mjs', import.meta.url), ['retainedFor']);
import { accountingFixture } from './helpers/reservation-accounting-fixture.mjs';
import { SELLER_PROFILE } from '../src/dacs/session-admission.mjs';
import { boundedCall, isBoundedCallTimeout } from '../src/dacs/bounded-call.mjs';
import * as fixture from './helpers/reservation-accounting-fixture.mjs';
import { FIXTURE_PROFILE } from './helpers/wire-authority-fixture.mjs';

const T0 = Date.UTC(2026, 10, 4, 12), UNITS = 17, FOUR = 68, FIVE = 85;
const hash = text => createHash('sha256').update(String(text)).digest('hex');
const job = index => generateCanonicalJobId({ timestamp: T0, entropy: Buffer.alloc(10, index) });
const claim = tag => 'did:demos:agent:' + hash(tag);
const BUYER = claim('capacity-buyer'), SELLER = claim('capacity-seller'), OTHER = claim('capacity-other-buyer');
const PIN = { listingId: 'capacity-listing', version: 1, contentHash: hash('capacity-listing') };
const PROFILE = Object.freeze({ id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION,
  chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion });
const SCOPE = { agreement: 'capacity-scope' };
const vetRef = tag => ({ vetRecordRef: { anchor: { kind: 'storage-program', locator: `vet-${tag}` }, contentHash: hash(tag) } });
const success = jobId => ({ status: 200, text: JSON.stringify({ disposition: 'present', value: { scope: SCOPE, input: { jobId, buyer: vetRef('buyer'), seller: vetRef('seller') } } }) });
const nonPass = { status: 200, text: JSON.stringify({ disposition: 'rejected', code: 'party_vet_non_pass', errorClass: 'permanent' }) };
const otherOutcome = { status: 200, text: 'not a context answer' };
const ROUTES = [PATHS.context, PATHS.proposals, PATHS.commitments, PATHS.payments];
const ENABLED = { false: ROUTES, true: [...ROUTES, PATHS.commitmentSignature] };
const BINDING = hash('capacity-binding');
const view = {
  none: { state: 'none' },
  pending: leaseUntil => ({ state: 'pending', binding: BINDING, attempt: 0, requestHash: hash('request'), leaseUntil }),
  ended: { state: 'ended', binding: BINDING, attempt: 0, requestHash: hash('request'), superseded: 0 },
  completed: binding => ({ state: 'completed', binding, outcome: { status: 200, text: '{}' } }),
};

let createPurchaseCapacity, createContextAdmissionTransaction, createReservationCoordinator, createSellerTransportStore, sellerStoreInternals, SellerTransportError, TERMINAL_CONTEXT_STATES, importFailure;
try {
  ({ createPurchaseCapacity } = await import('../src/dacs/seller-purchase-capacity.mjs'));
  ({ createReservationCoordinator } = await import('../src/dacs/seller-reservation-accounting.mjs'));
  ({ createContextAdmissionTransaction } = await import('../src/dacs/seller-admission-transaction.mjs'));
  ({ SellerTransportError, TERMINAL_CONTEXT_STATES, createSellerTransportStore, sellerStoreInternals } = await import('../src/dacs/seller-transport-auth.mjs'));
} catch (error) { importFailure = error; }

// One store, its capacity and its admission transaction on one clock. `reopen()` is a restart: the old handle closes and the
// durable rows are all that remains. `maxRecords` may change at a restart.
function world(t, { maxRecords = 1000, commitOnSignature = false, sessionState = () => null, store: storeOptions = {} } = {}) {
  assert.ifError(importFailure);
  const directory = mkdtempSync(join(tmpdir(), 'TEST-purchase-capacity-')), path = join(directory, 'transport.sqlite');
  const control = { clock: T0, ready: true, state: sessionState, inspect: () => view.none, generation: 0, spent: 0 };
  const holds = new Set(), w = { directory, path, control, holds };
  function open(limit) {
    w.store?.close();
    w.store = createSellerTransportStore({ path, now: () => control.clock, generation: `TEST-generation-${++control.generation}`,
      wireOperationView: target => control.operation?.(control.payloads?.get(wireOperationId(target)) ?? target) ?? view.none,
      ready: () => control.ready && w.capacity?.fitsNewPurchase() === true, contextSessionState: input => control.state(input), ...storeOptions });
    w.internals = sellerStoreInternals(w.store);
    w.capacity = createPurchaseCapacity({ store: w.store, now: () => control.clock, maxRecords: limit, commitOnSignature, sessionState: w.internals.sessionState });
    w.admission = createContextAdmissionTransaction({ store: w.store, capacity: w.capacity, now: () => control.clock, ready: () => control.ready,
      policy: { async reserve({ hold }) { holds.add(hold); return null; }, async release({ hold }) { holds.delete(hold); } },
      effectEvidence: async record => [record.vetAddresses.buyer, record.vetAddresses.seller].map(address => ({ address, kind: 'no-intent' })),
      inspectContextOutcome: jobId => control.inspect(jobId), completeWire: () => {}, deadlines: { policyMs: 10000 } });
  }
  w.reopen = (limit = maxRecords) => open(limit);
  open(maxRecords);
  t.after(() => { w.store.close(); rmSync(directory, { recursive: true, force: true }); });
  w.db = () => w.internals.db;
  w.within = work => w.internals.transaction(work);
  w.purchase = (index = 1, buyer = BUYER) => ({ jobId: job(index), buyer, seller: SELLER, listingPin: PIN });
  w.allocate = purchase => w.within(() => w.capacity.allocateWithin(purchase));
  w.current = jobId => w.within(() => w.capacity.allocationWithin(jobId));
  w.report = () => w.capacity.capacityReport();
  w.changes = () => w.db().prepare('SELECT total_changes() AS n').get().n;
  // Durable accounting rows for a charged request: a purchase unit when it names its allocation, a general one otherwise.
  w.charge = (jobId, route, count, allocationId = null, buyer = BUYER) => {
    w.db().prepare('INSERT OR IGNORE INTO kit_job_holds VALUES (?, ?, ?, ?, ?)').run(jobId, buyer, SELLER, canonicalize(PIN), Number(route === PATHS.context));
    for (let n = 0; n < count; n++) {
      w.db().prepare(`INSERT INTO kit_reservations (key, buyer, jobId, operationId, route, allocationId, class, requestHash, at, state, rev)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 2)`).run(hash(`key-${++control.spent}`), buyer, jobId, wireOperationId({ seller: SELLER, jobId, path: route }),
        route, allocationId, allocationId === null ? 'general' : 'purchase', hash('request'), T0);
    }
  };
  w.fill = count => w.charge(job(0xee), PATHS.proposals, count);
  // A commit that fails before it lands or just after it landed, once, for the next transaction for which `when()` holds.
  w.failCommit = (at, when = () => true) => {
    const db = w.db(), exec = db.exec.bind(db); let armed = true;
    db.exec = sql => {
      if (armed && sql === 'COMMIT' && when()) { armed = false; if (at === 'after') exec(sql); throw new Error(`cut-${at}`); }
      return exec(sql);
    };
  };
  w.prepare = (index = 0x11, buyer = BUYER) => {
    const jobId = job(index), scope = hash('challenge-scope'), { sessionNonce: nonce } = w.store.challenges.issue({ jobId, buyer }, scope);
    const bundle = { presentedBy: buyer, sessionNonce: nonce, presentation: { proof: 'TEST-fixture' } };
    const attempt = { nonce, jobId, buyer, challengeScopeHash: scope, presentationHash: hash(canonicalize(bundle)), path: 'context' };
    const result = w.store.challenges.attempt(attempt);
    const accepted = { buyerBundleText: canonicalize(bundle), buyerBundleHash: identityBundleHash(bundle), admission: { disposition: 'admitted', jobId, buyer, buyerBundleHash: identityBundleHash(bundle),
      listingPin: PIN, participants: [{ role: 'buyer', claim: buyer, ...SELLER_PROFILE }, { role: 'seller', claim: SELLER, ...SELLER_PROFILE }] },
    firstAdmission: { challengeExpiresAt: control.clock + 600000, generatedAt: control.clock, checkedAt: control.clock } };
    return { jobId, input: { jobId, buyer, seller: SELLER, listingPin: PIN, contextScopeHash: hash(canonicalize(SCOPE)), nonce, presentationHash: attempt.presentationHash,
      owner: result.owner, accepted, sellerBundlePresentedBy: SELLER, delegationExpiresAt: control.clock + 3600000, purchaseProfile: PROFILE } };
  };
  // The admitted start: the capability a completion runs on.
  w.reserveContext = jobId => w.admission.reserveContext(jobId, async () => Object.freeze({ state: 'new', operationId: hash('wire-operation'), attempt: 0, leaseUntil: control.clock + 300000 }));
  w.admissionRow = jobId => JSON.parse(w.db().prepare('SELECT record FROM kit_context_admissions WHERE jobId = ?').get(jobId).record);
  return w;
}
const figures = report => ({ used: report.used, allotted: report.allotted, free: report.free });
const stable = report => ({ ...figures(report), allocations: report.allocations, exhausted: report.exhausted });
const classifyInput = (purchase, route, inspection, extra = {}) => ({ ...purchase, route, binding: BINDING, inspection, retainedWork: true, ...extra });
const refusal = (work, code, status) => assert.throws(work, error => error.code === code && error.status === status);

test('new purchase needs the whole allotment', t => {
  for (const [commitOnSignature, allotment] of [[false, FOUR], [true, FIVE]]) {
    for (const free of [allotment - 1, allotment, allotment + 1]) {
      const w = world(t, { maxRecords: free, commitOnSignature }), p = w.purchase(), fits = free >= allotment;
      const files = readdirSync(w.directory), before = w.changes();
      assert.equal(w.capacity.allotment(), allotment); assert.equal(w.capacity.fitsNewPurchase(), fits); assert.equal(w.report().ready, fits);
      if (fits) {
        assert.ok(w.store.challenges.issue({ jobId: p.jobId, buyer: BUYER }, hash('scope')).sessionNonce);
        assert.equal(w.allocate(p).state, 'live'); assert.equal(w.report().allotted, allotment);
      } else {
        refusal(() => w.store.challenges.issue({ jobId: p.jobId, buyer: BUYER }, hash('scope')), 'seller_not_ready', 503);
        refusal(() => w.allocate(p), 'seller_not_ready', 503);
        assert.equal(w.changes(), before); assert.equal(w.current(p.jobId), null);
      }
      assert.deepEqual(readdirSync(w.directory), files);
    }
  }
});

test('draining refuses new purchases', async t => {
  const w = world(t, { maxRecords: FOUR + 10 }), first = w.prepare(0x11), second = w.prepare(0x22, OTHER);
  await w.admission.begin(first.input);
  const admitted = w.current(first.jobId), before = stable(w.report());
  assert.equal(w.capacity.fitsNewPurchase(), false);
  refusal(() => w.store.challenges.issue({ jobId: job(0x33), buyer: BUYER }, hash('scope')), 'seller_not_ready', 503);
  await assert.rejects(w.admission.begin(second.input), { code: 'seller_not_ready', status: 503 });
  assert.deepEqual(w.current(first.jobId), admitted); assert.equal(w.current(second.jobId), null); assert.deepEqual(stable(w.report()), before);
  assert.equal(w.capacity.classify(classifyInput(first.input, PATHS.proposals, view.none)).class, 'purchase-stage');
});

test('completion and terminal cleanup return only unused capacity', t => {
  const w = world(t, { maxRecords: 120 }), p = w.purchase(); w.fill(32);
  const allocation = w.allocate(p); w.charge(p.jobId, PATHS.context, 1, allocation.allocationId);
  assert.deepEqual(figures(w.report()), { used: 33, allotted: 67, free: 20 }); assert.equal(w.capacity.fitsNewPurchase(), false);
  const returned = w.within(() => w.capacity.returnRouteSlotWithin({ allocationId: allocation.allocationId, route: PATHS.context, allocationRev: allocation.rev }));
  assert.equal(returned, UNITS - 1); assert.deepEqual(figures(w.report()), { used: 33, allotted: 51, free: 36 }); assert.equal(w.capacity.fitsNewPurchase(), false);
  const live = w.current(p.jobId); assert.equal(live.state, 'live'); assert.equal(live.slots[PATHS.context].state, 'returned'); assert.equal(live.slots[PATHS.proposals].state, 'open');
  assert.equal(w.within(() => w.capacity.releaseAllWithin({ allocationId: allocation.allocationId, allocationRev: live.rev })), 3 * UNITS);
  assert.deepEqual(figures(w.report()), { used: 33, allotted: 0, free: 87 }); assert.equal(w.capacity.fitsNewPurchase(), true); assert.equal(w.current(p.jobId).state, 'released');
});

test('restart preserves used units, allotments and allocation ids', t => {
  const w = world(t, { maxRecords: 300 }), p = w.purchase(); w.fill(5);
  const checkpoints = [];
  const checkpoint = () => { checkpoints.push(stable(w.report())); };
  const allocation = w.allocate(p); checkpoint();
  w.charge(p.jobId, PATHS.context, 1, allocation.allocationId); w.charge(p.jobId, PATHS.proposals, 4, allocation.allocationId);
  w.within(() => w.capacity.returnRouteSlotWithin({ allocationId: allocation.allocationId, route: PATHS.context, allocationRev: allocation.rev })); checkpoint();
  w.within(() => w.capacity.releaseAllWithin({ allocationId: allocation.allocationId, allocationRev: w.capacity.allocationWithin(p.jobId).rev })); checkpoint();
  // The reports are compared at the state they were taken in: the third state is the last, so the first two restart through it.
  const last = checkpoints.at(-1); w.reopen(); w.reopen();
  assert.deepEqual(stable(w.report()), last); assert.equal(w.current(p.jobId).allocationId, allocation.allocationId);
  assert.equal(w.current(p.jobId).slots[PATHS.proposals].spent, 4); assert.equal(w.current(p.jobId).slots[PATHS.context].spent, 1);
  assert.equal(checkpoints[0].allocations[0].allocationId, allocation.allocationId);
  assert.deepEqual(figures(w.report()), { used: 10, allotted: 0, free: 290 });
});

test('crashes preserve allocation and return accounting', async t => {
  await t.test('allocation and acceptance commit together', async () => {
    const w = world(t, { maxRecords: 300 }), p = w.prepare();
    w.failCommit('before', () => w.capacity.allocationWithin(p.jobId) !== null);
    await assert.rejects(w.admission.begin(p.input));
    w.reopen(); assert.equal(w.current(p.jobId), null); assert.equal(w.admissionRow(p.jobId).admittedAt, null);
    assert.deepEqual(figures(w.report()), { used: 0, allotted: 0, free: 300 });
  });
  await t.test('allocation and acceptance committed: both survive two restarts under one allocation id', async () => {
    const w = world(t, { maxRecords: 300 }), p = w.prepare();
    w.failCommit('after', () => w.capacity.allocationWithin(p.jobId) !== null);
    await assert.rejects(w.admission.begin(p.input));
    w.reopen(); const adopted = w.current(p.jobId); assert.equal(adopted.state === 'live' || adopted.state === 'released', true); assert.notEqual(w.admissionRow(p.jobId).admittedAt, null);
    w.reopen(); assert.equal(w.current(p.jobId).allocationId, adopted.allocationId);
    assert.equal(w.allocate(w.purchase(0x11)).allocationId, adopted.allocationId);
  });
  await t.test('a spend committed before wire publication keeps its counters, allocation and purchase class across restarts', () => {
    const w = world(t, { maxRecords: 300 }), p = w.purchase(), allocation = w.allocate(p); w.charge(p.jobId, PATHS.proposals, 1, allocation.allocationId);
    const before = stable(w.report()); w.reopen(); w.reopen();
    assert.deepEqual(stable(w.report()), before); assert.equal(w.current(p.jobId).allocationId, allocation.allocationId);
    assert.equal(w.capacity.classify(classifyInput(p, PATHS.proposals, view.none)).class, 'purchase-stage');
  });
  for (const at of ['before', 'after']) await t.test(`a slot return whose commit fails ${at} landing: one return in total across two restarts`, () => {
    const w = world(t, { maxRecords: 300 }), p = w.purchase(), allocation = w.allocate(p); w.charge(p.jobId, PATHS.payments, 2, allocation.allocationId);
    const input = { allocationId: allocation.allocationId, route: PATHS.payments, allocationRev: allocation.rev };
    w.failCommit(at); assert.throws(() => w.within(() => w.capacity.returnRouteSlotWithin(input)));
    w.reopen(); w.reopen();
    const retried = w.within(() => w.capacity.returnRouteSlotWithin(input));
    assert.equal(retried, at === 'before' ? UNITS - 2 : 0); assert.equal(w.within(() => w.capacity.returnRouteSlotWithin(input)), 0);
    assert.deepEqual(figures(w.report()), { used: 2, allotted: 3 * UNITS, free: 300 - 2 - 3 * UNITS });
  });
  await t.test('a released purchase starts no new effect: the same route is general, and used stays', () => {
    const w = world(t, { maxRecords: 300 }), p = w.purchase(), allocation = w.allocate(p); w.charge(p.jobId, PATHS.payments, 1, allocation.allocationId);
    w.within(() => w.capacity.releaseAllWithin({ allocationId: allocation.allocationId, allocationRev: allocation.rev })); w.reopen(); w.reopen();
    assert.equal(w.capacity.classify(classifyInput(p, PATHS.payments, view.none)).class, 'general'); assert.equal(w.report().used, 1);
  });
});

test('authorized retained stages keep their allocation flag', t => {
  const w = world(t, { maxRecords: 300 }), p = w.purchase(), flag = (purchase, route, stageAuthorized = true) => w.capacity.retainedAllocated({ ...purchase, route, stageAuthorized });
  assert.equal(flag(p, PATHS.proposals), false, 'no allocation');
  const allocation = w.allocate(p); w.charge(p.jobId, PATHS.proposals, UNITS, allocation.allocationId);
  assert.equal(flag(p, PATHS.proposals), true, 'a fully spent slot still counts'); assert.equal(flag(p, PATHS.commitmentSignature), false, 'a route without a slot');
  assert.equal(flag(p, PATHS.proposals, false), false, 'no verified prior stage'); assert.equal(flag(w.purchase(2), PATHS.proposals), false, 'another job');
  assert.equal(flag({ ...p, buyer: OTHER }, PATHS.proposals), false, 'another buyer'); assert.equal(flag({ ...p, listingPin: { ...PIN, version: 2 } }, PATHS.proposals), false, 'another pin');
  assert.throws(() => flag(p, PATHS.proposals, 'yes'), TypeError);
  w.within(() => w.capacity.releaseAllWithin({ allocationId: allocation.allocationId, allocationRev: w.capacity.allocationWithin(p.jobId).rev }));
  assert.equal(flag(p, PATHS.proposals), false, 'a released allocation');
  const signature = world(t, { maxRecords: 300, commitOnSignature: true }); signature.allocate(p);
  assert.equal(signature.capacity.retainedAllocated({ ...p, route: PATHS.commitmentSignature, stageAuthorized: true }), true);
});

test('retained exhaustion is recorded only after rollback', t => {
  const w = world(t, { maxRecords: 80 }), p = w.purchase(); w.fill(12);
  const allocation = w.allocate(p); w.charge(p.jobId, PATHS.proposals, UNITS, allocation.allocationId);
  assert.equal(w.report().free, 0);
  const input = classifyInput(p, PATHS.proposals, view.none), before = w.changes();
  // The caller's whole transaction rolls back; only then is the refusal annotated.
  assert.throws(() => w.internals.transaction(() => w.capacity.classify(input), true), error => error.code === 'peer_store_capacity' && error.status === 503);
  assert.equal(w.changes(), before); assert.deepEqual(w.report().exhausted, []);
  const record = { operationId: wireOperationId({ seller: SELLER, jobId: p.jobId, path: PATHS.proposals }), jobId: p.jobId, route: PATHS.proposals, cause: 'peer_store_capacity' };
  w.capacity.recordExhaustion(record); w.capacity.recordExhaustion(record);
  const expected = [{ operationId: record.operationId, jobId: p.jobId, route: PATHS.proposals, cause: 'peer_store_capacity' }];
  assert.deepEqual(w.report().exhausted, expected); w.reopen(); w.reopen(); assert.deepEqual(w.report().exhausted, expected);
});

test('context settlement and abort clean up their allocation across restart', async t => {
  async function atSP(t) {
    const w = world(t, { maxRecords: 100 }); w.fill(32);
    const p = w.prepare(); await w.admission.begin(p.input); const allocation = w.current(p.jobId);
    w.charge(p.jobId, PATHS.context, 1, allocation.allocationId);
    assert.deepEqual(figures(w.report()), { used: 33, allotted: 67, free: 0 });
    return { w, p, allocation };
  }
  const classes = [['success', jobId => success(jobId), { used: 33, allotted: 51, free: 16 }, 'live'],
    ['vet-non-pass', () => nonPass, { used: 33, allotted: 0, free: 67 }, 'released'], ['other', () => otherOutcome, { used: 33, allotted: 0, free: 67 }, 'released']];
  for (const [name, answer, expected, state] of classes) for (const via of ['D8a', 'compensation']) await t.test(`${via} settles ${name}`, async t => {
    const { w, p, allocation } = await atSP(t), holdId = w.admissionRow(p.jobId).holdId;
    if (via === 'D8a') await (await w.reserveContext(p.jobId)).complete({ status: answer(p.jobId).status, text: answer(p.jobId).text });
    else {
      await w.reserveContext(p.jobId);
      w.control.inspect = () => ({ state: 'completed', binding: w.admissionRow(p.jobId).contextBinding, outcome: answer(p.jobId) });
      await w.admission.compensate(p.jobId, 'd');
    }
    const settle = () => {
      assert.equal(w.admissionRow(p.jobId).state, 'settled'); assert.equal(w.holds.has(holdId), false);
      assert.deepEqual(figures(w.report()), expected); assert.equal(w.current(p.jobId).state, state); assert.equal(w.current(p.jobId).allocationId, allocation.allocationId);
      assert.equal(w.current(p.jobId).slots[PATHS.context].state, 'returned');
      for (const route of [PATHS.proposals, PATHS.commitments, PATHS.payments]) assert.equal(w.current(p.jobId).slots[route].state, name === 'success' ? 'open' : 'returned');
    };
    settle(); const done = stable(w.report());
    for (let round = 0; round < 2; round++) { await w.admission.sweep({ startup: false }); w.reopen(); await w.admission.sweep({ startup: true }); settle(); assert.deepEqual(stable(w.report()), done); }
    if (name === 'success') assert.equal(w.capacity.classify(classifyInput(p.input, PATHS.proposals, view.none)).class, 'purchase-stage');
  });
  await t.test('an aborted admission releases the live allocation once', async t => {
    const { w, p } = await atSP(t); await w.admission.compensate(p.jobId, 'd');
    assert.equal(w.admissionRow(p.jobId).state, 'aborted'); assert.deepEqual(figures(w.report()), { used: 33, allotted: 0, free: 67 }); assert.equal(w.current(p.jobId).state, 'released');
    await w.admission.sweep({ startup: false }); w.reopen(); assert.deepEqual(figures(w.report()), { used: 33, allotted: 0, free: 67 });
  });
  for (const [name, inspect] of [['an inspection that fails', () => { throw new Error('journal unreadable'); }], ['an inspection bound to another operation', () => ({ state: 'completed', binding: hash('another'), outcome: success(job(0x11)) })]]) {
    await t.test(`${name} settles nothing: the allocation, the cause and cleanupPending stay`, async t => {
      const { w, p, allocation } = await atSP(t); await w.reserveContext(p.jobId); w.control.inspect = inspect; const before = stable(w.report());
      await w.admission.compensate(p.jobId, 'd');
      assert.equal(w.admissionRow(p.jobId).state, 'compensating'); assert.notEqual(w.admissionRow(p.jobId).cleanup.cause, null); assert.equal(w.admission.cleanupPending(), true);
      assert.deepEqual(stable(w.report()), before); assert.equal(w.current(p.jobId).allocationId, allocation.allocationId); assert.equal(w.current(p.jobId).state, 'live');
    });
  }
  await t.test('a settlement whose commit fails before landing leaves the row, the allocation and the hold untouched, and the sweep then settles and returns once', async t => {
    const { w, p } = await atSP(t), capability = await w.reserveContext(p.jobId), before = stable(w.report());
    w.failCommit('before', () => w.admissionRow(p.jobId).state === 'settled');
    await assert.rejects(capability.complete(success(p.jobId)));
    assert.equal(w.admissionRow(p.jobId).state, 'running'); assert.deepEqual(stable(w.report()), before); assert.equal(w.current(p.jobId).slots[PATHS.context].state, 'open');
    w.reopen(); w.control.inspect = () => ({ state: 'completed', binding: w.admissionRow(p.jobId).contextBinding, outcome: success(p.jobId) });
    for (let round = 0; round < 2; round++) { await w.admission.sweep({ startup: round === 0 }); assert.deepEqual(figures(w.report()), { used: 33, allotted: 51, free: 16 }); }
    assert.equal(w.admissionRow(p.jobId).state, 'settled'); assert.equal(w.current(p.jobId).state, 'live');
  });
  await t.test('an admission refusal and an acceptance hook refusal leave no allocation', async t => {
    const w = world(t, { maxRecords: 300 }), refused = w.prepare(0x11);
    w.admission.addAcceptanceHook(() => { throw Object.assign(new Error('hook-full'), { code: 'peer_store_capacity', status: 503 }); });
    await assert.rejects(w.admission.begin(refused.input), { code: 'peer_store_capacity' });
    assert.equal(w.current(refused.jobId), null); await w.admission.sweep({ startup: false }); assert.deepEqual(figures(w.report()), { used: 0, allotted: 0, free: 300 });
  });
});

test('route completion returns its slot once by revision', t => {
  for (const signature of [false, true]) {
    const w = world(t, { maxRecords: 500, commitOnSignature: signature }), routes = ENABLED[signature].slice(1), p = w.purchase(), allocation = w.allocate(p);
    routes.forEach((route, index) => w.charge(p.jobId, route, index + 1, allocation.allocationId));
    const total = routes.length * UNITS - routes.reduce((sum, _, index) => sum + index + 1, 0) + (UNITS - 0), stale = allocation.rev;
    let rev = allocation.rev, allotted = w.report().allotted; assert.equal(allotted, total);
    routes.forEach((route, index) => {
      const input = { allocationId: allocation.allocationId, route, allocationRev: rev };
      assert.equal(w.within(() => w.capacity.returnRouteSlotWithin(input)), UNITS - index - 1);
      assert.equal(w.within(() => w.capacity.returnRouteSlotWithin(input)), 0, 'a repeat'); rev += 1; allotted -= UNITS - index - 1;
      assert.equal(w.current(p.jobId).rev, rev); assert.equal(w.report().allotted, allotted); assert.equal(w.current(p.jobId).slots[route].state, 'returned');
    });
    assert.equal(w.within(() => w.capacity.returnRouteSlotWithin({ allocationId: allocation.allocationId, route: PATHS.context, allocationRev: stale })), 0, 'a stale revision');
    assert.equal(w.current(p.jobId).slots[PATHS.context].state, 'open');
    w.reopen(); assert.equal(w.current(p.jobId).rev, rev); assert.equal(w.report().used, routes.length * (routes.length + 1) / 2); assert.equal(w.report().allotted, UNITS);
    assert.equal(w.within(() => w.capacity.returnRouteSlotWithin({ allocationId: allocation.allocationId, route: routes[0], allocationRev: rev })), 0);
    if (!signature) assert.throws(() => w.within(() => w.capacity.returnRouteSlotWithin({ allocationId: allocation.allocationId, route: PATHS.commitmentSignature, allocationRev: rev })), TypeError);
  }
});

test('terminal cleanup trusts only synchronous terminal state', async t => {
  const unhandled = []; const listener = reason => unhandled.push(reason); process.on('unhandledRejection', listener); t.after(() => process.off('unhandledRejection', listener));
  const answers = { nonterminal: () => 'negotiating', unknown: () => null, unlisted: () => 'archived', throwing: () => { throw new Error('port down'); },
    rejected: () => Promise.reject(new Error('late failure')), thenable: () => ({ then(_, reject) { reject(new Error('late thenable failure')); } }),
    fulfilled: () => Promise.resolve('finalised') };
  const w = world(t, { maxRecords: 500 }), p = w.purchase(), allocation = w.allocate(p); w.charge(p.jobId, PATHS.context, 1, allocation.allocationId);
  const before = stable(w.report());
  for (const [name, answer] of Object.entries(answers)) {
    w.control.state = answer;
    w.capacity.releaseTerminalAllocations();
    assert.equal(w.current(p.jobId).state, 'live', name);
  }
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(unhandled, []); assert.deepEqual(stable(w.report()), before);
  w.control.state = ({ jobId }) => (jobId === p.jobId ? 'finalised' : null);
  w.capacity.releaseTerminalAllocations(); const released = stable(w.report());
  assert.equal(w.current(p.jobId).state, 'released'); assert.deepEqual(figures(w.report()), { used: 1, allotted: 0, free: 499 });
  for (let round = 0; round < 2; round++) { w.reopen(); w.capacity.releaseTerminalAllocations(); assert.deepEqual(stable(w.report()), released); }
  assert.notDeepEqual(released, before);
});

test('capacity-terminal-cleanup-commit-cut', t => {
  const w = world(t, { maxRecords: 300 }), p = w.purchase(), allocation = w.allocate(p); w.control.state = () => 'aborted-by-self';
  const live = stable(w.report());
  w.failCommit('before'); assert.throws(() => w.capacity.releaseTerminalAllocations(), /cut-before/);
  w.reopen(); assert.deepEqual(stable(w.report()), live); assert.equal(w.current(p.jobId).allocationId, allocation.allocationId);
  w.failCommit('after'); assert.throws(() => w.capacity.releaseTerminalAllocations());
  w.reopen(); const released = stable(w.report()); assert.equal(w.current(p.jobId).state, 'released'); assert.equal(released.allotted, 0);
  w.capacity.releaseTerminalAllocations(); assert.deepEqual(stable(w.report()), released);
});

test('capacity-bounded-exhaustion-record', t => {
  const w = world(t, { maxRecords: 80 }), p = w.purchase(); w.fill(12);
  const allocation = w.allocate(p); w.charge(p.jobId, PATHS.proposals, UNITS, allocation.allocationId);
  const record = (purchase, route = PATHS.proposals) => ({ operationId: wireOperationId({ seller: SELLER, jobId: purchase.jobId, path: route }), jobId: purchase.jobId, route, cause: 'peer_store_capacity' });
  const exhausted = () => w.report().exhausted.length, before = w.changes();
  // Classification alone writes nothing, however often it refuses.
  for (let n = 0; n < 5; n++) assert.throws(() => w.capacity.classify(classifyInput(p, PATHS.proposals, view.none)), { code: 'peer_store_capacity' });
  assert.equal(w.changes(), before); assert.equal(exhausted(), 0);
  // New, foreign and unretained input is a no-op: no buyer, window, counter, allocation or accounting row appears.
  for (const index of [0x40, 0x41, 0x42]) { const fresh = w.purchase(index, OTHER); w.capacity.recordExhaustion(record(fresh)); }
  w.capacity.recordExhaustion(record(p, PATHS.payments)); w.capacity.recordExhaustion({ ...record(p), operationId: hash('another operation') });
  assert.equal(w.changes(), before); assert.equal(exhausted(), 0);
  // The annotation's own commit failing loses only the annotation: the next refusal records it.
  w.failCommit('before'); assert.throws(() => w.capacity.recordExhaustion(record(p)), /cut-before/); assert.equal(exhausted(), 0);
  for (let n = 0; n < 5; n++) w.capacity.recordExhaustion(record(p));
  assert.equal(exhausted(), 1); const once = w.report().exhausted;
  w.reopen(); w.reopen(); assert.deepEqual(w.report().exhausted, once);
  // A released allocation, a transaction in progress and a refusal other than capacity annotate nothing.
  assert.throws(() => w.within(() => w.capacity.recordExhaustion(record(p))), TypeError); assert.throws(() => w.capacity.recordExhaustion({ ...record(p), cause: 'seller_not_ready' }), TypeError);
  w.within(() => w.capacity.releaseAllWithin({ allocationId: allocation.allocationId, allocationRev: w.capacity.allocationWithin(p.jobId).rev }));
  assert.equal(w.report().free > 0, true); assert.deepEqual(w.report().exhausted, []);
});

test('capacity-snapshot-and-cas', t => {
  const w = world(t, { maxRecords: 300 }), p = w.purchase(), allocation = w.allocate(p);
  assert.equal(Object.isFrozen(allocation), true); assert.equal(Object.isFrozen(allocation.slots), true); assert.equal(Object.isFrozen(allocation.slots[PATHS.context]), true);
  assert.throws(() => { allocation.state = 'released'; }, TypeError); assert.throws(() => { allocation.slots[PATHS.context].spent = 17; }, TypeError);
  const report = w.report(); assert.equal(Object.isFrozen(report), true); assert.equal(Object.isFrozen(report.allocations), true);
  assert.throws(() => { report.used = 0; }, TypeError); assert.throws(() => report.allocations.push({}), TypeError);
  assert.notEqual(w.current(p.jobId), w.current(p.jobId)); assert.deepEqual(w.current(p.jobId), allocation);
  // Totals follow the durable rows, never a number the caller holds.
  w.charge(p.jobId, PATHS.proposals, 3, allocation.allocationId); assert.deepEqual(figures(w.report()), { used: 3, allotted: FOUR - 3, free: 300 - FOUR });
  const stale = { allocationId: allocation.allocationId, route: PATHS.proposals, allocationRev: allocation.rev - 1, used: 0, allotted: 99 };
  const changes = w.changes(); assert.equal(w.within(() => w.capacity.returnRouteSlotWithin(stale)), 0); assert.equal(w.within(() => w.capacity.releaseAllWithin({ ...stale, route: undefined })), 0); assert.equal(w.changes(), changes);
  assert.equal(w.within(() => w.capacity.releaseAllWithin({ allocationId: hash('missing'), allocationRev: 1 })), 0);
  assert.deepEqual(figures(w.report()), { used: 3, allotted: FOUR - 3, free: 300 - FOUR });
});

test('capacity-foreign-binding-never-gets-a-slot-or-completed-bypass', t => {
  const w = world(t, { maxRecords: 80 }), p = w.purchase(); w.fill(12);
  const allocation = w.allocate(p); w.charge(p.jobId, PATHS.proposals, UNITS, allocation.allocationId); assert.equal(w.report().free, 0);
  const fresh = w.purchase(0x50);
  assert.deepEqual(w.capacity.classify(classifyInput(p, PATHS.proposals, view.completed(BINDING))), { class: 'completed-at-capacity', outcome: { status: 200, text: '{}' } });
  assert.throws(() => w.capacity.classify(classifyInput(p, PATHS.proposals, view.completed(hash('foreign')))), { code: 'peer_store_capacity' });
  assert.throws(() => w.capacity.classify(classifyInput(fresh, PATHS.proposals, view.completed(hash('foreign')))), { code: 'peer_store_capacity' });
  // Another buyer's spelling of the same job is no party of the allocation.
  assert.throws(() => w.capacity.classify(classifyInput({ ...p, buyer: `${BUYER}?jurisdiction=GB` }, PATHS.context, view.none)), { code: 'peer_store_capacity' });
  const roomy = world(t, { maxRecords: 500 }), q = roomy.purchase(), open = roomy.allocate(q);
  assert.deepEqual(roomy.capacity.classify(classifyInput(q, PATHS.proposals, view.completed(BINDING))), { class: 'general' }, 'below capacity a completed operation is general');
  assert.deepEqual(roomy.capacity.classify(classifyInput(q, PATHS.proposals, view.ended, { binding: hash('foreign') })), { class: 'general' });
  assert.deepEqual(roomy.capacity.classify(classifyInput(q, PATHS.proposals, view.ended)), { class: 'purchase-stage', allocationId: open.allocationId, allocationRev: open.rev, route: PATHS.proposals });
  assert.deepEqual(roomy.capacity.classify(classifyInput(q, PATHS.proposals, view.ended, { retainedWork: false })), { class: 'general' });
  assert.deepEqual(roomy.capacity.classify(classifyInput(q, PATHS.proposals, view.pending(T0 + 1))), { class: 'general' }, 'a live poll');
  assert.equal(roomy.capacity.classify(classifyInput(q, PATHS.proposals, view.pending(T0))).class, 'purchase-stage', 'an expired lease');
  assert.deepEqual(roomy.capacity.classify(classifyInput(q, PATHS.bundleRequest, view.none)), { class: 'general' });
});

test('capacity-restart-below-liability', t => {
  const w = world(t, { maxRecords: 300 }), p = w.purchase(), allocation = w.allocate(p); w.charge(p.jobId, PATHS.proposals, 2, allocation.allocationId); w.fill(30);
  const used = w.report().used, ids = w.report().allocations.map(entry => entry.allocationId), slots = w.current(p.jobId).slots;
  w.reopen(50); const report = w.report();
  assert.equal(report.free, 50 - used - (FOUR - 2)); assert.equal(report.free < 0, true); assert.equal(report.used, used); assert.deepEqual(report.allocations.map(entry => entry.allocationId), ids);
  assert.deepEqual(w.current(p.jobId).slots, slots); assert.equal(w.capacity.fitsNewPurchase(), false);
  refusal(() => w.allocate(w.purchase(2)), 'seller_not_ready', 503);
  assert.throws(() => w.capacity.classify(classifyInput(w.purchase(3), PATHS.proposals, view.none)), { code: 'peer_store_capacity', status: 503 });
  assert.throws(() => w.capacity.classify(classifyInput(p, PATHS.proposals, view.pending(T0 + 1))), { code: 'peer_store_capacity' });
  assert.equal(w.capacity.classify(classifyInput(p, PATHS.proposals, view.none)).class, 'purchase-stage');
  assert.equal(w.capacity.classify(classifyInput(p, PATHS.proposals, view.completed(BINDING))).class, 'completed-at-capacity');
  w.reopen(1000); assert.equal(w.report().used, used); assert.deepEqual(w.report().allocations.map(entry => entry.allocationId), ids); assert.equal(w.capacity.fitsNewPurchase(), true);
});

test('capacity-current-allocation-within-return', t => {
  const w = world(t, { maxRecords: 300 }), p = w.purchase(), allocation = w.allocate(p); w.charge(p.jobId, PATHS.proposals, 2, allocation.allocationId); w.charge(p.jobId, PATHS.payments, 5, allocation.allocationId);
  const returns = w.within(() => {
    const first = w.capacity.allocationWithin(p.jobId), one = w.capacity.returnRouteSlotWithin({ allocationId: first.allocationId, route: PATHS.proposals, allocationRev: first.rev });
    const second = w.capacity.allocationWithin(p.jobId), two = w.capacity.returnRouteSlotWithin({ allocationId: second.allocationId, route: PATHS.payments, allocationRev: second.rev });
    const stale = w.capacity.returnRouteSlotWithin({ allocationId: first.allocationId, route: PATHS.commitments, allocationRev: first.rev });
    return [one, two, stale, second.rev - first.rev];
  });
  assert.deepEqual(returns, [UNITS - 2, UNITS - 5, 0, 1]);
  w.reopen(); assert.equal(w.within(() => w.capacity.returnRouteSlotWithin({ allocationId: allocation.allocationId, route: PATHS.proposals, allocationRev: w.capacity.allocationWithin(p.jobId).rev })), 0);
  const calls = [() => w.capacity.allocateWithin(p), () => w.capacity.allocationWithin(p.jobId), () => w.capacity.returnRouteSlotWithin({ allocationId: allocation.allocationId, route: PATHS.proposals, allocationRev: 1 }),
    () => w.capacity.releaseAllWithin({ allocationId: allocation.allocationId, allocationRev: 1 })];
  for (const call of calls) assert.throws(call, TypeError);
});

test('capacity-admission-port-required', async t => {
  const w = world(t, { maxRecords: 300 }), other = world(t, { maxRecords: 300 });
  const options = capacity => ({ store: w.store, capacity, now: () => T0, ready: () => true, policy: { reserve: async () => null, release: async () => {} }, effectEvidence: async () => [],
    inspectContextOutcome: () => view.none, completeWire: () => {}, deadlines: { policyMs: 10000 } });
  const doubles = { fitsNewPurchase: () => true, allocateWithin() {} };
  for (const capacity of [undefined, null, doubles, other.capacity, { ...w.capacity }]) assert.throws(() => createContextAdmissionTransaction(options(capacity)), TypeError);
  assert.doesNotThrow(() => createContextAdmissionTransaction(options(w.capacity)));
  const p = w.prepare(); await w.admission.begin(p.input); assert.equal(w.current(p.jobId).state, 'live');
});

test('capacity-host-retained-flag-follows-the-settled-context', async t => {
  const w = world(t, { maxRecords: 500 }), p = w.prepare();
  const artifact = { jobId: p.jobId, parties: [{ role: 'buyer', primaryClaim: BUYER }, { role: 'seller', primaryClaim: SELLER }] };
  const agent = { transportAgreementOf: () => artifact, listingPin: PIN };
  const flag = (path = PATHS.proposals, purchase = { store: w.store, capacity: w.capacity }) => retainedFor(agent, { path, request: { jobId: p.jobId }, body: {} }, purchase).retained.allocated;
  assert.equal(flag(), false, 'no allocation'); await w.admission.begin(p.input);
  assert.equal(flag(), false, 'an allocation without a settled context');
  await (await w.reserveContext(p.jobId)).complete(success(p.jobId));
  assert.equal(w.admissionRow(p.jobId).contextOutcome, 'success');
  assert.equal(flag(), true); assert.equal(flag(PATHS.commitments), true); assert.equal(flag(PATHS.commitmentSignature), false, 'a route without a slot');
  assert.equal(flag(PATHS.proposals, {}), false, 'no capacity given'); assert.equal('allocated' in retainedFor(agent, { path: PATHS.state, request: { jobId: p.jobId }, body: {} }, { store: w.store, capacity: w.capacity }).retained, false);
  w.within(() => w.capacity.releaseAllWithin({ allocationId: w.capacity.allocationWithin(p.jobId).allocationId, allocationRev: w.capacity.allocationWithin(p.jobId).rev }));
  assert.equal(flag(), false, 'a released allocation');
  const refused = world(t, { maxRecords: 500 }), q = refused.prepare(); await refused.admission.begin(q.input); await (await refused.reserveContext(q.jobId)).complete(nonPass);
  assert.equal(retainedFor({ ...agent, transportAgreementOf: () => ({ ...artifact, jobId: q.jobId }) }, { path: PATHS.proposals, request: { jobId: q.jobId }, body: {} }, { store: refused.store, capacity: refused.capacity }).retained.allocated, false);
});

test('capacity-exact-parties-and-fixed-allotment', t => {
  for (const signature of [false, true]) {
    const w = world(t, { maxRecords: 500, commitOnSignature: signature }), p = w.purchase(), allocation = w.allocate(p);
    assert.equal(w.capacity.allotment(), signature ? FIVE : FOUR); assert.deepEqual(Object.keys(allocation.slots).sort(), [...ENABLED[signature]].sort());
    w.reopen(); assert.deepEqual(Object.keys(w.current(p.jobId).slots).sort(), [...ENABLED[signature]].sort());
    assert.equal(w.allocate(p).allocationId, allocation.allocationId, 'a retry adopts the same allocation');
    for (const different of [{ buyer: `${BUYER}?jurisdiction=GB` }, { seller: `${SELLER}?jurisdiction=GB` }, { listingPin: { ...PIN, contentHash: hash('another') } }]) {
      refusal(() => w.allocate({ ...p, ...different }), 'peer_operation_mismatch', 409);
      assert.equal(w.capacity.retainedAllocated({ ...p, ...different, route: PATHS.proposals, stageAuthorized: true }), false);
    }
    for (const bad of [{ jobId: 'job' }, { buyer: 7 }, { listingPin: null }]) assert.throws(() => w.allocate({ ...p, ...bad }), TypeError);
    assert.equal(w.report().allocations.length, 1);
  }
  assert.throws(() => createPurchaseCapacity({ store: {}, now: () => T0, sessionState: () => null }), TypeError);
});

async function accountedPurchase(t, maxRecords = FOUR) {
  const f = await accountingFixture(t, { leaveCapacityToTest: true });
  const capacity = createPurchaseCapacity({ store: f.store(), now: f.now, maxRecords, sessionState: sellerStoreInternals(f.store()).sessionState });
  const within = sellerStoreInternals(f.store()).transaction;
  const purchase = f.payload();
  const allocation = within(() => capacity.allocateWithin(purchase));
  const classify = () => capacity.classify(classifyInput(purchase, purchase.path, view.none));
  const input = (check = classify, reserve = async () => ({ state: 'new' })) => f.args(f.payload(), {
    checkCapacityWithin: check, checked: { reserve },
  });
  return { f, capacity, within, purchase, allocation, classify, input };
}

test('accounted purchase spending preserves its allocation and exhausts only its own slot', async t => {
  const { f, capacity, allocation, input } = await accountedPurchase(t);
  for (let n = 1; n <= UNITS; n++) {
    await f.reserve(input());
    assert.deepEqual(figures(capacity.capacityReport()), { used: n, allotted: FOUR - n, free: 0 });
    assert.equal(f.rows().at(-1).class, 'purchase');
    assert.equal(f.rows().at(-1).allocationId, allocation.allocationId);
    assert.equal(capacity.capacityReport().allocations[0].rev, allocation.rev + n);
  }
  await assert.rejects(f.reserve(input()), { code: 'peer_store_capacity', status: 503 });
  assert.equal(f.rows().length, UNITS);
  const before = stable(capacity.capacityReport());
  f.reopen();
  const reopened = createPurchaseCapacity({ store: f.store(), now: f.now, maxRecords: FOUR, sessionState: sellerStoreInternals(f.store()).sessionState });
  assert.deepEqual(stable(reopened.capacityReport()), before);
});

test('a stale allocation revision refuses an accounting charge before the journal', async t => {
  const { f, capacity, within, allocation, classify, input } = await accountedPurchase(t);
  const stale = classify();
  within(() => capacity.returnRouteSlotWithin({ allocationId: allocation.allocationId, allocationRev: allocation.rev, route: PATHS.proposals }));
  let calls = 0;
  await assert.rejects(f.reserve(input(() => stale, async () => { calls++; return { state: 'new' }; })), { code: 'peer_store_capacity', status: 503 });
  assert.equal(calls, 0); assert.equal(f.rows().length, 0); assert.equal(capacity.capacityReport().used, 0);
});

test('a failed accounting insert rolls the allocation revision and spend back', async t => {
  const { f, capacity, input } = await accountedPurchase(t);
  const before = stable(capacity.capacityReport());
  f.db.exec("CREATE TRIGGER stop_charge BEFORE INSERT ON kit_reservations BEGIN SELECT RAISE(ABORT, 'charge stopped'); END");
  await assert.rejects(f.reserve(input()), /charge stopped/);
  assert.deepEqual(stable(capacity.capacityReport()), before); f.assertEmpty();
});

test('journal refusal and result uncertainty keep the committed purchase unit after restart', async t => {
  for (const resultFailure of [false, true]) await t.test(resultFailure ? 'result write fails' : 'journal refuses', async t => {
    const { f, capacity, allocation, input } = await accountedPurchase(t);
    const refusal = Object.assign(new Error('journal refused'), { code: 'seller_effect_pending', status: 503 });
    if (resultFailure) f.db.exec("CREATE TRIGGER stop_result BEFORE UPDATE ON kit_reservations BEGIN SELECT RAISE(ABORT, 'result stopped'); END");
    await assert.rejects(f.reserve(input(undefined, async () => { throw refusal; })), error => error === refusal);
    assert.deepEqual(figures(capacity.capacityReport()), { used: 1, allotted: FOUR - 1, free: 0 });
    assert.equal(f.rows()[0].state, resultFailure ? 'reserving' : 'refused');
    assert.equal(f.rows()[0].allocationId, allocation.allocationId);
    const before = stable(capacity.capacityReport()); f.reopen();
    const reopened = createPurchaseCapacity({ store: f.store(), now: f.now, maxRecords: FOUR, sessionState: sellerStoreInternals(f.store()).sessionState });
    assert.deepEqual(stable(reopened.capacityReport()), before);
  });
});

test('a repeated nonce cannot charge the purchase slot twice', async t => {
  const { f, capacity, input } = await accountedPurchase(t);
  const request = input();
  await f.reserve(request);
  const before = stable(capacity.capacityReport());
  await assert.rejects(f.reserve(request), { code: 'peer_request_replayed', status: 409 });
  assert.deepEqual(stable(capacity.capacityReport()), before); assert.equal(f.rows().length, 1);
});

test('completed capacity classification and its caller sentinel create no accounting unit', async t => {
  const { f, capacity, purchase, input } = await accountedPurchase(t);
  const completion = capacity.classify(classifyInput(purchase, purchase.path, view.completed(BINDING)));
  assert.equal(completion.class, 'completed-at-capacity');
  const sentinel = new Error('completed operation');
  const before = stable(capacity.capacityReport()); let journalCalls = 0;
  await assert.rejects(f.reserve(input(() => { throw sentinel; }, async () => { journalCalls++; return { state: 'new' }; })), error => error === sentinel);
  assert.deepEqual(stable(capacity.capacityReport()), before); f.assertEmpty(); assert.equal(journalCalls, 0);
});

// Ordinary routes run on signed requests and the accounting fixture's real wire journal;
// context runs on a world's admission transaction, whose job lease the coordinator borrows.
const settle = () => new Promise(resolve => setImmediate(resolve));
const rejects = (promise, code, status) => assert.rejects(promise, error => error.code === code && (status === undefined || error.status === status));
const operationOf = jobId => wireOperationId({ seller: fixture.SELLER.claim, jobId, path: PATHS.proposals });

async function coordination(t, { maxRecords = 1000 } = {}, storeOptions = {}) {
  const control = { state: () => null };
  const f = await fixture.accountingFixture(t, { leaveCapacityToTest: true, contextSessionState: input => control.state(input), ...storeOptions }), w = { f, control, inspections: 0, limit: maxRecords };
  w.build = () => {
    const store = f.store();
    w.internals = sellerStoreInternals(store);
    w.capacity = createPurchaseCapacity({ store, now: f.now, maxRecords: w.limit, sessionState: w.internals.sessionState });
    w.coordinator = createReservationCoordinator({ accounting: store.reservationAccounting, capacity: w.capacity,
      inspectOperation: target => { w.inspections++; return inspectWireOperation(f.journal, target); } });
  };
  w.reopen = (limit = w.limit) => { w.limit = limit; f.reopen(); w.build(); };
  w.allocate = jobId => w.internals.transaction(() => w.capacity.allocateWithin({ jobId, buyer: fixture.BUYER.claim, seller: fixture.SELLER.claim, listingPin: fixture.PIN }));
  w.request = async (change = {}, extra = {}) => ({ ...(await f.admit(f.payload(change))), newJob: false, contextStart: false, paymentTx: null, retainedWork: true, ...extra });
  w.reserve = (input, ownership) => w.coordinator.reserveCoordinated(input, ownership);
  w.classes = () => f.rows().map(row => row.class);
  w.spent = jobId => w.capacity.capacityReport().allocations.find(allocation => allocation.jobId === jobId).slots[PATHS.proposals].spent;
  w.counts = () => Object.fromEntries(f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map(({ name }) => [name, f.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));
  w.build();
  return w;
}

// A request whose reserve() stops at a barrier, so a test holds its owner inside the mutex; `outcome` is what reserve() does after the barrier opens.
function paused(input, outcome = () => input.checked.reserve()) {
  let reach, open;
  const reached = new Promise(resolve => { reach = resolve; }), opened = new Promise(resolve => { open = resolve; });
  return { reached, open, input: { ...input, checked: { reserve: async () => { reach(); await opened; return outcome(); } } } };
}

// The coordinator over a world's accounting, capacity and admission transaction; `control.operation` answers the next inspection.
function withCoordinator(w) {
  w.inspections = 0; w.nonces = 0; w.control.operation = () => view.none; w.control.payloads = new Map();
  w.coordinator = createReservationCoordinator({ accounting: w.store.reservationAccounting, capacity: w.capacity, admissionTransaction: w.admission,
    inspectOperation: target => { w.inspections++; return w.control.operation(target); } });
  w.contextInput = (p, path = PATHS.context) => {
    const payload = { version: '1', kind: 'request', method: 'POST', path, bodyHash: hash('{}'), jobId: p.jobId, buyer: p.input.buyer, seller: SELLER, listingPin: PIN,
      agreementHash: hash('agreement'), nonce: hash(`nonce-${++w.nonces}`).slice(0, 32), expiresAt: w.control.clock + 30000, profile: PROFILE };
    const operationId = wireOperationId(payload);
    w.control.payloads.set(operationId, payload);
    return { checked: { reserve: async () => Object.freeze({ state: 'new', operationId, attempt: 0, leaseUntil: w.control.clock + 300000 }) },
      payload, route: path, operationId, newJob: false, contextStart: true, paymentTx: null, keepProfile: PROFILE, retainedWork: true };
  };
  w.begin = p => w.admission.begin(p.input);
  w.coordinatedContext = p => w.admission.reserveContext(p.jobId, lease => w.coordinator.reserveCoordinated(w.contextInput(p), { jobLease: lease }));
  w.livePending = () => { w.control.operation = target => ({ state: 'pending', binding: wireOperationBinding(target), attempt: 0, requestHash: hash('request'), leaseUntil: w.control.clock + 300000 }); };
  return w;
}

test('admission allots 68 units and the first context reservation spends one from the allocation', async t => {
  const w = withCoordinator(world(t, { maxRecords: 300 })), p = w.prepare();
  await w.begin(p);
  assert.equal(w.report().allotted, FOUR); assert.equal(w.current(p.jobId).state, 'live');
  assert.equal((await w.coordinatedContext(p)).effect.state, 'new');
  assert.deepEqual(figures(w.report()), { used: 1, allotted: FOUR - 1, free: 300 - 1 - (FOUR - 1) });
  const rows = w.db().prepare('SELECT class, allocationId, route FROM kit_reservations').all().map(row => ({ ...row }));
  assert.deepEqual(rows, [{ class: 'purchase', allocationId: w.current(p.jobId).allocationId, route: PATHS.context }]);
});

test('a poll inside a live context lease at full capacity is refused with no row or file and spends no purchase unit', async t => {
  const w = withCoordinator(world(t, { maxRecords: FOUR })), p = w.prepare();
  await w.begin(p); await w.coordinatedContext(p);
  const files = readdirSync(w.directory), allocation = w.current(p.jobId);
  w.livePending();
  await rejects(w.coordinatedContext(p), 'peer_store_capacity', 503);
  assert.equal(w.db().prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n, 1);
  assert.deepEqual(w.current(p.jobId), allocation); assert.deepEqual(readdirSync(w.directory), files);
});

test('raising `maxRecords` and restarting admits the exhausted operation as general, with no file deleted', async t => {
  const w = await coordination(t, { maxRecords: FOUR }); w.allocate(fixture.JOB);
  assert.equal((await w.reserve(await w.request({}, { newJob: true }))).state, 'new');
  await rejects(w.reserve(await w.request()), 'peer_store_capacity', 503);
  const files = w.f.files();
  w.reopen(1000);
  await rejects(w.reserve(await w.request()), 'seller_effect_pending', 503);
  assert.deepEqual(w.classes(), ['purchase', 'general']);
  for (const name of files) assert.ok(w.f.files().includes(name), name);
});

test("an unrelated purchase's reservations and polls never touch another purchase's units", async t => {
  const w = await coordination(t); w.allocate(fixture.JOB); w.allocate(fixture.JOB2);
  const untouched = JSON.stringify(w.capacity.capacityReport().allocations.find(allocation => allocation.jobId === fixture.JOB));
  assert.equal((await w.reserve(await w.request({ jobId: fixture.JOB2 }, { newJob: true }))).state, 'new');
  await rejects(w.reserve(await w.request({ jobId: fixture.JOB2 })), 'seller_effect_pending', 503);
  w.f.setTime(fixture.T0 + 300001);
  assert.equal((await w.reserve(await w.request({ jobId: fixture.JOB2 }))).state, 'recover');
  assert.equal(JSON.stringify(w.capacity.capacityReport().allocations.find(allocation => allocation.jobId === fixture.JOB)), untouched);
  assert.ok(w.f.rows().every(row => row.jobId === fixture.JOB2));
  assert.equal(w.spent(fixture.JOB2), 2);
});

test('requests competing for one operation wait for the paused reservation and are then classified after it, taking no unit', async t => {
  const w = await coordination(t, { maxRecords: FOUR }); w.allocate(fixture.JOB);
  const owner = paused(await w.request({}, { newJob: true })), first = w.reserve(owner.input);
  await owner.reached;
  const rivals = [await w.request(), await w.request()].map(input => rejects(w.reserve(input), 'peer_store_capacity', 503));
  await settle();
  assert.equal(w.inspections, 1, 'the rivals have not inspected'); assert.equal(w.f.rows().length, 1);
  owner.open();
  assert.equal((await first).state, 'new'); await Promise.all(rivals);
  assert.equal(w.inspections, 3); assert.deepEqual(w.classes(), ['purchase']); assert.equal(w.spent(fixture.JOB), 1);
  assert.equal(w.f.nonces().length, 1, 'a refused rival journals nothing');
  assert.deepEqual(w.capacity.capacityReport().exhausted.map(record => record.route), [PATHS.proposals]);
});

test('after the lease runs out, one recovery spends from the slot and its competitors are refused', async t => {
  const w = await coordination(t, { maxRecords: FOUR }); w.allocate(fixture.JOB);
  assert.equal((await w.reserve(await w.request({}, { newJob: true }))).state, 'new');
  w.f.setTime(fixture.T0 + 300001);
  const owner = paused(await w.request()), recovery = w.reserve(owner.input);
  await owner.reached;
  const rivals = [await w.request(), await w.request()].map(input => rejects(w.reserve(input), 'peer_store_capacity', 503));
  await settle(); assert.equal(w.inspections, 2);
  owner.open();
  assert.equal((await recovery).state, 'recover'); await Promise.all(rivals);
  assert.deepEqual(w.classes(), ['purchase', 'purchase']); assert.equal(w.spent(fixture.JOB), 2);
});

test('with general capacity available, competitors are charged general and answered pending', async t => {
  const w = await coordination(t); w.allocate(fixture.JOB);
  const owner = paused(await w.request({}, { newJob: true })), first = w.reserve(owner.input);
  await owner.reached;
  const rivals = [await w.request(), await w.request()].map(input => rejects(w.reserve(input), 'seller_effect_pending', 503));
  await settle(); assert.equal(w.inspections, 1);
  owner.open();
  assert.equal((await first).state, 'new'); await Promise.all(rivals);
  assert.deepEqual(w.classes(), ['purchase', 'general', 'general']); assert.equal(w.spent(fixture.JOB), 1);
});

test("repeated recoveries use the slot's sixteen attempts and the seventeenth unit meets the journal's unresolved answer", async t => {
  const w = await coordination(t); w.allocate(fixture.JOB);
  for (let attempt = 0; attempt < 17; attempt++) {
    w.f.setTime(fixture.T0 + attempt * 300001);
    const request = await w.request({}, { newJob: attempt === 0 });
    if (attempt < 16) assert.equal((await w.reserve(request)).state, attempt === 0 ? 'new' : 'recover', `attempt ${attempt}`);
    else await rejects(w.reserve(request), 'seller_effect_unresolved', 500);
  }
  assert.equal(w.spent(fixture.JOB), 17); assert.equal(w.classes().filter(name => name === 'purchase').length, 17);
  w.f.setTime(fixture.T0 + 17 * 300001);
  await rejects(w.reserve(await w.request()), 'seller_effect_unresolved', 500);
  assert.equal(w.classes().at(-1), 'general', 'the spent slot is not replenished');
});

test('waiters time out at 10,000 ms with nothing written; the owner keeps the mutex until its reservation settles; a late acquisition is released', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await coordination(t); w.allocate(fixture.JOB);
  const owner = paused(await w.request({}, { newJob: true })), first = w.reserve(owner.input);
  await owner.reached;
  const outward = assert.rejects(boundedCall(() => first, { timeoutMs: 10000 }), isBoundedCallTimeout);
  const files = w.f.files(), counts = w.counts();
  let outcome = null;
  const waiter = w.reserve(await w.request()).then(() => 'granted', error => { outcome = error; return 'refused'; });
  t.mock.timers.tick(9999); await settle(); assert.equal(outcome, null, 'still waiting at 9,999 ms');
  t.mock.timers.tick(1);
  await outward;
  assert.equal(w.f.rows()[0].state, 'reserving', 'the caller timeout leaves the underlying reservation owned');
  assert.equal(await waiter, 'refused'); assert.equal(outcome.code, 'seller_effect_pending'); assert.equal(outcome.status, 503); assert.equal(outcome.cause.name, 'TimeoutError');
  assert.equal(w.inspections, 1); assert.deepEqual(w.f.files(), files); assert.deepEqual(w.counts(), counts);
  const behind = rejects(w.reserve(await w.request()), 'seller_effect_pending', 503);
  await settle(); assert.equal(w.inspections, 1, 'the owner still holds the mutex');
  owner.open();
  assert.equal((await first).state, 'new'); await behind;
  assert.equal(w.inspections, 2, 'the timed-out waiter never inspected and its late acquisition was released');
  assert.deepEqual(w.classes(), ['purchase', 'general']);
});

test('reservations for different operations do not block each other', async t => {
  const w = await coordination(t);
  const owner = paused(await w.request({}, { newJob: true })), first = w.reserve(owner.input);
  await owner.reached;
  assert.equal((await w.reserve(await w.request({ jobId: fixture.JOB2 }, { newJob: true, retainedWork: false }))).state, 'new');
  assert.equal(w.inspections, 2);
  owner.open(); assert.equal((await first).state, 'new');
});

test('the coordinator and terminal observer refuse without writes when the guard is off', () => {
  const probe = fileURLToPath(new URL('./helpers/coordinator-guard-off-probe.mjs', import.meta.url));
  const kept = (process.env.NODE_OPTIONS ?? '').split(' ').filter(option => option !== '' && !option.includes('kit-guard-fixture.mjs')).join(' ');
  const child = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: kept } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { code: 'kit_operation_guard_off', written: 0, portCalls: 0, terminalSession: 'kit_operation_guard_off', observed: 'finalised', closures: 0 });
});

test('with `maxRecords` small and `free` 0, 100 fresh requests from 100 distinct buyers each refuse `peer_store_capacity` and leave every count at its pre-request value, also after two restarts', async t => {
  const w = await coordination(t, { maxRecords: 10 });
  for (let n = 0; n < 10; n++) {
    const request = await w.request({}, { retainedWork: false });
    if (n === 0) await w.reserve(request);
    else await rejects(w.reserve(request), 'seller_effect_pending', 503);
  }
  assert.equal(w.capacity.capacityReport().free, 0);
  const before = w.counts(), files = w.f.files();
  const flood = async round => {
    for (let n = 0; n < 100; n++) {
      const jobId = generateCanonicalJobId({ timestamp: T0, entropy: Buffer.from([round, n, 1, 2, 3, 4, 5, 6, 7, 8]) });
      const payload = w.f.payload({ jobId, buyer: claim(`flood-${round}-${n}`) });
      await rejects(w.reserve({ checked: { reserve: async () => assert.fail('a refused request reaches the journal') }, payload, route: payload.path, operationId: wireOperationId(payload),
        newJob: true, contextStart: false, paymentTx: null, keepProfile: FIXTURE_PROFILE, retainedWork: false }), 'peer_store_capacity', 503);
    }
    assert.deepEqual(w.counts(), before, `round ${round}`); assert.deepEqual(w.f.files(), files, `round ${round}`);
    assert.ok(w.counts().kit_reservations <= 10);
  };
  await flood(0);
  w.reopen(); w.reopen(); await flood(1);
});

test('refused polls fill the store only until their requests expire, then a repeat and a new job are admitted again', async t => {
  const w = await coordination(t, { maxRecords: 5 });
  for (let n = 0; n < 5; n++) {
    const request = await w.request({}, { retainedWork: false });
    if (n === 0) await w.reserve(request);
    else await rejects(w.reserve(request), 'seller_effect_pending', 503);
  }
  assert.equal(w.capacity.capacityReport().free, 0);
  await rejects(w.reserve(await w.request({}, { retainedWork: false })), 'peer_store_capacity', 503);
  w.f.setTime(fixture.T0 + 60001);
  assert.equal(w.capacity.capacityReport().used, 1);
  await rejects(w.reserve(await w.request({}, { retainedWork: false })), 'seller_effect_pending', 503);
  const jobId = generateCanonicalJobId({ timestamp: T0, entropy: Buffer.alloc(10, 9) }), payload = w.f.payload({ jobId, buyer: claim('new-job-buyer') });
  const effect = await w.reserve({ checked: { reserve: async () => ({ state: 'new' }) }, payload, route: payload.path, operationId: wireOperationId(payload),
    newJob: true, contextStart: false, paymentTx: null, keepProfile: FIXTURE_PROFILE, retainedWork: false });
  assert.equal(effect.state, 'new');
});

// An operation completed through the coordinator, then the store reopened at `limit` (FOUR leaves `free` 0).
async function completedOperation(t, limit) {
  const w = await coordination(t); w.allocate(fixture.JOB);
  completeWireEffect(w.f.journal, await w.reserve(await w.request()), { status: 200, text: '{"status":"delivered"}' });
  w.reopen(limit);
  return w;
}
// One signed retry of the operation, admitted again for each reservation.
const signedRetry = (w, change = {}) => {
  const p = w.f.payload(change);
  return async () => w.reserve({ ...(await w.f.admit(p)), paymentTx: null, retainedWork: true });
};

test('a completed operation at capacity refuses the same signed retry twice with no row, file or exhaustion record; with room the second is `peer_request_replayed`', async t => {
  await t.test('at capacity', async st => {
    const w = await completedOperation(st, FOUR);
    assert.equal(w.capacity.capacityReport().free, 0);
    const rows = w.f.rows().length, files = w.f.files(), retry = signedRetry(w);
    await rejects(retry(), 'peer_store_capacity', 503);
    await rejects(retry(), 'peer_store_capacity', 503);
    assert.equal(w.f.rows().length, rows); assert.deepEqual(w.f.files(), files); assert.deepEqual(w.capacity.capacityReport().exhausted, []);
  });
  await t.test('with room', async st => {
    const retry = signedRetry(await completedOperation(st, 1000));
    assert.equal((await retry()).state, 'completed');
    await rejects(retry(), 'peer_request_replayed', 409);
  });
});

test('a completed context operation at capacity is refused `peer_store_capacity` under the borrowed job lease, with no row, file or exhaustion record', async t => {
  const w = withCoordinator(world(t, { maxRecords: FOUR })), p = w.prepare();
  await w.begin(p); await w.coordinatedContext(p);
  assert.equal(w.report().free, 0);
  const files = readdirSync(w.directory), allocation = w.current(p.jobId);
  w.control.operation = target => view.completed(wireOperationBinding(target));
  await rejects(w.coordinatedContext(p), 'peer_store_capacity', 503);
  assert.equal(w.db().prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n, 1);
  assert.deepEqual(w.current(p.jobId), allocation); assert.deepEqual(readdirSync(w.directory), files); assert.deepEqual(w.report().exhausted, []);
});

test('a completed operation at capacity refuses a retry that expired before it was reserved; with room it is `peer_expired`', async t => {
  for (const [name, limit, code, status] of [['at capacity', FOUR, 'peer_store_capacity', 503], ['with room', 1000, 'peer_expired', 408]]) {
    await t.test(name, async st => {
      const w = await completedOperation(st, limit);
      const input = { ...(await w.f.admit(w.f.payload({ expiresAt: fixture.T0 + 5000 }))), paymentTx: null, retainedWork: true };
      // Eight seconds pass between admission and the reservation, on the wall clock and on the monotonic clock the wire re-checks with.
      w.f.setTime(fixture.T0 + 8000); performance.now.mock.mockImplementation(() => 8000);
      await rejects(w.reserve(input), code, status);
    });
  }
});

test('reservation-exhaustion-record-failure-keeps-the-refusal-as-cause', async t => {
  const w = await coordination(t, { maxRecords: FOUR }); w.allocate(fixture.JOB);
  assert.equal((await w.reserve(await w.request({}, { newJob: true }))).state, 'new');
  const cut = new Error('TEST exhaustion record failed');
  const failing = createReservationCoordinator({ accounting: w.f.store().reservationAccounting, inspectOperation: target => inspectWireOperation(w.f.journal, target),
    capacity: { classify: input => w.capacity.classify(input), recordExhaustion: () => { throw cut; }, terminalSession: jobId => w.capacity.terminalSession(jobId),
      flushTerminalObservations: () => w.capacity.flushTerminalObservations() } });
  for (let refusal = 0; refusal < 2; refusal++) {
    await assert.rejects(failing.reserveCoordinated(await w.request()), error => error === cut && error.cause?.code === 'peer_store_capacity' && error.cause.status === 503);
  }
  assert.equal(w.f.rows().length, 1, 'the refusals charged nothing'); assert.deepEqual(w.capacity.capacityReport().exhausted, []);
});

test('reservation-owner-rejection-releases-mutex', async t => {
  const cut = new Error('TEST reserve failed');
  const cases = [
    ['a reserve that throws', async () => { throw cut; }, false, reason => assert.equal(reason, cut), 'reserving', null],
    ['a definite refusal', async () => { throw new SellerTransportError('peer_operation_mismatch', 409); }, false, reason => assert.equal(reason.code, 'peer_operation_mismatch'), 'refused', 'peer_operation_mismatch'],
    ['a failed result write', undefined, true, reason => assert.match(reason.message, /TEST result write failed/), 'reserving', null],
  ];
  for (const [label, outcome, failWrite, check, state, code] of cases) {
    const w = await coordination(t); w.allocate(fixture.JOB);
    const owner = paused(await w.request({}, { newJob: true }), outcome), first = w.reserve(owner.input);
    await owner.reached;
    const rival = w.reserve(await w.request());
    await settle(); assert.equal(w.inspections, 1, label);
    if (failWrite) w.f.db.exec("CREATE TRIGGER stop_result BEFORE UPDATE ON kit_reservations BEGIN SELECT RAISE(ABORT, 'TEST result write failed'); END");
    owner.open();
    const [owned, queued] = await Promise.allSettled([first, rival]);
    assert.equal(owned.status, 'rejected', label); check(owned.reason);
    assert.notEqual(queued.status, undefined); assert.equal(w.inspections, 2, `${label}: the queued request got the mutex`);
    const [spent] = w.f.rows();
    assert.deepEqual({ class: spent.class, state: spent.state, code: spent.code }, { class: 'purchase', state, code }, `${label}: the spent unit stays charged`);
  }
});

test('reservation-mutex-owner-crash-reclassification', async t => {
  for (const journaled of [false, true]) {
    const w = await coordination(t); w.allocate(fixture.JOB);
    const request = await w.request();
    const source = `
      import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
      import { openWireRequestJournal, inspectWireOperation, wireOperationBinding, wireRequestHash } from '@kynesyslabs/dacs/wire';
      import { journalStore, reserveEffect } from ${JSON.stringify(new URL('../../../dist/wire/journal.js', import.meta.url).href)};
      import { createSellerTransportStore, sellerStoreInternals } from ${JSON.stringify(new URL('../src/dacs/seller-transport-auth.mjs', import.meta.url).href)};
      import { createPurchaseCapacity } from ${JSON.stringify(new URL('../src/dacs/seller-purchase-capacity.mjs', import.meta.url).href)};
      import { createReservationCoordinator } from ${JSON.stringify(new URL('../src/dacs/seller-reservation-accounting.mjs', import.meta.url).href)};
      const { path, directory, payload, at, journaled } = JSON.parse(process.argv[1]);
      const now = () => at;
      const journal = openWireRequestJournal(directory, { clock: now, leaseMs: 300000 });
      const store = createSellerTransportStore({ path, now, wireOperationView: target => inspectWireOperation(journal, target) });
      const capacity = createPurchaseCapacity({ store, now, sessionState: sellerStoreInternals(store).sessionState });
      const coordinator = createReservationCoordinator({ accounting: store.reservationAccounting, capacity, inspectOperation: target => inspectWireOperation(journal, target) });
      const checked = { reserve: async () => {
        if (journaled) reserveEffect(journalStore(journal), {
          key: sha256Hex(canonicalize({ buyer: payload.buyer, seller: payload.seller, profile: payload.profile, nonce: payload.nonce })),
          seller: payload.seller, jobId: payload.jobId, path: payload.path, binding: wireOperationBinding(payload), requestHash: wireRequestHash(payload)
        });
        process.kill(process.pid, 'SIGKILL');
        return new Promise(() => {});
      } };
      await coordinator.reserveCoordinated({ ...${JSON.stringify({ ...request, checked: undefined })}, checked });
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, JSON.stringify({ path: w.f.path, directory: w.f.journalDir,
      payload: request.payload, at: w.f.now(), journaled })], { encoding: 'utf8', timeout: 30000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    w.reopen();
    if (journaled) await rejects(w.reserve(await w.request()), 'seller_effect_pending', 503);
    else assert.equal((await w.reserve(await w.request())).state, 'new');
    assert.equal(w.inspections, 1, 'the new mutex owner reads the durable journal');
    assert.deepEqual(w.classes(), journaled ? ['purchase', 'general'] : ['purchase', 'purchase']);
    assert.equal(w.f.rows()[0].state, 'reserving', 'the killed owner retains its committed unit');
  }
});

test('reservation-context-borrowed-lease', async t => {
  const w = withCoordinator(world(t, { maxRecords: 300 })), p = w.prepare(), mutex = w.admission.jobEffectMutex(p.jobId);
  await w.begin(p);
  let queued, acquired = null;
  await w.admission.reserveContext(p.jobId, async lease => {
    const effect = await w.coordinator.reserveCoordinated(w.contextInput(p), { jobLease: lease });
    queued = mutex.acquire().then(next => { acquired = next; });
    await settle(); assert.equal(acquired, null, 'the coordinator did not release the borrowed lease');
    return effect;
  });
  await queued; assert.notEqual(acquired, null); acquired.release();
  const rows = () => w.db().prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n, before = { rows: rows(), inspections: w.inspections };
  const released = await mutex.acquire(); released.release();
  const foreign = await w.admission.jobEffectMutex(job(0x77)).acquire();
  const otherInstance = await world(t).admission.jobEffectMutex(p.jobId).acquire();
  const borrowed = [undefined, {}, { jobLease: undefined }, { jobLease: Object.freeze({ release() {} }) }, { jobLease: released }, { jobLease: foreign }, { jobLease: otherInstance }];
  for (const ownership of borrowed) await assert.rejects(w.coordinator.reserveCoordinated(w.contextInput(p), ownership), TypeError);
  foreign.release(); otherInstance.release();
  const lease = await mutex.acquire();
  await assert.rejects(w.coordinator.reserveCoordinated(w.contextInput(p, PATHS.proposals), { jobLease: lease }), TypeError, 'an ordinary route borrows nothing');
  const bare = createReservationCoordinator({ accounting: w.store.reservationAccounting, capacity: w.capacity, inspectOperation: () => assert.fail('inspected') });
  await assert.rejects(bare.reserveCoordinated(w.contextInput(p), { jobLease: lease }), TypeError, 'no admission transaction, no context');
  lease.release();
  assert.deepEqual({ rows: rows(), inspections: w.inspections }, before);
});

test('reservation-lock-map-cleanup', async t => {
  const w = await coordination(t), ids = new Set([operationOf(fixture.JOB), operationOf(fixture.JOB2)]), events = [];
  const set = Map.prototype.set, remove = Map.prototype.delete;
  t.mock.method(Map.prototype, 'set', function (key, value) { if (ids.has(key)) events.push(['set', key]); return set.call(this, key, value); });
  t.mock.method(Map.prototype, 'delete', function (key) { if (ids.has(key)) events.push(['delete', key]); return remove.call(this, key); });
  const of = id => events.filter(([, key]) => key === id).map(([kind]) => kind);
  const owner = paused(await w.request({}, { newJob: true })), first = w.reserve(owner.input);
  await owner.reached;
  const waiters = [await w.request(), await w.request()].map(input => w.reserve(input).catch(error => error.code));
  assert.equal(of(operationOf(fixture.JOB)).at(-1), 'set', 'busy while an owner and waiters remain');
  const other = await w.reserve(await w.request({ jobId: fixture.JOB2 }, { newJob: true, retainedWork: false }));
  await settle(); assert.equal(other.state, 'new'); assert.deepEqual(of(operationOf(fixture.JOB2)).at(-1), 'delete', 'an idle operation leaves no entry');
  owner.open(); await first; await Promise.all(waiters); await settle();
  assert.equal(of(operationOf(fixture.JOB)).filter(kind => kind === 'delete').length, 1, 'removed once, after the last waiter');
  assert.equal(of(operationOf(fixture.JOB)).at(-1), 'delete');
});

// The terminal closure, the gate list and the observation adapter. Closure and release are the store's metadata, counted apart
// from the work's own writes. Worlds here have a real store, capacity and admission transaction; the source is `control.state`.
const TERMINAL_NAMES = [...TERMINAL_CONTEXT_STATES];
const ALL_ROUTES = [PATHS.context, PATHS.proposals, PATHS.commitments, PATHS.commitmentSignature, PATHS.payments];
const SESSION_ANSWERS = {
  null: () => null, nonterminal: () => 'negotiating', 'agent stage': () => 'proposal-open', throwing: () => { throw new Error('TEST port down'); },
  'fulfilled promise': () => Promise.resolve('finalised'), 'rejected promise': () => Promise.reject(new Error('TEST late failure')),
  'rejecting thenable': () => ({ then(_, reject) { reject(new Error('TEST thenable failure')); } }),
  'throwing then getter': () => ({ get then() { throw new Error('TEST then getter'); } }),
};
const unavailableAnswer = label => !['null', 'nonterminal', 'agent stage'].includes(label);
const SESSION_UNAVAILABLE = { code: 'session_admission_unavailable', status: 503 };
const CLOSURES_SQL = 'SELECT jobId, state, source FROM kit_terminal_closures ORDER BY jobId';
const closures = w => w.db().prepare(CLOSURES_SQL).all().map(row => ({ ...row }));
// A second connection sees only what has committed.
const durableClosures = w => {
  const reader = new Database(w.path, { readonly: true });
  try { return reader.prepare(CLOSURES_SQL).all().map(row => ({ ...row })); } finally { reader.close(); }
};
const closureOf = (jobId, state = 'finalised', source = 'session-observer') => [{ jobId, state, source }];
const onlyJob = (jobId, answer) => input => (input.jobId === jobId ? answer(input) : null);
const failWrites = (w, table, event, message) => w.db().exec(`CREATE TRIGGER TEST_cut BEFORE ${event} ON ${table} BEGIN SELECT RAISE(ABORT, '${message}'); END`);
const healWrites = w => w.db().exec('DROP TRIGGER TEST_cut');
const spentState = w => ({ used: w.report().used, files: readdirSync(w.directory).sort() });
const watchUnhandled = t => { const seen = [], listener = reason => seen.push(reason); process.on('unhandledRejection', listener); t.after(() => process.off('unhandledRejection', listener)); return seen; };

// A world whose job `p` has its K1 admission and allocation, with the coordinator over its admission transaction.
async function coordinated(t, options = {}) {
  const w = withCoordinator(world(t, { maxRecords: 500, commitOnSignature: true, ...options })), p = w.prepare();
  await w.begin(p);
  return { w, p };
}
// One request on `route` for `p`; the context route runs under the admission transaction's job lease.
const attemptRoute = (w, p, route, input = w.contextInput(p, route)) => (route === PATHS.context
  ? w.admission.reserveContext(p.jobId, lease => w.coordinator.reserveCoordinated(input, { jobLease: lease }))
  : w.coordinator.reserveCoordinated(input));
function countedRequest(w, p, route) {
  const calls = { reserve: 0 }, input = w.contextInput(p, route), reserve = input.checked.reserve;
  input.checked.reserve = async () => { calls.reserve++; return reserve(); };
  return { input, calls };
}
const restart = w => { w.reopen(); withCoordinator(w); };

test('terminal closures and allocation releases survive restarts for every terminal state', async t => {
  const unhandled = watchUnhandled(t), answers = Object.values(SESSION_ANSWERS);
  for (const [index, name] of TERMINAL_NAMES.entries()) {
    const w = world(t, { maxRecords: 500 }), p = w.purchase(), allocation = w.allocate(p); w.charge(p.jobId, PATHS.context, 1, allocation.allocationId);
    let reads = 0; w.control.state = () => { reads++; return name; };
    assert.deepEqual(closures(w), []);
    w.capacity.releaseTerminalAllocations();
    assert.deepEqual(closures(w), closureOf(p.jobId, name, 'cleanup'), name);
    assert.equal(w.current(p.jobId).state, 'released'); assert.deepEqual(figures(w.report()), { used: 1, allotted: 0, free: 499 });
    const settled = stable(w.report()), readsAfterClosure = reads;
    w.capacity.releaseTerminalAllocations();
    assert.deepEqual(w.internals.terminalSession(p.jobId), { terminal: true, state: name });
    assert.deepEqual(stable(w.report()), settled); assert.equal(closures(w).length, 1); assert.equal(reads, readsAfterClosure, 'a closure answers without the port');
    for (const answer of [answers[index % answers.length], answers[(index + 3) % answers.length]]) {
      w.control.state = answer; w.reopen();
      assert.deepEqual(w.internals.terminalSession(p.jobId), { terminal: true, state: name }); w.capacity.releaseTerminalAllocations();
      assert.deepEqual(closures(w), closureOf(p.jobId, name, 'cleanup')); assert.deepEqual(stable(w.report()), settled);
    }
  }
  const settledRow = world(t, { maxRecords: 500 }), q = settledRow.prepare();
  await settledRow.admission.begin(q.input); await (await settledRow.reserveContext(q.jobId)).complete(success(q.jobId));
  assert.equal(settledRow.admissionRow(q.jobId).contextOutcome, 'success');
  settledRow.control.state = () => 'finalised'; settledRow.capacity.releaseTerminalAllocations();
  settledRow.control.state = () => null; settledRow.reopen();
  assert.deepEqual(settledRow.internals.terminalSession(q.jobId), { terminal: true, state: 'finalised' }); assert.equal(settledRow.admissionRow(q.jobId).contextOutcome, 'success');
  for (const [label, answer] of Object.entries(SESSION_ANSWERS)) {
    const w = world(t, { maxRecords: 500 }), p = w.purchase(); w.allocate(p); w.control.state = answer;
    for (let restarts = 0; restarts < 2; restarts++) {
      w.reopen();
      if (unavailableAnswer(label)) {
        assert.throws(() => w.internals.terminalSession(p.jobId), SESSION_UNAVAILABLE, label);
        w.capacity.releaseTerminalAllocations();
      } else {
        assert.deepEqual(w.internals.terminalSession(p.jobId), { terminal: false, state: null }, label);
        w.capacity.releaseTerminalAllocations();
      }
    }
    await settle(); assert.deepEqual(durableClosures(w), [], label); assert.equal(w.current(p.jobId).state, 'live', label);
  }
  assert.deepEqual(unhandled, []);
});

test('closure and allocation release commit together across crash cuts', t => {
  for (const cut of ['before', 'after']) {
    const w = world(t, { maxRecords: 500 }), p = w.purchase(), live = w.allocate(p); w.control.state = () => 'finalised';
    w.failCommit(cut);
    assert.throws(() => w.capacity.releaseTerminalAllocations(), undefined, cut);
    w.reopen();
    if (cut === 'before') {
      assert.deepEqual(durableClosures(w), []); assert.deepEqual(w.current(p.jobId), live);
      w.capacity.releaseTerminalAllocations();
    }
    assert.deepEqual(durableClosures(w), closureOf(p.jobId, 'finalised', 'cleanup'), cut); assert.equal(w.current(p.jobId).state, 'released', cut);
    assert.equal(w.db().prepare('SELECT COUNT(*) AS n FROM kit_terminal_closures').get().n, 1);
  }
});

test('terminal sessions refuse new effects while exact completed operations remain replayable', async t => {
  for (const route of ALL_ROUTES) for (const mode of ['closed', 'effect-path']) {
    const { w, p } = await coordinated(t), label = `${route} ${mode}`;
    w.control.state = onlyJob(p.jobId, () => 'aborted-by-other');
    if (mode === 'closed') { w.capacity.releaseTerminalAllocations(); assert.equal(w.current(p.jobId).state, 'released', label); } else assert.equal(w.current(p.jobId).state, 'live', label);
    const { input, calls } = countedRequest(w, p, route), before = spentState(w);
    await rejects(attemptRoute(w, p, route, input), 'context_session_terminal', 409);
    assert.deepEqual(durableClosures(w), closureOf(p.jobId, 'aborted-by-other', mode === 'closed' ? 'cleanup' : 'effect-path'), label);
    assert.equal(w.current(p.jobId).state, 'released', label); assert.deepEqual(spentState(w), before, label);
    assert.equal(calls.reserve, 0, label); assert.equal(w.inspections, 1, label);
    for (const restarted of [false, true]) {
      if (restarted) { w.control.state = () => null; restart(w); }
      for (let again = 0; again < 3; again++) await rejects(attemptRoute(w, p, route), 'context_session_terminal', 409);
      assert.deepEqual(spentState(w), before, label); assert.equal(closures(w).length, 1, label);
    }
  }
  const polled = await coordinated(t);
  assert.equal((await polled.w.coordinatedContext(polled.p)).effect.state, 'new');
  polled.w.control.state = onlyJob(polled.p.jobId, () => 'finalised');
  const opened = spentState(polled.w); polled.w.livePending();
  await rejects(polled.w.coordinatedContext(polled.p), 'context_session_terminal', 409);
  polled.w.control.clock += 300001; polled.w.control.operation = () => view.ended;
  await rejects(polled.w.coordinatedContext(polled.p), 'context_session_terminal', 409);
  assert.deepEqual(spentState(polled.w), opened);
  const replayed = await coordinated(t); let observed = 0;
  await attemptRoute(replayed.w, replayed.p, PATHS.proposals);
  replayed.w.control.state = () => { observed++; return 'finalised'; };
  replayed.w.control.operation = target => view.completed(wireOperationBinding(target));
  assert.equal((await attemptRoute(replayed.w, replayed.p, PATHS.proposals)).state, 'new');
  assert.equal(observed, 1, 'accounting revalidates the retained operation through the store');
  assert.deepEqual(closures(replayed.w), closureOf(replayed.p.jobId));
  for (const [label, answer] of Object.entries(SESSION_ANSWERS)) {
    const control = await coordinated(t); control.w.control.state = onlyJob(control.p.jobId, answer);
    if (unavailableAnswer(label)) await assert.rejects(attemptRoute(control.w, control.p, PATHS.proposals), SESSION_UNAVAILABLE, label);
    else assert.equal((await attemptRoute(control.w, control.p, PATHS.proposals)).state, 'new', label);
    assert.equal(control.w.report().used, unavailableAnswer(label) ? 0 : 1, label); assert.deepEqual(closures(control.w), [], label);
  }
});

test('terminal checks and registered gates run before accounting under the operation mutex', async t => {
  const ordered = await coordinated(t), log = [], seen = [];
  ordered.w.control.operation = () => { log.push('inspect'); return view.none; };
  ordered.w.control.state = onlyJob(ordered.p.jobId, () => { log.push('terminal'); return null; });
  ordered.w.coordinator.addPreAccountingGate(input => { log.push('first gate'); seen.push(input); return null; });
  ordered.w.coordinator.addPreAccountingGate(() => { log.push('second gate'); return null; });
  const input = ordered.w.contextInput(ordered.p, PATHS.proposals);
  assert.equal((await attemptRoute(ordered.w, ordered.p, PATHS.proposals, input)).state, 'new');
  assert.deepEqual(log, ['inspect', 'terminal', 'first gate', 'second gate', 'terminal']);
  assert.deepEqual(seen.map(({ route, jobId, payload, inspection }) => ({ route, jobId, payload, inspection })), [{ route: PATHS.proposals, jobId: ordered.p.jobId, payload: input.payload, inspection: view.none }]);

  const refusing = await coordinated(t); let later = 0;
  refusing.w.coordinator.addPreAccountingGate(() => ({ code: 'TEST_gate_refused', status: 422 }));
  refusing.w.coordinator.addPreAccountingGate(() => { later++; return null; });
  const untouched = { spent: spentState(refusing.w), ready: refusing.w.capacity.fitsNewPurchase(), report: stable(refusing.w.report()) }, { input: refused, calls } = countedRequest(refusing.w, refusing.p, PATHS.proposals);
  await rejects(attemptRoute(refusing.w, refusing.p, PATHS.proposals, refused), 'TEST_gate_refused', 422);
  assert.deepEqual({ spent: spentState(refusing.w), ready: refusing.w.capacity.fitsNewPurchase(), report: stable(refusing.w.report()) }, untouched);
  assert.equal(later, 0); assert.equal(calls.reserve, 0);

  const thrown = await coordinated(t), cut = new Error('TEST gate threw'), before = spentState(thrown.w);
  thrown.w.coordinator.addPreAccountingGate(() => { throw cut; });
  await assert.rejects(attemptRoute(thrown.w, thrown.p, PATHS.proposals), error => error === cut);
  assert.deepEqual(spentState(thrown.w), before);

  const replay = await coordinated(t); let gated = 0, read = 0;
  await attemptRoute(replay.w, replay.p, PATHS.proposals);
  replay.w.coordinator.addPreAccountingGate(() => { gated++; return { code: 'TEST_gate_refused', status: 422 }; });
  replay.w.control.state = () => { read++; return 'finalised'; }; replay.w.control.operation = target => view.completed(wireOperationBinding(target));
  assert.equal((await attemptRoute(replay.w, replay.p, PATHS.proposals)).state, 'new'); assert.deepEqual({ gated, read }, { gated: 0, read: 1 });
  replay.w.control.operation = target => ({ ...view.completed(wireOperationBinding(target)), binding: hash('another binding') });
  await rejects(attemptRoute(replay.w, replay.p, PATHS.proposals), 'context_session_terminal', 409);
  assert.equal(gated, 0, 'a foreign binding takes no bypass, and the terminal check precedes every gate');

  const failed = await coordinated(t); failed.w.control.state = onlyJob(failed.p.jobId, () => 'finalised');
  failWrites(failed.w, 'kit_terminal_closures', 'INSERT', 'TEST closure write cut');
  const intact = spentState(failed.w), allocationState = () => failed.w.db().prepare('SELECT state FROM kit_allocations').get().state;
  await assert.rejects(attemptRoute(failed.w, failed.p, PATHS.proposals), /TEST closure write cut/);
  assert.deepEqual(spentState(failed.w), intact); assert.equal(allocationState(), 'live');
  healWrites(failed.w); failed.w.control.state = () => null;
  await rejects(attemptRoute(failed.w, failed.p, PATHS.proposals), 'context_session_terminal', 409);
  assert.deepEqual(durableClosures(failed.w), closureOf(failed.p.jobId, 'finalised', 'effect-path')); assert.equal(failed.w.current(failed.p.jobId).state, 'released');
  await rejects(attemptRoute(failed.w, failed.p, PATHS.payments), 'context_session_terminal', 409); assert.equal(closures(failed.w).length, 1);

  const crowd = await coordinated(t); crowd.w.control.state = onlyJob(crowd.p.jobId, () => 'vet-failed');
  const outcomes = await Promise.allSettled([PATHS.proposals, PATHS.proposals, PATHS.commitments, PATHS.payments].map(route => attemptRoute(crowd.w, crowd.p, route)));
  assert.deepEqual(outcomes.map(outcome => outcome.reason?.code), Array(4).fill('context_session_terminal'));
  assert.equal(durableClosures(crowd.w).length, 1); assert.equal(crowd.w.report().used, 0);
});

test('terminal-gate-shape-and-thenable-refusals', async t => {
  const unhandled = watchUnhandled(t), { w, p } = await coordinated(t);
  for (const notGate of ['gate', null, {}, undefined]) assert.throws(() => w.coordinator.addPreAccountingGate(notGate), TypeError);
  const answers = { 'a Promise': () => Promise.resolve(null), 'a rejecting Promise': () => Promise.reject(new Error('TEST gate rejected')), 'a thenable': () => ({ then() {} }),
    'no status': () => ({ code: 'TEST_no_status' }), 'a text status': () => ({ code: 'TEST_status', status: 'refused' }), 'a success status': () => ({ code: 'TEST_ok', status: 200 }),
    'a bare string': () => 'refuse', undefined: () => undefined };
  for (const [label, answer] of Object.entries(answers)) {
    withCoordinator(w); w.coordinator.addPreAccountingGate(answer);
    const before = spentState(w);
    await assert.rejects(attemptRoute(w, p, PATHS.proposals), TypeError, label);
    assert.deepEqual(spentState(w), before, label);
  }
  await settle(); assert.deepEqual(unhandled, []); assert.equal(w.report().used, 0);
});

// OLD is a reclaimable challenge row of a terminal session that holds an allocation, with the challenge table full.
const oldSession = (t, options = {}) => {
  const w = world(t, { maxRecords: 200, store: { maxChallenges: 1, ...options } }), jobId = job(1);
  w.store.challenges.issue({ jobId, buyer: BUYER }, hash('scope')); w.allocate(w.purchase(1));
  w.control.clock += 2 * 3600000; w.control.state = onlyJob(jobId, () => 'finalised');
  return w;
};
const challengeRows = w => w.db().prepare('SELECT jobId FROM kit_challenges ORDER BY jobId').all().map(row => row.jobId);
const issueFor = (w, index) => w.store.challenges.issue({ jobId: job(index), buyer: BUYER }, hash('scope'));
const fillContextRecords = w => w.db().prepare("INSERT INTO kit_context_admissions VALUES (?, ?, ?, 'running', 1, '{}')").run(job(0xaa), BUYER, T0);
const workCounts = w => ['kit_job_bindings', 'kit_reservations'].map(table => w.db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

test('issuance and reclamation preserve terminal observations across request rollback', async t => {
  const unhandled = watchUnhandled(t);
  const cases = {
    'a successful transaction': { run: w => issueFor(w, 2), rows: [job(2)] },
    'a terminal refusal': { run: w => issueFor(w, 1), rejects: error => error.code === 'context_session_terminal' && error.status === 409, rows: [job(1)] },
    'a later capacity refusal': { options: { maxContextRecords: 1 }, setup: fillContextRecords, run: w => issueFor(w, 2), rejects: error => error.code === 'peer_context_capacity', rows: [job(1)] },
    'a thrown failure': { setup: w => failWrites(w, 'kit_challenges', 'DELETE', 'TEST challenge delete cut'), heal: true, run: w => issueFor(w, 2), rejects: /TEST challenge delete cut/, rows: [job(1)] },
    'a deliberate rollback': { run: w => w.internals.transaction(() => w.internals.sessionState({ jobId: job(1) }), true), rows: [job(1)] },
  };
  for (const [name, { options, setup, heal, run, rejects: expected, rows }] of Object.entries(cases)) {
    const w = oldSession(t, options), counts = workCounts(w), execs = [];
    setup?.(w);
    const db = w.db(), exec = db.exec.bind(db);
    t.mock.method(db, 'exec', sql => { execs.push({ sql, nested: /^BEGIN/.test(sql) && db.inTransaction }); return exec(sql); });
    try { if (expected) await assert.rejects(async () => run(w), expected, name); else run(w); } finally { db.exec.mock.restore(); }
    assert.deepEqual(durableClosures(w), closureOf(job(1)), name); assert.equal(w.current(job(1)).state, 'released', name);
    assert.deepEqual(challengeRows(w), rows, name); assert.ok(execs.every(({ nested }) => !nested), `${name}: no nested transaction`);
    if (heal) healWrites(w);
    assert.deepEqual(workCounts(w), counts, name);
    const settled = w.current(job(1));
    for (let reopened = 0; reopened < 2; reopened++) {
      w.control.state = () => null; w.reopen();
      assert.deepEqual(w.internals.terminalSession(job(1)), { terminal: true, state: 'finalised' }, name);
      w.capacity.releaseTerminalAllocations(); assert.deepEqual(w.current(job(1)), settled, name); assert.equal(durableClosures(w).length, 1, name);
    }
  }
  const flushing = oldSession(t); failWrites(flushing, 'kit_terminal_closures', 'INSERT', 'TEST flush cut');
  await assert.rejects(async () => issueFor(flushing, 1), error => /TEST flush cut/.test(error.message) && error.cause?.code === 'context_session_terminal');
  // Raw reads: a transaction would hit the barrier the pending observation puts in front of every later one.
  assert.deepEqual(durableClosures(flushing), []); assert.equal(flushing.db().prepare('SELECT state FROM kit_allocations').get().state, 'live');
  healWrites(flushing);
  assert.equal(issueFor(flushing, 2).sessionNonce.length, 64); assert.deepEqual(durableClosures(flushing), closureOf(job(1)));
  await rejects(Promise.resolve().then(() => issueFor(flushing, 1)), 'context_session_terminal', 409); assert.equal(durableClosures(flushing).length, 1);
  for (const [label, answer] of Object.entries(SESSION_ANSWERS)) {
    const quiet = world(t, { maxRecords: 200 }); quiet.control.state = answer;
    if (unavailableAnswer(label)) assert.throws(() => issueFor(quiet, 1), SESSION_UNAVAILABLE, label);
    else assert.equal(issueFor(quiet, 1).sessionNonce.length, 64, label);
    assert.deepEqual(durableClosures(quiet), [], label);
  }
  await settle(); assert.deepEqual(unhandled, []);
});

// Each retiring reader of the session state observes through the same adapter, on every active path.
const TERMINAL_REFUSAL = error => error.code === 'context_session_terminal' && error.status === 409;
const proposalOf = (f, jobId) => f.payload({ jobId });
const reserveProposal = (f, jobId) => f.store().reserve(proposalOf(f, jobId), {}, { keepProfile: FIXTURE_PROFILE });
const contextOf = (f, jobId) => [f.payload({ path: PATHS.context, jobId }), { scope: { jobId } }];
const reserveContext = (f, jobId) => f.store().reserve(...contextOf(f, jobId), { admit: () => fixture.T0 });
const retiringReaders = {
  'a new proposal': { run: f => assert.throws(() => reserveProposal(f, fixture.JOB), TERMINAL_REFUSAL) },
  'the classify dry run': { run: f => assert.throws(() => f.store().classify(proposalOf(f, fixture.JOB), {}, { keepProfile: FIXTURE_PROFILE }), TERMINAL_REFUSAL) },
  'the context step': { run: f => assert.throws(() => reserveContext(f, fixture.JOB), TERMINAL_REFUSAL) },
  assertPending: { before: f => reserveProposal(f, fixture.JOB), run: (f, held) => assert.throws(() => f.store().assertPending(held), TERMINAL_REFUSAL) },
  claim: { before: f => { f.store().finish(reserveProposal(f, fixture.JOB), 503, '{}'); return reserveProposal(f, fixture.JOB); },
    run: (f, held) => assert.throws(() => f.store().claim(held, proposalOf(f, fixture.JOB)), { code: 'seller_unavailable', status: 503 }) },
  resume: { before: f => { f.store().finish(reserveContext(f, fixture.JOB), 503, '{}'); return reserveContext(f, fixture.JOB); },
    run: (f, held) => assert.throws(() => f.store().resume(held, contextOf(f, fixture.JOB)[0]), TERMINAL_REFUSAL) },
  'context reclamation': { before: f => { f.store().finish(reserveContext(f, fixture.JOB), 200, '{}'); f.setTime(fixture.T0 + 7200000); }, run: f => { reserveContext(f, fixture.JOB2); }, maxContextRecords: 1 },
  'job reclamation': { before: f => { f.store().finish(reserveProposal(f, fixture.JOB), 200, '{}'); f.setTime(fixture.T0 + 7200000); }, run: f => { reserveProposal(f, fixture.JOB2); }, maxJobs: 1 },
};

test('all terminal readers and classify preserve their observations', async t => {
  for (const [name, { before, run, ...limits }] of Object.entries(retiringReaders)) {
    const w = await coordination(t, {}, limits); w.allocate(fixture.JOB);
    const held = before?.(w.f);
    w.control.state = onlyJob(fixture.JOB, () => 'finalised');
    run(w.f, held);
    const closed = new Database(w.f.path, { readonly: true });
    try { assert.deepEqual(closed.prepare(CLOSURES_SQL).all().map(row => ({ ...row })), closureOf(fixture.JOB), name); } finally { closed.close(); }
    assert.equal(w.internals.transaction(() => w.capacity.allocationWithin(fixture.JOB)).state, 'released', name);
    w.control.state = () => null; w.reopen();
    assert.deepEqual(w.internals.terminalSession(fixture.JOB), { terminal: true, state: 'finalised' }, name);
  }
});

test('terminal-observer-rollback-flush-crash-cuts', t => {
  const refusal = w => assert.throws(() => issueFor(w, 1), /TEST flush cut/);
  for (const [name, attempt] of Object.entries({
    'a refused issuance': refusal,
    'a deliberate rollback': w => assert.throws(() => w.internals.transaction(() => w.internals.sessionState({ jobId: job(1) }), true), /TEST flush cut/),
  })) {
    const w = oldSession(t), live = w.current(job(1));
    failWrites(w, 'kit_terminal_closures', 'INSERT', 'TEST flush cut');
    attempt(w);
    w.reopen();
    assert.deepEqual(durableClosures(w), [], `${name}: the answer never escaped before the flush`); assert.deepEqual(w.current(job(1)), live); assert.deepEqual(challengeRows(w), [job(1)]);
    healWrites(w);
    assert.throws(() => issueFor(w, 1), { code: 'context_session_terminal' }); assert.deepEqual(durableClosures(w), closureOf(job(1)), name);
  }
  for (const cut of ['before', 'after']) {
    const w = oldSession(t); w.failCommit(cut);
    assert.throws(() => issueFor(w, 1)); w.reopen();
    assert.deepEqual(durableClosures(w), cut === 'after' ? closureOf(job(1)) : [], cut);
    assert.equal(w.current(job(1)).state, cut === 'after' ? 'released' : 'live', cut);
  }
});

test('terminal-pending-flush-barrier', async t => {
  const { w, p } = await coordinated(t); let reads = 0;
  w.control.state = onlyJob(p.jobId, () => { reads++; return 'finalised'; });
  failWrites(w, 'kit_terminal_closures', 'INSERT', 'TEST pending cut');
  assert.throws(() => w.internals.terminalSession(p.jobId), /TEST pending cut/);
  assert.throws(() => w.internals.flushTerminalObservations(), /TEST pending cut/);
  assert.throws(() => w.internals.transaction(() => 'work'), /TEST pending cut/, 'a pending observation blocks later transactions');
  const { input, calls } = countedRequest(w, p, PATHS.proposals), before = spentState(w);
  let inspections = 0;
  w.control.operation = () => { inspections++; return view.none; };
  await assert.rejects(w.coordinator.reserveCoordinated(input), /TEST pending cut/);
  assert.equal(inspections, 0, 'pending metadata blocks operation inspection');
  assert.deepEqual(spentState(w), before); assert.equal(calls.reserve, 0); assert.deepEqual(durableClosures(w), []);
  healWrites(w); w.control.state = () => null;
  w.internals.flushTerminalObservations();
  assert.deepEqual(durableClosures(w), closureOf(p.jobId, 'finalised', 'effect-path')); assert.equal(w.current(p.jobId).state, 'released');
  assert.equal(w.internals.transaction(() => 'work'), 'work'); assert.equal(reads, 1, 'the retry read no port'); assert.equal(closures(w).length, 1);
});

test('terminal-observation-clock-fault', t => {
  const w = world(t, { maxRecords: 500 }), p = w.purchase(); w.allocate(p); w.control.state = () => 'finalised';
  for (const clock of [Number.NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    w.control.clock = clock;
    assert.throws(() => w.internals.terminalSession(p.jobId), error => error.code === 'peer_clock_invalid' && error.status === 503, String(clock));
    assert.deepEqual(durableClosures(w), [], String(clock)); assert.equal(w.db().prepare('SELECT state FROM kit_allocations').get().state, 'live');
  }
  w.control.clock = T0; w.control.state = () => null;
  w.internals.flushTerminalObservations();
  assert.deepEqual(durableClosures(w), closureOf(p.jobId, 'finalised', 'effect-path'), 'the observation was retained, never lost or malformed');
});

test('terminal-store-capacity-binding', t => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-terminal-binding-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let reads = 0;
  const store = createSellerTransportStore({ path: join(directory, 'transport.sqlite'), now: () => T0, contextSessionState: () => { reads++; return null; } });
  t.after(() => store.close());
  const internals = sellerStoreInternals(store), before = internals.db.prepare('SELECT total_changes() AS n').get().n;
  for (const call of [() => internals.sessionState({ jobId: job(1) }), () => internals.terminalSession(job(1)), () => internals.flushTerminalObservations(),
    () => store.challenges.issue({ jobId: job(1), buyer: BUYER }, hash('scope'))]) assert.throws(call, TypeError);
  assert.equal(reads, 0, 'no source read before the binding'); assert.equal(internals.db.prepare('SELECT total_changes() AS n').get().n, before);
  for (const notCleanup of ['cleanup', null, {}]) assert.throws(() => internals.bindTerminalCleanup(notCleanup), TypeError);
  assert.throws(() => createPurchaseCapacity({ store, now: () => T0, sessionState: () => null }), TypeError, 'a different source is refused');
  createPurchaseCapacity({ store, now: () => T0, sessionState: internals.sessionState });
  assert.throws(() => createPurchaseCapacity({ store, now: () => T0, sessionState: internals.sessionState }), TypeError, 'the cleanup binds once');
  assert.throws(() => internals.bindTerminalCleanup(() => {}), TypeError);
  assert.equal(internals.sessionState({ jobId: job(1) }), null); assert.equal(reads, 1);
});

test('terminal-store-capacity-binding an asynchronous cleanup rolls the closure back', t => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-terminal-async-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createSellerTransportStore({ path: join(directory, 'transport.sqlite'), now: () => T0, contextSessionState: () => 'finalised' });
  t.after(() => store.close());
  const internals = sellerStoreInternals(store); internals.bindTerminalCleanup(async () => {});
  assert.throws(() => internals.sessionState({ jobId: job(1) }), TypeError);
  assert.equal(internals.db.prepare('SELECT COUNT(*) AS n FROM kit_terminal_closures').get().n, 0);
});

test('terminal-session-open-transaction', t => {
  const w = world(t, { maxRecords: 500 }), p = w.purchase(); w.allocate(p);
  let reads = 0; w.control.state = onlyJob(p.jobId, () => { reads++; return 'finalised'; });
  const execs = [], db = w.db(), exec = db.exec.bind(db);
  t.mock.method(db, 'exec', sql => { execs.push(sql); return exec(sql); });
  assert.equal(w.internals.transaction(() => { assert.throws(() => w.internals.terminalSession(p.jobId), TypeError); return 'inside'; }), 'inside');
  assert.equal(reads, 0, 'no source read'); assert.deepEqual(execs, ['BEGIN IMMEDIATE', 'COMMIT']);
  assert.deepEqual(durableClosures(w), []);
  db.exec.mock.restore();
  // The in-transaction reader observes instead: the closure and release commit with the work, or right after a refusal.
  assert.equal(w.internals.transaction(() => w.internals.sessionState({ jobId: p.jobId })), 'finalised');
  assert.deepEqual(durableClosures(w), closureOf(p.jobId)); assert.equal(w.current(p.jobId).state, 'released');
  const refused = world(t, { maxRecords: 500 }), q = refused.purchase(); refused.allocate(q); refused.control.state = () => 'vet-failed';
  assert.throws(() => refused.internals.transaction(() => { refused.internals.sessionState({ jobId: q.jobId }); throw new Error('TEST refusal'); }), /TEST refusal/);
  assert.deepEqual(durableClosures(refused), closureOf(q.jobId, 'vet-failed')); assert.equal(refused.current(q.jobId).state, 'released');
  assert.throws(() => refused.internals.transaction(() => Promise.resolve('late')), TypeError);
});

test('terminal-reader-installation-audit', () => {
  const root = new URL('../src/', import.meta.url), sources = new Map();
  for (const file of readdirSync(root, { recursive: true })) if (file.endsWith('.mjs')) sources.set(file, readFileSync(new URL(file, root), 'utf8'));
  const callers = pattern => [...sources].filter(([, text]) => pattern.test(text)).map(([file]) => file);
  assert.deepEqual(callers(/\breadSellerSessionState\(readSessionState,/), ['dacs/seller-transport-auth.mjs'], 'the raw port is read in one place');
  assert.equal(sources.get('dacs/seller-transport-auth.mjs').match(/\breadSellerSessionState\(readSessionState,/g).length, 1);
  assert.deepEqual(callers(/\bcontextSessionState\(/), ['dacs/seller-transport-auth.mjs'], 'the host calls no port itself');
  const store = sources.get('dacs/seller-transport-auth.mjs');
  for (const line of store.split('\n').filter(text => text.includes('TERMINAL_CONTEXT_STATES.has('))) {
    assert.ok(/contextSessionState\(|readSessionStateWithin\(|\bstate\b/.test(line), `a terminal check reads through the adapter: ${line.trim()}`);
  }
  assert.equal(store.match(/createSellerChallengeLedger\(\{[^}]*sessionState: contextSessionState/g)?.length, 1, 'the ledger is given the adapter');
  assert.ok(sources.get('host.mjs').includes('sessionState: sellerStoreInternals(store).sessionState'), 'the capacity is given the store\'s adapter');
});

// Accounting stops counting a settled repeat or a refused row once its request has expired, so `used` does the same.
const REQUEST_EXPIRED_MS = 61000;

test('repeat and refused rows of an expired request stop counting toward used', t => {
  const w = world(t, { maxRecords: 5 }), p = w.purchase();
  w.charge(p.jobId, PATHS.proposals, 5);
  assert.deepEqual(figures(w.report()), { used: 5, allotted: 0, free: 0 });
  refusal(() => w.capacity.classify(classifyInput(p, PATHS.proposals, view.none)), 'peer_store_capacity', 503);
  w.control.clock += REQUEST_EXPIRED_MS;
  assert.deepEqual(figures(w.report()), { used: 1, allotted: 0, free: 4 }, 'only the first settled row of the route is kept');
  assert.equal(w.capacity.classify(classifyInput(p, PATHS.proposals, view.none)).class, 'general');
});

test('a full store frees its room for a new purchase once the repeat rows expire', t => {
  const w = world(t, { maxRecords: FOUR + 5 }), p = w.purchase(1);
  w.charge(p.jobId, PATHS.proposals, FOUR + 5);
  assert.equal(w.capacity.fitsNewPurchase(), false);
  w.control.clock += REQUEST_EXPIRED_MS;
  assert.equal(w.capacity.fitsNewPurchase(), true);
  assert.equal(w.allocate(w.purchase(2)).state, 'live');
});

test('a row still reserving after a crash keeps counting after its request expired', t => {
  const w = world(t, { maxRecords: 5 }), p = w.purchase();
  w.charge(p.jobId, PATHS.proposals, 3);
  w.db().prepare("UPDATE kit_reservations SET state = 'reserving', rev = 1").run();
  w.control.clock += REQUEST_EXPIRED_MS;
  assert.equal(w.report().used, 3);
});

test('a row of a request that has not expired yet keeps counting', t => {
  const w = world(t, { maxRecords: 5 }), p = w.purchase();
  w.charge(p.jobId, PATHS.proposals, 5);
  w.control.clock += REQUEST_EXPIRED_MS - 2000;
  assert.equal(w.report().used, 5);
});
