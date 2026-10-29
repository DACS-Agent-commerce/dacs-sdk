import test from 'node:test';
import assert from 'node:assert/strict';
import {identityBundleHash,canonicalize,sha256Hex} from '@kynesyslabs/dacs';
import {proposalAdmissionFixture} from './helpers/proposal-admission-fixture.mjs';
import {testWallet,NOW,JOB,buyer,seller} from './helpers/protocol-fixture.mjs';
import {fixtureIdentityBundle} from './fixtures/listings.mjs';
import {createSellerDurableState} from '../src/dacs/seller-durable-state.mjs';
import {SESSION_CHALLENGE_LIFETIME_MS} from '../src/dacs/session-admission.mjs';
import {listingPin} from '../src/dacs/purchase-protocol.mjs';
import {createSellerAgent} from '../src/dacs/seller-agent.mjs';
const staged=error=>error.code==='proposal_not_assembled';
test('accepted presentation and exact admission are atomically retained and replay after restart',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:listingPin(f.listing)}),kept=state.attemptChallenge(input.buyerIdentityBundle.sessionNonce,{presentationHash:'b'.repeat(64)});state.close();
 assert.deepEqual(kept.attempt.accepted.buyerBundle,input.buyerIdentityBundle);assert.equal(kept.attempt.accepted.buyerBundleHash,identityBundleHash(input.buyerIdentityBundle));
 assert.equal(kept.attempt.accepted.admission.disposition,'admitted');assert.equal(kept.attempt.admitted,true);
 const fresh=await f.open();await assert.rejects(fresh.stagedProposal(input),staged);assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1);assert.equal(f.signed.some(text=>text.startsWith('dacs-agreement:')),false);
});
for(const change of ['buyer','challenge'])test(`a job accepted before a restart refuses another ${change} without admitting it again`,async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open();await assert.rejects(agent.stagedProposal(f.input(agent)),staged);agent.close();
 const fresh=await f.open(),party=change==='buyer'?testWallet(44):buyer;
 await assert.rejects(fresh.stagedProposal(f.input(fresh,JOB,party)),error=>error.code==='job_taken');
 assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1);
});
test('the durable job binding refuses another admitted bundle atomically',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:listingPin(f.listing)});
 const other=testWallet(44),nonce='c'.repeat(64),otherBundle=fixtureIdentityBundle(other,NOW),hash=sha256Hex(canonicalize(otherBundle));
 state.issueChallenge(nonce,{jobId:JOB,buyer:other.claim,sessionNonce:nonce,issuedAt:NOW,expiresAt:NOW+1000});
 state.attemptChallenge(nonce,{jobId:JOB,presentationHash:hash});
 assert.throws(()=>state.admitChallenge(nonce,hash,{buyerBundle:otherBundle,buyerBundleHash:identityBundleHash(otherBundle),admission:{},admittedAt:NOW}),error=>error.code==='seller_job_bound');
 state.close();
});
test('failed proof consumes its challenge before validation and stays consumed after restart',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),good=f.input(agent),bad=structuredClone(good);bad.buyerIdentityBundle.presentation.signatures[0].signature='A'.repeat(86);
 await assert.rejects(agent.stagedProposal(bad),error=>error.code==='buyer_bundle_unauthenticated');agent.close();const fresh=await f.open();await assert.rejects(fresh.stagedProposal(good),error=>error.code==='session_not_admitted');assert.equal(f.admission.calls.some(([method])=>method==='admit'),false);
});
for(const binding of ['job','buyer'])test(`a challenge for another ${binding} cannot admit a presentation`,async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);
 if(binding==='job')input.transportIdentity.jobId='01J8N4YV7YVYQ4DB7M8T4C7W0B';else {const other=testWallet(44),nonce=input.buyerIdentityBundle.sessionNonce;input.buyerIdentityBundle={bundleVersion:'1',presentedBy:other.claim,presentedAt:NOW,sessionNonce:nonce,claims:[{ref:other.claim}]};input.buyerIdentityBundle.presentation={kind:'per-claim',signatures:[{ref:other.claim,signature:other.signBytes(Buffer.from('dacs-bundle-presentation:v1:'+identityBundleHash(input.buyerIdentityBundle))).toString('base64url')}]};input.transportIdentity.buyer=other.claim;}
 await assert.rejects(agent.stagedProposal(input));assert.equal(f.admission.calls.some(([method])=>method==='admit'),false);
});
test('expiry is exclusive for a new presentation',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);f.advance(SESSION_CHALLENGE_LIFETIME_MS);await assert.rejects(agent.stagedProposal(input),error=>error.code==='session_not_admitted');
});
test('fresh repeat of an accepted presentation revalidates without another admission',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);await assert.rejects(agent.stagedProposal(input),staged);
 assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1);assert.equal(f.admission.calls.filter(([method])=>method==='readRevocationSurfaces').length,2);
});
test('an oversized admission reply holds with its real bound failure',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);f.admission.sessionAdmission.admit=async()=>({extra:'x'.repeat(65537)});
 await assert.rejects(agent.stagedProposal(input),error=>error.code==='session_admission_unavailable'&&error.cause instanceof RangeError);
});
test('an admission reply with a non-JSON member is refused before normalization can drop it',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);f.admission.answerWith(answer=>({...answer,unexpected:undefined}));
 await assert.rejects(agent.stagedProposal(input),error=>error.code==='session_admission_unavailable'&&error.cause instanceof TypeError);
 assert.equal(f.admission.calls.some(([method])=>method==='admit'),true);assert.equal(f.signed.some(text=>text.startsWith('dacs-agreement:')),false);
});
test('a stalled admission is aborted at its deadline without proposal signing',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);let entered,limits;const started=new Promise(r=>entered=r);
 f.admission.sessionAdmission.admit=(_input,options)=>{limits=options;entered();return new Promise(()=>{});};t.mock.timers.enable({apis:['setTimeout']});const waiting=assert.rejects(agent.stagedProposal(input),error=>error.code==='session_admission_unavailable'&&error.cause?.name==='TimeoutError');await started;t.mock.timers.tick(10001);await waiting;assert.equal(limits.signal.aborted,true);assert.equal(limits.maxBytes,65536);
});

