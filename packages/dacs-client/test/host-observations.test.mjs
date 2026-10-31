import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPublicPurchaseService } from '../src/purchases.mjs';
import { createDeliveryDeadlineWatch } from '../src/dacs/delivery-deadline-watch.mjs';
import { PURCHASE_STATE_SCHEMA } from '../src/purchase-state-schema.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createProtocolPurchases } from '../src/dacs/protocol-purchases.mjs';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';
import { createPayDemSellerObserver } from '@kynesyslabs/dacs/seller';
import { createDemosChainReader, OS_INTEGER } from '../src/dacs/chain.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';

const HASH = '1'.repeat(64), CHAIN = 'f'.repeat(64), WALLET = '0x' + 'a'.repeat(64), PAYEE = '0x' + '7'.repeat(64);
const INCLUDED = { status: 'included', txHash: HASH, payer: WALLET, payee: PAYEE, amountOs: '2500000000', blockNumber: 10 };
function world(t, observation, { native = false, observer = 'TEST-host-reader', buyerRefusal = null, buyerAccess = null, signingAddress = WALLET, publicApi = false, now = () => 1700000000000 } = {}) {
  const db = openDatabase(':memory:'), store = createSqlitePurchaseStore();
  t.after(() => db.close());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8), now }), coordinates = createCoordinateStore({ db, now });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date(now()).toISOString());
  let bodyReads = 0;
  const chain = { network: 'testnet', rpcOrigin: 'https://rpc.invalid', pinnedIdentity: CHAIN, evidenceMode: 'TEST-host', observer,
    networkIdentity: async () => ({ identity: CHAIN, mode: 'public-chain-read' }),
    observeTransfer: async () => observation,
    getTransaction: async () => { bodyReads++; return { hash: HASH, status: 'confirmed', blockNumber: 10,
      content: { from: signingAddress, from_ed25519_address: WALLET, nonce: 7 } }; } };
  const terms = { buyer: { wallet: WALLET }, seller: { payee: PAYEE }, price: { amountOs: INCLUDED.amountOs, amount: '2.5' },
    network: 'testnet', rail: 'demos-native:DEM', listing: { listingId: 'TEST-listing', version: 1, contentHash: CHAIN },
    domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN },
    ...(native ? { protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',
      nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment', sellerAgreementProjection: 'public-signed-create' } } : {}) };
  const op = ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: 'TEST', request: {}, status: 'broadcast_reported',
    terms, termsHash: CHAIN, expiresAt: new Date(now() + 3600000).toISOString() }).operation;
  coordinates.save({ operationId: op.id, kind: 'native-dem-transfer', network: 'testnet', from: WALLET, nonceFence: 6, expectedNonce: 7,
    target: PAYEE, amountOs: INCLUDED.amountOs, payload: {} });
  coordinates.reportHash(op.id, HASH);
  const protocol = native || buyerRefusal || buyerAccess ? createProtocolPurchases({ db, ops, coordinates, store,
    buyerAccess: buyerRefusal ? { assertWallet() { throw buyerRefusal; } } : buyerAccess }) : null;
  const purchases = (publicApi ? createPublicPurchaseService : createPurchaseService)({ db, ops, coordinates, config: {}, chain, protocol, store, now, purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  return { db, chain, protocol, coordinates, op, ops, purchases, fixReader() { observation = { ...INCLUDED }; },
    bodyReads: () => bodyReads, snapshot: () => JSON.stringify(db.prepare('SELECT * FROM sqlite_master ORDER BY name').all().filter(r => r.type === 'table').map(r => [r.name, db.prepare(`SELECT * FROM "${r.name}" ORDER BY rowid`).all()])),
    consumed: () => db.prepare('SELECT count(*) n FROM wallet_nonce_consumptions').get().n,
    verify: () => purchases.verifyDeal({ accountId: op.accountId, operationId: op.id, token: ops.handoffTokenFor(op.id) }) };
}

function assertRetryable(w, result) {
  assert.equal(result.verification.outcome, 'invalid_observation');
  assert.equal(result.operation.status, 'broadcast_reported');
  assert.equal(w.coordinates.get(w.op.id).reportedTxHash, HASH);
  assert.ok(!w.coordinates.get(w.op.id).verifiedAt);
  assert.equal(w.consumed(), 0);
  assert.equal(w.bodyReads(), 0);
  assert.doesNotThrow(() => JSON.stringify(result));
}

for (const [label, hook] of [['included projection', () => ({ ...INCLUDED })], ['pending projection', () => ({ status: 'pending' })], ['throwing hook', () => { throw new Error('TEST-hook'); }]]) {
  test(`raw own facts settle without calling toJSON (${label})`, async t => {
    let calls = 0;
    const value = { ...INCLUDED, toJSON() { calls++; return hook(); } };
    const w = world(t, value), result = await w.verify();
    assert.equal(result.verification.outcome, 'verified');
    assert.deepEqual(result.verification.observation, INCLUDED);
    assert.deepEqual(w.coordinates.get(w.op.id).observation.observation, INCLUDED);
    assert.equal(calls, 0);
    assert.equal((await w.verify()).verification.outcome, 'verified');
  });
}

test('raw failed source disposition cannot be changed by toJSON and correction settles', async t => {
  let calls = 0;
  const w = world(t, { ...INCLUDED, sourceDisposition: 'failed', toJSON() { calls++; return { ...INCLUDED, sourceDisposition: 'included' }; } }, { native: true });
  const result = await w.verify();
  assert.equal(result.verification.outcome, 'transaction_unconfirmed');
  assert.equal(result.operation.status, 'broadcast_reported');
  assert.equal(result.verification.observation.sourceDisposition, 'failed');
  assert.ok(!w.coordinates.get(w.op.id).verifiedAt);
  assert.equal(w.consumed(), 0);
  assert.equal(calls, 0);
  w.fixReader();
  assert.equal((await w.verify()).verification.outcome, 'verified');
});

for (const [label, fields] of [['included', { sourceDisposition: 'included' }], ['absent', {}]]) {
  test(`native source disposition ${label} settles`, async t => {
    const result = await world(t, { ...INCLUDED, ...fields }, { native: true }).verify();
    assert.equal(result.verification.outcome, 'verified');
    assert.deepEqual(result.verification.observation, { ...INCLUDED, ...fields });
  });
}

for (const field of ['status', 'reason', 'txHash', 'payer', 'payee', 'amountOs', 'blockNumber', 'includedAt', 'sourceDisposition']) {
  test(`listed ${field} accessor is refused without invoking it`, async t => {
    let calls = 0;
    const value = Object.defineProperty({ ...INCLUDED }, field, { get() { calls++; throw new Error('TEST-getter'); } });
    const w = world(t, value);
    assertRetryable(w, await w.verify());
    assert.equal(calls, 0);
    w.fixReader();
    assert.equal((await w.verify()).verification.outcome, 'verified');
  });
}

for (const [label, extra] of [['huge string', 'x'.repeat(65537)], ['bigint', 1n], ['cycle', (() => { const cycle = {}; cycle.self = cycle; return cycle; })()], ['boxed string', new String('TEST')], ['function', () => {}], ['symbol', Symbol('TEST')]]) {
  test(`unknown ${label} and unknown getters are ignored and not retained`, async t => {
    let calls = 0;
    const value = { ...INCLUDED, extra, get tail() { calls++; throw new Error('TEST-unknown'); }, get toJSON() { calls++; throw new Error('TEST-toJSON'); } };
    const w = world(t, value), result = await w.verify();
    assert.equal(result.verification.outcome, 'verified');
    assert.deepEqual(result.verification.observation, INCLUDED);
    assert.equal(calls, 0);
  });
}

for (const [label, observation] of [
  ['Number amount', { ...INCLUDED, amountOs: 2500000000 }],
  ['bigint amount', { ...INCLUDED, amountOs: 2500000000n }],
  ['boxed amount', { ...INCLUDED, amountOs: new String(INCLUDED.amountOs) }],
  ['noncanonical amount', { ...INCLUDED, amountOs: '02500000000' }],
  ['negative amount', { ...INCLUDED, amountOs: '-1' }],
  ['fractional amount', { ...INCLUDED, amountOs: '2.5' }],
  ['missing amount', { ...INCLUDED, amountOs: undefined }],
  ['non-string payer', { ...INCLUDED, payer: 7 }],
  ['boxed payer', { ...INCLUDED, payer: new String(WALLET) }],
  ['missing payer', { ...INCLUDED, payer: undefined }],
  ['missing payee', { ...INCLUDED, payee: undefined }],
  ['unreadable payee', { ...INCLUDED, payee: 'TEST-invalid' }],
  ['long payer', { ...INCLUDED, payer: 'a'.repeat(1000000) }],
  ['long payee', { ...INCLUDED, payee: 'a'.repeat(1000000) }],
  ['string block', { ...INCLUDED, blockNumber: '10' }],
  ['missing block', { ...INCLUDED, blockNumber: undefined }],
  ['negative block', { ...INCLUDED, blockNumber: -1 }],
  ['fractional block', { ...INCLUDED, blockNumber: 1.5 }],
  ['unsafe block', { ...INCLUDED, blockNumber: Number.MAX_SAFE_INTEGER + 1 }],
  ['string inclusion time', { ...INCLUDED, includedAt: 'TEST-time' }],
  ['undefined inclusion time', { ...INCLUDED, includedAt: undefined }],
  ['negative inclusion time', { ...INCLUDED, includedAt: -1 }],
  ['fractional inclusion time', { ...INCLUDED, includedAt: 1.5 }],
  ['out of range inclusion time', { ...INCLUDED, includedAt: 8640000000000001 }],
  ['different hash', { ...INCLUDED, txHash: '2'.repeat(64) }],
  ['missing hash', { ...INCLUDED, txHash: undefined }],
  ['invalid hash', { ...INCLUDED, txHash: 'TEST-hash' }],
  ['long hash', { ...INCLUDED, txHash: '1'.repeat(1000000) }],
  ['non-string reason', { status: 'failed', reason: 7 }],
  ['undefined reason', { status: 'failed', reason: undefined }],
  ['undefined source disposition', { ...INCLUDED, sourceDisposition: undefined }],
  ['null source disposition', { ...INCLUDED, sourceDisposition: null }],
  ['other source disposition', { ...INCLUDED, sourceDisposition: 'x' }],
  ['boxed source disposition', { ...INCLUDED, sourceDisposition: new String('included') }],
  ['empty object', {}],
  ['unsupported status', { status: 'TEST-status' }],
]) {
  test(`malformed host observation (${label}) stays retryable and a corrected reader settles`, async t => {
    const w = world(t, observation);
    assertRetryable(w, await w.verify());
    w.fixReader();
    const next = await w.verify();
    assert.equal(next.verification.outcome, 'verified');
    assert.equal(next.operation.status, 'settled_verified');
    assert.equal(next.verification.observer, 'TEST-host-reader');
    assert.equal(w.consumed(), 1);
  });
}

for (const [label, value] of [['undefined', undefined], ['null', null], ['function', () => {}], ['symbol', Symbol('TEST')], ['string', 'TEST'], ['number', 1], ['array', []]]) {
  test(`root ${label} gets the object-shape reason`, async t => {
    const w = world(t, value), result = await w.verify();
    assertRetryable(w, result);
    assert.equal(result.verification.observation.reason, 'chain observation must be an object');
  });
}

test('inherited listed facts are absent and never read', async t => {
  let calls = 0;
  const inherited = Object.defineProperty({}, 'status', { get() { calls++; return 'included'; } });
  const w = world(t, Object.assign(Object.create(inherited), { txHash: HASH, payer: WALLET, payee: PAYEE, amountOs: INCLUDED.amountOs, blockNumber: 10 }));
  assertRetryable(w, await w.verify());
  assert.equal(calls, 0);
});

test('the record is detached before the body read', async t => {
  const value = { ...INCLUDED }, w = world(t, value), body = w.chain.getTransaction;
  w.chain.getTransaction = async () => { value.amountOs = '1'; return body(); };
  const result = await w.verify();
  assert.equal(result.verification.outcome, 'verified');
  assert.deepEqual(result.verification.observation, INCLUDED);
});

test('oversized amount is refused before the OS regex runs', async t => {
  const w = world(t, { ...INCLUDED, amountOs: '1'.repeat(1000000) });
  const original = OS_INTEGER.test;
  let calls = 0;
  OS_INTEGER.test = function (value) { calls++; return original.call(this, value); };
  try { assertRetryable(w, await w.verify()); assert.equal(calls, 0); }
  finally { OS_INTEGER.test = original; }
});

test('a long failed reason is capped and still decides from the failed status', async t => {
  const w = world(t, { status: 'failed', reason: 'x'.repeat(200000) }), result = await w.verify();
  assert.equal(result.verification.outcome, 'failed_unconfirmed');
  assert.equal(result.verification.observation.reason, 'x'.repeat(240));
  assert.equal(result.operation.status, 'payment_uncertain');
  assert.ok(JSON.stringify(w.coordinates.get(w.op.id)).length < 4000);
});

for (const status of ['pending', 'not-found', 'unavailable']) {
  test(`${status} retains only status/reason, skips the body and remains retryable`, async t => {
    const w = world(t, { status, reason: 'TEST-reason', extra: 1n }), result = await w.verify();
    assert.equal(result.verification.outcome, status === 'unavailable' ? 'chain_unavailable' : 'awaiting_inclusion');
    assert.deepEqual(result.verification.observation, { status, reason: 'TEST-reason' });
    assert.equal(result.operation.status, 'broadcast_reported');
    assert.equal(w.bodyReads(), 0);
    assert.equal(w.consumed(), 0);
    w.fixReader();
    assert.equal((await w.verify()).verification.outcome, 'verified');
  });
}

test('included epoch zero is retained in the public receipt', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
  const w = world(t, { ...INCLUDED, includedAt: 0 }), result = await w.verify();
  assert.equal(result.verification.outcome, 'verified');
  assert.equal(w.purchases.portalEvidence(result.operation.id, w.ops.handoffTokenFor(result.operation.id)).receipt.includedAt, '1970-01-01T00:00:00.000Z');
});

