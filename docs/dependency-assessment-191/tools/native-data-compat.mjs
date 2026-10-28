import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const collection=process.env.S55_COLLECTION_ROOT||process.argv[2];
if(!collection)throw new Error('Set S55_COLLECTION_ROOT, then run node --test --test-concurrency=1 native-data-compat.mjs');
const moduleAt=(relative)=>import(pathToFileURL(path.resolve(collection,relative)).href);
const {StorageProgram: Broad}=await moduleAt('consumers/live-buyer/node_modules/@kynesyslabs/demosdk/build/storage/index.js');
const {StorageProgram: Narrow}=await moduleAt('consumers/native-alpha2/node_modules/@demosnetwork/demos-native/dist/storage.js');
const {serializeTransactionContent: broadSerialize}=await moduleAt('consumers/live-buyer/node_modules/@kynesyslabs/demosdk/build/denomination/serializerGate.js');
const {serializeTransactionContent: narrowSerialize}=await moduleAt('consumers/native-alpha2/node_modules/@demosnetwork/demos-native/dist/client.js');
const owner='0x'+'12'.repeat(32);
test('storage address bytes match across nonce and salt cases',()=>{
  for(const nonce of [0,1,42,Number.MAX_SAFE_INTEGER])for(const salt of ['', 'compat']){
    assert.equal(Narrow.deriveStorageAddress(owner,'dacs-compat',nonce,salt),Broad.deriveStorageAddress(owner,'dacs-compat',nonce,salt));
  }
});
test('SDK-used storage builders preserve JSON payload bytes',()=>{
  const json={record:{kind:'compat',value:42}};
  for(const options of [{nonce:1},{nonce:42,salt:'',metadata:{kind:'compat'}},{nonce:42,salt:'compat',storageLocation:'onchain'}]){
    for(const acl of [undefined,Broad.publicACL(),Broad.privateACL()]){
      assert.equal(JSON.stringify(Narrow.createStorageProgram(owner,'dacs-compat',json,'json',acl,options)),JSON.stringify(Broad.createStorageProgram(owner,'dacs-compat',json,'json',acl,options)));
    }
  }
  for(const method of ['writeStorage','readStorage']){
    const args=method==='writeStorage'?['stor-compat',json,'json']:['stor-compat'];
    assert.equal(JSON.stringify(Narrow[method](...args)),JSON.stringify(Broad[method](...args)));
  }
  assert.deepEqual(Narrow.publicACL(),Broad.publicACL());
});
test('valid pre-fork and post-fork transaction serialization preserves bytes',()=>{
  for(const amount of [0,1,1.25,1000000000n,'2500000000']){
    const content={type:'native',from:owner,to:owner,amount,data:['native',{nativeOperation:'send',args:[owner,amount]}],nonce:1,timestamp:1,transaction_fee:{network_fee:amount,rpc_fee:0,additional_fee:0,rpc_address:null,extra:'kept'},gcr_edits:[{type:'balance',amount},{type:'escrow',data:{amount}},{type:'nonce',amount:1}]};
    // Native payloads themselves carry number/string wire amounts, not bigint.
    if(typeof amount==='bigint')content.data=['native',{nativeOperation:'send',args:[owner,1]}];
    for(const postFork of [false,true])assert.equal(narrowSerialize(content,postFork),broadSerialize(content,postFork));
  }
});
