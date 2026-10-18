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
const { sellerJournalIssuance }=await import('../src/devnet-demo/seller-issuance.mjs');
const { acquireSellerStateLock,SELLER_STATE_LOCK_REFUSALS }=await import('../src/devnet-demo/seller-state-lock.mjs');
async function directory(t){const root=await mkdtemp(join(tmpdir(),'d5-unit-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const purchase=()=>({jobId:JOBS[0],seller,buyer,listingPin:pin,sourceBinding,agreementHash:'e'.repeat(64),amountOs:'1000000000',paymentObserved:true,prePaymentOpen:false});
async function policy(t,{resolvePurchase=()=>null,limits={},paymentPhaseIndex=()=>2}={}){
 const evidencePath=join(await directory(t),'approvals.jsonl');
 const p=createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath,now:()=>T0,sellerApproval:{mode:'policy',...limits},policy:{address,seller,sourceBinding,listingPin:()=>pin,resolvePurchase,paymentPhaseIndex}});
 return {p,evidencePath};
}

test('A1 seller source is mandatory; stale app configuration is refused',()=>{
 assert.equal(sellerPurchaseSource(), 'seller');assert.equal(sellerPurchaseSource('seller'),'seller');assert.throws(()=>sellerPurchaseSource('app'));
});
test('A2 authenticated context capacity does not approve a pre-payment Vet; exact seller approval is required',async t=>{
 const {p,evidencePath}=await policy(t);const admission=createSellerContextAdmission({evidencePath,sellerApproval:{mode:'policy'},now:()=>T0});
 assert.equal(await admission.reserve({jobId:JOBS[0],effect:'a'.repeat(64),writes:2,hold:'context'}),null);
 let manual=0;const approval=composeSellerApproval({mode:'policy',policy:p,manual:async()=>{manual++;return true;}});
 const request=requestFor({artifactKind:'CompositeVerificationRecord'});
 assert.equal(await approval(request),true);assert.equal(manual,1);
 const ledger=parsePolicyLedger(await readFile(evidencePath,'utf8'));
 assert.equal(ledger.rows.filter(r=>r.signAuthorized).length,1,'sign authority is durable before the wallet receives approval');
 assert.equal(heldPolicyBudget(withContextHolds(ledger.rows),T0).writes,2,'one converted hold plus its remaining slot');
 assert.equal(await approval.confirm(confirmationFor(request)),true);
 await approval.settle(request,'spent');
 assert.equal(heldPolicyBudget(withContextHolds(parsePolicyLedger(await readFile(evidencePath,'utf8')).rows),T0).writes,2);
});
test('A3 pre-payment commitment stays held even with a seller proposal; a decline creates no sign authority',async t=>{
 const open={...purchase(),paymentObserved:false,prePaymentOpen:true};const {p,evidencePath}=await policy(t,{resolvePurchase:()=>open});let prompts=0;
 const approval=composeSellerApproval({mode:'policy',policy:p,manual:async()=>{prompts++;return false;}});
 assert.equal(await approval(requestFor({artifactKind:'FinalityCommitmentRecord'})),false);assert.equal(prompts,1);
 const ledger=parsePolicyLedger(await readFile(evidencePath,'utf8'));assert.equal(ledger.rows.some(r=>r.signAuthorized),false);assert.equal(heldPolicyBudget(ledger.rows,T0).writes,0);
});
test('A4 a paid job may authorize a bounded automatic write; an unknown result stays counted after restart',async t=>{
 const {p,evidencePath}=await policy(t,{resolvePurchase:purchase});const r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});
 assert.equal(await p.prepare(r),true);assert.equal(await p(r,confirmationFor(r)),true);await p.settle(r,'unknown');
 const ledger=parsePolicyLedger(await readFile(evidencePath,'utf8'));assert.equal(heldPolicyBudget(ledger.rows,T0+7200000).writes,1);
 assert.equal((await p.reconcile()).released.length,0);
});
test('A5 malformed bytes, a closed job, wrong chain, or excessive fee cannot be rescued by manual pre-payment approval',async t=>{
 for(const kind of ['bytes','closed','chain','endpoint','fee']){
  let found={...purchase(),paymentObserved:false,prePaymentOpen:kind!=='closed'};
  const {p}=await policy(t,{resolvePurchase:()=>found});let prompts=0;const a=composeSellerApproval({mode:'policy',policy:p,manual:()=>{prompts++;return true;}});
  const r=requestFor({artifactKind:'FinalityCommitmentRecord'});
  if(kind==='bytes')r.content.exactCreate='{}';if(kind==='chain')r.content.networkBinding={...sourceBinding,chainIdentity:'f'.repeat(64)};if(kind==='endpoint')r.content.networkBinding={...sourceBinding,endpoint:'https://another.test.invalid/'};if(kind==='fee')r.content.debit.totalOs='9000000000';
  assert.equal(await a(r),false,kind);assert.equal(prompts,0,kind);
 }
});
test('A6 Listing and manual-mode writes always need exact seller approval',async t=>{
 for(const [mode,artifactKind] of [['policy','Listing'],...['Listing','CompositeVerificationRecord','Deliverable'].map(kind=>['manual',kind])]){let called=0;const a=composeSellerApproval({mode,policy:{prepare:()=>assert.fail('policy ran')},manual:()=>{called++;return false;}});assert.equal(await a({content:{artifactKind}}),false);assert.equal(called,1);}
});
test('A7 paid-job policy refusal remains held for exact seller approval',async t=>{
 const {p}=await policy(t,{resolvePurchase:purchase,limits:{maxWriteTotalOs:'1000000000'}});let prompts=0;const a=composeSellerApproval({mode:'policy',policy:p,manual:()=>{prompts++;return true;}});
 assert.equal(await a(requestFor({artifactKind:'Deliverable'})),true);assert.equal(prompts,1);
});
test('L1 policy count and amount limits refuse context capacity before any ledger line',async t=>{
 for(const limits of [{maxWritesPerHour:1},{maxTotalOsPerHour:'4000000000'}]){
  const path=join(await directory(t),'ledger');const a=createSellerContextAdmission({evidencePath:path,sellerApproval:{mode:'policy',...limits},now:()=>T0});
  assert.match(await a.reserve({jobId:JOBS[0],effect:'a'.repeat(64),writes:2,hold:'x'}),/hourly/);await assert.rejects(readFile(path),{code:'ENOENT'});
 }
});
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
test('L4 release names one exact hold and leaves other reservations counted',async t=>{
 const path=join(await directory(t),'ledger'),a=createSellerContextAdmission({evidencePath:path,sellerApproval:{mode:'policy'},now:()=>T0});
 for(const hold of ['a','b'])assert.equal(await a.reserve({jobId:JOBS[0],effect:'a'.repeat(64),writes:2,hold}),null);
 assert.deepEqual(await releaseSellerContextHolds({evidencePath:path,jobId:JOBS[0],holdId:'a',now:()=>T0}),['a']);
 assert.equal(heldPolicyBudget(withContextHolds(parsePolicyLedger(await readFile(path,'utf8')).rows),T0).writes,2);
});
test('S1 seller purchase window is closed at exact expiry; one millisecond before is open',()=>{
 const at=T0-SELLER_PURCHASE_OPEN_WINDOW_MS,draft={parties:[{role:'buyer',primaryClaim:buyer},{role:'seller',primaryClaim:seller}],listingRef:pin,generatedAt:at,terms:{price:{amount:'1',currency:'DEM'},deadline:T0+1}};
 const session={jobId:JOBS[0],buyerBundle:{presentedBy:buyer},proposal:{plan:{draft}},proposalAdmission:{observedAt:at}};
 for(const [now,expected] of [[T0-1,true],[T0,false],[T0+1,false]])assert.equal(sellerRecordsPurchaseResolver({sessionOf:()=>session,buyerAccess:()=>({allowsWallet:()=>true}),now:()=>now})(JOBS[0]).prePaymentOpen,expected);
 assert.equal(sellerRecordsPurchaseResolver({sessionOf:()=>session,buyerAccess:()=>({allowsWallet:()=>false}),now:()=>T0})(JOBS[0]),false);
 assert.deepEqual(sellerHeldEvidenceJobs([{...session,stage:'delivery-ready',deliveryReady:{},nativeEvidenceWork:{}}]),[{jobId:JOBS[0]}]);
});
test('S2 issuance lookup binds wallet, nonce, timestamp and exact CREATE; it never proves release',async()=>{
 const request=requestFor(),c=request.content,content={from:c.wallet,nonce:c.nonce,timestamp:c.timestamp,data:['storageProgram',JSON.parse(c.exactCreate)]};
 const check=value=>sellerJournalIssuance({journals:[{entries:async()=>[['k',{signedTransaction:{content:value}}]]}]},request);
 assert.equal(await check(content),'issued');for(const change of [{from:'0x'+'b'.repeat(64)},{nonce:2},{timestamp:8},{data:['storageProgram',{}]}])assert.equal(await check({...content,...change}),'unknown');
});
test('S3 a second seller-state owner refuses before any file is changed',async t=>{
 const dir=await directory(t),lock=await acquireSellerStateLock(dir);t.after(()=>lock.release());
 const before=await readFile(join(dir,'seller-state.lock'));
 await assert.rejects(acquireSellerStateLock(dir),{message:SELLER_STATE_LOCK_REFUSALS.held});assert.deepEqual(await readFile(join(dir,'seller-state.lock')),before);
});
test('L5 both pre-payment manual Vets convert their capacity at the exact two-write budget; a third cannot get sign authority',async t=>{
 const {p,evidencePath}=await policy(t,{limits:{maxWritesPerHour:2,maxTotalOsPerHour:'8000000000'}});
 const admission=createSellerContextAdmission({evidencePath,sellerApproval:{mode:'policy',maxWritesPerHour:2,maxTotalOsPerHour:'8000000000'},now:()=>T0});
 assert.equal(await admission.reserve({jobId:JOBS[0],effect:'a'.repeat(64),writes:2,hold:'two'}),null);
 let prompts=0;const a=composeSellerApproval({mode:'policy',policy:p,manual:()=>{prompts++;return true;}});
 for(const party of [buyer,seller]){const r=requestFor({artifactKind:'CompositeVerificationRecord',party});assert.equal(await a(r),true);assert.equal(await a.confirm(confirmationFor(r)),true);await a.settle(r,'spent');}
 assert.equal(prompts,2);assert.equal(heldPolicyBudget(withContextHolds(parsePolicyLedger(await readFile(evidencePath,'utf8')).rows),T0).writes,2);
 assert.equal(await a(requestFor({artifactKind:'CompositeVerificationRecord',job:JOBS[1]})),false);assert.equal(prompts,2);
});
test('L6 one Vet converts only one slot across multiple retained holds of the same job',()=>{
 const hold={contextHold:'a',jobId:JOBS[0],writes:2,totalOs:'4',recordedAt:100,released:false},row={decision:'approved',policy:true,outcome:null,jobId:JOBS[0],artifactKind:'CompositeVerificationRecord',totalOs:'4',recordedAt:101};
 const ledger=[hold,{...hold,contextHold:'b'},row];assert.equal(heldPolicyBudget(withContextHolds(ledger),102).writes,4);
 assert.equal(heldPolicyBudget(withContextHolds(ledger,{jobId:JOBS[0],artifactKind:'CompositeVerificationRecord'}),102).writes,3);
});
test('A8 a fresh policy instance keeps an unknown issued reservation held beyond the hour and refuses another automatic write',async t=>{
 const {p,evidencePath}=await policy(t,{resolvePurchase:purchase,limits:{maxWritesPerHour:1}}),r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});
 assert.equal(await p.prepare(r),true);assert.equal(await p(r,confirmationFor(r)),true);await p.settle(r,'unknown');
 const restarted=createExactOperatorApproval({maxTotalOs:'10000000000',evidencePath,now:()=>T0+7200000,sellerApproval:{mode:'policy',maxWritesPerHour:1},policy:{address,seller,sourceBinding,listingPin:()=>pin,resolvePurchase:purchase,paymentPhaseIndex:()=>2,issuance:async()=> 'issued'}});
 const before=await readFile(evidencePath,'utf8'),answer=await restarted.reconcile();assert.equal(answer.held.length,1);assert.equal(answer.held[0].state,'issued-outcome-unknown');assert.deepEqual(answer.released,[]);assert.equal(await readFile(evidencePath,'utf8'),before);
 assert.equal(await restarted.prepare(r),false);assert.equal(parsePolicyLedger(await readFile(evidencePath,'utf8')).rows.filter(row=>row.signAuthorized).length,1);
});