test('a readable, different amount remains a terms mismatch', async t => {
  const result = await world(t, { ...INCLUDED, amountOs: '1' }).verify();
  assert.equal(result.verification.outcome, 'mismatch');
  assert.equal(result.operation.status, 'payment_mismatch');
});

test('a readable alternate key retains the approved buyer projection', async t => {
  const w = world(t, INCLUDED, { signingAddress: '0x' + 'b'.repeat(64) }), result = await w.verify();
  assert.equal(result.verification.outcome, 'verified');
  assert.equal(result.verification.signedByAlternateKey, true);
  assert.equal(w.consumed(), 0);
});

test('real chain reader declares core single-node observation attribution', () => {
  const reader = createDemosChainReader({ rpcUrl: 'https://rpc.invalid', network: 'testnet' });
  assert.equal(reader.observer, '@kynesyslabs/dacs observePayDemTransferCore (single-node consistent view; not a validator-quorum proof)');
});

test('undeclared host reader attribution is explicit', async t => {
  const result = await world(t, INCLUDED, { observer: null }).verify();
  assert.equal(result.verification.observer, 'host-supplied chain reader (observer not declared)');
});

for (const [label, cause] of [['no code', new Error('TEST-closed')], ['other code', Object.assign(new Error('TEST-closed'), { code: 'TEST-other' })], ['missing access', Object.assign(new Error('TEST-closed'), { code: 'buyer_access_closed', details: { buyerAccessMissing: true } })], ['closed', Object.assign(new Error('TEST-closed'), { code: 'buyer_access_closed' })]]) {
  test(`only buyer_access_closed selects readback without writes (${label})`, async t => {
    const w = world(t, INCLUDED, { buyerRefusal: cause }), before = w.snapshot();
    if (label === 'closed') {
      const result = await w.verify();
      assert.equal(result.verification.outcome, 'readback_only');
      assert.deepEqual(result.verification.observation, INCLUDED);
    } else await assert.rejects(w.verify(), error => error === cause);
    assert.equal(w.snapshot(), before);
  });
}

