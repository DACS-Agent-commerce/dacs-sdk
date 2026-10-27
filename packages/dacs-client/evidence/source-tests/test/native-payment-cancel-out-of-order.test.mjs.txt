// Purchases approved out of order, with both unpaid-purchase limits raised to
// 2 (their default of 1 allows one open purchase per wallet): purchases A and B
// from the same seller at the same price both have their Agreement CREATE on
// chain before A is approved, so A's payment nonce follows B's CREATE. Once A
// is cancelled, B's payment would carry A's cancelled settlement terms (payer,
// nonce, payee, amount). Sent, it would also settle A, so the operator's source
// refuses it; the plugin refuses it before the handoff, so nothing is offered
// to the wallet, B stays approved and cancels, and a purchase prepared again
// pays at a new nonce.
//
// The browser side is the shipped portal.js pay() (run from its source) with
// the real embedded wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { startDevnetAgreementTransportHarness } = await import('./helpers/devnet-agreement-transport-harness.mjs');
const { startDevnetAgreementTransportSeller } = await import('./helpers/devnet-agreement-transport-seller.mjs');
const { createSdkWalletSession, createDevnetAgreementWalletTransport } = await import('../public/portal/embedded-wallet/sdk-provider.mjs');
const { createOfflineAgreementBrokerClient } = await import('../public/portal/offline-agreement-broker.mjs');
const { linkPackagedWallet } = await import('./helpers/offline-agreement-fixture.mjs');
const { tool, tokenFrom } = await import('./helpers/flows.mjs');
const runtime = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

// The portal's pay() and the wallet helpers it calls, from the shipped source.
const portalSource = readFileSync(new URL('../public/portal/portal.js', import.meta.url), 'utf8');
const slice = (from, to) => { const start = portalSource.indexOf(from), end = portalSource.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return portalSource.slice(start, end); };
const PAY_SOURCE = `${slice('function envelopeError(res) {', 'async function connect()')}${slice('function findHash(value', '// ---------------- server API')}${slice('  async function pay(view) {', '  render(await api(`/portal/api/purchase/${id}/view`')}; pay`;

// The wallet's source binding requests (sdk-provider.mjs bindingCall).
const BINDING_PATH = '/portal/api/devnet-native-wallet-binding';
const wire = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (typeof url !== 'string' || new URL(url).pathname !== BINDING_PATH) return realFetch(url, options);
  const r = await realFetch(url, options);
  wire.push({ phase: JSON.parse(options.body).phase, status: r.status, error: (await r.clone().json()).error ?? null });
  return r;
};

const TWO_OPEN = { DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT: '2', DACS_MAX_UNPAID_PURCHASES_PER_WALLET: '2' };
const PAYMENT_TERMS_CANCELLED = 'This payment would carry the same terms as a cancelled purchase\'s payment (this wallet, its nonce, the payee and the amount), so it was not offered to your wallet for signing and nothing was sent. Cancel this purchase (cancel_wallet_handoff) and prepare it again: the new purchase pays at a new nonce.';

