// Rehosted native recovery assertions; no portal/browser or live wallet needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import {anchorFixture} from './helpers/anchor-isolated-fixture.mjs';
import {isProvenUnsignedAbsence} from '../src/dacs/native-dem-delivery-consumer.mjs';
import {seller} from './helpers/protocol-fixture.mjs';
import {fixtureListing} from './fixtures/listings.mjs';
import {assertQualifiedDeployment} from '../src/devnet-demo/deployment-qualification.mjs';
import {classifyStorageWriteSubmission,storageWriteAbsent,storageWriteConfirmationMatches,storageWriteAccountNonce,rpcEnvelope} from '../src/devnet-demo/storage-write-recovery.mjs';
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX'];
test('an observed source nonce fences stale RPC preparation, including a restarted anchor',async()=>{
 const w=await anchorFixture();await w.sourceJournal.put('included',{stage:'observed',hash:'a'.repeat(64),signedTransaction:{content:{from:w.owner,nonce:1,type:'storageProgram'}}});
 for(const anchor of [w.open(),w.open()])await assert.rejects(w.publish(anchor,JOBS[0]),/nonce RPC has not caught up/);
 assert.equal(w.captured.length,0);assert.equal(w.journal.rows.size,0);
});
test('different artifacts serialize nonce reservations and retain the floor across restart',async()=>{
 const w=await anchorFixture(),anchor=w.open();
 w.controls.request=async request=>{await w.journal.put('demo/wallet/signed',{stage:'signed',hash:'a'.repeat(64),signedTransaction:request.transaction});return {success:false,error:{code:'internal_error'}};};
 const results=await Promise.allSettled(JOBS.map(id=>w.publish(anchor,id)));
 assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(w.captured.length,1);assert.equal(w.captured[0].transaction.content.nonce,1);
 await assert.rejects(w.publish(w.open(),JOBS[1]),/nonce RPC has not caught up/);assert.equal(w.captured.length,1);
 w.controls.nonce=1;await w.journal.put('demo/wallet/signed',{stage:'broadcast-accepted',signedTransaction:w.captured[0].transaction});
 assert.equal((await w.publish(w.open(),JOBS[1])).status,'indeterminate');assert.equal(w.captured[1].transaction.content.nonce,2);
});
test('dirty, unidentified, unverified or partially qualified deployments authorize no wallet request',async()=>{
 const w=await anchorFixture();
 for(const pin of [null,{...w.source.pins.deployment,dirty:true},{...w.source.pins.deployment,artifactSha256:null},{...w.source.pins.deployment,qualifiedOperations:['nonce']}]){
  const source={...w.source,pins:{...w.source.pins,deployment:pin}};await assert.rejects(assertQualifiedDeployment(source),{code:'deployment_unqualified'});
 }
 w.source.verifyDeployment=async()=>false;await assert.rejects(w.publish(w.open(),JOBS[0]),{code:'deployment_unqualified'});assert.equal(w.captured.length,0);
});
test('a clean verified deployment at another source commit authorizes no native intent or wallet request',async()=>{
 const w=await anchorFixture();let verified=0;
 w.source.pins.deployment.commit='c'.repeat(40);w.source.verifyDeployment=async()=>{verified++;return true};
 await assert.rejects(w.publish(w.open(),JOBS[0]),{code:'deployment_unqualified'});
 assert.equal(verified,0);assert.equal(w.captured.length,0);assert.equal(w.journal.rows.size,0);
});
test('relay acknowledgement is not transaction inclusion and unknown status does not prove absence',()=>{
 const hash='a'.repeat(64),relay={result:200,response:{message:'Transaction relayed to validators'},require_reply:false,extra:null};
 const result=classifyStorageWriteSubmission(relay,hash);assert.notEqual(result?.disposition,'included');
 assert.equal(storageWriteAbsent({result:200,response:{state:'unknown'},require_reply:false,extra:''}),false);
});

