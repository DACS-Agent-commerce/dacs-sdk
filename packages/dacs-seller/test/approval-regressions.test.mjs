import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeSellerApproval,createExactOperatorApproval,parsePolicyLedger,heldPolicyBudget,SELLER_LEDGER_HEADER_FORMAT,SELLER_ISSUANCE_JOURNALS } from '../src/devnet-demo/operator-approval.mjs';
import { sellerRecordsPurchaseResolver } from '../src/devnet-demo/seller-purchase-source.mjs';
import { address,seller,buyer,pin,sourceBinding,artifactAuthority,T0,JOBS,PAYMENT_TX_REF,deliveredHashFor,requestFor,confirmationFor,realPurchaseResolver } from './helpers/d5-policy-fixtures.mjs';
const purchase=()=>({jobId:JOBS[0],seller,buyer,listingPin:pin,sourceBinding,agreementHash:'e'.repeat(64),amountOs:'1000000000',paymentObserved:true,paymentTxRef:{...PAYMENT_TX_REF},prePaymentOpen:false});
// An Agreement still unpaid, as seller records see it (buyer cancellation unknown).
const unpaid=()=>({...purchase(),paymentObserved:false,paymentTxRef:null,prePaymentOpen:null});
const policyInputs=(resolvePurchase,change={})=>({address,seller,sourceBinding,artifactAuthority,listingPin:()=>pin,resolvePurchase,paymentPhaseIndex:()=>2,deliveryPhaseIndex:()=>3,deliveredPayloadHash:deliveredHashFor,...change});
async function fixture(t,resolvePurchase=()=>null,{limits={},ledgerRetryMs}={}){
 const dir=await mkdtemp(join(tmpdir(),'TEST-approval-regression-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const evidencePath=join(dir,'ledger');
 const settings={maxTotalOs:'10000000000',evidencePath,now:()=>T0};
 const policyFor=(resolve=resolvePurchase)=>createExactOperatorApproval({...settings,sellerApproval:{mode:'policy',...limits},policy:policyInputs(resolve),...(ledgerRetryMs?{ledgerRetryMs}:{})});
 return {p:policyFor(),policyFor,evidencePath,settings,read:async()=>parsePolicyLedger(await readFile(evidencePath,'utf8'))};
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

test('D-1 a request changed during manual approval receives no sign authority',async t=>{
 const f=await fixture(t),r=requestFor({artifactKind:'CompositeVerificationRecord'});
 const manual=createExactOperatorApproval({...f.settings,authorize:()=>{r.content.exactCreate='{"changed":true}';return true;}});
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual});
 assert.equal(await a(r),false);
 const ledger=await f.read();assert.equal(ledger.rows.some(row=>row.signAuthorized),false);assert.equal(heldPolicyBudget(ledger.rows,T0).writes,0);
});

test('D-1 a request changed during an asynchronous policy read receives no approval',async t=>{
 const r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});
 const f=await fixture(t,async()=>{r.content.exactCreate='{"changed":true}';return purchase();});
 assert.equal(await f.p.prepare(r),false);assert.equal((await f.read()).rows.some(row=>row.signAuthorized),false);
});

test('D-1 direct manual approval refuses changed bytes and retains immutable approved bytes',async t=>{
 const f=await fixture(t),changed=requestFor();
 const manual=createExactOperatorApproval({...f.settings,authorize:()=>{changed.content.exactCreate='{}';return true;}});
 assert.equal(await manual(changed),false);
 const r=requestFor(),approve=createExactOperatorApproval({...f.settings,authorize:()=>true});
 assert.equal(await approve(r),true);assert(Object.isFrozen(r));assert(Object.isFrozen(r.content.debit));
 assert.throws(()=>{r.content.exactCreate='{}';},TypeError);
 const lines=(await readFile(f.evidencePath,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(lines.at(-1).requestBytes,JSON.stringify(r));
});

for(const [state,found] of [
 ['closed',{...unpaid(),prePaymentOpen:false}],
 ['paid',{...purchase(),prePaymentOpen:null}],
 ['indeterminate',{...unpaid(),paymentObserved:null}],
 ['access-refused',false],
])test(`D-2 a held purchase becoming ${state} during manual approval is released without sign authority`,async t=>{
 let current=null;const f=await fixture(t,async()=>current);let prompts=0;
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>{prompts++;current=found;return true;}});
 assert.equal(await a(requestFor({artifactKind:'CompositeVerificationRecord'})),false);assert.equal(prompts,1);
 const ledger=await f.read();assert.equal(ledger.rows.some(row=>row.signAuthorized),false);assert.equal(heldPolicyBudget(ledger.rows,T0).writes,0);
 assert.equal([...ledger.attempts.values()][0].outcome,'released');
});

