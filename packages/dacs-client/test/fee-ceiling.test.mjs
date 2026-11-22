// The host's per-write fee ceiling on the two purchase factories: the construction check, and the check made at each paid
// write (the payment handoff, its re-offer, the cancel release and the buyer's Agreement CREATE) before anything is saved,
// moved, offered to the wallet or sent to the seller. The hold is lifted through the test resolve hook.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fixedPriceAgreementLogicalAddress } from '@kynesyslabs/dacs';
import { setPurchaseAdmission, T0 } from './helpers/wire-client-fixture.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';

beforeEach((t) => t.mock.method(Date, 'now', () => T0));
const { compositionWorld, ACCOUNT_ID, TESTNET_FEE_CEILING_OS } = await import('./helpers/public-composition-world.mjs');
const { sellerFlow } = await import('./helpers/stored-request-flows.mjs');
const client = await import('../src/index.mjs');
const { admitPublicFactory } = await import('../src/public-admission.mjs');
const { createPurchaseService: createInternalPurchaseService } = await import('../src/purchases.mjs');
const { DemosSr2BridgeError } = await import('../src/dacs/demos-sr2-wallet-bridge.mjs');
const { claimForAddress } = await import('../src/signatures.mjs');

// The composed price is 2.5 DEM and the chain double's fee is 1 OS.
const PRICE_OS = '2500000000';
const PRICE_PLUS_FEE_OS = '2500000001';
const ONE_DEM_OS = '1000000000';
const STORAGE_RESERVE_OS = '3000000000';
const SLOT_HASH = 'e'.repeat(64);
const OTHER_PAYEE = '0x' + '5'.repeat(64);
const MALFORMED_CEILINGS = [undefined, null, '', '0', '-1', '1.5', '01', ' 1', '1e9', 50_000_000_000, 50_000_000_000n, {}];

const refusesCeiling = (error) => error instanceof TypeError && error.message === 'fee_ceiling_required';
const refusesWriteFee = (error) => error?.code === 'write-fee-cap';
const PUBLIC_FACTORIES = [['createPurchaseService', () => client.createPurchaseService], ['createProtocolPurchases', () => client.createProtocolPurchases]];

// Construction inputs whose every read is counted, so a refusal can show it touched no store.
async function countedOptions() {
  const { binding, currentLocal } = await bindFixture();
  const reads = { count: 0 };
  const counted = () => new Proxy({}, { get() { reads.count++; return () => {}; } });
  const chain = { getTransactionFees: async () => { reads.count++; return 1n; } };
  return { reads, options: { db: counted(), store: counted(), ops: counted(), coordinates: counted(), admission: { binding, currentLocal }, stopped: () => false, chain } };
}

async function admittedWorld(t, options) {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  return compositionWorld(t, options);
}

const handoffRequest = ({ operation, token }) => ({ operationId: operation.id, token });

test('a public purchase factory without a valid per-write fee ceiling throws fee_ceiling_required before reading any store, and the earlier construction refusals keep their codes', async () => {
  const { reads, options } = await countedOptions();
  for (const [name, factory] of PUBLIC_FACTORIES) {
    for (const feeCeilingOs of MALFORMED_CEILINGS) {
      assert.throws(() => factory()({ ...options, feeCeilingOs }), refusesCeiling, `${name} ${String(feeCeilingOs)}`);
    }
    assert.throws(() => factory()({ ...options, stopped: undefined }), (error) => error.message === 'stopped_required', name);
    assert.throws(() => factory()({ ...options, passiveOnly: false }), (error) => error.message === 'passive_only_invalid', name);
    assert.throws(() => factory()({ ...options, admission: undefined }), (error) => error.message === 'admission_required', name);
  }
  assert.equal(reads.count, 0);
});

test('passing feeCeiling: false in the options does not turn off the ceiling check on either public factory', async () => {
  const { reads, options } = await countedOptions();
  for (const [name, factory] of PUBLIC_FACTORIES) {
    assert.throws(() => factory()(options), refusesCeiling, name);
    for (const feeCeiling of [false, true]) assert.throws(() => factory()({ ...options, feeCeiling }), refusesCeiling, `${name} feeCeiling ${feeCeiling}`);
  }
  assert.equal(reads.count, 0);
});

test('a public purchase factory whose chain has no getTransactionFees function throws fee_ceiling_required; the stop-seam wrapper and the listing verifier construct without a ceiling', async () => {
  const { reads, options } = await countedOptions();
  for (const [name, factory] of PUBLIC_FACTORIES) {
    for (const [label, chain] of [['no chain', undefined], ['null chain', null], ['no fee reader', {}], ['a fee value, not a reader', { getTransactionFees: 1n }]]) {
      assert.throws(() => factory()({ ...options, feeCeilingOs: TESTNET_FEE_CEILING_OS, chain }), refusesCeiling, `${name}: ${label}`);
    }
  }
  assert.equal(reads.count, 0, 'construction never reads the fee');
  const wrapped = admitPublicFactory(() => ({ act: () => 1 }), { stopSeam: true })({ admission: options.admission, stopped: () => false });
  assert.equal(typeof wrapped.act, 'function');
  assert.equal(typeof client.createListingVerifier({ admission: options.admission, directory: {}, chain: {} }).verify, 'function');
});

