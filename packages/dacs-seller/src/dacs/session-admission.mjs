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
//    `requirementHash` and replayed aggregation are checked here. Verified
//    claims without `recipeVersion` require resolveLatestRecipe to authenticate
//    the family's latest live version in the job's registry snapshot.
//    Presence-only claims instead replay over the exact authenticated bundle,
//    without a synthetic VerifyResult. The optional
//    readSessionRecipeRegistryPin({ jobId }) supplies their snapshot hash and
//    is read once when either requirement includes a presence-only claim.
//    Both replay modes must use one snapshot pin for the job. Direct helper
//    replay uses optional `evidence`, independent of agent config:
//    resolveContent, resolveRecipe, resolveLatestRecipe, isRecipeSignerAuthorized,
//    isVerifyResultSignerAuthorized and verifyAuthorityAttestation. The helper
//    qualifies each implicit member against its family's latest live version.
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
import { ARTIFACT_SEPARATORS, admitRawJson, canonicalDemosAgentPublicKey, sameCanonicalClaimIdentity, canonicalize, checkListingRevocation, compositeVerificationAddress, contentHash, ed25519Verify, identityBundleHash, isAnchorReceipt, isCanonicalBase64Url, isCompositeVerificationRecord, isIdentityBundle, publicKeyFromRaw, resolveRecipe as authenticatePinnedRecipe, signedBytes, verifyCompositeVerificationRecord } from '@kynesyslabs/dacs';
import { verifyComponent } from './listing.mjs';
import { isCanonicalEd25519Signature, isSmallOrderPublicKey } from './demos-claims.mjs';

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
  if ('vetEvidence' in value) throw new TypeError('vetEvidence belongs to the direct Vet replay helper; this agent restores only empty invocations');
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
// A decoded answer must already be exactly a JSON value. The bounded
// serialization below is also its normalization, and JSON silently drops an
// `undefined` member, a function or a symbol (and renders NaN, array holes and
// a toJSON result as something else), so an answer could otherwise be admitted
// by losing a member it carried: sessionAdmissionProblem checks the original
// keys and would refuse it.
function assertJsonMember(value, ancestors = [], seen = { values: 0 }) {
  if (++seen.values > REVOCATION_READ_LIMITS.maxValues) throw new RangeError('revocation reply exceeds its value limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new TypeError('revocation reply contains a non-JSON member');
  if (ancestors.includes(value)) throw new TypeError('revocation reply contains a cycle');
  ancestors.push(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new TypeError('revocation reply contains a non-JSON member');
    for (const member of value) assertJsonMember(member, ancestors, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('revocation reply contains a non-JSON member');
    for (const key of Object.keys(value)) assertJsonMember(value[key], ancestors, seen);
  }
  ancestors.pop();
}
function boundedRevocationValue(value) {
  if (value instanceof Uint8Array) return admitRawJson(value, { maxBytes: REVOCATION_READ_LIMITS.maxBytes });
  assertJsonMember(value);
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
// The value and list bounds every returned representation shares: the outer
// reply of every read, and a VerifyResult decoded from byte content, whose
// encoding hides its lists and value count from the outer reply's own shape.
function boundedAdmissionValue(value, options) {
  const pending=[value];let values=0;
  while(pending.length){const member=pending.pop();if(++values>options.maxValues||(Array.isArray(member)&&member.length>ADMISSION_MAX_LIST_ITEMS))throw new RangeError('admission reply exceeds collection limits');if(member&&typeof member==='object')for(const child of Object.values(member))pending.push(child);}
  return value;
}
// Admission capabilities cap wire bytes before decoding and honor this signal.
// Returned representations also receive independent byte/value/list bounds. An
// optional `parentSignal` (the caller's shared deadline) aborts an active read
// too, so a read that ignores its own per-read deadline cannot outlive it.
export async function readAdmissionCapability(admission,method,input,parentSignal){
  const controller=new AbortController(),options={...REVOCATION_READ_LIMITS,signal:controller.signal};let timer,rejectAborted;
  const forwardAbort=()=>controller.abort();
  if(parentSignal){if(parentSignal.aborted)controller.abort();else parentSignal.addEventListener('abort',forwardAbort,{once:true});}
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DOMException('admission deadline expired','TimeoutError'));},options.timeoutMs);});
  const aborted=parentSignal?new Promise((_,reject)=>{rejectAborted=()=>reject(new DOMException('admission read aborted','AbortError'));if(parentSignal.aborted)rejectAborted();else parentSignal.addEventListener('abort',rejectAborted,{once:true});}):null;
  try{
    const work=Promise.resolve().then(()=>admission[method](structuredClone(input),options)).then(value=>{
      if(controller.signal.aborted)throw new DOMException('admission read aborted','AbortError');
      if(value===undefined)throw new TypeError('admission capability returned no value');
      return boundedAdmissionValue(boundedRevocationValue(value),options);
    });
    return await Promise.race(aborted?[work,deadline,aborted]:[work,deadline]);
  }finally{clearTimeout(timer);if(rejectAborted)parentSignal.removeEventListener('abort',rejectAborted);parentSignal?.removeEventListener('abort',forwardAbort);controller.abort();}
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

