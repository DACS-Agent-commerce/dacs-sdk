import test from 'node:test';
import assert from 'node:assert/strict';
import {agentFixture} from './helpers/seller-agent-isolated-fixture.mjs';
import {NOW} from './helpers/protocol-fixture.mjs';
import {JOBS} from './helpers/bilateral-vet-fixture.mjs';

for(const accessModel of ['buyer-only','encrypt-to-buyer','private','restricted','encrypted',{},false])test(`seller refuses non-public delivery access ${JSON.stringify(accessModel)} before publication`,async()=>{
 const w=await agentFixture();
 try{
  w.listing.offering.deliverable={accessModel};
  await assert.rejects(w.createAgent(),/seller delivery requires public access/);
 }finally{w.close();}
});

test('seller payment, early commitment and completion gates refuse before any external capability',async()=>{
 const w=await agentFixture();
 try{
  await assert.rejects(w.agent.submitPayment({jobId:JOBS[0],txHash:'a'.repeat(64),payerPayingKey:w.buyer.claim}),{code:'not_committed'});
  await assert.rejects(w.agent.commitOnSignature({jobId:JOBS[0],agreement:{},signedProjection:{}}),{code:'signature_commitment_disabled'});
  await assert.rejects(w.agent.bundleRequest({jobId:JOBS[0]}),{code:'not_delivered'});
 }finally{w.close();}
});
test('recovered seller caller withdraws old delivered credit and completion authority for every collision participant',async()=>{
 const w=await agentFixture({paid:true,collision:true});
 try{
  for(const jobId of JOBS){
   await assert.rejects(w.agent.submitPayment({jobId,txHash:'a'.repeat(64),payerPayingKey:w.buyer.claim}),{code:'settlement_collision'});
   await assert.rejects(w.agent.bundleRequest({jobId}),{code:'settlement_collision'});
   await assert.rejects(w.agent.countersign({jobId,buyerSignature:'fixture'}),{code:'settlement_collision'});
   await assert.rejects(w.agent.confirmBuyerCopy({jobId}),{code:'settlement_collision'});
   assert.equal(w.agent.stageOf(jobId),'settlement-indeterminate');
   assert.equal(w.agent.durableSessionOf(jobId).settlementCredit,'indeterminate');
   assert.throws(()=>w.agent.assertSettlementCredit(jobId),{code:'settlement_collision'});
  }
 }finally{w.close();}
});

import * as core from '@kynesyslabs/dacs';
import * as local from './helpers/local-anchor-fixture.mjs';
const HASH='a'.repeat(64),jobId=JOBS[0];
const payment=w=>({jobId,txHash:HASH,payerPayingKey:w.buyer.claim});
const NO_ST11={code:'bundle_finalization_unavailable',status:503};
// DACS-5 ST-11 / CORE SR2-9: the seller signs no completed bundle while the
// finalizer that resolves and finalizes every required record is not wired.
test('seller caller requires a finalized valid commitment receipt and its authoritative time',async()=>{
 for(const state of ['accepted','unknown']){
  const w=await agentFixture({lifecycle:true});try{w.anchors.controls.state=state;await assert.rejects(w.agent.commit({jobId}),{code:'commitment_failed'});assert.equal(w.store.loadSession(jobId).commitment,undefined);await assert.rejects(w.agent.submitPayment(payment(w)),{code:'not_committed'});}finally{w.close();}
 }
 const w=await agentFixture({lifecycle:true});try{w.anchors.controls.timestamp=NOW-70000;await assert.rejects(w.agent.commit({jobId}),{code:'commitment_failed'});}finally{w.close();}
});
test('real seller proposal responder advances a negotiated Agreement through commitment and delivery',async()=>{
 const w=await agentFixture({lifecycle:true}),next='01ARZ3NDEKTSV4RRFFQ69G5FAY';
 try{
  const input=await w.negotiate(next);assert.equal(input.agreement.jobId,next);
  assert.equal((await w.agent.commit({jobId:next})).status,'committed');
  assert.equal((await w.agent.submitPayment({...payment(w),jobId:next})).status,'delivered');
 }finally{w.close();}
});
test('early commitment caller requires independent exact buyer CREATE authorization before every effect',async()=>{
 const w=await agentFixture({lifecycle:true,early:true}),next='01ARZ3NDEKTSV4RRFFQ69G5FAY';
 try{
  const input=await w.negotiate(next,{anchor:false}),before=w.anchors.writes.length;
  for(const mutate of [r=>{delete r.signedProjection},r=>{r.signedProjection.signature.data='A'.repeat(86)},r=>{r.signedProjection.content.data[1].metadata.logicalAddress='other'},r=>{r.signedProjection.content.from='0x'+w.seller.claim.slice(16)},r=>{r.agreement.terms.price.amount='1'}]){
   const changed=structuredClone(input);mutate(changed);
   if(changed.signedProjection&&JSON.stringify(changed.signedProjection.content)!==JSON.stringify(input.signedProjection.content)){
    changed.signedProjection.hash=core.sha256Hex(JSON.stringify(changed.signedProjection.content));changed.signedProjection.signature.data=w.buyer.sign(Buffer.from(changed.signedProjection.hash)).toString('base64url');
   }
   await assert.rejects(w.agent.commitOnSignature(changed),{code:'signature_agreement_invalid'});
   assert.equal(w.anchors.writes.length,before);assert.equal(w.store.loadSession(next).signatureCommitmentAttempt,undefined);
  }
  assert.equal((await w.agent.commitOnSignature(input)).status,'commitment-held');
  await assert.rejects(w.agent.submitPayment({...payment(w),jobId:next}),{code:'not_committed'});
 }finally{w.close();}
});

