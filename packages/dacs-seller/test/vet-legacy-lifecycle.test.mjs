import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,JOBS} from './helpers/bilateral-vet-fixture.mjs';
for(const selected of [false,true])test(`a legacy ${selected?'selected':'open'} descriptor cannot invent new lifecycle membership`,async()=>{
 const w=fixture(),a=w.input(),b={...a,scope:{...a.scope,generatedAt:a.scope.generatedAt+1}},p=w.provider();await p.resolveBuyer(a);await p.resolveBuyer(b);
 // Model the durable format written by the previous release implementation.
 const [key]= (await w.store.entries())[0];await w.store.update(key,row=>{delete row.lifecycle;row.seller={...row.seller,generatedAts:selected?[b.scope.generatedAt]:[a.scope.generatedAt,b.scope.generatedAt],...(selected?{selected:b.scope.generatedAt}:{})};return row;});
 const effects=[w.controls.signs,w.local.writes.length,w.seen.length],before=await w.store.entries(),fresh=w.provider();
 assert.equal(await fresh.recoverBuyer(a),null);assert.notEqual((await fresh.resolveSeller({jobId:JOBS[0],listingPin:w.pin,buyerIdentityBundle:a.buyerIdentityBundle,generatedAt:a.scope.generatedAt})).disposition,'present');
 for(const input of [a,b])await assert.rejects(fresh.resolveBuyer(input),{code:'context_lifecycle_uncertain'});
 assert.deepEqual(await w.store.entries(),before);assert.deepEqual([w.controls.signs,w.local.writes.length,w.seen.length],effects);w.base.close();
});
