import { createFixtureSettlement } from './fixture-settlement.mjs';
import { admitSessionChallenge } from './session-challenge-limits.mjs';
import { operatorBuyerAccessConfig } from '../devnet-demo/buyer-access.mjs';
import { addressForClaim, isCanonicalEd25519Signature } from './demos-claims.mjs';
import { commitOnSignatureConfig, verifySignatureAgreement, verifyAgreementCreateAuthorization } from './commit-on-signature.mjs';
import { canonicalize, paymentEvidenceAddress, verifySellerPaymentIntake, commitFixedPriceAgreement, contentHash, isListing, createInMemoryFencedSessionStore, createInMemorySellerReceiptStore, fixedPriceAgreementLogicalAddress, finalizeFixedPriceAgreementContributions, finalityCommitmentAddress, identityBundleHash, isCanonicalJobId, isVerifiedListingAdmission, sameCanonicalClaimIdentity, canonicalDemosAgentPublicKey, isIdentityBundle, respondToFixedPriceAgreementProposalDurable, sellerFulfilmentVetRequirementsViolation, sha256Hex, signComponentArtifact, ARTIFACT_SEPARATORS, compositeVerificationAddress, createFsFencedSessionStore, runDurableFulfilmentToDeliveryReady, verifySettlementEvidence, isCompositeVerificationRecord, isCanonicalBase64Url, signedBytes } from '@kynesyslabs/dacs';
import { randomBytes } from 'node:crypto';
import { MAX_STORAGE_ARTIFACT_BYTES, assertStorageJsonDepth } from './wallet-transactions.mjs';
import { join } from 'node:path';
import { verifyComponent, DEM_RAIL } from './listing.mjs';
import { railAuthorityConfig, intakeRailDefinition, validateSellerListing } from './rail-authority.mjs';
import { listingRevocationProblem, sessionAdmissionConfig, sessionAdmissionProblem, readAdmissionCapability, vetAnchorReceiptProblem, vetRecordProblem, SELLER_PROFILE, SESSION_CHALLENGE_LIFETIME_MS } from './session-admission.mjs';
import { fixtureRef, signAnchorWrite, verifyFixtureRecord, verifyFixtureReceipt, fixtureTxRef, canonicalSignature } from './fixture-anchors.mjs';
import { createSellerDurableState, DEFAULT_SELLER_MAX_JOBS } from './seller-durable-state.mjs';
import { NATIVE_PAYMENT_EVIDENCE, nativePaymentEvidenceConfig, checkNativePaymentEvidence } from './native-payment-evidence-consumer.mjs';
import { isPaymentEvidenceWalletJournalPair, paymentEvidenceWalletJournalOf } from './payment-evidence-wallet-journal.mjs';
import { sellerSessionPresentationProblem } from './session-admission.mjs';
import { demDeliveryContextConfig, resolveDemDeliverySellerContext } from './dem-delivery-context-consumer.mjs';
import { nativeDemDeliveryConfig, submitNativeDemDelivery, reconcileNativeDemDelivery, readNativeDemDelivery, verifyNativeDemDeliveryReceipt, isProvenUnsignedAbsence } from './native-dem-delivery-consumer.mjs';
import { agreementInput, agreementTerms, commitmentReader, commitmentSession, commitmentVerifier, contributionVerifier, deliverableAddress, deliveryEvidenceAddress, listingPin, protocolSupport, RAIL_REGISTRY_VERSION, verifyDelivery, verifyPaymentEvidence } from './purchase-protocol.mjs';

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
const NO_EFFECT_ERRORS = new Set(['peer_job_capacity', 'session_not_admitted', 'session_admission_unavailable', 'buyer_access_closed', 'signature_commitment_disabled', 'signature_buyer_not_admitted', 'signature_agreement_invalid', 'signature_connection_unavailable', 'seller_signature_buyer_unresolved', 'unknown_job', 'not_agreed', 'agreement_not_anchored', 'agreement_anchor_invalid', 'agreement_substituted', 'not_committed', 'payment_already_recorded', 'buyer_bundle_invalid', 'buyer_bundle_unauthenticated', 'self_dealing', 'job_invalid', 'buyer_mismatch', 'seller_mismatch', 'job_taken', 'not_delivered', 'no_bundle_request', 'bundle_invalid', 'no_seller_copy', 'seller_native_evidence_conflict', ...SELLER_PRE_EFFECT_REFUSALS]);
const UNCERTAIN = Object.freeze({ error: 'operation_uncertain', message: 'The seller operation outcome is unavailable; no completion or finality is established.' });
const paymentPending = (answer) => answer?.status === 'held' || (answer?.status === 'payment-evidenced' &&
  (!['delivered', 'delivery-ready'].includes(answer.delivery?.status) || answer.delivery?.evidencePublication === 'held-readback-only'));
/** The one classification of an authenticated seller command's result
 * ({answer}, {error} or {held}), for its first run (HTTP finish) and for its
 * recovery (reconcileTransport). Only a refusal from the no-effect list keeps
 * its status; any other failure is uncertain. A release needs `retained:
 * false`, proof that no work of exactly this command is kept. A recovery
 * settles only what the store accepts (completion, or a proposal/payment retry
 * or release), and under an expired delegation only completion. */
export function transportOutcome(path, { answer, error, held, cause = error } = {}, { retained = true, recovering = false, readOnly = false, resumed = false } = {}) {
  const payment = path === '/dacs/v1/payments', proposal = path === '/dacs/v1/agreements/proposals';
  const refusal = error instanceof SellerAgentError && NO_EFFECT_ERRORS.has(error.code);
  const rejected = refusal || ((proposal || answer?.code !== 'party_vet_non_pass') && (answer?.status === 'rejected' || answer?.disposition === 'rejected' || (payment && answer?.status === 'indeterminate')));
  if (held !== undefined || (error && !refusal) || (proposal && rejected && retained)) return { disposition: 'indeterminate', reason: String(held ?? error?.code ?? answer?.reason ?? 'operation_uncertain').slice(0, 240), status: 503, value: UNCERTAIN, settle: !recovering, retry: false, noEffect: false,
    ...(cause === undefined ? {} : { cause, causeCode: [cause, cause?.cause].some(c => c?.name === 'TimeoutError' || c?.code === 'ETIMEDOUT') ? 'timeout' : 'reader' }) };
  const noEffect = rejected && !resumed && !retained;
  const final = ['delivered', 'delivery-ready'].includes(answer?.status) || (answer?.status === 'payment-evidenced' && !paymentPending(answer));
  const retry = !noEffect && ((proposal && ['waiting', 'indeterminate'].includes(answer?.disposition)) || (payment && (refusal ? retained : paymentPending(answer) || (retained && !final))));
  if (recovering && !(readOnly ? !retry && !noEffect && !rejected : retry || noEffect ? proposal || payment : !rejected)) {
    return { disposition: 'indeterminate', reason: String(refusal ? error.code : answer?.reason ?? 'seller_transport_work_retained').slice(0, 240), status: 503, value: UNCERTAIN, settle: false, retry: false, noEffect: false };
  }
  return { disposition: noEffect ? 'no-effect' : retry ? 'retry' : 'present', status: refusal ? error.status : 200,
    value: refusal ? { error: error.code, message: error.message } : answer, settle: true, retry, noEffect };
}
import { proposalTimeProblem } from './seller-proposal-time.mjs';
// Readback failures of retained native evidence work (the commitment and
// Agreement readback): a retry answers them as held, with the cause.
const RETAINED_READBACK_FAILURES = new Set(['commitment_failed', 'commitment_readback_required', 'substrate_unavailable', 'agreement_not_anchored', 'agreement_anchor_invalid', 'agreement_substituted', 'seller_agreement_readback_required']);
// A claimed pay-dem transaction hash as core payment intake reads it
// (lower case, without `0x`): the transport admits either form.
const paymentTxHash = (txHash) => String(txHash).toLowerCase().replace(/^0x/, '');
// What is kept of a wallet answer: its status, transaction hash and reason, bounded.
const walletAnswer = (answer) => ({ status: typeof answer?.status === 'string' ? answer.status.slice(0, 32) : 'missing',
  ...(typeof answer?.txHash === 'string' ? { txHash: answer.txHash.slice(0, 128) } : {}), ...(typeof answer?.reason === 'string' ? { reason: answer.reason.slice(0, 240) } : {}) });

// PROFILE.json sellerRequirement: the fixed requirement the buyer vets this
// seller against (the devnet-demo profile's SELLER_REQUIREMENT is the same
// empty requirement); the buyer's own bundle is vetted against the Listing's
// exact buyerRequirement.
const SELLER_REQUIREMENT = Object.freeze({ requirementVersion: '1', required: Object.freeze([]), preferredPresentation: 'any' });
const vetUnverified = (reason, cause) => new SellerAgentError('seller_state_unverified', reason, 503, { cause });

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

