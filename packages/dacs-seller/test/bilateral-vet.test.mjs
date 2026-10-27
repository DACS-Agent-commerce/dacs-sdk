import test from 'node:test';
import assert from 'node:assert/strict';
import {compositeVerificationAddress,contentHash} from '@kynesyslabs/dacs';
import {fixture,JOBS,recordFor} from './helpers/bilateral-vet-fixture.mjs';

test('direct provider starts, recovery, resume and release refuse malformed jobs before any state or verifier call',async()=>{
 const w=fixture(),{createDevnetDemoAgreementContextProvider}=await import('../src/devnet-demo/agreement-context.mjs');
 const forbidden=()=>assert.fail('malformed job reached party Vet state');
 const p=createDevnetDemoAgreementContextProvider({anchor:w.anchor,wallet:{claim:w.seller.claim,signBytes:w.seller.sign},listing:w.listing,
  store:{...w.store,read:forbidden,update:forbidden,entries:forbidden},counterparty:w.counterparty,log:()=>{}});
 for(const jobId of [undefined,null,7,'job-0',JOBS[0].toLowerCase(),JOBS[0].slice(1),'8'+JOBS[0].slice(1)]){
  const input=w.input(jobId);input.scope.jobId=jobId;
  for(const method of ['resolveBuyer','recoverBuyer','resumableBuyer'])await assert.rejects(p[method](input),{code:'job_invalid'});
  await assert.rejects(p.resolveSeller({jobId,listingPin:w.pin,buyerIdentityBundle:input.buyerIdentityBundle,generatedAt:input.scope.generatedAt}),{code:'job_invalid'});
  assert.throws(()=>p.release({jobId}),{code:'job_invalid'});
 }
 assert.equal(w.records.size,0);assert.equal(w.seen.length,0);assert.equal(p.invocations.length,0);assert.equal(p.contexts.size,0);
});

test('two parties authenticate independent verifier signatures and fresh seller sessions, including restart',async()=>{
 const w=fixture(),p=w.provider(),first=w.input(),second=w.input(JOBS[1]);
 for(const input of [first,second])assert.equal((await p.resolveBuyer(input)).disposition,'present');
 assert.equal(w.seen.length,2);assert.notEqual(w.seen[0].identityBundle.sessionNonce,w.seen[1].identityBundle.sessionNonce);
 assert.notEqual(w.seen[0].identityBundle.sessionNonce,w.listing.seller.identity.sessionNonce);
 assert.deepEqual(p.invocations.map(v=>v.record.signature.signer),[w.seller.claim,w.buyer.claim,w.seller.claim,w.buyer.claim]);
 const recovered=await w.provider().recoverBuyer(first);assert.equal(recovered.disposition,'present');
 assert.deepEqual(recovered.value.input.seller.identityBundle,w.seen[0].identityBundle);assert.equal(w.seen.length,2);
});
test('seller-signed seller CVR is rejected by real strict verification before anchoring and during recovery',async()=>{
 const w=fixture();w.controls.wrongSigner=true;const p=w.provider(),input=w.input();
 await assert.rejects(p.resolveBuyer(input),{code:'seller_vet_invalid'});assert.equal(p.contexts.size,0);
 assert.equal(w.records.has(compositeVerificationAddress(JOBS[0],w.seller.claim)),false);
 const good=fixture(),i=good.input();await good.provider().resolveBuyer(i);
 const address=compositeVerificationAddress(JOBS[0],good.seller.claim),row=good.records.get(address);
 row.artifact=await recordFor(good.seen[0],good.seller);row.receipt.contentHash=contentHash(row.artifact);
 assert.equal(await good.provider().recoverBuyer(i),null);
});
test('one buyer-issued seller nonce cannot be reused by another job after restart',async()=>{
 const w=fixture();w.controls.nonce='c'.repeat(64);await w.provider().resolveBuyer(w.input());
 const p=w.provider();await assert.rejects(p.resolveBuyer(w.input(JOBS[1])),{code:'seller_challenge_reused'});assert.equal(p.contexts.size,0);
});
test('a signed decision inconsistent with recomputation never yields context',async()=>{
 const w=fixture();w.controls.decision='fail';const p=w.provider();await assert.rejects(p.resolveBuyer(w.input()),{code:'seller_vet_invalid'});assert.equal(p.contexts.size,0);
});
for(const state of ['unknown','dropped','replaced','reorged'])test(`${state} Vet receipt never yields initial or recovered context`,async()=>{
 const w=fixture(),input=w.input(),p=w.provider();w.controls.receiptState=state;
 await assert.rejects(p.resolveBuyer(input));assert.equal(p.contexts.size,0);assert.equal(await w.provider().recoverBuyer(input),null);
});
for(const receiptVerdict of ['invalid','indeterminate'])test(`${receiptVerdict} SR-2 verification never yields context`,async()=>{
 const w=fixture();w.controls.receiptVerdict=receiptVerdict;const p=w.provider();await assert.rejects(p.resolveBuyer(w.input()));assert.equal(p.contexts.size,0);
});
test('relay acknowledgement cannot substitute for a verified accepted receipt',async()=>{
 const w=fixture();w.controls.relayOnly=true;const p=w.provider();await assert.rejects(p.resolveBuyer(w.input()));assert.equal(p.contexts.size,0);
});
test('missing buyer verifier refuses before any CVR signature or native effect',async()=>{
 const w=fixture();const {createDevnetDemoAgreementContextProvider}=await import('../src/devnet-demo/agreement-context.mjs');
 const p=createDevnetDemoAgreementContextProvider({anchor:w.anchor,wallet:{claim:w.seller.claim,signBytes:()=>assert.fail('signature')},listing:w.listing,store:w.store});
 assert.equal((await p.resolveBuyer(w.input())).code,'counterparty_vet_required');assert.equal(w.records.size,0);
});

