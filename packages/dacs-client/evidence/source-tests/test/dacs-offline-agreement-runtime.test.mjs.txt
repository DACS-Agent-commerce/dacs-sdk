// Source-aware fixture integration: real MCP/OAuth/portal, pinned SDK seller
// derivation, packaged wallet signing and independent native wire observations.
// Approval callback is a fixture; browser trusted-event evidence is separate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startProtocolHarness, addSeller } from './dacs-loopback-fixture.test.mjs';
import { tool, portal, tokenFrom, linkedUser } from './helpers/flows.mjs';
import { sellerValue } from './helpers/model-report.mjs';
import { startAgreementChain, linkPackagedWallet } from './helpers/offline-agreement-fixture.mjs';
import { memoryAnchorJournal } from './helpers/dacs-storage-anchor-wallet-fixture.mjs';
import { createSdkWalletSession } from '../public/portal/embedded-wallet/sdk-provider.mjs';
import { createDemosSr2WalletBridge } from '../src/dacs/demos-sr2-wallet-bridge.mjs';
import { installLoopbackOnlyGuard, externalAttempts } from './helpers/embedded-wallet-flow-fixtures.mjs';
import { OFFLINE_AGREEMENT_PROFILE } from '../src/dacs/protocol-purchases.mjs';
import { canonicalize, contentHash, isPayeeBoundAgreementDocument } from '@kynesyslabs/dacs';
import { verifyComponent } from '../src/dacs/listing.mjs';

installLoopbackOnlyGuard();
globalThis.window ??= globalThis;
globalThis.document ??= { baseURI: 'http://127.0.0.1/portal/assets/embedded-wallet/', currentScript: null };
globalThis.location ??= new URL('http://127.0.0.1/portal/assets/embedded-wallet/index.html');
const { Demos, Identities, validateMnemonic } = await import('../public/portal/embedded-wallet/demos-runtime.mjs');
const claim = (address) => `did:demos:agent:${address.slice(2)}`;
const mode = 'dacs-sr2-wallet-agreement';
const isStorageApproval = (request) => request.method === 'sendTransaction' && request.content?.kind === 'dacs-storage-anchor-create';
let counter = 0;

async function setup(t, { approveCreate = true, wrongBridgeWallet = false } = {}) {
  const chain = await startAgreementChain();
  const memory = memoryAnchorJournal();
  const journal = { ...memory, entries: () => memory.snapshot() };
  const approvals = [];
  let wallet, anchorJournal;
  const walletFactory = (options) => {
    anchorJournal = options.anchorJournal;
    return { request: (r) => wallet.request(r), getPublicAccount: () => wallet.getPublicAccount(), getWriteProfile: () => wallet.getWriteProfile() };
  };
  const h = await startProtocolHarness({ chain, env: { DACS_EMBEDDED_WALLET_WRITES: 'simulated-loopback' },
    walletAgreement: { rpcUrl: chain.url, network: 'demos-testnet', journal, walletFactory } });
  t.after(() => h.close());
  wallet = createSdkWalletSession({ DemosCtor: Demos, IdentitiesCtor: Identities, validateMnemonic, anchorJournal,
    transactionTransport: { profile: 'simulated-loopback', network: h.config.chain.network, rpcUrl: `${h.origin}/portal/api/wallet-rpc` },
    approve: async (request) => { approvals.push(structuredClone(request)); return isStorageApproval(request) ? approveCreate : true; } });
  await wallet.create();
  t.after(() => wallet.lock());
  const user = wrongBridgeWallet ? await linkedUser(h) : await linkPackagedWallet(h, wallet);
  const seller = await addSeller(h, { listingId: `offline-agreement-${++counter}` });
  const p = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `offline-agreement-key-${counter}`, protocol: mode });
  assert.equal(p.status, 'agreement_pending', JSON.stringify(p));
  const accountId = h.app.services.accounts.walletOwner(wrongBridgeWallet ? user.wallet.address : wallet.getPublicAccount().address);
  return { h, chain, wallet, user, seller, p, accountId, journal, approvals, token: tokenFrom(p.approvalUrl) };
}
async function sign(w, message) {
  const answer = await w.wallet.request({ method: 'sign', params: [message] });
  assert.equal(answer.success, true, JSON.stringify(answer.error));
  return answer.data.signature;
}
async function plan(w, { walletAddress = w.wallet.getPublicAccount().address, signWith } = {}) {
  const identity = await portal(w.h, `/portal/api/purchase/${w.p.operationId}/agreement/identity`, { token: w.token, address: walletAddress });
  assert.equal(identity.error, undefined, JSON.stringify(identity));
  const signature = signWith ? signWith(identity.signRequest.message) : await sign(w, identity.signRequest.message);
  const out = await portal(w.h, `/portal/api/purchase/${w.p.operationId}/agreement/plan`, { token: w.token, signature });
  assert.equal(out.error, undefined, JSON.stringify(out));
  return out;
}
async function submit(w, planned, signature) {
  return portal(w.h, `/portal/api/purchase/${w.p.operationId}/agreement/sign`, { token: w.token,
    agreementSignature: signature ?? await sign(w, planned.signRequest.agreementMessage) });
}

