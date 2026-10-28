import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readdirSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createSellerAgent} from '../src/dacs/seller-agent.mjs';
import {createSellerDurableState} from '../src/dacs/seller-durable-state.mjs';
import {fixtureListing} from './fixtures/listings.mjs';
import {seller,buyer,JOB,NOW} from './helpers/protocol-fixture.mjs';
import {railSteward} from './helpers/rail-authority-fixture.mjs';
import {listingPin} from '../src/dacs/purchase-protocol.mjs';
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'TEST-agent-construction-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const listing=fixtureListing(seller,{now:NOW}),signer={claim:seller.claim,sign:seller.signBytes},unreachable=()=>assert.fail('unexpected external operation');let time=NOW;
 const config={signer,listing,durableDirectory:dir,now:()=>time,agreementAnchor:{source:'TEST-native',readAgreement:unreachable},nativeArtifactAnchor:{writer:seller.claim,publish:unreachable,readRetained:unreachable,verifyReceipt:unreachable},deliverableProducer:unreachable,deliverySchemaVerifier:{schemaUrl:listing.offering.deliverable.schemaUrl,verify:unreachable},railAuthority:railSteward().railAuthority()};
 return{config,dir,listing,signer,advance:ms=>{time+=ms;},open:changes=>createSellerAgent({...config,...changes})};
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
