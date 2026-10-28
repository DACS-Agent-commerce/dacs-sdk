import test from 'node:test';
import assert from 'node:assert/strict';
import {proposalAdmissionFixture,proposalForInput} from './helpers/proposal-admission-fixture.mjs';
import {JOB,NOW} from './helpers/protocol-fixture.mjs';
import {canonicalize} from '@kynesyslabs/dacs';
import {createDemDeliveryContext} from '../src/dacs/dem-delivery-context-consumer.mjs';

const MINIMUM_REPORT_SIZE=Buffer.byteLength(canonicalize({jobId:'0'.repeat(26),agreementHash:'0'.repeat(64),settlementId:`demos:${'0'.repeat(64)}`}));
const REFUSED_REPORT_SIZES=[null,MINIMUM_REPORT_SIZE-1,...[1,2,3,4].map(offset=>MINIMUM_REPORT_SIZE+offset)];

test('completed proposal survives reject-different-proposal and exact replay after restart',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),a=await f.proposal(agent),complete=await agent.receiveProposal(a);assert.equal(complete.disposition,'complete');
 const changed=structuredClone(f.contexts.get(JOB).input);changed.buyer.vetRecordRef.contentHash='f'.repeat(64);const b=await proposalForInput(changed);f.advance(1000);assert.equal((await agent.receiveProposal(b)).disposition,'rejected');agent.close();
 const fresh=await f.open(),replay=await fresh.receiveProposal(a);assert.equal(replay.disposition,'complete');assert.deepEqual(replay.contribution,complete.contribution);
});
test('agreement state is exact, isolated, unknown-safe and retained across restart',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),request=await f.proposal(agent);await agent.receiveProposal(request);
 const original=agent.agreementState(request.transportIdentity),copy=agent.agreementState(request.transportIdentity);copy.proposal.plan.draft.generatedAt++;copy.contribution.signature.value='TEST-changed';assert.deepEqual(agent.agreementState(request.transportIdentity),original);
 assert.deepEqual(agent.agreementState({...request.transportIdentity,proposalHash:'0'.repeat(64)}),{proposal:null,contribution:null});agent.close();assert.deepEqual((await f.open()).agreementState(request.transportIdentity),original);
});
test('rejected unsigned context retains no live job and the next job can enter after restart',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true,maxJobs:1}),agent=await f.open(),bad=await f.proposal(agent,JOB,{synthetic:true});assert.equal((await agent.receiveProposal(bad)).disposition,'rejected');assert.equal(agent.durableSessions().length,0);agent.close();
 const fresh=await f.open(),next=await f.proposal(fresh,'01J8N4YV7YVYQ4DB7M8T4C7W0B');assert.equal((await fresh.receiveProposal(next)).disposition,'complete');
});
for(const method of ['resolveVetRecord','readVetAnchorReceipt','verifyVetAnchorReceipt'])test(`${method} timeout stays indeterminate and preserves the actual cause`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),request=await f.proposal(agent),cause=Object.assign(new Error('TEST source timeout'),{code:'ETIMEDOUT'});f.admission.sessionAdmission[method]=async()=>{throw cause;};
 const result=await agent.receiveProposal(request);assert.equal(result.disposition,'indeterminate');assert.equal(result.cause,cause);assert.equal(result.causeCode,'timeout');
});
test('an indeterminate receipt authentication stays indeterminate',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),request=await f.proposal(agent);f.admission.verifyReceiptWith(()=> 'indeterminate');assert.equal((await agent.receiveProposal(request)).disposition,'indeterminate');
});
test('oversized Vet data is held before cloning and authentication',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),request=await f.proposal(agent);f.admission.sessionAdmission.resolveVetRecord=async()=>({extra:'x'.repeat(65537)});const answer=await agent.receiveProposal(request);assert.equal(answer.disposition,'indeterminate');assert.ok(answer.cause instanceof RangeError);
});
test('a stalled Vet reader aborts and releases the active job fence',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),request=await f.proposal(agent);let enter,limits;const started=new Promise(r=>enter=r);f.admission.sessionAdmission.resolveVetRecord=(_input,options)=>{limits=options;enter();return new Promise(()=>{});};
 t.mock.timers.enable({apis:['setTimeout']});const pending=agent.receiveProposal(request);await started;t.mock.timers.tick(10001);const answer=await pending;assert.equal(answer.disposition,'indeterminate');assert.equal(answer.cause?.name,'TimeoutError');assert.equal(limits.signal.aborted,true);agent.close();
});

