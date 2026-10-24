import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as wallet from '../src/public/portal/embedded-wallet/sdk-provider.mjs';
test('package wallet helpers preserve the provider digest and confirmation contract', async () => {
  const helpers = await import('../src/wallet/payload-helpers.mjs');
  const content = { type: 'native', from: 'A'.repeat(64), to: '0x' + 'b'.repeat(64), amount: 1,
    data: ['native', { args: [] }], nonce: 7, timestamp: 1 };
  const signed = { ...content, from: '0x' + 'a'.repeat(64), transaction_fee: {}, gcr_edits: [], from_ed25519_address: 'TEST' };
  const digest = '69d081b66d283d0725b719066932eda8a47a3e0d0eedbec4dd8ab659e0fd6e33';
  assert.equal(await wallet.nativePayloadDigest(content), digest);
  assert.equal(await helpers.nativePayloadDigest(signed), digest);
  assert.equal(await helpers.nativePayloadDigest(content), digest);
  assert.notEqual(await helpers.nativePayloadDigest({ ...content, nonce: 8 }), digest);
  const transaction = { content: {}, signature: {}, hash: 'TEST', status: 'confirmed', blockNumber: 1 };
  const fees = { network_fee: 1, rpc_fee: 1, additional_fee: 0 };
  for (const [confirmation, expected] of [
    [null, false], [{}, false], [{ transaction: {} }, false],
    [{ transaction }, true], [{ transaction, custom_charges: [] }, false],
    [{ transaction: { ...transaction, extra: true } }, false],
    [{ transaction, gas_operation: { fees } }, true],
    [{ transaction, gas_operation: { fees: { network_fee: 1 } } }, false],
    [{ transaction, gas_operation: { fees, extra: true } }, false],
    [{ transaction, payload: {} }, false],
  ]) assert.equal(helpers.storageConfirmationShapeMatches(confirmation), expected);

});

test('post-fork prepared digest agrees with demosdk 4.0.16 serialized signing content', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('@kynesyslabs/demosdk')), 'utf8'));
  assert.equal(manifest.version, '4.0.16');
  const { serializeTransactionContent } = await import(new URL('denomination/serializerGate.js', import.meta.resolve('@kynesyslabs/demosdk')));
  const content = { type: 'native', from: '0x' + 'a'.repeat(64), to: '0x' + 'b'.repeat(64), amount: '1000000000',
    data: ['native', { nativeOperation: 'send', args: ['0x' + 'b'.repeat(64), '1000000000'] }], nonce: 7, timestamp: 1 };
  const signed = JSON.parse(serializeTransactionContent({ ...content,
    transaction_fee: { network_fee: 1, rpc_fee: 1, additional_fee: 0 }, gcr_edits: [] }, true));
  assert.equal(signed.amount, '1000000000');
  assert.equal(signed.transaction_fee.network_fee, '1000000000');
  assert.equal(await wallet.nativePayloadDigest(signed), await wallet.nativePayloadDigest(content));
  assert.notEqual(await wallet.nativePayloadDigest({ ...content, amount: 1 }), await wallet.nativePayloadDigest(signed));
});
