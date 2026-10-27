// Role-owned setup mirroring test/dacs-offline-browser-broker.test.mjs, with the
// opt-in harness browserAgreement journal replaced by the durable journal.
// Real packaged SDK signatures; approvals are synthetic callbacks (not Chrome).
import assert from 'node:assert/strict';
import { startProtocolHarness, addSeller } from '../dacs-loopback-fixture.test.mjs';
import { tool, portal, tokenFrom } from './flows.mjs';
import { startAgreementChain, linkPackagedWallet } from './offline-agreement-fixture.mjs';
import { createSdkWalletSession } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../../public/portal/offline-agreement-broker.mjs';

let counter = 0;
export const storage = (r) => r.content?.kind === 'dacs-storage-anchor-create';

export async function durableBrokerSetup(t, { journal, runtime, allow = true }) {
  const { Demos, Identities, validateMnemonic } = runtime;
  const chain = await startAgreementChain();
  const h = await startProtocolHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' }, browserAgreement: { journal, ttlMs: 120000 } });
  t.after(() => h.close());
  const calls = [];
  const api = async (path, body) => {
    calls.push({ path });
    const res = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: h.origin }, body: JSON.stringify(body) });
    const out = await res.json();
    if (!res.ok) { calls.push({ rejectedPath: path, error: out.error }); throw Object.assign(new Error(out.message), { code: out.error }); }
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
  const seller = await addSeller(h, { listingId: `durable-broker-${++counter}` });
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `durable-broker-${counter}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const token = tokenFrom(p.approvalUrl), id = p.operationId;
  client = createOfflineAgreementBrokerClient({ id, token, api });
  const sign = async (message) => { const answer = await wallet.request({ method: 'sign', params: [message] }); assert.equal(answer.success, true); return answer.data.signature; };
  const identity = await portal(h, `/portal/api/purchase/${id}/agreement/identity`, { token, address: wallet.getPublicAccount().address });
  const planned = await portal(h, `/portal/api/purchase/${id}/agreement/plan`, { token, signature: await sign(identity.signRequest.message) });
  assert.equal(planned.error, undefined, JSON.stringify(planned));
  const signature = await sign(planned.signRequest.agreementMessage);
  const account = h.app.services.accounts.walletOwner(wallet.getPublicAccount().address);
  return { h, chain, wallet, approvals, user, seller, token, id, account, client, calls,
    submit: () => portal(h, `/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature: signature }),
    authenticate: () => client.authenticate({ address: wallet.getPublicAccount().address, sign }),
    verify: () => tool(h, user, 'verify_deal', { operationId: id }),
    walletAnchor: () => h.app.services.ops.get(account, id).state.protocol.walletAnchor };
}
