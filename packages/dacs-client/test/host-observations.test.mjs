import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseService, createCoordinateStore, createProtocolPurchases, createSqlitePurchaseStore } from '@kynesyslabs/dacs-client';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';

const HASH = '1'.repeat(64), CHAIN = 'f'.repeat(64), WALLET = '0x' + 'a'.repeat(64), PAYEE = '0x' + '7'.repeat(64);
const INCLUDED = { status: 'included', txHash: HASH, payer: WALLET, payee: PAYEE, amountOs: '2500000000', blockNumber: 10 };
function world(t, observation, { native = false, observer = 'TEST-host-reader', buyerRefusal = null, signingAddress = WALLET } = {}) {
  const db = openDatabase(':memory:'), store = createSqlitePurchaseStore();
  t.after(() => db.close());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8) }), coordinates = createCoordinateStore({ db });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date().toISOString());
  const chain = { network: 'testnet', rpcOrigin: 'https://rpc.invalid', pinnedIdentity: CHAIN, evidenceMode: 'TEST-host', observer,
    networkIdentity: async () => ({ identity: CHAIN, mode: 'public-chain-read' }),
    observeTransfer: async () => observation,
    getTransaction: async () => ({ hash: HASH, status: 'confirmed', blockNumber: 10,
      content: { from: signingAddress, from_ed25519_address: WALLET, nonce: 7 } }) };
  const terms = { buyer: { wallet: WALLET }, seller: { payee: PAYEE }, price: { amountOs: INCLUDED.amountOs, amount: '2.5' },
    network: 'testnet', rail: 'demos-native:DEM', listing: { listingId: 'TEST-listing', version: 1, contentHash: CHAIN },
    domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN },
    ...(native ? { protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',
      nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment', sellerAgreementProjection: 'public-signed-create' } } : {}) };
  const op = ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: 'TEST', request: {}, status: 'broadcast_reported',
    terms, termsHash: CHAIN, expiresAt: new Date(Date.now() + 3600000).toISOString() }).operation;
  coordinates.save({ operationId: op.id, kind: 'native-dem-transfer', network: 'testnet', from: WALLET, nonceFence: 6, expectedNonce: 7,
    target: PAYEE, amountOs: INCLUDED.amountOs, payload: {} });
  coordinates.reportHash(op.id, HASH);
  const protocol = native || buyerRefusal ? createProtocolPurchases({ db, ops, coordinates, store,
    buyerAccess: buyerRefusal ? { assertWallet() { throw buyerRefusal; } } : null }) : null;
  const purchases = createPurchaseService({ db, ops, coordinates, config: {}, chain, protocol, store, purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  return { coordinates, op, ops, fixReader() { observation = { ...INCLUDED }; },
    consumed: () => db.prepare('SELECT count(*) n FROM wallet_nonce_consumptions').get().n,
    verify: () => purchases.verifyDeal({ accountId: op.accountId, operationId: op.id }) };
}

for (const [label, observation] of [
  ['Number amount', { ...INCLUDED, amountOs: 2500000000 }],
  ['bigint amount', { ...INCLUDED, amountOs: 2500000000n }],
  ['noncanonical amount', { ...INCLUDED, amountOs: '02500000000' }],
  ['missing amount', { ...INCLUDED, amountOs: undefined }],
  ['non-string payer', { ...INCLUDED, payer: 7 }],
  ['unreadable payee', { ...INCLUDED, payee: 'TEST-invalid' }],
  ['string block', { ...INCLUDED, blockNumber: '10' }],
  ['different hash', { ...INCLUDED, txHash: '2'.repeat(64) }],
  ['bigint extension', { ...INCLUDED, extra: 1n }],
  ['null result', null],
]) {
  test(`malformed host observation (${label}) stays retryable and a corrected reader settles`, async t => {
    const w = world(t, observation), first = await w.verify();
    assert.equal(first.verification.outcome, 'invalid_observation');
    assert.equal(first.operation.status, 'broadcast_reported');
    assert.equal(w.coordinates.get(w.op.id).reportedTxHash, HASH);
    assert.ok(!w.coordinates.get(w.op.id).verifiedAt);
    assert.equal(w.consumed(), 0);
    assert.doesNotThrow(() => JSON.stringify(first));
    w.fixReader();
    const next = await w.verify();
    assert.equal(next.verification.outcome, 'verified');
    assert.equal(next.operation.status, 'settled_verified');
    assert.equal(next.verification.observer, 'TEST-host-reader');
    assert.equal(w.consumed(), 1);
  });
}

test('a readable, different amount remains a terms mismatch', async t => {
  const w = world(t, { ...INCLUDED, amountOs: '1' });
  const result = await w.verify();
  assert.equal(result.verification.outcome, 'mismatch');
  assert.equal(result.operation.status, 'payment_mismatch');
});

test('a readable transfer signed by an alternate key retains the approved buyer projection', async t => {
  const w = world(t, INCLUDED, { signingAddress: '0x' + 'b'.repeat(64) });
  const result = await w.verify();
  assert.equal(result.verification.outcome, 'verified');
  assert.equal(result.verification.signedByAlternateKey, true);
  assert.equal(w.consumed(), 0, 'the alternate key does not consume the wallet own nonce');
});

test('an undeclared host observer is never attributed to the core observer', async t => {
  const result = await world(t, INCLUDED, { observer: null }).verify();
  assert.equal(result.verification.observer, 'host-supplied chain reader (observer not declared)');
});

test('native reconciliation unavailable in the public host offers no retry loop', async t => {
  const w = world(t, INCLUDED, { native: true }), result = await w.verify();
  assert.equal(result.verification.outcome, 'verified');
  assert.equal(result.verification.nativeNonceResolved, false);
  assert.equal(result.verification.nativeReadback, 'unavailable');
  assert.doesNotMatch(result.verification.nextStep, /retry|verify_deal/i);
  assert.deepEqual(w.ops.history(w.op.id).filter(event => event.type === 'native_nonce_pending'), []);
});

for (const closed of [false, true]) {
  test(`wallet refusal ${closed ? 'with buyer_access_closed selects readback only' : 'without a code propagates unchanged'}`, async t => {
    const cause = new Error('TEST-wallet-closed');
    if (closed) cause.code = 'buyer_access_closed';
    const w = world(t, INCLUDED, { buyerRefusal: cause });
    const before = w.coordinates.get(w.op.id);
    if (closed) {
      const result = await w.verify();
      assert.equal(result.verification.outcome, 'readback_only');
      assert.deepEqual(result.verification.observation, INCLUDED);
    } else await assert.rejects(w.verify(), error => error === cause);
    assert.deepEqual(w.coordinates.get(w.op.id), before);
    assert.equal(w.ops.get(w.op.accountId, w.op.id).status, 'broadcast_reported');
  });
}
