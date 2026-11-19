// The session state the host reads when the operator supplies no `contextSessionState`. A settled purchase reads as aborted by the
// seller once no payment can still come for it, which gives back the units the purchase still held:
//   - one that started no proposal, an hour after its admission;
//   - one with a proposal, an hour after its admission and once its Agreement's deadline has passed, when an Agreement is
//     retained: a commitment made after that deadline cannot be paid, and nothing is paid without a commitment.
// A purchase that retains commitment work or holds a payment, or whose commitment or payment attempt is still running, is never read
// as abandoned: a payment included before the deadline is accepted however late its claim arrives. A commitment refused with no
// effect leaves no such work, so that purchase is read like one with no commitment.
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';

/** How long a settled purchase may go without starting a proposal before it reads as abandoned. */
export const ABANDONED_PURCHASE_MS = 3_600_000;

const ABANDONED_STATE = 'aborted-by-self';

/**
 * Builds the synchronous `({ jobId }) => state` reader. `admissionRecord(jobId)` is the job's admission row or null,
 * `operationState({ jobId, path })` the wire journal's state of that route's operation, `retainsCommitmentWork(jobId)` whether the
 * seller retains commitment work for the job, `holdsPayment(jobId)` whether it retains or recorded a payment for the job,
 * `agreementDeadline(jobId)` the job's retained Agreement's `terms.deadline` (anything but a safe integer reads as none), and `now()`
 * the host clock. The reader answers `'aborted-by-self'` for a settled row admitted at least `ABANDONED_PURCHASE_MS` ago that the
 * rules above name abandoned, and `null` (unknown) for everything else, including a read that throws.
 */
export function createAbandonedPurchaseState({ admissionRecord, operationState, retainsCommitmentWork, holdsPayment, agreementDeadline, now }) {
  return ({ jobId }) => {
    try {
      const row = admissionRecord(jobId), time = now();
      if (row?.state !== 'settled' || !Number.isSafeInteger(row.admittedAt) || time - row.admittedAt < ABANDONED_PURCHASE_MS) return null;
      const stateOf = (path) => operationState({ jobId, path });
      if (stateOf(DACS_SELLER_HTTP_PATHS.commitments) === 'pending' || stateOf(DACS_SELLER_HTTP_PATHS.payments) === 'pending') return null;
      if (retainsCommitmentWork(jobId) || holdsPayment(jobId)) return null;
      if (stateOf(DACS_SELLER_HTTP_PATHS.proposals) === 'none') return ABANDONED_STATE;
      const read = agreementDeadline(jobId);
      return !Number.isSafeInteger(read) || time >= read ? ABANDONED_STATE : null;
    } catch { return null; }
  };
}
