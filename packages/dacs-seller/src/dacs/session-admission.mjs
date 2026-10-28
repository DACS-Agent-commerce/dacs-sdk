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
//    `requirementHash` and replayed aggregation are checked here. A requirement
//    with verified claims must pin each claim's `recipeVersion` (the seller has
//    no authenticated registry snapshot to prove an implicit version is the
//    latest) and replays only through the optional
//    `vetEvidence = { resolveContent, resolveRecipe, isRecipeSignerAuthorized,
//    isVerifyResultSignerAuthorized, verifyAuthorityAttestation }`, read with the
//    admission readers' limits (see vetRecordProblem).
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
  const proof = bundle.presentation?.kind === 'per-claim' && Array.isArray(bundle.presentation.signatures)
    && bundle.presentation.signatures.find((entry) => sameCanonicalClaimIdentity(entry?.ref, bundle.presentedBy));
  const valid = proof && typeof proof.signature === 'string' && proof.signature.length === 86 && isCanonicalBase64Url(proof.signature) && verifyComponent({
    signedBytes: Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(bundle)}`, 'utf8'),
    signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature },
  });
  return valid ? null : 'the seller bundle presentation does not verify';
}

export function sessionAdmissionConfig(value) {
  if (value == null) return null;
  if (!object(value) || ['admit', 'resolveVetRecord', 'readVetAnchorReceipt', 'verifyVetAnchorReceipt', 'readRevocationSurfaces', 'readRevocationMarker'].some((name) => typeof value[name] !== 'function')) {
    throw new TypeError('sessionAdmission must expose admit, resolveVetRecord, readVetAnchorReceipt, verifyVetAnchorReceipt, readRevocationSurfaces and readRevocationMarker');
  }
  const evidence = value.vetEvidence;
  if (evidence !== undefined && (!object(evidence) || VET_EVIDENCE_READERS.some((name) => typeof evidence[name] !== 'function'))) {
    throw new TypeError(`sessionAdmission.vetEvidence must expose ${VET_EVIDENCE_READERS.join(', ')}`);
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
      const result=boundedRevocationValue(value),pending=[result];let values=0;
      while(pending.length){const member=pending.pop();if(++values>options.maxValues||(Array.isArray(member)&&member.length>ADMISSION_MAX_LIST_ITEMS))throw new RangeError('admission reply exceeds collection limits');if(member&&typeof member==='object')for(const child of Object.values(member))pending.push(child);}
      return result;
    });
    return await Promise.race(aborted?[work,deadline,aborted]:[work,deadline]);
  }finally{clearTimeout(timer);if(rejectAborted)parentSignal.removeEventListener('abort',rejectAborted);parentSignal?.removeEventListener('abort',forwardAbort);controller.abort();}
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

// The readers of `sessionAdmission.vetEvidence`, the operator's authenticated
// evidence for a record whose requirement names verified claims.
const VET_EVIDENCE_READERS = ['resolveContent', 'resolveRecipe', 'isRecipeSignerAuthorized', 'isVerifyResultSignerAuthorized', 'verifyAuthorityAttestation'];
// One strict replay reads its evidence within this time in total, on top of
// each read's own byte, value and deadline limits.
const VET_EVIDENCE_REPLAY_TIMEOUT_MS = 30_000;
// Without `vetEvidence` nothing resolves, so a requirement whose decision needs
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

// DACS-2 §7.4.3: a ClaimRequirement without `recipeVersion` selects the latest
// live version in the authenticated session registry snapshot. This seller's
// evidence contract carries no such snapshot, so an implicit version cannot be
// proven to be the latest family version; accepting the result's own version
// would let an old signed recipe replay. Refuse rather than guess.
function unpinnedVerifiedResult(results) {
  return Array.isArray(results) && results.some((entry) => object(entry?.requirement)
    && entry.requirement.verificationRequired !== false && entry.requirement.recipeVersion === undefined);
}

// The evidence reads of one replay, each bounded by readAdmissionCapability
// and all by one deadline. The deadline also aborts the read in flight, so a
// reader that ignores its own per-read limit cannot hold the replay past 30 s.
// The first failure is kept (even a rejection with `undefined`) so the caller
// sees the real cause (timeout, oversize, throw), not the verifier's
// "unresolved".
function vetEvidenceReads(evidence, scope) {
  const controller = new AbortController();
  let expired = false, failed = false, failure, timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { expired = true; controller.abort(); reject(vetEvidenceTimeout()); }, VET_EVIDENCE_REPLAY_TIMEOUT_MS);
  });
  // A deadline that fires between reads has no racer; keep its rejection handled.
  deadline.catch(() => {});
  const read = async (method, input, decode = (reply) => reply) => {
    try {
      if (expired) throw vetEvidenceTimeout();
      const reply = await Promise.race([readAdmissionCapability(evidence, method, { ...scope, ...input }, controller.signal), deadline]);
      if (expired) throw vetEvidenceTimeout();
      return decode(reply);
    } catch (error) { const cause = expired ? vetEvidenceTimeout() : error; if (!failed) { failed = true; failure = cause; } throw cause; }
  };
  return { read, failure: () => (failed ? failure : undefined), hasFailure: () => failed, close: () => { clearTimeout(timer); controller.abort(); } };
}

// The content shape the core verifier takes from an operator reply: null
// (absent), canonical JSON, or base64url bytes. A VerifyResult returned as
// bytes is decoded to the canonical JSON object the core re-hashes; an
// authority proof stays bytes so its byte hash is preserved.
function vetEvidenceContent(reply, resultContent = false) {
  if (reply === null) return null;
  if (exactKeys(reply, ['encoding', 'value'])) {
    if (reply.encoding === 'canonical-json' && object(reply.value)) return reply;
    if (reply.encoding === 'bytes' && typeof reply.value === 'string' && isCanonicalBase64Url(reply.value)) {
      const value = Uint8Array.from(Buffer.from(reply.value, 'base64url'));
      if (!resultContent) return { encoding: 'bytes', value };
      const decoded = admitRawJson(value, { maxBytes: REVOCATION_READ_LIMITS.maxBytes });
      if (object(decoded)) return { encoding: 'canonical-json', value: decoded };
    }
  }
  throw new TypeError('the Vet evidence content reply is malformed');
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
// needs come from the operator's `evidence` (`sessionAdmission.vetEvidence`),
// read for this `role`'s record. Without it a requirement whose decision needs
// a result body is unresolved and refused. Throws the first failure of an
// evidence reader (timeout, oversize, a throw): that is unavailable evidence,
// not a record that fails its requirement.
export async function vetRecordProblem(record, { ref, jobId, role, party, bundleHash, verifier, invocation, now, evidence }) {
  if (!isCompositeVerificationRecord(record)) return 'the Vet reference names no CompositeVerificationRecord';
  if (contentHash(record) !== ref?.contentHash) return 'the Vet record does not hash to its reference';
  if (record.jobId !== jobId || record.evaluatedParty !== party || record.bundleHash !== bundleHash) return 'the Vet record evaluates another job, party or bundle';
  if (!sameCanonicalClaimIdentity(record.signature.signer, verifier) || (ref.signer !== undefined && !sameCanonicalClaimIdentity(ref.signer, verifier)) || !isCanonicalBase64Url(record.signature.value)
      || !verifyComponent({ signedBytes: signedBytes(ARTIFACT_SEPARATORS.CompositeVerificationRecord, contentHash(record)), signature: record.signature })) return 'the Vet record is not signed by its counterparty verifier';
  if (record.overallDecision !== 'pass') return `the Vet decision is ${record.overallDecision}`;
  if (!object(invocation)) return 'the Vet record has no requirement invocation';
  if (unpinnedVerifiedResult(invocation.freshness) || unpinnedVerifiedResult(invocation.dealSpecific)) return 'the Vet requirement does not pin a recipe version for a verified claim';
  const reads = evidence ? vetEvidenceReads(evidence, { jobId, role, party }) : null;
  // The verifier checks every signature itself with the signer's own key; the
  // operator's policy decides which signers other than the verifier may sign.
  const resolvePublicKey = (signature) => (sameCanonicalClaimIdentity(signature.signer, verifier) ? verifier : reads && signature.algorithm === 'ed25519' ? signature.signer : null);
  let strict, thrown;
  try {
    strict = await verifyCompositeVerificationRecord(record,
      { jobId, evaluatedParty: party, bundleHash, requirement: invocation.requirement, verifier, freshness: expectedResults(invocation.freshness), dealSpecific: expectedResults(invocation.dealSpecific) },
      { nowMs: now, ...(reads ? vetEvidenceDeps(reads.read) : NO_EVIDENCE_DEPS), resolvePublicKey, verify: ({ signedBytes: bytes, signature }) => verifyComponent({ signedBytes: bytes, signature }) });
  } catch (error) { thrown = error; } finally { reads?.close(); }
  if (reads?.hasFailure()) throw reads.failure();
  if (thrown) return `the Vet record does not verify against its requirement: ${String(thrown?.message ?? thrown).slice(0, 120)}`;
  if (strict?.status !== 'valid') return `the Vet record does not verify against its requirement (${strict?.status ?? 'missing'}: ${strict?.code ?? 'unknown'})`;
  return null;
}
