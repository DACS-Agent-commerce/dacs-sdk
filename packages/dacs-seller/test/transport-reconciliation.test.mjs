import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import {createServer} from 'node:http';
import {createSellerHttpHandler,createSellerAgentClient} from '../src/dacs/seller-http.mjs';
import {join} from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createSellerDurableState} from '../src/dacs/seller-durable-state.mjs';
import {agentFixture} from './helpers/seller-agent-isolated-fixture.mjs';
import {proposalAdmissionFixture} from './helpers/proposal-admission-fixture.mjs';
import {commitmentFixture} from './helpers/commitment-fixture.mjs';
import {seller,buyer,JOB,NOW} from './helpers/protocol-fixture.mjs';
import {JOBS} from './helpers/bilateral-vet-fixture.mjs';
import {createSellerTransportStore,createSellerTransportClientAuth,createSellerTransportServerAuth} from '../src/dacs/seller-transport-auth.mjs';
function command(agent,path,body,agreementHash){const rawBody=Buffer.from(JSON.stringify(body));return{body,rawBody,request:{method:'POST',path,jobId:body.transportIdentity?.jobId??body.jobId,buyer:buyer.claim,seller:seller.claim,listingPin:agent.listingPin,agreementHash,bodyHash:core.sha256Hex(rawBody)}};}
test('read-only commitment reconciliation neither signs nor publishes absent work and authenticates retained work',async()=>{
 const f=await agentFixture({lifecycle:true});try{const jobId=JOBS[0],request=command(f.agent,'/dacs/v1/commitments',{jobId},f.agent.durableSessionOf(jobId).agreementHash),before=f.anchors.writes.length;assert.equal((await f.agent.reconcileTransport({...request,readOnly:true})).disposition,'indeterminate');assert.equal(f.anchors.writes.length,before);await f.agent.commit({jobId});const writes=f.anchors.writes.length;assert.equal((await f.agent.reconcileTransport({...request,readOnly:true})).disposition,'present');assert.equal(f.anchors.writes.length,writes);}finally{f.close();}
});
test('read-only proposal reconciliation cannot produce a missing contribution and replays a retained one without signing',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),request=command(agent,'/dacs/v1/agreements/proposals',body,body.proposal.plan.agreementHash),signed=f.signed.length;
 assert.equal((await agent.reconcileTransport({...request,readOnly:true})).disposition,'indeterminate');assert.equal(f.signed.length,signed);const answer=await agent.receiveProposal(body),after=f.signed.length;assert.equal(answer.disposition,'complete');assert.equal((await agent.reconcileTransport({...request,readOnly:true})).disposition,'present');assert.equal(f.signed.length,after);
});
test('crash before agent, rejected proposal, then corrected proposal releases only the proven unsigned HTTP slot',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),path='/dacs/v1/agreements/proposals',store=createSellerTransportStore({path:join(f.dir,'TEST-peer.sqlite'),now:()=>NOW});t.after(()=>store.close());
 let currentHash=body.proposal.plan.agreementHash;const client=createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:seller.claim,resolveJob:()=>({listingPin:agent.listingPin,agreementHash:currentHash}),now:()=>NOW}),auth=createSellerTransportServerAuth({sellerSigner:{claim:seller.claim,sign:seller.signBytes},listingPin:agent.listingPin,store,now:()=>NOW});
 const envelope=await client.request(path,body,JSON.stringify(body)),request=auth.readRequest(envelope.header);assert.equal(store.reserve(request,body).disposition,'perform');
 if(path==='/dacs/v1/payments'){const prime={...request,path:'/dacs/v1/agreements/proposals',nonce:'e'.repeat(64)};store.finish(store.reserve(prime,{}),200,'{}');}
 const server=createServer(createSellerHttpHandler(agent,{authentication:auth}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 const peer=createSellerAgentClient({url:`http://127.0.0.1:${server.address().port}`,authentication:client});
 f.admission.verifyReceiptWith(()=> 'invalid');const out=await peer.propose(body);assert.equal(out.disposition,'rejected');
 f.admission.verifyReceiptWith(null);const corrected=await f.proposal(agent);currentHash=corrected.proposal.plan.agreementHash;assert.equal((await peer.propose(corrected)).disposition,'complete');
});
for(const status of ['absent','indeterminate','rejected'])test(`native Agreement reconciliation preserves ${status} classification and actual cause`,async t=>{
 const f=await commitmentFixture(t),{agent}=await f.prepare(),cause=new Error('TEST authenticated reader '+status);f.controls.read=()=>({disposition:status,cause});const request=command(agent,'/dacs/v1/commitments',{jobId:JOB},agent.durableSessionOf(JOB).agreementHash),out=await agent.reconcileTransport({...request,readOnly:true});assert.equal(out.disposition,'indeterminate');assert.equal(out.reason,status==='absent'?'agreement_not_anchored':status==='rejected'?'agreement_anchor_invalid':'substrate_unavailable');if(status!=='absent')assert.equal(out.cause?.cause,cause);assert.equal(f.local.writes.length,0);
});

