// Offline deterministic stubs only: no public Node2, wallet, faucet, signature
// or broadcast. Expected hashes are recomputed here, not read from the module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitObservedNode2Identity, createAdmittedNode2DemoTransport, createNode2TransportOwner, NODE2_PREDECESSOR_SOURCE,
  observeNode2Identity, readNode2Admission } from '../src/devnet-demo/operator-network.mjs';
import { DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE } from '../src/wallet/devnet-native-transport.mjs';
import { BLOCK_ONE, ENDPOINT, PREDECESSOR, ZERO, blockOne, blockZero, json, label, literalError, node2Stub } from './helpers/devnet-operator-node2-fallback-stub.mjs';

const sha=(value)=>createHash('sha256').update(value).digest('hex');
const AUTHORITY='TEST-RUN-node2-fallback-001',TRANSPORT='TEST-owned-node2-fallback',PIN='TEST-node2-fallback-pin-v1',NETWORK='demos-devnet';
const WALLET=`0x${'c'.repeat(64)}`;
const ZERO_HELD='Node2 block zero is not a confirmed canonical identity observation';
const actualError=()=>literalError(400,{require_reply:false,extra:'Block number not provided'});
const V1_ADMISSION_KEYS=['format','authority','network','endpoint','chainIdentity','transportAuthority','pinVersion','observationHash','observedAt','reviewedAt','trust','admissionHash'];
const temp=async(t,prefix)=>{const path=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(path,{recursive:true,force:true}));return path;};
const observeFallback=(stub,options={})=>observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,blockZeroUnavailable:'literal-error',fetchImpl:stub.fetchImpl,...options});
const rehash=(record,hashKey)=>{const {[hashKey]:_drop,...scope}=record;return{...scope,[hashKey]:sha(JSON.stringify(scope))};};

async function predecessorObservation(answer=literalError(400)){
  let time=5000;return observeFallback(node2Stub({0:answer,1:blockOne()}),{now:()=>time++});
}
const review=(observation,extra={})=>({observation,authority:AUTHORITY,transportAuthority:TRANSPORT,pinVersion:PIN,reviewedChainIdentity:PREDECESSOR,
  reviewedIdentitySource:NODE2_PREDECESSOR_SOURCE,reviewedBlockOneHash:BLOCK_ONE,reviewedAt:6000,...extra});
async function predecessorAdmission(){return admitObservedNode2Identity(review(await predecessorObservation()));}
async function blockZeroAdmission(){
  const observation=await observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,now:()=>5000,fetchImpl:node2Stub({0:blockZero()}).fetchImpl});
  return admitObservedNode2Identity({observation,authority:AUTHORITY,transportAuthority:TRANSPORT,pinVersion:PIN,reviewedChainIdentity:ZERO,reviewedAt:6000});
}

// Drives the PROTECTED binder through the PROTECTED demo transport via the
// owned createAdmittedNode2DemoTransport, exactly as operator.mjs composes it.
function admittedTransport(admission,answers,{onRequest,now,owner}={}){
  const stub=node2Stub(answers,{onRequest});
  const transportOwner=owner??createNode2TransportOwner({admission,fetchImpl:stub.fetchImpl});
  const journal={get:async()=>undefined,put:async()=>{throw new Error('TEST journal refuses writes during binding');},entries:async()=>[],withWalletLock:async(_key,work)=>work()};
  const capability=createAdmittedNode2DemoTransport({admission,transportOwner,journal,fetchImpl:owner?stub.fetchImpl:transportOwner.fetchImpl,now});
  return {stub,bind:()=>capability.binding({phase:'bind',address:WALLET})};
}

