// A Deliverable CREATE the node refused is not on the chain, and once another write of the seller has taken its nonce it never
// will be. The delivery capability over the real anchor then answers it as absent (marked dead), and the one new submission the
// seller makes through its own authorization check signs exactly one replacement.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import {fixtureListing} from './fixtures/listings.mjs';
import {seller} from './helpers/protocol-fixture.mjs';
import {anchorFixture,signSdkCreate} from './helpers/anchor-isolated-fixture.mjs';
import {createDevnetPurchasedReportProducer} from '../src/devnet-demo/deliverable.mjs';
import {createDevnetDemoDeliveryCapability} from '../src/devnet-demo/native-delivery.mjs';
import {isDeadRefusedCreate,mayPublishAgain,reconcileNativeDemDelivery,readNativeDemDelivery,submitNativeDemDelivery} from '../src/dacs/native-dem-delivery-consumer.mjs';

const JOB='01ARZ3NDEKTSV4RRFFQ69G5FAW';
const resendWith=(authorizeResend)=>({resend:true,authorizeResend});

// The wallet signs and keeps the first CREATE and the node refuses its broadcast; the next one it signs is accepted.
async function refusedDeliverable(){
 const w=await anchorFixture({artifactKinds:['Deliverable'],signRpc:async()=> 'TEST rpc authentication'});
 const listing=fixtureListing(seller),listingRef={listingId:listing.listingId,version:listing.listingVersion,contentHash:core.contentHash(listing)},agreement={jobId:JOB,listingRef};
 const report=createDevnetPurchasedReportProducer({producer:w.seller,produce:()=>'Bound purchased content'})({agreement,listing,settlementId:'settlement-1'});
 const logicalAddress=`dacs4:deliverable:${JOB}`,receiptContentHash=core.contentHash(report);
 const deliveryBinding={version:'1',profile:'dacs-native-delivery-publication/v1',jobId:JOB,phase:'deliver-storage-program',phaseIndex:0,listing:listingRef,
  agreementHash:report.agreementHash,fulfilmentId:'fulfilment-1',purchaseAmount:{currency:'DEM',amount:'2.5'},payloadHash:receiptContentHash};
 const input={jobId:JOB,logicalAddress,report,receiptContentHash,deliveryBinding};
 const included=new Set(),outcomes=['refused','accepted'],resends=[];
 w.source.observeBinding=async()=>{};
 w.source.binding=async({hash})=>({disposition:included.has(hash)?'included':'absent'});
 w.source.recoverStorageWrite=async({signedTransaction})=>{resends.push(signedTransaction.hash);};
 w.controls.reader.read=async()=>({status:'present',artifact:report,receipt:{contentHash:receiptContentHash,transactionRef:{value:'a'.repeat(64)},writer:w.seller},demosEvidence:{}});
 w.controls.reader.verifyReceipt=async()=> 'valid';
 w.controls.request=async request=>{
  const refused=outcomes.shift()==='refused',signedTransaction=await signSdkCreate(request.transaction),{hash}=signedTransaction;
  await w.journal.put('demo/wallet/lane',{stage:refused?'broadcast-started':'broadcast-accepted',hash,signedTransaction});
  await w.sourceJournal.put(`source/${hash}`,{stage:'signed',hash,signedTransaction});
  if(refused)return {success:false,error:{code:'broadcast_rejected'}};
  included.add(hash);
  return {success:true,data:{hash}};
 };
 // A new capability over a new anchor each time: the seller restarted.
 const capability=()=>createDevnetDemoDeliveryCapability({authority:'TEST-local',anchor:{...w.open(),authority:'TEST-local'}});
 const stages=[];
 const authorize=stage=>{stages.push(stage);return true;};
 assert.equal((await submitNativeDemDelivery(capability(),input,authorize)).status,'indeterminate','the node refused the first CREATE');
 assert.equal(w.captured.length,1);
 return {w,input,capability,authorize,stages,resends};
}

test('a refused Deliverable CREATE whose nonce is still free is not absent: it is read and reconciled as refused, and nothing is signed or sent',async()=>{
 const {w,input,capability,resends}=await refusedDeliverable();
 const read=await readNativeDemDelivery(capability(),input);
 assert.equal(read.status,'rejected');assert.equal(mayPublishAgain(read),false);
 assert.equal((await reconcileNativeDemDelivery(capability(),input)).status,'indeterminate');
 assert.equal(w.captured.length,1);assert.deepEqual(resends,[]);
});
test('after another write took its nonce, a refused Deliverable CREATE reads as dead and reconciles as absent without asking the wallet',async()=>{
 const {w,input,capability,resends}=await refusedDeliverable(),check=()=>true;
 w.controls.nonce=1;
 const read=await readNativeDemDelivery(capability(),input,resendWith(check));
 assert.equal(isDeadRefusedCreate(read),true);assert.equal(mayPublishAgain(read),true);
 assert.equal((await reconcileNativeDemDelivery(capability(),input)).status,'absent');
 assert.equal(w.captured.length,1);assert.deepEqual(resends,[]);
});
test('the new submission signs one replacement through the seller\'s authorization, and a later submission or read signs nothing',async()=>{
 const {w,input,capability,authorize,stages}=await refusedDeliverable();
 w.controls.nonce=1;
 const accepted=await submitNativeDemDelivery(capability(),input,authorize);
 assert.equal(accepted.status,'accepted');
 assert.deepEqual(stages,['intent','signing','intent','signing'],'the replacement is asked through the same two checks as the first send');
 assert.equal(w.captured.length,2);assert.deepEqual(w.captured.map(request=>request.transaction.content.nonce),[1,2]);
 assert.equal((await readNativeDemDelivery(capability(),input)).status,'present');
 assert.equal((await submitNativeDemDelivery(capability(),input,authorize)).status,'accepted');
 assert.equal(w.captured.length,2,'one wallet signature for the replacement');
});
test('a withdrawn authorization signs no replacement for a dead refused Deliverable CREATE',async()=>{
 const {w,input,capability}=await refusedDeliverable();
 w.controls.nonce=1;
 await assert.rejects(submitNativeDemDelivery(capability(),input,()=>false),{code:'not-authorized'});
 assert.equal(w.captured.length,1);
});
