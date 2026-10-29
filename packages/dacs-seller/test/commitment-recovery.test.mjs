import test from'node:test';
// Native success controls resume with the native settlement part; this part proves refusal.
const nativeCommitmentTest=test.skip;
import assert from'node:assert/strict';
import * as core from'@kynesyslabs/dacs';
import {commitmentFixture}from'./helpers/commitment-fixture.mjs';
import {anchorFixture}from'./helpers/anchor-isolated-fixture.mjs';
import {readbackFixture}from'./helpers/sr2-readback-fixture.mjs';
import {seller,buyer,JOB,NOW}from'./helpers/protocol-fixture.mjs';
import {localAnchor,signAnchorWrite}from'./helpers/local-anchor-fixture.mjs';
import {contributionVerifier,agreementInput}from'../src/dacs/purchase-protocol.mjs';
import {buildStorageProgramCreatePayload,deriveStorageAddress}from'../src/dacs/wallet-transactions.mjs';
import {createSellerAgent}from'../src/dacs/seller-agent.mjs';
import {fixtureListing,fixtureIdentityBundle}from'./fixtures/listings.mjs';
import {createSellerHttpHandler}from'../src/dacs/seller-http.mjs';
import {provenUnsignedAbsence}from'../src/dacs/native-dem-delivery-consumer.mjs';
import {exchange}from'./helpers/d5-http-fixture.mjs';
function projection(agreement){const logicalAddress=core.fixedPriceAgreementLogicalAddress(agreement.jobId),programName=core.logicalToStorageProgramName(logicalAddress),storageAddress=deriveStorageAddress(buyer.address,programName,1,'');const tx=buildStorageProgramCreatePayload({from:buyer.address,storageAddress,programName,logicalAddress,signedListing:agreement,nonce:1,timestamp:NOW});tx.content.from_ed25519_address=buyer.address;Object.assign(tx.content.data[1].metadata,{artifactKind:'Agreement',contentHash:core.contentHash(agreement),envelopeHash:core.sha256Hex(core.canonicalize(agreement))});tx.hash=core.sha256Hex(JSON.stringify(tx.content));tx.signature={type:'ed25519',data:'0x'+buyer.signBytes(Buffer.from(tx.hash)).toString('hex')};return tx;}
for(const early of [false,true])test(`cached fixture ${early?'signature':'ordinary'} commitment authenticates every HTTP replay`,async t=>{
 const {agentFixture}=await import('./helpers/seller-agent-isolated-fixture.mjs'),{JOBS}=await import('./helpers/bilateral-vet-fixture.mjs');
 const w=await agentFixture({early});t.after(()=>w.close());
 const {jobId,agreement,signedProjection}=await w.negotiate(JOBS[0],{anchor:false}),agent=w.agent;
 const body=early?{jobId,agreement,signedProjection}:{jobId};
 const cached=await (early?agent.commitOnSignature(body):agent.commit(body)),writes=w.anchors.writes.length;
 const store={reserve:()=>({disposition:'cached',status:200,text:JSON.stringify(cached)})};
 const authentication={seller:agent.claim,listingPin:agent.listingPin,store,readRequest:()=>({jobId}),validate(){},responseHeader:async()=> 'TEST-header'};
 const handler=createSellerHttpHandler(agent,{authentication,commitOnSignature:early});
 const post=()=>exchange(handler,{url:early?'/dacs/v1/commitments/signature':'/dacs/v1/commitments',text:JSON.stringify(body)});
 assert.equal((await post()).status,200);
 const read=w.anchors.controls.read;
 w.anchors.controls.read=(row,address)=>address===core.finalityCommitmentAddress(jobId)&&row.status==='present'?{...row,receipt:{...row.receipt,evidence:{...row.receipt.evidence,value:'TEST changed proof'}}}:row;
 for(let attempt=0;attempt<2;attempt++)assert.equal((await post()).status,503);
 w.anchors.controls.read=read;assert.equal((await post()).status,200);assert.equal(w.anchors.writes.length,writes);
});
for(const early of [false,true])test(`native ${early?'signature':'ordinary'} commitment is explicitly staged without effects`,async t=>{
 const f=await commitmentFixture(t,{early}),{agent,agreement}=await f.prepare();
 const body=early?{jobId:JOB,agreement,signedProjection:projection(agreement)}:{jobId:JOB};
 await assert.rejects(early?agent.commitOnSignature(body):agent.commit(body),{code:'settlement_profile_unavailable'});
 assert.equal(f.local.writes.length,0);
});
// An early attempt that persisted its intent but published no CREATE (wallet
// refusal, transient read, restart) must still sign on the retry once the
// seller holds an authenticated proof that nothing was signed.
nativeCommitmentTest('an early commitment whose first publish signed nothing signs once on the authenticated retry',async t=>{
 const f=await commitmentFixture(t,{early:true}),{agent,agreement}=await f.prepare(),request={jobId:JOB,agreement,signedProjection:projection(agreement)};
 const absent=f.native.readRetained,publish=f.native.publish;let publishes=0;
 f.native.readRetained=async input=>{const out=await absent(input);return out.status==='absent'?provenUnsignedAbsence('TEST no seller-signed intent'):out;};
 f.native.publish=async input=>{publishes+=1;if(publishes===1)throw new Error('TEST wallet refused');return publish(input);};
 let failure;try{await agent.commitOnSignature(request);}catch(error){failure=error;}
 assert.equal(failure?.code,'commitment_failed');assert.equal(f.local.writes.length,0);agent.close();
 const fresh=await f.open(),retried=await fresh.commitOnSignature(request);
 assert.equal(retried.status,'commitment-held');assert.equal(publishes,2,'the proven-unsigned retry publishes exactly once');assert.equal(f.local.writes.length,1);
});
// DACS-3 §8.5.2: the pre-anchor notAfter check uses the current clock. A retry
// that signed no CREATE is a new publication and cannot inherit a provisional
// time from an attempt made while the Listing was still live.
nativeCommitmentTest('a retry that signed no commitment CREATE cannot publish after the Listing expired',async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare(),absent=f.native.readRetained,publish=f.native.publish;
 f.native.readRetained=async input=>{const out=await absent(input);return out.status==='absent'?provenUnsignedAbsence('TEST no seller-signed intent'):out;};
 f.native.publish=async()=>{throw new Error('TEST wallet refused');};
 await assert.rejects(agent.commit({jobId:JOB}),e=>e.code==='commitment_failed');assert.equal(f.local.writes.length,0);agent.close();
 f.native.publish=publish;f.advance(f.listing.validity.notAfter-NOW+1);
 const fresh=await f.open();
 await assert.rejects(fresh.commit({jobId:JOB}),e=>e.code==='commitment_failed'&&/provisional time checks/.test(e.message));
 assert.equal(f.local.writes.length,0,'a commitment CREATE is never requested after the Listing expired');
});
// C-1: a wallet refusal leaves an unsigned intent. The retry re-stamps the
// provisional time (the Listing check uses the current clock), so the real
// publisher must replace that proven-unsigned intent instead of refusing the
// new record as an immutable conflict; otherwise a temporary wallet refusal or
// shutdown strands the job forever.
nativeCommitmentTest('an advancing-clock retry replaces a proven-unsigned commitment intent',async t=>{
 let publisherTime=NOW;const publisher=await anchorFixture({now:()=>publisherTime}),f=await commitmentFixture(t,{publisher:publisher.open()}),{agent}=await f.prepare();
 let failure;try{await agent.commit({jobId:JOB});}catch(error){failure=error;}
 assert.equal(failure?.code,'commitment_failed');assert.equal(publisher.journal.rows.size,1);assert.equal(publisher.captured.length,1);
 assert.equal([...publisher.journal.rows.values()][0].stage,'unsigned','the wallet refusal retained an unsigned intent');
 agent.close();f.advance(1000);publisherTime+=1000;
 publisher.source.binding=async()=>({disposition:'included'});publisher.source.observeBinding=async()=>publisher.source.transportBinding;
 publisher.controls.request=async request=>{const signed=structuredClone(request.transaction);signed.hash=core.sha256Hex(JSON.stringify(signed.content));signed.signature={type:'ed25519',data:'0x'+seller.signBytes(Buffer.from(signed.hash)).toString('hex')};const backend=readbackFixture({signedTransaction:signed,observedAt:NOW});Object.assign(publisher.controls.reader,backend.adapter);await publisher.sourceJournal.put('TEST accepted',{stage:'observed',hash:signed.hash,signedTransaction:signed});return{success:true,data:{hash:signed.hash,writeProof:{disposition:'included'}}};};
 const fresh=await f.open();
 await assert.rejects(fresh.commit({jobId:JOB}),error=>error.code==='commitment_failed');
 assert.equal(publisher.captured.length,2,'the proven-unsigned retry asks the wallet once more');
 assert.notEqual([...publisher.journal.rows.values()][0].stage,'unsigned');
});
async function fixtureProfile(t,inspect=false){
 const create=inspect?(await (await import('./helpers/private-module.mjs')).privateModule(new URL('../src/dacs/seller-agent.mjs',import.meta.url),[],source=>source.replace('  return api;','  return {...api,TESTsessions:sessions};'))).createSellerAgent:createSellerAgent;
 const listing=fixtureListing(seller,{now:NOW}),bundle=fixtureIdentityBundle(buyer,NOW),input=agreementInput({jobId:JOB,listing,buyerBundle:bundle,generatedAt:NOW}),plan=core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(input)),contribution=await core.createFixedPriceAgreementSignatureContribution(plan,'buyer',{party:buyer.claim,algorithm:'ed25519',sign:buyer.signBytes});const material={proposalVersion:'1',plan,buyerContribution:contribution},proposal={...material,proposalHash:core.sha256Hex(core.canonicalize(material))},transportIdentity={jobId:JOB,planHash:plan.planHash,agreementHash:plan.agreementHash,buyer:buyer.claim,seller:seller.claim,proposalHash:proposal.proposalHash};
 const anchors=localAnchor({now:()=>NOW}),agent=await create({signer:{claim:seller.claim,sign:seller.signBytes},listing,anchors,simulatedFixture:true,now:()=>NOW});t.after(()=>agent.close());const response=await agent.receiveProposal({proposal,transportIdentity,buyerIdentityBundle:bundle});assert.equal(response.disposition,'complete');const agreement=await core.finalizeFixedPriceAgreementContributions(plan,[contribution,response.contribution],contributionVerifier),address=core.fixedPriceAgreementLogicalAddress(JOB);await anchors.write({logicalAddress:address,artifact:agreement,writer:buyer.claim,writerSignature:signAnchorWrite(buyer.signBytes,address,core.contentHash(agreement))});return{agent,anchors};
}
test('memory fixture commitment rechecks its authoritative anchor on every repeat',async t=>{
 const f=await fixtureProfile(t);assert.equal((await f.agent.commit({jobId:JOB})).status,'committed');const writes=f.anchors.writes.length;f.anchors.controls.read=(row,address)=>address===core.finalityCommitmentAddress(JOB)?{status:'absent'}:row;await assert.rejects(f.agent.commit({jobId:JOB}));assert.equal(f.anchors.writes.length,writes);
});
for(const read of[null,{status:'indeterminate',reason:'TEST read timeout'},{status:'rejected',reason:'TEST invalid receipt'},{status:'absent'}])test(`fixture Agreement read classifies ${read?.status??'missing'} before commitment`,async t=>{
 const f=await fixtureProfile(t);f.anchors.controls.read=()=>read;await assert.rejects(f.agent.commit({jobId:JOB}),e=>e.code===(read?.status==='absent'?'agreement_not_anchored':read?.status==='rejected'?'agreement_anchor_invalid':'substrate_unavailable'));
});

