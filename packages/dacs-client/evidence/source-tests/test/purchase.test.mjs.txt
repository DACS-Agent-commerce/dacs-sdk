// Buyer purchase workflow over the real MCP transport + portal API, against
// SIMULATED fixture chain/directory. Expectations are computed independently
// from the fixture listing, not from the plugin's own outputs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentHash } from '@kynesyslabs/dacs';
import { loadConfig, PINNED_CHAIN_IDENTITIES } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { createLogger } from '../src/util/log.mjs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { OutboundError } from '../src/util/http.mjs';
import { startHarness, CALLBACK_ORIGIN } from './helpers/harness.mjs';
import { linkedUser, tool, toolRaw, portal, seedSellerListing, approvePurchase, reportPurchase, tokenFrom } from './helpers/flows.mjs';
import { startDirectoryFixture } from './fixtures/directory-server.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { openDatabase } from '../src/store/database.mjs';
import { createOperationStore } from '../src/operations.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { createAgentService } from '../src/agents.mjs';

let h;
let seller;
let primaryBuyer;
let otherBuyer;
let listing;
let keyCounter = 0;
const key = (label) => `test-${label}-${++keyCounter}-${Date.now()}`;

before(async () => {
  h = await startHarness({ env: { DACS_RATE_LIMIT_PER_MINUTE: '10000', DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT: '1000', DACS_MAX_UNPAID_PURCHASES_PER_WALLET: '1000', DACS_MAX_PURCHASE_STARTS_PER_ACCOUNT_PER_HOUR: '100000' } });
  seller = createEphemeralWallet();
  ({ listing } = seedSellerListing(h, seller, { listingId: 'market-report', price: '2.5' }));
  primaryBuyer = await linkedUser(h);
  otherBuyer = await linkedUser(h);
});
after(async () => h.close());

const coords = (listingId = 'market-report', version = 1, s = seller) => ({ listingId, version, seller: s.claim });

test('prepare_purchase binds exact terms but neither approves nor pays', async () => {
  const p = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('exact') });
  assert.equal(p.status, 'awaiting_approval');
  assert.equal(p.created, true);
  assert.equal(p.terms.payee, seller.address);
  assert.equal(p.terms.seller, seller.claim);
  assert.equal(p.terms.amount, '2.5 DEM');
  assert.equal(p.terms.amountOs, '2500000000');
  assert.equal(p.terms.listingContentHash, contentHash(listing));
  assert.equal(p.terms.buyerWallet, primaryBuyer.wallet.address);
  assert.equal(p.terms.network, 'demos-testnet');
  assert.match(p.approvalUrl, /\/portal\/purchase\/pur_[\w-]+#t=/);
  assert.equal(h.chain.nonceOf(primaryBuyer.wallet.address), 0, 'nothing was broadcast');
  const status = await tool(h, primaryBuyer, 'get_purchase_status', { operationId: p.operationId });
  assert.equal(status.approval, null);
  assert.equal(status.settlement, null);
});

test('happy path: wallet-approved exact terms, wallet broadcast, independent verification', async () => {
  const p = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('happy') });
  const { challenge, approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, primaryBuyer.wallet);
  // The wallet sees every binding field in the human-readable message.
  for (const fragment of ['purpose: approve-purchase', `payee: ${seller.address}`, 'amount: 2.5 DEM', 'amount-os: 2500000000', `listing-hash: ${contentHash(listing)}`, `operation: ${p.operationId}`, `terms-hash: ${p.termsHash}`, 'network: demos-testnet']) {
    assert.ok(challenge.message.includes(fragment), `challenge shows ${fragment}`);
  }
  assert.equal(approved.status, 'payment_handoff');
  const tx = approved.payload;
  assert.equal(tx.content.type, 'native');
  assert.equal(tx.content.from, primaryBuyer.wallet.address);
  assert.equal(tx.content.to, seller.address);
  assert.deepEqual(tx.content.data, ['native', { nativeOperation: 'send', args: [seller.address, '2500000000'] }]);
  assert.equal(tx.content.nonce, 1);
  const saved = h.app.services.coordinates.get(p.operationId);
  assert.equal(saved.expectedNonce, 1, 'coordinates saved before handoff');
  assert.equal(saved.nonceFence, 0);

  const hash = h.chain.walletBroadcast(tx); // SIMULATED wallet sign + broadcast
  const reported = await reportPurchase(h, p.operationId, token, { txHash: hash });
  assert.equal(reported.status, 'settled_verified', JSON.stringify(reported.verification));
  assert.equal(reported.verification.outcome, 'verified');
  assert.equal(reported.verification.chainMode, 'simulated-fixture');

  const status = await tool(h, primaryBuyer, 'get_purchase_status', { operationId: p.operationId });
  assert.equal(status.status, 'settled_verified');
  assert.equal(status.approval.signer, primaryBuyer.wallet.address);
  assert.equal(status.reportedTxHash, hash);
  assert.equal(status.settlement.observation.amountOs, '2500000000');
  assert.equal(status.approvalUrl, null);
  assert.ok(status.history.some((e) => e.type === 'approved') && status.history.some((e) => e.type === 'settled_verified'));
  const again = await tool(h, primaryBuyer, 'verify_deal', { operationId: p.operationId });
  assert.equal(again.status, 'settled_verified');
});

test('idempotency: same key and request returns the same operation; a different request conflicts', async () => {
  const k = key('idem');
  const a = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: k });
  const b = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: k });
  assert.equal(a.operationId, b.operationId);
  assert.equal(b.created, false);
  assert.equal(a.approvalUrl, b.approvalUrl, 'portal link is stable across replays');
  seedSellerListing(h, seller, { listingId: 'other-report', price: '1' });
  const c = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords('other-report'), idempotencyKey: k });
  assert.equal(c.error, 'idempotency_conflict');
  // Same key under another account is independent.
  const d = await tool(h, otherBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: k });
  assert.notEqual(d.operationId, a.operationId);
});

test('two accounts are isolated: no cross-account reads, verification or approval', async () => {
  const p = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('iso') });
  assert.equal((await tool(h, otherBuyer, 'get_purchase_status', { operationId: p.operationId })).error, 'not_found');
  assert.equal((await tool(h, otherBuyer, 'verify_deal', { operationId: p.operationId })).error, 'not_found');
  const otherBuyerStatus = await tool(h, otherBuyer, 'get_account_status');
  assert.ok(!otherBuyerStatus.purchases.some((x) => x.operationId === p.operationId));
  // otherBuyer's wallet cannot approve primaryBuyer's purchase even with her portal link.
  const token = tokenFrom(p.approvalUrl);
  const wrong = await portal(h, `/portal/api/purchase/${p.operationId}/challenge`, { token, address: otherBuyer.wallet.address });
  assert.equal(wrong.error, 'wrong_wallet');
  // A guessed/forged portal token is rejected.
  const forged = await portal(h, `/portal/api/purchase/${p.operationId}/view`, { token: 'A'.repeat(43) });
  assert.equal(forged.status, 404);
});

test('approval requires the bound wallet signature; replay and cross-operation reuse fail', async () => {
  const p1 = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('sig1') });
  const p2 = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords('other-report'), idempotencyKey: key('sig2') });
  const t1 = tokenFrom(p1.approvalUrl);
  const t2 = tokenFrom(p2.approvalUrl);
  const c1 = await portal(h, `/portal/api/purchase/${p1.operationId}/challenge`, { token: t1, address: primaryBuyer.wallet.address });
  const intruder = createEphemeralWallet();
  const bad = await portal(h, `/portal/api/purchase/${p1.operationId}/approve`, { token: t1, challengeId: c1.challengeId, signature: intruder.signHex(c1.message) });
  assert.equal(bad.error, 'bad_signature');
  // Using p1's challenge to approve p2 fails on binding.
  const cross = await portal(h, `/portal/api/purchase/${p2.operationId}/approve`, { token: t2, challengeId: c1.challengeId, signature: primaryBuyer.wallet.signHex(c1.message) });
  assert.equal(cross.error, 'binding_mismatch');
  const ok = await portal(h, `/portal/api/purchase/${p1.operationId}/approve`, { token: t1, challengeId: c1.challengeId, signature: primaryBuyer.wallet.signHex(c1.message) });
  assert.equal(ok.status, 'payment_handoff');
  const replay = await portal(h, `/portal/api/purchase/${p1.operationId}/approve`, { token: t1, challengeId: c1.challengeId, signature: primaryBuyer.wallet.signHex(c1.message) });
  assert.equal(replay.error, 'invalid_state');
  // Settle p1 so the wallet has no unresolved payment for later tests.
  const hash = h.chain.walletBroadcast(ok.payload);
  assert.equal((await reportPurchase(h, p1.operationId, t1, { txHash: hash })).status, 'settled_verified');
});

test('wallet error then restart: durable state resumes with the same nonce-fenced payload', async () => {
  const p = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('restart') });
  const { approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, primaryBuyer.wallet);
  const firstPayload = approved.payload;
  const err = await reportPurchase(h, p.operationId, token, { walletError: 'User rejected the request' });
  assert.equal(err.status, 'payment_handoff', 'a wallet error does not create a new transaction or retry');
  await h.restart();
  const status = await tool(h, primaryBuyer, 'get_purchase_status', { operationId: p.operationId });
  assert.equal(status.status, 'payment_handoff');
  assert.ok(status.history.some((e) => e.type === 'wallet_error'));
  const again = await portal(h, `/portal/api/purchase/${p.operationId}/handoff`, { token });
  assert.deepEqual(again.payload, firstPayload, 'same exact payload (same expected nonce) after restart');
  const hash = h.chain.walletBroadcast(again.payload);
  assert.throws(() => h.chain.walletBroadcast(firstPayload), /rejected nonce/, 'the nonce fence prevents a second inclusion');
  assert.equal((await reportPurchase(h, p.operationId, token, { txHash: hash })).status, 'settled_verified');
});

test('unknown outcome blocks retry until independently resolved', async () => {
  const p = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('uncertain') });
  const { approved } = await approvePurchase(h, p.operationId, p.approvalUrl, primaryBuyer.wallet);
  const hash = h.chain.walletBroadcast(approved.payload); // wallet sent it, but the report never arrived
  const check = await tool(h, primaryBuyer, 'verify_deal', { operationId: p.operationId });
  assert.equal(check.status, 'payment_uncertain');
  assert.equal(check.verification.outcome, 'hash_required');
  const blocked = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords('other-report'), idempotencyKey: key('blocked') });
  assert.equal(blocked.error, 'unresolved_payment');
  assert.equal(blocked.details.operationId, p.operationId);
  const resolved = await tool(h, primaryBuyer, 'verify_deal', { operationId: p.operationId, txHash: hash });
  assert.equal(resolved.status, 'settled_verified');
});

test('a reported transaction that does not match the approved terms is never accepted', async () => {
  const p = await tool(h, primaryBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('mismatch') });
  const { approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, primaryBuyer.wallet);
  const tampered = structuredClone(approved.payload);
  tampered.content.amount = '1';
  tampered.content.data[1].args[1] = '1'; // wallet sent 1 OS instead of the approved amount
  const hash = h.chain.walletBroadcast(tampered);
  const reported = await reportPurchase(h, p.operationId, token, { txHash: hash });
  assert.equal(reported.status, 'payment_mismatch');
  assert.ok(reported.verification.mismatches.includes('amount differs from the approved price'));
  // A different hash cannot then be swapped in for this purchase.
  const swap = await tool(h, primaryBuyer, 'verify_deal', { operationId: p.operationId, txHash: 'ab'.repeat(32) });
  assert.ok(['hash_conflict', 'invalid_state'].includes(swap.error));
});

test('model-supplied hashes are pointers only: an unrelated hash is not settlement', async () => {
  const p = await tool(h, otherBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('pointer') });
  const { approved } = await approvePurchase(h, p.operationId, p.approvalUrl, otherBuyer.wallet);
  assert.equal(approved.status, 'payment_handoff');
  // A real transaction by someone else (primaryBuyer -> seller, same amount) is not otherBuyer's payment.
  const before = h.chain.nonceOf(primaryBuyer.wallet.address);
  const foreign = h.chain.walletBroadcast({ content: { type: 'native', from: primaryBuyer.wallet.address, to: seller.address, amount: '2500000000', data: ['native', { nativeOperation: 'send', args: [seller.address, '2500000000'] }], nonce: before + 1, timestamp: Date.now() } });
  const result = await tool(h, otherBuyer, 'verify_deal', { operationId: p.operationId, txHash: foreign });
  assert.equal(result.verification.outcome, 'pointer_rejected');
  assert.equal(result.status, 'payment_uncertain', 'an unrelated transaction never finalizes the purchase');
  assert.ok(result.verification.mismatches.includes('payer is not the approved buyer wallet'));
  // otherBuyer's real payment can still be verified afterwards.
  const real = h.chain.walletBroadcast(approved.payload);
  assert.equal((await tool(h, otherBuyer, 'verify_deal', { operationId: p.operationId, txHash: real })).status, 'settled_verified');
});

test('one unresolved wallet handoff blocks approving another purchase from the same wallet', async () => {
  const ivy = await linkedUser(h);
  const a = await tool(h, ivy, 'prepare_purchase', { ...coords(), idempotencyKey: key('dbl-a') });
  const b = await tool(h, ivy, 'prepare_purchase', { ...coords('other-report'), idempotencyKey: key('dbl-b') });
  const { approved } = await approvePurchase(h, a.operationId, a.approvalUrl, ivy.wallet);
  assert.equal(approved.status, 'payment_handoff');
  const tb = tokenFrom(b.approvalUrl);
  const blocked = await portal(h, `/portal/api/purchase/${b.operationId}/challenge`, { token: tb, address: ivy.wallet.address });
  assert.equal(blocked.error, 'unresolved_payment');
  assert.equal(blocked.details.operationId, a.operationId);
  // A's wallet result is lost and A becomes uncertain: B stays blocked.
  const hash = h.chain.walletBroadcast(approved.payload);
  assert.equal((await tool(h, ivy, 'verify_deal', { operationId: a.operationId })).status, 'payment_uncertain');
  assert.equal((await portal(h, `/portal/api/purchase/${b.operationId}/challenge`, { token: tb, address: ivy.wallet.address })).error, 'unresolved_payment');
  // Resolving A unblocks B.
  assert.equal((await tool(h, ivy, 'verify_deal', { operationId: a.operationId, txHash: hash })).status, 'settled_verified');
  const { approved: bApproved } = await approvePurchase(h, b.operationId, b.approvalUrl, ivy.wallet);
  assert.equal(bApproved.status, 'payment_handoff');
  assert.equal(bApproved.payload.content.nonce, 2, 'B uses the next nonce only after A resolved');
});

test('idempotent replay of an unresolved purchase returns that purchase', async () => {
  const jo = await linkedUser(h);
  const k = key('replay-unresolved');
  const a = await tool(h, jo, 'prepare_purchase', { ...coords(), idempotencyKey: k });
  const { approved } = await approvePurchase(h, a.operationId, a.approvalUrl, jo.wallet);
  h.chain.walletBroadcast(approved.payload);
  assert.equal((await tool(h, jo, 'verify_deal', { operationId: a.operationId })).status, 'payment_uncertain');
  const again = await tool(h, jo, 'prepare_purchase', { ...coords(), idempotencyKey: k });
  assert.equal(again.operationId, a.operationId);
  assert.equal(again.created, false);
  assert.equal(again.status, 'payment_uncertain');
});

test('a transient transaction-body read failure is unavailability, not a mismatch', async () => {
  const kai = await linkedUser(h);
  const p = await tool(h, kai, 'prepare_purchase', { ...coords(), idempotencyKey: key('transient') });
  const { approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, kai.wallet);
  const hash = h.chain.walletBroadcast(approved.payload);
  h.chain.faults.failTxBodyAfter.set(hash, 1); // observer read succeeds, follow-up read fails
  const r = await reportPurchase(h, p.operationId, token, { txHash: hash });
  assert.equal(r.verification.outcome, 'chain_unavailable');
  assert.equal(r.status, 'broadcast_reported');
  h.chain.faults.failTxBodyAfter.delete(hash);
  assert.equal((await tool(h, kai, 'verify_deal', { operationId: p.operationId })).status, 'settled_verified');
});

test("another account cannot squat a buyer's transaction hash", async () => {
  const victim = await linkedUser(h);
  const attacker = await linkedUser(h);
  const v = await tool(h, victim, 'prepare_purchase', { ...coords(), idempotencyKey: key('victim') });
  const x = await tool(h, attacker, 'prepare_purchase', { ...coords(), idempotencyKey: key('attacker') });
  const { approved } = await approvePurchase(h, v.operationId, v.approvalUrl, victim.wallet);
  await approvePurchase(h, x.operationId, x.approvalUrl, attacker.wallet);
  const realHash = h.chain.walletBroadcast(approved.payload);
  const squat = await tool(h, attacker, 'verify_deal', { operationId: x.operationId, txHash: realHash });
  assert.equal(squat.verification.outcome, 'pointer_rejected');
  const settled = await tool(h, victim, 'verify_deal', { operationId: v.operationId, txHash: realHash });
  assert.equal(settled.status, 'settled_verified');
  // And the attacker can never settle on it later.
  const late = await tool(h, attacker, 'verify_deal', { operationId: x.operationId, txHash: realHash });
  assert.notEqual(late.status, 'settled_verified');
});

