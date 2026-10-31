import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import DatabaseSync from 'better-sqlite3';
import {canonicalize,identityBundleHash,sha256Hex} from '@kynesyslabs/dacs';
const {createSellerHttpHandler}=await import('../src/dacs/seller-http.mjs');
const {createSellerContextRoute,SELLER_CONTEXT_LIMITS}=await import('../src/dacs/seller-context-route.mjs');
const {createSellerTransportStore,createSellerTransportServerAuth,createSellerTransportClientAuth,SELLER_TRANSPORT_HEADER,SELLER_CONTEXT_PATH,SELLER_CONTEXT_CHALLENGE_PATH,sellerContextChallengeScope,sellerContextScopeHash}=await import('../src/dacs/seller-transport-auth.mjs');
import {JOBS,T,key,bundleFor,exchange,presentContext,world} from './helpers/d5-http-fixture.mjs';

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

test('B1 per-buyer unpaid-start limit refuses before any policy hold, log, journal insert, or provider write',async t=>{
 const w=await world(t);assert.equal((await exchange(w.handler,await w.wire())).status,200);const before=w.effects();
 const refused=await exchange(w.handler,await w.wire({jobId:JOBS[1]}));assert.equal(refused.status,409);assert.equal(JSON.parse(refused.text).error,'buyer_unpaid_start_limit');assert.deepEqual(effectState(w.effects()),effectState(before));
});
test('B2 global unpaid-start limit covers different buyers before all effects, including after restart',async t=>{
 const w=await world(t,{limits:{maxStartsPerHour:1,maxStartsPerBuyerPerHour:5}});assert.equal((await exchange(w.handler,await w.wire())).status,200);const before=w.effects();
 const refused=await exchange(w.handler,await w.wire({actor:w.other,jobId:JOBS[1]}));assert.equal(JSON.parse(refused.text).error,'unpaid_start_limit');assert.deepEqual(effectState(w.effects()),effectState(before));
 const reopened=createSellerTransportStore({path:w.path});t.after(()=>reopened.close());const input=await w.wire({actor:w.other,jobId:JOBS[1],fresh:true});const request=w.auth.readRequest(input.header),body=JSON.parse(input.text);
 await assert.rejects(w.route.reserve(request,body,reopened),{code:'unpaid_start_limit'});
 assert.throws(()=>reopened.attemptContextPresentation(request,body),{code:'context_challenge_consumed'});assert.deepEqual(effectState(w.effects()),effectState(before));
});
test('B3 accepted start at the exact one-hour boundary is outside the rolling count; one millisecond before is still inside',async t=>{
 const w=await world(t);await exchange(w.handler,await w.wire());w.advance(3599999);const before=w.effects();assert.equal((await exchange(w.handler,await w.wire({jobId:JOBS[1]}))).status,409);assert.deepEqual(effectState(w.effects()),effectState(before));
 w.advance(1);assert.equal((await exchange(w.handler,await w.wire({jobId:JOBS[1]}))).status,200);assert.equal(w.effects().writes,2);assert.deepEqual(SELLER_CONTEXT_LIMITS,{maxStartsPerBuyerPerHour:5,maxStartsPerHour:12});
});
test('B4 retries use the durable answer and cannot reserve or execute another write',async t=>{
 const w=await world(t,{recover:presentContext});const input=await w.wire(),first=await exchange(w.handler,input),before=w.effects();
 assert.equal((await exchange(w.handler,input)).text,first.text);assert.deepEqual(effectState(w.effects()),effectState(before));
 const fresh=await exchange(w.handler,await w.wire());assert.equal(fresh.text,first.text);assert.deepEqual(effectState(w.effects()),effectState(before));
});
test('B5 three concurrent starts share the global limit before any second hold or write',async t=>{
 const w=await world(t,{limits:{maxStartsPerHour:1,maxStartsPerBuyerPerHour:5}}),inputs=await Promise.all(JOBS.slice(0,3).map(jobId=>w.wire({jobId})));
 const out=await Promise.all(inputs.map(input=>exchange(w.handler,input)));assert.equal(out.filter(r=>r.status===200).length,1);assert.equal(w.effects().holds,1);assert.equal(w.effects().writes,1);
});
test('B6 journal capacity refuses before a policy hold or provider write',async t=>{
 const w=await world(t,{maxRecords:1});await exchange(w.handler,await w.wire());const before=w.effects();const refused=await exchange(w.handler,await w.wire({actor:w.other,jobId:JOBS[1]}));assert.equal(JSON.parse(refused.text).error,'peer_store_capacity');assert.deepEqual(effectState(w.effects()),effectState(before));
});
test('B7 invalid identity, multiple claims, fractional and stale time refuse before all effects',async t=>{
 const w=await world(t);let offset=0;for(const alter of [b=>{b.buyerIdentityBundle.bundleVersion='2'},b=>{b.buyerIdentityBundle.claims.push({ref:w.other.claim});b.buyerIdentityBundle.presentation.signatures.push({ref:w.other.claim,signature:Buffer.alloc(64).toString('base64url')})},b=>{b.scope.sellerRequirement={requirementVersion:'1',required:[{scheme:'key',verificationRequired:false}]}},b=>{b.scope.generatedAt+=0.5},b=>{b.scope.generatedAt-=600001}]){
  w.advance(++offset);const input=await w.wire({alter}),before=w.effects(),out=await exchange(w.handler,input);assert.equal(out.status,409,out.text);assert.deepEqual(effectState(w.effects()),effectState(before));
 }
 w.advance(1);assert.equal((await exchange(w.handler,await w.wire({alter:b=>{b.scope.generatedAt-=600000}}))).status,200,'the inclusive freshness boundary remains valid with its own issued challenge');
});
test('B8 malformed, absent and oversized authentication leaves the journal and provider untouched',async t=>{
 const w=await world(t);for(const header of [undefined,'bad','a'.repeat(4097)]){const before=w.effects(),out=await exchange(w.handler,{text:'{}',header});assert.equal(out.status,401);assert.deepEqual(effectState(w.effects()),effectState(before));}
});
test('B9 authenticated and unauthenticated oversized bodies fail before authentication or journaling, for declared and streamed sizes',async t=>{
 const w=await world(t),signed=await w.wire();for(const header of [undefined,signed.header])for(const headers of [{},{'content-length':'65537'}]){
  const before=w.effects(),out=await exchange(w.handler,{text:'x'.repeat(65537),header,headers});assert.equal(out.status,413);assert.deepEqual(effectState(w.effects()),effectState(before));
 }
});
test('B10 authenticated and unauthenticated rates are bounded before authentication, logging or journaling',async t=>{
 for(const signed of [false,true]){const w=await world(t,{maxRequestsPerWindow:1}),input=signed?await w.wire():{};await exchange(w.handler,input);const before=w.effects(),again=signed?await w.wire():{};assert.equal((await exchange(w.handler,again)).status,429);assert.deepEqual(effectState(w.effects()),effectState(before));}
});
test('B11 concurrency is bounded before authentication or effects for authenticated and unauthenticated traffic',async t=>{
 let finish,started;const begun=new Promise(resolve=>{started=resolve}),wait=new Promise(resolve=>{finish=resolve});
 const w=await world(t,{maxConcurrent:1,perform:async()=>{started();await wait;return {disposition:'absent',reason:'fixture'}}});
 const first=exchange(w.handler,await w.wire());await begun;const before=w.effects();
 for(const input of [{},await w.wire({actor:w.other,jobId:JOBS[1]})]){assert.equal((await exchange(w.handler,input)).status,429);assert.deepEqual(effectState(w.effects()),effectState(before));}finish();await first;
});
test('B12 a body timeout ends before authentication or any journal entry',async t=>{
 const w=await world(t,{bodyTimeoutMs:5}),req=new PassThrough();Object.assign(req,{url:SELLER_CONTEXT_PATH,method:'POST',headers:{'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1',localAddress:'127.0.0.1'}});
 const res={writeHead(status){this.status=status},end(){this.writableEnded=true}},before=w.effects();await w.handler(req,res);assert.equal(res.status,408);assert.deepEqual(effectState(w.effects()),effectState(before));req.destroy();
});
test('B13 start-limit rejection commits only the required anti-replay consumption',async t=>{
 const originalPrepare=DatabaseSync.prototype.prepare,originalExec=DatabaseSync.prototype.exec,mutations=[];let watch=false;
 DatabaseSync.prototype.prepare=function(sql){const statement=originalPrepare.call(this,sql);if(/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)){const run=statement.run;statement.run=function(...args){if(watch)mutations.push(sql);return run.apply(this,args)}}return statement;};
 DatabaseSync.prototype.exec=function(sql){if(watch&&/\b(CREATE|INSERT|UPDATE|DELETE|DROP|REPLACE)\b/i.test(sql))mutations.push(sql);return originalExec.call(this,sql);};
 t.after(()=>{DatabaseSync.prototype.prepare=originalPrepare;DatabaseSync.prototype.exec=originalExec});
 const w=await world(t);await exchange(w.handler,await w.wire());const input=await w.wire({jobId:JOBS[1]}),before=w.effects();watch=true;
 const response=await exchange(w.handler,input);watch=false;
 assert.equal(response.status,409);assert.equal(mutations.filter(sql=>sql.startsWith('DELETE FROM peer_nonce')).length,2,'both nonce tables are reclaimed before insertion');assert.deepEqual(mutations.filter(sql=>!sql.startsWith('DELETE FROM peer_nonce')),['UPDATE peer_context_challenges SET attempted = 1 WHERE nonce = ?', 'INSERT INTO peer_nonces VALUES (?, ?, ?, ?, ?)', 'INSERT INTO peer_nonce_retention VALUES (?, ?, ?, ?)'],'challenge consumption and the definite refusal nonce commit together');assert.deepEqual(effectState(w.effects()),effectState(before));
});
test('B14 an uncertain context effect is read back without a second hold or provider write',async t=>{
 const w=await world(t,{perform:async()=>{throw new Error('unknown fixture outcome')}});const first=await exchange(w.handler,await w.wire());assert.equal(first.status,503);const before=w.effects();
 const retry=await exchange(w.handler,await w.wire());assert.equal(retry.status,503);assert.equal(w.effects().holds,before.holds);assert.equal(w.effects().writes,before.writes);assert.equal(w.effects().counts.peer_effects,1);
});

