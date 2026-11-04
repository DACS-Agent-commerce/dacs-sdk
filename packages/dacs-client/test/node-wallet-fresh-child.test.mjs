import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runFreshChild } from './helpers/fresh-node-child.mjs';
import { mnemonicBytes } from './helpers/tp1-node-fixture.mjs';
const names = ["a fresh child with no NODE_OPTIONS, loaders or helper imports constructs the source node-wallet entry, imports a generated valid mnemonic, completes an offline native-send and storage-CREATE control, and writes nothing to stdout or stderr, also when preparation fails or answers malformed", "a fresh child speaking a JSON-RPC line protocol on stdout answers a request, makes an offline native send, then answers a second request; every stdout line parses as a frame"];
const fixture = readFileSync(new URL('./helpers/tp1-node-fixture.mjs',import.meta.url),'utf8');
const nodeSource = fixture.slice(fixture.indexOf('export function scriptedNode()'),fixture.indexOf('export async function world')).replace('export ','');
const agreementSource = fixture.slice(fixture.indexOf('export async function agreementRequest')).replace('export ','').replace("'../../src/dacs/wallet-transactions.mjs'",JSON.stringify(new URL('../src/dacs/wallet-transactions.mjs',import.meta.url).href));
const source = `
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { installPurchaseAdmissionHook,loadAdmissionDouble } from ${JSON.stringify(new URL('./helpers/purchase-admission-hook.mjs',import.meta.url).href)};
installPurchaseAdmissionHook(); (await loadAdmissionDouble()).setPurchaseAdmission('testnet-tp1');
const api=await import(${JSON.stringify(new URL('../src/wallet/node-wallet-session.mjs',import.meta.url).href)});
const { bindTp1Profile,TP1_APPROVED_IDENTITY_RECORD }=await import(${JSON.stringify(import.meta.resolve('@kynesyslabs/dacs/wire'))});

const {buildNativeTransferPayload}=await import(${JSON.stringify(new URL('../src/dacs/wallet-transactions.mjs',import.meta.url).href)});
const T0=1793102400000,ok=response=>({result:200,response,require_reply:false,extra:null});
${nodeSource}
${agreementSource.replaceAll("'@kynesyslabs/dacs'",JSON.stringify(import.meta.resolve('@kynesyslabs/dacs')))}
const node=scriptedNode(),owner=api.createNodeTransportOwner({endpoint:'https://rpc.example.invalid/',transportAuthority:'vector-authority',fetchImpl:node.fetch});
const binding=await bindTp1Profile({record:TP1_APPROVED_IDENTITY_RECORD,local:owner.local,readAuthority:async scope=>({local:scope.local,chainIdentity:TP1_APPROVED_IDENTITY_RECORD.chainIdentity,provenance:'TEST-child',sessionId:scope.sessionId,participants:[]})});
const records=new Map(); const journal={get:async k=>records.get(k)??null,put:async(k,v)=>records.set(k,structuredClone(v)),entries:async()=>[...records],withWalletLock:async(k,work)=>work(),close(){}};
const session=await api.createNodeWalletSession({admission:{binding,currentLocal:owner.currentLocal},owner,journal,key:new Uint8Array(JSON.parse(process.argv[2])),approve:async()=>true,clock:{now:()=>T0}});
const address=session.wallet.getPublicAccount().address;
if(process.argv[3]==='frames')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:1,result:address})+'\\n');
const send=await session.wallet.request({method:'sendTransaction',params:[buildNativeTransferPayload({from:address,to:'0x'+'2'.repeat(64),amountOs:'2500000000',nonce:1,timestamp:T0,encoding:'os-string'})]});
assert.equal(send.success,true,JSON.stringify(send));
// Resolve the native lane by authenticated readback before the second effect.
const receipt=await session.wallet.request({method:'readNativeTransfer',params:[{hash:node.broadcasts[0].hash}]});
assert.equal(receipt.data.disposition,'included',JSON.stringify(receipt));
const request=await agreementRequest({session,node});node.mode='drop';await session.wallet.request(request);assert.equal(node.broadcasts.length,2);
for(const malformed of [true,false]){node.intercept=async()=>{if(!malformed)throw new Error('TEST-preparation-failure');return new Response(JSON.stringify(ok(null)),{headers:{'content-type':'application/json'}});};const failed=await session.wallet.request(request);assert.equal(failed.success,false);}
if(process.argv[3]==='frames')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:2,result:true})+'\\n');
writeFileSync('result.json',JSON.stringify({broadcasts:node.broadcasts.length,globals:['window','document','location'].map(k=>typeof globalThis[k])}));
await session.close();journal.close();
`;
for (let i=0;i<names.length;i++) test(names[i],t=>{
 const child=runFreshChild(t,source,[JSON.stringify([...mnemonicBytes()]),i?'frames':'silent']);
 assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,'');
 assert.deepEqual(child.result,{broadcasts:2,globals:['undefined','undefined','undefined']});
 if(i)assert.deepEqual(child.stdout.trim().split('\n').map(line=>JSON.parse(line).id),[1,2]);else assert.equal(child.stdout,'');
});
