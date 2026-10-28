import assert from 'node:assert/strict';
import { startNativeEvidenceHarness, startNativeEvidenceSeller } from './native-payment-evidence-harness.mjs';
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
export async function nativeEvidenceFlow(t, options = {}) {
  const h = await startNativeEvidenceHarness(options); t.after(() => h.close());
  let client, allowPayment = true;
  const approvals = [];
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic,
    anchorJournal: { get: (k) => client.anchorJournal.get(k), put: (k, v) => client.anchorJournal.put(k, v), withWalletLock: (k, work) => client.anchorJournal.withWalletLock(k, work) },
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (r) => { approvals.push(structuredClone(r)); return r.content?.action === 'native DEM transfer' ? allowPayment : true; } });
  await wallet.create(); t.after(() => wallet.lock());
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async (message) => { const r = await wallet.request({ method: 'sign', params: [message] }); assert.equal(r.success, true); return r.data.signature; };
  const seller = await startNativeEvidenceSeller(h, { listingId: `native-payment-${++counter}` });
  const prepare = () => tool(h, buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `native-payment-${counter}-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  const prepared = await prepare(); assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared)); const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl);
  const api = (part, body = {}) => post(`${h.origin}/portal/api/purchase/${id}/${part}`, { token, ...body }, h.origin);
  client = createOfflineAgreementBrokerClient({ id, token, api: async (path, body) => { const r = await post(`${h.origin}${path}`, body, h.origin); if (r.httpStatus !== 200) throw Object.assign(new Error(r.message), { code: r.error }); return r; } });
  const account = h.app.services.accounts.walletOwner(address);
  const publicDiagnostic = () => ({stage:h.app.services.ops.get(account,id)?.state?.protocol?.stage,
    protocolAttempts:h.app.services.ops.get(account,id)?.state?.protocol?.attempts,
    sellerErrors:seller.functionalErrors.map(({code,message})=>({code,message})),
    storageConfirms:h.chain.wire.record.confirmAttempts?.length,storageSends:h.chain.wire.record.broadcastAttempts.length,
    storageAccepted:h.chain.wire.record.accepted.length,paymentAccepted:h.chain.record.accepted.length,
    storageRejections:h.chain.wire.record.rejections,paymentRejections:h.chain.record.rejections});
  return { h, wallet, buyer, address, seller, approvals, prepared, id, token, sign, api, prepare, authenticateAgreement:()=>client.authenticate({address,sign}),
    allowPayment: (v) => { allowPayment = v; }, op: () => h.app.services.ops.get(account, id), verify: (txHash) => tool(h, buyer, 'verify_deal', { operationId: id, ...(txHash ? { txHash } : {}) }),
    async agreement() {
      const identity = await api('agreement/identity', { address });
      const planned = await api('agreement/plan', { signature: await sign(identity.signRequest.message) });
      assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
      const agreementSignature = await sign(planned.signRequest.agreementMessage);
      await client.authenticate({ address, sign });
      const signed = await api('agreement/sign', { agreementSignature });
      assert.equal(signed.httpStatus, 200,JSON.stringify(publicDiagnostic()));
      try { assert.equal((await client.approveOne(wallet)).state, 'completed',JSON.stringify(publicDiagnostic())); }
      catch(error) { throw new Error(`${error.message}; public consumer diagnostic=${JSON.stringify(publicDiagnostic())}`,{cause:error}); }
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
      return { submit: () => otherApi('agreement/sign', { agreementSignature }) };
    },
    send: (payload) => { client.useNativePaymentLane(); return wallet.request({ method: 'sendTransaction', params: [payload] }); } };
}
