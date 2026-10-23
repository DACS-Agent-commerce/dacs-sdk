import { assertPurchaseActionsAdmitted } from './action-admission.mjs';
import { commitOnSignatureConfig } from './commit-on-signature.mjs';
import { observeTransferReadOnly, readIssuedArtifacts, readIssuedWallet } from '../devnet-demo/issued-readback.mjs';
import { deliveryDeadlineView, DELIVERY_TIME_SOURCE, verifiedDelivery } from './delivery-deadline-watch.mjs';
import { purchaseStore } from '../seams/purchase-store-not-wired.mjs';
// The plugin's buyer side of one DACS fixed-price pay-dem purchase, driven
// from a purchase operation's durable state (operation.state.protocol).
//
// The user's own wallet produces every buyer signature in the portal: the
// IdentityBundle presentation, the Agreement contribution, each SR-2 write
// authorization and the DACS-5 counter-signature. The server verifies each
// one against the purchase's bound wallet before using it and never holds a
// buyer key. Payment stays the existing approval + wallet handoff (nonce
// fence, single send, one-RPC readback); this module adds the protocol gates
// around it: no approval or handoff before the seller's finalized commitment
// is read back independently, the transfer is bound to the committed payee
// and amount, and nothing after the transfer is accepted without verified
// DACS-4 evidence, delivery and DACS-5 copies.
//
// Only the source-bound native Agreement profile remains. Fixture and
// complete simulated profiles have no admission or continuation path.
import { canonicalize, contentHash, generateCanonicalJobId, bundleAddress, decodeDemosAnchorReceiptProof, demosSignedTransactionProofHash, finalityCommitmentAddress, sha256Hex } from '@kynesyslabs/dacs';
import { isDevnetAgreementTransport, DEVNET_AGREEMENT_KIND } from '../wallet/devnet-native-transport.mjs';
import { NotWiredError, OperationError } from '../client-errors.mjs';
import { verifyDemosSignature, claimForAddress } from '../signatures.mjs';
import { attachIdentityPresentation, buildUnsignedIdentityBundle, verifyComponent } from './listing.mjs';
import { createSellerAgentClient, SellerRefusedError, SellerTlsUnusableError, sellerFailureCause, sellerFailureAttempt } from './seller-http.mjs';
import { createDemosSr2WalletBridge, SR2_WALLET_KIND } from './demos-sr2-wallet-bridge.mjs';
import { DemosSr2Error } from './demos-sr2-adapter.mjs';
import {
  agreementTerms,
  boundTermsMismatch,
  deliverableAddress,
  deliveryEvidenceAddress,
  deliveryIsFinal,
  exchangeAgreement,
  fixedPriceAgreementLogicalAddress,
  ORCHESTRATION,
  paymentEvidenceAddress,
  planAgreement,
  planAgreementFromInput,
  plainJson,
  PROTOCOL_LIMITS,
  protocolSupport,
} from './purchase-protocol.mjs';
import { AGREEMENT_CONTEXT_SOURCE, agreementContextConfig, resolveAgreementContext } from './agreement-context-consumer.mjs';
import { DEM_DELIVERY_CONTEXT_SOURCE, demDeliveryContextConfig, releaseDemDeliveryContext, resolveDemDeliveryBuyerContext } from './dem-delivery-context-consumer.mjs';
import { SELLER_SR2_PUBLIC_PROJECTION } from './seller-sr2-agreement-consumer.mjs';
import { NATIVE_AGREEMENT_PAYMENT, usesNativeAgreementPayment, nativeAgreementPaymentConfig } from './native-agreement-payment-consumer.mjs';
import { NATIVE_PAYMENT_EVIDENCE, nativePaymentEvidenceConfig, usesNativePaymentEvidence } from './native-payment-evidence-consumer.mjs';
import { sourceDemoSellerTransportConfig } from './source-demo-seller-transport.mjs';
import { verifySellerSessionDelegation } from './seller-transport-auth.mjs';
import { readDemDeliveryReady } from './dem-delivery-consumer.mjs';
import { CHAIN_POINTER_ASK_LIMIT, CHAIN_READBACK_OPERATOR_ACTION, chainPointerAskDue, deliveryPointerDiffers, missingChainPointers, replacementAnswerProblem } from './seller-session-lifecycle.mjs';
import { NATIVE_DEM_DELIVERY_SOURCE, nativeDemDeliveryConfig } from './native-dem-delivery-consumer.mjs';
import { DEVNET_NATIVE_COMMITMENT_MARKER, devnetNativeCommitmentConfig } from '../devnet-demo/commitment-consumer.mjs';
import { BuyerChainReadbackUnsupported, createBuyerChainReadback, POINTER_MISSING, signedCreateBytes, signedCreateFor } from './buyer-chain-readback.mjs';
import { cutText } from '../util/text.mjs';

// Retained native Agreement profile; consumer capabilities are bound in terms.
export const OFFLINE_AGREEMENT_MODE = 'dacs-sr2-wallet-agreement';
export const OFFLINE_AGREEMENT_PROFILE = 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1';
export const isOfflineWalletAgreement = (operation) => operation?.terms?.protocol?.profile === OFFLINE_AGREEMENT_PROFILE;
export const OFFLINE_AGREEMENT_LIMITS = Object.freeze({
  substrate: 'source-pinned-native',
  wallet: 'explicit-packaged-wallet-and-shared-journal; source-bound-browser-broker',
  vet: 'not-performed',
  railRegistry: PROTOCOL_LIMITS.railRegistry,
  commitment: 'awaiting-authenticated-seller-commitment-and-context',
  payment: 'held',
  bundleFinalization: 'held',
  finality: 'single-node-inclusion; not-established',
  humanAcceptance: 'not-recorded',
});
// Prepared while an operator Agreement context provider was configured: the
// plan must use that provider's bound context and never the placeholder refs.
export const usesDemDeliveryContext = (operation) => isOfflineWalletAgreement(operation) && operation.terms.protocol.agreementContext === DEM_DELIVERY_CONTEXT_SOURCE;
export const usesNativeDemDelivery = (operation) => usesDemDeliveryContext(operation) && operation.terms.protocol.nativeDelivery === NATIVE_DEM_DELIVERY_SOURCE;
export const usesAgreementContext = (operation) => isOfflineWalletAgreement(operation)
  && [AGREEMENT_CONTEXT_SOURCE, DEM_DELIVERY_CONTEXT_SOURCE].includes(operation.terms.protocol.agreementContext);
export const OPERATOR_CONTEXT_LIMITS = Object.freeze({
  ...OFFLINE_AGREEMENT_LIMITS,
  vet: 'operator-provider-record-refs-bound; Vet not performed or verified by the plugin',
  agreementContext: 'operator-configured-provider; its authority is not established by the plugin',
});
export const DEM_DELIVERY_CONTEXT_LIMITS = Object.freeze({
  ...OFFLINE_AGREEMENT_LIMITS,
  substrate: 'native Agreement/payment evidence plus loopback-fixture Vet/commitment/deliverable; mixed TEST substrate',
  vet: 'two partyVetCore composites produced, seller/orchestrator-signed, independently read back and closure-verified',
  agreementContext: 'explicit TEST application producer; exact buyer/seller Vet invocation provenance retained',
  bundleFinalization: 'delivery evidence publication and DACS-5 finalization deferred',
  finality: 'native source is one-node fixture view; loopback SR-2 records have fixture finality only',
});
// Prepared while `dacsProtocol.sellerSr2Commitment` was configured
// (seller-sr2-agreement-consumer.mjs): after the native Agreement anchors, the
// seller commitment is requested and read back; payment stays held.
// The authenticated source seller signs native CREATEs only after its exact
// interactive approval and then waits for Node2 inclusion; 15s is too short.
// A composition may set dacsProtocol.sellerRequestTimeoutMs (1-300s).
const AUTHENTICATED_SELLER_TIMEOUT_MS = 240000;
// A page request waits this long for a running Agreement plan step (which can
// wait on seller approvals), inside a tunnel's 100 s response limit. A
// composition may set dacsProtocol.planWaitMs (1-90s).
const PLAN_WAIT_MS = 60000;
// Purchase statuses after which a job's Agreement context is never read again.
const ENDED_STATUSES = new Set(['settled_verified', 'payment_failed', 'payment_mismatch', 'expired', 'terms_changed', 'cancelled', 'superseded', 'agreement_rejected']);
// A step that leads to a NEW seller write (the Agreement plan, the first
// Agreement signature, and every pre-payment gate) starts only while the
// seller session delegation has at least this long left. It exceeds one full
// authenticated seller request. Work already started is never gated: the
// seller answers it from its journal even after expiry. See
// docs/SELLER-SESSION-DELEGATION.md ("Safety margin").
export const SELLER_DELEGATION_SAFETY_MARGIN_MS = 5 * 60 * 1000;
export const usesSellerSr2Commitment = (operation) => isOfflineWalletAgreement(operation) && operation.terms.protocol.sellerCommitment === DEVNET_NATIVE_COMMITMENT_MARKER;
const sellerSr2CommitmentLimits = (operation) => ({
  agreementAnchor:'buyer native Agreement CREATE',commitmentAnchor:'seller native FinalityCommitmentRecord CREATE; one-node inclusion, not consensus finality',
  commitment: operation.state?.protocol?.commitment ? `seller-commitment-read-back-independently; ${operation.terms.protocol.sellerCommitment===DEVNET_NATIVE_COMMITMENT_MARKER?'native source':'retained source-pinned'} record; not strict finality` : 'requested-after-native-agreement-anchor; not read back yet',
});
export function assertAgreementPaymentHeld(operation) {
  if (usesNativeAgreementPayment(operation)) return;
  if (isOfflineWalletAgreement(operation)) throw new OperationError('agreement_payment_held', 'this offline wallet Agreement profile stops before verified commitment; payment, claims and completion remain held');
}

// One line per stage; the layers below keep transfer, DACS purchase evidence,
// delivery, completed copies and human acceptance apart.
export const STAGE_HELP = {
  identity: 'Open the approval link and present your wallet identity to start the DACS Agreement. Nothing is signed for payment and nothing is paid at this step.',
  'agreement-signing': 'Sign the Agreement and its anchor authorization in your wallet (approval link). Nothing is paid at this step.',
  'agreement-anchored': 'Both parties signed the Agreement and it is anchored, but the seller\'s finalized commitment has not been read back yet. Payment is not possible before that; re-open the approval link or call verify_deal to re-check.',
  committed: 'The seller\'s finalized commitment was read back independently of the seller. Approve the payment to the committed payee and amount in the approval link.',
  'awaiting-claim': 'The transfer was observed (one RPC node, tuple-only), but the seller has not yet verified the payment claim. Call verify_deal to retry the claim with the same transaction; never pay again.',
  'payment-evidenced': 'DACS-4 payment evidence from the seller verifies at the canonical address for your transaction, block and amount. Delivery is not verified yet; call verify_deal to re-check.',
  'delivery-ready': 'The purchased report and its seller-written canonical SR-2 receipt verify. Delivery evidence publication and completed DACS-5 copies remain unfinished; do not pay again.',
  delivered: 'Payment evidence and the delivered test report verify. The completed bundle is not signed yet; call verify_deal to request it.',
  'awaiting-countersignature': 'Payment evidence and delivery verify. Review and counter-sign the completed DACS-5 bundle in your wallet (approval link). Your signature records protocol completion, not satisfaction with the service.',
  completed: 'DACS purchase evidenced, test report delivered, and both completed DACS-5 copies verified. Explicit source-pinned observations only; Vet not performed, finality not independently established, and no human acceptance is recorded.',
  'agreement-rejected': 'The DACS Agreement was refused or could not be bound to these terms. Nothing was paid.',
  'claim-rejected': 'Your transfer was observed, but the seller refused the payment claim. Do not pay again; keep the transaction hash.',
  'evidence-rejected': 'The seller\'s DACS-4 payment evidence does not verify for your transaction. Do not pay again; this is recorded as a failed DACS purchase step.',
  'delivery-rejected': 'Payment evidence verifies, but the delivered report or its delivery evidence does not. Do not pay again.',
  'bundle-rejected': 'Payment and delivery verify, but the completed bundle copies do not (missing, invalid or divergent). Nothing more was signed.',
};

const ACCEPTED = new Set(['committed', 'awaiting-claim', 'payment-evidenced', 'delivery-ready', 'delivered', 'awaiting-countersignature', 'completed', 'claim-rejected', 'evidence-rejected', 'delivery-rejected', 'bundle-rejected']);

const COUNTERSIGNED_HELP = 'Your counter-signature is saved and the buyer copy write was sent once. It is only read back, never sent again, and nothing more is signed. Call verify_deal, or re-check in the approval link, to read it back and finish the copy exchange.';

// Only a buyer copy reference saved from an authenticated readback counts.
// Older checks saved it from the write acknowledgement alone, so a completed
// purchase saved that way reads as counter-signed and awaiting the readback
// until a re-check authenticates the copy.
const buyerCopyReadBack = (p) => p?.bundle?.buyerCopyReadBack === true;
const shownStage = (p) => (p?.stage === 'completed' && !buyerCopyReadBack(p) ? 'awaiting-countersignature' : p?.stage);

