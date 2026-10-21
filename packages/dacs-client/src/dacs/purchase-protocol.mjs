import { assertPurchaseActionsAdmitted } from './action-admission.mjs';
import { signatureCommitmentAnchor } from './commit-on-signature.mjs';
// One fixed-price native-DEM DACS purchase between a buyer (this plugin, with
// the user's own wallet) and a seller agent acting as phase orchestrator.
//
// Every protocol artifact is built and checked by the pinned @kynesyslabs/dacs
// SDK (Standard pin d45c0a2): Agreement derivation, signing plan and the
// buyer-owned durable exchange (advanceFixedPriceAgreementDurable), the
// finality-commitment gate (commitFixedPriceAgreement, read/resume only on the
// buyer side), SettlementEvidence verification (verifySettlementEvidence) and
// DACS-5 two-sided bundle construction/validation (buildTwoSidedBundle,
// verifyBundleCopy, bundlesDiverge). This module supplies only adapters:
// wallet signatures, the seller transport and the SR-2 substrate.
//
// Known, explicit limits of this slice (also in each status this produces):
//  - SR-2 reads use an explicit source-pinned single-node observation.
//  - DACS-2 Vet is NOT performed: each AgreementParty.vetRecordRef is an
//    unresolved placeholder at the canonical composite address, except in the
//    opt-in offline wallet profile with an operator-configured context
//    provider, whose refs the plugin binds but does not itself verify.
//  - The DACS-5 copies are built and validated with the two-sided bundle
//    primitives; the strict ST-11 finalizers (finalizeCompletedSellerBundleCore
//    and the buyer counterparts) are not used because they require DACS-2
//    composite-record closure and the V2 fulfilment handoff.
import {
  advanceFixedPriceAgreementDurable,
  attestationBundleHash,
  baseUnits,
  buildTwoSidedBundle,
  bundleAddress,
  bundlesDiverge,
  canonicalize,
  commitFixedPriceAgreement,
  compositeVerificationAddress,
  contentHash,
  createFixedPriceAgreementSigningPlan,
  createInMemoryFencedSessionStore,
  deriveFixedPriceAgreement,
  ed25519Verify,
  finalityCommitmentAddress,
  fixedPriceAgreementLogicalAddress,
  fixedPriceAgreementSignedBytes,
  identityBundleHash,
  isPayeeBoundAgreementDocument,
  isCanonicalJobId,
  isSettlementEvidence,
  paymentEvidenceAddress,
  publicKeyFromRaw,
  sha256Hex,
  verifyBundleCopy,
  verifySettlementEvidence,
  ARTIFACT_SEPARATORS,
} from '@kynesyslabs/dacs';
import { DEM_RAIL, DEM_DECIMALS, verifyComponent, utf8, deliverableAccessProblem, demPriceProblem } from './listing.mjs';
import { addressForClaim, claimForAddress } from '../signatures.mjs';
import { verifyFixtureReceipt, verifyFixtureRecord } from '../seams/seller-integration-not-wired.mjs';
import { canonicalSignature } from '../signatures.mjs';
import { artifactRef as fixtureRef, artifactTxRef as fixtureTxRef } from './artifact-reference.mjs';

export const PROTOCOL_PROFILE = 'dacs-chatgpt-plugin/fixed-price-pay-dem/v1';
export const ORCHESTRATION = 'seller-as-phase-orchestrator-v1';
// The DEM rail is the in-code PA-1 definition. The SDK seller intake requires
// a positive session rail-registry pin, so this slice pins version 1 for that
// in-code definition; no rail or recipe registry snapshot is authenticated.
export const RAIL_REGISTRY_VERSION = 1;
export const RECIPE_REGISTRY_VERSION = 0;
export const VET_NOT_PERFORMED = 'dacs-chatgpt-plugin/vet-not-performed/v1';
export const SUPPORTED_PIPELINE = Object.freeze(['negotiate-fixed-price', 'commit-payee-bound-agreement', 'pay-dem', 'deliver-storage-program']);
export const DEM_RAIL_DEFINITION = Object.freeze({
  railVersion: DEM_RAIL.railVersion,
  railId: DEM_RAIL.railId,
  availability: 'disabled',
  railType: 'demos-native',
  asset: Object.freeze({ kind: 'native-dem', symbol: 'DEM', decimals: DEM_DECIMALS }),
  network: Object.freeze({ kind: 'demos' }),
  phaseHandler: 'pay-dem',
  parameters: Object.freeze({}),
});

