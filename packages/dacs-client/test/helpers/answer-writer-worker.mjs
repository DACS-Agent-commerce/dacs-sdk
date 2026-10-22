// Another process on the same purchase database: on request it takes the
// write lock, stores a newer retained seller answer, holds the lock for a
// while, then commits. Only test data crosses IPC.
import { DatabaseSync } from 'node:sqlite';

const [path, id] = process.argv.slice(2);
const db = new DatabaseSync(path);
db.exec('PRAGMA busy_timeout = 5000');
process.on('message', ({ answer, holdMs }) => {
  db.exec('BEGIN IMMEDIATE');
  db.prepare("UPDATE operations SET state = json_set(state, '$.protocol.sellerAnswer', json(?)) WHERE id = ?").run(JSON.stringify(answer), id);
  process.send('locked');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
  db.exec('COMMIT');
  db.close();
  process.send('committed', () => process.disconnect());
});
