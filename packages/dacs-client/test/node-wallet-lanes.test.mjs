import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { rmSync } from 'node:fs';
import { runFreshChild } from './helpers/fresh-node-child.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { api, world, mnemonicBytes, setPurchaseAdmission, T0 } from './helpers/tp1-node-fixture.mjs';

test("an accepted native send is broadcast once; its lane stays readback-only across a restart of the composition", async t => {
const w=await world(t); const sent=await w.send(); assert.equal(sent.success,true,JSON.stringify(sent)); assert.equal(w.node.broadcasts.length,1); await w.restart(); assert.equal(w.node.broadcasts.length,1); const again=await w.send(); assert.equal(again.success,false); assert.equal(w.node.broadcasts.length,1);
});

test("a refused or lost broadcast answer is never resent, also after restart", async t => {
for(const mode of ['refuse','drop','503','auth-refuse']) { const w=await world(t); w.node.mode=mode; const result=await w.send(); assert.equal(result.success,false); await w.restart(); await w.send(); assert.equal(w.node.broadcasts.length,1); assert.ok((await w.lane()).signedTransaction); }
});

test("killed after the transport records broadcast-started and before the broadcast call; restart sends nothing by itself and readback decides", async t => {
await crashAndRestart(t, 'after-hash-intent');
});

test("two overlapping sends on one wallet serialize on the lane; neither is sent twice", async t => {
const w=await world(t); const results=await Promise.all([w.send(),w.send()]); assert.equal(results.filter(r=>r.success).length,1,JSON.stringify(results)); assert.equal(w.node.broadcasts.length,1);
});

test("confirmTx answering valid:false is confirm_rejected, nothing is broadcast and the lane is released", async t => {
const w=await world(t); w.node.mode='confirm-refuse'; const result=await w.send(); assert.equal(result.error.code,'confirm_rejected',JSON.stringify(result)); assert.equal(w.node.broadcasts.length,0); w.node.mode='accept'; assert.equal((await w.send()).success,true);
});

test('restart at signature-return and confirm-send cuts through the Node session', async t => {
 for(const mode of ['before-confirm','confirm-lost']) { const w=await world(t); w.node.mode=mode;
 w.node.intercept=async row=>{if(mode==='before-confirm'&&row.body.params[0].extra==='confirmTx')throw new Error('TEST-cut-before-confirm');};
 await w.send(); assert.equal(w.node.broadcasts.length,0); await w.restart(); assert.equal(w.node.broadcasts.length,0); }
});
test('kill between lane and hash-intent puts keeps native payment readback-only', async t => {
 await crashAndRestart(t, 'before-hash-intent');
});

