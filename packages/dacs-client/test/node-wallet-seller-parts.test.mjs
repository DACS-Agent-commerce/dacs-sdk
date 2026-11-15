import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { api, agreementRequest, mnemonicBytes, setPurchaseAdmission, world } from './helpers/tp1-node-fixture.mjs';
import { inPass, sellerPublications as publications } from './helpers/effect-gate-world.mjs';
import { confirmThroughFacade, listingCreate, retainAcceptedCreate, signedTransaction, signingWallet } from './helpers/seller-facade-confirm.mjs';
import { createWorld } from './helpers/native-create-world.mjs';
import { installNoEgress } from './helpers/no-egress.mjs';
import * as nativeTransport from '../src/wallet/devnet-native-transport.mjs';

const trap = installNoEgress();
test.after(() => trap.restore());
const refused = error => error.code === 'profile_not_admitted';
const ACTIVE = ['rpc', 'walletBinding', 'recoverStorageWrite', 'cancelNativeTransfer'];
// Written independently of Object.keys or the implementation's wrapper configuration.
const PASSIVE = ['pins', 'transportBinding', 'journal', 'settlementPublication', 'deliveryPublication', 'demoArtifactPublication',
  'readRpc', 'observeBinding', 'chainReader', 'nativeTransferClaimed', 'nativeTransferCancelled', 'nativeTransferRefused',
  'nativeNonceConsumer', 'isWalletIdle', 'profile', 'onPurchaseStep', 'onStorageWriteResend', 'reserveRpcAuth', 'close'];
const PHASES = ['bind', 'signature', 'release', 'broadcast', 'TEST-unknown'];
async function seller(t, options = {}) {
  assert.equal(typeof api.createNodeSellerComposition, 'function');
  return world(t, { ...options, createSession: api.createNodeSellerComposition,
    sessionOptions: { approveConfirmedWrite: null, publications: publications(), ...options.sessionOptions } });
}

test('held, each active facade member (rpc, walletBinding, binding bind/signature/release, recoverStorageWrite, cancelNativeTransfer) rejects profile_not_admitted with node calls 0', async t => {
  const w = await seller(t, { held: true }), facade = w.session.transport;
  for (const name of ACTIVE) {
    const pending = facade[name]({});
    assert.ok(pending instanceof Promise, name);
    await assert.rejects(pending, refused);
  }
  for (const phase of PHASES) await assert.rejects(facade.binding({ phase }), refused);
  assert.equal(w.node.calls.length, 0);
  assert.deepEqual(await w.journal().entries(), []);
});

test('held, passive facade members, nativeTransferCancelled, nativeTransferRefused, nativeNonceConsumer and binding readback keep their behaviour', async t => {
  const w = await seller(t, { held: true }), f = w.session.transport, address = w.session.wallet.getPublicAccount().address;
  assert.equal(f.journal, w.journal());
  assert.equal(f.pins.chainIdentity, w.admission.binding.profile.chainIdentity);
  for (const name of Object.keys(publications())) assert.deepEqual(f[name], publications()[name]);
  assert.equal(f.profile('https://wallet.invalid').capabilities.demoArtifactCreate, true);
  assert.equal(f.isWalletIdle(address), true);
  assert.equal(f.reserveRpcAuth(address), undefined);
  for (const name of ['onPurchaseStep', 'onStorageWriteResend']) assert.equal(f[name](() => {})(), true);
  const payload = w.request.params[0];
  assert.equal(await f.nativeTransferClaimed(address, payload), null);
  assert.equal(await f.nativeTransferCancelled(address, payload), false);
  assert.equal(await f.nativeTransferRefused(address, payload), null);
  assert.equal(await f.nativeNonceConsumer(address, payload), null);
  await assert.rejects(f.binding({ phase: 'readback', address, hash: 'a'.repeat(64) }), error => error.code !== 'profile_not_admitted');
  assert.equal((await f.observeBinding()).chainIdentity, f.pins.chainIdentity);
  assert.equal((await f.readRpc('/', { method: 'nodeCall', params: [{ message: 'getAddressNonce', data: { address } }] })).response, 0);
  assert.equal(typeof f.chainReader().observeTransfer, 'function');
  assert.equal((await w.session.observer.observe()).chainIdentity, f.pins.chainIdentity);
  assert.equal(w.node.broadcasts.length, 0);
  await f.close();
  await assert.rejects(f.observeBinding(), { code: 'transport_closed' });
});

