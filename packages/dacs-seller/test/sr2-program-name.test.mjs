import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@kynesyslabs/dacs';
import { deriveStorageAddress } from '../src/dacs/wallet-transactions.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { seller } from './helpers/protocol-fixture.mjs';

test('a correctly signed alternate program name reports the supported naming restriction', async () => {
  const f = readbackFixture();
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
  await assert.rejects(f.adapter.read(f.logicalAddress, {
    expectedWriter: f.expectedWriter, nativeAddress: address, signedProjection: f.signed,
  }), error => error.code === 'invalid' && /only SDK-derived program names are supported/.test(error.message));
});

test('the SDK-derived program name still reads with an exact address and signed projection', async () => {
  const f = readbackFixture();
  const result = await f.adapter.read(f.logicalAddress, {
    expectedWriter: f.expectedWriter, nativeAddress: f.native.storageAddress, signedProjection: f.signed,
  });
  assert.equal(result.status, 'present');
});
