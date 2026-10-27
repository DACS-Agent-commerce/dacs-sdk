// D11 deadline watch over the host's PurchaseStore. It is disabled by default;
// when enabled, one host-supplied absence report past the deadline and grace,
// and no later than the host clock, is saved once with its event.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPurchaseService } from '../src/purchases.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createDeliveryDeadlineWatch, deliveryDeadlineView, DELIVERY_DEADLINE_GRACE_MS } from '../src/dacs/delivery-deadline-watch.mjs';
import { protocolView } from '../src/dacs/protocol-purchases.mjs';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';

const ABSENT = { notPresent: true, delivery: { status: 'absent' } };
const untouched = new Proxy({}, { get(_target, key) { throw new Error(`unexpected use of ${String(key)}`); } });

function purchaseWorld(t, path = ':memory:') {
  const db = openDatabase(path), store = createSqlitePurchaseStore();
  t.after(() => { try { db.close(); } catch {} });
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8) }), coordinates = createCoordinateStore({ db });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('buyer', 'TEST', 'buyer', new Date().toISOString());
  const operation = ops.createIdempotent({ accountId: 'buyer', kind: 'purchase', idempotencyKey: 'TEST', request: {}, status: 'payment_handoff',
    terms: { buyer: { wallet: '0x' + 'a'.repeat(64) }, seller: { claim: 'seller', payee: '0x' + 'b'.repeat(64) }, protocol: {},
      price: { amountOs: '1000000000' }, listing: { listingId: 'TEST', version: 1, contentHash: 'f'.repeat(64) },
      network: 'testnet', rail: 'demos-native:DEM', domain: { network: 'testnet', chainIdentity: 'f'.repeat(64), mode: 'public-chain-read' } }, termsHash: 'f'.repeat(64),
    expiresAt: new Date(Date.now() + 3600000).toISOString(), state: { protocol: { stage: 'awaiting-countersignature',
      planned: { agreementMessage: 'TEST-agreement-sign', anchorMessage: 'TEST-anchor-sign' }, identity: { message: 'TEST-identity-sign' },
      sessionDelegation: { payload: { jobId: 'TEST-delegation-sign' }, signature: 'historical-signature' },
      bundle: { bundleHash: 'b'.repeat(64), message: 'TEST-bundle-sign' },
      agreement: { hash: 'f'.repeat(64), ref: { contentHash: 'f'.repeat(64) }, terms: { seller: 'seller', deadline: 1 },
        artifact: { terms: { deadline: 1 }, parties: [{ role: 'seller', primaryClaim: 'seller' }] } }, commitment: { verifiedAt: 'TEST' } } } }).operation;
  coordinates.save({ operationId: operation.id, kind: 'dem-transfer', network: 'testnet', from: operation.terms.buyer.wallet,
    nonceFence: 6, expectedNonce: 7, target: '0x' + 'b'.repeat(64), amountOs: '1000000000',
    payload: { type: 'native', nonce: 7, amount: 1000000000, data: ['send'] } });
  const chain = { getAddressNonce: async () => 6 };
  const purchases = createPurchaseService({ db, ops, coordinates, store, chain, config: {}, purposes: { APPROVE_PURCHASE: 'TEST' } });
  return { db, ops, coordinates, store, operation, purchases };
}

// A settled, payment-evidenced purchase whose delivery deadline (1 ms) has passed.
function settledWorld(t, path) {
  const w = purchaseWorld(t, path);
  w.ops.transition(w.operation.id, 'payment_handoff', 'settled_verified');
  w.coordinates.recordObservation(w.operation.id, { status: 'included' }, true, null);
  w.db.prepare("UPDATE operations SET state=json_set(state, '$.protocol.stage', 'payment-evidenced') WHERE id=?").run(w.operation.id);
  const current = () => w.ops.get(w.operation.accountId, w.operation.id);
  const watch = (options = {}) => createDeliveryDeadlineWatch({ db: w.db, ops: w.ops, coordinates: w.coordinates, store: w.store, enabled: true, ...options });
  return { ...w, current, watch };
}

function assertNoObservation(w, history) {
  assert.equal(w.current().state.protocol.deliveryDeadline, undefined);
  assert.deepEqual(w.ops.history(w.operation.id), history);
}