test('B15 a failed release cannot turn a definite context answer into an uncertain one',async t=>{
 const w=await world(t,{releaseFails:true});const out=await exchange(w.handler,await w.wire());assert.equal(out.status,200);assert.equal(w.effects().writes,1);assert.equal(w.effects().releases,1);
});
test('B16 a resume conflict releases its new unused hold and never calls the provider',async t=>{
 const w=await world(t),input=await w.wire(),request=w.auth.readRequest(input.header),before=w.effects();
 assert.equal(await w.route.resume({effectKey:'a'.repeat(64)},request,{resume(){throw new Error('fixture conflict')}},{writes:1}),null);
 assert.equal(w.effects().holds,before.holds);assert.equal(w.effects().releases,before.releases);assert.equal(w.effects().writes,0);assert.deepEqual(w.effects().counts,before.counts);
});

async function signed(w,body,{actor=w.buyer,url=SELLER_CONTEXT_PATH}={}){
 const scope=body.scope,text=JSON.stringify(body),client=createSellerTransportClientAuth({buyerSigner:actor,seller:w.seller.claim,resolveJob:()=>({listingPin:w.pin,agreementHash:sellerContextScopeHash(scope)}),now:w.now});
 return {text,header:(await client.request(url,body,text)).header,url};
}
function present(w,body){
 body.scope.buyerBundleHash=identityBundleHash(body.buyerIdentityBundle);
 body.buyerIdentityBundle.presentation.signatures[0].signature=w.buyer.sign(Buffer.from('dacs-bundle-presentation:v1:'+body.scope.buyerBundleHash)).toString('base64url');
 return body;
}
function nonceCount(w){return w.effects().counts.peer_nonces;}

