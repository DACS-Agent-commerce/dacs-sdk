import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../src/config.mjs';
import { createDevnetDemoOperator } from '../src/devnet-demo/operator.mjs';
import { bootstrapTestWalletCustody } from '../src/devnet-demo/operator-custody.mjs';
import { admitObservedNode2Identity, observeNode2Identity } from '../src/devnet-demo/operator-network.mjs';
import { createLoopbackTestTlsMaterial } from './helpers/loopback-test-tls.mjs';
import { startOperatorNode2 } from './helpers/devnet-operator-node2.mjs';

// createDevnetDemoOperator is all-or-nothing: a construction failure closes
// every journal, transport and listener it opened (newest first) and rethrows
// the original error, so a caller that catches it can bind the same port and
// construct again.

const JOURNALS=['node2-transport.sqlite','seller-artifacts.sqlite','seller-wallet.sqlite'];
const freePort=()=>new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const canBind=(port)=>new Promise((resolve)=>{const server=net.createServer();server.once('error',()=>resolve(false));server.listen(port,'127.0.0.1',()=>server.close(()=>resolve(true)));});
const resources=()=>process.getActiveResourcesInfo().reduce((counts,kind)=>({...counts,[kind]:(counts[kind]??0)+1}),{});
const extraResources=(before)=>Object.entries(resources()).filter(([kind,count])=>count>(before[kind]??0)).map(([kind,count])=>`${kind}+${count-(before[kind]??0)}`);
const sleep=(ms)=>new Promise((resolve)=>setTimeout(resolve,ms));
const forceClose=(server)=>new Promise((resolve)=>{if(!server.listening)return resolve();server.closeAllConnections();http.Server.prototype.close.call(server,()=>resolve());});

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
  return{appPort,ports:[appPort,sellerPort,directoryPort],stateDirectory,wallet,options:()=>({configPath,fetchImpl:testFetch,authorizeSellerApproval:()=>true})};
}

// Runs the constructor while recording every http server it creates, so a
// listener the constructor leaks (as on the base commit) is still closed after
// the assertions and cannot keep this test process alive.
async function construct(t,options,{onServer}={}){
  const created=[],listened=[],createServer=http.createServer;
  http.createServer=function(...args){const server=createServer.apply(this,args);created.push(server);server.once('listening',()=>listened.push(server.address().port));onServer?.(server);return server;};
  t.after(()=>Promise.all(created.map(forceClose)));
  let outcome;
  try{outcome=await createDevnetDemoOperator(options).then((operator)=>({operator}),(error)=>({error}));}finally{http.createServer=createServer;}
  if(outcome.operator){await outcome.operator.close();assert.fail('operator construction was expected to fail');}
  return{error:outcome.error,created,listened};
}

async function assertReleased(f,before){
  for(const port of f.ports)assert.equal(await canBind(port),true,`port ${port} is free for a new server`);
  for(const name of JOURNALS)assert.equal(existsSync(join(f.stateDirectory,`${name}-wal`)),false,`${name} is closed (no open WAL)`);
  let extra=extraResources(before);
  for(let attempt=0;extra.length&&attempt<100;attempt++){await sleep(50);extra=extraResources(before);}
  assert.deepEqual(extra,[],'construction failure leaves no new active handles');
}

async function assertRetrySucceeds(f){
  const operator=await createDevnetDemoOperator(f.options());
  try{const prepared=await operator.prepareDevnetDemo();assert.equal(prepared.config.publicOrigin,`http://127.0.0.1:${f.appPort}`);assert.equal(prepared.operatorEvidence.sellerTls.status,'ready');}finally{await operator.close();}
  assert.equal(await canBind(f.appPort),true);
}

test('a refused DACS_DELIVERY_DEADLINE_WATCH fails before any journal or listener opens; the port is free and a retry succeeds',{timeout:120000},async t=>{
  const f=await fixture(t);
  const previous=process.env.DACS_DELIVERY_DEADLINE_WATCH;
  const restore=()=>{if(previous===undefined)delete process.env.DACS_DELIVERY_DEADLINE_WATCH;else process.env.DACS_DELIVERY_DEADLINE_WATCH=previous;};
  t.after(restore);
  process.env.DACS_DELIVERY_DEADLINE_WATCH='maybe';
  const before=resources();
  const {error}=await construct(t,f.options());
  assert.ok(error instanceof ConfigError,`original ConfigError is rethrown (got ${error?.name}: ${error?.message})`);
  assert.match(error.message,/^DACS_DELIVERY_DEADLINE_WATCH must be off or on$/);
  assert.equal(error.suppressed,undefined);
  await assertReleased(f,before);
  for(const name of JOURNALS)assert.equal(existsSync(join(f.stateDirectory,name)),false,`${name} is never opened when the app config is refused`);
  restore();
  await assertRetrySucceeds(f);
});

