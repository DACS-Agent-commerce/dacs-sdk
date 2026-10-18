import { canonicalize } from '@kynesyslabs/dacs';
import { devnetAgreementTransportFlow } from './helpers/devnet-agreement-transport-flow.mjs';
import { FIXTURE_IDENTITY } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativePaymentFlow } from './helpers/native-agreement-payment-flow.mjs';
import { nativeAgreementPaymentConfig } from '../src/dacs/native-agreement-payment-consumer.mjs';
import { createPurchaseReadbackCache } from '../src/util/purchase-readback-cache.mjs';
import { createSellerSr2AgreementAnchor } from '../src/dacs/seller-sr2-agreement-consumer.mjs';
import { claimForAddress } from '../src/wallet/demos-signature.mjs';
import { OperationError } from '../src/operations.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
installLoopbackOnlyGuard();

function consumer(w,{enabled=false,respond=null}={}) {
  const requests=[];
  const fetchImpl=async(url,init)=>{requests.push({url:String(url),method:init?.method??'GET',body:init?.body??null});return (await respond?.(String(url),init))??fetch(url,init);};
  const cache=enabled?createPurchaseReadbackCache({loadPurchase:id=>id===w.id?w.op():{kind:'purchase',status:'awaiting_approval'}}):null;
  const options={walletConfig:{rpcUrl:w.h.chain.url,journal:w.h.journal},sellerSr2Commitment:{publicProjection:true},coordinates:w.h.app.services.coordinates,fetchImpl,now:()=>1791144500000};
  const capability=nativeAgreementPaymentConfig({enabled:true},{...options,readbackCache:cache});
  return{capability,requests,cache,fetchImpl,now:options.now};
}
const counts=(requests)=>Object.fromEntries(['searchStoragePrograms','getTxByHash','getBlockByNumber','native'].map(name=>[name,requests.filter(r=>name==='native'?r.method==='GET':r.body&&JSON.parse(r.body)?.params?.[0]?.message===name).length]));

test('real verified Agreement: counted chain reads at challenge, approval, lane and evidence; purchases never share',async(t)=>{
  const w=await nativePaymentFlow(t);await w.agreement();
  const rows=[];
  for(const enabled of [false,true]){
    const c=consumer(w,{enabled});const op=w.op(),stepCounts=[];
    for(const step of ['challenge','approve','native-payment/lane','post-payment']){
      const start=c.requests.length;
      if(step==='native-payment/lane')await c.capability.readLane(op,JSON.stringify([op.terms.network,FIXTURE_IDENTITY,op.terms.buyer.wallet]));
      else await c.capability.verifyAgreement(op,{reuseVerified:step==='challenge'||step==='post-payment'});
      stepCounts.push({step,reads:counts(c.requests.slice(start)),total:c.requests.length-start});
    }
    rows.push({enabled,stepCounts});
    if(enabled){
      // Payment gates re-read the current program state (identity, storage
      // search, native GET); only the post-payment reuse reads nothing.
      const current={searchStoragePrograms:1,getTxByHash:0,getBlockByNumber:1,native:1};
      assert.deepEqual(stepCounts.slice(1).map(s=>s.reads),[current,current,counts([])]);
      assert.deepEqual(stepCounts.slice(1).map(s=>s.total),[3,3,0]);
      const other={...op,id:'another-purchase'};const start=c.requests.length;
      await c.capability.verifyAgreement(other);assert.equal(c.requests.length-start,stepCounts[0].total);
      // Cache use never skips the wallet journal fence or current scope.
      const lane=`sr2/wallet/${JSON.stringify([op.terms.network,FIXTURE_IDENTITY,op.terms.buyer.wallet])}`;
      const retained=await w.h.journal.get(lane);await w.h.journal.put(lane,{...retained,stage:'broadcast-started'});
      await assert.rejects(c.capability.readLane(op,lane.slice('sr2/wallet/'.length)),{code:'wallet_fenced'});
      await w.h.journal.put(lane,retained);
    }else assert.ok(stepCounts.every(s=>s.total===stepCounts[0].total&&s.total>0));
  }
  assert.deepEqual(rows[1].stepCounts[0].reads,rows[0].stepCounts[0].reads);
  // A full read: identity + transaction + block twice (read, verifyReceipt), search once, native GET twice.
  const full={searchStoragePrograms:1,getTxByHash:2,getBlockByNumber:5,native:2};
  assert.deepEqual(rows[0].stepCounts.map(s=>[s.reads,s.total]),Array(4).fill([full,10]));
  assert.deepEqual(rows[1].stepCounts.map(s=>s.total),[10,3,3,0]);
  t.diagnostic(JSON.stringify(rows));
});