// A purchase resolver that fails is not a refusal: before payment a refusal is final for the artifact, so
// nothing is decided or written and a retry decides.
const timeout=()=>Object.assign(new Error('purchase source timed out'),{code:'ETIMEDOUT'});
const policyChecksFailed=async(f)=>(await readFile(f.evidencePath,'utf8')).trim().split('\n').map(JSON.parse).filter(line=>line.policyReason==='policy-check-failed');
test('a purchase resolver failure before payment leaves a Vet undecided, and a retry reaches manual approval',async t=>{
 let reads=0;const f=await fixture(t,async()=>{if(++reads===1)throw timeout();return null;});let prompts=0;
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>{prompts++;return true;}}),r=requestFor({artifactKind:'CompositeVerificationRecord'});
 await assert.rejects(a(r),{code:'ETIMEDOUT'});assert.equal(prompts,0);
 await assert.rejects(readFile(f.evidencePath),{code:'ENOENT'});
 assert.equal(await a(r),true);assert.equal(prompts,1);assert.equal((await f.read()).rows.filter(row=>row.signAuthorized).length,1);
});
test('a purchase resolver failure at confirmation (its purchase reread) leaves a held Vet unconfirmed and not rejected',async t=>{
 let reads=0,failAt=null;const f=await fixture(t,async()=>{if(++reads===failAt)throw timeout();return null;});
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>true}),r=requestFor({artifactKind:'CompositeVerificationRecord'});
 assert.equal(await a(r),true);failAt=reads+1;
 await assert.rejects(a.confirm(confirmationFor(r)),{code:'ETIMEDOUT'});
 assert.deepEqual(await policyChecksFailed(f),[]);assert.equal((await f.read()).rows.find(row=>row.signAuthorized).outcome,null);
 await a.settle(r,'released');assert.equal(heldPolicyBudget((await f.read()).rows,T0).writes,0);
});

test('C-4 synchronous abort during a manual callback records no decision',async t=>{
 const f=await fixture(t),controller=new AbortController();
 const a=createExactOperatorApproval({...f.settings,signal:controller.signal,authorize:()=>{controller.abort();return true;}});
 await assert.rejects(a(requestFor()),{code:'operator_closing'});
 await assert.rejects(readFile(f.evidencePath),{code:'ENOENT'});
});

test('C-4 synchronous abort also ends an unanswered manual callback',async t=>{
 const f=await fixture(t),controller=new AbortController();
 const a=createExactOperatorApproval({...f.settings,signal:controller.signal,authorize:()=>{controller.abort();return new Promise(()=>{});}});
 await assert.rejects(a(requestFor()),{code:'operator_closing'});
 await assert.rejects(readFile(f.evidencePath),{code:'ENOENT'});
});

for(const stage of ['decision','signing','completion'])test(`C-3 ${stage} append preserves an unterminated ledger record`,async t=>{
 const f=await fixture(t,purchase),r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});
 if(stage==='completion'){
  assert.equal(await f.p.prepare(r),true);await writeFile(f.evidencePath,(await readFile(f.evidencePath,'utf8')).trimEnd());
  await f.p.settle(r,'spent');assert.equal((await f.read()).rows[0].outcome,'spent');
 }else{
  const header={format:SELLER_LEDGER_HEADER_FORMAT,journals:Object.fromEntries(SELLER_ISSUANCE_JOURNALS.map(name=>[name,'a'.repeat(32)])),recordedAt:T0};
  await writeFile(f.evidencePath,JSON.stringify(header));
  const approve=stage==='signing'?f.p.prepare:createExactOperatorApproval({...f.settings,authorize:()=>true});
  assert.equal(await approve(r),true);assert.equal((await f.read()).rows.length,1);
 }
});

test('D-3 completion syncs its file before reporting success',async t=>{
 const f=await fixture(t,purchase),r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});assert.equal(await f.p.prepare(r),true);
 const original=fs.fsyncSync;let synced=false;
 try{
  fs.fsyncSync=fd=>{if(fs.realpathSync(`/proc/self/fd/${fd}`)===f.evidencePath)synced=true;return original(fd);};syncBuiltinESMExports();
  await f.p.settle(r,'spent');assert.equal(synced,true);
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();}
});

