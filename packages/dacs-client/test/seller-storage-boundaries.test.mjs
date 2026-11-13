import test from 'node:test';
import assert from 'node:assert/strict';
import { storedWorld, PATHS, bodyFor, errorCode } from './helpers/stored-request-fixture.mjs';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';
import { SellerTlsUnusableError } from '../src/dacs/seller-http.mjs';

const P = PATHS.proposals;
test('lossy and unsupported JSON is refused before persistence, signing or transport', async t => {
  for (const value of [NaN, Infinity, [undefined], 1e21, '\ud800', { toJSON: () => ({ changed: true }) }, undefined]) {
    const s = await storedWorld(t);
    await assert.rejects(s.client().propose({ ...bodyFor(P), value }), undefined, `value=${String(value)}`);
    assert.equal(s.record(P), undefined); assert.equal(s.fetches.length, 0); assert.equal(s.w.state.signs.length, 0);
  }
});

test('equivalent reordered input reuses exact stored bytes on restart', async t => {
  const s = await storedWorld(t), body = bodyFor(P);
  await s.client().propose(body); s.restart();
  await s.client().propose(Object.fromEntries(Object.entries(body).reverse()));
  assert.equal(s.fetches[0].body, s.fetches[1].body);
  await assert.rejects(s.client().propose({ ...body, different: true }), errorCode('stored_request_mismatch'));
});

test('neutral deadline observation preserves the in-flight result and the next protocol save', async t => {
  const s = await storedWorld(t), observation = { overdue: { at: 'TEST-observation' } };
  await s.client({ respond: init => {
    const row = s.p.get();
    s.p.ops.transition(row.id, row.status, row.status, { state: { protocol: { ...row.state.protocol, deliveryDeadline: observation } }, event: 'test_deadline', data: {} });
    return s.reply(init);
  } }).propose(bodyFor(P));
  assert.equal(s.record(P).lastClass, 'result');
  const saved = await s.p.service.identityRequest(s.holder.get(), s.w.buyer.address);
  assert.deepEqual(saved.operation.state.protocol.deliveryDeadline, observation);
});

test('inherited revisions seed progress before record bookkeeping advances the revision', async t => {
  const s = await storedWorld(t), snapshot = s.p.get(), generation = snapshot.state.protocol.revision ?? 0;
  s.records().start(P, bodyFor(P));
  assert.equal(s.p.get().state.protocol.progressGeneration, generation);
  const saved = await s.p.service.identityRequest(snapshot, s.w.buyer.address);
  assert.ok(saved.operation.state.protocol.progressGeneration > generation);
});

test('failed record and outcome commits never publish an uncommitted holder', async t => {
  const s = await storedWorld(t), before = s.holder.get();
  const { transaction } = createSqlitePurchaseStore();
  const abort = (db, work) => transaction(db, () => { work(); throw new Error('TEST-rollback'); });
  await assert.rejects(s.client({ requestRecords: s.records(s.holder, abort) }).propose(bodyFor(P)), /TEST-rollback/);
  assert.deepEqual(s.holder.get(), before); assert.deepEqual(s.p.get(), before);
  let writes = 0;
  const abortOutcome = (db, work) => transaction(db, () => { const result = work(); if (++writes === 2) throw new Error('TEST-outcome'); return result; });
  await assert.rejects(s.client({ requestRecords: s.records(s.holder, abortOutcome) }).propose(bodyFor(P)), /TEST-outcome/);
  assert.deepEqual(s.holder.get(), s.p.get()); assert.equal(s.record(P).lastClass, 'unknown');
});

test('approval expiry fences only pending approval statuses', async t => {
  for (const status of ['agreement_pending', 'awaiting_approval', 'payment_handoff', 'broadcast_reported', 'payment_uncertain']) {
    const s = await storedWorld(t, { status }); s.advance(3600000);
    if (['agreement_pending', 'awaiting_approval'].includes(status)) await assert.rejects(s.client().commit(s.w.job.jobId), errorCode('invalid_state'));
    else { const attempt = s.records().start(PATHS.commitments, bodyFor(PATHS.commitments)); assert.ok(attempt.text); }
  }
});

test('retained payment bytes can replay from delivery-rejected', async t => {
  const s = await storedWorld(t, { stage: 'payment-observed' }), path = PATHS.payments;
  await s.client().request(path, bodyFor(path)); s.patch({ stage: 'delivery-rejected' }); s.restart();
  await s.client().request(path, bodyFor(path)); assert.equal(s.fetches[0].body, s.fetches[1].body);
});

test('stored TLS refusal clears only its own attempt and preserves earlier unknown work', async t => {
  for (const priorUnknown of [false, true]) {
    const s = await storedWorld(t, { accepted: false }), path = PATHS.context;
    if (priorUnknown) s.records().start(path, bodyFor(path));
    const authentication = { ...s.auth, async request() { throw new SellerTlsUnusableError('TEST-TLS'); } };
    await assert.rejects(s.client({ authentication }).request(path, bodyFor(path)), errorCode('seller_tls_unusable'));
    assert.equal(s.record(path).attempts, priorUnknown ? 2 : 1); assert.equal(s.record(path).clearAttempts, 1);
    assert.equal(s.records().start(path, bodyFor(path)).newPurchase, !priorUnknown);
    assert.equal(s.fetches.length, 0);
  }
});
