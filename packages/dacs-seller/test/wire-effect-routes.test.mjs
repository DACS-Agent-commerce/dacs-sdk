import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import DatabaseSync from 'better-sqlite3';
import { NO_EFFECT_ERRORS, SellerAgentError, transportOutcome } from '../src/dacs/seller-agent.mjs';
import { NOW, testWallet } from './helpers/protocol-fixture.mjs';
import { BUYER as WORLD_BUYER, LISTING, answeredStatus, PIN as WORLD_PIN, SELLER as WORLD_SELLER, continuingWorld, derive, identityBody, jobFor, proposalFor, proposeJob, vetRef, world as routeWorld } from './helpers/wire-routes-world.mjs';
import { canonicalize, createFixedPriceAgreementSignatureContribution, createFixedPriceAgreementSigningPlan, deriveFixedPriceAgreement, sha256Hex } from '@kynesyslabs/dacs';
import { fixtureIdentityBundle } from './fixtures/listings.mjs';
import { agreementInput } from '../src/dacs/purchase-protocol.mjs';
import { wireBuyer } from './helpers/wire-buyer.mjs';
import { DACS_SELLER_HTTP_PATHS as PATHS, inspectWireOperation } from '@kynesyslabs/dacs/wire';
import { createPurchaseCapacity } from '../src/dacs/seller-purchase-capacity.mjs';
import { createReservationCoordinator } from '../src/dacs/seller-reservation-accounting.mjs';
import { createOrdinaryCompletionPort, createSellerHttpHandler, endWireAttempt } from '../src/dacs/seller-http.mjs';
import { SellerTransportError, createSellerTransportServerAuth, sellerStoreInternals } from '../src/dacs/seller-transport-auth.mjs';
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

// ---- The routes: every effect route decides from the wire journal's answer and ends each attempt through the completion port ----
// The wire bounds a discovery document's lifetime, so a test that lapses many attempts shortens the journal's lease.
const SHORT_LEASE_MS = 1000;
const CASES_PER_WORLD = 20;
const lapse = (w, ms = w.leaseMs) => { w.state.time += ms; };
const plainFailure = () => { throw new Error('TEST the agent failed after an unknown amount of work'); };
// Leaves one attempt open: the agent's answer is computed, then the answer cannot be signed, so nothing is completed.
const leaveOpen = async (w, send) => {
  w.signing.failures = 2;
  const answer = await send();
  assert.equal(answer.status, 503);
  assert.equal(answer.signed, false);
};
const recordOrder = (w, order) => {
  const reconcile = w.agent.reconcileTransport;
  w.agent.reconcileTransport = (input) => { order.push('reconcile'); return reconcile(input); };
  for (const name of ['receiveProposal', 'commit', 'commitOnSignature', 'submitPayment', 'bundleRequest', 'countersign']) {
    const route = w.agent[name];
    w.agent[name] = (...args) => { order.push('route'); return route(...args); };
  }
};
const accountingRows = (w) => {
  const db = new DatabaseSync(w.storePath, { readonly: true });
  try { return db.prepare('SELECT state, code FROM kit_reservations ORDER BY rowid').all(); } finally { db.close(); }
};

test('a new proposal runs the agent once and completes its attempt with the exact answer text after the agent\'s durable write', async t => {
  const w = await routeWorld(t), job = await proposeJob(w, 'new-proposal');
  let filesAtWrite = null;
  w.agent.onWork = () => { filesAtWrite = w.journalFiles().length; };
  const first = await job.post();
  assert.equal(first.status, 200);
  assert.equal(filesAtWrite, 2, 'when the agent wrote, the journal held only the attempt and the nonce key');
  assert.equal(w.journalFiles().length, 4, 'the end record and the outcome were published after it');
  const again = await job.post();
  assert.equal(again.text, first.text, 'a repeat gets the exact stored text');
  assert.equal(w.agent.calls.proposals, 1);
});

test('a completed payments operation that reported delivery is put to the agent again, and a later claim gets the answer the agent gives now', async t => {
  const w = await continuingWorld(t);
  const first = await w.request(PATHS.payments);
  assert.equal(first.status, 200);
  const seen = [];
  w.agent.submitPayment = async (body, { transport }) => { seen.push({ txHash: body.txHash, check: typeof transport.check, settle: typeof transport.settle }); return { status: 'held', reason: 'the delivery cannot be read now' }; };
  const files = w.journalFiles().length;
  const later = await w.post(PATHS.payments, { ...w.bodyFor(PATHS.payments), txHash: derive('another-transaction') }, { jobId: w.jobId, agreementHash: w.agreementHash });
  assert.deepEqual({ status: later.status, answer: later.body.status }, { status: 200, answer: 'held' }, 'the saved success is not replayed');
  assert.deepEqual(seen, [{ txHash: derive('another-transaction'), check: 'function', settle: 'undefined' }], 'the agent was asked once, with a check and no settle');
  await w.verified(later);
  assert.equal(w.journalFiles().length, files + 1, 'only the later request\'s nonce key was added: no new attempt');
  w.agent.submitPayment = async () => { throw new Error('TEST the refresh failed'); };
  const failed = await w.request(PATHS.payments);
  assert.deepEqual({ status: failed.status, error: failed.body.error }, { status: 503, error: 'operation_uncertain' }, 'a refresh that fails is no definite answer, and never the saved success');
});

