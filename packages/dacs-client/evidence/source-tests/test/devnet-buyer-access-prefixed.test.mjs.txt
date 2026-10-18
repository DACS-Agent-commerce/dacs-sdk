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
    rpcFault:input=>{rpcRequests.push(input);return null;},
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

test('buyer access admits only custody unless the switch is exactly true and rejects unconstructed policies',()=>{
  const custody=createEphemeralWallet(),foreign=createEphemeralWallet();
  for(const openBuyerAccess of [undefined,false,null,'true',1]){
    const access=createOperatorBuyerAccess({openBuyerAccess,custodyBuyer:custody.claim});
    assert.equal(operatorBuyerAccessConfig(access),access);assert.equal(access.allowsWallet(custody.address),true);access.assertWallet(custody.address);
    for(const wallet of [foreign.address,'bad-address',null]){assert.equal(access.allowsWallet(wallet),false);assert.throws(()=>access.assertWallet(wallet),closed);}
    assert.throws(()=>createOperatorBuyerAccess({openBuyerAccess}),/configured custody buyer/);
  }
  const open=createOperatorBuyerAccess({openBuyerAccess:true});assert.equal(open.allowsWallet(foreign.address),true);open.assertWallet(foreign.address);
  assert.equal(operatorBuyerAccessConfig(null),null);assert.throws(()=>operatorBuyerAccessConfig({assertWallet:()=>{}}),/constructed operator capability/);
});

for(const sellerApprovalMode of ['policy','manual'])for(const openBuyerAccess of [false,undefined])test(`closed admission (${sellerApprovalMode}, ${openBuyerAccess===false?'false':'default'}): a second account prepares nothing and causes no seller effect`,{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess,sellerApprovalMode}),before=await effects(w);
  assertRefused(await w.prepare('foreign-closed'));
  const accountId=w.h.application.services.accounts.walletOwner(w.wallet.address);
  // Legacy prepare cannot skip the operator restriction by omitting its protocol.
  const args=w.args('foreign-legacy');delete args.protocol;
  await assert.rejects(w.h.application.services.purchases.prepare({accountId,...args}),closed);
  assert.equal(w.h.application.db.prepare("SELECT count(*) AS n FROM operations WHERE kind = 'purchase'").get().n,0);
  assert.deepEqual(await effects(w),before,'zero approvals, wallet requests, chain reads or accepted/broadcast CREATEs after startup');
});

for(const sellerApprovalMode of ['policy','manual'])for(const cached of [false,true])test(`closed resume (${sellerApprovalMode}, ${cached?'cached plan':'identity only'}): replay, identity and plan refuse an earlier foreign purchase before any effect`,{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true,sellerApprovalMode}),{p,signatures}=await preparedIdentity(w,'foreign-retained');
  if(cached){const planned=await w.api(p,'plan',signatures);assert.equal(planned.error,undefined,JSON.stringify(planned));}
  await closeAccess(w);const before=await effects(w),operation=w.op(p),history=w.h.application.services.ops.history(p.operationId);
  assertRefused(await w.prepare('foreign-retained'));
  for(const [action,body] of [['identity',{address:w.wallet.address}],['plan',signatures]]){
    const response=await w.api(p,action,body);assertRefused(response);assert.equal(response.status,409);
  }
  assert.deepEqual(w.op(p),operation);assert.deepEqual(w.h.application.services.ops.history(p.operationId),history);
  assert.deepEqual(await effects(w),before,'zero manual/policy approvals, wallet requests, chain reads or CREATEs on resume');
});

test('protocol identity and plan boundaries independently refuse retained foreign signing requests in closed mode',{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true}),{p,signatures}=await preparedIdentity(w,'foreign-protocol-boundary');
  const planned=await w.api(p,'plan',signatures);assert.equal(planned.error,undefined,JSON.stringify(planned));
  await closeAccess(w);const before=await effects(w),operation=w.op(p),protocol=w.h.application.services.protocol;
  assert.throws(()=>protocol.identityRequest(operation,w.wallet.address),closed);
  await assert.rejects(protocol.planRequest(operation,signatures.signature,signatures.delegationSignature),closed);
  assert.deepEqual(await effects(w),before);
});

test('closed seller-policy resolver refuses a retained foreign buyer even when the context provider is called directly',{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true}),{p,signatures}=await preparedIdentity(w,'foreign-resolver');
  await closeAccess(w);const before=await effects(w),operation=w.op(p);
  const buyerBundle=attachIdentityPresentation(operation.state.protocol.identity,signatures.signature);
  const resolved=await resolveDemDeliveryBuyerContext(w.h.composition.dacsProtocol.demDeliveryContext,{operation,listing:w.h.composition.listing,buyerBundle,generatedAt:Date.now()});
  assert.notEqual(resolved.disposition,'present');
  assert.deepEqual(await effects(w),before,'direct provider is refused before any reads or wallet request');
  assert.equal(w.h.composition.contextProvider.invocations.length,0);
});

for(const sellerApprovalMode of ['policy','manual'])test(`open access (${sellerApprovalMode}): a second account still plans its Agreement with two seller Vet CREATEs`,{timeout:180000},async t=>{
  const w=await setup(t,{openBuyerAccess:true,sellerApprovalMode}),{p,signatures}=await preparedIdentity(w,'foreign-open'),before=await effects(w);
  const planned=await w.api(p,'plan',signatures);assert.equal(planned.error,undefined,JSON.stringify(planned));assert.equal(planned.signRequest.kind,'agreement');
  const rows=(await approvalRows(w.h)).slice(before.sellerDecisions);assert.equal(rows.length,2);assert.ok(rows.every(row=>row.decision==='approved'));
  assert.equal(w.walletRequests.length,before.walletRequests+2);assert.equal(w.manual.length,before.manualApprovals+(sellerApprovalMode==='manual'?2:0));
  const creates=w.h.node2.chain.wire.record.accepted.slice(before.acceptedCreates);assert.equal(creates.length,2);assert.ok(creates.every(tx=>tx.content.data[1].metadata.artifactKind==='CompositeVerificationRecord'));
  assert.deepEqual(w.h.composition.contextProvider.invocations.map(entry=>entry.evaluatedParty).sort(),[w.wallet.claim,w.h.prepared.operatorEvidence.seller].sort());
});