test('default observation is unchanged: valid block zero stays v1 and literal error is held without a block-one read',async()=>{
  const ok=node2Stub({0:blockZero(),1:blockOne()});
  const observation=await observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,now:()=>1000,fetchImpl:ok.fetchImpl});
  const scope={format:'dacs-node2-single-node-observation/v1',network:NETWORK,endpoint:ENDPOINT,chainIdentity:ZERO,observedAt:1000};
  assert.deepEqual(observation,{...scope,observationHash:sha(JSON.stringify(scope))});
  assert.deepEqual(ok.calls,[{url:ENDPOINT,method:'POST',redirect:'error',cache:'no-store',message:'getBlockByNumber',blockNumber:0}]);
  for(const answer of [literalError(400),literalError(200),literalError(400,{require_reply:false,extra:null})]){
    const held=node2Stub({0:answer,1:blockOne()});
    await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,fetchImpl:held.fetchImpl}),{message:ZERO_HELD});
    assert.deepEqual(held.heights(),[0]);
  }
  const optedIn=node2Stub({0:blockZero(),1:blockOne()});
  assert.deepEqual(await observeFallback(optedIn,{now:()=>1000}),observation);
  assert.deepEqual(optedIn.heights(),[0]);
  await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,blockZeroUnavailable:'any-error',fetchImpl:ok.fetchImpl}),{name:'TypeError',message:'the only Node2 block-zero fallback is the explicit literal-error policy'});
  assert.equal(ok.calls.length,1);
});

test('opt-in literal-error envelope records the confirmed block-one predecessor as run-scoped TEST material',async()=>{
  for(const answer of [literalError(400),literalError(400,{require_reply:false,extra:null}),literalError(200),literalError(200,{require_reply:false,extra:null})]){
    let time=5000;const stub=node2Stub({0:answer,1:blockOne()});
    const observation=await observeFallback(stub,{now:()=>time++});
    assert.deepEqual(stub.calls,[0,1].map((blockNumber)=>({url:ENDPOINT,method:'POST',redirect:'error',cache:'no-store',message:'getBlockByNumber',blockNumber})));
    assert.match(observation.scope,/^run-scoped single-node TEST observation/);assert.match(observation.scope,/not a production trust pin or quorum finality$/);
    const scope={format:'dacs-node2-single-node-predecessor-observation/v1',network:NETWORK,endpoint:ENDPOINT,chainIdentity:PREDECESSOR,identitySource:'confirmed-block-one-predecessor',
      blockZeroResult:answer.result,blockOneHash:BLOCK_ONE,blockZeroObservedAt:5000,observedAt:5001,scope:observation.scope};
    assert.deepEqual(observation,{...scope,observationHash:sha(JSON.stringify(scope))});
    assert.equal(Object.isFrozen(observation),true);
  }
  const aliased=await observeFallback(node2Stub({0:literalError(),1:blockOne({id:1,hash:`0x${BLOCK_ONE}`,previousHash:PREDECESSOR,chainIdentity:`0x${PREDECESSOR}`,genesisHash:PREDECESSOR,content:{previousHash:`0x${PREDECESSOR}`}})}),{now:()=>5000});
  assert.equal(aliased.chainIdentity,PREDECESSOR);assert.equal(aliased.blockOneHash,BLOCK_ONE);
  const sameMs=await observeFallback(node2Stub({0:literalError(),1:blockOne()}),{now:()=>7000});
  assert.equal(sameMs.observedAt-sameMs.blockZeroObservedAt,0);
  let span=[1000,61000];const edge=await observeFallback(node2Stub({0:literalError(),1:blockOne()}),{now:()=>span.shift()});
  assert.equal(edge.observedAt-edge.blockZeroObservedAt,60000);
});

