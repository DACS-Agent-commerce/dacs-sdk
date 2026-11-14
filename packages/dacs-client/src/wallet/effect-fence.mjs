// The client's actor-local fence over an injected `acquire` (the transport
// owner's connection fence). An operation holds the fence through an opaque
// capability: its nested steps reuse it, no other operation can present it, and
// the fence is released only when the operation that acquired it ends.
// Internal: not exported by the package.
import { AsyncLocalStorage } from 'node:async_hooks';
import { OperationError } from '../client-errors.mjs';

export const FENCE_ACQUIRE_TIMEOUT_MS = 10_000;

const refusal = (code, message, options) => new OperationError(code, message, undefined, options);
const notOwned = () => refusal('tp1_fence_not_owned', 'this operation does not own the actor fence capability');

// Releases an acquisition that grants nothing and retains any release failure.
const releaseUnused = (held, releaseFailed) => Promise.resolve().then(() => held?.release?.()).catch(releaseFailed);

// The acquisition, or `tp1_fence_timeout`. An acquisition that resolves after the
// timeout is released at once and grants nothing.
function acquireWithin(acquire, timeoutMs, setTimer, clearTimer, releaseFailed) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimer(() => { timedOut = true; reject(refusal('tp1_fence_timeout', `the actor fence was not acquired within ${timeoutMs} ms`)); }, timeoutMs);
    new Promise((settled) => settled(acquire())).then((held) => {
      if (timedOut) { releaseUnused(held, releaseFailed); return; }
      clearTimer(timer);
      resolve(held);
    }, (error) => {
      if (timedOut) return;
      clearTimer(timer);
      reject(error);
    });
  });
}

/**
 * The actor fence. `acquire()` resolves `{ release() }`; `currentLocal()` returns
 * the current local binding digest synchronously. Timers default to `setTimeout`
 * (monotonic) and are injectable for tests.
 *
 * `withFence(operationId, work, { capability })` runs `work(capability)` holding
 * the fence. Without a `capability` it acquires (rejecting `tp1_fence_timeout`
 * after 10,000 ms, or with the acquisition's own error), runs `work` and releases
 * on every path; a release failure rejects unless `work` already failed, whose
 * error wins. With a `capability` it reuses it and neither acquires nor
 * releases; a capability this operation did not acquire, or one already
 * released, rejects `tp1_fence_not_owned`. Reuse also requires the acquiring
 * async scope; an operation ID alone grants nothing. A failed unused-acquisition cleanup leaves
 * later acquisitions rejecting `tp1_fence_release_failed` with its cause.
 * `capability` is `{ connectionGeneration, localDigest }` as recorded at acquisition.
 *
 * `replaceConnection(replace)` acquires the fence like an effect, awaits
 * `replace()`, and increments `connectionGeneration` even if `replace` threw.
 */
export function createEffectFence({ acquire, currentLocal, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (typeof acquire !== 'function' || typeof currentLocal !== 'function') throw new TypeError('the actor fence needs acquire and currentLocal functions');
  const owners = new WeakMap();
  const scope = new AsyncLocalStorage();
  let failedRelease;
  const releaseFailed = (cause) => { failedRelease ??= refusal('tp1_fence_release_failed', 'the actor fence could not be released', { cause }); };
  let connectionGeneration = 0;

  async function acquireCapability(operationId) {
    if (failedRelease) throw failedRelease;
    const held = await acquireWithin(acquire, FENCE_ACQUIRE_TIMEOUT_MS, setTimer, clearTimer, releaseFailed);
    if (failedRelease) { await releaseUnused(held, releaseFailed); throw failedRelease; }
    let localDigest = null;
    try { if (typeof held?.release === 'function') localDigest = currentLocal(); } catch (error) {
      await releaseUnused(held, releaseFailed);
      throw error;
    }
    if (typeof localDigest !== 'string' || !localDigest) {
      await releaseUnused(held, releaseFailed);
      throw refusal('tp1_fence_invalid', 'the actor fence acquisition had no release or no local digest');
    }
    const capability = Object.freeze({ connectionGeneration, localDigest });
    owners.set(capability, { operationId, held, released: false });
    return capability;
  }

  // Marked released before the underlying release runs, so a failed release
  // leaves no capability that nested work could still reuse.
  async function releaseOwned(capability) {
    const owner = owners.get(capability);
    owner.released = true;
    await owner.held.release();
  }

  async function withFence(operationId, work, { capability } = {}) {
    if (capability !== undefined) {
      const owner = owners.get(capability);
      if (!owner || owner.operationId !== operationId || scope.getStore() !== capability || owner.released) throw notOwned();
      return work(capability);
    }
    const acquired = await acquireCapability(operationId);
    let outcome;
    try { outcome = { value: await scope.run(acquired, () => work(acquired)) }; } catch (error) { outcome = { failed: true, error }; }
    try { await releaseOwned(acquired); } catch (error) { if (!outcome.failed) throw error; }
    if (outcome.failed) throw outcome.error;
    return outcome.value;
  }

  const replacementOperation = Symbol('connection replacement');
  return {
    withFence,
    get connectionGeneration() { return connectionGeneration; },
    replaceConnection: (replace) => withFence(replacementOperation, async () => {
      try { return await replace(); } finally { connectionGeneration += 1; }
    }),
  };
}
