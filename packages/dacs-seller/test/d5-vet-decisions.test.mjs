// A valid strict-verification result authenticates a record, independently of
// its overallDecision. Stub only those two SDK operations to supply each
// valid non-pass result; run the actual provider and party-Vet state store.
import { privateModule } from './helpers/private-module.mjs';
import * as sdk from '@kynesyslabs/dacs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {compositeVerificationAddress,vetPhaseFailureClass} from '@kynesyslabs/dacs';
const buyer='did:demos:agent:'+'1'.repeat(64),seller='did:demos:agent:'+'2'.repeat(64),jobId='01ARZ3NDEKTSV4RRFFQ69G5FAW';
let decision='pass',nonPassParty=buyer,records=new Map(),madeRequirements=[],strictRequirements=[];
globalThis.__d5Strict=async(_record,expected)=>{strictRequirements.push(structuredClone(expected.requirement));return {status:'valid'}};
globalThis.__d5PartyVet=async (input,deps)=>{
 madeRequirements.push(structuredClone(input.requirement));
 const record={recordVersion:'1',jobId:input.jobId,evaluatedParty:input.evaluatedParty,overallDecision:input.evaluatedParty===nonPassParty?decision:'pass',signature:{signer:seller}};
 const address=compositeVerificationAddress(input.jobId,input.evaluatedParty);
 await deps.operationStore.compareAndSet({operationKey:address,expected:await deps.operationStore.load(address),next:{stage:'complete',record}});
 records.set(address,record);
 return {record,recordRef:{anchor:{kind:'storage-program',locator:'native'},contentHash:'a'.repeat(64),signer:seller},receipt:{nativeAddress:'native'}};
};
const sourceUrl=new URL('../src/devnet-demo/agreement-context.mjs',import.meta.url);
const sdkSource=`export * from ${JSON.stringify(import.meta.resolve('@kynesyslabs/dacs'))};
export const partyVetCore=(...args)=>globalThis.__d5PartyVet(...args);
export const verifyCompositeVerificationRecord=(...args)=>globalThis.__d5Strict(...args);`;
const sdkUrl=`data:text/javascript;base64,${Buffer.from(sdkSource).toString('base64')}`;
const {createDevnetDemoAgreementContextProvider}=await privateModule(sourceUrl,[],source=>source.replace("from '@kynesyslabs/dacs'",`from ${JSON.stringify(sdkUrl)}`));
const {createInMemoryPartyVetStore}=await import('../src/devnet-demo/party-vet-store.mjs');
const stores=new WeakMap();
const {fixtureListing}=await import('./fixtures/listings.mjs');
const {seller:fixtureSeller}=await import('./helpers/protocol-fixture.mjs');
const sdkFixtureListing=fixtureListing(fixtureSeller,{now:1800000000000});sdkFixtureListing.seller.identity={...bundleTemplate()};
function bundleTemplate(){return {presentedBy:seller,bundleVersion:'1',presentedAt:1800000000000,sessionNonce:'b'.repeat(64),claims:[{ref:seller}]};}
const {listingPin:pinFor}=await import('../src/dacs/purchase-protocol.mjs');
const scope={jobId,listingPin:pinFor(sdkFixtureListing),generatedAt:1800000000000,payee:'0x'+'2'.repeat(64)};
const bundle={presentedBy:buyer,bundleVersion:'1',presentedAt:scope.generatedAt,sessionNonce:'a'.repeat(64),claims:[{ref:buyer}],presentation:{kind:'per-claim',signatures:[{ref:buyer,signature:'fixture'}]}};
function provider(buyerRequirement={requirementVersion:'1',required:[],preferredPresentation:'any'}){
 let store=stores.get(records);if(!store){store=createInMemoryPartyVetStore();stores.set(records,store);}
 const counterparty={readRecord:async input=>({status:'unattempted',issuer:buyer,jobId,bundleHash:sdk.identityBundleHash(input.identityBundle),requirementHash:sdk.sha256Hex(sdk.canonicalize(input.requirement))}),issueChallenge:async()=>({issuer:buyer,seller,jobId,sessionNonce:'d'.repeat(64),expiresAt:scope.generatedAt+60000}),evaluate:async input=>{
  madeRequirements.push(structuredClone(input.requirement));
  return {recordVersion:'1',jobId,evaluatedParty:seller,overallDecision:nonPassParty===seller?decision:'pass',signature:{signer:buyer}};
 }};
 const provider=createDevnetDemoAgreementContextProvider({anchor:{writer:seller,hasIntent:async()=>false,verifyReceipt:async()=> 'valid',readRetained:async({logicalAddress})=>records.has(logicalAddress)?({status:'present',artifact:records.get(logicalAddress),receipt:{nativeAddress:'native',state:'finalized',observationDisposition:'established'}}):({status:'absent'}),publish:async({logicalAddress,artifact})=>{records.set(logicalAddress,artifact);return {status:'present',artifact,receipt:{nativeAddress:'native',state:'finalized',observationDisposition:'established'}};}},wallet:{claim:seller,signBytes:()=>Buffer.alloc(64)},listing:{...sdkFixtureListing, buyerRequirement},store,counterparty,now:()=>scope.generatedAt});
 return {...provider,resolveBuyer:(input,options={writable:()=>true})=>provider.resolveBuyer(input,options)};
}
async function retainProofs(){
 const store=stores.get(records),[key]= (await store.entries())[0];
 await store.update(key,row=>{row.ops.buyer.checkpoints={exact:{stage:'complete',record:structuredClone(records.get(compositeVerificationAddress(jobId,buyer)))}};row.counterpartyRecord=structuredClone(records.get(compositeVerificationAddress(jobId,seller)));return row;});
}
for(const party of [buyer,seller])for(const value of ['fail','indeterminate','error'])test(`VPC4 ${party===buyer?'buyer':'seller'} ${value}: valid record never creates initial or recovered context`,async()=>{
 records=new Map();decision=value;nonPassParty=party;const p=provider();
 const answer=await p.resolveBuyer({scope,buyerIdentityBundle:bundle});assert.deepEqual(answer,{disposition:'rejected',code:'party_vet_non_pass',errorClass:value==='fail'?'counterparty':'permanent',reason:`${party===buyer?'buyer':'seller'} Vet decision: ${value}`});assert.equal(p.contexts.size,0);
 // A rejected buyer never starts the seller proof; recovery remains absent.
 if(party===buyer){assert.equal(records.has(compositeVerificationAddress(jobId,seller)),false);assert.equal(await p.recoverBuyer({scope,buyerIdentityBundle:bundle}),null);return;}
 // Supply both authenticated records to the recovery path, retaining the non-pass decision.
 for(const evaluatedParty of [buyer,seller])records.set(compositeVerificationAddress(jobId,evaluatedParty),{recordVersion:'1',jobId,evaluatedParty,overallDecision:evaluatedParty===party?value:'pass',signature:{signer:evaluatedParty===seller?buyer:seller}});
 await retainProofs();assert.deepEqual(await p.recoverBuyer({scope,buyerIdentityBundle:bundle}),answer);assert.equal(p.contexts.size,0);
});
test('VPC4 pass control can produce context and recover it read-only',async()=>{
 records=new Map();decision='pass';const p=provider();assert.equal((await p.resolveBuyer({scope,buyerIdentityBundle:bundle})).disposition,'present');
 const fresh=provider();assert.equal((await fresh.recoverBuyer({scope,buyerIdentityBundle:bundle})).disposition,'present');
});

