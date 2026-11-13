import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {canonicalize} from '@kynesyslabs/dacs';
import {fetchBoundedJson} from '../src/util/http.mjs';
import {createSellerAgentClient} from '../src/dacs/seller-http.mjs';
import {createDirectoryClient} from '../src/dacs/directory.mjs';
import {createDemosChainReader} from '../src/dacs/chain.mjs';
import {createListingVerifier} from '../src/dacs/verification.mjs';
const corpus=JSON.parse(readFileSync(new URL('../../../test/fixtures/standard-next/raw-json-profile-v0.1.json',import.meta.url)));
const jsonResponse=bytes=>new Response(bytes,{headers:{'content-type':'application/json'}});
for(const vector of corpus.vectors)test(`CF-5 real ingress corpus: ${vector.name}`,async()=>{
 const bytes=(vector.rawHex??vector.rawUtf8Hex)?Buffer.from(vector.rawHex??vector.rawUtf8Hex,'hex'):Buffer.from(vector.rawUtf8Text,'utf8');
 const read=()=>fetchBoundedJson('https://read.invalid/',{fetchImpl:async()=>jsonResponse(bytes),timeoutMs:1000,maxBytes:1024*1024,expectedOrigin:'https://read.invalid'});
 const client=createSellerAgentClient({url:'http://127.0.0.1',fetchImpl:async()=>jsonResponse(bytes)});
 const post=()=>client.propose({});
 if(vector.expected==='reject') {
  await assert.rejects(read,e=>e.code===vector.expectedErrorCode && e.stage===vector.expectedStage);
  await assert.rejects(post,e=>e.admissionCode===vector.expectedErrorCode && e.admissionStage===vector.expectedStage);
 } else {
  const value=await read();assert.equal(Buffer.from(canonicalize(value)).toString('hex'),vector.canonicalUtf8Hex);
  // Seller application messages must also be objects; admission acceptance
  // alone does not grant an application action for a scalar or array.
  if(value!==null && typeof value==='object' && !Array.isArray(value)) assert.deepEqual(await post(),value);
  else await assert.rejects(post,e=>e.admissionCode===undefined);
 }
});
test('duplicate signed Listing members cannot yield a verified/transactable result',async()=>{
 const f=JSON.parse(readFileSync(new URL('./fixtures/live-directory-market-report.json',import.meta.url))),listing=f.storageProgram.data;
 for(const where of ['directory','storage']) {
  const fetchImpl=async input=>{
   const u=new URL(input),v=u.pathname==='/api/dacs/listings'?{listings:[f.summary],cursor:null,total:1}:u.pathname.startsWith('/api/dacs/listings/')?listing:f.storageProgram;
   let text=JSON.stringify(v);
   if(where==='directory'&&v===listing)text='{"listingId":"unsigned-first-member",'+text.slice(1);
   if(where==='storage'&&v===f.storageProgram)text=text.replace('"data":{','"data":{"listingId":"unsigned-first-member",');
   return jsonResponse(text);
  };
  const verifier=createListingVerifier({directory:createDirectoryClient({origin:'https://read.invalid',fetchImpl}),chain:createDemosChainReader({rpcUrl:'https://read.invalid',network:'read',fetchImpl}),now:()=>Date.parse(f.capturedAt)});
  try {const r=await verifier.verify({listingId:listing.listingId,version:listing.listingVersion,seller:listing.seller.identity.presentedBy});assert.equal(r.transactable,false);assert.ok(r.checks.some(c=>!c.ok));}
  catch(e){assert.equal(e.code,'DUPLICATE-MEMBER');}
 }
});
