import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseService as createPublicPurchaseService, createCoordinateStore, createProtocolPurchases, createSqlitePurchaseStore } from '@kynesyslabs/dacs-client';
import { createPayDemSellerObserver } from '@kynesyslabs/dacs/seller';
import { createPurchaseService } from '../src/purchases.mjs';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';

const HASH = '1'.repeat(64), CHAIN = 'f'.repeat(64), WALLET = '0x' + 'a'.repeat(64), PAYEE = '0x' + '7'.repeat(64);
const INCLUDED = { status: 'included', txHash: HASH, payer: WALLET, payee: PAYEE, amountOs: '2500000000', blockNumber: 10 };
function world(t, observation, { native = false, observer = 'TEST-host-reader', buyerRefusal = null, buyerAccess = null, signingAddress = WALLET, publicApi = false } = {}) {
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
  const protocol = native || buyerRefusal || buyerAccess ? createProtocolPurchases({ db, ops, coordinates, store,
    buyerAccess: buyerRefusal ? { assertWallet() { throw buyerRefusal; } } : buyerAccess }) : null;
  const purchases = (publicApi ? createPublicPurchaseService : createPurchaseService)({ db, ops, coordinates, config: {}, chain, protocol, store, purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  return { db, chain, protocol, coordinates, op, ops, purchases, fixReader() { observation = { ...INCLUDED }; },
    consumed: () => db.prepare('SELECT count(*) n FROM wallet_nonce_consumptions').get().n,
    verify: () => purchases.verifyDeal({ accountId: op.accountId, operationId: op.id }) };
}

for (const method of ['status', 'verifyDeal', 'cancel']) {
  test(`account lookup refuses a wrong-owner operation before secondary reads (${method})`, async t => {
    const w = world(t, INCLUDED, { publicApi: method !== 'cancel' });
    w.db.prepare('UPDATE operations SET status=? WHERE id=?').run('awaiting_approval', w.op.id);
    const get = w.ops.get;
    w.ops.get = (_account, id) => get(w.op.accountId, id);
    const calls = [];
    w.coordinates.get = () => { calls.push('coordinates'); };
    w.ops.history = () => { calls.push('history'); };
    w.ops.handoffTokenFor = () => { calls.push('token'); };
    w.chain.networkIdentity = async () => { calls.push('chain'); };
    const run = () => method === 'status' ? w.purchases.status('TEST-other', w.op.id)
      : w.purchases[method]({ accountId: 'TEST-other', operationId: w.op.id });
    if (method === 'status') assert.throws(run, { code: 'not_found' });
    else await assert.rejects(run, { code: 'not_found' });
    assert.deepEqual(calls, []);
  });
}

test('public readback preserves a host access refusal before chain reads', async t => {
  const cause = new Error('TEST-revoked');
  const w = world(t, INCLUDED, { publicApi: true, buyerRefusal: cause });
  const calls = [];
  w.coordinates.get = () => { calls.push('coordinates'); throw new Error('TEST-denied-coordinate-read'); };
  w.chain.networkIdentity = async () => { calls.push('chain'); };
  await assert.rejects(w.verify(), error => error === cause);
  assert.deepEqual(calls, []);
});

test('public readback honors an allowed buyer capability for the authenticated owner', async t => {
  const checked = [];
  const w = world(t, INCLUDED, { publicApi: true, buyerAccess: { assertWallet(address) { checked.push(address); } } });
  assert.equal((await w.verify()).verification.termsMatch, true);
  assert.deepEqual(checked, [WALLET]);
});

test('public readback does not bypass a missing-capability refusal', async t => {
  const cause = Object.assign(new Error('TEST-missing-capability'), { code: 'buyer_access_closed', details: { buyerAccessMissing: true } });
  const w = world(t, INCLUDED, { publicApi: true, buyerRefusal: cause });
  await assert.rejects(w.verify(), error => error === cause);
});

test('account lookup refuses an operation with another id', async t => {
  const w = world(t, INCLUDED, { publicApi: true });
  w.ops.get = () => ({ ...w.op, id: 'TEST-other-operation' });
  assert.throws(() => w.purchases.status(w.op.accountId, w.op.id), { code: 'not_found' });
  await assert.rejects(w.verify(), { code: 'not_found' });
});

test('public readback allows a closed buyer capability only for its recorded hash', async t => {
  const cause = Object.assign(new Error('TEST-closed'), { code: 'buyer_access_closed' });
  const w = world(t, INCLUDED, { publicApi: true, buyerRefusal: cause });
  assert.deepEqual((await w.verify()).verification.observation, INCLUDED);
  await assert.rejects(w.purchases.verifyDeal({ accountId: w.op.accountId, operationId: w.op.id, txHash: '2'.repeat(64) }), error => error === cause);
  w.coordinates.get = () => null;
  await assert.rejects(w.verify(), error => error === cause);
});

test('public readback refuses a hash other than its saved pointer before reading the chain', async t => {
  const w = world(t, INCLUDED, { publicApi: true });
  const calls = [];
  w.chain.networkIdentity = async () => { calls.push('chain'); };
  await assert.rejects(w.purchases.verifyDeal({ accountId: w.op.accountId, operationId: w.op.id, txHash: '2'.repeat(64) }), { code: 'invalid_state' });
  assert.deepEqual(calls, []);
});

for (const [label, observation] of [
  ['Number amount', { ...INCLUDED, amountOs: 2500000000 }],
  ['bigint amount', { ...INCLUDED, amountOs: 2500000000n }],
  ['noncanonical amount', { ...INCLUDED, amountOs: '02500000000' }],
  ['missing amount', { ...INCLUDED, amountOs: undefined }],
  ['non-string payer', { ...INCLUDED, payer: 7 }],
  ['unreadable payee', { ...INCLUDED, payee: 'TEST-invalid' }],
  ['string block', { ...INCLUDED, blockNumber: '10' }],
  ['string inclusion time', { ...INCLUDED, includedAt: 'TEST-time' }],
  ['out of range inclusion time', { ...INCLUDED, includedAt: 8640000000000001 }],
  ['different hash', { ...INCLUDED, txHash: '2'.repeat(64) }],
  ['bigint extension', { ...INCLUDED, extra: 1n }],
  ['null result', null],
  ['non-string reason', { status: 'failed', reason: 7 }],
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


for (const native of [false, true]) {
test(`public host readers remain diagnostic and cannot settle or consume a nonce (native=${native})`, async t => {
  const w = world(t, INCLUDED, { publicApi: true, native });
  const before = w.coordinates.get(w.op.id), history = w.ops.history(w.op.id);
  const result = await w.verify();
  assert.equal(result.verification.outcome, 'readback_only');
  assert.equal(result.verification.authority, 'unqualified_host');
  assert.deepEqual(result.verification.observation, INCLUDED);
  assert.equal(w.ops.get(w.op.accountId, w.op.id).status, 'broadcast_reported');
  assert.deepEqual(w.coordinates.get(w.op.id), before);
  assert.deepEqual(w.ops.history(w.op.id), history);
  assert.equal(w.consumed(), 0);
  for (const attachOnly of [false, true]) {
    const diagnostic = await w.purchases.verifyDeal({ accountId: w.op.accountId, operationId: w.op.id,
      txHash: HASH, attachOnly });
    assert.equal(diagnostic.verification.outcome, 'readback_only');
    await assert.rejects(w.purchases.verifyDeal({ accountId: w.op.accountId, operationId: w.op.id,
      txHash: '2'.repeat(64), attachOnly }), { code: 'invalid_state' });
    assert.deepEqual(w.coordinates.get(w.op.id), before, 'optional hashes are never attached');
    assert.deepEqual(w.ops.history(w.op.id), history);
  }
  for (const method of ['cancel', 'reportWalletResult', 'protocolRecheck']) {
    await assert.rejects(w.purchases[method]({ accountId: w.op.accountId, operationId: w.op.id }), { code: 'profile_not_admitted' });
  }
});
}

for (const status of ['awaiting_approval', 'agreement_pending']) {
  test(`public expired ${status} portal/status/evidence reads never persist or offer approval`, t => {
    const w = world(t, INCLUDED, { publicApi: true });
    w.db.prepare('UPDATE operations SET status=?, expires_at=? WHERE id=?').run(status, new Date(0).toISOString(), w.op.id);
    const before = w.ops.get(w.op.accountId, w.op.id), history = w.ops.history(w.op.id), coords = w.coordinates.get(w.op.id);
    const token = w.ops.handoffTokenFor(w.op.id);
    const portal = w.purchases.portalOperation(w.op.id, token);
    assert.deepEqual(portal, { ...before, status: 'expired' });
    const read = w.purchases.status(w.op.accountId, w.op.id);
    assert.deepEqual(portal, read.operation);
    assert.equal(read.operation.status, 'expired');
    assert.equal(read.approvalUrl, null);
    assert.match(read.next, /historical.*held/);
    const evidence = w.purchases.portalEvidence(portal);
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
    const w = world(t, INCLUDED, { publicApi: true });
    const expiresAt = new Date(['approved', 'settled_verified'].includes(status) ? 0 : Date.now() + 3600000).toISOString();
    w.db.prepare('UPDATE operations SET status=?, expires_at=? WHERE id=?').run(status, expiresAt, w.op.id);
    const before = w.ops.get(w.op.accountId, w.op.id);
    assert.deepEqual(w.purchases.portalOperation(w.op.id, w.ops.handoffTokenFor(w.op.id)), before);
    assert.deepEqual(w.purchases.status(w.op.accountId, w.op.id).operation, before);
  });
}

for (const sourceDisposition of [undefined, 'included', 'failed', 'pending', 'not-found', null]) {
  test(`public native diagnostic terms match respects source disposition ${String(sourceDisposition)}`, async t => {
    const w = world(t, INCLUDED, { publicApi: true, native: true });
    const observation = { ...INCLUDED, ...(sourceDisposition === undefined ? {} : { sourceDisposition }) };
    w.chain.observePurchaseTransfer = async () => observation;
    w.chain.observeTransfer = async () => { throw new Error('TEST-wrong-reader'); };
    const before = w.coordinates.get(w.op.id), history = w.ops.history(w.op.id);
    const result = await w.verify();
    assert.deepEqual(result.verification.observation, observation);
    assert.equal(result.verification.termsMatch, sourceDisposition === undefined || sourceDisposition === 'included' ? true : null);
    assert.deepEqual(w.coordinates.get(w.op.id), before);
    assert.deepEqual(w.ops.history(w.op.id), history);
    assert.equal(w.consumed(), 0);
  });
}

test('handoff lookup rejects an operation with another id before buyer or coordinate reads', t => {
  const w = world(t, INCLUDED, { publicApi: true });
  w.ops.getByHandoff = () => ({ ...w.op, id: 'TEST-other-operation' });
  assert.throws(() => w.purchases.portalOperation(w.op.id, 'TEST-token'), { code: 'not_found' });
});

test('public nested protocol guidance remains historical and held', t => {
  const w = world(t, INCLUDED, { publicApi: true, native: true });
  w.db.prepare('UPDATE operations SET state=? WHERE id=?').run(JSON.stringify({ protocol: { stage: 'agreement-signing' } }), w.op.id);
  const read = w.purchases.status(w.op.accountId, w.op.id);
  assert.equal(read.protocol.historical, true);
  assert.match(read.protocol.next, /historical.*held/);
  assert.match(w.purchases.portalEvidence(read.operation).protocol.next, /historical.*held/);
});

for (const field of ['payer', 'payee', 'amountOs']) {
  test(`public diagnostic explicitly reports a ${field} mismatch`, async t => {
    const value = { ...INCLUDED, [field]: field === 'amountOs' ? '1' : '0x' + 'c'.repeat(64) };
    const w = world(t, value, { publicApi: true });
    const result = await w.verify();
    assert.equal(result.verification.observation.status, 'included');
    assert.equal(result.verification.termsMatch, false);
    w.fixReader();
    assert.equal((await w.verify()).verification.termsMatch, true);
  });
}

for (const failure of [null, undefined, 'TEST-reader-failed']) {
  for (const publicApi of [false, true]) {
    test(`reader rejection ${String(failure)} remains unavailable (public=${publicApi})`, async t => {
      const cause = Object.assign(new Error('TEST-closed'), { code: 'buyer_access_closed' });
      const w = world(t, INCLUDED, { publicApi, buyerRefusal: cause });
      w.chain.observeTransfer = async () => { throw failure; };
      const result = await w.verify();
      assert.equal(result.verification.observation.status, 'unavailable');
      assert.equal(result.verification.observation.reason, String(failure));
      assert.equal(result.verification.termsMatch ?? null, null);
    });
  }
}

for (const failure of [null, undefined, 'TEST-reader-failed', new Error('TEST-long-'.repeat(100))]) {
  test(`ordinary retained readback converts and bounds reader rejection ${String(failure).slice(0, 40)}`, async t => {
    const w = world(t, INCLUDED);
    const reader = w.chain.observeTransfer;
    w.chain.observeTransfer = async () => { throw failure; };
    const result = await w.verify();
    assert.equal(result.verification.outcome, 'chain_unavailable');
    assert.equal(result.verification.observation.status, 'unavailable');
    assert.equal(result.verification.observation.reason, String(failure?.message ?? failure).slice(0, 240));
    assert.equal(result.operation.status, 'broadcast_reported');
    assert.equal(w.coordinates.get(w.op.id).reportedTxHash, HASH);
    assert.equal(w.consumed(), 0);
    w.chain.observeTransfer = reader;
    assert.equal((await w.verify()).verification.outcome, 'verified');
  });
}

test('inclusion time accepts epoch milliseconds and old malformed saved times render safely', async t => {
  const w = world(t, { ...INCLUDED, includedAt: 0 });
  assert.equal((await w.verify()).verification.outcome, 'verified');
  assert.equal(w.purchases.portalEvidence(w.ops.get(w.op.accountId, w.op.id)).receipt.includedAt, '1970-01-01T00:00:00.000Z');
  const historical = w.coordinates.get(w.op.id).observation;
  historical.observation.includedAt = 'TEST-bad-time';
  w.db.prepare('UPDATE write_coordinates SET observation=? WHERE operation_id=?').run(JSON.stringify(historical), w.op.id);
  assert.equal(w.purchases.portalEvidence(w.ops.get(w.op.accountId, w.op.id)).receipt.includedAt, null);
});

test('public diagnostic reads validate malformed observations without saving them', async t => {
  const w = world(t, { ...INCLUDED, amountOs: 1n }, { publicApi: true });
  const before = w.coordinates.get(w.op.id);
  const first = await w.verify();
  assert.equal(first.verification.outcome, 'readback_only');
  assert.equal(first.verification.observation.status, 'malformed');
  assert.doesNotThrow(() => JSON.stringify(first));
  w.fixReader();
  assert.deepEqual((await w.verify()).verification.observation, INCLUDED);
  assert.deepEqual(w.coordinates.get(w.op.id), before);
});


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

test('wallet-access-closed readback refuses non-JSON observation fields', async t => {
  const cause = Object.assign(new Error('TEST-closed'), { code: 'buyer_access_closed' });
  const w = world(t, { ...INCLUDED, amountOs: 1n }, { buyerRefusal: cause });
  const result = await w.verify();
  assert.equal(result.verification.outcome, 'readback_only');
  assert.equal(result.verification.observation.status, 'malformed');
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(w.consumed(), 0);
});

test('public diagnostics re-read saved settlements and never report saved success as fresh verification', async t => {
  const w = world(t, { status: 'pending' }, { publicApi: true });
  w.coordinates.recordObservation(w.op.id, { ...INCLUDED, txHash: HASH }, true);
  w.ops.transition(w.op.id, 'broadcast_reported', 'settled_verified');
  const before = w.coordinates.get(w.op.id), result = await w.verify();
  assert.equal(result.verification.outcome, 'readback_only');
  assert.deepEqual(result.verification.observation, { status: 'pending' });
  assert.deepEqual(w.coordinates.get(w.op.id), before);
  assert.equal(w.purchases.portalEvidence(w.ops.get(w.op.accountId, w.op.id)).receipt.historical, true);
});
