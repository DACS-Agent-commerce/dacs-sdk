// Main's separate-dialog native payment on the source-pinned devnet transport:
// cancelling the purchase (cancel_wallet_handoff) and sending its transfer
// exclude each other at the operator's source, under the payer's lane lock. A
// cancellation the source accepts is kept in its durable journal before
// cancelled: true is answered, and from then on the source refuses every
// transfer with its settlement terms (payer lane, nonce, payee, amount; the
// digest of the exact payload the plugin prepared is kept as evidence) at the
// signature lease (the wallet names its transfer there), at confirmTx and at
// the broadcast claim, also after a restart and in another process on the same
// journal. Once the source, in any process, has claimed the transfer (a
// signature lease naming it is claimed durably; one naming nothing claims at
// confirmTx) the purchase is not cancelled and stays readback-only. The
// buyer's next write on the same lane, and a transfer with other terms, are
// unaffected. A live purchase whose transfer is refused for another purchase's
// cancellation stays cancellable.
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
const { createSdkWalletSession, createDevnetAgreementWalletTransport, nativePayloadDigest } = await import('../public/portal/embedded-wallet/sdk-provider.mjs');
const { createOfflineAgreementBrokerClient } = await import('../public/portal/offline-agreement-broker.mjs');
const { linkPackagedWallet } = await import('./helpers/offline-agreement-fixture.mjs');
const { tool, toolRaw, tokenFrom } = await import('./helpers/flows.mjs');
const { openDurableWalletJournal } = await import('../src/wallet/durable-journal.mjs');
const { createDevnetAgreementTransport } = await import('../src/wallet/devnet-native-transport.mjs');
const runtime = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

// The portal's pay() and the wallet helpers it calls, from the shipped source.
const portalSource = readFileSync(new URL('../public/portal/portal.js', import.meta.url), 'utf8');
const slice = (from, to) => { const start = portalSource.indexOf(from), end = portalSource.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return portalSource.slice(start, end); };
const PAY_SOURCE = `${slice('function envelopeError(res) {', 'async function connect()')}${slice('function findHash(value', '// ---------------- server API')}${slice('  async function pay(view) {', '  render(await api(`/portal/api/purchase/${id}/view`')}; pay`;

// The wallet's source binding requests (sdk-provider.mjs bindingCall), with
// the source's answers. around(phase, body) runs before each goes out (and may
// change its body); after(phase, status) once it is answered.
const BINDING_PATH = '/portal/api/devnet-native-wallet-binding';
const wire = [];
const hooks = { around: null, after: null };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (typeof url !== 'string' || new URL(url).pathname !== BINDING_PATH) return realFetch(url, options);
  const body = JSON.parse(options.body);
  await hooks.around?.(body.phase, body);
  const r = await realFetch(url, { ...options, body: JSON.stringify(body) });
  const answer = await r.clone().json();
  wire.push({ phase: body.phase, status: r.status, error: answer.error ?? null, transfer: body.transfer ?? null });
  await hooks.after?.(body.phase, r.status);
  return r;
};

const CANCELLED_TEXT = 'This purchase was cancelled. The operator refused this attempt at its transfer, so it was not sent. An earlier attempt may have been sent; the purchase status reads it back.';
const TERMS_CANCELLED_TEXT = 'The operator refused this attempt at its transfer, so it was not sent: the transfer has the same terms as a cancelled purchase\'s payment. This purchase was not cancelled. Cancel it (cancel_wallet_handoff) and prepare it again: the new purchase pays at a new nonce.';
const MAY_BE_ON_ITS_WAY = (id) => `Not cancelled: the wallet had already started sending this payment, so it may be on its way. ${id} is read back only (get_purchase_status, verify_deal); nothing is ever resent.`;
const told = (e) => e.message === CANCELLED_TEXT;
// The transfer a handoff's wallet names at its lease, and the source keeps:
// its terms and the digest of its exact prepared payload.
const named = async ({ payload, terms }) => ({ nonce: payload.content.nonce, to: payload.content.to.toLowerCase(), amountOs: terms.price.amountOs, payloadDigest: await nativePayloadDigest(payload.content) });
// The same settlement terms in another payload: the cancelled payment
// re-signed at another time, or with its payee in upper case. Either settles
// the cancelled purchase if it is sent.
const sameTermsOtherPayload = (payload) => ({ ...payload, content: { ...payload.content, timestamp: payload.content.timestamp + 1 } });
const upperPayee = (payload) => {
  const to = `0x${payload.content.to.slice(2).toUpperCase()}`;
  return { ...payload, content: { ...payload.content, to, data: ['native', { ...payload.content.data[1], args: [to, payload.content.data[1].args[1]] }] } };
};