test('closed wallet refuses a different supplied hash without reads or writes', async t => {
  const cause = Object.assign(new Error('TEST-closed'), { code: 'buyer_access_closed' });
  const w = world(t, INCLUDED, { buyerRefusal: cause }), before = w.snapshot();
  w.chain.observeTransfer = async () => { assert.fail('unexpected read'); };
  await assert.rejects(w.purchases.verifyDeal({ accountId: w.op.accountId, operationId: w.op.id, txHash: '2'.repeat(64) }), error => error === cause);
  assert.equal(w.snapshot(), before);
});

test('closed wallet returns serializable malformed readback without writes', async t => {
  const cause = Object.assign(new Error('TEST-closed'), { code: 'buyer_access_closed' });
  const w = world(t, { ...INCLUDED, amountOs: 1n }, { buyerRefusal: cause }), before = w.snapshot();
  const result = await w.verify();
  assert.equal(result.verification.outcome, 'readback_only');
  assert.equal(result.verification.observation.status, 'malformed');
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(w.snapshot(), before);
});

const rejectionCases = [
  ['null', null, 'chain reader failed'], ['undefined', undefined, 'chain reader failed'],
  ['string', 'TEST-reader-failed', 'TEST-reader-failed'],
  ['long Error', new Error('TEST-long-'.repeat(100)), 'TEST-long-'.repeat(100).slice(0, 240)],
  ['null prototype', Object.create(null), 'chain reader failed'],
  ['message getter', Object.defineProperty({}, 'message', { get() { assert.fail('message getter called'); } }), 'chain reader failed'],
];
for (const [label, failure, expected] of rejectionCases) {
  for (const route of ['domain', 'observation', 'closed-wallet']) {
    test(`${route} catch safely bounds ${label} rejection`, async t => {
      const closed = Object.assign(new Error('TEST-closed'), { code: 'buyer_access_closed' });
      const w = world(t, INCLUDED, route === 'closed-wallet' ? { buyerRefusal: closed } : {});
      const before = w.snapshot();
      const key = route === 'domain' ? 'networkIdentity' : 'observeTransfer', reader = w.chain[key];
      w.chain[key] = async () => { throw failure; };
      const result = await w.verify();
      assert.equal(result.verification.outcome, route === 'closed-wallet' ? 'readback_only' : 'chain_unavailable');
      assert.equal(route === 'domain' ? result.verification.reason : result.verification.observation.reason, expected);
      assert.equal(result.operation.status, 'broadcast_reported');
      assert.equal(w.consumed(), 0);
      if (route !== 'observation') assert.equal(w.snapshot(), before);
      w.chain[key] = reader;
      if (route !== 'closed-wallet') assert.equal((await w.verify()).verification.outcome, 'verified');
    });
  }
}