// Wording layers kept apart in every status (never merged into one "done").
export const PROTOCOL_LIMITS = Object.freeze({
  substrate: 'simulated-loopback-fixture',
  vet: 'not-performed',
  railRegistry: 'in-code-pa1-dem-rail; operational pin 1; no registry snapshot authenticated',
  bundleFinalization: 'two-sided-copies-validated; strict-ST-11-finalizer-not-used',
  finality: 'rail-model-bft-final-reported-by-one-node; not-independently-established',
  humanAcceptance: 'not-recorded',
});

// SDK address of the deliverable and of the delivery evidence. The pinned SDK
// derives `dacs4:deliverable:{jobId}` in its fulfilment core and
// `dacs4:evidence:{jobId}` in its session core; neither helper is exported.
const jobAddress = (kind, jobId) => {
  if (!isCanonicalJobId(jobId)) throw new TypeError('canonical JID-1 jobId required');
  return `dacs4:${kind}:${jobId}`;
};
export const deliverableAddress = (jobId) => jobAddress('deliverable', jobId);
export const deliveryEvidenceAddress = (jobId) => jobAddress('evidence', jobId);
// Delivery is final once delivered, or at delivery-ready with no delivery
// evidence pending or held (the profile publishes no delivery evidence).
// While evidence is pending, the seller may still have to be asked again.
export const deliveryIsFinal = (protocol) => protocol?.stage === 'delivered' || (protocol?.stage === 'delivery-ready' && !protocol.delivery?.evidenceHold);
export { finalityCommitmentAddress, fixedPriceAgreementLogicalAddress, paymentEvidenceAddress, bundleAddress };

const DID_PREFIX = 'did:demos:agent:';

export function claimPublicKeyRaw(claim) {
  if (typeof claim !== 'string' || !claim.startsWith(DID_PREFIX)) return null;
  const raw = Buffer.from(claim.slice(DID_PREFIX.length), 'hex');
  return raw.length === 32 ? new Uint8Array(raw) : null;
}

const verifyClaim = (signer, bytes, value, algorithm = 'ed25519') => verifyComponent({ signedBytes: bytes, signature: { algorithm, signer, value } });

// SDK verifier callbacks: Agreement contributions, commitment signatures,
// SettlementEvidence and bundle copies are all did:demos:agent Ed25519.
export const contributionVerifier = ({ party, algorithm, value, signedBytes }) => (verifyClaim(party, signedBytes, value, algorithm) ? 'valid' : 'invalid');
export const commitmentVerifier = ({ signer, algorithm, value, signedBytes }) => (verifyClaim(signer, signedBytes, value, algorithm) ? 'valid' : 'invalid');
export const ed25519Deps = Object.freeze({
  resolvePublicKey: async (signer) => claimPublicKeyRaw(signer),
  verify: (bytes, signature, publicKey) => {
    try {
      return ed25519Verify(bytes, signature, publicKeyFromRaw(Buffer.from(publicKey)));
    } catch {
      return false;
    }
  },
});

export const plainJson = (value) => JSON.parse(JSON.stringify(value));

export function listingPin(listing) {
  return { listingId: listing.listingId, version: listing.listingVersion, contentHash: contentHash(listing) };
}

// Exactly the four-step pipeline this slice implements, on the DEM rail.
export function protocolSupport(listing) {
  const kinds = Array.isArray(listing?.pipeline) ? listing.pipeline.map((p) => p?.kind) : [];
  const reasons = [];
  if (canonicalize(kinds) !== canonicalize(SUPPORTED_PIPELINE)) reasons.push(`pipeline is not ${SUPPORTED_PIPELINE.join(' -> ')}`);
  const pay = listing?.pipeline?.[2];
  if (pay?.kind === 'pay-dem' && pay.parameters?.rail !== DEM_RAIL.railId) reasons.push('pay-dem phase is not on demos-native:DEM');
  if (listing?.offering?.deliverable?.kind !== 'storage-program') reasons.push('deliverable is not a storage-program');
  const access = deliverableAccessProblem(listing);
  if (access) reasons.push(access);
  if (listing?.pricing?.kind !== 'fixed' || listing?.pricing?.price?.currency !== 'DEM') reasons.push('pricing is not fixed DEM');
  // The seller takes no session whose payment it could not verify (listing.mjs).
  const price = demPriceProblem(listing);
  if (price) reasons.push(price);
  return { supported: reasons.length === 0, reasons, phases: { commit: 1, payment: 2, delivery: 3 } };
}

