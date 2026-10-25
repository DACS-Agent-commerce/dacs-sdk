// Child process of the wallet journal's crash test: anchors the test evidence
// through the journal over the chain file, and kills itself (SIGKILL) at a
// cut: 'signed' inside signCreate once it signed (nothing kept yet), 'kept'
// when the journal broadcasts (the signed CREATE is kept, not sent), 'sent'
// once the broadcast landed (before the journal hears the answer).
// Usage: node payment-evidence-wallet-crash.mjs JOURNAL CHAIN_FILE CUT
import { createPaymentEvidenceWalletJournal } from '../../src/index.mjs';
import DatabaseSync from 'better-sqlite3';
import { evidenceInput, walletChain } from './payment-evidence-wallet-chain.mjs';

const [path, chainFile, cut] = process.argv.slice(2);
const node = walletChain({ file: chainFile });
const die = () => { process.kill(process.pid, 'SIGKILL'); return new Promise(() => {}); };
if (cut === 'initialize') {
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql, ...args) {
    if (/INSERT.*journal_meta/.test(sql)) process.kill(process.pid, 'SIGKILL');
    return prepare.call(this, sql, ...args);
  };
}
const journal = createPaymentEvidenceWalletJournal({ path,
  signCreate: async (input) => { const answer = await node.signCreate(input); if (cut === 'signed') await die(); return answer; },
  broadcast: async ({ txHash }) => { if (cut === 'kept') await die(); node.land(txHash); if (cut === 'sent') await die(); },
  readAccountNonce: async () => node.accountNonce(),
  readTransactionState: async ({ txHash }) => node.transactionState(txHash) });
await journal.anchorEvidence(evidenceInput(node.claim));
// Every cut kills the process before this line.
process.exit(3);