// One buyer wallet and one seller on a fresh harness; purchase() runs main's
// per-step Start to awaiting_approval, approve() main's approval signature.
async function world(t) {
  const h = await startDevnetAgreementTransportHarness();
  t.after(() => h.close());
  t.after(() => { hooks.around = null; hooks.after = null; });
  globalThis.location = new URL(h.origin);
  const seller = await startDevnetAgreementTransportSeller(h, { listingId: `cancel-send-${Date.now()}`, durable: true });
  const transactionTransport = createDevnetAgreementWalletTransport(await h.profile());
  const api = async (path, body) => {
    const r = await realFetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body ?? {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.message || `request failed (${r.status})`), { code: data.error });
    return data;
  };
  const x = { h, seller, api, dialogs: [], onTransferDialog: null, broker: null, rendered: [] };
  const brokerJournal = { get: (k) => x.broker.anchorJournal.get(k), put: (k, v) => x.broker.anchorJournal.put(k, v), withWalletLock: (k, work) => x.broker.anchorJournal.withWalletLock(k, work) };
  const session = createSdkWalletSession({ DemosCtor: runtime.Demos, IdentitiesCtor: runtime.Identities, validateMnemonic: runtime.validateMnemonic, transactionTransport, anchorJournal: brokerJournal,
    approve: async (request) => { x.dialogs.push(request.method); if (request.method === 'sendTransaction' && request.content?.action === 'native DEM transfer') await x.onTransferDialog?.(); return true; } });
  await session.create();
  t.after(() => session.lock());
  x.session = session;
  x.address = session.getPublicAccount().address;
  x.buyer = await linkPackagedWallet(h, session);
  x.sign = async (m) => (await session.request({ method: 'sign', params: [m] })).data.signature;
  x.purchase = async () => {
    const prepared = await tool(h, x.buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `cancel-send-${Date.now()}-${Math.random()}`, protocol: 'dacs-sr2-wallet-agreement' });
    const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl);
    x.id = id; x.token = token;
    x.broker = createOfflineAgreementBrokerClient({ id, token, api });
    const identity = await api(`/portal/api/purchase/${id}/agreement/identity`, { token, address: x.address });
    const planned = await api(`/portal/api/purchase/${id}/agreement/plan`, { token, signature: await x.sign(identity.signRequest.message) });
    const agreementSignature = await x.sign(planned.signRequest.agreementMessage);
    await x.broker.authenticate({ address: x.address, sign: x.sign });
    await api(`/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature });
    await x.broker.approveOne(session);
    let view;
    for (let i = 0; i < 160; i++) { view = await api(`/portal/api/purchase/${id}/protocol/recheck`, { token }); if (!view.poll?.pending) break; await new Promise((r) => setTimeout(r, 250)); }
    assert.equal(view.status, 'awaiting_approval', JSON.stringify(view.evidence?.protocol?.lastAttempt ?? view.status));
    return id;
  };
  x.approve = async () => {
    const challenge = await api(`/portal/api/purchase/${x.id}/challenge`, { token: x.token, address: x.address });
    return api(`/portal/api/purchase/${x.id}/approve`, { token: x.token, challengeId: challenge.challengeId, signature: await x.sign(challenge.message) });
  };
  // The portal's pay(handoff), as the Approve button runs it after approve.
  const provider = { request: async (request) => { const answer = await session.request(request); x.wallet = answer; return answer; } };
  x.pay = (handoff) => vm.runInNewContext(PAY_SOURCE, { provider, api, render: (v) => x.rendered.push(v), log: () => {}, needPaymentNetwork: () => {}, id: x.id, token: x.token, offlineAgreementBroker: x.broker })(handoff);
  x.view = () => api(`/portal/api/purchase/${x.id}/view`, { token: x.token });
  x.cancel = () => tool(h, x.buyer, 'cancel_wallet_handoff', { operationId: x.id });
  x.broadcasts = () => h.chain.record.broadcasts.length;
  x.nodeCalls = (extra) => h.requests.filter((r) => r.extra === extra).length;
  x.mark = () => ({ wire: wire.length, confirms: x.nodeCalls('confirmTx'), sends: x.nodeCalls('broadcastTx'), broadcasts: x.broadcasts() });
  x.phases = (m) => wire.slice(m.wire).map((w) => `${w.phase}:${w.status}${w.error ? `:${w.error}` : ''}`);
  x.nothingSent = (m) => {
    assert.equal(x.broadcasts(), m.broadcasts, 'nothing was broadcast');
    assert.equal(x.nodeCalls('broadcastTx'), m.sends, 'no broadcast reached the node');
  };
  // Another process on the same source journal: its own connection to the file,
  // and its own source, with no lease in its memory.
  x.otherJournal = () => { const j = openDurableWalletJournal({ path: h.journal.path, mode: 'open', expectedJournalId: h.journal.journalId }); t.after(() => j.close()); return j; };
  x.otherSource = () => { const other = createDevnetAgreementTransport({ expected: h.expected, journal: x.otherJournal(), transportOwner: noConnection }); t.after(() => other.close()); return other; };
  x.key = (kind) => `devnet/${kind}/${JSON.stringify([h.expected.network, h.expected.chainIdentity, x.address])}`;
  x.record = async (journal = h.journal) => (await journal.entries()).filter(([key]) => key.startsWith('devnet/cancelled-payments/'));
  x.claims = async (journal = h.journal) => (await journal.get(x.key('transfer-claims')))?.claims ?? [];
  // Purchase-independent wallet lane (no page's one-time lane read).
  x.bareLane = () => { x.broker = { anchorJournal: { get: async () => undefined, put: async () => {}, withWalletLock: async (_key, work) => work() } }; };
  return x;
}
const noConnection = { getContext: () => ({}), acquireConnectionFence: async () => assert.fail('the cancellation takes no connection') };
const refused = (code) => (e) => e.code === code;

test('cancelled while the transfer dialog is open (the race on main): the source refuses the transfer before anything is signed; nothing is sent and the page says so', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  assert.equal(handoff.status, 'payment_handoff');
  const m = x.mark();
  let cancellation, record;
  x.onTransferDialog = async () => {
    cancellation = await x.cancel();
    // Durable before cancelled: true reached the caller: another connection to the journal sees it.
    record = await x.record(x.otherJournal());
  };
  await assert.rejects(x.pay(handoff), told);
  assert.deepEqual([cancellation.cancelled, cancellation.status], [true, 'cancelled'], JSON.stringify(cancellation));
  assert.equal(record.length, 1);
  const [key, value] = record[0];
  assert.equal(key, x.key('cancelled-payments'));
  const transfer = await named(handoff);
  assert.match(transfer.payloadDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(value.transfers.map(({ cancelledAt, ...rest }) => rest), [{ ...transfer, operationId: x.id }]);
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:409:payment_cancelled'], 'the lease was refused, before anything was signed');
  assert.deepEqual(wire.at(-1).transfer, transfer, 'the wallet named its transfer and its payload');
  assert.equal(x.nodeCalls('confirmTx'), m.confirms, 'no transfer reached the node');
  x.nothingSent(m);
  assert.equal((await x.view()).status, 'cancelled');
  assert.equal(x.rendered.at(-1).status, 'cancelled', 'the page shows the cancelled purchase');
});

test('cancelled before the wallet starts: the wallet\'s one-time lane read is refused; no transfer dialog, nothing signed or sent', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const m = x.mark(), dialogs = x.dialogs.length;
  const cancellation = await x.cancel();
  assert.deepEqual([cancellation.cancelled, cancellation.status], [true, 'cancelled']);
  await assert.rejects(x.pay(handoff), told);
  assert.equal(x.wallet.success, false);
  assert.deepEqual(x.dialogs.slice(dialogs), [], 'no transfer dialog');
  assert.deepEqual(x.phases(m), [], 'the wallet never reached the source');
  x.nothingSent(m);
  assert.equal(x.rendered.at(-1).status, 'cancelled');
});

test('cancelled after the wallet read its lane, before the transfer dialog opens: the source refuses the lease; nothing is signed or sent', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const m = x.mark();
  let cancellation;
  hooks.around = async (phase) => { if (phase === 'bind' && !cancellation) cancellation = await x.cancel(); };
  await assert.rejects(x.pay(handoff), told);
  assert.deepEqual([cancellation.cancelled, cancellation.status], [true, 'cancelled']);
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:409:payment_cancelled']);
  assert.equal(x.wallet.error.code, 'payment_cancelled');
  assert.match(x.wallet.error.message, /it has the terms of a cancelled payment\. This attempt was refused and not sent\. An earlier attempt may have been sent; the purchase's readback shows it\.$/);
  assert.equal(x.nodeCalls('confirmTx'), m.confirms);
  x.nothingSent(m);
  assert.equal(x.rendered.at(-1).status, 'cancelled');
});

// Another purchase's cancelled payment with this handoff's settlement terms,
// recorded after the handoff (the out-of-order purchase is refused before its
// handoff; this record reaches the journal later, written here through another
// connection to the file while the transfer dialog is open).
test('a cancelled payment with this handoff\'s terms that appears after the handoff (another purchase\'s): the source refuses the lease and nothing is sent; the purchase stays payment_handoff, the page and the wallet do not call it cancelled, cancelling it answers cancelled: true, and the buyer\'s next purchase prepares', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const other = { ...await named({ payload: sameTermsOtherPayload(handoff.payload), terms: handoff.terms }), operationId: `pur_${'A'.repeat(16)}` };
  x.onTransferDialog = () => x.otherJournal().put(x.key('cancelled-payments'), { cancelledPayments: 'dacs-chatgpt-plugin/cancelled-native-payments/v2', transfers: [{ ...other, cancelledAt: new Date().toISOString() }] });
  const m = x.mark();
  let error = null;
  try { await x.pay(handoff); } catch (e) { error = e; }
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:409:payment_cancelled'], 'refused at its lease, before anything was signed');
  assert.equal(x.nodeCalls('confirmTx'), m.confirms);
  x.nothingSent(m);
  assert.equal((await x.view()).status, 'payment_handoff', 'nothing was sent, so it is not left payment_uncertain');
  assert.equal(x.rendered.at(-1).status, 'payment_handoff');
  assert.equal(error?.message, TERMS_CANCELLED_TEXT, 'the page says this purchase was not cancelled');
  assert.equal(x.wallet.error.code, 'payment_cancelled');
  assert.doesNotMatch(x.wallet.error.message, /purchase was cancelled/, 'the wallet does not say its purchase was cancelled');
  const cancellation = await x.cancel();
  assert.deepEqual([cancellation.cancelled, cancellation.status], [true, 'cancelled'], JSON.stringify(cancellation));
  assert.deepEqual((await x.record())[0][1].transfers.map((r) => r.operationId), [other.operationId, x.id]);
  x.nothingSent(m);
  // Nothing is left unresolved: the buyer's next purchase prepares and reaches approval.
  await x.purchase();
});

test('cancelled once the source granted the signature lease: not cancelled, a payment may be on its way; one transfer, read back only, nothing resent; release removes the lease\'s claim', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const m = x.mark();
  let cancellation, claims;
  hooks.after = async (phase, status) => {
    if (phase !== 'signature' || status !== 200 || cancellation) return;
    claims = await x.claims();
    cancellation = await toolRaw(x.h, x.buyer, 'cancel_wallet_handoff', { operationId: x.id });
  };
  await x.pay(handoff);
  assert.deepEqual([cancellation.structuredContent?.cancelled, cancellation.structuredContent?.status], [false, 'payment_uncertain'], JSON.stringify(cancellation));
  assert.ok(cancellation.content.some((c) => c.type === 'text' && c.text.includes(MAY_BE_ON_ITS_WAY(x.id))), JSON.stringify(cancellation.content));
  assert.deepEqual(claims.map(({ leaseId, expiresAt, ...rest }) => rest), [await named(handoff)], 'the lease was claimed durably before it was returned');
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:200', 'broadcast:200', 'release:200']);
  assert.equal(x.broadcasts(), m.broadcasts + 1, 'the one transfer');
  assert.equal(x.rendered.at(-1).status, 'settled_verified', 'its readback settles the purchase');
  assert.deepEqual(await x.record(), [], 'nothing was recorded as cancelled');
  assert.deepEqual(await x.claims(), [], 'released: the claim is gone');
  // A second cancellation changes nothing, and nothing is ever sent again.
  const again = await toolRaw(x.h, x.buyer, 'cancel_wallet_handoff', { operationId: x.id });
  assert.equal(again.isError, true, JSON.stringify(again));
  assert.equal(x.broadcasts(), m.broadcasts + 1);
});

test('a retained transfer not yet read back is a claim too: not cancelled, readback only', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  // The wallet sends; the purchase is not yet told (its report is held).
  x.broker.useNativePaymentLane();
  const sent = await x.session.request({ method: 'sendTransaction', params: [handoff.payload] });
  assert.equal(sent.success, true, JSON.stringify(sent.error));
  assert.equal(await x.h.capability.nativeTransferClaimed(x.address, handoff.payload), 'broadcast-accepted');
  const cancellation = await toolRaw(x.h, x.buyer, 'cancel_wallet_handoff', { operationId: x.id });
  assert.deepEqual([cancellation.structuredContent?.cancelled, cancellation.structuredContent?.status], [false, 'payment_uncertain']);
  assert.ok(cancellation.content.some((c) => c.type === 'text' && c.text.includes(MAY_BE_ON_ITS_WAY(x.id))));
  const reported = await x.api(`/portal/api/purchase/${x.id}/report`, { token: x.token, txHash: sent.data.hash });
  assert.equal(reported.status, 'settled_verified');
  assert.equal(x.broadcasts(), 1);
});

test('a restart between the cancellation and the wallet\'s attempt: the source still refuses the transfer', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const m = x.mark();
  let cancellation;
  x.onTransferDialog = async () => { cancellation = await x.cancel(); await x.h.restart(); };
  await assert.rejects(x.pay(handoff), told);
  assert.equal(x.h.restarts(), 1);
  assert.equal(cancellation.cancelled, true);
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:409:payment_cancelled']);
  assert.equal(x.nodeCalls('confirmTx'), m.confirms);
  x.nothingSent(m);
  assert.equal((await x.view()).status, 'cancelled');
});

test('a wallet that does not name its transfer (an older page): the lease is granted, the source refuses its confirmTx; nothing reaches the node', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  hooks.around = (phase, body) => { if (phase === 'signature') delete body.transfer; };
  const m = x.mark();
  let cancellation;
  x.onTransferDialog = async () => { cancellation = await x.cancel(); };
  await assert.rejects(x.pay(handoff), told);
  assert.equal(cancellation.cancelled, true);
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:200', 'release:200'], 'no transfer named: the lease is granted');
  assert.equal(x.nodeCalls('confirmTx'), m.confirms, 'the source refused the confirmTx before the node saw it');
  x.nothingSent(m);
  assert.equal(x.rendered.at(-1).status, 'cancelled');
});

// Once the source claims a transfer no cancellation in any process records it,
// so the last two refusal points (the wallet's pre-broadcast request and the
// broadcast claim) are reached only by a record that appears in the journal
// anyway (here written directly, through another connection to the file).
// They stay: the broadcast claim is the final check.
async function recordAppears(t, x, handoff, when, payload = handoff.payload) {
  const journal = x.otherJournal(), transfer = await named(handoff);
  const write = () => journal.put(x.key('cancelled-payments'), { cancelledPayments: 'dacs-chatgpt-plugin/cancelled-native-payments/v2', transfers: [{ ...transfer, operationId: x.id, cancelledAt: new Date().toISOString() }] });
  if (when === 'before-broadcast-binding') hooks.around = async (phase) => { if (phase === 'broadcast') await write(); };
  else hooks.after = async (phase, status) => { if (phase === 'broadcast' && status === 200) await write(); };
  x.broker.useNativePaymentLane();
  return x.session.request({ method: 'sendTransaction', params: [payload] });
}
const noNativeClaim = async (x) => assert.ok(!(await x.h.journal.entries()).some(([key, value]) => key.startsWith('devnet/native-') && value?.signedTransaction?.content?.from === x.address && value.signedTransaction.content.type === 'native'), 'no transfer was claimed in the journal');

test('a cancellation record that appears after confirmTx: the wallet\'s pre-broadcast request is refused, so it knows nothing was sent', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const m = x.mark();
  const sent = await recordAppears(t, x, handoff, 'before-broadcast-binding');
  assert.deepEqual([sent.success, sent.error?.code], [false, 'payment_cancelled']);
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:200', 'broadcast:409:payment_cancelled', 'release:200']);
  assert.equal(x.nodeCalls('confirmTx'), m.confirms + 1, 'confirmed before the record appeared');
  x.nothingSent(m);
  await noNativeClaim(x);
});

test('a cancellation record that appears just before the broadcast: the broadcast claim refuses it; nothing is claimed or sent, and the source refuses it from then on', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const m = x.mark();
  const sent = await recordAppears(t, x, handoff, 'after-broadcast-binding');
  // The SDK reports any broadcastTx refusal as a transport failure, so the
  // wallet cannot tell; the source's journal shows nothing was sent.
  assert.deepEqual([sent.success, sent.error?.code], [false, 'outcome_unknown']);
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:200', 'broadcast:200', 'release:200']);
  x.nothingSent(m);
  await noNativeClaim(x);
  const { binding } = await x.h.capability.binding({ phase: 'bind', address: x.address });
  await assert.rejects(x.h.capability.binding({ phase: 'signature', address: x.address, binding, transfer: await named(handoff) }), refused('payment_cancelled'));
});

test('the record names one transfer, not the lane: the buyer\'s next Agreement CREATE (at the cancelled nonce) and next payment (same payee and amount) go through', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const first = await x.approve();
  const cancelled = await x.cancel();
  assert.equal(cancelled.cancelled, true);
  const cancelledNonce = first.payload.content.nonce;
  // Source level: a lease naming the cancelled transfer is refused; one naming another is not.
  const live = x.h.capability;
  const { binding } = await live.binding({ phase: 'bind', address: x.address });
  const lease = (transfer) => live.binding({ phase: 'signature', address: x.address, binding, transfer });
  const transfer = await named(first);
  await assert.rejects(lease(transfer), refused('payment_cancelled'));
  const otherAmount = await lease({ ...transfer, amountOs: `${transfer.amountOs}0` });
  await live.binding({ phase: 'release', address: x.address, leaseId: otherAmount.leaseId });
  // The next purchase on the same wallet lane: its Agreement CREATE takes the
  // cancelled transfer's nonce, and its payment pays the same payee the same amount.
  const before = x.broadcasts();
  await x.purchase();
  const second = await x.approve();
  assert.equal(second.payload.content.nonce, cancelledNonce + 1, 'the Agreement CREATE was sent at the cancelled nonce');
  assert.equal(second.payload.content.to, first.payload.content.to);
  assert.equal(second.payload.content.amount, first.payload.content.amount);
  await x.pay(second);
  assert.equal(x.rendered.at(-1).status, 'settled_verified');
  assert.equal(x.broadcasts(), before + 1, 'the payment');
});

test('cancellation needs an exact prepared transfer by the payer and its purchase, and the plugin\'s proof decides', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  const source = createDevnetAgreementTransport({ expected: x.h.expected, journal: x.h.journal, transportOwner: noConnection });
  t.after(() => source.close());
  const to = `0x${'5'.repeat(64)}`;
  const payload = { content: { type: 'native', from: x.address, to, amount: '1000000000', data: ['native', { nativeOperation: 'send', args: [to, '1000000000'] }], nonce: 9, timestamp: 1_760_000_000_000 } };
  const { timestamp: _none, ...untimed } = payload.content;
  for (const bad of [{ ...payload, content: { ...payload.content, from: `0x${'6'.repeat(64)}` } }, { content: { ...payload.content, type: 'storageProgram' } }, { content: { ...payload.content, amount: '1.5' } }, { content: untimed }, { content: { ...payload.content, timestamp: 0 } }]) {
    await assert.rejects(source.cancelNativeTransfer({ address: x.address, operationId: 'pur_x', payload: bad, unissued: async () => true }), refused('invalid_params'), JSON.stringify(bad.content));
  }
  await assert.rejects(source.cancelNativeTransfer({ address: x.address, operationId: '', payload, unissued: async () => true }), refused('invalid_params'), 'the purchase is required');
  assert.deepEqual(await source.cancelNativeTransfer({ address: x.address, operationId: 'pur_x', payload, unissued: async () => false }), { cancelled: false, claimed: null });
  assert.deepEqual(await x.record(), [], 'nothing is recorded unless the proof holds');
  assert.deepEqual(await source.cancelNativeTransfer({ address: x.address, operationId: 'pur_x', payload, unissued: async () => true }), { cancelled: true, claimed: null });
  assert.deepEqual((await x.record())[0][1].transfers.map(({ cancelledAt, ...rest }) => rest), [{ nonce: 9, to, amountOs: '1000000000', payloadDigest: await nativePayloadDigest(payload.content), operationId: 'pur_x' }]);
  // A later cancellation drops records below its nonce: the chain used them.
  assert.deepEqual(await source.cancelNativeTransfer({ address: x.address, operationId: 'pur_y', payload: { content: { ...payload.content, nonce: 10 } }, unissued: async () => true }), { cancelled: true, claimed: null });
  assert.deepEqual((await x.record())[0][1].transfers.map((r) => [r.nonce, r.operationId]), [[10, 'pur_y']]);
});

// The lease and the cancellation take the payer's source lane lock; whichever
// holds it first wins, and the other sees it.
test('lock order: a cancellation arriving while a lease is granted waits and is not cancelled; a lease arriving while a cancellation is recorded waits and is refused', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  const live = x.h.capability, journal = x.h.journal, get = journal.get, lock = journal.withWalletLock;
  t.after(() => { journal.get = get; journal.withWalletLock = lock; });
  const to = `0x${'5'.repeat(64)}`;
  const payload = { content: { type: 'native', from: x.address, to, amount: '1000000000', data: ['native', { nativeOperation: 'send', args: [to, '1000000000'] }], nonce: 9, timestamp: 1_760_000_000_000 } };
  const transfer = { nonce: 9, to, amountOs: '1000000000', payloadDigest: await nativePayloadDigest(payload.content) };
  const within = (promise, what) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(what)), 10_000); })]).finally(() => clearTimeout(timer)); };
  const { binding } = await live.binding({ phase: 'bind', address: x.address });
  // 1. The lease first. Its last check (under the lock) reads the record; right
  // after that read a cancellation of the transfer it names comes in.
  let reads = 0, seen, resume;
  let read = new Promise((resolve) => { seen = resolve; }), held = new Promise((resolve) => { resume = resolve; });
  journal.get = async (key) => {
    const value = await get.call(journal, key);
    if (key.startsWith('devnet/cancelled-payments/') && ++reads === 2) { seen(); await held; }
    return value;
  };
  const leasing = live.binding({ phase: 'signature', address: x.address, binding, transfer });
  await within(read, 'the lease never read the cancellation record under the lock');
  const cancelling = live.cancelNativeTransfer({ address: x.address, operationId: 'pur_x', payload, unissued: async () => true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  resume();
  const lease = await leasing;
  assert.deepEqual(await cancelling, { cancelled: false, claimed: 'signature-lease' }, 'the lease was granted first; the cancellation saw it');
  await live.binding({ phase: 'release', address: x.address, leaseId: lease.leaseId });
  journal.get = get;
  // 2. The cancellation first. While it holds the lock (inside the plugin's
  // proof), the lease comes in: it waits for the lock, then sees the record.
  read = new Promise((resolve) => { seen = resolve; }); held = new Promise((resolve) => { resume = resolve; });
  const recording = live.cancelNativeTransfer({ address: x.address, operationId: 'pur_x', payload, unissued: async () => { seen(); await held; return true; } });
  await within(read, 'the cancellation never ran the proof');
  let waiting;
  const atLock = new Promise((resolve) => { waiting = resolve; });
  journal.withWalletLock = (key, work) => { if (key.startsWith('devnet/native-wallet/')) waiting(); return lock.call(journal, key, work); };
  const refusedLease = live.binding({ phase: 'signature', address: x.address, binding, transfer });
  await within(atLock, 'the lease never asked for the lane lock');
  await new Promise((resolve) => setTimeout(resolve, 300));
  journal.withWalletLock = lock;
  resume();
  assert.deepEqual(await recording, { cancelled: true, claimed: null });
  await assert.rejects(refusedLease, refused('payment_cancelled'), 'the lease waited for the lock and saw the record');
  // The refused lease freed the connection: the next request gets it.
  const next = await live.binding({ phase: 'signature', address: x.address, binding, transfer: { ...transfer, nonce: 10 } });
  await live.binding({ phase: 'release', address: x.address, leaseId: next.leaseId });
});

test('two processes on one source journal: a live signature lease in one makes the other\'s cancellation answer cancelled: false, before and after confirmTx; nothing is recorded and the one transfer goes out', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const other = x.otherSource(), transfer = await named(handoff);
  const cancelThere = () => other.cancelNativeTransfer({ address: x.address, operationId: x.id, payload: handoff.payload, unissued: async () => true });
  const seen = {};
  hooks.after = async (phase, status) => {
    if (phase !== 'signature' || status !== 200) return;
    seen.afterLease = await cancelThere();
    seen.claimsAfterLease = await x.claims(x.otherJournal());
  };
  hooks.around = async (phase) => {
    if (phase !== 'broadcast') return;
    seen.afterConfirm = await cancelThere();
    seen.claimedAfterConfirm = await other.nativeTransferClaimed(x.address, handoff.payload);
    seen.claimsAfterConfirm = await x.claims(x.otherJournal());
  };
  const m = x.mark();
  x.broker.useNativePaymentLane();
  const sent = await x.session.request({ method: 'sendTransaction', params: [handoff.payload] });
  assert.equal(sent.success, true, JSON.stringify(sent.error));
  assert.deepEqual(seen.afterLease, { cancelled: false, claimed: 'signature-lease' }, 'the lease was a claim in the other process before anything was signed');
  assert.deepEqual(seen.afterConfirm, { cancelled: false, claimed: 'signature-lease' }, 'and once the node had seen the signed transfer');
  assert.equal(seen.claimedAfterConfirm, 'signature-lease');
  assert.deepEqual(seen.claimsAfterLease.map(({ leaseId, expiresAt, ...rest }) => rest), [transfer]);
  assert.deepEqual(seen.claimsAfterConfirm.map(({ leaseId, expiresAt, confirmTxAt, ...rest }) => ({ ...rest, marked: typeof confirmTxAt === 'string' })), [{ ...transfer, marked: true }], 'marked before its confirmTx went out');
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:200', 'broadcast:200', 'release:200']);
  assert.equal(x.broadcasts(), m.broadcasts + 1, 'the one transfer');
  assert.deepEqual(await x.record(), [], 'nothing was recorded as cancelled');
  assert.deepEqual(await x.claims(), [], 'the lease\'s claim went with it');
  assert.equal(await other.nativeTransferClaimed(x.address, handoff.payload), 'broadcast-accepted', 'the retained transfer is the claim from then on');
});

test('a lease\'s claim after it ends: released, it is gone; expired, also after its confirmTx (a process that stopped before its broadcast retained anything sent nothing), it is no claim: the cancellation is recorded, the transfer is refused from then on and the buyer\'s next purchase prepares', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const other = x.otherSource(), live = x.h.capability, transfer = await named(handoff);
  // Released before anything was signed.
  const { binding } = await live.binding({ phase: 'bind', address: x.address });
  const lease = await live.binding({ phase: 'signature', address: x.address, binding, transfer });
  assert.equal(await other.nativeTransferClaimed(x.address, handoff.payload), 'signature-lease');
  await live.binding({ phase: 'release', address: x.address, leaseId: lease.leaseId });
  assert.equal(await other.nativeTransferClaimed(x.address, handoff.payload), null, 'released: no claim');
  // Left by a process that stopped, and expired: before any confirmTx, and
  // after it was marked but before its broadcast retained an issued transfer.
  // Its lease can confirm or broadcast nothing more, and a broadcast always
  // retains its transfer on the lane before the network send, so nothing was sent.
  const journal = x.otherJournal(), past = new Date(Date.now() - 60_000).toISOString();
  const leave = (claim) => journal.put(x.key('transfer-claims'), { transferClaims: 'dacs-chatgpt-plugin/native-transfer-claims/v1', claims: [{ leaseId: 'a'.repeat(32), ...transfer, expiresAt: past, ...claim }] });
  await leave({});
  assert.equal(await other.nativeTransferClaimed(x.address, handoff.payload), null, 'expired before confirmTx');
  await leave({ confirmTxAt: past });
  assert.equal(await other.nativeTransferClaimed(x.address, handoff.payload), null, 'expired after confirmTx');
  const m = x.mark();
  const cancellation = await x.cancel();
  assert.deepEqual([cancellation.cancelled, cancellation.status], [true, 'cancelled'], JSON.stringify(cancellation));
  assert.equal((await x.record()).length, 1, 'recorded');
  // A send of that transfer after the cancellation is refused at the source.
  x.bareLane();
  const sent = await x.session.request({ method: 'sendTransaction', params: [handoff.payload] });
  assert.equal(sent.success, false);
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:409:payment_cancelled']);
  x.nothingSent(m);
  // Nothing is left unresolved: the buyer's next purchase prepares and reaches approval.
  await x.purchase();
});

test('a broadcast under way (its transfer retained as issued) is never cancelled under it, even once its lease\'s claim has expired: the cancellation waits for the lane lock and sees the retained transfer; one transfer, read back only', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const other = x.otherSource(), journal = x.h.journal, put = journal.put, transfer = await named(handoff);
  t.after(() => { journal.put = put; });
  let cancelling;
  journal.put = async (key, value) => {
    const done = await put.call(journal, key, value);
    if (!cancelling && key === x.key('native-wallet') && value?.stage === 'broadcast-started') {
      // Under the broadcast's lane lock, its transfer retained, before the
      // network send: its lease's claim expires, and another process cancels
      // (with a plugin proof that says nothing was sent).
      const past = new Date(Date.now() - 60_000).toISOString();
      await put.call(journal, x.key('transfer-claims'), { transferClaims: 'dacs-chatgpt-plugin/native-transfer-claims/v1', claims: [{ leaseId: 'b'.repeat(32), ...transfer, expiresAt: past, confirmTxAt: past }] });
      cancelling = other.cancelNativeTransfer({ address: x.address, operationId: x.id, payload: handoff.payload, unissued: async () => true });
    }
    return done;
  };
  x.broker.useNativePaymentLane();
  const sent = await x.session.request({ method: 'sendTransaction', params: [handoff.payload] });
  journal.put = put;
  assert.equal(sent.success, true, JSON.stringify(sent.error));
  assert.ok(cancelling, 'the cancellation came in during the broadcast');
  assert.deepEqual(await cancelling, { cancelled: false, claimed: 'broadcast-accepted' });
  assert.deepEqual(await x.record(), [], 'nothing was recorded as cancelled');
  assert.equal(x.broadcasts(), 1, 'the one transfer');
  const cancellation = await toolRaw(x.h, x.buyer, 'cancel_wallet_handoff', { operationId: x.id });
  assert.deepEqual([cancellation.structuredContent?.cancelled, cancellation.structuredContent?.status], [false, 'payment_uncertain']);
  assert.ok(cancellation.content.some((c) => c.type === 'text' && c.text.includes(MAY_BE_ON_ITS_WAY(x.id))));
  const reported = await x.api(`/portal/api/purchase/${x.id}/report`, { token: x.token, txHash: sent.data.hash });
  assert.equal(reported.status, 'settled_verified');
});

test('after cancelled: true, a re-signed copy with the same settlement terms (another time, or the payee in upper case) is refused at the source, whether its wallet names it or not, so nothing is sent that could settle the cancelled purchase', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const a = await x.approve();
  assert.equal((await x.cancel()).cancelled, true);
  const [namedA, namedB] = [await named(a), await named({ payload: sameTermsOtherPayload(a.payload), terms: a.terms })];
  assert.deepEqual([namedB.nonce, namedB.to, namedB.amountOs], [namedA.nonce, namedA.to, namedA.amountOs], 'the same terms');
  assert.notEqual(namedB.payloadDigest, namedA.payloadDigest, 'another payload');
  x.bareLane();
  for (const [name, payload] of Object.entries({ 'another time': sameTermsOtherPayload(a.payload), 'the payee in upper case': upperPayee(a.payload) })) {
    for (const naming of [true, false]) {
      hooks.around = naming ? null : (phase, body) => { if (phase === 'signature') delete body.transfer; };
      const m = x.mark();
      const sent = await x.session.request({ method: 'sendTransaction', params: [payload] });
      const what = `${name}, ${naming ? 'named' : 'naming nothing'}`;
      assert.equal(sent.success, false, what);
      assert.deepEqual(x.phases(m), naming ? ['bind:200', 'signature:409:payment_cancelled'] : ['bind:200', 'signature:200', 'release:200'], what);
      assert.equal(x.nodeCalls('confirmTx'), m.confirms, `${what}: the node never saw it`);
      x.nothingSent(m);
    }
  }
  hooks.around = null;
  assert.equal((await x.view()).status, 'cancelled');
  assert.deepEqual(await x.claims(), [], 'nothing was claimed');
});

for (const when of ['before-broadcast-binding', 'after-broadcast-binding']) {
  test(`a cancellation record that appears after a re-signed copy's confirmTx (another time), ${when === 'before-broadcast-binding' ? 'before its pre-broadcast request: that request' : 'just before its broadcast: the broadcast claim'} refuses it; nothing is sent`, { timeout: 600_000 }, async (t) => {
    const x = await world(t);
    await x.purchase();
    const handoff = await x.approve();
    const m = x.mark();
    const sent = await recordAppears(t, x, handoff, when, sameTermsOtherPayload(handoff.payload));
    assert.deepEqual([sent.success, sent.error?.code], [false, when === 'before-broadcast-binding' ? 'payment_cancelled' : 'outcome_unknown']);
    assert.deepEqual(x.phases(m), when === 'before-broadcast-binding' ? ['bind:200', 'signature:200', 'broadcast:409:payment_cancelled', 'release:200'] : ['bind:200', 'signature:200', 'broadcast:200', 'release:200']);
    assert.equal(x.nodeCalls('confirmTx'), m.confirms + 1, 'confirmed before the record appeared');
    x.nothingSent(m);
    await noNativeClaim(x);
  });
}

