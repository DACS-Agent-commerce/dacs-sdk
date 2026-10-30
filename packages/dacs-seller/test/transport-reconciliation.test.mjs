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
import {railSteward} from './helpers/rail-authority-fixture.mjs';
import {seller,buyer,JOB,NOW} from './helpers/protocol-fixture.mjs';
import {JOBS} from './helpers/bilateral-vet-fixture.mjs';
import {createSellerTransportStore,createSellerTransportClientAuth,createSellerTransportServerAuth} from '../src/dacs/seller-transport-auth.mjs';
import {SellerAgentError,transportOutcome} from '../src/dacs/seller-agent.mjs';
import {createOperatorBuyerAccess} from '../src/devnet-demo/buyer-access.mjs';
function command(agent,path,body,agreementHash){const rawBody=Buffer.from(JSON.stringify(body));return{body,rawBody,request:{method:'POST',path,jobId:body.transportIdentity?.jobId??body.jobId,buyer:buyer.claim,seller:seller.claim,listingPin:agent.listingPin,agreementHash,bodyHash:core.sha256Hex(rawBody)}};}
// Real store, server auth, HTTP handler and client. `serve` swaps the agent behind the same journal (a restart).
async function transport(t,agent,dir,body,path='/dacs/v1/agreements/proposals',storeOptions={}){
 const now=storeOptions.now??(()=>NOW);
 const store=createSellerTransportStore({path:join(dir,'TEST-recovery.sqlite'),now,...storeOptions});t.after(()=>store.close());
 let hash=body.proposal?.plan.agreementHash??core.contentHash(agent.transportAgreementOf(body.jobId));
 const client=createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:seller.claim,resolveJob:()=>({listingPin:agent.listingPin,agreementHash:hash}),now});
 const auth=createSellerTransportServerAuth({sellerSigner:{claim:seller.claim,sign:seller.signBytes},listingPin:agent.listingPin,store,now});
 const envelope=await client.request(path,body,JSON.stringify(body)),request=auth.readRequest(envelope.header);
 let handler=createSellerHttpHandler(agent,{authentication:auth});
 const server=createServer((req,res)=>handler(req,res));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
 return{store,request,client,auth,peer:createSellerAgentClient({url:`http://127.0.0.1:${server.address().port}`,authentication:client}),setHash:value=>{hash=value;},serve:(next,{readOnly=false}={})=>{handler=createSellerHttpHandler(next,{authentication:readOnly?{...auth,readbackOnly:()=>true}:auth});}};
}
// Holds the first call of agent[name] until released (a worker delayed before its job fence).
function pauseFirst(t,agent,name){
 const original=agent[name];let enter,release,first=true;const entered=new Promise(r=>{enter=r;}),blocked=new Promise(r=>{release=r;});t.after(()=>release());
 agent[name]=async(...args)=>{if(first){first=false;enter();await blocked;}return original(...args);};
 return{entered,release:()=>{release();agent[name]=original;}};
}
const outcome=promise=>promise.then(value=>({value}),error=>({error}));

