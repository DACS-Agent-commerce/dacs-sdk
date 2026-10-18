// Source-aware HTTP/MCP controls, real packaged SDK signatures; approvals here
// are synthetic callbacks. Trusted user-event acceptance is the Chrome suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { tool, portal, tokenFrom, linkedUser } from './helpers/flows.mjs';
import { sellerValue } from './helpers/model-report.mjs';
import { startAgreementChain, linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';
import { createOfflineAgreementBroker } from '../src/portal/offline-agreement-broker.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { canonicalize } from '@kynesyslabs/dacs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
let counter = 0;
const storage = (r) => r.content?.kind === 'dacs-storage-anchor-create';

async function setup(t, { allow = true, now, ttlMs = 120000, journalFault = false, probeJournal = false } = {}) {
  const chain = await startAgreementChain();
  const memory = memoryAnchorJournal();
  const journal = { ...memory, entries: () => memory.snapshot(), put: (key, value) => {
    if (journalFault && key.startsWith('sr2/wallet/')) throw new Error('fixture persistence failure');
    return memory.put(key, value);
  } };
  const h = await startProtocolHarness({ chain, now, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' }, browserAgreement: { journal, ttlMs } });
  t.after(() => h.close());
  const calls = [], probes = [];
  const api = async (path, body) => {
    calls.push({ path, body: structuredClone(body) });
    if (probeJournal && path.endsWith('/journal/put') && body.record.stage === 'broadcast-started') {
      const check = async (candidate, expected) => {
        const r = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(candidate) });
        const out = await r.json(); assert.equal(r.status, 409); assert.equal(out.error, expected); probes.push(expected);
      };
      await check({ ...body, correlation: 'wrong-correlation' }, 'broker_correlation_mismatch');
      await check({ ...body, requestHash: '0'.repeat(64) }, 'broker_correlation_mismatch');
      await check({ ...body, key: 'another-wallet-lane' }, 'broker_lane_mismatch');
      await check({ ...body, record: { ...body.record, hash: '0'.repeat(64) } }, 'broker_signed_scope_invalid');
      await check({ ...body, record: { ...body.record, approved: { ...body.record.approved, owner: 'did:demos:agent:wrong' } } }, 'broker_signed_scope_invalid');
      await check({ ...body, record: { ...body.record, approved: { ...body.record.approved, contentHash: '0'.repeat(64) } } }, 'broker_signed_scope_invalid');
      const r = await fetch(`${h.origin}${path.replace('/journal/put', '/complete')}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify({ ...body, answer: { success: true, data: { hash: body.record.hash, nonce: body.record.nonce, status: 'broadcast_accepted', evidenceMode: 'simulated-fixture' }, error: null } }) });
      assert.equal((await r.json()).error, 'broker_result_invalid'); probes.push('broker_result_invalid');
    }
    const res = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body) });
    const out = await res.json();
    if (!res.ok) { calls.push({ rejectedPath: path, error: out.error, message: out.message }); throw Object.assign(new Error(out.message), { code: out.error }); }
    return out;
  };
  let client;
  const approvals = [];
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic,
    anchorJournal: { get: (key) => client.anchorJournal.get(key), put: (key, value) => client.anchorJournal.put(key, value), withWalletLock: (key, work) => client.anchorJournal.withWalletLock(key, work) },
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (request) => { approvals.push(structuredClone(request)); return storage(request) ? allow : true; } });
  await wallet.create(); t.after(() => wallet.lock());
  const user = await linkPackagedWallet(h, wallet);
  const seller = await addSeller(h, { listingId: `browser-broker-${++counter}` });
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `broker-${counter}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const token = tokenFrom(p.approvalUrl), id = p.operationId;
  client = createOfflineAgreementBrokerClient({ id, token, api });
  const sign = async (message) => { const answer = await wallet.request({ method: 'sign', params: [message] }); assert.equal(answer.success, true); return answer.data.signature; };
  const identity = await portal(h, `/portal/api/purchase/${id}/agreement/identity`, { token, address: wallet.getPublicAccount().address });
  const planned = await portal(h, `/portal/api/purchase/${id}/agreement/plan`, { token, signature: await sign(identity.signRequest.message) });
  assert.equal(planned.error, undefined, JSON.stringify(planned));
  const signature = await sign(planned.signRequest.agreementMessage);
  const submit = () => portal(h, `/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature: signature });
  const account = h.app.services.accounts.walletOwner(wallet.getPublicAccount().address);
  const broker = (part, body, origin = h.origin, operationId = id) => fetch(`${h.origin}/portal/api/purchase/${operationId}/browser-agreement/${part}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) }).then(async (r) => ({ http: r.status, ...await r.json() }));
  return { h, chain, journal, wallet, approvals, user, seller, p, token, id, account, client, calls, probes, sign, submit, broker, planned,
    authenticate: () => client.authenticate({ address: wallet.getPublicAccount().address, sign }),
    verify: () => tool(h, user, 'verify_deal', { operationId: id }) };
}

test('linked-wallet-authenticated browser client carries one exact public CREATE result through HTTP/MCP; payment remains held', async (t) => {
  const w = await setup(t);
  const profile = await portal(w.h, '/portal/api/embedded-wallet/profile');
  assert.equal(profile.agreementBroker.kind, 'loopback-test-only');
  const noSession = await w.submit();
  assert.equal(noSession.error, 'broker_session_missing');
  assert.equal(w.h.app.services.ops.get(w.account, w.id).state.protocol.walletAnchor, undefined, 'absence must not fence a CREATE before wallet authentication');
  const scope = await w.authenticate();
  assert.equal(scope.wallet, w.wallet.getPublicAccount().address); assert.equal(scope.operation, w.id);
  const queued = await w.submit();
  assert.equal(queued.evidence.protocol.stage, 'agreement-signing'); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  const early = await w.verify(); assert.equal(early.protocol.lastAttempt.outcome, 'indeterminate');
  const done = await w.client.approveOne(w.wallet);
  assert.equal(done.state, 'completed', JSON.stringify(w.calls.filter((r) => r.error)));
  const out = await w.verify(); assert.equal(out.protocol.stage, 'agreement-anchored', JSON.stringify(out));
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1); assert.equal(w.approvals.filter(storage).length, 1);
  const retained = w.h.app.services.ops.get(w.account, w.id).state.protocol.walletAnchor;
  assert.equal(canonicalize(w.chain.wire.record.accepted[0].content.data[1].data), canonicalize(retained.artifact));
  assert.equal(Object.hasOwn(retained.artifact, 'artifactType'), false);
  assert.equal(out.protocol.limits.payment, 'held'); assert.equal(out.protocol.limits.vet, 'not-performed');
  assert.equal(out.protocol.layers.dacsPurchase, 'not-evidenced');
  await assert.rejects(w.client.approveOne(w.wallet), /completed.*no replay/);
  await w.verify(); await w.verify();
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1, 'repeatable guard: replay cannot issue another CREATE');
  for (const part of ['challenge', 'handoff']) {
    const held = await portal(w.h, `/portal/api/purchase/${w.id}/${part}`, { token: w.token, address: w.wallet.getPublicAccount().address });
    assert.equal(held.error, 'agreement_payment_held');
  }
  assert.equal(w.seller.state.requests.includes('/dacs/v1/commitments'), false);
  assert.equal(w.seller.state.requests.includes('/dacs/v1/payments'), false);
  assert.equal(w.h.app.services.coordinates.get(w.id), null);
});

