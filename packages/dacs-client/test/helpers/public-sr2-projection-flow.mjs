// Ordinary functional acceptance: actual MCP/portal/broker and packaged wallet,
// realistic normalizing loopback RPC, actual seller HTTP; simulated evidence.
import assert from 'node:assert/strict';
import { startSr2Harness, startSr2Seller } from './seller-sr2-agreement-harness.mjs';
import { linkPackagedWallet } from './offline-agreement-fixture.mjs';
import { memoryAnchorJournal } from './dacs-storage-anchor-wallet-fixture.mjs';
import { linkedUser, tool, tokenFrom } from './flows.mjs';
import { createSdkWalletSession } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../../public/portal/offline-agreement-broker.mjs';

globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../../public/portal/embedded-wallet/demos-runtime.mjs');
let counter = 0;
export const post = async (url, body, origin) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body ?? {}) });
  return { ...await r.json().catch(() => ({})), httpStatus: r.status };
};

export async function publicProjectionFlow(t, { capability = true, durable = false } = {}) {
  const memory = memoryAnchorJournal();
  const journal = { ...memory, entries: () => memory.snapshot() };
  const h = await startSr2Harness({ journal, sellerSr2Commitment: capability ? { commitmentSubstrate: 'fixture', publicProjection: true } : null });
  t.after(() => h.close());
  let client;
  const approvals = [];
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic,
    anchorJournal: { get: (k) => client.anchorJournal.get(k), put: (k, v) => client.anchorJournal.put(k, v), withWalletLock: (k, work) => client.anchorJournal.withWalletLock(k, work) },
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (request) => { approvals.push(structuredClone(request)); return true; } });
  await wallet.create(); t.after(() => wallet.lock());
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async (message) => { const result = await wallet.request({ method: 'sign', params: [message] }); assert.equal(result.success, true); return result.data.signature; };
  const seller = await startSr2Seller(h, { listingId: `public-sr2-${++counter}`, durable });
  const receiveProposal = seller.agent.receiveProposal;
  seller.agent.receiveProposal = (body) => { seller.proposal = structuredClone(body); return receiveProposal(body); };
  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `public-sr2-${counter}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared));
  const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl);
  client = createOfflineAgreementBrokerClient({ id, token, api: async (path, body) => {
    const answer = await post(`${h.origin}${path}`, body, h.origin);
    if (answer.httpStatus !== 200) throw Object.assign(new Error(answer.message), { code: answer.error });
    return answer;
  } });
  const identity = await post(`${h.origin}/portal/api/purchase/${id}/agreement/identity`, { token, address });
  const planned = await post(`${h.origin}/portal/api/purchase/${id}/agreement/plan`, { token, signature: await sign(identity.signRequest.message) });
  assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
  const agreementSignature = await sign(planned.signRequest.agreementMessage);
  const account = h.app.services.accounts.walletOwner(address);
  return { h, wallet, buyer, address, seller, approvals, journal, memory, id, token, sign,
    op: () => h.app.services.ops.get(account, id),
    verify: () => tool(h, buyer, 'verify_deal', { operationId: id }),
    run: async () => {
      await client.authenticate({ address, sign });
      assert.equal((await post(`${h.origin}/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature })).httpStatus, 200);
      assert.equal((await client.approveOne(wallet)).state, 'completed');
      return tool(h, buyer, 'verify_deal', { operationId: id });
    } };
}
