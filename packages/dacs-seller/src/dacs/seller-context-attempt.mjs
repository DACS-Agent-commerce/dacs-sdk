// The write authority and deadline of one attempt of the wire context route.
import { SellerTransportError } from './seller-transport-auth.mjs';

// How long one context attempt may run, measured on a monotonic clock from the start of its work.
const SELLER_CONTEXT_TIMEOUT_MS = 240_000;

// Reads a clock that must answer a non-negative number (a safe integer for the wall clock); anything else throws peer_clock_invalid (503).
function readClock(clock, integer) {
  let at;
  try { at = clock(); } catch (cause) { throw new SellerTransportError('peer_clock_invalid', 503, { cause }); }
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || (integer && !Number.isSafeInteger(at))) throw new SellerTransportError('peer_clock_invalid', 503);
  return at;
}
const contextDeadline = () => Object.assign(new Error('the context attempt passed its deadline'), { code: 'context_deadline' });

/**
 * The write authority and deadline of one context attempt (the capability `reserveContext` issued for `jobId`).
 * `run(work)` starts `work({ writable, signal })` once and returns `result`, which follows the work until the attempt closes and then
 * rejects, and `settled`, which resolves `{ status, value | reason }` only when the work itself has ended. The attempt closes at 240,000 ms
 * on the monotonic clock, or when the wire lease (`effect.leaseUntil`) has passed on the wall clock, or on `close(cause)`; the first cause
 * is kept, the signal aborts and `result` rejects: with a `cause` that is itself a SellerTransportError as is, otherwise with
 * `operation_uncertain` (503) carrying it, which for the deadline is an error coded `context_deadline`. A malformed clock closes it with
 * `peer_clock_invalid`. Closing is never evidence that nothing was dispatched.
 * `writable()` is false until the work has started and after the attempt closed or its deadline or lease has passed, even before the
 * timer has run; otherwise it is the admission transaction's `runningCheck`, which the caller asks while holding the job lease and
 * outside any store transaction. Do not call it to test liveness: its first true answer latches the attempt as effect-authorized.
 * `isClosed()` tells whether the attempt has closed, which separates a provider that failed on its own from one that was stopped.
 * Throws a TypeError when the job id, the effect's lease, the capability's attempt and revision, the admission check or a clock is unusable.
 */
export function createContextAttempt({ jobId, effect, capability, admissionTransaction, now, monotonicNow }) {
  if (typeof jobId !== 'string' || !Number.isSafeInteger(effect?.leaseUntil) || !Number.isSafeInteger(capability?.attempt) || !Number.isSafeInteger(capability?.rev)
      || typeof admissionTransaction?.runningCheck !== 'function' || typeof now !== 'function' || typeof monotonicNow !== 'function') {
    throw new TypeError('a context attempt needs its job id, effect, capability, admission transaction and clocks');
  }
  const controller = new AbortController();
  let started = false, startedAt = 0, timer = null, closed = false, rejectResult = null;
  const refusalFor = (cause) => (cause instanceof SellerTransportError ? cause : new SellerTransportError('operation_uncertain', 503, { cause }));
  function close(cause) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    controller.abort(cause);
    rejectResult?.(refusalFor(cause));
  }
  function passedDeadline() {
    return readClock(monotonicNow, false) - startedAt >= SELLER_CONTEXT_TIMEOUT_MS || readClock(now, true) >= effect.leaseUntil;
  }
  function writable() {
    if (!started || closed) return false;
    try {
      if (passedDeadline()) close(contextDeadline());
    } catch (error) { close(error); }
    return closed ? false : admissionTransaction.runningCheck(jobId, capability.attempt, capability.rev);
  }
  function run(work) {
    if (started) throw new TypeError('a context attempt runs once');
    started = true;
    try {
      startedAt = readClock(monotonicNow, false);
      timer = setTimeout(() => close(contextDeadline()), Math.max(1, Math.min(SELLER_CONTEXT_TIMEOUT_MS, effect.leaseUntil - readClock(now, true))));
    } catch (error) { close(error); }
    const call = closed ? Promise.reject(refusalFor(controller.signal.reason)) : new Promise((resolve) => resolve(work({ writable, signal: controller.signal })));
    const result = new Promise((resolve, reject) => { rejectResult = reject; call.then(resolve, reject); });
    result.catch(() => {});
    const settled = call.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
    settled.then(() => clearTimeout(timer));
    return Object.freeze({ result, settled });
  }
  return Object.freeze({ writable, close, run, isClosed: () => closed });
}