for(const stage of ['delivered','copies-exchanged'])for(const failing of [false,true])test(`fixture commitment readback preserves ${stage} on ${failing?'failure':'success'}`,async t=>{
 const f=await fixtureProfile(t,true),agent=f.agent;await agent.commit({jobId:JOB});agent.TESTsessions.get(JOB).stage=stage;
 if(failing){f.anchors.controls.read=()=>({status:'indeterminate'});await assert.rejects(agent.commit({jobId:JOB}),e=>e.code==='substrate_unavailable');}else assert.equal((await agent.commit({jobId:JOB})).status,'committed');
 assert.equal(agent.stageOf(JOB),stage);
});

test('read-only commitment authentication with no retained CREATE never signs or publishes',async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare();let signs=0;
 f.config.signer.sign=()=>{signs++;throw new Error('TEST read-only signer called');};
 await assert.rejects(agent.readCommitment({jobId:JOB}),error=>error.code==='settlement_profile_unavailable');
 assert.equal(f.local.writes.length,0);assert.equal(signs,0);
});

test('fixture read-only commitment without a retained CREATE has zero effects',async t=>{
 const f=await fixtureProfile(t),writes=f.anchors.writes.length;
 await assert.rejects(f.agent.readCommitment({jobId:JOB}),{code:'commitment_readback_required'});
 assert.equal(f.anchors.writes.length,writes);
});
function agentHttp(agent,request,store,options={}){return createSellerHttpHandler(agent,{...options,authentication:{seller:agent.claim,listingPin:agent.listingPin,store,readRequest:()=>request,validate(){},responseHeader:async()=> 'TEST-header'}});}
function commitmentRequest(agent,agreementHash,jobId=JOB){return{method:'POST',path:'/dacs/v1/commitments',jobId,seller:seller.claim,buyer:buyer.claim,listingPin:agent.listingPin,agreementHash};}
function uncertainStore(){const reconciles=[];return{reconciles,reserve:()=>({disposition:'uncertain',effectKey:'TEST-effect',owner:'TEST-owner'}),reconcile(...args){reconciles.push(args);}};}
function performStore(){const finishes=[];return{finishes,reserve:()=>({disposition:'perform',effectKey:'TEST-effect',owner:'TEST-owner'}),finish(...args){finishes.push(args);}};}

