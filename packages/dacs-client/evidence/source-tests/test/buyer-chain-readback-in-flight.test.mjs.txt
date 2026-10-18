// DACS_BUYER_CHAIN_READBACK turned on with purchases already in flight. Rows
// created with the switch off keep no signed CREATE bytes
// (state.protocol.chainReadback). With the switch on the buyer gets the
// pointer only through the seller's existing idempotent call (its answer
// replayed from the seller's effect cache), authenticates it on chain exactly
// as a fresh one and keeps it. When no pointer can be obtained the result is
// indeterminate: no stage is lowered, no verified result is cleared, nothing
// is sent, resent or refunded, and a session key is not retired while a
// pointer the seller-free readback needs is still missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { finalityCommitmentAddress, logicalToStorageProgramName } from '@kynesyslabs/dacs';
import { PUBLIC_SIGNED_CREATES } from '../src/dacs/buyer-chain-readback.mjs';
import { deliverableAddress } from '../src/dacs/purchase-protocol.mjs';
import { SELLER_SESSION_KEY_GRACE_MS } from '../src/devnet-demo/operator-sessions.mjs';
import { agree, creates, handoff, notFound, payAndDeliver, served, start } from './helpers/buyer-chain-readback-flow.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';

// The switch as the operator reads it (process.env), restored afterwards.
function switchEnv(t, value) {
  const previous = process.env.DACS_BUYER_CHAIN_READBACK;
  t.after(() => { if (previous === undefined) delete process.env.DACS_BUYER_CHAIN_READBACK; else process.env.DACS_BUYER_CHAIN_READBACK = previous; });
  process.env.DACS_BUYER_CHAIN_READBACK = value;
  return (next) => { process.env.DACS_BUYER_CHAIN_READBACK = next; };
}

test('on, a seller-committed row with no kept commitment bytes: approval replays the seller\'s commit answer, keeps the authenticated pointer and pays', { timeout: 420000 }, async (t) => {
  const h = await start(t, { buyerChainReadback: 'on' });
  const f = await agree(t, h);
  assert.equal((await f.verify()).protocol?.stage, 'seller-committed');
  const op = f.operation(), address = finalityCommitmentAddress(op.terms.protocol.jobId);
  assert.ok(op.state.protocol.chainReadback?.[address]);
  // A row from before the switch: switch-off rows carry no chainReadback.
  const state = structuredClone(op.state); delete state.protocol.chainReadback;
  h.app.db.prepare('UPDATE operations SET state = ? WHERE id = ?').run(JSON.stringify(state), op.id);
  let commits = 0; h.testHooks.afterSellerCommit = () => { commits += 1; };
  const sentBefore = served(h, '/dacs/v1/commitments').length, written = creates(h), revision = f.operation().state.protocol.revision;

  // A replayed pointer that does not authenticate is not kept; approval is refused and nothing moves.
  h.testHooks.rpcOverride = notFound(logicalToStorageProgramName(address));
  try {
    await assert.rejects(h.app.services.protocol.recheckCommitment(f.operation()),
      (error) => error.code === 'commitment_unverified' && /indeterminate/.test(error.message));
  } finally { h.testHooks.rpcOverride = null; }
  assert.equal(f.operation().state.protocol.chainReadback, undefined, 'a pointer that did not verify is not kept');
  assert.equal(f.operation().state.protocol.stage, 'seller-committed');

  // The pre-approval gate verifies the replayed pointer and keeps it, outside the purchase's progress.
  await h.app.services.protocol.recheckCommitment(f.operation(), { reuseVerified: true });
  const kept = f.operation().state.protocol;
  assert.ok(kept.chainReadback?.[address], 'the authenticated pointer is kept');
  assert.equal(kept.revision, revision, 'keeping a pointer is not progress');
  const replays = served(h, '/dacs/v1/commitments').slice(sentBefore);
  assert.ok(replays.length >= 2 && replays.every((answer) => answer[PUBLIC_SIGNED_CREATES]?.[address]), 'each replayed answer carried the seller\'s pointer');
  assert.equal(commits, 0, 'the seller replayed its stored answer; its commit route did not run again');

  const payment = await handoff(f);
  assert.equal(payment.status, 'payment_handoff');
  assert.equal(served(h, '/dacs/v1/commitments').length, sentBefore + replays.length, 'with the pointer kept, the handoff gate asks the seller nothing');
  assert.equal(creates(h), written, 'nothing was written or resent');
  const { completed } = await payAndDeliver(h, f, payment);
  assert.equal(completed.protocol?.stage, 'delivery-ready');
});

