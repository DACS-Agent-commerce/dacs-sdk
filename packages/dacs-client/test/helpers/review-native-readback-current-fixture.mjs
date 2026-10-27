// Offline-only fixture for the Node2 native transfer readback coverage pass.
// It builds an SDK-shaped post-fork native send signed by one in-process TEST
// key, the documented Node2 getTxByHash projection of it, the issued journal
// rows the transport retains at broadcast, and .invalid stub answers. Nothing
// here confirms, broadcasts, pays or reaches a socket. Expected outcomes and
// the contract oracle are written from docs/NODE2-NATIVE-TRANSFER-READBACK-
// COMPATIBILITY.md, never read back from production.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { CHAIN, NETWORK, label, sha } from './review-node2-current-coverage-fixture.mjs';

const SEED=Buffer.from(label('native-readback-current:test-key'),'hex');
const PRIVATE=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),SEED]),format:'der',type:'pkcs8'});
export const PAYER=`0x${createPublicKey(PRIVATE).export({format:'der',type:'spki'}).subarray(12).toString('hex')}`;
export const PAYEE=`0x${'7'.repeat(64)}`;
export const NODE_KEY=`0x${'5'.repeat(64)}`;
export const AMOUNT='2500000000';
export const GAS='1000000000';
export const FEES=Object.freeze({network_fee:'1000000000',rpc_fee:'2000000000',additional_fee:'0'});
export const NONCE=7;
export const TIMESTAMP=1_900_000_000_123;
export const BLOCK_NUMBER=10;
export const BLOCK_HASH=label('native-readback-current:block-10');
export const BLOCK_TIME=1_900_000_100;
export const FEE_KEYS=Object.freeze(['network_fee','rpc_fee','additional_fee']);
const clone=(value)=>structuredClone(value);

export const signHex=(message)=>sign(null,Buffer.from(message,'utf8'),PRIVATE).toString('hex');
const edit=(type,operation,account,amount)=>({type,operation,isRollback:false,account,txhash:'',amount});
// The four SDK edits in order (debit, credit, 1 DEM gas, nonce +1), as
// docs/EMBEDDED-WALLET-SDK.md and operator.mjs recoverIssuedPayment expect.
export const signedContent=()=>({type:'native',from:PAYER,to:PAYEE,amount:AMOUNT,
  data:['native',{nativeOperation:'send',args:[PAYEE,AMOUNT]}],
  gcr_edits:[edit('balance','remove',PAYER,AMOUNT),edit('balance','add',PAYEE,AMOUNT),edit('balance','remove',PAYER,GAS),edit('nonce','add',PAYER,1)],
  nonce:NONCE,timestamp:TIMESTAMP,transaction_fee:{...FEES,rpc_address:null},from_ed25519_address:PAYER});
export const signTransaction=(content)=>{const hash=sha(JSON.stringify(content));return {hash,content,signature:{type:'ed25519',data:signHex(hash)}};};

// Documented Node2 projection: root nonce/timestamp -> decimal string, root
// amount and the three fees -> equal safe numbers. Empty GCR txhash carriers
// become the transaction hash (existing documented node behaviour).
export function node2Projection(content,hash){
  const value=clone(content);
  value.nonce=String(value.nonce);value.timestamp=String(value.timestamp);value.amount=Number(value.amount);
  for(const key of FEE_KEYS)value.transaction_fee[key]=Number(value.transaction_fee[key]);
  for(const item of value.gcr_edits??[])if(item.txhash==='')item.txhash=hash;
  return value;
}
// Exact (unprojected) content apart from the filled txhash carriers.
export function exactProjection(content,hash){
  const value=clone(content);
  for(const item of value.gcr_edits??[])if(item.txhash==='')item.txhash=hash;
  return value;
}

export const laneKey=(address)=>`devnet/native-wallet/${JSON.stringify([NETWORK,CHAIN,address])}`;
export const intentKey=(hash)=>`devnet/native-transfer/${hash}`;
// Same field order the transport retains at broadcast (devnet-native-transport rpc()).
export const issuedRow=(signed,binding,stage='broadcast-accepted')=>({stage,hash:signed.hash,nonce:signed.content.nonce,signedTransaction:clone(signed),networkBinding:clone(binding)});
export const receiptFor=(signed)=>({hash:signed.hash,nonce:signed.content.nonce,blockNumber:BLOCK_NUMBER,blockHash:BLOCK_HASH,payer:PAYER,payee:PAYEE,amount:signed.content.amount,
  network:NETWORK,chainIdentity:CHAIN,attribution:'tuple-only',finality:'not-established',commitmentOnChain:false});

