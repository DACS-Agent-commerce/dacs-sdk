import { admitSessionChallenge } from './session-challenge-limits.mjs';
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
// The delivery SettlementEvidence is published only when the operator enables
// deliveryEvidenceEnabled (finishDeliveryEvidence); otherwise its publication,
// and the final bundle closure, stay behind an explicit later SDK finaliser
// call. Not deployed anywhere; tests run it on owned loopback only.
import { commitOnSignatureConfig, verifySignatureAgreement, verifyAgreementCreateAuthorization } from './commit-on-signature.mjs';
import { canonicalize, commitFixedPriceAgreement, contentHash, isListing, createFsFencedSessionStore, createInMemoryFencedSessionStore, createInMemorySellerReceiptStore, fixedPriceAgreementLogicalAddress, finalizeFixedPriceAgreementContributions, finalityCommitmentAddress, identityBundleHash, isCanonicalJobId, isVerifiedListingAdmission, sameCanonicalClaimIdentity, canonicalDemosAgentPublicKey, isIdentityBundle, paymentEvidenceAddress, respondToFixedPriceAgreementProposalDurable, runDurableFulfilmentToDeliveryReady, sellerFulfilmentVetRequirementsViolation, sha256Hex, signComponentArtifact, verifySellerPaymentIntake, verifySettlementEvidence, ARTIFACT_SEPARATORS } from '@kynesyslabs/dacs';
import { isNativeDeliveryEvidence } from './delivery-evidence.mjs';
import { randomBytes } from 'node:crypto';
import { MAX_STORAGE_ARTIFACT_BYTES } from './wallet-transactions.mjs';
import { join } from 'node:path';
import { verifyComponent, DEM_RAIL } from './listing.mjs';
import { railAuthorityConfig, intakeRailDefinition, validateSellerListing } from './rail-authority.mjs';
import { hasPresenceOnlyClaim, listingRevocationProblem, readRegistryPin, sessionAdmissionConfig, sessionAdmissionProblem, readAdmissionCapability, vetAnchorReceiptProblem, vetRecordProblem, SELLER_PROFILE, SESSION_CHALLENGE_LIFETIME_MS } from './session-admission.mjs';
import { fixtureRef, signAnchorWrite, verifyFixtureRecord, verifyFixtureReceipt, fixtureTxRef, canonicalSignature } from './fixture-anchors.mjs';
import { createSellerDurableState, DEFAULT_SELLER_MAX_JOBS } from './seller-durable-state.mjs';
import { NATIVE_PAYMENT_EVIDENCE, nativePaymentEvidenceConfig, checkNativePaymentEvidence } from './native-payment-evidence-consumer.mjs';
import { isPaymentEvidenceWalletJournalPair, paymentEvidenceWalletJournalOf } from './payment-evidence-wallet-journal.mjs';
import { sellerSessionPresentationProblem } from './session-admission.mjs';
import { demDeliveryContextConfig, resolveDemDeliverySellerContext } from './dem-delivery-context-consumer.mjs';
import { nativeDemDeliveryConfig, submitNativeDemDelivery, reconcileNativeDemDelivery, readNativeDemDelivery, verifyNativeDemDeliveryReceipt, isProvenUnsignedAbsence } from './native-dem-delivery-consumer.mjs';
import { deliverableJournalFor } from './deliverable-wallet-journal.mjs';
import { agreementInput, agreementTerms, bundleAddress, commitmentReader, commitmentSession, commitmentVerifier, contributionVerifier, deliverableAddress, deliveryEvidenceAddress, DEM_RAIL_DEFINITION, ed25519Deps, listingPin, protocolSupport, RAIL_REGISTRY_VERSION, verifyAnchoredCopy, verifyDelivery, verifyPaymentEvidence } from './purchase-protocol.mjs';

/** A seller refusal with its stable code and HTTP status (422 by default). */
export class SellerAgentError extends Error {
  constructor(code, message, status = 422, options = {}) {
    super(message,options);
    this.code = code;
    this.status = status;
  }
}

// What the native profile reads and writes instead of a fixture substrate.
const fixtureDisabled = async () => { throw new SellerAgentError('fixture_substrate_disabled', 'the native seller profile has no fixture substrate', 503); };
const NATIVE_PROFILE_FIXTURE = Object.freeze({ read: fixtureDisabled, write: fixtureDisabled });
// The seller agent's profile gates, each thrown only before any read, write,
// signature or send of its operation. They are definite refusals that keep no
// effect in the journal, so a request refused while the operator's
// configuration was incomplete runs once it is complete. A new gate goes here.
export const SELLER_PRE_EFFECT_REFUSALS = Object.freeze(['vet_context_required', 'session_admission_required', 'settlement_profile_unavailable', 'rail_unavailable', 'native_evidence_required', 'bundle_finalization_unavailable']);
// These seller-agent errors occur before an external effect. Any other error
// may follow an effect and stays uncertain; in particular, commitment_failed
// is deliberately absent: a write may have happened. A session the seller's
// admission did not admit (or could not answer for) kept nothing either.
// A payment claim other than the one whose work the agent retains
// (seller_native_evidence_conflict) is refused before anything of it runs.
export const SELLER_NO_EFFECT_ERRORS = new Set(['peer_job_capacity', 'session_not_admitted', 'session_admission_unavailable', 'buyer_access_closed', 'signature_commitment_disabled', 'signature_buyer_not_admitted', 'signature_connection_unavailable', 'seller_signature_buyer_unresolved', 'unknown_job', 'not_agreed', 'agreement_not_anchored', 'agreement_anchor_invalid', 'agreement_substituted', 'not_committed', 'payment_already_recorded', 'buyer_bundle_invalid', 'buyer_bundle_unauthenticated', 'self_dealing', 'job_invalid', 'buyer_mismatch', 'job_taken', 'not_delivered', 'no_bundle_request', 'bundle_invalid', 'no_seller_copy', 'seller_native_evidence_conflict', ...SELLER_PRE_EFFECT_REFUSALS]);

import { proposalTimeProblem } from './seller-proposal-time.mjs';
// Payment-evidence anchor outcomes after which no attempt can land: it never
// reached the wallet (the agent's own record), or the wallet's journal
// answered that nothing it signed for the address can be included. No wallet
// answer to the anchor itself is one: any answer is 'sent'.
const UNSENT_ANCHOR_OUTCOMES = Object.freeze(['not-sent', 'unsigned']);
// What the SR-2 adapter reports for an address it finds nothing at (a name-index
// or native-address miss). It proves no absence (CORE §5.1); it is a complete miss.
const NATIVE_READ_MISSES = Object.freeze(['name-index-miss', 'native-address-miss']);
// Readback failures of retained native evidence work (the commitment and
// Agreement readback): a retry answers them as held, with the cause.
const RETAINED_READBACK_FAILURES = new Set(['commitment_failed', 'commitment_readback_required', 'substrate_unavailable', 'agreement_not_anchored', 'agreement_anchor_invalid', 'agreement_substituted', 'seller_agreement_readback_required']);
// A claimed pay-dem transaction hash as core payment intake reads it
// (lower case, without `0x`): the transport admits either form.
const paymentTxHash = (txHash) => String(txHash).toLowerCase().replace(/^0x/, '');
// What is kept of a wallet answer: its status, transaction hash and reason, bounded.
const walletAnswer = (answer) => ({ status: typeof answer?.status === 'string' ? answer.status.slice(0, 32) : 'missing',
  ...(typeof answer?.txHash === 'string' ? { txHash: answer.txHash.slice(0, 128) } : {}), ...(typeof answer?.reason === 'string' ? { reason: answer.reason.slice(0, 240) } : {}) });

/** Build a deterministic report from the Agreement, its exact Listing and settlement ID.
 * Throws SellerAgentError for a malformed job or mismatched Listing. */
