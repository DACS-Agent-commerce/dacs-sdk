import test from 'node:test';
import assert from 'node:assert/strict';
import { modelReport } from './helpers/model-report.mjs';
import { compositeVerificationAddress,contentHash,paymentEvidenceAddress } from '@kynesyslabs/dacs';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { DEVNET_DELIVERY_KIND,DEVNET_SETTLEMENT_KIND,isDevnetDeliveryTransport,isDevnetSettlementTransport } from '../src/wallet/devnet-native-transport.mjs';
import { NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { createDemDeliveryContext,demDeliveryContextConfig } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { readDemDeliveryReady } from '../src/dacs/dem-delivery-consumer.mjs';
import { createNativeDemDeliveryCapability,nativeDemDeliveryConfig } from '../src/dacs/native-dem-delivery-consumer.mjs';

test('DEM delivery authority is opaque and an authenticated seller pointer alone is not delivery evidence',async()=>{
  assert.throws(()=>demDeliveryContextConfig(true),/constructed application capability/);
  assert.throws(()=>demDeliveryContextConfig({source:'dacs-chatgpt-plugin\/dem-delivery-context\/v1',authority:'TEST-forged'}),/constructed application capability/);
  assert.throws(()=>nativeDemDeliveryConfig({source:'dacs-chatgpt-plugin\/native-dem-delivery\/v1',authority:'TEST-forged'}),/constructed application capability/);
  const capability=createDemDeliveryContext({authority:'TEST-unit',resolveBuyer:async()=>({disposition:'absent',reason:'none'}),resolveSeller:async()=>({disposition:'absent',reason:'none'})});
  assert.equal(demDeliveryContextConfig(capability),capability);
  const jobId='01M46K00000000000000000000';
  const result=await readDemDeliveryReady({anchors:{read:async()=>({status:'absent'})},agreement:{jobId},listing:{},seller:`did:demos:agent:${'a'.repeat(64)}`,
    answer:{delivery:{status:'delivery-ready',logicalAddress:`dacs4:deliverable:${jobId}`,contentHash:'b'.repeat(64),evidenceHash:'c'.repeat(64),fulfilmentId:'claimed'}}});
  assert.deepEqual(result,{disposition:'indeterminate',reason:'canonical deliverable is not present'});
});

test('source demo: Agreement, approved DEM, native payment evidence and SDK durable delivery-ready report',{timeout:120000},async(t)=>{
  const w=await sourceDemoFlow(t);
  assert.equal(isDevnetSettlementTransport(w.h.capability),true);
  assert.equal(isDevnetDeliveryTransport(w.h.capability),true);
  assert.equal(w.op().terms.protocol.nativePaymentEvidence,NATIVE_PAYMENT_EVIDENCE);
  assert.equal(w.op().terms.protocol.sellerTransport.profile,'dacs-source-demo/signed-peer/v1');
  assert.deepEqual(w.op().terms.protocol.transportBinding,w.h.capability.transportBinding);
  assert.deepEqual(w.op().terms.protocol.transportBinding.settlementPublication,w.h.capability.settlementPublication);
  assert.equal((await w.agreement()).status,'awaiting_approval');
  await new Promise((resolve)=>setTimeout(resolve,1050));
  const {handoff}=await w.approve();assert.equal(handoff.status,'payment_handoff',JSON.stringify(handoff));
  const sent=await w.send(handoff.payload);assert.equal(sent.success,true,JSON.stringify(sent));
  const reported=await w.api('report',{txHash:sent.data.hash});
  assert.equal(reported.status,'settled_verified',JSON.stringify({reported,errors:w.seller.functionalErrors}));
  assert.equal(reported.evidence.protocol.stage,'delivery-ready',JSON.stringify({reported,delivery:w.seller.agent.deliveryStateOf(w.op().terms.protocol.jobId),errors:w.seller.functionalErrors}));
  assert.equal(reported.evidence.protocol.nativeEvidence.nativeReadback,'present');
  assert.equal(reported.evidence.protocol.layers.dacsPurchase,'payment-evidence-verified');
  assert.equal(reported.evidence.protocol.layers.service,'test-report-delivered-and-verified');
  assert.equal(reported.evidence.protocol.delivery.status,'delivery-ready');
  assert.equal(reported.evidence.protocol.delivery.evidencePublication,'deferred-to-explicit-sdk-finaliser');
  assert.equal(reported.evidence.protocol.delivery.substrate,'source-native-one-node-delivery');
  assert.equal(reported.evidence.protocol.delivery.report.jobId,w.op().terms.protocol.jobId);
  assert.equal(reported.evidence.protocol.delivery.report.agreementHash,w.op().state.protocol.agreement.hash);
  assert.equal(reported.evidence.protocol.delivery.report.settlementId,`demos:${sent.data.hash}`);
  assert.equal(reported.evidence.protocol.delivery.deliverableRef.contentHash,contentHash(reported.evidence.protocol.delivery.report));
  assert.match(reported.evidence.protocol.limits.vet,/two partyVetCore composites produced/);
  assert.match(reported.evidence.protocol.limits.delivery,/seller packaged-wallet native CREATE/);
  const jobId=w.op().terms.protocol.jobId,deliveryState=w.seller.agent.deliveryStateOf(jobId);
  assert.equal(deliveryState.paymentPermitId.length>0,true);
  assert.equal(deliveryState.auditSource.session.state,'settle-pending');
  assert.deepEqual(deliveryState.auditSource.session.phaseResults.map((entry)=>entry.step.kind),['negotiate-fixed-price','commit-payee-bound-agreement','pay-dem']);
  assert.equal(deliveryState.auditSource.artifacts.vetRequirements.length,2);
  assert.equal(deliveryState.auditSource.artifacts.settlementEvidence[0].contentHash,contentHash(w.seller.evidenceAttempts[0].artifact));
  assert.equal(w.seller.deliveryContextProvider.invocations.length,2);
  for(const invocation of w.seller.deliveryContextProvider.invocations){assert.equal(invocation.strictStatus,'valid');assert.equal(invocation.recordRef.anchor.locator,compositeVerificationAddress(jobId,invocation.evaluatedParty));}
  assert.equal(w.seller.evidenceAttempts.length,1);
  const intent=w.seller.evidenceAttempts[0],artifact=intent.artifact;
  assert.equal(intent.logicalAddress,paymentEvidenceAddress(artifact.jobId,'demos-native:DEM',2));
  assert.equal(intent.receiptContentHash,contentHash(artifact));
  const creates=w.h.chain.wire.record.accepted;
  assert.equal(creates.length,3);
  const sellerCreate=creates.find((tx)=>tx.content.data[1].metadata.artifactKind==='SettlementEvidence');
  assert.ok(sellerCreate);assert.equal(sellerCreate.content.from,w.seller.wallet.address);
  const deliveryCreate=creates.find((tx)=>tx.content.data[1].metadata.artifactKind==='Deliverable');
  assert.ok(deliveryCreate);assert.equal(deliveryCreate.content.from,w.seller.wallet.address);
  assert.equal(deliveryCreate.content.data[1].metadata.deliveryBinding.fulfilmentId,deliveryState.fulfilmentId);
  assert.equal(deliveryCreate.content.data[1].metadata.deliveryBinding.agreementHash,w.op().state.protocol.agreement.hash);
  assert.deepEqual(deliveryCreate.content.data[1].data,reported.evidence.protocol.delivery.report);
  assert.deepEqual(await w.seller.publicProjection({logicalAddress:reported.evidence.protocol.delivery.deliverableRef.anchor.locator,writer:w.seller.wallet.claim}),deliveryCreate);
  assert.equal(sellerCreate.content.data[1].metadata.networkBinding.settlementPublication.policy,'dacs-native-settlement-publication/v1');
  assert.equal(w.seller.sellerApprovals.find((r)=>r.content?.artifactKind==='SettlementEvidence')?.content.kind,DEVNET_SETTLEMENT_KIND);
  const deliveryApproval=w.seller.sellerApprovals.find((r)=>r.content?.artifactKind==='Deliverable');
  assert.equal(deliveryApproval?.content.kind,DEVNET_DELIVERY_KIND);
  assert.equal(deliveryApproval?.content.deliveryBinding.fulfilmentId,deliveryState.fulfilmentId);
  assert.equal(deliveryApproval?.content.debit.totalOs.length>0,true);
  assert.ok(w.seller.requests.includes('/dacs/v1/payments'));
  assert.ok(w.h.responseMarkers.every((marker)=>marker===null));
  const unavailable=createNativeDemDeliveryCapability({authority:'TEST-unavailable-native-delivery',submit:async()=>({status:'rejected',reason:'unused'}),reconcile:async()=>({status:'absent',reason:'unused'}),
    read:async()=>({status:'absent',reason:'native Deliverable bytes deliberately unavailable'}),verifyReceipt:async()=> 'indeterminate'});
  const absent=await readDemDeliveryReady({anchors:w.h.anchors,nativeDemDelivery:unavailable,agreement:w.op().state.protocol.agreement.artifact,listing:w.op().state.protocol.listing,
    seller:w.seller.wallet.claim,answer:{delivery:{status:'delivery-ready',logicalAddress:deliveryState.logicalAddress,contentHash:deliveryState.contentHash,evidenceHash:deliveryState.evidenceHash,fulfilmentId:deliveryState.fulfilmentId}}});
  assert.deepEqual(absent,{disposition:'indeterminate',reason:'native Deliverable bytes deliberately unavailable'});
  const writesBeforeRestart=w.seller.anchorWrites.length;
  await w.h.restart();await w.seller.restart();
  const replay=await w.verify();assert.equal(replay.protocol.stage,'delivery-ready',JSON.stringify({replay,deliveryState:w.seller.agent.deliveryStateOf(jobId),errors:w.seller.functionalErrors}));
  assert.deepEqual(modelReport(replay.protocol.delivery.report),reported.evidence.protocol.delivery.report);
  assert.equal(w.seller.anchorWrites.length,writesBeforeRestart);
  assert.equal(w.h.chain.record.broadcasts.length,1);assert.equal(w.h.chain.wire.record.broadcastAttempts.length,3);
  assert.equal(w.seller.evidenceAttempts.length,1);
  assert.equal(w.h.chain.wire.record.accepted.length,3);
  assert.equal((await w.api('completion/request')).error,'native_completion_held');
  t.diagnostic(JSON.stringify({operation:w.id,agreementCreate:creates[0].hash,payment:sent.data.hash,settlementCreate:sellerCreate.hash,deliveryCreate:deliveryCreate.hash,
    source:w.h.expected.endpoint,markers:w.h.responseMarkers,creates:3,payments:1,partyVet:w.seller.deliveryContextProvider.invocations.map(({evaluatedParty,recordRef})=>({evaluatedParty,recordRef})),
    permit:deliveryState.paymentPermitId,fulfilmentId:deliveryState.fulfilmentId,delivery:reported.evidence.protocol.delivery.deliverableRef,
    deliveryApproval:{kind:deliveryApproval.content.kind,totalOs:deliveryApproval.content.debit.totalOs},restart:{creates:w.h.chain.wire.record.accepted.length,payments:w.h.chain.record.broadcasts.length},
    finality:'source-native-one-node Agreement/payment/SettlementEvidence/Deliverable; fixture Vet/Listing/commitment; no independent finality',completion:'delivery-ready; evidence publication and DACS-5 finalization deferred'}));
});
