// Follow-up coverage for the repaired SR-2 source identity seam:
// adapter chainIdentity() -> opaque observeBinding() -> tracked -> journal
// source-read lane -> owner fence -> binder.bind() -> exact declaration check.
// Offline .invalid stubs only. Unsigned plan/handoff records stay in memory;
// nothing is signed, submitted, paid or broadcast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal, DEMOS_SR2_FIXTURE_CHAIN_IDENTITY, DENIED_UNSIGNED } from '../src/dacs/demos-sr2-adapter.mjs';
import { createDevnetNativeTransport } from '../src/wallet/devnet-native-transport.mjs';
import { CHAIN, ENDPOINT, NETWORK, NOW, OTHER, PIN, TRANSPORT, WALLET, WRITER, admittedTransport, blockZeroAdmission, envelopeAdmission, envelopeChain, layoutAdmission, layoutChain,
  memoryJournal, mutableOwner, node2Zero, offsetOne, offsetTwo, zeroBlock } from './helpers/review-node2-current-coverage-fixture.mjs';
import { LOGICAL, SEARCH, createReadOnlySr2Adapter, readAbsent } from './helpers/node2-sr2-binding-consumer.mjs';
import { DECLARED_KEYS, FIXTURE_RPC, NONCE, OBSERVATION_KEYS, PLAN_INPUT, fixtureStub, planningAdapter } from './helpers/review-sr2-binding-coverage-fixture.mjs';

const UNAVAILABLE=(code)=>`source-bound chain identity observation unavailable: ${code}`;
const runtime=(t,admission,answers,options)=>{const run=admittedTransport(admission,answers,options);t.after(()=>run.capability.close());return run;};
const nonBlock=(run,from=0)=>run.stub.messages(from).filter((m)=>m!=='getBlockByNumber');

test('data pin: a real observeBinding record satisfies every adapter acceptance check (so a cached copy would too)',async t=>{
  for(const [admission,chain,reads] of [[layoutAdmission,layoutChain,[0,1,2]],[envelopeAdmission,envelopeChain,[0,1]],[blockZeroAdmission,()=>({0:zeroBlock()}),[0]]]){
    const run=runtime(t,await admission(),chain()),observed=await run.capability.observeBinding();
    assert.deepEqual(Object.keys(observed).sort(),OBSERVATION_KEYS);
    for(const key of DECLARED_KEYS)assert.equal(observed[key],run.capability.transportBinding[key],key);
    assert.equal(observed.chainIdentity,run.capability.pins.chainIdentity);assert.ok(observed.expiresAt>observed.observedAt);
    assert.deepEqual(run.stub.heights(),reads);assert.deepEqual(run.journal.puts,[]);
  }
});

test('no cached success: after an accepted read the same adapter re-observes and holds a changed continuation or identity',async t=>{
  for(const [change,code] of [[{2:offsetTwo({hash:OTHER})},'unavailable'],[{1:offsetOne({content:{previousHash:OTHER}})},'identity_mismatch']]){
    const run=runtime(t,await layoutAdmission(),{...layoutChain(),...SEARCH}),adapter=createReadOnlySr2Adapter(run.capability);
    assert.equal((await adapter.read(LOGICAL,{expectedWriter:WRITER})).status,'absent');
    run.stub.set(change);const from=run.stub.calls.length;
    await assert.rejects(adapter.read(LOGICAL,{expectedWriter:WRITER}),{code:'indeterminate',message:UNAVAILABLE(code)});
    assert.deepEqual(run.stub.heights(from),[0,1,2]);assert.deepEqual(nonBlock(run,from),[],'name index not reached');assert.deepEqual(run.journal.puts,[]);
    run.stub.set(layoutChain());assert.equal((await adapter.read(LOGICAL,{expectedWriter:WRITER})).status,'absent');
  }
});

test('time: a stale fallback observation holds before the index; the next stable read is fresh and absent',async t=>{
  let time=NOW,armed=false;
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),...SEARCH},{now:()=>time,onRequest:({blockNumber})=>{if(armed&&blockNumber===1){armed=false;time+=60_001;}}});
  armed=true;
  await assert.rejects(readAbsent(run.capability),{code:'indeterminate',message:UNAVAILABLE('stale_observation')});
  assert.deepEqual(run.stub.heights(),[0,1,2]);assert.deepEqual(nonBlock(run),[]);
  assert.equal((await readAbsent(run.capability)).status,'absent');assert.deepEqual(nonBlock(run),['searchStoragePrograms']);
});

