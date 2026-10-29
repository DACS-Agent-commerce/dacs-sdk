import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {join} from 'node:path';
import {dirname} from 'node:path';
import {readFile} from 'node:fs/promises';
import {identityBundleHash} from '@kynesyslabs/dacs';
import {world,JOBS,exchange,presentContext} from './helpers/d5-http-fixture.mjs';
import {createSellerTransportStore,createSellerTransportClientAuth,SELLER_CONTEXT_PATH,sellerContextScopeHash} from '../src/dacs/seller-transport-auth.mjs';
import {createSellerContextRoute} from '../src/dacs/seller-context-route.mjs';
import {createSellerContextAdmission,releaseSellerContextHolds,parsePolicyLedger,withContextHolds,heldPolicyBudget} from '../src/devnet-demo/operator-approval.mjs';
const limits={maxStartsPerHour:100,maxStartsPerBuyerPerHour:100};
function rows(w,table){const db=new Database(w.path,{readonly:true});try{return db.prepare(`SELECT * FROM ${table}`).all()}finally{db.close()}}
async function signed(w,body){
 body.scope.buyerBundleHash=identityBundleHash(body.buyerIdentityBundle);
 body.buyerIdentityBundle.presentation.signatures[0].signature=w.buyer.sign(Buffer.from('dacs-bundle-presentation:v1:'+body.scope.buyerBundleHash)).toString('base64url');
 const text=JSON.stringify(body),client=createSellerTransportClientAuth({buyerSigner:w.buyer,seller:w.seller.claim,resolveJob:()=>({listingPin:w.pin,agreementHash:sellerContextScopeHash(body.scope)}),now:w.now});
 return {text,header:(await client.request(SELLER_CONTEXT_PATH,body,text)).header};
}
for(const sync of [false,true])test(`fresh ${sync?'synchronous':'asynchronous'} policy exception releases its own reservation and preserves nonce/challenge answers`,async t=>{
 let fail=true;
 const callback=sync?()=>{if(fail)throw Object.assign(new Error('TEST policy lock'),{code:'seller_state_locked'});return null}:async()=>{if(fail)throw Object.assign(new Error('TEST policy clock'),{code:'seller_clock_invalid'});return null};
 const w=await world(t,{limits,admitWrites:callback}),input=await w.wire();
 assert.equal((await exchange(w.handler,input)).status,503);
 for(const table of ['peer_effects','peer_context_admissions','peer_slots','peer_effect_jobs'])assert.equal(rows(w,table).length,0,table);
 assert.equal(w.effects().writes,0);assert.equal(rows(w,'peer_context_challenges')[0].attempted,1);
 assert.equal(rows(w,'peer_nonces')[0].status,503);
 fail=false;
 assert.equal((await exchange(w.handler,input)).status,503,'same nonce keeps its exact no-effect answer');
 const reopened=createSellerTransportStore({path:w.path,now:w.now});t.after(()=>reopened.close());
 const fresh=await w.wire({fresh:true}),reservation=await w.route.reserve(w.auth.readRequest(fresh.header),JSON.parse(fresh.text),reopened);
 assert.equal(reservation.disposition,'perform');assert.equal(w.effects().writes,0);
});
test('a resumed policy exception finishes the new owner as uncertain and permits later authenticated resume',async t=>{
 let calls=0;
 const w=await world(t,{limits,resumable:async()=>({writes:2}),perform:async()=>{throw new Error('TEST interrupted provider')},admitWrites:async()=>{if(++calls===2)throw new Error('TEST policy disk');return null}});
 const input=await w.wire();await exchange(w.handler,input);const old=rows(w,'peer_effects')[0];
 assert.equal(old.state,'uncertain');assert.equal((await exchange(w.handler,await w.wire())).status,503);
 const current=rows(w,'peer_effects')[0];assert.notEqual(current.owner,old.owner);assert.equal(current.state,'uncertain');
 assert.equal(rows(w,'peer_context_admissions').length,1);
 const reopened=createSellerTransportStore({path:w.path,now:w.now});t.after(()=>reopened.close());
 const retry=await w.wire(),request=w.auth.readRequest(retry.header),body=JSON.parse(retry.text),reservation=reopened.reserve(request,body);
 assert.equal((await w.route.resume(reservation,request,reopened,{writes:2})).disposition,'perform');assert.equal(calls,3);
});
for(const resumed of [false,true])test(`${resumed?'resumed':'fresh'} policy hold persisted before an exception is released before ownership is relinquished`,async t=>{
 const w=await world(t,{limits}),input=await w.wire(),request=w.auth.readRequest(input.header),body=JSON.parse(input.text);
 const evidencePath=join(dirname(w.path),'approval.jsonl'),config={evidencePath,sellerApproval:{mode:'policy',maxWriteTotalOs:'4',maxWritesPerHour:2,maxTotalOsPerHour:'8'},now:w.now};
 const admission=createSellerContextAdmission(config);let exactHold;
 const route=createSellerContextRoute({listing:w.listing,resolveBuyer:presentContext,assertBuyerAccess:()=>{},knownJob:()=>true,writable:()=>true,now:w.now,limits,recover:async()=>null,
  admitWrites:async value=>{exactHold=value.hold;assert.equal(await admission.reserve(value),null);throw Object.assign(new Error('TEST post-append sync'),{code:'EIO'})},
  releaseWrites:async value=>{assert.equal(rows(w,'peer_effects')[0].state,'pending');if(exactHold)assert.equal(value.hold,exactHold);await admission.release(value)} });
 if(resumed){const r=w.store.reserve(request,body,{admit:()=>w.now()});w.store.finish(r,503,'{}');await assert.rejects(route.resume(w.store.reserve(request,body),request,w.store,{writes:2}),{code:'EIO'});}
 else await assert.rejects(route.reserve(request,body,w.store),{code:'EIO'});
 const ledger=withContextHolds(parsePolicyLedger(await readFile(evidencePath,'utf8')).rows);
 assert.ok(ledger.every(row=>row.contextHold!==exactHold||row.released===true),JSON.stringify(ledger));
 assert.equal(rows(w,'peer_effects')[0]?.state,resumed?'uncertain':undefined);
 assert.equal(await admission.reserve({jobId:JOBS[1],effect:'b'.repeat(64),hold:'TEST next hold',writes:1}),null);
});
test('a competing route cannot compensate a live owner; an admission exception then frees its only slot',async t=>{
 let entered,finish;
 const started=new Promise(r=>entered=r),blocked=new Promise((_,reject)=>finish=reject);
 const w=await world(t,{limits,maxContextRecords:1,admitWrites:()=>{entered();return blocked}});
 const input=await w.wire(),first=exchange(w.handler,input);await started;
 const reopened=createSellerTransportStore({path:w.path,maxContextRecords:1,now:w.now});t.after(()=>reopened.close());
 const request=w.auth.readRequest(input.header),body=JSON.parse(input.text),owner=rows(w,'peer_effects')[0];
 assert.equal((await w.route.reserve(request,body,reopened)).disposition,'uncertain');
 assert.deepEqual(rows(w,'peer_effects')[0],owner);assert.equal(w.effects().holds,1);
 finish(new Error('TEST interrupted admission'));await first;
 assert.equal(rows(w,'peer_effects').length,0);assert.equal(rows(w,'peer_context_admissions').length,0);
});
for(const step of [60000,60001])test(`unknown-challenge refusals reclaim both nonce tables every ${step} ms`,async t=>{
 const w=await world(t,{limits,maxRecords:1});
 for(let i=0;i<6;i++){
  const body=JSON.parse((await w.wire()).text);body.buyerIdentityBundle.sessionNonce='f'.repeat(64);
  const answer=await exchange(w.handler,await signed(w,body));assert.equal(JSON.parse(answer.text).error,'context_challenge_mismatch');
  for(const table of ['peer_nonces','peer_nonce_retention'])assert.equal(rows(w,table).length,1,table);
  w.advance(step);
 }
 assert.equal(w.effects().writes,0);
});
for(const verdict of ['buyer_access_closed','context_scope_invalid','context_job_unknown'])test(`${verdict} refusal reclaims expired nonce storage`,async t=>{
 const w=await world(t,{limits,maxRecords:1}),input=await w.wire(),request=w.auth.readRequest(input.header),body=JSON.parse(input.text);
 assert.throws(()=>w.store.reserve(request,body,{contextDecision:true,verdict,admit:()=>w.now()}),{code:verdict});
 w.advance(60000);
 const next=await w.wire({fresh:true}),p=w.auth.readRequest(next.header);
 assert.throws(()=>w.store.reserve(p,JSON.parse(next.text),{contextDecision:true,verdict,admit:()=>w.now()}),{code:verdict});
 for(const table of ['peer_nonces','peer_nonce_retention'])assert.equal(rows(w,table).length,1,table);
});
for(const mode of ['complete','retry','noEffect','pending','uncertain'])test(`context refusal reclaims expired ${mode} nonce storage while retaining unresolved work`,async t=>{
 const w=await world(t,{limits,maxRecords:mode==='pending'||mode==='uncertain'?2:1}),input=await w.wire();
 const p={...w.auth.readRequest(input.header),path:'/dacs/v1/agreements/proposals'},reservation=w.store.reserve(p,{});
 if(mode!=='pending')w.store.finish(reservation,mode==='uncertain'?503:200,'{}',mode==='retry'?{retry:true}:mode==='noEffect'?{noEffect:true}:{});
 w.advance(60000);
 for(let i=0;i<2;i++){
  const body=JSON.parse((await w.wire({fresh:true})).text);body.buyerIdentityBundle.sessionNonce='f'.repeat(64);
  assert.equal((await exchange(w.handler,await signed(w,body))).status,409);
  w.advance(60000);
 }
 const keep=mode==='pending'||mode==='uncertain';
 for(const table of ['peer_nonces','peer_nonce_retention'])assert.equal(rows(w,table).length,keep?2:1,table);
 if(keep)assert.equal(rows(w,'peer_effects')[0].state,mode);
});
for(const buyerLimit of [false,true])test(`${buyerLimit?'buyer':'global'} start-limit refusal reclaims a prior completed nonce`,async t=>{
 const w=await world(t,{maxRecords:1,limits:{maxStartsPerHour:buyerLimit?10:1,maxStartsPerBuyerPerHour:buyerLimit?1:10}});
 await exchange(w.handler,await w.wire());w.advance(60000);
 const next=await w.wire({jobId:JOBS[1]}),p=w.auth.readRequest(next.header),body=JSON.parse(next.text);
 assert.throws(()=>w.store.reserve(p,body,{contextDecision:true,admit:()=>{throw Object.assign(new Error('TEST limit'),{code:buyerLimit?'buyer_unpaid_start_limit':'unpaid_start_limit'})}}),{code:buyerLimit?'buyer_unpaid_start_limit':'unpaid_start_limit'});
 for(const table of ['peer_nonces','peer_nonce_retention'])assert.equal(rows(w,table).length,1,table);
 assert.equal(rows(w,'peer_context_admissions').length,1);
});

