// The enabled purchase entry after a reload, against the real loopback broker
// routes and the real public broker client. Wallet approvals are synthetic
// callbacks on the packaged SDK session; every request stays on loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { tool, portal, tokenFrom } from './helpers/flows.mjs';
import { startAgreementChain, linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { portalHarness, tabStorage } from './helpers/portal-auto-harness.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
const storage = (r) => r.content?.kind === 'dacs-storage-anchor-create';
let counter = 0;

// Records every Agreement signature and opens a broker session on a first
// page, which is then lost before the CREATE. `reload()` opens the purchase
// again in the same tab with a new broker client that has no session.
async function signedThenLost(t) {
  const chain = await startAgreementChain(), memory = memoryAnchorJournal();
  const h = await startProtocolHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_PORTAL_AUTO_ADVANCE: 'on' }, browserAgreement: { journal: { ...memory, entries: () => memory.snapshot() }, ttlMs: 120000 } })
    .catch(async (error) => { await chain.close(); throw error; });
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
    anchorJournal: { get: (key) => client.anchorJournal.get(key), put: (key, value) => client.anchorJournal.put(key, value), withWalletLock: (key, work) => client.anchorJournal.withWalletLock(key, work) },
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (request) => { approvals.push(structuredClone(request)); return true; } });
  await wallet.create(); t.after(() => wallet.lock());
  const user = await linkPackagedWallet(h, wallet);
  const seller = await addSeller(h, { listingId: `auto-create-reload-${++counter}` });
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `auto-create-reload-${counter}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const token = tokenFrom(p.approvalUrl), id = p.operationId, address = wallet.getPublicAccount().address;
  const sign = async (message) => { const answer = await wallet.request({ method: 'sign', params: [message] }); assert.equal(answer.success, true); return answer.data.signature; };

  client = createOfflineAgreementBrokerClient({ id, token, api });
  const identity = await portal(h, `/portal/api/purchase/${id}/agreement/identity`, { token, address });
  const planned = await portal(h, `/portal/api/purchase/${id}/agreement/plan`, { token, signature: await sign(identity.signRequest.message) });
  const agreementSignature = await sign(planned.signRequest.agreementMessage);
  await client.authenticate({ address, sign });
  const signed = await portal(h, `/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature });
  assert.equal(signed.evidence.protocol.stage, 'agreement-signing', JSON.stringify(signed));

  const tab = tabStorage(), requests = [], wallets = { rejectNextSign: false };
  const pageWallet = { isDacsEmbeddedWallet: true,
    writeProfile: () => ({ profile: 'simulated-loopback', network: h.config.chain.network, evidenceMode: 'simulated-fixture', methods: ['sendTransaction'] }),
    request: async (req) => {
      requests.push(structuredClone(req));
      if (req.method === 'sign' && wallets.rejectNextSign) { wallets.rejectNextSign = false; return { success: false, error: { code: 'rejected', message: 'TEST buyer rejected the session signature' } }; }
      return wallet.request(req);
    } };
  async function reload() {
    client = createOfflineAgreementBrokerClient({ id, token, api });
    const page = portalHarness(null, null, { storage: tab, token, transport: (path, options) => fetch(`${h.origin}${path}`, { ...options, headers: { ...options.headers, origin: h.origin } }) });
    page.context.realBroker = client; page.context.realWallet = pageWallet;
    vm.runInContext(`offlineAgreementBroker=realBroker;provider=realWallet;address=${JSON.stringify(address)};`, page.context);
    t.after(() => page.destroy());
    await page.start(id);
    const flowText = () => page.document.getElementById('flow').text;
    const createButton = () => page.document.getElementById('flow').querySelectorAll('button[data-action]').find((b) => /Approve Agreement CREATE/.test(b.text));
    return { page, flowText, createButton, logText: () => page.document.getElementById('log').text };
  }
  const stage = async () => {
    let out;
    for (let i = 0; i < 20; i++) { out = await tool(h, user, 'verify_deal', { operationId: id }); if (out.protocol?.stage !== 'agreement-signing') break; }
    return out.protocol.stage;
  };
  return { chain, id, tab, requests, wallets, approvals, reload, stage, recorded: [identity.signRequest.message, planned.signRequest.agreementMessage] };
}

test('after a reload the standalone Agreement CREATE opens a new broker session, asks the wallet once and anchors the Agreement', async (t) => {
  const w = await signedThenLost(t);
  const first = await w.reload();
  assert.doesNotMatch(first.flowText(), /Sign the DACS Agreement/);
  assert.ok(first.createButton(), first.flowText());
  await first.createButton().fire('click');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1, first.logText());
  assert.equal(w.approvals.filter(storage).length, 1);
  assert.deepEqual(w.requests.map((r) => r.method === 'sign' ? 'sign' : 'create'), ['sign', 'create'], 'one session challenge, then the CREATE');
  assert.ok(w.requests.every((r) => !w.recorded.includes(r.params?.[0])), 'no recorded Agreement signature is requested again');
  assert.equal(w.tab.getItem(`dacs:auto:${w.id}:create`), 'asked');
  assert.equal(first.createButton(), undefined);
  assert.equal(await w.stage(), 'agreement-anchored');

  // A further reload of the same tab never offers the CREATE or a signature again.
  const again = await w.reload();
  assert.doesNotMatch(again.flowText(), /Approve Agreement CREATE|Sign the DACS Agreement/);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1); assert.equal(w.approvals.filter(storage).length, 1); assert.equal(w.requests.length, 2);
  assert.deepEqual(externalAttempts, []);
});

test('after a reload a rejected broker session signature claims no CREATE; the buyer can approve again', async (t) => {
  const w = await signedThenLost(t);
  const page = await w.reload();
  w.wallets.rejectNextSign = true;
  await page.createButton().fire('click');
  assert.match(page.logText(), /TEST buyer rejected the session signature/);
  assert.deepEqual(w.requests.map((r) => r.method), ['sign']);
  assert.equal(w.tab.getItem(`dacs:auto:${w.id}:create`), null, 'the CREATE is claimed only after the session is open');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  assert.ok(page.createButton(), page.flowText());
  await page.createButton().fire('click');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1, page.logText());
  assert.equal(w.approvals.filter(storage).length, 1);
  assert.equal(await w.stage(), 'agreement-anchored');
  assert.deepEqual(externalAttempts, []);
});
