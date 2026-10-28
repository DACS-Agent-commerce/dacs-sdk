import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as core from '@kynesyslabs/dacs';
import {createSellerAgent,SellerAgentError} from '../src/dacs/seller-agent.mjs';
import {createSellerDurableState} from '../src/dacs/seller-durable-state.mjs';
import {fixtureListing} from './fixtures/listings.mjs';
import {seller,buyer,JOB,NOW} from './helpers/protocol-fixture.mjs';
import {railSteward} from './helpers/rail-authority-fixture.mjs';
import {createSessionAdmissionFixture} from './helpers/session-admission-fixture.mjs';
import {buildUnsignedIdentityBundle,attachIdentityPresentation} from '../src/dacs/listing.mjs';
import {listingPin} from '../src/dacs/purchase-protocol.mjs';
import {admitSessionChallenge} from '../src/dacs/session-challenge-limits.mjs';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'TEST-agent-construction-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const listing=fixtureListing(seller,{now:NOW}),signer={claim:seller.claim,sign:seller.signBytes},unreachable=()=>assert.fail('unexpected external operation');let time=NOW;
 const admission=createSessionAdmissionFixture({seller:{claim:seller.claim,sign:seller.signBytes},buyer:{claim:buyer.claim,sign:buyer.signBytes},now:()=>time});
 const config={signer,listing,durableDirectory:dir,now:()=>time,agreementAnchor:{source:'TEST-native',readAgreement:unreachable},nativeArtifactAnchor:{writer:seller.claim,publish:unreachable,readRetained:unreachable,verifyReceipt:unreachable},deliverableProducer:unreachable,deliverySchemaVerifier:{schemaUrl:listing.offering.deliverable.schemaUrl,verify:unreachable},railAuthority:railSteward().railAuthority(),sessionAdmission:admission.sessionAdmission};
 return{config,dir,listing,signer,admission,advance:ms=>{time+=ms;},open:changes=>createSellerAgent({...config,...changes})};
}
// A buyer presentation that carries exactly the nonce the seller issued.
const presentWith=(party,sessionNonce)=>{
 const unsigned=buildUnsignedIdentityBundle({address:party.address,presentedAt:NOW-1000,sessionSeed:'construction',sessionNonce});
 return attachIdentityPresentation(unsigned,'0x'+party.signBytes(unsigned.message).toString('hex'));
};
const presentAt=(party,sessionNonce,presentedAt)=>{
 const unsigned=buildUnsignedIdentityBundle({address:party.address,presentedAt,sessionSeed:'construction',sessionNonce});
 return attachIdentityPresentation(unsigned,'0x'+party.signBytes(unsigned.message).toString('hex'));
};
const vetRef=(jobId,party,verifier)=>({anchor:{kind:'storage-program',locator:core.compositeVerificationAddress(jobId,party)},contentHash:'b'.repeat(64),signer:verifier});
const sessionFor=(jobId,bundle,checkpoint)=>({jobId,buyerBundle:bundle,buyerBundleHash:core.identityBundleHash(bundle),stage:'vetted',vetCheckpoint:checkpoint});
// CORE SN-4: the admitted attempt binds the exact complete presentation.
const admittedAttempt=session=>({presentationHash:core.contentHash(session.buyerBundle)});
const admitWith=(state,nonce,session)=>{const attempt=admittedAttempt(session);state.attemptChallenge(nonce,attempt);state.admitChallenge(nonce,attempt.presentationHash);};
async function saveSession(f,session,prepare){
 const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing)});
 try{prepare?.(state);await state.withJob(session.jobId,()=>state.saveSession(session));}finally{state.close();}
}
test('retained Listing admission rejects a substituted signature on restart',async t=>{
 const f=fixture(t),first=await f.open();first.close();const changed=structuredClone(f.listing);changed.signature.value='A'.repeat(86);
 await assert.rejects(f.open({listing:changed}),/Listing|listing/);
});
test('failed Listing initialization closes every owned database handle',async t=>{
 const f=fixture(t),changed=structuredClone(f.listing);changed.signature.value='A'.repeat(86);const path=join(f.dir,'seller-state.sqlite');
 const descriptors=()=>readdirSync('/proc/self/fd').filter(fd=>{try{return readlinkSync('/proc/self/fd/'+fd)===path;}catch{return false;}}).length;
 const before=descriptors();for(let i=0;i<3;i++)await assert.rejects(f.open({listing:changed}));assert.equal(descriptors(),before);
});
test('issued challenge survives authenticated database reopen with every bound field',async t=>{
 const f=fixture(t),agent=await f.open(),issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 const reopened=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing)});try{const prior=reopened.attemptChallenge(issued.sessionNonce,{presentationHash:'a'.repeat(64)});assert.deepEqual(prior,{kind:'session-challenge',...issued,attempt:null});}finally{reopened.close();}
});
for(const durable of [true,false])test(`${durable?'durable':'memory'} challenges enforce total capacity and stop counting expired unused nonces`,async t=>{
 const f=fixture(t),options={maxJobs:1,...durable?{}:{durableDirectory:undefined}},agent=await f.open(options);let current=agent;
 t.after(()=>current.close());const first=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});await assert.rejects(agent.issueSessionChallenge({jobId:'01J8N4YV7YVYQ4DB7M8T4C7W0B',buyer:buyer.claim}),e=>e.code==='seller_challenge_capacity');
 if(durable){agent.close();current=await f.open(options);await assert.rejects(current.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}),e=>e.code==='seller_challenge_capacity');}
 f.advance(first.expiresAt-NOW);assert.notEqual((await current.issueSessionChallenge({jobId:JOB,buyer:buyer.claim})).sessionNonce,first.sessionNonce);
});
for(const durable of [true,false])test(`${durable?'durable':'memory'} closed agents refuse every public operation`,async t=>{
 const f=fixture(t),agent=await f.open(durable?{}:{durableDirectory:undefined});agent.close();agent.close();
 for(const [name,operation]of Object.entries(agent))if(typeof operation==='function'&&name!=='close')assert.throws(()=>operation(name==='issueSessionChallenge'?{jobId:JOB,buyer:buyer.claim}:JOB),e=>e.code==='seller_closed',name);
});
test('the partial constructor is absent from the public package entry',async()=>{
 const entry=await import('../src/index.mjs');assert.equal(entry.createSellerAgent,undefined);
});

