import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {identityBundleHash} from '@kynesyslabs/dacs';
import {privateModule} from './private-module.mjs';
import {seller,buyer,JOB,NOW} from './protocol-fixture.mjs';
import {fixtureListing,fixtureIdentityBundle} from '../fixtures/listings.mjs';
import {railSteward} from './rail-authority-fixture.mjs';
import {createSessionAdmissionFixture} from './session-admission-fixture.mjs';
import {createDemDeliveryContext} from '../../src/dacs/dem-delivery-context-consumer.mjs';
import {createNativePaymentEvidenceConsumer} from '../../src/dacs/native-payment-evidence-consumer.mjs';
export async function proposalAdmissionFixture(t){
 const dir=await mkdtemp(join(tmpdir(),'TEST-proposal-admission-'));t.after(()=>rm(dir,{recursive:true,force:true}));let time=NOW;const signed=[];
 const unreachable=()=>{throw new Error('TEST external effect');},listing=fixtureListing(seller,{now:NOW}),admission=createSessionAdmissionFixture({seller:{claim:seller.claim,sign:seller.signBytes},buyer:{claim:buyer.claim,sign:buyer.signBytes},now:()=>time});
 const config={signer:{claim:seller.claim,sign:bytes=>{signed.push(Buffer.from(bytes).toString());return seller.signBytes(bytes);}},listing,durableDirectory:dir,now:()=>time,
  agreementAnchor:{source:'TEST-native',readAgreement:unreachable},nativeArtifactAnchor:{writer:seller.claim,publish:unreachable,readRetained:unreachable,verifyReceipt:unreachable},deliverableProducer:unreachable,deliverySchemaVerifier:{schemaUrl:listing.offering.deliverable.schemaUrl,verify:unreachable},railAuthority:railSteward().railAuthority(),sessionAdmission:admission.sessionAdmission,
  nativePaymentEvidence:createNativePaymentEvidenceConsumer({rpcUrl:'http://127.0.0.1:1',anchorEvidence:unreachable,fetchImpl:unreachable}),demDeliveryContext:createDemDeliveryContext({authority:'TEST-admission',resolveBuyer:unreachable,resolveSeller:unreachable})};
 const sourceUrl=new URL('../../src/dacs/seller-agent.mjs',import.meta.url),api=await privateModule(sourceUrl,[],source=>{if(!source.includes('  return api;'))throw new Error('TEST internal factory missing');return source.replace('  return api;','  return {...api,stagedProposal:receiveProposal};');});
 const open=async()=>{const agent=await api.createSellerAgent(config);t.after(()=>agent.close());return agent;};
 const input=async(agent,jobId=JOB,party=buyer)=>{const challenge=await agent.issueSessionChallenge({jobId,buyer:party.claim}),bundle=fixtureIdentityBundle(party,time);bundle.sessionNonce=challenge.sessionNonce;bundle.presentation.signatures[0].signature=party.signBytes(Buffer.from('dacs-bundle-presentation:v1:'+identityBundleHash(bundle))).toString('base64url');return{proposal:{},transportIdentity:{jobId,buyer:party.claim,seller:seller.claim},buyerIdentityBundle:bundle};};
 return{config,listing,dir,admission,signed,open,input,advance:ms=>{time+=ms;}};
}
