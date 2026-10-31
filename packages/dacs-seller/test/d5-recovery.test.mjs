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

for (const config of [{maxNoncesPerBuyerPerWindow:1},{maxRecords:1}]) test(`known bytes preserve journal refusal under ${JSON.stringify(config)}`,async t=>{
 const {exchange}=await import('./helpers/d5-http-fixture.mjs');
 const w=await world(t,{...config,recover:async body=>({disposition:'present',value:{scope:body.scope,input:{jobId:body.scope.jobId}}})});
 assert.equal((await exchange(w.handler,await w.wire())).status,200);
 const result=await exchange(w.handler,await w.wire());
 assert.equal(JSON.parse(result.text).error,config.maxRecords?'peer_store_capacity':'peer_buyer_nonce_limit');
 assert.equal(w.effects().writes,1);
});

test('cached present start authenticates retained records before replay',async t=>{
 const {exchange}=await import('./helpers/d5-http-fixture.mjs');
 let reads=0;
 const w=await world(t,{recover:async()=>{reads++;return null;}}),input=await w.wire();
 assert.equal((await exchange(w.handler,input)).status,200);
 assert.equal((await exchange(w.handler,input)).status,503);
 assert.equal(reads,1);assert.equal(w.effects().writes,1);
});

test('journal reservation precedes every durable write hold',async t=>{
 const {exchange}=await import('./helpers/d5-http-fixture.mjs');let w;
 w=await world(t,{admitWrites:async input=>{
  assert.equal(w.store.contextAdmission(input.jobId)?.effect,input.hold);
  return null;
 }});
 assert.equal((await exchange(w.handler,await w.wire())).status,200);
});

for(const separateHandle of [false,true])test(`two route instances share journal authority, separate store=${separateHandle}`,async t=>{
 const {exchange}=await import('./helpers/d5-http-fixture.mjs');
 const {createSellerContextRoute}=await import('../src/dacs/seller-context-route.mjs');
 const {createSellerHttpHandler}=await import('../src/dacs/seller-http.mjs');
 const {createSellerTransportStore,createSellerTransportServerAuth}=await import('../src/dacs/seller-transport-auth.mjs');
 let begin,finish;const begun=new Promise(resolve=>begin=resolve),gate=new Promise(resolve=>finish=resolve);
 const w=await world(t,{admitWrites:async()=>{begin();await gate;return null;}});
 t.after(()=>finish());
 const input=await w.wire(),pending=exchange(w.handler,input);await begun;
 const store=separateHandle?createSellerTransportStore({path:w.path,now:()=>T}):w.store;
 if(separateHandle)t.after(()=>store.close());
 const route=createSellerContextRoute({listing:w.listing,resolveBuyer:()=>assert.fail('second provider'),assertBuyerAccess:()=>{},admitWrites:()=>assert.fail('second hold'),releaseWrites:async()=>{},writable:()=>true,recover:async()=>null,now:()=>T});
 const auth=createSellerTransportServerAuth({sellerSigner:w.seller,listingPin:w.pin,store,now:()=>T});
 const handler=createSellerHttpHandler({claim:w.seller.claim,listingPin:w.pin},{authentication:auth,context:route});
 const retry=await exchange(handler,input);assert.equal(retry.status,503);assert.equal(JSON.parse(retry.text).error,'operation_uncertain');
 finish();assert.equal((await pending).status,200);assert.equal(w.effects().writes,1);
});

test('final cached replay retries a failed release, while uncertain replay preserves the hold',async t=>{
 const {createSellerContextRoute}=await import('../src/dacs/seller-context-route.mjs');
 const {createSellerContextAdmission,parsePolicyLedger}=await import('../src/devnet-demo/operator-approval.mjs');
 const w=await world(t),input=await w.wire(),body=JSON.parse(input.text),request=w.auth.readRequest(input.header);
 const path=join(w.path+'-policy.jsonl');t.after(()=>rm(path,{force:true}));
 const policy=createSellerContextAdmission({evidencePath:path,sellerApproval:{mode:'policy',maxWritesPerHour:2,maxTotalOsPerHour:'8',maxWriteTotalOs:'4'},now:()=>T});
 let fail=true,releases=0;
 const route=createSellerContextRoute({listing:w.listing,resolveBuyer:async()=>({disposition:'rejected'}),assertBuyerAccess:()=>{},writable:()=>true,admitWrites:policy.reserve,
  releaseWrites:async args=>{releases++;if(fail)throw new Error('TEST release unavailable');await policy.release(args);},recover:async()=>null,now:()=>T,log:()=>{}});
 const reserved=await route.reserve(request,body,w.store);
 assert.equal((await route.reserve(request,body,w.store)).disposition,'uncertain');assert.equal(releases,0);
 w.store.finish(reserved,200,JSON.stringify({disposition:'rejected'}),{noEffect:true});
 await route.settled(reserved.contextHold);fail=false;
 assert.equal((await route.reserve(request,body,w.store)).disposition,'cached');
 assert.equal(parsePolicyLedger(await (await import('node:fs/promises')).readFile(path,'utf8')).rows[0].released,true);
});

test('context client sends the same canonical bytes for reordered scope and bundle keys',async t=>{
 const {createSellerContextClient}=await import('../src/dacs/seller-context-route.mjs');
 const {canonicalize}=await import('@kynesyslabs/dacs');
 const w=await world(t),body=JSON.parse((await w.wire()).text),sent=[];
 const client=createSellerContextClient({clientFor:()=>({agreementContext:async value=>{sent.push(JSON.stringify(value));return {disposition:'indeterminate'};}})});
 const operation={state:{protocol:{sellerContextRequest:{generatedAt:body.scope.generatedAt,buyerBundle:body.buyerIdentityBundle}}}};
 await client.resolveBuyer(body,{operation});
 const reverse=value=>Object.fromEntries(Object.entries(value).reverse());
 await client.resolveBuyer({scope:reverse(body.scope),buyerIdentityBundle:reverse(body.buyerIdentityBundle)},{operation});
 assert.deepEqual(sent,[canonicalize(body),canonicalize(body)]);
});

test('proved resume transfers unused budget after the journal assigns a new owner',async t=>{
 const {createSellerContextRoute}=await import('../src/dacs/seller-context-route.mjs');
 const {createSellerContextAdmission}=await import('../src/devnet-demo/operator-approval.mjs');
 const w=await world(t),body=JSON.parse((await w.wire()).text),request=w.auth.readRequest((await w.wire()).header);
 const path=w.path+'-resume.jsonl';t.after(()=>rm(path,{force:true}));
 const policy=createSellerContextAdmission({evidencePath:path,sellerApproval:{mode:'policy',maxWritesPerHour:2,maxTotalOsPerHour:'8',maxWriteTotalOs:'4'},now:()=>T});
 const route=createSellerContextRoute({listing:w.listing,resolveBuyer:async()=>null,assertBuyerAccess:()=>{},writable:()=>true,admitWrites:policy.reserve,releaseWrites:policy.release,recover:async()=>null,now:()=>T});
 const first=await route.reserve(request,body,w.store);w.store.finish(first,503,'{}');
 const uncertain=w.store.reserve(request,body),resumed=await route.resume(uncertain,request,w.store,{writes:1});
 assert.equal(resumed.disposition,'perform');assert.match(resumed.contextHold.hold,new RegExp('^'+first.effectKey+':'));
});