test('isDevnetAgreementTransport, isDevnetSettlementTransport and isDevnetDemoTransport accept the genuine registered transport and the held facade, and refuse a structured copy, an unregistered object and null', async t => {
  const w = await seller(t), raw = createWorld({ journal: w.journal() }).capability;
  t.after(() => raw.close());
  const facade = api.createHeldTransportFacade({ admission: w.admission, transport: raw });
  for (const name of ['isDevnetAgreementTransport', 'isDevnetSettlementTransport', 'isDevnetDemoTransport']) {
    for (const value of [raw, facade, w.session.transport]) assert.equal(api[name](value), true, name);
    for (const value of [{ ...facade }, structuredClone(facade.transportBinding), {}, null]) assert.equal(api[name](value), false, name);
  }
  assert.throws(() => nativeTransport.registerHeldTransportFacade({}, {}), /registered/);
  assert.throws(() => api.createHeldTransportFacade({ admission: w.admission, transport: {} }), /registered/);
  await assert.rejects(import('@kynesyslabs/dacs-client/src/wallet/devnet-native-transport.mjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test("the facade's member inventory equals the separately documented complete inventory and the capability's own keys, each member classed active or passive", async t => {
  const w = await seller(t), raw = createWorld({ journal: w.journal() }).capability;
  t.after(() => raw.close());
  const expected = [...ACTIVE, ...PASSIVE, 'binding'].sort();
  assert.equal(new Set(expected).size, expected.length);
  assert.deepEqual(Object.keys(raw).sort(), expected);
  assert.deepEqual(Object.keys(w.session.transport).sort(), expected);
  const doc = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  for (const [category, names] of [['Active', ACTIVE], ['Passive', PASSIVE]]) {
    const row = doc.split('\n').find(line => line.startsWith(`| Facade ${category.toLowerCase()} |`));
    assert.ok(row, category);
    assert.deepEqual([...row.matchAll(/`(\w+)`/g)].map(match => match[1]).sort(), [...names].sort());
  }
  assert.match(doc, /binding.*readback.*passive/);
});

test('the node-wallet entry and every composition it returns expose no raw transport and no unwrapped effect method', async t => {
  const w = await seller(t, { held: true }), buyer = await world(t, { held: true });
  for (const name of Object.keys(api)) assert.doesNotMatch(name, /^(?:createDevnet|registerHeld)/);
  assert.deepEqual(Object.keys(w.session).sort(), ['close', 'effectPass', 'internalCauseOf', 'observer', 'runInEffectPass', 'transport', 'wallet', 'walletFactory']);
  assert.deepEqual(Object.keys(buyer.session).sort(), ['close', 'effectPass', 'internalCauseOf', 'runInEffectPass', 'wallet', 'walletFactory']);
  for (const composition of [w.session, buyer.session]) {
    for (const wallet of [composition.wallet, composition.walletFactory({ anchorJournal: w.journal() })]) {
      assert.deepEqual(Object.keys(wallet).sort(), ['actionsAdmitted', 'getPublicAccount', 'getWriteProfile', 'isLocked', 'lock', 'request']);
      await assert.rejects(wallet.request(w.request), refused);
    }
  }
  for (const name of ACTIVE) await assert.rejects(w.session.transport[name]({}), refused);
  assert.equal(w.node.calls.length + buyer.node.calls.length, 0);
});

test("the confirmed-write callback is installed with the seller/Listing routing: called once for the seller's own non-Listing confirmation; false or a throw is approval_required with zero broadcasts; manual mode installs none", async t => {
  for (const outcome of ['allow', 'deny', 'throw', 'manual']) {
    let calls = 0;
    const sentinel = new Error('TEST-policy-refused');
    const confirm = async () => { calls++; if (outcome === 'throw') throw sentinel; return outcome === 'allow'; };
    const w = await seller(t, { sessionOptions: { approveConfirmedWrite: outcome === 'manual' ? null : confirm } });
    const result = await inPass(w, () => w.send());
    assert.equal(calls, outcome === 'manual' ? 0 : 1);
    assert.equal(result.success, ['allow', 'manual'].includes(outcome), JSON.stringify(result));
    assert.equal(w.node.broadcasts.length, result.success ? 1 : 0);
    if (!result.success) {
      let error = w.session.internalCauseOf(result);
      while (error && error.code !== 'approval_required') error = error.cause;
      assert.equal(error?.code, 'approval_required');
      if (outcome === 'throw') assert.equal(error.cause, sentinel);
    }
  }
  // A genuine own Listing and a different sender's genuine native confirmation
  // both bypass even a denying policy, through the installed transport callback.
  let calls = 0;
  const w = await seller(t, { sessionOptions: { approveConfirmedWrite: () => { calls++; return false; } } });
  const wallet = await signingWallet(w), tx = listingCreate(w, wallet);
  const { answer, lease } = await inPass(w, () => confirmThroughFacade(w, wallet, tx));
  assert.equal(answer.response.data.valid, true);
  await w.session.transport.binding({ phase: 'release', address: wallet.address, leaseId: lease.leaseId });
  const other = createWorld({ journal: w.journal() });
  const otherTx = signedTransaction(other.wallet, { ...w.request.params[0], content: { ...w.request.params[0].content, from: other.wallet.address } });
  assert.equal((await inPass(w, () => confirmThroughFacade(w, other.wallet, otherTx))).answer.response.data.valid, true);
  await other.capability.close();
  assert.equal(calls, 0);
  assert.equal(w.node.broadcasts.length, 0);
});

test('seller confirmation routing keeps its imported identity after wallet lock for native and Agreement writes', async t => {
  for (const kind of ['native', 'Agreement']) for (const outcome of ['allow', 'deny', 'throw', 'manual']) {
    await t.test(`${kind}: ${outcome}`, async t => {
      let calls = 0;
      const cause = new Error('TEST-locked-policy');
      const policy = () => { calls++; if (outcome === 'throw') throw cause; return outcome === 'allow'; };
      const w = await seller(t, { sessionOptions: { approveConfirmedWrite: outcome === 'manual' ? null : policy } });
      const wallet = await signingWallet(w);
      const payload = kind === 'native' ? w.request.params[0] : (await agreementRequest(w)).params[0].transaction;
      const tx = signedTransaction(wallet, payload);
      w.session.wallet.lock();
      assert.equal(w.session.wallet.getPublicAccount(), null);
      if (outcome === 'allow' || outcome === 'manual') {
        assert.equal((await inPass(w, () => confirmThroughFacade(w, wallet, tx))).answer.response.data.valid, true);
      } else {
        await assert.rejects(inPass(w, () => confirmThroughFacade(w, wallet, tx)), error =>
          error.code === 'approval_required' && (outcome !== 'throw' || error.cause === cause));
      }
      assert.equal(calls, outcome === 'manual' ? 0 : 1);
      assert.equal(w.node.broadcasts.length, 0);
    });
  }
});

test('an own Listing confirmation skips seller policy after wallet lock', async t => {
  let calls = 0;
  const w = await seller(t, { sessionOptions: { approveConfirmedWrite: () => { calls++; return false; } } });
  const wallet = await signingWallet(w), tx = listingCreate(w, wallet);
  w.session.wallet.lock();
  assert.equal(w.session.wallet.getPublicAccount(), null);
  assert.equal((await inPass(w, () => confirmThroughFacade(w, wallet, tx))).answer.response.data.valid, true);
  assert.equal(calls, 0);
  assert.equal(w.node.broadcasts.length, 0);
});

test('foreign native and storage confirmations skip seller policy after wallet lock', async t => {
  for (const kind of ['native', 'Listing']) await t.test(kind, async t => {
    let calls = 0;
    const w = await seller(t, { sessionOptions: { approveConfirmedWrite: () => { calls++; return false; } } });
    const other = createWorld({ journal: w.journal() });
    t.after(() => other.capability.close());
    const tx = kind === 'Listing' ? listingCreate(w, other.wallet)
      : signedTransaction(other.wallet, { ...w.request.params[0], content: { ...w.request.params[0].content, from: other.wallet.address } });
    w.session.wallet.lock();
    assert.equal(w.session.wallet.getPublicAccount(), null);
    assert.equal((await inPass(w, () => confirmThroughFacade(w, other.wallet, tx))).answer.response.data.valid, true);
    assert.equal(calls, 0);
    assert.equal(w.node.broadcasts.length, 0);
  });
});

test('every non-readback binding phase, including broadcast, is held and rechecked after admission await', async t => {
  for (const change of ['hold', 'local']) {
    let current;
    const w = await seller(t, { ownerWrap: owner => { current = owner.currentLocal(); return { ...owner, currentLocal: () => current }; } });
    for (const phase of PHASES) {
      setPurchaseAdmission('testnet-tp1'); current = w.owner.local;
      let release;
      w.authority.state.gate = () => new Promise(resolve => { release = resolve; });
      const pending = w.session.transport.binding({ phase });
      await new Promise(setImmediate);
      if (change === 'hold') setPurchaseAdmission('held'); else current = { ...current, connectionId: 'TEST-replaced' };
      release();
      await assert.rejects(pending, error => refused(error) && (change === 'hold' || error.cause?.code === 'tp1_local_binding_changed'));
      assert.deepEqual(await w.journal().entries(), []);
    }
    assert.equal(w.node.calls.length, 0);
  }
});

test('native metadata cannot masquerade as a Listing to bypass the confirmed-write policy', async t => {
  let calls = 0;
  const w = await seller(t, { sessionOptions: { approveConfirmedWrite: () => { calls++; return false; } } });
  const wallet = await signingWallet(w), payload = structuredClone(w.request.params[0]);
  payload.content.data[1].metadata = { artifactKind: 'Listing' };
  const tx = signedTransaction(wallet, payload);
  await assert.rejects(inPass(w, () => confirmThroughFacade(w, wallet, tx)), { code: 'approval_required' });
  assert.equal(calls, 1);
  assert.equal(w.node.broadcasts.length, 0);
});

test('close approval after confirmation callback and refuse broadcast through the final gate', async t => {
  // P21a2b supplies the inner gate. Here the final public K6 boundary is the
  // gate under test: a successful callback cannot authorize a later broadcast.
  let confirmations = 0;
  const w = await seller(t, { sessionOptions: { approveConfirmedWrite: async () => { confirmations++; setPurchaseAdmission('held'); return true; } } });
  const wallet = await signingWallet(w), tx = signedTransaction(wallet, w.request.params[0]);
  const { lease } = await inPass(w, () => confirmThroughFacade(w, wallet, tx));
  await assert.rejects(w.session.transport.binding({ phase: 'broadcast', address: wallet.address, leaseId: lease.leaseId, hash: tx.hash }), refused);
  assert.equal(confirmations, 1);
  assert.equal(w.node.broadcasts.length, 0);
});

test('reopen held composition with pending artifact CREATE, allow readback and refuse recovery resend', async t => {
  const w = await seller(t), wallet = await signingWallet(w), tx = listingCreate(w, wallet);
  await retainAcceptedCreate(w, wallet, tx);
  const before = await w.journal().entries();
  await w.restart();
  setPurchaseAdmission('held');
  const f = w.session.transport;
  const result = await f.binding({ phase: 'readback', address: tx.content.from, hash: tx.hash });
  assert.equal(result.disposition, 'pending');
  await assert.rejects(f.recoverStorageWrite({ signedTransaction: tx, signRpc: () => assert.fail('held recovery signed') }), refused);
  assert.deepEqual(await w.journal().entries(), before);
  assert.equal(w.node.broadcasts.length, 0);
});

test('seller construction validates admission, runtime, publications and confirmed-write option before opening custody', async t => {
  const w = await seller(t);
  for (const value of [undefined, false, true, {}, 'TEST-policy']) {
    const key = mnemonicBytes();
    await assert.rejects(api.createNodeSellerComposition({ admission: w.admission, owner: w.owner, journal: w.journal(), key, publications: publications(), approveConfirmedWrite: value }), /approveConfirmedWrite/);
    assert.ok(key.every(byte => byte === 0));
  }
  const stateOwnership = { directory: dirname(w.path), held: () => true };
  for (const extra of [{ admission: undefined }, { publications: {} }, { key: new Uint8Array([255]) }]) {
    const key = extra.key ?? mnemonicBytes();
    await assert.rejects(api.createNodeSellerComposition({ admission: w.admission, owner: w.owner, journal: w.journal(), publications: publications(), approveConfirmedWrite: null, stateOwnership, ...extra, key }),
      error => error.code !== 'state_ownership_required');
    assert.ok(key.every(byte => byte === 0));
  }
  const original = Object.getOwnPropertyDescriptor(process, 'version');
  try {
    for (const version of ['v22.12.0', 'v23.3.0']) {
      Object.defineProperty(process, 'version', { value: version, configurable: true });
      const key = mnemonicBytes();
      await assert.rejects(api.createNodeSellerComposition({ admission: w.admission, owner: w.owner, journal: w.journal(), key, publications: publications(), approveConfirmedWrite: null }), { code: 'runtime_unsupported' });
      assert.ok(key.every(byte => byte === 0));
    }
  } finally { Object.defineProperty(process, 'version', original); }
  assert.equal(w.node.calls.length, 0);
});

test('binding readback snapshots its phase before the transport queues it', async t => {
  const w = await seller(t, { held: true }), address = w.session.wallet.getPublicAccount().address;
  const request = { phase: 'readback', address, hash: 'a'.repeat(64) };
  const pending = w.session.transport.binding(request);
  request.phase = 'bind';
  await assert.rejects(pending, { code: 'not_issued' });
  let reads = 0;
  await assert.rejects(w.session.transport.binding({ get phase() { return reads++ === 0 ? 'readback' : 'bind'; }, address, hash: request.hash }), { code: 'not_issued' });
  assert.equal(w.node.calls.length, 0);
  assert.deepEqual(await w.journal().entries(), []);
});

test('no socket or DNS lookup leaves the process in the seller-parts and observer suites', async t => {
  const w = await seller(t, { held: true });
  await w.session.observer.observe();
  await w.session.observer.readNodeInfo('getNetworkInfo');
  assert.deepEqual(trap.attempts, []);
});
