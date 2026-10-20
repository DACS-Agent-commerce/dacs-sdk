// Items 2 and 3: explicit Node2 number/id-plus-one empty-extra layout at
// block one and its block-two continuation, and the reviewed blockTwoHash flow
// observation -> admission -> readback -> createAdmittedNode2DemoTransport ->
// native reader (before normalization) -> unchanged binder. Offline .invalid
// stubs only; no public RPC, TLS, wallet, signature, CREATE or broadcast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitObservedNode2Identity, createAdmittedNode2DemoTransport, createNode2TransportOwner, observeNode2Identity, readNode2Admission } from '../src/devnet-demo/operator-network.mjs';
import { createDemosNetworkBinder } from '../src/dacs/network-binding.mjs';
import { createDevnetDemoTransport, DEVNET_NODE2_BLOCK_LAYOUT } from '../src/wallet/devnet-native-transport.mjs';
import { BLOCK_ONE, BLOCK_TWO, CHAIN, ENDPOINT, ENVELOPE_TOKEN, LAYOUT_TOKEN, NETWORK, NOW, OTHER, PIN, PREDECESSOR_SOURCE, TRANSPORT, WRONG, admittedTransport, clock,
  envelopeAdmission, layoutAdmission, layoutChain, legacyZero, memoryJournal, mutableOwner, node2Stub, node2Zero, observe, offsetOne, offsetTwo, review, sha } from './helpers/review-node2-current-coverage-fixture.mjs';

const OPT_IN={blockZeroUnavailable:'literal-error',blockOneLayout:LAYOUT_TOKEN};
const OBSERVATION_KEYS=['format','network','endpoint','chainIdentity','identitySource','blockZeroResult','blockZeroEnvelope','blockOneLayout','blockOneHash','blockTwoHash','blockZeroObservedAt','observedAt','scope','observationHash'];
const ADMISSION_KEYS=['format','authority','network','endpoint','chainIdentity','identitySource','blockZeroEnvelope','blockOneLayout','blockOneHash','blockTwoHash','fallbackDocumentation','transportAuthority','pinVersion','observationHash','observedAt','reviewedAt','trust','admissionHash'];
const LAYOUT_DIFFERS='the operator-reviewed block-one layout or continuation differs from the observation';
const ADMISSION_REFUSED='Node2 admission is not the exact reviewed TEST record';
const documentation=(observationHash,blockTwoHash)=>`Run-scoped single-node TEST Node2 predecessor: observation=${observationHash}; zero=${ENVELOPE_TOKEN}; layout=${LAYOUT_TOKEN}; block2=${blockTwoHash}; not a production trust pin.`;
const rehash=(value)=>{const {admissionHash:_drop,...scope}=value;return {...scope,admissionHash:sha(JSON.stringify(scope))};};
const temp=async(t)=>{const dir=await mkdtemp(join(tmpdir(),'review-node2-cov-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
const runtime=(t,admission,answers,options)=>{const run=admittedTransport(admission,answers,options);t.after(()=>run.capability.close());return run;};

test('data pin: the exported layout token is the documented Node2 layout token',()=>{assert.equal(DEVNET_NODE2_BLOCK_LAYOUT,LAYOUT_TOKEN);});

test('layout observation reads exactly 0,1,2 and records independent expected heights, hashes and tokens',async()=>{
  const stub=node2Stub(layoutChain());
  const o=await observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,fetchImpl:stub.fetchImpl,now:clock(10_000),...OPT_IN});
  assert.deepEqual(stub.heights(),[0,1,2]);assert.ok(stub.calls.every((c)=>c.path==='/'&&c.method==='POST'&&c.redirect==='error'));
  assert.deepEqual(Object.keys(o).sort(),[...OBSERVATION_KEYS].sort());
  assert.deepEqual([o.chainIdentity,o.blockOneHash,o.blockTwoHash,o.blockZeroResult,o.blockZeroEnvelope,o.blockOneLayout,o.identitySource],[CHAIN,BLOCK_ONE,BLOCK_TWO,400,ENVELOPE_TOKEN,LAYOUT_TOKEN,PREDECESSOR_SOURCE]);
  const {observationHash,...scope}=o;assert.equal(observationHash,sha(JSON.stringify(scope)));
});

test('layout policy pairing at observation: explicit token only, and only with the literal-error fallback',async()=>{
  for(const options of [{blockOneLayout:LAYOUT_TOKEN},{blockZeroUnavailable:'literal-error',blockOneLayout:'node2-number-id-plus-one/v1'},{blockZeroUnavailable:'literal-error',blockOneLayout:true}]){
    const stub=node2Stub(layoutChain());
    await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,fetchImpl:stub.fetchImpl,...options}),{name:'TypeError'});
    assert.deepEqual(stub.calls,[]);
  }
  // Without the layout token the offset block one stays held by the legacy rule.
  const held=node2Stub(layoutChain());
  await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,fetchImpl:held.fetchImpl,blockZeroUnavailable:'literal-error'}),/exact result-200 SDK envelope required/);
  assert.deepEqual(held.heights(),[0,1]);
  // Layout with the legacy two-field zero is observed but never admissible.
  const legacy=await observe({...layoutChain(),0:legacyZero()},OPT_IN);
  assert.equal(legacy.blockOneLayout,LAYOUT_TOKEN);assert.equal(legacy.blockZeroEnvelope,undefined);
  assert.throws(()=>admitObservedNode2Identity({observation:legacy,...review({reviewedBlockOneLayout:LAYOUT_TOKEN,reviewedBlockTwoHash:BLOCK_TWO})}),{name:'TypeError',message:'the exact single-node predecessor observation is required'});
});

