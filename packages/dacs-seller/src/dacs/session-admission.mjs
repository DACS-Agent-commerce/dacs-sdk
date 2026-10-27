// The seller's session admission: the authority the native profile needs
// before it opens, signs or sends anything for a new session. The operator
// supplies it as seller-owned trusted context (never the buyer's request); this
// module checks that every answer binds exactly the session it admits and
// refuses anything missing, malformed, duplicated or mismatched.
//
// sessionAdmission = { admit(query), resolveVetRecord(query), readVetAnchorReceipt(query), verifyVetAnchorReceipt(query),
//   readRevocationSurfaces(query), readRevocationMarker(markerAnchor) }:
//  - readRevocationSurfaces({ jobId, listingPin }) answers the DACS-1 §6.3.5/
//    §6.3.6 discovery surfaces the operator read for this Listing (core
//    RevocationSurface[], 1 to MAX_REVOCATION_SURFACES), and
//    readRevocationMarker(markerAnchor) the RevocationMarker a binding names, or
//    null. Readers also receive {signal,maxBytes,timeoutMs}: they must cap wire
//    bytes before JSON decoding and honor cancellation. Bounded raw UTF-8 bytes
//    or decoded JSON are accepted, with decoded values capped again locally.
//    They are readers only: the agent itself decides (DACS-1 RB-4..RB-6,
//    LR-3) with the core SDK's checkListingRevocation, which fetches, hashes and
//    verifies a bound marker against the Listing signer before `revoked`, and
//    answers `indeterminate` for a missing, stale, unverified or unreadable
//    surface. Only `absent` opens a new session.
//  - admit({ jobId, buyer, buyerBundleHash, sessionNonce, seller, listingPin, profile })
//    answers { disposition: 'admitted', jobId, buyer, buyerBundleHash, listingPin,
//    participants: [{ role, claim, standardRevision, documentVersions }, ...] }:
//    CORE §11.1.2(3), both participants are configured for this exact
//    corrective profile (the Standard commit and the complete tuple). An answer
//    with any other member (a `listingStatus` too) is refused.
//    It is asked only after the agent's own challenge ledger (CORE SN-1..SN-4,
//    DACS-1 §6.3.2) found the bundle's sessionNonce issued by this seller for
//    this job and buyer, and consumed it for this attempt, and after the
//    agent's own revocation check found the Listing not revoked.
//  - resolveVetRecord({ jobId, role, party, ref }) answers the
//    CompositeVerificationRecord the Vet reference names (DACS-2 §7.7.1): its
//    exact hash, the signature of the party's counterparty verifier (DACS-2
//    §7.7.2: the seller for the buyer's record, the buyer for the seller's),
//    the job, the evaluated party, its bundle, a passing decision and, under
//    the SDK's strict verifier, the requirement invocation's exact
//    `requirementHash` and replayed aggregation are checked here. A
//    presence-only claim is replayed over the exact bundle with its presentation
//    verified and the registry snapshot the operator pinned:
//  - readSessionRecipeRegistryPin({ jobId }) (optional) answers that snapshot's
//    sha-256 hash. It is read once, and only for a requirement that names a
//    presence-only claim; without it, or with another answer, such a
//    requirement is refused.
//  - readVetAnchorReceipt({ jobId, role, party, ref }) answers the CORE §5.1
//    AnchorReceipt the operator's SR-2 reader holds for that same record
//    (DACS-2 VPC-3: a Vet record is relied on only once it has a receipt at
//    `accepted` or later). This module checks what the receipt names (the
//    reference's canonical address and exact hash) and its state; whether it is
//    authentic is verifyVetAnchorReceipt's.
//    A record with no receipt, one for another address or hash, or one not yet
//    accepted (or dropped, replaced, expired, reorged, indeterminate) is refused.
//  - verifyVetAnchorReceipt({ jobId, role, party, ref, record, receipt }) answers
//    'valid', 'invalid' or 'indeterminate' for that exact record and receipt
//    (CORE SR2-4: "the receipt fields alone are assertions, not proof"; DACS-2
//    VPC-3: a verified receipt). It authenticates the receipt's evidence against
//    the chain; only 'valid' passes, and any other answer, or a throw, refuses
//    before any signature. The receipt's writer is not compared with the
//    record's signer: the Standard does not tie them (SR2-5 binds the writer
//    the receipt names, not the record's verifier).
import { ARTIFACT_SEPARATORS, admitRawJson, sameCanonicalClaimIdentity, canonicalize, checkListingRevocation, compositeVerificationAddress, contentHash, identityBundleHash, isAnchorReceipt, isCanonicalBase64Url, isCompositeVerificationRecord, isIdentityBundle, signedBytes, verifyCompositeVerificationRecord } from '@kynesyslabs/dacs';
import { verifyComponent } from './listing.mjs';

