import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,JOBS} from './helpers/bilateral-vet-fixture.mjs';
import {provenUnsignedAbsence} from '../src/dacs/native-dem-delivery-consumer.mjs';
import {compositeVerificationAddress} from '@kynesyslabs/dacs';
import {createSellerContextRoute} from '../src/dacs/seller-context-route.mjs';
for(const status of ['proven','absent','indeterminate','present'])test(`resume with ${status} evidence before proof checkpoints is read-only`,async()=>{
 const w=fixture(),input=w.input();let signs=0;w.config.wallet.signBytes=()=>{signs++;throw new Error('TEST signer interrupted');};
 await assert.rejects(w.provider().resolveBuyer(input)); // The signer failure is wrapped by the buyer Vet core.
 const calls=[];w.anchor.hasIntent=async address=>{calls.push(address);return true;};w.anchor.readRetained=async()=>status==='proven'?provenUnsignedAbsence('TEST interrupted unsigned approval'):{status};
 w.config.store.update=()=>assert.fail('resume wrote state');const result=await w.provider().resumableBuyer(input);
 assert.deepEqual(result,status==='proven'?{writes:2}:null);assert.equal(signs,1);assert.equal(w.local.writes.length,0);assert.equal(w.seen.length,0);
 assert.deepEqual(calls,status==='proven'?[w.buyer.claim,w.seller.claim].map(party=>compositeVerificationAddress(JOBS[0],party)):[compositeVerificationAddress(JOBS[0],w.buyer.claim)]);w.base.close();
});
test('one finalized buyer proof and one interrupted unsigned seller intent need exactly one remaining write',async()=>{
 const w=fixture(),input=w.input(),sellerAddress=compositeVerificationAddress(JOBS[0],w.seller.claim),publish=w.anchor.publish,read=w.anchor.readRetained;
 w.anchor.publish=async asked=>asked.logicalAddress===sellerAddress?{status:'indeterminate'}:publish(asked);
 await assert.rejects(w.provider().resolveBuyer(input),{code:'indeterminate'});
 w.anchor.hasIntent=async()=>true;w.anchor.readRetained=async asked=>asked.logicalAddress===sellerAddress?provenUnsignedAbsence('TEST unsigned seller intent'):read(asked);
 const effects=[w.controls.signs,w.local.writes.length,w.seen.length];w.config.store.update=()=>assert.fail('resume wrote state');
 assert.deepEqual(await w.provider().resumableBuyer(input),{writes:1});assert.deepEqual([w.controls.signs,w.local.writes.length,w.seen.length],effects);w.base.close();
});