test('a passiveOnly purchase composition without a fee ceiling constructs and its passive readers answer', async (t) => {
  const world = await compositionWorld(t, { passiveOnly: true, feeCeilingOs: null });
  const { operation, token } = world.seed({ status: 'awaiting_approval', key: 'TEST-passive' });
  assert.equal(world.service.status(ACCOUNT_ID, operation.id, token).operation.id, operation.id);
  assert.equal(world.service.portalOperation(operation.id, token).id, operation.id);
  assert.doesNotThrow(() => world.protocol.supportsMode(operation));
});

test('a payment handoff whose price plus fee is over the ceiling refuses write-fee-cap with nothing saved, moved or offered; price plus fee equal to the ceiling proceeds', async (t) => {
  for (const feeCeilingOs of [PRICE_OS, '1']) {
    const world = await admittedWorld(t, { feeCeilingOs });
    const purchase = world.seed({ status: 'approved', key: 'TEST-over', currentListing: true });
    const before = world.rows();
    await assert.rejects(world.service.prepareHandoff(handoffRequest(purchase)), refusesWriteFee, `ceiling ${feeCeilingOs}`);
    assert.equal(world.rows(), before, 'no coordinates, transition or event');
    assert.equal(world.coordinates.get(purchase.operation.id), null);
    assert.equal(world.ops.get(ACCOUNT_ID, purchase.operation.id).status, 'approved');
  }
  const world = await admittedWorld(t, { feeCeilingOs: PRICE_PLUS_FEE_OS });
  const purchase = world.seed({ status: 'approved', key: 'TEST-equal', currentListing: true });
  const result = await world.service.prepareHandoff(handoffRequest(purchase));
  assert.ok(result.payload, 'the payment is offered');
  assert.equal(world.ops.get(ACCOUNT_ID, purchase.operation.id).status, 'payment_handoff');
});

test('a stored payment handoff re-offered under a ceiling below its amount plus fee refuses write-fee-cap and records no reissue', async (t) => {
  const world = await admittedWorld(t, { feeCeilingOs: PRICE_OS });
  const purchase = world.seed({ status: 'payment_handoff', key: 'TEST-reoffer', handoff: true });
  const before = world.rows();
  await assert.rejects(world.service.prepareHandoff(handoffRequest(purchase)), refusesWriteFee);
  assert.equal(world.rows(), before);
  assert.doesNotMatch(world.rows(), /handoff_reissued/);
  const allowed = await admittedWorld(t, { feeCeilingOs: PRICE_PLUS_FEE_OS });
  const reoffered = allowed.seed({ status: 'payment_handoff', key: 'TEST-reoffer-allowed', handoff: true });
  assert.ok((await allowed.service.prepareHandoff(handoffRequest(reoffered))).payload);
  assert.match(allowed.rows(), /handoff_reissued/);
});

test('a cancel whose release transfer plus fee is over the ceiling refuses write-fee-cap and leaves the purchase unchanged', async (t) => {
  const world = await admittedWorld(t, { feeCeilingOs: ONE_DEM_OS });
  const purchase = world.seed({ status: 'payment_handoff', key: 'TEST-cancel', handoff: true });
  const before = world.rows();
  await assert.rejects(world.service.cancel({ accountId: ACCOUNT_ID, operationId: purchase.operation.id }), refusesWriteFee);
  assert.equal(world.rows(), before);
  assert.equal(world.ops.get(ACCOUNT_ID, purchase.operation.id).status, 'payment_handoff');
  const allowed = await admittedWorld(t, { feeCeilingOs: '1000000001' });
  const releasable = allowed.seed({ status: 'payment_handoff', key: 'TEST-cancel-allowed', handoff: true });
  const result = await allowed.service.cancel({ accountId: ACCOUNT_ID, operationId: releasable.operation.id });
  assert.ok(result.release, 'the release transfer is offered');
  assert.equal(result.operation.status, 'payment_uncertain');
});

