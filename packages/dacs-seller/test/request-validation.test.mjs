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

// CORE CF-5: the exact JSON a request stores or signs is admitted as raw JSON, not leniently parsed.
const intoMetadata=(r,member)=>{r.content.exactCreate=r.content.exactCreate.replace('"metadata":{',`"metadata":{${member},`);};
for(const [label,mutate] of [
 ['a duplicate member in the stored artifact',r=>{r.content.exactStorageBytes=r.content.exactStorageBytes.replace('{',`{"jobId":"${JOBS[1]}",`);r.content.storageBytes=Buffer.byteLength(r.content.exactStorageBytes);}],
 ['a duplicate member in the CREATE',r=>{r.content.exactCreate=r.content.exactCreate.replace('{','{"salt":"TEST",');}],
 ['a duplicate member in the CREATE metadata',r=>intoMetadata(r,'"logicalAddress":"dacs4:TEST-other"')],
 ['a lone surrogate escape in the CREATE metadata',r=>intoMetadata(r,'"TEST":"\\ud800"')],
 ['an unsafe number in the CREATE metadata',r=>intoMetadata(r,'"TEST":9007199254740993')],
 ['nesting deeper than 128 in the CREATE metadata',r=>intoMetadata(r,`"TEST":${'['.repeat(130)}${']'.repeat(130)}`)],
 ['an unpaired surrogate in the CREATE text',r=>intoMetadata(r,`"TEST":"${String.fromCharCode(0xd800)}"`)],
 ['a CREATE that is not JSON',r=>{r.content.exactCreate='{';}],
 ['a stored artifact that is not an object',r=>{r.content.exactStorageBytes='null';r.content.storageBytes=4;}],
])test(`request validation refuses ${label} as create-bytes`,async()=>{
 const r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});mutate(r);
 assert.equal(await policyRefusal(r,policy(),SELLER_POLICY_DEFAULTS),'create-bytes');
});

// Only a Vet record is held before the seller has any record of its job.
for(const held of ['seller-record-missing','cancellation-unknown'])test(`a finality record with no seller record of its job is refused, also when held as ${held}`,async()=>{
 const p=policy(async()=>null),r=requestFor({artifactKind:'FinalityCommitmentRecord'});
 assert.equal(await policyRefusal(r,p,SELLER_POLICY_DEFAULTS),'purchase');
 assert.equal(await policyRefusal(r,p,SELLER_POLICY_DEFAULTS,{held}),'purchase');
 assert.equal(await stillOpenBeforePayment(r,p,held),'purchase');
});

// The fresh pre-payment check binds the purchase to what the exact request names.
const openPurchase=()=>({...purchase(),paymentObserved:false,prePaymentOpen:true});
for(const [label,kind,change,reason] of [
 ['another Agreement','FinalityCommitmentRecord',{agreementHash:'f'.repeat(64)},'agreement'],
 ['another buyer than the evaluated party','CompositeVerificationRecord',{buyer:`did:demos:agent:${'3'.repeat(64)}`},'evaluated-party'],
 ['another listing','FinalityCommitmentRecord',{listingPin:{...pin,version:2}},'purchase'],
 ['another network','FinalityCommitmentRecord',{sourceBinding:{...sourceBinding,chainIdentity:'f'.repeat(64)}},'purchase'],
 ['another seller','FinalityCommitmentRecord',{seller:`did:demos:agent:${'4'.repeat(64)}`},'purchase'],
])test(`the fresh pre-payment check refuses a held ${kind} whose purchase now names ${label}`,async()=>{
 const r=requestFor({artifactKind:kind});
 assert.equal(await stillOpenBeforePayment(r,policy(openPurchase),'cancellation-unknown'),null);
 assert.equal(await stillOpenBeforePayment(r,policy(()=>({...openPurchase(),...change})),'cancellation-unknown'),reason);
});

for(const [label,mutate] of [['another data discriminator',data=>{data[0]='different';}],['an extra data element',data=>{data.push('TEST');}],['no data array',(data,content)=>{content.data={0:data[0],1:data[1]};}]])test(`a confirmation with ${label} counts nothing`,()=>{
 const r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'}),v=confirmationFor(r),content=v.response.data.transaction.content;
 mutate(content.data,content);assert.equal(confirmedWriteOs(v,r),null);
});

for(const [state,change] of [['closed',{paymentObserved:false,prePaymentOpen:false}],['paid',{paymentObserved:true,prePaymentOpen:null}],['indeterminate',{paymentObserved:null,prePaymentOpen:null}]])test(`fresh pre-payment check refuses ${state} purchase even with manual approval`,async()=>{
 const p=policy(()=>({...purchase(),...change})),r=requestFor({artifactKind:'FinalityCommitmentRecord'});
 assert.notEqual(await policyRefusal(r,p,SELLER_POLICY_DEFAULTS),null);
 assert.notEqual(await stillOpenBeforePayment(r,p,'cancellation-unknown'),null);
});
