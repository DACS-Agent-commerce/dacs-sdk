// Operator Agreement context consumer: actual OAuth/MCP, portal and broker
// HTTP, packaged SDK wallet signatures (synthetic approval callbacks; trusted
// Chrome clicks are the browser suite), the plugin seller HTTP client, and the
// UNCHANGED read-only Demo context resolver/responder over a TEST-only loopback
// adapter. Every authority is an explicit ephemeral simulation; payment, Vet,
// commitment, finality and completion remain held.
import runTest from 'node:test';
const referenceSkip = process.env.DACS_SELLER_INTEROP_REFERENCE ? false : 'DACS_SELLER_INTEROP_REFERENCE is not set: seller reference cases not run';
const test = (name, options, fn) => typeof options === 'function'
  ? runTest(name, { skip: referenceSkip }, options)
  : runTest(name, { ...options, skip: referenceSkip }, fn);
import assert from 'node:assert/strict';
import { canonicalize, contentHash, createFixedPriceAgreementSigningPlan, deriveFixedPriceAgreement, fixedPriceAgreementSignedBytes, identityBundleHash } from '@kynesyslabs/dacs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { startAgreementChain, linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { startContextHarness, startDemoContextSeller, providerSlot, sellerReference, TEST_AUTHORITY, SELLER_REFERENCE_DIGEST } from './helpers/agreement-context-integration.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';
import { planAgreement, vetNotPerformedRef } from '../src/dacs/purchase-protocol.mjs';
import { AGREEMENT_CONTEXT_SOURCE, agreementContextConfig } from '../src/dacs/agreement-context-consumer.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
let counter = 0;
const storage = (r) => r.content?.kind === 'dacs-storage-anchor-create';
const createKey = (id) => `browser-agreement/create/${id}`;
// Portal POST keeping the HTTP status apart from the operation `status` field.
const portal = async (h, path, body) => {
  const response = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  return { ...await response.json(), httpStatus: response.status };
};

