import test from 'node:test';
import assert from 'node:assert/strict';
import * as dacs from '@kynesyslabs/dacs';
import { DEMOS_SR2_FIXTURE_RECEIPT } from '../src/dacs/demos-sr2-adapter.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { seller } from './helpers/protocol-fixture.mjs';

const read = f => f.adapter.read(f.logicalAddress, { expectedWriter: seller.claim });

test('fixture read marks its evidence with the simulated-fixture labels', async () => {
  const { demosEvidence } = await read(readbackFixture());
  assert.equal(demosEvidence.state, DEMOS_SR2_FIXTURE_RECEIPT.state);
  assert.equal(demosEvidence.finalityProfile, DEMOS_SR2_FIXTURE_RECEIPT.finalityProfile);
});

test('fixture read keeps every other evidence field for existing callers', async () => {
  const f = readbackFixture();
  const { demosEvidence, receipt } = await read(f);
  assert.equal(demosEvidence.blockNumber, 1);
  assert.equal(demosEvidence.transactionRef, f.signed.hash);
  assert.equal(demosEvidence.nativeAddress, f.native.storageAddress);
  assert.equal(receipt.transactionRef.value, demosEvidence.transactionRef);
});

test('the public converter refuses the evidence a fixture read returns', async () => {
  const f = readbackFixture();
  const { demosEvidence, receipt } = await read(f);
  assert.throws(() => dacs.demosWriteEvidenceToAnchorReceipt({
    logicalAddress: f.logicalAddress, contentHash: receipt.contentHash, writer: seller.claim, evidence: demosEvidence,
  }), error => error instanceof dacs.NonFinalDemosEvidenceError);
});

test('the fixture receipt is still labelled included and not finalized', async () => {
  const { receipt } = await read(readbackFixture());
  assert.equal(receipt.state, 'included');
  assert.equal(receipt.finalityProfile, 'simulated-fixture-inclusion-only');
});

test('recheck and verifyReceipt still accept a fixture receipt after a marked read', async () => {
  const f = readbackFixture();
  const { receipt } = await read(f);
  assert.deepEqual(await f.adapter.recheck(receipt, { expectedWriter: seller.claim }), { status: 'present', evidenceMode: 'simulated-fixture' });
  assert.equal(await f.adapter.verifyReceipt({ receipt, logicalAddress: f.logicalAddress, artifact: f.artifact,
    expectedWriter: seller.claim, artifactKind: f.native.metadata.artifactKind }), 'valid');
});

test('changing returned evidence does not change what the next read returns', async () => {
  const f = readbackFixture();
  const first = await read(f);
  first.demosEvidence.state = 'finalized';
  first.demosEvidence.finalityProfile = 'demos-bft-confirmed-native-read';
  const second = await read(f);
  assert.equal(second.demosEvidence.state, 'included');
  assert.equal(second.demosEvidence.finalityProfile, 'simulated-fixture-inclusion-only');
});