test('a delivery refresh of a completed payment is refused once its request expired while the agent waited', async t => {
  const w = await continuingWorld(t);
  assert.equal((await w.request(PATHS.payments)).status, 200);
  w.agent.submitPayment = async (_body, { transport }) => { w.state.time += 5000; transport.check(); return { status: 'payment-evidenced', delivery: { status: 'delivered' } }; };
  const refused = await w.request(PATHS.payments, { lifetimeMs: 2000 });
  assert.deepEqual({ status: refused.status, error: refused.body.error }, { status: 408, error: 'peer_expired' });
});

for (const route of ['commitments', 'commitmentSignature']) {
  test(`a completed commitment on ${PATHS[route]} is revalidated read only before the stored answer is sent again`, async t => {
    const w = await continuingWorld(t);
    const first = await w.request(PATHS[route]);
    assert.equal(first.body.status, 'committed');
    const commits = { ...w.agent.calls }, revalidated = [];
    w.agent.readCommitment = async () => assert.fail('a replay never reads the commitment back through the agent');
    w.agent.revalidateCompletedAnswer = async (input) => { revalidated.push(input); };
    const replayed = await w.request(PATHS[route]);
    assert.deepEqual([replayed.status, replayed.text], [200, first.text], 'the stored answer is sent');
    assert.deepEqual(revalidated, [{ path: PATHS[route], jobId: w.jobId, outcome: { status: 200, text: first.text } }]);
    await w.verified(replayed);
    w.agent.revalidateCompletedAnswer = async () => { throw new SellerTransportError('seller_source_unavailable', 503, { cause: 'timeout' }); };
    const refused = await w.request(PATHS[route]);
    assert.deepEqual({ status: refused.status, error: refused.body.error, cause: refused.body.cause }, { status: 503, error: 'seller_source_unavailable', cause: 'timeout' }, 'a source that fails withholds the answer');
    assert.equal(refused.signed, true);
    assert.deepEqual(w.agent.calls, commits, 'no replay ran the commitment again');
  });
}

for (const route of ['proposals', 'commitments', 'commitmentSignature', 'payments', 'bundleRequest', 'bundleCountersignature']) {
  test(`a recover attempt asks the agent to reconcile before any route effect, on ${PATHS[route]}`, async t => {
    const w = route === 'proposals' ? await routeWorld(t) : await continuingWorld(t);
    const job = route === 'proposals' ? await proposeJob(w, 'a12') : null;
    const send = () => job ? job.post() : w.request(PATHS[route]);
    const order = [];
    recordOrder(w, order);
    await leaveOpen(w, send);
    assert.deepEqual(order, ['route']);
    lapse(w);
    const recovered = await send();
    assert.equal(recovered.status, answeredStatus(PATHS[route]));
    assert.deepEqual(order, ['route', 'reconcile'], 'the reconciliation ran, and no route effect ran again');
  });
}

test('a reconciliation answer maps to the attempt: present completes, no-effect and progress end null, anything else stays open', async t => {
  const reconciling = (disposition) => async ({ transport }) => {
    transport.claim();
    if (disposition !== 'unsettled') await transport.settle({ disposition, status: 200, value: { disposition: 'complete', contribution: { signed: true } }, settle: true, retry: disposition === 'retry', noEffect: disposition === 'no-effect' });
  };
  for (const [disposition, status, nextAnswer] of [['present', 200, 200], ['no-effect', 200, 200], ['retry', 200, 200], ['unsettled', 503, 'seller_effect_pending']]) {
    const w = await routeWorld(t), job = await proposeJob(w, `reconcile-${disposition}`);
    await leaveOpen(w, () => job.post());
    lapse(w);
    w.agent.reconcileTransport = reconciling(disposition);
    const answered = await job.post();
    assert.equal(answered.status, status, disposition);
    const files = w.journalFiles().length;
    const next = await job.post();
    if (nextAnswer === 200) assert.equal(next.status, 200, `${disposition}: ${disposition === 'present' ? 'completed' : 'the null end lets the next request recover at once'}`);    else assert.equal(next.body.error, nextAnswer, `${disposition}: the attempt is still open`);
    if (disposition === 'present') assert.equal(w.journalFiles().length, files + 1, 'a completed replay adds only its nonce key');
  }
});

test('every no-effect code, one unlisted SellerAgentError and a plain Error × proposals, commitments and payments × retained work absent/present × before/after completion', async t => {
  // The handler admits 120 requests a minute: each world serves a few dozen cases.
  let w;
  const failures = [...NO_EFFECT_ERRORS.map((code) => ({ code, listed: true, error: new SellerAgentError(code, 'TEST refusal', 409) })),
    { code: 'TEST_UNLISTED', listed: false, error: new SellerAgentError('TEST_UNLISTED', 'TEST unlisted', 409) }, { code: 'plain', listed: false, error: new Error('TEST plain') }];
  let index = 0;
  for (const retained of [false, true]) for (const failure of failures) {
    if (index % CASES_PER_WORLD === 0) w = await routeWorld(t, { leaseMs: SHORT_LEASE_MS });
    w.agent.retains = retained;
    const proposal = await proposeJob(w, `t04-${index++}`);
    w.agent.answer = () => { throw failure.error; };
    const reconciledBefore = w.agent.calls.reconciled;
    const refused = await proposal.post();
    assert.equal(refused.signed, true, failure.code);
    if (failure.listed && !retained) {
      assert.equal(refused.status, 409, `${failure.code}: a listed refusal before any work answers with its own status`);
      assert.equal((await proposal.post()).status, 200, `${failure.code}: the null end let the next request recover at once`);
      assert.equal(w.agent.calls.reconciled, reconciledBefore + 1);
    } else {
      assert.deepEqual({ status: refused.status, error: refused.body.error }, { status: 503, error: 'operation_uncertain' }, `${failure.code}: retained ${retained}`);
      w.state.time += SHORT_LEASE_MS - 1;
      assert.equal((await proposal.post()).body.error, 'seller_effect_pending', `${failure.code}: pending until the lease ends`);
      w.state.time += 1;
      assert.equal((await proposal.post()).status, 200, `${failure.code}: recovered at the lease's end`);
    }
  }
  // A returned rejected proposal with no retained work ends null and answers 200 without a signature of the agent.
  w = await routeWorld(t);
  w.agent.retains = false;
  const rejected = await proposeJob(w, 't04-rejected');
  w.agent.answer = () => ({ disposition: 'rejected', reason: 'TEST' });
  const answered = await rejected.post();
  assert.deepEqual({ status: answered.status, disposition: answered.body.disposition, signed: answered.signed }, { status: 200, disposition: 'rejected', signed: true });
  assert.equal((await rejected.post()).status, 200, 'the null end: the next request recovers at once');
});