test('read-only commitment reconciliation neither signs nor publishes absent work and authenticates retained work',async()=>{
 const f=await agentFixture({lifecycle:true});try{const jobId=JOBS[0],request=command(f.agent,'/dacs/v1/commitments',{jobId},f.agent.durableSessionOf(jobId).agreementHash),before=f.anchors.writes.length;assert.equal((await f.agent.reconcileTransport({...request,readOnly:true})).disposition,'indeterminate');assert.equal(f.anchors.writes.length,before);await f.agent.commit({jobId});const writes=f.anchors.writes.length;assert.equal((await f.agent.reconcileTransport({...request,readOnly:true})).disposition,'present');assert.equal(f.anchors.writes.length,writes);}finally{f.close();}
});
test('read-only proposal reconciliation cannot produce a missing contribution and replays a retained one without signing',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),request=command(agent,'/dacs/v1/agreements/proposals',body,body.proposal.plan.agreementHash),signed=f.signed.length;
 assert.equal((await agent.reconcileTransport({...request,readOnly:true})).disposition,'indeterminate');assert.equal(f.signed.length,signed);const answer=await agent.receiveProposal(body),after=f.signed.length;assert.equal(answer.disposition,'complete');assert.equal((await agent.reconcileTransport({...request,readOnly:true})).disposition,'present');assert.equal(f.signed.length,after);
});
// Historical rvc-r6 C-1.
test('crash before agent, rejected proposal, then corrected receipt releases only the proven unsigned HTTP slot',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),w=await transport(t,agent,f.dir,body);
 assert.equal(w.store.reserve(w.request,body).disposition,'perform');
 f.admission.verifyReceiptWith(()=> 'invalid');assert.equal((await w.peer.propose(body)).disposition,'rejected');
 f.admission.verifyReceiptWith(null);assert.equal((await w.peer.propose(structuredClone(body))).disposition,'complete');
});
test('actual resume recovers a lost fixture evidence answer after reopen without another CREATE',async()=>{
 const f=await agentFixture({lifecycle:true});try{const jobId=JOBS[0],address=core.paymentEvidenceAddress(jobId,'demos-native:DEM',2);await f.agent.commit({jobId});f.anchors.controls.failAfterWrite=address;await assert.rejects(f.agent.submitPayment({jobId,txHash:'a'.repeat(64),payerPayingKey:buyer.claim}));await f.reopen();assert.notEqual((await f.agent.reconcile({jobId})).status,'held');assert.equal((await f.agent.resume({jobId})).status,'delivered');assert.equal(f.anchors.writes.filter(a=>a===address).length,1);}finally{f.close();}
});
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
// Parity with the original path: a thrown definite refusal keeps its own status and body.
test('pending unauthenticated presentation is refused with its own status and releases its slot for a corrected proposal',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);body.buyerIdentityBundle.sessionNonce='f'.repeat(64);
 const w=await transport(t,agent,f.dir,body);w.store.reserve(w.request,body);
 await assert.rejects(w.peer.propose(body),{name:'SellerRefusedError',code:'buyer_bundle_unauthenticated',status:422});assert.equal(agent.durableSessionOf(JOB),null);
 const corrected=await f.proposal(agent);w.setHash(corrected.proposal.plan.agreementHash);assert.equal((await w.peer.propose(corrected)).disposition,'complete');
});
// cold F1 (1f4795b/5c363cc/292fb46): a temporary 5xx gate is never a signed final rejection.
test('a recovered proposal refused by a temporary rail gate answers 503 and runs once the rail is live',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),first=await f.open(),body=await f.proposal(first);first.close();
 f.config.railAuthority=railSteward().railAuthority({changes:{availability:'disabled'}});
 const down=await f.open(),w=await transport(t,down,f.dir,body);
 assert.equal(w.store.reserve(w.request,body).disposition,'perform');const signed=f.signed.length;
 await assert.rejects(w.peer.propose(body),{code:'seller_unavailable'});assert.equal(f.signed.length,signed);assert.equal(down.durableSessionOf(JOB),null);
 down.close();f.config.railAuthority=railSteward().railAuthority();const up=await f.open();w.serve(up);
 assert.equal((await w.peer.propose(body)).disposition,'complete');
});
// cold-292fb46 F2.
test('recovery does not run a proposal again after its context session ended and keeps its effect',async t=>{
 let state=null;
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),w=await transport(t,agent,f.dir,body,undefined,{contextSessionState:()=>state});
 assert.equal(w.store.reserve(w.request,body).disposition,'perform');state='aborted-by-self';const signed=f.signed.length;
 await assert.rejects(w.peer.propose(body),{code:'context_session_terminal',status:409});
 assert.equal(f.signed.length,signed);assert.equal(agent.durableSessionOf(JOB),null);
 state=null;assert.equal((await w.peer.propose(body)).disposition,'complete','the effect was held, not released');
});
// cold2 F1 (292fb46/1f4795b/5c363cc), agreed-plan C-1.
for(const state of ['pending','uncertain'])for(const end of ['released','completed'])test(`a stale ${state} recovery does no work after another recovery ${end} its effect`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),w=await transport(t,agent,f.dir,body);
 const first=w.store.reserve(w.request,body);if(state==='uncertain')w.store.finish(first,503,'{}');
 if(end==='released')f.admission.verifyReceiptWith(()=> 'invalid');
 const r1=pauseFirst(t,agent,'reconcileTransport'),stale=outcome(w.peer.propose(body));await r1.entered;
 assert.equal((await w.peer.propose(body)).disposition,end==='released'?'rejected':'complete');
 f.admission.verifyReceiptWith(null);
 const signed=f.signed.length,kept=agent.durableSessionOf(JOB)?.sellerContribution??null;
 // The corrected request reserves the released effect again and waits before its job fence.
 const b=end==='released'?pauseFirst(t,agent,'receiveProposal'):null,corrected=b?outcome(w.peer.propose(structuredClone(body))):null;if(b)await b.entered;
 r1.release();assert.equal((await stale).error?.code,'seller_unavailable');
 assert.equal(f.signed.length,signed,'the stale recovery signed nothing');assert.deepEqual(agent.durableSessionOf(JOB)?.sellerContribution??null,kept);
 if(b){b.release();assert.equal((await corrected).value?.disposition,'complete');}
});
test('the store hands an unfinished effect to one claimed recovery and fences every other owner',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),w=await transport(t,agent,f.dir,body);
 const first=w.store.reserve(w.request,body),r1=w.store.reserve(w.request,body),r2=w.store.reserve(w.request,body);
 assert.equal(r1.owner,first.owner);const claimed=w.store.claim(r2,w.request);assert.notEqual(claimed.owner,first.owner);
 assert.throws(()=>w.store.claim(r1,w.request),{code:'peer_reconciliation_conflict'},'an earlier reservation of the same effect');
 assert.throws(()=>w.store.assertPending(first),{code:'peer_store_conflict'},'the original worker cannot start');
 assert.throws(()=>w.store.finish(first,200,'{}'),{code:'peer_store_conflict'},'nor settle');
 assert.throws(()=>w.store.reconcile(r1,w.request,200,'{}'),{code:'peer_reconciliation_conflict'});
 assert.throws(()=>w.store.reconcile(claimed,w.request,422,'{}'),{code:'peer_reconciliation_invalid'},'a refusal status never completes');
 const refused='{"error":"buyer_bundle_unauthenticated"}';w.store.reconcile(claimed,w.request,422,refused,{noEffect:true});
 assert.deepEqual(w.store.reserve(w.request,body),{disposition:'cached',status:422,text:refused},'the nonce keeps its definite refusal');
 assert.throws(()=>w.store.claim(claimed,w.request),{code:'peer_reconciliation_conflict'},'a released effect');
 const next={...w.request,nonce:'TEST-next-nonce-0000000000'},again=w.store.reserve(next,body);assert.equal(again.disposition,'perform');
 const retry=w.store.claim(w.store.reserve(next,body),next);w.store.reconcile(retry,next,200,'{}',{retry:true});
 assert.throws(()=>w.store.claim({...retry},next),{code:'peer_reconciliation_conflict'},'an effect handed back to the retry');
});
test('staged authenticated fixture payment refuses intake after a pending reservation',async t=>{
 const f=await agentFixture({lifecycle:true});t.after(()=>f.close());const jobId=JOBS[0];await f.agent.commit({jobId});
 const body={jobId,txHash:'a'.repeat(64),payerPayingKey:buyer.claim};
 const dir=await mkdtemp(join(tmpdir(),'TEST-payment-restart-'));t.after(()=>rm(dir,{recursive:true,force:true}));const w=await transport(t,f.agent,dir,body,'/dacs/v1/payments');
 const prime={...w.request,path:'/dacs/v1/agreements/proposals',nonce:'e'.repeat(64)};w.store.finish(w.store.reserve(prime,{}),200,'{}');
 const first=w.store.reserve(w.request,body),writes=f.anchors.writes.length;
 await assert.rejects(w.peer.submitPayment(body),{code:'seller_unavailable'});assert.equal(f.anchors.writes.length,writes);assert.equal(f.agent.durableSessionOf(jobId).paymentWork,undefined);
 assert.doesNotThrow(()=>w.store.finish(first,503,'{}'),'the staged refusal did not take over the retained reservation');
});
test('recovery fences an original proposal delayed between HTTP reservation and the seller job fence',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),w=await transport(t,agent,f.dir,body);
 const original=pauseFirst(t,agent,'receiveProposal');f.admission.verifyReceiptWith(()=> 'invalid');
 const first=outcome(w.peer.propose(body));await original.entered;
 assert.equal((await w.peer.propose(body)).disposition,'rejected');
 f.admission.verifyReceiptWith(null);assert.equal((await w.peer.propose(structuredClone(body))).disposition,'complete');const signed=f.signed.length;
 original.release();assert.equal((await first).error?.code,'seller_unavailable');assert.equal(f.signed.length,signed);
});
test('a live seller job fence prevents concurrent proposal recovery from releasing its pending slot',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);
 let enter,release;const entered=new Promise(resolve=>{enter=resolve;}),blocked=new Promise(resolve=>{release=resolve;});t.after(()=>release());
 f.admission.verifyReceiptWith(async()=>{enter();await blocked;return 'valid';});
 const w=await transport(t,agent,f.dir,body),first=w.peer.propose(body);await entered;
 await assert.rejects(w.peer.propose(body),{code:'seller_unavailable'});release();assert.equal((await first).disposition,'complete');
 assert.equal((await w.peer.propose(body)).disposition,'complete');
});
// cold2-5c363cc F2 / cold-d0e148d F1: only the durable final checkpoint completes read only.
for(const changed of ['checkpoint','proposal','bundle','signature'])test(`read-only contribution recovery before final checkpoint stays indeterminate: ${changed}`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);await agent.receiveProposal(body);agent.close();
 const state=await createSellerDurableState({dir:f.dir,signer:f.config.signer,listingPin:agent.listingPin});
 try{await state.withJob(JOB,session=>{delete session.transportIdentity;session.proposal=null;delete session.agreementHash;if(changed==='proposal')session.sellerContributionProposalHash='f'.repeat(64);if(changed==='bundle')session.buyerBundleHash='e'.repeat(64);if(changed==='signature')session.sellerContribution.signature.value='TEST-invalid-signature';state.saveSession(session);});}finally{state.close();}
 if(changed==='bundle'){await assert.rejects(f.open());return;}
 const fresh=await f.open(),signed=f.signed.length,request=command(fresh,'/dacs/v1/agreements/proposals',body,body.proposal.plan.agreementHash);
 const out=await fresh.reconcileTransport({...request,readOnly:true});
 assert.equal(out.disposition,'indeterminate');assert.equal(f.signed.length,signed);assert.equal(fresh.durableSessionOf(JOB).agreementHash,undefined,'nothing is sealed');
 if(changed!=='checkpoint')return;
 const agreements=()=>f.signed.filter(text=>text.startsWith('dacs-payee-bound-agreement:v1:')).length,before=agreements();
 const live=await fresh.reconcileTransport(request);assert.equal(live.disposition,'present');assert.equal(live.value.disposition,'complete');
 assert.equal(fresh.durableSessionOf(JOB).agreementHash,body.proposal.plan.agreementHash,'a live retry writes the final checkpoint');assert.equal(agreements(),before,'without signing the Agreement again');
});
// One classification for first runs and recoveries (agreed plan step 5).
test('one outcome classifier: refusals keep their status, releases need proof, recovery settles only what the store accepts',()=>{
 const P='/dacs/v1/agreements/proposals',PAY='/dacs/v1/payments',C='/dacs/v1/commitments',gate=new SellerAgentError('rail_unavailable','TEST rail',503),definite=new SellerAgentError('buyer_bundle_unauthenticated','TEST bundle'),unknown=new Error('TEST unknown');
 const pick=o=>[o.disposition,o.status,o.retry,o.noEffect,o.settle];
 assert.deepEqual(pick(transportOutcome(P,{error:gate},{retained:false,recovering:true})),['no-effect',503,false,true,true],'a temporary gate is released with its own 503, never a signed 200');
 assert.deepEqual(transportOutcome(P,{error:gate},{retained:false,recovering:true}).value,{error:'rail_unavailable',message:'TEST rail'});
 assert.deepEqual(pick(transportOutcome(P,{error:definite},{retained:false,recovering:true})),['no-effect',422,false,true,true]);
 assert.deepEqual(pick(transportOutcome(P,{error:gate},{retained:true,recovering:true})),['indeterminate',503,false,false,false],'retained proposal work keeps its slot');
 assert.deepEqual(pick(transportOutcome(P,{answer:{disposition:'rejected'}},{retained:true,recovering:true})),['indeterminate',503,false,false,false]);
 assert.deepEqual(pick(transportOutcome(P,{answer:{disposition:'rejected'}})),['indeterminate',503,false,false,true],'the default is retained: a first run without proof stays uncertain');
 assert.deepEqual(pick(transportOutcome(P,{answer:{disposition:'waiting'}},{retained:true,recovering:true})),['retry',200,true,false,true]);
 assert.deepEqual(pick(transportOutcome(P,{error:unknown},{retained:false,recovering:true})),['indeterminate',503,false,false,false],'an arbitrary exception proves nothing');
 assert.deepEqual(pick(transportOutcome(P,{error:unknown},{retained:false})),['indeterminate',503,false,false,true],'a first run records it uncertain');
 assert.deepEqual(pick(transportOutcome(P,{answer:{disposition:'waiting'}},{retained:true,recovering:true,readOnly:true})),['indeterminate',503,false,false,false],'read only never hands back a retry');
 assert.deepEqual(pick(transportOutcome(P,{error:definite},{retained:false,recovering:true,readOnly:true})),['indeterminate',503,false,false,false],'read only never releases');
 assert.deepEqual(pick(transportOutcome(C,{error:new SellerAgentError('not_agreed','TEST')},{retained:false,recovering:true})),['indeterminate',503,false,false,false],'a recovered commitment is never released');
 assert.deepEqual(pick(transportOutcome(C,{error:new SellerAgentError('not_agreed','TEST')},{retained:false})),['no-effect',422,false,true,true],'its first run keeps the ordinary refusal');
 assert.deepEqual(pick(transportOutcome(PAY,{error:gate},{retained:true,recovering:true})),['retry',503,true,false,true],'a refused payment claim with retained work stays a retry');
 assert.deepEqual(pick(transportOutcome(PAY,{answer:{status:'delivered'}},{retained:true,recovering:true,readOnly:true})),['present',200,false,false,true]);
});
test('recovery refuses a request whose authenticated binding differs from its body or retained session',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),good=command(agent,'/dacs/v1/agreements/proposals',body,body.proposal.plan.agreementHash),signed=f.signed.length;
 for(const [name,change] of [['job',r=>({...r,jobId:JOBS[1]})],['buyer',r=>({...r,buyer:seller.claim})],['seller',r=>({...r,seller:buyer.claim})],['pin',r=>({...r,listingPin:{...r.listingPin,version:'TEST'}})],['agreement',r=>({...r,agreementHash:'f'.repeat(64)})],['body hash',r=>({...r,bodyHash:'e'.repeat(64)})]]){
  const out=await agent.reconcileTransport({...good,request:change(good.request)});assert.equal(out.disposition,'indeterminate',name);
 }
 const parsed=await agent.reconcileTransport({...good,body:{...body,proposal:{...body.proposal,proposalHash:'d'.repeat(64)}}});
 assert.deepEqual([parsed.disposition,parsed.reason],['indeterminate','seller_transport_context_mismatch'],'the parsed body must be the signed raw bytes');
 assert.equal(f.signed.length,signed);assert.equal(agent.durableSessionOf(JOB),null);
});
test('signature commitment recovery reads back only a retained attempt and never starts one',async()=>{
 const w=await agentFixture({lifecycle:true,early:true}),next='01ARZ3NDEKTSV4RRFFQ69G5FAY';
 try{
  const input=await w.negotiate(next,{anchor:false}),rawBody=Buffer.from(JSON.stringify(input)),writes=w.anchors.writes.length;
  const request={method:'POST',path:'/dacs/v1/commitments/signature',jobId:next,buyer:w.buyer.claim,seller:w.seller.claim,listingPin:w.pin,agreementHash:w.agent.durableSessionOf(next).agreementHash,bodyHash:core.sha256Hex(rawBody)};
  const out=await w.agent.reconcileTransport({request,body:input,rawBody});
  assert.deepEqual([out.disposition,out.reason],['indeterminate','seller_signature_attempt_absent']);
  assert.equal(w.anchors.writes.length,writes);assert.equal(w.agent.durableSessionOf(next).signatureCommitmentAttempt,undefined);
  assert.equal((await w.agent.commitOnSignature(input)).status,'commitment-held');
  assert.equal((await w.agent.reconcileTransport({request,body:input,rawBody})).value.status,'commitment-held','the retained attempt is read back');
 }finally{w.close();}
});
test('an unpaid outside buyer only has issued unknown writes inspected; a paid order recovers',async()=>{
 const w=await agentFixture({lifecycle:true});
 try{
  const jobId=JOBS[0];await w.agent.commit({jobId});let paid=false,reads=0;
  w.config.buyerAccess=createOperatorBuyerAccess({openBuyerAccess:false,custodyBuyer:seller.claim,buyerForJob:()=>w.buyer.address,paymentObserved:()=>paid});
  w.config.readIssued=async(job,options)=>{assert.equal(job,jobId);assert.deepEqual(options,{unknownOnly:true});reads++;return null;};
  await w.reopen();
  const body={jobId},rawBody=Buffer.from(JSON.stringify(body)),request={method:'POST',path:'/dacs/v1/commitments',jobId,buyer:w.buyer.claim,seller:w.seller.claim,listingPin:w.pin,agreementHash:w.agent.durableSessionOf(jobId).agreementHash,bodyHash:core.sha256Hex(rawBody)},writes=w.anchors.writes.length;
  const closed=await w.agent.reconcileTransport({request,body,rawBody});
  assert.deepEqual([closed.disposition,closed.reason],['indeterminate','buyer_access_closed; no unknown issued write, nothing was read; retained outcome unchanged']);
  assert.equal(reads,1);assert.equal(w.anchors.writes.length,writes);
  paid=true;const open=await w.agent.reconcileTransport({request,body,rawBody});assert.equal(open.disposition,'present',`the paid order keeps its job-scoped authority: ${open.reason} ${open.cause?.message}`);assert.equal(reads,1);
 }finally{w.close();}
});