test('a wallet that names one transfer and signs another: its confirmTx is refused before the node sees it, also when the transfer it signs was cancelled', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const declared = await named({ payload: sameTermsOtherPayload(handoff.payload), terms: handoff.terms });
  hooks.around = (phase, body) => { if (phase === 'signature') body.transfer = declared; };
  const attempt = async () => {
    const m = x.mark(), logs = x.h.logs.length;
    const sent = await x.session.request({ method: 'sendTransaction', params: [handoff.payload] });
    assert.equal(sent.success, false);
    assert.deepEqual(x.phases(m), ['bind:200', 'signature:200', 'release:200'], 'the lease named another transfer and was granted');
    // The RPC relay's answers (the SDK's own requests): its confirmTx was refused (409), not relayed.
    const rpc = x.h.logs.slice(logs).map((l) => JSON.parse(l)).filter((l) => l.event === 'http' && l.path === '/portal/api/devnet-native-wallet-rpc').map((l) => l.status);
    assert.equal(rpc.at(-1), 409, JSON.stringify(rpc));
    assert.equal(x.nodeCalls('confirmTx'), m.confirms, 'the node never saw it');
    x.nothingSent(m);
  };
  x.broker.useNativePaymentLane();
  await attempt();
  // Its purchase cancelled, and the lease naming a transfer that is not (other
  // terms: one with the cancelled terms is refused at the lease, test above).
  x.bareLane();
  assert.equal((await x.cancel()).cancelled, true);
  declared.amountOs = `${declared.amountOs}0`;
  await attempt();
  assert.deepEqual(await x.claims(), [], 'no claim is left');
});

