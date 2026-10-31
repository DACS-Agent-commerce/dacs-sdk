// Opt-in host-local recovery for the SIMULATED seller adapter. This retains
// seller-authenticated application context beside the pinned SDK stores. It
// never obtains a buyer key or reconstructs facts from a cached HTTP answer.
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
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

export async function createSellerDurableState({ dir, signer, listingPin, maxJobs = DEFAULT_SELLER_MAX_JOBS }) {
  if (typeof dir !== 'string' || !isAbsolute(dir) || !/^did:demos:agent:[0-9a-f]{64}$/.test(signer?.claim) || typeof signer.sign !== 'function' || !Number.isSafeInteger(maxJobs) || maxJobs < 1) fail('seller_state_configuration_invalid');
  // A worker shares the process's leases but not its realm: keep seller state on the main thread.
  if (!isMainThread) fail('seller_state_main_thread_required');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || realpathSync(dir) !== dir) fail('seller_state_directory_unsafe');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(signer.claim.slice(16), 'hex')]), format: 'der', type: 'spki' });
  const pin = clone(listingPin);
  const schema = [
    'CREATE TABLE seller_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    'CREATE TABLE seller_jobs (job TEXT PRIMARY KEY, revision INTEGER NOT NULL, value TEXT NOT NULL)',
    'CREATE TABLE seller_locks (job TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL)',
  ];
  const path = join(dir, 'seller-state.sqlite');
  try {
    lstatSync(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Only unfinished initializers may precede the final database. Recheck
    // the path because another process may have published while we listed.
    if (readdirSync(dir).some(name => !/^seller-state-[0-9a-f-]{36}\.init(?:-journal)?$/.test(name)) && !existsSync(path)) fail('seller_state_missing_database');
    if (!existsSync(path)) {
      const pending = join(dir, `seller-state-${randomUUID()}.init`);
      const fd = openSync(pending, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      let initial;
      try {
        closeSync(fd);
        initial = new DatabaseSync(pending);
        initial.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
        initial.exec(schema.join(';'));
        initial.prepare('INSERT INTO seller_meta VALUES (?,?)').run('context', authenticated('context', 'context', null));
        initial.exec('COMMIT');
        initial.close(); initial = null;
        // Publish only a complete, authenticated database, without replacing
        // the winner of a concurrent initialization. No SQLite handle to the
        // temporary path remains open when the final path becomes visible.
        try { linkSync(pending, path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        const directory = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
      } finally { try { initial?.close(); } finally { unlinkSync(pending); } }
    }
  }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.() || (file.mode & 0o077)) fail('seller_state_file_unsafe');
  if (file.size === 0) fail('seller_state_corrupt');
  takeLease(dir);
  const db = new DatabaseSync(path);
  const owned = new Map(); // jobId -> { owner, revision } for this store's held locks
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000');
  try {
    const actual = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.sql);
    if (!same(actual, [...schema].sort((a,b) => a.split(' ')[2].localeCompare(b.split(' ')[2])))) fail('seller_state_corrupt');
  } catch (error) { db.close(); throw error; }
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function authenticated(kind, id, body) {
    const payload = { version: '1', kind, id, seller: signer.claim, listingPin: pin, body: clone(body) };
    const bytes = Buffer.from(`${DOMAIN}${canonicalize(payload)}`);
    const signature = Buffer.from(signer.sign(bytes));
    if (signature.length !== 64 || !verify(null, bytes, key, signature)) fail('seller_state_signer_invalid');
    return JSON.stringify({ payload, signature: signature.toString('base64url') });
  }
  function verified(value, kind, id) {
    try {
      const envelope = JSON.parse(value);
      const { payload: p, signature } = envelope;
      if (Object.keys(envelope).sort().join(',') !== 'payload,signature' || Object.keys(p).sort().join(',') !== 'body,id,kind,listingPin,seller,version' || p.version !== '1' || p.kind !== kind || p.id !== id || p.seller !== signer.claim || !same(p.listingPin, pin) || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature)) fail('seller_state_corrupt');
      const sig = Buffer.from(signature, 'base64url');
      if (sig.toString('base64url') !== signature || !verify(null, Buffer.from(`${DOMAIN}${canonicalize(p)}`), key, sig)) fail('seller_state_corrupt');
      return clone(p.body);
    } catch { fail('seller_state_corrupt'); }
  }
  try {
    const config = get('SELECT value FROM seller_meta WHERE key=?', 'context');
    if (!config) fail('seller_state_corrupt');
    verified(config.value, 'context', 'context');
    const fencedStore = await createFsFencedSessionStore({ dir: join(dir, 'sdk-agreements') });
    const receiptStore = await createFsSellerReceiptStore({ dir: join(dir, 'sdk-receipts') });
    function load(jobId) {
      const row = get('SELECT * FROM seller_jobs WHERE job=?', jobId);
      if (!row) return null;
      const stored = verified(row.value, 'session', jobId);
      if (stored.revision !== row.revision || stored.session.jobId !== jobId || !isCanonicalJobId(jobId)) fail('seller_state_corrupt');
      return stored;
    }
    // Called inside each job-scoped write transaction (an effect's intent and
    // its completion record alike) and as the last check before each effect:
    // the caller must be running this store's acquisition of `jobId`, and the
    // row must still be that acquisition's. A released or reclaimed holder is
    // fenced.
    function fence(jobId) {
      const held = owned.get(jobId), scope = running.getStore();
      if (held === undefined || held.finished || scope?.api !== api || scope.jobId !== jobId || scope.owner !== held.owner) fail('seller_state_fenced');
      if (get('SELECT owner FROM seller_locks WHERE job=?', jobId)?.owner !== held.owner) fail('seller_state_fenced');
      return held;
    }
    // One line per row and interval when withJob() stays busy on a row that
    // nothing here proves alive or gone; it names the job and the reason only.
    const noticed = new Map(); // `<job> <owner>` -> last notice (ms)
    function notice(jobId, owner, reason) {
      const key = `${jobId} ${owner}`, at = Date.now();
      if (at - (noticed.get(key) ?? -Infinity) < NOTICE_INTERVAL_MS) return;
      noticed.delete(key);
      if (noticed.size >= 1024) noticed.delete(noticed.keys().next().value);
      noticed.set(key, at);
      process.stderr.write(`seller-state: job ${jobId} stays busy: its lock row (${reason}) names no holder this process can prove exited; see inspectLocks() and releaseAbandonedLock()\n`);
    }
    // Removes the lease files of processes that have exited, that no row names
    // and that are older than this process by a margin (so none of its own, and
    // none still being created). It runs under the database write lock, so no
    // row can name one meanwhile, and removes each while holding its lock: a
    // process stalled between creating and locking its lease fails to open
    // instead (takeLease checks its file).
    function pruneLeases() {
      transaction(() => {
        const named = new Set(db.prepare('SELECT owner FROM seller_locks').all().map((row) => row.owner.split(':')[1]));
        for (const name of readdirSync(join(dir, 'holders'))) {
          const id = /^([0-9a-f-]{36})\.sqlite$/.exec(name)?.[1];
          if (!id || id === PROCESS || named.has(id)) continue;
          let probe;
          try {
            const stat = lstatSync(holderFile(dir, id));
            if (!privateEntry(stat, 'isFile') || stat.mtimeMs >= performance.timeOrigin - PRUNE_MIN_AGE_MS) continue;
            probe = new DatabaseSync(holderFile(dir, id), { readonly: true });
            probe.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN EXCLUSIVE');
            unlinkSync(holderFile(dir, id));
          } catch { /* held, unreadable or gone: kept */ } finally { try { probe?.close(); } catch { /* removed or kept either way */ } }
        }
      });
    }
    const pendingReleases = new Map();
    function release(jobId, owner) {
      run('DELETE FROM seller_locks WHERE job=? AND owner=?', jobId, owner);
      if (owned.get(jobId)?.owner === owner) owned.delete(jobId);
      pendingReleases.delete(jobId);
    }
    function releasePending() {
      for (const [jobId, owner] of pendingReleases) release(jobId, owner);
    }
    const api = {
      fencedStore,
      receiptStore,
      // The fence as a check, for a seller effect that leaves through another
      // journal (a native publication or wallet call): true while the caller
      // runs this store's acquisition of `jobId` and still holds its row,
      // otherwise seller_state_fenced. Call it with nothing awaited between
      // it and the effect (for example as that journal's authorize hook).
      assertHeld(jobId) { fence(jobId); return true; },
      context: () => {
        const row = get('SELECT value FROM seller_meta WHERE key=?', 'context');
        return row ? verified(row.value, 'context', 'context') : null;
      },
      retainContext(context) {
        transaction(() => {
          const row = get('SELECT value FROM seller_meta WHERE key=?', 'context');
          if (!row) fail('seller_state_corrupt');
          const previous = verified(row.value, 'context', 'context');
          if (previous === null) run('UPDATE seller_meta SET value=? WHERE key=?', authenticated('context', 'context', context), 'context');
          else if (!same(previous, context)) fail('seller_state_context_conflict');
        });
      },
      sessions: () => db.prepare('SELECT job FROM seller_jobs ORDER BY job').all().map(({ job }) => load(job).session),
      loadSession: (jobId) => load(jobId)?.session ?? null,
      saveSession(session) {
        const jobId = session.jobId;
        const committed = transaction(() => {
          const held = fence(jobId);
          const previous = load(jobId);
          if ((previous?.revision ?? 0) !== held.revision) fail('seller_state_fenced');
          if (!previous && get('SELECT COUNT(*) AS n FROM seller_jobs').n >= maxJobs) fail('seller_state_capacity');
          const revision = held.revision + 1;
          const value = authenticated('session', jobId, { revision, session });
          run('INSERT INTO seller_jobs VALUES (?,?,?) ON CONFLICT(job) DO UPDATE SET revision=excluded.revision,value=excluded.value', jobId, revision, value);
          return { held, revision };
        });
        committed.held.revision = committed.revision;
      },
      async withJob(jobId, action) {
        if (!isCanonicalJobId(jobId)) fail('seller_state_job_invalid');
        releasePending();
        // One acquisition per job per store, even after its row was released.
        if (owned.has(jobId)) fail('seller_state_busy');
        const owner = `${process.pid}:${PROCESS}:${Date.now()}:${randomUUID()}${NAMESPACE ? `:${NAMESPACE.ns}.${NAMESPACE.boot}.${NAMESPACE.start}` : ''}`;
        const { reclaimed, revision } = transaction(() => {
          const lock = get('SELECT * FROM seller_locks WHERE job=?', jobId);
          // Never reclaim by age, and never by PID alone. A row naming a
          // process is taken over only once that process has exited. A row
          // naming none (the earlier format) is never taken over: its PID may
          // be a live holder in another PID namespace. Only the release frees it.
          const state = lock ? holderState(dir, lock, lockHolder(lock)) : null;
          if (lock && state !== 'exited') {
            if (!PROVEN_LIVE.has(state)) notice(jobId, lock.owner, state);
            fail('seller_state_busy');
          }
          if (lock) run('DELETE FROM seller_locks WHERE job=? AND owner=?', jobId, lock.owner);
          // Reserve capacity atomically with the job lock, before admission.
          // Concurrent new jobs count as reservations until their lock releases.
          if (!load(jobId)) {
            // A process can exit before saving a session. Its reservation must
            // not occupy capacity forever just because this is a different job.
            // Use the same positive exit proof as takeover, under this write
            // transaction; live/unproven holders and saved sessions stay counted.
            for (const reservation of db.prepare('SELECT * FROM seller_locks WHERE job NOT IN (SELECT job FROM seller_jobs)').all()) {
              if (holderState(dir, reservation, lockHolder(reservation)) === 'exited') {
                run('DELETE FROM seller_locks WHERE job=? AND owner=?', reservation.job, reservation.owner);
              }
            }
            if (get(`SELECT
            (SELECT COUNT(*) FROM seller_jobs) +
            (SELECT COUNT(*) FROM seller_locks WHERE job NOT IN (SELECT job FROM seller_jobs)) AS n`).n >= maxJobs) fail('seller_state_capacity');
          }
          run('INSERT INTO seller_locks VALUES (?,?,?)', jobId, owner, process.pid);
          return { reclaimed: Boolean(lock), revision: load(jobId)?.revision ?? 0 };
        });
        owned.set(jobId, { owner, revision });
        if (reclaimed) process.stderr.write(`seller-state: reclaimed the lock on job ${jobId} left by a process that has exited\n`);
        let actionFailed = false;
        try { return await running.run({ api, jobId, owner }, () => action(load(jobId)?.session ?? null)); }
        catch (error) { actionFailed = true; throw error; }
        finally {
          // The action is over: nothing it started may write under this row,
          // whether or not the delete lands now. A failed delete keeps the entry
          // (close and the retry need it) but fenced.
          const held = owned.get(jobId);
          if (held?.owner === owner) held.finished = true;
          try { release(jobId, owner); }
          catch (error) { pendingReleases.set(jobId, owner); if (!actionFailed) throw error; }
        }
      },
      inspectLocks: () => db.prepare('SELECT job,owner,pid FROM seller_locks ORDER BY job').all().map((row) => {
        const held = lockHolder(row), reason = holderState(dir, row, held);
        return { job: row.job, owner: row.owner, pid: row.pid, process: held?.process ?? null, acquiredAt: held ? new Date(held.acquiredAt).toISOString() : null,
          boot: held?.namespace && NAMESPACE ? (sameBoot(held) ? 'this' : 'other') : null,
          pidNamespace: held?.namespace && NAMESPACE && sameBoot(held) ? (sameNamespace(held) ? 'this' : 'other') : null,
          holderExited: held ? reason === 'exited' : null, reason, thisProcess: thisProcessLock(row), thisInstance: owned.get(row.job)?.owner === row.owner };
      }),
      // Explicit operator action. It removes only that exact row: retained
      // sessions, effects and settlements are untouched. A live holder (this
      // process, a held lease, or its PID here still running it) is never
      // released (seller_state_lock_live), nor a holder on this boot whose
      // lease can't be checked (seller_state_lock_unproven). A row whose holder
      // has exited is released. A row of another boot, or naming no identity
      // or no process (the earlier format), is released on the operator's
      // word: only after every process that could hold it has stopped (for the
      // earlier format, every process of the earlier version that can open
      // this directory, in every container and PID namespace).
      releaseAbandonedLock({ job, owner } = {}) {
        if (!isCanonicalJobId(job) || typeof owner !== 'string') fail('seller_state_lock_invalid');
        return transaction(() => {
          const row = get('SELECT * FROM seller_locks WHERE job=? AND owner=?', job, owner);
          if (!row) fail('seller_state_lock_mismatch');
          const state = holderState(dir, row, lockHolder(row));
          if (PROVEN_LIVE.has(state)) fail('seller_state_lock_live');
          if (!RELEASABLE.has(state)) fail('seller_state_lock_unproven');
          run('DELETE FROM seller_locks WHERE job=? AND owner=?', job, owner);
          return { released: true, recordsChanged: 0 };
        });
      },
      close: () => { releasePending(); if (owned.size) fail('seller_state_busy'); db.close(); },
    };
    try { pruneLeases(); } catch { /* the database is busy: a later open prunes */ }
    if (!NAMESPACE && !identityWarned) {
      identityWarned = true;
      process.stderr.write('seller-state: this host gives no boot and process start identity (no /proc, or kern.boottime and ps): a job lock left by a killed process is never reclaimed automatically; see inspectLocks() and releaseAbandonedLock()\n');
    }
    return api;
  } catch (error) { db.close(); throw error; }
}
