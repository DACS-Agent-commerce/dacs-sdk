// an earlier review, finding 2: RPC auth headers are fresh and single-use for every
// senderAuth caller (bind, signature, confirmTx, broadcastTx). an earlier review: the
// replay memory is per identity (one wallet filling it makes only its own sets
// stale), the operator's wallets are reserved, and a refused set says why. Offline: the
// Node2 source is an injected stub on a controlled clock, the relays listen on
// loopback, and the real packaged seller wallet writes to an owned loopback chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createHash } from 'node:crypto';
import { finalityCommitmentAddress, generateCanonicalJobId, signComponentArtifact, FINALITY_COMMITMENT_SEPARATOR } from '@kynesyslabs/dacs';
import { admittedTransport, blockZeroAdmission, zeroBlock, NOW, json, memoryJournal } from './helpers/review-node2-current-coverage-fixture.mjs';
import { startDevnetLiveCompositionTransport } from './helpers/devnet-live-composition-transport.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { createDevnetDemoArtifactAnchor } from '../src/devnet-demo/artifact-anchor.mjs';
import { createOperatorBuyerAccess } from '../src/devnet-demo/buyer-access.mjs';
import { createInProcessSellerRelay } from '../src/devnet-demo/seller-relay.mjs';
import { createWalletRpcRouter } from '../src/portal/wallet-rpc.mjs';

const sha=(value)=>createHash('sha256').update(value).digest('hex');
const auth=(wallet,timestamp)=>{const identity=`ed25519:${wallet.address}`;return{identity,timestamp:String(timestamp),signature:wallet.signHex(sha(`${identity}:${timestamp}`))};};
const custody=createEphemeralWallet(),other=createEphemeralWallet();
const source=async(extra={})=>{let clock=NOW;const run=admittedTransport(await blockZeroAdmission(),{0:zeroBlock(),...extra},{now:()=>clock});return{...run,advance:(ms)=>{clock+=ms;}};};
const nativeSend=(from,to)=>{const content={type:'native',from:from.address,to:to.address,amount:1,nonce:1,timestamp:1,data:['native',{nativeOperation:'send',args:[to.address,1]}]};const hash=sha(JSON.stringify(content));return{content,hash,signature:{type:'ed25519',data:from.signHex(hash)}};};
const confirmBody=(tx)=>({method:'execute',params:[{extra:'confirmTx',data:tx}]});
const code=(name)=>(error)=>{assert.equal(error.code,name,error.message);return true;};
const codes=(...names)=>(error)=>{assert.ok(names.includes(error.code),`${error.code}: ${error.message}`);return true;};

test('stale and far-future RPC auth headers are refused before any lease or source call',async()=>{
  const run=await source({'GET /':()=>json({result:200,response:{data:{valid:false}},require_reply:false,extra:null})});
  for(const timestamp of ['1',NOW-120001,NOW+120001]){
    for(const phase of ['bind','signature'])await assert.rejects(run.capability.walletBinding({phase,address:custody.address,binding:{}},auth(custody,timestamp)),code('wallet_auth_stale'));
    await assert.rejects(run.capability.rpc(confirmBody(nativeSend(custody,other)),auth(custody,timestamp)),code('wallet_auth_stale'));
  }
  assert.equal(run.stub.calls.length,0,'no source call');
  // Nothing was leased: another wallet takes the connection at once.
  const {binding}=await run.capability.binding({phase:'bind',address:other.address});
  await run.capability.binding({phase:'signature',address:other.address,binding});
  // The window's edges are inside it.
  const edge=await source();
  assert.equal((await edge.capability.walletBinding({phase:'bind',address:custody.address},auth(custody,NOW-120000))).binding.network,'demos-devnet');
  assert.equal((await edge.capability.walletBinding({phase:'bind',address:custody.address},auth(custody,NOW+120000))).binding.network,'demos-devnet');
});

