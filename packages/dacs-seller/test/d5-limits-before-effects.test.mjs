import { admitFixtureFor } from './helpers/challenge-api.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {identityBundleHash} from '@kynesyslabs/dacs';
const {createSellerContextRoute}=await import('../src/dacs/seller-context-route.mjs');
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

test('B16 a resume conflict releases its new unused hold and never calls the provider',async t=>{
 const w=await world(t),input=await w.wire(),request=w.auth.readRequest(input.header),before=w.effects();
 assert.equal(await w.route.resume({effectKey:'a'.repeat(64)},request,{resume(){throw new Error('fixture conflict')}},{writes:1}),null);
 assert.equal(w.effects().holds,before.holds);assert.equal(w.effects().releases,before.releases+1,'only the previous hold is released, before the journal is asked');assert.equal(w.effects().writes,0);assert.deepEqual(w.effects().counts,before.counts);
});


test('B40 direct context routes and clients refuse malformed IDs before store, policy, Vet or readback callbacks',async t=>{
 const w=await world(t),input=await w.wire(),original=JSON.parse(input.text),request=w.auth.readRequest(input.header);
 const untouched=new Proxy({},{get(){assert.fail('malformed job reached the transport store')}});
 for(const jobId of [undefined,null,7,'job-0',JOBS[0].toLowerCase(),JOBS[0].slice(1),'8'+JOBS[0].slice(1)]){
  const p={...request,jobId},body={...original,scope:{...original.scope,jobId}},before=w.effects();
  assert.throws(()=>w.route.onRejectedBody(p,body,untouched),{code:'peer_job_invalid'});
  for(const method of ['challenge','reserve']){
   await assert.rejects(w.route[method](p,body,untouched),{code:'peer_job_invalid'});
   await assert.rejects(w.route[method](request,body,untouched),{code:'peer_job_invalid'});
  }
  assert.throws(()=>w.route.perform(body),{code:'peer_job_invalid'});
  assert.throws(()=>w.route.settled({jobId,hold:'unused'}),{code:'peer_job_invalid'});
  await assert.rejects(w.route.reconcile({body}),{code:'peer_job_invalid'});
  await assert.rejects(w.route.resume({},p,untouched,{writes:1}),{code:'peer_job_invalid'});
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
  assert.deepEqual(effectState(w.effects()),effectState(before));
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

test('B29 a journal reservation conflict creates no policy hold',async t=>{
 const w=await world(t),input=await w.wire(),request=w.auth.readRequest(input.header),body=JSON.parse(input.text),original=w.store.reserve;
 const {createSellerContextAdmission}=await import('../src/devnet-demo/operator-approval.mjs');
 const evidencePath=join(tmpdir(),'d5-race-'+randomBytes(16).toString('hex')+'.jsonl');t.after(()=>rm(evidencePath,{force:true}));
 const policy=createSellerContextAdmission({evidencePath,sellerApproval:{mode:'policy'},now:w.now});
 const route=createSellerContextRoute({admitPresentation:admitFixtureFor(w.listing),listing:w.listing,resolveBuyer:()=>assert.fail('provider ran'),assertBuyerAccess:()=>{},admitWrites:policy.reserve,releaseWrites:policy.release,writable:()=>true,recover:async()=>null,now:w.now});
 w.store.reserve=(...args)=>{if(!args[2]?.dryRun)throw new Error('fixture capacity changed after dry check');return original.apply(w.store,args)};
 await assert.rejects(route.reserve(request,body,w.store),/capacity changed/);
 await assert.rejects(readFile(evidencePath,'utf8'),{code:'ENOENT'});assert.equal(w.effects().writes,0);assert.equal(w.effects().counts.peer_effects,0);
});

test('B31 the context client preserves a definite non-pass decision and attribution',async()=>{
 const {createSellerContextClient}=await import('../src/dacs/seller-context-route.mjs');
 const buyer=key(),bundle=bundleFor(buyer),scope={source:'d5-test-context/v1',wallet:'0x'+buyer.claim.slice(16),jobId:JOBS[0],buyer:buyer.claim,buyerBundleHash:identityBundleHash(bundle),seller:key().claim,listingPin:{listingId:'D5',version:1,contentHash:'b'.repeat(64)},rail:{railId:'demos-native:DEM',railVersion:1},payee:'fixture',price:{amount:'1',currency:'DEM'},generatedAt:T};
 const client=createSellerContextClient({clientFor:()=>({agreementContext:async()=>({disposition:'rejected',code:'party_vet_non_pass',errorClass:'counterparty',reason:'seller Vet decision: fail'})})});
 const answer=await client.resolveBuyer({scope,buyerIdentityBundle:bundle},{operation:{state:{protocol:{sellerContextRequest:{scope,buyerBundle:bundle}}}}});assert.equal(answer.disposition,'rejected');assert.equal(answer.code,'party_vet_non_pass');assert.equal(answer.errorClass,'counterparty');assert.match(answer.reason,/seller Vet decision: fail/);
});

const effectState=({releases,...value})=>({...value,counts:Object.fromEntries(Object.entries(value.counts).filter(([key])=>!['peer_nonces','peer_nonce_retention'].includes(key)))});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
for(const missing of ['admitWrites','releaseWrites','writable','recover'])test(`context construction requires ${missing} before provider work`,async t=>{
 const w=await world(t),callbacks={listing:w.listing,resolveBuyer:()=>assert.fail('provider'),assertBuyerAccess:()=>{},admitWrites:async()=>null,releaseWrites:async()=>{},writable:()=>true,recover:async()=>null};delete callbacks[missing];assert.throws(()=>createSellerContextRoute(callbacks),TypeError);
});