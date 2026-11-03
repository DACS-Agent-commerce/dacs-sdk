// Interaction coverage for the operator Agreement context runtime (input
// 8e74d294...): provider hold then valid context across cold app
// reconstruction with the explicit same TEST provider, reconstruction without
// a provider, and the operation expiring while the provider read is pending.
// Actual OAuth/MCP, portal and broker HTTP, SQLite durable broker journal
// (opt-in harness wiring; reopened on every reconstruction), packaged SDK
// wallet signatures with synthetic approval, the UNCHANGED read-only Demo
// resolver/responder. All authority is ephemeral TEST simulation; payment,
// Vet, commitment and finality stay held. Not security acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '@kynesyslabs/dacs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { startAgreementChain, linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { startDemoContextSeller, providerSlot, TEST_AUTHORITY } from './helpers/agreement-context-integration.mjs';
import { startRestartableContextHarness } from './helpers/agreement-context-interactions.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';
import { vetNotPerformedRef } from '../src/dacs/purchase-protocol.mjs';
import { AGREEMENT_CONTEXT_SOURCE } from '../src/dacs/agreement-context-consumer.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
let counter = 0;
const storage = (r) => r.content?.kind === 'dacs-storage-anchor-create';
const portal = async (h, path, body) => {
  const response = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { ...await response.json(), httpStatus: response.status };
};

async function setup(t, { install = true, now } = {}) {
  const chain = await startAgreementChain();
  const slot = providerSlot();
  const h = await startRestartableContextHarness({ chain, now, agreementContext: slot.config });
  t.after(() => h.close());
  const api = async (path, body) => {
    const r = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body) });
    const out = await r.json();
    if (!r.ok) throw Object.assign(new Error(out.message), { code: out.error });
    return out;
  };
  let client;
  const approvals = [];
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic,
    anchorJournal: { get: (k) => client.anchorJournal.get(k), put: (k, v) => client.anchorJournal.put(k, v), withWalletLock: (k, w) => client.anchorJournal.withWalletLock(k, w) },
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (request) => { approvals.push(structuredClone(request)); return true; } });
  await wallet.create(); t.after(() => wallet.lock());
  const user = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async (message) => { const a = await wallet.request({ method: 'sign', params: [message] }); assert.equal(a.success, true); return a.data.signature; };
  const clock = now ?? (() => Date.now());
  const seller = await startDemoContextSeller(h, { listingId: `context-interactions-${++counter}`, clock });
  if (install) slot.install(seller);
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `context-interactions-${counter}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const token = tokenFrom(p.approvalUrl), id = p.operationId;
  client = createOfflineAgreementBrokerClient({ id, token, api });
  const account = h.app.services.accounts.walletOwner(address);
  const identity = await portal(h, `/portal/api/purchase/${id}/agreement/identity`, { token, address });
  assert.equal(identity.httpStatus, 200, JSON.stringify(identity));
  const presentation = await sign(identity.signRequest.message);
  let signature;
  return { h, chain, slot, seller, wallet, approvals, user, address, p, token, id, account, client, sign,
    op: () => h.app.services.ops.get(account, id),
    plan: () => portal(h, `/portal/api/purchase/${id}/agreement/plan`, { token, signature: presentation }),
    signPlanned: async (planned) => { signature = await sign(planned.signRequest.agreementMessage); },
    submit: () => portal(h, `/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature: signature }),
    authenticate: () => client.authenticate({ address, sign }),
    approveOne: () => client.approveOne(wallet),
    verify: () => tool(h, user, 'verify_deal', { operationId: id }) };
}

