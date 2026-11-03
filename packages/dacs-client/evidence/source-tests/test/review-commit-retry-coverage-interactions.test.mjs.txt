// Exact-current C5/C6 interaction coverage of the retained native commitment
// readback-only contract. Every case enters through an actual route that
// reaches seller-agent commit or reconcileTransport: the legacy /payments route
// (:752), native /payments start (:975), the actual seller-http handler in
// authenticated reservation mode (uncertain /commitments -> reconcileTransport)
// and in unauthenticated legacy mode (/commitments -> commit). The two
// wrong-implementation witnesses import a TMPDIR copy of the exact source
// with one guard removed. NODE-only and offline: no socket, wallet, RPC, TLS or chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '@kynesyslabs/dacs';
import { NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { SellerUnavailableError } from '../src/dacs/seller-http.mjs';
import { clone, commitWorld, mutantCreateSellerAgent } from './helpers/review-commit-retry-coverage-world.mjs';

const PAY_TX = `0x${'cd'.repeat(32)}`;
const C5_GUARD = 'if(readbackOnly || retainedNativeCommitment) readbackRequired();';
const C6_GUARD = '!sameNativeCommitmentReceipt(session.commitment.anchorReceipt, finalized.anchorReceipt)))) refuse();';
const expectCode = async (promise, code) => { const error = await promise.then(() => null, (e) => e); assert.ok(error, `expected ${code}`); assert.equal(error.code, code, String(error?.message)); return error; };
const normalized = (w) => (value) => { value.receipt.blockRef.timestamp = w.clock + 4321; value.receipt.observedAt = w.clock + 9999; return value; };
const unchanged = (after, before) => {
  assert.equal(canonicalize(after.commitment), canonicalize(before.commitment), 'retained SDK commitment bytes are unchanged');
  assert.equal(canonicalize(after.phaseResults), canonicalize(before.phaseResults), 'phase history is not rewritten');
};
const reset = (w, applied) => { w.native.stored = clone(applied); w.native.view = (value) => value; w.native.status = null; w.native.verdict = 'valid'; };

test('C5 legacy /payments -> commit (:752): timestamp-only readback resumes; absent/ambiguous/wrong identity hold with zero second CREATE', async (t) => {
  const w = await commitWorld(t);
  assert.equal((await w.agent.commit({ jobId: w.jobId })).resumed, false); assert.equal(w.effects.publish, 1);
  const before = await w.retained(), applied = clone(w.native.stored);
  const pay = { jobId: w.jobId, txHash: PAY_TX, payerPayingKey: w.buyer.claim };
  w.native.view = normalized(w);
  const control = await w.agent.submitPayment(pay);
  assert.notEqual(control.status, 'delivered'); assert.equal(w.effects.publish, 1);
  t.diagnostic(JSON.stringify({ control: 'timestamp-normalized readback passed commit; payment stops at the out-of-scope observer', answer: control }));
  w.native.stored = null;
  const absent = await expectCode(w.agent.submitPayment(pay), 'commitment_failed');
  t.diagnostic(JSON.stringify({ absentMessage: absent.message }));
  for (const [code, setup] of [['commitment_failed', () => { w.native.status = 'indeterminate'; }], ['commitment_failed', () => { w.native.status = 'rejected'; }],
    ['commitment_failed', () => { w.native.verdict = 'invalid'; }], ['commitment_changed', () => { w.native.view = (v) => { v.receipt.blockRef.id = 'd4'.repeat(32); return v; }; }],
    ['commitment_changed', () => { w.native.view = (v) => { v.txRef.txHash = 'e5'.repeat(32); return v; }; }]]) {
    reset(w, applied); setup();
    await expectCode(w.agent.submitPayment(pay), code);
  }
  assert.equal(w.effects.publish, 1, 'no second CREATE through the payment route');
  const after = await w.retained();
  unchanged(after, before); assert.equal(after.paymentWork, undefined);
  // An uncertain /payments without retained work is held before any commitment readback.
  reset(w, applied);
  const reads = w.effects.readRetained;
  assert.deepEqual(await w.agent.reconcileTransport(w.transport('/dacs/v1/payments', pay)), { disposition: 'indeterminate', reason: 'seller_payment_context_mismatch' });
  assert.equal(w.effects.readRetained, reads); assert.equal(w.effects.publish, 1);
});

test('C5 native /payments start (:975, readbackOnly): absent/ambiguous/wrong identity are no-effect refusals with zero CREATE or evidence anchor', async (t) => {
  const w = await commitWorld(t, { nativeEvidence: true });
  await w.agent.commit({ jobId: w.jobId }); assert.equal(w.effects.publish, 1);
  const before = await w.retained(), applied = clone(w.native.stored);
  const pay = { jobId: w.jobId, txHash: PAY_TX, payerPayingKey: w.buyer.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE };
  const refused = (cause) => ({ status: 'rejected', reason: 'seller_native_evidence_not_started', step: 'commitment-readback', cause });
  for (const [cause, setup] of [['commitment_failed', () => { w.native.stored = null; }], ['commitment_failed', () => { w.native.status = 'indeterminate'; }],
    ['commitment_failed', () => { w.native.verdict = 'indeterminate'; }], ['commitment_changed', () => { w.native.view = (v) => { v.txRef.txHash = 'e5'.repeat(32); return v; }; }],
    ['commitment_changed', () => { w.native.view = (v) => { v.receipt.writer = 'did:demos:agent:' + 'f6'.repeat(32); return v; }; }]]) {
    reset(w, applied); setup();
    assert.deepEqual(await w.agent.submitPayment(pay), refused(cause));
  }
  assert.equal(w.effects.publish, 1); assert.equal(w.effects.anchorEvidence, 0); assert.equal(w.effects.fetch, 0, 'held before payment observation');
  reset(w, applied); w.native.view = normalized(w);
  const control = await w.agent.submitPayment(pay);
  assert.notEqual(control.step, 'commitment-readback', 'timestamp-only readback passes the commitment step');
  assert.equal(w.effects.publish, 1); assert.equal(w.effects.anchorEvidence, 0);
  t.diagnostic(JSON.stringify({ control }));
  const after = await w.retained();
  unchanged(after, before); assert.equal(after.nativeEvidenceWork, undefined);
});

test('C5 legacy unauthenticated seller-http /commitments -> commit: retry resumes; absent or wrong anchorTxRef is 503 with zero second CREATE', async (t) => {
  const w = await commitWorld(t, { http: 'legacy' });
  const first = await w.client.commit(w.jobId);
  assert.equal(first.status, 'committed'); assert.equal(first.resumed, false); assert.equal(w.effects.publish, 1);
  const before = await w.retained(), applied = clone(w.native.stored);
  w.native.view = normalized(w);
  const again = await w.client.commit(w.jobId);
  assert.equal(again.resumed, true); assert.equal(w.effects.publish, 1);
  reset(w, applied); w.native.stored = null;
  await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError);
  reset(w, applied); w.native.view = (v) => { v.txRef.txHash = 'e5'.repeat(32); return v; };
  await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError);
  assert.equal(w.effects.commitRoute, 4); assert.equal(w.effects.publish, 1);
  unchanged(await w.retained(), before);
});

