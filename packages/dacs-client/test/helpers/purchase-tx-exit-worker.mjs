// Exit the process inside or after one purchase transaction that spills pages.
import { DatabaseSync } from 'node:sqlite';
import { writeSync } from 'node:fs';
import { configure } from './purchase-tx-fixtures.mjs';
import { createSqlitePurchaseStore } from '../../src/seams/purchase-store-not-wired.mjs';

const [path, profile, stage] = process.argv.slice(2);
const db = new DatabaseSync(path);
configure(db, JSON.parse(profile));
db.exec('PRAGMA cache_size=10');
createSqlitePurchaseStore().transaction(db, () => {
  db.prepare('UPDATE records SET value=?').run('b'.repeat(10_000));
  if (stage === 'before-commit') {
    writeSync(1, 'TEST-before-commit');
    process.exit(0);
  }
});
writeSync(1, 'TEST-committed');
process.exit(0);
