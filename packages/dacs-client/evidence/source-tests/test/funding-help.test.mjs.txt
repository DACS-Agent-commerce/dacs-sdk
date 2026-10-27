import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { OutboundError } from '../src/util/http.mjs';
import { buyerFundingError } from '../src/buyer-funding.mjs';
import { OperationError } from '../src/operations.mjs';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { linkedUser, toolRaw, portal, tokenFrom } from './helpers/flows.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { startOperatorPurchaseNode2 } from './helpers/devnet-operator-purchase-node2.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { portalHarness } from './helpers/portal-auto-harness.mjs';
import { flush } from './helpers/portal-auto-dom.mjs';
import { CookieJar, TestOAuthProvider } from './helpers/oauth.mjs';
import { auth } from '@modelcontextprotocol/client';
import { writeFile } from 'node:fs/promises';

installLoopbackOnlyGuard();
const base = { DACS_PUBLIC_ORIGIN: 'https://plugin.example', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(32) };
const faucet = 'https://faucet.demos.sh';
let n = 0;
const key = () => `funding-${++n}`;
const args = (seller, extra = {}) => ({ listingId: seller.published.listingId, version: 1, seller: seller.wallet.claim, protocol: 'dacs-pay-dem', idempotencyKey: key(), ...extra });
async function setup(t, env = {}) {
  const h = await startProtocolHarness({ env });
  t.after(() => h.close());
  return { h, buyer: await linkedUser(h), seller: await addSeller(h, { listingId: key() }) };
}
const refusal = (h, buyer, seller, extra) => toolRaw(h, buyer, 'prepare_purchase', args(seller, extra));
const noWrites = (h, seller) => {
  assert.deepEqual(h.anchors.faults.writes, []);
  assert.deepEqual(seller.state.requests, []);
  assert.deepEqual(externalAttempts, []);
};

test('funding URL defaults empty and accepts only credential-free https even with local HTTP enabled', () => {
  assert.equal(loadConfig(base).fundingHelpUrl, '');
  assert.equal(loadConfig({ ...base, DACS_FUNDING_HELP_URL: '' }).fundingHelpUrl, '');
  assert.equal(loadConfig({ ...base, DACS_FUNDING_HELP_URL: `${faucet}/` }).fundingHelpUrl, faucet);
  assert.equal(loadConfig({ ...base, DACS_FUNDING_HELP_URL: faucet }).fundingHelpUrl, faucet);
  // A path or query is kept exactly, including a final "/" inside a query value.
  for (const url of ['https://fund.example/?', 'https://fund.example/?token=abc/', 'https://fund.example/fund?redirect=/', 'https://fund.example/faucet/', 'https://fund.example/a%20b/?x=%2F&y=1']) {
    assert.equal(loadConfig({ ...base, DACS_FUNDING_HELP_URL: url }).fundingHelpUrl, url);
  }
  for (const url of ['http://faucet.demos.sh', 'http://127.0.0.1:9', 'javascript:alert(1)', 'data:text/plain,x', '/faucet', 'garbage', 'https://user:pass@example.com', 'https://example.com/#fragment', 'https://example.com/#', 'https://example.com/?a=1#']) {
    assert.throws(() => loadConfig({ ...base, DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_FUNDING_HELP_URL: url }), ConfigError, url);
  }
});

// Final review of the source change, finding 1: the runbook copies the deploy template as the
// live env file, so the template must not turn the funding link on.
test('the deploy template leaves the funding URL commented out: a deployment copied from it shows no faucet', () => {
  const template = readFileSync(new URL('../deploy/dacs-chatgpt.env.example', import.meta.url), 'utf8');
  assert.doesNotMatch(template, /^\s*DACS_FUNDING_HELP_URL\s*=/m, 'no active line');
  assert.match(template, /^# DACS_FUNDING_HELP_URL=https:\/\/faucet\.example\.com\/$/m, 'a commented placeholder');
  assert.match(template, /faucet URL your network coordinator confirms/);
  // The template's active settings, as a deployment reads them: the guidance is off.
  const active = Object.fromEntries(template.split('\n').filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line)).map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  assert.equal(Object.hasOwn(active, 'DACS_FUNDING_HELP_URL'), false);
  assert.equal(loadConfig({ ...base, DACS_FUNDING_HELP_URL: active.DACS_FUNDING_HELP_URL }).fundingHelpUrl, '');
  assert.doesNotMatch(readFileSync(new URL('../docs/CHATGPT-DEVELOPER-MODE.md', import.meta.url), 'utf8'), /faucet\.demos\.sh/, 'the docs name no unconfirmed faucet');
});