for(const stage of ['file','directory'])test(`C-5 ${stage} sync failure prevents signature approval`,async t=>{
 const f=await fixture(t,purchase),r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'}),original=fs.fsyncSync,cause=new Error(`TEST ${stage} sync failed`);
 try{
  fs.fsyncSync=fd=>{if(fs.fstatSync(fd).isDirectory()===(stage==='directory'))throw cause;return original(fd);};syncBuiltinESMExports();
  const answer=await f.p.prepare(r).catch(error=>{assert.equal(error,cause);return false;});assert.equal(answer,false);
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();}
});

test('C-5 manual approval publishes its newly created ledger directory before returning',async t=>{
 const f=await fixture(t),evidencePath=join(f.evidencePath+'-new','ledger'),original=fs.fsyncSync,synced=[];
 try{
  fs.fsyncSync=fd=>{synced.push(fs.realpathSync(`/proc/self/fd/${fd}`));return original(fd);};syncBuiltinESMExports();
  const a=createExactOperatorApproval({...f.settings,evidencePath,authorize:()=>true});assert.equal(await a(requestFor()),true);
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 assert(synced.includes(evidencePath));assert(synced.includes(f.evidencePath+'-new'));assert(synced.includes(join(f.evidencePath,'..')));
});

test('D-1 direct held authorization cannot change retained bytes during its final resolver read',async t=>{
 const r=requestFor({artifactKind:'CompositeVerificationRecord'});let reads=0;
 const f=await fixture(t,async()=>{if(++reads===2)r.content.exactCreate='{"changed":true}';return null;});
 assert.equal((await f.p.decide(r)).outcome,'held');
 assert.equal(await f.p.authorizeHeld(r,true),'refused');assert.equal((await f.read()).rows.some(row=>row.signAuthorized),false);
 await f.p.settle(r,'released');assert.equal(heldPolicyBudget((await f.read()).rows,T0).writes,0);
});

const lastLine=async(f)=>JSON.parse((await readFile(f.evidencePath,'utf8')).trim().split('\n').at(-1));

// Sign authority for a write after payment rereads the paid purchase immediately before its append.
for(const [label,request] of [['payment evidence',()=>requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'})],['a Deliverable',()=>requestFor()]]){
 test(`a paid purchase that is no longer paid before sign authority gives ${label} no sign authority`,async t=>{
  let reads=0;const f=await fixture(t,async()=>++reads===1?purchase():unpaid());
  assert.equal(await f.p.prepare(request()),false);assert.equal(reads,2);
  assert.equal((await f.read()).rows.some(row=>row.signAuthorized),false);assert.equal((await lastLine(f)).policyReason,'payment-not-observed');
 });
 test(`a still-paid purchase gives ${label} sign authority after its final reread`,async t=>{
  let reads=0;const f=await fixture(t,async()=>{reads++;return purchase();});
  assert.equal(await f.p.prepare(request()),true);assert.equal(reads,2);assert.equal((await f.read()).rows.filter(row=>row.signAuthorized).length,1);
 });
}

// One open sign authority per exact request, in this process and after a restart.
for(const [label,again] of [
 ['the same request',(f,r)=>f.p.prepare(r)],
 ['an exact copy',(f,r)=>f.p.prepare(structuredClone(r))],
 ['an exact copy after a restart',(f,r)=>f.policyFor().prepare(structuredClone(r))],
])test(`repeating an exact preparation as ${label} adds no second open sign authority`,async t=>{
 const f=await fixture(t,purchase),r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});
 assert.equal(await f.p.prepare(r),true);assert.equal(await again(f,r),false);
 assert.equal((await f.read()).rows.filter(row=>row.signAuthorized).length,1);assert.equal((await lastLine(f)).policyReason,'sign-authorization-open');
 assert.equal(await f.p(r,confirmationFor(r)),true);
});
test('an exact request is sign-authorized again once its earlier sign authority ended',async t=>{
 const f=await fixture(t,purchase),r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});
 assert.equal(await f.p.prepare(r),true);await f.p.settle(r,'released');
 assert.equal(await f.p.prepare(structuredClone(r)),true);assert.equal((await f.read()).rows.filter(row=>row.signAuthorized&&row.outcome===null).length,1);
});

