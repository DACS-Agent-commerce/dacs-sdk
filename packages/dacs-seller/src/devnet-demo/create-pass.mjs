// The one way the seller's artifact anchor runs a wallet CREATE or its resend: the kit effect boundary's checks and fence
// first, then one effect pass of the wallet session whose steps are the boundary's own refresh, the host's stop check and
// the boundary's synchronous tail, with the job's current-authorization check last.
import { passContext } from '@kynesyslabs/dacs-client/node-wallet';
import { effectBoundaryBinding, effectPassRemainingMs, jobPassContext } from '../dacs/effect-boundary.mjs';
import { OperationError } from '../operations.mjs';

// The longest session pass the client accepts, in milliseconds.
const SESSION_PASS_MAX_MS = 10000;
const SELLER_CREATE_KIND = 'seller-create';

/**
 * Builds a job pass's current-authorization check from `held` (a job hold's check, such as the seller agent's
 * `heldFor(jobId)`, which returns true or throws its cause) and `revision` (`{ expected, current() }` for the lane's
 * retained revision, or null when the lane binds none). Returns a synchronous function that returns true, or throws:
 * the hold's own error, `job_not_held` for any other answer, `job_revision_expired` when `current()` answers null or
 * undefined, `job_revision_changed` when it answers anything but `expected`. Throws TypeError for a malformed input.
 */
export function currentAuthorizationFor({ held, revision }) {
  if (typeof held !== 'function') throw new TypeError('held must be a function');
  if (revision !== null && typeof revision?.current !== 'function') throw new TypeError('revision must be { expected, current() } or null');
  return () => {
    if (held() !== true) throw new OperationError('job_not_held', 'the job hold did not answer true');
    if (revision === null) return true;
    const current = revision.current();
    if (current === null || current === undefined) throw new OperationError('job_revision_expired', 'the job revision this write was bound to is gone');
    if (current !== revision.expected) throw new OperationError('job_revision_changed', 'the job revision changed after this write was bound to it');
    return true;
  };
}

/**
 * Builds `{ runCreate }` over the host's kit boundary (`effectBoundary`, from createEffectBoundary), the finalized wallet
 * `session`, the host's `stopped()` check, the session pass's `feeCeilingOs` and the port's wall `clock`.
 * `runCreate({ operationId, lane, operationClass, currentAuthorization, approvalRef, k1Rev, debitOs }, work)`:
 * 1. runs the boundary's `withFence` for a 'seller-create' operation stamped with the binding's pin version (a paid write
 *    when `debitOs` is given), under the job context of `operationClass` and `currentAuthorization`;
 * 2. inside it takes the session's connection fence and, with nothing awaited in between, reads the kit pass's remaining
 *    window: none left refuses `effect_pass_invalid` and `work` is never called; otherwise it opens a session pass whose
 *    deadline is that window (at most 10,000 ms) on `clock`;
 * 3. calls `work({ guardedSigner })` in the pass, where `guardedSigner(sign)` wraps an RPC-authentication signer so that
 *    the boundary's stop check and synchronous tail run right before each signature;
 * 4. releases the session fence, then the kit fence, on every outcome.
 * Resolves `work`'s answer. Rejects with the boundary's refusal, `effect_pass_invalid`, the session's own refusal or
 * `work`'s error. Throws TypeError for a boundary createEffectBoundary did not make.
 */
export function createSellerCreatePass({ effectBoundary, session, stopped, feeCeilingOs, clock }) {
  const binding = effectBoundaryBinding(effectBoundary);
  if (binding === undefined) throw new TypeError('effectBoundary must come from createEffectBoundary');
  // The client's gate ignores what finalStop answers, so a stop must throw.
  const finalStop = async () => {
    const answer = await stopped();
    if (answer !== false) throw new OperationError(answer === true ? 'seller_stopped' : 'stop_check_invalid', 'the seller is stopping or its stop check did not answer false');
  };

  async function inSessionPass(held, { operationId, operationClass, currentAuthorization }, work) {
    const lease = await session.acquireConnectionFence();
    try {
      const remaining = effectPassRemainingMs(held);
      if (!(remaining > 0)) throw new OperationError('effect_pass_invalid', 'the kit pass window ended before the session fence was granted; nothing was signed or sent');
      const handle = session.effectPass({ fence: lease, deadline: clock.now() + Math.min(remaining, SESSION_PASS_MAX_MS), refreshAuthority: () => effectBoundary.refresh(held),
        finalStop, synchronousChecks: [() => effectBoundary.checkNow(held)], feeCeilingOs, context: passContext({ operationClass, operationId, currentAuthorization }) });
      const guardedSigner = (sign) => {
        const signer = effectBoundary.signerFor(held, { sign });
        return (message) => signer.sign(message);
      };
      return await session.runInEffectPass(handle, () => work({ guardedSigner }));
    } finally { lease.release(); }
  }

  async function runCreate(input, work) {
    const { operationId, lane, operationClass, currentAuthorization, approvalRef = null, k1Rev = null, debitOs = null } = input;
    const op = { operationId, lane, kind: SELLER_CREATE_KIND, paidWrite: debitOs !== null, debitOs, approvalRef, k1Rev, pinVersion: binding.profile.pinVersion };
    return effectBoundary.withFence(op, (held) => inSessionPass(held, input, work), { context: jobPassContext(operationClass, currentAuthorization) });
  }
  return Object.freeze({ runCreate });
}
