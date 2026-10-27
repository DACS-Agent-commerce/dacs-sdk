import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseReadbackCache, sameIncludedFact } from '../src/util/purchase-readback-cache.mjs';
import { loadConfig } from '../src/config.mjs';
import { contractView, runtimeNames } from './helpers/env-contract-view.mjs';
const receipt=()=>({receiptVersion:'1',substrate:'demos',finalityProfile:'TEST',logicalAddress:'dacs:agreement:test',nativeAddress:'TEST-address',contentHash:'a'.repeat(64),transactionRef:{kind:'demos',value:'b'.repeat(64)},writer:'TEST-writer',state:'included',observationDisposition:'established',observedAt:100,blockRef:{id:'c'.repeat(64),height:'1',timestamp:100},evidence:{kind:'TEST',value:'TEST-proof'}});
const input=()=>({purchaseId:'purchase-a',receipt:receipt(),scope:{signedProjection:{hash:'b'.repeat(64)},writer:'TEST-writer',binding:'TEST-binding'}});
const result=()=>({disposition:'present',native:{receipt:receipt(),txRef:{writeTxHash:'b'.repeat(64)}},artifact:{TEST:'verified'}});
function harness(options={}){
  const operations=new Map(['purchase-a','purchase-b'].map(id=>[id,{kind:'purchase',status:'awaiting_approval',state:{protocol:{stage:'seller-committed'}}}]));
  return{operations,cache:createPurchaseReadbackCache({loadPurchase:id=>operations.get(id),...options})};
}
test('config enables purchase reuse only with 1, default off',()=>{
  const env={DACS_PUBLIC_ORIGIN:'https://plugin.example',DACS_OAUTH_COOKIE_KEYS:'x'.repeat(32)};
  for(const value of [undefined,'0','on','true',''])assert.equal(loadConfig({...env,DACS_READBACK_CACHE:value}).readbackCache,false);
  assert.equal(loadConfig({...env,DACS_READBACK_CACHE:'1'}).readbackCache,true);
  const contract=contractView();
  assert.deepEqual(contract.variables.DACS_READBACK_CACHE,{kind:'flag',default:'0',deployValue:'0',operator:true});
  assert.deepEqual(Object.keys(contract.variables).sort(),runtimeNames());
});
test('positive inclusion reuses only the same purchase and exact scope; values are isolated copies',async()=>{
  const {cache}=harness();let reads=0;const read=async()=>{reads++;return result();};
  const first=await cache.read(input(),read);first.native.receipt.blockRef.id='d'.repeat(64);
  const second=await cache.read(input(),read);second.artifact.TEST='changed';
  assert.deepEqual(await cache.read(input(),read),result());assert.equal(reads,1);
  await cache.read({...input(),purchaseId:'purchase-b'},read);assert.equal(reads,2);
  const changed=input();changed.scope.writer='another';await cache.read(changed,read);assert.equal(reads,3);
  changed.scope.binding='another';await cache.read(changed,read);assert.equal(reads,4);
});
for(const [name,change] of Object.entries({hash:r=>r.transactionRef.value='d'.repeat(64),block:r=>r.blockRef.id='d'.repeat(64),height:r=>r.blockRef.height='2',timestamp:r=>r.blockRef.timestamp=101,content:r=>r.contentHash='d'.repeat(64),native:r=>r.nativeAddress='different',logical:r=>r.logicalAddress='different',writer:r=>r.writer='different'}))test(`a changed ${name} misses and a returned mismatch never enters the cache`,async()=>{
  const {cache}=harness();let reads=0;const read=async()=>{reads++;return result();};
  await cache.read(input(),read);const changed=input();change(changed.receipt);
  assert.equal(sameIncludedFact(changed.receipt,receipt()),false);
  await cache.read(changed,read);await cache.read(changed,read);assert.equal(reads,3);
});
for(const disposition of ['absent','pending','indeterminate','rejected'])test(`${disposition} is never cached`,async()=>{
  const {cache}=harness();let reads=0;const read=async()=>{reads++;return{...result(),disposition};};
  await cache.read(input(),read);await cache.read(input(),read);assert.equal(reads,2);
  await cache.read(input(),async()=>{reads++;return result();});await cache.read(input(),read);assert.equal(reads,3);
});
test('errors, malformed receipts, unestablished inclusions and inconsistent transaction refs are never cached',async()=>{
  const {cache}=harness();let reads=0;const error=async()=>{reads++;throw Error('TEST unavailable');};
  for(let i=0;i<2;i++)await assert.rejects(cache.read(input(),error),/unavailable/);assert.equal(reads,2);
  for(const alter of [r=>r.state='submitted',r=>{r.observationDisposition='indeterminate';r.preservedReceiptHash='e'.repeat(64);},r=>delete r.blockRef,r=>r.extra=true]){
    const changed=input();alter(changed.receipt);const read=async()=>{reads++;return result();};const before=reads;
    await cache.read(changed,read);await cache.read(changed,read);assert.equal(reads-before,2);
  }
  const bad=result();bad.native.txRef.writeTxHash='d'.repeat(64);const read=async()=>{reads++;return bad;};const before=reads;
  await cache.read(input(),read);await cache.read(input(),read);assert.equal(reads-before,2);
});
for(const status of ['cancelled','expired','failed','completed','agreement_rejected','payment_failed','payment_mismatch','terms_changed','superseded','missing','wrong-kind','delivery-ready','delivered'])test(`purchase end (${status}) evicts and cannot repopulate`,async()=>{
  const {cache,operations}=harness();let reads=0;const read=async()=>{reads++;return result();};await cache.read(input(),read);
  const op=operations.get('purchase-a');
  if(['delivery-ready','delivered'].includes(status))op.state.protocol.stage=status;
  else if(status==='missing')operations.delete('purchase-a');else if(status==='wrong-kind')op.kind='identity';else op.status=status;
  await cache.read(input(),read);await cache.read(input(),read);assert.equal(reads,3);
  operations.set('purchase-a',{kind:'purchase',status:'awaiting_approval'});await cache.read(input(),read);assert.equal(reads,4,'ended entry was physically dropped');
});
test('stage event, in-flight end, shutdown and new process all discard proofs',async()=>{
  const {cache}=harness();let reads=0;const read=async()=>{reads++;return result();};
  await cache.read(input(),read);cache.stageChange({purchaseId:'purchase-a',stage:'delivery-ready'});await cache.read(input(),read);assert.equal(reads,2);
  const inFlight=input();inFlight.scope.binding='in-flight';let finish;
  const waiting=cache.read(inFlight,()=>{reads++;return new Promise(resolve=>finish=resolve);});
  cache.stageChange({purchaseId:'purchase-a',status:'cancelled'});finish(result());await waiting;
  await cache.read(inFlight,read);assert.equal(reads,4);
  cache.close();await cache.read(inFlight,read);await cache.read(inFlight,read);assert.equal(reads,6);
  await harness().cache.read(input(),read);assert.equal(reads,7,'a new instance starts empty');
});
test('cache bounds evict safely and shutdown during a read cannot repopulate',async()=>{
  const {cache}=harness({limit:1});let reads=0;const read=async()=>{reads++;return result();};
  await cache.read(input(),read);await cache.read({...input(),purchaseId:'purchase-b'},read);await cache.read(input(),read);assert.equal(reads,3);
  for(let i=0;i<17;i++)await cache.read({...input(),scope:{i}},read);
  await cache.read({...input(),scope:{i:0}},read);assert.equal(reads,21);
  let finish;const pending=cache.read({...input(),scope:{closing:true}},()=>new Promise(resolve=>finish=resolve));
  cache.close();finish(result());await pending;await cache.read(input(),read);assert.equal(reads,22);
});