test('C6 authenticated seller-http uncertain /commitments (lost ack after one CREATE): every hold is 503 without route, CREATE or durable change; timestamp-only readback reconciles once', async (t) => {
  const w = await commitWorld(t, { http: true });
  const finish = w.store.finish; let drop = true;
  w.store.finish = (...args) => { if (drop && args[1] === 200) { drop = false; throw new Error('TEST lost acknowledgement'); } return finish(...args); };
  await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError);
  assert.equal(w.effects.publish, 1); assert.equal(w.effects.commitRoute, 1);
  const before = await w.retained(), applied = clone(w.native.stored);
  assert.ok(before.commitment); assert.equal(before.stage, 'committed');
  const holds = {
    absent: () => { w.native.stored = null; },
    'indeterminate readback': () => { w.native.status = 'indeterminate'; },
    'rejected readback': () => { w.native.status = 'rejected'; },
    'receipt proof invalid': () => { w.native.verdict = 'invalid'; },
    'receipt proof indeterminate': () => { w.native.verdict = 'indeterminate'; },
    'block id': () => { w.native.view = (v) => { v.receipt.blockRef.id = 'd4'.repeat(32); return v; }; },
    'block height': () => { w.native.view = (v) => { v.receipt.blockRef.height = '10'; return v; }; },
    'receipt transactionRef': () => { w.native.view = (v) => { v.receipt.transactionRef.value = 'e5'.repeat(32); return v; }; },
    anchorTxRef: () => { w.native.view = (v) => { v.txRef.txHash = 'e5'.repeat(32); return v; }; },
    writer: () => { w.native.view = (v) => { v.receipt.writer = 'did:demos:agent:' + 'f6'.repeat(32); return v; }; },
    nonce: () => { w.native.view = (v) => { v.receipt.nonce = '8'; return v; }; },
    'native address': () => { w.native.view = (v) => { v.receipt.nativeAddress = 'TEST-native-other'; return v; }; },
    'receipt content hash': () => { w.native.view = (v) => { v.receipt.contentHash = '0'.repeat(64); return v; }; },
    'signed record': () => { w.native.view = (v) => { v.artifact.signature.value = Buffer.alloc(64).toString('base64url'); return v; }; },
    'malformed timestamp': () => { w.native.view = (v) => { v.receipt.blockRef.timestamp = String(v.receipt.blockRef.timestamp); return v; }; },
  };
  for (const [label, setup] of Object.entries(holds)) {
    reset(w, applied); setup();
    await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError, label);
  }
  assert.equal(w.effects.commitRoute, 1, 'the route is never performed again'); assert.equal(w.effects.reconcile, Object.keys(holds).length);
  assert.equal(w.effects.publish, 1);
  const held = await w.retained();
  unchanged(held, before); assert.equal(held.stage, before.stage);
  reset(w, applied); w.native.view = normalized(w);
  const reconciled = await w.client.commit(w.jobId);
  assert.equal(reconciled.status, 'committed'); assert.equal(reconciled.resumed, true);
  assert.equal(w.effects.publish, 1); assert.equal(w.effects.commitRoute, 1);
  unchanged(await w.retained(), before);
  const reconciles = w.effects.reconcile;
  assert.deepEqual(await w.client.commit(w.jobId), reconciled, 'the reconciled answer is now the completed effect');
  assert.equal(w.effects.reconcile, reconciles); assert.equal(w.effects.publish, 1);
});

