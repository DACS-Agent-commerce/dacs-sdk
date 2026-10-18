// DACS_BUYER_CHAIN_READBACK=on, an earlier review: a purchase that holds a verified
// delivery keeps it through every fresh read that is not a definite,
// authenticated contradiction. Payment evidence, Deliverable and delivery
// evidence reads that are indeterminate or fail, and seller answers that are
// refused (404, 409), unavailable (5xx) or malformed, leave status, stage,
// delivery and payment evidence as they were; any pointer that authenticated
// is kept; the attempt is chain-readback / indeterminate; nothing is refunded,
// faulted, resent or advanced. A rejected read still lowers the row exactly as
// with the switch off. A final row missing a pointer asks the seller within a
// bounded budget, and is held for the operator (ops health) once nothing can
// obtain the pointer: its asks are spent or its key is retired at the pointer
// retention bound.
// an earlier review: a rejection of what the seller offers (signed CREATE bytes that do
// not authenticate, or an answer whose pointer is not the verified delivery's)
// never lowers the row; an exception that is not a definite verdict is
// indeterminate; the retention bound is exact; a key retired without its
// history (a crash) is reconciled at startup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { logicalToStorageProgramName, sha256Hex } from '@kynesyslabs/dacs';
import { agreementTerms, deliverableAddress, deliveryEvidenceAddress, paymentEvidenceAddress } from '../src/dacs/purchase-protocol.mjs';
import { CHAIN_POINTER_ASK_INTERVAL_MS, CHAIN_POINTER_ASK_LIMIT, CHAIN_READBACK_OPERATOR_ACTION, missingChainPointers } from '../src/dacs/seller-session-lifecycle.mjs';
import { SELLER_SESSION_KEY_GRACE_MS, SELLER_SESSION_POINTER_RETENTION_MS, sellerSessionKeyRetirement } from '../src/devnet-demo/operator-sessions.mjs';
import { opsHealth } from '../src/ops/health.mjs';
import { IMMUTABLE_READBACK_TTL_MS } from '../src/util/immutable-readbacks.mjs';
import { createLoopbackTestTlsMaterial } from './helpers/loopback-test-tls.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';

