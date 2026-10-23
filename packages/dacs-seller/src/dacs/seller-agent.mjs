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
export async function createSellerAgent({ signer, listing, anchors, observeDemosTransfer, now = () => Date.now(), receiptStore: suppliedReceiptStore, durableDirectory, agreementAnchor = null, nativePaymentEvidence = null, demDeliveryContext = null, nativeDemDelivery = null, nativeArtifactAnchor = null, deliverableProducer = null, deliverySchemaVerifier = null, maxJobs = DEFAULT_SELLER_MAX_JOBS, deliveryEvidenceEnabled = false, buyerAccess = null, readIssued = null, commitOnSignature = false, signatureBuyer = null, signatureCommitmentReady = null, contextRequest = null, railAuthority = null, sessionAdmission = null, reconcilePaymentEvidence = null, simulatedFixture = false }) {
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1) throw new TypeError('maxJobs must be a positive safe integer');
  commitOnSignature = commitOnSignatureConfig(commitOnSignature);
  if (typeof simulatedFixture !== 'boolean') throw new TypeError('simulatedFixture must be true or false');
  if (signatureBuyer !== null && !/^did:demos:agent:[0-9a-f]{64}$/.test(signatureBuyer)) throw new TypeError('signatureBuyer must be an admitted buyer claim or null');
  if (signatureCommitmentReady !== null && typeof signatureCommitmentReady !== 'function') throw new TypeError('signatureCommitmentReady must be a function or null');
  if (commitOnSignature && !durableDirectory) throw new TypeError('commitment on signature requires durable seller state');
  if (!signer?.claim || typeof signer.sign !== 'function') throw new Error('a seller signer (claim + sign) is required');
  if (agreementAnchor !== null && (typeof agreementAnchor?.readAgreement !== 'function' || typeof agreementAnchor.source !== 'string')) throw new Error('agreementAnchor must expose source and readAgreement');
  if (listing?.seller?.identity?.presentedBy !== signer.claim) throw new Error('the seller signer does not control this Listing');
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
  const inlineSizeProblem = nativeProfile && (!Number.isSafeInteger(inlineSize) || inlineSize < minimumReportSize ||
    (inlineSize > minimumReportSize && inlineSize < minimumReportSize + 5))
    ? `unsupported Listing: inline storage delivery requires expectedSizeBytes equal to ${minimumReportSize} or between ${minimumReportSize + 5} and 131072` : null;
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
  const sign = (bytes) => new Uint8Array(durable ? durable.signOnce(`signature:${sha256Hex(bytes)}`, Buffer.from(bytes)) : signer.sign(Buffer.from(bytes)));
  const rawReceiptStore = durable?.receiptStore ?? suppliedReceiptStore ?? createInMemorySellerReceiptStore();
  const retainedAdmission = durable?.context();
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
    issueChallenge: (nonce, value) => {
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
    admitChallenge: (nonce, presentationHash) => { const prior = memoryChallenges.get(nonce); if (prior?.attempt?.presentationHash === presentationHash) prior.attempt.admitted = true; },
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
  const deliveryReport=(session,settlementId)=>{
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
  const recoveryCall = (fn) => durable ? (input) => durable.withJob(input?.transportIdentity?.jobId ?? input?.jobId, async (session) => {
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
    if (bundle.presentedBy === claim) throw new SellerAgentError('self_dealing', 'the buyer is the seller');
  }

  // CORE SN-1..SN-3: the seller issues the presentation challenge for a job and
  // buyer before the buyer presents; the operator hands it to the buyer (its
  // transport is out of scope). Only this verifier generates the nonce:
  // 256 bits from the CSPRNG (SN-1/SN-2), never caller-supplied bytes.
  // It admits one presentation (SN-4) until
  // SESSION_CHALLENGE_LIFETIME_MS after issue.
  function issueSessionChallenge({ jobId, buyer, sessionNonce } = {}) {
    if (!nativeProfile) throw new SellerAgentError('session_admission_required', 'the simulated fixture profile takes no session admission', 503);
    if (!isCanonicalJobId(jobId)) throw new SellerAgentError('job_invalid', 'jobId is not canonical');
    if (typeof buyer !== 'string' || !/^did:demos:agent:[0-9a-f]{64}$/.test(buyer) || buyer === claim) throw new SellerAgentError('buyer_invalid', 'the challenge names no buyer claim other than the seller');
    if (sessionNonce !== undefined) throw new SellerAgentError('challenge_invalid', 'the seller generates its own session nonce (CORE SN-1/SN-2)');
    const nonce = randomBytes(32).toString('hex'), issuedAt = now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new SellerAgentError('seller_clock_invalid', 'the seller clock is not an integer time', 503);
    const issued = { jobId, buyer, sessionNonce: nonce, issuedAt, expiresAt: issuedAt + SESSION_CHALLENGE_LIFETIME_MS };
    try { challenges.issueChallenge(nonce, issued); }
    catch (error) { if (error.code === 'seller_challenge_taken') throw new SellerAgentError('challenge_taken', 'this session nonce was issued before', 409); throw error; }
    return issued;
  }

  // ---- DACS-3: proposal -> seller contribution ----
  async function receiveProposal({ proposal, transportIdentity, buyerIdentityBundle }) {
    const jobId = transportIdentity?.jobId;
    if (!isCanonicalJobId(jobId)) throw new SellerAgentError('job_invalid', 'jobId is not canonical');
    assertVetContext();
    assertSessionAdmission();
    const existing = sessions.get(jobId);
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
    if (transportIdentity.buyer !== buyerIdentityBundle.presentedBy) throw new SellerAgentError('buyer_mismatch', 'proposal buyer is not the presented identity');
    if (existing && existing.buyerBundleHash !== bundleHash) throw new SellerAgentError('job_taken', 'this job is bound to another buyer', 409);
    // A new session is admitted before anything of it is kept, read, signed or sent.
    if (newSession) {
      // CORE SN-1..SN-3: the bundle's sessionNonce must be a challenge this
      // seller issued for this job and buyer (issueSessionChallenge), not expired
      // on first admission. DACS-1 §6.3.2 reverifies the retained accepted
      // presentation on retry; it does not accept its consumed nonce anew.
      const challengeProblem = !issued ? 'the presentation nonce is not a challenge this seller issued'
        : issued.jobId !== jobId || issued.buyer !== buyerIdentityBundle.presentedBy ? 'the presentation nonce is a challenge issued for another job or buyer'
          : issued.attempt !== null && !(issued.attempt.presentationHash === presentationHash && issued.attempt.admitted === true) ? 'the presentation challenge was consumed by an earlier presentation attempt'
            : issued.attempt === null && !(now() < issued.expiresAt) ? 'the presentation challenge expired' : null;
      if (challengeProblem) throw new SellerAgentError('session_not_admitted', challengeProblem, 409);
      // DACS-1 RB-4..RB-6, LR-3: the seller decides revocation itself (core
      // checkListingRevocation) over the operator's readings; only `absent` opens.
      const revocation = await listingRevocationProblem(admission, { listing, listingPin: pin, jobId, now });
      if (revocation) throw new SellerAgentError(revocation.code, revocation.message, revocation.status);
      const query = { jobId, buyer: buyerIdentityBundle.presentedBy, buyerBundleHash: bundleHash, sessionNonce: nonce,
        seller: claim, listingPin: structuredClone(pin), profile: structuredClone(SELLER_PROFILE) };
      let answer;
      try { answer = await admission.admit(structuredClone(query)); }
      catch (error) { throw new SellerAgentError('session_admission_unavailable', `the seller's session admission is unavailable: ${String(error?.message ?? error).slice(0, 180)}`, 503); }
      const problem = sessionAdmissionProblem(answer, query);
      if (problem) throw new SellerAgentError('session_not_admitted', problem, 409);
      challenges.admitChallenge(nonce, presentationHash);
    }
    if (!existing) sessions.set(jobId, { jobId, buyerBundle: structuredClone(buyerIdentityBundle), buyerBundleHash: identityBundleHash(buyerIdentityBundle), proposal: null, stage: 'proposed', ...(railPin ? { railPin } : {}) });
    else if (railPin && !inFlight) existing.railPin = railPin;
    const session = sessions.get(jobId);
    persist(session);
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
            for (const [role, party, bundle, verifier] of parties) {
              const ref = resolved.input[role].vetRecordRef;
              const invocation = resolved.vetRequirements.find((entry) => canonicalize(entry.vetRecordRef) === canonicalize(ref));
              let record;
              try { record = await admission.resolveVetRecord(structuredClone({ jobId, role, party, ref })); }
              catch (error) { return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: the ${role} Vet record is unavailable: ${String(error?.message ?? error).slice(0, 160)}` }; }
              const problem = await vetRecordProblem(record, { ref, jobId, party, bundleHash: identityBundleHash(bundle), verifier, invocation, now });
              if (problem) return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: ${role}: ${problem}` };
              // DACS-2 VPC-3: a signed record is no admitted one. It is relied on
              // only with its SR-2 receipt at `accepted` or later, before any signature.
              let receipt;
              try { receipt = await admission.readVetAnchorReceipt(structuredClone({ jobId, role, party, ref })); }
              catch (error) { return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: the ${role} Vet record SR-2 receipt is unavailable: ${String(error?.message ?? error).slice(0, 160)}` }; }
              const receiptProblem = vetAnchorReceiptProblem(receipt, { ref, jobId, party });
              if (receiptProblem) return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: ${role}: ${receiptProblem}` };
              // CORE SR2-4: the receipt's fields alone are assertions, not proof.
              // Only the operator's authentication of this record's receipt passes.
              let verdict;
              try { verdict = await admission.verifyVetAnchorReceipt(structuredClone({ jobId, role, party, ref, record, receipt })); }
              catch (error) { return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: the ${role} Vet record SR-2 receipt could not be verified: ${String(error?.message ?? error).slice(0, 160)}` }; }
              if (verdict !== 'valid') return { disposition: 'rejected', reason: `VET_RECORD_UNVERIFIED: ${role}: the Vet record SR-2 receipt is not verified (${typeof verdict === 'string' ? verdict.slice(0, 40) : 'no verdict'})` };
            }
            session.demDeliveryContext = structuredClone(resolved);
            persist(session);
            return { disposition: 'present', value: structuredClone(resolved.input) };
          }
          persist(session);
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
    if (progress.disposition !== 'complete') return { disposition: progress.disposition, stage: progress.stage, reason: progress.reason };
    session.proposal = structuredClone(proposal);
    session.transportIdentity = structuredClone(transportIdentity);
    session.agreementHash = transportIdentity.agreementHash;
    const agreementRef = { anchor: { kind: 'storage-program', locator: fixedPriceAgreementLogicalAddress(jobId) }, contentHash: session.agreementHash };
    recordPhase(session, 0, session.proposalAdmission.observedAt, { ok: true,
      contextDelta: { 'negotiate-fixed-price': { agreementHash: session.agreementHash, agreementRef } } });
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
  async function readBuyerAgreement(agreementAddress, buyer, agreementHash, signedProjection) {
    if (agreementAnchor) {
      const read = await agreementAnchor.readAgreement({ logicalAddress: agreementAddress, writer: buyer, agreementHash, ...(signedProjection === undefined ? {} : { signedProjection }) });
      if (read.disposition === 'present') return { agreement: read.artifact, ref: read.ref, native: read.native };
      if (read.disposition === 'absent') throw new SellerAgentError('agreement_not_anchored', 'the buyer has not anchored the Agreement');
      if (read.disposition === 'indeterminate') throw new SellerAgentError('substrate_unavailable', `SR-2 Agreement read is indeterminate: ${read.reason}`, 503);
      throw new SellerAgentError('agreement_anchor_invalid', `Agreement anchor is not the buyer write: ${read.reason}`);
    }
    let record;
    try {
      record = await anchors.read(agreementAddress);
    } catch (error) {
      throw new SellerAgentError('substrate_unavailable', `SR-2 read failed: ${error.message}`, 503);
    }
    if (record.status !== 'present') throw new SellerAgentError('agreement_not_anchored', 'the buyer has not anchored the Agreement');
    if (verifyFixtureRecord(record, { logicalAddress: agreementAddress, expectedWriter: buyer }) !== 'valid') throw new SellerAgentError('agreement_anchor_invalid', 'Agreement anchor is not the buyer write');
    return { agreement: record.artifact, ref: fixtureRef(agreementAddress, contentHash(record.artifact)), native: null };
  }
  const nativeAgreementView = (native) => ({ source: native.source, evidenceMode: native.evidenceMode, nativeAddress: native.nativeAddress, txRef: native.txRef });

  function retainCommitmentPhase(session, finalized) {
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
    // Once a native commitment has been finalized, every later entry through
    // the public commit path is reconciliation. An absent fresh observation is
    // not authority to publish another CREATE for the same logical address.
    const retainedNativeCommitment = Boolean(nativeArtifactAnchor && session.commitment);
    if (!early && session.commitment && !durable) return { status: 'committed', address: session.commitment.logicalAddress, resumed: true };
    if (!session.agreementHash) throw new SellerAgentError('not_agreed', 'no Agreement contribution was made for this job');
    const agreementAddress = fixedPriceAgreementLogicalAddress(jobId);
    const projection = signedProjection ?? session.agreementSignedProjection;
    let candidate;
    if (early) {
      try {
        candidate = await verifySignatureAgreement(signatureAgreement, session, contributionVerifier);
        verifyAgreementCreateAuthorization(signedProjection, candidate, agreementAddress, session.buyerBundle.presentedBy);
      }
      catch (error) { throw new SellerAgentError('signature_agreement_invalid', String(error.message).slice(0, 240)); }
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
      catch { throw new SellerAgentError('signature_connection_unavailable', 'early commitment connection reservation is unavailable', 503); }
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
          commitmentSigner: { algorithm: 'ed25519', signer: claim, sign: (bytes) => { if (readbackOnly && (early || session.signatureCommitmentAttempt)) readbackRequired(); return sign(bytes); } },
        },
        nativeArtifactAnchor ? {
          resolve: async (logicalAddress) => {
            const read=await nativeArtifactAnchor.readRetained({logicalAddress,artifactKind:'FinalityCommitmentRecord'});
            if(read.status==='absent') {
              commitmentProvenUnsigned = isProvenUnsignedAbsence(read);
              if (session.commitmentPublishAsked && !commitmentProvenUnsigned) return { disposition: 'indeterminate', reason: 'a requested commitment CREATE has no authenticated readback or proof that nothing was signed' };
              return {disposition:'absent'};
            }
            if(read.status!=='present') return {disposition:read.status==='rejected'?'rejected':'indeterminate',reason:read.reason};
            nativeCommitmentProjection=read.signedProjection;
            return {disposition:'present',anchored:{record:read.artifact,nativeAddress:read.receipt.nativeAddress,anchorTxRef:read.txRef,anchorReceipt:read.receipt}};
          },
          verifyAnchorReceipt: async (anchored) => nativeArtifactAnchor.verifyReceipt({logicalAddress:anchored.anchorReceipt.logicalAddress,artifact:anchored.record,artifactKind:'FinalityCommitmentRecord',receipt:anchored.anchorReceipt,signedProjection:nativeCommitmentProjection}),
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
      throw new SellerAgentError('commitment_failed', String(error?.message ?? error).slice(0, 240));
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
      if(contentHash(retained.record)!==contentHash(finalized.record) || retained.logicalAddress!==finalized.logicalAddress ||
          canonicalize(retained.anchorTxRef)!==canonicalize(finalized.anchorTxRef) || !sameNativeCommitmentReceipt(retained.anchorReceipt,finalized.anchorReceipt)) {
        throw new SellerAgentError('commitment_changed','fresh native commitment readback differs from the retained finalized commitment',503);
      }
      session.agreement=agreement;session.agreementRef=agreementRef;
      if(native)session.agreementAnchor=nativeAgreementView(native);
      session.stage='committed';persist(session);
      return {status:'committed',address:retained.logicalAddress,resumed:true,...(native?{agreementAnchor:nativeAgreementView(native)}:{})};
    }
    session.agreement = agreement;
    session.agreementRef = agreementRef;
    if (native) session.agreementAnchor = nativeAgreementView(native);
    session.commitment = finalized;
    session.stage = 'committed';
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
    observeDemosTransfer: (txHash) => observeDemosTransfer(txHash),
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

  function sameNativeCommitmentReceipt(left, right) {
    if (!left || !right || !Number.isSafeInteger(left.blockRef?.timestamp) || !Number.isSafeInteger(right.blockRef?.timestamp)) return false;
    const stable = ['receiptVersion','substrate','finalityProfile','logicalAddress','nativeAddress','contentHash','writer','nonce','state','observationDisposition'];
    return stable.every((key)=>canonicalize(left[key])===canonicalize(right[key])) &&
      canonicalize(left.transactionRef)===canonicalize(right.transactionRef) &&
      canonicalize({ id:left.blockRef.id, height:left.blockRef.height })===canonicalize({ id:right.blockRef.id, height:right.blockRef.height });
  }

  // A lost response after the native Deliverable CREATE has applied leaves the
  // SDK's durable delivery WAL at an intent. Before re-entering that runner,
  // authenticate the exact original public projection and retain only the
  // fulfilment binding the runner already returned. Absence/indeterminate
  // readback is deliberately non-authoritative here: it must never turn a
  // caller retry into another seller approval or CREATE. The one exception is
  // an absence the reader proved (a shutdown cut the approval before anything
  // was signed): the runner then reconciles its WAL, reads the same absence
  // and submits again, which asks the operator again.
  async function submitPayment({ jobId, txHash, payerPayingKey, nativePaymentEvidence: requestedEvidence }) {
    assertSettlementChain();
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    assertRailPin(session.railPin, 'in-flight');
    if (requestedEvidence === NATIVE_PAYMENT_EVIDENCE || session.nativeEvidenceWork) return submitNativePaymentEvidence({ session, jobId, txHash, payerPayingKey, requestedEvidence });
    // The fixture intake below claims the transfer, then anchors through the
    // fixture substrate, which the native profile does not have.
    if (nativeProfile) throw new SellerAgentError('native_evidence_required', 'the native seller profile takes payment only as native payment evidence', 409);
    if (session.payment) {
      if (session.payment.txHash !== paymentTxHash(txHash)) throw new SellerAgentError('payment_already_recorded', 'this job already has a verified payment', 409);
      return publicPayment(session);
    }
    if (!session.commitment) throw new SellerAgentError('not_committed', 'the Agreement is not committed; no payment is accepted before commitment');
    if (durable) await commit({ jobId }); // fresh authenticated commitment readback
    const terms = agreementTerms(session.agreement);
    if (session.paymentWork && (session.paymentWork.txHash !== paymentTxHash(txHash) || session.paymentWork.payerPayingKey !== payerPayingKey)) throw new SellerAgentError('seller_payment_work_conflict', 'a different verified claim is retained for this job', 503);
    const intake = session.paymentWork?.intake ?? await verifySellerPaymentIntake({ jobId, phaseIndex: terms.paymentPhaseIndex, railId: terms.rail, payerPayingKey, receipt: { kind: 'pay-dem', txHash } }, intakeDepsFor(jobId));
    if ([...settlementJobs].some(([id,claims]) => claims.has(jobId) && !hasSettlementCredit(id,jobId))) return { status: 'indeterminate', reason: 'settlement-collision' };
    if (intake.disposition !== 'verified' || (intake.fulfilment !== 'claim' && intake.fulfilment !== 'already-claimed')) {
      return { status: intake.disposition === 'indeterminate' ? 'indeterminate' : 'rejected', reason: intake.reason };
    }
    if (!bindSettlement(intake.settlementId, jobId)) return { status: 'indeterminate', reason: 'settlement-collision' };
    if (durable && !session.paymentWork) {
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

  // ---- DACS-5: completed two-sided bundle ----
  // DACS-5 §10.3.1 ST-11 and CORE §5.1 SR2-9: a completed bundle is signed
  // only after every required record (both Vet records, the commitment, the
  // settlement evidence and the bundle copy itself) has a finalized receipt
  // and resolves independently. That finalizer is not wired here, so no
  // profile signs, countersigns or anchors a completed bundle.
  const refuseBundleFinalization = () => {
    throw new SellerAgentError('bundle_finalization_unavailable', 'the seller signs no completed DACS-5 bundle: the ST-11 finalizer (finalized, independently resolved Vet, commitment, settlement and bundle records) is not available', 503);
  };
  function sessionFacts(session) {
    return bundleSession({
      agreement: session.agreement,
      agreementRef: session.agreementRef,
      commitmentRef: fixtureRef(session.commitment.logicalAddress, contentHash(session.commitment.record)),
      payment: session.payment.ref,
      delivery: session.payment.deliveryRef,
      observed: { txHash: session.payment.txHash, blockNumber: session.payment.blockNumber },
      finalisedAt: session.finalisedAt,
    });
  }

  async function bundleRequest({ jobId }) {
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    if (!session.payment) throw new SellerAgentError('not_delivered', 'nothing was delivered for this job');
    refuseBundleFinalization();
    session.finalisedAt ??= Math.max(now(), session.payment.deliveredAt);
    persist(session);
    const facts = sessionFacts(session);
    const plan = await bundleSigningPlan(facts);
    session.bundleHash = plan.bundleHash;
    session.sellerBundleSignature ??= Buffer.from(sign(plan.payload)).toString('base64url');
    persist(session);
    return { jobId, finalisedAt: session.finalisedAt, bundleHash: plan.bundleHash, sellerSignature: session.sellerBundleSignature };
  }

  async function countersign({ jobId, buyerSignature }) {
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    refuseBundleFinalization();
    if (!session.bundleHash) throw new SellerAgentError('no_bundle_request', 'request the bundle first');
    const facts = sessionFacts(session);
    const { copies, problems } = await assembleBundleCopies(facts, { buyer: buyerSignature, seller: session.sellerBundleSignature });
    if (problems.length) throw new SellerAgentError('bundle_invalid', problems.join('; '));
    if (durable) {
      if (session.countersignatureWork && session.countersignatureWork.buyerSignature !== canonicalSignature(buyerSignature)) throw new SellerAgentError('seller_bundle_work_conflict', 'a different countersignature is retained', 503);
      session.countersignatureWork = { buyerSignature: canonicalSignature(buyerSignature) };
      persist(session);
    }
    const anchored = await anchorOnce(bundleAddress(jobId, 'seller'), copies.sellerCopy);
    session.sellerCopy = copies.sellerCopy;
    session.stage = 'seller-copy-anchored';
    persist(session);
    return { status: 'seller-copy-anchored', address: anchored.ref.anchor.locator, bundleHash: session.bundleHash };
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

  // A reducer for an ALREADY reserved authenticated HTTP command.
  // Ordinary commitments resume under their anchor journal and the job fence
  // while the delegation is live; uncertain sends require readback.
  // Commit-on-signature reconciliation uses the readback-only gate; it cannot
  // sign or submit. An interrupted proposal resumes through the durable
  // responder under its original authenticated request and live delegation.
  // The other exception is a payment claim with retained native
  // evidence work: it runs that work's own retained step (submitNativePaymentEvidence),
  // whose durable anchor record governs every send, and answers `retry` while
  // it is not final, or `no-effect` when it ended before the work checkpoint
  // with a definite answer that kept nothing. `readOnly` (a request whose
  // session delegation expired) never runs it: the claim stays uncertain.
  // A transport cached answer is never evidence; retained seller-authenticated work must
  // agree with the pinned receipt authority and exact fresh native readback.
  // Local authenticated snapshots may advance after those facts are verified.
  async function reconcileTransport({ request, body, rawBody, readOnly = false }) {
    const held = (reason) => ({ disposition: 'indeterminate', reason });
    const same = (a, b) => canonicalize(a) === canonicalize(b);
    const session = sessions.get(request.jobId);
    // A proposal interrupted at any persistence boundary resumes through the
    // durable responder, whose authenticated checkpoints and signOnce govern
    // every signature/publication. The HTTP cache cannot seal an unfinished
    // proposal. Validate the exact authenticated request before resuming it.
    if (request.path === '/dacs/v1/agreements/proposals' && !readOnly) {
      const identity = body.transportIdentity;
      if (request.method !== 'POST' || request.jobId !== identity?.jobId || request.seller !== claim ||
          request.buyer !== identity?.buyer || identity?.seller !== claim || request.buyer !== body.buyerIdentityBundle?.presentedBy ||
          request.agreementHash !== identity?.agreementHash || !same(request.listingPin, pin) ||
          sha256Hex(rawBody) !== request.bodyHash || !same(JSON.parse(Buffer.from(rawBody).toString('utf8')), body)) return held('seller_transport_context_mismatch');
      try {
        const answer = await receiveProposal(body);
        return { disposition: answer.disposition === 'complete' ? 'present' : 'retry', value: answer };
      } catch (error) { return held(error.code ?? 'seller_proposal_indeterminate'); }
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
        const projection = body.signedProjection ?? session.agreementSignedProjection;
        const read = await agreementAnchor.readAgreement({ logicalAddress: address, writer: request.buyer, agreementHash: request.agreementHash, ...(projection === undefined ? {} : { signedProjection: projection }) });
        if (read.disposition !== 'present' || contentHash(read.artifact) !== request.agreementHash) throw new SellerAgentError('seller_agreement_readback_required', 'exact authenticated native Agreement is unavailable', 503);
        agreementRecord = { artifact: read.artifact };
        agreementRef = read.ref;
        native = read.native;
      } else {
        agreementRecord = await anchors.read(address);
        if (verifyFixtureRecord(agreementRecord, { logicalAddress: address, expectedWriter: request.buyer }) !== 'valid' ||
            contentHash(agreementRecord.artifact) !== request.agreementHash) throw new SellerAgentError('seller_agreement_readback_required', 'exact authenticated Agreement is unavailable', 503);
      }
      const logicalAddress=finalityCommitmentAddress(request.jobId);
      const record = nativeArtifactAnchor
        ? await nativeArtifactAnchor.readRetained({logicalAddress,artifactKind:'FinalityCommitmentRecord'})
        : await durable.readAnchor({ jobId: request.jobId, logicalAddress, anchors });
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
        verifyAnchorReceipt: nativeArtifactAnchor ? async(anchored)=>nativeArtifactAnchor.verifyReceipt({logicalAddress,artifact:anchored.record,artifactKind:'FinalityCommitmentRecord',receipt:anchored.anchorReceipt,signedProjection:record.signedProjection}) : reader.verifyAnchorReceipt,
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
      const paymentRecord = await durable.readAnchor({ jobId: request.jobId, logicalAddress: paymentEvidenceAddress(request.jobId, terms.rail, terms.paymentPhaseIndex), anchors });
      const deliverable = await durable.readAnchor({ jobId: request.jobId, logicalAddress: deliverableAddress(request.jobId), anchors });
      const deliveryRecord = await durable.readAnchor({ jobId: request.jobId, logicalAddress: deliveryEvidenceAddress(request.jobId), anchors });
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
    async function bundle() {
      await payment();
      if (!Number.isSafeInteger(session.finalisedAt)) refuse();
      const facts = sessionFacts(session);
      const plan = await bundleSigningPlan(facts);
      const retained = durable.signature(`signature:${sha256Hex(plan.payload)}`);
      const signature = session.sellerBundleSignature ?? (retained.disposition === 'present' ? retained.value : null);
      if (!signature || (session.bundleHash && session.bundleHash !== plan.bundleHash) ||
          !verifyComponent({ signedBytes: Buffer.from(plan.payload), signature: { algorithm: 'ed25519', signer: claim, value: signature } })) refuse();
      if (!session.sellerBundleSignature) { session.bundleHash = plan.bundleHash; session.sellerBundleSignature = signature; persist(session); }
      return { jobId: request.jobId, finalisedAt: session.finalisedAt, bundleHash: plan.bundleHash, sellerSignature: signature };
    }
    async function sellerCopy(buyerSignature) {
      await bundle();
      if (!session.countersignatureWork || session.countersignatureWork.buyerSignature !== canonicalSignature(buyerSignature)) refuse();
      const { copies, problems } = await assembleBundleCopies(sessionFacts(session), { buyer: buyerSignature, seller: session.sellerBundleSignature });
      if (problems.length) refuse();
      const address = bundleAddress(request.jobId, 'seller');
      const record = await durable.readAnchor({ jobId: request.jobId, logicalAddress: address, anchors });
      if (!same(record.artifact, copies.sellerCopy)) refuse();
      if (!session.sellerCopy) { session.sellerCopy = json(copies.sellerCopy); session.stage = 'seller-copy-anchored'; persist(session); }
      return { status: 'seller-copy-anchored', address, bundleHash: session.bundleHash };
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
            const answer = work
              ? await submitNativePaymentEvidence({ session, jobId: request.jobId, txHash: body.txHash, payerPayingKey: body.payerPayingKey, requestedEvidence: body.nativePaymentEvidence })
              : await submitPayment({ jobId: request.jobId, txHash: body.txHash, payerPayingKey: body.payerPayingKey, nativePaymentEvidence: body.nativePaymentEvidence });
            if (['delivery-ready','delivered'].includes(answer?.delivery?.status) && answer.delivery.evidencePublication !== 'held-readback-only') return present(answer);
            if (!work && !session.nativeEvidenceWork && ['rejected', 'indeterminate'].includes(answer?.status)) return { disposition: 'no-effect', value: answer };
            return !work || ['held', 'payment-evidenced'].includes(answer?.status) ? { disposition: 'retry', value: answer } : held(answer?.reason ?? 'seller_native_evidence_readback_required');
          }
          if (!session.paymentWork || session.paymentWork.txHash !== paymentTxHash(body.txHash) || body.payerPayingKey !== request.buyer ||
              session.paymentWork.payerPayingKey !== request.buyer) return held('seller_payment_context_mismatch');
          return present(await payment());
        }
        case '/dacs/v1/bundles/request':
        case '/dacs/v1/bundles/countersignature':
          return held('bundle_finalization_unavailable');
        case '/dacs/v1/bundles/buyer-copy': {
          await sellerCopy(session.countersignatureWork?.buyerSignature);
          const record = await anchors.read(bundleAddress(request.jobId, 'buyer'));
          const check = await verifyAnchoredCopy({ record, role: 'buyer', jobId: request.jobId, writer: request.buyer, expectedHash: session.bundleHash, ownCopy: session.sellerCopy });
          if (check.status !== 'verified') return held('seller_buyer_copy_readback_required');
          if (session.stage !== 'copies-exchanged') { session.stage = 'copies-exchanged'; persist(session); }
          return present(check);
        }
        default: return held('seller_transport_reconciliation_unsupported');
      }
    } catch (error) { return held(error.code ?? 'seller_readback_indeterminate'); }
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

  return {
    assertSettlementCredit,
    claim,
    listingPin: pin,
    issueSessionChallenge,
    receiveProposal: recoveryCall(receiveProposal),
    agreementState,
    commit: recoveryCall(commit),
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
      return reconcileTransport(input);
    });} : undefined,
    close: () => durable?.close(),
    // Test/ops visibility only: never a signing capability.
    finalityCommitmentAddress,
  };
}

export { canonicalSignature };
