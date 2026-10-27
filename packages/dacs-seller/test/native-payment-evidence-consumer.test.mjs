import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_SEPARATORS, paymentEvidenceAddress, signComponentArtifact } from '@kynesyslabs/dacs';
import { createNativePaymentEvidenceConsumer, nativeEvidenceReadOutcome } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { DEMOS_SR2_REPLY_BYTES } from '../src/dacs/demos-sr2-adapter.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { buyer, seller, protocolFixture, NOW } from './helpers/protocol-fixture.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' } });

async function consumerFixture({ evidence = {}, transfer = {}, respond } = {}) {
  const { agreement, observed: payment } = await protocolFixture();
  const observed = { ...payment, txHash: payment.txHash.replace(/^0x/, '') };
  const artifact = await signComponentArtifact({ evidenceVersion: '1', jobId: agreement.jobId, phase: 'pay-dem', outcome: 'success', observedAt: NOW,
    paymentTxRefs: [{ kind: 'demos', ...observed }], paymentAmount: { amount: '2.5', currency: 'DEM' },
    settlementFinality: { model: 'bft-final', finalityObservedAt: NOW }, ...evidence }, ARTIFACT_SEPARATORS.SettlementEvidence,
  { algorithm: 'ed25519', signer: seller.claim, sign: seller.signBytes });
  const f = readbackFixture({ logicalAddress: paymentEvidenceAddress(agreement.jobId, 'demos-native:DEM', 2), artifact,
    metadata: { artifactKind: 'SettlementEvidence' }, respond: async (url, init, state) => {
      const changed = await respond?.(url, init, state); if (changed !== undefined) return changed;
      if (new URL(url).pathname !== '/') return;
      const { message, data } = JSON.parse(init.body).params[0];
      if (message === 'getTransactionStatus') return json({ result: 200, response: { state: 'included', blockNumber: observed.blockNumber } });
      if (message === 'getTxByHash' && data.hash.replace(/^0x/, '') === observed.txHash.replace(/^0x/, '')) return json({ result: 200, response: {
        hash: observed.txHash, status: 'confirmed', blockNumber: observed.blockNumber,
        content: { type: 'native', from: buyer.address, to: seller.address, amount: '2500000000',
          data: ['native', { nativeOperation: 'send', args: [seller.address, '2500000000'] }], ...transfer } } });
      if (message === 'getBlockByNumber' && data.blockNumber === observed.blockNumber) return json({ result: 200, response: {
        number: observed.blockNumber, status: 'confirmed', content: { timestamp: NOW / 1000, ordered_transactions: [observed.txHash] } } });
    } });
  const consumer = createNativePaymentEvidenceConsumer({ rpcUrl: 'http://127.0.0.1:9922/', fetchImpl: f.fetchImpl, now: () => NOW });
  const input = { agreement, writer: seller.claim, ...observed, committedAt: NOW - 1000, signedProjection: f.signed, answerProjectionOnly: true };
  return { ...f, consumer, input };
}

for (const status of ['invalid', 'rejected', 'unavailable', 'unknown']) test(`an unauthenticated ${status} read outcome stays indeterminate`, () => {
  assert.deepEqual(nativeEvidenceReadOutcome({ status, code: 'TEST', reason: 'TEST observation' }),
    { disposition: 'indeterminate', nativeReadStatus: status, reason: 'TEST observation', code: 'TEST' });
});

test('the read outcome classifier preserves present and explicit absent outcomes', () => {
  assert.equal(nativeEvidenceReadOutcome({ status: 'present' }), null);
  assert.equal(nativeEvidenceReadOutcome({ status: 'absent' }).disposition, 'absent');
});

for (const projectionOnly of [false, true]) test(`a malformed native candidate stays indeterminate with projection-only=${projectionOnly}`, async () => {
  const f = await consumerFixture(); f.native.programName = 'TEST-wrong-program';
  const result = await f.consumer.readEvidence({ ...f.input, answerProjectionOnly: projectionOnly });
  assert.equal(result.disposition, 'indeterminate'); assert.equal(result.code, 'invalid');
  assert.notEqual(result.authenticated, true);
});

test('a contradiction in a second native read cannot turn fresh receipt failure into party fault', async () => {
  let reads = 0;
  const f = await consumerFixture({ respond: (url, init, state) => {
    if (new URL(url).pathname.startsWith('/storage-program/') && ++reads === 2) {
      return json({ ...state.native, metadata: { ...state.native.metadata, envelopeHash: 'b'.repeat(64) } });
    }
  } });
  const result = await f.consumer.readEvidence(f.input);
  assert.equal(reads, 2); assert.equal(result.disposition, 'indeterminate');
  assert.equal(result.nativeReadStatus, 'receipt-invalid'); assert.notEqual(result.authenticated, true);
});

for (const [label, transfer] of [['payer', { from: seller.address }], ['payee', { to: buyer.address, data: ['native', { nativeOperation: 'send', args: [buyer.address, '2500000000'] }] }],
  ['amount', { amount: '1', data: ['native', { nativeOperation: 'send', args: [seller.address, '1'] }] }]]) {
  test(`an unauthenticated payment ${label} mismatch stays indeterminate`, async () => {
    const f = await consumerFixture({ transfer });
    assert.equal((await f.consumer.observeDemosTransfer(f.input.txHash)).status, 'included', 'the raw node tuple reaches the consumer comparison');
    const result = await f.consumer.readEvidence(f.input);
    assert.equal(result.disposition, 'indeterminate'); assert.notEqual(result.authenticated, true);
    assert.equal(result.reason, 'native-evidence-observed-tuple-time-or-commitment-mismatch');
  });
}

test('an authenticated signed artifact with the wrong payment amount remains rejected', async () => {
  const f = await consumerFixture({ evidence: { paymentAmount: { amount: '3', currency: 'DEM' } } });
  const result = await f.consumer.readEvidence(f.input);
  assert.equal(result.disposition, 'rejected'); assert.equal(result.authenticated, true);
  assert.equal(result.reason, 'native-payment-evidence-scope-mismatch');
});

test('a projection-only read without a signed projection stays indeterminate before any read', async () => {
  const f = await consumerFixture();
  const result = await f.consumer.readEvidence({ ...f.input, signedProjection: undefined });
  assert.equal(result.disposition, 'indeterminate'); assert.equal(result.nativeReadStatus, 'public-projection-missing');
  assert.equal(f.calls.length, 0);
});

for (const [label, projection] of [
  ['oversized', f => ({ ...f.signed, padding: 'x'.repeat(DEMOS_SR2_REPLY_BYTES) })],
  ['a string', () => 'TEST projection'], ['an array', f => [f.signed]], ['a class instance', f => Object.assign(new Map(), f.signed)],
  ['unserializable', f => ({ ...f.signed, amount: 1n })],
]) test(`a signed projection is refused before the adapter reads when it is ${label}`, async () => {
  const f = await consumerFixture();
  const result = await f.consumer.readEvidence({ ...f.input, signedProjection: projection(f) });
  assert.equal(result.disposition, 'indeterminate'); assert.equal(result.nativeReadStatus, 'public-projection-malformed');
  assert.equal(f.calls.length, 0);
});

test('matching signed evidence and observed transfer remain present', async () => {
  const f = await consumerFixture();
  const result = await f.consumer.readEvidence(f.input);
  assert.equal(result.disposition, 'present', JSON.stringify(result));
  assert.deepEqual(result.artifact, f.artifact); assert.deepEqual(result.signedProjection, f.signed);
});