// DACS-2 Vet is not performed in this slice. The reference names the
// canonical composite address; nothing is anchored there.
export function vetNotPerformedRef(jobId, party) {
  return {
    anchor: { kind: 'storage-program', locator: compositeVerificationAddress(jobId, party) },
    contentHash: sha256Hex(canonicalize({ marker: VET_NOT_PERFORMED, jobId, party })),
  };
}

// The one Agreement derivation both sides perform independently.
export function agreementInput({ jobId, listing, buyerBundle, generatedAt }) {
  assertPurchaseActionsAdmitted();
  const sellerBundle = listing.seller.identity;
  return {
    jobId,
    verifiedListing: { disposition: 'verified', listing, pin: listingPin(listing) },
    buyer: { identityBundle: buyerBundle, vetRecordRef: vetNotPerformedRef(jobId, buyerBundle.presentedBy) },
    seller: { identityBundle: sellerBundle, vetRecordRef: vetNotPerformedRef(jobId, sellerBundle.presentedBy) },
    selectedRail: { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion },
    payoutBindings: [{ railId: DEM_RAIL.railId, phaseIndex: protocolSupport(listing).phases.payment, payeeAddress: addressForClaim(sellerBundle.presentedBy) }],
    generatedAt,
  };
}

// Buyer: the exact Agreement plan and the two wallet messages it needs (the
// Agreement signature and the SR-2 write authorization for its anchor).
export function planAgreement({ jobId, listing, buyerBundle, generatedAt }) {
  assertPurchaseActionsAdmitted();
  return planAgreementFromInput(agreementInput({ jobId, listing, buyerBundle, generatedAt }));
}

// The same SDK derivation and signing plan from a full derive input that an
// operator-configured context provider resolved; agreement-context-consumer.mjs
// has bound it to the purchase scope. Nothing here alters SDK output.
export function planAgreementFromInput(input) {
  assertPurchaseActionsAdmitted();
  const draft = deriveFixedPriceAgreement(input);
  const plan = createFixedPriceAgreementSigningPlan(draft);
  const logicalAddress = fixedPriceAgreementLogicalAddress(input.jobId);
  return {
    draft,
    plan,
    agreementMessage: utf8(fixedPriceAgreementSignedBytes(plan)),
    anchorAddress: logicalAddress,
    anchorMessage: null,
  };
}

// What the Agreement fixes, for display and for the payment binding.
export function agreementTerms(agreement) {
  const buyer = agreement.parties.find((p) => p.role === 'buyer');
  const seller = agreement.parties.find((p) => p.role === 'seller');
  const payout = agreement.terms.payoutBindings[0];
  return {
    jobId: agreement.jobId,
    listing: { ...agreement.listingRef },
    buyer: buyer.primaryClaim,
    seller: seller.primaryClaim,
    payee: payout.payeeAddress,
    paymentPhaseIndex: payout.phaseIndex,
    rail: payout.railId,
    price: { amount: agreement.terms.price.amount, currency: agreement.terms.price.currency, amountOs: baseUnits(agreement.terms.price.amount, DEM_DECIMALS) },
    deadline: agreement.terms.deadline,
  };
}

// Price, payee, Listing pin, rail and parties must be exactly the prepared terms.
export function boundTermsMismatch(operation, agreementLike) {
  const t = operation.terms;
  const payout = agreementLike.terms?.payoutBindings ?? [];
  const parties = agreementLike.parties ?? [];
  if (agreementLike.jobId !== t.protocol.jobId) return 'job';
  if (agreementLike.listingRef?.listingId !== t.listing.listingId || agreementLike.listingRef?.version !== t.listing.version || agreementLike.listingRef?.contentHash !== t.listing.contentHash) return 'listing';
  if (payout.length !== 1 || payout[0].payeeAddress !== t.seller.payee || payout[0].railId !== t.rail) return 'payee';
  let amountOs = null;
  try {
    amountOs = agreementLike.terms.price.currency === 'DEM' ? baseUnits(agreementLike.terms.price.amount, DEM_DECIMALS) : null;
  } catch {
    amountOs = null;
  }
  if (amountOs !== t.price.amountOs) return 'price';
  if (parties.find((x) => x.role === 'seller')?.primaryClaim !== t.seller.claim || parties.find((x) => x.role === 'buyer')?.primaryClaim !== claimForAddress(operation.terms.buyer.wallet)) return 'parties';
  return null;
}