for (const failure of ['non-native transaction', 'inconsistent amount']) {
  test(`core invalid observation (${failure}) preserves reason and consumed nonce`, async t => {
    const tx = { hash: HASH, status: 'confirmed', blockNumber: 10, content: {
      from: WALLET, from_ed25519_address: WALLET, nonce: 7, to: PAYEE, type: 'native', amount: '2500000000',
      data: ['native', { nativeOperation: 'send', args: [PAYEE, '2500000000'] }] } };
    if (failure === 'non-native transaction') tx.content.type = 'storage';
    else tx.content.data[1].args[1] = '1';
    const replies = { getTransactionStatus: { state: 'included', blockNumber: 10 }, getTxByHash: tx,
      getBlockByNumber: { number: 10, status: 'confirmed', content: { timestamp: 1786694557, ordered_transactions: [HASH] } } };
    const observer = createPayDemSellerObserver({ rpc: 'https://rpc.invalid', fetchImpl: async (_url, init) => {
      const { message } = JSON.parse(init.body).params[0];
      return new Response(JSON.stringify({ result: 200, response: replies[message] }));
    } });
    const observation = await observer.observeDemosTransfer(HASH);
    assert.equal(observation.status, 'invalid');
    assert.match(observation.reason, failure === 'non-native transaction' ? /not a native/ : /amount/);
    const w = world(t, observation), result = await w.verify();
    assert.equal(result.verification.outcome, 'invalid_observation');
    assert.deepEqual(result.verification.observation, observation);
    assert.equal(result.operation.status, 'payment_uncertain');
    assert.equal(result.verification.slotConsumed, true);
    assert.equal(w.consumed(), 1);
    assert.equal(w.coordinates.get(w.op.id).observation.observation.reason, observation.reason);
    w.fixReader();
    assert.equal((await w.verify()).verification.outcome, 'verified');
    assert.equal(w.consumed(), 1);
  });
}

test('public protocol native readback availability is reported without retry text', async t => {
  const w = world(t, INCLUDED, { native: true }), result = await w.verify();
  assert.equal(w.protocol.nativePaymentReadbackAvailable, false);
  assert.equal(result.verification.outcome, 'verified');
  assert.equal(result.verification.nativeNonceResolved, false);
  assert.equal(result.verification.nativeReadback, 'unavailable');
  assert.doesNotMatch(result.verification.nextStep, /retry|verify_deal/i);
  assert.deepEqual(w.ops.history(w.op.id).filter(event => event.type === 'native_nonce_pending'), []);
});

const DIAGNOSTIC_TIME = 1700000000000;
// Keep capability wall time aligned with valid provisioning, independently of
// the service clock that refusal tests change after creating the saved rows.
function diagnosticWorld(t, observation, options = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: DIAGNOSTIC_TIME });
  return world(t, observation, options);
}

