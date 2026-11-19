import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import * as core from '@kynesyslabs/dacs';
import {canonicalize,sha256Hex} from '@kynesyslabs/dacs';
import {agreementInput} from '../../src/dacs/purchase-protocol.mjs';
import {SELLER_REQUIREMENT} from '../../src/devnet-demo/agreement-context.mjs';
import {identityBundleHash} from '@kynesyslabs/dacs';
import {privateModule} from './private-module.mjs';
import {seller,buyer,JOB,NOW} from './protocol-fixture.mjs';
import {fixtureListing,fixtureIdentityBundle} from '../fixtures/listings.mjs';
import {railSteward} from './rail-authority-fixture.mjs';
import {createSessionAdmissionFixture} from './session-admission-fixture.mjs';
import {createSellerTransportStore} from './bound-transport-store.mjs';
import {createDemDeliveryContext} from '../../src/dacs/dem-delivery-context-consumer.mjs';
import {HOST_CONTEXT_CALLBACKS,presentContextAnswer} from './host-context-callbacks.mjs';
import {createNativePaymentEvidenceConsumer} from '../../src/dacs/native-payment-evidence-consumer.mjs';
// `ledger` is a function returning the challenge ledger the agent uses; by default one transport store lives as long as the fixture.
// `vetMode` selects the records and capability the fixture builds: the TP-1 G3
// orchestrator mode has the seller verify its own record (default: counterparty).
export const ORCHESTRATOR_MODE='tp1-g3-orchestrator';
export async function proposalAdmissionFixture(t,{assembled=false,maxJobs,expectedSizeBytes=1024,buyerRequirement=null,ledger=null,publicEndpoint=null,vetMode}={}){
 const dir=await mkdtemp(join(tmpdir(),'TEST-proposal-admission-'));t.after(()=>rm(dir,{recursive:true,force:true}));let time=NOW;const signed=[];const contexts=new Map();
 let store=null,generations=0;const storeDirectory=await mkdtemp(join(tmpdir(),'TEST-proposal-admission-ledger-'));t.after(()=>rm(storeDirectory,{recursive:true,force:true}));
 const openStore=()=>store=createSellerTransportStore({path:join(storeDirectory,'transport.sqlite'),now:()=>time,generation:'TEST-generation-'+ ++generations});
 if(ledger===null){openStore();t.after(()=>store.close());}
 const unreachable=()=>{throw new Error('TEST external effect');};
 const {signature,...listingDraft}=fixtureListing(seller,{now:NOW});
 if(publicEndpoint!==null)listingDraft.seller.publicEndpoint=publicEndpoint;
 if(buyerRequirement!==null)listingDraft.buyerRequirement=structuredClone(buyerRequirement);
 if(expectedSizeBytes===null)delete listingDraft.offering.deliverable.expectedSizeBytes;
 else listingDraft.offering.deliverable.expectedSizeBytes=expectedSizeBytes;
 const listing=await core.signComponentArtifact(listingDraft,core.ARTIFACT_SEPARATORS.Listing,{signer:seller.claim,algorithm:'ed25519',sign:seller.signBytes}),admission=createSessionAdmissionFixture({seller:{claim:seller.claim,sign:seller.signBytes},buyer:{claim:buyer.claim,sign:buyer.signBytes},now:()=>time});
 const orchestrated=vetMode===ORCHESTRATOR_MODE,sellerParty={claim:seller.claim,sign:seller.signBytes};
 const resolveSeller=async({jobId})=>contexts.has(jobId)?{disposition:'present',value:structuredClone(contexts.get(jobId))}:{disposition:'indeterminate',reason:'TEST context unavailable'};
 const capability=mode=>createDemDeliveryContext({authority:'TEST-admission',vetMode:mode,resolveBuyer:async scope=>presentContextAnswer(scope),resolveSeller,...HOST_CONTEXT_CALLBACKS});
 const config={get challengeLedger(){return ledger===null?store.challenges:ledger();},maxJobs,...vetMode===undefined?{}:{vetMode},signer:{claim:seller.claim,sign:bytes=>{signed.push(Buffer.from(bytes).toString());return seller.signBytes(bytes);}},listing,durableDirectory:dir,now:()=>time,
  agreementAnchor:{source:'TEST-native',readAgreement:unreachable},nativeArtifactAnchor:{writer:seller.claim,publish:unreachable,readRetained:unreachable,verifyReceipt:unreachable},deliverableProducer:unreachable,deliverySchemaVerifier:{schemaUrl:listing.offering.deliverable.schemaUrl,verify:unreachable},railAuthority:railSteward().railAuthority(),sessionAdmission:admission.sessionAdmission,
  nativePaymentEvidence:createNativePaymentEvidenceConsumer({rpcUrl:'http://127.0.0.1:1',anchorEvidence:unreachable,fetchImpl:unreachable}),demDeliveryContext:capability(vetMode)};
 const sourceUrl=new URL('../../src/dacs/seller-agent.mjs',import.meta.url),api=await privateModule(sourceUrl,[],source=>{
  if(!assembled&&source.includes('await respondToFixedPriceAgreementProposalDurable(')){
   const file=ts.createSourceFile('agent.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);let method;
   const find=node=>{if(ts.isFunctionDeclaration(node)&&node.name?.text==='receiveProposal')method=node;ts.forEachChild(node,find);};find(file);
   const signing=method.body.statements.find(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(declaration=>declaration.name.getText(file)==='signUnderPin'));
   if(!signing)throw new Error('TEST signing stage missing');
   source=source.slice(0,signing.getStart(file))+"\nthrow new SellerAgentError('proposal_not_assembled','TEST isolated admission boundary',503);\n"+source.slice(method.body.end-1);
  }
  if(!source.includes('  return api;'))throw new Error('TEST internal factory missing');return source.replace('  return api;','  return {...api,stagedProposal:receiveProposal,retainedVetEvidenceProblem};');
 });
 // The agent's closed-bootstrap gate lets every job on: no K1 admission row exists in this fixture, and the gate's own answers have their tests.
 const open=async(overrides={})=>{const agent=await api.createSellerAgent({...config,closedBootstrapGate:()=>null,...overrides});t.after(()=>agent.close());return agent;};
 // The same durable directory reopened under `mode` (its own capability and agent option).
 const reopenAs=mode=>open({vetMode:mode,demDeliveryContext:capability(mode)});
 const sign=(party,bundle)=>{bundle.presentation.signatures[0].signature=party.signBytes(Buffer.from('dacs-bundle-presentation:v1:'+identityBundleHash(bundle))).toString('base64url');};
 // A first admission as the context route makes it, over the ledger the agent reads: a challenge issued for the job, the one attempt on the
 // context path, the agent's session admission read and the acceptance. `amend(bundle)` changes the presentation before it is signed and admitted.
 const admit=async(agent,jobId,party,amend,challengeBuyer=party.claim)=>{
  const ledger=config.challengeLedger,scopeHash=sha256Hex('TEST challenge scope '+jobId),{sessionNonce}=ledger.issue({jobId,buyer:challengeBuyer},scopeHash);
  const bundle=fixtureIdentityBundle(party,time);bundle.sessionNonce=sessionNonce;amend?.(bundle);sign(party,bundle);
  const attempt=ledger.attempt({path:'context',nonce:sessionNonce,jobId,buyer:party.claim,challengeScopeHash:scopeHash,presentationHash:sha256Hex(canonicalize(bundle))});
  const answer=await agent.admitSessionPresentation({jobId,bundle,nonce:sessionNonce});
  const record={buyerBundleText:canonicalize(bundle),buyerBundleHash:identityBundleHash(bundle),admission:structuredClone(answer),admittedAt:time,firstAdmission:{challengeExpiresAt:ledger.retained(sessionNonce).expiresAt,generatedAt:time,checkedAt:time}};
  if(!ledger.accept(attempt.owner,sessionNonce,record))throw new Error('TEST the acceptance was refused');
  return bundle;
 };
 // A started host admits the presentation over its wire: the signed challenge route, then the context route; an agent is admitted through its ledger.
 const hostPresentation=async(host,jobId)=>{const {hostBuyer}=await import('./host-context-client.mjs');return (await hostBuyer(host,listing,{jobId})).admit(jobId);};
 const input=async(agent,jobId=JOB,party=buyer,amend,challengeBuyer)=>({proposal:{},transportIdentity:{jobId,buyer:party.claim,seller:seller.claim},buyerIdentityBundle:typeof agent.url==='string'?await hostPresentation(agent,jobId):await admit(agent,jobId,party,amend,challengeBuyer)});
 // A presentation no challenge was ever attempted for: its nonce is one the ledger never issued, and nothing of it is admitted.
 const unadmitted=(jobId=JOB,party=buyer,amend)=>{const bundle=fixtureIdentityBundle(party,time);bundle.sessionNonce=randomBytes(32).toString('hex');amend?.(bundle);sign(party,bundle);return{proposal:{},transportIdentity:{jobId,buyer:party.claim,seller:seller.claim},buyerIdentityBundle:bundle};};
 const proposal=async(agent,jobId=JOB,{synthetic=false,generatedAt=time,expiresAt,buyerRecord={},sellerRecord={},sellerBundle=listing.seller.identity}={})=>{
  const request=await input(agent,jobId,buyer,expiresAt===undefined?undefined:bundle=>{bundle.claims[0].expiresAt=expiresAt;});
  const base=agreementInput({jobId,listing,buyerBundle:request.buyerIdentityBundle,generatedAt});
  const buyerRef=await admission.vetRecord(jobId,buyer.claim,request.buyerIdentityBundle,{requirement:listing.buyerRequirement,...buyerRecord});
  const sellerRef=await admission.vetRecord(jobId,seller.claim,sellerBundle,{requirement:SELLER_REQUIREMENT,...orchestrated?{verifier:sellerParty}:{},...sellerRecord});
  const actual={...base,buyer:{...base.buyer,vetRecordRef:buyerRef},seller:{...base.seller,identityBundle:sellerBundle,vetRecordRef:sellerRef}};
  const vetRequirements=[['buyer',buyer.claim,seller.claim,listing.buyerRequirement],['seller',seller.claim,orchestrated?seller.claim:buyer.claim,SELLER_REQUIREMENT]].map(([role,evaluatedParty,verifier,requirement])=>({vetRecordRef:actual[role].vetRecordRef,evaluatedParty,verifier,requirement,freshness:[],dealSpecific:[]}));
  contexts.set(jobId,{input:structuredClone(actual),vetRequirements:structuredClone(vetRequirements)});
  return proposalForInput(synthetic?base:actual);
 };
 return{config,listing,dir,admission,signed,open,reopenAs,capability,input,unadmitted,proposal,contexts,advance:ms=>{time+=ms;},get store(){return store;},storePath:join(storeDirectory,'transport.sqlite'),reopenStore(){store.close();openStore();}};
}

export async function proposalForInput(input){
 const plan=core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(input)),buyerContribution=await core.createFixedPriceAgreementSignatureContribution(plan,'buyer',{party:buyer.claim,algorithm:'ed25519',sign:buyer.signBytes});
 const material={proposalVersion:'1',plan,buyerContribution},proposal={...material,proposalHash:core.sha256Hex(core.canonicalize(material))};
 return{proposal,transportIdentity:{jobId:input.jobId,planHash:plan.planHash,agreementHash:plan.agreementHash,buyer:buyer.claim,seller:seller.claim,proposalHash:proposal.proposalHash},buyerIdentityBundle:structuredClone(input.buyer.identityBundle)};
}