// The buyer Vet is finalized and the seller's presentation save met a busy store, so nothing of the
// seller exists yet and no intent was stored.
function busyWhenPresentationSaved(w){
 const store=w.config.store;let armed=true;
 w.config.store={...store,update:(key,change)=>store.update(key,(old,rows)=>{
  const next=change(old,rows);if(armed&&next?.presentation&&!old?.presentation){armed=false;throw Object.assign(new Error('TEST journal busy'),{code:'journal-busy'});}return next;
 })};
}
// Models a process that dies as soon as a row write reaches `reached`: every later row write fails.
function dieAfter(w,reached){
 const store=w.config.store;let dead=false;
 w.config.store={...store,update:(key,change)=>{
  if(dead)throw new Error('TEST process died');
  return store.update(key,(old,rows)=>{const next=change(old,rows);if(next&&reached(next))dead=true;return next;});
 }};
 return()=>{w.config.store=store;};
}
const effectsOf=w=>[w.controls.signs,w.local.writes.length,w.seen.length];
test('buyer Vet finalized and the seller write ended before any intent needs exactly one write',async()=>{
 const w=fixture(),input=w.input();busyWhenPresentationSaved(w);
 await assert.rejects(w.provider().resolveBuyer(input),{code:'journal-busy'});
 assert.equal(w.local.writes.length,1);
 const effects=effectsOf(w),update=w.config.store.update;w.config.store.update=()=>assert.fail('resume wrote state');
 assert.deepEqual(await w.provider().resumableBuyer(input),{writes:1});assert.deepEqual(effectsOf(w),effects);
 w.config.store.update=update;
 assert.equal((await w.provider().resolveBuyer(input)).disposition,'present');assert.equal(w.local.writes.length,2);w.base.close();
});
test('a retained seller presentation without an intent is not a clean cut',async()=>{
 const w=fixture(),input=w.input(),sellerAddress=compositeVerificationAddress(JOBS[0],w.seller.claim),publish=w.anchor.publish;
 w.anchor.publish=async asked=>asked.logicalAddress===sellerAddress?{status:'rejected',reason:'TEST ended before any intent'}:publish(asked);
 await assert.rejects(w.provider().resolveBuyer(input),{code:'seller_vet_receipt_invalid'});
 assert.equal(w.local.writes.length,1);assert.ok((await w.base.entries()).some(([,row])=>row.presentation));
 assert.equal(await w.provider().resumableBuyer(input),null);w.base.close();
});
test('a retained buyer checkpoint without an intent is not a clean cut, even beside a cut seller intent',async()=>{
 const w=fixture(),input=w.input(),buyerAddress=compositeVerificationAddress(JOBS[0],w.buyer.claim),sellerAddress=compositeVerificationAddress(JOBS[0],w.seller.claim),publish=w.anchor.publish;
 w.anchor.publish=async asked=>asked.logicalAddress===buyerAddress?{status:'indeterminate'}:publish(asked);
 await assert.rejects(w.provider().resolveBuyer(input));
 w.anchor.hasIntent=async address=>address===sellerAddress;w.anchor.readRetained=async()=>provenUnsignedAbsence('TEST unsigned seller intent');
 assert.equal(await w.provider().resumableBuyer(input),null);assert.equal(w.local.writes.length,0);w.base.close();
});
test('an admitted job row cut before any write needs both writes',async()=>{
 const w=fixture(),input=w.input(),restore=dieAfter(w,row=>row.lifecycle);
 await assert.rejects(w.provider().resolveBuyer(input));restore();
 const effects=effectsOf(w);w.config.store.update=()=>assert.fail('resume wrote state');
 assert.deepEqual(await w.provider().resumableBuyer(input),{writes:2});assert.deepEqual(effectsOf(w),effects);w.base.close();
});
test('a job row cut between binding and admission needs both writes',async()=>{
 const w=fixture(),input=w.input(),restore=dieAfter(w,row=>row.binding&&!row.lifecycle);
 await assert.rejects(w.provider().resolveBuyer(input));restore();
 assert.equal((await w.base.entries())[0][1].lifecycle,undefined);
 const effects=effectsOf(w),update=w.config.store.update;w.config.store.update=()=>assert.fail('resume wrote state');
 assert.deepEqual(await w.provider().resumableBuyer(input),{writes:2});assert.deepEqual(effectsOf(w),effects);
 w.config.store.update=update;assert.equal((await w.provider().resolveBuyer(input)).disposition,'present');w.base.close();
});
test('the route resumes a job row cut between binding and admission',async()=>{
 const w=fixture(),input=w.input(),restore=dieAfter(w,row=>row.binding&&!row.lifecycle);
 await assert.rejects(w.provider().resolveBuyer(input));restore();
 const provider=w.provider(),route=createSellerContextRoute({listing:w.listing,resolveBuyer:provider.resolveBuyer,assertBuyerAccess:()=>{},writable:()=>true,
  admitWrites:async()=>null,releaseWrites:async()=>{},recover:provider.recoverBuyer,resumable:provider.resumableBuyer});
 assert.deepEqual(await route.reconcile({body:input}),{disposition:'resume',writes:2});w.base.close();
});
test('a missing job row is not resumable',async()=>{
 const w=fixture();assert.equal(await w.provider().resumableBuyer(w.input()),null);w.base.close();
});
test('an ended job row is not resumable',async()=>{
 const w=fixture(),input=w.input(),restore=dieAfter(w,row=>row.lifecycle);
 await assert.rejects(w.provider().resolveBuyer(input));restore();
 await w.config.store.update((await w.base.entries())[0][0],row=>({...row,lifecycle:{...row.lifecycle,state:'ended'}}));
 assert.equal(await w.provider().resumableBuyer(input),null);w.base.close();
});
