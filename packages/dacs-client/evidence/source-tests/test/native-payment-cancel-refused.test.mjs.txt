// A native payment handoff whose transfer the operator's source refuses
// because it has a cancelled payment's settlement terms (a cancellation that
// appeared after the handoff, here written through another connection to the
// source journal). The page can report that refusal arbitrarily late. Each
// gate that refuses keeps the refusal of the handoff's exact transfer in the
// source journal, apart from the cancellation record, which a later
// cancellation prunes once the chain has used its nonce. So the purchase
// stays payment_handoff on the report however late it comes, and cancelling
// it ends it: with its nonce unchanged by the source's proof, and once its
// nonce has been used by what the source reads back at that nonce. Nothing of
// it is sent, resent, re-signed or settled on unverified data.
//
// The browser side is the shipped portal.js pay() (run from its source) with
// the real embedded wallet, or the report it posts.
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
const { tool, tokenFrom } = await import('./helpers/flows.mjs');
const { openDurableWalletJournal } = await import('../src/wallet/durable-journal.mjs');
const { createDevnetAgreementTransport } = await import('../src/wallet/devnet-native-transport.mjs');
const runtime = await import('../public/portal/embedded-wallet/demos-runtime.mjs');

// The portal's pay() and the wallet helpers it calls, from the shipped source.
const portalSource = readFileSync(new URL('../public/portal/portal.js', import.meta.url), 'utf8');
const slice = (from, to) => { const start = portalSource.indexOf(from), end = portalSource.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return portalSource.slice(start, end); };
const PAY_SOURCE = `${slice('function envelopeError(res) {', 'async function connect()')}${slice('function findHash(value', '// ---------------- server API')}${slice('  async function pay(view) {', '  render(await api(`/portal/api/purchase/${id}/view`')}; pay`;

// The wallet's source binding requests (sdk-provider.mjs bindingCall), with
// the source's answers; after(phase, status) runs once each is answered.
const BINDING_PATH = '/portal/api/devnet-native-wallet-binding';
const wire = [];
const hooks = { after: null };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (typeof url !== 'string' || new URL(url).pathname !== BINDING_PATH) return realFetch(url, options);
  const body = JSON.parse(options.body);
  const r = await realFetch(url, options);
  const answer = await r.clone().json();
  wire.push({ phase: body.phase, status: r.status, error: answer.error ?? null });
  await hooks.after?.(body.phase, r.status);
  return r;
};

const named = async ({ payload, terms }) => ({ nonce: payload.content.nonce, to: payload.content.to.toLowerCase(), amountOs: terms.price.amountOs, payloadDigest: await nativePayloadDigest(payload.content) });
// The same settlement terms in another payload (another purchase's cancelled payment).
const sameTermsOtherPayload = (payload) => ({ ...payload, content: { ...payload.content, timestamp: payload.content.timestamp + 1 } });
// Another write by the same wallet at the same nonce: a transfer to another payee.
const otherPayee = (payload) => {
  const to = `0x${'7'.repeat(64)}`;
  return { ...payload, content: { ...payload.content, to, timestamp: payload.content.timestamp + 2, data: ['native', { ...payload.content.data[1], args: [to, payload.content.data[1].args[1]] }] } };
};
const noConnection = { getContext: () => ({}), acquireConnectionFence: async () => assert.fail('this source takes no connection') };
const refused = (code) => (e) => e.code === code;

