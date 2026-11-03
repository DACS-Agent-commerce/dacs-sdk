// One bounded wait for the kit (SA-19): the work starts once, and its caller
// stops waiting at a deadline without the work being abandoned.

/**
 * Starts `work()` once and lets its caller wait `timeoutMs` for it.
 * Returns `{ result, settled }`. `result` is the work's own outcome, or rejects
 * with a `TimeoutError` at the deadline. `settled` is the same call with its
 * outcome handled: it resolves with `{ status, value }` or `{ status, reason }`
 * whenever the work ends and never rejects, so a caller that must act on a late
 * result can, and a late failure is never an unhandled rejection.
 * Throws a TypeError, starting nothing, when `timeoutMs` is not a positive safe integer.
 */
export function boundedCall(work, { timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive safe integer');
  const call = new Promise((resolve) => resolve(work()));
  const settled = Promise.allSettled([call]).then(([outcome]) => outcome);
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new DOMException(`the call did not finish within ${timeoutMs} ms`, 'TimeoutError')), timeoutMs);
  });
  const result = Promise.race([call, deadline]).finally(() => clearTimeout(timer));
  return { result, settled };
}
