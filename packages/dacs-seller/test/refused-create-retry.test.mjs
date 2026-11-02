// A CREATE the node refused is retried from its stored bytes while its nonce is free,
// and replaced by one new signature once the nonce has passed it and readback proves it never ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import {anchorFixture,signSdkCreate} from './helpers/anchor-isolated-fixture.mjs';
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX'];
const METHODS={
 publish:(anchor,input)=>anchor.publish(input),
 read:(anchor,input)=>anchor.read(input),
 readRetained:(anchor,input)=>anchor.readRetained(input),
};

// outcomes: what the wallet does on each request, in order.
//  refused: signs, journals the bytes, the node refuses the broadcast
//  refused-unsigned: reports a refusal without any journaled bytes
//  ambiguous: signs, journals the bytes, the outcome is unknown
//  accepted: signs, journals the bytes, the CREATE is included
//  crash-unsigned / crash-signed: the process dies before / after signing
async function refusedWorld(outcomes,{resendLands=false}={}){
 const w=await anchorFixture({signRpc:async()=> 'TEST rpc authentication'}),resends=[],signed=[],included=new Set();
 w.source.observeBinding=async()=>{};
 w.source.binding=async({hash})=>({disposition:included.has(hash)?'included':'absent'});
 w.source.recoverStorageWrite=async({signedTransaction})=>{resends.push(structuredClone(signedTransaction));if(resendLands)included.add(signedTransaction.hash);};
 w.controls.reader.read=async address=>{
  const row=[...w.journal.rows.values()].find(r=>r.input?.logicalAddress===address);
  return {status:'present',artifact:row.input.artifact,receipt:{contentHash:row.input.receiptContentHash,transactionRef:{value:'a'.repeat(64)}},demosEvidence:{}};
 };
 w.controls.reader.verifyReceipt=async()=> 'valid';
 w.controls.request=async request=>{
  const outcome=outcomes.shift();
  if(outcome==='crash-unsigned')throw new Error('TEST wallet died before signing');
  if(outcome==='refused-unsigned')return {success:false,error:{code:'broadcast_rejected'}};
  const signedTransaction=await signSdkCreate(request.transaction),{hash}=signedTransaction;
  signed.push(signedTransaction);
  const accepted=outcome==='accepted'||outcome==='crash-signed';
  await w.journal.put('demo/wallet/lane',{stage:accepted?'broadcast-accepted':'broadcast-started',hash,signedTransaction});
  await w.sourceJournal.put(`source/${hash}`,{stage:'signed',hash,signedTransaction});
  if(accepted)included.add(hash);
  if(outcome==='crash-signed')throw new Error('TEST wallet died after signing');
  if(outcome==='refused')return {success:false,error:{code:'broadcast_rejected'}};
  if(outcome==='ambiguous')return {success:false,error:{code:'internal_error'}};
  return {success:true,data:{hash}};
 };
 const artifactRow=job=>[...w.journal.rows.values()].find(row=>row.input?.artifact.jobId===job);
 return {...w,resends,signed,included,artifactRow,input:job=>artifactRow(job).input};
}
const requestedNonces=(w)=>w.captured.map(request=>request.transaction.content.nonce);

