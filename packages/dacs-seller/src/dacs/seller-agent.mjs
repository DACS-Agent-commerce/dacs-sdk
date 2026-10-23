import { operatorBuyerAccessConfig } from '../devnet-demo/buyer-access.mjs';
import { addressForClaim, isCanonicalEd25519Signature } from './demos-claims.mjs';
// Seller agent for one verified fixed-price DEM Listing, acting as phase
// orchestrator (seller-as-phase-orchestrator-v1). Transport-neutral: every
// method takes and returns plain JSON; seller-http.mjs is a narrow adapter.
//
// The seller identity is supplied by the operator as a signing callback over
// raw bytes (never the plugin buyer's key; the agent never sees a buyer key).
// Protocol steps use the pinned SDK seller surface:
//  - respondToFixedPriceAgreementProposalDurable re-derives the Agreement from
//    seller-local authenticated context before signing its contribution;
//  - commitFixedPriceAgreement signs and anchors the FinalityCommitmentRecord
//    after Agreement readback by default, or on exact signatures when enabled;
//  - verifySellerPaymentIntake verifies the pay-dem claim (payer, payee,
//    amount, inclusion after the finalized commitment, deadline, SB-1 identity,
//    SB-2 one-transaction-one-session receipt store) and derives the exact
//    unsigned payment SettlementEvidence.
// The explicit DEM delivery profile additionally consumes that same permit in
// runDurableFulfilmentToDeliveryReady using a seller-retained V2 SessionRecord,
// genuine partyVetCore provenance and independent delivery receipt readback.
// Evidence publication/final bundle closure stay behind an explicit later SDK
// finaliser call. Not deployed anywhere; tests run it on owned loopback only.
import { commitOnSignatureConfig, verifySignatureAgreement, verifyAgreementCreateAuthorization } from './commit-on-signature.mjs';
import {
  canonicalize,
  commitFixedPriceAgreement,
  contentHash,
  createFsFencedSessionStore,
  createInMemoryFencedSessionStore,
  createInMemorySellerReceiptStore,
  fixedPriceAgreementLogicalAddress,
  finalizeFixedPriceAgreementContributions,
  finalityCommitmentAddress,
  identityBundleHash,
  isCanonicalJobId,
  isIdentityBundle,
  paymentEvidenceAddress,
  respondToFixedPriceAgreementProposalDurable,
  runDurableFulfilmentToDeliveryReady,
  sellerFulfilmentVetRequirementsViolation,
  sha256Hex,
  signComponentArtifact,
  verifySellerPaymentIntake,
  verifySettlementEvidence,
  ARTIFACT_SEPARATORS,
} from '@kynesyslabs/dacs';
import { isNativeDeliveryEvidence } from './delivery-evidence.mjs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { verifyComponent, DEM_RAIL } from './listing.mjs';
import { railAuthorityConfig, intakeRailDefinition, validateSellerListing } from './rail-authority.mjs';
import { listingRevocationProblem, sessionAdmissionConfig, sessionAdmissionProblem, vetAnchorReceiptProblem, vetRecordProblem, SELLER_PROFILE, SESSION_CHALLENGE_LIFETIME_MS } from './session-admission.mjs';
import { fixtureRef, signAnchorWrite, verifyFixtureRecord, verifyFixtureReceipt, fixtureTxRef, canonicalSignature } from './fixture-anchors.mjs';
import { createSellerDurableState, DEFAULT_SELLER_MAX_JOBS } from './seller-durable-state.mjs';
import { NATIVE_PAYMENT_EVIDENCE, nativePaymentEvidenceConfig, checkNativePaymentEvidence } from './native-payment-evidence-consumer.mjs';
import { isPaymentEvidenceWalletJournalPair, paymentEvidenceWalletJournalOf } from './payment-evidence-wallet-journal.mjs';
import { sellerSessionPresentationProblem } from './session-admission.mjs';
import { demDeliveryContextConfig, resolveDemDeliverySellerContext } from './dem-delivery-context-consumer.mjs';
import { nativeDemDeliveryConfig, submitNativeDemDelivery, reconcileNativeDemDelivery, readNativeDemDelivery, verifyNativeDemDeliveryReceipt, isProvenUnsignedAbsence } from './native-dem-delivery-consumer.mjs';
import {
  agreementInput,
  agreementTerms,
  assembleBundleCopies,
  bundleAddress,
  bundleSession,
  bundleSigningPlan,
  commitmentReader,
  commitmentSession,
  commitmentVerifier,
  contributionVerifier,
  deliverableAddress,
  deliveryEvidenceAddress,
  DEM_RAIL_DEFINITION,
  ed25519Deps,
  listingPin,
  protocolSupport,
  RAIL_REGISTRY_VERSION,
  verifyAnchoredCopy,
  verifyDelivery,
  verifyPaymentEvidence,
} from './purchase-protocol.mjs';

