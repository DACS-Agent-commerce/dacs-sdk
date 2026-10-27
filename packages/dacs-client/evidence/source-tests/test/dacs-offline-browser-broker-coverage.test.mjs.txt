// Coverage-gap controls for the loopback browser broker: lifecycle boundaries,
// concurrency, Origin on every route and app-level profile exclusivity. Real
// packaged SDK signatures and HTTP/MCP; chain observations are simulated and
// approvals are synthetic callbacks (trusted clicks remain the Chrome suite).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { tool, portal, tokenFrom } from './helpers/flows.mjs';
import { sellerValue } from './helpers/model-report.mjs';
import { startAgreementChain, linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';
import { createOfflineAgreementBroker } from '../src/portal/offline-agreement-broker.mjs';
import { createApp } from '../src/app.mjs';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
let counter = 0;
const storage = (r) => r.content?.kind === 'dacs-storage-anchor-create';
const createKey = (id) => `browser-agreement/create/${id}`;

// `gate(key)` may block a journal read so tests can interleave HTTP requests
// deterministically; `events` records create-record reads/writes in order.
async function setup(t, { now, ttlMs = 120000, onPut, gate, durable = false, allow = true } = {}) {
  const chain = await startAgreementChain();
  const memory = memoryAnchorJournal(), events = [];
  let backing = memory, journalPath;
  if (durable) {
    const directory = await mkdtemp(join(tmpdir(), 'dacs-unsent-broker-'));
    journalPath = join(directory, 'wallet-journal.sqlite');
    backing = openDurableWalletJournal({ path: journalPath, mode: 'create' });
    t.after(async () => { backing.close(); await rm(directory, { recursive: true, force: true }); });
  }
  const journal = {
    entries: () => durable ? backing.entries() : memory.snapshot(),
    withWalletLock: (key, work) => backing.withWalletLock(key, work),
    get: async (key) => { if (key.startsWith('browser-agreement/')) events.push(`get ${key}`); if (gate) await gate(key); return backing.get(key); },
    put: (key, value) => { if (key.startsWith('browser-agreement/')) events.push(`put ${key} ${value.stage}`); return backing.put(key, value); } };
  const h = await startProtocolHarness({ chain, now, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT: '2', DACS_MAX_UNPAID_PURCHASES_PER_WALLET: '2' }, browserAgreement: { journal, ttlMs } });
  t.after(() => h.close());
  const post = (path, body, origin = h.origin) => fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) })
    .then(async (r) => ({ http: r.status, ...await r.json() }));
  const api = async (path, body) => {
    if (onPut && path.endsWith('/journal/put')) await onPut(body, path, post);
    const out = await post(path, body);
    if (out.http !== 200) throw Object.assign(new Error(out.message), { code: out.error });
    return out;
  };
  // The one packaged wallet routes its anchor journal through whichever
  // operation's broker client is currently approving.
  let active;
  const approvals = [];
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic,
    anchorJournal: { get: (key) => active.anchorJournal.get(key), put: (key, value) => active.anchorJournal.put(key, value), withWalletLock: (key, work) => active.anchorJournal.withWalletLock(key, work) },
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (request) => { approvals.push(structuredClone(request)); return storage(request) ? allow : true; } });
  await wallet.create(); t.after(() => wallet.lock());
  const user = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async (message) => { const answer = await wallet.request({ method: 'sign', params: [message] }); assert.equal(answer.success, true); return answer.data.signature; };
  const operation = async () => {
    const seller = await addSeller(h, { listingId: `browser-broker-coverage-${++counter}` });
    const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `broker-coverage-${counter}`, protocol: 'dacs-sr2-wallet-agreement' });
    assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
    const token = tokenFrom(p.approvalUrl), id = p.operationId;
    const client = createOfflineAgreementBrokerClient({ id, token, api });
    const identity = await portal(h, `/portal/api/purchase/${id}/agreement/identity`, { token, address });
    const planned = await portal(h, `/portal/api/purchase/${id}/agreement/plan`, { token, signature: await sign(identity.signRequest.message) });
    assert.equal(planned.error, undefined, JSON.stringify(planned));
    const signature = await sign(planned.signRequest.agreementMessage);
    const broker = (part, body, origin) => post(`/portal/api/purchase/${id}/browser-agreement/${part}`, body, origin);
    // A raw wallet-authenticated session, independent of the client's own one.
    const rawSession = async () => {
      const chl = await broker('challenge', { token, address });
      const opened = await broker('session', { token, challengeId: chl.challengeId, signature: await sign(chl.message) });
      assert.equal(opened.http, 200, JSON.stringify(opened));
      return opened.sessionToken;
    };
    return { p, token, id, client, broker, rawSession,
      approveOne: () => { active = client; return client.approveOne(wallet); },
      submit: () => portal(h, `/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature: signature }),
      authenticate: () => client.authenticate({ address, sign }),
      verify: () => tool(h, user, 'verify_deal', { operationId: id }) };
  };
  const first = await operation();
  active = first.client;
  return { h, chain, journal, events, wallet, approvals, user, address, operation, ...first,
    account: h.app.services.accounts.walletOwner(address), peek: (key) => backing.get(key),
    reopenJournal: () => { assert.equal(durable, true); const id = backing.journalId; backing.close(); backing = openDurableWalletJournal({ path: journalPath, mode: 'open', expectedJournalId: id }); },
  };
}

test('claim before the CREATE is queued is absent; the client never treats absence as a request', async (t) => {
  const w = await setup(t); await w.authenticate();
  await assert.rejects(w.client.approveOne(w.wallet), /CREATE is absent; no replay/);
  assert.equal(w.peek(createKey(w.id)), undefined);
  assert.equal(w.approvals.filter(storage).length, 0); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  // Accepting control: the same client then delivers exactly once after submit.
  await w.submit();
  assert.equal((await w.client.approveOne(w.wallet)).state, 'completed');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

test('reauthentication cannot extend a queued CREATE deadline: late claim fences it expired, nothing sent', async (t) => {
  let offset = 0; const w = await setup(t, { now: () => Date.now() + offset, ttlMs: 1000 });
  await w.authenticate(); await w.submit();
  const queued = w.peek(createKey(w.id)); assert.equal(queued.stage, 'queued');
  offset += 1001;
  const scope = await w.authenticate(); assert.equal(scope.operation, w.id, 'fresh session opens for the same exact scope');
  await assert.rejects(w.client.approveOne(w.wallet), /CREATE is expired; no replay/);
  const fenced = w.peek(createKey(w.id));
  assert.equal(fenced.stage, 'expired'); assert.equal(fenced.expiresAt, queued.expiresAt, 'guard witness: deadline was not extended');
  await assert.rejects(w.client.approveOne(w.wallet), /CREATE is expired; no replay/);
  const out = await w.verify(); assert.notEqual(out.protocol.stage, 'agreement-anchored');
  assert.equal(w.peek(createKey(w.id)).stage, 'expired', 'readback never re-queues an expired CREATE');
  assert.equal(w.approvals.filter(storage).length, 0); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('concurrent claims (same and second session) deliver the queued CREATE exactly once', async (t) => {
  const w = await setup(t); const first = await w.rawSession(); await w.submit();
  const second = await w.rawSession();
  const claims = await Promise.all([w.broker('claim', { sessionToken: first }, w.h.origin), w.broker('claim', { sessionToken: first }, w.h.origin), w.broker('claim', { sessionToken: second }, w.h.origin)]);
  assert.deepEqual(claims.map((c) => c.http), [200, 200, 200]);
  const delivered = claims.filter((c) => c.request);
  assert.equal(delivered.length, 1, JSON.stringify(claims.map((c) => c.state)));
  assert.ok(claims.every((c) => c.state === 'issued-to-browser' && c.payment === 'held'));
  assert.equal(w.peek(createKey(w.id)).stage, 'issued-to-browser');
  assert.equal((await w.broker('claim', { sessionToken: second }, w.h.origin)).request, null);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('every broker route refuses missing or foreign Origin before consuming anything', async (t) => {
  const w = await setup(t); await w.authenticate(); await w.submit();
  const raw = await w.rawSession();
  const bodies = { session: { token: w.token }, claim: { sessionToken: raw }, 'journal/get': { sessionToken: raw }, 'journal/put': { sessionToken: raw }, complete: { sessionToken: raw, answer: { success: false, error: { code: 'x' } } } };
  for (const [part, body] of Object.entries(bodies)) {
    for (const origin of [null, 'http://127.0.0.1:1', 'https://public.invalid']) {
      const out = await w.broker(part, body, origin);
      assert.equal(out.http, 409, `${part} ${origin}`); assert.equal(out.error, 'broker_origin_mismatch', `${part} ${origin}`);
    }
  }
  assert.equal(w.peek(createKey(w.id)).stage, 'queued', 'guard witness: refused claims did not consume delivery');
  assert.equal((await w.client.approveOne(w.wallet)).state, 'completed');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

test('an accepted lane record cannot precede its exact signed intent', async (t) => {
  const seen = [];
  const w = await setup(t, { onPut: async (body, path, post) => {
    if (body.record.stage !== 'broadcast-started' || seen.length) return;
    const out = await post(path, { ...body, record: { ...body.record, stage: 'broadcast-accepted' } });
    seen.push(out.error);
  } });
  await w.authenticate(); await w.submit();
  assert.equal((await w.client.approveOne(w.wallet)).state, 'completed');
  assert.deepEqual(seen, ['broker_journal_order']);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal((await w.verify()).protocol.stage, 'agreement-anchored');
});

test('session expiry bounds and literal-loopback profile are exact', () => {
  const config = { allowInsecureLocal: true, publicOrigin: 'http://127.0.0.1:8000', chain: { rpcUrl: 'http://127.0.0.1:8001', network: 'fixture' }, embeddedWallet: { writes: 'simulated-loopback' } };
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  for (const ttlMs of [999, 300001, 1500.5, '120000']) assert.throws(() => createOfflineAgreementBroker({ config, journal, ttlMs }), { code: 'broker_expiry_invalid' }, String(ttlMs));
  for (const ttlMs of [1000, 300000]) assert.equal(createOfflineAgreementBroker({ config, journal, ttlMs }).profile.kind, 'loopback-test-only');
  assert.equal(createOfflineAgreementBroker({ config: { ...config, publicOrigin: 'http://[::1]:8000' }, journal }).profile.payment, 'held');
  for (const publicOrigin of ['http://localhost:8000', 'https://127.0.0.1:8000', 'http://user:pw@127.0.0.1:8000']) {
    assert.throws(() => createOfflineAgreementBroker({ config: { ...config, publicOrigin }, journal }), { code: 'broker_profile_held' }, publicOrigin);
  }
  assert.throws(() => createOfflineAgreementBroker({ config: { ...config, allowInsecureLocal: false }, journal }), { code: 'broker_profile_held' });
});

test('app refuses broker combined with the legacy injected wallet profile or extra broker options', async (t) => {
  const chain = await startAgreementChain();
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  const h = await startProtocolHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' }, browserAgreement: { journal } });
  t.after(() => h.close());
  assert.equal((await portal(h, '/portal/api/embedded-wallet/profile')).agreementBroker.kind, 'loopback-test-only');
  const config = { ...h.config, databasePath: ':memory:' };
  await assert.rejects(createApp({ config, dacsProtocol: { browserAgreement: { journal, walletFactory: () => null } } }), /accepts only an explicit public journal/);
  await assert.rejects(createApp({ config, dacsProtocol: { browserAgreement: { journal }, walletAgreement: { rpcUrl: config.chain.rpcUrl, network: config.chain.network, journal, walletFactory: () => null } } }), /choose either the loopback browser broker or the injected fixture wallet/);
});

const outcome = (p) => p.then((v) => ({ ok: v }), (e) => ({ error: e.code ?? e.message }));

// Repaired oracle: only the provably unsent second operation can start afresh
// after the first operation's authenticated readback frees the nonce lane.
test('two pending operations on one wallet: unsent second stays fenced until first readback, then each anchors exactly once', async (t) => {
  const w = await setup(t), b = await w.operation();
  await w.authenticate(); await b.authenticate(); await w.submit();
  const queuedB = (await b.submit()).evidence.protocol;
  assert.equal(queuedB.stage, 'agreement-signing');
  assert.match(queuedB.lastAttempt.reason, /wallet-fenced: another unresolved wallet handoff owns the nonce lane/);
  assert.equal(w.peek(createKey(b.id)), undefined, 'guard witness: no second CREATE queued on an occupied lane');
  const account = w.h.app.services.accounts.walletOwner(w.address);
  assert.equal(w.h.app.services.ops.get(account, b.id).state.protocol.walletAnchor, null, 'pre-issue fence must not retain send/restore authority for B');
  assert.equal(w.journal.entries().filter(([k, v]) => k.startsWith('sr2/adapter/') && v.logicalAddress === `dacs3:agreement:${b.p.protocol.jobId}`).length, 0, 'B was fenced before a plan/handoff existed');
  assert.equal(w.peek(createKey(w.id)).stage, 'queued');
  const stillFenced = (await b.verify()).protocol;
  assert.match(sellerValue(stillFenced.lastAttempt.reason), /wallet-fenced/);
  assert.equal(w.h.app.services.ops.get(account, b.id).state.protocol.walletAnchor, null);
  assert.equal(w.peek(createKey(b.id)), undefined);
  // Accepting control: the first operation anchors exactly once.
  assert.equal((await w.approveOne()).state, 'completed');
  assert.equal((await w.verify()).protocol.stage, 'agreement-anchored');
  const resubmit = (await b.submit()).evidence.protocol;
  t.diagnostic(JSON.stringify({ walletAnchorRetainedForB: Boolean(w.h.app.services.ops.get(w.h.app.services.accounts.walletOwner(w.address), b.id).state.protocol.walletAnchor), resubmit: resubmit.lastAttempt }));
  assert.equal(resubmit.stage, 'agreement-signing'); assert.match(resubmit.lastAttempt.reason, /outcome_unknown/);
  assert.equal(w.peek(createKey(b.id)).stage, 'queued', 'B now has exactly one fresh queue, not a resend of any issued B CREATE');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1); assert.equal(w.approvals.filter(storage).length, 1);
  assert.equal((await b.approveOne()).state, 'completed');
  const anchoredB = (await b.verify()).protocol;
  assert.equal(anchoredB.stage, 'agreement-anchored'); assert.equal(anchoredB.limits.payment, 'held');
  assert.deepEqual(w.chain.wire.record.accepted.map((tx) => Number(tx.content.nonce)), [1, 2]);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 2); assert.equal(w.approvals.filter(storage).length, 2);
  await assert.rejects(b.approveOne(), /completed.*no replay/);
  await w.verify(); await b.verify();
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 2);
});

test('second operation submitted while the first lane awaits readback is fenced; no second approval or broadcast', async (t) => {
  const w = await setup(t), b = await w.operation();
  await w.authenticate(); await b.authenticate(); await w.submit();
  assert.equal((await w.approveOne()).state, 'completed');
  const lane = w.journal.entries().filter(([k]) => k.startsWith('sr2/wallet/')).map(([, v]) => v.stage);
  assert.deepEqual(lane, ['sr2-readback-pending']);
  const queuedB = (await b.submit()).evidence.protocol;
  t.diagnostic(JSON.stringify({ queuedB: queuedB.lastAttempt, recordB: w.peek(createKey(b.id))?.stage ?? null }));
  assert.equal(queuedB.stage, 'agreement-signing');
  assert.match(queuedB.lastAttempt.reason, /wallet-fenced/);
  assert.equal(w.h.app.services.ops.get(w.h.app.services.accounts.walletOwner(w.address), b.id).state.protocol.walletAnchor, null);
  const second = await outcome(b.approveOne());
  t.diagnostic(JSON.stringify({ second: second.ok?.state ?? second, recordB: w.peek(createKey(b.id))?.stage ?? null }));
  assert.equal(w.approvals.filter(storage).length, 1); assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal((await w.verify()).protocol.stage, 'agreement-anchored');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal((await b.verify()).protocol.stage, 'agreement-signing', 'MCP recheck can queue only the provably unsent B after A readback');
  assert.equal(w.peek(createKey(b.id)).stage, 'queued');
  assert.equal((await b.approveOne()).state, 'completed');
  assert.equal((await b.verify()).protocol.stage, 'agreement-anchored');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 2); assert.equal(w.approvals.filter(storage).length, 2);
});

test('durable journal with actual broker/MCP: unsent B persists as unsent, then queues and anchors once after A readback', async (t) => {
  const w = await setup(t, { durable: true }), b = await w.operation();
  await w.authenticate(); await b.authenticate(); await w.submit();
  assert.match((await b.submit()).evidence.protocol.lastAttempt.reason, /wallet-fenced/);
  assert.equal(w.h.app.services.ops.get(w.account, b.id).state.protocol.walletAnchor, null);
  assert.equal(await w.peek(createKey(b.id)), undefined);
  w.reopenJournal();
  assert.equal((await w.peek(createKey(w.id))).stage, 'queued');
  assert.equal(await w.peek(createKey(b.id)), undefined);
  assert.equal((await w.approveOne()).state, 'completed');
  assert.match(sellerValue((await b.verify()).protocol.lastAttempt.reason), /wallet-fenced/, 'accepted send alone does not release A lane');
  assert.equal((await w.verify()).protocol.stage, 'agreement-anchored');
  const queuedB = (await b.verify()).protocol;
  assert.equal(queuedB.stage, 'agreement-signing');
  assert.equal((await w.peek(createKey(b.id))).stage, 'queued');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal((await b.approveOne()).state, 'completed');
  assert.equal((await b.verify()).protocol.stage, 'agreement-anchored');
  w.reopenJournal();
  assert.equal((await w.peek(createKey(b.id))).stage, 'completed');
  const lane = (await w.journal.entries()).find(([k]) => k.startsWith('sr2/wallet/'))[1];
  assert.equal(lane.stage, 'broadcast-accepted'); assert.equal(Number(lane.nonce), 2);
  await w.verify(); await b.verify();
  await assert.rejects(b.approveOne(), /completed.*no replay/);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 2); assert.equal(w.approvals.filter(storage).length, 2);
});

// Reconstruct the actual app and SQLite-backed operation services with no old
// broker sessions, then reopen the public journal. This models restart state;
// it is not a process-kill or power-loss assurance claim.
async function restartedConsumer(t, w) {
  const originalClose = w.h.app.close;
  let closed = false;
  w.h.app.close = async () => { if (!closed) { closed = true; await originalClose(); } };
  await w.h.app.close();
  w.reopenJournal();
  const app = await createApp({ config: w.h.config, dacsProtocol: { anchorUrl: w.h.anchors.url,
    sellerEndpoint: (claim) => w.h.endpoints.get(claim) ?? null, browserAgreement: { journal: w.journal } } });
  t.after(() => app.close());
  return { app, operation: () => app.services.ops.get(w.account, w.id), verify: () => app.services.protocol.recheck(app.services.ops.get(w.account, w.id)) };
}

for (const stage of ['queued', 'issued-to-browser']) test(`restart preserves ${stage} intent and never requeues or redelivers it`, async (t) => {
  const w = await setup(t, { durable: true }); await w.authenticate(); await w.submit();
  if (stage === 'issued-to-browser') {
    const sessionToken = await w.rawSession();
    const claimed = await w.broker('claim', { sessionToken }, w.h.origin);
    assert.equal(claimed.state, stage); assert.ok(claimed.request);
  }
  const before = w.h.app.services.ops.get(w.account, w.id).state.protocol.walletAnchor;
  const restarted = await restartedConsumer(t, w);
  assert.equal(restarted.operation().state.protocol.walletAnchor.receiptContentHash, before.receiptContentHash);
  for (let n = 0; n < 2; n++) {
    const op = await restarted.verify();
    assert.equal(op.state.protocol.stage, 'agreement-signing');
    assert.ok(op.state.protocol.walletAnchor, 'issued or uncertain intent is never cleared by the unsent repair');
    assert.equal((await w.peek(createKey(w.id))).stage, stage);
  }
  assert.equal(w.approvals.filter(storage).length, 0); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('restart preserves an unknown applied CREATE and exact native readback; no fresh queue or second approval/send', async (t) => {
  const w = await setup(t, { durable: true }); await w.authenticate(); await w.submit();
  w.chain.wire.faults.dropAfterApply = true;
  assert.equal((await w.approveOne()).state, 'uncertain');
  assert.equal(w.chain.wire.record.accepted.length, 1);
  const restarted = await restartedConsumer(t, w);
  w.chain.faults.unavailable = true;
  assert.equal((await restarted.verify()).state.protocol.attempts.at(-1).outcome, 'indeterminate');
  assert.ok(restarted.operation().state.protocol.walletAnchor);
  assert.equal((await w.peek(createKey(w.id))).stage, 'uncertain');
  w.chain.faults.unavailable = false;
  assert.equal((await restarted.verify()).state.protocol.stage, 'agreement-anchored');
  assert.equal((await restarted.verify()).state.protocol.stage, 'agreement-anchored');
  assert.equal((await w.peek(createKey(w.id))).stage, 'uncertain', 'native readback is not CREATE delivery authority');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1); assert.equal(w.approvals.filter(storage).length, 1);
});

test('restart preserves explicit wallet rejection; no fresh intent or CREATE delivery', async (t) => {
  const w = await setup(t, { durable: true, allow: false }); await w.authenticate(); await w.submit();
  assert.equal((await w.approveOne()).state, 'denied');
  assert.equal((await w.verify()).protocol.stage, 'agreement-rejected');
  const restarted = await restartedConsumer(t, w);
  assert.equal((await restarted.verify()).state.protocol.stage, 'agreement-rejected');
  assert.ok(restarted.operation().state.protocol.walletAnchor, 'rejection retains the attempted scope');
  assert.equal((await w.peek(createKey(w.id))).stage, 'denied');
  await assert.rejects(restarted.app.services.protocol.submitAgreement(restarted.operation()), { code: 'invalid_state' });
  assert.equal(w.approvals.filter(storage).length, 1); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('operation expiry while a CREATE is queued blocks delivery and re-authentication', async (t) => {
  let offset = 0; const w = await setup(t, { now: () => Date.now() + offset, ttlMs: 300000 });
  const expiresAt = Date.parse(w.h.app.services.ops.get(w.h.app.services.accounts.walletOwner(w.address), w.id).expiresAt);
  offset = expiresAt - Date.now() - 20000;
  await w.authenticate(); assert.equal((await w.submit()).evidence.protocol.stage, 'agreement-signing');
  assert.equal(w.peek(createKey(w.id)).stage, 'queued');
  offset = expiresAt - Date.now() + 1000;
  const late = await outcome(w.approveOne());
  const reauth = await outcome(w.authenticate());
  const out = await outcome(w.verify());
  assert.deepEqual({ late, reauth }, { late: { error: 'broker_operation_expired' }, reauth: { error: 'broker_operation_expired' } });
  assert.equal(w.peek(createKey(w.id)).stage, 'queued', 'expired operation never consumes the delivery');
  assert.equal(out.ok.protocol.stage, 'agreement-signing');
  assert.equal(w.approvals.filter(storage).length, 0); assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('Agreement scope change after queueing: old session and fresh session both refuse the retained CREATE', async (t) => {
  const w = await setup(t); await w.authenticate(); await w.submit();
  const account = w.h.app.services.accounts.walletOwner(w.address), op = w.h.app.services.ops.get(account, w.id);
  w.h.app.services.ops.transition(w.id, op.status, op.status, { state: { protocol: { ...op.state.protocol, planned: { ...op.state.protocol.planned, plan: { ...op.state.protocol.planned.plan, agreementHash: 'f'.repeat(64) } } } } });
  const stale = await outcome(w.approveOne());
  const fresh = await outcome(w.authenticate());
  const retained = fresh.ok ? await outcome(w.approveOne()) : null;
  assert.deepEqual(stale, { error: 'broker_scope_changed' }, 'old session binding differs from current scope');
  assert.equal(fresh.ok['agreement-hash'], 'f'.repeat(64), 'fresh session binds the changed scope');
  assert.deepEqual(retained, { error: 'broker_scope_changed' }, 'retained CREATE binding differs from the fresh session');
  assert.equal(w.peek(createKey(w.id)).stage, 'queued');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0); assert.equal(w.approvals.filter(storage).length, 0);
});

test('blocked create-record read: a concurrent claim waits on the lock and cannot double-deliver', async (t) => {
  let release, blocked = false; const hold = new Promise((r) => { release = r; });
  const w = await setup(t, { gate: async (key) => { if (blocked && key.startsWith('browser-agreement/create/')) { blocked = false; await hold; } } });
  const s1 = await w.rawSession(); await w.submit(); const s2 = await w.rawSession();
  const mark = w.events.length; blocked = true;
  const one = w.broker('claim', { sessionToken: s1 }, w.h.origin);
  while (blocked) await new Promise((r) => setTimeout(r, 5));
  const two = w.broker('claim', { sessionToken: s2 }, w.h.origin);
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(w.events.slice(mark), [`get ${createKey(w.id)}`], 'guard witness: second claim never read while the first held the lock');
  release();
  const [a, c] = await Promise.all([one, two]);
  assert.equal(a.state, 'issued-to-browser'); assert.ok(a.request);
  assert.equal(c.state, 'issued-to-browser'); assert.equal(c.request, null);
  assert.deepEqual(w.events.slice(mark), [`get ${createKey(w.id)}`, `put ${createKey(w.id)} issued-to-browser`, `get ${createKey(w.id)}`, `get ${createKey(w.id)}`]);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('all broker coverage fixture connections stayed loopback', () => assert.deepEqual(externalAttempts, []));
