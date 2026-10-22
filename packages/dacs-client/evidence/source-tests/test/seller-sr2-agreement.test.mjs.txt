// Seller SR-2 Agreement consumer (docs/SELLER-SR2-AGREEMENT-INTEGRATION.md):
// actual OAuth/MCP, portal and loopback broker; the packaged SDK wallet signs,
// confirms and broadcasts exactly one Agreement storage CREATE on the SR-2
// fixture chain (approvals are synthetic consent callbacks); the actual seller
// agent behind the existing seller HTTP handler reads that native CREATE
// through the existing SR-2 adapter. Characterizes the exact remaining
// upstream gap; payment stays held throughout. Simulated loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fixedPriceAgreementLogicalAddress } from '@kynesyslabs/dacs';
import { startSr2Harness, startSr2Seller } from './helpers/seller-sr2-agreement-harness.mjs';
import { linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { linkedUser, tool, tokenFrom } from './helpers/flows.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createOfflineAgreementBrokerClient } from '../public/portal/offline-agreement-broker.mjs';
import { createSellerSr2AgreementAnchor, sellerSr2CommitmentConfig, SELLER_SR2_COMMITMENT_MARKER } from '../src/dacs/seller-sr2-agreement-consumer.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
let counter = 0;
const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const storage = (r) => r.content?.kind === 'dacs-storage-anchor-create';
const post = async (url, body, origin) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body ?? {}) });
  return { ...await r.json().catch(() => ({})), httpStatus: r.status };
};
const SELLER_GAP = /transaction lacks the exact writer authorization/;

async function setup(t, { capability = true, sr2Reader = true, exactContentNode = false, durable = false } = {}) {
  const memory = memoryAnchorJournal(), journal = { ...memory, entries: () => memory.snapshot() };
  const h = await startSr2Harness({ journal, exactContentNode, sellerSr2Commitment: capability ? { commitmentSubstrate: 'fixture' } : null });
  t.after(() => h.close());
  const api = async (path, body) => {
    const out = await post(`${h.origin}${path}`, body, h.origin);
    if (out.httpStatus !== 200) throw Object.assign(new Error(out.message), { code: out.error });
    return out;
  };
  let client;
  const approvals = [];
  const wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic,
    anchorJournal: { get: (k) => client.anchorJournal.get(k), put: (k, v) => client.anchorJournal.put(k, v), withWalletLock: (k, w) => client.anchorJournal.withWalletLock(k, w) },
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (request) => { approvals.push(structuredClone(request)); return true; } });
  await wallet.create(); t.after(() => wallet.lock());
  const buyer = await linkPackagedWallet(h, wallet), address = wallet.getPublicAccount().address;
  const other = await linkedUser(h);
  const sign = async (message) => { const a = await wallet.request({ method: 'sign', params: [message] }); assert.equal(a.success, true); return a.data.signature; };
  const seller = await startSr2Seller(h, { listingId: `seller-sr2-${++counter}`, sr2Reader, durable });
  const p = await tool(h, buyer, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `seller-sr2-${counter}`, protocol: 'dacs-sr2-wallet-agreement' });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const token = tokenFrom(p.approvalUrl), id = p.operationId;
  client = createOfflineAgreementBrokerClient({ id, token, api });
  const identity = await post(`${h.origin}/portal/api/purchase/${id}/agreement/identity`, { token, address });
  const planned = await post(`${h.origin}/portal/api/purchase/${id}/agreement/plan`, { token, signature: await sign(identity.signRequest.message) });
  assert.equal(planned.httpStatus, 200, JSON.stringify(planned));
  const agreementSignature = await sign(planned.signRequest.agreementMessage);
  const account = h.app.services.accounts.walletOwner(address);
  return { h, journal, wallet, approvals, buyer, other, address, seller, p, id, token, client,
    op: () => h.app.services.ops.get(account, id),
    run: async () => {
      await client.authenticate({ address, sign });
      const submitted = await post(`${h.origin}/portal/api/purchase/${id}/agreement/sign`, { token, agreementSignature });
      assert.equal(submitted.httpStatus, 200, JSON.stringify(submitted));
      assert.equal((await client.approveOne(wallet)).state, 'completed');
      return tool(h, buyer, 'verify_deal', { operationId: id });
    },
    verify: () => tool(h, buyer, 'verify_deal', { operationId: id }) };
}

