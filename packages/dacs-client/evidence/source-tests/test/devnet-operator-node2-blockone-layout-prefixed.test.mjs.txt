// Offline-only layout controls. No public RPC, wallet, faucet, signature,
// broadcast or DEM effect is reachable through the .invalid endpoint/stub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitObservedNode2Identity, createAdmittedNode2DemoTransport, createNode2TransportOwner, NODE2_PREDECESSOR_SOURCE, observeNode2Identity, readNode2Admission } from '../src/devnet-demo/operator-network.mjs';
import { DEVNET_NODE2_BLOCK_LAYOUT, DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE } from '../src/wallet/devnet-native-transport.mjs';
import { actualZero, blockOne, blockTwo, BLOCK_ONE, BLOCK_TWO, CHAIN, ENDPOINT, label, node2LayoutStub } from './helpers/devnet-operator-node2-blockone-layout-stub.mjs';

const AUTHORITY='TEST-RUN-node2-layout-001',TRANSPORT='TEST-owned-node2-layout',PIN='TEST-node2-layout-pin-v1',NETWORK='demos-devnet',WALLET=`0x${'d'.repeat(64)}`;
const temp=async(t)=>{const dir=await mkdtemp(join(tmpdir(),'node2-layout-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;};
const observe=(stub,extra={})=>observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,blockZeroUnavailable:'literal-error',blockOneLayout:DEVNET_NODE2_BLOCK_LAYOUT,fetchImpl:stub.fetchImpl,now:(()=>{let n=5000;return()=>n++;})(),...extra});
const review=(observation,extra={})=>({observation,authority:AUTHORITY,transportAuthority:TRANSPORT,pinVersion:PIN,reviewedChainIdentity:CHAIN,reviewedIdentitySource:NODE2_PREDECESSOR_SOURCE,
  reviewedBlockOneHash:BLOCK_ONE,reviewedBlockZeroEnvelope:DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE,reviewedBlockOneLayout:DEVNET_NODE2_BLOCK_LAYOUT,reviewedBlockTwoHash:BLOCK_TWO,reviewedAt:6000,...extra});
async function admission(){const stub=node2LayoutStub({0:actualZero(),1:blockOne(),2:blockTwo()});return admitObservedNode2Identity(review(await observe(stub)));}
function transport(admission,answers,{onRequest,owner,now}={}){const stub=node2LayoutStub(answers,{onRequest}),transportOwner=owner??createNode2TransportOwner({admission,fetchImpl:stub.fetchImpl});
  const journal={get:async()=>undefined,put:async()=>{throw new Error('TEST binding journal refuses writes');},entries:async()=>[],withWalletLock:async(_key,work)=>work()};
  const capability=createAdmittedNode2DemoTransport({admission,transportOwner,journal,fetchImpl:owner?stub.fetchImpl:transportOwner.fetchImpl,now});return{stub,bind:()=>capability.binding({phase:'bind',address:WALLET})};}

test('actual offset layout is default-held and requires the exact explicit observation token',async()=>{
  const held=node2LayoutStub({0:actualZero(),1:blockOne(),2:blockTwo()});
  await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,blockZeroUnavailable:'literal-error',fetchImpl:held.fetchImpl}),/exact result-200 SDK envelope required/);assert.deepEqual(held.heights(),[0,1]);
  for(const blockOneLayout of ['any-offset',true]){const stub=node2LayoutStub({});await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,blockZeroUnavailable:'literal-error',blockOneLayout,fetchImpl:stub.fetchImpl}),{name:'TypeError'});assert.deepEqual(stub.heights(),[]);}
  await assert.rejects(observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,blockOneLayout:DEVNET_NODE2_BLOCK_LAYOUT,fetchImpl:held.fetchImpl}),/requires the explicit block-zero fallback/);
});

test('otherwise-valid actual block pair records the layout and continuation under one observation hash',async()=>{
  const stub=node2LayoutStub({0:actualZero(),1:blockOne(),2:blockTwo()}),observation=await observe(stub);
  assert.deepEqual(stub.heights(),[0,1,2]);assert.equal(observation.chainIdentity,CHAIN);assert.equal(observation.blockOneHash,BLOCK_ONE);assert.equal(observation.blockTwoHash,BLOCK_TWO);
  assert.equal(observation.blockZeroEnvelope,DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE);assert.equal(observation.blockOneLayout,DEVNET_NODE2_BLOCK_LAYOUT);
  const {observationHash,...scope}=observation;assert.equal(observationHash,createHash('sha256').update(JSON.stringify(scope)).digest('hex'));
});