// PROFILE.json: the exact corrective profile this package implements (the
// Standard's JID-1 candidate tuple at standardRevision, spec/PROFILE.md).
export const SELLER_PROFILE = Object.freeze({
  standardRevision: 'd45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20',
  documentVersions: Object.freeze({ CORE: '0.3', 'DACS-1': '0.7', 'DACS-2': '0.6', 'DACS-3': '0.5', 'DACS-4': '0.8', 'DACS-5': '0.5' }),
});
// The most revocation surfaces one reading may name.
export const MAX_REVOCATION_SURFACES = 16;
// CORE SN-4: how long an issued presentation challenge can be presented.
export const SESSION_CHALLENGE_LIFETIME_MS = 10 * 60 * 1000;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && canonicalize(Object.keys(value).sort()) === canonicalize([...keys].sort());
const same = (left, right) => { try { return canonicalize(left) === canonicalize(right); } catch { return false; } };
const ADMITTED_KEYS = ['disposition', 'jobId', 'buyer', 'buyerBundleHash', 'listingPin', 'participants'];

// Why `bundle` is not the seller's identity for a session, or null: the
// Listing's own bundle, or a presentation of exactly it (the seller's Vet
// provider presents it afresh to the buyer's challenge), which differs only in
// presentedAt, sessionNonce and presentation, and whose presentation the seller
// signed (CORE SIG-6, as a buyer bundle's). The seller Vet record the buyer
// signs binds this bundle's hash (DACS-2 §7.7.2). The presentation's own
// sessionNonce is the buyer's to check (DACS-1 §6.3.2: the verifier of a
// presentation is its challenger), so it is not compared with this session's.
export function sellerSessionPresentationProblem(bundle, listingIdentity) {
  if (same(bundle, listingIdentity)) return null;
  if (!isIdentityBundle(bundle)) return 'the seller bundle is not an IdentityBundle';
  const fixed = ({ presentedAt: _at, sessionNonce: _nonce, presentation: _presentation, ...rest }) => rest;
  if (!same(fixed(bundle), fixed(listingIdentity))) return 'the seller bundle is not a presentation of the Listing identity';
  return identityPresentationValid(bundle, identityBundleHash(bundle)) ? null : 'the seller bundle presentation does not verify';
}

// DACS-1 BP-4 for a per-claim presentation: whether the presenter signed the
// bundle's hash. Never throws on a bundle that has no such presentation.
export function identityPresentationValid(bundle, bundleHash) {
  const proof = bundle?.presentation?.kind === 'per-claim' && Array.isArray(bundle.presentation.signatures)
    && bundle.presentation.signatures.find((entry) => sameCanonicalClaimIdentity(entry?.ref, bundle.presentedBy));
  return Boolean(proof && typeof proof.signature === 'string' && proof.signature.length === 86 && isCanonicalBase64Url(proof.signature) && verifyComponent({
    signedBytes: Buffer.from(`dacs-bundle-presentation:v1:${bundleHash}`, 'utf8'),
    signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature },
  }));
}

export function sessionAdmissionConfig(value) {
  if (value == null) return null;
  if (!object(value) || ['admit', 'resolveVetRecord', 'readVetAnchorReceipt', 'verifyVetAnchorReceipt', 'readRevocationSurfaces', 'readRevocationMarker'].some((name) => typeof value[name] !== 'function')) {
    throw new TypeError('sessionAdmission must expose admit, resolveVetRecord, readVetAnchorReceipt, verifyVetAnchorReceipt, readRevocationSurfaces and readRevocationMarker');
  }
  if (value.readSessionRecipeRegistryPin !== undefined && typeof value.readSessionRecipeRegistryPin !== 'function') {
    throw new TypeError('sessionAdmission.readSessionRecipeRegistryPin must be a function when given');
  }
  return value;
}

