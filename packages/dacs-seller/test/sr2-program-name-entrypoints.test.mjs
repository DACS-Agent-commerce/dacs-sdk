import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_SEPARATORS, canonicalize, paymentEvidenceAddress, sha256Hex, signComponentArtifact } from '@kynesyslabs/dacs';
import { DEMOS_SR2_FIXTURE_CHAIN_IDENTITY } from '../src/dacs/demos-sr2-adapter.mjs';
import { createNativePaymentEvidenceConsumer } from '../src/dacs/native-payment-evidence-consumer.mjs';
import { deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { NOW, protocolFixture, seller } from './helpers/protocol-fixture.mjs';

function alternateName(f) {
  const programName = 'other-implementation-deliverable';
  const address = deriveStorageAddress(seller.address, programName, 1);
  f.signed.content.to = address;
  Object.assign(f.signed.content.data[1], { programName, storageAddress: address });
  f.signed.hash = sha256Hex(JSON.stringify(f.signed.content));
  f.signed.signature.data = `0x${seller.signBytes(Buffer.from(f.signed.hash)).toString('hex')}`;
  Object.assign(f.tx, structuredClone(f.signed), { status: 'confirmed', blockNumber: 1 });
  Object.assign(f.native, { programName, storageAddress: address, createdByTx: f.signed.hash, interactionTxs: [f.signed.hash] });
  f.block.content.ordered_transactions = [f.signed.hash];
  f.state.rows = [];
  return address;
}

test('a journal-retained alternate-name address is refused without a supplied address or projection', async () => {
  const f = readbackFixture();
  const address = alternateName(f);
  await assert.rejects(f.adapter.read(f.logicalAddress, { expectedWriter: f.expectedWriter }),
    error => error.code === 'indeterminate' && /name-index visibility does not establish authenticated absence/.test(error.message));
  f.journal.put({ planId: 'TEST retained alternate-name address',
    scope: canonicalize(['http://127.0.0.1:9922', DEMOS_SR2_FIXTURE_CHAIN_IDENTITY]),
    logicalAddress: f.logicalAddress, writer: f.expectedWriter, nativeAddress: address });
  await assert.rejects(f.adapter.read(f.logicalAddress, { expectedWriter: f.expectedWriter }),
    error => error.code === 'invalid' && /only SDK-derived program names are supported/.test(error.message));
  assert.ok(f.state.calls.some(({ path }) => path === `/storage-program/${address}`));
});

test('payment evidence readEvidence stays indeterminate with an alternate-name signed projection', async () => {
  const { agreement, observed: payment } = await protocolFixture();
  const observed = { ...payment, txHash: payment.txHash.replace(/^0x/, '') };
  const artifact = await signComponentArtifact({ evidenceVersion: '1', jobId: agreement.jobId, phase: 'pay-dem', outcome: 'success', observedAt: NOW,
    paymentTxRefs: [{ kind: 'demos', ...observed }], paymentAmount: { amount: '2.5', currency: 'DEM' },
    settlementFinality: { model: 'bft-final', finalityObservedAt: NOW } }, ARTIFACT_SEPARATORS.SettlementEvidence,
    { algorithm: 'ed25519', signer: seller.claim, sign: seller.signBytes });
  const f = readbackFixture({ logicalAddress: paymentEvidenceAddress(agreement.jobId, 'demos-native:DEM', 2), artifact,
    metadata: { artifactKind: 'SettlementEvidence' } });
  alternateName(f);
  const consumer = createNativePaymentEvidenceConsumer({ rpcUrl: 'http://127.0.0.1:9922/', fetchImpl: f.fetchImpl, now: () => NOW });
  const input = { agreement, writer: seller.claim, ...observed, committedAt: NOW - 1000 };
  const plain = await consumer.readEvidence(input);
  assert.equal(plain.disposition, 'indeterminate');
  assert.match(plain.reason, /name-index visibility does not establish authenticated absence/);
  const projected = await consumer.readEvidence({ ...input, signedProjection: f.signed });
  assert.equal(projected.disposition, 'indeterminate');
  assert.equal(projected.code, 'invalid');
  assert.match(projected.reason, /only SDK-derived program names are supported/);
  assert.notEqual(projected.authenticated, true);
});