test('a seller custody refusal after the listener opens closes the listener, transport and journals and rethrows the original error',{timeout:120000},async t=>{
  const f=await fixture(t);
  await chmod(f.wallet('seller'),0o644);
  const before=resources();
  const {error,listened}=await construct(t,f.options());
  assert.match(error?.message??'',/^operator wallet files must be private real mode-0600 files owned by this process user$/);
  assert.deepEqual(listened,[f.appPort],'the failure came after the relay listener opened');
  assert.equal(error.suppressed,undefined);
  for(const name of JOURNALS)assert.equal(existsSync(join(f.stateDirectory,name)),true,`${name} was opened before the failure`);
  await assertReleased(f,before);
  await chmod(f.wallet('seller'),0o600);
  await assertRetrySucceeds(f);
});

test('a failure after both custody wallets open (unreadable listing draft) still releases everything',{timeout:120000},async t=>{
  const f=await fixture(t);
  await mkdir(f.stateDirectory,{recursive:true,mode:0o700});
  const draftPath=join(f.stateDirectory,'listing-draft.json');await mkdir(draftPath);
  const before=resources();
  const {error,listened}=await construct(t,f.options());
  assert.equal(error?.code,'EISDIR',`original read error is rethrown (got ${error?.code}: ${error?.message})`);
  assert.deepEqual(listened,[f.appPort],'the failure came after the relay listener opened');
  assert.equal(error.suppressed,undefined);
  await assertReleased(f,before);
  await rmdir(draftPath);
  await assertRetrySucceeds(f);
});

test('a cleanup step that fails does not hide the original error; the rest still closes, newest first',{timeout:120000},async t=>{
  const f=await fixture(t);
  await chmod(f.wallet('seller'),0o644);
  const injected=new Error('injected relay close failure');const journalsOpenAtRelayClose=[];
  const before=resources();
  const {error,created,listened}=await construct(t,f.options(),{onServer:(server)=>{server.close=()=>{
    journalsOpenAtRelayClose.push(...JOURNALS.map((name)=>existsSync(join(f.stateDirectory,`${name}-wal`))));throw injected;
  };}});
  assert.match(error?.message??'',/^operator wallet files must be private real mode-0600 files owned by this process user$/,'the original error is rethrown, not the cleanup failure');
  assert.ok(!(error instanceof AggregateError));assert.deepEqual(listened,[f.appPort]);
  assert.ok(error.suppressed instanceof AggregateError,'the cleanup failure is attached to the original error');
  assert.equal(error.suppressed.errors.length,1);assert.equal(error.suppressed.errors[0],injected);
  assert.deepEqual(journalsOpenAtRelayClose,[true,true,true],'the relay listener closes before the journals it was opened after');
  for(const name of JOURNALS)assert.equal(existsSync(join(f.stateDirectory,`${name}-wal`)),false,`${name} still closes after the relay close failed`);
  // Only the listener whose close was made to fail is still open; close it here.
  const relay=created.filter((server)=>server.listening);assert.equal(relay.length,1);
  assert.equal(relay[0].address().port,f.appPort);await forceClose(relay[0]);
  await assertReleased(f,before);
  await chmod(f.wallet('seller'),0o600);
  await assertRetrySucceeds(f);
});

test('a failed first listen (EADDRINUSE) closes the journals it opened and rethrows the listen error; a retry after the port frees succeeds',{timeout:120000},async t=>{
  const f=await fixture(t);
  const blocker=net.createServer();await new Promise((resolve,reject)=>{blocker.once('error',reject);blocker.listen(f.appPort,'127.0.0.1',resolve);});
  t.after(()=>new Promise((resolve)=>blocker.listening?blocker.close(()=>resolve()):resolve()));
  const before=resources();
  const {error,listened}=await construct(t,f.options());
  assert.equal(error?.code,'EADDRINUSE',`original listen error is rethrown (got ${error?.code}: ${error?.message})`);
  assert.deepEqual(listened,[],'the relay never listened');
  assert.equal(error.suppressed,undefined);
  for(const name of JOURNALS){
    assert.equal(existsSync(join(f.stateDirectory,name)),true,`${name} was opened before the listen`);
    assert.equal(existsSync(join(f.stateDirectory,`${name}-wal`)),false,`${name} is closed (no open WAL)`);
  }
  await new Promise((resolve)=>blocker.close(()=>resolve()));
  await assertReleased(f,before);
  await assertRetrySucceeds(f);
});

