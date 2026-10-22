import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateCanonicalJobId, identityBundleHash } from '@kynesyslabs/dacs';
import { startDevnetLiveCompositionTransport } from './helpers/devnet-live-composition-transport.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { fixtureListing } from './fixtures/listings.mjs';
import { createDevnetDemoComposition } from '../src/devnet-demo/composition.mjs';
import { createNativePaymentEvidenceConsumer } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { createSellerSr2AgreementAnchor } from '../src/dacs/seller-sr2-agreement-consumer.mjs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../src/dacs/demos-sr2-adapter.mjs';
import { createSourceDemoSellerTransport } from '../src/dacs/source-demo-seller-transport.mjs';
import { DEM_RAIL } from '../src/dacs/listing.mjs';
import { createInMemoryPartyVetStore } from '../src/devnet-demo/party-vet-store.mjs';

function memoryJournal(){const rows=new Map(),tails=new Map();return{get:async(k)=>structuredClone(rows.get(k)??null),put:async(k,v)=>rows.set(k,structuredClone(v)),entries:async()=>[...rows.entries()].map(([k,v])=>[k,structuredClone(v)]),async withWalletLock(k,work){const prior=tails.get(k)??Promise.resolve();let release;const next=new Promise(r=>release=r);tails.set(k,next);await prior;try{return await work();}finally{release();if(tails.get(k)===next)tails.delete(k);}}};}
const railAuthority=()=>({trustPhase:'PA-1',trustPolicyAcceptsPA1:true,registry:{state:'not-used',entries:[],definitions:[]},inCodeDefinitions:[{railId:DEM_RAIL.railId,railVersion:DEM_RAIL.railVersion,phaseHandler:'pay-dem',governanceAnchoring:'in-code',signatureValid:true}]});

test('devnet composition publishes its SDK Listing, produces both real party Vet records, and injects the genuine report path',{timeout:120000},async t=>{
  const harness=await startDevnetLiveCompositionTransport();t.after(()=>harness.close());globalThis.location=new URL(harness.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${harness.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  const profile=harness.capability.profile(harness.origin),transport=createDevnetAgreementWalletTransport(profile);
  const seller=await createEphemeralPackagedSeller({network:'demos-devnet',transactionTransport:transport});t.after(()=>seller.close());
  const buyer=await createEphemeralPackagedSeller({network:'demos-devnet',transactionTransport:transport});t.after(()=>buyer.close());
  const base=fixtureListing(seller.signer,{listingId:'native-composed-report',version:1,now:Date.now()-1000,notAfter:Date.now()+86400000});
  const {signature:_signature,...listingDraft}=base;listingDraft.offering={...listingDraft.offering,title:'Fresh Node2 purchased report',description:'A newly produced report bound to one fixed-price DEM purchase.',tags:['report','devnet']};
  const publicJournal=memoryJournal(),dir=mkdtempSync(join(tmpdir(),'devnet-composition-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  let anchor;
  const nativePaymentEvidence=createNativePaymentEvidenceConsumer({rpcUrl:harness.capability.pins.endpoint,sourceCapability:harness.capability,
    anchorEvidence:(input)=>anchor.publish({logicalAddress:input.logicalAddress,artifact:input.artifact,artifactKind:'SettlementEvidence'}),
    readSignedProjection:async()=>undefined});
  const reader=createDemosSr2Adapter({rpcUrl:harness.capability.pins.endpoint,sourceCapability:harness.capability,journal:createInMemoryDemosSr2Journal()});
  const agreementAnchor=createSellerSr2AgreementAnchor({reader});
  const sellerTransport=createSourceDemoSellerTransport({authority:'TEST-RUN-native-demo-001',authenticationFor:()=>({request:async()=>({}),verifyResponse:async()=>true})});
  const composition=await createDevnetDemoComposition({buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true}),authority:harness.authority,sourceCapability:harness.capability,publicJournal,partyVetStore:createInMemoryPartyVetStore(),sellerWalletFactory:seller.walletFactory,
    sellerSigner:{claim:seller.signer.claim,sign:(bytes)=>seller.signer.signBytes(bytes)},listingDraft,
    scanOwnListings:async(prefix)=>{const answer=await harness.capability.readRpc('/',{method:'nodeCall',params:[{message:'searchStoragePrograms',data:{query:prefix,options:{exactMatch:false,limit:50,offset:0}}}]});assert.equal(answer.result,200);assert.deepEqual(answer.response,[]);return{status:'ok',anchors:[]};},
    loadRailResolution:railAuthority,agreementAnchor,nativePaymentEvidence,sellerTransport,sellerEndpoint:()=>null,durableDirectory:join(dir,'seller'),
    observeDemosTransfer:(hash)=>harness.capability.chainReader().observeTransfer(hash),producePurchasedContent:({settlementId})=>`Fresh purchased report for ${settlementId}.`});
  anchor=composition.anchor;
  assert.equal(composition.listing.offering.title,'Fresh Node2 purchased report');assert.equal(composition.published.listingPin.listingId,'native-composed-report');
  const buyerBundle=fixtureListing(buyer.signer,{listingId:'buyer-identity-source',now:Date.now()-1000,notAfter:Date.now()+86400000}).seller.identity;
  const jobId=generateCanonicalJobId(),generatedAt=Date.now(),scope={jobId,buyer:buyer.signer.claim,buyerBundleHash:identityBundleHash(buyerBundle),seller:seller.signer.claim,
    listingPin:composition.published.listingPin,rail:{railId:DEM_RAIL.railId,railVersion:DEM_RAIL.railVersion},payee:seller.signer.address,generatedAt};
  const buyerContext=await composition.contextProvider.resolveBuyer({scope,buyerIdentityBundle:buyerBundle});assert.equal(buyerContext.disposition,'present',JSON.stringify(buyerContext));
  const sellerContext=await composition.contextProvider.resolveSeller({jobId,listingPin:composition.published.listingPin,buyerIdentityBundle:buyerBundle,generatedAt});assert.equal(sellerContext.disposition,'present',JSON.stringify(sellerContext));
  assert.deepEqual(composition.contextProvider.invocations.map(v=>v.evaluatedParty).sort(),[buyer.signer.claim,seller.signer.claim].sort());
  assert.ok(composition.contextProvider.invocations.every(v=>v.strictStatus==='valid'));
  const agreement={jobId,listingRef:composition.published.listingPin},report=composition.deliverableProducer({agreement,listing:composition.listing,settlementId:'demos:composition-control'});
  assert.equal(report.kind,'dacs-chatgpt-plugin/devnet-purchased-report');assert.match(report.content.text,/Fresh purchased report/);assert.doesNotMatch(report.content.text,/fixture/i);
  assert.equal(harness.chain.wire.record.accepted.length,3);assert.equal(seller.approvals.length,3);
  t.diagnostic(JSON.stringify({listingCreates:1,partyVetInvocations:2,strictVet:composition.contextProvider.invocations.map(v=>v.strictStatus),fixtureFallback:false,deliverableKind:report.kind,finality:composition.limits.finality}));
});
