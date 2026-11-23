import test from 'node:test';
import assert from 'node:assert/strict';
import {world,T,JOBS} from './helpers/d5-http-fixture.mjs';
const {proposalTimeProblem}=await import('../src/dacs/seller-proposal-time.mjs');

test('R1 only the exact admitted request extends proposal time, and the Agreement deadline remains exclusive',async t=>{
 const w=await world(t),input=await w.wire(),body=JSON.parse(input.text),request=input.request;
 const {createSellerContextRecords}=await import('../src/dacs/seller-context-route.mjs');
 // The admission row the records read, for the request's own job, buyer, Listing and scope.
 const row={jobId:request.jobId,buyer:request.buyer,seller:request.seller,listingPin:request.listingPin,contextScopeHash:request.agreementHash,state:'admitted'};
 const records=createSellerContextRecords({listing:w.listing,admission:jobId=>jobId===request.jobId?row:null,contextOutcome:()=>null});
 // The exact-request predicate over that row, then the helper used by the agent.
 const exact={jobId:JOBS[0],buyerBundle:body.buyerIdentityBundle,generatedAt:T};assert.equal(records.exactRequest(exact),true);
 const observedAt=T+600001,deadlineSecAfterCommit=1200;
 assert.equal(proposalTimeProblem({generatedAt:T,observedAt,deadlineSecAfterCommit,admitted:records.exactRequest(exact)}),null);
 for(const changed of [{...exact,generatedAt:T+1},{...exact,buyerBundle:{...exact.buyerBundle,sessionNonce:'f'.repeat(64)}}]){
  assert.equal(records.exactRequest(changed),false);assert.match(proposalTimeProblem({generatedAt:T,observedAt,deadlineSecAfterCommit,admitted:records.exactRequest(changed)}),/clock window/);
 }
 assert.match(proposalTimeProblem({generatedAt:T,observedAt:T+1200000,deadlineSecAfterCommit,admitted:true}),/deadline/);
});
