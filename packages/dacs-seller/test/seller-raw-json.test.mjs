import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {createSellerAgentClient}=await import('../src/dacs/seller-http.mjs');
import {exchange} from './helpers/d5-http-fixture.mjs';
import {world,PATHS} from './helpers/wire-routes-world.mjs';
const corpus=JSON.parse(readFileSync(new URL('../../../test/fixtures/standard-next/raw-json-profile-v0.1.json',import.meta.url)));
for(const vector of corpus.vectors)test(`HTTP exact bytes: ${vector.name}`,async(t)=>{
 const raw=vector.rawHex===undefined?Buffer.from(vector.rawUtf8Text):Buffer.from(vector.rawHex,'hex');
 const w=await world(t);
 const res=await exchange(w.handle.handler,{url:PATHS.proposals,text:raw});
 if(vector.expected==='reject'){assert.equal(res.status,400);assert.equal(JSON.parse(res.text).error,'bad_json');assert.equal(w.effects(),0);}
 else assert.notEqual(JSON.parse(res.text).error,'bad_json');
});
for(const raw of ['{"x":0,"x":1}','{"n":9007199254740991.1}','{"x":1e-400}','\ufeff{}','{"a":1,"\\u0061":2}'])test(`a received response that is not exact JSON is unavailable: ${raw}`,async()=>{
 const client=createSellerAgentClient({url:'http://127.0.0.1',fetchImpl:async()=>new Response(raw,{status:200,headers:{'content-type':'application/json'}})});
 await assert.rejects(client.propose({}),{code:'seller_unavailable'});
});
test('RPC responses admit exact bytes before discarding duplicate members or numeric identity', async () => {
  const { fetchBoundedJson } = await import('../src/util/http.mjs');
  const get = raw => fetchBoundedJson('http://127.0.0.1/', { fetchImpl: async () => new Response(raw, { headers: { 'content-type': 'application/json' } }), timeoutMs: 1000, maxBytes: 4096 });
  for (const raw of ['{"response":{"jobId":"other","jobId":"paid"}}', '{"a":1,"\\u0061":2}', '{"n":9007199254740991.1}', '\ufeff{}', new Uint8Array([0x22, 0xc0, 0xaf, 0x22])]) {
    await assert.rejects(get(raw), { kind: 'invalid' });
  }
  assert.deepEqual(await get('{"response":{"jobId":"paid","n":1e0}}'), { response: { jobId: 'paid', n: 1 } });
});
