// Exact-current C6-b coverage of retainCommitmentPhase parity between direct
// seller-agent commit and authenticated uncertain /dacs/v1/commitments
// adoption (reconcileTransport) after an applied native CREATE whose wallet
// answer was lost. Entry points: the actual seller-http handler, durable
// transport store, buyer client and seller-agent commit/reconcileTransport/
// submitPayment. Expected phase/commitment bytes are derived independently from
// the scripted applied CREATE, never from seller state. Phase-order/conflict
// preconditions are test-seeded through the signed durable API with the
// test-owned seller key. Two wrong-implementation witnesses import a TMPDIR copy
// of the exact source. NODE-only and offline: no socket, wallet, RPC, TLS or chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, contentHash, fixedPriceAgreementLogicalAddress } from '@kynesyslabs/dacs';
import { NATIVE_PAYMENT_EVIDENCE } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { SellerUnavailableError } from '../src/dacs/seller-http.mjs';
import { agreementTerms } from '../src/dacs/purchase-protocol.mjs';
import { clone, expectedCommitment, mutantCreateSellerAgent, phaseWorld, same } from './helpers/review-commit-phase-coverage-world.mjs';

const PAY_TX = `0x${'cd'.repeat(32)}`, PAY_TX_2 = `0x${'ce'.repeat(32)}`;
const ADOPTION = '        retainCommitmentPhase(adopted, adopted.commitment);\n        persist(adopted);';

// The applied CREATE with a lost wallet answer through the authenticated
// /commitments route: exactly one CREATE, one route call, an uncertain fence.
async function lostAnswer(w) {
  w.native.lostPublishResponse = true;
  await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError);
  w.native.lostPublishResponse = false; w.native.status = null;
  assert.equal(w.effects.publish, 1); assert.equal(w.effects.commitRoute, 1);
  const pending = await w.retained();
  assert.equal(pending.commitment, undefined); assert.ok(Number.isSafeInteger(pending.commitCreatedAt)); assert.equal(pending.phaseResults.length, 1);
  return { pending, applied: clone(w.native.stored) };
}
const reset = (w, applied) => { w.native.stored = clone(applied); w.native.view = (value) => value; w.native.status = null; w.native.verdict = 'valid'; w.agreementView.mode = 'present'; };
const paymentIndex = (w) => agreementTerms(w.agreement()).paymentPhaseIndex;

test('C6-b parity: normal direct commit, direct recovery and authenticated uncertain /commitments adoption each retain exactly the independently derived phase 1 and commitment', async (t) => {
  const paths = {
    'normal direct commit': async (w) => { assert.equal((await w.agent.commit({ jobId: w.jobId })).resumed, false); return false; },
    'direct recovery after lost wallet answer': async (w) => { await lostAnswer(w); assert.equal((await w.agent.commit({ jobId: w.jobId })).resumed, true); return true; },
    'authenticated uncertain /commitments adoption': async (w) => {
      await lostAnswer(w);
      const reduced = await w.client.commit(w.jobId);
      assert.equal(reduced.status, 'committed'); assert.equal(reduced.resumed, true);
      assert.equal(w.effects.commitRoute, 1, 'route not replayed'); assert.equal(w.effects.reconcile, 1);
      return true;
    },
  };
  for (const [label, run] of Object.entries(paths)) {
    const w = await phaseWorld(t);
    const resumed = await run(w);
    const expected = expectedCommitment(w, w.native.stored, resumed);
    const after = await w.retained();
    assert.ok(same(after.phaseResults[1], expected.phase), `${label}: phase 1 is the derived entry`);
    assert.ok(same(after.commitment, expected.commitment), `${label}: commitment is the derived SDK result`);
    assert.equal(after.phaseResults[1].invokedAt, w.clock + 1000, `${label}: native receipt time, not local commit time`);
    assert.equal(after.phaseResults.length, paymentIndex(w), `${label}: next recordPhase(paymentPhaseIndex) order precondition holds`);
    assert.equal(after.stage, 'committed'); assert.equal(w.agent.stageOf(w.jobId), 'committed');
    assert.equal(contentHash(after.agreement), w.agreementHash);
    assert.ok(same(after.agreementRef, { anchor: { kind: 'storage-program', locator: fixedPriceAgreementLogicalAddress(w.jobId) }, contentHash: w.agreementHash }));
    assert.ok(same(after.agreementAnchor, w.agreementNative));
    assert.equal(w.effects.publish, 1, `${label}: exactly one CREATE`);
    t.diagnostic(JSON.stringify({ path: label, phaseCount: after.phaseResults.length, invokedAt: after.phaseResults[1].invokedAt - w.clock, resumed: after.commitment.resumed, creates: w.effects.publish }));
  }
});

