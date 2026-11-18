// The session state the host reads when the operator supplies no `contextSessionState`. A purchase that has paid nothing and made no
// commitment is abandoned once an hour has passed since the later of its admission and its Agreement's deadline: the seller reads its
// session as aborted by itself, which gives back the units the purchase still held. Until the deadline a buyer can still propose and
// commit. A purchase with a commitment or a payment in the journal is never read as abandoned: a payment included before the deadline is
// accepted however late its claim arrives.
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';

/** How long a purchase that has made no commitment may go past its admission and its Agreement's deadline before it reads as abandoned. */
export const ABANDONED_PURCHASE_MS = 3_600_000;

const ABANDONED_STATE = 'aborted-by-self';
const { proposals, commitments, payments } = DACS_SELLER_HTTP_PATHS;

/** Whether the proposal and commitment routes have started nothing, so the purchase has no Agreement to wait for. */
const hasNoAgreementWork = (operationState, jobId) => [proposals, commitments].every((path) => operationState({ jobId, path }) === 'none');

/** Whether a proposal or commitment attempt is open, which a later retry could still finish. */
const hasOpenAgreementWork = (operationState, jobId) => [proposals, commitments].some((path) => operationState({ jobId, path }) === 'pending');

/**
 * Builds the synchronous `({ jobId }) => state` reader. `admissionRecord(jobId)` is the job's admission row or null,
 * `operationState({ jobId, path })` the wire journal's state of that route's operation, `agreementDeadline(jobId)` the deadline in
 * milliseconds of the Agreement the seller retains for the job (or null), and `now()` the host clock.
 * The reader answers `'aborted-by-self'` for a settled row whose payments and commitments routes have no operation, once
 * `ABANDONED_PURCHASE_MS` has passed since the later of its admission and its Agreement's deadline (a purchase with no proposal has no
 * deadline to wait for). It answers `null` (unknown) for everything else: a commitment, an open attempt, an Agreement with no readable
 * deadline, and a read that throws.
 */
export function createAbandonedPurchaseState({ admissionRecord, operationState, agreementDeadline, now }) {
  return ({ jobId }) => {
    try {
      const row = admissionRecord(jobId);
      if (row?.state !== 'settled' || !Number.isSafeInteger(row.admittedAt) || now() - row.admittedAt < ABANDONED_PURCHASE_MS) return null;
      if (operationState({ jobId, path: payments }) !== 'none' || operationState({ jobId, path: commitments }) !== 'none' || hasOpenAgreementWork(operationState, jobId)) return null;
      if (hasNoAgreementWork(operationState, jobId)) return ABANDONED_STATE;
      const deadline = agreementDeadline(jobId);
      if (!Number.isSafeInteger(deadline) || deadline < 0) return null;
      return now() - Math.max(row.admittedAt, deadline) >= ABANDONED_PURCHASE_MS ? ABANDONED_STATE : null;
    } catch { return null; }
  };
}