// The direct replay helper reads authenticated operator evidence for a record
// whose requirement names verified claims. The optional
// `resolveLatestRecipe` answers DACS-2 §7.4.3 for an unpinned claim.
const SHA256_HEX = /^[0-9a-f]{64}$/;
// One strict replay reads its evidence within this time in total, on top of
// each read's own byte, value and deadline limits.
const VET_EVIDENCE_REPLAY_TIMEOUT_MS = 30_000;
// Without `evidence` nothing resolves, so a requirement whose decision needs
// a result body is unresolved and refused.
const NO_EVIDENCE_DEPS = Object.freeze({ resolve: async () => null, resolveRecipe: async () => null, isRecipeSignerAuthorized: () => false, isVerifyResultSignerAuthorized: () => false,
  verifyAuthorityAttestation: () => 'unresolved', verifyRequirementParameters: (input) => requirementParametersMatch(input) });
const vetEvidenceTimeout = () => new DOMException('the Vet evidence deadline expired', 'TimeoutError');

// DACS-2 §7.5.2: a ClaimRequirement's exact parameters are re-derived from the
// authenticated result. `verificationMethod` is the result's method; every
// other parameter must occur, canonically equal, in the result's `data`.
function requirementParametersMatch({ result, expected }) {
  for (const [key, expectedValue] of Object.entries(expected.requirement.parameters ?? {})) {
    if (key === 'verificationMethod') { if (result.method !== expectedValue) return false; }
    else if (!object(result.data) || !Object.prototype.hasOwnProperty.call(result.data, key) || !same(result.data[key], expectedValue)) return false;
  }
  return true;
}

// Preflight every verified member's family metadata, including unused pins.
// Result projection and aggregation remain the core verifier's decisions.
function recipeFamilies(invocation) {
  const requirement=invocation.requirement, families=new Map();
  const members=[...(Array.isArray(requirement?.required)?requirement.required:[]),...(Array.isArray(requirement?.oneOf)?requirement.oneOf.flatMap(group=>Array.isArray(group)?group:[]):[])];
  const results=[...(Array.isArray(invocation.freshness)?invocation.freshness:[]),...(Array.isArray(invocation.dealSpecific)?invocation.dealSpecific:[])];
  for(const member of members){
    if(member?.verificationRequired!==true)continue;
    const methods=member.parameters?.verificationMethod!==undefined?[member.parameters.verificationMethod]:results.filter(result=>result?.scheme===member.scheme).map(result=>result.method);
    if(!methods.length||methods.some(method=>typeof method!=='string'||!method))throw new TypeError('the verified requirement has no resolvable recipe method family');
    if(member.recipeVersion!==undefined&&results.some(result=>result?.requirement&&same(result.requirement,member)))continue; // Bound pins are authenticated by the core.
    for(const method of methods)families.set(canonicalize([member.scheme,method,member.recipeVersion??null]),{scheme:member.scheme,method,...(member.recipeVersion===undefined?{}:{recipeVersion:member.recipeVersion})});
  }
  return [...families.values()];
}

// An unused explicit pin must still resolve to an authenticated live recipe.
async function pinnedSessionRecipeProblem(read,selector) {
  const recipe=await read('resolveRecipe',selector);
  if(!object(recipe)||recipe.scheme!==selector.scheme||recipe.recipeVersion!==selector.recipeVersion||recipe.availability!=='live')return 'the Vet pinned recipe is unavailable, non-live or differs from its selector';
  const signature=recipe.signature,key=evidenceSignerKey(signature?.signer);
  if(!key||(await read('isRecipeSignerAuthorized',{recipe,signature}))!==true)return 'the Vet pinned recipe-signature is not authorized';
  try {
    await authenticatePinnedRecipe('Vet replay',selector,{readRegistry:async()=>({entries:[recipe]}),stewardSigner:signature.signer,stewardPublicKey:key,
      verify:(bytes,signature,publicKey)=>ed25519Verify(bytes,signature,publicKeyFromRaw(publicKey))});
  } catch { return 'the Vet pinned recipe shape, method or signature does not authenticate'; }
  return null;
}