test('C6-b adoption from a timestamp-normalized fresh readback keeps that authenticated receipt; restart, direct retries under other timestamps and HTTP replay keep the session byte-identical', async (t) => {
  const w = await phaseWorld(t);
  const { applied } = await lostAnswer(w);
  w.native.view = (v) => { v.receipt.blockRef.timestamp = w.clock + 4321; v.receipt.observedAt = w.clock + 9999; return v; };
  const observed = w.native.view(clone(applied));
  const reduced = await w.client.commit(w.jobId);
  assert.equal(reduced.status, 'committed'); assert.equal(reduced.resumed, true);
  const expected = expectedCommitment(w, observed, true);
  const adopted = await w.retained();
  assert.ok(same(adopted.phaseResults[1], expected.phase)); assert.ok(same(adopted.commitment, expected.commitment));
  assert.equal(adopted.phaseResults[1].invokedAt, w.clock + 4321, 'authenticated receipt time at adoption');
  assert.notEqual(adopted.phaseResults[1].invokedAt, adopted.commitCreatedAt);
  for (const timestamp of [w.clock + 1000, w.clock + 7777]) {
    w.native.view = (v) => { v.receipt.blockRef.timestamp = timestamp; v.receipt.observedAt = timestamp; return v; };
    assert.equal((await w.agent.commit({ jobId: w.jobId })).resumed, true);
    assert.ok(same(await w.retained(), adopted), `direct retry at +${timestamp - w.clock} does not rewrite the session`);
  }
  const reconciles = w.effects.reconcile;
  assert.deepEqual(await w.client.commit(w.jobId), reduced, 'the reconciled answer is replayed from the store');
  assert.equal(w.effects.reconcile, reconciles); assert.equal(w.effects.commitRoute, 1); assert.equal(w.effects.publish, 1);
  assert.ok(same(await w.retained(), adopted));
});

test('C6-b adoption negatives: missing, indeterminate and conflicting identity/content/Agreement readback hold 503 with the pending session byte-identical, no CREATE and no route replay', async (t) => {
  const w = await phaseWorld(t);
  const { pending, applied } = await lostAnswer(w);
  const holds = {
    missing: () => { w.native.stored = null; },
    'rejected readback': () => { w.native.status = 'rejected'; },
    'indeterminate readback': () => { w.native.status = 'indeterminate'; },
    'receipt proof invalid': () => { w.native.verdict = 'invalid'; },
    'receipt proof indeterminate': () => { w.native.verdict = 'indeterminate'; },
    'receipt proof error': () => { w.native.verdict = 'error'; },
    'receipt not finalized': () => { w.native.view = (v) => { v.receipt.state = 'pending'; return v; }; },
    'receipt not established': () => { w.native.view = (v) => { v.receipt.observationDisposition = 'TEST-unknown'; return v; }; },
    'receipt logical address': () => { w.native.view = (v) => { v.receipt.logicalAddress += ':other'; return v; }; },
    'receipt content hash': () => { w.native.view = (v) => { v.receipt.contentHash = '0'.repeat(64); return v; }; },
    'malformed receipt time': () => { w.native.view = (v) => { v.receipt.blockRef.timestamp = String(v.receipt.blockRef.timestamp); return v; }; },
    'malformed anchorTxRef': () => { w.native.view = (v) => { v.txRef = { kind: 'demos' }; return v; }; },
    'self-consistent receipt over different record bytes': () => { w.native.view = (v) => { v.artifact.signature.value = Buffer.alloc(64).toString('base64url'); v.receipt.contentHash = contentHash(v.artifact); return v; }; },
    'Agreement readback absent': () => { w.agreementView.mode = 'absent'; },
    'Agreement readback indeterminate': () => { w.agreementView.mode = 'indeterminate'; },
    'Agreement readback substituted': () => { w.agreementView.mode = 'substituted'; },
  };
  const reasons = {};
  for (const [label, setup] of Object.entries(holds)) {
    reset(w, applied); setup();
    await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError, label);
    const direct = await w.agent.reconcileTransport(w.transport());
    assert.equal(direct.disposition, 'indeterminate', label); reasons[label] = direct.reason;
    if (label.startsWith('Agreement')) assert.equal(direct.reason, 'seller_agreement_readback_required', label);
    assert.ok(same(await w.retained(), pending), `${label}: pending durable session unchanged`);
    assert.equal(w.agent.stageOf(w.jobId), pending.stage);
  }
  assert.equal(w.effects.publish, 1); assert.equal(w.effects.commitRoute, 1); assert.equal(w.effects.reconcile, Object.keys(holds).length);
  t.diagnostic(JSON.stringify({ heldReasons: reasons }));
  reset(w, applied);
  assert.equal((await w.client.commit(w.jobId)).status, 'committed', 'accepting control after every hold');
  const adopted = await w.retained(), expected = expectedCommitment(w, applied, true);
  assert.ok(same(adopted.phaseResults[1], expected.phase)); assert.ok(same(adopted.commitment, expected.commitment));
  assert.equal(w.effects.publish, 1); assert.equal(w.effects.commitRoute, 1);
});

