// The keyless purchase source: the members the server-side purchase flow reads, over the caller's transport owner and
// durable journal, with no key, no signer and no member that confirms or broadcasts. A keyed session in the same world
// only produces retained facts to read back. The scripted TEST node stands in for the chain; no network, chain or funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { api, ok, world, setPurchaseAdmission, T0 } from './helpers/tp1-node-fixture.mjs';
import { createAuthorityFixture } from './fixtures/tp1-authority-reader.mjs';
import { runFreshChild } from './helpers/fresh-node-child.mjs';
const { JOURNAL_METHODS } = await import('../src/wallet/keystore-wallet-opener.mjs');
const { buildNativeTransferPayload } = await import('../src/dacs/wallet-transactions.mjs');
const { isDevnetDeliveryTransport } = await import('../src/wallet/devnet-native-transport.mjs');
const { createProtocolPurchases } = await import('../src/dacs/protocol-purchases.mjs');
const { createSqlitePurchaseStore } = await import('../src/seams/purchase-store-not-wired.mjs');
const { createDevnetNativeCommitmentCapability } = await import('../src/devnet-demo/commitment-consumer.mjs');
const { createBuyerChainReadback } = await import('../src/dacs/buyer-chain-readback.mjs');
const { createDemosSr2WalletBridge } = await import('../src/dacs/demos-sr2-wallet-bridge.mjs');
const { nativeAgreementPaymentConfig, NATIVE_AGREEMENT_PAYMENT } = await import('../src/dacs/native-agreement-payment-consumer.mjs');
const { SELLER_SR2_PUBLIC_PROJECTION } = await import('../src/dacs/seller-sr2-agreement-consumer.mjs');
const { readIssuedWallet } = await import('../src/devnet-demo/issued-readback.mjs');
const { walletLane } = await import('../src/wallet/wallet-lane.mjs');
const { isDevnetAgreementTransport, isDevnetSettlementTransport, isDevnetDemoTransport } = api;

const CEILING = '50000000000';
const PAYEE = '0x' + '2'.repeat(64);
const AMOUNT_OS = '2500000000';
const PHASE_REFUSED = 'keyless_source_phase_refused';
const OWNER_MEMBERS = ['currentLocal', 'getContext', 'acquireConnectionFence', 'fetchImpl'];
const SOURCE_MEMBERS = ['binding', 'cancelNativeTransfer', 'chainReader', 'close', 'isWalletIdle', 'journal', 'nativeNonceConsumer', 'nativeTransferCancelled',
  'nativeTransferClaimed', 'nativeTransferRefused', 'observeBinding', 'pins', 'readRpc', 'transportBinding'];
const PIN_FIELDS = ['chainIdentity', 'endpoint', 'network', 'pinVersion', 'transportAuthority'];
const JSON_TYPE = { 'content-type': 'application/json' };
const NATIVE_READS =['nativeTransferClaimed', 'nativeTransferCancelled', 'nativeTransferRefused', 'nativeNonceConsumer'];

