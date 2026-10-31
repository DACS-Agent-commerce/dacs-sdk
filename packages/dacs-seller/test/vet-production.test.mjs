import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevnetDemoAgreementContextProvider } from '../src/devnet-demo/agreement-context.mjs';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { JOB, buyer, seller } from './helpers/protocol-fixture.mjs';
import { compositeVerificationAddress } from '@kynesyslabs/dacs';

test('staged Vet factory refuses before any signer, anchor or row operation',()=>{
 let effects=0;const effect=()=>{effects++;throw new Error('TEST effect');};
 assert.throws(()=>createDevnetDemoAgreementContextProvider({anchor:{hasIntent:effect,publish:effect},wallet:{signBytes:effect},store:{read:effect,update:effect,entries:effect}}),/Vet context is not assembled/);assert.equal(effects,0);
});
test('real staged engine anchors one buyer Vet record signed by the seller',async()=>{
 const f=productionFixture(),result=await f.run();
 assert.equal(result.buyerVet.record.overallDecision,'pass');assert.equal(result.buyerVet.record.evaluatedParty,buyer.claim);assert.equal(result.buyerVet.record.signature.signer,seller.claim);
 assert.equal(result.buyerVet.recordRef.anchor.locator,compositeVerificationAddress(JOB,buyer.claim));assert.equal(f.local.writes.length,1);assert.equal(f.controls.signs,1);f.base.close();
});
test('a repeated request for a finished job signs and writes nothing again',async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input();
 await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true);await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true);
 assert.equal(f.local.writes.length,1);assert.equal(f.controls.signs,1);f.base.close();
});
test('an anchor that only relays the write never closes the buyer Vet',async()=>{
 const f=productionFixture();f.controls.relayOnly=true;await assert.rejects(f.run());assert.equal(f.local.writes.length,0);f.base.close();
});
for(const state of ['accepted','included'])test(`merely ${state} receipts never close staged Vet`,async()=>{
 const f=productionFixture();f.controls.receiptState=state;f.controls.receiptVerdict='valid';await assert.rejects(f.run());f.base.close();
});
test('a finished job is read back again: a buyer receipt that no longer qualifies refuses the repeat',async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input();
 assert.equal((await p.jobVet(input.scope,input.buyerIdentityBundle,()=>true)).buyerVet.record.overallDecision,'pass');
 f.controls.receiptStateFor=asked=>asked===compositeVerificationAddress(JOB,buyer.claim)?'accepted':'finalized';
 await assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>true),e=>e.code==='party_vet_unavailable');assert.equal(f.local.writes.length,1);f.base.close();
});
// A receipt that is not final yet is a wait: the step is retried, never kept as a terminal failure.
for(const state of ['accepted','included'])for(const provider of ['same','fresh'])test(`a ${state} receipt for the written Vet finalizes on a retry with a ${provider} provider`,async()=>{
 const f=productionFixture(),p=await f.provider(),input=f.input(),run=()=>(provider==='same'?Promise.resolve(p):f.provider()).then(use=>use.jobVet(input.scope,input.buyerIdentityBundle,()=>true));
 f.controls.receiptState=state;f.controls.receiptVerdict='valid';
 await assert.rejects(run());await assert.rejects(run(),/./,'still not final: still a wait');
 f.controls.receiptState='finalized';
 const result=await run();assert.equal(result.buyerVet.record.overallDecision,'pass');
 assert.equal(f.local.writes.length,1,'the retry rereads the same intent');assert.equal(f.controls.signs,1,'nothing is signed twice');f.base.close();
});
