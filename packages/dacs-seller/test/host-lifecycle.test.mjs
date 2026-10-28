import test from 'node:test';
import assert from 'node:assert/strict';
import {chmodSync} from 'node:fs';
import {createServer} from 'node:http';
import {mkdtemp,rm,chmod,access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import * as core from '@kynesyslabs/dacs';
import {commitmentFixture} from './helpers/commitment-fixture.mjs';
import {privateModule} from './helpers/private-module.mjs';
import {seller,buyer,NOW,fixtureRecord} from './helpers/protocol-fixture.mjs';
import {contributionVerifier} from '../src/dacs/purchase-protocol.mjs';
import {createSellerAgentClient} from '../src/dacs/seller-http.mjs';
import {createSellerTransportClientAuth} from '../src/dacs/seller-transport-auth.mjs';
const defer=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function fixture(t,{wrap=agent=>agent}={}){
 const f=await commitmentFixture(t),dataDirectory=await mkdtemp(join(tmpdir(),'TEST-host-lifecycle-'));
 const {durableDirectory,commitOnSignature,nativeArtifactAnchor,...config}=f.config;
 const api=await privateModule(new URL('../src/host.mjs',import.meta.url),['setTestWrapper'],source=>source.replace('const REQUIRED =', 'let testWrapper=agent=>agent; function setTestWrapper(value){testWrapper=value;}\nconst REQUIRED =').replace('createSellerHttpHandler(agent,','createSellerHttpHandler(testWrapper(agent),'));
 api.setTestWrapper(wrap);const options={...config,artifactAnchor:nativeArtifactAnchor,dataDirectory},hosts=[];
 const start=async(changes={})=>{const h=await api.startSellerHost({...options,...changes});hosts.push(h);return h;};
 t.after(async()=>{await chmod(dataDirectory,0o700);for(const h of hosts)await h.close().catch(()=>{});await rm(dataDirectory,{recursive:true,force:true});});
 const client=(host,request)=>createSellerAgentClient({url:host.url,authentication:createSellerTransportClientAuth({buyerSigner:{claim:buyer.claim,sign:buyer.signBytes},seller:seller.claim,resolveJob:()=>({listingPin:host.listingPin,agreementHash:request.proposal.plan.agreementHash}),now:()=>NOW})});
 return{...f,start,options,dataDirectory,client};
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

test('close aborts and drains an accepted native artifact readback before releasing state',async t=>{
 const entered=defer(),releaseRead=defer();let block=true;
 const f=await fixture(t),native=f.native;
 const artifactAnchor=Object.freeze({...native,readRetained:async input=>{
  if(block&&input.artifactKind==='FinalityCommitmentRecord'){entered.resolve();await releaseRead.promise;}
  return native.readRetained(input);
 }});
 const host=await f.start({artifactAnchor}),request=await f.proposal(host),client=f.client(host,request);
 const answer=await client.propose(request);
 assert.equal(answer.disposition,'complete');
 await anchorAgreement(f,request,answer);
 const pending=client.commit(request.transportIdentity.jobId).then(()=>'answered',error=>error.code??error.name);
 await entered.promise;
 try{
  const closed=await Promise.race([host.close().then(()=>'closed'),new Promise(resolve=>setTimeout(()=>resolve('stuck'),8000))]);
  assert.equal(closed,'closed','close aborts the accepted native readback instead of waiting for it');
  const reopened=await f.start();await reopened.close();
 }finally{block=false;releaseRead.resolve();}
 await pending;
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

test('host close does not wait for the keep-alive timeout',async t=>{
 const f=await fixture(t),host=await f.start(),request=await f.proposal(host);
 assert.equal((await f.client(host,request).propose(request)).disposition,'complete');
 const started=performance.now();
 await host.close();
 assert.ok(performance.now()-started<2000,'close does not wait for the idle keep-alive timeout');
});

test('a listen failure releases the state lock and everything opened before it',async t=>{
 const f=await fixture(t),blocker=createServer();
 await new Promise(resolve=>blocker.listen({host:'127.0.0.1',port:0,exclusive:true},resolve));
 const port=blocker.address().port;
 try{await assert.rejects(f.start({port}),error=>error.code==='EADDRINUSE');}
 finally{await new Promise(resolve=>blocker.close(resolve));}
 const host=await f.start();await host.close();
});
