import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, compositeVerificationAddress, contentHash, finalityCommitmentAddress, generateCanonicalJobId, identityBundleHash, listingAddress, sha256Hex, signComponentArtifact, ARTIFACT_SEPARATORS, FINALITY_COMMITMENT_SEPARATOR } from '@kynesyslabs/dacs';
import { startDevnetLiveCompositionTransport } from './helpers/devnet-live-composition-transport.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { createDevnetDemoArtifactAnchor } from '../src/devnet-demo/artifact-anchor.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { createDevnetPurchasedReportProducer, isDevnetPurchasedReport } from '../src/devnet-demo/deliverable.mjs';
import { fixtureListing } from './fixtures/listings.mjs';

function memoryJournal(){const rows=new Map(),tails=new Map();return{get:async(k)=>structuredClone(rows.get(k)??null),put:async(k,v)=>rows.set(k,structuredClone(v)),entries:async()=>[...rows.entries()].map(([k,v])=>[k,structuredClone(v)]),async withWalletLock(k,work){const prior=tails.get(k)??Promise.resolve();let release;const next=new Promise(r=>release=r);tails.set(k,next);await prior;try{return await work();}finally{release();if(tails.get(k)===next)tails.delete(k);}}};}

test('packaged seller wallet publishes exact signed demo artifacts and purchased bytes once; fresh public readback is the only retry path',{timeout:120000},async t=>{
  let clock=1770000000000;
  const harness=await startDevnetLiveCompositionTransport();t.after(()=>harness.close());globalThis.location=new URL(harness.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${harness.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  const approvals=[],profile=harness.capability.profile(harness.origin),transport=createDevnetAgreementWalletTransport(profile);
  const seller=await createEphemeralPackagedSeller({rpcUrl:`${harness.origin}/portal/api/devnet-native-wallet-rpc`,network:'demos-devnet',transactionTransport:transport,approve:async(request)=>{approvals.push(structuredClone(request));return true;}});t.after(()=>seller.close());
  const journal=memoryJournal(),anchor=createDevnetDemoArtifactAnchor({sourceCapability:harness.capability,journal,walletFactory:seller.walletFactory,network:'demos-devnet',buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true}),now:()=>++clock});
  const signedListing=fixtureListing(seller.signer,{listingId:'native-demo-report',version:1,now:1769999000000,notAfter:1771000000000});
  const listingLogical=listingAddress(seller.signer.claim,signedListing.listingId,1);
  const listing=await anchor.publish({logicalAddress:listingLogical,artifact:signedListing,artifactKind:'Listing'});assert.equal(listing.status,'present',JSON.stringify({listing,journal:await journal.entries(),profile:seller.wallet.getWriteProfile()}));
  const jobId=generateCanonicalJobId(),buyer={claim:`did:demos:agent:${'52'.repeat(32)}`},bundle={bundleVersion:'1',presentedBy:buyer.claim,presentedAt:1769999900000,sessionNonce:'b'.repeat(64),claims:[{ref:buyer.claim}],presentation:{kind:'per-claim',signatures:[{ref:buyer.claim,signature:'A'.repeat(86)}]}};
  const compositeUnsigned={recordVersion:'1',jobId,evaluatedParty:buyer.claim,bundleHash:identityBundleHash(bundle),requirementHash:sha256Hex(canonicalize(signedListing.buyerRequirement)),freshness:[],supplementary:[],dealSpecific:[],overallDecision:'pass',generatedAt:1770000000100};
  const composite=await signComponentArtifact(compositeUnsigned,ARTIFACT_SEPARATORS.CompositeVerificationRecord,{algorithm:'ed25519',signer:seller.signer.claim,sign:(bytes)=>seller.signer.signBytes(bytes)});
  const vet=await anchor.publish({logicalAddress:compositeVerificationAddress(jobId,buyer.claim),artifact:composite,artifactKind:'CompositeVerificationRecord'});assert.equal(vet.status,'present',JSON.stringify(vet));
  const commitmentUnsigned={finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),listingRef:{listingId:signedListing.listingId,version:1,contentHash:contentHash(signedListing)},parties:[buyer.claim,seller.signer.claim],pattern:'fixed-price',createdAt:1770000000200};
  const commitment=await signComponentArtifact(commitmentUnsigned,FINALITY_COMMITMENT_SEPARATOR,{algorithm:'ed25519',signer:seller.signer.claim,sign:(bytes)=>seller.signer.signBytes(bytes)});
  const committed=await anchor.publish({logicalAddress:finalityCommitmentAddress(jobId),artifact:commitment,artifactKind:'FinalityCommitmentRecord'});assert.equal(committed.status,'present',JSON.stringify(committed));
  const agreement={jobId,listingRef:commitmentUnsigned.listingRef};
  const producer=createDevnetPurchasedReportProducer({producer:seller.signer.claim,produce:({settlementId})=>`Purchased Node2 demo report for ${settlementId}.`});
  const report=producer({agreement,listing:signedListing,settlementId:'demos:tx-demo:4'});assert.equal(isDevnetPurchasedReport(report,{jobId,agreementHash:contentHash(agreement),producer:seller.signer.claim}),true);assert.doesNotMatch(report.content.text,/fixture/i);
  const deliveryBinding={version:'1',profile:'dacs-native-delivery-publication/v1',jobId,phase:'deliver-storage-program',phaseIndex:3,listing:report.listing,agreementHash:report.agreementHash,fulfilmentId:'fixture-fulfilment-control',purchaseAmount:{amount:'2.5',currency:'DEM'},payloadHash:contentHash(report)};
  await assert.rejects(anchor.publish({logicalAddress:`dacs4:deliverable:${jobId}`,artifact:report,artifactKind:'Deliverable'}),/exact Agreement, Listing, fulfilment, amount and payload/);
  await assert.rejects(anchor.publish({logicalAddress:`dacs4:deliverable:${jobId}`,artifact:report,artifactKind:'Deliverable',deliveryBinding:{...deliveryBinding,agreementHash:'b'.repeat(64)}}),/exact Agreement, Listing, fulfilment, amount and payload/);
  assert.equal(approvals.length,3);assert.equal(harness.chain.wire.record.accepted.length,3);
  const delivered=await anchor.publish({logicalAddress:`dacs4:deliverable:${jobId}`,artifact:report,artifactKind:'Deliverable',deliveryBinding});assert.equal(delivered.status,'present',JSON.stringify({delivered,errors:harness.errors,lastConfirm:harness.chain.wire.record.confirms.at(-1),broadcastAttempts:harness.chain.wire.record.broadcastAttempts}));
  const broadcasts=harness.chain.wire.record.accepted.length;assert.equal(broadcasts,4);assert.equal(approvals.length,4);assert.ok(approvals.every((request)=>request.content?.action==='immutable DACS storage anchor CREATE'&&request.content?.kind==='devnet-demo-artifact-storage-create'));
  const repeated=await anchor.publish({logicalAddress:`dacs4:deliverable:${jobId}`,artifact:report,artifactKind:'Deliverable',deliveryBinding});assert.equal(repeated.status,'present');assert.equal(harness.chain.wire.record.accepted.length,broadcasts);assert.equal(approvals.length,4);
  for(const result of [listing,vet,committed,delivered]){assert.equal(result.receipt.writer,seller.signer.claim);assert.equal(result.noResend,true);assert.equal(typeof result.signedProjection?.hash,'string');}
  // Count native transaction reads at the owned source endpoint every readback passes.
  const txReads=()=>harness.requests.filter(request=>request==='getTxByHash').length,immutableReads=txReads();assert.ok(immutableReads>0);
  const retainedKinds=[[listingLogical,'Listing'],[compositeVerificationAddress(jobId,buyer.claim),'CompositeVerificationRecord'],[finalityCommitmentAddress(jobId),'FinalityCommitmentRecord']];
  for(const [logicalAddress,artifactKind] of retainedKinds)assert.equal((await anchor.readRetained({logicalAddress,artifactKind})).status,'present');
  assert.equal(txReads(),immutableReads,'verified immutable readbacks reuse their exact proof within the short TTL');
  assert.equal(await anchor.verifyReceipt({logicalAddress:compositeVerificationAddress(jobId,buyer.claim),artifact:composite,artifactKind:'CompositeVerificationRecord',receipt:vet.receipt}),'valid');
  assert.equal(txReads(),immutableReads,'receipt verification reuses only the identical authenticated proof');
  const changedReceipt={...vet.receipt,contentHash:'f'.repeat(64)};
  assert.equal(await anchor.verifyReceipt({logicalAddress:compositeVerificationAddress(jobId,buyer.claim),artifact:composite,artifactKind:'CompositeVerificationRecord',receipt:changedReceipt}),'invalid');
  // fresh (payment-path) reads never reuse a proof.
  assert.equal((await anchor.readRetained({logicalAddress:finalityCommitmentAddress(jobId),artifactKind:'FinalityCommitmentRecord',fresh:true})).status,'present');
  const afterFresh=txReads();assert.ok(afterFresh>immutableReads,'a fresh commitment read goes to the chain');
  assert.equal(await anchor.verifyReceipt({logicalAddress:finalityCommitmentAddress(jobId),artifact:commitment,artifactKind:'FinalityCommitmentRecord',receipt:committed.receipt,fresh:true}),'valid');
  // Nothing, including a Listing, is reused for the whole process: after the TTL every kind reads the chain again.
  clock+=60001;
  for(const [logicalAddress,artifactKind] of retainedKinds){const before=txReads();assert.equal((await anchor.readRetained({logicalAddress,artifactKind})).status,'present');assert.ok(txReads()>before,`${artifactKind} re-read after the TTL`);}
  assert.equal(harness.chain.wire.record.accepted.length,broadcasts);
  t.diagnostic(JSON.stringify({artifacts:['Listing','CompositeVerificationRecord','FinalityCommitmentRecord','Deliverable'],creates:4,approvals:4,repeatedCreates:0,authority:harness.authority,markerRequired:false,finality:'not-established',deliverableKind:report.kind}));
});

test('demo artifact profile is explicit and old Agreement-only capability cannot be relabelled',async()=>{
  const producer=createDevnetPurchasedReportProducer({producer:`did:demos:agent:${'11'.repeat(32)}`,produce:()=> 'actual purchased bytes'});
  const report=producer({agreement:{jobId:generateCanonicalJobId(),listingRef:{listingId:'x',version:1,contentHash:'a'.repeat(64)}},listing:{offering:{title:'x'}},settlementId:'s'});
  assert.equal(report.kind,'dacs-chatgpt-plugin/devnet-purchased-report');assert.throws(()=>createDevnetPurchasedReportProducer({producer:'TEST',produce:()=>''}),/seller identity/);
});
