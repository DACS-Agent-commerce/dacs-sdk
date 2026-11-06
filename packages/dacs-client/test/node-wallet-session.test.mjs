import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { runFreshChild } from './helpers/fresh-node-child.mjs';
import { api, world, mnemonicBytes, setPurchaseAdmission } from './helpers/tp1-node-fixture.mjs';
const refusal = code => error => error.code === code || error.message === code;

test("admitted through the test seam, a native send signs once, confirms once and broadcasts once on the scripted TP-1 node", async t => {
const w = await world(t);const {Demos}=await (await import('../src/wallet/node-demos-loading.mjs')).loadNodeDemos();const original=Demos.prototype.sign;let signs=0;t.mock.method(Demos.prototype,'sign',function(...args){signs++;return Reflect.apply(original,this,args);}); const result = await w.send();assert.equal(signs,1); assert.equal(result.success, true, JSON.stringify(result)); assert.equal(w.node.confirms.length, 1); assert.equal(w.node.broadcasts.length, 1); assert.deepEqual(w.node.confirms[0], w.node.broadcasts[0]);
});

test("with window, document and location absent, the public factory builds both profile helpers and the session from one fixed descriptor origin, and no request is addressed to that origin", async t => {
const w = await world(t); const {createDevnetNativeWalletTransport,createDevnetAgreementWalletTransport}=await import('../src/public/portal/embedded-wallet/sdk-provider.mjs'); const relayOrigin='https://node-wallet.invalid'; const descriptor={network:'demos-testnet',rpcUrl:relayOrigin+'/portal/api/devnet-native-wallet-rpc',bindingUrl:relayOrigin+'/portal/api/devnet-native-wallet-binding'}; assert.ok(createDevnetNativeWalletTransport({...descriptor,profile:'devnet-native'},{relayOrigin})); assert.ok(createDevnetAgreementWalletTransport({...descriptor,profile:'devnet-agreement',transportBinding:w.session.wallet.getWriteProfile().transportBinding},{relayOrigin})); for (const key of ['window','document','location']) assert.equal(typeof globalThis[key], 'undefined'); assert.ok(w.session.wallet.getWriteProfile()); const sent = await w.send(); assert.equal(sent.success, true, JSON.stringify(sent)); assert.ok(w.node.calls.every(row => row.url === w.owner.local.endpoint && row.redirect === 'error'));
});