for(const restart of[false,true])nativeCommitmentTest(`uncertain commitment ${restart?'after restart':'replay'} completes from the retained finalized receipt`,async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare();assert.equal((await agent.commit({jobId:JOB})).status,'committed');
 const writes=f.local.writes.length;if(restart)agent.close();const live=restart?await f.open():agent;
 const store=uncertainStore(),request=commitmentRequest(live,core.contentHash(f.controls.agreement.artifact));
 const res=await exchange(agentHttp(live,request,store),{url:'/dacs/v1/commitments',text:JSON.stringify({jobId:JOB})});
 assert.equal(res.status,200);assert.equal(JSON.parse(res.text).status,'committed');
 assert.equal(store.reconciles.length,1);assert.equal(store.reconciles[0][2],200);assert.equal(f.local.writes.length,writes);
});

nativeCommitmentTest('uncertain commitment replay holds when the fresh receipt no longer authenticates',async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare();assert.equal((await agent.commit({jobId:JOB})).status,'committed');
 const writes=f.local.writes.length;f.local.controls.read=row=>row.status==='present'?{...row,receipt:{...row.receipt,contentHash:'0'.repeat(64)}}:row;
 const store=uncertainStore(),request=commitmentRequest(agent,core.contentHash(f.controls.agreement.artifact));
 const res=await exchange(agentHttp(agent,request,store),{url:'/dacs/v1/commitments',text:JSON.stringify({jobId:JOB})});
 assert.equal(res.status,503);assert.equal(store.reconciles.length,0);assert.equal(f.local.writes.length,writes);
});

