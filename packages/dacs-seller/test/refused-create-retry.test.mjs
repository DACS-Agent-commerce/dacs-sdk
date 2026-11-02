// A CREATE the node refused is retried from its stored bytes while its nonce is free,
// and replaced by one new signature once the nonce has passed it and readback proves it never ran.
import test from 'node:test';
import assert from 'node:assert/strict';
import {anchorFixture,signSdkCreate} from './helpers/anchor-isolated-fixture.mjs';
import {isDeadRefusedCreate} from '../src/dacs/native-dem-delivery-consumer.mjs';
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX'];
// A resend is on only where the caller passes the check in.
const allowResend=()=>({resend:true,authorizeResend:async()=>true});
const METHODS={
 publish:(anchor,input)=>anchor.publish({...input,authorize:async()=>true}),
 read:(anchor,input)=>anchor.read(input,allowResend()),
 readRetained:(anchor,input)=>anchor.readRetained(input,allowResend()),
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
 assert.equal((await w.open().readRetained(w.input(JOBS[0]),allowResend())).status,'rejected');
 assert.equal(w.resends.length,0);
});
for(const method of ['read','readRetained'])test(`${method} on a refused CREATE fails closed with the nonce read's cause`,async()=>{
 const w=await refusedWorld(['refused'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=null;
 await assert.rejects(w.open()[method](w.input(JOBS[0]),allowResend()),{code:'indeterminate'});
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
 for(let i=0;i<2;i++)assert.equal((await w.open()[method](w.input(JOBS[0]),allowResend())).status,'rejected');
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

// Resend authorization: the caller's check is asked fresh, right before the bytes are sent.
const countedCheck=(answer)=>{const check=async()=>{check.calls++;return typeof answer==='function'?answer():answer;};check.calls=0;return check;};
for(const method of ['read','readRetained'])test(`${method} with default options never sends a refused CREATE again`,async()=>{
 const w=await refusedWorld(['refused'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);
 for(let i=0;i<2;i++)assert.equal((await w.open()[method](w.input(JOBS[0]))).status,'rejected');
 assert.equal(w.resends.length,0);
});
for(const method of ['read','readRetained'])test(`${method} with a resend and no authorization check is refused before anything is sent`,async()=>{
 const w=await refusedWorld(['refused'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);
 const result=await w.open()[method](w.input(JOBS[0]),{resend:true});
 assert.equal(result.status,'rejected');assert.match(result.reason,/authorization/);
 assert.equal(w.resends.length,0);
});
for(const method of ['read','readRetained'])test(`${method} sends a refused CREATE again only after its authorization check passes, asked once at send time`,async()=>{
 const w=await refusedWorld(['refused'],{resendLands:true}),authorizeResend=countedCheck(true);
 await w.publish(w.open(),JOBS[0]);
 assert.equal((await w.open()[method](w.input(JOBS[0]),{resend:true,authorizeResend})).status,'present');
 assert.equal(authorizeResend.calls,1);assert.equal(w.resends.length,1);
});
for(const method of ['read','readRetained'])test(`${method} sends nothing when the authorization check refuses, and a later passing check still sends once`,async()=>{
 const w=await refusedWorld(['refused'],{resendLands:true}),refuse=countedCheck(false);
 await w.publish(w.open(),JOBS[0]);
 for(let i=0;i<2;i++)assert.equal((await w.open()[method](w.input(JOBS[0]),{resend:true,authorizeResend:refuse})).status,'rejected');
 assert.equal(refuse.calls,2);assert.equal(w.resends.length,0);
 assert.equal((await w.open()[method](w.input(JOBS[0]),allowResend())).status,'present');
 assert.equal(w.resends.length,1);
});
for(const method of ['read','readRetained'])test(`${method} sends nothing when the authorization check throws, and keeps its cause`,async()=>{
 const w=await refusedWorld(['refused'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);
 const lost=countedCheck(()=>{throw Object.assign(new Error('TEST purchase cancelled'),{code:'purchase_cancelled'});});
 await assert.rejects(w.open()[method](w.input(JOBS[0]),{resend:true,authorizeResend:lost}),{code:'purchase_cancelled'});
 assert.equal(w.resends.length,0);
 assert.equal((await w.open()[method](w.input(JOBS[0]),allowResend())).status,'present');
 assert.equal(w.resends.length,1);
});
test('a check that answers anything but true sends nothing',async()=>{
 const w=await refusedWorld(['refused'],{resendLands:true});
 await w.publish(w.open(),JOBS[0]);
 for(const answer of [undefined,'yes',1,{}])await w.open().readRetained(w.input(JOBS[0]),{resend:true,authorizeResend:countedCheck(answer)});
 assert.equal(w.resends.length,0);
});
test('publish on a retained refused CREATE sends it again only through its authorize check',async()=>{
 const w=await refusedWorld(['refused'],{resendLands:true}),authorize=countedCheck(false);
 await w.publish(w.open(),JOBS[0]);
 assert.equal((await w.open().publish(w.input(JOBS[0]))).status,'rejected');
 assert.equal(w.resends.length,0);
 assert.equal((await w.open().publish({...w.input(JOBS[0]),authorize})).status,'rejected');
 assert.equal(authorize.calls,1);assert.equal(w.resends.length,0);
 assert.equal((await w.open().publish({...w.input(JOBS[0]),authorize:countedCheck(true)})).status,'present');
 assert.equal(w.resends.length,1);assert.equal(w.captured.length,1);
});
test('publish on an accepted CREATE that is not yet readable never sends it again without an authorize check',async()=>{
 const w=await refusedWorld(['accepted']);
 w.source.binding=async()=>({disposition:'pending'});
 await w.publish(w.open(),JOBS[0]);
 assert.equal(w.resends.length,0);
});

// A resend slot is used only by bytes that were sent.
const slotWorld=async(answers)=>{
 const w=await refusedWorld(['refused']);
 w.source.recoverStorageWrite=async({signedTransaction})=>{
  const answer=answers.shift();w.resends.push(structuredClone(signedTransaction));
  if(answer.lands)w.included.add(signedTransaction.hash);
  return answer.report;
 };
 await w.publish(w.open(),JOBS[0]);
 return w;
};
for(const method of ['read','readRetained'])test(`${method}: a refused CREATE whose resend was reported unsent keeps its one resend`,async()=>{
 const w=await slotWorld([{report:{disposition:'pending',resent:false}},{lands:true}]);
 assert.equal((await w.open()[method](w.input(JOBS[0]),allowResend())).status,'rejected');
 assert.equal((await w.open()[method](w.input(JOBS[0]),allowResend())).status,'present');
 assert.equal(w.resends.length,2);
});
for(const method of ['read','readRetained'])test(`${method}: a refused CREATE whose resend was sent uses its one resend`,async()=>{
 const w=await slotWorld([{report:{disposition:'pending',resent:true}},{lands:true}]);
 for(let i=0;i<3;i++)assert.equal((await w.open()[method](w.input(JOBS[0]),allowResend())).status,'rejected');
 assert.equal(w.resends.length,1);
});
test('a resend whose outcome is not reported counts as sent',async()=>{
 const w=await slotWorld([{report:undefined},{lands:true}]);
 for(let i=0;i<3;i++)await w.open().readRetained(w.input(JOBS[0]),allowResend());
 assert.equal(w.resends.length,1);
});
test('a resend that throws counts as sent',async()=>{
 const w=await slotWorld([{report:undefined},{lands:true}]);
 w.source.recoverStorageWrite=async()=>{w.resends.push('thrown');throw new Error('TEST transport died');};
 await assert.rejects(w.open().readRetained(w.input(JOBS[0]),allowResend()),/transport died/);
 await w.open().readRetained(w.input(JOBS[0]),allowResend());
 assert.equal(w.resends.length,1);
});

// A refused CREATE the node can no longer include is answered `rejected` as before, and marked: the marked answer
// (never a copy of it) is the callers' proof that publishing it again cannot make a second CREATE.
for(const method of ['read','readRetained'])test(`${method} marks a refused CREATE whose nonce passed and whose readback is absent as dead, and sends nothing`,async()=>{
 const w=await refusedWorld(['refused','accepted']);
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=1;
 const result=await w.open()[method](w.input(JOBS[0]),allowResend());
 assert.equal(result.status,'rejected');assert.equal(isDeadRefusedCreate(result),true);
 assert.equal(isDeadRefusedCreate({...result}),false,'a copy confers no proof');
 assert.equal(w.captured.length,1);assert.equal(w.resends.length,0);assert.equal(w.artifactRow(JOBS[0]).stage,'rejected');
});
test('a refused CREATE whose nonce is still free is not marked dead',async()=>{
 const w=await refusedWorld(['refused']);
 await w.publish(w.open(),JOBS[0]);
 const result=await w.open().readRetained(w.input(JOBS[0]),{resend:false});
 assert.equal(result.status,'rejected');assert.equal(isDeadRefusedCreate(result),false);
});
test('a refused CREATE whose nonce passed is not marked dead while its readback is pending',async()=>{
 const w=await refusedWorld(['refused']);
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=1;w.source.binding=async()=>({disposition:'pending'});
 const result=await w.open().readRetained(w.input(JOBS[0]),{resend:false});
 assert.equal(result.status,'indeterminate');assert.equal(isDeadRefusedCreate(result),false);
});
test('a replacement that was refused too is never marked dead: the wallet is asked once',async()=>{
 const w=await refusedWorld(['refused','refused','accepted']);
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=1;
 await w.publish(w.open(),JOBS[0]);w.controls.nonce=2;
 const result=await w.open().readRetained(w.input(JOBS[0]),{resend:false});
 assert.equal(result.status,'rejected');assert.equal(isDeadRefusedCreate(result),false);
 assert.equal(w.captured.length,2);
});

// R1: once the refused bytes were sent again, the account nonce passing the CREATE's nonce no longer proves another
// transaction took it: the resend may have. A replacement needs the complete-index rule of the wallet journal's fate():
// the nonce snapshot's block height, and an absence checked through at least that block.
const indexAbsentThrough=(w,block)=>{w.source.binding=async({hash})=>w.included.has(hash)?{disposition:'included'}:{disposition:'absent',...(block===undefined?{}:{checkedThroughBlock:block})};};
const resentRefusedWorld=async()=>{
 const w=await refusedWorld(['refused','accepted']);
 await w.publish(w.open(),JOBS[0]);
 await w.open().readRetained(w.input(JOBS[0]),allowResend());
 assert.equal(w.resends.length,1,'the refused bytes were sent again');
 return w;
};
test('a resend that lands after the replacement check signs no replacement',async()=>{
 const w=await resentRefusedWorld();
 w.controls.nonce=1;
 for(let i=0;i<2;i++)assert.equal((await w.publish(w.open(),JOBS[0])).status,'indeterminate');
 assert.equal(w.captured.length,1,'no second signature while the index may not show the resend');
 w.included.add(w.signed[0].hash);
 assert.equal((await w.publish(w.open(),JOBS[0])).status,'present');
 assert.equal(w.captured.length,1);assert.equal(w.artifactRow(JOBS[0]).supersedes,undefined);
});
test('a resent refused CREATE is not marked dead while the index is not proven complete',async()=>{
 const w=await resentRefusedWorld();
 w.controls.nonce=1;
 const result=await w.open().readRetained(w.input(JOBS[0]),{resend:false});
 assert.equal(result.status,'indeterminate');assert.equal(isDeadRefusedCreate(result),false);
});
for(const [label,nonce,through] of [['an index behind the nonce snapshot',{nonce:1,blockHeight:10},9],['an index that reports no height',{nonce:1,blockHeight:10},undefined],['a nonce with no block height',1,10]])
 test(`a resent refused CREATE is not replaced on ${label}`,async()=>{
  const w=await resentRefusedWorld();
  w.controls.nonce=nonce;indexAbsentThrough(w,through);
  assert.equal((await w.publish(w.open(),JOBS[0])).status,'indeterminate');
  assert.equal(w.captured.length,1);
 });
test('a resent refused CREATE is replaced once when the index is complete past the nonce',async()=>{
 const w=await resentRefusedWorld();
 w.controls.nonce={nonce:1,blockHeight:10};indexAbsentThrough(w,10);
 assert.equal(isDeadRefusedCreate(await w.open().readRetained(w.input(JOBS[0]),{resend:false})),true);
 assert.equal((await w.publish(w.open(),JOBS[0])).status,'present');
 assert.deepEqual(requestedNonces(w),[1,2]);assert.equal(w.artifactRow(JOBS[0]).supersedes.hash,w.signed[0].hash);
 assert.equal((await w.publish(w.open(),JOBS[0])).status,'present');assert.equal(w.captured.length,2);
});
for(const [label,nonce] of [['an extra field',{nonce:1,blockHeight:10,extra:1}],['a negative height',{nonce:1,blockHeight:-1}],['a height that is not a number',{nonce:1,blockHeight:'10'}],['no nonce',{blockHeight:10}],['a list',[1,10]]])
 test(`a nonce reply with ${label} proves nothing: the refused CREATE is neither marked dead nor replaced`,async()=>{
  const w=await refusedWorld(['refused','accepted']);
  await w.publish(w.open(),JOBS[0]);w.controls.nonce=nonce;
  await assert.rejects(w.publish(w.open(),JOBS[0]),{code:'indeterminate'});
  const result=await w.open().readRetained(w.input(JOBS[0]),{resend:false});
  assert.equal(result.status,'rejected');assert.equal(isDeadRefusedCreate(result),false);
  assert.equal(w.captured.length,1);
 });
test('a resend the transport reported never dispatched leaves the bare absence rule in force',async()=>{
 const w=await refusedWorld(['refused','accepted']);
 w.source.recoverStorageWrite=async({signedTransaction})=>{w.resends.push(signedTransaction.hash);return {resent:false};};
 await w.publish(w.open(),JOBS[0]);
 await w.open().readRetained(w.input(JOBS[0]),allowResend());
 w.controls.nonce=1;
 assert.equal(isDeadRefusedCreate(await w.open().readRetained(w.input(JOBS[0]),{resend:false})),true);
});