test('DEM formatting stays exact above Number precision', () => {
  const details = { priceOs: '9007199254740993000000001', buyerFeesOs: '2000000000', requiredOs: '9007199254740995000000001', balanceOs: '9007199254740995000000000' };
  const error = buyerFundingError(new OperationError('buyer_balance_insufficient', 'refused', details), { wallet: 'fixture-buyer', price: { amountOs: details.priceOs }, config: {}, network: 'demos-testnet' });
  assert.equal(error.buyerFunding.priceDem, '9007199254740993.000000001');
  assert.equal(error.buyerFunding.buyerFeesDem, '2');
  assert.equal(error.buyerFunding.requiredDem, '9007199254740995.000000001');
  assert.equal(error.buyerFunding.balanceDem, '9007199254740995');
  assert.equal(error.buyerFunding.shortfallDem, '0.000000001');
  const zero = { priceOs: '1', buyerFeesOs: '0', requiredOs: '1', balanceOs: '0' };
  const zeroError = buyerFundingError(new OperationError('buyer_balance_insufficient', 'refused', zero), { wallet: 'fixture-buyer', price: { amountOs: zero.priceOs }, config: {}, network: 'demos-testnet' });
  assert.equal(zeroError.buyerFunding.priceDem, '0.000000001');
  assert.equal(zeroError.buyerFunding.buyerFeesDem, '0');
  assert.equal(zeroError.buyerFunding.balanceDem, '0');
  assert.equal(zeroError.buyerFunding.shortfallDem, '0.000000001');
  assert.equal(zeroError.buyerFunding.message, 'The purchase needs 0.000000001 DEM (0.000000001 DEM price + 0 DEM buyer fee reserve); your balance is 0 DEM and your shortfall is 0.000000001 DEM.');
});

test('an amount that is not a whole non-negative OS value drops the funding block, never the refusal', () => {
  const ok = { priceOs: '1', buyerFeesOs: '0', requiredOs: '1', balanceOs: '0' };
  const cases = [
    ['buyer_balance_unavailable', undefined, '1.5'], ['buyer_balance_unavailable', undefined, '-1'], ['buyer_balance_unavailable', undefined, '1e9'],
    ['buyer_balance_insufficient', { ...ok, balanceOs: '-1' }, '1'], ['buyer_balance_insufficient', { ...ok, buyerFeesOs: '0.5' }, '1'], ['buyer_balance_insufficient', { ...ok, requiredOs: 'x' }, '1'],
    ['buyer_balance_insufficient', { ...ok, balanceOs: '2' }, '1'],
  ];
  for (const [code, details, amountOs] of cases) {
    const error = new OperationError(code, 'main refusal', details);
    let out;
    assert.doesNotThrow(() => { out = buyerFundingError(error, { wallet: 'fixture-buyer', price: { amountOs }, config: { fundingHelpUrl: faucet }, network: 'demos-testnet' }); }, JSON.stringify(details ?? amountOs));
    assert.equal(out, error);
    assert.equal(out.buyerFunding, undefined, JSON.stringify(details ?? amountOs));
    assert.deepEqual([out.code, out.message, out.details], [code, 'main refusal', details]);
  }
});

test('demo operator forwards the funding URL environment value into its runtime config', async (t) => {
  const previous = process.env.DACS_FUNDING_HELP_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.DACS_FUNDING_HELP_URL;
    else process.env.DACS_FUNDING_HELP_URL = previous;
  });
  process.env.DACS_FUNDING_HELP_URL = faucet;
  const h = await startOperatorPurchaseNode2({ listen: false, authorizeSellerApproval: async () => true });
  t.after(() => h.close());
  assert.equal(h.prepared.config.fundingHelpUrl, faucet);
  delete process.env.DACS_FUNDING_HELP_URL;
  await h.restart();
  assert.equal(h.prepared.config.fundingHelpUrl, '');
  assert.deepEqual(externalAttempts, []);
});

test('MCP gives exact shortfall and fee-only shortfall; empty URL keeps legacy text byte-identical and equality accepts', async (t) => {
  const { h, buyer, seller } = await setup(t, { DACS_FUNDING_HELP_URL: '' });
  h.chain.faults.fees = { networkFee: 2, rpcFee: 3, additionalFee: 4 };
  for (const [os, balance, shortfall] of [['0', '0', '12.5'], ['2499999999', '2.499999999', '10.000000001'], ['2500000000', '2.5', '10'], ['12499999999', '12.499999999', '0.000000001']]) {
    h.chain.setBalance(buyer.wallet.address, os);
    const result = await refusal(h, buyer, seller);
    const legacy = { error: 'buyer_balance_insufficient', message: `The buyer balance does not cover the purchase price plus buyer fees. Required 12.5 DEM (2.5 DEM price + 10 DEM buyer fee reserve); available ${balance} DEM. Fund the buyer wallet before continuing; no seller write or wallet approval was requested.`, details: { balanceOs: os, priceOs: '2500000000', buyerFeesOs: '10000000000', requiredOs: '12500000000' } };
    assert.equal(result.isError, true);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(legacy) }]);
    const { buyerFunding, ...unchanged } = result.structuredContent;
    assert.deepEqual(unchanged, legacy);
    assert.deepEqual(buyerFunding, {
      currency: 'DEM', network: 'demos-testnet', priceDem: '2.5', balance: 'known',
      buyerFeesDem: '10', requiredDem: '12.5', balanceDem: balance, shortfallDem: shortfall,
      message: `The purchase needs 12.5 DEM (2.5 DEM price + 10 DEM buyer fee reserve); your balance is ${balance} DEM and your shortfall is ${shortfall} DEM.`,
    });
  }
  noWrites(h, seller);
  h.chain.setBalance(buyer.wallet.address, '12500000000');
  const accepted = await refusal(h, buyer, seller);
  assert.equal(accepted.isError, undefined);
  assert.equal(accepted.structuredContent.status, 'agreement_pending');
  assert.equal(accepted.structuredContent.buyerFunding, undefined);
  noWrites(h, seller);
});

