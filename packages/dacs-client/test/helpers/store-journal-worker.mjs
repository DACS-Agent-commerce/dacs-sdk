import { DatabaseSync } from 'node:sqlite';
import { writeSync } from 'node:fs';
import { createSqlitePurchaseStore } from '../../src/seams/purchase-store-not-wired.mjs';
const db = new DatabaseSync(process.argv[2]);
db.exec(`PRAGMA journal_mode=${process.argv[3]}; PRAGMA synchronous=${process.argv[3] === 'WAL' ? 'FULL' : 'EXTRA'}; PRAGMA cache_size=10`);
try {
  createSqlitePurchaseStore().transaction(db, () => {
    db.prepare('UPDATE records SET value=?').run('b'.repeat(10_000));
    writeSync(1, 'TEST-before-commit');
    process.exit(0);
  });
  throw new Error('TEST-missing-process-exit');
} catch (error) {
  if (error.code !== 'purchase_store_unsupported_journal_mode') throw error;
  writeSync(1, 'TEST-refused');
}
db.close();
