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
 const p=createExactOperatorApproval({...settings,sellerApproval:{mode:'policy'},policy:{address,seller,sourceBinding,listingPin:()=>pin,resolvePurchase,paymentPhaseIndex:()=>2,deliveryPhaseIndex:()=>3}});
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
 ['closed',{...purchase(),paymentObserved:false,prePaymentOpen:false}],
 ['paid',{...purchase(),paymentObserved:true,prePaymentOpen:null}],
 ['indeterminate',{...purchase(),paymentObserved:null,prePaymentOpen:null}],
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
for(const [read,failOn] of [['policy read',1],['final reread',2]])test(`a purchase resolver failure at confirmation (${read}) leaves a held Vet unconfirmed and not rejected`,async t=>{
 let reads=0,failAt=null;const f=await fixture(t,async()=>{if(++reads===failAt)throw timeout();return null;});
 const a=composeSellerApproval({mode:'policy',policy:f.p,manual:()=>true}),r=requestFor({artifactKind:'CompositeVerificationRecord'});
 assert.equal(await a(r),true);failAt=reads+failOn;
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
 assert.equal(await f.p.prepare(r),false);assert.equal(f.p.heldForManual(r),true);
 assert.equal(await f.p.authorizeSign(r),false);assert.equal((await f.read()).rows.some(row=>row.signAuthorized),false);
 await f.p.settle(r,'released');assert.equal(heldPolicyBudget((await f.read()).rows,T0).writes,0);
});

const lastLine=async(f)=>JSON.parse((await readFile(f.evidencePath,'utf8')).trim().split('\n').at(-1));

// Sign authority for a write after payment rereads the paid purchase immediately before its append.
for(const [label,request] of [['payment evidence',()=>requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'})],['a Deliverable',()=>requestFor()]]){
 test(`a paid purchase that is no longer paid before sign authority gives ${label} no sign authority`,async t=>{
  let reads=0;const f=await fixture(t,async()=>({...purchase(),paymentObserved:++reads===1}));
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
 ['an exact copy after a restart',(f,r)=>createExactOperatorApproval({...f.settings,sellerApproval:{mode:'policy'},policy:{address,seller,sourceBinding,listingPin:()=>pin,resolvePurchase:purchase,paymentPhaseIndex:()=>2}}).prepare(structuredClone(r))],
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

test('a policy approval of an artifact that is not valid for its kind is rejected as artifact-structure with no sign authority',async t=>{
 const f=await fixture(t,purchase),r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem',artifact:{evidenceVersion:'invalid',outcome:'invalid'}});
 assert.equal(await f.p.prepare(r),false);
 assert.equal((await lastLine(f)).decision,'rejected');assert.equal((await lastLine(f)).policyReason,'artifact-structure');
 assert.equal((await f.read()).rows.some(row=>row.signAuthorized),false);
});

// Stop ends a pending manual callback even with no external signal, and records no decision.
test('stop ends an unanswered manual callback with no external signal',async t=>{
 const f=await fixture(t);let asked=0;
 const a=createExactOperatorApproval({...f.settings,authorize:()=>{asked++;return new Promise(()=>{});}});
 const outcome=assert.rejects(a(requestFor()),{code:'operator_closing'});
 assert.equal(asked,1);await a.stop();await outcome;
 await assert.rejects(readFile(f.evidencePath),{code:'ENOENT'});
 await assert.rejects(a(requestFor()),{code:'seller_approval_stopped'});
});
