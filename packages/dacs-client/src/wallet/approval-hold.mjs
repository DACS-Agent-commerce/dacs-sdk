// An approval held from before the caller's effect pass until that pass's one call uses it. A hold lives in memory only and
// writes nothing: the signer reservation keeps the durable approval request and id. Its states are `held` -> `taken` -> `ended`,
// or `held` -> `ended`, kept in a module WeakMap, so a copied object is not a hold.
import { sha256Hex } from '@kynesyslabs/dacs';
import { createHostStop } from '../host-stop.mjs';

const holds = new WeakMap();
const isGeneration = value => Number.isSafeInteger(value) && value >= 0;

/**
 * Reads `stopped()` once, synchronously. Returns when it answers false. Throws OperationError `writes_stopped` when it answers
 * true, `stop_check_invalid` for a promise (never awaited; its rejection is handled) or any other non-boolean, and
 * `stop_check_failed` with the thrown error as `cause` when it throws.
 */
export function assertNotStoppedNow(stopped) {
  createHostStop(() => stopped()).assert();
}

// The ledger's revocation count, or null when it throws or answers anything but a non-negative safe integer.
function readGeneration(revocationGeneration) {
  try { const generation = revocationGeneration(); return isGeneration(generation) ? generation : null; } catch { return null; }
}

/**
 * Returns a frozen hold `{approvalHash, requestText, revision(), release()}` for the exact approved `requestText`, carrying the
 * private `attempt`. It records `revocationGeneration()` once. `revision()` answers `approvalHash` while the hold is `held` or
 * `taken`, `stopped()` answers exactly false, and `revocationGeneration()` still answers the recorded count; otherwise null. It
 * never throws. `release()` ends a hold still `held` and returns `settle(attempt)`'s promise; a repeat returns that same promise,
 * and a hold already `taken` or `ended` without a release resolves undefined. `settle` must never reject, so neither does `release()`.
 */
export function createApprovalHold({ requestText, attempt, stopped, revocationGeneration, settle }) {
  const recorded = readGeneration(revocationGeneration), approvalHash = sha256Hex(requestText);
  const entry = { state: 'held', attempt, released: undefined };
  entry.current = () => {
    if (entry.state === 'ended' || recorded === null || readGeneration(revocationGeneration) !== recorded) return false;
    try { assertNotStoppedNow(stopped); return true; } catch { return false; }
  };
  const hold = Object.freeze({ approvalHash, requestText, revision: () => (entry.current() ? approvalHash : null),
    release() {
      if (entry.state === 'held') { entry.state = 'ended'; entry.released = settle(attempt); }
      return entry.released ?? Promise.resolve(undefined);
    },
  });
  holds.set(hold, entry);
  return hold;
}

/**
 * Takes a hold for its one use. Returns its attempt and moves it to `taken` when it is `held`, current (`revision()` not null)
 * and `owns(attempt)` answers exactly true; a throw counts as false. Otherwise returns null and leaves the hold as it was, so
 * another composition's hold stays usable by its own adapter.
 */
export function takeApprovalHold(hold, owns) {
  const entry = holds.get(hold);
  if (entry?.state !== 'held' || !entry.current()) return null;
  let owned;
  try { owned = owns(entry.attempt) === true; } catch { return null; }
  if (!owned) return null;
  entry.state = 'taken';
  return entry.attempt;
}

/** Ends a hold whose call has settled: `revision()` answers null from now on and `release()` resolves undefined. */
export function endApprovalHold(hold) {
  const entry = holds.get(hold);
  if (entry) entry.state = 'ended';
}
