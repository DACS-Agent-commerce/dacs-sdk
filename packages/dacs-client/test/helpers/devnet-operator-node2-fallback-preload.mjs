// TEST-only --import preload for the bootstrap CLI: replaces fetch with an
// in-memory Node2 stub so the child process never reaches any network.
import { appendFileSync } from 'node:fs';

const endpoint=process.env.DACS_TEST_NODE2_FALLBACK_ENDPOINT;
const blocks=JSON.parse(process.env.DACS_TEST_NODE2_FALLBACK_BLOCKS??'{}');
const log=process.env.DACS_TEST_NODE2_FALLBACK_LOG;
globalThis.fetch=async(input,init={})=>{
  const call=JSON.parse(init.body??'null')?.params?.[0];
  if(String(input)!==endpoint||init.method!=='POST'||init.redirect!=='error'||call?.message!=='getBlockByNumber'
    ||!Object.hasOwn(blocks,String(call.data?.blockNumber)))throw new Error('TEST Node2 stub refused an unexpected request');
  appendFileSync(log,`${call.data.blockNumber}\n`);
  return new Response(JSON.stringify(blocks[call.data.blockNumber]),{status:200,headers:{'content-type':'application/json'}});
};
