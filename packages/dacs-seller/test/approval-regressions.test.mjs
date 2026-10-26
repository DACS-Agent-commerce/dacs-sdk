import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeSellerApproval,createExactOperatorApproval,parsePolicyLedger,heldPolicyBudget,SELLER_LEDGER_HEADER_FORMAT,SELLER_ISSUANCE_JOURNALS } from '../src/devnet-demo/operator-approval.mjs';
import { sellerRecordsPurchaseResolver } from '../src/devnet-demo/seller-purchase-source.mjs';
import { address,seller,buyer,pin,sourceBinding,T0,JOBS,requestFor,confirmationFor,realPurchaseResolver } from './helpers/d5-policy-fixtures.mjs';
const purchase=()=>({jobId:JOBS[0],seller,buyer,listingPin:pin,sourceBinding,agreementHash:'e'.repeat(64),amountOs:'1000000000',paymentObserved:true,prePaymentOpen:false});
async function fixture(t,resolvePurchase=()=>null){
 const dir=await mkdtemp(join(tmpdir(),'TEST-approval-regression-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const evidencePath=join(dir,'ledger');
 const settings={maxTotalOs:'10000000000',evidencePath,now:()=>T0};
 const p=createExactOperatorApproval({...settings,sellerApproval:{mode:'policy'},policy:{address,seller,sourceBinding,listingPin:()=>pin,resolvePurchase,paymentPhaseIndex:()=>2}});
 return {p,evidencePath,settings,read:async()=>parsePolicyLedger(await readFile(evidencePath,'utf8'))};
}

test('C-1 real asynchronous seller resolver completes a manually approved unknown Vet',async t=>{
 const f=await fixture(t,sellerRecordsPurchaseResolver({sessionOf:()=>null}));let prompts=0;
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>{prompts++;return true;}}),r=requestFor({artifactKind:'CompositeVerificationRecord'});
 assert.equal(await a(r),true);assert.equal(prompts,1);assert.equal(await a.confirm(confirmationFor(r)),true);
 await a.settle(r,'spent');assert.equal((await f.read()).rows.find(row=>row.signAuthorized).outcome,'spent');
});

test('C-2 real seller projection reaches manual approval and confirms an unpaid commitment',async t=>{
 const resolve=realPurchaseResolver(),found=await resolve(JOBS[0]),f=await fixture(t,resolve);let prompts=0;
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>{prompts++;return true;}}),r=requestFor({artifactKind:'FinalityCommitmentRecord',artifact:{agreementHash:found.agreementHash}});
 assert.equal(await a(r),true);assert.equal(prompts,1);assert.equal(await a.confirm(confirmationFor(r)),true);
 await a.settle(r,'spent');assert.equal((await f.read()).rows.find(row=>row.signAuthorized).outcome,'spent');
});
