// The session state the host reads when the operator supplies no `contextSessionState`. A purchase that settled its context step and has
// started no later operation is abandoned once an hour has passed since its admission: the seller reads its session as aborted by itself,
// which gives back the units the purchase still held. A purchase with a proposal, a commitment or a payment in the journal is never read
// as abandoned, so no payment a buyer could have sent is cut off.
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';

/** How long a settled purchase may go without starting a later operation before it reads as abandoned. */
export const ABANDONED_PURCHASE_MS = 3_600_000;

const ABANDONED_STATE = 'aborted-by-self';
const LATER_ROUTES = Object.freeze([DACS_SELLER_HTTP_PATHS.proposals, DACS_SELLER_HTTP_PATHS.commitments, DACS_SELLER_HTTP_PATHS.payments]);

/**
 * Builds the synchronous `({ jobId }) => state` reader. `admissionRecord(jobId)` is the job's admission row or null,
 * `operationState({ jobId, path })` the wire journal's state of that route's operation, and `now()` the host clock.
 * The reader answers `'aborted-by-self'` for a settled row admitted at least `ABANDONED_PURCHASE_MS` ago whose later routes all have no
 * operation, and `null` (unknown) for everything else, including a read that throws.
 */
export function createAbandonedPurchaseState({ admissionRecord, operationState, now }) {
  return ({ jobId }) => {
    try {
      const row = admissionRecord(jobId);
      if (row?.state !== 'settled' || !Number.isSafeInteger(row.admittedAt) || now() - row.admittedAt < ABANDONED_PURCHASE_MS) return null;
      return LATER_ROUTES.every((path) => operationState({ jobId, path }) === 'none') ? ABANDONED_STATE : null;
    } catch { return null; }
  };
}
