import test from 'node:test';
import assert from 'node:assert/strict';
import { createProtocolPurchases } from '../src/dacs/protocol-purchases.mjs';
import { createOperatorBuyerAccess, buyerAuthorizedSellerApproval } from '../src/devnet-demo/buyer-access.mjs';
import { createDevnetDemoComposition } from '../src/devnet-demo/composition.mjs';
const wallet=`0x${'1'.repeat(64)}`,custodyBuyer=`did:demos:agent:${'2'.repeat(64)}`;
const closed=error=>error.code==='buyer_access_closed';
const operation={id:'retained',accountId:'owner',status:'agreement_pending',terms:{buyer:{wallet},protocol:{sellerCommitment:'dacs-chatgpt-plugin/devnet-native-seller-commitment/v1',transportBinding:{source:'devnet-agreement-transport/v1'}}},state:{protocol:{stage:'agreement-signing',planned:{}}}};
const guarded=createProtocolPurchases({ops:{},coordinates:{},dacsProtocol:{buyerAccess:createOperatorBuyerAccess({custodyBuyer})}});
for(const method of ['identityRequest','planRequest','signRequest','submitAgreement','recheckCommitment','advance','checkDelivery','countersignRequest','countersign','withNativePaymentLane','readNativePaymentLane','recheck'])test(`direct protocol ${method} checks access first`,async()=>{
  await assert.rejects(async()=>guarded[method](operation,{}),closed);
});
test('direct protocol planRequest checks access before its unplanned path',async()=>{
  await assert.rejects(async()=>guarded.planRequest({...operation,state:{protocol:{stage:'identity'}}},{}),closed);
});
test('operator cached operation requires capability, while generic fixtures remain optional',async()=>{
  const generic=createProtocolPurchases({ops:{},coordinates:{},dacsProtocol:{}});
  await assert.rejects(generic.planRequest(operation),closed);
  const fixture={...operation,terms:{...operation.terms,protocol:{}}};
  assert.doesNotThrow(()=>generic.assertBuyerAccess(wallet,fixture));
});
test('operator composition requires capability before construction',async()=>{
  await assert.rejects(createDevnetDemoComposition({}),/requires buyerAccess/);
});
for(const mode of ['manual','policy'])test(`buyer gate surrounds ${mode} preparation and confirmation`,async()=>{
  let paid=false,allowed=false,calls=0,confirms=0;
  const access=createOperatorBuyerAccess({custodyBuyer,paymentObserved:()=>paid,buyerForJob:()=>allowed?`0x${'2'.repeat(64)}`:wallet});
  const base=Object.assign(async()=>{calls++;return true;},{confirm:()=>{confirms++;return true;},settle:()=>{}});
  const approve=buyerAuthorizedSellerApproval({buyerAccess:access,approval:base}),request={content:{artifactKind:'Deliverable',jobId:'job'}};
  await assert.rejects(approve(request),closed);assert.equal(calls,0);
  allowed=true;await approve(request);allowed=false;
  assert.throws(()=>approve.confirm({}),closed);assert.equal(confirms,0);
  paid=true;await approve(request);assert.equal(calls,2);
  assert.match(access.sellerNotice(wallet,'job'),/buyer is outside closed access/i);
});

test('seller capability requires a retained buyer and keeps paid access distinct from policy access',()=>{
  let paid=false;
  const access=createOperatorBuyerAccess({custodyBuyer,buyerForJob:job=>job==='known'?wallet:null,paymentObserved:()=>paid});
  assert.throws(()=>access.assertSellerJob('unknown'),closed);assert.throws(()=>access.assertSellerJob('known'),closed);
  assert.throws(()=>access.assertSellerWallet(wallet,'known'),closed);assert.throws(()=>access.sellerNotice(wallet,'known'),closed);paid=true;
  access.assertSellerJob('known');assert.equal(access.allowsWallet(wallet),false);
  assert.throws(()=>buyerAuthorizedSellerApproval({buyerAccess:null,approval:()=>true}),/requires buyerAccess/);
});

