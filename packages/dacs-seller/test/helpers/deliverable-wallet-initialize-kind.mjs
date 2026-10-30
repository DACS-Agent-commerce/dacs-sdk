// Deterministically release two first-open probes of different journal kinds
// after both observed no schema: neither may mix its table into the other's file.
import { parentPort, workerData } from 'node:worker_threads';
import DatabaseSync from 'better-sqlite3';
import { createDeliverableWalletJournal, createPaymentEvidenceWalletJournal } from '../../src/index.mjs';

const barrier = new Int32Array(workerData.barrier);
const prepare = DatabaseSync.prototype.prepare;
let first = true;
DatabaseSync.prototype.prepare = function (sql, ...args) {
  const statement = prepare.call(this, sql, ...args);
  if (first && /sqlite_master/.test(sql) && /name = 'journal_meta'/.test(sql)) {
    first = false;
    const get = statement.get;
    statement.get = function (...parameters) {
      const result = get.apply(this, parameters);
      parentPort.postMessage({ ready: true });
      Atomics.wait(barrier, 0, 0);
      return result;
    };
  }
  return statement;
};
const make = workerData.kind === 'deliverable' ? createDeliverableWalletJournal : createPaymentEvidenceWalletJournal;
try {
  const journal = make({ path: workerData.path,
    signCreate() {}, broadcast() {}, readAccountNonce() { return 0; }, readTransactionState() { return 'absent'; } });
  parentPort.postMessage({ journalId: journal.journalId });
  journal.close();
} catch (error) { parentPort.postMessage({ error: error.message }); }
