// DACS_INTENT_APPROVAL with main's other purchase switches.
// - DACS_PORTAL_AUTO_ADVANCE: refused together. Auto-advance serves purchase
//   pages its own rewrite of portal.js, built from the file without the Start
//   hooks, with its own per-tab wallet-request journal and a standalone
//   Agreement CREATE action; none of it is held to a Start.
// - DACS_READBACK_CACHE: composes. The cache holds only a purchase's verified,
//   included Agreement readback for the payment gates. The Start records, the
//   wallet's fence and the issuance check never read through it, and every
//   intent route reads the purchase from its durable record.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { createApp } from '../src/app.mjs';
import { createPortalRouter } from '../src/portal/routes.mjs';
import { startDevnetAgreementTransportHarness } from './helpers/devnet-agreement-transport-harness.mjs';
import { startDevnetAgreementTransportSeller } from './helpers/devnet-agreement-transport-seller.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { contractView } from './helpers/env-contract-view.mjs';
import { gatedWallet, signedMessages, CountingDemos } from './helpers/start-intent.mjs';
import { runStart } from '../public/portal-intent/start-flow.mjs';
import { START_ANNOUNCEMENT } from '../public/portal-intent/gate.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';

const base = { DACS_PUBLIC_ORIGIN: 'http://127.0.0.1:8787', DACS_ALLOW_INSECURE_LOCALHOST: '1', DACS_OAUTH_COOKIE_KEYS: 'k'.repeat(64) };
const PAIR = /^DACS_INTENT_APPROVAL=on and DACS_PORTAL_AUTO_ADVANCE=on cannot be enabled together; turn one of them off$/;

test('loadConfig refuses DACS_INTENT_APPROVAL=on with DACS_PORTAL_AUTO_ADVANCE=on, naming both; every other pair, and the readback cache, loads', () => {
  assert.throws(() => loadConfig({ ...base, DACS_INTENT_APPROVAL: 'on', DACS_PORTAL_AUTO_ADVANCE: 'on' }), (e) => e instanceof ConfigError && PAIR.test(e.message));
  for (const intent of [undefined, 'off', 'on']) for (const auto of [undefined, 'off', 'on']) {
    if (intent === 'on' && auto === 'on') continue;
    const c = loadConfig({ ...base, ...(intent ? { DACS_INTENT_APPROVAL: intent } : {}), ...(auto ? { DACS_PORTAL_AUTO_ADVANCE: auto } : {}) });
    assert.deepEqual([c.intentApproval, c.portalAutoAdvance], [intent ?? 'off', auto ?? 'off']);
  }
  const all = loadConfig({ ...base, DACS_INTENT_APPROVAL: 'on', DACS_READBACK_CACHE: '1', DACS_SHOWCASE_LEDGER: '1', DACS_SHOWCASE_PUBLICATION_VIEW: '1' });
  assert.deepEqual([all.intentApproval, all.readbackCache, all.showcaseLedger, all.showcasePublicationView, all.portalAutoAdvance], ['on', true, true, true, 'off']);
});

test('a programmatic config with both on is refused by createApp before it opens anything, and by the portal router', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'intent-pair-'));
  try {
    const config = { ...loadConfig({ ...base, DACS_DATA_DIR: dir, DACS_INTENT_APPROVAL: 'on' }), portalAutoAdvance: 'on' };
    await assert.rejects(createApp({ config }), (e) => e instanceof TypeError && PAIR.test(e.message));
    assert.deepEqual(readdirSync(dir), [], 'no database or other state was created');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const deps = { db: { prepare: () => ({ get() {}, run() {} }) }, purchases: {}, accounts: {}, logger: { error() {}, info() {}, debug() {} }, timeline: { record() {} } };
  assert.throws(() => createPortalRouter({ config: { intentApproval: 'on', portalAutoAdvance: 'on' }, ...deps }), (e) => e instanceof TypeError && PAIR.test(e.message));
  for (const config of [{ intentApproval: 'on', portalAutoAdvance: 'off' }, { intentApproval: 'off', portalAutoAdvance: 'on' }]) {
    assert.doesNotThrow(() => express().use(createPortalRouter({ config, ...deps })), JSON.stringify(config));
  }
});

test('the refusal is documented next to both switches', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const flat = (path) => read(path).replace(/\s+/g, ' ');
  assert.match(flat('../docs/START-INTENT.md'), /`DACS_INTENT_APPROVAL=on` is refused together with `DACS_PORTAL_AUTO_ADVANCE=on`/);
  assert.match(flat('../docs/portal-auto-advance.md'), /It is refused together with `DACS_INTENT_APPROVAL=on`/);
  const env = read('../deploy/dacs-chatgpt.env.example');
  assert.match(env, /^# Not together with DACS_PORTAL_AUTO_ADVANCE=on: the server refuses the pair\.\nDACS_INTENT_APPROVAL=off$/m);
  // Auto-advance is a switch file (docs/SWITCHES.md): its operator note stands for the env example lines.
  assert.match(JSON.parse(read('../src/switches/DACS_PORTAL_AUTO_ADVANCE.switch')).operatorNote, /Not together with DACS_INTENT_APPROVAL=on: the server refuses the pair\./);
  const { variables } = contractView();
  assert.match(variables.DACS_PORTAL_AUTO_ADVANCE.note, /together with DACS_INTENT_APPROVAL=on/);
  assert.match(variables.DACS_INTENT_APPROVAL.note, /together with DACS_PORTAL_AUTO_ADVANCE=on/);
});

