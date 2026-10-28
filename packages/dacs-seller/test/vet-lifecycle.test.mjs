import test from 'node:test';
import assert from 'node:assert/strict';
import { identityBundleHash } from '@kynesyslabs/dacs';
import { fixture, T, JOBS } from './helpers/bilateral-vet-fixture.mjs';
const request=(w,input)=>({jobId:input.scope.jobId,listingPin:w.pin,buyerIdentityBundle:input.buyerIdentityBundle,generatedAt:input.scope.generatedAt});
const next=input=>({...input,scope:{...input.scope,generatedAt:input.scope.generatedAt+1}});
for(const adapter of ['cached','fresh','recovery','fallback'])for(const boundary of ['first-read','second-read','receipt'])for(const transition of ['select','sweep'])test(`${adapter} refuses ${transition} committed during ${boundary}`,async()=>{
 const w=fixture(),p=w.provider(),a=w.input();a.scope.buyerBundleHash=identityBundleHash(a.buyerIdentityBundle);const b=next(a);await p.resolveBuyer(a);await p.resolveBuyer(b);
 if(adapter==='fallback'){const [key]= (await w.store.entries())[0];await w.store.update(key,row=>({...row,seller:null}));w.config.retainedScope=async()=>a.scope;}
 const use=adapter==='cached'?p:w.provider(),method=boundary==='receipt'?'verifyReceipt':'readRetained',original=w.anchor[method];let count=0,entered,resume;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>resume=r);
 w.anchor[method]=async input=>{const out=await original(input);if(++count===(boundary==='second-read'||boundary==='receipt'?2:1)){entered();await gate;}return out;};
 const pending=adapter==='recovery'?use.recoverBuyer(a):use.resolveSeller(request(w,a));await ready;
 const effects=[w.controls.signs,w.local.writes.length,w.seen.length];
 if(transition==='select')await w.provider().release({jobId:JOBS[0],generatedAt:b.scope.generatedAt});else assert.equal((await w.provider().sweep(()=>true)).deleted,1);
 resume();const result=await pending;assert.notEqual(result?.disposition,'present');assert.deepEqual([w.controls.signs,w.local.writes.length,w.seen.length],effects);
 if(transition==='sweep')assert.equal(w.store.usage().jobs,0);w.base.close();
});
for(const time of [undefined,null,-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,'1'])test(`request time ${String(time)} is refused before effects`,async()=>{
 const w=fixture(),input=w.input();input.scope.generatedAt=time;
 await assert.rejects(w.provider().resolveBuyer(input),{code:'context_time_invalid'});assert.equal(w.controls.signs,0);assert.equal(w.store.usage().jobs,0);w.base.close();
});
test('sixteen arbitrary admitted times survive restart; the seventeenth cannot evict any',async()=>{
 const w=fixture(),a=w.input(),times=[15,0,14,1,13,2,12,3,11,4,10,5,9,6,8,7];
 for(const offset of times)assert.equal((await w.provider().resolveBuyer({...a,scope:{...a.scope,generatedAt:T+offset}})).disposition,'present');
 await assert.rejects(w.provider().resolveBuyer({...a,scope:{...a.scope,generatedAt:T+16}}),{code:'context_capacity'});
 for(const offset of times)assert.equal((await w.provider().recoverBuyer({...a,scope:{...a.scope,generatedAt:T+offset}})).disposition,'present');
 assert.equal(w.controls.signs,2);assert.equal(w.local.writes.length,2);w.base.close();
});
test('selection survives restart, cannot conflict or reopen membership, and remains idempotent',async()=>{
 const w=fixture(),a=w.input(),b=next(a),p=w.provider();await p.resolveBuyer(a);await p.resolveBuyer(b);
 await p.release({jobId:JOBS[0],generatedAt:b.scope.generatedAt});await p.release({jobId:JOBS[0],generatedAt:b.scope.generatedAt});
 assert.equal(await w.provider().recoverBuyer(a),null);assert.notEqual((await w.provider().resolveSeller(request(w,a))).disposition,'present');
 await assert.rejects(w.provider().resolveBuyer(a),{code:'context_released'});
 await assert.rejects(p.release({jobId:JOBS[0],generatedAt:a.scope.generatedAt}),{code:'context_released'});
 assert.equal((await w.provider().recoverBuyer(b)).disposition,'present');w.base.close();
});
test('read-only recovery and resume perform no store updates, signatures, writes or evaluations',async()=>{
 const w=fixture(),a=w.input();await w.provider().resolveBuyer(a);const effects=[w.controls.signs,w.local.writes.length,w.seen.length],update=w.config.store.update;
 w.config.store.update=()=>assert.fail('read-only store write');const p=w.provider();assert.equal((await p.recoverBuyer(a)).disposition,'present');await p.resumableBuyer(a);
 assert.deepEqual([w.controls.signs,w.local.writes.length,w.seen.length],effects);w.config.store.update=update;w.base.close();
});

