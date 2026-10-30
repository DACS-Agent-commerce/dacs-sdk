import test from 'node:test';
import assert from 'node:assert/strict';
import {anchorFixture,signSdkCreate} from './helpers/anchor-isolated-fixture.mjs';
const jobs=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX'];
async function world({sourceCopy=false,refused=false}={}){
 const w=await anchorFixture({signRpc:async()=> 'TEST rpc authentication'}),resends=[];
 let included=false;
 w.source.observeBinding=async()=>{};
 w.source.binding=async()=>({disposition:included?'included':refused?'absent':'pending'});
 w.source.recoverStorageWrite=async({signedTransaction})=>{resends.push(structuredClone(signedTransaction));included=true;};
 w.controls.reader.read=async address=>{
  const row=[...w.journal.rows.values()].find(r=>r.input?.logicalAddress===address);
  return {status:'present',artifact:row.input.artifact,receipt:{contentHash:row.input.receiptContentHash,transactionRef:{value:'a'.repeat(64)}},demosEvidence:{}};
 };
 w.controls.reader.verifyReceipt=async()=> 'valid';
 w.controls.request=async request=>{
  const signedTransaction=await signSdkCreate(request.transaction);
  const row={stage:'broadcast-started',hash:signedTransaction.hash,signedTransaction};
  await w.journal.put('demo/wallet/lane',row);
  if(sourceCopy)await w.sourceJournal.put(`source/${request.jobId}`,row);
  if(refused)return {success:false,error:{code:'broadcast_rejected'}};
  throw new Error('TEST interrupted before source journal');
 };
 return {...w,resends,include:()=>included=true};
}
for(const method of ['read','readRetained','publish'])for(const sourceCopy of [false,true])test(`${method} recovers original signed bytes from ${sourceCopy?'both journals':'the wallet alone'} after restart`,async()=>{
 const w=await world({sourceCopy});
 await assert.rejects(w.publish(w.open(),jobs[0]),/interrupted/);
 const original=(await w.journal.get('demo/wallet/lane')).signedTransaction;
 const input=[...w.journal.rows.values()].find(r=>r.input).input;
 assert.equal((await w.open()[method](input)).status,'present');
 assert.deepEqual(w.resends,[original]);assert.equal(w.captured.length,1);
 assert.equal((await w.open()[method](input)).status,'present');
 assert.equal(w.resends.length,1);
});
for(const sourceCopy of [false,true])test(`a refused ${sourceCopy?'source and wallet':'wallet-only'} CREATE frees the wallet lane for another job and retains its original bytes`,async()=>{
 const w=await world({sourceCopy,refused:true});
 await w.publish(w.open(),jobs[0]);
 const original=(await w.journal.get('demo/wallet/lane')).signedTransaction;
 assert.equal((await w.publish(w.open(),jobs[1])).status,'indeterminate');
 assert.equal(w.captured.length,2);assert.deepEqual(w.captured.map(r=>r.transaction.content.nonce),[1,1]);
 const prior=[...w.journal.rows.values()].find(r=>r.input?.artifact.jobId===jobs[0]);
 assert.deepEqual(prior.signedTransaction,original);
 assert.equal((await w.open().readRetained(prior.input)).status,'rejected');
 assert.equal(w.resends.length,0);
});
test('a broadcast refusal can authenticate late inclusion without another wallet request or resend',async()=>{
 const w=await world({refused:true});await w.publish(w.open(),jobs[0]);w.include();
 const input=[...w.journal.rows.values()].find(r=>r.input).input;
 assert.equal((await w.open().readRetained(input)).status,'present');
 assert.equal(w.resends.length,0);assert.equal(w.captured.length,1);
});
test('an unknown wallet-only signed outcome keeps the lane while retaining the original projection',async()=>{
 const w=await world();await assert.rejects(w.publish(w.open(),jobs[0]),/interrupted/);
 w.source.binding=async()=>({disposition:'indeterminate'});
 await assert.rejects(w.publish(w.open(),jobs[1]),{code:'indeterminate'});
 assert.equal(w.captured.length,1);assert.equal(w.resends.length,0);
});

test('a wallet-only refused CREATE found included keeps the nonce floor until RPC catches up',async()=>{
 const w=await world({refused:true});await w.publish(w.open(),jobs[0]);w.include();
 await assert.rejects(w.publish(w.open(),jobs[1]),/nonce RPC has not caught up/);
 assert.equal(w.captured.length,1);
 w.controls.nonce=1;await w.publish(w.open(),jobs[1]);assert.equal(w.captured[1].transaction.content.nonce,2);
});

for (const sourceCopy of [false, true]) for (const code of ['stale_plan', 'upstream_unavailable']) test(`a refused CREATE does not make an unsigned ${code} successor issued (${sourceCopy})`, async () => {
 const w = await world({sourceCopy, refused: true});
 await w.publish(w.open(), jobs[0]);
 w.controls.request = async () => ({success: false, error: {code}});
 await w.publish(w.open(), jobs[1]);
 const input = [...w.journal.rows.values()].find(r => r.input?.artifact.jobId === jobs[1]);
 assert.equal(input.stage, 'unsigned');
 await w.publish(w.open(), jobs[1]);
 assert.equal(w.captured.length, 3);
});
