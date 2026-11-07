// Child process of the wallet journal's survival test, with no unhandled-rejection trap of a test runner:
// a kept CREATE that another write of the wallet overtook is checked again, and the job's authorization is
// withdrawn while the wallet reads the account nonce. Prints { signs, code }; an unhandled rejection ends it with exit code 1.
// Usage: node payment-evidence-authorization-withdrawn.mjs JOURNAL
import { createPaymentEvidenceWalletJournal } from '../../src/index.mjs';
import { evidenceInput, walletChain } from './payment-evidence-wallet-chain.mjs';

const [path] = process.argv.slice(2);
const node = walletChain();
let signs = 0, authorized = true, withdrawOnRead = false;
const journal = createPaymentEvidenceWalletJournal({ path,
  signCreate: async (input) => { signs++; return node.signCreate(input); },
  // The node drops every broadcast, so the first CREATE stays kept and is overtaken by the other writes.
  broadcast: async () => {},
  readAccountNonce: async () => { if (withdrawOnRead) authorized = false; return { nonce: node.accountNonce(), blockHeight: node.accountNonce() }; },
  readTransactionState: async ({ txHash }) => ({ state: node.transactionState(txHash), checkedThroughBlock: node.accountNonce() }) });
const first = await journal.anchorEvidence(evidenceInput(node.claim));
node.other();
node.other();
withdrawOnRead = true;
let code = null;
try {
  await journal.ensureEvidence({ ...evidenceInput(node.claim), expectedJournalId: journal.journalId, attempt: { outcome: 'sent', answer: first }, authorize: () => authorized });
} catch (error) { code = error.code; }
// Let a rejection nobody handles surface before the answer is printed.
await new Promise((resolve) => setImmediate(resolve));
process.stdout.write(JSON.stringify({ signs, code }));
