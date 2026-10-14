// DACS_SELLER_CONTEXT=route on the real operator and the owned loopback Node2
// chain: chain writes are the accepted storage CREATEs the fixture records.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { canonicalize, contentHash, generateCanonicalJobId, identityBundleHash } from '@kynesyslabs/dacs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { linkAccount } from './helpers/seller-context-off-operator.mjs';
import { offOperation } from './helpers/seller-context-off-scenario.mjs';
import { openTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';
import { tool, portal, tokenFrom } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { AGREEMENT_CONTEXT_SOURCE } from '../src/dacs/agreement-context-consumer.mjs';
import { resolveDemDeliveryBuyerContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { DEM_RAIL, attachIdentityPresentation, buildUnsignedIdentityBundle, purchaseSupport } from '../src/dacs/listing.mjs';
import { listingPin, planAgreementFromInput } from '../src/dacs/purchase-protocol.mjs';
import { SellerRefusedError, createSellerAgentClient } from '../src/dacs/seller-http.mjs';
import { createSellerTransportClientAuth, sellerContextScopeHash, sellerSessionDelegationSigningBytes } from '../src/dacs/seller-transport-auth.mjs';
import { createSellerContextAdmission, releaseSellerContextHolds } from '../src/devnet-demo/operator-approval.mjs';
import { opsHealth } from '../src/ops/health.mjs';
import { PURCHASE_APPROVAL_TTL_MS } from '../src/purchases.mjs';
import { SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';

const HASH=/^[0-9a-f]{64}$/;
const CONTEXT='/dacs/v1/agreements/context';

function withSellerContext(t,value){
  const previous=process.env.DACS_SELLER_CONTEXT;
  if(value===undefined)delete process.env.DACS_SELLER_CONTEXT;else process.env.DACS_SELLER_CONTEXT=value;
  t.after(()=>{if(previous===undefined)delete process.env.DACS_SELLER_CONTEXT;else process.env.DACS_SELLER_CONTEXT=previous;});
}
const transportRows=(h)=>{const db=new DatabaseSync(join(h.config.stateDirectory,'seller-transport.sqlite'),{readOnly:true});try{return{
  slots:db.prepare('SELECT slot, effect FROM peer_slots ORDER BY slot').all().map((row)=>({...row})),
  effects:db.prepare('SELECT effect, state, status FROM peer_effects ORDER BY effect').all().map((row)=>({...row})),
  nonces:db.prepare('SELECT COUNT(*) AS n FROM peer_nonces').get().n};}finally{db.close();}};
// Counts every node:crypto signature this process makes (the custody buyer's
// and the seller's keys sign through it) until the test ends.
const nodeCrypto=createRequire(import.meta.url)('node:crypto');
function countSignatures(t){
  const original=nodeCrypto.sign;let count=0;
  nodeCrypto.sign=function(...args){count+=1;return original.apply(this,args);};syncBuiltinESMExports();
  t.after(()=>{nodeCrypto.sign=original;syncBuiltinESMExports();});
  return()=>count;
}
const evidence=(h)=>{try{return readFileSync(join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'),'utf8').trim().split('\n').filter(Boolean).map((line)=>JSON.parse(line));}catch(error){if(error.code==='ENOENT')return[];throw error;}};

for(const openBuyerAccess of [false,true])test(`route: the operator purchase completes with the context over the seller transport (${openBuyerAccess?'open':'closed'} access)`,{timeout:600000},async t=>{
  withSellerContext(t,'route');
  const settings=['DACS_SHOWCASE_REPORT_VIEW','DACS_FUNDING_HELP_URL'],previous=settings.map(name=>process.env[name]);
  Object.assign(process.env,{DACS_SHOWCASE_REPORT_VIEW:'1',DACS_FUNDING_HELP_URL:'https://faucet.example.com/'});
  t.after(()=>settings.forEach((name,index)=>{if(previous[index]===undefined)delete process.env[name];else process.env[name]=previous[index];}));
  const sellerApprovals=[];
  const h=await startOperatorPurchaseNode2({...(openBuyerAccess?{openBuyerAccess}:{}),
    authorizeSellerApproval:({request})=>{sellerApprovals.push(structuredClone(request));return true;},authorizeBuyerApproval:()=>true});
  t.after(()=>h.close());
  assert.equal(h.prepared.config.sellerContext,'route');
  assert.equal(h.prepared.config.showcaseReportView,true,'main report view is forwarded alongside the context route');
  assert.equal(h.prepared.config.fundingHelpUrl,'https://faucet.example.com','main funding guidance is forwarded alongside the context route');
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:`route-${openBuyerAccess}`});
  // The seller accepted the buyer's proposal, so both derived the same Agreement bytes.
  assert.equal(result.status,'delivery-ready',JSON.stringify(result).slice(0,400));
  assert.equal(result.partyVet.length,2);assert.ok(result.partyVet.every((entry)=>entry.strictStatus==='valid'));
  assert.equal(h.node2.chain.wire.record.accepted.length,7,'Listing, Agreement, two Vet, commitment, evidence and Deliverable CREATEs, as in-process');
  assert.equal(sellerApprovals.length,6);
  const rows=transportRows(h),slot=rows.slots.find((row)=>row.slot===`${result.jobId}:${CONTEXT}`);
  assert.ok(slot,'the context step went over the seller transport');assert.match(slot.effect,HASH);
  assert.deepEqual(rows.effects.find((row)=>row.effect===slot.effect),{effect:slot.effect,state:'complete',status:200});
});

// Open access with the switch at route; planFor() takes one fresh buyer
// account through prepare, identity (with its delegation) and plan.
async function routedOperator(t,options={}){
  withSellerContext(t,'route');
  const prompts=[],walletRequests=[];
  const h=await startOperatorPurchaseNode2({openBuyerAccess:true,authorizeSellerApproval:(input)=>{prompts.push(input);return true;},
    wrapSellerWalletFactory:(factory)=>(input)=>{const wallet=factory(input);return{...wallet,request:(request)=>{walletRequests.push(request);return wallet.request(request);}};},...options});
  t.after(()=>h.close());
  const origin=h.config.publicOrigin,harness={origin,mcpUrl:`${origin}/mcp`};
  const planFor=async(key)=>{
    const wallet=createEphemeralWallet(),provider=await linkAccount({...harness,address:wallet.address,signHex:wallet.signHex});
    const p=await tool(harness,{provider},'prepare_purchase',{listingId:h.config.listing.listingId,version:1,seller:h.prepared.operatorEvidence.seller,idempotencyKey:key,protocol:'dacs-sr2-wallet-agreement'});
    assert.equal(p.status,'agreement_pending',JSON.stringify(p));
    const api=(action,body={})=>portal(harness,`/portal/api/purchase/${p.operationId}/agreement/${action}`,{token:tokenFrom(p.approvalUrl),...body});
    const identity=await api('identity',{address:wallet.address});
    const plan=()=>api('plan',{signature:wallet.signHex(identity.signRequest.message),delegationSignature:wallet.signHex(identity.signRequest.delegation.message)});
    const planned=await plan();
    return{wallet,p,planned,plan,op:()=>h.application.services.ops.get(h.application.services.accounts.walletOwner(wallet.address),p.operationId)};
  };
  const evidenceLines=()=>{try{return readFileSync(join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'),'utf8').trim().split('\n').filter(Boolean).length;}catch(error){if(error.code==='ENOENT')return 0;throw error;}};
  const effects=()=>({accepted:h.node2.chain.wire.record.accepted.length,broadcasts:h.node2.chain.wire.record.broadcastAttempts.length,prompts:prompts.length,walletRequests:walletRequests.length,evidence:evidenceLines()});
  return{h,planFor,effects,prompts};
}

test('route: a retried context request makes no second Vet CREATE on the loopback chain, also after a restart; other bytes are refused',{timeout:600000},async t=>{
  const {h,planFor,effects,prompts}=await routedOperator(t);
  const {planned,op}=await planFor('route-retry');assert.equal(planned.error,undefined,JSON.stringify(planned));
  const operation=op(),protocol=operation.state.protocol;
  assert.equal(effects().accepted,3,'Listing and the two Vet CREATEs');
  assert.deepEqual(prompts.slice(1).map((prompt)=>prompt.request.content.artifactKind),['CompositeVerificationRecord','CompositeVerificationRecord']);
  const jobId=operation.terms.protocol.jobId,slot=transportRows(h).slots.find((row)=>row.slot===`${jobId}:${CONTEXT}`);assert.ok(slot);
  const retry=async(generatedAt=protocol.planned.draft.generatedAt)=>resolveDemDeliveryBuyerContext(h.composition.dacsProtocol.demDeliveryContext,{operation,listing:protocol.listing,buyerBundle:protocol.buyerBundle,generatedAt});
  const before=effects();
  const again=await retry();
  assert.equal(again.disposition,'present',again.reason);
  assert.equal(planAgreementFromInput(again.input).plan.agreementHash,protocol.planned.plan.agreementHash,'the same Agreement as the saved plan');
  assert.equal(contentHash(again.scope),protocol.agreementContext.scopeHash);
  assert.deepEqual(effects(),before,'no CREATE, broadcast or approval prompt');
  // The buyer sends only the request saved on the purchase; other bytes never leave
  // (the seller's own refusal of other bytes is covered offline).
  assert.equal(protocol.sellerContextRequest.generatedAt,protocol.planned.draft.generatedAt);
  const other=await retry(protocol.planned.draft.generatedAt+1000);
  assert.equal(other.disposition,'indeterminate');assert.match(other.reason,/differs from the one saved on the purchase; nothing was sent/);
  assert.deepEqual(effects(),before);
  await h.restart();
  assert.equal(h.composition.contextProvider.contexts.size,0,'the seller\'s in-memory context is gone');
  const afterRestart=await retry();
  assert.equal(afterRestart.disposition,'present',afterRestart.reason);
  assert.equal(canonicalize(afterRestart.input),canonicalize(again.input));
  assert.deepEqual(effects(),before,'answered from the transport journal: no second Vet CREATE');
  const rows=transportRows(h);
  assert.deepEqual(rows.slots.filter((row)=>row.slot.startsWith(`${jobId}:`)),[{slot:`${jobId}:${CONTEXT}`,effect:slot.effect}]);
  assert.equal(rows.effects.filter((row)=>row.effect===slot.effect).length,1);
});

test('route: in policy mode a start the write budget cannot hold is refused before any write',{timeout:600000},async t=>{
  const {h,planFor,effects}=await routedOperator(t,{sellerApproval:{mode:'policy',maxWritesPerHour:2}});
  const first=await planFor('route-budget-1');assert.equal(first.planned.error,undefined,JSON.stringify(first.planned));
  // One durable reservation for both Vet writes, converted by their two policy decisions, then closed.
  const contextLines=()=>evidence(h).filter((row)=>row.format==='dacs-node2-seller-context-admission/v1');
  const jobId=first.op().terms.protocol.jobId;
  assert.deepEqual(contextLines().map((row)=>[row.event,row.jobId]),[['hold',jobId],['release',jobId]]);
  assert.equal(evidence(h).filter((row)=>row.approvalMode==='policy'&&row.decision==='approved').length,2);
  const before=effects();
  // Both Vet writes of a second start would exceed two policy writes an hour.
  const second=await planFor('route-budget-2');
  assert.equal(second.planned.error,'agreement_context_held',JSON.stringify(second.planned));
  assert.match(second.planned.message,/seller refused the context request \(seller_budget_refused\)/);
  assert.deepEqual(effects(),{...before,evidence:before.evidence+1},'no CREATE, broadcast, wallet request, approval prompt or policy decision; one decision-log line');
  assert.deepEqual(contextLines().at(-1),{format:'dacs-node2-seller-context-admission/v1',event:'refused',jobId:second.op().terms.protocol.jobId,
    buyer:second.wallet.claim,reason:'seller_budget_refused',recordedAt:contextLines().at(-1).recordedAt});
});

test('route: with closed access a foreign buyer\'s own signed context request is refused before any effect (#38)',{timeout:600000},async t=>{
  withSellerContext(t,'route');
  const prompts=[];
  const h=await startOperatorPurchaseNode2({authorizeSellerApproval:(input)=>{prompts.push(input);return true;}});
  t.after(()=>h.close());
  const listing=h.composition.listing,support=purchaseSupport(listing),seller=listing.seller.identity.presentedBy,pin=listingPin(listing);
  const foreign=createEphemeralWallet(),unsigned=buildUnsignedIdentityBundle({address:foreign.address,presentedAt:Date.now(),sessionSeed:'TEST-foreign-route'});
  const buyerIdentityBundle=attachIdentityPresentation(unsigned,foreign.signHex(unsigned.message));
  const scope={source:AGREEMENT_CONTEXT_SOURCE,wallet:foreign.address,jobId:generateCanonicalJobId(),buyer:foreign.claim,buyerBundleHash:identityBundleHash(buyerIdentityBundle),seller,listingPin:pin,
    rail:{railId:DEM_RAIL.railId,railVersion:DEM_RAIL.railVersion},payee:support.payee,price:support.price,generatedAt:Date.now()};
  const authentication=createSellerTransportClientAuth({buyerSigner:{claim:foreign.claim,sign:foreign.signBytes},seller,resolveJob:()=>({listingPin:pin,agreementHash:sellerContextScopeHash(scope)})});
  const client=createSellerAgentClient({url:h.config.sellerOrigin,fetchImpl:h.fetchImpl,authentication,timeoutMs:30000});
  const before={accepted:h.node2.chain.wire.record.accepted.length,broadcasts:h.node2.chain.wire.record.broadcastAttempts.length,prompts:prompts.length,rows:transportRows(h)};
  await assert.rejects(client.agreementContext({scope,buyerIdentityBundle}),(error)=>error instanceof SellerRefusedError&&error.code==='buyer_access_closed'&&error.status===409);
  assert.deepEqual({accepted:h.node2.chain.wire.record.accepted.length,broadcasts:h.node2.chain.wire.record.broadcastAttempts.length,prompts:prompts.length,rows:transportRows(h)},before,'no CREATE, approval prompt or journal row');
  assert.equal(h.composition.contextProvider.invocations.length,0);
  // The operator's own route client sends nothing for a foreign buyer, or to an endpoint other than the purchase's.
  const custody=await openTestWalletCustody({directory:h.config.custodyDirectory,role:'buyer',publicOrigin:h.config.publicOrigin});t.after(()=>custody.close());
  const synthetic=(address,sellerAgent)=>{const operation=offOperation({listing,buyer:{address},jobId:generateCanonicalJobId()});operation.terms.protocol.sellerAgent=sellerAgent;return operation;};
  const custodyUnsigned=buildUnsignedIdentityBundle({address:custody.signer.address,presentedAt:Date.now(),sessionSeed:'TEST-custody-route'});
  const custodyBundle=attachIdentityPresentation(custodyUnsigned,custody.signer.signBytes(Buffer.from(custodyUnsigned.message)).toString('hex'));
  const viaClient=(operation,buyerBundle)=>resolveDemDeliveryBuyerContext(h.composition.dacsProtocol.demDeliveryContext,{operation,listing,buyerBundle,generatedAt:Date.now()});
  const foreignAnswer=await viaClient(synthetic(foreign.address,new URL(h.config.sellerOrigin).origin),buyerIdentityBundle);
  assert.equal(foreignAnswer.disposition,'indeterminate');assert.match(foreignAnswer.reason,/differs from operator test custody/);
  const moved=await viaClient(synthetic(custody.signer.address,'https://127.0.0.1:1'),custodyBundle);
  assert.equal(moved.disposition,'indeterminate');assert.match(moved.reason,/endpoint changed since this purchase was prepared/);
  assert.deepEqual({accepted:h.node2.chain.wire.record.accepted.length,broadcasts:h.node2.chain.wire.record.broadcastAttempts.length,prompts:prompts.length,rows:transportRows(h)},before);
});

// Fix 2: a lost answer is followed by a retried plan that resends the request
// saved on the purchase, and the seller's journal returns its first answer.
test('route: after a lost answer (reset, client timeout, or a 503 while the seller writes) the retried plan gets the first answer with no new write',{timeout:900000},async t=>{
  let fault=null,inFlight=null;const duplicates=[];
  const {h,planFor,effects}=await routedOperator(t,{rpcFault:async({url,body,headers})=>{
    if(new URL(url).pathname!==CONTEXT||!fault)return null;
    const kind=fault;fault=null;
    const forward=()=>h.node2.fetchImpl(url,{method:'POST',headers,body:JSON.stringify(body)}).then(async(response)=>({status:response.status,headers:response.headers,text:await response.text()}));
    if(kind==='503'){
      // The seller is still writing when the same signed request arrives again.
      const before=effects().walletRequests;inFlight=forward();
      for(let i=0;i<600&&effects().walletRequests===before;i++)await new Promise((resolve)=>setTimeout(resolve,50));
      const duplicate=await forward();duplicates.push(duplicate);
      return new Response(duplicate.text,{status:duplicate.status,headers:duplicate.headers});
    }
    await forward();
    if(kind==='timeout')throw new DOMException('TEST client timeout after the seller answered','TimeoutError');
    throw new Error('TEST connection reset after the seller answered');
  }});
  for(const kind of ['reset','timeout','503']){
    fault=kind;
    const before=effects();
    const {planned,plan,op}=await planFor(`route-lost-${kind}`);
    assert.equal(planned.error,'agreement_context_held',JSON.stringify(planned));assert.match(planned.message,/indeterminate/);
    await inFlight;inFlight=null;
    if(kind==='503'){assert.equal(duplicates.length,1);assert.equal(duplicates[0].status,503);assert.match(duplicates[0].text,/operation_uncertain/);}
    const written=effects();
    assert.equal(written.accepted,before.accepted+2,`${kind}: the seller wrote both Vet records once`);
    const saved=op().state.protocol.sellerContextRequest;
    const again=await plan();
    assert.equal(again.error,undefined,JSON.stringify(again));
    assert.deepEqual(effects(),written,`${kind}: no CREATE, broadcast, wallet request, approval prompt or decision line on the retry`);
    assert.ok(saved,'the request was saved before the first send');
    const protocol=op().state.protocol;
    assert.equal(protocol.planned.draft.generatedAt,saved.generatedAt,'the plan comes from the saved request');
    assert.equal(canonicalize(protocol.buyerBundle),canonicalize(saved.buyerBundle));
  }
});

// Fix 3: open access in manual mode puts no approval prompt in front of the
// operator for a job its app did not prepare for that buyer.
test('route: with open access in manual mode an unknown or another buyer\'s job, or one no longer open, is refused before any prompt, with one decision-log line each',{timeout:600000},async t=>{
  const {h,effects}=await routedOperator(t);
  const listing=h.composition.listing,support=purchaseSupport(listing),seller=listing.seller.identity.presentedBy,pin=listingPin(listing);
  const origin=h.config.publicOrigin,harness={origin,mcpUrl:`${origin}/mcp`};
  const owner=createEphemeralWallet(),provider=await linkAccount({...harness,address:owner.address,signHex:owner.signHex});
  const prepared=await tool(harness,{provider},'prepare_purchase',{listingId:h.config.listing.listingId,version:1,seller:h.prepared.operatorEvidence.seller,idempotencyKey:'route-unknown-owner',protocol:'dacs-sr2-wallet-agreement'});
  assert.equal(prepared.status,'agreement_pending',JSON.stringify(prepared));
  const ownersJob=h.application.services.ops.get(h.application.services.accounts.walletOwner(owner.address),prepared.operationId).terms.protocol.jobId;
  const attacker=createEphemeralWallet(),attackerWallet=attacker;
  const ask=async(jobId,{wallet:attacker=attackerWallet,refusal='context_job_unknown'}={})=>{
    const unsigned=buildUnsignedIdentityBundle({address:attacker.address,presentedAt:Date.now(),sessionSeed:'TEST-attacker-route'}),buyerIdentityBundle=attachIdentityPresentation(unsigned,attacker.signHex(unsigned.message));
    const scope={source:AGREEMENT_CONTEXT_SOURCE,wallet:attacker.address,jobId,buyer:attacker.claim,buyerBundleHash:identityBundleHash(buyerIdentityBundle),seller,listingPin:pin,
      rail:{railId:DEM_RAIL.railId,railVersion:DEM_RAIL.railVersion},payee:support.payee,price:support.price,generatedAt:Date.now()};
    const key=createEphemeralWallet(),payload={version:'1',kind:'seller-session-delegation',buyer:attacker.claim,sessionPublicKey:key.publicKeyRaw.toString('hex'),seller,listingPin:pin,jobId,notBefore:Date.now()-1000,expiresAt:Date.now()+3_600_000};
    const delegation={payload,signature:attacker.signBytes(sellerSessionDelegationSigningBytes(payload)).toString('base64url')};
    const authentication=createSellerTransportClientAuth({sessionSigner:{claim:key.claim,sign:key.signBytes},delegation,seller,resolveJob:()=>({listingPin:pin,agreementHash:sellerContextScopeHash(scope)})});
    const client=createSellerAgentClient({url:h.config.sellerOrigin,fetchImpl:h.fetchImpl,authentication,timeoutMs:30000});
    if(refusal===null)return client.agreementContext({scope,buyerIdentityBundle});
    await assert.rejects(client.agreementContext({scope,buyerIdentityBundle}),(error)=>error instanceof SellerRefusedError&&error.code===refusal&&error.status===409);
  };
  const before=effects(),rows=transportRows(h);
  await ask(generateCanonicalJobId());
  await ask(ownersJob);
  assert.deepEqual(effects(),{...before,evidence:before.evidence+2},'no CREATE, broadcast, wallet request or approval prompt');
  assert.deepEqual(transportRows(h),rows,'no journal row');
  assert.equal(h.composition.contextProvider.invocations.length,0);
  assert.deepEqual(evidence(h).slice(-2).map((row)=>[row.event,row.buyer,row.reason]),[['refused',attacker.claim,'context_job_unknown'],['refused',attacker.claim,'context_job_unknown']]);
  // The owner's own job is admitted only while its purchase is open: not after
  // its window, nor once it left agreement_pending (code review R6).
  const db=h.application.db,row=db.prepare('SELECT status, expires_at FROM operations WHERE id = ?').get(prepared.operationId);
  db.prepare('UPDATE operations SET expires_at = ? WHERE id = ?').run(new Date(Date.now()-1000).toISOString(),prepared.operationId);
  await ask(ownersJob,{wallet:owner});
  db.prepare('UPDATE operations SET expires_at = ?, status = ? WHERE id = ?').run(row.expires_at,'cancelled',prepared.operationId);
  await ask(ownersJob,{wallet:owner});
  assert.deepEqual(evidence(h).slice(-2).map((row)=>[row.event,row.buyer,row.reason]),[['refused',owner.claim,'context_job_unknown'],['refused',owner.claim,'context_job_unknown']]);
  assert.equal(h.composition.contextProvider.invocations.length,0);
  db.prepare('UPDATE operations SET status = ? WHERE id = ?').run(row.status,prepared.operationId);
  const admitted=await ask(ownersJob,{wallet:owner,refusal:null});
  assert.equal(admitted.disposition,'present',JSON.stringify(admitted).slice(0,200));assert.equal(h.composition.contextProvider.invocations.length,2);
});

// Fix round 2 (code P2-A): a signed admission refusal proves the seller's
// journal does not know the saved request, so the purchase drops it; each later
// plan attempt sends one fresh request.
test('route: after a signed admission refusal the purchase drops its saved request, and each plan attempt sends one fresh request',{timeout:600000},async t=>{
  const sent=[];
  const {h,planFor,effects}=await routedOperator(t,{sellerApproval:{mode:'policy',maxWritesPerHour:2},
    rpcFault:async({url,body})=>{if(new URL(url).pathname===CONTEXT)sent.push(body.scope.generatedAt);return null;}});
  // A step a crash left holding both hourly writes.
  const evidencePath=join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'),crashedJob=generateCanonicalJobId();
  assert.equal(await createSellerContextAdmission({evidencePath,sellerApproval:{mode:'policy',maxWritesPerHour:2}}).reserve({jobId:crashedJob,effect:'e'.repeat(64),writes:2,hold:'crashed-step'}),null);
  // Merge round 2 (Daybreak P2-1, P2-2): ops health with the operator state, and with the database alone.
  const stateDirectory=realpathSync(h.config.stateDirectory),databasePath=join(stateDirectory,'app','dacs-chatgpt.sqlite');
  const budget=()=>opsHealth({databasePath,operatorState:stateDirectory,sellerApproval:{mode:'policy',maxWritesPerHour:2},now:Date.now()}).seller.budget;
  // The crashed step's hold is counted as admission counts it, and named for the release command.
  assert.deepEqual(budget(),{window:'rolling-hour',writes:2,maxWrites:2,totalOs:'8000000000',totalDem:'8.000000000',maxTotalOs:'96000000000',maxTotalDem:'96.000000000',status:'at-limit',
    inFlightPreparation:{counted:false,maxWrites:1,maxTotalOs:'4000000000',maxTotalDem:'4.000000000'},contextHolds:[{jobId:crashedJob,holdId:'crashed-step',heldWrites:2}]});
  const {planned,plan,op}=await planFor('route-drop-refused');
  assert.equal(planned.error,'agreement_context_held',JSON.stringify(planned));assert.match(planned.message,/\(seller_budget_refused\)/);
  assert.equal(sent.length,1);assert.equal(op().state.protocol.sellerContextRequest,null,'the refused request is dropped');
  // The signed refusal came before the seller's provider ran: the attempt and
  // its event say nothing was written, so the database alone shows nothing to read back.
  const purchaseId=op().id;
  const noWrite=(label,refusals)=>{
    const recorded=op().state.protocol.attempts.filter((entry)=>entry.step==='agreement-context');
    assert.deepEqual(recorded.map((entry)=>[entry.outcome,entry.reason,entry.written]),Array(refusals).fill(['rejected','seller refused the context request (seller_budget_refused)',false]),label);
    const db=new DatabaseSync(databasePath,{readOnly:true});
    try{assert.deepEqual(db.prepare("SELECT data FROM operation_events WHERE operation_id = ? AND type = 'protocol_agreement-context' ORDER BY seq").all(purchaseId).map((row)=>JSON.parse(row.data).written),Array(refusals).fill(false),label);}
    finally{db.close();}
    const report=opsHealth({databasePath,now:Date.now()});
    assert.deepEqual(report.stuck.filter((row)=>row.purchaseId===purchaseId),[],`${label}: not stuck`);
    assert.equal(report.purchases.find((row)=>row.purchaseId===purchaseId).outcome,'recorded',label);
  };
  noWrite('the refusal',1);
  const again=await plan();
  assert.match(again.message,/\(seller_budget_refused\)/);
  assert.equal(sent.length,2,'one request for the attempt');assert.ok(sent[1]>sent[0],'a fresh request');
  assert.equal(op().state.protocol.sellerContextRequest,null);
  noWrite('the retried refusal',2);
  // The operator releases the crashed step's hold; the next attempt is admitted.
  assert.deepEqual(await releaseSellerContextHolds({evidencePath,jobId:crashedJob}),['crashed-step']);
  const freed=budget();assert.deepEqual([freed.writes,freed.status,freed.contextHolds],[0,'ok',undefined]);
  const before=effects();
  const admitted=await plan();
  assert.equal(admitted.error,undefined,JSON.stringify(admitted));
  assert.equal(sent.length,3);assert.ok(sent[2]>sent[1]);
  assert.equal(effects().accepted,before.accepted+2,'both Vet records written once');
  const protocol=op().state.protocol;
  assert.equal(protocol.sellerContextRequest.generatedAt,sent[2]);assert.equal(protocol.planned.draft.generatedAt,sent[2]);
  noWrite('after the admitted retry',2);
});

// Fix round 2 (Daybreak P2): the seller provider's in-memory contexts are what a
// seller restart loses before the proposal; the durable records recover them
// read only, and the purchase completes with no Vet written again. Since main
// 8228e66 those records are the provider's party Vet store, which keeps each
// answered context before the seller answers.
test('route: a completed context the seller no longer holds in memory is recovered for the proposal; the purchase completes with no second Vet',{timeout:600000},async t=>{
  withSellerContext(t,'route');
  let emptied=null,kept=null,h;
  // The job's party Vet row when the proposal arrives (main deletes it once the purchase is paid).
  const partyVetRows=()=>{const db=new DatabaseSync(join(h.config.stateDirectory,'seller-party-vet.sqlite'),{readOnly:true});try{return db.prepare('SELECT value FROM jobs').all().map((row)=>JSON.parse(row.value));}finally{db.close();}};
  h=await startOperatorPurchaseNode2({authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true,rpcFault:async({url})=>{
    if(new URL(url).pathname==='/dacs/v1/agreements/proposals'&&emptied===null){h.composition.contextProvider.contexts.clear();emptied=h.composition.contextProvider.contexts.size;kept=partyVetRows();}
    return null;
  }});
  t.after(()=>h.close());
  let result;
  try{result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'route-recovered-context'});}
  catch(error){const row=h.application.db.prepare("SELECT state FROM operations WHERE kind = 'purchase'").get();result={thrown:error.message,lastAttempt:JSON.parse(row?.state??'{}').protocol?.attempts?.at(-1)??null};}
  assert.equal(emptied,0,'the proposal reached a seller without the in-memory context');
  assert.equal(result.status,'delivery-ready',JSON.stringify(result).slice(0,400));
  assert.equal(h.node2.chain.wire.record.accepted.length,7,'Listing, Agreement, two Vet, commitment, evidence and Deliverable CREATEs: no Vet written again');
  assert.equal(h.composition.contextProvider.invocations.length,2,'each Vet produced once');
  assert.equal([...h.composition.contextProvider.contexts.values()].some((entry)=>entry.input.jobId===result.jobId),false,'nothing recovered into memory');
  assert.ok(kept.some((row)=>row.jobId===result.jobId&&row.seller?.generatedAts?.length===1),'the proposal was answered from the job\'s party Vet row');
});

// Fix round 2 (Daybreak P2): the proposal of an exact saved request is checked
// against the seller's durable admission, not against its arrival time.
test('route: after a lost answer and eleven minutes, the plan from the saved request is proposed and the seller accepts it',{timeout:900000},async t=>{
  withSellerContext(t,'route');
  // The clock stops only once the operator is up: main's start-up check reads it
  // against the certificate the harness has just made (whole-second validFrom).
  let clock=null,lose=true,h;
  h=await startOperatorPurchaseNode2({openBuyerAccess:true,now:()=>clock??Date.now(),authorizeSellerApproval:()=>true,rpcFault:async({url,body,headers})=>{
    if(new URL(url).pathname!==CONTEXT||!lose)return null;
    lose=false;
    await (await h.node2.fetchImpl(url,{method:'POST',headers,body:JSON.stringify(body)})).text();
    throw new Error('TEST lost context answer after the seller completed');
  }});
  t.after(()=>h.close());
  clock=Date.now();
  const harness={origin:h.config.publicOrigin,mcpUrl:`${h.config.publicOrigin}/mcp`};
  const wallet=createEphemeralWallet(),provider=await linkAccount({...harness,address:wallet.address,signHex:wallet.signHex});
  const prepared=await tool(harness,{provider},'prepare_purchase',{listingId:h.config.listing.listingId,version:1,seller:h.prepared.operatorEvidence.seller,idempotencyKey:'route-stale-saved',protocol:'dacs-sr2-wallet-agreement'});
  const token=tokenFrom(prepared.approvalUrl),api=(action,body={})=>portal(harness,`/portal/api/purchase/${prepared.operationId}/agreement/${action}`,{token,...body});
  const op=()=>h.application.services.ops.get(h.application.services.accounts.walletOwner(wallet.address),prepared.operationId);
  const identity=await api('identity',{address:wallet.address});
  const request={signature:wallet.signHex(identity.signRequest.message),delegationSignature:wallet.signHex(identity.signRequest.delegation.message)};
  assert.equal((await api('plan',request)).error,'agreement_context_held');
  const writes=h.node2.chain.wire.record.accepted.length;
  clock+=11*60*1000;
  const planned=await api('plan',request);
  assert.equal(planned.error,undefined,JSON.stringify(planned));
  assert.equal(op().state.protocol.planned.draft.generatedAt,op().state.protocol.sellerContextRequest.generatedAt,'planned from the saved request');
  const realNow=Date.now;Date.now=()=>clock;t.after(()=>{Date.now=realNow;});
  const browserApi=async(path,body)=>{const response=await fetch(`${harness.origin}${path}`,{method:'POST',headers:{'content-type':'application/json',origin:harness.origin},body:JSON.stringify(body)});
    const answer={status:response.status,...await response.json()};if(answer.status!==200)throw Object.assign(new Error(answer.message),{code:answer.error});return answer;};
  await createOfflineAgreementBrokerClient({id:prepared.operationId,token,api:browserApi}).authenticate({address:wallet.address,sign:async(message)=>wallet.signHex(message)});
  const signed=await api('sign',{agreementSignature:wallet.signHex(planned.signRequest.agreementMessage)});
  assert.equal(signed.status,'agreement_pending',JSON.stringify(signed.evidence?.protocol?.lastAttempt));
  assert.doesNotMatch(JSON.stringify(signed.evidence?.protocol?.lastAttempt??{}),/proposal-publication/);
  // The seller signed its contribution: its journal holds the completed proposal.
  const jobId=op().terms.protocol.jobId,db=new DatabaseSync(join(h.config.stateDirectory,'seller-transport.sqlite'),{readOnly:true});
  let proposal;try{proposal=db.prepare("SELECT e.state, e.status, e.response FROM peer_slots s JOIN peer_effects e ON e.effect = s.effect WHERE s.slot = ?").get(`${jobId}:/dacs/v1/agreements/proposals`);}finally{db.close();}
  assert.equal(proposal?.state,'complete');assert.equal(proposal.status,200);assert.equal(JSON.parse(proposal.response).disposition,'complete');
  assert.equal(h.node2.chain.wire.record.accepted.length,writes,'no Vet written again');
});

// One fresh buyer account through prepare and identity on the portal (open
// access); plan() and sign(planned) as the browser makes them.
async function portalPurchase(h,key){
  const harness={origin:h.config.publicOrigin,mcpUrl:`${h.config.publicOrigin}/mcp`};
  const wallet=createEphemeralWallet(),provider=await linkAccount({...harness,address:wallet.address,signHex:wallet.signHex});
  const prepared=await tool(harness,{provider},'prepare_purchase',{listingId:h.config.listing.listingId,version:1,seller:h.prepared.operatorEvidence.seller,idempotencyKey:key,protocol:'dacs-sr2-wallet-agreement'});
  assert.equal(prepared.status,'agreement_pending',JSON.stringify(prepared));
  const token=tokenFrom(prepared.approvalUrl),api=(action,body={})=>portal(harness,`/portal/api/purchase/${prepared.operationId}/agreement/${action}`,{token,...body});
  const op=()=>h.application.services.ops.get(h.application.services.accounts.walletOwner(wallet.address),prepared.operationId);
  const identity=await api('identity',{address:wallet.address});
  const request={signature:wallet.signHex(identity.signRequest.message),delegationSignature:wallet.signHex(identity.signRequest.delegation.message)};
  const sign=async(planned)=>{
    const browserApi=async(path,body)=>{const response=await fetch(`${harness.origin}${path}`,{method:'POST',headers:{'content-type':'application/json',origin:harness.origin},body:JSON.stringify(body)});
      const answer={status:response.status,...await response.json()};if(answer.status!==200)throw Object.assign(new Error(answer.message),{code:answer.error});return answer;};
    await createOfflineAgreementBrokerClient({id:prepared.operationId,token,api:browserApi}).authenticate({address:wallet.address,sign:async(message)=>wallet.signHex(message)});
    return api('sign',{agreementSignature:wallet.signHex(planned.signRequest.agreementMessage)});
  };
  return{wallet,op,plan:()=>api('plan',request),sign};
}
const vetCreates=(h)=>h.node2.chain.wire.record.accepted.filter((tx)=>tx.content?.data?.[1]?.metadata?.artifactKind==='CompositeVerificationRecord').length;
// The seller's journal holds the job's completed proposal (the seller signed its contribution).
const proposalComplete=(h,jobId)=>{
  const db=new DatabaseSync(join(h.config.stateDirectory,'seller-transport.sqlite'),{readOnly:true});
  try{const row=db.prepare("SELECT e.state, e.status, e.response FROM peer_slots s JOIN peer_effects e ON e.effect = s.effect WHERE s.slot = ?").get(`${jobId}:/dacs/v1/agreements/proposals`);
    return row?.state==='complete'&&row.status===200&&JSON.parse(row.response).disposition==='complete';}
  finally{db.close();}
};

// Sweep (code P1-1): the operator's per-write purchase check (the route's
// `writable`): a purchase cancelled after admission starts no new Vet write and
// puts no approval prompt in front of the operator.
test('route: in manual mode a purchase cancelled at its first Vet approval gets no second Vet prompt or write',{timeout:600000},async t=>{
  let h,cancelled=false;
  const vetPrompts=[];
  const routed=await routedOperator(t,{authorizeSellerApproval:({request})=>{
    if(request.content?.artifactKind!=='CompositeVerificationRecord')return true;
    vetPrompts.push(request.content.logicalAddress);
    if(!cancelled){cancelled=true;h.application.db.prepare("UPDATE operations SET status = 'cancelled' WHERE kind = 'purchase'").run();}
    return true;
  }});
  h=routed.h;
  const {planned}=await routed.planFor('route-cancelled-mid-step');
  assert.ok(cancelled);assert.notEqual(planned.error,undefined,JSON.stringify(planned));
  assert.equal(vetPrompts.length,1,'the second Vet is never asked');
  assert.ok(vetCreates(h)<=1,'the second Vet is never written');
  assert.equal(h.composition.contextProvider.invocations.length,vetCreates(h));
});

// Sweep (code P1-2): without an admitted route request (in-process here) the
// seller keeps its ten-minute clock window for the proposal's generatedAt.
test('in-process: a proposal whose generatedAt is eleven minutes old is refused by the seller clock window',{timeout:900000},async t=>{
  withSellerContext(t,undefined);
  let clock=null;
  const h=await startOperatorPurchaseNode2({openBuyerAccess:true,now:()=>clock??Date.now(),authorizeSellerApproval:()=>true});
  t.after(()=>h.close());
  clock=Date.now();
  const {op,plan,sign}=await portalPurchase(h,'in-process-stale-proposal');
  const planned=await plan();
  assert.equal(planned.error,undefined,JSON.stringify(planned));
  assert.equal(op().state.protocol.sellerContextRequest??null,null,'in-process saves no context request');
  clock+=11*60*1000;
  const realNow=Date.now;Date.now=()=>clock;t.after(()=>{Date.now=realNow;});
  const signed=await sign(planned);
  assert.match(JSON.stringify(signed),/proposal generatedAt is outside the seller clock window/);
  assert.equal(proposalComplete(h,op().terms.protocol.jobId),false);
});

// Sweep (code P2-2): the operator wires the provider's restart recovery
// (composition.mjs retainedScope). A crash after both Vet writes and before
// the party Vet row kept the context: the retry is reconciled from both
// records, and the proposal is answered from the durable admission record and
// journal, with no Vet written again.
test('route: after a crash before its party Vet row kept the context, the proposal is answered from the durable records with no second Vet',{timeout:900000},async t=>{
  withSellerContext(t,'route');
  let crash=true;
  const h=await startOperatorPurchaseNode2({openBuyerAccess:true,authorizeSellerApproval:()=>true,
    wrapPartyVetStore:(store)=>Object.freeze({...store,update:(key,change)=>store.update(key,(current)=>{
      const next=change(current);
      if(crash&&next?.seller&&!current?.seller){crash=false;throw new Error('TEST crash before the context was kept');}
      return next;
    })})});
  t.after(()=>h.close());
  const {op,plan,sign}=await portalPurchase(h,'route-crash-before-party-vet-row');
  const first=await plan();
  assert.equal(first.error,'agreement_context_held',JSON.stringify(first));
  assert.equal(crash,false);assert.equal(vetCreates(h),2,'both Vets were written before the crash');
  const planned=await plan();
  assert.equal(planned.error,undefined,JSON.stringify(planned));
  // The reconciliation answered from both Vet records (and kept them in memory);
  // the seller restarts before the proposal, so only the durable records remain.
  await h.restart();
  assert.equal(h.composition.contextProvider.contexts.size,0,'nothing in memory');
  const signed=await sign(planned);
  assert.equal(signed.status,'agreement_pending',JSON.stringify(signed.evidence?.protocol?.lastAttempt??signed));
  assert.ok(proposalComplete(h,op().terms.protocol.jobId),'the seller signed its contribution');
  assert.equal(vetCreates(h),2,'no Vet written again');assert.equal(h.composition.contextProvider.invocations.length,0,'no Vet produced after the restart');
});

// Sweep (code P2-3): a refusal the seller's journal makes
// (peer_operation_conflict: other bytes for a started job) is not a fresh
// admission refusal, so the purchase keeps its saved request and sends exactly
// those bytes again.
test('route: after the seller journal refuses other bytes for a started job, the purchase keeps its saved request and resends the same bytes',{timeout:600000},async t=>{
  const sent=[];
  const {h,effects}=await routedOperator(t,{rpcFault:async({url,body})=>{if(new URL(url).pathname===CONTEXT)sent.push(canonicalize(body));return null;}});
  const {wallet,op,plan}=await portalPurchase(h,'route-keep-saved');
  const jobId=op().terms.protocol.jobId,listing=h.composition.listing,support=purchaseSupport(listing),seller=listing.seller.identity.presentedBy,pin=listingPin(listing);
  // The same buyer starts the job with other bytes (its own earlier presentation and time).
  const unsigned=buildUnsignedIdentityBundle({address:wallet.address,presentedAt:Date.now()-5000,sessionSeed:'TEST-earlier-request'}),buyerIdentityBundle=attachIdentityPresentation(unsigned,wallet.signHex(unsigned.message));
  const scope={source:AGREEMENT_CONTEXT_SOURCE,wallet:wallet.address,jobId,buyer:wallet.claim,buyerBundleHash:identityBundleHash(buyerIdentityBundle),seller,listingPin:pin,
    rail:{railId:DEM_RAIL.railId,railVersion:DEM_RAIL.railVersion},payee:support.payee,price:support.price,generatedAt:Date.now()-5000};
  const key=createEphemeralWallet(),payload={version:'1',kind:'seller-session-delegation',buyer:wallet.claim,sessionPublicKey:key.publicKeyRaw.toString('hex'),seller,listingPin:pin,jobId,notBefore:Date.now()-1000,expiresAt:Date.now()+3_600_000};
  const delegation={payload,signature:wallet.signBytes(sellerSessionDelegationSigningBytes(payload)).toString('base64url')};
  const authentication=createSellerTransportClientAuth({sessionSigner:{claim:key.claim,sign:key.signBytes},delegation,seller,resolveJob:()=>({listingPin:pin,agreementHash:sellerContextScopeHash(scope)})});
  const earlier=await createSellerAgentClient({url:h.config.sellerOrigin,fetchImpl:h.fetchImpl,authentication,timeoutMs:30000}).agreementContext({scope,buyerIdentityBundle});
  assert.equal(earlier.disposition,'present',JSON.stringify(earlier).slice(0,200));
  sent.length=0;
  const before=effects();
  const refused=await plan();
  assert.equal(refused.error,'agreement_context_held',JSON.stringify(refused));assert.match(refused.message,/\(peer_operation_conflict\)/);
  const saved=op().state.protocol.sellerContextRequest;
  assert.ok(saved,'the saved request is kept');assert.equal(sent.length,1);
  const again=await plan();
  assert.match(again.message,/\(peer_operation_conflict\)/);
  assert.equal(sent.length,2);assert.equal(sent[1],sent[0],'exactly the same bytes again');
  assert.deepEqual(op().state.protocol.sellerContextRequest,saved);
  assert.deepEqual(effects(),{...before,evidence:effects().evidence},'no CREATE, broadcast, wallet request or approval prompt');
});

// Main's local seller TLS guard (#71) covers the context request as it covers
// every other seller request: with the certificate expired or not yet valid,
// the saved request is refused before signing and dispatch. Inside the
// purchase window it is still sent. Each authenticated request the seller
// receives adds one peer_nonces row, also when its journal answers it; each
// request the buyer signs adds a signature.
test('route: the seller TLS guard refuses a context request before signing and dispatch',{timeout:600000},async t=>{
  withSellerContext(t,'route');
  let time=null;
  const h=await startOperatorPurchaseNode2({authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true,now:()=>time??Date.now()});
  t.after(()=>h.close());
  const signatures=countSignatures(t);
  const result=await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:'route-tls-guard'});
  assert.equal(result.status,'delivery-ready',JSON.stringify(result).slice(0,400));
  const accountId=h.application.db.prepare('SELECT account_id FROM operations WHERE id = ?').get(result.operationId).account_id;
  const operation=h.application.services.ops.get(accountId,result.operationId),protocol=operation.state.protocol;
  const retry=()=>resolveDemDeliveryBuyerContext(h.composition.dacsProtocol.demDeliveryContext,{operation,listing:protocol.listing,buyerBundle:protocol.buyerBundle,generatedAt:protocol.sellerContextRequest.generatedAt});
  const x509=new X509Certificate(readFileSync(h.config.sellerTls.certificatePath)),start=Date.parse(x509.validFrom),end=Date.parse(x509.validTo);
  const windowMs=PURCHASE_APPROVAL_TTL_MS+h.config.listing.deadlineSecAfterCommit*1000+SELLER_SESSION_KEY_GRACE_MS,sent=()=>transportRows(h).nonces;
  for(const at of [null,end-windowMs]){
    time=at;const before=sent(),signed=signatures(),answer=await retry();
    assert.equal(answer.disposition,'present',`${at}: ${answer.reason}`);assert.equal(sent(),before+1,'sent once, answered from the journal');
    assert.ok(signatures()>signed,'the buyer signed the request');
  }
  for(const [at,reason] of [[end,/seller TLS certificate expired/],[start-1,/seller TLS certificate is not yet valid/]]){
    time=at;const before=sent(),signed=signatures(),answer=await retry();
    assert.equal(answer.disposition,'indeterminate');assert.match(answer.reason,reason);
    assert.equal(Object.hasOwn(answer,'written'),false,'a local refusal never says nothing was written');
    // Merge round 4 (Daybreak P2-1): main's attempt facts for a guard refusal.
    assert.deepEqual([answer.causeCode,answer.dispatched],['tls',false]);
    assert.equal(sent(),before,'refused before dispatch: the seller authenticated no request');
    assert.equal(signatures(),signed,'refused before signing');
  }
  time=null;
});

// Merge round 4 (Daybreak P2-1): a purchase prepared while the certificate
// covers its window, planned once the operator sees the certificate end (as
// after a restart with a shorter one: the start-up check refuses only one that
// has already ended). The guard refuses before signing and dispatch, and the
// purchase records it as main records every guard refusal: `causeCode: 'tls'`
// and `dispatched: false`, never `written`. Database-only ops health reads it as
// not sent; the saved request is kept and planned from once the certificate is
// usable. A context request sent earlier stays unread: the refusal settles nothing.
test('route: a context plan the TLS guard refuses is recorded as not sent, and an earlier sent request stays unread',{timeout:900000},async t=>{
  withSellerContext(t,'route');
  let time=null,lose=false,h;
  h=await startOperatorPurchaseNode2({authorizeSellerApproval:()=>true,now:()=>time??Date.now(),appNow:()=>Date.now(),evidenceResumeTimer:{every:()=>null,cancel:()=>{}},
    rpcFault:async({url,body,headers})=>{
      if(new URL(url).pathname!==CONTEXT||!lose)return null;
      lose=false;
      await (await h.node2.fetchImpl(url,{method:'POST',headers,body:JSON.stringify(body)})).text();
      throw new Error('TEST lost context answer after the seller completed');
    }});
  t.after(()=>h.close());
  const signatures=countSignatures(t),end=Date.parse(new X509Certificate(readFileSync(h.config.sellerTls.certificatePath)).validTo);
  const origin=h.config.publicOrigin,harness={origin,mcpUrl:`${origin}/mcp`};
  const custody=await openTestWalletCustody({directory:h.config.custodyDirectory,role:'buyer',publicOrigin:origin});t.after(()=>custody.close());
  const signHex=(message)=>custody.signer.signBytes(Buffer.from(message)).toString('hex');
  const provider=await linkAccount({...harness,address:custody.signer.address,signHex}),accountId=h.application.services.accounts.walletOwner(custody.signer.address);
  const databasePath=join(realpathSync(h.config.stateDirectory),'app','dacs-chatgpt.sqlite');
  // [outcome, causeCode, dispatched, has written] of each context attempt.
  const marks=(rows)=>rows.map((row)=>[row.outcome,row.causeCode,row.dispatched,Object.hasOwn(row,'written')]);
  const purchase=async(key)=>{
    const p=await tool(harness,{provider},'prepare_purchase',{listingId:h.config.listing.listingId,version:1,seller:h.prepared.operatorEvidence.seller,idempotencyKey:key,protocol:'dacs-sr2-wallet-agreement'});
    assert.equal(p.status,'agreement_pending',JSON.stringify(p));
    const api=(action,body={})=>portal(harness,`/portal/api/purchase/${p.operationId}/agreement/${action}`,{token:tokenFrom(p.approvalUrl),...body});
    const identity=await api('identity',{address:custody.signer.address});
    assert.equal(identity.error,undefined,JSON.stringify(identity));
    const signature=signHex(identity.signRequest.message),op=()=>h.application.services.ops.get(accountId,p.operationId);
    return{id:p.operationId,op,plan:()=>api('plan',{signature}),
      attempts:()=>marks(op().state.protocol.attempts.filter((entry)=>entry.step==='agreement-context')),
      events:()=>marks(h.application.services.ops.history(p.operationId).filter((event)=>event.type==='protocol_agreement-context').map((event)=>event.data))};
  };
  const health=(id)=>{
    const report=opsHealth({databasePath,now:Date.now()}),row=report.purchases.find((entry)=>entry.purchaseId===id);
    return{outcome:row.outcome,causeCode:row.causeCode,lastAttemptDispatched:row.lastAttemptDispatched,stuck:report.stuck.filter((entry)=>entry.purchaseId===id).map((entry)=>entry.outcome)};
  };
  // The plan with the operator's clock at the certificate's end.
  const refused=async(p)=>{
    const effects=()=>({signatures:signatures(),nonces:transportRows(h).nonces,writes:h.node2.chain.wire.record.accepted.length}),before=effects();
    time=end;const answer=await p.plan();time=null;
    assert.equal(answer.error,'agreement_context_held',JSON.stringify(answer));assert.match(answer.message,/seller TLS certificate expired/);
    assert.deepEqual(effects(),before,'no signature, no request, no write');
  };

  // The purchase's first context request is the one refused.
  const first=await purchase('route-tls-first');
  await refused(first);
  const saved=first.op().state.protocol.sellerContextRequest;
  assert.ok(Number.isSafeInteger(saved?.generatedAt),'the saved request is kept');
  assert.deepEqual(first.attempts(),[['indeterminate','tls',false,false]]);
  assert.deepEqual(first.events(),[['indeterminate','tls',false,false]]);
  assert.deepEqual(health(first.id),{outcome:'not-sent',causeCode:'tls',lastAttemptDispatched:false,stuck:[]});
  // The certificate is usable again: the saved request is sent and planned.
  const planned=await first.plan();
  assert.equal(planned.error,undefined,JSON.stringify(planned));
  assert.equal(first.op().state.protocol.planned.draft.generatedAt,saved.generatedAt,'planned from the saved request');
  h.application.services.purchases.cancel({accountId,operationId:first.id});

  // A request sent earlier lost its answer: the seller may have written its Vets.
  const second=await purchase('route-tls-after-lost');
  lose=true;const signed=signatures(),lost=await second.plan();
  assert.equal(lost.error,'agreement_context_held',JSON.stringify(lost));assert.ok(signatures()>signed,'the lost request was signed and sent');
  await refused(second);
  assert.deepEqual(second.attempts(),[['indeterminate','other',undefined,false],['indeterminate','tls',false,false]]);
  assert.deepEqual(second.events(),[['indeterminate','other',undefined,false],['indeterminate','tls',false,false]]);
  assert.deepEqual(health(second.id),{outcome:'seller-journal-not-read',causeCode:'tls',lastAttemptDispatched:false,stuck:['seller-journal-not-read']});
});
