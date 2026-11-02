import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_SIGNED_NONCE, confirmedNativeTransferNode, observeConfirmedNativeTransfer } from './helpers/confirmed-native-transfer-fixture.mjs';
import { buyer, seller, NOW } from './helpers/protocol-fixture.mjs';

const transfer = { txHash: 'ab'.repeat(32), payer: buyer.address, payee: seller.address, amountOs: '2500000000', blockNumber: 8, includedAt: NOW + 3000 };

test('the confirmed transfer fixture serves a transaction with a valid signed nonce', async () => {
  const { response: transaction } = await confirmedNativeTransferNode(transfer).getTxByHash(transfer.txHash);
  assert.equal(transaction.status, 'confirmed');
  assert.equal(transaction.content.nonce, FIXTURE_SIGNED_NONCE);
  assert.ok(Number.isSafeInteger(transaction.content.nonce) && transaction.content.nonce >= 0);
});

test('the confirmed transfer fixture is read back as an included transfer with the requested facts', async () => {
  const observation = await observeConfirmedNativeTransfer(transfer);
  assert.equal(observation.status, 'included', JSON.stringify(observation));
  assert.equal(observation.txHash, transfer.txHash);
  assert.equal(observation.amountOs, transfer.amountOs);
  assert.equal(observation.blockNumber, transfer.blockNumber);
  assert.equal(observation.includedAt, transfer.includedAt);
});

test('a nonce chosen for the fixture is the nonce the confirmed transaction carries', async () => {
  const { response: transaction } = await confirmedNativeTransferNode({ ...transfer, nonce: 7 }).getTxByHash(transfer.txHash);
  assert.equal(transaction.content.nonce, 7);
});
