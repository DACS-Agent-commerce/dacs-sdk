// Local replacements for host-owned adapters absent from this source snapshot.
// The caller, commitment/payment validators, evidence verifier and bundle
// construction/copy validators are the shipped SDK, using real signatures.
import * as core from '@kynesyslabs/dacs';
import {createPublicKey,verify} from 'node:crypto';
import {fixtureRef,fixtureTxRef,verifyFixtureRecord} from './local-anchor-fixture.mjs';
export const claimKey=claim=>Buffer.from(claim.slice(16),'hex');
export const verifyBytes=(bytes,signature,key)=>verify(null,bytes,createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(key)]),format:'der',type:'spki'}),signature);
export const ed25519Deps={resolvePublicKey:async claim=>claimKey(claim),verify:verifyBytes};
export const verifyComponent=({signedBytes,signature})=>{try{return verifyBytes(signedBytes,Buffer.from(signature.value,'base64url'),claimKey(signature.signer));}catch{return false;}};
export const listingPin=listing=>({listingId:listing.listingId,version:listing.listingVersion,contentHash:core.contentHash(listing)});
export const RAIL_REGISTRY_VERSION=1;
export const DEM_RAIL_DEFINITION={railVersion:1,railId:'demos-native:DEM',railType:'demos-native',asset:{kind:'native-dem',symbol:'DEM',decimals:9},network:{kind:'demos'},phaseHandler:'pay-dem',parameters:{},availability:'live'};
export const agreementInput=({jobId,listing,buyerBundle,generatedAt})=>({jobId,verifiedListing:{disposition:'verified',listing,pin:listingPin(listing)},buyer:{identityBundle:buyerBundle,vetRecordRef:fixtureRef('vet-buyer','d'.repeat(64))},seller:{identityBundle:listing.seller.identity,vetRecordRef:fixtureRef('vet-seller','d'.repeat(64))},selectedRail:{railId:'demos-native:DEM',railVersion:1},payoutBindings:[{railId:'demos-native:DEM',phaseIndex:2,payeeAddress:listing.seller.identity.presentedBy.slice(16)}],generatedAt});
export const contributionVerifier=({signedBytes,party,value})=>verifyComponent({signedBytes,signature:{signer:party,value}})?'valid':'invalid';
export const agreementTerms=agreement=>({listing:agreement.listingRef,price:{...agreement.terms.price,amountOs:'2500000000'},rail:agreement.terms.rail.railId,paymentPhaseIndex:2,payee:agreement.terms.payoutBindings[0].payeeAddress,seller:agreement.parties.find(p=>p.role==='seller').primaryClaim});
export const commitmentSession=agreement=>({jobId:agreement.jobId,listingRef:agreement.listingRef,phaseKind:'commit-payee-bound-agreement',orchestrator:agreementTerms(agreement).seller,...Object.fromEntries(agreement.parties.map(({role,primaryClaim,bundleHash,vetRecordRef})=>[role,{primaryClaim,bundleHash,vetRecordRef}]))});
export const commitmentVerifier=({signedBytes,signer,value})=>verifyComponent({signedBytes,signature:{signer,value}})?'valid':'invalid';
export const commitmentReader=(anchors,writer)=>({resolve:async address=>{const row=await anchors.read(address);return row.status==='present'?{disposition:'present',anchored:{record:row.artifact,nativeAddress:row.receipt.nativeAddress,anchorTxRef:fixtureTxRef(row.receipt),anchorReceipt:row.receipt}}:{disposition:row.status==='absent'?'absent':'indeterminate'};},verifyAnchorReceipt:anchored=>verifyFixtureRecord({status:'present',artifact:anchored.record,receipt:anchored.anchorReceipt},{logicalAddress:anchored.anchorReceipt.logicalAddress,expectedWriter:writer})});
export const deliverableAddress=jobId=>`dacs4:deliverable:${jobId}`;
export const deliveryEvidenceAddress=jobId=>`dacs4:evidence:${jobId}`;
export const bundleAddress=(jobId,role)=>`dacs5:bundle:${jobId}:${role}`;
export function bundleSession({agreement,agreementRef,commitmentRef,payment,delivery,finalisedAt}){
 return {jobId:agreement.jobId,outcome:'completed',listingRef:agreement.listingRef,agreementRef,phaseSummary:[{index:0,kind:'negotiate-fixed-price',outcome:'ok'},{index:1,kind:'commit-payee-bound-agreement',outcome:'ok',attestationRef:commitmentRef},{index:2,kind:'pay-dem',outcome:'ok',attestationRef:payment},{index:3,kind:'deliver-storage-program',outcome:'ok',attestationRef:delivery}],vetRecords:agreement.parties.map(p=>p.vetRecordRef),settlementEvidence:[payment,delivery],recipeRegistryVersion:1,railRegistryVersion:1,finalisedAt,...Object.fromEntries(agreement.parties.map(({role,primaryClaim,bundleHash})=>[role,{primaryClaim,bundleHash}]))};
}
async function copies(facts,signatures){return core.buildTwoSidedBundle({...facts,...Object.fromEntries(['buyer','seller'].map(role=>[role,{...facts[role],signer:()=>signatures?Buffer.from(signatures[role],'base64url'):Buffer.alloc(64)}]))});}
export async function bundleSigningPlan(facts){const copy=(await copies(facts)).sellerCopy,bundleHash=core.attestationBundleHash(copy),payload=core.signedBytes(core.ARTIFACT_SEPARATORS.FaultAttestationBundle,bundleHash);return {bundleHash,payload};}
export async function assembleBundleCopies(facts,signatures){const result=await copies(facts,signatures),problems=[];for(const role of ['buyer','seller']){const verdict=await core.verifyBundleCopy(result[role+'Copy'],role,ed25519Deps);if(!verdict.valid)problems.push(verdict.reason);}return {copies:result,problems};}
export async function verifyAnchoredCopy({record,role,jobId,writer,expectedHash,ownCopy}){
 const reasons=[];
 if(record?.receipt?.state!=='finalized')return {status:'rejected',reasons:['copy is not finalized']};
 if(verifyFixtureRecord(record,{logicalAddress:bundleAddress(jobId,role),expectedWriter:writer})!=='valid')return {status:'rejected',reasons:['copy receipt invalid']};
 const checked=await core.verifyBundleCopy(record.artifact,role,ed25519Deps);
 if(!checked.valid)reasons.push(checked.reason);
 if(core.attestationBundleHash(record.artifact)!==expectedHash)reasons.push('different bundle');
 if(ownCopy&&core.bundlesDiverge(ownCopy,record.artifact))reasons.push('copies diverge');
 return {status:reasons.length?'rejected':'verified',reasons};
}
export async function verifyPaymentEvidence({agreement,record,observed}){
 const terms=agreementTerms(agreement),address=core.paymentEvidenceAddress(agreement.jobId,terms.rail,2);
 if(verifyFixtureRecord(record,{logicalAddress:address,expectedWriter:terms.seller})!=='valid')return {status:'rejected'};
 const verdict=await core.verifySettlementEvidence(record.artifact,{orchestrator:terms.seller,agreement:{amount:terms.price.amount,currency:terms.price.currency},rail:{railId:terms.rail,railType:'demos-native',asset:'DEM',assetSpec:{kind:'native-dem'},network:'demos',networkSpec:{kind:'demos'},handler:'pay-dem'},attestationRef:fixtureRef(address,core.contentHash(record.artifact)),result:{ok:true,txRefs:[{kind:'demos',...observed}]},paymentAddress:{railId:terms.rail,phaseIndex:2}},ed25519Deps);
 return {status:verdict.decision==='pass'?'verified':'rejected',ref:fixtureRef(address,core.contentHash(record.artifact))};
}
export async function verifyDelivery({agreement,deliverable,evidenceRecord}){
 const terms=agreementTerms(agreement),address=deliverableAddress(agreement.jobId),evidenceAddress=deliveryEvidenceAddress(agreement.jobId);
 if(verifyFixtureRecord(deliverable,{logicalAddress:address,expectedWriter:terms.seller})!=='valid'||verifyFixtureRecord(evidenceRecord,{logicalAddress:evidenceAddress,expectedWriter:terms.seller})!=='valid'||evidenceRecord.artifact.deliverableContentHash!==core.sha256Hex(core.canonicalize(deliverable.artifact)))return {status:'rejected'};
 const verdict=await core.verifySettlementEvidence(evidenceRecord.artifact,{orchestrator:terms.seller,agreement:{amount:terms.price.amount,currency:terms.price.currency},attestationRef:fixtureRef(evidenceAddress,core.contentHash(evidenceRecord.artifact)),result:{ok:true},expectedAnchorLocator:address},ed25519Deps);
 return {status:verdict.decision==='pass'?'verified':'rejected',evidenceRef:fixtureRef(evidenceAddress,core.contentHash(evidenceRecord.artifact)),deliverableRef:fixtureRef(address,core.contentHash(deliverable.artifact)),deliveredAt:evidenceRecord.artifact.observedAt};
}