test('an existing context is suspended when fresh receipt readback loses authority',async()=>{
 const w=fixture(),p=w.provider(),input=w.input();await p.resolveBuyer(input);w.controls.receiptState='reorged';
 await assert.rejects(p.resolveBuyer(input),{code:'party_vet_unavailable'});
 assert.equal((await p.resolveSeller({jobId:input.scope.jobId,listingPin:w.pin,buyerIdentityBundle:input.buyerIdentityBundle,generatedAt:input.scope.generatedAt})).disposition,'indeterminate');
});
test('native publisher separates seller writer from buyer CVR verifier with real signatures',async()=>{
 const {anchorFixture}=await import('./helpers/anchor-isolated-fixture.mjs');const w=fixture(),native=await anchorFixture({writer:w.seller}),input={jobId:JOBS[0],identityBundle:w.listing.seller.identity,requirement:w.listing.buyerRequirement};
 const logicalAddress=compositeVerificationAddress(JOBS[0],w.seller.claim);
 await assert.rejects(native.open().publish({logicalAddress,artifact:await recordFor(input,w.seller),artifactKind:'CompositeVerificationRecord'}),{code:'invalid'});assert.equal(native.captured.length,0);
 const record=await recordFor(input,w.buyer);
 assert.equal((await native.open().publish({logicalAddress,artifact:record,artifactKind:'CompositeVerificationRecord',verifier:w.buyer.claim})).status,'indeterminate');
 assert.equal(native.captured.length,1);assert.equal(native.captured[0].owner,w.seller.claim);
});