// The switch as the operator reads it (process.env), restored afterwards.
function switchEnv(t, value) {
  const previous = process.env.DACS_BUYER_CHAIN_READBACK;
  t.after(() => { if (previous === undefined) delete process.env.DACS_BUYER_CHAIN_READBACK; else process.env.DACS_BUYER_CHAIN_READBACK = previous; });
  process.env.DACS_BUYER_CHAIN_READBACK = value;
  return (next) => { process.env.DACS_BUYER_CHAIN_READBACK = next; };
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const call = (body) => body?.method === 'nodeCall' ? body.params?.[0] : null;
// TEST chain faults, by what they touch: the name index for one program, or one native program read.
const notFoundAt = (address) => ({ body }) => call(body)?.message === 'searchStoragePrograms' && call(body).data?.query === logicalToStorageProgramName(address) ? json({ result: 200, response: [], require_reply: false, extra: null }) : null;
const unavailableAt = (nativeAddress) => ({ url }) => new URL(url).pathname === `/storage-program/${nativeAddress}` ? json({ error: 'TEST node unavailable' }, 503) : null;
// The native program at nativeAddress as the node returns it, with its data changed.
const alteredAt = (w, nativeAddress, alter) => async ({ url, headers }) => {
  if (new URL(url).pathname !== `/storage-program/${nativeAddress}`) return null;
  const value = await (await w.h.node2.fetchImpl(url, { method: 'GET', headers })).json();
  return json({ ...value, data: alter(value.data) });
};

// One operator, its purchase rows and the probes every test uses. offRow: the
// purchases are made with the switch off; flip (the default) then turns it on
// and restarts, as an operator upgrading does. morePurchases: further purchases
// made the same way. manualSweeps: the key sweep runs only at startup and when
// a test calls it. The clock runs at an offset, or stands still once frozen.
async function world(t, { offRow = false, flip = true, sellerApproval, sellerDeliveryEvidence, openBuyerAccess = true, idempotencyKey, morePurchases = [], manualSweeps = false } = {}) {
  const set = switchEnv(t, offRow ? 'off' : 'on');
  let offsetMs = 0, frozen = null, chainFault = null, sellerFault = null, h;
  const sellerCalls = [], clock = () => frozen ?? Date.now() + offsetMs;
  h = await startOperatorPurchaseNode2({ openBuyerAccess, now: clock, ...(sellerApproval ? { sellerApproval, tlsFixture: createLoopbackTestTlsMaterial() } : {}), ...(sellerDeliveryEvidence ? { sellerDeliveryEvidence } : {}),
    ...(manualSweeps ? { sessionSweepTimer: { every: () => ({}), cancel: () => {} } } : {}),
    authorizeSellerApproval: sellerApproval ? ({ request }) => request.content.artifactKind === 'Listing' : () => true, authorizeBuyerApproval: () => true,
    rpcFault: async (request) => {
      if (h && new URL(request.url).origin === new URL(h.config.sellerOrigin).origin) { sellerCalls.push(new URL(request.url).pathname); return sellerFault?.(request) ?? null; }
      return chainFault?.(request) ?? null;
    } });
  t.after(() => h.close());
  const driver = h.operator.createBuyerDriver({ composition: h.composition });
  const result = await driver.purchase({ idempotencyKey }), more = [];
  for (const key of morePurchases) more.push(await driver.purchase({ idempotencyKey: key }));
  if (offRow && flip) { set('on'); await h.restart(); }
  assert.equal(h.prepared.config.buyerChainReadback, offRow && !flip ? 'off' : 'on');
  const accountOf = (id) => h.application.db.prepare('SELECT account_id FROM operations WHERE id = ?').get(id).account_id;
  const accountId = accountOf(result.operationId), operationId = result.operationId;
  const op = () => h.application.services.ops.get(accountId, operationId);
  const effects = () => ({ creates: h.node2.chain.wire.record.accepted.length, payments: h.node2.chain.record.accepted.length });
  const sellerStore = (work) => { const db = new DatabaseSync(join(h.config.stateDirectory, 'seller-transport.sqlite')); db.exec('PRAGMA busy_timeout = 5000'); try { return work(db); } finally { db.close(); } };
  return { h, result, more, op, accountId, operationId, effects, sellerCalls, sellerStore,
    opOf: (id) => h.application.services.ops.get(accountOf(id), id),
    verify: (id = operationId) => h.application.services.purchases.verifyDeal({ accountId: accountOf(id), operationId: id }),
    advance: (ms) => { offsetMs += ms; }, clock, setOffset: (ms) => { frozen = null; offsetMs = ms; }, freeze: (ms) => { frozen = ms; },
    health: () => opsHealth({ databasePath: h.prepared.config.databasePath, now: clock() }),
    chain: (fault) => { chainFault = fault; }, seller: (fault) => { sellerFault = fault; },
    // The payments the seller answered for this job (its asks), as seen at its origin.
    asks: () => sellerCalls.filter((path) => path === '/dacs/v1/payments').length };
}
// The row kept everything it had verified; the last attempt says why.
function assertKept(w, original, reason, id) {
  const operation = id ? w.opOf(id) : w.op(), p = operation.state.protocol, last = p.attempts.at(-1);
  assert.equal(operation.status, 'settled_verified');
  assert.equal(p.stage, original.stage, JSON.stringify(last));
  assert.deepEqual(p.delivery, original.delivery, 'the verified delivery is kept, not cleared');
  assert.deepEqual(p.paymentEvidence, original.paymentEvidence, 'the verified payment evidence is kept');
  assert.equal(last.step, 'chain-readback'); assert.equal(last.outcome, 'indeterminate');
  assert.match(last.reason, reason);
  return p;
}
// The same verified result, apart from when it was observed: a fresh verified
// read re-observes each receipt (observedAt, and the write proof that carries it).
const unobserved = (value) => JSON.parse(JSON.stringify(value ?? null), (key, item) => item && typeof item === 'object' && !Array.isArray(item) && item.receiptVersion
  ? Object.fromEntries(Object.entries(item).filter(([name]) => name !== 'observedAt' && name !== 'evidence')) : item);
// Rewrites the seller's cached payment answer for this job (what the seller
// replays, signed as it is); returns the restore.
function editAnswer(w, edit) {
  const effect = w.sellerStore((db) => db.prepare("SELECT effect, response FROM peer_effects WHERE response LIKE '%\"delivery\"%' AND response LIKE ?").get(`%${w.result.jobId}%`));
  assert.ok(effect, 'the seller retained its payment answer');
  const answer = JSON.parse(effect.response);
  edit(answer);
  w.sellerStore((db) => db.prepare('UPDATE peer_effects SET response = ? WHERE effect = ?').run(JSON.stringify(answer), effect.effect));
  return () => w.sellerStore((db) => db.prepare('UPDATE peer_effects SET response = ? WHERE effect = ?').run(effect.response, effect.effect));
}

test('on, a final row with every pointer kept: indeterminate payment and Deliverable reads, and an exception from a read, keep it; a definite contradiction of the Agreement or the Deliverable lowers it as with the switch off', { timeout: 600000 }, async (t) => {
  const w = await world(t, { idempotencyKey: 'chain-readback-final-hold-reads' });
  assert.equal(w.result.status, 'delivery-ready');
  const original = structuredClone(w.op().state.protocol), jobId = w.result.jobId, terms = agreementTerms(original.agreement.artifact);
  const payment = paymentEvidenceAddress(jobId, terms.rail, terms.paymentPhaseIndex), deliverable = deliverableAddress(jobId);
  assert.deepEqual(missingChainPointers(w.op()), [], 'control: payment evidence and Deliverable pointers are kept');
  const baseline = w.effects(), asked = w.asks();

  // Deliverable: a kept pointer whose fresh read is not found (a an earlier review), or whose native read is unavailable.
  w.chain(notFoundAt(deliverable)); try { await w.verify(); } finally { w.chain(null); }
  assertKept(w, original, /Deliverable read is indeterminate/);
  w.chain(unavailableAt(original.delivery.anchorReceipt.nativeAddress)); try { await w.verify(); } finally { w.chain(null); }
  assertKept(w, original, /Deliverable read is indeterminate/);
  // an earlier review (a review P3): an exception from the Deliverable read that is no
  // definite verdict. The node returns a number the canonical form cannot
  // hold, so the adapter's canonicalize throws a DacsError with no code.
  w.chain(alteredAt(w, original.delivery.anchorReceipt.nativeAddress, (data) => ({ ...data, title: 2 ** 60 }))); try { await w.verify(); } finally { w.chain(null); }
  assertKept(w, original, /Deliverable read is indeterminate \(native Deliverable read: error: canonical form/);
  // Payment evidence: a kept pointer whose fresh read is not found.
  w.chain(notFoundAt(payment)); try { await w.verify(); } finally { w.chain(null); }
  assertKept(w, original, /payment evidence read is indeterminate/);
  // The Agreement re-read (once its reuse window has passed) is not found: indeterminate, not a rejection.
  w.advance(IMMUTABLE_READBACK_TTL_MS + 1000);
  w.chain(notFoundAt(original.agreement.ref.anchor.locator)); try { await w.verify(); } finally { w.chain(null); }
  assertKept(w, original, /Agreement did not read back/);
  assert.equal(w.asks(), asked, 'a final row with its pointers reads back without the seller');

  // Code an earlier review (MF4): a definite rejection of the buyer's own
  // Agreement on chain is not indeterminate: the delivery is cleared, as with
  // the switch off. (The failed re-read above evicted the reused proof.)
  w.chain(alteredAt(w, original.agreement.anchorReceipt.nativeAddress, (data) => ({ ...data, TEST: 'altered on chain' })));
  try { await w.verify(); } finally { w.chain(null); }
  let p = w.op().state.protocol;
  assert.equal(p.stage, 'payment-evidenced', JSON.stringify(p.attempts.at(-1)));
  assert.equal(p.delivery, null);
  assert.deepEqual([p.attempts.at(-1).step, p.attempts.at(-1).outcome], ['native-evidence', 'held']);

  // Control: the next ordinary recheck verifies the same delivery.
  await w.verify();
  p = w.op().state.protocol;
  assert.equal(p.stage, 'delivery-ready'); assert.equal(p.attempts.at(-1).outcome, 'verified');
  assert.deepEqual(unobserved(p.delivery.anchorReceipt), unobserved(original.delivery.anchorReceipt));

  // an earlier review (code P2-1 / a review P2-1), replacing the source change's code review
  // P3-1 case: native Deliverable bytes on chain that no longer match the kept
  // signed CREATE are a node answer that did not authenticate. The SR-2
  // adapter refuses them unmarked (the source change), so they are not a contradiction: the
  // verified delivery is kept and read again. Only a marked contradiction (the
  // writer's own signed CREATE contradicting the purchase) rejects; no node
  // answer can produce one (buyer-chain-readback-unit pins that verdict).
  w.chain(alteredAt(w, original.delivery.anchorReceipt.nativeAddress, (data) => ({ ...data, title: 'TEST altered on chain' })));
  try { await w.verify(); } finally { w.chain(null); }
  assertKept(w, { ...original, delivery: p.delivery, paymentEvidence: p.paymentEvidence }, /Deliverable read is indeterminate \(native Deliverable read: invalid: /);
  await w.verify();
  p = w.op().state.protocol;
  assert.equal(p.stage, 'delivery-ready'); assert.equal(p.attempts.at(-1).outcome, 'verified');
  assert.deepEqual(w.effects(), baseline, 'no CREATE or payment');
});

test('on, a delivered row with its evidence pointer kept: an evidence read that is not found or unavailable keeps delivered', { timeout: 600000 }, async (t) => {
  const w = await world(t, { sellerApproval: { mode: 'policy' }, sellerDeliveryEvidence: { enabled: true }, openBuyerAccess: undefined, idempotencyKey: 'chain-readback-final-hold-evidence' });
  assert.equal(w.result.status, 'delivered', JSON.stringify(w.result).slice(0, 400));
  const original = structuredClone(w.op().state.protocol), evidence = deliveryEvidenceAddress(w.result.jobId);
  assert.ok(original.chainReadback?.[evidence], 'control: the evidence pointer is kept');
  const baseline = w.effects();
  w.chain(notFoundAt(evidence)); try { await w.verify(); } finally { w.chain(null); }
  assertKept(w, original, /delivery evidence read is indeterminate/);
  w.chain(unavailableAt(original.delivery.evidenceReceipt.nativeAddress)); try { await w.verify(); } finally { w.chain(null); }
  assertKept(w, original, /delivery evidence read is indeterminate/);
  // an earlier review (a review P2-1): node bytes that do not authenticate against
  // the kept evidence CREATE (an unmarked adapter `invalid`) keep delivered too.
  w.chain(alteredAt(w, original.delivery.evidenceReceipt.nativeAddress, (data) => ({ ...data, TEST: 'unauthenticated node bytes' }))); try { await w.verify(); } finally { w.chain(null); }
  assertKept(w, original, /delivery evidence read is indeterminate \(native SettlementEvidence read: invalid: /);
  await w.verify();
  const p = w.op().state.protocol;
  assert.equal(p.stage, 'delivered'); assert.equal(p.attempts.at(-1).outcome, 'verified');
  assert.deepEqual(w.effects(), baseline, 'no CREATE or payment');
});

test('on, an evidence-backed delivered off-row with a live key: seller 404, 409, 5xx, a malformed answer and an answer naming other evidence each keep the delivery and its evidence reference and fall back to a seller-free read; asks are spaced; a held row is released once the restored seller supplies every pointer', { timeout: 600000 }, async (t) => {
  // a an earlier review (P3): a truly delivered row, so its evidence reference is at stake.
  const w = await world(t, { offRow: true, sellerDeliveryEvidence: { enabled: true }, idempotencyKey: 'chain-readback-final-hold-seller' });
  assert.equal(w.result.status, 'delivered', JSON.stringify(w.result).slice(0, 400));
  const original = structuredClone(w.op().state.protocol), jobId = w.result.jobId, terms = agreementTerms(original.agreement.artifact);
  const payment = paymentEvidenceAddress(jobId, terms.rail, terms.paymentPhaseIndex), deliverable = deliverableAddress(jobId), evidence = deliveryEvidenceAddress(jobId);
  assert.ok(original.delivery.evidenceRef, 'the row is delivered on its read-back delivery evidence');
  assert.ok(original.sellerAnswer, 'the off-row keeps a retained seller answer');
  assert.equal(original.chainReadback, undefined);
  const baseline = w.effects();
  const evidenceKept = () => assert.deepEqual(w.op().state.protocol.delivery.evidenceRef, original.delivery.evidenceRef, 'the evidence reference survives');
  const context = w.sellerStore((db) => db.prepare('SELECT context FROM peer_jobs WHERE job = ?').get(jobId).context);

  // 404: the code review's probe. The seller's transport store forgets the job; it refuses, signed.
  w.sellerStore((db) => db.prepare('DELETE FROM peer_jobs WHERE job = ?').run(jobId));
  let asked = w.asks();
  await w.verify();
  assert.equal(w.asks(), asked + 1, 'the final row missing its Deliverable pointer asked the seller once');
  let p = assertKept(w, original, /Deliverable signed CREATE.*seller refused \(.*peer_unknown_job/);
  evidenceKept();
  assert.deepEqual(Object.keys(p.chainReadback), [payment], 'the payment evidence pointer from the retained answer authenticated and is kept');
  assert.equal(p.chainPointerAsks.count, 1);
  // The next recheck inside the ask interval does not ask; it reads back seller-free.
  await w.verify();
  assert.equal(w.asks(), asked + 1, 'no ask inside the interval');
  p = assertKept(w, original, /Deliverable signed CREATE/);
  assert.doesNotMatch(p.attempts.at(-1).reason, /seller refused/);

  // 409: another lasting signed refusal (the seller's job context no longer matches).
  w.sellerStore((db) => db.prepare('INSERT INTO peer_jobs VALUES (?, ?)').run(jobId, '{"TEST":"another context"}'));
  w.advance(CHAIN_POINTER_ASK_INTERVAL_MS + 1000); asked = w.asks();
  await w.verify();
  assert.equal(w.asks(), asked + 1);
  assertKept(w, original, /seller refused \(.*peer_job_conflict/);
  evidenceKept();
  w.sellerStore((db) => db.prepare('UPDATE peer_jobs SET context = ? WHERE job = ?').run(context, jobId));

  // 5xx: the seller is unreachable.
  w.seller(() => json({ error: 'TEST seller unreachable' }, 503));
  w.advance(CHAIN_POINTER_ASK_INTERVAL_MS + 1000); asked = w.asks();
  try { await w.verify(); } finally { w.seller(null); }
  assert.equal(w.asks(), asked + 1);
  assertKept(w, original, /seller could not be asked/);
  evidenceKept();

  // A malformed answer: the seller's cached payment answer carries no delivery pointer.
  let restore = editAnswer(w, (answer) => { delete answer.delivery; });
  w.advance(CHAIN_POINTER_ASK_INTERVAL_MS + 1000); asked = w.asks();
  await w.verify();
  assert.equal(w.asks(), asked + 1);
  assertKept(w, original, /seller answer carries no delivery-ready pointer/);
  evidenceKept();
  restore();

  // an earlier review (code P2-2): an answer naming other delivery evidence than the
  // verified one. The evidence on chain authenticates and does not match the
  // seller's claim, which is the seller's problem: delivered stays.
  restore = editAnswer(w, (answer) => { answer.delivery.evidenceHash = sha256Hex('TEST other delivery evidence'); });
  w.advance(CHAIN_POINTER_ASK_INTERVAL_MS + 1000); asked = w.asks();
  await w.verify();
  assert.equal(w.asks(), asked + 1);
  assertKept(w, original, /seller answer's delivery evidence hash differs from the verified delivery/);
  evidenceKept();
  restore();

  // an earlier review (a review P2-1): the fresh answer's delivery evidence pointer
  // meets node bytes that do not authenticate. Unmarked, that is no
  // contradiction; on bytes the seller offered it is still the seller's
  // problem, so the recheck reads again from the retained answer.
  w.chain(alteredAt(w, original.delivery.evidenceReceipt.nativeAddress, (data) => ({ ...data, TEST: 'unauthenticated node bytes' })));
  w.advance(CHAIN_POINTER_ASK_INTERVAL_MS + 1000); asked = w.asks();
  try { await w.verify(); } finally { w.chain(null); }
  assert.equal(w.asks(), asked + 1);
  assertKept(w, original, /seller answer's delivery evidence signed CREATE did not authenticate \(native SettlementEvidence read: invalid: /);
  evidenceKept();

  // Code an earlier review (MF2): a held purchase whose readback keeps every
  // pointer is released. Hold it as the operator's key sweep does
  // (holdChainReadback), while its seller can still answer.
  const held = w.h.application.services.protocol.holdChainReadback(w.op(), 'TEST held while the seller can still answer');
  assert.deepEqual(held.state.protocol.chainReadbackHeld.missing, [deliverable, evidence]);
  assert.equal(w.health().stuck.find((row) => row.purchaseId === w.operationId)?.outcome, 'operator-action-required');

  // The seller is back: its replayed answer's pointers authenticate and are kept; the row verifies.
  w.advance(CHAIN_POINTER_ASK_INTERVAL_MS + 1000);
  await w.verify();
  p = w.op().state.protocol;
  assert.equal(p.stage, 'delivered'); assert.equal(p.attempts.at(-1).outcome, 'verified');
  assert.deepEqual(p.delivery.evidenceRef, original.delivery.evidenceRef);
  assert.ok(p.chainReadback[deliverable] && p.chainReadback[evidence], 'the Deliverable and evidence pointers are kept');
  assert.deepEqual(missingChainPointers(w.op()), []);
  assert.equal(p.chainReadbackHeld, undefined, 'released: the readback kept every pointer');
  assert.notEqual(w.health().stuck.find((row) => row.purchaseId === w.operationId)?.outcome, 'operator-action-required', 'ops health no longer reports it');
  assert.deepEqual(w.effects(), baseline, 'no CREATE or payment, nothing resent');
});

test('on, a final row that can never obtain its pointer: asks stop at the budget and the row is held for the operator; the key retires exactly at the pointer retention bound', { timeout: 600000 }, async (t) => {
  const w = await world(t, { offRow: true, idempotencyKey: 'chain-readback-final-hold-budget' });
  const original = structuredClone(w.op().state.protocol), jobId = w.result.jobId, deliverable = deliverableAddress(jobId);
  const baseline = w.effects();
  // The seller refuses for good.
  w.sellerStore((db) => db.prepare('DELETE FROM peer_jobs WHERE job = ?').run(jobId));
  const before = w.asks();
  for (let i = 0; i < CHAIN_POINTER_ASK_LIMIT; i++) {
    assert.equal(w.op().state.protocol.chainReadbackHeld, undefined, `not held before the last ask (${i})`);
    await w.verify(); w.advance(CHAIN_POINTER_ASK_INTERVAL_MS + 1000);
  }
  assert.equal(w.asks(), before + CHAIN_POINTER_ASK_LIMIT, 'one ask per spaced recheck, up to the budget');
  let p = assertKept(w, original, /Deliverable signed CREATE/);
  assert.equal(p.chainReadbackHeld.action, CHAIN_READBACK_OPERATOR_ACTION);
  assert.deepEqual(p.chainReadbackHeld.missing, [deliverable]);
  assert.match(p.chainReadbackHeld.reason, /seller asks for chain pointers are spent/);
  const held = w.h.application.db.prepare("SELECT data FROM operation_events WHERE operation_id = ? AND type = 'protocol_chain-readback' ORDER BY seq DESC LIMIT 1").get(w.operationId);
  assert.equal(JSON.parse(held.data).operatorAction, CHAIN_READBACK_OPERATOR_ACTION, 'the hold is in the purchase history');
  // Past the budget the seller is not asked again; the row still keeps its verified result.
  await w.verify();
  assert.equal(w.asks(), before + CHAIN_POINTER_ASK_LIMIT);
  assertKept(w, original, /Deliverable signed CREATE/);
  // Queryable: ops health reports the purchase as needing the operator.
  const report = w.health(), stuck = report.stuck.find((row) => row.purchaseId === w.operationId);
  assert.equal(report.healthy, false);
  assert.equal(stuck.outcome, 'operator-action-required'); assert.match(stuck.nextExpected, /operator action required; never resend/);

  // Retention: the key is kept until exactly the bound after the delegation
  // expires (a an earlier review: one millisecond before it, then at it), then
  // retired with operator action.
  const bound = original.sessionDelegation.payload.expiresAt + SELLER_SESSION_POINTER_RETENTION_MS;
  w.freeze(bound - 1);
  let swept = w.h.operator.sweepSellerSessions();
  assert.equal(swept.deleted.length, 0);
  assert.match(swept.kept.find((item) => item.operationId === w.operationId).reason, /lacks kept chain pointers .*pointer retention bound/);
  w.freeze(bound);
  swept = w.h.operator.sweepSellerSessions();
  assert.equal(swept.deleted.length, 1, JSON.stringify(swept.kept));
  assert.deepEqual(swept.deleted[0].operatorAction, { missing: [deliverable] });
  const deleted = w.h.application.db.prepare("SELECT data FROM operation_events WHERE operation_id = ? AND type = 'seller_session_key_deleted'").get(w.operationId);
  assert.equal(JSON.parse(deleted.data).operatorAction, CHAIN_READBACK_OPERATOR_ACTION);
  w.setOffset(bound - Date.now());
  // With the key retired (and the asks spent) the row reads back seller-free, unchanged.
  const asked = w.asks();
  await w.verify();
  assert.equal(w.asks(), asked, 'nothing is sent to the seller');
  assertKept(w, original, /Deliverable signed CREATE/);
  assert.deepEqual(w.effects(), baseline, 'no CREATE or payment');
});

test('on, operator: a driver re-read with no kept Deliverable pointer is reported as not available yet, never as a difference; the payment is not resent', { timeout: 600000 }, async (t) => {
  switchEnv(t, 'on');
  const h = await startOperatorPurchaseNode2({ authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  t.after(() => h.close());
  // TEST: whenever the app keeps the authenticated Deliverable bytes they are
  // dropped again. The app has already verified; only the driver's own re-read
  // finds no pointer (code an earlier review, P3-4).
  const pointer = (row) => `'$.protocol.chainReadback."dacs4:deliverable:' || json_extract(${row}.terms, '$.protocol.jobId') || '"'`;
  h.application.db.exec(`CREATE TEMP TRIGGER test_drop_deliverable_pointer AFTER UPDATE OF state ON operations
    WHEN json_extract(NEW.state, ${pointer('NEW')}) IS NOT NULL
    BEGIN UPDATE operations SET state = json_remove(state, ${pointer('operations')}) WHERE id = NEW.id; END`);
  await assert.rejects(h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'chain-readback-driver-indeterminate' }), (error) => {
    assert.match(error.message, /independent buyer native readback is not available yet \(.*Deliverable CREATE is not available yet/);
    assert.doesNotMatch(error.message, /differs/);
    return true;
  });
  const row = h.application.db.prepare("SELECT state FROM operations WHERE kind = 'purchase'").get();
  assert.equal(JSON.parse(row.state).protocol.stage, 'delivery-ready', 'the app verified the delivery');
  assert.equal(h.node2.chain.record.accepted.length, 1, 'one payment, never resent');
});

test('on, the key sweep alone: exactly at the pointer retention bound it retires the key and holds the purchase for the operator; the final-state grace is not added to the bound', { timeout: 600000 }, async (t) => {
  const w = await world(t, { offRow: true, idempotencyKey: 'chain-readback-final-hold-retention' });
  const row = structuredClone(w.op()), original = row.state.protocol, deliverable = deliverableAddress(w.result.jobId);
  assert.equal(SELLER_SESSION_POINTER_RETENTION_MS, 7 * 24 * 60 * 60 * 1000, 'the default is conservative: seven days after the delegation expires');
  assert.ok(SELLER_SESSION_POINTER_RETENTION_MS > SELLER_SESSION_KEY_GRACE_MS);
  const expiresAt = original.sessionDelegation.payload.expiresAt, bound = expiresAt + SELLER_SESSION_POINTER_RETENTION_MS;
  w.freeze(bound - 1);
  assert.equal(w.h.operator.sweepSellerSessions().deleted.length, 0, 'one millisecond before the bound the key is kept');
  assert.equal(w.op().state.protocol.chainReadbackHeld, undefined);
  w.freeze(bound);
  const swept = w.h.operator.sweepSellerSessions();
  assert.equal(swept.deleted.length, 1, JSON.stringify(swept.kept));
  const p = w.op().state.protocol;
  assert.equal(p.stage, original.stage); assert.deepEqual(p.delivery, original.delivery);
  assert.equal(p.chainReadbackHeld.action, CHAIN_READBACK_OPERATOR_ACTION);
  assert.ok(p.chainReadbackHeld.missing.includes(deliverable));
  assert.equal(p.revision, original.revision, 'holding is not progress');
  assert.equal(w.health().stuck.find((item) => item.purchaseId === w.operationId)?.outcome, 'operator-action-required');

  // a an earlier review (P3): the bound is exact even when the purchase became
  // final shortly before it. Here the operator retains pointers for 0 ms and
  // the purchase became final five minutes before its delegation expired: at
  // the bound the key is retired, not kept for the rest of the 15-minute grace.
  const late = { ...row, state: { ...row.state, protocol: { ...original, sellerSessionFinalAt: expiresAt - 5 * 60 * 1000 } } }, payload = original.sessionDelegation.payload;
  const decide = (time, requireChainPointers = true) => sellerSessionKeyRetirement(late, payload, { time, requireChainPointers, pointerRetentionMs: 0 });
  assert.equal(decide(expiresAt - 1).retire, false);
  assert.match(decide(expiresAt - 1).reason, /pointer retention bound/);
  assert.deepEqual(decide(expiresAt), { retire: true, reason: `final purchase lacks kept chain pointers (${missingChainPointers(late).join(', ')}) at the pointer retention bound; retired, operator action required`, operatorAction: { missing: missingChainPointers(late) } });
  // Without the chain pointer rule the same purchase still waits out its grace.
  assert.match(decide(expiresAt, false).reason, /inside the grace window/);
  assert.equal(decide(expiresAt + 10 * 60 * 1000, false).retire, true);
});

// a an earlier review (P3): a legacy final row, verified before the seller answer
// (or its signed payment projection) was retained, has no projection for a
// seller-free read either. Its key used to be kept forever; now it retires
// exactly at the same bound, with the same durable operator hold.
for (const [shape, edit] of [['no retained seller answer', (p) => { delete p.sellerAnswer; }], ['a retained seller answer without its signed payment projection', (p) => { delete p.sellerAnswer.signedProjection; }]]) {
  test(`on, the key sweep alone, a legacy final row with ${shape}: kept until the pointer retention bound, then the key retires exactly at it and the purchase is held for the operator`, { timeout: 600000 }, async (t) => {
    const w = await world(t, { offRow: true, manualSweeps: true, idempotencyKey: `chain-readback-final-hold-legacy-${shape.length}` });
    const db = w.h.application.db, stored = JSON.parse(db.prepare('SELECT state FROM operations WHERE id = ?').get(w.operationId).state);
    edit(stored.protocol);
    db.prepare('UPDATE operations SET state = ? WHERE id = ?').run(JSON.stringify(stored), w.operationId);
    const original = structuredClone(w.op().state.protocol), missing = missingChainPointers(w.op()), baseline = w.effects();
    assert.ok(missing.length, 'verified before the switch: no pointer kept');
    const directory = join(w.h.config.stateDirectory, 'seller-sessions'), key = join(directory, `${sha256Hex(w.operationId)}.json`);
    const bound = original.sessionDelegation.payload.expiresAt + SELLER_SESSION_POINTER_RETENTION_MS;
    w.freeze(bound - 1);
    let swept = w.h.operator.sweepSellerSessions();
    assert.equal(swept.deleted.length, 0, 'one millisecond before the bound the key is kept');
    assert.match(swept.kept.find((item) => item.operationId === w.operationId).reason, /^final purchase has no retained signed payment projection and lacks kept chain pointers .*\(pointer retention bound\)$/);
    assert.equal(readFileSync(key, 'utf8').length > 0, true);
    assert.equal(w.op().state.protocol.chainReadbackHeld, undefined);
    w.freeze(bound);
    swept = w.h.operator.sweepSellerSessions();
    assert.deepEqual(swept.deleted.map((item) => item.operationId), [w.operationId], JSON.stringify(swept.kept));
    assert.deepEqual(swept.deleted[0].operatorAction, { missing });
    assert.throws(() => readFileSync(key), { code: 'ENOENT' });
    const p = w.op().state.protocol;
    assert.equal(p.stage, original.stage); assert.deepEqual(p.delivery, original.delivery);
    assert.equal(p.revision, original.revision, 'holding is not progress');
    assert.equal(p.chainReadbackHeld.action, CHAIN_READBACK_OPERATOR_ACTION); assert.deepEqual(p.chainReadbackHeld.missing, missing);
    // The hold keeps the first 240 characters of the deletion reason.
    assert.equal(p.chainReadbackHeld.reason, swept.deleted[0].reason.slice(0, 240));
    assert.match(swept.deleted[0].reason, /^final purchase has no retained signed payment projection and lacks kept chain pointers .* at the pointer retention bound; retired, operator action required$/);
    const [event, ...extra] = db.prepare("SELECT data FROM operation_events WHERE operation_id = ? AND type = 'seller_session_key_deleted'").all(w.operationId).map((row) => JSON.parse(row.data));
    assert.equal(extra.length, 0); assert.equal(event.operatorAction, CHAIN_READBACK_OPERATOR_ACTION); assert.deepEqual(event.missing, missing);
    assert.equal(w.health().stuck.find((item) => item.purchaseId === w.operationId)?.outcome, 'operator-action-required');
    assert.deepEqual(w.effects(), baseline, 'no CREATE or payment');
  });
}

// a an earlier review (P2): the same legacy row without its payment evidence too,
// and with every pointer missingChainPointers() still names kept, so nothing
// is missing to hold. It cannot reproduce its verified payment, so its key is
// never retired: kept at the bound and long after, reported on every sweep,
// with no deletion event and no hold.
test('on, the key sweep alone, a legacy final row with no retained seller answer and no payment evidence: its key is kept at the pointer retention bound and after, and every sweep reports it', { timeout: 600000 }, async (t) => {
  const w = await world(t, { offRow: true, manualSweeps: true, idempotencyKey: 'chain-readback-final-hold-legacy-no-payment-evidence' });
  const db = w.h.application.db, stored = JSON.parse(db.prepare('SELECT state FROM operations WHERE id = ?').get(w.operationId).state);
  delete stored.protocol.sellerAnswer; delete stored.protocol.paymentEvidence;
  db.prepare('UPDATE operations SET state = ? WHERE id = ?').run(JSON.stringify(stored), w.operationId);
  stored.protocol.chainReadback = Object.fromEntries(missingChainPointers(w.op()).map((address) => [address, { TEST: 'kept signed CREATE' }]));
  db.prepare('UPDATE operations SET state = ? WHERE id = ?').run(JSON.stringify(stored), w.operationId);
  assert.deepEqual(missingChainPointers(w.op()), [], 'nothing is missing to hold');
  const original = structuredClone(w.op().state.protocol), baseline = w.effects();
  const directory = join(w.h.config.stateDirectory, 'seller-sessions'), key = join(directory, `${sha256Hex(w.operationId)}.json`), marker = join(directory, `${sha256Hex(w.operationId)}.retired.json`);
  const bound = original.sessionDelegation.payload.expiresAt + SELLER_SESSION_POINTER_RETENTION_MS;
  const reason = 'final purchase record is malformed: the verified payment evidence is not at its canonical address';
  const lines = [], write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) { lines.push(String(chunk)); return write.call(this, chunk, ...rest); };
  t.after(() => { process.stderr.write = write; });
  for (const time of [bound - 1, bound, bound + 400 * 24 * 60 * 60 * 1000]) {
    w.freeze(time); lines.length = 0;
    const swept = w.h.operator.sweepSellerSessions(), when = new Date(time).toISOString();
    assert.deepEqual(swept.deleted, [], when);
    assert.equal(swept.kept.find((item) => item.operationId === w.operationId)?.reason, reason, when);
    assert.ok(lines.includes(`seller-session-sweep: ${w.operationId}: ${reason}\n`), `${when}: reported on stderr`);
    assert.equal(readFileSync(key, 'utf8').length > 0, true); assert.throws(() => readFileSync(marker), { code: 'ENOENT' });
  }
  process.stderr.write = write;
  assert.deepEqual(w.op().state.protocol, original, 'no hold; nothing changed');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM operation_events WHERE operation_id = ? AND type = 'seller_session_key_deleted'").get(w.operationId).n, 0);
  assert.deepEqual(w.effects(), baseline, 'no CREATE or payment');
});

// Code an earlier review (P2-2), the reviewer's probe zz-r3-seller-bytes: a final
// row verified before the switch was turned on asks the seller for its missing
// pointers. A seller (buggy, a corrupted cache or hostile) answers with a
// payment-evidence signed CREATE whose signature is garbled, then with a
// Deliverable receipt that differs from the chain. Neither is a contradiction
// of anything this purchase holds: the verified row is kept and read again from
// its retained answer, and nothing is written or paid. Switch off (control),
// the same final row reads back from its retained answer alone.
for (const flip of [true, false]) {
  test(`${flip ? 'on' : 'off (control)'}, a final row verified before the switch: a seller answer whose payment evidence signed CREATE does not authenticate, then one whose Deliverable receipt differs from the chain, keeps the verified delivery`, { timeout: 600000 }, async (t) => {
    const w = await world(t, { offRow: true, flip, idempotencyKey: `chain-readback-final-hold-seller-bytes-${flip ? 'on' : 'off'}` });
    assert.equal(w.result.status, 'delivery-ready');
    const original = structuredClone(w.op().state.protocol), baseline = w.effects();
    const kept = (reason) => {
      if (flip) return assertKept(w, original, reason);
      const p = w.op().state.protocol;
      // Switch off each recheck verifies afresh, so only the observation times move.
      assert.equal(p.stage, original.stage); assert.deepEqual(unobserved(p.delivery), unobserved(original.delivery)); assert.deepEqual(unobserved(p.paymentEvidence), unobserved(original.paymentEvidence));
      assert.deepEqual([p.attempts.at(-1).step, p.attempts.at(-1).outcome], ['delivery', 'verified'], 'switch off: the retained answer verifies as before');
      return p;
    };
    let restore = editAnswer(w, (answer) => {
      assert.ok(answer.signedProjection?.signature?.data, 'the cached answer carries the payment evidence signed CREATE');
      const data = answer.signedProjection.signature.data;
      answer.signedProjection.signature.data = data.slice(0, -2) + (data.endsWith('00') ? '11' : '00');
    });
    let asked = w.asks();
    await w.verify();
    assert.equal(w.asks(), asked + (flip ? 1 : 0), flip ? 'the row missing its pointers asked the seller' : 'switch off: the seller is not asked');
    kept(/Deliverable signed CREATE.*the seller answer's payment evidence signed CREATE did not authenticate \(.*writer authorization/);
    restore();

    restore = editAnswer(w, (answer) => { answer.delivery.anchorReceipt = { ...answer.delivery.anchorReceipt, nonce: Number(answer.delivery.anchorReceipt.nonce) + 7 }; });
    w.advance(CHAIN_POINTER_ASK_INTERVAL_MS + 1000); asked = w.asks();
    await w.verify();
    assert.equal(w.asks(), asked + (flip ? 1 : 0));
    kept(/Deliverable signed CREATE.*the seller answer's Deliverable receipt differs from the verified delivery/);
    restore();

    // an earlier review (a review P2-1): the fresh answer's Deliverable pointer
    // meets node bytes that do not authenticate (an unmarked adapter
    // `invalid`). That rejects nothing; it is the seller offer's problem, so the
    // row reads again from its retained answer, as before the source change.
    if (flip) {
      w.chain(alteredAt(w, original.delivery.anchorReceipt.nativeAddress, (data) => ({ ...data, title: 'TEST unauthenticated node bytes' })));
      w.advance(CHAIN_POINTER_ASK_INTERVAL_MS + 1000); asked = w.asks();
      try { await w.verify(); } finally { w.chain(null); }
      assert.equal(w.asks(), asked + 1);
      kept(/Deliverable signed CREATE.*the seller answer's Deliverable signed CREATE did not authenticate \(native Deliverable read: invalid: /);
    }
    assert.deepEqual(w.effects(), baseline, 'nothing written or paid');
  });
}

// The durable state a crash leaves when it stops the key sweep after the
// retired marker and the unlink, before the purchase history and the hold.
function retireWithoutHistory(w, operationId) {
  const directory = join(w.h.config.stateDirectory, 'seller-sessions'), name = sha256Hex(operationId);
  const record = JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
  writeFileSync(join(directory, `${name}.retired.json`), `${JSON.stringify({ format: 'dacs-seller-session-retired/v1', operationId, accountId: record.accountId, sessionPublicKey: record.payload.sessionPublicKey,
    retiredAt: Date.now(), reason: 'TEST final purchase lacks kept chain pointers at the pointer retention bound; retired, operator action required' })}\n`, { mode: 0o600, flag: 'wx' });
  unlinkSync(join(directory, `${name}.json`));
  return record.payload.sessionPublicKey;
}

test('on, a key retired without its purchase history (a crash between the retired marker and the hold): a recheck holds the purchase; a restart writes the deletion event and the hold; another restart changes nothing; other markers are ignored and reported', { timeout: 600000 }, async (t) => {
  const w = await world(t, { offRow: true, manualSweeps: true, idempotencyKey: 'chain-readback-final-hold-crash-a', morePurchases: ['chain-readback-final-hold-crash-b'] });
  const a = w.operationId, b = w.more[0].operationId, baseline = w.effects();
  const originalA = structuredClone(w.opOf(a).state.protocol), originalB = structuredClone(w.opOf(b).state.protocol);
  assert.ok(missingChainPointers(w.opOf(a)).length && missingChainPointers(w.opOf(b)).length, 'both rows verified before the switch and lack pointers');
  const deletions = (id) => w.h.application.db.prepare("SELECT data FROM operation_events WHERE operation_id = ? AND type = 'seller_session_key_deleted'").all(id).map((row) => JSON.parse(row.data));
  const outcome = (id) => w.health().stuck.find((row) => row.purchaseId === id)?.outcome;

  // Code an earlier review (MF3): the running process. The recheck's ask finds
  // the key retired, so nothing can obtain the missing pointer any more: it
  // holds the purchase itself, and asks nothing of the seller.
  const keyA = retireWithoutHistory(w, a);
  const asked = w.asks();
  await w.verify(a);
  assert.equal(w.asks(), asked, 'the retired key signs nothing; the seller is not asked');
  const heldA = assertKept(w, originalA, /seller session key is retired/, a).chainReadbackHeld;
  assert.equal(heldA.action, CHAIN_READBACK_OPERATOR_ACTION); assert.match(heldA.reason, /seller session key is retired/);
  assert.deepEqual(deletions(a), [], 'no deletion event was written before the crash');

  // a an earlier review (P2): after a restart, the startup sweep reconciles the
  // marker: B gets its deletion event and its hold; A gets its deletion event.
  const keyB = retireWithoutHistory(w, b);
  assert.equal(outcome(b), undefined, 'before the restart nothing reports B');
  await w.h.restart();
  const p = w.opOf(b).state.protocol;
  assert.equal(p.stage, originalB.stage); assert.deepEqual(p.delivery, originalB.delivery);
  assert.equal(p.revision, originalB.revision, 'holding is not progress');
  assert.equal(p.chainReadbackHeld.action, CHAIN_READBACK_OPERATOR_ACTION);
  assert.match(p.chainReadbackHeld.reason, /seller session key is retired/);
  assert.equal(outcome(b), 'operator-action-required');
  assert.equal(outcome(a), 'operator-action-required');
  for (const [id, key] of [[a, keyA], [b, keyB]]) {
    const [event, ...extra] = deletions(id);
    assert.equal(extra.length, 0);
    assert.equal(event.sessionPublicKey, key); assert.equal(event.reconciled, true); assert.match(event.reason, /^TEST final purchase lacks kept chain pointers/);
  }
  assert.deepEqual(w.opOf(a).state.protocol.chainReadbackHeld, heldA, 'A keeps the hold its recheck wrote');

  // Markers that are not exactly as the sweep writes them, or that name no
  // purchase, are ignored and reported. A second restart changes nothing.
  const directory = join(w.h.config.stateDirectory, 'seller-sessions');
  writeFileSync(join(directory, `${sha256Hex('pur_TESTmalformedmark')}.retired.json`), '{"format":"dacs-seller-session-retired/v1"}\n', { mode: 0o600 });
  writeFileSync(join(directory, `${sha256Hex('pur_TESTnotapurchase0')}.retired.json`), `${JSON.stringify({ format: 'dacs-seller-session-retired/v1', operationId: 'pur_TESTnotapurchase0', accountId: w.accountId,
    sessionPublicKey: sha256Hex('TEST key'), retiredAt: Date.now(), reason: 'TEST' })}\n`, { mode: 0o600 });
  const snapshot = () => [a, b].map((id) => ({ row: w.h.application.db.prepare('SELECT status, state, updated_at FROM operations WHERE id = ?').get(id),
    events: w.h.application.db.prepare('SELECT seq, at, type, data FROM operation_events WHERE operation_id = ? ORDER BY seq').all(id) }));
  const before = snapshot(), lines = [], write = process.stderr.write;
  process.stderr.write = function (chunk, ...rest) { lines.push(String(chunk)); return write.call(this, chunk, ...rest); };
  try { await w.h.restart(); } finally { process.stderr.write = write; }
  assert.deepEqual(snapshot(), before, 'the second restart writes nothing');
  assert.ok(lines.some((line) => /retired marker [0-9a-f]{64} ignored: retired marker is malformed/.test(line)), lines.join(''));
  assert.ok(lines.some((line) => /retired marker [0-9a-f]{64} \(pur_TESTnotapurchase0\) ignored: purchase not found/.test(line)), lines.join(''));
  assert.deepEqual(w.effects(), baseline, 'no CREATE or payment');
});
