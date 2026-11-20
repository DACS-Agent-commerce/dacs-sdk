// Runs the removal of the obsolete transport tables on the database at `argv[2]` and kills this process with SIGKILL at `argv[3]`:
// `before-commit` (the tables are dropped inside the open transaction) or `after-commit` (the removal is durable).
import DatabaseSync from 'better-sqlite3';
import { dropEmptyObsoleteTables } from '../../src/dacs/seller-obsolete-store-tables.mjs';

const [, , path, cut] = process.argv;
const db = new DatabaseSync(path);
db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL');
const killed = new Proxy(db, {
  get(target, key) {
    if (key === 'exec') {
      return (sql) => {
        if (sql === 'COMMIT' && cut === 'before-commit') process.kill(process.pid, 'SIGKILL');
        const result = target.exec(sql);
        if (sql === 'COMMIT' && cut === 'after-commit') process.kill(process.pid, 'SIGKILL');
        return result;
      };
    }
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
dropEmptyObsoleteTables(killed, process.argv[4]);
