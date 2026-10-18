import './helpers/d5-isolated-dependencies.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {createSellerHttpHandler,createSellerAgentClient}=await import('../src/dacs/seller-http.mjs');
import {exchange,key} from './helpers/d5-http-fixture.mjs';
const {createSellerTransportServerAuth,createSellerTransportStore}=await import('../src/dacs/seller-transport-auth.mjs');
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const corpus=JSON.parse(readFileSync(new URL('../../../test/fixtures/standard-next/raw-json-profile-v0.1.json',import.meta.url)));
for(const vector of corpus.vectors)test(`HTTP exact bytes: ${vector.name}`,async()=>{
 const raw=vector.rawHex===undefined?Buffer.from(vector.rawUtf8Text):Buffer.from(vector.rawHex,'hex');
 let dispatched=0;
 const handler=createSellerHttpHandler({receiveProposal:()=>{dispatched++;return {ok:true};}});
 const res=await exchange(handler,{url:'/dacs/v1/agreements/proposals',text:raw});
 if(vector.expected==='reject'){assert.equal(res.status,400);assert.equal(JSON.parse(res.text).error,'bad_json');assert.equal(dispatched,0);}
 else assert.notEqual(JSON.parse(res.text).error,'bad_json');
});
for(const raw of ['{"x":0,"x":1}','{"n":9007199254740991.1}','{"x":1e-400}','\ufeff{}','{"a":1,"\\u0061":2}'])test(`received response is admitted before authentication: ${raw}`,async()=>{
 let auth=0;const client=createSellerAgentClient({url:'http://127.0.0.1',fetchImpl:async()=>new Response(raw,{status:200,headers:{'content-type':'application/json'}}),authentication:{request:async()=>({header:'fixture',payload:{}}),verifyResponse:()=>{auth++;}}});
 await assert.rejects(client.propose({}),{code:'seller_unavailable'});assert.equal(auth,0);
});
test('decoded authentication envelope rejects duplicate names and lossy numeric tokens before signature checks',()=>{
 const seller=key(),dir=mkdtempSync(join(tmpdir(),'seller-json-')),store=createSellerTransportStore({path:join(dir,'transport.sqlite')});
 try{const auth=createSellerTransportServerAuth({sellerSigner:seller,listingPin:{listingId:'raw',version:1,contentHash:'a'.repeat(64)},store});
  for(const raw of ['{"payload":{},"payload":{},"signature":"x"}','{"payload":{"n":9007199254740991.1},"signature":"x"}','\ufeff{}'])assert.throws(()=>auth.readRequest(Buffer.from(raw).toString('base64url')),{code:'peer_envelope_invalid'});
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