for(const code of ['internal_error','capture-without-signing','broadcast_rejected'])test(`${code} before inclusion releases the nonce for a different artifact without RPC advancement`,async()=>{
 const w=await anchorFixture();w.controls.request=async()=>({success:false,error:{code}});
 assert.equal((await w.publish(w.open(),JOBS[0])).status,'indeterminate');
 assert.equal((await w.publish(w.open(),JOBS[1])).status,'indeterminate');
 assert.deepEqual(w.captured.map(r=>r.transaction.content.nonce),[1,1]);
});
test('a definitive signed broadcast rejection preserves its matching wallet journal floor',async()=>{
 const w=await anchorFixture();w.controls.request=async request=>{
  await w.journal.put('demo/wallet/rejected',{stage:'broadcast-started',signedTransaction:request.transaction});
  await w.sourceJournal.put('source/rejected',{stage:'signed',hash:'c'.repeat(64),signedTransaction:request.transaction});
  return {success:false,error:{code:'broadcast_rejected'}};
 };
 await w.publish(w.open(),JOBS[0]);
 await assert.rejects(w.publish(w.open(),JOBS[1]),/nonce RPC has not caught up/);
 assert.equal(w.captured.length,1);
});

const retainedReads={
 read:(anchor,input)=>anchor.read(input),
 readRetained:(anchor,input)=>anchor.readRetained(input),
 publish:(anchor,input)=>anchor.publish(input),
};
async function signedFailureWorld(code='broadcast_rejected'){
 const w=await anchorFixture({signRpc:async()=> 'rpc-auth'}),resends=[];
 w.source.binding=async()=>({disposition:'pending'});
 w.source.recoverStorageWrite=async({signedTransaction})=>resends.push(structuredClone(signedTransaction));
 w.controls.request=async request=>{
  const hash=(request.jobId===JOBS[0]?'c':'d').repeat(64),signedTransaction=structuredClone({...request.transaction,hash});
  signedTransaction.content.gcr_edits={TEST:'signed SDK edits'};
  await w.journal.put(`demo/wallet/${request.jobId}`,{stage:'broadcast-started',hash,signedTransaction});
  await w.sourceJournal.put(`source/${request.jobId}`,{stage:'signed',hash,signedTransaction});
  return {success:false,error:{code}};
 };
 await w.publish(w.open(),JOBS[0]);
 const [key,row]=[...w.journal.rows].find(([key])=>key.startsWith('demo/artifact/'));
 return {...w,key,input:row.input,resends};
}
for(const [method,read] of Object.entries(retainedReads))test(`a rejected signed CREATE stays rejected through ${method}, retries and reopened anchors`,async()=>{
 const w=await signedFailureWorld();
 for(let i=0;i<3;i++){
  const result=await read(w.open(),w.input);
  assert.equal(result.status,'rejected');assert.match(result.reason,/broadcast_rejected/);assert.equal(result.noResend,true);
  assert.equal((await w.journal.get(w.key)).stage,'rejected');
 }
 assert.equal(w.captured.length,1);assert.equal(w.resends.length,0);
 await assert.rejects(w.publish(w.open(),JOBS[1]),/nonce RPC has not caught up/);
 assert.equal(w.captured.length,1);
});
test('a rejection already promoted by an older retained read still fences both nonce journals',async()=>{
 const w=await signedFailureWorld(),row=await w.journal.get(w.key);
 await w.journal.put(w.key,{...row,stage:'issued',hash:'c'.repeat(64)});
 for(const read of Object.values(retainedReads))assert.equal((await read(w.open(),w.input)).status,'rejected');
 await assert.rejects(w.publish(w.open(),JOBS[1]),/nonce RPC has not caught up/);
 assert.equal(w.captured.length,1);assert.equal(w.resends.length,0);
});
for(const [method,read] of Object.entries(retainedReads))test(`an ambiguous signed CREATE remains fenced after ${method} and restart`,async()=>{
 const w=await signedFailureWorld('internal_error');
 assert.equal((await read(w.open(),w.input)).status,'indeterminate');
 await assert.rejects(w.publish(w.open(),JOBS[1]),/retained seller source transaction requires readback/);
 assert.equal(w.captured.length,1);assert.equal(w.resends.length,1);
 assert.deepEqual(w.resends[0],(await w.sourceJournal.get(`source/${JOBS[0]}`)).signedTransaction);
});
for(const method of ['read','readRetained'])test(`${method} waits for an in-flight publisher's definitive outcome`,async()=>{
 const w=await anchorFixture({signRpc:async()=> 'rpc-auth'});
 let requested,finish,bindingCalls=0,resends=0;
 const inWallet=new Promise(resolve=>requested=resolve),answer=new Promise(resolve=>finish=resolve);
 w.source.binding=async()=>{bindingCalls++;return {disposition:'pending'};};
 w.source.recoverStorageWrite=async()=>{resends++;};
 w.controls.request=async request=>{
  const hash='c'.repeat(64),signedTransaction={...request.transaction,hash};
  await w.journal.put('demo/wallet/rejected',{stage:'broadcast-started',hash,signedTransaction});
  await w.sourceJournal.put('source/rejected',{stage:'signed',hash,signedTransaction});
  requested();await answer;
  return {success:false,error:{code:'broadcast_rejected'}};
 };
 const publication=w.publish(w.open(),JOBS[0]);await inWallet;
 const [key,row]=[...w.journal.rows].find(([key])=>key.startsWith('demo/artifact/'));
 const observation=retainedReads[method](w.open(),row.input);
 // Let the read reach the journal while the wallet answer is still pending.
 await new Promise(resolve=>setImmediate(resolve));
 const callsWhilePending=bindingCalls;finish();
 await publication;const result=await observation;
 assert.equal(callsWhilePending,0);assert.equal(result.status,'rejected');assert.equal(resends,0);
 assert.equal((await w.journal.get(key)).stage,'rejected');
 await assert.rejects(w.publish(w.open(),JOBS[1]),/nonce RPC has not caught up/);assert.equal(w.captured.length,1);
});
test('a source writer arriving between reservation scan and intent cannot enter the shared wallet lane',async()=>{
 const w=await anchorFixture(),put=w.journal.put;let other,entered=false;
 w.journal.put=async(key,value)=>{
  if(!other&&key.startsWith('demo/artifact/'))other=w.source.withWalletNonceLock({owner:w.owner,network:'local-only',chainIdentity:'local-only'},async()=>{
   entered=true;
   await w.sourceJournal.put('other',{stage:'observed',signedTransaction:{content:{from:w.owner,nonce:w.controls.nonce+1}}});
  });
  return put(key,value);
 };
 w.controls.request=async()=>{assert.equal(entered,false);w.controls.nonce=1;return {success:false,error:{code:'internal_error'}};};
 await w.publish(w.open(),JOBS[0]);await other;
 assert.equal(entered,true);assert.equal(w.captured[0].transaction.content.nonce,1);
 assert.equal((await w.sourceJournal.get('other')).signedTransaction.content.nonce,2);
});
test('a host without a shared source-wallet lane cannot request a new CREATE',async()=>{
 const w=await anchorFixture();delete w.source.withWalletNonceLock;
 await assert.rejects(w.publish(w.open(),JOBS[0]),{code:'nonce_lane_unavailable'});assert.equal(w.captured.length,0);
});
test('retained readback never resends through an unqualified deployment; qualified recovery preserves original bytes',async()=>{
 const w=await anchorFixture({signRpc:async()=> 'rpc-auth'}),resends=[];
 w.source.binding=async()=>({disposition:'pending'});
 w.source.recoverStorageWrite=async({signedTransaction})=>resends.push(structuredClone(signedTransaction));
 await w.publish(w.open(),JOBS[0]);
 const [key,row]=[...w.journal.rows].find(([key])=>key.startsWith('demo/artifact/'));
 const signedTransaction={...row.transaction,hash:'c'.repeat(64),content:{...row.transaction.content,type:'storageProgram'}};
 await w.journal.put(key,{...row,stage:'issued',hash:signedTransaction.hash});
 await w.sourceJournal.put('original',{stage:'signed',hash:signedTransaction.hash,signedTransaction});
 w.source.pins.deployment.dirty=true;
 await assert.rejects(w.open().readRetained({logicalAddress:row.input.logicalAddress,artifactKind:row.input.artifactKind}),{code:'deployment_unqualified'});
 assert.equal(resends.length,0);assert.equal(w.captured.length,1);
 w.source.pins.deployment.dirty=false;
 assert.equal((await w.open().readRetained({logicalAddress:row.input.logicalAddress,artifactKind:row.input.artifactKind})).status,'indeterminate');
 for(let i=0;i<3;i++)await w.open().readRetained({logicalAddress:row.input.logicalAddress,artifactKind:row.input.artifactKind});
 assert.deepEqual(resends,[signedTransaction],'at most one resend, including provider restart');assert.equal(w.captured.length,1,'recovery never asks the transaction wallet again');
});

