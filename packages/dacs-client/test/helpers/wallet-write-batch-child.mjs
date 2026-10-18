import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';

const {createWalletWriteBatch}=await import(process.env.DACS_BATCH_TEST_MODULE?pathToFileURL(process.env.DACS_BATCH_TEST_MODULE).href:new URL('../../src/wallet/write-batch.mjs',import.meta.url).href);
const journal=openDurableWalletJournal({path:process.argv[2],mode:'open'});
const wallet=`0x${'51'.repeat(32)}`;
const checkpoint=process.argv[3] ?? 'journaled';
const lane=JSON.stringify(['offline-batch','fake-chain',wallet]);
const sent=[];
async function pause(event) {
  if(checkpoint!==event)return;
  process.send({event,writes:3,sent});
  await new Promise(()=>{});
}
const wrapped={...journal,put:async(key,value)=>{
  const initial=key===lane&&value.writes.every(write=>write.disposition==='indeterminate');
  if(initial)await pause('before-journal');
  await journal.put(key,value);
  if(initial){await pause('journaled');await pause('after-journal');}
  if(key===lane){
    const acknowledged=value.writes.filter(write=>write.disposition==='submitted').length;
    if(acknowledged===1)await pause('after-ack-1');
    if(acknowledged===2)await pause('mid-batch');
  }
  if(key.startsWith('wallet-batch/'))await pause('after-archive');
}};
const api=createWalletWriteBatch({journal:wrapped,network:'offline-batch',chainIdentity:'fake-chain',wallet,
  readNonce:async()=>10,
  sign:async(transaction)=>({content:transaction.content,hash:createHash('sha256').update(JSON.stringify(transaction.content)).digest('hex'),signature:{type:'fake-public-test-signature',data:'offline'}}),
  verifySigned:async()=>true,
  broadcast:async({nonce,hash})=>{
    if(sent.length===0)await pause('before-first-broadcast');
    sent.push(nonce);if(sent.length===1)await pause('after-send-1');
    return {disposition:'submitted',hash};
  },
  readback:async({hash,nonce})=>({disposition:'included',wallet,hash,nonce,proof:'fake-inclusion'}),verifyIncluded:async({observation})=>observation.proof==='fake-inclusion'});
await api.submit({batchId:'first',step:'delivery',writes:Array.from({length:3},(_,index)=>({content:{from:wallet,nonce:11+index,data:['storageProgram',{artifact:index}]}}))});
await api.reconcile({batchId:'first'});
throw new Error(`unreached crash checkpoint: ${checkpoint}`);
