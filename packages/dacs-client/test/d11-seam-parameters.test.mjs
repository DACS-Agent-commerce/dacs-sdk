// D11 seams are factory parameters. A host passes its PurchaseStore and its
// wallet-challenge purposes; a factory built without them refuses at
// construction, before any read, write or wallet request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPurchaseService } from '../src/purchases.mjs';
import { createProtocolPurchases } from '../src/dacs/protocol-purchases.mjs';
import { createDeliveryDeadlineWatch, deliveryDeadlineView } from '../src/dacs/delivery-deadline-watch.mjs';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { purchaseStore, createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';
import { walletPurposes } from '../src/seams/wallet-actions-not-wired.mjs';
import { DEVNET_NATIVE_COMMITMENT_MARKER } from '../src/devnet-demo/commitment-consumer.mjs';
import * as wallet from '../src/public/portal/embedded-wallet/sdk-provider.mjs';
import * as transport from '../src/wallet/devnet-native-transport.mjs';

const notWired = (seam) => (error) => error.name === 'NotWiredError' && error.code === 'client_not_wired' && error.seam === seam;
// Any use of these throws: a factory that refuses first never touches them.
const untouched = new Proxy({}, { get(_target, key) { throw new Error(`unexpected use of ${String(key)}`); } });
const store = createSqlitePurchaseStore();
const purposes = { APPROVE_PURCHASE: 'approve-purchase' };

for (const bad of [undefined, null, {}, { transaction: () => {} }, { isUniqueViolation: () => false }, { transaction: 'x', isUniqueViolation: () => false }]) {
  test(`a missing or partial PurchaseStore is refused at construction: ${JSON.stringify(bad)}`, () => {
    assert.throws(() => purchaseStore(bad), notWired('purchase-store-not-wired'));
    assert.throws(() => createPurchaseService({ db: untouched, ops: untouched, coordinates: untouched, chain: untouched, challenges: untouched, store: bad, purposes }), notWired('purchase-store-not-wired'));
    assert.throws(() => createProtocolPurchases({ db: untouched, ops: untouched, coordinates: untouched, store: bad }), notWired('purchase-store-not-wired'));
    assert.throws(() => createDeliveryDeadlineWatch({ db: untouched, ops: untouched, coordinates: untouched, store: bad }), notWired('purchase-store-not-wired'));
  });
}

for (const bad of [undefined, null, {}, { APPROVE_PURCHASE: '' }, { APPROVE_PURCHASE: '  ' }, { APPROVE_PURCHASE: 1 }]) {
  test(`missing wallet purposes are refused at construction: ${JSON.stringify(bad)}`, () => {
    assert.throws(() => walletPurposes(bad), notWired('wallet-actions-not-wired'));
    assert.throws(() => createPurchaseService({ db: untouched, ops: untouched, coordinates: untouched, chain: untouched, challenges: untouched, store, purposes: bad }), notWired('wallet-actions-not-wired'));
  });
}

test('the store seam keeps only the two host functions, and purposes only the approval purpose', () => {
  const extra = { ...store, other: () => {} };
  assert.deepEqual(Object.keys(purchaseStore(extra)), ['transaction', 'isUniqueViolation']);
  const db = new DatabaseSync(':memory:');
  try { assert.equal(purchaseStore(extra).transaction(db, () => 'TEST-result'), 'TEST-result'); } finally { db.close(); }
  assert.deepEqual(walletPurposes({ ...purposes, LOGIN: 'login' }), purposes);
  assert.equal(Object.isFrozen(walletPurposes(purposes)), true);
});

test('protocol purchases without an operator capability build, and their paths that need one stay closed', () => {
  const buyer = createProtocolPurchases({ db: {}, ops: {}, coordinates: {}, store });
  assert.equal(buyer.actionsAdmitted, false);
});

test('protocol purchases refuse an unwired deadline watch instead of silently ignoring it', () => {
  assert.throws(() => createProtocolPurchases({ db: untouched, ops: untouched, coordinates: untouched, store,
    deliveryDeadlineWatch: {} }), /deliveryDeadlineWatch is not wired/);
});

test('the native transport links to the package wallet helpers, not a throwing stub', async () => {
  // The wallet seam exports only walletPurposes, so the transport (imported
  // above) could not link if it still imported the old stub names.
  assert.deepEqual(Object.keys(await import('../src/seams/wallet-actions-not-wired.mjs')), ['walletPurposes']);
  assert.equal(typeof transport.createDevnetNativeTransport, 'function');
  const content = { type: 'native', from: 'A'.repeat(64), to: '0x' + 'b'.repeat(64), amount: 1, data: ['native', { args: [] }], nonce: 7, timestamp: 1 };
  assert.match(await wallet.nativePayloadDigest(content), /^[0-9a-f]{64}$/);
  assert.equal(wallet.storageConfirmationShapeMatches({ transaction: { content: {}, signature: {}, hash: 'h', status: 'confirmed', blockNumber: 1 } }), true);
});

for (const buyerAccess of [false, {}, { assertWallet: 'TEST' }]) {
  test('malformed resolved buyer capability refuses construction', () => {
    assert.throws(() => createProtocolPurchases({ db: untouched, ops: untouched, coordinates: untouched, store, buyerAccess }), notWired('buyer-access-not-wired'));
  });
}

test('missing buyer capability refuses a native purchase before touching host state', () => {
  const buyer = createProtocolPurchases({ db: untouched, ops: untouched, coordinates: untouched, store });
  assert.throws(() => buyer.assertBuyerAccess('TEST-wallet', { terms: { protocol: { sellerCommitment: DEVNET_NATIVE_COMMITMENT_MARKER } } }), { code: 'buyer_access_closed' });
});

test('resolved buyer capability keeps its receiver and original refusal', () => {
  const cause = new Error('TEST-wallet-refused');
  const buyerAccess = { wallet: 'TEST-wallet', assertWallet(wallet) { assert.equal(this.wallet, wallet); throw cause; } };
  const buyer = createProtocolPurchases({ db: {}, ops: {}, coordinates: {}, store, buyerAccess });
  assert.throws(() => buyer.assertBuyerAccess('TEST-wallet'), error => error === cause);
});

test('store methods retain their host receiver and original errors', () => {
  const cause = new Error('TEST-store-refused');
  const host = { marker: 'TEST-host', transaction: store.transaction,
    isUniqueViolation(error) { assert.equal(this.marker, 'TEST-host'); return error === cause; } };
  const seam = purchaseStore(host);
  const db = new DatabaseSync(':memory:');
  try { assert.throws(() => seam.transaction(db, () => { throw cause; }), error => error === cause); } finally { db.close(); }
  assert.equal(seam.isUniqueViolation(cause), true);
});

test('injected seams do not lift trusted profile admission on any protocol action', async () => {
  const buyer = createProtocolPurchases({ db: untouched, ops: untouched, coordinates: untouched, store, buyerAccess: { assertWallet() {} } });
  assert.equal(buyer.actionsAdmitted, false);
  assert.throws(() => buyer.prepareTerms({}), { code: 'profile_not_admitted' });
  for (const method of ['identityRequest', 'planRequest', 'signRequest', 'submitAgreement', 'recheck', 'withNativePaymentLane', 'readNativePaymentLane']) {
    assert.equal(typeof buyer[method], 'function', method);
    await assert.rejects(async () => buyer[method]({}), { code: 'profile_not_admitted' });
  }
});

test('an asynchronous buyer assertion cannot grant synchronous wallet authority', () => {
  assert.throws(() => createProtocolPurchases({ db: untouched, ops: untouched, coordinates: untouched, store,
    buyerAccess: { async assertWallet() {} } }), notWired('buyer-access-not-wired'));
  const buyer = createProtocolPurchases({ db: {}, ops: {}, coordinates: {}, store,
    buyerAccess: { assertWallet: () => Promise.resolve() } });
  assert.throws(() => buyer.assertBuyerAccess('TEST-wallet'), notWired('buyer-access-not-wired'));
});

test('deadline observation uses the concrete transaction and refuses a stale repeat', t => {
  const operation = { id: 'TEST-operation', accountId: 'TEST-buyer', kind: 'purchase', status: 'settled_verified',
    terms: { seller: { claim: 'TEST-seller' }, protocol: {} },
    state: { protocol: { stage: 'payment-evidenced', agreement: { hash: 'TEST-hash', ref: { contentHash: 'TEST-hash' },
      artifact: { terms: { deadline: 1 }, parties: [{ role: 'seller', primaryClaim: 'TEST-seller' }] }, terms: { seller: 'TEST-seller', deadline: 1 } },
      commitment: { verifiedAt: 'TEST-verified' } } } };
  let current = operation, writes = 0;
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const watch = createDeliveryDeadlineWatch({ enabled: true, db,
    coordinates: { get: () => ({ verifiedAt: 'TEST-verified' }) }, store,
    ops: { get: () => current, transition(_id, _before, _after, { state }) { writes++; current = { ...current, state }; return current; } } });
  const readback = { notPresent: true, delivery: { status: 'absent' }, checkedAt: 120002 };
  watch.observe(operation, readback);
  watch.observe(operation, readback);
  assert.equal(writes, 1);
  assert.equal(current.state.protocol.deliveryDeadline.overdue.disposition, 'indeterminate');
  assert.equal(current.state.protocol.deliveryDeadline.overdue.source, 'host-supplied');
  const view = deliveryDeadlineView(current, { now: () => 120003, enabled: true });
  assert.match(view.message, /host's local report/);
  assert.doesNotMatch(view.message, /plugin checked|plugin's own observation/);
});

for (const transaction of [async () => {}, function* () {}, async function* () {}]) {
  test(`non-synchronous transaction refuses all factories: ${transaction.constructor.name}`, () => {
    const bad = { transaction, isUniqueViolation: () => false };
    assert.throws(() => purchaseStore(bad), notWired('purchase-store-not-wired'));
    assert.throws(() => createPurchaseService({ db: untouched, store: bad, purposes }), notWired('purchase-store-not-wired'));
    assert.throws(() => createProtocolPurchases({ db: untouched, store: bad }), notWired('purchase-store-not-wired'));
    assert.throws(() => createDeliveryDeadlineWatch({ db: untouched, store: bad }), notWired('purchase-store-not-wired'));
  });
}

for (const rejected of [false, true]) {
  test(`an unqualified promise-returning transaction is refused without invocation, rejectsWhenCalled=${rejected}`, async () => {
    let calls = 0;
    assert.throws(() => purchaseStore({ transaction: () => { calls++; return rejected ? Promise.reject(new Error('TEST-store-refusal')) : Promise.resolve('TEST'); },
      isUniqueViolation: () => false }), notWired('purchase-store-not-wired'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
  });
}

for (const topLevel of [undefined, { assertWallet() {} }]) {
  test('the old buyer-access location refuses even if a top-level capability is supplied', () => {
    assert.throws(() => createProtocolPurchases({ db: untouched, ops: untouched, coordinates: untouched, store,
      buyerAccess: topLevel, dacsProtocol: { buyerAccess: { assertWallet() { throw new Error('TEST-closed'); } } } }),
      error => error instanceof TypeError && /buyerAccess.*top.level/.test(error.message));
  });
}

for (const assertWallet of [() => false, () => true, function* () { throw new Error('TEST-closed'); }, async function* () { throw new Error('TEST-closed'); }]) {
  test(`non-assertion buyer capability cannot admit a wallet: ${assertWallet.constructor.name}`, () => {
    const buyer = createProtocolPurchases({ db: {}, ops: {}, coordinates: {}, store, buyerAccess: { assertWallet } });
    assert.throws(() => buyer.assertBuyerAccess('TEST-wallet'), notWired('buyer-access-not-wired'));
  });
}

test('package wallet helpers preserve the provider digest and confirmation contract', async () => {
  const helpers = await import('../src/wallet/payload-helpers.mjs');
  const content = { type: 'native', from: 'A'.repeat(64), to: '0x' + 'b'.repeat(64), amount: 1,
    data: ['native', { args: [] }], nonce: 7, timestamp: 1 };
  const signed = { ...content, from: '0x' + 'a'.repeat(64), transaction_fee: {}, gcr_edits: [], from_ed25519_address: 'TEST' };
  const digest = '69d081b66d283d0725b719066932eda8a47a3e0d0eedbec4dd8ab659e0fd6e33';
  assert.equal(await wallet.nativePayloadDigest(content), digest);
  assert.equal(await helpers.nativePayloadDigest(signed), digest);
  assert.equal(await helpers.nativePayloadDigest(content), digest);
  assert.notEqual(await helpers.nativePayloadDigest({ ...content, nonce: 8 }), digest);
  for (const confirmation of [null, {}, { transaction: {} },
    { transaction: { content: {}, signature: {}, hash: 'TEST', status: 'confirmed', blockNumber: 1 } },
    { transaction: { content: {}, signature: {}, hash: 'TEST', status: 'confirmed', blockNumber: 1 }, custom_charges: [] }]) {
    assert.equal(helpers.storageConfirmationShapeMatches(confirmation), wallet.storageConfirmationShapeMatches(confirmation));
  }
});

test('the statically served wallet provider loads without files outside the public tree', async () => {
  const source = readFileSync(new URL('../src/public/portal/embedded-wallet/sdk-provider.mjs', import.meta.url));
  const served = await import('data:text/javascript;base64,' + source.toString('base64'));
  const content = { type: 'native', from: 'A'.repeat(64), to: '0x' + 'b'.repeat(64), amount: 1,
    data: ['native', { args: [] }], nonce: 7, timestamp: 1 };
  assert.equal(await served.nativePayloadDigest(content), await wallet.nativePayloadDigest(content));
  assert.equal(served.storageConfirmationShapeMatches({ transaction: { content: {}, signature: {}, hash: 'TEST', status: 'confirmed', blockNumber: 1 } }), true);
});


test('post-fork prepared digest agrees with demosdk 4.0.16 serialized signing content', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@kynesyslabs/demosdk')), 'utf8'));
  assert.equal(manifest.version, '4.0.16');
  const { serializeTransactionContent } = await import(new URL('denomination/serializerGate.js', import.meta.resolve('@kynesyslabs/demosdk')));
  const content = { type: 'native', from: '0x' + 'a'.repeat(64), to: '0x' + 'b'.repeat(64), amount: '1000000000',
    data: ['native', { nativeOperation: 'send', args: ['0x' + 'b'.repeat(64), '1000000000'] }], nonce: 7, timestamp: 1 };
  const signed = JSON.parse(serializeTransactionContent({ ...content,
    transaction_fee: { network_fee: 1, rpc_fee: 1, additional_fee: 0 }, gcr_edits: [] }, true));
  assert.equal(signed.amount, '1000000000');
  assert.equal(signed.transaction_fee.network_fee, '1000000000');
  assert.equal(await wallet.nativePayloadDigest(signed), await wallet.nativePayloadDigest(content));
  assert.notEqual(await wallet.nativePayloadDigest({ ...content, amount: 1 }), await wallet.nativePayloadDigest(signed));
});
