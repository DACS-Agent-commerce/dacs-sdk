import test from 'node:test';
import assert from 'node:assert/strict';
import * as core from '@kynesyslabs/dacs';
import {join} from 'node:path';
import {createSellerDurableState} from '../src/dacs/seller-durable-state.mjs';
import {agentFixture} from './helpers/seller-agent-isolated-fixture.mjs';
import {proposalAdmissionFixture} from './helpers/proposal-admission-fixture.mjs';
import {railSteward} from './helpers/rail-authority-fixture.mjs';
import {seller,buyer,JOB,NOW} from './helpers/protocol-fixture.mjs';
import {JOBS} from './helpers/bilateral-vet-fixture.mjs';
import {createSellerTransportClientAuth} from '../src/dacs/seller-transport-auth.mjs';
import {createSellerTransportStore} from './helpers/bound-transport-store.mjs';
import {SellerAgentError,transportOutcome} from '../src/dacs/seller-agent.mjs';
import {createOperatorBuyerAccess} from '../src/devnet-demo/buyer-access.mjs';
import {privateModule} from './helpers/private-module.mjs';

const {createSellerAgent:createOperationAgent}=await privateModule(new URL('../src/dacs/seller-agent.mjs',import.meta.url),[],source=>source.replace(
 '  return api;',
 '  return {...api,runOperation:recoveryCall(({operation})=>operation())};',
));
const operationFailures=[['undefined',undefined],['null',null],['zero',0],['empty string',''],['false',false],['bigint zero',0n],['NaN',NaN],['Error',new Error('operation failed')]];

for(const path of ['/dacs/v1/payments','/dacs/v1/commitments'])for(const [label,failure] of operationFailures){
 test(`transport classifies ${label} failure as uncertain on ${path}`,()=>{
  const result=transportOutcome(path,{error:failure});
  assert.deepEqual([result.disposition,result.status,result.retry,result.noEffect],['indeterminate',503,false,false]);
  assert.equal(Object.hasOwn(result,'cause'),true);
  assert.equal(result.cause,failure);
 });
}
for(const path of ['/dacs/v1/payments','/dacs/v1/commitments'])test(`fenced operations reject failures on ${path}`,async t=>{
 const f=await agentFixture();f.agent.close();
 let agent;t.after(()=>{agent?.close();f.close();});agent=await createOperationAgent(f.config);
 for(const [label,failure] of operationFailures)for(const asynchronous of [false,true])await t.test(`${label} ${asynchronous?'rejection':'throw'}`,async()=>{
  const settled=[];
  const transport={path,check(){},settle:result=>settled.push(result)};
  let calls=0;
  const operation=()=>{calls++;if(asynchronous)return Promise.reject(failure);throw failure;};
  const rejected=await agent.runOperation({jobId:JOBS[0],operation},{transport}).then(()=>false,error=>{
   assert.equal(error,failure);
   return true;
  });
  assert.equal(settled.length,1);
  assert.deepEqual([settled[0].disposition,settled[0].status,settled[0].retry,settled[0].noEffect],['indeterminate',503,false,false]);
  assert.equal(Object.hasOwn(settled[0],'cause'),true);
  assert.equal(settled[0].cause,failure);
  assert.equal(rejected,true,'the operation must reject');
  assert.equal(calls,1);
 });
});

test('transport recovery keeps failures uncertain',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);
 await agent.receiveProposal(body);
 const input=command(agent,'/dacs/v1/agreements/proposals',body,body.proposal.plan.agreementHash);
 for(const [label,value] of operationFailures)await t.test(label,async()=>{
 let checks=0;
 const result=await agent.reconcileTransport({...input,transport:{claim:()=>({check(){checks++;throw value;}}),settle(){}}});
 assert.ok(checks>0);
 assert.deepEqual([result.disposition,result.status,result.retry,result.settle],['indeterminate',503,false,false]);
 assert.equal(Object.hasOwn(result,'cause'),true);
 assert.equal(result.cause,value);
 });
});

function command(agent,path,body,agreementHash){const rawBody=Buffer.from(JSON.stringify(body));return{body,rawBody,request:{method:'POST',path,jobId:body.transportIdentity?.jobId??body.jobId,buyer:buyer.claim,seller:seller.claim,listingPin:agent.listingPin,agreementHash,bodyHash:core.sha256Hex(rawBody)}};}
// A real store, bound to the seller and Listing, and a signed request over it.
async function transport(t,agent,dir,body,path='/dacs/v1/agreements/proposals',storeOptions={}){
 const now=storeOptions.now??(()=>NOW);
 const store=createSellerTransportStore({path:join(dir,'TEST-recovery.sqlite'),now,...storeOptions});t.after(()=>store.close());
 let hash=body.proposal?.plan.agreementHash??core.contentHash(agent.transportAgreementOf(body.jobId));
 const client=createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:seller.claim,resolveJob:()=>({listingPin:agent.listingPin,agreementHash:hash}),now});
 store.bind({seller:seller.claim,listingPin:agent.listingPin});
 const{payload:request}=await client.request(path,body,JSON.stringify(body));
 return{store,request,client,setHash:value=>{hash=value;}};
}