for(const state of ['unknown','dropped','replaced','reorged'])test(`seller-only ${state} receipt blocks publication and suspends retained context`,async()=>{
 const w=fixture(),input=w.input(),address=compositeVerificationAddress(JOBS[0],w.seller.claim);
 const read=w.anchor.readRetained,publish=w.anchor.publish;
 let faulty=false;
 const patch=(row,key)=>faulty&&key===address&&row.receipt?{...row,receipt:{...row.receipt,state}}:row;
 w.anchor.readRetained=async i=>patch(await read(i),i.logicalAddress);
 w.anchor.publish=async i=>patch(await publish(i),i.logicalAddress);
 faulty=true;await assert.rejects(w.provider().resolveBuyer(input),{code:'seller_vet_receipt_invalid'});
 faulty=false;const p=w.provider();assert.equal((await p.resolveBuyer(input)).disposition,'present');
 faulty=true;assert.equal(await w.provider().recoverBuyer(input),null);
 const request={jobId:JOBS[0],listingPin:w.pin,buyerIdentityBundle:input.buyerIdentityBundle,generatedAt:input.scope.generatedAt};
 assert.equal((await p.resolveSeller(request)).disposition,'indeterminate');
 assert.equal((await w.provider().resolveSeller(request)).disposition,'indeterminate');
});
test('included seller CVR receipt is held while the buyer CVR remains finalized',async()=>{
 const w=fixture(),address=compositeVerificationAddress(JOBS[0],w.seller.claim),read=w.anchor.readRetained,publish=w.anchor.publish;
 const patch=(row,key)=>key===address&&row.receipt?{...row,receipt:{...row.receipt,state:'included'}}:row;
 w.anchor.readRetained=async i=>patch(await read(i),i.logicalAddress);w.anchor.publish=async i=>patch(await publish(i),i.logicalAddress);
 const input=w.input();await assert.rejects(w.provider().resolveBuyer(input),{code:'seller_vet_receipt_invalid'});
 assert.equal(await w.provider().recoverBuyer(input),null);
});
test('ended jobs free challenge capacity across many sessions and provider restarts',async()=>{
 const w=fixture({maxJobs:1});
 for(let i=0;i<12;i++){
  const p=w.provider(),jobId='01ARZ3NDEKTSV4RRFFQ69G5F'+String(i).padStart(2,'0');
  assert.equal((await p.resolveBuyer(w.input(jobId))).disposition,'present');
  p.release({jobId});await p.sweep(()=>true);
  assert.equal(w.store.usage().jobs,0);
 }
});
test('transient readback remains indeterminate after restart and recovers once the RPC returns',async()=>{
 const w=fixture(),p=w.provider(),input=w.input();await p.resolveBuyer(input);
 const request={jobId:JOBS[0],listingPin:w.pin,buyerIdentityBundle:input.buyerIdentityBundle,generatedAt:input.scope.generatedAt};
 const read=w.anchor.readRetained;w.anchor.readRetained=async()=>({status:'indeterminate',reason:'RPC unavailable'});
 assert.equal((await p.resolveSeller(request)).disposition,'indeterminate');
 const restarted=w.provider();assert.equal((await restarted.resolveSeller(request)).disposition,'indeterminate');
 w.anchor.readRetained=read;assert.equal((await restarted.resolveSeller(request)).disposition,'present');
});

test('an orphaned fence from the earlier provider is reclaimed before binding at capacity',async()=>{
 const w=fixture({maxJobs:1});await w.store.update('seller-challenge/legacy',()=>({jobId:JOBS[1],buyer:w.buyer.claim,sessionNonce:'e'.repeat(64)}));
 assert.equal((await w.provider().resolveBuyer(w.input())).disposition,'present');
 assert.equal(w.store.usage().jobs,1);assert.ok((await w.store.entries()).every(([key])=>key.startsWith('party-vet/')));
});
test('concurrent providers cannot claim the same buyer-issued seller challenge for different jobs',async()=>{
 const w=fixture();w.controls.nonce='e'.repeat(64);
 const results=await Promise.allSettled(JOBS.map(id=>w.provider().resolveBuyer(w.input(id))));
 assert.equal(results.filter(r=>r.status==='fulfilled'&&r.value.disposition==='present').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'seller_challenge_reused');
});

