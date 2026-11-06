import test from 'node:test';
import assert from 'node:assert/strict';
import { world, ok, agreementRequest } from './helpers/tp1-node-fixture.mjs';
import { installNoEgress } from './helpers/no-egress.mjs';
import { causeChain, spiedWorld } from './helpers/node-wallet-signing-spy.mjs';
import { EmbeddedWalletError } from '../src/public/portal/embedded-wallet/sdk-provider.mjs';
import { OutboundError } from '../src/util/http.mjs';

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

const JSON_TYPE = { 'content-type': 'application/json' };
const answerWith = (body, init = {}) => new Response(body, { headers: JSON_TYPE, ...init });
const streamedOf = bytes => answerWith(new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }));
const onMessage = (w, message, respond) => { w.node.intercept = row => (row.body.params[0].message === message ? respond(row) : undefined); };
const onConfirm = (w, respond) => { w.node.intercept = row => (row.body.params[0].extra === 'confirmTx' ? respond(row.body.params[0].data) : undefined); };
const confirmAnswer = (tx, tamper = data => data) => answerWith(JSON.stringify(ok({ data: tamper({ valid: true, message: '', gas_operation: null, transaction: tx }) })));
const causedBy = (result, w) => causeChain(w.session.internalCauseOf(result));

test("malformed JSON, invalid UTF-8 and an over-long list are refused before use with the cause kept", async t => {
const overLong = () => streamedOf(new TextEncoder().encode(JSON.stringify(ok({ ordered_transactions: Array.from({ length: 140_000 }, () => 'a'.repeat(30)) }))));
const cases = [['malformed JSON', () => answerWith('{not json'), e => e.code === 'INVALID-JSON'],
  ['invalid UTF-8', () => streamedOf(Uint8Array.of(0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d)), e => e.code === 'INVALID-UTF8'],
  ['over-long list', overLong, e => e instanceof OutboundError && e.message === 'response exceeds byte limit']];
for (const [name, respond, original] of cases) {
  const w = await world(t); onMessage(w, 'getAddressNonce', respond);
  const result = await w.send();
  assert.equal(result.error.code, 'upstream_unavailable', name + JSON.stringify(result)); assert.equal(w.node.broadcasts.length, 0, name);
  assert.ok(causedBy(result, w).some(original), name + ': original error kept as internal cause');
}
});

test("through the real seam, a timeout, malformed JSON, invalid UTF-8, an oversized reply, a validated valid:false confirmation and a dropped acknowledgement each keep their original error as internal cause and map to their own public class", async t => {
const timeout = async w => {
  const stop = new AbortController(), mocked = t.mock.method(AbortSignal, 'timeout', () => stop.signal);
  let started; const waiting = new Promise(resolve => { started = resolve; });
  onMessage(w, 'getAddressNonce', () => { started(); return new Promise(() => {}); });
  const pending = w.send(); await waiting; stop.abort(new DOMException('TEST-deadline', 'TimeoutError'));
  try { return await pending; } finally { mocked.mock.restore(); }
};
const cases = [
  ['timeout', 'upstream_unavailable', timeout, e => e.name === 'TimeoutError' && e.message === 'TEST-deadline'],
  ['malformed JSON', 'upstream_unavailable', w => { onMessage(w, 'getAddressNonce', () => answerWith('{not json')); return w.send(); }, e => e.code === 'INVALID-JSON'],
  ['invalid UTF-8', 'upstream_unavailable', w => { onMessage(w, 'getAddressNonce', () => streamedOf(Uint8Array.of(0xff))); return w.send(); }, e => e.code === 'INVALID-UTF8'],
  ['oversized reply', 'upstream_unavailable', w => { onMessage(w, 'getAddressNonce', () => streamedOf(new Uint8Array(4 * 1024 * 1024 + 1))); return w.send(); }, e => e.message === 'response exceeds byte limit'],
  ['valid:false confirmation', 'confirm_rejected', w => { w.node.mode = 'confirm-refuse'; return w.send(); }, e => /^\[Confirm\]/.test(e.message)],
  ['dropped acknowledgement', 'outcome_unknown', w => { w.node.mode = 'drop'; return w.send(); }, e => e.message === 'TEST-acknowledgement-lost']];
for (const [name, code, run, original] of cases) {
  const w = await world(t); const result = await run(w);
  assert.equal(result.error.code, code, name + JSON.stringify(result));
  assert.ok(causedBy(result, w).some(original), name + ': original error kept as internal cause');
}
});

