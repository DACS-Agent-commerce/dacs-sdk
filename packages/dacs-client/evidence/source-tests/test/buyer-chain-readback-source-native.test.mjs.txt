// DACS_BUYER_CHAIN_READBACK=on never keeps a seller-journal reader silently.
// The source-native demo verifies its Deliverable through a generic native DEM
// delivery provider, which reads the seller's wallet journal, so with the
// switch on that configuration is refused when the app starts, before any
// purchase, seller or journal exists. A configuration whose native readers
// can all read the chain only (payment evidence from the signed bytes the
// buyer is given) still starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BuyerChainReadbackUnsupported } from '../src/dacs/buyer-chain-readback.mjs';
import { sourceDemoFlow } from './helpers/source-demo-flow.mjs';
import { startDevnetAgreementTransportHarness } from './helpers/devnet-agreement-transport-harness.mjs';

test('on: the source-native demo configuration is refused at startup instead of reading the seller journal', { timeout: 120000 }, async (t) => {
  await assert.rejects(sourceDemoFlow(t, { buyerChainReadback: 'on' }), (error) => {
    assert.ok(error instanceof BuyerChainReadbackUnsupported, String(error?.stack ?? error));
    assert.equal(error.code, 'buyer_chain_readback_unsupported');
    assert.match(error.message, /native DEM delivery capability/);
    return true;
  });
});

test('on: native payment evidence alone reads the chain only, so that configuration starts', { timeout: 120000 }, async (t) => {
  const h = await startDevnetAgreementTransportHarness({ settlementEnabled: true, buyerChainReadback: 'on' });
  t.after(() => h.close());
  assert.equal(h.config.buyerChainReadback, 'on');
  assert.equal(h.app.services.protocol.available, true);
});
