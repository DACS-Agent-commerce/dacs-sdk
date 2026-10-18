import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { openTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';
import { auth } from '@modelcontextprotocol/client';
import { CookieJar, TestOAuthProvider } from './helpers/oauth.mjs';
import { tool, portal, tokenFrom } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createOperatorBuyerAccess, operatorBuyerAccessConfig } from '../src/devnet-demo/buyer-access.mjs';
import { attachIdentityPresentation } from '../src/dacs/listing.mjs';
import { resolveDemDeliveryBuyerContext } from '../src/dacs/dem-delivery-context-consumer.mjs';

async function linkAccount({harness,wallet}){
  const scope='dacs.account.read dacs.purchases.write',callbackUrl=`${harness.origin}/operator/oauth/callback`;
  class Provider extends TestOAuthProvider{get redirectUrl(){return callbackUrl;}get clientMetadata(){return{...super.clientMetadata,redirect_uris:[callbackUrl]};}}
  const provider=new Provider({scope}),jar=new CookieJar();
  const follow=async start=>{
    let url=new URL(start);
    for(let i=0;i<12;i++){
      if(url.href.startsWith(callbackUrl))return url;
      const response=await fetch(url,{redirect:'manual',headers:{cookie:jar.header(url)}});jar.store(response);
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location)return url;url=new URL(location,url);
    }
    throw new Error('TEST OAuth redirect bound exceeded');
  };
  assert.equal(await auth(provider,{serverUrl:harness.mcpUrl,scope}),'REDIRECT');
  const page=await follow(provider.authorizationUrl),uid=/\/portal\/authorize\/([^/?#]+)/.exec(page.pathname)?.[1];assert.ok(uid);
  const api=async(action,body)=>{
    const url=`${harness.origin}/portal/authorize/${uid}/api/${action}`,response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',cookie:jar.header(url)},body:JSON.stringify(body)});
    jar.store(response);const out=await response.json();assert.equal(response.status,200,JSON.stringify(out));return out;
  };
  const challenge=await api('challenge',{address:wallet.address}),done=await api('complete',{challengeId:challenge.challengeId,signature:wallet.signHex(challenge.message)});
  const callback=await follow(done.redirectTo);
  assert.equal(await auth(provider,{serverUrl:harness.mcpUrl,authorizationCode:callback.searchParams.get('code'),iss:callback.searchParams.get('iss'),scope}),'AUTHORIZED');
  return{provider};
}

const MODE='dacs-sr2-wallet-agreement';
const closed=error=>error.code==='buyer_access_closed';
const approvalRows=async h=>(await readFile(join(h.config.stateDirectory,'evidence','seller-approvals.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).filter(row=>row.decision);

async function setup(t,{openBuyerAccess,sellerApprovalMode='policy'}={}){
  const manual=[],walletRequests=[],rpcRequests=[];
  const h=await startOperatorPurchaseNode2({openBuyerAccess,sellerApproval:{mode:sellerApprovalMode},authorizeSellerApproval:input=>{manual.push(input);return true;},
    rpcFault:input=>{if(!new URL(input.url).pathname.startsWith('/dacs/'))rpcRequests.push(input);return null;},
    wrapSellerWalletFactory:factory=>options=>{const wallet=factory(options);return{...wallet,request:input=>{walletRequests.push(input);return wallet.request(input);}};}});
  t.after(()=>h.close());
  const harness={origin:h.config.publicOrigin,mcpUrl:`${h.config.publicOrigin}/mcp`};
  const custody=await openTestWalletCustody({directory:h.config.custodyDirectory,role:'buyer',publicOrigin:h.config.publicOrigin});t.after(()=>custody.close());
  await linkAccount({harness,wallet:{address:custody.signer.address,signHex:message=>custody.signer.signBytes(Buffer.from(message)).toString('hex')}});
  const wallet=createEphemeralWallet(),{provider}=await linkAccount({harness,wallet});
  assert.notEqual(wallet.claim,h.prepared.operatorEvidence.buyer);
  assert.notEqual(h.application.services.accounts.walletOwner(wallet.address),h.application.services.accounts.walletOwner(custody.signer.address));
  const args=idempotencyKey=>({listingId:h.config.listing.listingId,version:1,seller:h.prepared.operatorEvidence.seller,idempotencyKey,protocol:MODE});
  return{h,harness,wallet,manual,walletRequests,rpcRequests,args,prepare:key=>tool(harness,{provider},'prepare_purchase',args(key)),
    api:(p,action,body={})=>portal(harness,`/portal/api/purchase/${p.operationId}/agreement/${action}`,{token:tokenFrom(p.approvalUrl),...body}),
    op:p=>h.application.services.ops.get(h.application.services.accounts.walletOwner(wallet.address),p.operationId)};
}

async function effects(w){
  return{manualApprovals:w.manual.length,sellerDecisions:(await approvalRows(w.h)).length,walletRequests:w.walletRequests.length,rpcRequests:w.rpcRequests.length,
    acceptedCreates:w.h.node2.chain.wire.record.accepted.length,createBroadcasts:w.h.node2.chain.wire.record.broadcastAttempts.length,nativeBroadcasts:w.h.node2.chain.record.broadcasts.length};
}
const assertRefused=response=>{assert.equal(response.error,'buyer_access_closed',JSON.stringify(response));assert.equal(response.signRequest,undefined);};

async function preparedIdentity(w,key){
  const p=await w.prepare(key);assert.equal(p.status,'agreement_pending',JSON.stringify(p));
  const identity=await w.api(p,'identity',{address:w.wallet.address});assert.equal(identity.error,undefined,JSON.stringify(identity));
  const signatures={signature:w.wallet.signHex(identity.signRequest.message),delegationSignature:w.wallet.signHex(identity.signRequest.delegation.message)};
  return{p,identity,signatures};
}

async function closeAccess(w){
  w.h.config.openBuyerAccess=false;
  await writeFile(w.h.configPath,`${JSON.stringify(w.h.config)}\n`,{mode:0o600});await w.h.restart();
  assert.equal(w.h.prepared.operatorEvidence.openBuyerAccess,false);
}

import { createProtocolPurchases } from '../src/dacs/protocol-purchases.mjs';
import { createDevnetDemoComposition } from '../src/devnet-demo/composition.mjs';

for(const sellerApprovalMode of ['manual','policy'])test(`direct provider refuses foreign buyer before work (${sellerApprovalMode})`,{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true,sellerApprovalMode}),{p,signatures}=await preparedIdentity(w,'direct-provider');
  await closeAccess(w);const before=await effects(w),operation=w.op(p),history=w.h.application.services.ops.history(p.operationId);
  const buyerBundle=attachIdentityPresentation(operation.state.protocol.identity,signatures.signature);
  const resolved=await resolveDemDeliveryBuyerContext(w.h.composition.dacsProtocol.demDeliveryContext,{operation,listing:w.h.composition.listing,buyerBundle,generatedAt:Date.now()});
  assert.notEqual(resolved.disposition,'present');
  await assert.rejects(w.h.composition.contextProvider.resolveSeller({jobId:operation.terms.protocol.jobId,buyerIdentityBundle:buyerBundle}),closed);
  await assert.rejects(async()=>w.h.composition.dacsProtocol.nativePaymentEvidence.anchorEvidence({jobId:operation.terms.protocol.jobId,artifact:{}}),closed);
  assert.throws(()=>w.h.composition.deliverableProducer({agreement:{jobId:operation.terms.protocol.jobId}}),closed);
  assert.deepEqual(await effects(w),before);
  assert.deepEqual(w.op(p),operation);assert.deepEqual(w.h.application.services.ops.history(p.operationId),history);
});

test('missing capability refuses operator retained cached requests; generic defaults remain optional',{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true}),{p,signatures}=await preparedIdentity(w,'missing-cap');
  await w.api(p,'plan',signatures);await closeAccess(w);const operation=w.op(p),before=await effects(w);
  const protocol=createProtocolPurchases({ops:w.h.application.services.ops,coordinates:{},dacsProtocol:{}});
  await assert.rejects(protocol.planRequest(operation),closed);
  assert.throws(()=>protocol.identityRequest(operation,w.wallet.address),closed);
  assert.equal(operatorBuyerAccessConfig(null),null);
  assert.deepEqual(await effects(w),before);
  await assert.rejects(createDevnetDemoComposition({}),/buyerAccess/);
});

