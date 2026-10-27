import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { createDemDeliveryContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, tool, portal, tokenFrom, approvePurchase, reportPurchase, seedSellerListing } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';

installLoopbackOnlyGuard();
let n = 0;
const key = () => `abuse-limit-${++n}`;
const args = (seller, idempotencyKey = key()) => ({ listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, protocol: 'dacs-pay-dem', idempotencyKey });
const owner = (h, buyer) => h.app.services.accounts.walletOwner(buyer.wallet.address);

async function setup(t, options = {}) {
  const h = await startProtocolHarness(options);
  t.after(() => h.close());
  const buyer = await linkedUser(h);
  const seller = await addSeller(h, { listingId: key(), ...(options.now ? { now: options.now, listingNow: options.now() } : {}) });
  return { h, buyer, seller };
}

function noSellerWork(h, seller) {
  assert.deepEqual(h.anchors.faults.writes, []);
  assert.deepEqual(seller.state.requests, []);
}

test('abuse config defaults are 1 account slot, 1 wallet slot and 5 starts per hour; invalid caps fail closed', () => {
  const env = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) };
  assert.deepEqual(loadConfig(env).purchaseLimits, { maxUnpaidPerAccount: 1, maxUnpaidPerWallet: 1, maxStartsPerHour: 5 });
  for (const name of ['DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT', 'DACS_MAX_UNPAID_PURCHASES_PER_WALLET', 'DACS_MAX_PURCHASE_STARTS_PER_ACCOUNT_PER_HOUR']) {
    for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity']) assert.throws(() => loadConfig({ ...env, [name]: value }), ConfigError);
  }
});

test('account cap includes another linked buyer wallet; refusal and idempotent replay do no seller work', async (t) => {
  const { h, buyer, seller } = await setup(t);
  const accountId = owner(h, buyer), second = createEphemeralWallet();
  h.app.services.accounts.linkWallet({ accountId, address: second.address, challengeId: key() });
  const request = { ...args(seller), walletAddress: buyer.wallet.address };
  const first = await tool(h, buyer, 'prepare_purchase', request);
  assert.equal(first.status, 'agreement_pending');
  const refusal = await tool(h, buyer, 'prepare_purchase', { ...args(seller), walletAddress: second.address });
  assert.equal(refusal.error, 'unpaid_purchase_account_limit');
  assert.match(refusal.message, /Pay or cancel.*no seller write or wallet approval/);
  const replay = await tool(h, buyer, 'prepare_purchase', request);
  assert.equal(replay.operationId, first.operationId);
  noSellerWork(h, seller);
  assert.equal(h.app.db.prepare("SELECT count(*) AS n FROM operations WHERE kind = 'purchase'").get().n, 1);
});

test('wallet cap survives a wallet changing accounts; a different wallet remains independent', async (t) => {
  const { h, buyer, seller } = await setup(t);
  const first = await tool(h, buyer, 'prepare_purchase', args(seller));
  assert.equal(first.status, 'agreement_pending');
  const queued = h.app.services.ops.get(owner(h, buyer), first.operationId);
  const other = await linkedUser(h), accountId = owner(h, other);
  h.app.db.prepare('UPDATE wallets SET account_id = ? WHERE address = ?').run(accountId, buyer.wallet.address);
  const refused = await tool(h, other, 'prepare_purchase', { ...args(seller), walletAddress: buyer.wallet.address });
  assert.equal(refused.error, 'unpaid_purchase_wallet_limit');
  assert.match(refused.message, /buyer wallet.*Pay or cancel.*no seller write or wallet approval/);
  const legacy = h.app.services.ops.createIdempotent({ accountId, kind: 'purchase', idempotencyKey: key(), request: { legacyQueued: true }, status: queued.status, terms: queued.terms, termsHash: queued.termsHash, state: queued.state, expiresAt: queued.expiresAt });
  const portalRefusal = await portal(h, `/portal/api/purchase/${legacy.operation.id}/agreement/identity`, { token: legacy.handoffToken, address: buyer.wallet.address });
  assert.equal(portalRefusal.error, 'unpaid_purchase_wallet_limit');
  assert.equal(portalRefusal.signRequest, undefined);
  await h.app.services.purchases.cancel({ accountId, operationId: legacy.operation.id });
  assert.equal((await tool(h, other, 'prepare_purchase', { ...args(seller), walletAddress: other.wallet.address })).status, 'agreement_pending');
  noSellerWork(h, seller);
});

