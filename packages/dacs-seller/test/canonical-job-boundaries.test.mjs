import test from 'node:test';
import assert from 'node:assert/strict';
import {createDevnetPurchasedReportProducer,isDevnetPurchasedReport} from '../src/devnet-demo/deliverable.mjs';
const {createDevnetDemoDeliveryCapability,readDevnetDeliveryEvidence,readDevnetPurchasedReport}=await import('../src/devnet-demo/native-delivery.mjs');
import {submitNativeDemDelivery,readNativeDemDelivery,verifyNativeDemDeliveryReceipt} from '../src/dacs/native-dem-delivery-consumer.mjs';
const JOB='01ARZ3NDEKTSV4RRFFQ69G5FAW';
const invalid=[undefined,null,7,{},'job-0',JOB.toLowerCase(),JOB.replace('0','O'),JOB.slice(1),'8'+JOB.slice(1)];
const seller='did:demos:agent:'+'2'.repeat(64);

test('native report production and validation require a canonical job before producing or hashing content',()=>{
 const listing={offering:{title:'Bound report'}},listingRef={listingId:'bound',version:1,contentHash:'a'.repeat(64)};
 const producer=createDevnetPurchasedReportProducer({producer:seller,produce:()=> 'Bound purchased content'});
 const report=producer({agreement:{jobId:JOB,listingRef},listing,settlementId:'fixture'});
 assert.equal(isDevnetPurchasedReport(report),true);
 const guarded=createDevnetPurchasedReportProducer({producer:seller,produce:()=>assert.fail('invalid job reached producer')});
 for(const jobId of invalid){
  assert.throws(()=>guarded({agreement:{jobId},listing,settlementId:'fixture'}),/canonical uppercase ULID/);
  assert.equal(isDevnetPurchasedReport({...report,jobId}),false);
 }
});

test('native delivery readers and publication callbacks refuse malformed jobs before anchors or receipt reads',async()=>{
 let calls=0;
 const anchor={authority:'TEST-local',writer:seller,publish:()=>assert.fail('publish'),read:()=>assert.fail('read'),verifyReceipt:()=>assert.fail('verify'),
  readRetained:async()=>{calls++;return {status:'absent'}}};
 const capability=createDevnetDemoDeliveryCapability({authority:'TEST-local',anchor,deliveryEvidenceEnabled:true});
 for(const jobId of invalid){
  await assert.rejects(readDevnetDeliveryEvidence(capability,{jobId,seller}),/canonical uppercase ULID/);
  await assert.rejects(readDevnetPurchasedReport(capability,{jobId}),/canonical uppercase ULID/);
  const input={jobId,report:{jobId},logicalAddress:'unused'};
  assert.equal((await submitNativeDemDelivery(capability,input)).status,'rejected');
  assert.equal((await readNativeDemDelivery(capability,input)).status,'rejected');
  assert.equal(await verifyNativeDemDeliveryReceipt(capability,input),'invalid');
 }
 assert.equal(calls,0);
 assert.equal((await readDevnetDeliveryEvidence(capability,{jobId:JOB,seller})).status,'absent');assert.equal(calls,1);
});