test('C6 authenticated seller-http uncertain /commitments after an applied CREATE with a lost wallet answer: read-only adoption retains phase 1 and survives restart', async (t) => {
  const w = await commitWorld(t, { http: true });
  w.native.lostPublishResponse = true;
  await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError);
  w.native.lostPublishResponse = false; w.native.status = null;
  assert.equal(w.effects.publish, 1);
  const pending = await w.retained();
  assert.equal(pending.commitment, undefined); assert.ok(Number.isSafeInteger(pending.commitCreatedAt)); assert.equal(pending.phaseResults.length, 1);

  // Missing, ambiguous and conflicting native observations must leave the
  // pending durable session byte-for-byte unchanged and never re-enter CREATE.
  const applied = clone(w.native.stored);
  for (const [label, setup] of [
    ['missing', () => { w.native.stored = null; }],
    ['ambiguous', () => { w.native.status = 'indeterminate'; }],
    ['conflicting receipt content', () => { w.native.view = (value) => { value.receipt.contentHash = '0'.repeat(64); return value; }; }],
  ]) {
    w.native.stored = clone(applied); w.native.status = null; w.native.view = (value) => value;
    setup();
    await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError, label);
    const held = await w.retained();
    assert.equal(canonicalize(held), canonicalize(pending), `${label} readback cannot change pending durable state`);
    assert.equal(w.effects.publish, 1, `${label} readback cannot publish`);
  }
  w.native.stored = clone(applied); w.native.status = null; w.native.view = (value) => value;
  const reduced = await w.client.commit(w.jobId);
  assert.equal(reduced.status, 'committed'); assert.equal(reduced.resumed, true);
  assert.equal(w.effects.commitRoute, 1); assert.equal(w.effects.reconcile, 4); assert.equal(w.effects.publish, 1);
  const adopted = await w.retained();
  assert.ok(adopted.commitment); assert.equal(adopted.stage, 'committed');
  assert.equal(adopted.phaseResults.length, 2, 'read-only adoption retains commitment phase 1');
  assert.equal(adopted.phaseResults[1].index, 1);
  assert.equal(adopted.phaseResults[1].invokedAt, adopted.commitment.committedAt, 'native receipt time is the phase time');
  assert.deepEqual(adopted.phaseResults[1].result.txRefs, [adopted.commitment.anchorTxRef]);
  assert.deepEqual(adopted.phaseResults[1].result.anchorReceipt, adopted.commitment.anchorReceipt);
  assert.equal(adopted.phaseResults[1].result.attestationRef.contentHash, adopted.phaseResults[1].result.contextDelta['commit-payee-bound-agreement'].anchorReceipt.contentHash);
  // `retained()` restarted the seller. Later direct entry remains readback-only
  // and does not rewrite the adopted phase.
  const direct = await w.agent.commit({ jobId: w.jobId });
  assert.equal(direct.resumed, true); assert.equal(w.effects.publish, 1);
  const later = await w.retained();
  assert.equal(canonicalize(later.commitment), canonicalize(adopted.commitment));
  assert.equal(canonicalize(later.phaseResults), canonicalize(adopted.phaseResults));
  const progression = await w.agent.submitPayment({ jobId: w.jobId, txHash: PAY_TX, payerPayingKey: w.buyer.claim });
  assert.equal(progression.status, 'indeterminate', 'next supported phase boundary reaches the out-of-scope observer instead of seller_phase_order');
  assert.equal(w.effects.publish, 1);
  t.diagnostic(JSON.stringify({ observation: 'adopted commitment with durable phaseResults[1]', phaseCount: later.phaseResults.length, creates: w.effects.publish, progression }));
});