test('a never-observed wrong hash can be corrected; an observed one cannot', async () => {
  const gina = await linkedUser(h);
  const p = await tool(h, gina, 'prepare_purchase', { ...coords(), idempotencyKey: key('wronghash') });
  const { approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, gina.wallet);
  const hash = h.chain.walletBroadcast(approved.payload);
  const bogus = await reportPurchase(h, p.operationId, token, { txHash: '12'.repeat(32) }); // wallet returned an unrelated id
  assert.equal(bogus.status, 'broadcast_reported');
  assert.equal(bogus.verification.outcome, 'awaiting_inclusion');
  const fixed = await tool(h, gina, 'verify_deal', { operationId: p.operationId, txHash: hash });
  assert.equal(fixed.status, 'settled_verified');
  assert.equal((await tool(h, gina, 'verify_deal', { operationId: p.operationId, txHash: '34'.repeat(32) })).error, 'hash_conflict');
  const history = (await tool(h, gina, 'get_purchase_status', { operationId: p.operationId })).history;
  assert.ok(history.some((e) => e.type === 'reported_hash_replaced'));
});

test('pending inclusion keeps the purchase unresolved until the chain confirms', async () => {
  const pendingBuyer = await linkedUser(h);
  const p = await tool(h, pendingBuyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('pending') });
  const { approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, pendingBuyer.wallet);
  const hash = h.chain.walletBroadcast(approved.payload);
  h.chain.faults.pendingHashes.add(hash);
  const reported = await reportPurchase(h, p.operationId, token, { txHash: hash });
  assert.equal(reported.status, 'broadcast_reported');
  assert.equal(reported.verification.outcome, 'awaiting_inclusion');
  h.chain.faults.pendingHashes.delete(hash);
  assert.equal((await tool(h, pendingBuyer, 'verify_deal', { operationId: p.operationId })).status, 'settled_verified');
});

for (const [label, patch, outcome] of [
  ['failed', { status: 'failed' }, 'execution_failed'],
  ['pending', { status: 'pending' }, 'awaiting_inclusion'],
  ['missing status', { status: undefined }, 'transaction_unconfirmed'],
  ['unknown status', { status: 'unexpected' }, 'transaction_unconfirmed'],
  ['included status', { status: 'included' }, 'transaction_unconfirmed'],
  ['finalized status', { status: 'finalized' }, 'transaction_unconfirmed'],
  ['block mismatch', { blockNumber: -1 }, 'invalid_observation'],
  ['null block number', { blockNumber: null }, 'invalid_observation'],
  ['different hash', { hash: '12'.repeat(32) }, 'transaction_unconfirmed'],
  ['missing hash', { hash: undefined }, 'transaction_unconfirmed'],
  ['invalid hash', { hash: 'not-a-hash' }, 'transaction_unconfirmed'],
]) {
  test(`canonical transaction readback: ${label} never settles or consumes the slot`, async () => {
    const buyer = await linkedUser(h);
    const p = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key(label.replaceAll(' ', '-')) });
    const { approved } = await approvePurchase(h, p.operationId, p.approvalUrl, buyer.wallet);
    const hash = h.chain.walletBroadcast(approved.payload);
    const chain = h.app.services.chain;
    const getTransaction = chain.getTransaction;
    // The SDK observer reads independently; vary the subsequent canonical
    // body read so its earlier inclusion cannot authorize a changed response.
    chain.getTransaction = async (txHash) => {
      const body = { ...await getTransaction(txHash), ...patch };
      if (Object.hasOwn(patch, 'hash') && patch.hash === undefined) delete body.hash;
      return body;
    };
    try {
      const r = await tool(h, buyer, 'verify_deal', { operationId: p.operationId, txHash: hash });
      assert.equal(r.status, label === 'failed' ? 'payment_uncertain' : 'broadcast_reported');
      assert.equal(r.verification.outcome, outcome);
      assert.ok(r.verification.rejectedReason);
      assert.equal(r.verification.slotConsumed, false);
      const saved = h.app.services.coordinates.get(p.operationId);
      assert.equal(saved.observation.slotConsumed, false);
      assert.equal(saved.observation.rejectedReason, r.verification.rejectedReason);
      assert.equal(saved.verifiedAt, null);
      assert.equal((await tool(h, buyer, 'get_purchase_status', { operationId: p.operationId })).settlement, null);
      if (label === 'failed') {
        const again = await tool(h, buyer, 'verify_deal', { operationId: p.operationId });
        assert.equal(again.status, 'payment_uncertain');
        assert.equal(again.verification.outcome, 'execution_failed');
        assert.equal(again.verification.txStatus, 'failed');
        assert.equal(again.verification.slotConsumed, false);
      }
    } finally {
      chain.getTransaction = getTransaction;
    }
    const again = await tool(h, buyer, 'verify_deal', { operationId: p.operationId });
    assert.equal(again.status, 'settled_verified', JSON.stringify(again));
  });
}

for (const resolution of ['nonce-proof cancel', 'later confirmed read']) {
  test(`canonical execution failure stays uncertain until ${resolution}`, async () => {
    const buyer = await linkedUser(h);
    const p = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key(resolution.replaceAll(' ', '-')) });
    const { approved } = await approvePurchase(h, p.operationId, p.approvalUrl, buyer.wallet);
    const hash = h.chain.walletBroadcast(approved.payload);
    const chain = h.app.services.chain;
    const getTransaction = chain.getTransaction;
    chain.getTransaction = async (txHash) => ({ ...await getTransaction(txHash), status: 'failed' });
    try {
      const failed = await tool(h, buyer, 'verify_deal', { operationId: p.operationId, txHash: hash });
      assert.equal(failed.status, 'payment_uncertain');
      assert.equal(failed.verification.outcome, 'execution_failed');
      assert.equal(failed.verification.txStatus, 'failed');
      assert.equal(failed.verification.slotConsumed, false);
      assert.equal(failed.verification.rejectedReason, 'canonical transaction execution failed');
      const saved = h.app.services.coordinates.get(p.operationId);
      assert.equal(saved.observation.slotConsumed, false);
      assert.equal(saved.verifiedAt, null);
      assert.equal((await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('failed-replacement') })).error, 'unresolved_payment');
      let terminal;
      if (resolution === 'nonce-proof cancel') {
        const refused = await tool(h, buyer, 'cancel_wallet_handoff', { operationId: p.operationId });
        assert.equal(refused.cancelled, false, 'an advanced nonce still refuses cancellation');
        assert.equal(refused.status, 'payment_uncertain');
        // Failed execution at node 61b8e75 does not apply the nonce edit.
        // Restore that projection; walletBroadcast otherwise simulates success.
        h.chain.setNonce(buyer.wallet.address, saved.nonceFence);
        const cancelled = await tool(h, buyer, 'cancel_wallet_handoff', { operationId: p.operationId });
        assert.equal(cancelled.cancelled, true);
        assert.equal(cancelled.status, 'cancelled');
        const replacement = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('after-failed-cancel') });
        const { approved: replacementHandoff } = await approvePurchase(h, replacement.operationId, replacement.approvalUrl, buyer.wallet);
        assert.equal(replacementHandoff.status, 'payment_handoff');
        assert.equal(h.app.services.coordinates.get(replacement.operationId).expectedNonce, saved.expectedNonce);
        terminal = 'cancelled';
      } else {
        chain.getTransaction = getTransaction;
        const confirmed = await tool(h, buyer, 'verify_deal', { operationId: p.operationId });
        assert.equal(confirmed.status, 'settled_verified');
        assert.equal(confirmed.verification.outcome, 'verified');
        assert.equal(confirmed.verification.txHash, hash);
        chain.getTransaction = async (txHash) => ({ ...await getTransaction(txHash), status: 'failed' });
        terminal = 'settled_verified';
      }
      const before = await tool(h, buyer, 'get_purchase_status', { operationId: p.operationId });
      assert.ok(!before.history.some((event) => event.type === 'payment_failed'), 'execution failure never enters a terminal failure state');
      const again = await tool(h, buyer, 'verify_deal', { operationId: p.operationId });
      assert.equal(again.status, terminal, 'a failed re-read cannot revive a terminal purchase');
      const after = await tool(h, buyer, 'get_purchase_status', { operationId: p.operationId });
      assert.deepEqual(after.history, before.history, 'no transition leaves the terminal state');
      if (terminal === 'cancelled') assert.equal(again.verification.slotConsumed, false);
    } finally {
      chain.getTransaction = getTransaction;
    }
  });
}

async function cancelledPayment(label) {
  const buyer = await linkedUser(h);
  const a = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key(label.replaceAll(' ', '-')) });
  const { approved } = await approvePurchase(h, a.operationId, a.approvalUrl, buyer.wallet);
  const hash = h.chain.walletBroadcast(approved.payload), chain = h.app.services.chain;
  const getTransaction = chain.getTransaction;
  chain.getTransaction = async (txHash) => ({ ...await getTransaction(txHash), status: 'failed' });
  try {
    assert.equal((await tool(h, buyer, 'verify_deal', { operationId: a.operationId, txHash: hash })).status, 'payment_uncertain');
  } finally { chain.getTransaction = getTransaction; }
  const saved = h.app.services.coordinates.get(a.operationId);
  h.chain.setNonce(buyer.wallet.address, saved.nonceFence);
  assert.equal((await tool(h, buyer, 'cancel_wallet_handoff', { operationId: a.operationId })).cancelled, true);
  return { buyer, a, hash, saved };
}

for (const replacementState of ['payment_handoff', 'payment_uncertain']) {
  test(`late settlement supersedes replacement in ${replacementState}`, async () => {
    const { buyer, a, hash, saved } = await cancelledPayment(replacementState);
    const b = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('same-slot') });
    const { approved } = await approvePurchase(h, b.operationId, b.approvalUrl, buyer.wallet);
    assert.equal(approved.status, 'payment_handoff');
    assert.equal(h.app.services.coordinates.get(b.operationId).expectedNonce, saved.expectedNonce);
    h.chain.setNonce(buyer.wallet.address, saved.expectedNonce); // old transfer now consumes the slot
    if (replacementState === 'payment_uncertain') {
      assert.equal((await tool(h, buyer, 'verify_deal', { operationId: b.operationId })).status, 'payment_uncertain');
    }
    const confirmed = await tool(h, buyer, 'verify_deal', { operationId: a.operationId });
    assert.equal(confirmed.status, 'settled_verified'); assert.equal(confirmed.verification.outcome, 'verified');
    const status = await tool(h, buyer, 'get_purchase_status', { operationId: b.operationId });
    assert.equal(status.status, 'superseded', 'late settlement resolves the other reservation without submitting A\'s hash to B');
    assert.deepEqual(status.history.at(-1).data, { supersededBy: a.operationId, txHash: hash });
    assert.equal(status.approvalUrl, null); assert.equal(status.settlement, null);
    const evidence = h.app.services.coordinates.get(b.operationId);
    assert.equal(evidence.observation.supersededBy, a.operationId); assert.equal(evidence.observation.txHash, hash);
    assert.equal(evidence.observation.slotConsumed, true); assert.equal(evidence.verifiedAt, null); assert.equal(evidence.reportedTxHash, null);
    const again = await tool(h, buyer, 'verify_deal', { operationId: b.operationId });
    assert.equal(again.status, 'superseded'); assert.equal(again.verification.outcome, 'superseded');
    assert.equal(again.verification.supersededBy, a.operationId);
    const c = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('released-slot') });
    assert.equal(c.status, 'awaiting_approval');
    const { approved: next } = await approvePurchase(h, c.operationId, c.approvalUrl, buyer.wallet);
    assert.equal(next.status, 'payment_handoff'); assert.equal(next.payload.content.nonce, saved.expectedNonce + 1);
  });
}

for (const difference of ['nonce', 'network', 'chain identity', 'terminal state']) {
  test(`late settlement preserves another reservation at a different ${difference}`, async () => {
    const chain = h.app.services.chain, network = chain.network, identity = chain.networkIdentity, pin = chain.pinnedIdentity;
    const first = 'ab'.repeat(32), second = 'cd'.repeat(32);
    try {
      // Bind A and B to the same public-chain-read mode so only chainIdentity differs.
      if (difference === 'chain identity') {
        chain.pinnedIdentity = first;
        chain.networkIdentity = async () => ({ mode: 'public-chain-read', identity: first });
      }
      const { buyer, a, hash, saved } = await cancelledPayment(difference);
      if (difference === 'nonce') h.chain.setNonce(buyer.wallet.address, saved.expectedNonce);
      if (difference === 'network') chain.network = 'other-fixture-network';
      let b;
      try {
        b = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('different-reservation') });
        assert.equal((await approvePurchase(h, b.operationId, b.approvalUrl, buyer.wallet)).approved.status, 'payment_handoff');
      } finally { chain.network = network; }
      if (difference === 'chain identity') {
        // A prior configuration bound this stored reservation to another genesis.
        h.app.db.prepare("UPDATE operations SET terms = json_set(terms, '$.domain.chainIdentity', ?) WHERE id = ?").run(second, b.operationId);
        const accountId = h.app.services.accounts.walletOwner(buyer.wallet.address);
        const [domainA, domainB] = [a, b].map(({ operationId }) => h.app.services.ops.get(accountId, operationId).terms.domain);
        assert.deepEqual({ ...domainB, chainIdentity: first }, domainA); assert.equal(domainA.mode, 'public-chain-read');
      }
      if (difference === 'terminal state') {
        assert.equal((await tool(h, buyer, 'cancel_wallet_handoff', { operationId: b.operationId })).cancelled, true);
      }
      const before = await tool(h, buyer, 'get_purchase_status', { operationId: b.operationId });
      const evidence = h.app.services.coordinates.get(b.operationId);
      h.chain.setNonce(buyer.wallet.address, saved.expectedNonce);
      assert.equal((await tool(h, buyer, 'verify_deal', { operationId: a.operationId, txHash: hash })).status, 'settled_verified');
      const after = await tool(h, buyer, 'get_purchase_status', { operationId: b.operationId });
      assert.equal(after.status, before.status); assert.deepEqual(after.history, before.history);
      assert.deepEqual(h.app.services.coordinates.get(b.operationId), evidence);
    } finally { chain.networkIdentity = identity; chain.pinnedIdentity = pin; }
  });
}

async function replacementPublication(buyer) {
  const pub = await tool(h, buyer, 'register_agent', {
    idempotencyKey: key('replacement-publication'), listingId: key('slot-listing'), displayName: 'Slot seller',
    endpointUrl: 'https://127.0.0.1/dacs', title: 'Nonce slot listing', description: 'Fixture publication at the cancelled payment nonce.',
    category: 'services.translation', tags: ['fixture'], priceDem: '1.25', validDays: 30,
  });
  assert.equal(pub.status, 'awaiting_identity_signature', JSON.stringify(pub));
  const token = tokenFrom(pub.portalUrl);
  const view = await portal(h, `/portal/api/publish/${pub.operationId}/view`, { token });
  const identity = await portal(h, `/portal/api/publish/${pub.operationId}/identity`, { token, address: buyer.wallet.address, signature: buyer.wallet.signHex(view.signRequest.message) });
  assert.equal(identity.status, 'awaiting_listing_signature', JSON.stringify(identity));
  const listed = await portal(h, `/portal/api/publish/${pub.operationId}/listing`, { token, signature: buyer.wallet.signHex(identity.signRequest.message) });
  assert.equal(listed.status, 'publication_handoff');
  return { pub, token };
}

