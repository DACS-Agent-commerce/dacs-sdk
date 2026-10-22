// Item 4: lifecycle propagation of the Node2 policies through the reachable
// binding phases of the admitted demo transport (operator.mjs:123-124):
// bind, signature (recover + beforeSignature), readback (recover), readRpc
// (bind per read), release/close and the broadcast-phase/rpc refusals.
// Offline .invalid stubs only. The 'signature' phase is the binder's
// pre-signature fence: nothing is signed, no CREATE/payment/broadcast is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemosNetworkBinder } from '../src/dacs/network-binding.mjs';
import { BLOCK_ONE, CHAIN, ENDPOINT, NETWORK, NOW, OTHER, PIN, RETAINED_HASH, TRANSPORT, WALLET, admittedTransport, alignedOne, envelopeAdmission, envelopeChain,
  layoutAdmission, layoutChain, memoryJournal, mutableOwner, offsetOne, offsetTwo } from './helpers/review-node2-current-coverage-fixture.mjs';

const FENCED='Node2 run connection is unavailable or already fenced';
const NONCE_READ={method:'nodeCall',params:[{message:'getAddressNonce',data:{address:WALLET}}]};
const EXTRA={getTransactionStatus:{result:200,response:{state:'pending'}},getAddressNonce:{result:200,response:7}};
// Retained-row SHAPE fixture for the readback seam: it carries no signature,
// is never verified or relayed, and the test claims only a 'pending' answer.
const retainedRow=(binding)=>({hash:RETAINED_HASH,nonce:1,stage:'broadcast-answered',signedTransaction:{hash:RETAINED_HASH,content:{type:'native',from:WALLET}},networkBinding:binding});
const runtime=(t,admission,answers,options)=>{const run=admittedTransport(admission,answers,options);t.after(()=>run.capability.close());return run;};
async function prepare(run){const {binding}=await run.bind();run.journal.seed(`devnet/native-transfer/${RETAINED_HASH}`,retainedRow(binding));return {saved:binding,from:run.stub.calls.length};}
const others=(run,from)=>run.stub.messages(from).filter((m)=>m!=='getBlockByNumber');

const KINDS={
  layout:{admission:layoutAdmission,chain:layoutChain,reads:[0,1,2],identity:{1:offsetOne({content:{previousHash:OTHER}})},continuation:{2:offsetTwo({hash:OTHER})}},
  envelope:{admission:envelopeAdmission,chain:envelopeChain,reads:[0,1],identity:{1:alignedOne({content:{previousHash:OTHER}})},continuation:null},
};
const PHASES={
  bind:{observations:1,tail:[],run:(cap)=>cap.binding({phase:'bind',address:WALLET}),
    check:(v)=>{assert.equal(v.binding.chainIdentity,CHAIN);assert.equal(v.binding.source.blockHash,BLOCK_ONE);assert.equal(v.pending,null);}},
  signature:{observations:2,tail:[],run:(cap,saved)=>cap.binding({phase:'signature',address:WALLET,binding:saved}),
    check:(v)=>{assert.match(v.leaseId,/^[0-9a-f]{32}$/);assert.equal(v.expiresAt,NOW+30000);assert.equal(v.binding.chainIdentity,CHAIN);assert.equal(v.binding.source.blockHash,BLOCK_ONE);},
    cleanup:async(cap,v)=>assert.deepEqual(await cap.binding({phase:'release',address:WALLET,leaseId:v.leaseId}),{released:true})},
  readback:{observations:1,tail:['getTransactionStatus'],run:(cap)=>cap.binding({phase:'readback',address:WALLET,hash:RETAINED_HASH}),
    check:(v)=>assert.deepEqual(v,{disposition:'pending',hash:RETAINED_HASH,nonce:1,noResend:true})},
  readRpc:{observations:1,tail:['getAddressNonce'],run:(cap)=>cap.readRpc('/',NONCE_READ),check:(v)=>assert.deepEqual(v,{result:200,response:7})},
};

