// P1 regression coverage for the authenticated seller /payments uncertainty
// reducer. Owned loopback only; no public Node, wallet, faucet or payment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { contentHash, sha256Hex } from '@kynesyslabs/dacs';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { acceptedCreates, kindOf } from './helpers/review-native-delivery-coverage-reader.mjs';
import { NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';

const STATE_DOMAIN='dacs-chatgpt-plugin:offline-seller-state:v1:';
const effects=async(w)=>({kinds:acceptedCreates(w).map(kindOf).sort(),attempts:w.h.chain.wire.record.broadcastAttempts.length,
  payments:w.h.chain.record.broadcasts.length,approvals:w.seller.sellerApprovals.length,evidence:w.seller.evidenceAttempts.length});
function transportInput(w,jobId,body){const rawBody=Buffer.from(JSON.stringify(body));return{request:{method:'POST',path:'/dacs/v1/payments',jobId,
  seller:w.seller.wallet.claim,buyer:w.buyerActor.signer.claim,listingPin:w.seller.agent.listingPin,
  agreementHash:w.op().state.protocol.agreement.hash,bodyHash:sha256Hex(rawBody)},body,rawBody};}
function failAfterEvidenceApply(w){const original=w.seller.wallet.signBytes,fault={fired:0};w.seller.wallet.signBytes=(bytes)=>{
  const text=Buffer.from(bytes).toString('utf8');
  if(!fault.fired&&text.startsWith(STATE_DOMAIN)&&text.includes('"nativeEvidenceWork"')&&text.includes('"anchorAnswer"')){
    fault.fired+=1;throw new Error('TEST seller checkpoint unavailable after SettlementEvidence apply');
  }
  return original(bytes);
};return fault;}
function oneShotMarker(name){const path=join(tmpdir(),`${name}-${process.pid}.json`);writeFileSync(path,JSON.stringify({name,pid:process.pid,createdAt:new Date().toISOString()}),{flag:'wx',mode:0o600});return path;}

const paid=async(t)=>{
  const w=await sourceDemoFlow(t);assert.equal((await w.agreement()).status,'awaiting_approval');
  await new Promise((resolve)=>setTimeout(resolve,1050));
  const {handoff}=await w.approve();assert.equal(handoff.status,'payment_handoff',JSON.stringify(handoff));
  const sent=await w.send(handoff.payload);assert.equal(sent.success,true,JSON.stringify(sent));
  return{w,sent,jobId:w.op().terms.protocol.jobId};
};

test('P1: uncertain cached payment authenticates the applied SettlementEvidence and resumes the same SDK permit without resend', {timeout:180000}, async t=>{
  const marker=oneShotMarker('seller-uncertain-payment-recovery');
  const {w,sent,jobId}=await paid(t),txHash=sent.data.hash,payer=w.buyerActor.signer.claim;
  const body={jobId,txHash,payerPayingKey:payer,nativePaymentEvidence:NATIVE_PAYMENT_EVIDENCE};
  const fault=failAfterEvidenceApply(w),first=(await w.api('report',{txHash})).evidence;
  assert.equal(fault.fired,1);assert.notEqual(first.protocol.stage,'delivery-ready');
  assert.deepEqual((await effects(w)).kinds,['Agreement','SettlementEvidence']);
  assert.equal(w.seller.evidenceAttempts.length,1);assert.equal(w.h.chain.record.broadcasts.length,1);
  await w.h.restart();await w.seller.restart();
  const beforeNegative=await effects(w),accepted=w.h.chain.wire.record.accepted;
  const evidenceIndex=accepted.findIndex((tx)=>kindOf(tx)==='SettlementEvidence');assert.ok(evidenceIndex>=0);
  const original=structuredClone(accepted[evidenceIndex]),evidenceAddress=original.content.to;
  accepted.splice(evidenceIndex,1);
  const missing=await w.seller.agent.reconcileTransport(transportInput(w,jobId,body));
  assert.notEqual(missing.disposition,'present');
  accepted.splice(evidenceIndex,0,original);
  assert.deepEqual(await effects(w),beforeNegative);
  const nativeFault=w.h.chain.faults.native;
  w.h.chain.faults.native=(native)=>native.storageAddress===evidenceAddress?{unexpected:'TEST malformed evidence read'}:native;
  const ambiguous=await w.seller.agent.reconcileTransport(transportInput(w,jobId,body));
  assert.notEqual(ambiguous.disposition,'present');assert.deepEqual(await effects(w),beforeNegative);
  w.h.chain.faults.native=(native)=>native.storageAddress===evidenceAddress?{...native,owner:w.address}:native;
  const wrongWriter=await w.seller.agent.reconcileTransport(transportInput(w,jobId,body));
  assert.notEqual(wrongWriter.disposition,'present');assert.deepEqual(await effects(w),beforeNegative);
  w.h.chain.faults.native=(native)=>native.storageAddress===evidenceAddress?{...native,data:{...native.data,outcome:'failure'}}:native;
  const wrongContent=await w.seller.agent.reconcileTransport(transportInput(w,jobId,body));
  assert.notEqual(wrongContent.disposition,'present');assert.deepEqual(await effects(w),beforeNegative);
  w.h.chain.faults.native=nativeFault;
  const wrongPayment=await w.seller.agent.reconcileTransport(transportInput(w,jobId,{...body,txHash:`0x${'ab'.repeat(32)}`}));
  assert.notEqual(wrongPayment.disposition,'present');assert.deepEqual(await effects(w),beforeNegative);
  const otherJob=`${jobId.slice(0,-1)}${jobId.at(-1)==='0'?'1':'0'}`;
  const crossJob=await w.seller.agent.reconcileTransport(transportInput(w,otherJob,{...body,jobId:otherJob})).catch((error)=>({disposition:'indeterminate',reason:error.code??'error'}));
  assert.notEqual(crossJob.disposition,'present');assert.deepEqual(await effects(w),beforeNegative);
  const cached=(await w.api('report',{txHash})).evidence;
  const reduced=await w.seller.agent.reconcileTransport(transportInput(w,jobId,body));
  assert.equal(cached.protocol.stage,'delivery-ready',JSON.stringify({cached:cached.protocol,state:w.seller.agent.deliveryStateOf(jobId),errors:w.seller.functionalErrors,
    responses:w.seller.responses.slice(-4)}));
  assert.equal(reduced.disposition,'present',JSON.stringify({reduced,state:w.seller.agent.deliveryStateOf(jobId),errors:w.seller.functionalErrors}));
  assert.equal(reduced.value.delivery.status,'delivery-ready',JSON.stringify(reduced));
  const recovered=(await w.api('report',{txHash})).evidence;
  assert.equal(recovered.protocol.stage,'delivery-ready',JSON.stringify(recovered.protocol));
  const baseline=await effects(w);assert.deepEqual(baseline.kinds,['Agreement','Deliverable','SettlementEvidence']);
  assert.equal(baseline.attempts,3);assert.equal(baseline.payments,1);assert.equal(baseline.evidence,1);
  assert.equal(recovered.protocol.paymentEvidence.txHash,txHash);assert.equal(recovered.protocol.delivery.report.jobId,jobId);
  assert.equal(recovered.protocol.delivery.report.agreementHash,w.op().state.protocol.agreement.hash);
  assert.ok(w.seller.responses.some((r)=>r.path==='/dacs/v1/payments'&&r.status===503),'the original authenticated route must be cached as operation_uncertain');
  assert.equal(w.buyerActor.approvals.filter((r)=>r.content?.action==='native DEM transfer').length,1);
  assert.equal(w.seller.sellerApprovals.filter((r)=>r.content?.artifactKind==='SettlementEvidence').length,1);
  assert.equal(w.seller.sellerApprovals.filter((r)=>r.content?.artifactKind==='Deliverable').length,1);
  await w.h.restart();await w.seller.restart();
  assert.equal((await w.verify()).protocol.stage,'delivery-ready');assert.deepEqual(await effects(w),baseline);
  const wrong=await w.seller.agent.reconcileTransport(transportInput(w,jobId,{...body,txHash:`0x${'ab'.repeat(32)}`}));
  assert.notEqual(wrong.disposition,'present');assert.deepEqual(await effects(w),baseline);
  t.diagnostic(JSON.stringify({marker,first:first.protocol.stage,held:{missing:missing.reason,ambiguous:ambiguous.reason,wrongWriter:wrongWriter.reason,
    wrongContent:wrongContent.reason,wrongPayment:wrongPayment.reason,crossJob:crossJob.reason},reduced:reduced.value.delivery.status,recovered:recovered.protocol.stage,baseline}));
});

test('compatibility control: consumed permit remains reducible during lost Deliverable response recovery', {timeout:180000}, async t=>{
  const marker=oneShotMarker('seller-consumed-permit-compatibility');
  const {w,sent,jobId}=await paid(t),txHash=sent.data.hash,payer=w.buyerActor.signer.claim;
  let dropped=0;Object.defineProperty(w.h.chain.wire.faults,'dropAfterApply',{configurable:true,get:()=>{
    const last=acceptedCreates(w).at(-1);if(!dropped&&last&&kindOf(last)==='Deliverable'){dropped+=1;return true;}return false;
  }});
  const first=(await w.api('report',{txHash:sent.data.hash})).evidence;assert.equal(first.protocol.stage,'payment-observed');assert.equal(dropped,1);
  await w.h.restart();await w.seller.restart();
  const body={jobId,txHash,payerPayingKey:payer,nativePaymentEvidence:NATIVE_PAYMENT_EVIDENCE};
  const reduced=await w.seller.agent.reconcileTransport(transportInput(w,jobId,body));
  assert.equal(reduced.disposition,'present',JSON.stringify({reduced,state:w.seller.agent.deliveryStateOf(jobId)}));
  assert.equal(reduced.value.delivery.status,'delivery-ready',JSON.stringify(reduced));
  t.diagnostic(JSON.stringify({marker,reduced:reduced.value.delivery.status,effects:await effects(w)}));
});