const request=(w,input)=>({jobId:input.scope.jobId,listingPin:w.pin,buyerIdentityBundle:input.buyerIdentityBundle,generatedAt:input.scope.generatedAt});
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('release fences a late context completion before durable retention',async()=>{
 const w=fixture(),p=w.provider(),a=w.input(),b=structuredClone(a);b.scope.generatedAt++;
 await p.resolveBuyer(a);const read=w.anchor.readRetained,entered=gate(),resume=gate();let wait=true;
 w.anchor.readRetained=async input=>{if(wait&&input.fresh){wait=false;entered.resolve();await resume.promise;}return read(input);};
 const slow=p.resolveBuyer(a);await entered.promise;await p.resolveBuyer(b);p.release({jobId:a.scope.jobId,generatedAt:b.scope.generatedAt});resume.resolve();
 await assert.rejects(slow,e=>e.code==='context_released');const row=(await w.store.entries()).find(([key])=>key.startsWith('party-vet/'))[1];
 assert.deepEqual(row.seller.generatedAts,[b.scope.generatedAt]);assert.equal(p.contexts.size,1);assert.equal((await p.resolveSeller(request(w,a))).disposition,'rejected');w.store.close();
});
// The release selection and a sweep's deletion are kept in the job's row, so they hold in every provider on the
// store and after a restart, not only in the provider that made them.
const releasedB=async()=>{
 const w=fixture(),p=w.provider(),a=w.input(),b=structuredClone(a);b.scope.generatedAt++;
 await p.resolveBuyer(a);await p.resolveBuyer(b);p.release({jobId:a.scope.jobId,generatedAt:b.scope.generatedAt});
 return{w,p,a,b,times:async()=>(await w.store.entries()).find(([key])=>key.startsWith('party-vet/'))[1].seller.generatedAts};
};
test('after a restart, buyer resolution refuses a request time the release did not select',async t=>{
 const{w,a,b,times}=await releasedB();t.after(()=>w.store.close());
 await assert.rejects(w.provider().resolveBuyer(a),{code:'context_released'});
 assert.deepEqual(await times(),[b.scope.generatedAt]);assert.equal(w.seen.length,1);
});
test('after a restart, recovery refuses a request time the release did not select',async t=>{
 const{w,a,b}=await releasedB();t.after(()=>w.store.close());const restarted=w.provider();
 assert.equal(await restarted.recoverBuyer(a),null);assert.equal((await restarted.resolveSeller(request(w,a))).disposition,'rejected');
 assert.equal((await restarted.resolveSeller(request(w,b))).disposition,'present');
});
test('a cached context is refused once another provider on the store selected another request time',async t=>{
 const w=fixture(),p=w.provider(),a=w.input(),b=structuredClone(a);b.scope.generatedAt++;t.after(()=>w.store.close());
 await p.resolveBuyer(a);await p.resolveBuyer(b);w.provider().release({jobId:a.scope.jobId,generatedAt:b.scope.generatedAt});
 assert.equal((await p.resolveSeller(request(w,a))).disposition,'rejected');assert.equal((await p.resolveSeller(request(w,b))).disposition,'present');
});
test('a cached context is refused once another provider on the store swept its ended job',async t=>{
 const w=fixture(),p=w.provider(),input=w.input();t.after(()=>w.store.close());
 await p.resolveBuyer(input);assert.equal((await w.provider().sweep(()=>true)).deleted,1);
 assert.equal((await p.resolveSeller(request(w,input))).disposition,'rejected');
});
test('sweep evicts contexts and Vet jobs and cannot resurrect an ended job',async()=>{
 const w=fixture(),p=w.provider(),input=w.input();await p.resolveBuyer(input);assert.equal((await p.sweep(()=>true)).deleted,1);assert.equal(p.contexts.size,0);assert.equal(w.store.usage().jobs,0);
 assert.notEqual((await p.resolveSeller(request(w,input))).disposition,'present');const replay=await p.resolveBuyer(input);assert.notEqual(replay.disposition,'present');assert.equal(w.seen.length,1);w.store.close();
});
for(const reverse of [false,true])test(`retained timestamps recover after restart in ${reverse?'reverse':'forward'} order`,async()=>{
 const w=fixture(),p=w.provider(),a=w.input(),b=structuredClone(a);b.scope.generatedAt++;await p.resolveBuyer(a);await p.resolveBuyer(b);const fresh=w.provider();
 for(const input of reverse?[b,a]:[a,b])assert.equal((await fresh.resolveSeller(request(w,input))).disposition,'present');w.store.close();
});
for(const role of ['buyer','seller'])for(const method of ['resolveSeller','recoverBuyer'])test(`${method} after restart refuses a changed ${role} Vet ref on every retry`,async t=>{
 const w=fixture(),input=w.input();t.after(()=>w.store.close());await w.provider().resolveBuyer(input);
 const address=compositeVerificationAddress(input.scope.jobId,w[role].claim),row=w.records.get(address),signer=role==='buyer'?w.seller:w.buyer;
 const {signComponentArtifact,ARTIFACT_SEPARATORS}=await import('@kynesyslabs/dacs');const {fixtureRecord}=await import('./helpers/protocol-fixture.mjs');
 const {signature,...unsigned}=row.artifact;const replacement=await signComponentArtifact({...unsigned,generatedAt:unsigned.generatedAt-1},ARTIFACT_SEPARATORS.CompositeVerificationRecord,{signer:signer.claim,algorithm:'ed25519',sign:signer.signBytes});
 w.records.set(address,fixtureRecord(address,replacement,w.seller));const restarted=w.provider();
 for(let attempt=0;attempt<2;attempt++){
  if(method==='resolveSeller')assert.equal((await restarted.resolveSeller(request(w,input))).disposition,'indeterminate');
  else assert.equal(await restarted.recoverBuyer(input),null);
 }
 assert.equal(restarted.contexts.size,0);
 assert.equal(w.seen.length,1);
 w.records.set(address,row);assert.equal((await restarted.resolveSeller(request(w,input))).disposition,'present');assert.equal(w.seen.length,1);
});
