import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { generateCanonicalJobId } from '@kynesyslabs/dacs';
import { listingPin } from '../src/dacs/purchase-protocol.mjs';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { createSellerAgentClient, createSellerHttpHandler, SellerRefusedError } from '../src/dacs/seller-http.mjs';
import { commitWorld, clone } from './helpers/review-commit-retry-coverage-world.mjs';

const request = w => ({ jobId: w.jobId, agreement: clone(w.agreement), signedProjection: clone(w.signedProjection) });

// One synthetic loopback request into the actual handler (no socket).
async function post(handler, path, body) {
  const raw = Buffer.from(JSON.stringify(body));
  const req = Readable.from([raw]);
  Object.assign(req, { url: path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(raw.length) },
    socket: { remoteAddress: '127.0.0.1', localAddress: '127.0.0.1' } });
  const answer = { status: 0, text: '' };
  await handler(req, { destroyed: false, writableEnded: false, writeHead(status) { answer.status = status; }, end(text) { answer.text = String(text); } });
  return { status: answer.status, body: JSON.parse(answer.text) };
}

test('off keeps main\'s route table: the early route is not found before any reservation', async t => {
  let calls = 0;
  const agent = { claim: `did:demos:agent:${'11'.repeat(32)}`, listingPin: { listingId: 'x', version: 1, contentHash: '22'.repeat(32) },
    commitOnSignature() { calls++; throw new SellerAgentError('signature_commitment_disabled', 'commitment on signature is disabled'); } };
  const body = { jobId: 'job', agreement: {}, signedProjection: {} };
  assert.deepEqual(await post(createSellerHttpHandler(agent), '/dacs/v1/commitments/signature', body), { status: 404, body: { error: 'not_found' } });
  assert.equal(calls, 0);
  assert.equal((await post(createSellerHttpHandler(agent, { commitOnSignature: true }), '/dacs/v1/commitments/signature', body)).status, 422, 'a definite refusal when enabled');
  assert.equal(createSellerAgentClient({ url: 'http://127.0.0.1:1' }).commitOnSignature, undefined);
  assert.equal(typeof createSellerAgentClient({ url: 'http://127.0.0.1:1', commitOnSignature: true }).commitOnSignature, 'function');
  assert.throws(() => createSellerHttpHandler(agent, { commitOnSignature: 'on' }), /boolean/);

  const w = await commitWorld(t, { fixedClock: true, http: true });
  for (let i = 0; i < 2; i++) await assert.rejects(w.client.commitOnSignature(w.jobId, w.agreement, w.signedProjection));
  assert.equal(w.effects.reconcile, 0, 'no retained transport effect to reconcile');
  assert.equal(w.effects.commitmentSignatures, 0);
});

test('read-only reconciliation never starts an early attempt or reserves the buyer slot', async t => {
  const w = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  const answer = await w.agent.reconcileTransport(w.transport('/dacs/v1/commitments/signature', request(w)));
  assert.equal(answer.disposition, 'indeterminate');
  assert.equal(w.effects.commitmentSignatures, 0); assert.equal(w.effects.publish, 0);
  assert.equal((await w.retained()).signatureCommitmentAttempt, undefined);
  // The buyer slot is still free for another job (the scripted native
  // capability holds one record, so the second job starts from none).
  const next = await w.newAgreement();
  assert.equal((await w.agent.commitOnSignature(next)).status, 'commitment-held');
  w.native.stored = null;
  assert.equal((await w.agent.commit({ jobId: w.jobId })).status, 'committed');
  assert.equal(w.effects.publish, 2);
});

test('with a retained attempt, reconciliation of a malformed signature request is held rather than answered by readback', async t => {
  const w = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  assert.equal((await w.agent.commitOnSignature(request(w))).status, 'commitment-held');
  for (const body of [{ jobId: w.jobId }, { ...request(w), extra: true }]) {
    assert.equal((await w.agent.reconcileTransport(w.transport('/dacs/v1/commitments/signature', body))).disposition, 'indeterminate');
  }
  assert.equal(w.agent.stageOf(w.jobId), 'proposed');
  assert.equal(w.effects.publish, 1);
});