test("overlapping calls failing with different sentinel errors each keep their own cause; no sentinel text reaches the public envelope, stdout or stderr", async t => {
const written = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write;
  t.mock.method(stream, 'write', function recordWrite(chunk, ...rest) { written.push(String(chunk)); return Reflect.apply(write, stream, [chunk, ...rest]); });
}
const sentinels = [new Error('TEST-overlap-cause-one'), new Error('TEST-overlap-cause-two')];
const [first, second] = [await world(t), await world(t)];
onMessage(first, 'getAddressNonce', () => { throw sentinels[0]; }); onMessage(second, 'getNetworkParameters', () => { throw sentinels[1]; });
const results = await Promise.all([first.send(), second.send()]);
[first, second].forEach((w, i) => {
  assert.equal(results[i].error.code, 'upstream_unavailable', JSON.stringify(results[i])); const chain = causedBy(results[i], w);
  assert.ok(chain.includes(sentinels[i]), 'own sentinel kept'); assert.ok(!chain.includes(sentinels[1 - i]), "the other call's sentinel is not attached");
});
assert.ok(!JSON.stringify(results).includes('TEST-overlap-cause')); assert.ok(!written.join('').includes('TEST-overlap-cause'));
});

test("an interrupted streamed body, a binder context or block-read failure, and a broadcast failure the SDK returns as result-500 each keep the original error object as internal cause, also for two overlapping calls", async t => {
const sentinels = ['body', 'context', 'block', 'broadcast'].map(name => new Error('TEST-cause-' + name));
let failContext = null;
const contextFault = owner => ({ ...owner, getContext: () => { if (failContext) throw failContext; return owner.getContext(); } });
const worlds = [await world(t), await world(t, { ownerWrap: contextFault }), await world(t), await world(t)];
const [body, , block, broadcast] = worlds;
onMessage(body, 'getAddressNonce', () => answerWith(new ReadableStream({ start(c) { c.error(sentinels[0]); } })));
onMessage(block, 'getBlockByNumber', () => { throw sentinels[2]; });
broadcast.node.intercept = row => { if (row.body.params[0].extra === 'broadcastTx') throw sentinels[3]; };
failContext = sentinels[1];
const results = await Promise.all(worlds.map(w => w.send()));
failContext = null;
worlds.forEach((w, i) => {
  assert.equal(results[i].success, false, JSON.stringify(results[i])); const chain = causedBy(results[i], w);
  assert.ok(chain.includes(sentinels[i]), `sentinel ${i} kept as the same object`);
  sentinels.forEach((other, j) => { if (j !== i) assert.ok(!chain.includes(other), `sentinel ${j} not attached to call ${i}`); });
});
assert.equal(results[3].error.code, 'outcome_unknown'); assert.equal(broadcast.node.broadcasts.length, 0);
});

test("a malformed, non-200 or unavailable confirmation answer is upstream_unavailable with its cause and nothing is broadcast; only a validated valid:false is confirm_rejected", async t => {
const confirmReturning = (result, response) => w => t.mock.method(w.nodeDemosPrototype, 'confirm', async () => ({ result, response }));
const cases = [
  ['malformed data', 'upstream_unavailable', w => onConfirm(w, () => answerWith(JSON.stringify(ok({ data: { valid: 'yes' } }))))],
  ['non-200 result', 'upstream_unavailable', w => onConfirm(w, () => answerWith(JSON.stringify({ result: 400, response: 'TEST-bad' })))],
  ['unavailable node', 'upstream_unavailable', w => onConfirm(w, () => answerWith('TEST-down', { status: 503 }))],
  ['valid:true without a transaction hash', 'upstream_unavailable', confirmReturning(200, { data: { valid: true, transaction: { hash: 'not-a-hash' } } })],
  ['result 500 from the SDK', 'upstream_unavailable', confirmReturning(500, new Error('TEST-sdk-500'))],
  ['validated valid:false', 'confirm_rejected', w => { w.node.mode = 'confirm-refuse'; }]];
for (const [name, code, arrange] of cases) {
  const w = await spiedWorld(t); arrange(w); const result = await w.send();
  assert.equal(result.error.code, code, name + JSON.stringify(result)); assert.equal(w.node.broadcasts.length, 0, name);
  assert.ok(causedBy(result, w).length > 1, name + ': cause kept');
}
});