// The rebuilt lifecycle: fixed policy outcomes, one closed manual table, one sign gate (rvd-sdk-365-21c-r4).
const payDem=()=>requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});
const ledgerLines=async(f)=>(await readFile(f.evidencePath,'utf8')).trim().split('\n').map(JSON.parse);
const openSignRows=async(f)=>(await f.read()).rows.filter(row=>row.signAuthorized&&row.outcome===null);
const OVER_CAP={limits:{maxWriteTotalOs:'1000000000'}};
test('D-1 a copy with another purpose at the same wallet nonce gets no second open sign authority',async t=>{
 const f=await fixture(t,purchase),r=payDem(),other=structuredClone(r);other.purpose='TEST another purpose';
 assert.equal(await f.p.prepare(r),true);assert.equal(await f.p.prepare(other),false);
 assert.equal((await lastLine(f)).policyReason,'sign-authorization-open');assert.equal((await openSignRows(f)).length,1);
});
test('D-2 a purchase that turns unpaid during the manual wait gets neither sign authority nor confirmation',async t=>{
 let current=purchase();const f=await fixture(t,async()=>current,OVER_CAP);
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>{current=unpaid();return true;}});
 assert.equal(await a(payDem()),false);assert.equal((await f.read()).rows.some(row=>row.signAuthorized),false);
 assert.equal([...(await f.read()).attempts.values()][0].reason,'confirmation-refused');
 current=purchase();const b=composeSellerApproval({mode:'policy',policy:(await fixture(t,async()=>current)).p,manual:()=>assert.fail('no prompt')}),r=payDem();
 assert.equal(await b(r),true);current=unpaid();assert.equal(await b.confirm(confirmationFor(r)),false);
});
test('D-3 a purchase read that times out after payment rejects with no prompt and no decision line',async t=>{
 const f=await fixture(t,async()=>{throw timeout();},OVER_CAP);let prompts=0;
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>{prompts++;return true;}});
 for(const r of [payDem(),requestFor()])await assert.rejects(a(r),{code:'ETIMEDOUT'});
 assert.equal(prompts,0);await assert.rejects(readFile(f.evidencePath),{code:'ENOENT'});
});
// Resolves once the policy reports the ledger unreadable (it then waits, unsigned and not refused).
function ledgerWait(t){
 const write=process.stderr.write;let seen;const waiting=new Promise(done=>{seen=done;});
 process.stderr.write=function(text,...rest){if(String(text).startsWith('seller-policy-ledger unreadable'))seen();return write.call(this,text,...rest);};
 t.after(()=>{process.stderr.write=write;});
 return waiting;
}
for(const [label,end] of [['stop ends the wait',async(f,a,pending)=>{await f.p.stop();await assert.rejects(pending,{code:'seller_approval_stopped'});}],
 ['a repaired ledger is decided again',async(f,a,pending)=>{await writeFile(f.evidencePath,'');assert.equal(await pending,true);}]])test(`D-4 a torn ledger at restart holds paid evidence with no prompt: ${label}`,async t=>{
 const f=await fixture(t,purchase,{...OVER_CAP,ledgerRetryMs:1});let prompts=0;await writeFile(f.evidencePath,'{"format":');
 const waiting=ledgerWait(t),a=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>{prompts++;return true;}}),pending=a(payDem());
 await waiting;assert.equal(prompts,0);await end(f,a,pending);
});
test('D-5 a second composer on the same ledger is not asked to approve a copy with open sign authority',async t=>{
 const f=await fixture(t,purchase,OVER_CAP),r=payDem();let prompts=0;const manual=()=>{prompts++;return true;};
 assert.equal(await composeSellerApproval({mode:'policy',policy:f.p,manual})(r),true);assert.equal(prompts,1);
 assert.equal(await composeSellerApproval({mode:'policy',policy:f.policyFor(),manual})(structuredClone(r)),false);
 assert.equal(prompts,1);assert.equal((await f.read()).rows.filter(row=>row.signAuthorized).length,1);
});
test('(a) two held copies of one write: only the first manual answer gets sign authority',async t=>{
 const f=await fixture(t),first=requestFor({artifactKind:'CompositeVerificationRecord'}),second=structuredClone(first);
 for(const r of [first,second])assert.equal((await f.p.decide(r)).outcome,'held');
 assert.equal(await f.p.authorizeHeld(first,true),'signed');assert.equal(await f.p.authorizeHeld(second,true),'refused');
 assert.equal((await openSignRows(f)).length,1);assert.deepEqual([...(await f.read()).attempts.values()].map(attempt=>attempt.outcome),[null,'released']);
});
test('(b) a manual answer after payment is one attempt: a hold line, then a sign line, counted before approval returns',async t=>{
 const f=await fixture(t,purchase,OVER_CAP);let lines=null;
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual:async()=>{lines=await ledgerLines(f);return true;}});
 assert.equal(await a(payDem()),true);
 assert.deepEqual(lines.map(line=>[line.policyReason,Boolean(line.attemptId)]),[['write-fee-cap',true]]);
 const after=await ledgerLines(f);assert.equal(after.length,2);assert.equal(after[1].attemptId,lines[0].attemptId);
 assert.equal(heldPolicyBudget((await f.read()).rows,T0).writes,1);
});
test('(c) payment not observed is final: it is never offered for manual approval',async t=>{
 const f=await fixture(t,unpaid);let prompts=0;
 assert.equal(await composeSellerApproval({mode:'policy',policy:f.p,manual:()=>{prompts++;return true;}})(payDem()),false);
 assert.equal(prompts,0);const line=await lastLine(f);assert.equal(line.policyReason,'payment-not-observed');assert.equal(line.attemptId,undefined);
});
test('D-6 confirm after a Listing or manual-mode approval is false and writes nothing',async t=>{
 const f=await fixture(t),listing=requestFor();listing.content.artifactKind='Listing';
 for(const [mode,r] of [['policy',listing],['manual',requestFor()]]){
  const a=composeSellerApproval({mode,policy:f.p,manual:()=>true});
  assert.equal(await a(r),true);assert.equal(await a.confirm(confirmationFor(r)),false);
 }
 await assert.rejects(readFile(f.evidencePath),{code:'ENOENT'});
});
test('a shutdown that ends a held manual answer releases the attempt and keeps the closing error',async t=>{
 const f=await fixture(t),closing=Object.assign(new Error('TEST closing'),{code:'operator_closing'});
 await assert.rejects(composeSellerApproval({mode:'policy',policy:f.p,manual:()=>{throw closing;}})(requestFor({artifactKind:'CompositeVerificationRecord'})),closing);
 assert.equal([...(await f.read()).attempts.values()][0].reason,'operator-released');
});
test('a confirmation retains the executed transaction it checked, not the rest of the node answer',async t=>{
 const f=await fixture(t,purchase),r=payDem(),v=confirmationFor(r);v.response.data.message='x'.repeat(2_000_000);
 assert.equal(await f.p.prepare(r),true);assert.equal(await f.p(r,v),true);
 assert.ok((await readFile(f.evidencePath)).length<64*1024);
});

