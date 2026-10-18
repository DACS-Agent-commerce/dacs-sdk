// Fix 4: the devnet-demo Agreement-context provider can publish seller Vet
// records. The purchase itself (error, status, stage, retries) is unchanged,
// and ops health reads the recorded attempt from the live database. Fix 5:
// "not written" is a structured mark set by the consumer, never taken from
// provider text or codes. Fix 6: the consumer sets it only when it invoked no
// provider; any answer or failure from an invoked provider is a possible write.
// Fix 7: that holds even when the answer or the thrown value cannot be read.
// Fix 8: and when the answer's disposition changes between reads.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as demContext from '../src/dacs/dem-delivery-context-consumer.mjs';
import { resolveAgreementContext } from '../src/dacs/agreement-context-consumer.mjs';
import { createDevnetDemoAgreementContextProvider } from '../src/devnet-demo/agreement-context.mjs';
import { createInMemoryPartyVetStore } from '../src/devnet-demo/party-vet-store.mjs';
import { opsHealth } from '../src/ops/health.mjs';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, tool, portal, tokenFrom } from './helpers/flows.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { installLoopbackOnlyGuard } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { startRestartableContextHarness } from './helpers/agreement-context-interactions.mjs';
import { startChainFixture } from './fixtures/chain-server.mjs';

installLoopbackOnlyGuard();

test('provider-effect: DEM Agreement context without a configured capability records the provider-unavailable code', async () => {
  // Restarted without demDeliveryContext: nothing was invoked, so nothing can have been written.
  // Fix 5: plus the structured not-written mark, which ops health trusts instead of the text.
  assert.deepEqual(await demContext.resolveDemDeliveryBuyerContext(null, { operation: {}, listing: {}, buyerBundle: {}, generatedAt: 0 }),
    { disposition: 'indeterminate', reason: 'CONTEXT_PROVIDER_UNAVAILABLE: DEM delivery context capability is absent', written: false });
  assert.deepEqual(await resolveAgreementContext(null, { operation: {}, listing: {}, buyerBundle: {}, generatedAt: 0 }),
    { disposition: 'indeterminate', reason: 'CONTEXT_PROVIDER_UNAVAILABLE: no operator Agreement context provider is configured', written: false });
});