test('expired foreign refusal leaves operation and history unchanged',{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true}),{p}=await preparedIdentity(w,'expired-retained');
  w.h.application.db.prepare('UPDATE operations SET expires_at = ? WHERE id = ?').run(new Date(Date.now()-1000).toISOString(),p.operationId);
  await closeAccess(w);const operation=w.op(p),history=w.h.application.services.ops.history(p.operationId),before=await effects(w);
  assertRefused(await w.api(p,'identity',{address:w.wallet.address}));
  assert.deepEqual(w.op(p),operation);assert.deepEqual(w.h.application.services.ops.history(p.operationId),history);assert.deepEqual(await effects(w),before);
});

test('cached Agreement submission refuses before chain reads or signatures',{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true}),{p,signatures}=await preparedIdentity(w,'cached-submit');
  const planned=await w.api(p,'plan',signatures);await closeAccess(w);
  const before=await effects(w),operation=w.op(p),history=w.h.application.services.ops.history(p.operationId);
  assertRefused(await w.api(p,'sign',{agreementSignature:w.wallet.signHex(planned.signRequest.agreementMessage)}));
  await assert.rejects(w.h.application.services.protocol.submitAgreement(operation,{agreementSignature:w.wallet.signHex(planned.signRequest.agreementMessage)}),closed);
  assert.deepEqual(w.op(p),operation);assert.deepEqual(w.h.application.services.ops.history(p.operationId),history);assert.deepEqual(await effects(w),before);
});

