// The Agreement a job's completed context plans, for a state read that arrives before any proposal session exists.
import { contentHash, deriveFixedPriceAgreement, isCanonicalJobId, sameCanonicalClaimIdentity } from '@kynesyslabs/dacs';
import { admitWireArtifact } from '@kynesyslabs/dacs/wire';
import { canonicalize } from './listing.mjs';
import { listingPin } from './purchase-protocol.mjs';
import { deepFreeze } from './seller-challenge-ledger.mjs';
import { SellerTransportError } from './seller-transport-auth.mjs';

const MS_PER_SECOND = 1_000;

// Why a job has no planned Agreement: the code, HTTP status and message of the stored cause.
const NO_ADMISSION = ['context_admission_missing', 404, 'the job has no accepted context admission'];
const NOT_COMPLETED = ['context_not_completed', 404, 'the job\'s context has not completed'];
const NOT_PASSED = ['context_not_passed', 404, 'the job\'s context did not complete with a present answer'];
const BINDING_MISMATCH = ['context_binding_mismatch', 409, 'the completed context is not the one the job admitted'];
const AGREEMENT_MISMATCH = ['planned_agreement_mismatch', 409, 'the retained context input does not derive this seller\'s Agreement for the job'];

const absent = ([code, status, message]) => ({ kind: 'absent', cause: { code, status, message } });

// A source that cannot be read keeps the error's own code and status, and its cause's message.
function unavailable(error) {
  const detail = error?.cause ?? error;
  return { kind: 'unavailable', cause: { code: typeof error?.code === 'string' ? error.code : 'operation_uncertain', status: Number.isInteger(error?.status) ? error.status : 503,
    message: detail instanceof Error ? detail.message : String(detail) } };
}

const partyClaim = (agreement, role) => agreement.parties.find((party) => party.role === role)?.primaryClaim;

// The Agreement the retained input derives, when it is this seller's Listing, generatedAt and deadline and the admitted parties; otherwise null.
function agreementBoundTo({ input, jobId, row, scope, pin, deadlineMs }) {
  try {
    const agreement = deriveFixedPriceAgreement(input);
    const bound = agreement.jobId === jobId && agreement.generatedAt === scope.generatedAt && canonicalize(agreement.listingRef) === canonicalize(pin)
      && agreement.terms.deadline === scope.generatedAt + deadlineMs
      && sameCanonicalClaimIdentity(partyClaim(agreement, 'buyer'), row.buyer) && sameCanonicalClaimIdentity(partyClaim(agreement, 'seller'), row.seller);
    return bound ? agreement : null;
  } catch { return null; }
}

/**
 * The host's reader of a job's planned Agreement. `admissionRecord(jobId)` is the job's admission row and `completedOutcomeOf(jobId)` its
 * completed context outcome `{ status, text }`, or null; `records` is `createSellerContextRecords`' view of both; `revalidate({ jobId, outcome })`
 * reads the outcome's retained Vet records back and throws unless they confirm it. Returns `readPlannedAgreement({ jobId })`, which throws
 * SellerTransportError `peer_job_invalid` (409) for a malformed job and a TypeError for malformed options, and never throws for evidence it
 * cannot use. It resolves a frozen `{ kind: 'present', agreement, retained }` once the stored present outcome is confirmed at its source and
 * its input derives the Agreement of this Listing, original generatedAt and deadline and the admitted parties, `{ kind: 'absent', cause }` when the
 * job has no completed present context for the admitted request, and `{ kind: 'unavailable', cause }` when the source cannot confirm it.
 * `retained` holds the job, the admitted parties as stored and the derived Agreement's hash. Nothing is signed or written, and nothing the
 * requester sends is read.
 */
export function createPlannedAgreementReader({ listing, admissionRecord, completedOutcomeOf, records, revalidate }) {
  const pin = listingPin(listing), deadlineMs = listing.terms.deadlineSecAfterCommit * MS_PER_SECOND;
  async function plan(jobId) {
    const row = admissionRecord(jobId);
    if (row === null || row === undefined) return absent(NO_ADMISSION);
    const outcome = completedOutcomeOf(jobId);
    if (outcome === null) return absent(NOT_COMPLETED);
    const stored = outcome.status === 200 ? JSON.parse(outcome.text) : null;
    if (stored?.disposition !== 'present') return absent(NOT_PASSED);
    const scope = records.completedScope({ jobId, buyer: row.buyer });
    if (scope === null || records.retainedBody(jobId) === null) return absent(BINDING_MISMATCH);
    await revalidate({ jobId, outcome });
    const agreement = agreementBoundTo({ input: stored.value.input, jobId, row, scope, pin, deadlineMs });
    if (agreement === null) return absent(AGREEMENT_MISMATCH);
    return { kind: 'present', agreement, retained: { jobId, buyer: row.buyer, seller: row.seller, agreementHash: contentHash(agreement) } };
  }
  return async function readPlannedAgreement(input) {
    if (input === null || typeof input !== 'object') throw new TypeError('readPlannedAgreement takes { jobId }');
    if (!isCanonicalJobId(input.jobId)) throw new SellerTransportError('peer_job_invalid', 409);
    try { return deepFreeze(await plan(input.jobId)); } catch (error) { return deepFreeze(unavailable(error)); }
  };
}

/**
 * The records `checkWireRequest` takes for a state read, from a present planned Agreement: the exact retained object and the draft admitted from its
 * canonical text, as the wire admits any artifact. The draft is not signed, so it is never a commitment or Agreement of the continuation pair.
 */
export function plannedStateRecords({ agreement, retained }) {
  return { retained, artifacts: [admitWireArtifact(Buffer.from(canonicalize(agreement), 'utf8'))], held: false };
}