test('fence interaction: an active signature lease on the same capability holds SR-2 reads without waiting; release restores them',async t=>{
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),...SEARCH}),{binding}=await run.bind();
  const lease=await run.capability.binding({phase:'signature',address:WALLET,binding}),from=run.stub.calls.length;
  await assert.rejects(readAbsent(run.capability),{code:'indeterminate',message:UNAVAILABLE('transport')});
  assert.equal(run.stub.calls.length,from);assert.deepEqual(run.journal.puts,[]);
  assert.deepEqual(await run.capability.binding({phase:'release',address:WALLET,leaseId:lease.leaseId}),{released:true});
  assert.equal((await readAbsent(run.capability)).status,'absent');
});

test('source brand: copies, prototypes, look-alikes and the native-only transport are refused before any read',async t=>{
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),...SEARCH}),capability=run.capability,spread={...capability};
  // Witness: the spread copy carries the same observeBinding and declaration,
  // so only the opaque brand distinguishes it.
  assert.equal(typeof spread.observeBinding,'function');assert.equal(spread.transportBinding,capability.transportBinding);
  const nativeOnly=createDevnetNativeTransport({expected:{network:NETWORK,chainIdentity:CHAIN,pinVersion:PIN,endpoint:ENDPOINT,transportAuthority:TRANSPORT},transportOwner:mutableOwner(),journal:memoryJournal()});
  t.after(()=>nativeOnly.close());
  for(const forged of [spread,Object.create(capability),{observeBinding:capability.observeBinding,transportBinding:capability.transportBinding,pins:capability.pins,readRpc:capability.readRpc},nativeOnly])
    assert.throws(()=>createDemosSr2Adapter({rpcUrl:ENDPOINT,sourceCapability:forged,journal:createInMemoryDemosSr2Journal(),now:()=>NOW}),{code:'source-held'});
  for(const rpcUrl of ['https://node2-current-coverage.invalid','https://node2-current-coverage.invalid/rpc'])
    assert.throws(()=>createDemosSr2Adapter({rpcUrl,sourceCapability:capability,journal:createInMemoryDemosSr2Journal(),now:()=>NOW}),{code:'offline-only'});
  assert.throws(()=>createDemosSr2Adapter({rpcUrl:ENDPOINT,journal:createInMemoryDemosSr2Journal(),now:()=>NOW}),{code:'offline-only'},'default (no capability) refuses a non-loopback endpoint');
  assert.deepEqual(run.stub.calls,[]);
});

test('fixture branch is separate: no binder, direct block zero, and the Node2 literal-error envelope stays held there',async()=>{
  const ok=fixtureStub({0:{result:200,response:{number:0,status:'confirmed',hash:DEMOS_SR2_FIXTURE_CHAIN_IDENTITY}},...SEARCH});
  const fixture=createDemosSr2Adapter({rpcUrl:FIXTURE_RPC,journal:createInMemoryDemosSr2Journal(),fetchImpl:ok.fetchImpl,now:()=>NOW});
  assert.equal((await fixture.read(LOGICAL,{expectedWriter:WRITER})).status,'absent');assert.deepEqual(ok.calls,['block:0','searchStoragePrograms']);
  for(const zero of [node2Zero(),{result:200,response:{number:0,status:'confirmed',hash:OTHER}}]){
    const held=fixtureStub({0:zero,...SEARCH});
    await assert.rejects(createDemosSr2Adapter({rpcUrl:FIXTURE_RPC,journal:createInMemoryDemosSr2Journal(),fetchImpl:held.fetchImpl,now:()=>NOW}).read(LOGICAL,{expectedWriter:WRITER}),
      {code:zero.result===400?'indeterminate':'invalid-chain'});
    assert.deepEqual(held.calls,['block:0']);
  }
});

test('plan context: unsigned planWrite consumes a fresh source observation before index and nonce reads',async t=>{
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),...SEARCH,...NONCE}),{adapter,journal,stages}=planningAdapter(run.capability);
  const plan=await adapter.planWrite(PLAN_INPUT);
  assert.equal(plan.stage,'prepared');assert.equal(plan.nonce,8);assert.equal(plan.evidenceMode,'explicit-pinned-transport-single-node');
  const record=await journal.get(plan.planId);
  assert.deepEqual(record.metadata.networkBinding,run.capability.transportBinding);assert.equal(record.payload.content.from,WALLET);
  assert.deepEqual(run.stub.messages(),[...Array(6).fill('getBlockByNumber'),'searchStoragePrograms',...Array(3).fill('getBlockByNumber'),'getAddressNonce']);
  assert.deepEqual(stages,['prepared']);assert.deepEqual(run.journal.puts,[],'the source transport journal is never written');
});

