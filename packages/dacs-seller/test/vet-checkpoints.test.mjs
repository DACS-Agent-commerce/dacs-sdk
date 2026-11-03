import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { createInMemoryPartyVetStore, openPartyVetStore } from '../src/devnet-demo/party-vet-store.mjs';
import { privateModule } from './helpers/private-module.mjs';
import { seller, JOB, NOW } from './helpers/protocol-fixture.mjs';
const api=await privateModule(new URL('../src/devnet-demo/agreement-context.mjs',import.meta.url),['partyVetState','durableOperationStore','freshOps']);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const request=(execute,changes={})=>({operationKey:'TEST-vet',operationHash:'a'.repeat(64),inputHash:'b'.repeat(64),step:'composite-anchor',execute,...changes});
async function fixture(raw=createInMemoryPartyVetStore(),initialize=true,role='seller'){
 const state=api.partyVetState(raw,seller.claim),job={jobId:JOB,incarnation:'TEST checkpoint incarnation',binding:{TEST:'exact binding'}},clock={step:null};
 if(initialize)await state.update(JOB,()=>({binding:job.binding,lifecycle:{incarnation:job.incarnation,epoch:0,state:'open',times:[]},ops:api.freshOps()}));
 const durable=api.durableOperationStore(state,job,role,{now:()=>NOW,clock});
 return{raw,state,job,clock,durable,store:durable.operationStore};
}

