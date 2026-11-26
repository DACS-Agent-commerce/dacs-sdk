import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { api, ok, world, setPurchaseAdmission } from './helpers/tp1-node-fixture.mjs';
import { createAuthorityFixture } from './fixtures/tp1-authority-reader.mjs';
const { JOURNAL_METHODS } = await import('../src/wallet/keystore-wallet-opener.mjs');
const { createDemosSr2Adapter } = await import('../src/dacs/demos-sr2-adapter.mjs');
const { nativeAgreementPaymentConfig } = await import('../src/dacs/native-agreement-payment-consumer.mjs');
const { isDevnetDeliveryTransport } = await import('../src/wallet/devnet-native-transport.mjs');
const { isDevnetAgreementTransport, isDevnetSettlementTransport, isDevnetDemoTransport } = api;

const REFUSED = 'keyless_transport_write_refused';
const NOT_ADMITTED = 'profile_not_admitted';
const OWNER_MEMBERS = ['currentLocal', 'getContext', 'acquireConnectionFence', 'fetchImpl'];
const RELAY_MEMBERS = ['binding', 'close', 'rpc', 'walletBinding'];
const PUBLIC_ORIGIN = 'https://relay.example.invalid';
const JSON_TYPE = { 'content-type': 'application/json' };
const FOREIGN_ADDRESS = '0x' + '7'.repeat(64);

const isRefusal = code => error => error.code === code || error.message === code;
const isTypeError = code => error => error instanceof TypeError && error.message === code;
const walletOf = w => w.session.wallet.getPublicAccount().address;
const nodeCall = (message, data = {}) => ({ method: 'nodeCall', params: [{ message, data }] });
const readback = (address, hash) => ({ phase: 'readback', address, hash });
const release = (address, leaseId = 'TEST-lease') => ({ phase: 'release', address, leaseId });
const causeChain = error => (error === undefined ? [] : [error, ...causeChain(error.cause)]);
const settles = promise => Promise.race([promise.then(() => true, () => true), new Promise(resolve => setImmediate(() => resolve(false)))]);

// The owner's and journal's members, each logging its name before it runs, so a test can assert none was called.
function watched(w, { owner = w.owner, journal = w.journal() } = {}) {
  const calls = { owner: [], journal: [] };
  const spy = (target, names, log) => Object.fromEntries(names.map(name => [name, (...args) => { log.push(name); return target[name](...args); }]));
  return { calls, owner: spy(owner, OWNER_MEMBERS, calls.owner), journal: spy(journal, JOURNAL_METHODS, calls.journal) };
}

async function openRelay(t, w, { watch = watched(w), admission = w.admission, walletAddress = walletOf(w), ...options } = {}) {
  const relay = await api.createKeylessAgreementTransport({ admission, owner: watch.owner, journal: watch.journal, walletAddress, ...options });
  t.after(() => relay.close());
  watch.calls.owner.length = 0; watch.calls.journal.length = 0;
  return { relay, watch };
}

// A keyed send that leaves a retained, included transfer on the shared journal; returns its hash.
async function retainedTransfer(w) {
  const sent = await w.send();
  assert.equal(sent.success, true, JSON.stringify(sent));
  return w.node.broadcasts[0].hash;
}

// What a test asserts after a refusal: no journal method, no owner method and no node request ran since `before`.
function assertUntouched(w, watch, before) {
  assert.deepEqual(watch.calls.journal, [], 'journal methods called');
  assert.deepEqual(watch.calls.owner, [], 'owner methods called');
  assert.equal(w.node.calls.length, before, 'node requests sent');
}