test('actual four-field envelope is recorded, explicitly reviewed, read back and consumed without changing the binder policy',async t=>{
  const observation=await predecessorObservation(actualError());
  assert.equal(observation.blockZeroEnvelope,DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE);
  assert.equal(observation.blockZeroResult,400);
  assert.throws(()=>admitObservedNode2Identity(review(observation)),{message:'the operator-reviewed block-zero envelope differs from the observation'});
  assert.throws(()=>admitObservedNode2Identity(review(observation,{reviewedBlockZeroEnvelope:'other'})),{message:'the operator-reviewed block-zero envelope differs from the observation'});
  const admission=admitObservedNode2Identity(review(observation,{reviewedBlockZeroEnvelope:DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE}));
  assert.equal(admission.blockZeroEnvelope,DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE);
  assert.match(admission.fallbackDocumentation,/node2-result-400-error-require-reply-false-block-number-not-provided\/v1/);
  const dir=await temp(t,'node2-observed-envelope-admission-'),path=join(dir,'admission.json');
  await writeFile(path,JSON.stringify(admission));assert.deepEqual(await readNode2Admission(path),admission);
  const altered=rehash({...admission,blockZeroEnvelope:'other'},'admissionHash');await writeFile(path,JSON.stringify(altered));
  await assert.rejects(readNode2Admission(path),{message:'Node2 admission is not the exact reviewed TEST record'});
  const {stub,bind}=admittedTransport(admission,{0:actualError(),1:blockOne()});
  const {binding,pending}=await bind();
  assert.equal(pending,null);assert.equal(binding.chainIdentity,PREDECESSOR);assert.deepEqual(stub.heights(),[0,1]);
});

for(const [name,answer] of [
  ['non-literal error text',{result:400,response:'Error'}],
  ['padded error text',{result:400,response:'error '}],
  ['server-error result',{result:500,response:'error'}],
  ['not-found result',{result:404,response:'error'}],
  ['string result',{result:'400',response:'error'}],
  ['envelope without result',{response:'error'}],
  ['bare literal body','error'],
  ['null body',null],
  ['null response',{result:400,response:null}],
  ['partial RPC envelope',{result:400,response:'error',extra:null}],
  ['require_reply true',{result:400,response:'error',require_reply:true,extra:null}],
  ['non-null extra',{result:400,response:'error',require_reply:false,extra:'x'}],
  ['unconfirmed block zero',{result:200,response:{number:0,status:'pending',hash:ZERO}}],
]) test(`opt-in block zero stays held without a block-one read: ${name}`,async()=>{
  const stub=node2Stub({0:answer,1:blockOne()});
  await assert.rejects(observeFallback(stub),{message:ZERO_HELD});
  assert.deepEqual(stub.heights(),[0]);
});

test('opt-in block-zero transport failure and timeout stay held without a block-one read',async()=>{
  const failed=node2Stub({0:()=>json(literalError(),503),1:blockOne()});
  await assert.rejects(observeFallback(failed),{message:'Node2 identity observation failed with HTTP 503'});
  assert.deepEqual(failed.heights(),[0]);
  const hung=node2Stub({0:()=>new Promise(()=>{}),1:blockOne()});
  await assert.rejects(observeFallback(hung,{timeoutMs:25}),{message:'Node2 identity observation timed out'});
  assert.deepEqual(hung.heights(),[0]);
  for(const timeoutMs of [0,60001,1.5])await assert.rejects(observeFallback(node2Stub({}),{timeoutMs}),{name:'TypeError'});
});

const other=label('offline-node2-fallback-other-chain');
for(const [name,answer] of [
  ['non-200 block-one result',{result:400,response:blockOne().response}],
  ['block one literal error',{result:200,response:'error'}],
  ['block one unavailable',literalError(400)],
  ['null block',{result:200,response:null}],
  ['block without SDK envelope',blockOne().response],
  ['partial RPC envelope',blockOne({},{extra:null})],
  ['string height',blockOne({number:'1'})],
  ['wrong height',blockOne({number:2})],
  ['id-only height',{result:200,response:{id:1,status:'confirmed',hash:BLOCK_ONE,content:{previousHash:PREDECESSOR}}}],
  ['conflicting id',blockOne({id:2})],
  ['unconfirmed',blockOne({status:'pending'})],
  ['uppercase hash',blockOne({hash:BLOCK_ONE.toUpperCase()})],
  ['short hash',blockOne({hash:BLOCK_ONE.slice(1)})],
  ['missing content',blockOne({content:undefined})],
  ['array content',blockOne({content:[PREDECESSOR]})],
  ['missing predecessor',blockOne({content:{}})],
  ['uppercase predecessor',blockOne({content:{previousHash:PREDECESSOR.toUpperCase()}})],
  ['literal error predecessor',blockOne({content:{previousHash:'error'}})],
  ['self-referential predecessor',blockOne({hash:PREDECESSOR})],
  ['conflicting previousHash alias',blockOne({previousHash:other})],
  ['conflicting chainIdentity alias',blockOne({chainIdentity:other})],
  ['conflicting genesisHash alias',blockOne({genesisHash:other})],
]) test(`opt-in block one is refused: ${name}`,async()=>{
  const stub=node2Stub({0:literalError(),1:answer});
  await assert.rejects(observeFallback(stub),{message:/^Node2 block one is not a confirmed predecessor observation: /});
  assert.deepEqual(stub.heights(),[0,1]);
});