import { createDevnetDemoAgreementContextProvider } from '../src/devnet-demo/agreement-context.mjs';
import { createSellerAgent } from '../src/dacs/seller-agent.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
const seller=createEphemeralWallet(),anchor={source:'dacs-devnet-demo-native-artifacts/v1',writer:seller.claim,publish:async()=>{},readRetained:async()=>({status:'absent'}),hasIntent:async()=>{throw new Error('unexpected read');},verifyReceipt:async()=> 'valid'};
for(const method of ['resolveBuyer','resolveSeller'])test(`provider ${method} guards work and refuses missing operator capability`,async()=>{
  const options={anchor,wallet:{claim:seller.claim,signBytes:seller.signBytes},listing:fixtureListing(seller),store:{read:async()=>{throw new Error('unexpected read');},update:async()=>{throw new Error('unexpected write');},entries:async()=>{throw new Error('unexpected read');}}};
  const input={scope:{jobId:'01ARZ3NDEKTSV4RRFFQ69G5FAV'},buyerIdentityBundle:{presentedBy:`did:demos:agent:${wallet.slice(2)}`}};
  const guardedProvider=createDevnetDemoAgreementContextProvider({...options,buyerAccess:createOperatorBuyerAccess({custodyBuyer})});
  await assert.rejects(guardedProvider[method](input),closed);
  const missing=createDevnetDemoAgreementContextProvider(options);await assert.rejects(missing[method](input),closed);
});
test('native operator seller refuses missing capability; generic seller defaults remain optional',async()=>{
  const options={signer:{claim:seller.claim,sign:seller.signBytes},listing:fixtureListing(seller),anchors:{},observeDemosTransfer:async()=>{throw new Error('unexpected read');}};
  const input={transportIdentity:{jobId:'01ARZ3NDEKTSV4RRFFQ69G5FAV'},buyerIdentityBundle:{presentedBy:`did:demos:agent:${wallet.slice(2)}`}};
  const operator=await createSellerAgent({...options,nativeArtifactAnchor:anchor,deliverableProducer:()=>{throw new Error('unexpected work');}});
  await assert.rejects(operator.receiveProposal(input),closed);
  const generic=await createSellerAgent(options);await assert.rejects(generic.receiveProposal(input),error=>error.code==='buyer_bundle_invalid');
});

import { createDevnetAgreementTransport } from '../src/wallet/devnet-native-transport.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
function retainedSource(stage){
  const jobId='01ARZ3NDEKTSV4RRFFQ69G5FAV',hash='a'.repeat(64),rows=new Map([['issued',{stage,hash,signedTransaction:{content:{from:wallet,type:'storageProgram',data:['storageProgram',{data:{jobId},metadata:{logicalAddress:`dacs4:finality:${jobId}`,artifactKind:'FinalityCommitmentRecord'}}]}}}]]);
  let reads=0,writes=0;
  const pins={network:'demos-devnet',chainIdentity:'b'.repeat(64),endpoint:'https://127.0.0.1:1/',pinVersion:'TEST-guard',transportAuthority:'TEST-guard'};
  const context={...pins,connectionId:'TEST-guard-connection'};
  const source=createDevnetAgreementTransport({expected:pins,transportOwner:{getContext:()=>context,acquireConnectionFence:async()=>({context,release(){}})},
    journal:{entries:async()=>[...rows.entries()],get:async key=>rows.get(key),put:async()=>{writes++;throw new Error('unexpected durable write');},withWalletLock:async(key,work)=>work()},
    fetchImpl:async()=>{reads++;throw new Error('unexpected source read');}});
  const op={...operation,kind:'purchase',status:'awaiting_approval',terms:{...operation.terms,protocol:{...operation.terms.protocol,jobId}}};
  const ops={get:()=>op,getByHandoff:()=>op},coordinates={get:()=>({reportedTxHash:hash})};
  const protocolFor=buyerAccess=>createProtocolPurchases({ops,coordinates,dacsProtocol:{buyerAccess,walletAgreement:{sourceCapability:source,bridgeFor:()=>{}},sellerEndpoint:()=>null}});
  const serviceFor=protocol=>createPurchaseService({db:{prepare:()=>({})},config:{},ops,coordinates,protocol,chain:{observeTransfer:async()=>{reads++;throw new Error('unexpected fallback read');}}});
  return{op,source,protocolFor,serviceFor,effects:()=>({reads,writes})};
}
test('known prepayment CREATE never grants another direct or service read',async()=>{
  const w=retainedSource('observed'),protocol=w.protocolFor(createOperatorBuyerAccess({custodyBuyer})),service=w.serviceFor(protocol);
  await assert.rejects(protocol.recheck(w.op),closed);
  await assert.rejects(service.protocolRecheck({operationId:w.op.id,token:'retained'}),closed);
  assert.deepEqual(w.effects(),{reads:0,writes:0});
});
test('missing capability refuses even retained unknown recovery in protocol and service',async()=>{
  const w=retainedSource('broadcast-started'),protocol=w.protocolFor(null),service=w.serviceFor(protocol);
  await assert.rejects(protocol.recheck(w.op),closed);
  await assert.rejects(service.protocolRecheck({operationId:w.op.id,token:'retained'}),closed);
  await assert.rejects(service.verifyDeal({accountId:w.op.accountId,operationId:w.op.id}),closed);
  await assert.rejects(protocol.readIssued(w.op),closed);
  await assert.rejects(protocol.readIssuedPayment(w.op,'a'.repeat(64)),closed);
  assert.deepEqual(w.effects(),{reads:0,writes:0});
});

