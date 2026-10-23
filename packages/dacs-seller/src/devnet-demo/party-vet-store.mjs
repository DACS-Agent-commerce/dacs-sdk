// The seller's party Vet store (node:sqlite): one row per job with the job's
// Vet binding, its SDK operation checkpoints, the write-ahead record of each
// signature, the context the seller's Agreement step reads, or a quarantine
// marker. It is its own file next to the artifact journal, so its rows never
// take that journal's capacity or slow its scans, and a job's row can be
// deleted once its purchase ended.
//
// Every change is one IMMEDIATE transaction: read the row, apply a synchronous
// change, write or delete it. SQLite's write lock makes that atomic across
// processes that open the same file; no lock row is left behind by a process
// that dies. Each row carries a digest bound to this store's identity, so a
// row changed outside the store fails closed instead of reading as valid.
// Errors carry the durable journal's codes (journal-capacity, journal-busy,
// journal-integrity, journal-invalid). No key or secret is ever stored.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const PARTY_VET_STORE_FORMAT = 'dacs-party-vet-store';
export const PARTY_VET_STORE_VERSION = 1;
// A row holds one job until its purchase ends (or its approval window passed).
// A planned job's row is about 26 KB (docs/DEVNET-FIXED-PRICE-DEMO.md), so the
// job cap binds first.
export const PARTY_VET_STORE_LIMITS = Object.freeze({ maxJobs: 4096, maxValueBytes: 256 * 1024, maxTotalBytes: 256 * 1024 * 1024 });

class PartyVetStoreError extends Error {
  constructor(code, message, options) { super(message, options); this.code = code; }
}
const fail = (code, message, options) => { throw new PartyVetStoreError(code, message, options); };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const bounded = (name, value, min, max) => { if (!Number.isSafeInteger(value) || value < min || value > max) fail('journal-invalid', `${name} must be an integer from ${min} to ${max}`); return value; };
const checkKey = (key) => { if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 512 || key.includes('\0')) fail('journal-invalid', 'party Vet store keys are non-empty strings of at most 512 bytes'); return key; };
const encode = (value) => {
  const text = JSON.stringify(value);
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
  const usage = (rows = backend.totals()) => ({ jobs: rows.jobs, bytes: rows.bytes, maxJobs: limits.maxJobs, maxTotalBytes: limits.maxTotalBytes,
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
      if (typeof next?.then === 'function') fail('journal-invalid', 'party Vet store changes are synchronous');
      if (next === undefined) return current;
      if (next === null) { backend.remove(key); return null; }
      const text = encode(next), bytes = Buffer.byteLength(text);
      if (bytes > limits.maxValueBytes) fail('journal-capacity', `the party Vet store row exceeds ${limits.maxValueBytes} bytes; nothing was written`);
      const totals = backend.totals(), old = backend.size(key);
      if ((old === null ? totals.jobs + 1 : totals.jobs) > limits.maxJobs || totals.bytes - (old ?? 0) + bytes > limits.maxTotalBytes) fail('journal-capacity', 'the party Vet store is full; nothing was written');
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

// path: absolute. A missing file is a fresh store (created mode 0600); an
// existing one must be this format and intact.
export function openPartyVetStore({ path, busyTimeoutMs = 1000, ...options } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.startsWith('file:')) fail('journal-invalid', 'an explicit absolute party Vet store path is required');
  bounded('busyTimeoutMs', busyTimeoutMs, 0, 10_000);
  const limits = limitsFor(options);
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid())) fail('journal-invalid', 'the party Vet store must be a private regular file owned by this process user');
  let db;
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
    db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (db.prepare('PRAGMA journal_mode = WAL').get().journal_mode !== 'wal') fail('journal-error', 'WAL journal mode is unavailable for the party Vet store');
    db.exec('PRAGMA synchronous = FULL');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('journal-integrity', 'the party Vet store failed its integrity check');
    storeId = tx('BEGIN IMMEDIATE', () => {
      if (db.prepare('SELECT count(*) AS n FROM sqlite_schema').get().n === 0) {
        db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT');
        db.exec('CREATE TABLE jobs (key TEXT PRIMARY KEY, value TEXT NOT NULL, bytes INTEGER NOT NULL, digest TEXT NOT NULL) STRICT');
        const id = randomBytes(16).toString('hex'), insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
        for (const [key, value] of [['format', PARTY_VET_STORE_FORMAT], ['version', String(PARTY_VET_STORE_VERSION)], ['store_id', id]]) insert.run(key, value);
        return id;
      }
      let meta;
      try { meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((row) => [row.key, row.value])); } catch (error) { fail('journal-integrity', 'the party Vet store schema is absent or changed', { cause: error }); }
      if (meta.format !== PARTY_VET_STORE_FORMAT || meta.version !== String(PARTY_VET_STORE_VERSION) || !/^[a-f0-9]{32}$/.test(meta.store_id ?? '')) fail('journal-integrity', 'the party Vet store format, version or identity is not recognized');
      return meta.store_id;
    });
  } catch (error) { try { db?.close(); } catch { /* already failed */ } closed = true; throw translate(error); }
  const digest = (key, text) => sha256(`${PARTY_VET_STORE_FORMAT}\n${storeId}\n${key}\n${text}`);
  const decode = (row) => {
    if (row.digest !== digest(row.key, row.value) || row.bytes !== Buffer.byteLength(row.value)) fail('journal-integrity', 'a party Vet store row changed outside the store; nothing may be signed or sent');
    return JSON.parse(row.value);
  };
  const backend = {
    // Changes run in an IMMEDIATE transaction, reads in a deferred one.
    transaction: (fn) => tx('BEGIN IMMEDIATE', fn),
    snapshot: (fn) => tx('BEGIN', fn),
    get: (key) => { const row = db.prepare('SELECT key, value, bytes, digest FROM jobs WHERE key = ?').get(key); return row ? decode(row) : null; },
    size: (key) => db.prepare('SELECT bytes FROM jobs WHERE key = ?').get(key)?.bytes ?? null,
    totals: () => { const row = db.prepare('SELECT count(*) AS jobs, coalesce(sum(bytes), 0) AS bytes FROM jobs').get(); return { jobs: Number(row.jobs), bytes: Number(row.bytes) }; },
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
  const backend = {
    transaction: (fn) => {
      const before = new Map(rows);
      try { return fn(); } catch (error) { rows.clear(); for (const [key, value] of before) rows.set(key, value); throw error; }
    },
    snapshot: (fn) => fn(),
    get: (key) => (rows.has(key) ? JSON.parse(rows.get(key).text) : null),
    size: (key) => rows.get(key)?.bytes ?? null,
    totals: () => ({ jobs: rows.size, bytes: [...rows.values()].reduce((sum, row) => sum + row.bytes, 0) }),
    put: (key, text, bytes) => { rows.set(key, { text, bytes }); },
    remove: (key) => { rows.delete(key); },
    entries: () => [...rows.keys()].sort().map((key) => [key, JSON.parse(rows.get(key).text)]),
    close: () => {},
  };
  return Object.freeze(storeOver(backend, limits));
}