for (const publicationState of ['publication_handoff', 'broadcast_reported', 'publication_uncertain']) {
test(`late settlement terminates a publication holding the consumed nonce: ${publicationState}`, async () => {
  const { buyer, a, hash, saved } = await cancelledPayment('publication-slot');
  const { pub, token } = await replacementPublication(buyer);
  const publication = h.app.services.ops.get(h.app.services.accounts.walletOwner(buyer.wallet.address), pub.operationId);
  assert.deepEqual(publication.state.publicationDomain, { mode: 'simulated-fixture', chainIdentity: null });
  assert.equal(h.app.services.coordinates.get(pub.operationId).expectedNonce, saved.expectedNonce);
  h.chain.setNonce(buyer.wallet.address, saved.expectedNonce);
  if (publicationState === 'publication_uncertain') {
    assert.equal((await portal(h, `/portal/api/publish/${pub.operationId}/handoff`, { token })).status, 'publication_uncertain');
  }
  if (publicationState !== 'publication_handoff') {
    const reported = await portal(h, `/portal/api/publish/${pub.operationId}/report`, { token, txHash: createHash('sha256').update(pub.operationId).digest('hex') });
    assert.equal(reported.status, publicationState);
  }
  const beforeSettlement = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('publication-blocking-unchanged') });
  assert.equal(publicationState === 'publication_uncertain' ? beforeSettlement.status : beforeSettlement.error, publicationState === 'publication_uncertain' ? 'awaiting_approval' : 'unresolved_payment');
  assert.equal((await tool(h, buyer, 'verify_deal', { operationId: a.operationId, txHash: hash })).status, 'settled_verified');
  const status = await tool(h, buyer, 'get_agent_status', { agentId: pub.agentId });
  assert.equal(status.publicationStatus, 'publication_mismatch'); assert.equal(status.onChainVerified, false);
  assert.equal(status.portalUrl, null); assert.deepEqual(status.history.at(-1).data, { supersededBy: a.operationId, txHash: hash });
  const stages = h.app.services.agents.get(h.app.services.accounts.walletOwner(buyer.wallet.address), pub.agentId).stages;
  assert.equal(stages.find((stage) => stage.id === 'storage_write').state, 'failed');
  assert.equal(stages.find((stage) => stage.id === 'chain_readback').state, 'failed');
  assert.match(status.next, /nonce slot/);
  assert.equal((await tool(h, buyer, 'verify_agent_publication', { agentId: pub.agentId })).publicationStatus, 'publication_mismatch');
  assert.equal((await portal(h, `/portal/api/publish/${pub.operationId}/handoff`, { token })).error, 'invalid_state');
  assert.equal((await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('after-publication-consumed') })).status, 'awaiting_approval');
});
}

for (const mismatch of ['different chain identity', 'different mode', 'missing domain']) {
  test(`late settlement preserves a publication reservation with ${mismatch}`, async () => {
    const { chain, ops, accounts, coordinates } = h.app.services;
    const identity = chain.networkIdentity, pin = chain.pinnedIdentity;
    const first = 'ab'.repeat(32), second = 'cd'.repeat(32);
    try {
      chain.pinnedIdentity = first;
      chain.networkIdentity = async () => ({ mode: 'public-chain-read', identity: first });
      const { buyer, a, hash, saved } = await cancelledPayment('publication-domain');
      chain.pinnedIdentity = second;
      chain.networkIdentity = async () => mismatch === 'different mode' ? { mode: 'simulated-fixture', identity: null } : { mode: 'public-chain-read', identity: second };
      const { pub } = await replacementPublication(buyer);
      const domain = mismatch === 'different mode' ? { mode: 'simulated-fixture', chainIdentity: null } : { mode: 'public-chain-read', chainIdentity: second };
      // Model the persisted reservation, including databases made before domain capture.
      if (mismatch === 'missing domain') h.app.db.prepare("UPDATE operations SET state = json_remove(state, '$.publicationDomain') WHERE id = ?").run(pub.operationId);
      else h.app.db.prepare("UPDATE operations SET state = json_set(state, '$.publicationDomain', json(?)) WHERE id = ?").run(JSON.stringify(domain), pub.operationId);
      const accountId = accounts.walletOwner(buyer.wallet.address), before = ops.get(accountId, pub.operationId);
      const history = ops.history(pub.operationId), reservation = coordinates.get(pub.operationId);
      assert.equal(reservation.expectedNonce, saved.expectedNonce);
      chain.pinnedIdentity = first;
      chain.networkIdentity = async () => ({ mode: 'public-chain-read', identity: first });
      h.chain.setNonce(buyer.wallet.address, saved.expectedNonce);
      assert.equal((await tool(h, buyer, 'verify_deal', { operationId: a.operationId, txHash: hash })).status, 'settled_verified');
      assert.deepEqual(ops.get(accountId, pub.operationId), before);
      assert.deepEqual(ops.history(pub.operationId), history);
      assert.deepEqual(coordinates.get(pub.operationId), reservation);
      assert.equal((await tool(h, buyer, 'get_agent_status', { agentId: pub.agentId })).publicationStatus, 'publication_handoff');
    } finally { chain.networkIdentity = identity; chain.pinnedIdentity = pin; }
  });
}

test('late settlement and supersession roll back together if another transition fails', async () => {
  const { buyer, a, hash, saved } = await cancelledPayment('supersession-rollback');
  const b = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('rollback-replacement') });
  assert.equal((await approvePurchase(h, b.operationId, b.approvalUrl, buyer.wallet)).approved.status, 'payment_handoff');
  h.chain.setNonce(buyer.wallet.address, saved.expectedNonce);
  const { ops, coordinates, purchases, accounts } = h.app.services, transition = ops.transition;
  const aBefore = coordinates.get(a.operationId), bBefore = coordinates.get(b.operationId);
  const aHistory = ops.history(a.operationId), bHistory = ops.history(b.operationId);
  ops.transition = (id, from, to, options) => {
    if (id === b.operationId && to === 'superseded') throw new Error('TEST supersession transition refused');
    return transition(id, from, to, options);
  };
  try {
    await assert.rejects(purchases.verifyDeal({ accountId: accounts.walletOwner(buyer.wallet.address), operationId: a.operationId }), /TEST supersession transition refused/);
    assert.deepEqual(coordinates.get(a.operationId), aBefore); assert.deepEqual(coordinates.get(b.operationId), bBefore);
    assert.deepEqual(ops.history(a.operationId), aHistory); assert.deepEqual(ops.history(b.operationId), bHistory);
  } finally { ops.transition = transition; }
  assert.equal((await tool(h, buyer, 'verify_deal', { operationId: a.operationId, txHash: hash })).status, 'settled_verified');
  assert.equal((await tool(h, buyer, 'get_purchase_status', { operationId: b.operationId })).status, 'superseded');
});

// The settling body is signed by an alternate key for the buyer account; the
// node may have counted its nonce against that key, leaving the wallet's free.
for (const reservation of ['purchase', 'publication']) {
  test(`late alternate-signer settlement leaves a ${reservation} reservation at the same nonce open`, async () => {
    const { buyer, a, hash, saved } = await cancelledPayment(`alternate-signer-${reservation}`);
    const { ops, coordinates, accounts, chain } = h.app.services, accountId = accounts.walletOwner(buyer.wallet.address);
    let other;
    if (reservation === 'purchase') {
      const b = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('alternate-signer-replacement') });
      assert.equal((await approvePurchase(h, b.operationId, b.approvalUrl, buyer.wallet)).approved.status, 'payment_handoff');
      other = b.operationId;
    } else other = (await replacementPublication(buyer)).pub.operationId;
    assert.equal(coordinates.get(other).expectedNonce, saved.expectedNonce);
    const before = ops.get(accountId, other), history = ops.history(other), evidence = coordinates.get(other);
    const getTransaction = chain.getTransaction;
    let settled;
    chain.getTransaction = async (txHash) => { const body = await getTransaction(txHash); body.content.from = `0x${'a'.repeat(64)}`; return body; };
    try {
      settled = await tool(h, buyer, 'verify_deal', { operationId: a.operationId, txHash: hash });
      assert.equal(settled.status, 'settled_verified');
    } finally { chain.getTransaction = getTransaction; }
    assert.deepEqual(ops.get(accountId, other), before); assert.deepEqual(ops.history(other), history);
    assert.deepEqual(coordinates.get(other), evidence);
    assert.equal(settled.verification.signedByAlternateKey, true);
  });
}

for (const order of ['cancel first', 'settlement first']) {
  test(`confirmed verification races nonce-proof cancellation: ${order}`, async () => {
    const buyer = await linkedUser(h);
    const p = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('cancel-settle-race') });
    const { approved } = await approvePurchase(h, p.operationId, p.approvalUrl, buyer.wallet);
    const hash = h.chain.walletBroadcast(approved.payload);
    const chain = h.app.services.chain, coordinates = h.app.services.coordinates;
    const getTransaction = chain.getTransaction, getAddressNonce = chain.getAddressNonce;
    chain.getTransaction = async (txHash) => ({ ...await getTransaction(txHash), status: 'failed' });
    assert.equal((await tool(h, buyer, 'verify_deal', { operationId: p.operationId, txHash: hash })).status, 'payment_uncertain');
    const saved = coordinates.get(p.operationId);
    h.chain.setNonce(buyer.wallet.address, saved.nonceFence);
    let nonceRead, releaseNonce, bodyRead, releaseBody;
    const nonceStarted = new Promise((resolve) => { nonceRead = resolve; });
    const nonceHeld = new Promise((resolve) => { releaseNonce = resolve; });
    const bodyStarted = new Promise((resolve) => { bodyRead = resolve; });
    const bodyHeld = new Promise((resolve) => { releaseBody = resolve; });
    chain.getAddressNonce = async (address) => { const nonce = await getAddressNonce(address); nonceRead(); await nonceHeld; return nonce; };
    chain.getTransaction = async (txHash) => { const body = await getTransaction(txHash); bodyRead(); await bodyHeld; return body; };
    let cancelling, verifying;
    try {
      cancelling = tool(h, buyer, 'cancel_wallet_handoff', { operationId: p.operationId });
      await nonceStarted;
      h.chain.setNonce(buyer.wallet.address, saved.expectedNonce); // the earlier nonce proof has already been read
      verifying = tool(h, buyer, 'verify_deal', { operationId: p.operationId }); // no explicit hash, captured uncertainty
      await bodyStarted;
      assert.equal(coordinates.get(p.operationId).verifiedAt, null, 'chain facts alone do not write settlement');
      if (order === 'cancel first') {
        releaseNonce();
        const cancelled = await cancelling;
        assert.equal(cancelled.cancelled, true); assert.equal(cancelled.status, 'cancelled');
        assert.equal(coordinates.get(p.operationId).verifiedAt, null, 'committed cancellation has no settlement evidence');
        releaseBody();
      } else {
        releaseBody();
        const verified = await verifying;
        assert.equal(verified.status, 'settled_verified'); assert.equal(verified.verification.outcome, 'verified');
        assert.ok(coordinates.get(p.operationId).verifiedAt);
        releaseNonce();
        const lost = await cancelling;
        assert.equal(lost.status, 'settled_verified'); assert.equal(lost.cancelled, false, 'cancel reports it lost to committed settlement');
      }
      const verified = await verifying;
      assert.equal(verified.status, 'settled_verified'); assert.equal(verified.verification.outcome, 'verified');
      const stored = await tool(h, buyer, 'get_purchase_status', { operationId: p.operationId });
      assert.equal(stored.status, verified.status); assert.ok(coordinates.get(p.operationId).verifiedAt);
      assert.deepEqual(verified.verification, { outcome: 'verified', ...coordinates.get(p.operationId).observation, verifiedAt: coordinates.get(p.operationId).verifiedAt });
      assert.equal(coordinates.get(p.operationId).observation.txHash, hash);
      assert.equal(stored.history.filter((event) => event.type === 'settled_verified').length, 1);
    } finally {
      releaseNonce(); releaseBody();
      await Promise.allSettled([cancelling, verifying]);
      chain.getTransaction = getTransaction; chain.getAddressNonce = getAddressNonce;
    }
  });
}

test('settlement evidence rolls back when its state transition fails', async () => {
  const buyer = await linkedUser(h);
  const p = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('settlement-rollback') });
  const { approved } = await approvePurchase(h, p.operationId, p.approvalUrl, buyer.wallet);
  const hash = h.chain.walletBroadcast(approved.payload), services = h.app.services;
  const getTransaction = services.chain.getTransaction, transition = services.ops.transition;
  services.chain.getTransaction = async (txHash) => ({ ...await getTransaction(txHash), status: 'failed' });
  assert.equal((await tool(h, buyer, 'verify_deal', { operationId: p.operationId, txHash: hash })).status, 'payment_uncertain');
  services.chain.getTransaction = getTransaction;
  const before = services.coordinates.get(p.operationId), history = services.ops.history(p.operationId);
  services.ops.transition = (id, from, to, options) => {
    if (id === p.operationId && to === 'settled_verified') throw new Error('TEST settlement transition refused');
    return transition(id, from, to, options);
  };
  try {
    await assert.rejects(services.purchases.verifyDeal({ accountId: services.accounts.walletOwner(buyer.wallet.address), operationId: p.operationId }), /TEST settlement transition refused/);
    assert.deepEqual(services.coordinates.get(p.operationId), before, 'status and evidence roll back together');
    assert.deepEqual(services.ops.history(p.operationId), history);
    assert.equal((await tool(h, buyer, 'get_purchase_status', { operationId: p.operationId })).status, 'payment_uncertain');
  } finally { services.ops.transition = transition; }
  assert.equal((await tool(h, buyer, 'verify_deal', { operationId: p.operationId })).status, 'settled_verified');
});

for (const [label, bodyPatch, observationPatch, confirmLater] of [
  ['failed', { status: 'failed' }, null, false],
  ['pending', { status: 'pending' }, null, false],
  ['missing status', { status: undefined }, null, false],
  ['unknown status', { status: 'unexpected' }, null, false],
  ['block mismatch', { blockNumber: -1 }, null, false],
  ['invalid observation', {}, { status: 'invalid', reason: 'inconsistent readback' }, false],
  ['observer failed', {}, { status: 'failed', reason: 'transaction state is failed' }, false],
  ['observer pending', {}, { status: 'pending' }, false],
  ['unavailable', {}, { status: 'unavailable' }, false],
  ['confirmed after failed', { status: 'failed' }, null, true],
  ['different hash', { hash: '12'.repeat(32) }, null, true],
  ['missing hash', { hash: undefined }, null, true],
]) {
  test(`cancelled failed purchase survives explicit ${label} readback without blocking its replacement`, async () => {
    const buyer = await linkedUser(h);
    const p = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key(label.replaceAll(' ', '-')) });
    const { approved } = await approvePurchase(h, p.operationId, p.approvalUrl, buyer.wallet);
    const hash = h.chain.walletBroadcast(approved.payload);
    const chain = h.app.services.chain;
    const getTransaction = chain.getTransaction, observeTransfer = chain.observeTransfer;
    chain.getTransaction = async (txHash) => ({ ...await getTransaction(txHash), status: 'failed' });
    try {
      const failed = await tool(h, buyer, 'verify_deal', { operationId: p.operationId, txHash: hash });
      assert.equal(failed.status, 'payment_uncertain');
      const saved = h.app.services.coordinates.get(p.operationId);
      h.chain.setNonce(buyer.wallet.address, saved.nonceFence); // failed execution applies no nonce edit
      assert.equal((await tool(h, buyer, 'cancel_wallet_handoff', { operationId: p.operationId })).cancelled, true);
      const before = await tool(h, buyer, 'get_purchase_status', { operationId: p.operationId });
      const replacement = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('replacement-after-cancel') });
      assert.equal(replacement.status, 'awaiting_approval');
      chain.getTransaction = async (txHash) => {
        const body = { ...await getTransaction(txHash), ...bodyPatch };
        if (Object.hasOwn(bodyPatch, 'hash') && bodyPatch.hash === undefined) delete body.hash;
        return body;
      };
      let started, release;
      const readStarted = new Promise((resolve) => { started = resolve; });
      const held = new Promise((resolve) => { release = resolve; });
      chain.observeTransfer = async (txHash) => {
        started();
        await held;
        return observationPatch ?? observeTransfer(txHash);
      };
      const checking = tool(h, buyer, 'verify_deal', { operationId: p.operationId, txHash: hash });
      await readStarted;
      let checked;
      try {
        assert.equal((await tool(h, buyer, 'get_purchase_status', { operationId: p.operationId })).status, 'cancelled', 'readback never temporarily revokes cancellation');
        const { approved: handoff } = await approvePurchase(h, replacement.operationId, replacement.approvalUrl, buyer.wallet);
        assert.equal(handoff.status, 'payment_handoff', 'replacement can obtain its handoff while the old read is pending');
      } finally {
        release();
        checked = await checking;
      }
      assert.equal(checked.status, 'cancelled');
      const after = await tool(h, buyer, 'get_purchase_status', { operationId: p.operationId });
      assert.deepEqual(after.history, before.history, 'no failed read revives the cancelled purchase');
      assert.equal((await tool(h, buyer, 'get_purchase_status', { operationId: replacement.operationId })).status, 'payment_handoff');
      if (confirmLater) {
        chain.getTransaction = getTransaction;
        chain.observeTransfer = observeTransfer;
        h.chain.setNonce(buyer.wallet.address, saved.expectedNonce); // the old transfer finally applies
        const confirmed = await tool(h, buyer, 'verify_deal', { operationId: p.operationId, txHash: hash });
        assert.equal(confirmed.status, 'settled_verified');
        assert.equal(confirmed.verification.outcome, 'verified');
        assert.equal(confirmed.verification.txHash, hash);
        assert.equal((await tool(h, buyer, 'get_purchase_status', { operationId: replacement.operationId })).status, 'superseded');
      }
    } finally {
      chain.getTransaction = getTransaction;
      chain.observeTransfer = observeTransfer;
    }
  });
}

