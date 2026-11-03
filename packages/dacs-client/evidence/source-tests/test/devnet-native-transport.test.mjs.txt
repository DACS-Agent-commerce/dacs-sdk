import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevnetNativeTransportHarness } from './helpers/devnet-native-transport-harness.mjs';
import { createSdkWalletSession, createDevnetNativeWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { createApp } from '../src/app.mjs';
globalThis.window ??= globalThis;
globalThis.document ??= {baseURI:'http://127.0.0.1/portal/assets/embedded-wallet/'};
globalThis.location ??= new URL('http://127.0.0.1/');
const {Demos,Identities,validateMnemonic}=await import('../public/portal/embedded-wallet/demos-runtime.mjs');
const payee='0x'+'71'.repeat(32);
async function flow(t,{decide=()=>true,beforeNativeBroadcast=null,transportOptions={}}={}){const h=await startDevnetNativeTransportHarness({beforeNativeBroadcast,transportOptions});t.after(()=>h.close());globalThis.location=new URL(h.origin);const approvals=[];const transport=createDevnetNativeWalletTransport(await h.profile());const w=createSdkWalletSession({DemosCtor:Demos,IdentitiesCtor:Identities,validateMnemonic,transactionTransport:transport,approve:async r=>{approvals.push(structuredClone(r));return decide(r,h);}});await w.create();t.after(()=>w.lock());const address=w.getPublicAccount().address;return{h,w,approvals,address,tx:buildNativeTransferPayload({from:address,to:payee,amountOs:'2500000000',nonce:1,timestamp:Date.now(),encoding:'os-string'})};}

test('actual app native-only source capability: bundled SDK sign/confirm/broadcast over same-origin relay to owned HTTPS TEST pin without simulation header; exact debit and retained readback/restart no resend',async t=>{
  const {h,w,approvals,address,tx}=await flow(t);
  const sent=await w.request({method:'sendTransaction',params:[tx]});assert.equal(sent.success,true,JSON.stringify(sent));
  assert.equal(h.chain.record.broadcasts.length,1);assert.equal(h.chain.record.accepted.length,1);
  assert.deepEqual(h.chain.record.auth,[true,true]);
  const approval=approvals.find(r=>r.content?.action==='native DEM transfer').content;
  assert.deepEqual([approval.from,approval.to,approval.amountOs,approval.nonce,approval.debit.totalOs],[address,payee,'2500000000',1,'8500000000']);
  assert.equal(approval.networkBinding.chainIdentity,h.expected.chainIdentity);assert.match(approval.networkBinding.transportAuthority,/^TEST-/);
  const record=(await h.journal.entries())[0][1];assert.equal(record.stage,'broadcast-accepted');assert.equal(record.hash,sent.data.hash);assert.deepEqual(record.signedTransaction,h.chain.record.accepted[0]);
  await h.restart();
  const repeated=await w.request({method:'sendTransaction',params:[tx]});assert.equal(repeated.error.code,'outcome_unknown');assert.equal(repeated.data.hash,sent.data.hash);assert.equal(h.chain.record.broadcasts.length,1);
  const read=await w.request({method:'readNativeTransfer',params:[{hash:sent.data.hash}]});assert.equal(read.success,true,JSON.stringify(read));assert.equal(read.data.disposition,'included');
  assert.deepEqual([read.data.receipt.payer,read.data.receipt.payee,read.data.receipt.amount,read.data.receipt.nonce,read.data.receipt.blockNumber],[address,payee,'2500000000',1,1]);
  assert.equal(read.data.receipt.finality,'not-established');assert.equal(read.data.receipt.attribution,'tuple-only');assert.equal(read.data.receipt.commitmentOnChain,false);
  const after=await w.request({method:'sendTransaction',params:[tx]});assert.equal(after.success,false);assert.equal(h.chain.record.broadcasts.length,1);
  assert.equal(approvals.filter(r=>r.content?.action==='native DEM transfer').length,1);
  assert.ok(h.requests.filter(r=>r.message==='getBlockByNumber').length>=5,'actual fresh pin observations consumed at signing and broadcast fences');
  assert.ok(h.responseMarkers.length>0);assert.ok(h.responseMarkers.every(m=>m===null),'actual HTTPS answers carry no simulation header');
  t.diagnostic(JSON.stringify({hash:sent.data.hash,nonce:1,block:read.data.receipt.blockNumber,totalDebitOs:approval.debit.totalOs,nativeBroadcasts:1,restarts:h.restarts(),authority:approval.networkBinding.transportAuthority,markerRequired:false,finality:'not-established'}));
});

test('unknown applied native send is durably retained: restart refuses resend before readback; original signed bytes remain exact',async t=>{
  const {h,w,tx}=await flow(t);h.chain.paymentFaults.payment='drop-after-apply';
  const sent=await w.request({method:'sendTransaction',params:[tx]});assert.equal(sent.error.code,'outcome_unknown');
  assert.equal((await h.journal.entries())[0][1].stage,'broadcast-started');await h.restart();
  assert.equal((await w.request({method:'sendTransaction',params:[tx]})).error.code,'outcome_unknown');
  const read=await w.request({method:'readNativeTransfer',params:[{hash:sent.data.hash}]});assert.equal(read.success,true,JSON.stringify(read));assert.equal(read.data.disposition,'included');assert.equal(h.chain.record.broadcasts.length,1);
});

test('unknown unapplied native send remains pending across restart and never allocates a second send',async t=>{
  const {h,w,tx}=await flow(t);h.chain.paymentFaults.payment='drop-before-apply';const sent=await w.request({method:'sendTransaction',params:[tx]});assert.equal(sent.error.code,'outcome_unknown');await h.restart();
  const read=await w.request({method:'readNativeTransfer',params:[{hash:sent.data.hash}]});assert.equal(read.success,true);assert.equal(read.data.disposition,'pending');assert.equal(h.chain.record.accepted.length,0);
  assert.equal((await w.request({method:'sendTransaction',params:[tx]})).error.code,'outcome_unknown');assert.equal(h.chain.record.broadcasts.length,1);
});

test('default absent and old held profile stay held; the new profile permits no CREATE/listing/identity writes or model approved:true authority',async t=>{
  const h=await startDevnetNativeTransportHarness({enabled:false});t.after(()=>h.close());assert.equal((await fetch(`${h.origin}/portal/api/devnet-native-wallet-profile`,{method:'POST'})).status,404);
  const off=await fetch(`${h.origin}/portal/api/embedded-wallet/profile`,{method:'POST'}).then(r=>r.json());assert.equal(off.writes,'off');
  const held=createSdkWalletSession({DemosCtor:Demos,transactionTransport:{profile:'testnet-held',network:'demos-devnet'},approve:async()=>true});await held.create();t.after(()=>held.lock());
  assert.equal((await held.request({method:'sendTransaction',params:[{approved:true}]})).error.code,'held_for_review');
  const live=await flow(t);
  for(const method of ['addGithubIdentity','removeWeb2Identity'])assert.equal((await live.w.request({method,params:['test']})).error.code,'unsupported');
  assert.equal((await live.w.request({method:'sendTransaction',params:[{content:{type:'storageProgram'}}]})).error.code,'held_for_review');
  assert.equal(live.h.chain.record.broadcasts.length,0);assert.equal(live.approvals.length,0);
  await assert.rejects(createApp({config:h.config,nativeWalletTransport:{approved:true}}),/explicit independently trusted source capability/);
});

test('normal wallet decline issues nothing; a later unavailable binding after exact approval still signs/sends nothing',async t=>{
  const declined=await flow(t,{decide:()=>false});
  assert.equal((await declined.w.request({method:'sendTransaction',params:[declined.tx]})).error.code,'user_rejected');
  assert.equal(declined.h.chain.record.confirms.length,0);assert.equal(declined.h.chain.record.broadcasts.length,0);assert.equal((await declined.h.journal.entries()).length,0);
  const unavailable=await flow(t,{decide:(_r,h)=>{h.chain.paymentFaults.unavailable=true;return true;}});
  const answer=await unavailable.w.request({method:'sendTransaction',params:[unavailable.tx]});assert.equal(answer.success,false);
  assert.equal(unavailable.h.chain.record.confirms.length,0);assert.equal(unavailable.h.chain.record.broadcasts.length,0);assert.equal((await unavailable.h.journal.entries()).length,0);
  assert.deepEqual(unavailable.h.fenceEvents,['acquire','release','acquire','release']);
});

test('same buyer later native nonce2: prior readback is retained and cannot release the newer pending intent; each send remains once-only across restart',async t=>{
  const {h,w,address,tx}=await flow(t);
  const first=await w.request({method:'sendTransaction',params:[tx]});assert.equal(first.success,true);
  const firstRead=await w.request({method:'readNativeTransfer',params:[{hash:first.data.hash}]});assert.equal(firstRead.data.disposition,'included');
  const secondTx=buildNativeTransferPayload({from:address,to:payee,amountOs:'2500000000',nonce:2,timestamp:Date.now(),encoding:'os-string'});
  const second=await w.request({method:'sendTransaction',params:[secondTx]});assert.equal(second.success,true,JSON.stringify(second));
  await h.restart();
  const older=await w.request({method:'readNativeTransfer',params:[{hash:first.data.hash}]});assert.deepEqual(older.data.receipt,firstRead.data.receipt);
  const lane=(await h.journal.entries()).find(([k])=>k.startsWith('devnet/native-wallet/'))[1];assert.equal(lane.hash,second.data.hash);assert.equal(lane.stage,'broadcast-accepted','older receipt must not release the newer issued lane');
  const blocked=await w.request({method:'sendTransaction',params:[secondTx]});assert.equal(blocked.error.code,'outcome_unknown');assert.equal(h.chain.record.broadcasts.length,2);
  const secondRead=await w.request({method:'readNativeTransfer',params:[{hash:second.data.hash}]});assert.equal(secondRead.data.receipt.nonce,2);assert.equal(secondRead.data.receipt.blockNumber,2);
  assert.deepEqual(h.chain.record.accepted.map(x=>x.content.nonce),[1,2]);
});

test('app restart during one in-flight native broadcast drains the owned connection before journal close and retains exact bytes once',async t=>{
  let signalArrival,releaseBroadcast;
  const arrived=new Promise(resolve=>signalArrival=resolve),released=new Promise(resolve=>releaseBroadcast=resolve);
  const {h,w,tx}=await flow(t,{beforeNativeBroadcast:async()=>{signalArrival();await released;}});
  const sentPromise=w.request({method:'sendTransaction',params:[tx]});await arrived;
  assert.equal((await h.journal.entries())[0][1].stage,'broadcast-started');
  let restarted=false;const restart=h.restart().then(()=>restarted=true);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(restarted,false,'shutdown must not close the journal while the owned native send is in flight');
  assert.equal(h.fenceEvents.at(-1),'acquire','the actual connection stays fenced until the one send answers');
  releaseBroadcast();const sent=await sentPromise;await restart;
  assert.equal(sent.success,true,JSON.stringify(sent));assert.equal(h.chain.record.broadcasts.length,1);
  const record=(await h.journal.entries()).find(([key])=>key.startsWith('devnet/native-wallet/'))[1];
  assert.equal(record.stage,'broadcast-accepted');assert.deepEqual(record.signedTransaction,h.chain.record.accepted[0]);
  const read=await w.request({method:'readNativeTransfer',params:[{hash:sent.data.hash}]});assert.equal(read.data.disposition,'included');
  assert.equal((await w.request({method:'sendTransaction',params:[tx]})).error.code,'stale_plan');assert.equal(h.chain.record.broadcasts.length,1);
});

test('source transport completes the operator policy decision after confirmation and before broadcast',async t=>{
  let checked=0;
  const allowed=await flow(t,{transportOptions:{approveConfirmedWrite:async(validity)=>{checked++;assert.equal(validity.response.data.valid,true);return true;}}});
  assert.equal((await allowed.w.request({method:'sendTransaction',params:[allowed.tx]})).success,true);
  assert.equal(checked,1);assert.equal(allowed.h.chain.record.broadcasts.length,1);
});

test('source transport refuses a policy-rejected confirmation before journal issuance or broadcast',async t=>{
  const refused=await flow(t,{transportOptions:{approveConfirmedWrite:async()=>false}});
  assert.equal((await refused.w.request({method:'sendTransaction',params:[refused.tx]})).success,false);
  assert.equal(refused.h.chain.record.confirms.length,1);assert.equal(refused.h.chain.record.broadcasts.length,0);
  assert.equal((await refused.h.journal.entries()).length,0);
});