// DACS-2 §7.4.3: qualify each actual implicit result/member projection
// against the authenticated registry's latest live version. A stale member
// fails only that member; unavailable/non-live or malformed selection evidence refuses replay.
// Successful selections across both party records must share one snapshot.
async function latestSessionRecipeProblem(read, { scheme, method, recipeVersion }, pins) {
  return read('resolveLatestRecipe', { scheme, method, required: true }, selection=>{
    if (selection === null) return 'the Vet session registry has no recipe version for the unpinned claim';
    if (!object(selection) || !exactKeys(selection, ['sessionRecipeRegistrySnapshotHash', 'recipeVersion', 'availability'])) throw malformedEvidence('the Vet session registry selection is malformed');
    const pin = selection.sessionRecipeRegistrySnapshotHash;
    if (typeof pin !== 'string' || !SHA256_HEX.test(pin)) throw malformedEvidence('the Vet session registry pin is malformed');
    if (pins.length > 0 && pins[0] !== pin) throw malformedEvidence('the Vet session registry resolved another session registry snapshot');
    if (!Number.isSafeInteger(selection.recipeVersion) || selection.recipeVersion < 1) throw malformedEvidence('the Vet session registry recipe version is malformed');
    if (!['live','disabled','failed','mocked'].includes(selection.availability)) throw malformedEvidence('the Vet session registry availability is malformed');
    if (selection.availability !== 'live') return 'the Vet session registry latest recipe version is not live';
    if (recipeVersion !== undefined && selection.recipeVersion !== recipeVersion) return 'the Vet result is not the latest live recipe version in the authenticated session registry';
    if(pins.length===0)pins.push(pin);
    return null;
  });
}

// A malformed operator reply is a deterministic record problem, not an
// unavailable read: it keeps its own marker so the caller can reject the
// record instead of reporting the evidence source as down.
const VET_EVIDENCE_MALFORMED = Symbol('Vet evidence malformed');
const malformedEvidence = (message) => Object.assign(new TypeError(message), { [VET_EVIDENCE_MALFORMED]: true });

// The evidence reads of one replay, each bounded by readAdmissionCapability
// and all by one deadline. The deadline also aborts the read in flight, so a
// reader that ignores its own per-read limit cannot hold the replay past 30 s.
// The first failure is kept (even a rejection with `undefined`) so the caller
// sees the real cause (timeout, oversize, throw), not the verifier's
// "unresolved".
function vetEvidenceReads(evidence, scope) {
  const controller = new AbortController(), selections=new Map();
  let expired = false, failed = false, failure, malformed, timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; controller.abort(); reject(vetEvidenceTimeout()); }, VET_EVIDENCE_REPLAY_TIMEOUT_MS);
  });
  // A deadline that fires between reads has no racer; keep its rejection handled.
  deadline.catch(() => {});
  const read = async (method, input, decode = (reply) => reply) => {
    try {
      if (expired) throw vetEvidenceTimeout();
      const key=['resolveLatestRecipe','resolveRecipe'].includes(method)?canonicalize([method,input.scheme,input.method,input.recipeVersion??null]):null;
      if(key!==null&&!selections.has(key))selections.set(key,readAdmissionCapability(evidence,method,{...scope,...input},controller.signal));
      const pending=key===null?readAdmissionCapability(evidence,method,{...scope,...input},controller.signal):selections.get(key);
      const reply = await Promise.race([pending, deadline]);
      if (expired) throw vetEvidenceTimeout();
      return decode(reply);
    } catch (error) {
      if (error?.[VET_EVIDENCE_MALFORMED]) { malformed ??= error.message; throw error; }
      const cause = expired ? vetEvidenceTimeout() : error; if (!failed) { failed = true; failure = cause; } throw cause;
    }
  };
  return { read, failure: () => (failed ? failure : undefined), hasFailure: () => failed, malformed: () => malformed,
    close: () => { clearTimeout(timer); controller.abort(); } };
}