test('a keyless relay view has four frozen Agreement-only methods and cannot be a purchase source', async t => {
  const w = await world(t);
  const { relay } = await openRelay(t, w);
  assert.equal(Object.isFrozen(relay), true);
  assert.deepEqual(Object.keys(relay).sort(), RELAY_MEMBERS);
  assert.equal(isDevnetAgreementTransport(relay), true);
  for (const isOther of [isDevnetSettlementTransport, isDevnetDeliveryTransport, isDevnetDemoTransport]) assert.equal(isOther(relay), false);
  const before = w.node.calls.length;
  const journal = { get() {}, put() {}, records() {}, entries() {}, withWalletLock: (_key, work) => work() };
  const sourceConfig = source => ({ rpcUrl: w.owner.local.endpoint, sourceCapability: source, journal });
  const nativePayment = source => nativeAgreementPaymentConfig(source, { walletConfig: sourceConfig(source), sellerSr2Commitment: { publicProjection: {} }, coordinates: {}, fetchImpl: w.node.fetch, now: () => 0 });
  assert.throws(() => createDemosSr2Adapter({ ...sourceConfig(relay), fetchImpl: w.node.fetch }), isRefusal('source-held'));
  assert.throws(() => nativePayment(relay), TypeError);
  assert.equal(w.node.calls.length, before);
  // The same calls accept a real keyed Agreement source, so the refusals above are about the relay view.
  assert.ok(createDemosSr2Adapter({ ...sourceConfig(w.session.transport), fetchImpl: w.node.fetch }));
  assert.ok(nativePayment(w.session.transport));
});

test('a keyless relay refuses every signing and execute path before a journal or node call', async t => {
  const w = await world(t);
  const address = walletOf(w), hash = 'a'.repeat(64);
  const { relay, watch } = await openRelay(t, w);
  const before = w.node.calls.length;
  for (const name of ['sign', 'signature', 'bind', 'broadcast', 'execute', 'recoverStorageWrite', 'reopenWithheldBroadcast', 'withWalletNonceLock', 'cancelNativeTransfer']) assert.equal(relay[name], undefined, name);
  const signedBody = extra => ({ method: 'execute', params: [{ extra, data: { hash } }] });
  const rpcBodies = [signedBody('confirmTx'), signedBody('broadcastTx'), nodeCall('getTweet'), nodeCall('getTxByHash', { hash }), { method: 'nodeCall', params: [] },
    { method: 'nodeCall', params: [{ message: 'getNetworkInfo' }, { message: 'getNetworkInfo' }] }, { method: 'nodeCall', params: { message: 'getNetworkInfo' } }, null, 'getNetworkInfo'];
  for (const body of rpcBodies) await assert.rejects(relay.rpc(body, {}), isRefusal(REFUSED), JSON.stringify(body));
  await assert.rejects(relay.rpc(nodeCall('getNetworkInfo'), {}, { currentAuthorization: () => true }), isRefusal(REFUSED));
  await assert.rejects(relay.rpc(nodeCall('getNetworkInfo'), {}, undefined), isRefusal(REFUSED));
  const requests = [{ phase: 'bind', address }, { phase: 'signature', address, binding: {}, transfer: {} }, { phase: 'broadcast', address, leaseId: 'x', hash }, { phase: 'sign', address },
    { address, hash }, { ...readback(address, hash), writeProof: {} }, { ...readback(address, hash), failedNonceFence: 1 }, { ...readback(address, hash), consumedByHash: 'b'.repeat(64) },
    { ...release(address), extra: true }, { phase: 'readback', address }, { phase: 'release', address, leaseId: 1 }, { phase: 'readback', address, hash: 1 }, null, 'readback'];
  for (const method of ['binding', 'walletBinding']) {
    for (const request of requests) await assert.rejects(relay[method](request, {}), isRefusal(REFUSED), `${method} ${JSON.stringify(request)}`);
  }
  assertUntouched(w, watch, before);
});

test('a keyless relay rejects secret injected and noncanonical wallet options before opening a source', async t => {
  const w = await world(t);
  const address = walletOf(w), watch = watched(w);
  const construct = options => api.createKeylessAgreementTransport({ admission: w.admission, owner: watch.owner, journal: watch.journal, walletAddress: address, ...options });
  const before = w.node.calls.length;
  const secrets = { key: new Uint8Array(32), mnemonic: 'TEST words', signer: () => {}, signRpc: () => {}, boundary: {}, reopenGrants: {}, expected: {}, fetchImpl: () => {}, accountId: 'TEST-account', stopped: () => false };
  for (const [name, value] of Object.entries(secrets)) await assert.rejects(construct({ [name]: value }), isTypeError('keyless_transport_options_invalid'), name);
  const badAddresses = [undefined, null, 5, '', 'abc', address.toUpperCase().replace('0X', '0x'), address.slice(2), ` ${address}`, address + '0'];
  for (const walletAddress of badAddresses) await assert.rejects(construct({ walletAddress }), isTypeError('wallet_address_invalid'), String(walletAddress));
  for (const name of OWNER_MEMBERS) await assert.rejects(construct({ owner: { ...watch.owner, [name]: undefined } }), isTypeError('keyless_transport_options_invalid'), name);
  for (const name of JOURNAL_METHODS) await assert.rejects(construct({ journal: { ...watch.journal, [name]: undefined } }), isTypeError('keyless_transport_options_invalid'), name);
  for (const options of [{ owner: undefined }, { journal: undefined }]) await assert.rejects(construct(options), isTypeError('keyless_transport_options_invalid'));
  await assert.rejects(api.createKeylessAgreementTransport({ owner: watch.owner, journal: watch.journal, walletAddress: address }), isTypeError('admission_required'));
  await assert.rejects(construct({ record: {} }), isTypeError('admission_input_untrusted'));
  assertUntouched(w, watch, before);
});

