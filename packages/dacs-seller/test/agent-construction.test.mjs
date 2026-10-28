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
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'TEST-agent-construction-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const listing=fixtureListing(seller,{now:NOW}),signer={claim:seller.claim,sign:seller.signBytes},unreachable=()=>assert.fail('unexpected external operation');let time=NOW;
 const config={signer,listing,durableDirectory:dir,now:()=>time,agreementAnchor:{source:'TEST-native',readAgreement:unreachable},nativeArtifactAnchor:{writer:seller.claim,publish:unreachable,readRetained:unreachable,verifyReceipt:unreachable},deliverableProducer:unreachable,deliverySchemaVerifier:{schemaUrl:listing.offering.deliverable.schemaUrl,verify:unreachable},railAuthority:railSteward().railAuthority()};
 return{config,dir,listing,signer,advance:ms=>{time+=ms;},open:changes=>createSellerAgent({...config,...changes})};
}
// A buyer presentation that carries exactly the nonce the seller issued.
const presentWith=(party,sessionNonce)=>{
 const unsigned=buildUnsignedIdentityBundle({address:party.address,presentedAt:NOW-1000,sessionSeed:'construction',sessionNonce});
 return attachIdentityPresentation(unsigned,'0x'+party.signBytes(unsigned.message).toString('hex'));
};
const vetRef=(jobId,party,verifier)=>({anchor:{kind:'storage-program',locator:core.compositeVerificationAddress(jobId,party)},contentHash:'b'.repeat(64),signer:verifier});
const sessionFor=(jobId,bundle,checkpoint)=>({jobId,buyerBundle:bundle,buyerBundleHash:core.identityBundleHash(bundle),stage:'vetted',vetCheckpoint:checkpoint});
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
 const f=fixture(t),agent=await f.open(),issued=agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 const reopened=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing)});try{const prior=reopened.attemptChallenge(issued.sessionNonce,{presentationHash:'a'.repeat(64)});assert.deepEqual(prior,{kind:'session-challenge',...issued,attempt:null});}finally{reopened.close();}
});
for(const durable of [true,false])test(`${durable?'durable':'memory'} challenges enforce total capacity and stop counting expired unused nonces`,async t=>{
 const f=fixture(t),options={maxJobs:1,...durable?{}:{durableDirectory:undefined}},agent=await f.open(options);let current=agent;
 t.after(()=>current.close());const first=agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});assert.throws(()=>agent.issueSessionChallenge({jobId:'01J8N4YV7YVYQ4DB7M8T4C7W0B',buyer:buyer.claim}),e=>e.code==='seller_challenge_capacity');
 if(durable){agent.close();current=await f.open(options);assert.throws(()=>current.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}),e=>e.code==='seller_challenge_capacity');}
 f.advance(first.expiresAt-NOW);assert.notEqual(current.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}).sessionNonce,first.sessionNonce);
});
for(const durable of [true,false])test(`${durable?'durable':'memory'} closed agents refuse every public operation`,async t=>{
 const f=fixture(t),agent=await f.open(durable?{}:{durableDirectory:undefined});agent.close();agent.close();
 for(const [name,operation]of Object.entries(agent))if(typeof operation==='function'&&name!=='close')assert.throws(()=>operation(name==='issueSessionChallenge'?{jobId:JOB,buyer:buyer.claim}:JOB),e=>e.code==='seller_closed',name);
});
test('the partial constructor is absent from the public package entry',async()=>{
 const entry=await import('../src/index.mjs');assert.equal(entry.createSellerAgent,undefined);
});

