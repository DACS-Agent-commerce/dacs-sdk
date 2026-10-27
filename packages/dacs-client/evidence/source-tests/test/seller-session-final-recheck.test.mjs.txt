// Unit-level routing of a native-evidence recheck after delivery is final
// (the end-to-end readback is seller-session-final-readback.test.mjs). A
// delegated final purchase with a retained answer is readback-only: no session authentication or
// seller request, but a fresh native read that downgrades the current delivery
// when it does not verify, exactly like a custody purchase. Nothing here
// leaves the process: the native RPC and the seller are recording stubs.
import test from 'node:test';
import { fork } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { createAccountService } from '../src/accounts.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createProtocolPurchases, protocolView, OFFLINE_AGREEMENT_PROFILE } from '../src/dacs/protocol-purchases.mjs';
import { NATIVE_AGREEMENT_PAYMENT } from '../src/dacs/native-agreement-payment-consumer.mjs';
import { NATIVE_PAYMENT_EVIDENCE, createNativePaymentEvidenceConsumer } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { createSourceDemoSellerTransport } from '../src/dacs/source-demo-seller-transport.mjs';
import { createInMemoryDemosSr2Journal } from '../src/dacs/demos-sr2-adapter.mjs';
import { SELLER_SR2_PUBLIC_PROJECTION } from '../src/dacs/seller-sr2-agreement-consumer.mjs';
import { SELLER_SESSION_KEY_GRACE_MS, sellerSessionKeyRetirement } from '../src/devnet-demo/operator-sessions.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { FIXTURE_LISTING, boundTerms, retainedAnswerFixture } from './helpers/retained-answer-fixture.mjs';

const RPC = 'http://127.0.0.1:9/', SELLER = 'http://127.0.0.1:1';
const retired = () => Object.assign(new Error('the seller session key for this purchase was deleted after the purchase ended; nothing new can be sent to the seller with it'), { code: 'seller_session_retired' });

function world(t, { delegated, stage = 'delivery-ready', pointer = true, keyDeleted = false, injectAnswer = false, dbPath = ':memory:', beforeRead = null }) {
  const time = Date.parse('2026-10-08T12:00:00Z'), now = () => time, db = openDatabase(dbPath); t.after(() => db.close());
  const accounts = createAccountService({ db, builtinIssuer: 'https://plugin.example/oauth', now });
  const account = accounts.resolveFromToken({ issuer: 'https://issuer.example', subject: 'TEST-buyer' });
  const ops = createOperationStore({ db, handoffSecret: 'TEST-only-secret'.repeat(4), now }), coordinates = createCoordinateStore({ db, now });
  const buyer = createEphemeralWallet(), seller = createEphemeralWallet(), rpcReads = [], sellerRequests = [], authentications = [];
  const fetchImpl = async (input) => {
    const url = new URL(input);
    (url.origin === new URL(RPC).origin ? rpcReads : sellerRequests).push(url.pathname);
    await beforeRead?.();
    throw new Error('TEST loopback stub is unreachable');
  };
  const transport = createSourceDemoSellerTransport({ authority: 'TEST-final-recheck',
    ...(delegated ? { sessionDelegation: { request: () => { throw new Error('TEST no new delegation'); }, accept: () => { throw new Error('TEST no new delegation'); } } } : {}),
    authenticationFor: (operation) => { authentications.push(operation.id); if (keyDeleted) throw retired(); throw new Error('TEST seller authentication unavailable'); } });
  const jobId = '01ARZ3NDEKTSV4RRFFQ69G5FAV', report = { jobId, settlementId: 'TEST-settlement', TEST: 'purchased report' };
  const delivery = { status: 'delivery-ready', fulfilmentId: 'TEST-fulfilment', deliverableRef: { anchor: { kind: 'storage-program', locator: `dacs4:deliverable:${jobId}` }, contentHash: 'f'.repeat(64) },
    anchorReceipt: { TEST: 'receipt' }, payloadHash: 'f'.repeat(64), evidenceHash: 'e'.repeat(64), deliveredAt: time - 1000, report };
  // A payment projection and receipt bound the way retirement requires.
  const bound = retainedAnswerFixture({ buyer, seller, jobId, time });
  const sellerAnswer = { status: 'payment-evidenced', settlementId: report.settlementId, evidenceAddress: bound.sellerAnswer.evidenceAddress, signedProjection: bound.sellerAnswer.signedProjection,
    delivery: { status: 'delivery-ready', fulfilmentId: delivery.fulfilmentId, logicalAddress: delivery.deliverableRef.anchor.locator, contentHash: delivery.payloadHash, evidenceHash: delivery.evidenceHash, anchorReceipt: delivery.anchorReceipt } };
  const terms = { buyer: { wallet: buyer.address }, ...boundTerms({ seller }), listing: { ...FIXTURE_LISTING },
    network: 'TEST', domain: { mode: 'simulated-fixture' },
    protocol: { profile: OFFLINE_AGREEMENT_PROFILE, jobId, sellerAgent: SELLER, substrate: 'TEST', nativePayment: NATIVE_AGREEMENT_PAYMENT, sellerAgreementProjection: SELLER_SR2_PUBLIC_PROJECTION,
      nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE, sellerTransport: transport.declaration } };
  const protocol = { stage, attempts: [], paymentEvidence: bound.paymentEvidence,
    agreement: { ...bound.agreement, anchorReceipt: { nativeAddress: 'TEST', transactionRef: { value: 'b'.repeat(64) } } },
    ...(stage === 'payment-evidenced' ? {} : { delivery }), ...((delegated && pointer) || injectAnswer ? { sellerAnswer } : {}),
    ...(delegated ? { sessionDelegation: { payload: { expiresAt: time + 3600000 } } } : {}) };
  const { operation } = ops.createIdempotent({ accountId: account.id, kind: 'purchase', idempotencyKey: 'TEST', request: {}, status: 'settled_verified', terms, termsHash: 'd'.repeat(64),
    expiresAt: new Date(time + 86400000).toISOString(), state: { protocol } });
  coordinates.save({ operationId: operation.id, kind: 'purchase', network: 'TEST', from: buyer.address, target: seller.address, nonceFence: 0, expectedNonce: 1, payload: {} });
  coordinates.reportHash(operation.id, '9'.repeat(64));
  coordinates.recordObservation(operation.id, { chainMode: 'simulated-fixture', observation: { txHash: '9'.repeat(64), blockNumber: 1 } }, true);
  const purchases = createProtocolPurchases({ db, ops, coordinates, now, fetchImpl, dacsProtocol: {
    walletAgreement: { bridgeFor: () => { throw new Error('TEST no wallet bridge'); }, network: 'TEST', rpcUrl: RPC, journal: createInMemoryDemosSr2Journal() },
    sellerEndpoint: () => SELLER, sellerSr2Commitment: { commitmentSubstrate: 'fixture', publicProjection: true }, nativeAgreementPayment: { enabled: true },
    nativePaymentEvidence: createNativePaymentEvidenceConsumer({ rpcUrl: RPC, fetchImpl }), sellerTransport: transport } });
  const get = () => ops.get(account.id, operation.id);
  return { get, now, rpcReads, sellerRequests, authentications, recheck: () => purchases.recheck(get(), coordinates.get(operation.id)) };
}