test('the deadline watch is disabled by default and touches nothing', () => {
  const watch = createDeliveryDeadlineWatch({ db: untouched, ops: untouched, coordinates: untouched, store: createSqlitePurchaseStore() });
  const operation = { id: 'TEST-operation', state: {} };
  assert.equal(watch.observe(operation, { ...ABSENT, checkedAt: Date.now() }), operation);
  assert.equal(watch.start(), undefined);
  return watch.sweep();
});

for (const checkedAt of [8640000000000000, 8640000000000001, Number.MAX_SAFE_INTEGER]) {
  test(`deadline observation checks the Date range (${checkedAt})`, t => {
    const w = purchaseWorld(t);
    w.db.prepare("UPDATE operations SET status='settled_verified', state=json_set(state, '$.protocol.stage', 'payment-evidenced') WHERE id=?").run(w.operation.id);
    const op = w.ops.get(w.operation.accountId, w.operation.id);
    const watch = createDeliveryDeadlineWatch({ ...w, enabled: true, now: () => 8640000000000000, coordinates: { get: () => ({ verifiedAt: 'TEST' }) } });
    const result = watch.observe(op, { ...ABSENT, checkedAt });
    assert.equal(Boolean(result.state.protocol.deliveryDeadline?.overdue), checkedAt === 8640000000000000);
    assert.doesNotThrow(() => deliveryDeadlineView(result, { enabled: true }));
  });
}

for (const checkedAt of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '2026-10-27T00:00:00Z', null, undefined]) {
  test(`a malformed, negative or unsafe report time is ignored (${String(checkedAt)})`, t => {
    const w = settledWorld(t), history = w.ops.history(w.operation.id);
    w.watch({ now: () => Date.now() }).observe(w.current(), { ...ABSENT, checkedAt });
    assertNoObservation(w, history);
  });
}

for (const clock of [-1, 0.5, 8640000000000001]) {
  test(`an out-of-range host clock records nothing (${clock})`, t => {
    const w = settledWorld(t), history = w.ops.history(w.operation.id);
    w.watch({ now: () => clock }).observe(w.current(), { ...ABSENT, checkedAt: 2 + DELIVERY_DEADLINE_GRACE_MS });
    assertNoObservation(w, history);
  });
}

test('the grace period is exclusive: a report at deadline + grace is too early', t => {
  const w = settledWorld(t), history = w.ops.history(w.operation.id), clock = 2 + DELIVERY_DEADLINE_GRACE_MS;
  const watch = w.watch({ now: () => clock });
  watch.observe(w.current(), { ...ABSENT, checkedAt: 1 + DELIVERY_DEADLINE_GRACE_MS });
  assertNoObservation(w, history);
  watch.observe(w.current(), { ...ABSENT, checkedAt: clock });
  assert.equal(w.current().state.protocol.deliveryDeadline.overdue.checkedAt, clock);
});

for (const offset of [1, 7 * 24 * 3600000, 1700000000000000]) {
  test(`deadline watch ignores a future host observation (+${offset} ms), accepts current time`, t => {
    const w = settledWorld(t), clock = Date.now(), watch = w.watch({ now: () => clock });
    const operation = w.current(), before = w.ops.history(w.operation.id);
    watch.observe(operation, { ...ABSENT, checkedAt: clock + offset });
    assertNoObservation(w, before);
    watch.observe(operation, { ...ABSENT, checkedAt: clock });
    assert.equal(w.current().state.protocol.deliveryDeadline.overdue.checkedAt, clock);
  });
}

test('a microsecond report cannot mark a future delivery deadline overdue', t => {
  const w = purchaseWorld(t), clock = Date.now(), deadline = clock + 7 * 24 * 3600000;
  const op = structuredClone(w.operation);
  op.state.protocol.stage = 'payment-evidenced';
  op.state.protocol.agreement.terms.deadline = deadline;
  op.state.protocol.agreement.artifact.terms.deadline = deadline;
  w.db.prepare('UPDATE operations SET status=?, state=? WHERE id=?').run('settled_verified', JSON.stringify(op.state), op.id);
  const watch = createDeliveryDeadlineWatch({ ...w, now: () => clock, enabled: true,
    coordinates: { get: () => ({ verifiedAt: 'TEST' }) } });
  const current = w.ops.get(op.accountId, op.id), history = w.ops.history(op.id);
  watch.observe(current, { ...ABSENT, checkedAt: clock * 1000 });
  assert.equal(w.ops.get(op.accountId, op.id).state.protocol.deliveryDeadline, undefined);
  assert.deepEqual(w.ops.history(op.id), history);
});