// The closed manual table, for every write kind and every reason a policy can give.
const REASONS=['request-shape','debit','write-fee-cap','create-bytes','artifact','logical-address','purchase','purchase-closed','payment-not-observed','payment-already-observed',
 'seller-record-missing','cancellation-unknown','evaluated-party','listing','agreement','parties','payment-amount','payment-tx','deliverable','delivery-binding','request-changed',
 'sign-authorization-open','operator-fee-budget','job-write-limit','hourly-write-limit','hourly-dem-limit'];
const MANUAL_TABLE={before:['seller-record-missing','cancellation-unknown'],after:['write-fee-cap','job-write-limit','hourly-write-limit','hourly-dem-limit']};
for(const [kind,phase] of [['CompositeVerificationRecord','before'],['FinalityCommitmentRecord','before'],['Deliverable','after'],['SettlementEvidence','after']])test(`the composer asks manual for a held ${kind} only for its table reasons`,async()=>{
 const asked=[],released=[];
 for(const reason of REASONS){
  const request={content:{artifactKind:kind}};
  const policy={decide:async()=>({outcome:'held',reason,attemptId:'TEST',requestBytes:JSON.stringify(request)}),authorizeHeld:async()=>'refused',releaseHeld:async(held,why)=>{released.push([reason,why]);},settle:async()=>{}};
  await composeSellerApproval({mode:'policy',policy,manual:()=>{asked.push(reason);return true;}})(request);
 }
 assert.deepEqual(asked,MANUAL_TABLE[phase]);
 assert.deepEqual(released,REASONS.filter(reason=>!MANUAL_TABLE[phase].includes(reason)).map(reason=>[reason,'confirmation-refused']));
});