test('every no-effect code and a plain Error on commitments and payments keep the proposal rule: a listed refusal ends null (on retained payment work as progress), anything else stays open', async t => {
  for (const [code, error, answer] of [['peer_job_capacity', new SellerAgentError('peer_job_capacity', 'TEST', 503), 'peer_job_capacity'], ['plain', new Error('TEST plain'), 'operation_uncertain']]) {
    const w = await continuingWorld(t);
    w.agent.answer = () => { throw error; };
    const answered = await w.post(PATHS.commitments, { jobId: w.jobId }, { jobId: w.jobId, agreementHash: w.agreementHash });
    assert.deepEqual({ status: answered.status, error: answered.body.error }, { status: 503, error: answer }, code);
  }
  for (const [retained, listed] of [[false, true], [true, true], [false, false]]) {
    const payments = await continuingWorld(t);
    payments.agent.retains = retained;
    const failure = listed ? new SellerAgentError('rail_unavailable', 'TEST', 503) : new Error('TEST plain');
    payments.agent.submitPayment = async () => { throw failure; };
    const answered = await payments.request(PATHS.payments);
    assert.equal(answered.body.error, listed ? 'rail_unavailable' : 'operation_uncertain', `payments retained ${retained} listed ${listed}`);
    payments.state.time += listed ? 0 : payments.leaseMs - 1;
    const next = await payments.request(PATHS.payments);
    assert.equal(next.body.error === 'seller_effect_pending', !listed, 'a null end recovers at once; an open attempt is pending');
  }
});

test('an agent result the wire refuses as an outcome is not completed and answers signed 503 operation_uncertain; later recovery remains possible', async t => {
  const twoByte = { pad: 'é'.repeat(262144) };
  assert.ok(JSON.stringify(twoByte).length < 524288 && Buffer.byteLength(JSON.stringify(twoByte)) > 524288);
  for (const [label, answer] of [['an escaped lone surrogate', { text: '\ud800' }], ['text over 524,288 UTF-8 bytes', twoByte]]) {
    const w = await routeWorld(t), job = await proposeJob(w, 't06');
    w.agent.answer = () => answer;
    const refused = await job.post();
    assert.deepEqual({ status: refused.status, error: refused.body.error, signed: refused.signed }, { status: 503, error: 'operation_uncertain', signed: true }, label);
    assert.equal(w.journalFiles().length, 2, `${label}: no end record and no outcome`);
    lapse(w);
    assert.equal((await job.post()).status, 200, `${label}: the next request recovers`);
  }
});

const TERMINAL_SESSIONS = ['finalised', 'vet-failed', 'negotiate-failed', 'commit-failed', 'settle-failed', 'aborted-by-self', 'aborted-by-other', 'failed-substrate'];
const UNREADABLE_SESSIONS = { throws: () => { throw new Error('the session reader is down'); }, thenable: () => ({ then() {} }), number: () => 7 };
const failSession = (w, read) => Object.defineProperty(w.state, 'session', { configurable: true, enumerable: true, get: read,
  set(value) { Object.defineProperty(w.state, 'session', { configurable: true, enumerable: true, writable: true, value }); } });

test('a context session that ends while a proposal request is in flight refuses the work before it signs, in every terminal state, and a live session is admitted', async t => {
  const w = await routeWorld(t);
  for (const terminal of [null, ...TERMINAL_SESSIONS]) {
    w.state.session = null;
    const job = await proposeJob(w, `ended-while-in-flight-${terminal}`);
    // The agent reads the session after its waits, just before it signs.
    w.agent.onWork = () => { w.state.session = terminal; };
    const answer = await job.post();
    w.agent.onWork = () => {};
    assert.equal(w.agent.transportAgreementOf(job.jobId) !== null, terminal === null, `${terminal}: the contribution is kept only for a live session`);
    assert.deepEqual({ status: answer.status, error: answer.body.error }, terminal === null ? { status: 200, error: undefined } : { status: 503, error: 'operation_uncertain' }, String(terminal));
  }
});