test('five starts including cancellations exhaust the rolling hour; cancelled purchases release their unpaid slot', async (t) => {
  let at = Date.now();
  const { h, buyer, seller } = await setup(t, { now: () => at });
  const accountId = owner(h, buyer);
  let firstArgs, first;
  for (let i = 0; i < 5; i += 1) {
    const request = args(seller), p = await tool(h, buyer, 'prepare_purchase', request);
    assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
    if (i === 0) { firstArgs = request; first = p; }
    assert.equal((await h.app.services.purchases.cancel({ accountId, operationId: p.operationId })).cancelled, true);
  }
  const refusal = await tool(h, buyer, 'prepare_purchase', args(seller));
  assert.equal(refusal.error, 'purchase_start_limit');
  assert.match(refusal.message, /5 purchase starts.*past hour.*Wait.*no seller write or wallet approval/);
  assert.equal((await tool(h, buyer, 'prepare_purchase', firstArgs)).operationId, first.operationId, 'replay does not consume a start');
  at += 60 * 60 * 1000 - 1;
  await assert.rejects(h.app.services.purchases.prepare({ accountId, ...args(seller) }), { code: 'purchase_start_limit' });
  at += 1;
  seedSellerListing(h, seller.wallet, { listingId: seller.published.listingId, price: '2.5', now: at, summary: { observedAt: new Date(at).toISOString() } });
  assert.equal((await h.app.services.purchases.prepare({ accountId, ...args(seller) })).created, true);
  noSellerWork(h, seller);
});

test('concurrent starts reserve only one durable slot, including concurrent replay with the same key', async (t) => {
  const { h, buyer, seller } = await setup(t), accountId = owner(h, buyer);
  const reopened = await createApp({ config: h.config, logger: { info() {}, warn() {}, error() {} }, dacsProtocol: { anchorUrl: h.anchors.url, sellerEndpoint: (claim) => h.endpoints.get(claim) } });
  t.after(() => reopened.close());
  const calls = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => (i % 2 ? reopened : h.app).services.purchases.prepare({ accountId, ...args(seller) })));
  assert.equal(calls.filter((r) => r.status === 'fulfilled').length, 1);
  for (const r of calls.filter((r) => r.status === 'rejected')) assert.equal(r.reason.code, 'unpaid_purchase_account_limit');
  const p = calls.find((r) => r.status === 'fulfilled').value;
  await h.app.services.purchases.cancel({ accountId, operationId: p.operation.id });
  const request = { accountId, ...args(seller) };
  const replay = await Promise.all([h.app.services.purchases.prepare(request), h.app.services.purchases.prepare(request)]);
  assert.equal(replay[0].operation.id, replay[1].operation.id);
  assert.equal(replay.filter((r) => r.created).length, 1);
  noSellerWork(h, seller);
});

