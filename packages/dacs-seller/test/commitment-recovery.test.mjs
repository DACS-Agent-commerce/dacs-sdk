import test from'node:test';
import {readFileSync}from'node:fs';
const stageSource=readFileSync(new URL('../src/dacs/seller-agent.mjs',import.meta.url),'utf8');
const nativeStaged=stageSource.includes('typeof submitNativePaymentEvidence')&&!stageSource.includes('async function submitNativePaymentEvidence(');
const nativeCommit=(name,run)=>test(name,{skip:nativeStaged},run);
import assert from'node:assert/strict';
import * as core from'@kynesyslabs/dacs';
import {commitmentFixture}from'./helpers/commitment-fixture.mjs';
import {finalizedCommitmentReader} from './helpers/finalized-commitment-reader.mjs';
import {anchorFixture}from'./helpers/anchor-isolated-fixture.mjs';
import {readbackFixture}from'./helpers/sr2-readback-fixture.mjs';
import {seller,buyer,JOB,NOW}from'./helpers/protocol-fixture.mjs';
import {localAnchor,signAnchorWrite}from'./helpers/local-anchor-fixture.mjs';
import {contributionVerifier,agreementInput}from'../src/dacs/purchase-protocol.mjs';
import {buildStorageProgramCreatePayload,deriveStorageAddress}from'../src/dacs/wallet-transactions.mjs';
import {createSellerAgent}from'../src/dacs/seller-agent.mjs';
import {fixtureListing,fixtureIdentityBundle}from'./fixtures/listings.mjs';
function projection(agreement){const logicalAddress=core.fixedPriceAgreementLogicalAddress(agreement.jobId),programName=core.logicalToStorageProgramName(logicalAddress),storageAddress=deriveStorageAddress(buyer.address,programName,1,'');const tx=buildStorageProgramCreatePayload({from:buyer.address,storageAddress,programName,logicalAddress,signedListing:agreement,nonce:1,timestamp:NOW});tx.content.from_ed25519_address=buyer.address;Object.assign(tx.content.data[1].metadata,{artifactKind:'Agreement',contentHash:core.contentHash(agreement),envelopeHash:core.sha256Hex(core.canonicalize(agreement))});tx.hash=core.sha256Hex(JSON.stringify(tx.content));tx.signature={type:'ed25519',data:'0x'+buyer.signBytes(Buffer.from(tx.hash)).toString('hex')};return tx;}
nativeCommit('successful native commitment replays exact state after restart and rejects contradictory block time',async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare();assert.equal((await agent.commit({jobId:JOB})).status,'committed');const kept=agent.durableSessionOf(JOB).commitment;agent.close();const fresh=await f.open();assert.equal((await fresh.commit({jobId:JOB})).status,'committed');assert.deepEqual(fresh.durableSessionOf(JOB).commitment,kept);assert.equal(f.local.writes.length,1);
 f.local.controls.read=row=>row.status==='present'?{...row,receipt:{...row.receipt,blockRef:{...row.receipt.blockRef,timestamp:row.receipt.blockRef.timestamp+1000}}}:row;
 await assert.rejects(fresh.commit({jobId:JOB}),e=>e.code==='commitment_changed');assert.deepEqual(fresh.durableSessionOf(JOB).commitment,kept);
});
nativeCommit('real publisher proves an empty pre-intent journal and recovers a failed nonce read after restart',async t=>{
 const publisher=await anchorFixture({now:()=>NOW}),f=await commitmentFixture(t,{publisher:publisher.open()}),{agent}=await f.prepare();publisher.source.readRpc=async()=>({result:503,response:null,require_reply:false,extra:null});
 let failure;try{await agent.commit({jobId:JOB});}catch(error){failure=error;}assert.equal(failure?.code,'commitment_failed');assert.equal(publisher.journal.rows.size,0);assert.equal(publisher.captured.length,0);agent.close();
 publisher.source.readRpc=async()=>({result:200,response:0,require_reply:false,extra:null});publisher.source.binding=async()=>({disposition:'included'});publisher.source.observeBinding=async()=>publisher.source.transportBinding;
 publisher.controls.request=async request=>{const signed=structuredClone(request.transaction);signed.hash=core.sha256Hex(JSON.stringify(signed.content));signed.signature={type:'ed25519',data:'0x'+seller.signBytes(Buffer.from(signed.hash)).toString('hex')};const backend=readbackFixture({signedTransaction:signed,observedAt:NOW});const finalized=finalizedCommitmentReader(backend.adapter,{claim:seller.claim,sign:seller.signBytes});finalized.record({logicalAddress:backend.logicalAddress,artifact:backend.artifact,signedProjection:signed,blockRef:{id:backend.state.block.hash,height:String(backend.state.block.number),timestamp:NOW}});Object.assign(publisher.controls.reader,finalized);await publisher.sourceJournal.put('TEST accepted',{stage:'observed',hash:signed.hash,signedTransaction:signed});return{success:true,data:{hash:signed.hash,writeProof:{disposition:'included'}}};};
 const fresh=await f.open();assert.equal((await fresh.commit({jobId:JOB})).status,'committed');assert.equal(publisher.captured.length,1);
});
for(const early of[false,true])nativeCommit(`early commitment ${early?'enabled':'disabled'} is explicit and never duplicated`,async t=>{
 const f=await commitmentFixture(t,{early}),{agent,agreement}=await f.prepare(),request={jobId:JOB,agreement,signedProjection:projection(agreement)};
 if(!early){await assert.rejects(agent.commitOnSignature(request),e=>e.code==='signature_commitment_disabled');assert.equal(f.local.writes.length,0);return;}
 f.controls.agreement=null;assert.equal((await agent.commitOnSignature(request)).status,'commitment-held');assert.equal((await agent.commitOnSignature(request)).status,'commitment-held');assert.equal(f.local.writes.length,1);
});
async function fixtureProfile(t){
 const listing=fixtureListing(seller,{now:NOW}),bundle=fixtureIdentityBundle(buyer,NOW),input=agreementInput({jobId:JOB,listing,buyerBundle:bundle,generatedAt:NOW}),plan=core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(input)),contribution=await core.createFixedPriceAgreementSignatureContribution(plan,'buyer',{party:buyer.claim,algorithm:'ed25519',sign:buyer.signBytes});const material={proposalVersion:'1',plan,buyerContribution:contribution},proposal={...material,proposalHash:core.sha256Hex(core.canonicalize(material))},transportIdentity={jobId:JOB,planHash:plan.planHash,agreementHash:plan.agreementHash,buyer:buyer.claim,seller:seller.claim,proposalHash:proposal.proposalHash};
 const anchors=localAnchor({now:()=>NOW}),agent=await createSellerAgent({signer:{claim:seller.claim,sign:seller.signBytes},listing,anchors,simulatedFixture:true,now:()=>NOW});t.after(()=>agent.close());const response=await agent.receiveProposal({proposal,transportIdentity,buyerIdentityBundle:bundle});assert.equal(response.disposition,'complete');const agreement=await core.finalizeFixedPriceAgreementContributions(plan,[contribution,response.contribution],contributionVerifier),address=core.fixedPriceAgreementLogicalAddress(JOB);await anchors.write({logicalAddress:address,artifact:agreement,writer:buyer.claim,writerSignature:signAnchorWrite(buyer.signBytes,address,core.contentHash(agreement))});return{agent,anchors};
}
test('memory fixture commitment rechecks its authoritative anchor on every repeat',async t=>{
 const f=await fixtureProfile(t);assert.equal((await f.agent.commit({jobId:JOB})).status,'committed');const writes=f.anchors.writes.length;f.anchors.controls.read=(row,address)=>address===core.finalityCommitmentAddress(JOB)?{status:'absent'}:row;await assert.rejects(f.agent.commit({jobId:JOB}));assert.equal(f.anchors.writes.length,writes);
});
for(const read of[null,{status:'indeterminate',reason:'TEST read timeout'},{status:'rejected',reason:'TEST invalid receipt'},{status:'absent'}])test(`fixture Agreement read classifies ${read?.status??'missing'} before commitment`,async t=>{
 const f=await fixtureProfile(t);f.anchors.controls.read=()=>read;await assert.rejects(f.agent.commit({jobId:JOB}),e=>e.code===(read?.status==='absent'?'agreement_not_anchored':read?.status==='rejected'?'agreement_anchor_invalid':'substrate_unavailable'));
});