test('a session source that cannot be read is never read as live by proposal work, and nothing is signed or kept', async t => {
  const w = await routeWorld(t);
  for (const [label, fault] of Object.entries(UNREADABLE_SESSIONS)) {
    w.state.session = null;
    const job = await proposeJob(w, `unreadable-${label}`);
    w.agent.onWork = () => failSession(w, fault);
    const answer = await job.post();
    w.agent.onWork = () => {};
    w.state.session = null;
    assert.equal(w.agent.transportAgreementOf(job.jobId), null, `${label}: nothing is kept`);
    assert.deepEqual({ status: answer.status, error: answer.body.error }, { status: 503, error: 'operation_uncertain' }, label);
  }
});

test('a recovered proposal is not claimed once its session ended after accounting, and one claimed while the session was live is refused at its next check', async t => {
  const w = await routeWorld(t, { leaseMs: SHORT_LEASE_MS });
  const observed = [];
  // The session ends after the reservation passed: before the agent's claim, or after it.
  const reconciling = (beforeClaim, afterClaim) => async ({ transport }) => {
    w.state.session = beforeClaim;
    let claim;
    try { claim = transport.claim(); } catch (error) { observed.push({ claim: `${error.code} ${error.status}` }); return; }
    w.state.session = afterClaim;
    try { claim.check(); observed.push({ check: 'live' }); } catch (error) { observed.push({ check: `${error.code} ${error.status}` }); }
    await transport.settle({ disposition: 'present', status: 200, value: { disposition: 'complete', contribution: { signed: true } }, settle: true });
  };
  const recovered = async (label, beforeClaim, afterClaim) => {
    w.state.session = null;
    const job = await proposeJob(w, `recovered-${label}`);
    await leaveOpen(w, () => job.post());
    lapse(w);
    w.agent.reconcileTransport = reconciling(beforeClaim, afterClaim);
    return job.post();
  };
  assert.equal((await recovered('live', null, null)).status, 200);
  const ended = await recovered('ended', 'aborted-by-other', null);
  assert.equal(ended.status, 503);
  assert.equal(ended.body.error, 'operation_uncertain');
  assert.equal((await recovered('ends-after-claim', null, 'vet-failed')).status, 200, 'the answer the agent settles is still completed');
  assert.deepEqual(observed, [{ check: 'live' }, { claim: 'seller_unavailable 503' }, { check: 'context_session_terminal 409' }]);
});

test('a valid answer containing non-NFC text completes and is replayed with byte-identical stored text', async t => {
  const w = await routeWorld(t), job = await proposeJob(w, 't21');
  const answer = { text: 'é' };
  w.agent.answer = () => answer;
  const first = await job.post(), again = await job.post();
  assert.equal(first.status, 200);
  assert.ok(Buffer.from(first.text).equals(Buffer.from(JSON.stringify(answer))), 'the sent bytes are the exact answer');
  assert.ok(Buffer.from(again.text).equals(Buffer.from(first.text)), 'the replay sends the same bytes');
  await w.verified(again);
});

test('a completion the journal refuses as superseded answers signed 503 operation_uncertain, never the computed answer', async t => {
  const w = await routeWorld(t), job = await proposeJob(w, 't07');
  let release;
  w.agent.answer = () => new Promise((resolve) => { release = resolve; });
  const slow = job.post();
  for (let turn = 0; turn < 100 && release === undefined; turn++) await new Promise(setImmediate);
  lapse(w);
  w.agent.answer = undefined;
  const successor = await job.post();
  assert.equal(successor.status, 200, 'the successor recovers and completes');
  release({ disposition: 'complete', contribution: { signed: 'computed by the worker that lost its lease' } });
  const lost = await slow;
  assert.deepEqual({ status: lost.status, error: lost.body.error }, { status: 503, error: 'operation_uncertain' });
  assert.ok(!lost.text.includes('lost its lease'));
  assert.equal((await job.post()).text, successor.text, 'the successor\'s outcome stands');
});

test('a request whose host-retained binding changed is peer_job_conflict 409 while open, after completion and after a restart; the agent is not called', async t => {
  const w = await routeWorld(t), job = await proposeJob(w, 't10');
  const other = await proposalFor(job.jobId, NOW + 1000);
  const mismatched = () => w.post(PATHS.proposals, other.body, { jobId: job.jobId, agreementHash: other.agreementHash });
  await leaveOpen(w, () => job.post());
  const original = w.agent.transportAgreementOf;
  w.agent.transportAgreementOf = () => structuredClone(other.body.proposal.plan.draft);
  const calls = w.agent.calls.proposals;
  for (const [label, before] of [['while open', () => {}], ['after completion', () => { w.agent.transportAgreementOf = original; lapse(w); }], ['after a restart', () => { w.reopen(); }]]) {
    if (label === 'after completion') { await job.post(); }
    before();
    if (label !== 'while open') w.agent.transportAgreementOf = () => structuredClone(other.body.proposal.plan.draft);
    const files = w.journalFiles().length;
    const refused = await mismatched();
    assert.deepEqual({ status: refused.status, error: refused.body.error }, { status: 409, error: 'peer_job_conflict' }, label);
    assert.equal(w.journalFiles().length, files, `${label}: the refused request published nothing, as the accounting refused it first`);
    assert.equal(w.agent.calls.proposals, calls, `${label}: the agent was not called`);
  }
});