const json=(text)=>new Response(text,{status:200,headers:{'content-type':'application/json'}});
// Inclusion answers for one hash. `raw` rewrites the encoded getTxByHash body
// text so wire-level JSON number literals can be exercised.
export function inclusionAnswers(hash,content,{tx=()=>{},block=()=>{},status=null,raw=null}={}){
  const transaction={hash,status:'confirmed',blockNumber:BLOCK_NUMBER,content};tx(transaction);
  const inclusion={number:BLOCK_NUMBER,status:'confirmed',hash:BLOCK_HASH,content:{ordered_transactions:[hash],timestamp:BLOCK_TIME}};block(inclusion);
  const txAnswer={result:200,response:transaction};
  return {getTransactionStatus:{result:200,response:status??{state:'included',blockNumber:BLOCK_NUMBER}},
    getTxByHash:raw?()=>json(raw(JSON.stringify(txAnswer))):txAnswer,
    [BLOCK_NUMBER]:{result:200,response:inclusion}};
}
export const executeCalls=(stub)=>stub.calls.filter((call)=>['confirmTx','broadcastTx'].includes(call.message));
// RPC auth headers are single-use: each call gets the next millisecond from the
// transport clock (1900000000000, the admitted fixture NOW) unless one is given.
let sdkStamp=1_900_000_000_000;
export function sdkHeaders(address=PAYER,timestamp=String(sdkStamp++)){
  const identity=`ed25519:${address}`;
  return {identity,timestamp,signature:signHex(sha(`${identity}:${timestamp}`))};
}

// Independent contract oracle for executed content (doc table + "all other
// content remains structurally exact"). Object key order is not part of JSON
// value equality; txhash carriers are honoured only inside gcr_edits.
const DECIMAL=/^(?:0|[1-9][0-9]*)$/;
const safeUint=(value)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0);
export function contractAccepts(signed,actual,hash){
  const walk=(a,e,path)=>{
    const at=path.join('.');
    if((at==='nonce'||at==='timestamp')&&safeUint(e)&&typeof a==='string'&&DECIMAL.test(a)&&BigInt(a)===BigInt(e))return true;
    if((at==='amount'||FEE_KEYS.some((key)=>at===`transaction_fee.${key}`))&&typeof e==='string'&&DECIMAL.test(e)&&safeUint(a)&&BigInt(a)===BigInt(e))return true;
    if(path.length===3&&path[0]==='gcr_edits'&&path[2]==='txhash'&&e===''&&a===hash)return true;
    if(e===null||a===null||typeof e!=='object'||typeof a!=='object')return Object.is(a,e)||(a===e);
    if(Array.isArray(e)!==Array.isArray(a))return false;
    if(Array.isArray(e))return a.length===e.length&&e.every((item,index)=>walk(a[index],item,[...path,String(index)]));
    const ak=Object.keys(a),ek=Object.keys(e);
    return ak.length===ek.length&&ek.every((key)=>Object.hasOwn(a,key)&&walk(a[key],e[key],[...path,key]));
  };
  return walk(actual,signed,[]);
}

// Plausible WRONG matcher models (production is never mutated). Each accepts
// the documented projection, so each is a credible implementation; the tests
// show vectors each admits while the actual readback entry point holds them.
const plainEqual=(a,e,rule,path=[])=>{
  const hit=rule(a,e,path);if(hit!==undefined)return hit;
  if(a===e)return true;
  if(!a||!e||typeof a!=='object'||typeof e!=='object'||Array.isArray(a)!==Array.isArray(e))return false;
  const ak=Object.keys(a).sort(),ek=Object.keys(e).sort();
  return JSON.stringify(ak)===JSON.stringify(ek)&&ek.every((key)=>plainEqual(a[key],e[key],rule,[...path,key]));
};
const carrier=(a,e,path,hash)=>path.at(-1)==='txhash'&&e===''&&a===hash;
const numeric=(v)=>typeof v==='number'||(typeof v==='string'&&v.trim()!==''&&Number.isFinite(Number(v)));
export const WRONG_MATCHERS=Object.freeze({
  // Broad recursive numeric coercion: any number/numeric-string pair anywhere.
  broadRecursiveCoercion:(e,a,hash)=>plainEqual(a,e,(x,y,path)=>carrier(x,y,path,hash)||(numeric(x)&&numeric(y)&&Number(x)===Number(y))?true:undefined),
  // Exact with the documented root projections, but skips fee and GCR subtrees.
  ignoresFeeAndGcr:(e,a,hash)=>plainEqual(a,e,(x,y,path)=>{
    if(['transaction_fee','gcr_edits'].includes(path[0]))return true;
    if(path.length===1&&['nonce','timestamp'].includes(path[0])&&typeof x==='string'&&x===String(y))return true;
    if(path.length===1&&path[0]==='amount'&&typeof x==='number'&&String(x)===y)return true;
    return carrier(x,y,path,hash)?true:undefined;
  }),
  // Projection keyed by field name at any depth instead of exact root paths.
  pathInsensitiveKeys:(e,a,hash)=>plainEqual(a,e,(x,y,path)=>{
    const key=path.at(-1);
    if(['nonce','timestamp'].includes(key)&&typeof x==='string'&&x===String(y))return true;
    if(['amount',...FEE_KEYS].includes(key)&&typeof x==='number'&&Number.isSafeInteger(x)&&String(x)===y)return true;
    return carrier(x,y,path,hash)?true:undefined;
  }),
  // Number()-based nonce/timestamp coercion instead of the canonical decimal check.
  numberCoercedCounters:(e,a,hash)=>plainEqual(a,e,(x,y,path)=>{
    if(path.length===1&&['nonce','timestamp'].includes(path[0])&&typeof x==='string')return Number(x)===y;
    if(path.length===1&&path[0]==='amount'&&typeof x==='number'&&String(x)===y)return true;
    if(path.length===2&&path[0]==='transaction_fee'&&typeof x==='number'&&String(x)===y)return true;
    return carrier(x,y,path,hash)?true:undefined;
  }),
});
