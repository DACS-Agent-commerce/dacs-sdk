// Offline-only Node2 coverage fixture. Every endpoint is a .invalid name served
// by an injected fetch stub: no public RPC, TLS, wallet, signer, CREATE, payment
// or broadcast is reachable. Hashes and policy tokens are written here from the
// documented contract (docs/DEVNET-NODE2-*.md), never read back from production.
import { createHash } from 'node:crypto';
import { admitObservedNode2Identity, createAdmittedNode2DemoTransport, createNode2TransportOwner, observeNode2Identity } from '../../src/devnet-demo/operator-network.mjs';

export const sha=(value)=>createHash('sha256').update(value).digest('hex');
export const label=(text)=>sha(`scenario-node2-current-coverage:${text}`);
export const ENDPOINT='https://node2-current-coverage.invalid/';
export const NETWORK='demos-devnet';
export const AUTHORITY='TEST-RUN-scenario-node2-cov-001';
export const TRANSPORT='TEST-owned-scenario-node2-cov';
export const PIN='TEST-scenario-node2-cov-pin-v1';
export const CHAIN=label('chain-identity');
export const BLOCK_ONE=label('block-one');
export const BLOCK_TWO=label('block-two');
export const OTHER=label('other');
export const RETAINED_HASH=label('retained-transfer-hash');
export const WALLET=`0x${'e'.repeat(64)}`;
export const WRITER=`did:demos:agent:${'e'.repeat(64)}`;
export const NOW=1_900_000_000_000;
// Documented tokens, written literally so a renamed export is detected.
export const ENVELOPE_TOKEN='node2-result-400-error-require-reply-false-block-number-not-provided/v1';
export const LAYOUT_TOKEN='node2-number-id-plus-one-empty-extra/v1';
export const PREDECESSOR_SOURCE='confirmed-block-one-predecessor';

export const node2Zero=()=>({result:400,response:'error',require_reply:false,extra:'Block number not provided'});
export const legacyZero=()=>({result:400,response:'error'});
export const zeroBlock=(block={})=>({result:200,response:{number:0,status:'confirmed',hash:CHAIN,...block}});
export const alignedOne=(block={},envelope={})=>({result:200,response:{number:1,id:1,status:'confirmed',hash:BLOCK_ONE,content:{previousHash:CHAIN},...block},...envelope});
export const offsetOne=(block={},envelope={})=>({result:200,response:{number:1,id:2,status:'confirmed',hash:BLOCK_ONE,content:{previousHash:CHAIN},...block},require_reply:false,extra:'',...envelope});
export const offsetTwo=(block={},envelope={})=>({result:200,response:{number:2,id:3,status:'confirmed',hash:BLOCK_TWO,content:{previousHash:BLOCK_ONE},...block},require_reply:false,extra:'',...envelope});
export const layoutChain=()=>({0:node2Zero(),1:offsetOne(),2:offsetTwo()});
export const envelopeChain=()=>({0:node2Zero(),1:alignedOne()});
export const clock=(start)=>{let n=start;return()=>n++;};
export const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

// Routes getBlockByNumber by height, other nodeCalls by message and GETs by
// path. Any unlisted request or origin is refused and still recorded.
export function node2Stub(initial,{onRequest}={}){
  let answers={...initial};const calls=[];
  const fetchImpl=async(input,init={})=>{
    const url=new URL(String(input)),body=init.body===undefined?undefined:JSON.parse(init.body),call=body?.params?.[0];
    const entry={origin:url.origin,path:url.pathname,method:init.method??'GET',redirect:init.redirect,message:call?.message??call?.extra??null,blockNumber:call?.data?.blockNumber};
    calls.push(entry);
    if(url.origin!==new URL(ENDPOINT).origin)throw new Error('TEST Node2 stub refused a non-fixture origin');
    await onRequest?.(entry);
    const key=call?.message==='getBlockByNumber'?call.data.blockNumber:call?.message??`GET ${url.pathname}`;
    if(!Object.hasOwn(answers,key))throw new Error(`TEST Node2 stub refused an unexpected request: ${String(key)}`);
    const answer=answers[key];
    return typeof answer==='function'?answer(entry,call?.data):json(answer);
  };
  return {fetchImpl,calls,set:(next)=>{answers={...answers,...next};},
    heights:(from=0)=>calls.slice(from).filter((c)=>c.message==='getBlockByNumber').map((c)=>c.blockNumber),
    messages:(from=0)=>calls.slice(from).map((c)=>c.message)};
}

// Durable-journal stand-in with a real per-key lock. `puts` records every
// write; seed() places a fixture row without counting as a transport write.
export function memoryJournal({serialize=true}={}){
  const records=new Map(),puts=[],locks=new Map();
  return {puts,seed:(key,value)=>records.set(key,structuredClone(value)),
    get:async(key)=>records.has(key)?structuredClone(records.get(key)):undefined,
    put:async(key,value)=>{puts.push(key);records.set(key,structuredClone(value));},
    entries:async()=>[...records.entries()].map(([key,value])=>[key,structuredClone(value)]),
    async withWalletLock(key,work){
      if(!serialize)return work();
      const prior=locks.get(key)??Promise.resolve();let release;const gate=new Promise((resolve)=>{release=resolve;}),mine=prior.then(()=>gate);locks.set(key,mine);
      await prior;try{return await work();}finally{release();if(locks.get(key)===mine)locks.delete(key);}
    }};
}

