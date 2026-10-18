// The seller-lease regression from a review,
// pinned as a regression. Closed access (default). Anonymous callers, with no
// cookie, origin or key, name the custody seller's address (and the custody
// buyer's) on the operator's public native relay. Before this fix the relay
// admitted the seller by address: the anonymous signature phase took the
// operator's only connection fence, and the custody buyer's next plan failed
// with listing_not_transactable until a restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { auth } from '@modelcontextprotocol/client';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { openTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';
import { CookieJar, TestOAuthProvider } from './helpers/oauth.mjs';
import { tool, portal, tokenFrom } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createHash } from 'node:crypto';

async function linkAccount({harness,wallet}){
  const scope='dacs.account.read dacs.purchases.write',callbackUrl=`${harness.origin}/operator/oauth/callback`;
  class Provider extends TestOAuthProvider{get redirectUrl(){return callbackUrl;}get clientMetadata(){return{...super.clientMetadata,redirect_uris:[callbackUrl]};}}
  const provider=new Provider({scope}),jar=new CookieJar();
  const follow=async(start)=>{
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
  const page=await follow(provider.authorizationUrl),uid=/\/portal\/authorize\/([^/?#]+)/.exec(page.pathname)?.[1];
  const api=async(action,body)=>{
    const url=`${harness.origin}/portal/authorize/${uid}/api/${action}`,response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',cookie:jar.header(url)},body:JSON.stringify(body)});
    jar.store(response);const out=await response.json();assert.equal(response.status,200,JSON.stringify(out));return out;
  };
  const challenge=await api('challenge',{address:wallet.address}),done=await api('complete',{challengeId:challenge.challengeId,signature:wallet.signHex(challenge.message)});
  const callback=await follow(done.redirectTo);
  assert.equal(await auth(provider,{serverUrl:harness.mcpUrl,authorizationCode:callback.searchParams.get('code'),iss:callback.searchParams.get('iss'),scope}),'AUTHORIZED');
  return{provider};
}

test('anonymous seller- and buyer-address relay requests are refused with no source call or lease; custody buyer and seller still work',{timeout:300000},async t=>{
  const sourceCalls=[];
  const h=await startOperatorPurchaseNode2({authorizeSellerApproval:()=>true,rpcFault:(input)=>{sourceCalls.push(input);return null;}});t.after(()=>h.close());
  assert.equal(h.prepared.operatorEvidence.openBuyerAccess,false);
  const harness={origin:h.config.publicOrigin,mcpUrl:`${h.config.publicOrigin}/mcp`};
  const custody=await openTestWalletCustody({directory:h.config.custodyDirectory,role:'buyer',publicOrigin:h.config.publicOrigin});t.after(()=>custody.close());
  const signHex=(message)=>custody.signer.signBytes(Buffer.from(message)).toString('hex');
  const seller=`0x${h.prepared.operatorEvidence.seller.slice('did:demos:agent:'.length)}`,buyer=custody.signer.address;
  const relay=async(path,body,headers={})=>{const r=await fetch(`${harness.origin}${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return{http:r.status,...(await r.json())};};
  const binding=(body,headers)=>relay('/portal/api/devnet-native-wallet-binding',body,headers),rpc=(body)=>relay('/portal/api/devnet-native-wallet-rpc',body);
  const before=sourceCalls.length;
  // The seller's address earns nothing on the public relay, in any phase or call.
  for(const phase of ['bind','signature','readback','release']){
    const refused=await binding({phase,address:seller,binding:{},hash:'a'.repeat(64),leaseId:'x'});
    assert.equal(refused.error,'seller_wallet_in_process',`${phase}: ${JSON.stringify(refused)}`);
  }
  for(const body of [{method:'nodeCall',params:[{message:'getAddressNonce',data:{address:seller}}]},
    {method:'execute',params:[{extra:'confirmTx',data:{content:{from:seller}}}]},
    {method:'execute',params:[{extra:'broadcastTx',data:{response:{data:{transaction:{content:{from:seller}}}}}}]}]){
    const refused=await rpc(body);assert.equal(refused.http,409,JSON.stringify(refused));assert.equal(refused.error,'seller_wallet_in_process');
  }
  // The custody buyer's address alone is no key proof either: bind and
  // signature need its own RPC auth headers, and forged headers are refused.
  const forger=createEphemeralWallet(),timestamp=String(Date.now()),identity=`ed25519:${buyer}`;
  const forged={identity,timestamp,signature:forger.signHex(createHash('sha256').update(`${identity}:${timestamp}`).digest('hex'))};
  for(const phase of ['bind','signature'])for(const headers of [{},forged]){
    const refused=await binding({phase,address:buyer,binding:{}},headers);
    assert.equal(refused.error,'wallet_auth_required',`${phase}: ${JSON.stringify(refused)}`);
  }
  assert.equal(sourceCalls.length,before,'no source-chain call was made for any refused request');
  // The fence is free: the custody buyer's plan runs, and the seller's own
  // Vet CREATEs go through its in-process relay.
  const sellerCreates=()=>h.node2.chain.wire.record.accepted.filter(tx=>tx.content.from===seller).length;
  assert.equal(sellerCreates(),1,'the seller published its Listing in-process at startup');
  const {provider}=await linkAccount({harness,wallet:{address:buyer,signHex}});
  const p=await tool(harness,{provider},'prepare_purchase',{listingId:h.config.listing.listingId,version:1,seller:h.prepared.operatorEvidence.seller,idempotencyKey:'relay-regression',protocol:'dacs-sr2-wallet-agreement'});
  assert.equal(p.status,'agreement_pending',JSON.stringify(p));
  const api=(action,body={})=>portal(harness,`/portal/api/purchase/${p.operationId}/agreement/${action}`,{token:tokenFrom(p.approvalUrl),...body});
  const identityRequest=await api('identity',{address:buyer});
  assert.equal(identityRequest.error,undefined,JSON.stringify(identityRequest));
  const plan=await api('plan',{signature:signHex(identityRequest.signRequest.message),...(identityRequest.signRequest.delegation?{delegationSignature:signHex(identityRequest.signRequest.delegation.message)}:{})});
  assert.equal(plan.error,undefined,JSON.stringify(plan));
  assert.equal(sellerCreates(),3,'the plan added the seller Vet CREATEs, as in the probe control run');
});