test('a relay request still sending its body when construction fails is not an unhandled rejection; the original error is rethrown and the port is reusable',{timeout:120000},async t=>{
  const f=await fixture(t);
  await chmod(f.wallet('seller'),0o644);
  const rejections=[],onRejection=(reason)=>rejections.push(reason);
  process.on('unhandledRejection',onRejection);t.after(()=>process.off('unhandledRejection',onRejection));
  const before=resources();
  let client=null,requestClosed=null;
  // The relay's listen callback, which resumes the constructor, runs only once
  // a partial request is inside the relay handler waiting for the rest of its
  // body. The constructor then fails (seller wallet mode) and its cleanup
  // resets that connection mid-body.
  const holdPartialRequest=(server)=>new Promise((resolve)=>{
    server.once('request',(req)=>{requestClosed=new Promise((done)=>req.once('close',done));resolve();});
    client=net.connect(server.address().port,'127.0.0.1',()=>client.write('POST / HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"jsonrpc":'));
    client.on('error',()=>{});
  });
  t.after(()=>client?.destroy());
  const {error,listened}=await construct(t,f.options(),{onServer:(server)=>{
    const listen=server.listen;server.listen=function(port,host,callback){return listen.call(this,port,host,()=>holdPartialRequest(this).then(callback));};
  }});
  assert.match(error?.message??'',/^operator wallet files must be private real mode-0600 files owned by this process user$/,'the original error is rethrown');
  assert.deepEqual(listened,[f.appPort],'the failure came after the relay listener opened');
  assert.equal(error.suppressed,undefined);
  assert.ok(requestClosed,'a partial request was held open inside the relay');
  await requestClosed;
  // The reset body read rejects after the close; give a detached rejection time to surface.
  await sleep(200);
  assert.deepEqual(rejections.map((reason)=>`${reason?.code}: ${reason?.message}`),[],'no unhandled rejection from the reset relay request');
  client.destroy();
  await assertReleased(f,before);
  await chmod(f.wallet('seller'),0o600);
  await assertRetrySucceeds(f);
  assert.deepEqual(rejections,[]);
});

test('cleanup failures keep an existing suppressed value, and are reported on stderr when they cannot be attached',{timeout:180000},async t=>{
  const prior=new Error('earlier suppressed failure');
  const cases=[
    {name:'error with an own suppressed',make:()=>Object.assign(new Error('late construction failure'),{suppressed:prior}),attached:true},
    {name:'frozen error',make:()=>Object.freeze(new Error('frozen late construction failure')),attached:false},
    {name:'primitive',make:()=>'primitive late construction failure',attached:false},
  ];
  for(const item of cases)await t.test(item.name,async t=>{
    const f=await fixture(t);
    const thrown=item.make(),injected=new Error('injected relay close failure');let listening=false;
    // The first now() after the relay listens (the listing draft) throws the
    // test's own value; the relay's close is made to fail during cleanup.
    const options={...f.options(),now:()=>{if(listening)throw thrown;return Date.now();}};
    const lines=[],write=process.stderr.write;
    process.stderr.write=function(chunk,...rest){lines.push(String(chunk));return write.call(this,chunk,...rest);};
    let outcome;
    try{outcome=await construct(t,options,{onServer:(server)=>{server.once('listening',()=>{listening=true;});server.close=()=>{throw injected;};}});}
    finally{process.stderr.write=write;}
    const {error,created}=outcome;
    assert.equal(error,thrown,'the original value is rethrown as is');
    const notes=lines.filter((line)=>line.startsWith('devnet-operator-construction:'));
    if(item.attached){
      assert.ok(error.suppressed instanceof AggregateError);
      assert.deepEqual(error.suppressed.errors,[prior,injected],'the existing suppressed value is kept first');
      assert.deepEqual(notes,[]);
    }else{
      if(typeof error==='object')assert.equal(Object.hasOwn(error,'suppressed'),false);
      assert.deepEqual(notes,['devnet-operator-construction: 1 cleanup failure(s) could not be attached to the original error\n']);
    }
    for(const server of created.filter((server)=>server.listening))await forceClose(server);
    for(const port of f.ports)assert.equal(await canBind(port),true,`port ${port} is free for a new server`);
  });
});
