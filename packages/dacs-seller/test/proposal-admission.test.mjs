import test from 'node:test';
import assert from 'node:assert/strict';
import {identityBundleHash,canonicalize,sha256Hex} from '@kynesyslabs/dacs';
import Database from 'better-sqlite3';
import {proposalAdmissionFixture} from './helpers/proposal-admission-fixture.mjs';
import {testWallet,NOW,JOB,buyer} from './helpers/protocol-fixture.mjs';
import {fixtureIdentityBundle} from './fixtures/listings.mjs';
import {createSellerDurableState} from '../src/dacs/seller-durable-state.mjs';
import {SESSION_CHALLENGE_LIFETIME_MS} from '../src/dacs/session-admission.mjs';
import {listingPin} from '../src/dacs/purchase-protocol.mjs';
import {createSellerAgent} from '../src/dacs/seller-agent.mjs';
const staged=error=>error.code==='proposal_not_assembled';
const CHALLENGE_SCOPE=sha256Hex('TEST challenge scope');
const OTHER_JOB='01J8N4YV7YVYQ4DB7M8T4C7W0B';
test('accepted presentation and exact admission are atomically retained and replay after restart',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=await f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);agent.close();
 const kept=f.store.challenges.retained(input.buyerIdentityBundle.sessionNonce);
 assert.equal(kept.accepted.buyerBundleText,canonicalize(input.buyerIdentityBundle));assert.equal(kept.accepted.buyerBundleHash,identityBundleHash(input.buyerIdentityBundle));
 assert.equal(kept.accepted.admission.disposition,'admitted');assert.equal(kept.state,'accepted');
 const fresh=await f.open();await assert.rejects(fresh.stagedProposal(input),staged);assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1);assert.equal(f.signed.some(text=>text.startsWith('dacs-agreement:')),false);
});
test('a job accepted before a restart refuses another buyer without admitting it again',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open();
 const first=await f.input(agent),second=f.unadmitted(JOB,testWallet(44));
 await assert.rejects(agent.stagedProposal(first),staged);agent.close();
 const fresh=await f.open();
 await assert.rejects(fresh.stagedProposal(second),error=>error.code==='job_taken');
 assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1);
});
test('a job accepted before a restart is closed to another challenge',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open();await assert.rejects(agent.stagedProposal(await f.input(agent)),staged);agent.close();
 const fresh=await f.open();
 assert.throws(()=>f.config.challengeLedger.issue({jobId:JOB,buyer:buyer.claim},CHALLENGE_SCOPE),error=>error.code==='context_job_closed');
 assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1);
 fresh.close();
});
test('a proposal with a failed bundle proof is refused and leaves the accepted presentation usable',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),good=await f.input(agent),bad=structuredClone(good);bad.buyerIdentityBundle.presentation.signatures[0].signature='A'.repeat(86);
 await assert.rejects(agent.stagedProposal(bad),error=>error.code==='buyer_bundle_unauthenticated');agent.close();const fresh=await f.open();await assert.rejects(fresh.stagedProposal(good),staged);assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1);
});
for(const binding of ['job','buyer'])test(`a challenge issued for another ${binding} is refused at its attempt and admits no session`,async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),ledger=f.config.challengeLedger,other=testWallet(44),{sessionNonce}=ledger.issue({jobId:JOB,buyer:buyer.claim},CHALLENGE_SCOPE);
 const attempt=ledger.attempt({path:'context',nonce:sessionNonce,jobId:binding==='job'?OTHER_JOB:JOB,buyer:binding==='buyer'?other.claim:buyer.claim,challengeScopeHash:CHALLENGE_SCOPE,presentationHash:sha256Hex('TEST presentation')});
 assert.deepEqual([attempt.kind,attempt.code],['refused','context_challenge_mismatch']);
 await assert.rejects(agent.stagedProposal(f.unadmitted()),error=>error.code==='context_admission_closed');assert.equal(f.admission.calls.some(([method])=>method==='admit'),false);
});
for(const [when,elapsed,kind,code] of [['one millisecond before',SESSION_CHALLENGE_LIFETIME_MS-1,'validate',undefined],['at',SESSION_CHALLENGE_LIFETIME_MS,'refused','context_challenge_expired']])test(`a challenge attempt ${when} its expiry is ${kind==='validate'?'let on':'refused context_challenge_expired'}`,async t=>{
 const f=await proposalAdmissionFixture(t),ledger=f.config.challengeLedger,{sessionNonce}=ledger.issue({jobId:JOB,buyer:buyer.claim},CHALLENGE_SCOPE);f.advance(elapsed);
 const answer=ledger.attempt({path:'context',nonce:sessionNonce,jobId:JOB,buyer:buyer.claim,challengeScopeHash:CHALLENGE_SCOPE,presentationHash:sha256Hex('TEST presentation')});
 assert.deepEqual([answer.kind,answer.code],[kind,code]);
});
test('fresh repeat of an accepted presentation revalidates without another admission',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=await f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);await assert.rejects(agent.stagedProposal(input),staged);
 assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1);assert.equal(f.admission.calls.filter(([method])=>method==='readRevocationSurfaces').length,3,'challenge issuance and both proposals revalidate the Listing');
});
// The agent's session admission read is the one the context route's policy calls for a first presentation.
const admitRequest=input=>({jobId:JOB,bundle:input.buyerIdentityBundle,nonce:input.buyerIdentityBundle.sessionNonce});
test('an oversized admission reply holds with its real bound failure',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.unadmitted();f.admission.sessionAdmission.admit=async()=>({extra:'x'.repeat(65537)});
 await assert.rejects(agent.admitSessionPresentation(admitRequest(input)),error=>error.code==='session_admission_unavailable'&&error.cause instanceof RangeError);
});
test('an admission reply with a non-JSON member is refused before normalization can drop it',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.unadmitted();f.admission.answerWith(answer=>({...answer,unexpected:undefined}));
 await assert.rejects(agent.admitSessionPresentation(admitRequest(input)),error=>error.code==='session_admission_unavailable'&&error.cause instanceof TypeError);
 assert.equal(f.admission.calls.some(([method])=>method==='admit'),true);assert.equal(f.signed.some(text=>text.startsWith('dacs-agreement:')),false);
});
test('a stalled admission is aborted at its deadline without proposal signing',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.unadmitted();let entered,limits;const started=new Promise(r=>entered=r);
 f.admission.sessionAdmission.admit=(_input,options)=>{limits=options;entered();return new Promise(()=>{});};t.mock.timers.enable({apis:['setTimeout']});const waiting=assert.rejects(agent.admitSessionPresentation(admitRequest(input)),error=>error.code==='session_admission_unavailable'&&error.cause?.name==='TimeoutError');await started;t.mock.timers.tick(10001);await waiting;assert.equal(limits.signal.aborted,true);assert.equal(limits.maxBytes,65536);
});