test('actual resume recovers a lost fixture evidence answer after reopen without another CREATE',async()=>{
 const f=await agentFixture({lifecycle:true});try{const jobId=JOBS[0],address=core.paymentEvidenceAddress(jobId,'demos-native:DEM',2);await f.agent.commit({jobId});f.anchors.controls.failAfterWrite=address;await assert.rejects(f.agent.submitPayment({jobId,txHash:'a'.repeat(64),payerPayingKey:buyer.claim}));await f.reopen();assert.notEqual((await f.agent.reconcile({jobId})).status,'held');assert.equal((await f.agent.resume({jobId})).status,'delivered');assert.equal(f.anchors.writes.filter(a=>a===address).length,1);}finally{f.close();}
});

async function transport(t,agent,dir,body,path='/dacs/v1/agreements/proposals'){
 const store=createSellerTransportStore({path:join(dir,'TEST-recovery.sqlite'),now:()=>NOW});t.after(()=>store.close());
 let hash=body.proposal?.plan.agreementHash??core.contentHash(agent.transportAgreementOf(body.jobId));
 const client=createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:seller.claim,resolveJob:()=>({listingPin:agent.listingPin,agreementHash:hash}),now:()=>NOW});
 const auth=createSellerTransportServerAuth({sellerSigner:{claim:seller.claim,sign:seller.signBytes},listingPin:agent.listingPin,store,now:()=>NOW});
 const envelope=await client.request(path,body,JSON.stringify(body)),request=auth.readRequest(envelope.header);
 if(path==='/dacs/v1/payments'){const prime={...request,path:'/dacs/v1/agreements/proposals',nonce:'e'.repeat(64)};store.finish(store.reserve(prime,{}),200,'{}');}
 const server=createServer(createSellerHttpHandler(agent,{authentication:auth}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 return{store,request,client,auth,peer:createSellerAgentClient({url:`http://127.0.0.1:${server.address().port}`,authentication:client}),setHash:value=>{hash=value;}};
}
for(const answer of ['waiting','indeterminate'])test(`pending proposal recovers ${answer} and keeps its exact retry slot`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),w=await transport(t,agent,f.dir,body);
 const first=w.store.reserve(w.request,body);assert.equal(first.disposition,'perform');
 let leases,lease;
 if(answer==='waiting')t.mock.timers.enable({apis:['Date'],now:NOW});
 if(answer==='waiting'){leases=await core.createFsFencedSessionStore({dir:join(f.dir,'sdk-agreements')});await leases.create({jobId:JOB,agreementHash:body.proposal.plan.agreementHash,phase:'agreement:plan-binding',now:Date.now()});lease=await leases.acquireLease({jobId:JOB,owner:'TEST-other-worker',ttlMs:60000,now:Date.now()});assert.equal(lease.ok,true);}
 else f.admission.verifyReceiptWith(()=> 'indeterminate');
 const out=await w.peer.propose(body);assert.equal(out.disposition,answer);
 assert.throws(()=>w.store.finish(first,200,'{}'),{code:'peer_store_conflict'});
 f.admission.verifyReceiptWith(null);
 if(answer==='waiting')t.mock.timers.tick(60001);
 assert.equal((await w.peer.propose(body)).disposition,'complete');
});
test('pending unauthenticated presentation releases its slot for a corrected proposal',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);body.buyerIdentityBundle.sessionNonce='f'.repeat(64);
 const w=await transport(t,agent,f.dir,body);w.store.reserve(w.request,body);
 const out=await w.peer.propose(body);assert.equal(out.disposition,'rejected');assert.equal(out.reason,'buyer_bundle_unauthenticated');assert.equal(agent.durableSessionOf(JOB),null);
 const corrected=await f.proposal(agent);w.setHash(corrected.proposal.plan.agreementHash);assert.equal((await w.peer.propose(corrected)).disposition,'complete');
});
for(const state of ['included','pending'])test(`fixture payment before work checkpoint recovers ${state} intake after a pending reservation`,async t=>{
 const f=await agentFixture({lifecycle:true});t.after(()=>f.close());const jobId=JOBS[0];await f.agent.commit({jobId});
 if(state==='pending')f.controls.observation={status:'pending'};
 const body={jobId,txHash:'a'.repeat(64),payerPayingKey:buyer.claim},request=command(f.agent,'/dacs/v1/payments',body,f.agent.durableSessionOf(jobId).agreementHash);
 const dir=await mkdtemp(join(tmpdir(),'TEST-payment-restart-'));t.after(()=>rm(dir,{recursive:true,force:true}));const w=await transport(t,f.agent,dir,body,'/dacs/v1/payments'),first=w.store.reserve(w.request,body);
 const out=await w.peer.submitPayment(body);assert.equal(out.status,state==='included'?'delivered':'indeterminate');assert.throws(()=>w.store.finish(first,200,'{}'),{code:'peer_store_conflict'});
 if(state==='pending'){f.controls.observation=null;assert.equal((await w.peer.submitPayment(body)).status,'delivered');}
});

