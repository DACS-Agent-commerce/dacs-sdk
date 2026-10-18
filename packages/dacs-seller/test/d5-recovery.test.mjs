import './helpers/d5-isolated-dependencies.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {generateKeyPairSync,sign} from 'node:crypto';
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
 const records=createSellerContextRecords({listing:{seller:{identity:{presentedBy:w.seller.claim}},pin:w.pin,payee:body.scope.payee,price:body.scope.price},store:()=>w.store});
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

test('R2 two processes resume one unsigned CREATE using the real provider and SDK without a second signed record',async t=>{
 const w=await world(t),input=await w.wire(),body=JSON.parse(input.text),directory=await mkdtemp(join(tmpdir(),'d5-restart-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const pair=generateKeyPairSync('ed25519'),claim='did:demos:agent:'+pair.publicKey.export({format:'der',type:'spki'}).subarray(12).toString('hex'),signer={claim,sign:bytes=>sign(null,bytes,pair.privateKey)};
 const buyerPair=generateKeyPairSync('ed25519'),buyerClaim='did:demos:agent:'+buyerPair.publicKey.export({format:'der',type:'spki'}).subarray(12).toString('hex'),buyerSigner={claim:buyerClaim,sign:bytes=>sign(null,bytes,buyerPair.privateKey)};
 const b={bundleVersion:'1',presentedBy:claim,presentedAt:T,sessionNonce:'b'.repeat(64),claims:[{ref:claim}]},bundle={...b,presentation:{kind:'per-claim',signatures:[{ref:claim,signature:signer.sign(Buffer.from('dacs-bundle-presentation:v1:'+identityBundleHash(b))).toString('base64url')}]}};
 body.scope.buyer=buyerClaim;body.scope.wallet='0x'+buyerClaim.slice(16);
 body.buyerIdentityBundle={bundleVersion:'1',presentedBy:buyerClaim,presentedAt:T,sessionNonce:'e'.repeat(64),claims:[{ref:buyerClaim}],presentation:{kind:'per-claim',signatures:[{ref:buyerClaim,signature:'pending'}]}};
 body.scope.seller=claim;body.scope.payee='0x'+claim.slice(16);
 const listing={seller:{identity:bundle},pin:w.pin,payee:body.scope.payee,price:body.scope.price,buyerRequirement:{requirementVersion:'1',required:[],preferredPresentation:'any'}};
 const {createSellerTransportStore,sellerContextChallengeScope}=await import('../src/dacs/seller-transport-auth.mjs');
 const transport=createSellerTransportStore({path:join(directory,'transport.sqlite'),now:()=>T});
 body.buyerIdentityBundle.sessionNonce=transport.issueContextChallenge({jobId:body.scope.jobId,buyer:buyerClaim},sellerContextChallengeScope(body.scope),{admit:()=>T}).sessionNonce;transport.close();
 body.scope.buyerBundleHash=identityBundleHash(body.buyerIdentityBundle);body.buyerIdentityBundle.presentation.signatures[0].signature=buyerSigner.sign(Buffer.from('dacs-bundle-presentation:v1:'+body.scope.buyerBundleHash)).toString('base64url');
 const text=JSON.stringify(body),client=createSellerTransportClientAuth({buyerSigner,seller:claim,resolveJob:()=>({listingPin:w.pin,agreementHash:sellerContextScopeHash(body.scope)}),now:()=>T}),header=(await client.request(SELLER_CONTEXT_PATH,body,text)).header;
 await writeFile(join(directory,'config.json'),JSON.stringify({time:T,buyer:{claim:buyerClaim,privateKey:buyerPair.privateKey.export({format:'pem',type:'pkcs8'})},seller:{claim,privateKey:pair.privateKey.export({format:'pem',type:'pkcs8'})},listing,input:{text,header}}),{mode:0o600});
 const run=phase=>{const result=spawnSync(process.execPath,[new URL('./helpers/d5-restart-process.mjs',import.meta.url).pathname,directory,phase],{encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout)};
 const cut=run('cut');assert.equal(cut.status,503,JSON.stringify(cut));assert.equal(cut.creates.length,1);assert.equal(cut.signatures.length,2);assert.equal(cut.after.scopeHash,sellerContextScopeHash(body.scope));
 const unknown=run('unknown');assert.equal(unknown.status,503);assert.equal(unknown.holds.length,0);assert.equal(unknown.resumeCount,0);assert.deepEqual(unknown.creates,cut.creates);assert.deepEqual(unknown.signatures,cut.signatures);
 const resumed=run('resume');assert.equal(resumed.status,200,JSON.stringify(resumed));assert.equal(resumed.answer.disposition,'present');assert.equal(resumed.retryStatus,200);assert.equal(resumed.resumeCount,1);assert.equal(resumed.holds.length,1);assert.equal(resumed.holds[0].writes,1);assert.deepEqual(resumed.before,cut.after);assert.deepEqual(resumed.after,cut.after);assert.equal(new Set(resumed.creates).size,2);assert.equal(resumed.creates.length,2);assert.equal(resumed.signatures.length,2);
 const readback=run('resume');assert.equal(readback.status,200);assert.equal(readback.holds.length,0);assert.equal(readback.resumeCount,0);assert.deepEqual(readback.creates,resumed.creates);assert.deepEqual(readback.signatures,resumed.signatures);
});