test('A9 payment evidence uses the trusted Listing phase index, and absent or malformed indices cannot authorize it',async t=>{
 const {p}=await policy(t,{resolvePurchase:purchase,paymentPhaseIndex:()=>4});
 const request=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem',logicalAddress:paymentEvidenceAddress(JOBS[0],'demos-native:DEM',4)});
 assert.equal(await p.prepare(request),true);assert.equal(await p(request,confirmationFor(request)),true);await p.settle(request,'spent');
 assert.equal(await p.prepare(requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'})),false,'the formerly hardcoded phase is refused');
 for(const index of [null,undefined,-1,-0,0.5,'4',NaN,Infinity,Number.MAX_SAFE_INTEGER+1]){
  const {p,evidencePath}=await policy(t,{resolvePurchase:purchase,paymentPhaseIndex:()=>index});
  assert.equal(await p.prepare(request),false);assert.equal(JSON.parse((await readFile(evidencePath,'utf8')).trim().split('\n').at(-1)).policyReason,'logical-address');
 }
 const missing=await policy(t,{resolvePurchase:purchase,paymentPhaseIndex:null});assert.equal(await missing.p.prepare(request),false);
});

for(const [reason,options,open] of [
 ['evaluated-party',{artifactKind:'CompositeVerificationRecord',party:'did:demos:agent:'+'c'.repeat(64)},true],
 ['logical-address',{logicalAddress:'dacs4:deliverable:'+JOBS[1]}],
 ...['listing','listingPin','listingRef'].map(field=>['listing',{artifactKind:'SettlementEvidence',artifact:{[field]:{...pin,version:2}}}]),
 ['agreement',{artifact:{agreementHash:'f'.repeat(64)}}],
 ['payment-amount',{artifactKind:'SettlementEvidence',phase:'pay-dem',artifact:{paymentAmount:{amount:'2',currency:'DEM'}}}],
])test(`policy refuses exact CREATE content with mismatched ${reason} before sign authority`,async t=>{
 const {p,evidencePath}=await policy(t,{resolvePurchase:()=>({...purchase(),...(open?{paymentObserved:false,prePaymentOpen:true}:{})})});
 assert.equal(await p.prepare(requestFor(options)),false);
 const rows=parsePolicyLedger(await readFile(evidencePath,'utf8')).rows;
 assert.equal(JSON.parse((await readFile(evidencePath,'utf8')).trim().split('\n').at(-1)).policyReason,reason);assert.equal(rows.some(row=>row.signAuthorized),false);
});

for(const change of [{jobId:JOBS[1]},{phase:'pay-dem'},{phaseIndex:-1},{listing:{...pin,version:2}},{agreementHash:'f'.repeat(64)},
 {fulfilmentId:''},{purchaseAmount:{amount:'2',currency:'DEM'}},{payloadHash:'f'.repeat(64)}])test(`policy refuses mismatched delivery binding ${Object.keys(change)[0]} before sign authority`,async t=>{
 const {p,evidencePath}=await policy(t,{resolvePurchase:purchase}),request=requestFor();
 Object.assign(request.content.deliveryBinding,change);
 const op=JSON.parse(request.content.exactCreate);op.metadata.deliveryBinding=request.content.deliveryBinding;request.content.exactCreate=JSON.stringify(op);
 assert.equal(await p.prepare(request),false);
 const rows=parsePolicyLedger(await readFile(evidencePath,'utf8')).rows;
 assert.equal(JSON.parse((await readFile(evidencePath,'utf8')).trim().split('\n').at(-1)).policyReason,'delivery-binding');assert.equal(rows.some(row=>row.signAuthorized),false);
});
test('L7 a sign-authorized preparation already holds budget against another context admission',async t=>{
 const {p,evidencePath}=await policy(t,{resolvePurchase:purchase,limits:{maxWritesPerHour:2,maxTotalOsPerHour:'8000000000'}}),r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});assert.equal(await p.prepare(r),true);
 const before=await readFile(evidencePath,'utf8'),a=createSellerContextAdmission({evidencePath,sellerApproval:{mode:'policy',maxWritesPerHour:2,maxTotalOsPerHour:'8000000000'},now:()=>T0});
 assert.equal(await a.reserve({jobId:JOBS[1],effect:'b'.repeat(64),writes:2,hold:'blocked'}),'hourly-write-limit');assert.equal(await readFile(evidencePath,'utf8'),before);
});
test('L8 context refusal ledger lines must retain their exact key and integer-time shape',()=>{
 const row={format:'dacs-node2-seller-context-admission/v1',event:'refused',jobId:JOBS[0],buyer,reason:'limit',recordedAt:T0};assert.equal(parsePolicyLedger(JSON.stringify(row)).rows.length,0);
 for(const change of [{extra:1},{reason:null},{recordedAt:T0+0.5}])assert.throws(()=>parsePolicyLedger(JSON.stringify({...row,...change})));
});