export class SellerAgentError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// What the native profile reads and writes instead of a fixture substrate.
const fixtureDisabled = async () => { throw new SellerAgentError('fixture_substrate_disabled', 'the native seller profile has no fixture substrate', 503); };
const NATIVE_PROFILE_FIXTURE = Object.freeze({ read: fixtureDisabled, write: fixtureDisabled });

import { proposalTimeProblem } from './seller-proposal-time.mjs';
export { proposalTimeProblem } from './seller-proposal-time.mjs';
const FINALISED_SKEW_MS = 5 * 60 * 1000;
// Payment-evidence anchor outcomes after which no attempt can land: it never
// reached the wallet (the agent's own record), or the wallet's journal
// answered that nothing it signed for the address can be included. No wallet
// answer to the anchor itself is one: any answer is 'sent'.
const UNSENT_ANCHOR_OUTCOMES = Object.freeze(['not-sent', 'unsigned']);
// Readback failures of retained native evidence work (the commitment and
// Agreement readback): a retry answers them as held, with the cause.
const RETAINED_READBACK_FAILURES = new Set(['commitment_failed', 'commitment_readback_required', 'substrate_unavailable', 'agreement_not_anchored', 'agreement_anchor_invalid', 'agreement_substituted', 'seller_agreement_readback_required']);
// A claimed pay-dem transaction hash as core payment intake reads it
// (lower case, without `0x`): the transport admits either form.
const paymentTxHash = (txHash) => String(txHash).toLowerCase().replace(/^0x/, '');
// What is kept of a wallet answer: its status, transaction hash and reason, bounded.
const walletAnswer = (answer) => ({ status: typeof answer?.status === 'string' ? answer.status.slice(0, 32) : 'missing',
  ...(typeof answer?.txHash === 'string' ? { txHash: answer.txHash.slice(0, 128) } : {}), ...(typeof answer?.reason === 'string' ? { reason: answer.reason.slice(0, 240) } : {}) });

// The deterministic test report this agent delivers: derived only from the
// Agreement and the verified payment, so every replay is byte-identical.
export function buildReport({ agreement, listing, settlementId }) {
  if (!isCanonicalJobId(agreement?.jobId)) throw new SellerAgentError('job_invalid', 'jobId is not canonical');
  const terms = agreementTerms(agreement);
  return {
    reportVersion: '1',
    kind: 'dacs-chatgpt-plugin/fixture-test-report',
    jobId: agreement.jobId,
    agreementHash: contentHash(agreement),
    listing: { ...agreement.listingRef },
    title: listing.offering.title,
    settlementId,
    body: [
      `Deterministic fixture report for job ${agreement.jobId}.`,
      `Listing ${terms.listing.listingId}@v${terms.listing.version}, price ${terms.price.amount} DEM.`,
      'SIMULATED offline fixture content; not a real market report.',
    ],
  };
}

// The substrate is chosen once, never by fallback. `agreementAnchor` and
// `nativeArtifactAnchor` (programmatic operator capabilities) together select
// the native profile: commit reads the buyer's Agreement as its native Demos
// SR-2 storage CREATE and publishes the FinalityCommitmentRecord natively. Any
// other native capability needs both, and that profile takes no `anchors`: a
// remaining fixture read or write refuses (fixture_substrate_disabled). The
// simulated fixture substrate is used only when it is passed as `anchors` with
// no native capability and `simulatedFixture: true`: that profile signs over
// the not-performed Vet references and the unsigned in-code rail, so it is
// never chosen by default.
// The native profile signs an Agreement only with the operator's authenticated
// Vet context (`demDeliveryContext`), never the synthetic not-performed Vet
// references, and only over a rail its steward-signed `railAuthority` makes
// selectable, pinned into the session first (rail-authority.mjs). It commits
// or takes payment only with the whole chain to delivery
// (`nativePaymentEvidence`, `demDeliveryContext`, `nativeDemDelivery`) and the
// pinned rail: a commitment it could not settle would make the buyer pay for
// nothing. No profile signs a completed DACS-5 bundle (the ST-11 finalizer is
// not wired; bundle_finalization_unavailable).
// The native profile opens a new session only for a presentation of a
// challenge this seller issued for its job and buyer (issueSessionChallenge;
// the first attempt consumes it, durably), on a Listing its own revocation
// check (core checkListingRevocation over the operator's readings) finds not
// revoked, and under the operator's `sessionAdmission` (session-admission.mjs):
// the exact profile of both parties and the Vet records the references name,
// checked strictly against the requirement invocations the delivery runner
// checks, for a retained context too.
// `contextRequest({jobId, buyerBundle, generatedAt})` (seller context route,
// seller-context-route.mjs createSellerContextRecords exactRequest) is true only
// when the seller durably admitted exactly that context request for the job.

export { canonicalSignature };
