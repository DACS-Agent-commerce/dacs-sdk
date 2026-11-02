// D16 launch review: a signed native transfer is broadcast at most once and an
// issued, lost or refused send stays readback-only, also after a restart.
// Readback reports it included only for a confirmed transaction in its
// confirmed block whose executed content is the original signed content.
// The real native transport, embedded wallet and durable journal run in this
// process against a scripted TEST node. A TEST stand-in for the injected Demos
// SDK class signs with a real Ed25519 key. No network, chain, funds or app.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDevnetNativeTransport, DEVNET_NATIVE_BINDING_PATH } from '../src/wallet/devnet-native-transport.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { createDevnetNativeWalletTransport, createSdkWalletSession } from '../src/public/portal/embedded-wallet/sdk-provider.mjs';

const OWNER='TEST-native-owner', ORIGIN='https://wallet.test', PAYEE='0x'+'7'.repeat(64);
const PINS={network:'testnet',chainIdentity:'c'.repeat(64),pinVersion:'TEST-native-pins',endpoint:'https://rpc.invalid/',transportAuthority:OWNER};
const CONTEXT={network:PINS.network,endpoint:PINS.endpoint,transportAuthority:OWNER,connectionId:'TEST-connection'};
const sha=v=>createHash('sha256').update(v).digest('hex');
const ok=response=>({result:200,response,require_reply:false,extra:null});
const same=v=>v;

// Applies an accepted (or dropped-after-apply) broadcast at the next nonce in
// block 1. view.tx/view.block change what readback is shown, not what applied.
function testNode() {
 // tamper rewrites the node's answer to a confirmTx, a broadcastTx (given the tx hash) or a nodeCall read.
 const node={nonce:0,broadcast:'accept',confirms:0,broadcasts:[],applied:new Map(),status:null,view:{tx:same,block:same},tamper:{confirm:same,broadcast:same,read:same}};
 node.fetch=async(url,init)=>{
  const body=JSON.parse(init.body),call=body.params[0];let answer;
  if(body.method==='nodeCall'){
   const {message,data}=call;
   if(message==='getBlockByNumber')answer=ok(data.blockNumber===0?{number:0,status:'confirmed',hash:PINS.chainIdentity,content:{}}
    :node.view.block({number:data.blockNumber,status:'confirmed',hash:'b'.repeat(64),content:{ordered_transactions:[...node.applied.keys()]}}));
   else if(message==='getAddressNonce')answer=ok(node.nonce);
   else if(message==='getNetworkParameters')answer=ok({networkFee:1,rpcFee:1,additionalFee:0});
   else if(message==='getTransactionStatus')answer=ok(node.status??(node.applied.has(data.hash)?{state:'included',blockNumber:1}:{state:'unknown'}));
   else if(message==='getTxByHash')answer=node.applied.has(data.hash)?ok(node.view.tx({...structuredClone(node.applied.get(data.hash)),status:'confirmed',blockNumber:1})):{result:400,response:'error',require_reply:false,extra:null};
   else throw new Error(`unexpected TEST node read ${message}`);
   answer=node.tamper.read(answer);
  } else if(call.extra==='confirmTx'){node.confirms++;answer=node.tamper.confirm(ok({data:{valid:true,gas_operation:null,transaction:call.data}}),call.data.hash);}
  else {
   const tx=call.data.response.data.transaction;node.broadcasts.push(tx.hash);
   if(node.broadcast==='refuse')answer={result:400,response:'TEST refusal',require_reply:false,extra:null};
   else {
    node.applied.set(tx.hash,structuredClone(tx));node.nonce=tx.content.nonce;
    if(node.broadcast==='drop-after-apply')throw new TypeError('TEST connection dropped after apply');
    answer=ok({message:'TEST accepted'});
   }
   answer=node.tamper.broadcast(answer,tx.hash);
  }
  return new Response(JSON.stringify(answer),{headers:{'content-type':'application/json'}});
 };
 return node;
}

