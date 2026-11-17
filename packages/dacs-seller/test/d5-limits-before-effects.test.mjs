import test from 'node:test';
import assert from 'node:assert/strict';
import {identityBundleHash} from '@kynesyslabs/dacs';
const {createSellerTransportClientAuth,SELLER_CONTEXT_PATH}=await import('../src/dacs/seller-transport-auth.mjs');
import {JOBS,T,key,bundleFor,world} from './helpers/d5-http-fixture.mjs';

test('context records, the context client and the transport auth refuse malformed IDs before store, policy, Vet or readback callbacks',async t=>{
 const w=await world(t),input=await w.wire(),original=JSON.parse(input.text),request=input.request;
 for(const jobId of [undefined,null,7,'job-0',JOBS[0].toLowerCase(),JOBS[0].slice(1),'8'+JOBS[0].slice(1)]){
 const p={...request,jobId},body={...original,scope:{...original.scope,jobId}},before=w.counts();
  const {createSellerContextClient,createSellerContextRecords}=await import('../src/dacs/seller-context-route.mjs');
  const records=createSellerContextRecords({listing:w.listing,admission:()=>assert.fail('records read an admission for a malformed job'),contextOutcome:()=>assert.fail('records read an outcome for a malformed job')});
  assert.throws(()=>records.exactRequest({jobId,buyerBundle:body.buyerIdentityBundle,generatedAt:T}),{code:'peer_job_invalid'});
  assert.throws(()=>records.completedScope({jobId,buyer:w.buyer.claim}),{code:'peer_job_invalid'});
  await assert.rejects(createSellerContextClient({clientFor:()=>assert.fail('client resolved malformed job')}).resolveBuyer(body),{code:'peer_job_invalid'});
  const client=createSellerTransportClientAuth({buyerSigner:w.buyer,seller:w.seller.claim,resolveJob:()=>assert.fail('transport resolved malformed job')});
  await assert.rejects(client.request(SELLER_CONTEXT_PATH,body,JSON.stringify(body)),{code:'peer_job_invalid'});
  assert.throws(()=>client.verifyResponse(p,{}),{code:'peer_job_invalid'});
  assert.deepEqual(w.counts(),before);
 }
});

test('B43 the context client preserves a signed canonical-job refusal as a definite no-write answer',async t=>{
 const w=await world(t),body=JSON.parse((await w.wire()).text);
 const {createSellerContextClient,sellerContextRequestUnknown}=await import('../src/dacs/seller-context-route.mjs');
 const {SellerRefusedError}=await import('../src/dacs/seller-http.mjs');
 const client=createSellerContextClient({clientFor:()=>({agreementContext:async()=>{throw new SellerRefusedError('peer_job_invalid','invalid job',409)}})});
 const answer=await client.resolveBuyer(body,{operation:{state:{protocol:{sellerContextRequest:{scope:body.scope,buyerBundle:body.buyerIdentityBundle}}}}});
 assert.equal(answer.disposition,'rejected');assert.equal(answer.written,false);assert.equal(sellerContextRequestUnknown(answer.reason),true);
});

test('B31 the context client preserves a definite non-pass decision and attribution',async()=>{
 const {createSellerContextClient}=await import('../src/dacs/seller-context-route.mjs');
 const buyer=key(),bundle=bundleFor(buyer),scope={source:'d5-test-context/v1',wallet:'0x'+buyer.claim.slice(16),jobId:JOBS[0],buyer:buyer.claim,buyerBundleHash:identityBundleHash(bundle),seller:key().claim,listingPin:{listingId:'D5',version:1,contentHash:'b'.repeat(64)},rail:{railId:'demos-native:DEM',railVersion:1},payee:'fixture',price:{amount:'1',currency:'DEM'},generatedAt:T};
 const client=createSellerContextClient({clientFor:()=>({agreementContext:async()=>({disposition:'rejected',code:'party_vet_non_pass',errorClass:'counterparty',reason:'seller Vet decision: fail'})})});
 const answer=await client.resolveBuyer({scope,buyerIdentityBundle:bundle},{operation:{state:{protocol:{sellerContextRequest:{scope,buyerBundle:bundle}}}}});assert.equal(answer.disposition,'rejected');assert.equal(answer.code,'party_vet_non_pass');assert.equal(answer.errorClass,'counterparty');assert.match(answer.reason,/seller Vet decision: fail/);
});

