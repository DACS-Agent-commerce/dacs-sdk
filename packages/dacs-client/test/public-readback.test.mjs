// DC-CW2: the public purchase service chooses its readback behaviour at call time.
// A held read is the pure projection: it writes nothing, contacts no seller, signer
// or chain write path, and leaks no nested signing material or raw event history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './helpers/purchase-admission-hook.mjs';

installPurchaseAdmissionHook();
const { setPurchaseAdmission } = await loadAdmissionDouble();
const { compositionWorld, ACCOUNT_ID, NOW } = await import('./helpers/public-composition-world.mjs');
const { OFFLINE_AGREEMENT_PROFILE } = await import('../src/dacs/protocol-purchases.mjs');
const { createPublicPurchaseService } = await import('../src/purchases.mjs');
const { admitPublicFactory } = await import('../src/public-admission.mjs');
const { DIAGNOSTIC_LIMITS } = await import('../src/diagnostic-projection.mjs');

const HASH = '1'.repeat(64);
const MARKER = 'TEST-MARKER-must-not-leak';
const NATIVE_TERMS = { profile: OFFLINE_AGREEMENT_PROFILE, jobId: '01HZY3K8V9Q2W4E6R7T8Y9X0AB', nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment', sellerAgreementProjection: 'public-signed-create' };
const SIGNED_AGREEMENT = { artifact: { jobId: NATIVE_TERMS.jobId, signatures: [{ value: 'TEST-signature-text' }] }, hash: 'a'.repeat(64) };
const holdAfter = (t) => t.after(() => setPurchaseAdmission('held'));

// Seller lookups, chain broadcasts and every native-source signature, fetch, journal write and fence.
const effects = (world) => [world.counters.sellerLookups, world.chain.broadcasts, world.native.calls.length, world.native.writes.length, world.native.fences.acquired];
const readers = (world, { operation, token }, signal) => ({
  status: () => world.service.status(ACCOUNT_ID, operation.id, token),
  portalOperation: () => world.service.portalOperation(operation.id, token),
  portalEvidence: () => world.service.portalEvidence(operation.id, token),
  verifyDeal: () => world.service.verifyDeal({ accountId: ACCOUNT_ID, operationId: operation.id, token, ...(signal ? { signal } : {}) }),
});

test('a service constructed admitted and then re-held, with a purchase at agreement_pending with a signed Agreement and one settled_verified awaiting seller work: verifyDeal returns readback for both; seller, signer and broadcast counters stay 0; journals and rows are unchanged', async (t) => {
  setPurchaseAdmission('testnet-tp1');
  holdAfter(t);
  const world = await compositionWorld(t);
  const pending = world.seed({ status: 'agreement_pending', key: 'TEST-pending', protocolTerms: NATIVE_TERMS, state: { protocol: { stage: 'agreement-signing', agreement: SIGNED_AGREEMENT } } });
  const settled = world.seed({ status: 'settled_verified', key: 'TEST-settled', protocolTerms: NATIVE_TERMS, reportedTxHash: HASH, state: { protocol: { stage: 'seller-committed', agreement: SIGNED_AGREEMENT } } });
  setPurchaseAdmission('held');
  const before = world.rows();
  for (const purchase of [pending, settled]) {
    const result = await readers(world, purchase).verifyDeal();
    assert.equal(result.operation.id, purchase.operation.id);
    assert.ok(result.verification, 'a readback is returned, not a refusal');
  }
  assert.deepEqual(effects(world), [0, 0, 0, 0, 0]);
  assert.equal(world.rows(), before);
});

test('the constant flips to held at a barrier after verifyDeal\'s entry check and before its continuation: verifyDeal returns the diagnostic readback and the continuation runs 0 times; with the constant still admitted, a binding refusal at the same point rejects with its tp1_* cause', async (t) => {
  setPurchaseAdmission('testnet-tp1');
  holdAfter(t);
  const world = await compositionWorld(t);
  const purchase = world.seed({ status: 'agreement_pending', key: 'TEST-barrier', protocolTerms: NATIVE_TERMS, state: { protocol: { stage: 'agreement-signing', agreement: SIGNED_AGREEMENT } } });
  const before = world.rows();
  world.authority.state.gate = async () => { setPurchaseAdmission('held'); };
  const result = await readers(world, purchase).verifyDeal();
  assert.ok(result.verification, 'the diagnostic readback is returned');
  assert.equal(world.counters.buyerAccess, 1, 'only verifyDeal\'s own check ran; the continuation\'s protocol.recheck did not');
  assert.equal(world.rows(), before);
  setPurchaseAdmission('testnet-tp1');
  world.authority.state.gate = async () => { world.current.connectionId = 'vector-conn-2'; };
  await assert.rejects(readers(world, purchase).verifyDeal(), (error) => error.code === 'profile_not_admitted' && error.cause?.code === 'tp1_local_binding_changed');
});

test('admitted: verifyDeal\'s continuation calls protocol.recheck exactly once, after its K6 check', async (t) => {
  setPurchaseAdmission('testnet-tp1');
  holdAfter(t);
  const world = await compositionWorld(t);
  const purchase = world.seed({ status: 'agreement_pending', key: 'TEST-recheck', protocolTerms: NATIVE_TERMS, state: { protocol: { stage: 'agreement-signing', agreement: SIGNED_AGREEMENT } } });
  let accessBeforeCheck = -1, checks = 0;
  world.authority.state.gate = async () => { checks++; accessBeforeCheck = world.counters.buyerAccess; };
  await readers(world, purchase).verifyDeal();
  assert.equal(checks, 1, 'one K6 check for the one wrapped call');
  assert.equal(accessBeforeCheck, 1, 'only verifyDeal\'s own buyer-access check preceded the K6 check');
  assert.equal(world.counters.buyerAccess, 2, 'recheck ran once, after the check');
});

test('held: verifyDeal, status, portalOperation and portalEvidence return today\'s diagnostic projections (approvalUrl null)', async (t) => {
  setPurchaseAdmission('held');
  const world = await compositionWorld(t);
  const purchase = world.seed({ status: 'awaiting_approval', key: 'TEST-held-projection' });
  const read = readers(world, purchase);
  const status = read.status();
  assert.equal(status.approvalUrl, null);
  assert.match(status.next, /historical.*held/);
  assert.equal(read.portalEvidence().actionable, false);
  assert.equal(read.portalOperation().id, purchase.operation.id);
  assert.ok((await read.verifyDeal()).verification);
});

// Each cell names the diagnostic() read sites (purchases.mjs, by what they guard) its entry points reach.
const INCLUDED = { status: 'included', txHash: HASH, payer: '', payee: '', amountOs: '2500000000', blockNumber: 10 };
const CELLS = [
  { name: '(a) an expired agreement_pending purchase', sites: ['ownership check', 'nextFor', 'protocolFor', 'projectDiagnosticOperation (status, portalOperation)', 'expiry projection'],
    seed: { status: 'agreement_pending', key: 'TEST-expired', expiresAt: new Date(NOW - 1).toISOString(), protocolTerms: NATIVE_TERMS, state: { protocol: { stage: 'agreement-signing' } } } },
  { name: '(b) a native purchase with an included saved hash, read twice and with the read interrupted', sites: ['coordinates projection', 'history slice', 'diagnosticReadback entry', 'historical flag'],
    seed: { status: 'broadcast_reported', key: 'TEST-native', protocolTerms: NATIVE_TERMS, reportedTxHash: HASH }, repeat: true, interrupt: true, observe: true },
  { name: '(c) a non-native purchase whose ordinary reader sees an included transaction', sites: ['approvalUrl', 'actionable flag', 'diagnosticReadback in verifyDeal'],
    seed: { status: 'broadcast_reported', key: 'TEST-ordinary', reportedTxHash: HASH }, observe: true, expectPassiveFacts: true },
  // Marker text sits under key names the projection treats as signing material, nested in claim, payment evidence and delivery, and in event data.
  { name: '(d) saved state with nested strings holding marker text, an oversized receipt and a long event history', sites: ['projectDiagnostic (status, portalEvidence)', 'history slice', 'evidence projection'],
    seed: { status: 'settled_verified', key: 'TEST-marked', protocolTerms: NATIVE_TERMS, reportedTxHash: HASH, events: 120, eventData: { message: MARKER },
      state: { protocol: { stage: 'seller-committed', claim: { status: 'present', signature: MARKER }, paymentEvidence: { ref: 'TEST-ref', message: MARKER },
        delivery: { delivered: true, payload: { text: MARKER }, receipt: 'r'.repeat(5000) } } } } },
];

function everyString(value, visit) {
  if (typeof value === 'string') visit(value);
  else if (value !== null && typeof value === 'object') for (const member of Object.values(value)) everyString(member, visit);
}

test('held readback is write-free and leak-free for every purchase state and lane (extends tests 32 and 35)', async (t) => {
  setPurchaseAdmission('held');
  for (const cell of CELLS) {
    const world = await compositionWorld(t);
    const purchase = world.seed(cell.seed);
    const payer = world.wallet.address;
    if (cell.observe) world.chain.observePassiveTransfer = async () => ({ ...INCLUDED, payer, payee: world.ops.get(ACCOUNT_ID, purchase.operation.id).terms.seller.payee });
    const before = world.rows();
    const controller = new AbortController();
    if (cell.interrupt) controller.abort();
    for (const [entry, read] of Object.entries(readers(world, purchase, cell.interrupt ? controller.signal : undefined))) {
      for (let round = 0; round < (cell.repeat ? 2 : 1); round++) {
        const output = await read();
        const text = JSON.stringify(output);
        const leak = text.indexOf(MARKER);
        assert.ok(leak < 0, `${entry} (${cell.name}): no marker text, found near ${text.slice(Math.max(0, leak - 160), leak + 40)}`);
        assert.ok((output.history?.length ?? 0) <= DIAGNOSTIC_LIMITS.collectionItems, `${entry}: the event history is bounded, never the raw history`);
        everyString(output, (value) => assert.ok(value.length <= DIAGNOSTIC_LIMITS.stringChars, `${entry}: string of ${value.length} chars is bounded`));
        if (cell.expectPassiveFacts && entry === 'verifyDeal') {
          assert.equal(output.verification.observation.status, 'included');
          assert.notEqual(output.verification.outcome, 'readback_unverified');
          assert.notEqual(output.verification.observation.status, 'unavailable');
        }
      }
      assert.equal(world.rows(), before, `${entry}: row status, revision, events, journals and claims are unchanged`);
    }
    assert.deepEqual(effects(world), [0, 0, 0, 0, 0], cell.name);
  }
  // The three action guards (reportWalletResult, protocolRecheck, cancel) are only reachable on the unwrapped diagnostic service.
  const world = await compositionWorld(t);
  const purchase = world.seed({ status: 'broadcast_reported', key: 'TEST-guards', reportedTxHash: HASH });
  const diagnostic = createPublicPurchaseService({ db: world.db, ops: world.ops, coordinates: world.coordinates, chain: world.chain, config: {}, store: world.store, purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  const before = world.rows();
  for (const method of ['reportWalletResult', 'protocolRecheck', 'cancel']) {
    await assert.rejects(diagnostic[method]({ accountId: ACCOUNT_ID, operationId: purchase.operation.id, token: purchase.token }), { code: 'profile_not_admitted' }, method);
  }
  assert.equal(world.rows(), before);
});

// A wrapped protocol call that refuses admission never ran its original, so the
// service neither records it as a protocol outcome nor turns it into a result.
// Each case runs with the connection changed, and with the hold re-held, inside the protocol's authority read.
const ADMISSION_REFUSALS = [
  { label: 'the connection changes', change: (world) => { world.current.connectionId = 'vector-conn-2'; }, cause: 'tp1_local_binding_changed' },
  { label: 'the hold is re-held', change: () => setPurchaseAdmission('held'), cause: undefined },
];
const refusedAdmission = (cause) => (error) => error.code === 'profile_not_admitted' && (cause === undefined || error.cause?.code === cause);
// Arms the barrier for the authority read that follows `reads` earlier ones.
const refuseAfterReads = (world, reads, change) => {
  const target = world.authority.state.calls + reads;
  world.authority.state.gate = async () => { if (world.authority.state.calls === target) change(world); };
};
const eventTypes = (world, operation) => world.ops.history(operation.id).map((event) => event.type);

for (const { label, change, cause } of ADMISSION_REFUSALS) {
  test(`${label} inside a wrapped protocol call: issueApprovalChallenge rejects profile_not_admitted, records no event and issues no challenge`, async (t) => {
    setPurchaseAdmission('testnet-tp1');
    holdAfter(t);
    const world = await compositionWorld(t);
    const { operation, token } = world.seed({ status: 'awaiting_approval', key: 'TEST-challenge', protocolTerms: {}, currentListing: true });
    const before = world.rows();
    refuseAfterReads(world, 2, change);
    await assert.rejects(world.service.issueApprovalChallenge({ operationId: operation.id, token, address: world.wallet.address }), refusedAdmission(cause));
    assert.equal(world.rows(), before);
    assert.equal(world.counters.challengesIssued, 0);
  });

  test(`${label} inside a wrapped protocol call: prepareHandoff of an approved purchase rejects profile_not_admitted, with no event and no coordinates`, async (t) => {
    setPurchaseAdmission('testnet-tp1');
    holdAfter(t);
    const world = await compositionWorld(t);
    const { operation, token } = world.seed({ status: 'approved', key: 'TEST-handoff', protocolTerms: {}, currentListing: true });
    const before = world.rows();
    refuseAfterReads(world, 2, change);
    await assert.rejects(world.service.prepareHandoff({ operationId: operation.id, token }), refusedAdmission(cause));
    assert.equal(world.rows(), before);
    assert.equal(world.coordinates.get(operation.id), null);
  });

  test(`${label} inside a wrapped protocol call: prepareHandoff re-entry of a payment_handoff purchase at its nonce fence rejects profile_not_admitted and records neither a refusal nor a reissue`, async (t) => {
    setPurchaseAdmission('testnet-tp1');
    holdAfter(t);
    const world = await compositionWorld(t);
    const { operation, token } = world.seed({ status: 'payment_handoff', key: 'TEST-reissue', protocolTerms: {}, handoff: true });
    const before = world.rows();
    refuseAfterReads(world, 2, change);
    await assert.rejects(world.service.prepareHandoff({ operationId: operation.id, token }), refusedAdmission(cause));
    assert.equal(world.rows(), before);
  });
}

// verifyDeal on a settled or superseded native purchase, over a wrapped stand-in protocol that has the native readback methods.
const nativeSource = (nativePaymentSuperseded) => ({ available: true, nativePaymentReadbackAvailable: true, assertBuyerAccess() {}, recheck: async (operation) => operation, nativePaymentSuperseded, nativeIntentsSupersededBy: async () => [] });
const wrappedSource = (world, source) => admitPublicFactory(() => source, { passive: ['assertBuyerAccess'] })({ admission: world.admission });
const nativeService = (world, protocol) => createPublicPurchaseService({ db: world.db, ops: world.ops, coordinates: world.coordinates, store: world.store, chain: world.chain, config: {}, protocol,
  now: () => NOW, purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
function seedNativeOwner(world, key) {
  const owner = world.seed({ status: 'settled_verified', key, protocolTerms: NATIVE_TERMS, reportedTxHash: HASH });
  world.coordinates.recordObservation(owner.operation.id, { txHash: HASH, slotConsumed: true }, true);
  return owner;
}
// Both resolvers run through verifyDeal: the settled owner releases its own nonce, and a superseded purchase releases its lane.
const NATIVE_RESOLUTIONS = [
  { name: 'nonce consumption', pending: 'native_nonce_pending', seedTarget: (world) => seedNativeOwner(world, 'TEST-owner') },
  { name: 'supersession', pending: 'native_supersession_pending',
    seedTarget(world) {
      const owner = seedNativeOwner(world, 'TEST-owner');
      const target = world.seed({ status: 'superseded', key: 'TEST-superseded', protocolTerms: NATIVE_TERMS, handoff: true });
      world.coordinates.recordObservation(target.operation.id, { txHash: HASH, supersededBy: owner.operation.id }, false, null);
      return target;
    } },
];

for (const { name, pending, seedTarget } of NATIVE_RESOLUTIONS) {
  for (const { label, change, cause } of ADMISSION_REFUSALS) {
    test(`${label} inside a wrapped protocol call during native ${name}: verifyDeal ${cause ? 'rejects profile_not_admitted' : 'returns the diagnostic readback'} and writes no ${pending} event`, async (t) => {
      setPurchaseAdmission('testnet-tp1');
      holdAfter(t);
      const world = await compositionWorld(t);
      const target = seedTarget(world);
      const service = nativeService(world, wrappedSource(world, nativeSource(async () => true)));
      const before = world.rows();
      refuseAfterReads(world, 1, change);
      const read = service.verifyDeal({ accountId: ACCOUNT_ID, operationId: target.operation.id, token: target.token });
      if (cause) await assert.rejects(read, refusedAdmission(cause));
      else assert.ok((await read).verification, 'the diagnostic readback is returned');
      assert.equal(world.rows(), before);
      assert.ok(!eventTypes(world, target.operation).includes(pending));
    });
  }
}

// Guards: any other refusal from the protocol keeps the service's own recording.
test('a protocol refusal that is not an admission refusal is still recorded: commitment_recheck_refused with its code, and a resolved refused result from prepareHandoff', async (t) => {
  setPurchaseAdmission('testnet-tp1');
  holdAfter(t);
  const world = await compositionWorld(t);
  const challenge = world.seed({ status: 'awaiting_approval', key: 'TEST-guard-challenge', protocolTerms: {}, currentListing: true });
  await assert.rejects(world.service.issueApprovalChallenge({ operationId: challenge.operation.id, token: challenge.token, address: world.wallet.address }),
    (error) => error instanceof Error && error.code !== undefined && error.code !== 'profile_not_admitted');
  const recorded = world.ops.history(challenge.operation.id).find((event) => event.type === 'commitment_recheck_refused');
  assert.ok(recorded, 'the refusal is recorded');
  assert.notEqual(recorded.data.reason, 'profile_not_admitted');
  const handoff = world.seed({ status: 'approved', key: 'TEST-guard-handoff', protocolTerms: {}, currentListing: true });
  const result = await world.service.prepareHandoff({ operationId: handoff.operation.id, token: handoff.token });
  assert.equal(result.payload, null);
  assert.ok(result.refused && result.refused !== 'profile_not_admitted');
  assert.ok(eventTypes(world, handoff.operation).includes('handoff_refused'));
});

test('a source error that is not an admission refusal still records native_nonce_pending and native_supersession_pending and leaves the lane unresolved', async (t) => {
  setPurchaseAdmission('testnet-tp1');
  holdAfter(t);
  for (const { pending, seedTarget } of NATIVE_RESOLUTIONS) {
    const world = await compositionWorld(t);
    const target = seedTarget(world);
    const service = nativeService(world, nativeSource(async () => { throw new Error('TEST-source-unavailable'); }));
    const result = await service.verifyDeal({ accountId: ACCOUNT_ID, operationId: target.operation.id, token: target.token });
    assert.ok(result.verification);
    assert.ok(eventTypes(world, target.operation).includes(pending));
  }
});
