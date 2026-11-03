import assert from 'node:assert/strict';
import { startNativeAgreementHarness } from './native-agreement-payment-harness.mjs';
import { startSr2Seller } from './seller-sr2-agreement-harness.mjs';
import { linkPackagedWallet } from './offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './flows.mjs';
import { post } from './public-sr2-projection-flow.mjs';
import { createSdkWalletSession } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../../public/portal/offline-agreement-broker.mjs';
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../../public/portal/embedded-wallet/demos-runtime.mjs');
let counter = 0;
export async function nativePaymentFlow(t, options = {}) {
  const h = await startNativeAgreementHarness(options); t.after(() => h.close());
  let client, allowPayment = true, allowAgreement = true;
  const approvals = [];
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic,
    anchorJournal: { get: (k) => client.anchorJournal.get(k), put: (k, v) => client.anchorJournal.put(k, v), withWalletLock: (k, work) => client.anchorJournal.withWalletLock(k, work) },
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (r) => { approvals.push(structuredClone(r)); return r.content?.action === 'native DEM transfer' ? allowPayment : allowAgreement; } });
  await wallet.create(); t.after(() => wallet.lock());
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async (message) => { const r = await wallet.request({ method: 'sign', params: [message] }); assert.equal(r.success, true); return r.data.signature; };
  const seller = await startSr2Seller(h, { listingId: `native-payment-${++counter}`, durable: options.durableSeller ?? true, ...options.sellerOptions });
  const prepare = () => tool(h, buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `native-payment-${counter}-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  const prepared = await prepare(); assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared)); const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl);
  const api = (part, body = {}) => post(`${h.origin}/portal/api/purchase/${id}/${part}`, { token, ...body }, h.origin);
  client = createOfflineAgreementBrokerClient({ id, token, api: async (path, body) => { const r = await post(`${h.origin}${path}`, body, h.origin); if (r.httpStatus !== 200) throw Object.assign(new Error(r.message), { code: r.error }); return r; } });
  const account = h.app.services.accounts.walletOwner(address);
  return { h, wallet, buyer, address, seller, approvals, prepared, id, token, sign, api, prepare,
    allowAgreement: (v) => { allowAgreement = v; }, allowPayment: (v) => { allowPayment = v; }, op: () => h.app.services.ops.get(account, id), verify: (txHash) => tool(h, buyer, 'verify_deal', { operationId: id, ...(txHash ? { txHash } : {}) }),
    async agreement({ beforeWalletApproval, afterWalletApproval, approvalState = 'completed', skipWalletApproval = false } = {}) {
      const identity = await api('agreement/identity', { address });
      const planned = await api('agreement/plan', { signature: await sign(identity.signRequest.message) });
      assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
      const agreementSignature = await sign(planned.signRequest.agreementMessage);
      await client.authenticate({ address, sign });
      assert.equal((await api('agreement/sign', { agreementSignature })).httpStatus, 200);
      await beforeWalletApproval?.();
      if (!skipWalletApproval) assert.equal((await client.approveOne(wallet)).state, approvalState);
      await afterWalletApproval?.();
      return tool(h, buyer, 'verify_deal', { operationId: id });
    },
    async approve() { const challenge = await api('challenge', { address }); assert.equal(challenge.httpStatus, 200, JSON.stringify(challenge)); return { challenge, handoff: await api('approve', { challengeId: challenge.challengeId, signature: await sign(challenge.message) }) }; },
    async otherDraft() {
      const preparedOther = await prepare(), otherId = preparedOther.operationId, otherToken = tokenFrom(preparedOther.approvalUrl);
      assert.equal(preparedOther.status, 'agreement_pending', JSON.stringify(preparedOther));
      const otherApi = (part, body = {}) => post(`${h.origin}/portal/api/purchase/${otherId}/${part}`, { token: otherToken, ...body }, h.origin);
      const identity = await otherApi('agreement/identity', { address });
      const plan = await otherApi('agreement/plan', { signature: await sign(identity.signRequest.message) });
      assert.equal(plan.httpStatus, 200, JSON.stringify(plan));
      const otherClient = createOfflineAgreementBrokerClient({ id: otherId, token: otherToken, api: async (path, body) => { const r = await post(`${h.origin}${path}`, body, h.origin); if (r.httpStatus !== 200) throw Object.assign(new Error(r.message), { code: r.error }); return r; } });
      await otherClient.authenticate({ address, sign });
      const agreementSignature = await sign(plan.signRequest.agreementMessage);
      return { prepared: preparedOther, submit: () => otherApi('agreement/sign', { agreementSignature }),
        async approve() { const previous = client; client = otherClient; try { return await otherClient.approveOne(wallet); } finally { client = previous; } } };
    },
    send: (payload) => { client.useNativePaymentLane(); return wallet.request({ method: 'sendTransaction', params: [payload] }); } };
}
