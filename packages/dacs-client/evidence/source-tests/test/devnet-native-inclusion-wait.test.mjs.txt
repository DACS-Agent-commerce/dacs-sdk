import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevnetNativeTransportHarness } from './helpers/devnet-native-transport-harness.mjs';
import { createSdkWalletSession, createDevnetNativeWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
globalThis.window ??= globalThis;
globalThis.document ??= {baseURI:'http://127.0.0.1/portal/assets/embedded-wallet/'};
globalThis.location ??= new URL('http://127.0.0.1/');
const {Demos,Identities,validateMnemonic}=await import('../public/portal/embedded-wallet/demos-runtime.mjs');
const payee='0x'+'71'.repeat(32);
async function flow(t,harness){
  const h=await startDevnetNativeTransportHarness(harness);t.after(()=>h.close());globalThis.location=new URL(h.origin);
  const transport=createDevnetNativeWalletTransport(await h.profile());
  const w=createSdkWalletSession({DemosCtor:Demos,IdentitiesCtor:Identities,validateMnemonic,transactionTransport:transport,approve:async()=>true});await w.create();t.after(()=>w.lock());
  const address=w.getPublicAccount().address;
  return{h,w,address,tx:buildNativeTransferPayload({from:address,to:payee,amountOs:'2500000000',nonce:1,timestamp:Date.now(),encoding:'os-string'})};
}
const statusReadsAfterBroadcast=(h)=>{const at=h.requests.findIndex(r=>r.extra==='broadcastTx');return h.requests.slice(at+1).filter(r=>r.message==='getTransactionStatus').length;};

test('an accepted broadcast answers only after Node2 reports the same hash included, so the first caller readback is included; one broadcast, lane stays unreleased',async t=>{
  let clock=Date.now();const waits=[];
  const {h,w,tx}=await flow(t,{pendingStatusPolls:3,transportOptions:{now:()=>clock,sleep:async(ms)=>{waits.push(ms);clock+=ms;}}});
  const sent=await w.request({method:'sendTransaction',params:[tx]});assert.equal(sent.success,true,JSON.stringify(sent));
  assert.deepEqual(waits,[500,500,500]);
  assert.equal(sent.data.writeProof?.disposition,'included');
  assert.equal(sent.data.writeProof.receipt.hash,sent.data.hash);
  assert.equal(statusReadsAfterBroadcast(h),4,'three pending status reads then the included one, before the wallet answer');
  assert.equal(h.chain.record.broadcasts.length,1);
  const record=(await h.journal.entries()).find(([key])=>key===`devnet/native-transfer/${sent.data.hash}`)[1];
  assert.equal(record.stage,'broadcast-accepted','the status wait records nothing and leaves release to exact readback');
  const proofReads=h.requests.filter(request=>request.message==='getTxByHash').length;
  const read=await w.request({method:'readNativeTransfer',params:[{hash:sent.data.hash}]});assert.equal(read.success,true,JSON.stringify(read));
  assert.equal(h.requests.filter(request=>request.message==='getTxByHash').length,proofReads+1,'a readback without the returned proof always authenticates fresh transaction facts, including a lost response');
  assert.equal(read.data.disposition,'included');assert.equal(read.data.receipt.payer,tx.content.from);
  assert.equal((await w.request({method:'sendTransaction',params:[tx]})).success,false);assert.equal(h.chain.record.broadcasts.length,1);
  assert.equal(h.fenceEvents.filter(e=>e==='acquire').length,h.fenceEvents.filter(e=>e==='release').length,'every status poll fence is released');
});

test('inclusion wait is bounded: a still-pending accepted broadcast answers with its original hash, stays pending on readback and is never resent',async t=>{
  let clock=Date.now();const waits=[];
  const {h,w,tx}=await flow(t,{pendingStatusPolls:1000,transportOptions:{inclusionWaitMs:40,inclusionPollMs:10,now:()=>clock,sleep:async(ms)=>{waits.push(ms);clock+=ms;}}});
  const sent=await w.request({method:'sendTransaction',params:[tx]});assert.equal(sent.success,true,JSON.stringify(sent));
  assert.deepEqual(waits,[10,10,10,10]);assert.equal(sent.data.writeProof,undefined);
  assert.equal(statusReadsAfterBroadcast(h),4,'exactly the bounded number of status polls');
  const read=await w.request({method:'readNativeTransfer',params:[{hash:sent.data.hash}]});assert.equal(read.data.disposition,'pending');
  const repeated=await w.request({method:'sendTransaction',params:[tx]});assert.equal(repeated.error.code,'outcome_unknown');assert.equal(repeated.data.hash,sent.data.hash);
  assert.equal(h.chain.record.broadcasts.length,1);
  assert.equal(h.fenceEvents.filter(e=>e==='acquire').length,h.fenceEvents.filter(e=>e==='release').length);
});

test('inclusion wait options are validated',async()=>{
  const {createDevnetNativeTransport}=await import('../src/wallet/devnet-native-transport.mjs');
  const base={expected:null,transportOwner:{getContext(){},async acquireConnectionFence(){}},journal:{get(){},put(){},entries(){},withWalletLock(){}}};
  for(const bad of [{inclusionWaitMs:-1},{inclusionWaitMs:300001},{inclusionPollMs:0},{inclusionWaitMs:1.5},{sleep:null}])
    assert.throws(()=>createDevnetNativeTransport({...base,...bad}),/inclusion wait must be bounded/);
});

test('default inclusion poll clamps its final sleep to the remaining bound; a lost response never enters inclusion polling or resends',async t=>{
  let clock=Date.now();const waits=[];
  const {h,w,tx}=await flow(t,{pendingStatusPolls:1000,transportOptions:{inclusionWaitMs:750,now:()=>clock,sleep:async(ms)=>{waits.push(ms);clock+=ms;}}});
  const sent=await w.request({method:'sendTransaction',params:[tx]});assert.equal(sent.success,true);
  assert.deepEqual(waits,[500,250]);assert.equal(sent.data.writeProof,undefined);
  assert.equal((await w.request({method:'sendTransaction',params:[tx]})).error.code,'outcome_unknown');assert.equal(h.chain.record.broadcasts.length,1);
  const lost=await flow(t,{transportOptions:{now:()=>clock,sleep:async()=>assert.fail('unknown broadcast must not poll')}});
  lost.h.chain.paymentFaults.payment='drop-after-apply';
  const answer=await lost.w.request({method:'sendTransaction',params:[lost.tx]});assert.equal(answer.error.code,'outcome_unknown');
  assert.equal(statusReadsAfterBroadcast(lost.h),0);
  assert.equal((await lost.w.request({method:'sendTransaction',params:[lost.tx]})).error.code,'outcome_unknown');
  assert.equal(lost.h.chain.record.broadcasts.length,1);
});

test('an inclusion proof is bound to the connection it was read on: a connection change during the proof reads returns no proof; readback authenticates fresh, one broadcast',async t=>{
  let clock=Date.now(),armed=false,switched=0;const holder={};
  const {h,w,tx}=await flow(t,{beforeNativeBroadcast:()=>{armed=true;},beforeNodeCall:(message)=>{if(armed&&message==='getTxByHash'&&!switched){switched++;holder.h.switchConnection();}},transportOptions:{now:()=>clock,sleep:async(ms)=>{clock+=ms;}}});
  holder.h=h;
  const sent=await w.request({method:'sendTransaction',params:[tx]});assert.equal(sent.success,true,JSON.stringify(sent));
  assert.equal(switched,1,'the connection changed while the inclusion proof was being read');
  assert.equal(sent.data.writeProof,undefined,'a proof read across a connection change is never returned or cached');
  assert.equal(h.chain.record.broadcasts.length,1);
  const proofReads=h.requests.filter(request=>request.message==='getTxByHash').length;
  const read=await w.request({method:'readNativeTransfer',params:[{hash:sent.data.hash}]});assert.equal(read.success,true,JSON.stringify(read));
  assert.equal(read.data.disposition,'included');
  assert.equal(h.requests.filter(request=>request.message==='getTxByHash').length,proofReads+1,'readback authenticates fresh transaction facts on the current connection');
  assert.equal((await w.request({method:'sendTransaction',params:[tx]})).success,false);assert.equal(h.chain.record.broadcasts.length,1,'never resent');
});
