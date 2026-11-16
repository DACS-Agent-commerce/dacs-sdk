// What the wire context route does with a presentation it already accepted: continue it without a first admission's checks,
// and answer a stored outcome only after the retained records it was made from have been read back.
import { identityBundleHash } from '@kynesyslabs/dacs';
import { wireOperationBinding } from '@kynesyslabs/dacs/wire';
import { boundedCall } from './bounded-call.mjs';
import { canonicalize } from './listing.mjs';
import { createCompletedOutcomeReader } from './seller-http.mjs';
import { SELLER_CONTEXT_PATH, SellerTransportError } from './seller-transport-auth.mjs';
import { sessionAdmissionProblem } from './session-admission.mjs';

// How long the provider may take to read back the retained records of a stored outcome.
const SOURCE_REVALIDATION_TIMEOUT_MS = 10_000;

/**
 * The revalidation of a stored context outcome. `provider.recoverBuyer` reads the retained Vet records passively and `retainedBody(jobId)`
 * gives the request they were made for, or null. Returns `revalidate({ jobId, outcome })`, which resolves once the provider's read gives
 * exactly the stored answer: a present answer needs both Vet records, a non-pass only the record that refused. Any other result, a failed
 * or late read included, throws SellerTransportError `seller_source_unavailable` (503) with its cause. It never rewrites the outcome.
 */
export function createContextOutcomeRevalidation({ provider, retainedBody }) {
  return async function revalidateContextOutcome({ jobId, outcome }) {
    const unavailable = (cause) => new SellerTransportError('seller_source_unavailable', 503, { cause });
    let stored, body;
    try { stored = JSON.parse(outcome.text); } catch (cause) { throw unavailable(cause); }
    if (outcome.status !== 200 || !['present', 'rejected'].includes(stored?.disposition) || (body = retainedBody(jobId)) === null) throw unavailable('retained_context_missing');
    let recovered, same;
    try {
      recovered = await boundedCall(() => provider.recoverBuyer(structuredClone(body), { writable: () => false, signal: AbortSignal.timeout(SOURCE_REVALIDATION_TIMEOUT_MS) }), { timeoutMs: SOURCE_REVALIDATION_TIMEOUT_MS });
      same = recovered !== null && recovered !== undefined && canonicalize(recovered) === canonicalize(stored);
    } catch (cause) { throw unavailable(cause); }
    if (!same) throw unavailable(recovered === null || recovered === undefined ? 'absent' : 'changed');
  };
}

/**
 * Returns `continuesAccepted(row)`: whether the host's own admission `row` lets the job's accepted presentation continue while the seller is
 * not ready. Its challenge (`ledger.retained`) must be accepted with the row's presentation, and the row admitted or running, or settled
 * with a completed context outcome (`completedOutcomeOf(jobId)`, null while there is none). An aborted or compensating row, and one
 * settled by compensation, never continues.
 */
export function createContinuationCheck({ ledger, completedOutcomeOf }) {
  return (row) => {
    const challenge = ledger.retained(row.nonce);
    if (challenge?.state !== 'accepted' || challenge.presentationHash !== row.presentationHash) return false;
    if (row.state === 'admitted' || row.state === 'running') return true;
    return row.state === 'settled' && completedOutcomeOf(row.jobId) !== null;
  };
}

/**
 * The accepted continuation of K1. `continueAccepted(request, { body, delegationExpiresAt }, { accepted })` checks that the presented bundle is
 * the kept one and that the kept admission still binds it (`session_admission_unavailable` 503 otherwise), runs `checkPolicy` again and
 * re-reads the job's admission row. No challenge expiry, generatedAt, profile admission, start limit, hold or start is checked or made.
 * Resolves with the stored `{ status, text }` of a settled admission, which reserves nothing and is answered after `revalidate`, and with
 * null for an admitted or running one, which the caller reserves. A closed row, or a settled one without a completed outcome, is
 * `context_admission_closed` (409). `assertLive(request, delegationExpiresAt)` throws once the request or its delegation has expired.
 */
export function createAcceptedContinuation({ wire, seller, pin, checkPolicy, admissionRecord, revalidate, assertLive }) {
  const readCompletedOutcome = createCompletedOutcomeReader({ journal: wire.journal, seller }).completedOutcomeWithoutReservation;
  return async function continueAccepted(request, { body, delegationExpiresAt }, { accepted }) {
    const bundle = body.buyerIdentityBundle;
    if (canonicalize(bundle) !== accepted.buyerBundleText || identityBundleHash(bundle) !== accepted.buyerBundleHash
        || sessionAdmissionProblem(accepted.admission, { jobId: request.jobId, buyer: bundle.presentedBy, buyerBundleHash: accepted.buyerBundleHash, seller, listingPin: pin }) !== null) {
      throw new SellerTransportError('session_admission_unavailable', 503);
    }
    await checkPolicy(request);
    const row = admissionRecord(request.jobId);
    if (row === null || !['admitted', 'running', 'settled'].includes(row.state)) throw new SellerTransportError('context_admission_closed', 409);
    if (row.state !== 'settled') return null;
    const outcome = await readCompletedOutcome({ path: SELLER_CONTEXT_PATH, jobId: request.jobId, binding: wireOperationBinding(request), revalidate: (stored) => revalidate({ jobId: request.jobId, outcome: stored }) });
    if (outcome === null) throw new SellerTransportError('context_admission_closed', 409);
    assertLive(request, delegationExpiresAt);
    return outcome;
  };
}