// Accepting control on the IDEALIZED exact-content node (see the harness):
// every verification is the unchanged SR-2 adapter's (`read` + `verifyReceipt`).
test('accepting control (idealized exact-content node, simulated): seller HTTP commit authenticates the native SR-2 Agreement through the adapter and commits; buyer reads it back and stops at seller-committed, payment held', async (t) => {
  const w = await setup(t, { exactContentNode: true });
  const out = await w.run();
  assert.equal(out.protocol.stage, 'seller-committed', JSON.stringify(out.protocol.lastAttempt));
  assert.equal(out.status, 'agreement_pending', 'no awaiting_approval transition: payment stays held');
  const p = w.op().state.protocol, jobId = w.op().terms.protocol.jobId;
  const accepted = w.h.chain.wire.record.accepted;
  assert.equal(accepted.length, 1); assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 1);
  assert.deepEqual(accepted[0].content.data[1].data.signatures.map((s) => s.party), [p.buyerBundle.presentedBy, w.seller.wallet.claim]);
  assert.equal(out.protocol.commitment.signer, w.seller.wallet.claim);
  assert.equal(w.seller.agent.stageOf(jobId), 'committed');
  // The seller names the native Agreement (not a fixture write) in its answer.
  const again = await post(`${w.seller.origin}/dacs/v1/commitments`, { jobId });
  t.diagnostic(`seller commit (repeat): ${JSON.stringify(again)}`);
  assert.equal(again.status, 'committed');
  const reader = createSellerSr2AgreementAnchor({ rpcUrl: w.h.sellerChainUrl });
  const read = await reader.readAgreement({ logicalAddress: fixedPriceAgreementLogicalAddress(jobId), writer: p.buyerBundle.presentedBy });
  assert.equal(read.disposition, 'present', JSON.stringify(read));
  const realistic = await createSellerSr2AgreementAnchor({ rpcUrl: w.h.chain.url }).readAgreement({ logicalAddress: fixedPriceAgreementLogicalAddress(jobId), writer: p.buyerBundle.presentedBy });
  assert.equal(realistic.disposition, 'rejected', 'the same read on the realistic node view is the documented gap');
  assert.equal(read.native.nativeAddress, p.agreement.anchorReceipt.nativeAddress); assert.equal(read.native.source, 'demos-sr2-storage-create');
  assert.deepEqual(read.ref, { anchor: { kind: 'storage-program', locator: fixedPriceAgreementLogicalAddress(jobId) }, contentHash: p.agreement.hash });
  assert.match(out.protocol.limits.commitment, /read-back-independently; fixture record; not strict finality/);
  assert.match(out.protocol.limits.commitmentAnchor, /SIMULATED fixture substrate/);
  for (const part of ['challenge', 'handoff']) assert.equal((await post(`${w.h.origin}/portal/api/purchase/${w.id}/${part}`, { token: w.token, address: w.address })).error, 'agreement_payment_held');
  assert.ok(!w.seller.requests.includes('/dacs/v1/payments'));
  assert.equal((await w.verify()).protocol.stage, 'seller-committed');
  assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 1, 'rechecks never re-send'); assert.equal(w.approvals.filter(storage).length, 1);
  t.diagnostic(JSON.stringify({ stage: out.protocol.stage, commitment: out.protocol.commitment.contentHash, nativeAddress: read.native.nativeAddress, node: 'idealized-exact-content', payment: 'held' }));
});