test('C6 control: the same applied CREATE with a lost wallet answer, recovered by direct commit (the resume seam), records phase 1 from the native receipt', async (t) => {
  const w = await commitWorld(t, { http: true });
  w.native.lostPublishResponse = true;
  await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError);
  w.native.lostPublishResponse = false; w.native.status = null;
  const recovered = await w.agent.commit({ jobId: w.jobId });
  assert.equal(recovered.status, 'committed'); assert.equal(recovered.resumed, true); assert.equal(w.effects.publish, 1);
  const after = await w.retained();
  assert.equal(after.phaseResults.length, 2); assert.equal(after.phaseResults[1].index, 1);
  assert.equal(after.phaseResults[1].invokedAt, after.commitment.committedAt, 'native receipt time is the phase time');
  const reduced = await w.client.commit(w.jobId);
  assert.equal(reduced.resumed, true); assert.equal(w.effects.commitRoute, 1); assert.equal(w.effects.publish, 1);
});

test('C5 wrong-implementation witness: without retainedNativeCommitment, the absent readback on legacy /payments and direct commit publishes again', async (t) => {
  const mutant = await mutantCreateSellerAgent(t, [[C5_GUARD, 'if(readbackOnly) readbackRequired();']]);
  const w = await commitWorld(t, { create: mutant });
  await w.agent.commit({ jobId: w.jobId }); assert.equal(w.effects.publish, 1);
  w.native.stored = null;
  await w.agent.submitPayment({ jobId: w.jobId, txHash: PAY_TX, payerPayingKey: w.buyer.claim }).catch(() => null);
  assert.equal(w.effects.publish, 2, 'the mutant re-enters publish where the exact current guard holds');
  w.native.stored = null;
  await w.agent.commit({ jobId: w.jobId }).catch(() => null);
  assert.equal(w.effects.publish, 3);
});

test('C5 wrong-implementation witness: native /payments start holds while either guard remains; only with both removed it publishes again', async (t) => {
  const pay = (w) => ({ jobId: w.jobId, txHash: PAY_TX, payerPayingKey: w.buyer.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE });
  for (const [replacement, creates] of [['if(retainedNativeCommitment) readbackRequired();', 1], ['if(readbackOnly) readbackRequired();', 1], ['if(false) readbackRequired();', 2]]) {
    const w = await commitWorld(t, { create: await mutantCreateSellerAgent(t, [[C5_GUARD, replacement]]), nativeEvidence: true });
    await w.agent.commit({ jobId: w.jobId });
    w.native.stored = null;
    await w.agent.submitPayment(pay(w)).catch(() => null);
    assert.equal(w.effects.publish, creates, replacement);
    assert.equal(w.effects.anchorEvidence, 0);
  }
});

test('C6 wrong-implementation witness: without sameNativeCommitmentReceipt, uncertain /commitments accepts a different immutable block', async (t) => {
  const mutant = await mutantCreateSellerAgent(t, [[C6_GUARD, 'false))) refuse();']]);
  const w = await commitWorld(t, { create: mutant });
  await w.agent.commit({ jobId: w.jobId });
  w.native.view = (v) => { v.receipt.blockRef.id = 'd4'.repeat(32); return v; };
  const wrong = await w.agent.reconcileTransport(w.transport());
  assert.equal(wrong.disposition, 'present', 'the mutant accepts what the exact current guard holds');
  w.native.view = (v) => { v.txRef.txHash = 'e5'.repeat(32); return v; };
  assert.equal((await w.agent.reconcileTransport(w.transport())).disposition, 'indeterminate', 'the separate anchorTxRef clause still holds');
  assert.equal(w.effects.publish, 1);
});
