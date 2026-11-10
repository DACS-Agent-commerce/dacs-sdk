// The live-composition purchase steps shared by the DACS_BUYER_CHAIN_READBACK
// tests: start a harness, agree, hand off payment, pay and read delivery.
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startDevnetLiveCompositionApp } from './devnet-live-composition-app.mjs';
import { createDevnetAgreementWalletTransport } from '../../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './native-settlement-consumer-seller.mjs';
import { linkPackagedWallet } from './offline-agreement-fixture.mjs';
import { tool, toolRaw, tokenFrom } from './flows.mjs';
import { post } from './public-sr2-projection-flow.mjs';
import { createOfflineAgreementBrokerClient } from '../../public/portal/offline-agreement-broker.mjs';
import { createSellerTransportClientAuth } from '../../src/dacs/seller-transport-auth.mjs';

export const NEW_FIELDS = /chainReadback|publicSignedCreates|answerProjectionOnly|chainSignedCreate/;
export const txReads = (h) => h.transport.requests.filter((request) => request === 'getTxByHash').length;
// Successful seller answers as the seller sent them for one route.
export const served = (h, path) => h.sellerResponses.filter((sent) => sent.path === path && sent.status === 200).map((sent) => { try { return JSON.parse(sent.text); } catch { return null; } }).filter(Boolean);
export const creates = (h) => h.transport.chain.wire.record.accepted.length;
export const notFound = (programName) => (parsed) => parsed?.method === 'nodeCall' && parsed.params?.[0]?.message === 'searchStoragePrograms' && parsed.params[0].data?.query === programName
  ? { result: 200, response: [], require_reply: false, extra: null } : undefined;

export async function start(t, options) {
  const h = await startDevnetLiveCompositionApp(options);
  t.after(async () => { await h.sellerTiming.waitForIdle({ timeoutMs: 60000 }).catch(() => {}); await h.close(); });
  globalThis.location = new URL(h.origin); globalThis.window ??= globalThis; globalThis.document ??= { baseURI: `${h.origin}/portal/assets/embedded-wallet/`, currentScript: null };
  return h;
}

// The existing live-composition purchase, through the Agreement CREATE approval.
export async function agree(t, h) {
  let client;
  const buyerActor = await createEphemeralPackagedSeller({ network: 'demos-devnet', transactionTransport: createDevnetAgreementWalletTransport(h.transport.capability.profile(h.origin)) }); t.after(() => buyerActor.close());
  const wallet = buyerActor.walletFactory({ anchorJournal: { get: (key) => client.anchorJournal.get(key), put: (key, value) => client.anchorJournal.put(key, value), withWalletLock: (key, work) => client.anchorJournal.withWalletLock(key, work) } });
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async (message) => { const answer = await wallet.request({ method: 'sign', params: [message] }); assert.equal(answer.success, true); return answer.data.signature; };
  h.authenticationRegistry.set(h.sellerActor.signer.claim, createSellerTransportClientAuth({ buyerSigner: { claim: buyerActor.signer.claim, sign: (bytes) => buyerActor.signer.signBytes(bytes) }, seller: h.sellerActor.signer.claim, resolveJob: (jobId) => h.jobContexts.get(jobId) }));
  const preparedRaw = await toolRaw(h, buyer, 'prepare_purchase', { listingId: h.composition.listing.listingId, version: 1, seller: h.sellerActor.signer.claim, idempotencyKey: `chain-readback-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  const prepared = preparedRaw.structuredContent;
  assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared));
  const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl), api = (part, body = {}) => post(`${h.origin}/portal/api/purchase/${id}/${part}`, { token, ...body }, h.origin);
  client = createOfflineAgreementBrokerClient({ id, token, api: async (path, body) => { const answer = await post(`${h.origin}${path}`, body, h.origin); if (answer.httpStatus !== 200) throw Object.assign(new Error(answer.message), { code: answer.error }); return answer; } });
  const account = h.app.services.accounts.walletOwner(address), operation = () => h.app.services.ops.get(account, id);
  const identity = await api('agreement/identity', { address }), planned = await api('agreement/plan', { signature: await sign(identity.signRequest.message) }); assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
  h.jobContexts.set(operation().terms.protocol.jobId, { listingPin: planned.signRequest.summary.listing, agreementHash: planned.signRequest.agreementHash });
  await client.authenticate({ address, sign });
  const signed = await api('agreement/sign', { agreementSignature: await sign(planned.signRequest.agreementMessage) }); assert.equal(signed.httpStatus, 200, JSON.stringify(signed));
  const approved = await client.approveOne(wallet); assert.equal(approved.state, 'completed', JSON.stringify(approved));
  return { buyer, buyerActor, wallet, client, api, sign, id, address, operation, preparedRaw, verify: () => tool(h, buyer, 'verify_deal', { operationId: id }),
    raw: (name, args = { operationId: id }) => toolRaw(h, buyer, name, args),
    async listTools() { const mcp = new Client({ name: 'chain-readback-tools', version: '1' }); await mcp.connect(new StreamableHTTPClientTransport(new URL(h.mcpUrl), { authProvider: buyer.provider })); try { return (await mcp.listTools()).tools; } finally { await mcp.close(); } } };
}
export async function handoff(f) {
  const challenge = await f.api('challenge', { address: f.address });
  const answer = await f.api('approve', { challengeId: challenge.challengeId, signature: await f.sign(challenge.message) });
  assert.equal(answer.status, 'payment_handoff', JSON.stringify(answer));
  return answer;
}
export async function payAndDeliver(h, f, payment) {
  f.client.useNativePaymentLane(); const sent = await f.wallet.request({ method: 'sendTransaction', params: [payment.payload] }); assert.equal(sent.success, true, JSON.stringify(sent));
  let completed = (await f.api('report', { txHash: sent.data.hash })).evidence;
  await h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  for (let attempt = 0; attempt < 4 && completed?.protocol?.stage !== 'delivery-ready'; attempt++) completed = await f.verify();
  assert.equal(completed.protocol?.stage, 'delivery-ready', JSON.stringify(completed));
  return { txHash: sent.data.hash, completed };
}
export const context = (h, f) => { const op = f.operation(); return { op, p: op.state.protocol, agreement: op.state.protocol.agreement.artifact, listing: op.state.protocol.listing, seller: op.terms.seller.claim, jobId: op.terms.protocol.jobId }; };