for(const [method,call] of Object.entries(METHODS))test(`${method} sends a refused CREATE's stored bytes again once while its nonce is free`,async()=>{
 const w=await refusedWorld(['refused'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);
 const [original]=w.signed,input=w.input(JOBS[0]);
 assert.equal((await call(w.open(),input)).status,'present');
 assert.deepEqual(w.resends,[original]);
 assert.equal((await call(w.open(),input)).status,'present');
 assert.equal(w.resends.length,1);assert.equal(w.captured.length,1);
});
for(const [method,call] of Object.entries(METHODS))test(`${method} resends a refused CREATE only once when the resend does not land`,async()=>{
 const w=await refusedWorld(['refused']);
 await w.publish(w.open(),JOBS[0]);
 const [original]=w.signed,input=w.input(JOBS[0]);
 for(let i=0;i<3;i++){
  const result=await call(w.open(),input);
  assert.equal(result.status,'rejected');assert.match(result.reason,/broadcast_rejected/);
 }
 assert.deepEqual(w.resends,[original]);assert.equal(w.captured.length,1);
 assert.equal((await w.artifactRow(JOBS[0])).stage,'rejected');
});
for(const method of ['read','readRetained'])test(`a passive ${method} never resends a refused CREATE`,async()=>{
 const w=await refusedWorld(['refused'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);
 for(let i=0;i<2;i++)assert.equal((await w.open()[method](w.input(JOBS[0]),{resend:false})).status,'rejected');
 assert.equal(w.resends.length,0);
});
test('publishing another artifact never resends a refused CREATE',async()=>{
 const w=await refusedWorld(['refused','ambiguous'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);
 await w.publish(w.open(),JOBS[1]);
 assert.equal(w.resends.length,0);assert.deepEqual(requestedNonces(w),[1,1]);
});
test('a refused CREATE is not resent while another signed CREATE holds its nonce',async()=>{
 const w=await refusedWorld(['refused','ambiguous'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);await w.publish(w.open(),JOBS[1]);
 assert.equal((await w.open().readRetained(w.input(JOBS[0]))).status,'rejected');
 assert.equal(w.resends.length,0);
});
for(const method of ['read','readRetained'])test(`${method} on a refused CREATE fails closed with the nonce read's cause`,async()=>{
 const w=await refusedWorld(['refused'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=null;
 await assert.rejects(w.open()[method](w.input(JOBS[0])),{code:'indeterminate'});
 assert.equal(w.resends.length,0);
 assert.equal((await w.open()[method](w.input(JOBS[0]),{resend:false})).status,'rejected');
});
test('publish on a refused CREATE fails closed with the nonce read\'s cause and asks nothing',async()=>{
 const w=await refusedWorld(['refused','accepted'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=null;
 await assert.rejects(w.publish(w.open(),JOBS[0]),{code:'indeterminate'});
 assert.equal(w.captured.length,1);assert.equal(w.resends.length,0);
});
test('a retained wallet CREATE row without a hash still fences publishing another artifact',async()=>{
 const w=await refusedWorld(['accepted']);
 w.controls.nonce=5;
 await w.journal.put('demo/wallet/lane',{stage:'broadcast-started',signedTransaction:{content:{from:w.owner,nonce:1,type:'storageProgram'}}});
 await assert.rejects(w.publish(w.open(),JOBS[1]),/differs from its original public projection/);
 assert.equal(w.captured.length,0);
});

test('a refused CREATE whose nonce passed is replaced by exactly one new signature, then answered from the new row',async()=>{
 const w=await refusedWorld(['refused','accepted']);
 await w.publish(w.open(),JOBS[0]);
 const [original]=w.signed;w.controls.nonce=1;
 const result=await w.publish(w.open(),JOBS[0]);
 assert.equal(result.status,'present');
 assert.equal(w.captured.length,2);assert.deepEqual(requestedNonces(w),[1,2]);assert.equal(w.resends.length,0);
 assert.equal(w.artifactRow(JOBS[0]).supersedes.hash,original.hash);
 for(let i=0;i<3;i++)assert.equal((await w.publish(w.open(),JOBS[0])).status,'present');
 assert.equal((await w.open().readRetained(w.input(JOBS[0]))).status,'present');
 assert.equal(w.captured.length,2);assert.equal(w.signed.length,2);
});
for(const method of ['read','readRetained'])test(`${method} on a refused CREATE whose nonce passed neither asks the wallet nor replaces the row`,async()=>{
 const w=await refusedWorld(['refused','accepted']);
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=1;
 for(let i=0;i<2;i++)assert.equal((await w.open()[method](w.input(JOBS[0]))).status,'rejected');
 assert.equal(w.captured.length,1);assert.equal(w.resends.length,0);
 assert.equal(w.artifactRow(JOBS[0]).stage,'rejected');assert.equal(w.artifactRow(JOBS[0]).supersedes,undefined);
});
test('a refused CREATE whose nonce passed is not replaced while its readback is not a complete absence',async()=>{
 const w=await refusedWorld(['refused','accepted']);
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=1;
 w.source.binding=async()=>({disposition:'pending'});
 for(let i=0;i<2;i++)assert.equal((await w.publish(w.open(),JOBS[0])).status,'indeterminate');
 assert.equal(w.captured.length,1);assert.equal(w.resends.length,0);
});
test('a refused CREATE found included late is answered from its own bytes with no new signature',async()=>{
 const w=await refusedWorld(['refused','accepted']);
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=1;w.included.add(w.signed[0].hash);
 assert.equal((await w.publish(w.open(),JOBS[0])).status,'present');
 assert.equal(w.captured.length,1);assert.equal(w.resends.length,0);
});
test('an ambiguous signed CREATE whose nonce passed stays fenced: no resend, no new signature',async()=>{
 const w=await refusedWorld(['ambiguous','accepted']);
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=1;
 for(let i=0;i<2;i++)assert.equal((await w.publish(w.open(),JOBS[0])).status,'indeterminate');
 await assert.rejects(w.publish(w.open(),JOBS[1]),/requires readback|nonce RPC has not caught up/);
 assert.equal(w.captured.length,1);assert.equal(w.resends.length,0);
});
test('a refusal with no retained signed bytes has nothing to resend or prove and stays fenced',async()=>{
 const w=await refusedWorld(['refused-unsigned','accepted'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=1;
 assert.equal((await w.publish(w.open(),JOBS[0])).status,'indeterminate');
 assert.equal(w.captured.length,1);assert.equal(w.resends.length,0);
});
test('a replacement that is refused too stays rejected: the wallet is asked once',async()=>{
 const w=await refusedWorld(['refused','refused','accepted']);
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=1;
 assert.equal((await w.publish(w.open(),JOBS[0])).status,'indeterminate');
 w.controls.nonce=2;
 for(let i=0;i<3;i++)assert.equal((await w.publish(w.open(),JOBS[0])).status,'rejected');
 assert.equal(w.captured.length,2);assert.equal(w.resends.length,0);
 assert.equal(w.artifactRow(JOBS[0]).stage,'rejected');
});
test('a wallet that dies before signing the replacement is asked again from the same replacement row',async()=>{
 const w=await refusedWorld(['refused','crash-unsigned','accepted']);
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=1;
 await assert.rejects(w.publish(w.open(),JOBS[0]),/died before signing/);
 assert.equal(w.artifactRow(JOBS[0]).stage,'intent');
 assert.equal((await w.publish(w.open(),JOBS[0])).status,'present');
 assert.deepEqual(requestedNonces(w),[1,2,2]);assert.equal(w.signed.length,2);
});
test('a wallet that dies after signing the replacement is not asked again',async()=>{
 const w=await refusedWorld(['refused','crash-signed','accepted']);
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=1;
 await assert.rejects(w.publish(w.open(),JOBS[0]),/died after signing/);
 assert.equal((await w.publish(w.open(),JOBS[0])).status,'present');
 assert.equal(w.captured.length,2);assert.equal(w.signed.length,2);
});