for(const boundary of ['before','at','terminal'])test('effective recovery claim mode at expiry '+boundary,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);let at=NOW,terminal=false;
 const w=await transport(t,agent,f.dir,body,undefined,{now:()=>at,contextSessionState:()=>terminal?'aborted-by-self':null});w.store.reserve(w.request,body);const before=f.signed.length;
 const original=agent.reconcileTransport;let claimed;
 const claim=w.store.claim;w.store.claim=(...args)=>(claimed=claim.apply(w.store,args));
 agent.reconcileTransport=input=>{at=input.request.expiresAt-(boundary==='before'?1:0);terminal=boundary==='terminal';return original(input);};
 const result=await outcome(w.peer.propose(body));
 assert.equal(claimed.live,boundary==='before');
 if(boundary==='before')assert.equal(result.value.disposition,'complete');else{assert.equal(result.error.name,'SellerUnavailableError');assert.equal(f.signed.length,before);assert.equal(agent.durableSessionOf(JOB),null);}
});
test('a live recovery claim may settle retry after its request expires',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);let at=NOW;
 const w=await transport(t,agent,f.dir,body,undefined,{now:()=>at});w.store.reserve(w.request,body);f.admission.verifyReceiptWith(()=> 'indeterminate');
 const claim=w.store.claim;w.store.claim=(reservation,request,options)=>{const kept=claim.call(w.store,reservation,request,options);at=request.expiresAt;return kept;};
 assert.equal((await w.peer.propose(body)).disposition,'indeterminate');
 f.admission.verifyReceiptWith(null);assert.equal((await w.peer.propose(body)).disposition,'complete');
});
for(const mode of ['unknown','none','no-reader'])test('closed resume gates before unavailable Vet restoration '+mode,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),first=await f.open(),body=await f.proposal(first);await first.receiveProposal(body);first.close();let paid=false,reads=0,vetReads=0,broken=false;
 const resolve=f.config.sessionAdmission.resolveVetRecord;f.config.sessionAdmission.resolveVetRecord=(...args)=>{vetReads++;if(broken)throw Error('TEST Vet reader unavailable');return resolve(...args);};
 f.config.buyerAccess=createOperatorBuyerAccess({openBuyerAccess:false,custodyBuyer:seller.claim,buyerForJob:()=>buyer.address,paymentObserved:()=>paid});
 const unknown={status:'TEST-issued-readback'};if(mode!=='no-reader')f.config.readIssued=async(jobId,options)=>{assert.equal(jobId,JOB);assert.deepEqual(options,{unknownOnly:true});reads++;return mode==='unknown'?unknown:null;};
 const agent=await f.open();vetReads=0;broken=true;const signs=f.signed.length;
 if(mode==='unknown')assert.deepEqual(await agent.resume({jobId:JOB}),unknown);else await assert.rejects(agent.resume({jobId:JOB}),{code:'buyer_access_closed',status:409});
 assert.equal(reads,mode==='no-reader'?0:1);assert.equal(vetReads,0);assert.equal(f.signed.length,signs);
 paid=true;await assert.rejects(agent.resume({jobId:JOB}),{code:'seller_state_unverified'});assert.ok(vetReads>0);
});

