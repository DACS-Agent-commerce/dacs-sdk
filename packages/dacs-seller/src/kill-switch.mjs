// The operator's stop file: while an entry named KILL exists in the data directory, the seller makes no effect.
// It imports only node:fs, node:path, the shutdown flag and the diagnostic projection.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { stopRequested } from './devnet-demo/stop-request.mjs';
import { sellerDiagnostic } from './seller-diagnostics.mjs';

const KILL_ENTRY = 'KILL';
// The filesystem codes a failed check reports by name; any other code is reported as `other`.
const NAMED_FS_CODES = new Set(['EACCES', 'EPERM', 'EIO', 'ELOOP', 'ENAMETOOLONG', 'ENOTDIR', 'ENOENT']);

const fsCodeOf = (error) => (NAMED_FS_CODES.has(error?.code) ? error.code : 'other');
const answer = (present, cause, fsCode) => Object.freeze({ present, cause, fsCode });
const ABSENT = answer(false, null, null);

/**
 * Reads whether `<dataDirectory>/KILL` is present, synchronously, so it can run inside a database transaction.
 * The data directory must be a real directory (lstat, never a symlink). Only `ENOENT` on KILL means absent; any entry type
 * (file, directory, symlink, broken symlink, FIFO) is present, and its contents are never read. Any failure counts as present.
 * Returns a frozen `{ present, cause, fsCode }`: `cause` is `null`, `kill-present`, `kill-unreadable`,
 * `data-directory-not-directory` or `data-directory-unreadable`; `fsCode` names the failed call's code, else `null`.
 * Never throws, never caches and writes nothing.
 */
export function killState(dataDirectory) {
  try {
    if (!lstatSync(dataDirectory).isDirectory()) return answer(true, 'data-directory-not-directory', null);
  } catch (error) {
    return answer(true, 'data-directory-unreadable', fsCodeOf(error));
  }
  try {
    lstatSync(join(dataDirectory, KILL_ENTRY));
    return answer(true, 'kill-present', null);
  } catch (error) {
    return error?.code === 'ENOENT' ? ABSENT : answer(true, 'kill-unreadable', fsCodeOf(error));
  }
}

/**
 * Returns `isStopped()`, a synchronous boolean: the process shutdown flag, or KILL present in `dataDirectory` (read again on
 * every call). Each change of the observed cause writes one `seller_stop_observed` line to stderr through the closed diagnostic
 * projection; the first absent state writes nothing. Never throws.
 */
export function createStopCheck(dataDirectory) {
  let seen = ABSENT;
  return function isStopped() {
    const state = killState(dataDirectory);
    if (state.cause !== seen.cause || state.fsCode !== seen.fsCode) {
      seen = state;
      try {
        process.stderr.write(`seller-stop: ${JSON.stringify(sellerDiagnostic('seller_stop_observed', { stopCause: state.cause, fsCode: state.fsCode }))}\n`);
      } catch { /* a closed stderr does not change the answer */ }
    }
    return stopRequested() || state.present;
  };
}

/**
 * Reads a host stop predicate once. Returns `{ stopped, cause }`: `true` is stopped with cause `null`; a predicate that throws is
 * stopped with `stop_check_failed`; one that answers a non-boolean (a promise included, whose rejection is then handled) is
 * stopped with `stop_check_invalid`. Never throws.
 */
export function readStopPredicate(stopped) {
  let value;
  try { value = stopped(); } catch { return { stopped: true, cause: 'stop_check_failed' }; }
  if (typeof value?.then === 'function') Promise.resolve(value).then(undefined, () => {});
  if (typeof value !== 'boolean') return { stopped: true, cause: 'stop_check_invalid' };
  return { stopped: value, cause: null };
}
