import { assertPurchaseActionsAdmitted } from './action-admission.mjs';
import { operatorBuyerAccessConfig } from '../seams/buyer-access-not-wired.mjs';
import { addressForClaim } from '../signatures.mjs';
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
  sha256Hex,
  signComponentArtifact,
  verifySellerPaymentIntake,
  verifySettlementEvidence,
  ARTIFACT_SEPARATORS,
} from '@kynesyslabs/dacs';
import { isNativeDeliveryEvidence } from './delivery-evidence.mjs';
import { join } from 'node:path';
import { validateListing, verifyComponent, DEM_RAIL } from './listing.mjs';
import { artifactRef as fixtureRef, artifactTxRef as fixtureTxRef } from './artifact-reference.mjs';
import { signAnchorWrite, verifyFixtureRecord, verifyFixtureReceipt } from '../seams/seller-integration-not-wired.mjs';
import { canonicalSignature } from '../signatures.mjs';
import { createSellerDurableState } from './seller-durable-state.mjs';
import { NATIVE_PAYMENT_EVIDENCE, nativePaymentEvidenceConfig, checkNativePaymentEvidence } from './native-payment-evidence-consumer.mjs';
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

const GENERATED_AT_SKEW_MS = 10 * 60 * 1000;
const FINALISED_SKEW_MS = 5 * 60 * 1000;

