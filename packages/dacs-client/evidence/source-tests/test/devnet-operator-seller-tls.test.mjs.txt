import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';
import { X509Certificate } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCanonicalJobId } from '@kynesyslabs/dacs';
import { createDevnetDemoOperator } from '../src/devnet-demo/operator.mjs';
import { createDevnetDemoComposition } from '../src/devnet-demo/composition.mjs';
import { createApp } from '../src/app.mjs';
import { assertSellerTlsClientHandshake } from '../src/devnet-demo/seller-tls.mjs';
import { createSellerAgentClient, SellerUnavailableError } from '../src/dacs/seller-http.mjs';
import { bootstrapTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';
import { admitObservedNode2Identity, observeNode2Identity } from '../src/devnet-demo/operator-network.mjs';
import { startOperatorNode2 } from './helpers/devnet-operator-node2.mjs';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, tool } from './helpers/flows.mjs';
import { createLoopbackTestTlsMaterial } from './helpers/loopback-test-tls.mjs';
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
async function fixture(t){
  const node2=await startOperatorNode2();t.after(()=>node2.close());
  const root=await realpath(await mkdtemp(join(tmpdir(),'devnet-operator-cleanup-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const [appPort,sellerPort,directoryPort]=await Promise.all([freePort(),freePort(),freePort()]);
  const publicOrigin=`http://127.0.0.1:${appPort}`,custodyDirectory=join(root,'custody'),stateDirectory=join(root,'state');
  const custody=await bootstrapTestWalletCustody({directory:custodyDirectory,publicOrigin});
  const observation=await observeNode2Identity({endpoint:node2.endpoint,network:'demos-devnet',fetchImpl:node2.fetchImpl});
  const authority='TEST-RUN-operator-cleanup-001';
  const admission=admitObservedNode2Identity({observation,authority,transportAuthority:'TEST-owned-operator-node2',pinVersion:'TEST-operator-pin-v1',reviewedChainIdentity:observation.chainIdentity});
  const admissionPath=join(root,'admission.json');await writeFile(admissionPath,`${JSON.stringify(admission)}\n`,{mode:0o600});
  const config={format:'dacs-node2-demo-operator/v1',authority,publicOrigin,sellerOrigin:`https://127.0.0.1:${sellerPort}`,sellerTls:{keyPath:join(root,'seller-key.pem'),certificatePath:join(root,'seller-cert.pem')},
    directoryOrigin:`http://127.0.0.1:${directoryPort}`,stateDirectory,custodyDirectory,networkAdmissionPath:admissionPath,
    listing:{listingId:'operator-cleanup-report',listingVersion:1,displayName:'Operator Seller',title:'Node2 purchased report',description:'A seller-produced report.',category:'services.market-report',tags:['report'],priceDem:'1',validForMs:86400000,deadlineSecAfterCommit:3600},
    sellerFeeBudget:{maxTotalOs:'10000000000'},content:{mediaType:'text/plain; charset=utf-8',text:'Purchased report bytes.'}};
  const tls=createLoopbackTestTlsMaterial({temporaryRoot:root});
  await writeFile(config.sellerTls.keyPath,tls.key,{mode:0o600});await writeFile(config.sellerTls.certificatePath,tls.cert,{mode:0o600});
  const configPath=join(root,'operator.json');await writeFile(configPath,`${JSON.stringify(config)}\n`,{mode:0o600});
  const testFetch=(url,options)=>new URL(url).protocol==='https:'?node2.fetchImpl(url,options):fetch(url,options);
  const wallet=(role)=>custody.wallets.find((entry)=>entry.role===role).path;
  return{root,node2Cert:node2.cert,cert:tls.cert,config,configPath,stateDirectory,wallet,options:()=>({configPath,fetchImpl:testFetch,authorizeSellerApproval:()=>true})};
}
// The injected-client probe: exactly this GET, never redirected or credentialed.
const PROBE={path:'/__seller_tls_handshake__',method:'GET',redirect:'manual',credentials:'omit',signal:true};
// An injected client that trusts exactly the test seller certificate while
// trusted() holds. It records every seller request's path and options, and
// sends each once onSellerRequest's answer settles.
function injectedSellerFetch(f,{trusted=()=>true,onSellerRequest=()=>{}}={}){
  const nodeFetch=f.options().fetchImpl,requests=[];
  const fetchImpl=async(url,options={})=>{
    if(new URL(url).origin!==f.config.sellerOrigin)return nodeFetch(url,options);
    requests.push({path:new URL(url).pathname,method:options.method,redirect:options.redirect,credentials:options.credentials,signal:options.signal instanceof AbortSignal});
    await onSellerRequest(url,options);
    return new Promise((resolve,reject)=>{
      const request=https.request(url,{method:options.method,signal:options.signal,agent:false,...(trusted()?{ca:f.cert}:{})},response=>{
        const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));response.on('error',reject);
      });request.once('error',reject);request.end(options.body);
    });
  };
  return{fetchImpl,requests};
}
// The production composition around one operator, ready to attach.
async function composed(t,f,fetchImpl){
  const operator=await createDevnetDemoOperator({...f.options(),fetchImpl});t.after(()=>operator.close());
  const prepared=await operator.prepareDevnetDemo(),composition=await createDevnetDemoComposition(prepared.composition);t.after(()=>composition.sellerAgent.close());
  const application=await createApp({config:prepared.config,dacsProtocol:composition.dacsProtocol,devnetAgreementTransport:prepared.devnetAgreementTransport,fetchImpl});t.after(()=>application.close());
  return{operator,composition,application,attach:(overrides={})=>operator.attachSellerAgent({sellerAgent:composition.sellerAgent,application,composition,...overrides}),listen:()=>operator.listen({application,composition})};
}
const refusesConnections=async(origin)=>{
  const socket=net.connect({host:'127.0.0.1',port:Number(new URL(origin).port)});
  await new Promise((resolve,reject)=>{socket.once('connect',()=>{socket.destroy();reject(new Error(`${origin} still accepts connections`));});socket.once('error',error=>{assert.equal(error.code,'ECONNREFUSED');resolve();});});
};
const allRefuse=async(f)=>{for(const origin of [f.config.publicOrigin,f.config.sellerOrigin,f.config.directoryOrigin])await refusesConnections(origin);};
const withConfig=(f,changes)=>writeFile(f.configPath,`${JSON.stringify({...f.config,...changes})}\n`,{mode:0o600});
// Every seller transport store (seller-transport-auth.mjs) opened while work
// runs, and whether it was closed by the time work settled.
async function transportStores(work){
  const {DatabaseSync}=await import('node:sqlite'),{exec,close}=DatabaseSync.prototype,stores=new Map();
  DatabaseSync.prototype.exec=function(sql){if(String(sql).includes('CREATE TABLE IF NOT EXISTS peer_meta'))stores.set(this,false);return exec.call(this,sql);};
  DatabaseSync.prototype.close=function(){if(stores.has(this))stores.set(this,true);return close.call(this);};
  try{await work();}finally{Object.assign(DatabaseSync.prototype,{exec,close});}
  return[...stores.values()];
}


// The test's clock changes certificate validity without committing keys or
// certificates, changing host time, or weakening loopback TLS verification.
for(const kind of ['expired','not-yet-valid'])test(`startup refuses seller TLS: ${kind}`,{timeout:120000},async t=>{
  const f=await fixture(t),x509=new X509Certificate(f.cert),end=Date.parse(x509.validTo);
  const time=kind==='expired'?end:Date.parse(x509.validFrom)-1;
  let operator;
  try{
    await assert.rejects(async()=>{operator=await createDevnetDemoOperator({...f.options(),now:()=>time});},error=>{
      assert.equal(error.code,'seller_tls_unusable');
      assert.ok(error.message.includes(new Date(end).toISOString()));
      assert.match(error.message,kind==='expired'?/expired/:/not yet valid/);
      assert.equal(/BEGIN|PRIVATE KEY/.test(error.message),false);return true;
    });
    assert.equal(existsSync(join(f.stateDirectory,'node2-transport.sqlite')),false,'refuses before a journal or listener opens');
  }finally{await operator?.close();}
});

test('valid TLS accepted, readiness includes end date, runtime admission and cached seller calls refuse expiration without sending',{timeout:120000},async t=>{
  const f=await fixture(t),end=Date.parse(new X509Certificate(f.cert).validTo),windowMs=90*60*1000+SELLER_SESSION_KEY_GRACE_MS;
  let time=end-windowMs-1;
  const operator=await createDevnetDemoOperator({...f.options(),now:()=>time});t.after(()=>operator.close());
  const prepared=await operator.prepareDevnetDemo();
  assert.deepEqual(prepared.operatorEvidence.sellerTls,{notAfter:new Date(end).toISOString(),status:'ready'});
  const seller=prepared.operatorEvidence.seller,buyer=prepared.operatorEvidence.buyer,jobId=generateCanonicalJobId();
  const operation={terms:{buyer:{wallet:'0x'+buyer.slice('did:demos:agent:'.length)},protocol:{jobId}},state:{protocol:{listing:prepared.composition.listingDraft,planned:{plan:{agreementHash:'a'.repeat(64)}}}}};
  const authentication=prepared.composition.sellerTransport.authenticationFor(operation);
  let sends=0;
  const client=createSellerAgentClient({url:'https://127.0.0.1:41002',authentication,fetchImpl:()=>{sends++;throw new Error('unexpected send');}});
  time=end-windowMs;
  await assert.rejects(client.commit(jobId),error=>error instanceof SellerUnavailableError&&error.causeCode==='other');
  assert.equal(sends,1,'in-flight authentication reaches fetch at the exact window boundary');
  sends=0;
  assert.throws(()=>prepared.composition.sellerEndpoint(seller,{newPurchase:true}),/purchase window/);
  assert.equal(prepared.composition.sellerEndpoint(seller),null,'an existing purchase can use the still-valid certificate');
  assert.equal((await operator.prepareDevnetDemo()).operatorEvidence.sellerTls.status,'unusable');
  time=end;
  assert.throws(()=>prepared.composition.sellerEndpoint(seller,{newPurchase:true}),/expired/);
  assert.equal(prepared.composition.sellerEndpoint(seller),null,'an existing purchase reaches the HTTP guard so its failure can be recorded');
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(client.commit(jobId),error=>{
    assert.ok(error instanceof SellerUnavailableError);assert.equal(error.name,'SellerUnavailableError','an earlier operation outcome remains indeterminate');assert.equal(error.code,'seller_tls_unusable');assert.match(error.message,/expired/);assert.ok(error.message.includes(new Date(end).toISOString()));return true;
  });
  const freshClient=createSellerAgentClient({url:'https://127.0.0.1:41002',authentication:prepared.composition.sellerTransport.authenticationFor(operation),fetchImpl:()=>{sends++;throw new Error('unexpected send');}});
  await assert.rejects(freshClient.commit(jobId),error=>error instanceof SellerUnavailableError&&error.code==='seller_tls_unusable'&&error.message.includes(new Date(end).toISOString()));
  assert.equal(sends,0,'cached authentication rechecks validity; nothing is sent or resent');
  const readiness=(await operator.prepareDevnetDemo()).operatorEvidence.sellerTls;
  assert.match(readiness.reason,/expired/);assert.equal(readiness.notAfter,new Date(end).toISOString());
  const h=await startProtocolHarness();t.after(()=>h.close());
  const user=await linkedUser(h),listed=await addSeller(h,{listingId:'tls-admission-refusal'});
  h.endpoints.get=(claim)=>prepared.composition.sellerEndpoint(claim,{newPurchase:true});
  const refused=await tool(h,user,'prepare_purchase',{listingId:listed.published.listingId,version:1,seller:listed.wallet.claim,idempotencyKey:'expired-seller-tls',protocol:'dacs-pay-dem'});
  assert.equal(refused.error,'seller_tls_unusable');assert.match(refused.message,/expired/);assert.ok(refused.message.includes(new Date(end).toISOString()));
  assert.equal(h.app.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='purchase'").get().n,0,'the API explains the refusal before creating a purchase');
  // Config edits do not shorten the purchase authority in a retained Listing.
  await operator.close();
  const retained=structuredClone(prepared.composition.listingDraft);retained.terms.deadlineSecAfterCommit=7200;
  await writeFile(join(f.stateDirectory,'listing-draft.json'),JSON.stringify(retained),{mode:0o600});
  time=end-windowMs-1;let restarted;
  try{restarted=await createDevnetDemoOperator({...f.options(),now:()=>time});const readiness=(await restarted.prepareDevnetDemo()).operatorEvidence.sellerTls;assert.equal(readiness.status,'unusable');assert.match(readiness.reason,/purchase window of 9900000 ms/);}finally{await restarted?.close();}
  // A longer edited config also cannot replace a shorter retained Listing.
  await writeFile(join(f.stateDirectory,'listing-draft.json'),JSON.stringify(prepared.composition.listingDraft),{mode:0o600});
  await writeFile(f.configPath,JSON.stringify({...f.config,listing:{...f.config.listing,deadlineSecAfterCommit:7200}}),{mode:0o600});
  const accepted=await createDevnetDemoOperator({...f.options(),now:()=>time});
  try{assert.equal((await accepted.prepareDevnetDemo()).operatorEvidence.sellerTls.status,'ready');}finally{await accepted.close();}
});

for(const kind of ['wrong-SAN','key-mismatch','clientAuth-only'])test(`hard TLS identity failure refuses startup: ${kind}`,{timeout:120000},async t=>{
  const f=await fixture(t);
  const other=createLoopbackTestTlsMaterial({temporaryRoot:f.root,san:kind==='wrong-SAN'?'DNS:localhost':'IP:127.0.0.1',...(kind==='clientAuth-only'?{extendedKeyUsage:'clientAuth'}:{})});
  await writeFile(kind==='key-mismatch'?f.config.sellerTls.keyPath:f.config.sellerTls.certificatePath,kind==='key-mismatch'?other.key:other.cert,{mode:0o600});
  if(kind!=='key-mismatch')await writeFile(f.config.sellerTls.keyPath,other.key,{mode:0o600});
  let operator;
  try{await assert.rejects(async()=>{operator=await createDevnetDemoOperator(f.options());},error=>{
    assert.equal(error.code,'seller_tls_unusable');
    assert.equal(error.message,kind==='wrong-SAN'?'seller TLS certificate seller origin hostname check failed':kind==='key-mismatch'?'seller TLS key/certificate secure context check failed':'seller TLS certificate extended key usage serverAuth check failed');return true;
  });assert.equal(existsSync(join(f.stateDirectory,'node2-transport.sqlite')),false);}finally{await operator?.close();}
});

// Paid, undelivered work restarts with a new leaf from the same trusted CA.
// No clock shift is used until recovery finishes: the Agreement remains live.
for(const minutesLeft of [0,75,105])test(`paid undelivered purchase resumes after real-clock TLS restart (${minutesLeft||'control'} minutes left)`,{timeout:240000},async t=>{
  const { createOperatorRecoveryNode2 } = await import('./helpers/devnet-operator-recovery-node2.mjs');
  const { createLoopbackTestCa } = await import('./helpers/loopback-test-ca.mjs');
  const root=await mkdtemp(join(tmpdir(),'seller-tls-restart-ca-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const ca=createLoopbackTestCa(root);let time=null;
  const h=await createOperatorRecoveryNode2({tlsFixture:ca.issue(Date.now()+86400000),authorizeSellerApproval:()=>true,authorizeBuyerApproval:()=>true,now:()=>time??Date.now()});t.after(()=>h.close());
  h.blockSellerClaims(true);
  const key=`tls-restart-${minutesLeft}`;
  try{await h.operator.createBuyerDriver({composition:h.composition}).purchase({idempotencyKey:key});}catch{/* a held claim can end the driver run */}
  const row=h.application.db.prepare("SELECT id,account_id FROM operations WHERE kind='purchase'").get();assert.ok(row);
  const retained=h.application.services.ops.get(row.account_id,row.id);
  assert.equal(retained.status,'settled_verified');assert.ok(h.blockedClaims>0);
  assert.notEqual(retained.state.protocol.stage,'delivery-ready');
  assert.equal(h.node2.chain.record.accepted.length,1,'the retained purchase really paid once');
  const deadline=retained.state.protocol.agreement.artifact.terms.deadline;
  const remaining=(deadline-Date.now())/60000;
  assert.ok(remaining>55&&remaining<=60,`restart is about 60 minutes before Agreement deadline: ${remaining}`);
  h.blockSellerClaims(false);
  if(minutesLeft){
    const next=ca.issue(Date.now()+minutesLeft*60000);
    await writeFile(h.config.sellerTls.keyPath,next.key,{mode:0o600});await writeFile(h.config.sellerTls.certificatePath,next.cert,{mode:0o600});
  }
  const end=Date.parse(new X509Certificate(await readFile(h.config.sellerTls.certificatePath)).validTo),windowMs=90*60000+SELLER_SESSION_KEY_GRACE_MS;
  await h.restart();
  const response=await fetch(h.config.publicOrigin+'/health');assert.equal(response.status,200);
  const health=await response.json();assert.equal(health.status,minutesLeft?'degraded':'ok');assert.equal(health.sellerTls.status,minutesLeft?'unusable':'ready');
  assert.equal(health.sellerTls.notAfter,new Date(end).toISOString());
  if(minutesLeft){assert.ok(health.sellerTls.notBefore);assert.equal(health.sellerTls.windowStartedAt,new Date(end-windowMs).toISOString());assert.throws(()=>h.prepared.composition.sellerEndpoint(h.prepared.operatorEvidence.seller,{newPurchase:true}),/purchase window/);}
  const resumed=await h.operator.createBuyerDriver({composition:h.composition}).resume({idempotencyKey:key});
  assert.equal(resumed.status,'delivery-ready',JSON.stringify(resumed));
  assert.equal(h.node2.chain.record.accepted.length,1,'operator recovery never resends payment');
  assert.equal(h.node2.chain.wire.record.accepted.length,7,'same CREATE count as the no-swap control');
  assert.ok(Date.now()<deadline,'recovery completes before the real Agreement deadline');
  // Preserve the live HTTP readiness check after real-clock recovery completes.
  time=end-windowMs-1;assert.equal((await fetch(h.config.publicOrigin+'/health').then(r=>r.json())).sellerTls.status,'ready');
  time=end-windowMs;assert.equal((await fetch(h.config.publicOrigin+'/health').then(r=>r.json())).sellerTls.status,'unusable');
});

test('balance read crossing the certificate admission boundary refuses the new purchase',{timeout:120000},async t=>{
  const f=await fixture(t),end=Date.parse(new X509Certificate(f.cert).validTo),windowMs=90*60*1000+SELLER_SESSION_KEY_GRACE_MS;
  let time=end-windowMs-1;
  const operator=await createDevnetDemoOperator({...f.options(),now:()=>time});t.after(()=>operator.close());
  const prepared=await operator.prepareDevnetDemo();
  let balanceRead=false,advanceClockOnFunds=false;
  const h=await startProtocolHarness({fetchImpl:async(url,options)=>{
    const response=await fetch(url,options);
    if(advanceClockOnFunds&&options?.body?.includes('getAddressInfo')){balanceRead=true;time=end-windowMs;}
    return response;
  }});t.after(()=>h.close());
  const user=await linkedUser(h),listed=await addSeller(h,{listingId:'balance-read-crosses-window'});
  const fixtureEndpoint=h.endpoints.get(listed.wallet.claim);assert.ok(fixtureEndpoint);
  // Exercise the operator gate, then return the actual harness endpoint. The
  // standalone operator has no attached endpoint map in this admission test.
  h.endpoints.get=()=>{prepared.composition.sellerEndpoint(prepared.operatorEvidence.seller,{newPurchase:true});return fixtureEndpoint;};
  advanceClockOnFunds=true;
  const refused=await tool(h,user,'prepare_purchase',{listingId:listed.published.listingId,version:1,seller:listed.wallet.claim,idempotencyKey:'late-balance',protocol:'dacs-pay-dem'});
  assert.equal(balanceRead,true,'the admission boundary is crossed by the balance read itself');
  assert.equal(refused.error,'seller_tls_unusable',JSON.stringify(refused));
  assert.equal(h.app.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='purchase'").get().n,0);
});

for(const offset of [0,1])test(`still-valid startup inside purchase window is degraded (offset ${offset})`,{timeout:120000},async t=>{
  const f=await fixture(t),x509=new X509Certificate(f.cert),end=Date.parse(x509.validTo),windowMs=90*60*1000+SELLER_SESSION_KEY_GRACE_MS;
  const operator=await createDevnetDemoOperator({...f.options(),now:()=>end-windowMs+offset});t.after(()=>operator.close());
  const readiness=(await operator.prepareDevnetDemo()).operatorEvidence.sellerTls;
  assert.equal(readiness.status,'unusable');assert.match(readiness.reason,/purchase window of 6300000 ms/);assert.equal(readiness.notBefore,new Date(x509.validFrom).toISOString());assert.equal(readiness.notAfter,new Date(end).toISOString());assert.equal(readiness.windowStartedAt,new Date(end-windowMs).toISOString());
});

test('certificate expiring while a retained Listing is read still refuses construction before attachment',{timeout:120000},async t=>{
  const f=await fixture(t),end=Date.parse(new X509Certificate(f.cert).validTo);
  let time=Date.now();
  const first=await createDevnetDemoOperator({...f.options(),now:()=>time});await first.close();
  const read=fsp.readFile;let restarted,readRetained=false;
  // Advance only this owned fixture's clock at its exact retained Listing read.
  // Keep real filesystem bytes, TLS checks and cleanup; restore the builtin in all cases.
  fsp.readFile=async(...args)=>{const value=await read(...args);if(args[0]===join(f.stateDirectory,'listing-draft.json')){readRetained=true;time=end;}return value;};
  syncBuiltinESMExports();
  try{
    await assert.rejects(async()=>{restarted=await createDevnetDemoOperator({...f.options(),now:()=>time});},error=>error.code==='seller_tls_unusable'&&/expired/.test(error.message));
    assert.equal(readRetained,true);
  }finally{fsp.readFile=read;syncBuiltinESMExports();await restarted?.close();}
});

// Exercise production's default fetch and CA store in a fresh process: Node
// loads NODE_EXTRA_CA_CERTS once, before either fetch or tls.connect is used.
for(const kind of ['trusted','keyCertSign-only','untrusted'])test(`default-client seller TLS handshake: ${kind}`,{timeout:120000},async t=>{
  const f=await fixture(t);
  if(kind==='keyCertSign-only'){
    const tls=createLoopbackTestTlsMaterial({temporaryRoot:f.root,extendedKeyUsage:'serverAuth',keyUsage:'critical,keyCertSign'});
    await writeFile(f.config.sellerTls.keyPath,tls.key,{mode:0o600});await writeFile(f.config.sellerTls.certificatePath,tls.cert,{mode:0o600});
  }
  const caPath=join(f.root,'client-ca.pem');
  // Always trust Node2. Only the untrusted case omits the seller certificate.
  await writeFile(caPath,f.node2Cert+(kind==='untrusted'?'':await readFile(f.config.sellerTls.certificatePath,'utf8')),{mode:0o600});
  const code=`
    import https from 'node:https';
    import net from 'node:net';
    import {createDevnetDemoOperator} from './src/devnet-demo/operator.mjs';
    import {createDevnetDemoComposition} from './src/devnet-demo/composition.mjs';
    import {createApp} from './src/app.mjs';
    let operator,composition,application,requests=0;
    // SNICallback runs only for a ClientHello that carries SNI; the default context still answers.
    const createServer=https.createServer,servernames=[];let connections=0;
    https.createServer=(options,handler)=>{
      const server=createServer({...options,SNICallback:(name,done)=>{servernames.push(name);done(null);}},(req,res)=>{requests++;handler(req,res);});
      server.on('connection',()=>{connections++;});return server;
    };
    let result;
    try {
      operator=await createDevnetDemoOperator({configPath:process.argv[1],authorizeSellerApproval:()=>true});
      const prepared=await operator.prepareDevnetDemo();
      composition=await createDevnetDemoComposition(prepared.composition);
      application=await createApp({config:prepared.config,dacsProtocol:composition.dacsProtocol,devnetAgreementTransport:prepared.devnetAgreementTransport});
      await operator.attachSellerAgent({sellerAgent:composition.sellerAgent,application,composition});
      await operator.listen({application,composition});
      result={ready:(await fetch(process.argv[2]+'/health').then(r=>r.json())).sellerTls.status};
    } catch(error) {
      const config=JSON.parse(await (await import('node:fs/promises')).readFile(process.argv[1],'utf8'));
      const listening=await Promise.all([config.publicOrigin,config.sellerOrigin,config.directoryOrigin].map(origin=>new Promise(resolve=>{
        const socket=net.connect({host:'127.0.0.1',port:Number(new URL(origin).port)});
        socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));
      })));
      result={code:error.code,message:error.message,closedOnFailure:listening.every(value=>!value)};
    }
    finally {await operator?.close();await application?.close();composition?.sellerAgent?.close();}
    console.log(JSON.stringify({...result,requests,servernames,connections}));
  `;
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--input-type=module','-e',code,f.configPath,f.config.publicOrigin],{env:{...process.env,NODE_EXTRA_CA_CERTS:caPath},stdio:['ignore','pipe','pipe']});
    let out='',err='';child.stdout.on('data',chunk=>{out+=chunk;});child.stderr.on('data',chunk=>{err+=chunk;});
    const timer=setTimeout(()=>child.kill('SIGKILL'),90000);
    child.once('error',reject);child.once('close',exit=>{clearTimeout(timer);if(exit!==0)return reject(new Error(`startup child exit ${exit}: ${err}`));resolve(JSON.parse(out.trim().split('\n').at(-1)));});
  });
  assert.equal(result.requests,0,'the TLS-only probe never reaches the seller HTTP handler');
  // Like fetch, the probe sends no SNI for the IP-literal seller origin.
  assert.deepEqual(result.servernames,[],'no SNI reached the seller listener');
  assert.equal(result.connections,kind==='trusted'?2:1,'attachment and listen each probe once');
  if(kind==='trusted')assert.equal(result.ready,'ready',JSON.stringify(result));
  else {
    assert.equal(result.closedOnFailure,true,'startup closes opened listeners before returning its error');
    assert.equal(result.code,'seller_tls_unusable');
    assert.equal(result.message,`seller TLS client handshake failed (${kind==='keyCertSign-only'?'INVALID_PURPOSE':'DEPTH_ZERO_SELF_SIGNED_CERT'})`);
  }
  for(const origin of [f.config.publicOrigin,f.config.sellerOrigin,f.config.directoryOrigin]){
    const socket=net.connect({host:'127.0.0.1',port:Number(new URL(origin).port)});
    await new Promise((resolve,reject)=>{socket.once('connect',()=>{socket.destroy();reject(new Error('failed startup leaked a listener'));});socket.once('error',error=>{assert.equal(error.code,'ECONNREFUSED');resolve();});});
  }
});

test('DNS seller certificate requires a SAN even when localhost matches the CN',{timeout:120000},async t=>{
  const f=await fixture(t),tls=createLoopbackTestTlsMaterial({temporaryRoot:f.root,san:null,subject:'/CN=localhost'});
  await writeFile(f.config.sellerTls.keyPath,tls.key,{mode:0o600});await writeFile(f.config.sellerTls.certificatePath,tls.cert,{mode:0o600});
  await writeFile(f.configPath,JSON.stringify({...f.config,sellerOrigin:f.config.sellerOrigin.replace('127.0.0.1','localhost')}),{mode:0o600});
  let operator;try{await assert.rejects(async()=>{operator=await createDevnetDemoOperator(f.options());},error=>error.code==='seller_tls_unusable'&&error.message==='seller TLS certificate seller origin hostname check failed');}finally{await operator?.close();}
});

test('a low-balance buyer receives the protocol hold before any funds read',{timeout:120000},async t=>{
  const identity='a'.repeat(64);
  const h=await startProtocolHarness({chainIdentityPin:identity,fetchImpl:async(url,options)=>{
    const response=await fetch(url,options);
    if(options?.body?.includes('getBlockByNumber')&&JSON.parse(options.body).params[0].data.blockNumber===0){
      const headers=new Headers(response.headers);headers.delete('x-dacs-simulation');headers.delete('content-length');
      return new Response(JSON.stringify({result:200,response:{number:0,hash:identity,status:'confirmed',content:{}}}),{status:200,headers});
    }
    return response;
  }});t.after(()=>h.close());
  const buyer=await linkedUser(h),seller=await addSeller(h,{listingId:'low-balance-held-protocol'});
  h.chain.setBalance(buyer.wallet.address,'0');
  const before=h.chain.faults.rpcCalls.filter(call=>call==='getAddressInfo').length;
  const answer=await tool(h,buyer,'prepare_purchase',{listingId:seller.published.listingId,version:1,seller:seller.wallet.claim,idempotencyKey:'held-before-funds',protocol:'dacs-pay-dem'});
  assert.equal(answer.error,'dacs_protocol_held',JSON.stringify(answer));
  assert.equal(h.chain.faults.rpcCalls.filter(call=>call==='getAddressInfo').length,before);
});

// An injected fetch uses precisely its own CA for the harmless HTTP probe.
for(const phase of ['attach','listen'])test(`injected-client TLS refusal closes the operator during ${phase}`,{timeout:120000},async t=>{
  const f=await fixture(t);
  let trusted=phase==='listen';
  const client=injectedSellerFetch(f,{trusted:()=>trusted}),a=await composed(t,f,client.fetchImpl);
  if(phase==='listen'){await a.attach();trusted=false;}
  await assert.rejects(phase==='attach'?a.attach:a.listen,error=>error.code==='seller_tls_unusable'&&error.message==='seller TLS client handshake failed (DEPTH_ZERO_SELF_SIGNED_CERT)');
  // Only the probe was sent: a GET that follows no redirect and sends no credentials.
  assert.deepEqual(client.requests,Array(phase==='attach'?1:2).fill(PROBE));
  await allRefuse(f);
});

// Attachment is one-shot: nothing opens after close, and close waits for an
// attachment in flight, which closes what it opened itself.
test('seller attachment after close is refused before anything opens',{timeout:120000},async t=>{
  const f=await fixture(t),client=injectedSellerFetch(f),a=await composed(t,f,client.fetchImpl);
  await a.operator.close();
  let swept=0;
  const composition={...a.composition,contextProvider:{...a.composition.contextProvider,sweep:async()=>{swept++;}}};
  await assert.rejects(a.attach({composition}),error=>error.code==='operator_closing');
  assert.equal(swept,0,'not even the party Vet sweep ran');
  assert.deepEqual(client.requests,[],'no listener was probed');
  assert.equal(existsSync(join(f.stateDirectory,'seller-transport.sqlite')),false,'no seller store was opened');
  await allRefuse(f);
});

test('close during seller attachment leaves every listener closed',{timeout:180000},async t=>{
  // Before the seller listener opens (with the custody buyer's run store, and
  // with open buyer access, which has none), and while its handshake runs.
  for(const moment of ['before-listener','before-listener-open-access','during-handshake']){
    const f=await fixture(t);let a,closing,closeStarted;
    if(moment==='before-listener-open-access')await withConfig(f,{openBuyerAccess:true});
    const started=new Promise(resolve=>{closeStarted=resolve;});
    const startClose=()=>{closing??=a.operator.close();closeStarted();return closing;};
    // The probe waits for close (2 s at most): a close that did not wait for
    // the attachment would return while the seller listener is still open.
    const client=injectedSellerFetch(f,{onSellerRequest:()=>{
      if(moment!=='during-handshake')return;
      let timer;return Promise.race([startClose(),new Promise(resolve=>{timer=setTimeout(resolve,2000);})]).finally(()=>clearTimeout(timer));
    }});
    a=await composed(t,f,client.fetchImpl);
    const attaching=a.attach();attaching.catch(()=>{});
    if(moment!=='during-handshake')startClose();
    await started;await closing;
    await allRefuse(f);
    await assert.rejects(attaching,error=>error.code==='operator_closing',moment);
    assert.deepEqual(client.requests,moment==='during-handshake'?[PROBE]:[],moment);
    // A close during the party Vet sweep stops the attachment before its store and listener.
    if(moment!=='during-handshake')assert.equal(existsSync(join(f.stateDirectory,'seller-transport.sqlite')),false,`${moment}: no seller store was opened`);
    await assert.rejects(a.attach(),error=>error.code==='operator_closing',`${moment}: a later attachment opens nothing`);
  }
});

test('a seller agent attaches once; the first listener stays the one served and closes with the operator',{timeout:120000},async t=>{
  // The first probe is held, so the attachment is in flight with its listener open.
  let release,reached;const held=new Promise(resolve=>{release=resolve;}),atProbe=new Promise(resolve=>{reached=resolve;});
  const f=await fixture(t),client=injectedSellerFetch(f,{onSellerRequest:()=>{if(client.requests.length>1)return;reached();return held;}}),a=await composed(t,f,client.fetchImpl);
  const first=a.attach();
  await assert.rejects(a.attach(),error=>error.code==='seller_attach_in_progress');
  await atProbe;
  await assert.rejects(a.attach(),error=>error.code==='seller_attach_in_progress');
  await assert.rejects(a.listen(),error=>error.message==='authenticated seller agent must be attached before listen','an attachment in flight has published nothing');
  await refusesConnections(f.config.directoryOrigin);
  release();
  await first;
  await assert.rejects(a.attach(),error=>error.code==='seller_already_attached');
  assert.deepEqual(client.requests,[PROBE],'refused attachments probe nothing');
  await a.listen();
  const answer=await client.fetchImpl(`${f.config.sellerOrigin}/dacs/v1/agreements/proposals`,{method:'GET'});
  assert.equal(answer.status,405,'the first attachment\'s seller handler answers');
  await a.operator.close();
  await allRefuse(f);
});

// an earlier review (a review P2, code P3): until every attach check has passed,
// the seller listener answers only the TLS probe, and the operator publishes
// nothing a request or a resume pass could use: no seller endpoint, no
// evidence resume pass. An early request is refused, never served.
test('a seller request arriving before attachment completes is refused, never served',{timeout:120000},async t=>{
  const f=await fixture(t);
  // Delivery evidence on, so the attachment has an evidence resume pass to publish.
  await withConfig(f,{sellerDeliveryEvidence:{enabled:true}});
  let release,reached;const held=new Promise(resolve=>{release=resolve;}),atProbe=new Promise(resolve=>{reached=resolve;});
  const probes=()=>client.requests.filter(request=>request.path===PROBE.path).length;
  // Only the attachment's own handshake probe is held.
  const client=injectedSellerFetch(f,{onSellerRequest:(url)=>{if(new URL(url).pathname!==PROBE.path||probes()>1)return;reached();return held;}}),a=await composed(t,f,client.fetchImpl);
  const claim=a.composition.sellerAgent.claim,route=`${f.config.sellerOrigin}/dacs/v1/agreements/proposals`;
  const attaching=a.attach();attaching.catch(()=>{});
  await atProbe;
  // The listener is open and its handshake is in flight.
  for(const options of [{method:'GET'},{method:'POST',body:'{}'}]){
    const answer=await client.fetchImpl(route,options);
    assert.equal(answer.status,503,`${options.method}: refused before the seller handler`);
    assert.deepEqual(await answer.json(),{error:'seller_not_attached'});
    assert.deepEqual([answer.headers.get('cache-control'),answer.headers.get('connection')],['no-store','close']);
  }
  // The probe path keeps the seller handler's fixed loopback answer.
  const probe=await client.fetchImpl(`${f.config.sellerOrigin}${PROBE.path}`,{method:'GET'});
  assert.deepEqual([probe.status,await probe.json(),probe.headers.get('cache-control'),probe.headers.get('connection')],[404,{error:'not_found'},'no-store','close']);
  assert.equal(a.composition.dacsProtocol.sellerEndpoint(claim),null,'no seller endpoint is published while attaching');
  assert.equal(a.operator.resumeHeldDeliveryEvidence(),null,'no evidence resume pass is published while attaching');
  release();await attaching;
  assert.equal(a.composition.dacsProtocol.sellerEndpoint(claim),f.config.sellerOrigin);
  assert.deepEqual(await a.operator.resumeHeldDeliveryEvidence(),[],'the published pass runs (no held evidence here)');
  // None of the early requests reached the seller handler: all 120 of its first window do now.
  const statuses=[];
  for(let i=0;i<121;i++)statuses.push((await client.fetchImpl(route,{method:'GET'})).status);
  assert.deepEqual(statuses.slice(0,120),Array(120).fill(405),'the attached seller handler answers');
  assert.equal(statuses[120],429,'the early refusals spent none of the seller request budget');
});

test('a session initialization failure after the handshake closes the seller listener and surfaces',{timeout:120000},async t=>{
  const f=await fixture(t);
  // A retained seller session store makes attachment initialize session cleanup.
  await mkdir(join(f.stateDirectory,'seller-sessions'),{recursive:true,mode:0o700});
  const client=injectedSellerFetch(f),a=await composed(t,f,client.fetchImpl);
  const stores=await transportStores(()=>assert.rejects(a.attach({application:{...a.application,services:{}}}),error=>error.message==='seller session cleanup needs the application purchase store to retire seller session keys'));
  assert.deepEqual(stores,[true],'the attachment closed the seller transport store it opened');
  assert.deepEqual(client.requests,[PROBE],'the failure follows a successful handshake');
  await allRefuse(f);
});

test('the injected-client TLS probe spends none of the seller request budget',{timeout:120000},async t=>{
  const f=await fixture(t),client=injectedSellerFetch(f),a=await composed(t,f,client.fetchImpl);
  await a.attach();await a.listen();
  assert.deepEqual(client.requests,[PROBE,PROBE]);
  const statuses=[];
  for(let i=0;i<121;i++)statuses.push((await client.fetchImpl(`${f.config.sellerOrigin}/dacs/v1/agreements/proposals`,{method:'GET'})).status);
  assert.deepEqual(statuses.slice(0,120),Array(120).fill(405),'all 120 ordinary requests of the first window reach the seller routes');
  assert.equal(statuses[120],429,'the 121st exceeds that same window');
});

test('an injected client that ignores its abort signal is bounded by the probe timer',{timeout:15000},async()=>{
  let signal;
  const started=Date.now();
  await assert.rejects(assertSellerTlsClientHandshake('https://127.0.0.1:9',(_url,options)=>{signal=options.signal;return new Promise(()=>{});},false,{timeoutMs:50}),
    error=>error.code==='seller_tls_unusable'&&error.message==='seller TLS client handshake failed (ETIMEDOUT)');
  assert.equal(signal.aborted,true,'the probe signal is aborted too');
  assert.ok(Date.now()-started<5000);
  // A probe that settles clears its 10 s timer at once.
  const timers=()=>process.getActiveResourcesInfo().filter(type=>type==='Timeout').length,before=timers();
  await assertSellerTlsClientHandshake('https://127.0.0.1:9',async()=>new Response(null,{status:404}),false);
  assert.equal(timers(),before,'a settled probe leaves no timer behind');
});
