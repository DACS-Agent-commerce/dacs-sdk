// A real SQLite connection in its own process, released by an IPC message so tests can line two
// processes up at the same step. Arguments: <store path> <action> <JSON input>. Actions: `issue`,
// `attempt`, and `issue-then-die` (SIGKILLs itself after the issuing transaction commits, before it answers).
import Database from 'better-sqlite3';
import { createSellerChallengeLedger } from '../../src/dacs/seller-challenge-ledger.mjs';

const [path, action, encoded] = process.argv.slice(2);
const { now, generation, request, scope } = JSON.parse(encoded);
const db = new Database(path);
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = FULL');

const transaction = (run) => {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    if (action === 'issue-then-die') process.kill(process.pid, 'SIGKILL');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
};
const ledger = createSellerChallengeLedger({
  db, transaction, generation, now: () => now, sessionState: () => null,
  admissionCounts: () => ({ contextRecords: 0, starts: 0, buyerStarts: () => 0 }), ready: () => true, stopped: () => false,
});

process.send('ready');
process.once('message', () => {
  let answer;
  try {
    answer = action === 'attempt' ? ledger.attempt(request) : ledger.issue(request, scope, { assertStillLive() {} });
  } catch (error) {
    answer = { code: error.code, status: error.status };
  }
  process.send(answer, () => process.exit(0));
});