for (const method of ['status', 'verifyDeal', 'cancel']) {
  test(`account lookup refuses a wrong-owner operation before secondary reads (${method})`, async t => {
    const w = diagnosticWorld(t, INCLUDED, { publicApi: method !== 'cancel' });
    w.db.prepare('UPDATE operations SET status=? WHERE id=?').run('awaiting_approval', w.op.id);
    const token = w.ops.handoffTokenFor(w.op.id), get = w.ops.get;
    w.ops.get = (_account, id) => get(w.op.accountId, id);
    const calls = [];
    w.coordinates.get = () => { calls.push('coordinates'); };
    w.ops.history = () => { calls.push('history'); };
    w.ops.handoffTokenFor = () => { calls.push('token'); };
    w.chain.networkIdentity = async () => { calls.push('chain'); };
    const run = () => method === 'status' ? w.purchases.status('TEST-other', w.op.id, token)
      : w.purchases[method]({ accountId: 'TEST-other', operationId: w.op.id, token });
    if (method === 'status') assert.throws(run, { code: 'not_found' });
    else await assert.rejects(run, { code: 'not_found' });
    assert.deepEqual(calls, []);
  });
}

for (const status of ['awaiting_approval', 'agreement_pending']) {
  test(`public expired ${status} portal/status/evidence reads never persist or offer approval`, async t => {
    const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
    w.db.prepare('UPDATE operations SET status=?, expires_at=? WHERE id=?').run(status, new Date(0).toISOString(), w.op.id);
    const before = w.ops.get(w.op.accountId, w.op.id), history = w.ops.history(w.op.id), coords = w.coordinates.get(w.op.id);
    const token = w.ops.handoffTokenFor(w.op.id);
    const portal = w.purchases.portalOperation(w.op.id, token);
    assert.deepEqual(portal, { ...before, status: 'expired' });
    const read = w.purchases.status(w.op.accountId, w.op.id, w.ops.handoffTokenFor(w.op.id));
    assert.deepEqual(portal, read.operation);
    assert.equal(read.operation.status, 'expired');
    assert.equal(read.approvalUrl, null);
    assert.match(read.next, /historical.*held/);
    const evidence = w.purchases.portalEvidence(w.op.id, token);
    assert.equal(evidence.actionable, false);
    assert.match(evidence.next, /historical.*held/);
    assert.deepEqual(w.ops.get(w.op.accountId, w.op.id), before);
    assert.deepEqual(w.ops.history(w.op.id), history);
    assert.deepEqual(w.coordinates.get(w.op.id), coords);
    assert.throws(() => w.purchases.portalOperation(w.op.id, 'TEST-wrong-token'), { code: 'not_found' });
  });
}

for (const status of ['awaiting_approval', 'agreement_pending', 'approved', 'settled_verified']) {
  test(`public portal/status preserve ${status} outside an elapsed approval window`, t => {
    const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
    const expiresAt = new Date(['approved', 'settled_verified'].includes(status) ? 0 : Date.now() + 3600000).toISOString();
    w.db.prepare('UPDATE operations SET status=?, expires_at=? WHERE id=?').run(status, expiresAt, w.op.id);
    const before = w.ops.get(w.op.accountId, w.op.id);
    assert.deepEqual(w.purchases.portalOperation(w.op.id, w.ops.handoffTokenFor(w.op.id)), before);
    assert.deepEqual(w.purchases.status(w.op.accountId, w.op.id, w.ops.handoffTokenFor(w.op.id)).operation, before);
  });
}

test('public nested protocol guidance remains historical and held', t => {
  const w = diagnosticWorld(t, INCLUDED, { publicApi: true, native: true });
  w.db.prepare('UPDATE operations SET state=? WHERE id=?').run(JSON.stringify({ protocol: { stage: 'agreement-signing' } }), w.op.id);
  const read = w.purchases.status(w.op.accountId, w.op.id, w.ops.handoffTokenFor(w.op.id));
  assert.equal(read.protocol.historical, true);
  assert.match(read.protocol.next, /historical.*held/);
  assert.match(w.purchases.portalEvidence(w.op.id, w.ops.handoffTokenFor(w.op.id)).protocol.next, /historical.*held/);
});

test('inclusion time accepts epoch milliseconds and old malformed saved times render safely', async t => {
  const w = diagnosticWorld(t, { ...INCLUDED, includedAt: 0 });
  assert.equal((await w.verify()).verification.outcome, 'verified');
  assert.equal(w.purchases.portalEvidence(w.op.id, w.ops.handoffTokenFor(w.op.id)).receipt.includedAt, '1970-01-01T00:00:00.000Z');
  const historical = w.coordinates.get(w.op.id).observation;
  historical.observation.includedAt = 'TEST-bad-time';
  w.db.prepare('UPDATE write_coordinates SET observation=? WHERE operation_id=?').run(JSON.stringify(historical), w.op.id);
  assert.equal(w.purchases.portalEvidence(w.op.id, w.ops.handoffTokenFor(w.op.id)).receipt.includedAt, null);
});