test('canonical confirmed transaction may settle without an optional body block number', async () => {
  const buyer = await linkedUser(h);
  const p = await tool(h, buyer, 'prepare_purchase', { ...coords(), idempotencyKey: key('confirmed-no-block') });
  const { approved } = await approvePurchase(h, p.operationId, p.approvalUrl, buyer.wallet);
  const hash = h.chain.walletBroadcast(approved.payload);
  const chain = h.app.services.chain;
  const getTransaction = chain.getTransaction;
  chain.getTransaction = async (txHash) => {
    const body = await getTransaction(txHash);
    assert.equal(body.status, 'confirmed');
    body.hash = `0x${body.hash.toUpperCase()}`;
    delete body.blockNumber;
    return body;
  };
  try {
    const r = await tool(h, buyer, 'verify_deal', { operationId: p.operationId, txHash: hash });
    assert.equal(r.status, 'settled_verified', JSON.stringify(r));
    assert.equal(r.verification.outcome, 'verified');
    assert.equal(r.verification.slotConsumed, true);
  } finally {
    chain.getTransaction = getTransaction;
  }
});

test('listing changed after approval: nothing is handed to the wallet', async () => {
  const restartBuyer = await linkedUser(h);
  const { listing: l, locator } = seedSellerListing(h, seller, { listingId: 'volatile-report', price: '3' });
  const p = await tool(h, restartBuyer, 'prepare_purchase', { ...coords('volatile-report'), idempotencyKey: key('volatile') });
  // The change lands after the pre-signature check passed and the challenge
  // was issued: the authoritative handoff re-verification must still catch it.
  const token = tokenFrom(p.approvalUrl);
  const challenge = await portal(h, `/portal/api/purchase/${p.operationId}/challenge`, { token, address: restartBuyer.wallet.address });
  assert.ok(challenge.challengeId);
  h.chain.faults.alterStorage.set(locator, { ...l, pricing: { kind: 'fixed', price: { amount: '30', currency: 'DEM' } } });
  const approved = await portal(h, `/portal/api/purchase/${p.operationId}/approve`, { token, challengeId: challenge.challengeId, signature: restartBuyer.wallet.signHex(challenge.message) });
  assert.equal(approved.status, 'terms_changed');
  assert.equal(approved.payload, null);
  assert.equal(h.app.services.coordinates.get(p.operationId), null, 'no coordinates were saved and nothing was handed to the wallet');
  h.chain.faults.alterStorage.delete(locator);
});

test('approval window expiry is enforced server-side', async () => {
  const erin = await linkedUser(h);
  const p = await tool(h, erin, 'prepare_purchase', { ...coords(), idempotencyKey: key('expiry') });
  h.app.db.prepare('UPDATE operations SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), p.operationId);
  const challenge = await portal(h, `/portal/api/purchase/${p.operationId}/challenge`, { token: tokenFrom(p.approvalUrl), address: erin.wallet.address });
  assert.equal(challenge.error, 'invalid_state');
  assert.equal((await tool(h, erin, 'get_purchase_status', { operationId: p.operationId })).status, 'expired');
  // The read-only status tool reports expiry without writing it.
  const q = await tool(h, erin, 'prepare_purchase', { ...coords(), idempotencyKey: key('expiry-ro') });
  h.app.db.prepare('UPDATE operations SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), q.operationId);
  assert.equal((await tool(h, erin, 'get_purchase_status', { operationId: q.operationId })).status, 'expired');
  assert.equal(h.app.db.prepare('SELECT status FROM operations WHERE id = ?').get(q.operationId).status, 'awaiting_approval');
});

test('concurrent wallet handoffs return one saved payload', async () => {
  const hal = await linkedUser(h);
  const p = await tool(h, hal, 'prepare_purchase', { ...coords(), idempotencyKey: key('handoff-race') });
  const { approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, hal.wallet);
  const results = await Promise.all(Array.from({ length: 4 }, () => portal(h, `/portal/api/purchase/${p.operationId}/handoff`, { token })));
  for (const r of results) {
    assert.equal(r.status, 'payment_handoff', JSON.stringify(r));
    assert.deepEqual(r.payload, approved.payload);
  }
  const hash = h.chain.walletBroadcast(approved.payload);
  assert.equal((await reportPurchase(h, p.operationId, token, { txHash: hash })).status, 'settled_verified');
});

test('altered or unverifiable listing evidence is not transactable', async () => {
  const s2 = createEphemeralWallet();
  // Directory detail differs from the chain bytes.
  const a = seedSellerListing(h, s2, { listingId: 'altered-detail' });
  h.directory.faults.alterDetail.set(h.directory.keyFor(a.listing), { ...a.listing, offering: { ...a.listing.offering, title: 'Swapped' } });
  const va = await tool(h, null, 'get_listing', coords('altered-detail', 1, s2));
  assert.equal(va.transactable, false);
  assert.ok(va.checks.find((c) => c.name === 'directory-detail-hash-matches-summary' && !c.ok));
  // Chain anchor owned by someone other than the seller.
  const b = seedSellerListing(h, s2, { listingId: 'foreign-owner' });
  h.chain.seedStorage(b.locator, { data: b.listing, owner: createEphemeralWallet().address });
  const vb = await tool(h, null, 'get_listing', coords('foreign-owner', 1, s2));
  assert.equal(vb.transactable, false);
  assert.ok(vb.checks.find((c) => c.name === 'chain-anchor-owner-is-seller' && !c.ok));
  // Expired validity window.
  seedSellerListing(h, s2, { listingId: 'expired-offer', now: Date.now() - 10 * 86400_000, notAfter: Date.now() - 86400_000 });
  const vc = await tool(h, null, 'get_listing', coords('expired-offer', 1, s2));
  assert.equal(vc.transactable, false);
  assert.notEqual(vc.disposition, 'verified');
  // Catalog says revoked.
  seedSellerListing(h, s2, { listingId: 'revoked-offer', summary: { status: 'revoked' } });
  const vd = await tool(h, null, 'get_listing', coords('revoked-offer', 1, s2));
  assert.equal(vd.transactable, false);
  // Stale catalog observation cannot establish revocation absence.
  seedSellerListing(h, s2, { listingId: 'stale-offer', summary: { observedAt: new Date(Date.now() - 3 * 86400_000).toISOString() } });
  const ve = await tool(h, null, 'get_listing', coords('stale-offer', 1, s2));
  assert.equal(ve.transactable, false);
  // Bad signature: listing bytes changed after signing (chain and directory agree, signature does not).
  const forged = { ...a.listing, listingId: 'forged-sig', offering: { ...a.listing.offering, title: 'Changed after signing' } };
  const locator = 'stor-' + 'f'.repeat(40);
  h.chain.seedStorage(locator, { data: forged, owner: s2.address });
  h.directory.add({ ...(await import('./fixtures/listings.mjs')).summaryFor(forged, locator) }, forged);
  const vf = await tool(h, null, 'get_listing', coords('forged-sig', 1, s2));
  assert.equal(vf.transactable, false);
  assert.equal(vf.disposition, 'rejected');
  // Unsupported pricing for v0.1 (negotiable) stays discoverable but not purchasable.
  seedSellerListing(h, s2, { listingId: 'rfq-offer', pricing: { kind: 'negotiable', priceBand: { min: { amount: '1', currency: 'DEM' }, max: { amount: '2', currency: 'DEM' } } }, pipeline: [{ kind: 'negotiate-rfq' }, { kind: 'commit-payee-bound-agreement' }, { kind: 'pay-dem', parameters: { rail: 'demos-native:DEM' } }] });
  const vg = await tool(h, null, 'get_listing', coords('rfq-offer', 1, s2));
  assert.equal(vg.transactable, false);
  const buyer = await linkedUser(h);
  const refused = await tool(h, buyer, 'prepare_purchase', { ...coords('altered-detail', 1, s2), idempotencyKey: key('refuse') });
  assert.equal(refused.error, 'listing_not_transactable');
});

test('unavailable directory or chain fails safely without creating operations', async () => {
  const frank = await linkedUser(h);
  h.directory.faults.unavailable = true;
  try {
    const search = await tool(h, null, 'search_agents', { query: 'report' });
    assert.equal(search.error, 'upstream_unavailable');
    const p = await tool(h, frank, 'prepare_purchase', { ...coords(), idempotencyKey: key('down1') });
    assert.equal(p.error, 'upstream_unavailable');
  } finally {
    h.directory.faults.unavailable = false;
  }
  h.chain.faults.unavailable = true;
  try {
    const v = await tool(h, null, 'get_listing', coords());
    assert.equal(v.transactable, false);
    assert.ok(v.checks.find((c) => c.name === 'chain-anchor-present' && !c.ok));
    const p = await tool(h, frank, 'prepare_purchase', { ...coords(), idempotencyKey: key('down2') });
    assert.equal(p.error, 'listing_not_transactable');
  } finally {
    h.chain.faults.unavailable = false;
  }
  const status = await tool(h, frank, 'get_account_status');
  assert.equal(status.purchases.length, 0);
});

test('a settled purchase keeps its status and evidence through failing re-reads', async () => {
  const lea = await linkedUser(h);
  const p = await tool(h, lea, 'prepare_purchase', { ...coords(), idempotencyKey: key('sticky') });
  const { approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, lea.wallet);
  const hash = h.chain.walletBroadcast(approved.payload);
  assert.equal((await reportPurchase(h, p.operationId, token, { txHash: hash })).status, 'settled_verified');
  h.chain.faults.unavailable = true;
  try {
    const again = await tool(h, lea, 'verify_deal', { operationId: p.operationId });
    assert.equal(again.status, 'settled_verified');
    assert.equal(again.verification.outcome, 'verified');
  } finally {
    h.chain.faults.unavailable = false;
  }
  h.chain.faults.pendingHashes.add(hash);
  assert.equal((await tool(h, lea, 'verify_deal', { operationId: p.operationId, txHash: hash })).status, 'settled_verified');
  h.chain.faults.pendingHashes.delete(hash);
  const status = await tool(h, lea, 'get_purchase_status', { operationId: p.operationId });
  assert.ok(status.settlement, 'settlement evidence is still returned');
  assert.equal((await tool(h, lea, 'verify_deal', { operationId: p.operationId, txHash: 'cd'.repeat(32) })).error, 'hash_conflict');
});

test('a wallet rejection can be cancelled while the nonce proves nothing was sent', async () => {
  const max = await linkedUser(h);
  const a = await tool(h, max, 'prepare_purchase', { ...coords(), idempotencyKey: key('cancel-a') });
  const b = await tool(h, max, 'prepare_purchase', { ...coords('other-report'), idempotencyKey: key('cancel-b') });
  const { approved, token } = await approvePurchase(h, a.operationId, a.approvalUrl, max.wallet);
  await reportPurchase(h, a.operationId, token, { walletError: 'User rejected the request' });
  const cancelled = await tool(h, max, 'cancel_wallet_handoff', { operationId: a.operationId });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.status, 'cancelled');
  const { approved: bApproved } = await approvePurchase(h, b.operationId, b.approvalUrl, max.wallet);
  assert.equal(bApproved.status, 'payment_handoff', 'cancellation unblocks the wallet');
  assert.equal(bApproved.payload.content.nonce, approved.payload.content.nonce, 'same nonce slot: at most one of the two can ever land');
  // If the wallet later sends the old (cancelled) payload, it is still recorded honestly.
  const late = h.chain.walletBroadcast(approved.payload);
  assert.equal((await tool(h, max, 'verify_deal', { operationId: a.operationId, txHash: late })).status, 'settled_verified');
  assert.throws(() => h.chain.walletBroadcast(bApproved.payload), /rejected nonce/, 'B can no longer land');
  const bCheck = await tool(h, max, 'verify_deal', { operationId: b.operationId });
  assert.equal(bCheck.status, 'superseded', 'the slot provably went to A, so B can never be paid');
  assert.equal(bCheck.verification.supersededBy, a.operationId);
  const next = await tool(h, max, 'prepare_purchase', { ...coords('other-report'), idempotencyKey: key('after-superseded') });
  assert.equal(next.status, 'awaiting_approval', 'the wallet is unblocked');
  // Cancel is refused once the nonce advanced.
  const refused = await tool(h, max, 'cancel_wallet_handoff', { operationId: b.operationId });
  assert.equal(refused.error, 'invalid_state');
});

test('a chain-reported failed transaction never finalizes the purchase', async () => {
  const ned = await linkedUser(h);
  const p = await tool(h, ned, 'prepare_purchase', { ...coords(), idempotencyKey: key('failed') });
  const { approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, ned.wallet);
  const hash = h.chain.walletBroadcast(approved.payload, { failOnChain: true });
  const r = await reportPurchase(h, p.operationId, token, { txHash: hash });
  assert.equal(r.verification.outcome, 'failed_unconfirmed');
  assert.equal(r.status, 'payment_uncertain');
  assert.equal((await tool(h, ned, 'prepare_purchase', { ...coords('other-report'), idempotencyKey: key('failed-retry') })).error, 'unresolved_payment');
});

test('logs never contain bearer tokens, signatures or handoff tokens', async () => {
  const joined = h.logs.join('\n');
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(joined), 'no JWTs in logs');
  assert.ok(!joined.includes(primaryBuyer.token()), 'no access token in logs');
  assert.ok(!/#t=/.test(joined), 'no portal tokens in logs');
});

// ---------------------------------------------------------------------------
// Network identity (a review P1), purchase commitment (P3) and single-RPC,
// tuple-only observation (P4). The pinned-chain tests run the real app against
// a NON-simulated loopback chain stub with a genesis block (test-only, not a
// Demos node), so the pinned-identity path runs; the existing tests above run
// the SIMULATED fixture path.
// ---------------------------------------------------------------------------
const GENESIS_A = 'a1'.repeat(32);
const GENESIS_B = 'b2'.repeat(32);
const HEX64 = /^[0-9a-f]{64}$/;

// The chain identity reader over an injected fetch (no sockets). Mirrors the
// pinned @kynesyslabs/dacs DemosAdapter.resolveChainIdentity convention.
function fakeRpc({ blocks = {}, marked = false, results = {} } = {}) {
  const asked = [];
  const fetchImpl = async (_url, init) => {
    const call = JSON.parse(init.body).params[0];
    asked.push(call.data.blockNumber);
    const headers = { 'content-type': 'application/json', ...(marked ? { 'x-dacs-simulation': 'fixture' } : {}) };
    const result = results[call.data.blockNumber] ?? 200;
    return new Response(JSON.stringify({ result, response: result === 200 ? blocks[call.data.blockNumber] ?? null : 'error' }), { status: 200, headers });
  };
  return { fetchImpl, asked };
}

test('chain identity: the genesis hash from block 0, else block 1 previousHash; nothing else counts', async () => {
  const read = (rpcUrl, rpc) => createDemosChainReader({ rpcUrl, network: 'demos-testnet', fetchImpl: rpc.fetchImpl }).networkIdentity();
  const remote = 'https://rpc.identity.invalid';
  assert.deepEqual(await read(remote, fakeRpc({ blocks: { 0: { number: 0, hash: `0x${GENESIS_A.toUpperCase()}` } } })), { mode: 'public-chain-read', identity: GENESIS_A });
  // Some nodes refuse block zero; block one's confirmed predecessor is the identity.
  const fallback = fakeRpc({ results: { 0: 500 }, blocks: { 1: { number: 1, hash: GENESIS_B, status: 'confirmed', content: { previousHash: GENESIS_A } } } });
  assert.deepEqual(await read(remote, fallback), { mode: 'public-chain-read', identity: GENESIS_A });
  assert.deepEqual(fallback.asked, [0, 1]);
  for (const [label, rpc] of [
    ['no genesis at all', fakeRpc()],
    ['block 0 is not the genesis', fakeRpc({ blocks: { 0: { number: 7, hash: GENESIS_A } } })],
    ['malformed genesis hash', fakeRpc({ blocks: { 0: { number: 0, hash: 'genesis' } } })],
    ['unconfirmed block 1', fakeRpc({ blocks: { 1: { number: 1, hash: GENESIS_B, status: 'derived', content: { previousHash: GENESIS_A } } } })],
    // The simulation marker means nothing off loopback: a genesis is still required.
    ['simulation marker on a non-loopback RPC', fakeRpc({ marked: true })],
  ]) {
    await assert.rejects(read(remote, rpc), (error) => error instanceof OutboundError && error.kind === 'invalid', label);
  }
  // A loopback RPC that marks its answer simulated is a fixture without a real identity.
  assert.deepEqual(await read('http://127.0.0.1:9', fakeRpc({ marked: true })), { mode: 'simulated-fixture', identity: null });
  // This build pins no chain identity, so every non-simulated chain is unpinned.
  assert.deepEqual({ ...PINNED_CHAIN_IDENTITIES }, {});
  assert.equal(createDemosChainReader({ rpcUrl: remote, network: 'demos-testnet', pinnedIdentity: `0x${GENESIS_A}` }).pinnedIdentity, GENESIS_A);
  assert.equal(createDemosChainReader({ rpcUrl: remote, network: 'demos-testnet', pinnedIdentity: 'not-a-hash' }).pinnedIdentity, null);
});

// Test-only stand-in for a Demos RPC that does not mark itself simulated. It
// serves exactly the reads a purchase needs, with the genesis at block 0, and
// a wallet-broadcast entry point with the next-nonce rule (as the fixtures do).
async function startPinnedChainStub({ genesisHash }) {
  const nonces = new Map();
  const storage = new Map();
  const txs = new Map();
  const blocks = [null]; // block 0 is the genesis; transactions start at 1
  let genesis = genesisHash;
  let clock = Math.floor(Date.now() / 1000);
  function nodeCall(message, data) {
    switch (message) {
      case 'getAddressNonce':
        return nonces.get(String(data.address).toLowerCase()) ?? 0;
      case 'getTransactionStatus': {
        const tx = txs.get(String(data.hash).toLowerCase());
        return tx ? { state: 'included', blockNumber: tx.blockNumber } : { state: 'not-found' };
      }
      case 'getTxByHash': {
        const tx = txs.get(String(data.hash).toLowerCase());
        return tx ? { hash: tx.hash, content: tx.content, status: 'confirmed', blockNumber: tx.blockNumber } : null;
      }
      case 'getBlockByNumber': {
        if (data.blockNumber === 0) return { number: 0, hash: genesis, status: 'confirmed', content: { ordered_transactions: [], timestamp: clock } };
        const block = blocks[data.blockNumber];
        return block ? { number: block.number, status: 'confirmed', content: { ordered_transactions: block.txs, timestamp: block.timestamp } } : null;
      }
      default:
        return undefined;
    }
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    const url = new URL(req.url, 'http://stub');
    const storageMatch = /^\/storage-program\/(stor-[0-9a-f]{40})$/.exec(url.pathname);
    if (req.method === 'GET' && storageMatch) {
      const entry = storage.get(storageMatch[1]);
      return entry ? send(200, { success: true, ...entry }) : send(404, { success: false });
    }
    if (req.method !== 'POST' || url.pathname !== '/') return send(404, { error: 'not found' });
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body)?.params?.[0];
    const response = nodeCall(call?.message, call?.data ?? {});
    return response === undefined ? send(200, { result: 400, response: 'unknown method' }) : send(200, { result: 200, response });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    nonceOf: (address) => nonces.get(address.toLowerCase()) ?? 0,
    // The RPC now reports another chain.
    setGenesis: (hash) => {
      genesis = hash;
    },
    seedStorage(address, { data, owner, programName = 'fixture' }) {
      storage.set(address, { data: structuredClone(data), owner: owner.toLowerCase(), programName });
    },
    // Stand-in for a wallet's sign + broadcast of the handed-off payload.
    walletBroadcast(tx) {
      const content = structuredClone(tx.content);
      const from = String(content.from).toLowerCase();
      const current = nonces.get(from) ?? 0;
      if (content.nonce !== current + 1) throw new Error(`stub chain rejected nonce ${content.nonce}; expected ${current + 1}`);
      content.from_ed25519_address = from;
      const hash = createHash('sha256').update(JSON.stringify(content)).digest('hex');
      nonces.set(from, current + 1);
      clock += 5;
      const block = { number: blocks.length, txs: [hash], timestamp: clock };
      blocks.push(block);
      txs.set(hash, { hash, content, blockNumber: block.number });
      return hash;
    },
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

// The real app with the configuration loaded from the environment. This build
// pins no chain identity, so a pin is supplied the way a reviewed source change
// would provide it: in the loaded chain config.
async function startPinnedApp({ genesisHash = GENESIS_A, pin, maxUnpaid = '1' } = {}) {
  const chain = await startPinnedChainStub({ genesisHash });
  const directory = await startDirectoryFixture();
  const dataDir = mkdtempSync(join(tmpdir(), 'dacs-fixed-price-'));
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const loaded = loadConfig({
    DACS_PUBLIC_ORIGIN: origin,
    DACS_ALLOW_INSECURE_LOCALHOST: '1',
    DACS_OAUTH_COOKIE_KEYS: randomBytes(32).toString('hex'),
    DACS_DATA_DIR: dataDir,
    DACS_DIRECTORY_ORIGIN: directory.url,
    DACS_CHAIN_RPC_URL: chain.url,
    DACS_CHAIN_NETWORK: 'demos-testnet',
    DACS_ALLOWED_REDIRECT_ORIGINS: CALLBACK_ORIGIN,
    DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT: maxUnpaid,
    DACS_MAX_UNPAID_PURCHASES_PER_WALLET: maxUnpaid,
  });
  assert.equal(loaded.chain.pinnedIdentity, null, 'this build pins no chain identity');
  const config = pin === undefined ? loaded : Object.freeze({ ...loaded, chain: Object.freeze({ ...loaded.chain, pinnedIdentity: pin }) });
  const created = await createApp({ config, logger: createLogger({ level: 'error', sink: () => {} }) });
  server.on('request', created.app);
  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    chain,
    directory,
    app: created,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await closed;
      await created.close();
      await chain.close();
      await directory.close();
      rmSync(dataDir, { recursive: true });
    },
  };
}