test('an unresolved buyer slot is a definite HTTP refusal; the identical retry performs once the slot is released', async t => {
  const w = await commitWorld(t, { commitOnSignature: true, fixedClock: true, http: true });
  const state = await createSellerDurableState({ dir: w.buildOptions.durableDirectory, signer: w.buildOptions.signer, listingPin: listingPin(w.buildOptions.listing) });
  t.after(() => state.close());
  // The same buyer holds an unresolved early commitment on another job.
  const other = generateCanonicalJobId();
  await state.withJob(other, async () => state.reserveSignatureCommitment(w.buyer.claim, other));
  await assert.rejects(w.client.commitOnSignature(w.jobId, w.agreement, w.signedProjection),
    e => e instanceof SellerRefusedError && e.code === 'seller_signature_buyer_unresolved' && e.status === 409);
  assert.equal(w.effects.commitmentSignatures, 0);
  await state.withJob(other, async () => state.releaseSignatureCommitment(w.buyer.claim, other));
  assert.equal((await w.client.commitOnSignature(w.jobId, w.agreement, w.signedProjection)).status, 'commitment-held');
  assert.equal(w.effects.reconcile, 0, 'performed, not reduced from an uncertain effect');
  assert.equal(w.effects.publish, 1);
});

test('a transient read before signing leaves the ordinary commitment available after Agreement readback', async t => {
  const w = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  w.native.status = 'indeterminate';
  await assert.rejects(w.agent.commitOnSignature(request(w)), e => e.code === 'commitment_failed');
  w.native.status = null;
  await w.retained();
  // A repeated early request stays readback-only.
  await assert.rejects(w.agent.commitOnSignature(request(w)), e => e.code === 'commitment_failed');
  assert.equal(w.effects.commitmentSignatures, 0); assert.equal(w.effects.publish, 0);
  assert.equal((await w.agent.commit({ jobId: w.jobId })).status, 'committed');
  assert.equal(w.effects.publish, 1);
  w.native.stored = null;
  assert.equal((await w.agent.commitOnSignature(await w.newAgreement())).status, 'commitment-held', 'the buyer slot was released');
});

test('a definite publication failure before any intent leaves the ordinary commitment available; a seen commitment is never published again', async t => {
  const w = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  const publish = w.buildOptions.nativeArtifactAnchor.publish;
  w.buildOptions.nativeArtifactAnchor.publish = async () => { throw new Error('TEST connection closed before the publisher retained an intent'); };
  await w.retained();
  await assert.rejects(w.agent.commitOnSignature(request(w)), e => e.code === 'commitment_failed');
  assert.equal(w.native.stored, null);
  w.buildOptions.nativeArtifactAnchor.publish = publish;
  await w.retained();
  assert.equal((await w.agent.commit({ jobId: w.jobId })).status, 'committed');
  assert.equal(w.effects.publish, 1);
  assert.equal(w.effects.commitmentSignatures, 1, 'the retained record signature is reused');

  const held = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  assert.equal((await held.agent.commitOnSignature(request(held))).status, 'commitment-held');
  assert.equal((await held.retained()).signatureCommitmentHeld, true);
  held.native.stored = null;
  await assert.rejects(held.agent.commit({ jobId: held.jobId }), e => e.code === 'commitment_failed');
  assert.equal(held.effects.publish, 1);
});

test('a late early request for a committed job only reads back and takes no buyer slot', async t => {
  const w = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  assert.equal((await w.agent.commit({ jobId: w.jobId })).status, 'committed');
  assert.equal((await w.agent.commitOnSignature(request(w))).status, 'commitment-held');
  assert.equal(w.effects.publish, 1);
  assert.equal((await w.retained()).signatureCommitmentAttempt, undefined);
  w.native.stored = null;
  assert.equal((await w.agent.commitOnSignature(await w.newAgreement())).status, 'commitment-held');
});

test('a reservation retained without its session marker is released by that job\'s authenticated readback', async t => {
  const w = await commitWorld(t, { commitOnSignature: true, fixedClock: true });
  // The durable state a crash between the reservation and the session save leaves.
  const state = await createSellerDurableState({ dir: w.buildOptions.durableDirectory, signer: w.buildOptions.signer, listingPin: listingPin(w.buildOptions.listing) });
  try { await state.withJob(w.jobId, async () => state.reserveSignatureCommitment(w.buyer.claim, w.jobId)); } finally { state.close(); }
  await w.retained();
  const next = await w.newAgreement();
  await assert.rejects(w.agent.commitOnSignature(next), e => e.code === 'seller_signature_buyer_unresolved');
  assert.equal((await w.agent.commit({ jobId: w.jobId })).status, 'committed');
  w.native.stored = null;
  assert.equal((await w.agent.commitOnSignature(next)).status, 'commitment-held');
});