test('each header set is accepted once: replays and bind headers reused for signature are refused without effects',async()=>{
  const run=await source({'GET /':()=>json({result:200,response:{data:{valid:false}},require_reply:false,extra:null})});
  const bindHeaders=auth(custody,NOW);
  const {binding}=await run.capability.walletBinding({phase:'bind',address:custody.address},bindHeaders);
  let calls=run.stub.calls.length;
  await assert.rejects(run.capability.walletBinding({phase:'bind',address:custody.address},bindHeaders),code('wallet_auth_replayed'));
  await assert.rejects(run.capability.walletBinding({phase:'signature',address:custody.address,binding},bindHeaders),code('wallet_auth_replayed'));
  // Another encoding of the same signature is the same proof.
  await assert.rejects(run.capability.walletBinding({phase:'signature',address:custody.address,binding},{...bindHeaders,signature:bindHeaders.signature.replace(/^0x/,'')}),code('wallet_auth_replayed'));
  assert.equal(run.stub.calls.length,calls,'no source call for a replay');
  // No lease was taken by the replays.
  await run.capability.binding({phase:'bind',address:other.address});
  const signatureHeaders=auth(custody,NOW+1);
  const lease=await run.capability.walletBinding({phase:'signature',address:custody.address,binding},signatureHeaders);
  const confirmHeaders=auth(custody,NOW+2),tx=nativeSend(custody,other);
  assert.equal((await run.capability.rpc(confirmBody(tx),confirmHeaders)).response.data.valid,false);
  calls=run.stub.calls.length;
  await assert.rejects(run.capability.rpc(confirmBody(tx),confirmHeaders),code('wallet_auth_replayed'));
  assert.equal(run.stub.calls.length,calls,'a replayed confirm reaches no source');
  await run.capability.binding({phase:'release',address:custody.address,leaseId:lease.leaseId});
  calls=run.stub.calls.length;
  await assert.rejects(run.capability.walletBinding({phase:'signature',address:custody.address,binding},signatureHeaders),code('wallet_auth_replayed'));
  assert.equal(run.stub.calls.length,calls,'a replayed signature reaches no source');
  await run.capability.binding({phase:'bind',address:other.address});
  // A fresh set for the same phase is accepted.
  assert.match((await run.capability.walletBinding({phase:'signature',address:custody.address,binding},auth(custody,NOW+3))).leaseId,/^[0-9a-f]{32}$/);
});