for(const sellerApprovalMode of ['manual','policy'])test(`all retained buyer stages refuse without effects (${sellerApprovalMode})`,{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true,sellerApprovalMode}),{p,signatures}=await preparedIdentity(w,'stage-matrix');
  await w.api(p,'plan',signatures);
  const services=w.h.application.services,template=w.op(p),cases=[];
  for(const lane of ['legacy','DACS'])for(const [name,status,stage] of [
    ['planned','agreement_pending','agreement-signing'],['Agreement anchored','agreement_pending','agreement-anchored'],
    ['awaiting approval','awaiting_approval','seller-committed'],['payment handoff','payment_handoff','seller-committed'],
    ['settled/evidence','settled_verified','native-payment-evidence-held']]){
    const terms=structuredClone(template.terms);if(lane==='legacy')delete terms.protocol;
    const state=structuredClone(template.state);if(lane==='legacy')delete state.protocol;
    else Object.assign(state.protocol,{stage,unknownOutcome:{status:'unknown',noResend:true}});
    const created=services.ops.createIdempotent({accountId:template.accountId,kind:'purchase',idempotencyKey:`${lane}-${name}`,request:{lane,name},status,terms,termsHash:template.termsHash,expiresAt:template.expiresAt,state});
    cases.push({lane,name,p:{operationId:created.operation.id},id:created.operation.id,token:created.handoffToken});
  }
  await closeAccess(w);
  for(const c of cases){
    const svc=w.h.application.services,operation=w.op(c.p),history=svc.ops.history(c.id),before=await effects(w);
    const input={operationId:c.id,token:c.token};
    for(const [method,extra] of [
      ['issueApprovalChallenge',{address:w.wallet.address}],['approve',{challengeId:'unused',signature:'unused'}],
      ['prepareHandoff',{}],['nativePaymentLane',{key:'unused'}],['reportWalletResult',{walletError:'unknown'}],
      ['verifyDeal',{accountId:operation.accountId}],['cancel',{accountId:operation.accountId}],
      ...(c.lane==='DACS'?[['agreementIdentity',{address:w.wallet.address}],['agreementPlan',{}],['agreementSubmit',{}],['completionRequest',{}],['completionCountersign',{}],['protocolRecheck',{}]]:[])]){
      await assert.rejects(async()=>svc.purchases[method]({...input,...extra}),closed,`${c.lane} ${c.name} ${method}`);
      assert.deepEqual(w.op(c.p),operation,`${method} operation`);assert.deepEqual(svc.ops.history(c.id),history,`${method} history`);assert.deepEqual(await effects(w),before,`${method} effects`);
    }
  }
});

import { planAgreementFromInput, exchangeAgreement } from '../src/dacs/purchase-protocol.mjs';
import { createSellerAgentClient } from '../src/dacs/seller-http.mjs';
import { createSellerTransportClientAuth } from '../src/dacs/seller-transport-auth.mjs';