export function commitmentSession(agreement) {
  const party = (role) => {
    const p = agreement.parties.find((entry) => entry.role === role);
    return { primaryClaim: p.primaryClaim, bundleHash: p.bundleHash, vetRecordRef: structuredClone(p.vetRecordRef) };
  };
  const seller = party('seller');
  return { jobId: agreement.jobId, listingRef: { ...agreement.listingRef }, phaseKind: 'commit-payee-bound-agreement', orchestrator: seller.primaryClaim, buyer: party('buyer'), seller };
}

// SR-2 lookups in the SDK commitment-gate envelope.
export function commitmentReader(anchors, orchestrator) {
  return {
    resolve: async (logicalAddress) => {
      let record;
      try {
        record = await anchors.read(logicalAddress);
      } catch (error) {
        return { disposition: 'indeterminate', reason: `SR-2 read failed: ${error.message}` };
      }
      if (record.status === 'absent') return { disposition: 'absent' };
      return { disposition: 'present', anchored: { record: record.artifact, nativeAddress: record.receipt.nativeAddress, anchorTxRef: fixtureTxRef(record.receipt), anchorReceipt: record.receipt } };
    },
    verifyAnchorReceipt: (anchored) => verifyFixtureReceipt({ receipt: anchored.anchorReceipt, logicalAddress: anchored.anchorReceipt.logicalAddress, hash: contentHash(anchored.record), expectedWriter: orchestrator }),
  };
}

// ---------------------------------------------------------------------------
// DACS-3 Agreement exchange (buyer side, SDK durable coordinator).
// ---------------------------------------------------------------------------

// The buyer's signatures were produced by the wallet before this call. The
// coordinator's signer and reconciliation seams return that detached
// signature only for the exact planned bytes, so the SDK never holds a live
// buyer key. A fresh in-memory fenced store per call re-drives every step from
// authenticated transport/substrate state (idempotent).
export async function exchangeAgreement({ plan, draft, buyerClaim, buyerBundle, agreementSignature, seller, anchorAdapter, commitOnSignature = false, workerId = 'plugin-buyer' }) {
  assertPurchaseActionsAdmitted();
  if (!anchorAdapter) throw new TypeError('native Agreement anchor adapter is required');
  const signature = canonicalSignature(agreementSignature);
  const planned = Buffer.from(fixedPriceAgreementSignedBytes(plan));
  // A definite seller refusal (seller-http SellerRefusedError) is a rejection;
  // anything that did not answer is indeterminate.
  const indeterminate = (error) => ({ disposition: error?.name === 'SellerRefusedError' ? 'rejected' : 'indeterminate', reason: String(error?.message ?? error).slice(0, 200) });
  const walletSignature = (bytes, { party }) => {
    if (party !== buyerClaim || !planned.equals(Buffer.from(bytes))) throw new Error('the wallet signed only the planned Agreement bytes');
    return signature;
  };
  return advanceFixedPriceAgreementDurable(
    { draft, buyer: { party: buyerClaim, algorithm: 'ed25519', sign: walletSignature } },
    {
      store: createInMemoryFencedSessionStore(),
      workerId,
      leaseTtlMs: 60_000,
      reconcileBuyerSignature: ({ planHash, party }) =>
        planHash === plan.planHash && party === buyerClaim ? { disposition: 'present', value: signature } : { disposition: 'rejected', reason: 'no wallet signature for this plan' },
      verifyContribution: contributionVerifier,
      transport: {
        publishProposal: async (proposal, identity) => {
          try {
            const answer = await seller.propose({ proposal, transportIdentity: identity, buyerIdentityBundle: buyerBundle });
            return answer.disposition === 'complete' ? { disposition: 'submitted' } : { disposition: answer.disposition === 'rejected' ? 'rejected' : 'indeterminate', reason: answer.reason ?? 'seller did not accept the proposal' };
          } catch (error) {
            return indeterminate(error);
          }
        },
        reconcileProposalPublication: async (identity) => {
          try {
            const state = await seller.agreementState(identity);
            return state.proposal ? { disposition: 'present', value: state.proposal } : { disposition: 'absent', reason: 'seller holds no proposal' };
          } catch (error) {
            return indeterminate(error);
          }
        },
        resolveSellerContributions: async (identity) => {
          try {
            const state = await seller.agreementState(identity);
            return state.contribution ? { disposition: 'present', value: [state.contribution] } : { disposition: 'absent', reason: 'seller has not contributed' };
          } catch (error) {
            return indeterminate(error);
          }
        },
      },
      anchor: signatureCommitmentAnchor(anchorAdapter, seller, commitOnSignature),
    },
  );
}