test('opt-in block-one HTTP failure, timeout, stale span and backwards clock stay held',async()=>{
  await assert.rejects(observeFallback(node2Stub({0:literalError(),1:()=>json(blockOne(),503)})),{message:'Node2 identity observation failed with HTTP 503'});
  await assert.rejects(observeFallback(node2Stub({0:literalError(),1:()=>new Promise(()=>{})}),{timeoutMs:25}),{message:'Node2 identity observation timed out'});
  for(const times of [[1000,61001],[1000,999],[1000,Number.NaN]]){
    await assert.rejects(observeFallback(node2Stub({0:literalError(),1:blockOne()}),{now:()=>times.shift()}),{message:'Node2 block-one predecessor observation is stale or out of order'});
  }
});

test('predecessor admission requires exact operator review, is TEST-pinned and retains its identity source',async()=>{
  const observation=await predecessorObservation(),admission=admitObservedNode2Identity(review(observation));
  const documentation=admission.fallbackDocumentation;
  assert.ok(documentation.includes(observation.observationHash));assert.ok(documentation.length<=512);assert.match(documentation,/^Run-scoped single-node TEST/);
  assert.match(admission.trust,/run-scoped single-node TEST/);assert.match(admission.trust,/not a production trust pin/);
  const scope={format:'dacs-node2-single-node-predecessor-test-admission/v1',authority:AUTHORITY,network:NETWORK,endpoint:ENDPOINT,chainIdentity:PREDECESSOR,
    identitySource:'confirmed-block-one-predecessor',blockOneHash:BLOCK_ONE,fallbackDocumentation:documentation,transportAuthority:TRANSPORT,pinVersion:PIN,
    observationHash:observation.observationHash,observedAt:5001,reviewedAt:6000,trust:admission.trust};
  assert.deepEqual(admission,{...scope,admissionHash:sha(JSON.stringify(scope))});
  const sourceReview='the block-one predecessor fallback requires explicit operator review of its identity source';
  const differs='the operator-reviewed predecessor or block-one hash differs from the observation';
  for(const [extra,message] of [
    [{reviewedIdentitySource:undefined},sourceReview],[{reviewedIdentitySource:'block-zero-hash'},sourceReview],
    [{reviewedBlockOneHash:undefined},differs],[{reviewedBlockOneHash:PREDECESSOR},differs],[{reviewedChainIdentity:BLOCK_ONE},differs],[{reviewedChainIdentity:ZERO},differs],
    [{pinVersion:'node2-pin-v1'},'run authority, transport authority, or TEST pin version is malformed'],[{authority:'TEST-owner'},'run authority, transport authority, or TEST pin version is malformed'],
    [{reviewedAt:5000},'review time must follow the observation'],
  ])assert.throws(()=>admitObservedNode2Identity(review(observation,extra)),{message});
  for(const change of [{chainIdentity:other},{blockOneHash:other},{blockZeroResult:200},{observedAt:5002},{network:'demos-other'}])
    assert.throws(()=>admitObservedNode2Identity(review({...observation,...change})),{message:'the single-node predecessor observation was altered after it was observed'});
  for(const change of [{blockZeroResult:500},{identitySource:'block-zero-hash'},{scope:'production pin'},{observedAt:5000+60001},{extra:true},{chainIdentity:BLOCK_ONE}])
    assert.throws(()=>admitObservedNode2Identity(review({...observation,...change})),{name:'TypeError',message:'the exact single-node predecessor observation is required'});
});

