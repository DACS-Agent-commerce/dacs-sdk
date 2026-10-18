// The cancel/send exclusion with main's failed native payments (a transfer
// whose execution failed is read back failed at the saved nonce fence, and its
// purchase may then be cancelled). The failed lane is resolved, so it is no
// claim and blocks no next lease; and that cancellation keeps the payment's
// exact transfer at the operator's source as cancel_wallet_handoff does, so a
// re-signed copy (the same prepared payload, another fee and hash) is never
// confirmed or sent, and a source that claimed the transfer meanwhile keeps
// the purchase uncancelled. Offline: the Node2 coverage fixture's .invalid
// stub and in-memory journal; nothing is confirmed or broadcast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admittedTransport, CHAIN, layoutAdmission, layoutChain, memoryJournal, NETWORK, NOW, sha } from './helpers/review-node2-current-coverage-fixture.mjs';
import { AMOUNT, FEES, PAYER, PAYEE, intentKey, issuedRow, laneKey, node2Projection, sdkHeaders, signedContent, signTransaction } from './helpers/review-native-readback-current-fixture.mjs';
import { openDatabase } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { createProtocolPurchases } from '../src/dacs/protocol-purchases.mjs';
import { NATIVE_AGREEMENT_PAYMENT } from '../src/dacs/native-agreement-payment-consumer.mjs';
import { nativePayloadDigest } from '../public/portal/embedded-wallet/sdk-provider.mjs';

const BLOCK = sha('native-payment-cancel-failed-lane:block-10');
const key = (kind) => `devnet/${kind}/${JSON.stringify([NETWORK, CHAIN, PAYER])}`;
// The unsigned payload the plugin hands the wallet; signing keeps its digest.
const prepared = (content = signedContent()) => ({ content: { type: content.type, from: content.from, to: content.to, amount: content.amount, data: content.data, nonce: content.nonce, timestamp: content.timestamp } });
const named = async (payload) => ({ nonce: payload.content.nonce, to: payload.content.to.toLowerCase(), amountOs: AMOUNT, payloadDigest: await nativePayloadDigest(payload.content) });
const refused = (code) => (e) => e.code === code;

// Purchase A's native payment was sent through the source (retained
// broadcast-accepted) and its execution failed; the buyer nonce is still the
// saved fence 6, so the payment nonce 7 is free.
async function world(t) {
  const signed = signTransaction(signedContent()), journal = memoryJournal();
  const run = admittedTransport(await layoutAdmission(), {
    ...layoutChain(),
    getTransactionStatus: { result: 200, response: { state: 'included', blockNumber: 10 } },
    getTxByHash: { result: 200, response: { hash: signed.hash, status: 'failed', blockNumber: 10, content: node2Projection(signed.content, signed.hash) } },
    getAddressNonce: { result: 200, response: { nonce: 6 } },
    10: { result: 200, response: { number: 10, status: 'confirmed', hash: BLOCK, content: { timestamp: 1_900_000_000_123, ordered_transactions: [signed.hash] } } },
  }, { journal });
  const source = run.capability;
  t.after(() => source.close());
  const bind = () => source.binding({ phase: 'bind', address: PAYER });
  const issued = issuedRow(signed, (await bind()).binding);
  journal.seed(intentKey(signed.hash), issued); journal.seed(laneKey(PAYER), issued);
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date().toISOString());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-only-cancel-failed-lane-secret-00000000' }), coordinates = createCoordinateStore({ db });
  const terms = { buyer: { wallet: PAYER }, seller: { payee: PAYEE }, price: { amountOs: AMOUNT }, listing: { listingId: 'TEST-listing', version: 1, contentHash: sha('TEST-listing') }, network: NETWORK, rail: 'demos-native:DEM',
    domain: { network: NETWORK, rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN },
    protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: NATIVE_AGREEMENT_PAYMENT, sellerAgreementProjection: 'public-signed-create', transportBinding: source.transportBinding } };
  const purchase = (name, status, payload) => {
    const op = ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: name, request: { name }, status, terms, termsHash: sha(name), expiresAt: new Date(Date.now() + 60000).toISOString(), state: { protocol: { stage: 'seller-committed' } } }).operation;
    coordinates.save({ operationId: op.id, kind: 'native-dem-transfer', network: NETWORK, from: PAYER, nonceFence: 6, expectedNonce: 7, target: PAYEE, amountOs: AMOUNT, payload });
    return op;
  };
  const protocol = createProtocolPurchases({ db, ops, coordinates, dacsProtocol: { sellerEndpoint: () => source.pins.endpoint, sellerSr2Commitment: { commitmentSubstrate: 'fixture', publicProjection: true },
    walletAgreement: { rpcUrl: source.pins.endpoint, network: NETWORK, sourceCapability: source, journal, bridgeFor: () => null }, nativeAgreementPayment: source } });
  const chain = { ...source.chainReader(), networkIdentity: async () => ({ identity: (await source.observeBinding()).chainIdentity, mode: 'public-chain-read' }) };
  const purchases = createPurchaseService({ db, config: {}, ops, coordinates, chain, protocol });
  const a = purchase('TEST-failed-A', 'payment_uncertain', prepared());
  coordinates.reportHash(a.id, signed.hash);
  const failed = await purchases.verifyDeal({ accountId: 'TEST-buyer', operationId: a.id });
  assert.equal(failed.verification.outcome, 'execution_failed', JSON.stringify(failed.verification));
  return { run, source, journal, signed, ops, coordinates, purchases, purchase, a, bind,
    cancel: (op) => purchases.cancel({ accountId: 'TEST-buyer', operationId: op.id }),
    status: (op) => ops.get('TEST-buyer', op.id).status,
    record: async () => (await journal.get(key('cancelled-payments')))?.transfers?.map(({ cancelledAt, ...rest }) => rest) ?? [],
    claims: async () => (await journal.get(key('transfer-claims')))?.claims ?? [],
    sends: () => run.stub.messages().filter((m) => ['confirmTx', 'broadcastTx'].includes(m)) };
}

