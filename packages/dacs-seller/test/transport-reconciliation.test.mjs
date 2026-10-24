import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import {createServer} from 'node:http';
import {createSellerHttpHandler,createSellerAgentClient} from '../src/dacs/seller-http.mjs';
import {join} from 'node:path';
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
