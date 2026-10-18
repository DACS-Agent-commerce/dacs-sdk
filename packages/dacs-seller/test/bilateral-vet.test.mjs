import test from 'node:test';
import assert from 'node:assert/strict';
import {compositeVerificationAddress,contentHash} from '@kynesyslabs/dacs';
import {fixture,JOBS,recordFor} from './helpers/bilateral-vet-fixture.mjs';

test('two parties authenticate independent verifier signatures and fresh seller sessions, including restart',async()=>{
 const w=fixture(),p=w.provider(),first=w.input(),second=w.input(JOBS[1]);
 for(const input of [first,second])assert.equal((await p.resolveBuyer(input)).disposition,'present');
 assert.equal(w.seen.length,2);assert.notEqual(w.seen[0].identityBundle.sessionNonce,w.seen[1].identityBundle.sessionNonce);
 assert.notEqual(w.seen[0].identityBundle.sessionNonce,w.listing.seller.identity.sessionNonce);
 assert.deepEqual(p.invocations.map(v=>v.record.signature.signer),[w.seller.claim,w.buyer.claim,w.seller.claim,w.buyer.claim]);
 const recovered=await w.provider().recoverBuyer(first);assert.equal(recovered.disposition,'present');
 assert.deepEqual(recovered.value.input.seller.identityBundle,w.seen[0].identityBundle);assert.equal(w.seen.length,2);
});
test('seller-signed seller CVR is rejected by real strict verification before anchoring and during recovery',async()=>{
 const w=fixture();w.controls.wrongSigner=true;const p=w.provider(),input=w.input();
 await assert.rejects(p.resolveBuyer(input),{code:'seller_vet_invalid'});assert.equal(p.contexts.size,0);
 assert.equal(w.records.has(compositeVerificationAddress(JOBS[0],w.seller.claim)),false);
 const good=fixture(),i=good.input();await good.provider().resolveBuyer(i);
 const address=compositeVerificationAddress(JOBS[0],good.seller.claim),row=good.records.get(address);
 row.artifact=await recordFor(good.seen[0],good.seller);row.receipt.contentHash=contentHash(row.artifact);
 assert.equal(await good.provider().recoverBuyer(i),null);
});
test('one buyer-issued seller nonce cannot be reused by another job after restart',async()=>{
 const w=fixture();w.controls.nonce='c'.repeat(64);await w.provider().resolveBuyer(w.input());
 const p=w.provider();await assert.rejects(p.resolveBuyer(w.input(JOBS[1])),{code:'seller_challenge_reused'});assert.equal(p.contexts.size,0);
});
test('a signed decision inconsistent with recomputation never yields context',async()=>{
 const w=fixture();w.controls.decision='fail';const p=w.provider();await assert.rejects(p.resolveBuyer(w.input()),{code:'seller_vet_invalid'});assert.equal(p.contexts.size,0);
});
for(const state of ['unknown','dropped','replaced','reorged'])test(`${state} Vet receipt never yields initial or recovered context`,async()=>{
 const w=fixture(),input=w.input(),p=w.provider();w.controls.receiptState=state;
 await assert.rejects(p.resolveBuyer(input));assert.equal(p.contexts.size,0);assert.equal(await w.provider().recoverBuyer(input),null);
});
for(const receiptVerdict of ['invalid','indeterminate'])test(`${receiptVerdict} SR-2 verification never yields context`,async()=>{
 const w=fixture();w.controls.receiptVerdict=receiptVerdict;const p=w.provider();await assert.rejects(p.resolveBuyer(w.input()));assert.equal(p.contexts.size,0);
});
test('relay acknowledgement cannot substitute for a verified accepted receipt',async()=>{
 const w=fixture();w.controls.relayOnly=true;const p=w.provider();await assert.rejects(p.resolveBuyer(w.input()));assert.equal(p.contexts.size,0);
});
test('missing buyer verifier refuses before any CVR signature or native effect',async()=>{
 const w=fixture();const {createDevnetDemoAgreementContextProvider}=await import('../src/devnet-demo/agreement-context.mjs');
 const p=createDevnetDemoAgreementContextProvider({anchor:w.anchor,wallet:{claim:w.seller.claim,signBytes:()=>assert.fail('signature')},listing:w.listing,store:w.store});
 assert.equal((await p.resolveBuyer(w.input())).code,'counterparty_vet_required');assert.equal(w.records.size,0);
});

test('an existing context is suspended when fresh receipt readback loses authority',async()=>{
 const w=fixture(),p=w.provider(),input=w.input();await p.resolveBuyer(input);w.controls.receiptState='reorged';
 await assert.rejects(p.resolveBuyer(input),{code:'party_vet_unavailable'});
 assert.equal((await p.resolveSeller({jobId:input.scope.jobId,listingPin:w.listing.pin,buyerIdentityBundle:input.buyerIdentityBundle,generatedAt:input.scope.generatedAt})).disposition,'indeterminate');
});
test('native publisher separates seller writer from buyer CVR verifier with real signatures',async()=>{
 const {anchorFixture}=await import('./helpers/anchor-isolated-fixture.mjs');const w=fixture(),native=await anchorFixture({writer:w.seller}),input={jobId:JOBS[0],identityBundle:w.listing.seller.identity,requirement:w.listing.buyerRequirement};
 const logicalAddress=compositeVerificationAddress(JOBS[0],w.seller.claim);
 await assert.rejects(native.open().publish({logicalAddress,artifact:await recordFor(input,w.seller),artifactKind:'CompositeVerificationRecord'}),{code:'invalid'});assert.equal(native.captured.length,0);
 const record=await recordFor(input,w.buyer);
 assert.equal((await native.open().publish({logicalAddress,artifact:record,artifactKind:'CompositeVerificationRecord',verifier:w.buyer.claim})).status,'indeterminate');
 assert.equal(native.captured.length,1);assert.equal(native.captured[0].owner,w.seller.claim);
});
