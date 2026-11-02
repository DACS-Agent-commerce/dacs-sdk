// Crash the owner-checked journal after the caller's exact work is durable.
import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {createPaymentEvidenceWalletJournal} from '../../src/index.mjs';
import {evidenceInput,walletChain} from './payment-evidence-wallet-chain.mjs';
const [path,chainFile,checkpoint,cut]=process.argv.slice(2),node=walletChain({file:chainFile});
const die=()=>{process.kill(process.pid,'SIGKILL');return new Promise(()=>{});};
const journal=createPaymentEvidenceWalletJournal({path,
 signCreate:async input=>{const answer=await node.signCreate(input);if(cut==='signing')await die();return answer;},
 broadcast:async({txHash})=>{if(cut==='committed')await die();node.land(txHash);if(cut==='broadcast')await die();},
 readAccountNonce:async()=>node.accountNonce(),readTransactionState:async({txHash})=>node.transactionState(txHash)});
const work={...evidenceInput(node.claim),expectedJournalId:journal.journalId,attempt:{outcome:'unknown'}};
writeFileSync(checkpoint,JSON.stringify(work));const fd=openSync(checkpoint,'r');fsyncSync(fd);closeSync(fd);
if(cut==='checkpoint')await die();
await journal.ensureEvidence(JSON.parse(readFileSync(checkpoint,'utf8')));
if(cut==='answer')await die();
process.exit(3);