test('per-job challenge capacity applies before the global bound',async t=>{
 const f=fixture(t),agent=await f.open({maxJobs:32});t.after(()=>agent.close());for(let i=0;i<16;i++)agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});
 assert.throws(()=>agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}),e=>e.code==='seller_challenge_capacity');assert.ok(agent.issueSessionChallenge({jobId:'01J8N4YV7YVYQ4DB7M8T4C7W0B',buyer:buyer.claim}));
});
test('an expired unused challenge is retained across restart and does not consume live capacity',async t=>{
 const f=fixture(t),agent=await f.open({maxJobs:1}),issued=agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 f.advance(issued.expiresAt-NOW+1);
 const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing),maxJobs:1});
 try{assert.deepEqual(state.challenge(issued.sessionNonce),{kind:'session-challenge',...issued,attempt:null},'CORE SN-4 retains the unused issuance record');}finally{state.close();}
 const fresh=await f.open({maxJobs:1});try{assert.ok(fresh.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}));}finally{fresh.close();}
});
test('an attempted, admitted challenge stays retained but does not consume live capacity after expiry',async t=>{
 const otherJob='01J8N4YV7YVYQ4DB7M8T4C7W0B';
 const f=fixture(t),agent=await f.open({maxJobs:1}),issued=agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing),maxJobs:1});
 try{state.attemptChallenge(issued.sessionNonce,{presentationHash:'a'.repeat(64)});state.admitChallenge(issued.sessionNonce,'a'.repeat(64));}finally{state.close();}
 f.advance(issued.expiresAt-NOW+1);
 const fresh=await f.open({maxJobs:1});try{assert.ok(fresh.issueSessionChallenge({jobId:otherJob,buyer:buyer.claim}),'a consumed challenge is a retained tombstone, not a live slot');}finally{fresh.close();}
 const reopened=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing),maxJobs:1});
 try{assert.deepEqual(reopened.challenge(issued.sessionNonce).attempt,{presentationHash:'a'.repeat(64),admitted:true});}finally{reopened.close();}
});
test('malformed challenge requests are coded refusals',async t=>{
 const f=fixture(t),agent=await f.open();t.after(()=>agent.close());
 for(const request of [null,undefined,42,'challenge',[]])assert.throws(()=>agent.issueSessionChallenge(request),error=>error instanceof SellerAgentError&&error.code==='challenge_invalid'&&error.status===422);
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
  const f=fixture(t),agent=await f.open(),issued=agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
  await saveSession(f,sessionFor(otherJob,presentWith(buyer,issued.sessionNonce),{buyer:vetRef(otherJob,buyer.claim,seller.claim),seller:vetRef(otherJob,seller.claim,buyer.claim)}));
  await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&/another job or buyer/.test(error.message));
 }
 {
  const f=fixture(t),agent=await f.open(),issued=agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
  await saveSession(f,sessionFor(JOB,presentWith(buyer,issued.sessionNonce),{buyer:vetRef(JOB,buyer.claim,seller.claim),seller:vetRef(JOB,seller.claim,buyer.claim)}));
  await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&/not consumed and admitted/.test(error.message));
 }
});
test('restart refuses a retained vetted session with no exact, job-bound, verifier-signed Vet checkpoint',async t=>{
 const f=fixture(t),agent=await f.open(),issued=agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 const bundle=presentWith(buyer,issued.sessionNonce);
 const admit=async session=>saveSession(f,session,state=>{state.attemptChallenge(issued.sessionNonce,{presentationHash:'a'.repeat(64)});state.admitChallenge(issued.sessionNonce,'a'.repeat(64));});
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
test('restart restores a session bound to its admitted challenge and to verified Vet records and receipts',async t=>{
 const f=fixture(t),signerKey={claim:seller.claim,sign:seller.signBytes},buyerKey={claim:buyer.claim,sign:buyer.signBytes};
 const admission=createSessionAdmissionFixture({seller:signerKey,buyer:buyerKey,now:()=>NOW});
 const agent=await f.open({sessionAdmission:admission.sessionAdmission}),issued=agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});agent.close();
 const bundle=presentWith(buyer,issued.sessionNonce);
 const buyerRef=await admission.vetRecord(JOB,buyer.claim,bundle,{requirement:f.listing.buyerRequirement});
 const sellerRef=await admission.vetRecord(JOB,seller.claim,f.listing.seller.identity,{requirement:f.listing.buyerRequirement});
 const state=await createSellerDurableState({dir:f.dir,signer:f.signer,listingPin:listingPin(f.listing)});
 try{
  state.attemptChallenge(issued.sessionNonce,{presentationHash:'a'.repeat(64)});state.admitChallenge(issued.sessionNonce,'a'.repeat(64));
  await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:bundle,buyerBundleHash:core.identityBundleHash(bundle),sellerBundle:f.listing.seller.identity,stage:'vetted',vetCheckpoint:{buyer:buyerRef,seller:sellerRef}}));
 }finally{state.close();}
 const fresh=await f.open({sessionAdmission:admission.sessionAdmission});
 try{assert.equal(fresh.stageOf(JOB),'vetted');assert.equal(fresh.durableSessionOf(JOB).vetCheckpoint.buyer.contentHash,buyerRef.contentHash);}finally{fresh.close();}
});