test('C6-b phase-order/conflict boundary (test-seeded inconsistent durable precondition): adoption holds with the exact reason, durable state unchanged, no CREATE/route; an identical retained phase 1 is accepted idempotently', async (t) => {
  const w = await phaseWorld(t);
  const { pending, applied } = await lostAnswer(w);
  const expected = expectedCommitment(w, applied, true);
  const cases = [
    ['seller_phase_conflict', (s) => { s.phaseResults[1] = { ...clone(expected.phase), invokedAt: expected.phase.invokedAt + 1 }; return s; }],
    ['seller_phase_order', (s) => { s.phaseResults = []; return s; }],
  ];
  for (const [code, mutate] of cases) {
    const seeded = await w.seed(mutate);
    assert.ok(same(await w.retained(), seeded));
    await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError, code);
    assert.deepEqual(await w.agent.reconcileTransport(w.transport()), { disposition: 'indeterminate', reason: code });
    const after = await w.retained();
    assert.ok(same(after, seeded), `${code}: durable session unchanged`); assert.equal(after.commitment, undefined);
    assert.equal(w.agent.stageOf(w.jobId), seeded.stage);
  }
  assert.equal(w.effects.publish, 1); assert.equal(w.effects.commitRoute, 1);
  await w.seed((s) => { s.phaseResults = [clone(pending.phaseResults[0]), clone(expected.phase)]; return s; });
  assert.equal((await w.client.commit(w.jobId)).status, 'committed', 'identical retained phase 1 is accepted');
  const adopted = await w.retained();
  assert.equal(adopted.phaseResults.length, 2);
  assert.ok(same(adopted.phaseResults[1], expected.phase)); assert.ok(same(adopted.commitment, expected.commitment));
  assert.equal(w.effects.publish, 1); assert.equal(w.effects.commitRoute, 1);
});

test('C6-b detached persistence boundary: a fenced durable write during adoption holds 503 with no durable change, CREATE or route; the next retry adopts once', async (t) => {
  const w = await phaseWorld(t);
  const { pending, applied } = await lostAnswer(w);
  w.native.beforeRead = () => w.stealLock();
  await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError);
  assert.equal(w.native.beforeRead, null, 'fault fired inside the seller reconciliation');
  assert.ok(same(await w.retained(), pending));
  w.native.beforeRead = () => w.stealLock();
  assert.deepEqual(await w.agent.reconcileTransport(w.transport()), { disposition: 'indeterminate', reason: 'seller_state_fenced' });
  assert.ok(same(await w.retained(), pending));
  assert.equal((await w.client.commit(w.jobId)).status, 'committed');
  const adopted = await w.retained(), expected = expectedCommitment(w, applied, true);
  assert.ok(same(adopted.phaseResults[1], expected.phase)); assert.ok(same(adopted.commitment, expected.commitment));
  assert.equal(w.effects.publish, 1); assert.equal(w.effects.commitRoute, 1);
});

test('C6-b wrong-implementation witness (non-atomic adoption): persisting the commitment before phase retention leaves a committed session without phase 1 and later retries answer committed', async (t) => {
  const mutant = await mutantCreateSellerAgent(t, [[ADOPTION, '        persist(adopted);\n        retainCommitmentPhase(adopted, adopted.commitment);']]);
  for (const [label, options] of [['exact', {}], ['mutant', { create: mutant }]]) {
    const w = await phaseWorld(t, options);
    await lostAnswer(w);
    const seeded = await w.seed((s) => { s.phaseResults = []; return s; });
    await assert.rejects(w.client.commit(w.jobId), SellerUnavailableError, label);
    const after = await w.retained();
    const retry = await w.client.commit(w.jobId).then((value) => value, (error) => error);
    if (label === 'exact') {
      assert.ok(same(after, seeded)); assert.ok(retry instanceof SellerUnavailableError);
    } else {
      assert.ok(after.commitment, 'mutant persisted the commitment'); assert.equal(after.phaseResults.length, 0); assert.equal(after.stage, 'committed');
      assert.equal(retry.status, 'committed', 'mutant now reconciles a session whose phase history is missing');
    }
    assert.equal(w.effects.publish, 1);
    t.diagnostic(JSON.stringify({ implementation: label, commitmentRetained: Boolean(after.commitment), phaseCount: after.phaseResults.length, retry: retry.status ?? retry.name }));
  }
});