import { readIssuedWallet } from '../src/devnet-demo/issued-readback.mjs';
import { NATIVE_AGREEMENT_PAYMENT } from '../src/dacs/native-agreement-payment-consumer.mjs';
import { SELLER_SR2_PUBLIC_PROJECTION } from '../src/dacs/seller-sr2-agreement-consumer.mjs';
test('closed wallet readback rejects known CREATEs and payment verification rejects CREATE hashes',async()=>{
  const known=retainedSource('observed'),knownProtocol=known.protocolFor(createOperatorBuyerAccess({custodyBuyer}));
  assert.equal(await readIssuedWallet({sourceCapability:known.source,address:wallet,hash:'a'.repeat(64)}),null);
  assert.equal(await knownProtocol.readIssuedPayment(known.op,'a'.repeat(64)),null);
  const unknown=retainedSource('broadcast-started'),protocol=unknown.protocolFor(createOperatorBuyerAccess({custodyBuyer}));
  assert.equal(await protocol.readIssuedPayment(unknown.op,'a'.repeat(64)),null);
  Object.assign(unknown.op.terms.protocol,{profile:'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',nativePayment:NATIVE_AGREEMENT_PAYMENT,sellerAgreementProjection:SELLER_SR2_PUBLIC_PROJECTION});
  await assert.rejects(unknown.serviceFor(protocol).verifyDeal({accountId:unknown.op.accountId,operationId:unknown.op.id}),closed);
  assert.deepEqual(unknown.effects(),{reads:0,writes:0});
});