test('a stalled DEM delivery context resolver aborts and releases the job fence',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true});let enter,limits,calls=0;
 const started=new Promise(r=>enter=r);
 f.config.demDeliveryContext=createDemDeliveryContext({authority:'TEST-stalled-delivery',resolveBuyer:async()=>null,
  resolveSeller:(request,options)=>{if(calls++===0){limits=options;enter();return new Promise(()=>{});}return {disposition:'present',value:structuredClone(f.contexts.get(request.jobId))};}});
 const agent=await f.open(),request=await f.proposal(agent),pending=agent.receiveProposal(request);
 await started;const answer=await pending;
 assert.equal(answer.disposition,'indeterminate');assert.match(answer.reason,/^DEM delivery seller context failed: /);assert.equal(limits.signal.aborted,true);
 assert.equal((await agent.receiveProposal(request)).disposition,'complete','the same job runs again after the fence is released');
});

test('retired admission history remains bounded even when no live job is held',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true,maxJobs:1}),agent=await f.open();agent.close();
 const {createSellerDurableState}=await import('../src/dacs/seller-durable-state.mjs');const {listingPin}=await import('../src/dacs/purchase-protocol.mjs');const {sha256Hex}=await import('@kynesyslabs/dacs');const {buyer,NOW}=await import('./helpers/protocol-fixture.mjs');
 const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:listingPin(f.listing),maxJobs:1});try{for(let i=0;i<16;i++){const nonce=sha256Hex('TEST retired history '+i),hash=sha256Hex('TEST accepted presentation '+i);state.issueChallenge(nonce,{jobId:JOB,buyer:buyer.claim,issuedAt:NOW,expiresAt:NOW+600000});state.attemptChallenge(nonce,{presentationHash:hash});state.admitChallenge(nonce,hash,{TEST:'retained operator checkpoint'});state.retireChallenge(nonce,hash);}}finally{state.close();}
 const fresh=await f.open();assert.throws(()=>fresh.issueSessionChallenge({jobId:'01J8N4YV7YVYQ4DB7M8T4C7W0B',buyer:buyer.claim}),e=>e.code==='seller_challenge_capacity');
});

test('an exact retry reuses the retained context admission after the callback is lost',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true});f.config.contextRequest=()=>true;
 const agent=await f.open(),request=await f.proposal(agent,JOB,{generatedAt:NOW-30000});
 // The challenge is still live, but the proposal is older than the plain clock window.
 f.advance(590000);const complete=await agent.receiveProposal(request);assert.equal(complete.disposition,'complete');agent.close();
 f.config.contextRequest=()=>false;
 const replay=await (await f.open()).receiveProposal(request);assert.equal(replay.disposition,'complete');assert.deepEqual(replay.contribution,complete.contribution);
});

for(const expectedSizeBytes of REFUSED_REPORT_SIZES)test(`an unproducible inline delivery size (${expectedSizeBytes}) is refused before any Agreement signature`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true,expectedSizeBytes}),agent=await f.open(),request=await f.proposal(agent);
 const answer=await agent.receiveProposal(request);assert.equal(answer.disposition,'rejected');assert.equal(answer.stage,'context');assert.match(answer.reason,/inline storage delivery requires expectedSizeBytes/);
 assert.equal(agent.durableSessionOf(JOB),null);assert.ok(!f.signed.some(text=>text.startsWith('dacs-payee-bound-agreement:v1:')),'the seller signed no Agreement');
});
for(const expectedSizeBytes of [MINIMUM_REPORT_SIZE,MINIMUM_REPORT_SIZE+5,131072])test(`a producible inline delivery size (${expectedSizeBytes}) completes the contribution`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true,expectedSizeBytes}),agent=await f.open(),request=await f.proposal(agent);
 assert.equal((await agent.receiveProposal(request)).disposition,'complete');assert.ok(agent.durableSessionOf(JOB).sellerContribution);
});
test('an inline delivery Listing above the profile bound is refused at construction',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true,expectedSizeBytes:131073});await assert.rejects(f.open(),/at most 131072/);
});

test('a non-canonical proposal job is a definite job-invalid refusal, not an uncertain outcome',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),request=await f.proposal(agent);
 request.transportIdentity.jobId='bad:job';
 await assert.rejects(agent.receiveProposal(request),{code:'job_invalid',status:422});
});

test('validated contribution is retained before the final proposal snapshot and reused after restart',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true});let cut=true,signatures=0;const original=f.config.signer.sign;
 f.config.signer.sign=bytes=>{const text=Buffer.from(bytes).toString();if(text.startsWith('dacs-payee-bound-agreement:v1:'))signatures++;if(text.includes('"kind":"session"')){const payload=JSON.parse(text.slice(text.indexOf('{')));if(cut&&payload.body.session.proposal?.proposalHash){cut=false;throw new Error('TEST final proposal save interrupted');}}return original(bytes);};
 const agent=await f.open(),request=await f.proposal(agent);await assert.rejects(agent.receiveProposal(request),/TEST final proposal save interrupted/);const kept=agent.durableSessionOf(JOB);assert.ok(kept.sellerContribution);assert.equal(kept.proposal,null);agent.close();assert.deepEqual((await (await f.open()).receiveProposal(request)).contribution,kept.sellerContribution);assert.equal(signatures,1);
});
