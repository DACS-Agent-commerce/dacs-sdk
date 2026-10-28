import test from 'node:test';
import assert from 'node:assert/strict';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { JOB, buyer } from './helpers/protocol-fixture.mjs';
import { compositeVerificationAddress } from '@kynesyslabs/dacs';

const address=compositeVerificationAddress(JOB,buyer.claim);
const cases=[['publish','result'],['readRetained','result'],['verifyReceipt','verdict'],['readRetained','bytes']];
for(const [boundary,mode] of cases)for(const failure of mode==='verdict'?['indeterminate']:['indeterminate','journal-busy','journal-capacity'])for(const fresh of [false,true])test(`${boundary} ${mode} ${failure} retries exact buyer record (${fresh?'restart':'same provider'})`,async()=>{
 const f=productionFixture(),original=f.anchor[boundary],read=f.anchor.readRetained,verify=f.anchor.verifyReceipt;let held=true,bytes=false;
 if(mode==='bytes')f.anchor.verifyReceipt=async input=>{const out=await verify(input);bytes=true;return out;};
 if(boundary==='publish')f.anchor.readRetained=async input=>held&&f.local.rows.has(address)?{status:'indeterminate'}:read(input);
 f.anchor[boundary]=async input=>{
  if(boundary==='publish'&&held&&failure!=='indeterminate')throw Object.assign(new Error('TEST journal unavailable'),{code:failure});
  const out=await original(input);
  if(input.logicalAddress!==address||!held)return out;
  if(mode==='bytes'){if(!bytes)return out;bytes=false;}
  if(mode==='verdict')return 'indeterminate';
  if(failure==='indeterminate')return{status:'indeterminate',reason:'TEST pending',noResend:true};
  throw Object.assign(new Error('TEST journal unavailable'),{code:failure});
 };
 const p=await f.provider(),input=f.input(),run=async()=>{const use=fresh?await f.provider():p;return use.jobVet(input.scope,input.buyerIdentityBundle,()=>true);};
 await assert.rejects(run());await assert.rejects(run());const signatures=f.controls.signs;
 held=false;const results=await Promise.all([run(),run()]);
 for(const result of results)assert.equal(result.buyerVet.record.overallDecision,'pass');
 assert.equal(f.controls.signs,signatures,'the retained signature is reused');
 assert.equal(f.local.writes.filter(row=>row===address).length,1);f.base.close();
});
for(const definitive of ['rejected','invalid','wrong-hash'])test(`a definitive ${definitive} fallback overrides earlier uncertainty`,async()=>{
 const f=productionFixture(),publish=f.anchor.publish,read=f.anchor.readRetained;let reads=0;
 f.anchor.publish=async input=>{await publish(input);return{status:'indeterminate'};};
 f.anchor.readRetained=async input=>{const out=await read(input);if(++reads===1)return out;
  if(definitive==='rejected')return{status:'rejected',reason:'TEST refused'};
  if(definitive==='invalid')return out.status==='present'?{...out,receipt:{...out.receipt,state:'dropped'}}:out;
  return out.status==='present'?{...out,artifact:{...out.artifact,jobId:'TEST changed'}}:out;
 };
 await assert.rejects(f.run());const row=(await f.base.entries())[0][1];
 assert.equal(Object.values(row.ops.buyer.steps).some(step=>step.state==='failed'),true);f.base.close();
});
