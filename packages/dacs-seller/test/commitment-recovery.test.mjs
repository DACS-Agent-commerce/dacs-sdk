import test from'node:test';
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
