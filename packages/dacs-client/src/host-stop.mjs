import { OperationError } from './client-errors.mjs';
import { nonSynchronous } from './util/sqlite-purchase-admission.mjs';

/** The refusal codes a host stop raises; the wallet's effect boundary raises the same four. */
export const HOST_STOP_CODES = Object.freeze(['writes_stopped', 'stop_check_failed', 'stop_check_invalid', 'stop_check_timeout']);

/** Returns whether `error` is an OperationError carrying one of the host stop codes. */
export const isHostStopRefusal = (error) => error instanceof OperationError && HOST_STOP_CODES.includes(error.code);

const refusal = (code, cause) => new OperationError(code, `host stop refused: ${code}`, undefined, cause === undefined ? undefined : { cause });

const NO_HOST_STOP = Object.freeze({ source: undefined, assert() {} });
const sourcesByObject = new WeakMap();

/**
 * Wraps the host's synchronous stop check. Returns a frozen `{source, assert()}`; with no check, a shared gate whose `assert` does nothing.
 * `assert()` calls the check on every use and never caches it. It throws OperationError `writes_stopped` when the check answers true,
 * `stop_check_failed` (keeping the thrown error as `cause`) when it throws, and `stop_check_invalid` for any answer but a boolean.
 * A returned promise counts as invalid: its outcome is never read, and a rejection raises no unhandled rejection.
 * Throws TypeError(stop_seam_invalid) when `stopped` is neither undefined nor a synchronous function.
 */
export function createHostStop(stopped) {
  if (stopped === undefined) return NO_HOST_STOP;
  if (typeof stopped !== 'function' || nonSynchronous(stopped)) throw new TypeError('stop_seam_invalid');
  return Object.freeze({ source: stopped, assert() {
    let answer;
    try { answer = stopped(); } catch (cause) { throw refusal('stop_check_failed', cause); }
    if (typeof answer?.then === 'function') { Promise.resolve(answer).catch(() => {}); throw refusal('stop_check_invalid'); }
    if (typeof answer !== 'boolean') throw refusal('stop_check_invalid');
    if (answer) throw refusal('writes_stopped');
  } });
}

/** Records the stop check a factory built `object` with, so a service can compare it with its protocol's. Returns `object`. */
export function bindHostStop(object, stopped) {
  sourcesByObject.set(object, stopped);
  return object;
}

/** Returns the stop check `object` was built with, or undefined when it was built with none. */
export const hostStopSourceOf = (object) => sourcesByObject.get(object);