// ---------------------------------------------------------------------------
// DACS-3 commitment: independent buyer readback (never from the seller).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DACS-4 evidence (buyer verification of the seller-published records).
// ---------------------------------------------------------------------------

// A fresh plain object per call: the SDK refuses frozen (read-only) context.
const demRailContext = () => ({
  railId: DEM_RAIL.railId,
  railType: 'demos-native',
  asset: 'DEM',
  assetSpec: { kind: 'native-dem' },
  network: 'demos',
  networkSpec: { kind: 'demos' },
  handler: 'pay-dem',
});

// Payment SettlementEvidence at the SB-1/PC-2 address, signed by the
// orchestrator (seller), for exactly the transaction and block the buyer
// itself observed and exactly the Agreement amount.
export async function verifyPaymentEvidence({ agreement, record, observed }) {
  const terms = agreementTerms(agreement);
  const address = paymentEvidenceAddress(agreement.jobId, terms.rail, terms.paymentPhaseIndex);
  const reasons = [];
  if (!record || record.status !== 'present') return { status: 'absent', address };
  if (verifyFixtureRecord(record, { logicalAddress: address, expectedWriter: terms.seller }) !== 'valid') reasons.push('evidence anchor receipt does not verify for the seller at the SB-1 address');
  const evidence = record.artifact;
  if (!isSettlementEvidence(evidence) || evidence.phase !== 'pay-dem' || evidence.outcome !== 'success') reasons.push('record is not pay-dem success SettlementEvidence');
  else {
    const tx = evidence.paymentTxRefs?.[0];
    if (evidence.jobId !== agreement.jobId) reasons.push('evidence names another job');
    if (evidence.paymentTxRefs.length !== 1 || tx?.kind !== 'demos') reasons.push('evidence does not name exactly one Demos transaction');
    if (tx?.txHash?.toLowerCase() !== observed.txHash.toLowerCase()) reasons.push('evidence transaction is not the buyer-observed transfer');
    if (tx?.blockNumber !== observed.blockNumber) reasons.push('evidence block differs from the buyer-observed block');
    if (evidence.paymentAmount?.amount !== terms.price.amount || evidence.paymentAmount?.currency !== 'DEM') reasons.push('evidence amount differs from the Agreement price');
    if (evidence.settlementFinality?.model !== 'bft-final') reasons.push('evidence finality model is not the pay-dem bft-final rail model');
    if (evidence.signature?.signer !== terms.seller) reasons.push('evidence is not signed by the seller (phase orchestrator)');
    const sdk = await verifySettlementEvidence(evidence, {
      orchestrator: terms.seller,
      agreement: { amount: terms.price.amount, currency: terms.price.currency },
      rail: demRailContext(),
      attestationRef: fixtureRef(address, contentHash(evidence)),
      result: { ok: true, txRefs: [{ kind: 'demos', txHash: observed.txHash, blockNumber: observed.blockNumber }] },
      paymentAddress: { railId: terms.rail, phaseIndex: terms.paymentPhaseIndex },
    }, ed25519Deps);
    if (sdk.decision !== 'pass') reasons.push(`SDK verifySettlementEvidence: ${sdk.decision} (${sdk.reasons.join('; ').slice(0, 200)})`);
  }
  if (reasons.length) return { status: 'rejected', address, reasons };
  return { status: 'verified', address, ref: fixtureRef(address, contentHash(evidence)), evidenceHash: contentHash(evidence), observedAt: evidence.observedAt, model: evidence.settlementFinality.model };
}