// inclusionWaitMs 0 never polls; a positive wait polls once per ms with no real sleep.
async function world(t,{inclusionWaitMs=0}={}) {
 const dir=mkdtempSync(join(tmpdir(),'native-broadcast-once-')),path=join(dir,'journal.sqlite');
 const node=testNode(),calls=[],approvals=[];
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const address='0x'+Buffer.from(publicKey.export({format:'jwk'}).x,'base64url').toString('hex');
 const signText=m=>sign(null,Buffer.from(m,'utf8'),privateKey).toString('hex');
 // SDK request auth: fresh single-use stamps, kept apart from the wallet's own Date.now() stamps.
 let stamp=Date.now()+60000;
 const sdkAuth=()=>{const identity=`ed25519:${address}`,timestamp=String(stamp++);return {identity,timestamp,signature:signText(sha(`${identity}:${timestamp}`))};};
 let journal=openDurableWalletJournal({path,mode:'create'}),transport;
 const start=()=>{transport=createDevnetNativeTransport({expected:PINS,journal,fetchImpl:node.fetch,inclusionWaitMs,inclusionPollMs:1,sleep:async()=>{},
  transportOwner:{getContext:()=>({...CONTEXT}),acquireConnectionFence:()=>({context:{...CONTEXT},release(){}})}});};
 start();
 // The same-origin binding relay the wallet posts to. The wallet stamps its
 // bind and signature auth with Date.now(); the delay stands in for the HTTP
 // round trip, so the two stamps of one send never share a millisecond.
 const saved={location:globalThis.location,fetch:globalThis.fetch};
 globalThis.location=new URL(ORIGIN+'/');
 globalThis.fetch=async(url,init)=>{
  assert.equal(new URL(url).pathname,DEVNET_NATIVE_BINDING_PATH);
  await new Promise(resolve=>setTimeout(resolve,2));
  try{return Response.json(await transport.walletBinding(JSON.parse(init.body),init.headers));}
  catch(error){return Response.json({error:error.code??'internal_error'},{status:409});}
 };
 t.after(async()=>{Object.assign(globalThis,saved);await transport.close();journal.close();rmSync(dir,{recursive:true,force:true});});
 let validity=null,broadcastAnswer=null;
 class TestDemos {
  rpc_url=null;
  newMnemonic(){return 'TEST stand-in';}
  async connectWallet(){}
  getAddress(){return address;}
  disconnect(){}
  async signMessage(message){return {type:'ed25519',data:signText(message)};}
  async connect(url){calls.push('connect');this.rpc_url=url;}
  async nodeCall(message,data){calls.push(message);const answer=await transport.rpc({method:'nodeCall',params:[{message,data}]},{});return answer?.result===200?answer.response:null;}
  async sign(tx,{nonce}){
   calls.push('sign');
   const c=structuredClone(tx.content),edit=(type,operation,account,amount)=>({type,operation,isRollback:false,account,txhash:'',amount});
   Object.assign(c,{from:address,from_ed25519_address:address,nonce,transaction_fee:{network_fee:'1000000000',rpc_fee:'1000000000',additional_fee:'0',rpc_address:null},
    gcr_edits:[edit('balance','remove',address,c.amount),edit('balance','add',c.to,c.amount),edit('balance','remove',address,'1000000000'),edit('nonce','add',address,1)]});
   const hash=sha(JSON.stringify(c));
   return {content:c,signature:{type:'ed25519',data:signText(hash)},hash,status:'',blockNumber:null};
  }
  async confirm(signed){calls.push('confirm');validity=await transport.rpc({method:'execute',params:[{extra:'confirmTx',data:signed}]},sdkAuth());return validity;}
  // The SDK reports a failed broadcast request as result 500.
  async broadcast(confirmed){calls.push('broadcast');try{broadcastAnswer=await transport.rpc({method:'execute',params:[{extra:'broadcastTx',data:confirmed}]},sdkAuth());return broadcastAnswer;}catch{return {result:500,response:'TEST transport failure'};}}
 }
 const wallet=createSdkWalletSession({DemosCtor:TestDemos,transactionTransport:createDevnetNativeWalletTransport(transport.profile(ORIGIN)),approve:async request=>{approvals.push(request);return true;}});
 await wallet.create();
 assert.equal(wallet.getPublicAccount().address,address);
 const tx=buildNativeTransferPayload({from:address,to:PAYEE,amountOs:'2500000000',nonce:1,timestamp:Date.now(),encoding:'os-string'});
 return {node,calls,approvals,wallet,address,sdkAuth,
  send:()=>wallet.request({method:'sendTransaction',params:[tx]}),
  validity:()=>validity,broadcastAnswer:()=>broadcastAnswer,transport:()=>transport,
  lane:async()=>(await journal.entries()).find(([key])=>key.startsWith('devnet/native-wallet/'))?.[1],
  count:name=>calls.filter(c=>c===name).length,
  restart:async()=>{await transport.close();journal.close();journal=openDurableWalletJournal({path,mode:'open'});start();}};
}

