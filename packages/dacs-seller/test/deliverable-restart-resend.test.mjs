// A paid order's Deliverable CREATE the wallet signed and kept just before a
// crash stays pending after the restart unless the restart path may send those
// kept bytes again. A plain read stays passive; the restart read sends them once,
// and only while its caller's own authorization check answers true.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import {fixtureListing} from './fixtures/listings.mjs';
import {seller} from './helpers/protocol-fixture.mjs';
import {anchorFixture,signSdkCreate} from './helpers/anchor-isolated-fixture.mjs';
import {createDevnetPurchasedReportProducer} from '../src/devnet-demo/deliverable.mjs';
import {createDevnetDemoDeliveryCapability} from '../src/devnet-demo/native-delivery.mjs';
import {readNativeDemDelivery,submitNativeDemDelivery} from '../src/dacs/native-dem-delivery-consumer.mjs';

const JOB='01ARZ3NDEKTSV4RRFFQ69G5FAW';
const resendWith=(authorizeResend)=>({resend:true,authorizeResend});
const countedCheck=(answer)=>{const check=()=>{check.calls++;if(answer instanceof Error)throw answer;return answer;};check.calls=0;return check;};

// The wallet signs and keeps the CREATE and the node accepts it, then the process
// dies before the first readback. `resendLands`: whether a resend makes it appear.
async function crashedBeforeReadback({resendLands=true}={}){
 const w=await anchorFixture({artifactKinds:['Deliverable'],signRpc:async()=> 'TEST rpc authentication'});
 const listing=fixtureListing(seller),listingRef={listingId:listing.listingId,version:listing.listingVersion,contentHash:core.contentHash(listing)},agreement={jobId:JOB,listingRef};
 const report=createDevnetPurchasedReportProducer({producer:w.seller,produce:()=>'Bound purchased content'})({agreement,listing,settlementId:'settlement-1'});
 const logicalAddress=`dacs4:deliverable:${JOB}`,receiptContentHash=core.contentHash(report);
 const deliveryBinding={version:'1',profile:'dacs-native-delivery-publication/v1',jobId:JOB,phase:'deliver-storage-program',phaseIndex:0,listing:listingRef,
  agreementHash:report.agreementHash,fulfilmentId:'fulfilment-1',purchaseAmount:{currency:'DEM',amount:'2.5'},payloadHash:receiptContentHash};
 const input={jobId:JOB,logicalAddress,report,receiptContentHash,deliveryBinding};
 const included=new Set(),resends=[];let crashed=true;
 w.source.observeBinding=async()=>{};
 w.source.binding=async({hash})=>{if(crashed)throw new Error('TEST process died before the readback');return {disposition:included.has(hash)?'included':'pending'};};
 w.source.recoverStorageWrite=async({signedTransaction})=>{resends.push(signedTransaction.hash);if(resendLands)included.add(signedTransaction.hash);};
 w.controls.reader.read=async()=>({status:'present',artifact:report,receipt:{contentHash:receiptContentHash,transactionRef:{value:'a'.repeat(64)},writer:w.seller},demosEvidence:{}});
 w.controls.reader.verifyReceipt=async()=> 'valid';
 w.controls.request=async request=>{
  const signedTransaction=await signSdkCreate(request.transaction),{hash}=signedTransaction;
  await w.journal.put('demo/wallet/lane',{stage:'broadcast-accepted',hash,signedTransaction});
  await w.sourceJournal.put(`source/${hash}`,{stage:'signed',hash,signedTransaction});
  return {success:true,data:{hash}};
 };
 const capability=()=>createDevnetDemoDeliveryCapability({authority:'TEST-local',anchor:{...w.open(),authority:'TEST-local'}});
 await assert.rejects(submitNativeDemDelivery(capability(),input,()=>true),/died before the readback/);
 crashed=false;
 assert.equal(w.captured.length,1,'signed once');
 return {w,input,capability,resends,included};
}

test('a plain read of a Deliverable CREATE kept before a crash stays pending and sends nothing',async()=>{
 const {w,input,capability,resends}=await crashedBeforeReadback();
 for(let i=0;i<2;i++)assert.equal((await readNativeDemDelivery(capability(),input)).status,'indeterminate');
 assert.deepEqual(resends,[]);assert.equal(w.captured.length,1);
});
test('after a restart the read that is authorized to resend sends the kept bytes once and the Deliverable reads back',async()=>{
 const {w,input,capability,resends}=await crashedBeforeReadback(),check=countedCheck(true);
 assert.equal((await readNativeDemDelivery(capability(),input,resendWith(check))).status,'present');
 assert.equal(check.calls,1);assert.equal(resends.length,1);
 assert.equal((await readNativeDemDelivery(capability(),input,resendWith(check))).status,'present');
 assert.equal(resends.length,1);assert.equal(w.captured.length,1,'never signed again');
});
test('two restarts send the kept bytes once when the resend does not land',async()=>{
 const {w,input,capability,resends}=await crashedBeforeReadback({resendLands:false});
 for(let restart=0;restart<3;restart++)assert.equal((await readNativeDemDelivery(capability(),input,resendWith(countedCheck(true)))).status,'indeterminate');
 assert.equal(resends.length,1);assert.equal(w.captured.length,1);
});
test('a resend whose outcome is uncertain spends the one resend',async()=>{
 const {w,input,capability,resends}=await crashedBeforeReadback();
 w.source.recoverStorageWrite=async()=>{resends.push('thrown');throw new Error('TEST transport died');};
 await assert.rejects(readNativeDemDelivery(capability(),input,resendWith(countedCheck(true))),/transport died/);
 await readNativeDemDelivery(capability(),input,resendWith(countedCheck(true)));
 assert.equal(resends.length,1);
});
for(const [label,answer] of [['answers false',false],['throws because the authority was withdrawn',new Error('TEST purchase cancelled')]])test(`a restart read whose check ${label} sends nothing, and a later passing check still sends once`,async()=>{
 const {input,capability,resends}=await crashedBeforeReadback(),refuse=countedCheck(answer);
 const refused=readNativeDemDelivery(capability(),input,resendWith(refuse));
 if(answer instanceof Error)await assert.rejects(refused,/purchase cancelled/);else assert.equal((await refused).status,'indeterminate');
 assert.equal(refuse.calls,1);assert.deepEqual(resends,[]);
 assert.equal((await readNativeDemDelivery(capability(),input,resendWith(countedCheck(true)))).status,'present');
 assert.equal(resends.length,1);
});
test('a resend with no authorization check is refused and sends nothing',async()=>{
 const {input,capability,resends}=await crashedBeforeReadback();
 const answer=await readNativeDemDelivery(capability(),input,{resend:true});
 assert.equal(answer.status,'rejected');assert.deepEqual(resends,[]);
});