test("with relayOrigin absent, readTransport, both profile helpers and the anchor plan still compare with globalThis.location", async () => {
const source = readFileSync(new URL('../src/public/portal/embedded-wallet/sdk-provider.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
const origin = 'https://browser.example.invalid';
const context = { URL, TextEncoder, location: { origin } };
runInNewContext(source + `; globalThis.check = () => {
 const profile = { profile: DEVNET_NATIVE_TRANSPORT_PROFILE, network: 'testnet', rpcUrl: location.origin + '/portal/api/devnet-native-wallet-rpc', bindingUrl: location.origin + '/portal/api/devnet-native-wallet-binding' };
 const transportBinding={source:'devnet-agreement-transport/v1',bindingVersion:'dacs-demos-network-binding/v1',bindingId:'a'.repeat(64),network:'testnet',chainIdentity:'b'.repeat(64),pinVersion:'TEST-origin',endpoint:'https://rpc.example.invalid/',transportAuthority:'vector-authority'};
 const agreement={...profile,profile:DEVNET_AGREEMENT_TRANSPORT_PROFILE,transportBinding};
 const wallet=createSdkWalletSession({DemosCtor:class {},transactionTransport:agreement});
 return readTransport(profile).rpcUrl === createDevnetNativeWalletTransport(profile).rpcUrl && createDevnetAgreementWalletTransport(agreement).rpcUrl===profile.rpcUrl && wallet.getWriteProfile().profile===DEVNET_AGREEMENT_TRANSPORT_PROFILE && readTransport({...profile, rpcUrl:'https://other.invalid/portal/api/devnet-native-wallet-rpc'}) === null;
}; globalThis.anchorCheck=async(origin)=>{const transport={rpcUrl:origin+'/portal/api/devnet-native-wallet-rpc'}; try{await devnetAgreementAnchorPlan({},'',transport);}catch(error){return error.code;}};`, context);
assert.equal(context.check(), true);assert.equal(await context.anchorCheck(origin),'invalid_params');assert.equal(await context.anchorCheck('https://other.invalid'),'unsupported');
assert.match(source, /devnetAgreementAnchorPlan\(request, address, transport, relayOrigin/);
});

test("held, every write request rejects profile_not_admitted with signer 0 and node calls 0", async t => {
const w = await world(t, {held:true});const {Demos}=await (await import('../src/wallet/node-demos-loading.mjs')).loadNodeDemos();let signs=0;for(const name of ['sign','signMessage'])t.mock.method(Demos.prototype,name,async()=>{signs++;throw new Error('TEST-held-signer-called');}); for (const method of ['sendTransaction','sign','signMessage','signTransaction','registerIdentity','getWeb2IdentityProofPayload','anchorAgreement']) { const pending = w.session.wallet.request(method==='sendTransaction'?w.request:{method,params:method==='sign'?['TEST-held']:[]}); assert.ok(pending instanceof Promise); await assert.rejects(pending, refusal('profile_not_admitted')); } assert.equal(w.node.calls.length, 0); assert.equal((await w.journal().entries()).length, 0);assert.equal(signs,0);
});

test("held, getPublicAccount, getWriteProfile, isLocked and lock keep their signatures", async t => {
const w = await world(t, {held:true}); assert.equal(typeof w.session.wallet.getPublicAccount().address, 'string'); assert.equal(typeof w.session.wallet.getWriteProfile(), 'object'); assert.equal(w.session.wallet.isLocked(), false); assert.equal(w.session.wallet.lock(), undefined); assert.equal(w.session.wallet.isLocked(), true);
});

test("construction without admission throws admission_required, imports no demosdk and opens no journal", async t => {
const key = mnemonicBytes(); await assert.rejects(api.createNodeWalletSession({key}), refusal('admission_required')); assert.ok(key.every(v => v === 0));
const child=runFreshChild(t,`
 import {writeFileSync} from 'node:fs';import {registerHooks} from 'node:module';
 const api=await import(${JSON.stringify(new URL('../src/wallet/node-wallet-session.mjs',import.meta.url).href)});
 let imports=0,opens=0;registerHooks({resolve(specifier,context,next){if(/demosdk|demos-loader|demos-quiet-hooks/.test(specifier))imports++;return next(specifier,context);}});
 const key=new Uint8Array(JSON.parse(process.argv[2])),journal={get(){opens++;},put(){opens++;},entries(){opens++;},withWalletLock(){opens++;}};
 try{await api.createNodeWalletSession({key,journal});}catch(error){writeFileSync('result.json',JSON.stringify({code:error.message,imports,opens,zero:key.every(v=>v===0)}));}
`,[JSON.stringify([...mnemonicBytes()])]);
assert.equal(child.status,0,child.stderr);assert.deepEqual(child.result,{code:'admission_required',imports:0,opens:0,zero:true});

});

test("options carrying profile, record, identityRecord or actionsAdmitted throw admission_input_untrusted", async t => {
const w = await world(t); for (const name of ['profile','record','identityRecord','actionsAdmitted']) { const key=mnemonicBytes(); await assert.rejects(api.createNodeWalletSession({admission:w.admission,key,[name]:{}}), refusal('admission_input_untrusted')); assert.ok(key.every(v=>v===0)); } assert.equal(w.node.calls.length,0);
});

test("runtime floor refuses v22.12.0 and v23.3.0 before any file opens and admits v22.13.0 and v23.4.0", async t => {
const original = Object.getOwnPropertyDescriptor(process,'version'); t.after(()=>Object.defineProperty(process,'version',original));
const w = await world(t); for (const version of ['v22.12.0','v23.3.0','v22.13.0','v23.4.0']) {
 Object.defineProperty(process,'version',{value:version,configurable:true}); const key=mnemonicBytes();
 const construction = api.createNodeWalletSession({admission:w.admission,owner:w.owner,journal:w.journal(),approve:async()=>true,clock:w.clock,key});
 if(version==='v22.12.0'||version==='v23.3.0')await assert.rejects(construction,refusal('runtime_unsupported'));
 else { const session=await construction;assert.equal(session.wallet.isLocked(),false);await session.close(); }
 assert.ok(key.every(v=>v===0)); }
});

test("a copied binding, another connectionId or a throwing currentLocal refuses before signing", async t => {
const w=await world(t); const { wallet }=w.session;
const current=w.admission.currentLocal; w.admission.currentLocal=()=>{throw new Error('TEST-local');};
// Use a fresh wallet wrapper so the constructor captures each hostile admission.
for(const admission of [{binding:structuredClone(w.admission.binding),currentLocal:current},{binding:w.admission.binding,currentLocal:()=>({...current(),connectionId:'TEST-other'})},{binding:w.admission.binding,currentLocal:w.admission.currentLocal}]) {
 const s=await api.createNodeWalletSession({admission,owner:w.owner,journal:w.journal(),key:mnemonicBytes(),approve:async()=>true,clock:w.clock});
 await assert.rejects(s.wallet.request(w.request),refusal('profile_not_admitted')); s.wallet.lock(); }
assert.equal(w.node.confirms.length,0); assert.equal(wallet.isLocked(),false);
});

test("authority reader stalls past 10,000 ms or rejects E; the refusal keeps its cause and signer calls are 0", async t => {
const w=await world(t); const failure=new Error('TEST-reader'); w.authority.state.failure=failure;
await assert.rejects(w.send(),error=>error.cause===failure); w.authority.state.failure=null;
t.mock.timers.enable({apis:['setTimeout']}); w.authority.state.gate=()=>new Promise(()=>{});
const pending=w.send(); await new Promise(setImmediate); t.mock.timers.tick(10000);
await assert.rejects(pending,error=>error.cause?.code==='tp1_authority_timeout'); assert.equal(w.node.calls.length,0);
});

test("hold flips or currentLocal changes at a barrier inside the binding check; signer 0", async t => {
for (const change of ['hold', 'local']) {
 let current;
 const w = await world(t, {ownerWrap: owner => { current = owner.currentLocal(); return {...owner,currentLocal:()=>current}; }});
 let resolve; w.authority.state.gate=()=>new Promise(r=>{resolve=r;});
 const pending=w.send(); await new Promise(setImmediate);
 if(change==='hold')setPurchaseAdmission('held'); else current={...current,connectionId:'TEST-changed'};
 resolve(); await assert.rejects(pending,refusal('profile_not_admitted')); assert.equal(w.node.calls.length,0);
}
});

test("the key bytes are zero-filled after import and on every construction failure", async t => {
const w=await world(t), copies=[], keyLength=mnemonicBytes().length;
const copy=Uint8Array.from;
t.mock.method(Uint8Array,'from',function(value,...args){const result=Reflect.apply(copy,this,[value,...args]);if(value instanceof Uint8Array && value.length===keyLength)copies.push(result);return result;});
const key=mnemonicBytes(); const s=await api.createNodeWalletSession({admission:w.admission,owner:w.owner,journal:w.journal(),key,approve:async()=>true,clock:w.clock});
assert.ok(key.every(v=>v===0)); s.wallet.lock(); t.after(()=>s.close());
for(const options of [{},{admission:w.admission,owner:{}}]){const key=mnemonicBytes();await assert.rejects(api.createNodeWalletSession({...options,key}));assert.ok(key.every(v=>v===0));}
const {Demos}=await (await import('../src/wallet/node-demos-loading.mjs')).loadNodeDemos();
const failure=new Error('TEST-connect-import-failed');t.mock.method(Demos.prototype,'connectWallet',async()=>{throw failure;});
const failedKey=mnemonicBytes();await assert.rejects(api.createNodeWalletSession({admission:w.admission,owner:w.owner,journal:w.journal(),key:failedKey,clock:w.clock}),error=>error===failure);
assert.ok(failedKey.every(v=>v===0));assert.ok(copies.length>=3);for(const bytes of copies)assert.ok(bytes.every(v=>v===0));
});

test("an invalid mnemonic refuses invalid_mnemonic before connectWallet is called and every key byte copy is zero-filled", async t => {
const w=await world(t);const {Demos}=await (await import('../src/wallet/node-demos-loading.mjs')).loadNodeDemos();let connects=0;t.mock.method(Demos.prototype,'connectWallet',async()=>{connects++;throw new Error('TEST-invalid-connect');}); for (const key of [new TextEncoder().encode('TEST invalid mnemonic'),Uint8Array.of(255)]) { await assert.rejects(api.createNodeWalletSession({admission:w.admission,owner:w.owner,journal:w.journal(),key,clock:w.clock}),refusal('invalid_mnemonic')); assert.ok(key.every(v=>v===0)); assert.equal(w.node.calls.length,0);assert.equal(connects,0); }
});

test("an http endpoint, an endpoint with a path or credentials, or a non-canonical origin is refused by the owner", async () => {
for(const endpoint of ['http://rpc.invalid/','https://rpc.invalid/path','https://user:pass@rpc.invalid/','https://RPC.invalid/','https://rpc.invalid','https://rpc.invalid/?q=1']) assert.throws(()=>api.createNodeTransportOwner({endpoint,transportAuthority:'vector-authority',fetchImpl:()=>{}}));
});

test('owner fences queue, release once and reject waiters after close; fetch stays at the bound origin', async () => {
 const calls=[]; const owner=api.createNodeTransportOwner({endpoint:'https://rpc.example.invalid/',transportAuthority:'vector-authority',fetchImpl:(url,init)=>calls.push({url,init})});
 const first=await owner.acquireConnectionFence({address:'TEST-first'}); let acquired=false;
 const second=owner.acquireConnectionFence({address:'TEST-second'}).then(lease=>{acquired=true;return lease;});
 await new Promise(setImmediate); assert.equal(acquired,false); first.release(); first.release(); const lease=await second;
 assert.deepEqual(lease.context,owner.getContext()); owner.fetchImpl(owner.local.endpoint,{redirect:'follow'});assert.equal(calls[0].init.redirect,'error');
 assert.throws(()=>owner.fetchImpl('https://other.invalid/',{}),refusal('transport_mismatch')); for(const transportAuthority of ['', 'vector-authority\n', 'x'.repeat(161)]) assert.throws(()=>api.createNodeTransportOwner({endpoint:owner.local.endpoint,transportAuthority}),refusal('transport_mismatch')); const third=owner.acquireConnectionFence(); owner.close();
 await assert.rejects(third,refusal('transport_closed')); assert.throws(()=>owner.currentLocal(),refusal('transport_closed')); lease.release();
});
test('walletFactory stays synchronous, shares the identity and hold, and uses the selected anchor journal', async t => {
 const w=await world(t);const selected=[];const journal={...w.journal(),get:async k=>{selected.push(k);return w.journal().get(k);}};
 const wallet=w.session.walletFactory({anchorJournal:journal});assert.equal(wallet instanceof Promise,false);assert.deepEqual(wallet.getPublicAccount(),w.session.wallet.getPublicAccount());
 const {agreementRequest}=await import('./helpers/tp1-node-fixture.mjs');w.node.mode='drop';await wallet.request(await agreementRequest(w));assert.ok(selected.length>0);const reads=selected.length;
 setPurchaseAdmission('held');await assert.rejects(wallet.request(w.request),refusal('profile_not_admitted'));assert.equal(selected.length,reads);
 wallet.lock();assert.equal(w.session.wallet.isLocked(),true);
});

test('a failed SDK load zeroes key before any wallet or journal is constructed', async t => {
 const child=runFreshChild(t,`
  import {writeFileSync} from 'node:fs';
  import {registerHooks} from 'node:module';
  const api=await import(${JSON.stringify(new URL('../src/wallet/node-wallet-session.mjs',import.meta.url).href)});
  const failure=new Error('TEST-load-refused');
  registerHooks({resolve(specifier,context,next){if(specifier==='@kynesyslabs/demosdk/websdk')throw failure;return next(specifier,context);}});
  const key=new Uint8Array(JSON.parse(process.argv[2]));let opens=0;
  const journal={get(){opens++;},put(){opens++;},withWalletLock(){opens++;},entries(){opens++;}};
  try{await api.createNodeWalletSession({admission:{binding:{},currentLocal:()=>({})},journal,key});}
  catch(error){writeFileSync('result.json',JSON.stringify({same:error===failure,zero:key.every(v=>v===0),opens}));}
 `,[JSON.stringify([...mnemonicBytes()])]);
 assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'');assert.equal(child.stderr,'');assert.deepEqual(child.result,{same:true,zero:true,opens:0});
});

test('construction snapshots admission and the consumed key before its first await and for later wallet views', async t => {
 const w=await world(t),key=mnemonicBytes(),replacement=mnemonicBytes();
 const options={admission:w.admission,owner:w.owner,journal:w.journal(),key,approve:async()=>true,clock:w.clock};
 const pending=api.createNodeWalletSession(options);options.key=replacement;
 options.admission={binding:structuredClone(w.admission.binding),currentLocal:w.admission.currentLocal};
 const session=await pending;t.after(()=>session.close());assert.ok(key.every(value=>value===0));
 const wallet=session.walletFactory({anchorJournal:w.journal()});
 assert.equal((await wallet.request({method:'sign',params:['TEST-snapshot']})).success,true);
 assert.ok(replacement.some(value=>value!==0),'the replacement buffer was not consumed');replacement.fill(0);
});

test("the delta map records the transport owner's port source and every edited line of sdk-provider.mjs, util/http.mjs and network-binding.mjs", async () => {
const { ledger, locations } = await import('../scripts/delta-map.mjs');
const map = readFileSync(new URL('../DELTA-MAP.md', import.meta.url), 'utf8');
assert.match(map, /frontend `d6f0e16` `http-mcp\/src\/devnet-demo\/operator-network\.mjs:197-224`/);
const record = ledger().changes.find(change => change.subject.startsWith('delta(client): WF P21a1bb '));
for (const name of ['public/portal/embedded-wallet/sdk-provider.mjs', 'util/http.mjs', 'dacs/network-binding.mjs']) {
  const path = `packages/dacs-client/src/${name}`;
  assert.ok(record.files.some(file => file.path === path && file.before !== file.after), `${path} has a P21a1bb delta record`);
  assert.ok(map.includes(locations(path)), `${path}: the map lists every edited line`);
}
});

const TRANSACTION_SHAPED_HASH = 'ab'.repeat(32);
const generalSign = (w, message) => w.session.wallet.request({ method: 'sign', params: [message] });
const assertMismatch = result => { assert.equal(result.success, false, JSON.stringify(result)); assert.equal(result.error.code, 'payload_mismatch'); };

test('admitted, a general sign request for the hash of a sent transaction is refused payload_mismatch and returns no signature', async t => {
  const w = await world(t);
  assert.equal((await w.send()).success, true);
  const sent = w.node.broadcasts[0];
  const result = await generalSign(w, sent.hash);
  assertMismatch(result);
  assert.equal(result.data, null);
});

test('admitted, a general sign request for a bare 64-hex string is refused payload_mismatch', async t => {
  assertMismatch(await generalSign(await world(t), TRANSACTION_SHAPED_HASH));
});

test('admitted, a general sign request for a domain-prefixed transaction hash is refused payload_mismatch', async t => {
  assertMismatch(await generalSign(await world(t), `demos-tx:v1:7:${TRANSACTION_SHAPED_HASH}`));
});

test('admitted, a general sign request for ordinary text still returns an ed25519 signature', async t => {
  const result = await generalSign(await world(t), 'hello from the host');
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.type, 'ed25519');
  assert.match(result.data.signature, /^[0-9a-f]{128}$/);
});

test('admitted, authenticated node requests are still signed after the sign guard', async t => {
  const w = await world(t);
  assert.equal((await w.send()).success, true);
  const authenticated = w.node.calls.filter(call => call.headers.signature);
  assert.ok(authenticated.length > 0, 'the send makes authenticated node calls');
  for (const call of authenticated) assert.match(call.headers.signature, /^(?:0x)?[0-9a-f]{128}$/);
});
