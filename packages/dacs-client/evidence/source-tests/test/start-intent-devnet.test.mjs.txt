// One Start approval on the source-pinned devnet Agreement path (the Node2
// shape, owned loopback TEST transport): identity, Agreement, the browser
// Agreement session and the buyer's one Agreement CREATE, all under one
// intent, with the real embedded SDK wallet and the existing broker client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startDevnetAgreementTransportHarness } from './helpers/devnet-agreement-transport-harness.mjs';
import { startDevnetAgreementTransportSeller } from './helpers/devnet-agreement-transport-seller.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { gatedWallet, signedMessages, CountingDemos } from './helpers/start-intent.mjs';
import { runStart } from '../public/portal-intent/start-flow.mjs';
import { START_ANNOUNCEMENT } from '../public/portal-intent/gate.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';
import { operatorAuthLine } from '../public/portal-intent/intent.mjs';

let counter = 0;
// Node2's declared CREATE debit (src/devnet-demo/operator-approval.mjs): storage 1,
// SDK gas 1, network 1 and RPC 1 DEM, exactly the 4 DEM ceiling per write.
const NODE2_FEES = { networkFee: 1, rpcFee: 1 };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const AUTH_HASH = /^[0-9a-f]{64}$/;
// holdBinding: { phase, reached, until } holds that binding response until `until` resolves.
async function world(t, { nativeFees = NODE2_FEES, DemosCtor, around, holdBinding = null } = {}) {
  const h = await startDevnetAgreementTransportHarness({ env: { DACS_INTENT_APPROVAL: 'on' }, nativeFees });
  t.after(() => h.close());
  globalThis.location = new URL(h.origin);
  let client;
  const puts = [];
  const profile = await h.profile();
  // Every request the wallet sends to the source binding route: phase and auth headers.
  const binding = [];
  const bindingUrl = new URL(profile.bindingUrl, h.origin).href;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    if ((typeof url === 'string' || url instanceof URL) && new URL(url, h.origin).href === bindingUrl) {
      const headers = init?.headers ?? {};
      const { phase } = JSON.parse(init.body);
      binding.push({ phase, identity: headers.identity, timestamp: headers.timestamp, signature: headers.signature });
      if (holdBinding?.phase === phase) return realFetch(url, init).then(async (response) => { holdBinding.reached(); await holdBinding.until; return response; });
    }
    return realFetch(url, init);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const w = await gatedWallet({ transactionTransport: createDevnetAgreementWalletTransport(profile), DemosCtor, around,
    anchorJournal: { get: (k) => client.anchorJournal.get(k), put: (k, v) => { puts.push(v?.stage); return client.anchorJournal.put(k, v); }, withWalletLock: (k, work) => client.anchorJournal.withWalletLock(k, work) } });
  t.after(() => w.session.lock());
  const buyer = await linkPackagedWallet(h, w.session);
  const seller = await startDevnetAgreementTransportSeller(h, { listingId: `intent-devnet-${++counter}`, durable: true });
  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `intent-devnet-${counter}-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared));
  const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl);
  const api = async (path, body) => {
    const r = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body ?? {}) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.message || `request failed (${r.status})`), { code: data.error });
    return data;
  };
  client = createOfflineAgreementBrokerClient({ id, token, api });
  const recheck = async () => {
    for (let i = 0; i < 120; i++) {
      const view = await api(`/portal/api/purchase/${id}/protocol/recheck`, { token });
      if (!view.poll?.pending) return view;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('recheck did not settle');
  };
  const account = h.app.services.accounts.walletOwner(w.address);
  return { h, w, id, token, api, client, recheck, puts, binding, op: () => h.app.services.ops.get(account, id) };
}

test('devnet, switch on: one Start dialog covers identity, Agreement, browser session and the one Agreement CREATE', async (t) => {
  const x = await world(t);
  const dialogs = x.w.dialogs.length, signed = signedMessages.length;
  const next = await runStart({ id: x.id, token: x.token, address: x.w.address, gate: x.w.gate, api: x.api, origin: x.h.origin, broker: x.client, provider: x.w.session, recheck: x.recheck });
  assert.equal(next.status, 'awaiting_approval', JSON.stringify(next.evidence?.protocol?.lastAttempt));
  assert.deepEqual(x.w.dialogs.slice(dialogs).map((d) => d.method), ['approvePurchaseIntent'], 'exactly one wallet dialog');
  const intentText = x.w.dialogs.at(-1).message;
  assert.match(intentText, /Wallet writes covered: 1 \(the Agreement record, nonce 1\)/);
  assert.match(intentText, /Fee ceiling: 4 DEM per write, 4 DEM in total/);
  // The CREATE step lists main's two operator RPC auth signatures.
  assert.ok(intentText.split('\n').includes(operatorAuthLine(x.w.address)), 'the dialog lists the operator RPC auth signatures');
  // Identity, Agreement and browser session messages under the Start approval,
  // then main's two source RPC auth headers (bind and signature phases,
  // sdk-provider.mjs sourceAuthHeaders): a sha256 hex each, no transaction.
  const newly = signedMessages.slice(signed);
  assert.equal(newly.length, 5, 'identity, Agreement and browser session messages, plus two source auth headers');
  assert.match(newly[0], /^dacs-bundle-presentation:v1:[0-9a-f]{64}$/);
  assert.match(newly[1], /^dacs-payee-bound-agreement:v1:[0-9a-f]{64}$/);
  assert.match(newly[2], /requests a DACS wallet signature/);
  for (const auth of newly.slice(3)) assert.match(auth, AUTH_HASH, 'a source auth header hash, not a transaction');
  // Each is exactly sha256("ed25519:<address>:<timestamp>") of the headers the
  // binding request carried, bind first, then signature; no other phase signs.
  const authed = x.binding.filter((b) => b.identity !== undefined);
  assert.deepEqual(authed.map((b) => b.phase), ['bind', 'signature']);
  assert.deepEqual(x.binding.map((b) => b.phase).filter((phase) => !['bind', 'signature'].includes(phase)).sort(), ['broadcast', 'release']);
  authed.forEach((b, i) => {
    assert.equal(b.identity, `ed25519:${x.w.address}`);
    assert.match(b.timestamp, /^[0-9]+$/);
    assert.equal(newly[3 + i], sha256(`ed25519:${x.w.address}:${b.timestamp}`), `${b.phase}: the signed hash is the one its headers name`);
  });
  const accepted = x.h.chain.wire.record.accepted;
  assert.equal(accepted.length, 1, 'the Agreement CREATE was broadcast once');
  assert.equal(accepted[0].content.nonce, 1, 'at the planned nonce');
  assert.equal(x.op().state.protocol.agreement.anchorReceipt.writer, `did:demos:agent:${x.w.address.slice(2)}`);
  assert.equal(x.w.gate.active, false);
});

test('devnet, switch on: a CREATE at another nonce than planned is refused before signing; nothing is broadcast and the buyer is told why', async (t) => {
  const x = await world(t);
  const shifted = async (path, body) => {
    const r = await x.api(path, body);
    if (path.endsWith('/intent/start')) r.start.wallet.plannedNonce += 1;
    return r;
  };
  await assert.rejects(runStart({ id: x.id, token: x.token, address: x.w.address, gate: x.w.gate, api: shifted, origin: x.h.origin, broker: x.client, provider: x.w.session, recheck: x.recheck }),
    (error) => error.code === 'intent_mismatch' && error.field === 'nonce' && /Nothing was signed: the Agreement CREATE uses nonce 1, not the planned 2/.test(error.message));
  assert.equal(x.h.chain.wire.record.accepted.length, 0, 'nothing broadcast');
  assert.equal(x.h.chain.record.broadcasts.length, 0, 'no broadcast attempt at all');
});

test('devnet, switch on: a CREATE debit above the approved fee ceiling is refused before signing; nothing is broadcast', async (t) => {
  // The fixture's default fees (network 2, RPC 3): a 7 DEM CREATE.
  const x = await world(t, { nativeFees: null });
  await assert.rejects(runStart({ id: x.id, token: x.token, address: x.w.address, gate: x.w.gate, api: x.api, origin: x.h.origin, broker: x.client, provider: x.w.session, recheck: x.recheck }),
    (error) => error.code === 'intent_mismatch' && error.field === 'fee' && /costs 7 DEM, above the 4 DEM ceiling per write/.test(error.message));
  assert.equal(x.h.chain.record.broadcasts.length, 0, 'no broadcast attempt');
  assert.equal(x.h.chain.wire.record.accepted.length, 0, 'nothing written');
  assert.equal(x.op().state.protocol.agreement, undefined, 'no Agreement was anchored');
});

test('devnet, switch on, other wallets: the per-step flow keeps its four dialogs', async (t) => {
  const x = await world(t);
  const address = x.w.address;
  const sign = async (message) => { const r = await x.w.session.request({ method: 'sign', params: [message] }); assert.equal(r.success, true); return r.data.signature; };
  const dialogs = x.w.dialogs.length;
  const identity = await x.api(`/portal/api/purchase/${x.id}/agreement/identity`, { token: x.token, address });
  const planned = await x.api(`/portal/api/purchase/${x.id}/agreement/plan`, { token: x.token, signature: await sign(identity.signRequest.message) });
  const agreementSignature = await sign(planned.signRequest.agreementMessage);
  await x.client.authenticate({ address, sign });
  await x.api(`/portal/api/purchase/${x.id}/agreement/sign`, { token: x.token, agreementSignature });
  assert.equal((await x.client.approveOne(x.w.session)).state, 'completed');
  assert.equal((await x.recheck()).status, 'awaiting_approval');
  assert.deepEqual(x.w.dialogs.slice(dialogs).map((d) => d.method), ['sign', 'sign', 'sign', 'sendTransaction'], 'identity, Agreement, session and CREATE each ask');
  assert.equal(x.w.dialogs.at(-1).content.kind, 'devnet-agreement-storage-create');
});

test('devnet, switch on: a peer Start while the SDK signs the approved Agreement CREATE stops it before issue; nothing is broadcast, and the purchase closes as superseded', async (t) => {
  let signStarted; let releaseSign;
  const signing = new Promise((resolve) => { signStarted = resolve; });
  const released = new Promise((resolve) => { releaseSign = resolve; });
  t.after(() => releaseSign());
  // The real SDK, paused inside the storage transaction signature.
  class PausedDemos extends CountingDemos {
    async sign(transaction, options) {
      if (transaction?.content?.type === 'storageProgram') { signStarted(); await released; }
      return super.sign(transaction, options);
    }
  }
  const x = await world(t, { DemosCtor: PausedDemos });
  const outcome = runStart({ id: x.id, token: x.token, address: x.w.address, gate: x.w.gate, api: x.api, origin: x.h.origin, broker: x.client, provider: x.w.session }).then(() => 'completed', (error) => error);
  const first = await Promise.race([signing.then(() => 'signing'), outcome]);
  assert.equal(first, 'signing', `the CREATE never reached the SDK signature: ${first?.message ?? first}`);
  x.w.gate.peerStarted({ type: START_ANNOUNCEMENT, wallet: x.w.address });
  assert.equal(x.w.gate.active, false);
  releaseSign();
  const error = await outcome;
  assert.ok(error.code === 'intent_mismatch' && error.field === 'superseded' && /^Nothing was sent:.*this purchase is closed and nothing was paid; prepare a new purchase/.test(error.message), String(error?.message ?? error));
  assert.deepEqual(x.puts, [], 'the CREATE was never recorded as issued');
  assert.equal(x.h.chain.wire.record.accepted.length, 0, 'nothing written');
  assert.equal(x.h.chain.record.broadcasts.length, 0, 'no broadcast attempt');
  // The broker had handed the CREATE to the wallet, so the wallet's refusal
  // closes the purchase; the recorded reason is the fence's, as the buyer is told.
  const after = await x.recheck();
  assert.equal(after.status, 'agreement_rejected');
  assert.equal(after.evidence?.protocol?.lastAttempt?.reason, 'agreement-anchor: superseded');
  await assert.rejects(x.api(`/portal/api/purchase/${x.id}/intent/start`, { token: x.token, address: x.w.address }), (e) => e.code === 'invalid_state' && /agreement_rejected/.test(e.message));
  assert.equal(x.w.dialogs.filter((d) => d.method === 'sendTransaction').length, 0, 'no wallet write dialog either');
});

// A peer Start while the SDK session waits to make an operator RPC auth
// signature (sourceAuthHeaders): pending before the gate's fence, as when the
// session is still hashing, or inside the SDK signature itself.
for (const { phase, nth, inside } of [{ phase: 'bind', nth: 1, inside: false }, { phase: 'signature', nth: 2, inside: false }, { phase: 'signature', nth: 2, inside: true }]) {
  test(`devnet, switch on: a peer Start while the ${phase} auth signature is pending${inside ? ' inside the SDK' : ''} ${inside ? 'discards it' : 'signs nothing'}; no ${phase} request is sent, and the purchase closes as superseded`, async (t) => {
    let reached; let release;
    const pending = new Promise((resolve) => { reached = resolve; });
    const released = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    let auths = 0;
    const pause = async (message) => { if (AUTH_HASH.test(message) && ++auths === nth) { reached(); await released; } };
    // around: outside the fence (the SDK is not asked yet); DemosCtor: inside it.
    const options = inside
      ? { DemosCtor: class extends CountingDemos { async signMessage(message, o) { await pause(message); return super.signMessage(message, o); } } }
      : { around: (Fenced) => class extends Fenced { async signMessage(message, o) { await pause(message); return super.signMessage(message, o); } } };
    const x = await world(t, options);
    const signed = signedMessages.length;
    const outcome = runStart({ id: x.id, token: x.token, address: x.w.address, gate: x.w.gate, api: x.api, origin: x.h.origin, broker: x.client, provider: x.w.session }).then(() => 'completed', (error) => error);
    const first = await Promise.race([pending.then(() => 'pending'), outcome]);
    assert.equal(first, 'pending', `the ${phase} auth signature was never requested: ${first?.message ?? first}`);
    x.w.gate.peerStarted({ type: START_ANNOUNCEMENT, wallet: x.w.address });
    release();
    const error = await outcome;
    assert.ok(error.code === 'intent_mismatch' && error.field === 'superseded' && /^Nothing was sent: a newer purchase start, a lock or another tab replaced this one while the wallet was preparing the Agreement record\..*this purchase is closed and nothing was paid/.test(error.message), String(error?.message ?? error));
    const newly = signedMessages.slice(signed);
    assert.equal(newly.length, 3 + nth - (inside ? 0 : 1), inside ? 'the SDK had signed when the Start was replaced' : 'the SDK was not asked for the pending auth signature');
    assert.deepEqual(x.binding.filter((b) => b.identity !== undefined).map((b) => b.phase), ['bind', 'signature'].slice(0, nth - 1), `no ${phase} request was sent`);
    assert.equal(x.binding.filter((b) => b.phase === phase).length, 0, `no ${phase} request at all`);
    assert.equal(x.binding.filter((b) => b.phase === 'bind').length, nth - 1, 'the bind request only once its auth signature was made under the live Start');
    assert.deepEqual(x.puts, [], 'the CREATE was never recorded as issued');
    assert.equal(x.h.chain.record.broadcasts.length, 0, 'no broadcast attempt');
    // The native counter above does not see storage CREATEs; the wire's does.
    assert.equal(x.h.chain.wire.record.accepted.length, 0, 'nothing written');
    const after = await x.recheck();
    assert.equal(after.status, 'agreement_rejected');
    assert.equal(after.evidence?.protocol?.lastAttempt?.reason, 'agreement-anchor: superseded');
  });
}

test('devnet, switch on: a peer Start after the bind request, before the CREATE approval, gets no wallet dialog and no signature request; the purchase closes as superseded', async (t) => {
  let reached; let release;
  const pending = new Promise((resolve) => { reached = resolve; });
  const until = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const x = await world(t, { holdBinding: { phase: 'bind', reached, until } });
  const dialogs = x.w.dialogs.length, signed = signedMessages.length;
  const outcome = runStart({ id: x.id, token: x.token, address: x.w.address, gate: x.w.gate, api: x.api, origin: x.h.origin, broker: x.client, provider: x.w.session }).then(() => 'completed', (error) => error);
  const first = await Promise.race([pending.then(() => 'pending'), outcome]);
  assert.equal(first, 'pending', `the bind request was never sent: ${first?.message ?? first}`);
  x.w.gate.peerStarted({ type: START_ANNOUNCEMENT, wallet: x.w.address });
  release();
  const error = await outcome;
  assert.ok(error.code === 'intent_mismatch' && error.field === 'superseded' && /^Nothing was sent: a newer purchase start, a lock or another tab replaced this one while the wallet was preparing the Agreement record\./.test(error.message), String(error?.message ?? error));
  assert.deepEqual(x.w.dialogs.slice(dialogs).map((d) => d.method), ['approvePurchaseIntent'], 'no dialog for the dropped Start\'s CREATE');
  assert.equal(signedMessages.length - signed, 4, 'identity, Agreement, browser session and the bind auth signature only');
  assert.deepEqual(x.binding.map((b) => b.phase), ['bind'], 'no signature request');
  assert.deepEqual(x.puts, []);
  assert.equal(x.h.chain.wire.record.accepted.length, 0, 'nothing written');
  const after = await x.recheck();
  assert.equal(after.status, 'agreement_rejected');
  assert.equal(after.evidence?.protocol?.lastAttempt?.reason, 'agreement-anchor: superseded');
});