for(const [kindName,kind] of Object.entries(KINDS))for(const [phaseName,phase] of Object.entries(PHASES))
  test(`lifecycle ${kindName}/${phaseName}: one valid baseline; identity, continuation, connection, endpoint and owner holds; no write`,async t=>{
    const admission=await kind.admission(),answers={...kind.chain(),...EXTRA};
    {
      const run=runtime(t,admission,answers),{saved,from}=await prepare(run),value=await phase.run(run.capability,saved);
      phase.check(value);
      assert.deepEqual(run.stub.heights(from),phase.observations===2?[...kind.reads,...kind.reads]:kind.reads);
      assert.deepEqual(others(run,from),phase.tail);assert.deepEqual(run.journal.puts,[]);
      await phase.cleanup?.(run.capability,value);
    }
    for(const [name,change,code,heights] of [['identity',kind.identity,'identity_mismatch',kind.reads],...(kind.continuation?[['changed continuation',kind.continuation,'unavailable',[0,1,2]]]:[])]){
      const run=runtime(t,admission,answers),{saved,from}=await prepare(run);run.stub.set(change);
      await assert.rejects(phase.run(run.capability,saved),{code},name);
      assert.deepEqual(run.stub.heights(from),heights,name);assert.deepEqual(others(run,from),[],name);assert.deepEqual(run.journal.puts,[],name);
      run.stub.set(kind.chain());assert.equal((await run.bind()).binding.chainIdentity,CHAIN,`${name}: fence and binder are reusable`);
    }
    for(const name of ['connection','endpoint']){
      const owner=mutableOwner(),last=kind.reads.at(-1);let armed=false;
      const run=runtime(t,admission,answers,{owner,onRequest:(entry)=>{if(armed&&entry.blockNumber===last){armed=false;owner.state.connectionId='review-cov-connection-2';}}});
      const {saved,from}=await prepare(run);
      if(name==='connection')armed=true;else owner.state.endpoint='https://other-node2.invalid/';
      await assert.rejects(phase.run(run.capability,saved),{code:name==='connection'?'connection_changed':'transport_mismatch'},name);
      assert.deepEqual(run.stub.heights(from),name==='connection'?kind.reads:[],name);assert.deepEqual(others(run,from),[],name);
      const counts=owner.counts();assert.equal(counts.held,false,name);assert.equal(counts.acquired,counts.released,name);assert.deepEqual(run.journal.puts,[],name);
    }
    {
      const run=runtime(t,admission,answers),{saved,from}=await prepare(run);run.owner.close();
      await assert.rejects(phase.run(run.capability,saved),{message:FENCED});
      assert.equal(run.stub.calls.length,from);assert.deepEqual(run.journal.puts,[]);
    }
  });

test('signature phase refuses a saved binding that differs from the admitted identity before any read',async t=>{
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),...EXTRA}),{saved,from}=await prepare(run);
  for(const binding of [{...saved,chainIdentity:OTHER},{...saved,pinVersion:'TEST-other-pin'},{...saved,source:{...saved.source,fallbackDocumentation:'other'}},{...saved,source:{...saved.source,kind:'block-zero-hash'}}])
    await assert.rejects(run.capability.binding({phase:'signature',address:WALLET,binding}),{code:'binding_mismatch'});
  assert.equal(run.stub.calls.length,from);assert.deepEqual(run.journal.puts,[]);
  assert.equal((await run.bind()).binding.chainIdentity,CHAIN,'the fence was released after each refusal');
});

test('concurrent binds: the actual owner fence admits one observation, refuses the other without reads, then is reusable',async t=>{
  const run=runtime(t,await layoutAdmission(),layoutChain());
  const [a,b]=await Promise.allSettled([run.bind(),run.bind()]);
  assert.equal(a.status,'fulfilled');assert.equal(b.status,'rejected');assert.equal(b.reason.message,FENCED);
  assert.deepEqual(run.stub.heights(),[0,1,2]);
  assert.equal((await run.bind()).binding.chainIdentity,CHAIN);
});

test('concurrent readRpc is serialized by the journal lane lock; without it the owner fence refuses the second read',async t=>{
  const answers={...layoutChain(),...EXTRA};
  const run=runtime(t,await layoutAdmission(),answers);
  assert.deepEqual(await Promise.all([run.capability.readRpc('/',NONCE_READ),run.capability.readRpc('/',NONCE_READ)]),[{result:200,response:7},{result:200,response:7}]);
  const once=['getBlockByNumber','getBlockByNumber','getBlockByNumber','getAddressNonce'];assert.deepEqual(run.stub.messages(),[...once,...once]);
  const loose=runtime(t,await layoutAdmission(),answers,{journal:memoryJournal({serialize:false})});
  const settled=await Promise.allSettled([loose.capability.readRpc('/',NONCE_READ),loose.capability.readRpc('/',NONCE_READ)]);
  assert.deepEqual(settled.map((s)=>s.status).sort(),['fulfilled','rejected']);assert.equal(settled.find((s)=>s.status==='rejected').reason.message,FENCED);
});

test('readRpc binds before its own allow-list check: a refused read observes identity but sends no refused request',async t=>{
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),...EXTRA});
  for(const body of [{method:'execute',params:[{extra:'broadcastTx'}]},{method:'nodeCall',params:[{message:'sendTransaction',data:{}}]}])
    await assert.rejects(run.capability.readRpc('/',body),{code:'readonly_only'});
  await assert.rejects(run.capability.readRpc('/other',undefined),{code:'readonly_only'});
  assert.deepEqual(others(run,0),[]);assert.deepEqual(run.stub.heights(),[0,1,2,0,1,2,0,1,2]);assert.deepEqual(run.journal.puts,[]);
});