for(const sellerApprovalMode of ['manual','policy'])test(`seller proposal, HTTP, commit and retained jobs refuse before payment (${sellerApprovalMode})`,{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true,sellerApprovalMode}),{p,signatures}=await preparedIdentity(w,'seller-boundaries');
  const operation=w.op(p),buyerBundle=attachIdentityPresentation(operation.state.protocol.identity,signatures.signature);
  const resolved=await resolveDemDeliveryBuyerContext(w.h.composition.dacsProtocol.demDeliveryContext,{operation,listing:w.h.composition.listing,buyerBundle,generatedAt:Date.now()});
  const planned=planAgreementFromInput(resolved.input);let proposal;
  await exchangeAgreement({plan:planned.plan,draft:planned.draft,buyerClaim:w.wallet.claim,buyerBundle,agreementSignature:w.wallet.signHex(planned.agreementMessage),
    seller:{agreementState:identity=>w.h.composition.sellerAgent.agreementState(identity),propose:async body=>{proposal=body;return w.h.composition.sellerAgent.receiveProposal(body);}},
    anchorAdapter:{reconcileAgreementAnchor:async()=>({disposition:'absent'}),anchorAgreement:async()=>({disposition:'indeterminate',reason:'stop before anchor'}),verifyAnchorReceipt:async()=> 'unknown'}});
  assert.ok(proposal);await closeAccess(w);const before=await effects(w),agent=w.h.composition.sellerAgent,jobId=operation.terms.protocol.jobId,stage=agent.stageOf(jobId);
  await assert.rejects(agent.receiveProposal(proposal),closed);
  for(const method of ['commit','submitPayment','bundleRequest','countersign','confirmBuyerCopy','resume'])await assert.rejects(agent[method]({jobId}),closed,method);
  const authentication=createSellerTransportClientAuth({buyerSigner:{claim:w.wallet.claim,sign:bytes=>w.wallet.signBytes(bytes)},seller:operation.terms.seller.claim,
    resolveJob:()=>({listingPin:resolved.scope.listingPin,agreementHash:planned.plan.agreementHash})});
  const client=createSellerAgentClient({url:w.h.config.sellerOrigin,fetchImpl:w.h.fetchImpl,authentication});
  await assert.rejects(client.propose(proposal),closed);
  assert.equal(agent.stageOf(jobId),stage);assert.deepEqual(await effects(w),before);
  const source=w.h.prepared.composition.sourceCapability,publicJournal=w.h.prepared.composition.publicJournal;
  // Every seller CREATE of this job is still known (observed): reconciliation
  // refuses at once and reads nothing from the chain.
  const issued=(await source.journal.entries()).filter(([,value])=>value.signedTransaction?.content?.data?.[1]?.data?.jobId===jobId);
  assert.ok(issued.length>0);assert.ok(issued.every(([,value])=>value.stage==='observed'),JSON.stringify(issued.map(([,value])=>value.stage)));
  await assert.rejects(agent.reconcile({jobId}),closed);
  const known=await agent.reconcileTransport({request:{jobId},body:{},rawBody:Buffer.from('{}')});
  assert.equal(known.disposition,'indeterminate');assert.match(known.reason,/buyer_access_closed; no unknown issued write, nothing was read/);
  assert.deepEqual(await effects(w),before,'zero RPC reads for known CREATEs');
  for(const [key,value] of await source.journal.entries())if(value.signedTransaction?.content?.data?.[1]?.data?.jobId===jobId)await source.journal.put(key,{...value,stage:'broadcast-started'});
  const sourceBefore=await source.journal.entries(),publicBefore=await publicJournal.entries(),operationBefore=w.op(p),history=w.h.application.services.ops.history(p.operationId);
  const recovered=await agent.resume({jobId});assert.equal(recovered.status,'readback-only');assert.ok(recovered.records.every(row=>row.status==='present'));
  assert.equal((await agent.reconcile({jobId})).status,'readback-only');
  const reconciled=await agent.reconcileTransport({request:{jobId},body:{},rawBody:Buffer.from('{}')});
  assert.equal(reconciled.disposition,'indeterminate');assert.match(reconciled.reason,/buyer_access_closed/);
  assert.deepEqual(await source.journal.entries(),sourceBefore);assert.deepEqual(await publicJournal.entries(),publicBefore);
  assert.equal(agent.stageOf(jobId),stage);assert.deepEqual(w.op(p),operationBefore);assert.deepEqual(w.h.application.services.ops.history(p.operationId),history);
  const after=await effects(w);assert.ok(after.rpcRequests>before.rpcRequests);delete after.rpcRequests;const expected={...before};delete expected.rpcRequests;assert.deepEqual(after,expected);
});

