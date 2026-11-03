// an earlier review, finding 1: the demo anchor's receipt verification checks closed
// access before any cache, binder or receipt read. an earlier review: a caller's
// projection authenticates locally (hash, seller signature, receipt reference)
// and the request is checked locally before either chooses that access check. Offline: an owned loopback
// chain and the real packaged seller wallet; every source request passes the
// harness's TLS endpoint and is counted there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ARTIFACT_SEPARATORS, canonicalize, contentHash, finalityCommitmentAddress, generateCanonicalJobId, listingAddress, sha256Hex, signComponentArtifact, FINALITY_COMMITMENT_SEPARATOR } from '@kynesyslabs/dacs';
import { startDevnetLiveCompositionTransport } from './helpers/devnet-live-composition-transport.mjs';
import { memoryJournal } from './helpers/review-node2-current-coverage-fixture.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { createDevnetDemoArtifactAnchor } from '../src/devnet-demo/artifact-anchor.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { fixtureListing } from './fixtures/listings.mjs';

const custody=createEphemeralWallet(),foreign=createEphemeralWallet();
const closed=(error)=>error.code==='buyer_access_closed';

// Both commitments are published while access is open; then access closes with
// only the custody buyer admitted.
async function fixture(t){
  const h=await startDevnetLiveCompositionTransport();t.after(()=>h.close());
  globalThis.location=new URL(h.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${h.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  const seller=await createEphemeralPackagedSeller({rpcUrl:`${h.origin}/portal/api/devnet-native-wallet-rpc`,network:'demos-devnet',transactionTransport:createDevnetAgreementWalletTransport(h.capability.profile(h.origin))});t.after(()=>seller.close());
  const journal=memoryJournal(),custodyJob=generateCanonicalJobId(),foreignJob=generateCanonicalJobId();
  const commitment=async(jobId,buyer)=>({logicalAddress:finalityCommitmentAddress(jobId),artifactKind:'FinalityCommitmentRecord',artifact:await signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),
    listingRef:{listingId:'closed-receipt-report',version:1,contentHash:'c'.repeat(64)},parties:[buyer.claim,seller.signer.claim],pattern:'fixed-price',createdAt:1770000000200},
    FINALITY_COMMITMENT_SEPARATOR,{algorithm:'ed25519',signer:seller.signer.claim,sign:(bytes)=>seller.signer.signBytes(bytes)})});
  const anchor=(buyerAccess)=>createDevnetDemoArtifactAnchor({sourceCapability:h.capability,journal,walletFactory:seller.walletFactory,network:'demos-devnet',buyerAccess});
  const open=anchor(createOperatorBuyerAccess({openBuyerAccess:true}));
  const foreignInput=await commitment(foreignJob,foreign),custodyInput=await commitment(custodyJob,custody);
  const foreignOut=await open.publish(foreignInput),custodyOut=await open.publish(custodyInput);
  assert.equal(foreignOut.status,'present');assert.equal(custodyOut.status,'present');
  const closedAnchor=anchor(createOperatorBuyerAccess({custodyBuyer:custody.claim,buyerForJob:(job)=>job===custodyJob?custody.address:foreign.address}));
  return {h,seller,open,closedAnchor,foreignInput,foreignOut,custodyInput,custodyOut};
}

test('closed receipt verification refuses a foreign job\'s authentic receipt before any source read',{timeout:300000},async t=>{
  const f=await fixture(t),before=f.h.requests.length;
  const receipt=f.foreignOut.receipt;
  // With the caller's projection (fresh or cache path), with the source's own
  // retained projection, and with no projection retained at all.
  await assert.rejects(f.closedAnchor.verifyReceipt({...f.foreignInput,receipt,signedProjection:f.foreignOut.signedProjection,fresh:true}),closed);
  await assert.rejects(f.closedAnchor.verifyReceipt({...f.foreignInput,receipt,signedProjection:f.foreignOut.signedProjection}),closed);
  await assert.rejects(f.closedAnchor.verifyReceipt({...f.foreignInput,receipt,fresh:true}),closed);
  await assert.rejects(f.closedAnchor.verifyReceipt({...f.foreignInput,receipt:{...receipt,transactionRef:{...receipt.transactionRef,value:'f'.repeat(64)}}}),closed);
  assert.equal(f.h.requests.length,before,'no source read');
});