test('read-only commitment reconciliation neither signs nor publishes absent work and authenticates retained work',async()=>{
 const f=await agentFixture({lifecycle:true});try{const jobId=JOBS[0],request=command(f.agent,'/dacs/v1/commitments',{jobId},f.agent.durableSessionOf(jobId).agreementHash),before=f.anchors.writes.length;assert.equal((await f.agent.reconcileTransport({...request,readOnly:true})).disposition,'indeterminate');assert.equal(f.anchors.writes.length,before);await f.agent.commit({jobId});const writes=f.anchors.writes.length;assert.equal((await f.agent.reconcileTransport({...request,readOnly:true})).disposition,'present');assert.equal(f.anchors.writes.length,writes);}finally{f.close();}
});
test('read-only proposal reconciliation cannot produce a missing contribution and replays a retained one without signing',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),request=command(agent,'/dacs/v1/agreements/proposals',body,body.proposal.plan.agreementHash),signed=f.signed.length;
 assert.equal((await agent.reconcileTransport({...request,readOnly:true})).disposition,'indeterminate');assert.equal(f.signed.length,signed);const answer=await agent.receiveProposal(body),after=f.signed.length;assert.equal(answer.disposition,'complete');assert.equal((await agent.reconcileTransport({...request,readOnly:true})).disposition,'present');assert.equal(f.signed.length,after);
});
// Historical rvc-r6 C-1.
test('actual resume recovers a lost fixture evidence answer after reopen without another CREATE',async()=>{
 const f=await agentFixture({lifecycle:true});try{const jobId=JOBS[0],address=core.paymentEvidenceAddress(jobId,'demos-native:DEM',2);await f.agent.commit({jobId});f.anchors.controls.failAfterWrite=address;await assert.rejects(f.agent.submitPayment({jobId,txHash:'a'.repeat(64),payerPayingKey:buyer.claim}));await f.reopen();assert.notEqual((await f.agent.reconcile({jobId})).status,'held');assert.equal((await f.agent.resume({jobId})).status,'delivered');assert.equal(f.anchors.writes.filter(a=>a===address).length,1);}finally{f.close();}
});
test('unfinished work is read from the saved session for the route asked about',async()=>{
 const f=await agentFixture({lifecycle:true});try{
  const jobId=JOBS[0],kept=()=>['/dacs/v1/agreements/proposals','/dacs/v1/payments'].map(path=>f.agent.retainsUnfinishedWork({jobId,path}));
  assert.deepEqual(kept(),[false,false],'an Agreement alone leaves nothing to finish');
  f.anchors.controls.failAfterWrite=`dacs3:commit:${jobId}`;await assert.rejects(f.agent.commit({jobId}));await f.reopen();
  assert.deepEqual(kept(),[true,true],'a commitment write waits for its read-back');
  await f.agent.commit({jobId});assert.deepEqual(kept(),[false,false]);
  f.anchors.controls.failAfterWrite=core.paymentEvidenceAddress(jobId,'demos-native:DEM',2);await assert.rejects(f.agent.submitPayment({jobId,txHash:'a'.repeat(64),payerPayingKey:buyer.claim}));await f.reopen();
  assert.deepEqual(kept(),[false,true],'a recorded payment waits for its stored answer');
  assert.equal((await f.agent.resume({jobId})).status,'delivered');assert.deepEqual(kept(),[false,true],'delivery alone stores no answer');
 }finally{f.close();}
});
// Parity with the original path: a thrown definite refusal keeps its own status and body.
// cold F1 (1f4795b/5c363cc/292fb46): a temporary 5xx gate is never a signed final rejection.
// cold-292fb46 F2.
// cold2 F1 (292fb46/1f4795b/5c363cc), agreed-plan C-1.
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
 assert.equal(f.signed.length,signed);assert.equal(agent.durableSessionOf(JOB),null);
});
test('signature commitment recovery of a request with no retained attempt proves no anchor row, then runs the original early operation once',async()=>{
 const w=await agentFixture({lifecycle:true,early:true}),next='01ARZ3NDEKTSV4RRFFQ69G5FAY';
 try{
  const input=await w.negotiate(next,{anchor:false}),rawBody=Buffer.from(JSON.stringify(input)),writes=w.anchors.writes.length;
  const request={method:'POST',path:'/dacs/v1/commitments/signature',jobId:next,buyer:w.buyer.claim,seller:w.seller.claim,listingPin:w.pin,agreementHash:w.agent.durableSessionOf(next).agreementHash,bodyHash:core.sha256Hex(rawBody)};
  const readOnly=await w.agent.reconcileTransport({request,body:input,rawBody,readOnly:true});
  assert.equal(readOnly.disposition,'indeterminate','a read-only replay never starts an attempt');
  assert.equal(w.anchors.writes.length,writes);assert.equal(w.agent.durableSessionOf(next).signatureCommitmentAttempt,undefined);
  const out=await w.agent.reconcileTransport({request,body:input,rawBody});
  assert.deepEqual([out.disposition,out.value.status],['present','commitment-held'],'no anchor row exists, so the original operation runs');
  assert.equal(w.anchors.writes.length,writes+1);assert.equal(w.agent.durableSessionOf(next).signatureCommitmentAttempt,true);
  assert.equal((await w.agent.reconcileTransport({request,body:input,rawBody})).value.status,'commitment-held','the retained attempt is read back');
  assert.equal(w.anchors.writes.length,writes+1,'one write in all');
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
test('removing session admission after signing refuses startup before replay',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent);await agent.receiveProposal(body);agent.close();const signed=f.signed.length;
 f.config.sessionAdmission=null;await assert.rejects(f.open());assert.equal(f.signed.length,signed);
});

test('a claimed recovery check refuses an owner replaced before its signature',async t=>{
 const f=await proposalAdmissionFixture(t,{assembled:true}),agent=await f.open(),body=await f.proposal(agent),w=await transport(t,agent,f.dir,body);
 w.store.reserve(w.request,body);const first=w.store.claim(w.store.reserve(w.request,body),w.request);
 w.store.claim(w.store.reserve(w.request,body),w.request);
 assert.throws(()=>first.check(),{code:'peer_reconciliation_conflict'});
});