test('provider-effect: devnet Agreement context: any provider failure, before or after its first Vet publish, is recorded as a possible write', async (t) => {
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  let provider = null, providerCalls = 0;
  const demDeliveryContext = demContext.createDemDeliveryContext({ authority: 'TEST-provider-effect-party-vet',
    resolveBuyer: async (input) => { providerCalls += 1; return provider.resolveBuyer(input); },
    resolveSeller: async () => { throw new Error('TEST unexpected seller resolver'); } });
  const h = await startProtocolHarness({ demDeliveryContext, browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  t.after(() => h.close());
  const seller = await addSeller(h, { listingId: 'provider-effect-agreement-context' });
  // The real provider over a TEST anchor: the seller signer can refuse before
  // anything is published, or a publish is issued and its answer lost.
  let fault = null;
  const published = [];
  const anchor = { writer: seller.wallet.claim,
    publish: async ({ logicalAddress }) => { published.push(logicalAddress); throw new Error('TEST Vet publish answer lost'); },
    verifyReceipt: async () => 'invalid', readRetained: async () => ({ status: 'absent' }), hasIntent: async () => false };
  const wallet = { claim: seller.wallet.claim, signBytes: (bytes) => { if (fault === 'signer') throw new Error('TEST seller signer refused'); return seller.wallet.signBytes(bytes); } };
  provider = createDevnetDemoAgreementContextProvider({ anchor, wallet, listing: seller.listing, store: createInMemoryPartyVetStore() });

  // One buyer per purchase: an account may hold one unpaid purchase.
  async function purchase(key) {
    const buyer = await linkedUser(h), account = h.app.services.accounts.walletOwner(buyer.wallet.address);
    const p = await tool(h, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, protocol: 'dacs-sr2-wallet-agreement', idempotencyKey: key });
    assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
    const token = tokenFrom(p.approvalUrl), path = `/portal/api/purchase/${p.operationId}/agreement/`;
    const identity = await portal(h, `${path}identity`, { token, address: buyer.wallet.address });
    const signature = buyer.wallet.signHex(identity.signRequest.message);
    return { id: p.operationId, plan: () => portal(h, `${path}plan`, { token, signature }), op: () => h.app.services.ops.get(account, p.operationId) };
  }
  // The SDK wraps a provider-internal error in its own step message.
  const held = (out, w, reason) => {
    assert.deepEqual([out.status, out.error], [409, 'agreement_context_held'], JSON.stringify(out));
    assert.equal(out.signRequest, undefined);
    const o = w.op(), last = o.state.protocol.attempts.at(-1);
    assert.deepEqual([o.status, o.state.protocol.stage, o.state.protocol.planned], ['agreement_pending', 'identity', undefined]);
    assert.deepEqual([last.step, last.outcome], ['agreement-context', 'indeterminate']);
    assert.match(last.reason, reason);
    assert.equal(out.message, `the operator Agreement context is indeterminate (${last.reason}); no Agreement was planned or signed`);
    return last.reason;
  };

  fault = 'signer';
  const before = await purchase('provider-effect-before-publish');
  // Fix 6: recorded as on main. The provider ran, and only its own code knew
  // that it had not published yet, so the consumer does not mark it not written.
  held(await before.plan(), before, /^DEM delivery context failed: /);
  assert.deepEqual(published, [], 'the signer refused before any publish');
  assert.equal(Object.hasOwn(before.op().state.protocol.attempts.at(-1), 'written'), false, 'fix 6: no not-written mark');

  fault = null;
  const lost = await purchase('provider-effect-lost-answer');
  // Unchanged from before fix 4: no reason code, the consumer's own prefix.
  const lostReason = held(await lost.plan(), lost, /^DEM delivery context failed: /);
  assert.equal(published.length, 1, 'one Vet publish was issued');
  assert.equal(Object.hasOwn(lost.op().state.protocol.attempts.at(-1), 'written'), false, 'fix 5: no not-written mark');
  // Retrying is unchanged: the provider is asked again and the purchase stays held.
  const calls = providerCalls;
  assert.equal(held(await lost.plan(), lost, /^DEM delivery context failed: /), lostReason);
  assert.equal(providerCalls, calls + 1);
  assert.equal(lost.op().state.protocol.attempts.filter((a) => a.step === 'agreement-context').length, 2);

  // The live database, read as the CLI reads it, with no operator state.
  const report = opsHealth({ databasePath: h.config.databasePath, now: Date.now() });
  assert.equal(report.healthy, false);
  assert.equal(report.seller.journals, null);
  assert.deepEqual(report.stuck.map((s) => [s.purchaseId, s.stage, s.outcome]).sort(), [[before.id, 'identity', 'seller-journal-not-read'], [lost.id, 'identity', 'seller-journal-not-read']].sort());
});

test('provider-status: a provider cannot mark its own Agreement-context failure as not written, with any consumer export', async (t) => {
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  let resolveBuyer = null;
  const demDeliveryContext = demContext.createDemDeliveryContext({ authority: 'TEST-provider-status-party-vet', resolveBuyer: (input) => resolveBuyer(input),
    resolveSeller: async () => { throw new Error('TEST unexpected seller resolver'); } });
  const h = await startProtocolHarness({ demDeliveryContext, browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  t.after(() => h.close());
  const seller = await addSeller(h, { listingId: 'provider-status-agreement-context' });
  const published = [], CONTEXT_NOT_WRITTEN = 'CONTEXT_NOT_WRITTEN';
  // The real devnet provider, whose anchor's own error happens to carry the not-written code after a publish.
  const anchor = { writer: seller.wallet.claim,
    publish: async ({ logicalAddress }) => { published.push(logicalAddress); throw Object.assign(new Error('TEST downstream failure'), { code: CONTEXT_NOT_WRITTEN }); },
    verifyReceipt: async () => 'invalid', readRetained: async () => ({ status: 'absent' }), hasIntent: async () => false };
  const devnet = createDevnetDemoAgreementContextProvider({ anchor, wallet: { claim: seller.wallet.claim, signBytes: (bytes) => seller.wallet.signBytes(bytes) }, listing: seller.listing, store: createInMemoryPartyVetStore() });
  const providers = {
    // Each one may have published a seller Vet record before answering.
    'answers with a not-written reason': async () => { published.push('reason'); return { disposition: 'indeterminate', reason: 'CONTEXT_NOT_WRITTEN: provider-controlled after-write claim' }; },
    'answers with the mark': async () => { published.push('answer-mark'); return { disposition: 'indeterminate', reason: 'provider-controlled after-write claim', written: false }; },
    'answers with a provider-unavailable reason': async () => { published.push('unavailable'); return { disposition: 'absent', reason: 'CONTEXT_PROVIDER_UNAVAILABLE: provider-controlled' }; },
    'throws the not-written code': async () => { published.push('code'); throw Object.assign(new Error('provider-controlled after-write claim'), { code: CONTEXT_NOT_WRITTEN }); },
    'throws an error carrying the mark': async () => { published.push('mark'); throw Object.assign(new Error('provider-controlled after-write claim'), { code: CONTEXT_NOT_WRITTEN, written: false }); },
    'rethrows a downstream error with that code': (input) => devnet.resolveBuyer(input),
    // Fix 6: provider code can import the consumer module. Whatever any of its
    // exports makes or throws, thrown after a write, is still a possible write.
    ...Object.fromEntries(Object.entries(demContext).filter(([, value]) => typeof value === 'function').map(([name, make]) => [`throws what the consumer's ${name} export makes`, async () => {
      published.push(name);
      let made;
      try { made = await make('provider-controlled after-write claim'); } catch (error) { made = error; }
      throw made;
    }])),
  };
  const ids = [];
  for (const [label, provider] of Object.entries(providers)) {
    resolveBuyer = provider;
    const buyer = await linkedUser(h), account = h.app.services.accounts.walletOwner(buyer.wallet.address);
    const p = await tool(h, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, protocol: 'dacs-sr2-wallet-agreement', idempotencyKey: `provider-status-forged-${ids.length}` });
    assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
    const token = tokenFrom(p.approvalUrl), path = `/portal/api/purchase/${p.operationId}/agreement/`;
    const identity = await portal(h, `${path}identity`, { token, address: buyer.wallet.address });
    const out = await portal(h, `${path}plan`, { token, signature: buyer.wallet.signHex(identity.signRequest.message) });
    // The purchase is held exactly as before.
    assert.deepEqual([out.status, out.error], [409, 'agreement_context_held'], `${label}: ${JSON.stringify(out)}`);
    const o = h.app.services.ops.get(account, p.operationId), last = o.state.protocol.attempts.at(-1);
    assert.deepEqual([o.status, o.state.protocol.stage, o.state.protocol.planned, last.step], ['agreement_pending', 'identity', undefined, 'agreement-context'], label);
    assert.equal(out.message, `the operator Agreement context is ${last.outcome} (${last.reason}); no Agreement was planned or signed`, label);
    assert.equal(Object.hasOwn(last, 'written'), false, label);
    ids.push(p.operationId);
  }
  assert.equal(published.length, Object.keys(providers).length, 'every provider ran');
  const report = opsHealth({ databasePath: h.config.databasePath, now: Date.now() });
  assert.equal(report.healthy, false);
  assert.deepEqual(report.stuck.map((s) => [s.purchaseId, s.outcome]).sort(), ids.map((id) => [id, 'seller-journal-not-read']).sort());
});

test('provider-restart: a server restarted without its Agreement-context provider records the plan read as not written; ops health raises no write alert', async (t) => {
  // Prepared while a provider was configured, so the purchase uses the Agreement context.
  let calls = 0;
  const provider = { authority: 'test-provider-restart-provider', resolve: async () => { calls += 1; return { disposition: 'indeterminate', reason: 'TEST unexpected provider read' }; } };
  const h = await startRestartableContextHarness({ chain: await startChainFixture(), agreementContext: provider });
  h.sellers = [];
  h.onClose(async () => { for (const s of h.sellers) await s.close(); });
  t.after(() => h.close());
  const seller = await addSeller(h, { listingId: 'provider-restart-no-provider' });
  const buyer = await linkedUser(h), account = h.app.services.accounts.walletOwner(buyer.wallet.address);
  const p = await tool(h, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, protocol: 'dacs-sr2-wallet-agreement', idempotencyKey: 'provider-restart-no-provider' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const token = tokenFrom(p.approvalUrl), path = `/portal/api/purchase/${p.operationId}/agreement/`;
  const identity = await portal(h, `${path}identity`, { token, address: buyer.wallet.address });
  await h.restart(null);
  const out = await portal(h, `${path}plan`, { token, signature: buyer.wallet.signHex(identity.signRequest.message) });
  assert.deepEqual([out.status, out.error, calls], [409, 'agreement_context_held', 0], JSON.stringify(out));
  const last = h.app.services.ops.get(account, p.operationId).state.protocol.attempts.at(-1);
  assert.deepEqual([last.step, last.outcome, last.reason, last.written], ['agreement-context', 'indeterminate', 'CONTEXT_PROVIDER_UNAVAILABLE: no operator Agreement context provider is configured', false]);
  const report = opsHealth({ databasePath: h.config.databasePath, now: Date.now() });
  assert.deepEqual(report.stuck, []);
  assert.equal(report.healthy, true);
  assert.equal(report.purchases.find((x) => x.purchaseId === p.operationId).outcome, 'unresolved-read');
});

// Fix 7: answers and thrown values the consumer cannot read. The provider ran, so each may follow a seller Vet write.
const throwing = (base, key) => Object.defineProperty(base, key, { enumerable: true, get() { throw new Error('TEST provider-controlled getter'); } });
const UNREADABLE = {
  'answers with a throwing reason getter': async () => throwing({ disposition: 'indeterminate' }, 'reason'),
  'answers with a throwing disposition getter': async () => throwing({}, 'disposition'),
  'answers present with a throwing value getter': async () => throwing({ disposition: 'present' }, 'value'),
  'answers with an object whose every read throws': async () => new Proxy({}, { get: (_, key) => { if (key === 'then') return undefined; throw new Error('TEST provider-controlled proxy'); } }),
  'answers with a reason that cannot be printed': async () => ({ disposition: 'rejected', reason: { toString() { throw new Error('TEST provider-controlled reason'); } } }),
  'throws a value that cannot be printed': async () => { throw Object.create(null); },
  'throws an error whose message getter throws': async () => { throw throwing(new Error(), 'message'); },
};

// Fix 8: answers whose disposition changes between reads. The consumer reads it
// once, so the first value decides; no later value reaches the result.
const changing = (first, then) => Object.assign(async () => {
  let reads = 0;
  return Object.defineProperty({ reason: 'TEST provider-controlled' }, 'disposition', { enumerable: true, get() { reads += 1; return reads === 1 ? first : then; } });
}, { outcome: first });
const unsaveable = { toJSON() { throw new Error('TEST provider-controlled value'); }, toUpperCase() { return 'TEST'; } };
const CHANGING = {
  'answers absent, then present': changing('absent', 'present'),
  'answers indeterminate, then present': changing('indeterminate', 'present'),
  'answers absent, then a value that cannot be saved': changing('absent', unsaveable),
  'answers rejected, then a value that cannot be saved': changing('rejected', unsaveable),
};

// Each purchase is held exactly as for any other provider failure, and ops health reads it from the live database.
async function expectUnreadableHeld(t, h, setProvider, listingId, cases = UNREADABLE) {
  t.after(() => h.close());
  const seller = await addSeller(h, { listingId });
  const ids = [];
  for (const [label, provider] of Object.entries(cases)) {
    let calls = 0;
    setProvider(async (input) => { calls += 1; return provider(input); });
    const buyer = await linkedUser(h), account = h.app.services.accounts.walletOwner(buyer.wallet.address);
    const p = await tool(h, buyer, 'prepare_purchase', { listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, protocol: 'dacs-sr2-wallet-agreement', idempotencyKey: `${listingId}-${ids.length}` });
    assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
    const token = tokenFrom(p.approvalUrl), path = `/portal/api/purchase/${p.operationId}/agreement/`;
    const identity = await portal(h, `${path}identity`, { token, address: buyer.wallet.address });
    const out = await portal(h, `${path}plan`, { token, signature: buyer.wallet.signHex(identity.signRequest.message) });
    assert.deepEqual([calls, out.status, out.error], [1, 409, 'agreement_context_held'], `${label}: ${JSON.stringify(out)}`);
    const o = h.app.services.ops.get(account, p.operationId), last = o.state.protocol.attempts.at(-1);
    assert.deepEqual([o.status, o.state.protocol.stage, o.state.protocol.planned, last?.step], ['agreement_pending', 'identity', undefined, 'agreement-context'], label);
    assert.equal(out.message, `the operator Agreement context is ${last.outcome} (${last.reason}); no Agreement was planned or signed`, label);
    assert.equal(Object.hasOwn(last, 'written'), false, label);
    if (provider.outcome) assert.equal(last.outcome, provider.outcome, label);
    ids.push(p.operationId);
  }
  const report = opsHealth({ databasePath: h.config.databasePath, now: Date.now() });
  assert.equal(report.healthy, false);
  assert.deepEqual(report.stuck.map((s) => [s.purchaseId, s.outcome]).sort(), ids.map((id) => [id, 'seller-journal-not-read']).sort());
}

test('provider-read: DEM Agreement context: an answer or failure the consumer cannot read is recorded as a possible write', async (t) => {
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  let resolveBuyer = null;
  const demDeliveryContext = demContext.createDemDeliveryContext({ authority: 'TEST-provider-read-unreadable', resolveBuyer: (input) => resolveBuyer(input),
    resolveSeller: async () => { throw new Error('TEST unexpected seller resolver'); } });
  const h = await startProtocolHarness({ demDeliveryContext, browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  await expectUnreadableHeld(t, h, (provider) => { resolveBuyer = provider; }, 'provider-read-dem-unreadable');
});

test('provider-read: operator Agreement context: an answer or failure the consumer cannot read is recorded as a possible write', async (t) => {
  let resolve = null;
  const h = await startRestartableContextHarness({ chain: await startChainFixture(), agreementContext: { authority: 'test-provider-read-unreadable', resolve: (input) => resolve(input) } });
  h.sellers = [];
  h.onClose(async () => { for (const s of h.sellers) await s.close(); });
  await expectUnreadableHeld(t, h, (provider) => { resolve = provider; }, 'provider-read-generic-unreadable');
});

test('provider-disposition: DEM Agreement context: an answer whose disposition changes between reads is recorded as a possible write', async (t) => {
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  let resolveBuyer = null;
  const demDeliveryContext = demContext.createDemDeliveryContext({ authority: 'TEST-provider-disposition-changing', resolveBuyer: (input) => resolveBuyer(input),
    resolveSeller: async () => { throw new Error('TEST unexpected seller resolver'); } });
  const h = await startProtocolHarness({ demDeliveryContext, browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  await expectUnreadableHeld(t, h, (provider) => { resolveBuyer = provider; }, 'provider-disposition-dem-changing', CHANGING);
});

test('provider-disposition: operator Agreement context: an answer whose disposition changes between reads is recorded as a possible write', async (t) => {
  let resolve = null;
  const h = await startRestartableContextHarness({ chain: await startChainFixture(), agreementContext: { authority: 'test-provider-disposition-changing', resolve: (input) => resolve(input) } });
  h.sellers = [];
  h.onClose(async () => { for (const s of h.sellers) await s.close(); });
  await expectUnreadableHeld(t, h, (provider) => { resolve = provider; }, 'provider-disposition-generic-changing', CHANGING);
});

test('provider-disposition: DEM seller context: an answer that is not a usable present answer is held as indeterminate', async () => {
  let answer = null;
  const capability = demContext.createDemDeliveryContext({ authority: 'TEST-provider-disposition-seller', resolveBuyer: async () => { throw new Error('TEST unexpected buyer resolver'); },
    resolveSeller: async () => answer });
  const resolve = () => demContext.resolveDemDeliverySellerContext(capability, { jobId: 'TEST-job', listing: { listingId: 'TEST-listing', listingVersion: 1 }, buyerBundle: {}, generatedAt: 0 });
  for (const [label, value] of [['present without a value', { disposition: 'present', value: 'TEST' }], ['an unknown disposition', { disposition: 'TEST-unknown' }]]) {
    answer = value;
    assert.deepEqual(await resolve(), { disposition: 'indeterminate', reason: 'DEM delivery seller context is malformed' }, label);
  }
});
