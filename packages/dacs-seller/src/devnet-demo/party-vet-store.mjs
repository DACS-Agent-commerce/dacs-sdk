// The seller's party Vet store (SQLite): one row per job with the job's
// Vet binding, its SDK operation checkpoints, the write-ahead record of each
// signature, the context the seller's Agreement step reads, or a quarantine
// marker. It is its own file next to the artifact journal, so its rows never
// take that journal's capacity or slow its scans, and a job's row can be
// deleted once its purchase ended.
//
// A store is opened with an explicit mode: 'create' needs an absent file and
// 'open' an existing one, so a lost file is never replaced by an empty store
// that would read every checkpoint as never written.
//
// Every change is one IMMEDIATE transaction: read the row, apply a synchronous
// change, write or delete it. SQLite's write lock makes that atomic across
// processes that open the same file; no lock row is left behind by a process
// that dies. Each row carries a digest bound to this store's identity, so a
// row changed outside the store fails closed instead of reading as valid, and
// the store's own record of its row count and bytes catches a row removed
// outside it.
// Errors carry the durable journal's codes (journal-capacity, journal-busy,
// journal-integrity, journal-invalid). No key or secret is ever stored.
import DatabaseSync from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, linkSync, lstatSync, mkdtempSync, openSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const PARTY_VET_STORE_FORMAT = 'dacs-party-vet-store';
export const PARTY_VET_STORE_VERSION = 1;
const STORE_TABLES = Object.freeze({
  meta: 'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  jobs: 'CREATE TABLE jobs (key TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL, digest TEXT NOT NULL) STRICT',
});
// A row holds one job until its purchase ends (or its approval window passed).
// A planned job's row is about 26 KB (docs/DEVNET-FIXED-PRICE-DEMO.md), so the
// job cap binds first.
export const PARTY_VET_STORE_LIMITS = Object.freeze({ maxJobs: 4096, maxValueBytes: 256 * 1024, maxTotalBytes: 256 * 1024 * 1024 });

class PartyVetStoreError extends Error {
  constructor(code, message, options) { super(message, options); this.code = code; }
}
const fail = (code, message, options) => { throw new PartyVetStoreError(code, message, options); };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
// The store's record of how many rows and bytes it holds, bound to its identity.
const totalsRecord = (storeId, jobs, bytes) => `${jobs}:${bytes}:${sha256(`${PARTY_VET_STORE_FORMAT}\n${storeId}\ntotals\n${jobs}\n${bytes}`)}`;
const bounded = (name, value, min, max) => { if (!Number.isSafeInteger(value) || value < min || value > max) fail('journal-invalid', `${name} must be an integer from ${min} to ${max}`); return value; };
const checkKey = (key) => { if (typeof key !== 'string' || !key || Buffer.from(key).toString('utf8') !== key || Buffer.byteLength(key) > 512 || key.includes('\0')) fail('journal-invalid', 'party Vet store keys are non-empty strings of at most 512 bytes'); return key; };
const encode = (value) => {
  let text;
  try { text = JSON.stringify(value); }
  catch (cause) { fail('journal-invalid', 'party Vet store rows must serialize to JSON objects', { cause }); }
  if (typeof text !== 'string' || text[0] !== '{') fail('journal-invalid', 'party Vet store rows are JSON objects');
  return text;
};

function limitsFor({ maxJobs = PARTY_VET_STORE_LIMITS.maxJobs, maxValueBytes = PARTY_VET_STORE_LIMITS.maxValueBytes, maxTotalBytes = PARTY_VET_STORE_LIMITS.maxTotalBytes } = {}) {
  bounded('maxJobs', maxJobs, 1, 1_000_000); bounded('maxValueBytes', maxValueBytes, 64, 16 * 1024 * 1024); bounded('maxTotalBytes', maxTotalBytes, maxValueBytes, 4 * 1024 * 1024 * 1024);
  return { maxJobs, maxValueBytes, maxTotalBytes };
}

