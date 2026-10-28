import { DatabaseSync } from 'node:sqlite';
import { createSqlitePurchaseStore } from '../../src/seams/purchase-store-not-wired.mjs';
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA synchronous=FULL');
createSqlitePurchaseStore().transaction(db, () => {
  db.prepare('INSERT INTO records VALUES (?)').run('TEST-first');
  db.prepare('INSERT INTO records VALUES (?)').run('TEST-second');
  if (process.argv[3] === 'before-commit') process.exit(0);
});
process.exit(0);