test('cold reconstruction with the same TEST provider: held before restart, plans once after; retained plan survives another restart uncalled; owner-bound CREATE reads back once', async (t) => {
  const w = await setup(t, { install: false });
  const held = await w.plan();
  assert.deepEqual([held.httpStatus, held.error], [409, 'agreement_context_held']);
  assert.match(held.message, /indeterminate/);
  assert.equal(w.op().state.protocol.planned, undefined);
  // Operator installs the TEST authority, then the app is rebuilt with the same provider config.
  w.slot.install(w.seller);
  await w.h.restart(w.slot.config);
  assert.equal(w.op().terms.protocol.agreementContext, AGREEMENT_CONTEXT_SOURCE, 'marker persisted in the operation row');
  assert.equal(w.op().state.protocol.attempts.at(-1).step, 'agreement-context');
  const planned = await w.plan();
  assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
  assert.equal(w.seller.providerCalls.length, 1, 'only the post-install read reached the TEST authority');
  const jobId = w.op().terms.protocol.jobId;
  for (const party of w.op().state.protocol.planned.draft.parties) {
    assert.deepEqual(party.vetRecordRef, w.seller.vetRef(jobId, party.primaryClaim));
    assert.notEqual(party.vetRecordRef.contentHash, vetNotPerformedRef(jobId, party.primaryClaim).contentHash);
  }
  const agreementHash = w.op().state.protocol.planned.plan.agreementHash;
  // Witness: with NO provider configured the retained plan is still returned, so the
  // re-entry result comes from persisted state, not from a fresh provider derivation.
  await w.h.restart(null);
  const retainedWithoutProvider = await w.plan();
  assert.equal(retainedWithoutProvider.httpStatus, 200, JSON.stringify(retainedWithoutProvider));
  assert.equal(retainedWithoutProvider.signRequest.agreementMessage, planned.signRequest.agreementMessage);
  await w.h.restart(w.slot.config);
  const again = await w.plan();
  assert.equal(again.signRequest.agreementMessage, planned.signRequest.agreementMessage, 'retained plan returned after reconstruction');
  assert.equal(w.seller.providerCalls.length, 1, 'provider not consulted for a retained plan');
  assert.equal(w.op().state.protocol.agreementContext.authority, TEST_AUTHORITY);
  await w.signPlanned(planned);
  await w.authenticate();
  const queued = await w.submit();
  assert.equal(queued.httpStatus, 200, JSON.stringify(queued));
  assert.equal(w.seller.progress.at(-1).disposition, 'complete', JSON.stringify(w.seller.progress.at(-1)));
  assert.deepEqual(w.seller.signed, [w.seller.wallet.claim]);
  assert.equal(queued.evidence.protocol.stage, 'agreement-signing');
  assert.equal((await w.h.store.journal.get(`browser-agreement/create/${w.id}`)).stage, 'queued');
  assert.equal((await w.approveOne()).state, 'completed');
  const out = await w.verify();
  assert.equal(out.protocol.stage, 'agreement-anchored', JSON.stringify(out));
  const tx = w.chain.wire.record.accepted[0];
  assert.equal(tx.content.from, w.address, 'CREATE is owned by the linked purchase wallet');
  assert.equal(contentHash(tx.content.data[1].data), agreementHash, 'anchored artifact is the planned two-party Agreement');
  assert.deepEqual(w.op().state.protocol.agreement.artifact.signatures.map((s) => s.party), [w.op().state.protocol.buyerBundle.presentedBy, w.seller.wallet.claim]);
  assert.equal(out.protocol.limits.payment, 'held');
  // Third reconstruction: stage and journal survive; repeats only observe.
  await w.h.restart(w.slot.config);
  assert.equal((await w.verify()).protocol.stage, 'agreement-anchored');
  assert.equal((await w.h.store.journal.get(`browser-agreement/create/${w.id}`)).stage, 'completed');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1); assert.equal(w.approvals.filter(storage).length, 1);
  assert.equal(w.seller.progress.length, 1); assert.equal(w.seller.providerCalls.length, 1);
  t.diagnostic(JSON.stringify({ restarts: w.h.restarts, providerCalls: w.seller.providerCalls.length, sellerProposals: w.seller.progress.length, broadcasts: 1, agreementHash }));
});