test('signature lease holds the connection fence until exact release; wrong-id release reports released but keeps the fence',async t=>{
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),...EXTRA}),{saved}=await prepare(run);
  const lease=await run.capability.binding({phase:'signature',address:WALLET,binding:saved}),from=run.stub.calls.length;
  await assert.rejects(run.bind(),{message:FENCED});await assert.rejects(run.capability.readRpc('/',NONCE_READ),{message:FENCED});
  await assert.rejects(run.capability.binding({phase:'signature',address:WALLET,binding:saved}),{code:'wallet_fenced'});
  assert.deepEqual(await run.capability.binding({phase:'release',address:WALLET,leaseId:'0'.repeat(32)}),{released:true});
  await assert.rejects(run.bind(),{message:FENCED},'a wrong lease id does not release the fence');
  assert.equal(run.stub.calls.length,from);
  assert.deepEqual(await run.capability.binding({phase:'release',address:WALLET,leaseId:lease.leaseId}),{released:true});
  assert.equal((await run.bind()).binding.chainIdentity,CHAIN);assert.deepEqual(run.journal.puts,[]);
});

test('broadcast phase and rpc relay refuse without a confirmed signed transaction: no read, write or relay',async t=>{
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),...EXTRA}),{saved}=await prepare(run);
  await assert.rejects(run.capability.binding({phase:'broadcast',address:WALLET,leaseId:'0'.repeat(32),hash:RETAINED_HASH}),{code:'network_binding_required'});
  const lease=await run.capability.binding({phase:'signature',address:WALLET,binding:saved}),from=run.stub.calls.length;
  await assert.rejects(run.capability.binding({phase:'broadcast',address:WALLET,leaseId:lease.leaseId,hash:RETAINED_HASH}),{code:'native_confirmation_required'});
  for(const body of [
    {method:'execute',params:[{extra:'confirmTx',data:{hash:RETAINED_HASH,content:{type:'native',from:'0x01'}}}]},
    {method:'execute',params:[{extra:'broadcastTx',data:{response:{data:{transaction:{hash:RETAINED_HASH,content:{type:'native',from:'0x01'}}}}}}]},
    {method:'execute',params:[{extra:'broadcastTx',data:{}}]},{method:'execute',params:[{extra:'sendTransaction'}]},
  ])await assert.rejects(run.capability.rpc(body,{}),{code:'native_only'});
  assert.equal(run.stub.calls.length,from);assert.deepEqual(run.journal.puts,[]);
  await run.capability.binding({phase:'release',address:WALLET,leaseId:lease.leaseId});
});

test('close drains, releases an active lease fence, and admits no new phase',async t=>{
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),...EXTRA}),{saved}=await prepare(run);
  await run.capability.binding({phase:'signature',address:WALLET,binding:saved});
  await run.capability.close();
  const fence=await run.owner.acquireConnectionFence();fence.release();
  for(const work of [()=>run.bind(),()=>run.capability.readRpc('/',NONCE_READ),()=>run.capability.binding({phase:'readback',address:WALLET,hash:RETAINED_HASH})])
    await assert.rejects(work(),{code:'transport_closed'});
  assert.deepEqual(run.journal.puts,[]);
});

test('layered: recheck/recover/beforeSignature/beforeBroadcast share one binder observe path over the normalized value',async()=>{
  // The transport reader receives (height, policy) and never the phase
  // (devnet-native-transport.mjs:135), so phase behavior lives in the binder.
  const make=(one)=>{const context={network:NETWORK,endpoint:ENDPOINT,transportAuthority:TRANSPORT,connectionId:'layered-1'};
    return createDemosNetworkBinder({expected:{network:NETWORK,chainIdentity:CHAIN,pinVersion:PIN,endpoint:ENDPOINT,transportAuthority:TRANSPORT},now:()=>NOW,
      fallback:{blockZeroUnavailable:'literal-error',documentation:'TEST layered witness'},reader:{getContext:()=>context,
        getBlockByNumber:async(height)=>({value:height===0?'error':{result:200,response:one},context,observedAt:NOW,fromCache:false,redirected:false})}});};
  const normalized={number:1,status:'confirmed',hash:BLOCK_ONE,content:{previousHash:CHAIN}},phases=['recheck','recover','beforeSignature','beforeBroadcast'];
  const ok=make(normalized),saved=await ok.bind();
  for(const phase of phases){assert.deepEqual(await ok[phase](saved),saved,phase);assert.throws(()=>ok[phase](),{code:'binding_mismatch'});}
  for(const [one,code] of [[{...normalized,content:{previousHash:OTHER}},'identity_mismatch'],[{...normalized,id:2},'wrong_block'],[{...normalized,status:'pending'},'wrong_block']]){
    const held=make(one);for(const phase of phases)await assert.rejects(held[phase](saved),{code},`${phase}:${code}`);
  }
});
