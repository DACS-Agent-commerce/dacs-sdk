import {NATIVE_PAYMENT_EVIDENCE} from '../src/dacs/native-payment-evidence-consumer.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {chmodSync} from 'node:fs';
import {createServer} from 'node:http';
import {connect} from 'node:net';
import {once} from 'node:events';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,rm,chmod,access,writeFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as core from '@kynesyslabs/dacs';
import {commitmentFixture} from './helpers/commitment-fixture.mjs';
import {privateModule} from './helpers/private-module.mjs';
import {seller,buyer,NOW,fixtureRecord} from './helpers/protocol-fixture.mjs';
import {contributionVerifier} from '../src/dacs/purchase-protocol.mjs';
import {startSellerHost} from '../src/host.mjs';
import {createSellerAgentClient} from '../src/dacs/seller-http.mjs';
import {createSellerTransportClientAuth,SELLER_TRANSPORT_HEADER} from '../src/dacs/seller-transport-auth.mjs';
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function fixture(t,{wrap=agent=>agent}={}){
 const f=await commitmentFixture(t),dataDirectory=await mkdtemp(join(tmpdir(),'TEST-host-lifecycle-'));
 const {durableDirectory,commitOnSignature,nativeArtifactAnchor,...config}=f.config;
 const api=await privateModule(new URL('../src/host.mjs',import.meta.url),['setTestWrapper','setTestKeepAliveTimeout','setTestReadbackTimeout'],source=>source.replace('const REQUIRED =', 'let testWrapper=agent=>agent; function setTestWrapper(value){testWrapper=value;}\nconst REQUIRED =').replace('createSellerHttpHandler(agent,','createSellerHttpHandler(testWrapper(agent),').replace('const TIMEOUTS =','let testKeepAliveTimeout=5000; function setTestKeepAliveTimeout(value){testKeepAliveTimeout=Number(value);}\nlet testReadbackTimeout=15000; function setTestReadbackTimeout(value){testReadbackTimeout=Number(value);}\nconst TIMEOUTS =').replace('keepAliveTimeout: TIMEOUTS.keepAliveTimeout','keepAliveTimeout: testKeepAliveTimeout').replace('timeoutMs: TIMEOUTS.requestTimeout','timeoutMs: testReadbackTimeout'));
 api.setTestWrapper(wrap);const options={...config,artifactAnchor:nativeArtifactAnchor,dataDirectory},hosts=[];
 const start=async(changes={})=>{const h=await api.startSellerHost({...options,...changes});hosts.push(h);return h;};
 t.after(async()=>{await chmod(dataDirectory,0o700);for(const h of hosts)await h.close().catch(()=>{});await rm(dataDirectory,{recursive:true,force:true});});
 const client=(host,request)=>createSellerAgentClient({url:host.url,authentication:createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:seller.claim,resolveJob:()=>({listingPin:host.listingPin,agreementHash:request.proposal.plan.agreementHash}),now:()=>NOW}),timeoutMs:60000});
 return{...f,start,options,dataDirectory,client,setKeepAliveTimeout:api.setTestKeepAliveTimeout,setReadbackTimeout:api.setTestReadbackTimeout};
}
async function anchorAgreement(f,request,answer){
 const agreement=await core.finalizeFixedPriceAgreementContributions(request.proposal.plan,[request.proposal.buyerContribution,answer.contribution],contributionVerifier);
 f.controls.agreement=fixtureRecord(core.fixedPriceAgreementLogicalAddress(agreement.jobId),agreement,buyer);
}
test('host refuses non-loopback before opening state',async t=>{
 const f=await fixture(t);for(const host of ['0.0.0.0','localhost','192.0.2.1'])await assert.rejects(f.start({host}),/literal loopback/);
 await assert.rejects(access(join(f.dataDirectory,'seller-state.lock')),{code:'ENOENT'});
});
test('host owns its lock while an authenticated HTTP request drains, then reopens and replays retained contribution',async t=>{
 const entered=defer(),release=defer();let block=true;t.after(()=>release.resolve());
 const f=await fixture(t,{wrap:agent=>({...agent,receiveProposal:async request=>{if(block){entered.resolve();await release.promise;}return agent.receiveProposal(request);}})}),host=await f.start();
 await assert.rejects(f.start(),e=>e.code==='seller_state_locked');
 const request=await f.proposal(host),pending=f.client(host,request).propose(request);await entered.promise;
 let closed=false;const closing=host.close().then(()=>{closed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);await assert.rejects(f.start(),e=>e.code==='seller_state_locked');
 release.resolve();const answer=await pending;assert.equal(answer.disposition,'complete');await closing;block=false;
 const reopened=await f.start();assert.deepEqual((await f.client(reopened,request).propose(request)).contribution,answer.contribution);await reopened.close();
});
test('host close reports filesystem lock-release failure after attempting cleanup',async t=>{
 const f=await fixture(t),host=await f.start();await chmod(f.dataDirectory,0o500);
 try{await assert.rejects(host.close(),error=>error instanceof AggregateError&&error.errors.some(e=>e.code==='EACCES'));}
 finally{await chmod(f.dataDirectory,0o700);}
 await access(join(f.dataDirectory,'seller-state.lock'));await assert.rejects(f.start(),e=>e.code==='seller_state_locked');
});

test('startup failure remains the original cause when cleanup also fails',async t=>{
 let directory;const original=new Error('TEST startup handler failure');
 const f=await fixture(t,{wrap:()=>{chmodSync(directory,0o500);throw original;}});directory=f.dataDirectory;
 try{await assert.rejects(f.start(),error=>error===original&&error.cleanupError?.errors.some(e=>e.code==='EACCES'));}
 finally{await chmod(directory,0o700);}
});

test('a frozen startup failure is kept as the aggregate cause when cleanup also fails',async t=>{
 let directory;const original=Object.freeze(new Error('TEST frozen startup cause'));
 const f=await fixture(t,{wrap:()=>{chmodSync(directory,0o500);throw original;}});directory=f.dataDirectory;
 try{
  await assert.rejects(f.start(),error=>{
   assert.ok(error instanceof AggregateError,'the frozen cause is carried by an aggregate error');
   assert.equal(error.cause,original,'the original startup error stays the cause');
   assert.ok(error.errors.some(e=>e.errors?.some(n=>n.code==='EACCES')),'the cleanup failure is reported');
   return true;
  });
 }finally{await chmod(directory,0o700);}
});

test('the host still refuses a native artifact capability without its readbacks',async t=>{
 const f=await fixture(t);const {readRetained:_removed,...anchor}=f.native;
 await assert.rejects(f.start({artifactAnchor:anchor}),/native demo artifact capability is incomplete/);
 const host=await f.start();await host.close();
});

test('close waits for an accepted native artifact readback before releasing state',async t=>{
 const entered=defer(),releaseRead=defer();let block=true,closedAt=false,afterClose=0;
 const f=await fixture(t),native=f.native;
 const artifactAnchor=Object.freeze({...native,readRetained:async input=>{
  if(block&&input.artifactKind==='FinalityCommitmentRecord'){entered.resolve();await releaseRead.promise;if(closedAt)afterClose++;}
  return native.readRetained(input);
 }});
 const host=await f.start({artifactAnchor}),request=await f.proposal(host),client=f.client(host,request);
 const answer=await client.propose(request);assert.equal(answer.disposition,'complete');
 await anchorAgreement(f,request,answer);
 const pending=client.commit(request.transportIdentity.jobId).then(()=> 'answered',error=>error.code??error.name);
 await entered.promise;
 let closed=false;const closing=host.close().then(()=>{closed=true;closedAt=true;});
 try{
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(closed,false,'close retains ownership while the underlying readback still runs');
  await assert.rejects(f.start(),e=>e.code==='seller_state_locked');
 }finally{block=false;releaseRead.resolve();}
 await closing;
 assert.equal(afterClose,0,'a late readback never writes after ownership transfers');
 assert.equal(await pending,'answered','the accepted readback outcome answers the request instead of becoming an uncertain shutdown');
 const reopened=await f.start(),recovered=f.client(reopened,request);
 assert.equal((await recovered.commit(request.transportIdentity.jobId)).status,'committed','the commitment completed before shutdown stays committed after restart');
 assert.equal((await recovered.commit(request.transportIdentity.jobId)).status,'committed','an authenticated retry recovers the same commitment');
 await reopened.close();
});

test('a readback past its deadline answers uncertain and close still releases state',async t=>{
 const f=await fixture(t),native=f.native;let aborted=0;
 // The deadline is a host setting; shorten it so a readback that cannot finish
 // inside it is exercised without waiting the production fifteen seconds.
 f.setReadbackTimeout(400);
 const artifactAnchor=Object.freeze({...native,readRetained:async(input,options)=>{
  if(input.artifactKind==='FinalityCommitmentRecord'){
   await new Promise((resolve,reject)=>{
    const onAbort=()=>{aborted++;reject(new Error('TEST readback aborted'));};
    if(options?.signal?.aborted){onAbort();return;}
    options?.signal?.addEventListener('abort',onAbort,{once:true});
   });
  }
  return native.readRetained(input);
 }});
 const host=await f.start({artifactAnchor}),request=await f.proposal(host),client=f.client(host,request);
 const answer=await client.propose(request);assert.equal(answer.disposition,'complete');
 await anchorAgreement(f,request,answer);
 const outcome=await client.commit(request.transportIdentity.jobId).then(()=> 'answered',error=>`${error.name}/${error.code}`);
 assert.match(outcome,/SellerUnavailableError\/seller_unavailable/,'a readback that cannot finish inside its deadline answers uncertain');
 const closeOutcome=await Promise.race([
  host.close().then(()=> 'closed'),
  new Promise(resolve=>setTimeout(()=>resolve('still-open'),10000)),
 ]);
 assert.equal(closeOutcome,'closed','close does not wait for a readback past its deadline');
 assert.ok(aborted>=1,'shutdown stops the underlying readback once the request has drained');
 const reopened=await f.start({artifactAnchor:native});
 assert.ok(reopened.url,'the state lock is released after the deadline');
 await reopened.close();
});

test('host close destroys a connection that never finishes its request headers',async t=>{
 const f=await fixture(t),host=await f.start();
 const socket=connect({host:'127.0.0.1',port:Number(new URL(host.url).port)});
 try{
  await once(socket,'connect');
  // A buyer may open a connection and send a partial request line; no request
  // is dispatched, so nothing of it can be drained.
  socket.write('POST /dacs/v1/commitments HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n');
  await new Promise(resolve=>setImmediate(resolve));
  let guard;
  const outcome=await Promise.race([
   host.close().then(()=> 'closed'),
   new Promise(resolve=>{guard=setTimeout(()=>resolve('still-open'),10000);}),
  ]);
  clearTimeout(guard);
  assert.equal(outcome,'closed','a connection with no dispatched request cannot hold close');
 }finally{socket.destroy();}
});

test('wrapped native artifact readbacks keep their capability receiver',async t=>{
 const f=await fixture(t),native=f.native;
 const artifactAnchor={...native,reads:0,verifies:0,
  async readRetained(input){this.reads++;return native.readRetained(input);},
  async verifyReceipt(input){this.verifies++;return native.verifyReceipt(input);}};
 const host=await f.start({artifactAnchor}),request=await f.proposal(host),client=f.client(host,request);
 const answer=await client.propose(request);assert.equal(answer.disposition,'complete');
 await anchorAgreement(f,request,answer);
 assert.equal((await client.commit(request.transportIdentity.jobId)).status,'committed');
 assert.ok(artifactAnchor.reads>=1,'readRetained ran with its capability as receiver');
 assert.ok(artifactAnchor.verifies>=1,'verifyReceipt ran with its capability as receiver');
 await host.close();
});

test('wrapped native artifact publish keeps its capability receiver',async t=>{
 const f=await fixture(t),native=f.native;
 const artifactAnchor={...native,published:0,async publish(input){this.published++;return native.publish(input);}};
 const host=await f.start({artifactAnchor}),request=await f.proposal(host),client=f.client(host,request);
 const answer=await client.propose(request);assert.equal(answer.disposition,'complete');
 await anchorAgreement(f,request,answer);
 assert.equal((await client.commit(request.transportIdentity.jobId)).status,'committed');
 assert.equal(artifactAnchor.published,1,'publish ran with its capability as receiver');
 await host.close();
});

test('host forwards capability metadata getters with the capability as receiver',async t=>{
 const f=await fixture(t),native=f.native;
 const artifactAnchor=new class{
  #inner=native;
  get writer(){return this.#inner.writer;}
  get source(){return this.#inner.source;}
  readRetained(input){return this.#inner.readRetained(input);}
  verifyReceipt(input){return this.#inner.verifyReceipt(input);}
  publish(input){return this.#inner.publish(input);}
 }();
 const host=await f.start({artifactAnchor}),request=await f.proposal(host),client=f.client(host,request);
 const answer=await client.propose(request);assert.equal(answer.disposition,'complete');
 await anchorAgreement(f,request,answer);
 assert.equal((await client.commit(request.transportIdentity.jobId)).status,'committed');
 await host.close();
});

test('host issues no session challenge once close has begun',async t=>{
 const entered=defer(),release=defer();
 const f=await fixture(t,{wrap:agent=>({...agent,receiveProposal:async request=>{entered.resolve();await release.promise;return agent.receiveProposal(request);}})}),host=await f.start();
 const request=await f.proposal(host),pending=f.client(host,request).propose(request).catch(error=>error);
 await entered.promise;
 const closing=host.close();
 try{
  assert.throws(()=>host.issueSessionChallenge({jobId:request.transportIdentity.jobId,buyer:buyer.claim}),error=>error.code==='seller_host_closing');
 }finally{release.resolve();}
 await pending;await closing;
});

test('host close closes an idle keep-alive connection instead of waiting for its expiry',async t=>{
 const f=await fixture(t);
 // With expiry disabled, close() can only finish if it actively closes the
 // idle connection; the guard below is a hang guard, not a latency assertion.
 f.setKeepAliveTimeout(0);
 const host=await f.start();
 const socket=connect({host:'127.0.0.1',port:Number(new URL(host.url).port)});
 try{
  await once(socket,'connect');
  // A refusal before any effect is answered without `connection: close`, so
  // the server keeps this connection alive after the response.
  const body='{"transportIdentity":{}}';
  socket.write(`POST /dacs/v1/agreements/state HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`);
  const [answer]=await once(socket,'data');
  assert.match(String(answer),/^HTTP\/1\.1 4\d\d /);
  assert.doesNotMatch(String(answer),/connection: close/i);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(socket.destroyed,false,'the connection is a live idle keep-alive connection');
  let guard;
  const outcome=await Promise.race([
   host.close().then(()=> 'closed'),
   new Promise(resolve=>{guard=setTimeout(()=>resolve('still-open'),10000);}),
  ]);
  clearTimeout(guard);
  assert.equal(outcome,'closed','close closes the idle connection rather than waiting for keep-alive expiry');
 }finally{socket.destroy();}
});

test('a listen failure releases the state lock and everything opened before it',async t=>{
 const f=await fixture(t),blocker=createServer();
 await new Promise(resolve=>blocker.listen({host:'127.0.0.1',port:0,exclusive:true},resolve));
 const port=blocker.address().port;
 try{await assert.rejects(f.start({port}),error=>error.code==='EADDRINUSE');}
 finally{await new Promise(resolve=>blocker.close(resolve));}
 const host=await f.start();await host.close();
});

test('host reports both literal loopback URLs',async t=>{
 const f=await fixture(t);
 const v4=await f.start();assert.match(v4.url,/^http:\/\/127\.0\.0\.1:\d+$/);await v4.close();
 const v6=await f.start({host:'::1'});assert.match(v6.url,/^http:\/\/\[::1\]:\d+$/);await v6.close();
});

test('host makes newly created seller and transport directories durable before listening',async t=>{
 const f=await fixture(t),original=fs.fsyncSync,synced=[];
 try{
  fs.fsyncSync=descriptor=>{try{synced.push(fs.realpathSync(`/proc/self/fd/${descriptor}`));}catch{}return original(descriptor);};
  syncBuiltinESMExports();
  const host=await f.start();
  assert.ok(synced.includes(join(f.dataDirectory,'transport')),'the new transport directory entry is synced');
  assert.ok(synced.includes(f.dataDirectory),'the new seller and transport directory entries are synced in dataDirectory');
  await host.close();
 }finally{fs.fsyncSync=original;syncBuiltinESMExports();}
});

test('host refuses malformed options before opening any state',async t=>{
 const root=await mkdtemp(join(tmpdir(),'TEST-host-options-')),dataDirectory=await mkdtemp(join(root,'state-'));
 const loose=await mkdtemp(join(tmpdir(),'TEST-host-loose-'));await chmod(loose,0o755);
 const link=join(root,'link');await symlink(dataDirectory,link);
 const file=join(root,'regular');await writeFile(file,'TEST');
 t.after(async()=>{await rm(root,{recursive:true,force:true});await rm(loose,{recursive:true,force:true});});
 const base=()=>({signer:{claim:seller.claim,sign:()=>{}},listing:{},dataDirectory,buyerAccess:{},agreementAnchor:{},artifactAnchor:{},deliverableProducer(){},nativePaymentEvidence:{},reconcilePaymentEvidence(){},demDeliveryContext:{},nativeDemDelivery:{},railAuthority:{},sessionAdmission:{}});
 const cases=[
  ['non-object',null,/must be an object/],
  ['array options',[],/must be an object/],
  ['unknown option',{...base(),extra:true},/unknown seller host option: extra/],
  ['missing required',(()=>{const value=base();delete value.agreementAnchor;return value;})(),/requires agreementAnchor/],
  ['non-loopback host',{...base(),host:'localhost'},/literal loopback/],
  ['negative port',{...base(),port:-1},/port must be an integer/],
  ['port above 65535',{...base(),port:65536},/port must be an integer/],
  ['fractional port',{...base(),port:1.5},/port must be an integer/],
  ['string port',{...base(),port:'80'},/port must be an integer/],
  ['relative dataDirectory',{...base(),dataDirectory:'relative/state'},/absolute path/],
  ['non-private dataDirectory',{...base(),dataDirectory:loose},/existing private \(mode 0700\) directory/],
  ['symbolic link dataDirectory',{...base(),dataDirectory:link},/existing private \(mode 0700\) directory/],
  ['regular file dataDirectory',{...base(),dataDirectory:file},/existing private \(mode 0700\) directory/],
  ['observeDemosTransfer is not a function',{...base(),observeDemosTransfer:5},/must be functions/],
  ['now is not a function',{...base(),now:5},/must be functions/],
  ['mismatched payment evidence pair',{...base(),nativePaymentEvidence:{anchorEvidence:()=>{}}},/payment-evidence anchor and reconcilePaymentEvidence/],
 ];
 for(const [label,options,expected] of cases)await assert.rejects(startSellerHost(options),expected,label);
});

for(const method of ['readRetained','verifyReceipt','publish'])test(`staged native payment enters no ${method} and host closes cleanly`,async t=>{
 const f=await fixture(t),native=f.native;let calls=0;
 const artifactAnchor={...native,[method]:async input=>{calls++;return native[method](input);}};
 const host=await f.start({artifactAnchor}),request=await f.proposal(host),client=f.client(host,request);
 const answer=await client.propose(request);assert.equal(answer.disposition,'complete');await anchorAgreement(f,request,answer);
 await assertStagedPayment(host,request);
 assert.equal(calls,0);await host.close();const reopened=await f.start();await reopened.close();
});

async function assertStagedPayment(host,request){
 const body={jobId:request.transportIdentity.jobId,txHash:'a'.repeat(64),payerPayingKey:buyer.claim,nativePaymentEvidence:NATIVE_PAYMENT_EVIDENCE},text=JSON.stringify(body),path='/dacs/v1/payments';
 const auth=createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:seller.claim,resolveJob:()=>({listingPin:host.listingPin,agreementHash:request.proposal.plan.agreementHash}),now:()=>NOW});
 const signed=await auth.request(path,body,text);
 const response=await fetch(host.url+path,{method:'POST',headers:{'content-type':'application/json',[SELLER_TRANSPORT_HEADER]:signed.header},body:text});
 const answer=await response.text();auth.verifyResponse(signed.payload,{header:response.headers.get(SELLER_TRANSPORT_HEADER),status:response.status,text:answer});
 assert.equal(response.status,503);assert.equal(JSON.parse(answer).error,'settlement_profile_unavailable');
}
