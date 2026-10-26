import test from 'node:test';
import assert from 'node:assert/strict';
import { policyRefusal,confirmedWriteOs,stillOpenBeforePayment,SELLER_POLICY_DEFAULTS } from '../src/devnet-demo/operator-approval.mjs';
import { sellerRecordsPurchaseResolver } from '../src/devnet-demo/seller-purchase-source.mjs';
import { address,seller,buyer,pin,sourceBinding,T0,JOBS,requestFor,confirmationFor } from './helpers/d5-policy-fixtures.mjs';
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
 ['logical-address',r=>{r.content.logicalAddress='dacs4:wrong';}],
])test(`request validation refuses ${reason}`,async()=>{
 const r=requestFor();mutate(r);assert.equal(await policyRefusal(r,policy(),SELLER_POLICY_DEFAULTS),reason);
});