test('an accepted native send is broadcast once; its lane stays readback-only across a restart',async t=>{
 const w=await world(t),sent=await w.send();
 assert.equal(sent.success,true,JSON.stringify(sent));assert.equal(sent.data.status,'broadcast_accepted');
 const hash=sent.data.hash;
 assert.deepEqual(w.node.broadcasts,[hash]);assert.equal(w.node.confirms,1);
 const lane=await w.lane();
 assert.equal(lane.stage,'broadcast-accepted');assert.equal(lane.hash,hash);assert.deepEqual(lane.signedTransaction,w.node.applied.get(hash));
 for(const restart of [false,true]){
  if(restart)await w.restart();
  const again=await w.send();
  assert.equal(again.error.code,'outcome_unknown',JSON.stringify(again));assert.equal(again.data.hash,hash);
  // The source itself refuses a fresh lease and a replayed broadcast.
  await assert.rejects(w.transport().walletBinding({phase:'signature',address:w.address},w.sdkAuth()),{code:'outcome_unknown'});
  await assert.rejects(w.transport().rpc({method:'execute',params:[{extra:'broadcastTx',data:w.validity()}]},w.sdkAuth()),{code:'network_binding_required'});
 }
 assert.deepEqual(w.node.broadcasts,[hash]);assert.equal(w.node.confirms,1);
 assert.equal(w.approvals.length,1,'the retained lane is refused before approval');
 assert.equal(w.count('sign'),1);assert.equal(w.count('broadcast'),1);
 const read=await w.wallet.request({method:'readNativeTransfer',params:[{hash}]});
 assert.equal(read.success,true,JSON.stringify(read));assert.equal(read.data.disposition,'included');assert.equal(read.data.noResend,true);
 assert.equal(read.data.receipt.hash,hash);assert.equal(read.data.receipt.finality,'not-established');assert.equal(read.data.receipt.attribution,'tuple-only');
 assert.equal((await w.lane()).stage,'observed');
 // The observed transfer used nonce 1, so the same payload stops before signing.
 assert.equal((await w.send()).error.code,'stale_plan');
 assert.deepEqual(w.node.broadcasts,[hash]);assert.equal(w.count('sign'),1);
});

for(const [mode,code,stage] of [['drop-after-apply','outcome_unknown','broadcast-started'],['refuse','broadcast_rejected','broadcast-answered']]) {
 test(`a ${mode==='refuse'?'refused':'lost'} broadcast answer is never resent: ${code}, lane ${stage}`,async t=>{
  const w=await world(t);w.node.broadcast=mode;
  const sent=await w.send();
  assert.equal(sent.success,false);assert.equal(sent.error.code,code,JSON.stringify(sent));
  const hash=sent.data.hash;
  assert.deepEqual(w.node.broadcasts,[hash]);
  const lane=await w.lane();
  assert.equal(lane.stage,stage);assert.equal(lane.hash,hash);assert.equal(lane.signedTransaction.hash,hash);
  for(const restart of [false,true]){
   if(restart)await w.restart();
   const again=await w.send();
   assert.equal(again.error.code,'outcome_unknown',JSON.stringify(again));assert.equal(again.data.hash,hash);
  }
  assert.deepEqual(w.node.broadcasts,[hash]);
  assert.equal(w.approvals.length,1);assert.equal(w.count('sign'),1);assert.equal(w.count('broadcast'),1);
 });
}