test('wallet session requires exact owner, operation, handoff and same Origin; signatures are one-use', async (t) => {
  const w = await setup(t), other = await linkedUser(w.h);
  const body = { token: w.token, address: w.wallet.getPublicAccount().address };
  assert.equal((await w.broker('challenge', body, null)).error, 'broker_origin_mismatch');
  assert.equal((await w.broker('challenge', body, 'http://127.0.0.1:1')).error, 'broker_origin_mismatch');
  assert.equal((await w.broker('challenge', { ...body, address: other.wallet.address })).error, 'broker_owner_mismatch');
  assert.equal((await w.broker('challenge', { ...body, token: 'not-an-operation-handoff' })).error, 'not_found');
  const chl = await w.broker('challenge', body);
  const wrong = await w.broker('session', { token: w.token, challengeId: chl.challengeId, signature: other.wallet.signHex(chl.message) });
  assert.equal(wrong.error, 'bad_signature');
  const good = { token: w.token, challengeId: chl.challengeId, signature: await w.sign(chl.message) };
  const opened = await w.broker('session', good); assert.equal(opened.http, 200);
  assert.equal((await w.broker('session', good)).error, 'challenge_replayed');
  assert.equal((await w.broker('claim', { sessionToken: opened.sessionToken }, w.h.origin, 'pur_other')).error, 'broker_session_missing');
  const op = w.h.app.services.ops.get(w.account, w.id);
  w.h.app.services.ops.transition(w.id, op.status, op.status, { state: { protocol: { ...op.state.protocol, planned: { ...op.state.protocol.planned, plan: { ...op.state.protocol.planned.plan, agreementHash: '0'.repeat(64) } } } } });
  assert.equal((await w.broker('claim', { sessionToken: opened.sessionToken })).error, 'broker_scope_changed');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('claim consumes delivery once: wrong correlation/hash/lane and fabricated success cannot authorize a send or receipt', async (t) => {
  const w = await setup(t, { probeJournal: true }); await w.authenticate(); await w.submit();
  const authCall = w.calls.find((r) => r.path.endsWith('/session'));
  const opened = await w.broker('session', authCall.body); assert.equal(opened.error, 'challenge_replayed');
  // Intercept only the HTTP client seam to examine public scoped data, not keys.
  const apiClaim = w.calls.length;
  await w.client.approveOne(w.wallet);
  assert.deepEqual(w.probes, ['broker_correlation_mismatch', 'broker_correlation_mismatch', 'broker_lane_mismatch', 'broker_signed_scope_invalid', 'broker_signed_scope_invalid', 'broker_signed_scope_invalid', 'broker_result_invalid']);
  const get = w.calls.slice(apiClaim).find((r) => r.path.endsWith('/journal/get')).body;
  assert.equal((await w.broker('journal/get', { ...get, correlation: 'wrong' })).error, 'broker_correlation_mismatch');
  assert.equal((await w.broker('journal/get', { ...get, requestHash: '0'.repeat(64) })).error, 'broker_correlation_mismatch');
  assert.equal((await w.broker('journal/get', get)).error, 'broker_delivery_replayed');
  const complete = w.calls.find((r) => r.path?.endsWith('/complete')).body;
  assert.equal((await w.broker('complete', complete)).error, 'broker_delivery_replayed');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

test('explicit browser denial has no journal/broadcast; repeated verify only records rejection', async (t) => {
  const w = await setup(t, { allow: false }); await w.authenticate(); await w.submit();
  assert.equal((await w.client.approveOne(w.wallet)).state, 'denied');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  const out = await w.verify(); assert.equal(out.protocol.stage, 'agreement-rejected');
  assert.match(sellerValue(out.protocol.lastAttempt.reason), /user_rejected/);
  assert.equal(w.journal.snapshot().filter(([k]) => k.startsWith('sr2/wallet/')).length, 0);
});

test('unknown after applied CREATE preserves signed journal and only independent readback; never a second browser claim/broadcast', async (t) => {
  const w = await setup(t); await w.authenticate(); await w.submit(); w.chain.wire.faults.dropAfterApply = true;
  assert.equal((await w.client.approveOne(w.wallet)).state, 'uncertain');
  assert.equal(w.chain.wire.record.accepted.length, 1); assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  w.chain.faults.unavailable = true;
  assert.equal((await w.verify()).protocol.lastAttempt.outcome, 'indeterminate');
  w.chain.faults.unavailable = false; w.chain.wire.faults.dropAfterApply = false;
  assert.equal((await w.verify()).protocol.stage, 'agreement-anchored');
  await assert.rejects(w.client.approveOne(w.wallet), /uncertain.*no replay/);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

test('expired session or absent browser leaves an explicit fenced gap, no automatic retry or send', async (t) => {
  let offset = 0; const w = await setup(t, { now: () => Date.now() + offset, ttlMs: 1000 });
  await w.authenticate(); await w.submit(); offset += 1001;
  await assert.rejects(w.client.approveOne(w.wallet), { code: 'broker_session_expired' });
  const out = await w.verify(); assert.equal(out.protocol.stage, 'agreement-signing');
  assert.match(sellerValue(out.protocol.lastAttempt.reason), /absent-or-uncertain/);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('missing explicit journal or non-loopback/public profile refuses construction without any walletFactory fallback', () => {
  const config = { allowInsecureLocal: true, publicOrigin: 'http://127.0.0.1:8000', chain: { rpcUrl: 'http://127.0.0.1:8001', network: 'fixture' }, embeddedWallet: { writes: 'simulated-loopback' } };
  assert.throws(() => createOfflineAgreementBroker({ config }), { code: 'broker_journal_required' });
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  assert.throws(() => createOfflineAgreementBroker({ config: { ...config, publicOrigin: 'https://public.invalid' }, journal }), { code: 'broker_profile_held' });
  assert.throws(() => createOfflineAgreementBroker({ config: { ...config, chain: { ...config.chain, rpcUrl: 'https://public.invalid' } }, journal }), { code: 'broker_profile_held' });
  assert.throws(() => createOfflineAgreementBroker({ config: { ...config, embeddedWallet: { writes: 'testnet-held' } }, journal }), { code: 'broker_profile_held' });
});

test('public journal persistence failure stops before one broadcast, never launders approval into an accepting receipt', async (t) => {
  const w = await setup(t, { journalFault: true }); await w.authenticate(); await w.submit();
  assert.equal((await w.client.approveOne(w.wallet)).state, 'denied');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  assert.equal((await w.verify()).protocol.stage, 'agreement-rejected');
});
test('all browser broker Node fixture connections stayed loopback', () => assert.deepEqual(externalAttempts, []));