test('cache mismatches still fail against actual chain: hash, block, content and signed scope',async(t)=>{
  const w=await nativePaymentFlow(t);await w.agreement();const c=consumer(w,{enabled:true});await c.capability.verifyAgreement(w.op());
  for(const change of [a=>a.anchorReceipt.transactionRef.value='a'.repeat(64),a=>a.anchorReceipt.blockRef.id='a'.repeat(64),
    a=>a.anchorReceipt.blockRef.height='999',a=>a.anchorReceipt.contentHash='a'.repeat(64),a=>a.hash='a'.repeat(64),a=>a.signedProjection.hash='a'.repeat(64)]){
    const op=structuredClone(w.op());change(op.state.protocol.agreement);const before=c.requests.length;
    await assert.rejects(c.capability.verifyAgreement(op),{code:'agreement_unverified'});assert.ok(c.requests.length>before,'changed coordinates must read fresh');
  }
  const before=c.requests.length;await c.capability.verifyAgreement(w.op());assert.equal(counts(c.requests.slice(before)).getTxByHash,0,'valid entry remains isolated');
});

test('switch off preserves legacy request bytes and outputs, including failed readback',async(t)=>{
  const w=await nativePaymentFlow(t);await w.agreement();const c=consumer(w);const op=w.op();
  const legacy=createSellerSr2AgreementAnchor({rpcUrl:w.h.chain.url,fetchImpl:c.fetchImpl,now:c.now});
  async function previousVerify(){
    const a=op.state.protocol.agreement;
    const r=await legacy.readAgreement({logicalAddress:a.ref.anchor.locator,writer:claimForAddress(op.terms.buyer.wallet),agreementHash:a.hash,signedProjection:a.signedProjection});
    if(r.disposition!=='present'||r.native.nativeAddress!==a.anchorReceipt.nativeAddress||r.native.txRef.writeTxHash!==a.anchorReceipt.transactionRef.value)throw new OperationError('agreement_unverified','fresh native Agreement/projection readback did not verify; no payment is issued');
  }
  const capture=async(work)=>{c.requests.length=0;let output;try{output=await work();}catch(e){output={code:e.code,message:e.message,details:e.details};}return JSON.stringify({requests:c.requests,output});};
  for(const unavailable of [false,true]){
    w.h.chain.faults.unavailable=unavailable;
    assert.equal(await capture(()=>c.capability.verifyAgreement(op)),await capture(previousVerify));
  }
  w.h.chain.faults.unavailable=false;
});

test('configured portal reuses readback through payment, restart reads fresh, no resend protection remains',async(t)=>{
  const w=await nativePaymentFlow(t,{readbackCache:'1'});assert.equal(w.h.config.readbackCache,true);await w.agreement();
  const initial=await w.api('challenge',{address:w.address});assert.equal(initial.httpStatus,200,JSON.stringify(initial));
  // A cached verified inclusion survives only in this process. Commitment and
  // mutable nonce/balance reads still use their original paths.
  w.h.chain.faults.native=()=>{throw Error('TEST Agreement read unavailable');};
  const cached=await w.api('challenge',{address:w.address});assert.equal(cached.httpStatus,200,JSON.stringify(cached));
  await w.h.restart();assert.equal((await w.api('challenge',{address:w.address})).error,'agreement_unverified');
  w.h.chain.faults.native=null;
  const {handoff}=await w.approve();assert.equal(handoff.status,'payment_handoff');
  const sent=await w.send(handoff.payload);assert.equal(sent.success,true,JSON.stringify(sent));
  assert.equal((await w.api('report',{txHash:sent.data.hash})).status,'settled_verified');
  await w.h.restart();assert.equal((await w.api('handoff')).error,'invalid_state');assert.equal((await w.verify()).status,'settled_verified');
  assert.equal(w.h.chain.record.broadcasts.length,1);assert.equal(w.h.chain.wire.record.broadcastAttempts.length,1);
});

test('cache tests use owned loopback only',()=>assert.deepEqual(externalAttempts,[]));


