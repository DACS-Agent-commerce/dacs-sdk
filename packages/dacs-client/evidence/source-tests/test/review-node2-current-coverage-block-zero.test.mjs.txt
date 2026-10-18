// Item 1: numeric block-zero literal-error opt-in for the actual Node2
// four-field envelope. Offline .invalid stubs only; no public RPC, TLS, wallet,
// signature, CREATE, payment or broadcast is reachable from these entrypoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admitObservedNode2Identity, observeNode2Identity } from '../src/devnet-demo/operator-network.mjs';
import { DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE } from '../src/wallet/devnet-native-transport.mjs';
import { BLOCK_ONE, CHAIN, ENDPOINT, ENVELOPE_TOKEN, NETWORK, PREDECESSOR_SOURCE, WRONG, admittedTransport, alignedOne, blockZeroAdmission, clock, envelopeAdmission, json,
  legacyAdmission, legacyZero, node2Stub, node2Zero, observe, review, sha, zeroBlock } from './helpers/review-node2-current-coverage-fixture.mjs';

const ZERO_HELD='Node2 block zero is not a confirmed canonical identity observation';
const OPT_IN={blockZeroUnavailable:'literal-error'};
const actual=node2Zero();

test('data pin: the exported envelope token is the documented Node2 four-field token',()=>{
  assert.equal(DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE,ENVELOPE_TOKEN);
  assert.deepEqual(Object.keys(actual),['result','response','require_reply','extra']);
});

test('default (no opt-in) observation holds every literal-error shape after exactly one block-zero read',async()=>{
  for(const answer of [actual,legacyZero(),{result:200,response:'error'}]){
    const stub=node2Stub({0:answer,1:alignedOne()});
    await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,fetchImpl:stub.fetchImpl}),{message:ZERO_HELD});
    assert.deepEqual(stub.heights(),[0]);
  }
});

test('opt-in observation records the exact four-field result as its own named envelope under one hash',async()=>{
  const stub=node2Stub({0:actual,1:alignedOne()});
  const o=await observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,fetchImpl:stub.fetchImpl,now:clock(10_000),...OPT_IN});
  assert.deepEqual(stub.heights(),[0,1]);
  const {observationHash,...scope}=o;
  assert.deepEqual(scope,{format:'dacs-node2-single-node-predecessor-observation/v1',network:NETWORK,endpoint:ENDPOINT,chainIdentity:CHAIN,identitySource:PREDECESSOR_SOURCE,
    blockZeroResult:400,blockZeroEnvelope:ENVELOPE_TOKEN,blockOneHash:BLOCK_ONE,blockZeroObservedAt:10_000,observedAt:10_001,scope:o.scope});
  assert.match(o.scope,/^run-scoped single-node TEST observation/);
  assert.equal(observationHash,sha(JSON.stringify(scope)));
  assert.equal(Object.isFrozen(o),true);
  // The legacy two-field result never carries the four-field token.
  const legacy=await observe({0:legacyZero(),1:alignedOne()},OPT_IN);
  assert.equal(Object.hasOwn(legacy,'blockZeroEnvelope'),false);assert.equal(legacy.blockZeroResult,400);
});

test('admission requires explicit exact review of the recorded envelope token',async()=>{
  const o=await observe({0:actual,1:alignedOne()},OPT_IN);
  for(const reviewedBlockZeroEnvelope of [undefined,'node2-result-400-error/v1',ENVELOPE_TOKEN.toUpperCase(),`${ENVELOPE_TOKEN} `])
    assert.throws(()=>admitObservedNode2Identity({observation:o,...review({reviewedBlockZeroEnvelope})}),{message:'the operator-reviewed block-zero envelope differs from the observation'});
  const admission=admitObservedNode2Identity({observation:o,...review({reviewedBlockZeroEnvelope:ENVELOPE_TOKEN})});
  assert.equal(admission.blockZeroEnvelope,ENVELOPE_TOKEN);assert.equal(admission.identitySource,PREDECESSOR_SOURCE);
  assert.ok(admission.fallbackDocumentation.includes(o.observationHash));assert.ok(admission.fallbackDocumentation.includes(ENVELOPE_TOKEN));
  // A legacy observation refuses the four-field review token.
  const legacy=await observe({0:legacyZero(),1:alignedOne()},OPT_IN);
  assert.throws(()=>admitObservedNode2Identity({observation:legacy,...review({reviewedBlockZeroEnvelope:ENVELOPE_TOKEN})}),{message:'the operator-reviewed block-zero envelope differs from the observation'});
});

test('runtime admission/envelope matrix: four-field and legacy policies stay exact and non-interchangeable',async t=>{
  const admissions={envelope:await envelopeAdmission(),legacy:await legacyAdmission(),zero:await blockZeroAdmission()};
  for(const [kind,zero,expected] of [
    ['envelope',actual,{heights:[0,1],source:'confirmed-block-one-predecessor'}],
    ['envelope',legacyZero(),{heights:[0],code:'unavailable'}],
    ['legacy',legacyZero(),{heights:[0,1],source:'confirmed-block-one-predecessor'}],
    ['legacy',actual,{heights:[0],code:'unavailable'}],
    ['zero',actual,{heights:[0],code:'unavailable'}],
    ['zero',zeroBlock(),{heights:[0],source:'block-zero-hash'}],
  ]){
    const run=admittedTransport(admissions[kind],{0:zero,1:alignedOne()});t.after(()=>run.capability.close());
    if(expected.code)await assert.rejects(run.bind(),{code:expected.code},`${kind}`);
    else{
      const {binding,pending}=await run.bind();assert.equal(pending,null);
      assert.equal(binding.chainIdentity,CHAIN);assert.equal(binding.source.kind,expected.source);
      if(expected.source==='confirmed-block-one-predecessor')assert.deepEqual(binding.source,{kind:expected.source,blockNumber:1,blockHash:BLOCK_ONE,fallbackDocumentation:admissions[kind].fallbackDocumentation});
    }
    assert.deepEqual(run.stub.heights(),expected.heights,`${kind}`);assert.deepEqual(run.journal.puts,[]);
  }
});

