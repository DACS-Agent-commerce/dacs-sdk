// A host stop seen on the seller request path: nothing is signed or sent, and the stored request keeps its outcome.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { storedWorld, PATHS, bodyFor } from './helpers/stored-request-fixture.mjs';
import { T0, JOB } from './helpers/wire-client-fixture.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
beforeEach(t => t.mock.method(Date, 'now', () => T0));
const { OperationError } = await import('../src/client-errors.mjs');
const { SellerUnavailableError } = await import('../src/dacs/seller-http.mjs');
const { buildUnsignedIdentityBundle, attachIdentityPresentation } = await import('../src/dacs/listing.mjs');
const { planAgreement, exchangeAgreement } = await import('../src/dacs/purchase-protocol.mjs');
const { sellerFlow } = await import('./helpers/stored-request-flows.mjs');
const P = PATHS.proposals;
const recordOf = (row) => row.state.protocol.sellerRequests?.[P];
const protocolOf = (s) => s.p.get().state.protocol;

// A stop check that answers `false` until the purchase row holds a request record for the proposal route.
const stopsOnceRecorded = (flow, { falseReadsAfterRecord = 0 } = {}) => {
  let reads = 0;
  return () => {
    if (!flow.s || !recordOf(flow.s.p.get())) return false;
    return ++reads > falseReadsAfterRecord;
  };
};
const rememberFlow = (flow) => (s) => { flow.s = s; };
const isStopRefusal = (error) => error instanceof OperationError && error.code === 'writes_stopped' && error.message === 'host stop refused: writes_stopped'
  && !(error instanceof SellerUnavailableError) && error.answerClass === undefined;

function assertRefusedAtTheWire(flow) {
  const { s } = flow;
  assert.equal(s.w.state.signs.length, 0);
  assert.equal(s.fetches.length, 0);
  const record = recordOf(s.p.get());
  assert.equal(record.lastClass, 'unknown');
  assert.equal(record.attempts, 1);
  assert.equal(record.clearAttempts, 0);
  assert.equal(protocolOf(s).sellerSuspension.cause, 'writes_stopped');
}

test('stopped at request entry: submitAgreement rejects with the OperationError writes_stopped itself, the session signer is called 0 times, nothing is fetched, and the record of the proposal route stays unknown with its attempt counted', async (t) => {
  const flow = {};
  await assert.rejects(sellerFlow(t, 'agreement', rememberFlow(flow), {}, { stopped: stopsOnceRecorded(flow) }), isStopRefusal);
  assertRefusedAtTheWire(flow);
});

test('stopped between the authority read of the wire and the signature: submitAgreement rejects with the OperationError writes_stopped itself, the session signer is called 0 times and the route record stays unknown', async (t) => {
  const flow = {};
  await assert.rejects(sellerFlow(t, 'agreement', rememberFlow(flow), {}, { stopped: stopsOnceRecorded(flow, { falseReadsAfterRecord: 1 }) }), isStopRefusal);
  assertRefusedAtTheWire(flow);
});

test('stopped after signing and before the send: the pre-send check refuses writes_stopped and fetch is called 0 times', async (t) => {
  const s = await storedWorld(t);
  await assert.rejects(s.client({ stopped: () => s.w.state.signs.length > 0 }).propose(bodyFor(P)), isStopRefusal);
  assert.equal(s.w.state.signs.length, 1);
  assert.equal(s.fetches.length, 0);
  assert.equal(s.record(P).lastClass, 'unknown');
  assert.equal(s.record(P).attempts, 1);
});

test('a stop seen during the wait between retries sends no further request, signs nothing further, rejects writes_stopped, leaves the outcome of the route unknown and records the suspension', async (t) => {
  const s = await storedWorld(t), sleep = s.clock.sleep;
  let stopped = false;
  s.clock.sleep = async ms => { await sleep(ms); stopped = true; };
  const respond = init => s.reply(init, 503, { error: 'seller_effect_pending' });
  await assert.rejects(s.client({ stopped: () => stopped, respond }).propose(bodyFor(P)), isStopRefusal);
  assert.equal(s.fetches.length, 1);
  assert.equal(s.w.state.signs.length, 1);
  assert.equal(s.delays.length, 1);
  assert.equal(s.record(P).lastClass, 'unknown');
  assert.equal(s.record(P).attempts, 1);
  assert.equal(s.p.get().state.protocol.sellerSuspension.cause, 'writes_stopped');
});

test('a stop seen when a request starts stores no bytes and counts no attempt', async (t) => {
  const s = await storedWorld(t), before = s.p.get();
  await assert.rejects(s.client({ stopped: () => true }).propose(bodyFor(P)), isStopRefusal);
  assert.equal(s.record(P), undefined);
  assert.deepEqual(s.p.get().state.protocol.sellerRequests, before.state.protocol.sellerRequests);
  assert.equal(s.p.get().state.protocol.revision, (before.state.protocol.revision ?? 0) + 1, 'the one write is the suspension');
  assert.equal(s.p.get().state.protocol.sellerSuspension.cause, 'writes_stopped');
  assert.equal(s.w.state.signs.length, 0);
  assert.equal(s.fetches.length, 0);
});

test('a stop that turns on inside the agreement exchange signs nothing, fetches nothing, records the suspension, and submitAgreement resolves with an indeterminate agreement note', async (t) => {
  const stop = { on: false };
  const beforeRun = (_s, state) => {
    // The real exchange runs with a real plan and signatures; only the stop turns on first.
    state.exchange = async ({ seller, anchorAdapter }) => {
      stop.on = true;
      const wallet = createEphemeralWallet(), sellerWallet = createEphemeralWallet();
      const listing = fixtureListing(sellerWallet, { listingId: 'host-stop-exchange', price: '1', now: T0 });
      const unsigned = buildUnsignedIdentityBundle({ address: wallet.address, presentedAt: T0, sessionNonce: 'e'.repeat(64) });
      const buyerBundle = attachIdentityPresentation(unsigned, wallet.signHex(unsigned.message));
      const planned = planAgreement({ jobId: JOB, listing, buyerBundle, generatedAt: T0 });
      return exchangeAgreement({ plan: planned.plan, draft: planned.draft, buyerClaim: wallet.claim, buyerBundle,
        agreementSignature: wallet.signHex(planned.agreementMessage), seller, anchorAdapter });
    };
  };
  const { s, result } = await sellerFlow(t, 'agreement', beforeRun, {}, { stopped: () => stop.on });
  assert.equal(s.w.state.signs.length, 0);
  assert.equal(s.fetches.length, 0);
  assert.equal(result.status, 'agreement_pending');
  const note = result.state.protocol.attempts.at(-1);
  assert.equal(note.step, 'agreement');
  assert.equal(note.outcome, 'indeterminate');
  assert.equal(note.causeCode, undefined);
  assert.equal('dispatched' in note, false);
  assert.equal(note.reason, 'proposal-publication: host stop refused: writes_stopped');
  assert.equal(result.state.protocol.sellerSuspension.cause, 'writes_stopped');
  const suspensions = s.p.ops.history(s.p.op.id).filter((event) => event.type === 'seller_suspended');
  assert.ok(suspensions.length > 0);
  assert.ok(suspensions.every((event) => event.data.cause === 'writes_stopped'));
  assert.equal(recordOf(s.p.get()), undefined);
});
