import test from 'node:test';
import assert from 'node:assert/strict';
import {agentFixture} from './helpers/seller-agent-isolated-fixture.mjs';
import {JOBS} from './helpers/bilateral-vet-fixture.mjs';

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