// Near-miss shapes: each is admitted by a plausible wrong predicate (model) yet
// held by the real observation AND the real admitted runtime after one read.
const NEAR=[
  ['lowercase extra',{...actual,extra:'block number not provided'},WRONG.extraCaseInsensitive],
  ['trailing-space extra',{...actual,extra:'Block number not provided '},WRONG.extraPrefix],
  ['prefix-only extra',{...actual,extra:'Block number'},WRONG.extraPrefix],
  ['empty extra',{...actual,extra:''},WRONG.anyErrorResponse],
  ['require_reply true',{...actual,require_reply:true},WRONG.anyErrorResponse],
  ['require_reply string',{...actual,require_reply:'false'},WRONG.replyAsString],
  ['require_reply missing',{result:400,response:'error',extra:'Block number not provided'},WRONG.looseTypes],
  ['string result',{...actual,result:'400'},WRONG.looseTypes],
  ['capitalised response',{...actual,response:'Error'},WRONG.responseCaseInsensitive],
  ['additional field',{...actual,id:0},WRONG.ignoreExtraKeys],
  ['server-error result',{...actual,result:500},WRONG.anyErrorResponse],
];
for(const [name,answer,model] of NEAR)test(`near-miss block zero held at observation and runtime: ${name}`,async t=>{
  assert.equal(model(answer),true,'the vector discriminates the modelled wrong implementation');
  const stub=node2Stub({0:answer,1:alignedOne()});
  await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,fetchImpl:stub.fetchImpl,...OPT_IN}),{message:ZERO_HELD});
  assert.deepEqual(stub.heights(),[0]);
  const run=admittedTransport(await envelopeAdmission(),{0:answer,1:alignedOne()});t.after(()=>run.capability.close());
  await assert.rejects(run.bind(),{code:'unavailable'});
  assert.deepEqual(run.stub.heights(),[0]);assert.deepEqual(run.journal.puts,[]);
});

test('legacy null-extra result-400 is observed as legacy material but never bound by the four-field runtime',async t=>{
  const nullExtra={result:400,response:'error',require_reply:false,extra:null};
  const o=await observe({0:nullExtra,1:alignedOne()},OPT_IN);
  assert.equal(Object.hasOwn(o,'blockZeroEnvelope'),false);
  for(const admission of [await envelopeAdmission(),await legacyAdmission()]){
    const run=admittedTransport(admission,{0:nullExtra,1:alignedOne()});t.after(()=>run.capability.close());
    await assert.rejects(run.bind(),{code:'unavailable'});assert.deepEqual(run.stub.heights(),[0]);
  }
});

test('pre-existing binder-native result-200 literal marker is unchanged by the four-field rule (documented asymmetry)',async t=>{
  // Observation holds this shape; the protected binder's own SDK rule treats
  // {result:200,response:'error'} as its literal marker irrespective of extras.
  const answer={result:200,response:'error',require_reply:false,extra:'Block number not provided'};
  const stub=node2Stub({0:answer,1:alignedOne()});
  await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,fetchImpl:stub.fetchImpl,...OPT_IN}),{message:ZERO_HELD});
  const run=admittedTransport(await envelopeAdmission(),{0:answer,1:alignedOne()});t.after(()=>run.capability.close());
  assert.equal((await run.bind()).binding.source.blockNumber,1);assert.deepEqual(run.stub.heights(),[0,1]);
  const unpinned=admittedTransport(await blockZeroAdmission(),{0:answer,1:alignedOne()});t.after(()=>unpinned.capability.close());
  await assert.rejects(unpinned.bind(),{code:'unavailable',message:'Block zero is unavailable and no reviewed block-one fallback is configured'});
  assert.deepEqual(unpinned.stub.heights(),[0]);
});

test('block-zero transport failures never activate the fallback at observation or runtime',async t=>{
  const failing=node2Stub({0:()=>json(actual,503),1:alignedOne()});
  await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,fetchImpl:failing.fetchImpl,...OPT_IN}),{message:'Node2 identity observation failed with HTTP 503'});
  assert.deepEqual(failing.heights(),[0]);
  const hung=node2Stub({0:()=>new Promise(()=>{}),1:alignedOne()});
  await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,fetchImpl:hung.fetchImpl,timeoutMs:25,...OPT_IN}),{message:'Node2 identity observation timed out'});
  assert.deepEqual(hung.heights(),[0]);
  for(const zero of [()=>json(actual,503),()=>Promise.reject(Object.assign(new Error('TEST timeout'),{name:'TimeoutError'})),()=>new Response('error',{status:200,headers:{'content-type':'text/plain'}})]){
    const run=admittedTransport(await envelopeAdmission(),{0:zero,1:alignedOne()});t.after(()=>run.capability.close());
    await assert.rejects(run.bind(),{code:'unavailable'});assert.deepEqual(run.stub.heights(),[0]);
  }
});