// Purchase authority read last before every sign and confirmation line: a purchase that changes on that read
// stops the line (rvc r2 C-1 for the confirmation).
for(const [label,write,current,changed,options] of [
 ['an automatic write after payment',payDem,purchase,unpaid,{}],
 ['a held write after payment',payDem,purchase,unpaid,OVER_CAP],
 ['a held write before payment',()=>requestFor({artifactKind:'FinalityCommitmentRecord'}),unpaid,()=>({...unpaid(),prePaymentOpen:false}),{}],
]){
 const run=async(t,flipAt)=>{
  let reads=0;const f=await fixture(t,async()=>++reads===flipAt?changed():current(),options);
  const a=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>true}),r=write(),signed=await a(r),signReads=reads;
  return{f,r,signed,signReads,confirmed:signed&&await a.confirm(confirmationFor(r)),confirmReads:reads};
 };
 test(`${label}: the last purchase read before its sign line and before its confirmation line decides`,async t=>{
  const clean=await run(t,0);assert.deepEqual([clean.signed,clean.confirmed],[true,true]);
  const beforeSign=await run(t,clean.signReads);assert.equal(beforeSign.signed,false);assert.equal((await beforeSign.f.read()).rows.some(row=>row.signAuthorized),false);
  const beforeConfirm=await run(t,clean.confirmReads);assert.deepEqual([beforeConfirm.signed,beforeConfirm.confirmed],[true,false]);
  assert.equal((await beforeConfirm.f.read()).rows.find(row=>row.signAuthorized).outcome,'released');
 });
}

// Stop ends a pending manual callback even with no external signal, and records no decision.
test('stop ends an unanswered manual callback with no external signal',async t=>{
 const f=await fixture(t);let asked=0;
 const a=createExactOperatorApproval({...f.settings,authorize:()=>{asked++;return new Promise(()=>{});}});
 const outcome=assert.rejects(a(requestFor()),{code:'operator_closing'});
 assert.equal(asked,1);await a.stop();await outcome;
 await assert.rejects(readFile(f.evidencePath),{code:'ENOENT'});
 await assert.rejects(a(requestFor()),{code:'seller_approval_stopped'});
});

