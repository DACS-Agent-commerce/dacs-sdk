import { finalityCommitmentAddress } from '@kynesyslabs/dacs';
import { deliverableAddress, deliveryEvidenceAddress } from '../dacs/purchase-protocol.mjs';
import { PUBLIC_SIGNED_CREATES } from '../dacs/buyer-chain-readback.mjs';

// Seller side of DACS_BUYER_CHAIN_READBACK=on. A buyer that reads only the
// chain still needs the original signed CREATE bytes, because Node2 returns
// executed transactions normalized. Each successful seller answer for a job
// therefore names, for its commitment, Deliverable and delivery evidence, the
// bytes of every write the seller has verified itself. The seller HTTP handler
// adds them when it sends an answer, including one replayed from its effect
// cache, so a write made after the answer was first produced (delayed delivery
// evidence) is still pointed to. They are a pointer: the buyer authenticates
// them on chain and never takes them as a verdict. Bytes the seller has not
// seen included are never offered. Off (the default) this is not installed
// and answers are unchanged.
//
// A retained write the seller has not verified yet (its answer was lost) is
// first read back by the seller itself, through its ordinary authenticated
// readback (readRetained). That readback may record the verified result in the
// seller's journal and, for a write still pending at the node, make the
// existing one-time unchanged resend (recoverStorageWrite); it never signs
// anything. It runs inside the answer, so it is bounded: all such readbacks
// for one answer share READBACK_BUDGET_MS. After that the answer is sent
// without the pointer (the readback may still finish and record its result),
// and a later answer names it.
const WRITES = [[finalityCommitmentAddress, 'FinalityCommitmentRecord'], [deliverableAddress, 'Deliverable'], [deliveryEvidenceAddress, 'SettlementEvidence']];
export const READBACK_BUDGET_MS = 5000;

// The readback's result (null if it failed), or TIMED_OUT once the time left
// has passed.
const TIMED_OUT = Symbol('timed out');
function within(promise, ms) {
  let timer;
  return Promise.race([promise.catch(() => null), new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); timer.unref?.(); })]).finally(() => clearTimeout(timer));
}

export function createPublicSignedCreates(anchor, { readbackBudgetMs = READBACK_BUDGET_MS } = {}) {
  if (typeof anchor?.retainedSignedCreate !== 'function' || typeof anchor.readRetained !== 'function') throw new TypeError('public signed CREATEs need the seller artifact anchor');
  if (!Number.isSafeInteger(readbackBudgetMs) || readbackBudgetMs < 0) throw new TypeError('the seller readback budget must be a nonnegative integer');
  // The answer, with the pointer field added when there is anything to name.
  return async (jobId, answer) => {
    if (typeof jobId !== 'string' || answer === null || typeof answer !== 'object' || Array.isArray(answer) || Object.hasOwn(answer, 'error')) return answer;
    const creates = {}, deadline = Date.now() + readbackBudgetMs;
    // A timer can fire a millisecond before Date.now() reaches the deadline:
    // a readback that timed out spends the budget whatever the clock says.
    let spent = false;
    for (const [address, artifactKind] of WRITES) {
      const logicalAddress = address(jobId);
      let signed = await anchor.retainedSignedCreate({ logicalAddress, artifactKind });
      const left = deadline - Date.now();
      if (!signed && !spent && left > 0) {
        const read = await within(anchor.readRetained({ logicalAddress, artifactKind }), left);
        if (read === TIMED_OUT) spent = true;
        else if (read?.status === 'present') signed = await anchor.retainedSignedCreate({ logicalAddress, artifactKind });
      }
      if (signed) creates[logicalAddress] = signed;
    }
    return Object.keys(creates).length ? { ...answer, [PUBLIC_SIGNED_CREATES]: creates } : answer;
  };
}