// One buyer wallet and one seller on a fresh harness. purchase() runs main's
// per-step Start to awaiting_approval and returns that purchase; the other
// steps take the purchase they act on.
async function world(t) {
  const h = await startDevnetAgreementTransportHarness({ env: TWO_OPEN });
  t.after(() => h.close());
  globalThis.location = new URL(h.origin);
  const seller = await startDevnetAgreementTransportSeller(h, { listingId: `out-of-order-${Date.now()}`, durable: true });
  const transactionTransport = createDevnetAgreementWalletTransport(await h.profile());
  const api = async (path, body) => {
    const r = await realFetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body ?? {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.message || `request failed (${r.status})`), { code: data.error });
    return data;
  };
  // The wallet's anchor journal is the broker's of the purchase being worked on.
  const x = { h, api, dialogs: [], broker: null, rendered: [] };
  const brokerJournal = { get: (k) => x.broker.anchorJournal.get(k), put: (k, v) => x.broker.anchorJournal.put(k, v), withWalletLock: (k, work) => x.broker.anchorJournal.withWalletLock(k, work) };
  const session = createSdkWalletSession({ DemosCtor: runtime.Demos, IdentitiesCtor: runtime.Identities, validateMnemonic: runtime.validateMnemonic, transactionTransport, anchorJournal: brokerJournal,
    approve: async (request) => { x.dialogs.push(request.method); return true; } });
  await session.create();
  t.after(() => session.lock());
  x.address = session.getPublicAccount().address;
  x.buyer = await linkPackagedWallet(h, session);
  const sign = async (m) => (await session.request({ method: 'sign', params: [m] })).data.signature;
  x.purchase = async () => {
    const prepared = await tool(h, x.buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `out-of-order-${Date.now()}-${Math.random()}`, protocol: 'dacs-sr2-wallet-agreement' });
    const p = { id: prepared.operationId, token: tokenFrom(prepared.approvalUrl) };
    p.broker = x.broker = createOfflineAgreementBrokerClient({ id: p.id, token: p.token, api });
    const identity = await api(`/portal/api/purchase/${p.id}/agreement/identity`, { token: p.token, address: x.address });
    const planned = await api(`/portal/api/purchase/${p.id}/agreement/plan`, { token: p.token, signature: await sign(identity.signRequest.message) });
    const agreementSignature = await sign(planned.signRequest.agreementMessage);
    await p.broker.authenticate({ address: x.address, sign });
    await api(`/portal/api/purchase/${p.id}/agreement/sign`, { token: p.token, agreementSignature });
    await p.broker.approveOne(session);
    let view;
    for (let i = 0; i < 160; i++) { view = await api(`/portal/api/purchase/${p.id}/protocol/recheck`, { token: p.token }); if (!view.poll?.pending) break; await new Promise((r) => setTimeout(r, 250)); }
    assert.equal(view.status, 'awaiting_approval', JSON.stringify(view.evidence?.protocol?.lastAttempt ?? view.status));
    return p;
  };
  x.approve = async (p) => {
    const challenge = await api(`/portal/api/purchase/${p.id}/challenge`, { token: p.token, address: x.address });
    return api(`/portal/api/purchase/${p.id}/approve`, { token: p.token, challengeId: challenge.challengeId, signature: await sign(challenge.message) });
  };
  // The portal's pay(view), as the Approve button runs it after approve.
  const provider = { request: async (request) => session.request(request) };
  x.pay = (p, view) => { x.broker = p.broker; return vm.runInNewContext(PAY_SOURCE, { provider, api, render: (v) => x.rendered.push(v), log: () => {}, needPaymentNetwork: () => {}, id: p.id, token: p.token, offlineAgreementBroker: p.broker })(view); };
  x.view = (p) => api(`/portal/api/purchase/${p.id}/view`, { token: p.token });
  x.cancel = (p) => tool(h, x.buyer, 'cancel_wallet_handoff', { operationId: p.id });
  x.broadcasts = () => h.chain.record.broadcasts.length;
  x.nodeCalls = (extra) => h.requests.filter((r) => r.extra === extra).length;
  x.mark = () => ({ wire: wire.length, confirms: x.nodeCalls('confirmTx'), sends: x.nodeCalls('broadcastTx'), broadcasts: x.broadcasts() });
  x.phases = (m) => wire.slice(m.wire).map((w) => `${w.phase}:${w.status}${w.error ? `:${w.error}` : ''}`);
  return x;
}

test('out of order (both unpaid-purchase limits at 2): B\'s payment would carry cancelled A\'s settlement terms, so it is refused before signing; nothing is offered to the wallet or sent, B stays approved and cancels, and a purchase prepared again pays at a new nonce and settles', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  const a = await x.purchase(), b = await x.purchase();
  const handoffA = await x.approve(a);
  assert.equal(handoffA.status, 'payment_handoff');
  const cancelA = await x.cancel(a);
  assert.deepEqual([cancelA.cancelled, cancelA.status], [true, 'cancelled'], JSON.stringify(cancelA));
  const m = x.mark(), dialogs = x.dialogs.length;
  const approvedB = await x.approve(b);
  assert.deepEqual([approvedB.status, approvedB.payload, approvedB.refusal], ['approved', null, PAYMENT_TERMS_CANCELLED], 'refused before the handoff: B stays approved');
  await assert.rejects(x.pay(b, approvedB), (e) => e.message === PAYMENT_TERMS_CANCELLED, 'the page says why');
  // Re-opening the link asks again and is refused again: no handoff is saved.
  const again = await x.api(`/portal/api/purchase/${b.id}/handoff`, { token: b.token });
  assert.deepEqual([again.status, again.payload, again.refusal], ['approved', null, PAYMENT_TERMS_CANCELLED]);
  assert.deepEqual(x.phases(m), [], 'nothing reached the operator\'s source: no lease, nothing signed');
  assert.deepEqual(x.dialogs.slice(dialogs), ['sign'], 'only B\'s approval signature: no transfer dialog');
  assert.equal(x.nodeCalls('confirmTx'), m.confirms);
  assert.equal(x.nodeCalls('broadcastTx'), m.sends);
  assert.equal(x.broadcasts(), m.broadcasts, 'nothing was sent');
  const cancelB = await x.cancel(b);
  assert.deepEqual([cancelB.cancelled, cancelB.status], [true, 'cancelled'], JSON.stringify(cancelB));
  // The buyer's next purchase is not blocked. Its Agreement CREATE takes the
  // cancelled nonce, and its payment (same payee and amount) the next one.
  const c = await x.purchase();
  const handoffC = await x.approve(c);
  assert.equal(handoffC.status, 'payment_handoff');
  assert.equal(handoffC.payload.content.nonce, handoffA.payload.content.nonce + 1, 'a new nonce');
  assert.deepEqual([handoffC.payload.content.to, handoffC.payload.content.amount], [handoffA.payload.content.to, handoffA.payload.content.amount]);
  const before = x.broadcasts();
  await x.pay(c, handoffC);
  assert.equal(x.rendered.at(-1).status, 'settled_verified');
  assert.equal(x.broadcasts(), before + 1, 'the one payment');
  assert.deepEqual([(await x.view(a)).status, (await x.view(b)).status], ['cancelled', 'cancelled'], 'A and B stay cancelled');
});
