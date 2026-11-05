import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DACS_STANDARD_PIN,contentHash} from '@kynesyslabs/dacs';
import {evaluateCompletionReadiness,COMPLETION_READINESS_STANDARD_PIN} from '../src/dacs/completion-readiness.mjs';
import {SDK_PROVENANCE,purchaseSupport} from '../src/dacs/listing.mjs';
import {createListingVerifier} from '../src/dacs/verification.mjs';
import {deliverableAddress,deliveryEvidenceAddress,planAgreement,planAgreementFromInput,exchangeAgreement,DEM_RAIL_DEFINITION} from '../src/dacs/purchase-protocol.mjs';
import {createBuyerChainReadback} from '../src/dacs/buyer-chain-readback.mjs';
import {createDevnetAgreementTransport} from '../src/wallet/devnet-native-transport.mjs';
import {createProtocolPurchases} from '../src/dacs/protocol-purchases.mjs';
import {createSellerAgent} from '../src/dacs/seller-agent.mjs';
// The held buyer API uses the concrete store with an invalid database handle
// and no operator capability; no authority, wallet or native check is mocked.
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';
const noWrites=createSqlitePurchaseStore();
const jobId='01ARZ3NDEKTSV4RRFFQ69G5FAV',seller='did:demos:agent:'+'a'.repeat(64);
const operation={terms:{buyer:{wallet:'0x'+'e'.repeat(64)},seller:{claim:seller},protocol:{jobId,profile:'dacs-chatgpt-plugin/fixed-price-pay-dem/v1'}},state:{protocol:{revision:7,stage:'delivery-ready',agreement:null,commitment:null,paymentEvidence:null,delivery:{report:{jobId}},bundle:null}}};
const view={jobId,profile:operation.terms.protocol.profile,revision:7,stage:'delivery-ready',agreement:null,commitment:null,paymentEvidence:null,delivery:{report:{jobId}},bundle:null};
const row=(o,v,id)=>evaluateCompletionReadiness(o,v).requirements.find(r=>r.id===id);
test('completion diagnostics identify the installed workspace pin and remain held',()=>{
 assert.equal(COMPLETION_READINESS_STANDARD_PIN,DACS_STANDARD_PIN);assert.equal(SDK_PROVENANCE.standardPin,DACS_STANDARD_PIN);assert.match(SDK_PROVENANCE.source,/workspace/);
 assert.equal(row(operation,view,'profile.implementation').status,'present');assert.equal(evaluateCompletionReadiness(operation,view).status,'held');assert.equal(row(operation,view,'profile.completion').code,'profile.not-admitted');
});
test('revision-only stale and not-saved protocol views cannot advertise current delivery',()=>{
 assert.equal(row(operation,view,'protocol.view').status,'present');
 for(const stale of [{...view,revision:6},{...view,notSaved:{savedRevision:8,savedStage:'delivery-ready'}}]) {
  assert.equal(row(operation,stale,'protocol.view').status,'mismatch');assert.notEqual(row(operation,stale,'deliverable.current').status,'present');
 }
});
const grammar=JSON.parse(readFileSync(new URL('./fixtures/job-id-grammar-v0.1.json',import.meta.url)));
for(const v of grammar.vectors.filter(v=>(v.operation==='validate'||v.operation==='lookup-bundle'&&v.expected==='error')))test(`JID-1 address grammar ${v.name}`,()=>{
 for(const fn of [deliverableAddress,deliveryEvidenceAddress]) {
  if(v.expected==='pass')assert.ok(fn(v.jobId).endsWith(':'+v.jobId));else assert.throws(()=>fn(v.jobId),/canonical JID-1/);
 }
});
test('malformed JIDs stop all reader entries before resolution',async()=>{
 let reads=0;
 const source=createDevnetAgreementTransport({expected:{network:'testnet',chainIdentity:'f'.repeat(64),pinVersion:'TEST-1',endpoint:'https://rpc.invalid/',transportAuthority:'TEST-owner'},transportOwner:{getContext(){reads++;throw Error('unexpected');},acquireConnectionFence(){reads++;throw Error('unexpected');}},journal:{get:async()=>null,put:async()=>{throw Error('write');},entries:async()=>[],withWalletLock:(_k,w)=>w()}});
 const reader=createBuyerChainReadback({sourceCapability:source,reader:{read:async()=>{reads++;throw Error('unexpected');},verifyReceipt:async()=>{reads++;throw Error('unexpected');}}});
 for(const v of grammar.vectors.filter(v=>(v.operation==='validate'||v.operation==='lookup-bundle'&&v.expected==='error')&&v.expected!=='pass')) {
  const args={jobId:v.jobId,agreement:{jobId:v.jobId},listing:{seller:{identity:{presentedBy:seller}}},seller};
  for(const name of ['readCommitment','readDeliverable','readDeliveryEvidence'])assert.equal((await reader[name](args)).status,'indeterminate');
 }assert.equal(reads,0);
});
const refused=e=>e.code==='profile_not_admitted';
for(const authority of [undefined,{}, {standardRevision:'old'}, {standardRevision:DACS_STANDARD_PIN}, [{standardRevision:DACS_STANDARD_PIN},{standardRevision:DACS_STANDARD_PIN}]])test('profile candidate refuses caller-supplied/missing/mismatched/duplicate authority before effects '+JSON.stringify(authority),async()=>{
 let effects=0;const effect=()=>{effects++;throw Error('effect');};
 const buyer=createProtocolPurchases({db:{},ops:{},coordinates:{},dacsProtocol:{profileAuthority:authority},fetchImpl:effect,store:noWrites});
 assert.equal(buyer.available,false);assert.equal(buyer.actionsAdmitted,false);
 for(const method of ['prepareTerms','identityRequest','signRequest','withNativePaymentLane','readNativePaymentLane'])assert.throws(()=>buyer[method]({},effect),refused);
 await assert.rejects(buyer.planRequest({}),refused);
 await assert.rejects(buyer.submitAgreement({}),refused);
 await assert.rejects(buyer.recheck({}),refused);
 await assert.rejects(buyer.recheckCommitment({}),refused);
 assert.throws(()=>planAgreement({}),refused);assert.throws(()=>planAgreementFromInput({}),refused);
 await assert.rejects(exchangeAgreement({seller:{propose:effect},anchorAdapter:{write:effect}}),refused);
 await assert.rejects(createSellerAgent({signer:{sign:effect},profileAuthority:authority}),refused);
 assert.equal(effects,0);
});
const capture=JSON.parse(readFileSync(new URL('./fixtures/live-directory-market-report.json',import.meta.url)));
for(const availability of [undefined,'disabled','failed','mocked','live'])test(`rail ${availability} cannot enable purchase without authoritative status`,async()=>{
 const listing=structuredClone(capture.storageProgram.data);// Caller-supplied availability cannot authenticate rail registry state.
 const authority={availability};
 assert.equal(purchaseSupport(listing,{railAuthority:authority}).supported,false);assert.equal(DEM_RAIL_DEFINITION.availability,'disabled');
 const directory={findSummary:async()=>capture.summary,getListingDetail:async()=>listing},chain={readStorageProgram:async()=>({status:'found',...capture.storageProgram})};
 const r=await createListingVerifier({directory,chain,railAuthority:authority,now:()=>Date.parse(capture.capturedAt)}).verify({listingId:listing.listingId,version:listing.listingVersion,seller:listing.seller.identity.presentedBy});
 assert.equal(r.transactable,false);
});