// provider: 'installed' (operator TEST authority installed before purchase),
// 'empty' (provider configured, no authority installed) or 'none' (legacy).
async function setup(t, { provider = 'installed', sellerAuthority = true, mode = 'dacs-sr2-wallet-agreement' } = {}) {
  const chain = await startAgreementChain();
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  const slot = provider === 'none' ? null : providerSlot();
  const h = await startContextHarness({ chain, agreementContext: slot?.config, browserAgreement: { journal } });
  t.after(() => h.close());
  const api = async (path, body) => {
    const r = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body) });
    const out = await r.json();
    if (!r.ok) throw Object.assign(new Error(out.message), { code: out.error });
    return out;
  };
  let active;
  const approvals = [];
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic,
    anchorJournal: { get: (key) => active.anchorJournal.get(key), put: (key, value) => active.anchorJournal.put(key, value), withWalletLock: (key, work) => active.anchorJournal.withWalletLock(key, work) },
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (request) => { approvals.push(structuredClone(request)); return true; } });
  await wallet.create(); t.after(() => wallet.lock());
  const user = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async (message) => { const answer = await wallet.request({ method: 'sign', params: [message] }); assert.equal(answer.success, true); return answer.data.signature; };
  const operation = async () => {
    const seller = await startDemoContextSeller(h, { listingId: `plugin-context-${++counter}`, sellerAuthority });
    if (provider === 'installed') slot.install(seller);
    const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `plugin-context-${counter}`, protocol: mode });
    assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
    const token = tokenFrom(p.approvalUrl), id = p.operationId;
    const client = createOfflineAgreementBrokerClient({ id, token, api });
    const account = h.app.services.accounts.walletOwner(address);
    const op = () => h.app.services.ops.get(account, id);
    const identity = await portal(h, `/portal/api/purchase/${id}/agreement/identity`, { token, address });
    assert.equal(identity.httpStatus, 200, JSON.stringify(identity));
    const presentation = await sign(identity.signRequest.message);
    const plan = () => portal(h, `/portal/api/purchase/${id}/agreement/plan`, { token, signature: presentation });
    let signature;
    return { p, token, id, client, seller, op, account, plan, presentation,
      signPlanned: async (planned) => { signature = await sign(planned.signRequest.agreementMessage); return signature; },
      approveOne: () => { active = client; return client.approveOne(wallet); },
      submit: () => portal(h, `/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature: signature }),
      authenticate: () => client.authenticate({ address, sign }),
      verify: () => tool(h, user, 'verify_deal', { operationId: id }) };
  };
  const first = await operation();
  active = first.client;
  return { h, chain, journal, wallet, approvals, user, address, slot, operation, ...first };
}

// Independent expectation: the SDK derivation from test-known facts only (the
// Listing the test seeded, the retained wallet-presented bundle, the TEST
// authority's record refs and payee), never from plugin plan output.
function independentPlan(w, generatedAt) {
  const o = w.op(), jobId = o.terms.protocol.jobId, listing = w.seller.listing, buyerBundle = o.state.protocol.buyerBundle;
  const draft = deriveFixedPriceAgreement({ jobId, verifiedListing: { disposition: 'verified', listing, pin: w.seller.pin },
    buyer: { identityBundle: buyerBundle, vetRecordRef: w.seller.vetRef(jobId, buyerBundle.presentedBy) },
    seller: { identityBundle: listing.seller.identity, vetRecordRef: w.seller.vetRef(jobId, w.seller.wallet.claim) },
    selectedRail: { railId: 'demos-native:DEM', railVersion: 1 }, payoutBindings: [{ railId: 'demos-native:DEM', phaseIndex: 2, payeeAddress: w.seller.wallet.address }], generatedAt });
  return createFixedPriceAgreementSigningPlan(draft);
}

test('read-only Demo seller reference is the exact 17-file artifact', async () => {
  const api = await sellerReference();
  assert.equal(Object.keys(api.files).length, 17);
  assert.equal(typeof api.createAgreementContextResolver, 'function'); assert.equal(typeof api.createSellerAgreementResponder, 'function');
  assert.equal(SELLER_REFERENCE_DIGEST, 'dbe07f9c9cff45fa2a4af106b80614ce59c5ac19b9acf5c147aa315c78a298bf');
});

test('accepting: MCP/portal plan from the operator context matches the unchanged Demo responder; both sign; wallet-approved CREATE reads back agreement-anchored, payment held', async (t) => {
  const w = await setup(t);
  assert.equal(w.op().terms.protocol.agreementContext, AGREEMENT_CONTEXT_SOURCE);
  const planned = await w.plan();
  assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
  const o = w.op(), p = o.state.protocol, draft = p.planned.draft, jobId = o.terms.protocol.jobId;
  assert.equal(w.seller.providerCalls.length, 1);
  assert.deepEqual(w.seller.providerCalls[0], { source: AGREEMENT_CONTEXT_SOURCE, account: w.account, operation: w.id, wallet: w.address, jobId,
    buyer: p.buyerBundle.presentedBy, buyerBundleHash: identityBundleHash(p.buyerBundle), seller: w.seller.wallet.claim, listingPin: w.seller.pin,
    rail: { railId: 'demos-native:DEM', railVersion: 1 }, payee: w.seller.wallet.address, price: o.terms.price, generatedAt: draft.generatedAt });
  for (const party of draft.parties) {
    assert.deepEqual(party.vetRecordRef, w.seller.vetRef(jobId, party.primaryClaim));
    assert.notEqual(party.vetRecordRef.contentHash, vetNotPerformedRef(jobId, party.primaryClaim).contentHash);
  }
  const expected = independentPlan(w, draft.generatedAt);
  assert.equal(p.planned.plan.planHash, expected.planHash); assert.equal(p.planned.plan.agreementHash, expected.agreementHash);
  assert.equal(planned.signRequest.agreementMessage, Buffer.from(fixedPriceAgreementSignedBytes(expected)).toString('utf8'));
  assert.deepEqual(p.agreementContext.authority, TEST_AUTHORITY);
  // Re-entry returns the retained exact plan; the provider is not consulted again.
  const again = await w.plan(); assert.equal(again.signRequest.agreementMessage, planned.signRequest.agreementMessage); assert.equal(w.seller.providerCalls.length, 1);
  await w.signPlanned(planned);
  await w.authenticate();
  const queued = await w.submit();
  assert.equal(queued.httpStatus, 200, JSON.stringify(queued));
  assert.equal(w.seller.progress.length, 1);
  assert.equal(w.seller.progress[0].disposition, 'complete', JSON.stringify(w.seller.progress[0]));
  assert.deepEqual(w.seller.signed, [w.seller.wallet.claim]); assert.equal(w.seller.published.length, 1);
  assert.equal(canonicalize(w.seller.received[0].proposal.plan), canonicalize(p.planned.plan), 'the exact wallet-signed plan reached the seller unmodified');
  assert.deepEqual(w.seller.verifiedVets.map((v) => v.status), ['valid', 'valid']);
  assert.equal(w.seller.listingReads.length, 2);
  for (const read of w.seller.listingReads) { assert.equal(read.status, 200); assert.equal(read.bytes, canonicalize(w.seller.listing)); }
  assert.equal(queued.evidence.protocol.stage, 'agreement-signing'); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  assert.equal((await w.approveOne()).state, 'completed');
  const out = await w.verify();
  assert.equal(out.protocol.stage, 'agreement-anchored', JSON.stringify(out));
  const anchored = w.op().state.protocol.agreement.artifact;
  assert.equal(contentHash(anchored), expected.agreementHash);
  assert.deepEqual(anchored.signatures.map((s) => s.party), [p.buyerBundle.presentedBy, w.seller.wallet.claim]);
  assert.equal(canonicalize(w.chain.wire.record.accepted[0].content.data[1].data), canonicalize(w.op().state.protocol.walletAnchor.artifact));
  assert.equal(canonicalize(anchored), canonicalize(w.op().state.protocol.walletAnchor.artifact));
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1); assert.equal(w.approvals.filter(storage).length, 1);
  assert.equal(out.protocol.limits.payment, 'held'); assert.match(out.protocol.limits.vet, /not performed or verified by the plugin/);
  assert.equal(out.protocol.agreementContext.authority, TEST_AUTHORITY);
  assert.equal(out.protocol.layers.dacsPurchase, 'not-evidenced'); assert.equal(out.protocol.commitment, null);
  assert.equal(out.status, 'agreement_pending');
  for (const part of ['challenge', 'handoff']) assert.equal((await portal(w.h, `/portal/api/purchase/${w.id}/${part}`, { token: w.token, address: w.address })).error, 'agreement_payment_held');
  await assert.rejects(w.approveOne(), /completed.*no replay/);
  await w.verify(); assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal(w.seller.progress.length, 1, 'no second proposal after anchoring');
  // After anchoring the plan step is closed; nothing is re-planned.
  const closed = await w.plan(); assert.equal(closed.httpStatus, 409); assert.equal(closed.error, 'invalid_state'); assert.equal(w.seller.providerCalls.length, 1);
  t.diagnostic(JSON.stringify({ stage: out.protocol.stage, agreementHash: expected.agreementHash, nativeAddress: out.protocol.agreement.nativeAddress, sellerSigned: w.seller.signed.length, broadcasts: 1, payment: 'held' }));
  assert.deepEqual(externalAttempts, []);
});

test('configured provider without installed authority holds before plan/sign; later authority plans once', async (t) => {
  const w = await setup(t, { provider: 'empty' });
  const held = await w.plan();
  assert.equal(held.httpStatus, 409); assert.equal(held.error, 'agreement_context_held'); assert.match(held.message, /indeterminate.*no Agreement was planned or signed/);
  const o = w.op();
  assert.equal(o.state.protocol.stage, 'identity'); assert.equal(o.state.protocol.planned, undefined);
  assert.equal(o.state.protocol.attempts.at(-1).step, 'agreement-context'); assert.equal(o.state.protocol.attempts.at(-1).outcome, 'indeterminate');
  const status = await w.verify(); assert.equal(status.protocol.stage, 'identity'); assert.equal(status.protocol.limits.payment, 'held');
  assert.equal(w.seller.received.length, 0); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  w.slot.install(w.seller);
  const planned = await w.plan(); assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
  assert.equal(w.op().state.protocol.planned.plan.planHash, independentPlan(w, w.op().state.protocol.planned.draft.generatedAt).planHash);
});

test('guard witness: each out-of-scope or indeterminate provider answer is held with no plan, proposal or CREATE', async (t) => {
  const w = await setup(t);
  const good = w.seller.resolveTrusted;
  const variants = [
    ['throws', async () => { throw new Error('TEST provider down'); }, 'indeterminate'],
    ['absent', async () => ({ disposition: 'absent', reason: 'TEST none' }), 'absent'],
    ['unknown disposition', async () => ({ disposition: 'verified' }), 'indeterminate'],
    ['scope of another account', async (r) => { const a = await good(r); a.value.scope = { ...a.value.scope, account: 'acct_other' }; return a; }, 'rejected'],
    ['placeholder Vet ref', async (r) => { const a = await good(r); a.value.input.buyer.vetRecordRef = { ...vetNotPerformedRef(r.scope.jobId, r.scope.buyer), signer: w.seller.vetWriter.claim }; return a; }, 'rejected'],
    ['Vet ref at another job', async (r) => { const a = await good(r); a.value.input.seller.vetRecordRef.anchor.locator = 'dacs2:composite:other'; return a; }, 'rejected'],
    ['self-signed Vet ref', async (r) => { const a = await good(r); a.value.input.buyer.vetRecordRef.signer = r.scope.buyer; return a; }, 'rejected'],
    ['Listing bytes altered but marked verified', async (r) => { const a = await good(r); a.value.input.verifiedListing.listing = { ...a.value.input.verifiedListing.listing, listingVersion: 2 }; return a; }, 'rejected'],
    ['other payee', async (r) => { const a = await good(r); a.value.input.payoutBindings[0].payeeAddress = `0x${'1'.repeat(64)}`; return a; }, 'rejected'],
    ['other buyer bundle', async (r) => { const a = await good(r); a.value.input.buyer.identityBundle = structuredClone(a.value.input.seller.identityBundle); return a; }, 'rejected'],
    ['other generatedAt', async (r) => { const a = await good(r); a.value.input.generatedAt += 1; return a; }, 'rejected'],
    ['other rail', async (r) => { const a = await good(r); a.value.input.selectedRail = { railId: 'demos-native:DEM', railVersion: 2 }; return a; }, 'rejected'],
    ['extra input field', async (r) => { const a = await good(r); a.value.input.verified = true; return a; }, 'rejected'],
    ['other job in input', async (r) => { const a = await good(r); a.value.input.jobId = '01M45GN02CFXG31WX9T81TDMWP'; return a; }, 'rejected'],
    ['Listing not reader-verified', async (r) => { const a = await good(r); a.value.input.verifiedListing.disposition = 'indeterminate'; return a; }, 'rejected'],
    ['Listing pin altered', async (r) => { const a = await good(r); a.value.input.verifiedListing.pin.contentHash = '0'.repeat(64); return a; }, 'rejected'],
    ['seller bundle swapped', async (r) => { const a = await good(r); a.value.input.seller.identityBundle = structuredClone(a.value.input.buyer.identityBundle); return a; }, 'rejected'],
    ['Vet ref without signer', async (r) => { const a = await good(r); delete a.value.input.seller.vetRecordRef.signer; return a; }, 'rejected'],
    ['present without scope echo', async (r) => { const a = await good(r); delete a.value.scope; return a; }, 'indeterminate'],
  ];
  for (const [name, fault, disposition] of variants) {
    w.seller.faults.provider = fault;
    const held = await w.plan();
    assert.equal(held.error, 'agreement_context_held', `${name}: ${JSON.stringify(held)}`);
    assert.equal(w.op().state.protocol.attempts.at(-1).outcome, disposition, name);
    assert.equal(w.op().state.protocol.planned, undefined, name);
  }
  assert.equal(w.seller.received.length, 0); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0); assert.equal(w.approvals.filter(storage).length, 0);
  w.seller.faults.provider = null;
  const planned = await w.plan(); assert.equal(planned.httpStatus, 200, 'accepting control after the guard variants');
  t.diagnostic(`held variants: ${variants.length}`);
});

test('concurrent plan requests across the async provider read retain exactly one plan', async (t) => {
  const w = await setup(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  w.seller.faults.provider = async (r) => { await gate; return w.seller.resolveTrusted(r); };
  const both = Promise.all([w.plan(), w.plan()]);
  await new Promise((resolve) => setTimeout(resolve, 50)); release();
  const [a, b] = await both;
  assert.equal(a.httpStatus, 200, JSON.stringify(a)); assert.equal(b.httpStatus, 200, JSON.stringify(b));
  const retained = w.op().state.protocol.planned.agreementMessage;
  assert.equal(a.signRequest.agreementMessage, retained); assert.equal(b.signRequest.agreementMessage, retained);
  assert.equal(w.h.app.services.ops.history(w.id).filter((e) => e.type === 'protocol_agreement_planned').length, 1);
});

test('Demo seller without its IO/policy authority stays indeterminate at context; no seller signature or CREATE', async (t) => {
  const w = await setup(t, { sellerAuthority: false });
  const planned = await w.plan(); assert.equal(planned.httpStatus, 200);
  await w.signPlanned(planned); await w.authenticate();
  const submitted = await w.submit(); assert.equal(submitted.httpStatus, 200);
  const progress = w.seller.progress[0];
  assert.deepEqual([progress.disposition, progress.stage], ['indeterminate', 'context']); assert.match(progress.reason, /^CONTEXT_IO_UNAVAILABLE/);
  assert.deepEqual(w.seller.signed, []); assert.deepEqual(w.seller.published, []);
  assert.equal((await w.verify()).protocol.stage, 'agreement-signing');
  assert.equal(w.op().state.protocol.walletAnchor, undefined); assert.equal(w.journal.get(createKey(w.id)), undefined);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('unknown after applied CREATE on the context path: readback only, never a second claim/broadcast', async (t) => {
  const w = await setup(t);
  const planned = await w.plan(); await w.signPlanned(planned); await w.authenticate(); await w.submit();
  w.chain.wire.faults.dropAfterApply = true;
  assert.equal((await w.approveOne()).state, 'uncertain');
  w.chain.faults.unavailable = true;
  assert.equal((await w.verify()).protocol.lastAttempt.outcome, 'indeterminate');
  w.chain.faults.unavailable = false; w.chain.wire.faults.dropAfterApply = false;
  assert.equal((await w.verify()).protocol.stage, 'agreement-anchored');
  await assert.rejects(w.approveOne(), /uncertain.*no replay/);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1); assert.equal(w.seller.progress.length, 1);
});

test('second operation on one wallet (context path): unsent B fenced until A readback, then each anchors once', async (t) => {
  const w = await setup(t), b = await w.operation();
  for (const x of [w, b]) { const planned = await x.plan(); assert.equal(planned.httpStatus, 200); await x.signPlanned(planned); await x.authenticate(); }
  await w.submit();
  const queuedB = (await b.submit()).evidence.protocol;
  assert.match(queuedB.lastAttempt.reason, /wallet-fenced/); assert.equal(b.op().state.protocol.walletAnchor, null);
  assert.equal((await w.approveOne()).state, 'completed');
  assert.equal((await w.verify()).protocol.stage, 'agreement-anchored');
  assert.equal((await b.verify()).protocol.stage, 'agreement-signing');
  assert.equal((await b.approveOne()).state, 'completed');
  assert.equal((await b.verify()).protocol.stage, 'agreement-anchored');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 2); assert.equal(w.approvals.filter(storage).length, 2);
  assert.notEqual(w.op().state.protocol.planned.plan.agreementHash, b.op().state.protocol.planned.plan.agreementHash);
});

test('owner scope: another handoff token cannot plan; legacy profile without a provider keeps placeholder refs and exact SDK bytes', async (t) => {
  const w = await setup(t, { provider: 'none' });
  assert.equal((await portal(w.h, `/portal/api/purchase/${w.id}/agreement/plan`, { token: 'not-this-handoff', signature: w.presentation })).httpStatus, 404);
  assert.equal(Object.hasOwn(w.op().terms.protocol, 'agreementContext'), false);
  const planned = await w.plan(); assert.equal(planned.httpStatus, 200);
  const o = w.op(), p = o.state.protocol, jobId = o.terms.protocol.jobId;
  for (const party of p.planned.draft.parties) assert.deepEqual(party.vetRecordRef, vetNotPerformedRef(jobId, party.primaryClaim));
  const legacy = planAgreement({ jobId, listing: p.listing, buyerBundle: p.buyerBundle, generatedAt: p.planned.draft.generatedAt });
  assert.equal(canonicalize(legacy.plan), canonicalize(p.planned.plan)); assert.equal(legacy.agreementMessage, planned.signRequest.agreementMessage);
  assert.equal(p.agreementContext, undefined); assert.equal(w.seller.providerCalls.length, 0);
  const status = await w.verify(); assert.equal(status.protocol.limits.vet, 'not-performed'); assert.equal(status.protocol.agreementContext, undefined);
  // Against the Demo seller with valid TEST facts the legacy placeholder plan
  // is still refused (retained gap characterization, as the interop witness).
  w.seller.installFacts(jobId, p.buyerBundle);
  await w.signPlanned(planned); await w.authenticate(); await w.submit();
  assert.deepEqual([w.seller.progress[0].disposition, w.seller.progress[0].stage], ['rejected', 'context']);
  assert.equal(w.seller.progress[0].reason, 'proposal plan differs from the independently derived seller agreement');
  assert.deepEqual(w.seller.verifiedVets.map((v) => v.status), ['valid', 'valid']); assert.deepEqual(w.seller.signed, []);
  assert.equal((await w.verify()).protocol.stage, 'agreement-rejected');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0); assert.equal(w.approvals.filter(storage).length, 0);
});

test('provider is scoped to the opt-in wallet profile: a dacs-pay-dem purchase keeps the legacy plan', async (t) => {
  const w = await setup(t, { mode: 'dacs-pay-dem' });
  assert.equal(Object.hasOwn(w.op().terms.protocol, 'agreementContext'), false);
  const planned = await w.plan(); assert.equal(planned.httpStatus, 200);
  const o = w.op(), jobId = o.terms.protocol.jobId;
  for (const party of o.state.protocol.planned.draft.parties) assert.deepEqual(party.vetRecordRef, vetNotPerformedRef(jobId, party.primaryClaim));
  assert.equal(w.seller.providerCalls.length, 0);
});

test('malformed operator configuration fails at construction, never silently falls back', () => {
  assert.equal(agreementContextConfig(undefined), null);
  for (const bad of [{}, { resolve: () => null }, { authority: 'x' }, { authority: '', resolve: () => null }, { authority: 'x', resolve: () => null, verified: true }, { authority: 'x', resolve: 'no' }]) {
    assert.throws(() => agreementContextConfig(bad), /exactly \{ authority, resolve \}/);
  }
});

test('Node harness never attempted an external connection', () => assert.deepEqual(externalAttempts, []));