for(const role of ['buyer','seller'])test(`crash before descriptor pinning cannot select a replacement ${role} proof`,async()=>{
 const {signComponentArtifact,ARTIFACT_SEPARATORS,compositeVerificationAddress}=await import('@kynesyslabs/dacs');
 const {fixtureRecord}=await import('./helpers/protocol-fixture.mjs');
 const w=fixture(),a=w.input(),update=w.config.store.update;let fail=true;
 w.config.store.update=(key,change)=>update(key,(row,rows)=>{const next=change(row,rows);if(fail&&!row?.seller&&next?.seller)throw new Error('TEST lost descriptor save');return next;});
 await assert.rejects(w.provider().resolveBuyer(a),/TEST lost descriptor save/);fail=false;
 const effects=[w.controls.signs,w.local.writes.length,w.seen.length],address=compositeVerificationAddress(JOBS[0],w[role].claim),original=w.records.get(address),{signature,...unsigned}=original.artifact,signer=role==='buyer'?w.seller:w.buyer;
 const replacement=await signComponentArtifact({...unsigned,generatedAt:unsigned.generatedAt-1},ARTIFACT_SEPARATORS.CompositeVerificationRecord,{signer:signer.claim,algorithm:'ed25519',sign:signer.signBytes});
 w.records.set(address,fixtureRecord(address,replacement,w.seller));
 for(let i=0;i<2;i++){assert.equal(await w.provider().recoverBuyer(a),null);assert.notEqual((await w.provider().resolveSeller(request(w,a))).disposition,'present');}
 w.records.set(address,original);assert.equal((await w.provider().recoverBuyer(a)).disposition,'present');
 assert.deepEqual([w.controls.signs,w.local.writes.length,w.seen.length],effects);assert.equal((await w.store.entries())[0][1].seller,null);w.base.close();
});
test('a delete/recreate with identical binding and proofs has a different lifecycle incarnation',async()=>{
 const w=fixture(),a=w.input();await w.provider().resolveBuyer(a);const [key,old]=(await w.store.entries())[0],read=w.anchor.readRetained;let entered,resume,once=true;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>resume=r);
 w.anchor.readRetained=async input=>{const out=await read(input);if(once){once=false;entered();await gate;}return out;};
 const pending=w.provider().recoverBuyer(a);await ready;await w.provider().sweep(()=>true);
 await w.store.update(key,()=>({...old,lifecycle:{...old.lifecycle,incarnation:'TEST recreated incarnation'}}));resume();assert.equal(await pending,null);w.base.close();
});
test('failed durable selection is observable and leaves the earlier membership usable',async()=>{
 const w=fixture(),a=w.input(),b=next(a),p=w.provider();await p.resolveBuyer(a);await p.resolveBuyer(b);const update=w.config.store.update;
 w.config.store.update=(key,change)=>update(key,(row,rows)=>{const value=change(row,rows);if(value?.lifecycle?.state==='selected')throw new Error('TEST failed selection');return value;});
 await assert.rejects(p.release({jobId:JOBS[0],generatedAt:b.scope.generatedAt}),/TEST failed selection/);
 w.config.store.update=update;assert.equal((await w.provider().recoverBuyer(a)).disposition,'present');assert.equal((await w.provider().recoverBuyer(b)).disposition,'present');w.base.close();
});
test('same-provider ending during final verification prevents recovery and defers an active step deletion',async()=>{
 const w=fixture(),p=w.provider(),a=w.input();await p.resolveBuyer(a);const verify=w.anchor.verifyReceipt;let once=true,entered,resume;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>resume=r);
 w.anchor.verifyReceipt=async input=>{const out=await verify(input);if(once){once=false;entered();await gate;}return out;};
 const pending=p.recoverBuyer(a);await ready;await p.release({jobId:JOBS[0]});resume();assert.equal(await pending,null);assert.equal(w.store.usage().jobs,0);w.base.close();
});

