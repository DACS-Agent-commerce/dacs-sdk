// The session state the host reads when the operator supplies no `contextSessionState`. A purchase that retains no commitment work and
// holds no payment is abandoned once an hour has passed since its admission and, when the seller retains an Agreement, its deadline has
// passed: the seller reads its session as aborted by itself, which gives back the units the purchase still held. A purchase whose
// proposal was refused, or never made, retains no Agreement and nothing can be paid for it. A payment is accepted only when included
// before the deadline, so after it a commitment could never be paid and the purchase is closed to new ones. A purchase that retains commitment work or holds a payment, or whose commitment or payment attempt is still pending, is never
// read as abandoned: a payment included before the deadline is accepted however late its claim arrives. A commitment refused with no
// effect leaves no such work, so that purchase is read like one with no commitment.
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';

/** How long a purchase that retains no commitment work and holds no payment may go past its admission before it reads as abandoned. */
export const ABANDONED_PURCHASE_MS = 3_600_000;

const ABANDONED_STATE = 'aborted-by-self';
const { proposals, commitments, payments } = DACS_SELLER_HTTP_PATHS;

/** Whether an attempt on a route a later retry could still finish is open. */
const hasOpenAttempt = (operationState, jobId) => [proposals, commitments, payments].some((path) => operationState({ jobId, path }) === 'pending');

/**
 * Builds the synchronous `({ jobId }) => state` reader. `admissionRecord(jobId)` is the job's admission row or null,
 * `operationState({ jobId, path })` the wire journal's state of that route's operation, `retainsCommitmentWork(jobId)` whether the
 * seller retains commitment work for the job, `holdsPayment(jobId)` whether it retains or recorded a payment for the job,
 * `agreementDeadline(jobId)` the deadline in milliseconds of the Agreement the seller retains for the job, or null when it retains no
 * Agreement, and `now()` the host clock. The reader answers `'aborted-by-self'` for a settled row that retains no commitment work and
 * holds no payment, once `ABANDONED_PURCHASE_MS` has passed since its admission and its Agreement's deadline has passed (a purchase
 * that retains no Agreement has no deadline to wait for). It answers `null` (unknown) for everything else: retained commitment work, a
 * held payment, an open attempt, a retained Agreement with no readable deadline, and a read that throws.
 */
export function createAbandonedPurchaseState({ admissionRecord, operationState, retainsCommitmentWork, holdsPayment, agreementDeadline, now }) {
  return ({ jobId }) => {
    try {
      const row = admissionRecord(jobId);
      if (row?.state !== 'settled' || !Number.isSafeInteger(row.admittedAt) || now() - row.admittedAt < ABANDONED_PURCHASE_MS) return null;
      if (hasOpenAttempt(operationState, jobId) || retainsCommitmentWork(jobId) || holdsPayment(jobId)) return null;
      const deadline = agreementDeadline(jobId);
      if (deadline === null) return ABANDONED_STATE;
      if (!Number.isSafeInteger(deadline) || deadline < 0) return null;
      return now() >= deadline ? ABANDONED_STATE : null;
    } catch { return null; }
  };
}