test('invalid inclusion coordinates on either side never compare equal',()=>{
  for(const alter of [r=>r.state='submitted',r=>{r.observationDisposition='indeterminate';r.preservedReceiptHash='e'.repeat(64);},r=>delete r.blockRef,r=>r.extra=true,r=>r.transactionRef.value='not-a-hash',r=>r.blockRef.id='not-a-hash']){
    const bad=receipt();alter(bad);assert.equal(sameIncludedFact(bad,receipt()),false);assert.equal(sameIncludedFact(receipt(),bad),false);assert.equal(sameIncludedFact(bad,bad),false);
  }
});
test('in-flight caller mutation cannot change the captured receipt coordinates',async()=>{
  const {cache}=harness();const request=input();let finish,reads=0;
  const pending=cache.read(request,()=>new Promise(resolve=>finish=resolve));
  request.receipt.blockRef.id='d'.repeat(64);const changed=result();changed.native.receipt.blockRef.id='d'.repeat(64);finish(changed);await pending;
  await cache.read(input(),async()=>{reads++;return result();});assert.equal(reads,1,'a changed answer cannot populate the original coordinate key');
});

test('cached values still run the current source check and never absorb its error',async()=>{
  const {cache}=harness();let reads=0,checks=0;
  const read=async()=>{reads++;return result();};await cache.read(input(),read);
  await assert.rejects(cache.read(input(),read,async()=>{checks++;throw Error('TEST binding changed');}),/binding changed/);
  assert.deepEqual(await cache.read(input(),read,async()=>{checks++;}),result());assert.equal(reads,1);assert.equal(checks,2);
});
test('every supplied receipt byte remains part of the cache key',async()=>{
  const {cache}=harness();let reads=0;const read=async()=>{reads++;return result();};
  await cache.read(input(),read);const changed=input();changed.receipt.evidence.value='TEST-different-proof';
  await cache.read(changed,read);assert.equal(reads,2);
});