// One buyer wallet and one seller on a fresh harness; purchase() runs main's
// per-step Start to awaiting_approval, approve() main's approval signature.
async function world(t) {
  const h = await startDevnetAgreementTransportHarness();
  t.after(() => h.close());
  t.after(() => { hooks.after = null; });
  globalThis.location = new URL(h.origin);
  const seller = await startDevnetAgreementTransportSeller(h, { listingId: `cancel-refused-${Date.now()}`, durable: true });
  const transactionTransport = createDevnetAgreementWalletTransport(await h.profile());
  const reports = [];
  const api = async (path, body) => {
    if (path.endsWith('/report')) reports.push(body);
    const r = await realFetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body ?? {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.message || `request failed (${r.status})`), { code: data.error });
    return data;
  };
  const x = { h, seller, api, reports, broker: null, rendered: [] };
  const brokerJournal = { get: (k) => x.broker.anchorJournal.get(k), put: (k, v) => x.broker.anchorJournal.put(k, v), withWalletLock: (k, work) => x.broker.anchorJournal.withWalletLock(k, work) };
  const session = createSdkWalletSession({ DemosCtor: runtime.Demos, IdentitiesCtor: runtime.Identities, validateMnemonic: runtime.validateMnemonic, transactionTransport, anchorJournal: brokerJournal, approve: async () => true });
  await session.create();
  t.after(() => session.lock());
  x.session = session;
  x.address = session.getPublicAccount().address;
  x.buyer = await linkPackagedWallet(h, session);
  x.sign = async (m) => (await session.request({ method: 'sign', params: [m] })).data.signature;
  x.purchase = async () => {
    const prepared = await tool(h, x.buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `cancel-refused-${Date.now()}-${Math.random()}`, protocol: 'dacs-sr2-wallet-agreement' });
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
  x.report = (body) => api(`/portal/api/purchase/${x.id}/report`, { token: x.token, ...body });
  x.cancel = () => tool(h, x.buyer, 'cancel_wallet_handoff', { operationId: x.id });
  x.history = () => h.app.services.ops.history(x.id);
  x.broadcasts = () => h.chain.record.broadcasts.length;
  x.nodeCalls = (extra) => h.requests.filter((r) => r.extra === extra).length;
  x.mark = () => ({ wire: wire.length, confirms: x.nodeCalls('confirmTx'), sends: x.nodeCalls('broadcastTx'), broadcasts: x.broadcasts() });
  x.phases = (m) => wire.slice(m.wire).map((w) => `${w.phase}:${w.status}${w.error ? `:${w.error}` : ''}`);
  // Another process on the same source journal: its own connection to the
  // file, and its own source, with no lease in its memory.
  x.otherJournal = () => { const j = openDurableWalletJournal({ path: h.journal.path, mode: 'open', expectedJournalId: h.journal.journalId }); t.after(() => j.close()); return j; };
  x.otherSource = () => { const other = createDevnetAgreementTransport({ expected: h.expected, journal: x.otherJournal(), transportOwner: noConnection }); t.after(() => other.close()); return other; };
  x.key = (kind) => `devnet/${kind}/${JSON.stringify([h.expected.network, h.expected.chainIdentity, x.address])}`;
  x.record = async () => (await h.journal.get(x.key('cancelled-payments')))?.transfers ?? [];
  x.refusals = async () => ((await h.journal.get(x.key('refused-transfers')))?.refusals ?? []).map(({ refusedAt, ...rest }) => rest);
  // Another purchase's cancelled payment with this handoff's terms, written
  // through another connection to the journal (it appears after the handoff).
  x.cancelledElsewhere = async (handoff) => x.otherJournal().put(x.key('cancelled-payments'), { cancelledPayments: 'dacs-chatgpt-plugin/cancelled-native-payments/v2',
    transfers: [{ ...await named({ payload: sameTermsOtherPayload(handoff.payload), terms: handoff.terms }), operationId: `pur_${'A'.repeat(16)}`, cancelledAt: new Date().toISOString() }] });
  // Another source-routed write by this wallet uses the handoff's nonce, and
  // is read back included.
  x.useNonce = async (handoff) => {
    x.broker = { anchorJournal: { get: async () => undefined, put: async () => {}, withWalletLock: async (_key, work) => work() } };
    const used = await session.request({ method: 'sendTransaction', params: [otherPayee(handoff.payload)] });
    assert.equal(used.success, true, JSON.stringify(used.error));
    assert.equal((await h.capability.binding({ phase: 'readback', address: x.address, hash: used.data.hash })).disposition, 'included');
    return used.data.hash;
  };
  // A later legitimate cancellation at the next nonce (another purchase's,
  // in any process on the journal) prunes the record the transfer was refused for.
  x.pruneWith = async (source, handoff) => {
    const nonce = handoff.payload.content.nonce;
    assert.deepEqual(await source.cancelNativeTransfer({ address: x.address, operationId: `pur_${'C'.repeat(16)}`, payload: { ...handoff.payload, content: { ...handoff.payload.content, nonce: nonce + 1 } }, unissued: async () => true }), { cancelled: true, claimed: null });
    assert.deepEqual((await x.record()).map((r) => r.nonce), [nonce + 1], 'the record this transfer was refused for is pruned');
  };
  return x;
}