// The shared store logic over a row backend whose `transaction` runs its
// function atomically and synchronously.
function storeOver(backend, limits) {
  // Compact ended-job rows retain replay authority and byte accounting, but
  // contain no active Vet work. Keep them outside the active-job quota.
  const replayFence=(key,row)=>key.startsWith('party-vet/')
    && row?.version==='dacs-devnet-demo-party-vet-state/v2'
    && Object.keys(row).sort().join(',')==='jobId,lifecycle,revision,version,writer'
    && row.lifecycle?.state==='ended';
  const activeJobs=()=>backend.entries().filter(([key,row])=>!replayFence(key,row)).length;
  const usage = (rows = {...backend.totals(),jobs:activeJobs()}) => ({ jobs: rows.jobs, bytes: rows.bytes, maxJobs: limits.maxJobs, maxTotalBytes: limits.maxTotalBytes,
    remainingJobs: Math.max(0, limits.maxJobs - rows.jobs), remainingBytes: Math.max(0, limits.maxTotalBytes - rows.bytes) });
  // change(current) answers undefined (no change), null (delete the row) or
  // the next row. It must be synchronous: nothing may interleave between the
  // read and the write. The second argument reads all rows in that same
  // transaction, for uniqueness checks spanning jobs.
  async function update(key, change) {
    checkKey(key);
    if (typeof change !== 'function') fail('journal-invalid', 'party Vet store change must be a function');
    // The change's own refusal reaches the caller as it was thrown.
    let refused = null;
    try { return backend.transaction(() => {
      const current = backend.get(key);
      let next;
      try { next = change(current === null ? null : structuredClone(current), () => structuredClone(backend.entries())); } catch (error) { refused = { error }; throw error; }
      if (typeof next?.then === 'function') { Promise.resolve(next).catch(() => {}); fail('journal-invalid', 'party Vet store changes are synchronous'); }
      if (next === undefined) return current;
      if (next === null) { backend.remove(key); return null; }
      const text = encode(next), bytes = Buffer.byteLength(text);
      if (bytes > limits.maxValueBytes) fail('journal-capacity', `the party Vet store row exceeds ${limits.maxValueBytes} bytes; nothing was written`);
      const totals = backend.totals(), old = backend.size(key);
      const jobs=activeJobs() - (current&&!replayFence(key,current)?1:0) + (replayFence(key,next)?0:1);
      if (jobs > limits.maxJobs || totals.bytes - (old ?? 0) + bytes > limits.maxTotalBytes) fail('journal-capacity', 'the party Vet store is full; nothing was written');
      backend.put(key, text, bytes);
      return JSON.parse(text);
    }); } catch (error) { throw refused ? refused.error : error; }
  }
  return {
    read: async (key) => { checkKey(key); return backend.snapshot(() => backend.get(key)); },
    update,
    entries: async () => backend.snapshot(() => backend.entries()),
    usage: () => usage(),
    close: () => backend.close(),
  };
}