for(const paid of [false,true])test(`read-only proposal replay applies closed outside-buyer policy, paid=${paid}`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);await agent.receiveProposal(body);agent.close();
 const signed=f.signed.length;f.config.buyerAccess=createOperatorBuyerAccess({custodyBuyer:seller.claim,openBuyerAccess:false,buyerForJob:()=>buyer.address,paymentObserved:()=>paid});
 const closed=await f.open(),request=command(closed,'/dacs/v1/agreements/proposals',body,body.proposal.plan.agreementHash);
 const out=await closed.reconcileTransport({...request,readOnly:true});assert.equal(out.disposition,'indeterminate');assert.equal(out.reason,'buyer_access_closed');assert.equal(out.value.contribution,undefined);assert.equal(f.signed.length,signed);closed.close();
 f.config.buyerAccess=createOperatorBuyerAccess({custodyBuyer:seller.claim,openBuyerAccess:true});
 assert.equal((await (await f.open()).reconcileTransport({...request,readOnly:true})).disposition,'present');assert.equal(f.signed.length,signed);
});
for(const policy of ['custody','open'])test(`read-only proposal replay retains ${policy} access without another signature`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);const complete=await agent.receiveProposal(body);agent.close();
 const signed=f.signed.length;f.config.buyerAccess=createOperatorBuyerAccess({custodyBuyer:policy==='custody'?buyer.claim:seller.claim,openBuyerAccess:policy==='open'});
 const fresh=await f.open(),out=await fresh.reconcileTransport({...command(fresh,'/dacs/v1/agreements/proposals',body,body.proposal.plan.agreementHash),readOnly:true});
 assert.equal(out.disposition,'present');assert.deepEqual(out.value.contribution,complete.contribution);assert.equal(f.signed.length,signed);
});
for(const gate of ['rail','vet-context'])test(`read-only proposal replay applies current ${gate} gate`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);await agent.receiveProposal(body);agent.close();const signed=f.signed.length;
 if(gate==='rail')f.config.railAuthority=railSteward().railAuthority({changes:{availability:'disabled'}});else f.config.demDeliveryContext=null;
 const fresh=await f.open(),out=await fresh.reconcileTransport({...command(fresh,'/dacs/v1/agreements/proposals',body,body.proposal.plan.agreementHash),readOnly:true});
 assert.equal(out.disposition,'indeterminate');assert.equal(out.reason,gate==='rail'?'rail_unavailable':'vet_context_required');assert.equal(f.signed.length,signed);
});
test('retained proposal gate refusals are uncertain on first run and recovery',()=>{
 const path='/dacs/v1/agreements/proposals',pick=o=>[o.disposition,o.status,o.retry,o.noEffect,o.settle];
 for(const [code,status] of [['buyer_access_closed',409],['rail_unavailable',503]]){
  const error=new SellerAgentError(code,'TEST policy gate',status);
  assert.deepEqual(pick(transportOutcome(path,{error},{retained:true})),['indeterminate',503,false,false,true]);
  assert.deepEqual(pick(transportOutcome(path,{error},{retained:true,recovering:true})),['indeterminate',503,false,false,false]);
  assert.deepEqual(pick(transportOutcome(path,{error},{retained:false})),['no-effect',status,false,true,true]);
 }
});
for(const [mode,options] of [['first run',{}],['resumed run',{resumed:true}],['recovery',{recovering:true}],['read-only recovery',{recovering:true,readOnly:true}]]){
 for(const answer of [{disposition:'rejected'},{status:'rejected'},{disposition:'rejected',code:'party_vet_non_pass'},{status:'rejected',code:'party_vet_non_pass'}]){
  test(`retained returned proposal rejection stays uncertain on ${mode}: ${JSON.stringify(answer)}`,()=>{
   const out=transportOutcome('/dacs/v1/agreements/proposals',{answer},{...options,retained:true});
   assert.deepEqual([out.disposition,out.status,out.retry,out.noEffect,out.settle],['indeterminate',503,false,false,!options.recovering]);
  });
 }
}
test('returned proposal rejection releases only with proof that no work remains',()=>{
 const path='/dacs/v1/agreements/proposals';
 for(const answer of [{disposition:'rejected'},{status:'rejected'},{disposition:'rejected',code:'party_vet_non_pass'}]){
  for(const recovering of [false,true]){
   const out=transportOutcome(path,{answer},{retained:false,recovering});
   assert.deepEqual([out.disposition,out.status,out.retry,out.noEffect,out.settle],['no-effect',200,false,true,true]);
  }
 }
});
for(const recovering of [false,true])test(`HTTP retained publication signature survives a returned rejection and healthy retry, recovery=${recovering}`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),signatures=[];let cut=true;
 const original=f.config.signer.sign;
 f.config.signer.sign=bytes=>{
  const text=Buffer.from(bytes).toString();
  if(cut&&text.includes('"kind":"session"')&&JSON.parse(text.slice(text.indexOf('{'))).body?.session?.sellerContribution){cut=false;throw new Error('TEST contribution publication interrupted');}
  const signature=original(bytes);
  if(text.startsWith('dacs-payee-bound-agreement:v1:'))signatures.push(Buffer.from(signature).toString('base64url'));
  return signature;
 };
 const statuses=[],fetchImpl=globalThis.fetch;
 t.mock.method(globalThis,'fetch',async(...args)=>{const response=await fetchImpl(...args);statuses.push(response.status);return response;});
 const agent=await f.open(),body=await f.proposal(agent),w=await transport(t,agent,f.dir,body);
 assert.equal((await w.peer.propose(body)).disposition,'indeterminate');
 assert.equal(cut,false,'publication failed after signing');assert.equal(signatures.length,1);assert.equal(agent.retainsProposalWork(JOB),true);
 if(recovering)assert.equal(w.store.reserve(w.request,body).disposition,'perform','leave the retried slot pending for recovery');
 let verifications=0;
 f.admission.verifyReceiptWith(()=>++verifications===3?'invalid':'valid');
 const refused=await outcome(w.peer.propose(body));
 assert.equal(statuses.at(-1),503,'a returned rejection with retained work must remain HTTP uncertain');
 assert.equal(refused.error?.code,'seller_unavailable');assert.equal(verifications,3,'restore passes before the proposal receipt recheck refuses');
 assert.equal(w.store.reserve(w.request,body).disposition,'uncertain');assert.equal(signatures.length,1);
 f.admission.verifyReceiptWith(null);
 const complete=await w.peer.propose(body);
 assert.equal(statuses.at(-1),200);assert.equal(complete.disposition,'complete');
 assert.equal(signatures.length,1);assert.equal(complete.contribution.signature.value,signatures[0]);
 assert.equal(w.store.reserve(w.request,body).disposition,'cached');
});
for(const reopened of [false,true])test(`HTTP retained proposal refusal keeps an uncertain slot and can recover, reopened=${reopened}`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);await agent.receiveProposal(body);agent.close();const signed=f.signed.length;
 f.config.buyerAccess=createOperatorBuyerAccess({custodyBuyer:seller.claim,openBuyerAccess:false});let fresh=await f.open();const w=await transport(t,fresh,f.dir,body);
 await assert.rejects(w.peer.propose(body),{code:'seller_unavailable'});assert.equal(w.store.reserve(w.request,body).disposition,'uncertain');
 if(reopened){fresh.close();f.config.buyerAccess=createOperatorBuyerAccess({custodyBuyer:seller.claim,openBuyerAccess:true});fresh=await f.open();w.serve(fresh,{readOnly:true});assert.equal((await w.peer.propose(body)).disposition,'complete');}
 else{let settles=0;const reconcile=w.store.reconcile;w.store.reconcile=(...args)=>{settles++;return reconcile(...args);};w.serve(fresh,{readOnly:true});await assert.rejects(w.peer.propose(body),{code:'seller_unavailable'});assert.equal(w.store.reserve(w.request,body).disposition,'uncertain');assert.equal(settles,0);}
 assert.equal(f.signed.length,signed);
});