test('a payment_cancelled refusal the page reports only after another write used the nonce and a later cancellation pruned the record it was refused for: the source kept the refusal, so the purchase stays payment_handoff (also through verify_deal), and its cancel reads back what used the nonce and ends it cancelled; nothing of it was sent, and the buyer\'s next purchase prepares', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  assert.equal(handoff.status, 'payment_handoff');
  await x.cancelledElsewhere(handoff);
  const m = x.mark();
  // The page's own pay(); its report is held until the race below has run.
  let report, sent;
  const held = new Promise((resolve) => { report = resolve; });
  const real = x.api;
  const pay = vm.runInNewContext(PAY_SOURCE, { provider: { request: async (r) => { sent = await x.session.request(r); return sent; } }, api: async (path, body) => { if (path.endsWith('/report')) { x.reports.push(body); await held; } return real(path, body); },
    render: (v) => x.rendered.push(v), log: () => {}, needPaymentNetwork: () => {}, id: x.id, token: x.token, offlineAgreementBroker: x.broker })(handoff);
  const paid = pay.then(() => null, (e) => e);
  for (let i = 0; i < 400 && !x.reports.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual([sent.success, sent.error?.code], [false, 'payment_cancelled']);
  assert.deepEqual(x.phases(m), ['bind:200', 'signature:409:payment_cancelled'], 'refused at its lease, before anything was signed');
  const usedBy = await x.useNonce(handoff);
  await x.pruneWith(x.h.capability, handoff);
  report();
  const error = await paid;
  assert.equal((await x.view()).status, 'payment_handoff', 'the refusal outlived its record: not payment_uncertain');
  assert.deepEqual(await x.refusals(), [{ ...await named(handoff), gate: 'signature' }], 'the source kept this exact transfer\'s refusal');
  assert.deepEqual({ ...x.reports.at(-1) }, { token: x.token, walletError: sent.error.message, walletErrorCode: 'payment_cancelled' }, 'the page reports the wallet\'s code');
  assert.match(error?.message ?? '', /so it was not sent: the transfer has the same terms as a cancelled purchase's payment\. This purchase was not cancelled\./);
  // verify_deal does not leave it readback-only either.
  const verified = await tool(x.h, x.buyer, 'verify_deal', { operationId: x.id });
  assert.deepEqual([verified.status, verified.verification.outcome], ['payment_handoff', 'not_broadcast'], JSON.stringify(verified));
  const cancellation = await x.cancel();
  assert.deepEqual([cancellation.cancelled, cancellation.status], [true, 'cancelled'], JSON.stringify(cancellation));
  assert.equal(x.history().find((e) => e.type === 'cancelled')?.data.consumedBy, usedBy, 'ended from the write that used its nonce');
  assert.equal(x.broadcasts(), m.broadcasts + 1, 'only the other write was sent');
  assert.equal(x.nodeCalls('broadcastTx'), m.sends + 1);
  // Nothing is left unresolved: the buyer's next purchase prepares and reaches approval.
  await x.purchase();
});

test('the same race across two processes on one source journal: the other process refuses the transfer and keeps the refusal, and its later cancellation prunes the record; this process keeps the purchase payment_handoff on the late report and its cancel ends it from what used the nonce', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  await x.cancelledElsewhere(handoff);
  const other = x.otherSource();
  // The wallet's lease request reaches the other process's source: refused
  // there, before any connection is taken or anything is signed.
  await assert.rejects(other.binding({ phase: 'signature', address: x.address, transfer: await named(handoff) }), refused('payment_cancelled'));
  assert.deepEqual(await x.refusals(), [{ ...await named(handoff), gate: 'signature' }], 'kept in the shared journal');
  const m = x.mark();
  const usedBy = await x.useNonce(handoff);
  await x.pruneWith(other, handoff);
  const reported = await x.report({ walletError: 'the operator refused this transfer: it has the terms of a cancelled payment.', walletErrorCode: 'payment_cancelled' });
  assert.equal(reported.status, 'payment_handoff');
  const cancellation = await x.cancel();
  assert.deepEqual([cancellation.cancelled, cancellation.status], [true, 'cancelled'], JSON.stringify(cancellation));
  assert.equal(x.history().find((e) => e.type === 'cancelled')?.data.consumedBy, usedBy);
  assert.equal(x.broadcasts(), m.broadcasts + 1, 'only the other write was sent');
  await x.purchase();
});