test('a keyless relay verifies the approved binding and refuses a changed owner before construction', async t => {
  const w = await world(t);
  const watch = watched(w), before = w.node.calls.length;
  const otherLocal = { ...w.owner.local, endpoint: 'https://other.example.invalid/' };
  const foreignBinding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: otherLocal, readAuthority: createAuthorityFixture().read });
  const open = admission => api.createKeylessAgreementTransport({ admission, owner: watch.owner, journal: watch.journal, walletAddress: walletOf(w) });
  await assert.rejects(open({ binding: foreignBinding, currentLocal: w.owner.currentLocal }), error => error.code === NOT_ADMITTED && error.cause !== undefined);
  await assert.rejects(open({ binding: { ...w.admission.binding, recordDigest: '0'.repeat(64) }, currentLocal: w.owner.currentLocal }), isRefusal(NOT_ADMITTED));
  // The connection changes while the binding check is awaited: first read matches, later reads do not.
  let reads = 0;
  const movingOwner = { ...watch.owner, currentLocal: () => (reads++ === 0 ? w.owner.currentLocal() : otherLocal) };
  await assert.rejects(api.createKeylessAgreementTransport({ admission: w.admission, owner: movingOwner, journal: watch.journal, walletAddress: walletOf(w) }), isRefusal('tp1_local_binding_changed'));
  const movingAdmission = { binding: w.admission.binding, currentLocal: () => otherLocal };
  await assert.rejects(open(movingAdmission), isRefusal('tp1_local_binding_changed'));
  assert.deepEqual(watch.calls.journal, []);
  assert.equal(w.node.calls.length, before);
});

test('keyless readback keeps the retained hash and bounded source refusals while release sends nothing', async t => {
  const w = await world(t);
  const address = walletOf(w), hash = await retainedTransfer(w);
  const { relay } = await openRelay(t, w);
  const sends = () => [w.node.confirms.length, w.node.broadcasts.length];
  const sendsBefore = sends();
  const included = await relay.binding(readback(address, hash));
  assert.equal(included.disposition, 'included');
  await assert.rejects(relay.binding(readback(address, 'c'.repeat(64))), isRefusal('not_issued'));
  const answerWith = (body, init = {}) => new Response(body, { headers: JSON_TYPE, ...init });
  const refusals = [
    ['an oversized reply', () => answerWith(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); c.close(); } })), error => error.message === 'response exceeds byte limit'],
    ['a malformed reply', () => answerWith('{not json'), error => error.code === 'INVALID-JSON'],
  ];
  for (const [name, respond, original] of refusals) {
    w.node.intercept = () => respond();
    await assert.rejects(relay.binding(readback(address, hash)), error => error.code === 'unavailable' && causeChain(error).some(original), name);
  }
  w.node.intercept = () => new Promise(() => {});
  const stop = new AbortController();
  const mockedTimeout = t.mock.method(AbortSignal, 'timeout', () => stop.signal);
  const pending = relay.binding(readback(address, hash));
  const deadlineRefusal = assert.rejects(pending, error => error.code === 'unavailable' && causeChain(error).some(cause => cause.message === 'TEST-deadline'));
  await settles(pending);
  stop.abort(new DOMException('TEST-deadline', 'TimeoutError'));
  await deadlineRefusal;
  mockedTimeout.mock.restore();
  w.node.intercept = null;
  assert.deepEqual(await relay.binding(release(address)), { released: true });
  assert.deepEqual(sends(), sendsBefore);
  assert.equal((await relay.binding(readback(address, hash))).disposition, 'included');
});