test('a cancel whose nonce slot already holds the wallet\'s own other transaction answers that transaction whatever the fee', async (t) => {
  const world = await admittedWorld(t);
  const purchase = world.seed({ status: 'payment_handoff', key: 'TEST-slot', handoff: true });
  Object.assign(world.chain, {
    getTransactionFees: async () => 10n ** 20n,
    getAddressNonce: async () => 7,
    findTransferAtNonce: async () => ({ status: 'found', hash: SLOT_HASH }),
    observeTransfer: async () => ({ status: 'included', txHash: SLOT_HASH, payer: world.wallet.address, payee: OTHER_PAYEE, amountOs: '5', blockNumber: 10 }),
    getTransaction: async () => ({ hash: SLOT_HASH, status: 'confirmed', content: { from: world.wallet.address, nonce: 7 } }),
  });
  const result = await world.service.cancel({ accountId: ACCOUNT_ID, operationId: purchase.operation.id });
  assert.equal(result.slotTxHash, SLOT_HASH);
  assert.equal(result.release, undefined);
});

test('a listing priced over the ceiling is refused write-fee-cap at protocol start, before the Agreement write', async (t) => {
  for (const feeCeilingOs of [PRICE_OS, STORAGE_RESERVE_OS]) {
    const world = await admittedWorld(t, { feeCeilingOs });
    const { operation } = await world.prepare();
    const token = world.ops.handoffTokenFor(operation.id);
    const before = world.rows();
    const effects = () => [world.counters.sellerLookups, world.native.calls.length, world.native.writes.length];
    const effectsBefore = effects();
    await assert.rejects(world.service.agreementIdentity({ operationId: operation.id, token, address: world.wallet.address }), refusesWriteFee, `ceiling ${feeCeilingOs}`);
    assert.equal(world.rows(), before);
    assert.deepEqual(effects(), effectsBefore, 'no seller request or native call');
    assert.equal(world.ops.get(ACCOUNT_ID, operation.id).state.protocol.planned, undefined, 'no Agreement plan');
  }
  const world = await admittedWorld(t);
  assert.ok((await world.preparedWithIdentity()).signature, 'under the ceiling the buyer is asked to sign');
});

// The buyer's Agreement submission through the real protocol factory; the seller proposal is the first request the exchange sends.
async function agreementSubmission(t, factoryOptions, { arrange = () => {}, configOverrides } = {}) {
  let flow, service;
  const outcome = sellerFlow(t, 'agreement', (s, state, built) => { flow = s; service = built; return arrange(s, state); }, configOverrides, factoryOptions)
    .then(({ result }) => ({ result }), (error) => ({ error }));
  const settled = await outcome;
  return { ...settled, flow, service };
}
const eventCount = (flow) => flow.p.db.prepare('SELECT count(*) AS n FROM operation_events').get().n;
const failingFees = { getTransactionFees: async () => { throw new Error('TEST-fee-unavailable'); } };

test('a buyer Agreement write whose fee plus storage reserve is over the ceiling refuses before signatures are saved, the seller is asked or a CREATE intent is kept; one at the ceiling proceeds; a missing or unreadable fee refuses', async (t) => {
  for (const [label, factoryOptions] of [['over the ceiling', { chain: { getTransactionFees: async () => 2n }, feeCeilingOs: '3000000001' }],
    ['no fee reader', { chain: {} }], ['unreadable fee', { chain: failingFees }]]) {
    const { error, flow, service } = await agreementSubmission(t, factoryOptions);
    assert.ok(refusesWriteFee(error), label);
    if (label === 'unreadable fee') assert.equal(error.cause?.message, 'TEST-fee-unavailable');
    const before = { row: JSON.stringify(flow.p.get()), events: eventCount(flow) };
    await assert.rejects(service.submitAgreement(flow.p.get(), { agreementSignature: 'TEST-new-signature' }), refusesWriteFee, label);
    assert.deepEqual({ row: JSON.stringify(flow.p.get()), events: eventCount(flow) }, before, `${label}: nothing saved`);
    assert.equal(flow.p.get().state.protocol.signatures.agreement, 'TEST-retained-contribution', label);
    assert.equal(flow.p.get().state.protocol.walletAnchor, undefined, label);
    assert.deepEqual([flow.fetches.length, flow.w.state.signs.length], [0, 0], `${label}: no seller request`);
  }
  const { error, flow } = await agreementSubmission(t, { feeCeilingOs: '3000000001' });
  assert.equal(error, undefined);
  assert.equal(flow.fetches.length, 1, 'the seller proposal is sent');
});

test('an Agreement write ceiling at or above the CREATE network fee but below the fee plus storage reserve refuses', async (t) => {
  const { error, flow } = await agreementSubmission(t, { feeCeilingOs: STORAGE_RESERVE_OS, chain: { getTransactionFees: async () => 1n } });
  assert.ok(refusesWriteFee(error));
  assert.equal(flow.fetches.length, 0);
});

// The retained intent `anchorAgreement` expects for this purchase's Agreement.
function retainedIntent(flow) {
  const jobId = flow.w.job.jobId;
  return { logicalAddress: fixedPriceAgreementLogicalAddress(jobId), artifact: flow.made.agreement, writer: claimForAddress(flow.p.get().terms.buyer.wallet),
    artifactKind: 'Agreement', jobId, receiptContentHash: flow.made.agreementHash };
}

