import { createHash } from 'node:crypto';

export const label=(text)=>createHash('sha256').update(text).digest('hex');
export const ENDPOINT='https://node2-layout.test.invalid/';
export const CHAIN=label('offline-node2-layout-chain');
export const BLOCK_ONE=label('offline-node2-layout-block-one');
export const BLOCK_TWO=label('offline-node2-layout-block-two');
export const actualZero=()=>({result:400,response:'error',require_reply:false,extra:'Block number not provided'});
export const offsetBlock=(number,id,hash,previousHash,block={},envelope={})=>({result:200,response:{number,id,status:'confirmed',hash,content:{previousHash},...block},require_reply:false,extra:'',...envelope});
export const blockOne=(block={},envelope={})=>offsetBlock(1,2,BLOCK_ONE,CHAIN,block,envelope);
export const blockTwo=(block={},envelope={})=>offsetBlock(2,3,BLOCK_TWO,BLOCK_ONE,block,envelope);

export function node2LayoutStub(answers,{onRequest}={}){
  const calls=[];
  const fetchImpl=async(input,init={})=>{
    const call=JSON.parse(init.body).params[0],height=call.data?.blockNumber;
    calls.push({url:String(input),method:init.method,redirect:init.redirect,cache:init.headers?.['cache-control']??init.cache,message:call.message,blockNumber:height});
    await onRequest?.(height);
    if(call.message!=='getBlockByNumber'||!Object.hasOwn(answers,height))throw new Error('TEST Node2 layout stub refused an unexpected request');
    const answer=answers[height];return typeof answer==='function'?answer():new Response(JSON.stringify(answer),{status:200,headers:{'content-type':'application/json'}});
  };
  return {fetchImpl,calls,heights:()=>calls.map((call)=>call.blockNumber)};
}
