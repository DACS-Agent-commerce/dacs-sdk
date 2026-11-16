import { admitFixtureFor } from './helpers/challenge-api.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {world,T,JOBS} from './helpers/d5-http-fixture.mjs';
const {sellerContextScopeHash}=await import('../src/dacs/seller-transport-auth.mjs');
const {proposalTimeProblem}=await import('../src/dacs/seller-proposal-time.mjs');

test('R1 only the exact admitted request extends proposal time, and the Agreement deadline remains exclusive',async t=>{
 const w=await world(t),input=await w.wire(),body=JSON.parse(input.text),request=w.auth.readRequest(input.header);
 const {createSellerContextRecords}=await import('../src/dacs/seller-context-route.mjs');
 // The old store's admission row, shaped as K1's admission row the records read.
 const admission=jobId=>{const old=w.store.contextAdmission(jobId);return old&&{jobId,buyer:old.buyer,seller:old.seller,listingPin:old.listingPin,contextScopeHash:old.scopeHash,state:'admitted'};};
 const records=createSellerContextRecords({listing:w.listing,admission,contextOutcome:()=>null});
 // Actual admission record and exact-request predicate, then the helper used by the agent.
 const reservation=await w.route.reserve(request,body,w.store);assert.equal(reservation.disposition,'perform');
 const exact={jobId:JOBS[0],buyerBundle:body.buyerIdentityBundle,generatedAt:T};assert.equal(records.exactRequest(exact),true);
 const observedAt=T+600001,deadlineSecAfterCommit=1200;
 assert.equal(proposalTimeProblem({generatedAt:T,observedAt,deadlineSecAfterCommit,admitted:records.exactRequest(exact)}),null);
 for(const changed of [{...exact,generatedAt:T+1},{...exact,buyerBundle:{...exact.buyerBundle,sessionNonce:'f'.repeat(64)}}]){
  assert.equal(records.exactRequest(changed),false);assert.match(proposalTimeProblem({generatedAt:T,observedAt,deadlineSecAfterCommit,admitted:records.exactRequest(changed)}),/clock window/);
 }
 assert.match(proposalTimeProblem({generatedAt:T,observedAt:T+1200000,deadlineSecAfterCommit,admitted:true}),/deadline/);
});


test('final cached replay retries a failed release, while uncertain replay preserves the hold',async t=>{
 const {createSellerContextRoute}=await import('../src/dacs/seller-context-route.mjs');
 const {createSellerContextAdmission,parsePolicyLedger}=await import('../src/devnet-demo/operator-approval.mjs');
 const w=await world(t),input=await w.wire(),body=JSON.parse(input.text),request=w.auth.readRequest(input.header);
 const path=join(w.path+'-policy.jsonl');t.after(()=>rm(path,{force:true}));
 const policy=createSellerContextAdmission({evidencePath:path,sellerApproval:{mode:'policy',maxWritesPerHour:2,maxTotalOsPerHour:'8',maxWriteTotalOs:'4'},now:()=>T});
 let fail=true,releases=0;
 const route=createSellerContextRoute({admitPresentation:admitFixtureFor(w.listing),listing:w.listing,resolveBuyer:async()=>({disposition:'rejected'}),assertBuyerAccess:()=>{},writable:()=>true,admitWrites:policy.reserve,
  releaseWrites:async args=>{releases++;if(fail)throw new Error('TEST release unavailable');await policy.release(args);},recover:async()=>null,now:()=>T,log:()=>{}});
 const reserved=await route.reserve(request,body,w.store);
 assert.equal((await route.reserve(request,body,w.store)).disposition,'uncertain');assert.equal(releases,0);
 w.store.finish(reserved,200,JSON.stringify({disposition:'rejected'}),{noEffect:true});
 await route.settled(reserved.contextHold);fail=false;
 assert.equal((await route.reserve(request,body,w.store)).disposition,'cached');
 assert.equal(parsePolicyLedger(await (await import('node:fs/promises')).readFile(path,'utf8')).rows[0].released,true);
});

test('context client sends the same canonical bytes for reordered scope and bundle keys',async t=>{
 const {createSellerContextClient}=await import('../src/dacs/seller-context-route.mjs');
 const {canonicalize}=await import('@kynesyslabs/dacs');
 const w=await world(t),body=JSON.parse((await w.wire()).text),sent=[];
 const client=createSellerContextClient({clientFor:()=>({agreementContext:async value=>{sent.push(JSON.stringify(value));return {disposition:'indeterminate'};}})});
 const operation={state:{protocol:{sellerContextRequest:{scope:body.scope,buyerBundle:body.buyerIdentityBundle}}}};
 await client.resolveBuyer(body,{operation});
 const reverse=value=>Object.fromEntries(Object.entries(value).reverse());
 await client.resolveBuyer({scope:reverse(body.scope),buyerIdentityBundle:reverse(body.buyerIdentityBundle)},{operation});
 assert.deepEqual(sent,[canonicalize(body),canonicalize(body)]);
});