// The content shape the core verifier takes from an operator reply: null
// (absent), canonical JSON, or base64url bytes. A VerifyResult returned as
// bytes is decoded to the canonical JSON object the core re-hashes, under the
// same value and list bounds a canonical-json reply receives; an authority
// proof stays bytes so its byte hash is preserved, and its empty value is a
// legitimate (hashing to the empty digest) raw body.
function vetEvidenceContent(reply, resultContent = false) {
  if (reply === null) return null;
  if (exactKeys(reply, ['encoding', 'value'])) {
    if (reply.encoding === 'canonical-json' && object(reply.value)) return reply;
    if (reply.encoding === 'bytes' && typeof reply.value === 'string' && (reply.value === '' ? !resultContent : isCanonicalBase64Url(reply.value))) {
      const value = Uint8Array.from(Buffer.from(reply.value, 'base64url'));
      if (!resultContent) return { encoding: 'bytes', value };
      let decoded;
      try { decoded = boundedAdmissionValue(admitRawJson(value, { maxBytes: REVOCATION_READ_LIMITS.maxBytes }), REVOCATION_READ_LIMITS); }
      catch (error) {
        // Only a byte bound says the evidence source could not answer; every
        // other admission failure is a deterministic malformed document.
        if (error instanceof RangeError || error?.code === 'BYTE-LIMIT-EXCEEDED') throw error;
        throw malformedEvidence(`the Vet evidence content reply is malformed: ${String(error?.message ?? error).slice(0, 120)}`);
      }
      if (object(decoded)) return { encoding: 'canonical-json', value: decoded };
    }
  }
  throw malformedEvidence('the Vet evidence content reply is malformed');
}

// The self-certifying Ed25519 key a signer claim names, or null: the Demos
// agent claim the session participants use, or the canonical
// `key:<32-byte lowercase hex>` claim a recipe steward or VerifyResult signer
// may use. A small-order point proves only trivial signatures and is refused.
const KEY_CLAIM = /^key:([0-9a-f]{64})$/;
function evidenceSignerKey(claim) {
  if (typeof claim !== 'string') return null;
  const match = KEY_CLAIM.exec(claim);
  let raw;
  try { raw = match ? Uint8Array.from(Buffer.from(match[1], 'hex')) : canonicalDemosAgentPublicKey(claim); }
  catch { return null; }
  return raw && !isSmallOrderPublicKey(raw) ? raw : null;
}

// The core verifier's resolvers over the operator's readers. Content is
// authenticated by the verifier itself (hash against its reference, both
// signatures); the operator decides which signers may sign and whether the
// authority proof holds. Only an explicit `true` authorizes a signer, and only
// `valid` or `unresolved` is a usable attestation verdict.
const vetEvidenceDeps = (read) => ({
  resolve: (ref) => read('resolveContent', { anchor: ref.anchor, contentHash: ref.contentHash }, (reply) => vetEvidenceContent(reply, ref.recipeVersion !== undefined)),
  resolveRecipe: (selector) => read('resolveRecipe', selector),
  isRecipeSignerAuthorized: async (recipe, signature) => (await read('isRecipeSignerAuthorized', { recipe, signature })) === true,
  isVerifyResultSignerAuthorized: async (result, signature, expected) => (await read('isVerifyResultSignerAuthorized', { result, signature, expected })) === true,
  verifyAuthorityAttestation: async (input) => {
    const verdict = await read('verifyAuthorityAttestation', input);
    return verdict === 'valid' || verdict === 'unresolved' ? verdict : 'invalid';
  },
  verifyRequirementParameters: (input) => requirementParametersMatch(input),
});

// The core verifier's expectation for each invocation result: the retained
// `sourceJobId` is bound to the job by the invocation check, not by the verifier.
const expectedResults = (results) => results.map(({ ref, scheme, identifier, method, requirement }) => ({ ref, scheme, identifier, method, requirement }));

