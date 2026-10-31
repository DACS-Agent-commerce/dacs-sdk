// SDK #365 sweep: the shipped Deliverable capability composed with the artifact
// anchor. A wallet that refuses without signing, or a process that dies while
// the wallet is asked, must leave a paid order's Deliverable askable again
// (once), and a signed CREATE must never be asked again. The agent's own check
// is the one `isProvenUnsignedAbsence` the host uses (seller-agent.mjs,
// reconcileDeliverySubmission), applied here to the capability's real answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import {fixtureListing} from './fixtures/listings.mjs';
import {seller} from './helpers/protocol-fixture.mjs';
import {anchorFixture} from './helpers/anchor-isolated-fixture.mjs';
import {createDevnetPurchasedReportProducer} from '../src/devnet-demo/deliverable.mjs';
import {createDevnetDemoDeliveryCapability} from '../src/devnet-demo/native-delivery.mjs';
import {isProvenUnsignedAbsence,readNativeDemDelivery,submitNativeDemDelivery} from '../src/dacs/native-dem-delivery-consumer.mjs';

const JOB='01ARZ3NDEKTSV4RRFFQ69G5FAW';
async function composed(){
 const w=await anchorFixture({artifactKinds:['Deliverable']}),anchor=w.open();
 const listing=fixtureListing(seller),listingRef={listingId:listing.listingId,version:listing.listingVersion,contentHash:core.contentHash(listing)},agreement={jobId:JOB,listingRef};
 const report=createDevnetPurchasedReportProducer({producer:w.seller,produce:()=>'Bound purchased content'})({agreement,listing,settlementId:'settlement-1'});
 const logicalAddress=`dacs4:deliverable:${JOB}`,receiptContentHash=core.contentHash(report);
 const deliveryBinding={version:'1',profile:'dacs-native-delivery-publication/v1',jobId:JOB,phase:'deliver-storage-program',phaseIndex:0,listing:listingRef,
  agreementHash:report.agreementHash,fulfilmentId:'fulfilment-1',purchaseAmount:{currency:'DEM',amount:'2.5'},payloadHash:receiptContentHash};
 const input={jobId:JOB,logicalAddress,report,receiptContentHash,deliveryBinding};
 const capability=(opened=anchor)=>createDevnetDemoDeliveryCapability({authority:'TEST-local',anchor:{...opened,authority:'TEST-local'}});
 return {w,anchor,input,capability,logicalAddress};
}
const refuse=(code)=>async()=>({success:false,error:{code}});

for(const code of ['internal_error','capture-without-signing'])test(`a wallet ${code} before anything is signed: the capability proves the absence, also after a restart, and the Deliverable is asked once more`,async()=>{
 for(const restart of [false,true]){
  const {w,anchor,input,capability}=await composed();
  w.controls.request=refuse(code);
  const first=await submitNativeDemDelivery(capability(),input);
  assert.equal(first.status,'indeterminate',`restart ${restart}`);assert.equal(w.captured.length,1);
  const opened=restart?w.open():anchor;
  assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(opened),input)),true,`restart ${restart}: nothing was signed, so the read proves it`);
  // The agent asks again on that proof: the wallet signs and the CREATE lands this time.
  w.controls.request=async request=>{
   await w.journal.put('demo/wallet/signed',{stage:'broadcast-accepted',hash:'a'.repeat(64),signedTransaction:{...request.transaction,hash:'a'.repeat(64)}});
   return {success:false,error:{code:'internal_error'}};
  };
  assert.equal((await submitNativeDemDelivery(capability(opened),input)).status,'indeterminate');
  assert.equal(w.captured.length,2,'asked once more');
  assert.deepEqual(w.captured.map(r=>r.transaction.content.nonce),[1,1]);
  // Now a signed CREATE is retained for the address: the proof is gone and it is never asked again.
  assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(w.open()),input).catch(()=>null)),false);
 }
});
test('a process killed while the wallet was asked: proven absence only while no signed CREATE is retained',async()=>{
 const {w,input,capability}=await composed();
 w.controls.request=async()=>{throw new Error('killed');};
 await assert.rejects(submitNativeDemDelivery(capability(),input),/killed/);
 assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(w.open()),input)),true);
 await w.journal.put('demo/wallet/signed',{stage:'broadcast-started',hash:'a'.repeat(64),signedTransaction:{...w.captured[0].transaction,hash:'a'.repeat(64)}});
 w.source.binding=async()=>({disposition:'pending'});
 assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(w.open()),input).catch(()=>null)),false);
});

for (const restart of [false, true]) for (const lostFence of [false, true]) test(`native delivery rechecks authorization after nonce RPC, restart=${restart}, lostFence=${lostFence}`, async () => {
 const {w,anchor,input,capability}=await composed();
 let prepared=false,checks=0;
 w.source.readRpc=async()=>{prepared=true;return {result:200,response:0,require_reply:false,extra:null};};
 const failure=new Error('TEST job fence lost during preparation');
 const authorize=()=>{checks++;assert.equal(prepared,true,'guard runs after asynchronous nonce preparation');if(lostFence)throw failure;return false;};
 await assert.rejects(submitNativeDemDelivery(capability(),input,authorize),lostFence?error=>error===failure:error=>error.code==='not-authorized');
 assert.equal(checks,1);
 assert.equal(w.captured.length,0,'no wallet signature requested');
 const opened=restart?w.open():anchor;
 assert.equal(isProvenUnsignedAbsence(await readNativeDemDelivery(capability(opened),input)),true);
 const retry=await submitNativeDemDelivery(capability(opened),input,()=>true);
 assert.equal(retry.status,'indeterminate');
 assert.equal(w.captured.length,1,'unsigned refusal remains askable after reopen');
});
