// A valid strict-verification result authenticates a record, independently of
// its overallDecision. Stub only those two SDK operations to supply each
// valid non-pass result; run the actual provider and party-Vet state store.
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as sdk from '@kynesyslabs/dacs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {compositeVerificationAddress,vetPhaseFailureClass} from '@kynesyslabs/dacs';
import {seller as fixtureSeller} from './helpers/protocol-fixture.mjs';
const buyer='did:demos:agent:'+'1'.repeat(64),seller=fixtureSeller.claim,jobId='01ARZ3NDEKTSV4RRFFQ69G5FAW';
let decision='pass',nonPassParty=buyer,records=new Map(),madeRequirements=[],strictRequirements=[];
globalThis.__d5Strict=async(_record,expected)=>{strictRequirements.push(structuredClone(expected.requirement));return {status:'valid'}};
globalThis.__d5PartyVet=async input=>{
 madeRequirements.push(structuredClone(input.requirement));
 const record={recordVersion:'1',jobId:input.jobId,evaluatedParty:input.evaluatedParty,overallDecision:input.evaluatedParty===nonPassParty?decision:'pass',signature:{signer:seller}};
 records.set(compositeVerificationAddress(input.jobId,input.evaluatedParty),record);
 return {record,recordRef:{anchor:{kind:'storage-program',locator:'native'},contentHash:'a'.repeat(64),signer:seller},receipt:{nativeAddress:'native'}};
};
const sourceUrl=new URL('../src/devnet-demo/agreement-context.mjs',import.meta.url);
const module=new vm.SourceTextModule(await readFile(sourceUrl,'utf8'),{identifier:sourceUrl.href});
await module.link(async specifier=>{
 const values=specifier==='@kynesyslabs/dacs'?{...sdk,partyVetCore:(...args)=>globalThis.__d5PartyVet(...args),verifyCompositeVerificationRecord:(...args)=>globalThis.__d5Strict(...args)}:await import(specifier.startsWith('.')?new URL(specifier,sourceUrl).href:specifier);
 return new vm.SyntheticModule(Object.keys(values),function(){for(const [key,value]of Object.entries(values))this.setExport(key,value);});
});await module.evaluate();
const {createDevnetDemoAgreementContextProvider}=module.namespace;
const {createInMemoryPartyVetStore}=await import('../src/devnet-demo/party-vet-store.mjs');
const stores=new WeakMap();
const {fixtureListing}=await import('./fixtures/listings.mjs');
const sdkFixtureListing=fixtureListing(fixtureSeller,{now:1800000000000});sdkFixtureListing.seller.identity={...bundleTemplate()};
function bundleTemplate(){return {presentedBy:seller,bundleVersion:'1',presentedAt:1800000000000,sessionNonce:'b'.repeat(64),claims:[{ref:seller}]};}
const {listingPin:pinFor}=await import('../src/dacs/purchase-protocol.mjs');
const scope={jobId,generatedAt:1800000000000,payee:fixtureSeller.address};
const bundle={presentedBy:buyer,bundleVersion:'1',presentedAt:scope.generatedAt,sessionNonce:'a'.repeat(64),claims:[{ref:buyer}],presentation:{kind:'per-claim',signatures:[{ref:buyer,signature:'fixture'}]}};
function provider(buyerRequirement={requirementVersion:'1',required:[],preferredPresentation:'any'}){
 let store=stores.get(records);if(!store){store=createInMemoryPartyVetStore();stores.set(records,store);}
 const counterparty={readRecord:async input=>({status:'unattempted',issuer:buyer,jobId,bundleHash:sdk.identityBundleHash(input.identityBundle),requirementHash:sdk.sha256Hex(sdk.canonicalize(input.requirement))}),issueChallenge:async()=>({issuer:buyer,seller,jobId,sessionNonce:'d'.repeat(64),expiresAt:scope.generatedAt+60000}),evaluate:async input=>{
  madeRequirements.push(structuredClone(input.requirement));
  return {recordVersion:'1',jobId,evaluatedParty:seller,overallDecision:nonPassParty===seller?decision:'pass',signature:{signer:buyer}};
 }};
 return createDevnetDemoAgreementContextProvider({anchor:{writer:seller,hasIntent:async()=>false,verifyReceipt:async()=> 'valid',readRetained:async({logicalAddress})=>records.has(logicalAddress)?({status:'present',artifact:records.get(logicalAddress),receipt:{nativeAddress:'native',state:'finalized',observationDisposition:'established'}}):({status:'absent'}),publish:async({logicalAddress,artifact})=>{records.set(logicalAddress,artifact);return {status:'present',artifact,receipt:{nativeAddress:'native',state:'finalized',observationDisposition:'established'}};}},wallet:{claim:seller,signBytes:fixtureSeller.signBytes},listing:{...sdkFixtureListing, buyerRequirement},store,counterparty,now:()=>scope.generatedAt});
}
for(const party of [buyer,seller])for(const value of ['fail','indeterminate','error'])test(`VPC4 ${party===buyer?'buyer':'seller'} ${value}: valid record never creates initial or recovered context`,async()=>{
 records=new Map();decision=value;nonPassParty=party;const p=provider();
 const answer=await p.resolveBuyer({scope,buyerIdentityBundle:bundle});assert.deepEqual(answer,{disposition:'rejected',code:'party_vet_non_pass',errorClass:value==='fail'?'counterparty':'permanent',reason:`${party===buyer?'buyer':'seller'} Vet decision: ${value}`});assert.equal(p.contexts.size,0);
 // Supply both authenticated records to the recovery path, retaining the non-pass decision.
 for(const evaluatedParty of [buyer,seller])records.set(compositeVerificationAddress(jobId,evaluatedParty),{recordVersion:'1',jobId,evaluatedParty,overallDecision:evaluatedParty===party?value:'pass',signature:{signer:evaluatedParty===seller?buyer:seller}});
 assert.deepEqual(await p.recoverBuyer({scope,buyerIdentityBundle:bundle}),answer);assert.equal(p.contexts.size,0);
});
test('VPC4 pass control can produce context and recover it read-only',async()=>{
 records=new Map();decision='pass';const p=provider();assert.equal((await p.resolveBuyer({scope,buyerIdentityBundle:bundle})).disposition,'present');
 const fresh=provider();assert.equal((await fresh.recoverBuyer({scope,buyerIdentityBundle:bundle})).disposition,'present');
});

