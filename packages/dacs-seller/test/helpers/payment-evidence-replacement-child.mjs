// Unshipped test child: replaces a kept payment-evidence CREATE the chain proves will never execute, through a journal that
// approves ahead over the stand-in wallet chain kept in CHAIN_FILE, and is killed (SIGKILL) at CUT:
//   update   right after the supersession UPDATE of the kept row runs, inside the writer lock's transaction;
//   insert   right after the successor's INSERT runs, inside the same transaction;
//   kept     at the successor's send, after the transaction committed and before anything is sent.
// Usage: node payment-evidence-replacement-child.mjs CUT JOURNAL_PATH CHAIN_FILE
import DatabaseSync from 'better-sqlite3';
import { approvingChainJournal } from './payment-evidence-test-journals.mjs';
import { evidenceInput, walletChain } from './payment-evidence-wallet-chain.mjs';

const [cut, path, chainFile] = process.argv.slice(2);
const die = () => process.kill(process.pid, 'SIGKILL');
const KILLED_AFTER = { update: /^UPDATE evidence_creates SET superseded_at/, insert: /^INSERT INTO evidence_creates / };
if (KILLED_AFTER[cut]) {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function prepareThenDie(sql, ...rest) {
    const statement = Reflect.apply(prepare, this, [sql, ...rest]);
    if (KILLED_AFTER[cut].test(sql)) {
      const run = statement.run;
      statement.run = function runThenDie(...args) { Reflect.apply(run, this, args); return die(); };
    }
    return statement;
  };
}
const wallet = walletChain({ file: chainFile });
const journal = approvingChainJournal(path, wallet, { onSend: cut === 'kept' ? die : undefined });
await journal.ensureEvidence({ ...evidenceInput(wallet.claim), expectedJournalId: journal.journalId, authorize: () => true });
// Every cut that reaches this line missed it.
process.exit(3);