test('exported seller fixture report refuses malformed jobs before deriving terms or hashing',async()=>{
 const w=await agentFixture();
 try{for(const jobId of [undefined,null,'job-0',JOBS[0].toLowerCase()])assert.throws(()=>w.buildReport({agreement:{jobId}}),{code:'job_invalid'});}finally{w.close();}
});

test('delivered collision-free sessions refuse both finalization operations before any new state or signature',async()=>{
 const w=await agentFixture({lifecycle:true});try{await w.agent.commit({jobId});assert.equal((await w.agent.submitPayment(payment(w))).status,'delivered');const saved=w.agent.durableSessionOf(jobId),writes=w.anchors.writes.length;await assert.rejects(w.agent.bundleRequest({jobId}),NO_ST11);await assert.rejects(w.agent.countersign({jobId,buyerSignature:'TEST'}),NO_ST11);assert.deepEqual(w.agent.durableSessionOf(jobId),saved);assert.equal(w.anchors.writes.length,writes);}finally{w.close();}
});
for(const problem of ['absent','changed','unavailable','failed-transfer','payer','ref','deliverableRef','deliveryRef'])test(`retained fixture delivery requires fresh ${problem} readback after restart`,async()=>{
 const w=await agentFixture({lifecycle:true});try{await w.agent.commit({jobId});assert.equal((await w.agent.submitPayment(payment(w))).status,'delivered');await w.reopen();const writes=w.anchors.writes.length;
 if(['ref','deliverableRef','deliveryRef'].includes(problem)){const target=w.agent.durableSessionOf(jobId).payment[problem].anchor.locator;w.anchors.controls.read=(row,address)=>address===target?{...row,artifact:{...row.artifact,jobId:'TEST-changed'}}:row;}
 else if(problem==='failed-transfer')w.controls.observation={status:'failed'};
 else if(problem!=='payer')w.anchors.controls.read=(row,address)=>{if(address!==core.finalityCommitmentAddress(jobId))return row;if(problem==='unavailable')throw new Error('TEST reader unavailable');if(problem==='absent')return{status:'absent'};return{...row,artifact:{...row.artifact,jobId:'TEST-changed'}};};
 await assert.rejects(w.agent.submitPayment({...payment(w),...problem==='payer'?{payerPayingKey:w.seller.claim}:{}}));assert.equal(w.anchors.writes.length,writes);
 }finally{w.close();}
});

test('retained fixture payment succeeds only after unchanged fresh transfer and artifacts verify',async()=>{
 const w=await agentFixture({lifecycle:true});try{await w.agent.commit({jobId});const answer=await w.agent.submitPayment(payment(w));await w.reopen();assert.deepEqual(await w.agent.submitPayment(payment(w)),answer);}finally{w.close();}
});