test('VPC2 initial, retained and recovered contexts keep distinct buyer and explicit empty seller requirements',async()=>{
 records=new Map();decision='pass';madeRequirements=[];strictRequirements=[];
 const buyerRequirement={requirementVersion:'1',required:[{scheme:'key',verificationRequired:false}],preferredPresentation:'any'},empty={requirementVersion:'1',required:[],preferredPresentation:'any'};
 const p=provider(buyerRequirement);await p.resolveBuyer({scope,buyerIdentityBundle:bundle});assert.deepEqual(madeRequirements,[buyerRequirement,empty]);assert.deepEqual(strictRequirements,[buyerRequirement,empty,empty,buyerRequirement,empty]);
 const retained=await p.resolveSeller({jobId,listingPin:pinFor({...sdkFixtureListing,buyerRequirement}),buyerIdentityBundle:bundle,generatedAt:scope.generatedAt});assert.deepEqual(retained.value.vetRequirements.map(r=>r.requirement),[buyerRequirement,empty]);
 strictRequirements=[];await provider(buyerRequirement).recoverBuyer({scope,buyerIdentityBundle:bundle});assert.deepEqual(strictRequirements,[buyerRequirement,empty]);
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
 records.set(compositeVerificationAddress(jobId,buyer),{recordVersion:'1',jobId,evaluatedParty:buyer,overallDecision:'unknown',signature:{signer:seller}});
 await assert.rejects(p.recoverBuyer({scope,buyerIdentityBundle:bundle}),/unknown DACS-2 verification decision/);
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