test('byte-distinct scopes with one canonical form never share an entry',async()=>{
  const {cache}=harness();let reads=0;const read=async()=>{reads++;return result();};
  await cache.read(input(),read);const reordered=input();reordered.scope=Object.fromEntries(Object.entries(reordered.scope).reverse());
  await cache.read(reordered,read);assert.equal(reads,2);await cache.read(input(),read);assert.equal(reads,2);
});
test('a non-present current check evicts the hit and is returned; a passing check sees an isolated copy',async()=>{
  const {cache}=harness();let reads=0;const read=async()=>{reads++;return result();};await cache.read(input(),read);
  assert.deepEqual(await cache.read(input(),read,async(hit)=>{hit.artifact.TEST='mutated';}),result());
  const held={disposition:'rejected',reason:'TEST current state differs'};
  assert.deepEqual(await cache.read(input(),read,async()=>held),held);assert.equal(reads,1);
  await cache.read(input(),read);assert.equal(reads,2,'the failed hit was evicted');
});
for(const [name,during] of Object.entries({
  'stage notification':({cache})=>cache.stageChange({purchaseId:'purchase-a',status:'cancelled'}),
  'durable end only':({operations})=>{operations.get('purchase-a').status='cancelled';},
  'shutdown':({cache})=>cache.close(),
}))test(`${name} during a hit's current check returns a fresh read, not the selected proof`,async()=>{
  const h=harness();let reads=0;await h.cache.read(input(),async()=>{reads++;return result();});
  let release;const checking=h.cache.read(input(),async()=>{reads++;return{disposition:'absent'};},()=>new Promise(resolve=>release=resolve));
  await new Promise(setImmediate);during(h);release();
  assert.deepEqual(await checking,{disposition:'absent'});assert.equal(reads,2);
});
test('a purchase ending durably during a miss cannot insert, even with no notification or bucket',async()=>{
  const {cache,operations}=harness();let reads=0,finish;
  const pending=cache.read(input(),()=>{reads++;return new Promise(resolve=>finish=resolve);});
  operations.get('purchase-a').status='cancelled';finish(result());await pending;
  operations.get('purchase-a').status='awaiting_approval';
  await cache.read(input(),async()=>{reads++;return result();});assert.equal(reads,2);
});
test('an end notification during a first read cannot insert after a stale durable state',async()=>{
  const {cache}=harness();let reads=0,finish;
  const pending=cache.read(input(),()=>{reads++;return new Promise(resolve=>finish=resolve);});
  cache.stageChange({purchaseId:'purchase-a',stage:'delivery-ready'});finish(result());await pending;
  await cache.read(input(),async()=>{reads++;return result();});assert.equal(reads,2);
});
test('uncacheable reads take no purchase slot',async()=>{
  const {cache}=harness({limit:1});let reads=0;const read=async()=>{reads++;return result();};
  await cache.read({...input(),purchaseId:'purchase-b'},read);
  await cache.read(input(),async()=>{reads++;return{disposition:'absent'};});
  await cache.read({...input(),purchaseId:'purchase-b'},read);assert.equal(reads,2);
});
for(const stage of ['completed','claim-rejected','evidence-rejected','delivery-rejected','bundle-rejected'])test(`ended stage ${stage} ends reuse by lookup and by notification`,async()=>{
  const {cache,operations}=harness();let reads=0;const read=async()=>{reads++;return result();};
  await cache.read(input(),read);operations.get('purchase-a').state.protocol.stage=stage;await cache.read(input(),read);assert.equal(reads,2);
  operations.get('purchase-a').state.protocol.stage='seller-committed';await cache.read(input(),read);assert.equal(reads,3);
  cache.stageChange({purchaseId:'purchase-a',stage});await cache.read(input(),read);assert.equal(reads,4);
});
