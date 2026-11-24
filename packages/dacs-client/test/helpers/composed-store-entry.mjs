// Runs one offline harness suite on the purchase store a deployed buyer
// composes, in its own test process, and first checks that the harness modules
// the suite imports resolve to that store.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/** Register the composed store hooks, add the substitution check, then load `suite` (a URL). */
export async function runOnComposedStore(suite) {
  register(new URL('./composed-purchase-store-hooks.mjs', import.meta.url));
  const database = await import('./purchase-integrity-database.mjs');
  const operations = await import('./purchase-integrity-operations.mjs');
  test('the suite opens a state file in WAL with synchronous FULL and writes through the shipped operations store', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dacs-composed-store-')), db = database.openDatabase(join(dir, 'state.sqlite'));
    t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
    assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'meta'").get(), undefined, 'only the package schema is present');
    const ops = operations.createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8) });
    assert.throws(() => ops.createIdempotent({ kind: 'identity' }), { message: 'operation_kind_unsupported' }, 'the shipped store admits only purchases');
  });
  await import(suite.href);
}