for(const sellerApprovalMode of ['manual','policy'])test(`legacy open challenge cannot be consumed after closure (${sellerApprovalMode})`,{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true,sellerApprovalMode}),svc=w.h.application.services,accountId=svc.accounts.walletOwner(w.wallet.address);
  const args=w.args('legacy-signed-challenge');delete args.protocol;
  const prepared=await svc.purchases.prepare({accountId,...args}),operation=prepared.operation;
  assert.equal(operation.status,'awaiting_approval');
  const token=svc.ops.handoffTokenFor(operation.id),challenge=await svc.purchases.issueApprovalChallenge({operationId:operation.id,token,address:w.wallet.address});
  const signature=w.wallet.signHex(challenge.message);
  await closeAccess(w);const input={operationId:operation.id,token},before=await effects(w),history=w.h.application.services.ops.history(operation.id),retained=w.op({operationId:operation.id});
  await assert.rejects(w.h.application.services.purchases.issueApprovalChallenge({...input,address:w.wallet.address}),closed);
  await assert.rejects(w.h.application.services.purchases.approve({...input,challengeId:challenge.challengeId,signature}),closed);
  assert.deepEqual(w.op({operationId:operation.id}),retained);assert.deepEqual(w.h.application.services.ops.history(operation.id),history);assert.deepEqual(await effects(w),before);
  assert.equal(w.h.application.db.prepare('SELECT consumed_at FROM challenges WHERE id = ?').get(challenge.challengeId)?.consumed_at,null);
});

import { createDevnetDemoArtifactAnchor } from '../src/devnet-demo/artifact-anchor.mjs';
import { signComponentArtifact, finalityCommitmentAddress, FINALITY_COMMITMENT_SEPARATOR } from '@kynesyslabs/dacs';
test('direct wallet cannot skip buyer approval in manual mode',{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true,sellerApprovalMode:'manual'}),{p}=await preparedIdentity(w,'direct-wallet');
  await closeAccess(w);const before=await effects(w),operation=w.op(p),c=w.h.prepared.composition,jobId=operation.terms.protocol.jobId;
  // Deliberately skip the provider, agent and anchor gate (an open
  // capability) to test the wallet's final independent buyer authorization
  // around its manual approval path.
  const anchor=createDevnetDemoArtifactAnchor({sourceCapability:c.sourceCapability,journal:c.publicJournal,walletFactory:c.sellerWalletFactory,network:c.sourceCapability.pins.network,buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true})});
  const artifact=await signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),listingRef:{listingId:operation.terms.listing.listingId,version:1,contentHash:operation.terms.listing.contentHash},parties:[w.wallet.claim,c.sellerSigner.claim],pattern:'fixed-price',createdAt:Date.now()},
    FINALITY_COMMITMENT_SEPARATOR,{algorithm:'ed25519',signer:c.sellerSigner.claim,sign:c.sellerSigner.sign});
  // The operator's own composed anchor refuses this foreign job before any read, approval or send.
  await assert.rejects(w.h.composition.anchor.publish({logicalAddress:finalityCommitmentAddress(jobId),artifact,artifactKind:'FinalityCommitmentRecord'}),closed);
  assert.deepEqual(await effects(w),before);
  let answer;try{answer=await anchor.publish({logicalAddress:finalityCommitmentAddress(jobId),artifact,artifactKind:'FinalityCommitmentRecord'});}catch(error){answer={status:'refused',error:error.code};}
  assert.notEqual(answer.status,'present');assert.equal(w.manual.length,before.manualApprovals);
  assert.equal(w.h.node2.chain.wire.record.accepted.length,before.acceptedCreates);assert.equal(w.h.node2.chain.wire.record.broadcastAttempts.length,before.createBroadcasts);
});

test('browser broker refuses retained foreign approval challenge after closure',{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true}),{p,signatures}=await preparedIdentity(w,'broker-closed');
  await w.api(p,'plan',signatures);await closeAccess(w);const before=await effects(w),operation=w.op(p),history=w.h.application.services.ops.history(p.operationId);
  const raw=await fetch(`${w.harness.origin}/portal/api/purchase/${p.operationId}/browser-agreement/challenge`,{method:'POST',headers:{'content-type':'application/json',origin:w.harness.origin},body:JSON.stringify({token:tokenFrom(p.approvalUrl),address:w.wallet.address})});
  const response={status:raw.status,...await raw.json()};
  assertRefused(response);assert.deepEqual(w.op(p),operation);assert.deepEqual(w.h.application.services.ops.history(p.operationId),history);assert.deepEqual(await effects(w),before);
});

