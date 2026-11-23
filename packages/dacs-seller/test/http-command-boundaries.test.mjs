import test from 'node:test';
import assert from 'node:assert/strict';
import {createSellerAgentClient} from '../src/dacs/seller-http.mjs';
for(const method of ['propose','submitPayment','agreementContext'])test(`${method} rejects oversized nested decoded collections`,async()=>{
 const client=createSellerAgentClient({url:'http://127.0.0.1:1',fetchImpl:async()=>new Response(JSON.stringify({nested:{items:Array(100000).fill(0)}}),{headers:{'content-type':'application/json'}})});
 await assert.rejects(client[method]({}),e=>e.name==='SellerUnavailableError');
});