test('per-job challenge capacity applies before the global bound',async t=>{
 const f=fixture(t),agent=await f.open({maxJobs:32});t.after(()=>agent.close());for(let i=0;i<16;i++)await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});
 await assert.rejects(agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}),e=>e.code==='seller_challenge_capacity');assert.ok(await agent.issueSessionChallenge({jobId:'01J8N4YV7YVYQ4DB7M8T4C7W0B',buyer:buyer.claim}));
});
test('an expired unused challenge is retained across restart and does not consume live capacity',async t=>{
 const f=fixture(t),agent=await f.open({maxJobs:1}),issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 f.advance(issued.expiresAt-NOW+1);
 const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing),maxJobs:1});
 try{assert.deepEqual(state.challenge(issued.sessionNonce),{kind:'session-challenge',...issued,attempt:null},'CORE SN-4 retains the unused issuance record');}finally{state.close();}
 const fresh=await f.open({maxJobs:1});try{assert.ok(await fresh.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}));}finally{fresh.close();}
});
test('an attempted, admitted challenge stays retained but does not consume live capacity after expiry',async t=>{
 const otherJob='01J8N4YV7YVYQ4DB7M8T4C7W0B';
 const f=fixture(t),agent=await f.open({maxJobs:1}),issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing),maxJobs:1});
 try{state.attemptChallenge(issued.sessionNonce,{presentationHash:'a'.repeat(64)});state.admitChallenge(issued.sessionNonce,'a'.repeat(64));}finally{state.close();}
 f.advance(issued.expiresAt-NOW+1);
 const fresh=await f.open({maxJobs:1});try{assert.ok(await fresh.issueSessionChallenge({jobId:otherJob,buyer:buyer.claim}),'a consumed challenge is a retained tombstone, not a live slot');}finally{fresh.close();}
 const reopened=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing),maxJobs:1});
 try{assert.deepEqual(reopened.challenge(issued.sessionNonce).attempt,{presentationHash:'a'.repeat(64),admitted:true});}finally{reopened.close();}
});
test('an attempted challenge, admitted or refused, holds no live issuance slot',()=>{
 const value={jobId:JOB,issuedAt:NOW};
 for(const admitted of [false,true]){
  const row={kind:'session-challenge',jobId:JOB,issuedAt:NOW-1,expiresAt:NOW+1000,attempt:{presentationHash:'a'.repeat(64),admitted}};
  assert.doesNotThrow(()=>admitSessionChallenge(new Map([['nonce',row]]),value,{maxOutstanding:1,maxPerJob:1}));
 }
});
test('malformed challenge requests are coded refusals',async t=>{
 const f=fixture(t),agent=await f.open();t.after(()=>agent.close());
 for(const request of [null,undefined,42,'challenge',[]])await assert.rejects(agent.issueSessionChallenge(request),error=>error instanceof SellerAgentError&&error.code==='challenge_invalid'&&error.status===422);
});
test('restart refuses a retained session whose challenge this seller never issued',async t=>{
 const f=fixture(t),agent=await f.open();agent.close();
 const bundle=presentWith(buyer,'ab'.repeat(32));
 await saveSession(f,sessionFor(JOB,bundle,{buyer:vetRef(JOB,buyer.claim,seller.claim),seller:vetRef(JOB,seller.claim,buyer.claim)}));
 await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&/challenge/.test(error.message));
});
test('restart refuses a retained session whose challenge was issued for another job or never attempted',async t=>{
 const otherJob='01J8N4YV7YVYQ4DB7M8T4C7W0B';
 {
  const f=fixture(t),agent=await f.open(),issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
  await saveSession(f,sessionFor(otherJob,presentWith(buyer,issued.sessionNonce),{buyer:vetRef(otherJob,buyer.claim,seller.claim),seller:vetRef(otherJob,seller.claim,buyer.claim)}));
  await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&/another job or buyer/.test(error.message));
 }
 {
  const f=fixture(t),agent=await f.open(),issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
  await saveSession(f,sessionFor(JOB,presentWith(buyer,issued.sessionNonce),{buyer:vetRef(JOB,buyer.claim,seller.claim),seller:vetRef(JOB,seller.claim,buyer.claim)}));
  await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&/not consumed and admitted/.test(error.message));
 }
});
test('restart refuses a retained vetted session with no exact, job-bound, verifier-signed Vet checkpoint',async t=>{
 const f=fixture(t),agent=await f.open(),issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 const bundle=presentWith(buyer,issued.sessionNonce);
 const admit=async session=>saveSession(f,session,state=>admitWith(state,issued.sessionNonce,session));
 for(const [checkpoint,pattern] of [
  [null,/no exact buyer and seller Vet checkpoint/],
  [{buyer:null,seller:null},/not an exact signed record reference/],
  [{buyer:vetRef('01J8N4YV7YVYQ4DB7M8T4C7W0C',buyer.claim,seller.claim),seller:vetRef(JOB,seller.claim,buyer.claim)},/canonical composite address/],
  [{buyer:vetRef(JOB,buyer.claim,buyer.claim),seller:vetRef(JOB,seller.claim,buyer.claim)},/signed by its counterparty verifier/],
 ]) {
  await admit(sessionFor(JOB,bundle,checkpoint));
  await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&pattern.test(error.message));
 }
});
test('read paths refuse a retained session another writer left unverified',async t=>{
 const f=fixture(t),agent=await f.open();t.after(()=>agent.close());
 const bundle=presentWith(buyer,'ab'.repeat(32));
 await saveSession(f,sessionFor(JOB,bundle,{buyer:vetRef(JOB,buyer.claim,seller.claim),seller:vetRef(JOB,seller.claim,buyer.claim)}));
 for(const read of [()=>agent.transportAgreementOf(JOB),()=>agent.deliveryStateOf(JOB)])assert.throws(read,error=>error.code==='seller_state_unverified');
 assert.equal(agent.retainsPaymentClaim(JOB,{txHash:'0x'+'a'.repeat(64),payerPayingKey:buyer.claim}),false,'an unverified session retains no payment claim');
});
test('restart refuses a Vet record the counterparty did not sign or a receipt below accepted',async t=>{
 const signerKey={claim:seller.claim,sign:seller.signBytes},buyerKey={claim:buyer.claim,sign:buyer.signBytes},otherJob='01J8N4YV7YVYQ4DB7M8T4C7W0B';
 for(const [options,pattern,prepare] of [
  [{signer:{claim:buyer.claim,sign:seller.signBytes}},/not signed by its counterparty verifier/],
  [{receipt:{state:'expired'}},/not accepted or later/],
  [{receipt:null},/has no SR-2 receipt/],
  [{bundleHash:'c'.repeat(64)},/evaluates another job, party or bundle/],
  [{recordJobId:otherJob},/evaluates another job, party or bundle/],
  [{},/Vet receipt does not verify/,admission=>admission.verifyReceiptWith(()=>'invalid')],
 ]) {
  const f=fixture(t),admission=createSessionAdmissionFixture({seller:signerKey,buyer:buyerKey,now:()=>NOW});
  prepare?.(admission);
  const agent=await f.open({sessionAdmission:admission.sessionAdmission}),issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
  const bundle=presentWith(buyer,issued.sessionNonce);
  const buyerRef=await admission.vetRecord(JOB,buyer.claim,bundle,{requirement:f.listing.buyerRequirement});
  const sellerRef=await admission.vetRecord(JOB,seller.claim,f.listing.seller.identity,{requirement:f.listing.buyerRequirement,...options});
  const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing)});
  try{
   admitWith(state,issued.sessionNonce,{buyerBundle:bundle});
   await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:bundle,buyerBundleHash:core.identityBundleHash(bundle),sellerBundle:f.listing.seller.identity,stage:'vetted',vetCheckpoint:{buyer:buyerRef,seller:sellerRef}}));
  }finally{state.close();}
  await assert.rejects(f.open({sessionAdmission:admission.sessionAdmission}),error=>error.code==='seller_state_unverified'&&pattern.test(error.message));
 }
});
test('restart restores a session bound to its admitted challenge and to verified Vet records and receipts',async t=>{
 const f=fixture(t),signerKey={claim:seller.claim,sign:seller.signBytes},buyerKey={claim:buyer.claim,sign:buyer.signBytes};
 const admission=createSessionAdmissionFixture({seller:signerKey,buyer:buyerKey,now:()=>NOW});
 const agent=await f.open({sessionAdmission:admission.sessionAdmission}),issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 const bundle=presentWith(buyer,issued.sessionNonce);
 const buyerRef=await admission.vetRecord(JOB,buyer.claim,bundle,{requirement:f.listing.buyerRequirement});
 const sellerRef=await admission.vetRecord(JOB,seller.claim,f.listing.seller.identity,{requirement:f.listing.buyerRequirement});
 const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing)});
 try{
  admitWith(state,issued.sessionNonce,{buyerBundle:bundle});
  await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:bundle,buyerBundleHash:core.identityBundleHash(bundle),sellerBundle:f.listing.seller.identity,stage:'vetted',vetCheckpoint:{buyer:buyerRef,seller:sellerRef}}));
 }finally{state.close();}
 const fresh=await f.open({sessionAdmission:admission.sessionAdmission});
 try{assert.equal(fresh.stageOf(JOB),'vetted');assert.equal(fresh.durableSessionOf(JOB).vetCheckpoint.buyer.contentHash,buyerRef.contentHash);}finally{fresh.close();}
});
// A fully admitted session whose two Vet records are counterparty-signed, with
// an optional wrong requirementHash substituted into either record.
async function vettedSession(t,requirementHash={}){
 const f=fixture(t),signerKey={claim:seller.claim,sign:seller.signBytes},buyerKey={claim:buyer.claim,sign:buyer.signBytes};
 const admission=createSessionAdmissionFixture({seller:signerKey,buyer:buyerKey,now:()=>NOW});
 const agent=await f.open({sessionAdmission:admission.sessionAdmission}),issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 const bundle=presentWith(buyer,issued.sessionNonce);
 const buyerRef=await admission.vetRecord(JOB,buyer.claim,bundle,{requirement:f.listing.buyerRequirement,...requirementHash.buyer?{requirementHash:requirementHash.buyer}:{}});
 const sellerRef=await admission.vetRecord(JOB,seller.claim,f.listing.seller.identity,{requirement:f.listing.buyerRequirement,...requirementHash.seller?{requirementHash:requirementHash.seller}:{}});
 const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing)});
 try{
  admitWith(state,issued.sessionNonce,{buyerBundle:bundle});
  await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:bundle,buyerBundleHash:core.identityBundleHash(bundle),sellerBundle:f.listing.seller.identity,stage:'vetted',vetCheckpoint:{buyer:buyerRef,seller:sellerRef}}));
 }finally{state.close();}
 return {f,admission};
}
test('restart refuses a retained Vet record the counterparty signed for another requirement',async t=>{
 for(const role of ['buyer','seller']){
  const {f,admission}=await vettedSession(t,{[role]:'c'.repeat(64)});
  await assert.rejects(f.open({sessionAdmission:admission.sessionAdmission}),error=>error.code==='seller_state_unverified'&&/requirement-hash-mismatch/.test(error.message));
 }
});
test('restart fails closed when a Vet reader stalls past its deadline',async t=>{
 const {f,admission}=await vettedSession(t);
 let entered,seen;
 const reached=new Promise(resolve=>{entered=resolve;});
 const {resolveVetRecord:_resolve,...rest}=admission.sessionAdmission;
 const stall={...rest,resolveVetRecord:(query,options)=>{seen=options;entered();return new Promise(()=>{});}};
 t.mock.timers.enable({apis:['setTimeout']});
 const attempt=f.open({sessionAdmission:stall});let state='pending';
 attempt.then(()=>{state='resolved';},()=>{state='rejected';});
 const pending=assert.rejects(attempt,error=>error.code==='seller_state_unverified'&&/cannot be resolved/.test(error.message)&&error.cause?.name==='TimeoutError');
 await reached;await Promise.resolve();
 assert.equal(state,'pending','a stalled reader must not settle the restore');
 assert.equal(seen.maxBytes,64*1024);assert.equal(seen.timeoutMs,10_000);assert.ok(seen.signal instanceof AbortSignal,'every Vet reader receives an abort signal');
 t.mock.timers.tick(10_000);
 await pending;
});
test('restart fails closed when a Vet reader returns an oversized reply',async t=>{
 const {f,admission}=await vettedSession(t);
 await assert.rejects(f.open({sessionAdmission:{...admission.sessionAdmission,resolveVetRecord:async()=>({padded:'x'.repeat(64*1024)})}}),
  error=>error.code==='seller_state_unverified'&&/cannot be resolved/.test(error.message));
});
test('a malformed retained challenge issuance is corruption, not a released slot',()=>{
 const value={jobId:JOB,issuedAt:NOW};
 for(const row of [{kind:'session-challenge',attempt:null,expiresAt:'invalid'},{kind:'session-challenge',attempt:null,expiresAt:-1},{kind:'session-challenge',attempt:'consumed',expiresAt:NOW+1000}])
  assert.throws(()=>admitSessionChallenge(new Map([['nonce',row]]),value,{maxOutstanding:1,maxPerJob:1}),error=>error.code==='seller_state_corrupt');
});
// CORE SN-4: an admitted nonce must name the exact complete presentation that
// was presented, not just the nonce.
test('restart refuses a retained session admitted for a different presentation',async t=>{
 const f=fixture(t),signerKey={claim:seller.claim,sign:seller.signBytes},buyerKey={claim:buyer.claim,sign:buyer.signBytes};
 const admission=createSessionAdmissionFixture({seller:signerKey,buyer:buyerKey,now:()=>NOW});
 const agent=await f.open({sessionAdmission:admission.sessionAdmission}),issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 const bundle=presentWith(buyer,issued.sessionNonce),other=presentAt(buyer,issued.sessionNonce,NOW-2000);
 assert.notEqual(core.contentHash(other),core.contentHash(bundle));
 const buyerRef=await admission.vetRecord(JOB,buyer.claim,bundle,{requirement:f.listing.buyerRequirement});
 const sellerRef=await admission.vetRecord(JOB,seller.claim,f.listing.seller.identity,{requirement:f.listing.buyerRequirement});
 const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing)});
 try{
  const attempt={presentationHash:core.contentHash(other)};state.attemptChallenge(issued.sessionNonce,attempt);state.admitChallenge(issued.sessionNonce,attempt.presentationHash);
  await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:bundle,buyerBundleHash:core.identityBundleHash(bundle),sellerBundle:f.listing.seller.identity,stage:'vetted',vetCheckpoint:{buyer:buyerRef,seller:sellerRef}}));
 }finally{state.close();}
 await assert.rejects(f.open({sessionAdmission:admission.sessionAdmission}),error=>error.code==='seller_state_unverified'&&/another presentation/.test(error.message));
});
// DACS-2 VPC-3: a session another opener saved after this instance verified its
// retained evidence is refused by every live read, however exact its shapes.
test('live reads refuse a shape-valid session another writer saved after open',async t=>{
 const f=fixture(t),agent=await f.open();t.after(()=>agent.close());
 const issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}),bundle=presentWith(buyer,issued.sessionNonce);
 const session={...sessionFor(JOB,bundle,{buyer:vetRef(JOB,buyer.claim,seller.claim),seller:vetRef(JOB,seller.claim,buyer.claim)}),paymentWork:{txHash:'a'.repeat(64),payerPayingKey:buyer.claim}};
 await saveSession(f,session,state=>admitWith(state,issued.sessionNonce,session));
 for(const read of [()=>agent.stageOf(JOB),()=>agent.durableSessionOf(JOB),()=>agent.transportAgreementOf(JOB),()=>agent.deliveryStateOf(JOB),()=>agent.durableSessions()])
  assert.throws(read,error=>error.code==='seller_state_unverified'&&/not verified by this seller instance/.test(error.message));
 assert.equal(agent.retainsPaymentClaim(JOB,{txHash:'0x'+'a'.repeat(64),payerPayingKey:buyer.claim}),false,'an unverified session retains no payment claim');
});
test('live reads refuse a retained session changed after this instance verified it',async t=>{
 const {f,admission}=await vettedSession(t),agent=await f.open({sessionAdmission:admission.sessionAdmission});t.after(()=>agent.close());
 assert.equal(agent.stageOf(JOB),'vetted');
 const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing)});
 try{await state.withJob(JOB,()=>state.saveSession({...state.loadSession(JOB),stage:'delivered'}));}finally{state.close();}
 assert.throws(()=>agent.stageOf(JOB),error=>error.code==='seller_state_unverified'&&/changed after this seller instance verified it/.test(error.message));
});
// DACS-2 §7.7.2: the seller bundle a buyer signs must be the Listing identity
// or a signed presentation of it, never an altered bundle with its own Vet record.
test('restart refuses a retained seller bundle that is not the Listing identity or a valid presentation',async t=>{
 for(const [label,build] of [
  ['an added claim',listing=>({...structuredClone(listing.seller.identity),claims:[...listing.seller.identity.claims,{ref:'did:demos:agent:'+'c'.repeat(64)}]})],
  ['an invalid presentation signature',()=>{const bundle=presentWith(seller,'ab'.repeat(32));bundle.presentation.signatures[0].signature=Buffer.alloc(64,1).toString('base64url');return bundle;}],
 ]) {
  const f=fixture(t),signerKey={claim:seller.claim,sign:seller.signBytes},buyerKey={claim:buyer.claim,sign:buyer.signBytes};
  const admission=createSessionAdmissionFixture({seller:signerKey,buyer:buyerKey,now:()=>NOW});
  const agent=await f.open({sessionAdmission:admission.sessionAdmission}),issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
  const bundle=presentWith(buyer,issued.sessionNonce),sellerBundle=build(f.listing);
  const buyerRef=await admission.vetRecord(JOB,buyer.claim,bundle,{requirement:f.listing.buyerRequirement});
  const sellerRef=await admission.vetRecord(JOB,seller.claim,sellerBundle,{requirement:f.listing.buyerRequirement});
  const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing)});
  try{
   admitWith(state,issued.sessionNonce,{buyerBundle:bundle});
   await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:bundle,buyerBundleHash:core.identityBundleHash(bundle),sellerBundle,stage:'vetted',vetCheckpoint:{buyer:buyerRef,seller:sellerRef}}));
  }finally{state.close();}
  await assert.rejects(f.open({sessionAdmission:admission.sessionAdmission}),
   error=>error.code==='seller_state_unverified'&&/seller (?:.*not a presentation of the Listing identity|.*presentation does not verify)/.test(error.message),label);
 }
});
// A receipt reader failure is not a missing receipt: timeout, refusal and a
// genuinely absent receipt stay distinguishable, and the cause is kept.
test('a retained receipt read failure keeps its cause and only a missing result reports no receipt',async t=>{
 for(const [code,pattern] of [['ENOENT',/has no SR-2 receipt/],['ETIMEDOUT',/cannot be read \(ETIMEDOUT\)/],['EACCES',/cannot be read \(EACCES\)/]]){
  const {f,admission}=await vettedSession(t);
  const readVetAnchorReceipt=async()=>{throw Object.assign(new Error(`receipt reader ${code}`),{code});};
  await assert.rejects(f.open({sessionAdmission:{...admission.sessionAdmission,readVetAnchorReceipt}}),
   error=>error.code==='seller_state_unverified'&&pattern.test(error.message)&&error.cause?.code===code);
 }
});
// DACS-1 RB-4..RB-6: the seller opens a new session only when the operator's
// own readers find the Listing not revoked, and refuses before any nonce is
// retained when the reading is revoked (409) or indeterminate (503).
test('a new session is gated by the operator revocation reading before a nonce is retained',async t=>{
 const revokedSurface=async listing=>{
  const pin=listingPin(listing);
  const marker=await core.signComponentArtifact({listingId:listing.listingId,listingVersion:listing.listingVersion,listingContentHash:pin.contentHash,revokedAt:NOW,reason:'TEST revoked'},'dacs-revocation:v1:',{algorithm:'ed25519',signer:seller.claim,sign:seller.signBytes});
  return{marker,surfaces:[{kind:'well-known',status:'revoked',integrity:'verified',binding:{sellerPrimaryClaim:seller.claim,listingId:listing.listingId,listingVersion:listing.listingVersion,listingContentHash:pin.contentHash,logicalAddress:`dacs1-revoked:${core.encodeAddressSegment(seller.claim)}:${listing.listingId}:v${listing.listingVersion}`,markerAnchor:{kind:'storage-program',locator:'TEST-marker'},markerContentHash:core.contentHash(marker)}}]};
 };
 const f=fixture(t),revoked=await revokedSurface(f.listing);
 f.admission.markers.set('TEST-marker',revoked.marker);
 f.admission.readRevocationWith(()=>revoked.surfaces);
 const agent=await f.open();t.after(()=>agent.close());
 const readings=()=>f.admission.calls.filter(([name])=>name==='readRevocationSurfaces').length;
 await assert.rejects(agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}),error=>error.code==='session_not_admitted'&&error.status===409);
 assert.equal(readings(),1,'the operator revocation reader is asked before a session opens');
 f.admission.readRevocationWith(()=>{throw new Error('revocation reader down');});
 await assert.rejects(agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}),error=>error.code==='session_admission_unavailable'&&error.status===503);
 f.admission.readRevocationWith(null);
 const issued=await agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});
 assert.match(issued.sessionNonce,/^[0-9a-f]{64}$/);
 assert.equal(readings(),3,'an active reading is required for every new session');
});
test('a native seller without a session admission cannot open a session',async t=>{
 const f=fixture(t),agent=await f.open({sessionAdmission:undefined});t.after(()=>agent.close());
 await assert.rejects(agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}),error=>error.code==='session_admission_required'&&error.status===503);
});
// The construction check proves the Listing's own bytes, signature and rail;
// its fabricated catalog row is not a revocation reading and is not retained.
test('the retained Listing admission never records a revocation reading',async t=>{
 const f=fixture(t),agent=await f.open();agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing)});
 try{const context=state.context();assert.equal(context.validation.disposition,'verified');assert.equal(Object.hasOwn(context.validation,'revocation'),false,'the construction check is not a revocation reading');}finally{state.close();}
});
// A close during the live revocation read must not let the issuance settle:
// the nonce is not retained and the caller sees the same coded refusal as any
// other operation on a closed agent.
test('a close during the live revocation read refuses the issuance',async t=>{
 const f=fixture(t);let release;const gate=new Promise(resolve=>{release=resolve;});
 f.admission.readRevocationWith(()=>gate);
 const agent=await f.open();t.after(()=>agent.close());
 const pending=agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});
 agent.close();
 release([{kind:'catalog',status:'active',readStatus:'ok',catalogObservedAt:NOW}]);
 await assert.rejects(pending,error=>error.code==='seller_closed'&&error.status===503);
});