// Every exit of a held attempt ends it, and no line is written for an attempt that has ended (cold F1, cold2 F1).
const vetRequest=()=>requestFor({artifactKind:'CompositeVerificationRecord'});
const attemptReasons=async(f)=>[...(await f.read()).attempts.values()].map(attempt=>attempt.reason);
const WEEK_MS=7*24*3_600_000;
for(const [label,prepare] of [['prepare',(f,r)=>f.p.prepare(r)],['policy-mode approve',(f,r)=>f.p(r)]])test(`a held write prepared through ${label} opens no attempt and holds no budget`,async t=>{
 const f=await fixture(t);assert.equal(await prepare(f,vetRequest()),false);
 const ledger=await f.read();assert.equal(ledger.attempts.size,0);assert.equal(heldPolicyBudget(ledger.rows,T0+WEEK_MS).writes,0);
});
test('a held preparation at the hourly write limit leaves a restarted composer able to ask and approve a Vet',async t=>{
 const f=await fixture(t,()=>null,{limits:{maxWritesPerHour:1}});let prompts=0;
 assert.equal(await f.p.prepare(vetRequest()),false);
 assert.equal(await composeSellerApproval({mode:'policy',policy:f.policyFor(),manual:()=>{prompts++;return true;}})(vetRequest()),true);assert.equal(prompts,1);
});
test('a sign gate that throws after a manual yes releases the held attempt and keeps the error',async t=>{
 let reads=0;const f=await fixture(t,async()=>{if(++reads===2)throw timeout();return null;});
 await assert.rejects(composeSellerApproval({mode:'policy',policy:f.p,manual:()=>true})(vetRequest()),{code:'ETIMEDOUT'});
 assert.deepEqual(await attemptReasons(f),['sign-authorization-failed']);
});
test('a retry after a sign gate error is counted once and approved under a one-write hourly limit',async t=>{
 let reads=0;const f=await fixture(t,async()=>{if(++reads===2)throw timeout();return null;},{limits:{maxWritesPerHour:1}});let prompts=0;
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>{prompts++;return true;}}),r=vetRequest();
 await assert.rejects(a(r),{code:'ETIMEDOUT'});assert.equal(await a(r),true);assert.equal(prompts,2);
});
for(const [label,end,code] of [['ends with the closing error',fail=>fail(Object.assign(new Error('TEST closing'),{code:'operator_closing'})),'operator_closing'],
 ['answers no',(fail,answer)=>answer(false),'seller_approval_stopped']])test(`a manual answer that ${label} after the policy stopped still releases the held attempt`,async t=>{
 const f=await fixture(t);let answer,fail,asked;const prompted=new Promise(done=>{asked=done;});
 const pending=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>new Promise((done,reject)=>{answer=done;fail=reject;asked();})})(vetRequest());
 await prompted;await f.p.stop();end(fail,answer);
 await assert.rejects(pending,{code});assert.deepEqual(await attemptReasons(f),['operator-released']);
});
// A manual approval on f's ledger whose first prompt waits for answer(value); any later prompt answers no.
function deferredManual(settings){
 let answer,asked,prompts=0;const prompted=new Promise(done=>{asked=done;});
 const manual=createExactOperatorApproval({...settings,authorize:()=>{if(++prompts>1)return false;asked();return new Promise(done=>{answer=done;});}});
 return{manual,prompted,answer:value=>answer(value)};
}
test('a second approval of a request whose manual answer is pending rejects, writes nothing and leaves the first answer valid',async t=>{
 const f=await fixture(t,purchase,OVER_CAP),d=deferredManual(f.settings),a=composeSellerApproval({mode:'policy',policy:f.p,manual:d.manual}),r=payDem();
 const first=a(r);await d.prompted;const lines=(await ledgerLines(f)).length;
 await assert.rejects(a(r),{code:'seller_approval_pending'});assert.equal((await ledgerLines(f)).length,lines);
 d.answer(true);assert.equal(await first,true);
 const ledger=await f.read();assert.equal(ledger.attempts.size,1);assert.equal((await openSignRows(f)).length,1);
});
for(const [label,end] of [['the wallet released it',(f,a,r)=>a.settle(r,'released')],['the policy released it',(f,a,r)=>f.p.releaseHeld(r,'operator-released')]])
 test(`a manual answer that arrives after ${label} writes nothing and leaves the ledger readable`,async t=>{
  const f=await fixture(t,purchase,OVER_CAP),d=deferredManual(f.settings),a=composeSellerApproval({mode:'policy',policy:f.p,manual:d.manual}),r=payDem();
  const pending=a(r);await d.prompted;await end(f,a,r);const lines=(await ledgerLines(f)).length;
  d.answer(true);assert.equal(await pending,false);
  assert.equal((await ledgerLines(f)).length,lines);assert.equal((await f.read()).rows.some(row=>row.signAuthorized),false);
 });
