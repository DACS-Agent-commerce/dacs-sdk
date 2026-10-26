import test from 'node:test';
import assert from 'node:assert/strict';
import { policyRefusal,confirmedWriteOs,stillOpenBeforePayment,SELLER_POLICY_DEFAULTS } from '../src/devnet-demo/operator-approval.mjs';
import { sellerRecordsPurchaseResolver } from '../src/devnet-demo/seller-purchase-source.mjs';
import { address,seller,buyer,pin,sourceBinding,T0,JOBS,requestFor,confirmationFor,realPurchaseResolver } from './helpers/d5-policy-fixtures.mjs';
const purchase=()=>({jobId:JOBS[0],seller,buyer,listingPin:pin,sourceBinding,agreementHash:'e'.repeat(64),amountOs:'1000000000',paymentObserved:true,prePaymentOpen:false});
const policy=(resolvePurchase=purchase)=>({address,seller,sourceBinding,listingPin:()=>pin,resolvePurchase,paymentPhaseIndex:()=>2});

test('request validation accepts exact paid writes and exact confirmed balance removals',async()=>{
 const r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});
 assert.equal(await policyRefusal(r,policy(),SELLER_POLICY_DEFAULTS),null);
 assert.equal(confirmedWriteOs(confirmationFor(r),r),2000000000n);
 for(const mutate of [v=>v.response.data.valid=false,v=>v.response.data.transaction.content.nonce++,v=>v.response.data.transaction.content.data[1].salt='changed',v=>v.response.data.transaction.content.gcr_edits[0].amount='2']){
  const v=confirmationFor(r);mutate(v);assert.equal(confirmedWriteOs(v,r),null);
 }
});
for(const [reason,mutate] of [
 ['request-shape',r=>r.address='0x'+'f'.repeat(64)],
 ['debit',r=>r.content.debit.totalOs='04'],
 ['create-bytes',r=>r.content.exactCreate='{}'],
])test(`request validation refuses ${reason}`,async()=>{
 const r=requestFor();mutate(r);assert.equal(await policyRefusal(r,policy(),SELLER_POLICY_DEFAULTS),reason);
});

test('request validation refuses a consistently encoded wrong logical address',async()=>{
 assert.equal(await policyRefusal(requestFor({logicalAddress:'dacs4:wrong'}),policy(),SELLER_POLICY_DEFAULTS),'logical-address');
});

test('C-1 final pre-payment check awaits the real resolver for an unknown Vet',async()=>{
 const resolve=sellerRecordsPurchaseResolver({sessionOf:()=>null});
 const r=requestFor({artifactKind:'CompositeVerificationRecord'});
 assert.equal(await policyRefusal(r,policy(resolve),SELLER_POLICY_DEFAULTS),'seller-record-missing');
 assert.equal(await stillOpenBeforePayment(r,policy(resolve),'seller-record-missing'),null);
});


test('C-2 real seller projection holds unknown cancellation authority for exact manual approval',async()=>{
 const resolve=realPurchaseResolver(),found=await resolve(JOBS[0]);
 const r=requestFor({artifactKind:'FinalityCommitmentRecord',artifact:{agreementHash:found.agreementHash}});
 assert.equal(await policyRefusal(r,policy(resolve),SELLER_POLICY_DEFAULTS),'cancellation-unknown');
 assert.equal(await stillOpenBeforePayment(r,policy(resolve),'cancellation-unknown'),null);
});

for(const [state,change] of [['closed',{paymentObserved:false,prePaymentOpen:false}],['paid',{paymentObserved:true,prePaymentOpen:null}],['indeterminate',{paymentObserved:null,prePaymentOpen:null}]])test(`fresh pre-payment check refuses ${state} purchase even with manual approval`,async()=>{
 const p=policy(()=>({...purchase(),...change})),r=requestFor({artifactKind:'FinalityCommitmentRecord'});
 assert.notEqual(await policyRefusal(r,p,SELLER_POLICY_DEFAULTS),null);
 assert.notEqual(await stillOpenBeforePayment(r,p,'cancellation-unknown'),null);
});
