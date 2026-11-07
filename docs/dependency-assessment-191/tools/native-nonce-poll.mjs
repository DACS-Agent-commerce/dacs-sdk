import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const collection=process.env.S55_COLLECTION_ROOT||process.argv[2];
if(!collection)throw new Error('Set S55_COLLECTION_ROOT, then run node --test --test-concurrency=1 native-nonce-poll.mjs');
const moduleAt=(relative)=>import(pathToFileURL(path.resolve(collection,relative)).href);
// The broad websdk barrel needs the same resolver hook the generated project loads with --import.
await moduleAt('consumers/live-buyer/node_modules/@kynesyslabs/dacs-node/dist/demosLoader.js');
const {Demos: Broad}=await moduleAt('consumers/live-buyer/node_modules/@kynesyslabs/demosdk/build/websdk/index.js');
const {Demos: Narrow}=await moduleAt('consumers/native-alpha2/node_modules/@demosnetwork/demos-native/dist/client.js');
const address='0x'+'34'.repeat(32);
// Wallet-free: the node read is a scripted reply sequence; no connection, key, signature or chain call is made.
function scripted(client,replies){
  let calls=0;
  client.nodeCall=async(method)=>{
    assert.equal(method,'getAddressNonce');
    const reply=replies[Math.min(calls++,replies.length-1)];
    if(reply instanceof Error)throw reply;
    return reply;
  };
  return ()=>calls;
}
test('a transient nonce read error: broad keeps polling, native alpha.2 rejects',async()=>{
  const broad=new Broad();
  const broadCalls=scripted(broad,[new Error('transient read'),5]);
  assert.equal(await broad.waitForNonce(address,5,{timeoutMs:2000,pollIntervalMs:1}),5);
  assert.equal(broadCalls(),2);
  const narrow=new Narrow();
  const narrowCalls=scripted(narrow,[new Error('transient read'),5]);
  await assert.rejects(narrow.waitForNonce(address,5,{timeoutMs:2000,pollIntervalMs:1}),/transient read/);
  assert.equal(narrowCalls(),1);
});
test('a malformed nonce: broad reads it as 0, native alpha.2 fails closed',async()=>{
  const broad=new Broad();
  scripted(broad,['not-a-nonce']);
  assert.equal(await broad.getAddressNonce(address),0);
  const narrow=new Narrow();
  scripted(narrow,['not-a-nonce']);
  await assert.rejects(narrow.getAddressNonce(address),/no valid address nonce/);
});
