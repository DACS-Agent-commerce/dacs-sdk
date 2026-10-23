// EXPLICIT durable public wallet journal (node:sqlite). Opt-in only: nothing in
// application configuration constructs it. It stores public signed intents,
// approvals and receipts; it never holds a key, mnemonic, password or vault.
// Interface: async get(key), put(key, value), entries(), withWalletLock(key, work).
//
// Locks are rows in the same database, shared by every process that opens the
// same file. A lock is released only by its own holder after its work settles.
// A dead or stalled holder is NEVER timed out: others see a bounded busy error.
// Lane records are never deleted, so an issued/unknown stage keeps fencing even
// after an operator explicitly removes an abandoned lock row.
import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const DURABLE_WALLET_JOURNAL_FORMAT = 'dacs-durable-wallet-journal';
export const DURABLE_WALLET_JOURNAL_VERSION = 1;

export class DurableWalletJournalError extends Error {
  constructor(code, message, options) { super(message, options); this.code = code; }
}
const fail = (code, message, options) => { throw new DurableWalletJournalError(code, message, options); };
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bounded = (name, v, min, max) => { if (!Number.isSafeInteger(v) || v < min || v > max) fail('journal-invalid', `${name} must be an integer from ${min} to ${max}`); return v; };

const SCHEMA = [
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
  'CREATE TABLE records (key TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, value TEXT NOT NULL, digest TEXT NOT NULL, bytes INTEGER NOT NULL) STRICT',
  'CREATE TABLE locks (key TEXT PRIMARY KEY, token TEXT NOT NULL, instance TEXT NOT NULL, pid INTEGER NOT NULL, fence INTEGER NOT NULL, acquired_at TEXT NOT NULL) STRICT',
];

// Exact JSON only: the wallet compares JSON.stringify(readback) with what it
// wrote, so key order is preserved and anything JSON would alter is refused.
function exactJson(value) {
  const seen = new Set();
  const walk = (v, depth) => {
    if (depth > 64) fail('journal-invalid', 'record nesting exceeds 64 levels');
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return;
    if (typeof v === 'number') { if (!Number.isFinite(v) || Object.is(v, -0)) fail('journal-invalid', 'record numbers must be finite JSON numbers'); return; }
    if (typeof v !== 'object') fail('journal-invalid', `record contains a non-JSON ${typeof v}`);
    if (seen.has(v)) fail('journal-invalid', 'record contains a cycle or shared reference');
    seen.add(v);
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i += 1) { if (!Object.hasOwn(v, i)) fail('journal-invalid', 'record arrays must be dense'); walk(v[i], depth + 1); }
    } else {
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) fail('journal-invalid', 'record objects must be plain JSON objects');
      if (Object.getOwnPropertySymbols(v).length) fail('journal-invalid', 'record objects must not have symbol keys');
      for (const k of Object.keys(v)) { if (v[k] === undefined) fail('journal-invalid', `record field ${JSON.stringify(k)} is undefined`); walk(v[k], depth + 1); }
    }
    seen.delete(v);
  };
  walk(value, 0);
  return JSON.stringify(value);
}

function translate(error) {
  if (error instanceof DurableWalletJournalError) return error;
  const text = String(error?.message ?? error);
  if (/database is locked|SQLITE_BUSY|database table is locked/i.test(text)) return new DurableWalletJournalError('journal-busy', 'the journal database is busy; nothing was changed', { cause: error });
  if (/not a database|malformed|corrupt|SQLITE_CORRUPT|SQLITE_NOTADB/i.test(text)) return new DurableWalletJournalError('journal-integrity', 'the journal database is not intact; nothing may be sent', { cause: error });
  return new DurableWalletJournalError('journal-error', 'the journal operation failed; nothing may be sent', { cause: error });
}