test('a wallet that names nothing claims its transfer at confirmTx: before it, the lease is no claim; from then on another process\'s cancellation answers cancelled: false, and the transfer goes out once', { timeout: 600_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const other = x.otherSource();
  const seen = {};
  hooks.around = async (phase, body) => {
    if (phase === 'signature') delete body.transfer;
    if (phase === 'broadcast') seen.afterConfirm = await other.cancelNativeTransfer({ address: x.address, operationId: x.id, payload: handoff.payload, unissued: async () => true });
  };
  hooks.after = async (phase, status) => { if (phase === 'signature' && status === 200) seen.afterLease = await other.nativeTransferClaimed(x.address, handoff.payload); };
  const m = x.mark();
  x.broker.useNativePaymentLane();
  const sent = await x.session.request({ method: 'sendTransaction', params: [handoff.payload] });
  assert.equal(sent.success, true, JSON.stringify(sent.error));
  assert.equal(seen.afterLease, null, 'a lease that names nothing claims no transfer');
  assert.deepEqual(seen.afterConfirm, { cancelled: false, claimed: 'signature-lease' }, 'claimed at its confirmTx');
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:200', 'broadcast:200', 'release:200']);
  assert.equal(x.broadcasts(), m.broadcasts + 1);
  assert.deepEqual(await x.record(), []);
});