test('a refused transfer whose nonce was used outside the operator\'s source (the source retains no write there): the purchase stays payment_handoff on the report, and its cancel cannot tell what used the nonce, so it is not cancelled and stays readback-only', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  await x.cancelledElsewhere(handoff);
  const m = x.mark();
  x.broker.useNativePaymentLane();
  const sent = await x.session.request({ method: 'sendTransaction', params: [handoff.payload] });
  assert.deepEqual([sent.success, sent.error?.code], [false, 'payment_cancelled']);
  // A wallet that reaches the node directly uses the nonce; the source never saw that write.
  x.h.chain.wire.setNonce(x.address, handoff.payload.content.nonce);
  await x.pruneWith(x.h.capability, handoff);
  assert.equal((await x.report({ walletError: sent.error.message, walletErrorCode: sent.error.code })).status, 'payment_handoff');
  const cancellation = await x.cancel();
  assert.deepEqual([cancellation.cancelled, cancellation.status], [false, 'payment_uncertain'], 'what used the nonce may have been this payment');
  assert.equal(x.broadcasts(), m.broadcasts, 'nothing was sent through the source');
});

test('a refused transfer whose nonce was used while another write the source retained at that nonce does not read back included (the node dropped it): the cancel cannot tell yet what used the nonce, so the purchase is not cancelled and stays payment_handoff, to be cancelled again', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  await x.cancelledElsewhere(handoff);
  x.broker.useNativePaymentLane();
  const sent = await x.session.request({ method: 'sendTransaction', params: [handoff.payload] });
  assert.deepEqual([sent.success, sent.error?.code], [false, 'payment_cancelled']);
  // Another write at the nonce reaches the source; the node drops it before applying it.
  x.broker = { anchorJournal: { get: async () => undefined, put: async () => {}, withWalletLock: async (_key, work) => work() } };
  x.h.chain.paymentFaults.payment = 'drop-before-apply';
  const dropped = await x.session.request({ method: 'sendTransaction', params: [otherPayee(handoff.payload)] });
  x.h.chain.paymentFaults.payment = 'ok';
  assert.equal(dropped.error?.code, 'outcome_unknown');
  x.h.chain.wire.setNonce(x.address, handoff.payload.content.nonce);
  assert.equal((await x.report({ walletError: sent.error.message, walletErrorCode: sent.error.code })).status, 'payment_handoff');
  const cancellation = await x.cancel();
  assert.deepEqual([cancellation.cancelled, cancellation.status], [false, 'payment_handoff'], JSON.stringify(cancellation));
  assert.equal(x.history().at(-1).type, 'cancel_deferred');
});