const isCode = code => error => error.code === code;
const isTypeError = code => error => error instanceof TypeError && error.message === code;
const nodeCall = (message, data = {}) => ({ method: 'nodeCall', params: [{ message, data }] });
const outcome = promise => promise.then(value => ({ value }), error => ({ code: error.code ?? error.message }));
const settles = promise => Promise.race([promise.then(() => true, () => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
const walletOf = w => w.session.wallet.getPublicAccount().address;
// The confirm and broadcast requests the node received.
const posted = (w, extra) => w.node.calls.filter(row => row.body?.params?.[0]?.extra === extra);
const posts = w => [posted(w, 'confirmTx').length, posted(w, 'broadcastTx').length];
// A prepared, unsigned transfer by `address` at `nonce`, as the plugin hands it to the wallet.
const prepared = (address, nonce) => buildNativeTransferPayload({ from: address, to: PAYEE, amountOs: AMOUNT_OS, nonce, timestamp: T0, encoding: 'os-string' });
// The cancellations the source keeps for `address`, from the journal itself.
const cancelledEntries = async (w, address) => (await w.journal().entries()).filter(([key]) => key.startsWith('devnet/cancelled-payments/') && key.includes(address))
  .flatMap(([, record]) => record.transfers);

// The owner's and journal's members, each logging its name before it runs, so a test can assert none was called.
function watched(w) {
  const calls = { owner: [], journal: [] };
  const spy = (target, names, log) => Object.fromEntries(names.map(name => [name, (...args) => { log.push(name); return target()[name](...args); }]));
  return { calls, owner: spy(() => w.owner, OWNER_MEMBERS, calls.owner), journal: spy(() => w.journal(), JOURNAL_METHODS, calls.journal) };
}

// The source takes no clock, so its transport reads the system clock; the keyed fixture session reads the same one, so the
// network binding and claims each saves carry times the other accepts.
async function sourceWorld(t, worldOptions = {}) {
  const w = await world(t, { ...worldOptions, sessionOptions: { clock: { now: () => Date.now() } } });
  const state = { stop: () => false };
  const options = (extra = {}) => ({ admission: w.admission, owner: w.owner, journal: w.journal(), stopped: () => state.stop(), feeCeilingOs: CEILING, ...extra });
  const open = async extra => {
    const { sourceCapability } = await api.createKeylessPurchaseSource(options(extra));
    t.after(() => sourceCapability.close());
    return sourceCapability;
  };
  return { w, state, options, open };
}

// A keyed send that leaves a retained, included transfer at nonce 1 on the shared journal; returns its hash.
async function retainedTransfer(w) {
  const sent = await w.send();
  assert.equal(sent.success, true, JSON.stringify(sent));
  return w.node.broadcasts[0].hash;
}

// A native purchase bound to `source`'s pins, as the protocol callbacks read it.
const purchaseOf = (source, address) => ({ id: 'TEST-purchase', status: 'paying', terms: { network: source.pins.network, buyer: { wallet: address },
  domain: { mode: 'public-chain-read', chainIdentity: source.pins.chainIdentity },
  protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: NATIVE_AGREEMENT_PAYMENT, sellerAgreementProjection: SELLER_SR2_PUBLIC_PROJECTION, transportBinding: source.transportBinding } } });

// The protocol over `source`, with the seller and signing sides left as stand-ins the callbacks below never reach.
function protocolOver(w, source) {
  const commitment = createDevnetNativeCommitmentCapability({ authority: 'TEST-RUN-keyless-source',
    anchor: { authority: 'TEST-RUN-keyless-source', readRetained() { throw new Error('TEST-not-used'); }, verifyReceipt() { throw new Error('TEST-not-used'); } } });
  return createProtocolPurchases({ store: createSqlitePurchaseStore(), receiptFeeCeilings: { payFeeCeilingOs: '1000', anchorFeeCeilingOs: '2000' }, buyerMandateCapOs: '100000000000', coordinates: { unresolvedForSender: () => [] }, fetchImpl: w.node.fetch, now: () => T0,
    dacsProtocol: { walletAgreement: { sourceCapability: source, network: source.pins.network, rpcUrl: source.pins.endpoint, journal: w.journal(), bridgeFor: () => ({}) },
      nativeSellerCommitment: commitment, nativeAgreementPayment: source, sellerEndpoint: () => 'https://seller.example.invalid' } });
}

test('a keyless purchase source has exactly the members the purchase flow reads and passes only the Agreement transport check', async t => {
  const { w, options } = await sourceWorld(t);
  const built = await api.createKeylessPurchaseSource(options());
  t.after(() => built.sourceCapability.close());
  assert.deepEqual(Object.keys(built), ['sourceCapability']);
  assert.equal(Object.isFrozen(built), true);
  const source = built.sourceCapability;
  assert.equal(Object.isFrozen(source), true);
  assert.deepEqual(Object.keys(source).sort(), SOURCE_MEMBERS);
  assert.equal(isDevnetAgreementTransport(source), true);
  for (const isOther of [isDevnetSettlementTransport, isDevnetDeliveryTransport, isDevnetDemoTransport]) assert.equal(isOther(source), false);
  assert.equal(source.journal, w.journal(), 'the passed journal reference');
  for (const name of ['rpc', 'walletBinding', 'recoverStorageWrite', 'reserveRpcAuth', 'actionsAdmitted', 'profile', 'withWalletNonceLock']) assert.equal(source[name], undefined, name);
});

test("the purchase flow's readers accept a keyless purchase source and read every member as the keyed source answers it", async t => {
  const { w, open } = await sourceWorld(t);
  const keyed = w.session.transport, address = walletOf(w), hash = await retainedTransfer(w), payload = w.request.params[0];
  const source = await open();
  const sent = posts(w);
  assert.deepEqual(sent, [1, 1]);
  assert.deepEqual(source.pins, keyed.pins);
  assert.deepEqual(Object.keys(source.pins).sort(), PIN_FIELDS);
  assert.deepEqual(source.transportBinding, keyed.transportBinding);
  assert.equal(typeof source.isWalletIdle(address), 'boolean', 'the reconcile path reads the idle answer synchronously');
  assert.equal(source.isWalletIdle(address), keyed.isWalletIdle(address));
  for (const name of NATIVE_READS) assert.deepEqual(await source[name](address, payload), await keyed[name](address, payload), name);
  assert.equal((await source.observeBinding()).chainIdentity, (await keyed.observeBinding()).chainIdentity);
  const info = nodeCall('getNetworkInfo');
  assert.deepEqual(await source.readRpc('/', info), await keyed.readRpc('/', info));
  assert.equal((await source.chainReader().observeTransfer(hash)).status, (await keyed.chainReader().observeTransfer(hash)).status);
  const readback = { phase: 'readback', address, hash };
  assert.equal((await source.binding(readback)).disposition, (await keyed.binding(readback)).disposition);
  assert.deepEqual(await readIssuedWallet({ sourceCapability: source, address, hash, nativeOnly: true }), await readIssuedWallet({ sourceCapability: keyed, address, hash, nativeOnly: true }));

  // The readers that take a source construct over it and read as they do over the keyed one.
  assert.equal(createBuyerChainReadback({ sourceCapability: source, now: () => T0 }).source, createBuyerChainReadback({ sourceCapability: keyed, now: () => T0 }).source);
  const refuse = () => { throw new Error('TEST-not-used'); };
  const bridgeOver = capability => createDemosSr2WalletBridge({ rpcUrl: source.pins.endpoint, network: source.pins.network, journal: w.journal(), sourceCapability: capability,
    walletFactory: () => ({ request: refuse, getPublicAccount: refuse, getWriteProfile: refuse }), fetchImpl: w.node.fetch, now: () => T0 });
  w.node.intercept = row => (row.body?.params?.[0]?.message === 'searchStoragePrograms' ? new Response(JSON.stringify(ok([])), { headers: JSON_TYPE }) : undefined);
  const logicalAddress = 'dacs3:agreement:01M5YKPJG0248H248H248H248H';
  const expectation = { expectedWriter: 'did:demos:agent:' + address.slice(2) };
  const absent = await outcome(bridgeOver(source).read(logicalAddress, expectation));
  assert.deepEqual(absent, await outcome(bridgeOver(keyed).read(logicalAddress, expectation)));
  assert.equal(absent.value?.status, 'absent', 'the bridge read answers');
  w.node.intercept = null;
  const purchase = purchaseOf(source, address);
  const payment = nativeAgreementPaymentConfig(source, { walletConfig: { rpcUrl: source.pins.endpoint, sourceCapability: source, journal: w.journal() },
    sellerSr2Commitment: { publicProjection: true }, coordinates: { unresolvedForSender: () => [] }, fetchImpl: w.node.fetch, now: () => T0 });
  await assert.rejects(payment.readLane(purchase, walletLane({ network: source.pins.network, chainIdentity: source.pins.chainIdentity, address: PAYEE })), isCode('wallet_lane_mismatch'));
  assert.equal(await payment.withPaymentLane(purchase, async () => 'TEST-in-lane'), 'TEST-in-lane');

  // The purchase flow's own callbacks reach the source: a reconcile read, a proof-bearing readback and a cancel.
  const protocol = protocolOver(w, source), keyedProtocol = protocolOver(w, keyed);
  assert.equal(await protocol.nativePaymentSuperseded(purchase, { expectedNonce: 1, reportedTxHash: hash, observation: { slotConsumed: true, txHash: hash } }), true);
  const failed = { observation: { txStatus: 'failed', txHash: hash }, reportedTxHash: hash, nonceFence: 1, payload, expectedNonce: 1 };
  assert.deepEqual(await outcome(protocol.nativePaymentFailed(purchase, failed)), await outcome(keyedProtocol.nativePaymentFailed(purchase, failed)));
  const unclaimed = prepared(address, 2), rows = JSON.stringify(await w.journal().entries());
  setPurchaseAdmission('held');
  await assert.rejects(protocol.cancelNativePayment(purchase, { payload: unclaimed, expectedNonce: 2 }), isCode('profile_not_admitted'));
  assert.equal(JSON.stringify(await w.journal().entries()), rows, 'a held cancel writes nothing');
  setPurchaseAdmission('testnet-tp1');
  assert.deepEqual(await protocol.cancelNativePayment(purchase, { payload: unclaimed, expectedNonce: 2 }), { cancelled: true, claimed: null });
  assert.equal(await protocol.nativePaymentTermsCancelled(purchase, unclaimed), true);
  assert.deepEqual(posts(w), sent, 'the node saw only the keyed confirm and broadcast');
});

test('a keyless purchase source reads back with the lane proofs the purchase flow passes and refuses every other binding phase', async t => {
  const { w, open } = await sourceWorld(t);
  const keyed = w.session.transport, address = walletOf(w), hash = await retainedTransfer(w);
  const source = await open();
  for (const proof of [{ failedNonceFence: 7 }, { consumedByHash: 'b'.repeat(64) }]) {
    const request = { phase: 'readback', address, hash, ...proof };
    const answer = await outcome(source.binding(request));
    assert.notEqual(answer.code, PHASE_REFUSED, JSON.stringify(proof));
    assert.deepEqual(answer.code, (await outcome(keyed.binding(request))).code, JSON.stringify(proof));
  }
  // The node answers the transfer failed, so the fence proof is compared with the saved nonce: a fence that does not match is refused.
  w.node.intercept = row => (row.body?.params?.[0]?.message === 'getTxByHash'
    ? new Response(JSON.stringify(ok({ ...structuredClone(w.node.applied.get(hash)), status: 'failed', blockNumber: 1 })), { headers: JSON_TYPE }) : undefined);
  const mismatched = { phase: 'readback', address, hash, failedNonceFence: 7 };
  assert.equal((await outcome(source.binding(mismatched))).code, 'invalid_params');
  assert.equal((await outcome(keyed.binding(mismatched))).code, 'invalid_params');
  w.node.intercept = null;
  const watchedJournal = JSON.stringify(await w.journal().entries()), before = w.node.calls.length;
  for (const request of [{ phase: 'bind', address }, { phase: 'signature', address, binding: {} }, { phase: 'broadcast', address, leaseId: 'TEST-lease', hash },
    { phase: 'release', address, leaseId: 'TEST-lease' }, { address, hash }, null, 'readback']) {
    await assert.rejects(source.binding(request), isCode(PHASE_REFUSED), JSON.stringify(request));
  }
  assert.equal(w.node.calls.length, before, 'no node request');
  assert.equal(JSON.stringify(await w.journal().entries()), watchedJournal, 'no journal change');
});

test('a keyless purchase source refuses key-like, extra and missing options before any owner, journal or node call', async t => {
  const { w, options } = await sourceWorld(t);
  const watch = watched(w), before = w.node.calls.length;
  const watchedOptions = () => ({ ...options(), owner: watch.owner, journal: watch.journal });
  const construct = extra => api.createKeylessPurchaseSource({ ...watchedOptions(), ...extra });
  const extras = { key: new Uint8Array(32), mnemonic: 'TEST words', phrase: 'TEST words', keystore: 'TEST-keystore', signer: () => {}, signRpc: () => {}, fetchImpl: () => {},
    expected: {}, boundary: {}, transportOwner: watch.owner, walletAddress: '0x' + '7'.repeat(64), signingHandle: {}, secondOwner: watch.owner };
  for (const [name, value] of Object.entries(extras)) await assert.rejects(construct({ [name]: value }), isTypeError('keyless_relay_options_invalid'), name);
  for (const name of ['owner', 'journal', 'stopped', 'feeCeilingOs']) {
    const without = watchedOptions();
    delete without[name];
    await assert.rejects(api.createKeylessPurchaseSource(without), isTypeError('keyless_relay_options_invalid'), `without ${name}`);
  }
  for (const name of OWNER_MEMBERS) await assert.rejects(construct({ owner: { ...watch.owner, [name]: undefined } }), isTypeError('keyless_relay_owner_invalid'), name);
  for (const name of JOURNAL_METHODS) await assert.rejects(construct({ journal: { ...watch.journal, [name]: undefined } }), isTypeError('keyless_relay_journal_invalid'), name);
  const withoutAdmission = watchedOptions();
  delete withoutAdmission.admission;
  await assert.rejects(api.createKeylessPurchaseSource(withoutAdmission), isTypeError('admission_required'));
  await assert.rejects(api.createKeylessPurchaseSource({ ...withoutAdmission, key: new Uint8Array(32) }), isTypeError('admission_required'), 'the admission shape is checked first');
  await assert.rejects(api.createKeylessPurchaseSource(undefined), isTypeError('admission_required'));
  assert.deepEqual(watch.calls, { owner: [], journal: [] }, 'no owner or journal member was called');
  assert.equal(w.node.calls.length, before, 'no node request was sent');
});

test('a keyless purchase source holds no key and constructing one loads no demosdk', async t => {
  const child = runFreshChild(t, `
    import { writeFileSync } from 'node:fs'; import { registerHooks } from 'node:module';
    let demosdkImports = 0;
    registerHooks({ resolve(specifier, context, next) { if (/demosdk|demos-loader|demos-quiet-hooks|node-demos-loading|sdk-provider|node-wallet-session/.test(specifier)) demosdkImports++; return next(specifier, context); } });
    const { createKeylessPurchaseSource } = await import(process.argv[2]);
    const { bindFixture } = await import(process.argv[3]);
    const { binding, currentLocal } = await bindFixture();
    const refuse = () => { throw new Error('TEST-not-called'); };
    const owner = { currentLocal, getContext: refuse, acquireConnectionFence: refuse, fetchImpl: refuse };
    const journal = Object.fromEntries(['get', 'put', 'entries', 'withWalletLock', 'appendUnderLock', 'withOwnedOrAcquiredLane'].map(name => [name, refuse]));
    const built = await createKeylessPurchaseSource({ admission: { binding, currentLocal }, owner, journal, stopped: () => false, feeCeilingOs: '1' });
    const source = built.sourceCapability;
    const names = [...Reflect.ownKeys(built), ...Reflect.ownKeys(source)].map(String);
    const result = { demosdkImports, keys: Object.keys(source).sort(), pins: Object.keys(source.pins).sort(), names,
      bindingKeys: Object.keys(source.transportBinding).sort() };
    await source.close();
    writeFileSync('result.json', JSON.stringify(result));
  `, [new URL('../src/wallet/keyless-purchase-source.mjs', import.meta.url).href, new URL('./fixtures/tp1-authority-reader.mjs', import.meta.url).href]);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.result.demosdkImports, 0);
  assert.deepEqual(child.result.keys, SOURCE_MEMBERS);
  assert.deepEqual(child.result.pins, PIN_FIELDS);
  assert.deepEqual(child.result.bindingKeys, ['bindingId', 'bindingVersion', 'source', ...PIN_FIELDS].sort());
  for (const name of child.result.names) assert.doesNotMatch(name, /sign|key|phrase|mnemonic|secret|seed/i, name);
});

test('a keyless purchase source refuses a missing or malformed fee ceiling and builds nothing', async t => {
  const { w, options } = await sourceWorld(t);
  const watch = watched(w), before = w.node.calls.length;
  const construct = extra => api.createKeylessPurchaseSource({ ...options(), owner: watch.owner, journal: watch.journal, ...extra });
  for (const feeCeilingOs of [50000000000, '0', '01', '-1', '1.5', '']) await assert.rejects(construct({ feeCeilingOs }), isTypeError('keyless_relay_fee_ceiling_invalid'), String(feeCeilingOs));
  const withoutCeiling = { ...options(), owner: watch.owner, journal: watch.journal };
  delete withoutCeiling.feeCeilingOs;
  await assert.rejects(api.createKeylessPurchaseSource(withoutCeiling), isTypeError('keyless_relay_options_invalid'));
  for (const stopped of [false, 'no', null]) await assert.rejects(construct({ stopped }), isTypeError('keyless_relay_stop_invalid'), String(stopped));
  assert.deepEqual(watch.calls, { owner: [], journal: [] });
  assert.equal(w.node.calls.length, before);
  const { sourceCapability } = await api.createKeylessPurchaseSource(options({ feeCeilingOs: '1' }));
  t.after(() => sourceCapability.close());
  assert.equal(isDevnetAgreementTransport(sourceCapability), true, 'the smallest valid ceiling builds');
});

test('a keyless purchase source has no member that can confirm or broadcast, so no fee ceiling is crossed', async t => {
  const { w, open, options } = await sourceWorld(t);
  const address = walletOf(w);
  await retainedTransfer(w);
  const bodies = [...posted(w, 'confirmTx'), ...posted(w, 'broadcastTx')].map(row => row.body);
  assert.equal(bodies.length, 2);
  const source = await open({ feeCeilingOs: '1' }), sent = posts(w);
  for (const body of bodies) await assert.rejects(source.readRpc('/', body), isCode('readonly_only'), body.params[0].extra);
  for (const name of Object.keys(source).filter(name => typeof source[name] === 'function' && name !== 'close')) {
    for (const body of bodies) {
      for (const args of [[body], ['/', body], [address, body], [{ address, operationId: 'TEST-op', payload: body, unissued: async () => true }]]) {
        try { await source[name](...args); } catch { /* every refusal is fine; the node must see no send */ }
      }
    }
  }
  assert.deepEqual(posts(w), sent, 'no member sent a confirm or broadcast');
  const { nativeTransport } = await api.createKeylessSignedRelayTransport(options({ feeCeilingOs: '1' }));
  t.after(() => nativeTransport.close());
  assert.equal(isDevnetAgreementTransport(nativeTransport), true, 'the same five options build the signed relay');
});

test('a keyless purchase source cancels nothing while held, stopped or after its connection changed, and reads on', async t => {
  let current;
  const { w, state, open } = await sourceWorld(t, { ownerWrap: owner => { current = owner.currentLocal(); return { ...owner, currentLocal: () => current }; } });
  const address = walletOf(w), hash = await retainedTransfer(w), unclaimed = prepared(address, 2);
  const source = await open();
  const cancel = () => source.cancelNativeTransfer({ address, operationId: 'TEST-op', payload: unclaimed, unissued: async () => true });
  const checked = current;
  const refusals = [
    [() => setPurchaseAdmission('held'), 'profile_not_admitted'],
    [() => { state.stop = () => true; }, 'writes_stopped'],
    [() => { state.stop = () => { throw new Error('TEST-stop-read-failed'); }; }, 'stop_check_failed'],
    [() => { state.stop = async () => false; }, 'stop_check_invalid'],
    [() => { state.stop = () => 'no'; }, 'stop_check_invalid'],
  ];
  const running = () => { state.stop = () => false; setPurchaseAdmission('testnet-tp1'); current = checked; };
  for (const [change, code] of refusals) {
    const rows = JSON.stringify(await w.journal().entries()), before = w.node.calls.filter(row => row.body?.method === 'execute').length;
    change();
    await assert.rejects(cancel(), isCode(code), code);
    assert.equal(JSON.stringify(await w.journal().entries()), rows, `${code}: no journal write`);
    assert.equal(await source.nativeTransferCancelled(address, unclaimed), false, `${code}: the native reads still answer`);
    assert.equal((await source.binding({ phase: 'readback', address, hash })).disposition, 'included', `${code}: readback still runs`);
    assert.equal(w.node.calls.filter(row => row.body?.method === 'execute').length, before, `${code}: no node send`);
    running();
  }
  const rows = JSON.stringify(await w.journal().entries());
  current = { ...checked, connectionId: 'TEST-other-connection' };
  await assert.rejects(cancel(), error => error.code === 'profile_not_admitted' && error.cause !== undefined);
  current = checked;
  assert.equal(JSON.stringify(await w.journal().entries()), rows, 'a changed connection writes nothing');
  assert.deepEqual(await cancel(), { cancelled: true, claimed: null }, 'admitted and not stopped, the same call cancels');
});

test('a keyless purchase source is not built over a refused or changed binding', async t => {
  const { w, options } = await sourceWorld(t);
  const watch = watched(w), before = w.node.calls.length;
  const construct = extra => api.createKeylessPurchaseSource({ ...options(), owner: watch.owner, journal: watch.journal, ...extra });
  const otherLocal = { ...w.owner.currentLocal(), endpoint: 'https://other.example.invalid/' };
  const foreign = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: otherLocal, readAuthority: createAuthorityFixture().read });
  await assert.rejects(construct({ admission: { binding: foreign, currentLocal: w.owner.currentLocal } }), error => error.code === 'profile_not_admitted' && error.cause !== undefined);
  await assert.rejects(construct({ admission: { binding: { ...w.admission.binding, recordDigest: '0'.repeat(64) }, currentLocal: w.owner.currentLocal } }), isCode('profile_not_admitted'));
  await assert.rejects(construct({ admission: { binding: w.admission.binding, currentLocal: () => otherLocal } }), isCode('tp1_local_binding_changed'));
  assert.deepEqual(watch.calls.journal, [], 'no journal read');
  assert.deepEqual(watch.calls.owner.filter(name => name !== 'currentLocal'), [], 'only the connection the binding check compares was read');
  assert.equal(w.node.calls.length, before, 'no node read');
});