for (const method of ['portalOperation', 'portalEvidence']) {
  for (const invalid of ['forged-operation', 'missing-token', 'wrong-token', 'missing-id', 'object-token']) {
    test(`${method} authenticates ${invalid} before secondary reads`, t => {
      const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
      const token = w.ops.handoffTokenFor(w.op.id), calls = [];
      const lookup = w.ops.getByHandoff, lookups = [];
      w.ops.getByHandoff = (...args) => { lookups.push(args); return lookup(...args); };
      const args = {
        'forged-operation': [{ ...w.op, accountId: 'TEST-attacker' }, token],
        'missing-token': [w.op.id],
        'wrong-token': [w.op.id, 'TEST-wrong-token'],
        'missing-id': [undefined, token],
        'object-token': [w.op.id, { token }],
      }[invalid];
      w.coordinates.get = () => { calls.push('coordinates'); throw new Error('TEST-private-read'); };
      w.ops.history = () => { calls.push('history'); };
      assert.throws(() => w.purchases[method](...args), { code: 'not_found' });
      assert.deepEqual(calls, []);
      if (invalid !== 'wrong-token') assert.deepEqual(lookups, []);
    });
  }

  for (const mismatch of ['id', 'kind']) {
    test(`${method} rejects a host ${mismatch} mismatch before secondary reads`, t => {
      const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
      const calls = [];
      w.ops.getByHandoff = () => ({ ...w.op, [mismatch]: 'TEST-other' });
      w.coordinates.get = () => { calls.push('coordinates'); throw new Error('TEST-private-read'); };
      assert.throws(() => w.purchases[method](w.op.id, w.ops.handoffTokenFor(w.op.id)), { code: 'not_found' });
      assert.deepEqual(calls, []);
    });
  }
}

test('portal evidence authenticates each repeated read and uses fresh stored data', t => {
  const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
  const token = w.ops.handoffTokenFor(w.op.id), lookup = w.ops.getByHandoff, calls = [];
  w.ops.getByHandoff = (id, suppliedToken) => { calls.push([id, suppliedToken]); return lookup(id, suppliedToken); };
  const before = w.coordinates.get(w.op.id), history = w.ops.history(w.op.id);
  const first = w.purchases.portalEvidence(w.op.id, token);
  assert.equal(first.reportedTxHash, HASH);
  assert.equal(first.actionable, false);
  assert.deepEqual(w.purchases.portalEvidence(w.op.id, token), first);
  w.db.prepare('UPDATE operations SET state=? WHERE id=?').run(JSON.stringify({ preparedVerification: { evidence: { directoryMode: 'TEST-fresh' } } }), w.op.id);
  assert.equal(w.purchases.portalEvidence(w.op.id, token).directoryMode, 'TEST-fresh');
  assert.deepEqual(calls, Array.from({ length: 3 }, () => [w.op.id, token]));
  assert.deepEqual(w.coordinates.get(w.op.id), before);
  assert.deepEqual(w.ops.history(w.op.id), history);
  assert.equal(w.consumed(), 0);
  w.ops.getByHandoff = () => null;
  assert.throws(() => w.purchases.portalEvidence(w.op.id, token), { code: 'not_found' });
});

test('portal evidence refuses another operation handoff token', t => {
  const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
  const other = w.ops.createIdempotent({ accountId: w.op.accountId, kind: 'purchase', idempotencyKey: 'TEST-other', request: {},
    status: w.op.status, terms: w.op.terms, termsHash: CHAIN, expiresAt: w.op.expiresAt });
  assert.throws(() => w.purchases.portalEvidence(w.op.id, other.handoffToken), { code: 'not_found' });
  assert.equal(w.purchases.portalEvidence(other.operation.id, other.handoffToken).reportedTxHash, null);
});
// Diagnostic reads save nothing, on a repeat as well: an elapsed approval is
// reported as expired. Only the portal's action entry saves that transition.
for (const status of ['awaiting_approval', 'agreement_pending']) {
  test(`portal evidence and status report an elapsed ${status} approval without saving it`, t => {
    const w = diagnosticWorld(t, INCLUDED, { native: status === 'agreement_pending' });
    w.db.prepare('UPDATE operations SET status=?, expires_at=?, state=? WHERE id=?').run(status, new Date(Date.now() - 1000).toISOString(),
      JSON.stringify(status === 'agreement_pending' ? { protocol: { stage: 'agreement-pending' } } : {}), w.op.id);
    const token = w.ops.handoffTokenFor(w.op.id), events = w.ops.history(w.op.id).length;
    const writes = () => w.db.prepare('SELECT total_changes() n').get().n, before = writes();
    const transition = w.ops.transition;
    w.ops.transition = () => assert.fail('diagnostic read saved a transition');
    for (let read = 0; read < 2; read++) {
      const evidence = w.purchases.portalEvidence(w.op.id, token);
      assert.equal(evidence.actionable, false);
      if (status === 'agreement_pending') assert.equal(evidence.protocol.stage, 'agreement-pending');
      assert.equal(w.purchases.status(w.op.accountId, w.op.id).operation.status, 'expired');
    }
    assert.equal(writes(), before);
    assert.equal(w.ops.get(w.op.accountId, w.op.id).status, status);
    assert.equal(w.ops.history(w.op.id).length, events);
    w.ops.transition = transition;
    assert.equal(w.purchases.portalOperation(w.op.id, token).status, 'expired');
    assert.equal(w.ops.history(w.op.id).length, events + 1);
  });
}

for (const source of ['lookup', 'buyer-access']) {
  test(`portal evidence preserves ${source} refusals before private reads`, t => {
    const cause = new Error('TEST-host-refusal');
    const w = diagnosticWorld(t, INCLUDED, { publicApi: true, ...(source === 'buyer-access' ? { buyerRefusal: cause } : {}) });
    if (source === 'lookup') w.ops.getByHandoff = () => { throw cause; };
    const calls = [];
    w.coordinates.get = () => { calls.push('coordinates'); };
    assert.throws(() => w.purchases.portalEvidence(w.op.id, w.ops.handoffTokenFor(w.op.id)), error => error === cause);
    assert.deepEqual(calls, []);
  });
}