test('removing session admission after signing refuses startup before replay',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);await agent.receiveProposal(body);agent.close();const signed=f.signed.length;
 f.config.sessionAdmission=null;await assert.rejects(f.open());assert.equal(f.signed.length,signed);
});

for(const boundary of ['resolveVetRecord','readVetAnchorReceipt','verifyVetAnchorReceipt','context','signature'])test(`live proposal recovery rechecks claimed context after ${boundary}`,async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true});let state=null,once=true;
 if(boundary==='context'){const {createDemDeliveryContext}=await import('../src/dacs/dem-delivery-context-consumer.mjs');f.config.demDeliveryContext=createDemDeliveryContext({authority:'TEST-recovery-terminal-context',resolveBuyer:async()=>null,resolveSeller:async({jobId})=>{state='aborted-by-other';return{disposition:'present',value:structuredClone(f.contexts.get(jobId))};}});}
 else if(boundary==='signature'){const sign=f.config.signer.sign;f.config.signer.sign=bytes=>{const signature=sign(bytes);if(Buffer.from(bytes).toString().startsWith('dacs-payee-bound-agreement:v1:'))state='aborted-by-other';return signature;};}
 else{const read=f.admission.sessionAdmission[boundary];f.admission.sessionAdmission[boundary]=async(...args)=>{const value=await read(...args);if(once){once=false;state='aborted-by-other';}return value;};}
 const agent=await f.open(),body=await f.proposal(agent),w=await transport(t,agent,f.dir,body,'/dacs/v1/agreements/proposals',{contextSessionState:()=>state});
 w.store.reserve(w.request,body);
 await assert.rejects(w.peer.propose(body),{code:'seller_unavailable'});
 assert.equal(f.signed.filter(value=>value.startsWith('dacs-payee-bound-agreement:v1:')).length,boundary==='signature'?1:0);
 assert.equal(agent.durableSessionOf(JOB)?.sellerContribution,undefined);assert.equal(w.store.reserve(w.request,body).disposition,'uncertain');
});
test('a claimed recovery check refuses an owner replaced before its signature',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),w=await transport(t,agent,f.dir,body);
 w.store.reserve(w.request,body);const first=w.store.claim(w.store.reserve(w.request,body),w.request);
 w.store.claim(w.store.reserve(w.request,body),w.request);
 assert.throws(()=>first.check(),{code:'peer_reconciliation_conflict'});
});
