// Real native adapter and transport, retained public authorizations, injected
// read responses. No wallet module, submitter or purchase fixture mode. The
// signature-domain tests sign their CREATE with a key made at test time.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sha256Hex} from '@kynesyslabs/dacs';
import {createDevnetAgreementTransport} from '../src/wallet/devnet-native-transport.mjs';
import {createDemosSr2Adapter,createInMemoryDemosSr2Journal,isDemosSr2Contradiction} from '../src/dacs/demos-sr2-adapter.mjs';
import { readOnlyBoundary } from './helpers/read-only-boundary.mjs';
import {readTransactionSignaturePrefix} from '../src/dacs/transaction-signature-domain.mjs';
import {deriveStorageAddress} from '../src/dacs/wallet-transactions.mjs';
const f=JSON.parse(readFileSync(new URL('./fixtures/sr2-public-creates.json',import.meta.url)));
const clone=v=>structuredClone(v), writer='did:demos:agent:'+f.owner.slice(2);
const recordedNetworkInfo=name=>JSON.parse(JSON.parse(readFileSync(new URL(`../../../conformance/tp1-node-observations/${name}.json`,import.meta.url))).body).response;
// A node that reports the signatureDomain fork, not yet active. The CREATE is included at block 7.
const OS_DENOMINATION={activationHeight:0,activated:true,currentHeight:9};
const DOMAIN_INACTIVE={forks:{osDenomination:OS_DENOMINATION,signatureDomain:{activationHeight:null,activated:false,currentHeight:9}}};
const domainActive=(chainId,activationHeight=7)=>({forks:{osDenomination:OS_DENOMINATION,signatureDomain:{activationHeight,activated:true,currentHeight:9}},chainId});
function setup({projection=clone(f.valid),owner=f.owner,networkInfo=DOMAIN_INACTIVE,changeTx=()=>{},changeNative=()=>{},changeBlock=()=>{}}={}) {
 const op=projection.content.data[1],tx={...clone(projection),status:'confirmed',blockNumber:7};
 const native={success:true,storageAddress:op.storageAddress,owner,programName:op.programName,data:clone(op.data),metadata:clone(op.metadata),createdByTx:projection.hash,interactionTxs:[projection.hash]};
 const block={number:7,status:'confirmed',hash:'a'.repeat(64),content:{timestamp:1790000010,ordered_transactions:[projection.hash]},validation_data:{TEST:'single-node-observation',chainIdentity:f.pins.chainIdentity}};
 changeTx(tx);changeNative(native);changeBlock(block);
 let effects=0,info=networkInfo;
 const reads=[];
 const journal={get:async()=>null,put:async()=>{effects++;throw Error('write forbidden');},entries:async()=>[],withWalletLock:(_k,w)=>w()};
 const context={network:f.pins.network,endpoint:f.pins.endpoint,transportAuthority:f.pins.transportAuthority,connectionId:'TEST-connection'};
 const source=createDevnetAgreementTransport({ boundary: readOnlyBoundary,expected:f.pins,journal,now:()=>1790000020000,transportOwner:{getContext:()=>({...context}),acquireConnectionFence:()=>({context:{...context},release(){}})},fetchImpl:async(url,options={})=>{
  const body=options.body?JSON.parse(options.body):null,message=body?.params?.[0]?.message,data=body?.params?.[0]?.data;
  reads.push({url:String(url),message});
  let value;
  if(!body)value=native;
  else if(message==='getBlockByNumber')value=data.blockNumber===0?{number:0,status:'confirmed',hash:f.pins.chainIdentity,content:{}}:block;
  else if(message==='searchStoragePrograms')value=[{storageAddress:op.storageAddress,programName:op.programName}];
  else if(message==='getTxByHash')value=tx;
  else if(message==='getNetworkInfo'){if(info instanceof Error)throw info;value=info;}
  else {effects++;throw Error('unexpected effect '+message);}
  return new Response(JSON.stringify(body?{result:200,response:value}:value),{headers:{'content-type':'application/json'}});
 }});
 const adapterJournal=createInMemoryDemosSr2Journal(),expectedWriter='did:demos:agent:'+owner.slice(2);
 const adapter=createDemosSr2Adapter({rpcUrl:f.pins.endpoint,sourceCapability:source,journal:adapterJournal,now:()=>1790000020000});
 return {adapter,projection,reads,adapterJournal,setNetworkInfo:value=>{info=value;},effects:()=>effects,read:()=>adapter.read(f.logical,{expectedWriter,signedProjection:projection}),
  verifyReceipt:receipt=>adapter.verifyReceipt({receipt,logicalAddress:f.logical,artifact:f.artifact,expectedWriter,signedProjection:projection})};
}
// The fixture's valid CREATE, re-addressed to a writer key made at test time and signed over `messageFor(hash)`.
const testKey=generateKeyPairSync('ed25519');
const testOwner='0x'+Buffer.from(testKey.publicKey.export({format:'jwk'}).x,'base64url').toString('hex');
function createSignedOver(messageFor) {
 const content=clone(f.valid.content),op=content.data[1];
 content.from=content.from_ed25519_address=testOwner;
 op.storageAddress=content.to=deriveStorageAddress(testOwner,op.programName,content.nonce,'');
 const hash=sha256Hex(JSON.stringify(content));
 return {hash,content,signature:{type:'ed25519',data:'0x'+sign(null,Buffer.from(messageFor(hash),'utf8'),testKey.privateKey).toString('hex')}};
}
const signedWorld=(messageFor,networkInfo)=>setup({projection:createSignedOver(messageFor),owner:testOwner,networkInfo});
const refusedUnmarked=e=>e.code==='invalid'&&!isDemosSr2Contradiction(e);
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
test('with the signature domain inactive a bare-hash signature verifies',async()=>{
 const h=signedWorld(hash=>hash,DOMAIN_INACTIVE),r=await h.read();
 assert.equal(r.status,'present');assert.equal(await h.verifyReceipt(r.receipt),'valid');
});
test('with the signature domain inactive a signature over the domain form is refused',async()=>{
 const h=signedWorld(hash=>`demos-tx:v1:7:${hash}`,DOMAIN_INACTIVE);
 await assert.rejects(h.read(),refusedUnmarked);
});
for(const chainId of [7,0])test(`with the signature domain active on chain ${chainId} a signature over the domain form verifies`,async()=>{
 const h=signedWorld(hash=>`demos-tx:v1:${chainId}:${hash}`,domainActive(chainId)),r=await h.read();
 assert.equal(r.status,'present');assert.equal(await h.verifyReceipt(r.receipt),'valid');
});
for(const [name,messageFor] of [
 ['the bare hash',hash=>hash],
 ['another chain id',hash=>`demos-tx:v1:8:${hash}`],
 ['a zero-padded chain id',hash=>`demos-tx:v1:07:${hash}`],
 ['an empty chain id',hash=>`demos-tx:v1::${hash}`],
 ['the tag with no chain id field',hash=>`demos-tx:v1:${hash}`],
])test(`with the signature domain active on chain 7 a signature over ${name} is refused`,async()=>{
 const h=signedWorld(messageFor,domainActive(7));
 await assert.rejects(h.read(),refusedUnmarked);
});
// The Demos SDK signs the bare hash when the node reports no signatureDomain fork.
for(const [name,networkInfo] of [
 ['a signatureDomain-less network info answer',{forks:{osDenomination:{activated:true}},chainId:7}],
 ['the recorded answer of a node build without the signatureDomain fork',recordedNetworkInfo('network')],
 ['the recorded answer of a node build with the signatureDomain fork not active',recordedNetworkInfo('network-2026-10-20')],
]){
 test(`with ${name} a bare-hash signature verifies`,async()=>{
  const h=setup({networkInfo}),r=await h.read();
  assert.equal(r.status,'present');assert.equal(await h.verifyReceipt(r.receipt),'valid');
 });
 test(`with ${name} a signature over the domain form is refused`,async()=>{
  await assert.rejects(signedWorld(hash=>`demos-tx:v1:1:${hash}`,networkInfo).read(),refusedUnmarked);
 });
}
test('the recorded answer of the node build without the signatureDomain fork does not report it',()=>{
 assert.equal(Object.hasOwn(recordedNetworkInfo('network').forks,'signatureDomain'),false);
});
// The form follows the block that included the CREATE (block 7), not the fork state at readback.
for(const activationHeight of [8,1000]){
 test(`with the signature domain active from block ${activationHeight} a CREATE included at block 7 verifies the bare hash`,async()=>{
  const h=signedWorld(hash=>hash,domainActive(7,activationHeight)),r=await h.read();
  assert.equal(r.status,'present');assert.equal(await h.verifyReceipt(r.receipt),'valid');
 });
 test(`with the signature domain active from block ${activationHeight} a CREATE included at block 7 refuses the domain form`,async()=>{
  await assert.rejects(signedWorld(hash=>`demos-tx:v1:7:${hash}`,domainActive(7,activationHeight)).read(),refusedUnmarked);
 });
}
for(const activationHeight of [7,6,0]){
 test(`with the signature domain active from block ${activationHeight} a CREATE included at block 7 verifies the domain form`,async()=>{
  const h=signedWorld(hash=>`demos-tx:v1:7:${hash}`,domainActive(7,activationHeight)),r=await h.read();
  assert.equal(r.status,'present');assert.equal(await h.verifyReceipt(r.receipt),'valid');
 });
 test(`with the signature domain active from block ${activationHeight} a CREATE included at block 7 refuses the bare hash`,async()=>{
  await assert.rejects(signedWorld(hash=>hash,domainActive(7,activationHeight)).read(),refusedUnmarked);
 });
}
for(const [name,networkInfo] of [
 ['an unreadable',new Error('TEST-network-info-unreadable')],
 ['a non-object','TEST-not-an-object'],
 ['a fork-less',{chainId:7}],
 ['an osDenomination-less',{forks:{signatureDomain:{activationHeight:null,activated:false,currentHeight:9}},chainId:7}],
 ['a null signatureDomain',{forks:{osDenomination:OS_DENOMINATION,signatureDomain:null},chainId:7}],
 ['a non-boolean activation',{forks:{osDenomination:OS_DENOMINATION,signatureDomain:{activationHeight:7,activated:'true',currentHeight:9}},chainId:7}],
 ['an active chain-id-less',domainActive(undefined)],
 ['a negative chain id',domainActive(-1)],
 ['a fractional chain id',domainActive(7.5)],
 ['a decimal-string chain id',domainActive('7')],
 ['an unsafe chain id',domainActive(2**53)],
 ['an active activation-height-less',{forks:{osDenomination:OS_DENOMINATION,signatureDomain:{activated:true,currentHeight:9}},chainId:7}],
 ['an active unscheduled',domainActive(7,null)],
 ['a negative activation height',domainActive(7,-1)],
 ['a fractional activation height',domainActive(7,6.5)],
 ['a decimal-string activation height',domainActive(7,'6')],
 ['an unsafe activation height',domainActive(7,2**53)],
])test(`${name} network info answer leaves the readback indeterminate and applies nothing`,async()=>{
 const h=setup({networkInfo});
 await assert.rejects(h.read(),e=>e.code==='indeterminate');
 assert.deepEqual(await h.adapterJournal.records(),[]);assert.equal(h.effects(),0);
});
test('with the signature domain active a transaction without an inclusion height leaves the readback indeterminate and applies nothing',async()=>{
 const h=setup({networkInfo:domainActive(7),changeTx:tx=>{delete tx.blockNumber;}});
 await assert.rejects(h.read(),e=>e.code==='indeterminate');
 assert.deepEqual(await h.adapterJournal.records(),[]);assert.equal(h.effects(),0);
});
for(const inclusionHeight of [undefined,null,-1,7.5,'7',2**53])test(`with the signature domain active an inclusion height of ${JSON.stringify(inclusionHeight)??'undefined'} has no signature form`,async()=>{
 assert.equal(await readTransactionSignaturePrefix(async()=>domainActive(7),inclusionHeight),null);
});
test('verifyReceipt answers indeterminate when the signature domain becomes unreadable',async()=>{
 const h=setup(),r=await h.read();
 h.setNetworkInfo({forks:{}});
 assert.equal(await h.verifyReceipt(r.receipt),'indeterminate');
});
test('the signature domain is read once per readback, on the node the transaction came from',async()=>{
 const h=setup();await h.read();await h.read();
 const reads=h.reads.filter(({message})=>['getTxByHash','getNetworkInfo'].includes(message));
 assert.deepEqual(reads.map(({message})=>message),['getTxByHash','getNetworkInfo','getTxByHash','getNetworkInfo']);
 assert.equal(new Set(reads.map(({url})=>url)).size,1);
});