test('layout admission requires exact explicit review, survives readback and rejects recomputed tampering',async t=>{
  const observation=await observe(node2LayoutStub({0:actualZero(),1:blockOne(),2:blockTwo()}));
  for(const extra of [{reviewedBlockOneLayout:undefined},{reviewedBlockOneLayout:'other'},{reviewedBlockTwoHash:undefined},{reviewedBlockTwoHash:CHAIN}])assert.throws(()=>admitObservedNode2Identity(review(observation,extra)),/layout or continuation differs/);
  const value=admitObservedNode2Identity(review(observation)),dir=await temp(t),path=join(dir,'admission.json');await writeFile(path,JSON.stringify(value));assert.deepEqual(await readNode2Admission(path),value);
  const changed={...value,blockTwoHash:label('other-block-two')};const {admissionHash:_drop,...scope}=changed;changed.admissionHash=createHash('sha256').update(JSON.stringify(scope)).digest('hex');await writeFile(path,JSON.stringify(changed));
  await assert.rejects(readNode2Admission(path),/exact reviewed TEST record/);
});

test('admitted runtime repeats block-two consistency then feeds the unchanged binder canonical block one',async()=>{
  const value=await admission(),run=transport(value,{0:actualZero(),1:blockOne(),2:blockTwo()}),result=await run.bind();
  assert.deepEqual(run.stub.heights(),[0,1,2]);assert.equal(result.binding.chainIdentity,CHAIN);assert.equal(result.pending,null);
  assert.deepEqual(result.binding.source,{kind:'confirmed-block-one-predecessor',blockNumber:1,blockHash:BLOCK_ONE,fallbackDocumentation:value.fallbackDocumentation});
});

test('runtime holds an otherwise-valid block two whose hash differs from exact admission review',async()=>{
  const value=await admission(),changedHash=label('runtime-changed-block-two-hash');
  const run=transport(value,{0:actualZero(),1:blockOne(),2:blockTwo({hash:changedHash})});
  await assert.rejects(run.bind(),{code:'unavailable'});
  assert.deepEqual(run.stub.heights(),[0,1,2]);
});

test('legacy aligned number/id layout remains on its unchanged two-read path',async()=>{
  const legacyOne={result:200,response:{number:1,id:1,status:'confirmed',hash:BLOCK_ONE,content:{previousHash:CHAIN}}};
  const observation=await observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,blockZeroUnavailable:'literal-error',fetchImpl:node2LayoutStub({0:{result:400,response:'error'},1:legacyOne}).fetchImpl,now:(()=>{let n=1;return()=>n++;})()});
  const value=admitObservedNode2Identity({observation,authority:AUTHORITY,transportAuthority:TRANSPORT,pinVersion:PIN,reviewedChainIdentity:CHAIN,reviewedIdentitySource:NODE2_PREDECESSOR_SOURCE,reviewedBlockOneHash:BLOCK_ONE,reviewedAt:3});
  const run=transport(value,{0:{result:400,response:'error'},1:legacyOne});assert.equal((await run.bind()).binding.chainIdentity,CHAIN);assert.deepEqual(run.stub.heights(),[0,1]);
});

for(const [name,one] of [
  ['wrong id',blockOne({id:1})],['wrong offset',blockOne({id:3})],['wrong number',blockOne({number:2})],['wrong status',blockOne({status:'pending'})],
  ['wrong hash',blockOne({hash:'x'.repeat(64)})],['null-extra envelope',blockOne({}, {extra:null})],['missing extra',{result:200,response:blockOne().response,require_reply:false}],
  ['conflicting predecessor alias',blockOne({previousHash:label('other-predecessor')})],['conflicting chain identity',blockOne({chainIdentity:label('other-chain')})],
])test(`operator refuses block-one layout boundary: ${name}`,async()=>{const stub=node2LayoutStub({0:actualZero(),1:one,2:blockTwo()});await assert.rejects(observe(stub));assert.deepEqual(stub.heights(),name==='conflicting chain identity'?[0,1,2]:[0,1]);});

for(const [name,two] of [
  ['wrong id',blockTwo({id:2})],['wrong number',blockTwo({number:3})],['wrong status',blockTwo({status:'pending'})],['wrong hash',blockTwo({hash:'x'.repeat(64)})],
  ['wrong predecessor',blockTwo({content:{previousHash:CHAIN}})],['conflicting predecessor alias',blockTwo({previousHash:CHAIN})],['conflicting chain identity',blockTwo({chainIdentity:label('other-chain')})],
  ['swapped block-one shape',blockOne()],['null-extra envelope',blockTwo({}, {extra:null})],
])test(`operator refuses block-two continuation boundary: ${name}`,async()=>{const stub=node2LayoutStub({0:actualZero(),1:blockOne(),2:two});await assert.rejects(observe(stub));assert.deepEqual(stub.heights(),[0,1,2]);});

