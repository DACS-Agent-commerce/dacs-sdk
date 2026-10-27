// Integration of the source change onto main bcdb2cf: the legacy quarantine (the source change) through
// the purchase route, read by ops health (the source change). The provider's refusal says
// nothing was signed or sent, but a provider ran: the attempt carries no
// not-written mark, and ops health still sends the operator to the seller
// journal. The passive legacy check recognises a CREATE intent at either CVR
// key alone (the state an earlier server leaves when it stopped between the
// buyer's and the seller's Vet).
import test from 'node:test';
import assert from 'node:assert/strict';
import { compositeVerificationAddress } from '@kynesyslabs/dacs';
import { createDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createDevnetDemoAgreementContextProvider } from '../src/devnet-demo/agreement-context.mjs';
import { createInMemoryPartyVetStore } from '../src/devnet-demo/party-vet-store.mjs';
import { claimForAddress } from '../src/wallet/demos-signature.mjs';
import { opsHealth } from '../src/ops/health.mjs';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, tool, portal, tokenFrom } from './helpers/flows.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { installLoopbackOnlyGuard } from './helpers/embedded-wallet-flow-fixtures.mjs';

installLoopbackOnlyGuard();

const LEGACY_MESSAGE = 'this purchase was started by an earlier server version; nothing was signed or sent; start a new purchase';

test('legacy quarantine through the purchase route: its own error, no not-written mark, and ops health still reads it as a possible seller Vet write', async (t) => {
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  let provider = null;
  const demDeliveryContext = createDemDeliveryContext({ authority: 'TEST-merge-legacy',
    resolveBuyer: (input, options) => provider.resolveBuyer(input, options),
    resolveSeller: async () => { throw new Error('TEST unexpected seller resolver'); } });
  const h = await startProtocolHarness({ demDeliveryContext, browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  t.after(() => h.close());
  const seller = await addSeller(h, { listingId: 'merge-legacy' });
  // An anchor whose journal holds the earlier server's intents at exactly the keys `legacyAt` names.
  const calls = { publish: 0, read: 0, readRetained: 0, hasIntent: [], signatures: 0 };
  let legacyAt = () => true;
  const anchor = { writer: seller.wallet.claim,
    publish: async () => { calls.publish += 1; throw new Error('TEST unexpected publish'); },
    read: async () => { calls.read += 1; return { status: 'absent' }; },
    readRetained: async () => { calls.readRetained += 1; return { status: 'absent' }; },
    verifyReceipt: async () => 'invalid',
    hasIntent: async (address) => { calls.hasIntent.push(address); return legacyAt(address); } };
  const wallet = { claim: seller.wallet.claim, signBytes: (bytes) => { calls.signatures += 1; return seller.wallet.signBytes(bytes); } };
  provider = createDevnetDemoAgreementContextProvider({ anchor, wallet, listing: seller.listing, store: createInMemoryPartyVetStore(), log: () => {} });

  async function purchase(key) {
    const buyer = await linkedUser(h), account = h.app.services.accounts.walletOwner(buyer.wallet.address);
    const p = await tool(h, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, protocol: 'dacs-sr2-wallet-agreement', idempotencyKey: key });
    assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
    const token = tokenFrom(p.approvalUrl), path = `/portal/api/purchase/${p.operationId}/agreement/`;
    const identity = await portal(h, `${path}identity`, { token, address: buyer.wallet.address });
    const signature = buyer.wallet.signHex(identity.signRequest.message);
    const op = () => h.app.services.ops.get(account, p.operationId);
    const jobId = op().terms.protocol.jobId;
    return { id: p.operationId, op, plan: () => portal(h, `${path}plan`, { token, signature }),
      keys: { buyer: compositeVerificationAddress(jobId, claimForAddress(buyer.wallet.address)), seller: compositeVerificationAddress(jobId, seller.wallet.claim) } };
  }
  const refused = (out, w, label) => {
    assert.deepEqual([out.status, out.error, out.message], [409, 'legacy_party_vet_state_missing', LEGACY_MESSAGE], `${label}: ${JSON.stringify(out)}`);
    assert.equal(out.signRequest, undefined, label);
    const o = w.op(), last = o.state.protocol.attempts.at(-1);
    assert.deepEqual([o.status, o.state.protocol.stage, o.state.protocol.planned], ['agreement_pending', 'identity', undefined], label);
    assert.deepEqual([last.step, last.outcome], ['agreement-context', 'rejected'], label);
    assert.match(last.reason, /^legacy_party_vet_state_missing: /, label);
    // the source change: only a consumer that invoked no provider may mark an attempt not written.
    assert.equal(Object.hasOwn(last, 'written'), false, `${label}: no not-written mark`);
  };

  const both = await purchase('merge-legacy-both');
  refused(await both.plan(), both, 'both keys');
  refused(await both.plan(), both, 'both keys, retried');
  assert.deepEqual(calls.hasIntent.sort(), [both.keys.buyer, both.keys.seller].sort(), 'one passive check of the two CVR keys; the marker answers the retry');

  // Only one key holds an intent: still quarantined, whichever it is.
  const ids = [both.id];
  for (const role of ['buyer', 'seller']) {
    const w = await purchase(`merge-legacy-${role}`);
    legacyAt = (address) => address === w.keys[role];
    refused(await w.plan(), w, `${role} key only`);
    ids.push(w.id);
  }
  assert.deepEqual([calls.signatures, calls.publish, calls.read, calls.readRetained], [0, 0, 0, 0], 'nothing signed, sent or read back');

  // the source change ops health over the live database, as the CLI reads it without operator state.
  const report = opsHealth({ databasePath: h.config.databasePath, now: Date.now() });
  assert.equal(report.healthy, false);
  assert.deepEqual(report.stuck.map((s) => [s.purchaseId, s.stage, s.outcome]).sort(), ids.map((id) => [id, 'identity', 'seller-journal-not-read']).sort());
});
