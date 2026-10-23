import './helpers/d5-isolated-dependencies.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createDevnetPurchasedReportProducer,isDevnetPurchasedReport} from '../src/devnet-demo/deliverable.mjs';
const {createDevnetDemoDeliveryCapability,readDevnetDeliveryEvidence,readDevnetPurchasedReport}=await import('../src/devnet-demo/native-delivery.mjs');
import {anchorFixture} from './helpers/anchor-isolated-fixture.mjs';
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
 const anchor={authority:'local',writer:seller,publish:()=>assert.fail('publish'),read:()=>assert.fail('read'),verifyReceipt:()=>assert.fail('verify'),
  readRetained:async()=>{calls++;return {status:'absent'}}};
 const capability=createDevnetDemoDeliveryCapability({authority:'local',anchor,deliveryEvidenceEnabled:true});
 for(const jobId of invalid){
  await assert.rejects(readDevnetDeliveryEvidence(capability,{jobId,seller}),/canonical uppercase ULID/);
  await assert.rejects(readDevnetPurchasedReport(capability,{jobId}),/canonical uppercase ULID/);
  const input={jobId,report:{jobId},logicalAddress:'unused'};
  assert.equal((await capability.submit(input)).status,'rejected');
  assert.equal((await capability.read(input)).status,'rejected');
  assert.equal(await capability.verifyReceipt(input),'invalid');
 }
 assert.equal(calls,0);
 assert.equal((await readDevnetDeliveryEvidence(capability,{jobId:JOB,seller})).status,'absent');assert.equal(calls,1);
});

test('native artifact publication, read and receipt verification refuse malformed jobs before journaling',async()=>{
 const w=await anchorFixture(),anchor=w.open();
 for(const jobId of invalid){
  const input={logicalAddress:'unused',artifact:{jobId,signature:{signer:w.seller}},artifactKind:'FinalityCommitmentRecord'};
  await assert.rejects(anchor.publish(input),{code:'invalid'});
  assert.equal((await anchor.read(input)).status,'rejected');
  assert.equal(await anchor.verifyReceipt({...input,receipt:{transactionRef:{value:'a'.repeat(64)}}}),'invalid');
 }
 assert.equal(w.captured.length,0);assert.equal(w.journal.rows.size,0);
});

test('address-only native intent and retained reads reject malformed embedded jobs before hashing or journal reads',async()=>{
 const w=await anchorFixture(),anchor=w.open();
 w.journal.get=()=>assert.fail('malformed address reached journal');
 for(const jobId of invalid)for(const prefix of ['dacs2:composite:','dacs3:commit:','dacs4:deliverable:','dacs4:evidence:']){
  const logicalAddress=prefix+String(jobId);
  await assert.rejects(anchor.hasIntent(logicalAddress),{code:'invalid'});
  await assert.rejects(anchor.readRetained({logicalAddress,artifactKind:'FinalityCommitmentRecord'}),{code:'invalid'});
  await assert.rejects(anchor.retainedSignedCreate({logicalAddress,artifactKind:'FinalityCommitmentRecord'}),{code:'invalid'});
 }
});