test('unknown balance on invalid reads, read failure and timeout never invents amounts; legacy text is unchanged', async (t) => {
  const { h, buyer, seller } = await setup(t);
  const chain = h.app.services.chain, original = chain.getAddressBalance;
  for (const error of [new OutboundError('invalid', 'inexact'), new OutboundError('unavailable', 'read failed'), new OutboundError('unavailable', 'request timed out')]) {
    chain.getAddressBalance = async () => { throw error; };
    const result = await refusal(h, buyer, seller);
    assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify({ error: 'buyer_balance_unavailable', message: 'The buyer balance or buyer fees could not be read exactly from the bound chain. Try again after the chain read is available; no seller write or wallet approval was requested.' }) }]);
    assert.deepEqual(result.structuredContent.buyerFunding, {
      currency: 'DEM', network: 'demos-testnet', priceDem: '2.5', balance: 'unknown',
      message: 'Your buyer balance is unknown; the price is 2.5 DEM and the balance or buyer fee reserve could not be read exactly.',
    });
  }
  chain.getAddressBalance = original;
  h.chain.faults.fees = {};
  const feeFailure = await refusal(h, buyer, seller);
  assert.equal(feeFailure.structuredContent.buyerFunding.balance, 'unknown');
  assert.equal(feeFailure.structuredContent.buyerFunding.shortfallDem, undefined);
  noWrites(h, seller);
});