for (const method of ['portalOperation', 'portalEvidence']) {
  test(`${method} verifies the saved capability even when the host accepts every token`, t => {
    const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
    const token = w.ops.handoffTokenFor(w.op.id);
    w.ops.getByHandoff = () => w.ops.get(w.op.accountId, w.op.id);
    const get = w.coordinates.get, calls = [];
    w.coordinates.get = (...args) => { calls.push('coordinates'); return get(...args); };
    assert.throws(() => w.purchases[method](w.op.id, 'TEST-wrong-token'), { code: 'not_found' });
    assert.deepEqual(calls, []);
    assert.ok(w.purchases[method](w.op.id, token));
  });
}

for (const method of ['portalOperation', 'portalEvidence']) {
  for (const expiry of [null, '', 'TEST-malformed-time', new Date(0).toISOString()]) {
    test(`${method} rejects missing, malformed or expired stored handoff expiry ${expiry}`, t => {
      const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
      const token = w.ops.handoffTokenFor(w.op.id);
      w.ops.getByHandoff = () => w.op;
      w.db.prepare('UPDATE operations SET handoff_expires_at=? WHERE id=?').run(expiry, w.op.id);
      w.coordinates.get = () => assert.fail('private coordinates read before authentication');
      assert.throws(() => w.purchases[method](w.op.id, token), { code: 'not_found' });
    });
  }
  test(`${method} checks fresh stored token rotation and owner despite a permissive lookup`, t => {
    const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
    const token = w.ops.handoffTokenFor(w.op.id);
    w.ops.getByHandoff = () => w.op;
    assert.ok(w.purchases[method](w.op.id, token));
    w.db.prepare('UPDATE operations SET handoff_token_hash=? WHERE id=?').run('0'.repeat(64), w.op.id);
    assert.throws(() => w.purchases[method](w.op.id, token), { code: 'not_found' });
  });
  test(`${method} rejects a host owner mismatch for a valid capability`, t => {
    const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
    w.ops.getByHandoff = () => ({ ...w.op, accountId: 'TEST-other-owner' });
    assert.throws(() => w.purchases[method](w.op.id, w.ops.handoffTokenFor(w.op.id)), { code: 'not_found' });
  });
}

test('retained protocol readback authenticates its closed-access shortcut with the same saved capability', async t => {
  const refusal = Object.assign(new Error('TEST-closed'), { code: 'buyer_access_closed' });
  const w = diagnosticWorld(t, INCLUDED, { native: true, buyerRefusal: refusal });
  w.ops.getByHandoff = () => w.op;
  let reads = 0;
  w.protocol.readIssued = async () => { reads++; return true; };
  await assert.rejects(w.purchases.protocolRecheck({ operationId: w.op.id, token: 'TEST-wrong-token' }), { code: 'not_found' });
  assert.equal(reads, 0);
  const result = await w.purchases.protocolRecheck({ operationId: w.op.id, token: w.ops.handoffTokenFor(w.op.id) });
  assert.equal(result.verification.outcome, 'readback_only');
  assert.equal(reads, 1);
});

// All capability read paths must refuse an unknown clock before host lookups.
for (const method of ['portalOperation', 'portalEvidence', 'protocolRecheck']) {
  for (const [label, clock] of [
    ['NaN', NaN], ['undefined', undefined], ['infinity', Infinity], ['negative infinity', -Infinity],
    ['string', '0'], ['null', null], ['object', {}], ['fraction', 1.5], ['negative', -1],
    ['out of range', 8640000000000001], ['bigint', 0n], ['symbol', Symbol('TEST-clock')],
  ]) test(`${method} refuses an invalid ${label} clock before private reads`, async t => {
    let serviceClock = DIAGNOSTIC_TIME;
    const w = diagnosticWorld(t, INCLUDED, { publicApi: method !== 'protocolRecheck', native: true, now: () => serviceClock });
    const token = w.ops.handoffTokenFor(w.op.id);
    serviceClock = clock;
    const calls = [];
    w.ops.getByHandoff = () => { calls.push('operation'); return w.op; };
    w.coordinates.get = () => { calls.push('coordinates'); };
    w.protocol.readIssued = async () => { calls.push('protocol'); };
    const run = () => method === 'protocolRecheck' ? w.purchases[method]({ operationId: w.op.id, token }) : w.purchases[method](w.op.id, token);
    if (method === 'protocolRecheck') await assert.rejects(run, { code: 'not_found' });
    else assert.throws(run, { code: 'not_found' });
    assert.deepEqual(calls, []);
  });
  test(`${method} refuses an expired capability with a stale valid clock`, async t => {
    let serviceClock = DIAGNOSTIC_TIME;
    const w = diagnosticWorld(t, INCLUDED, { publicApi: method !== 'protocolRecheck', native: true, now: () => serviceClock });
    const token = w.ops.handoffTokenFor(w.op.id);
    serviceClock = 0;
    w.db.prepare('UPDATE operations SET handoff_expires_at=? WHERE id=?').run('1970-01-01T00:00:00.001Z', w.op.id);
    w.ops.getByHandoff = () => assert.fail('expired capability reached host lookup');
    const run = () => method === 'protocolRecheck' ? w.purchases[method]({ operationId: w.op.id, token }) : w.purchases[method](w.op.id, token);
    if (method === 'protocolRecheck') await assert.rejects(run, { code: 'not_found' });
    else assert.throws(run, { code: 'not_found' });
  });
}
for (const method of ['portalOperation', 'portalEvidence']) {
  test(`${method} accepts an unexpired capability with a valid clock and rechecks it on repeat`, t => {
    let clock = DIAGNOSTIC_TIME;
    const w = diagnosticWorld(t, INCLUDED, { publicApi: true, now: () => clock });
    const token = w.ops.handoffTokenFor(w.op.id);
    assert.ok(w.purchases[method](w.op.id, token));
    clock = 0;
    assert.ok(w.purchases[method](w.op.id, token));
    clock = NaN;
    assert.throws(() => w.purchases[method](w.op.id, token), { code: 'not_found' });
    clock = Date.parse('9999-01-01T00:00:00Z');
    assert.throws(() => w.purchases[method](w.op.id, token), { code: 'not_found' });
  });
}