test('legacy admitted flags without the exact retained presentation hold without readmitting',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:listingPin(f.listing)}),hash=sha256Hex(canonicalize(input.buyerIdentityBundle));state.attemptChallenge(input.buyerIdentityBundle.sessionNonce,{presentationHash:hash});state.admitChallenge(input.buyerIdentityBundle.sessionNonce,hash);state.close();
 const fresh=await f.open();await assert.rejects(fresh.stagedProposal(input),e=>e.code==='session_admission_unavailable');assert.equal(f.admission.calls.some(([method])=>method==='admit'),false);
});

// A proposal stage session has no Vet evidence to authenticate it, so the
// accepted presentation and its validated admission answer are the only proof
// this seller admitted it. A bare legacy `admitted` flag is not enough.
test('a saved proposal stage session without its accepted presentation does not restore',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:listingPin(f.listing)}),hash=sha256Hex(canonicalize(input.buyerIdentityBundle));
 state.attemptChallenge(input.buyerIdentityBundle.sessionNonce,{presentationHash:hash});state.admitChallenge(input.buyerIdentityBundle.sessionNonce,hash);
 await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:input.buyerIdentityBundle,buyerBundleHash:identityBundleHash(input.buyerIdentityBundle),stage:'proposed'}));state.close();
 await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&/accepted presentation/.test(error.message));
});

test('an admitted proposal that claims no Vet stays readable at its proposed stage',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);
 assert.equal(agent.stageOf(JOB),'proposed','a session before Vet claims no Vet checkpoint or evidence');
 assert.equal(agent.transportAgreementOf(JOB),null);
 assert.deepEqual(agent.durableSessionOf(JOB),null);
});

test('a retained session past proposal without a Vet checkpoint refuses the restart',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:listingPin(f.listing)});
 await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:input.buyerIdentityBundle,buyerBundleHash:identityBundleHash(input.buyerIdentityBundle),stage:'agreed'}));
 state.close();
 await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&/Vet checkpoint/.test(error.message));
});

test('a retained proposal stage session restores with only its challenge binding',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:listingPin(f.listing)});
 await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:input.buyerIdentityBundle,buyerBundleHash:identityBundleHash(input.buyerIdentityBundle),stage:'proposed'}));
 state.close();
 const fresh=await f.open();assert.equal(fresh.stageOf(JOB),'proposed');
});