export function protocolStageHelp(operation) {
  const notSaved = operation?.state?.protocol?.notSaved;
  if (notSaved) return `This check's result was not saved: another check saved newer progress for this purchase first (saved step: ${notSaved.savedStage ?? 'unset'}). Call verify_deal again, or re-check in the approval link, to read the saved state.`;
  if (shownStage(operation?.state?.protocol) === 'awaiting-countersignature' && operation.state.protocol.bundle?.buyerSignature) return COUNTERSIGNED_HELP;
  if(operation.terms?.protocol?.transportBinding?.source==='devnet-agreement-transport/v1'){
    if(operation.state?.protocol?.stage==='payment-observed')return 'One source-pinned RPC reports the approved native DEM tuple. The Agreement and seller commitment CREATEs used the same explicit transport. Finality is not independently established; unknown writes are readback-only and no payment is resent.';
    if(operation.state?.protocol?.stage==='seller-committed')return 'The two-party signed Agreement and seller FinalityCommitmentRecord both verify on the explicit source-pinned transport. Separately approve the exact native DEM debit; one-node inclusion is not independent finality.';
    if(operation.state?.protocol?.stage==='agreement-signing')return 'Sign the original Agreement, then separately approve its exact CREATE, source pin and full wallet debit. A retained issued/unknown write is readback-only; no identity or publication writes are enabled.';
    if(operation.state?.protocol?.stage==='agreement-anchored')return 'The exact native Agreement CREATE and source-pinned single-node readback verify. Awaiting the seller FinalityCommitmentRecord CREATE on that same source; payment remains held until its fresh readback verifies.';
  }
  if (isOfflineWalletAgreement(operation)) {
    if (usesNativePaymentEvidence(operation) && operation.state?.protocol?.stage === 'delivered') return 'The purchased report, payment evidence and delivery evidence verify on fresh native readback. DACS-5 bundle finalization remains deferred; do not pay again.';
    if (usesNativePaymentEvidence(operation) && operation.state?.protocol?.stage === 'delivery-ready' && operation.state.protocol.delivery?.evidenceHold) return operation.state.protocol.delivery.evidenceHold.status === 'rejected'
      ? 'The purchased report (delivery.report) and its seller-written receipt verify. The seller\'s delivery evidence did not verify (delivery.evidenceHold), so delivered is not claimed. Do not pay again.'
      : 'The purchased report (delivery.report) and its seller-written receipt verify. The seller\'s delivery evidence has not read back yet (delivery.evidenceHold); verify_deal re-checks it. Do not pay again.';
    if (usesNativePaymentEvidence(operation) && operation.state?.protocol?.stage === 'delivery-ready') return STAGE_HELP['delivery-ready'];
    if (usesNativePaymentEvidence(operation) && operation.state?.protocol?.nativeEvidence) return 'An opt-in claim was requested for the same native payment. Only fresh native evidence readback plus the pinned SDK verifier can establish payment evidence on the explicit source-pinned transport (a single-node view). The SDK bft-final label is not independent chain finality. Any missing/unknown anchor is readback-only; never pay again. Delivery remains pending unless an authenticated delivery-ready result is present.';
    if (usesNativeAgreementPayment(operation) && operation.state?.protocol?.stage === 'seller-committed') return 'Your native SR-2 Agreement and seller commitment verify on the source-pinned transport. Separately approve the exact native DEM payment. The handoff is issued once; unknown outcomes are readback-only. One-node inclusion is not independent finality.';
    if (usesNativeAgreementPayment(operation) && operation.state?.protocol?.stage === 'payment-observed') return 'One source-pinned RPC reports the approved native DEM tuple in its reserved nonce slot. Unknown outcomes are readback-only; do not pay again. Independent finality and completion are not established.';
    if (operation.state?.protocol?.stage === 'agreement-anchored') return 'The buyer-wallet-approved Agreement CREATE and source-pinned native readback verify. Awaiting authenticated seller commitment and context; payment remains held.';
    if (operation.state?.protocol?.stage === 'agreement-signing') return 'Sign the Agreement, then approve its exact storage CREATE, source pin and network debit in the packaged wallet. Payment remains held. A pending write is resumed by readback only.';
    if (operation.state?.protocol?.stage === 'seller-committed') return 'The native Agreement CREATE and seller commitment verify on the explicit source-pinned transport. Independent finality and completion are not established.';
  }
  return STAGE_HELP[operation?.state?.protocol?.stage] ?? null;
}

// Approval binding additions: the wallet-signed approval names the job, the
// Agreement and the read-back commitment record (present once committed).
export function protocolApprovalFields(operation) {
  const p = operation?.state?.protocol;
  if (!operation?.terms?.protocol || !p?.commitment) return {};
  return {
    'dacs-job': operation.terms.protocol.jobId,
    'dacs-agreement': p.agreement.hash,
    'dacs-commitment': p.commitment.contentHash,
    'dacs-commitment-signer': p.commitment.signer,
  };
}

// Pure status projection for MCP and the portal (no network). A view marked
// notSaved is one check's own result that lost to newer saved progress: its
// fields describe that check only, and it offers nothing to sign.
export function protocolView(operation, deadlineOptions = {}) {
  const p = operation?.state?.protocol;
  if (!operation?.terms?.protocol || !p) return null;
  const stage = shownStage(p);
  const notSaved = p.notSaved ?? null;
  const deliveryDeadline = deliveryDeadlineView(operation, deadlineOptions);
  const reached = (...stages) => stages.includes(stage);
  // Delivery is a current projection, not an audit-history field. A later
  // unsuccessful fresh read downgrades the stage and must make any retained
  // legacy bytes non-projectable even before a repaired reducer rewrites them.
  const currentDelivery = reached('delivery-ready', 'delivered', 'awaiting-countersignature', 'completed', 'bundle-rejected') ? p.delivery : null;
  return {
    profile: operation.terms.protocol.profile,
    jobId: operation.terms.protocol.jobId,
    orchestration: operation.terms.protocol.orchestration,
    sellerAgent: operation.terms.protocol.sellerAgent,
    substrate: operation.terms.protocol.substrate,
    stage,
    revision: p.revision ?? 0,
    ...(notSaved ? { notSaved: { savedRevision: notSaved.savedRevision, savedStage: notSaved.savedStage } } : {}),
    next: protocolStageHelp(operation),
    agreement: p.agreement ? { hash: p.agreement.hash, ref: p.agreement.ref, ...p.agreement.terms, ...(isOfflineWalletAgreement(operation) ? { anchorReceipt: p.agreement.anchorReceipt, nativeAddress: p.agreement.anchorReceipt?.nativeAddress } : {}) } : null,
    commitment: p.commitment ?? null,
    claim: p.claim ?? null,
    paymentEvidence: p.paymentEvidence ?? null,
    ...(deliveryDeadline ? { deliveryDeadline } : {}),
    ...(p.nativeEvidence ? { nativeEvidence: p.nativeEvidence } : {}),
    delivery: currentDelivery ? { status: currentDelivery.status, fulfilmentId: currentDelivery.fulfilmentId, deliverableRef: currentDelivery.deliverableRef,
      anchorReceipt: currentDelivery.anchorReceipt, evidenceRef: currentDelivery.evidenceRef, evidenceHash: currentDelivery.evidenceHash,
      evidencePublication: currentDelivery.evidencePublication, evidenceReceipt:currentDelivery.evidenceReceipt, ...(currentDelivery.evidenceHold ? { evidenceHold: currentDelivery.evidenceHold } : {}), payloadHash: currentDelivery.payloadHash, deliveredAt: currentDelivery.deliveredAt, substrate:currentDelivery.substrate, report: currentDelivery.report } : null,
    bundle: p.bundle ? { bundleHash: p.bundle.bundleHash, finalisedAt: p.bundle.finalisedAt, buyerCopy: buyerCopyReadBack(p) ? p.bundle.buyerCopyRef : null, sellerCopy: p.bundle.sellerCopyRef ?? null, counterSigned: Boolean(p.bundle.buyerSignature), message: stage === 'awaiting-countersignature' && !notSaved && !p.bundle.buyerSignature ? p.bundle.message : undefined } : null,
    layers: {
      transfer: operation.status === 'settled_verified' ? 'observed-by-one-rpc-tuple-only' : 'not-observed',
      dacsPurchase: reached('payment-evidenced', 'delivery-ready', 'delivered', 'awaiting-countersignature', 'completed', 'delivery-rejected', 'bundle-rejected') ? 'payment-evidence-verified' : 'not-evidenced',
      service: reached('delivery-ready', 'delivered', 'awaiting-countersignature', 'completed', 'bundle-rejected') ? 'test-report-delivered-and-verified' : 'not-delivered',
      completedCopies: stage === 'completed' ? 'both-copies-verified' : 'not-exchanged',
      humanAcceptance: 'not-recorded',
    },
    limits: { ...(usesDemDeliveryContext(operation) ? DEM_DELIVERY_CONTEXT_LIMITS : usesAgreementContext(operation) ? OPERATOR_CONTEXT_LIMITS : OFFLINE_AGREEMENT_LIMITS),
      ...(usesSellerSr2Commitment(operation) ? sellerSr2CommitmentLimits(operation) : {}),
      ...(usesNativeAgreementPayment(operation) ? { payment: 'normal-exact-approval; one-time native handoff; explicit source-pinned transport', bundleFinalization: 'held' } : {}),
      ...(operation.terms.protocol.transportBinding?.source==='devnet-agreement-transport/v1' ? {substrate:operation.terms.protocol.sellerCommitment===DEVNET_NATIVE_COMMITMENT_MARKER?'native signed Listing/Vet/Agreement/commitment/payment evidence/deliverable CREATEs on one explicit source transport':'native Agreement CREATE and DEM transfer on explicit source-pinned transport; authenticated seller commitment read separately',wallet:'same-origin packaged SDK; exact independent source binding and normal approval',agreementAnchor:'native CREATE; exact original signed projection/executed content/native/block membership verified',payment:'normal-exact-approval; durable one-send native DEM; unknown readback-only',finality:'not-established; single-node inclusion is not validator-quorum evidence'}:{}),
      ...(usesDemDeliveryContext(operation) ? { vet: DEM_DELIVERY_CONTEXT_LIMITS.vet, agreementContext: DEM_DELIVERY_CONTEXT_LIMITS.agreementContext,
        bundleFinalization: stage==='delivered'?'DACS-5 finalization deferred':DEM_DELIVERY_CONTEXT_LIMITS.bundleFinalization,
        delivery: usesNativeDemDelivery(operation)?'authenticated SDK delivery-ready via seller packaged-wallet native CREATE and fresh buyer native readback; live Node2 authority/finality not established':'authenticated SDK delivery-ready on loopback SR-2; source-native live Node2 delivery is not established' } : {}) },
    ...(usesNativeAgreementPayment(operation) ? { nativePayment: { delivery: 'one-time; no reissue', observation: 'single-rpc-tuple-only', subsequentProtocol: usesNativePaymentEvidence(operation) ? (stage === 'delivered' ? 'delivery evidence read back; DACS-5 completion deferred' : stage === 'delivery-ready' ? (p.delivery?.evidenceHold ? 'SDK durable fulfilment delivery-ready; delivery evidence readback pending or held; DACS5 completion deferred' : 'SDK durable fulfilment delivery-ready; evidence publication/DACS5 completion deferred') : 'opt-in-SDK-claim-attempt; native-evidence-readback-required; delivery pending') : 'claims/delivery/completion-held' } } : {}),
    ...(p.agreementContext ? { agreementContext: { source: p.agreementContext.source, authority: p.agreementContext.authority } } : {}),
    ...(p.storageGap ? { storageGap: p.storageGap } : {}),
    lastAttempt: p.attempts?.at(-1) ?? null,
  };
}

// A protocol save whose caller read an older revision than the stored one.
// Nothing was saved; `operation` is the caller's own view, marked notSaved.
export class StaleProtocolCheck extends OperationError {
  constructor(operation) {
    super('protocol_check_stale', 'another check saved newer progress for this purchase first; this check was not saved');
    this.operation = operation;
  }
}

// Public projections describe saved protocol state without offering actions.
export function diagnosticProtocolView(operation, options = {}) {
  const view = protocolView(operation, options);
  const { message: _message, ...bundle } = view?.bundle ?? {};
  return view ? { ...view, ...(view.bundle ? { bundle } : {}), historical: true,
    next: 'Stored protocol state is historical. Purchase actions are held; public readback cannot establish settlement or delivery.' } : null;
}