test('RPC submission and absence envelopes require exact fields and matching transaction hashes',()=>{
 const hash='a'.repeat(64),ok={result:200,response:{hash},require_reply:false,extra:null};
 assert.equal(classifyStorageWriteSubmission(ok,hash),'accepted');
 for(const answer of [{...ok,result:400},{...ok,require_reply:true},{...ok,extra:{}},{...ok,response:{hash:'b'.repeat(64)}},{...ok,response:{hash,error:'failed'}},{...ok,response:null},{...ok,unexpected:true}])assert.equal(classifyStorageWriteSubmission(answer,hash),'unknown');
 const status={result:200,response:{state:'unknown'},require_reply:false,extra:''},absent={result:400,response:'error',require_reply:false,extra:null};
 assert.equal(storageWriteAbsent(status,absent),true);
 for(const other of [{...absent,result:200},{...absent,extra:''},{...absent,require_reply:true},{...absent,response:{error:true}},{...absent,unexpected:true}])assert.equal(storageWriteAbsent(status,other),false);
 assert.equal(storageWriteAbsent({...status,response:{state:'pending'}},absent),false);
 assert.equal(rpcEnvelope({...ok,extra:undefined},200,null),false);
 for(const n of [-1,'01','1.0',Number.MAX_SAFE_INTEGER+1,{},null])assert.equal(storageWriteAccountNonce(n),null);
 assert.equal(storageWriteAccountNonce('12'),12);
});
test('confirmation envelopes reject incomplete or malformed node signatures and confirmation projections',()=>{
 const response={data:{valid:true,reference_block:1,message:'ok',gas_operation:null,transaction:{}},signature:{type:'ed25519',data:'0x'+'a'.repeat(128)},rpc_public_key:{type:'ed25519',data:'0x'+'b'.repeat(64)}};
 assert.equal(storageWriteConfirmationMatches(response),true);
 for(const mutate of [r=>{r.data.valid=false},r=>{r.data.reference_block=-1},r=>{r.data.gas_operation={}},r=>{delete r.signature},r=>{r.signature.data='0x01'},r=>{r.rpc_public_key.type='other'},r=>{r.data.unexpected=true}]){const changed=structuredClone(response);mutate(changed);assert.equal(storageWriteConfirmationMatches(changed),false);}
});

