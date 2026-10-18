// Real agent and authenticated SQLite state; absent host capabilities throw if
// reached. These vectors test the caller's payment and completion gates.
import './d5-isolated-dependencies.mjs';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicKey,verify} from 'node:crypto';
import vm from 'node:vm';
import * as core from '@kynesyslabs/dacs';
import {key,bundleFor,T,JOBS} from './bilateral-vet-fixture.mjs';
const {createSellerDurableState}=await import('../../src/dacs/seller-durable-state.mjs');
const forbidden=()=>{throw new Error('external effect reached before lifecycle admission')};
export async function agentFixture({paid=false,collision=false}={}){
 const seller=key(),buyer=key(),dir=mkdtempSync(join(tmpdir(),'seller-agent-gates-'));
 const pin={listingId:'agent-gates',version:1,contentHash:'b'.repeat(64)},listing={pin,seller:{identity:bundleFor(seller)},pipeline:[],terms:{},offering:{title:'fixture'}};
 const store=await createSellerDurableState({dir,signer:seller,listingPin:pin});store.retainContext({admittedAt:T,validation:{disposition:'verified'}});
 for(const jobId of JOBS)await store.withJob(jobId,()=>{
  const buyerBundle=bundleFor(buyer);
  const session={jobId,buyerBundle,buyerBundleHash:core.identityBundleHash(buyerBundle),stage:paid?'delivered':'proposed'};
  if(paid)session.payment={settlementId:'demos:one',txHash:'a'.repeat(64),deliveredAt:T};
  store.saveSession(session);
 });
 if(paid)await store.withJob(JOBS[0],()=>store.bindSettlement('demos:one',JOBS[0],{jobId:JOBS[0]}));
 if(collision)await store.withJob(JOBS[1],()=>store.bindSettlement('demos:one',JOBS[1],{jobId:JOBS[1]}));
 const verifyComponent=({signedBytes,signature})=>{try{return verify(null,signedBytes,createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(signature.signer.slice(16),'hex')]),format:'der',type:'spki'}),Buffer.from(signature.value,'base64url'));}catch{return false}};
 const protocolNames=['agreementInput','agreementTerms','assembleBundleCopies','bundleAddress','bundleSession','bundleSigningPlan','commitmentReader','commitmentSession','commitmentVerifier','contributionVerifier','deliverableAddress','deliveryEvidenceAddress','verifyAnchoredCopy','verifyDelivery','verifyPaymentEvidence'];
 const protocol=Object.fromEntries(protocolNames.map(n=>[n,forbidden]));Object.assign(protocol,{ed25519Deps:{},DEM_RAIL_DEFINITION:{},RAIL_REGISTRY_VERSION:1,listingPin:l=>l.pin,protocolSupport:()=>({supported:true,phases:{payment:2,delivery:3}})});
 const modules={
  '@kynesyslabs/dacs':core,'node:path':await import('node:path'),
  '../devnet-demo/buyer-access.mjs':{operatorBuyerAccessConfig:()=>null},
  '../wallet/demos-signature.mjs':{addressForClaim:c=>'0x'+c.slice(16)},
  './commit-on-signature.mjs':{commitOnSignatureConfig:v=>v,verifySignatureAgreement:forbidden,verifyAgreementCreateAuthorization:forbidden},
  './delivery-evidence.mjs':{isNativeDeliveryEvidence:forbidden},
  './listing.mjs':{validateListing:async()=>({disposition:'verified'}),verifyComponent,DEM_RAIL:{railId:'demos-native:DEM',railVersion:1}},
  './fixture-anchors.mjs':Object.fromEntries(['fixtureRef','signAnchorWrite','verifyFixtureRecord','verifyFixtureReceipt','fixtureTxRef','canonicalSignature'].map(n=>[n,forbidden])),
  './seller-durable-state.mjs':{createSellerDurableState:async()=>store},
  './native-payment-evidence-consumer.mjs':{NATIVE_PAYMENT_EVIDENCE:'native-fixture',nativePaymentEvidenceConfig:()=>null,checkNativePaymentEvidence:forbidden},
  './dem-delivery-context-consumer.mjs':{demDeliveryContextConfig:()=>null,resolveDemDeliverySellerContext:forbidden},
  './native-dem-delivery-consumer.mjs':Object.fromEntries(['nativeDemDeliveryConfig','submitNativeDemDelivery','reconcileNativeDemDelivery','readNativeDemDelivery','verifyNativeDemDeliveryReceipt','isProvenUnsignedAbsence'].map(n=>[n,n==='nativeDemDeliveryConfig'?()=>null:forbidden])),
  './purchase-protocol.mjs':protocol,
  './seller-proposal-time.mjs':await import('../../src/dacs/seller-proposal-time.mjs'),
 };
 const module=new vm.SourceTextModule(readFileSync(new URL('../../src/dacs/seller-agent.mjs',import.meta.url),'utf8'));
 await module.link(async spec=>{const values=modules[spec];if(!values)throw new Error('missing isolated host capability '+spec);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);});});await module.evaluate();
 const agent=await module.namespace.createSellerAgent({signer:seller,listing,anchors:{read:forbidden,write:forbidden},observeDemosTransfer:forbidden,durableDirectory:dir,now:()=>T});
 return {agent,store,seller,buyer,pin,close:()=>{agent.close();rmSync(dir,{recursive:true,force:true});}};
}
