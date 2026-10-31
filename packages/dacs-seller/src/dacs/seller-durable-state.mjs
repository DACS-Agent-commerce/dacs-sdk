// Opt-in host-local recovery for the SIMULATED seller adapter. This retains
// seller-authenticated application context beside the pinned SDK stores. It
// never obtains a buyer key or reconstructs facts from a cached HTTP answer.
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import { isMainThread } from 'node:worker_threads';
import { canonicalize, contentHash, createFsFencedSessionStore, createFsSellerReceiptStore, isCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { verifyFixtureRecord } from './fixture-anchors.mjs';

const DOMAIN = 'dacs-chatgpt-plugin:offline-seller-state:v1:';
const clone = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b) => canonicalize(a) === canonicalize(b);
const fail = (code) => { throw new SellerRecoveryError(code); };
// A job lock row's owner is `<pid>:<process>:<acquired ms>:<acquisition>`,
// then `:<namespace>` where this host names this process's boot and start.
// `<process>` is made once per realm and shared by every copy of this module
// and every store in it. Liveness comes from a lease the kernel releases when
// the process ends, never from the PID alone: on first opening a state
// directory the process takes an exclusive SQLite (POSIX) lock on
// `holders/<process>.sqlite` and holds it until exit. A row is live while its
// holder's lease is held; if the lease cannot be checked at all, the row is
// busy. `<namespace>` is `<PID namespace>.<boot>.<start>`: on Linux the inode
// of /proc/self/ns/pid, the boot id and the start ticks; elsewhere (macOS, the
// BSDs: one PID space per kernel) `0`, `kern.boottime` and the `ps` start
// second. A free lease proves an exit only for a holder on this boot (this
// kernel's lock table), so a row from another boot, or naming no namespace,
// stays busy. A PID names a process only inside its own namespace on its own
// boot, so a row's PID is consulted only when that matches this process's, and
// then only to keep the row busy: its PID still runs the process that took it.
// Rows written before this format (`<pid>:<uuid>`) name no lease and no
// namespace. Nothing here can prove their holder gone (its PID may be a live
// process in another PID namespace), so they stay busy until the operator's
// exact-row release. The acquisition time is shown to the operator only;
// nothing is reclaimed by age.
const REALM_KEY = Symbol.for('dacs.sellerState.process');
// Field 22 of /proc/<pid>/stat (start time in clock ticks since boot).
const startTicks = (stat) => { const field = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; return /^\d{1,20}$/.test(field ?? '') ? field : null; };
// The BSD tools, with a fixed PATH, locale and time zone.
const tool = (file, args) => execFileSync(file, args, { encoding: 'utf8', env: { PATH: '/bin:/usr/bin:/sbin:/usr/sbin', LC_ALL: 'C', TZ: 'UTC0' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// A running process's start time in whole seconds (UTC), as `ps` lists it, or null.
function psStart(pid) {
  try {
    const match = /^\s*[A-Z][a-z]{2} +([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s*$/.exec(tool('ps', ['-o', 'lstart=', '-p', String(pid)]));
    const month = match ? MONTHS.indexOf(match[1]) : -1;
    return month < 0 ? null : String(Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000);
  } catch { return null; }
}
// This process's PID namespace, boot and start time, or null where the host
// does not give all three. `pids` is how a PID here is looked up: 'proc' when
// /proc/<pid> names PIDs of this namespace (not when /proc was mounted for an
// ancestor namespace), 'ps' without /proc, or null.
function namespaceIdentity() {
  try {
    const ns = statSync('/proc/self/ns/pid', { bigint: true }).ino.toString();
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const start = startTicks(readFileSync('/proc/self/stat', 'utf8'));
    const nspid = /^NSpid:\s*(.*)$/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1].trim().split(/\s+/);
    if (!/^\d{1,20}$/.test(ns) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(boot) || start === null) return null;
    return Object.freeze({ ns, boot, start, pids: nspid?.length === 1 && nspid[0] === String(process.pid) ? 'proc' : null });
  } catch { /* no /proc: as on macOS and the BSDs */ }
  try {
    // Whole seconds only: they differ across reboots, and small adjustments
    // to the microseconds can't make a holder of this boot look like another's.
    const boot = /\bsec = (\d{1,20}),/.exec(tool('sysctl', ['-n', 'kern.boottime']));
    const start = psStart(process.pid);
    return boot && start ? Object.freeze({ ns: '0', boot: `bt${boot[1]}`, start, pids: 'ps' }) : null;
  } catch { return null; }
}
if (!globalThis[REALM_KEY]) Object.defineProperty(globalThis, REALM_KEY, { value: Object.freeze({ process: randomUUID(), leases: new Map(), namespace: namespaceIdentity() }) });
const { process: PROCESS, leases: LEASES, namespace: NAMESPACE = null } = globalThis[REALM_KEY];
const OWNER = /^(\d+):([0-9a-f-]{36}):(\d{1,15}):[0-9a-f-]{36}(?::(\d{1,20})\.([0-9a-f-]{36}|bt\d{1,20})\.(\d{1,20}))?$/;
const LEGACY_OWNER = /^\d+:[0-9a-f-]{36}$/;
function lockHolder(row) {
  const match = OWNER.exec(row.owner);
  if (!match || Number(match[1]) !== row.pid) return null;
  return { process: match[2], acquiredAt: Number(match[3]), namespace: match[4] ? { ns: match[4], boot: match[5], start: match[6] } : null };
}
const thisProcessLock = (row) => lockHolder(row)?.process === PROCESS;
const sameBoot = (holder) => Boolean(NAMESPACE && holder.namespace && holder.namespace.boot === NAMESPACE.boot);
const sameNamespace = (holder) => sameBoot(holder) && holder.namespace.ns === NAMESPACE.ns;
const holderFile = (dir, holder) => join(dir, 'holders', `${holder}.sqlite`);
const privateEntry = (stat, kind) => stat[kind]() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && !(stat.mode & 0o077);
// Takes this process's lifetime lease on `dir` once; it is never released
// before exit. Nothing else in this process may open the file: closing any
// other descriptor for it would drop the POSIX lock. So the file is always new
// (an existing one can only be this lease reached by another path), and it is
// made 0600 whatever the umask: opened read-only, SQLite would take only a
// shared lock, and others would see the lease free. The descriptor that
// created it stays open, and is never closed, for the same reason.
function takeLease(dir) {
  if (LEASES.has(dir)) return;
  const holders = join(dir, 'holders');
  try { mkdirSync(holders, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!privateEntry(lstatSync(holders), 'isDirectory')) fail('seller_state_directory_unsafe');
  const file = holderFile(dir, PROCESS);
  let fd;
  try { fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); } catch (error) { if (error.code === 'EEXIST') fail('seller_state_lease_unavailable'); throw error; }
  let lease;
  try {
    fchmodSync(fd, 0o600);
    const stat = lstatSync(file);
    if (!privateEntry(stat, 'isFile') || (stat.mode & 0o777) !== 0o600) fail('seller_state_file_unsafe');
    lease = new DatabaseSync(file);
    try { lease.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE'); } catch { fail('seller_state_lease_unavailable'); }
    // A pruner (below) may have removed the file before the lock was taken:
    // hold only the file this process created, still at its path. The open
    // descriptor keeps its inode from being reused meanwhile.
    let locked = null;
    try { locked = lstatSync(file); } catch { /* removed */ }
    const created = fstatSync(fd);
    if (locked?.ino !== created.ino || locked.dev !== created.dev) fail('seller_state_lease_unavailable');
  } catch (error) { lease?.close(); closeSync(fd); throw error; }
  LEASES.set(dir, { lease, fd });
}
const START_UNREADABLE = Symbol('start-unreadable');
const procStat = (pid) => readFileSync(`/proc/${pid}/stat`, 'utf8');
// The start time of the process a PID names here now; null only when the kernel
// says no process has that PID (ESRCH); START_UNREADABLE when one may run but
// its start can't be read (procfs mounted with hidepid shows another user's
// live process as missing, EPERM, a failed or malformed read).
function runningStart(pid, readStat = procStat) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  let signalled = true;
  try { process.kill(pid, 0); } catch (error) { signalled = error.code !== 'ESRCH'; }
  if (!signalled) return null;
  if (NAMESPACE.pids === 'proc') { try { return startTicks(readStat(pid)) ?? START_UNREADABLE; } catch { return START_UNREADABLE; } }
  return psStart(pid) ?? START_UNREADABLE;
}
// True when the row's holder ran in this PID namespace on this boot and its
// PID still runs the process that took the row (same start time), or runs a
// process whose start can't be read: that holder is alive whatever its lease
// shows. Otherwise the lease alone decides.
function holderRunsHere(row, holder, readStat) {
  if (!NAMESPACE?.pids || !sameNamespace(holder)) return false;
  const start = runningStart(row.pid, readStat);
  return start !== null && (start === START_UNREADABLE || start === holder.namespace.start);
}
// The state of process `id`'s lease: 'held' (another process holds it), 'free'
// (it can be taken), or 'unchecked' (missing, not a private regular file,
// unreadable, or any other error).
function leaseState(dir, id) {
  let probe;
  try {
    if (!privateEntry(lstatSync(holderFile(dir, id)), 'isFile')) return 'unchecked';
    probe = new DatabaseSync(holderFile(dir, id), { readonly: true });
    probe.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY');
    probe.exec('BEGIN EXCLUSIVE');
    probe.exec('ROLLBACK');
    return 'free';
  } catch (error) { return error?.errcode === 5 || error?.code === 'SQLITE_BUSY' ? 'held' : 'unchecked'; } finally { try { probe?.close(); } catch { /* the answer stands */ } }
}
// Why a row is, or is not, reclaimable. Only 'exited' is: its holder ran on
// this boot of this kernel, so its lease is in this kernel's lock table, that
// lease can be taken, and it does not still run in this PID namespace.
// - 'this-process', 'live': its holder runs (its lease is held, or its PID here
//   still runs it);
// - 'other-boot': it names another boot (or another kernel sharing the
//   directory), whose holder no free lease here can prove gone;
// - 'no-identity': it, or this process, has no boot and start identity;
// - 'lease-unproven': it names this boot, and its lease can't be checked;
// - 'legacy-format' (`<pid>:<uuid>`) or 'unrecognised': it names no process.
function holderState(dir, row, holder) {
  if (!holder) return LEGACY_OWNER.test(row.owner) ? 'legacy-format' : 'unrecognised';
  if (holder.process === PROCESS) return 'this-process';
  const lease = leaseState(dir, holder.process);
  if (lease === 'held') return 'live';
  if (!NAMESPACE || !holder.namespace) return 'no-identity';
  if (!sameBoot(holder)) return 'other-boot';
  if (holderRunsHere(row, holder)) return 'live';
  return lease === 'free' ? 'exited' : 'lease-unproven';
}
const PROVEN_LIVE = new Set(['this-process', 'live']);
// Rows the operator can release: an exited holder, or one nothing here can
// check (another boot or kernel, no identity, no process), on the operator's
// word that every process that could hold it has stopped. A live holder, and a
// holder on this boot whose lease can't be checked, are refused.
const RELEASABLE = new Set(['exited', 'other-boot', 'no-identity', 'legacy-format', 'unrecognised']);
// A busy answer on a row nothing proves alive or gone is reported once per row
// in this interval, so a held job is never silent.
const NOTICE_INTERVAL_MS = 10 * 60 * 1000;
// Pruning leaves lease files younger than this before the opening process
// started: a process takes its lease in one synchronous step after creating it.
const PRUNE_MIN_AGE_MS = 60 * 1000;
let identityWarned = false;
// The acquisition running in this async context: { api, jobId, owner }.
const running = new AsyncLocalStorage();

export class SellerRecoveryError extends Error {
  constructor(code) { super(code); this.code = code; this.status = 503; }
}

export const DEFAULT_SELLER_MAX_JOBS = 10000;