// The deterministic test report this agent delivers: derived only from the
// Agreement and the verified payment, so every replay is byte-identical.
export function buildReport({ agreement, listing, settlementId }) {
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

// `agreementAnchor` (optional, programmatic operator capability; see
// seller-sr2-agreement-consumer.mjs) makes commit read the buyer's Agreement as
// its native Demos SR-2 storage CREATE, authenticated by the SR-2 adapter.
// Without it the fixture-substrate Agreement write is read exactly as before.
// The FinalityCommitmentRecord is anchored on `anchors` in both cases.
export async function createSellerAgent({ signer, listing, anchors, observeDemosTransfer, now = () => Date.now(), receiptStore: suppliedReceiptStore, durableDirectory, agreementAnchor = null, nativePaymentEvidence = null, demDeliveryContext = null, nativeDemDelivery = null, nativeArtifactAnchor = null, deliverableProducer = null, deliveryEvidenceEnabled = false, buyerAccess = null, readIssued = null, commitOnSignature = false, signatureBuyer = null, signatureCommitmentReady = null }) {
  assertPurchaseActionsAdmitted();
  commitOnSignature = commitOnSignatureConfig(commitOnSignature);
  if (signatureBuyer !== null && !/^did:demos:agent:[0-9a-f]{64}$/.test(signatureBuyer)) throw new TypeError('signatureBuyer must be an admitted buyer claim or null');
  if (signatureCommitmentReady !== null && typeof signatureCommitmentReady !== 'function') throw new TypeError('signatureCommitmentReady must be a function or null');
  if (commitOnSignature && !durableDirectory) throw new TypeError('commitment on signature requires durable seller state');
  if (!signer?.claim || typeof signer.sign !== 'function') throw new Error('a seller signer (claim + sign) is required');
  if (agreementAnchor !== null && (typeof agreementAnchor?.readAgreement !== 'function' || typeof agreementAnchor.source !== 'string')) throw new Error('agreementAnchor must expose source and readAgreement');
  if (listing?.seller?.identity?.presentedBy !== signer.claim) throw new Error('the seller signer does not control this Listing');
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
  if (deliveryContext && (!nativeEvidence || !durableDirectory)) throw new TypeError('DEM delivery context requires the durable native evidence profile');
  if (nativeDelivery && !deliveryContext) throw new TypeError('native DEM delivery requires the authenticated DEM delivery context');
  if(typeof deliveryEvidenceEnabled!=='boolean'||(deliveryEvidenceEnabled&&(!nativeArtifactAnchor||!nativeDelivery)))throw new TypeError('delivery evidence publication requires the explicit native demo delivery profile');
  const pin = listingPin(listing);
  if (durableDirectory && suppliedReceiptStore) throw new Error('durable seller recovery owns the pinned filesystem receipt store');
  const durable = durableDirectory ? await createSellerDurableState({ dir: durableDirectory, signer, listingPin: pin }) : null;
  const sign = (bytes) => new Uint8Array(durable ? durable.signOnce(`signature:${sha256Hex(bytes)}`, Buffer.from(bytes)) : signer.sign(Buffer.from(bytes)));
  const receiptStore = durable?.receiptStore ?? suppliedReceiptStore ?? createInMemorySellerReceiptStore();
  const retainedAdmission = durable?.context();
  // Historical admission captured once, atomically with the Listing bytes it
  // validated; payment intake replays exactly this result (never live state).
  const admittedAt = retainedAdmission?.admittedAt ?? now();
  const validation = retainedAdmission?.validation ?? await validateListing(listing, {
    now: () => admittedAt,
    revocationSurfaces: [{ kind: 'catalog', status: 'active', readStatus: 'ok', catalogObservedAt: admittedAt }],
    readMarker: async () => null,
  });
  if (validation.disposition !== 'verified') throw new Error(`own Listing does not verify: ${validation.reason}`);
  durable?.retainContext({ admittedAt, validation });
  const sellerBundle = listing.seller.identity;
  const store = durable?.fencedStore ?? createInMemoryFencedSessionStore();
  const fulfilmentStore = deliveryContext ? await createFsFencedSessionStore({ dir: join(durableDirectory, 'sdk-fulfilment') }) : null;
  const sessions = new Map(); // jobId -> session
  const signatures = new Map(); // planHash -> seller signature
  const contributions = new Map(); // proposalHash -> contribution
  const settlementJobs = new Map(); // canonical settlement id -> the one job it paid (SB-2)
  const deliveryReport=(session,settlementId)=>{
    const report=deliverableProducer ? deliverableProducer({agreement:structuredClone(session.agreement),listing:structuredClone(listing),settlementId}) : buildReport({agreement:session.agreement,listing,settlementId});
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
  const heldFor = (jobId) => (durable ? () => durable.assertHeld(jobId) : undefined);
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
  }) : fn;

  const sessionFor = (jobId) => {
    const session = sessions.get(jobId);
    if (!session) throw new SellerAgentError('unknown_job', 'no session for this job', 404);
    return session;
  };

  function authenticateBuyerBundle(bundle) {
    if (!isIdentityBundle(bundle)) throw new SellerAgentError('buyer_bundle_invalid', 'buyer IdentityBundle is not normative');
    const proof = bundle.presentation?.kind === 'per-claim' && bundle.presentation.signatures.find((entry) => entry.ref === bundle.presentedBy);
    const ok = proof && verifyComponent({
      signedBytes: Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(bundle)}`, 'utf8'),
      signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature },
    });
    if (!ok) throw new SellerAgentError('buyer_bundle_unauthenticated', 'buyer IdentityBundle presentation does not verify');
    if (bundle.presentedBy === claim) throw new SellerAgentError('self_dealing', 'the buyer is the seller');
  }

  // ---- DACS-3: proposal -> seller contribution ----
  async function receiveProposal({ proposal, transportIdentity, buyerIdentityBundle }) {
    const jobId = transportIdentity?.jobId;
    if (!isCanonicalJobId(jobId)) throw new SellerAgentError('job_invalid', 'jobId is not canonical');
    assertBuyer(buyerIdentityBundle?.presentedBy,jobId,{proposal:true});
    authenticateBuyerBundle(buyerIdentityBundle);
    if (transportIdentity.buyer !== buyerIdentityBundle.presentedBy) throw new SellerAgentError('buyer_mismatch', 'proposal buyer is not the presented identity');
    const existing = sessions.get(jobId);
    if (existing && existing.buyerBundleHash !== identityBundleHash(buyerIdentityBundle)) throw new SellerAgentError('job_taken', 'this job is bound to another buyer', 409);
    if (!existing) sessions.set(jobId, { jobId, buyerBundle: structuredClone(buyerIdentityBundle), buyerBundleHash: identityBundleHash(buyerIdentityBundle), proposal: null, stage: 'proposed' });
    const session = sessions.get(jobId);
    persist(session);
    const progress = await respondToFixedPriceAgreementProposalDurable(
      { proposal, transportIdentity, seller: { party: claim, algorithm: 'ed25519', sign: (bytes) => sign(bytes) } },
      {
        store,
        workerId: 'seller-agent',
        leaseTtlMs: 60_000,
        resolveAuthenticatedAgreementContext: async (query) => {
          const draft = query.candidateDraft;
          if (query.seller !== claim || canonicalize(query.listingPin) !== canonicalize(pin)) return { disposition: 'rejected', reason: 'proposal names another Listing or seller' };
          if (query.buyer !== session.buyerBundle.presentedBy || query.jobId !== jobId) return { disposition: 'rejected', reason: 'proposal names another buyer or job' };
          const generatedAt = draft?.generatedAt;
          const observedAt = session.proposalAdmission?.proposalHash === proposal.proposalHash ? session.proposalAdmission.observedAt : now();
          if (!Number.isSafeInteger(generatedAt) || Math.abs(generatedAt - observedAt) > GENERATED_AT_SKEW_MS) return { disposition: 'rejected', reason: 'proposal generatedAt is outside the seller clock window' };
          session.proposalAdmission = { proposalHash: proposal.proposalHash, observedAt };
          if (deliveryContext) {
            const retained = session.demDeliveryContext;
            const resolved = retained ?? await resolveDemDeliverySellerContext(deliveryContext, { jobId, listing, buyerBundle: session.buyerBundle, generatedAt });
            if (resolved.disposition !== 'present') return { disposition: resolved.disposition, reason: resolved.reason };
            if (retained && (retained.input.generatedAt !== generatedAt || retained.input.jobId !== jobId)) return { disposition: 'rejected', reason: 'retained DEM delivery Agreement context differs' };
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
    persist(session);
    return { disposition: 'complete', contribution: progress.result.sellerContribution };
  }

  function agreementState(identity) {
    if (durable) restore(durable.loadSession(identity?.jobId));
    const session = sessions.get(identity?.jobId);
    if (!session?.proposal || session.transportIdentity?.proposalHash !== identity.proposalHash) return { proposal: null, contribution: null };
    return { proposal: session.proposal, contribution: contributions.get(identity.proposalHash) ?? null };
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

  // DACS-3 §8.4.1: negotiation succeeds only with both signatures anchored
  // (SR-2). The seller's own contribution is not that, so `commit` records this
  // phase, after the buyer's Agreement readback has authenticated.
  function retainNegotiatePhase(session, jobId) {
    const agreementRef = { anchor: { kind: 'storage-program', locator: fixedPriceAgreementLogicalAddress(jobId) }, contentHash: session.agreementHash };
    return recordPhase(session, 0, session.proposalAdmission.observedAt, { ok: true,
      contextDelta: { 'negotiate-fixed-price': { agreementHash: session.agreementHash, agreementRef } } });
  }

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
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
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
            if(read.status==='absent') return {disposition:'absent'};
            if(read.status!=='present') return {disposition:read.status==='rejected'?'rejected':'indeterminate',reason:read.reason};
            nativeCommitmentProjection=read.signedProjection;
            return {disposition:'present',anchored:{record:read.artifact,nativeAddress:read.receipt.nativeAddress,anchorTxRef:read.txRef,anchorReceipt:read.receipt}};
          },
          verifyAnchorReceipt: async (anchored) => nativeArtifactAnchor.verifyReceipt({logicalAddress:anchored.anchorReceipt.logicalAddress,artifact:anchored.record,artifactKind:'FinalityCommitmentRecord',receipt:anchored.anchorReceipt,signedProjection:nativeCommitmentProjection}),
          submit: async (logicalAddress, commitmentRecord) => {
            if(readbackOnly || retainedNativeCommitment) readbackRequired();
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
    // Recorded before the commitment is retained, so a saved commitment never
    // lacks the phase before it.
    retainNegotiatePhase(session, jobId);
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
  const intakeDeps = {
    resolveCommittedAgreement: async (jobId) => {
      const session = sessions.get(jobId);
      if (!session?.commitment) return { disposition: 'rejected', reason: 'no finalized commitment for this job' };
      const c = session.commitment;
      return {
        disposition: 'verified',
        agreement: structuredClone(session.agreement),
        agreementHash: c.agreementHash,
        commitment: { finality: 'finalized', ref: c.logicalAddress, contentHash: contentHash(c.record), jobId, agreementHash: c.agreementHash, listingRef: { ...session.agreement.listingRef }, committedAt: c.committedAt, signer: c.record.signature.signer },
        railRegistryVersion: RAIL_REGISTRY_VERSION,
      };
    },
    resolveListingAtCommit: async (listingRef) => (canonicalize(listingRef) === canonicalize(pin) ? { rawListing: structuredClone(listing), validation: structuredClone(validation) } : { rawListing: {}, validation: { disposition: 'rejected', reason: 'unknown-listing' } }),
    resolveRail: async ({ ref, railRegistryVersion }) =>
      ref?.railId === DEM_RAIL.railId && railRegistryVersion === RAIL_REGISTRY_VERSION ? { disposition: 'verified', rail: structuredClone(DEM_RAIL_DEFINITION), railRegistryVersion } : { disposition: 'rejected', reason: 'unknown rail' },
    resolveIdentityBundle: async (bundleHash) => {
      if (bundleHash === identityBundleHash(sellerBundle)) return { disposition: 'verified', bundle: structuredClone(sellerBundle) };
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
  };

  async function anchorOnce(logicalAddress, artifact) {
    const authorize = () => signAnchorWrite(sign, logicalAddress, contentHash(artifact));
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
      deliverableRef: {
        deliverableType: listing.offering.deliverable.kind,
        hash: contentHash(listing.offering.deliverable),
        ...(listing.offering.deliverable.schemaUrl ? { schemaUrl: listing.offering.deliverable.schemaUrl } : {}),
      },
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
        railRegistryVersion: RAIL_REGISTRY_VERSION,
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
      payloadHash:contentHash(deliveryReport(session,work.intake.settlementId)) };
  }

  function sameNativeDeliveryReceipt(left, right) {
    if (!left || !right) return false;
    const stable = ['receiptVersion','substrate','finalityProfile','logicalAddress','nativeAddress','contentHash','writer','nonce','state','observationDisposition'];
    return stable.every((key)=>canonicalize(left[key])===canonicalize(right[key])) &&
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
  async function recoverNativeDeliveryBinding(session, work) {
    if (!nativeDelivery || session.deliveryReady) return { status: 'not-needed' };
    const result = session.deliveryHold?.result;
    if (result?.decision !== 'indeterminate' || result.code !== 'delivery-submission-ambiguous' ||
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
        receiptContentHash: contentHash(report), deliveryBinding: binding });
    } catch (error) {
      return { status: 'held', reason: `native delivery reconciliation readback is unavailable: ${String(error?.message ?? error).slice(0, 180)}` };
    }
    if (isProvenUnsignedAbsence(read)) return { status: 'askable' };
    if (read.status !== 'present') return { status: 'held', reason: read.reason ?? 'original native Deliverable CREATE is not authenticated on fresh readback' };
    session.deliveryAdapter = { fulfilmentId: result.fulfilmentId, deliveryBinding: binding,
      reconciliationId: read.receipt.transactionRef.value, substrate: 'source-native-delivery-recovered-readonly' };
    persist(session);
    return { status: 'present' };
  }

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
        const result=await readNativeDemDelivery(nativeDelivery,{jobId:session.jobId,logicalAddress,report,receiptContentHash:contentHash(report),deliveryBinding:deliveryBinding(fulfilmentId)});
        if(result.status==='present')return{status:'present',artifact:result.artifact,receipt:result.receipt,signedProjection:result.signedProjection,demosEvidence:result.demosEvidence};
        if(result.status==='rejected')throw new SellerAgentError('delivery_readback_invalid',result.reason,503);
        return null;
      }
      const record = await anchors.read(logicalAddress);
      if (record.status !== 'present') return null;
      if (verifyFixtureRecord(record, { logicalAddress, expectedWriter: claim }) !== 'valid') throw new SellerAgentError('delivery_readback_invalid', 'delivery receipt is not the seller write', 503);
      return record;
    };
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
          const answer=await submitNativeDemDelivery(nativeDelivery,{...input,report,receiptContentHash:contentHash(report),deliveryBinding:binding});
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
          return reconcileNativeDemDelivery(nativeDelivery,{...input,jobId:session.jobId,logicalAddress:deliverableAddress(session.jobId),report,
            receiptContentHash:contentHash(report),deliveryBinding:deliveryBinding(input.fulfilmentId)});
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
      verifyDeliverySchema: ({ schemaUrl, cleartextPayload }) => {
        const matches = schemaUrl === listing.offering.deliverable.schemaUrl && reportMatches(cleartextPayload, session, work.intake.settlementId);
        return { disposition: matches ? 'valid' : 'invalid', ...(matches ? {} : { reason: 'report schema/bindings differ' }) };
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
    const session = sessionFor(jobId);
    assertBuyer(session.buyerBundle.presentedBy,jobId);
    if (requestedEvidence === NATIVE_PAYMENT_EVIDENCE || session.nativeEvidenceWork) return submitNativePaymentEvidence({ session, jobId, txHash, payerPayingKey, requestedEvidence });
    if (session.payment) {
      if (session.payment.txHash !== String(txHash).toLowerCase()) throw new SellerAgentError('payment_already_recorded', 'this job already has a verified payment', 409);
      return publicPayment(session);
    }
    if (!session.commitment) throw new SellerAgentError('not_committed', 'the Agreement is not committed; no payment is accepted before commitment');
    if (durable) await commit({ jobId }); // fresh authenticated commitment readback
    const terms = agreementTerms(session.agreement);
    if (session.paymentWork && (session.paymentWork.txHash !== String(txHash).toLowerCase() || session.paymentWork.payerPayingKey !== payerPayingKey)) throw new SellerAgentError('seller_payment_work_conflict', 'a different verified claim is retained for this job', 503);
    const intake = session.paymentWork?.intake ?? await verifySellerPaymentIntake({ jobId, phaseIndex: terms.paymentPhaseIndex, railId: terms.rail, payerPayingKey, receipt: { kind: 'pay-dem', txHash } }, intakeDeps);
    if (intake.disposition !== 'verified' || (intake.fulfilment !== 'claim' && intake.fulfilment !== 'already-claimed')) {
      return { status: intake.disposition === 'indeterminate' ? 'indeterminate' : 'rejected', reason: intake.reason };
    }
    // SB-2: one transaction counts for one session. The SDK receipt store
    // keeps re-selecting its winner until a permit is consumed, and this agent
    // never consumes one (no V2 fulfilment handoff), so the canonical
    // settlement identity is bound set-once (synchronous check-and-set) to the
    // first verified job before any evidence or delivery. The fenced store's
    // bindHash is not usable here: it refuses new bindings for leased sessions
    // without recording one.
    const boundTo = settlementJobs.get(intake.settlementId);
    if (boundTo && boundTo !== jobId) return { status: 'rejected', reason: 'settlement-bound-to-another-job' };
    if (durable && !durable.bindSettlement(intake.settlementId, jobId)) return { status: 'rejected', reason: 'settlement-bound-to-another-job' };
    settlementJobs.set(intake.settlementId, jobId);
    if (durable && !session.paymentWork) {
      session.paymentWork = { txHash: String(txHash).toLowerCase(), payerPayingKey, intake: JSON.parse(JSON.stringify(intake)), deliveredAt: now() };
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
    const p = session.payment;
    return { status: 'delivered', settlementId: p.settlementId, evidenceAddress: p.ref.anchor.locator, deliverableAddress: p.deliverableRef.anchor.locator, deliveryEvidenceAddress: p.deliveryRef.anchor.locator };
  }

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
    return { status: 'payment-evidenced', settlementId: work.intake.settlementId, evidenceAddress: work.address,
      evidenceHash: work.intake.evidenceHash, anchorReceipt: work.nativeReceipt, signedProjection: retainedNativeEvidenceProjection(work),
      anchorAttempt: work.anchorAttempt, finality: 'one-node-fixture-view-not-independent', delivery };
  }

  // Reduce a retained native-evidence checkpoint only from independently
  // authenticated, read-only authorities. In particular, a transport retry
  // never calls anchorEvidence again and neither an old HTTP response nor the
  // signed seller snapshot is treated as a receipt/public projection.
  async function reduceNativeEvidenceWork(session, work, { jobId, txHash, payerPayingKey }) {
    const terms = agreementTerms(session.agreement), hash = String(txHash).toLowerCase(), intake = work?.intake;
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
    // earlier checkpoint recovers it independently through readEvidence's
    // explicit seller-journal reader.
    const projection = retainedNativeEvidenceProjection(work);
    const read = await nativeEvidence.readEvidence({ agreement: session.agreement, writer: claim, txHash: hash,
      blockNumber: intake.settlementIdentity.blockNumber, committedAt: session.commitment.committedAt,
      ...(projection ? { signedProjection: projection } : {}) });
    if (read.disposition !== 'present') return read;
    if (contentHash(read.artifact) !== intake.evidenceHash || canonicalize(read.artifact) !== canonicalize(work.evidence)) return held('seller_native_evidence_artifact_readback_mismatch', 'rejected');
    if (work.nativeReceipt && !sameNativeDeliveryReceipt(work.nativeReceipt, read.receipt)) return held('seller_native_evidence_receipt_readback_mismatch', 'rejected');
    if (work.publicSignedProjection && canonicalize(work.publicSignedProjection) !== canonicalize(read.signedProjection)) return held('seller_native_evidence_projection_readback_mismatch', 'rejected');
    if (work.publicSignedProjectionJson && (!projection || canonicalize(projection) !== canonicalize(read.signedProjection))) return held('seller_native_evidence_projection_bytes_mismatch', 'rejected');
    // A fresh native observation may carry new observer timestamps/proofs even
    // though it authenticated the same immutable CREATE. Preserve the exact
    // receipt/projection bytes already recorded in the SDK phase result; after
    // stable identity and signed-projection checks above, those are the only
    // bytes that can resume the existing phase without rewriting its history.
    const authenticatedReceipt = work.nativeReceipt ? structuredClone(work.nativeReceipt) : structuredClone(read.receipt);
    const authenticatedProjection = projection ? structuredClone(projection) : structuredClone(read.signedProjection);
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
    const result = delivery.ready.result, deliveredHash = contentHash(result.artifact.anchoredValue);
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
    const result = delivery.ready.result, deliveredHash = contentHash(result.artifact.anchoredValue);
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
      receiptContentHash: contentHash(report), deliveryBinding: binding });
    const valid = reread.status === 'present' && ready.paymentPermitId === work.intake.permitId && ready.contentHash === contentHash(report) &&
      canonicalize(ready.deliveryBinding) === canonicalize(binding) && sameNativeDeliveryReceipt(reread.receipt, ready.anchorReceipt);
    if (!valid) return nativeEvidenceResponse(work, { status: 'held', reason: reread.reason ?? 'persisted SDK delivery-ready result did not authenticate on fresh native read' });
    return finishDeliveryEvidence(session, work, { status: 'delivery-ready', fulfilmentId: ready.fulfilmentId, logicalAddress: ready.logicalAddress,
      contentHash: ready.contentHash, anchorReceipt: reread.receipt, evidenceHash: ready.evidenceHash, deliveryBinding: binding,
      substrate: nativeDeliverySubstrate, evidencePublication: 'deferred-to-explicit-sdk-finaliser' });
  }

  async function finishDeliveryEvidence(session, work, pointer) {
    if(!deliveryEvidenceEnabled)return nativeEvidenceResponse(work,pointer);
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
        if(read?.status==='absent')read=await nativeArtifactAnchor.publish({logicalAddress:address,artifact:evidence,artifactKind:'SettlementEvidence',authorize:heldFor(session.jobId)});
      }
    }catch(error){return held(String(error.message).slice(0,240));}
    if(read?.status!=='present')return held(read?.reason??'original delivery evidence CREATE requires authenticated readback; no resend');
    if(session.deliveryEvidenceWork.address!==address||session.deliveryEvidenceWork.evidenceHash!==ready.evidenceHash||canonicalize(read.artifact)!==canonicalize(evidence)
      ||await nativeArtifactAnchor.verifyReceipt({logicalAddress:address,artifact:evidence,artifactKind:'SettlementEvidence',receipt:read.receipt,signedProjection:read.signedProjection})!=='valid')return held('delivery evidence readback differs');
    session.stage='delivered';persist(session);
    return nativeEvidenceResponse(work,{...pointer,status:'delivered',evidencePublication:'native-read-back',evidenceRef:signedFixtureRef(address,ready.evidenceHash),evidenceReceipt:read.receipt});
  }

  // Everything before the durable work checkpoint is free of external effects:
  // the commitment is only read back, and the SDK permit claim, settlement
  // binding and evidence signature are local and replay-idempotent for this
  // exact job/payment. A failure here is a definite no-effect answer. Thrown,
  // it would leave the authenticated transport fenced as uncertain with no
  // retained work for its read-only reconciliation to reduce, so the paid
  // order could never be delivered. A durable checkpoint keeps throwing.
  async function startNativePaymentEvidence({ session, jobId, hash, payerPayingKey }) {
    let step = 'commitment-readback';
    try {
      await commit({ jobId }, { readbackOnly: true });
      const terms = agreementTerms(session.agreement);
      step = 'payment-intake';
      const intake = await verifySellerPaymentIntake({ jobId, phaseIndex: terms.paymentPhaseIndex, railId: terms.rail, payerPayingKey, receipt: { kind: 'pay-dem', txHash: hash } }, { ...intakeDeps, observeDemosTransfer: nativeEvidence.observeDemosTransfer });
      if (intake.disposition !== 'verified' || !['claim', 'already-claimed'].includes(intake.fulfilment)) return { answer: { status: intake.disposition === 'indeterminate' ? 'indeterminate' : 'rejected', reason: intake.reason } };
      step = 'settlement-binding';
      if (!durable.bindSettlement(intake.settlementId, jobId)) return { answer: { status: 'rejected', reason: 'settlement-bound-to-another-job' } };
      step = 'evidence-signing';
      const evidence = await signEvidence(structuredClone(intake.evidenceInput));
      if (contentHash(evidence) !== intake.evidenceHash) throw new SellerAgentError('evidence_hash_mismatch', 'SDK signed evidence hash differs', 500);
      step = 'evidence-check';
      const check = await checkNativePaymentEvidence({ artifact: evidence, agreement: session.agreement, writer: claim, txHash: hash, blockNumber: intake.settlementIdentity.blockNumber });
      if (check.decision !== 'pass') throw new SellerAgentError('native_evidence_invalid', check.reasons.join('; '));
      step = 'work-checkpoint';
      const work = session.nativeEvidenceWork = { txHash: hash, payerPayingKey, agreementHash: contentHash(session.agreement), commitmentHash: contentHash(session.commitment.record),
        listingPin: pin, intake: JSON.parse(JSON.stringify(intake)), evidence, address: paymentEvidenceAddress(jobId, terms.rail, terms.paymentPhaseIndex), anchorAttempt: 'issued-once' };
      session.stage = 'native-payment-evidence-held'; persist(session);
      return { work };
    } catch (error) {
      if (durable.loadSession(jobId)?.nativeEvidenceWork) throw error;
      delete session.nativeEvidenceWork;
      const cause = typeof error?.code === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(error.code) ? error.code : 'unclassified';
      return { answer: { status: 'rejected', reason: 'seller_native_evidence_not_started', step, cause } };
    }
  }

  // Separate from the historical fixture receipt/delivery publisher. Genuine
  // SDK SettlementEvidence is preserved byte-for-byte; no artifactType is
  // invented to satisfy a wallet bridge. Retain an issued attempt BEFORE the
  // wallet boundary. Every later call/restart is readback-only, never resend.
  async function submitNativePaymentEvidence({ session, jobId, txHash, payerPayingKey, requestedEvidence }) {
    if (!nativeEvidence || requestedEvidence !== NATIVE_PAYMENT_EVIDENCE) throw new SellerAgentError('native_evidence_held', 'the explicit native evidence capability/terms are absent');
    if (!session.commitment || !session.agreementAnchor) throw new SellerAgentError('not_committed', 'native Agreement and seller commitment must be retained');
    const hash = String(txHash).toLowerCase();
    let work = session.nativeEvidenceWork;
    if (work) {
      await commit({ jobId });
      if (work.txHash !== hash || work.payerPayingKey !== payerPayingKey || work.agreementHash !== contentHash(session.agreement)
          || work.commitmentHash !== contentHash(session.commitment.record)) throw new SellerAgentError('seller_native_evidence_conflict', 'the retained exact payment/Agreement/commitment cannot change', 409);
    } else {
      const started = await startNativePaymentEvidence({ session, jobId, hash, payerPayingKey });
      if (!started.work) return started.answer;
      work = started.work;
      durable.assertHeld(jobId);
      try {
        const answer = await nativeEvidence.anchorEvidence({ logicalAddress: work.address, artifact: structuredClone(work.evidence), writer: claim, artifactKind: 'SettlementEvidence', jobId, receiptContentHash: work.intake.evidenceHash });
        work.anchorAnswer = JSON.parse(JSON.stringify(answer ?? null));
      } catch (error) { work.anchorError = { code: error.code ?? 'unknown', message: String(error.message).slice(0, 240) }; }
      persist(session);
    }
    // Recovery is delivery-only. The payment evidence receipt/projection below
    // was already authenticated and retained before the ambiguous delivery;
    // re-reading the exact Deliverable is the only new external observation.
    if (work.nativeReceipt && retainedNativeEvidenceProjection(work) && nativeDelivery && session.deliveryReady) {
      return readPersistedNativeDelivery(session, work);
    }
    if (work.nativeReceipt && retainedNativeEvidenceProjection(work) && session.deliveryHold?.result?.code === 'delivery-submission-ambiguous') {
      const recovered = await recoverNativeSdkDelivery(session, work);
      if (recovered) return recovered;
    }
    const read = await reduceNativeEvidenceWork(session, work, { jobId, txHash: hash, payerPayingKey });
    if (read.disposition === 'present') return advanceAuthenticatedNativeDelivery(session, work, read);
    return { status: read.disposition === 'rejected' ? 'rejected' : 'held', reason: read.reason ?? 'native-evidence-readback-incomplete',
      ...(work.anchorError ? { anchorError: work.anchorError } : {}),
      evidenceAddress: work.address, evidenceHash: work.intake.evidenceHash, intake: 'pinned-SDK-verified-on-owned-fixture', readback: read.disposition,
      ...(read.nativeReadStatus ? { nativeReadStatus:read.nativeReadStatus } : {}), ...(read.code ? { nativeReadCode:read.code } : {}), anchorAttempt: work.anchorAttempt,
      limits: 'fixture Listing admission/rail/commitment; SDK one-node included view, not independent finality; delivery/Vet/ST11/completion held' };
  }

  // ---- DACS-5: completed two-sided bundle ----
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

  // A read-only reducer for an ALREADY reserved authenticated HTTP command.
  // Commit-on-signature reconciliation uses the readback-only gate; it cannot
  // sign or submit. The one native
  // fulfilment branch first authenticates the original applied CREATE and then
  // re-enters the same consumed SDK WAL, where only reconciliation is possible.
  // A transport cached answer is never evidence; retained seller-authenticated work must
  // agree with the pinned receipt authority and exact fresh native readback.
  // Local authenticated snapshots may advance after those facts are verified.
  async function reconcileTransport({ request, body, rawBody }) {
    const held = (reason) => ({ disposition: 'indeterminate', reason });
    const same = (a, b) => canonicalize(a) === canonicalize(b);
    const session = sessions.get(request.jobId);
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
          const verified = await commitment();
          return present({ status: 'committed', address: verified.logicalAddress, resumed: true, ...(session.agreementAnchor ? { agreementAnchor: json(session.agreementAnchor) } : {}) });
        }
        case '/dacs/v1/payments': {
          if (session.nativeEvidenceWork) {
            const work = session.nativeEvidenceWork;
            if (body.nativePaymentEvidence !== NATIVE_PAYMENT_EVIDENCE || work.txHash !== String(body.txHash).toLowerCase() ||
                body.payerPayingKey !== request.buyer || work.payerPayingKey !== request.buyer) {
              return held('seller_native_delivery_context_mismatch');
            }
            await commitment();
            const read = await reduceNativeEvidenceWork(session, work, { jobId: request.jobId, txHash: body.txHash, payerPayingKey: body.payerPayingKey });
            if (read.disposition !== 'present') return held(read.reason ?? 'seller_native_evidence_readback_required');
            const answer = await advanceAuthenticatedNativeDelivery(session, work, read);
            return ['delivery-ready','delivered'].includes(answer?.delivery?.status) ? present(answer) : held(answer?.delivery?.reason ?? 'seller_native_delivery_readback_required');
          }
          if (!session.paymentWork || session.paymentWork.txHash !== String(body.txHash).toLowerCase() || body.payerPayingKey !== request.buyer ||
              session.paymentWork.payerPayingKey !== request.buyer) return held('seller_payment_context_mismatch');
          return present(await payment());
        }
        case '/dacs/v1/bundles/request': return present(await bundle());
        case '/dacs/v1/bundles/countersignature': return present(await sellerCopy(body.buyerSignature));
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
  // authenticated exact readback. Absence never authorizes resubmission.
  async function resume({ jobId }) {
    const session = sessionFor(jobId);
    if(access&&!access.allowsWallet(addressForClaim(session.buyerBundle.presentedBy))&&readIssued){
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
    claim,
    listingPin: pin,
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
    stageOf: (jobId) => (durable?.loadSession(jobId) ?? sessions.get(jobId))?.stage ?? null,
    deliveryStateOf: (jobId) => {
      const session = durable?.loadSession(jobId) ?? sessions.get(jobId);
      return structuredClone(session?.deliveryReady ?? session?.deliveryHold ?? null);
    },
    reconcile: durable ? async({ jobId }) => {
      const session=durable.loadSession(jobId);
      // Only an issued unknown CREATE earns a read; otherwise refuse with no chain access.
      if(access&&session&&!access.allowsWallet(addressForClaim(session.buyerBundle.presentedBy))){
        const unknown=await readIssued?.(jobId,{unknownOnly:true});
        if(unknown)return unknown;
        throw new SellerAgentError('buyer_access_closed','this operator accepts only its configured custody buyer while openBuyerAccess is off; no unknown issued write remains to read back',409);
      }
      return durable.reconcileJob(jobId, anchors);
    } : undefined,
    resume: durable ? recoveryCall(resume) : undefined,
    reconcileTransport: durable ? async(input) => {
      const session=durable.loadSession(input.request?.jobId);
      if(access&&session&&!access.allowsWallet(addressForClaim(session.buyerBundle.presentedBy))){
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
