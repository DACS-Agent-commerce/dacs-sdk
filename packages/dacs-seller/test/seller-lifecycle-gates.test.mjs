import test from 'node:test';
import assert from 'node:assert/strict';
import {agentFixture} from './helpers/seller-agent-isolated-fixture.mjs';
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
 const w=await agentFixture({lifecycle:true});try{w.anchors.controls.timestamp=1800000000000-70000;await assert.rejects(w.agent.commit({jobId}),{code:'commitment_failed'});}finally{w.close();}
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
