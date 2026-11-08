import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ok, agreementRequest, T0 } from './helpers/tp1-node-fixture.mjs';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
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
for (const [send, approvedForkReads] of [[nativeSend, 1], [anchorSend, 2]]) {
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

const loadDemos = async () => (await (await import('../src/wallet/node-demos-loading.mjs')).loadNodeDemos()).Demos;
// What demosdk 4.0.18 signs once the node's signatureDomain fork is active, made on top of the installed SDK's own finalization.
const signingPreimage = (original, preimage) => function signUnderPreimage(rawTx, options) {
  const outer = this;
  const preimageCrypto = new Proxy(outer.crypto, { get: (target, key) => (key === 'sign' ? (algorithm, hashBytes) => target.sign(algorithm, utf8(preimage(Buffer.from(hashBytes).toString('utf8')))) : Reflect.get(target, key)) });
  const shadow = Object.create(outer, { crypto: { value: preimageCrypto } });
  return Reflect.apply(original, shadow, [rawTx, options]);
};

test("a signed message in the signatureDomain form of an active fork is accepted for the exact hash, native and anchor; another hash, version, field or chain id refuses with inner signatures 0", async t => {
const Demos = await loadDemos(), original = Demos.prototype.sign, otherHash = 'c'.repeat(64);
t.mock.method(Demos.prototype, 'sign', signingPreimage(original, hash => hash));
const refused = {
  'another hash': () => `demos-tx:v1:7:${otherHash}`, 'an empty chain id': hash => `demos-tx:v1::${hash}`, 'a non-decimal chain id': hash => `demos-tx:v1:x7:${hash}`,
  'a negative chain id': hash => `demos-tx:v1:-7:${hash}`, 'another version': hash => `demos-tx:v2:7:${hash}`, 'two chain id fields': hash => `demos-tx:v1:7:8:${hash}`,
  'a trailing byte': hash => `demos-tx:v1:7:${hash}0`, 'a leading byte': hash => ` demos-tx:v1:7:${hash}`, 'no hash': () => 'demos-tx:v1:7:',
};
for (const send of [nativeSend, anchorSend]) {
  const w = await spiedWorld(t), request = send === anchorSend ? await agreementRequest(w) : w.request;
  for (const [name, preimage] of Object.entries(refused)) {
    Demos.prototype.sign.mock.mockImplementation(signingPreimage(original, preimage));
    const result = await w.session.wallet.request(request);
    assert.equal(result.error?.code, 'payload_mismatch', name + JSON.stringify(result)); assert.equal(w.signsInsideSign, 0, name + ': no inner signature');
  }
  Demos.prototype.sign.mock.mockImplementation(signingPreimage(original, hash => `demos-tx:v1:7:${hash}`));
  await w.session.wallet.request(request);
  assert.equal(w.signsInsideSign, 1, 'the exact domain-separated hash is signed');
  assert.ok(w.innerSigns.some(message => /^demos-tx:v1:7:[0-9a-f]{64}$/.test(Buffer.from(message).toString('utf8'))), 'the inner signature covers the domain-separated preimage');
}
});

test("a finalContent answer that is not two canonical OS amount strings refuses payload_mismatch before the inner signature", async t => {
const answers = {
  numbers: { totalDebitOs: 5, feeDebitOs: 1 }, arrays: { totalDebitOs: ['5'], feeDebitOs: ['1'] }, 'a leading zero': { totalDebitOs: '007', feeDebitOs: '1' },
  'a negative amount': { totalDebitOs: '-5', feeDebitOs: '1' }, 'an empty amount': { totalDebitOs: '', feeDebitOs: '1' }, 'a missing fee': { totalDebitOs: '5' }, 'no answer': undefined,
};
for (const [name, answer] of Object.entries(answers)) {
  const w = await spiedWorld(t), sign = w.nodeDemosPrototype.sign;
  t.mock.method(w.nodeDemosPrototype, 'sign', function substituteFinalContent(rawTx, options) { return Reflect.apply(sign, this, [rawTx, { ...options, finalContent: () => answer }]); });
  const result = await w.send();
  assert.equal(result.error?.code, 'payload_mismatch', name + JSON.stringify(result)); assert.equal(w.signsInsideSign, 0, name + ': no inner signature');
}
});

const wholeDemSend = w => w.session.wallet.request({ method: 'sendTransaction', params: [buildNativeTransferPayload({ from: w.session.wallet.getPublicAccount().address, to: '0x' + '2'.repeat(64), amountOs: '3000000000', nonce: 1, timestamp: T0, encoding: 'os-string' })] });
const forkReadFlipsAfter = (w, approvedReads) => { let reads = 0; sdkMessage(w, 'getNetworkInfo', () => (++reads > approvedReads ? answerWith({ forks: { osDenomination: { activated: false } } }) : undefined)); };

test("a whole-DEM native send is refused before the inner signature when the denomination read after approval fails or flips", async t => {
for (const [name, change] of [['fails', forkReadFailsAfter], ['flips to pre-fork', forkReadFlipsAfter]]) {
  const w = await spiedWorld(t); change(w, 1);
  const result = await wholeDemSend(w);
  assert.equal(result.error?.code, 'payload_mismatch', name + JSON.stringify(result)); assert.equal(w.signsInsideSign, 0, name + ': no inner signature'); assert.equal(w.node.confirms.length, 0);
}
});

test("a native signature made without the pre-signature check, as the browser SDK does, is refused after signing when its denomination is not the approved one", async t => {
const Demos = await loadDemos(), w = await spiedWorld(t); forkReadFailsAfter(w, 1);
t.mock.method(w.nodeDemosPrototype, 'sign', function unguardedSign(rawTx, options) { return Reflect.apply(Demos.prototype.sign, this, [rawTx, { nonce: options.nonce }]); });
const result = await wholeDemSend(w);
assert.equal(result.error?.code, 'payload_mismatch', JSON.stringify(result)); assert.equal(w.node.confirms.length, 0, 'nothing is confirmed or broadcast');
});