const pinnedCoords = (listingId, s) => ({ listingId, version: 1, seller: s.claim });
const bindingLine = (message, name) => message.split('\n').find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
const purchaseView = (app, p) => portal(app, `/portal/api/purchase/${p.operationId}/view`, { token: tokenFrom(p.approvalUrl) });

test('P1 negative: with no pinned chain identity (this build) a purchase is refused before any approval', async () => {
  const app = await startPinnedApp();
  try {
    const s = createEphemeralWallet();
    seedSellerListing(app, s, { listingId: 'unpinned', price: '2' });
    const buyer = await linkedUser(app);
    const p = await tool(app, buyer, 'prepare_purchase', { ...pinnedCoords('unpinned', s), idempotencyKey: key('unpinned') });
    assert.equal(p.error, 'network_identity_unpinned', JSON.stringify(p));
    assert.deepEqual((await tool(app, buyer, 'get_account_status')).purchases, [], 'no purchase was created');
    assert.equal(app.chain.nonceOf(buyer.wallet.address), 0);
  } finally {
    await app.close();
  }
});

test('P1 negative: an RPC reporting another chain than the pinned one is refused at prepare', async () => {
  const app = await startPinnedApp({ genesisHash: GENESIS_B, pin: GENESIS_A });
  try {
    const s = createEphemeralWallet();
    seedSellerListing(app, s, { listingId: 'wrong-rpc', price: '2' });
    const buyer = await linkedUser(app);
    const p = await tool(app, buyer, 'prepare_purchase', { ...pinnedCoords('wrong-rpc', s), idempotencyKey: key('wrong-rpc') });
    assert.equal(p.error, 'network_identity_mismatch', JSON.stringify(p));
    assert.deepEqual((await tool(app, buyer, 'get_account_status')).purchases, []);
  } finally {
    await app.close();
  }
});