// Delivery: the anchored deliverable, and delivery SettlementEvidence that
// commits to its exact JCS bytes at the canonical deliverable address.
export async function verifyDelivery({ agreement, deliverable, evidenceRecord }) {
  const terms = agreementTerms(agreement);
  const reasons = [];
  const dAddress = deliverableAddress(agreement.jobId);
  const eAddress = deliveryEvidenceAddress(agreement.jobId);
  if (!deliverable || deliverable.status !== 'present' || !evidenceRecord || evidenceRecord.status !== 'present') return { status: 'absent' };
  if (verifyFixtureRecord(deliverable, { logicalAddress: dAddress, expectedWriter: terms.seller }) !== 'valid') reasons.push('deliverable anchor receipt does not verify for the seller');
  if (verifyFixtureRecord(evidenceRecord, { logicalAddress: eAddress, expectedWriter: terms.seller }) !== 'valid') reasons.push('delivery evidence anchor receipt does not verify for the seller');
  const evidence = evidenceRecord.artifact;
  const payloadHash = sha256Hex(canonicalize(deliverable.artifact));
  if (!isSettlementEvidence(evidence) || evidence.phase !== 'deliver-storage-program' || evidence.outcome !== 'success') reasons.push('record is not deliver-storage-program success evidence');
  else {
    if (evidence.jobId !== agreement.jobId) reasons.push('delivery evidence names another job');
    if (evidence.deliverableContentHash !== payloadHash) reasons.push('delivery evidence does not commit to the anchored deliverable bytes');
    if (evidence.deliverableAnchor?.locator !== dAddress) reasons.push('delivery evidence points at another deliverable address');
    if (deliverable.artifact?.jobId !== agreement.jobId || deliverable.artifact?.agreementHash !== contentHash(agreement)) reasons.push('deliverable is not bound to this Agreement');
    const sdk = await verifySettlementEvidence(evidence, {
      orchestrator: terms.seller,
      agreement: { amount: terms.price.amount, currency: terms.price.currency },
      attestationRef: fixtureRef(eAddress, contentHash(evidence)),
      result: { ok: true },
      expectedAnchorLocator: dAddress,
    }, ed25519Deps);
    if (sdk.decision !== 'pass') reasons.push(`SDK verifySettlementEvidence: ${sdk.decision} (${sdk.reasons.join('; ').slice(0, 200)})`);
  }
  if (reasons.length) return { status: 'rejected', reasons };
  return { status: 'verified', deliverableRef: fixtureRef(dAddress, contentHash(deliverable.artifact)), evidenceRef: fixtureRef(eAddress, contentHash(evidence)), payloadHash, deliveredAt: evidence.observedAt, report: deliverable.artifact };
}

// ---------------------------------------------------------------------------
// DACS-5 completed two-sided bundle.
// ---------------------------------------------------------------------------

// The session facts both parties derive independently from their own
// verified records; the seller proposes only `finalisedAt`.
export function bundleSession({ agreement, agreementRef, commitmentRef, payment, delivery, observed, finalisedAt }) {
  const terms = agreementTerms(agreement);
  const party = (role) => agreement.parties.find((p) => p.role === role);
  const buyer = party('buyer');
  const seller = party('seller');
  return {
    jobId: agreement.jobId,
    outcome: 'completed',
    listingRef: { ...agreement.listingRef },
    agreementRef: structuredClone(agreementRef),
    phaseSummary: [
      { index: 0, kind: 'negotiate-fixed-price', outcome: 'ok' },
      { index: 1, kind: 'commit-payee-bound-agreement', outcome: 'ok', attestationRef: structuredClone(commitmentRef) },
      { index: terms.paymentPhaseIndex, kind: 'pay-dem', outcome: 'ok', txRefs: [{ kind: 'demos', txHash: observed.txHash, blockNumber: observed.blockNumber }], attestationRef: structuredClone(payment) },
      { index: 3, kind: 'deliver-storage-program', outcome: 'ok', attestationRef: structuredClone(delivery) },
    ],
    vetRecords: [structuredClone(buyer.vetRecordRef), structuredClone(seller.vetRecordRef)],
    settlementEvidence: [structuredClone(payment), structuredClone(delivery)],
    recipeRegistryVersion: RECIPE_REGISTRY_VERSION,
    railRegistryVersion: RAIL_REGISTRY_VERSION,
    finalisedAt,
    buyer: { primaryClaim: buyer.primaryClaim, bundleHash: buyer.bundleHash },
    seller: { primaryClaim: seller.primaryClaim, bundleHash: seller.bundleHash },
  };
}

