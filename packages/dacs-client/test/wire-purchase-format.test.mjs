import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TP1_CAPABILITIES } from '@kynesyslabs/dacs/wire';
import { world, purchase, code, T0 } from './helpers/wire-client-fixture.mjs';
const old = {
  profile: 'dacs-source-demo/signed-peer/v1', authority: 'TEST-wire', request: 'buyer-delegated-session-ed25519-complete-body', delegation: 'seller-session-delegation/v1', response: 'seller-ed25519-request-bound', durability: 'seller-intent-journal'
};
test("a purchase prepared under the old seller transport declaration is refused seller_transport_changed before any signature and is never re-signed, also after a restart", async (t) => {
  const w = await world(t), p = await purchase(t, w, { declaration: old, protocolPatch: { planned: { draft: {}, plan: {} } } });
  for (const restart of [false, true]) {
    if (restart)
      p.reopen();
    await assert.rejects(p.service.identityRequest(p.get(), w.buyer.address), code('seller_transport_changed'));
    for (const method of ['signRequest','planRequest','submitAgreement']) await assert.rejects(p.service[method](p.get()),code('seller_transport_changed'));
    assert.equal(p.get().state.protocol.sessionDelegation, undefined);
  }
  assert.equal(p.policies(), 0);
  assert.equal(w.state.signs.length, 0);
});
test("labels outside D6 are unchanged", async () => {
  const labels = {
    'dacs/agreement-context-consumer.mjs': { AGREEMENT_CONTEXT_SOURCE: 'dacs-chatgpt-plugin/operator-agreement-context/v1' },
    'dacs/buyer-chain-readback.mjs': { BUYER_CHAIN_READBACK_SOURCE: 'dacs-chatgpt-plugin/buyer-chain-readback/v1' },
    'dacs/dem-delivery-context-consumer.mjs': { DEM_DELIVERY_CONTEXT_SOURCE: 'dacs-chatgpt-plugin/dem-delivery-context/v1' },
    'dacs/native-dem-delivery-consumer.mjs': { NATIVE_DEM_DELIVERY_SOURCE: 'dacs-chatgpt-plugin/native-dem-delivery/v1' },
    'dacs/protocol-purchases.mjs': { OFFLINE_AGREEMENT_PROFILE: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1' },
    'dacs/purchase-protocol.mjs': { PROTOCOL_PROFILE: 'dacs-chatgpt-plugin/fixed-price-pay-dem/v1', VET_NOT_PERFORMED: 'dacs-chatgpt-plugin/vet-not-performed/v1' },
    'purchases.mjs': { PURCHASE_PROFILE: 'dacs-chatgpt-plugin/fixed-price-dem-purchase/v1', COMMITMENT_DOMAIN: 'dacs-chatgpt-plugin/fixed-price-dem-purchase-commitment/v1' },
    'devnet-demo/commitment-consumer.mjs': { DEVNET_NATIVE_COMMITMENT_MARKER: 'dacs-chatgpt-plugin/devnet-native-seller-commitment/v1' },
    'devnet-demo/deliverable.mjs': { DEVNET_PURCHASED_REPORT_KIND: 'dacs-chatgpt-plugin/devnet-purchased-report' },
  };
  for (const [file, names] of Object.entries(labels)) {
    const module = await import('../src/' + file);
    for (const [name, value] of Object.entries(names))
      assert.equal(module[name], value, name);
  }
  assert.ok(readFileSync(new URL('../src/dacs/listing.mjs', import.meta.url), 'utf8').includes('`dacs-chatgpt-plugin:${sessionSeed}:${claim}:${presentedAt}`'));
  assert.equal(TP1_CAPABILITIES.output.envelope, 'dacs-chatgpt-plugin/devnet-purchased-report');
});
test('an old-declaration row with a verified on-chain payment stays held with seller_transport_changed after restart, no status moves, nothing signed', async (t) => {
  const w = await world(t), p = await purchase(t, w, { declaration: old, paid: true, status: 'settled_verified', protocolPatch: { stage: 'payment-observed', transfer: { txHash: 'a'.repeat(64), blockNumber: 10 } } });
  const coords = {
    verifiedAt: new Date(T0).toISOString(), reportedTxHash: 'a'.repeat(64), observation: { observation: { blockNumber: 10, includedAt: T0, payer: w.buyer.address, payee: w.seller.address, amountOs: '2500000000' } }
  };
  for (const restart of [false, true]) {
    if (restart)
      p.reopen();
    const result = await p.service.recheck(p.get(), coords);
    assert.equal(result.status, 'settled_verified');
    assert.equal(p.get().state.protocol.stage, 'payment-observed');
    assert.equal(p.ops.history(p.op.id).at(-1).data.code, 'seller_transport_changed');
    await assert.rejects(p.service.identityRequest(p.get(), w.buyer.address), code('seller_transport_changed'));
    assert.equal(await p.service.readIssued(p.get()), null);
  }
  assert.equal(p.journalReads(), 2);
  assert.equal(p.policies(), 0);
  assert.equal(w.state.signs.length, 0);
});