test('block-zero admission is unchanged and refuses predecessor review material',async()=>{
  const observation=await observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,now:()=>5000,fetchImpl:node2Stub({0:blockZero()}).fetchImpl});
  const base={observation,authority:AUTHORITY,transportAuthority:TRANSPORT,pinVersion:'node2-pin-v1',reviewedChainIdentity:ZERO,reviewedAt:6000};
  const admission=admitObservedNode2Identity(base);
  assert.deepEqual(Object.keys(admission),V1_ADMISSION_KEYS);
  const scope={format:'dacs-node2-single-node-test-admission/v1',authority:AUTHORITY,network:NETWORK,endpoint:ENDPOINT,chainIdentity:ZERO,transportAuthority:TRANSPORT,pinVersion:'node2-pin-v1',
    observationHash:observation.observationHash,observedAt:5000,reviewedAt:6000,trust:'operator-reviewed single-node TEST observation; not an independent genesis pin or consensus-finality proof'};
  assert.deepEqual(admission,{...scope,admissionHash:sha(JSON.stringify(scope))});
  assert.deepEqual(admitObservedNode2Identity({...base,reviewedIdentitySource:'block-zero-hash'}),admission);
  for(const extra of [{reviewedIdentitySource:NODE2_PREDECESSOR_SOURCE},{reviewedBlockOneHash:BLOCK_ONE}])
    assert.throws(()=>admitObservedNode2Identity({...base,...extra}),{message:'the operator-reviewed identity source differs from the block-zero observation'});
});

test('reading a predecessor admission is exact; tampering is refused even when the hash is recomputed',async t=>{
  const admission=await predecessorAdmission(),dir=await temp(t,'node2-fallback-admission-');
  const write=async(name,value)=>{const path=join(dir,name);await writeFile(path,JSON.stringify(value),{mode:0o600});return path;};
  assert.deepEqual(await readNode2Admission(await write('ok.json',admission)),admission);
  const v1=await blockZeroAdmission();assert.deepEqual(await readNode2Admission(await write('v1.json',v1)),v1);
  let index=0;
  for(const [change,recompute] of [
    [{chainIdentity:other},false],[{blockOneHash:other},false],[{identitySource:'block-zero-hash'},false],[{fallbackDocumentation:'other reference'},false],
    [{fallbackDocumentation:'other reference'},true],[{identitySource:'block-zero-hash'},true],[{trust:'production pin'},true],[{pinVersion:'node2-pin-v1'},true],
    [{reviewedAt:5000},true],[{chainIdentity:BLOCK_ONE},true],[{endpoint:'https://node2.test.invalid/rpc'},true],[{format:'dacs-node2-single-node-test-admission/v1'},true],[{extra:true},true],
  ]){
    const changed=recompute?rehash({...admission,...change},'admissionHash'):{...admission,...change};
    await assert.rejects(readNode2Admission(await write(`tampered-${index++}.json`,changed)),{message:'Node2 admission is not the exact reviewed TEST record'});
  }
});

test('transport accepting control: an exact predecessor admission lets the protected binder verify block one',async()=>{
  const admission=await predecessorAdmission();
  for(const answer of [literalError(200,{require_reply:false,extra:null}),literalError(200)]){
    const {stub,bind}=admittedTransport(admission,{0:answer,1:blockOne({},{require_reply:false,extra:null})});
    const {binding,pending}=await bind();
    assert.equal(pending,null);
    assert.equal(binding.chainIdentity,PREDECESSOR);assert.equal(binding.pinVersion,PIN);assert.equal(binding.endpoint,ENDPOINT);assert.equal(binding.transportAuthority,TRANSPORT);
    assert.deepEqual(binding.source,{kind:'confirmed-block-one-predecessor',blockNumber:1,blockHash:BLOCK_ONE,fallbackDocumentation:admission.fallbackDocumentation});
    assert.deepEqual(stub.heights(),[0,1]);
    assert.ok(stub.calls.every((call)=>call.url===ENDPOINT&&call.redirect==='error'&&call.cache==='no-store'));
  }
});