test('source cache preserves the current transport binding check, and off retains its legacy short-TTL reuse',async(t)=>{
  const w=await devnetAgreementTransportFlow(t);await w.agreement();
  const op=w.op();
  const make=(readbackCache)=>nativeAgreementPaymentConfig(w.h.capability,{walletConfig:{rpcUrl:w.h.expected.endpoint,journal:w.h.journal,sourceCapability:w.h.capability},sellerSr2Commitment:{publicProjection:true},coordinates:w.h.app.services.coordinates,now:()=>Date.now(),readbackCache});
  const cache=createPurchaseReadbackCache({loadPurchase:()=>w.op()}),c=make(cache);
  await c.verifyAgreement(op);
  const start=w.h.requests.length;await c.verifyAgreement(op);
  assert.ok(!w.h.requests.slice(start).some(r=>r.message==='getTxByHash'),'cached source inclusion skips the transaction/block authentication');
  assert.ok(w.h.requests.slice(start).some(r=>r.message==='searchStoragePrograms'),'a payment-gate hit still re-reads current program state');
  w.h.chain.faults.unavailable=true;
  await assert.rejects(c.verifyAgreement(op),'cached inclusion cannot skip the live source binding');
  w.h.chain.faults.unavailable=false;
  const wrong=structuredClone(op);wrong.terms.domain.chainIdentity='a'.repeat(64);
  await assert.rejects(c.readLane(wrong,JSON.stringify([op.terms.network,w.h.expected.chainIdentity,op.terms.buyer.wallet])),{code:'network_identity_mismatch'});
  const old=make(null);await old.verifyAgreement(op);
  const before=w.h.requests.length;await old.verifyAgreement(op,{reuseVerified:true});
  assert.ok(!w.h.requests.slice(before).some(r=>r.message==='getTxByHash'),'existing TTL reuse stays off-path compatible');
  const fresh=w.h.requests.length;await old.verifyAgreement(op);
  assert.ok(w.h.requests.slice(fresh).some(r=>r.message==='getTxByHash'),'off still reads fresh at the payment gate');
});

test('operation stage notifications evict the configured cache at delivery-ready',async(t)=>{
  const w=await nativePaymentFlow(t,{readbackCache:'1'});await w.agreement();
  const challenge=await w.api('challenge',{address:w.address});assert.equal(challenge.httpStatus,200);
  const op=w.op(),ops=w.h.app.services.ops;
  ops.transition(op.id,op.status,op.status,{state:{protocol:{...op.state.protocol,stage:'delivery-ready'}}});
  // Restore the original scope as a stale-save witness: the old entry must
  // already be gone, even when durable state later carries the old stage.
  ops.transition(op.id,op.status,op.status,{state:{protocol:op.state.protocol}});
  w.h.chain.faults.native=()=>{throw Error('TEST unavailable');};
  assert.equal((await w.api('challenge',{address:w.address})).error,'agreement_unverified');
  w.h.chain.faults.native=null;
});

// ---- an earlier review ----
const tampered=(n)=>({...n,data:{...n.data,tampered:true}});
for(const [path,flow] of [['native',nativePaymentFlow],['source',devnetAgreementTransportFlow]])for(const readbackCache of ['0','1'])
  test(`${path}: approve after the Agreement program changes on chain holds payment, DACS_READBACK_CACHE=${readbackCache}`,async(t)=>{
    const w=await flow(t,{readbackCache});assert.equal(w.h.config.readbackCache,readbackCache==='1');await w.agreement();
    const challenge=await w.api('challenge',{address:w.address});assert.equal(challenge.httpStatus,200,JSON.stringify(challenge));
    w.h.chain.faults.native=tampered;
    const handoff=await w.api('approve',{challengeId:challenge.challengeId,signature:await w.sign(challenge.message)});
    w.h.chain.faults.native=null;
    assert.equal(Boolean(handoff.payload),false,JSON.stringify(handoff));assert.notEqual(handoff.status,'payment_handoff');
  });