test('lifecycle (idealized node): durable seller restart re-reads the same native Agreement and resumes the same commitment without another buyer CREATE', async (t) => {
  let w;
  try { w = await setup(t, { exactContentNode: true, durable: true }); }
  catch (error) {
    // The pinned SDK private store refuses any group/world-writable ancestor of
    // the temp directory; reported as an explicit host skip, never a pass.
    if (/fenced session store path component is group\/world writable/.test(error.message)) return t.skip(`HOST: ${error.message}`);
    throw error;
  }
  const out = await w.run();
  assert.equal(out.protocol.stage, 'seller-committed', JSON.stringify(out.protocol.lastAttempt));
  const jobId = w.op().terms.protocol.jobId, p = w.op().state.protocol;
  await w.seller.restart();
  const answer = await post(`${w.seller.origin}/dacs/v1/commitments`, { jobId });
  assert.equal(answer.status, 'committed', JSON.stringify(answer)); assert.equal(answer.resumed, true);
  assert.equal(answer.agreementAnchor.nativeAddress, p.agreement.anchorReceipt.nativeAddress, 'the seller names the native Agreement after restart');
  assert.equal(answer.agreementAnchor.source, 'demos-sr2-storage-create'); assert.equal(answer.agreementAnchor.evidenceMode, 'simulated-fixture');
  const again = await w.verify();
  assert.equal(again.protocol.stage, 'seller-committed'); assert.equal(again.protocol.commitment.contentHash, out.protocol.commitment.contentHash);
  assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 1, 'no second buyer CREATE'); assert.equal(w.seller.restarts(), 1);
});

test('actual seam, exact gap: the seller HTTP commit consumes the buyer native CREATE through the SR-2 adapter, which cannot authenticate it without the writer-retained signed projection; buyer stops at agreement-anchored, payment held', async (t) => {
  const w = await setup(t);
  assert.equal(w.op().terms.protocol.sellerCommitment, SELLER_SR2_COMMITMENT_MARKER);
  const out = await w.run();
  const p = w.op().state.protocol, jobId = w.op().terms.protocol.jobId;
  // Achieved: exactly one packaged-wallet CREATE, natively read back by the buyer's own bridge.
  assert.equal(out.protocol.stage, 'agreement-anchored', JSON.stringify(out.protocol.lastAttempt));
  assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 1); assert.equal(w.approvals.filter(storage).length, 1);
  // The seller's actual commit endpoint was reached and consumed the SR-2 reader.
  assert.ok(w.seller.requests.includes('/dacs/v1/commitments'));
  const attempts = p.attempts.map((a) => `${a.step}:${a.outcome}`);
  assert.ok(attempts.includes('commit-request:refused'), JSON.stringify(p.attempts));
  assert.match(p.attempts.find((a) => a.step === 'commit-request').reason, SELLER_GAP);
  assert.equal(out.protocol.commitment, null); assert.equal(out.status, 'agreement_pending');
  assert.equal(w.seller.agent.stageOf(jobId), 'proposed', 'the seller signed and anchored no commitment');
  const direct = await post(`${w.seller.origin}/dacs/v1/commitments`, { jobId });
  assert.equal(direct.error, 'agreement_anchor_invalid'); assert.match(direct.message, SELLER_GAP);
  // Witness for the cause: the node's executed content is wire-normalized, so it
  // no longer hashes to the signed hash; only the buyer's retained signed
  // projection (its own journal) does, which a seller does not hold.
  const accepted = w.h.chain.wire.record.accepted[0];
  assert.equal(sha256(JSON.stringify(accepted.content)), accepted.hash, 'the signed projection hashes to the transaction hash');
  const executed = await post(w.h.chain.url, { method: 'nodeCall', params: [{ message: 'getTxByHash', data: { hash: accepted.hash } }] });
  assert.notEqual(sha256(JSON.stringify(executed.response.content)), accepted.hash, 'executed content returned to a third party does not');
  assert.equal(typeof executed.response.content.nonce, 'string');
  // Every hold remains.
  assert.equal(out.protocol.limits.payment, 'held');
  assert.match(out.protocol.limits.commitment, /not read back yet/);
  for (const part of ['challenge', 'handoff']) assert.equal((await post(`${w.h.origin}/portal/api/purchase/${w.id}/${part}`, { token: w.token, address: w.address })).error, 'agreement_payment_held');
  assert.equal((await w.verify()).protocol.stage, 'agreement-anchored');
  assert.equal(w.h.chain.wire.record.broadcastAttempts.length, 1, 'rechecks never re-send');
  assert.equal((await tool(w.h, w.other, 'get_purchase_status', { operationId: w.id })).error, 'not_found');
  t.diagnostic(JSON.stringify({ stage: out.protocol.stage, nativeAddress: p.agreement.anchorReceipt.nativeAddress, sellerCommit: direct.error, reason: direct.message, broadcasts: 1, payment: 'held' }));
});