test('recovery fences an original proposal delayed between HTTP reservation and the seller job fence',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),original=agent.receiveProposal;
 let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),blocked=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 agent.receiveProposal=async(input,options)=>{enter();await blocked;return original(input,options);};
 const w=await transport(t,agent,f.dir,body);f.admission.verifyReceiptWith(()=> 'invalid');
 const first=assert.rejects(w.peer.propose(body),{code:'seller_unavailable'});await entered;
 assert.equal((await w.peer.propose(body)).disposition,'rejected');
 agent.receiveProposal=original;f.admission.verifyReceiptWith(null);const corrected=await f.proposal(agent);w.setHash(corrected.proposal.plan.agreementHash);
 assert.equal((await w.peer.propose(corrected)).disposition,'complete');const signed=f.signed.length;
 release();await first;assert.equal(f.signed.length,signed);
});
test('a live seller job fence prevents concurrent proposal recovery from releasing its pending slot',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);
 let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),blocked=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 f.admission.verifyReceiptWith(async()=>{enter();await blocked;return 'valid';});
 const w=await transport(t,agent,f.dir,body),first=w.peer.propose(body);await entered;
 await assert.rejects(w.peer.propose(body),{code:'seller_unavailable'});release();assert.equal((await first).disposition,'complete');
 assert.equal((await w.peer.propose(body)).disposition,'complete');
});
for(const noEffect of [false,true])test(`pending proposal ${noEffect?'release':'retry'} requires a fenced proof and rejects stale ownership`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),w=await transport(t,agent,f.dir,body),first=w.store.reserve(w.request,body);
 const retained=w.store.reserve(w.request,body),options=noEffect?{noEffect:true}:{retry:true};
 assert.throws(()=>w.store.reconcile(retained,w.request,200,'{}',options),{code:'peer_reconciliation_conflict'});
 assert.throws(()=>w.store.reconcile({...retained,owner:'TEST-stale'},w.request,200,'{}',{...options,pendingFenced:true}),{code:'peer_reconciliation_conflict'});
 w.store.reconcile(retained,w.request,200,'{}',{...options,pendingFenced:true});assert.throws(()=>w.store.assertPending(first),{code:'peer_store_conflict'});
});

for(const changed of ['checkpoint','proposal','bundle','signature'])test(`read-only contribution recovery before final checkpoint authenticates ${changed}`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);await agent.receiveProposal(body);agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:agent.listingPin});
 try{await state.withJob(JOB,session=>{delete session.transportIdentity;if(changed==='proposal')session.sellerContributionProposalHash='f'.repeat(64);if(changed==='bundle')session.buyerBundleHash='e'.repeat(64);if(changed==='signature')session.sellerContribution.signature.value='TEST-invalid-signature';state.saveSession(session);});}finally{state.close();}
 // A changed buyer bundle is rejected while restoring the authenticated session.
 if(changed==='bundle'){await assert.rejects(f.open());return;}
 const fresh=await f.open(),signed=f.signed.length,out=await fresh.reconcileTransport({...command(fresh,'/dacs/v1/agreements/proposals',body,body.proposal.plan.agreementHash),readOnly:true});
 assert.equal(out.disposition,changed==='checkpoint'?'present':'indeterminate');assert.equal(f.signed.length,signed);
});