test('sixteen lapsed attempts end in seller_effect_unresolved on every later request: 500, recorded in the accounting row, with no automatic reset; the state route still answers', async t => {
  const w = await routeWorld(t, { leaseMs: SHORT_LEASE_MS }), job = await proposeJob(w, 't11');
  w.agent.answer = plainFailure;
  w.agent.reconcileTransport = async () => {};
  for (let attempt = 0; attempt < 16; attempt++) {
    assert.equal((await job.post()).status, 503, `attempt ${attempt}`);
    lapse(w);
  }
  for (const request of [17, 18]) {
    const refused = await job.post();
    assert.deepEqual({ status: refused.status, error: refused.body.error }, { status: 500, error: 'seller_effect_unresolved' }, `request ${request}`);
  }
  assert.deepEqual(accountingRows(w).at(-1), { state: 'refused', code: 'seller_effect_unresolved' });
  const state = await w.post(PATHS.state, identityBody(job.jobId, job.agreementHash), { jobId: job.jobId, agreementHash: job.agreementHash });
  assert.equal(state.status, 200);
});

test('the same signed request again is peer_request_replayed 409 and runs nothing', async t => {
  const w = await routeWorld(t), job = await proposeJob(w, 't12');
  const signed = await w.buyerWire.signRequest(PATHS.proposals, job.body, { jobId: job.jobId, agreementHash: job.agreementHash });
  assert.equal((await w.send(PATHS.proposals, signed)).status, 200);
  const replayed = await w.send(PATHS.proposals, signed);
  assert.deepEqual({ status: replayed.status, error: replayed.body.error }, { status: 409, error: 'peer_request_replayed' });
  assert.equal(w.effects(), 1);
});

test('a request inside a live lease answers signed 503 seller_effect_pending and calls no agent', async t => {
  const w = await routeWorld(t), job = await proposeJob(w, 't13');
  await leaveOpen(w, () => job.post());
  const calls = w.effects();
  const pending = await job.post();
  assert.deepEqual({ status: pending.status, error: pending.body.error, signed: pending.signed }, { status: 503, error: 'seller_effect_pending', signed: true });
  assert.equal(w.effects(), calls);
});

test('two requests for one operation: one runs, the other gets seller_effect_pending; one agent call', async t => {
  const w = await routeWorld(t), job = await proposeJob(w, 't15');
  let release;
  w.agent.answer = () => new Promise((resolve) => { release = resolve; });
  const running = job.post();
  for (let turn = 0; turn < 100 && release === undefined; turn++) await new Promise(setImmediate);
  assert.equal((await job.post()).body.error, 'seller_effect_pending');
  release({ disposition: 'complete', contribution: { signed: true } });
  assert.equal((await running).status, 200);
  assert.equal(w.agent.calls.proposals, 1);
});