// The reason a resolved Vet record does not back its reference and the
// requirement invocation that names it, or null. `verifier` is the evaluated
// party's counterparty (DACS-2 §7.7.2). DACS-2 §7.7.1: the record must hash
// the invocation's exact BundleRequirement (`requirementHash`) and its
// decision must replay from the invocation's expected results under the core
// strict verifier. The VerifyResults, recipes and authority proofs that replay
// needs come from this direct helper's operator `evidence`,
// read for this `role`'s record. A claim without `recipeVersion` is compared
// with the operator's authenticated session registry family head. A member
// whose result differs from its selected live version is unsatisfied; another
// pinned alternative may pass. An unavailable/non-live family refuses replay. Without evidence, a
// required verified member cannot be satisfied. Throws the first failure of an evidence reader (timeout, oversize,
// a throw): that is unavailable evidence, not a record that fails its
// requirement. Malformed content or registry replies are record problems.
// A presence-only claim needs no VerifyResult (DACS-2 forbids a synthetic
// result): its record is replayed over the exact `presence.bundle`, whose
// presentation is verified (BP-4), against the operator's `presence.registryPin`
// (PCR-6, CRQ-1), and is refused without a valid pin.
// `sessionRegistryPins` is one array shared by the record checks of one job:
// the first authenticated session registry pin a record resolves becomes the
// job's pin, and every later record of that job must resolve the same one.
export async function vetRecordProblem(record, { ref, jobId, role, party, bundleHash, verifier, invocation, now, evidence, presence, sessionRegistryPins }) {
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
  const pins = sessionRegistryPins ?? [];
  if (presenceOnly) {
    // Retained sessions must replay after ordinary claim expiry, without
    // changing the bundle or inventing a different evaluation time.
    if (Array.isArray(presence?.bundle?.claims) && presence.bundle.claims.some(claim => claim?.expiresAt !== undefined))
      return 'expiring claims cannot be retained for presence-only seller sessions';
    if (pins.length > 0 && pins[0] !== registryPin) return 'the Vet session registry resolved another session registry snapshot';
    if (pins.length === 0) pins.push(registryPin);
  }
  const reads = evidence ? vetEvidenceReads(evidence, { jobId, role, party }) : null;
  // Every signature is verified with the key its own signer claim names (a
  // Demos agent or a canonical `key:` claim); the operator's policy decides
  // which signers other than the verifier may sign.
  const resolvePublicKey = (signature) => (signature?.algorithm !== 'ed25519'
    || (!sameCanonicalClaimIdentity(signature.signer, verifier) && !reads) ? null : evidenceSignerKey(signature.signer));
  const verify = ({ signedBytes: bytes, signature, publicKey }) => publicKey instanceof Uint8Array
    && isCanonicalEd25519Signature(signature?.value) && ed25519Verify(bytes, Buffer.from(signature.value, 'base64url'), publicKeyFromRaw(publicKey));
  let strict, thrown, problem;
  try {
    for(const family of recipeFamilies(invocation)){
      problem=family.recipeVersion!==undefined
        ?!reads?'the Vet pinned recipe evidence is unavailable':await pinnedSessionRecipeProblem(reads.read,family)
        :!reads||typeof evidence.resolveLatestRecipe!=='function'?'the Vet requirement does not pin a recipe version for a verified claim':await latestSessionRecipeProblem(reads.read,family,pins);
      if(problem)break;
    }
    if (!problem) strict = await verifyCompositeVerificationRecord(record,
      { jobId, evaluatedParty: party, bundleHash, requirement: invocation.requirement, verifier, freshness: expectedResults(invocation.freshness), dealSpecific: expectedResults(invocation.dealSpecific),
        ...(presenceOnly ? { presence: { bundle: presence.bundle, sessionRecipeRegistrySnapshotHash: registryPin } } : {}) },
      { nowMs: now, ...(reads ? vetEvidenceDeps(reads.read) : NO_EVIDENCE_DEPS), resolvePublicKey, verify,
        isSessionRecipeRegistrySnapshotAuthenticated: (snapshotHash) => snapshotHash === registryPin,
        verifyIdentityPresentation: (presented) => identityPresentationValid(presented.bundle, presented.bundleHash),
        isImplicitRecipeVersionSelected: async ({ expected }) => {
          const issue = !reads || typeof evidence.resolveLatestRecipe !== 'function' ? 'the Vet requirement does not pin a recipe version for a verified claim'
            : await latestSessionRecipeProblem(reads.read, { scheme: expected.scheme, method: expected.method, recipeVersion: expected.ref.recipeVersion }, pins);
          problem ??= issue;
          return issue === null;
        } });
  } catch (error) { thrown = error; } finally { reads?.close(); }
  if (reads?.malformed()) return reads.malformed();
  if (reads?.hasFailure()) throw reads.failure();
  if (problem && strict?.status !== 'valid') return problem;
  if (thrown) return `the Vet record does not verify against its requirement: ${String(thrown?.message ?? thrown).slice(0, 120)}`;
  if (strict?.status !== 'valid') return `the Vet record does not verify against its requirement (${strict?.status ?? 'missing'}: ${strict?.code ?? 'unknown'})`;
  return null;
}