test('proved resume transfers unused budget after the journal assigns a new owner',async t=>{
 const {createSellerContextRoute}=await import('../src/dacs/seller-context-route.mjs');
 const {createSellerContextAdmission}=await import('../src/devnet-demo/operator-approval.mjs');
 const w=await world(t),body=JSON.parse((await w.wire()).text),request=w.auth.readRequest((await w.wire()).header);
 const path=w.path+'-resume.jsonl';t.after(()=>rm(path,{force:true}));
 const policy=createSellerContextAdmission({evidencePath:path,sellerApproval:{mode:'policy',maxWritesPerHour:2,maxTotalOsPerHour:'8',maxWriteTotalOs:'4'},now:()=>T});
 const route=createSellerContextRoute({admitPresentation:admitFixtureFor(w.listing),listing:w.listing,resolveBuyer:async()=>null,assertBuyerAccess:()=>{},writable:()=>true,admitWrites:policy.reserve,releaseWrites:policy.release,recover:async()=>null,now:()=>T});
 const first=await route.reserve(request,body,w.store);w.store.finish(first,503,'{}');
 const uncertain=w.store.reserve(request,body),resumed=await route.resume(uncertain,request,w.store,{writes:1});
 assert.equal(resumed.disposition,'perform');assert.match(resumed.contextHold.hold,new RegExp('^'+first.effectKey+':'));
});

// Only the request saved on the purchase is ever sent: the saved scope must be the
// exact scope the caller passes, whichever seller scope field differs.
const driftedScope = (w, body) => ({source: 'other-source/v1', wallet: '0x' + 'e'.repeat(64), jobId: JOBS[1], buyer: w.other.claim, buyerBundleHash: 'f'.repeat(64), seller: w.other.claim,
 listingPin: {...body.scope.listingPin, version: body.scope.listingPin.version + 1}, rail: {railId: 'other:RAIL', railVersion: 1}, payee: 'someone-else',
 price: {...body.scope.price, amount: '999'}, generatedAt: body.scope.generatedAt + 1});
for (const key of ['source', 'wallet', 'jobId', 'buyer', 'buyerBundleHash', 'seller', 'listingPin', 'rail', 'payee', 'price', 'generatedAt']) test(`context client sends nothing when the ${key} differs from the saved request`, async t => {
 const {createSellerContextClient} = await import('../src/dacs/seller-context-route.mjs');
 const w = await world(t), body = JSON.parse((await w.wire()).text); let built = 0, sent = 0;
 const client = createSellerContextClient({clientFor: () => { built++; return {agreementContext: async () => { sent++; return {disposition: 'indeterminate'}; }}; }});
 const operation = {state: {protocol: {sellerContextRequest: {scope: body.scope, buyerBundle: body.buyerIdentityBundle}}}};
 await assert.rejects(client.resolveBuyer({scope: {...body.scope, [key]: driftedScope(w, body)[key]}, buyerIdentityBundle: body.buyerIdentityBundle}, {operation}), /nothing was sent/);
 assert.equal(built + sent, 0);
});
test('context client refuses a saved request without its scope and sends nothing', async t => {
 const {createSellerContextClient} = await import('../src/dacs/seller-context-route.mjs');
 const w = await world(t), body = JSON.parse((await w.wire()).text); let sent = 0;
 const client = createSellerContextClient({clientFor: () => ({agreementContext: async () => { sent++; return {disposition: 'indeterminate'}; }})});
 const operation = {state: {protocol: {sellerContextRequest: {generatedAt: body.scope.generatedAt, buyerBundle: body.buyerIdentityBundle}}}};
 await assert.rejects(client.resolveBuyer(body, {operation}), /nothing was sent/);
 assert.equal(sent, 0);
});
test('context client keeps sending the saved bytes after an uncertain send and refuses a drifted retry', async t => {
 const {createSellerContextClient} = await import('../src/dacs/seller-context-route.mjs');
 const w = await world(t), body = JSON.parse((await w.wire()).text), sent = [], hashes = [];
 const client = createSellerContextClient({clientFor: (operation, hash) => { hashes.push(hash); return {agreementContext: async value => { sent.push(JSON.stringify(value)); throw new Error('TEST lost answer'); }}; }});
 const operation = {state: {protocol: {sellerContextRequest: {scope: body.scope, buyerBundle: body.buyerIdentityBundle}}}};
 assert.equal((await client.resolveBuyer(body, {operation})).disposition, 'indeterminate');
 await assert.rejects(client.resolveBuyer({scope: {...body.scope, payee: 'someone-else'}, buyerIdentityBundle: body.buyerIdentityBundle}, {operation}), /nothing was sent/);
 const reversed = Object.fromEntries(Object.entries(body.scope).reverse());
 assert.equal((await client.resolveBuyer({scope: reversed, buyerIdentityBundle: body.buyerIdentityBundle}, {operation})).disposition, 'indeterminate');
 assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]);
 assert.deepEqual(hashes, [sellerContextScopeHash(body.scope), sellerContextScopeHash(body.scope)]);
});
