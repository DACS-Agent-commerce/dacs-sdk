// Real agent and authenticated SQLite state; absent host capabilities throw if
// reached. These vectors test the caller's payment and completion gates.
import './d5-isolated-dependencies.mjs';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPublicKey,randomBytes,verify} from 'node:crypto';
import vm from 'node:vm';
import * as core from '@kynesyslabs/dacs';
import * as local from './local-anchor-fixture.mjs';
import * as lifecycleProtocol from './lifecycle-protocol-fixture.mjs';
import {fixtureListing} from '../fixtures/listings.mjs';
import {key,bundleFor,T,JOBS} from './bilateral-vet-fixture.mjs';
const durableState=await import('../../src/dacs/seller-durable-state.mjs');
const {createSellerDurableState}=durableState;
// The package's own claim and signature module; only absent host capabilities are stubbed.
const claims=await import('../../src/dacs/demos-claims.mjs');
const forbidden=()=>{throw new Error('external effect reached before lifecycle admission')};
export async function agentFixture({paid=false,collision=false,lifecycle=false,early=false}={}){
 const seller=key(),buyer=key(),dir=mkdtempSync(join(tmpdir(),'seller-agent-gates-'));
 const listing=lifecycle?fixtureListing({claim:seller.claim,signBytes:seller.sign},{now:T}):{pin:{listingId:'agent-gates',version:1,contentHash:'b'.repeat(64)},seller:{identity:bundleFor(seller)},pipeline:[],terms:{},offering:{title:'fixture',deliverable:{accessModel:'public'}}};
 const pin=lifecycle?lifecycleProtocol.listingPin(listing):listing.pin;
 const anchors=lifecycle?local.localAnchor({now:()=>T+1000}):{read:forbidden,write:forbidden},agreements=new Map();
 const controls={observation:null};
 let store=await createSellerDurableState({dir,signer:seller,listingPin:pin});store.retainContext({admittedAt:T,validation:{disposition:'verified',step:9,reason:'verified',listing,listingContentHash:pin.contentHash,revocation:'absent',railResolution:{disposition:'verified',reason:'verified'}}});
 for(const jobId of JOBS)await store.withJob(jobId,async()=>{
  const buyerBundle=bundleFor(buyer);
  const session={jobId,buyerBundle,buyerBundleHash:core.identityBundleHash(buyerBundle),stage:paid?'delivered':'proposed'};
  if(lifecycle){
   const ref=role=>({anchor:{kind:'storage-program',locator:'vet-'+role},contentHash:'d'.repeat(64)});
   const draft=core.deriveFixedPriceAgreement({jobId,verifiedListing:{disposition:'verified',listing,pin},buyer:{identityBundle:buyerBundle,vetRecordRef:ref('buyer')},seller:{identityBundle:listing.seller.identity,vetRecordRef:ref('seller')},selectedRail:{railId:'demos-native:DEM',railVersion:1},payoutBindings:[{railId:'demos-native:DEM',phaseIndex:2,payeeAddress:seller.claim.slice(16)}],generatedAt:T});
   const agreement=await core.signFixedPriceAgreement(draft,{party:buyer.claim,algorithm:'ed25519',sign:buyer.sign},{party:seller.claim,algorithm:'ed25519',sign:seller.sign});
   const address=core.fixedPriceAgreementLogicalAddress(jobId),hash=core.contentHash(agreement);
   await anchors.write({logicalAddress:address,artifact:agreement,writer:buyer.claim,writerSignature:local.signAnchorWrite(buyer.sign,address,hash)});
   agreements.set(jobId,agreement);
   Object.assign(session,{agreement,agreementHash:hash,agreementRef:local.fixtureRef(address,hash),phaseResults:[{index:0,step:listing.pipeline[0],invokedAt:T,result:{ok:true,contextDelta:{}},contextDelta:{}}],transportIdentity:{agreementHash:hash}});
  }
  if(paid)session.payment={settlementId:'demos:one',txHash:'a'.repeat(64),deliveredAt:T};
  store.saveSession(session);
 });
 if(paid)await store.withJob(JOBS[0],()=>store.bindSettlement('demos:one',JOBS[0],{jobId:JOBS[0]}));
 if(collision)await store.withJob(JOBS[1],()=>store.bindSettlement('demos:one',JOBS[1],{jobId:JOBS[1]}));
 const verifyComponent=({signedBytes,signature})=>{try{return verify(null,signedBytes,createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(signature.signer.slice(16),'hex')]),format:'der',type:'spki'}),Buffer.from(signature.value,'base64url'));}catch{return false}};
 const protocolNames=['agreementInput','agreementTerms','assembleBundleCopies','bundleAddress','bundleSession','bundleSigningPlan','commitmentReader','commitmentSession','commitmentVerifier','contributionVerifier','deliverableAddress','deliveryEvidenceAddress','verifyAnchoredCopy','verifyDelivery','verifyPaymentEvidence'];
 const protocol=Object.fromEntries(protocolNames.map(n=>[n,forbidden]));Object.assign(protocol,{ed25519Deps:{},DEM_RAIL_DEFINITION:{},RAIL_REGISTRY_VERSION:1,listingPin:l=>l.pin,protocolSupport:()=>({supported:true,phases:{payment:2,delivery:3}})});
 if(lifecycle)Object.assign(protocol,lifecycleProtocol);
 const deriveStorageAddress=(owner,name,nonce,salt)=>'stor-'+core.sha256Hex(`${owner}:${name}:${nonce}:${salt}`).slice(0,40);
 let signatureCapability;
 if(lifecycle){
  const authModule=new vm.SourceTextModule(readFileSync(new URL('../../src/dacs/commit-on-signature.mjs',import.meta.url),'utf8'));
  const dependencies={'@kynesyslabs/dacs':core,'./demos-claims.mjs':claims,'./wallet-transactions.mjs':{deriveStorageAddress}};
  await authModule.link(spec=>{const values=dependencies[spec];return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);});});await authModule.evaluate();signatureCapability=authModule.namespace;
 }

 const modules={
  '@kynesyslabs/dacs':core,'node:path':await import('node:path'),'node:crypto':{randomBytes},
  '../devnet-demo/buyer-access.mjs':{operatorBuyerAccessConfig:()=>null},
  './demos-claims.mjs':claims,
  './commit-on-signature.mjs':lifecycle?signatureCapability:{commitOnSignatureConfig:v=>v,verifySignatureAgreement:forbidden,verifyAgreementCreateAuthorization:forbidden},
  './delivery-evidence.mjs':{isNativeDeliveryEvidence:forbidden},
  './listing.mjs':{validateListing:async()=>({disposition:'verified'}),verifyComponent,DEM_RAIL:{railId:'demos-native:DEM',railVersion:1}},
  './fixture-anchors.mjs':lifecycle?local:Object.fromEntries(['fixtureRef','signAnchorWrite','verifyFixtureRecord','verifyFixtureReceipt','fixtureTxRef','canonicalSignature'].map(n=>[n,forbidden])),
  // Preserve the real exports (including capacity defaults); replace only the store factory.
  './seller-durable-state.mjs':{...durableState,createSellerDurableState:async()=>store},
  './native-payment-evidence-consumer.mjs':{NATIVE_PAYMENT_EVIDENCE:'native-fixture',nativePaymentEvidenceConfig:()=>null,checkNativePaymentEvidence:forbidden},
  './payment-evidence-wallet-journal.mjs':{isPaymentEvidenceWalletJournalPair:()=>false,paymentEvidenceWalletJournalOf:()=>null},
  './dem-delivery-context-consumer.mjs':{demDeliveryContextConfig:()=>null,resolveDemDeliverySellerContext:forbidden},
  './native-dem-delivery-consumer.mjs':Object.fromEntries(['nativeDemDeliveryConfig','submitNativeDemDelivery','reconcileNativeDemDelivery','readNativeDemDelivery','verifyNativeDemDeliveryReceipt','isProvenUnsignedAbsence'].map(n=>[n,n==='nativeDemDeliveryConfig'?()=>null:forbidden])),
  './purchase-protocol.mjs':protocol,
  './seller-proposal-time.mjs':await import('../../src/dacs/seller-proposal-time.mjs'),
  './rail-authority.mjs':await import('../../src/dacs/rail-authority.mjs'),
  './session-admission.mjs':await import('../../src/dacs/session-admission.mjs'),
 };
 const module=new vm.SourceTextModule(readFileSync(new URL('../../src/dacs/seller-agent.mjs',import.meta.url),'utf8'));
 await module.link(async spec=>{const values=modules[spec];if(!values)throw new Error('missing isolated host capability '+spec);return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value] of Object.entries(values))this.setExport(key,value);});});await module.evaluate();
 const create=()=>module.namespace.createSellerAgent({signer:seller,listing,anchors,observeDemosTransfer:lifecycle?async hash=>controls.observation??({status:'included',txHash:hash,payer:buyer.claim.slice(16),payee:seller.claim.slice(16),amountOs:'2500000000',blockNumber:8,includedAt:T+2000}):forbidden,durableDirectory:dir,commitOnSignature:early,now:()=>T+2000,simulatedFixture:true});
 let agent=await create();
 const negotiate=async(jobId,{anchor=true}={})=>{
  const buyerIdentityBundle=bundleFor(buyer),input=lifecycleProtocol.agreementInput({jobId,listing,buyerBundle:buyerIdentityBundle,generatedAt:T}),draft=core.deriveFixedPriceAgreement(input),plan=core.createFixedPriceAgreementSigningPlan(draft);
  const buyerContribution=await core.createFixedPriceAgreementSignatureContribution(plan,'buyer',{party:buyer.claim,algorithm:'ed25519',sign:buyer.sign});
  const material={proposalVersion:'1',plan,buyerContribution},proposal={...material,proposalHash:core.sha256Hex(core.canonicalize(material))};
  const transportIdentity={jobId,planHash:plan.planHash,agreementHash:plan.agreementHash,buyer:buyer.claim,seller:seller.claim,proposalHash:proposal.proposalHash};
  const progress=await agent.receiveProposal({proposal,transportIdentity,buyerIdentityBundle});
  if(progress.disposition!=='complete')throw new Error('seller negotiation did not complete: '+JSON.stringify(progress));
  const agreement=await core.finalizeFixedPriceAgreementContributions(plan,[buyerContribution,progress.contribution],lifecycleProtocol.contributionVerifier),address=core.fixedPriceAgreementLogicalAddress(jobId);
  agreements.set(jobId,agreement);
  if(anchor)await anchors.write({logicalAddress:address,artifact:agreement,writer:buyer.claim,writerSignature:local.signAnchorWrite(buyer.sign,address,core.contentHash(agreement))});
  const owner='0x'+buyer.claim.slice(16),programName=core.logicalToStorageProgramName(address),storageAddress=deriveStorageAddress(owner,programName,1,'');
  const content={type:'storageProgram',from:owner,from_ed25519_address:owner,to:storageAddress,nonce:1,amount:0,data:['storageProgram',{operation:'CREATE_STORAGE_PROGRAM',programName,storageAddress,salt:'',encoding:'json',storageLocation:'onchain',acl:{mode:'public'},data:agreement,metadata:{logicalAddress:address,artifactKind:'Agreement',contentHash:core.contentHash(agreement),envelopeHash:core.sha256Hex(core.canonicalize(agreement))}}]};
  const hash=core.sha256Hex(JSON.stringify(content)),signedProjection={content,hash,signature:{type:'ed25519',data:buyer.sign(Buffer.from(hash)).toString('base64url')}};
  return {jobId,agreement,signedProjection};
 };
 return {get agent(){return agent;},createAgent:create,buildReport:module.namespace.buildReport,reopen:async()=>{agent.close();store=await createSellerDurableState({dir,signer:seller,listingPin:pin});agent=await create();return agent;},get store(){return store;},negotiate,seller,buyer,pin,listing,anchors,agreements,controls,protocol,close:()=>{agent.close();rmSync(dir,{recursive:true,force:true});}};
}
