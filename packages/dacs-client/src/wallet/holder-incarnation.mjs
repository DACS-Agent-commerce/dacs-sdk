// Proof that the process which took a durable wallet lane lock has exited, so a
// lock left by our own crashed process can be recovered and no other lock ever
// is. Adapted from the seller state's reviewed lock code.
//
// Every process takes a lifetime lease on each journal directory it opens: an
// exclusive SQLite (POSIX) lock on `<dir>/holders/<process>.sqlite`, taken once
// and held until exit, so the kernel frees it when the process ends however it
// ends. A free lease proves an exit only within one kernel's lock table. A lock
// row names its holder as `<token>:<pid>:<process>[:<ns>.<boot>.<start>]`:
// `<process>` is the lease id, and `<ns>.<boot>.<start>` is the holder's PID
// namespace, boot and start. On Linux these are the inode of /proc/self/ns/pid,
// the boot id and the start ticks; elsewhere (one PID space per kernel) `0`,
// `kern.boottime` and the `ps` start second. Storage that does not share POSIX
// locks between machines is not supported.
//
// A holder is `exited` only when ALL hold: same boot and PID namespace, a PID
// reading is available here, the lease is free, the original start identity no
// longer runs (its PID is unused, or now names a different start), and
// acquiredAt is a valid time not after the clock. Age, a timeout, or a PID
// alone prove nothing. Everything else stays busy under another class.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const REALM_KEY = Symbol.for('dacs.walletJournal.process');
const HOLDERS = 'holders';
const TOOL_TIMEOUT_MS = 5000;
const SQLITE_BUSY = 5;
const UUID = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
const LEASE_ID = new RegExp(`^${UUID}$`);
const LEGACY_INSTANCE = /^[0-9a-f]{32}$/;
const INSTANCE = new RegExp(`^([0-9a-f]{32}):(\\d{1,15}):(${UUID})(?::(\\d{1,20})\\.(${UUID}|bt\\d{1,20})\\.(\\d{1,20}))?$`);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Returned by an identity reading when a PID may be running but its start cannot be read. */
export const START_UNREADABLE = Symbol('start-unreadable');

/** A refused lease: the holders directory or lease file is unsafe, or the lease cannot be taken. */
export class HolderLeaseError extends Error {
  constructor(message, options) { super(message, options); this.name = 'HolderLeaseError'; }
}
const refuse = (message, options) => { throw new HolderLeaseError(message, options); };

// Field 22 of /proc/<pid>/stat (start time in clock ticks since boot). The
// command name (field 2) may hold spaces or parentheses, so count from the last ')'.
const startTicks = (stat) => { const field = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; return /^\d{1,20}$/.test(field ?? '') ? field : null; };
// The BSD tools, with a fixed PATH, locale and time zone.
const tool = (file, args) => execFileSync(file, args, { encoding: 'utf8', env: { PATH: '/bin:/usr/bin:/sbin:/usr/sbin', LC_ALL: 'C', TZ: 'UTC0' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: TOOL_TIMEOUT_MS });
// A running process's start time in whole seconds (UTC), as `ps` lists it, or null.
function psStart(pid) {
  try {
    const match = /^\s*[A-Z][a-z]{2} +([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s*$/.exec(tool('ps', ['-o', 'lstart=', '-p', String(pid)]));
    const month = match ? MONTHS.indexOf(match[1]) : -1;
    return month < 0 ? null : String(Date.UTC(Number(match[6]), month, Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])) / 1000);
  } catch { return null; }
}
// This process's PID namespace, boot and start, or null where the host does not
// give all three. `pids` is how a PID here is looked up: 'proc' when /proc/<pid>
// names PIDs of this namespace (not when /proc was mounted for an ancestor
// namespace), 'ps' without /proc, or null.
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

// The start of the process a PID names here now: null when the kernel says no
// process has that PID, START_UNREADABLE when one may run but its start can't be read.
function runningStart(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return null; }
  if (globalThis[REALM_KEY].namespace?.pids === 'proc') { try { return startTicks(readFileSync(`/proc/${pid}/stat`, 'utf8')) ?? START_UNREADABLE; } catch { return START_UNREADABLE; } }
  return psStart(pid) ?? START_UNREADABLE;
}

/**
 * The OS readings a classification uses, which tests replace through the
 * journal's `identity` option: `self` (this process's `{ ns, boot, start, pids }`
 * or null), `runningStart(pid)` (null, START_UNREADABLE, or the start a PID
 * names now) and `now()` (milliseconds). Lease files are always read for real.
 */
export const OS_IDENTITY = Object.freeze({ self: globalThis[REALM_KEY].namespace, runningStart, now: () => Date.now() });

const privateEntry = (stat, kind) => stat[kind]() && !stat.isSymbolicLink() && stat.uid === process.getuid?.() && !(stat.mode & 0o077);
const sameInode = (a, b) => a?.ino === b.ino && a.dev === b.dev;
const leaseFile = (dir, id) => join(dir, HOLDERS, `${id}.sqlite`);

/**
 * Takes this process's lifetime lease on `dir` once per canonical directory; it
 * is never released before exit. Nothing else in this process may open the
 * file: closing any other descriptor for it would drop the POSIX lock. So the
 * file is always new, made 0600 whatever the umask, and the descriptor that
 * created it stays open. Throws HolderLeaseError, registering nothing, when the
 * lease can't be taken.
 */
