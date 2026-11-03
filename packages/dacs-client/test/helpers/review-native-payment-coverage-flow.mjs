// Same packaged-wallet/portal/MCP flow as native-agreement-payment-flow.mjs, but
// one SDK wallet session can drive several purchases in turn: its public
// journal delegate follows the purchase currently being driven. Nothing is
// planted; every CREATE/approval/send goes through the actual portal APIs.
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

export async function nativeRepeatBuyer(t) {
  const h = await startNativeAgreementHarness({ maxUnpaid: '2' }); t.after(() => h.close());
  let client;
  const approvals = [];
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic,
    anchorJournal: { get: (k) => client.anchorJournal.get(k), put: (k, v) => client.anchorJournal.put(k, v), withWalletLock: (k, work) => client.anchorJournal.withWalletLock(k, work) },
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (r) => { approvals.push(structuredClone(r)); return true; } });
  await wallet.create(); t.after(() => wallet.lock());
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async (message) => { const r = await wallet.request({ method: 'sign', params: [message] }); assert.equal(r.success, true); return r.data.signature; };
  const seller = await startSr2Seller(h, { listingId: `review-native-repeat-${++counter}`, durable: true });
  const account = () => h.app.services.accounts.walletOwner(address);
  async function purchase(tag) {
    const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `review-native-repeat-${counter}-${tag}`, protocol: 'dacs-sr2-wallet-agreement' });
    if (prepared.status !== 'agreement_pending') return { prepared };
    const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl);
    const api = (part, body = {}) => post(`${h.origin}/portal/api/purchase/${id}/${part}`, { token, ...body }, h.origin);
    const own = createOfflineAgreementBrokerClient({ id, token, api: async (path, body) => { const r = await post(`${h.origin}${path}`, body, h.origin); if (r.httpStatus !== 200) throw Object.assign(new Error(r.message), { code: r.error }); return r; } });
    return { prepared, id, token, api, op: () => h.app.services.ops.get(account(), id), verify: (txHash) => tool(h, buyer, 'verify_deal', { operationId: id, ...(txHash ? { txHash } : {}) }),
      async agreement() {
        client = own;
        const identity = await api('agreement/identity', { address });
        const planned = await api('agreement/plan', { signature: await sign(identity.signRequest.message) });
        assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
        const agreementSignature = await sign(planned.signRequest.agreementMessage);
        await own.authenticate({ address, sign });
        assert.equal((await api('agreement/sign', { agreementSignature })).httpStatus, 200);
        const delivered = await own.approveOne(wallet);
        return { delivered, verified: await tool(h, buyer, 'verify_deal', { operationId: id }) };
      },
      async approve() { const challenge = await api('challenge', { address }); assert.equal(challenge.httpStatus, 200, JSON.stringify(challenge)); return api('approve', { challengeId: challenge.challengeId, signature: await sign(challenge.message) }); },
      send: (payload) => { client = own; own.useNativePaymentLane(); return wallet.request({ method: 'sendTransaction', params: [payload] }); } };
  }
  return { h, wallet, buyer, address, seller, approvals, purchase };
}
