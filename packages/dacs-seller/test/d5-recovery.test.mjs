import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {identityBundleHash} from '@kynesyslabs/dacs';
import {world,T,JOBS} from './helpers/d5-http-fixture.mjs';
const {createSellerTransportClientAuth,SELLER_CONTEXT_PATH,sellerContextScopeHash}=await import('../src/dacs/seller-transport-auth.mjs');
const {proposalTimeProblem}=await import('../src/dacs/seller-proposal-time.mjs');

test('R1 only the exact admitted request extends proposal time, and the Agreement deadline remains exclusive',async t=>{
 const w=await world(t),input=await w.wire(),body=JSON.parse(input.text),request=w.auth.readRequest(input.header);
 const {createSellerContextRecords}=await import('../src/dacs/seller-context-route.mjs');
 const records=createSellerContextRecords({listing:w.listing,store:()=>w.store});
 // Actual admission record and exact-request predicate, then the helper used by the agent.
 const reservation=await w.route.reserve(request,body,w.store);assert.equal(reservation.disposition,'perform');
 const exact={jobId:JOBS[0],buyerBundle:body.buyerIdentityBundle,generatedAt:T};assert.equal(records.exactRequest(exact),true);
 const observedAt=T+600001,deadlineSecAfterCommit=1200;
 assert.equal(proposalTimeProblem({generatedAt:T,observedAt,deadlineSecAfterCommit,admitted:records.exactRequest(exact)}),null);
 for(const changed of [{...exact,generatedAt:T+1},{...exact,buyerBundle:{...exact.buyerBundle,sessionNonce:'f'.repeat(64)}}]){
  assert.equal(records.exactRequest(changed),false);assert.match(proposalTimeProblem({generatedAt:T,observedAt,deadlineSecAfterCommit,admitted:records.exactRequest(changed)}),/clock window/);
 }
 assert.match(proposalTimeProblem({generatedAt:T,observedAt:T+1200000,deadlineSecAfterCommit,admitted:true}),/deadline/);
});

async function restartFixture(t){
 const w=await world(t),body=JSON.parse((await w.wire()).text),directory=await mkdtemp(join(tmpdir(),'TEST-context-restart-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const {testWallet}=await import('./helpers/protocol-fixture.mjs');const {privateKeyFromSeed}=await import('@kynesyslabs/dacs');const {fixtureListing}=await import('./fixtures/listings.mjs');const {listingPin}=await import('../src/dacs/purchase-protocol.mjs');
 const signer=testWallet(17),buyer=testWallet(12),listing=fixtureListing(signer,{now:T}),pin=listingPin(listing);
 body.scope.buyer=buyer.claim;body.scope.wallet=buyer.address;body.scope.seller=signer.claim;body.scope.payee=signer.address;body.scope.listingPin=pin;
 body.buyerIdentityBundle={bundleVersion:'1',presentedBy:buyer.claim,presentedAt:T,sessionNonce:'e'.repeat(64),claims:[{ref:buyer.claim}],presentation:{kind:'per-claim',signatures:[{ref:buyer.claim,signature:'pending'}]}};
 const {createSellerTransportStore,sellerContextChallengeScope}=await import('../src/dacs/seller-transport-auth.mjs');const transport=createSellerTransportStore({path:join(directory,'transport.sqlite'),now:()=>T});
 body.buyerIdentityBundle.sessionNonce=transport.issueContextChallenge({jobId:body.scope.jobId,buyer:buyer.claim},sellerContextChallengeScope(body.scope),{admit:()=>T}).sessionNonce;transport.close();
 body.scope.buyerBundleHash=identityBundleHash(body.buyerIdentityBundle);body.buyerIdentityBundle.presentation.signatures[0].signature=buyer.signBytes(Buffer.from('dacs-bundle-presentation:v1:'+body.scope.buyerBundleHash)).toString('base64url');
 const text=JSON.stringify(body),client=createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:signer.claim,resolveJob:()=>({listingPin:pin,agreementHash:sellerContextScopeHash(body.scope)}),now:()=>T}),header=(await client.request(SELLER_CONTEXT_PATH,body,text)).header;
 const key=(wallet,tag)=>({claim:wallet.claim,privateKey:privateKeyFromSeed(new Uint8Array(32).fill(tag)).export({format:'pem',type:'pkcs8'})});
 await writeFile(join(directory,'config.json'),JSON.stringify({time:T,buyer:key(buyer,12),seller:key(signer,17),listing,pin,input:{text,header}}),{mode:0o600});
 const run=phase=>{const result=spawnSync(process.execPath,[new URL('./helpers/d5-restart-process.mjs',import.meta.url).pathname,directory,phase],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
 return{run,body};
}
test('R2 two processes resume one unsigned CREATE using the real provider without a second signed record',async t=>{
 const {run,body}=await restartFixture(t);const cut=run('cut');assert.equal(cut.status,503,JSON.stringify(cut));assert.equal(cut.creates.length,1);assert.equal(cut.signatures.length,2);assert.equal(cut.after.scopeHash,sellerContextScopeHash(body.scope));
 const unknown=run('unknown');assert.equal(unknown.status,503);assert.equal(unknown.holds.length,0);assert.equal(unknown.resumeCount,0);assert.deepEqual(unknown.creates,cut.creates);assert.deepEqual(unknown.signatures,cut.signatures);
 const resumed=run('resume');assert.equal(resumed.status,200,JSON.stringify(resumed));assert.equal(resumed.answer.disposition,'present');assert.equal(resumed.retryStatus,200);assert.equal(resumed.resumeCount,1);assert.equal(resumed.holds.length,1);assert.equal(resumed.holds[0].writes,1);assert.deepEqual(resumed.before,cut.after);assert.deepEqual(resumed.after,cut.after);assert.equal(new Set(resumed.creates).size,2);assert.equal(resumed.creates.length,2);assert.equal(resumed.signatures.length,2);
 const readback=run('resume');assert.equal(readback.status,200);assert.equal(readback.holds.length,0);assert.equal(readback.resumeCount,0);assert.deepEqual(readback.creates,resumed.creates);assert.deepEqual(readback.signatures,resumed.signatures);
});
test('R3 lost HTTP finish after both Vet writes recovers read-only in a fresh process',async t=>{
 const {run}=await restartFixture(t),lost=run('lost');assert.equal(lost.status,503,JSON.stringify(lost));assert.equal(lost.creates.length,2);assert.equal(lost.signatures.length,2);
 const recovered=run('resume');assert.equal(recovered.status,200,JSON.stringify(recovered));assert.equal(recovered.answer.disposition,'present');assert.equal(recovered.holds.length,0);assert.equal(recovered.resumeCount,0);assert.deepEqual(recovered.creates,lost.creates);assert.deepEqual(recovered.signatures,lost.signatures);
});