test('real MCP/OAuth/portal Agreement anchors unchanged SDK two-party bytes through packaged wallet CREATE and fresh owner-bound readback', async (t) => {
  const w = await setup(t);
  const planned = await plan(w);
  assert.equal(planned.signRequest.anchorMessage, null);
  assert.equal(planned.signRequest.anchorKind, 'dacs-storage-anchor-create');
  assert.equal(planned.signRequest.payment, 'held');
  const out = await submit(w, planned);
  assert.equal(out.status, 'agreement_pending', JSON.stringify(out));
  const pv = out.evidence.protocol;
  assert.equal(pv.profile, OFFLINE_AGREEMENT_PROFILE);
  assert.equal(pv.stage, 'agreement-anchored', JSON.stringify(pv.lastAttempt));
  assert.equal(pv.storageGap, undefined);
  assert.equal(pv.lastAttempt.outcome, 'anchored');
  assert.equal(pv.agreement.hash, planned.signRequest.agreementHash);
  const retained = w.h.app.services.ops.get(w.accountId, w.p.operationId).state.protocol.walletAnchor;
  assert.equal(isPayeeBoundAgreementDocument(retained.artifact), true);
  assert.equal(retained.artifact.payeeBoundAgreementVersion, '1');
  assert.equal(Object.hasOwn(retained.artifact, 'artifactType'), false);
  assert.equal(contentHash(retained.artifact), planned.signRequest.agreementHash);
  assert.equal(retained.writer, claim(w.wallet.getPublicAccount().address));
  assert.equal(retained.artifactKind, 'Agreement');
  assert.equal(retained.jobId, pv.jobId);
  assert.equal(retained.artifact.jobId, pv.jobId);
  assert.equal(retained.logicalAddress, `dacs3:agreement:${pv.jobId}`);
  assert.equal(retained.receiptContentHash, planned.signRequest.agreementHash);
  assert.equal(retained.artifact.parties.find((p) => p.role === 'seller').primaryClaim, w.seller.wallet.claim);
  assert.notEqual(retained.writer, w.seller.wallet.claim);
  assert.equal(retained.artifact.signatures.length, 2);
  for (const signature of retained.artifact.signatures) assert.equal(verifyComponent({ signedBytes: new TextEncoder().encode(planned.signRequest.agreementMessage), signature: { algorithm: signature.algorithm, signer: signature.party, value: signature.value } }), true);
  const bridge = createDemosSr2WalletBridge({ rpcUrl: w.chain.url, network: w.h.config.chain.network, journal: w.journal, walletFactory: () => w.wallet });
  const read = await bridge.read(retained.logicalAddress, { expectedWriter: retained.writer, expectedArtifactKind: 'Agreement' });
  assert.equal(read.status, 'present');
  assert.equal(canonicalize(read.artifact), canonicalize(retained.artifact));
  assert.equal(await bridge.verifyReceipt({ receipt: pv.agreement.anchorReceipt, logicalAddress: retained.logicalAddress, artifact: retained.artifact, expectedWriter: retained.writer, artifactKind: 'Agreement' }), 'valid');
  assert.equal(await bridge.verifyReceipt({ receipt: pv.agreement.anchorReceipt, logicalAddress: retained.logicalAddress, artifact: retained.artifact, expectedWriter: retained.writer, artifactKind: 'Listing' }), 'invalid');
  assert.notEqual(contentHash({ ...retained.artifact, artifactType: 'Agreement' }), planned.signRequest.agreementHash, 'adding a bridge discriminator would change the signed content hash');
  const tx = w.chain.wire.record.accepted[0];
  assert.equal(tx.content.from, w.wallet.getPublicAccount().address);
  assert.equal(tx.content.type, 'storageProgram');
  assert.equal(tx.content.data[1].operation, 'CREATE_STORAGE_PROGRAM');
  assert.equal(tx.content.data[1].metadata.artifactKind, 'Agreement');
  assert.equal(tx.content.data[1].metadata.logicalAddress, retained.logicalAddress);
  assert.equal(canonicalize(tx.content.data[1].data), canonicalize(retained.artifact));
  assert.equal(tx.signature.type, 'ed25519');
  const approval = w.approvals.find(isStorageApproval);
  assert.equal(approval.content.exactStorageBytes, canonicalize(retained.artifact));
  assert.equal(approval.content.artifactKind, 'Agreement');
  assert.equal(approval.content.jobId, pv.jobId);
  assert.equal(approval.content.debit.totalOs, '7000000000', 'simulated storage+signature+network+RPC debit, not Agreement payment');
  t.diagnostic(JSON.stringify({ shape: 'payeeBoundAgreementVersion:1;artifactType absent', signedContentHash: contentHash(retained.artifact), signatures: retained.artifact.signatures, exactBytes: canonicalize(retained.artifact).length, stage: pv.stage, nativeAddress: pv.agreement.nativeAddress, broadcasts: 1 }));
  assert.equal(pv.limits.payment, 'held');
  assert.equal(pv.limits.vet, 'not-performed');
  assert.match(pv.limits.finality, /no-real-consensus/);
  assert.deepEqual(pv.layers, { transfer: 'not-observed', dacsPurchase: 'not-evidenced', service: 'not-delivered', completedCopies: 'not-exchanged', humanAcceptance: 'not-recorded' });
  assert.equal(w.chain.wire.record.accepted.length, 1);
  assert.equal(w.approvals.filter(isStorageApproval).length, 1);
  assert.equal(w.journal.snapshot().length, 2, 'retained SDK adapter plan and approved signed wallet lane');
  assert.equal(w.seller.state.requests.includes('/dacs/v1/commitments'), false);
  assert.equal(w.seller.state.requests.includes('/dacs/v1/payments'), false);
  assert.equal(w.h.app.services.coordinates.get(w.p.operationId), null);
  const replay = await tool(w.h, w.user, 'verify_deal', { operationId: w.p.operationId });
  assert.equal(replay.protocol.stage, 'agreement-anchored');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1, 'replay only reads the one CREATE');
  assert.equal(w.approvals.filter(isStorageApproval).length, 1);
});