test('the custody buyer\'s own receipts still verify through a closed anchor',{timeout:300000},async t=>{
  const f=await fixture(t),receipt=f.custodyOut.receipt;
  assert.equal(await f.closedAnchor.verifyReceipt({...f.custodyInput,receipt,signedProjection:f.custodyOut.signedProjection,fresh:true}),'valid');
  const before=f.h.requests.length;
  assert.equal(await f.closedAnchor.verifyReceipt({...f.custodyInput,receipt,fresh:true}),'valid');
  assert.ok(f.h.requests.length>before,'the custody receipt is read back from the source');
  assert.equal(await f.closedAnchor.verifyReceipt({...f.custodyInput,receipt:{...receipt,transactionRef:{...receipt.transactionRef,value:'f'.repeat(64)}}}),'indeterminate');
  // The seller's own Listing (no purchase) still verifies, with and without the caller's projection.
  const artifact=fixtureListing(f.seller.signer,{listingId:'closed-receipt-listing',version:1,now:1769999000000,notAfter:1771000000000});
  const listing={logicalAddress:listingAddress(f.seller.signer.claim,artifact.listingId,1),artifact,artifactKind:'Listing'};
  const published=await f.open.publish(listing);assert.equal(published.status,'present');
  assert.equal(await f.closedAnchor.verifyReceipt({...listing,receipt:published.receipt,signedProjection:published.signedProjection,fresh:true}),'valid');
  assert.equal(await f.closedAnchor.verifyReceipt({...listing,receipt:published.receipt,fresh:true}),'valid');
});

test('a request naming another job or kind than its signed transaction is invalid before any source read',{timeout:300000},async t=>{
  const f=await fixture(t),before=f.h.requests.length;
  const foreignRequest={...f.foreignInput,receipt:f.foreignOut.receipt,fresh:true};
  // The custody job's genuine projection offered for the foreign job's receipt.
  assert.equal(await f.closedAnchor.verifyReceipt({...foreignRequest,signedProjection:f.custodyOut.signedProjection}),'invalid');
  // A projection relabelled as a Listing (which needs no buyer) for the foreign job.
  const relabelled=structuredClone(f.custodyOut.signedProjection),metadata=relabelled.content.data[1].metadata;
  metadata.artifactKind='Listing';metadata.artifactBinding={...metadata.artifactBinding,artifactKind:'Listing',jobId:f.foreignInput.artifact.jobId};
  assert.equal(await f.closedAnchor.verifyReceipt({...foreignRequest,signedProjection:relabelled}),'invalid');
  // The custody job's own projection and receipt, but another artifact kind.
  assert.equal(await f.closedAnchor.verifyReceipt({...f.custodyInput,artifactKind:'CompositeVerificationRecord',receipt:f.custodyOut.receipt,signedProjection:f.custodyOut.signedProjection,fresh:true}),'invalid');
  assert.equal(f.h.requests.length,before,'no source read');
});

const sha=(value)=>createHash('sha256').update(value).digest('hex');
const relabel=(projection,change)=>{const copy=structuredClone(projection);change(copy.content.data[1].metadata);return copy;};

test('a foreign projection relabelled as a Listing is invalid with zero source reads',{timeout:300000},async t=>{
  const f=await fixture(t),before=f.h.requests.length;
  // a review probe: a genuine foreign FinalityCommitmentRecord projection
  // whose metadata alone is relabelled as a Listing, which needs no buyer.
  const relabelled=relabel(f.foreignOut.signedProjection,(metadata)=>{metadata.artifactKind='Listing';metadata.artifactBinding.artifactKind='Listing';});
  assert.equal(await f.closedAnchor.verifyReceipt({...f.foreignInput,artifactKind:'Listing',receipt:f.foreignOut.receipt,signedProjection:relabelled,fresh:true}),'invalid');
  assert.equal(await f.closedAnchor.verifyReceipt({...f.foreignInput,artifactKind:'Listing',receipt:f.foreignOut.receipt,signedProjection:relabelled}),'invalid');
  assert.equal(f.h.requests.length,before,'no source read');
});