// Test transport owner whose actual context can change; counts fence use.
export function mutableOwner(){
  const state={network:NETWORK,endpoint:ENDPOINT,transportAuthority:TRANSPORT,connectionId:'scenario-cov-connection-1'};let held=false,acquired=0,released=0;
  const getContext=()=>Object.freeze({network:state.network,endpoint:state.endpoint,transportAuthority:state.transportAuthority,connectionId:state.connectionId});
  return {state,counts:()=>({acquired,released,held}),getContext,
    async acquireConnectionFence(){if(held)throw new Error('TEST owner connection already fenced');held=true;acquired++;let live=true;return {context:getContext(),release(){if(live){live=false;held=false;released++;}}};}};
}

export const review=(extra={})=>({authority:AUTHORITY,transportAuthority:TRANSPORT,pinVersion:PIN,reviewedChainIdentity:CHAIN,reviewedIdentitySource:PREDECESSOR_SOURCE,reviewedBlockOneHash:BLOCK_ONE,reviewedAt:20_000,...extra});
export const observe=(answers,extra={})=>observeNode2Identity({endpoint:ENDPOINT,network:NETWORK,fetchImpl:node2Stub(answers).fetchImpl,now:clock(10_000),...extra});
export async function layoutAdmission(){
  const observation=await observe(layoutChain(),{blockZeroUnavailable:'literal-error',blockOneLayout:LAYOUT_TOKEN});
  return admitObservedNode2Identity({observation,...review({reviewedBlockZeroEnvelope:ENVELOPE_TOKEN,reviewedBlockOneLayout:LAYOUT_TOKEN,reviewedBlockTwoHash:BLOCK_TWO})});
}
export async function envelopeAdmission(){
  const observation=await observe(envelopeChain(),{blockZeroUnavailable:'literal-error'});
  return admitObservedNode2Identity({observation,...review({reviewedBlockZeroEnvelope:ENVELOPE_TOKEN})});
}
export async function legacyAdmission(){
  const observation=await observe({0:legacyZero(),1:alignedOne()},{blockZeroUnavailable:'literal-error'});
  return admitObservedNode2Identity({observation,...review()});
}
export async function blockZeroAdmission(){
  const observation=await observe({0:zeroBlock()});
  return admitObservedNode2Identity({observation,authority:AUTHORITY,transportAuthority:TRANSPORT,pinVersion:PIN,reviewedChainIdentity:CHAIN,reviewedAt:20_000});
}

// The operator composition (operator.mjs:123-124) over an injected stub.
export function admittedTransport(admission,answers,{owner=null,journal=memoryJournal(),onRequest,now=()=>NOW}={}){
  const stub=node2Stub(answers,{onRequest});
  const transportOwner=owner??createNode2TransportOwner({admission,fetchImpl:stub.fetchImpl});
  const capability=createAdmittedNode2DemoTransport({admission,transportOwner,journal,fetchImpl:owner?stub.fetchImpl:transportOwner.fetchImpl,now});
  return {stub,owner:transportOwner,journal,capability,bind:()=>capability.binding({phase:'bind',address:WALLET})};
}

// Plausible WRONG implementations, as models only (production is never
// mutated). A test shows each model admits its vector while the real
// entrypoint holds it, so the vector discriminates that wrong implementation.
export const WRONG=Object.freeze({
  extraPrefix:(a)=>a?.result===400&&a?.response==='error'&&a?.require_reply===false&&typeof a?.extra==='string'&&a.extra.startsWith('Block number'),
  extraCaseInsensitive:(a)=>a?.result===400&&a?.response==='error'&&a?.require_reply===false&&String(a?.extra).trim().toLowerCase()==='block number not provided',
  ignoreExtraKeys:(a)=>a?.result===400&&a?.response==='error'&&a?.require_reply===false&&a?.extra==='Block number not provided',
  looseTypes:(a)=>a?.result==400&&a?.response==='error'&&!a?.require_reply&&a?.extra==='Block number not provided',
  replyAsString:(a)=>a?.result===400&&a?.response==='error'&&String(a?.require_reply)==='false'&&a?.extra==='Block number not provided',
  responseCaseInsensitive:(a)=>[200,400].includes(a?.result)&&String(a?.response).toLowerCase()==='error',
  anyErrorResponse:(a)=>a?.response==='error',
  continuityOnly:(one,two)=>two?.response?.status==='confirmed'&&two?.response?.content?.previousHash===one?.response?.hash,
  anyPositiveOffset:(answer,number)=>answer?.response?.number===number&&answer?.response?.id>number,
  dropIdEverywhere:(answer)=>{const {id:_id,...rest}=answer.response;return {...answer,response:rest};},
});
