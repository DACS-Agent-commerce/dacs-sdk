import './helpers/d5-isolated-dependencies.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {paymentEvidenceAddress} from '@kynesyslabs/dacs';
import { address,seller,buyer,pin,sourceBinding,T0,JOBS,requestFor,confirmationFor } from './helpers/d5-policy-fixtures.mjs';
const { composeSellerApproval,createExactOperatorApproval,createSellerContextAdmission,parsePolicyLedger,withContextHolds,heldPolicyBudget,sellerPurchaseSource,releaseSellerContextHolds }=await import('../src/devnet-demo/operator-approval.mjs');
const { sellerRecordsPurchaseResolver,SELLER_PURCHASE_OPEN_WINDOW_MS,sellerHeldEvidenceJobs }=await import('../src/devnet-demo/seller-purchase-source.mjs');
async function directory(t){const root=await mkdtemp(join(tmpdir(),'d5-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const purchase=()=>({jobId:JOBS[0],seller,buyer,listingPin:pin,sourceBinding,agreementHash:'e'.repeat(64),amountOs:'1000000000',paymentObserved:true,prePaymentOpen:false});
async function policy(t,{resolvePurchase=()=>null,limits={},paymentPhaseIndex=()=>2}={}){
 const evidencePath=join(await directory(t),'approvals.jsonl');
 const p=createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath,now:()=>T0,sellerApproval:{mode:'policy',...limits},policy:{address,seller,sourceBinding,listingPin:()=>pin,resolvePurchase,paymentPhaseIndex}});
 return {p,evidencePath};
}

test('L2 context holds and sign-authorized rows share the job and hourly budgets without double conversion',()=>{
 const hold={contextHold:'h',jobId:JOBS[0],writes:2,totalOs:'4',recordedAt:100,released:false};
 const row={decision:'approved',policy:true,outcome:null,jobId:JOBS[0],artifactKind:'CompositeVerificationRecord',totalOs:'4',recordedAt:100};
 assert.equal(heldPolicyBudget(withContextHolds([hold,row]),101).writes,2);
 for(const changed of [{...row,artifactKind:'Deliverable'},{...row,recordedAt:99},{...row,jobId:JOBS[1]}])assert.equal(heldPolicyBudget(withContextHolds([hold,changed]),101).writes,3);
});
test('L3 new context ledger lines reject malformed keys, duplicate holds, limits, and a release for another job',()=>{
 const hold={format:'dacs-node2-seller-context-admission/v1',event:'hold',holdId:'h',jobId:JOBS[0],effect:'a'.repeat(64),writes:2,totalOs:'4',recordedAt:100};
 for(const mutation of [{...hold,extra:1},{...hold,writes:0},{...hold,writes:7},{...hold,totalOs:'04'},{...hold,effect:'wrong'}])assert.throws(()=>parsePolicyLedger(JSON.stringify(mutation)));
 assert.throws(()=>parsePolicyLedger([hold,hold].map(JSON.stringify).join('\n')));
 assert.throws(()=>parsePolicyLedger([hold,{format:hold.format,event:'release',holdId:'h',jobId:JOBS[1],recordedAt:101}].map(JSON.stringify).join('\n')));
});
test('L6 one Vet converts only one slot across multiple retained holds of the same job',()=>{
 const hold={contextHold:'a',jobId:JOBS[0],writes:2,totalOs:'4',recordedAt:100,released:false},row={decision:'approved',policy:true,outcome:null,jobId:JOBS[0],artifactKind:'CompositeVerificationRecord',totalOs:'4',recordedAt:101};
 const ledger=[hold,{...hold,contextHold:'b'},row];assert.equal(heldPolicyBudget(withContextHolds(ledger),102).writes,4);
 assert.equal(heldPolicyBudget(withContextHolds(ledger,{jobId:JOBS[0],artifactKind:'CompositeVerificationRecord'}),102).writes,3);
});
test('L8 context refusal ledger lines must retain their exact key and integer-time shape',()=>{
 const row={format:'dacs-node2-seller-context-admission/v1',event:'refused',jobId:JOBS[0],buyer,reason:'limit',recordedAt:T0};assert.equal(parsePolicyLedger(JSON.stringify(row)).rows.length,0);
 for(const change of [{extra:1},{reason:null},{recordedAt:T0+0.5}])assert.throws(()=>parsePolicyLedger(JSON.stringify({...row,...change})));
});
