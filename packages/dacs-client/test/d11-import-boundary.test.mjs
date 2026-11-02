import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as wallet from '../src/public/portal/embedded-wallet/sdk-provider.mjs';
import * as helpers from '../src/wallet/payload-helpers.mjs';
import { createDevnetAgreementTransport } from '../src/wallet/devnet-native-transport.mjs';

function fresh(source) {
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'});
 assert.equal(result.status,0,result.stdout+result.stderr);
}
test('buyer modules avoid seller state, portal, wallet seams and eager SQLite', () => {
 fresh(`import assert from 'node:assert/strict';import {registerHooks} from 'node:module';
 import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
 let sqliteAllowed=false,sqliteLoads=0;
 registerHooks({resolve(specifier,context,next){const result=next(specifier,context);
 if(/seller-agent\\.mjs|seller-state|\\/public\\/portal\\/|wallet-actions-not-wired/.test(result.url))throw Error('forbidden buyer dependency '+result.url);
 if(result.url==='node:sqlite'){assert.equal(sqliteAllowed,true,'eager SQLite');sqliteLoads++;}return result;}});
 await import(${JSON.stringify(new URL('../src/dacs/seller-http.mjs',import.meta.url).href)});
 await import(${JSON.stringify(new URL('../src/wallet/devnet-native-transport.mjs',import.meta.url).href)});
 await assert.rejects(import(${JSON.stringify(new URL('../src/seams/wallet-actions-not-wired.mjs',import.meta.url).href)}), /forbidden buyer dependency/);
 const {createSellerTransportStore}=await import(${JSON.stringify(new URL('../src/dacs/seller-transport-auth.mjs',import.meta.url).href)});
 assert.equal(sqliteLoads,0);sqliteAllowed=true;
 const dir=mkdtempSync(join(tmpdir(),'dacs-import-store-'));
 try{const store=createSellerTransportStore({path:join(dir,'peer.sqlite')});
 store.bind({seller:'TEST-seller',listingPin:{listingId:'TEST-listing',version:1,contentHash:'a'.repeat(64)}});store.close();assert.equal(sqliteLoads,1);}
 finally{rmSync(dir,{recursive:true,force:true});}`);
});
test('served provider loads as a standalone data module', async () => {
 const source=readFileSync(new URL('../src/public/portal/embedded-wallet/sdk-provider.mjs',import.meta.url),'utf8');
 const served=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 assert.equal(await served.nativePayloadDigest({}),await helpers.nativePayloadDigest({}));
});
test('production native claim uses the pure payload digest without wallet actions', async () => {
 const {pins}=JSON.parse(readFileSync(new URL('./fixtures/sr2-public-creates.json',import.meta.url)));
 let writes=0,reads=0;
 const source=createDevnetAgreementTransport({expected:pins,now:()=>1790000020000,
  journal:{get:async()=>null,entries:async()=>[],put:async()=>{writes++;},withWalletLock:(_key,fn)=>fn()},
  transportOwner:{getContext:()=>{throw Error('unexpected connection');},acquireConnectionFence:()=>{throw Error('unexpected fence');}},
  fetchImpl:()=>{reads++;throw Error('unexpected fetch');}});
 const from='0x'+'a'.repeat(64),to='0x'+'b'.repeat(64);
 assert.equal(await source.nativeTransferClaimed(from,{content:{type:'native',from,to,amount:'1000000000',nonce:7,timestamp:1,data:['native',{nativeOperation:'send',args:[to,'1000000000']}]}}),null);
 assert.equal(writes,0);assert.equal(reads,0);
});
test('seller agent and HTTP transport share refusal identity', () => {
 fresh(`import assert from 'node:assert/strict';import {Readable} from 'node:stream';
 const agent=await import(${JSON.stringify(new URL('../src/dacs/seller-agent.mjs',import.meta.url).href)});
 const shared=await import(${JSON.stringify(new URL('../src/dacs/seller-agent-error.mjs',import.meta.url).href)});
 const {createSellerHttpHandler}=await import(${JSON.stringify(new URL('../src/dacs/seller-http.mjs',import.meta.url).href)});
 assert.equal(agent.SellerAgentError,shared.SellerAgentError);
 const handler=createSellerHttpHandler({commit(){throw new agent.SellerAgentError('unknown_job','TEST refused',404);}});
 const req=Readable.from([Buffer.from('{}')]);Object.assign(req,{method:'POST',url:'/dacs/v1/commitments',headers:{'content-type':'application/json'},socket:{remoteAddress:'127.0.0.1',localAddress:'127.0.0.1'}});
 let status,body;await handler(req,{writeHead(s){status=s;},end(b){body=JSON.parse(b);}});
 assert.equal(status,404);assert.equal(body.error,'unknown_job');`);
});
test('extracted digest matches the SDK serializer byte contract', async () => {
 const {serializeTransactionContent}=await import(new URL('denomination/serializerGate.js',import.meta.resolve('@kynesyslabs/demosdk')));
 const to='0x'+'b'.repeat(64),content={type:'native',from:'0x'+'a'.repeat(64),to,amount:'1000000000',nonce:7,timestamp:1,data:['native',{nativeOperation:'send',args:[to,'1000000000']}]};
 const signed=JSON.parse(serializeTransactionContent({...content,transaction_fee:{network_fee:1,rpc_fee:1,additional_fee:0},gcr_edits:[]},true));
 assert.equal(await helpers.nativePayloadDigest(signed),await helpers.nativePayloadDigest(content));
});
test('standalone provider helpers are generated from their maintained source', async () => {
 const { payloadHelpersSource } = await import('../scripts/generate-payload-helpers.mjs');
 const source=readFileSync(new URL('../src/public/portal/embedded-wallet/sdk-provider.mjs',import.meta.url),'utf8');
 assert.equal(readFileSync(new URL('../src/wallet/payload-helpers.mjs',import.meta.url),'utf8'),payloadHelpersSource(source));
});