// The reason a session admission answer does not admit this exact session, or null.
export function sessionAdmissionProblem(answer, { jobId, buyer, buyerBundleHash, seller, listingPin }) {
  if (!exactKeys(answer, ADMITTED_KEYS) || answer.disposition !== 'admitted') return 'the session is not admitted';
  if (answer.jobId !== jobId || answer.buyer !== buyer || answer.buyerBundleHash !== buyerBundleHash || !same(answer.listingPin, listingPin)) return 'the admission names another job, buyer, bundle or Listing';
  const participants = answer.participants;
  if (!Array.isArray(participants) || participants.length !== 2) return 'the profile admission does not name exactly the buyer and the seller';
  for (const [role, claim] of [['buyer', buyer], ['seller', seller]]) {
    const entries = participants.filter((entry) => entry?.role === role);
    if (entries.length !== 1 || !exactKeys(entries[0], ['role', 'claim', 'standardRevision', 'documentVersions']) || entries[0].claim !== claim) return `the profile admission does not name the ${role} once`;
    if (entries[0].standardRevision !== SELLER_PROFILE.standardRevision || !same(entries[0].documentVersions, SELLER_PROFILE.documentVersions)) return `the ${role} is not configured for this exact profile`;
  }
  return null;
}

// DACS-1 RB-4..RB-6 for a new session on this seller's own Listing, decided by
// the core SDK over the operator's readings: null when the Listing is not
// revoked (`absent`), else { code, status, message }. A verified revocation
// marker refuses (409); an indeterminate check (a reader that throws, a
// missing, stale, unverified or malformed surface, a marker that does not read
// back or verify) refuses as unavailable (503), keeping its cause. `now` is the
// seller clock, read by the check after the surfaces are read, so a reading
// stamped by the same clock is never taken for one from the future.
const REVOCATION_READ_LIMITS = Object.freeze({ maxBytes: 64 * 1024, maxValues: 4096, timeoutMs: 10_000 });
const revocationUnavailable = reason => ({ code: 'session_admission_unavailable', status: 503, message: `the Listing revocation check is indeterminate: ${String(reason).slice(0, 160)}` });
function boundedRevocationValue(value) {
  if (value instanceof Uint8Array) return admitRawJson(value, { maxBytes: REVOCATION_READ_LIMITS.maxBytes });
  let remaining = REVOCATION_READ_LIMITS.maxBytes, values = 0;
  const text = JSON.stringify(value, (key, child) => {
    if (++values > REVOCATION_READ_LIMITS.maxValues || key.length > remaining || (typeof child === 'string' && child.length > remaining)) throw new RangeError('revocation reply exceeds its byte or value limit');
    remaining -= Buffer.byteLength(JSON.stringify(key)) + 2;
    remaining -= child === null || ['string', 'number', 'boolean'].includes(typeof child) ? Buffer.byteLength(JSON.stringify(child)) : 2;
    if (remaining < 0) throw new RangeError('revocation reply exceeds its byte limit');
    return child;
  });
  if (typeof text !== 'string' || Buffer.byteLength(text) > REVOCATION_READ_LIMITS.maxBytes) throw new RangeError('revocation reply exceeds its byte limit');
  return admitRawJson(Buffer.from(text), { maxBytes: REVOCATION_READ_LIMITS.maxBytes });
}

const ADMISSION_MAX_LIST_ITEMS=256;
const REGISTRY_PIN_PATTERN = /^[0-9a-f]{64}$/;
// Admission capabilities cap wire bytes before decoding and honor this signal.
// Returned representations also receive independent byte/value/list bounds.
export async function readAdmissionCapability(admission,method,input){
  const controller=new AbortController(),options={...REVOCATION_READ_LIMITS,signal:controller.signal};let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DOMException('admission deadline expired','TimeoutError'));},options.timeoutMs);});
  try{
    return await Promise.race([Promise.resolve().then(()=>admission[method](structuredClone(input),options)).then(value=>{
      if(controller.signal.aborted)throw new DOMException('admission read aborted','AbortError');
      if(value===undefined)throw new TypeError('admission capability returned no value');
      const result=boundedRevocationValue(value),pending=[result];let values=0;
      while(pending.length){const member=pending.pop();if(++values>options.maxValues||(Array.isArray(member)&&member.length>ADMISSION_MAX_LIST_ITEMS))throw new RangeError('admission reply exceeds collection limits');if(member&&typeof member==='object')for(const child of Object.values(member))pending.push(child);}
      return result;
    }),deadline]);
  }finally{clearTimeout(timer);controller.abort();}
}

