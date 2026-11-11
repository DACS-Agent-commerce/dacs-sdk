// Purchase allocations, accounting, returns and restart recovery on the shared transport store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, generateCanonicalJobId, identityBundleHash } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS, TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION, wireOperationId } from '@kynesyslabs/dacs/wire';
import { privateModule } from './helpers/private-module.mjs';
const { retainedFor } = await privateModule(new URL('../src/dacs/seller-wire-requests.mjs', import.meta.url), ['retainedFor']);
import { accountingFixture } from './helpers/reservation-accounting-fixture.mjs';
import { SELLER_PROFILE } from '../src/dacs/session-admission.mjs';

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

let createPurchaseCapacity, createContextAdmissionTransaction, createSellerTransportStore, sellerStoreInternals, importFailure;
try {
  ({ createPurchaseCapacity } = await import('../src/dacs/seller-purchase-capacity.mjs'));
  ({ createContextAdmissionTransaction } = await import('../src/dacs/seller-admission-transaction.mjs'));
  ({ createSellerTransportStore, sellerStoreInternals } = await import('../src/dacs/seller-transport-auth.mjs'));
} catch (error) { importFailure = error; }

// One store, its capacity and its admission transaction on one clock. `reopen()` is a restart: the old handle closes and the
// durable rows are all that remains. `maxRecords` may change at a restart.
function world(t, { maxRecords = 1000, commitOnSignature = false, sessionState = () => null } = {}) {
  assert.ifError(importFailure);
  const directory = mkdtempSync(join(tmpdir(), 'TEST-purchase-capacity-')), path = join(directory, 'transport.sqlite');
  const control = { clock: T0, ready: true, state: sessionState, inspect: () => view.none, generation: 0, spent: 0 };
  const holds = new Set(), w = { directory, control, holds };
  function open(limit) {
    w.store?.close();
    w.store = createSellerTransportStore({ path, now: () => control.clock, generation: `TEST-generation-${++control.generation}`,
      ready: () => control.ready && w.capacity?.fitsNewPurchase() === true });
    w.internals = sellerStoreInternals(w.store);
    w.capacity = createPurchaseCapacity({ store: w.store, now: () => control.clock, maxRecords: limit, commitOnSignature, sessionState: input => control.state(input) });
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
  for (const [name, answer] of Object.entries(answers)) { w.control.state = answer; w.capacity.releaseTerminalAllocations(); assert.equal(w.current(p.jobId).state, 'live', name); }
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
  const f = await accountingFixture(t);
  const capacity = createPurchaseCapacity({ store: f.store(), now: f.now, maxRecords, sessionState: () => null });
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
  const reopened = createPurchaseCapacity({ store: f.store(), now: f.now, maxRecords: FOUR, sessionState: () => null });
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
    const reopened = createPurchaseCapacity({ store: f.store(), now: f.now, maxRecords: FOUR, sessionState: () => null });
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