test('a payment cancelled after its execution failed: the source keeps its exact transfer, so a re-signed copy is refused at the lease and at confirmTx; nothing reaches the node', async (t) => {
  const w = await world(t);
  const cancelled = await w.cancel(w.a);
  assert.deepEqual([cancelled.cancelled, cancelled.operation.status], [true, 'cancelled']);
  assert.equal((await w.journal.get(intentKey(w.signed.hash))).stage, 'failed');
  assert.equal((await w.bind()).pending, null, 'the failed lane is released');
  const transfer = await named(prepared());
  assert.deepEqual(await w.record(), [{ ...transfer, operationId: w.a.id }], 'kept before cancelled: true was answered');
  // The same prepared payload signed again with another fee: another hash, the same transfer.
  const copy = signTransaction({ ...signedContent(), transaction_fee: { ...FEES, rpc_fee: '2000000001', rpc_address: null } });
  assert.notEqual(copy.hash, w.signed.hash);
  assert.equal(await nativePayloadDigest(copy.content), transfer.payloadDigest);
  const { binding } = await w.bind();
  await assert.rejects(w.source.binding({ phase: 'signature', address: PAYER, binding, transfer }), refused('payment_cancelled'), 'a lease naming it');
  const lease = await w.source.binding({ phase: 'signature', address: PAYER, binding });
  try {
    await assert.rejects(w.source.rpc({ method: 'execute', params: [{ extra: 'confirmTx', data: copy }] }, sdkHeaders()), refused('payment_cancelled'), 'a lease naming nothing: its confirmTx');
  } finally { await w.source.binding({ phase: 'release', address: PAYER, leaseId: lease.leaseId }); }
  assert.deepEqual(w.sends(), [], 'nothing reached the node');
  assert.deepEqual(await w.claims(), []);
  assert.equal(w.status(w.a), 'cancelled');
});

test('a failed lane is resolved, not a claim: the buyer\'s next handoff at the free nonce can lease its transfer, and is cancelled when declined', async (t) => {
  const w = await world(t);
  assert.equal((await w.cancel(w.a)).cancelled, true);
  // Purchase B at the same free nonce, its own payload and amount. A payload
  // with A's settlement terms would settle the cancelled A if it were sent, so
  // it stays refused (a real next purchase pays after its own CREATE, at a
  // later nonce).
  const OTHER = '2500000001';
  const payloadB = prepared({ ...signedContent(), amount: OTHER, data: ['native', { nativeOperation: 'send', args: [PAYEE, OTHER] }], timestamp: signedContent().timestamp + 1 });
  const b = w.purchase('TEST-next-B', 'payment_handoff', payloadB), transferB = { ...await named(payloadB), amountOs: OTHER };
  assert.equal(await w.source.nativeTransferClaimed(PAYER, payloadB), null, 'the failed lane is no claim on B');
  const { binding } = await w.bind();
  const sameTerms = await named(prepared({ ...signedContent(), timestamp: signedContent().timestamp + 1 }));
  await assert.rejects(w.source.binding({ phase: 'signature', address: PAYER, binding, transfer: sameTerms }), refused('payment_cancelled'), 'A\'s terms in another payload');
  const lease = await w.source.binding({ phase: 'signature', address: PAYER, binding, transfer: transferB });
  assert.deepEqual((await w.claims()).map(({ leaseId, expiresAt, ...rest }) => rest), [transferB], 'B\'s lease is granted and claimed');
  await w.source.binding({ phase: 'release', address: PAYER, leaseId: lease.leaseId });
  assert.deepEqual(await w.claims(), []);
  const declined = await w.cancel(b);
  assert.deepEqual([declined.cancelled, declined.operation.status, declined.message], [true, 'cancelled', undefined], JSON.stringify(declined));
  assert.deepEqual((await w.record()).map((r) => r.operationId), [w.a.id, b.id]);
  assert.deepEqual(w.sends(), []);
});

test('the failed payment\'s cancellation and a lease naming its transfer exclude each other: a lease another process takes once the failed lane is released keeps the purchase uncancelled; nothing is recorded', async (t) => {
  const w = await world(t);
  const transfer = await named(prepared()), put = w.journal.put;
  let leased = false;
  // Right after the source releases the failed lane (under its lane lock),
  // another process's signature lease naming this transfer is granted, before
  // the cancellation takes the lock again to keep the transfer.
  w.journal.put = async (k, value) => {
    await put(k, value);
    if (!leased && k === laneKey(PAYER) && value?.stage === 'failed') {
      leased = true;
      await put(key('transfer-claims'), { transferClaims: 'dacs-chatgpt-plugin/native-transfer-claims/v1', claims: [{ leaseId: 'b'.repeat(32), ...transfer, expiresAt: new Date(NOW + 60_000).toISOString() }] });
    }
  };
  const result = await w.cancel(w.a);
  assert.equal(leased, true, 'the source released the failed lane');
  assert.deepEqual([result.cancelled, result.operation.status], [false, 'payment_uncertain'], JSON.stringify(result));
  assert.deepEqual(await w.record(), [], 'not kept as cancelled: the other process may send it');
  assert.equal(await w.source.nativeTransferClaimed(PAYER, prepared()), 'signature-lease');
  assert.deepEqual(w.sends(), []);
});
