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
 registerHooks({resolve(specifier,context,next){const result=next(specifier,context);
 if(/seller-agent\\.mjs|seller-state|\\/public\\/portal\\/|wallet-actions-not-wired/.test(result.url))throw Error('forbidden buyer dependency '+result.url);
 if(/seller-(?:agent-error|transport-auth|session-limits)\\.mjs/.test(result.url))throw Error('forbidden seller dependency '+result.url);
 if(result.url==='node:sqlite')throw Error('eager SQLite');return result;}});
 const http=await import(${JSON.stringify(new URL('../src/dacs/seller-http.mjs',import.meta.url).href)});
 assert.equal('createSellerHttpHandler' in http,false);assert.equal('loopbackSocket' in http,false);
 await import(${JSON.stringify(new URL('../src/wallet/devnet-native-transport.mjs',import.meta.url).href)});
 await assert.rejects(import(${JSON.stringify(new URL('../src/seams/wallet-actions-not-wired.mjs',import.meta.url).href)}), /forbidden buyer dependency/);`);
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