// CORE CF-3: advisory ClaimReference parameters do not change the buyer's
// identity, so a challenge issued to the parameter-free claim admits a
// presentation that carries one and the saved session must still restart.
test('a challenge for the parameter-free buyer restores a presentation carrying an advisory parameter',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open();
 const parameterized={...buyer,claim:`${buyer.claim}?jurisdiction=GB`};
 const challenge=agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim});
 const bundle=fixtureIdentityBundle(parameterized,NOW);bundle.sessionNonce=challenge.sessionNonce;
 bundle.presentation.signatures[0].signature=parameterized.signBytes(Buffer.from('dacs-bundle-presentation:v1:'+identityBundleHash(bundle))).toString('base64url');
 const input={proposal:{},transportIdentity:{jobId:JOB,buyer:buyer.claim,seller:seller.claim},buyerIdentityBundle:bundle};
 await assert.rejects(agent.stagedProposal(input),staged);agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:listingPin(f.listing)});
 await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:bundle,buyerBundleHash:identityBundleHash(bundle),stage:'proposed'}));state.close();
 const fresh=await f.open();assert.equal(fresh.stageOf(JOB),'proposed');
});

test('a closed agent refuses proposal admission before it consumes the challenge',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);agent.close();
 await assert.rejects(agent.stagedProposal(input),error=>error.code==='seller_closed');
 const fresh=await f.open();await assert.rejects(fresh.stagedProposal(input),staged);
 assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1);
});

test('the native profile issues no challenge without its session admission',async t=>{
 const f=await proposalAdmissionFixture(t);
 const missing=await createSellerAgent({...f.config,maxJobs:1,sessionAdmission:null});t.after(()=>missing.close());
 assert.throws(()=>missing.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}),error=>error.code==='session_admission_required'&&error.status===503);
 missing.close();
 // A refused issuance retains nothing: the one live issuance slot is still free.
 const agent=await createSellerAgent({...f.config,maxJobs:1});t.after(()=>agent.close());
 assert.ok(agent.issueSessionChallenge({jobId:JOB,buyer:buyer.claim}).sessionNonce);
});

// The admitted attempt must fingerprint the complete presentation. The core
// contentHash drops top-level signature/signatures members, so comparing the
// attempt with it made a valid buyer-supplied extension unreadable.
test('an accepted presentation carrying an extra bundle member stays readable and restores',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);
 input.buyerIdentityBundle.signature='TEST bundle extension';
 input.buyerIdentityBundle.presentation.signatures[0].signature=buyer.signBytes(Buffer.from('dacs-bundle-presentation:v1:'+identityBundleHash(input.buyerIdentityBundle))).toString('base64url');
 await assert.rejects(agent.stagedProposal(input),staged);
 assert.equal(agent.stageOf(JOB),'proposed');agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:listingPin(f.listing)});
 await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:input.buyerIdentityBundle,buyerBundleHash:identityBundleHash(input.buyerIdentityBundle),stage:'proposed'}));state.close();
 const fresh=await f.open();assert.equal(fresh.stageOf(JOB),'proposed');
});

// close() can run while an admission read is pending. The continuation must
// refuse with the lifecycle error before any capability call or state change.
async function gatedRevocation(f){
 let entered,release;const started=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;});
 const original=f.admission.sessionAdmission.readRevocationSurfaces;
 f.admission.sessionAdmission.readRevocationSurfaces=async query=>{entered();await gate;return original(query);};
 return{started,release};
}
test('a close during the admission revocation read refuses before admitting',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent),gate=await gatedRevocation(f);
 const pending=agent.stagedProposal(input);await gate.started;agent.close();gate.release();
 await assert.rejects(pending,error=>error.code==='seller_closed');
 assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,0);
});
test('a close during an accepted replay revocation read refuses with the lifecycle error',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.input(agent);
 await assert.rejects(agent.stagedProposal(input),staged);
 const gate=await gatedRevocation(f);
 const pending=agent.stagedProposal(input);await gate.started;agent.close();gate.release();
 await assert.rejects(pending,error=>error.code==='seller_closed');
});