test('native: payment-gate hits re-check data, metadata, owner and provenance at approval and lane, and evict on mismatch',async(t)=>{
  const w=await nativePaymentFlow(t);await w.agreement();const c=consumer(w,{enabled:true});const op=w.op();
  const lane=JSON.stringify([op.terms.network,FIXTURE_IDENTITY,op.terms.buyer.wallet]);
  const changes={data:tampered,metadata:n=>({...n,metadata:{...n.metadata,tampered:true}}),owner:n=>({...n,owner:'TEST-other-owner'}),
    createdByTx:n=>({...n,createdByTx:'a'.repeat(64)}),interactionTxs:n=>({...n,interactionTxs:['a'.repeat(64)]}),provenanceAbsent:({createdByTx,interactionTxs,...n})=>n};
  for(const [name,change] of Object.entries(changes))for(const gate of ['approve','lane']){
    await c.capability.verifyAgreement(op,{reuseVerified:true});
    const populated=c.requests.length;await c.capability.verifyAgreement(op,{reuseVerified:true});assert.equal(c.requests.length,populated,'populated');
    w.h.chain.faults.native=change;const before=c.requests.length;
    await assert.rejects(gate==='lane'?c.capability.readLane(op,lane):c.capability.verifyAgreement(op),{code:'agreement_unverified'},`${name} at ${gate}`);
    assert.equal(counts(c.requests.slice(before)).getTxByHash,0,'the current-state recheck rejected it');
    w.h.chain.faults.native=null;
    const after=c.requests.length;await c.capability.verifyAgreement(op,{reuseVerified:true});
    assert.ok(counts(c.requests.slice(after)).getTxByHash>0,'a failed recheck evicts the hit');
  }
});

test('native: a payment-gate hit rejects the same program content at another native address',async(t)=>{
  const w=await nativePaymentFlow(t);await w.agreement();const op=w.op(),original=op.state.protocol.agreement.anchorReceipt.nativeAddress,moved=`stor-${'f'.repeat(40)}`;
  let move=false;
  const reply=(body)=>new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json','x-dacs-simulation':'fixture'}});
  const respond=async(url,init)=>{
    if(!move)return null;
    if(init?.body&&JSON.parse(init.body)?.params?.[0]?.message==='searchStoragePrograms'){const r=await(await fetch(url,init)).json();r.response=r.response.map(row=>({...row,storageAddress:moved}));return reply(r);}
    if(url.endsWith(`/storage-program/${moved}`)){const n=await(await fetch(url.replace(moved,original))).json();return reply({...n,storageAddress:moved});}
    return null;
  };
  const c=consumer(w,{enabled:true,respond});await c.capability.verifyAgreement(op,{reuseVerified:true});
  move=true;await assert.rejects(c.capability.verifyAgreement(op),{code:'agreement_unverified'});
});

test('source with the cache on: reuse hits past the TTL still observe the binding, and the TTL is byte-sensitive',async(t)=>{
  const w=await devnetAgreementTransportFlow(t);await w.agreement();const op=w.op();let clock=Date.now();
  const c=nativeAgreementPaymentConfig(w.h.capability,{walletConfig:{rpcUrl:w.h.expected.endpoint,journal:w.h.journal,sourceCapability:w.h.capability},sellerSr2Commitment:{publicProjection:true},coordinates:w.h.app.services.coordinates,now:()=>clock,readbackCache:createPurchaseReadbackCache({loadPurchase:()=>w.op()})});
  await c.verifyAgreement(op,{reuseVerified:true});clock+=120000;
  const before=w.h.requests.length;await c.verifyAgreement(op,{reuseVerified:true});
  assert.ok(!w.h.requests.slice(before).some(r=>['getTxByHash','searchStoragePrograms'].includes(r.message)),'a reuse hit past the TTL reads no Agreement');
  clock+=120000;w.h.chain.faults.unavailable=true;
  await assert.rejects(c.verifyAgreement(op,{reuseVerified:true}),'a reuse hit cannot skip the live source binding');
  w.h.chain.faults.unavailable=false;await c.verifyAgreement(op,{reuseVerified:true});
  const reordered=structuredClone(op),p=reordered.state.protocol.agreement.signedProjection;p.content=Object.fromEntries(Object.entries(p.content).reverse());
  await assert.rejects(c.verifyAgreement(reordered,{reuseVerified:true}),{code:'agreement_unverified'});
});