// Through the source, while a refusal stands nothing with its terms is sent,
// and its record is pruned only once the nonce is used. Here the record is
// removed by hand, so this payment's own transfer can use the nonce: the
// write that used it is then verified like a reported hash.
test('a refused transfer whose nonce was then used by a transfer with its own terms (its record removed by hand): the cancel verifies that write like a reported hash, so the purchase settles and is not cancelled; nothing is resent', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  await x.cancelledElsewhere(handoff);
  x.broker.useNativePaymentLane();
  const sent = await x.session.request({ method: 'sendTransaction', params: [handoff.payload] });
  assert.deepEqual([sent.success, sent.error?.code], [false, 'payment_cancelled']);
  await x.otherJournal().put(x.key('cancelled-payments'), { cancelledPayments: 'dacs-chatgpt-plugin/cancelled-native-payments/v2', transfers: [] });
  x.broker = { anchorJournal: { get: async () => undefined, put: async () => {}, withWalletLock: async (_key, work) => work() } };
  const own = await x.session.request({ method: 'sendTransaction', params: [handoff.payload] });
  assert.equal(own.success, true, JSON.stringify(own.error));
  assert.equal((await x.h.capability.binding({ phase: 'readback', address: x.address, hash: own.data.hash })).disposition, 'included');
  const before = x.broadcasts();
  const cancellation = await x.cancel();
  assert.deepEqual([cancellation.cancelled, cancellation.status], [false, 'settled_verified'], JSON.stringify(cancellation));
  assert.equal((await x.view()).evidence.reportedTxHash, own.data.hash);
  assert.equal(x.broadcasts(), before, 'nothing was resent');
});

test('the page\'s wallet code is recorded and never trusted alone: a report naming payment_cancelled when the operator\'s source refused nothing moves the purchase to payment_uncertain, as any wallet error does', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  await x.approve();
  const reported = await x.report({ walletError: 'payment_cancelled', walletErrorCode: 'payment_cancelled' });
  assert.equal(reported.status, 'payment_uncertain');
  assert.deepEqual(x.history().find((e) => e.type === 'wallet_error')?.data, { message: 'payment_cancelled', code: 'payment_cancelled' }, 'recorded with its code');
  assert.deepEqual(await x.refusals(), []);
});

// The second-process window: the broadcast claim refuses a transfer whose
// terms a cancellation appearing just before it names. The SDK reports any
// broadcastTx refusal as an unknown outcome with the transaction's hash, so
// the page reports that hash, and the purchase is read back by it.
test('a broadcast refused at its claim for a cancelled payment\'s terms that the wallet reports as an unknown outcome with its hash: the hash is attached and the purchase is read back by it, not kept payment_handoff; the refusal is kept, and nothing was sent', { timeout: 900_000 }, async (t) => {
  const x = await world(t);
  await x.purchase();
  const handoff = await x.approve();
  const m = x.mark();
  const journal = x.otherJournal(), transfer = await named(handoff);
  hooks.after = async (phase, status) => {
    if (phase === 'broadcast' && status === 200) await journal.put(x.key('cancelled-payments'), { cancelledPayments: 'dacs-chatgpt-plugin/cancelled-native-payments/v2', transfers: [{ ...transfer, operationId: `pur_${'A'.repeat(16)}`, cancelledAt: new Date().toISOString() }] });
  };
  let error = null;
  try { await x.pay(handoff); } catch (e) { error = e; }
  assert.equal(x.wallet.error?.code, 'outcome_unknown');
  const hash = x.wallet.data.hash;
  assert.match(error?.message ?? '', /^Payment outcome unknown/);
  assert.deepEqual({ ...x.reports.at(-1) }, { token: x.token, walletError: error.message, txHash: hash }, 'the page reports the hash');
  assert.equal(x.broadcasts(), m.broadcasts, 'nothing was broadcast');
  assert.deepEqual(await x.refusals(), [{ ...transfer, gate: 'broadcast' }]);
  const view = await x.view();
  assert.notEqual(view.status, 'payment_handoff', 'a report with a hash is read back by it');
  assert.equal(view.evidence.reportedTxHash, hash);
  assert.equal((await x.cancel()).error, 'invalid_state', 'readback only: not cancellable');
});