test('transport accepting control: block-zero admission binds block zero and never receives a fallback policy',async()=>{
  const admission=await blockZeroAdmission();
  const ok=admittedTransport(admission,{0:blockZero(),1:blockOne()});
  assert.deepEqual((await ok.bind()).binding.source,{kind:'block-zero-hash',blockNumber:0,blockHash:ZERO,fallbackDocumentation:null});
  assert.deepEqual(ok.stub.heights(),[0]);
  for(const forged of [admission,{...admission,fallbackDocumentation:'forged',identitySource:NODE2_PREDECESSOR_SOURCE}]){
    const held=admittedTransport({...forged,chainIdentity:PREDECESSOR},{0:literalError(200),1:blockOne()});
    await assert.rejects(held.bind(),{code:'unavailable',message:'Block zero is unavailable and no reviewed block-one fallback is configured'});
    assert.deepEqual(held.stub.heights(),[0]);
  }
});

test('transport representation policies stay exact across legacy, null-extra and actual shapes',async()=>{
  const admission=await predecessorAdmission();
  const legacy=admittedTransport(admission,{0:literalError(400),1:blockOne()});assert.equal((await legacy.bind()).binding.chainIdentity,PREDECESSOR);assert.deepEqual(legacy.stub.heights(),[0,1]);
  for(const answer of [literalError(400,{require_reply:false,extra:null}),actualError()]){const {stub,bind}=admittedTransport(admission,{0:answer,1:blockOne()});await assert.rejects(bind(),{code:'unavailable'});assert.deepEqual(stub.heights(),[0]);}
  const actualObservation=await predecessorObservation(actualError());
  const actualAdmission=admitObservedNode2Identity(review(actualObservation,{reviewedBlockZeroEnvelope:DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE}));
  for(const answer of [literalError(400),literalError(400,{require_reply:false,extra:null})]){const {stub,bind}=admittedTransport(actualAdmission,{0:answer,1:blockOne()});await assert.rejects(bind(),{code:'unavailable'});assert.deepEqual(stub.heights(),[0]);}
});

test('transport refuses a tampered predecessor admission before any read',async()=>{
  const admission=await predecessorAdmission();
  for(const forged of [{...admission,chainIdentity:other},rehash({...admission,pinVersion:'node2-pin-v1'},'admissionHash'),{...admission,fallbackDocumentation:'other reference'}]){
    const stub=node2Stub({0:literalError(200),1:blockOne()});
    assert.throws(()=>createAdmittedNode2DemoTransport({admission:forged,transportOwner:createNode2TransportOwner({admission:forged,fetchImpl:stub.fetchImpl}),
      journal:{get:async()=>undefined,put:async()=>{},entries:async()=>[],withWalletLock:async(_key,work)=>work()},fetchImpl:stub.fetchImpl}),{message:'Node2 admission is not the exact reviewed TEST record'});
    assert.deepEqual(stub.calls,[]);
  }
});

test('transport negative boundaries: wrong pin, non-literal error, null block, timeout, changed connection and stale reads stay held',async()=>{
  const admission=await predecessorAdmission();
  for(const [answers,code] of [
    [{0:literalError(200),1:blockOne({content:{previousHash:other}})},'identity_mismatch'],
    [{0:{result:200,response:'Error'},1:blockOne()},'malformed_observation'],
    [{0:literalError(200),1:{result:200,response:null}},'malformed_observation'],
    [{0:literalError(200),1:literalError(400)},'unavailable'],
    [{0:literalError(200),1:blockOne({status:'pending'})},'wrong_block'],
    [{0:literalError(200),1:()=>Promise.reject(Object.assign(new Error('TEST timeout'),{name:'TimeoutError'}))},'unavailable'],
  ]){
    const {bind}=admittedTransport(admission,answers);
    await assert.rejects(bind(),{code});
  }
  const state={connectionId:'node2-connection-1'};
  const contextOf=()=>Object.freeze({network:admission.network,endpoint:admission.endpoint,transportAuthority:admission.transportAuthority,connectionId:state.connectionId});
  const owner={getContext:contextOf,async acquireConnectionFence(){return{context:contextOf(),release(){}};}};
  const changed=admittedTransport(admission,{0:literalError(200),1:blockOne()},{owner,onRequest:(height)=>{if(height===1)state.connectionId='node2-connection-2';}});
  await assert.rejects(changed.bind(),{code:'connection_changed'});
  let time=1_800_000_000_000;
  const stale=admittedTransport(admission,{0:literalError(200),1:blockOne()},{now:()=>time,onRequest:(height)=>{if(height===1)time+=60_001;}});
  await assert.rejects(stale.bind(),{code:'stale_observation'});
  assert.deepEqual(stale.stub.heights(),[0,1]);
});