test('recheckAgreement binds the receipt to this Agreement, projection and chain on its own',async(t)=>{
  const w=await nativePaymentFlow(t);await w.agreement();const op=w.op(),a=op.state.protocol.agreement;
  const reader=createSellerSr2AgreementAnchor({rpcUrl:w.h.chain.url,now:()=>1791144500000});
  const read={logicalAddress:a.ref.anchor.locator,writer:claimForAddress(op.terms.buyer.wallet),agreementHash:a.hash,signedProjection:a.signedProjection};
  const {receipt}=(await reader.readAgreement(read)).native;
  assert.deepEqual(await reader.recheckAgreement({...read,receipt}),{disposition:'present'});
  const proof=JSON.parse(Buffer.from(receipt.evidence.value,'base64url').toString('utf8'));
  const otherChain={...receipt,evidence:{...receipt.evidence,value:Buffer.from(canonicalize({...proof,chainIdentity:'a'.repeat(64)})).toString('base64url')}};
  for(const [name,request] of Object.entries({projection:{...read,receipt,signedProjection:{...a.signedProjection,hash:'a'.repeat(64)}},chain:{...read,receipt:otherChain},
    logical:{...read,receipt,logicalAddress:'dacs:agreement:TEST-other'},content:{...read,receipt,agreementHash:'a'.repeat(64)}}))
    assert.equal((await reader.recheckAgreement(request)).disposition,'rejected',name);
  w.h.chain.faults.native=n=>({...n,owner:'TEST-other-owner'});
  assert.equal((await reader.recheckAgreement({...read,receipt})).disposition,'absent','no program owned by this writer remains');
  w.h.chain.faults.native=null;
  const legacy=createSellerSr2AgreementAnchor({reader:{read:async()=>null,verifyReceipt:async()=>'valid'}});
  assert.equal((await legacy.recheckAgreement({...read,receipt})).disposition,'indeterminate');
});

test('a byte-reordered signed projection misses the cache, reads fresh and is rejected',async(t)=>{
  const w=await nativePaymentFlow(t);await w.agreement();const op=w.op(),reordered=structuredClone(op);
  const p=reordered.state.protocol.agreement.signedProjection;p.content=Object.fromEntries(Object.entries(p.content).reverse());
  assert.equal(canonicalize(p),canonicalize(op.state.protocol.agreement.signedProjection));
  assert.notEqual(JSON.stringify(p),JSON.stringify(op.state.protocol.agreement.signedProjection));
  for(const enabled of [false,true]){
    const c=consumer(w,{enabled});await c.capability.verifyAgreement(op,{reuseVerified:true});
    for(const reuseVerified of [true,false]){
      const before=c.requests.length;
      await assert.rejects(c.capability.verifyAgreement(reordered,{reuseVerified}),{code:'agreement_unverified'});
      assert.ok(counts(c.requests.slice(before)).getTxByHash>0,'a byte-distinct projection reads fresh');
    }
    if(enabled){const before=c.requests.length;await c.capability.verifyAgreement(op,{reuseVerified:true});assert.equal(c.requests.length,before,'the exact projection still hits');}
  }
});

test('source: payment-gate hits re-check current program state at approval and lane; ended stages keep the short TTL',async(t)=>{
  const w=await devnetAgreementTransportFlow(t);await w.agreement();const op=w.op();
  const make=(loadPurchase)=>nativeAgreementPaymentConfig(w.h.capability,{walletConfig:{rpcUrl:w.h.expected.endpoint,journal:w.h.journal,sourceCapability:w.h.capability},sellerSr2Commitment:{publicProjection:true},coordinates:w.h.app.services.coordinates,now:()=>Date.now(),readbackCache:createPurchaseReadbackCache({loadPurchase})});
  const c=make(()=>w.op()),lane=JSON.stringify([op.terms.network,w.h.expected.chainIdentity,op.terms.buyer.wallet]);
  for(const gate of ['approve','lane']){
    await c.verifyAgreement(op);w.h.chain.faults.native=tampered;const before=w.h.requests.length;
    await assert.rejects(gate==='lane'?c.readLane(op,lane):c.verifyAgreement(op),{code:'agreement_unverified'},gate);
    assert.ok(!w.h.requests.slice(before).some(r=>r.message==='getTxByHash'),'the current-state recheck rejected it');
    w.h.chain.faults.native=null;
  }
  // Node2 may omit both provenance fields; an authenticated source projection admits that, as read() does.
  await c.verifyAgreement(op);w.h.chain.faults.native=({createdByTx,interactionTxs,...n})=>n;const omitted=w.h.requests.length;
  await c.verifyAgreement(op);w.h.chain.faults.native=null;
  assert.ok(!w.h.requests.slice(omitted).some(r=>r.message==='getTxByHash'),'paired omission is a current-state pass on a source hit');
  const ended=make(()=>({...w.op(),state:{...w.op().state,protocol:{...w.op().state.protocol,stage:'delivered'}}}));
  await ended.verifyAgreement(op,{reuseVerified:true});
  const before=w.h.requests.length;await ended.verifyAgreement(op,{reuseVerified:true});
  assert.ok(!w.h.requests.slice(before).some(r=>r.message==='getTxByHash'),'an ended purchase reuses within the legacy TTL');
});
