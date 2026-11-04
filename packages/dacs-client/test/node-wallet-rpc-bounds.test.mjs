import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { api, world, mnemonicBytes, setPurchaseAdmission, T0, ok } from './helpers/tp1-node-fixture.mjs';
const refusal = code => error => error.code === code || error.message === code;
import { installNoEgress } from './helpers/no-egress.mjs';

test("through the SDK path, a 4 MiB block reply is admitted and 4 MiB plus one byte is refused before decode, declared and streamed", async t => {
for(const declared of [true,false])for(const extra of [0,1]) { const w=await world(t);
w.node.intercept=async row=>{if(row.body.params[0].message!=='getBlockByNumber')return; const text=JSON.stringify(ok({number:0,status:'confirmed',hash:w.admission.binding.profile.chainIdentity,content:{}})); const body=text+' '.repeat(4*1024*1024+extra-Buffer.byteLength(text));
return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(body));c.close();}}),{headers:{'content-type':'application/json',...(declared?{'content-length':String(Buffer.byteLength(body))}:{})}});};
const result=await w.send(); assert.equal(result.success,extra===0,JSON.stringify(result)); if(extra)assert.equal(w.node.confirms.length,0); }
});

test("a node that never answers ends upstream_unavailable within the transport deadline with no broadcast", async t => {
const w=await world(t);let started;const waiting=new Promise(resolve=>{started=resolve;});
w.node.intercept=row=>{if(row.body.params[0].message==='getAddressNonce'){started();return new Promise(()=>{});}};
const timeout=new AbortController();t.mock.method(AbortSignal,'timeout',()=>timeout.signal);
const pending=w.send();await waiting;timeout.abort(new DOMException('TEST-deadline','TimeoutError'));
const result=await pending;assert.equal(result.error.code,'upstream_unavailable',JSON.stringify(result));assert.equal(w.node.broadcasts.length,0);
});

test("no socket or DNS lookup leaves the process; every SDK post reaches the transport in process", async t => {
const guard=installNoEgress(); t.after(()=>guard.restore()); const w=await world(t); assert.equal((await w.send()).success,true); assert.equal(guard.attempts.length,0); assert.ok(w.node.calls.length>0);
});

test("a 503 on broadcastTx reaches the node exactly once; the session reports outcome_unknown and the lane is readback-only", async t => {
const w=await world(t); w.node.mode='503'; const result=await w.send(); assert.equal(result.error.code,'outcome_unknown',JSON.stringify(result)); assert.equal(w.node.broadcasts.length,1); await w.send(); assert.equal(w.node.broadcasts.length,1);
});