// Submits a purchase that already keeps a CREATE intent; the exchange reaches the anchor step, as the real coordinator does once
// the seller has the proposal. Returns the anchor step's answer and the events written after the intent was seeded.
async function resumeRetainedIntent(t, factoryOptions, bridge) {
  let anchorAnswer, intentEvents = 0;
  const { error, flow } = await agreementSubmission(t, factoryOptions, {
    configOverrides: { walletAgreement: { bridgeFor: () => bridge } },
    arrange: (s, state) => {
      s.patch({ walletAnchor: retainedIntent(s) });
      intentEvents = eventCount(s);
      state.exchange = async ({ anchorAdapter }) => {
        const intent = retainedIntent(s);
        anchorAnswer = await anchorAdapter.anchorAgreement({ artifact: intent.artifact, agreementHash: intent.receiptContentHash, logicalAddress: intent.logicalAddress });
        return { disposition: 'indeterminate', stage: 'agreement-anchor', reason: 'TEST-retained' };
      };
    },
  });
  const newEvents = JSON.stringify(flow.p.db.prepare('SELECT * FROM operation_events').all().slice(intentEvents));
  return { error, anchorAnswer, newEvents };
}

// A wallet bridge that records its calls; `resume` answers with `resumeAnswer`, which may throw.
function recordingBridge(resumeAnswer) {
  const calls = [];
  return { calls, bridge: { resume: async () => { calls.push('resume'); return resumeAnswer(); }, anchor: async () => { calls.push('anchor'); return { status: 'indeterminate' }; } } };
}

test('a retained Agreement CREATE intent still resumes under a lowered ceiling and under an unreadable fee, and no new CREATE is issued', async (t) => {
  for (const [label, factoryOptions] of [['lowered ceiling', { feeCeilingOs: '1' }], ['unreadable fee', { chain: failingFees }]]) {
    const { calls, bridge } = recordingBridge(() => ({ status: 'indeterminate', code: 'TEST-readback-pending' }));
    const { error, anchorAnswer, newEvents } = await resumeRetainedIntent(t, factoryOptions, bridge);
    assert.equal(error, undefined, label);
    assert.equal(anchorAnswer.disposition, 'indeterminate', label);
    assert.deepEqual(calls, ['resume'], label);
    assert.doesNotMatch(newEvents, /protocol_wallet_anchor_intent/, label);
  }
});

// The real bridge's `resume` refuses a plan that is still prepared with authorization-required, before any wallet request.
test('a retained intent whose wallet plan is still prepared, under a lowered ceiling and with no fee reader, keeps the resume refusal authorization-required with no wallet request and no new intent', async (t) => {
  const { calls, bridge } = recordingBridge(() => { throw new DemosSr2BridgeError('authorization-required', 'resume cannot issue a wallet handoff'); });
  const { error, anchorAnswer, newEvents } = await resumeRetainedIntent(t, { feeCeilingOs: '1', chain: {} }, bridge);
  assert.equal(error, undefined);
  assert.match(anchorAnswer.reason, /^wallet anchor: authorization-required:/);
  assert.deepEqual(calls, ['resume'], 'no anchor, so no wallet request');
  assert.doesNotMatch(newEvents, /protocol_wallet_anchor_intent/);
});

test('an internal purchase factory given no ceiling refuses each paid write with write-fee-cap', async (t) => {
  const world = await admittedWorld(t);
  const service = createInternalPurchaseService({ db: world.db, ops: world.ops, coordinates: world.coordinates, store: world.store, chain: world.chain, protocol: world.protocol,
    accounts: { listWallets: () => [{ address: world.wallet.address }] }, verifier: { verify: async () => assert.fail('the ceiling refuses before the listing is read') },
    challenges: {}, config: { demAmountEncoding: 'os-string', publicOrigin: 'https://portal.example.invalid' }, purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  const approved = world.seed({ status: 'approved', key: 'TEST-internal-handoff', currentListing: true });
  const handedOff = world.seed({ status: 'payment_handoff', key: 'TEST-internal-reoffer', handoff: true });
  const before = world.rows();
  await assert.rejects(service.prepareHandoff(handoffRequest(approved)), refusesWriteFee, 'handoff');
  await assert.rejects(service.prepareHandoff(handoffRequest(handedOff)), refusesWriteFee, 're-offer');
  await assert.rejects(service.cancel({ accountId: ACCOUNT_ID, operationId: handedOff.operation.id }), refusesWriteFee, 'cancel release');
  assert.equal(world.rows(), before);
  const { error, flow } = await agreementSubmission(t, { feeCeilingOs: undefined });
  assert.ok(refusesWriteFee(error), 'Agreement CREATE');
  assert.equal(flow.fetches.length, 0);
});
