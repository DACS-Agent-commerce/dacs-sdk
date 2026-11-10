import test from 'node:test';
import assert from 'node:assert/strict';
import {agentFixture} from './helpers/seller-agent-isolated-fixture.mjs';
import {JOBS} from './helpers/bilateral-vet-fixture.mjs';

const [FIRST_JOB, SECOND_JOB] = JOBS;
const TX_HASH = 'a'.repeat(64);

const malformedTxHashes = [
  ['empty', ''],
  ['prefix only', '0x'],
  ['non-hex digits', 'z'.repeat(64)],
  ['one digit short', 'a'.repeat(63)],
  ['one digit long', 'a'.repeat(65)],
  ['leading space', ` ${TX_HASH}`],
  ['trailing newline', `${TX_HASH}\n`],
  ['doubled prefix', `0x0x${TX_HASH}`],
];

const missingOrMalformedPayerKeys = (w) => [
  ['missing', undefined],
  ['null', null],
  ['empty', ''],
  ['number', 5],
  ['object', {}],
  ['array holding the buyer claim', [w.buyer.claim]],
  ['not a claim', 'not-a-key'],
  ['buyer claim cut short', w.buyer.claim.slice(0, -2)],
  ['seller claim', w.seller.claim],
];

// Nothing was anchored and no payment work was kept for the job.
function assertNothingRetained(w, jobId, writesBefore) {
  assert.equal(w.anchors.writes.length, writesBefore, 'no anchor write');
  const session = w.agent.durableSessionOf(jobId);
  assert.equal(session.paymentWork, undefined, 'no retained payment work');
  assert.equal(session.payment, undefined, 'no recorded payment');
  assert.equal(w.agent.stageOf(jobId), 'committed');
}

test('fixture settlement refuses a malformed transaction hash with no write and no retained work', async () => {
  const w = await agentFixture();
  try {
    await w.agent.commit({jobId: FIRST_JOB});
    const writesBefore = w.anchors.writes.length;
    for (const [label, txHash] of malformedTxHashes) {
      await assert.rejects(w.agent.submitPayment({jobId: FIRST_JOB, txHash, payerPayingKey: w.buyer.claim}), {code: 'payment_tx_hash_invalid', status: 422}, label);
      assertNothingRetained(w, FIRST_JOB, writesBefore);
    }
    const answer = await w.agent.submitPayment({jobId: FIRST_JOB, txHash: TX_HASH, payerPayingKey: w.buyer.claim});
    assert.equal(answer.status, 'delivered', 'the correct claim still delivers after the refusals');
  } finally {
    w.close();
  }
});

test('fixture settlement refuses a missing or malformed payer paying key with no write and no retained work', async () => {
  const w = await agentFixture();
  try {
    await w.agent.commit({jobId: FIRST_JOB});
    const writesBefore = w.anchors.writes.length;
    for (const [label, payerPayingKey] of missingOrMalformedPayerKeys(w)) {
      await assert.rejects(w.agent.submitPayment({jobId: FIRST_JOB, txHash: TX_HASH, payerPayingKey}), {code: 'payer_not_authenticated', status: 422}, label);
      assertNothingRetained(w, FIRST_JOB, writesBefore);
    }
    const answer = await w.agent.submitPayment({jobId: FIRST_JOB, txHash: TX_HASH, payerPayingKey: w.buyer.claim});
    assert.equal(answer.status, 'delivered', 'the correct claim still delivers after the refusals');
  } finally {
    w.close();
  }
});

test('fixture settlement refuses a transfer a second live job claims and keeps no work for it', async () => {
  const w = await agentFixture();
  try {
    for (const jobId of [FIRST_JOB, SECOND_JOB]) await w.agent.commit({jobId});
    const claim = (jobId) => ({jobId, txHash: TX_HASH, payerPayingKey: w.buyer.claim});
    assert.equal((await w.agent.submitPayment(claim(FIRST_JOB))).status, 'delivered');
    const writesBefore = w.anchors.writes.length;
    const refused = await w.agent.submitPayment(claim(SECOND_JOB));
    assert.equal(refused.status, 'rejected', 'the second job is refused');
    assertNothingRetained(w, SECOND_JOB, writesBefore);
    await assert.rejects(w.agent.submitPayment(claim(FIRST_JOB)), {code: 'settlement_collision'}, 'the contested transfer gives the first job no credit either');
    assert.equal(w.agent.stageOf(FIRST_JOB), 'settlement-indeterminate');
    assert.equal(w.anchors.writes.length, writesBefore, 'no further anchor write for either job');
  } finally {
    w.close();
  }
});
