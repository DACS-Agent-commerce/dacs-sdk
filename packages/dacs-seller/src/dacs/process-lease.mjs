// A seller process's lifetime lease on each state directory it opens, and the
// one rule that decides whether another process that named such a lease has
// exited. The lease is an exclusive SQLite (POSIX) lock on
// `<dir>/holders/<process>.sqlite`, taken once and held until exit, so the
// kernel itself frees it when the process ends, however it ends. A free lease
// proves an exit only within one kernel's lock table: only for a holder that
// ran on this boot. A PID, or the start time it reads back, is never exit
// evidence; it can only keep a holder live.
//
// `<process>` is a UUID made once per realm and shared by every copy of this
// module. The namespace identity is `{ ns, boot, start }`: on Linux the inode
// of /proc/self/ns/pid, the boot id and the start ticks; elsewhere (macOS, the
// BSDs: one PID space per kernel) `0`, `kern.boottime` and the `ps` start
// second. Storage that does not share POSIX locks between machines is not
// supported: a free lease read there proves nothing.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const REALM_KEY = Symbol.for('dacs.sellerState.process');
const HOLDERS = 'holders';
const TOOL_TIMEOUT_MS = 5000;
const LEASE_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
// Field 22 of /proc/<pid>/stat (start time in clock ticks since boot). The
// command name (field 2) may hold spaces or parentheses, so count from the last ')'.
const startTicks = (stat) => { const field = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; return /^\d{1,20}$/.test(field ?? '') ? field : null; };
// The BSD tools, with a fixed PATH, locale and time zone.
const tool = (file, args) => execFileSync(file, args, { encoding: 'utf8', env: { PATH: '/bin:/usr/bin:/sbin:/usr/sbin', LC_ALL: 'C', TZ: 'UTC0' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: TOOL_TIMEOUT_MS });
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
    if (!/^\d{1,20}$/.test(ns) || !LEASE_ID.test(boot) || start === null) return null;
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
const { leases: LEASES } = globalThis[REALM_KEY];

/** This process's lease id: a UUID made once per realm and shared by every copy of this module. */
export const PROCESS_LEASE_ID = globalThis[REALM_KEY].process;
/** This process's `{ ns, boot, start, pids }` identity, or null where the host does not give one. */
export const PROCESS_NAMESPACE = globalThis[REALM_KEY].namespace ?? null;

/** A refused lease: `code` is seller_state_directory_unsafe, seller_state_file_unsafe or seller_state_lease_unavailable. */
export class ProcessLeaseError extends Error {
  constructor(code) { super(code); this.name = 'ProcessLeaseError'; this.code = code; }
}
const refuse = (code) => { throw new ProcessLeaseError(code); };
const privateEntry = (stat, kind) => stat[kind]() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && !(stat.mode & 0o077);
const sameInode = (a, b) => a?.ino === b.ino && a.dev === b.dev;

/** The path of lease `id` under state directory `dir`. */
export const leaseFile = (dir, id) => join(dir, HOLDERS, `${id}.sqlite`);

/**
 * Takes this process's lifetime lease on `dir` once per canonical directory (an
 * alias or trailing slash reaches the same lease); it is never released before
 * exit. Nothing else in this process may open the file: closing any other
 * descriptor for it would drop the POSIX lock. So the file is always new, made
 * 0600 whatever the umask (opened read-only, SQLite would take only a shared
 * lock), and the descriptor that created it stays open. Returns the lease id;
 * throws ProcessLeaseError, and registers nothing, when the lease can't be taken.
 */
export function takeLease(dir) {
  const canonical = realpathSync(dir);
  if (LEASES.has(canonical)) return PROCESS_LEASE_ID;
  if (!lstatSync(canonical).isDirectory()) refuse('seller_state_directory_unsafe');
  const holders = join(canonical, HOLDERS);
  try { mkdirSync(holders, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!privateEntry(lstatSync(holders), 'isDirectory')) refuse('seller_state_directory_unsafe');
  const file = leaseFile(canonical, PROCESS_LEASE_ID);
  let fd;
  try { fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); } catch (error) { if (error.code === 'EEXIST') refuse('seller_state_lease_unavailable'); throw error; }
  let lease;
  try {
    fchmodSync(fd, 0o600);
    const created = fstatSync(fd), stat = lstatSync(file);
    if (!privateEntry(stat, 'isFile') || (stat.mode & 0o777) !== 0o600 || !sameInode(stat, created)) refuse('seller_state_file_unsafe');
    lease = new Database(file);
    try { lease.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE'); } catch { refuse('seller_state_lease_unavailable'); }
    // Hold only the file this process created, still at its path. The open
    // descriptor keeps its inode from being reused meanwhile.
    let locked = null;
    try { locked = lstatSync(file); } catch { /* removed */ }
    if (!sameInode(locked, created)) refuse('seller_state_lease_unavailable');
  } catch (error) {
    try { lease?.close(); } finally { closeSync(fd); }
    throw error;
  }
  LEASES.set(canonical, { lease, fd });
  return PROCESS_LEASE_ID;
}

/**
 * The state of lease `id` under `dir`: 'held' (a process holds it; always so
 * for this process's own lease, which is never opened again here), 'free' (it
 * can be taken), or 'unchecked' (a malformed id; missing, not a private regular
 * file, unreadable, or any other error).
 */
export function leaseState(dir, id) {
  if (id === PROCESS_LEASE_ID) return 'held';
  if (typeof id !== 'string' || !LEASE_ID.test(id)) return 'unchecked';
  let probe;
  try {
    if (!privateEntry(lstatSync(leaseFile(dir, id)), 'isFile')) return 'unchecked';
    probe = new Database(leaseFile(dir, id), { readonly: true });
    probe.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY');
    probe.exec('BEGIN EXCLUSIVE');
    probe.exec('ROLLBACK');
    return 'free';
  } catch (error) { return error?.code === 'SQLITE_BUSY' ? 'held' : 'unchecked'; } finally { try { probe?.close(); } catch { /* the answer stands */ } }
}

const START_UNREADABLE = Symbol('start-unreadable');
const procStat = (pid) => readFileSync(`/proc/${pid}/stat`, 'utf8');
// The start time of the process a PID names here now; null only when the kernel
// says no process has that PID (ESRCH); START_UNREADABLE when one may run but
// its start can't be read (procfs mounted with hidepid shows another user's
// live process as missing, EPERM, a failed or malformed read).
function runningStart(pid, self, readStat) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return null; }
  if (self.pids === 'proc') { try { return startTicks(readStat(pid)) ?? START_UNREADABLE; } catch { return START_UNREADABLE; } }
  return psStart(pid) ?? START_UNREADABLE;
}
// True when the holder ran in this PID namespace on this boot and its PID
// still runs the process that took the lease (same start time), or runs a
// process whose start can't be read. False otherwise: never exit evidence.
function holderRunsHere(holder, self, readStat) {
  if (!self.pids || holder.namespace.ns !== self.ns) return false;
  const start = runningStart(holder.pid, self, readStat);
  return start !== null && (start === START_UNREADABLE || start === holder.namespace.start);
}

/**
 * Classifies the process that named lease `holder.process` in state directory
 * `dir`, given its `pid` and `namespace` (`{ ns, boot, start }` or null).
 * Returns 'this-process'; 'live' (its lease is held, or its PID here still
 * runs it or something whose start can't be read); 'no-identity' (it, or this
 * process, has no boot identity); 'other-boot' (no free lease here can prove
 * it gone); 'exited' (same boot, lease free, PID not running it); or
 * 'lease-unproven' (same boot, its lease can't be checked). `self` and
 * `readStat` replace this process's identity and the /proc/<pid>/stat read.
 */
export function leaseHolderState(dir, holder, { self = PROCESS_NAMESPACE, readStat = procStat } = {}) {
  if (holder.process === PROCESS_LEASE_ID) return 'this-process';
  const lease = leaseState(dir, holder.process);
  if (lease === 'held') return 'live';
  if (!self || !holder.namespace) return 'no-identity';
  if (holder.namespace.boot !== self.boot) return 'other-boot';
  if (holderRunsHere(holder, self, readStat)) return 'live';
  return lease === 'free' ? 'exited' : 'lease-unproven';
}
