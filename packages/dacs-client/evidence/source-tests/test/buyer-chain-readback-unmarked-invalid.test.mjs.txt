// DACS_BUYER_CHAIN_READBACK=on with the source change's SR-2 adapter: a node answer that does
// not authenticate is refused with an unmarked `invalid`, and the chain reader
// rejects only a marked contradiction. Native bytes that differ from the signed
// CREATE at the commitment read leave the purchase agreement_pending (never
// agreement_rejected), and at a final row's kept Deliverable keep the verified
// delivery. Nothing is resent.
// Review findings: PR the source change an earlier review, code P2-1 / a review P2-1 (the
// reviewer's probe chain-readback-unmarked-invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { start, agree, handoff, payAndDeliver, creates } from './helpers/buyer-chain-readback-flow.mjs';
import { createsOf } from './helpers/commitment-node-junk.mjs';

test('on: an unauthenticated node answer at the commitment read leaves the purchase agreement_pending; the next read completes it', { timeout: 600000 }, async (t) => {
  const h = await start(t, { buyerChainReadback: 'on' });
  h.testHooks.afterSellerCommit = (answer) => {
    if (!answer?.address) return;
    h.transport.chain.faults.native = (record) => record?.metadata?.artifactKind === 'FinalityCommitmentRecord'
      ? { ...record, data: { ...record.data, TEST: 'unauthenticated node bytes' } }
      : record;
    h.testHooks.afterSellerCommit = null;
  };
  const f = await agree(t, h);
  let result;
  try {
    result = await f.verify();
  } finally {
    h.transport.chain.faults.native = null;
  }

  const after = f.operation().state.protocol;
  assert.equal(result.status, 'agreement_pending', JSON.stringify(result));
  assert.equal(after.stage, 'agreement-anchored');
  assert.deepEqual([after.attempts.at(-1).step, after.attempts.at(-1).outcome], ['commitment', 'indeterminate']);
  assert.match(after.attempts.at(-1).reason, /native FinalityCommitmentRecord read: invalid: /);
  assert.equal(createsOf(h, 'FinalityCommitmentRecord').length, 1, 'the seller wrote its one commitment; the readback sends no replacement CREATE');
  const effects = creates(h);
  // The node answers again: readback alone completes the purchase.
  assert.equal((await f.verify()).status, 'awaiting_approval');
  assert.equal(creates(h), effects, 'nothing was written to complete it');
});

test('on: a final row keeps a verified Deliverable when node bytes no longer authenticate against its kept CREATE', { timeout: 600000 }, async (t) => {
  const h = await start(t, { buyerChainReadback: 'on' });
  const f = await agree(t, h);
  assert.equal((await f.verify()).status, 'awaiting_approval');
  const payment = await handoff(f);
  await payAndDeliver(h, f, payment);
  const before = structuredClone(f.operation().state.protocol);
  assert.equal(before.stage, 'delivery-ready');
  const effects = creates(h);

  // Node-returned native data differs from the seller's retained, previously
  // authenticated CREATE. demos-sr2-adapter refuses this as an unmarked
  // `invalid`: the node answer did not authenticate and is not a contradiction.
  h.transport.chain.faults.native = (record) => record?.metadata?.artifactKind === 'Deliverable'
    ? { ...record, data: { ...record.data, title: 'TEST unauthenticated node bytes' } }
    : record;
  try {
    await f.verify();
  } finally {
    h.transport.chain.faults.native = null;
  }

  const after = f.operation().state.protocol;
  assert.equal(after.stage, before.stage, JSON.stringify(after.attempts.at(-1)));
  assert.deepEqual(after.delivery, before.delivery, 'the verified delivery remains pinned');
  assert.deepEqual(after.paymentEvidence, before.paymentEvidence, 'the verified payment proof remains pinned');
  assert.deepEqual([after.attempts.at(-1).step, after.attempts.at(-1).outcome], ['chain-readback', 'indeterminate']);
  assert.match(after.attempts.at(-1).reason, /native Deliverable read: invalid: /);
  assert.equal(creates(h), effects, 'the readback sends no CREATE');
});
