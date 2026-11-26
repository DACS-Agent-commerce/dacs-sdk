// The seller's Node wallet over the real approval ledger: a policy-mode ledger file in the wallet's data directory, composed
// with composeSellerApproval, a scripted purchase source for the wallet's own seller claim, and readers of the ledger's lines.
// The scripted node and the wallet are the ones seller-node-wallet-world.mjs builds, so that file is imported first.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalize, contentHash, paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { createSellerNodeWallet, fixtureClaim, inWalletPass, keyRecordBytes, privateDataDirectory, replayNode, sellerWalletWorld, T0 } from './seller-node-wallet-world.mjs';
import { agreementHash, artifactAuthority, buyer, deliveredHashFor, JOBS, pin, PAYMENT_TX_REF, requestFor, sourceBinding as fixtureBinding } from './d5-policy-fixtures.mjs';

const { composeSellerApproval, createExactOperatorApproval, heldPolicyBudget, parsePolicyLedger } = await import('../../src/devnet-demo/operator-approval.mjs');

const CLAIM_PREFIX = 'did:demos:agent:';
const LEDGER_FILE = 'approvals.jsonl';
const OPERATOR_MAX_TOTAL_OS = '50000000000';
const PAYMENT_PHASE_INDEX = 2;
const SIGN_FORMAT = 'dacs-node2-seller-policy-sign-authorization/v1';
const RETAINED_CALLS = ['prepare', 'open', 'reopen', 'confirm', 'settle'];
// The binding members a buyer's Agreement shares with the seller's source binding.
const SHARED_BINDING_MEMBERS = ['network', 'chainIdentity', 'pinVersion', 'bindingVersion'];

/** The job ids the evidence inputs use. */
export { JOBS };

/** A SettlementEvidence anchor input for `job`, written by `claim`: a pay-dem artifact the ledger's policy admits. */
function evidenceInputFor(claim, job = JOBS[0]) {
  const request = requestFor({ artifactKind: 'SettlementEvidence', phase: 'pay-dem', job, editArtifact: artifact => { artifact.signature.signer = claim; } });
  const artifact = JSON.parse(request.content.exactStorageBytes);
  return { logicalAddress: paymentEvidenceAddress(job, 'demos-native:DEM', PAYMENT_PHASE_INDEX), artifact, writer: claim, artifactKind: 'SettlementEvidence', jobId: job,
    receiptContentHash: contentHash(artifact) };
}

const linesOf = text => text.split('\n').filter(Boolean).map(line => JSON.parse(line));

/**
 * Builds a seller Node wallet whose approval is the real policy ledger over `approvals.jsonl` in its data directory. `limits` are the
 * ledger's policy limits. The world adds `purchaseState` (`purchase` is the scripted purchase, `paid` the valid one to restore,
 * `purchaseError` makes the purchase read throw, `now` is the ledger's clock),
 * `confirmations` (how many times the confirmation gate ran, shared and retained), `retainedCalls` (the names of the retained calls
 * made, in order), `faults` (`faults[name] = (real, args) => ...` replaces a retained call), `anchor(input)`, `reconcile(input)`,
 * `reopen()` (the process dies and starts again over the same files: a new ledger object and a new wallet) and `ledger`, the readers.
 */