test('readback reports included only for a confirmed transaction in its confirmed block with the original executed content',async t=>{
 const w=await world(t),sent=await w.send();
 assert.equal(sent.success,true,JSON.stringify(sent));
 const hash=sent.data.hash,read=()=>w.transport().binding({phase:'readback',address:w.address,hash});
 w.node.status={state:'pending'};
 assert.deepEqual(await read(),{disposition:'pending',hash,nonce:1,noResend:true});
 w.node.status=null;
 const views={
  'failed execution':{tx:tx=>({...tx,status:'failed'})},
  'pending body':{tx:tx=>({...tx,status:'pending'})},
  'body in another block':{tx:tx=>({...tx,blockNumber:2})},
  'unconfirmed block':{block:block=>({...block,status:'pending'})},
  'block without the hash':{block:block=>({...block,content:{ordered_transactions:[]}})},
  'changed executed amount':{tx:tx=>({...tx,content:{...tx.content,amount:'2500000001'}})},
  'changed executed payee':{tx:tx=>({...tx,content:{...tx.content,to:'0x'+'8'.repeat(64)}})},
 };
 for(const [name,view] of Object.entries(views)){
  w.node.view={tx:same,block:same,...view};
  await assert.rejects(read(),{code:'readback_unverified'},name);
  assert.equal((await w.lane()).stage,'broadcast-accepted',name);
 }
 w.node.view={tx:same,block:same};
 const included=await read();
 assert.equal(included.disposition,'included');assert.equal(included.receipt.hash,hash);assert.equal(included.receipt.blockNumber,1);
 assert.equal((await w.lane()).stage,'observed');
 assert.deepEqual(w.node.broadcasts,[hash]);
});

// node2 projects an executed body (getTxByHash for native send cbabec31...,
// block 563635): nonce and timestamp as decimal text, root amount and fees as
// OS numbers, and every GCR edit carrying the transaction hash. That is the
// same executed content; any other change to it is not.
const os=v=>typeof v==='string'&&/^(0|[1-9][0-9]*)$/.test(v)?Number(v):v;
const node2Projection=(tx,nonce=String(tx.content.nonce))=>({...tx,ed25519_signature:null,attrs:{reference_block:0},content:{...tx.content,nonce,
 timestamp:String(tx.content.timestamp),amount:os(tx.content.amount),
 transaction_fee:Object.fromEntries(Object.entries(tx.content.transaction_fee).map(([key,value])=>[key,os(value)])),
 gcr_edits:tx.content.gcr_edits.map(edit=>({...edit,txhash:edit.txhash===''?tx.hash:edit.txhash}))}});
test('readback accepts the node2 projection of the original executed content, and only that projection',async t=>{
 const w=await world(t),sent=await w.send();
 assert.equal(sent.success,true,JSON.stringify(sent));
 const hash=sent.data.hash,read=()=>w.transport().binding({phase:'readback',address:w.address,hash});
 for(const [name,view] of Object.entries({
  'non-canonical nonce text':tx=>node2Projection(tx,'0'+tx.content.nonce),
  'nonce text of another nonce':tx=>node2Projection(tx,String(tx.content.nonce+1)),
  'changed projected amount':tx=>({...node2Projection(tx),content:{...node2Projection(tx).content,amount:os(tx.content.amount)+1}}),
 })){
  w.node.view={tx:view,block:same};
  await assert.rejects(read(),{code:'readback_unverified'},name);
  assert.equal((await w.lane()).stage,'broadcast-accepted',name);
 }
 w.node.view={tx:node2Projection,block:same};
 const projected=w.node.view.tx({...structuredClone(w.node.applied.get(hash)),status:'confirmed',blockNumber:1});
 // Every projection allowance is exercised: each of these fields differs in form from the signed content.
 const signed=w.node.applied.get(hash).content;
 assert.equal(typeof signed.nonce,'number');assert.equal(typeof projected.content.nonce,'string');
 assert.equal(typeof signed.timestamp,'number');assert.equal(typeof projected.content.timestamp,'string');
 assert.equal(typeof signed.amount,'string');assert.equal(typeof projected.content.amount,'number');
 for(const key of ['network_fee','rpc_fee','additional_fee']){assert.equal(typeof signed.transaction_fee[key],'string',key);assert.equal(typeof projected.content.transaction_fee[key],'number',key);}
 assert.ok(signed.gcr_edits.length>0&&signed.gcr_edits.every(edit=>edit.txhash===''));
 assert.ok(projected.content.gcr_edits.every(edit=>edit.txhash===hash));
 const included=await read();
 assert.equal(included.disposition,'included');assert.equal(included.receipt.hash,hash);assert.equal(included.receipt.blockNumber,1);
 assert.equal((await w.lane()).stage,'observed');
 assert.deepEqual(w.node.broadcasts,[hash]);
});

