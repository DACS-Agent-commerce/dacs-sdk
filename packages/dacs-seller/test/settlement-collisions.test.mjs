import './helpers/d5-isolated-dependencies.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {key} from './helpers/d5-http-fixture.mjs';
const {createSellerDurableState}=await import('../src/dacs/seller-durable-state.mjs');
const JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX'];
for(const jobs of [JOBS,[...JOBS].reverse()])test(`SB-2 collision suspends both jobs in order ${jobs.join(',')}, including restart`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'seller-collision-')),signer=key(),listingPin={listingId:'collision',version:1,contentHash:'a'.repeat(64)};
 let store=await createSellerDurableState({dir,signer,listingPin});
 try{
  store.retainContext({admittedAt:1800000000000,validation:{disposition:'verified'}});
  assert.equal(await store.withJob(jobs[0],()=>store.bindSettlement('demos:one-tx',jobs[0],{jobId:jobs[0],evidenceHash:'b'.repeat(64)})),true);
  assert.equal(store.settlementJob('demos:one-tx'),jobs[0]);
  assert.equal(await store.withJob(jobs[1],()=>store.bindSettlement('demos:one-tx',jobs[1],{jobId:jobs[1],evidenceHash:'c'.repeat(64)})),false);
  for(const jobId of jobs)assert.equal(await store.withJob(jobId,()=>store.bindSettlement('demos:one-tx',jobId)),false);
  assert.equal(store.settlementJob('demos:one-tx'),null);store.close();store=null;store=await createSellerDurableState({dir,signer,listingPin});
  assert.equal(store.settlementJob('demos:one-tx'),null);
  for(const jobId of jobs)assert.equal(await store.withJob(jobId,()=>store.bindSettlement('demos:one-tx',jobId)),false);
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});


test('transport admits a competing payment to authenticated intake instead of electing the first sender',async()=>{
 const {createSellerTransportStore}=await import('../src/dacs/seller-transport-auth.mjs');
 const dir=mkdtempSync(join(tmpdir(),'transport-collision-')),store=createSellerTransportStore({path:join(dir,'transport.sqlite'),now:()=>1800000000000});
 const buyer=key().claim,seller=key().claim,listingPin={listingId:'collision',version:1,contentHash:'b'.repeat(64)};
 try{
  for(const [i,jobId] of JOBS.entries()){
   const request={jobId,buyer,seller,listingPin,agreementHash:'c'.repeat(64),nonce:String(i).repeat(32),expiresAt:1800000030000,method:'POST',path:'/dacs/v1/agreements/proposals',bodyHash:'d'.repeat(64)};
   const proposal=store.reserve(request,{});store.finish(proposal,200,'{}');
   const payment=store.reserve({...request,path:'/dacs/v1/payments',nonce:String(i+2).repeat(32)},{jobId,txHash:'e'.repeat(64),payerPayingKey:buyer});
   assert.equal(payment.disposition,'perform');store.finish(payment,200,'{}');
  }
 }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('cached delivered transport answer is revalidated before disclosure',async()=>{
 const {createSellerHttpHandler}=await import('../src/dacs/seller-http.mjs');const {exchange}=await import('./helpers/d5-http-fixture.mjs');
 const seller=key().claim,listingPin={listingId:'collision',version:1,contentHash:'b'.repeat(64)};
 const handler=createSellerHttpHandler({claim:seller,listingPin,assertSettlementCredit:()=>{throw new Error('credit suspended')}},{authentication:{seller,listingPin,readRequest:()=>({jobId:JOBS[0]}),validate:()=>{},responseHeader:()=> 'fixture',store:{reserve:()=>({disposition:'cached',status:200,text:'{"status":"delivered"}'})}}});
 const result=await exchange(handler,{url:'/dacs/v1/payments',text:'{}',header:'fixture'});assert.equal(result.status,503);assert.notEqual(JSON.parse(result.text).status,'delivered');
});