for (const [name, change] of [
  ['the agreement changed after the readback', (w) => w.db.prepare("UPDATE operations SET state=json_set(state, '$.protocol.agreement.hash', ?, '$.protocol.agreement.ref.contentHash', ?) WHERE id=?").run('e'.repeat(64), 'e'.repeat(64), w.operation.id)],
  ['the purchase left settled_verified', (w) => w.db.prepare("UPDATE operations SET status='payment_uncertain' WHERE id=?").run(w.operation.id)],
  ['delivery was verified meanwhile', (w) => w.db.prepare("UPDATE operations SET state=json_set(state, '$.protocol.delivery', json('{\"status\":\"verified\"}')) WHERE id=?").run(w.operation.id)],
  ['the payment coordinates are no longer verified', (w) => w.db.prepare('UPDATE write_coordinates SET verified_at=NULL WHERE operation_id=?').run(w.operation.id)],
]) {
  test(`a stale readback records nothing when ${name}`, t => {
    const w = settledWorld(t), clock = Date.now(), readFor = w.current();
    change(w);
    const history = w.ops.history(w.operation.id);
    w.watch({ now: () => clock }).observe(readFor, { ...ABSENT, checkedAt: clock });
    assert.equal(w.current().state.protocol.deliveryDeadline, undefined);
    assert.deepEqual(w.ops.history(w.operation.id), history);
  });
}

test('repeated reports and a reopened store keep one host-supplied observation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-deadline-watch-')), path = join(dir, 'state.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const w = settledWorld(t, path), clock = Date.now(), first = { ...ABSENT, checkedAt: clock };
  const watch = w.watch({ now: () => clock });
  watch.observe(w.current(), first);
  watch.observe(w.current(), { ...first, checkedAt: clock - 1 });
  const events = () => w.ops.history(w.operation.id).filter(row => row.type === 'protocol_delivery_deadline_overdue');
  assert.equal(events().length, 1);
  const { operation } = w;
  w.db.close();
  const db = openDatabase(path), ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8) });
  t.after(() => db.close());
  const reopened = createDeliveryDeadlineWatch({ db, ops, coordinates: createCoordinateStore({ db }), store: createSqlitePurchaseStore(), enabled: true, now: () => clock + 1 });
  reopened.observe(ops.get(operation.accountId, operation.id), { ...first, checkedAt: clock + 1 });
  const overdue = ops.get(operation.accountId, operation.id).state.protocol.deliveryDeadline.overdue;
  assert.deepEqual({ checkedAt: overdue.checkedAt, source: overdue.source, authority: overdue.authority }, { checkedAt: clock, source: 'host-supplied', authority: 'local-observation' });
  assert.equal(ops.history(operation.id).filter(row => row.type === 'protocol_delivery_deadline_overdue').length, 1);
});

test('historical malformed overdue and delivery timestamps remain renderable after JSON roundtrip', () => {
  for (const timestamp of [Number.MAX_SAFE_INTEGER, -1, 'invalid', null]) {
    const operation = JSON.parse(JSON.stringify({ terms: { protocol: {} }, state: { protocol: { stage: 'payment-evidenced',
      deliveryDeadline: { overdue: { deadline: 1, checkedAt: timestamp }, laterDelivery: { deliveredAt: timestamp, deliveredAtSource: 'TEST' } } } } }));
    const view = deliveryDeadlineView(operation, { enabled: true });
    assert.match(view.message, /unavailable|invalid|unknown/i);
    assert.doesNotThrow(() => protocolView(operation));
  }
});

test('public deadline guidance says verify_deal records the payment and then answers the action hold', () => {
  const operation = { state: { protocol: { agreement: { artifact: { terms: { deadline: 0 } } } } } };
  const result = deliveryDeadlineView(operation, { now: () => 1000, enabled: true });
  assert.match(result.message, /verify_deal records the payment transfer/);
  assert.match(result.message, /answers profile_not_admitted; get_purchase_status shows the saved result/);
  assert.match(result.message, /Delivery checking remains held/);
  assert.doesNotMatch(result.message, /verify_deal checks the chain again|payment transfer only/);
});