function assertDowngraded(w, label) {
  const operation = w.get(), view = protocolView(operation);
  assert.equal(operation.state.protocol.stage, 'payment-evidenced', `${label}: ${JSON.stringify(operation.state.protocol.attempts.at(-1))}`);
  assert.equal(operation.state.protocol.delivery, null, label);
  assert.equal(view.delivery, null, label);
  assert.equal(view.layers.service, 'not-delivered', label);
  assert.equal(operation.state.protocol.attempts.at(-1).outcome, 'held', label);
}

test('delegated final delivery: an unverified fresh read downgrades it without session authentication or seller requests, and keeps the key', async (t) => {
  const w = world(t, { delegated: true });
  const payload = w.get().state.protocol.sessionDelegation.payload, later = { time: w.now() + SELLER_SESSION_KEY_GRACE_MS + 1 };
  assert.equal(sellerSessionKeyRetirement(w.get(), payload, later).retire, true, 'final before the read');
  await w.recheck();
  assertDowngraded(w, 'delegated');
  assert.deepEqual(w.authentications, [], 'no seller session signer is acquired');
  assert.deepEqual(w.sellerRequests, [], 'the seller is not asked');
  assert.ok(w.rpcReads.length > 0, 'a fresh native read was attempted');
  assert.ok(w.get().state.protocol.sellerAnswer, 'the readback pointer survives the downgrade');
  assert.match(w.get().state.protocol.nativeEvidence?.sellerAnswerSource ?? '', /^retained; the seller was not asked$/, 'a failure before the payment summary still marks the retained seller fields');
  const decision = sellerSessionKeyRetirement(w.get(), payload, later);
  assert.equal(decision.retire, false);
  assert.match(decision.reason, /not final/);
});

test('custody final delivery: the same unverified recheck downgrades it and still asks the seller, as on main', async (t) => {
  const w = world(t, { delegated: false });
  await w.recheck();
  assertDowngraded(w, 'custody');
  assert.equal(w.authentications.length, 1, 'custody rechecks go through the seller, unchanged');
  assert.equal(Object.hasOwn(w.get().state.protocol, 'sellerAnswer'), false);
  // Only a delegated purchase is ever readback-only, even if a custody row
  // somehow carried a retained answer.
  const injected = world(t, { delegated: false, injectAnswer: true });
  await injected.recheck();
  assertDowngraded(injected, 'custody with an injected answer');
  assert.equal(injected.authentications.length, 1, 'a custody row still asks the seller');
});