nativeCommitmentTest('uncertain commitment with proven unsigned absence runs the authenticated request once',async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare(),read=f.native.readRetained;
 f.native.readRetained=async input=>{const out=await read(input);return out.status==='absent'?provenUnsignedAbsence('TEST no seller-signed intent'):out;};
 const request=commitmentRequest(agent,core.contentHash(f.controls.agreement.artifact)),rawBody=Buffer.from(JSON.stringify({jobId:JOB}));
 const answer=await agent.reconcileTransport({request,body:{jobId:JOB},rawBody});
 assert.equal(answer.disposition,'present');assert.equal(answer.value.status,'committed');assert.equal(f.local.writes.length,1);
});

test('an uncertain signature commitment without an Agreement never takes the ordinary path',async t=>{
 const f=await commitmentFixture(t,{early:true}),{agent}=await f.prepare(),read=f.native.readRetained;
 f.native.readRetained=async input=>{const out=await read(input);return out.status==='absent'?provenUnsignedAbsence('TEST no seller-signed intent'):out;};
 const request={...commitmentRequest(agent,core.contentHash(f.controls.agreement.artifact)),path:'/dacs/v1/commitments/signature'},writes=f.local.writes.length;
 const answer=await agent.reconcileTransport({request,body:{jobId:JOB},rawBody:Buffer.from(JSON.stringify({jobId:JOB}))});
 assert.equal(answer.disposition,'indeterminate');
 assert.equal(f.local.writes.length,writes,'a signature request without an Agreement never publishes an ordinary commitment');
});