test('a keyless purchase source cancels a prepared transfer once through the lane lock and keeps the passed journal reference', async t => {
  const { w, open } = await sourceWorld(t);
  const address = walletOf(w);
  await retainedTransfer(w);
  const source = await open(), sent = posts(w), unclaimed = prepared(address, 2);
  assert.equal(source.journal, w.journal());
  const request = { address, operationId: 'TEST-op', payload: unclaimed, unissued: async () => true };
  assert.deepEqual(await source.cancelNativeTransfer(request), { cancelled: true, claimed: null });
  assert.equal(await source.nativeTransferCancelled(address, unclaimed), true);
  assert.deepEqual(await source.nativeTransferRefused(address, unclaimed), { cancelled: true, refusal: null });
  assert.equal((await cancelledEntries(w, address)).length, 1);
  assert.deepEqual(await source.cancelNativeTransfer(request), { cancelled: true, claimed: null }, 'a repeated cancel answers the same');
  assert.equal((await cancelledEntries(w, address)).length, 2, 'each admitted call appends under the lane lock');
  // Two calls at once: the second waits for the lane lock, so their writes never interleave.
  const order = [];
  const timed = label => ({ ...request, unissued: async () => { order.push(`${label}-start`); await new Promise(resolve => setImmediate(resolve)); order.push(`${label}-end`); return true; } });
  await Promise.all([source.cancelNativeTransfer(timed('first')), source.cancelNativeTransfer(timed('second'))]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
  assert.equal((await cancelledEntries(w, address)).length, 4);
  const claimedAnswer = await source.cancelNativeTransfer({ ...request, payload: w.request.params[0] });
  assert.equal(claimedAnswer.cancelled, false);
  assert.notEqual(claimedAnswer.claimed, null, 'the keyed send claimed the transfer');
  assert.equal((await cancelledEntries(w, address)).length, 4, 'a claimed transfer gets no entry');
  assert.deepEqual(posts(w), sent, 'no cancel sends anything');
});

test('closing a keyless purchase source closes only its own transport and leaves the passed journal and owner open', async t => {
  const { w, open } = await sourceWorld(t);
  const address = walletOf(w), hash = await retainedTransfer(w);
  const source = await open();
  let release, reached;
  const entered = new Promise(resolve => { reached = resolve; }), held = new Promise(resolve => { release = resolve; });
  w.node.intercept = async row => { if (row.body?.params?.[0]?.message === 'getTransactionStatus') { w.node.intercept = null; reached(); await held; } };
  const reading = outcome(source.binding({ phase: 'readback', address, hash }));
  await entered;
  const closing = source.close();
  assert.equal(await settles(closing), false, 'close waits for the read in flight');
  await assert.rejects(source.nativeTransferClaimed(address, w.request.params[0]), isCode('transport_closed'));
  release();
  await closing;
  await reading;
  await source.close();
  await assert.rejects(source.binding({ phase: 'readback', address, hash }), isCode('transport_closed'));
  await w.journal().put('TEST-after-close', { kept: true });
  assert.deepEqual(await w.journal().get('TEST-after-close'), { kept: true });
  assert.deepEqual(w.owner.currentLocal(), w.admission.currentLocal());
  const sibling = await open();
  assert.equal((await sibling.binding({ phase: 'readback', address, hash })).disposition, 'included', 'a second source over them still reads');
});

test('a new keyless purchase source over the same durable journal reads back a retained transfer and sends nothing', async t => {
  const { w, options } = await sourceWorld(t);
  const address = walletOf(w), hash = await retainedTransfer(w), sentPayload = w.request.params[0], unclaimed = prepared(address, 2);
  const first = (await api.createKeylessPurchaseSource(options())).sourceCapability;
  assert.deepEqual(await first.cancelNativeTransfer({ address, operationId: 'TEST-op', payload: unclaimed, unissued: async () => true }), { cancelled: true, claimed: null });
  const claimed = await first.nativeTransferClaimed(address, sentPayload);
  await first.close();
  const sent = posts(w);
  const restarted = await w.restart();
  const { sourceCapability: source } = await api.createKeylessPurchaseSource(options({ owner: restarted.owner, admission: restarted.admission, journal: w.journal() }));
  t.after(() => source.close());
  assert.deepEqual(await source.nativeTransferClaimed(address, sentPayload), claimed, 'the claim survives the restart');
  assert.equal(await source.nativeTransferCancelled(address, unclaimed), true, 'the cancellation survives the restart');
  assert.equal((await source.binding({ phase: 'readback', address, hash })).disposition, 'included');
  // The readback finishes the retained lane, so the claim now reads as the keyed transport over the same journal reads it.
  assert.deepEqual(await source.nativeTransferClaimed(address, sentPayload), await w.session.transport.nativeTransferClaimed(address, sentPayload));
  assert.deepEqual(posts(w), sent, 'no confirm or broadcast after the restart');
});
