// The one place purchase transaction tests choose journaling. Every profile is
// a configuration purchase admission accepts; refusal tests change it explicitly.
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSqlitePurchaseStore } from '../../src/seams/purchase-store-not-wired.mjs';

const MAIN_PROFILES = [
  { journal: 'DELETE', synchronous: 'EXTRA' }, { journal: 'TRUNCATE', synchronous: 'EXTRA' },
  { journal: 'PERSIST', synchronous: 'EXTRA' }, { journal: 'WAL', synchronous: 'FULL' },
  { journal: 'WAL', synchronous: 'EXTRA' }, { journal: 'MEMORY', volatile: true },
];
export const TEMP_JOURNALS = Object.freeze(['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY']);
export const PROFILES = Object.freeze(MAIN_PROFILES.flatMap(main => TEMP_JOURNALS.map(temp => Object.freeze({ ...main, temp }))));
export const FILE_PROFILES = Object.freeze(PROFILES.filter(profile => !profile.volatile && profile.temp === 'DELETE'));
export const DEFAULT_PROFILE = PROFILES.find(profile => profile.journal === 'WAL' && profile.synchronous === 'FULL' && profile.temp === 'DELETE');
export const label = profile => `${profile.journal}${profile.volatile ? ' volatile' : `/${profile.synchronous}`}, TEMP ${profile.temp}`;

/** Apply a profile to one connection; synchronous is a per-connection setting. */
export function configure(db, { journal, synchronous, temp }) {
  db.exec(`PRAGMA journal_mode=${journal}; PRAGMA temp.journal_mode=${temp}`);
  if (synchronous) db.exec(`PRAGMA synchronous=${synchronous}`);
}

/** Open a configured database, removed when the test ends. */
export function purchaseDatabase(t, profile = DEFAULT_PROFILE, { schema = 'CREATE TABLE records (id TEXT PRIMARY KEY)', Database = DatabaseSync } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-purchase-tx-')), path = join(dir, 'state.sqlite');
  const db = new Database(profile.volatile ? ':memory:' : path);
  configure(db, profile);
  db.exec(schema);
  t.after(() => { try { db.close(); } catch { /* Retired handles are already closed. */ } rmSync(dir, { recursive: true, force: true }); });
  return { db, dir, path, store: createSqlitePurchaseStore() };
}

/** Read ids from a fresh connection, or from db itself for a volatile database. */
export function durableIds(db, path, profile = DEFAULT_PROFILE, table = 'records') {
  const reader = profile.volatile ? db : new DatabaseSync(path);
  try { return reader.prepare(`SELECT id FROM ${table} ORDER BY id`).all().map(row => row.id); }
  finally { if (reader !== db) reader.close(); }
}

/** Hide isTransaction, as on the oldest supported Node versions. */
export class LegacyDatabase extends DatabaseSync {
  get isTransaction() { return undefined; }
}
