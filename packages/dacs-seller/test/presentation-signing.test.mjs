import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { identityBundleHash } from '@kynesyslabs/dacs';
import { openPartyVetStore } from '../src/devnet-demo/party-vet-store.mjs';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { JOB, NOW, seller } from './helpers/protocol-fixture.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const reply=value=>Buffer.from(JSON.stringify(value));
const message=bundle=>Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(bundle)}`);
const indeterminate=error=>error.code==='seller_presentation_indeterminate';
async function sessionFixture(t,store){
 const f=productionFixture();t.after(()=>f.base.close());if(store)f.config.store=store;
 const provider=await f.provider(),job={jobId:JOB,binding:{buyerIdentityBundle:f.input().buyerIdentityBundle},open:()=>true,writeStarted:false};
 await provider.state.update(JOB,()=>({binding:job.binding,writeStarted:false}));
 return{...f,provider,job,run:async()=>(await f.provider()).sellerSession(job),row:()=>provider.state.read(JOB)};
}
function interruptSave(f,predicate,{after=false}={}){
 const store=f.config.store;let armed=true;
 f.config.store={...store,update:async(key,change)=>{
  let interrupt=false;
  const result=await store.update(key,(old,rows)=>{const next=change(old,rows);interrupt=armed&&predicate(next,old);if(interrupt){armed=false;if(!after)throw new Error('TEST interrupted save');}return next;});
  if(interrupt)throw new Error('TEST interrupted save');return result;
 }};
}
function retainSignerOutcome(f,{reject=false}={}){
 let outcome;
 f.config.wallet.signBytes=(bytes,request)=>{f.controls.signs++;const signature=seller.signBytes(bytes).toString('base64url');outcome={...request,status:'signed',signature};if(reject)throw new Error('TEST signer reply lost');return signature;};
 f.config.wallet.reconcilePresentationSignature=async request=>{
  assert.deepEqual(request,{jobId:outcome.jobId,signer:outcome.signer,reservation:outcome.reservation,signedBytes:outcome.signedBytes});return reply(outcome);
 };
 return()=>outcome;
}

// Outside-review regression: on the reviewed head retry made three signer calls
// instead of the two calls of a clean bilateral Vet.
test('lost presentation save never signs again on an end-to-end retry',async t=>{
 const f=productionFixture();t.after(()=>f.base.close());
 interruptSave(f,(next,old)=>!old?.presentation?.bundle?.presentation&&next?.presentation?.bundle?.presentation);
 await assert.rejects(f.run(),/interrupted save/);assert.equal(f.controls.signs,1);
 const [retry]=await Promise.allSettled([f.run()]);
 assert.equal(f.controls.signs,1,'retry must not sign either presentation or composite after an unknown presentation signature');
 assert.equal(retry.status,'rejected');assert.ok(indeterminate(retry.reason));assert.equal(f.issued.size,1);
});
test('exact bytes and pending reservation are durable before the signer runs',async t=>{
 const f=await sessionFixture(t);let request;
 f.config.wallet.signBytes=async(bytes,identity)=>{
  f.controls.signs++;request=identity;const row=await f.row();
  assert.equal(row.writeStarted,true);assert.equal(row.presentation.signing.state,'pending');
  assert.deepEqual(identity,{jobId:JOB,signer:seller.claim,reservation:row.presentation.signing.reservation,signedBytes:bytes.toString('hex')});
  assert.equal(row.presentation.signing.signedBytes,message(row.presentation.bundle).toString('hex'));
  return seller.signBytes(bytes);
 };
 const bundle=await f.run();assert.ok(request.reservation);assert.equal(f.controls.signs,1);
 assert.equal((await f.row()).presentation.signing.state,'complete');assert.deepEqual(await f.run(),bundle);
});
for(const reject of [false,true])test(`wallet receipt recovers a ${reject?'lost signer reply':'lost signature save'} without signing again`,async t=>{
 const f=await sessionFixture(t),outcome=retainSignerOutcome(f,{reject});
 if(!reject)interruptSave(f,(next,old)=>!old?.presentation?.bundle?.presentation&&next?.presentation?.bundle?.presentation);
 await assert.rejects(f.run(),/lost|interrupted/);const bundle=await f.run();
 assert.equal(bundle.presentation.signatures[0].signature,outcome().signature);assert.equal(f.controls.signs,1);
});
test('a committed signature whose save acknowledgement was lost replays without wallet lookup',async t=>{
 const f=await sessionFixture(t);interruptSave(f,(next,old)=>!old?.presentation?.bundle?.presentation&&next?.presentation?.bundle?.presentation,{after:true});
 await assert.rejects(f.run(),/interrupted save/);await f.run();assert.equal(f.controls.signs,1);
});
test('failed reservation acknowledgement holds without ever calling the signer',async t=>{
 const f=await sessionFixture(t);interruptSave(f,next=>next?.presentation?.signing?.state==='pending',{after:true});
 await assert.rejects(f.run(),/interrupted save/);await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,0);
});
test('a failed reservation write resumes the prepared exact bytes',async t=>{
 const f=await sessionFixture(t);interruptSave(f,next=>next?.presentation?.signing?.state==='pending');
 await assert.rejects(f.run(),/interrupted save/);const before=(await f.row()).presentation;
 f.config.listing.seller.identity.presentedAt++;
 const bundle=await f.run();assert.equal(message(bundle).toString('hex'),before.signing.signedBytes);assert.equal(f.controls.signs,1);assert.equal(f.issued.size,1);
});
test('concurrent providers reserve only one signer call',async t=>{
 const f=await sessionFixture(t),started=deferred(),gate=deferred();
 f.config.wallet.signBytes=async bytes=>{f.controls.signs++;started.resolve();await gate.promise;return seller.signBytes(bytes);};
 const first=f.run();await started.promise;await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);
 gate.resolve();const bundle=await first;assert.deepEqual(await f.run(),bundle);
});
test('providers racing from the unsigned row call the signer once',async t=>{
 const f=await sessionFixture(t);const results=await Promise.allSettled([f.run(),f.run()]);
 assert.ok(results.some(result=>result.status==='fulfilled'));assert.equal(f.controls.signs,1);
 for(const result of results)if(result.status==='rejected')assert.ok(indeterminate(result.reason));
});
test('concurrent receipt lookups keep one identical fenced signature outcome',async t=>{
 const f=await sessionFixture(t);retainSignerOutcome(f,{reject:true});await assert.rejects(f.run(),/reply lost/);
 const results=await Promise.all([f.run(),f.run()]);assert.deepEqual(results[0],results[1]);assert.equal(f.controls.signs,1);
});
test('a slow receipt cannot overwrite a new reservation',async t=>{
 const f=await sessionFixture(t),outcome=retainSignerOutcome(f,{reject:true});await assert.rejects(f.run(),/reply lost/);
 const started=deferred(),gate=deferred();f.config.wallet.reconcilePresentationSignature=async()=>{started.resolve();await gate.promise;return reply(outcome());};
 const recovery=f.run(),rejected=assert.rejects(recovery,error=>error.code==='binding-changed');await started.promise;
 await f.provider.state.update(JOB,row=>{row.presentation.signing.reservation='TEST newer reservation';return row;});
 const changed=await f.row();gate.resolve();await rejected;assert.deepEqual(await f.row(),changed);
});
test('two SQLite handles and a reopen retain the same unknown signer reservation',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'TEST-presentation-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'vet.sqlite');let one=openPartyVetStore({path,mode:'create'}),two=openPartyVetStore({path,mode:'open'});
 const f=await sessionFixture(t,one),started=deferred(),gate=deferred();
 f.config.wallet.signBytes=async()=>{f.controls.signs++;started.resolve();await gate.promise;throw new Error('TEST signer disconnected');};
 const first=f.run(),rejected=assert.rejects(first,/signer disconnected/);await started.promise;
 f.config.store=two;await assert.rejects(f.run(),indeterminate);gate.resolve();await rejected;one.close();two.close();
 one=openPartyVetStore({path,mode:'open'});t.after(()=>one.close());f.config.store=one;
 await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);
});
for(const field of ['binding','reservation','bundle'])test(`a slow signature cannot overwrite a changed ${field}`,async t=>{
 const f=await sessionFixture(t),started=deferred(),gate=deferred();
 f.config.wallet.signBytes=async bytes=>{started.resolve();await gate.promise;return seller.signBytes(bytes);};
 const first=f.run(),rejected=assert.rejects(first,error=>error.code==='binding-changed');await started.promise;
 await f.provider.state.update(JOB,row=>{if(field==='binding')row.binding={TEST:'changed'};else if(field==='reservation')row.presentation.signing.reservation='TEST replacement';else row.presentation.bundle.presentedAt++;return row;});
 const changed=await f.row();gate.resolve();await rejected;assert.deepEqual(await f.row(),changed);
});
for(const status of ['absent','unknown','unattempted'])test(`a ${status} wallet lookup never authorizes another signature`,async t=>{
 const f=await sessionFixture(t);retainSignerOutcome(f,{reject:true});await assert.rejects(f.run(),/reply lost/);
 f.config.wallet.reconcilePresentationSignature=async()=>reply({status});
 await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);
});
for(const field of ['jobId','signer','reservation','signedBytes','signature'])test(`reconciliation rejects a mismatched ${field}`,async t=>{
 const f=await sessionFixture(t),outcome=retainSignerOutcome(f,{reject:true});await assert.rejects(f.run(),/reply lost/);
 f.config.wallet.reconcilePresentationSignature=async()=>reply({...outcome(),[field]:field==='signature'?seller.signBytes(Buffer.from('TEST other bytes')).toString('base64url'):'TEST mismatch'});
 await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);
});
for(const kind of ['object','oversized','malformed'])test(`wallet lookup refuses ${kind} replies before signature use`,async t=>{
 const f=await sessionFixture(t),outcome=retainSignerOutcome(f,{reject:true});await assert.rejects(f.run(),/reply lost/);
 f.config.wallet.reconcilePresentationSignature=async()=>kind==='object'?outcome():Buffer.from(kind==='oversized'?' '.repeat(4097):'{');
 await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);
});
test('wallet lookup keeps its connection error as the cause',async t=>{
 const f=await sessionFixture(t);retainSignerOutcome(f,{reject:true});await assert.rejects(f.run(),/reply lost/);
 const cause=Object.assign(new Error('TEST connection refused'),{code:'ECONNREFUSED'});
 f.config.wallet.reconcilePresentationSignature=async()=>{throw cause;};
 await assert.rejects(f.run(),error=>indeterminate(error)&&error.cause===cause);
});
test('wallet lookup deadline aborts a stalled receipt read',async t=>{
 const f=await sessionFixture(t);retainSignerOutcome(f,{reject:true});await assert.rejects(f.run(),/reply lost/);
 const entered=deferred();let limits;f.config.wallet.reconcilePresentationSignature=async(_request,options)=>{limits=options;entered.resolve();return new Promise(()=>{});};
 t.mock.timers.enable({apis:['setTimeout']});const rejected=assert.rejects(f.run(),error=>indeterminate(error)&&error.cause?.name==='TimeoutError');
 await entered.promise;t.mock.timers.tick(10001);await rejected;assert.equal(limits.signal.aborted,true);assert.equal(limits.maxBytes,4096);
});
for(const field of ['signedBytes','signature'])test(`retained ${field} is checked before replay`,async t=>{
 const f=await sessionFixture(t);await f.run();
 await f.provider.state.update(JOB,row=>{if(field==='signedBytes')row.presentation.signing.signedBytes='00';else row.presentation.bundle.presentation.signatures[0].signature=seller.signBytes(Buffer.from('TEST changed')).toString('base64url');return row;});
 await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);
});
for(const state of ['complete','legacy'])test(`a ${state} saved outcome is cryptographically checked before replay`,async t=>{
 const f=await sessionFixture(t);await f.run();const invalid=seller.signBytes(Buffer.from('TEST other message')).toString('base64url');
 await f.provider.state.update(JOB,row=>{row.presentation.bundle.presentation.signatures[0].signature=invalid;
  if(state==='legacy')delete row.presentation.signing;else row.presentation.signing.signature=invalid;return row;
 });
 await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);
});
test('legacy unsigned rows cannot authorize signing but valid signed rows still replay',async t=>{
 const f=await sessionFixture(t);const bundle=await f.run();
 await f.provider.state.update(JOB,row=>{delete row.presentation.signing;return row;});assert.deepEqual(await f.run(),bundle);
 await f.provider.state.update(JOB,row=>{delete row.presentation.bundle.presentation;return row;});
 await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);
});
test('completed presentations from a changed binding cannot replay',async t=>{
 const f=await sessionFixture(t);await f.run();await f.provider.state.update(JOB,row=>({...row,binding:{TEST:'new binding'}}));
 await assert.rejects(f.run(),error=>error.code==='binding-changed');
});
test('invalid direct signer output leaves a pending outcome instead of a saved success',async t=>{
 const f=await sessionFixture(t);f.config.wallet.signBytes=()=>{f.controls.signs++;return seller.signBytes(Buffer.from('TEST wrong message'));};
 await assert.rejects(f.run(),indeterminate);assert.equal((await f.row()).presentation.signing.state,'pending');
 await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);
});
test('hex signer output is normalized before the fenced result is saved',async t=>{
 const f=await sessionFixture(t);f.config.wallet.signBytes=bytes=>{f.controls.signs++;return seller.signBytes(bytes).toString('hex');};
 const bundle=await f.run();assert.equal(bundle.presentation.signatures[0].signature.length,86);assert.deepEqual(await f.run(),bundle);assert.equal(f.controls.signs,1);
});
test('a receipt with unexpected list fields is refused',async t=>{
 const f=await sessionFixture(t),outcome=retainSignerOutcome(f,{reject:true});await assert.rejects(f.run(),/reply lost/);
 f.config.wallet.reconcilePresentationSignature=async()=>reply({...outcome(),extra:[{}]});
 await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);
});
test('a malformed retained signature entry fails with a clear indeterminate error',async t=>{
 const f=await sessionFixture(t);await f.run();await f.provider.state.update(JOB,row=>{row.presentation.bundle.presentation.signatures=[null];return row;});
 await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);
});
test('cancellation during reservation prevents a new signature',async t=>{
 const f=await sessionFixture(t),store=f.config.store;let open=true;f.job.open=()=>open;
 f.config.store={...store,update:async(key,change)=>{const row=await store.update(key,change);if(row?.presentation?.signing?.state==='pending')open=false;return row;}};
 await assert.rejects(f.run(),error=>error.code==='not-pending');assert.equal(f.controls.signs,0);
});
test('expired unknown signatures keep their reservation without requesting another challenge',async t=>{
 const f=await sessionFixture(t);retainSignerOutcome(f,{reject:true});await assert.rejects(f.run(),/reply lost/);
 f.config.now=()=>NOW+60001;delete f.config.wallet.reconcilePresentationSignature;
 await assert.rejects(f.run(),indeterminate);assert.equal(f.controls.signs,1);assert.equal(f.issued.size,1);
});