test('an underfunded buyer cannot reach the native seller Vet producer; the funded control reaches that same seam', async (t) => {
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  let vetRequests = 0;
  const demDeliveryContext = createDemDeliveryContext({ authority: 'TEST-abuse-vet', resolveBuyer: async () => { vetRequests += 1; return { disposition: 'indeterminate', reason: 'TEST Vet producer boundary' }; }, resolveSeller: async () => { throw new Error('TEST unexpected seller resolver'); } });
  const { h, buyer, seller } = await setup(t, { demDeliveryContext, browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  const p = await tool(h, buyer, 'prepare_purchase', { ...args(seller), protocol: 'dacs-sr2-wallet-agreement' }), token = tokenFrom(p.approvalUrl);
  const path = `/portal/api/purchase/${p.operationId}/agreement/`;
  const identity = await portal(h, `${path}identity`, { token, address: buyer.wallet.address });
  assert.equal(identity.error, undefined);
  const signature = buyer.wallet.signHex(identity.signRequest.message);
  h.chain.setBalance(buyer.wallet.address, '0');
  const refused = await portal(h, `${path}plan`, { token, signature });
  assert.equal(refused.error, 'buyer_balance_insufficient');
  assert.equal(refused.signRequest, undefined);
  assert.equal(vetRequests, 0);
  assert.deepEqual(memory.snapshot(), []);
  noSellerWork(h, seller);
  h.chain.setBalance(buyer.wallet.address, '1000000000000');
  const funded = await portal(h, `${path}plan`, { token, signature });
  assert.equal(funded.error, 'agreement_context_held');
  assert.equal(vetRequests, 1, 'the control reaches the exact producer the balance refusal blocks');
});

test('balance must cover price, SDK gas and both node fees; missing or inexact chain reads refuse with no seller work', async (t) => {
  const { h, buyer, seller } = await setup(t);
  h.chain.faults.fees = { networkFee: 2, rpcFee: 3 };
  h.chain.setBalance(buyer.wallet.address, '8499999999');
  const insufficient = await tool(h, buyer, 'prepare_purchase', args(seller));
  assert.equal(insufficient.error, 'buyer_balance_insufficient');
  assert.deepEqual(insufficient.details, { balanceOs: '8499999999', priceOs: '2500000000', buyerFeesOs: '6000000000', requiredOs: '8500000000' });
  assert.match(insufficient.message, /price plus buyer fees.*Fund.*no seller write or wallet approval/);
  assert.match(insufficient.message, /Required 8\.5 DEM \(2\.5 DEM price \+ 6 DEM buyer fee reserve\); available 8\.499999999 DEM/);
  for (const value of [undefined, null, -1, 8.5, 2 ** 53, '01', '1.5', '-1', '1e20', ' 1', '9'.repeat(79)]) {
    h.chain.setBalance(buyer.wallet.address, value === undefined ? { missing: true } : value);
    assert.equal((await tool(h, buyer, 'prepare_purchase', args(seller))).error, 'buyer_balance_unavailable');
  }
  h.chain.setBalance(buyer.wallet.address, '8500000000');
  for (const fees of [{}, { networkFee: 1.5, rpcFee: 0 }, { networkFee: '2', rpcFee: 3 }, { networkFee: -1, rpcFee: 0 }, { networkFee: Number.MAX_SAFE_INTEGER + 1, rpcFee: 0 },
    { networkFee: 2, rpcFee: 3, additionalFee: -1 }, { networkFee: 2, rpcFee: 3, additionalFee: 1.5 }, { networkFee: 2, rpcFee: 3, additionalFee: '1' }, { networkFee: 2, rpcFee: 3, additionalFee: null }]) {
    h.chain.faults.fees = fees;
    assert.equal((await tool(h, buyer, 'prepare_purchase', args(seller))).error, 'buyer_balance_unavailable');
  }
  h.chain.faults.fees = { networkFee: 2, rpcFee: 3 };
  assert.equal((await tool(h, buyer, 'prepare_purchase', args(seller))).status, 'agreement_pending', 'exact funding boundary accepts');
  assert.ok(h.chain.faults.rpcCalls.includes('getAddressInfo'));
  noSellerWork(h, seller);
});

// A reader over a stubbed fetch: no socket is opened.
function stubReader(answer) {
  const fetchImpl = async (_url, init) => {
    const { message } = JSON.parse(init.body).params[0];
    return new Response(JSON.stringify({ result: 200, response: answer(message) }), { headers: { 'content-type': 'application/json' } });
  };
  return createDemosChainReader({ rpcUrl: 'http://127.0.0.1:9', network: 'demos-testnet', fetchImpl });
}

test('balance read follows DACS_DEM_AMOUNT_ENCODING exactly; fees add additionalFee when present', async () => {
  const address = createEphemeralWallet().address;
  const balanceOf = (balance, encoding) => stubReader(() => ({ pubkey: address, nonce: 12, balance })).getAddressBalance(address, encoding ? { encoding } : undefined);
  // os-string (default): integer OS, string (live Node2 shape) or safe JSON integer.
  for (const [value, os] of [['2481500000000', 2481500000000n], ['0', 0n], [2481500000, 2481500000n], [0, 0n], [Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)]]) {
    assert.equal(await balanceOf(value), os, `os-string ${JSON.stringify(value)}`);
    assert.equal(await balanceOf(value, 'os-string'), os, `os-string ${JSON.stringify(value)}`);
  }
  for (const value of [undefined, null, '', '01', '1.5', '-1', '1e20', ' 1', '0x10', '9'.repeat(79), 1.5, -1, 2 ** 53, true, {}]) {
    await assert.rejects(balanceOf(value, 'os-string'), { kind: 'invalid' }, `os-string ${JSON.stringify(value)}`);
  }
  // dem-number (pre-fork): DEM, safe JSON integer or decimal string with at most 9 fraction digits.
  for (const [value, os] of [[2481, 2481000000000n], [0, 0n], ['2481', 2481000000000n], ['2481.5', 2481500000000n], ['2481.50', 2481500000000n], ['0.000000001', 1n], ['0', 0n]]) {
    assert.equal(await balanceOf(value, 'dem-number'), os, `dem-number ${JSON.stringify(value)}`);
  }
  for (const value of [undefined, null, '', '02', '.5', '5.', '1.0000000001', '-1', '1e3', ' 1', 1.5, -1, 2 ** 53, '9'.repeat(70)]) {
    await assert.rejects(balanceOf(value, 'dem-number'), { kind: 'invalid' }, `dem-number ${JSON.stringify(value)}`);
  }
  await assert.rejects(balanceOf('1', 'float'), { kind: 'invalid' }, 'an unknown encoding fails closed');
  const feeOf = (params) => stubReader(() => params).getTransactionFees();
  assert.equal(await feeOf({ networkFee: 1, rpcFee: 1, additionalFee: 0, blockTimeMs: 1000 }), 3_000_000_000n, 'live Node2 shape: 1 DEM gas + 1 + 1 + 0');
  assert.equal(await feeOf({ networkFee: 1, rpcFee: 1 }), 3_000_000_000n, 'absent additionalFee is 0');
  assert.equal(await feeOf({ networkFee: 1, rpcFee: 1, additionalFee: 2 }), 5_000_000_000n);
  for (const additionalFee of [-1, 1.5, '2', null, 2 ** 53]) await assert.rejects(feeOf({ networkFee: 1, rpcFee: 1, additionalFee }), { kind: 'invalid' });
});

test('dem-number deployments read the buyer balance in DEM before any seller write', async (t) => {
  const { h, buyer, seller } = await setup(t, { env: { DACS_DEM_AMOUNT_ENCODING: 'dem-number' } });
  h.chain.faults.fees = { networkFee: 2, rpcFee: 3 };
  for (const [value, balanceOs] of [[8, '8000000000'], ['8.499999999', '8499999999']]) {
    h.chain.setBalance(buyer.wallet.address, value);
    const refused = await tool(h, buyer, 'prepare_purchase', args(seller));
    assert.equal(refused.error, 'buyer_balance_insufficient', JSON.stringify(refused));
    assert.deepEqual(refused.details, { balanceOs, priceOs: '2500000000', buyerFeesOs: '6000000000', requiredOs: '8500000000' });
  }
  h.chain.setBalance(buyer.wallet.address, '8.5000000001');
  assert.equal((await tool(h, buyer, 'prepare_purchase', args(seller))).error, 'buyer_balance_unavailable', 'more than 9 fraction digits is inexact');
  h.chain.setBalance(buyer.wallet.address, '8.5');
  assert.equal((await tool(h, buyer, 'prepare_purchase', args(seller))).status, 'agreement_pending', 'exactly 8.5 DEM covers the requirement');
  noSellerWork(h, seller);
});

test('a positive additionalFee raises the required balance; a JSON number OS balance is exact', async (t) => {
  const { h, buyer, seller } = await setup(t);
  h.chain.setBalance(buyer.wallet.address, 12499999999);
  h.chain.faults.fees = { networkFee: 2, rpcFee: 3, additionalFee: 0 };
  const without = await tool(h, buyer, 'prepare_purchase', args(seller));
  assert.equal(without.status, 'agreement_pending', 'control: 12.499999999 DEM covers 2.5 + 6 without an additional fee');
  assert.equal((await h.app.services.purchases.cancel({ accountId: owner(h, buyer), operationId: without.operationId })).cancelled, true);
  h.chain.faults.fees = { networkFee: 2, rpcFee: 3, additionalFee: 4 };
  const refused = await tool(h, buyer, 'prepare_purchase', args(seller));
  assert.equal(refused.error, 'buyer_balance_insufficient');
  assert.deepEqual(refused.details, { balanceOs: '12499999999', priceOs: '2500000000', buyerFeesOs: '10000000000', requiredOs: '12500000000' });
  h.chain.setBalance(buyer.wallet.address, 12500000000);
  assert.equal((await tool(h, buyer, 'prepare_purchase', args(seller))).status, 'agreement_pending');
  noSellerWork(h, seller);
});

test('an unreadable balance or fee read logs its cause; the buyer refusal stays generic', async (t) => {
  const { h, buyer, seller } = await setup(t);
  const from = h.logs.length;
  h.chain.setBalance(buyer.wallet.address, '1.5');
  const balance = await tool(h, buyer, 'prepare_purchase', args(seller));
  assert.equal(balance.error, 'buyer_balance_unavailable');
  assert.doesNotMatch(balance.message, /os-string|getAddressInfo/, 'the cause is not shown to the buyer');
  h.chain.setBalance(buyer.wallet.address, '1000000000000');
  h.chain.faults.fees = { networkFee: 1, rpcFee: 1, additionalFee: -1 };
  assert.equal((await tool(h, buyer, 'prepare_purchase', args(seller))).error, 'buyer_balance_unavailable');
  const logged = h.logs.slice(from).filter((line) => line.includes('"buyer_funds_read_failed"'));
  assert.deepEqual(logged.map((line) => JSON.parse(line)).map(({ level, event, kind, errorCode, message }) => ({ level, event, kind, errorCode, message })), [
    { level: 'warn', event: 'buyer_funds_read_failed', kind: 'invalid', errorCode: null, message: 'balance response has no exact non-negative os-string amount' },
    { level: 'warn', event: 'buyer_funds_read_failed', kind: 'invalid', errorCode: null, message: 'network fees must be exact non-negative whole DEM amounts' },
  ]);
  const hex = buyer.wallet.address.toLowerCase().replace(/^0x/, '');
  for (const line of logged) assert.ok(!line.toLowerCase().includes(hex), 'no buyer address in the cause log');
  noSellerWork(h, seller);
});

test('native Agreement purchase reserves CREATE storage, gas and fees plus payment fees before any wallet prompt', async (t) => {
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  const { h, buyer, seller } = await setup(t, { browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  h.chain.setBalance(buyer.wallet.address, '9499999999');
  const refused = await tool(h, buyer, 'prepare_purchase', { ...args(seller), protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(refused.error, 'buyer_balance_insufficient');
  assert.equal(refused.details.buyerFeesOs, '7000000000');
  assert.equal(refused.details.requiredOs, '9500000000');
  assert.deepEqual(memory.snapshot(), []);
  noSellerWork(h, seller);
});

test('portal rechecks funds before identity and Agreement planning; old over-cap operations are refused before a sign request', async (t) => {
  const { h, buyer, seller } = await setup(t);
  const p = await tool(h, buyer, 'prepare_purchase', args(seller)), token = tokenFrom(p.approvalUrl);
  const path = `/portal/api/purchase/${p.operationId}/agreement/`;
  h.chain.setBalance(buyer.wallet.address, '0');
  const identityRefusal = await portal(h, `${path}identity`, { token, address: buyer.wallet.address });
  assert.equal(identityRefusal.error, 'buyer_balance_insufficient');
  assert.equal(identityRefusal.signRequest, undefined);
  assert.match(identityRefusal.message, /Fund the buyer wallet.*no seller write or wallet approval/);
  h.chain.setBalance(buyer.wallet.address, '1000000000000');
  const identity = await portal(h, `${path}identity`, { token, address: buyer.wallet.address });
  assert.equal(identity.error, undefined);
  h.chain.setBalance(buyer.wallet.address, '0');
  const planRefusal = await portal(h, `${path}plan`, { token, signature: buyer.wallet.signHex(identity.signRequest.message) });
  assert.equal(planRefusal.error, 'buyer_balance_insufficient');
  assert.equal(planRefusal.signRequest, undefined);
  const original = h.app.services.ops.get(owner(h, buyer), p.operationId);
  h.app.services.ops.createIdempotent({ accountId: original.accountId, kind: 'purchase', idempotencyKey: key(), request: { legacyQueued: true }, status: original.status, terms: original.terms, termsHash: original.termsHash, state: original.state, expiresAt: original.expiresAt });
  const capRefusal = await portal(h, `${path}identity`, { token, address: buyer.wallet.address });
  assert.equal(capRefusal.error, 'unpaid_purchase_account_limit');
  assert.equal(capRefusal.signRequest, undefined);
  noSellerWork(h, seller);
});

async function signAndApprove(h, buyer, p) {
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const token = tokenFrom(p.approvalUrl), path = `/portal/api/purchase/${p.operationId}/agreement/`;
  const identity = await portal(h, `${path}identity`, { token, address: buyer.wallet.address });
  const plan = await portal(h, `${path}plan`, { token, signature: buyer.wallet.signHex(identity.signRequest.message) });
  const signed = await portal(h, `${path}sign`, { token, agreementSignature: buyer.wallet.signHex(plan.signRequest.agreementMessage), anchorSignature: buyer.wallet.signHex(plan.signRequest.anchorMessage) });
  assert.equal(signed.status, 'awaiting_approval');
  const { approved } = await approvePurchase(h, p.operationId, p.approvalUrl, buyer.wallet);
  assert.equal(approved.status, 'payment_handoff');
  return { token, approved };
}

test('a lost payment response stays readback-only; its handoff holds the account slot, payment_uncertain blocks only its own wallet, verified payment frees it', async (t) => {
  const { h, buyer, seller } = await setup(t);
  const accountId = owner(h, buyer), second = createEphemeralWallet();
  h.app.services.accounts.linkWallet({ accountId, address: second.address, challengeId: key() });
  const p = await tool(h, buyer, 'prepare_purchase', { ...args(seller), walletAddress: buyer.wallet.address });
  const { token, approved } = await signAndApprove(h, buyer, p);
  const hash = h.chain.walletBroadcast(approved.payload);
  const lost = await reportPurchase(h, p.operationId, token, { walletError: 'TEST response lost after send' });
  assert.equal(lost.status, 'payment_handoff');
  // Another wallet on the account is not fenced by the per-wallet unresolved
  // guard, so only the new account cap can refuse it.
  const handoffHeld = await tool(h, buyer, 'prepare_purchase', { ...args(seller), walletAddress: second.address });
  assert.equal(handoffHeld.error, 'unpaid_purchase_account_limit', 'an issued handoff is unpaid and holds the account slot');
  assert.match(handoffHeld.message, /Pay or cancel.*no seller write or wallet approval/);
  assert.equal((await tool(h, buyer, 'verify_deal', { operationId: p.operationId })).status, 'payment_uncertain');
  const sameWallet = await tool(h, buyer, 'prepare_purchase', { ...args(seller), walletAddress: buyer.wallet.address });
  assert.equal(sameWallet.error, 'unresolved_payment', 'the uncertain payment still blocks its own wallet');
  assert.equal(sameWallet.details.operationId, p.operationId);
  const otherWallet = await tool(h, buyer, 'prepare_purchase', { ...args(seller), walletAddress: second.address });
  assert.equal(otherWallet.status, 'agreement_pending', 'payment_uncertain no longer holds the whole account');
  assert.equal((await h.app.services.purchases.cancel({ accountId, operationId: otherWallet.operationId })).cancelled, true);
  const again = await portal(h, `/portal/api/purchase/${p.operationId}/handoff`, { token });
  assert.equal(again.error, 'invalid_state');
  assert.equal(again.payload, undefined);
  seller.state.failPaths.add('/dacs/v1/payments');
  h.chain.setBalance(buyer.wallet.address, '0');
  const paid = await tool(h, buyer, 'verify_deal', { operationId: p.operationId, txHash: hash });
  assert.equal(paid.status, 'settled_verified');
  const writes = h.anchors.faults.writes.length;
  h.chain.setBalance(buyer.wallet.address, '1000000000000');
  assert.equal((await tool(h, buyer, 'prepare_purchase', { ...args(seller), walletAddress: buyer.wallet.address })).status, 'agreement_pending');
  assert.equal(h.anchors.faults.writes.length, writes, 'slot release does not write for the next purchase');
  assert.equal(h.chain.nonceOf(buyer.wallet.address), 1, 'the lost response was never resent');
});

test('a payment_mismatch purchase frees its unpaid account and wallet slot', async (t) => {
  const { h, buyer, seller } = await setup(t);
  const accountId = owner(h, buyer), second = createEphemeralWallet();
  h.app.services.accounts.linkWallet({ accountId, address: second.address, challengeId: key() });
  const p = await tool(h, buyer, 'prepare_purchase', { ...args(seller), walletAddress: buyer.wallet.address });
  const { token, approved } = await signAndApprove(h, buyer, p);
  assert.equal((await tool(h, buyer, 'prepare_purchase', { ...args(seller), walletAddress: second.address })).error, 'unpaid_purchase_account_limit', 'control: the handoff holds the slot');
  const tampered = structuredClone(approved.payload);
  tampered.content.amount = '1';
  tampered.content.data[1].args[1] = '1'; // the wallet sent 1 OS instead of the approved price
  const hash = h.chain.walletBroadcast(tampered);
  const reported = await reportPurchase(h, p.operationId, token, { txHash: hash });
  assert.equal(reported.status, 'payment_mismatch');
  // Same account and same wallet, each capped at 1: success proves both slots are free.
  const next = await tool(h, buyer, 'prepare_purchase', { ...args(seller), walletAddress: buyer.wallet.address });
  assert.equal(next.status, 'agreement_pending', JSON.stringify(next));
  assert.equal(h.app.services.ops.get(accountId, p.operationId).status, 'payment_mismatch', 'the mismatch itself is unchanged');
});

test('abuse fixtures never attempted an external connection', () => assert.deepEqual(externalAttempts, []));