test('direct consumer: the real native CREATE is rejected by the adapter (gap); another job is absent; an unavailable chain is indeterminate; malformed reader refused', async (t) => {
  const w = await setup(t);
  await w.run();
  const reader = createSellerSr2AgreementAnchor({ rpcUrl: w.h.chain.url });
  const jobId = w.op().terms.protocol.jobId, address = fixedPriceAgreementLogicalAddress(jobId), buyer = w.op().state.protocol.buyerBundle.presentedBy;
  const read = await reader.readAgreement({ logicalAddress: address, writer: buyer });
  assert.equal(read.disposition, 'rejected'); assert.match(read.reason, SELLER_GAP);
  assert.equal((await reader.readAgreement({ logicalAddress: fixedPriceAgreementLogicalAddress('01M45JZZZZZZZZZZZZZZZZZZZZ'), writer: buyer })).disposition, 'absent');
  w.h.chain.faults.unavailable = true;
  const unavailable = await reader.readAgreement({ logicalAddress: address, writer: buyer });
  w.h.chain.faults.unavailable = false;
  assert.equal(unavailable.disposition, 'indeterminate', JSON.stringify(unavailable));
  assert.throws(() => createSellerSr2AgreementAnchor({ reader: { read: () => null } }), /read and verifyReceipt/);
});

test('boundary: an unavailable chain during the seller commit maps to seller substrate_unavailable (HTTP 503), not a refusal; no commitment is signed', async (t) => {
  const w = await setup(t);
  await w.run();
  const jobId = w.op().terms.protocol.jobId;
  w.h.chain.faults.unavailable = true;
  const answer = await post(`${w.seller.origin}/dacs/v1/commitments`, { jobId });
  w.h.chain.faults.unavailable = false;
  assert.equal(answer.httpStatus, 503, JSON.stringify(answer));
  assert.equal(w.seller.agent.stageOf(jobId), 'proposed');
});

test('compatibility witness: the default seller (no SR-2 reader) reads only the fixture write and reports agreement_not_anchored; buyer stays agreement-anchored, payment held', async (t) => {
  const w = await setup(t, { sr2Reader: false });
  const out = await w.run();
  assert.equal(out.protocol.stage, 'agreement-anchored');
  const refused = w.op().state.protocol.attempts.find((a) => a.step === 'commit-request');
  assert.match(refused.reason, /has not anchored the Agreement/);
  const direct = await post(`${w.seller.origin}/dacs/v1/commitments`, { jobId: w.op().terms.protocol.jobId });
  assert.equal(direct.error, 'agreement_not_anchored');
  assert.equal((await post(`${w.h.origin}/portal/api/purchase/${w.id}/challenge`, { token: w.token, address: w.address })).error, 'agreement_payment_held');
});

test('compatibility: without the buyer capability the Agreement-only profile stops at agreement-anchored and never asks the seller to commit', async (t) => {
  const w = await setup(t, { capability: false });
  assert.equal(Object.hasOwn(w.op().terms.protocol, 'sellerCommitment'), false);
  const out = await w.run();
  assert.equal(out.protocol.stage, 'agreement-anchored');
  assert.equal(out.protocol.limits.commitment, 'awaiting-authenticated-seller-commitment-and-context');
  assert.equal(out.protocol.limits.agreementAnchor, undefined);
  assert.ok(!w.seller.requests.includes('/dacs/v1/commitments'));
  assert.equal((await post(`${w.h.origin}/portal/api/purchase/${w.id}/challenge`, { token: w.token, address: w.address })).error, 'agreement_payment_held');
});

test('capability shape: exact { commitmentSubstrate: "fixture" } or a construction error; malformed capability fails app construction', async () => {
  assert.equal(sellerSr2CommitmentConfig(undefined), null);
  for (const bad of [{}, { commitmentSubstrate: 'demos' }, { commitmentSubstrate: 'fixture', live: true }, 'fixture']) assert.throws(() => sellerSr2CommitmentConfig(bad), /exactly/);
  const memory = memoryAnchorJournal();
  await assert.rejects(startSr2Harness({ journal: { ...memory, entries: () => memory.snapshot() }, sellerSr2Commitment: { commitmentSubstrate: 'demos' } }), /exactly/);
});

test('seller SR-2 Agreement connections stayed loopback', () => assert.deepEqual(externalAttempts, []));