test('B38 correctly signed malformed job IDs are refused at challenge, context, proposal and payment boundaries without effects',async t=>{
 const w=await world(t),input=await w.wire(),original=JSON.parse(input.text);
 const template=JSON.parse(Buffer.from(input.header,'base64url').toString()).payload;
 const snapshot=()=>{const db=new DatabaseSync(w.path,{readonly:true});try{return db.prepare('SELECT * FROM peer_context_challenges ORDER BY nonce').all()}finally{db.close()}};
 for(const jobId of [JOBS[0].toLowerCase(),JOBS[0].replace('0','O'),JOBS[0].slice(1),'8'+JOBS[0].slice(1),'job-0',null,7]){
  for(const url of [SELLER_CONTEXT_CHALLENGE_PATH,SELLER_CONTEXT_PATH,'/dacs/v1/agreements/proposals','/dacs/v1/payments']){
   const body=url.startsWith(SELLER_CONTEXT_PATH)?{scope:{...original.scope,jobId},...(url===SELLER_CONTEXT_PATH?{buyerIdentityBundle:original.buyerIdentityBundle}:{})}
    :url.endsWith('/payments')?{jobId,payerPayingKey:w.buyer.claim,txHash:'a'.repeat(64)}:{transportIdentity:{jobId,buyer:w.buyer.claim,seller:w.seller.claim,agreementHash:template.agreementHash}};
   if(url===SELLER_CONTEXT_CHALLENGE_PATH)delete body.scope.buyerBundleHash;
   const text=JSON.stringify(body),payload={...template,path:url,jobId,bodyHash:sha256Hex(text)};
   // The normal client refuses malformed IDs locally. Sign the exact negative
   // vector here so the server, rather than the client, must enforce JID-1.
   const signature=w.buyer.sign(Buffer.from('dacs-chatgpt-plugin:loopback-seller-peer:v1:'+canonicalize(payload))).toString('base64url');
   const header=Buffer.from(canonicalize({payload,signature})).toString('base64url'),before=w.effects(),challenges=snapshot();
   const out=await exchange(w.handler,{url,text,header});
   assert.equal(out.status,401,url+' '+String(jobId)+' '+out.text);assert.equal(JSON.parse(out.text).error,'peer_envelope_invalid');
   assert.deepEqual(effectState(w.effects()),effectState(before));assert.deepEqual(snapshot(),challenges);
  }
 }
 assert.equal((await exchange(w.handler,input)).status,200,'the canonical signed control still admits');
});