test('same step executes once for concurrent and repeated callers',async()=>{
 const f=await fixture(),gate=deferred(),started=deferred();let effects=0;
 const input=request(async()=>{effects++;started.resolve();await gate.promise;return{TEST:'result'};});
 const first=f.store.runOnce(input),second=f.store.runOnce(input);await started.promise;gate.resolve();
 assert.deepEqual(await Promise.all([first,second]),[{TEST:'result'},{TEST:'result'}]);await f.store.runOnce(input);assert.equal(effects,1);f.raw.close();
});
test('conflicting input is refused before another executor runs',async()=>{
 const f=await fixture(),gate=deferred(),started=deferred();let effects=0;
 const first=f.store.runOnce(request(async()=>{effects++;started.resolve();await gate.promise;return{TEST:'first'};}));await started.promise;
 const second=f.store.runOnce(request(async()=>{effects++;return{TEST:'wrong'};},{inputHash:'c'.repeat(64)}));
 gate.resolve();const results=await Promise.allSettled([first,second]);assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.match(results[1].reason.message,/conflict/);assert.equal(effects,1);f.raw.close();
});
test('terminal executor failure is retained and never invokes the executor again',async()=>{
 const f=await fixture();let effects=0;const input=request(async()=>{effects++;throw Object.assign(new Error('TEST terminal failure'),{code:'TEST_FAILED'});});
 for(let i=0;i<2;i++)await assert.rejects(f.store.runOnce(input),e=>e.message==='TEST terminal failure'&&e.code==='TEST_FAILED');assert.equal(effects,1);f.raw.close();
});
test('lost result save remains indeterminate after real database reopen without a second effect',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'TEST-vet-checkpoint-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'vet.sqlite');let raw=openPartyVetStore({path,mode:'create'}),crash=true,effects=0;
 const input=request(async()=>{effects++;return{TEST:'landed'};});const key=canonicalize({operationKey:input.operationKey,step:input.step});
 const flaky={...raw,update:(id,change)=>raw.update(id,(old,rows)=>{const next=change(old,rows);if(crash&&next?.ops?.seller?.steps?.[key]?.value!==undefined){crash=false;throw new Error('TEST result save interrupted');}return next;})};
 const f=await fixture(flaky);await assert.rejects(f.store.runOnce(input),/result save interrupted/);raw.close();raw=openPartyVetStore({path,mode:'open'});const again=await fixture(raw,false);
 const result=await Promise.allSettled([again.store.runOnce(input)]);assert.equal(result[0].status,'rejected');assert.equal(result[0].reason.code,'indeterminate');assert.equal(effects,1);raw.close();
});
test('authorization is serialized with the step and concurrent replay does not reauthorize',async()=>{
 const f=await fixture(),gate=deferred(),started=deferred();let authorizations=0,effects=0;
 const input={...request(async()=>{effects++;return{TEST:'result'};}),authorize:async()=>{authorizations++;started.resolve();await gate.promise;return{status:'authorized'};}};
 const first=f.store.runOnceAuthorized(input),second=f.store.runOnceAuthorized(input);await started.promise;gate.resolve();
 const result=await Promise.all([first,second]);assert.equal(result.every(r=>r.status==='complete'),true);assert.equal(effects,1);assert.equal(authorizations,1);f.raw.close();
});
test('rejected or unavailable authorization leaves the same step recoverable',async()=>{
 const f=await fixture();let effects=0;const input=request(async()=>{effects++;return{TEST:'result'};});
 assert.deepEqual(await f.store.runOnceAuthorized({...input,authorize:async()=>({status:'rejected',reason:'expired'})}),{status:'authorization-rejected',reason:'expired'});
 const cause=new Error('TEST lease observation failed');await assert.rejects(f.store.runOnceAuthorized({...input,authorize:async()=>{throw cause;}}),e=>e===cause);
 assert.equal((await f.store.runOnceAuthorized({...input,authorize:async()=>({status:'authorized'})})).status,'complete');assert.equal(effects,1);f.raw.close();
});
test('simultaneous composite keys retain their own signing context and exact bytes',async()=>{
 const f=await fixture(),gate=deferred(),both=deferred();let started=0;
 const make=index=>request(async()=>{if(++started===2)both.resolve();await gate.promise;const bytes=Buffer.from('TEST bytes '+index);assert.equal(f.clock.step.generatedAt,NOW);assert.equal(await f.durable.writeAhead(bytes),null);const signature=seller.signBytes(bytes).toString('base64url');await f.durable.recordSignature(bytes,signature);return{signature};},{step:'composite',operationKey:'TEST-composite-'+index});
 const work=[f.store.runOnce(make(1)),f.store.runOnce(make(2))];await both.promise;gate.resolve();const results=await Promise.allSettled(work);
 assert.equal(results.every(r=>r.status==='fulfilled'),true);assert.equal(f.clock.step,null);const row=await f.state.read(JOB);assert.equal(Object.keys(row.ops.seller.signing).length,2);f.raw.close();
});
test('competing checkpoint CAS has one winner and snapshots cannot mutate saved state',async()=>{
 const f=await fixture();const outcomes=await Promise.all([f.store.compareAndSet({operationKey:'TEST-cas',expected:null,next:{TEST:'one'}}),f.store.compareAndSet({operationKey:'TEST-cas',expected:null,next:{TEST:'two'}})]);
 assert.equal(outcomes.filter(Boolean).length,1);const value=await f.store.load('TEST-cas');value.TEST='changed';assert.notEqual((await f.store.load('TEST-cas')).TEST,'changed');f.raw.close();
});
test('changed binding refuses execution and stale checkpoint updates',async()=>{
 const f=await fixture();await f.state.update(JOB,row=>({...row,binding:{TEST:'new binding'}}));let effects=0;
 await assert.rejects(f.store.runOnce(request(async()=>{effects++;return{};})),e=>e.code==='binding-changed');await assert.rejects(f.store.compareAndSet({operationKey:'TEST',expected:null,next:{TEST:1}}),e=>e.code==='binding-changed');assert.equal(effects,0);f.raw.close();
});
test('bytes and signatures cannot conflict inside an active written-ahead signing step',async()=>{
 const f=await fixture(),bytes=Buffer.from('TEST exact signed bytes'),signature=seller.signBytes(bytes).toString('base64url');
 await f.store.runOnce(request(async()=>{
  assert.equal(await f.durable.writeAhead(bytes),null);await f.durable.recordSignature(bytes,signature);assert.equal(await f.durable.writeAhead(bytes),signature);
  await assert.rejects(f.durable.writeAhead(Buffer.from('changed')),e=>e.code==='conflict');await assert.rejects(f.durable.recordSignature(bytes,seller.signBytes(Buffer.from('other')).toString('base64url')),e=>e.code==='conflict');return{signature};
 },{step:'composite'}));
 await assert.rejects(f.durable.writeAhead(bytes),e=>e.code==='write-ahead-missing');f.raw.close();
});
test('state metadata and canonical job boundaries reject foreign records',async()=>{
 const f=await fixture();assert.deepEqual(await f.state.jobs(),[JOB]);await assert.rejects(f.state.read('bad:job'),e=>e.code==='job_invalid');
 const [key,row]=(await f.raw.entries())[0];await f.raw.update(key,()=>({...row,writer:'TEST other writer'}));await assert.rejects(f.state.read(JOB),e=>e.code==='indeterminate');f.raw.close();
});
for(const role of ['buyer','seller'])test(`interrupted ${role} composite signature save retains a terminal failure across restart without signing twice`,async()=>{
 const raw=createInMemoryPartyVetStore();let interrupt=true,signs=0,active;
 const flaky={...raw,update:(key,change)=>raw.update(key,(current,rows)=>{const next=change(current,rows);if(interrupt&&Object.values(next?.ops?.[role]?.signing??{}).some(row=>row.signature!==undefined)){interrupt=false;throw new Error('TEST signature save interrupted');}return next;})};
 active=await fixture(flaky,true,role);const input=request(async()=>{const bytes=Buffer.from('TEST durable signature');const prior=await active.durable.writeAhead(bytes);const signature=prior??(++signs,seller.signBytes(bytes).toString('base64url'));await active.durable.recordSignature(bytes,signature);return{signature};},{step:'composite'});
 await assert.rejects(active.store.runOnce(input),/signature save interrupted/);active=await fixture(raw,false,role);await assert.rejects(active.store.runOnce(input),/signature save interrupted/);assert.equal(signs,1);raw.close();
});
test('legacy successful results replay but an unfinished legacy signing step remains held',async()=>{
 const f=await fixture();let effects=0;const input=request(async()=>{effects++;return{};},{step:'composite'}),key=canonicalize({operationKey:input.operationKey,step:input.step});
 await f.state.update(JOB,row=>{row.ops.seller.signing[key]={operationHash:input.operationHash,inputHash:input.inputHash,generatedAt:NOW};return row;});
 await assert.rejects(f.store.runOnce(input),e=>e.code==='indeterminate');assert.equal(effects,0);
 await f.state.update(JOB,row=>{row.ops.seller.steps[key]={operationHash:input.operationHash,inputHash:input.inputHash,value:{TEST:'legacy result'}};return row;});
 assert.deepEqual(await f.store.runOnce(input),{TEST:'legacy result'});assert.equal(effects,0);f.raw.close();
});
test('different store handles fence the same durable step while its outcome is pending',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'TEST-vet-handles-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'vet.sqlite'),one=openPartyVetStore({path,mode:'create'}),two=openPartyVetStore({path,mode:'open'});
 const first=await fixture(one),second=await fixture(two,false),gate=deferred(),started=deferred();let effects=0;
 const input=request(async()=>{effects++;started.resolve();await gate.promise;return{TEST:'one durable effect'};});const a=first.store.runOnce(input),b=second.store.runOnce(input);await started.promise;gate.resolve();
 const result=await Promise.all([a,b]);assert.deepEqual(result[0],result[1]);assert.equal(effects,1);one.close();two.close();
});
test('binding changed while authorization is in flight refuses a non-signing effect',async()=>{
 const f=await fixture();let effects=0;
 const input={...request(async()=>{effects++;return{};}),authorize:async()=>{await f.state.update(JOB,row=>({...row,binding:{TEST:'new binding'}}));return{status:'authorized'};}};
 await assert.rejects(f.store.runOnceAuthorized(input),e=>e.errors?.[0]?.code==='binding-changed');assert.equal(effects,0);f.raw.close();
});

test('a delayed operation cannot save a checkpoint into a replacement lifecycle',async()=>{
 const f=await fixture(),entered=deferred(),resume=deferred();
 const pending=f.store.runOnce(request(async()=>{entered.resolve();await resume.promise;return {TEST:'old result'};}));
 const held=pending.catch(error=>error);await entered.promise;
 await f.state.update(JOB,row=>({...row,lifecycle:{...row.lifecycle,incarnation:'TEST replacement incarnation'}}));
 resume.resolve();assert.equal((await held).code,'binding-changed');
 assert.equal(Object.values((await f.state.read(JOB)).ops.seller.steps)[0].state,'pending');f.raw.close();
});