test('an uncoordinated source journal change after the first scan refuses before the wallet request',async()=>{
 const w=await anchorFixture(),put=w.journal.put;let inserted=false;
 w.journal.put=async(key,value)=>{
  if(!inserted&&key.startsWith('demo/artifact/')){inserted=true;await w.sourceJournal.put('uncoordinated',{stage:'signed',hash:'f'.repeat(64),signedTransaction:{content:{from:w.owner,nonce:1,type:'storageProgram'}}});}
  return put(key,value);
 };
 await assert.rejects(w.publish(w.open(),JOBS[0]),/source wallet nonce lane changed/);assert.equal(w.captured.length,0);
 assert.equal([...w.journal.rows.values()].find(row=>row.transaction).stage,'unsigned');
});

// A held native Deliverable is asked again only on the reader's proven absence
// (README: the delivery capability's contract). publish stores its intent before
// it asks the wallet to sign, so an address with no intent and no signed CREATE
// retained anywhere was never signed; every other absence stays plain.
test('a read of an address that was never asked of the wallet proves the absence; one with a retained signed CREATE or an unknown outcome does not',async()=>{
 const w=await anchorFixture(),anchor=w.open(),jobId=JOBS[0],logicalAddress=core.finalityCommitmentAddress(jobId);
 const read=async()=>anchor.read({logicalAddress,artifact:await w.artifact(jobId),artifactKind:'FinalityCommitmentRecord'});
 const signedFor={stage:'signed',hash:'a'.repeat(64),signedTransaction:{content:{from:w.owner,nonce:1,data:['storageProgram',{metadata:{logicalAddress}}]}}};
 const never=await read();
 assert.equal(never.status,'absent');assert.equal(isProvenUnsignedAbsence(never),true,'no intent, no signed CREATE retained: proven unsigned');
 assert.equal(w.captured.length,0);
 // A signed CREATE for this address retained by the wallet, whose intent row is gone: not proven.
 await w.journal.put('demo/wallet/signed',signedFor);
 const lost=await read();
 assert.equal(lost.status,'absent');assert.notEqual(isProvenUnsignedAbsence(lost),true,'a retained signed CREATE for the address is no proof');
 // The source's own journal retains one: not proven either.
 w.journal.rows.delete('demo/wallet/signed');
 await w.sourceJournal.put('source/signed',signedFor);
 assert.notEqual(isProvenUnsignedAbsence(await read()),true,'a signed CREATE retained by the source is no proof');
 w.sourceJournal.rows.delete('source/signed');
 assert.equal(isProvenUnsignedAbsence(await read()),true);
 // The wallet was asked and answered success:false while it journaled a signed CREATE: unknown, never the proof.
 w.controls.request=async request=>{await w.journal.put('demo/wallet/signed',{stage:'broadcast-started',hash:'a'.repeat(64),signedTransaction:request.transaction});return {success:false,error:{code:'internal_error'}};};
 await w.publish(anchor,jobId);
 assert.equal(w.captured.length,1);
 assert.notEqual(isProvenUnsignedAbsence(await read()),true,'a failure that left a signed CREATE is no proof');
});

