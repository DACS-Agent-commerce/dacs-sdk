import test from 'node:test';
import assert from 'node:assert/strict';
import { createImmutableReadbacks } from '../src/util/immutable-readbacks.mjs';
import { createListingVerifier } from '../src/dacs/verification.mjs';
import { fixtureListing, fixtureLocator, summaryFor } from './fixtures/listings.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';

test('immutable proofs are isolated by purchase, locator, content hash and complete signed scope; callers cannot mutate retained proofs',()=>{
  const cache=createImmutableReadbacks({limit:2}),key={purchaseId:'one',locator:'address',contentHash:'hash',scope:{writer:'seller',receipt:{block:1}}};
  const original={status:'verified',receipt:{block:1}};cache.put(key,original);original.receipt.block=2;
  const returned=cache.get(key);returned.receipt.block=3;assert.equal(cache.get(key).receipt.block,1);
  for(const change of [{purchaseId:'two'},{locator:'another'},{contentHash:'other'},{scope:{writer:'other',receipt:{block:1}}},{scope:{writer:'seller',receipt:{block:2}}}])assert.equal(cache.get({...key,...change}),null);
  cache.put({...key,purchaseId:'two'},original);cache.put({...key,purchaseId:'three'},original);assert.equal(cache.get(key),null);
});

test('cached Listing bytes skip native reads within one purchase while source admission, validity and catalog revocation are checked again',async()=>{
  const wallet=createEphemeralWallet();let clock=1770000000000,reads=0,observations=0,unavailable=false;
  const listing=fixtureListing(wallet,{now:clock,notAfter:clock+10000}),locator=fixtureLocator('immutable-listing');
  let summary=summaryFor(listing,locator,{observedAt:new Date(clock).toISOString()});
  const directory={origin:'http://fixture',findSummary:async()=>summary,getListingDetail:async()=>listing};
  const chain={readStorageProgram:async()=>{reads++;return{status:'found',data:listing,owner:wallet.address};}};
  const verifier=createListingVerifier({directory,chain,now:()=>clock,cacheImmutable:true,observeBinding:async()=>{observations++;if(unavailable)throw new Error('source unavailable');}});
  const input={listingId:listing.listingId,version:1,seller:wallet.claim,purchaseId:'purchase-one'};
  assert.equal((await verifier.verify(input)).transactable,true);assert.equal(reads,1);assert.equal(observations,0);
  assert.equal((await verifier.verify(input)).transactable,true);assert.equal(reads,1);assert.equal(observations,1);
  assert.equal((await verifier.verify({...input,purchaseId:'purchase-two'})).transactable,true);assert.equal(reads,2);
  unavailable=true;const held=await verifier.verify(input);assert.equal(held.transactable,false);assert.ok(held.checks.some(check=>check.name==='chain-anchor-present'&&!check.ok&&check.detail==='storage program unavailable'));assert.equal(reads,2);unavailable=false;
  summary={...summary,status:'revoked'};assert.equal((await verifier.verify(input)).transactable,false);assert.equal(reads,2);
  summary={...summary,status:'active'};clock+=10001;assert.equal((await verifier.verify(input)).transactable,false);assert.equal(reads,2);
});

test('immutable proofs expire after the short TTL and can be evicted',()=>{
  let clock=1770000000000;const cache=createImmutableReadbacks({ttlMs:60000,now:()=>clock}),key={purchaseId:'one',locator:'address',contentHash:'hash',scope:{}};
  assert.throws(()=>createImmutableReadbacks({ttlMs:0}),TypeError);
  cache.put(key,{block:1});clock+=59999;assert.deepEqual(cache.get(key),{block:1});
  clock+=1;assert.equal(cache.get(key),null,'expired at the TTL');
  cache.put(key,{block:2});cache.delete(key);assert.equal(cache.get(key),null,'evicted');
});

test('a fresh Listing verification always reads the chain; a changed chain Listing is seen and evicted, a changed detail misses, and the TTL forces a re-read',async()=>{
  const wallet=createEphemeralWallet();let clock=1770000000000,reads=0;
  const listing=fixtureListing(wallet,{now:clock,notAfter:clock+3600000}),locator=fixtureLocator('fresh-listing');
  let detail=listing,summary=summaryFor(listing,locator,{observedAt:new Date(clock).toISOString()}),onChain=listing;
  const directory={origin:'http://fixture',findSummary:async()=>summary,getListingDetail:async()=>detail};
  const chain={readStorageProgram:async()=>{reads++;return{status:'found',data:onChain,owner:wallet.address};}};
  const verifier=createListingVerifier({directory,chain,now:()=>clock,cacheImmutable:true});
  const input={listingId:listing.listingId,version:1,seller:wallet.claim,purchaseId:'purchase-one'};
  assert.equal((await verifier.verify(input)).transactable,true);assert.equal(reads,1);
  assert.equal((await verifier.verify(input)).transactable,true);assert.equal(reads,1,'pre-handoff reuse within the TTL');
  assert.equal((await verifier.verify({...input,fresh:true})).transactable,true);assert.equal(reads,2,'the handoff check reads the chain');
  // The chain bytes change under an unchanged directory: the fresh read sees it and evicts the proof.
  onChain={...listing,offering:{...listing.offering,title:'Changed on chain'}};
  const changed=await verifier.verify({...input,fresh:true});assert.equal(changed.transactable,false);assert.equal(reads,3);
  assert.ok(changed.checks.some(check=>check.name==='chain-readback-equals-directory-detail'&&!check.ok));
  assert.equal((await verifier.verify(input)).transactable,false);assert.equal(reads,4,'the evicted proof is not served again');
  onChain=listing;assert.equal((await verifier.verify(input)).transactable,true);assert.equal(reads,5);
  // A changed directory detail has a different content hash, so it never hits the old proof.
  const next=fixtureListing(wallet,{now:clock,notAfter:clock+3600000,title:'Next report'});
  detail=next;summary=summaryFor(next,locator,{observedAt:new Date(clock).toISOString()});onChain=next;
  assert.equal((await verifier.verify(input)).transactable,true);assert.equal(reads,6,'new bytes are a cache miss');
  assert.equal((await verifier.verify(input)).transactable,true);assert.equal(reads,6);
  clock+=60000;summary={...summary,catalogObservedAt:new Date(clock).toISOString()};
  assert.equal((await verifier.verify(input)).transactable,true);assert.equal(reads,7,'re-read after the TTL');
});