test('runtime holds changed block-two layout and a connection change without binder relaxation',async()=>{
  const value=await admission(),bad=transport(value,{0:actualZero(),1:blockOne(),2:blockTwo({content:{previousHash:CHAIN}})});await assert.rejects(bad.bind(),{code:'unavailable'});assert.deepEqual(bad.stub.heights(),[0,1,2]);
  const state={connectionId:'layout-1'},context=()=>({network:NETWORK,endpoint:ENDPOINT,transportAuthority:TRANSPORT,connectionId:state.connectionId});
  const owner={getContext:context,async acquireConnectionFence(){return{context:context(),release(){}};}};
  const changed=transport(value,{0:actualZero(),1:blockOne(),2:blockTwo()},{owner,onRequest:(height)=>{if(height===2)state.connectionId='layout-2';}});await assert.rejects(changed.bind(),{code:'connection_changed'});assert.deepEqual(changed.stub.heights(),[0,1,2]);
});

const SCRIPT=fileURLToPath(new URL('../scripts/devnet-demo-operator-bootstrap.mjs',import.meta.url));
const PRELOAD=new URL('./helpers/devnet-operator-node2-fallback-preload.mjs',import.meta.url).href;
function cli(dir,name,args,blocks){const log=join(dir,`${name}.log`),result=spawnSync(process.execPath,['--import',PRELOAD,SCRIPT,...args],{encoding:'utf8',timeout:30000,
  env:{PATH:process.env.PATH??'',DACS_TEST_NODE2_FALLBACK_ENDPOINT:ENDPOINT,DACS_TEST_NODE2_FALLBACK_BLOCKS:JSON.stringify(blocks),DACS_TEST_NODE2_FALLBACK_LOG:log}});
  return{...result,heights:existsSync(log)?readFile(log,'utf8').then((text)=>text.trim().split('\n').filter(Boolean).map(Number)):Promise.resolve([])};}

test('unchanged CLI stays held while explicit layout observation and review produce an exact readback',async t=>{
  const dir=await temp(t),observationPath=join(dir,'observation.json'),admissionPath=join(dir,'admission.json'),blocks={0:actualZero(),1:blockOne(),2:blockTwo()};
  const base=['observe',`--endpoint=${ENDPOINT}`,`--network=${NETWORK}`,'--block-zero-unavailable=literal-error',`--out=${observationPath}`];
  const held=cli(dir,'held',base,blocks);assert.notEqual(held.status,0);assert.deepEqual(await held.heights,[0,1]);assert.equal(existsSync(observationPath),false);
  const observed=cli(dir,'observed',[...base,`--block-one-layout=${DEVNET_NODE2_BLOCK_LAYOUT}`],blocks);assert.equal(observed.status,0,observed.stderr);assert.deepEqual(await observed.heights,[0,1,2]);assert.equal((await stat(observationPath)).mode&0o077,0);
  const observation=JSON.parse(await readFile(observationPath,'utf8'));assert.equal(observation.blockOneLayout,DEVNET_NODE2_BLOCK_LAYOUT);assert.equal(observation.blockTwoHash,BLOCK_TWO);
  const common=['admit',`--observation=${observationPath}`,`--authority=${AUTHORITY}`,`--transport-authority=${TRANSPORT}`,`--pin-version=${PIN}`,`--reviewed-chain-identity=${CHAIN}`,
    `--reviewed-identity-source=${NODE2_PREDECESSOR_SOURCE}`,`--reviewed-block-one-hash=${BLOCK_ONE}`,`--reviewed-block-zero-envelope=${DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE}`,`--out=${admissionPath}`];
  const missing=cli(dir,'missing-review',common,{});assert.notEqual(missing.status,0);assert.equal(existsSync(admissionPath),false);
  const accepted=cli(dir,'accepted',[...common,`--reviewed-block-one-layout=${DEVNET_NODE2_BLOCK_LAYOUT}`,`--reviewed-block-two-hash=${BLOCK_TWO}`],{});assert.equal(accepted.status,0,accepted.stderr);assert.equal((await stat(admissionPath)).mode&0o077,0);
  const value=await readNode2Admission(admissionPath);assert.equal(value.blockOneLayout,DEVNET_NODE2_BLOCK_LAYOUT);assert.equal(value.blockTwoHash,BLOCK_TWO);
});