// SDK #365 sweep: a wallet refusal that signed nothing, and a kill while the
// wallet was asked, stranded a paid order (the reader never proved the absence
// and publish never asked again).
const unsignedFixture=async()=>{
 const w=await anchorFixture(),anchor=w.open(),jobId=JOBS[0],logicalAddress=core.finalityCommitmentAddress(jobId);
 const input={logicalAddress,artifact:await w.artifact(jobId),artifactKind:'FinalityCommitmentRecord'};
 const rows=()=>[...w.journal.rows].filter(([key])=>key.startsWith('demo/artifact/')).map(([,row])=>row);
 return {w,anchor,jobId,logicalAddress,input,rows};
};
for(const code of ['internal_error','capture-without-signing','sdk_error'])test(`a wallet ${code} that signed nothing is a proven absence, and publishing asks the wallet again from a fresh intent`,async()=>{
 const {w,anchor,input,rows}=await unsignedFixture();
 w.controls.request=async()=>({success:false,error:{code}});
 assert.equal((await anchor.publish(input)).status,'indeterminate');
 assert.equal(rows()[0].stage,'unsigned');
 for(const read of [()=>anchor.read(input),()=>w.open().read(input),()=>w.open().readRetained(input)]){
  const out=await read();assert.equal(out.status,'absent');assert.equal(isProvenUnsignedAbsence(out),true,'nothing signed: proven absence, also after a restart');
 }
 let attempts=0;w.controls.request=async request=>{attempts++;return {success:false,error:{code}};};
 assert.equal((await w.open().publish(input)).status,'indeterminate');
 assert.equal(attempts,1,'exactly one new wallet request');assert.equal(w.captured.length,2);
 assert.deepEqual(w.captured.map(r=>r.transaction.content.nonce),[1,1],'no nonce was consumed');assert.equal(rows().length,1);
});
test('a process killed while the wallet was asked (an intent, nothing signed) is a proven absence; a signed CREATE retained for the address is not',async()=>{
 const {w,anchor,input,rows}=await unsignedFixture();
 w.source.binding=async()=>({disposition:'pending'});
 w.controls.request=async()=>{throw new Error('killed');};
 await assert.rejects(anchor.publish(input),/killed/);
 assert.equal(rows()[0].stage,'intent');
 assert.equal(isProvenUnsignedAbsence(await w.open().read(input)),true,'the wallet journals before it sends: no signed CREATE retained, so none was sent');
 // The wallet journaled its signed CREATE before the kill: the outcome is unknown.
 await w.journal.put('demo/wallet/signed',{stage:'broadcast-started',hash:'a'.repeat(64),signedTransaction:w.captured[0].transaction});
 const held=await w.open().read(input);
 assert.notEqual(isProvenUnsignedAbsence(held),true,'a retained signed CREATE is no proof');
 assert.notEqual(isProvenUnsignedAbsence(await w.open().readRetained(input)),true);
 assert.equal((await w.open().publish(input)).status,'indeterminate','a retained signed CREATE is only read back');
 assert.equal(w.captured.length,1,'a signed CREATE is never asked of the wallet again');
 // The source retains it instead.
 w.journal.rows.delete('demo/wallet/signed');
 await w.sourceJournal.put('source/signed',{stage:'signed',hash:'a'.repeat(64),signedTransaction:w.captured[0].transaction});
 assert.notEqual(isProvenUnsignedAbsence(await w.open().read(input)),true);
});
test('only a row that carries no hash or signed transaction can be an unsigned proof',async()=>{
 const {w,anchor,input,rows}=await unsignedFixture();
 w.controls.request=async()=>({success:false,error:{code:'internal_error'}});
 await anchor.publish(input);
 const [key,row]=[...w.journal.rows].find(([k])=>k.startsWith('demo/artifact/'));
 for(const changed of [{...row,hash:'b'.repeat(64)},{...row,signedTransaction:row.transaction},{...row,stage:'issued'},{...row,stage:'denied',error:'user_rejected'},{...row,stage:'rejected',error:'broadcast_rejected'}]){
  await w.journal.put(key,changed);
  assert.notEqual(isProvenUnsignedAbsence(await w.open().read(input)),true,JSON.stringify(Object.keys(changed))+changed.stage);
 }
});