const SCRIPT=fileURLToPath(new URL('../scripts/devnet-demo-operator-bootstrap.mjs',import.meta.url));
const PRELOAD=new URL('./helpers/devnet-operator-node2-fallback-preload.mjs',import.meta.url).href;
function cli(dir,name,args,blocks){
  const log=join(dir,`${name}.log`);
  const result=spawnSync(process.execPath,['--import',PRELOAD,SCRIPT,...args],{encoding:'utf8',timeout:30000,
    env:{PATH:process.env.PATH??'',DACS_TEST_NODE2_FALLBACK_ENDPOINT:ENDPOINT,DACS_TEST_NODE2_FALLBACK_BLOCKS:JSON.stringify(blocks),DACS_TEST_NODE2_FALLBACK_LOG:log}});
  return {...result,heights:existsSync(log)?readFile(log,'utf8').then((text)=>text.trim().split('\n').filter(Boolean).map(Number)):Promise.resolve([])};
}

test('bootstrap CLI: literal-error fallback is opt-in, exact and requires explicit predecessor review',async t=>{
  const dir=await temp(t,'node2-fallback-cli-'),blocks={0:literalError(400),1:blockOne()};
  const observationPath=join(dir,'observation.json'),admissionPath=join(dir,'admission.json');
  const held=cli(dir,'held',['observe',`--endpoint=${ENDPOINT}`,`--network=${NETWORK}`,`--out=${observationPath}`],blocks);
  assert.notEqual(held.status,0);assert.match(held.stderr,new RegExp(ZERO_HELD));assert.equal(existsSync(observationPath),false);assert.deepEqual(await held.heights,[0]);
  for(const [name,flag] of [['wrong-policy','--block-zero-unavailable=any-error'],['bare-flag','--block-zero-unavailable']]){
    const refused=cli(dir,name,['observe',`--endpoint=${ENDPOINT}`,`--network=${NETWORK}`,flag,`--out=${observationPath}`],blocks);
    assert.notEqual(refused.status,0);assert.equal(existsSync(observationPath),false);assert.deepEqual(await refused.heights,[]);
  }
  const observed=cli(dir,'observed',['observe',`--endpoint=${ENDPOINT}`,`--network=${NETWORK}`,'--block-zero-unavailable=literal-error',`--out=${observationPath}`],blocks);
  assert.equal(observed.status,0,observed.stderr);assert.deepEqual(await observed.heights,[0,1]);
  const printed=JSON.parse(observed.stdout);
  assert.deepEqual([printed.status,printed.chainIdentity,printed.identitySource,printed.blockOneHash],['observed',PREDECESSOR,NODE2_PREDECESSOR_SOURCE,BLOCK_ONE]);
  assert.equal((await stat(observationPath)).mode&0o077,0);
  const common=[`--observation=${observationPath}`,`--authority=${AUTHORITY}`,`--transport-authority=${TRANSPORT}`,`--pin-version=${PIN}`,`--reviewed-chain-identity=${PREDECESSOR}`];
  for(const [name,extra] of [['no-source',[`--reviewed-block-one-hash=${BLOCK_ONE}`]],['no-block-one',[`--reviewed-identity-source=${NODE2_PREDECESSOR_SOURCE}`]],
    ['bare-source',['--reviewed-identity-source',`--reviewed-block-one-hash=${BLOCK_ONE}`]]]){
    const refused=cli(dir,name,['admit',...common,...extra,`--out=${admissionPath}`],{});
    assert.notEqual(refused.status,0);assert.equal(existsSync(admissionPath),false);
  }
  const admitted=cli(dir,'admitted',['admit',...common,`--reviewed-identity-source=${NODE2_PREDECESSOR_SOURCE}`,`--reviewed-block-one-hash=${BLOCK_ONE}`,`--out=${admissionPath}`],{});
  assert.equal(admitted.status,0,admitted.stderr);assert.equal(JSON.parse(admitted.stdout).identitySource,NODE2_PREDECESSOR_SOURCE);
  assert.equal((await stat(admissionPath)).mode&0o077,0);
  const read=await readNode2Admission(admissionPath);
  assert.deepEqual([read.format,read.identitySource,read.chainIdentity,read.blockOneHash],['dacs-node2-single-node-predecessor-test-admission/v1',NODE2_PREDECESSOR_SOURCE,PREDECESSOR,BLOCK_ONE]);
});