for(const status of ['failed','unavailable','changed'])test(`interrupted fixture payment reauthenticates ${status} transfer before resuming publication`,async()=>{
 const w=await agentFixture({lifecycle:true});
 try{
  await w.agent.commit({jobId});
  const address=core.paymentEvidenceAddress(jobId,'demos-native:DEM',2);
  w.anchors.controls.failAfterWrite=address;
  await assert.rejects(w.agent.submitPayment(payment(w)),{code:'seller_anchor_reconciliation_required'});
  const retained=w.agent.durableSessionOf(jobId).paymentWork;
  await w.reopen();
  assert.notEqual((await w.store.reconcileJob(jobId,w.anchors)).status,'held');
  const writes=w.anchors.writes.length;
  w.controls.observation=status==='changed'
   ?{status:'included',txHash:HASH,payer:w.buyer.address,payee:w.seller.address,amountOs:'2500000000',blockNumber:9,includedAt:NOW+4000}
   :{status,reason:'TEST transfer readback '+status};
  let answer;
  try{answer=await w.agent.submitPayment(payment(w));}catch(error){assert.equal(error.code,'payment_readback_required');}
  assert.notEqual(answer?.status,'delivered');
  assert.equal(w.anchors.writes.length,writes,'no deliverable or delivery evidence is published from cached intake');
  assert.deepEqual(w.agent.durableSessionOf(jobId).paymentWork,retained,'the original payment work stays exact');
  w.controls.observation=null;
  assert.equal((await w.agent.submitPayment(payment(w))).status,'delivered');
  assert.equal(w.anchors.writes.filter(value=>value===address).length,1,'recovery reuses the original payment evidence CREATE');
 }finally{w.close();}
});

for(const selector of ['', 'TEST-unknown'])test(`unknown payment selector ${JSON.stringify(selector)} has no effects`,async()=>{
 const w=await agentFixture();try{await w.agent.commit({jobId});const before=w.anchors.writes.length;
 await assert.rejects(w.agent.submitPayment({...payment(w),nativePaymentEvidence:selector}),{code:'native_evidence_selector_invalid'});
 assert.equal(w.anchors.writes.length,before);assert.equal(w.agent.durableSessionOf(jobId).paymentWork,undefined);
 }finally{w.close();}
});

test('prefixed and plain transaction hashes replay one retained fixture settlement',async()=>{
 const w=await agentFixture();try{await w.agent.commit({jobId});const answer=await w.agent.submitPayment({...payment(w),txHash:'0x'+HASH}),before=w.anchors.writes.length;
 await w.reopen();assert.deepEqual(await w.agent.submitPayment(payment(w)),answer);assert.equal(w.anchors.writes.length,before);
 }finally{w.close();}
});

test('observer limits and cancellation reach the configured fixture observer',async()=>{
 const w=await agentFixture();try{await w.agent.commit({jobId});let options;
 w.config.observeDemosTransfer=async(hash,limits)=>{options=limits;return {status:'unavailable',reason:'TEST source unavailable'};};
 const agent=await w.createAgent();try{assert.notEqual((await agent.submitPayment(payment(w))).status,'delivered');assert.equal(options.maxBytes,65536);assert.equal(options.timeoutMs,10000);assert.equal(options.signal.aborted,true);}finally{agent.close();}
 }finally{w.close();}
});

test('authenticated fixture payments refuse before reserving transport work',async()=>{
 const w=await agentFixture();try{await w.agent.commit({jobId});
 const {createSellerHttpHandler}=await import('../src/dacs/seller-http.mjs'),{exchange}=await import('./helpers/d5-http-fixture.mjs');
 const before=w.anchors.writes.length,request={jobId};
 const authentication={seller:w.agent.claim,listingPin:w.agent.listingPin,store:{reserve(){assert.fail('payment reached transport reservation');}},readRequest:()=>request,validate(){},responseHeader:async()=> 'TEST-header'};
 const handler=createSellerHttpHandler(w.agent,{authentication});
 const result=await exchange(handler,{url:'/dacs/v1/payments',text:JSON.stringify(payment(w))});
 assert.equal(result.status,503);assert.equal(JSON.parse(result.text).error,'settlement_profile_unavailable');assert.equal(w.anchors.writes.length,before);
 }finally{w.close();}
});
