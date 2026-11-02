import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExactOperatorApproval,parsePolicyLedger } from '../src/devnet-demo/operator-approval.mjs';
import { address,seller,buyer,pin,sourceBinding,artifactAuthority,T0,JOBS,PAYMENT_TX_REF,deliveredHashFor,requestFor,confirmationFor } from './helpers/d5-policy-fixtures.mjs';

// stop() and settle() against the approval ledger: a release that fails is reported and retried, and the wallet's
// outcome for a sign line is still recorded after stop().
const paidPurchase=()=>({jobId:JOBS[0],seller,buyer,listingPin:pin,sourceBinding,agreementHash:'e'.repeat(64),amountOs:'1000000000',paymentObserved:true,paymentTxRef:{...PAYMENT_TX_REF},prePaymentOpen:false});
const policyInputs=(resolvePurchase)=>({address,seller,sourceBinding,artifactAuthority,listingPin:()=>pin,resolvePurchase,paymentPhaseIndex:()=>2,deliveryPhaseIndex:()=>3,deliveredPayloadHash:deliveredHashFor});
async function fixture(t,resolvePurchase=()=>null){
 const dir=await mkdtemp(join(tmpdir(),'TEST-approval-stop-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const evidencePath=join(dir,'ledger'),settings={maxTotalOs:'10000000000',evidencePath,now:()=>T0};
 const policyFor=()=>createExactOperatorApproval({...settings,sellerApproval:{mode:'policy'},policy:policyInputs(resolvePurchase)});
 return {p:policyFor(),policyFor,evidencePath,read:async()=>parsePolicyLedger(await readFile(evidencePath,'utf8'))};
}
const vetRequest=()=>requestFor({artifactKind:'CompositeVerificationRecord'});
const payDem=()=>requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});
const openSignRows=async(f)=>(await f.read()).rows.filter(row=>row.signAuthorized&&row.outcome===null);
const openAttempts=async(f)=>[...(await f.read()).attempts.values()].filter(attempt=>attempt.outcome===null);
const attemptReasons=async(f)=>[...(await f.read()).attempts.values()].map(attempt=>attempt.reason);
// After `skip` more ledger append opens, the next `count` fail with EIO; the returned function restores them.
function failingAppends(t,count,skip=0){
 const{openSync}=fs;let left=count;
 fs.openSync=(path,flags,...rest)=>{if(flags==='a'&&skip-->0)return openSync(path,flags,...rest);if(flags==='a'&&left>0){left--;throw Object.assign(new Error('TEST append failed'),{code:'EIO'});}return openSync(path,flags,...rest);};
 syncBuiltinESMExports();
 const restore=()=>{fs.openSync=openSync;syncBuiltinESMExports();};t.after(restore);return restore;
}

test('stop rejects when a held attempt could not be released, and a second stop releases it',async t=>{
 const f=await fixture(t),r=vetRequest();
 assert.equal((await f.p.decide(r)).outcome,'held');
 const restore=failingAppends(t,1);await assert.rejects(f.p.stop(),{code:'EIO'});restore();
 assert.equal((await openAttempts(f)).length,1);
 await f.p.stop();
 assert.equal((await openAttempts(f)).length,0);assert.deepEqual(await attemptReasons(f),['operator-released']);
});
test('stop ends every other held attempt when one release fails, and rejects with the failure',async t=>{
 const f=await fixture(t),first=vetRequest(),second=vetRequest();
 assert.equal((await f.p.decide(first)).outcome,'held');assert.equal((await f.p.decide(second)).outcome,'held');
 const restore=failingAppends(t,1);await assert.rejects(f.p.stop(),{code:'EIO'});restore();
 assert.equal((await openAttempts(f)).length,1);
 await f.p.stop();assert.equal((await openAttempts(f)).length,0);
});
test('stop rejects when the ledger lock cannot be taken, and a second stop releases once it can',async t=>{
 const f=await fixture(t),r=vetRequest();
 assert.equal((await f.p.decide(r)).outcome,'held');
 const lockPath=`${f.evidencePath}.policy-lock`;await rm(lockPath,{recursive:true,force:true});await writeFile(lockPath,'');
 await assert.rejects(f.p.stop());
 assert.equal((await openAttempts(f)).length,1);
 await rm(lockPath);await f.p.stop();
 assert.equal((await openAttempts(f)).length,0);
});
test('concurrent stops share one release, and a stop after a clean stop writes nothing',async t=>{
 const f=await fixture(t),r=vetRequest();
 assert.equal((await f.p.decide(r)).outcome,'held');
 await Promise.all([f.p.stop(),f.p.stop()]);await f.p.stop();
 assert.deepEqual(await attemptReasons(f),['operator-released']);
});
test('settle as released after stop completes the open sign line, and a restart decides the same request again',async t=>{
 const f=await fixture(t,paidPurchase),r=payDem();
 assert.equal(await f.p.prepare(r),true);
 await f.p.stop();await f.p.settle(r,'released');
 assert.equal((await openSignRows(f)).length,0);assert.equal((await f.read()).rows.find(row=>row.signAuthorized).outcome,'released');
 assert.equal(await f.policyFor().prepare(r),true);
});
test('settle as spent after stop completes the open sign line',async t=>{
 const f=await fixture(t,paidPurchase),r=payDem();
 assert.equal(await f.p.prepare(r),true);
 await f.p.stop();await f.p.settle(r,'spent');
 assert.equal((await openSignRows(f)).length,0);assert.equal((await f.read()).rows.find(row=>row.signAuthorized).outcome,'spent');
});
test('a second settle after stop writes no second completion',async t=>{
 const f=await fixture(t,paidPurchase),r=payDem();
 assert.equal(await f.p.prepare(r),true);
 await f.p.stop();await f.p.settle(r,'released');const lines=(await readFile(f.evidencePath,'utf8')).split('\n').length;
 await f.p.settle(r,'released');assert.equal((await readFile(f.evidencePath,'utf8')).split('\n').length,lines);
});
test('settle as released after a failed stop ends the held attempt the stop could not',async t=>{
 const f=await fixture(t),r=vetRequest();
 assert.equal((await f.p.decide(r)).outcome,'held');
 const restore=failingAppends(t,1);await assert.rejects(f.p.stop(),{code:'EIO'});restore();
 await f.p.settle(r,'released');
 assert.equal((await openAttempts(f)).length,0);assert.deepEqual(await attemptReasons(f),['wallet-released']);
});
test('a settle in flight when stop is called is waited for by stop',async t=>{
 const f=await fixture(t,paidPurchase),r=payDem();
 assert.equal(await f.p.prepare(r),true);
 let settled=false;const settling=f.p.settle(r,'released').then(()=>{settled=true;});
 await f.p.stop();
 assert.equal(settled,true);await settling;assert.equal((await openSignRows(f)).length,0);
});
test('decide and prepare are still refused after stop',async t=>{
 const f=await fixture(t,paidPurchase);
 await f.p.stop();
 await assert.rejects(f.p.decide(payDem()),{code:'seller_approval_stopped'});
 await assert.rejects(f.p.prepare(payDem()),{code:'seller_approval_stopped'});
});
test('a confirmation after stop is refused and leaves the sign line open and unconfirmed',async t=>{
 const f=await fixture(t,paidPurchase),r=payDem();
 assert.equal(await f.p.prepare(r),true);
 await f.p.stop();
 await assert.rejects(f.p(r,confirmationFor(r)),{code:'seller_approval_stopped'});
 const[row]=await openSignRows(f);assert.equal(row.confirmed,null);
});