test('VPC2 initial, retained and recovered contexts keep distinct buyer and explicit empty seller requirements',async()=>{
 records=new Map();decision='pass';madeRequirements=[];strictRequirements=[];
 const buyerRequirement={requirementVersion:'1',required:[{scheme:'key',verificationRequired:false}],preferredPresentation:'any'},empty={requirementVersion:'1',required:[],preferredPresentation:'any'};
 const p=provider(buyerRequirement),boundScope={...scope,listingPin:pinFor({...sdkFixtureListing,buyerRequirement})};await p.resolveBuyer({scope:boundScope,buyerIdentityBundle:bundle});assert.deepEqual(madeRequirements,[buyerRequirement,empty]);assert.deepEqual(strictRequirements,[buyerRequirement,empty,empty,buyerRequirement,empty]);
 const retained=await p.resolveSeller({jobId,listingPin:pinFor({...sdkFixtureListing,buyerRequirement}),buyerIdentityBundle:bundle,generatedAt:scope.generatedAt});assert.deepEqual(retained.value.vetRequirements.map(r=>r.requirement),[buyerRequirement,empty]);
 strictRequirements=[];await provider(buyerRequirement).recoverBuyer({scope:boundScope,buyerIdentityBundle:bundle});assert.deepEqual(strictRequirements,[buyerRequirement,empty]);
});

// The route parses the sole Demos presentation before invoking this profile's
// Vet (B7); attempts:[] invokes no further credential-format parser. Exercise
// the shared mapper's exception explicitly without inventing that provenance
// from a signed CVR's free-text reason or overallDecision alone.
test('VPC4 malformed-counterparty exception changes only fault attribution',()=>{
 for(const value of ['error','indeterminate']){
  assert.equal(vetPhaseFailureClass(value),'permanent');
  assert.equal(vetPhaseFailureClass(value,'counterparty-malformed-presentation'),'counterparty');
 }
 assert.equal(vetPhaseFailureClass('fail','counterparty-malformed-presentation'),'counterparty');
 assert.equal(vetPhaseFailureClass('pass','counterparty-malformed-presentation'),null);
 assert.throws(()=>vetPhaseFailureClass('unknown'),/unknown DACS-2 verification decision/);
 assert.throws(()=>vetPhaseFailureClass('error','unverified-cause'),/unknown Vet phase failure cause/);
});
test('VPC4 an unknown authenticated decision cannot become pass or a classified phase answer',async()=>{
 records=new Map();decision='unknown';nonPassParty=buyer;const p=provider();
 await assert.rejects(p.resolveBuyer({scope,buyerIdentityBundle:bundle}),/unknown DACS-2 verification decision/);
 assert.equal(p.contexts.size,0);
 assert.equal(await p.recoverBuyer({scope,buyerIdentityBundle:bundle}),null);
 assert.equal(p.contexts.size,0);
});

test('a truthy authenticated non-pass recovery result never authorizes a durable seller context',async()=>{
 records=new Map();decision='pass';nonPassParty=buyer;
 assert.equal((await provider().resolveBuyer({scope,buyerIdentityBundle:bundle})).disposition,'present');
 // Simulate a genuine authenticated non-pass record. This test file's strict
 // verifier intentionally accepts it so the disposition check decides alone.
 records.get(compositeVerificationAddress(jobId,seller)).overallDecision='fail';
 const fresh=provider();
 const answer=await fresh.resolveSeller({jobId,listingPin:pinFor({...sdkFixtureListing,buyerRequirement:{requirementVersion:'1',required:[],preferredPresentation:'any'}}),buyerIdentityBundle:bundle,generatedAt:scope.generatedAt});
 assert.equal(answer.disposition,'indeterminate');assert.equal(fresh.contexts.size,0);
});