// A Listing the operator refused is asked again only on the same proof as any
// unsigned intent: no signed CREATE for its address retained in either journal.
const deniedListing=async()=>{
 const w=await anchorFixture({writer:{claim:seller.claim,sign:seller.signBytes},artifactKinds:['Listing']}),listing=fixtureListing(seller,{now:1800000000000});
 const input={logicalAddress:core.listingAddress(seller.claim,listing.listingId,listing.listingVersion),artifact:listing,artifactKind:'Listing',reaskDenied:true};
 w.controls.request=async()=>({success:false,error:{code:'user_rejected'}});
 assert.equal((await w.open().publish(input)).status,'rejected');
 return {w,input};
};
test('a refused Listing is asked again when no signed CREATE is retained for it',async()=>{
 const {w,input}=await deniedListing();
 await w.open().publish(input);
 assert.equal(w.captured.length,2);
});
for(const journal of ['source','wallet'])test(`a refused Listing is not asked again once the ${journal} journal retains a signed CREATE for it`,async()=>{
 const {w,input}=await deniedListing(),signed={stage:'signed',hash:'a'.repeat(64),signedTransaction:w.captured[0].transaction};
 if(journal==='source')await w.sourceJournal.put('source/signed',signed);else await w.journal.put('demo/wallet/signed',signed);
 // The node has caught up with that CREATE, so only the proof can stop a second ask.
 w.controls.nonce=1;w.source.binding=async()=>({disposition:'pending'});w.source.recoverStorageWrite=async()=>{};
 for(let i=0;i<2;i++)await w.open().publish(input).catch(error=>assert.notEqual(error.code,undefined,String(error)));
 assert.equal(w.captured.length,1,'a signed CREATE is never asked of the wallet again');
});

for (const restart of [false, true]) for (const otherJob of [false, true]) test(`interrupted unsigned intent releases its nonce for ${otherJob ? 'another' : 'the same'} job, restart=${restart}`, async () => {
  const w = await anchorFixture(), anchor = w.open();
  w.controls.request = async () => { throw new Error('TEST process died inside wallet request'); };
  await assert.rejects(w.publish(anchor, JOBS[0]), /process died/);
  let asks = 0;
  w.controls.request = async () => { asks++; return { success: false, error: { code: 'capture-without-signing' } }; };
  const result = await w.publish(restart ? w.open() : anchor, JOBS[otherJob ? 1 : 0]);
  assert.equal(result.status, 'indeterminate');
  assert.equal(asks, 1, 'the wallet is asked exactly once more');
  assert.deepEqual(w.captured.map((request) => request.transaction.content.nonce), [1, 1]);
});

test('operator refusal is stable across publication and both read methods after reopening',async()=>{
 const {w,input}=await deniedListing();
 const request={...input,reaskDenied:false};
 for(const read of Object.values(retainedReads))assert.equal((await read(w.open(),request)).status,'rejected');
 assert.equal(w.captured.length,1);
});