test('B39 bundle presentedAt in the past or future never gates admission',async t=>{
 for(const offset of [-86400000,86400000]){
  const w=await world(t),input=await w.wire(),body=JSON.parse(input.text);
  body.buyerIdentityBundle.presentedAt=T+offset;
  const out=await exchange(w.handler,await signed(w,present(w,body)));
  assert.equal(out.status,200,out.text);assert.equal(w.effects().writes,1);
 }
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
  const records=createSellerContextRecords({listing:w.listing,store:()=>assert.fail('records opened malformed job')});
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

test('B41 a canonical cross-job body still consumes its recognized presentation nonce on attempt',async t=>{
 const w=await world(t),input=await w.wire(),body=JSON.parse(input.text);
 const payload=JSON.parse(Buffer.from(input.header,'base64url').toString()).payload;
 body.scope.jobId=JOBS[1];const text=JSON.stringify(body);payload.bodyHash=sha256Hex(text);
 const signature=w.buyer.sign(Buffer.from('dacs-chatgpt-plugin:loopback-seller-peer:v1:'+canonicalize(payload))).toString('base64url');
 const header=Buffer.from(canonicalize({payload,signature})).toString('base64url');
 assert.equal(JSON.parse((await exchange(w.handler,{text,header})).text).error,'context_challenge_mismatch');
 assert.equal(JSON.parse((await exchange(w.handler,input)).text).error,'context_challenge_consumed');assert.equal(w.effects().writes,0);
});

test('B42 malformed body jobs in a canonical signed envelope refuse without consuming a challenge or starting work',async t=>{
 const w=await world(t),input=await w.wire(),original=JSON.parse(input.text);
 const template=JSON.parse(Buffer.from(input.header,'base64url').toString()).payload;
 for(const jobId of [undefined,null,7,JOBS[0].toLowerCase(),JOBS[0].slice(1)]){
  const body={...original,scope:{...original.scope,jobId}},text=JSON.stringify(body),payload={...template,bodyHash:sha256Hex(text)};
  const signature=w.buyer.sign(Buffer.from('dacs-chatgpt-plugin:loopback-seller-peer:v1:'+canonicalize(payload))).toString('base64url');
  const header=Buffer.from(canonicalize({payload,signature})).toString('base64url'),before=w.effects();
  const out=await exchange(w.handler,{text,header});assert.equal(JSON.parse(out.text).error,'peer_job_invalid');assert.deepEqual(effectState(w.effects()),effectState(before));
  const db=new DatabaseSync(w.path,{readonly:true});try{assert.equal(db.prepare('SELECT attempted FROM peer_context_challenges WHERE nonce=?').get(body.buyerIdentityBundle.sessionNonce).attempted,0);}finally{db.close();}
 }
 assert.equal((await exchange(w.handler,input)).status,200);
});

test('B43 the context client preserves a signed canonical-job refusal as a definite no-write answer',async t=>{
 const w=await world(t),body=JSON.parse((await w.wire()).text);
 const {createSellerContextClient,sellerContextRequestUnknown}=await import('../src/dacs/seller-context-route.mjs');
 const {SellerRefusedError}=await import('../src/dacs/seller-http.mjs');
 const client=createSellerContextClient({clientFor:()=>({agreementContext:async()=>{throw new SellerRefusedError('peer_job_invalid','invalid job',409)}})});
 const answer=await client.resolveBuyer(body,{operation:{state:{protocol:{sellerContextRequest:{generatedAt:body.scope.generatedAt,buyerBundle:body.buyerIdentityBundle}}}}});
 assert.equal(answer.disposition,'rejected');assert.equal(answer.written,false);assert.equal(sellerContextRequestUnknown(answer.reason),true);
});

test('B17 retries and unknown-job state reads retain bounded nonce answers without new effects; another buyer still starts',async t=>{
 const w=await world(t,{maxRecords:128,maxRequestsPerWindow:1000,recover:presentContext});const first=await w.wire();await exchange(w.handler,first);
 const before=w.effects();assert.equal((await exchange(w.handler,await w.wire({jobId:JOBS[1]}))).status,409);
 for(let i=0;i<20;i++){
  assert.equal((await exchange(w.handler,await w.wire())).status,200);
  const body={transportIdentity:{jobId:JOBS[3],buyer:w.buyer.claim,seller:w.seller.claim,agreementHash:'c'.repeat(64)}},text=JSON.stringify(body),url='/dacs/v1/agreements/state';
  const client=createSellerTransportClientAuth({buyerSigner:w.buyer,seller:w.seller.claim,resolveJob:()=>({listingPin:w.pin,agreementHash:'c'.repeat(64)}),now:w.now});
  assert.equal((await exchange(w.handler,{text,url,header:(await client.request(url,body,text)).header})).status,200);
 }
 assert.deepEqual(effectState(w.effects()),effectState(before));assert.equal((await exchange(w.handler,await w.wire({actor:w.other,jobId:JOBS[2]}))).status,200);
});
test('B18 completed expired nonces free capacity after restart while old effect answers remain',async t=>{
 const requestLifetimeMs=30000,nonceWindowMs=60000,w=await world(t,{maxRecords:1,recover:presentContext}),first=await w.wire(),firstAnswer=await exchange(w.handler,first);
 assert.equal(firstAnswer.status,200);w.advance(requestLifetimeMs+1);
 const reopened=createSellerTransportStore({path:w.path,maxRecords:1,maxContextRecords:10000,now:w.now});t.after(()=>reopened.close());
 const early=await w.wire({actor:w.other,jobId:JOBS[1]});
 // Request expiry does not end the retained nonce's full rate window.
 await assert.rejects(w.route.reserve(w.auth.readRequest(early.header),JSON.parse(early.text),reopened),{code:'peer_store_capacity'});
 w.advance(nonceWindowMs-requestLifetimeMs);
 const input=await w.wire({actor:w.other,jobId:JOBS[1]}),request=w.auth.readRequest(input.header),body=JSON.parse(input.text);
 const reservation=await w.route.reserve(request,body,reopened);assert.equal(reservation.disposition,'perform');reopened.finish(reservation,200,'{}');
 assert.equal(nonceCount(w),1);assert.equal(w.effects().counts.peer_effects,2);
 w.advance(nonceWindowMs+1);
 const fresh=await signed(w,JSON.parse(first.text)),cached=await exchange(w.handler,fresh),retry=await exchange(w.handler,fresh);
 assert.equal(cached.status,200);assert.equal(retry.status,200);assert.equal(cached.text,firstAnswer.text);assert.equal(retry.text,firstAnswer.text);
 assert.equal(w.effects().writes,1,'retained answer never calls provider again');
});
test('B19 new nonce rows are bounded per buyer before journaling, and expire out of the rate window',async t=>{
 const w=await world(t,{maxNoncesPerBuyerPerWindow:1,limits:{maxStartsPerHour:5,maxStartsPerBuyerPerHour:5}});await exchange(w.handler,await w.wire());
 const input=await w.wire({jobId:JOBS[1]}),before=w.effects(),refused=await exchange(w.handler,input);
 assert.equal(JSON.parse(refused.text).error,'peer_buyer_nonce_limit');assert.deepEqual(effectState(w.effects()),effectState(before));
 assert.equal((await exchange(w.handler,await w.wire({actor:w.other,jobId:JOBS[2]}))).status,200);
 w.advance(60000);assert.equal((await exchange(w.handler,await w.wire({jobId:JOBS[1]}))).status,200);
});
test('B20 a successful unsigned-cut resume uses one remaining-write hold and the same admission',async t=>{
 let calls=0;const w=await world(t,{perform:async body=>{if(++calls===1)throw new Error('unsigned shutdown cut');return presentContext(body)},recover:async body=>calls>1?presentContext(body):null,resumable:async()=>({writes:1})});
 const input=await w.wire();assert.equal((await exchange(w.handler,input)).status,503);const before=w.effects(),admitted=w.store.contextAdmission(JOBS[0]);
 let resumed=false;const original=w.store.resume;w.store.resume=(...args)=>{const result=original(...args);resumed=result.resumed;return result};
 assert.equal((await exchange(w.handler,await w.wire())).status,200);assert.equal(resumed,true);assert.equal(w.effects().holds,before.holds+1);assert.equal(w.effects().writes,before.writes+1);assert.deepEqual(w.store.contextAdmission(JOBS[0]),admitted);
 const after=w.effects();assert.equal((await exchange(w.handler,await w.wire())).status,200);assert.deepEqual(effectState(w.effects()),effectState(after));
});
test('B21 definite post-write Vet failure is retained, counted, and recovered with the same answer',async t=>{
 const answer={disposition:'rejected',code:'party_vet_non_pass',errorClass:'counterparty',reason:'buyer Vet decision: fail'};
 for(const recovery of [false,true]){
  const w=await world(t,{perform:async()=>{if(recovery)throw new Error('lost response');return answer},recover:async()=>answer});
  const input=await w.wire();assert.equal((await exchange(w.handler,input)).status,recovery?503:200);
  const result=await exchange(w.handler,await w.wire());assert.equal(result.status,200);assert.deepEqual(JSON.parse(result.text),answer);assert.ok(w.store.contextAdmission(JOBS[0]));
  const before=w.effects();assert.equal((await exchange(w.handler,await w.wire({jobId:JOBS[1]}))).status,409);assert.deepEqual(effectState(w.effects()),effectState(before));assert.equal(w.effects().writes,1);
 }
});
test('B22 missing, buyer-chosen, mismatched, expired and cross-job presentations cannot start work',async t=>{
 for(const mode of ['missing','chosen','scope','expired','job']){
  const w=await world(t),input=await w.wire(),body=JSON.parse(input.text);
  if(mode==='missing')delete body.buyerIdentityBundle.sessionNonce;
  if(mode==='chosen')body.buyerIdentityBundle.sessionNonce='f'.repeat(64);
  if(mode==='scope')body.scope.generatedAt++;
  if(mode==='expired')w.advance(60000);
  if(mode==='job')body.scope.jobId=JOBS[1];
  const before=w.effects(),out=await exchange(w.handler,await signed(w,present(w,body)));
  assert.equal(out.status,409,mode+out.text);assert.match(JSON.parse(out.text).error,/context_challenge_/);assert.deepEqual(effectState(w.effects()),effectState(before));
 }
});
test('B23 challenge is consumed on a failed proof attempt, retained across restart, and not reaccepted',async t=>{
 const w=await world(t),input=await w.wire(),body=JSON.parse(input.text),bad=structuredClone(body);bad.buyerIdentityBundle.presentation.signatures[0].signature=Buffer.alloc(64).toString('base64url');
 assert.equal(JSON.parse((await exchange(w.handler,await signed(w,bad))).text).error,'buyer_bundle_unauthenticated');
 const reopened=createSellerTransportStore({path:w.path,now:w.now});t.after(()=>reopened.close());
 assert.throws(()=>reopened.attemptContextPresentation(w.auth.readRequest(input.header),body),{code:'context_challenge_consumed'});
 assert.equal(JSON.parse((await exchange(w.handler,input)).text).error,'context_challenge_consumed');assert.equal(w.effects().writes,0);
});
test('B24 authenticated challenge issuance is bounded before journal effects and returns seller-generated entropy',async t=>{
 const w=await world(t),input=await w.wire(),body={scope:sellerContextChallengeScope(JSON.parse(input.text).scope)},before=w.effects();
 assert.equal((await exchange(w.handler,{url:SELLER_CONTEXT_CHALLENGE_PATH,text:JSON.stringify(body)})).status,401);
 const response=await exchange(w.handler,await signed(w,body,{url:SELLER_CONTEXT_CHALLENGE_PATH}));assert.equal(response.status,200);assert.match(JSON.parse(response.text).sessionNonce,/^[0-9a-f]{64}$/);assert.deepEqual(effectState(w.effects()),effectState(before));
 const second={scope:{...body.scope,jobId:JOBS[1]}};assert.equal((await exchange(w.handler,await signed(w,second,{url:SELLER_CONTEXT_CHALLENGE_PATH}))).status,429);assert.deepEqual(effectState(w.effects()),effectState(before));
});
test('B25 a consumed presentation cannot authorize a new scope even after the start window',async t=>{
 const w=await world(t),input=await w.wire();await exchange(w.handler,input);w.advance(3600000);
 const body=JSON.parse(input.text);body.scope.jobId=JOBS[1];body.scope.generatedAt=w.now();const before=w.effects();
 assert.equal((await exchange(w.handler,await signed(w,body))).status,409);assert.deepEqual(effectState(w.effects()),effectState(before));
});

test('B26 legacy completed nonces keep the maximum request lifetime before reclamation',async t=>{
 const w=await world(t,{maxRecords:1});await exchange(w.handler,await w.wire());
 const db=new DatabaseSync(w.path);db.exec('DELETE FROM peer_nonce_retention');db.close();
 const reopened=createSellerTransportStore({path:w.path,maxRecords:1,maxContextRecords:10000,now:w.now});t.after(()=>reopened.close());
 let input=await w.wire({actor:w.other,jobId:JOBS[1]});await assert.rejects(w.route.reserve(w.auth.readRequest(input.header),JSON.parse(input.text),reopened),{code:'peer_store_capacity'});
 w.advance(60000);input=await w.wire({actor:w.other,jobId:JOBS[1]});assert.equal((await w.route.reserve(w.auth.readRequest(input.header),JSON.parse(input.text),reopened)).disposition,'perform');assert.equal(nonceCount(w),1);
});
test('B27 a mismatched attempt consumes its issued challenge and cannot probe it again',async t=>{
 const w=await world(t),input=await w.wire(),body=JSON.parse(input.text),bad=structuredClone(body);bad.scope.generatedAt++;
 assert.equal(JSON.parse((await exchange(w.handler,await signed(w,bad))).text).error,'context_challenge_mismatch');
 assert.equal(JSON.parse((await exchange(w.handler,input)).text).error,'context_challenge_consumed');assert.equal(w.effects().writes,0);
});
test('B28 over-limit challenge issuance performs no SQL mutation and holds no policy capacity',async t=>{
 const w=await world(t);await exchange(w.handler,await w.wire());const first=JSON.parse((await w.wire()).text),body={scope:{...sellerContextChallengeScope(first.scope),jobId:JOBS[1]}};
 const original=DatabaseSync.prototype.prepare,mutations=[];
 DatabaseSync.prototype.prepare=function(sql){if(/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql))mutations.push(sql);return original.call(this,sql)};
 try{
  const before=w.effects(),out=await exchange(w.handler,await signed(w,body,{url:SELLER_CONTEXT_CHALLENGE_PATH}));assert.equal(out.status,429);assert.deepEqual(effectState(w.effects()),effectState(before));assert.deepEqual(mutations,[]);
 }finally{DatabaseSync.prototype.prepare=original;}
});
test('B29 a journal reservation conflict creates no policy hold',async t=>{
 const w=await world(t),input=await w.wire(),request=w.auth.readRequest(input.header),body=JSON.parse(input.text),original=w.store.reserve;
 const {createSellerContextAdmission,parsePolicyLedger}=await import('../src/devnet-demo/operator-approval.mjs');
 const evidencePath=join(tmpdir(),'d5-race-'+randomBytes(16).toString('hex')+'.jsonl');t.after(()=>rm(evidencePath,{force:true}));
 const policy=createSellerContextAdmission({evidencePath,sellerApproval:{mode:'policy'},now:w.now});
 const route=createSellerContextRoute({listing:w.listing,resolveBuyer:()=>assert.fail('provider ran'),assertBuyerAccess:()=>{},admitWrites:policy.reserve,releaseWrites:policy.release,writable:()=>true,recover:async()=>null,now:w.now});
 w.store.reserve=(...args)=>{if(!args[2]?.dryRun)throw new Error('fixture capacity changed after dry check');return original.apply(w.store,args)};
 await assert.rejects(route.reserve(request,body,w.store),/capacity changed/);
 await assert.rejects(readFile(evidencePath,'utf8'),{code:'ENOENT'});assert.equal(w.effects().writes,0);assert.equal(w.effects().counts.peer_effects,0);
});

test('B30 an expired delegated session cannot issue a new durable challenge',async t=>{
 const w=await world(t),session=key(),input=await w.wire(),body={scope:{...sellerContextChallengeScope(JSON.parse(input.text).scope),jobId:JOBS[1]}},payload={version:'1',kind:'seller-session-delegation',buyer:w.buyer.claim,sessionPublicKey:session.claim.slice(16),seller:w.seller.claim,listingPin:w.pin,jobId:JOBS[1],notBefore:T-1000,expiresAt:T-1};
 const {sellerSessionDelegationSigningBytes}=await import('../src/dacs/seller-transport-auth.mjs');
 const delegation={payload,signature:w.buyer.sign(sellerSessionDelegationSigningBytes(payload)).toString('base64url')},auth=createSellerTransportServerAuth({sellerSigner:w.seller,listingPin:w.pin,store:w.store,requireDelegation:true,now:w.now});
 const handler=createSellerHttpHandler({claim:w.seller.claim,listingPin:w.pin,transportAgreementOf:()=>null},{authentication:auth,context:w.route});
 const client=createSellerTransportClientAuth({sessionSigner:session,delegation,seller:w.seller.claim,resolveJob:()=>({listingPin:w.pin,agreementHash:sellerContextScopeHash(body.scope)}),now:w.now}),text=JSON.stringify(body),header=(await client.request(SELLER_CONTEXT_CHALLENGE_PATH,body,text)).header,before=w.effects();
 assert.equal(JSON.parse((await exchange(handler,{text,header,url:SELLER_CONTEXT_CHALLENGE_PATH})).text).error,'peer_delegation_expired');assert.deepEqual(effectState(w.effects()),effectState(before));
});
test('B31 the context client preserves a definite non-pass decision and attribution',async()=>{
 const {createSellerContextClient}=await import('../src/dacs/seller-context-route.mjs');
 const buyer=key(),bundle=bundleFor(buyer),scope={source:'d5-test-context/v1',wallet:'0x'+buyer.claim.slice(16),jobId:JOBS[0],buyer:buyer.claim,buyerBundleHash:identityBundleHash(bundle),seller:key().claim,listingPin:{listingId:'D5',version:1,contentHash:'b'.repeat(64)},rail:{railId:'demos-native:DEM',railVersion:1},payee:'fixture',price:{amount:'1',currency:'DEM'},generatedAt:T};
 const client=createSellerContextClient({clientFor:()=>({agreementContext:async()=>({disposition:'rejected',code:'party_vet_non_pass',errorClass:'counterparty',reason:'seller Vet decision: fail'})})});
 const answer=await client.resolveBuyer({scope,buyerIdentityBundle:bundle},{operation:{state:{protocol:{sellerContextRequest:{generatedAt:T,buyerBundle:bundle}}}}});assert.equal(answer.disposition,'rejected');assert.equal(answer.code,'party_vet_non_pass');assert.equal(answer.errorClass,'counterparty');assert.match(answer.reason,/seller Vet decision: fail/);
});

test('B32 another buyer consumes the issued challenge before mismatch refusal',async t=>{
 const w=await world(t),input=await w.wire(),body=JSON.parse(input.text),nonce=body.buyerIdentityBundle.sessionNonce;
 assert.throws(()=>w.store.attemptContextPresentation({jobId:JOBS[1],buyer:w.other.claim},{scope:body.scope,buyerIdentityBundle:{sessionNonce:nonce}}),{code:'context_challenge_mismatch'});
 const replay=await exchange(w.handler,input);assert.equal(replay.status,409);assert.equal(JSON.parse(replay.text).error,'context_challenge_consumed');
});
test('B33 every malformed challenge value is a definite refusal before policy or journal effects',async t=>{
 const w=await world(t),input=await w.wire();
 for(const value of [{},['x'],7,null,'A'.repeat(64),'a'.repeat(63)]){
  const body=JSON.parse(input.text);body.buyerIdentityBundle.sessionNonce=value;body.scope.buyerBundleHash=identityBundleHash(body.buyerIdentityBundle);
  const before=w.effects(),out=await exchange(w.handler,await signed(w,body));assert.equal(out.status,409);assert.equal(JSON.parse(out.text).error,'context_challenge_mismatch');assert.deepEqual(effectState(w.effects()),effectState(before));
 }
 assert.equal((await exchange(w.handler,input)).status,200,'malformed values did not consume the real challenge');
});
test('B34 closed buyer challenge requests are definite refusals without writes',async t=>{
 const w=await world(t,{assertBuyerAccess:()=>{throw Object.assign(new Error('closed'),{code:'buyer_access_closed'})}}),input=await w.wire(),body={scope:sellerContextChallengeScope(JSON.parse(input.text).scope)},before=w.effects();
 const out=await exchange(w.handler,await signed(w,body,{url:SELLER_CONTEXT_CHALLENGE_PATH}));assert.equal(out.status,409);assert.equal(JSON.parse(out.text).error,'buyer_access_closed');assert.deepEqual(effectState(w.effects()),effectState(before));
});
test('B35 HTTP and retained recovery preserve every Vet fault class; malformed classes stay indeterminate at the client',async t=>{
 const {createSellerContextClient}=await import('../src/dacs/seller-context-route.mjs');
 for(const errorClass of ['counterparty','permanent'])for(const recovery of [false,true]){
  const answer={disposition:'rejected',code:'party_vet_non_pass',errorClass,reason:'buyer Vet decision: '+(errorClass==='counterparty'?'fail':'error')};
  const w=await world(t,{perform:async()=>{if(recovery)throw new Error('lost answer');return answer},recover:async()=>answer}),input=await w.wire();
  const first=await exchange(w.handler,input);assert.equal(first.status,recovery?503:200);
  const retained=await exchange(w.handler,input);assert.equal(retained.status,200);assert.deepEqual(JSON.parse(retained.text),answer);
  const body=JSON.parse(input.text),operation={state:{protocol:{sellerContextRequest:{generatedAt:body.scope.generatedAt,buyerBundle:body.buyerIdentityBundle}}}};
  const consume=async response=>createSellerContextClient({clientFor:()=>({agreementContext:async()=>response})}).resolveBuyer(body,{operation});
  const consumed=await consume(JSON.parse(retained.text));assert.equal(consumed.disposition,'rejected');assert.equal(consumed.errorClass,errorClass);
  for(const errorClass of [undefined,'transient','unknown',null]){
   const invalid={...answer,errorClass};if(errorClass===undefined)delete invalid.errorClass;
   const result=await consume(invalid);assert.equal(result.disposition,'indeterminate');assert.equal(result.code,undefined);
  }
 }
});

test('B36 total context capacity consumes an attempted presentation but refuses before holds or new effects',async t=>{
 const w=await world(t,{maxContextRecords:1,limits:{maxStartsPerHour:100,maxStartsPerBuyerPerHour:100}});
 const next=await w.wire({jobId:JOBS[1],actor:w.other});
 assert.equal((await exchange(w.handler,await w.wire())).status,200);
 const before=w.effects(),result=await exchange(w.handler,next);
 assert.equal(result.status,503);assert.equal(JSON.parse(result.text).error,'peer_context_capacity');
 assert.deepEqual(effectState(w.effects()),effectState(before));
 const body=JSON.parse(next.text),db=new DatabaseSync(w.path,{readonly:true});
 try{assert.equal(db.prepare('SELECT attempted FROM peer_context_challenges WHERE nonce = ?').get(body.buyerIdentityBundle.sessionNonce).attempted,1);}finally{db.close();}
 const scope=sellerContextChallengeScope({...body.scope,generatedAt:w.now()});
 const challengeBody={scope},challengeText=JSON.stringify(challengeBody);
 const challengeClient=createSellerTransportClientAuth({buyerSigner:w.other,seller:w.seller.claim,resolveJob:()=>({listingPin:w.pin,agreementHash:sellerContextScopeHash(scope)}),now:w.now});
 const challenge=await challengeClient.request(SELLER_CONTEXT_CHALLENGE_PATH,challengeBody,challengeText);
 const denied=await exchange(w.handler,{url:SELLER_CONTEXT_CHALLENGE_PATH,text:challengeText,header:challenge.header});
 assert.equal(denied.status,503);assert.equal(JSON.parse(denied.text).error,'peer_context_capacity');assert.deepEqual(effectState(w.effects()),effectState(before));
});


test('B37 an authenticated malformed context consumes its recognized nonce before transport scope validation',async t=>{
 const w=await world(t),input=await w.wire(),body=JSON.parse(input.text),nonce=body.buyerIdentityBundle.sessionNonce;
 body.unexpected=true;
 const response=await exchange(w.handler,await signed(w,body));assert.equal(response.status,409);
 const db=new DatabaseSync(w.path,{readonly:true});try{assert.equal(db.prepare('SELECT attempted FROM peer_context_challenges WHERE nonce=?').get(nonce).attempted,1);}finally{db.close();}
 const replay=await exchange(w.handler,input);assert.equal(replay.status,409);assert.equal(JSON.parse(replay.text).error,'context_challenge_consumed');
});


test('context presentation signatures use canonical Ed25519 Base64URL before reserving Vet writes', async t => {
 for (const mutate of [s => s + '=', s => ' ' + s, s => Buffer.from(s, 'base64url').toString('hex'), s => s.slice(0, -1) + String.fromCharCode(s.charCodeAt(s.length - 1) + 1)]) {
  const w = await world(t), input = await w.wire(), body = JSON.parse(input.text);
  const valid = body.buyerIdentityBundle.presentation.signatures[0].signature;
  body.buyerIdentityBundle.presentation.signatures[0].signature = mutate(valid);
  const before = w.effects(), out = await exchange(w.handler, await signed(w, body));
  assert.equal(out.status, 409, out.text);
  assert.equal(JSON.parse(out.text).error, 'buyer_bundle_unauthenticated');
  assert.deepEqual(effectState(w.effects()), effectState(before), 'no policy holds or Vet provider writes');
 }
 const w = await world(t), input = await w.wire();
 assert.equal((await exchange(w.handler, input)).status, 200, 'canonical signed presentation remains allowed');
 assert.equal(w.effects().writes, 1);
});

const effectState=({releases,...value})=>({...value,counts:Object.fromEntries(Object.entries(value.counts).filter(([key])=>!['peer_nonces','peer_nonce_retention'].includes(key)))});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('identical retry during admission cannot report no writes while the first request proceeds',async t=>{
 const entered=deferred(),resume=deferred(),retryEntered=deferred();const w=await world(t,{admitWrites:async()=>{entered.resolve();await resume.promise;return null;}}),input=await w.wire();let attempts=0;
 const context={...w.route,reserve(...args){if(++attempts===2)retryEntered.resolve();return w.route.reserve(...args);}};
 const handler=createSellerHttpHandler({claim:w.seller.claim,listingPin:w.pin},{authentication:w.auth,context});
 const first=exchange(handler,input);await entered.promise;const retry=exchange(handler,input);await retryEntered.promise;await Promise.resolve();resume.resolve();const answers=await Promise.all([first,retry]);
 assert.equal(answers[0].status,200);assert.ok(answers[1].status===200||answers[1].status===503,answers[1].text);assert.equal(w.effects().writes,1);assert.equal(w.effects().holds,1);
});
for(const missing of ['admitWrites','releaseWrites','writable','recover'])test(`context construction requires ${missing} before provider work`,async t=>{
 const w=await world(t),callbacks={listing:w.listing,resolveBuyer:()=>assert.fail('provider'),assertBuyerAccess:()=>{},admitWrites:async()=>null,releaseWrites:async()=>{},writable:()=>true,recover:async()=>null};delete callbacks[missing];assert.throws(()=>createSellerContextRoute(callbacks),TypeError);
});
test('provider sees the active purchase guard before each write and after cancellation',async t=>{
 let open=true;const decisions=[];const w=await world(t,{writable:()=>open,perform:async(body,options)=>{decisions.push(options?.writable?.());open=false;decisions.push(options?.writable?.());return {disposition:'rejected'};}});
 await exchange(w.handler,await w.wire());assert.deepEqual(decisions,[true,false]);
});
test('an asynchronous buyer access refusal stops a start before any hold or write',async t=>{
 const w=await world(t,{assertBuyerAccess:async()=>{throw Object.assign(new Error('closed'),{code:'buyer_access_closed'})}}),before=w.effects();
 const out=await exchange(w.handler,await w.wire());assert.equal(out.status,409);assert.equal(JSON.parse(out.text).error,'buyer_access_closed');assert.deepEqual(effectState(w.effects()),effectState(before));
});
test('a saved present answer is not repeated once its Vet records no longer verify',async t=>{
 let verified=true;const w=await world(t,{recover:async body=>verified?presentContext(body):null}),input=await w.wire();
 assert.equal((await exchange(w.handler,input)).status,200);const before=w.effects();verified=false;
 const replay=await exchange(w.handler,input);assert.equal(replay.status,503);assert.equal(JSON.parse(replay.text).error,'operation_uncertain');assert.deepEqual(effectState(w.effects()),effectState(before));
 verified=true;assert.equal((await exchange(w.handler,input)).status,200);
});