test('an unauthenticated projection never chooses the access check',{timeout:300000},async t=>{
  const f=await fixture(t),before=f.h.requests.length;
  const foreignJob=f.foreignInput.artifact.jobId,foreignRequest={...f.foreignInput,receipt:f.foreignOut.receipt,fresh:true};
  // A custody projection relabelled with the foreign job: its hash no longer
  // matches its content, so it is invalid, not checked as the foreign job.
  const custodyAsForeign=relabel(f.custodyOut.signedProjection,(metadata)=>{metadata.artifactBinding.jobId=foreignJob;});
  const custodyReceipt={...f.custodyOut.receipt,transactionRef:{...f.custodyOut.receipt.transactionRef}};
  assert.equal(await f.closedAnchor.verifyReceipt({...foreignRequest,receipt:custodyReceipt,signedProjection:custodyAsForeign}),'invalid','content differs from its hash');
  // The same with its hash recomputed: the seller never signed that hash.
  const rehashed={...custodyAsForeign,hash:sha(JSON.stringify(custodyAsForeign.content))};
  assert.equal(await f.closedAnchor.verifyReceipt({...foreignRequest,receipt:{...custodyReceipt,transactionRef:{...custodyReceipt.transactionRef,value:rehashed.hash}},signedProjection:rehashed}),'invalid','not signed by the seller');
  // A genuine foreign projection with a receipt naming another transaction.
  assert.equal(await f.closedAnchor.verifyReceipt({...foreignRequest,receipt:custodyReceipt,signedProjection:f.foreignOut.signedProjection}),'invalid','receipt names another transaction');
  // Malformed requests, checked before any projection or journal lookup.
  assert.equal(await f.closedAnchor.verifyReceipt({...foreignRequest,writer:f.foreignInput.artifact.signature.signer.replace(/.$/,(c)=>c==='0'?'1':'0')}),'invalid','another writer');
  assert.equal(await f.closedAnchor.verifyReceipt({...foreignRequest,artifactKind:'Listing'}),'invalid','an artifact not of the requested kind');
  assert.equal(await f.closedAnchor.verifyReceipt({...foreignRequest,receipt:{...f.foreignOut.receipt,transactionRef:{kind:'demos-tx'}}}),'invalid','no transaction hash');
  assert.equal(f.h.requests.length,before,'no source read');
  // The authentic foreign projection is still refused as the foreign job.
  await assert.rejects(f.closedAnchor.verifyReceipt({...foreignRequest,signedProjection:f.foreignOut.signedProjection}),closed);
});

// A receipt is caller data too. One naming an authorized transaction, but
// otherwise describing another job's write, must not reach that write.
const forge=(receipt,{txHash,artifact})=>{
  const proof=JSON.parse(Buffer.from(receipt.evidence.value,'base64url').toString('utf8'));
  if(artifact)proof.nativeRead.valueHash=sha256Hex(canonicalize(artifact));
  return {...structuredClone(receipt),...(artifact?{contentHash:contentHash(artifact)}:{}),transactionRef:{...receipt.transactionRef,value:txHash},
    evidence:{...receipt.evidence,value:Buffer.from(canonicalize(proof),'utf8').toString('base64url')}};
};

test('a receipt that borrows an authorized transaction for another job or kind is invalid before any source read',{timeout:300000},async t=>{
  const f=await fixture(t);
  const listingArtifact=fixtureListing(f.seller.signer,{listingId:'closed-receipt-borrowed',version:1,now:1769999000000,notAfter:1771000000000});
  const listing=await f.open.publish({logicalAddress:listingAddress(f.seller.signer.claim,listingArtifact.listingId,1),artifact:listingArtifact,artifactKind:'Listing'});
  assert.equal(listing.status,'present');
  const before=f.h.requests.length;
  // The foreign write's receipt, naming the custody transaction (whose
  // projection is authentic and authorized): another job, so invalid.
  assert.equal(await f.closedAnchor.verifyReceipt({...f.foreignInput,receipt:forge(f.foreignOut.receipt,{txHash:f.custodyOut.signedProjection.hash}),signedProjection:f.custodyOut.signedProjection,fresh:true}),'invalid','another job');
  // The foreign write's address, described as a Deliverable whose job is the
  // Listing's, naming the Listing transaction (which needs no buyer): another kind, so invalid.
  const deliverable={reportVersion:'1',kind:'dacs-chatgpt-plugin/devnet-purchased-report',jobId:`listing:${listingArtifact.listingId}`,producer:f.seller.signer.claim,content:{mediaType:'text/plain; charset=utf-8',text:'borrowed'}};
  assert.equal(await f.closedAnchor.verifyReceipt({logicalAddress:f.foreignInput.logicalAddress,artifact:deliverable,artifactKind:'Deliverable',
    receipt:forge(f.foreignOut.receipt,{txHash:listing.signedProjection.hash,artifact:deliverable}),signedProjection:listing.signedProjection,fresh:true}),'invalid','another kind');
  // A kind this anchor does not publish (its source has no delivery evidence) is invalid with no lookup.
  const evidence=await signComponentArtifact({evidenceVersion:'1',jobId:f.foreignInput.artifact.jobId,phase:'deliver-storage-program',outcome:'success',dacsSdkAuditSourceHash:'d'.repeat(64),deliverableContentHash:'e'.repeat(64),
    deliverableAnchor:{kind:'storage-program',locator:`dacs4:deliverable:${f.foreignInput.artifact.jobId}`},observedAt:1770000000300},ARTIFACT_SEPARATORS.SettlementEvidence,{algorithm:'ed25519',signer:f.seller.signer.claim,sign:(bytes)=>f.seller.signer.signBytes(bytes)});
  assert.equal(await f.closedAnchor.verifyReceipt({logicalAddress:`dacs4:evidence:${f.foreignInput.artifact.jobId}`,artifact:evidence,artifactKind:'SettlementEvidence',receipt:f.foreignOut.receipt,fresh:true}),'invalid','a kind this anchor does not publish');
  assert.equal(f.h.requests.length,before,'no source read');
});
