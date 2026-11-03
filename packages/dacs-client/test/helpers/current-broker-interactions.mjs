// Role-owned setup for test/dacs-current-broker-interactions.test.mjs. Actual
// opt-in harness browserAgreement broker over a caller-owned SQLite durable
// journal that can be closed and reopened between steps; actual OAuth/MCP and
// portal routes; one packaged SDK wallet (real signatures) whose approval
// callback is synthetic consent. Every chain/seller observation is simulated.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProtocolHarness, addSeller } from '../dacs-loopback-fixture.test.mjs';
import { tool, portal, tokenFrom } from './flows.mjs';
import { startAgreementChain, linkPackagedWallet } from './offline-agreement-fixture.mjs';
import { createSdkWalletSession } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../../public/portal/offline-agreement-broker.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { createApp } from '../../src/app.mjs';

export const storage = (r) => r.content?.kind === 'dacs-storage-anchor-create';
export const createKey = (id) => `browser-agreement/create/${id}`;
let counter = 0;

// The harness keeps one journal object; reopening swaps the SQLite handle
// underneath it so every later consumer call reads the reopened file.
// `lossyReopen` is the test-effectiveness witness only: after reopening it
// hides every record written before, like a journal silently recreated empty.
export async function reopenableJournal(t, { lossyReopen = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dacs-current-broker-'));
  const path = join(directory, 'wallet-journal.sqlite');
  let backing = openDurableWalletJournal({ path, mode: 'create' });
  const journalId = backing.journalId;
  let reopens = 0;
  const forgotten = new Set();
  t.after(async () => { try { backing.close(); } catch { /* already closed */ } await rm(directory, { recursive: true, force: true }); });
  const journal = { get: async (k) => forgotten.has(k) ? undefined : backing.get(k), put: (k, v) => { forgotten.delete(k); return backing.put(k, v); },
    entries: async () => (await backing.entries()).filter(([k]) => !forgotten.has(k)), withWalletLock: (k, w) => backing.withWalletLock(k, w) };
  return {
    path, journalId, journal,
    async reopen() {
      assert.deepEqual(backing.inspectLocks(), [], 'reopen only at a quiescent point');
      backing.close();
      backing = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: journalId });
      if (lossyReopen) for (const [k] of await backing.entries()) forgotten.add(k);
      reopens += 1;
    },
    reopens: () => reopens,
    inspectLocks: () => backing.inspectLocks(),
    // Consumer-visible view (what the broker/bridge read), not the raw file.
    lanes: async () => (await journal.entries()).filter(([k]) => k.startsWith('sr2/wallet/')).map(([, v]) => ({ stage: v.stage, nonce: Number(v.nonce), logicalAddress: v.approved?.logicalAddress })),
    adapters: async () => (await journal.entries()).filter(([k]) => k.startsWith('sr2/adapter/')).map(([, v]) => ({ logicalAddress: v.logicalAddress, stage: v.stage })),
  };
}

export async function nodeBrokerSetup(t, runtime, { lossyReopen = false, now } = {}) {
  const { Demos, Identities, validateMnemonic } = runtime;
  const store = await reopenableJournal(t, { lossyReopen });
  const chain = await startAgreementChain();
  const h = await startProtocolHarness({ chain, ...(now ? { now } : {}), env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback', DACS_MAX_UNPAID_PURCHASES_PER_ACCOUNT: '2', DACS_MAX_UNPAID_PURCHASES_PER_WALLET: '2' }, browserAgreement: { journal: store.journal, ttlMs: 120000 } });
  t.after(() => h.close());
  // Every broker HTTP call, with its outcome: observation, not just status.
  const calls = [];
  const post = (path, body) => fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body) })
    .then(async (r) => ({ http: r.status, ...await r.json() }));
  const api = async (path, body) => {
    const out = await post(path, body);
    calls.push({ route: path.split('/browser-agreement/')[1], http: out.http, state: out.state, delivered: Boolean(out.request), error: out.error });
    if (out.http !== 200) throw Object.assign(new Error(out.message), { code: out.error });
    return out;
  };
  let active;
  const approvals = [];
  const decision = { allow: true };
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic,
    anchorJournal: { get: (k) => active.anchorJournal.get(k), put: (k, v) => active.anchorJournal.put(k, v), withWalletLock: (k, w) => active.anchorJournal.withWalletLock(k, w) },
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (request) => { approvals.push(structuredClone(request)); return storage(request) ? decision.allow : true; } });
  await wallet.create(); t.after(() => wallet.lock());
  const user = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const account = h.app.services.accounts.walletOwner(address);
  const sign = async (message) => { const a = await wallet.request({ method: 'sign', params: [message] }); assert.equal(a.success, true); return a.data.signature; };
  let app = h.app;
  // `seller(h, listingId)` may supply another loopback seller; `beforeSign`
  // receives the retained operation after planning (interop operator facts).
  const operation = async (label, { seller: makeSeller = (hh, listingId) => addSeller(hh, { listingId }), beforeSign } = {}) => {
    const seller = await makeSeller(h, `current-broker-${label}-${++counter}`);
    const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `current-broker-${label}-${counter}`, protocol: 'dacs-sr2-wallet-agreement' });
    assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
    const token = tokenFrom(p.approvalUrl), id = p.operationId;
    const client = createOfflineAgreementBrokerClient({ id, token, api });
    const identity = await portal(h, `/portal/api/purchase/${id}/agreement/identity`, { token, address });
    const planned = await portal(h, `/portal/api/purchase/${id}/agreement/plan`, { token, signature: await sign(identity.signRequest.message) });
    assert.equal(planned.error, undefined, JSON.stringify(planned));
    if (beforeSign) await beforeSign(app.services.ops.get(account, id), seller);
    const signature = await sign(planned.signRequest.agreementMessage);
    const raw = (part, body) => post(`/portal/api/purchase/${id}/browser-agreement/${part}`, body);
    return { label, p, id, token, client, seller, logicalAddress: `dacs3:agreement:${p.protocol.jobId}`,
      authenticate: () => client.authenticate({ address, sign }),
      // Claim without completing: a delivered CREATE the browser never answered.
      claimOnly: async () => {
        const chl = await raw('challenge', { token, address });
        const opened = await raw('session', { token, challengeId: chl.challengeId, signature: await sign(chl.message) });
        return raw('claim', { sessionToken: opened.sessionToken });
      },
      approveOne: () => { active = client; return client.approveOne(wallet); },
      submit: () => portal(h, `/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature: signature }),
      verify: () => tool(h, user, 'verify_deal', { operationId: id }),
      record: () => store.journal.get(createKey(id)),
      anchor: () => app.services.ops.get(account, id).state.protocol.walletAnchor,
      recheck: () => app.services.protocol.recheck(app.services.ops.get(account, id)).then((op) => op.state.protocol) };
  };
  // Reconstruct the actual app/SQLite operation services with no old broker
  // sessions over the reopened journal: restart state, not process-kill proof.
  const restart = async () => {
    const originalClose = h.app.close;
    let closed = false;
    h.app.close = async () => { if (!closed) { closed = true; await originalClose(); } };
    await h.app.close();
    await store.reopen();
    app = await createApp({ config: h.config, dacsProtocol: { anchorUrl: h.anchors.url, sellerEndpoint: (claim) => h.endpoints.get(claim) ?? null, browserAgreement: { journal: store.journal } } });
    t.after(() => app.close());
  };
  return { h, chain, store, wallet, approvals, decision, calls, user, address, account, operation, restart,
    broadcasts: () => chain.wire.record.broadcastAttempts.length, createApprovals: () => approvals.filter(storage).length };
}