test('native Agreement funding includes the same CREATE storage and action fee reserve as admission', async (t) => {
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  const h = await startProtocolHarness({ browserAgreement: { journal }, env: { DACS_FUNDING_HELP_URL: faucet, DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' } });
  t.after(() => h.close());
  const buyer = await linkedUser(h), seller = await addSeller(h, { listingId: key() });
  h.chain.setBalance(buyer.wallet.address, '9499999999');
  const result = await refusal(h, buyer, seller, { protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(result.structuredContent.buyerFunding.priceDem, '2.5');
  assert.equal(result.structuredContent.buyerFunding.buyerFeesDem, '7');
  assert.equal(result.structuredContent.buyerFunding.requiredDem, '9.5');
  assert.equal(result.structuredContent.buyerFunding.balanceDem, '9.499999999');
  assert.equal(result.structuredContent.buyerFunding.shortfallDem, '0.000000001');
  assert.deepEqual(memory.snapshot(), []);
  noWrites(h, seller);
});

test('configured guidance uses the selected linked buyer address and appears only on testnet networks', async (t) => {
  for (const network of ['demos-testnet', 'demos-devnet', 'demos-mainnet', 'fixture']) {
    const { h, buyer, seller } = await setup(t, { DACS_FUNDING_HELP_URL: `${faucet}/`, DACS_CHAIN_NETWORK: network });
    const second = createEphemeralWallet();
    h.app.services.accounts.linkWallet({ accountId: h.app.services.accounts.walletOwner(buyer.wallet.address), address: second.address, challengeId: key() });
    h.chain.setBalance(second.address, '0');
    const result = await refusal(h, buyer, seller, { walletAddress: second.address });
    const funding = result.structuredContent.buyerFunding;
    // The buyer's address comes only with the configured funding page.
    assert.equal(funding.buyerAddress, undefined);
    if (['demos-testnet', 'demos-devnet'].includes(network)) {
      assert.notEqual(funding.help.buyerAddress, seller.wallet.address);
      assert.notEqual(funding.help.buyerAddress, buyer.wallet.address);
      assert.deepEqual(funding.help, { url: faucet, buyerAddress: second.address });
      assert.equal(result.content[1].text, funding.message);
      assert.match(funding.message, /get testnet DEM at https:\/\/faucet.demos.sh and paste your buyer address/);
      assert.ok(funding.message.includes(second.address));
      assert.ok(!funding.message.includes(buyer.wallet.address));
      h.chain.setBalance(second.address, { missing: true });
      const unknown = await refusal(h, buyer, seller, { walletAddress: second.address });
      assert.equal(unknown.structuredContent.buyerFunding.balance, 'unknown');
      assert.deepEqual(unknown.structuredContent.buyerFunding.help, funding.help);
      assert.doesNotMatch(unknown.content[1].text, /shortfall/);
    } else {
      assert.equal(funding.help, undefined);
      assert.equal(result.content.length, 1);
      assert.ok(!JSON.stringify(result).includes(faucet));
      assert.ok(!JSON.stringify(funding).includes(second.address));
    }
    noWrites(h, seller);
  }
});

// Exercise the portal's actual API error, action-log and element functions
// without Chrome. The stand-in DOM refuses HTML parsing, so the log must
// render every message as a text node.
const page = readFileSync(new URL('../public/portal/portal.js', import.meta.url), 'utf8');
const domSource = page.slice(page.indexOf('const $ = (id)'), page.indexOf('// SIMULATED offline profile'));
const apiSource = page.slice(page.indexOf('async function api('), page.indexOf('// Re-check DACS steps'));
const runSource = page.slice(page.indexOf('const run = (fn)'), page.indexOf('// Action buttons lock'));
class FakeNode {}
class FakeText extends FakeNode {
  constructor(text) { super(); this.textContent = text; }
}
class FakeElement extends FakeNode {
  constructor(tag) { super(); this.tag = tag; this.children = []; this.className = ''; }
  append(...nodes) { for (const node of nodes) this.children.push(node instanceof FakeNode ? node : new FakeText(String(node))); }
  setAttribute() {}
  addEventListener() {}
  set innerHTML(_) { throw new Error('the portal log must not parse HTML'); }
  insertAdjacentHTML() { throw new Error('the portal log must not parse HTML'); }
  get textContent() { return this.children.map((child) => child.textContent).join(''); }
}
function portalPage(fetchImpl) {
  const logBox = new FakeElement('div');
  const document = { getElementById: (id) => (id === 'log' ? logBox : null), createElement: (tag) => new FakeElement(tag), createTextNode: (text) => new FakeText(text) };
  const fns = runInNewContext(`${domSource}\n${apiSource}\n${runSource}\n({ api, run })`, { fetch: fetchImpl, document, Node: FakeNode, showcaseReportView: false, Date: class { toLocaleTimeString() { return '00:00:00'; } } });
  return { ...fns, logBox };
}
function shownLines(logBox) {
  return logBox.children.map((p) => {
    assert.ok(p instanceof FakeElement && p.tag === 'p');
    assert.ok(p.children.every((child) => child instanceof FakeText), 'log lines hold text nodes only');
    assert.ok(p.textContent.startsWith('00:00:00 '));
    return { message: p.textContent.slice('00:00:00 '.length), cls: p.className };
  });
}
async function pageError(h, path, body) {
  const { api, run, logBox } = portalPage((url, init) => fetch(`${h.origin}${url}`, init));
  await run(() => api(path, body))();
  const shown = shownLines(logBox);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].cls, 'bad');
  return shown[0].message;
}

test('portal log renders a refusal carrying HTML as text', async () => {
  const payload = '<img src=x onerror=alert(1)>';
  const { api, run, logBox } = portalPage(async () => new Response(JSON.stringify({ error: 'buyer_balance_insufficient', message: payload, buyerFunding: { message: `${payload} https://fund.example/?a=<b>` } }), { status: 409 }));
  await run(() => api('/portal/api/x', {}))();
  const shown = shownLines(logBox);
  assert.deepEqual(shown, [{ message: `${payload} ${payload} https://fund.example/?a=<b>`, cls: 'bad' }]);
  // A refusal without a message still shows the status fallback, then the funding sentence.
  const bare = portalPage(async () => new Response(JSON.stringify({ error: 'buyer_balance_insufficient', buyerFunding: { message: 'Funding sentence.' } }), { status: 409 }));
  await bare.run(() => bare.api('/portal/api/x', {}))();
  assert.deepEqual(shownLines(bare.logBox), [{ message: 'request failed (409) Funding sentence.', cls: 'bad' }]);
});

test('portal and embedded-wallet host show exact refusal at identity and plan, with optional URL and unknown balance', async (t) => {
  for (const configured of [false, true]) {
    const { h, buyer, seller } = await setup(t, { DACS_FUNDING_HELP_URL: configured ? faucet : '' });
    h.chain.faults.fees = { networkFee: 1, rpcFee: 1 };
    const p = (await refusal(h, buyer, seller)).structuredContent, token = tokenFrom(p.approvalUrl);
    const path = `/portal/api/purchase/${p.operationId}/agreement/`;
    h.chain.setBalance(buyer.wallet.address, '5499999999');
    const body = { token, address: buyer.wallet.address };
    const identityRefusal = await portal(h, `${path}identity`, body);
    assert.equal(identityRefusal.error, 'buyer_balance_insufficient');
    const { status: httpStatus, buyerFunding: funding, ...legacy } = identityRefusal;
    assert.equal(httpStatus, 409);
    assert.equal(JSON.stringify(legacy), JSON.stringify({
      error: 'buyer_balance_insufficient',
      message: 'The buyer balance does not cover the purchase price plus buyer fees. Required 5.5 DEM (2.5 DEM price + 3 DEM buyer fee reserve); available 5.499999999 DEM. Fund the buyer wallet before continuing; no seller write or wallet approval was requested.',
      details: { balanceOs: '5499999999', priceOs: '2500000000', buyerFeesOs: '3000000000', requiredOs: '5500000000' },
    }));
    assert.equal(funding.shortfallDem, '0.000000001');
    assert.equal(identityRefusal.buyerFunding.buyerFeesDem, '3');
    const shown = await pageError(h, `${path}identity`, body);
    assert.ok(shown.includes(identityRefusal.buyerFunding.message));
    assert.equal(shown.includes(faucet), configured);
    if (configured) assert.ok(shown.includes(buyer.wallet.address));
    h.chain.setBalance(buyer.wallet.address, '5500000000');
    const identity = await portal(h, `${path}identity`, body);
    const planBody = { token, signature: buyer.wallet.signHex(identity.signRequest.message) };
    h.chain.setBalance(buyer.wallet.address, '0');
    const planRefusal = await portal(h, `${path}plan`, planBody);
    assert.equal(planRefusal.buyerFunding.shortfallDem, '5.5');
    assert.ok((await pageError(h, `${path}plan`, planBody)).includes(planRefusal.buyerFunding.message));
    h.chain.setBalance(buyer.wallet.address, { missing: true });
    const unknown = await portal(h, `${path}identity`, body);
    assert.equal(unknown.buyerFunding.balance, 'unknown');
    assert.equal(unknown.buyerFunding.shortfallDem, undefined);
    const unknownShown = await pageError(h, `${path}identity`, body);
    assert.match(unknownShown, /balance is unknown/);
    assert.doesNotMatch(unknownShown, /shortfall/);
    const status = await toolRaw(h, buyer, 'get_purchase_status', { operationId: p.operationId });
    assert.equal(status.structuredContent.status, 'agreement_pending');
    assert.equal(status.structuredContent.buyerFunding, undefined, 'refusal is transient and is not shown in purchase status');
    noWrites(h, seller);
  }
});

// Main's switches (readback cache, auto-advance, showcase, seller identities)
// leave the refusal exactly as with them off, and never cache the balance read.
test('refusal is unchanged with readback cache, auto-advance, showcase and seller identity switches on', async (t) => {
  const switches = { DACS_READBACK_CACHE: '1', DACS_PORTAL_AUTO_ADVANCE: 'on', DACS_SHOWCASE_LEDGER: '1', DACS_SHOWCASE_PUBLICATION_VIEW: '1', DACS_SHOWCASE_RECEIPT: 'on', DACS_SHOWCASE_WALKTHROUGH: 'on', DACS_SELLER_IDENTITIES: 'on' };
  const shown = [];
  for (const env of [{}, switches]) {
    const { h, buyer, seller } = await setup(t, { DACS_FUNDING_HELP_URL: faucet, ...env });
    h.chain.faults.fees = { networkFee: 1, rpcFee: 1 };
    h.chain.setBalance(buyer.wallet.address, '1');
    const first = await refusal(h, buyer, seller);
    h.chain.setBalance(buyer.wallet.address, '2');
    const second = await refusal(h, buyer, seller);
    assert.equal(second.structuredContent.buyerFunding.balanceDem, '0.000000002', 'the balance is read fresh, never cached');
    h.chain.setBalance(buyer.wallet.address, '5500000000');
    const p = (await refusal(h, buyer, seller)).structuredContent;
    h.chain.setBalance(buyer.wallet.address, '0');
    const page = await portal(h, `/portal/api/purchase/${p.operationId}/agreement/identity`, { token: tokenFrom(p.approvalUrl), address: buyer.wallet.address });
    const strip = (r) => JSON.parse(JSON.stringify(r).replaceAll(buyer.wallet.address, 'BUYER'));
    shown.push({ first: strip(first), second: strip(second), page: strip(page) });
    noWrites(h, seller);
  }
  assert.deepEqual(shown[1], shown[0]);
  assert.equal(shown[1].page.buyerFunding.shortfallDem, '5.5');
  assert.equal(shown[1].first.content[1].text, shown[1].first.structuredContent.buyerFunding.message);
});

// DACS_INTENT_APPROVAL=on (the source change): the Start route runs main's identity step, so
// it refuses with the same funding block, and the hooked portal.js keeps the
// api() line that shows it.
test('with DACS_INTENT_APPROVAL=on the Start route refuses exactly as identity does, and the hooked portal shows the funding sentence', async (t) => {
  for (const url of ['', faucet]) {
    const { h, buyer, seller } = await setup(t, { DACS_INTENT_APPROVAL: 'on', DACS_FUNDING_HELP_URL: url });
    h.chain.faults.fees = { networkFee: 1, rpcFee: 1 };
    const p = (await refusal(h, buyer, seller)).structuredContent, token = tokenFrom(p.approvalUrl), body = { token, address: buyer.wallet.address };
    h.chain.setBalance(buyer.wallet.address, '1');
    const start = await portal(h, `/portal/api/purchase/${p.operationId}/intent/start`, body);
    assert.equal(start.status, 409);
    assert.equal(start.buyerFunding.shortfallDem, '5.499999999');
    assert.equal(start.buyerFunding.help?.buyerAddress, url ? buyer.wallet.address : undefined);
    assert.deepEqual(start, await portal(h, `/portal/api/purchase/${p.operationId}/agreement/identity`, body));
    const served = await (await fetch(`${h.origin}/portal/assets/portal.js`)).text();
    assert.ok(served.includes("startIntent = await import('/portal/assets/intent/start.mjs')"), 'the Start hooks are in');
    assert.equal(served.split('data.buyerFunding?.message').length, 2, 'the funding line is served once');
    noWrites(h, seller);
  }
});

// Links a wallet through the operator's own OAuth callback (as closed-access-boundaries does).
async function linkOperatorAccount({ harness, wallet }) {
  const scope = 'dacs.account.read dacs.purchases.write', callbackUrl = `${harness.origin}/operator/oauth/callback`;
  class Provider extends TestOAuthProvider { get redirectUrl() { return callbackUrl; } get clientMetadata() { return { ...super.clientMetadata, redirect_uris: [callbackUrl] }; } }
  const provider = new Provider({ scope }), jar = new CookieJar();
  const follow = async (start) => {
    let url = new URL(start);
    for (let i = 0; i < 12; i++) {
      if (url.href.startsWith(callbackUrl)) return url;
      const response = await fetch(url, { redirect: 'manual', headers: { cookie: jar.header(url) } }); jar.store(response);
      const location = response.headers.get('location'); await response.body?.cancel();
      if (!location) return url; url = new URL(location, url);
    }
    throw new Error('TEST OAuth redirect bound exceeded');
  };
  assert.equal(await auth(provider, { serverUrl: harness.mcpUrl, scope }), 'REDIRECT');
  const page = await follow(provider.authorizationUrl), uid = /\/portal\/authorize\/([^/?#]+)/.exec(page.pathname)?.[1]; assert.ok(uid);
  const api = async (action, body) => {
    const url = `${harness.origin}/portal/authorize/${uid}/api/${action}`, response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', cookie: jar.header(url) }, body: JSON.stringify(body) });
    jar.store(response); const out = await response.json(); assert.equal(response.status, 200, JSON.stringify(out)); return out;
  };
  const challenge = await api('challenge', { address: wallet.address }), done = await api('complete', { challengeId: challenge.challengeId, signature: wallet.signHex(challenge.message) });
  const callback = await follow(done.redirectTo);
  assert.equal(await auth(provider, { serverUrl: harness.mcpUrl, authorizationCode: callback.searchParams.get('code'), iss: callback.searchParams.get('iss'), scope }), 'AUTHORIZED');
  return { provider };
}

// The operator's closed-access guard (the source change) runs before the balance check: a
// foreign buyer sees only buyer_access_closed. With open buyer access the
// same buyer reaches the check and gets the demos-devnet funding guidance.
test('operator: open buyer access shows devnet funding guidance; closed access refuses first with none', { timeout: 300000 }, async (t) => {
  const previous = process.env.DACS_FUNDING_HELP_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.DACS_FUNDING_HELP_URL;
    else process.env.DACS_FUNDING_HELP_URL = previous;
  });
  process.env.DACS_FUNDING_HELP_URL = faucet;
  const h = await startOperatorPurchaseNode2({ openBuyerAccess: true, sellerApproval: { mode: 'policy' }, authorizeSellerApproval: async () => true });
  t.after(() => h.close());
  const harness = { origin: h.config.publicOrigin, mcpUrl: `${h.config.publicOrigin}/mcp` };
  const wallet = createEphemeralWallet(), { provider } = await linkOperatorAccount({ harness, wallet });
  assert.notEqual(wallet.claim, h.prepared.operatorEvidence.buyer);
  const prepare = () => {
    h.application.services.chain.getAddressBalance = async () => 0n;
    return toolRaw(harness, { provider }, 'prepare_purchase', { listingId: h.config.listing.listingId, version: 1, seller: h.prepared.operatorEvidence.seller, idempotencyKey: key(), protocol: 'dacs-sr2-wallet-agreement' });
  };
  const open = await prepare();
  assert.equal(open.structuredContent?.error, 'buyer_balance_insufficient', JSON.stringify(open));
  const funding = open.structuredContent.buyerFunding;
  assert.equal(funding.network, 'demos-devnet');
  assert.equal(funding.balanceDem, '0');
  assert.equal(funding.shortfallDem, funding.requiredDem);
  assert.deepEqual(funding.help, { url: faucet, buyerAddress: wallet.address });
  assert.equal(open.content[1].text, funding.message);
  h.config.openBuyerAccess = false;
  await writeFile(h.configPath, `${JSON.stringify(h.config)}\n`, { mode: 0o600 });
  await h.restart();
  assert.equal(h.prepared.operatorEvidence.openBuyerAccess, false);
  const closed = await prepare();
  assert.equal(closed.isError, true);
  assert.equal(JSON.parse(closed.content[0].text).error, 'buyer_access_closed');
  assert.equal(closed.structuredContent, undefined);
  assert.equal(closed.content.length, 1);
  assert.ok(!JSON.stringify(closed).includes(faucet));
});

// DACS_PORTAL_AUTO_ADVANCE=on: the portal answers every OperationError with
// 409, but only ambiguous conflicts are rechecked. A balance refusal is the
// buyer's to act on, so the page shows it (with the funding sentence) and stops.
test('auto-advancing purchase page shows a balance refusal at identity or plan instead of rechecking silently; an unreadable balance is shown, then read back', async () => {
  // the source change distinguishes an unplanned identity stage from a saved Agreement plan.
  const held = { status: 'agreement_pending', autoAdvance: { requiresSignature: true }, evidence: { protocol: { stage: 'identity', limits: { payment: 'held' } } } };
  const refused = (code) => ({ ok: false, status: 409, data: { error: code, message: `TEST ${code}`, buyerFunding: { message: `TEST funding for ${code} at https://fund.example/` } } });
  const identity = { ok: true, data: { signRequest: { message: 'TEST-identity' } } };
  for (const [step, code] of [['identity', 'buyer_balance_insufficient'], ['identity', 'buyer_balance_unavailable'], ['plan', 'buyer_balance_insufficient']]) {
    const h = portalHarness(held, async (path, _body, enrich) => path.endsWith(`/agreement/${step}`) ? refused(code) : path.endsWith('/agreement/identity') ? identity : { ok: true, data: enrich(held) });
    await h.start();
    const reads = h.requests.length;
    await h.document.getElementById('flow').querySelector('button[data-action]').fire('click');
    await flush();
    const log = h.document.getElementById('log').text;
    assert.ok(log.includes(`TEST ${code} TEST funding for ${code} at https://fund.example/`), `${step} ${code}: ${log}`);
    // An unreadable balance is a transient chain read failure (retryable): after
    // its text the page reads the purchase state back, and asks the wallet nothing.
    const transient = code === 'buyer_balance_unavailable';
    if (transient) assert.match(log, /Checking purchase state/); else assert.doesNotMatch(log, /Checking purchase state/);
    assert.equal(h.wallet.length, step === 'plan' ? 1 : 0, 'only the identity presentation reaches the wallet, and only before a plan refusal');
    if (transient) { await h.clock.advance(500); assert.ok(h.requests.slice(reads).some((r) => r.path.endsWith('/auto/recheck'))); }
    else assert.ok(!h.requests.slice(reads).some((r) => r.path.endsWith('/auto/recheck')));
    // At identity nothing was asked, so the page waits for the buyer. At plan the
    // tab journal already holds the asked signature, so main's readback-only rule
    // keeps reading back (and never asks the wallet again).
    if (step === 'identity') assert.equal(h.clock.timers.size, 0, 'no automatic recheck is scheduled');
    else {
      await h.clock.advance(500);
      assert.match(h.document.getElementById('flow').text, /will not be requested again/);
      assert.equal(h.wallet.length, 1);
    }
    h.destroy();
  }
});

// DACS_COMMIT_ON_SIGNATURE=on (the source change): the seller's early commitment starts only
// when the browser broker records a signed CREATE, and the broker needs a
// planned purchase. Planning passes the balance check first, so a low balance
// is refused at prepare, identity and plan exactly as with the switch off, and
// nothing is journaled, signed or sent to the seller.
test('with DACS_COMMIT_ON_SIGNATURE=on the balance refusal fires at prepare, identity and plan exactly as off, and no CREATE or early commitment can start', async (t) => {
  const shown = [];
  for (const commit of ['off', 'on']) {
    const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
    const h = await startProtocolHarness({ browserAgreement: { journal }, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_FUNDING_HELP_URL: faucet, DACS_COMMIT_ON_SIGNATURE: commit } });
    t.after(() => h.close());
    assert.equal(h.config.commitOnSignature, commit === 'on');
    const buyer = await linkedUser(h), seller = await addSeller(h, { listingId: key() }), sr2 = { protocol: 'dacs-sr2-wallet-agreement' };
    h.chain.faults.fees = { networkFee: 1, rpcFee: 1 };
    const low = () => h.chain.setBalance(buyer.wallet.address, '1'), funded = () => h.chain.setBalance(buyer.wallet.address, '100000000000');
    low();
    const prepared = await refusal(h, buyer, seller, sr2);
    funded();
    const p = (await refusal(h, buyer, seller, sr2)).structuredContent, token = tokenFrom(p.approvalUrl);
    const path = `/portal/api/purchase/${p.operationId}/agreement/`, body = { token, address: buyer.wallet.address };
    low();
    const identityRefusal = await portal(h, `${path}identity`, body);
    funded();
    const identity = await portal(h, `${path}identity`, body);
    const planBody = { token, signature: buyer.wallet.signHex(identity.signRequest.message) };
    low();
    const planRefusal = await portal(h, `${path}plan`, planBody);
    const challenge = await fetch(`${h.origin}/portal/api/purchase/${p.operationId}/browser-agreement/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body) });
    const broker = { status: challenge.status, ...(await challenge.json()) };
    for (const refused of [prepared.structuredContent, identityRefusal, planRefusal]) {
      assert.equal(refused.error, 'buyer_balance_insufficient', JSON.stringify(refused));
      assert.deepEqual(refused.buyerFunding.help, { url: faucet, buyerAddress: buyer.wallet.address });
    }
    assert.deepEqual([identityRefusal.status, planRefusal.status], [409, 409]);
    assert.deepEqual([broker.status, broker.error], [409, 'broker_operation_mismatch'], 'the broker that would notify the seller refuses an unplanned purchase');
    const account = h.app.services.accounts.walletOwner(buyer.wallet.address);
    assert.equal(h.app.services.ops.get(account, p.operationId).state.protocol.planned, undefined);
    assert.deepEqual(memory.snapshot(), [], 'no CREATE was journaled');
    noWrites(h, seller);
    const strip = (r) => JSON.parse(JSON.stringify(r).replaceAll(buyer.wallet.address, 'BUYER'));
    shown.push(strip({ prepared, identityRefusal, planRefusal, broker }));
  }
  assert.deepEqual(shown[1], shown[0]);
});

// The demo operator with DACS_COMMIT_ON_SIGNATURE=on (the source change) still refuses a low
// balance with the funding block. Its runtime config never turns the auto page
// on, so the source change's operator_stopping 503 cannot reach the auto page's refusal list.
test('operator with DACS_COMMIT_ON_SIGNATURE=on refuses a low balance at prepare and identity with funding guidance and serves no auto page', { timeout: 300000 }, async (t) => {
  const names = ['DACS_FUNDING_HELP_URL', 'DACS_COMMIT_ON_SIGNATURE', 'DACS_PORTAL_AUTO_ADVANCE'], previous = names.map((name) => process.env[name]);
  t.after(() => names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; }));
  Object.assign(process.env, { DACS_FUNDING_HELP_URL: faucet, DACS_COMMIT_ON_SIGNATURE: 'on', DACS_PORTAL_AUTO_ADVANCE: 'on' });
  const h = await startOperatorPurchaseNode2({ openBuyerAccess: true, sellerApproval: { mode: 'policy' }, authorizeSellerApproval: async () => true });
  t.after(() => h.close());
  assert.equal(h.prepared.config.commitOnSignature, true);
  assert.equal(h.prepared.config.portalAutoAdvance, 'off');
  const harness = { origin: h.config.publicOrigin, mcpUrl: `${h.config.publicOrigin}/mcp` };
  const wallet = createEphemeralWallet(), { provider } = await linkOperatorAccount({ harness, wallet });
  const balance = (os) => { h.application.services.chain.getAddressBalance = async () => os; };
  const prepare = () => toolRaw(harness, { provider }, 'prepare_purchase', { listingId: h.config.listing.listingId, version: 1, seller: h.prepared.operatorEvidence.seller, idempotencyKey: key(), protocol: 'dacs-sr2-wallet-agreement' });
  balance(0n);
  const refused = await prepare();
  assert.equal(refused.structuredContent?.error, 'buyer_balance_insufficient', JSON.stringify(refused));
  assert.deepEqual(refused.structuredContent.buyerFunding.help, { url: faucet, buyerAddress: wallet.address });
  balance(10n ** 12n);
  const p = (await prepare()).structuredContent;
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const page = await (await fetch(p.approvalUrl.split('#')[0])).text();
  assert.ok(page.includes('/portal/assets/portal.js') && !page.includes('auto-portal.js'), 'the operator serves the manual purchase page');
  balance(0n);
  const identity = await portal(harness, `/portal/api/purchase/${p.operationId}/agreement/identity`, { token: tokenFrom(p.approvalUrl), address: wallet.address });
  assert.deepEqual([identity.status, identity.error], [409, 'buyer_balance_insufficient'], JSON.stringify(identity));
  assert.equal(identity.buyerFunding.network, 'demos-devnet');
  assert.deepEqual(identity.buyerFunding.help, { url: faucet, buyerAddress: wallet.address });
});
