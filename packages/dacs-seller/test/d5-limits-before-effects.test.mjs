import test from 'node:test';
import assert from 'node:assert/strict';
import {JOBS,T,world} from './helpers/d5-http-fixture.mjs';

test('context records refuse malformed IDs before store, policy, Vet or readback callbacks',async t=>{
 const w=await world(t),input=await w.wire(),original=JSON.parse(input.text);
 for(const jobId of [undefined,null,7,'job-0',JOBS[0].toLowerCase(),JOBS[0].slice(1),'8'+JOBS[0].slice(1)]){
 const body={...original,scope:{...original.scope,jobId}},before=w.counts();
  const {createSellerContextRecords}=await import('../src/dacs/seller-context-route.mjs');
  const records=createSellerContextRecords({listing:w.listing,admission:()=>assert.fail('records read an admission for a malformed job'),contextOutcome:()=>assert.fail('records read an outcome for a malformed job')});
  assert.throws(()=>records.exactRequest({jobId,buyerBundle:body.buyerIdentityBundle,generatedAt:T}),{code:'peer_job_invalid'});
  assert.throws(()=>records.completedScope({jobId,buyer:w.buyer.claim}),{code:'peer_job_invalid'});
  assert.deepEqual(w.counts(),before);
 }
});