const syncPath = (target, flags) => {
  const fd = openSync(target, flags);
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

// Publish a complete private database without replacing a concurrent winner.
function initializePartyVetStore(path) {
  const temporary = mkdtempSync(path + '.init-'), candidate = join(temporary, 'store.sqlite');
  let db;
  try {
    closeSync(openSync(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    db = new DatabaseSync(candidate);
    db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
    for (const sql of Object.values(STORE_TABLES)) db.exec(sql);
    const id = randomBytes(16).toString('hex'), insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of [['format', PARTY_VET_STORE_FORMAT], ['version', String(PARTY_VET_STORE_VERSION)], ['store_id', id], ['totals', totalsRecord(id, 0, 0)]]) insert.run(key, value);
    db.exec('COMMIT'); db.close(); db = null;
    syncPath(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { linkSync(candidate, path); } catch (error) { throw error.code === 'EEXIST' ? new PartyVetStoreError('journal-exists', 'another opener created the party Vet store first', { cause: error }) : error; }
    syncPath(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
  } finally {
    try { db?.close(); } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
}

// A crash between publishing the database (a hard link from its initialization
// directory) and removing that directory leaves the database with two links.
// The store is whole then: the other link is removed when it is the private
// candidate this process user's initializer made next to the path. Any other
// second link is left for the caller's link check to refuse.
function settleInterruptedPublication(path, published) {
  const prefix = `${basename(path)}.init-`, uid = process.getuid();
  for (const entry of readdirSync(dirname(path))) {
    if (!entry.startsWith(prefix)) continue;
    const directory = join(dirname(path), entry);
    let folder, candidate;
    try { folder = lstatSync(directory); candidate = lstatSync(join(directory, 'store.sqlite')); } catch { continue; }
    if (folder.isDirectory() && folder.uid === uid && (folder.mode & 0o077) === 0 && candidate.isFile() && candidate.uid === uid && candidate.dev === published.dev && candidate.ino === published.ino) {
      rmSync(directory, { recursive: true, force: true });
      syncPath(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
      return lstatSync(path);
    }
  }
  return published;
}

// Synchronous admission follows the private-store ownership/path policy; this
// API cannot use the asynchronous directory preparation primitive.
function admitPath(path) {
  if (!process.getuid) fail('journal-invalid', 'party Vet storage requires POSIX ownership checks');
  const parent = dirname(path), uid = process.getuid();
  for (let component = parent; ; component = dirname(component)) {
    const stat = lstatSync(component), scratch = stat.uid === 0 && (stat.mode & 0o1000) !== 0 && component !== parent;
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== uid && stat.uid !== 0) ||
        (component === parent && stat.uid !== uid) || ((stat.mode & 0o022) !== 0 && !scratch)) fail('journal-invalid', 'party Vet storage requires private owned directories without symbolic links');
    if (component === dirname(component)) break;
  }
  for (const name of [path, path + '-wal', path + '-shm', path + '-journal']) {
    let stat;
    try { stat = lstatSync(name); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (name === path && stat.nlink === 2) stat = settleInterruptedPublication(path, stat);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== uid) fail('journal-invalid', 'the party Vet store must be a private regular file with one link owned by this process user');
  }
}

// path: absolute. mode 'create' requires an absent file and publishes it only
// after initialization (journal-exists otherwise); mode 'open' requires an
// existing file of this format that is intact (journal-absent when missing).
export function openPartyVetStore({ path, mode, busyTimeoutMs = 1000, ...options } = {}) {
  if (mode !== 'create' && mode !== 'open') fail('journal-invalid', "mode must be explicitly 'create' or 'open'");
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.startsWith('file:')) fail('journal-invalid', 'an explicit absolute party Vet store path is required');
  path = resolve(path);
  if (path !== path.trim()) fail('journal-invalid', 'the party Vet store path must not have surrounding whitespace');
  admitPath(path);
  bounded('busyTimeoutMs', busyTimeoutMs, 0, 10_000);
  const limits = limitsFor(options);
  let present = true;
  try { lstatSync(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; present = false; }
  if (mode === 'create' && present) fail('journal-exists', 'create refuses an existing party Vet store path');
  if (mode === 'open' && !present) fail('journal-absent', 'the party Vet store is absent; it is not recreated');
  if (!present) initializePartyVetStore(path);
  const file = lstatSync(path);
  if (file.nlink !== 1 || !file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid())) fail('journal-invalid', 'the party Vet store must be a private regular file owned by this process user');
  let db;
  const verifyIdentity = () => {
    admitPath(path);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd), after = lstatSync(path);
      if ([opened, after].some(stat => stat.dev !== file.dev || stat.ino !== file.ino || stat.nlink !== 1)) fail('journal-invalid', 'the party Vet store changed while opening');
    } finally { closeSync(fd); }
  };
  const translate = (error) => {
    if (error instanceof PartyVetStoreError) return error;
    const text = String(error?.message ?? error);
    if (/database is locked|SQLITE_BUSY|database table is locked/i.test(text)) return new PartyVetStoreError('journal-busy', 'the party Vet store is busy; nothing was changed', { cause: error });
    if (/not a database|malformed|corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(text)) return new PartyVetStoreError('journal-integrity', 'the party Vet store is not intact; nothing may be signed or sent', { cause: error });
    return new PartyVetStoreError('journal-error', 'the party Vet store operation failed; nothing may be signed or sent', { cause: error });
  };
  let closed = false;
  const tx = (kind, fn) => {
    if (closed) fail('journal-closed', 'the party Vet store is closed');
    try {
      db.exec(kind);
      try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw error; }
    } catch (error) { throw translate(error); }
  };
  let storeId;
  try {
    verifyIdentity();
    db = new DatabaseSync(path, { readonly: true, fileMustExist: true });
    verifyIdentity();
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('journal-integrity', 'the party Vet store failed its integrity check');
    storeId = tx('BEGIN', () => {
      const schema = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema').all();
      if (schema.some(row => !(row.type === 'table' && Object.hasOwn(STORE_TABLES, row.name) && row.sql === STORE_TABLES[row.name]) &&
          !(row.type === 'index' && Object.hasOwn(STORE_TABLES, row.tbl_name) && row.sql === null && row.name === `sqlite_autoindex_${row.tbl_name}_1`))) {
        fail('journal-integrity', 'the party Vet store contains unexpected schema objects');
      }
      for (const [name, sql] of Object.entries(STORE_TABLES)) {
        if (db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name)?.sql !== sql) fail('journal-integrity', 'the party Vet store schema is absent or changed');
      }
      let meta;
      try { meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((row) => [row.key, row.value])); } catch (error) { fail('journal-integrity', 'the party Vet store schema is absent or changed', { cause: error }); }
      if (Object.keys(meta).sort().join() !== 'format,store_id,totals,version' || meta.format !== PARTY_VET_STORE_FORMAT || meta.version !== String(PARTY_VET_STORE_VERSION) || !/^[a-f0-9]{32}$/.test(meta.store_id ?? '')) fail('journal-integrity', 'the party Vet store format, version or identity is not recognized');
      return meta.store_id;
    });
  } catch (error) { try { db?.close(); } catch { /* already failed */ } closed = true; throw translate(error); }
  const digest = (key, text) => sha256(`${PARTY_VET_STORE_FORMAT}\n${storeId}\n${key}\n${text}`);
  const decode = (row) => {
    if (row.digest !== digest(row.key, row.value) || row.bytes !== Buffer.byteLength(row.value)) fail('journal-integrity', 'a party Vet store row changed outside the store; nothing may be signed or sent');
    try {
      const value = JSON.parse(row.value);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('journal-integrity', 'a party Vet store row is not a JSON object');
      return value;
    } catch (cause) { fail('journal-integrity', 'a party Vet store row is malformed', { cause }); }
  };
  // The rows held must be the rows the store recorded: a row removed outside it fails closed.
  const heldTotals = () => { const row = db.prepare('SELECT count(*) AS jobs, coalesce(sum(bytes), 0) AS bytes FROM jobs').get(); return { jobs: Number(row.jobs), bytes: Number(row.bytes) }; };
  const recordedTotals = () => db.prepare("SELECT value FROM meta WHERE key = 'totals'").get()?.value;
  const checkTotals = (recorded) => {
    const { jobs, bytes } = heldTotals();
    if (recorded !== totalsRecord(storeId, jobs, bytes)) fail('journal-integrity', 'the party Vet store holds other rows than it recorded; nothing may be signed or sent');
  };
  const recordTotals = () => { const { jobs, bytes } = heldTotals(); db.prepare("UPDATE meta SET value = ? WHERE key = 'totals'").run(totalsRecord(storeId, jobs, bytes)); };
  try {
    tx('BEGIN', () => { for (const row of db.prepare('SELECT key, value, bytes, digest FROM jobs').iterate()) decode(row); checkTotals(recordedTotals()); });
    db.close(); verifyIdentity();
    db = new DatabaseSync(path, { fileMustExist: true }); verifyIdentity();
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (db.prepare('PRAGMA journal_mode = WAL').get().journal_mode !== 'wal') fail('journal-error', 'WAL journal mode is unavailable for the party Vet store');
    db.exec('PRAGMA synchronous = FULL');
  }
  catch (error) { db.close(); closed = true; throw translate(error); }
  const backend = {
    // Changes run in an IMMEDIATE transaction, reads in a deferred one.
    transaction: (fn) => tx('BEGIN IMMEDIATE', () => { checkTotals(recordedTotals()); const result = fn(); recordTotals(); return result; }),
    snapshot: (fn) => tx('BEGIN', () => { checkTotals(recordedTotals()); return fn(); }),
    get: (key) => { const row = db.prepare('SELECT key, value, bytes, digest FROM jobs WHERE key = ?').get(key); return row ? decode(row) : null; },
    size: (key) => db.prepare('SELECT bytes FROM jobs WHERE key = ?').get(key)?.bytes ?? null,
    totals: heldTotals,
    put: (key, text, bytes) => db.prepare('INSERT INTO jobs (key, value, bytes, digest) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, bytes = excluded.bytes, digest = excluded.digest').run(key, text, bytes, digest(key, text)),
    remove: (key) => db.prepare('DELETE FROM jobs WHERE key = ?').run(key),
    entries: () => db.prepare('SELECT key, value, bytes, digest FROM jobs ORDER BY key').all().map((row) => [row.key, decode(row)]),
    close: () => { if (!closed) { closed = true; db.close(); } },
  };
  const store = storeOver(backend, limits);
  return Object.freeze({ ...store, path, storeId, usage: () => backend.snapshot(() => store.usage()) });
}

// The same store in memory, for tests: nothing survives the process.
export function createInMemoryPartyVetStore(options = {}) {
  const limits = limitsFor(options), rows = new Map();
  let closed = false;
  const assertOpen = () => { if (closed) fail('journal-closed', 'the party Vet store is closed'); };
  const backend = {
    transaction: (fn) => {
      assertOpen();
      const before = new Map(rows);
      try { return fn(); } catch (error) { rows.clear(); for (const [key, value] of before) rows.set(key, value); throw error; }
    },
    snapshot: (fn) => { assertOpen(); return fn(); },
    get: (key) => (rows.has(key) ? JSON.parse(rows.get(key).text) : null),
    size: (key) => rows.get(key)?.bytes ?? null,
    totals: () => { assertOpen(); return { jobs: rows.size, bytes: [...rows.values()].reduce((sum, row) => sum + row.bytes, 0) }; },
    put: (key, text, bytes) => { rows.set(key, { text, bytes }); },
    remove: (key) => { rows.delete(key); },
    entries: () => [...rows.keys()].sort().map((key) => [key, JSON.parse(rows.get(key).text)]),
    close: () => { closed = true; },
  };
  return Object.freeze(storeOver(backend, limits));
}
