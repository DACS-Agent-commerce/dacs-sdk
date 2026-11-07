import test from 'node:test';
import assert from 'node:assert/strict';
import { agreementContextScope } from '../../dacs-client/src/dacs/agreement-context-consumer.mjs';
import { purchaseSupport } from '../src/dacs/listing.mjs';
import { provenUnsignedAbsence } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { fixture } from './helpers/bilateral-vet-fixture.mjs';

function routeInput(w) {
  const input=w.input(),support=purchaseSupport(w.listing);
  assert.equal(support.supported,true);
  input.scope=agreementContextScope({
    operation:{accountId:'TEST-account',id:'TEST-operation',terms:{
      buyer:{wallet:w.buyer.address},protocol:{jobId:input.scope.jobId},
      seller:{claim:w.seller.claim,payee:support.payee},listing:w.pin,price:support.price,
    }},buyerBundle:input.buyerIdentityBundle,generatedAt:input.scope.generatedAt,
  });
  return input;
}

for(const adapter of ['fresh','repeat','recoverBuyer','resolveSeller','retainedScope'])test(`route-shaped purchase price is accepted by ${adapter}`,async t=>{
  const w=fixture();t.after(()=>w.base.close());
  const input=routeInput(w),first=await w.provider().resolveBuyer(input);
  assert.equal(first.disposition,'present');
  assert.deepEqual(first.value.scope,input.scope);
  assert.deepEqual(first.value.scope.price,{amount:'2.5',currency:'DEM',amountOs:'2500000000'});
  if(adapter==='fresh')return;
  const effects=[w.controls.signs,w.local.writes.length,w.seen.length];
  if(adapter==='retainedScope'){
    const [key]= (await w.store.entries())[0];
    await w.store.update(key,row=>({...row,seller:null}));
    w.config.retainedScope=async()=>input.scope;
  }
  const p=w.provider(),answer=adapter==='repeat'?await p.resolveBuyer(input)
    :adapter==='recoverBuyer'?await p.recoverBuyer(input)
    :await p.resolveSeller({jobId:input.scope.jobId,listingPin:w.pin,buyerIdentityBundle:input.buyerIdentityBundle,generatedAt:input.scope.generatedAt});
  assert.equal(answer.disposition,'present');
  assert.deepEqual(answer.value.input,first.value.input);
  assert.deepEqual([w.controls.signs,w.local.writes.length,w.seen.length],effects);
});

test('route-shaped purchase price resumes an interrupted unsigned run without effects',async t=>{
  const w=fixture();t.after(()=>w.base.close());
  const input=routeInput(w);let signs=0;
  w.config.wallet.signBytes=()=>{signs++;throw new Error('TEST signer interrupted');};
  await assert.rejects(w.provider().resolveBuyer(input));
  w.anchor.hasIntent=async()=>true;
  w.anchor.readRetained=async()=>provenUnsignedAbsence('TEST interrupted unsigned approval');
  w.config.store.update=()=>assert.fail('resume wrote state');
  assert.deepEqual(await w.provider().resumableBuyer(input),{writes:2});
  assert.deepEqual([signs,w.local.writes.length,w.seen.length],[1,0,0]);
});

for(const field of ['amount','currency','amountOs','missing amountOs','extra field'])test(`route-shaped price with changed ${field} is refused before effects`,async t=>{
  const w=fixture();t.after(()=>w.base.close());
  const input=routeInput(w);
  if(field==='missing amountOs')delete input.scope.price.amountOs;
  else if(field==='extra field')input.scope.price.extra='TEST-extra';
  else input.scope.price[field]=field==='amount'?'9':field==='currency'?'USD':'9000000';
  assert.equal((await w.provider().resolveBuyer(input)).code,'context_conflict');
  assert.deepEqual([w.controls.signs,w.local.writes.length,w.seen.length,w.issued.size,w.store.usage().jobs],[0,0,0,0,0]);
});