nativeCommitmentTest('malformed early Agreement is a definite refusal before any effect',async t=>{
 const f=await commitmentFixture(t,{early:true}),{agent}=await f.prepare();let failure;
 try{await agent.commitOnSignature({jobId:JOB,agreement:{},signedProjection:{}});}catch(error){failure=error;}
 assert.equal(failure?.code,'signature_agreement_invalid');assert.equal(failure?.status,422);assert.equal(f.local.writes.length,0);
});

test('signature_agreement_invalid is a definite no-effect HTTP refusal',async()=>{
 const {SellerAgentError}=await import('../src/dacs/seller-agent.mjs'),store=performStore();
 const agent={claim:'TEST-seller',listingPin:{TEST:'pin'},commitOnSignature:async()=>{throw new SellerAgentError('signature_agreement_invalid','TEST malformed early Agreement',422);}};
 const authentication={seller:agent.claim,listingPin:agent.listingPin,store,readRequest:()=>({jobId:JOB}),validate(){},responseHeader:async()=> 'TEST-header'};
 const res=await exchange(createSellerHttpHandler(agent,{authentication,commitOnSignature:true}),{url:'/dacs/v1/commitments/signature',text:JSON.stringify({jobId:JOB,agreement:{},signedProjection:{}})});
 assert.equal(res.status,422);assert.equal(JSON.parse(res.text).error,'signature_agreement_invalid');
 assert.equal(store.finishes.length,1);assert.equal(store.finishes[0][3].noEffect,true);
});

nativeCommitmentTest('native Agreement present without an artifact is a definite refusal before any effect',async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare();
 f.controls.read=()=>({disposition:'present',artifact:null,ref:{anchor:{kind:'storage-program',locator:core.fixedPriceAgreementLogicalAddress(JOB)},contentHash:'a'.repeat(64)},native:{source:'TEST-native-agreement',evidenceMode:'TEST-writer-proof',nativeAddress:'TEST-native',txRef:{kind:'demos',txHash:'b'.repeat(64),blockNumber:1}}});
 let failure;try{await agent.commit({jobId:JOB});}catch(error){failure=error;}
 assert.equal(failure?.code,'agreement_anchor_invalid');assert.equal(failure?.status,422);assert.equal(f.local.writes.length,0);
});

test('fixture commitment replay accepts a fresh observation time without rewriting retained bytes',async t=>{
 const f=await fixtureProfile(t,true),agent=f.agent;assert.equal((await agent.commit({jobId:JOB})).status,'committed');
 const kept=structuredClone(agent.TESTsessions.get(JOB)),writes=f.anchors.writes.length;
 f.anchors.controls.read=row=>row.status==='present'?{...row,receipt:{...row.receipt,observedAt:NOW+1000}}:row;
 assert.equal((await agent.commit({jobId:JOB})).status,'committed');
 assert.deepEqual(agent.TESTsessions.get(JOB).commitment,kept.commitment);
 assert.deepEqual(agent.TESTsessions.get(JOB).phaseResults,kept.phaseResults);
 assert.equal(f.anchors.writes.length,writes);
});