test('layout admission pairing requires exact review of both the token and the block-two hash',async()=>{
  const o=await observe(layoutChain(),OPT_IN),base={reviewedBlockZeroEnvelope:ENVELOPE_TOKEN};
  for(const extra of [{},{reviewedBlockOneLayout:LAYOUT_TOKEN},{reviewedBlockTwoHash:BLOCK_TWO},{reviewedBlockOneLayout:'other',reviewedBlockTwoHash:BLOCK_TWO},
    {reviewedBlockOneLayout:LAYOUT_TOKEN,reviewedBlockTwoHash:BLOCK_ONE},{reviewedBlockOneLayout:LAYOUT_TOKEN,reviewedBlockTwoHash:OTHER},{reviewedBlockOneLayout:LAYOUT_TOKEN,reviewedBlockTwoHash:BLOCK_TWO.toUpperCase()}])
    assert.throws(()=>admitObservedNode2Identity({observation:o,...review({...base,...extra})}),{message:LAYOUT_DIFFERS});
  const envelopeOnly=await observe({0:node2Zero(),1:{result:200,response:{number:1,status:'confirmed',hash:BLOCK_ONE,content:{previousHash:CHAIN}}}},{blockZeroUnavailable:'literal-error'});
  for(const extra of [{reviewedBlockTwoHash:BLOCK_TWO},{reviewedBlockOneLayout:LAYOUT_TOKEN}])
    assert.throws(()=>admitObservedNode2Identity({observation:envelopeOnly,...review({...base,...extra})}),{message:LAYOUT_DIFFERS});
});

