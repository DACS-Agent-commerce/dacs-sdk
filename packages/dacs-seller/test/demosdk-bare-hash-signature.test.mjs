// The wallet journal tests re-sign a transaction hash with the test wallet. demosdk 4.0.18 signs a bare
// transaction hash as a message only with raw: true; the signature must be the one demosdk 4.0.16 made.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SDK_WALLET_ADDRESS, signMessageAsTestWallet } from './helpers/payment-evidence-wallet-sdk.mjs';

const FIXED_TRANSACTION_HASH = '00ee3f83c769bd68893dd977282c14fe93c58dfe314fd96a5b703b286877ccf2';
// Recorded by signing FIXED_TRANSACTION_HASH with demosdk 4.0.16 and the test wallet (seed bytes all 7).
const WALLET_ADDRESS_FROM_4_0_16 = '0xbee908f7adbdf71e83dddf6c7a9e9907fdf3308eba69c534470b17b89d41bf0e';
const SIGNATURE_FROM_4_0_16 = '0xb26991b733e97115717ac22061e8c895042101e384366edf6e9b49a5a45e6a645fe93efc935523db975652f86f1c7e27823a483eb8c23aa095247bcb5606f60e';

test('the test wallet signs a bare transaction hash to the exact signature demosdk 4.0.16 made', async () => {
  assert.equal(SDK_WALLET_ADDRESS, WALLET_ADDRESS_FROM_4_0_16);
  assert.deepEqual(await signMessageAsTestWallet(FIXED_TRANSACTION_HASH), { type: 'ed25519', data: SIGNATURE_FROM_4_0_16 });
});