// The recipe registry snapshot hash the operator pinned for the job (CRQ-1), or
// null when it configured no `readSessionRecipeRegistryPin`. The read is bounded
// like any admission capability and throws, keeping its cause, when it fails.
export async function readRegistryPin(admission, jobId) {
  return typeof admission.readSessionRecipeRegistryPin === 'function' ? readAdmissionCapability(admission, 'readSessionRecipeRegistryPin', { jobId }) : null;
}

// Whether a BundleRequirement names a presence-only claim, which its Vet record
// replays over the exact bundle (PCR-6) instead of through a VerifyResult.
export function hasPresenceOnlyClaim(requirement) {
  const claims = [...(Array.isArray(requirement?.required) ? requirement.required : []), ...(Array.isArray(requirement?.oneOf) ? requirement.oneOf.flat() : [])];
  return claims.some((claim) => claim?.verificationRequired === false);
}

export async function listingRevocationProblem(admission, input) {
  const controller = new AbortController();
  const options = { signal: controller.signal, maxBytes: REVOCATION_READ_LIMITS.maxBytes, timeoutMs: REVOCATION_READ_LIMITS.timeoutMs };
  let timer, failure, timedOut = false;
  const read = async (method, query) => {
    try {
      if (controller.signal.aborted) throw new Error('revocation read aborted');
      const value = await admission[method](query, options);
      if (controller.signal.aborted) throw new Error('revocation read aborted');
      return boundedRevocationValue(value);
    } catch (error) { failure = error; throw error; }
  };
  const deadline = new Promise(resolve => { timer = setTimeout(() => { timedOut = true; controller.abort(); resolve(revocationUnavailable('revocation-reader-timeout')); }, options.timeoutMs); });
  try {
    const result = await Promise.race([checkRevocationProblem({ readRevocationSurfaces: query => read('readRevocationSurfaces', query), readRevocationMarker: anchor => read('readRevocationMarker', anchor) }, input), deadline]);
    return !timedOut && failure && result?.status === 503 ? revocationUnavailable(failure?.message ?? failure) : result;
  } finally { clearTimeout(timer); controller.abort(); }
}

async function checkRevocationProblem(admission, { listing, listingPin, jobId, now }) {
  let surfaces;
  try { surfaces = await admission.readRevocationSurfaces(structuredClone({ jobId, listingPin })); }
  catch (error) { return revocationUnavailable(`revocation-surfaces-unavailable: ${error?.message ?? error}`); }
  if (!Array.isArray(surfaces) || surfaces.length === 0 || surfaces.length > MAX_REVOCATION_SURFACES) return revocationUnavailable(`revocation-surfaces-malformed (1 to ${MAX_REVOCATION_SURFACES} surfaces)`);
  const result = await checkListingRevocation(listing, listingPin.contentHash, { nowMs: now, surfaces,
    readMarker: async (anchor) => admission.readRevocationMarker(structuredClone(anchor)),
    verifyMarkerSignature: ({ signedBytes: bytes, signature }) => verifyComponent({ signedBytes: bytes, signature }) });
  if (result.disposition === 'absent') return null;
  if (result.disposition === 'revoked') return { code: 'session_not_admitted', status: 409, message: `the Listing is revoked (${result.reason})` };
  return revocationUnavailable(result.reason);
}

// The CORE §5.1 receipt states from which a Vet record may be relied on
// (DACS-2 VPC-3: `accepted` or later; dropped, replaced, expired, reorged and
// rejected are not later states). Demos specifically requires inclusion/finality
// (DEMOS-MAPPING A.2); accepted remains available to bindings that define it.
export const VET_RECEIPT_STATES = Object.freeze(['accepted', 'included', 'finalized']);