test('the native relay refuses replayed binding headers before any source call',async t=>{
  const run=await source(),app=express();
  app.use(createWalletRpcRouter({config:{publicOrigin:'http://127.0.0.1:1'},nativeTransport:run.capability,buyerAccess:createOperatorBuyerAccess({custodyBuyer:custody.claim})}));
  const server=http.createServer(app);await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const post=async(body,headers)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/portal/api/devnet-native-wallet-binding`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return{http:r.status,...await r.json()};};
  const headers=auth(custody,NOW),bound=await post({phase:'bind',address:custody.address},headers);
  assert.equal(bound.http,200,JSON.stringify(bound));
  const calls=run.stub.calls.length;
  for(const phase of ['bind','signature']){
    const replayed=await post({phase,address:custody.address,binding:bound.binding},headers);
    assert.equal(replayed.error,'wallet_auth_replayed',JSON.stringify(replayed));
  }
  assert.equal(run.stub.calls.length,calls,'no source call');
});

test('a refused forgery does not use up the genuine header set',async()=>{
  const run=await source(),identity=`ed25519:${custody.address}`,timestamp=String(NOW+5);
  await assert.rejects(run.capability.walletBinding({phase:'bind',address:custody.address},{identity,timestamp,signature:other.signHex(sha(`${identity}:${timestamp}`))}),code('wallet_auth_required'));
  assert.equal((await run.capability.walletBinding({phase:'bind',address:custody.address},auth(custody,timestamp))).binding.network,'demos-devnet');
});

test('each identity\'s replay memory is bounded and never reopens a forgotten header set',async()=>{
  const run=await source(),tx=nativeSend(custody,other),first=NOW-100000;
  // Each confirm is refused for want of a lease, after its headers are used.
  const use=(timestamp)=>run.capability.rpc(confirmBody(tx),auth(custody,timestamp));
  for(let i=0;i<256;i++)await assert.rejects(use(first+i),code('network_binding_required'));
  await assert.rejects(use(first+5),code('wallet_auth_replayed'));
  // A full identity forgets its own oldest; a fresh set stamped at or before it is refused.
  await assert.rejects(use(first-1),code('wallet_auth_stale'));
  await assert.rejects(use(NOW+1),code('network_binding_required'),'a new set is still accepted at the bound');
  await assert.rejects(use(NOW+2),code('network_binding_required'),'and the next forgets the next oldest');
  // The forgotten oldest two, and anything older, stay refused.
  await assert.rejects(use(first),code('wallet_auth_stale'));
  await assert.rejects(use(first+1),code('wallet_auth_stale'));
  await assert.rejects(use(first-2),code('wallet_auth_stale'));
  await assert.rejects(use(first+6),code('wallet_auth_replayed'));
  assert.equal(run.stub.calls.length,0);
});

// Both reviews' probe: 4,097 future-stamped sets from one identity used to
// raise one floor for everyone, so the custody buyer and seller were refused.
for(const [order,stamp] of [['descending, near the window\'s edge',(i)=>NOW+120000-i],['ascending',(i)=>NOW+10000+i]]){
  test(`one identity filling the replay memory (${order}) makes only its own sets stale`,async()=>{
    const run=await source(),attacker=createEphemeralWallet(),seller=createEphemeralWallet(),tx=nativeSend(attacker,other);
    // Descending, the attacker's own floor soon refuses its later (lower) sets.
    for(let i=0;i<4097;i++)await assert.rejects(run.capability.rpc(confirmBody(tx),auth(attacker,stamp(i))),codes('network_binding_required','wallet_auth_stale'));
    assert.equal(run.stub.calls.length,0,'the flood made no source call');
    run.advance(1000);
    // Fresh custody and seller sets are accepted, by binding and by confirm.
    assert.equal((await run.capability.walletBinding({phase:'bind',address:custody.address},auth(custody,NOW+1000))).binding.network,'demos-devnet');
    assert.equal((await run.capability.walletBinding({phase:'bind',address:seller.address},auth(seller,NOW+1000))).binding.network,'demos-devnet');
    await assert.rejects(run.capability.rpc(confirmBody(nativeSend(seller,other)),auth(seller,NOW+1001)),code('network_binding_required'));
    // The attacker's own replays stay refused: remembered sets are replays,
    // and everything at or before its forgotten ones is stale.
    await assert.rejects(run.capability.rpc(confirmBody(tx),auth(attacker,Math.max(stamp(0),stamp(4096)))),code('wallet_auth_replayed'));
    await assert.rejects(run.capability.rpc(confirmBody(tx),auth(attacker,Math.min(stamp(0),stamp(4096)))),code('wallet_auth_stale'));
    await assert.rejects(run.capability.rpc(confirmBody(tx),auth(attacker,NOW+1000)),code('wallet_auth_stale'));
  });
}

test('through the open public relay, one buyer filling the replay memory does not lock another wallet out',async t=>{
  const run=await source(),attacker=createEphemeralWallet(),victim=createEphemeralWallet(),app=express();
  app.use(createWalletRpcRouter({config:{publicOrigin:'http://127.0.0.1:1'},nativeTransport:run.capability,buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true})}));
  const server=http.createServer(app);await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const post=async(path,body,headers)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return{http:r.status,...await r.json()};};
  const tx=nativeSend(attacker,other);
  for(let i=0;i<4097;i++)assert.equal((await post('/portal/api/devnet-native-wallet-rpc',confirmBody(tx),auth(attacker,NOW+10000+i))).http,500);
  assert.equal(run.stub.calls.length,0,'the flood made no source call');
  const bound=await post('/portal/api/devnet-native-wallet-binding',{phase:'bind',address:victim.address},auth(victim,NOW));
  assert.equal(bound.http,200,JSON.stringify(bound));
});

test('the shared replay memory is bounded: the largest holder forgets first, and the operator\'s wallets are reserved',async()=>{
  const run=await source(),seller=createEphemeralWallet();
  run.capability.reserveRpcAuth(custody.address);run.capability.reserveRpcAuth(seller.address);
  const confirm=(wallet,timestamp)=>run.capability.rpc(confirmBody(nativeSend(wallet,other)),auth(wallet,timestamp));
  // The reserved wallets hold several sets each; they are never the holder that forgets.
  for(let i=0;i<8;i++){await assert.rejects(confirm(custody,NOW+i),code('network_binding_required'));await assert.rejects(confirm(seller,NOW+i),code('network_binding_required'));}
  // One identity holds 256 sets and 3,840 others one each: 4,096 shared entries.
  const big=createEphemeralWallet(),bigTx=nativeSend(big,other);
  for(let i=0;i<256;i++)await assert.rejects(run.capability.rpc(confirmBody(bigTx),auth(big,NOW+i)),code('network_binding_required'));
  const singles=[];
  for(let i=0;i<3840;i++){const wallet=createEphemeralWallet();singles.push(wallet);await assert.rejects(confirm(wallet,NOW),code('network_binding_required'));}
  // Each newcomer makes the largest holder forget its oldest, and nobody else.
  for(let i=0;i<255;i++)await assert.rejects(confirm(createEphemeralWallet(),NOW),code('network_binding_required'));
  await assert.rejects(run.capability.rpc(confirmBody(bigTx),auth(big,NOW+254)),code('wallet_auth_stale'));
  await assert.rejects(run.capability.rpc(confirmBody(bigTx),auth(big,NOW+255)),code('wallet_auth_replayed'));
  await assert.rejects(confirm(singles[0],NOW),code('wallet_auth_replayed'));
  // Now no shared identity holds two: a newcomer, or a holder's second set, is busy.
  await assert.rejects(confirm(createEphemeralWallet(),NOW),code('wallet_auth_busy'));
  await assert.rejects(confirm(singles[1],NOW+1),code('wallet_auth_busy'));
  assert.equal(run.stub.calls.length,0,'no refused or lease-less set read the source');
  // Making room never took a reserved wallet's sets: its earliest is still remembered.
  await assert.rejects(confirm(custody,NOW),code('wallet_auth_replayed'));
  await assert.rejects(confirm(seller,NOW),code('wallet_auth_replayed'));
  // The reserved wallets are unaffected, past their own quota too.
  for(let i=8;i<300;i++){await assert.rejects(confirm(custody,NOW+i),code('network_binding_required'));await assert.rejects(confirm(seller,NOW+i),code('network_binding_required'));}
  await assert.rejects(confirm(custody,NOW+7),code('wallet_auth_stale'),'a reserved wallet forgets only its own oldest');
  assert.equal((await run.capability.walletBinding({phase:'bind',address:seller.address},auth(seller,NOW+300))).binding.network,'demos-devnet');
  // Once the shared sets are stale, memory is free again.
  run.advance(120000+300);
  await assert.rejects(confirm(createEphemeralWallet(),NOW+120300),code('network_binding_required'));
  assert.throws(()=>run.capability.reserveRpcAuth('not an address'),TypeError);
  run.capability.reserveRpcAuth(createEphemeralWallet().address);run.capability.reserveRpcAuth(createEphemeralWallet().address);
  assert.throws(()=>run.capability.reserveRpcAuth(createEphemeralWallet().address),TypeError,'at most four reserved wallets');
});

test('a wallet whose clock is more than two minutes off gets a specific refusal from each relay',async t=>{
  const run=await source(),app=express(),seller=createEphemeralWallet();
  app.use(createWalletRpcRouter({config:{publicOrigin:'http://127.0.0.1:1'},nativeTransport:run.capability,buyerAccess:createOperatorBuyerAccess({openBuyerAccess:true})}));
  const server=http.createServer(app);await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));t.after(()=>server.close());
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=async(url,body,headers)=>{const r=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return{http:r.status,...await r.json()};};
  const relay=createInProcessSellerRelay({sourceCapability:run.capability,address:seller.address,publicOrigin:'http://127.0.0.1:1'});
  const answers=[];
  for(const timestamp of [NOW-180000,NOW+180000]){
    answers.push(await post(`${base}/portal/api/devnet-native-wallet-rpc`,confirmBody(nativeSend(custody,other)),auth(custody,timestamp)));
    answers.push(await post(`${base}/portal/api/devnet-native-wallet-binding`,{phase:'bind',address:custody.address},auth(custody,timestamp)));
    answers.push(await relay.run(()=>post('http://127.0.0.1:1/portal/api/devnet-native-wallet-rpc',confirmBody(nativeSend(seller,other)),auth(seller,timestamp))));
    answers.push(await relay.run(()=>post('http://127.0.0.1:1/portal/api/devnet-native-wallet-binding',{phase:'bind',address:seller.address},auth(seller,timestamp))));
  }
  assert.equal(run.stub.calls.length,0,'no source call');
  for(const answer of answers){
    assert.equal(answer.http,409,JSON.stringify(answer));
    assert.equal(answer.error,'wallet_auth_stale');
    assert.match(answer.message,/more than 2 minutes from the operator's clock/);
    assert.equal(answer.response,answer.message,'the SDK envelope carries the same message');
    assert.doesNotMatch(JSON.stringify(answer),/\d{10,}/,'no server timestamp');
  }
  // A replayed set says so too.
  const headers=auth(custody,NOW);
  assert.equal((await post(`${base}/portal/api/devnet-native-wallet-binding`,{phase:'bind',address:custody.address},headers)).http,200);
  const calls=run.stub.calls.length,replayed=await post(`${base}/portal/api/devnet-native-wallet-binding`,{phase:'bind',address:custody.address},headers);
  assert.equal(replayed.http,409);assert.equal(replayed.error,'wallet_auth_replayed');
  assert.equal(run.stub.calls.length,calls,'no source call for the replay');
});

test('the packaged wallet reports a clock more than two minutes off plainly, and nothing is signed or sent',{timeout:300000},async t=>{
  const h=await startDevnetLiveCompositionTransport({transportOptions:{now:()=>Date.now()+180000}});t.after(()=>h.close());
  globalThis.location=new URL(h.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${h.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  const seller=await createEphemeralPackagedSeller({rpcUrl:`${h.origin}/portal/api/devnet-native-wallet-rpc`,network:'demos-devnet',transactionTransport:createDevnetAgreementWalletTransport(h.capability.profile(h.origin))});t.after(()=>seller.close());
  const relay=createInProcessSellerRelay({sourceCapability:h.capability,address:seller.signer.address,publicOrigin:h.origin});
  const walletFactory=(options)=>{const wallet=seller.walletFactory(options);return{getPublicAccount:()=>wallet.getPublicAccount(),getWriteProfile:()=>wallet.getWriteProfile(),request:(input)=>relay.run(()=>wallet.request(input))};};
  const jobId=generateCanonicalJobId();
  const artifact=await signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),listingRef:{listingId:'rpc-auth-clock',version:1,contentHash:'c'.repeat(64)},
    parties:[custody.claim,seller.signer.claim],pattern:'fixed-price',createdAt:1770000000200},FINALITY_COMMITMENT_SEPARATOR,{algorithm:'ed25519',signer:seller.signer.claim,sign:(bytes)=>seller.signer.signBytes(bytes)});
  const anchor=createDevnetDemoArtifactAnchor({sourceCapability:h.capability,journal:memoryJournal(),walletFactory,network:'demos-devnet',buyerAccess:createOperatorBuyerAccess({custodyBuyer:custody.claim,buyerForJob:()=>custody.address})});
  const out=await anchor.publish({logicalAddress:finalityCommitmentAddress(jobId),artifactKind:'FinalityCommitmentRecord',artifact});
  assert.equal(out.status,'indeterminate',JSON.stringify(out));
  assert.match(out.reason,/^wallet_auth_stale: .*clock is more than 2 minutes off/);
  assert.equal(h.requests.filter((request)=>['confirmTx','broadcastTx'].includes(request)).length,0,'nothing confirmed or broadcast');
});

test('a real packaged-wallet write signs fresh headers for bind, signature, confirmTx and broadcastTx; replaying any is refused',{timeout:300000},async t=>{
  const h=await startDevnetLiveCompositionTransport();t.after(()=>h.close());
  globalThis.location=new URL(h.origin);globalThis.window??=globalThis;globalThis.document??={baseURI:`${h.origin}/portal/assets/embedded-wallet/`,currentScript:null};
  const seller=await createEphemeralPackagedSeller({rpcUrl:`${h.origin}/portal/api/devnet-native-wallet-rpc`,network:'demos-devnet',transactionTransport:createDevnetAgreementWalletTransport(h.capability.profile(h.origin))});t.after(()=>seller.close());
  // The operator's path: the seller wallet reaches its source through the
  // in-process relay, so bind and signature use walletBinding with the
  // embedded wallet's own headers, and confirmTx and broadcastTx the SDK's.
  const seen=[];
  const sourceCapability={walletBinding:(body,headers)=>{if(headers.identity)seen.push({kind:body.phase,body:structuredClone(body),headers});return h.capability.walletBinding(body,headers);},
    rpc:(body,headers)=>{const extra=body?.params?.[0]?.extra;if(extra)seen.push({kind:extra,body:structuredClone(body),headers});return h.capability.rpc(body,headers);}};
  const relay=createInProcessSellerRelay({sourceCapability,address:seller.signer.address,publicOrigin:h.origin});
  const walletFactory=(options)=>{const wallet=seller.walletFactory(options);return{getPublicAccount:()=>wallet.getPublicAccount(),getWriteProfile:()=>wallet.getWriteProfile(),request:(input)=>relay.run(()=>wallet.request(input))};};
  const jobId=generateCanonicalJobId();
  const artifact=await signComponentArtifact({finalityCommitmentVersion:'1',jobId,agreementHash:'a'.repeat(64),listingRef:{listingId:'rpc-auth-report',version:1,contentHash:'c'.repeat(64)},
    parties:[custody.claim,seller.signer.claim],pattern:'fixed-price',createdAt:1770000000200},FINALITY_COMMITMENT_SEPARATOR,{algorithm:'ed25519',signer:seller.signer.claim,sign:(bytes)=>seller.signer.signBytes(bytes)});
  const anchor=createDevnetDemoArtifactAnchor({sourceCapability:h.capability,journal:memoryJournal(),walletFactory,network:'demos-devnet',buyerAccess:createOperatorBuyerAccess({custodyBuyer:custody.claim,buyerForJob:()=>custody.address})});
  assert.equal((await anchor.publish({logicalAddress:finalityCommitmentAddress(jobId),artifactKind:'FinalityCommitmentRecord',artifact})).status,'present');
  assert.deepEqual(seen.map((entry)=>entry.kind),['bind','signature','confirmTx','broadcastTx']);
  assert.equal(new Set(seen.map((entry)=>entry.headers.timestamp)).size,4,'a fresh header set for every request');
  assert.deepEqual(h.errors,[]);
  const before=h.requests.length;
  for(const entry of seen){
    const replay=['bind','signature'].includes(entry.kind)?h.capability.walletBinding(entry.body,entry.headers):h.capability.rpc(entry.body,entry.headers);
    await assert.rejects(replay,code('wallet_auth_replayed'),entry.kind);
  }
  assert.equal(h.requests.length,before,'no source request for any replay');
});
