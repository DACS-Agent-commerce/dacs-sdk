// The seller's session admission: the authority the native profile needs
// before it opens, signs or sends anything for a new session. The operator
// supplies it as seller-owned trusted context (never the buyer's request); this
// module checks that every answer binds exactly the session it admits and
// refuses anything missing, malformed, duplicated or mismatched.
//
// sessionAdmission = { admit(query), resolveVetRecord(query) }:
//  - admit({ jobId, buyer, buyerBundleHash, sessionNonce, seller, listingPin, profile })
//    answers { disposition: 'admitted', jobId, buyer, buyerBundleHash, listingPin,
//    challenge: { nonce, consumedAt }, listingStatus: { status, observedAt },
//    participants: [{ role, claim, standardRevision, documentVersions }, ...] }:
//      * CORE §11.1.2(3): both participants are configured for this exact
//        corrective profile (the Standard commit and the complete tuple);
//      * CORE SN-1..SN-4, DACS-1 §6.3.2: the bundle's sessionNonce is the
//        challenge the seller issued for this job, consumed by this attempt;
//      * DACS-1 RB-5/RB-6, LR-3: a fresh revocation reading of this Listing is
//        `active` (revoked or unknown refuses the new session).
//  - resolveVetRecord({ jobId, role, party, ref }) answers the
//    CompositeVerificationRecord the Vet reference names (DACS-2 §7.7.1): its
//    exact hash, the orchestrator's signature, the job, the evaluated party,
//    its bundle and a passing decision are checked here.
import { ARTIFACT_SEPARATORS, canonicalize, contentHash, isCanonicalBase64Url, isCompositeVerificationRecord, signedBytes } from '@kynesyslabs/dacs';
import { verifyComponent } from './listing.mjs';

// PROFILE.json: the exact corrective profile this package implements (the
// Standard's JID-1 candidate tuple at standardRevision, spec/PROFILE.md).
export const SELLER_PROFILE = Object.freeze({
  standardRevision: 'd45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20',
  documentVersions: Object.freeze({ CORE: '0.3', 'DACS-1': '0.7', 'DACS-2': '0.6', 'DACS-3': '0.5', 'DACS-4': '0.8', 'DACS-5': '0.5' }),
});
// How old a consumed challenge and a revocation reading may be when admitted.
export const SESSION_ADMISSION_MAX_AGE_MS = 5 * 60 * 1000;

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && canonicalize(Object.keys(value).sort()) === canonicalize([...keys].sort());
const same = (left, right) => { try { return canonicalize(left) === canonicalize(right); } catch { return false; } };
const recent = (time, now) => Number.isSafeInteger(time) && time <= now && now - time <= SESSION_ADMISSION_MAX_AGE_MS;
const ADMITTED_KEYS = ['disposition', 'jobId', 'buyer', 'buyerBundleHash', 'listingPin', 'challenge', 'listingStatus', 'participants'];

export function sessionAdmissionConfig(value) {
  if (value == null) return null;
  if (!object(value) || typeof value.admit !== 'function' || typeof value.resolveVetRecord !== 'function') throw new TypeError('sessionAdmission must expose admit and resolveVetRecord');
  return value;
}

// The reason a session admission answer does not admit this exact session, or null.
export function sessionAdmissionProblem(answer, { jobId, buyer, buyerBundleHash, sessionNonce, seller, listingPin, now }) {
  if (!exactKeys(answer, ADMITTED_KEYS) || answer.disposition !== 'admitted') return 'the session is not admitted';
  if (answer.jobId !== jobId || answer.buyer !== buyer || answer.buyerBundleHash !== buyerBundleHash || !same(answer.listingPin, listingPin)) return 'the admission names another job, buyer, bundle or Listing';
  if (!exactKeys(answer.challenge, ['nonce', 'consumedAt']) || answer.challenge.nonce !== sessionNonce || !recent(answer.challenge.consumedAt, now)) return 'the presentation nonce is not a seller-issued challenge consumed by this attempt';
  if (!exactKeys(answer.listingStatus, ['status', 'observedAt']) || answer.listingStatus.status !== 'active' || !recent(answer.listingStatus.observedAt, now)) return 'the Listing has no fresh active revocation reading';
  const participants = answer.participants;
  if (!Array.isArray(participants) || participants.length !== 2) return 'the profile admission does not name exactly the buyer and the seller';
  for (const [role, claim] of [['buyer', buyer], ['seller', seller]]) {
    const entries = participants.filter((entry) => entry?.role === role);
    if (entries.length !== 1 || !exactKeys(entries[0], ['role', 'claim', 'standardRevision', 'documentVersions']) || entries[0].claim !== claim) return `the profile admission does not name the ${role} once`;
    if (entries[0].standardRevision !== SELLER_PROFILE.standardRevision || !same(entries[0].documentVersions, SELLER_PROFILE.documentVersions)) return `the ${role} is not configured for this exact profile`;
  }
  return null;
}

// The reason a resolved Vet record does not back its reference, or null.
export function vetRecordProblem(record, { ref, jobId, party, bundleHash, orchestrator }) {
  if (!isCompositeVerificationRecord(record)) return 'the Vet reference names no CompositeVerificationRecord';
  if (contentHash(record) !== ref?.contentHash) return 'the Vet record does not hash to its reference';
  if (record.jobId !== jobId || record.evaluatedParty !== party || record.bundleHash !== bundleHash) return 'the Vet record evaluates another job, party or bundle';
  if (record.signature.signer !== orchestrator || ref.signer !== orchestrator || !isCanonicalBase64Url(record.signature.value)
      || !verifyComponent({ signedBytes: signedBytes(ARTIFACT_SEPARATORS.CompositeVerificationRecord, contentHash(record)), signature: record.signature })) return 'the Vet record is not signed by the phase orchestrator';
  if (record.overallDecision !== 'pass') return `the Vet decision is ${record.overallDecision}`;
  return null;
}
