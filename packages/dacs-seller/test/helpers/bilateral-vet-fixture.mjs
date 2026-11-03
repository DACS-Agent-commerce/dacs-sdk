import './d5-isolated-dependencies.mjs';
import {generateKeyPairSync,sign,randomBytes,verify} from 'node:crypto';
import {contentHash,identityBundleHash,sha256Hex,canonicalize,signComponentArtifact} from '@kynesyslabs/dacs';
const {createDevnetDemoAgreementContextProvider}=await import('../../src/devnet-demo/agreement-context.mjs');
const {createInMemoryPartyVetStore}=await import('../../src/devnet-demo/party-vet-store.mjs');
export const T=1800000000000,JOBS=['01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAX'];
export function key(){const pair=generateKeyPairSync('ed25519');return {claim:'did:demos:agent:'+pair.publicKey.export({type:'spki',format:'der'}).subarray(12).toString('hex'),sign:bytes=>sign(null,bytes,pair.privateKey),publicKey:pair.publicKey,privateKey:pair.privateKey};}
export function bundleFor(signer,nonce=randomBytes(32).toString('hex')){const value={bundleVersion:'1',presentedBy:signer.claim,presentedAt:T,sessionNonce:nonce,claims:[{ref:signer.claim}]};return {...value,presentation:{kind:'per-claim',signatures:[{ref:signer.claim,signature:signer.sign(Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(value)}`)).toString('base64url')}]}};}
export function recordFor({jobId,identityBundle,requirement},signer,overallDecision='pass'){
 return signComponentArtifact({recordVersion:'1',jobId,evaluatedParty:identityBundle.presentedBy,bundleHash:identityBundleHash(identityBundle),requirementHash:sha256Hex(canonicalize(requirement)),freshness:[],supplementary:[],dealSpecific:[],overallDecision,generatedAt:T},'dacs-composite:v1:',{algorithm:'ed25519',signer:signer.claim,sign:bytes=>signer.sign(bytes)});
}
export function fixture({maxJobs}={}){
 const seller=key(),buyer=key(),records=new Map(),store=createInMemoryPartyVetStore({maxJobs}),seen=[],nonces=new Set();
 const controls={receiptState:'finalized',receiptVerdict:'valid',wrongSigner:false,decision:'pass',nonce:null,relayOnly:false};
 const listing={seller:{identity:bundleFor(seller)},pin:{listingId:'bilateral',version:1,contentHash:'b'.repeat(64)},payee:'0x'+seller.claim.slice(16),price:{amount:'1',currency:'DEM'},buyerRequirement:{requirementVersion:'1',required:[],preferredPresentation:'any'}};
 const anchor={writer:seller.claim,hasIntent:async address=>records.has(address),readRetained:async({logicalAddress})=>{const row=records.get(logicalAddress);return row?{...structuredClone(row),receipt:{...row.receipt,state:controls.receiptState}}:{status:'absent'};},read:async input=>anchor.readRetained(input),verifyReceipt:async()=>controls.receiptVerdict,publish:async({logicalAddress,artifact})=>{
  if(controls.relayOnly)return {status:'indeterminate',reason:'validator relay acknowledgement'};
  if(records.has(logicalAddress))return records.get(logicalAddress);
  const hash=contentHash(artifact),receipt={receiptVersion:'1',substrate:'fixture',finalityProfile:'fixture',logicalAddress,nativeAddress:logicalAddress,contentHash:hash,transactionRef:{kind:'fixture',value:hash},writer:seller.claim,state:controls.receiptState,observationDisposition:'established',observedAt:T,blockRef:{id:'fixture'},evidence:{kind:'fixture',value:'local'}};
  const row={status:'present',artifact:structuredClone(artifact),receipt};records.set(logicalAddress,row);return row;
 }};
 const counterparty={issueChallenge:async({jobId})=>({issuer:buyer.claim,seller:seller.claim,jobId,sessionNonce:controls.nonce??randomBytes(32).toString('hex'),expiresAt:T+60000}),evaluate:async input=>{
  // The actual buyer verifier consumes its nonce BEFORE presentation checks.
  const nonce=input.identityBundle.sessionNonce;assertFresh(nonce);nonces.add(nonce);
  if(!verify(null,Buffer.from(`dacs-bundle-presentation:v1:${identityBundleHash(input.identityBundle)}`),seller.publicKey,Buffer.from(input.identityBundle.presentation.signatures[0].signature,'base64url')))throw new Error('seller presentation invalid');
  seen.push(structuredClone(input));return recordFor(input,controls.wrongSigner?seller:buyer,controls.decision);
 }};
 function assertFresh(nonce){if(nonces.has(nonce))throw new Error('buyer challenge consumed');}
 const provider=()=>createDevnetDemoAgreementContextProvider({anchor,wallet:{claim:seller.claim,signBytes:seller.sign},listing,store,counterparty,now:()=>T,log:()=>{}});
 const input=(jobId=JOBS[0])=>({scope:{jobId,buyer:buyer.claim,seller:seller.claim,generatedAt:T,payee:listing.payee,listingPin:listing.pin,price:listing.price},buyerIdentityBundle:bundleFor(buyer)});
 return {seller,buyer,listing,store,anchor,controls,records,seen,provider,input,counterparty};
}