test("with no confirmed-write callback installed, a valid:true native confirmation with the exact transaction bytes and malformed gas_operation.fees or a non-null custom_charges is upstream_unavailable with its cause and zero broadcasts, never confirm_rejected", async t => {
const tampers = [data => ({ ...data, gas_operation: { fees: { network_fee: 'bad', rpc_fee: 0, additional_fee: 0 } } }), data => ({ ...data, custom_charges: { burn: 1 } })];
for (const tamper of tampers) {
  const w = await world(t); onConfirm(w, tx => confirmAnswer(tx, tamper)); const result = await w.send();
  assert.equal(result.error.code, 'upstream_unavailable', JSON.stringify(result)); assert.equal(w.node.broadcasts.length, 0);
  assert.ok(causedBy(result, w).some(e => /approved send/.test(e.message)), 'the failed check is named');
}
});

test("with no confirmed-write callback installed, a valid:true storage confirmation with the exact transaction and malformed gas fields, or a denomination change during confirmation, is upstream_unavailable with its cause and zero broadcasts", async t => {
const gasFault = w => onConfirm(w, tx => confirmAnswer(tx, data => ({ ...data, gas_operation: { fees: { network_fee: 'bad', rpc_fee: 0, additional_fee: 0 } } })));
const denominationFault = w => {
  let confirmed = false;
  w.node.intercept = row => {
    if (row.body.params[0].extra === 'confirmTx') confirmed = true;
    if (confirmed && row.body.params[0].message === 'getNetworkInfo') return answerWith(JSON.stringify(ok({ forks: { osDenomination: { activated: false } } })));
  };
};
for (const arrange of [gasFault, denominationFault]) {
  const w = await world(t); arrange(w); const result = await w.session.wallet.request(await agreementRequest(w));
  assert.equal(result.error.code, 'upstream_unavailable', JSON.stringify(result)); assert.equal(w.node.broadcasts.length, 0);
  assert.ok(causedBy(result, w).length > 1, 'the failed check is kept as the cause');
}
});

test("a valid:true answer whose transaction bytes changed is refused at the transport as signed_bytes_changed and reaches the caller as upstream_unavailable", async t => {
const w = await world(t); onConfirm(w, tx => confirmAnswer({ ...tx, status: 'TEST-changed' })); const result = await w.send();
assert.equal(result.error.code, 'upstream_unavailable', JSON.stringify(result)); assert.equal(w.node.broadcasts.length, 0);
assert.ok(causedBy(result, w).some(e => e.code === 'signed_bytes_changed'));
});

test("an EmbeddedWalletError thrown inside demos.sign reaches the caller with its own code and cause; any other signing error is sdk_error with the original error as cause", async t => {
const { Demos } = await (await import('../src/wallet/node-demos-loading.mjs')).loadNodeDemos();
const refusalCause = new Error('TEST-gate-cause'), failure = new Error('TEST-sign-failure');
const w = await world(t);
t.mock.method(Demos.prototype, 'sign', async () => { throw new EmbeddedWalletError('payload_mismatch', 'TEST-gate-refusal', { cause: refusalCause }); });
const gated = await w.send(); assert.equal(gated.error.code, 'payload_mismatch', JSON.stringify(gated)); assert.ok(causedBy(gated, w).includes(refusalCause));
Demos.prototype.sign.mock.mockImplementation(async () => { throw failure; });
const other = await w.send(); assert.equal(other.error.code, 'sdk_error', JSON.stringify(other)); assert.ok(causedBy(other, w).includes(failure));
assert.equal(w.node.confirms.length, 0);
});