test('blockTwoHash flow: observe -> admit -> 0600 file -> readNode2Admission -> admitted runtime binds via the unchanged binder',async t=>{
  const o=await observe(layoutChain(),OPT_IN);
  const admission=admitObservedNode2Identity({observation:o,...review({reviewedBlockZeroEnvelope:ENVELOPE_TOKEN,reviewedBlockOneLayout:LAYOUT_TOKEN,reviewedBlockTwoHash:BLOCK_TWO})});
  assert.deepEqual(Object.keys(admission).sort(),[...ADMISSION_KEYS].sort());
  assert.equal(admission.blockTwoHash,BLOCK_TWO);assert.equal(admission.fallbackDocumentation,documentation(o.observationHash,BLOCK_TWO));
  const path=join(await temp(t),'admission.json');await writeFile(path,JSON.stringify(admission),{mode:0o600});
  const read=await readNode2Admission(path);assert.deepEqual(read,admission);
  const run=runtime(t,read,layoutChain()),{binding,pending}=await run.bind();
  assert.equal(pending,null);assert.deepEqual(run.stub.heights(),[0,1,2]);assert.deepEqual(run.journal.puts,[]);
  assert.deepEqual({...binding,connectionId:'*',observedAt:'*',expiresAt:'*'},{bindingVersion:'dacs-demos-network-binding/v1',bindingId:binding.bindingId,network:NETWORK,chainIdentity:CHAIN,pinVersion:PIN,endpoint:ENDPOINT,
    transportAuthority:TRANSPORT,connectionId:'*',source:{kind:PREDECESSOR_SOURCE,blockNumber:1,blockHash:BLOCK_ONE,fallbackDocumentation:admission.fallbackDocumentation},observedAt:'*',expiresAt:'*'});
  assert.match(binding.connectionId,/^node2-[0-9a-f]{32}$/);assert.equal(binding.expiresAt,binding.observedAt+60000);
  assert.equal(binding.bindingId,sha(JSON.stringify(['dacs-demos-network-binding/v1',NETWORK,CHAIN,PIN,ENDPOINT,TRANSPORT])));
});

test('otherwise-valid changed continuation is held at the native reader before normalization; continuity alone is not enough',async t=>{
  const admission=await layoutAdmission(),changed=offsetTwo({hash:OTHER});
  assert.equal(WRONG.continuityOnly(offsetOne(),changed),true,'a continuity-only reader would admit this block two');
  const run=runtime(t,admission,{...layoutChain(),2:changed});
  await assert.rejects(run.bind(),{code:'unavailable',message:'The identity read is unavailable'});
  assert.deepEqual(run.stub.heights(),[0,1,2]);assert.deepEqual(run.journal.puts,[]);
  // Same transport, reviewed block two restored: binds (the hold was the only difference).
  run.stub.set({2:offsetTwo()});assert.equal((await run.bind()).binding.source.blockHash,BLOCK_ONE);
});

test('reviewed blockTwoHash is snapshotted at construction; later mutation of the caller object has no effect',async t=>{
  const admission={...await layoutAdmission()};
  const run=runtime(t,admission,layoutChain());admission.blockTwoHash=OTHER;admission.chainIdentity=OTHER;
  assert.equal((await run.bind()).binding.chainIdentity,CHAIN);
});

test('admission readback: altered blockTwoHash is refused; a fully re-derived forgery is integrity-valid but runtime compares it exactly',async t=>{
  const admission=await layoutAdmission(),dir=await temp(t);let n=0;
  const write=async(value)=>{const path=join(dir,`a-${n++}.json`);await writeFile(path,JSON.stringify(value),{mode:0o600});return path;};
  for(const changed of [{...admission,blockTwoHash:OTHER},rehash({...admission,blockTwoHash:OTHER}),rehash({...admission,blockTwoHash:BLOCK_ONE,fallbackDocumentation:documentation(admission.observationHash,BLOCK_ONE)})])
    await assert.rejects(readNode2Admission(await write(changed)),{message:ADMISSION_REFUSED});
  const forged=await readNode2Admission(await write(rehash({...admission,blockTwoHash:OTHER,fallbackDocumentation:documentation(admission.observationHash,OTHER)})));
  assert.equal(forged.blockTwoHash,OTHER);
  const actual=runtime(t,forged,layoutChain());await assert.rejects(actual.bind(),{code:'unavailable'});assert.deepEqual(actual.stub.heights(),[0,1,2]);
  const matching=runtime(t,forged,{...layoutChain(),2:offsetTwo({hash:OTHER})});assert.equal((await matching.bind()).binding.chainIdentity,CHAIN);
  // A non-recomputed object is refused before any read.
  const stub=node2Stub(layoutChain());
  assert.throws(()=>createAdmittedNode2DemoTransport({admission:{...admission,blockTwoHash:OTHER},transportOwner:createNode2TransportOwner({admission,fetchImpl:stub.fetchImpl}),journal:memoryJournal(),fetchImpl:stub.fetchImpl}),{message:ADMISSION_REFUSED});
  assert.deepEqual(stub.calls,[]);
});

