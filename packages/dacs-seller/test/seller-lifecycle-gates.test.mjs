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
test('seller caller commits, accepts verified payment and delivers, but signs no completed bundle, before or after a restart',async()=>{
 const w=await agentFixture({lifecycle:true});
 try{
  assert.equal((await w.agent.commit({jobId})).status,'committed');
  assert.equal(w.store.loadSession(jobId).commitment.committedAt,1800000001000,'CA-8 uses receipt block time, not record/local time');
  assert.equal((await w.agent.submitPayment(payment(w))).status,'delivered');
  const writes=w.anchors.writes.length;
  const unsigned=()=>{const session=w.store.loadSession(jobId);assert.equal(session.finalisedAt,undefined);assert.equal(session.bundleHash,undefined);assert.equal(session.sellerBundleSignature,undefined);assert.equal(session.sellerCopy,undefined);};
  for(let round=0;round<2;round++){
   await assert.rejects(w.agent.bundleRequest({jobId}),NO_ST11);
   await assert.rejects(w.agent.countersign({jobId,buyerSignature:'fixture'}),NO_ST11);
   await assert.rejects(w.agent.confirmBuyerCopy({jobId}),{code:'no_seller_copy'});
   const agreementHash=w.store.loadSession(jobId).agreementHash;
   for(const path of ['/dacs/v1/bundles/request','/dacs/v1/bundles/countersignature']){
    const body=path.endsWith('request')?{jobId}:{jobId,buyerSignature:'fixture'},rawBody=Buffer.from(JSON.stringify(body));
    const request={method:'POST',path,jobId,buyer:w.buyer.claim,seller:w.seller.claim,listingPin:w.pin,agreementHash,bodyHash:core.sha256Hex(rawBody)};
    assert.deepEqual(await w.agent.reconcileTransport({request,body,rawBody}),{disposition:'indeterminate',reason:'bundle_finalization_unavailable'},path);
   }
   unsigned();assert.equal(w.anchors.writes.length,writes,'no bundle copy is anchored');
   await w.reopen();
   assert.equal((await w.agent.submitPayment(payment(w))).status,'delivered');assert.equal(w.anchors.writes.length,writes);
  }
 }finally{w.close();}
});
for(const [name,change] of [
 ['wrong transfer hash',o=>({...o,txHash:'b'.repeat(64)})],
 ['wrong amount',o=>({...o,amountOs:'2499999999'})],
 ['wrong payee',o=>({...o,payee:'c'.repeat(64)})],
 ['wrong payer',o=>({...o,payer:'c'.repeat(64)})],
 ['pending receipt',()=>({status:'pending'})],
 ['unavailable receipt',()=>({status:'unavailable',reason:'RPC unavailable'})],
])test(`seller caller refuses ${name} before payment evidence or delivery`,async()=>{
 const w=await agentFixture({lifecycle:true});
 try{await w.agent.commit({jobId});const writes=w.anchors.writes.length;
  w.controls.observation=change({status:'included',txHash:HASH,payer:w.buyer.claim.slice(16),payee:w.seller.claim.slice(16),amountOs:'2500000000',blockNumber:8,includedAt:1800000002000});
  const out=await w.agent.submitPayment(payment(w));assert.ok(['rejected','indeterminate'].includes(out.status),JSON.stringify(out));
  assert.equal(w.anchors.writes.length,writes);assert.equal(w.store.loadSession(jobId).payment,undefined);
 }finally{w.close();}
});
test('seller caller requires a finalized valid commitment receipt and its authoritative time',async()=>{
 for(const state of ['accepted','unknown']){
  const w=await agentFixture({lifecycle:true});try{w.anchors.controls.state=state;await assert.rejects(w.agent.commit({jobId}),{code:'commitment_failed'});assert.equal(w.store.loadSession(jobId).commitment,undefined);await assert.rejects(w.agent.submitPayment(payment(w)),{code:'not_committed'});}finally{w.close();}
 }
 const w=await agentFixture({lifecycle:true});try{w.anchors.controls.timestamp=1800000000000-70000;await assert.rejects(w.agent.commit({jobId}),{code:'commitment_failed'});}finally{w.close();}
});
test('retained payment response requires exact evidence address, reference and delivery hash readback',async()=>{
 const w=await agentFixture({lifecycle:true});
 try{
  await w.agent.commit({jobId});await w.agent.submitPayment(payment(w));
  const body=payment(w),rawBody=Buffer.from(JSON.stringify(body)),agreementHash=w.store.loadSession(jobId).agreementHash;
  const request={method:'POST',path:'/dacs/v1/payments',jobId,buyer:w.buyer.claim,seller:w.seller.claim,listingPin:w.pin,agreementHash,bodyHash:core.sha256Hex(rawBody)};
  const read=()=>w.agent.reconcileTransport({request,body,rawBody});
  const good=await read();assert.equal(good.disposition,'present',JSON.stringify(good));
  const paymentAddress=core.paymentEvidenceAddress(jobId,'demos-native:DEM',2),deliverableAddress=w.protocol.deliverableAddress(jobId),deliveryAddress=w.protocol.deliveryEvidenceAddress(jobId);
  for(const [target,change] of [
   [paymentAddress,row=>({...row,receipt:{...row.receipt,logicalAddress:'wrong-address'}})],
   [paymentAddress,row=>({...row,receipt:{...row.receipt,contentHash:'f'.repeat(64)}})],
   [deliverableAddress,row=>({...row,artifact:{...row.artifact,body:['changed bytes']}})],
   [deliveryAddress,row=>({...row,artifact:{...row.artifact,deliverableContentHash:'f'.repeat(64)}})],
  ]){
   const writes=w.anchors.writes.length;w.anchors.controls.read=(row,address)=>address===target?change(row):row;
   assert.equal((await read()).disposition,'indeterminate');assert.equal(w.anchors.writes.length,writes);
  }
  w.anchors.controls.read=row=>row;assert.equal((await read()).disposition,'present');
 }finally{w.close();}
});
test('lost evidence write answer recovers from exact retained bytes without signing or writing again',async()=>{
 const w=await agentFixture({lifecycle:true});
 try{
  await w.agent.commit({jobId});w.anchors.controls.failAfterWrite=core.paymentEvidenceAddress(jobId,'demos-native:DEM',2);
  await assert.rejects(w.agent.submitPayment(payment(w)),{code:'seller_anchor_reconciliation_required'});
  const address=core.paymentEvidenceAddress(jobId,'demos-native:DEM',2),original=structuredClone(w.anchors.rows.get(address));
  await w.reopen();assert.equal((await w.agent.submitPayment(payment(w))).status,'delivered');
  assert.deepEqual(w.anchors.rows.get(address),original);assert.equal(w.anchors.writes.filter(a=>a===address).length,1);
 }finally{w.close();}
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