async function crashAndRestart(t, cut) {
 const source=`
 import {writeFileSync} from 'node:fs';
 import {world} from ${JSON.stringify(new URL('./helpers/tp1-node-fixture.mjs',import.meta.url).href)};
 const cut=process.argv[2];
 const w=await world({after(){}},{journalWrap:journal=>({...journal,put:async(key,value)=>{
  if(key.startsWith('devnet/native-transfer/')&&value.stage==='broadcast-started'){
   if(cut==='after-hash-intent')await journal.put(key,value);
   process.kill(process.pid,'SIGKILL');
  }
  return journal.put(key,value);
 }})});
 writeFileSync('result.json',JSON.stringify({path:w.path,request:w.request}));
 await w.send();
 `;
 const child=runFreshChild(t,source,[cut]);assert.equal(child.status,null);assert.ok(child.result?.path,child.stderr);
 const {path,request}=child.result;t.after(()=>rmSync(dirname(path),{recursive:true,force:true}));
 const journal=openDurableWalletJournal({path,mode:'open'});t.after(()=>journal.close());
 const before=(await journal.entries()).find(([key])=>key.startsWith('devnet/native-wallet/'))[1];
 assert.equal(before.stage,'broadcast-started');
 const intents=(await journal.entries()).filter(([key])=>key.startsWith('devnet/native-transfer/'));
 assert.equal(intents.length,cut==='after-hash-intent'?1:0);
 const calls=[];const owner=api.createNodeTransportOwner({endpoint:'https://rpc.example.invalid/',transportAuthority:'vector-authority',fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);calls.push(body); const message=body.params[0].message;
  if(message==='getBlockByNumber')return new Response(JSON.stringify({result:200,response:{number:0,status:'confirmed',hash:binding.profile.chainIdentity},require_reply:false,extra:null}),{headers:{'content-type':'application/json'}});
  if(message==='getTransactionStatus')return new Response(JSON.stringify({result:200,response:{state:'unknown'},require_reply:false,extra:null}),{headers:{'content-type':'application/json'}});
  return new Response(JSON.stringify({result:400,response:'error',require_reply:false,extra:null}),{headers:{'content-type':'application/json'}});
 }});t.after(()=>owner.close());
 const {binding}=await bindFixture({local:owner.currentLocal()});setPurchaseAdmission('testnet-tp1');t.after(()=>setPurchaseAdmission('held'));
 const session=await api.createNodeWalletSession({owner,journal,admission:{binding,currentLocal:owner.currentLocal},key:mnemonicBytes(),clock:{now:()=>T0},approve:async()=>true});t.after(()=>session.close());
 assert.equal(calls.length,0,'restart alone sends nothing');
 const read=await session.wallet.request({method:'readNativeTransfer',params:[{hash:before.hash}]});assert.equal(read.success,true,JSON.stringify(read));assert.equal(read.data.noResend,true,JSON.stringify(read));
 const result=await session.wallet.request(request);assert.equal(result.error.code,'outcome_unknown');
 assert.ok(calls.every(body=>body.method==='nodeCall'));
 assert.deepEqual((await journal.entries()).find(([key])=>key.startsWith('devnet/native-wallet/'))[1].signedTransaction,before.signedTransaction);
}

test('a failed broadcast-intent write transmits nothing and restart preserves any retained native bytes', async t => {
 for(const cut of ['lane','hash']) {
  let armed=true;
  const w=await world(t,{journalWrap:journal=>({...journal,put:async(key,value)=>{
   if(armed&&value.stage==='broadcast-started'&&key.startsWith(cut==='lane'?'devnet/native-wallet/':'devnet/native-transfer/')){armed=false;throw Object.assign(new Error('TEST-intent-write-failed'),{code:'EIO'});}
   return journal.put(key,value);
  }})});
  await w.send();assert.equal(w.node.broadcasts.length,0);const lane=await w.lane();await w.restart();assert.equal(w.node.broadcasts.length,0);
  if(cut==='hash'){assert.equal(lane.stage,'broadcast-started');await w.send();assert.equal(w.node.broadcasts.length,0);assert.deepEqual((await w.lane()).signedTransaction,lane.signedTransaction);}
  else assert.equal(await w.lane(),undefined);
 }
});

test('acknowledgement persistence or lease release failure never repeats a native broadcast after restart', async t => {
 for(const cut of ['hash-ack','lane-ack','lease-release']) {
  let armed=false;
  const failure=()=>Object.assign(new Error('TEST-post-broadcast-failure'),{code:'EIO'});
  const w=await world(t,{
   journalWrap:journal=>({...journal,put:async(key,value)=>{
    const selected=key.startsWith(cut==='hash-ack'?'devnet/native-transfer/':'devnet/native-wallet/');
    if(armed&&cut!=='lease-release'&&selected&&value.stage==='broadcast-accepted'){armed=false;throw failure();}
    return journal.put(key,value);
   }}),
   ownerWrap:owner=>({...owner,acquireConnectionFence:async claim=>{
    const lease=await owner.acquireConnectionFence(claim);
    return {...lease,release(){lease.release();if(armed&&cut==='lease-release'){armed=false;throw failure();}}};
   }}),
  });
  w.node.intercept=async row=>{if(row.body.params[0].extra==='broadcastTx')armed=true;};
  await w.send();assert.equal(w.node.broadcasts.length,1);const before=await w.lane();
  assert.deepEqual(before.signedTransaction,w.node.broadcasts[0]);armed=false;w.node.intercept=null;
  await w.restart();assert.equal(w.node.broadcasts.length,1);await w.send();assert.equal(w.node.broadcasts.length,1);
  assert.deepEqual((await w.lane()).signedTransaction,before.signedTransaction);
 }
});
