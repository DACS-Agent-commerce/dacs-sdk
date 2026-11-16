import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {identityBundleHash} from '@kynesyslabs/dacs';
const {createSellerTransportClientAuth,SELLER_CONTEXT_PATH}=await import('../src/dacs/seller-transport-auth.mjs');
const {createSellerTransportStore}=await import('./helpers/bound-transport-store.mjs');
import {JOBS,T,key,bundleFor,world} from './helpers/d5-http-fixture.mjs';

test('transport job capacity is independent of live nonce capacity, with completed jobs retained', async t => {
 const dir=await mkdtemp(join(tmpdir(),'seller-job-capacity-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 let time=T;
 const path=join(dir,'transport.sqlite');
 for(const maxJobs of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>createSellerTransportStore({path,maxJobs}),/positive job capacity/);
 const store=createSellerTransportStore({path,maxRecords:1,maxJobs:2,now:()=>time});t.after(()=>store.close());
 const buyer=key(),seller=key();
 const payload=jobId=>({version:'1',kind:'request',method:'POST',path:'/dacs/v1/agreements/proposals',bodyHash:'a'.repeat(64),jobId,
  buyer:buyer.claim,seller:seller.claim,listingPin:{listingId:'capacity',version:1,contentHash:'b'.repeat(64)},agreementHash:'c'.repeat(64),
  nonce:randomBytes(16).toString('base64url'),expiresAt:time+30000});
 for(const jobId of JOBS.slice(0,2)) {
  const reservation=store.reserve(payload(jobId),{});assert.equal(reservation.disposition,'perform');
  store.finish(reservation,200,'{}',{});time+=61000;
 }
 assert.throws(()=>store.reserve(payload(JOBS[2]),{}),{code:'peer_job_capacity'});
 // A small job limit must not shrink the simultaneous request budget either.
 const other=createSellerTransportStore({path:join(dir,'other.sqlite'),maxRecords:2,maxJobs:1,now:()=>time});t.after(()=>other.close());
 const first=payload(JOBS[0]),reservation=other.reserve(first,{});other.finish(reservation,200,'{}',{});
 assert.equal(other.reserve({...payload(JOBS[0]),path:'/dacs/v1/commitments'},{}).disposition,'perform');
});

test('context records, the context client and the transport auth refuse malformed IDs before store, policy, Vet or readback callbacks',async t=>{
 const w=await world(t),input=await w.wire(),original=JSON.parse(input.text),request=w.auth.readRequest(input.header);
 for(const jobId of [undefined,null,7,'job-0',JOBS[0].toLowerCase(),JOBS[0].slice(1),'8'+JOBS[0].slice(1)]){
 const p={...request,jobId},body={...original,scope:{...original.scope,jobId}},before=w.counts();
  const {createSellerContextClient,createSellerContextRecords}=await import('../src/dacs/seller-context-route.mjs');
  const records=createSellerContextRecords({listing:w.listing,admission:()=>assert.fail('records read an admission for a malformed job'),contextOutcome:()=>assert.fail('records read an outcome for a malformed job')});
  assert.throws(()=>records.exactRequest({jobId,buyerBundle:body.buyerIdentityBundle,generatedAt:T}),{code:'peer_job_invalid'});
  assert.throws(()=>records.completedScope({jobId,buyer:w.buyer.claim}),{code:'peer_job_invalid'});
  assert.throws(()=>w.auth.validate(p,{}),{code:'peer_request_unauthenticated'});
  await assert.rejects(w.auth.responseHeader(p,200,'{}'),{code:'peer_job_invalid'});
  await assert.rejects(createSellerContextClient({clientFor:()=>assert.fail('client resolved malformed job')}).resolveBuyer(body),{code:'peer_job_invalid'});
  const client=createSellerTransportClientAuth({buyerSigner:w.buyer,seller:w.seller.claim,resolveJob:()=>assert.fail('transport resolved malformed job')});
  await assert.rejects(client.request(SELLER_CONTEXT_PATH,body,JSON.stringify(body)),{code:'peer_job_invalid'});
  assert.throws(()=>client.verifyResponse(p,{}),{code:'peer_job_invalid'});
  assert.deepEqual(withoutNonceTables(w.counts()),withoutNonceTables(before));
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

const withoutNonceTables=counts=>Object.fromEntries(Object.entries(counts).filter(([key])=>!['peer_nonces','peer_nonce_retention'].includes(key)));