test('operator, off -> on restart at seller-committed: the commitment re-verifies from chain and the pointer is kept', { timeout: 600000 }, async (t) => {
  const set = switchEnv(t, 'off');
  const h = await startOperatorPurchaseNode2({ sellerApproval: { mode: 'policy' }, authorizeSellerApproval: () => true, authorizeBuyerApproval: ({ scope }) => scope.kind !== 'payment-terms' });
  t.after(() => h.close());
  await assert.rejects(h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'chain-readback-in-flight-committed' }));
  const row = h.application.db.prepare("SELECT id, account_id FROM operations WHERE kind='purchase' AND status='awaiting_approval'").get();
  assert.ok(row);
  let operation = h.application.services.ops.get(row.account_id, row.id);
  assert.equal(operation.state.protocol.stage, 'seller-committed');
  assert.equal(operation.state.protocol.chainReadback, undefined);
  const address = finalityCommitmentAddress(operation.terms.protocol.jobId), effects = () => ({ creates: h.node2.chain.wire.record.accepted.length, payments: h.node2.chain.record.accepted.length });

  set('on');
  await h.restart();
  assert.equal(h.prepared.config.buyerChainReadback, 'on');
  const baseline = effects();
  operation = h.application.services.ops.get(row.account_id, row.id);
  await h.application.services.protocol.recheckCommitment(operation, { reuseVerified: true });
  operation = h.application.services.ops.get(row.account_id, row.id);
  assert.ok(operation.state.protocol.chainReadback?.[address], 'the replayed pointer authenticated and was kept');
  await h.application.services.protocol.recheckCommitment(operation);
  const polled = await h.application.services.purchases.verifyDeal({ accountId: row.account_id, operationId: row.id });
  assert.equal(polled.operation.state.protocol.stage, 'seller-committed');
  assert.equal(polled.operation.status, 'awaiting_approval');
  assert.deepEqual(effects(), baseline, 'no CREATE or payment');
});

test('operator, a delivered off-row whose session key was retired stays delivered after the switch is turned on', { timeout: 600000 }, async (t) => {
  const set = switchEnv(t, 'off');
  let offsetMs = 0;
  const h = await startOperatorPurchaseNode2({ openBuyerAccess: true, now: () => Date.now() + offsetMs, authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true });
  t.after(() => h.close());
  const result = await h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'chain-readback-in-flight-retired' });
  assert.equal(result.status, 'delivery-ready');
  offsetMs = SELLER_SESSION_KEY_GRACE_MS + 1000;
  const swept = h.operator.sweepSellerSessions();
  assert.equal(swept.deleted.length, 1, JSON.stringify(swept.kept));
  const [{ operationId, accountId }] = swept.deleted;
  const op = () => h.application.services.ops.get(accountId, operationId), original = structuredClone(op().state.protocol);
  assert.equal(original.chainReadback, undefined);

  set('on');
  await h.restart();
  const directory = join(h.config.stateDirectory, 'seller-sessions'), keys = () => readdirSync(directory).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));
  const effects = () => ({ creates: h.node2.chain.wire.record.accepted.length, payments: h.node2.chain.record.accepted.length }), baseline = effects();
  for (let i = 0; i < 2; i++) await h.application.services.purchases.verifyDeal({ accountId, operationId });
  const p = op().state.protocol;
  assert.equal(p.stage, 'delivery-ready', JSON.stringify(p.attempts?.at(-1)));
  assert.deepEqual(p.delivery, original.delivery, 'the verified delivery is kept, not cleared');
  assert.deepEqual(p.paymentEvidence, original.paymentEvidence);
  assert.equal(p.attempts.at(-1).step, 'chain-readback'); assert.equal(p.attempts.at(-1).outcome, 'indeterminate');
  assert.match(p.attempts.at(-1).reason, /Deliverable signed CREATE/);
  assert.ok(Object.keys(p.chainReadback ?? {}).length === 1 && !p.chainReadback[deliverableAddress(result.jobId)], 'only the payment evidence pointer (from the retained answer) authenticated and was kept');
  const status = await h.application.services.purchases.verifyDeal({ accountId, operationId });
  assert.equal(status.operation.state.protocol.stage, 'delivery-ready');
  // A legacy off-row (verified before seller answers were retained): its pointer
  // is derived from the delivery and carries no signed payment-evidence bytes.
  const { sellerAnswer: _answer, chainReadback: _kept, ...legacy } = op().state.protocol;
  h.application.services.ops.transition(operationId, 'settled_verified', 'settled_verified', { state: { protocol: legacy }, event: 'TEST_legacy_row' });
  await h.application.services.purchases.verifyDeal({ accountId, operationId });
  const l = op().state.protocol;
  assert.equal(l.stage, 'delivery-ready', JSON.stringify(l.attempts?.at(-1)));
  assert.deepEqual(l.delivery, original.delivery);
  assert.match(l.attempts.at(-1).reason, /payment evidence signed CREATE/);
  assert.deepEqual(effects(), baseline, 'no CREATE or payment');
  assert.deepEqual(keys(), [], 'no replacement session key');
});