export function takeLease(dir) {
  const canonical = realpathSync(dir);
  if (LEASES.has(canonical)) return;
  if (!lstatSync(canonical).isDirectory()) refuse('the journal directory is not a directory');
  const holders = join(canonical, HOLDERS);
  try { mkdirSync(holders, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!privateEntry(lstatSync(holders), 'isDirectory')) refuse('the holders directory is not a private directory owned by this user');
  const file = leaseFile(canonical, PROCESS_LEASE_ID);
  let fd;
  try { fd = openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); } catch (error) { if (error.code === 'EEXIST') refuse('this process lease file already exists', { cause: error }); throw error; }
  let lease;
  try {
    fchmodSync(fd, 0o600);
    const created = fstatSync(fd), stat = lstatSync(file);
    if (!privateEntry(stat, 'isFile') || (stat.mode & 0o777) !== 0o600 || !sameInode(stat, created)) refuse('the lease file is not a private file made by this process');
    lease = new DatabaseSync(file);
    try { lease.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE'); } catch (error) { refuse('the lease could not be locked', { cause: error }); }
    // Hold only the file this process created, still at its path.
    let locked = null;
    try { locked = lstatSync(file); } catch { /* removed */ }
    if (!sameInode(locked, created)) refuse('the lease file was replaced while it was locked');
  } catch (error) {
    try { lease?.close(); } finally { closeSync(fd); }
    throw error;
  }
  LEASES.set(canonical, { lease, fd });
}

// SQLITE_BUSY by result code, or by message where the engine reports no code.
const isBusy = (error) => (error?.errcode & 0xff) === SQLITE_BUSY || /database is locked|SQLITE_BUSY/i.test(String(error?.message));
// 'held' (a process holds lease `id`; always so for this process's own), 'free'
// (it can be taken), or 'unchecked' (a malformed id; the file is missing, not a
// private regular file, unreadable, or any other error).
function leaseState(dir, id) {
  if (id === PROCESS_LEASE_ID) return 'held';
  if (!LEASE_ID.test(id)) return 'unchecked';
  let probe;
  try {
    if (!privateEntry(lstatSync(leaseFile(dir, id)), 'isFile')) return 'unchecked';
    probe = new DatabaseSync(leaseFile(dir, id), { readOnly: true });
    probe.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY');
    probe.exec('BEGIN EXCLUSIVE');
    probe.exec('ROLLBACK');
    return 'free';
  } catch (error) { return isBusy(error) ? 'held' : 'unchecked'; } finally { try { probe?.close(); } catch { /* the answer stands */ } }
}

/**
 * The lock-row `instance` text of a journal instance `token` held by `process`
 * (a lease id) as process `pid` in `namespace` (`{ ns, boot, start }` or null).
 */
export function formatHolderInstance(token, { pid, process: leaseId, namespace }) {
  return `${token}:${pid}:${leaseId}${namespace ? `:${namespace.ns}.${namespace.boot}.${namespace.start}` : ''}`;
}

function parseHolderInstance(instance, pid) {
  const match = INSTANCE.exec(instance);
  if (!match || Number(match[2]) !== pid) return null;
  return { pid, process: match[3], namespace: match[4] ? { ns: match[4], boot: match[5], start: match[6] } : null };
}

/**
 * Classifies the holder named by a lock row (`instance` text, `pid` and ISO
 * `acquiredAt`) for a journal in `dir`, as one of: 'this-process'; 'live' (its
 * lease is held, or its PID still runs it or something whose start can't be
 * read); 'exited' (the only class that may be reclaimed); 'other-boot' (no free
 * lease here can prove it gone); 'no-identity' (it or this process lacks a
 * boot, namespace or PID reading, or it ran in another PID namespace);
 * 'lease-unproven' (its lease can't be checked, or acquiredAt is after the
 * clock, or the clock is unreadable); 'legacy-format' (a row from before
 * incarnations); or 'unrecognised' (malformed text, pid or acquiredAt).
 * `identity` replaces the OS readings (see OS_IDENTITY).
 */
export function classifyHolder(dir, { instance, pid, acquiredAt }, identity = OS_IDENTITY) {
  const holder = parseHolderInstance(instance, pid);
  if (!holder) return LEGACY_INSTANCE.test(instance) ? 'legacy-format' : 'unrecognised';
  if (holder.process === PROCESS_LEASE_ID) return 'this-process';
  const lease = leaseState(dir, holder.process);
  if (lease === 'held') return 'live';
  const { self } = identity;
  if (!self || !holder.namespace) return 'no-identity';
  if (holder.namespace.boot !== self.boot) return 'other-boot';
  if (holder.namespace.ns !== self.ns || !self.pids) return 'no-identity';
  const start = identity.runningStart(holder.pid);
  if (start === START_UNREADABLE || start === holder.namespace.start) return 'live';
  if (lease !== 'free') return 'lease-unproven';
  const acquired = Date.parse(acquiredAt), now = identity.now();
  if (!Number.isFinite(acquired)) return 'unrecognised';
  return Number.isFinite(now) && acquired <= now ? 'exited' : 'lease-unproven';
}