test('an accepted row without its exact retained presentation holds without readmitting',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=await f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);agent.close();
 const db=new Database(f.storePath);try{db.prepare("UPDATE kit_challenges SET accepted = '{}' WHERE state = 'accepted'").run();}finally{db.close();}
 const fresh=await f.open();await assert.rejects(fresh.stagedProposal(input),e=>e.code==='session_admission_unavailable');assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1);
});

// A proposal stage session has no Vet evidence to authenticate it, so the
// accepted presentation and its validated admission answer are the only proof
// this seller admitted it. A row accepted for other bytes is not enough.
test('a saved proposal stage session without its accepted presentation does not restore',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=await f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);agent.close();
 // The ledger refuses to accept bytes other than the attempted ones, so the row
 // is rewritten to hold another presentation, as the test above empties it.
 const bundle=input.buyerIdentityBundle,other=fixtureIdentityBundle(buyer,NOW+1),db=new Database(f.storePath);
 try{assert.equal(db.prepare("UPDATE kit_challenges SET accepted = json_set(accepted, '$.buyerBundleText', ?, '$.buyerBundleHash', ?) WHERE state = 'accepted'").run(canonicalize(other),identityBundleHash(other)).changes,1);}finally{db.close();}
 const state=await createSellerDurableState({dir:f.dir,integritySigner:f.config.signer,listingPin:listingPin(f.listing)});
 await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:bundle,buyerBundleHash:identityBundleHash(bundle),stage:'proposed'}));state.close();
 await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&/accepted presentation/.test(error.message));
});

test('an admitted proposal that claims no Vet stays readable at its proposed stage',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=await f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);
 assert.equal(agent.stageOf(JOB),'proposed','a session before Vet claims no Vet checkpoint or evidence');
 assert.equal(agent.transportAgreementOf(JOB),null);
 assert.deepEqual(agent.durableSessionOf(JOB),null);
});