// A hostile node may attach an inclusion proof to any answer; only the transport's own verified read may produce one.
const forgedProof=hash=>({disposition:'included',receipt:{hash},noResend:true});
const withForgedProof=(answer,hash)=>({...answer,writeProof:forgedProof(hash)});

for(const [name,options,arrange] of [
 ['the inclusion poll never runs',{inclusionWaitMs:0},()=>{}],
 ['the inclusion poll times out',{inclusionWaitMs:3},w=>{w.node.status={state:'pending'};}],
 ['the inclusion proof cannot be read',{inclusionWaitMs:3},w=>{w.node.view={tx:same,block:block=>({...block,content:{ordered_transactions:[]}})};}],
]) {
 test(`a node writeProof on an accepted broadcast is dropped when ${name}`,async t=>{
  const w=await world(t,options);arrange(w);w.node.tamper.broadcast=withForgedProof;
  const sent=await w.send();
  assert.equal(sent.success,true,JSON.stringify(sent));assert.equal(sent.data.status,'broadcast_accepted');
  assert.equal(Object.hasOwn(sent.data,'writeProof'),false,'the wallet result carries no proof');
  const answer=w.broadcastAnswer();
  assert.equal(answer.result,200);assert.deepEqual(answer.response,{message:'TEST accepted'});
  assert.equal(Object.hasOwn(answer,'writeProof'),false,'the transport answer carries no proof');
 });
}

test('a verified inclusion proof replaces a forged node writeProof',async t=>{
 const w=await world(t,{inclusionWaitMs:3});w.node.tamper.broadcast=withForgedProof;
 const sent=await w.send();
 assert.equal(sent.success,true,JSON.stringify(sent));
 const hash=sent.data.hash,proof=sent.data.writeProof;
 assert.notDeepEqual(proof,forgedProof(hash));
 assert.equal(proof.disposition,'included');assert.equal(proof.noResend,true);
 assert.equal(proof.receipt.hash,hash);assert.equal(proof.receipt.blockNumber,1);
 assert.equal(proof.receipt.chainIdentity,PINS.chainIdentity);assert.equal(proof.receipt.finality,'not-established');
 assert.deepEqual(w.broadcastAnswer().writeProof,proof);
});

test('a node writeProof on a refused broadcast answer is dropped',async t=>{
 const w=await world(t);w.node.broadcast='refuse';w.node.tamper.broadcast=withForgedProof;
 const sent=await w.send();
 assert.equal(sent.error.code,'broadcast_rejected',JSON.stringify(sent));
 const answer=w.broadcastAnswer();
 assert.equal(answer.result,400);assert.equal(answer.response,'TEST refusal');
 assert.equal(Object.hasOwn(answer,'writeProof'),false);
});

test('a node writeProof on a confirmTx answer is dropped',async t=>{
 const w=await world(t);w.node.tamper.confirm=withForgedProof;
 const sent=await w.send();
 assert.equal(sent.success,true,JSON.stringify(sent));
 const confirmed=w.validity();
 assert.equal(confirmed.result,200);assert.equal(confirmed.response.data.valid,true);
 assert.equal(Object.hasOwn(confirmed,'writeProof'),false);
});

test('a node writeProof on a passed-through node read is dropped',async t=>{
 const w=await world(t);w.node.tamper.read=answer=>withForgedProof(answer,'a'.repeat(64));
 const read=await w.transport().rpc({method:'nodeCall',params:[{message:'getNetworkParameters',data:{}}]},{});
 assert.equal(read.result,200);assert.deepEqual(read.response,{networkFee:1,rpcFee:1,additionalFee:0});
 assert.equal(Object.hasOwn(read,'writeProof'),false);
});