test('accepting control: a correct fixed-price payment on the pinned chain is recorded as a single-RPC, tuple-only observation', async () => {
  const app = await startPinnedApp({ pin: GENESIS_A });
  try {
    const s = createEphemeralWallet();
    seedSellerListing(app, s, { listingId: 'pinned-ok', price: '2' });
    const buyer = await linkedUser(app);
    const p = await tool(app, buyer, 'prepare_purchase', { ...pinnedCoords('pinned-ok', s), idempotencyKey: key('pinned-ok') });
    assert.equal(p.status, 'awaiting_approval', JSON.stringify(p));
    const before = await purchaseView(app, p);
    assert.deepEqual(before.terms.domain, { network: 'demos-testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: GENESIS_A });

    const { challenge, approved, token } = await approvePurchase(app, p.operationId, p.approvalUrl, buyer.wallet);
    // The wallet-signed approval names the bound chain and the purchase commitment.
    assert.equal(bindingLine(challenge.message, 'network-identity'), `genesis ${GENESIS_A}`);
    const commitment = bindingLine(challenge.message, 'commitment');
    assert.match(commitment, HEX64);
    assert.equal(before.evidence.commitment, commitment);
    assert.equal(approved.status, 'payment_handoff');
    assert.deepEqual(approved.payload.content.data, ['native', { nativeOperation: 'send', args: [s.address, '2000000000'] }], 'the transfer itself carries no commitment');

    const hash = app.chain.walletBroadcast(approved.payload);
    const reported = await reportPurchase(app, p.operationId, token, { txHash: hash });
    assert.equal(reported.status, 'settled_verified', JSON.stringify(reported.verification));
    const v = reported.verification;
    assert.equal(v.outcome, 'verified');
    assert.equal(v.chainMode, 'public-chain-read');
    assert.deepEqual(
      [v.observationScope, v.finality, v.attribution, v.fulfillment, v.rpcOrigin],
      ['single-rpc', 'not-established', 'tuple-only', 'not-triggered', new URL(app.chain.url).origin],
    );
    assert.deepEqual(v.purchaseCommitment, { value: commitment, carriedOnChain: false });
    assert.equal(v.domain.chainIdentity, GENESIS_A);
    assert.equal(reported.evidence.receipt.attribution, 'tuple-only');
    assert.equal(reported.evidence.receipt.commitmentOnChain, false);
    assert.equal(reported.evidence.receipt.finality, 'not-established');

    const status = await tool(app, buyer, 'get_purchase_status', { operationId: p.operationId });
    assert.equal(status.status, 'settled_verified');
    for (const phrase of ['not finality', 'not a purchase-specific receipt', 'does not trigger service fulfillment']) {
      assert.ok(status.next.includes(phrase), `status text says: ${phrase}`);
    }
    assert.equal(status.settlement.attribution, 'tuple-only');
    assert.equal(status.settlement.finality, 'not-established');
    const again = await tool(app, buyer, 'verify_deal', { operationId: p.operationId });
    assert.equal(again.status, 'settled_verified');
    assert.equal(again.verification.attribution, 'tuple-only');
  } finally {
    await app.close();
  }
});

test('P1 negative: once bound, an RPC reporting another chain gets no approval, no handoff, no nonce proof and no settlement', async () => {
  const app = await startPinnedApp({ pin: GENESIS_A });
  try {
    const s = createEphemeralWallet();
    seedSellerListing(app, s, { listingId: 'switch', price: '3' });
    const buyer = await linkedUser(app);

    // Before approval: no approval challenge on the other chain.
    const p1 = await tool(app, buyer, 'prepare_purchase', { ...pinnedCoords('switch', s), idempotencyKey: key('switch-1') });
    app.chain.setGenesis(GENESIS_B);
    const refused = await portal(app, `/portal/api/purchase/${p1.operationId}/challenge`, { token: tokenFrom(p1.approvalUrl), address: buyer.wallet.address });
    assert.equal(refused.error, 'network_identity_mismatch');
    assert.equal((await purchaseView(app, p1)).status, 'terms_changed');
    app.chain.setGenesis(GENESIS_A);

    // Between the approval signature and the first handoff: the approval is
    // consumed, but nothing is fenced or handed to the wallet.
    const p3 = await tool(app, buyer, 'prepare_purchase', { ...pinnedCoords('switch', s), idempotencyKey: key('switch-3') });
    const t3 = tokenFrom(p3.approvalUrl);
    const c3 = await portal(app, `/portal/api/purchase/${p3.operationId}/challenge`, { token: t3, address: buyer.wallet.address });
    app.chain.setGenesis(GENESIS_B);
    const a3 = await portal(app, `/portal/api/purchase/${p3.operationId}/approve`, { token: t3, challengeId: c3.challengeId, signature: buyer.wallet.signHex(c3.message) });
    assert.equal(a3.status, 'terms_changed');
    assert.equal(a3.payload, null);
    assert.equal(app.app.services.coordinates.get(p3.operationId), null, 'no nonce fence or payload was saved');
    app.chain.setGenesis(GENESIS_A);

    // After the handoff: nothing re-issued, no nonce proof, no settlement.
    const p2 = await tool(app, buyer, 'prepare_purchase', { ...pinnedCoords('switch', s), idempotencyKey: key('switch-2') });
    const { approved, token } = await approvePurchase(app, p2.operationId, p2.approvalUrl, buyer.wallet);
    assert.equal(approved.status, 'payment_handoff');
    app.chain.setGenesis(GENESIS_B);
    const reissue = await portal(app, `/portal/api/purchase/${p2.operationId}/handoff`, { token });
    assert.equal(reissue.payload, null);
    assert.equal(reissue.status, 'payment_handoff', 'kept open: the old payload may still land');
    const check = await tool(app, buyer, 'verify_deal', { operationId: p2.operationId });
    assert.equal(check.verification.outcome, 'network_identity_mismatch');
    assert.equal(check.status, 'payment_handoff');
    assert.equal((await tool(app, buyer, 'cancel_wallet_handoff', { operationId: p2.operationId })).error, 'network_identity_mismatch', 'no cancel on another chain\'s nonce');
    const hash = app.chain.walletBroadcast(approved.payload); // the old payload lands anyway
    const reported = await reportPurchase(app, p2.operationId, token, { txHash: hash });
    assert.equal(reported.verification.outcome, 'network_identity_mismatch');
    assert.notEqual(reported.status, 'settled_verified');

    // Back on the bound chain the same transfer is observed (tuple-only).
    app.chain.setGenesis(GENESIS_A);
    const settled = await tool(app, buyer, 'verify_deal', { operationId: p2.operationId });
    assert.equal(settled.status, 'settled_verified');
    assert.equal(settled.verification.attribution, 'tuple-only');
  } finally {
    await app.close();
  }
});

test('P3 negative (wrong purchase commitment): the commitment is purchase-specific in the approval, and a transfer claiming one is never accepted', async () => {
  const app = await startPinnedApp({ pin: GENESIS_A, maxUnpaid: '2' });
  try {
    const s = createEphemeralWallet();
    seedSellerListing(app, s, { listingId: 'commit', price: '2' });
    const buyer = await linkedUser(app);
    const a = await tool(app, buyer, 'prepare_purchase', { ...pinnedCoords('commit', s), idempotencyKey: key('commit-a') });
    const b = await tool(app, buyer, 'prepare_purchase', { ...pinnedCoords('commit', s), idempotencyKey: key('commit-b') });
    const ta = tokenFrom(a.approvalUrl);
    const tb = tokenFrom(b.approvalUrl);
    const ca = await portal(app, `/portal/api/purchase/${a.operationId}/challenge`, { token: ta, address: buyer.wallet.address });
    const cb = await portal(app, `/portal/api/purchase/${b.operationId}/challenge`, { token: tb, address: buyer.wallet.address });
    const commitmentA = bindingLine(ca.message, 'commitment');
    const commitmentB = bindingLine(cb.message, 'commitment');
    assert.match(commitmentA, HEX64);
    assert.notEqual(commitmentA, commitmentB, 'same buyer, seller, listing and price: still a different commitment');
    // A's signed approval (commitment A) cannot approve B.
    const crossed = await portal(app, `/portal/api/purchase/${b.operationId}/approve`, { token: tb, challengeId: ca.challengeId, signature: buyer.wallet.signHex(ca.message) });
    assert.equal(crossed.error, 'binding_mismatch');
    const approved = await portal(app, `/portal/api/purchase/${b.operationId}/approve`, { token: tb, challengeId: cb.challengeId, signature: buyer.wallet.signHex(cb.message) });
    assert.equal(approved.status, 'payment_handoff');

    // A transfer carrying B's own commitment in its bytes (an extra native arg,
    // which no Demos or DACS contract defines) is not settlement.
    const claimed = structuredClone(approved.payload);
    claimed.content.data[1].args.push(commitmentB);
    const hash = app.chain.walletBroadcast(claimed);
    const reported = await reportPurchase(app, b.operationId, tb, { txHash: hash });
    assert.equal(reported.verification.outcome, 'invalid_observation');
    assert.equal(reported.status, 'payment_uncertain');
  } finally {
    await app.close();
  }
});

test('simulated fixture purchases are bound to the simulated domain and recorded as single-RPC, tuple-only fixture evidence', async () => {
  const fern = await linkedUser(h);
  const p = await tool(h, fern, 'prepare_purchase', { ...coords(), idempotencyKey: key('sim-domain') });
  const { challenge, approved, token } = await approvePurchase(h, p.operationId, p.approvalUrl, fern.wallet);
  assert.equal(bindingLine(challenge.message, 'network-identity'), 'SIMULATED fixture (no real chain identity)');
  const hash = h.chain.walletBroadcast(approved.payload);
  const reported = await reportPurchase(h, p.operationId, token, { txHash: hash });
  assert.equal(reported.status, 'settled_verified');
  assert.deepEqual(reported.terms.domain, { network: 'demos-testnet', rail: 'demos-native:DEM', mode: 'simulated-fixture', chainIdentity: null });
  assert.equal(reported.verification.attribution, 'tuple-only');
  assert.equal(reported.verification.finality, 'not-established');
  assert.match((await tool(h, fern, 'get_purchase_status', { operationId: p.operationId })).next, /SIMULATED fixture chain .*not finality, not a purchase-specific receipt, no service fulfillment/);
  // The text the model reads from verify_deal carries the same limits.
  const raw = await toolRaw(h, fern, 'verify_deal', { operationId: p.operationId });
  assert.match(raw.content[0].text, /^Purchase pur_[\w-]+: settled_verified \(verified\)\. A SIMULATED fixture chain .*not finality, not a purchase-specific receipt, no service fulfillment/);
});

// Compatibility: a purchase stored before network binding (no terms.domain)
// is never approved, re-handed off, cancelled on a nonce read or settled; it
// stays open for an operator rather than guessing its network.
test('a purchase stored without a bound network domain gets no approval, handoff, nonce proof or settlement', async () => {
  const vic = await linkedUser(h);
  const unbind = (id) => h.app.db.prepare("UPDATE operations SET terms = json_remove(terms, '$.domain') WHERE id = ?").run(id);

  const a = await tool(h, vic, 'prepare_purchase', { ...coords(), idempotencyKey: key('legacy-a') });
  unbind(a.operationId);
  const refused = await portal(h, `/portal/api/purchase/${a.operationId}/challenge`, { token: tokenFrom(a.approvalUrl), address: vic.wallet.address });
  assert.equal(refused.error, 'network_identity_mismatch');
  assert.equal((await tool(h, vic, 'get_purchase_status', { operationId: a.operationId })).status, 'terms_changed');

  const b = await tool(h, vic, 'prepare_purchase', { ...coords(), idempotencyKey: key('legacy-b') });
  const { approved, token } = await approvePurchase(h, b.operationId, b.approvalUrl, vic.wallet);
  assert.equal(approved.status, 'payment_handoff');
  unbind(b.operationId);
  const reissue = await portal(h, `/portal/api/purchase/${b.operationId}/handoff`, { token });
  assert.equal(reissue.payload, null);
  assert.equal(reissue.status, 'payment_handoff');
  assert.equal((await tool(h, vic, 'verify_deal', { operationId: b.operationId })).verification.outcome, 'network_identity_mismatch');
  assert.equal((await tool(h, vic, 'cancel_wallet_handoff', { operationId: b.operationId })).error, 'network_identity_mismatch');
  const hash = h.chain.walletBroadcast(approved.payload);
  const reported = await reportPurchase(h, b.operationId, token, { txHash: hash });
  assert.equal(reported.verification.outcome, 'network_identity_mismatch');
  assert.equal(reported.status, 'broadcast_reported', 'kept open and blocking, never settled');
  assert.equal((await tool(h, vic, 'prepare_purchase', { ...coords('other-report'), idempotencyKey: key('legacy-c') })).error, 'unresolved_payment');
});

// ---------------------------------------------------------------------------
// a review P2: an embedded-wallet native DEM send shows its complete debit
// before approval and is confirmed and broadcast only if the signed
// transaction and the node's confirmation carry exactly that. Signing by the
// REAL bundled Demos SDK (public/portal/embedded-wallet/demos-runtime.mjs) in
// Node with the minimal browser globals test/embedded-wallet-contract.test.mjs
// uses (set only here, after the server tests above); the real plugin server
// and relay; the SIMULATED SDK-wire chain with network fee 1. Demos subclasses
// stand in for an SDK or a node that changes what moves funds.
// ---------------------------------------------------------------------------
async function paymentRig({ networkFee = 1 } = {}) {
  globalThis.window ??= globalThis;
  globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
  globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
  const [runtime, sdk, { startSdkChainFixture }] = await Promise.all([
    import('../public/portal/embedded-wallet/demos-runtime.mjs'),
    import('../public/portal/embedded-wallet/sdk-provider.mjs'),
    import('./helpers/embedded-wallet-transaction-chain.mjs'),
  ]);
  const chain = await startSdkChainFixture({ networkFee, rpcFee: 0 });
  const rig = await startHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  const profile = await portal(rig, '/portal/api/embedded-wallet/profile');
  const transactionTransport = { profile: profile.writes, rpcUrl: profile.rpcUrl, network: profile.network };
  async function wallet({ DemosCtor = runtime.Demos, mnemonic } = {}) {
    const asked = [];
    const session = sdk.createSdkWalletSession({
      DemosCtor,
      IdentitiesCtor: runtime.Identities,
      validateMnemonic: runtime.validateMnemonic,
      transactionTransport,
      approve: async (request) => {
        asked.push(structuredClone(request));
        return true;
      },
    });
    const account = mnemonic ? await session.importMnemonic(mnemonic) : await session.create();
    return { session, address: account.address, asked };
  }
  // A linked embedded buyer with one approved purchase handed off for `price` DEM.
  async function purchase(price) {
    const user = await linkedUser(rig);
    const buyer = await wallet();
    const link = new URL((await tool(rig, user, 'start_wallet_link')).linkUrl);
    const f = new URLSearchParams(link.hash.slice(1));
    const body = { accountId: f.get('a'), expires: Number(f.get('e')), nonce: f.get('n'), token: f.get('t') };
    const lc = await portal(rig, '/portal/api/link/challenge', { ...body, address: buyer.address });
    const ls = await buyer.session.request({ method: 'sign', params: [lc.message] });
    assert.equal((await portal(rig, '/portal/api/link/complete', { ...body, challengeId: lc.challengeId, signature: ls.data.signature })).address, buyer.address);
    const s = createEphemeralWallet();
    const listingId = key('p2');
    seedSellerListing(rig, s, { listingId, price });
    const p = await tool(rig, user, 'prepare_purchase', { ...pinnedCoords(listingId, s), idempotencyKey: key('p2-buy'), walletAddress: buyer.address });
    const token = tokenFrom(p.approvalUrl);
    const c = await portal(rig, `/portal/api/purchase/${p.operationId}/challenge`, { token, address: buyer.address });
    const signed = await buyer.session.request({ method: 'sign', params: [c.message] });
    const approved = await portal(rig, `/portal/api/purchase/${p.operationId}/approve`, { token, challengeId: c.challengeId, signature: signed.data.signature });
    assert.equal(approved.status, 'payment_handoff', JSON.stringify(approved));
    return { user, buyer, seller: s, p, token, payload: approved.payload, mnemonic: buyer.session.exportMnemonicForUser() };
  }
  const executes = (from) => chain.calls.slice(from).filter((c) => c.startsWith('execute:'));
  const signTampering = (mutate) => class extends runtime.Demos {
    async sign(tx, options) {
      const signedTx = await super.sign(tx, options);
      if (signedTx?.content?.type === 'native') mutate(signedTx.content);
      return signedTx;
    }
  };
  const confirmTampering = (mutate) => class extends runtime.Demos {
    async confirm(tx) {
      const validity = await super.confirm(tx);
      mutate(validity.response.data);
      return validity;
    }
  };
  return { h: rig, chain, wallet, purchase, executes, signTampering, confirmTampering };
}

test('P2 accepting control: the embedded approval shows the complete debit and the real SDK signs exactly the four expected edits', async () => {
  const rig = await paymentRig();
  try {
    const buy = await rig.purchase('2');
    const mark = rig.chain.calls.length;
    const asked = buy.buyer.asked.length;
    const res = await buy.buyer.session.request({ method: 'sendTransaction', params: [buy.payload] });
    assert.equal(res.success, true, JSON.stringify(res.error));
    const approval = buy.buyer.asked.slice(asked);
    assert.equal(approval.length, 1, 'one approval');
    const { note, ...debit } = approval[0].content.debit;
    assert.deepEqual(debit, { sellerAmountDem: '2', sdkGasDem: '1', networkFeeDem: '1', rpcFeeDem: '0', additionalFeeDem: '0', totalDem: '4', totalOs: '4000000000' });
    assert.match(note, /seller amount, the SDK gas edit and the node fees/);
    assert.match(approval[0].purpose, /Total debit 4 DEM/);
    assert.deepEqual(rig.executes(mark), ['execute:confirmTx', 'execute:broadcastTx'], 'one confirm, one broadcast');

    const onChain = rig.chain.txs.get(res.data.hash).content;
    const from = buy.buyer.address;
    assert.deepEqual(onChain.gcr_edits.map((e) => [e.type, e.operation, e.account, e.amount, e.isRollback]), [
      ['balance', 'remove', from, '2000000000', false],
      ['balance', 'add', buy.seller.address, '2000000000', false],
      ['balance', 'remove', from, '1000000000', false],
      ['nonce', 'add', from, 1, false],
    ]);
    assert.deepEqual(onChain.transaction_fee, { network_fee: '1000000000', rpc_fee: '0', additional_fee: '0', rpc_address: null });

    const reported = await portal(rig.h, `/portal/api/purchase/${buy.p.operationId}/report`, { token: buy.token, txHash: res.data.hash });
    assert.equal(reported.status, 'settled_verified', JSON.stringify(reported.verification));
    assert.equal(reported.verification.chainMode, 'simulated-fixture');
    assert.equal(reported.verification.attribution, 'tuple-only');
    assert.equal(reported.verification.observationScope, 'single-rpc');
    buy.buyer.session.lock();
  } finally {
    await rig.h.close();
  }
});

test('P2 negative (extra SDK debit): a signed transaction with any other balance change or fee is never confirmed or broadcast', async () => {
  const rig = await paymentRig();
  try {
    const buy = await rig.purchase('2');
    const cases = [
      ['an extra SDK balance debit', (c) => c.gcr_edits.splice(2, 0, { type: 'balance', operation: 'remove', isRollback: false, account: c.from_ed25519_address, txhash: '', amount: '5000000000' })],
      ['a larger gas debit', (c) => { c.gcr_edits[2].amount = '2000000000'; }],
      ['a credit to another account', (c) => { c.gcr_edits[1].account = `0x${'3'.repeat(64)}`; }],
      ['a dropped nonce edit', (c) => { c.gcr_edits.pop(); }],
      ['a non-zero additional fee', (c) => { c.transaction_fee.additional_fee = '1000000000'; }],
      ['a network fee other than shown', (c) => { c.transaction_fee.network_fee = '2000000000'; }],
      ['an rpc address set before confirmation', (c) => { c.transaction_fee.rpc_address = `0x${'4'.repeat(64)}`; }],
      ['custom charges', (c) => { c.custom_charges = { amount: '1' }; }],
    ];
    for (const [label, mutate] of cases) {
      const tampered = await rig.wallet({ DemosCtor: rig.signTampering(mutate), mnemonic: buy.mnemonic });
      assert.equal(tampered.address, buy.buyer.address);
      const mark = rig.chain.calls.length;
      const res = await tampered.session.request({ method: 'sendTransaction', params: [buy.payload] });
      assert.equal(res.error?.code, 'payload_mismatch', `${label}: ${JSON.stringify(res)}`);
      assert.deepEqual(rig.executes(mark), [], `${label}: no confirm and no broadcast`);
      tampered.session.lock();
    }
    assert.equal(rig.chain.nonceOf(buy.buyer.address), 0, 'nothing reached the chain');
    assert.equal((await tool(rig.h, buy.user, 'verify_deal', { operationId: buy.p.operationId })).verification.outcome, 'not_broadcast');
    buy.buyer.session.lock();
  } finally {
    await rig.h.close();
  }
});

test('P2 negative: a node confirmation that adds a debit or another fee is never broadcast', async () => {
  const rig = await paymentRig();
  try {
    const buy = await rig.purchase('2');
    const cases = [
      ['an extra debit in the confirmed edits', (d) => d.transaction.content.gcr_edits.push({ type: 'balance', operation: 'remove', isRollback: false, account: d.transaction.content.from_ed25519_address, txhash: '', amount: '1000000000' })],
      ['a higher node fee view', (d) => { d.gas_operation = { fees: { network_fee: '2000000000', rpc_fee: '0', additional_fee: '0' } }; }],
      ['custom charges in the confirmation', (d) => { d.custom_charges = { amount: '1000000000' }; }],
      ['a confirmed additional fee', (d) => { d.transaction.content.transaction_fee.additional_fee = '1000000000'; }],
      ['a malformed rpc address', (d) => { d.transaction.content.transaction_fee.rpc_address = 'node'; }],
    ];
    for (const [label, mutate] of cases) {
      const tampered = await rig.wallet({ DemosCtor: rig.confirmTampering(mutate), mnemonic: buy.mnemonic });
      const mark = rig.chain.calls.length;
      const res = await tampered.session.request({ method: 'sendTransaction', params: [buy.payload] });
      assert.equal(res.error?.code, 'confirm_rejected', `${label}: ${JSON.stringify(res)}`);
      assert.deepEqual(rig.executes(mark), ['execute:confirmTx'], `${label}: validated, never broadcast`);
      tampered.session.lock();
    }
    // A post-fork node fills transaction_fee.rpc_address with its own key while
    // confirming (SDK 4.0.16 TxFee): the wallet's check accepts that one field
    // and broadcasts once. This stand-in node does not model node-filled
    // fields, so it refuses the altered copy and nothing is applied.
    const filled = await rig.wallet({ DemosCtor: rig.confirmTampering((d) => { d.transaction.content.transaction_fee.rpc_address = `0x${'ab'.repeat(32)}`; }), mnemonic: buy.mnemonic });
    let mark = rig.chain.calls.length;
    const passed = await filled.session.request({ method: 'sendTransaction', params: [buy.payload] });
    assert.equal(passed.error?.code, 'broadcast_rejected', JSON.stringify(passed));
    assert.deepEqual(rig.executes(mark), ['execute:confirmTx', 'execute:broadcastTx']);
    filled.session.lock();
    assert.equal(rig.chain.nonceOf(buy.buyer.address), 0);
    // The untampered send still goes through once and settles (tuple-only).
    mark = rig.chain.calls.length;
    const res = await buy.buyer.session.request({ method: 'sendTransaction', params: [buy.payload] });
    assert.equal(res.success, true, JSON.stringify(res.error));
    assert.deepEqual(rig.executes(mark), ['execute:confirmTx', 'execute:broadcastTx']);
    assert.equal((await portal(rig.h, `/portal/api/purchase/${buy.p.operationId}/report`, { token: buy.token, txHash: res.data.hash })).status, 'settled_verified');
    buy.buyer.session.lock();
  } finally {
    await rig.h.close();
  }
});

test('P2 negative: a node fee the wallet cannot show exactly is refused before any approval', async () => {
  const rig = await paymentRig({ networkFee: 0.5 });
  try {
    const buy = await rig.purchase('2');
    const asked = buy.buyer.asked.length;
    const mark = rig.chain.calls.length;
    const res = await buy.buyer.session.request({ method: 'sendTransaction', params: [buy.payload] });
    assert.equal(res.error?.code, 'unsupported', JSON.stringify(res));
    assert.equal(buy.buyer.asked.length, asked, 'no approval was requested');
    assert.deepEqual(rig.executes(mark), []);
    buy.buyer.session.lock();
  } finally {
    await rig.h.close();
  }
});

// Isolated store/service interleavings: no portal, signer or chain write.
function nonceRaceWorld(t, { aStatus = 'cancelled' } = {}) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const accountId = 'TEST-nonce-race', wallet = `0x${'e'.repeat(64)}`, payee = `0x${'7'.repeat(64)}`;
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(accountId, 'TEST', accountId, new Date().toISOString());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-only-nonce-race-secret-000000000000' }), coordinates = createCoordinateStore({ db });
  const domain = { network: 'demos-testnet', rail: 'demos-native:DEM', mode: 'simulated-fixture', chainIdentity: null };
  const terms = { buyer: { wallet }, seller: { payee, claim: 'TEST-seller' }, price: { amountOs: '2500000000' }, listing: { listingId: 'TEST-listing', version: 1, contentHash: 'ab'.repeat(32) }, network: domain.network, rail: domain.rail, domain };
  const create = (key, status, kind = 'purchase', opTerms = terms, state = {}) => ops.createIdempotent({ accountId, kind, idempotencyKey: key, request: { key }, status, terms: opTerms, termsHash: 'cd'.repeat(32), state, expiresAt: new Date(Date.now() + 60000).toISOString() });
  const hash = 'ef'.repeat(32), a = create('TEST-cancelled-A', aStatus).operation;
  coordinates.save({ operationId: a.id, kind: 'dem-transfer', network: domain.network, from: wallet, nonceFence: 6, expectedNonce: 7, target: payee, amountOs: terms.price.amountOs, payload: {} });
  coordinates.reportHash(a.id, hash);
  const chain = { network: domain.network, evidenceMode: domain.mode, networkIdentity: async () => ({ mode: domain.mode }), getAddressNonce: async () => 6,
    observeTransfer: async () => ({ status: 'included', txHash: hash, blockNumber: 10, payer: wallet, payee, amountOs: terms.price.amountOs }),
    getTransaction: async () => ({ hash, status: 'confirmed', blockNumber: 10, content: { from: wallet, nonce: 7 } }), readStorageProgram: async () => ({ status: 'absent' }) };
  const verifier = { verify: async () => ({ transactable: true, contentHash: terms.listing.contentHash, price: terms.price, payee, evidence: { chainMode: domain.mode } }) };
  const purchases = createPurchaseService({ db, config: { demAmountEncoding: 'os-string' }, ops, coordinates, chain, verifier });
  const agents = createAgentService({ db, config: {}, ops, coordinates, chain });
  const verify = () => purchases.verifyDeal({ accountId, operationId: a.id });
  return { db, ops, coordinates, accountId, wallet, terms, chain, create, purchases, agents, a, verify };
}

for (const kind of ['purchase', 'publication']) {
  test(`nonce reservation races late settlement: ${kind}`, async t => {
    const w = nonceRaceWorld(t);
    const listing = { listingId: 'TEST-listing', listingVersion: 1, seller: { identity: { presentedBy: `did:demos:agent:${w.wallet.slice(2)}` } } };
    const b = kind === 'purchase' ? w.create('TEST-replacement', 'approved')
      : w.create('TEST-publication', 'listing_signed', 'listing_publication', { wallet: w.wallet, network: w.terms.network }, { signedListing: listing });
    let read, resume;
    const started = new Promise(resolve => { read = resolve; }), held = new Promise(resolve => { resume = resolve; });
    w.chain.getAddressNonce = async () => { read(); await held; return 6; };
    const handoff = (kind === 'purchase' ? w.purchases : w.agents).prepareHandoff;
    const args = { operationId: b.operation.id, token: b.handoffToken };
    const saving = handoff(args);
    try {
      await started;
      assert.equal((await w.verify()).operation.status, 'settled_verified');
      resume();
      await assert.rejects(saving, { code: 'nonce_readback_unavailable' });
      assert.equal(w.coordinates.get(b.operation.id), null, 'a consumed reservation never leaves the transaction');
      assert.equal(w.ops.get(w.accountId, b.operation.id).status, kind === 'purchase' ? 'approved' : 'listing_signed');
      w.chain.getAddressNonce = async () => 7;
      const retried = await handoff(args);
      assert.equal(retried.operation.status, kind === 'purchase' ? 'payment_handoff' : 'publication_handoff');
      assert.equal(w.coordinates.get(b.operation.id).expectedNonce, 8);
    } finally { resume(); await Promise.allSettled([saving]); }
  });
}

// Explicit proof the wallet's own nonce was used needs a slot-consuming body the
// wallet itself signed; an alternate signing key may leave that nonce free.
const ALT_SIGNER = `0x${'a'.repeat(64)}`;
const handoffFor = (w, kind) => {
  const listing = { listingId: 'TEST-listing', listingVersion: 1, seller: { identity: { presentedBy: `did:demos:agent:${w.wallet.slice(2)}` } } };
  const b = kind === 'purchase' ? w.create('TEST-replacement', 'approved')
    : w.create('TEST-publication', 'listing_signed', 'listing_publication', { wallet: w.wallet, network: w.terms.network }, { signedListing: listing });
  return { b, run: () => (kind === 'purchase' ? w.purchases : w.agents).prepareHandoff({ operationId: b.operation.id, token: b.handoffToken }) };
};

for (const kind of ['purchase', 'publication']) {
  test(`an alternate-signer settlement at the next nonce does not refuse a new ${kind} handoff`, async t => {
    const w = nonceRaceWorld(t);
    const getTransaction = w.chain.getTransaction;
    w.chain.getTransaction = async (txHash) => { const body = await getTransaction(txHash); body.content = { ...body.content, from: ALT_SIGNER, from_ed25519_address: w.wallet }; return body; };
    const settled = await w.verify();
    assert.equal(settled.operation.status, 'settled_verified'); assert.equal(settled.verification.signedByAlternateKey, true);
    // The node counted A's nonce against ALT_SIGNER: the wallet's nonce is still 6.
    const { b, run } = handoffFor(w, kind);
    const issued = await run();
    assert.equal(issued.operation.status, kind === 'purchase' ? 'payment_handoff' : 'publication_handoff');
    assert.equal(w.coordinates.get(b.operation.id).expectedNonce, 7);
    assert.equal(w.ops.history(b.operation.id).some(event => event.type === 'handoff_refused'), false);
  });
}

for (const [signer, refused] of [['wallet', true], ['alternate key', false]]) {
  for (const kind of ['purchase', 'publication']) {
    test(`a confirmed ${signer}-signed payment_mismatch racing a ${kind} handoff ${refused ? 'refuses' : 'does not refuse'} it`, async t => {
      const w = nonceRaceWorld(t, { aStatus: 'payment_uncertain' });
      const observeTransfer = w.chain.observeTransfer, getTransaction = w.chain.getTransaction;
      w.chain.observeTransfer = async () => ({ ...await observeTransfer(), amountOs: '1' });
      if (signer !== 'wallet') w.chain.getTransaction = async (txHash) => { const body = await getTransaction(txHash); body.content = { ...body.content, from: ALT_SIGNER, from_ed25519_address: w.wallet }; return body; };
      const { b, run } = handoffFor(w, kind);
      let read, resume;
      const started = new Promise(resolve => { read = resolve; }), held = new Promise(resolve => { resume = resolve; });
      w.chain.getAddressNonce = async () => { read(); await held; return 6; };
      const saving = run();
      try {
        await started;
        const mismatch = await w.verify();
        assert.equal(mismatch.operation.status, 'payment_mismatch', JSON.stringify(mismatch.verification));
        assert.equal(mismatch.verification.slotConsumed, true); assert.equal(w.coordinates.get(w.a.id).verifiedAt, null);
        assert.equal(w.coordinates.get(w.a.id).observation.signedByAlternateKey, refused ? undefined : true);
        resume();
        if (refused) {
          await assert.rejects(saving, { code: 'nonce_readback_unavailable' });
          assert.equal(w.coordinates.get(b.operation.id), null, 'a consumed reservation never leaves the transaction');
          assert.equal(w.ops.get(w.accountId, b.operation.id).status, kind === 'purchase' ? 'approved' : 'listing_signed');
          w.chain.getAddressNonce = async () => 7;
          const retried = await run();
          assert.equal(retried.operation.status, kind === 'purchase' ? 'payment_handoff' : 'publication_handoff');
          assert.equal(w.coordinates.get(b.operation.id).expectedNonce, 8);
        } else {
          const issued = await saving;
          assert.equal(issued.operation.status, kind === 'purchase' ? 'payment_handoff' : 'publication_handoff');
          assert.equal(w.coordinates.get(b.operation.id).expectedNonce, 7);
        }
      } finally { resume(); await Promise.allSettled([saving]); }
    });
  }
}

// Recorded wallet-signed slot consumption (with its durable record, the guard's
// evidence): a later transient re-read of the same hash, or a status that stays
// cancelled, keeps it.
const mismatchedReads = (w, signer) => {
  const observeTransfer = w.chain.observeTransfer, getTransaction = w.chain.getTransaction;
  w.chain.observeTransfer = async () => ({ ...await observeTransfer(), amountOs: '1' });
  if (signer !== 'wallet') w.chain.getTransaction = async (txHash) => { const body = await getTransaction(txHash); body.content = { ...body.content, from: ALT_SIGNER, from_ed25519_address: w.wallet }; return body; };
};
const TRANSIENT_READS = {
  'chain-unavailable': (w) => { w.chain.observeTransfer = async () => { throw new Error('TEST-rpc-unavailable'); }; },
  'pending-body': (w) => { const getTransaction = w.chain.getTransaction; w.chain.getTransaction = async (txHash) => ({ ...await getTransaction(txHash), status: 'pending' }); },
  'failed-body': (w) => { const getTransaction = w.chain.getTransaction; w.chain.getTransaction = async (txHash) => ({ ...await getTransaction(txHash), status: 'failed' }); },
};
const racingHandoff = (w, kind) => {
  const { b, run } = handoffFor(w, kind);
  let read, resume;
  const started = new Promise(resolve => { read = resolve; }), held = new Promise(resolve => { resume = resolve; });
  w.chain.getAddressNonce = async () => { read(); await held; return 6; };
  return { b, run, started, resume, saving: run() };
};

for (const transient of Object.keys(TRANSIENT_READS)) {
  for (const kind of ['purchase', 'publication']) {
    test(`a ${transient} re-read after a confirmed wallet-signed payment_mismatch racing a ${kind} handoff still refuses it`, async t => {
      const w = nonceRaceWorld(t, { aStatus: 'payment_uncertain' });
      mismatchedReads(w, 'wallet');
      const race = racingHandoff(w, kind);
      try {
        await race.started;
        assert.equal((await w.verify()).operation.status, 'payment_mismatch');
        TRANSIENT_READS[transient](w);
        const reread = await w.verify();
        assert.equal(reread.operation.status, 'payment_mismatch'); assert.equal(reread.verification.slotConsumed, false);
        race.resume();
        await assert.rejects(race.saving, { code: 'nonce_readback_unavailable' });
        assert.equal(w.coordinates.get(race.b.operation.id), null, 'a consumed reservation never leaves the transaction');
        assert.equal(w.ops.get(w.accountId, race.b.operation.id).status, kind === 'purchase' ? 'approved' : 'listing_signed');
      } finally { race.resume(); await Promise.allSettled([race.saving]); }
    });
  }
}

for (const transient of Object.keys(TRANSIENT_READS)) {
  for (const signer of ['wallet', 'alternate key']) {
    test(`a ${transient} re-read of the same hash keeps the recorded ${signer}-signed slot consumption`, async t => {
      const w = nonceRaceWorld(t, { aStatus: 'payment_uncertain' });
      mismatchedReads(w, signer);
      assert.equal((await w.verify()).operation.status, 'payment_mismatch');
      const recorded = w.coordinates.get(w.a.id).observation;
      assert.equal(recorded.slotConsumed, true); assert.equal(recorded.signedByAlternateKey, signer === 'wallet' ? undefined : true);
      TRANSIENT_READS[transient](w);
      const reread = await w.verify();
      const saved = w.coordinates.get(w.a.id);
      assert.equal(saved.verifiedAt, null); assert.equal(saved.observation.txHash, recorded.txHash);
      assert.equal(saved.observation.slotConsumed, true, 'a transient re-read never erases the recorded slot consumption');
      assert.equal(saved.observation.signedByAlternateKey, recorded.signedByAlternateKey);
      // Everything else is this re-read's own observation.
      assert.deepEqual(saved.observation.observation, reread.verification.observation);
      assert.equal(saved.observation.txStatus, reread.verification.txStatus); assert.equal(saved.observation.observedAt, reread.verification.observedAt);
    });
  }
}

test('a re-read that records a different hash never inherits the recorded slot consumption', async t => {
  const w = nonceRaceWorld(t);
  mismatchedReads(w, 'alternate key');
  const hash = w.coordinates.get(w.a.id).reportedTxHash, other = '12'.repeat(32);
  assert.equal((await w.verify()).operation.status, 'cancelled');
  assert.equal(w.coordinates.get(w.a.id).observation.slotConsumed, true);
  w.coordinates.clearRejectedPointer(w.a.id, hash);
  TRANSIENT_READS['chain-unavailable'](w);
  const reread = await w.purchases.verifyDeal({ accountId: w.accountId, operationId: w.a.id, txHash: other });
  assert.equal(reread.verification.outcome, 'chain_unavailable');
  const saved = w.coordinates.get(w.a.id);
  assert.equal(saved.reportedTxHash, other); assert.equal(saved.observation.txHash, other);
  assert.equal(saved.observation.slotConsumed, false); assert.equal(saved.observation.signedByAlternateKey, undefined);
  assert.equal(Object.hasOwn(saved.observation, 'slotConsumedCarried'), false);
});

// A pointer whose observation records slot consumption (fresh or carried) is
// never replaced or detached, so another hash's read cannot erase it.
const assertConsumptionKept = (w, hash) => {
  const saved = w.coordinates.get(w.a.id);
  assert.equal(saved.reportedTxHash, hash, 'the consumed pointer is kept');
  assert.equal(saved.observation.txHash, hash); assert.equal(saved.observation.slotConsumed, true);
  assert.equal(w.ops.history(w.a.id).some(event => event.type === 'reported_hash_replaced'), false);
};
const correctPointer = (w, txHash) => w.purchases.verifyDeal({ accountId: w.accountId, operationId: w.a.id, txHash });
const POINTER_KEEPING_READS = {
  'failed-observation': (w) => { w.chain.observeTransfer = async () => ({ status: 'failed', txHash: w.coordinates.get(w.a.id).reportedTxHash, reason: 'TEST-reverted' }); },
  'pointer-rejected': (w) => { const getTransaction = w.chain.getTransaction; w.chain.getTransaction = async (txHash) => { const body = await getTransaction(txHash); body.content = { ...body.content, nonce: 8 }; return body; }; },
};

test('a pointer correction after a transient re-read of a consumed slot is refused', async t => {
  const w = nonceRaceWorld(t);
  mismatchedReads(w, 'wallet');
  const hash = w.coordinates.get(w.a.id).reportedTxHash, other = '12'.repeat(32);
  assert.equal((await w.verify()).operation.status, 'cancelled');
  await assert.rejects(correctPointer(w, other), { code: 'hash_conflict' });
  TRANSIENT_READS['chain-unavailable'](w);
  await w.verify();
  assert.equal(w.coordinates.get(w.a.id).observation.slotConsumedCarried, true);
  await assert.rejects(correctPointer(w, other), { code: 'hash_conflict' });
  assertConsumptionKept(w, hash);
});

for (const kind of ['purchase', 'publication']) {
  test(`a refused pointer correction after a transient re-read of a consumed slot racing a ${kind} handoff still refuses it`, async t => {
    const w = nonceRaceWorld(t);
    mismatchedReads(w, 'wallet');
    const hash = w.coordinates.get(w.a.id).reportedTxHash, other = '12'.repeat(32);
    const race = racingHandoff(w, kind);
    try {
      await race.started;
      assert.equal((await w.verify()).verification.slotConsumed, true);
      await assert.rejects(correctPointer(w, other), { code: 'hash_conflict' });
      TRANSIENT_READS['chain-unavailable'](w);
      await w.verify();
      await assert.rejects(correctPointer(w, other), { code: 'hash_conflict' });
      assertConsumptionKept(w, hash);
      race.resume();
      await assert.rejects(race.saving, { code: 'nonce_readback_unavailable' });
      assert.equal(w.coordinates.get(race.b.operation.id), null, 'a consumed reservation never leaves the transaction');
      assert.equal(w.ops.get(w.accountId, race.b.operation.id).status, kind === 'purchase' ? 'approved' : 'listing_signed');
    } finally { race.resume(); await Promise.allSettled([race.saving]); }
  });
}

for (const route of Object.keys(POINTER_KEEPING_READS)) {
  for (const kind of ['purchase', 'publication']) {
    test(`a ${route} re-read of a consumed slot keeps its pointer and a racing ${kind} handoff still refuses`, async t => {
      const w = nonceRaceWorld(t);
      mismatchedReads(w, 'wallet');
      const hash = w.coordinates.get(w.a.id).reportedTxHash, other = '12'.repeat(32);
      const race = racingHandoff(w, kind);
      try {
        await race.started;
        assert.equal((await w.verify()).verification.slotConsumed, true);
        POINTER_KEEPING_READS[route](w);
        const reread = await w.verify();
        assert.equal(reread.operation.status, 'cancelled');
        assert.equal(reread.verification.outcome, route === 'failed-observation' ? 'failed_unconfirmed' : 'pointer_rejected');
        assertConsumptionKept(w, hash);
        assert.equal(w.coordinates.get(w.a.id).observation.slotConsumedCarried, true);
        TRANSIENT_READS['chain-unavailable'](w);
        await assert.rejects(correctPointer(w, other), { code: 'hash_conflict' });
        assertConsumptionKept(w, hash);
        race.resume();
        await assert.rejects(race.saving, { code: 'nonce_readback_unavailable' });
        assert.equal(w.coordinates.get(race.b.operation.id), null, 'a consumed reservation never leaves the transaction');
      } finally { race.resume(); await Promise.allSettled([race.saving]); }
    });
  }
}

test('a reported hash with no recorded slot consumption can still be corrected', async t => {
  const w = nonceRaceWorld(t, { aStatus: 'payment_uncertain' });
  const other = '12'.repeat(32);
  TRANSIENT_READS['pending-body'](w);
  assert.equal((await w.verify()).verification.outcome, 'awaiting_inclusion');
  assert.equal(w.coordinates.get(w.a.id).observation.slotConsumed, false);
  TRANSIENT_READS['chain-unavailable'](w);
  assert.equal((await correctPointer(w, other)).verification.outcome, 'chain_unavailable');
  const saved = w.coordinates.get(w.a.id);
  assert.equal(saved.reportedTxHash, other); assert.equal(saved.observation.txHash, other);
  assert.equal(w.ops.history(w.a.id).some(event => event.type === 'reported_hash_replaced'), true);
});

test('a slot already settled by another purchase still detaches the superseded pointer after a carried consumption', async t => {
  const w = nonceRaceWorld(t);
  mismatchedReads(w, 'wallet');
  const hash = w.coordinates.get(w.a.id).reportedTxHash, observeTransfer = w.chain.observeTransfer;
  assert.equal((await w.verify()).verification.slotConsumed, true);
  TRANSIENT_READS['chain-unavailable'](w);
  await w.verify();
  assert.equal(w.coordinates.get(w.a.id).observation.slotConsumedCarried, true);
  w.chain.observeTransfer = observeTransfer;
  const owner = w.create('TEST-owner', 'settled_verified').operation;
  w.coordinates.save({ operationId: owner.id, kind: 'dem-transfer', network: w.terms.network, from: w.wallet, nonceFence: 6, expectedNonce: 7, target: w.terms.seller.payee, amountOs: w.terms.price.amountOs, payload: {} });
  w.coordinates.reportHash(owner.id, hash);
  w.coordinates.recordObservation(owner.id, { txHash: hash, slotConsumed: true }, true);
  const read = await w.verify();
  assert.equal(read.verification.outcome, 'superseded'); assert.equal(read.verification.supersededBy, owner.id);
  const saved = w.coordinates.get(w.a.id);
  assert.equal(saved.reportedTxHash, null, 'the superseded pointer is detached');
  assert.equal(saved.observation.supersededBy, owner.id); assert.equal(saved.observation.slotConsumed, true);
  assert.equal(Object.hasOwn(saved.observation, 'slotConsumedCarried'), false);
});

for (const [signer, refused] of [['wallet', true], ['alternate key', false]]) {
  for (const kind of ['purchase', 'publication']) {
    test(`a confirmed ${signer}-signed mismatch read on a cancelled purchase racing a ${kind} handoff ${refused ? 'refuses' : 'does not refuse'} it`, async t => {
      const w = nonceRaceWorld(t);
      mismatchedReads(w, signer);
      const race = racingHandoff(w, kind);
      try {
        await race.started;
        const read = await w.verify();
        assert.equal(read.operation.status, 'cancelled'); assert.equal(read.verification.outcome, 'mismatch'); assert.equal(read.verification.slotConsumed, true);
        race.resume();
        if (refused) {
          await assert.rejects(race.saving, { code: 'nonce_readback_unavailable' });
          assert.equal(w.coordinates.get(race.b.operation.id), null, 'a consumed reservation never leaves the transaction');
          assert.equal(w.ops.get(w.accountId, race.b.operation.id).status, kind === 'purchase' ? 'approved' : 'listing_signed');
        } else {
          const issued = await race.saving;
          assert.equal(issued.operation.status, kind === 'purchase' ? 'payment_handoff' : 'publication_handoff');
          assert.equal(w.coordinates.get(race.b.operation.id).expectedNonce, 7);
        }
      } finally { race.resume(); await Promise.allSettled([race.saving]); }
    });
  }
}

test('an alternate-signed slot already settled by another purchase records signedByAlternateKey and does not refuse a handoff', async t => {
  const w = nonceRaceWorld(t, { aStatus: 'payment_uncertain' });
  mismatchedReads(w, 'alternate key');
  const hash = w.coordinates.get(w.a.id).reportedTxHash, owner = w.create('TEST-owner', 'settled_verified').operation;
  w.coordinates.save({ operationId: owner.id, kind: 'dem-transfer', network: w.terms.network, from: w.wallet, nonceFence: 6, expectedNonce: 7, target: w.terms.seller.payee, amountOs: w.terms.price.amountOs, payload: {} });
  w.coordinates.reportHash(owner.id, hash);
  w.coordinates.recordObservation(owner.id, { txHash: hash, slotConsumed: true, signedByAlternateKey: true }, true);
  const read = await w.verify();
  assert.equal(read.operation.status, 'superseded'); assert.equal(read.verification.supersededBy, owner.id);
  const saved = w.coordinates.get(w.a.id).observation;
  assert.equal(saved.slotConsumed, true); assert.equal(saved.signedByAlternateKey, true);
  const { b, run } = handoffFor(w, 'purchase');
  assert.equal((await run()).operation.status, 'payment_handoff');
  assert.equal(w.coordinates.get(b.operation.id).expectedNonce, 7);
});

// Wallet-signed nonce use is also recorded durably, apart from the pointer and
// its observation, so a concurrent pointer move or a later write cannot erase it.
const nonceRows = (w) => w.db.prepare('SELECT from_address, network, nonce, tx_hash, operation_id FROM wallet_nonce_consumptions ORDER BY rowid').all().map(row => ({ ...row }));
const nonceRow = (w, txHash, operationId = w.a.id) => ({ from_address: w.wallet, network: w.terms.network, nonce: 7, tx_hash: txHash, operation_id: operationId });
const gate = () => { let open, release; const started = new Promise(resolve => { open = resolve; }), held = new Promise(resolve => { release = resolve; }); return { started, release, wait: async () => { open(); await held; } }; };

for (const kind of ['purchase', 'publication']) {
  test(`a wallet-signed read landing after a concurrent pointer correction still refuses a racing ${kind} handoff`, async t => {
    const w = nonceRaceWorld(t);
    const hash = w.coordinates.get(w.a.id).reportedTxHash, other = '12'.repeat(32);
    const first = gate(), second = gate(), observeTransfer = w.chain.observeTransfer;
    w.chain.observeTransfer = async (txHash) => {
      if (txHash === hash) { await first.wait(); return { ...await observeTransfer(), amountOs: '1' }; }
      await second.wait(); throw new Error('TEST-rpc-unavailable');
    };
    const race = racingHandoff(w, kind);
    let reading, correcting;
    try {
      await race.started;
      reading = correctPointer(w, hash);
      await first.started;
      correcting = correctPointer(w, other);
      await second.started;
      assert.equal(w.coordinates.get(w.a.id).reportedTxHash, other, 'the unobserved pointer was corrected while the first read was in flight');
      first.release();
      const read = await reading;
      assert.equal(read.verification.outcome, 'mismatch'); assert.equal(read.verification.slotConsumed, true);
      second.release();
      assert.equal((await correcting).verification.outcome, 'chain_unavailable');
      const saved = w.coordinates.get(w.a.id);
      assert.equal(saved.reportedTxHash, other); assert.equal(saved.observation.slotConsumed, false, 'the observation lost the consumption');
      assert.deepEqual(nonceRows(w), [nonceRow(w, hash)], 'the durable record keeps it');
      race.resume();
      await assert.rejects(race.saving, { code: 'nonce_readback_unavailable' });
      assert.equal(w.coordinates.get(race.b.operation.id), null, 'a consumed reservation never leaves the transaction');
      assert.equal(w.ops.get(w.accountId, race.b.operation.id).status, kind === 'purchase' ? 'approved' : 'listing_signed');
    } finally { first.release(); second.release(); race.resume(); await Promise.allSettled([race.saving, reading, correcting]); }
  });
}

const DURABLE_BRANCHES = {
  settlement: { aStatus: 'payment_uncertain', status: 'settled_verified', reads: () => {} },
  mismatch: { aStatus: 'payment_uncertain', status: 'payment_mismatch', reads: mismatchedReads },
  'cancelled purchase': { aStatus: 'cancelled', status: 'cancelled', reads: mismatchedReads },
  'earlier owner': { aStatus: 'payment_uncertain', status: 'superseded', reads: (w, signer) => {
    mismatchedReads(w, signer);
    const owner = w.create('TEST-owner', 'settled_verified').operation, hash = w.coordinates.get(w.a.id).reportedTxHash;
    w.coordinates.save({ operationId: owner.id, kind: 'dem-transfer', network: w.terms.network, from: w.wallet, nonceFence: 6, expectedNonce: 7, target: w.terms.seller.payee, amountOs: w.terms.price.amountOs, payload: {} });
    w.coordinates.reportHash(owner.id, hash);
    w.coordinates.recordObservation(owner.id, { txHash: hash, slotConsumed: true, ...(signer === 'wallet' ? {} : { signedByAlternateKey: true }) }, true);
  } },
};
for (const [branch, { aStatus, status, reads }] of Object.entries(DURABLE_BRANCHES)) {
  for (const signer of ['wallet', 'alternate key']) {
    test(`a confirmed ${signer}-signed read in the ${branch} branch ${signer === 'wallet' ? 'records' : 'never records'} durable nonce use, once`, async t => {
      const w = nonceRaceWorld(t, { aStatus });
      const hash = w.coordinates.get(w.a.id).reportedTxHash;
      if (signer !== 'wallet' && branch === 'settlement') {
        const getTransaction = w.chain.getTransaction;
        w.chain.getTransaction = async (txHash) => { const body = await getTransaction(txHash); body.content = { ...body.content, from: ALT_SIGNER, from_ed25519_address: w.wallet }; return body; };
      }
      reads(w, signer);
      const read = await w.verify();
      assert.equal(read.operation.status, status, JSON.stringify(read.verification)); assert.equal(read.verification.slotConsumed, true);
      const expected = signer === 'wallet' ? [nonceRow(w, hash)] : [];
      assert.deepEqual(nonceRows(w), expected);
      await w.verify();
      assert.deepEqual(nonceRows(w), expected, 'a second read of the same hash adds no row');
    });
  }
}

// An alternate-signed body may leave the wallet's own nonce free for the
// approved transfer, so its recorded consumption never pins the pointer.
const walletSignedPayment = (w, txHash) => {
  const observeTransfer = w.chain.observeTransfer, getTransaction = w.chain.getTransaction;
  w.chain.observeTransfer = async (hash) => hash === txHash ? { status: 'included', txHash, blockNumber: 11, payer: w.wallet, payee: w.terms.seller.payee, amountOs: w.terms.price.amountOs } : observeTransfer(hash);
  w.chain.getTransaction = async (hash) => hash === txHash ? { hash: txHash, status: 'confirmed', blockNumber: 11, content: { from: w.wallet, nonce: 7 } } : getTransaction(hash);
};
for (const carried of [true, false]) {
  test(`a ${carried ? 'carried' : 'fresh'} alternate-signed consumption on a cancelled purchase lets a wallet-signed payment at that nonce replace the pointer and settle`, async t => {
    const w = nonceRaceWorld(t);
    mismatchedReads(w, 'alternate key');
    const hash = w.coordinates.get(w.a.id).reportedTxHash, other = '12'.repeat(32);
    const read = await w.verify();
    assert.equal(read.operation.status, 'cancelled'); assert.equal(read.verification.slotConsumed, true); assert.equal(read.verification.signedByAlternateKey, true);
    if (carried) {
      TRANSIENT_READS['chain-unavailable'](w);
      await w.verify();
      const saved = w.coordinates.get(w.a.id).observation;
      assert.equal(saved.slotConsumedCarried, true); assert.equal(saved.signedByAlternateKey, true); assert.equal(saved.txHash, hash);
    }
    walletSignedPayment(w, other);
    const settled = await correctPointer(w, other);
    assert.equal(settled.operation.status, 'settled_verified', JSON.stringify(settled.verification));
    assert.equal(settled.verification.txHash, other); assert.equal(settled.verification.signedByAlternateKey, undefined);
    const saved = w.coordinates.get(w.a.id);
    assert.equal(saved.reportedTxHash, other); assert.ok(saved.verifiedAt);
    assert.equal(w.ops.history(w.a.id).some(event => event.type === 'reported_hash_replaced'), true);
    assert.deepEqual(nonceRows(w), [nonceRow(w, other)]);
  });
}

for (const route of Object.keys(POINTER_KEEPING_READS)) {
  test(`a ${route} re-read of an alternate-signed consumption on a cancelled purchase detaches its pointer`, async t => {
    const w = nonceRaceWorld(t);
    mismatchedReads(w, 'alternate key');
    const hash = w.coordinates.get(w.a.id).reportedTxHash;
    assert.equal((await w.verify()).verification.signedByAlternateKey, true);
    POINTER_KEEPING_READS[route](w);
    const reread = await w.verify();
    assert.equal(reread.operation.status, 'cancelled');
    assert.equal(reread.verification.outcome, route === 'failed-observation' ? 'failed_unconfirmed' : 'pointer_rejected');
    const saved = w.coordinates.get(w.a.id);
    assert.equal(saved.reportedTxHash, null, 'an alternate-signed consumption never pins the pointer');
    assert.equal(saved.observation.txHash, hash); assert.equal(saved.observation.signedByAlternateKey, true);
    assert.deepEqual(nonceRows(w), []);
  });
}

// State written before the durable record existed carries no signer
// provenance (here an alternate-signed body at nonce 7 left the wallet's nonce
// at 6); the guard never counts it, and the handoff's fresh nonce read covers it.
const UPGRADED_STATES = {
  settled: { aStatus: 'settled_verified', verified: true, observation: {} },
  mismatch: { aStatus: 'payment_mismatch', verified: false, observation: { mismatches: ['amount differs from the approved price'] } },
};
for (const [state, { aStatus, verified, observation }] of Object.entries(UPGRADED_STATES)) {
  for (const kind of ['purchase', 'publication']) {
    test(`a pre-upgrade ${state} purchase without signer provenance at the next nonce does not refuse a new ${kind} handoff`, async t => {
      const w = nonceRaceWorld(t, { aStatus });
      const hash = w.coordinates.get(w.a.id).reportedTxHash;
      const getTransaction = w.chain.getTransaction;
      w.chain.getTransaction = async (txHash) => { const body = await getTransaction(txHash); body.content = { ...body.content, from: ALT_SIGNER, from_ed25519_address: w.wallet }; return body; };
      w.coordinates.recordObservation(w.a.id, { txHash: hash, observedAt: new Date().toISOString(), chainMode: w.terms.domain.mode, observation: { status: 'included', txHash: hash, blockNumber: 10, payer: w.wallet, payee: w.terms.seller.payee, amountOs: verified ? w.terms.price.amountOs : '1' }, slotConsumed: true, txNonce: 7, mismatches: [], ...observation }, verified);
      const saved = w.coordinates.get(w.a.id);
      assert.equal(saved.observation.slotConsumed, true); assert.equal(Object.hasOwn(saved.observation, 'signedByAlternateKey'), false);
      assert.equal(Boolean(saved.verifiedAt), verified); assert.deepEqual(nonceRows(w), []);
      if (verified) {
        // Re-verifying returns the stored settlement and never records its signer.
        assert.equal((await w.verify()).verification.outcome, 'verified');
        assert.deepEqual(nonceRows(w), []);
      }
      const { b, run } = handoffFor(w, kind);
      const issued = await run();
      assert.equal(issued.operation.status, kind === 'purchase' ? 'payment_handoff' : 'publication_handoff');
      assert.equal(w.coordinates.get(b.operation.id).expectedNonce, 7);
    });
  }
}

test('cancelled unverified readback returns a concurrent stored settlement and continues protocol', async t => {
  const w = nonceRaceWorld(t);
  w.db.prepare("UPDATE operations SET terms = json_set(terms, '$.protocol', json(?)) WHERE id = ?").run(JSON.stringify({ profile: 'TEST-continuation' }), w.a.id);
  let read, resume;
  const started = new Promise(resolve => { read = resolve; }), held = new Promise(resolve => { resume = resolve; });
  const observed = w.chain.observeTransfer;
  w.chain.observeTransfer = async () => { const value = await observed(); read(); await held; return { ...value, amountOs: '1' }; };
  let continued = 0;
  const protocol = { available: true, recheck: async operation => { continued++; return operation; } };
  const slower = createPurchaseService({ db: w.db, config: {}, ops: w.ops, coordinates: w.coordinates, chain: w.chain, protocol }).verifyDeal({ accountId: w.accountId, operationId: w.a.id });
  try {
    await started;
    w.chain.observeTransfer = observed;
    assert.equal((await w.verify()).operation.status, 'settled_verified');
    resume();
    assert.equal((await slower).operation.status, 'settled_verified');
    assert.equal(continued, 1, 'protocol continuation sees the stored settlement');
    assert.equal(w.ops.history(w.a.id).filter(event => event.type === 'settled_verified').length, 1);
  } finally { resume(); await Promise.allSettled([slower]); }
});