test('a retained session past proposal without a Vet checkpoint refuses the restart',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=await f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);agent.close();
 const state=await createSellerDurableState({dir:f.dir,integritySigner:f.config.signer,listingPin:listingPin(f.listing)});
 await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:input.buyerIdentityBundle,buyerBundleHash:identityBundleHash(input.buyerIdentityBundle),stage:'agreed'}));
 state.close();
 await assert.rejects(f.open(),error=>error.code==='seller_state_unverified'&&/Vet checkpoint/.test(error.message));
});

test('a retained proposal stage session restores with only its challenge binding',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=await f.input(agent);await assert.rejects(agent.stagedProposal(input),staged);agent.close();
 const state=await createSellerDurableState({dir:f.dir,integritySigner:f.config.signer,listingPin:listingPin(f.listing)});
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
 const input=await f.input(agent,JOB,parameterized,undefined,buyer.claim),bundle=input.buyerIdentityBundle;input.transportIdentity.buyer=buyer.claim;
 await assert.rejects(agent.stagedProposal(input),staged);agent.close();
 const state=await createSellerDurableState({dir:f.dir,integritySigner:f.config.signer,listingPin:listingPin(f.listing)});
 await state.withJob(JOB,()=>state.saveSession({jobId:JOB,buyerBundle:bundle,buyerBundleHash:identityBundleHash(bundle),stage:'proposed'}));state.close();
 const fresh=await f.open();assert.equal(fresh.stageOf(JOB),'proposed');
});

test('a closed agent refuses proposal admission before it consumes the challenge',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=await f.input(agent);agent.close();
 await assert.rejects(agent.stagedProposal(input),error=>error.code==='seller_closed');
 const fresh=await f.open();await assert.rejects(fresh.stagedProposal(input),staged);
 assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1);
});

test('the native profile reads no session admission without its capability',async t=>{
 const f=await proposalAdmissionFixture(t),input=f.unadmitted();
 const missing=await createSellerAgent({...f.config,...f.signing,maxJobs:1,sessionAdmission:null});t.after(()=>missing.close());
 await assert.rejects(missing.admitSessionPresentation(admitRequest(input)),error=>error.code==='session_admission_required'&&error.status===503);
 missing.close();
 // A refused read retains nothing: the same presentation is still admitted by an agent that has the capability.
 const agent=await createSellerAgent({...f.config,...f.signing,maxJobs:1});t.after(()=>agent.close());
 assert.equal((await agent.admitSessionPresentation(admitRequest(input))).disposition,'admitted');
});

// The admitted attempt must fingerprint the complete presentation. The core
// contentHash drops top-level signature/signatures members, so comparing the
// attempt with it made a valid buyer-supplied extension unreadable.
test('an accepted presentation carrying an extra bundle member stays readable and restores',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=await f.input(agent,JOB,buyer,bundle=>{bundle.signature='TEST bundle extension';});
 await assert.rejects(agent.stagedProposal(input),staged);
 assert.equal(agent.stageOf(JOB),'proposed');agent.close();
 const state=await createSellerDurableState({dir:f.dir,integritySigner:f.config.signer,listingPin:listingPin(f.listing)});
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
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=f.unadmitted(),gate=await gatedRevocation(f);
 const pending=agent.admitSessionPresentation(admitRequest(input));await gate.started;agent.close();gate.release();
 await assert.rejects(pending,error=>error.code==='seller_closed');
 assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,0);
});
test('a close during an accepted replay revocation read refuses with the lifecycle error',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=await f.input(agent);
 await assert.rejects(agent.stagedProposal(input),staged);
 const gate=await gatedRevocation(f);
 const pending=agent.stagedProposal(input);await gate.started;agent.close();gate.release();
 await assert.rejects(pending,error=>error.code==='seller_closed');
});

// The transport identity is buyer-supplied. A proposal naming another seller
// must not reach the admission capability or retain an accepted presentation.
test('a proposal naming another seller is refused before admission',async t=>{
 const f=await proposalAdmissionFixture(t),agent=await f.open(),input=await f.input(agent);
 input.transportIdentity.seller=testWallet(44).claim;
 await assert.rejects(agent.stagedProposal(input),error=>error.code==='seller_mismatch'&&error.status===409);
 assert.equal(f.admission.calls.filter(([method])=>method==='admit').length,1,'only the context admission read the capability');
});