// The reason a Vet record's SR-2 receipt does not back its reference, or null:
// DACS-2 VPC-3 and §7.7.2. The receipt is a well-formed CORE §5.1 receipt for
// the reference's exact hash, at the job's canonical composite address (the
// reference's own locator), observed (not indeterminate), at `accepted` or later.
export function vetAnchorReceiptProblem(receipt, { ref, jobId, party }) {
  if (receipt == null) return 'the Vet record has no SR-2 receipt';
  if (!isAnchorReceipt(receipt)) return 'the Vet record SR-2 receipt is not a CORE receipt';
  if (ref?.anchor?.locator !== compositeVerificationAddress(jobId, party)) return 'the Vet reference is not at the job\'s canonical composite address';
  if (receipt.logicalAddress !== ref.anchor.locator || receipt.contentHash !== ref.contentHash) return 'the Vet record SR-2 receipt is for another address or hash';
  if (receipt.observationDisposition !== 'established') return 'the Vet record SR-2 receipt is not an established observation';
  // DEMOS-MAPPING A.2: Demos has no verifiable durable accepted state.
  if (receipt.substrate === 'demos' && receipt.state === 'accepted') return 'the Demos Vet record SR-2 receipt must be included or finalized';
  if (!VET_RECEIPT_STATES.includes(receipt.state)) return `the Vet record SR-2 receipt is ${receipt.state}, not accepted or later`;
  return null;
}

// The reason a resolved Vet record does not back its reference and the
// requirement invocation that names it, or null. `verifier` is the evaluated
// party's counterparty (DACS-2 §7.7.2). DACS-2 §7.7.1: the record must hash
// the invocation's exact BundleRequirement (`requirementHash`) and its
// decision must replay from the invocation's expected results under the core
// strict verifier. No VerifyResult resolver is configured, so a requirement
// whose decision needs a result body is unresolved and refused. A presence-only
// claim needs none (DACS-2 forbids a synthetic result for it): its record is
// replayed over the exact `presence.bundle`, whose presentation is verified
// (BP-4), against the operator's `presence.registryPin` (PCR-6, CRQ-1), and is
// refused without a valid pin.
export async function vetRecordProblem(record, { ref, jobId, party, bundleHash, verifier, invocation, now, presence }) {
  if (!isCompositeVerificationRecord(record)) return 'the Vet reference names no CompositeVerificationRecord';
  if (contentHash(record) !== ref?.contentHash) return 'the Vet record does not hash to its reference';
  if (record.jobId !== jobId || record.evaluatedParty !== party || record.bundleHash !== bundleHash) return 'the Vet record evaluates another job, party or bundle';
  if (!sameCanonicalClaimIdentity(record.signature.signer, verifier) || (ref.signer !== undefined && !sameCanonicalClaimIdentity(ref.signer, verifier)) || !isCanonicalBase64Url(record.signature.value)
      || !verifyComponent({ signedBytes: signedBytes(ARTIFACT_SEPARATORS.CompositeVerificationRecord, contentHash(record)), signature: record.signature })) return 'the Vet record is not signed by its counterparty verifier';
  if (record.overallDecision !== 'pass') return `the Vet decision is ${record.overallDecision}`;
  if (!object(invocation)) return 'the Vet record has no requirement invocation';
  const presenceOnly = hasPresenceOnlyClaim(invocation.requirement);
  const registryPin = presence?.registryPin;
  if (presenceOnly && !REGISTRY_PIN_PATTERN.test(registryPin)) return 'the Vet requirement names a presence-only claim and no pinned registry authority was supplied';
  let strict;
  try {
    strict = await verifyCompositeVerificationRecord(record,
      { jobId, evaluatedParty: party, bundleHash, requirement: invocation.requirement, verifier, freshness: invocation.freshness, dealSpecific: invocation.dealSpecific,
        ...(presenceOnly ? { presence: { bundle: presence.bundle, sessionRecipeRegistrySnapshotHash: registryPin } } : {}) },
      { nowMs: now, resolve: async () => null, resolveRecipe: async () => null, isRecipeSignerAuthorized: () => false, isVerifyResultSignerAuthorized: () => false,
        resolvePublicKey: (signature) => (sameCanonicalClaimIdentity(signature.signer, verifier) ? verifier : null), verify: ({ signedBytes: bytes, signature }) => verifyComponent({ signedBytes: bytes, signature }),
        verifyAuthorityAttestation: () => 'unresolved', isSessionRecipeRegistrySnapshotAuthenticated: (snapshotHash) => snapshotHash === registryPin,
        verifyIdentityPresentation: (presented) => identityPresentationValid(presented.bundle, presented.bundleHash) });
  } catch (error) { return `the Vet record does not verify against its requirement: ${String(error?.message ?? error).slice(0, 120)}`; }
  if (strict?.status !== 'valid') return `the Vet record does not verify against its requirement (${strict?.status ?? 'missing'}: ${strict?.code ?? 'unknown'})`;
  return null;
}