test('runtime constructor pairing is exact (createDevnetDemoTransport, before any read)',()=>{
  const fallback={blockZeroUnavailable:'literal-error',documentation:'TEST node-layout coverage fallback'},stub=node2Stub(layoutChain());
  const base={expected:{network:NETWORK,chainIdentity:CHAIN,pinVersion:PIN,endpoint:ENDPOINT,transportAuthority:TRANSPORT},transportOwner:mutableOwner(),journal:memoryJournal(),fetchImpl:stub.fetchImpl};
  for(const [options,message] of [
    [{fallback,blockZeroErrorEnvelope:ENVELOPE_TOKEN,blockOneLayout:'node2-offset/v1',reviewedBlockTwoHash:BLOCK_TWO},'the native block-one layout policy is unsupported'],
    [{fallback,blockOneLayout:LAYOUT_TOKEN,reviewedBlockTwoHash:BLOCK_TWO},'the native block-one layout requires the exact observed block-zero fallback'],
    [{blockZeroErrorEnvelope:ENVELOPE_TOKEN,blockOneLayout:LAYOUT_TOKEN,reviewedBlockTwoHash:BLOCK_TWO},'the native block-zero error envelope requires an explicit binder fallback'],
    [{fallback,blockZeroErrorEnvelope:ENVELOPE_TOKEN,blockOneLayout:LAYOUT_TOKEN},'the native block-one layout requires the exact reviewed block-two hash'],
    [{fallback,blockZeroErrorEnvelope:ENVELOPE_TOKEN,reviewedBlockTwoHash:BLOCK_TWO},'the reviewed block-two hash requires the exact native block-one layout'],
    [{fallback,blockZeroErrorEnvelope:ENVELOPE_TOKEN,blockOneLayout:LAYOUT_TOKEN,reviewedBlockTwoHash:`0x${BLOCK_TWO}`},'the reviewed native block-two hash must be canonical'],
    [{fallback,blockZeroErrorEnvelope:ENVELOPE_TOKEN,blockOneLayout:LAYOUT_TOKEN,reviewedBlockTwoHash:BLOCK_TWO.toUpperCase()},'the reviewed native block-two hash must be canonical'],
  ])assert.throws(()=>createDevnetDemoTransport({...base,...options}),{name:'TypeError',message});
  assert.deepEqual(stub.calls,[]);
});

// Runtime boundary table (layout admission). Reader refusals surface through
// the unchanged binder as code 'unavailable'; no write is ever attempted.
const ONE=[
  ['aligned id 1 (legacy shape under layout)',offsetOne({id:1})],['id offset +2',offsetOne({id:3}),WRONG.anyPositiveOffset],['number 2',offsetOne({number:2})],
  ['pending status',offsetOne({status:'pending'})],['0x-prefixed hash',offsetOne({hash:`0x${BLOCK_ONE}`})],['uppercase predecessor',offsetOne({content:{previousHash:CHAIN.toUpperCase()}})],
  ['self predecessor',offsetOne({content:{previousHash:BLOCK_ONE}})],['conflicting previousHash alias',offsetOne({previousHash:OTHER})],
  ['conflicting chainIdentity alias',offsetOne({chainIdentity:OTHER})],['conflicting genesisHash alias',offsetOne({genesisHash:OTHER})],
  ['null extra',offsetOne({},{extra:null})],['missing extra',{result:200,response:offsetOne().response,require_reply:false}],['two-field envelope',{result:200,response:offsetOne().response}],
];
for(const [name,one,model] of ONE)test(`runtime block-one layout boundary held: ${name}`,async t=>{
  if(model)assert.equal(model(one,1),true);
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),1:one});
  await assert.rejects(run.bind(),{code:'unavailable'});assert.deepEqual(run.stub.heights(),[0,1]);assert.deepEqual(run.journal.puts,[]);
});
const TWO=[
  ['id 2',offsetTwo({id:2})],['id offset +2',offsetTwo({id:4}),WRONG.anyPositiveOffset],['number 3',offsetTwo({number:3})],['pending status',offsetTwo({status:'pending'})],
  ['discontinuous predecessor',offsetTwo({content:{previousHash:CHAIN}})],['block-one hash reused',offsetTwo({hash:BLOCK_ONE})],
  ['conflicting previousHash alias',offsetTwo({previousHash:OTHER})],['conflicting chainIdentity alias',offsetTwo({chainIdentity:OTHER})],
  ['conflicting genesisHash alias',offsetTwo({genesisHash:OTHER})],['null extra',offsetTwo({},{extra:null})],['changed reviewed hash',offsetTwo({hash:OTHER})],
];
for(const [name,two,model] of TWO)test(`runtime block-two continuation boundary held: ${name}`,async t=>{
  if(model)assert.equal(model(two,2),true);
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),2:two});
  await assert.rejects(run.bind(),{code:'unavailable'});assert.deepEqual(run.stub.heights(),[0,1,2]);assert.deepEqual(run.journal.puts,[]);
});