test('purchase construction reports an actionable error for the pre-capability schema', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(PURCHASE_STATE_SCHEMA.replace('handoff_expires_at TEXT,', ''));
  assert.throws(() => createPublicPurchaseService({ db, config: {}, store: createSqlitePurchaseStore(), purposes: { APPROVE_PURCHASE: 'TEST-approve' } }),
    error => error.code === 'schema_migration_required' && /handoff_expires_at/.test(error.message));
  db.exec('ALTER TABLE operations ADD COLUMN handoff_expires_at TEXT');
  assert.ok(createPublicPurchaseService({ db, config: {}, store: createSqlitePurchaseStore(), purposes: { APPROVE_PURCHASE: 'TEST-approve' } }));
});

// Wire vector pinned to the original store's hashHandoffToken contract:
// 9d820e0:packages/dacs-client/test/helpers/purchase-integrity-operations.mjs:43.
test('portal capabilities accept the pinned exact-byte hash vector', t => {
  const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
  w.db.prepare('UPDATE operations SET handoff_token_hash=? WHERE id=?').run(
    'afe0c673f2027d951dfa05cecb56c758114474d50893b91004207d3733a4fb55', w.op.id);
  w.ops.getByHandoff = () => w.op;
  for (const method of ['portalOperation', 'portalEvidence']) {
    assert.ok(w.purchases[method](w.op.id, 'TEST-capability-vector'));
    assert.throws(() => w.purchases[method](w.op.id, 'TEST-capability-vector '), { code: 'not_found' });
  }
});

// Account and operation IDs are labels, not read capabilities.
for (const method of ['status']) {
  for (const proof of ['missing', 'wrong', 'other-operation', 'expired']) {
    test(`public ${method} refuses a known owner/id with ${proof} capability`, async t => {
      const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
      let token = proof === 'missing' ? undefined : proof === 'wrong' ? 'TEST-wrong-token' : w.ops.handoffTokenFor(w.op.id);
      if (proof === 'other-operation') token = w.ops.createIdempotent({ accountId: w.op.accountId, kind: 'purchase',
        idempotencyKey: 'TEST-other-read', request: {}, status: w.op.status, terms: w.op.terms,
        termsHash: CHAIN, expiresAt: w.op.expiresAt }).handoffToken;
      if (proof === 'expired') w.db.prepare('UPDATE operations SET handoff_expires_at=? WHERE id=?').run('1970-01-01T00:00:00.000Z', w.op.id);
      w.ops.getByHandoff = () => w.op; // Host lookup deliberately grants no protection.
      w.coordinates.get = () => assert.fail('unauthenticated coordinate read');
      w.ops.history = () => assert.fail('unauthenticated history read');
      w.chain.networkIdentity = async () => assert.fail('unauthenticated chain read');
      const run = () => method === 'status' ? w.purchases.status(w.op.accountId, w.op.id, token)
        : w.purchases.verifyDeal({ accountId: w.op.accountId, operationId: w.op.id, token });
      if (method === 'status') assert.throws(run, { code: 'not_found' });
      else await assert.rejects(run, { code: 'not_found' });
    });
  }
  test(`public ${method} accepts its capability and rechecks expiry on repeat`, async t => {
    const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
    const token = w.ops.handoffTokenFor(w.op.id);
    const read = () => method === 'status' ? w.purchases.status(w.op.accountId, w.op.id, token)
      : w.purchases.verifyDeal({ accountId: w.op.accountId, operationId: w.op.id, token });
    assert.equal((await read()).operation.id, w.op.id);
    w.db.prepare('UPDATE operations SET handoff_expires_at=? WHERE id=?').run('1970-01-01T00:00:00.000Z', w.op.id);
    if (method === 'status') assert.throws(read, { code: 'not_found' });
    else await assert.rejects(read, { code: 'not_found' });
  });
}

for (const method of ['portalOperation', 'portalEvidence']) {
  for (const format of ['sqlite', 'local-iso', 'offset', 'epoch-text', 'normalized-date']) {
    test(`${method} refuses ambiguous or noncanonical ${format} expiry`, t => {
      const w = diagnosticWorld(t, INCLUDED, { publicApi: true });
      const token = w.ops.handoffTokenFor(w.op.id), iso = new Date(Date.now() + 3600000).toISOString();
      const expiry = { sqlite: iso.slice(0, 19).replace('T', ' '), 'local-iso': iso.slice(0, -1),
        offset: iso.replace('Z', '+00:00'), 'epoch-text': String(Date.now() + 3600000),
        'normalized-date': '9999-02-30T00:00:00.000Z' }[format];
      w.db.prepare('UPDATE operations SET handoff_expires_at=? WHERE id=?').run(expiry, w.op.id);
      w.ops.getByHandoff = () => assert.fail('invalid expiry reached private host lookup');
      assert.throws(() => w.purchases[method](w.op.id, token), { code: 'not_found' });
    });
  }
}
