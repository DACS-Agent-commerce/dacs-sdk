import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { admitFixtureFor } from './helpers/challenge-api.mjs';
import {join} from 'node:path';
import {dirname} from 'node:path';
import {readFile} from 'node:fs/promises';
import {world,JOBS,presentContext} from './helpers/d5-http-fixture.mjs';
import {createSellerContextRoute} from '../src/dacs/seller-context-route.mjs';
import {createSellerContextAdmission,parsePolicyLedger,withContextHolds} from '../src/devnet-demo/operator-approval.mjs';
const limits={maxStartsPerHour:100,maxStartsPerBuyerPerHour:100};
function rows(w,table){const db=new Database(w.path,{readonly:true});try{return db.prepare(`SELECT * FROM ${table}`).all()}finally{db.close()}}
for(const resumed of [false,true])test(`${resumed?'resumed':'fresh'} policy hold persisted before an exception is released before ownership is relinquished`,async t=>{
 const w=await world(t,{limits}),input=await w.wire(),request=w.auth.readRequest(input.header),body=JSON.parse(input.text);
 const evidencePath=join(dirname(w.path),'approval.jsonl'),config={evidencePath,sellerApproval:{mode:'policy',maxWriteTotalOs:'4',maxWritesPerHour:2,maxTotalOsPerHour:'8'},now:w.now};
 const admission=createSellerContextAdmission(config);let exactHold;
 const route=createSellerContextRoute({admitPresentation:admitFixtureFor(w.listing),listing:w.listing,resolveBuyer:presentContext,assertBuyerAccess:()=>{},knownJob:()=>true,writable:()=>true,now:w.now,limits,recover:async()=>null,
  admitWrites:async value=>{exactHold=value.hold;assert.equal(await admission.reserve(value),null);throw Object.assign(new Error('TEST post-append sync'),{code:'EIO'})},
  releaseWrites:async value=>{assert.equal(rows(w,'peer_effects')[0].state,exactHold?'pending':'uncertain');if(exactHold)assert.equal(value.hold,exactHold);await admission.release(value)} });
 if(resumed){const r=w.store.reserve(request,body,{admit:()=>w.now()});w.store.finish(r,503,'{}');await assert.rejects(route.resume(w.store.reserve(request,body),request,w.store,{writes:2}),{code:'EIO'});}
 else await assert.rejects(route.reserve(request,body,w.store),{code:'EIO'});
 const ledger=withContextHolds(parsePolicyLedger(await readFile(evidencePath,'utf8')).rows);
 assert.ok(ledger.every(row=>row.contextHold!==exactHold||row.released===true),JSON.stringify(ledger));
 assert.equal(rows(w,'peer_effects')[0]?.state,resumed?'uncertain':undefined);
 assert.equal(await admission.reserve({jobId:JOBS[1],effect:'b'.repeat(64),hold:'TEST next hold',writes:1}),null);
});
for(const verdict of ['buyer_access_closed','context_scope_invalid','context_job_unknown'])test(`${verdict} refusal keeps nonce storage bounded`,async t=>{
 const w=await world(t,{limits,maxRecords:1,assertBuyerAccess:()=>{if(verdict==='buyer_access_closed')throw Object.assign(new Error('TEST closed'),{code:verdict})},knownJob:()=>verdict!=='context_job_unknown'}),input=await w.wire(),request=w.auth.readRequest(input.header),body=JSON.parse(input.text);
 const invalid=structuredClone(body);if(verdict==='context_scope_invalid')invalid.scope.buyerBundleHash='invalid';
 await assert.rejects(w.route.reserve(request,invalid,w.store),{code:verdict});
 w.advance(60000);
 const next=await w.wire({jobId:JOBS[1]}),changed=JSON.parse(next.text);if(verdict==='context_scope_invalid')changed.scope.buyerBundleHash='invalid';
 await assert.rejects(w.route.reserve(w.auth.readRequest(next.header),changed,w.store),{code:verdict});
 for(const table of ['peer_nonces','peer_nonce_retention'])assert.equal(rows(w,table).length,0,table);
});
// A hold belongs to one journal owner. An attempt that ended 503 finishes its journal
// step and releases its hold as two steps, so a resume can start between them: the
// ended attempt must never free the hold of the attempt that resumed it.
async function ownedHoldWorld(t, options = {}, maxWritesPerHour = 2) {
 const w = await world(t, {limits, ...options}), input = await w.wire(), request = w.auth.readRequest(input.header), body = JSON.parse(input.text);
 const evidencePath = join(dirname(w.path), 'approval.jsonl');
 const admission = createSellerContextAdmission({evidencePath, sellerApproval: {mode: 'policy', maxWriteTotalOs: '4', maxWritesPerHour, maxTotalOsPerHour: String(4 * maxWritesPerHour)}, now: w.now});
 const open = async () => parsePolicyLedger(await readFile(evidencePath, 'utf8')).rows.filter(row => row.contextHold && !row.released).map(row => row.contextHold);
 const otherJob = {jobId: JOBS[1], effect: 'b'.repeat(64), hold: 'TEST other job', writes: 2};
 return {w, input, request, body, admission, open, otherJob};
}
const policyRoute = (s, releaseWrites = s.admission.release) => createSellerContextRoute({admitPresentation: admitFixtureFor(s.w.listing), listing: s.w.listing, resolveBuyer: presentContext, assertBuyerAccess: () => {}, knownJob: () => true, writable: () => true,
 now: s.w.now, limits, recover: async () => null, admitWrites: s.admission.reserve, releaseWrites, log: () => {}});
