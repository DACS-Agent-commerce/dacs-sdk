// Real native adapter and transport, retained public authorizations, injected
// read responses. No wallet module, signer, submitter or purchase fixture mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDevnetAgreementTransport} from '../src/wallet/devnet-native-transport.mjs';
import {createDemosSr2Adapter,createInMemoryDemosSr2Journal} from '../src/dacs/demos-sr2-adapter.mjs';
const f=JSON.parse(readFileSync(new URL('./fixtures/sr2-public-creates.json',import.meta.url)));
const clone=v=>structuredClone(v), writer='did:demos:agent:'+f.owner.slice(2);
function setup({projection=clone(f.valid),changeTx=()=>{},changeNative=()=>{},changeBlock=()=>{}}={}) {
 const op=projection.content.data[1],tx={...clone(projection),status:'confirmed',blockNumber:7};
 const native={success:true,storageAddress:op.storageAddress,owner:f.owner,programName:op.programName,data:clone(op.data),metadata:clone(op.metadata),createdByTx:projection.hash,interactionTxs:[projection.hash]};
 const block={number:7,status:'confirmed',hash:'a'.repeat(64),content:{timestamp:1790000010,ordered_transactions:[projection.hash]},validation_data:{TEST:'single-node-observation',chainIdentity:f.pins.chainIdentity}};
 changeTx(tx);changeNative(native);changeBlock(block);
 let effects=0;
 const journal={get:async()=>null,put:async()=>{effects++;throw Error('write forbidden');},entries:async()=>[],withWalletLock:(_k,w)=>w()};
 const context={network:f.pins.network,endpoint:f.pins.endpoint,transportAuthority:f.pins.transportAuthority,connectionId:'TEST-connection'};
 const source=createDevnetAgreementTransport({expected:f.pins,journal,now:()=>1790000020000,transportOwner:{getContext:()=>({...context}),acquireConnectionFence:()=>({context:{...context},release(){}})},fetchImpl:async(url,options={})=>{
  const body=options.body?JSON.parse(options.body):null,message=body?.params?.[0]?.message,data=body?.params?.[0]?.data;
  let value;
  if(!body)value=native;
  else if(message==='getBlockByNumber')value=data.blockNumber===0?{number:0,status:'confirmed',hash:f.pins.chainIdentity,content:{}}:block;
  else if(message==='searchStoragePrograms')value=[{storageAddress:op.storageAddress,programName:op.programName}];
  else if(message==='getTxByHash')value=tx;
  else {effects++;throw Error('unexpected effect '+message);}
  return new Response(JSON.stringify(body?{result:200,response:value}:value),{headers:{'content-type':'application/json'}});
 }});
 const adapter=createDemosSr2Adapter({rpcUrl:f.pins.endpoint,sourceCapability:source,journal:createInMemoryDemosSr2Journal(),now:()=>1790000020000});
 return {adapter,projection,effects:()=>effects,read:()=>adapter.read(f.logical,{expectedWriter:writer,signedProjection:projection})};
}
test('retained public CREATE authenticates through real adapter and verifies its receipt',async()=>{
 const h=setup(),r=await h.read();assert.equal(r.status,'present');
 assert.equal(await h.adapter.verifyReceipt({receipt:r.receipt,logicalAddress:f.logical,artifact:f.artifact,expectedWriter:writer,signedProjection:h.projection}),'valid');
 assert.equal(h.effects(),0);
});
for(const [name,options] of [
 ['wrong writer signature',{projection:{...clone(f.valid),signature:{type:'ed25519',data:'0x'+'00'.repeat(64)}}}],
 ['changed signed bytes',{projection:{...clone(f.valid),content:{...clone(f.valid.content),amount:1}}}],
 ['signed writer differs',{projection:clone(f.wrongFrom)}],
 ['changed executed content',{changeTx:tx=>{tx.content.data[1].data.TEST='changed';}}],
 ['changed native bytes',{changeNative:n=>{n.data.TEST='changed';}}],
 ['wrong nonce-derived address',{projection:clone(f.wrongNonce)}],
 ['wrong creation receipt binding',{changeNative:n=>{n.createdByTx='b'.repeat(64);}}],
 ['unconfirmed transaction',{changeTx:tx=>{tx.status='pending';}}],
 ['unconfirmed containing block',{changeBlock:b=>{b.status='pending';}}],
 ['transaction missing from block',{changeBlock:b=>{b.content.ordered_transactions=[];}}],
])test(`native authorization refuses ${name}`,async()=>{
 const h=setup(options);let verified;
 await assert.rejects(async()=>{verified=await h.read();},e=>['invalid','indeterminate'].includes(e.code));
 assert.equal(verified,undefined);assert.equal(h.effects(),0);
});
test('receipt content binding cannot be changed after authentication',async()=>{
 const h=setup(),r=await h.read(),receipt={...r.receipt,contentHash:'b'.repeat(64)};
 assert.equal(await h.adapter.verifyReceipt({receipt,logicalAddress:f.logical,artifact:f.artifact,expectedWriter:writer,signedProjection:h.projection}),'invalid');assert.equal(h.effects(),0);
});