nativeCommit('commitment wrapper keeps the actual provider failure chain',async t=>{
 const f=await commitmentFixture(t),cause=Object.assign(new Error('TEST wallet connection refused'),{code:'ECONNREFUSED'});f.native.publish=async()=>{throw cause;};const {agent}=await f.prepare();await assert.rejects(agent.commit({jobId:JOB}),error=>error.code==='commitment_failed'&&error.cause?.cause===cause);
});

nativeCommit('valid native receipts may omit the optional nonce and still replay',async t=>{
 const f=await commitmentFixture(t),read=f.native.readRetained;f.native.readRetained=async input=>{const out=await read(input);if(out.receipt)delete out.receipt.nonce;return out;};const {agent}=await f.prepare();await agent.commit({jobId:JOB});assert.equal((await agent.commit({jobId:JOB})).status,'committed');
});
for(const changed of['proof','time','phase'])nativeCommit(`retained native checkpoint ${changed} is reauthenticated before cached success`,async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare();await agent.commit({jobId:JOB});agent.close();const {createSellerDurableState}=await import('../src/dacs/seller-durable-state.mjs');const {listingPin}=await import('../src/dacs/purchase-protocol.mjs');const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:listingPin(f.listing)});
 try{await state.withJob(JOB,session=>{if(changed==='proof')session.commitment.anchorReceipt.evidence.value='TEST-broken-proof';else if(changed==='time')session.commitment.committedAt++;else session.phaseResults[1].invokedAt++;state.saveSession(session);});}finally{state.close();}
 const fresh=await f.open();await assert.rejects(fresh.commit({jobId:JOB}),e=>['commitment_changed','seller_phase_conflict'].includes(e.code));assert.equal(f.local.writes.length,1);
});
