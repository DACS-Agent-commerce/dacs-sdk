import ts from 'typescript';
import { ARTIFACT_SEPARATORS, canonicalize, contentHash, identityBundleHash, sha256Hex, signComponentArtifact } from '@kynesyslabs/dacs';
import { privateModule } from './private-module.mjs';
import { buyer, seller, JOB, NOW } from './protocol-fixture.mjs';
import { fixtureIdentityBundle, fixtureListing } from '../fixtures/listings.mjs';
import { localAnchor } from './local-anchor-fixture.mjs';
import { signAnchorWrite, verifyFixtureReceipt } from '../../src/dacs/fixture-anchors.mjs';
import { createInMemoryPartyVetStore } from '../../src/devnet-demo/party-vet-store.mjs';
import { listingPin } from '../../src/dacs/purchase-protocol.mjs';
const url=new URL('../../src/devnet-demo/agreement-context.mjs',import.meta.url);
export async function stagedProvider(config){
 const module=await privateModule(url,[],source=>{
  source=source.replace('  throw new Error("Vet context is not assembled");\n','');
  const file=ts.createSourceFile('vet.mjs',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
  const factory=file.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='createDevnetDemoAgreementContextProvider');
  if(!factory?.body)throw new Error('TEST staged factory missing');
  const returned=factory.body.statements.filter(ts.isReturnStatement).at(-1),members='jobVet,sellerSession,produceSeller,state';
  return returned?source.slice(0,returned.getStart(file))+`return {...(${returned.expression.getText(file)}),${members}};`+source.slice(returned.end)
   :source.slice(0,factory.body.end-1)+`return {${members}};\n`+source.slice(factory.body.end-1);
 });
 return module.createDevnetDemoAgreementContextProvider(config);
}
export async function recordFor(input,signer=buyer,decision='pass',claim=signer.claim){
 return signComponentArtifact({recordVersion:'1',jobId:input.jobId,evaluatedParty:input.identityBundle.presentedBy,bundleHash:identityBundleHash(input.identityBundle),requirementHash:sha256Hex(canonicalize(input.requirement)),freshness:[],supplementary:[],dealSpecific:[],overallDecision:decision,generatedAt:NOW},ARTIFACT_SEPARATORS.CompositeVerificationRecord,{signer:claim,algorithm:'ed25519',sign:signer.signBytes});
}
export function productionFixture(options={}){
 const base=createInMemoryPartyVetStore(options),local=localAnchor({now:()=>NOW}),seen=[],issued=new Map(),evaluations=new Map();let nonceSequence=0;
 const controls={nonce:null,wrongSigner:false,qualifiedSigner:false,decision:'pass',receiptState:'finalized',receiptVerdict:null,failCounterpartySave:false,relayOnly:false,signs:0,presentationSigns:0};
 const store={...base,update:(key,change)=>base.update(key,(old,rows)=>{const next=change(old,rows);if(controls.failCounterpartySave&&!old?.counterpartyRecord&&next?.counterpartyRecord){controls.failCounterpartySave=false;throw new Error('TEST counterparty checkpoint lost');}return next;})};
 const listing=fixtureListing(seller,{now:NOW}),pin=listingPin(listing);
 const anchor={writer:seller.claim,hasIntent:async address=>local.rows.has(address),readRetained:async({logicalAddress})=>{const row=await local.read(logicalAddress);return row.status==='present'?{...row,receipt:{...row.receipt,state:controls.receiptStateFor?.(logicalAddress)??controls.receiptState}}:row;},read:input=>anchor.readRetained(input),
  verifyReceipt:async({receipt,logicalAddress,artifact})=>controls.receiptVerdict??verifyFixtureReceipt({receipt,logicalAddress,hash:contentHash(artifact),expectedWriter:seller.claim}),
  publish:async({logicalAddress,artifact})=>{if(controls.relayOnly)return{status:'indeterminate',reason:'TEST relay only'};if(!local.rows.has(logicalAddress))await local.write({logicalAddress,artifact,writer:seller.claim,writerSignature:signAnchorWrite(seller.signBytes,logicalAddress,contentHash(artifact))});return anchor.readRetained({logicalAddress});}};
 const evaluationKey=input=>sha256Hex(canonicalize([input.jobId,identityBundleHash(input.identityBundle),sha256Hex(canonicalize(input.requirement))]));
 const consumed=new Set(),expiries=new Map();
 const counterparty={
  issueChallenge:async({jobId})=>{const sessionNonce=controls.nonce??sha256Hex('TEST nonce '+jobId+ ++nonceSequence);issued.set(`${jobId}/${sessionNonce}`,true);const expiresAt=config.now()+(controls.challengeLifetime??60000);expiries.set(sessionNonce,expiresAt);return{issuer:buyer.claim,seller:seller.claim,jobId,sessionNonce,expiresAt};},
  readRecord:async input=>{const record=evaluations.get(evaluationKey(input));if(record)return{status:'present',record:structuredClone(record)};return issued.has(`${input.jobId}/${input.identityBundle.sessionNonce}`)&&!consumed.has(input.identityBundle.sessionNonce)?{status:'unattempted',issuer:buyer.claim,jobId:input.jobId,bundleHash:identityBundleHash(input.identityBundle),requirementHash:sha256Hex(canonicalize(input.requirement))}:{status:'indeterminate'};},
  evaluate:async input=>{const nonce=input.identityBundle.sessionNonce;if(consumed.has(nonce))throw new Error('TEST buyer challenge already consumed');consumed.add(nonce);seen.push(structuredClone(input));if(config.now()+(controls.buyerSkew??0)>expiries.get(nonce))throw new Error('TEST expired challenge');const signer=controls.wrongSigner?seller:buyer;const record=await recordFor(input,signer,controls.decision,controls.qualifiedSigner?signer.claim+'?region=GB':signer.claim);evaluations.set(evaluationKey(input),record);return record;},
 };
 const config={anchor,wallet:{claim:seller.claim,signBytes:bytes=>{controls.signs++;if(Buffer.from(bytes).toString().startsWith('dacs-bundle-presentation:v1:'))controls.presentationSigns++;return seller.signBytes(bytes);}},listing,store,counterparty,now:()=>NOW,log:()=>{}};
 const input=(jobId=JOB)=>({scope:{jobId,buyer:buyer.claim,seller:seller.claim,generatedAt:NOW,payee:seller.address,listingPin:pin,price:listing.pricing.price},buyerIdentityBundle:fixtureIdentityBundle(buyer,NOW)});
 return{base,store,local,anchor,counterparty,controls,listing,pin,seen,evaluations,issued,consumed,expiries,input,config,provider:()=>stagedProvider(config),run:async(value=input())=>(await stagedProvider(config)).jobVet(value.scope,value.buyerIdentityBundle,()=>true)};
}
