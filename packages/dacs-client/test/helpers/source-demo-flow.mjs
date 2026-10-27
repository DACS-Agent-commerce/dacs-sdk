import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperatorSellerSessions } from '../../src/devnet-demo/operator-sessions.mjs';
import { createSellerTransportClientAuth } from '../../src/dacs/seller-transport-auth.mjs';
import { startDevnetAgreementTransportHarness } from './devnet-agreement-transport-harness.mjs';
import { startSourceDemoSeller } from './source-demo-seller.mjs';
import { createSourceDemoSellerTransport } from '../../src/dacs/source-demo-seller-transport.mjs';
import { createEphemeralPackagedSeller } from './native-settlement-consumer-seller.mjs';
import { createDevnetAgreementWalletTransport } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../../public/portal/offline-agreement-broker.mjs';
import { linkPackagedWallet } from './offline-agreement-fixture.mjs';
import { tool,tokenFrom } from './flows.mjs';
import { post } from './public-sr2-projection-flow.mjs';
import { createSellerAgentClient } from '../../src/dacs/seller-http.mjs';
import { createDemDeliveryContext } from '../../src/dacs/dem-delivery-context-consumer.mjs';
import { createNativeDemDeliveryCapability } from '../../src/dacs/native-dem-delivery-consumer.mjs';

