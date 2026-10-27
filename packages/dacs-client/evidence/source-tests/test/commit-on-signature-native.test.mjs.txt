import test from 'node:test';
import assert from 'node:assert/strict';
import { startDevnetLiveCompositionApp } from './helpers/devnet-live-composition-app.mjs';
import { createDevnetAgreementWalletTransport } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createEphemeralPackagedSeller } from './helpers/native-settlement-consumer-seller.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { tool, tokenFrom } from './helpers/flows.mjs';
import { post } from './helpers/public-sr2-projection-flow.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';
import { createSellerTransportClientAuth } from '../src/dacs/seller-transport-auth.mjs';
import { createSellerAgentClient } from '../src/dacs/seller-http.mjs';
import { authorizedCreate } from './helpers/review-commit-retry-coverage-world.mjs';

async function world(t, options = {}) {
  const h = await startDevnetLiveCompositionApp({ commitOnSignature: true, ...options }); t.after(() => h.close());
  const actor = await createEphemeralPackagedSeller({ network: 'demos-devnet', transactionTransport: createDevnetAgreementWalletTransport(h.transport.capability.profile(h.origin)) }); t.after(() => actor.close());
  let client;
  const wallet = actor.walletFactory({ anchorJournal: { get: key => client.anchorJournal.get(key), put: (key, value) => client.anchorJournal.put(key, value), withWalletLock: (key, work) => client.anchorJournal.withWalletLock(key, work) } });
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const sign = async message => { const r = await wallet.request({ method: 'sign', params: [message] }); assert.equal(r.success, true); return r.data.signature; };
  const authentication = createSellerTransportClientAuth({ buyerSigner: { claim: actor.signer.claim, sign: bytes => actor.signer.signBytes(bytes) }, seller: h.sellerActor.signer.claim, resolveJob: job => h.jobContexts.get(job) });
  h.authenticationRegistry.set(h.sellerActor.signer.claim, authentication);
  const prepared = await tool(h, buyer, 'prepare_purchase', { listingId: h.composition.listing.listingId, version: 1, seller: h.sellerActor.signer.claim, idempotencyKey: `signature-native-${Date.now()}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(prepared.status, 'agreement_pending', JSON.stringify(prepared));
  const id = prepared.operationId, token = tokenFrom(prepared.approvalUrl), api = (part, body = {}) => post(`${h.origin}/portal/api/purchase/${id}/${part}`, { token, ...body }, h.origin);
  client = createOfflineAgreementBrokerClient({ id, token, api: async (path, body) => { const r = await post(`${h.origin}${path}`, body, h.origin); if (r.httpStatus !== 200) throw Error(JSON.stringify(r)); return r; } });
  const account = h.app.services.accounts.walletOwner(address), op = () => h.app.services.ops.get(account, id);
  const identity = await api('agreement/identity', { address }), plan = await api('agreement/plan', { signature: await sign(identity.signRequest.message) });
  assert.equal(plan.httpStatus, 200, JSON.stringify(plan));
  h.jobContexts.set(op().terms.protocol.jobId, { listingPin: plan.signRequest.summary.listing, agreementHash: plan.signRequest.agreementHash });
  await client.authenticate({ address, sign });
  assert.equal((await api('agreement/sign', { agreementSignature: await sign(plan.signRequest.agreementMessage) })).httpStatus, 200);
  return { h, actor, wallet, client, buyer, op, verify: () => tool(h, buyer, 'verify_deal', { operationId: id }), peer: createSellerAgentClient({ url: h.sellerOrigin, authentication, commitOnSignature: true }) };
}

test('native composition recovers shared buyer/seller connection contention without stranding or resending', async t => {
  let commitmentSignatures = 0, broadcastGate = false;
  const w = await world(t, { onCommitmentSign: () => { commitmentSignatures++; }, beforeBuyerBroadcast: async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(commitmentSignatures, 0, 'connection reservation precedes seller commitment signing'); broadcastGate = true;
  } });
  assert.equal((await w.client.approveOne(w.wallet)).state, 'completed');
  await w.h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  assert.equal(broadcastGate, true);
  const result = await w.verify();
  assert.equal(result.status, 'awaiting_approval', JSON.stringify({ result, sourceErrors: w.h.transport.errors, seller: w.h.sellerTiming.snapshot() }));
  assert.equal(w.h.transport.chain.wire.record.accepted.filter(tx => tx.content.data[1].metadata.artifactKind === 'FinalityCommitmentRecord').length, 1);
  assert.equal(w.h.transport.chain.wire.record.broadcastAttempts.length, w.h.transport.chain.wire.record.accepted.length, 'no broadcast retry');
});

test('native closed admission refuses a foreign buyer before its early attempt or CREATE', async t => {
  const custodyBuyer = createEphemeralWallet();
  const w = await world(t, { signatureBuyer: custodyBuyer.claim, appCommitOnSignature: false });
  const agreement = w.op().state.protocol.walletAnchor.artifact;
  const buyer = { address: w.wallet.getPublicAccount().address, signHex: message => '0x' + w.actor.signer.signBytes(Buffer.from(message)).toString('hex') };
  const signed = authorizedCreate({ buyer, agreement, clock: Date.now() });
  const creates = w.h.transport.chain.wire.record.accepted.length;
  assert.equal(w.h.transport.chain.wire.record.accepted.filter(tx => tx.content.data[1].metadata.artifactKind === 'FinalityCommitmentRecord').length, 0, 'closed admission cannot spend before the foreign buyer authorizes a CREATE');
  await assert.rejects(w.peer.commitOnSignature(agreement.jobId, agreement, signed), /not admitted|unavailable|unauthenticated/);
  await w.h.sellerTiming.waitForIdle({ timeoutMs: 60000 });
  assert.equal(w.h.transport.chain.wire.record.accepted.length, creates, 'foreign buyer consumes no seller CREATE');
  assert.equal(w.h.transport.chain.wire.record.accepted.filter(tx => tx.content.data[1].metadata.artifactKind === 'Agreement').length, 0);
  assert.equal(w.h.composition.sellerAgent.stageOf(agreement.jobId), 'proposed');
});

test('a held buyer signature fence cannot consume and strand the native seller attempt', async t => {
  const w = await world(t, { appCommitOnSignature: false });
  const agreement = w.op().state.protocol.walletAnchor.artifact, address = w.wallet.getPublicAccount().address;
  const buyer = { address, signHex: message => '0x' + w.actor.signer.signBytes(Buffer.from(message)).toString('hex') };
  const signed = authorizedCreate({ buyer, agreement, clock: Date.now() });
  const { binding } = await w.h.transport.capability.binding({ phase: 'bind', address });
  const lease = await w.h.transport.capability.binding({ phase: 'signature', address, binding });
  const attempt = Promise.resolve().then(() => w.peer.commitOnSignature(agreement.jobId, agreement, signed)).catch(() => null);
  await new Promise(resolve => setTimeout(resolve, 100));
  await w.h.transport.capability.binding({ phase: 'release', address, leaseId: lease.leaseId });
  await attempt;
  assert.equal((await w.client.approveOne(w.wallet)).state, 'completed');
  const result = await w.verify();
  assert.equal(result.status, 'awaiting_approval', JSON.stringify(result));
  assert.equal(w.h.transport.chain.wire.record.accepted.filter(tx => tx.content.data[1].metadata.artifactKind === 'FinalityCommitmentRecord').length, 1);
});

test('a definite native publication failure after readiness leaves the ordinary commitment available without a resend', async t => {
  let failNonce = false, nonceFaults = 0;
  const w = await world(t, { appCommitOnSignature: false, rpcOverride: body => {
    if (!failNonce || body?.params?.[0]?.message !== 'getAddressNonce') return undefined;
    failNonce = false; nonceFaults++;
    return { result: 500, response: 'TEST seller nonce unavailable before any publication intent' };
  } });
  const commitments = () => w.h.transport.chain.wire.record.accepted.filter(tx => tx.content.data[1].metadata.artifactKind === 'FinalityCommitmentRecord');
  const agreement = w.op().state.protocol.walletAnchor.artifact, address = w.wallet.getPublicAccount().address;
  const buyer = { address, signHex: message => '0x' + w.actor.signer.signBytes(Buffer.from(message)).toString('hex') };
  failNonce = true;
  await assert.rejects(w.peer.commitOnSignature(agreement.jobId, agreement, authorizedCreate({ buyer, agreement, clock: Date.now() })));
  assert.equal(nonceFaults, 1, 'the early attempt reached native publication and failed before its intent');
  assert.equal(commitments().length, 0);
  assert.equal((await w.client.approveOne(w.wallet)).state, 'completed');
  const result = await w.verify();
  assert.equal(result.status, 'awaiting_approval', JSON.stringify(result));
  assert.equal(commitments().length, 1);
  assert.equal(w.h.transport.chain.wire.record.broadcastAttempts.length, w.h.transport.chain.wire.record.accepted.length, 'no broadcast retry');
});