export async function ledgerWorld(t, { limits = {}, node = replayNode(), directory = privateDataDirectory(t) } = {}) {
  const claim = await fixtureClaim(), address = `0x${claim.slice(CLAIM_PREFIX.length)}`;
  const sourceBinding = { ...fixtureBinding, network: TP1_APPROVED_IDENTITY_RECORD.network, chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity };
  const paid = { seller: claim, buyer, listingPin: pin, sourceBinding, agreementHash, amountOs: '1000000000', paymentObserved: true, paymentTxRef: { ...PAYMENT_TX_REF }, prePaymentOpen: false };
  const state = { purchase: paid, paid, now: T0, purchaseError: null, confirmations: { shared: 0, retained: 0 }, retainedCalls: [], faults: {} };
  const evidencePath = join(directory, LEDGER_FILE);
  const policyInputs = { address, seller: claim, sourceBinding, artifactAuthority, listingPin: () => pin, paymentPhaseIndex: () => PAYMENT_PHASE_INDEX, deliveryPhaseIndex: () => 3,
    deliveredPayloadHash: deliveredHashFor,
    resolvePurchase: async jobId => { if (state.purchaseError) throw state.purchaseError; return state.purchase && { jobId, ...state.purchase }; } };

  const openApproval = () => {
    const policy = createExactOperatorApproval({ maxTotalOs: OPERATOR_MAX_TOTAL_OS, evidencePath, now: () => state.now, sellerApproval: { mode: 'policy', ...limits }, policy: policyInputs });
    t.after(() => policy.stop());
    const approve = composeSellerApproval({ mode: 'policy', policy, manual: () => assert.fail('the operator was asked') });
    const { confirm } = approve, { retained } = approve;
    approve.confirm = (...args) => { state.confirmations.shared++; return confirm(...args); };
    // Each retained call is recorded, and runs through `faults[name](real, args)` when a test set one.
    const retainedCall = name => (...args) => {
      state.retainedCalls.push(name);
      if (name === 'confirm') state.confirmations.retained++;
      return state.faults[name] ? state.faults[name](retained[name], args) : retained[name](...args);
    };
    approve.retained = Object.fromEntries(RETAINED_CALLS.map(name => [name, retainedCall(name)]));
    return approve;
  };

  const world = await sellerWalletWorld(t, { directory, node, options: { approve: openApproval() } });
  // The policy's source binding is the seller transport's own, whole. The buyer's Agreement binding keeps the buyer's endpoint and
  // authority and shares only the tuple with it. The fixture binding above only lets the policy be constructed before the wallet.
  const sellerBinding = JSON.parse(canonicalize(world.wallet.sourceCapability.transportBinding));
  policyInputs.sourceBinding = sellerBinding;
  paid.sourceBinding = { ...fixtureBinding, ...Object.fromEntries(SHARED_BINDING_MEMBERS.map(key => [key, sellerBinding[key]])) };
  const assertBindings = () => {
    const transportBinding = canonicalize(world.wallet.sourceCapability.transportBinding);
    assert.equal(canonicalize(policyInputs.sourceBinding), transportBinding, 'the policy binds the seller transport');
    assert.equal(canonicalize(world.sourceBinding), transportBinding);
    const buyerBinding = state.paid.sourceBinding, seller = policyInputs.sourceBinding;
    assert.ok(SHARED_BINDING_MEMBERS.every(key => buyerBinding[key] === seller[key]), 'the buyer shares the tuple');
    assert.ok(buyerBinding.endpoint !== seller.endpoint && buyerBinding.transportAuthority !== seller.transportAuthority, 'the buyer keeps its own endpoint and authority');
    assert.deepEqual(Object.keys(buyerBinding).sort(), Object.keys(fixtureBinding).sort(), 'the buyer binding has no seller publication member');
  };
  const text = () => readFile(evidencePath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
  const rows = async () => parsePolicyLedger(await text()).rows;
  const ledger = {
    path: evidencePath,
    lines: async () => linesOf(await text()),
    rows,
    signLines: async () => (await ledger.lines()).filter(line => line.format === SIGN_FORMAT),
    completions: async id => (await ledger.lines()).filter(line => line.reservationId === id && line.outcome),
    linked: async id => (await ledger.lines()).filter(line => line.reservationId === id && line.confirmation),
    open: async () => (await rows()).filter(row => row.signAuthorized && row.outcome === null),
    budget: async () => heldPolicyBudget(await rows(), state.now),
  };
  Object.assign(world, {
    claim, address, sourceBinding: sellerBinding, ledger, evidenceInput: job => evidenceInputFor(claim, job), purchaseState: state, confirmations: state.confirmations, retainedCalls: state.retainedCalls,
    faults: state.faults,
    anchor: input => inWalletPass(world, () => world.wallet.paymentEvidence.anchorEvidence(input)),
    reconcile: input => inWalletPass(world, () => world.wallet.paymentEvidence.reconcilePaymentEvidence(input)),
    reopen: async () => {
      await world.wallet.close();
      world.approve = openApproval();
      world.options = { ...world.options, approve: world.approve };
      world.approval = world.approve.retained;
      world.wallet = await createSellerNodeWallet({ ...world.options, journalMode: 'open', keyRecord: keyRecordBytes() });
      assertBindings();
    },
  });
  assertBindings();
  return world;
}