// A policy whose decide returns after `change(request)` altered the request, as if it changed while the composer waited.
const changingAfterDecide=(f,change)=>Object.assign((...args)=>f.p(...args),f.p,{decide:async request=>{const decision=await f.p.decide(request);change(request);return decision;}});
test('a request changed after the policy held it is not asked about, writes no manual line and ends released',async t=>{
 const f=await fixture(t,purchase,OVER_CAP),r=payDem();let prompts=0;
 const manual=createExactOperatorApproval({...f.settings,authorize:()=>{prompts++;return true;}});
 assert.equal(await composeSellerApproval({mode:'policy',policy:changingAfterDecide(f,request=>{request.purpose='TEST changed';}),manual})(r),false);
 assert.equal(prompts,0);assert.deepEqual(await attemptReasons(f),['confirmation-refused']);
 assert.equal((await f.read()).rows.some(row=>row.signAuthorized),false);assert.equal((await ledgerLines(f)).some(line=>line.decision&&!line.approvalMode),false);
});
test('a request changed and changed back around the policy hold is not asked about',async t=>{
 const f=await fixture(t,purchase,OVER_CAP),r=payDem(),original=r.purpose;let prompts=0;
 const pending=composeSellerApproval({mode:'policy',policy:changingAfterDecide(f,request=>{request.purpose=original;}),manual:()=>{prompts++;return true;}})(r);
 r.purpose='TEST changed';assert.equal(await pending,false);
 assert.equal(prompts,0);assert.deepEqual(await attemptReasons(f),['confirmation-refused']);assert.equal((await f.read()).rows.some(row=>row.signAuthorized),false);
});
test('a request changed before the policy captures it is shown to manual as the bytes its sign line keeps',async t=>{
 const f=await fixture(t,purchase,OVER_CAP),r=payDem();let shown=null;
 const pending=composeSellerApproval({mode:'policy',policy:f.p,manual:request=>{shown=request.purpose;return true;}})(r);
 r.purpose='TEST changed';assert.equal(await pending,true);
 assert.equal(shown,'TEST changed');assert.equal((await openSignRows(f))[0].request.purpose,'TEST changed');
});
test('a manual approval on the same ledger answers for the bytes the policy captured, not the earlier request',async t=>{
 const f=await fixture(t,purchase,OVER_CAP),r=payDem();let asked=null;
 const manual=createExactOperatorApproval({...f.settings,authorize:answer=>{asked=answer;return true;}});
 const pending=composeSellerApproval({mode:'policy',policy:f.p,manual})(r);
 r.purpose='TEST changed';assert.equal(await pending,true);
 assert.equal(asked.request.purpose,'TEST changed');assert.equal(asked.approvalHash,(await openSignRows(f))[0].approvalHash);
});
test('a Vet request changed into a held write of another kind is asked about once and leaves no open attempt',async t=>{
 const f=await fixture(t,purchase,OVER_CAP),r=vetRequest();let prompts=0;
 const pending=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>{prompts++;return true;}})(r);
 Object.assign(r,payDem());assert.equal(await pending,true);assert.equal(prompts,1);
 assert.deepEqual([...(await f.read()).attempts.values()].filter(attempt=>attempt.outcome===null&&!attempt.reservation),[]);
});
test('a manual answer for bytes changed during the wait writes no sign line and leaves the ledger readable',async t=>{
 const f=await fixture(t,purchase,OVER_CAP),r=payDem();
 assert.equal(await composeSellerApproval({mode:'policy',policy:f.p,manual:createExactOperatorApproval({...f.settings,authorize:()=>{r.purpose='TEST changed';return true;}})})(r),false);
 assert.equal((await f.read()).rows.some(row=>row.signAuthorized),false);assert.deepEqual(await attemptReasons(f),['confirmation-refused']);
});
test('a manual approval on another ledger writes no line for an attempt it does not have',async t=>{
 const f=await fixture(t,purchase,OVER_CAP),other=f.evidencePath+'-manual';
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual:createExactOperatorApproval({...f.settings,evidencePath:other,authorize:()=>true})});
 assert.equal(await a(payDem()),false);await assert.rejects(readFile(other),{code:'ENOENT'});
 assert.deepEqual(await attemptReasons(f),['manual-declined']);
});
// A held attempt whose sign line was written but not synced, and whose cleanup append also failed.
async function unsyncedSignLine(t){
 const f=await fixture(t),r=vetRequest(),{fsyncSync,openSync}=fs;let syncs=0,appends=0;
 assert.equal((await f.p.decide(r)).outcome,'held');
 try{
  fs.fsyncSync=fd=>{if(fs.realpathSync(`/proc/self/fd/${fd}`)===f.evidencePath&&++syncs===1)throw new Error('TEST sync failed');return fsyncSync(fd);};
  fs.openSync=(path,flags,...rest)=>{if(flags==='a'&&++appends===2)throw new Error('TEST append failed');return openSync(path,flags,...rest);};
  syncBuiltinESMExports();
  assert.equal(await f.p.authorizeHeld(r,true),'unsigned');
 }finally{fs.fsyncSync=fsyncSync;fs.openSync=openSync;syncBuiltinESMExports();}
 assert.equal((await openSignRows(f)).length,1);
 return{f,r};
}
for(const [label,end] of [['decided again',(f,r)=>f.p.decide(r)],['released',(f,r)=>f.p.releaseHeld(r,'operator-released')],['settled as released',(f,r)=>f.p.settle(r,'released')]])
 test(`a request whose sign line failed to sync and clean up stays readable when it is ${label}`,async t=>{
  const{f,r}=await unsyncedSignLine(t);await end(f,r);
  assert.equal((await openSignRows(f)).length,1);assert.equal((await f.policyFor().reconcile()).held.length,1);
 });
