import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {key} from './helpers/d5-http-fixture.mjs';
const {createSellerDurableState}=await import('../src/dacs/seller-durable-state.mjs');
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX'];
for(const jobs of [JOBS,[...JOBS].reverse()])test(`SB-2 collision suspends both jobs in order ${jobs.join(',')}, including restart`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'seller-collision-')),signer=key(),listingPin={listingId:'collision',version:1,contentHash:'a'.repeat(64)};
 let store=await createSellerDurableState({dir,signer,listingPin});
 try{
  store.retainContext({admittedAt:1800000000000,validation:{disposition:'verified'}});
  assert.equal(await store.withJob(jobs[0],()=>store.bindSettlement('demos:one-tx',jobs[0],{phaseIndex:0,jobId:jobs[0],evidenceHash:'b'.repeat(64)})),true);
  assert.equal(store.settlementJob('demos:one-tx'),jobs[0]);
  assert.equal(await store.withJob(jobs[1],()=>store.bindSettlement('demos:one-tx',jobs[1],{phaseIndex:0,jobId:jobs[1],evidenceHash:'c'.repeat(64)})),false);
  for(const jobId of jobs)assert.equal(await store.withJob(jobId,()=>store.bindSettlement('demos:one-tx',jobId)),false);
  assert.equal(store.settlementJob('demos:one-tx'),null);store.close();store=null;store=await createSellerDurableState({dir,signer,listingPin});
  assert.equal(store.settlementJob('demos:one-tx'),null);
  for(const jobId of jobs)assert.equal(await store.withJob(jobId,()=>store.bindSettlement('demos:one-tx',jobId)),false);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});