test('plan context hold: a changed identity holds planWrite before index/nonce and persists no plan',async t=>{
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),1:offsetOne({content:{previousHash:OTHER}}),...SEARCH,...NONCE}),{adapter,journal,stages}=planningAdapter(run.capability);
  await assert.rejects(adapter.planWrite(PLAN_INPUT),{code:'indeterminate',message:UNAVAILABLE('identity_mismatch')});
  assert.deepEqual(nonBlock(run),[]);assert.deepEqual(stages,[]);assert.deepEqual(await journal.records(),[]);
});

test('handoff context: storage-anchor handoff re-observes freshly; a changed continuation keeps the plan prepared and releases lane and fence',async t=>{
  const owner=mutableOwner(),run=runtime(t,await layoutAdmission(),{...layoutChain(),...SEARCH,...NONCE},{owner}),{adapter,journal,stages}=planningAdapter(run.capability);
  const plan=await adapter.planWrite(PLAN_INPUT);
  run.stub.set({2:offsetTwo({hash:OTHER})});const from=run.stub.calls.length;
  await assert.rejects(adapter.takeStorageAnchorHandoff({planId:plan.planId,walletAddress:WALLET,network:NETWORK}),{code:'indeterminate',message:UNAVAILABLE('unavailable')});
  assert.deepEqual(run.stub.heights(from),[0,1,2]);assert.deepEqual(nonBlock(run,from),[]);assert.equal((await journal.get(plan.planId)).stage,'prepared');
  assert.deepEqual(owner.counts(),{acquired:owner.counts().released,released:owner.counts().released,held:false});
  // Same plan, wrong network label: refused after the fresh observation; still prepared.
  run.stub.set(layoutChain());
  await assert.rejects(adapter.takeStorageAnchorHandoff({planId:plan.planId,walletAddress:WALLET,network:'demos-other'}),{code:'invalid-chain'});
  assert.equal((await journal.get(plan.planId)).stage,'prepared');
  // Exact network on the restored chain: the writer lane and fence were released.
  const issued=await adapter.takeStorageAnchorHandoff({planId:plan.planId,walletAddress:WALLET,network:NETWORK});
  assert.equal(issued.stage,'handoff-issued');assert.equal(issued.unsignedTransaction.content.network,NETWORK);assert.equal(issued.unsignedTransaction.content.chainIdentity,CHAIN);
  // Unsigned template (wallet-transactions.mjs:95-96): no signature or hash is supplied here.
  assert.equal(issued.unsignedTransaction.signature,null);assert.equal(issued.unsignedTransaction.hash,'');
  assert.deepEqual(stages,['prepared','handoff-issued']);assert.deepEqual(run.journal.puts,[]);
});

test('resume/retire context: denied-handoff retirement requires a fresh observation; a changed identity keeps the handoff fenced',async t=>{
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),...SEARCH,...NONCE}),{adapter,journal}=planningAdapter(run.capability);
  const plan=await adapter.planWrite(PLAN_INPUT);await adapter.takeStorageAnchorHandoff({planId:plan.planId,walletAddress:WALLET,network:NETWORK});
  const retire={logicalAddress:PLAN_INPUT.logicalAddress,writer:WRITER,walletAddress:WALLET,provesUnsigned:async()=>true};
  run.stub.set({1:offsetOne({content:{previousHash:OTHER}})});const from=run.stub.calls.length;
  await assert.rejects(adapter.retireDeniedHandoff(retire),{code:'indeterminate',message:UNAVAILABLE('identity_mismatch')});
  assert.deepEqual(nonBlock(run,from),[]);assert.equal((await journal.get(plan.planId)).stage,'handoff-issued');
  run.stub.set(layoutChain());
  assert.equal((await adapter.retireDeniedHandoff(retire)).stage,DENIED_UNSIGNED);
  assert.deepEqual(nonBlock(run,from),['searchStoragePrograms','getAddressNonce']);assert.deepEqual(run.journal.puts,[]);
});