// The exact bytes the SDK bundle builder signs for each party, with the
// unsigned copies (signatures stripped) the parties anchor.
export async function bundleSigningPlan(session) {
  assertPurchaseActionsAdmitted();
  let payload = null;
  const capture = (bytes) => {
    payload ??= Buffer.from(bytes);
    if (!payload.equals(Buffer.from(bytes))) throw new Error('bundle copies sign different bytes');
    return new Uint8Array(64);
  };
  const copies = await buildTwoSidedBundle({ ...session, buyer: { ...session.buyer, signer: capture }, seller: { ...session.seller, signer: capture } });
  const hash = attestationBundleHash(copies.buyerCopy);
  if (attestationBundleHash(copies.sellerCopy) !== hash) throw new Error('bundle copies have different signed scopes');
  const message = utf8(payload);
  if (!Buffer.from(message, 'utf8').equals(payload)) throw new Error('bundle signing bytes are not a wallet-signable UTF-8 message');
  return { bundleHash: hash, message, payload };
}

// Both copies carrying both detached signatures, checked by the SDK copy
// validator (signer set, address role) and the divergence predicate.
export async function assembleBundleCopies(session, signatures) {
  assertPurchaseActionsAdmitted();
  const detached = (value) => () => new Uint8Array(Buffer.from(canonicalSignature(value), 'base64url'));
  const copies = await buildTwoSidedBundle({
    ...session,
    buyer: { ...session.buyer, signer: detached(signatures.buyer) },
    seller: { ...session.seller, signer: detached(signatures.seller) },
  });
  const buyerCheck = await verifyBundleCopy(copies.buyerCopy, 'buyer', ed25519Deps);
  const sellerCheck = await verifyBundleCopy(copies.sellerCopy, 'seller', ed25519Deps);
  const problems = [];
  if (!buyerCheck.valid || !buyerCheck.fullySigned) problems.push(`buyer copy: ${buyerCheck.valid ? 'not fully signed' : buyerCheck.reason}`);
  if (!sellerCheck.valid || !sellerCheck.fullySigned) problems.push(`seller copy: ${sellerCheck.valid ? 'not fully signed' : sellerCheck.reason}`);
  if (bundlesDiverge(copies.buyerCopy, copies.sellerCopy)) problems.push('copies diverge');
  return { copies, problems };
}

// A counterparty copy read back from its role address: anchored by that
// role, SDK-valid for that role, the same signed scope, and not divergent.
export async function verifyAnchoredCopy({ record, role, jobId, writer, expectedHash, ownCopy }) {
  const address = bundleAddress(jobId, role);
  const reasons = [];
  if (!record || record.status !== 'present') return { status: 'absent', address };
  if (verifyFixtureRecord(record, { logicalAddress: address, expectedWriter: writer }) !== 'valid') reasons.push(`${role} copy anchor receipt does not verify for the ${role}`);
  const copy = record.artifact;
  const check = await verifyBundleCopy(copy, role, ed25519Deps);
  if (!check.valid || !check.fullySigned) reasons.push(`${role} copy is not a fully signed valid copy: ${check.valid ? 'missing signature' : check.reason}`);
  if (attestationBundleHash(copy) !== expectedHash) reasons.push(`${role} copy signs a different bundle`);
  if (ownCopy && bundlesDiverge(ownCopy, copy)) reasons.push('copies diverge');
  if (reasons.length) return { status: 'rejected', address, reasons };
  return { status: 'verified', address, ref: fixtureRef(address, contentHash(copy)), bundleHash: expectedHash };
}

// Small structural guards reused by callers.
export function isProtocolAgreement(value) {
  return isPayeeBoundAgreementDocument(value);
}

export function partyBundleHash(bundle) {
  return identityBundleHash(bundle);
}

export { ARTIFACT_SEPARATORS };