test('a late settle of an ended attempt leaves the hold of the attempt that resumed it open, through a chain of resumes', async t => {
 const s = await ownedHoldWorld(t), route = policyRoute(s), {store} = s.w;
 const first = await route.reserve(s.request, s.body, store); store.finish(first, 503, '{}');
 const second = await route.resume(store.reserve(s.request, s.body), s.request, store, {writes: 2});
 await route.settled(first.contextHold);
 assert.deepEqual(await s.open(), [second.contextHold.hold]);
 assert.equal(await s.admission.reserve(s.otherJob), 'hourly-write-limit');
 store.finish(second, 503, '{}');
 const third = await route.resume(store.reserve(s.request, s.body), s.request, store, {writes: 2});
 await route.settled(first.contextHold); await route.settled(second.contextHold);
 assert.deepEqual(await s.open(), [third.contextHold.hold]);
 assert.equal(await s.admission.reserve(s.otherJob), 'hourly-write-limit');
 await route.settled(third.contextHold);
 assert.deepEqual(await s.open(), []);
 assert.equal(await s.admission.reserve(s.otherJob), null);
});
test('a failed release of an ended attempt is retried by the resume for that attempt only', async t => {
 let fail = true;
 const s = await ownedHoldWorld(t, {}, 4), route = policyRoute(s, async input => { if (fail) throw new Error('TEST release unavailable'); await s.admission.release(input); }), {store} = s.w;
 assert.equal(await s.admission.reserve({...s.otherJob, writes: 1}), null);
 const first = await route.reserve(s.request, s.body, store); store.finish(first, 503, '{}');
 await route.settled(first.contextHold);
 assert.deepEqual(await s.open(), [s.otherJob.hold, first.contextHold.hold]);
 fail = false;
 const second = await route.resume(store.reserve(s.request, s.body), s.request, store, {writes: 1});
 assert.deepEqual(await s.open(), [s.otherJob.hold, second.contextHold.hold]);
});
test('a resume whose release of the previous hold fails leaves the journal owner unchanged, and a retry releases that hold', async t => {
 let failNext = false;
 const s = await ownedHoldWorld(t, {}, 4), {store} = s.w;
 const route = policyRoute(s, async input => { if (failNext) { failNext = false; throw new Error('TEST release unavailable'); } await s.admission.release(input); });
 const first = await route.reserve(s.request, s.body, store); store.finish(first, 503, '{}');
 failNext = true;
 assert.equal(await route.resume(store.reserve(s.request, s.body), s.request, store, {writes: 1}), null);
 assert.deepEqual(await s.open(), [first.contextHold.hold]);
 const retained = store.reserve(s.request, s.body);
 assert.deepEqual([retained.disposition, retained.owner], ['uncertain', first.owner]);
 const second = await route.resume(retained, s.request, store, {writes: 1});
 assert.deepEqual(await s.open(), [second.contextHold.hold]);
 store.finish(second, 503, '{}');
 const third = await route.resume(store.reserve(s.request, s.body), s.request, store, {writes: 1});
 assert.deepEqual(await s.open(), [third.contextHold.hold]);
});