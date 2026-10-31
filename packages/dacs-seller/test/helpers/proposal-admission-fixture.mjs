import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import * as core from '@kynesyslabs/dacs';
import {agreementInput} from '../../src/dacs/purchase-protocol.mjs';
import {SELLER_REQUIREMENT} from '../../src/devnet-demo/agreement-context.mjs';
import {identityBundleHash} from '@kynesyslabs/dacs';
import {privateModule} from './private-module.mjs';
import {seller,buyer,JOB,NOW} from './protocol-fixture.mjs';
import {fixtureListing,fixtureIdentityBundle} from '../fixtures/listings.mjs';
import {railSteward} from './rail-authority-fixture.mjs';
import {createSessionAdmissionFixture} from './session-admission-fixture.mjs';
import {createDemDeliveryContext} from '../../src/dacs/dem-delivery-context-consumer.mjs';
import {createNativePaymentEvidenceConsumer} from '../../src/dacs/native-payment-evidence-consumer.mjs';
export async function proposalAdmissionFixture(t,{assembled=false,maxJobs,expectedSizeBytes=1024}={}){
 const dir=await mkdtemp(join(tmpdir(),'TEST-proposal-admission-'));t.after(()=>rm(dir,{recursive:true,force:true}));let time=NOW;const signed=[];const contexts=new Map();
 const unreachable=()=>{throw new Error('TEST external effect');};
 const {signature,...listingDraft}=fixtureListing(seller,{now:NOW});
 if(expectedSizeBytes===null)delete listingDraft.offering.deliverable.expectedSizeBytes;
 else listingDraft.offering.deliverable.expectedSizeBytes=expectedSizeBytes;
 const listing=await core.signComponentArtifact(listingDraft,core.ARTIFACT_SEPARATORS.Listing,{signer:seller.claim,algorithm:'ed25519',sign:seller.signBytes}),admission=createSessionAdmissionFixture({seller:{claim:seller.claim,sign:seller.signBytes},buyer:{claim:buyer.claim,sign:buyer.signBytes},now:()=>time});
 const config={maxJobs,signer:{claim:seller.claim,sign:bytes=>{signed.push(Buffer.from(bytes).toString());return seller.signBytes(bytes);}},listing,durableDirectory:dir,now:()=>time,
  agreementAnchor:{source:'TEST-native',readAgreement:unreachable},nativeArtifactAnchor:{writer:seller.claim,publish:unreachable,readRetained:unreachable,verifyReceipt:unreachable},deliverableProducer:unreachable,deliverySchemaVerifier:{schemaUrl:listing.offering.deliverable.schemaUrl,verify:unreachable},railAuthority:railSteward().railAuthority(),sessionAdmission:admission.sessionAdmission,
  nativePaymentEvidence:createNativePaymentEvidenceConsumer({rpcUrl:'http://127.0.0.1:1',anchorEvidence:unreachable,fetchImpl:unreachable}),demDeliveryContext:createDemDeliveryContext({authority:'TEST-admission',resolveBuyer:unreachable,resolveSeller:async({jobId})=>contexts.has(jobId)?{disposition:'present',value:structuredClone(contexts.get(jobId))}:{disposition:'indeterminate',reason:'TEST context unavailable'}})};
 const sourceUrl=new URL('../../src/dacs/seller-agent.mjs',import.meta.url),api=await privateModule(sourceUrl,[],source=>{
  if(!assembled&&source.includes('await respondToFixedPriceAgreementProposalDurable(')){
   const file=ts.createSourceFile('agent.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let method;
   const find=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='receiveProposal')method=node;ts.forEachChild(node,find);};find(file);
   const signing=method.body.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(file)==='signUnderPin'));
   if(!signing)throw new Error('TEST signing stage missing');
   source=source.slice(0,signing.getStart(file))+"\nthrow new SellerAgentError('proposal_not_assembled','TEST isolated admission boundary',503);\n"+source.slice(method.body.end-1);
  }
  if(!source.includes('  return api;'))throw new Error('TEST internal factory missing');return source.replace('  return api;','  return {...api,stagedProposal:receiveProposal};');
 });
 const open=async()=>{const agent=await api.createSellerAgent(config);t.after(()=>agent.close());return agent;};
 const input=async(agent,jobId=JOB,party=buyer)=>{const challenge=await agent.issueSessionChallenge({jobId,buyer:party.claim}),bundle=fixtureIdentityBundle(party,time);bundle.sessionNonce=challenge.sessionNonce;bundle.presentation.signatures[0].signature=party.signBytes(Buffer.from('dacs-bundle-presentation:v1:'+identityBundleHash(bundle))).toString('base64url');return{proposal:{},transportIdentity:{jobId,buyer:party.claim,seller:seller.claim},buyerIdentityBundle:bundle};};
 const proposal=async(agent,jobId=JOB,{synthetic=false,generatedAt=time}={})=>{
  const request=await input(agent,jobId),base=agreementInput({jobId,listing,buyerBundle:request.buyerIdentityBundle,generatedAt});
  const buyerRef=await admission.vetRecord(jobId,buyer.claim,request.buyerIdentityBundle,{requirement:listing.buyerRequirement});
  const sellerRef=await admission.vetRecord(jobId,seller.claim,listing.seller.identity,{requirement:SELLER_REQUIREMENT});
  const actual={...base,buyer:{...base.buyer,vetRecordRef:buyerRef},seller:{...base.seller,vetRecordRef:sellerRef}};
  const vetRequirements=[['buyer',buyer.claim,seller.claim,listing.buyerRequirement],['seller',seller.claim,buyer.claim,SELLER_REQUIREMENT]].map(([role,evaluatedParty,verifier,requirement])=>({vetRecordRef:actual[role].vetRecordRef,evaluatedParty,verifier,requirement,freshness:[],dealSpecific:[]}));
  contexts.set(jobId,{input:structuredClone(actual),vetRequirements:structuredClone(vetRequirements)});
  return proposalForInput(synthetic?base:actual);
 };
 return{config,listing,dir,admission,signed,open,input,proposal,contexts,advance:ms=>{time+=ms;}};
}

export async function proposalForInput(input){
 const plan=core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(input)),buyerContribution=await core.createFixedPriceAgreementSignatureContribution(plan,'buyer',{party:buyer.claim,algorithm:'ed25519',sign:buyer.signBytes});
 const material={proposalVersion:'1',plan,buyerContribution},proposal={...material,proposalHash:core.sha256Hex(core.canonicalize(material))};
 return{proposal,transportIdentity:{jobId:input.jobId,planHash:plan.planHash,agreementHash:plan.agreementHash,buyer:buyer.claim,seller:seller.claim,proposalHash:proposal.proposalHash},buyerIdentityBundle:structuredClone(input.buyer.identityBundle)};
}