// D11: `store` is the host's PurchaseStore; `buyerAccess` is the host's
// already-resolved operator capability (null when it has none, so the paths
// that need one refuse with buyer_access_closed).
export function createProtocolPurchases({ db, ops, coordinates, dacsProtocol, fetchImpl = globalThis.fetch, now = () => Date.now(), deliveryDeadlineWatch = null, readbackCache = null, store, buyerAccess = null }) {
  const { transaction } = purchaseStore(store);
  if (deliveryDeadlineWatch !== null) throw new TypeError('deliveryDeadlineWatch is not wired; invoke the separate watch.observe method explicitly');
  if (dacsProtocol?.buyerAccess !== undefined) throw new TypeError('buyerAccess moved to the top-level createProtocolPurchases option');
  if (buyerAccess !== null && (typeof buyerAccess?.assertWallet !== 'function' || Object.prototype.toString.call(buyerAccess.assertWallet) === '[object AsyncFunction]')) throw new NotWiredError('buyer-access-not-wired');
  const commitOnSignature = commitOnSignatureConfig(dacsProtocol?.commitOnSignature);
  const assertBuyerAccess = (wallet, operation = null) => {
    if(!buyerAccess && (dacsProtocol?.nativeSellerCommitment || operation?.terms?.protocol?.sellerCommitment === DEVNET_NATIVE_COMMITMENT_MARKER))
      throw new OperationError('buyer_access_closed','operator buyerAccess capability is missing; nothing was signed or sent',{buyerAccessMissing:true});
    const checked = buyerAccess?.assertWallet(wallet);
    if (checked !== undefined) {
      if (checked && typeof checked.then === 'function') Promise.resolve(checked).catch(() => {});
      throw new NotWiredError('buyer-access-not-wired');
    }
  };
  const walletConfig = dacsProtocol?.walletAgreement;
  const sellerRequestTimeoutMs = dacsProtocol?.sellerRequestTimeoutMs ?? AUTHENTICATED_SELLER_TIMEOUT_MS;
  if (!Number.isSafeInteger(sellerRequestTimeoutMs) || sellerRequestTimeoutMs < 1000 || sellerRequestTimeoutMs > 300000) throw new TypeError('sellerRequestTimeoutMs must be an integer from 1000 through 300000');
  const planWaitMs = dacsProtocol?.planWaitMs ?? PLAN_WAIT_MS;
  if (!Number.isSafeInteger(planWaitMs) || planWaitMs < 1000 || planWaitMs > 90000) throw new TypeError('planWaitMs must be an integer from 1000 through 90000');
  const sourceCapability = walletConfig?.sourceCapability ?? null;
  if(sourceCapability && !isDevnetAgreementTransport(sourceCapability)) throw new TypeError('opaque Agreement source capability required');
  const sourceTerms = (op) => Boolean(sourceCapability && canonicalize(op.terms.protocol.transportBinding) === canonicalize(sourceCapability.transportBinding));
  const walletBridge = walletConfig && !walletConfig.bridgeFor ? createDemosSr2WalletBridge({ ...walletConfig, fetchImpl, now }) : null;
  const walletAvailable = Boolean((walletBridge || typeof walletConfig?.bridgeFor === 'function') && typeof dacsProtocol.sellerEndpoint === 'function');
  const available = Boolean(walletAvailable && sourceCapability);
  const supportsMode = (mode) => mode === OFFLINE_AGREEMENT_MODE && available;
  // Optional operator configuration only (agreement-context-consumer.mjs).
  const agreementContext = agreementContextConfig(dacsProtocol?.agreementContext);
  const demDeliveryContext = demDeliveryContextConfig(dacsProtocol?.demDeliveryContext);
  const nativeDemDelivery = nativeDemDeliveryConfig(dacsProtocol?.nativeDemDelivery);
  if (agreementContext && demDeliveryContext) throw new TypeError('configure one Agreement context capability');
  // Optional operator capability (seller-sr2-agreement-consumer.mjs).
  if (dacsProtocol?.sellerSr2Commitment) throw new TypeError('fixture seller commitments are not supported');
  const nativeSellerCommitment = devnetNativeCommitmentConfig(dacsProtocol?.nativeSellerCommitment);
  const sellerCommitmentConfig=nativeSellerCommitment;
  // chain readback: the devnet seller's commitment, Deliverable
  // and evidence are read from the chain only, never the seller's journal, and
  // payment evidence only from the signed bytes the buyer was given. A native
  // DEM delivery capability other than the devnet purchased report can only
  // verify through its provider (a seller journal), so it is refused here
  // rather than kept silently; so is chain readback without a source pin.
  const chainReadback = sourceCapability ? createBuyerChainReadback({ sourceCapability, now }) : null;
  // Signed CREATE bytes this purchase has authenticated on chain, by logical address.
  const chainRetained = (operation, creates) => creates && Object.keys(creates).length ? { chainReadback: { ...operation.state.protocol.chainReadback, ...creates } } : {};
  const nativePayment = nativeAgreementPaymentConfig(dacsProtocol?.nativeAgreementPayment, { walletConfig, sellerSr2Commitment:sellerCommitmentConfig, coordinates, fetchImpl, now, readbackCache });
  const nativeEvidence = nativePaymentEvidenceConfig(dacsProtocol?.nativePaymentEvidence);
  const sellerTransport = sourceDemoSellerTransportConfig(dacsProtocol?.sellerTransport);
  if (nativeEvidence && !nativePayment) throw new TypeError('native payment evidence requires the existing native Agreement/payment capability');
  if (nativeDemDelivery && (!demDeliveryContext || !nativeEvidence)) throw new TypeError('native DEM delivery requires DEM context and native payment evidence');
  if (nativeEvidence && nativeEvidence.rpcOrigin !== new URL(walletConfig.rpcUrl).origin) throw new TypeError('native evidence and the approved native wallet must use the same owned fixture origin');
  const anchors = null; // No fixture substrate remains.
  const unavailable = () => new OperationError('dacs_protocol_unavailable', 'source-bound DACS protocol purchases are not configured on this server; nothing was prepared');

  function sellerFor(operation) {
    const url = dacsProtocol.sellerEndpoint(operation.terms.seller.claim);
    if (!url) throw new OperationError('seller_agent_unavailable', 'no seller agent endpoint is known for this seller; nothing was signed or paid');
    const declared = operation.terms.protocol.sellerTransport;
    if (declared && (!sellerTransport || canonicalize(declared) !== canonicalize(sellerTransport.declaration))) throw new OperationError('seller_transport_changed','the signed seller transport context is unavailable or changed');
    const client = createSellerAgentClient({ url, fetchImpl, commitOnSignature, ...(declared ? { authentication:sellerTransport.authenticationFor(operation), timeoutMs:sellerRequestTimeoutMs } : {}) });
    if (client.origin !== operation.terms.protocol.sellerAgent) throw new OperationError('seller_agent_changed', 'the seller agent endpoint changed since this purchase was prepared; nothing was signed or paid');
    return client;
  }
  // fresh: skip any reused native readback (payment-path gates).
  // answer: the seller's commit answer, whose signed CREATE bytes are only a pointer.
  const readCurrentCommitment=(operation,{fresh=false,answer}={})=>chainReadback.readCommitment({
    agreement:operation.state.protocol.agreement.artifact,listing:operation.state.protocol.listing,seller:operation.terms.seller.claim,fresh,
    signedProjection:signedCreateFor(finalityCommitmentAddress(operation.terms.protocol.jobId),{retained:operation.state.protocol.chainReadback,answer})});

  // Terms + initial state for prepare (the caller already verified the Listing
  // and bound the network domain).
  // Repeat only TLS admission after an asynchronous funds read. Static
  // protocol/listing refusals retain their original order in prepareTerms.
  function assertSellerAdmission(sellerClaim) {
    try { return dacsProtocol.sellerEndpoint(sellerClaim, { newPurchase: true }); }
    catch (error) {
      if (error instanceof SellerTlsUnusableError) throw new OperationError(error.code, error.message);
      throw error;
    }
  }

  function prepareTerms({ verification, domain, sellerClaim, mode = OFFLINE_AGREEMENT_MODE }) {
    assertPurchaseActionsAdmitted();
    if (!supportsMode(mode)) throw unavailable();
    if(sourceCapability && (mode!==OFFLINE_AGREEMENT_MODE || domain.mode!=='public-chain-read' || domain.network!==sourceCapability.pins.network || domain.chainIdentity!==sourceCapability.pins.chainIdentity)) throw new OperationError('network_identity_mismatch','the separate source capability admits only newly bound native Agreement terms');
    if (!sourceCapability || domain.mode !== 'public-chain-read' || domain.chainIdentity !== sourceCapability.pins.chainIdentity || domain.network !== sourceCapability.pins.network) throw new OperationError('network_identity_mismatch', 'native purchase requires its source-bound chain domain');
    const support = protocolSupport(verification.listing);
    if (!support.supported) throw new OperationError('listing_not_dacs_protocol', `this Listing is not the supported fixed-price pay-dem pipeline: ${support.reasons.join('; ')}`);
    const url = assertSellerAdmission(sellerClaim);
    if (!url) throw new OperationError('seller_agent_unavailable', 'no seller agent endpoint is known for this seller; nothing was prepared');
    const jobId = generateCanonicalJobId();
    if (mode === OFFLINE_AGREEMENT_MODE && domain.network !== walletConfig.network) throw new OperationError('network_identity_mismatch', 'the injected wallet bridge is not bound to the prepared fixture network');
    if (!nativeSellerCommitment) throw new OperationError('seller_commitment_unavailable', 'native seller commitment capability required');
    return {
      terms: { profile: OFFLINE_AGREEMENT_PROFILE, jobId, orchestration: ORCHESTRATION, sellerAgent: createSellerAgentClient({ url, fetchImpl }).origin, substrate: 'source-pinned-native-fixed-price-demo; finality-held',
        ...(mode === OFFLINE_AGREEMENT_MODE && sourceCapability ? {transportBinding:sourceCapability.transportBinding} : {}),
        ...(mode === OFFLINE_AGREEMENT_MODE && (agreementContext || demDeliveryContext) ? { agreementContext: demDeliveryContext ? DEM_DELIVERY_CONTEXT_SOURCE : AGREEMENT_CONTEXT_SOURCE } : {}),
        ...(mode === OFFLINE_AGREEMENT_MODE && nativeDemDelivery ? {nativeDelivery:NATIVE_DEM_DELIVERY_SOURCE}:{}),
        ...(mode === OFFLINE_AGREEMENT_MODE && sellerCommitmentConfig ? { sellerCommitment: DEVNET_NATIVE_COMMITMENT_MARKER, ...(nativeSellerCommitment ? { sellerAgreementProjection: SELLER_SR2_PUBLIC_PROJECTION } : {}) } : {}),
        ...(mode === OFFLINE_AGREEMENT_MODE && nativePayment ? { nativePayment: NATIVE_AGREEMENT_PAYMENT, ...(nativeEvidence ? { nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE, ...(sellerTransport ? {sellerTransport:sellerTransport.declaration}:{}) } : {}) } : {}) },
      state: { stage: 'identity', listing: plainJson(verification.listing), attempts: [] },
    };
  }

  // State writes are one transaction that compares the status and the
  // protocol revision the caller read, then writes revision + 1 (with any
  // status move). A caller that read an older revision writes nothing: another
  // check saved newer progress first. Its check (even a success) goes to the
  // event log only, and its flow ends with StaleProtocolCheck carrying its own
  // unsaved view, so nothing continues from a snapshot that was not saved.
  function save(operation, patch, { event = 'protocol_step', data = {}, toStatus, attempt } = {}) {
    const own = { ...operation.state.protocol, ...patch, ...(attempt ? { attempts: withAttempt(operation.state.protocol, attempt) } : {}) };
    const result = transaction(db, () => {
      const stored = ops.get(operation.accountId, operation.id);
      if (!stored) throw new OperationError('not_found', 'operation not found');
      if (stored.status !== operation.status) throw new OperationError('invalid_state', `operation is ${stored.status}, expected ${operation.status}`, { status: stored.status });
      const seen = revisionOf(operation);
      const held = revisionOf(stored);
      if (seen !== held) {
        const notSaved = { savedRevision: held, savedStage: stored.state.protocol?.stage ?? null };
        ops.appendEvent(operation.id, 'protocol_check_not_saved', { ...data, event, stage: own.stage, revision: seen, ...notSaved });
        return { notSaved };
      }
      const base = stored.state.protocol;
      const protocol = { ...base, ...patch, ...(attempt ? { attempts: withAttempt(base, attempt) } : {}), revision: held + 1 };
      // The delivery deadline observation is append-only and written only by
      // the deadline watch, so the stored one always stands. A Deliverable
      // verified after an overdue observation records its delivery time once.
      if (base.deliveryDeadline) {
        protocol.deliveryDeadline = { ...base.deliveryDeadline };
        if (base.deliveryDeadline.overdue && !base.deliveryDeadline.laterDelivery && verifiedDelivery(protocol)) {
          const delivery = protocol.delivery;
          protocol.deliveryDeadline.laterDelivery = { verifiedAt: now(), deliveredAt: delivery.deliveredAt,
            deliveredAtSource: DELIVERY_TIME_SOURCE, deliverableRef: delivery.deliverableRef, payloadHash: delivery.payloadHash };
        }
      }
      return { saved: ops.transition(operation.id, operation.status, toStatus ?? operation.status, { state: { protocol }, event, data: { stage: protocol.stage, ...data } }) };
    });
    if (result.saved) return result.saved;
    throw new StaleProtocolCheck({ ...operation, state: { ...operation.state, protocol: { ...own, notSaved: result.notSaved } } });
  }
  const revisionOf = (operation) => operation.state?.protocol?.revision ?? 0;
  // chain readback: keep signed CREATE bytes that just
  // authenticated on chain, outside any check's progress. It is not progress,
  // so the revision stays and no caller's snapshot goes stale; a later save
  // starts from the stored row, so they stay. Only the payment gates call this
  // (never while a save that patches chainReadback can run: those are at
  // agreement_pending or settled_verified, and a changed status writes
  // nothing). An address already kept is never replaced.
  function keepChainPointers(operation, creates) {
    if (!creates || !Object.keys(creates).length) return operation;
    return transaction(db, () => {
      const stored = ops.get(operation.accountId, operation.id);
      if (!stored || stored.status !== operation.status) return operation;
      const kept = stored.state.protocol.chainReadback ?? {}, added = Object.fromEntries(Object.entries(creates).filter(([address]) => kept[address] === undefined));
      if (!Object.keys(added).length) return stored;
      return ops.transition(operation.id, stored.status, stored.status, { state: { protocol: { ...stored.state.protocol, chainReadback: { ...kept, ...added } } },
        event: 'protocol_chain_pointer_kept', data: { addresses: Object.keys(added) } });
    });
  }
  // chain readback: a final purchase that can no longer obtain a
  // missing chain pointer (its seller asks are spent, or its seller session key
  // is retired) is held for the operator: the verified result stays, and ops
  // health reports it until a later readback keeps every pointer. Like
  // keepChainPointers it is not progress. The operator's key sweep calls this
  // when it retires a key at the pointer retention bound.
  const heldForOperator = (missing, reason) => ({ action: CHAIN_READBACK_OPERATOR_ACTION, since: new Date(now()).toISOString(), missing, reason: String(reason).slice(0, 240) });
  function holdChainReadback(operation, reason) {
    return transaction(db, () => {
      const stored = ops.get(operation.accountId, operation.id);
      if (!stored || stored.status !== 'settled_verified' || !deliveryIsFinal(stored.state.protocol) || stored.state.protocol.chainReadbackHeld) return stored ?? null;
      const missing = missingChainPointers(stored);
      if (!missing.length) return stored;
      const held = { ...heldForOperator(missing, reason), source: 'host-supplied' };
      return ops.transition(stored.id, stored.status, stored.status, { state: { protocol: { ...stored.state.protocol, chainReadbackHeld: held } }, event: 'protocol_chain_readback_held', data: held });
    });
  }
  const withAttempt = (protocol, entry) => [...(protocol?.attempts ?? []).slice(-9), entry];
  // `written: false` is set only where an Agreement-context consumer invoked no
  // provider, so no write can have been made; ops health trusts nothing else.
  // The local TLS guard alone supplies `dispatched: false`; that describes
  // this attempt and never resolves an earlier unknown write.
  const recordedAttempt = (outcome, reason, written, causeCode, dispatched) => ({ outcome, ...(dispatched === false ? { dispatched } : {}), ...(sellerFailureCause(causeCode) ? { causeCode } : {}), ...(reason ? { reason: cutText(reason, 240) } : {}), ...(written === false ? { written } : {}) });
  // The purchase was cancelled or expired while this step's call was in flight,
  // so the attempt cannot be saved on it. Its event is still logged: a
  // possibly-issued write is never lost. The purchase is unchanged.
  const noteLost = (operation, step, outcome, reason, { written, data, causeCode, dispatched } = {}) => {
    try { ops.record(operation.id, `protocol_${step}`, { ...recordedAttempt(outcome, reason, written, causeCode, dispatched), ...data }); } catch { /* the caller's error stands */ }
  };
  // data: extra event fields only; the protocol attempt view is unchanged.
  const note = (operation, step, outcome, reason, patch = {}, { data, written, causeCode, dispatched, ...options } = {}) => {
    const recorded = recordedAttempt(outcome, reason, written, causeCode, dispatched);
    try {
      return save(operation, patch, { event: `protocol_${step}`, data: { ...recorded, ...data }, attempt: { at: new Date(now()).toISOString(), step, ...recorded }, ...options });
    } catch (error) {
      if (error instanceof OperationError && error.code === 'invalid_state') noteLost(operation, step, outcome, reason, { written, data, causeCode, dispatched });
      throw error;
    }
  };
  // Flows that check and advance: a stale save ends the flow, and the caller
  // gets its own unsaved view (marked notSaved).
  const endIfStale = (flow) => async (...args) => {
    try {
      return await flow(...args);
    } catch (error) {
      if (error instanceof StaleProtocolCheck) return error.operation;
      throw error;
    }
  };
  // Signing requests: a stale save means another request saved first, so
  // answer once more from the stored operation (its saved identity or plan),
  // never with this unsaved one.
  const fromStoredIfStale = (operation, error, retry) => {
    if (!(error instanceof StaleProtocolCheck)) throw error;
    return retry(ops.get(operation.accountId, operation.id));
  };

  const requireStage = (operation, ...stages) => {
    const stage = operation.state?.protocol?.stage;
    if (!stages.includes(stage)) throw new OperationError('invalid_state', `DACS purchase step is ${stage ?? 'unset'}`);
  };
  const buyerClaim = (operation) => claimForAddress(operation.terms.buyer.wallet);
  function requireDelegationMargin(operation, step) {
    if (!operation.terms.protocol?.sellerTransport?.delegation) return;
    const expiresAt = operation.state.protocol?.sessionDelegation?.payload?.expiresAt;
    if (Number.isSafeInteger(expiresAt) && expiresAt - now() >= SELLER_DELEGATION_SAFETY_MARGIN_MS) return;
    const when = Number.isSafeInteger(expiresAt) ? new Date(expiresAt).toISOString() : 'unknown';
    throw new OperationError('seller_delegation_expiring', `the seller session delegation expires at ${when}, less than ${SELLER_DELEGATION_SAFETY_MARGIN_MS / 60000} minutes from now, so ${step} would need a seller write it may not finish; nothing was signed or sent. Prepare a new purchase.`);
  }

  // ---- DACS-1 identity presentation (wallet signature) ----
  function identityRequest(operation, address) {
    assertPurchaseActionsAdmitted();
    assertBuyerAccess(operation.terms.buyer.wallet, operation);
    try {
      return identityRequestOnce(operation, address);
    } catch (error) {
      return fromStoredIfStale(operation, error, (stored) => identityRequestOnce(stored, address));
    }
  }

  function identityRequestOnce(operation, address) {
    if (operation.status !== 'agreement_pending') throw new OperationError('invalid_state', `purchase is ${operation.status}`);
    if (address !== operation.terms.buyer.wallet) throw new OperationError('wrong_wallet', 'connect the wallet bound to this purchase');
    requireStage(operation, 'identity', 'agreement-signing');
    let current = operation;
    if (!current.state.protocol.identity) {
      const unsigned = buildUnsignedIdentityBundle({ address, presentedAt: now(), sessionSeed: `${operation.id}:${operation.terms.protocol.jobId}` });
      current = save(current, { identity: unsigned }, { event: 'protocol_identity_requested' });
    }
    if (operation.terms.protocol.sellerTransport?.delegation && !current.state.protocol.sessionDelegation) {
      if (!sellerTransport?.sessionDelegation) throw new OperationError('seller_delegation_unavailable', 'the retained seller session authority is unavailable');
      const requested = sellerTransport.sessionDelegation.request(current);
      current = save(current, { sessionDelegation: { payload: requested.payload } }, { event: 'protocol_seller_session_requested' });
    }
    const delegation = current.state.protocol.sessionDelegation;
    return { operation: current, message: current.state.protocol.identity.message, ...(delegation ? { delegation: { payload: delegation.payload, message: sellerTransport.sessionDelegation.request(current).message } } : {}) };
  }

  // ---- DACS-3 plan: the exact Agreement the wallet will sign ----
  // Async only for the operator context read; every other path is unchanged.
  // One plan step per purchase runs at a time: its context read can wait on
  // seller approvals for longer than the page's HTTP request lives. A second
  // request with the same signatures waits for the running one and gets its
  // answer; one with other signatures is told it is already running, and
  // nothing is read, signed or saved for it. A saved plan never waits, and a
  // purchase no longer pending is refused before any running step is joined.
  const planFlights = new Map();
  const flightKey = (operation) => canonicalize([operation.accountId, operation.id]);
  const flightArgs = (presentationSignature, delegationSignature, intentGeneratedAt) => canonicalize([presentationSignature ?? null, delegationSignature ?? null, intentGeneratedAt ?? null]);
  // A waiter gives up after planWaitMs with 202 plan_in_progress. The step
  // keeps running and saves its plan or its attempt note, which the page reads
  // from the purchase status; no other step is started for the waiter.
  function waitForPlan(flight) {
    let timer;
    const bound = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new OperationError('plan_in_progress', 'the Agreement plan step for this purchase is still running (it can wait on seller approvals); nothing else was started or signed for this request. Check the purchase status: once the plan is saved, continue from it'), { httpStatus: 202 })), planWaitMs);
    });
    return Promise.race([flight, bound]).finally(() => clearTimeout(timer));
  }
  // The authenticated check the portal route makes before its domain, balance
  // and fee reads: the running step's own signatures wait for it, others are
  // told at once. Null when no step runs (or none may be joined).
  function runningPlan(operation, presentationSignature, delegationSignature, intentGeneratedAt) {
    assertBuyerAccess(operation.terms.buyer.wallet, operation);
    if (operation.status !== 'agreement_pending' || operation.state?.protocol?.planned) return null;
    const running = planFlights.get(flightKey(operation));
    if (!running) return null;
    if (running.args !== flightArgs(presentationSignature, delegationSignature, intentGeneratedAt)) throw new OperationError('plan_in_progress', 'the Agreement plan step for this purchase is already running; nothing was signed for this request. Check the purchase status: once the plan is saved, continue from it');
    return waitForPlan(running.flight);
  }
  // Whether this process runs the purchase's plan step now. In memory only:
  // a restart ends the step, and a client may then submit its retained
  // signatures again.
  const planRunning = (operation) => planFlights.has(flightKey(operation));
  // Every plan step this process runs now, so an owner's shutdown can drain
  // them like its admitted requests. Each settles when its step ends.
  const planFlightsRunning = () => [...planFlights.values()].map((running) => running.flight);
  async function planRequest(operation, presentationSignature, delegationSignature, intentGeneratedAt) {
    assertPurchaseActionsAdmitted();
    assertBuyerAccess(operation.terms.buyer.wallet, operation);
    if (operation.status !== 'agreement_pending') throw new OperationError('invalid_state', `purchase is ${operation.status}`);
    if (operation.state?.protocol?.planned) return planRequestStep(operation, presentationSignature, delegationSignature, intentGeneratedAt);
    const joined = runningPlan(operation, presentationSignature, delegationSignature, intentGeneratedAt);
    if (joined) return joined;
    const key = flightKey(operation);
    const flight = planRequestStep(operation, presentationSignature, delegationSignature, intentGeneratedAt).finally(() => planFlights.delete(key));
    flight.catch(() => {});
    planFlights.set(key, { args: flightArgs(presentationSignature, delegationSignature, intentGeneratedAt), flight });
    return waitForPlan(flight);
  }

  async function planRequestStep(operation, presentationSignature, delegationSignature, intentGeneratedAt) {
    let planned;
    try {
      planned = await planRequestOnce(operation, presentationSignature, delegationSignature, intentGeneratedAt);
    } catch (error) {
      planned = await fromStoredIfStale(operation, error, (stored) => planRequestOnce(stored, presentationSignature, delegationSignature, intentGeneratedAt));
    }
    // The provider keeps only the saved request's context, for the seller.
    if (usesDemDeliveryContext(planned.operation) && planned.operation.state.protocol.planned) releaseDemDeliveryContext(demDeliveryContext, { jobId: planned.operation.terms.protocol.jobId, generatedAt: planned.operation.state.protocol.planned.draft.generatedAt });
    return planned;
  }
  // Once a purchase ends, the provider drops the job's in-memory entries.
  if (demDeliveryContext) ops.onTransition?.((changed) => {
    if (!ENDED_STATUSES.has(changed.status) || !usesDemDeliveryContext(changed)) return;
    if (ENDED_STATUSES.has(ops.get(changed.accountId, changed.id)?.status)) releaseDemDeliveryContext(demDeliveryContext, { jobId: changed.terms.protocol.jobId });
  });

  async function planRequestOnce(operation, presentationSignature, delegationSignature, intentGeneratedAt) {
    if (operation.status !== 'agreement_pending') throw new OperationError('invalid_state', `purchase is ${operation.status}`);
    requireStage(operation, 'identity', 'agreement-signing');
    const p = operation.state.protocol;
    if (p.planned) return { operation, request: signRequest(operation) };
    if (!p.identity) throw new OperationError('invalid_state', 'present your wallet identity first');
    let buyerBundle;
    try {
      buyerBundle = attachIdentityPresentation(p.identity, presentationSignature);
    } catch {
      throw new OperationError('bad_signature', 'the identity presentation signature does not verify for the purchase wallet');
    }
    if (operation.terms.protocol.sellerTransport?.delegation) {
      if (!sellerTransport?.sessionDelegation) throw new OperationError('seller_delegation_unavailable', 'the retained seller session authority is unavailable');
      let delegation;
      try { delegation = sellerTransport.sessionDelegation.accept(operation, delegationSignature ?? p.sessionDelegation?.signature); }
      catch { throw new OperationError('bad_signature', 'the seller session delegation does not verify for this purchase wallet and scope'); }
      operation = save(operation, { sessionDelegation: delegation }, { event: 'protocol_seller_session_delegated' });
      // Before the context read: it can already make seller Vet writes.
      requireDelegationMargin(operation, 'the Agreement plan');
    }
    // Only the intent route supplies an already approved exact generation time.
    const generatedAt = intentGeneratedAt ?? now();
    // Read again right before each Vet signature or anchor intent: a purchase
    // no longer pending starts no new write.
    const writable = () => {
      const current = ops.get(operation.accountId, operation.id);
      if (current?.status !== 'agreement_pending') return `purchase is ${current?.status ?? 'absent'}`;
      if (current.termsHash !== operation.termsHash) return 'purchase terms changed';
      return Date.parse(current.expiresAt) > now() || 'the purchase approval window elapsed';
    };
    if (!usesAgreementContext(operation)) return savePlan(operation, buyerBundle, planAgreement({ jobId: operation.terms.protocol.jobId, listing: p.listing, buyerBundle, generatedAt }));
    const resolved = usesDemDeliveryContext(operation)
      ? await resolveDemDeliveryBuyerContext(demDeliveryContext, { operation, listing: p.listing, buyerBundle, generatedAt, writable })
      : await resolveAgreementContext(agreementContext, { operation, listing: p.listing, buyerBundle, generatedAt });
    // Re-read after the await: an exact plan saved meanwhile is never replaced.
    const current = ops.get(operation.accountId, operation.id);
    const changed = current?.status !== 'agreement_pending' || current.termsHash !== operation.termsHash;
    // Expiry is applied lazily at entry points; the approval window can elapse
    // during the provider read. Refuse before returning or saving any plan; the
    // next entry point records the expiry through the purchase service.
    const elapsed = !changed && Date.parse(current.expiresAt) <= now();
    // A provider answer other than present may follow a seller Vet write.
    if ((changed || elapsed) && resolved.disposition !== 'present') noteLost(operation, 'agreement-context', resolved.disposition, resolved.reason, { written: resolved.written });
    if (changed) throw new OperationError('invalid_state', 'the purchase changed while its Agreement context was read; no Agreement was planned or signed');
    if (elapsed) throw new OperationError('invalid_state', 'the purchase approval window elapsed while its Agreement context was read; no Agreement was planned or signed');
    if (current.state.protocol.planned) return { operation: current, request: signRequest(current) };
    // The context read may have signed and sent Vet records; only the
    // Agreement is known to be neither planned nor signed here.
    if (resolved.disposition !== 'present') {
      note(current, 'agreement-context', resolved.disposition, resolved.reason, {}, { written: resolved.written });
      if (resolved.code === 'legacy_party_vet_state_missing') throw new OperationError(resolved.code, 'this purchase was started by an earlier server version; nothing was signed or sent; start a new purchase');
      throw new OperationError('agreement_context_held', `the operator Agreement context is ${resolved.disposition} (${resolved.reason}); no Agreement was planned or signed`);
    }
    let planned;
    try {
      planned = planAgreementFromInput(resolved.input);
    } catch (error) {
      throw new OperationError('agreement_context_held', `the SDK refused the bound Agreement context (${String(error?.message ?? error).slice(0, 160)}); no Agreement was planned or signed`);
    }
    const parties = planned.draft.parties;
    if (!['buyer', 'seller'].every((role) => canonicalize(parties.find((x) => x.role === role)?.vetRecordRef) === canonicalize(resolved.input[role].vetRecordRef))) {
      throw new OperationError('agreement_context_held', 'the derived Agreement does not carry the bound context Vet refs; no Agreement was planned or signed');
    }
    return savePlan(current, buyerBundle, planned, { source: usesDemDeliveryContext(current) ? DEM_DELIVERY_CONTEXT_SOURCE : AGREEMENT_CONTEXT_SOURCE,
      authority: resolved.authority, scopeHash: contentHash(resolved.scope), resolvedAt: new Date(now()).toISOString() });
  }

  function savePlan(operation, buyerBundle, planned, context) {
    if (operation.terms.protocol.sellerTransport?.delegation) {
      try { verifySellerSessionDelegation(operation.state.protocol.sessionDelegation, { buyer: buyerClaim(operation), seller: operation.terms.seller.claim, listingPin: Object.fromEntries(['listingId', 'version', 'contentHash'].map((key) => [key, operation.terms.listing[key]])), jobId: operation.terms.protocol.jobId, time: now(), deadline: planned.draft.terms.deadline }); }
      catch { throw new OperationError('seller_delegation_invalid', 'the seller delegation is expired or differs from the derived Agreement'); }
      requireDelegationMargin(operation, 'the Agreement plan');
    }
    const bound = boundTermsMismatch(operation, planned.draft);
    if (bound) throw new OperationError('agreement_terms_mismatch', `the derived Agreement differs from the prepared terms (${bound}); nothing was signed`);
    const next = save(operation, { stage: 'agreement-signing', buyerBundle, planned: plainJson(planned), ...(context ? { agreementContext: context } : {}) }, { event: 'protocol_agreement_planned', data: { agreementHash: planned.plan.agreementHash } });
    return { operation: next, request: signRequest(next) };
  }

  function signRequest(operation) {
    assertPurchaseActionsAdmitted();
    assertBuyerAccess(operation.terms.buyer.wallet, operation);
    const p = operation.state.protocol;
    const t = p.planned.draft.terms;
    return {
      agreementMessage: p.planned.agreementMessage,
      anchorMessage: p.planned.anchorMessage,
      agreementHash: p.planned.plan.agreementHash,
      summary: {
        jobId: p.planned.draft.jobId,
        listing: p.planned.draft.listingRef,
        seller: operation.terms.seller.claim,
        payee: t.payoutBindings[0].payeeAddress,
        amount: `${t.price.amount} ${t.price.currency}`,
        amountOs: operation.terms.price.amountOs,
        network: `${operation.terms.network} · ${operation.terms.rail}`,
        deadline: new Date(t.deadline).toISOString(),
      },
      ...(isOfflineWalletAgreement(operation) ? { anchorMessage: null, anchorKind: sourceTerms(operation) ? DEVNET_AGREEMENT_KIND : SR2_WALLET_KIND, storageApproval: 'exact-create-and-debit-in-packaged-wallet', payment: 'held' } : {}),
    };
  }

  // ---- DACS-3 exchange, anchor, commitment readback ----
  async function submitAgreement(operation, { agreementSignature, anchorSignature } = {}) {
    assertPurchaseActionsAdmitted();
    assertBuyerAccess(operation.terms.buyer.wallet, operation);
    if (isOfflineWalletAgreement(operation)) {
      if (!walletAvailable) throw unavailable();
      const work = () => walletConfig.journal.withWalletLock(`plugin/agreement/${operation.id}`, () => {
        const current = ops.get(operation.accountId, operation.id);
        if (nativePayment) nativePayment.unresolved(current);
        return submitAgreementCore(current, { agreementSignature, anchorSignature });
      });
      return nativePayment ? nativePayment.withWorkflow(operation, work) : work();
    }
    return submitAgreementCore(operation, { agreementSignature, anchorSignature });
  }

  async function submitAgreementCore(operation, { agreementSignature, anchorSignature } = {}) {
    if (!available) throw unavailable();
    if (operation.status !== 'agreement_pending') throw new OperationError('invalid_state', `purchase is ${operation.status}`);
    let current = operation;
    const p = current.state.protocol;
    if (agreementSignature || anchorSignature) {
      requireStage(current, 'agreement-signing');
      // The first signature starts the seller proposal, the buyer's Agreement
      // CREATE and the seller commit. A resubmission resumes that work.
      if (!p.signatures) requireDelegationMargin(current, 'the Agreement exchange');
      const wallet = current.terms.buyer.wallet;
      if (!verifyDemosSignature({ address: wallet, message: p.planned.agreementMessage, signature: agreementSignature ?? '' })) throw new OperationError('bad_signature', 'the Agreement signature does not verify for the purchase wallet');
      current = save(current, { signatures: { agreement: agreementSignature, ...(anchorSignature ? { anchor: anchorSignature } : {}) } }, { event: 'protocol_agreement_signed' });
    }
    requireStage(current, 'agreement-signing', 'agreement-anchored');
    if (!current.state.protocol.signatures) throw new OperationError('invalid_state', 'sign the Agreement first');
    return continueAgreement(current);
  }

  const continueAgreement = (operation) => continueWalletAgreement(operation);

  // Native receipt contract for the bounded offline mode. Retain the exact
  // SDK-produced artifact before wallet approval. An intent with no surviving
  // handoff stays indeterminate; re-entry never substitutes a new send.
  async function continueWalletAgreement(operation) {
    // Browser authentication must precede a fresh retained CREATE intent. The
    // loopback broker's resumed bridge cannot deliver or broadcast again.
    const walletBridgeForOperation = walletConfig.bridgeFor ? walletConfig.bridgeFor(operation) : walletBridge;
    let current = operation;
    const p = current.state.protocol;
    const writer = buyerClaim(current);
    const jobId = current.terms.protocol.jobId;
    const logicalAddress = fixedPriceAgreementLogicalAddress(jobId);
    const agreementHash = p.planned.plan.agreementHash;
    const sameInput = (input) => p.planned.anchorAddress === logicalAddress && input.logicalAddress === logicalAddress && input.agreementHash === agreementHash;
    const retainedInput = () => current.state.protocol.walletAnchor;
    const sameRetainedScope = (retained) => retained?.artifactKind === 'Agreement' && retained.jobId === jobId && retained.artifact?.jobId === jobId
      && retained.writer === writer && retained.logicalAddress === logicalAddress && retained.receiptContentHash === agreementHash
      && !boundTermsMismatch(current, retained.artifact) && contentHash(retained.artifact) === agreementHash;
    const bridgeError = (error) => ({ disposition: ['invalid', 'wrong-writer', 'conflict', 'hash-profile-held'].includes(error?.code) ? 'rejected' : 'indeterminate',
      reason: `wallet anchor: ${error?.code ?? 'unavailable'}: ${String(error?.message ?? error).slice(0, 180)}` });
    function nativeResult(result) {
      if (result.status !== ('native-read-visible')) return { disposition: result.status === 'rejected' ? 'rejected' : 'indeterminate', reason: result.code ?? 'native readback is unavailable' };
      return { disposition: 'present', value: { artifact: result.artifact, ref: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: result.receipt.contentHash }, anchorReceipt: result.receipt } };
    }
    const anchorAdapter = {
      ...(commitOnSignature && walletConfig.onCreateAuthorized ? { onCreateAuthorized: (input, notify) => {
        if (sameInput(input)) walletConfig.onCreateAuthorized(current.id, notify);
      } } : {}),
      anchorAgreement: async (input) => {
        if (!sameInput(input) || boundTermsMismatch(current, input.artifact) || contentHash(input.artifact) !== input.agreementHash) return { disposition: 'rejected', reason: 'native CREATE differs from prepared Agreement scope' };
        const expected = { logicalAddress, artifact: plainJson(input.artifact), writer, artifactKind: 'Agreement', jobId, receiptContentHash: agreementHash };
        const previous = retainedInput();
        if (previous && canonicalize(previous) !== canonicalize(expected)) return { disposition: 'rejected', reason: 'retained CREATE scope differs from the signed Agreement' };
        if (!previous) current = save(current, { walletAnchor: expected }, { event: 'protocol_wallet_anchor_intent', data: { logicalAddress, agreementHash: input.agreementHash } });
        let result;
        try { result = previous ? await walletBridgeForOperation.resume(expected) : await walletBridgeForOperation.anchor(expected); }
        catch (error) {
          // In the pinned adapter this exact exception precedes any new
          // plan/handoff/wallet request. Only our fresh, provably unsent intent
          // can be discarded. Any pre-existing intent stays readback-only,
          // including missing/issued/unknown handoffs and wallet rejections.
          if (!previous && error instanceof DemosSr2Error && error.code === 'wallet-fenced') {
            current = save(current, { walletAnchor: null }, { event: 'protocol_wallet_anchor_not_issued', data: { logicalAddress, agreementHash, reason: 'wallet-fenced' } });
          }
          return bridgeError(error);
        }
        return result.status === ('native-read-visible') ? { disposition: 'submitted' } : { disposition: result.status === 'rejected' ? 'rejected' : 'indeterminate', reason: result.code ?? 'wallet CREATE outcome is unknown' };
      },
      reconcileAgreementAnchor: async (input) => {
        if (!sameInput(input)) return { disposition: 'rejected', reason: 'Agreement reconciliation scope changed' };
        const retained = retainedInput();
        if (!retained) return { disposition: 'absent', reason: 'this operation has not issued a wallet CREATE intent' };
        if (!sameRetainedScope(retained)) return { disposition: 'rejected', reason: 'retained wallet CREATE owner or Agreement scope changed' };
        try { return nativeResult(await walletBridgeForOperation.resume(retained)); }
        catch (error) { return bridgeError(error); }
      },
      verifyAnchorReceipt: async ({ expectedWriter, ref, receipt }) => {
        const retained = retainedInput();
        if (!sameRetainedScope(retained) || expectedWriter !== writer || ref.anchor.locator !== logicalAddress || ref.contentHash !== agreementHash) return 'invalid';
        return walletBridgeForOperation.verifyReceipt({ receipt, logicalAddress, artifact: retained.artifact, expectedWriter: writer, artifactKind: 'Agreement' });
      },
    };
    const seller = sellerFor(current);
    const progress = await exchangeAgreement({ plan: p.planned.plan, draft: p.planned.draft, buyerClaim: writer, buyerBundle: p.buyerBundle,
      agreementSignature: p.signatures.agreement, seller, anchorAdapter, commitOnSignature });
    if (progress.disposition === 'rejected') return note(current, 'agreement', 'rejected', `${progress.stage}: ${progress.reason}`, { stage: 'agreement-rejected' }, { toStatus: 'agreement_rejected' });
    if (progress.disposition !== 'anchored') return note(current, 'agreement', progress.disposition, `${progress.stage}: ${progress.reason}`, {}, { causeCode: seller.failureCause, dispatched: seller.failureDispatched });
    const agreement = plainJson(progress.result.agreement);
    if (boundTermsMismatch(current, agreement)) return note(current, 'agreement', 'rejected', 'native anchored Agreement differs from prepared terms', { stage: 'agreement-rejected' }, { toStatus: 'agreement_rejected' });
    const anchored = note(current, 'agreement', 'anchored', null, { stage: 'agreement-anchored', agreement: { artifact: agreement, hash: progress.result.agreementHash,
      ref: plainJson(progress.result.agreementRef), anchorReceipt: plainJson(progress.result.anchorReceipt), terms: agreementTerms(agreement) } });
    return usesSellerSr2Commitment(anchored) ? continueSellerSr2Commitment(anchored) : anchored;
  }

  // Opt-in only: the seller reads the buyer's native SR-2 Agreement itself and
  // commits; the buyer trusts only its own readback of the finalized commitment
  // (fixture substrate). Default operations stop at `seller-committed` and
  // remain agreement_pending/payment held. Explicitly prepared native payment
  // terms alone progress to the normal awaiting_approval path.
  async function continueSellerSr2Commitment(operation) {
    let current = operation, commitAnswer;
    try {
      let signedProjection;
      if (current.terms.protocol.sellerAgreementProjection === SELLER_SR2_PUBLIC_PROJECTION) {
        const p = current.state.protocol;
        signedProjection = p.agreement.signedProjection;
        if (!signedProjection) {
          const receipt = p.agreement.anchorReceipt;
          const proof = decodeDemosAnchorReceiptProof(receipt);
          // The injected journal contains public bytes only. Select the exact
          // approved, verified CREATE named by the buyer's native receipt; never
          // export its plan, approval flags, wallet lane or signing capability.
          const records = (await walletConfig.journal.entries()).filter(([key, r]) => key.startsWith('sr2/adapter/')
            && r.stage === 'verified' && r.authorizationProfile === 'embedded-storage-anchor-create'
            && r.logicalAddress === receipt.logicalAddress && r.writer === receipt.writer
            && r.transactionHash === receipt.transactionRef.value && r.hash === p.agreement.hash);
          if (records.length !== 1) throw new OperationError('agreement_projection_unavailable', 'the exact public signed CREATE is unavailable; payment remains held');
          signedProjection = plainJson(records[0][1].authorizedTransaction);
          if (signedProjection.hash !== receipt.transactionRef.value || sha256Hex(JSON.stringify(signedProjection.content)) !== signedProjection.hash
            || demosSignedTransactionProofHash(signedProjection) !== proof.signedTransactionHash) throw new OperationError('agreement_projection_unavailable', 'the public signed CREATE differs from the native receipt; payment remains held');
          current = save(current, { agreement: { ...p.agreement, signedProjection } }, { event: 'protocol_agreement_public_projection_retained' });
        }
      }
      commitAnswer = await sellerFor(current).commit(current.terms.protocol.jobId, signedProjection === undefined ? {} : { signedProjection });
    } catch (error) {
      if (error instanceof StaleProtocolCheck) throw error;
      current = note(current, 'commit-request', error instanceof SellerRefusedError ? 'refused' : 'unavailable', error.message, {}, sellerFailureAttempt(error));
    }
    const readback = await readCurrentCommitment(current, { answer: commitAnswer });
    if (readback.status === 'verified') {
      return note(current, 'commitment', 'verified', null, {
        stage: 'seller-committed',
        commitment: { address: readback.address, ref: readback.ref, contentHash: readback.contentHash, signer: readback.signer, committedAt: readback.committedAt, verifiedAt: new Date(now()).toISOString(), substrate: 'source-native-one-node' },
        ...chainRetained(current, readback.chainSignedCreate ? { [readback.address]: readback.chainSignedCreate } : null),
      }, usesNativeAgreementPayment(current) ? { toStatus: 'awaiting_approval' } : {});
    }
    if (readback.status === 'rejected' && readback.authenticated === true) return note(current, 'commitment', 'rejected', readback.reason, { stage: 'agreement-rejected' }, { toStatus: 'agreement_rejected' });
    return note(current, 'commitment', readback.status === 'rejected' ? 'indeterminate' : readback.status, readback.reason ?? 'no finalized commitment at the canonical address yet', {},
      readback.sellerAnswerDiagnostic ? { data: { sellerAnswerDiagnostic: readback.sellerAnswerDiagnostic } } : {});
  }

  // The seller's existing idempotent commit route, asked again with exactly the
  // body this purchase first sent (continueSellerSr2Commitment). The seller
  // replays its stored answer, which carries its verified signed CREATEs as a
  // pointer. Nothing is signed for, resent or written; a failure is only why
  // no pointer was obtained.
  async function replayedCommitAnswer(operation) {
    const p = operation.state.protocol, projected = operation.terms.protocol.sellerAgreementProjection === SELLER_SR2_PUBLIC_PROJECTION;
    if (projected && !p.agreement?.signedProjection) return { reason: 'no kept Agreement signed CREATE to repeat the seller commit request unchanged' };
    try { return { answer: await sellerFor(operation).commit(operation.terms.protocol.jobId, projected ? { signedProjection: p.agreement.signedProjection } : {}) }; }
    catch (error) { return { reason: `the seller's commit answer could not be replayed (${error instanceof SellerRefusedError ? 'refused' : 'unavailable'}: ${String(error?.message ?? error).slice(0, 160)})` }; }
  }

  // Fresh independent readback, required before approval and before handoff.
  // By default the Agreement and commitment are re-read from the chain. Only
  // the pre-approval gate passes reuseVerified, accepting proofs this purchase
  // verified within the short TTL; the handoff gate reads fresh. With the
  // purchase readback cache on, its Agreement hit re-reads the current program
  // state only, reusing this purchase's authenticated transaction/block proof.
  async function recheckCommitment(operation, { reuseVerified = false } = {}) {
    assertPurchaseActionsAdmitted();
    assertBuyerAccess(operation.terms.buyer.wallet, operation);
    assertAgreementPaymentHeld(operation);
    if (!available) throw unavailable();
    const p = operation.state?.protocol;
    if (!p?.commitment || (!ACCEPTED.has(p.stage) && !(usesNativeAgreementPayment(operation) && ['seller-committed', 'payment-observed'].includes(p.stage)))) throw new OperationError('commitment_required', 'the seller\'s finalized commitment has not been read back; nothing was signed or sent');
    // Every caller precedes payment; the seller must still accept new payment evidence.
    requireDelegationMargin(operation, 'payment');
    if (usesNativeAgreementPayment(operation)) {
      if (!nativePayment) throw unavailable();
      await nativePayment.verifyAgreement(operation, { reuseVerified });
    }
    // chain readback with no kept commitment bytes (the row
    // verified while the switch was off): the seller's replayed commit answer
    // is the only pointer, authenticated exactly as a fresh one and then kept.
    const address = finalityCommitmentAddress(operation.terms.protocol.jobId);
    const replay = chainReadback && operation.terms.protocol.sellerCommitment === DEVNET_NATIVE_COMMITMENT_MARKER && p.chainReadback?.[address] === undefined
      ? await replayedCommitAnswer(operation) : null;
    const readback = await readCurrentCommitment(operation, { fresh: !reuseVerified, answer: replay?.answer });
    if (readback.status !== 'verified' || readback.contentHash !== p.commitment.contentHash || readback.signer !== p.commitment.signer || readback.committedAt !== p.commitment.committedAt) {
      const why = [readback.reason, replay?.reason].filter(Boolean).join('; ');
      throw new OperationError('commitment_unverified', `the seller's finalized commitment did not verify on re-read (${readback.status}${why ? `: ${why}` : ''}); nothing was signed or sent`);
    }
    if (replay && readback.chainSignedCreate) keepChainPointers(operation, { [address]: readback.chainSignedCreate });
    const terms = p.agreement.terms;
    if (terms.payee !== operation.terms.seller.payee || terms.price.amountOs !== operation.terms.price.amountOs) {
      throw new OperationError('agreement_terms_mismatch', 'the committed Agreement does not bind the prepared payee and amount; nothing was signed or sent');
    }
    return readback;
  }

  // Native purchases use advanceNativeEvidence; DACS-5 is held in this profile.
  const completionHeld = () => { throw new OperationError('native_completion_held', 'completed bundle exchange is not enabled in the native purchase profile'); };
  const countersignRequest = completionHeld;
  const countersign = completionHeld;
  const checkDelivery = completionHeld;

  const RETAINED_ANSWER_SOURCE = 'retained; the seller was not asked';
  // The authenticated seller answer that led a delegated purchase to verified
  // delivery. It is only a pointer to exact native records: readback-only
  // rechecks re-read and re-verify them without a seller request or session
  // signature. Rows verified before it was retained derive the same pointer
  // from their verified delivery (derive), but only once their key is gone:
  // while it exists the seller is asked, as on main, and a full answer is
  // retained. Anything else has no seller-free readback.
  function retainedSellerAnswer(operation, { derive = true } = {}) {
    const p = operation.state.protocol;
    if (!p.sessionDelegation) return null;
    if (p.sellerAnswer) return p.sellerAnswer;
    if (!derive) return null;
    const d = p.delivery, n = p.nativeEvidence;
    if (!d?.deliverableRef?.anchor?.locator || !d.report?.settlementId) return null;
    return { status: n?.sellerStatus, settlementId: d.report.settlementId, evidenceAddress: n?.evidenceAddress ?? null, evidenceHash: n?.evidenceHash ?? null,
      anchorAttempt: n?.anchorAttempt ?? null, delivery: { status: d.status, fulfilmentId: d.fulfilmentId, logicalAddress: d.deliverableRef.anchor.locator,
        contentHash: d.payloadHash, evidenceHash: d.evidenceHash, anchorReceipt: d.anchorReceipt } };
  }

  // verify_deal / portal re-check entry point: drive whatever is pending.
  // retained: readback only, from retainedSellerAnswer; the seller is not asked.
  // Chain readback: pointerAsk, this recheck asked the seller
  // only for chain pointers a final row lacks (counted in chainPointerAsks);
  // sellerProblem, why the seller's own answer was not used; sellerGone, the
  // seller session key is retired, so no later ask can obtain a pointer.
  async function advanceNativeEvidence(operation, coords, { retained = null, pointerAsk = false, sellerProblem = null, sellerGone = false } = {}) {
    // A failed current read downgrades a previously delivered view, but an
    // initial ambiguous delivery has no stale proof to revoke and retains its
    // existing payment-observed/held vocabulary.
    const unavailableStage = () => operation.state.protocol.delivery
      ? (operation.state.protocol.paymentEvidence ? 'payment-evidenced' : 'native-payment-evidence-held')
      : operation.state.protocol.stage;
    // Every outcome keeps the newest retained answer. This recheck's snapshot
    // can predate a concurrent one that retained it (after which the sweep may
    // have deleted the key), so the stored answer is read in the same
    // transaction as the write. Only fresh, an answer this recheck just got
    // from the seller and checked against its own verified receipt and
    // delivery (replacementAnswerProblem), replaces it; a retained or derived
    // pointer never does. A derived pointer is written only where nothing is
    // stored, with every outcome of its readback, so a failed read (which
    // clears the delivery) never loses the way back. A check that is not saved
    // (stale, or the purchase changed) has logged only its event; that event
    // commits with this transaction and the error is thrown after it.
    const asks = pointerAsk ? { chainPointerAsks: { count: (operation.state.protocol.chainPointerAsks?.count ?? 0) + 1, at: new Date(now()).toISOString() } } : {};
    const settle = (step, outcome, reason, patch, fresh = null, data) => {
      const result = transaction(db, () => {
        const pointer = fresh ?? ops.get(operation.accountId, operation.id)?.state?.protocol?.sellerAnswer ?? (retained ? plainJson(retained) : undefined);
        try {
          return { saved: note(operation, step, outcome, reason, { ...patch, ...asks, ...(pointer ? { sellerAnswer: pointer } : {}) }, { data, causeCode: data?.causeCode, dispatched: data?.dispatched }) };
        } catch (error) {
          if (error instanceof StaleProtocolCheck || (error instanceof OperationError && error.code === 'invalid_state')) return { error };
          throw error;
        }
      });
      if (result.error) throw result.error;
      return result.saved;
    };
    // Readback-only exits before a new summary is built still mark the seller
    // fields they leave visible.
    const marked = retained ? { nativeEvidence: { ...operation.state.protocol.nativeEvidence, sellerAnswerSource: RETAINED_ANSWER_SOURCE } } : {};
    // chain readback, once this purchase holds a verified
    // delivery: a fresh read that is not a definite, authenticated
    // contradiction changes nothing. That covers an unavailable, refusing or
    // malformed seller answer, and a payment, Deliverable or delivery-evidence
    // read that is indeterminate, has no pointer or fails. Status, stage,
    // delivery and payment evidence stay; any pointer that did authenticate is
    // kept; the attempt is chain-readback / indeterminate and names why. Nothing
    // is refunded, faulted, resent or advanced. Only a rejected read (a definite
    // contradiction) lowers or rejects the row, exactly as with the switch off,
    // and only when it rejects what this purchase already holds: signed CREATE
    // bytes it authenticated and kept (the retained answer's payment projection
    // is bound to the verified receipt), or bytes that authenticated on chain in
    // this read and read back otherwise. A rejection of what the seller offers
    // (bytes that did not authenticate, or a fresh answer whose pointer is not
    // the verified delivery) is the seller's problem: withoutSeller reads again
    // from the retained answer (sellerRejection). The adapter's `invalid` is a
    // contradiction only when marked (the source change); unmarked it reads indeterminate and
    // keeps its code, and on bytes a fresh answer offered it is still the
    // seller's problem.
    const holding = Boolean(operation.state.protocol.delivery);
    const keepVerified = (why, creates = null) => {
      const p = operation.state.protocol, kept = chainRetained(operation, creates);
      // Held for the operator once nothing can obtain a missing pointer.
      const missing = deliveryIsFinal(p) ? missingChainPointers({ ...operation, state: { ...operation.state, protocol: { ...p, ...kept } } }) : [];
      const spent = sellerGone || (asks.chainPointerAsks?.count ?? p.chainPointerAsks?.count ?? 0) >= CHAIN_POINTER_ASK_LIMIT;
      const held = missing.length && spent && !p.chainReadbackHeld
        ? heldForOperator(missing, sellerGone ? 'the seller session key is retired' : `the ${CHAIN_POINTER_ASK_LIMIT} seller asks for chain pointers are spent`) : null;
      return settle('chain-readback', 'indeterminate', `${why}${sellerProblem ? `; ${sellerProblem}` : ''}; the verified ${p.stage} result is kept and the next recheck reads again`,
        { ...marked, ...kept, ...(held ? { chainReadbackHeld: held } : {}) }, null, held ? { operatorAction: held.action, missing: held.missing } : undefined);
    };
    // A seller answer that cannot be used: the retained answer still gives a
    // seller-free fresh read, and only without one is nothing read (creates:
    // pointers that did authenticate, kept then).
    const withoutSeller = (problem, creates = null) => {
      const fallback = retained ? null : retainedSellerAnswer(operation);
      return fallback ? advanceNativeEvidence(operation, coords, { retained: fallback, pointerAsk, sellerProblem: problem }) : keepVerified(problem, creates);
    };
    // Why a rejected Deliverable or delivery evidence read of a holding row
    // rejects only what the seller offered, or null. fresh: the answer this
    // recheck just got from the seller (a retained one is bound to the verified
    // delivery already).
    const sellerRejection = (delivered, verified, fresh) => {
      const kept = operation.state.protocol.chainReadback ?? {}, jobId = operation.terms.protocol.jobId;
      const offered = (address, authenticated) => kept[address] === undefined && !authenticated;
      const why = (reason) => String(reason ?? 'no reason given').slice(0, 120);
      const refused = (disposition, code) => disposition === 'rejected' || Boolean(fresh && code === 'invalid');
      if (refused(delivered.disposition, delivered.code)) {
        const differs = fresh && deliveryPointerDiffers(verified, fresh);
        if (differs) return `the seller answer's ${differs} differs from the verified delivery`;
        if (offered(deliverableAddress(jobId), delivered.authenticated)) return `the seller answer's Deliverable signed CREATE did not authenticate (${why(delivered.reason)})`;
      }
      const evidenceHold = delivered.delivery?.evidenceHold;
      if (evidenceHold && refused(evidenceHold.status, delivered.evidenceCode)) {
        const differs = fresh && deliveryPointerDiffers(verified, fresh, { evidence: true });
        if (differs) return `the seller answer's ${differs} differs from the verified delivery`;
        if (offered(deliveryEvidenceAddress(jobId), delivered.evidenceAuthenticated)) return `the seller answer's delivery evidence signed CREATE did not authenticate (${why(evidenceHold.reason)})`;
      }
      return null;
    };
    if (!nativeEvidence) {
      if (holding) return keepVerified('the prepared consumer capability is unavailable');
      return settle('native-evidence', 'held', 'the prepared consumer capability is unavailable; no new authority is inferred', { stage: unavailableStage(), delivery: null, ...marked });
    }
    let answer, asking = false;
    try {
      const seller = retained ? null : sellerFor(operation);
      // After payment: the purchase's own verified proof may be reused.
      await nativePayment.verifyAgreement(operation, { reuseVerified: true });
      asking = !retained;
      answer = retained ?? await seller.submitPayment({ jobId: operation.terms.protocol.jobId, txHash: coords.reportedTxHash,
        payerPayingKey: buyerClaim(operation), nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE });
    } catch (error) {
      // A deleted session key never ends the readback: re-read the retained
      // pointer instead, so delivery stays current only on a fresh read.
      const pointer = !retained && error?.code === 'seller_session_retired' ? retainedSellerAnswer(operation) : null;
      if (pointer) return advanceNativeEvidence(operation, coords, { retained: pointer, ...({ pointerAsk, sellerProblem: 'the seller session key is retired', sellerGone: true }) });
      if (holding && asking) return withoutSeller(`the seller ${error instanceof SellerRefusedError ? 'refused' : 'could not be asked'} (${String(error?.message ?? error).slice(0, 120)})`);
      // An Agreement readback that is not a definite rejection is indeterminate.
      if (holding && !(error?.code === 'agreement_unverified' && error.readbackDisposition === 'rejected' && error.readbackAuthenticated === true)) return keepVerified(`the Agreement did not read back (${String(error?.message ?? error).slice(0, 120)})`);
      // Only the plugin's own codes are recorded (e.g. agreement_unverified); a seller refusal's code is seller-chosen.
      return settle('native-evidence', 'held', error.message, { stage: unavailableStage(), delivery: null, ...marked }, null, error instanceof OperationError ? { code: error.code } : sellerFailureCause(error.causeCode) ? sellerFailureAttempt(error) : undefined);
    }
    if (holding && !['delivery-ready', 'delivered'].includes(answer?.delivery?.status)) return asking ? withoutSeller('the seller answer carries no delivery-ready pointer') : keepVerified('the retained answer carries no delivery-ready pointer');
    // An HTTP status/signature is never an anchor verdict. Read the exact
    // canonical native evidence through the read-only adapter + SDK verifier.
    // With chain readback, bytes this purchase already authenticated come first.
    const paymentTerms = agreementTerms(operation.state.protocol.agreement.artifact);
    const ownPayment = paymentTerms ? signedCreateFor(paymentEvidenceAddress(operation.terms.protocol.jobId, paymentTerms.rail, paymentTerms.paymentPhaseIndex), { retained: operation.state.protocol.chainReadback }) : undefined;
    const signedProjection = ownPayment ?? answer.signedProjection;
    let read;
    const paymentRetained = (more) => read?.disposition === 'present' && read.signedProjection ? { [read.ref.anchor.locator]: signedCreateBytes(read.signedProjection), ...more } : more;
    try {
      read = await nativeEvidence.readEvidence({ agreement: operation.state.protocol.agreement.artifact, writer: operation.terms.seller.claim,
        txHash: coords.reportedTxHash, blockNumber: coords.observation.observation.blockNumber, committedAt: operation.state.protocol.commitment.committedAt, ...(signedProjection ? { signedProjection } : {}),
         });
    } catch (error) {
      if (holding) return keepVerified(`the payment evidence read failed (${String(error?.message ?? error).slice(0, 120)})`);
      return settle('native-evidence', 'held', error.message, { stage: unavailableStage(), delivery: null, ...marked });
    }
    if (read.nativeReadStatus === 'public-projection-missing' && operation.state.protocol.paymentEvidence) return keepVerified('neither this purchase nor the seller answer holds the payment evidence signed CREATE');
    if (holding && asking && (read.disposition === 'rejected' || read.code === 'invalid') && !ownPayment && !read.authenticated) // the source change: an unmarked invalid reads indeterminate
      return withoutSeller(`the seller answer's payment evidence signed CREATE did not authenticate (${String(read.reason ?? 'no reason given').slice(0, 120)})`);
    if (holding && read.disposition !== 'present' && !(read.disposition === 'rejected' && read.authenticated === true)) return keepVerified(`the payment evidence read is ${read.disposition} (${String(read.reason ?? 'no reason given').slice(0, 120)})`);
    // On a readback-only recheck the seller fields come from the retained
    // answer, not from a seller reply.
    const summary = { status: read.disposition === 'present' ? 'native-evidence-read-back' : 'held', sellerStatus: answer.status,
      reason: answer.reason ?? read.reason ?? 'delivery-held', evidenceAddress: answer.evidenceAddress ?? null, evidenceHash: answer.evidenceHash ?? null,
      nativeReadback: read.disposition, ...(read.nativeReadStatus ? { nativeReadStatus:read.nativeReadStatus } : {}), ...(read.code ? { nativeReadCode:read.code } : {}),
      nativeReadReason:read.reason ?? null, ...(answer.anchorError ? { anchorError:answer.anchorError } : {}), anchorAttempt: answer.anchorAttempt ?? null,
      delivery: answer.delivery?.status ?? 'pending', finality: 'source-pinned-one-node-view-not-independent', ...(retained ? { sellerAnswerSource: RETAINED_ANSWER_SOURCE } : {}) };
    if (read.disposition === 'present' && ['delivery-ready','delivered'].includes(answer.delivery?.status)) {
      const delivered = await readDemDeliveryReady({ anchors, nativeDemDelivery, agreement: operation.state.protocol.agreement.artifact,
        listing: operation.state.protocol.listing, seller: operation.terms.seller.claim, answer, ...(chainReadback ? { chainReadback, retainedSignedCreates: operation.state.protocol.chainReadback } : {}) });
      summary.deliveryReadback={disposition:delivered.disposition,...(delivered.reason?{reason:delivered.reason}:{})};
      const verifiedBefore = operation.state.protocol.delivery;
      const sellerFault = holding ? sellerRejection(delivered, verifiedBefore, asking ? answer : null) : null;
      if (sellerFault) return withoutSeller(sellerFault, paymentRetained(delivered.chainSignedCreates ?? null));
      if (holding && delivered.disposition !== 'present' && !(delivered.disposition === 'rejected' && delivered.authenticated === true))
        return keepVerified(delivered.pointer === POINTER_MISSING ? 'neither this purchase nor the seller answer holds the Deliverable signed CREATE'
          : `the Deliverable read is ${delivered.disposition} (${String(delivered.reason ?? 'no reason given').slice(0, 120)})`, paymentRetained(null));
      // Delivered before: evidence that does not read back now, short of a
      // definite rejection, keeps delivered.
      const evidenceHold = delivered.delivery?.evidenceHold;
      if (holding && verifiedBefore.evidenceRef && delivered.disposition === 'present' && !delivered.delivery.evidenceRef && !(evidenceHold?.status === 'rejected' && delivered.evidenceAuthenticated === true) && delivered.delivery.payloadHash === verifiedBefore.payloadHash)
        return keepVerified(delivered.evidencePointer === POINTER_MISSING ? 'neither this purchase nor the seller answer holds the delivery evidence signed CREATE'
          : `the delivery evidence read is indeterminate (${String(evidenceHold?.reason ?? 'no reason given').slice(0, 120)})`, paymentRetained(delivered.chainSignedCreates));
      if (delivered.disposition === 'rejected') return settle('delivery', 'rejected', delivered.reason, { stage: 'delivery-rejected', nativeEvidence: summary, delivery: null });
      if (delivered.disposition === 'present') {
        const patch = { stage: delivered.delivery.status, nativeEvidence: summary,
          paymentEvidence: { ref: read.ref, anchorReceipt: read.receipt, txHash: coords.reportedTxHash, blockNumber: coords.observation.observation.blockNumber },
          delivery: plainJson(delivered.delivery), ...chainRetained(operation, paymentRetained(delivered.chainSignedCreates)) };
        // A held purchase whose readback now keeps every pointer is no longer held.
        if (operation.state.protocol.chainReadbackHeld && !missingChainPointers({ ...operation, state: { ...operation.state, protocol: { ...operation.state.protocol, ...patch } } }).length) patch.chainReadbackHeld = undefined;
        // A seller answer that cannot authenticate this readback is not
        // retained; whatever is stored stays, and the summary says why.
        const fresh = !retained && operation.state.protocol.sessionDelegation ? plainJson(answer) : null;
        const refused = fresh && replacementAnswerProblem(operation, { ...operation.state.protocol, ...patch, sellerAnswer: fresh });
        if (refused) summary.sellerAnswerNotRetained = refused;
        return settle('delivery', 'verified', null, patch, refused ? null : fresh);
      }
    }
    if (read.disposition === 'present') return settle('native-evidence', 'verified-source-native-read', null,
      { stage: 'payment-evidenced', nativeEvidence: summary, paymentEvidence: { ref: read.ref, anchorReceipt: read.receipt, txHash: coords.reportedTxHash, blockNumber: coords.observation.observation.blockNumber }, delivery: null,
        ...chainRetained(operation, paymentRetained(null)) });
    return settle('native-evidence', 'held', summary.reason, { stage: 'native-payment-evidence-held', nativeEvidence: summary, delivery: null });
  }

  async function recheck(operation, coords) {
    assertPurchaseActionsAdmitted();
    try{assertBuyerAccess(operation.terms.buyer.wallet, operation);}
    catch(error){
      if(error.code==='buyer_access_closed'&&!error.details?.buyerAccessMissing&&sourceCapability){
        const read=await readIssuedArtifacts({sourceCapability,writer:buyerClaim(operation),jobId:operation.terms.protocol.jobId,unknownOnly:operation.status!=='settled_verified'});
        if(read)return operation;
      }
      throw error;
    }
    if (!available) return operation;
    const stage = operation.state?.protocol?.stage;
    if (isOfflineWalletAgreement(operation)) {
      if (usesNativeAgreementPayment(operation) && operation.status === 'settled_verified' && coords?.verifiedAt) {
        const current = stage === 'seller-committed' ? save(operation, { stage: 'payment-observed', transfer: { txHash: coords.reportedTxHash, blockNumber: coords.observation.observation.blockNumber } }, { event: 'protocol_native_transfer_observed' }) : operation;
        if (!usesNativePaymentEvidence(current)) return current;
        // Final delegated delivery with a retained answer needs nothing more
        // from the seller (its session key may be retired), but stays current
        // only on a fresh read. A legacy row asks the seller while its key exists.
        // With chain readback, a final row still missing a chain
        // pointer asks the seller (as a legacy row does) until it keeps them,
        // within its ask budget (chainPointerAskDue); otherwise it reads back
        // from its retained answer only.
        const final = deliveryIsFinal(current.state.protocol), kept = final ? retainedSellerAnswer(current, { derive: false }) : null;
        const pointerAsk = Boolean(kept && missingChainPointers(current).length && chainPointerAskDue(current.state.protocol, now()));
        return advanceNativeEvidence(current, coords, { retained: pointerAsk ? null : kept, ...(pointerAsk ? { pointerAsk } : {}) });
      }
      if (operation.status === 'agreement_pending' && ['agreement-signing', 'agreement-anchored'].includes(stage) && operation.state.protocol.signatures) return submitAgreement(operation);
      return operation;
    }
    return operation;
  }

  // The read-only proof that cancels a native payment: the source journal
  // retains no transaction from the payer at or after the handoff's payment
  // nonce and no unobserved one (a failed one is resolved). Every source
  // broadcast is retained before it is sent.
  const unissuedSince = (payer, expectedNonce) => async () => !(await sourceCapability.journal.entries()).some(([key, value]) =>
    key.startsWith('devnet/native-') && value?.signedTransaction?.content?.from === payer
    && value.stage !== 'failed'
    && (value.stage !== 'observed' || !(Number(value.signedTransaction.content.nonce) < expectedNonce)));

  return {
    available,
    actionsAdmitted: false,
    nativePaymentReadbackAvailable: Boolean(nativePayment),
    // Chain readback: the buyer's own chain reader, for the
    // operator's buyer driver; the operator-action hold, for its key sweep.
    ...(chainReadback ? { chainReadback } : {}),
    ...({ holdChainReadback }),
    readIssuedPayment:async(operation,hash)=>{
      if(!sourceCapability)return null;
      if(!buyerAccess)assertBuyerAccess(operation.terms.buyer.wallet,operation);
      return readIssuedWallet({sourceCapability,address:operation.terms.buyer.wallet,hash,nativeOnly:true});
    },
    // A refused buyer's reported pointer, observed without any journal write.
    observeReportedPayment:(hash)=>sourceCapability?observeTransferReadOnly({sourceCapability,hash}):null,
    readIssued:async(operation)=>{
      if(!sourceCapability)return null;
      if(!buyerAccess)assertBuyerAccess(operation.terms.buyer.wallet,operation);
      return readIssuedArtifacts({sourceCapability,writer:buyerClaim(operation),jobId:operation.terms.protocol.jobId,unknownOnly:operation.status!=='settled_verified'});
    },
    assertBuyerAccess,
    supportsMode,
    prepareTerms,
    assertSellerAdmission,
    identityRequest,
    planRequest,
    runningPlan,
    planRunning,
    planFlightsRunning,
    signRequest,
    submitAgreement: endIfStale(submitAgreement),
    recheckCommitment,
    // Whether the operator's source, in any process, has claimed a transfer
    // with this handoff's settlement terms (devnet-native-transport.mjs
    // nativeTransferClaimed), with no network read; null when it has not.
    nativePaymentClaimed: (operation, coords) => (usesNativeAgreementPayment(operation) && sourceCapability ? sourceCapability.nativeTransferClaimed(operation.terms.buyer.wallet, coords.payload) : null),
    // Whether the operator's source keeps a cancelled payment with this
    // payment's settlement terms (devnet-native-transport.mjs
    // nativeTransferCancelled), so it refuses the transfer at every gate: a
    // read of its journal, with no network read and no write; false with no
    // source.
    nativePaymentTermsCancelled: async (operation, payload) => (usesNativeAgreementPayment(operation) && sourceCapability ? sourceCapability.nativeTransferCancelled(operation.terms.buyer.wallet, payload) : false),
    // Whether the operator's source refuses this handoff's transfer for a
    // cancelled payment's terms, under the same workflow/lane locks as the
    // cancellations that write its records (devnet-native-transport.mjs
    // nativeTransferRefused): it keeps such a cancellation, or it refused this
    // exact transfer for one, which outlives that record. Either way this
    // handoff sent nothing through the source. With consumer, also what used
    // the handoff's nonce, as the source reads it back (nativeNonceConsumer),
    // if this purchase is bound to the source's chain. null when the source
    // does not refuse it, or with no source.
    nativePaymentRefused: (operation, coords, { consumer = false } = {}) => {
      if (!nativePayment || !sourceCapability || !usesNativeAgreementPayment(operation)) return null;
      const payer = operation.terms.buyer.wallet;
      return nativePayment.withWorkflow(operation, () => nativePayment.withPaymentLane(operation, async () => {
        const refused = await sourceCapability.nativeTransferRefused(payer, coords.payload);
        if (!refused || !consumer) return refused;
        const bound = sourceTerms(operation) && operation.terms.domain?.mode === 'public-chain-read' && operation.terms.domain.chainIdentity === sourceCapability.pins.chainIdentity && operation.terms.network === sourceCapability.pins.network;
        return { ...refused, consumer: bound ? await sourceCapability.nativeNonceConsumer(payer, coords.payload) : null };
      }));
    },
    // Cancelling a declined native payment: under the same workflow/lane
    // locks, and under the payer's source lane lock as well
    // (devnet-native-transport.mjs cancelNativeTransfer), so cancelling and
    // sending this handoff's transfer exclude each other: { cancelled, claimed }.
    // The source records the transfer's normalized settlement terms (payer
    // lane, nonce, payee, amount; the prepared payload's digest only as
    // evidence) and the purchase, and refuses any transfer that could settle
    // the cancelled purchase, however it was re-signed. Another purchase's
    // payment with the same terms (approved out of order) is such a transfer:
    // its handoff refuses it before signing (nativePaymentTermsCancelled), and
    // it recovers by being cancelled and prepared again, at a new nonce. The
    // proof is unissuedSince, above.
    cancelNativePayment: (operation, coords) => {
      if (!nativePayment || !sourceCapability || !usesNativeAgreementPayment(operation) || !Number.isSafeInteger(coords?.expectedNonce)) return { cancelled: false, claimed: null };
      const payer = operation.terms.buyer.wallet;
      return nativePayment.withWorkflow(operation, () => nativePayment.withPaymentLane(operation, () => sourceCapability.cancelNativeTransfer({ address: payer, operationId: operation.id, payload: coords.payload, unissued: unissuedSince(payer, coords.expectedNonce) })));
    },
    // Cancelling a native payment whose reported transfer failed: once the
    // source reads it back failed at the saved nonce fence (releasing its
    // lane), the source keeps this payment's settlement terms as cancelled, as
    // cancelNativePayment does, so it never confirms or sends a transfer with
    // them again, however it was re-signed. A source that has claimed such a
    // transfer meanwhile (a signature lease naming it, in any process) is not
    // cancelled.
    nativePaymentFailed: (operation, coords) => {
      if (!nativePayment || !usesNativeAgreementPayment(operation) || coords?.observation?.txStatus !== 'failed' || coords.observation.txHash !== coords.reportedTxHash) return false;
      return nativePayment.withWorkflow(operation, () => nativePayment.withPaymentLane(operation, async () => {
        if (!sourceCapability) return true; // The fixture has no issued source-transport lane.
        const payer = operation.terms.buyer.wallet;
        const result = await sourceCapability.binding({ phase: 'readback', address: payer, hash: coords.reportedTxHash, failedNonceFence: coords.nonceFence });
        if (result.disposition !== 'failed' || result.resolved !== true) return false;
        const held = await sourceCapability.cancelNativeTransfer({ address: payer, operationId: operation.id, payload: coords.payload, unissued: unissuedSince(payer, coords.expectedNonce) });
        return held.cancelled === true;
      }));
    },
    // Releases retained source intents at this purchase's nonce once a different
    // confirmed hash consumed it: another purchase's settlement (superseded) or
    // this purchase's own reported hash (settled or mismatched).
    nativePaymentSuperseded: (operation, coords) => {
      const consumed = coords?.observation?.supersededBy || (coords?.observation?.slotConsumed === true && coords.observation.txHash === coords.reportedTxHash);
      if (!nativePayment || !usesNativeAgreementPayment(operation) || !consumed || !Number.isSafeInteger(coords.expectedNonce)) return false;
      return nativePayment.withWorkflow(operation, () => nativePayment.withPaymentLane(operation, async () => {
        if (!sourceCapability) return true;
        if (!sourceTerms(operation) || operation.terms.domain?.mode !== 'public-chain-read' || operation.terms.domain.chainIdentity !== sourceCapability.pins.chainIdentity || operation.terms.network !== sourceCapability.pins.network) return false;
        if (!sourceCapability.isWalletIdle?.(operation.terms.buyer.wallet)) return false;
        const records = new Map(), lanes = new Map();
        for (const [key, r] of await sourceCapability.journal.entries()) {
          if (key.startsWith('devnet/native-') && r?.signedTransaction?.content?.type === 'native' && r.signedTransaction.content.from === operation.terms.buyer.wallet
            && r.networkBinding?.network === sourceCapability.pins.network && r.networkBinding.chainIdentity === sourceCapability.pins.chainIdentity
            && r.nonce === coords.expectedNonce && r.hash !== coords.observation.txHash) {
            if (key.startsWith('devnet/native-transfer/')) records.set(r.hash, r);
            else if (key.startsWith('devnet/native-wallet/')) lanes.set(r.hash, r);
          }
        }
        // The retained intent is authoritative if its lane write was interrupted.
        for (const [hash, r] of lanes) if (!records.has(hash)) records.set(hash, r);
        for (const [hash, r] of records) {
          const held = lanes.has(hash) && !['observed', 'failed'].includes(lanes.get(hash).stage);
          if (r.stage === 'observed') { if (held) return false; continue; }
          if (r.stage === 'failed') {
            if (!held) continue;
            // A retained nonce-fence failure also proves this hash can never be included.
            const fenced = r.failure?.supersededByHash === undefined && Number.isSafeInteger(r.failure?.nonceFence) && r.failure.nonceFence >= 0;
            if (r.failure?.supersededByHash !== coords.observation.txHash && !fenced) return false;
          }
          const result = await sourceCapability.binding({ phase: 'readback', address: operation.terms.buyer.wallet, hash, consumedByHash: coords.observation.txHash });
          if (result.disposition !== 'failed' || result.resolved !== true) return false;
        }
        return sourceCapability.isWalletIdle(operation.terms.buyer.wallet);
      }));
    },
    // Read-only, after nativePaymentSuperseded resolved this purchase's own
    // consumed nonce: the retained source intents at that nonce whose failure
    // proof is supersededByHash of this hash, the only proof that the wallet's
    // own nonce was used. A nonce-fence failure is resolved but proves nothing
    // about that nonce, so it is never listed. null when no source journal was
    // read (that proof is vacuous without a source capability) or when any
    // retained intent at the nonce has neither failure proof.
    nativeIntentsSupersededBy: (operation, coords) => {
      const consumed = coords?.observation?.slotConsumed === true && coords.observation.txHash === coords.reportedTxHash;
      if (!nativePayment || !sourceCapability || !sourceTerms(operation) || !usesNativeAgreementPayment(operation) || !consumed || !Number.isSafeInteger(coords.expectedNonce)) return null;
      return nativePayment.withWorkflow(operation, () => nativePayment.withPaymentLane(operation, async () => {
        const hashes = new Set();
        for (const [key, r] of await sourceCapability.journal.entries()) {
          if ((key.startsWith('devnet/native-transfer/') || key.startsWith('devnet/native-wallet/')) && r?.signedTransaction?.content?.type === 'native' && r.signedTransaction.content.from === operation.terms.buyer.wallet
            && r.networkBinding?.network === sourceCapability.pins.network && r.networkBinding.chainIdentity === sourceCapability.pins.chainIdentity
            && r.nonce === coords.expectedNonce && r.hash !== coords.observation.txHash) {
            const f = r.failure, fenced = f?.supersededByHash === undefined && Number.isSafeInteger(f?.nonceFence) && f.nonceFence >= 0;
            if (r.stage !== 'failed' || (f?.supersededByHash !== coords.observation.txHash && !fenced)) return null;
            if (!fenced) hashes.add(r.hash);
          }
        }
        return [...hashes];
      }));
    },
    withNativePaymentLane: (operation, work) => {
    assertPurchaseActionsAdmitted();
    assertBuyerAccess(operation.terms.buyer.wallet, operation);
      if (!nativePayment) throw unavailable();
      return nativePayment.withWorkflow(operation, () => nativePayment.withPaymentLane(operation, async () => { await nativePayment.assertReady(operation); return work(); }));
    },
    readNativePaymentLane: (operation, key) => {
    assertPurchaseActionsAdmitted();
    assertBuyerAccess(operation.terms.buyer.wallet, operation);
      if (!nativePayment || !usesNativeAgreementPayment(operation)) throw unavailable();
      return nativePayment.withWorkflow(operation, () => nativePayment.withPaymentLane(operation, async () => {
        const current = ops.get(operation.accountId, operation.id);
        if (current.state.protocol.nativePaymentLaneIssued) throw new OperationError('native_payment_already_issued', 'the wallet guard was delivered once; readback only, never resend');
        const record = await nativePayment.readLane(current, key);
        // Consume before releasing this read to the packaged wallet. A lost
        // response or rejected/unknown wallet result never grants another send.
        save(current, { nativePaymentLaneIssued: true }, { event: 'protocol_native_wallet_guard_issued', data: { createHash: record.hash, createNonce: record.nonce } });
        return record;
      }));
    },
    checkDelivery: endIfStale(checkDelivery),
    recheck: endIfStale(recheck),
    countersignRequest,
    countersign: endIfStale(countersign),
  };
}

export function holdCompletedBundle(protocol) {
  const later = protocol.deliveryDeadline?.laterDelivery;
  return later?.deliveredAtSource === 'chain-authenticated inclusion block timestamp'
    && later.deliveredAt > protocol.deliveryDeadline.overdue.deadline;
}
