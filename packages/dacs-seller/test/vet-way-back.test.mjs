import test from 'node:test';
import assert from 'node:assert/strict';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { failStoreCall } from './helpers/store-faults.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';

// A fault-free run signs the buyer composite record and the seller presentation.
const FAULT_FREE_SIGNS=2;
// Store calls of the composite steps that come before the signer (or any anchor
// publication) is invoked: the write-ahead of the bytes, the anchor step's write
// mark, and the purchase check right before the signer.
const BEFORE_SIGNER=[['update',7],['update',13],['read',5]];
const retryableCodes=['journal-busy','journal-capacity'];

const presentationState=async f=>(await f.base.entries()).map(([,row])=>row).find(row=>row?.jobId===JOB)?.presentation?.signing?.state;

async function runOnceThenRetry(f){
 await assert.rejects(f.run());
 return f.run();
}

for(const code of retryableCodes)for(const [kind,at] of BEFORE_SIGNER)test(`${code} at store ${kind} ${at} before the signer is retried to the fault-free signature count`,async()=>{
 const f=productionFixture();failStoreCall(f,{kind,at,code});
 const result=await runOnceThenRetry(f);
 assert.ok(result.buyerVet&&result.sellerVet);
 assert.equal(f.controls.signs,FAULT_FREE_SIGNS);assert.equal(f.controls.presentationSigns,1);assert.equal(f.local.writes.length,2);
});

for(const at of [8,9,14])test(`one busy store write after the signer (update ${at}) completes without another signature`,async()=>{
 const f=productionFixture();failStoreCall(f,{kind:'update',at});
 const result=await f.run();
 assert.ok(result.buyerVet&&result.sellerVet);
 assert.equal(f.controls.signs,FAULT_FREE_SIGNS);assert.equal(f.local.writes.length,2);
});

// Makes the first composite-record signature attempt fail with this error;
// later attempts reach the fixture's signer, which counts the signatures.
function failFirstCompositeSign(f,error){
 const sign=f.config.wallet.signBytes;let failed=false;
 f.config.wallet.signBytes=bytes=>{
  if(!failed&&!Buffer.from(bytes).toString().startsWith('dacs-bundle-presentation:v1:')){failed=true;throw error;}
  return sign(bytes);
 };
}

test('a composite signature refused with user_rejected is asked again on retry',async()=>{
 const f=productionFixture();failFirstCompositeSign(f,Object.assign(new Error('TEST operator refused'),{code:'user_rejected'}));
 const result=await runOnceThenRetry(f);
 assert.ok(result.buyerVet&&result.sellerVet);assert.equal(f.controls.signs,FAULT_FREE_SIGNS);
});

test('a composite signer failure without the refusal code holds the step and never signs again',async()=>{
 const f=productionFixture();failFirstCompositeSign(f,new Error('TEST signer disconnected'));
 await assert.rejects(f.run());await assert.rejects(f.run());
 assert.equal(f.controls.signs,0);
});

test('a store that stays busy after the signer holds the step and never signs the composite again',async()=>{
 const f=productionFixture(),faults=failStoreCall(f,{kind:'update',at:8,persistent:true});
 await assert.rejects(f.run(),/busy/);
 faults.heal();
 await assert.rejects(f.run());
 assert.equal(f.controls.signs,1);
});

// Read 10 is the purchase check before the presentation reservation is written;
// read 11 is the same check repeated after it, where the reservation is restored.
for(const at of [10,11])test(`a store fault at read ${at} around the presentation reservation leaves prepared and the retry signs once`,async()=>{
 const f=productionFixture();failStoreCall(f,{kind:'read',at});
 await assert.rejects(f.run(),error=>error.code==='journal-busy');
 assert.equal(await presentationState(f),'prepared');
 assert.equal(f.controls.presentationSigns,0);
 const result=await f.run();
 assert.ok(result.sellerVet);assert.equal(f.controls.presentationSigns,1);assert.equal(f.controls.signs,FAULT_FREE_SIGNS);assert.equal(f.issued.size,1);
});
