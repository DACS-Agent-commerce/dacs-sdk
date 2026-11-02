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
