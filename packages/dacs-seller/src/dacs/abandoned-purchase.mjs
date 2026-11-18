// The session state the host reads when the operator supplies no `contextSessionState`. A settled purchase reads as aborted by the
// seller once no payment can still come for it, which gives back the units the purchase still held:
//   - one that started no proposal or commitment, an hour after its admission;
//   - one with a proposal and no commitment, an hour after its admission and once its Agreement's deadline has passed, when an
//     Agreement is retained: a commitment made after that deadline cannot be paid, and nothing is paid without a commitment;
//   - one with a commitment, an hour after its Agreement's deadline: a payment included after the deadline is refused, and the hour
//     lets the claim of a payment included just before it arrive.
// A purchase with a payment operation, or with a commitment and no readable deadline, is never read as abandoned.
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';

/** How long a settled purchase may go without starting a later operation before it reads as abandoned, and how long past its deadline. */
export const ABANDONED_PURCHASE_MS = 3_600_000;

const ABANDONED_STATE = 'aborted-by-self';

/**
 * Builds the synchronous `({ jobId }) => state` reader. `admissionRecord(jobId)` is the job's admission row or null,
 * `operationState({ jobId, path })` the wire journal's state of that route's operation, `agreementDeadline(jobId)` the job's retained
 * Agreement's `terms.deadline` (anything but a safe integer reads as none), and `now()` the host clock.
 * The reader answers `'aborted-by-self'` for a settled row admitted at least `ABANDONED_PURCHASE_MS` ago that the rules above name
 * abandoned, and `null` (unknown) for everything else, including a read that throws.
 */
export function createAbandonedPurchaseState({ admissionRecord, operationState, agreementDeadline, now }) {
  return ({ jobId }) => {
    try {
      const row = admissionRecord(jobId), time = now();
      if (row?.state !== 'settled' || !Number.isSafeInteger(row.admittedAt) || time - row.admittedAt < ABANDONED_PURCHASE_MS) return null;
      const started = (path) => operationState({ jobId, path }) !== 'none';
      if (started(DACS_SELLER_HTTP_PATHS.payments)) return null;
      const committed = started(DACS_SELLER_HTTP_PATHS.commitments);
      if (!committed && !started(DACS_SELLER_HTTP_PATHS.proposals)) return ABANDONED_STATE;
      const read = agreementDeadline(jobId), deadline = Number.isSafeInteger(read) ? read : null;
      if (!committed) return deadline === null || time >= deadline ? ABANDONED_STATE : null;
      return deadline !== null && time - deadline >= ABANDONED_PURCHASE_MS ? ABANDONED_STATE : null;
    } catch { return null; }
  };
}