// mode 'create' requires an absent file; mode 'open' requires an existing,
// intact journal. An absent journal is never silently recreated, because that
// would forget issued lanes.
export function openDurableWalletJournal({ path, mode, expectedJournalId, lockTimeoutMs = 2000, pollMs = 20, busyTimeoutMs = 1000,
  maxRecords = 4096, maxKeyBytes = 512, maxValueBytes = 256 * 1024, maxTotalBytes = 32 * 1024 * 1024 } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || path.startsWith('file:')) fail('journal-invalid', 'an explicit absolute caller-owned database path is required');
  if (mode !== 'create' && mode !== 'open') fail('journal-invalid', "mode must be explicitly 'create' or 'open'");
  if (expectedJournalId !== undefined && (typeof expectedJournalId !== 'string' || !/^[a-f0-9]{32}$/.test(expectedJournalId))) fail('journal-invalid', 'expected journal id is malformed');
  bounded('lockTimeoutMs', lockTimeoutMs, 0, 60_000); bounded('pollMs', pollMs, 5, 1000); bounded('busyTimeoutMs', busyTimeoutMs, 0, 10_000);
  bounded('maxRecords', maxRecords, 1, 1_000_000); bounded('maxKeyBytes', maxKeyBytes, 16, 4096);
  bounded('maxValueBytes', maxValueBytes, 64, 16 * 1024 * 1024); bounded('maxTotalBytes', maxTotalBytes, maxValueBytes, 1024 * 1024 * 1024);
  const present = existsSync(path);
  if (mode === 'create' && present) fail('journal-exists', 'create refuses an existing database path');
  if (mode === 'open' && !present) fail('journal-absent', 'the durable journal is absent; it is not recreated');

  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (db.prepare('PRAGMA journal_mode = WAL').get().journal_mode !== 'wal') fail('journal-error', 'WAL journal mode is unavailable for this path');
    db.exec('PRAGMA synchronous = FULL');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('journal-integrity', 'the journal database failed its integrity check');
  } catch (error) { try { db?.close(); } catch { /* already failed */ } throw translate(error); }

  let closed = false;
  function tx(kind, fn) {
    if (closed) fail('journal-closed', 'the journal is closed');
    try {
      db.exec(kind);
      try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { try { db.exec('ROLLBACK'); } catch { /* connection already rolled back */ } throw error; }
    } catch (error) { throw translate(error); }
  }

  let journalId;
  try {
    journalId = tx('BEGIN IMMEDIATE', () => {
      if (mode === 'create') {
        if (db.prepare("SELECT count(*) AS n FROM sqlite_schema").get().n !== 0) fail('journal-exists', 'create found an existing schema');
        for (const statement of SCHEMA) db.exec(statement);
        const id = randomBytes(16).toString('hex');
        const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
        for (const [k, v] of [['format', DURABLE_WALLET_JOURNAL_FORMAT], ['version', String(DURABLE_WALLET_JOURNAL_VERSION)], ['journal_id', id], ['records', '0'], ['total_bytes', '0'], ['next_seq', '1'], ['fence', '0']]) insert.run(k, v);
        return id;
      }
      let rows;
      try { rows = db.prepare('SELECT key, value FROM meta').all(); } catch (error) { fail('journal-integrity', 'the journal schema is absent or changed', { cause: error }); }
      const meta = Object.fromEntries(rows.map((r) => [r.key, r.value]));
      if (meta.format !== DURABLE_WALLET_JOURNAL_FORMAT || meta.version !== String(DURABLE_WALLET_JOURNAL_VERSION) || !/^[a-f0-9]{32}$/.test(meta.journal_id ?? '')) fail('journal-integrity', 'the journal format, version or identity is not recognized');
      if (expectedJournalId !== undefined && meta.journal_id !== expectedJournalId) fail('journal-integrity', 'the journal identity differs from the expected journal');
      return meta.journal_id;
    });
  } catch (error) { try { db.close(); } catch { /* already failed */ } closed = true; throw error; }

  const instance = randomBytes(16).toString('hex');
  const held = new AsyncLocalStorage();
  let active = 0;
  const digest = (key, text) => sha256(`${DURABLE_WALLET_JOURNAL_FORMAT}\n${journalId}\n${key}\n${text}`);
  const checkKey = (key) => {
    if (typeof key !== 'string' || !key || Buffer.byteLength(key) > maxKeyBytes || key.includes('\0')) fail('journal-invalid', `journal keys must be non-empty strings of at most ${maxKeyBytes} bytes`);
    return key;
  };

  // Every read verifies identity, row count/bytes and each row digest. A
  // changed, moved or removed row fails closed instead of reading as absent.
  function meta() {
    const m = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
    if (m.format !== DURABLE_WALLET_JOURNAL_FORMAT || m.version !== String(DURABLE_WALLET_JOURNAL_VERSION) || m.journal_id !== journalId) fail('journal-integrity', 'the journal format, version or identity changed');
    const totals = db.prepare('SELECT count(*) AS n, coalesce(sum(bytes), 0) AS bytes, coalesce(max(seq), 0) AS seq FROM records').get();
    if (String(totals.n) !== m.records || String(totals.bytes) !== m.total_bytes || totals.seq >= Number(m.next_seq)) fail('journal-integrity', 'journal record totals changed outside this journal');
    return m;
  }
  function decode(row) {
    if (row.digest !== digest(row.key, row.value) || row.bytes !== Buffer.byteLength(row.value)) fail('journal-integrity', 'a journal record changed outside this journal; nothing may be sent');
    try { return JSON.parse(row.value); } catch (error) { fail('journal-integrity', 'a journal record is not JSON', { cause: error }); }
  }

  async function get(key) {
    checkKey(key);
    return tx('BEGIN', () => {
      meta();
      const row = db.prepare('SELECT key, value, digest, bytes FROM records WHERE key = ?').get(key);
      return row ? decode(row) : undefined;
    });
  }

  async function entries() {
    return tx('BEGIN', () => {
      meta();
      return db.prepare('SELECT key, value, digest, bytes FROM records ORDER BY seq').all().map((row) => [row.key, decode(row)]);
    });
  }

  // A key locked by another holder may not be written; a holder whose lock
  // row was removed is fenced. The check and write are one IMMEDIATE commit.
  async function put(key, value) {
    checkKey(key);
    const text = exactJson(value);
    const bytes = Buffer.byteLength(text);
    if (bytes > maxValueBytes) fail('journal-capacity', `record exceeds ${maxValueBytes} bytes; nothing was written`);
    const mine = held.getStore()?.get(key);
    tx('BEGIN IMMEDIATE', () => {
      const m = meta();
      const lock = db.prepare('SELECT token FROM locks WHERE key = ?').get(key);
      if (mine ? lock?.token !== mine : lock) fail('journal-fenced', mine ? 'this holder no longer owns the wallet lane lock; nothing was written' : 'another holder owns this key; nothing was written');
      const old = db.prepare('SELECT bytes FROM records WHERE key = ?').get(key);
      const records = Number(m.records) + (old ? 0 : 1);
      const total = Number(m.total_bytes) - (old?.bytes ?? 0) + bytes;
      if (records > maxRecords || total > maxTotalBytes) fail('journal-capacity', 'journal record capacity is exhausted; nothing was written');
      if (old) db.prepare('UPDATE records SET value = ?, digest = ?, bytes = ? WHERE key = ?').run(text, digest(key, text), bytes, key);
      else {
        db.prepare('INSERT INTO records (key, seq, value, digest, bytes) VALUES (?, ?, ?, ?, ?)').run(key, Number(m.next_seq), text, digest(key, text), bytes);
        db.prepare("UPDATE meta SET value = ? WHERE key = 'next_seq'").run(String(Number(m.next_seq) + 1));
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'records'").run(String(records));
      db.prepare("UPDATE meta SET value = ? WHERE key = 'total_bytes'").run(String(total));
    });
  }

  async function withWalletLock(key, work) {
    checkKey(key);
    if (typeof work !== 'function') fail('journal-invalid', 'lock work must be a function');
    const outer = held.getStore() ?? new Map();
    // Same-key reentry is unsupported (existing in-memory journals deadlock);
    // it fails at once instead of waiting. Distinct nested keys are supported.
    if (outer.has(key)) fail('journal-reentrant', 'this context already holds this wallet lane; reentrant locking is unsupported');
    const token = randomBytes(16).toString('hex');
    const deadline = Date.now() + lockTimeoutMs;
    for (;;) {
      let acquired = false;
      try {
        acquired = tx('BEGIN IMMEDIATE', () => {
          const m = meta();
          // A lane whose own record changed is never handed to new work.
          const row = db.prepare('SELECT key, value, digest, bytes FROM records WHERE key = ?').get(key);
          if (row) decode(row);
          if (db.prepare('SELECT 1 FROM locks WHERE key = ?').get(key)) return false;
          const fence = Number(m.fence) + 1;
          db.prepare('INSERT INTO locks (key, token, instance, pid, fence, acquired_at) VALUES (?, ?, ?, ?, ?, ?)').run(key, token, instance, process.pid, fence, new Date().toISOString());
          db.prepare("UPDATE meta SET value = ? WHERE key = 'fence'").run(String(fence));
          return true;
        });
      } catch (error) { if (error.code !== 'journal-busy') throw error; }
      if (acquired) break;
      if (Date.now() >= deadline) fail('journal-busy', 'the wallet lane is held by another holder; no work was started');
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    active += 1;
    let outcome;
    try { outcome = { value: await held.run(new Map(outer).set(key, token), work) }; } catch (error) { outcome = { error }; }
    // Release happens only after this holder's work has settled. Failure to
    // release leaves the lane held (fail closed) and is reported to the caller.
    try {
      const removed = tx('BEGIN IMMEDIATE', () => db.prepare('DELETE FROM locks WHERE key = ? AND token = ?').run(key, token).changes);
      if (removed !== 1) fail('journal-fenced', 'the wallet lane lock was removed while held; results must be reconciled by readback', Object.hasOwn(outcome, 'error') ? { cause: outcome.error } : undefined);
    } finally { active -= 1; }
    if (Object.hasOwn(outcome, 'error')) throw outcome.error;
    return outcome.value;
  }

  function inspectLocks() {
    return tx('BEGIN', () => db.prepare('SELECT key, instance, pid, fence, acquired_at FROM locks ORDER BY fence').all()
      .map((r) => ({ key: r.key, instance: r.instance, pid: r.pid, fence: r.fence, acquiredAt: r.acquired_at, thisInstance: r.instance === instance })));
  }

  // Explicit operator action after independently establishing that the holder
  // process is gone. It removes only mutual exclusion; records are untouched,
  // so an issued or unknown lane stage still refuses every new payload.
  function releaseAbandonedLock({ key, instance: holder, fence } = {}) {
    checkKey(key);
    if (holder === instance) fail('journal-lock-live', 'this live journal instance owns the lock');
    return tx('BEGIN IMMEDIATE', () => {
      meta();
      if (db.prepare('DELETE FROM locks WHERE key = ? AND instance = ? AND fence = ?').run(key, holder, fence).changes !== 1) fail('journal-lock-mismatch', 'no lock row matches this exact key, holder and fence');
      return { released: true, recordsChanged: 0 };
    });
  }

  function close() {
    if (closed) return;
    if (active > 0) fail('journal-busy', 'the journal has active wallet lane work');
    closed = true;
    db.close();
  }

  return { journalId, instance, path, get, put, entries, withWalletLock, inspectLocks, releaseAbandonedLock, close };
}