test('closing a keyless relay drains reads and reopening the journal permits readback without replay', async t => {
  const w = await world(t);
  const address = walletOf(w), hash = await retainedTransfer(w);
  const { relay } = await openRelay(t, w);
  let startedRead, openGate;
  const started = new Promise(resolve => { startedRead = resolve; }), gate = new Promise(resolve => { openGate = resolve; });
  w.node.intercept = async () => { startedRead(); w.node.intercept = null; await gate; };
  const read = relay.binding(readback(address, hash));
  await started;
  let closed = false;
  const closing = relay.close().then(() => { closed = true; });
  assert.equal(await settles(closing), false, 'close waits for the read in flight');
  for (const call of [() => relay.binding(readback(address, hash)), () => relay.binding(release(address)), () => relay.walletBinding(readback(address, hash), {}), () => relay.rpc(nodeCall('getNetworkInfo'), {})]) {
    await assert.rejects(call(), isRefusal('transport_closed'));
  }
  assert.equal(closed, false);
  openGate();
  await Promise.allSettled([read]);
  await closing;
  assert.equal(closed, true);
  await relay.close();
  const sends = [w.node.confirms.length, w.node.broadcasts.length];
  const next = await w.restart();
  const reopened = await openRelay(t, w, { watch: watched(w, { owner: next.owner, journal: w.journal() }), admission: next.admission });
  assert.equal((await reopened.relay.binding(readback(address, hash))).disposition, 'included');
  assert.deepEqual([w.node.confirms.length, w.node.broadcasts.length], sends);
});

test('a keyless relay bound to one wallet refuses another wallet before a journal or node read', async t => {
  const w = await world(t);
  const hash = 'a'.repeat(64);
  const { relay, watch } = await openRelay(t, w);
  const before = w.node.calls.length;
  for (const method of ['binding', 'walletBinding']) {
    await assert.rejects(relay[method](readback(FOREIGN_ADDRESS, hash), {}), isRefusal(REFUSED), method);
    await assert.rejects(relay[method](release(FOREIGN_ADDRESS), {}), isRefusal(REFUSED), method);
  }
  await assert.rejects(relay.rpc(nodeCall('getAddressNonce', { address: FOREIGN_ADDRESS }), {}), isRefusal(REFUSED));
  await assert.rejects(relay.rpc(nodeCall('getAddressNonce', {}), {}), isRefusal(REFUSED));
  assertUntouched(w, watch, before);
});

test('keyless relay forwards exactly three preparation reads through its owner', async t => {
  const w = await world(t);
  const address = walletOf(w);
  w.node.nonce = 41;
  const { relay, watch } = await openRelay(t, w);
  const reads = [[nodeCall('getNetworkInfo'), ok({ forks: { osDenomination: { activated: true }, signatureDomain: { activated: false } }, chainId: 1 })],
    [nodeCall('getNetworkParameters'), ok({ networkFee: 1, rpcFee: 0, additionalFee: 0 })], [nodeCall('getAddressNonce', { address }), ok(41)]];
  for (const [body, answer] of reads) {
    const before = w.node.calls.length;
    assert.deepEqual(await relay.rpc(body, {}), answer);
    assert.equal(w.node.calls.length, before + 1);
    assert.deepEqual(w.node.calls.at(-1).body, body);
  }
  assert.ok(watch.calls.owner.includes('getContext'));
  assert.deepEqual(watch.calls.owner.filter(name => name !== 'getContext' && name !== 'fetchImpl'), []);
  assert.deepEqual(watch.calls.journal, []);
  const before = w.node.calls.length;
  const bad = [{ method: 'nodeCall', params: [] }, { method: 'nodeCall', params: [reads[0][0].params[0], reads[0][0].params[0]] }, null, nodeCall('getTweet'), nodeCall('getAddressNonce', { address: FOREIGN_ADDRESS })];
  watch.calls.owner.length = 0;
  for (const body of bad) await assert.rejects(relay.rpc(body, {}), isRefusal(REFUSED));
  assertUntouched(w, watch, before);
});

test('keyless walletBinding forwards retained readback and same-instance release', async t => {
  const w = await world(t);
  const address = walletOf(w), hash = await retainedTransfer(w);
  const { relay } = await openRelay(t, w);
  const sends = [w.node.confirms.length, w.node.broadcasts.length];
  const result = await relay.walletBinding(readback(address, hash), {});
  assert.equal(result.disposition, 'included');
  assert.deepEqual(await relay.walletBinding(release(address, 'TEST-lease'), {}), { released: true });
  assert.deepEqual(await relay.walletBinding(release(address, 'TEST-lease'), {}), { released: true });
  assert.deepEqual([w.node.confirms.length, w.node.broadcasts.length], sends);
});