// A legacy row (verified before the answer was retained) asks the seller while
// its key exists, as on main. Once the key is gone its pointer is derived from
// the verified delivery, read fresh, and kept through a failed read, so a later
// recheck reads again instead of recording the deletion as a permanent hold.
test('legacy delegated final delivery asks the seller while its key exists; after deletion it reads fresh from a derived pointer that survives a failed read', async (t) => {
  const w = world(t, { delegated: true, pointer: false });
  const later = { time: w.now() + SELLER_SESSION_KEY_GRACE_MS + 1 }, decision = sellerSessionKeyRetirement(w.get(), w.get().state.protocol.sessionDelegation.payload, later);
  assert.equal(decision.retire, false, 'its payment readback has no retained signed projection');
  assert.match(decision.reason, /no retained signed payment projection/);
  await w.recheck();
  assertDowngraded(w, 'legacy with its key');
  assert.equal(w.authentications.length, 1, 'while the key exists the seller is asked, as on main');
  assert.deepEqual(w.rpcReads, [], 'no readback from a derived pointer while the key exists');

  const gone = world(t, { delegated: true, pointer: false, keyDeleted: true });
  await gone.recheck();
  assertDowngraded(gone, 'legacy after key deletion');
  assert.equal(gone.authentications.length, 1, 'the key is tried first');
  const reads = gone.rpcReads.length;
  assert.ok(reads > 0, 'a fresh read from the derived pointer');
  assert.deepEqual(gone.sellerRequests, []);
  const kept = gone.get().state.protocol.sellerAnswer;
  assert.equal(kept?.settlementId, 'TEST-settlement', 'the derived pointer is kept through the failed read');
  assert.equal(kept.delivery.logicalAddress, `dacs4:deliverable:${gone.get().terms.protocol.jobId}`);
  await gone.recheck();
  assertDowngraded(gone, 'legacy after key deletion, rechecked');
  assert.ok(gone.rpcReads.length > reads, 'the kept pointer is read fresh again, so restored chain state can recover it');
  assert.doesNotMatch(gone.get().state.protocol.attempts.at(-1).reason, /was deleted/);
});

test('after key deletion a downgraded delegated purchase re-reads from its retained pointer; without one the deletion is recorded as a hold', async (t) => {
  const w = world(t, { delegated: true, stage: 'payment-evidenced', keyDeleted: true });
  await w.recheck();
  assertDowngraded(w, 'retired with pointer');
  assert.equal(w.authentications.length, 1, 'the key is tried first while the purchase is not final');
  assert.ok(w.rpcReads.length > 0, 'the retained pointer is read fresh instead');
  assert.deepEqual(w.sellerRequests, []);
  assert.doesNotMatch(w.get().state.protocol.attempts.at(-1).reason, /was deleted/);
  const bare = world(t, { delegated: true, stage: 'payment-evidenced', keyDeleted: true, pointer: false });
  await bare.recheck();
  assertDowngraded(bare, 'retired without pointer');
  assert.deepEqual(bare.rpcReads, [], 'nothing to read without a pointer');
  assert.match(bare.get().state.protocol.attempts.at(-1).reason, /seller session key for this purchase was deleted/);
});

// The stored answer is read in the same write transaction as the readback's
// save, so another process (a second app on the same database) committing a
// newer answer meanwhile is waited for and kept, not overwritten.
test('a readback that settles while another process commits a newer retained answer keeps that answer', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'seller-answer-merge-'))); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let reached, release;
  const paused = new Promise((resolve) => { reached = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  let first = true;
  const w = world(t, { delegated: true, dbPath: join(directory, 'app.sqlite'), beforeRead: async () => { if (first) { first = false; reached(); await gate; } } });
  const newer = { ...w.get().state.protocol.sellerAnswer, TEST: 'newer answer committed by another process' };
  const worker = fork(fileURLToPath(new URL('./helpers/answer-writer-worker.mjs', import.meta.url)), [join(directory, 'app.sqlite'), w.get().id], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => worker.connected && worker.kill());
  const messages = [];
  const next = (expected) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`TEST worker never sent ${expected}`)), 20000);
    const check = () => { if (messages.includes(expected)) { clearTimeout(timer); resolve(); } else setTimeout(check, 5); }; check(); });
  worker.on('message', (message) => messages.push(message));
  t.after(() => release());
  const recheck = w.recheck();
  await Promise.race([paused, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('TEST the readback never reached its native read')), 20000); timer.unref(); })]);
  worker.send({ answer: newer, holdMs: 2000 });
  await next('locked');
  release();
  await recheck;
  await next('committed');
  assertDowngraded(w, 'the readback itself still fails');
  assert.deepEqual(w.get().state.protocol.sellerAnswer, newer, 'the newer answer survives');
});