test('unknown after applying the real Agreement stays indeterminate; unavailable then valid recheck only observes and never resends', async (t) => {
  const w = await setup(t);
  const planned = await plan(w);
  w.chain.wire.faults.dropAfterApply = true;
  const pending = await submit(w, planned);
  assert.equal(pending.evidence.protocol.stage, 'agreement-signing');
  assert.equal(pending.evidence.protocol.lastAttempt.outcome, 'indeterminate');
  assert.match(pending.evidence.protocol.lastAttempt.reason, /outcome_unknown/);
  assert.equal(pending.evidence.protocol.agreement, null);
  assert.equal(w.chain.wire.record.accepted.length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  const before = w.approvals.length;
  w.chain.wire.faults.dropAfterApply = false;
  w.chain.faults.unavailable = true;
  const unavailable = await tool(w.h, w.user, 'verify_deal', { operationId: w.p.operationId });
  assert.equal(unavailable.protocol.stage, 'agreement-signing');
  assert.equal(unavailable.protocol.lastAttempt.outcome, 'indeterminate');
  assert.equal(w.approvals.length, before);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  w.chain.faults.unavailable = false;
  const resumed = await tool(w.h, w.user, 'verify_deal', { operationId: w.p.operationId });
  assert.equal(resumed.protocol.stage, 'agreement-anchored', JSON.stringify(resumed));
  assert.equal(resumed.protocol.lastAttempt.outcome, 'anchored');
  assert.equal(w.approvals.length, before);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  const concurrent = await Promise.all([tool(w.h, w.user, 'verify_deal', { operationId: w.p.operationId }), tool(w.h, w.user, 'verify_deal', { operationId: w.p.operationId })]);
  assert.ok(concurrent.every((x) => x.protocol.stage === 'agreement-anchored'));
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal(w.approvals.length, before);
});

test('wrong connected wallet and wrong buyer signature refuse before CREATE', async (t) => {
  const w = await setup(t);
  const other = await linkedUser(w.h);
  const wrong = await portal(w.h, `/portal/api/purchase/${w.p.operationId}/agreement/identity`, { token: w.token, address: other.wallet.address });
  assert.equal(wrong.error, 'wrong_wallet');
  const planned = await plan(w);
  const forged = await submit(w, planned, other.wallet.signHex(planned.signRequest.agreementMessage));
  assert.equal(forged.error, 'bad_signature');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('a separately valid buyer signature cannot authorize another injected bridge wallet to own CREATE', async (t) => {
  const w = await setup(t, { wrongBridgeWallet: true });
  const planned = await plan(w, { walletAddress: w.user.wallet.address, signWith: (m) => w.user.wallet.signHex(m) });
  const out = await submit(w, planned, w.user.wallet.signHex(planned.signRequest.agreementMessage));
  assert.equal(out.evidence.protocol.stage, 'agreement-rejected');
  assert.equal(out.evidence.protocol.lastAttempt.outcome, 'rejected');
  assert.match(out.evidence.protocol.lastAttempt.reason, /wrong-writer/);
  assert.equal(w.approvals.filter(isStorageApproval).length, 0);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

for (const field of ['owner', 'logicalAddress', 'contentHash', 'artifactKind', 'jobId', 'receiptContentHash']) test(`retained intent ${field} mismatch refuses reconciliation before wallet access or any new send`, async (t) => {
  const w = await setup(t);
  const planned = await plan(w);
  w.chain.wire.faults.dropAfterApply = true;
  await submit(w, planned);
  const operation = w.h.app.services.ops.get(w.accountId, w.p.operationId);
  const protocol = operation.state.protocol;
  if (field === 'owner') protocol.walletAnchor.writer = w.seller.wallet.claim;
  if (field === 'logicalAddress') protocol.walletAnchor.logicalAddress = 'dacs3:agreement:another-scope';
  if (field === 'contentHash') protocol.walletAnchor.artifact.terms.price.amount = '2.6';
  if (field === 'artifactKind') protocol.walletAnchor.artifactKind = 'Listing';
  if (field === 'jobId') protocol.walletAnchor.jobId = 'another-job';
  if (field === 'receiptContentHash') protocol.walletAnchor.receiptContentHash = 'f'.repeat(64);
  protocol.stage = 'agreement-signing';
  w.h.app.services.ops.transition(w.p.operationId, 'agreement_pending', 'agreement_pending', { state: { protocol }, event: 'test-only-scope-corruption' });
  const out = await tool(w.h, w.user, 'verify_deal', { operationId: w.p.operationId });
  assert.equal(out.protocol.stage, 'agreement-rejected');
  assert.match(sellerValue(out.protocol.lastAttempt.reason), /retained wallet CREATE owner or Agreement scope changed/);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1, 'the unknown original CREATE is not repeated');
  assert.equal(w.approvals.filter(isStorageApproval).length, 1);
});

test('retained Agreement signature corruption is rejected even though SDK signed-scope contentHash is unchanged', async (t) => {
  const w = await setup(t);
  const planned = await plan(w);
  w.chain.wire.faults.dropAfterApply = true;
  await submit(w, planned);
  const operation = w.h.app.services.ops.get(w.accountId, w.p.operationId);
  const protocol = operation.state.protocol;
  const originalHash = contentHash(protocol.walletAnchor.artifact);
  const signature = protocol.walletAnchor.artifact.signatures[0];
  signature.value = `${signature.value[0] === 'A' ? 'B' : 'A'}${signature.value.slice(1)}`;
  assert.equal(contentHash(protocol.walletAnchor.artifact), originalHash);
  w.h.app.services.ops.transition(w.p.operationId, 'agreement_pending', 'agreement_pending', { state: { protocol }, event: 'test-only-signature-corruption' });
  const out = await tool(w.h, w.user, 'verify_deal', { operationId: w.p.operationId });
  assert.equal(out.protocol.stage, 'agreement-rejected');
  assert.match(sellerValue(out.protocol.lastAttempt.reason), /invalid: Agreement signatures do not authorize these exact signed bytes/);
  assert.equal(w.approvals.filter(isStorageApproval).length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
});

test('no explicit atomic journal cannot construct this profile', () => {
  assert.throws(() => createDemosSr2WalletBridge({ rpcUrl: 'http://127.0.0.1:1', network: 'demos-testnet', walletFactory: () => ({}) }), (e) => e.code === 'journal-required');
});

test('profile unavailable without wallet capability, even while legacy fixture mode remains configured', async (t) => {
  const h = await startProtocolHarness(); t.after(() => h.close());
  const user = await linkedUser(h), seller = await addSeller(h, { listingId: `missing-wallet-${++counter}` });
  const out = await tool(h, user, 'prepare_purchase', { listingId: seller.listing.listingId, version: 1, seller: seller.wallet.claim, idempotencyKey: `missing-wallet-${counter}`, protocol: mode });
  assert.equal(out.error, 'dacs_protocol_unavailable');
});

test('payment-held guards cover portal approval/handoff/report, MCP hash import, and direct completion/claim entry points', async (t) => {
  const w = await setup(t);
  const planned = await plan(w); await submit(w, planned);
  for (const [path, extra] of [['challenge', { address: w.wallet.getPublicAccount().address }], ['approve', { challengeId: 'unused', signature: '' }], ['handoff', {}], ['report', { txHash: 'f'.repeat(64) }]]) {
    const out = await portal(w.h, `/portal/api/purchase/${w.p.operationId}/${path}`, { token: w.token, ...extra });
    assert.equal(out.error, 'agreement_payment_held', path);
  }
  const imported = await tool(w.h, w.user, 'verify_deal', { operationId: w.p.operationId, txHash: 'f'.repeat(64) });
  assert.equal(imported.error, 'agreement_payment_held');
  const operation = w.h.app.services.ops.get(w.accountId, w.p.operationId);
  const protocol = w.h.app.services.protocol;
  await assert.rejects(protocol.recheckCommitment(operation), (e) => e.code === 'agreement_payment_held');
  await assert.rejects(protocol.advance(operation, {}), (e) => e.code === 'agreement_payment_held');
  assert.throws(() => protocol.countersignRequest(operation), (e) => e.code === 'agreement_payment_held');
  await assert.rejects(protocol.countersign(operation, {}), (e) => e.code === 'agreement_payment_held');
  assert.equal(w.h.app.services.coordinates.get(w.p.operationId), null);
  assert.equal(w.chain.wire.record.accepted.length, 1, 'Agreement storage is allowed, but no payment or completion follows');
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 1);
  assert.equal(w.seller.state.requests.includes('/dacs/v1/payments'), false);
  assert.equal(w.seller.state.requests.includes('/dacs/v1/commitments'), false);
});

test('repeatable guard witness: skipped purchase status cannot turn the Agreement profile into a payment handoff', async (t) => {
  const w = await setup(t);
  // Independently known forbidden effect: a mode that owns only Agreement
  // storage must reject payment even if a faulty caller changes its status.
  w.h.app.services.ops.transition(w.p.operationId, 'agreement_pending', 'awaiting_approval', { event: 'test-only-wrong-status' });
  const out = await portal(w.h, `/portal/api/purchase/${w.p.operationId}/challenge`, { token: w.token, address: w.wallet.getPublicAccount().address });
  assert.equal(out.error, 'agreement_payment_held');
  assert.equal(w.h.app.services.coordinates.get(w.p.operationId), null);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
});

test('private owner scope stays enforced and rejected storage approval creates no receipt or broadcast', async (t) => {
  const w = await setup(t, { approveCreate: false });
  const outsider = await linkedUser(w.h);
  const privateStatus = await tool(w.h, outsider, 'get_purchase_status', { operationId: w.p.operationId });
  assert.equal(privateStatus.error, 'not_found');
  const planned = await plan(w);
  const out = await submit(w, planned);
  assert.equal(out.evidence.protocol.stage, 'agreement-rejected');
  assert.match(out.evidence.protocol.lastAttempt.reason, /user_rejected/);
  assert.equal(w.approvals.filter(isStorageApproval).length, 1);
  assert.equal(w.chain.wire.record.broadcastAttempts.length, 0);
  assert.equal(out.evidence.protocol.agreement, null);
});

test('all network attempts in this runtime contract remain loopback', () => assert.equal(externalAttempts.length, 0));
