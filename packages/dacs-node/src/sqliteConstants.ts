/**
 * SQLite schema constants that need no database driver. They live apart from
 * `sqlite.ts` so the package root can read them without loading the optional
 * `better-sqlite3` dependency; `./sqlite` re-exports both.
 */
export const DACS_NODE_SQLITE_SCHEMA_VERSION = 8 as const;
export const DACS_NODE_SQLITE_APPLICATION_ID = 0x44414353 as const;
