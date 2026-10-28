import { admitSessionChallenge } from './session-challenge-limits.mjs';
import { operatorBuyerAccessConfig } from '../devnet-demo/buyer-access.mjs';
import { addressForClaim, isCanonicalEd25519Signature } from './demos-claims.mjs';
import { commitOnSignatureConfig, verifySignatureAgreement, verifyAgreementCreateAuthorization } from './commit-on-signature.mjs';
import { canonicalize, commitFixedPriceAgreement, contentHash, isListing, createInMemoryFencedSessionStore, fixedPriceAgreementLogicalAddress, finalityCommitmentAddress, identityBundleHash, isCanonicalJobId, isVerifiedListingAdmission, sameCanonicalClaimIdentity, canonicalDemosAgentPublicKey, isIdentityBundle, respondToFixedPriceAgreementProposalDurable, sellerFulfilmentVetRequirementsViolation, sha256Hex } from '@kynesyslabs/dacs';
import { randomBytes } from 'node:crypto';
import { verifyComponent, DEM_RAIL } from './listing.mjs';
import { railAuthorityConfig, validateSellerListing } from './rail-authority.mjs';
import { listingRevocationProblem, sessionAdmissionConfig, sessionAdmissionProblem, readAdmissionCapability, vetAnchorReceiptProblem, vetRecordProblem, SELLER_PROFILE, SESSION_CHALLENGE_LIFETIME_MS } from './session-admission.mjs';
import { fixtureRef, signAnchorWrite, verifyFixtureRecord, fixtureTxRef } from './fixture-anchors.mjs';
import { createSellerDurableState, DEFAULT_SELLER_MAX_JOBS } from './seller-durable-state.mjs';
import { nativePaymentEvidenceConfig } from './native-payment-evidence-consumer.mjs';
import { isPaymentEvidenceWalletJournalPair } from './payment-evidence-wallet-journal.mjs';
import { sellerSessionPresentationProblem } from './session-admission.mjs';
import { demDeliveryContextConfig, resolveDemDeliverySellerContext } from './dem-delivery-context-consumer.mjs';
import { nativeDemDeliveryConfig, isProvenUnsignedAbsence } from './native-dem-delivery-consumer.mjs';
import { agreementTerms, agreementInput, commitmentReader, commitmentSession, commitmentVerifier, contributionVerifier, listingPin, protocolSupport } from './purchase-protocol.mjs';

/** A seller refusal with its stable code and HTTP status (422 by default). */
export class SellerAgentError extends Error {
  constructor(code, message, status = 422, options = {}) {
    super(message,options);
    this.code = code;
    this.status = status;
  }
}
import { proposalTimeProblem } from './seller-proposal-time.mjs';
// A claimed pay-dem transaction hash as core payment intake reads it
// (lower case, without `0x`): the transport admits either form.
const paymentTxHash = (txHash) => String(txHash).toLowerCase().replace(/^0x/, '');