// Internal seller proposal, commitment, payment and delivery profile. The
// native profile commits or takes payment only with the whole chain to
// delivery (nativePaymentEvidence, demDeliveryContext, nativeDemDelivery).
const MAX_CHALLENGES_PER_JOB=16;
export async function createSellerAgent({ signer, listing, anchors, observeDemosTransfer, now = () => Date.now(), durableDirectory, agreementAnchor = null, nativePaymentEvidence = null, demDeliveryContext = null, nativeDemDelivery = null, nativeArtifactAnchor = null, deliverableProducer = null, deliverySchemaVerifier = null, maxJobs = DEFAULT_SELLER_MAX_JOBS, deliveryEvidenceEnabled = false, buyerAccess = null, readIssued = null, commitOnSignature = false, signatureBuyer = null, signatureCommitmentReady = null, contextRequest = null, railAuthority = null, sessionAdmission = null, reconcilePaymentEvidence = null, simulatedFixture = false }) {
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
  const nativeUnavailable=()=>{throw new SellerAgentError('settlement_profile_unavailable','native payment handling is not assembled',503);};
  const assertPaymentChain = () => {
    if (nativeProfile && !settlementChain) throw new SellerAgentError('settlement_profile_unavailable', 'the native seller profile takes payment only with native payment evidence, the DEM delivery context and native DEM delivery', 503);
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
  const durable = durableDirectory ? await createSellerDurableState({ dir: durableDirectory, signer, listingPin: pin, maxJobs }) : null;
  let closed=false;
  const requireOpen=()=>{if(closed)throw new SellerAgentError('seller_closed','the seller agent is closed',503);};
  try {
  const sign = (bytes) => new Uint8Array(durable ? durable.signOnce(`signature:${sha256Hex(bytes)}`, Buffer.from(bytes)) : signer.sign(Buffer.from(bytes)));
  const rawReceiptStore = durable?.receiptStore ?? createInMemorySellerReceiptStore();
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
  if (!retainedAdmission) { const { revocation: _revocation, ...retained } = validation; durable?.retainContext({ admittedAt, validation: retained }); }
  const sellerBundle = listing.seller.identity;
  const store = durable?.fencedStore ?? createInMemoryFencedSessionStore();
  const fulfilmentStore = deliveryContext ? await createFsFencedSessionStore({ dir: join(durableDirectory, 'sdk-fulfilment') }) : null;
  const sessions = new Map(); // jobId -> session
  // CORE SN-1..SN-4: the challenges this seller issued, by nonce, each bound to
  // one job and buyer (kept with the durable seller state, else in memory).
  const memoryChallenges = new Map();
  const challenges = durable ? durable : {
    issueChallenge: (nonce, value, limits) => {
      admitSessionChallenge(memoryChallenges,value,limits);
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
  // The delivery runner inspects and consumes the permit before it prepares or sends the Deliverable.
  // Each call re-checks the settlement credit: a permit whose settlement another job also claims is invalid,
  // never a thrown store failure (which the runner would hold as an ambiguous, retryable read).
  const permitCredit = (permit) => !['available', 'already-consumed'].includes(permit?.status) || !permit.claim || hasSettlementCredit(permit.claim.settlementId, permit.claim.jobId);
  const receiptStore = {
    inspectPermit: (permitId) => rawReceiptStore.inspectPermit(permitId),
    claim: async candidate => { bindSettlement(candidate.settlementId, candidate.jobId, structuredClone(candidate)); return rawReceiptStore.claim(candidate); },
    inspectPermit: async permitId => { const permit = await rawReceiptStore.inspectPermit(permitId); return permitCredit(permit) ? permit : { status: 'invalid' }; },
    consumePermit: async (permitId, handoff) => permitCredit(await rawReceiptStore.inspectPermit(permitId)) ? rawReceiptStore.consumePermit(permitId, handoff) : { status: 'invalid' },
  };
  const verifiedSessions = new Map(), sessionFingerprint = (session) => sha256Hex(canonicalize(session)); // jobId -> verified bytes hash
  function retainedSnapshotProblem(session) {
    return !durable ? null : verifiedSessions.get(session.jobId) === undefined ? 'the retained session was not verified by this seller instance' : sessionFingerprint(session) !== verifiedSessions.get(session.jobId) ? 'the retained session changed after this seller instance verified it' : null;
  }
  // A retained session may be exposed only once the exact attempt that admitted
  // it is proven from this seller's own authenticated ledger (CORE SN-3/SN-4: a
  // nonce is bound to one job and buyer and consumed on attempt), and, since a
  // retained session claims Vet, both exact job and bundle Vet references, their
  // counterparty-signed records and their verified SR-2 receipts (DACS-2
  // VPC-3). Anything else is held: never restored and never returned.
  function retainedChallengeProblem(session) {
    if (!nativeProfile || !durable) return null;
    const bundle = session.buyerBundle, nonce = bundle?.sessionNonce;
    const challenge = durable.challenge(nonce);
    if (!challenge) return 'the retained session names no challenge this seller issued';
    if (challenge.jobId !== session.jobId || !sameCanonicalClaimIdentity(challenge.buyer, bundle.presentedBy) || challenge.sessionNonce !== nonce) return 'the retained session challenge was issued for another job or buyer';
    if (challenge.attempt?.admitted !== true) return 'the retained session challenge was not consumed and admitted for this attempt';
    if (challenge.attempt.presentationHash !== sha256Hex(canonicalize(bundle))) return 'the retained session challenge was admitted for another presentation';
    // A pre-Vet proposal session has no Vet evidence to authenticate it: only
    // the exact accepted presentation and its validated admission answer,
    // written with that admission, prove this seller admitted it. Legacy
    // sessions past proposal keep their own Vet evidence check instead.
    if (!claimsVet(session)) {
      const accepted = challenge.attempt.accepted;
      if (!accepted || accepted.buyerBundleHash !== session.buyerBundleHash || canonicalize(accepted.buyerBundle ?? null) !== canonicalize(bundle)) return 'the retained proposal session has no exact accepted presentation';
      const admissionProblem = sessionAdmissionProblem(accepted.admission, { jobId: session.jobId, buyer: bundle.presentedBy, buyerBundleHash: session.buyerBundleHash, seller: claim, listingPin: pin });
      if (admissionProblem) return `the retained proposal session ${admissionProblem}`;
    }
    return null;
  }
  function retainedVetRefProblem(ref, jobId, party, verifier) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || Object.keys(ref).sort().join(',') !== 'anchor,contentHash,signer') return 'the retained Vet reference is not an exact signed record reference';
    if (ref.anchor?.kind !== 'storage-program' || Object.keys(ref.anchor).sort().join(',') !== 'kind,locator' || ref.anchor.locator !== compositeVerificationAddress(jobId, party)) return 'the retained Vet reference is not at the job\'s canonical composite address';
    if (!/^[0-9a-f]{64}$/.test(ref.contentHash) || !sameCanonicalClaimIdentity(ref.signer, verifier)) return 'the retained Vet reference is not signed by its counterparty verifier';
    return null;
  }
  const retainedVetRefs=session=>session.vetCheckpoint??(session.demDeliveryContext?.input?{buyer:session.demDeliveryContext.input.buyer.vetRecordRef,seller:session.demDeliveryContext.input.seller.vetRecordRef}:null);
  function retainedVetCheckpointProblem(session) {
    if(!nativeProfile)return null;
    const checkpoint = retainedVetRefs(session);
    if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint) || Object.keys(checkpoint).sort().join(',') !== 'buyer,seller') return 'the retained session has no exact buyer and seller Vet checkpoint';
    const buyer = session.buyerBundle?.presentedBy;
    if (typeof buyer !== 'string' || buyer.length === 0 || buyer.normalize('NFC') !== buyer) return 'the retained session names no canonical buyer';
    const buyerProblem = retainedVetRefProblem(checkpoint.buyer, session.jobId, buyer, claim);
    if (buyerProblem) return `buyer ${buyerProblem}`;
    const seller = retainedVetRefProblem(checkpoint.seller, session.jobId, claim, buyer);
    if (seller) return `seller ${seller}`;
    return null;
  }
  async function retainedVetEvidenceProblem(session) {
    if(!nativeProfile)return null;
    const checkpoint=retainedVetRefs(session);
    if (!admission) return 'the seller has no session admission to authenticate retained Vet records';
    const sellerBundle = session.sellerBundle ?? listing.seller.identity, sellerProblem = sellerSessionPresentationProblem(sellerBundle, listing.seller.identity);
    if (sellerProblem) return `seller ${sellerProblem}`;
    const parties = [
      ['buyer', session.buyerBundle.presentedBy, checkpoint.buyer, identityBundleHash(session.buyerBundle), claim, listing.buyerRequirement],
      ['seller', claim, checkpoint.seller, identityBundleHash(sellerBundle), session.buyerBundle.presentedBy, SELLER_REQUIREMENT],
    ];
    for (const [role, party, ref, bundleHash, verifier, requirement] of parties) {
      let record, receipt, verdict;
      try { record = await readAdmissionCapability(admission, 'resolveVetRecord', { jobId: session.jobId, role, party, ref }); } catch (error) { throw vetUnverified(`the ${role} Vet record cannot be resolved (${error?.code ?? 'error'})`, error); }
      // DACS-2 §7.7.1/§7.7.2: the strict verifier replays the record's decision
      // against the exact requirement this profile invoked, binding its signed
      // requirementHash and result references; shape and signer alone would
      // accept a record the counterparty signed for another requirement.
      const recordProblem = await vetRecordProblem(record, { ref, jobId: session.jobId, party, bundleHash, verifier, invocation: { requirement, freshness: [], dealSpecific: [] }, now });
      if (recordProblem) return `the ${role} ${recordProblem}`;
      try { receipt = await readAdmissionCapability(admission, 'readVetAnchorReceipt', { jobId: session.jobId, role, party, ref }); } catch (error) { throw vetUnverified(error?.code === 'ENOENT' ? `the ${role} Vet record has no SR-2 receipt` : `the ${role} Vet record SR-2 receipt cannot be read (${error?.code ?? 'error'})`, error); }
      // DACS-2 VPC-3: a record is relied on only at `accepted` or later.
      const receiptProblem = vetAnchorReceiptProblem(receipt, { ref, jobId: session.jobId, party });
      if (receiptProblem) return `the ${role} ${receiptProblem}`;
      try { verdict = await readAdmissionCapability(admission, 'verifyVetAnchorReceipt', { jobId: session.jobId, role, party, ref, record, receipt }); } catch (error) { throw vetUnverified(`the ${role} Vet receipt cannot be verified (${error?.code ?? 'error'})`, error); }
      if (verdict !== 'valid') return `the ${role} Vet receipt does not verify`;
    }
    return null;
  }
  // Only the exact pre-Vet proposal stage this part retains claims no Vet: it
  // precedes the checkpoint, so the challenge binding alone applies. Every
  // other stage - `vetted`, any later stage, or one this code does not know -
  // requires both exact checkpoints and their evidence (fail closed).
  function claimsVet(session) {
    return session.stage !== 'proposed' || session.vetCheckpoint !== undefined;
  }
  function retainedSessionProblem(session) {
    // Fixture sessions use not-performed Vet markers; a retained native Vet
    // checkpoint still needs native admission and cannot cross this profile.
    if (!nativeProfile && (session.vetCheckpoint !== undefined || session.demDeliveryContext !== undefined)) return 'the fixture profile cannot authenticate retained native Vet records';
    return nativeProfile || durable ? retainedChallengeProblem(session) ?? (claimsVet(session) ? retainedVetCheckpointProblem(session) : null) : null;
  }
  function sessionView (session) {
    if(!session)return null;
    const problem = retainedSnapshotProblem(session) ?? retainedSessionProblem(session);
    if (problem) throw new SellerAgentError('seller_state_unverified', problem, 503);
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
  const persist = (session) => { durable?.saveSession(session); verifiedSessions.set(session.jobId, sessionFingerprint(session)); };
  // The seller-state lock, checked last before an effect that leaves through
  // another journal: as the native publisher's authorize hook (called under its
  // address lock with nothing awaited before the CREATE intent), or just before
  // a wallet or delivery call. A holder that lost its job's row sends nothing.
  const heldFor = (jobId) => () => { assertSettlementCredit(jobId); return durable ? durable.assertHeld(jobId) : true; };
  function recordPhase(session, index, invokedAt, result, write = true) {
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
    if (write) persist(session);
    return entry;
  }
  async function restore(session) {
    if (!session) return;
    authenticateBuyerBundle(session.buyerBundle);
    if (identityBundleHash(session.buyerBundle) !== session.buyerBundleHash) throw new SellerAgentError('seller_state_corrupt', 'retained buyer binding is invalid', 503);
    const problem = retainedSessionProblem(session) ?? (claimsVet(session) ? await retainedVetEvidenceProblem(session) : null);
    if (problem) throw new SellerAgentError('seller_state_unverified', problem, 503);
    sessions.set(session.jobId, session);verifiedSessions.set(session.jobId, sessionFingerprint(session));
    if (session.sellerContribution) {
      signatures.set(session.sellerContribution.planHash, session.sellerContribution.signature.value);
      contributions.set(session.sellerContributionProposalHash, session.sellerContribution);
    }
  }
  for (const session of durable?.sessions() ?? []) await restore(session);
  // An authenticated transport command hands in its reservation's checks: it
  // is checked inside the job fence before restore or work, and its outcome
  // is settled there, before the fence is released.
  const recoveryCall = (fn, before) => durable ? (input, { transport } = {}) => durable.withJob(input?.transportIdentity?.jobId ?? input?.jobId, async (session) => {
    transport?.check();
    const jobId = input?.transportIdentity?.jobId ?? input?.jobId;
    const early=before?await before(session,jobId):undefined;if(early!==undefined)return early;
    sessions.delete(jobId);
    await restore(session);
    if (!transport) return fn(input);
    let result;
    try { transport.check();const answer=await fn(input,{transport});transport.check();result={answer}; } catch (error) { result = { error }; }
    transport.settle(transportOutcome(transport.path, result, { retained: retainedWork(transport.path, jobId, input) }));
    if (result.error) throw result.error;
    return result.answer;
  }).catch((error) => {
    if (error.code === 'seller_state_capacity') throw new SellerAgentError('peer_job_capacity', 'the seller has reached maxJobs; no new session was admitted', 503);
    // The store's fence rejects a non-canonical job before the operation's own
    // validation runs. It is the same definite no-effect refusal the operation
    // would have raised, not an uncertain outcome.
    if (error.code === 'seller_state_job_invalid') throw new SellerAgentError('job_invalid', 'jobId is not canonical');
    throw error;
  }) : async(input,{transport}={})=>{transport?.check();const answer=await fn(input,{transport});transport?.check();return answer;};

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
  async function issueSessionChallenge(request) {
    requireOpen();
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new SellerAgentError('challenge_invalid', 'the challenge request must be an object', 422);
    const { jobId, buyer, sessionNonce } = request;
    if (!nativeProfile) throw new SellerAgentError('session_admission_required', 'the simulated fixture profile takes no session admission', 503);
    assertSessionAdmission();
    if (!isCanonicalJobId(jobId)) throw new SellerAgentError('job_invalid', 'jobId is not canonical');
    if (!canonicalDemosAgentPublicKey(buyer) || sameCanonicalClaimIdentity(buyer,claim)) throw new SellerAgentError('buyer_invalid', 'the challenge names no buyer claim other than the seller');
    if (sessionNonce !== undefined) throw new SellerAgentError('challenge_invalid', 'the seller generates its own session nonce (CORE SN-1/SN-2)');
    const nonce = randomBytes(32).toString('hex'), issuedAt = now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new SellerAgentError('seller_clock_invalid', 'the seller clock is not an integer time', 503);
    if(!Number.isSafeInteger(issuedAt+SESSION_CHALLENGE_LIFETIME_MS))throw new SellerAgentError('seller_clock_invalid','the challenge expiry exceeds the safe clock range',503);
    const issued = { jobId, buyer, sessionNonce: nonce, issuedAt, expiresAt: issuedAt + SESSION_CHALLENGE_LIFETIME_MS };
    const revocation = await listingRevocationProblem(admission, { listing, listingPin: pin, jobId, now });
    requireOpen();
    if (revocation) throw new SellerAgentError(revocation.code, revocation.message, revocation.status);
    try { challenges.issueChallenge(nonce, issued,{maxOutstanding:maxJobs,maxPerJob:MAX_CHALLENGES_PER_JOB}); }
    catch (error) { if(error.code==='seller_challenge_capacity')throw new SellerAgentError(error.code,error.message,503); if (error.code === 'seller_challenge_taken') throw new SellerAgentError('challenge_taken', 'this session nonce was issued before', 409); throw error; }
    return issued;
  }

  // ---- DACS-3: proposal -> seller contribution ----
  async function receiveProposal({ proposal, transportIdentity, buyerIdentityBundle },{transport}={}) {
    requireOpen();
    const jobId = transportIdentity?.jobId;
    if (!isCanonicalJobId(jobId)) throw new SellerAgentError('job_invalid', 'jobId is not canonical');
    // The transport identity is buyer-supplied: a request naming another seller
    // is refused before any capability is asked or anything is retained.
    if (!sameCanonicalClaimIdentity(transportIdentity?.seller, claim)) throw new SellerAgentError('seller_mismatch', 'proposal seller is not this agent', 409);
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
      // A job's accepted presentation is reserved durably when it is admitted
      // (session-job:<jobId>, written in the admission's own transaction). After
      // a restart, or against a concurrent opener, the same job may only replay
      // that exact presentation: another buyer or bundle is refused before the
      // admission capability is asked, and the durable write refuses a race.
      const bound = !existing && durable ? durable.jobBinding(jobId) : null;
      if (bound && (!sameCanonicalClaimIdentity(bound.buyer, buyerIdentityBundle.presentedBy) || bound.presentationHash !== presentationHash)) throw new SellerAgentError('job_taken', 'this job is bound to another buyer or bundle', 409);
      // DACS-1 RB-4..RB-6, LR-3: the seller decides revocation itself (core
      // checkListingRevocation) over the operator's readings; only `absent` opens.
      const revocation = await listingRevocationProblem(admission, { listing, listingPin: pin, jobId, now });
      requireOpen();
      if (revocation) throw new SellerAgentError(revocation.code, revocation.message, revocation.status);
      const query = { jobId, buyer: buyerIdentityBundle.presentedBy, buyerBundleHash: bundleHash, sessionNonce: nonce,
        seller: claim, listingPin: structuredClone(pin), profile: structuredClone(SELLER_PROFILE) };
      const accepted=issued.attempt?.admitted===true?issued.attempt.accepted:null;
      if(issued.attempt?.admitted===true&&(!accepted||accepted.buyerBundleHash!==bundleHash||canonicalize(accepted.buyerBundle??null)!==canonicalize(buyerIdentityBundle)))throw new SellerAgentError('session_admission_unavailable','the retained accepted presentation is incomplete or differs',503);
      let answer;
      try { answer = accepted?structuredClone(accepted.admission):await readAdmissionCapability(admission,'admit',query); }
      catch (cause) { throw new SellerAgentError('session_admission_unavailable', 'the seller session admission is unavailable', 503,{cause}); }
      // Checked after the awaited admission read too, outside the reader error
      // wrapper: a close while it was pending is a lifecycle refusal, not an
      // unavailable admission, and keeps nothing.
      requireOpen();
      const problem = sessionAdmissionProblem(answer, query);
      if (problem) throw new SellerAgentError(accepted?'session_admission_unavailable':'session_not_admitted', problem, accepted?503:409);
      if(!accepted)try{challenges.admitChallenge(nonce, presentationHash,{buyerBundle:structuredClone(buyerIdentityBundle),buyerBundleHash:bundleHash,admission:structuredClone(answer),admittedAt:now()});}
        catch(error){if(error.code==='seller_job_bound')throw new SellerAgentError('job_taken','this job is bound to another buyer or bundle',409);throw error;}
    }
    if (!existing) sessions.set(jobId, { jobId, buyerBundle: structuredClone(buyerIdentityBundle), buyerBundleHash: identityBundleHash(buyerIdentityBundle), proposal: null, stage: 'proposed', ...(railPin ? { railPin } : {}) });
    else if (railPin && !inFlight) existing.railPin = railPin;
    const session = sessions.get(jobId);
    verifiedSessions.set(jobId, sessionFingerprint(session));
    const signUnderPin = (bytes) => {
      transport?.check();
      if (inlineSizeProblem) throw new SellerAgentError('unsupported_inline_delivery', inlineSizeProblem, 503);
      if (!inFlight) assertListingCurrent();
      // The first completed signature is made now, not when the context was
      // resolved: the responder's own checkpoints can outlast the plain clock
      // window or the admitted route's absolute deadline. Recheck the retained
      // decision on the current clock here; signOnce's completed record alone
      // replays a signature already made. A session retained by an earlier
      // build carries no generatedAt and keeps the context-time decision.
      const retainedDecision = session.proposalAdmission?.proposalHash === proposal.proposalHash ? session.proposalAdmission : null;
      if (retainedDecision && Number.isSafeInteger(retainedDecision.generatedAt) &&
          durable?.signature(`signature:${sha256Hex(bytes)}`).disposition !== 'present') {
        const lateProblem = proposalTimeProblem({ generatedAt: retainedDecision.generatedAt, observedAt: now(),
          deadlineSecAfterCommit: listing.terms.deadlineSecAfterCommit, admitted: retainedDecision.admitted });
        if (lateProblem) throw new SellerAgentError('proposal_expired', lateProblem, 409);
      }
      // The key is only a pointer. An intent or a thrown signer never makes
      // this pin in flight; signOnce's completed record is the authority.
      session.agreementSignatureKey = `signature:${sha256Hex(bytes)}`;
      session.agreementSignatureProposalHash = proposal.proposalHash;
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
          // The admission decision belongs to the exact proposal the seller
          // first saw: an exact retry after a crash replays the retained
          // contribution, so it must not re-ask a callback that has since been
          // lost or changed. A completed signature was made under that
          // decision and replays with the observation time it was decided at.
          const priorAdmission = session.proposalAdmission?.proposalHash === proposal.proposalHash ? session.proposalAdmission : null;
          // A retained signing intent is not a signature: the first completed
          // signature for this proposal is made now, so the clock is read now.
          // Only replaying an already completed signature reuses the old
          // observation, which is why it carries the proposal it was made for.
          const signed = Boolean(session.sellerContribution ||
            (session.agreementSignatureKey && session.agreementSignatureProposalHash === proposal.proposalHash &&
              durable?.signature(session.agreementSignatureKey).disposition === 'present'));
          const admitted = typeof priorAdmission?.admitted === 'boolean' ? priorAdmission.admitted
            : admittedContextRequest({ jobId, buyerBundle: session.buyerBundle, generatedAt });
          const timeProblemAt = (observedAt) => proposalTimeProblem({ generatedAt, observedAt,
            deadlineSecAfterCommit: listing.terms.deadlineSecAfterCommit, admitted });
          const observedAt = signed && priorAdmission ? priorAdmission.observedAt : now();
          const timeProblem = timeProblemAt(observedAt);
          if (timeProblem) return { disposition: 'rejected', reason: timeProblem };
          if (!priorAdmission) session.proposalAdmission = { proposalHash: proposal.proposalHash, observedAt, admitted, generatedAt };
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
            for (const [role, party, bundle, verifier] of parties) {
              const ref = resolved.input[role].vetRecordRef;
              const invocation = resolved.vetRequirements.find((entry) => canonicalize(entry.vetRecordRef) === canonicalize(ref));
              // Restore replays each record against this profile's fixed
              // requirement and no freshness/deal-specific results. Sign only
              // the declaration restore can reproduce, so no persisted session
              // is refused by the next start of this seller.
              const expectedRequirement = role === 'seller' ? SELLER_REQUIREMENT : listing.buyerRequirement;
              if (!invocation || invocation.freshness.length !== 0 || invocation.dealSpecific.length !== 0 ||
                  canonicalize(invocation.requirement) !== canonicalize(expectedRequirement)) {
                return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: ${role}: the Vet requirement invocation differs from the requirement this profile restores` };
              }
              let record;
              try { record = await readAdmissionCapability(admission,'resolveVetRecord',{ jobId, role, party, ref }); }
              catch (cause) { return unavailable(cause,`the ${role} Vet record is unavailable`); }
              if (record === null) return unavailable(new Error('Vet record is absent'),`the ${role} Vet record is absent`);
              const problem = await vetRecordProblem(record, { ref, jobId, party, bundleHash: identityBundleHash(bundle), verifier, invocation, now });
              if (problem) return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: ${role}: ${problem}` };
              // DACS-2 VPC-3: a signed record is no admitted one. It is relied on
              // only with its SR-2 receipt at `accepted` or later, before any signature.
              let receipt;
              try { receipt = await readAdmissionCapability(admission,'readVetAnchorReceipt',{ jobId, role, party, ref }); }
              catch (cause) { return unavailable(cause,`the ${role} Vet record read or authentication is unavailable`); }
              if (receipt === null) return unavailable(new Error('Vet receipt is absent'),`the ${role} Vet record has no SR-2 receipt`);
              const receiptProblem = vetAnchorReceiptProblem(receipt, { ref, jobId, party });
              if (receiptProblem) return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: ${role}: ${receiptProblem}` };
              // CORE SR2-4: the receipt's fields alone are assertions, not proof.
              // Only the operator's authentication of this record's receipt passes.
              let verdict;
              try { verdict = await readAdmissionCapability(admission,'verifyVetAnchorReceipt',{ jobId, role, party, ref, record, receipt }); }
              catch (cause) { return unavailable(cause,`the ${role} Vet record read or authentication is unavailable`); }
              if (verdict !== 'valid') return verdict==='invalid'?{disposition:'rejected',reason:`VET_RECORD_UNVERIFIED: ${role}: invalid Vet receipt`}:unavailable(new Error('Vet receipt verification is indeterminate'),`the ${role} Vet receipt verification is indeterminate`);
            }
            // The clock is read again after every authenticated read: the
            // admitted route's deadline is absolute, so the first completed
            // signature must not be made once it has passed.
            if (!signed) {
              const lateProblem = timeProblemAt(now());
              if (lateProblem) return { disposition: 'rejected', reason: lateProblem };
            }
            session.demDeliveryContext = structuredClone(resolved);
            session.sellerBundle = structuredClone(sessionSeller);
            session.vetCheckpoint = { buyer: structuredClone(resolved.input.buyer.vetRecordRef), seller: structuredClone(resolved.input.seller.vetRecordRef) };
            return { disposition: 'present', value: structuredClone(resolved.input) };
          }
          if (!signed) {
            const lateProblem = timeProblemAt(now());
            if (lateProblem) return { disposition: 'rejected', reason: lateProblem };
          }
          return { disposition: 'present', value: agreementInput({ jobId, listing, buyerBundle: session.buyerBundle, generatedAt }) };
        },
        verifyContribution: contributionVerifier,
        reconcileSellerSignature: (input) => (signatures.has(input.planHash) ? { disposition: 'present', value: signatures.get(input.planHash) } : { disposition: 'absent', reason: 'not signed yet' }),
        transport: {
          publishSellerContribution: (contribution, identity) => {
            transport?.check();
            // The durable session is the authority, not these caches. Retain
            // the exact proposal and transport identity with the contribution
            // and save them together first: a crash after publication must
            // not leave a contribution the buyer's readback cannot name, and a
            // failed save must not leave a later reconciliation believing an
            // unpublished contribution is present.
            session.sellerContribution = structuredClone(contribution);
            session.sellerContributionProposalHash = identity.proposalHash;
            session.proposal = structuredClone(proposal);
            session.transportIdentity = structuredClone(transportIdentity);
            session.agreementHash = transportIdentity.agreementHash;
            persist(session);
            contributions.set(identity.proposalHash, structuredClone(contribution));
            signatures.set(contribution.planHash, contribution.signature.value);
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
    // The verified responder result is authoritative for the contribution: a
    // terminal recovery completes the negotiation after an earlier publication
    // save failed, and this final snapshot must still carry that contribution.
    session.sellerContribution = structuredClone(progress.result.sellerContribution);
    session.sellerContributionProposalHash = transportIdentity.proposalHash;
    session.proposal = structuredClone(proposal);
    session.transportIdentity = structuredClone(transportIdentity);
    session.agreementHash = transportIdentity.agreementHash;
    persist(session);
    contributions.set(transportIdentity.proposalHash, structuredClone(session.sellerContribution));
    signatures.set(session.sellerContribution.planHash, session.sellerContribution.signature.value);
    return { disposition: 'complete', contribution: progress.result.sellerContribution };
  }

  function agreementState(identity) {
    assertSettlementCredit(identity?.jobId);
    // Read without replacing the object owned by a concurrent job operation.
    const session = sessionView(durable ? durable.loadSession(identity?.jobId) : sessions.get(identity?.jobId));
    if (!session?.proposal || session.transportIdentity?.proposalHash !== identity.proposalHash) return { proposal: null, contribution: null };
    return structuredClone({ proposal: session.proposal, contribution: session.sellerContribution ?? null });
  }

  // The buyer-anchored Agreement and the reference that names it: the
  // fixture-substrate write by default, or the buyer's authenticated native
  // SR-2 CREATE with the opt-in capability (its receipt kept as `native`).
  async function readBuyerAgreement(agreementAddress,buyer,agreementHash,signedProjection) {
    const reader=agreementAnchor??anchors,method=agreementAnchor?'readAgreement':'read';let read,returnedAgreementCause;
    const input=agreementAnchor?{logicalAddress:agreementAddress,writer:buyer,agreementHash,...signedProjection===undefined?{}:{signedProjection}}:agreementAddress;
    try {read=await readAdmissionCapability({read:async(query,limits)=>{
      const value=await reader[method](query,limits);returnedAgreementCause=value?.cause;
      // A reader's diagnostic Error is kept separately from its bounded JSON
      // answer. Preserve every other descriptor and the prototype for validation.
      if(!value||typeof value!=='object'||Array.isArray(value)||!Object.hasOwn(value,'cause'))return value;
      const properties=Object.getOwnPropertyDescriptors(value);delete properties.cause;
      return Object.create(Object.getPrototypeOf(value),properties);
    }},'read',input);}
    catch(cause){throw new SellerAgentError('substrate_unavailable','SR-2 Agreement read failed',503,{cause});}
    const status=agreementAnchor?read?.disposition:read?.status;
    if(status==='absent')throw new SellerAgentError('agreement_not_anchored','the buyer has not anchored the Agreement');
    if(status==='rejected'||status==='invalid')throw new SellerAgentError('agreement_anchor_invalid','Agreement anchor does not authenticate the buyer write',422,{cause:returnedAgreementCause??read});
    if(status!=='present')throw new SellerAgentError('substrate_unavailable','SR-2 Agreement readback is unavailable',503,{cause:returnedAgreementCause??read});
    if(agreementAnchor){
      // The capability's present answer is caller data: hash it before any
      // commitment effect so malformed bytes are a definite refusal, not an
      // uncertain transport outcome after a write.
      try{contentHash(read.artifact);}catch(cause){throw new SellerAgentError('agreement_anchor_invalid','Agreement anchor artifact is malformed',422,{cause});}
      return{agreement:read.artifact,ref:read.ref,native:read.native};
    }
    let verdict;
    try{verdict=verifyFixtureRecord(read,{logicalAddress:agreementAddress,expectedWriter:buyer});}
    catch(cause){throw new SellerAgentError('agreement_anchor_invalid','Agreement anchor is malformed',422,{cause});}
    if(verdict!=='valid')throw new SellerAgentError('agreement_anchor_invalid','Agreement anchor is not the buyer write');
    return{agreement:read.artifact,ref:fixtureRef(agreementAddress,contentHash(read.artifact)),native:null};
  }

  const nativeAgreementView = (native) => ({ source: native.source, evidenceMode: native.evidenceMode, nativeAddress: native.nativeAddress, txRef: native.txRef });

  function retainCommitmentPhase(session, finalized, write = true) {
    // Ordinary commit has now authenticated the anchored Agreement and both signatures.
    const agreementRef={anchor:{kind:'storage-program',locator:fixedPriceAgreementLogicalAddress(session.jobId)},contentHash:finalized.agreementHash};
    recordPhase(session,0,session.proposalAdmission.observedAt,{ok:true,contextDelta:{'negotiate-fixed-price':{agreementHash:finalized.agreementHash,agreementRef}}},write);
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
    }, write);
  }

  function releaseFinalizedSignatureCommitment(session, jobId) {
    // Only this job's finalized commitment, authenticated with both Agreement signatures, frees the slot.
    // Reservation and session save are separate writes, so no saved marker is needed.
    if (commitOnSignature || session.signatureCommitmentAttempt) durable.releaseSignatureCommitment(session.buyerBundle.presentedBy, jobId);
  }

  // ---- DACS-3: finalized commitment (orchestrator) ----
  // `readbackOnly` is internal (never an HTTP body field): a retained
  // commitment is authenticated again, but an absent one is never published.
  // `adopt` is internal to transport reconciliation: a publisher readback may
  // adopt a commitment that was anchored before its session save, still with
  // no signing or submission.
  async function commit({ jobId, signedProjection }, { readbackOnly = false, signatureAgreement, adopt = false } = {}) {
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    assertRailPin(session.railPin, 'in-flight');
    if(nativeProfile)settlementOperations.commit();
    const early = signatureAgreement !== undefined;
    if (early && !commitOnSignature) throw new SellerAgentError('signature_commitment_disabled', 'commitment on signature is disabled');
    if (early && signatureBuyer !== null && session.buyerBundle.presentedBy !== signatureBuyer) throw new SellerAgentError('signature_buyer_not_admitted', 'buyer is not admitted to early commitment');
    // An early request for an already committed job only reads back.
    const attempt = early && !session.commitment;
    // Repeated early requests stay readback-only once an early commitment is
    // held, and the ordinary path keeps main's fence, the publisher's durable
    // intent before any send, until the early commitment has been seen present;
    // after that it only reads back. A persisted early attempt is not a held
    // commitment: when nothing was signed the retry signs its one record, and
    // the publisher's own proof gate refuses a second CREATE otherwise.
    readbackOnly ||= early ? !attempt || Boolean(session.signatureCommitmentHeld) : Boolean(session.signatureCommitmentHeld);
    const readbackRequired = () => { throw new SellerAgentError('commitment_readback_required', 'only the retained commitment may be read back here', 503); };
    if(readbackOnly&&!session.commitment&&!session.signatureCommitmentAttempt&&!adopt)readbackRequired();
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
    // A retained commitment keeps the time it finalized at. A new publication,
    // including a retry that signed no CREATE, is provisionally time-stamped
    // now: the SDK checks notBefore/notAfter against the current clock.
    if (!session.commitment) session.commitCreatedAt = now();
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
    // A fresh read creates a new observation timestamp, not a new commitment
    // or phase result. Authenticate it above, then retain the exact original
    // SDK commitment/phase bytes when the immutable record, tx and receipt
    // binding are unchanged. This holds for the native readback and for the
    // fixture substrate, whose receipt also carries a read observation time.
    if (session.commitment) {
      const retained=session.commitment;
      if(contentHash(retained.record)!==contentHash(finalized.record) || retained.logicalAddress!==finalized.logicalAddress || retained.committedAt!==finalized.committedAt ||
          canonicalize(retained.anchorTxRef)!==canonicalize(finalized.anchorTxRef) || !sameNativeCommitmentReceipt(retained.anchorReceipt,finalized.anchorReceipt)) {
        throw new SellerAgentError('commitment_changed','fresh commitment readback differs from the retained finalized commitment',503);
      }
      const verdict=nativeArtifactAnchor
        ? await readAdmissionCapability(nativeArtifactAnchor,'verifyReceipt',{logicalAddress:retained.logicalAddress,artifact:retained.record,artifactKind:'FinalityCommitmentRecord',receipt:retained.anchorReceipt,signedProjection:nativeCommitmentProjection,fresh:true})
        : commitmentReader(anchors, claim).verifyAnchorReceipt({record:retained.record,anchorReceipt:retained.anchorReceipt});
      if(verdict!=='valid')throw new SellerAgentError('commitment_changed','retained commitment proof no longer authenticates',503);
      const adopted=structuredClone(session);
      adopted.agreement=agreement;adopted.agreementRef=agreementRef;
      if(native)adopted.agreementAnchor=nativeAgreementView(native);
      if(adopted.stage==='proposed')adopted.stage='committed';
      retainCommitmentPhase(adopted,retained,false);
      releaseFinalizedSignatureCommitment(adopted, jobId);
      persist(adopted);Object.assign(session,adopted);
      return {status:'committed',address:retained.logicalAddress,resumed:true,...(native?{agreementAnchor:nativeAgreementView(native)}:{})};
    }
    // A conflicting or out-of-order phase must not change the live session:
    // validate and keep the complete adoption on a copy, then save it once.
    const adopted = structuredClone(session);
    adopted.agreement = agreement;
    adopted.agreementRef = agreementRef;
    if (native) adopted.agreementAnchor = nativeAgreementView(native);
    adopted.commitment = structuredClone(finalized);
    if(adopted.stage==='proposed')adopted.stage='committed';
    // The native receipt is the authoritative commitment time. Local wall
    // time may be later within the same millisecond/second and cannot replace
    // that finalized fact in the SDK SessionRecord.
    retainCommitmentPhase(adopted, finalized, false);
    releaseFinalizedSignatureCommitment(adopted, jobId);
    persist(adopted);
    Object.assign(session, adopted);
    return { status: 'committed', address: finalized.logicalAddress, resumed: finalized.resumed, ...(native ? { agreementAnchor: nativeAgreementView(native) } : {}) };
  }

  // ---- DACS-4: payment claim -> SDK intake -> payment evidence ----
  // The native rail is the job's own pinned signed definition (RAV-R5), never
  // the current configuration; the fixture profile uses its simulated rail.
  async function anchorOnce(logicalAddress, artifact) {
    if(artifact.jobId)assertSettlementCredit(artifact.jobId);
    const authorize = () => { if(artifact.jobId)assertSettlementCredit(artifact.jobId);return signAnchorWrite(sign, logicalAddress, contentHash(artifact)); };
    const receipt = durable ? await durable.anchor({ jobId: artifact.jobId, logicalAddress, artifact, anchors, authorize }) : await anchors.write({ logicalAddress, artifact, writer: claim, writerSignature: authorize() });
    return { ref: fixtureRef(logicalAddress, contentHash(artifact)), receipt };
  }

  const signEvidence = (unsigned) => signComponentArtifact(unsigned, ARTIFACT_SEPARATORS.SettlementEvidence, { algorithm: 'ed25519', signer: claim, sign: (bytes) => sign(bytes) });

  function sameNativeDeliveryReceipt(left, right) {
    if (!left || !right) return false;
    const stable = ['receiptVersion','substrate','finalityProfile','logicalAddress','nativeAddress','contentHash','writer','nonce','state','observationDisposition'];
    return stable.every((key)=>canonicalize(left[key]??null)===canonicalize(right[key]??null)) &&
      canonicalize(left.transactionRef)===canonicalize(right.transactionRef) && canonicalize(left.blockRef)===canonicalize(right.blockRef);
  }

  // Commitment replay requires the exact authenticated block identity and
  // timestamp. Keep the original receipt after the fresh comparison succeeds.
  function sameNativeCommitmentReceipt(left, right) {
    if (!left || !right || !Number.isSafeInteger(left.blockRef?.timestamp) || !Number.isSafeInteger(right.blockRef?.timestamp)) return false;
    const stable = ['receiptVersion','substrate','finalityProfile','logicalAddress','nativeAddress','contentHash','writer','nonce','state','observationDisposition'];
    return stable.every((key)=>canonicalize(left[key]??null)===canonicalize(right[key]??null)) &&
      canonicalize(left.transactionRef)===canonicalize(right.transactionRef) &&
      canonicalize(left.blockRef)===canonicalize(right.blockRef);
  }

  const pinnedRail = (jobId) => {
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
    resolveIdentityBundle:async hash=>{
      const current=sessions.get(paymentJobId);
      for(const bundle of [sellerBundle,current?.demDeliveryContext?.input?.seller?.identityBundle,current?.buyerBundle].filter(Boolean))if(identityBundleHash(bundle)===hash)return {disposition:'verified',bundle:structuredClone(bundle)};
      return {disposition:'rejected',reason:'unknown identity bundle'};
    },
    resolvePayerAddress: async () => ({ disposition: 'rejected', reason: 'x402 is not supported by this agent' }),
    resolvePayeeDestination: async () => ({ disposition: 'error', reason: 'x402 is not supported by this agent', tier: 2 }),
    observeDemosTransfer: nativeEvidence?.observeDemosTransfer,
    observeX402Transfer: async () => ({ status: 'unavailable', reason: 'x402 is not supported by this agent' }),
    verifyX402ReceiptExtensions: () => ({ disposition: 'fail', reason: 'x402 is not supported by this agent' }),
    classifyX402SettlementChain: () => ({ disposition: 'unsupported', reason: 'x402 is not supported by this agent' }),
    receiptStore,
  });
  // ---- DACS-3: authenticated commitment transport reconciliation ----
  // Reduces an already reserved, authenticated /commitments[/signature]
  // command from this seller's retained state plus a fresh native readback. It
  // never signs or publishes to complete an uncertain effect: a finalized (or
  // early held) commitment answers what the same request would answer now.
  // Only a native read that proves nothing was ever signed may hand the request
  // back to its ordinary start once, under the same job lock.
  const COMMITMENT_PATHS = new Set(['/dacs/v1/commitments', '/dacs/v1/commitments/signature']);
  const provenUnsignedCommitment = async (jobId) => {
    if (!nativeArtifactAnchor) return false;
    try {
      const read = await nativeArtifactAnchor.readRetained({ logicalAddress: finalityCommitmentAddress(jobId), artifactKind: 'FinalityCommitmentRecord', proofOfNoIntent: true, fresh: true });
      return read?.status === 'absent' && isProvenUnsignedAbsence(read);
    } catch { return false; }
  };
  async function reconcileCommitmentTransport({ request, body, readOnly = false } = {}) {
    if (!COMMITMENT_PATHS.has(request?.path)) return undefined;
    const held = (reason, cause) => {
      const out = { disposition: 'indeterminate', reason: String(reason).slice(0, 240) };
      if (cause) { out.causeCode = cause?.cause?.name === 'TimeoutError' ? 'timeout' : 'reader'; Object.defineProperty(out, 'cause', { value: cause }); }
      return out;
    };
    const failed = (error) => held(typeof error?.code === 'string' ? error.code : 'seller_commitment_readback_indeterminate', error);
    const bound = () => {
      try {
        return request.method === 'POST' && isCanonicalJobId(request.jobId) && Boolean(body) && typeof body === 'object' && !Array.isArray(body) &&
          body.jobId === request.jobId && request.seller === claim && typeof request.buyer === 'string' && canonicalize(request.listingPin) === canonicalize(pin);
      } catch { return false; }
    };
    if (!bound()) return held('commitment transport context differs');
    const session = sessions.get(request.jobId);
    if (!session || request.buyer !== session.buyerBundle.presentedBy || request.agreementHash !== session.agreementHash) return held('no retained session for this authenticated commitment request');
    const early = request.path === '/dacs/v1/commitments/signature';
    if (early && !commitOnSignature) return held('early commitment is disabled');
    // The signature route's required Agreement is checked before recovery can
    // fall through to the ordinary commitment path: a body without one was
    // never a signature commitment request.
    if (early && (!body.agreement || typeof body.agreement !== 'object' || Array.isArray(body.agreement))) return held('the signature commitment request has no Agreement');
    // Recovery never starts an early attempt or reserves its buyer slot.
    if (early && !session.signatureCommitmentAttempt) return held('seller_signature_attempt_absent');
    const input = { jobId: request.jobId, signedProjection: body.signedProjection };
    const options = { readbackOnly: true, adopt: !early, ...(early ? { signatureAgreement: body.agreement } : {}) };
    let answer;
    try { answer = await commit(input, options); }
    catch (error) {
      if (readOnly || early || session.commitment || session.signatureCommitmentHeld || !(await provenUnsignedCommitment(request.jobId))) return failed(error);
      try { answer = await commit(input, early ? { signatureAgreement: body.agreement } : {}); }
      catch (retryError) { return failed(retryError); }
    }
    return answer?.status === 'committed' || answer?.status === 'commitment-held' ? { disposition: 'present', value: answer } : held('commitment readback did not establish a retained outcome');
  }

  function signedFixtureRef(logicalAddress, hash) {
    return { ...fixtureRef(logicalAddress, hash), signer: claim };
  }

  function fulfilmentAgreement(session) {
    const party = (role) => session.agreement.parties.find((candidate) => candidate.role === role);
    const buyer = party('buyer'), seller = party('seller');
    return {
      artifactKind: 'payee-bound', ref: fixedPriceAgreementLogicalAddress(session.jobId), contentHash: contentHash(session.agreement), jobId: session.jobId,
      listingPin: structuredClone(pin),
      buyer: { primaryClaim: buyer.primaryClaim, bundleHash: buyer.bundleHash, vetRecordRef: structuredClone(buyer.vetRecordRef) },
      seller: { primaryClaim: seller.primaryClaim, bundleHash: seller.bundleHash, vetRecordRef: structuredClone(seller.vetRecordRef) },
      // The committed Agreement already binds the complete canonical spec, including additive fields named `signature` (not an artifact signature).
      deliverableRef: structuredClone(session.agreement.terms.deliverable),
      commitment: { status: 'finalized', ref: session.commitment.logicalAddress, agreementHash: session.commitment.agreementHash,
        recordContentHash: contentHash(session.commitment.record), finalizedAt: session.commitment.committedAt, signer: claim },
    };
  }

  function fulfilmentListing() {
    return { pin: structuredClone(pin), sellerPrimaryClaim: claim, buyerRequirement: structuredClone(listing.buyerRequirement),
      pipeline: structuredClone(listing.pipeline), deliverable: structuredClone(listing.offering.deliverable) };
  }

  function fulfilmentAuditSource(session, paymentRef) {
    const party = (role) => session.agreement.parties.find((candidate) => candidate.role === role);
    const buyer = party('buyer'), seller = party('seller');
    const commitmentRef = { anchor:{kind:'storage-program',locator:session.commitment.logicalAddress}, contentHash:contentHash(session.commitment.record), signer:claim };
    return {
      sourceVersion: '1',
      session: {
        recordVersion: '1', jobId: session.jobId, state: 'settle-pending', listingRef: structuredClone(pin),
        parties: [
          { role: 'buyer', bundleHash: buyer.bundleHash, primaryClaim: buyer.primaryClaim, vetRecordRef: structuredClone(buyer.vetRecordRef) },
          { role: 'seller', bundleHash: seller.bundleHash, primaryClaim: seller.primaryClaim, vetRecordRef: structuredClone(seller.vetRecordRef) },
          { role: 'orchestrator', bundleHash: seller.bundleHash, primaryClaim: seller.primaryClaim },
        ],
        pipeline: structuredClone(listing.pipeline), phaseResults: structuredClone(session.phaseResults),
        startedAt: session.startedAt, lastUpdatedAt: session.lastUpdatedAt,
        recipeRegistryVersion: 1, railRegistryVersion: session.railPin.railRegistryVersion,
      },
      artifacts: {
        agreementCommitment: commitmentRef, vetRecords: [structuredClone(buyer.vetRecordRef), structuredClone(seller.vetRecordRef)],
        vetRequirements: structuredClone(session.demDeliveryContext.vetRequirements), settlementEvidence: [structuredClone(paymentRef)],
      },
      provenanceProfile: 'dacs-sdk-operational-v1',
    };
  }

  function reportMatches(value, session, settlementId) {
    return canonicalize(value) === canonicalize(deliveryReport(session, settlementId));
  }

  // Why one storage CREATE cannot carry this report, or null; checked before the permit is spent.
  function reportProblem(report) {
    const size = Buffer.byteLength(canonicalize(report));
    const expected = listing.offering.deliverable.expectedSizeBytes;
    if (size > MAX_STORAGE_ARTIFACT_BYTES || (expected !== undefined && size !== expected)) {
      return `inline delivery size ${size} differs from supported expectedSizeBytes ${expected ?? 'undeclared'} (maximum ${MAX_STORAGE_ARTIFACT_BYTES})`;
    }
    try { assertStorageJsonDepth(report); } catch { return 'the report nests deeper than one storage CREATE can carry'; }
    return null;
  }

  // After a restart the SDK hands back a consumed permit's retained candidate without preparing again;
  // the producer may no longer answer it, so it must be bound to this job, Agreement and settlement and
  // fit one CREATE. A report prepared in this run or already retained as sent is the exact current answer.
  function candidateMatches(value, session, settlementId, preparedInRun) {
    if (preparedInRun || session.deliverySentReport?.settlementId === settlementId) return reportMatches(value, session, settlementId);
    return value?.jobId === session.jobId && value.agreementHash === contentHash(session.agreement) && value.settlementId === settlementId && reportProblem(value) === null;
  }

  async function validCurrentFulfilmentFence(fence, jobId) {
    const loaded = await fulfilmentStore.load(jobId);
    return loaded.status === 'ok' && loaded.record.lease?.owner === fence.owner && loaded.record.lease?.generation === fence.generation && loaded.record.lease.expiresAt > now();
  }

  function nativeDeliveryBinding(session, work, fulfilmentId) {
    const terms = agreementTerms(session.agreement);
    return { version:'1',profile:'dacs-native-delivery-publication/v1',jobId:session.jobId,
      phase:'deliver-storage-program',phaseIndex:protocolSupport(listing).phases.delivery,listing:structuredClone(pin),
      agreementHash:contentHash(session.agreement),fulfilmentId,purchaseAmount:{amount:terms.price.amount,currency:terms.price.currency},
      payloadHash:sha256Hex(canonicalize(deliveryReport(session,work.intake.settlementId))) };
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
    const request = { agreementRef: agreement.ref, agreementHash: agreement.contentHash, commitmentRef: agreement.commitment.ref,
      deliveryPhaseIndex: protocolSupport(listing).phases.delivery, paymentPermitId: work.intake.permitId };
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
        // An absent read is an answer; any other non-present read is an outage whose bounded cause is not proof the Deliverable is gone.
        if(result.status==='absent')return null;
        return {status:'indeterminate',reason:String(result.reason ?? `native delivery read is ${result.status ?? 'unclassified'}`).slice(0,180)};
      }
      const record = await anchors.read(logicalAddress);
      if (record.status === 'present') {
        if (verifyFixtureRecord(record, { logicalAddress, expectedWriter: claim }) !== 'valid') throw new SellerAgentError('delivery_readback_invalid', 'delivery receipt is not the seller write', 503);
        return record;
      }
      if (record.status === 'absent') return null;
      return {status:'indeterminate',reason:String(record.reason ?? 'the delivery address returned no verdict').slice(0,180)};
    };
    let verifiedSchemaPayload, preparedInRun = false;
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
        preparedInRun = true;
        // A producer can be corrected after payment; a size disagreement must not become the core's permanent preparation-failed handoff.
        const problem = reportProblem(report);
        if (problem) return { status: 'indeterminate', reason: problem };
        if (schemaUrl !== undefined) {
          const verdict = await deps.verifyDeliverySchema({ schemaUrl, cleartextPayload: report });
          if (verdict?.disposition !== 'valid') return { status: 'indeterminate', reason: verdict?.reason || 'report schema validation is not valid' };
        }
        return { status: 'prepared', delivery: { artifact: { kind: phase, cleartextPayload: report, anchoredValue: report, access: { model: 'public' } } } };
      },
      submitDelivery: async (input) => {
        if (!await validCurrentFulfilmentFence(input.fence, session.jobId)) return { status: 'rejected', reason: 'delivery effect fence is not current' };
        if (input.logicalAddress !== deliverableAddress(session.jobId) || !candidateMatches(input.artifact.anchoredValue, session, work.intake.settlementId, preparedInRun) ||
            canonicalize(input.artifact.cleartextPayload) !== canonicalize(input.artifact.anchoredValue)) return { status: 'rejected', reason: 'delivery candidate differs from the exact report' };
        if(nativeDelivery){
          const report=structuredClone(input.artifact.anchoredValue);
          // Check now and through the publisher's authorization hook before signing. A throw keeps the SDK
          // intent pending; authoritative unsigned absence permits one retry.
          heldFor(session.jobId)?.();
          // Retain before submission: only authenticated readback or proven unsigned absence settles this intent.
          session.deliverySentReport={settlementId:work.intake.settlementId,canonical:canonicalize(report)};
          const binding=deliveryBinding(input.fulfilmentId);
          session.deliverySubmitted=[...new Set([...(session.deliverySubmitted??[]),input.fulfilmentId])];
          session.deliveryAdapter={fulfilmentId:input.fulfilmentId,artifactHash:input.artifactHash,deliveryBinding:binding,substrate:'source-native-delivery'};
          persist(session);
          const answer=await submitNativeDemDelivery(nativeDelivery,{...input,report,receiptContentHash:sha256Hex(canonicalize(report)),deliveryBinding:binding},heldFor(session.jobId));
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
          const answer=await reconcileNativeDemDelivery(nativeDelivery,{...input,jobId:session.jobId,logicalAddress:deliverableAddress(session.jobId),report,receiptContentHash:sha256Hex(canonicalize(report)),deliveryBinding:binding});
          if(answer.status==='complete'){
            // A consumed permit can reconcile before the submission WAL is visited. Restore its binding here too;
            // resolution and receipt verification below must still authenticate the actual CREATE.
            session.deliveryAdapter={fulfilmentId:input.fulfilmentId,deliveryBinding:binding,reconciliationId:answer.reconciliationId,substrate:'source-native-delivery-recovered-readonly'};
            persist(session);
          }
          return answer;
        }
        const record = await readDelivery(deliverableAddress(session.jobId),input.fulfilmentId);
        if (!record) return { status: 'absent', reason: 'canonical delivery address is empty' };
        if (record.status === 'indeterminate') return { status: 'indeterminate', reason: `canonical delivery readback is unavailable: ${record.reason}` };
        if (!reportMatches(record.artifact, session, work.intake.settlementId)) return { status: 'indeterminate', reason: 'canonical delivery bytes differ' };
        return { status: 'complete', reconciliationId: input.reconciliationId ?? input.fulfilmentId, observedAt: record.receipt.blockRef.timestamp };
      },
      resolveDelivery: async ({ logicalAddress, jobId, phaseIndex, phase }) => {
        if (logicalAddress !== deliverableAddress(session.jobId) || jobId !== session.jobId || phaseIndex !== protocolSupport(listing).phases.delivery || phase !== 'deliver-storage-program') {
          return { status: 'rejected', reason: 'delivery read scope differs' };
        }
        const record = await readDelivery(logicalAddress,session.deliveryAdapter?.fulfilmentId);
        if (!record) return { status: 'indeterminate', reason: 'canonical delivery is absent' };
        if (record.status === 'indeterminate') return { status: 'indeterminate', reason: `canonical delivery readback is unavailable: ${record.reason}` };
        if (!reportMatches(record.artifact, session, work.intake.settlementId)) return { status: 'rejected', reason: 'canonical delivery bytes differ' };
        if (nativeDelivery) {
          // The read is authenticated whole: its signed projection must prove the receipt it arrived with, not only the bytes.
          const report = deliveryReport(session, work.intake.settlementId);
          const verdict = await verifyNativeDemDeliveryReceipt(nativeDelivery, { jobId: session.jobId, logicalAddress, report, receipt: record.receipt,
            receiptContentHash: sha256Hex(canonicalize(report)), deliveryBinding: deliveryBinding(session.deliveryAdapter?.fulfilmentId),
            ...(record.signedProjection ? { signedProjection: record.signedProjection } : {}) });
          if (verdict !== 'valid') return { status: 'indeterminate', reason: `native delivery receipt is ${verdict} against the bytes read back` };
        }
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
        if (schemaUrl !== listing.offering.deliverable.schemaUrl || !candidateMatches(cleartextPayload, session, work.intake.settlementId, preparedInRun)) {
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
        // The runner submits again only on an absence that is authoritative: this seller never asked the
        // capability for this fulfilment, or the reader proved nothing was signed. A name index miss or an
        // unavailable read is no proof (CORE §5.1): a CREATE that landed would be made twice.
        if (nativeDelivery) {
          if (!(session.deliverySubmitted ?? []).includes(input.fulfilmentId)) return { status: 'absent', reason: 'this seller never submitted the Deliverable for this fulfilment' };
          const report = deliveryReport(session, work.intake.settlementId);
          let read;
          try { read = await readNativeDemDelivery(nativeDelivery, { jobId: session.jobId, logicalAddress: input.logicalAddress, report, receiptContentHash: sha256Hex(canonicalize(report)), deliveryBinding: deliveryBinding(input.fulfilmentId) }); }
          catch (error) { return { status: 'indeterminate', reason: `native delivery readback is unavailable: ${String(error?.code ?? 'unknown').slice(0, 64)}: ${String(error?.message ?? error).slice(0, 180)}` }; }
          if (isProvenUnsignedAbsence(read)) return { status: 'absent', reason: read.reason ?? 'the reader proved the Deliverable CREATE was never signed' };
          if (read?.status !== 'present') return { status: 'indeterminate', reason: `a submitted Deliverable CREATE did not read back: ${read?.reason ?? read?.status ?? 'missing'}` };
          if (!reportMatches(read.artifact, session, work.intake.settlementId)) return { status: 'indeterminate', reason: 'canonical delivery bytes differ' };
          // Older intents may lack the adapter checkpoint. Restore it from the authenticated read before the runner resolves delivery in this call.
          session.deliveryAdapter = { fulfilmentId: input.fulfilmentId, deliveryBinding: deliveryBinding(input.fulfilmentId), reconciliationId: read.receipt.transactionRef.value, substrate: 'source-native-delivery-recovered-readonly' };
          persist(session);
          return { status: 'accepted', reconciliationId: read.receipt.transactionRef.value };
        }
        const record = await readDelivery(input.logicalAddress,input.fulfilmentId);
        if (!record) return { status: 'absent', reason: 'current fence registered canonical delivery absence' };
        if (record.status === 'indeterminate') return { status: 'indeterminate', reason: `canonical delivery readback is unavailable: ${record.reason}` };
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

  const fixtureSettlement=nativeProfile?null:createFixtureSettlement({listing,validation,sellerBundle,claim,anchors,observer:observeDemosTransfer,receiptStore,
    sessionFor,commit,sign,signEvidence,reportFor:deliveryReport,persist,durable,bindSettlement,assertCredit:assertSettlementCredit,heldFor,now,
    error:(code,message,status=503)=>{throw new SellerAgentError(code,message,status);}});
  const settlementOperations=Object.freeze(nativeProfile?{commit:()=>{},payment:submitNativePaymentEvidence}:{commit:()=>{},payment:fixtureSettlement.submitPayment});
  async function submitPayment({jobId,txHash,payerPayingKey,nativePaymentEvidence:requestedEvidence}) {
    assertPaymentChain();
    const session=sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    assertRailPin(session.railPin,'in-flight');
    if(requestedEvidence!=null&&requestedEvidence!==NATIVE_PAYMENT_EVIDENCE)throw new SellerAgentError('native_evidence_selector_invalid','unknown native payment selector',409);
    if(requestedEvidence===NATIVE_PAYMENT_EVIDENCE||session.nativeEvidenceWork)return nativeProfile?settlementOperations.payment({session,jobId,txHash,payerPayingKey,requestedEvidence}):nativeUnavailable();
    if(nativeProfile)throw new SellerAgentError('native_evidence_required','the native seller profile takes payment only as native payment evidence',409);
    return settlementOperations.payment({jobId,txHash,payerPayingKey});
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
  // authenticated, read-only authorities. This reduction never dispatches a
  // CREATE; the owning journal alone prepares or reuses its exact bytes.
  // An old HTTP response or seller snapshot is no receipt/public projection.
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
    try { permit = await rawReceiptStore.inspectPermit(permitId); }
    catch(error) { return {disposition:'indeterminate',reason:`seller_native_evidence_permit_unavailable: ${String(error.message).slice(0,160)}`,code:String(error.code??'unknown').slice(0,64)}; }
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
      catch(error) { return {disposition:'indeterminate',reason:`seller_native_evidence_projection_unavailable: ${String(error.message).slice(0,160)}`,code:String(error.code??'unknown').slice(0,64)}; }
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
    work.publicSignedProjectionJson ??= JSON.stringify(authenticatedProjection);
    delete work.publicSignedProjection;
    session.stage = session.deliveryReady ? session.stage : 'native-payment-evidenced';
    persist(session);
    return { ...read, receipt: authenticatedReceipt, signedProjection: authenticatedProjection };
  }

  async function advanceAuthenticatedNativeDelivery(session, work, read) {
    if (!deliveryContext) return nativeEvidenceResponse(work, 'held-missing-consumed-v2-fulfilment-and-Vet-audit');
    if (nativeDelivery && session.deliveryReady) return readPersistedNativeDelivery(session, work);
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
    session.deliveryReady = { fulfilmentId: result.fulfilmentId, logicalAddress: result.logicalAddress, contentHash: deliveredHash, anchorReceipt: structuredClone(result.anchorReceipt),
      evidenceHash: result.evidenceHash, paymentPermitId: work.intake.permitId, finalisation: structuredClone(delivery.ready.finalisation), auditSource: structuredClone(delivery.auditSource),
      ...(nativeDelivery ? { deliveryBinding: nativeDeliveryBinding(session, work, result.fulfilmentId), substrate: 'source-native-one-node-delivery' } : { substrate: 'loopback-sr2-fixture' }) };
    session.stage = 'delivery-ready';
    persist(session);
    return nativeEvidenceResponse(work, { status: 'delivery-ready', fulfilmentId: result.fulfilmentId, logicalAddress: result.logicalAddress,
      contentHash: deliveredHash, anchorReceipt: result.anchorReceipt, evidenceHash: result.evidenceHash,
      ...(nativeDelivery ? { deliveryBinding: nativeDeliveryBinding(session, work, result.fulfilmentId) } : {}),
      substrate: nativeDelivery ? nativeDeliverySubstrate : 'mixed-test-native-payment-plus-loopback-sr2-delivery', evidencePublication: 'deferred-to-explicit-sdk-finaliser' });
  }

  async function readPersistedNativeDelivery(session, work) {
    const ready = session.deliveryReady, report = deliveryReport(session, work.intake.settlementId);
    const binding = nativeDeliveryBinding(session, work, ready.fulfilmentId);
    const reread = await readNativeDemDelivery(nativeDelivery, { jobId: session.jobId, logicalAddress: ready.logicalAddress, report, receiptContentHash: sha256Hex(canonicalize(report)), deliveryBinding: binding });
    const valid = reread.status === 'present' && reread.artifact && canonicalize(reread.artifact) === canonicalize(report) && ready.paymentPermitId === work.intake.permitId && ready.contentHash === sha256Hex(canonicalize(report)) &&
      canonicalize(ready.deliveryBinding) === canonicalize(binding) && sameNativeDeliveryReceipt(reread.receipt, ready.anchorReceipt) &&
      await verifyNativeDemDeliveryReceipt(nativeDelivery, {jobId:session.jobId,logicalAddress:ready.logicalAddress,report,receipt:reread.receipt,receiptContentHash:ready.contentHash,deliveryBinding:binding,signedProjection:reread.signedProjection}) === 'valid';
    if (!valid) return nativeEvidenceResponse(work, { status: 'held', reason: reread.reason ?? 'persisted SDK delivery-ready result did not authenticate on fresh native read' });
    return nativeEvidenceResponse(work, { status: 'delivery-ready', fulfilmentId: ready.fulfilmentId, logicalAddress: ready.logicalAddress,
      contentHash: ready.contentHash, anchorReceipt: reread.receipt, evidenceHash: ready.evidenceHash, deliveryBinding: binding,
      substrate: nativeDeliverySubstrate, evidencePublication: 'deferred-to-explicit-sdk-finaliser' });
  }

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
        walletJournal:walletJournal.journalId,journalVersion:1, anchorAttempts:0, anchorOutcome:'not-sent' };
      session.stage = 'native-payment-evidence-held'; persist(session);
      return { work };
    } catch (error) {
      if (durable.loadSession(jobId)?.nativeEvidenceWork) throw error;
      delete session.nativeEvidenceWork;
      const cause = typeof error?.code === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(error.code) ? error.code : step==='evidence-signing'?'evidence-signing-failed':'unclassified';
      return { answer: { status: paymentVerified || step === 'commitment-readback' || error?.status === 503 ? 'indeterminate' : 'rejected', reason: 'seller_native_evidence_not_started', step, cause } };
    }
  }

  async function ensureNativePaymentEvidence(session,work) {
    durable.assertHeld(session.jobId);assertSettlementCredit(session.jobId);
    // Bind only an older checkpoint that demonstrably predates its first call.
    if(!work.walletJournal&&work.anchorOutcome==='not-sent'&&!work.anchorAttempts&&!work.anchorAnswer){work.walletJournal=walletJournal.journalId;persist(session);}
    if(work.walletJournal!==walletJournal.journalId)throw new SellerAgentError('wallet_journal_changed','restore the original evidence journal',503);
    const terms=agreementTerms(session.agreement);
    const current=await verifySellerPaymentIntake({jobId:session.jobId,phaseIndex:terms.paymentPhaseIndex,railId:terms.rail,payerPayingKey:work.payerPayingKey,receipt:{kind:'pay-dem',txHash:work.txHash}},intakeDepsFor(session.jobId));
    if(current.disposition!=='verified'||!['claim','already-claimed'].includes(current.fulfilment)||current.settlementId!==work.intake.settlementId||current.permitId!==work.intake.permitId||current.evidenceHash!==work.intake.evidenceHash
      ||canonicalize(current.evidenceInput)!==canonicalize(work.intake.evidenceInput))throw new SellerAgentError('payment_readback_required',current.reason??'payment is not freshly authenticated',503);
    durable.assertHeld(session.jobId);assertSettlementCredit(session.jobId);
    work.anchorAttempts=(work.anchorAttempts??0)+1;persist(session);
    try {
      const answer=await walletJournal.ensureEvidence({expectedJournalId:work.walletJournal,authorize:()=>{assertSettlementCredit(session.jobId);return heldFor(session.jobId)();},logicalAddress:work.address,artifact:structuredClone(work.evidence),writer:claim,artifactKind:'SettlementEvidence',jobId:session.jobId,
        receiptContentHash:work.intake.evidenceHash,...(work.journalVersion===1?{}:{attempt:{outcome:work.anchorOutcome,answer:structuredClone(work.anchorAnswer??null)}})});
      work.journalVersion=1;work.anchorAnswer=walletAnswer(answer);work.anchorOutcome='sent';delete work.anchorError;
    } catch(error) {work.anchorError={code:String(error?.code??'unknown').slice(0,64),message:String(error?.message??error).slice(0,240)};}
    persist(session);
  }

  async function submitNativePaymentEvidence({ session, jobId, txHash, payerPayingKey, requestedEvidence }) {
    if (!nativeEvidence || requestedEvidence !== NATIVE_PAYMENT_EVIDENCE) throw new SellerAgentError('native_evidence_held', 'the explicit native evidence capability/terms are absent');
    if (!session.commitment || !session.agreementAnchor) throw new SellerAgentError('not_committed', 'native Agreement and seller commitment must be retained');
    const hash = paymentTxHash(txHash);
    let work = session.nativeEvidenceWork;
    if (work) {
      if (work.txHash !== hash || work.payerPayingKey !== payerPayingKey || work.agreementHash !== contentHash(session.agreement)
          || work.commitmentHash !== contentHash(session.commitment.record)) throw new SellerAgentError('seller_native_evidence_conflict', 'the retained exact payment/Agreement/commitment cannot change', 409);
      try { await commit({ jobId }, { readbackOnly: true }); }
      catch (error) {
        if (error instanceof SellerAgentError && !RETAINED_READBACK_FAILURES.has(error.code)) throw error;
        return heldNativeEvidence(work, { disposition: 'indeterminate', reason: `seller-commitment-readback-unavailable: ${String(error?.message ?? error).slice(0, 200)}`,
          code: typeof error?.code === 'string' ? error.code : 'unclassified' });
      }
      // Commitment readback adopts an authenticated copy of the session.
      // Continue on its checkpoint so later wallet answers are persisted.
      work = session.nativeEvidenceWork;
    } else {
      const started = await startNativePaymentEvidence({ session, jobId, hash, payerPayingKey });
      if (!started.work) return started.answer;
      work = started.work;
    }
    // A retained delivery is not a shortcut: the payment evidence it rests on is
    // authenticated again below, and advanceAuthenticatedNativeDelivery then
    // reads the Deliverable back.
    let read = await reduceNativeEvidenceWork(session, work, { jobId, txHash: hash, payerPayingKey });
    const missing=read.disposition==='absent'||read.disposition==='indeterminate'&&['name-index-miss','native-address-miss'].includes(read.nativeObservation);
    if(missing&&!work.nativeReceipt) {
      try {await ensureNativePaymentEvidence(session,work);}
      catch(error){work.anchorError={code:String(error?.code??'unknown').slice(0,64),message:String(error?.message??error).slice(0,240)};persist(session);}
      read=await reduceNativeEvidenceWork(session,work,{jobId,txHash:hash,payerPayingKey});
    }
    if(read.disposition==='absent')read={...read,disposition:'indeterminate',reason:'native-payment-evidence-not-read-back'};
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
    refuseBundleFinalization();
  }

  // ---- One fenced recovery of an uncertain authenticated transport command ----
  // Runs under the job fence, after the transport store's claim and the
  // authenticated restore (reconcileTransport). The exact request is checked
  // again against the restored session, then one closed table runs it: live,
  // through the command's own durable reducer, whose journals replay what was
  // signed or sent; under an expired delegation, read back only.
  const proposalWork = (jobId) => { const s = durable?.loadSession(jobId) ?? sessions.get(jobId); return Boolean(s?.agreementSignatureKey || s?.sellerContribution || s?.commitment); };
  // Work of exactly this command that forbids releasing its effect.
  const retainedWork = (path, jobId, body) => path === '/dacs/v1/agreements/proposals' ? proposalWork(jobId) : path === '/dacs/v1/payments' && api.retainsPaymentClaim(jobId, body);
  async function recoverTransport({ request, body, rawBody, readOnly, transport }) {
    const same = (a, b) => canonicalize(a) === canonicalize(b);
    const proposal = request.path === '/dacs/v1/agreements/proposals', session = sessions.get(request.jobId) ?? null;
    const identity = proposal ? body.transportIdentity : session?.transportIdentity;
    let decoded; try { decoded = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch { /* differs below */ }
    if (request.method !== 'POST' || request.seller !== claim || !same(request.listingPin, pin) || sha256Hex(rawBody) !== request.bodyHash || decoded === undefined || !same(decoded, body) ||
        request.jobId !== (body.transportIdentity?.jobId ?? body.jobId) || identity?.seller !== claim || request.buyer !== identity?.buyer || request.agreementHash !== identity?.agreementHash ||
        (proposal ? request.buyer !== body.buyerIdentityBundle?.presentedBy : request.agreementHash !== session?.agreementHash)) return { held: 'seller_transport_context_mismatch' };
    try {
      switch (request.path) {
        case '/dacs/v1/agreements/proposals': {
          if (!readOnly) { const answer=await receiveProposal(body,{transport});transport?.check();return {answer}; }
          // Read only, a proposal completes from its durable final checkpoint
          // alone, never from a contribution saved without it.
          if (!session?.proposal || !session.sellerContribution || !same(body.proposal, session.proposal) || !same(body.transportIdentity, session.transportIdentity) ||
              session.agreementHash !== request.agreementHash || session.sellerContributionProposalHash !== body.proposal.proposalHash ||
              session.buyerBundleHash !== identityBundleHash(body.buyerIdentityBundle)) return { held: 'seller_proposal_state_incomplete' };
          assertVetContext(); assertSessionAdmission(); assertRailPin(session.railPin, 'in-flight');
          assertBuyer(request.buyer, request.jobId, { proposal: true });
          const agreement = await finalizeFixedPriceAgreementContributions(session.proposal.plan, [session.proposal.buyerContribution, session.sellerContribution], contributionVerifier);
          return contentHash(agreement) === request.agreementHash ? { answer: { disposition: 'complete', contribution: structuredClone(session.sellerContribution) } } : { held: 'seller_proposal_state_incomplete' };
        }
        case '/dacs/v1/agreements/state': return { answer: agreementState(body.transportIdentity) };
        case '/dacs/v1/commitments': case '/dacs/v1/commitments/signature': {
          const proof = await reconcileCommitmentTransport({ request, body, readOnly });
          return proof?.disposition === 'present' ? { answer: proof.value } : { held: proof?.reason ?? 'seller_commitment_readback_indeterminate', cause: proof?.cause };
        }
        case '/dacs/v1/payments': {
          if (session.nativeEvidenceWork || (nativeEvidence && body.nativePaymentEvidence === NATIVE_PAYMENT_EVIDENCE)) {
            const work = session.nativeEvidenceWork ?? null;
            if (body.nativePaymentEvidence !== NATIVE_PAYMENT_EVIDENCE || body.payerPayingKey !== request.buyer ||
                (work && (work.txHash !== paymentTxHash(body.txHash) || work.payerPayingKey !== request.buyer))) {
              return { held: 'seller_native_delivery_context_mismatch' };
            }
            // Native payment recovery can sign or send retained wallet work.
            // Only a live delegation may run it; fixture readback below is pure.
            if (readOnly) return { held: 'peer_delegation_expired: a payment claim runs again only under a live session delegation' };
            assertPaymentChain();
            return { answer: work
              ? await submitNativePaymentEvidence({ session, jobId: request.jobId, txHash: body.txHash, payerPayingKey: body.payerPayingKey, requestedEvidence: body.nativePaymentEvidence })
              : await submitPayment(body) };
          }
          const work = session?.nativeEvidenceWork ?? session?.paymentWork;
          if (work && (work.txHash !== paymentTxHash(body.txHash) || work.payerPayingKey !== body.payerPayingKey)) return { held: 'seller_payment_context_mismatch' };
          if (!readOnly) return { answer: await submitPayment(body) };
          return fixtureSettlement ? { answer: await fixtureSettlement.readPayment(body) } : { held: 'seller_payment_readback_unavailable' };
        }
        case '/dacs/v1/bundles/request': case '/dacs/v1/bundles/countersignature': case '/dacs/v1/bundles/buyer-copy': return { held: 'bundle_finalization_unavailable' };
        default: return { held: 'seller_transport_reconciliation_unsupported' };
      }
    } catch (error) { return { error }; }
  }

  // Seller-owned recovery seam, deliberately not an HTTP route. It resumes
  // only retained, previously verified work after every unknown anchor has
  // authenticated exact readback. Absence never authorizes resubmission.
  async function resume({ jobId }) {
    const session = sessionFor(jobId);
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
    assertAuthenticatedPayment:()=>{assertPaymentChain();if(nativeProfile)return;throw new SellerAgentError('settlement_profile_unavailable','authenticated payment recovery is not assembled',503);},
    assertSettlementCredit,
    claim,
    listingPin: pin,
    issueSessionChallenge,
    receiveProposal: recoveryCall(receiveProposal),
    agreementState,
    commit: recoveryCall(commit),
    // Reauthenticates cached transport answers without authorizing a new CREATE.
    readCommitment: recoveryCall(({jobId,signedProjection,signatureAgreement}) => commit({jobId,signedProjection}, {readbackOnly:true,signatureAgreement})),
    // The one recovery of an uncertain authenticated command. The HTTP
    // transport hands in its store capabilities: claim, inside the job fence
    // before anything is restored or run, and settle, before the fence is
    // released. A trusted direct caller without them only gets the outcome.
    reconcileTransport: durable ? ({ transport, ...input } = {}) => durable.withJob(input.request?.jobId, async (session) => {
      const claimed=transport?.claim();
      const { path, jobId } = input.request, readOnly = input.readOnly === true || claimed?.live===false;
      let result;
      // An unpaid outside buyer only has issued unknown writes inspected:
      // nothing is restored or run. Live and read-only proposal replay each
      // apply the proposal wallet and profile gates themselves.
      if (path !== '/dacs/v1/agreements/proposals' && access && session && buyerAccessClosed(session, jobId)) {
        result = { held: await readIssued?.(jobId, { unknownOnly: true }) ? 'buyer_access_closed; issued unknown writes inspected read-only; retained outcome unchanged' : 'buyer_access_closed; no unknown issued write, nothing was read; retained outcome unchanged' };
      } else { sessions.delete(jobId); await restore(session); result = await recoverTransport({ ...input, readOnly, transport:typeof claimed?.check==='function'?claimed:undefined }); }
      const outcome = transportOutcome(path, result, { retained: retainedWork(path, jobId, input.body), recovering: true, readOnly });
      if (outcome.settle) transport?.settle(outcome);
      return outcome;
    }) : undefined,
    commitOnSignature: recoveryCall((input) => {
      if (!input || canonicalize(Object.keys(input).sort()) !== canonicalize(['agreement', 'jobId', 'signedProjection']) || !input.agreement || typeof input.agreement !== 'object') throw new SellerAgentError('signature_agreement_invalid', 'expected exactly jobId, Agreement and signedProjection');
      return commit({ jobId: input.jobId, signedProjection: input.signedProjection }, { signatureAgreement: input.agreement });
    }),
    submitPayment: recoveryCall(submitPayment),
    bundleRequest: recoveryCall(bundleRequest),
    countersign: recoveryCall(countersign),
    confirmBuyerCopy: recoveryCall(confirmBuyerCopy),
    transportAgreementOf: (jobId) => {
      const session = sessionView(durable?.loadSession(jobId) ?? sessions.get(jobId));
      return structuredClone(session?.agreement ?? session?.proposal?.plan?.draft ?? null);
    },
    stageOf: (jobId) => sessionView(durable?.loadSession(jobId) ?? sessions.get(jobId))?.stage ?? null,
    deliveryStateOf: (jobId) => {
      assertSettlementCredit(jobId);
      const session = sessionView(durable?.loadSession(jobId) ?? sessions.get(jobId));
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
      // An unverified retained session retains nothing: the transport may
      // release the claim's effect rather than keep work it cannot attribute.
      if (session && (retainedSnapshotProblem(session) ?? retainedSessionProblem(session))) return false;
      const work = session?.nativeEvidenceWork ?? session?.paymentWork;
      return Boolean(work) && work.txHash === paymentTxHash(txHash) && work.payerPayingKey === payerPayingKey;
    },
    // Whether this seller retains proposal work for the job (a signature
    // intent, a contribution or a commitment): the transport then never
    // releases its proposal effect. Synchronous and read only.
    retainsProposalWork: (jobId) => proposalWork(jobId),
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
    resume: durable ? recoveryCall(resume,async(session,jobId)=>{
      if(access&&session?.buyerBundle&&buyerAccessClosed(session,jobId)){
        const unknown=await readIssued?.(jobId,{unknownOnly:true});if(unknown)return unknown;
        throw new SellerAgentError('buyer_access_closed','this operator accepts only its configured custody buyer while openBuyerAccess is off; no unknown issued write remains to read back',409);
      }
    }) : undefined,

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
