import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createWorld, NOW, JOB_IDS } from './helpers/native-create-world.mjs';
import { api, world, T0 } from './helpers/tp1-node-fixture.mjs';

test("two requests in the same millisecond get strictly increasing stamps and both are accepted", async t => {
const stamps=api.createRpcStampSource({now:()=>T0}); assert.equal(stamps.next('TEST-wallet'),T0); assert.equal(stamps.next('TEST-wallet'),T0+1); const w=await world(t); assert.equal((await w.send()).success,true); const values=w.node.calls.filter(row=>row.headers.identity?.startsWith('ed25519:')).map(row=>Number(row.headers.timestamp)); assert.ok(values.length>=2); for(let i=1;i<values.length;i++)assert.ok(values[i]>values[i-1]);
});

test("a backward clock step never yields a stamp at or below the last one used", async () => {
let now=T0; const stamps=api.createRpcStampSource({now:()=>now}); const first=stamps.next('TEST-wallet'); now-=1000; assert.equal(stamps.next('TEST-wallet'),first+1);
});

test("overlapping authenticated requests on one wallet authorize no duplicate write", async t => {
const w=await world(t); await Promise.all([w.send(),w.send()]); assert.equal(w.node.broadcasts.length,1); const values=w.node.calls.filter(row=>row.headers.identity?.startsWith('ed25519:')).map(row=>row.headers.timestamp); assert.equal(new Set(values).size,values.length);
});

test("wallet_auth_replayed or wallet_auth_stale on a broadcast means that call sent nothing, while an earlier dispatched send stays unknown", async t => {
for(const mode of ['auth-refuse','auth-stale']) { const w=await world(t); w.node.mode=mode; const result=await w.send(); assert.equal(result.success,false);assert.equal(w.node.applied.size,0); assert.equal((await w.lane()).stage,'broadcast-answered'); await w.restart(); await w.send(); assert.equal(w.node.broadcasts.length,1); }
});

test("a transport recovery stamp comes from the session's sequencer, so it is above the stamp the session just used and the recovery is not refused for a collision", async t => {
const stamps=api.createRpcStampSource({now:()=>NOW}), sessionWorld=await world(t); const w=createWorld({journal:sessionWorld.journal(),stamps});t.after(()=>w.capability.close());
const tx=await w.makeCreate(JOB_IDS[0],1);await w.retain(tx,'broadcast-accepted');
const identity=`ed25519:${w.wallet.address}`,timestamp=String(stamps.next(identity));
const signature=w.wallet.signText(createHash('sha256').update(`${identity}:${timestamp}`).digest('hex'));
await w.capability.walletBinding({phase:'bind',address:w.wallet.address},{identity,timestamp,signature});
const messages=[]; await w.capability.recoverStorageWrite({signedTransaction:tx,signRpc:async message=>{messages.push(message);return w.wallet.signHex(message);}});
assert.equal(messages[0],createHash('sha256').update(`${identity}:${NOW+1}`).digest('hex'),'the recovery stamp is the sequencer\'s next one');
assert.deepEqual(w.sent.confirms,[tx.hash],'the recovery authenticated and reached the confirmation');
});

test("a transport recovery stamp colliding with a session stamp ends pending with noResend and no second send", async t => {
const sessionWorld=await world(t); const w=createWorld({journal:sessionWorld.journal()});t.after(()=>w.capability.close());
const tx=await w.makeCreate(JOB_IDS[0],1);await w.retain(tx,'broadcast-accepted');
const identity=`ed25519:${w.wallet.address}`,stamps=api.createRpcStampSource({now:()=>NOW}),timestamp=String(stamps.next(identity));
const signature=w.wallet.signText(createHash('sha256').update(`${identity}:${timestamp}`).digest('hex'));
await w.capability.walletBinding({phase:'bind',address:w.wallet.address},{identity,timestamp,signature});
let signed=0; const result=await w.capability.recoverStorageWrite({signedTransaction:tx,signRpc:async message=>{signed++;return w.wallet.signHex(message);}});
assert.equal(signed,1,'recovery attempted authentication at the colliding clock tick');assert.deepEqual(result,{disposition:'pending',hash:tx.hash,noResend:true});assert.deepEqual(w.sent,{confirms:[],broadcasts:[]});
});