test('reconstruction without the provider: marked purchase stays held (no placeholder fallback), new purchases are legacy; restoring the same provider plans once', async (t) => {
  const w = await setup(t);
  await w.h.restart(null);
  const held = await w.plan();
  assert.deepEqual([held.httpStatus, held.error], [409, 'agreement_context_held']);
  assert.match(held.message, /CONTEXT_PROVIDER_UNAVAILABLE/);
  assert.equal(w.op().state.protocol.planned, undefined, 'no placeholder plan for a marked purchase');
  assert.equal(w.seller.providerCalls.length, 0);
  // Retained legacy profile on the provider-less app: a new purchase carries no marker.
  const s2 = await startDemoContextSeller(w.h, { listingId: `context-interactions-legacy-${++counter}` });
  const legacy = await tool(w.h, w.user, 'prepare_purchase', { listingId: s2.listing.listingId, version: 1, seller: s2.wallet.claim, idempotencyKey: `context-interactions-legacy-${counter}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(legacy.status, 'agreement_pending', JSON.stringify(legacy));
  assert.equal(Object.hasOwn(w.h.app.services.ops.get(w.account, legacy.operationId).terms.protocol, 'agreementContext'), false);
  await w.h.restart(w.slot.config);
  const planned = await w.plan();
  assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
  assert.equal(w.seller.providerCalls.length, 1);
  const jobId = w.op().terms.protocol.jobId;
  for (const party of w.op().state.protocol.planned.draft.parties) assert.deepEqual(party.vetRecordRef, w.seller.vetRef(jobId, party.primaryClaim));
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('operation expires while the provider read is pending and another request expires it: nothing planned', async (t) => {
  let offset = 0;
  const now = () => Date.now() + offset;
  const w = await setup(t, { now });
  let release; const gate = new Promise((r) => { release = r; });
  w.seller.faults.provider = async (r) => { await gate; return w.seller.resolveTrusted(r); };
  const pending = w.plan();
  while (w.seller.providerCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
  offset = Date.parse(w.op().expiresAt) - Date.now() + 1000;
  const other = await portal(w.h, `/portal/api/purchase/${w.id}/agreement/identity`, { token: w.token, address: w.address });
  t.diagnostic(`intervening request after expiry: ${other.httpStatus} ${other.error ?? other.status}`);
  assert.notEqual(w.op().status, 'agreement_pending', 'the intervening entry point expired the operation');
  release();
  const out = await pending;
  assert.equal(out.httpStatus, 409, JSON.stringify(out)); assert.equal(out.error, 'invalid_state');
  assert.match(out.message, /changed while its Agreement context was read/);
  assert.equal(w.op().state.protocol.planned, undefined);
  assert.equal(w.seller.received.length, 0); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

// G1 repaired oracle (the an earlier review characterization, which observed 200 and a
// saved plan, is preserved in the an earlier review evidence and failed 1/1 against this
// repair before being updated).
test('operation passes expiresAt while the provider read is pending with no intervening request: 409, nothing planned', async (t) => {
  let offset = 0;
  const now = () => Date.now() + offset;
  const w = await setup(t, { now });
  let release; const gate = new Promise((r) => { release = r; });
  w.seller.faults.provider = async (r) => { await gate; return w.seller.resolveTrusted(r); };
  const pending = w.plan();
  while (w.seller.providerCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
  offset = Date.parse(w.op().expiresAt) - Date.now() + 1000;
  release();
  const out = await pending;
  const after = w.op();
  t.diagnostic(JSON.stringify({ planHttp: out.httpStatus, planError: out.error ?? null, status: after.status, planned: Boolean(after.state.protocol.planned) }));
  assert.equal(out.httpStatus, 409, JSON.stringify(out)); assert.equal(out.error, 'invalid_state');
  assert.match(out.message, /approval window elapsed while its Agreement context was read/);
  assert.equal(after.state.protocol.planned, undefined); assert.equal(after.state.protocol.stage, 'identity');
  assert.equal(w.h.app.services.ops.history(w.id).filter((e) => e.type === 'protocol_agreement_planned').length, 0);
  // Lazy expiry is unchanged: the next entry point records it.
  const next = await w.plan();
  assert.equal(next.httpStatus, 409); assert.equal(w.op().status, 'expired');
  assert.equal(w.seller.providerCalls.length, 1, 'expired entry never reaches the provider again');
  assert.equal(w.seller.received.length, 0); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  assert.equal(await w.h.store.journal.get(`browser-agreement/create/${w.id}`), undefined);
});

test('accepting time control: provider read completing just inside the approval window plans normally', async (t) => {
  let offset = 0;
  const now = () => Date.now() + offset;
  const w = await setup(t, { now });
  let release; const gate = new Promise((r) => { release = r; });
  w.seller.faults.provider = async (r) => { await gate; return w.seller.resolveTrusted(r); };
  const pending = w.plan();
  while (w.seller.providerCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
  offset = Date.parse(w.op().expiresAt) - Date.now() - 5000;
  release();
  const out = await pending;
  assert.equal(out.httpStatus, 200, JSON.stringify(out));
  assert.equal(w.op().state.protocol.stage, 'agreement-signing');
  const jobId = w.op().terms.protocol.jobId;
  for (const party of w.op().state.protocol.planned.draft.parties) assert.deepEqual(party.vetRecordRef, w.seller.vetRef(jobId, party.primaryClaim));
});

// One plan step per purchase: a concurrent request with the same signature
// waits for the running step instead of making a second provider read (the
// second read is what re-ran the buyer Vet in the live failure).
test('concurrent plan requests share one provider read and one saved plan; a request after expiry is refused and the plan is not replaced', async (t) => {
  let offset = 0;
  const now = () => Date.now() + offset;
  const w = await setup(t, { now });
  const gates = [];
  w.seller.faults.provider = async (r) => { await new Promise((resolve) => gates.push(resolve)); return w.seller.resolveTrusted(r); };
  const first = w.plan(), second = w.plan();
  while (gates.length < 1) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(gates.length, 1, 'the second request waits for the running plan step');
  gates[0]();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.httpStatus, 200, JSON.stringify(a)); assert.equal(b.httpStatus, 200, JSON.stringify(b));
  assert.equal(b.signRequest.agreementMessage, a.signRequest.agreementMessage);
  const savedMessage = w.op().state.protocol.planned.agreementMessage;
  offset = Date.parse(w.op().expiresAt) - Date.now() + 1000;
  const late = await w.plan();
  assert.equal(late.httpStatus, 409, JSON.stringify(late));
  assert.equal(late.signRequest, undefined);
  assert.equal(w.op().state.protocol.planned.agreementMessage, savedMessage, 'the plan saved inside the window is not replaced');
  assert.equal(w.h.app.services.ops.history(w.id).filter((e) => e.type === 'protocol_agreement_planned').length, 1);
  assert.equal(gates.length, 1);
  assert.equal(w.seller.received.length, 0); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('context interaction harness never attempted an external connection', () => assert.deepEqual(externalAttempts, []));