// The devnet Start world of start-intent-devnet, with the purchase readback cache on.
let counter = 0;
async function world(t, { DemosCtor } = {}) {
  const h = await startDevnetAgreementTransportHarness({ env: { DACS_INTENT_APPROVAL: 'on' }, nativeFees: { networkFee: 1, rpcFee: 1 }, readbackCache: '1' });
  t.after(() => h.close());
  assert.equal(h.config.readbackCache, true);
  assert.equal(h.config.intentApproval, 'on');
  globalThis.location = new URL(h.origin);
  let client;
  const puts = [];
  const w = await gatedWallet({ transactionTransport: createDevnetAgreementWalletTransport(await h.profile()), DemosCtor,
    anchorJournal: { get: (k) => client.anchorJournal.get(k), put: (k, v) => { puts.push(v?.stage); return client.anchorJournal.put(k, v); }, withWalletLock: (k, work) => client.anchorJournal.withWalletLock(k, work) } });
  t.after(() => w.session.lock());
  const buyer = await linkPackagedWallet(h, w.session);
  const seller = await startDevnetAgreementTransportSeller(h, { listingId: `intent-cache-${++counter}`, durable: true });
  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `intent-cache-${counter}-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
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
  const start = (options = {}) => runStart({ id, token, address: w.address, gate: w.gate, api, origin: h.origin, broker: client, provider: w.session, recheck, ...options });
  return { h, w, id, token, api, recheck, start, puts };
}

test('devnet, DACS_READBACK_CACHE=1: a Start runs to issuance; approval reuses cached inclusion and rechecks current Agreement state; a later Start is refused from the durable stage with nothing asked', async (t) => {
  const x = await world(t);
  const dialogs = x.w.dialogs.length;
  const next = await x.start();
  assert.equal(next.status, 'awaiting_approval', JSON.stringify(next.evidence?.protocol?.lastAttempt));
  assert.deepEqual(x.w.dialogs.slice(dialogs).map((d) => d.method), ['approvePurchaseIntent'], 'exactly one wallet dialog');
  assert.deepEqual(x.h.chain.wire.record.accepted.map((r) => r.content.nonce), [1], 'the Agreement CREATE was written once, at the planned nonce');
  assert.equal(x.w.gate.active, false);
  // The first challenge populates the verified inclusion cache. The second
  // uses the consumer's short-TTL map. Approval must use the inclusion cache
  // and still read current program state before issuing the payment handoff.
  const sign = async (message) => { const r = await x.w.session.request({ method: 'sign', params: [message] }); assert.equal(r.success, true); return r.data.signature; };
  await x.api(`/portal/api/purchase/${x.id}/challenge`, { token: x.token, address: x.w.address });
  const challenge = await x.api(`/portal/api/purchase/${x.id}/challenge`, { token: x.token, address: x.w.address });
  const signature = await sign(challenge.message);
  const beforeApproval = x.h.requests.length;
  const handoff = await x.api(`/portal/api/purchase/${x.id}/approve`, { token: x.token, challengeId: challenge.challengeId, signature });
  assert.equal(handoff.status, 'payment_handoff', JSON.stringify(handoff));
  const approvalReads = x.h.requests.slice(beforeApproval);
  assert.equal(approvalReads.filter((r) => r.message === 'getTxByHash').length, 0, 'approval uses the verified inclusion cache');
  assert.ok(approvalReads.some((r) => r.message === 'searchStoragePrograms'), 'a hit still reads current Agreement state');
  // A new Start for this purchase sees the stage as recorded, not as cached.
  const asked = x.w.dialogs.length, signed = signedMessages.length;
  await assert.rejects(x.api(`/portal/api/purchase/${x.id}/intent/start`, { token: x.token, address: x.w.address }), (e) => e.code === 'invalid_state' && /payment_handoff/.test(e.message));
  await assert.rejects(x.start(), (e) => e.code === 'invalid_state' && /payment_handoff/.test(e.message));
  assert.equal(x.w.dialogs.length, asked, 'no wallet dialog');
  assert.equal(signedMessages.length, signed, 'nothing signed');
  assert.equal(x.h.chain.wire.record.accepted.length, 1, 'nothing written again');
});

test('devnet, DACS_READBACK_CACHE=1: the cache is inert before issuance: a peer Start while the SDK signs the approved CREATE still stops it before issue; nothing is written and the purchase closes as superseded', async (t) => {
  let signStarted; let releaseSign;
  const signing = new Promise((resolve) => { signStarted = resolve; });
  const released = new Promise((resolve) => { releaseSign = resolve; });
  t.after(() => releaseSign());
  class PausedDemos extends CountingDemos {
    async sign(transaction, options) {
      if (transaction?.content?.type === 'storageProgram') { signStarted(); await released; }
      return super.sign(transaction, options);
    }
  }
  const x = await world(t, { DemosCtor: PausedDemos });
  const outcome = x.start({ recheck: undefined }).then(() => 'completed', (error) => error);
  const first = await Promise.race([signing.then(() => 'signing'), outcome]);
  assert.equal(first, 'signing', `the CREATE never reached the SDK signature: ${first?.message ?? first}`);
  x.w.gate.peerStarted({ type: START_ANNOUNCEMENT, wallet: x.w.address });
  releaseSign();
  const error = await outcome;
  assert.ok(error.code === 'intent_mismatch' && error.field === 'superseded' && /^Nothing was sent:/.test(error.message), String(error?.message ?? error));
  assert.deepEqual(x.puts, [], 'the CREATE was never recorded as issued');
  assert.equal(x.h.chain.wire.record.accepted.length, 0, 'nothing written');
  const after = await x.recheck();
  assert.equal(after.status, 'agreement_rejected');
  assert.equal(after.evidence?.protocol?.lastAttempt?.reason, 'agreement-anchor: superseded');
  await assert.rejects(x.api(`/portal/api/purchase/${x.id}/intent/start`, { token: x.token, address: x.w.address }), (e) => e.code === 'invalid_state' && /agreement_rejected/.test(e.message));
});