test('runtime accepting alias controls: equal aliases on both blocks bind',async t=>{
  const run=runtime(t,await layoutAdmission(),{...layoutChain(),1:offsetOne({previousHash:CHAIN,chainIdentity:CHAIN,genesisHash:CHAIN}),2:offsetTwo({previousHash:BLOCK_ONE,chainIdentity:CHAIN,genesisHash:CHAIN})});
  assert.equal((await run.bind()).binding.source.blockHash,BLOCK_ONE);assert.deepEqual(run.stub.heights(),[0,1,2]);
});

test('0x-prefixed block-one hash: observation normalizes it but the runtime reader holds (fail-closed asymmetry)',async t=>{
  const answers={...layoutChain(),1:offsetOne({hash:`0x${BLOCK_ONE}`}),2:offsetTwo()};
  const o=await observe(answers,OPT_IN);assert.equal(o.blockOneHash,BLOCK_ONE);
  const admission=admitObservedNode2Identity({observation:o,...review({reviewedBlockZeroEnvelope:ENVELOPE_TOKEN,reviewedBlockOneLayout:LAYOUT_TOKEN,reviewedBlockTwoHash:BLOCK_TWO})});
  const run=runtime(t,admission,answers);await assert.rejects(run.bind(),{code:'unavailable'});assert.deepEqual(run.stub.heights(),[0,1]);
});

test('id is not dropped globally: no-layout runtime and block zero keep the binder height rule',async t=>{
  // Envelope-only admission (no layout): the offset block one reaches the binder unchanged.
  const plain=runtime(t,await envelopeAdmission(),{0:node2Zero(),1:offsetOne()});
  await assert.rejects(plain.bind(),{code:'wrong_block'});assert.deepEqual(plain.stub.heights(),[0,1]);
  // Layout admission: a block zero carrying a database id is never normalized.
  const zeroWithId={result:200,response:{number:0,id:1,status:'confirmed',hash:CHAIN}};
  const layout=runtime(t,await layoutAdmission(),{...layoutChain(),0:zeroWithId});
  await assert.rejects(layout.bind(),{code:'wrong_block'});assert.deepEqual(layout.stub.heights(),[0]);
  // Witness: the unchanged binder WOULD bind both if id were dropped everywhere,
  // so the transport-level holds above discriminate a global id-drop.
  for(const [zero,one] of [[node2Zero(),WRONG.dropIdEverywhere(offsetOne())],[WRONG.dropIdEverywhere(zeroWithId),null]]){
    const context={network:NETWORK,endpoint:ENDPOINT,transportAuthority:TRANSPORT,connectionId:'binder-witness'};
    const binder=createDemosNetworkBinder({expected:{network:NETWORK,chainIdentity:CHAIN,pinVersion:PIN,endpoint:ENDPOINT,transportAuthority:TRANSPORT},now:()=>NOW,
      fallback:{blockZeroUnavailable:'literal-error',documentation:'TEST witness'},reader:{getContext:()=>context,
        getBlockByNumber:async(height)=>({value:height===0?(zero.result===400?'error':zero):one,context,observedAt:NOW,fromCache:false,redirected:false})}});
    assert.equal((await binder.bind()).chainIdentity,CHAIN);
  }
});