test('bootstrap CLI records the actual envelope and requires its explicit review',async t=>{
  const dir=await temp(t,'node2-actual-envelope-cli-'),observationPath=join(dir,'observation.json'),admissionPath=join(dir,'admission.json');
  const observed=cli(dir,'observed-actual',['observe',`--endpoint=${ENDPOINT}`,`--network=${NETWORK}`,'--block-zero-unavailable=literal-error',`--out=${observationPath}`],{0:actualError(),1:blockOne()});
  assert.equal(observed.status,0,observed.stderr);assert.deepEqual(await observed.heights,[0,1]);
  const observation=JSON.parse(await readFile(observationPath,'utf8'));assert.equal(observation.blockZeroEnvelope,DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE);
  const common=[`--observation=${observationPath}`,`--authority=${AUTHORITY}`,`--transport-authority=${TRANSPORT}`,`--pin-version=${PIN}`,`--reviewed-chain-identity=${PREDECESSOR}`,
    `--reviewed-identity-source=${NODE2_PREDECESSOR_SOURCE}`,`--reviewed-block-one-hash=${BLOCK_ONE}`,`--out=${admissionPath}`];
  const missing=cli(dir,'admit-missing-envelope',['admit',...common],{});assert.notEqual(missing.status,0);assert.equal(existsSync(admissionPath),false);
  const admitted=cli(dir,'admit-actual',['admit',...common,`--reviewed-block-zero-envelope=${DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE}`],{});
  assert.equal(admitted.status,0,admitted.stderr);assert.equal((await readNode2Admission(admissionPath)).blockZeroEnvelope,DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE);
});

test('bootstrap CLI: block-zero observe and admit keep the unchanged v1 records',async t=>{
  const dir=await temp(t,'node2-zero-cli-'),observationPath=join(dir,'observation.json'),admissionPath=join(dir,'admission.json');
  const observed=cli(dir,'observed',['observe',`--endpoint=${ENDPOINT}`,`--network=${NETWORK}`,`--out=${observationPath}`],{0:blockZero(),1:blockOne()});
  assert.equal(observed.status,0,observed.stderr);assert.deepEqual(await observed.heights,[0]);
  assert.deepEqual(Object.keys(JSON.parse(observed.stdout)),['status','path','chainIdentity','trust']);
  const admitted=cli(dir,'admitted',['admit',`--observation=${observationPath}`,`--authority=${AUTHORITY}`,`--transport-authority=${TRANSPORT}`,'--pin-version=node2-pin-v1',`--reviewed-chain-identity=${ZERO}`,`--out=${admissionPath}`],{});
  assert.equal(admitted.status,0,admitted.stderr);assert.deepEqual(Object.keys(JSON.parse(admitted.stdout)),['status','path','chainIdentity','trust']);
  assert.deepEqual(Object.keys(await readNode2Admission(admissionPath)),V1_ADMISSION_KEYS);
});
