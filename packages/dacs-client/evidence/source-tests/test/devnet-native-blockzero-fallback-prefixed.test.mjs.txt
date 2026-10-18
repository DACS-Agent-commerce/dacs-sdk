import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDevnetNativeTransport, DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE } from '../src/wallet/devnet-native-transport.mjs';

const hash=(value)=>createHash('sha256').update(value).digest('hex');
const A=hash('offline-node2-network-a'),B=hash('offline-node2-network-b'),FIRST=hash('offline-node2-network-a-block-one');
const ADDRESS=`0x${'11'.repeat(32)}`;
const FALLBACK=Object.freeze({blockZeroUnavailable:'literal-error',documentation:'reviewed Node2 contract: block zero is literal error and confirmed block one commits its predecessor'});
const first=(changes={})=>({number:1,status:'confirmed',hash:FIRST,content:{previousHash:A},...changes});
const expected=Object.freeze({network:'offline-node2-a',chainIdentity:A,pinVersion:'offline-node2-pin-v1',endpoint:'https://node2.invalid/',transportAuthority:'TEST-offline-node2-rpc'});

function memoryJournal(){const records=new Map();return{get:async k=>structuredClone(records.get(k)??null),put:async(k,v)=>records.set(k,structuredClone(v)),entries:async()=>[...records.entries()].map(([k,v])=>[k,structuredClone(v)]),withWalletLock:async(_key,work)=>work()};}
const observed=()=>({result:400,response:'error',require_reply:false,extra:'Block number not provided'});
function fixture(t,{fallback=null,blockZeroErrorEnvelope=null,zero={result:400,response:'error'},one={result:200,response:first()},timeoutMs=100}={}){
  const requests=[];let connectionId='offline-connection-1';
  const transportOwner={getContext:()=>({network:expected.network,endpoint:expected.endpoint,transportAuthority:expected.transportAuthority,connectionId}),async acquireConnectionFence(){let live=true;return{context:await this.getContext(),release(){live=false;},get live(){return live;}}}};
  const fetchImpl=async(_url,options={})=>{const body=JSON.parse(options.body),height=body.params[0].data.blockNumber;requests.push(height);const answer=height===0?zero:one;if(answer==='timeout')return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('TEST timeout'),{name:'AbortError'})),{once:true}));return new Response(JSON.stringify(answer),{status:200,headers:{'content-type':'application/json'}});};
  const capability=createDevnetNativeTransport({expected,transportOwner,journal:memoryJournal(),fallback,blockZeroErrorEnvelope,fetchImpl,now:()=>1_700_000_000_000,timeoutMs});
  t.after(()=>capability.close());
  return{requests,bind:()=>capability.binding({phase:'bind',address:ADDRESS}),setConnection:(value)=>{connectionId=value;}};
}
const rejects=(code)=>(error)=>error?.code===code;

test('opt-in exact Node2 block-zero 400/literal-error envelope uses the confirmed block-one predecessor',async t=>{
  const w=fixture(t,{fallback:FALLBACK});const answer=await w.bind();
  assert.deepEqual(w.requests,[0,1]);
  assert.equal(answer.binding.chainIdentity,A);
  assert.deepEqual(answer.binding.source,{kind:'confirmed-block-one-predecessor',blockNumber:1,blockHash:FIRST,fallbackDocumentation:FALLBACK.documentation});
  assert.equal(answer.pending,null);
});

test('the same exact Node2 block-zero envelope holds when no reviewed fallback is supplied',async t=>{
  const w=fixture(t);await assert.rejects(w.bind(),rejects('unavailable'));assert.deepEqual(w.requests,[0]);
});

test('opt-in recorded actual four-field Node2 envelope uses the confirmed block-one predecessor',async t=>{
  const w=fixture(t,{fallback:FALLBACK,blockZeroErrorEnvelope:DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE,zero:observed()});
  const answer=await w.bind();
  assert.deepEqual(w.requests,[0,1]);
  assert.equal(answer.binding.chainIdentity,A);
  assert.equal(answer.pending,null);
});

test('actual and legacy envelope policies are not interchangeable',async t=>{
  for(const options of [
    {fallback:FALLBACK,zero:observed()},
    {fallback:FALLBACK,blockZeroErrorEnvelope:DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE,zero:{result:400,response:'error'}},
    {fallback:FALLBACK,blockZeroErrorEnvelope:DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE,zero:{result:400,response:'error',require_reply:false,extra:null}},
  ]){
    const w=fixture(t,options);await assert.rejects(w.bind(),rejects('unavailable'));assert.deepEqual(w.requests,[0]);
  }
});

test('four-field policy refuses unsupported tokens and requires the binder fallback',async t=>{
  assert.throws(()=>fixture(t,{fallback:FALLBACK,blockZeroErrorEnvelope:'other'}),{name:'TypeError',message:'the native block-zero error envelope policy is unsupported'});
  assert.throws(()=>fixture(t,{blockZeroErrorEnvelope:DEVNET_NODE2_BLOCK_ZERO_ERROR_ENVELOPE}),{name:'TypeError',message:'the native block-zero error envelope requires an explicit binder fallback'});
});

for(const [label,zero,code] of [
  ['additional envelope field',{result:400,response:'error',extra:null},'unavailable'],
  ['actual envelope wrong extra',{result:400,response:'error',require_reply:false,extra:'Different'},'unavailable'],
  ['actual envelope wrong reply flag',{result:400,response:'error',require_reply:true,extra:'Block number not provided'},'unavailable'],
  ['different result',{result:401,response:'error'},'unavailable'],
  ['different response',{result:400,response:'ERROR'},'unavailable'],
  ['null response',{result:400,response:null},'unavailable'],
  ['object response',{result:400,response:{}},'unavailable'],
  ['null answer',null,'malformed_observation'],
])test(`non-exact block-zero ${label} never activates fallback`,async t=>{const w=fixture(t,{fallback:FALLBACK,zero});await assert.rejects(w.bind(),rejects(code));assert.deepEqual(w.requests,[0]);});

test('a timed-out block-zero read never activates fallback',async t=>{const w=fixture(t,{fallback:FALLBACK,zero:'timeout',timeoutMs:20});await assert.rejects(w.bind(),rejects('unavailable'));assert.deepEqual(w.requests,[0]);});

for(const [label,one,code] of [
  ['wrong height',{result:200,response:first({number:2})},'wrong_block'],
  ['unconfirmed status',{result:200,response:first({status:'pending'})},'wrong_block'],
  ['wrong predecessor',{result:200,response:first({content:{previousHash:B}})},'identity_mismatch'],
  ['conflicting predecessor alias',{result:200,response:first({previousHash:B})},'conflicting_identity'],
  ['block-one 400 literal error',{result:400,response:'error'},'unavailable'],
])test(`block-one ${label} remains held`,async t=>{const w=fixture(t,{fallback:FALLBACK,one});await assert.rejects(w.bind(),rejects(code));assert.deepEqual(w.requests,[0,1]);});
