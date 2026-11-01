import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExactOperatorApproval,parsePolicyLedger,SELLER_LEDGER_HEADER_FORMAT,SELLER_ISSUANCE_JOURNALS } from '../src/devnet-demo/operator-approval.mjs';
import { T0,requestFor } from './helpers/d5-policy-fixtures.mjs';
async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'TEST-approval-regression-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const evidencePath=join(dir,'ledger');
 const settings={maxTotalOs:'10000000000',evidencePath,now:()=>T0};
 return {evidencePath,settings,read:async()=>parsePolicyLedger(await readFile(evidencePath,'utf8'))};
}

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

for(const stage of ['decision'])test(`C-3 ${stage} append preserves an unterminated ledger record`,async t=>{
 const f=await fixture(t),r=requestFor({artifactKind:'SettlementEvidence',phase:'pay-dem'});
 const header={format:SELLER_LEDGER_HEADER_FORMAT,journals:Object.fromEntries(SELLER_ISSUANCE_JOURNALS.map(name=>[name,'a'.repeat(32)])),recordedAt:T0};
 await writeFile(f.evidencePath,JSON.stringify(header));
 const approve=createExactOperatorApproval({...f.settings,authorize:()=>true});
 assert.equal(await approve(r),true);assert.equal((await f.read()).rows.length,1);
});

test('C-5 manual approval publishes its newly created ledger directory before returning',async t=>{
 const f=await fixture(t),evidencePath=join(f.evidencePath+'-new','ledger'),original=fs.fsyncSync,synced=[];
 try{
  fs.fsyncSync=fd=>{synced.push(fs.realpathSync(`/proc/self/fd/${fd}`));return original(fd);};syncBuiltinESMExports();
  const a=createExactOperatorApproval({...f.settings,evidencePath,authorize:()=>true});assert.equal(await a(requestFor()),true);
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 assert(synced.includes(evidencePath));assert(synced.includes(f.evidencePath+'-new'));assert(synced.includes(join(f.evidencePath,'..')));
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

// The manual line's time is checked as every policy line's is (rvd D-4, dspre F5).
for(const at of [-1,1.5,Number.MAX_SAFE_INTEGER+1,'1'])test(`a manual answer at clock ${String(at)} rejects and writes no line`,async t=>{
 const f=await fixture(t),a=createExactOperatorApproval({...f.settings,now:()=>at,authorize:()=>true});
 await assert.rejects(a(requestFor()),RangeError);await assert.rejects(readFile(f.evidencePath),{code:'ENOENT'});
});

test('policy mode without its purchase and source context is refused',async t=>{
 const f=await fixture(t);
 assert.throws(()=>createExactOperatorApproval({...f.settings,sellerApproval:{mode:'policy'}}),TypeError);
});