// Internal authenticated proposal contributions and commitment.
// Payment and delivery are introduced separately.
const MAX_CHALLENGES_PER_JOB=16;
export async function createSellerAgent({ signer, listing, anchors, now = () => Date.now(), durableDirectory, agreementAnchor = null, nativePaymentEvidence = null, demDeliveryContext = null, nativeDemDelivery = null, nativeArtifactAnchor = null, deliverableProducer = null, deliverySchemaVerifier = null, maxJobs = DEFAULT_SELLER_MAX_JOBS, deliveryEvidenceEnabled = false, buyerAccess = null, commitOnSignature = false, signatureBuyer = null, signatureCommitmentReady = null, contextRequest = null, railAuthority = null, sessionAdmission = null, reconcilePaymentEvidence = null, simulatedFixture = false }) {
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
  const durable = durableDirectory ? await createSellerDurableState({ dir: durableDirectory, signer, listingPin: pin, maxJobs }) : null;
  let closed=false;
  const requireOpen=()=>{if(closed)throw new SellerAgentError('seller_closed','the seller agent is closed',503);};
  try {
  const sign = (bytes) => new Uint8Array(durable ? durable.signOnce(`signature:${sha256Hex(bytes)}`, Buffer.from(bytes)) : signer.sign(Buffer.from(bytes)));
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
  const contributions = new Map(); // canonical settlement id -> all admissible claims
  const hasSettlementCredit = (id, jobId) => !durable || durable.settlementJob(id) === jobId;
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
  const sessionView = (session) => {
    if(!session)return null;
    const copy=structuredClone(session);
    try { assertSettlementCredit(session.jobId); }
    catch(error) { if(error.code!=='settlement_collision')throw error;copy.settlementCredit='indeterminate';copy.stage='settlement-indeterminate'; }
    return copy;
  };
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
    // The store's fence rejects a non-canonical job before the operation's own
    // validation runs. It is the same definite no-effect refusal the operation
    // would have raised, not an uncertain outcome.
    if (error.code === 'seller_state_job_invalid') throw new SellerAgentError('job_invalid', 'jobId is not canonical');
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
          if (!priorAdmission) session.proposalAdmission = { proposalHash: proposal.proposalHash, observedAt, admitted };
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
              try { record = await readAdmissionCapability(admission,'resolveVetRecord',{ jobId, role, party, ref }); }
              catch (cause) { return unavailable(cause,`the ${role} Vet record is unavailable`); }
              const problem = await vetRecordProblem(record, { ref, jobId, party, bundleHash: identityBundleHash(bundle), verifier, invocation, now });
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
            // The clock is read again after every authenticated read: the
            // admitted route's deadline is absolute, so the first completed
            // signature must not be made once it has passed.
            if (!signed) {
              const lateProblem = timeProblemAt(now());
              if (lateProblem) return { disposition: 'rejected', reason: lateProblem };
            }
            session.demDeliveryContext = structuredClone(resolved);
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
  // `adopt` is internal to transport reconciliation: a publisher readback may
  // adopt a commitment that was anchored before its session save, still with
  // no signing or submission.
  async function commit({ jobId, signedProjection }, { readbackOnly = false, signatureAgreement, adopt = false } = {}) {
    assertSettlementChain();
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    assertRailPin(session.railPin, 'in-flight');
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
      retainCommitmentPhase(session,retained);
      session.agreement=agreement;session.agreementRef=agreementRef;
      if(native)session.agreementAnchor=nativeAgreementView(native);
      if(session.stage==='proposed')session.stage='committed';persist(session);
      return {status:'committed',address:retained.logicalAddress,resumed:true,...(native?{agreementAnchor:nativeAgreementView(native)}:{})};
    }
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

  async function anchorOnce(logicalAddress, artifact) {
    if(artifact.jobId)assertSettlementCredit(artifact.jobId);
    const authorize = () => { if(artifact.jobId)assertSettlementCredit(artifact.jobId);return signAnchorWrite(sign, logicalAddress, contentHash(artifact)); };
    const receipt = durable ? await durable.anchor({ jobId: artifact.jobId, logicalAddress, artifact, anchors, authorize }) : await anchors.write({ logicalAddress, artifact, writer: claim, writerSignature: authorize() });
    return { ref: fixtureRef(logicalAddress, contentHash(artifact)), receipt };
  }

  function sameNativeCommitmentReceipt(left, right) {
    if (!left || !right || !Number.isSafeInteger(left.blockRef?.timestamp) || !Number.isSafeInteger(right.blockRef?.timestamp)) return false;
    const stable = ['receiptVersion','substrate','finalityProfile','logicalAddress','nativeAddress','contentHash','writer','nonce','state','observationDisposition'];
    return stable.every((key)=>canonicalize(left[key]??null)===canonicalize(right[key]??null)) &&
      canonicalize(left.transactionRef)===canonicalize(right.transactionRef) &&
      canonicalize(left.blockRef)===canonicalize(right.blockRef);
  }

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
    const held = (reason) => ({ disposition: 'indeterminate', reason: String(reason).slice(0, 240) });
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
    const input = { jobId: request.jobId, signedProjection: body.signedProjection };
    const options = { readbackOnly: true, adopt: !early, ...(early ? { signatureAgreement: body.agreement } : {}) };
    let answer;
    try { answer = await commit(input, options); }
    catch (error) {
      if (readOnly || session.commitment || session.signatureCommitmentHeld || !(await provenUnsignedCommitment(request.jobId))) return held(error?.message ?? error);
      try { answer = await commit(input, early ? { signatureAgreement: body.agreement } : {}); }
      catch (retryError) { return held(retryError?.message ?? retryError); }
    }
    return answer?.status === 'committed' || answer?.status === 'commitment-held' ? { disposition: 'present', value: answer } : held('commitment readback did not establish a retained outcome');
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
    // Read-only reduction of an uncertain commitment HTTP reservation. Other
    // routes keep their own (or no) reconciliation.
    reconcileTransport: durable ? async (input) => {
      const jobId = input?.request?.jobId;
      if (!COMMITMENT_PATHS.has(input?.request?.path) || !isCanonicalJobId(jobId)) return undefined;
      try {
        return await durable.withJob(jobId, async (session) => { sessions.delete(jobId); restore(session); return reconcileCommitmentTransport(input); });
      } catch (error) {
        if (error?.code === 'seller_state_capacity') throw new SellerAgentError('peer_job_capacity', 'the seller has reached maxJobs; no new session was admitted', 503);
        throw error;
      }
    } : reconcileCommitmentTransport,
    commitOnSignature: recoveryCall((input) => {
      if (!input || canonicalize(Object.keys(input).sort()) !== canonicalize(['agreement', 'jobId', 'signedProjection']) || !input.agreement || typeof input.agreement !== 'object') throw new SellerAgentError('signature_agreement_invalid', 'expected exactly jobId, Agreement and signedProjection');
      return commit({ jobId: input.jobId, signedProjection: input.signedProjection }, { signatureAgreement: input.agreement });
    }),
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

export { canonicalSignature } from './fixture-anchors.mjs';
export { proposalTimeProblem } from './seller-proposal-time.mjs';