for(const boundary of ['production','retention'])test(`selection before ${boundary} completes invalidates the old ticket and preserves the selected request`,async()=>{
 const w=fixture(),a=w.input(),b=next(a),p=w.provider();let entered,resume,admitted,once=true;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>resume=r),admittedB=new Promise(r=>admitted=r),update=w.config.store.update;
 w.config.store.update=async(key,change)=>{
  if(boundary==='retention'&&once){let pins=false;const result=await update(key,(row,rows)=>{const value=change(row,rows);pins=Boolean(!row?.seller&&value?.seller);if(pins)return undefined;return value;});if(pins){once=false;entered();await gate;return update(key,change);}if(result?.lifecycle?.times.includes(b.scope.generatedAt))admitted();return result;}
  const result=await update(key,change);if(result?.lifecycle?.times.includes(b.scope.generatedAt))admitted();return result;
 };
 if(boundary==='production'){const read=w.anchor.readRetained;w.anchor.readRetained=async input=>{const result=await read(input);if(once){once=false;entered();await gate;}return result;};}
 const first=p.resolveBuyer(a);const firstHeld=first.catch(error=>error);await ready;
 const second=w.provider().resolveBuyer(b),secondHeld=second.catch(error=>error);await admittedB;
 if(boundary==='retention')assert.equal((await secondHeld).disposition,'present');
 await w.provider().release({jobId:JOBS[0],generatedAt:b.scope.generatedAt});resume();
 assert.equal((await firstHeld).code,'context_released');await secondHeld;
 assert.equal(await w.provider().recoverBuyer(a),null);assert.equal((await w.provider().resolveBuyer(b)).disposition,'present');assert.equal(w.local.writes.length,2);assert.equal(w.controls.signs,2);w.base.close();
});
test('ending an active producer reports durable invalidation before deferred deletion and starts no later effects',async()=>{
 const w=fixture(),p=w.provider(),a=w.input(),sign=w.config.wallet.signBytes;let entered,resume,once=true;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>resume=r);
 w.config.wallet.signBytes=async bytes=>{if(once){once=false;entered();await gate;}return sign(bytes);};
 const pending=p.resolveBuyer(a),held=pending.catch(error=>error);await ready;
 assert.deepEqual(await p.release({jobId:JOBS[0]}),{invalidated:true,deleted:false});resume();assert.ok((await held) instanceof Error);
 await p.sweep(()=>true);assert.equal(w.local.writes.length,0);assert.equal(w.controls.signs,1);assert.equal(w.store.usage().jobs,0,'the ended marker fences replay outside active quota');w.base.close();
});

for(const restart of [false,true])test(`no-intent endings retain replay fences outside active-job quota, reopen=${restart}`,async()=>{
 const w=fixture({maxJobs:1});
 for(let index=0;index<8;index++){
  const jobId=JOBS[0].slice(0,-1)+String(index);
  const provider=w.provider();
  assert.deepEqual(await provider.release({jobId}),{invalidated:true,deleted:false});
  assert.equal(w.store.usage().remainingJobs,1);
  const fresh=restart?w.provider():provider;
  await assert.rejects(fresh.resolveBuyer(w.input(jobId)),{code:'context_released'});
 }
 assert.equal((await w.provider().resolveBuyer(w.input(JOBS[1]))).disposition,'present');
 assert.equal(w.store.usage().remainingJobs,0);w.base.close();
});