test('native wallet relay refuses foreign new work after closure',{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true}),{p}=await preparedIdentity(w,'native-relay-closed');
  await closeAccess(w);const before=await effects(w),operation=w.op(p),history=w.h.application.services.ops.history(p.operationId);
  for(const phase of ['bind','signature','broadcast']){
    const response=await portal(w.harness,'/portal/api/devnet-native-wallet-binding',{phase,address:w.wallet.address});assertRefused(response);
  }
  for(const body of [{method:'nodeCall',params:[{message:'getAddressNonce',data:{address:w.wallet.address}}]},
    {method:'execute',params:[{extra:'confirmTx',data:{content:{from:w.wallet.address}}}]},
    {method:'execute',params:[{extra:'broadcastTx',data:{response:{data:{transaction:{content:{from:w.wallet.address}}}}}}]}]){
    const response=await portal(w.harness,'/portal/api/devnet-native-wallet-rpc',body);assertRefused(response);
  }
  assert.deepEqual(w.op(p),operation);assert.deepEqual(w.h.application.services.ops.history(p.operationId),history);assert.deepEqual(await effects(w),before);
});

test('bootstrap relay before listen applies the buyer-only relay check',{timeout:180000},async t=>{
  const rpcRequests=[],h=await startOperatorPurchaseNode2({listen:false,authorizeSellerApproval:()=>true,rpcFault:input=>{rpcRequests.push(input);return null;}});t.after(()=>h.close());
  assert.equal(h.running,null);
  const foreign=createEphemeralWallet(),seller=`0x${h.prepared.operatorEvidence.seller.slice('did:demos:agent:'.length)}`,reads=rpcRequests.length;
  const relay=async(path,body)=>{const response=await fetch(`${h.config.publicOrigin}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{http:response.status,body:await response.json()};};
  for(const [path,body] of [['/portal/api/devnet-native-wallet-binding',{phase:'bind',address:foreign.address}],
    ['/portal/api/devnet-native-wallet-rpc',{method:'nodeCall',params:[{message:'getAddressNonce',data:{address:foreign.address}}]}],
    ['/portal/api/devnet-native-wallet-rpc',{method:'execute',params:[{extra:'confirmTx',data:{content:{from:foreign.address}}}]}],
    ['/portal/api/devnet-native-wallet-rpc',{method:'execute',params:[{extra:'broadcastTx',data:{response:{data:{transaction:{content:{from:foreign.address}}}}}}]}]]){
    const refused=await relay(path,body);assert.equal(refused.body.error,'buyer_access_closed',JSON.stringify(refused));assert.equal(refused.http,422);
  }
  // The custody seller published its Listing in-process before listen; its
  // address earns nothing on the bootstrap relay either.
  for(const [path,body] of [['/portal/api/devnet-native-wallet-binding',{phase:'bind',address:seller}],
    ['/portal/api/devnet-native-wallet-rpc',{method:'nodeCall',params:[{message:'getAddressNonce',data:{address:seller}}]}]]){
    const refused=await relay(path,body);assert.equal(refused.body.error,'seller_wallet_in_process',JSON.stringify(refused));assert.equal(refused.http,422);
  }
  assert.equal(rpcRequests.length,reads,'nothing was forwarded for the foreign wallet or the seller address');
  const buyer=`0x${h.prepared.operatorEvidence.buyer.slice('did:demos:agent:'.length)}`;
  const own=await relay('/portal/api/devnet-native-wallet-rpc',{method:'nodeCall',params:[{message:'getAddressNonce',data:{address:buyer}}]});
  assert.equal(own.http,200,JSON.stringify(own));assert.equal(own.body.result,200,JSON.stringify(own));assert.ok(rpcRequests.length>reads,'the custody buyer is still relayed');
  const unsigned=await relay('/portal/api/devnet-native-wallet-binding',{phase:'bind',address:buyer});
  assert.equal(unsigned.body.error,'wallet_auth_required',JSON.stringify(unsigned));
});