for (const sync of [false, true]) test(`a ${sync ? 'synchronous' : 'asynchronous'} provider exception releases unused policy capacity but keeps its effect uncertain`, async t => {
 let admission;
 const fail = () => { throw new Error('TEST provider stopped before a write'); };
 const w = await world(t, {limits, perform: sync ? fail : async () => fail(),
  admitWrites: input => admission.reserve(input), releaseWrites: input => admission.release(input)});
 const evidencePath = join(dirname(w.path), 'approval.jsonl');
 admission = createSellerContextAdmission({evidencePath, sellerApproval: {mode: 'policy', maxWriteTotalOs: '4', maxWritesPerHour: 2, maxTotalOsPerHour: '8'}, now: w.now});
 const input = await w.wire();
 assert.equal((await exchange(w.handler, input)).status, 503);
 assert.equal(heldPolicyBudget(withContextHolds(parsePolicyLedger(await readFile(evidencePath, 'utf8')).rows), w.now()).writes, 0);
 assert.equal(rows(w, 'peer_effects')[0].state, 'uncertain');
 assert.equal((await exchange(w.handler, await w.wire())).status, 503);
 assert.equal(w.effects().writes, 1, 'uncertain retry does not invoke the provider again');
 w.advance(2 * 3600000);
 assert.equal(await admission.reserve({jobId: JOBS[1], effect: 'b'.repeat(64), hold: 'TEST next hold', writes: 2}), null);
});

test('an exceptional resumed provider releases its fresh unused hold', async t => {
 const w = await world(t, {limits, resumable: async () => ({writes: 2}), perform: async () => {throw new Error('TEST stopped provider');}});
 assert.equal((await exchange(w.handler, await w.wire())).status, 503);
 assert.equal(w.effects().releases, 1);
 assert.equal((await exchange(w.handler, await w.wire())).status, 503);
 assert.equal(w.effects().writes, 2);
 assert.equal(w.effects().releases, 3, 'old hold and both finished attempts are released');
 assert.equal(rows(w, 'peer_effects')[0].state, 'uncertain');
});