test('operator, a delivered off-row with a live key after the switch is turned on: an unreachable seller holds without downgrading, and the key is kept until the pointers are', { timeout: 600000 }, async (t) => {
  const set = switchEnv(t, 'off');
  let offsetMs = 0, sellerDown = false, h;
  const sellerCalls = [];
  h = await startOperatorPurchaseNode2({ openBuyerAccess: true, now: () => Date.now() + offsetMs, authorizeSellerApproval: () => true, authorizeBuyerApproval: () => true,
    rpcFault: ({ url }) => {
      if (!h || new URL(url).origin !== new URL(h.config.sellerOrigin).origin) return null;
      sellerCalls.push(new URL(url).pathname);
      return sellerDown ? new Response(JSON.stringify({ error: 'TEST seller unreachable' }), { status: 503, headers: { 'content-type': 'application/json' } }) : null;
    } });
  t.after(() => h.close());
  const result = await h.operator.createBuyerDriver({ composition: h.composition }).purchase({ idempotencyKey: 'chain-readback-in-flight-live-key' });
  assert.equal(result.status, 'delivery-ready');
  set('on');
  await h.restart();
  const row = h.application.db.prepare('SELECT account_id FROM operations WHERE id = ?').get(result.operationId), accountId = row.account_id, operationId = result.operationId;
  const op = () => h.application.services.ops.get(accountId, operationId), original = structuredClone(op().state.protocol);
  const verify = () => h.application.services.purchases.verifyDeal({ accountId, operationId });
  const effects = () => ({ creates: h.node2.chain.wire.record.accepted.length, payments: h.node2.chain.record.accepted.length }), baseline = effects();
  const directory = join(h.config.stateDirectory, 'seller-sessions'), keys = () => readdirSync(directory).filter((name) => /^[0-9a-f]{64}\.json$/.test(name));

  sellerDown = true;
  const asked = sellerCalls.length;
  await verify();
  sellerDown = false;
  assert.ok(sellerCalls.length > asked, 'the final row missing its pointers asked the seller');
  let p = op().state.protocol;
  assert.equal(p.stage, 'delivery-ready', JSON.stringify(p.attempts?.at(-1)));
  assert.deepEqual(p.delivery, original.delivery, 'an unreachable seller clears nothing');
  assert.equal(p.attempts.at(-1).step, 'chain-readback'); assert.equal(p.attempts.at(-1).outcome, 'indeterminate');
  assert.match(p.attempts.at(-1).reason, /seller could not be asked/);

  offsetMs = SELLER_SESSION_KEY_GRACE_MS + 1000;
  const kept = h.operator.sweepSellerSessions();
  assert.equal(kept.deleted.length, 0, 'the key a seller-backed recheck still needs is kept');
  assert.ok(kept.kept.some((item) => item.operationId === operationId && /lacks kept chain pointers/.test(item.reason)), JSON.stringify(kept.kept));
  assert.equal(keys().length, 1);

  // The seller is back: its replayed answer carries the pointers; they authenticate and are kept.
  await verify();
  p = op().state.protocol;
  assert.equal(p.stage, 'delivery-ready');
  assert.ok(p.chainReadback?.[deliverableAddress(result.jobId)], 'the Deliverable pointer is kept');
  assert.equal(Object.keys(p.chainReadback).length, 2, 'payment evidence and Deliverable pointers are kept');
  const retired = h.operator.sweepSellerSessions();
  assert.equal(retired.deleted.length, 1, JSON.stringify(retired.kept));
  await verify();
  assert.equal(op().state.protocol.stage, 'delivery-ready', 'the seller-free readback verifies from the kept pointers');
  assert.equal(op().state.protocol.attempts.at(-1).outcome, 'verified');
  assert.deepEqual(effects(), baseline, 'no CREATE or payment');
});