import { createWalletRpcRouter } from '../src/portal/wallet-rpc.mjs';
import { createApp } from '../src/app.mjs';
import { createDevnetAgreementTransportBroker } from '../src/portal/devnet-agreement-transport-broker.mjs';
import * as buyerAccessModule from '../src/devnet-demo/buyer-access.mjs';
const duckAccess=Object.freeze({allowsWallet:()=>true,assertWallet(){},assertRelayWallet(){},assertSellerJob(){},assertSellerWallet(){},jobAccess:()=>'open',sellerNotice:()=>null});
test('native Agreement relay and app refuse a missing or caller-built capability at construction',async()=>{
  const {source}=retainedSource('observed'),config={publicOrigin:'http://127.0.0.1:1',logLevel:'error'};
  assert.throws(()=>createWalletRpcRouter({config,nativeTransport:source}),/requires the operator buyerAccess capability/);
  assert.throws(()=>createWalletRpcRouter({config,nativeTransport:source,buyerAccess:duckAccess}),/constructed operator capability/);
  assert.doesNotThrow(()=>createWalletRpcRouter({config,nativeTransport:source,buyerAccess:createOperatorBuyerAccess({custodyBuyer})}));
  await assert.rejects(createApp({config,devnetAgreementTransport:source,dacsProtocol:null}),/requires the constructed operator buyerAccess capability/);
  await assert.rejects(createApp({config,devnetAgreementTransport:source,dacsProtocol:{buyerAccess:duckAccess}}),/constructed operator capability/);
  assert.throws(()=>createDevnetAgreementTransportBroker({config,sourceCapability:source,journal:source.journal}),error=>error.code==='broker_profile_held'&&/buyer-access check is required/.test(error.message));
});
test('bootstrap relay refuses retryably before the capability exists, then applies the buyer-only relay check',()=>{
  const {assertBootstrapRelay}=buyerAccessModule;
  const seller=`0x${'3'.repeat(64)}`,access=createOperatorBuyerAccess({custodyBuyer,custodySeller:`did:demos:agent:${'3'.repeat(64)}`});
  const nonce=address=>({method:'nodeCall',params:[{message:'getAddressNonce',data:{address}}]});
  assert.throws(()=>assertBootstrapRelay(null,false,nonce(seller)),error=>error.code==='operator_starting'&&error.retryable===true);
  assert.throws(()=>assertBootstrapRelay(duckAccess,false,nonce(seller)),/constructed operator capability/);
  for(const [binding,body] of [[true,{phase:'bind',address:wallet}],[false,nonce(wallet)],[false,{method:'execute',params:[{extra:'confirmTx',data:{content:{from:wallet}}}]}],
    [false,{method:'execute',params:[{extra:'broadcastTx',data:{response:{data:{transaction:{content:{from:wallet}}}}}}]}]])assert.throws(()=>assertBootstrapRelay(access,binding,body),closed);
  // The custody seller's traffic is in-process; its address earns nothing here.
  assert.throws(()=>assertBootstrapRelay(access,true,{phase:'bind',address:seller}),{code:'seller_wallet_in_process'});
  assert.throws(()=>assertBootstrapRelay(access,false,nonce(seller)),{code:'seller_wallet_in_process'});
  assert.doesNotThrow(()=>assertBootstrapRelay(access,true,{phase:'bind',address:`0x${'2'.repeat(64)}`}));
  assert.doesNotThrow(()=>assertBootstrapRelay(access,false,nonce(`0x${'2'.repeat(64)}`)));
  assert.doesNotThrow(()=>assertBootstrapRelay(access,false,{method:'nodeCall',params:[{message:'getNetworkInfo',data:{}}]}));
});
test('closed-access-19-resend logs each reported resend by its own job: outside, unknown before attach, never custody or Listing',async t=>{
  const {crossJobResendLog}=buyerAccessModule,foreignJob='01ARZ3NDEKTSV4RRFFQ69G5FAV',custodyJob='01ARZ3NDEKTSV4RRFFQ69G5FAW',paidJob='01ARZ3NDEKTSV4RRFFQ69G5FAX';
  let attached=false;
  const access=createOperatorBuyerAccess({custodyBuyer,buyerForJob:job=>attached?(job===custodyJob?`0x${'2'.repeat(64)}`:wallet):null,paymentObserved:job=>job===paidJob,buyerLookupReady:()=>attached});
  const lines=[],write=process.stderr.write;t.after(()=>{process.stderr.write=write;});
  process.stderr.write=function(chunk,...rest){if(String(chunk).startsWith('closed-access-19-resend')){lines.push(String(chunk));return true;}return write.call(this,chunk,...rest);};
  assert.throws(()=>crossJobResendLog(duckAccess),/constructed operator capability/);
  const log=crossJobResendLog(access),notice=(jobId,hash,artifactKind='FinalityCommitmentRecord')=>log({hash,writer:wallet,jobId,artifactKind});
  const line=(job,hash,what)=>`closed-access-19-resend: job ${job} tx ${hash}: one unchanged resend of an accepted but missing seller write for a job ${what}; no new transaction signature, approval or nonce\n`;
  // Before the purchase store is attached the job's access is unknown, never "outside".
  notice(custodyJob,'a'.repeat(64));
  assert.deepEqual(lines,[line(custodyJob,'a'.repeat(64),'whose closed access is unknown (the purchase store is not attached yet)')]);
  attached=true;lines.length=0;
  notice(custodyJob,'a'.repeat(64));notice(`listing:report`,'c'.repeat(64),'Listing');
  assert.deepEqual(lines,[],'custody jobs and Listings log nothing');
  // A foreign job, paid or not, is outside closed access.
  notice(foreignJob,'b'.repeat(64));notice(paidJob,'d'.repeat(64),'SettlementEvidence');
  assert.deepEqual(lines,[line(foreignJob,'b'.repeat(64),'outside closed access'),line(paidJob,'d'.repeat(64),'outside closed access')]);
  lines.length=0;crossJobResendLog(createOperatorBuyerAccess({openBuyerAccess:true}))({hash:'b'.repeat(64),jobId:foreignJob,artifactKind:'FinalityCommitmentRecord'});
  assert.deepEqual(lines,[],'open access logs nothing');
});
