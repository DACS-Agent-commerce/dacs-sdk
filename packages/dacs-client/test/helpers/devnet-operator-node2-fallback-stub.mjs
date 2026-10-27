// Offline in-memory Node2 wire stub. Hashes are derived fixture labels, never
// public-chain pins; the .invalid endpoint cannot resolve if a stub is skipped.
import { createHash } from 'node:crypto';

export const label=(text)=>createHash('sha256').update(text).digest('hex');
export const ENDPOINT='https://node2.test.invalid/';
export const ZERO=label('offline-node2-fallback-block-zero');
export const PREDECESSOR=label('offline-node2-fallback-predecessor');
export const BLOCK_ONE=label('offline-node2-fallback-block-one');
export const blockZero=()=>({result:200,response:{number:0,status:'confirmed',hash:ZERO}});
export const literalError=(result=400,rest={})=>({result,response:'error',...rest});
export const blockOne=(block={},rest={})=>({result:200,response:{number:1,status:'confirmed',hash:BLOCK_ONE,content:{previousHash:PREDECESSOR},...block},...rest});
export const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});

// answers[blockNumber] is JSON material or a function returning a Response/promise.
export function node2Stub(answers,{onRequest}={}){
  const calls=[];
  const fetchImpl=async(input,init={})=>{
    const call=JSON.parse(init.body).params[0];
    calls.push({url:String(input),method:init.method,redirect:init.redirect,cache:init.headers?.['cache-control']??init.cache,message:call.message,blockNumber:call.data?.blockNumber});
    await onRequest?.(call.data?.blockNumber);
    if(call.message!=='getBlockByNumber'||!Object.hasOwn(answers,call.data?.blockNumber))throw new Error('TEST Node2 stub has no answer for this call');
    const answer=answers[call.data.blockNumber];
    return typeof answer==='function'?answer():json(answer);
  };
  return {fetchImpl,calls,heights:()=>calls.map((call)=>call.blockNumber)};
}