test('C6-b wrong-implementation witness (omitted phase retention): adoption without retainCommitmentPhase stays one phase short of paymentPhaseIndex and direct commit never backfills it', async (t) => {
  const mutant = await mutantCreateSellerAgent(t, [[ADOPTION, '        persist(adopted);']]);
  for (const [label, options] of [['exact', {}], ['mutant', { create: mutant }]]) {
    const w = await phaseWorld(t, options);
    await lostAnswer(w);
    assert.equal((await w.client.commit(w.jobId)).status, 'committed');
    assert.equal((await w.agent.commit({ jobId: w.jobId })).resumed, true);
    const after = await w.retained();
    assert.equal(after.phaseResults.length, label === 'exact' ? paymentIndex(w) : paymentIndex(w) - 1, label);
    assert.equal(w.effects.publish, 1);
    t.diagnostic(JSON.stringify({ implementation: label, phaseCount: after.phaseResults.length, paymentPhaseIndex: paymentIndex(w) }));
  }
});

test('C6-b retained native /payments after adoption (authenticated HTTP): an uncertain /payments holds without route replay, resend or evidence anchor; direct entry passes commitment readback with no CREATE and stops at the refused observer', async (t) => {
  const w = await phaseWorld(t, { nativeEvidence: true });
  await lostAnswer(w);
  assert.equal((await w.client.commit(w.jobId)).status, 'committed');
  const adopted = await w.retained();
  const pay = (txHash) => ({ jobId: w.jobId, txHash, payerPayingKey: w.buyer.claim, nativePaymentEvidence: NATIVE_PAYMENT_EVIDENCE });
  w.ack.drop = true;
  await assert.rejects(w.client.submitPayment(pay(PAY_TX)), SellerUnavailableError);
  assert.equal(w.ack.drop, false, 'the performed route answer lost its acknowledgement');
  assert.equal(w.effects.paymentRoute, 1); assert.equal(w.effects.publish, 1); assert.equal(w.effects.anchorEvidence, 0);
  const fetches = w.effects.fetch, reads = w.effects.readRetained;
  await assert.rejects(w.client.submitPayment(pay(PAY_TX)), SellerUnavailableError);
  const other = await w.client.submitPayment(pay(PAY_TX_2)).then((value) => value, (error) => error);
  assert.ok(other instanceof Error, 'a different payment body is not accepted for this job');
  assert.equal(w.effects.paymentRoute, 1, 'uncertain /payments is never performed again'); assert.equal(w.effects.fetch, fetches);
  assert.deepEqual(await w.agent.reconcileTransport(w.transport('/dacs/v1/payments', pay(PAY_TX))), { disposition: 'indeterminate', reason: 'seller_payment_context_mismatch' });
  assert.equal(w.effects.readRetained, reads, 'held before any commitment readback');
  const answer = await w.agent.submitPayment(pay(PAY_TX));
  assert.notEqual(answer.step, 'commitment-readback', 'the adopted commitment authenticates on the readbackOnly entry');
  assert.notEqual(answer.status, 'payment-evidenced');
  assert.equal(w.effects.publish, 1); assert.equal(w.effects.anchorEvidence, 0);
  t.diagnostic(JSON.stringify({ directNativePaymentAnswer: answer, differentBody: { name: other.name, code: other.code }, observerFetches: w.effects.fetch }));
  const after = await w.retained();
  assert.equal(canonicalize(after.commitment), canonicalize(adopted.commitment));
  assert.equal(canonicalize(after.phaseResults), canonicalize(adopted.phaseResults));
  assert.equal(after.nativeEvidenceWork, undefined); assert.equal(after.paymentWork, undefined);
  assert.equal(after.stage, 'committed'); assert.equal(w.agent.stageOf(w.jobId), 'committed'); assert.equal(w.agent.deliveryStateOf(w.jobId), null);
});