test('no non-context effect route reads or writes the old transport tables', async t => {
  const w = await continuingWorld(t);
  const old = () => {
    const db = new DatabaseSync(w.storePath, { readonly: true });
    try { return Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'peer_%'").all().map(({ name }) => [name, db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n])); } finally { db.close(); }
  };
  const before = old();
  assert.ok(Object.keys(before).length >= 4);
  for (const path of [PATHS.commitments, PATHS.payments, PATHS.state]) assert.equal((await w.request(path)).status, 200, path);
  await leaveOpen(w, () => w.request(PATHS.bundleRequest));
  lapse(w);
  assert.equal((await w.request(PATHS.bundleRequest)).status, answeredStatus(PATHS.bundleRequest), 'one recovery');
  assert.deepEqual(old(), before);
});

test('the state and buyer-copy routes reserve nothing and touch no journal', async t => {
  const w = await continuingWorld(t);
  const files = w.journalFiles(), reservations = accountingRows(w).length;
  for (const path of [PATHS.state, PATHS.bundleBuyerCopy]) assert.equal((await w.request(path)).status, 200, path);
  assert.deepEqual(w.journalFiles(), files);
  assert.equal(accountingRows(w).length, reservations);
  const unknown = await w.post(PATHS.state, identityBody(jobFor('t19-unknown'), derive('t19')), { jobId: jobFor('t19-unknown'), agreementHash: derive('t19') });
  assert.equal(unknown.status, 404, 'a job the host holds nothing for is not answered');
  assert.equal(w.agent.agreementState(identityBody(jobFor('t19-unknown'), derive('t19')).transportIdentity).proposal, null);
});

test('an agent without callable retainsPaymentClaim or assertSettlementCredit is refused at construction', async t => {
  const w = await routeWorld(t);
  const { wire } = w.handle, authentication = createSellerTransportServerAuth({ sellerSigner: { claim: WORLD_SELLER.claim, sign: WORLD_SELLER.sign }, listingPin: WORLD_PIN, store: w.handle.store, now: w.clock });
  for (const name of ['retainsPaymentClaim', 'assertSettlementCredit']) for (const value of [undefined, 'not a function', {}]) {
    const agent = { ...w.agent, [name]: value };
    assert.throws(() => createSellerHttpHandler(agent, { authentication, wire }), TypeError, `${name} ${typeof value}`);
  }
  assert.equal(typeof createSellerHttpHandler(w.agent, { authentication, wire }), 'function', 'the complete agent constructs');
  assert.equal(w.journalFiles().length, 0);
});

test('settlement-credit hook {throws, rejects asynchronously, suspended, passes after await} × signed-200 route × {new, recover, completed replay, state read}', async t => {
  const w = await routeWorld(t, { leaseMs: SHORT_LEASE_MS });
  const hooks = { throws: () => { throw new Error('TEST credit lost'); }, rejects: () => Promise.reject(new Error('TEST credit rejected')),
    suspended: () => new Promise(() => {}), 'passes after await': async () => { await Promise.resolve(); } };
  for (const [name, hook] of Object.entries(hooks)) for (const phase of ['new', 'recover', 'completed replay', 'state read']) {
    const job = await proposeJob(w, `t18-${name}-${phase}`.replaceAll(' ', '-'));
    if (phase === 'recover') { await leaveOpen(w, () => job.post()); lapse(w); }
    if (phase === 'completed replay' || phase === 'state read') assert.equal((await job.post()).status, 200);
    let credited = 0;
    w.agent.credit = () => { credited++; return hook(); };
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const files = w.journalFiles().length;
    const request = phase === 'state read' ? w.post(PATHS.state, identityBody(job.jobId, job.agreementHash), { jobId: job.jobId, agreementHash: job.agreementHash }) : job.post();
    if (name === 'suspended') {
      for (let turn = 0; turn < 100 && credited === 0; turn++) await new Promise(setImmediate);
      t.mock.timers.tick(10000);
    }
    const answered = await request;
    t.mock.timers.reset();
    w.agent.credit = () => {};
    const label = `${name} on ${phase}`;
    assert.equal(credited, 1, `${label}: the hook ran exactly once`);
    if (name === 'passes after await') assert.equal(answered.status, 200, label);
    else {
      assert.deepEqual({ status: answered.status, error: answered.body.error, signed: answered.signed }, { status: 503, error: 'operation_uncertain', signed: true }, label);
      assert.ok(!answered.text.includes('contribution'), `${label}: no success text left`);
    }
    if (phase === 'completed replay' && name !== 'passes after await') assert.equal(w.journalFiles().length, files + 1, 'the stored outcome is unchanged: only the nonce key was added');
  }
});

test('the agent\'s settlement is awaited before the answer is written', async t => {
  const w = await routeWorld(t), job = await proposeJob(w, 'awaited-settlement');
  const order = [], unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  w.agent.receiveProposal = async (body, { transport }) => {
    const outcome = transportOutcome(transport.path, { answer: { disposition: 'complete', contribution: { signed: true } } }, { retained: false });
    order.push('settle starts');
    try { await transport.settle(outcome); } catch (error) { order.push('settle rejected'); throw error; }
    order.push('settle done');
    return outcome.value;
  };
  w.agent.credit = async () => { await Promise.resolve(); throw new Error('TEST credit rejected after an await'); };
  const refused = await job.post();
  order.push('answered');
  assert.deepEqual(order, ['settle starts', 'settle rejected', 'answered'], 'the rejection was awaited before the response');
  assert.deepEqual({ status: refused.status, error: refused.body.error }, { status: 503, error: 'operation_uncertain' });
  assert.equal(w.journalFiles().length, 2, 'nothing was completed');
  w.agent.credit = () => {};
  lapse(w);
  order.length = 0;
  assert.equal((await job.post()).status, 200, 'the recovery completes once the credit holds');
  await new Promise(setImmediate);
  assert.deepEqual(unhandled, []);
});

test('a completed proposal and commitment return only their own slot; an open attempt returns none', async t => {
  const w = await routeWorld(t);
  // The wire context is frozen: the host's retained-purchase check reads this capacity, which holds a live allocation on these two routes.
  w.handle.wireOverrides = { capacity: { retainedAllocated: ({ route }) => [PATHS.proposals, PATHS.commitments].includes(route) } };
  w.reopen();
  const { store, capacity } = w.handle, internals = sellerStoreInternals(store);
  const figures = () => { const { used, allotted, free } = capacity.capacityReport(); return { used, allotted, free }; };
  const slots = (jobId) => capacity.capacityReport().allocations.find((allocation) => allocation.jobId === jobId).slots;
  const job = await proposeJob(w, 'slot-return'), open = await proposeJob(w, 'slot-open');
  for (const { jobId } of [job, open]) internals.transaction(() => capacity.allocateWithin({ jobId, buyer: WORLD_BUYER.claim, seller: WORLD_SELLER.claim, listingPin: WORLD_PIN }));
  const delta = (before, after) => ({ used: after.used - before.used, allotted: before.allotted - after.allotted, free: after.free - before.free });
  const beforeOpen = figures();
  await leaveOpen(w, () => open.post());
  const afterOpen = figures();
  assert.deepEqual(delta(beforeOpen, afterOpen), { used: 1, allotted: 1, free: 0 }, 'an open attempt spent its unit and returned nothing');
  assert.equal((await job.post()).status, 200);
  assert.deepEqual(delta(afterOpen, figures()), { used: 1, allotted: 17, free: 16 }, 'the proposal spent one unit and returned the other 16 of its own slot');
  const beforeCommit = figures(), proposalSlot = slots(job.jobId)[PATHS.proposals];
  assert.equal((await w.post(PATHS.commitments, { jobId: job.jobId }, { jobId: job.jobId, agreementHash: job.agreementHash })).status, 200);
  assert.deepEqual(delta(beforeCommit, figures()), { used: 1, allotted: 17, free: 16 }, 'the commitment spent one unit and returned the other 16 of its own slot');
  assert.deepEqual(slots(job.jobId)[PATHS.proposals], proposalSlot, 'the proposal slot did not move');
  const beforeReplay = figures();
  assert.equal((await job.post()).status, 200);
  assert.deepEqual(delta(beforeReplay, figures()), { used: 1, allotted: 0, free: -1 }, 'a completed replay is charged one general unit and returns no slot');
  lapse(w);
  const beforeRecover = figures();
  assert.equal((await open.post()).status, 200);
  // Which expired row of the route stops counting depends on the rows' random keys, so `used` is not compared here.
  assert.equal(delta(beforeRecover, figures()).allotted, 16, 'the recovery spent one more unit of the slot and returned the 15 left, once');
});

test('with the guard off, a directly composed handler answers kit_operation_guard_off on every effect route with no journal file and no accounting row', async () => {
  const handlerUrl = new URL('../src/dacs/seller-http.mjs', import.meta.url).href;
  const options = (process.env.NODE_OPTIONS ?? '').split(' ').filter((option) => !option.includes('kit-guard-fixture'));
  const probe = `import { createSellerHttpHandler } from ${JSON.stringify(handlerUrl)};
    try { createSellerHttpHandler({}); console.log('constructed'); } catch (error) { console.log(error.code); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { env: { ...process.env, NODE_OPTIONS: options.join(' ') }, encoding: 'utf8' });
  assert.equal(child.stdout.trim(), 'kit_operation_guard_off', child.stderr);
});

// The completions the completion port recorded: only a final outcome is recorded, and only it returns a route slot.
const completions = (w) => {
  const db = new DatabaseSync(w.storePath, { readonly: true });
  try { return db.prepare('SELECT route, attempt, status, cleanup FROM kit_ordinary_completions ORDER BY rowid').all(); } finally { db.close(); }
};
const operationOf = (w, jobId, path) => inspectWireOperation(w.handle.wire.journal, { seller: WORLD_SELLER.claim, jobId, path });
const HELD = { status: 'held', reason: 'native-payment-evidence-not-anchored', readback: 'absent' };
const DELIVERED = { status: 'payment-evidenced', delivery: { status: 'delivered' } };
// A recovery that answers as the agent's reconciliation classifies a retained answer.
const reconcilingWith = (path, resultFor) => async (input) => {
  input.transport.claim();
  const outcome = transportOutcome(path, await resultFor(input), { retained: true, recovering: true });
  if (outcome.settle) await input.transport.settle(outcome);
};

test('an effect route reserves through the coordinator and ends through the completion port', async t => {
  const w = await routeWorld(t), done = await proposeJob(w, 'port-outcome'), refused = await proposeJob(w, 'port-null');
  const { reservations } = w.handle.wire, coordinated = reservations.reserveCoordinated, inputs = [];
  reservations.reserveCoordinated = (input, ...rest) => { inputs.push(input); return coordinated(input, ...rest); };
  assert.equal((await done.post()).status, 200);
  assert.deepEqual(completions(w), [{ route: PATHS.proposals, attempt: 0, status: 200, cleanup: 'route' }], 'the final answer ended through the completion port');
  w.agent.answer = () => { throw new SellerAgentError('peer_job_capacity', 'TEST nothing was done', 503); };
  assert.equal((await refused.post()).body.error, 'peer_job_capacity');
  assert.equal(operationOf(w, refused.jobId, PATHS.proposals).state, 'ended', 'the proven no-effect answer ended its attempt with null');
  assert.equal(completions(w).length, 1, 'a null end records no completion');
  assert.deepEqual(inputs.map((input) => [input.payload.jobId, input.retainedWork, input.paymentTx]), [[done.jobId, false, null], [refused.jobId, false, null]]);
});

test('a waiting proposal polled twenty times recovers each time and completes once', async t => {
  const w = await routeWorld(t), job = await proposeJob(w, 'waiting-polls');
  const waiting = { disposition: 'waiting', stage: 'lease', reason: 'TEST the durable responder is still working' };
  w.agent.answer = () => waiting;
  let polls = 0;
  w.agent.reconcileTransport = reconcilingWith(PATHS.proposals, () => { w.agent.calls.reconciled++; return { answer: ++polls < 20 ? waiting : { disposition: 'complete', contribution: { signed: true } } }; });
  assert.equal((await job.post()).body.disposition, 'waiting');
  for (let poll = 1; poll < 20; poll++) {
    const answered = await job.post();
    assert.deepEqual({ status: answered.status, disposition: answered.body.disposition }, { status: 200, disposition: 'waiting' }, `poll ${poll}: recovered at once, never seller_effect_pending`);
    assert.equal(w.agent.calls.reconciled, poll, `poll ${poll}: the agent reconciled first`);
    const { state, attempt, superseded } = operationOf(w, job.jobId, PATHS.proposals);
    assert.deepEqual({ state, attempt, superseded }, { state: 'ended', attempt: poll, superseded: 0 }, `poll ${poll}: ended without an outcome and superseded nothing`);
  }
  assert.deepEqual(completions(w), [], 'no outcome yet, so no route slot was returned');
  const final = await job.post();
  assert.equal(final.body.disposition, 'complete');
  assert.equal((await job.post()).text, final.text, 'the final answer is the stored outcome');
  assert.deepEqual({ proposals: w.agent.calls.proposals, reconciled: w.agent.calls.reconciled }, { proposals: 1, reconciled: 20 }, 'one route effect, then only reconciliation');
  assert.deepEqual(completions(w), [{ route: PATHS.proposals, attempt: 20, status: 200, cleanup: 'route' }], 'completed once, with its slot returned once');
});

test('a held payment recovers after one clean restart and completes once without a second charge', async t => {
  const w = await continuingWorld(t);
  let intake = 0, recovered = 0;
  w.agent.submitPayment = async () => { intake++; return HELD; };
  w.agent.reconcileTransport = reconcilingWith(PATHS.payments, () => ({ answer: ++recovered < 2 ? HELD : DELIVERED }));
  const { reservations } = w.handle.wire, coordinated = reservations.reserveCoordinated, claims = [];
  reservations.reserveCoordinated = (input, ...rest) => { claims.push(input.paymentTx); return coordinated(input, ...rest); };
  assert.deepEqual((await w.request(PATHS.payments)).body, HELD);
  assert.deepEqual((await w.request(PATHS.payments)).body, HELD, 'the next request recovered at once and the agent reconciled');
  assert.deepEqual(claims, [w.bodyFor(PATHS.payments).txHash, w.bodyFor(PATHS.payments).txHash], 'the coordinator reserves under the payment transaction');
  assert.equal(completions(w).filter((row) => row.route === PATHS.payments).length, 0, 'a held payment keeps its route slot');
  w.reopen();
  assert.deepEqual((await w.request(PATHS.payments)).body, DELIVERED, 'after the restart the next request recovers at once and delivers');
  assert.deepEqual({ intake, recovered }, { intake: 1, recovered: 2 }, 'payment intake ran once: no second charge');
  assert.deepEqual(completions(w).filter((row) => row.route === PATHS.payments), [{ route: PATHS.payments, attempt: 2, status: 200, cleanup: 'route' }], 'completed once');
});

test('two buyers racing for one job: the first committed claim wins and the other is refused with nothing created or charged', async t => {
  const w = await routeWorld(t), jobId = jobFor('two-buyers'), rivalWallet = testWallet(41);
  const first = await proposalFor(jobId);
  // The rival's own proposal for the same job, signed by the rival as its buyer.
  const base = agreementInput({ jobId, listing: LISTING, buyerBundle: fixtureIdentityBundle(rivalWallet, NOW), generatedAt: NOW });
  const plan = createFixedPriceAgreementSigningPlan(deriveFixedPriceAgreement({ ...base, buyer: { ...base.buyer, vetRecordRef: vetRef(jobId, rivalWallet) }, seller: { ...base.seller, vetRecordRef: vetRef(jobId, WORLD_SELLER) } }));
  const buyerContribution = await createFixedPriceAgreementSignatureContribution(plan, 'buyer', { party: rivalWallet.claim, algorithm: 'ed25519', sign: rivalWallet.signBytes });
  const material = { proposalVersion: '1', plan, buyerContribution }, proposal = { ...material, proposalHash: sha256Hex(canonicalize(material)) };
  const rivalBody = { proposal, transportIdentity: { jobId, planHash: plan.planHash, agreementHash: plan.agreementHash, buyer: rivalWallet.claim, seller: WORLD_SELLER.claim, proposalHash: proposal.proposalHash }, buyerIdentityBundle: base.buyer.identityBundle };
  const rival = await wireBuyer({ buyer: { claim: rivalWallet.claim, sign: rivalWallet.signBytes }, seller: WORLD_SELLER, listingPin: WORLD_PIN, clock: w.clock });
  const rivalSigned = await rival.signRequest(PATHS.proposals, rivalBody, { jobId, agreementHash: plan.agreementHash });
  const answers = await Promise.all([w.post(PATHS.proposals, first.body, { jobId, agreementHash: first.agreementHash }), w.send(PATHS.proposals, rivalSigned)]);
  const claims = [WORLD_BUYER.claim, rivalWallet.claim], won = answers.findIndex((answer) => answer.status === 200), loser = answers[1 - won];
  assert.notEqual(won, -1, 'the first committed claim wins');
  assert.ok(loser.status >= 400 && loser.status < 500 && loser.signed, `the other is refused definitely: ${loser.status} ${loser.body.error}`);
  assert.equal(w.agent.calls.proposals, 1, 'the agent ran for the winner only');
  assert.equal(w.agent.transportAgreementOf(jobId).parties.find((party) => party.role === 'buyer').primaryClaim, claims[won], 'the job is the winner\'s');
  const db = new DatabaseSync(w.storePath, { readonly: true });
  try {
    assert.deepEqual(db.prepare('SELECT state FROM kit_reservations WHERE buyer = ? AND state != ?').all(claims[1 - won], 'refused'), [], 'nothing was reserved for the other buyer');
    assert.equal(db.prepare('SELECT count(*) AS n FROM kit_payment_transactions').get().n, 0, 'nothing was charged');
  } finally { db.close(); }
  assert.deepEqual(completions(w), [{ route: PATHS.proposals, attempt: 0, status: 200, cleanup: 'route' }], 'one operation completed, for the winner');
});

test('a recovered payment under a changed claim is held and runs no intake', async t => {
  const w = await continuingWorld(t), first = w.bodyFor(PATHS.payments);
  let intake = 0;
  w.agent.submitPayment = async () => { intake++; return HELD; };
  // As the agent's reconciliation does, a claim other than the one whose work it retains is held as a context mismatch before anything runs.
  w.agent.reconcileTransport = reconcilingWith(PATHS.payments, ({ body }) => body.txHash === first.txHash ? { answer: HELD } : { held: 'seller_payment_context_mismatch' });
  assert.deepEqual((await w.request(PATHS.payments)).body, HELD);
  const changed = await w.post(PATHS.payments, { ...first, txHash: derive('changed-payment') }, { jobId: w.jobId, agreementHash: w.agreementHash });
  assert.deepEqual({ status: changed.status, error: changed.body.error, signed: changed.signed }, { status: 503, error: 'operation_uncertain', signed: true }, 'the changed claim is held');
  assert.equal(intake, 1, 'no intake ran for the changed claim');
  assert.equal(completions(w).filter((row) => row.route === PATHS.payments).length, 0, 'nothing was completed');
});