let counter=0;
export async function sourceDemoFlow(t,{delegated=false,buyerChainReadback='off'}={}){
  // Delegation clock shared by the app's session store and client auth and the
  // seller's server auth, so a test can move past the delegation expiry.
  let delegationOffsetMs=0;const delegationNow=()=>Date.now()+delegationOffsetMs;
  const authenticationRegistry=new Map(),jobContexts=new Map();
  const deliveryProviders=new Map(),jobDeliveryProviders=new Map();
  const demDeliveryContext=createDemDeliveryContext({authority:'TEST-owned-loopback-party-vet-and-delivery',
    resolveBuyer:async(input)=>{const provider=deliveryProviders.get(input.scope.seller);if(!provider)return{disposition:'indeterminate',reason:'TEST seller delivery provider is absent'};
      const answer=await provider.context.resolveBuyer(input);if(answer.disposition==='present')jobDeliveryProviders.set(input.scope.jobId,provider);return answer;},
    resolveSeller:async(input)=>{const provider=jobDeliveryProviders.get(input.jobId);return provider?provider.context.resolveSeller(input):{disposition:'indeterminate',reason:'TEST job delivery provider is absent'};}});
  const routed=(operation)=>async(input)=>{const provider=jobDeliveryProviders.get(input.jobId);if(!provider)throw new Error('TEST job native delivery provider is absent');return provider.native[operation](input);};
  const nativeDemDelivery=createNativeDemDeliveryCapability({authority:'TEST-owned-loopback-source-native-delivery',submit:routed('submit'),reconcile:routed('reconcile'),read:routed('read'),verifyReceipt:routed('verifyReceipt')});
  const sessionDirectory=delegated?realpathSync(mkdtempSync(join(tmpdir(),'source-demo-sessions-'))):null;
  if(sessionDirectory)t.after(()=>rmSync(sessionDirectory,{recursive:true}));
  let sessions=delegated?createOperatorSellerSessions({directory:sessionDirectory,now:delegationNow}):null;
  const sellerTransport=createSourceDemoSellerTransport({authority:'TEST-ephemeral-buyer-and-seller-operators',...(delegated?{sessionDelegation:{request:(operation)=>sessions.request(operation),accept:(operation,signature)=>sessions.accept(operation,signature)}}:{}),authenticationFor:(operation)=>{
    if(!delegated)return authenticationRegistry.get(operation.terms.seller.claim);
    const p=operation.state.protocol,agreement=p.agreement?.artifact??p.planned.draft;
    return createSellerTransportClientAuth({sessionSigner:sessions.signerFor(operation),delegation:p.sessionDelegation,seller:operation.terms.seller.claim,resolveJob:(id)=>{assert.equal(id,operation.terms.protocol.jobId);return{listingPin:Object.fromEntries(['listingId','version','contentHash'].map(key=>[key,operation.terms.listing[key]])),agreementHash:p.agreement?.hash??p.planned.plan.agreementHash,deadline:agreement.terms.deadline};},now:delegationNow});
  }});
  const h=await startDevnetAgreementTransportHarness({settlementEnabled:true,deliveryEnabled:true,sellerTransport,demDeliveryContext,nativeDemDelivery,buyerChainReadback});t.after(()=>h.close());
  globalThis.location=new URL(h.origin);
  let client,allowPayment=true;const buyerWalletAttempts=[];
  const buyerActor=await createEphemeralPackagedSeller({network:h.expected.network,transactionTransport:createDevnetAgreementWalletTransport(await h.profile()),approve:(r)=>r.content?.action==='native DEM transfer'?allowPayment:true});
  t.after(()=>buyerActor.close());
  const wallet=buyerActor.walletFactory({anchorJournal:{get:(k)=>client.anchorJournal.get(k),put:(k,v)=>client.anchorJournal.put(k,v),withWalletLock:(k,work)=>client.anchorJournal.withWalletLock(k,work)}});
  const buyer=await linkPackagedWallet(h,wallet),address=wallet.getPublicAccount().address;
  const sign=async(message)=>{const r=await wallet.request({method:'sign',params:[message]});assert.equal(r.success,true);return r.data.signature;};
  const seller=await startSourceDemoSeller(h,{listingId:`source-demo-${++counter}`,buyerSigner:{claim:buyerActor.signer.claim,sign:(bytes)=>buyerActor.signer.signBytes(bytes)},authenticationRegistry,jobContexts,demDeliveryContext,nativeDemDelivery,requireDelegation:delegated,now:delegationNow});
  deliveryProviders.set(seller.wallet.claim,{context:seller.deliveryContextProvider,native:seller.nativeDeliveryProvider});
  const prepared=await tool(h,buyer,'prepare_purchase',{listingId:seller.listing.listingId,version:1,seller:seller.wallet.claim,idempotencyKey:`source-demo-${counter}-${Date.now()}`,protocol:'dacs-sr2-wallet-agreement'});
  assert.equal(prepared.status,'agreement_pending',JSON.stringify(prepared));const id=prepared.operationId,token=tokenFrom(prepared.approvalUrl);
  const api=(part,body={})=>post(`${h.origin}/portal/api/purchase/${id}/${part}`,{token,...body},h.origin);
  client=createOfflineAgreementBrokerClient({id,token,api:async(path,body)=>{const r=await post(`${h.origin}${path}`,body,h.origin);if(r.httpStatus!==200)throw Object.assign(Error(r.message),{code:r.error});return r;}});
  const account=h.app.services.accounts.walletOwner(address),op=()=>h.app.services.ops.get(account,id);
  return{h,wallet,buyer,buyerActor,buyerWalletAttempts,address,seller,prepared,id,token,api,op,verify:(txHash)=>tool(h,buyer,'verify_deal',{operationId:id,...(txHash?{txHash}:{})}),allowPayment:(v)=>{allowPayment=v;},restartSessions:()=>{sessions=createOperatorSellerSessions({directory:sessionDirectory,now:delegationNow});},
    sessionDirectory,sweepSessions:()=>sessions.sweep(({operationId,accountId})=>h.app.services.ops.get(accountId,operationId)),
    advanceDelegationClock:(ms)=>{delegationOffsetMs+=ms;},sellerTransport,
    async agreement(){const identity=await api('agreement/identity',{address});const signature=await sign(identity.signRequest.message),delegationSignature=identity.signRequest.delegation?await sign(identity.signRequest.delegation.message):undefined;const planned=await api('agreement/plan',{signature,...(delegationSignature?{delegationSignature}:{})});assert.equal(planned.httpStatus,200,JSON.stringify(planned));
      jobContexts.set(op().terms.protocol.jobId,{listingPin:planned.signRequest.summary.listing,agreementHash:planned.signRequest.agreementHash});
      const authentication=sellerTransport.authenticationFor(op());
      const peer=createSellerAgentClient({url:seller.origin,authentication});
      try { assert.deepEqual(await peer.agreementState({jobId:op().terms.protocol.jobId,buyer:buyerActor.signer.claim,seller:seller.wallet.claim,agreementHash:planned.signRequest.agreementHash}),{proposal:null,contribution:null}); }
      catch(error){throw new Error(`authenticated seller preflight failed: ${error.message}; ${JSON.stringify({requests:seller.requests,responses:seller.responses,jobContext:jobContexts.get(op().terms.protocol.jobId),buyer:buyerActor.signer.claim,operationBuyer:op().terms.buyer.wallet,seller:seller.wallet.claim})}`,{cause:error});}
      const agreementSignature=await sign(planned.signRequest.agreementMessage);await client.authenticate({address,sign});assert.equal((await api('agreement/sign',{agreementSignature})).httpStatus,200);
      try{assert.equal((await client.approveOne({request:async(request)=>{const answer=await wallet.request(request);buyerWalletAttempts.push({request,answer});return answer;}})).state,'completed');}catch(error){throw new Error(`${error.message}; diagnostic=${JSON.stringify({writeProfile:wallet.getWriteProfile(),walletAttempts:buyerWalletAttempts,op:op().state.protocol,sellerRequests:seller.requests,sellerResponses:seller.responses,requests:h.requests.slice(-20),logs:h.logs.slice(-20),creates:h.chain.wire.record.broadcastAttempts,rejections:h.chain.wire.record.rejections})}`,{cause:error});}
      return tool(h,buyer,'verify_deal',{operationId:id});},
    async approve(){const challenge=await api('challenge',{address});return{challenge,handoff:await api('approve',{challengeId:challenge.challengeId,signature:await sign(challenge.message)})};},
    send:(payload)=>{client.useNativePaymentLane();return wallet.request({method:'sendTransaction',params:[payload]});}};
}
