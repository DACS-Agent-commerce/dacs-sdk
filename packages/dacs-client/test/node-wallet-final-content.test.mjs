import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ok, agreementRequest } from './helpers/tp1-node-fixture.mjs';
import { spiedWorld } from './helpers/node-wallet-signing-spy.mjs';

const answerWith = value => new Response(JSON.stringify(ok(value)), { headers: { 'content-type': 'application/json' } });
const utf8 = text => new TextEncoder().encode(text);
const sdkMessage = (w, message, respond) => { w.node.intercept = row => (row.body.params[0].message === message ? respond(row) : undefined); };
const approvedFeeThenChanged = (w, changed) => { let reads = 0; sdkMessage(w, 'getNetworkParameters', () => (++reads > 1 ? answerWith({ networkFee: 1, rpcFee: 0, additionalFee: 0, ...changed }) : undefined)); };
const forkReadFailsAfter = (w, approvedReads) => { let reads = 0; sdkMessage(w, 'getNetworkInfo', () => { if (++reads > approvedReads) throw new Error('TEST-fork-read-failed'); }); };
const nativeSend = w => w.send();
const anchorSend = async w => w.session.wallet.request(await agreementRequest(w));
const captureFinalContent = (t, w) => {
  const captured = [], original = w.nodeDemosPrototype.sign;
  t.mock.method(w.nodeDemosPrototype, 'sign', async function captureSign(rawTx, options) {
    const signed = await Reflect.apply(original, this, [rawTx, options]);
    captured.push({ finalContent: options.finalContent, content: signed.content });
    return signed;
  });
  return captured;
};

test("the node answers a different network or RPC fee after approval: the native send and the storage anchor refuse payload_mismatch before the inner signature, with inner signatures 0", async t => {
for (const send of [nativeSend, anchorSend]) for (const changed of [{ networkFee: 60 }, { rpcFee: 1 }]) {
  const w = await spiedWorld(t); approvedFeeThenChanged(w, changed);
  const request = send === anchorSend ? await agreementRequest(w) : w.request;
  const result = await w.session.wallet.request(request);
  assert.equal(result.error?.code, 'payload_mismatch', JSON.stringify(result)); assert.equal(w.signsInsideSign, 0, 'no inner signature'); assert.equal(w.node.confirms.length, 0);
}
});

test("a fork-status read failing during signing changes the serialized denomination: refused before the inner signature, with inner signatures 0", async t => {
for (const [send, approvedForkReads] of [[nativeSend, 0], [anchorSend, 2]]) {
  const w = await spiedWorld(t); forkReadFailsAfter(w, approvedForkReads);
  const request = send === anchorSend ? await agreementRequest(w) : w.request;
  const result = await w.session.wallet.request(request);
  assert.equal(result.success, false, JSON.stringify(result)); assert.equal(result.error.code, 'payload_mismatch', JSON.stringify(result));
  assert.equal(w.signsInsideSign, 0, 'no inner signature'); assert.equal(w.node.confirms.length, 0);
}
});

test("the signed message is the finalized hash and the hash is sha256 of JSON(content); a transaction object replaced inside sign refuses; RPC-authentication signatures outside the sign scope pass through", async t => {
const { Demos } = await (await import('../src/wallet/node-demos-loading.mjs')).loadNodeDemos();
const w = await spiedWorld(t);
const sent = await w.send(); assert.equal(sent.success, true, JSON.stringify(sent)); assert.equal(w.signsInsideSign, 1);
const finalized = w.node.broadcasts[0];
assert.equal(createHash('sha256').update(JSON.stringify(finalized.content)).digest('hex'), finalized.hash);
assert.ok(w.innerSigns.some(message => Buffer.from(message).equals(utf8(finalized.hash))), 'the inner signature covers the finalized hash');
assert.ok(w.innerSigns.length >= 3, 'the RPC-authentication signatures outside the sign scope passed through');
const original = Demos.prototype.sign;
const refusals = {
  'a transaction object replaced inside sign': function replaced(rawTx, options) { return Reflect.apply(original, this, [structuredClone(rawTx), options]); },
  'a message that is not the transaction hash': async function otherMessage(rawTx) { rawTx.hash = createHash('sha256').update(JSON.stringify(rawTx.content)).digest('hex'); return this.crypto.sign('ed25519', utf8('TEST-other-message')); },
  'a hash that is not the sha256 of the content': async function otherHash(rawTx) { rawTx.hash = 'c'.repeat(64); return this.crypto.sign('ed25519', utf8(rawTx.hash)); },
};
t.mock.method(Demos.prototype, 'sign', refusals['a transaction object replaced inside sign']);
for (const [name, implementation] of Object.entries(refusals)) {
  Demos.prototype.sign.mock.mockImplementation(implementation);
  const refused = await spiedWorld(t), result = await refused.send();
  assert.equal(result.error?.code, 'payload_mismatch', name + JSON.stringify(result));
  assert.equal(refused.signsInsideSign, 0, name + ': no inner signature inside sign');
}
});

test("native finalContent validates the separately approved amount and returns totalDebitOs including price and feeDebitOs excluding price; anchor finalContent includes storage, gas and node fees and returns equal total and fee components", async t => {
const native = await spiedWorld(t), nativeCaptured = captureFinalContent(t, native);
assert.equal((await native.send()).success, true);
const { finalContent, content } = nativeCaptured[0];
assert.deepEqual(finalContent(content), { totalDebitOs: '4500000000', feeDebitOs: '2000000000' });
for (const changed of [{ ...content, nonce: content.nonce + 1 }, { ...content, amount: '2500000001' }, { ...content, custom_charges: { burn: 1 } }, { ...content, gcr_edits: content.gcr_edits.slice(1) }]) {
  assert.throws(() => finalContent(changed), error => error.code === 'payload_mismatch');
}
const anchor = await spiedWorld(t), anchorCaptured = captureFinalContent(t, anchor);
const result = await anchorSend(anchor); assert.equal(result.success, true, JSON.stringify(result));
const anchored = anchorCaptured[0], storageFeeOs = BigInt(anchored.content.gcr_edits[0].amount), expected = (storageFeeOs + 2_000_000_000n).toString();
assert.deepEqual(anchored.finalContent(anchored.content), { totalDebitOs: expected, feeDebitOs: expected });
assert.throws(() => anchored.finalContent({ ...anchored.content, to: 'stor-' + '0'.repeat(40) }), error => error.code === 'payload_mismatch');
});
