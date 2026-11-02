// Seller records: one process owns a seller state directory (its approval
// ledger, journal binding and issuance journals) for its whole lifetime.
// The lock file is published whole (a synced temporary file linked into
// place, so it is never seen partly written) and names its holder's host,
// process lease, pid and namespace. The holder's exit is proven only by its
// kernel lease on this directory (process-lease.mjs) being free on this boot;
// then the lock is taken over. Anything else refuses.
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { leaseFile, leaseHolderState, PROCESS_LEASE_ID, PROCESS_NAMESPACE, takeLease } from '../dacs/process-lease.mjs';

export const SELLER_STATE_LOCK_FILE = 'seller-state.lock';
const FORMAT = 'dacs-seller-state-lock/v2';
const FIELDS = ['format', 'host', 'process', 'pid', 'namespace', 'acquiredAt'];
const NAMESPACE_FIELDS = { ns: /^\d{1,20}$/, boot: /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|bt\d{1,20})$/, start: /^\d{1,20}$/ };
const TAKEOVER = 'takeover';
export const SELLER_STATE_LOCK_REFUSALS = Object.freeze({
  held: 'seller state directory is in use by another live operator process (seller-state.lock); nothing was read or written: stop that operator first, one operator per state directory',
  doubt: 'seller state directory is locked by an operator process that cannot be proven gone (seller-state.lock names another host or boot, is unreadable, or its holder lease cannot be checked); nothing was read or written: confirm that no operator uses this state directory on any host, then remove seller-state.lock by hand',
});

const refuse = (reason, cause) => Object.assign(new Error(SELLER_STATE_LOCK_REFUSALS[reason], cause ? { cause } : undefined), { code: 'seller_state_locked', reason });
const plainObject = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const exactNamespace = (value) => value === null || (plainObject(value, Object.keys(NAMESPACE_FIELDS))
  && Object.entries(NAMESPACE_FIELDS).every(([key, pattern]) => typeof value[key] === 'string' && pattern.test(value[key])));
const exactRecord = (value) => plainObject(value, FIELDS) && value.format === FORMAT && typeof value.host === 'string'
  && typeof value.process === 'string' && Number.isSafeInteger(value.pid) && value.pid > 0
  && Number.isSafeInteger(value.acquiredAt) && value.acquiredAt >= 0 && exactNamespace(value.namespace);
const lockRecord = (at) => ({ format: FORMAT, host: hostname(), process: PROCESS_LEASE_ID, pid: process.pid,
  namespace: PROCESS_NAMESPACE && { ns: PROCESS_NAMESPACE.ns, boot: PROCESS_NAMESPACE.boot, start: PROCESS_NAMESPACE.start }, acquiredAt: at });

// 'held' while the lock's holder runs (this process included), 'exited' when
// its lease on this directory proves it gone on this host and boot, and
// 'doubt' for anything else: another host, no identity, an unreadable or
// malformed record, an unprovable lease.
function lockState(directory, text) {
  let record = null;
  try { record = JSON.parse(text); } catch { return 'doubt'; }
  if (!exactRecord(record) || record.host !== hostname() || !record.namespace || !PROCESS_NAMESPACE) return 'doubt';
  const state = leaseHolderState(directory, record);
  if (state === 'this-process' || state === 'live') return 'held';
  return state === 'exited' ? 'exited' : 'doubt';
}

// The lock's text, or null when there is none.
const readLock = (path) => { try { return readFileSync(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const readLockOrRefuse = (path) => { try { return readLock(path); } catch (error) { throw refuse('doubt', error); } };
const removeQuietly = (path) => { try { unlinkSync(path); } catch { /* already gone */ } };
function syncDirectory(directory) {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
// Writes text to a new private temporary file beside path, synced to disk.
function writeTemporary(path, text) {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  let written = false;
  try { writeFileSync(fd, text); fsyncSync(fd); written = true; } finally { closeSync(fd); if (!written) removeQuietly(temporary); }
  return temporary;
}
// Removes the lock at path only while it still holds text, then syncs.
function removeOwnLock(directory, path, text) {
  if (readLock(path) !== text) return;
  unlinkSync(path);
  syncDirectory(directory);
}
// Publishes text at path, linked (never replacing) or renamed over the lock
// judged exited. Returns false when a lock was already there to link over. If
// any step after publication fails, the lock is removed while it is still this
// one before the error is rethrown: no published lock is left without a handle.
function publish(directory, path, text, replace) {
  const temporary = writeTemporary(path, text);
  try {
    if (replace) renameSync(temporary, path); else linkSync(temporary, path);
  } catch (error) {
    removeQuietly(temporary);
    if (error.code === 'EEXIST' && !replace) return false;
    throw error;
  }
  try {
    if (!replace) unlinkSync(temporary);
    syncDirectory(directory);
  } catch (error) {
    removeQuietly(temporary);
    try { removeOwnLock(directory, path, text); } catch { /* the first error explains the failure */ }
    throw error;
  }
  return true;
}
// Replaces the lock judged exited, inside a takeover section that one process
// at a time holds (an exclusive SQLite lock the kernel frees if it crashes).
// Inside it the lock is read again: a lock changed meanwhile is judged afresh.
// Returns false when the lock disappeared meanwhile.
function takeOver(directory, path, text) {
  const section = new Database(leaseFile(directory, TAKEOVER));
  try {
    try { section.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE'); } catch (error) { throw refuse('held', error); }
    const found = readLockOrRefuse(path);
    if (found === null) return false;
    const state = lockState(directory, found);
    if (state !== 'exited') throw refuse(state);
    return publish(directory, path, text, true);
  } finally {
    try { if (section.inTransaction) section.exec('ROLLBACK'); } finally { section.close(); }
  }
}

/**
 * Takes the lock on `directory`, or throws before anything else in it is read.
 * Rejects with code seller_state_locked and `reason` 'held' while another live
 * process (or this one) holds it, or 'doubt' when its holder can't be proven
 * gone. Returns `{ path, release() }`; release() is synchronous and idempotent,
 * removes the lock only while it is still this one, and throws if the
 * directory can't be synced. This process's lease is kept until it exits.
 */
export async function acquireSellerStateLock(directory, { now = Date.now } = {}) {
  takeLease(directory);
  const canonical = realpathSync(directory), path = join(canonical, SELLER_STATE_LOCK_FILE);
  const text = `${JSON.stringify(lockRecord(now()))}\n`;
  // A lock that vanishes between the failed link and its read was just
  // released: one fresh attempt follows.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (publish(canonical, path, text, false)) return lockHandle(canonical, path, text);
    const found = readLockOrRefuse(path);
    if (found === null) continue;
    const state = lockState(canonical, found);
    if (state !== 'exited') throw refuse(state);
    if (takeOver(canonical, path, text)) return lockHandle(canonical, path, text);
  }
  throw refuse('doubt');
}
function lockHandle(directory, path, text) {
  let released = false;
  return Object.freeze({ path, release: () => {
    if (released) return;
    released = true;
    removeOwnLock(directory, path, text);
  } });
}
