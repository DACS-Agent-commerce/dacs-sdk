// One bounded wait for the kit: the work starts once, and its caller stops
// waiting at a deadline without the work being abandoned.

class BoundedCallTimeout extends Error { name = 'TimeoutError'; }
// Node's timers hold at most this many milliseconds; a longer delay fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Starts `work()` once and waits at most `timeoutMs` for it.
 * Returns a promise for the work's own outcome that rejects with this helper's timeout error (see
 * isBoundedCallTimeout) at the deadline. An outcome that arrives later is consumed, so a late failure
 * is never an unhandled rejection. Only asynchronous waits are bounded: `work()` must return promptly.
 * Throws a TypeError, starting nothing, when `timeoutMs` is not an integer from 1 to 2^31 - 1.
 */
export function boundedCall(work, { timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) throw new TypeError('timeoutMs must be an integer from 1 to 2^31 - 1');
  const call = new Promise((resolve) => resolve(work()));
  call.catch(() => {});
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new BoundedCallTimeout(`the call did not finish within ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([call, deadline]).finally(() => clearTimeout(timer));
}

/** True only for the deadline error of a boundedCall; an error the work raised itself, a TimeoutError included, is false. */
export const isBoundedCallTimeout = (error) => error instanceof BoundedCallTimeout;