test('keyless binding readback stays passive while held rpc and walletBinding refuse', async t => {
  const w = await world(t);
  const address = walletOf(w), hash = await retainedTransfer(w);
  const { relay, watch } = await openRelay(t, w);
  setPurchaseAdmission('held');
  const readbackResult = await relay.binding(readback(address, hash));
  assert.equal(readbackResult.disposition, 'included');
  watch.calls.journal.length = 0; watch.calls.owner.length = 0;
  const before = w.node.calls.length;
  const held = [() => relay.binding(release(address)), () => relay.walletBinding(readback(address, hash), {}), () => relay.walletBinding(release(address), {}),
    () => relay.rpc(nodeCall('getNetworkInfo'), {}), () => relay.rpc(nodeCall('getNetworkParameters'), {}), () => relay.rpc(nodeCall('getAddressNonce', { address }), {})];
  for (const call of held) await assert.rejects(call(), isRefusal(NOT_ADMITTED));
  assertUntouched(w, watch, before);
  await assert.rejects(relay.rpc(nodeCall('getTweet'), {}), isRefusal(REFUSED));
  await assert.rejects(relay.binding({ phase: 'bind', address }), isRefusal(REFUSED));
  setPurchaseAdmission('testnet-tp1');
  assert.deepEqual(await relay.rpc(nodeCall('getAddressNonce', { address }), {}), ok(w.node.nonce));
});

test('a pure keyless Agreement profile matches the inner transport without a buyer session', async t => {
  const w = await world(t);
  const nodeCallsBefore = w.node.calls.length;
  const { binding } = w.admission;
  const profile = api.keylessAgreementProfile({ binding, publicOrigin: PUBLIC_ORIGIN });
  assert.equal(w.node.calls.length, nodeCallsBefore);
  const inner = w.session.transport.profile(PUBLIC_ORIGIN);
  assert.deepEqual(profile, inner);
  assert.equal(profile.transportBinding.bindingId, inner.transportBinding.bindingId);
  assert.deepEqual(profile.transportBinding, inner.transportBinding);
  assert.equal(profile.capabilities.agreementCreate, true);
  assert.equal(profile.capabilities.settlementEvidenceCreate, false);
  const unadmitted = [undefined, null, 'binding', {}, { ...binding, recordDigest: '0'.repeat(64) }, { ...binding, profile: { ...binding.profile, pinVersion: 7 } }, { ...binding, local: {} }];
  for (const candidate of unadmitted) assert.throws(() => api.keylessAgreementProfile({ binding: candidate, publicOrigin: PUBLIC_ORIGIN }), isRefusal('admission_required'), JSON.stringify(candidate));
  for (const publicOrigin of [undefined, null, 5, '', 'relay.example.invalid', 'http://relay.example.invalid', `${PUBLIC_ORIGIN}/`, `${PUBLIC_ORIGIN}/path`, `${PUBLIC_ORIGIN}?q=1`]) {
    assert.throws(() => api.keylessAgreementProfile({ binding, publicOrigin }), isTypeError('public_origin_invalid'), String(publicOrigin));
  }
  assert.throws(() => api.keylessAgreementProfile(), isRefusal('admission_required'));
});

test('a keyless relay refuses a request with a hidden, symbol or accessor member before a journal or node call', async t => {
  const w = await world(t);
  const address = walletOf(w), hash = 'a'.repeat(64);
  const { relay, watch } = await openRelay(t, w);
  const before = w.node.calls.length;
  for (const base of [readback(address, hash), release(address)]) {
    const requests = [
      Object.defineProperty({ ...base }, 'writeProof', { value: { disposition: 'included' }, enumerable: false }),
      { ...base, [Symbol('TEST-member')]: 1 },
      Object.defineProperty({ ...base }, 'phase', { get: () => base.phase, enumerable: true }),
    ];
    for (const request of requests) {
      for (const method of ['binding', 'walletBinding']) await assert.rejects(relay[method](request, {}), isRefusal(REFUSED), `${method} ${base.phase}`);
    }
  }
  assertUntouched(w, watch, before);
});
