// Genuine fixture profile: real signatures, protocol, receipts and SQLite.
import * as core from '@kynesyslabs/dacs';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {seller as sellerKey,buyer as buyerKey,NOW} from './protocol-fixture.mjs';
import {JOBS} from './bilateral-vet-fixture.mjs';
import {fixtureListing,fixtureIdentityBundle} from '../fixtures/listings.mjs';
import {localAnchor,signAnchorWrite} from './local-anchor-fixture.mjs';
import * as protocol from '../../src/dacs/purchase-protocol.mjs';
import {agreementInput,contributionVerifier,listingPin} from '../../src/dacs/purchase-protocol.mjs';
import {createSellerDurableState} from '../../src/dacs/seller-durable-state.mjs';
import {createSellerAgent,buildReport} from '../../src/dacs/seller-agent.mjs';
import {buildStorageProgramCreatePayload,deriveStorageAddress} from '../../src/dacs/wallet-transactions.mjs';
export async function agentFixture({paid=false,collision=false,lifecycle=false,early=false}={}){
 const seller={...sellerKey,sign:sellerKey.signBytes},buyer={...buyerKey,sign:buyerKey.signBytes},dir=mkdtempSync(join(tmpdir(),'TEST-fixture-payment-')),listing=fixtureListing(sellerKey,{now:NOW}),pin=listingPin(listing),anchors=localAnchor({now:()=>NOW+2000}),agreements=new Map(),controls={observation:null};
 const config={signer:seller,listing,anchors,durableDirectory:dir,commitOnSignature:early,now:()=>NOW+2000,simulatedFixture:true,observeDemosTransfer:async hash=>controls.observation??{status:'included',txHash:hash,payer:buyer.address,payee:seller.address,amountOs:'2500000000',blockNumber:8,includedAt:NOW+3000}};
 let agent,store;const create=()=>createSellerAgent(config);
 const openStore=()=>createSellerDurableState({dir,signer:seller,listingPin:pin});
 const negotiate=async(jobId,{anchor=true,claims=[]}={})=>{
  const buyerIdentityBundle=fixtureIdentityBundle(buyerKey,NOW);
  buyerIdentityBundle.claims.push(...claims.map(ref=>({ref})));
  buyerIdentityBundle.presentation.signatures[0].signature=buyer.sign(Buffer.from('dacs-bundle-presentation:v1:'+core.identityBundleHash(buyerIdentityBundle))).toString('base64url');
  const input=agreementInput({jobId,listing,buyerBundle:buyerIdentityBundle,generatedAt:NOW}),plan=core.createFixedPriceAgreementSigningPlan(core.deriveFixedPriceAgreement(input)),buyerContribution=await core.createFixedPriceAgreementSignatureContribution(plan,'buyer',{party:buyer.claim,algorithm:'ed25519',sign:buyer.sign});
  const material={proposalVersion:'1',plan,buyerContribution},proposal={...material,proposalHash:core.sha256Hex(core.canonicalize(material))},transportIdentity={jobId,planHash:plan.planHash,agreementHash:plan.agreementHash,buyer:buyer.claim,seller:seller.claim,proposalHash:proposal.proposalHash},response=await agent.receiveProposal({proposal,transportIdentity,buyerIdentityBundle});
  if(response.disposition!=='complete')throw new Error('TEST proposal incomplete: '+JSON.stringify(response));
  const agreement=await core.finalizeFixedPriceAgreementContributions(plan,[buyerContribution,response.contribution],contributionVerifier),address=core.fixedPriceAgreementLogicalAddress(jobId);agreements.set(jobId,agreement);
  if(anchor)await anchors.write({logicalAddress:address,artifact:agreement,writer:buyer.claim,writerSignature:signAnchorWrite(buyer.sign,address,core.contentHash(agreement))});
  const programName=core.logicalToStorageProgramName(address),storageAddress=deriveStorageAddress(buyer.address,programName,1,''),signedProjection=buildStorageProgramCreatePayload({from:buyer.address,storageAddress,programName,logicalAddress:address,signedListing:agreement,nonce:1,timestamp:NOW});signedProjection.content.from_ed25519_address=buyer.address;Object.assign(signedProjection.content.data[1].metadata,{artifactKind:'Agreement',contentHash:core.contentHash(agreement),envelopeHash:core.sha256Hex(core.canonicalize(agreement))});signedProjection.hash=core.sha256Hex(JSON.stringify(signedProjection.content));signedProjection.signature={type:'ed25519',data:'0x'+buyer.sign(Buffer.from(signedProjection.hash)).toString('hex')};
  return{jobId,agreement,signedProjection};
 };
 agent=await create();for(const jobId of JOBS)await negotiate(jobId);
 agent.close();store=await openStore();
 if(paid){for(const jobId of JOBS)await store.withJob(jobId,session=>{session.payment={settlementId:'demos:one',txHash:'a'.repeat(64),deliveredAt:NOW};session.stage='delivered';store.saveSession(session);});await store.withJob(JOBS[0],()=>store.bindSettlement('demos:one',JOBS[0],{jobId:JOBS[0],phaseIndex:2}));if(collision)await store.withJob(JOBS[1],()=>store.bindSettlement('demos:one',JOBS[1],{jobId:JOBS[1],phaseIndex:2}));}
 store.close();agent=await create();store=await openStore();
 return{config,get agent(){return agent;},createAgent:create,buildReport,get store(){return store;},negotiate,seller,buyer,pin,listing,anchors,agreements,controls,protocol,reopen:async()=>{agent.close();store.close();agent=await create();store=await openStore();return agent;},close:()=>{agent.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}
