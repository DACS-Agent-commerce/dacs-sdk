import test from 'node:test';
import assert from 'node:assert/strict';
import { productionFixture } from './helpers/vet-production-fixture.mjs';
import { NOW } from './helpers/protocol-fixture.mjs';

for(const outcome of ['unattempted','present','indeterminate','absent','issuer','jobId','bundleHash','requirementHash'])test(`expired unsigned seller challenge reconciles ${outcome}`,async()=>{
 const f=productionFixture();let at=NOW,issued=0,interrupt=true;
 f.config.now=()=>at;
 const sign=f.config.wallet.signBytes,issue=f.counterparty.issueChallenge,read=f.counterparty.readRecord;
 f.config.wallet.signBytes=bytes=>{if(interrupt){interrupt=false;throw new Error('TEST interrupted signer');}return sign(bytes);};
 f.counterparty.issueChallenge=async input=>({...await issue(input),expiresAt:at+60000,...(++issued&&{})});
 await assert.rejects(f.run(),/TEST interrupted signer/);at+=60001;
 f.counterparty.readRecord=async input=>{const out=await read(input);if(outcome==='unattempted')return out;if(['issuer','jobId','bundleHash','requirementHash'].includes(outcome))return{...out,[outcome]:'TEST wrong'};return{status:outcome};};
 const effects=f.controls.signs;
 if(outcome==='unattempted'){
  const result=await f.run();assert.equal(result.sellerVet.record.overallDecision,'pass');assert.equal(issued,2);
 }else{await assert.rejects(f.run(),e=>e.code==='seller_vet_reconciliation_required');assert.equal(issued,1);assert.equal(f.controls.signs,effects);assert.equal(f.local.writes.length,0);}
 f.base.close();
});

// A signed presentation that expired before its first evaluation is just as
// stuck as an unsigned one: the buyer must refuse it under SN-4 forever. An
// exact unused ledger outcome lets the seller reserve a fresh challenge.
for(const provider of ['same','fresh'])test(`an expired signed presentation rotates an unused challenge with a ${provider} provider`,async()=>{
 const f=productionFixture();let at=NOW;
 f.config.now=()=>at;
 const expiries=new Map(),issue=f.counterparty.issueChallenge;
 f.counterparty.issueChallenge=async input=>{const challenge={...await issue(input),expiresAt:at+60000};expiries.set(challenge.sessionNonce,challenge.expiresAt);f.issued.set(challenge.sessionNonce,input.jobId);return challenge;};
 const read=f.counterparty.readRecord;let unavailable=true;
 f.counterparty.readRecord=async input=>{if(unavailable){unavailable=false;throw Object.assign(new Error('TEST ledger unavailable'),{code:'ECONNREFUSED'});}return read(input);};
 // A conforming buyer refuses a presentation whose issued nonce has expired.
 const evaluate=f.counterparty.evaluate;
 f.counterparty.evaluate=async input=>{const expiry=expiries.get(input.identityBundle.sessionNonce);if(expiry===undefined||at>expiry){f.consumed.add(input.identityBundle.sessionNonce);throw new Error('TEST expired challenge');}return evaluate(input);};
 const p=await f.provider(),input=f.input();
 await assert.rejects(p.jobVet(input.scope,input.buyerIdentityBundle,()=>true),e=>e.code==='counterparty_vet_unavailable');
 const saved=await p.state.read(input.scope.jobId);
 assert.ok(saved.presentation.bundle.presentation,'the failed attempt left the presentation signed');
 at+=60001;
 const use=provider==='same'?p:await f.provider();
 const result=await use.jobVet(input.scope,input.buyerIdentityBundle,()=>true);
 assert.equal(result.sellerVet.record.overallDecision,'pass');
 assert.equal(expiries.size,2,'exactly one replacement challenge is issued');assert.equal(f.seen.length,1);
 f.base.close();
});
for(const change of ['signed','replaced'])test(`expired challenge rotation preserves a concurrently ${change} presentation`,async()=>{
 const f=productionFixture();let at=NOW,interrupt=true,entered,continueRead;
 f.config.now=()=>at;const sign=f.config.wallet.signBytes;
 f.config.wallet.signBytes=bytes=>{if(interrupt){interrupt=false;throw new Error('TEST interrupted signer');}return sign(bytes);};
 await assert.rejects(f.run());at+=60001;
 const issue=f.counterparty.issueChallenge;f.counterparty.issueChallenge=async input=>({...await issue(input),expiresAt:at+60000});
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>continueRead=r),read=f.counterparty.readRecord;
 f.counterparty.readRecord=async input=>{const result=await read(input);entered();await gate;return result;};
 const p=await f.provider(),row=await p.state.read(f.input().scope.jobId),job={jobId:row.jobId,binding:row.binding,open:()=>true,writeStarted:true};
 const work=p.sellerSession(job);await ready;
 const updated=structuredClone(row.presentation);updated.bundle.presentation={kind:'per-claim',signatures:[{ref:row.binding.scope.seller,signature:'TEST retained signature'}]};
 if(change==='replaced')updated.challenge.sessionNonce='ab'.repeat(32);
 await p.state.update(job.jobId,current=>({...current,presentation:updated}));
 continueRead();assert.deepEqual(await work,updated.bundle);assert.deepEqual((await p.state.read(job.jobId)).presentation,updated);assert.equal(f.controls.signs,0);f.base.close();
});