export function buildReport({ agreement, listing, settlementId }) {
  if (!isCanonicalJobId(agreement?.jobId)) throw new SellerAgentError('job_invalid', 'jobId is not canonical');
  if (!isListing(listing) || contentHash(listing) !== agreement.listingRef?.contentHash) {
    throw new SellerAgentError('listing_invalid', 'Listing does not match the Agreement');
  }
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
const MAX_CHALLENGES_PER_JOB=16;
export async function createSellerAgent({ signer, listing, anchors, observeDemosTransfer, now = () => Date.now(), receiptStore: suppliedReceiptStore, durableDirectory, agreementAnchor = null, nativePaymentEvidence = null, demDeliveryContext = null, nativeDemDelivery = null, nativeArtifactAnchor = null, deliverableProducer = null, deliverySchemaVerifier = null, maxJobs = DEFAULT_SELLER_MAX_JOBS, deliveryEvidenceEnabled = false, buyerAccess = null, readIssued = null, commitOnSignature = false, signatureBuyer = null, signatureCommitmentReady = null, contextRequest = null, railAuthority = null, sessionAdmission = null, reconcilePaymentEvidence = null, reconcileDeliverableCreate = null, simulatedFixture = false }) {
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1) throw new TypeError('maxJobs must be a positive safe integer');
  commitOnSignature = commitOnSignatureConfig(commitOnSignature);
  if (typeof simulatedFixture !== 'boolean') throw new TypeError('simulatedFixture must be true or false');
  if (signatureBuyer !== null && !/^did:demos:agent:[0-9a-f]{64}$/.test(signatureBuyer)) throw new TypeError('signatureBuyer must be an admitted buyer claim or null');
  if (signatureCommitmentReady !== null && typeof signatureCommitmentReady !== 'function') throw new TypeError('signatureCommitmentReady must be a function or null');
  if (commitOnSignature && !durableDirectory) throw new TypeError('commitment on signature requires durable seller state');
  if (!signer?.claim || typeof signer.sign !== 'function') throw new Error('a seller signer (claim + sign) is required');
  if (agreementAnchor !== null && (typeof agreementAnchor?.readAgreement !== 'function' || typeof agreementAnchor.source !== 'string')) throw new Error('agreementAnchor must expose source and readAgreement');
  if (!sameCanonicalClaimIdentity(listing?.seller?.identity?.presentedBy,signer.claim)) throw new Error('the seller signer does not control this Listing');
  if ((listing?.offering?.deliverable?.accessModel ?? 'public') !== 'public') throw new Error('unsupported Listing: seller delivery requires public access');
  // DACS-4 §9.6.1: larger payloads require an extended pointer. This
  // profile prepares inline storage only, so refuse before any Agreement.
  if (listing?.offering?.deliverable?.expectedSizeBytes > 128 * 1024) throw new Error('unsupported Listing: inline storage delivery supports at most 131072 bytes; larger payloads require an extended pointer');
  if (contextRequest !== null && typeof contextRequest !== 'function') throw new Error('contextRequest must be a function');
  const admittedContextRequest = (input) => { try { return contextRequest?.(input) === true; } catch { return false; } };
  const support = protocolSupport(listing);
  if (!support.supported) throw new Error(`unsupported Listing: ${support.reasons.join('; ')}`);
  const access=operatorBuyerAccessConfig(buyerAccess);
  const assertBuyer=(buyer,jobId,{proposal=false}={})=>{
    if(!access){
      if(nativeArtifactAnchor?.source==='dacs-devnet-demo-native-artifacts/v1')throw new SellerAgentError('buyer_access_closed','operator buyerAccess capability is missing',409);
      return;
    }
    try{if(proposal)access.assertWallet(addressForClaim(buyer));else access.assertSellerWallet(addressForClaim(buyer),jobId);}
    catch(error){if(error.code==='buyer_access_closed')throw new SellerAgentError(error.code,error.message,409);throw error;}
  };
  // Recovery uses the same job-scoped paid-order authority as ordinary work.
  // Only unpaid outsiders fall back to inspecting issued unknown writes.
  const buyerAccessClosed=(session,jobId)=>{
    try{assertBuyer(session.buyerBundle.presentedBy,jobId);return false;}
    catch(error){if(error.code==='buyer_access_closed')return true;throw error;}
  };
  const claim = signer.claim;
  const nativeEvidence = nativePaymentEvidenceConfig(nativePaymentEvidence);
  const deliveryContext = demDeliveryContextConfig(demDeliveryContext);
  const nativeDelivery = nativeDemDeliveryConfig(nativeDemDelivery);
  if ((nativeArtifactAnchor === null) !== (deliverableProducer === null)) throw new TypeError('native demo artifacts and the genuine deliverable producer must be configured together');
  if (nativeArtifactAnchor && (nativeArtifactAnchor.writer !== signer.claim || typeof nativeArtifactAnchor.publish !== 'function' || typeof nativeArtifactAnchor.readRetained !== 'function' || typeof nativeArtifactAnchor.verifyReceipt !== 'function' || typeof deliverableProducer !== 'function')) throw new TypeError('native demo artifact capability is incomplete or belongs to another seller');
  if (nativeEvidence && (!durableDirectory || !agreementAnchor || typeof nativeEvidence.anchorEvidence !== 'function')) throw new TypeError('native evidence requires durable seller state, native Agreement readback and an explicit seller wallet anchor capability');
  if (reconcilePaymentEvidence !== null && (typeof reconcilePaymentEvidence !== 'function' || !nativeEvidence)) throw new TypeError('reconcilePaymentEvidence must be the seller wallet\'s journal question for the native evidence anchor, or null');
  if (deliveryContext && (!nativeEvidence || !durableDirectory)) throw new TypeError('DEM delivery context requires the durable native evidence profile');
  if (nativeDelivery && !deliveryContext) throw new TypeError('native DEM delivery requires the authenticated DEM delivery context');
  // CORE §5.1: the question that lets a plain absence of a submitted
  // Deliverable send its kept CREATE again (and answers `unsigned` for a new
  // signature) comes only from the createDeliverableWalletJournal whose submit
  // is the capability's, so that every signed Deliverable CREATE is kept.
  const deliverableJournal = deliverableJournalFor(nativeDelivery, reconcileDeliverableCreate);
  if(typeof deliveryEvidenceEnabled!=='boolean'||(deliveryEvidenceEnabled&&(!nativeArtifactAnchor||!nativeDelivery)))throw new TypeError('delivery evidence publication requires the explicit native demo delivery profile');
  const nativeProfile = agreementAnchor !== null || nativeArtifactAnchor !== null || nativeEvidence !== null || deliveryContext !== null || nativeDelivery !== null;
  if (nativeProfile && (agreementAnchor === null || nativeArtifactAnchor === null)) throw new TypeError('the native seller profile needs both agreementAnchor and nativeArtifactAnchor; it never falls back to the fixture substrate');
  if (nativeProfile && anchors != null) throw new TypeError('the native seller profile takes no fixture substrate (anchors)');
  if (!nativeProfile && (typeof anchors?.read !== 'function' || typeof anchors.write !== 'function')) throw new TypeError('a seller agent needs agreementAnchor and nativeArtifactAnchor, or an explicit fixture substrate (anchors)');
  if (nativeProfile && simulatedFixture) throw new TypeError('the native seller profile is not the simulated fixture profile');
  if (!nativeProfile && !simulatedFixture) throw new TypeError('the fixture substrate (anchors) is the simulated fixture profile: it signs over not-performed Vet references and an unsigned rail, and needs simulatedFixture: true');
  // This native profile has no extended-pointer publisher. A signed exact
  // size is its pre-payment capacity bound, including for default Listings.
  // General DACS Listings may omit it; this inline-only profile cannot.
  const inlineSize = listing?.offering?.deliverable?.expectedSizeBytes;
  const minimumReportSize = Buffer.byteLength(canonicalize({ jobId: '0'.repeat(26), agreementHash: '0'.repeat(64), settlementId: `demos:${'0'.repeat(64)}` }));
  // An extra JSON member costs at least five bytes (,"":0); the four
  // lengths immediately above the binding-only object cannot be produced.
  const inlineSizeProblem = nativeProfile && (!Number.isSafeInteger(inlineSize) || inlineSize < minimumReportSize || inlineSize > MAX_STORAGE_ARTIFACT_BYTES ||
    (inlineSize > minimumReportSize && inlineSize < minimumReportSize + 5))
    ? `unsupported Listing: inline storage delivery requires expectedSizeBytes equal to ${minimumReportSize} or between ${minimumReportSize + 5} and ${MAX_STORAGE_ARTIFACT_BYTES}` : null;
  const rail = railAuthorityConfig(railAuthority);
  if (rail && !nativeProfile) throw new TypeError('the simulated fixture profile takes no railAuthority; it uses only the simulated fixture rail');
  if (nativeProfile && !rail) throw new TypeError(`the native seller profile needs railAuthority: it selects ${DEM_RAIL.railId} only from its steward-signed definition`);
  const admission = sessionAdmissionConfig(sessionAdmission);
  if (admission && !nativeProfile) throw new TypeError('the simulated fixture profile takes no sessionAdmission');
  if (nativeProfile) anchors = NATIVE_PROFILE_FIXTURE;
  const settlementChain = nativeEvidence !== null && deliveryContext !== null && nativeDelivery !== null;
  // DACS-4 PC-7(b) catch-up: a profile that takes payment needs the wallet's
  // journal question, so an anchor whose outcome is unknown (a throw, a crash
  // during the wallet call, a dropped submission) always has a way to land;
  // without it a paid order would be held for good. Its answer ('unsigned') is
  // the only one that lets the agent sign the same evidence again, so the
  // anchor and the question come from one createPaymentEvidenceWalletJournal,
  // which keeps every signed CREATE and reads its fate from the chain: any
  // other pair, a wrapper or two journals included, is refused, for an agent
  // composed directly as for the host.
  if (settlementChain && reconcilePaymentEvidence === null) throw new TypeError('the native settlement profile needs reconcilePaymentEvidence, the seller wallet\'s journal question for the evidence anchor (createPaymentEvidenceWalletJournal)');
  if (settlementChain && !isPaymentEvidenceWalletJournalPair(nativeEvidence.anchorEvidence, reconcilePaymentEvidence)) {
    throw new TypeError('the native settlement profile takes the payment-evidence anchor and reconcilePaymentEvidence only from one createPaymentEvidenceWalletJournal: nativePaymentEvidence must anchor with its anchorEvidence');
  }
  // That journal also keeps the exact signed CREATE, whose public projection
  // the evidence readback needs (the name index alone cannot authenticate
  // it): the agent reads it from the journal, read only, so a consumer
  // composed without a reader of its own still reads its evidence back.
  const walletJournal = settlementChain ? paymentEvidenceWalletJournalOf(nativeEvidence.anchorEvidence) : null;
  // Checked before any session, signature, read or write. These profile gates
  // (and native_evidence_required, bundle_finalization_unavailable) are
  // seller-http.mjs SELLER_PRE_EFFECT_REFUSALS: definite no-effect refusals.
  const assertVetContext = () => {
    if (nativeProfile && !deliveryContext) throw new SellerAgentError('vet_context_required', 'the native seller profile signs an Agreement only with the authenticated Vet context (demDeliveryContext)', 503);
  };
  const assertSessionAdmission = () => {
    if (nativeProfile && !admission) throw new SellerAgentError('session_admission_required', 'the native seller profile opens a session only under the seller\'s session admission (profile, challenge, revocation and Vet records)', 503);
  };
  const assertSettlementChain = () => {
    if (nativeProfile && !settlementChain) throw new SellerAgentError('settlement_profile_unavailable', 'the native seller profile commits and takes payment only with native payment evidence, the DEM delivery context and native DEM delivery', 503);
  };
  // RAV-R1..R3, R5 against the session's own pin (a new session's pin before it
  // is retained). Fixture sessions carry none and use the simulated rail.
  const assertRailPin = (railPin, sessionState) => {
    if (!nativeProfile) return;
    const verdict = rail.evaluate(railPin, sessionState);
    if (verdict.decision !== 'pass') throw new SellerAgentError('rail_unavailable', `the ${sessionState === 'new' ? 'selected' : 'pinned'} ${DEM_RAIL.railId} rail is not usable: ${verdict.decision} (${verdict.reason})`, 503);
  };
  const schemaUrl = listing.offering.deliverable.schemaUrl;
  const verifySchema = deliverySchemaVerifier?.verify?.bind(deliverySchemaVerifier);
  if (nativeProfile && schemaUrl !== undefined &&
      (deliverySchemaVerifier?.schemaUrl !== schemaUrl || typeof verifySchema !== 'function')) {
    throw new TypeError('unsupported delivery schema: supply deliverySchemaVerifier { schemaUrl, verify } for the Listing before accepting agreements');
  }
  const pin = listingPin(listing);
  if (durableDirectory && suppliedReceiptStore) throw new Error('durable seller recovery owns the pinned filesystem receipt store');
  const durable = durableDirectory ? await createSellerDurableState({ dir: durableDirectory, signer, listingPin: pin, maxJobs }) : null;
  let closed=false;
  const requireOpen=()=>{if(closed)throw new SellerAgentError('seller_closed','the seller agent is closed',503);};
  try {
  const assertNativePaymentHandler=()=>{if(typeof submitNativePaymentEvidence!=='function')throw new SellerAgentError('settlement_profile_unavailable','native payment handling is not assembled',503);};

  const sign = (bytes) => new Uint8Array(durable ? durable.signOnce(`signature:${sha256Hex(bytes)}`, Buffer.from(bytes)) : signer.sign(Buffer.from(bytes)));
  const rawReceiptStore = durable?.receiptStore ?? suppliedReceiptStore ?? createInMemorySellerReceiptStore();
  const retainedAdmission = durable?.context();
  if(retainedAdmission&&!isVerifiedListingAdmission(listing,retainedAdmission.validation))throw new Error('retained Listing admission differs from the current signed Listing');
  // Historical admission captured once, atomically with the Listing bytes it
  // validated; payment intake replays exactly this result (never live state).
  // It checks the Listing's own bytes, signature and rail only: the catalog row
  // below is this seller's own, not a revocation reading. Whether the Listing
  // is revoked is checked for each new session (listingRevocationProblem).
  const admittedAt = retainedAdmission?.admittedAt ?? now();
  const validation = retainedAdmission?.validation ?? await validateSellerListing(listing, {
    now: () => admittedAt,
    revocationSurfaces: [{ kind: 'catalog', status: 'active', readStatus: 'ok', catalogObservedAt: admittedAt }],
    readMarker: async () => null,
    railAuthority: rail,
    simulatedFixture,
  });
  if (validation.disposition !== 'verified') throw new Error(`own Listing does not verify: ${validation.reason}`);
  durable?.retainContext({ admittedAt, validation });
  const sellerBundle = listing.seller.identity;
  const store = durable?.fencedStore ?? createInMemoryFencedSessionStore();
  const fulfilmentStore = deliveryContext ? await createFsFencedSessionStore({ dir: join(durableDirectory, 'sdk-fulfilment') }) : null;
  const sessions = new Map(); // jobId -> session
  // CORE SN-1..SN-4: the challenges this seller issued, by nonce, each bound to
  // one job and buyer (kept with the durable seller state, else in memory).
  const memoryChallenges = new Map();
  const challenges = durable ? durable : {
    issueChallenge: (nonce, value, limits) => {
      admitSessionChallenge(memoryChallenges,value,limits,id=>memoryChallenges.delete(id));
      if (memoryChallenges.has(nonce)) throw new SellerAgentError('seller_challenge_taken', 'this nonce was issued before', 409);
      memoryChallenges.set(nonce, { kind: 'session-challenge', ...structuredClone(value), attempt: null });
    },
    attemptChallenge: (nonce, attempt) => {
      const prior = memoryChallenges.get(nonce);
      if (!prior) return null;
      const before = structuredClone(prior);
      if (prior.attempt === null) prior.attempt = structuredClone(attempt);
      return before;
    },
    admitChallenge: (nonce, presentationHash, accepted) => { const prior = memoryChallenges.get(nonce); if (prior?.attempt?.presentationHash === presentationHash) prior.attempt={...prior.attempt,admitted:true,...accepted===undefined?{}:{accepted:structuredClone(accepted)}}; },
    retireChallenge:(nonce,hash)=>{const row=memoryChallenges.get(nonce);if(row?.attempt?.presentationHash!==hash||row.attempt.admitted!==true)throw new SellerAgentError('seller_state_corrupt','challenge retirement differs',503);row.attempt.retired=true;},
  };
  const signatures = new Map(); // planHash -> seller signature
  const contributions = new Map(); // proposalHash -> contribution
  const settlementJobs = new Map(); // canonical settlement id -> all admissible claims
  const bindSettlement = (id, jobId, candidate = null) => {
    const claims = settlementJobs.get(id) ?? new Map();
    claims.set(jobId, candidate); settlementJobs.set(id, claims);
    const local = claims.size === 1;
    const retained = durable ? durable.bindSettlement(id, jobId, candidate) : true;
    return local && retained;
  };
  const hasSettlementCredit = (id, jobId) => (!settlementJobs.has(id) || (settlementJobs.get(id).size === 1 && settlementJobs.get(id).has(jobId))) && (!durable || durable.settlementJob(id) === jobId);
  const assertSettlementCredit = (jobId) => {
    // A read snapshot can predate intake, and another holder can discover a
    // collision. Neither an absent cached payment nor a cached success grants
    // credit: check all known identities against the durable binding (SB-2).
    const ids = new Set();
    for (const session of [durable?.loadSession(jobId), sessions.get(jobId)]) {
      for (const id of [session?.payment?.settlementId, session?.paymentWork?.intake?.settlementId, session?.nativeEvidenceWork?.intake?.settlementId]) {
        if (id) ids.add(id);
      }
    }
    for (const id of ids) if (!hasSettlementCredit(id, jobId)) throw new SellerAgentError('settlement_collision', 'competing admissible settlement claims require binding authority', 503);
  };
  // The SDK calls claim only after authenticating the complete payment tuple.
  // Keep that tuple before the primitive's provisional election, including a loser.
  const receiptStore = {
    claim: async candidate => { bindSettlement(candidate.settlementId, candidate.jobId, structuredClone(candidate)); return rawReceiptStore.claim(candidate); },
    consumePermit: async (id,handoff) => {
      const permit=await rawReceiptStore.inspectPermit(id);
      if(permit.claim && !hasSettlementCredit(permit.claim.settlementId,permit.claim.jobId))return {status:'invalid'};
      return rawReceiptStore.consumePermit(id,handoff);
    },
    inspectPermit: (...args) => rawReceiptStore.inspectPermit(...args),
  };
  const sessionView = (session) => {
    if(!session)return null;
    const copy=structuredClone(session);
    try { assertSettlementCredit(session.jobId); }
    catch(error) { if(error.code!=='settlement_collision')throw error;copy.settlementCredit='indeterminate';copy.stage='settlement-indeterminate'; }
    return copy;
  };
  // The Deliverable is the exact canonical report the seller submitted: once
  // it is retained (session.deliverySentReport, kept before the CREATE is
  // asked) every readback and verification uses those bytes, never what the
  // producer answers now.
  const deliveryReport=(session,settlementId)=>{
    if(session.deliverySentReport?.settlementId===settlementId)return JSON.parse(session.deliverySentReport.canonical);
    const report=deliverableProducer ? deliverableProducer({agreement:structuredClone(session.agreement),listing:structuredClone(listing),settlementId}) : buildReport({agreement:session.agreement,listing,settlementId});
    if (report && typeof report.then === 'function') {
      Promise.resolve(report).catch(() => {});
      throw new SellerAgentError('deliverable_producer_async', 'deliverableProducer must synchronously return deterministic JSON for this Agreement and settlement', 503);
    }
    if(report?.jobId!==session.jobId || report.agreementHash!==contentHash(session.agreement) || report.settlementId!==settlementId) throw new SellerAgentError('deliverable_producer_invalid','the application deliverable is not bound to this Agreement and settlement',503);
    return report;
  };
  const nativeDeliverySubstrate=nativeArtifactAnchor
    ? 'source-native-one-node-delivery; signed native Listing/Vet/commitment and genuine producer'
    : 'source-native-one-node-delivery; fixture Vet/Listing/commitment remain';
  const persist = (session) => durable?.saveSession(session);
  // The seller-state lock, checked last before an effect that leaves through
  // another journal: as the native publisher's authorize hook (called under its
  // address lock with nothing awaited before the CREATE intent), or just before
  // a wallet or delivery call. A holder that lost its job's row sends nothing.
  const heldFor = (jobId) => () => { assertSettlementCredit(jobId); return durable ? durable.assertHeld(jobId) : true; };
  function recordPhase(session, index, invokedAt, result) {
    const contextDelta = structuredClone(result.contextDelta ?? {});
    const entry = { index, step: structuredClone(listing.pipeline[index]), invokedAt, result: { ...structuredClone(result), contextDelta }, contextDelta };
    session.phaseResults ??= [];
    const existing = session.phaseResults[index];
    if (existing) {
      if (canonicalize(existing) !== canonicalize(entry)) throw new SellerAgentError('seller_phase_conflict', `retained phase ${index} differs from the completed operation`, 503);
      return existing;
    }
    if (session.phaseResults.length !== index || !Number.isSafeInteger(invokedAt) || invokedAt < 0) throw new SellerAgentError('seller_phase_order', `phase ${index} cannot be recorded out of order`, 503);
    session.startedAt ??= invokedAt;
    session.phaseResults.push(entry);
    session.lastUpdatedAt = Math.max(session.lastUpdatedAt ?? session.startedAt, invokedAt);
    persist(session);
    return entry;
  }
  function restore(session) {
    if (!session) return;
    authenticateBuyerBundle(session.buyerBundle);
    if (identityBundleHash(session.buyerBundle) !== session.buyerBundleHash) throw new SellerAgentError('seller_state_corrupt', 'retained buyer binding is invalid', 503);
    sessions.set(session.jobId, session);
    if (session.sellerContribution) {
      signatures.set(session.sellerContribution.planHash, session.sellerContribution.signature.value);
      contributions.set(session.sellerContributionProposalHash, session.sellerContribution);
    }
  }
  for (const session of durable?.sessions() ?? []) restore(session);
  const recoveryCall = (fn) => durable ? (input, { assertTransportOwner } = {}) => durable.withJob(input?.transportIdentity?.jobId ?? input?.jobId, async (session) => {
    assertTransportOwner?.();
    const jobId = input?.transportIdentity?.jobId ?? input?.jobId;
    sessions.delete(jobId);
    restore(session);
    return fn(input);
  }).catch((error) => {
    if (error.code === 'seller_state_capacity') throw new SellerAgentError('peer_job_capacity', 'the seller has reached maxJobs; no new session was admitted', 503);
    throw error;
  }) : fn;

  const sessionFor = (jobId) => {
    const session = sessions.get(jobId);
    if (!session) throw new SellerAgentError('unknown_job', 'no session for this job', 404);
    assertSettlementCredit(jobId);
    return session;
  };

  function authenticateBuyerBundle(bundle) {
    if (!isIdentityBundle(bundle)) throw new SellerAgentError('buyer_bundle_invalid', 'buyer IdentityBundle is not normative');
    const proof = bundle.presentation?.kind === 'per-claim' && bundle.presentation.signatures.find((entry) => entry.ref === bundle.presentedBy);
    // CORE SIG-6: exactly the canonical unpadded Base64URL of 64 bytes.
    const ok = proof && isCanonicalEd25519Signature(proof.signature) && verifyComponent({
      signedBytes: Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(bundle)}`, 'utf8'),
      signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature },
    });
    if (!ok) throw new SellerAgentError('buyer_bundle_unauthenticated', 'buyer IdentityBundle presentation does not verify');
    if (sameCanonicalClaimIdentity(bundle.presentedBy,claim)) throw new SellerAgentError('self_dealing', 'the buyer is the seller');
  }

  // CORE SN-1..SN-3: the seller issues the presentation challenge for a job and
  // buyer before the buyer presents; the operator hands it to the buyer (its
  // transport is out of scope). Only this verifier generates the nonce:
  // 256 bits from the CSPRNG (SN-1/SN-2), never caller-supplied bytes.
  // It admits one presentation (SN-4) until
  // SESSION_CHALLENGE_LIFETIME_MS after issue.
  function issueSessionChallenge({ jobId, buyer, sessionNonce } = {}) {
    requireOpen();
    if (!nativeProfile) throw new SellerAgentError('session_admission_required', 'the simulated fixture profile takes no session admission', 503);
    if (!isCanonicalJobId(jobId)) throw new SellerAgentError('job_invalid', 'jobId is not canonical');
    if (!canonicalDemosAgentPublicKey(buyer) || sameCanonicalClaimIdentity(buyer,claim)) throw new SellerAgentError('buyer_invalid', 'the challenge names no buyer claim other than the seller');
    if (sessionNonce !== undefined) throw new SellerAgentError('challenge_invalid', 'the seller generates its own session nonce (CORE SN-1/SN-2)');
    const nonce = randomBytes(32).toString('hex'), issuedAt = now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new SellerAgentError('seller_clock_invalid', 'the seller clock is not an integer time', 503);
    if(!Number.isSafeInteger(issuedAt+SESSION_CHALLENGE_LIFETIME_MS))throw new SellerAgentError('seller_clock_invalid','the challenge expiry exceeds the safe clock range',503);
    const issued = { jobId, buyer, sessionNonce: nonce, issuedAt, expiresAt: issuedAt + SESSION_CHALLENGE_LIFETIME_MS };
    try { challenges.issueChallenge(nonce, issued,{maxOutstanding:maxJobs,maxPerJob:MAX_CHALLENGES_PER_JOB}); }
    catch (error) { if(error.code==='seller_challenge_capacity')throw new SellerAgentError(error.code,error.message,503); if (error.code === 'seller_challenge_taken') throw new SellerAgentError('challenge_taken', 'this session nonce was issued before', 409); throw error; }
    return issued;
  }

  // ---- DACS-3: proposal -> seller contribution ----
  async function receiveProposal({ proposal, transportIdentity, buyerIdentityBundle }) {
    const jobId = transportIdentity?.jobId;
    if (!isCanonicalJobId(jobId)) throw new SellerAgentError('job_invalid', 'jobId is not canonical');
    assertVetContext();
    assertSessionAdmission();
    const existing = sessions.get(jobId);
    const completedProposalHash=existing?.proposal?.proposalHash??existing?.sellerContributionProposalHash;
    if(completedProposalHash&&completedProposalHash!==proposal?.proposalHash)return{disposition:'rejected',stage:'context',reason:'another proposal has already completed for this job'};
    // Session start (LRR-6, RAV-R1/R2): the rail is selected and its exact
    // signed definition pinned before the Agreement is signed. The pin is in
    // flight only from a successful retained seller signature: until then
    // every attempt, a retry after a rejection or a crash
    // included, selects again under the current authority as a new session.
    // The Agreement names only the rail id and version, so a new pin never
    // changes what is signed. The rail is the seller's own state, read before
    // the presentation is looked at: a `rail_unavailable` refusal consumes no
    // challenge.
    const inFlight = Boolean(existing?.sellerContribution || (existing?.agreementSignatureKey &&
      durable?.signature(existing.agreementSignatureKey).disposition === 'present'));
    // DACS-1 §6.3.4 step 3 is a current read-time gate, independent of the
    // historical admission retained for payment intake. Both endpoints count.
    const assertListingCurrent = () => {
      const at = now();
      if (at < listing.validity?.notBefore || (listing.validity?.notAfter !== undefined && at > listing.validity.notAfter)) {
        throw new SellerAgentError('session_not_admitted', 'the Listing is outside its validity interval', 409);
      }
    };
    if (!inFlight) assertListingCurrent();
    const railPin = nativeProfile ? (inFlight ? existing.railPin : rail.pin()) : undefined;
    assertRailPin(railPin, inFlight ? 'in-flight' : 'new');
    // CORE SN-4: a presentation attempt for a new session (not yet signed
    // under its pin) consumes the challenge its bundle carries, durably and
    // before the attempt is validated (its signature, buyer and job binding
    // included), a refused attempt too; only that exact presentation, once
    // admitted, continues. A session in flight continues without one.
    const newSession = nativeProfile && !inFlight;
    const nonce = buyerIdentityBundle?.sessionNonce;
    let presentationHash = null;
    try { presentationHash = sha256Hex(canonicalize(buyerIdentityBundle)); } catch { /* a malformed attempt still consumes its challenge */ }
    // DACS-1 §6.3.2: a presentation for a new session that carries no session
    // nonce is refused. It names no challenge, so it consumes none.
    if (newSession && (typeof nonce !== 'string' || nonce === '')) throw new SellerAgentError('session_not_admitted', 'the presentation carries no session nonce (DACS-1 §6.3.2)', 409);
    const issued = newSession ? challenges.attemptChallenge(nonce, { jobId, presentationHash, attemptedAt: now(), admitted: false }) : null;
    if (!isIdentityBundle(buyerIdentityBundle)) throw new SellerAgentError('buyer_bundle_invalid', 'buyer IdentityBundle is not normative');
    assertBuyer(buyerIdentityBundle.presentedBy,jobId,{proposal:true});
    const bundleHash = identityBundleHash(buyerIdentityBundle);
    if (nativeProfile && existing && canonicalize(existing.buyerBundle) !== canonicalize(buyerIdentityBundle)) throw new SellerAgentError('session_not_admitted', 'the presentation differs from the retained accepted presentation', 409);
    authenticateBuyerBundle(buyerIdentityBundle);
    if (!sameCanonicalClaimIdentity(transportIdentity.buyer,buyerIdentityBundle.presentedBy)) throw new SellerAgentError('buyer_mismatch', 'proposal buyer is not the presented identity');
    if (existing && existing.buyerBundleHash !== bundleHash) throw new SellerAgentError('job_taken', 'this job is bound to another buyer', 409);
    // A new session is admitted before anything of it is kept, read, signed or sent.
    if (newSession) {
      // CORE SN-1..SN-3: the bundle's sessionNonce must be a challenge this
      // seller issued for this job and buyer (issueSessionChallenge), not expired
      // on first admission. DACS-1 §6.3.2 reverifies the retained accepted
      // presentation on retry; it does not accept its consumed nonce anew.
      const challengeProblem = !issued ? 'the presentation nonce is not a challenge this seller issued'
        : issued.jobId !== jobId || !sameCanonicalClaimIdentity(issued.buyer,buyerIdentityBundle.presentedBy) ? 'the presentation nonce is a challenge issued for another job or buyer'
          : issued.attempt !== null && !(issued.attempt.presentationHash === presentationHash && issued.attempt.admitted === true) ? 'the presentation challenge was consumed by an earlier presentation attempt'
            : issued.attempt === null && !(now() < issued.expiresAt) ? 'the presentation challenge expired' : null;
      if (challengeProblem) throw new SellerAgentError('session_not_admitted', challengeProblem, 409);
      // DACS-1 RB-4..RB-6, LR-3: the seller decides revocation itself (core
      // checkListingRevocation) over the operator's readings; only `absent` opens.
      const revocation = await listingRevocationProblem(admission, { listing, listingPin: pin, jobId, now });
      if (revocation) throw new SellerAgentError(revocation.code, revocation.message, revocation.status);
      const query = { jobId, buyer: buyerIdentityBundle.presentedBy, buyerBundleHash: bundleHash, sessionNonce: nonce,
        seller: claim, listingPin: structuredClone(pin), profile: structuredClone(SELLER_PROFILE) };
      const accepted=issued.attempt?.admitted===true?issued.attempt.accepted:null;
      if(issued.attempt?.admitted===true&&(!accepted||accepted.buyerBundleHash!==bundleHash||canonicalize(accepted.buyerBundle??null)!==canonicalize(buyerIdentityBundle)))throw new SellerAgentError('session_admission_unavailable','the retained accepted presentation is incomplete or differs',503);
      let answer;
      try { answer = accepted?structuredClone(accepted.admission):await readAdmissionCapability(admission,'admit',query); }
      catch (cause) { throw new SellerAgentError('session_admission_unavailable', 'the seller session admission is unavailable', 503,{cause}); }
      const problem = sessionAdmissionProblem(answer, query);
      if (problem) throw new SellerAgentError(accepted?'session_admission_unavailable':'session_not_admitted', problem, accepted?503:409);
      if(!accepted)challenges.admitChallenge(nonce, presentationHash,{buyerBundle:structuredClone(buyerIdentityBundle),buyerBundleHash:bundleHash,admission:structuredClone(answer),admittedAt:now()});
    }
    if (!existing) sessions.set(jobId, { jobId, buyerBundle: structuredClone(buyerIdentityBundle), buyerBundleHash: identityBundleHash(buyerIdentityBundle), proposal: null, stage: 'proposed', ...(railPin ? { railPin } : {}) });
    else if (railPin && !inFlight) existing.railPin = railPin;
    const session = sessions.get(jobId);
    const signUnderPin = (bytes) => {
      if (inlineSizeProblem) throw new SellerAgentError('unsupported_inline_delivery', inlineSizeProblem, 503);
      if (!inFlight) assertListingCurrent();
      // The key is only a pointer. An intent or a thrown signer never makes
      // this pin in flight; signOnce's completed record is the authority.
      session.agreementSignatureKey = `signature:${sha256Hex(bytes)}`;
      persist(session);
      const signature = sign(bytes);
      if (session.railPin) { session.railPinSigned = true; persist(session); }
      return signature;
    };
    let contextFailure=null;
    const unavailable=(cause,reason)=>{contextFailure=cause;return{disposition:'indeterminate',reason:`VET_RECORD_UNVERIFIED: ${reason}`};};
    const progress = await respondToFixedPriceAgreementProposalDurable(
      { proposal, transportIdentity, seller: { party: claim, algorithm: 'ed25519', sign: signUnderPin } },
      {
        store,
        workerId: 'seller-agent',
        leaseTtlMs: 60_000,
        resolveAuthenticatedAgreementContext: async (query) => {
          const draft = query.candidateDraft;
          // Existing signed sessions remain readable/recoverable after upgrade.
          if (inlineSizeProblem && !inFlight) return { disposition: 'rejected', reason: inlineSizeProblem };
          if (query.seller !== claim || canonicalize(query.listingPin) !== canonicalize(pin)) return { disposition: 'rejected', reason: 'proposal names another Listing or seller' };
          if (query.buyer !== session.buyerBundle.presentedBy || query.jobId !== jobId) return { disposition: 'rejected', reason: 'proposal names another buyer or job' };
          const generatedAt = draft?.generatedAt;
          const observedAt = session.proposalAdmission?.proposalHash === proposal.proposalHash ? session.proposalAdmission.observedAt : now();
          const timeProblem = proposalTimeProblem({ generatedAt, observedAt, deadlineSecAfterCommit: listing.terms.deadlineSecAfterCommit,
            admitted: admittedContextRequest({ jobId, buyerBundle: session.buyerBundle, generatedAt }) });
          if (timeProblem) return { disposition: 'rejected', reason: timeProblem };
          session.proposalAdmission = { proposalHash: proposal.proposalHash, observedAt };
          if (deliveryContext) {
            const retained = session.demDeliveryContext;
            const resolved = retained ?? await resolveDemDeliverySellerContext(deliveryContext, { jobId, listing, buyerBundle: session.buyerBundle, generatedAt });
            if (resolved.disposition !== 'present') return { disposition: resolved.disposition, reason: resolved.reason };
            if (retained && (retained.input.generatedAt !== generatedAt || retained.input.jobId !== jobId)) return { disposition: 'rejected', reason: 'retained DEM delivery Agreement context differs' };
            // A context reference over the not-performed marker names no Vet record.
            const notPerformed = agreementInput({ jobId, listing, buyerBundle: session.buyerBundle, generatedAt });
            if (['buyer', 'seller'].some((role) => resolved.input[role].vetRecordRef.contentHash === notPerformed[role].vetRecordRef.contentHash)) {
              return { disposition: 'rejected', reason: 'the Vet context names the not-performed Vet references' };
            }
            // The delivery audit source carries these invocations. The core
            // delivery runner's own predicate refuses here, before signing,
            // what it would refuse at delivery after payment: one invocation
            // per party record, that party, its counterparty verifier, the
            // Listing's buyer requirement and every required claim covered.
            // A retained context is checked again, here and against its
            // records below: it may have been kept under an earlier, weaker check.
            const invocationProblem = sellerFulfilmentVetRequirementsViolation(resolved.vetRequirements, { jobId, buyerRequirement: listing.buyerRequirement,
              buyer: { primaryClaim: session.buyerBundle.presentedBy, vetRecordRef: resolved.input.buyer.vetRecordRef },
              seller: { primaryClaim: claim, vetRecordRef: resolved.input.seller.vetRecordRef } });
            if (invocationProblem) return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: ${invocationProblem}` };
            // DACS-2 §7.7.1: a reference is relied on only through the record it names.
            // §7.7.2: each party's record is verified by its counterparty, the
            // buyer's by the seller and the seller's by the buyer. The seller's
            // record is of the bundle the Agreement carries: the Listing's, or
            // this session's presentation of exactly it, which must verify.
            const sessionSeller = resolved.input.seller.identityBundle;
            const presentationProblem = sellerSessionPresentationProblem(sessionSeller, sellerBundle);
            if (presentationProblem) return { disposition: 'rejected', reason: `seller identity differs: ${presentationProblem}` };
            const parties = [['buyer', session.buyerBundle.presentedBy, session.buyerBundle, claim], ['seller', claim, sessionSeller, session.buyerBundle.presentedBy]];
            // A presence-only claim is replayed over the exact bundle against the
            // registry snapshot the operator pinned for the job; the pin is read
            // only then, once for both records.
            let registryPin = null;
            if (resolved.vetRequirements.some((entry) => hasPresenceOnlyClaim(entry.requirement))) {
              try { registryPin = await readRegistryPin(admission, jobId); }
              catch (cause) { return unavailable(cause, 'the pinned registry authority is unavailable'); }
            }
            for (const [role, party, bundle, verifier] of parties) {
              const ref = resolved.input[role].vetRecordRef;
              const invocation = resolved.vetRequirements.find((entry) => canonicalize(entry.vetRecordRef) === canonicalize(ref));
              let record;
              try { record = await readAdmissionCapability(admission,'resolveVetRecord',{ jobId, role, party, ref }); }
              catch (cause) { return unavailable(cause,`the ${role} Vet record is unavailable`); }
              let problem;
              try { problem = await vetRecordProblem(record, { ref, jobId, role, party, bundleHash: identityBundleHash(bundle), verifier, invocation, now, evidence: admission.vetEvidence, presence: { bundle, registryPin } }); }
              catch (cause) { return unavailable(cause,`the ${role} Vet evidence is unavailable`); }
              if (problem) return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: ${role}: ${problem}` };
              // DACS-2 VPC-3: a signed record is no admitted one. It is relied on
              // only with its SR-2 receipt at `accepted` or later, before any signature.
              let receipt;
              try { receipt = await readAdmissionCapability(admission,'readVetAnchorReceipt',{ jobId, role, party, ref }); }
              catch (cause) { return unavailable(cause,`the ${role} Vet record read or authentication is unavailable`); }
              const receiptProblem = vetAnchorReceiptProblem(receipt, { ref, jobId, party });
              if (receiptProblem) return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: ${role}: ${receiptProblem}` };
              // CORE SR2-4: the receipt's fields alone are assertions, not proof.
              // Only the operator's authentication of this record's receipt passes.
              let verdict;
              try { verdict = await readAdmissionCapability(admission,'verifyVetAnchorReceipt',{ jobId, role, party, ref, record, receipt }); }
              catch (cause) { return unavailable(cause,`the ${role} Vet record read or authentication is unavailable`); }
              if (verdict !== 'valid') return verdict==='invalid'?{disposition:'rejected',reason:`VET_RECORD_UNVERIFIED: ${role}: invalid Vet receipt`}:unavailable(new Error('Vet receipt verification is indeterminate'),`the ${role} Vet receipt verification is indeterminate`);
            }
            session.demDeliveryContext = structuredClone(resolved);
            return { disposition: 'present', value: structuredClone(resolved.input) };
          }
          return { disposition: 'present', value: agreementInput({ jobId, listing, buyerBundle: session.buyerBundle, generatedAt }) };
        },
        verifyContribution: contributionVerifier,
        reconcileSellerSignature: (input) => (signatures.has(input.planHash) ? { disposition: 'present', value: signatures.get(input.planHash) } : { disposition: 'absent', reason: 'not signed yet' }),
        transport: {
          publishSellerContribution: (contribution, identity) => {
            contributions.set(identity.proposalHash, structuredClone(contribution));
            signatures.set(contribution.planHash, contribution.signature.value);
            session.sellerContribution = structuredClone(contribution);
            session.sellerContributionProposalHash = identity.proposalHash;
            persist(session);
            return { disposition: 'submitted' };
          },
          reconcileSellerContributionPublication: (identity) =>
            contributions.has(identity.proposalHash) ? { disposition: 'present', value: contributions.get(identity.proposalHash) } : { disposition: 'absent', reason: 'not published' },
        },
      },
    );
    if (progress.disposition !== 'complete') {
      if(!existing&&!session.agreementSignatureKey&&!session.sellerContribution){if(nativeProfile)challenges.retireChallenge(nonce,presentationHash);sessions.delete(jobId);}
      const answer={disposition:progress.disposition,stage:progress.stage,reason:progress.reason};
      if(contextFailure){answer.causeCode=contextFailure?.name==='TimeoutError'||contextFailure?.code==='ETIMEDOUT'?'timeout':contextFailure instanceof RangeError?'reply-limit':'reader';Object.defineProperty(answer,'cause',{value:contextFailure});}
      return answer;
    }
    session.proposal = structuredClone(proposal);
    session.transportIdentity = structuredClone(transportIdentity);
    session.agreementHash = transportIdentity.agreementHash;
    persist(session);
    return { disposition: 'complete', contribution: progress.result.sellerContribution };
  }

  function agreementState(identity) {
    assertSettlementCredit(identity?.jobId);
    // Read without replacing the object owned by a concurrent job operation.
    const session = durable ? durable.loadSession(identity?.jobId) : sessions.get(identity?.jobId);
    if (!session?.proposal || session.transportIdentity?.proposalHash !== identity.proposalHash) return { proposal: null, contribution: null };
    return structuredClone({ proposal: session.proposal, contribution: session.sellerContribution ?? null });
  }

  // The buyer-anchored Agreement and the reference that names it: the
  // fixture-substrate write by default, or the buyer's authenticated native
  // SR-2 CREATE with the opt-in capability (its receipt kept as `native`).
  async function readBuyerAgreement(agreementAddress,buyer,agreementHash,signedProjection) {
    const reader=agreementAnchor??anchors,method=agreementAnchor?'readAgreement':'read';let read,returnedAgreementCause;
    const input=agreementAnchor?{logicalAddress:agreementAddress,writer:buyer,agreementHash,...signedProjection===undefined?{}:{signedProjection}}:agreementAddress;
    try {read=await readAdmissionCapability({read:async(query,limits)=>{const value=await reader[method](query,limits);returnedAgreementCause=value?.cause;return value;}},'read',input);}
    catch(cause){throw new SellerAgentError('substrate_unavailable','SR-2 Agreement read failed',503,{cause});}
    const status=agreementAnchor?read?.disposition:read?.status;
    if(status==='absent')throw new SellerAgentError('agreement_not_anchored','the buyer has not anchored the Agreement');
    if(status==='rejected'||status==='invalid')throw new SellerAgentError('agreement_anchor_invalid','Agreement anchor does not authenticate the buyer write',422,{cause:returnedAgreementCause??read});
    if(status!=='present')throw new SellerAgentError('substrate_unavailable','SR-2 Agreement readback is unavailable',503,{cause:returnedAgreementCause??read});
    if(agreementAnchor)return{agreement:read.artifact,ref:read.ref,native:read.native};
    let verdict;
    try{verdict=verifyFixtureRecord(read,{logicalAddress:agreementAddress,expectedWriter:buyer});}
    catch(cause){throw new SellerAgentError('agreement_anchor_invalid','Agreement anchor is malformed',422,{cause});}
    if(verdict!=='valid')throw new SellerAgentError('agreement_anchor_invalid','Agreement anchor is not the buyer write');
    return{agreement:read.artifact,ref:fixtureRef(agreementAddress,contentHash(read.artifact)),native:null};
  }

  const nativeAgreementView = (native) => ({ source: native.source, evidenceMode: native.evidenceMode, nativeAddress: native.nativeAddress, txRef: native.txRef });

  // DACS-3 §8.4.1: negotiation succeeds only with both signatures anchored
  // (SR-2). The seller's own contribution is not that, so `commit` records this
  // phase, after the buyer's Agreement readback has authenticated.
  function retainNegotiatePhase(session, jobId) {
    const agreementRef = { anchor: { kind: 'storage-program', locator: fixedPriceAgreementLogicalAddress(jobId) }, contentHash: session.agreementHash };
    return recordPhase(session, 0, session.proposalAdmission.observedAt, { ok: true,
      contextDelta: { 'negotiate-fixed-price': { agreementHash: session.agreementHash, agreementRef } } });
  }

  function retainCommitmentPhase(session, finalized) {
    // Ordinary commit has now authenticated the anchored Agreement and both signatures.
    const agreementRef={anchor:{kind:'storage-program',locator:fixedPriceAgreementLogicalAddress(session.jobId)},contentHash:finalized.agreementHash};
    recordPhase(session,0,session.proposalAdmission.observedAt,{ok:true,contextDelta:{'negotiate-fixed-price':{agreementHash:finalized.agreementHash,agreementRef}}});
    const commitmentRef = { anchor:{kind:'storage-program',locator:finalized.logicalAddress}, contentHash:contentHash(finalized.record), signer: claim };
    const commitmentTxRef = finalized.anchorTxRef;
    const commitmentDelta = { 'commit-payee-bound-agreement': {
      agreementHash: finalized.agreementHash,
      anchorTxRef: commitmentTxRef,
      anchorReceipt: structuredClone(finalized.anchorReceipt),
      committedAt: finalized.committedAt,
    } };
    return recordPhase(session, 1, nativeArtifactAnchor ? finalized.committedAt : session.commitCreatedAt, {
      ok: true,
      txRefs: [commitmentTxRef],
      attestationRef: commitmentRef,
      anchorReceipt: structuredClone(finalized.anchorReceipt),
      contextDelta: commitmentDelta,
    });
  }

  // ---- DACS-3: finalized commitment (orchestrator) ----
  // `readbackOnly` is internal (never an HTTP body field): a retained
  // commitment is authenticated again, but an absent one is never published.
  async function commit({ jobId, signedProjection }, { readbackOnly = false, signatureAgreement } = {}) {
    assertSettlementChain();
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    assertRailPin(session.railPin, 'in-flight');
    if(nativeProfile)assertNativePaymentHandler();
    const early = signatureAgreement !== undefined;
    if (early && !commitOnSignature) throw new SellerAgentError('signature_commitment_disabled', 'commitment on signature is disabled');
    if (early && signatureBuyer !== null && session.buyerBundle.presentedBy !== signatureBuyer) throw new SellerAgentError('signature_buyer_not_admitted', 'buyer is not admitted to early commitment');
    // An early request for an already committed job only reads back.
    const attempt = early && !session.commitment;
    // Repeated early requests stay readback-only. The ordinary path keeps
    // main's fence, the publisher's durable intent before any send, until the
    // early commitment has been seen present; after that it only reads back.
    readbackOnly ||= early ? !attempt || Boolean(session.signatureCommitmentAttempt) : Boolean(session.signatureCommitmentHeld);
    const readbackRequired = () => { throw new SellerAgentError('commitment_readback_required', 'only the retained commitment may be read back here', 503); };
    if(readbackOnly&&!session.commitment&&!session.signatureCommitmentAttempt)readbackRequired();
    // Once a native commitment has been finalized, every later entry through
    // the public commit path is reconciliation. An absent fresh observation is
    // not authority to publish another CREATE for the same logical address.
    const retainedNativeCommitment = Boolean(nativeArtifactAnchor && session.commitment);
    readbackOnly ||= Boolean(session.commitment);
    if (!session.agreementHash) throw new SellerAgentError('not_agreed', 'no Agreement contribution was made for this job');
    const agreementAddress = fixedPriceAgreementLogicalAddress(jobId);
    const projection = signedProjection ?? session.agreementSignedProjection;
    let candidate;
    if (early) {
      try {
        candidate = await verifySignatureAgreement(signatureAgreement, session, contributionVerifier);
        verifyAgreementCreateAuthorization(signedProjection, candidate, agreementAddress, session.buyerBundle.presentedBy);
      }
      catch (error) { throw new SellerAgentError('signature_agreement_invalid', String(error.message).slice(0, 240),422,{cause:error}); }
    }
    const { agreement, ref: agreementRef, native } = early
      ? { agreement: candidate, ref: fixtureRef(agreementAddress, session.agreementHash), native: null }
      : await readBuyerAgreement(agreementAddress, session.buyerBundle.presentedBy, session.agreementHash, projection);
    if (contentHash(agreement) !== session.agreementHash) throw new SellerAgentError('agreement_substituted', 'anchored Agreement differs from the one the seller contributed to');
    // Retain public proof only after ordinary native authentication, before any
    // commitment effect. Restart can reauthenticate it without buyer authority.
    if (native && projection !== undefined) session.agreementSignedProjection = structuredClone(projection);
    if (early && !session.signatureCommitmentAttempt && signatureCommitmentReady) {
      try { await signatureCommitmentReady(); }
      catch(cause) { throw new SellerAgentError('signature_connection_unavailable', 'early commitment connection reservation is unavailable', 503,{cause}); }
    }
    if (!nativeArtifactAnchor && durable?.hasAnchor(finalityCommitmentAddress(jobId))) await durable.reconcileAnchor(`anchor:${finalityCommitmentAddress(jobId)}`, anchors);
    // Older retained attempts have no publication marker. Their CREATE may
    // already have been asked for, so require the same proof as a new send.
    if (nativeArtifactAnchor) session.commitmentPublishAsked ??= session.commitCreatedAt !== undefined;
    session.commitCreatedAt ??= now();
    if (attempt) {
      if (!session.signatureCommitmentAttempt) {
        try { durable.reserveSignatureCommitment(session.buyerBundle.presentedBy, jobId); }
        catch (error) {
          if (error?.code === 'seller_signature_buyer_unresolved') throw new SellerAgentError(error.code, 'this buyer already has an unresolved early commitment', 409);
          throw error;
        }
      }
      session.agreementSignedProjection = structuredClone(signedProjection);
      session.signatureCommitmentAttempt = true;
    }
    // This job's authenticated readback releases its buyer slot even without a
    // saved marker: the reservation and the session save are separate writes.
    if (!early && (commitOnSignature || session.signatureCommitmentAttempt)) durable.releaseSignatureCommitment(session.buyerBundle.presentedBy, jobId);
    persist(session);
    let finalized;
    let nativeCommitmentProjection;
    let commitmentProvenUnsigned = false;
    try {
      finalized = await commitFixedPriceAgreement(
        {
          agreement,
          verifiedListing: { disposition: 'verified', listing, pin },
          session: commitmentSession(agreement),
          createdAt: session.commitCreatedAt,
          commitmentSigner: { algorithm: 'ed25519', signer: claim, sign: (bytes) => { if (readbackOnly) readbackRequired(); return sign(bytes); } },
        },
        nativeArtifactAnchor ? {
          resolve: async (logicalAddress) => {
            const read=await nativeArtifactAnchor.readRetained({logicalAddress,artifactKind:'FinalityCommitmentRecord',proofOfNoIntent:true,fresh:true});
            if(read.status==='absent') {
              commitmentProvenUnsigned = isProvenUnsignedAbsence(read);
              if (session.commitmentPublishAsked && !commitmentProvenUnsigned) return { disposition: 'indeterminate', reason: 'a requested commitment CREATE has no authenticated readback or proof that nothing was signed' };
              return {disposition:'absent'};
            }
            if(read.status!=='present') return {disposition:read.status==='rejected'?'rejected':'indeterminate',reason:read.reason};
            nativeCommitmentProjection=read.signedProjection;
            return {disposition:'present',anchored:{record:read.artifact,nativeAddress:read.receipt.nativeAddress,anchorTxRef:read.txRef,anchorReceipt:read.receipt}};
          },
          verifyAnchorReceipt: async (anchored) => readAdmissionCapability(nativeArtifactAnchor,'verifyReceipt',{logicalAddress:anchored.anchorReceipt.logicalAddress,artifact:anchored.record,artifactKind:'FinalityCommitmentRecord',receipt:anchored.anchorReceipt,signedProjection:nativeCommitmentProjection,fresh:true}),
          submit: async (logicalAddress, commitmentRecord) => {
            if(readbackOnly || retainedNativeCommitment) readbackRequired();
            if (session.commitmentPublishAsked && !commitmentProvenUnsigned) readbackRequired();
            heldFor(jobId)?.();
            session.commitmentPublishAsked = true;
            persist(session);
            const out=await nativeArtifactAnchor.publish({logicalAddress,artifact:commitmentRecord,artifactKind:'FinalityCommitmentRecord',authorize:heldFor(jobId)});
            if(out.status!=='present') throw new Error(out.reason ?? 'native commitment publication is indeterminate');
            nativeCommitmentProjection=out.signedProjection;
            return {record:commitmentRecord,nativeAddress:out.receipt.nativeAddress,anchorTxRef:out.txRef,anchorReceipt:out.receipt};
          },
        } : {
          ...commitmentReader(anchors, claim),
          submit: async (logicalAddress, commitmentRecord) => {
            if (readbackOnly) readbackRequired();
            const receipt = (await anchorOnce(logicalAddress, commitmentRecord)).receipt;
            return { record: commitmentRecord, nativeAddress: receipt.nativeAddress, anchorTxRef: fixtureTxRef(receipt), anchorReceipt: receipt };
          },
        },
        commitmentVerifier,
      );
    } catch (error) {
      throw new SellerAgentError('commitment_failed', String(error?.message ?? error).slice(0, 240),503,{cause:error});
    }
    if (early) {
      if (attempt && !session.signatureCommitmentHeld) { session.signatureCommitmentHeld = true; persist(session); }
      return { status: 'commitment-held', address: finalized.logicalAddress, resumed: finalized.resumed };
    }
    // A native fresh read creates a new observation timestamp, not a new
    // commitment or phase result. Authenticate it above, then retain the exact
    // original SDK commitment/phase bytes when the immutable record, tx and
    // receipt binding are unchanged.
    if (nativeArtifactAnchor && session.commitment) {
      const retained=session.commitment;
      if(contentHash(retained.record)!==contentHash(finalized.record) || retained.logicalAddress!==finalized.logicalAddress || retained.committedAt!==finalized.committedAt ||
          canonicalize(retained.anchorTxRef)!==canonicalize(finalized.anchorTxRef) || !sameNativeCommitmentReceipt(retained.anchorReceipt,finalized.anchorReceipt)) {
        throw new SellerAgentError('commitment_changed','fresh native commitment readback differs from the retained finalized commitment',503);
      }
      if(await readAdmissionCapability(nativeArtifactAnchor,'verifyReceipt',{logicalAddress:retained.logicalAddress,artifact:retained.record,artifactKind:'FinalityCommitmentRecord',receipt:retained.anchorReceipt,signedProjection:nativeCommitmentProjection,fresh:true})!=='valid')throw new SellerAgentError('commitment_changed','retained commitment proof no longer authenticates',503);
      retainNegotiatePhase(session,jobId);
      retainCommitmentPhase(session,retained);
      session.agreement=agreement;session.agreementRef=agreementRef;
      if(native)session.agreementAnchor=nativeAgreementView(native);
      if(session.stage==='proposed')session.stage='committed';persist(session);
      return {status:'committed',address:retained.logicalAddress,resumed:true,...(native?{agreementAnchor:nativeAgreementView(native)}:{})};
    }
    // Recorded before the commitment is retained, so a saved commitment never
    // lacks the phase before it.
    retainNegotiatePhase(session, jobId);
    session.agreement = agreement;
    session.agreementRef = agreementRef;
    if (native) session.agreementAnchor = nativeAgreementView(native);
    session.commitment = finalized;
    if(session.stage==='proposed')session.stage='committed';
    // The native receipt is the authoritative commitment time. Local wall
    // time may be later within the same millisecond/second and cannot replace
    // that finalized fact in the SDK SessionRecord.
    retainCommitmentPhase(session, finalized);
    persist(session);
    return { status: 'committed', address: finalized.logicalAddress, resumed: finalized.resumed, ...(native ? { agreementAnchor: nativeAgreementView(native) } : {}) };
  }

  // ---- DACS-4: payment claim -> SDK intake -> payment evidence ----
  // The native rail is the job's own pinned signed definition (RAV-R5), never
  // the current configuration; the fixture profile uses its simulated rail.
  const pinnedRail = (jobId) => {
    if (!nativeProfile) return { disposition: 'verified', rail: structuredClone(DEM_RAIL_DEFINITION), railRegistryVersion: RAIL_REGISTRY_VERSION };
    const railPin = sessions.get(jobId)?.railPin;
    const verdict = rail.evaluate(railPin, 'in-flight');
    if (verdict.decision !== 'pass') return { disposition: verdict.decision === 'fail' ? 'rejected' : 'indeterminate', reason: `pinned rail ${verdict.decision} (${verdict.reason})` };
    return { disposition: 'verified', rail: intakeRailDefinition(railPin), railRegistryVersion: railPin.railRegistryVersion };
  };
  const intakeDepsFor = (paymentJobId) => ({
    resolveCommittedAgreement: async (jobId) => {
      const session = sessions.get(jobId);
      if (jobId !== paymentJobId || !session?.commitment) return { disposition: 'rejected', reason: 'no finalized commitment for this job' };
      const railed = pinnedRail(jobId);
      if (railed.disposition !== 'verified') return { disposition: railed.disposition, reason: railed.reason };
      const c = session.commitment;
      return {
        disposition: 'verified',
        agreement: structuredClone(session.agreement),
        agreementHash: c.agreementHash,
        commitment: { finality: 'finalized', ref: c.logicalAddress, contentHash: contentHash(c.record), jobId, agreementHash: c.agreementHash, listingRef: { ...session.agreement.listingRef }, committedAt: c.committedAt, signer: c.record.signature.signer },
        railRegistryVersion: railed.railRegistryVersion,
      };
    },
    resolveListingAtCommit: async (listingRef) => (canonicalize(listingRef) === canonicalize(pin) ? { rawListing: structuredClone(listing), validation: structuredClone(validation) } : { rawListing: {}, validation: { disposition: 'rejected', reason: 'unknown-listing' } }),
    resolveRail: async ({ ref, railRegistryVersion }) => {
      const railed = pinnedRail(paymentJobId);
      if (railed.disposition !== 'verified') return railed;
      return ref?.railId === railed.rail.railId && railRegistryVersion === railed.railRegistryVersion ? railed : { disposition: 'rejected', reason: 'unknown rail' };
    },
    resolveIdentityBundle: async (bundleHash) => {
      if (bundleHash === identityBundleHash(sellerBundle)) return { disposition: 'verified', bundle: structuredClone(sellerBundle) };
      for (const session of sessions.values()) {
        const presented=session.demDeliveryContext?.input?.seller?.identityBundle;
        if(presented && identityBundleHash(presented)===bundleHash)return {disposition:'verified',bundle:structuredClone(presented)};
      }
      for (const session of sessions.values()) if (session.buyerBundleHash === bundleHash) return { disposition: 'verified', bundle: structuredClone(session.buyerBundle) };
      return { disposition: 'rejected', reason: 'unknown identity bundle' };
    },
    resolvePayerAddress: async () => ({ disposition: 'rejected', reason: 'x402 is not supported by this agent' }),
    resolvePayeeDestination: async () => ({ disposition: 'error', reason: 'x402 is not supported by this agent', tier: 2 }),
    observeDemosTransfer: (txHash) => readAdmissionCapability({read:()=>observeDemosTransfer(txHash)},'read',{}),
    observeX402Transfer: async () => ({ status: 'unavailable', reason: 'x402 is not supported by this agent' }),
    verifyX402ReceiptExtensions: () => ({ disposition: 'fail', reason: 'x402 is not supported by this agent' }),
    classifyX402SettlementChain: () => ({ disposition: 'unsupported', reason: 'x402 is not supported by this agent' }),
    receiptStore,
  });

  async function anchorOnce(logicalAddress, artifact) {
    if(artifact.jobId)assertSettlementCredit(artifact.jobId);
    const authorize = () => { if(artifact.jobId)assertSettlementCredit(artifact.jobId);return signAnchorWrite(sign, logicalAddress, contentHash(artifact)); };
    const receipt = durable ? await durable.anchor({ jobId: artifact.jobId, logicalAddress, artifact, anchors, authorize }) : await anchors.write({ logicalAddress, artifact, writer: claim, writerSignature: authorize() });
    return { ref: fixtureRef(logicalAddress, contentHash(artifact)), receipt };
  }

  const signEvidence = (unsigned) => signComponentArtifact(unsigned, ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: claim, sign: (bytes) => sign(bytes) });

  function signedFixtureRef(logicalAddress, hash) {
    return { ...fixtureRef(logicalAddress, hash), signer: claim };
  }

  function fulfilmentAgreement(session) {
    const party = (role) => session.agreement.parties.find((candidate) => candidate.role === role);
    const buyer = party('buyer'), seller = party('seller');
    return {
      artifactKind: 'payee-bound',
      ref: fixedPriceAgreementLogicalAddress(session.jobId),
      contentHash: contentHash(session.agreement),
      jobId: session.jobId,
      listingPin: structuredClone(pin),
      buyer: { primaryClaim: buyer.primaryClaim, bundleHash: buyer.bundleHash, vetRecordRef: structuredClone(buyer.vetRecordRef) },
      seller: { primaryClaim: seller.primaryClaim, bundleHash: seller.bundleHash, vetRecordRef: structuredClone(seller.vetRecordRef) },
      // The committed Agreement already binds the complete canonical spec,
      // including additive fields named `signature` (not an artifact signature).
      deliverableRef: structuredClone(session.agreement.terms.deliverable),
      commitment: {
        status: 'finalized',
        ref: session.commitment.logicalAddress,
        agreementHash: session.commitment.agreementHash,
        recordContentHash: contentHash(session.commitment.record),
        finalizedAt: session.commitment.committedAt,
        signer: claim,
      },
    };
  }

  function fulfilmentListing() {
    return {
      pin: structuredClone(pin),
      sellerPrimaryClaim: claim,
      buyerRequirement: structuredClone(listing.buyerRequirement),
      pipeline: structuredClone(listing.pipeline),
      deliverable: structuredClone(listing.offering.deliverable),
    };
  }

  function fulfilmentAuditSource(session, paymentRef) {
    const party = (role) => session.agreement.parties.find((candidate) => candidate.role === role);
    const buyer = party('buyer'), seller = party('seller');
    const commitmentRef = { anchor:{kind:'storage-program',locator:session.commitment.logicalAddress}, contentHash:contentHash(session.commitment.record), signer:claim };
    return {
      sourceVersion: '1',
      session: {
        recordVersion: '1',
        jobId: session.jobId,
        state: 'settle-pending',
        listingRef: structuredClone(pin),
        parties: [
          { role: 'buyer', bundleHash: buyer.bundleHash, primaryClaim: buyer.primaryClaim, vetRecordRef: structuredClone(buyer.vetRecordRef) },
          { role: 'seller', bundleHash: seller.bundleHash, primaryClaim: seller.primaryClaim, vetRecordRef: structuredClone(seller.vetRecordRef) },
          { role: 'orchestrator', bundleHash: seller.bundleHash, primaryClaim: seller.primaryClaim },
        ],
        pipeline: structuredClone(listing.pipeline),
        phaseResults: structuredClone(session.phaseResults),
        startedAt: session.startedAt,
        lastUpdatedAt: session.lastUpdatedAt,
        recipeRegistryVersion: 1,
        railRegistryVersion: session.railPin.railRegistryVersion,
      },
      artifacts: {
        agreementCommitment: commitmentRef,
        vetRecords: [structuredClone(buyer.vetRecordRef), structuredClone(seller.vetRecordRef)],
        vetRequirements: structuredClone(session.demDeliveryContext.vetRequirements),
        settlementEvidence: [structuredClone(paymentRef)],
      },
      provenanceProfile: 'dacs-sdk-operational-v1',
    };
  }

  function reportMatches(value, session, settlementId) {
    const expected = deliveryReport(session, settlementId);
    return canonicalize(value) === canonicalize(expected);
  }

  async function validCurrentFulfilmentFence(fence, jobId) {
    const loaded = await fulfilmentStore.load(jobId);
    return loaded.status === 'ok' && loaded.record.lease?.owner === fence.owner &&
      loaded.record.lease?.generation === fence.generation && loaded.record.lease.expiresAt > now();
  }

  function nativeDeliveryBinding(session, work, fulfilmentId) {
    const terms = agreementTerms(session.agreement);
    return { version:'1',profile:'dacs-native-delivery-publication/v1',jobId:session.jobId,
      phase:'deliver-storage-program',phaseIndex:protocolSupport(listing).phases.delivery,listing:structuredClone(pin),
      agreementHash:contentHash(session.agreement),fulfilmentId,purchaseAmount:{amount:terms.price.amount,currency:terms.price.currency},
      payloadHash:sha256Hex(canonicalize(deliveryReport(session,work.intake.settlementId))) };
  }

  function sameNativeDeliveryReceipt(left, right) {
    if (!left || !right) return false;
    const stable = ['receiptVersion','substrate','finalityProfile','logicalAddress','nativeAddress','contentHash','writer','nonce','state','observationDisposition'];
    return stable.every((key)=>canonicalize(left[key]??null)===canonicalize(right[key]??null)) &&
      canonicalize(left.transactionRef)===canonicalize(right.transactionRef) && canonicalize(left.blockRef)===canonicalize(right.blockRef);
  }

  // A fresh process may observe the same reviewed block with a normalized
  // wall-clock timestamp. The immutable block identity is its hash and height;
  // preserve the already-authenticated original receipt rather than replacing
  // it with that later observation. Every other receipt/transaction binding
  // remains exact, and both timestamps must still be well-formed source facts.
  function sameNativeCommitmentReceipt(left, right) {
    if (!left || !right || !Number.isSafeInteger(left.blockRef?.timestamp) || !Number.isSafeInteger(right.blockRef?.timestamp)) return false;
    const stable = ['receiptVersion','substrate','finalityProfile','logicalAddress','nativeAddress','contentHash','writer','nonce','state','observationDisposition'];
    return stable.every((key)=>canonicalize(left[key]??null)===canonicalize(right[key]??null)) &&
      canonicalize(left.transactionRef)===canonicalize(right.transactionRef) &&
      canonicalize(left.blockRef)===canonicalize(right.blockRef);
  }

  // A plain absence of a submitted Deliverable may hide a CREATE the wallet
  // signed and kept (a lost answer, a dropped broadcast): only the wallet
  // journal that kept this submission can tell. It sends the kept bytes again,
  // unchanged, and answers `unsigned` only when nothing it signed can still land,
  // so that alone lets a new submission be asked. Returns { status: 'unsigned' },
  // or { status: 'held', reason } with the journal's cause; throws when the job
  // lock is lost. A journal that is not the one recorded with the submission (a
  // lost or replaced file, or none recorded) is not asked.
  async function askDeliverableJournal(session, work, fulfilmentId) {
    if (session.deliveryWalletJournal !== deliverableJournal.journalId) {
      return { status: 'held', reason: 'wallet_journal_changed: the wallet journal that kept this Deliverable submission is not the configured one; restore its file to resolve it' };
    }
    heldFor(session.jobId)();
    const report = deliveryReport(session, work.intake.settlementId);
    let answer;
    try {
      answer = await reconcileDeliverableCreate({ logicalAddress: deliverableAddress(session.jobId), report, writer: claim, jobId: session.jobId,
        receiptContentHash: sha256Hex(canonicalize(report)), deliveryBinding: nativeDeliveryBinding(session, work, fulfilmentId) });
    } catch (error) { return { status: 'held', reason: `${error?.code ?? 'wallet_journal_error'}: ${String(error?.message ?? error).slice(0, 180)}` }; }
    // The journal's bounded cause is kept with the held outcome: a refused or
    // timed-out broadcast, or a supersession, is told apart from a lost answer.
    const cause = typeof answer?.reason === 'string' && answer.reason ? `: ${answer.reason.slice(0, 240)}` : '';
    if (answer?.status === 'unsigned') {
      // A supersession reason is a fact of the chain read that proved the row
      // cannot land; once the row is superseded every later question about it
      // answers only that nothing is live. Keep the first cause with the
      // submission record, for the one CREATE it names, so the held outcome
      // keeps saying why (it authorizes nothing).
      const retained = session.deliveryJournalUnsigned, reason = typeof answer.reason === 'string' ? answer.reason.slice(0, 240) : undefined;
      if (typeof answer.txHash === 'string' && reason) {
        if (retained?.txHash === answer.txHash && typeof retained.reason === 'string') return { status: 'unsigned', reason: retained.reason };
        session.deliveryJournalUnsigned = { txHash: answer.txHash, reason };
        persist(session);
      }
      return { status: 'unsigned', reason };
    }
    if (['rebroadcast', 'pending', 'applied'].includes(answer?.status)) return { status: 'held', reason: `the kept signed Deliverable CREATE was answered ${answer.status}; its readback is awaited${cause}` };
    return { status: 'held', reason: 'the wallet journal answered no known status for the Deliverable CREATE' };
  }

  // With the journal, the read of a submitted Deliverable that throws the
  // adapter's miss is a plain absence too: it is asked only to send the same bytes.
  const isDeliverableMiss = (error) => deliverableJournal !== null && NATIVE_READ_MISSES.includes(error?.observation);

  // A lost response after the native Deliverable CREATE has applied leaves the
  // SDK's durable delivery WAL at an intent. Before re-entering that runner,
  // authenticate the exact original public projection and retain only the
  // fulfilment binding the runner already returned. Absence/indeterminate
  // readback is deliberately non-authoritative here: it must never turn a
  // caller retry into another seller approval or CREATE. The one exception is
  // an absence the reader proved (a shutdown cut the approval before anything
  // was signed): the runner then reconciles its WAL, reads the same absence
  // and submits again, which asks the operator again.
  async function recoverNativeDeliveryBinding(session, work) {
    if (!nativeDelivery || session.deliveryReady) return { status: 'not-needed' };
    const result = session.deliveryHold?.result;
    if (result?.decision !== 'indeterminate' || !['delivery-submission-ambiguous', 'delivery-resolution-pending'].includes(result.code) ||
        result.safeToRetryDelivery !== false || result.recovery?.action !== 'reconcile-delivery' ||
        typeof result.fulfilmentId !== 'string' || !result.fulfilmentId) return { status: 'not-needed' };
    const { disposition: _disposition, fulfilment: _fulfilment, reason: _reason, permitId: _permitId, ...authorization } = work.intake;
    if (!result.consumedPaymentAuthorization || canonicalize(result.consumedPaymentAuthorization) !== canonicalize(authorization)) {
      return { status: 'held', reason: 'retained SDK delivery recovery authority differs from the native payment intake' };
    }
    const report = deliveryReport(session, work.intake.settlementId);
    const binding = nativeDeliveryBinding(session, work, result.fulfilmentId);
    if (session.deliveryAdapter && (session.deliveryAdapter.fulfilmentId !== result.fulfilmentId ||
        canonicalize(session.deliveryAdapter.deliveryBinding) !== canonicalize(binding))) {
      return { status: 'held', reason: 'retained native delivery recovery binding differs from the SDK fulfilment intent' };
    }
    let read;
    try {
      read = await readNativeDemDelivery(nativeDelivery, { jobId: session.jobId, logicalAddress: deliverableAddress(session.jobId), report,
        receiptContentHash: sha256Hex(canonicalize(report)), deliveryBinding: binding });
    } catch (error) {
      if (!isDeliverableMiss(error)) return { status: 'held', reason: `native delivery reconciliation readback is unavailable: ${String(error?.message ?? error).slice(0, 180)}` };
      read = { status: 'absent' };
    }
    if (isProvenUnsignedAbsence(read)) return { status: 'askable' };
    if (read.status === 'absent' && deliverableJournal) {
      const asked = await askDeliverableJournal(session, work, result.fulfilmentId);
      return asked.status === 'unsigned' ? { status: 'askable' } : { status: 'held', reason: asked.reason };
    }
    if (read.status !== 'present') return { status: 'held', reason: read.reason ?? 'original native Deliverable CREATE is not authenticated on fresh readback' };
    session.deliveryAdapter = { fulfilmentId: result.fulfilmentId, deliveryBinding: binding,
      reconciliationId: read.receipt.transactionRef.value, substrate: 'source-native-delivery-recovered-readonly' };
    persist(session);
    return { status: 'present' };
  }

  // Runs the SDK delivery runner over this job's retained fulfilment. A lost
  // response after the native Deliverable CREATE leaves the SDK's delivery WAL
  // at an intent; the runner re-enters it through reconcileDeliverySubmission
  // below, which only reads the Deliverable back. Absence or an unavailable
  // read never causes another CREATE: only an absence the reader proved (or a
  // submission this seller never made) lets the runner submit again.
  async function runSdkDeliveryReady(session, work, paymentRead) {
    if (!deliveryContext || !session.demDeliveryContext || !fulfilmentStore) {
      return { status: 'not-ready', reason: 'authenticated DEM delivery context is unavailable' };
    }
    const terms = agreementTerms(session.agreement);
    const paymentRef = signedFixtureRef(work.address, work.intake.evidenceHash);
    recordPhase(session, terms.paymentPhaseIndex, work.intake.evidenceInput.observedAt, {
      ok: true,
      txRefs: structuredClone(work.intake.evidenceInput.paymentTxRefs),
      attestationRef: paymentRef,
      anchorReceipt: structuredClone(paymentRead.receipt),
      contextDelta: {},
    });
    const agreement = fulfilmentAgreement(session), signedListing = fulfilmentListing();
    const auditSource = fulfilmentAuditSource(session, paymentRef);
    const request = {
      agreementRef: agreement.ref,
      agreementHash: agreement.contentHash,
      commitmentRef: agreement.commitment.ref,
      deliveryPhaseIndex: protocolSupport(listing).phases.delivery,
      paymentPermitId: work.intake.permitId,
    };
    const deliveryBinding = (fulfilmentId) => nativeDeliveryBinding(session,work,fulfilmentId);
    const verifySellerComponent = ({ signedBytes, signature, expectedSigner }) => {
      const valid = expectedSigner === claim && signature?.signer === claim && verifyComponent({ signedBytes, signature });
      return { disposition: valid ? 'valid' : 'invalid', ...(valid ? {} : { reason: 'signature is not the seller/orchestrator component' }) };
    };
    const readDelivery = async (logicalAddress, fulfilmentId=session.deliveryAdapter?.fulfilmentId) => {
      if (nativeDelivery) {
        if (!fulfilmentId) return null;
        const report=deliveryReport(session,work.intake.settlementId);
        const result=await readNativeDemDelivery(nativeDelivery,{jobId:session.jobId,logicalAddress,report,receiptContentHash:sha256Hex(canonicalize(report)),deliveryBinding:deliveryBinding(fulfilmentId)});
        if(result.status==='present')return{status:'present',artifact:result.artifact,receipt:result.receipt,signedProjection:result.signedProjection,demosEvidence:result.demosEvidence};
        if(result.status==='rejected')throw new SellerAgentError('delivery_readback_invalid',result.reason,503);
        return null;
      }
      const record = await anchors.read(logicalAddress);
      if (record.status !== 'present') return null;
      if (verifyFixtureRecord(record, { logicalAddress, expectedWriter: claim }) !== 'valid') throw new SellerAgentError('delivery_readback_invalid', 'delivery receipt is not the seller write', 503);
      return record;
    };
    let verifiedSchemaPayload;
    const deps = {
      auditSourceProfile: 'v2',
      receiptStore,
      resolveAuditSource: async (jobId) => jobId === session.jobId ? { status: 'verified', value: structuredClone(auditSource) } : { status: 'rejected', reason: 'another job was requested' },
      resolveAgreement: async (ref) => ref === agreement.ref ? { status: 'verified', value: structuredClone(agreement) } : { status: 'rejected', reason: 'another Agreement was requested' },
      resolveListing: async (requestedPin) => canonicalize(requestedPin) === canonicalize(pin) ? { status: 'verified', value: structuredClone(signedListing) } : { status: 'rejected', reason: 'another Listing was requested' },
      prepareDelivery: async ({ jobId, phaseIndex, phase, logicalAddress }) => {
        if (jobId !== session.jobId || phaseIndex !== protocolSupport(listing).phases.delivery || phase !== 'deliver-storage-program' || logicalAddress !== deliverableAddress(session.jobId)) {
          return { status: 'rejected', reason: 'delivery preparation scope differs' };
        }
        const report = deliveryReport(session, work.intake.settlementId);
        const size = Buffer.byteLength(canonicalize(report));
        const expected = listing.offering.deliverable.expectedSizeBytes;
        // A producer can be corrected after payment. Do not let a size
        // disagreement become the core's permanent preparation-failed handoff.
        if (size > MAX_STORAGE_ARTIFACT_BYTES || (expected !== undefined && size !== expected)) {
          return { status: 'indeterminate', reason: `inline delivery size ${size} differs from supported expectedSizeBytes ${expected ?? 'undeclared'} (maximum ${MAX_STORAGE_ARTIFACT_BYTES})` };
        }
        if (schemaUrl !== undefined) {
          const verdict = await deps.verifyDeliverySchema({ schemaUrl, cleartextPayload: report });
          if (verdict?.disposition !== 'valid') return { status: 'indeterminate', reason: verdict?.reason || 'report schema validation is not valid' };
        }
        return { status: 'prepared', delivery: { artifact: { kind: phase, cleartextPayload: report, anchoredValue: report, access: { model: 'public' } } } };
      },
      submitDelivery: async (input) => {
        if (!await validCurrentFulfilmentFence(input.fence, session.jobId)) return { status: 'rejected', reason: 'delivery effect fence is not current' };
        if (input.logicalAddress !== deliverableAddress(session.jobId) || !reportMatches(input.artifact.anchoredValue, session, work.intake.settlementId) ||
            canonicalize(input.artifact.cleartextPayload) !== canonicalize(input.artifact.anchoredValue)) return { status: 'rejected', reason: 'delivery candidate differs from the exact report' };
        if(nativeDelivery){
          const report=structuredClone(input.artifact.anchoredValue),binding=deliveryBinding(input.fulfilmentId);
          // A lost job lock throws here, before anything leaves. The SDK's delivery WAL keeps a thrown
          // submission at its intent (an answer such as 'rejected' would be its retained outcome), so the
          // next holder reads back authoritative absence and submits once.
          heldFor(session.jobId)?.();
          // Kept before the capability is asked: from here on only a readback
          // (or the reader's proven absence) tells whether this CREATE exists.
          session.deliverySentReport={settlementId:work.intake.settlementId,canonical:canonicalize(report)};
          session.deliverySubmitted=[...new Set([...(session.deliverySubmitted??[]),input.fulfilmentId])];
          session.deliveryAdapter={fulfilmentId:input.fulfilmentId,artifactHash:input.artifactHash,deliveryBinding:binding,substrate:'source-native-delivery'};
          // The journal this submission goes through: only it may later answer for it.
          if(deliverableJournal)session.deliveryWalletJournal=deliverableJournal.journalId;
          persist(session);
          const answer=await submitNativeDemDelivery(nativeDelivery,{...input,report,receiptContentHash:sha256Hex(canonicalize(report)),deliveryBinding:binding,writer:claim});
          if(answer.status!=='accepted')return answer;
          session.deliveryAdapter={fulfilmentId:input.fulfilmentId,artifactHash:input.artifactHash,deliveryBinding:binding,reconciliationId:answer.reconciliationId,substrate:'source-native-delivery'};
          persist(session);return answer;
        }
        const anchored = await anchorOnce(input.logicalAddress, input.artifact.anchoredValue);
        session.deliveryAdapter = { fulfilmentId: input.fulfilmentId, artifactHash: input.artifactHash, ref: anchored.ref, receipt: anchored.receipt, substrate:'loopback-sr2-fixture' };
        persist(session);
        return { status: 'accepted', reconciliationId: input.fulfilmentId };
      },
      reconcileDelivery: async (input) => {
        if(nativeDelivery){
          const report=deliveryReport(session,work.intake.settlementId);
          const binding=deliveryBinding(input.fulfilmentId);
          let answer;
          try{answer=await reconcileNativeDemDelivery(nativeDelivery,{...input,jobId:session.jobId,logicalAddress:deliverableAddress(session.jobId),report,
            receiptContentHash:sha256Hex(canonicalize(report)),deliveryBinding:binding});}
          catch(error){if(!isDeliverableMiss(error))throw error;answer={status:'absent',reason:String(error?.message??error).slice(0,180)};}
          // This seller submitted it and its CREATE is not on the chain: the wallet journal sends the kept bytes again,
          // and only its `unsigned` leaves the absence to the SDK (which then submits, through the same journal).
          if(answer.status==='absent'&&deliverableJournal&&(session.deliverySubmitted??[]).includes(input.fulfilmentId)){
            const asked=await askDeliverableJournal(session,work,input.fulfilmentId);
            if(asked.status!=='unsigned')return{status:'pending',reason:asked.reason};
            // The journal proved why nothing it signed can still land (superseded
            // under the nonce rule): keep that cause in the held outcome, while
            // the absence itself is unchanged and authorizes nothing by itself.
            if(asked.reason)answer={...answer,reason:asked.reason};
          }
          if(answer.status==='complete'){
            // A consumed permit can reconcile before the submission WAL is
            // visited. Restore its binding here too; resolution and receipt
            // verification below must still authenticate the actual CREATE.
            session.deliveryAdapter={fulfilmentId:input.fulfilmentId,deliveryBinding:binding,reconciliationId:answer.reconciliationId,substrate:'source-native-delivery-recovered-readonly'};
            persist(session);
          }
          return answer;
        }
        const record = await readDelivery(deliverableAddress(session.jobId),input.fulfilmentId);
        if (!record) return { status: 'absent', reason: 'canonical delivery address is empty' };
        if (!reportMatches(record.artifact, session, work.intake.settlementId)) return { status: 'indeterminate', reason: 'canonical delivery bytes differ' };
        return { status: 'complete', reconciliationId: input.reconciliationId ?? input.fulfilmentId, observedAt: record.receipt.blockRef.timestamp };
      },
      resolveDelivery: async ({ logicalAddress, jobId, phaseIndex, phase }) => {
        if (logicalAddress !== deliverableAddress(session.jobId) || jobId !== session.jobId || phaseIndex !== protocolSupport(listing).phases.delivery || phase !== 'deliver-storage-program') {
          return { status: 'rejected', reason: 'delivery read scope differs' };
        }
        const record = await readDelivery(logicalAddress,session.deliveryAdapter?.fulfilmentId);
        if (!record) return { status: 'indeterminate', reason: 'canonical delivery is absent' };
        if (!reportMatches(record.artifact, session, work.intake.settlementId)) return { status: 'rejected', reason: 'canonical delivery bytes differ' };
        return { status: 'verified', value: { artifact: { kind: phase, cleartextPayload: structuredClone(record.artifact), anchoredValue: structuredClone(record.artifact), access: { model: 'public' } }, anchorReceipt: structuredClone(record.receipt) } };
      },
      verifyAnchorReceipt: async ({ purpose, expectedWriter, ref, receipt }) => {
        if(nativeDelivery && purpose==='delivery' && expectedWriter.primaryClaim===claim){
          const fulfilmentId=session.deliveryAdapter?.fulfilmentId;
          if(!fulfilmentId)return{disposition:'indeterminate',reason:'native delivery fulfilment binding is unavailable'};
          const report=deliveryReport(session,work.intake.settlementId);
          const verdict=await verifyNativeDemDeliveryReceipt(nativeDelivery,{jobId:session.jobId,logicalAddress:ref.anchor.locator,report,receipt,receiptContentHash:ref.contentHash,deliveryBinding:deliveryBinding(fulfilmentId)});
          return{disposition:verdict==='valid'?'valid':verdict==='indeterminate'?'indeterminate':'invalid',...(verdict==='valid'?{}:{reason:'native delivery receipt authentication failed'})};
        }
        const valid = (purpose === 'delivery' || purpose === 'settlement-evidence') && expectedWriter.primaryClaim === claim &&
          verifyFixtureReceipt({ receipt, logicalAddress: ref.anchor.locator, hash: ref.contentHash, expectedWriter: claim }) === 'valid';
        return { disposition: valid ? 'valid' : 'invalid', ...(valid ? {} : { reason: 'fixture receipt authentication failed' }) };
      },
      verifyDeliverySchema: async ({ schemaUrl, cleartextPayload }) => {
        if (schemaUrl !== listing.offering.deliverable.schemaUrl || !reportMatches(cleartextPayload, session, work.intake.settlementId)) {
          return { disposition: 'invalid', reason: 'report schema/bindings differ' };
        }
        if (verifiedSchemaPayload === canonicalize(cleartextPayload)) return { disposition: 'valid' };
        const verdict = verifySchema ? await verifySchema({ schemaUrl, cleartextPayload: structuredClone(cleartextPayload) }) : { disposition: 'invalid' };
        if (verdict?.disposition === 'valid' && canonicalize(Object.keys(verdict).sort()) !== canonicalize(['disposition'])) return { disposition: 'indeterminate', reason: 'schema verifier returned a malformed disposition' };
        if (verdict?.disposition === 'valid') verifiedSchemaPayload = canonicalize(cleartextPayload);
        // Preserve unavailable/malformed verifier answers for the core's
        // retryable classification; only an explicit invalid verdict fails.
        return verdict;
      },
      evidenceSigner: { algorithm: 'ed25519', signer: claim, sign: (bytes) => sign(bytes) },
      auditSourceCommitmentSigner: { algorithm: 'ed25519', signer: claim, sign: (bytes) => sign(bytes) },
      verifyEvidenceSignature: verifySellerComponent,
      verifyAuditSourceCommitmentSignature: verifySellerComponent,
      anchorEvidence: async ({ evidence, evidenceHash }) => {
        const address = deliveryEvidenceAddress(session.jobId);
        if (contentHash(evidence) !== evidenceHash) return { status: 'rejected', reason: 'delivery evidence hash differs' };
        const anchored = await anchorOnce(address, evidence);
        return { status: 'anchored', ref: signedFixtureRef(address, evidenceHash), anchorReceipt: anchored.receipt };
      },
      resolveEvidence: async (ref) => {
        const read = await anchors.read(ref.anchor.locator);
        return read.status === 'present' && verifyFixtureRecord(read, { logicalAddress: ref.anchor.locator, expectedWriter: claim }) === 'valid' && contentHash(read.artifact) === ref.contentHash
          ? { status: 'verified', value: read.artifact } : { status: 'indeterminate', reason: 'delivery evidence is unavailable' };
      },
      nowMs: now,
    };
    const durability = {
      store: fulfilmentStore,
      workerId: 'source-demo-seller-fulfilment',
      leaseTtlMs: 60_000,
      leaseNowMs: now,
      reconcilePayloadAttestation: async () => ({ status: 'absent', reason: 'storage-program delivery has no payload attestation' }),
      reconcileDeliverySubmission: async (input) => {
        if (!await validCurrentFulfilmentFence(input.fence, session.jobId)) return { status: 'indeterminate', reason: 'delivery reconciliation fence is not current' };
        // The runner submits again only on an absence that is authoritative: this
        // seller never asked the capability for this fulfilment (a lost job lock
        // or a crash before it), or the reader proved nothing was signed. A name
        // index miss or an unavailable read is no proof (CORE §5.1): a CREATE
        // that landed would be made twice.
        if (nativeDelivery) {
          if (!(session.deliverySubmitted ?? []).includes(input.fulfilmentId)) return { status: 'absent', reason: 'this seller never submitted the Deliverable for this fulfilment' };
          const report = deliveryReport(session, work.intake.settlementId);
          let read;
          try { read = await readNativeDemDelivery(nativeDelivery, { jobId: session.jobId, logicalAddress: input.logicalAddress, report, receiptContentHash: sha256Hex(canonicalize(report)), deliveryBinding: deliveryBinding(input.fulfilmentId) }); }
          catch (error) {
            if (!isDeliverableMiss(error)) return { status: 'indeterminate', reason: `native delivery readback is unavailable: ${String(error?.message ?? error).slice(0, 180)}` };
            read = { status: 'absent' };
          }
          if (isProvenUnsignedAbsence(read)) return { status: 'absent', reason: read.reason ?? 'the reader proved the Deliverable CREATE was never signed' };
          if (read?.status === 'absent' && deliverableJournal) {
            const asked = await askDeliverableJournal(session, work, input.fulfilmentId);
            return asked.status === 'unsigned' ? { status: 'absent', reason: asked.reason ?? 'the wallet journal keeps no signed Deliverable CREATE that can still land' } : { status: 'indeterminate', reason: asked.reason };
          }
          if (read?.status !== 'present') return { status: 'indeterminate', reason: `a submitted Deliverable CREATE did not read back: ${read?.reason ?? read?.status ?? 'missing'}` };
          if (!reportMatches(read.artifact, session, work.intake.settlementId)) return { status: 'indeterminate', reason: 'canonical delivery bytes differ' };
          // Older intents may lack the adapter checkpoint. Restore it from the
          // authenticated read before the runner resolves delivery in this call.
          session.deliveryAdapter = { fulfilmentId: input.fulfilmentId, deliveryBinding: deliveryBinding(input.fulfilmentId),
            reconciliationId: read.receipt.transactionRef.value, substrate: 'source-native-delivery-recovered-readonly' };
          persist(session);
          return { status: 'accepted', reconciliationId: read.receipt.transactionRef.value };
        }
        const record = await readDelivery(input.logicalAddress,input.fulfilmentId);
        if (!record) return { status: 'absent', reason: 'current fence registered canonical delivery absence' };
        if (!reportMatches(record.artifact, session, work.intake.settlementId)) return { status: 'indeterminate', reason: 'canonical delivery bytes differ' };
        return { status: 'accepted', reconciliationId: nativeDelivery ? record.receipt.transactionRef.value : input.fulfilmentId };
      },
      reconcileEvidencePublication: async (input) => {
        if (!await validCurrentFulfilmentFence(input.fence, session.jobId)) return { status: 'indeterminate', reason: 'evidence reconciliation fence is not current' };
        const read = await anchors.read(deliveryEvidenceAddress(session.jobId));
        if (read.status !== 'present') return { status: 'absent', reason: 'current fence registered evidence absence' };
        if (contentHash(read.artifact) !== input.evidenceHash || verifyFixtureRecord(read, { logicalAddress: deliveryEvidenceAddress(session.jobId), expectedWriter: claim }) !== 'valid') return { status: 'indeterminate', reason: 'delivery evidence readback differs' };
        return { status: 'anchored', ref: signedFixtureRef(deliveryEvidenceAddress(session.jobId), input.evidenceHash), anchorReceipt: read.receipt };
      },
      publishFinalSessionReceipt: async () => ({ status: 'indeterminate', reason: 'explicit SDK finaliser is not invoked by the delivery-ready endpoint' }),
      reconcileFinalSessionReceipt: async () => ({ status: 'absent', reason: 'current fence registered final-receipt absence' }),
    };
    const ready = await runDurableFulfilmentToDeliveryReady(request, deps, durability);
    if (ready.status !== 'delivery-ready') return { status: 'not-ready', reason: `${ready.result.decision}:${ready.result.code ?? 'unknown'}:${ready.result.reasons?.join('; ') ?? 'SDK delivery is not ready'}`, result: ready.result };
    return { status: 'delivery-ready', ready, auditSource, request };
  }

  async function submitPayment({ jobId, txHash, payerPayingKey, nativePaymentEvidence: requestedEvidence }) {
    assertSettlementChain();
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    assertRailPin(session.railPin, 'in-flight');
    if (requestedEvidence === NATIVE_PAYMENT_EVIDENCE || session.nativeEvidenceWork) {assertNativePaymentHandler();return submitNativePaymentEvidence({ session, jobId, txHash, payerPayingKey, requestedEvidence });}
    // The fixture intake below claims the transfer, then anchors through the
    // fixture substrate, which the native profile does not have.
    if (nativeProfile) throw new SellerAgentError('native_evidence_required', 'the native seller profile takes payment only as native payment evidence', 409);
    if (session.payment) {
      if (session.payment.txHash !== paymentTxHash(txHash)) throw new SellerAgentError('payment_already_recorded', 'this job already has a verified payment', 409);
      if(session.paymentWork?.payerPayingKey!==payerPayingKey)throw new SellerAgentError('seller_payment_work_conflict','retained payer differs',409);
      await commit({jobId});
      const intake=await verifySellerPaymentIntake({jobId,phaseIndex:agreementTerms(session.agreement).paymentPhaseIndex,railId:agreementTerms(session.agreement).rail,payerPayingKey,receipt:{kind:'pay-dem',txHash}},intakeDepsFor(jobId));
      if(intake.disposition!=='verified'||!['claim','already-claimed'].includes(intake.fulfilment)||intake.settlementId!==session.payment.settlementId)throw new SellerAgentError('payment_readback_required','retained fixture payment is not freshly authenticated',503);
      const observed=intake.settlementIdentity;
      const read=address=>readAdmissionCapability(anchors,'read',address);
      const paymentRecord=await read(session.payment.ref.anchor.locator),deliverable=await read(session.payment.deliverableRef.anchor.locator),evidenceRecord=await read(session.payment.deliveryRef.anchor.locator);
      const paymentCheck=await verifyPaymentEvidence({agreement:session.agreement,record:paymentRecord,observed}),deliveryCheck=await verifyDelivery({agreement:session.agreement,deliverable,evidenceRecord});
      if(paymentCheck.status!=='verified'||deliveryCheck.status!=='verified'||contentHash(paymentRecord.artifact)!==session.payment.ref.contentHash||contentHash(deliverable.artifact)!==session.payment.deliverableRef.contentHash||contentHash(evidenceRecord.artifact)!==session.payment.deliveryRef.contentHash)throw new SellerAgentError('payment_readback_required','retained fixture artifacts changed',503);
      return publicPayment(session);
    }
    if (!session.commitment) throw new SellerAgentError('not_committed', 'the Agreement is not committed; no payment is accepted before commitment');
    if (durable) await commit({ jobId }); // fresh authenticated commitment readback
    const terms = agreementTerms(session.agreement);
    if (session.paymentWork && (session.paymentWork.txHash !== paymentTxHash(txHash) || session.paymentWork.payerPayingKey !== payerPayingKey)) throw new SellerAgentError('seller_payment_work_conflict', 'a different verified claim is retained for this job', 503);
    // A retained intake is historical evidence. Reauthenticate the transfer
    // before resuming publication; the receipt store preserves its exact claim.
    const intake = await verifySellerPaymentIntake({ jobId, phaseIndex: terms.paymentPhaseIndex, railId: terms.rail, payerPayingKey, receipt: { kind: 'pay-dem', txHash } }, intakeDepsFor(jobId));
    if ([...settlementJobs].some(([id,claims]) => claims.has(jobId) && !hasSettlementCredit(id,jobId))) return { status: 'indeterminate', reason: 'settlement-collision' };
    if (intake.disposition !== 'verified' || (intake.fulfilment !== 'claim' && intake.fulfilment !== 'already-claimed')) {
      return { status: intake.disposition === 'indeterminate' ? 'indeterminate' : 'rejected', reason: intake.reason };
    }
    if (!bindSettlement(intake.settlementId, jobId)) return { status: 'indeterminate', reason: 'settlement-collision' };
    if (!session.paymentWork) {
      session.paymentWork = { txHash: paymentTxHash(txHash), payerPayingKey, intake: JSON.parse(JSON.stringify(intake)), deliveredAt: now() };
      persist(session);
    }
    const evidence = await signEvidence(structuredClone(intake.evidenceInput));
    if (contentHash(evidence) !== intake.evidenceHash) throw new SellerAgentError('evidence_hash_mismatch', 'signed evidence does not hash to the SDK evidence hash', 500);
    const address = paymentEvidenceAddress(jobId, terms.rail, terms.paymentPhaseIndex);
    const paymentAnchor = await anchorOnce(address, evidence);
    // Deterministic delivery, then delivery evidence over its exact JCS bytes.
    const report = deliveryReport(session, intake.settlementId);
    const deliverableAnchor = await anchorOnce(deliverableAddress(jobId), report);
    const deliveredAt = session.paymentWork?.deliveredAt ?? now();
    const deliveryEvidence = await signEvidence({
      evidenceVersion: '1',
      jobId,
      phase: 'deliver-storage-program',
      outcome: 'success',
      deliverableContentHash: sha256Hex(canonicalize(report)),
      deliverableAnchor: { kind: 'storage-program', locator: deliverableAddress(jobId) },
      observedAt: deliveredAt,
    });
    const selfCheck = await verifySettlementEvidence(deliveryEvidence, {
      orchestrator: claim,
      agreement: { amount: terms.price.amount, currency: terms.price.currency },
      attestationRef: fixtureRef(deliveryEvidenceAddress(jobId), contentHash(deliveryEvidence)),
      result: { ok: true },
      expectedAnchorLocator: deliverableAddress(jobId),
    }, ed25519Deps);
    if (selfCheck.decision !== 'pass') throw new SellerAgentError('delivery_evidence_invalid', selfCheck.reasons.join('; '), 500);
    const deliveryAnchor = await anchorOnce(deliveryEvidenceAddress(jobId), deliveryEvidence);
    session.payment = {
      txHash: intake.settlementIdentity.txHash.toLowerCase(),
      blockNumber: intake.settlementIdentity.blockNumber,
      settlementId: intake.settlementId,
      permitId: intake.permitId,
      ref: paymentAnchor.ref,
      deliveryRef: deliveryAnchor.ref,
      deliverableRef: deliverableAnchor.ref,
      deliveredAt,
    };
    session.stage = 'delivered';
    persist(session);
    return publicPayment(session);
  }

  function publicPayment(session) {
    assertSettlementCredit(session.jobId);
    const p = session.payment;
    return { status: 'delivered', settlementId: p.settlementId, evidenceAddress: p.ref.anchor.locator, deliverableAddress: p.deliverableRef.anchor.locator, deliveryEvidenceAddress: p.deliveryRef.anchor.locator };
  }

  const sameNativeEvidenceProjection=(left,right)=>JSON.stringify(left?.content)===JSON.stringify(right?.content)&&canonicalize(left)===canonicalize(right);
  function retainedNativeEvidenceProjection(work) {
    if (typeof work.publicSignedProjectionJson === 'string') {
      try {
        const parsed = JSON.parse(work.publicSignedProjectionJson);
        if (JSON.stringify(parsed) === work.publicSignedProjectionJson) return parsed;
      } catch { /* malformed retained projection stays unavailable */ }
      return null;
    }
    return work.publicSignedProjection ?? null;
  }

  function nativeEvidenceResponse(work, delivery) {
    assertSettlementCredit(work.intake.jobId);
    return { status: 'payment-evidenced', settlementId: work.intake.settlementId, evidenceAddress: work.address,
      evidenceHash: work.intake.evidenceHash, anchorReceipt: work.nativeReceipt, signedProjection: retainedNativeEvidenceProjection(work),
      anchorAttempt: work.anchorAttempt, anchorAttempts: work.anchorAttempts, finality: 'one-node-fixture-view-not-independent', delivery };
  }

  // Reduce a retained native-evidence checkpoint only from independently
  // authenticated, read-only authorities. In particular, this reduction never
  // calls anchorEvidence (only submitNativePaymentEvidence sends it again,
  // after an attempt that cannot have written it) and neither an old HTTP response nor the signed seller
  // snapshot is treated as a receipt/public projection.
  async function reduceNativeEvidenceWork(session, work, { jobId, txHash, payerPayingKey }) {
    const terms = agreementTerms(session.agreement), hash = paymentTxHash(txHash), intake = work?.intake;
    const held = (reason, disposition = 'indeterminate') => ({ disposition, reason });
    if (!work || session.jobId !== jobId || hash !== work.txHash || payerPayingKey !== work.payerPayingKey ||
        payerPayingKey !== session.buyerBundle.presentedBy || payerPayingKey !== terms.buyer ||
        work.agreementHash !== contentHash(session.agreement) || work.commitmentHash !== contentHash(session.commitment?.record) ||
        canonicalize(work.listingPin) !== canonicalize(pin) ||
        work.address !== paymentEvidenceAddress(jobId, terms.rail, terms.paymentPhaseIndex) ||
        intake?.settlementIdentity?.txHash?.toLowerCase() !== hash || intake?.evidenceHash !== contentHash(work.evidence) ||
        durable.settlementJob(intake?.settlementId) !== jobId) return held('seller_native_evidence_checkpoint_mismatch');
    const check = await checkNativePaymentEvidence({ artifact: work.evidence, agreement: session.agreement, writer: claim,
      txHash: hash, blockNumber: intake.settlementIdentity.blockNumber });
    if (check.decision !== 'pass') return held('seller_native_evidence_artifact_mismatch', 'rejected');
    const { disposition, fulfilment, reason, permitId, ...authorization } = intake;
    let permit;
    try { permit = await receiptStore.inspectPermit(permitId); }
    catch { return held('seller_native_evidence_permit_unavailable'); }
    if (!['available', 'already-consumed'].includes(permit.status) || permit.claim?.jobId !== jobId ||
        canonicalize(permit.claim?.authorization) !== canonicalize(authorization)) return held('seller_native_evidence_permit_mismatch', 'rejected');
    // demosEvidence.signedTransaction is canonical proof text, not a lossless
    // reconstruction of the JSON.stringify-ordered wallet signing bytes. Only
    // the exact retained public projection may be supplied as a fallback; an
    // earlier checkpoint recovers it from the wallet journal that kept the
    // signed CREATE (or readEvidence's own reader, which comes first). Either
    // way the readback authenticates the bytes against the chain.
    const retainedProjection = retainedNativeEvidenceProjection(work);
    let projection = retainedProjection;
    if (!projection && typeof work.publicSignedProjectionJson !== 'string' && walletJournal) {
      try { projection = await walletJournal.readSignedProjection({ logicalAddress: work.address }); }
      catch { projection = null; }
    }
    const read = await nativeEvidence.readEvidence({ agreement: session.agreement, writer: claim, txHash: hash,
      blockNumber: intake.settlementIdentity.blockNumber, committedAt: session.commitment.committedAt, retainedReceipt:work.nativeReceipt,
      ...(projection ? { signedProjection: projection } : {}) });
    if (read.disposition !== 'present') return read;
    if (contentHash(read.artifact) !== intake.evidenceHash || canonicalize(read.artifact) !== canonicalize(work.evidence)) return held('seller_native_evidence_artifact_readback_mismatch', 'rejected');
    if (work.nativeReceipt && !sameNativeDeliveryReceipt(work.nativeReceipt, read.receipt)) return held('seller_native_evidence_receipt_readback_mismatch', 'rejected');
    if (work.publicSignedProjection && !sameNativeEvidenceProjection(work.publicSignedProjection,read.signedProjection)) return held('seller_native_evidence_projection_readback_mismatch', 'rejected');
    if (work.publicSignedProjectionJson && (!retainedProjection || !sameNativeEvidenceProjection(retainedProjection,read.signedProjection))) return held('seller_native_evidence_projection_bytes_mismatch', 'rejected');
    // A fresh native observation may carry new observer timestamps/proofs even
    // though it authenticated the same immutable CREATE. Preserve the exact
    // receipt/projection bytes already recorded in the SDK phase result; after
    // stable identity and signed-projection checks above, those are the only
    // bytes that can resume the existing phase without rewriting its history.
    const authenticatedReceipt = work.nativeReceipt ? structuredClone(work.nativeReceipt) : structuredClone(read.receipt);
    const authenticatedProjection = retainedProjection ? structuredClone(retainedProjection) : structuredClone(read.signedProjection);
    work.nativeReceipt ??= structuredClone(authenticatedReceipt);
    work.publicSignedProjection ??= structuredClone(authenticatedProjection);
    work.publicSignedProjectionJson ??= JSON.stringify(authenticatedProjection);
    session.stage = session.deliveryReady ? session.stage : 'native-payment-evidenced';
    persist(session);
    return { ...read, receipt: authenticatedReceipt, signedProjection: authenticatedProjection };
  }

  async function advanceAuthenticatedNativeDelivery(session, work, read) {
    if (!deliveryContext) return nativeEvidenceResponse(work, 'held-missing-consumed-v2-fulfilment-and-Vet-audit');
    if (nativeDelivery && session.deliveryReady) return readPersistedNativeDelivery(session, work);
    if (session.deliveryHold?.result?.code === 'delivery-submission-ambiguous') {
      const recovered = await recoverNativeSdkDelivery(session, work);
      if (recovered) return recovered;
    }
    const recovery = await recoverNativeDeliveryBinding(session, work);
    if (recovery.status === 'held') {
      session.deliveryHold = { reason: recovery.reason, ...(session.deliveryHold?.result ? { result: session.deliveryHold.result } : {}) };
      persist(session);
      return nativeEvidenceResponse(work, { status: 'held', reason: recovery.reason });
    }
    const delivery = await runSdkDeliveryReady(session, work, read);
    if (delivery.status !== 'delivery-ready') {
      session.deliveryHold = { reason: delivery.reason, ...(delivery.result ? { result: structuredClone(delivery.result) } : {}) };
      persist(session);
      if (nativeDelivery && delivery.result?.code === 'delivery-submission-ambiguous' &&
          delivery.result.safeToRetryDelivery === false && delivery.result.recovery?.action === 'reconcile-delivery') {
        throw new SellerAgentError('native_delivery_reconciliation_required', 'the original Deliverable CREATE outcome requires authenticated read-only reconciliation', 503);
      }
      return nativeEvidenceResponse(work, { status: 'held', reason: delivery.reason });
    }
    const result = delivery.ready.result, deliveredHash = sha256Hex(canonicalize(result.artifact.anchoredValue));
    session.deliveryReady = { fulfilmentId: result.fulfilmentId, logicalAddress: result.logicalAddress, contentHash: deliveredHash,
      anchorReceipt: structuredClone(result.anchorReceipt), evidenceHash: result.evidenceHash, ...(deliveryEvidenceEnabled?{evidence:structuredClone(result.evidence)}:{}), paymentPermitId: work.intake.permitId,
      finalisation: structuredClone(delivery.ready.finalisation), auditSource: structuredClone(delivery.auditSource),
      ...(nativeDelivery ? { deliveryBinding: nativeDeliveryBinding(session, work, result.fulfilmentId), substrate: 'source-native-one-node-delivery' } : { substrate: 'loopback-sr2-fixture' }) };
    session.stage = 'delivery-ready';
    persist(session);
    return finishDeliveryEvidence(session, work, { status: 'delivery-ready', fulfilmentId: result.fulfilmentId, logicalAddress: result.logicalAddress,
      contentHash: deliveredHash, anchorReceipt: result.anchorReceipt, evidenceHash: result.evidenceHash,
      ...(nativeDelivery ? { deliveryBinding: nativeDeliveryBinding(session, work, result.fulfilmentId) } : {}),
      substrate: nativeDelivery ? nativeDeliverySubstrate : 'mixed-test-native-payment-plus-loopback-sr2-delivery', evidencePublication: 'deferred-to-explicit-sdk-finaliser' });
  }

  async function recoverNativeSdkDelivery(session, work) {
    const recovery = await recoverNativeDeliveryBinding(session, work);
    if (recovery.status === 'not-needed') return null;
    if (recovery.status === 'held') {
      session.deliveryHold = { reason: recovery.reason, ...(session.deliveryHold?.result ? { result: session.deliveryHold.result } : {}) };
      persist(session);
      return nativeEvidenceResponse(work, { status: 'held', reason: recovery.reason });
    }
    const delivery = await runSdkDeliveryReady(session, work, { receipt: work.nativeReceipt });
    if (delivery.status !== 'delivery-ready') {
      session.deliveryHold = { reason: delivery.reason, ...(delivery.result ? { result: structuredClone(delivery.result) } : {}) };
      persist(session);
      return nativeEvidenceResponse(work, { status: 'held', reason: delivery.reason });
    }
    const result = delivery.ready.result, deliveredHash = sha256Hex(canonicalize(result.artifact.anchoredValue));
    const binding = nativeDeliveryBinding(session, work, result.fulfilmentId);
    session.deliveryReady = { fulfilmentId: result.fulfilmentId, logicalAddress: result.logicalAddress, contentHash: deliveredHash,
      anchorReceipt: structuredClone(result.anchorReceipt), evidenceHash: result.evidenceHash, ...(deliveryEvidenceEnabled?{evidence:structuredClone(result.evidence)}:{}), paymentPermitId: work.intake.permitId,
      finalisation: structuredClone(delivery.ready.finalisation), auditSource: structuredClone(delivery.auditSource),
      deliveryBinding: binding, substrate: 'source-native-one-node-delivery' };
    session.stage = 'delivery-ready';
    persist(session);
    return finishDeliveryEvidence(session, work, { status: 'delivery-ready', fulfilmentId: result.fulfilmentId, logicalAddress: result.logicalAddress,
      contentHash: deliveredHash, anchorReceipt: result.anchorReceipt, evidenceHash: result.evidenceHash, deliveryBinding: binding,
      substrate: nativeDeliverySubstrate, evidencePublication: 'deferred-to-explicit-sdk-finaliser' });
  }

  async function readPersistedNativeDelivery(session, work) {
    const ready = session.deliveryReady, report = deliveryReport(session, work.intake.settlementId);
    const binding = nativeDeliveryBinding(session, work, ready.fulfilmentId);
    const reread = await readNativeDemDelivery(nativeDelivery, { jobId: session.jobId, logicalAddress: ready.logicalAddress, report,
      receiptContentHash: sha256Hex(canonicalize(report)), deliveryBinding: binding });
    const valid = reread.status === 'present' && reread.artifact && canonicalize(reread.artifact) === canonicalize(report) && ready.paymentPermitId === work.intake.permitId && ready.contentHash === sha256Hex(canonicalize(report)) &&
      canonicalize(ready.deliveryBinding) === canonicalize(binding) && sameNativeDeliveryReceipt(reread.receipt, ready.anchorReceipt) &&
      await verifyNativeDemDeliveryReceipt(nativeDelivery, {jobId:session.jobId,logicalAddress:ready.logicalAddress,report,receipt:reread.receipt,receiptContentHash:ready.contentHash,deliveryBinding:binding,signedProjection:reread.signedProjection}) === 'valid';
    if (!valid) return nativeEvidenceResponse(work, { status: 'held', reason: reread.reason ?? 'persisted SDK delivery-ready result did not authenticate on fresh native read' });
    return finishDeliveryEvidence(session, work, { status: 'delivery-ready', fulfilmentId: ready.fulfilmentId, logicalAddress: ready.logicalAddress,
      contentHash: ready.contentHash, anchorReceipt: reread.receipt, evidenceHash: ready.evidenceHash, deliveryBinding: binding,
      substrate: nativeDeliverySubstrate, evidencePublication: 'deferred-to-explicit-sdk-finaliser' });
  }

  async function finishDeliveryEvidence(session, work, pointer) {
    if(!deliveryEvidenceEnabled&&!session.deliveryEvidenceWork)return nativeEvidenceResponse(work,pointer);
    const ready=session.deliveryReady,report=deliveryReport(session,work.intake.settlementId),address=deliveryEvidenceAddress(session.jobId),evidence=ready.evidence;
    const held=(reason)=>nativeEvidenceResponse(work,{...pointer,evidencePublication:'held-readback-only',reason});
    if(!isNativeDeliveryEvidence(evidence,claim,address)||contentHash(evidence)!==ready.evidenceHash||evidence.deliverableContentHash!==sha256Hex(canonicalize(report)))return held('retained delivery evidence differs from the verified Deliverable');
    const check=await verifySettlementEvidence(evidence,{orchestrator:claim,agreement:{amount:agreementTerms(session.agreement).price.amount,currency:'DEM'},attestationRef:signedFixtureRef(address,ready.evidenceHash),result:{ok:true},expectedAnchorLocator:deliverableAddress(session.jobId)},ed25519Deps);
    if(check.decision!=='pass')return held('delivery evidence verifier refused the retained evidence');
    // No-resend: the artifact anchor journals its CREATE intent before it asks
    // the wallet. A retained intent (sent, lost, denied or unknown) is only
    // ever read back. 'absent' means this seller never reached the wallet for
    // this address (for example the intent write itself failed), so the
    // write is published again; publish() re-checks the journal under the
    // wallet lock and falls back to readback if an intent appeared meanwhile.
    let read;
    try{
      if(!session.deliveryEvidenceWork){
        session.deliveryEvidenceWork={address,evidenceHash:ready.evidenceHash};persist(session);
        read=await nativeArtifactAnchor.publish({logicalAddress:address,artifact:evidence,artifactKind:'SettlementEvidence',authorize:heldFor(session.jobId)});
      }else{
        if(session.deliveryEvidenceWork.address!==address||session.deliveryEvidenceWork.evidenceHash!==ready.evidenceHash)return held('retained delivery evidence work differs from the verified Deliverable');
        read=await nativeArtifactAnchor.readRetained({logicalAddress:address,artifactKind:'SettlementEvidence'});
        if(read?.status==='absent'&&deliveryEvidenceEnabled)read=await nativeArtifactAnchor.publish({logicalAddress:address,artifact:evidence,artifactKind:'SettlementEvidence',authorize:heldFor(session.jobId)});
      }
    }catch(error){return held(String(error.message).slice(0,240));}
    if(read?.status!=='present')return held(read?.reason??'original delivery evidence CREATE requires authenticated readback; no resend');
    if(session.deliveryEvidenceWork.address!==address||session.deliveryEvidenceWork.evidenceHash!==ready.evidenceHash||canonicalize(read.artifact)!==canonicalize(evidence)
      ||await nativeArtifactAnchor.verifyReceipt({logicalAddress:address,artifact:evidence,artifactKind:'SettlementEvidence',receipt:read.receipt,signedProjection:read.signedProjection})!=='valid')return held('delivery evidence readback differs');
    const retained=session.deliveryEvidenceWork.receipt;
    if(retained&&(!sameNativeDeliveryReceipt(retained,read.receipt)||await nativeArtifactAnchor.verifyReceipt({logicalAddress:address,artifact:evidence,artifactKind:'SettlementEvidence',receipt:retained,signedProjection:read.signedProjection})!=='valid'))return held('retained delivery evidence receipt differs');
    session.deliveryEvidenceWork.receipt??=structuredClone(read.receipt);
    session.stage='delivered';persist(session);
    return nativeEvidenceResponse(work,{...pointer,status:'delivered',evidencePublication:'native-read-back',evidenceRef:signedFixtureRef(address,ready.evidenceHash),evidenceReceipt:session.deliveryEvidenceWork.receipt});
  }

  // Everything before the durable work checkpoint is free of external effects:
  // the commitment is only read back, and the SDK permit claim, settlement
  // binding and evidence signature are local and replay-idempotent for this
  // exact job/payment. A failure here is a no-effect transport answer; after
  // verified intake it remains indeterminate so the buyer retries the paid order.
  // Thrown,
  // it would leave the authenticated transport fenced as uncertain with no
  // retained work for its read-only reconciliation to reduce, so the paid
  // order could never be delivered. A durable checkpoint keeps throwing.
  async function startNativePaymentEvidence({ session, jobId, hash, payerPayingKey }) {
    let step = 'commitment-readback', paymentVerified = false;
    try {
      await commit({ jobId }, { readbackOnly: true });
      const terms = agreementTerms(session.agreement);
      step = 'payment-intake';
      const intake = await verifySellerPaymentIntake({ jobId, phaseIndex: terms.paymentPhaseIndex, railId: terms.rail, payerPayingKey, receipt: { kind: 'pay-dem', txHash: hash } }, { ...intakeDepsFor(jobId), observeDemosTransfer: nativeEvidence.observeDemosTransfer });
      if ([...settlementJobs].some(([id,claims]) => claims.has(jobId) && !hasSettlementCredit(id,jobId))) return { answer: { status: 'indeterminate', reason: 'settlement-collision' } };
      if (intake.disposition !== 'verified' || !['claim', 'already-claimed'].includes(intake.fulfilment)) return { answer: { status: intake.disposition === 'indeterminate' ? 'indeterminate' : 'rejected', reason: intake.reason } };
      paymentVerified = true;
      step = 'settlement-binding';
      if (!bindSettlement(intake.settlementId, jobId)) return { answer: { status: 'indeterminate', reason: 'settlement-collision' } };
      step = 'evidence-signing';
      const evidence = await signEvidence(structuredClone(intake.evidenceInput));
      if (contentHash(evidence) !== intake.evidenceHash) throw new SellerAgentError('evidence_hash_mismatch', 'SDK signed evidence hash differs', 500);
      step = 'evidence-check';
      const check = await checkNativePaymentEvidence({ artifact: evidence, agreement: session.agreement, writer: claim, txHash: hash, blockNumber: intake.settlementIdentity.blockNumber });
      if (check.decision !== 'pass') throw new SellerAgentError('native_evidence_invalid', check.reasons.join('; '));
      step = 'work-checkpoint';
      const work = session.nativeEvidenceWork = { txHash: hash, payerPayingKey, agreementHash: contentHash(session.agreement), commitmentHash: contentHash(session.commitment.record),
        listingPin: pin, intake: JSON.parse(JSON.stringify(intake)), evidence, address: paymentEvidenceAddress(jobId, terms.rail, terms.paymentPhaseIndex),
        anchorAttempt: 'readback-first-retry', anchorAttempts: 0, anchorOutcome: 'not-sent' };
      session.stage = 'native-payment-evidence-held'; persist(session);
      return { work };
    } catch (error) {
      if (durable.loadSession(jobId)?.nativeEvidenceWork) throw error;
      delete session.nativeEvidenceWork;
      const cause = typeof error?.code === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(error.code) ? error.code : 'unclassified';
      return { answer: { status: paymentVerified || step === 'commitment-readback' || error?.status === 503 ? 'indeterminate' : 'rejected', reason: 'seller_native_evidence_not_started', step, cause } };
    }
  }

  // One call of the wallet journal's anchor with the exact retained evidence,
  // under the job lock and settlement credit, its attempt kept before the call
  // as `anchorOutcome: 'unknown'`. Any answer makes it 'sent' (no answer of the
  // anchor proves that nothing was signed: only the journal's reconciliation
  // can). A caught throw with no projection in that journal is a proven
  // pre-signing failure; a crash or an unreadable journal stays 'unknown'.
  async function anchorNativePaymentEvidence(session, work) {
    durable.assertHeld(session.jobId);assertSettlementCredit(session.jobId);
    work.anchorAttempts = (work.anchorAttempts ?? 1) + 1;
    work.anchorOutcome = 'unknown';
    // The journal this attempt goes through: only it may later answer for it.
    // An earlier attempt's answer is not this one's.
    work.walletJournal = walletJournal.journalId;
    delete work.anchorAnswer;
    persist(session);
    try {
      const answer = await nativeEvidence.anchorEvidence({ logicalAddress: work.address, artifact: structuredClone(work.evidence), writer: claim, artifactKind: 'SettlementEvidence', jobId: session.jobId, receiptContentHash: work.intake.evidenceHash });
      work.anchorAnswer = walletAnswer(answer);
      work.anchorOutcome = 'sent';
      delete work.anchorError;
    } catch (error) {
      work.anchorError = { code: error.code ?? 'unknown', message: String(error.message).slice(0, 240) };
      // This exact journal keeps every CREATE before broadcast. A caught
      // failure with explicitly no retained projection reached no send.
      try { if (await walletJournal.readSignedProjection({ logicalAddress: work.address }) === null) work.anchorOutcome = 'failed-before-signing'; } catch { /* unknown stays fenced */ }
    }
    persist(session);
  }

  // DACS-4 PC-7(b): the anchor retry is idempotent on the payment address. An
  // attempt that was sent or whose outcome is unknown (or a retained 'refused'
  // of an earlier version), and that does not read back, is resolved only by
  // the wallet that holds its signed transaction: `reconcilePaymentEvidence`
  // answers from the wallet's own journal for this exact evidence (the agent
  // takes it only from one createPaymentEvidenceWalletJournal, with that
  // journal's anchor). Only { status: 'unsigned' } (it holds no transaction it
  // signed for this address that is or can still be included) lets the same
  // bytes be sent again; { status: 'rebroadcast' | 'pending', txHash } (the one signed
  // transaction was sent again, or is still pending) keeps the readback
  // waiting. Any other answer or a throw keeps the claim held, with its cause.
  async function reconcileNativePaymentEvidence(session, work) {
    durable.assertHeld(session.jobId);assertSettlementCredit(session.jobId);
    // A lost or replaced journal file is another journal: it keeps nothing of
    // this attempt, so its `unsigned` would sign a second CREATE. Not asked.
    if (typeof work.walletJournal !== 'string' || work.walletJournal.length===0 || work.walletJournal !== walletJournal.journalId) {
      work.reconcileError = { code: 'wallet_journal_changed', message: 'the wallet journal that kept this anchor attempt is not the configured one; restore its file to resolve the attempt' };
      persist(session);
      return;
    }
    let answer;
    try {
      answer = await reconcilePaymentEvidence({ logicalAddress: work.address, artifact: structuredClone(work.evidence), writer: claim, artifactKind: 'SettlementEvidence', jobId: session.jobId,
        receiptContentHash: work.intake.evidenceHash, attempt: { outcome: work.anchorOutcome, answer: structuredClone(work.anchorAnswer ?? null) } });
    } catch (error) {
      work.reconcileError = { code: error.code ?? 'unknown', message: String(error.message).slice(0, 240) };
      persist(session);
      return;
    }
    work.reconcileAnswer = walletAnswer(answer);
    delete work.reconcileError;
    // 'unsigned' about a sent attempt names the transaction it superseded:
    // the one the anchor answered. Any other is not about this attempt.
    const sent = work.anchorAnswer?.txHash;
    if (answer?.status === 'unsigned' && sent !== undefined && answer.txHash !== sent) {
      work.reconcileError = { code: 'wallet_journal_answer_mismatch', message: 'the wallet journal answered unsigned for a transaction other than the one this attempt sent' };
    } else if (answer?.status === 'unsigned') work.anchorOutcome = 'unsigned';
    persist(session);
  }

  // Separate from the historical fixture receipt/delivery publisher. Genuine
  // SDK SettlementEvidence is preserved byte-for-byte; no artifactType is
  // invented to satisfy a wallet bridge. Retain an issued attempt BEFORE the
  // wallet boundary. Every later call or restart reads back first. DACS-4
  // PC-7(b), write-once: the anchor is sent again with the same bytes only
  // when no attempt can have written it, that is when the last attempt never
  // ran (a crash after the checkpoint, 'not-sent') or the wallet's journal
  // answered that nothing it signed can land ('unsigned'), and the readback
  // finds nothing; at most once per
  // call and never in the call of the first attempt. A name-index miss is no
  // proof of absence (CORE §5.1): after an attempt that was sent or whose
  // outcome is unknown (a throw, a crash during the call), nothing is sent
  // again unless reconcilePaymentEvidence answers 'unsigned'; otherwise the
  // readback is waited for, so a write that landed but is not indexed yet is
  // never created twice. An unknown readback sends nothing and asks nothing.
  // Once a readback authenticated it (work.nativeReceipt), it is never sent again.
  // Once the work is retained, it alone decides what a retry may send, so a
  // readback that fails (a node or index outage) answers held with its cause
  // instead of throwing: the claim stays a retry, never an uncertain effect
  // with no way on (seller-http.mjs). A settlement collision still refuses.
  async function submitNativePaymentEvidence({ session, jobId, txHash, payerPayingKey, requestedEvidence }) {
    if (!nativeEvidence || requestedEvidence !== NATIVE_PAYMENT_EVIDENCE) throw new SellerAgentError('native_evidence_held', 'the explicit native evidence capability/terms are absent');
    if (!session.commitment || !session.agreementAnchor) throw new SellerAgentError('not_committed', 'native Agreement and seller commitment must be retained');
    const hash = paymentTxHash(txHash);
    let work = session.nativeEvidenceWork, retry = false;
    if (work) {
      if (work.txHash !== hash || work.payerPayingKey !== payerPayingKey || work.agreementHash !== contentHash(session.agreement)
          || work.commitmentHash !== contentHash(session.commitment.record)) throw new SellerAgentError('seller_native_evidence_conflict', 'the retained exact payment/Agreement/commitment cannot change', 409);
      try { await commit({ jobId }, { readbackOnly: true }); }
      catch (error) {
        if (error instanceof SellerAgentError && !RETAINED_READBACK_FAILURES.has(error.code)) throw error;
        return heldNativeEvidence(work, { disposition: 'indeterminate', reason: `seller-commitment-readback-unavailable: ${String(error?.message ?? error).slice(0, 200)}`,
          code: typeof error?.code === 'string' ? error.code : 'unclassified' });
      }
      retry = !work.nativeReceipt;
    } else {
      const started = await startNativePaymentEvidence({ session, jobId, hash, payerPayingKey });
      if (!started.work) return started.answer;
      work = started.work;
      await anchorNativePaymentEvidence(session, work);
    }
    // A retained delivery is not a shortcut: the payment evidence it rests on is
    // authenticated again below, and advanceAuthenticatedNativeDelivery then
    // reads the Deliverable back.
    let read = await reduceNativeEvidenceWork(session, work, { jobId, txHash: hash, payerPayingKey });
    // A complete miss only permits asking the owning journal; it grants no send.
    const noReadback=()=>read.disposition==='absent'||(read.disposition==='indeterminate'&&NATIVE_READ_MISSES.includes(read.nativeObservation));
    if(retry&&noReadback()&&work.anchorOutcome!=='not-sent'&&work.walletJournal!==walletJournal.journalId){await reconcileNativePaymentEvidence(session,work);return heldNativeEvidence(work,{disposition:'indeterminate',reason:'wallet_journal_changed'});}
    if (retry && noReadback() && reconcilePaymentEvidence && !UNSENT_ANCHOR_OUTCOMES.includes(work.anchorOutcome)) await reconcileNativePaymentEvidence(session, work);
    if (retry && noReadback() && UNSENT_ANCHOR_OUTCOMES.includes(work.anchorOutcome)) {
      await anchorNativePaymentEvidence(session, work);
      read = await reduceNativeEvidenceWork(session, work, { jobId, txHash: hash, payerPayingKey });
    }
    // An anchor that may have been written and is not read back yet is
    // pending, not absent: the index has not shown it.
    if (read.disposition === 'absent' && !UNSENT_ANCHOR_OUTCOMES.includes(work.anchorOutcome)) {
      read = { ...read, disposition: 'indeterminate', reason: `native-payment-evidence-anchor-${work.anchorOutcome === 'sent' ? 'sent' : 'outcome-unknown'}-not-read-back` };
    }
    if (read.disposition === 'present') return advanceAuthenticatedNativeDelivery(session, work, read);
    return heldNativeEvidence(work, read);
  }
  function heldNativeEvidence(work, read) {
    return { status: read.disposition === 'rejected' ? 'rejected' : 'held', reason: read.reason ?? 'native-evidence-readback-incomplete',
      ...(work.anchorError ? { anchorError: work.anchorError } : {}), ...(work.reconcileError ? { reconcileError: work.reconcileError } : {}),
      evidenceAddress: work.address, evidenceHash: work.intake.evidenceHash, intake: 'pinned-SDK-verified-on-owned-fixture', readback: read.disposition,
      ...(read.nativeReadStatus ? { nativeReadStatus:read.nativeReadStatus } : {}), ...(read.code ? { nativeReadCode:read.code } : {}), anchorAttempt: work.anchorAttempt, anchorAttempts: work.anchorAttempts,
      anchorOutcome: work.anchorOutcome ?? 'unknown',
      limits: 'fixture Listing admission/rail/commitment; SDK one-node included view, not independent finality; delivery/Vet/ST11/completion held' };
  }

  // ---- DACS-5: completed two-sided bundle ----
  // DACS-5 §10.3.1 ST-11 and CORE §5.1 SR2-9: a completed bundle is signed
  // only after every required record (both Vet records, the commitment, the
  // settlement evidence and the bundle copy itself) has a finalized receipt
  // and resolves independently. That finalizer is not wired here, so no
  // profile signs, countersigns or anchors a completed bundle.
  const refuseBundleFinalization = () => {
    throw new SellerAgentError('bundle_finalization_unavailable', 'the seller signs no completed DACS-5 bundle: the ST-11 finalizer (finalized, independently resolved Vet, commitment, settlement and bundle records) is not available', 503);
  };
  async function bundleRequest({ jobId }) {
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    if (!session.payment) throw new SellerAgentError('not_delivered', 'nothing was delivered for this job');
    refuseBundleFinalization();
  }

  async function countersign({ jobId }) {
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    refuseBundleFinalization();
  }

  async function confirmBuyerCopy({ jobId }) {
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    if (!session.sellerCopy) throw new SellerAgentError('no_seller_copy', 'the seller copy is not anchored');
    let record;
    try {
      record = await anchors.read(bundleAddress(jobId, 'buyer'));
    } catch (error) {
      throw new SellerAgentError('substrate_unavailable', `SR-2 read failed: ${error.message}`, 503);
    }
    const check = await verifyAnchoredCopy({ record, role: 'buyer', jobId, writer: session.buyerBundle.presentedBy, expectedHash: session.bundleHash, ownCopy: session.sellerCopy });
    if (check.status === 'verified') { session.stage = 'copies-exchanged'; persist(session); }
    return check;
  }

  async function reconcileTransport({ request, body, rawBody, readOnly = false }) {
    const held=(reason,cause)=>{const out={disposition:'indeterminate',reason};if(cause){out.causeCode=cause?.cause?.name==='TimeoutError'?'timeout':'reader';Object.defineProperty(out,'cause',{value:cause});}return out;};
    const same = (a, b) => canonicalize(a) === canonicalize(b);
    const session = sessions.get(request.jobId);
    const readAnchors={read:address=>readAdmissionCapability(anchors,'read',address)};
    // A proposal interrupted at any persistence boundary resumes through the
    // durable responder, whose authenticated checkpoints and signOnce govern
    // every signature/publication. The HTTP cache cannot seal an unfinished
    // proposal. Validate the exact authenticated request before resuming it.
    if (request.path === '/dacs/v1/agreements/proposals' && (!readOnly || (session && !session.transportIdentity))) {
      const identity = body.transportIdentity;
      if (request.method !== 'POST' || request.jobId !== identity?.jobId || request.seller !== claim ||
          request.buyer !== identity?.buyer || identity?.seller !== claim || request.buyer !== body.buyerIdentityBundle?.presentedBy ||
          request.agreementHash !== identity?.agreementHash || !same(request.listingPin, pin) ||
          sha256Hex(rawBody) !== request.bodyHash || !same(JSON.parse(Buffer.from(rawBody).toString('utf8')), body)) return held('seller_transport_context_mismatch');
      // Read only (an expired delegation) before the final proposal checkpoint:
      // a seller contribution already signed for exactly this proposal is
      // answered without signing or saving anything.
      if (readOnly) {
        if (!session.sellerContribution || session.sellerContributionProposalHash !== body.proposal?.proposalHash || session.buyerBundleHash !== identityBundleHash(body.buyerIdentityBundle)) return held('seller_proposal_state_incomplete');
        try {
          const agreement = await finalizeFixedPriceAgreementContributions(body.proposal.plan, [body.proposal.buyerContribution, session.sellerContribution], contributionVerifier);
          return contentHash(agreement) === request.agreementHash ? { disposition: 'present', value: { disposition: 'complete', contribution: session.sellerContribution } } : held('seller_proposal_state_incomplete');
        } catch (error) { return held(error.code ?? 'seller_proposal_indeterminate', error); }
      }
      const unsigned = () => { const retained=durable?.loadSession(request.jobId)??sessions.get(request.jobId);return !retained?.agreementSignatureKey&&!retained?.sellerContribution&&!retained?.commitment; };
      try {
        const answer = await receiveProposal(body);
        if(answer.disposition==='complete')return{disposition:'present',value:answer};
        if(['waiting','indeterminate'].includes(answer.disposition))return{disposition:'retry',value:answer};
        if(answer.disposition==='rejected'&&unsigned())return{disposition:'no-effect',value:answer};
        return held('seller_proposal_work_retained');
      } catch (error) {
        if(error instanceof SellerAgentError && SELLER_NO_EFFECT_ERRORS.has(error.code) && unsigned())return{disposition:'no-effect',value:{disposition:'rejected',reason:error.code,message:error.message}};
        return held(error.code ?? 'seller_proposal_indeterminate',error);
      }
    }
    if (!session?.transportIdentity || request.method !== 'POST' || request.jobId !== (body.transportIdentity?.jobId ?? body.jobId) ||
        request.seller !== claim || request.buyer !== session.buyerBundle.presentedBy || !same(request.listingPin, pin) ||
        request.agreementHash !== session.agreementHash || request.agreementHash !== session.transportIdentity.agreementHash ||
        sha256Hex(rawBody) !== request.bodyHash || !same(JSON.parse(Buffer.from(rawBody).toString('utf8')), body)) return held('seller_transport_context_mismatch');
    const present = (value) => ({ disposition: 'present', value });
    const json = (value) => JSON.parse(JSON.stringify(value));
    const refuse = () => { throw new SellerAgentError('seller_read_only_reconciliation', 'reconciliation cannot sign or submit', 503); };
    async function commitment() {
      const address = fixedPriceAgreementLogicalAddress(request.jobId);
      let agreementRecord, agreementRef = fixtureRef(address, request.agreementHash), native = null;
      if (agreementAnchor) {
        const projection=body.signedProjection??session.agreementSignedProjection;
        const read=await readBuyerAgreement(address,request.buyer,request.agreementHash,projection);
        if(contentHash(read.agreement)!==request.agreementHash)throw new SellerAgentError('agreement_substituted','authenticated Agreement differs',422,{cause:read});
        agreementRecord={artifact:read.agreement};agreementRef=read.ref;native=read.native;
      } else {
        agreementRecord = await readAnchors.read(address);
        if (verifyFixtureRecord(agreementRecord, { logicalAddress: address, expectedWriter: request.buyer }) !== 'valid' ||
            contentHash(agreementRecord.artifact) !== request.agreementHash) throw new SellerAgentError('seller_agreement_readback_required', 'exact authenticated Agreement is unavailable', 503);
      }
      const logicalAddress=finalityCommitmentAddress(request.jobId);
      const record = nativeArtifactAnchor
        ? await nativeArtifactAnchor.readRetained({logicalAddress,artifactKind:'FinalityCommitmentRecord',proofOfNoIntent:true,fresh:true})
        : await durable.readAnchor({ jobId: request.jobId, logicalAddress, anchors:readAnchors });
      if(nativeArtifactAnchor && record.status!=='present') refuse();
      const reader = commitmentReader(anchors, claim);
      const finalized = await commitFixedPriceAgreement({
        agreement: agreementRecord.artifact,
        verifiedListing: { disposition: 'verified', listing, pin },
        session: commitmentSession(agreementRecord.artifact),
        createdAt: session.commitCreatedAt ?? now(),
        commitmentSigner: { algorithm: 'ed25519', signer: claim, sign: refuse },
      }, {
        resolve: () => ({ disposition: 'present', anchored: { record: record.artifact, nativeAddress: record.receipt.nativeAddress, anchorTxRef: nativeArtifactAnchor?record.txRef:fixtureTxRef(record.receipt), anchorReceipt: record.receipt } }),
        verifyAnchorReceipt: nativeArtifactAnchor ? async(anchored)=>readAdmissionCapability(nativeArtifactAnchor,'verifyReceipt',{logicalAddress,artifact:anchored.record,artifactKind:'FinalityCommitmentRecord',receipt:anchored.anchorReceipt,signedProjection:record.signedProjection,fresh:true}) : reader.verifyAnchorReceipt,
        submit: refuse,
      }, commitmentVerifier);
      if (!finalized.resumed || finalized.recordKind !== 'finality') refuse();
      if (!session.commitment) {
        // Validate and retain the complete adoption on a detached session.
        // A conflicting or out-of-order phase must not partially mutate the
        // live in-memory session before recordPhase fails closed.
        const adopted = structuredClone(session);
        adopted.agreement = json(agreementRecord.artifact);
        adopted.agreementRef = json(agreementRef);
        if (native) adopted.agreementAnchor = json(nativeAgreementView(native));
        if (native && (body.signedProjection ?? adopted.agreementSignedProjection) !== undefined) adopted.agreementSignedProjection = json(body.signedProjection ?? adopted.agreementSignedProjection);
        adopted.commitment = json(finalized);
        adopted.stage = 'committed';
        retainCommitmentPhase(adopted, adopted.commitment);
        persist(adopted);
        Object.assign(session, adopted);
      } else if (contentHash(session.commitment.record) !== contentHash(finalized.record) ||
          (nativeArtifactAnchor && (session.commitment.logicalAddress !== finalized.logicalAddress ||
            canonicalize(session.commitment.anchorTxRef) !== canonicalize(finalized.anchorTxRef) ||
            !sameNativeCommitmentReceipt(session.commitment.anchorReceipt, finalized.anchorReceipt)))) refuse();
      return finalized;
    }
    async function payment() {
      await commitment();
      const work = session.paymentWork;
      if (!work) refuse();
      const intake = work.intake;
      const { disposition, fulfilment, reason, permitId, ...authorization } = intake;
      const permit = await receiptStore.inspectPermit(permitId); // read-only pinned SDK authority
      if (disposition !== 'verified' || !['claim', 'already-claimed'].includes(fulfilment) ||
          permit.status !== 'available' || !same(permit.claim.authorization, authorization) ||
          permit.claim.jobId !== request.jobId || durable.settlementJob(intake.settlementId) !== request.jobId) refuse();
      const terms = agreementTerms(session.agreement);
      const paymentRecord = await durable.readAnchor({ jobId: request.jobId, logicalAddress: paymentEvidenceAddress(request.jobId, terms.rail, terms.paymentPhaseIndex), anchors:readAnchors });
      const deliverable = await durable.readAnchor({ jobId: request.jobId, logicalAddress: deliverableAddress(request.jobId), anchors:readAnchors });
      const deliveryRecord = await durable.readAnchor({ jobId: request.jobId, logicalAddress: deliveryEvidenceAddress(request.jobId), anchors:readAnchors });
      const freshIntake=await verifySellerPaymentIntake({jobId:request.jobId,phaseIndex:terms.paymentPhaseIndex,railId:terms.rail,payerPayingKey:body.payerPayingKey,receipt:{kind:'pay-dem',txHash:body.txHash}},intakeDepsFor(request.jobId));
      if(freshIntake.disposition!=='verified'||freshIntake.settlementId!==intake.settlementId)refuse();
      const observed = { txHash: intake.settlementIdentity.txHash, blockNumber: intake.settlementIdentity.blockNumber };
      const evidence = await verifyPaymentEvidence({ agreement: session.agreement, record: paymentRecord, observed });
      const delivery = await verifyDelivery({ agreement: session.agreement, deliverable, evidenceRecord: deliveryRecord });
      if (evidence.status !== 'verified' || delivery.status !== 'verified' || contentHash(paymentRecord.artifact) !== intake.evidenceHash ||
          !same(deliverable.artifact, deliveryReport(session, intake.settlementId)) ||
          delivery.deliveredAt !== work.deliveredAt) refuse();
      const recovered = { txHash: observed.txHash.toLowerCase(), blockNumber: observed.blockNumber, settlementId: intake.settlementId, permitId,
        ref: evidence.ref, deliveryRef: delivery.evidenceRef, deliverableRef: delivery.deliverableRef, deliveredAt: work.deliveredAt };
      if (session.payment && !same(session.payment, recovered)) refuse();
      if (!session.payment) { session.payment = recovered; session.stage = 'delivered'; persist(session); }
      return publicPayment(session);
    }
    try {
      switch (request.path) {
        case '/dacs/v1/agreements/proposals': {
          if (!same(body.proposal, session.proposal) || !same(body.transportIdentity, session.transportIdentity) ||
              identityBundleHash(body.buyerIdentityBundle) !== session.buyerBundleHash || !session.sellerContribution) return held('seller_proposal_state_incomplete');
          const agreement = await finalizeFixedPriceAgreementContributions(session.proposal.plan, [session.proposal.buyerContribution, session.sellerContribution], contributionVerifier);
          if (contentHash(agreement) !== request.agreementHash) refuse();
          return present({ disposition: 'complete', contribution: session.sellerContribution });
        }
        case '/dacs/v1/agreements/state':
          return same(body.transportIdentity, session.transportIdentity) ? present(agreementState(body.transportIdentity)) : held('seller_transport_context_mismatch');
        case '/dacs/v1/commitments/signature':
          if (!body.agreement || !same(Object.keys(body).sort(), ['agreement', 'jobId', 'signedProjection'])) refuse();
          // Reconciliation never starts an attempt or reserves a buyer slot.
          if (!session.signatureCommitmentAttempt) return held('seller_signature_attempt_absent');
          return present(await commit({ jobId: request.jobId, signedProjection: body.signedProjection }, { readbackOnly: true, signatureAgreement: body.agreement }));
        case '/dacs/v1/commitments': {
          // The original authenticated command may have stopped before any
          // publication intent. Under the job fence, commit's anchor journal
          // permits that unsent work and only reads uncertain/retained sends.
          if (!readOnly) return present(await commit({ jobId: request.jobId, signedProjection: body.signedProjection }));
          const verified = await commitment();
          return present({ status: 'committed', address: verified.logicalAddress, resumed: true, ...(session.agreementAnchor ? { agreementAnchor: json(session.agreementAnchor) } : {}) });
        }
        case '/dacs/v1/payments': {
          if (session.nativeEvidenceWork || (nativeEvidence && body.nativePaymentEvidence === NATIVE_PAYMENT_EVIDENCE)) {
            const work = session.nativeEvidenceWork ?? null;
            if (body.nativePaymentEvidence !== NATIVE_PAYMENT_EVIDENCE || body.payerPayingKey !== request.buyer ||
                (work && (work.txHash !== paymentTxHash(body.txHash) || work.payerPayingKey !== request.buyer))) {
              return held('seller_native_delivery_context_mismatch');
            }
            // What the agent retained, not how an earlier request ended (a
            // thrown readback, a crash mid-request), decides what this claim
            // may do. With work retained, the same retained step as
            // submitPayment runs: it reads back first, and sends the anchor
            // again only on a proven absence (after a send, only on the wallet
            // journal's 'unsigned'), so it never sends twice. With none, the
            // claim ended before the work checkpoint, where nothing is sent and
            // every step is replay-idempotent (startNativePaymentEvidence), so
            // the same claim runs again from its start under submitPayment's
            // gates. An answer that is not final hands the effect back to the
            // ordinary retry (`retry`, seller-http.mjs). A run that kept no
            // work and answered `rejected` or `indeterminate` started nothing,
            // as on the ordinary path: `no-effect` releases the claim's slot,
            // so a corrected claim reaches payment intake.
            // Either run can sign and send: never under an expired delegation.
            if (readOnly) return held('peer_delegation_expired: a payment claim runs again only under a live session delegation');
            assertNativePaymentHandler();
            const answer = work
              ? await submitNativePaymentEvidence({ session, jobId: request.jobId, txHash: body.txHash, payerPayingKey: body.payerPayingKey, requestedEvidence: body.nativePaymentEvidence })
              : await submitPayment({ jobId: request.jobId, txHash: body.txHash, payerPayingKey: body.payerPayingKey, nativePaymentEvidence: body.nativePaymentEvidence });
            if (['delivery-ready','delivered'].includes(answer?.delivery?.status) && answer.delivery.evidencePublication !== 'held-readback-only') return present(answer);
            if (!work && !session.nativeEvidenceWork && ['rejected', 'indeterminate'].includes(answer?.status)) return { disposition: 'no-effect', value: answer };
            return !work || ['held', 'payment-evidenced'].includes(answer?.status) ? { disposition: 'retry', value: answer } : held(answer?.reason ?? 'seller_native_evidence_readback_required');
          }
          if (body.payerPayingKey !== request.buyer || (session.paymentWork &&
              (session.paymentWork.txHash !== paymentTxHash(body.txHash) || session.paymentWork.payerPayingKey !== request.buyer))) return held('seller_payment_context_mismatch');
          if (readOnly) return session.paymentWork ? present(await payment()) : held('seller_payment_context_mismatch');
          const answer = await submitPayment(body);
          if (['delivered','delivery-ready'].includes(answer?.status)) return present(answer);
          return { disposition: !session.paymentWork && ['rejected','indeterminate'].includes(answer?.status) ? 'no-effect' : 'retry', value: answer };
        }
        case '/dacs/v1/bundles/request':
        case '/dacs/v1/bundles/countersignature':
          return held('bundle_finalization_unavailable');
        case '/dacs/v1/bundles/buyer-copy': return held('bundle_finalization_unavailable');
        default: return held('seller_transport_reconciliation_unsupported');
      }
    } catch (error) { return held(error.code ?? 'seller_readback_indeterminate',error); }
  }

  // Seller-owned recovery seam, deliberately not an HTTP route. It resumes
  // only retained, previously verified work after every unknown anchor has
  // authenticated exact readback. Absence never authorizes resubmission, except
  // that the payment-evidence anchor is sent again when its readback proves
  // it absent (submitNativePaymentEvidence, DACS-4 PC-7(b)).
  async function resume({ jobId }) {
    const session = sessionFor(jobId);
    if(access&&readIssued&&buyerAccessClosed(session,jobId)){
      const unknown=await readIssued(jobId,{unknownOnly:true});
      if(unknown)return unknown;
    }
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    const reconciliation = await durable.reconcileJob(jobId, anchors);
    if (reconciliation.status === 'held') throw new SellerAgentError('seller_reconciliation_required', 'an anchor outcome remains unknown', 503);
    if (session.countersignatureWork && !session.sellerCopy) return countersign({ jobId, buyerSignature: session.countersignatureWork.buyerSignature });
    if (session.paymentWork && !session.payment) return submitPayment({ jobId, txHash: session.paymentWork.txHash, payerPayingKey: session.paymentWork.payerPayingKey });
    if (session.nativeEvidenceWork && (!session.deliveryReady || deliveryEvidenceEnabled)) return submitPayment({ jobId, txHash: session.nativeEvidenceWork.txHash,
      payerPayingKey: session.nativeEvidenceWork.payerPayingKey, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE });
    if (session.commitCreatedAt && !session.commitment) return commit({ jobId });
    return { status: 'retained', stage: session.stage };
  }

  const api = {
    assertSettlementCredit,
    claim,
    listingPin: pin,
    issueSessionChallenge,
    receiveProposal: recoveryCall(receiveProposal),
    agreementState,
    commit: recoveryCall(commit),
    // Reauthenticates cached transport answers without authorizing a new CREATE.
    readCommitment: recoveryCall(({jobId,signedProjection,signatureAgreement}) => commit({jobId,signedProjection}, {readbackOnly:true,signatureAgreement})),
    commitOnSignature: recoveryCall((input) => {
      if (!input || canonicalize(Object.keys(input).sort()) !== canonicalize(['agreement', 'jobId', 'signedProjection']) || !input.agreement || typeof input.agreement !== 'object') throw new SellerAgentError('signature_agreement_invalid', 'expected exactly jobId, Agreement and signedProjection');
      return commit({ jobId: input.jobId, signedProjection: input.signedProjection }, { signatureAgreement: input.agreement });
    }),
    submitPayment: recoveryCall(submitPayment),
    bundleRequest: recoveryCall(bundleRequest),
    countersign: recoveryCall(countersign),
    confirmBuyerCopy: recoveryCall(confirmBuyerCopy),
    transportAgreementOf: (jobId) => {
      const session = durable?.loadSession(jobId) ?? sessions.get(jobId);
      return structuredClone(session?.agreement ?? session?.proposal?.plan?.draft ?? null);
    },
    stageOf: (jobId) => sessionView(durable?.loadSession(jobId) ?? sessions.get(jobId))?.stage ?? null,
    deliveryStateOf: (jobId) => {
      assertSettlementCredit(jobId);
      const session = durable?.loadSession(jobId) ?? sessions.get(jobId);
      return structuredClone(session?.deliveryReady ?? session?.deliveryHold ?? null);
    },
    // Read-only copies of this seller's own authenticated durable sessions, for
    // an operator whose seller policy and resume pass read seller records
    // (sellerApproval.purchaseSource "seller"). Synchronous; never signs or reads the chain.
    durableSessionOf: durable ? (jobId) => sessionView(durable.loadSession(jobId)) : undefined,
    // Whether this seller retains payment work for exactly this claim (its
    // transaction and payer): the transport then never releases the claim's
    // effect as one that started nothing. Synchronous and read only.
    retainsPaymentClaim: (jobId, { txHash, payerPayingKey } = {}) => {
      if (!isCanonicalJobId(jobId)) return false;
      const session = durable?.loadSession(jobId) ?? sessions.get(jobId);
      const work = session?.nativeEvidenceWork ?? session?.paymentWork;
      return Boolean(work) && work.txHash === paymentTxHash(txHash) && work.payerPayingKey === payerPayingKey;
    },
    durableSessions: durable ? () => durable.sessions().map(sessionView) : undefined,
    reconcile: durable ? async({ jobId }) => {
      const session=durable.loadSession(jobId);
      // An unpaid outside buyer may only read back an issued unknown CREATE.
      if(access&&session&&buyerAccessClosed(session,jobId)){
        const unknown=await readIssued?.(jobId,{unknownOnly:true});
        if(unknown)return unknown;
        throw new SellerAgentError('buyer_access_closed','this operator accepts only its configured custody buyer while openBuyerAccess is off; no unknown issued write remains to read back',409);
      }
      return durable.reconcileJob(jobId, anchors);
    } : undefined,
    resume: durable ? recoveryCall(resume) : undefined,
    reconcileTransport: durable ? async(input) => {
      const session=durable.loadSession(input.request?.jobId);
      if(access&&session&&buyerAccessClosed(session,input.request.jobId)){
        const unknown=await readIssued?.(input.request.jobId,{unknownOnly:true});
        return {disposition:'indeterminate',reason:unknown?'buyer_access_closed; issued unknown writes inspected read-only; retained outcome unchanged':'buyer_access_closed; no unknown issued write, nothing was read; retained outcome unchanged'};
      }
      return durable.withJob(input.request?.jobId, async (session) => {
      sessions.delete(input.request.jobId); restore(session);
      const proof = await reconcileTransport(input);
      input.settle?.(proof);
      return proof;
    });} : undefined,
    close: () => {if(!closed){durable?.close();closed=true;}},
    // Test/ops visibility only: never a signing capability.
    finalityCommitmentAddress,
  };
  for(const [name,operation]of Object.entries(api))if(typeof operation==='function'&&name!=='close')api[name]=(...args)=>{requireOpen();return operation.apply(api,args);};
  return api;
  } catch(error) {
    try{durable?.close();}catch(cause){throw new AggregateError([error,cause],'seller initialization cleanup failed',{cause:error});}
    throw error;
  }
}

export { canonicalSignature, proposalTimeProblem };
