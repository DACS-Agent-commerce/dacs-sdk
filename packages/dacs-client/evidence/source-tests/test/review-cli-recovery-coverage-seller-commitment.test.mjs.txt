// Exact-current coverage of the seller native FinalityCommitmentRecord fresh
// readback (sameNativeCommitmentReceipt) through the actual createSellerAgent
// commit and reconcileTransport entry points. NODE-only, offline, in-memory:
// test-owned ephemeral Ed25519 keys, a scripted native artifact capability and
// a scripted native Agreement reader. No socket, wallet, RPC, TLS or chain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalize, contentHash, generateCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { createSellerAgent } from '../src/dacs/seller-agent.mjs';
import { createSellerDurableState } from '../src/dacs/seller-durable-state.mjs';
import { buildUnsignedIdentityBundle, attachIdentityPresentation } from '../src/dacs/listing.mjs';
import { planAgreement, exchangeAgreement, listingPin } from '../src/dacs/purchase-protocol.mjs';
import { createEphemeralWallet } from './fixtures/wallet.mjs';
import { fixtureListing } from './fixtures/listings.mjs';

const clone = (value) => JSON.parse(JSON.stringify(value));
const TX = 'a1'.repeat(32), BLOCK = 'b2'.repeat(32);

async function world(t) {
  const directory = mkdtempSync(join(tmpdir(), 'review-cli-recovery-commit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const seller = createEphemeralWallet(), buyer = createEphemeralWallet(), clock = Date.now();
  const listing = fixtureListing(seller, { listingId: 'cli-recovery-commit', price: '1', now: clock });
  const durableDirectory = join(directory, 'seller');
  const effects = { publish: 0, readRetained: 0, verify: 0, agreementReads: 0 };
  // Scripted native capability. `stored` is the one applied CREATE; `view`
  // may rewrite only the fresh observation returned by readRetained.
  const native = { stored: null, view: (value) => value, verdict: 'valid', status: null };
  const nativeArtifactAnchor = {
    writer: seller.claim,
    publish: async ({ logicalAddress, artifact, artifactKind }) => {
      effects.publish++;
      assert.equal(artifactKind, 'FinalityCommitmentRecord');
      const receipt = { receiptVersion: '1', substrate: 'TEST-offline-demos-sr2', finalityProfile: 'TEST-one-node-not-finality', logicalAddress,
        nativeAddress: `TEST-native-${sha256Hex(logicalAddress).slice(0, 16)}`, contentHash: contentHash(artifact), transactionRef: { kind: 'demos-tx', value: TX },
        writer: seller.claim, nonce: '7', state: 'finalized', observationDisposition: 'established', observedAt: clock + 1000,
        evidence: { kind: 'demos-tx', value: TX }, blockRef: { id: BLOCK, height: '9', timestamp: clock + 1000 } };
      native.stored = { artifact: clone(artifact), receipt, txRef: { kind: 'demos', txHash: TX, blockNumber: 9 }, signedProjection: { TEST: 'public signed projection' } };
      return { status: 'present', ...clone(native.stored) };
    },
    readRetained: async ({ artifactKind }) => {
      effects.readRetained++;
      assert.equal(artifactKind, 'FinalityCommitmentRecord');
      if (native.status) return { status: native.status, reason: `TEST ${native.status} readback` };
      if (!native.stored) return { status: 'absent', reason: 'TEST no CREATE' };
      return { status: 'present', ...native.view(clone(native.stored)) };
    },
    verifyReceipt: async () => { effects.verify++; return native.verdict; },
  };
  let agreement = null;
  const agreementAnchor = {
    source: 'TEST-offline-native-agreement',
    readAgreement: async ({ logicalAddress, writer, agreementHash }) => {
      effects.agreementReads++;
      if (!agreement || writer !== buyer.claim || contentHash(agreement) !== agreementHash) return { disposition: 'absent', reason: 'TEST no Agreement' };
      return { disposition: 'present', artifact: clone(agreement), ref: { anchor: { kind: 'storage-program', locator: logicalAddress }, contentHash: agreementHash },
        native: { source: 'TEST-offline-native-agreement', evidenceMode: 'TEST-scripted', nativeAddress: 'TEST-native-agreement', txRef: { kind: 'demos', txHash: 'c3'.repeat(32), blockNumber: 8 } } };
    },
  };
  const refusedAnchors = { read: async () => { throw new Error('TEST fixture substrate is not used'); }, write: async () => { throw new Error('TEST fixture substrate write forbidden'); } };
  const build = () => createSellerAgent({ signer: { claim: seller.claim, sign: (bytes) => seller.signBytes(bytes) }, listing, anchors: refusedAnchors,
    observeDemosTransfer: async () => ({ status: 'unavailable', reason: 'TEST payment not in scope' }), durableDirectory, agreementAnchor,
    nativeArtifactAnchor, deliverableProducer: () => { throw new Error('TEST delivery not in scope'); } });
  let agent = await build();
  t.after(() => agent?.close());
  const jobId = generateCanonicalJobId();
  const unsigned = buildUnsignedIdentityBundle({ address: buyer.address, presentedAt: clock, sessionSeed: 'review-cli-recovery-buyer' });
  const buyerBundle = attachIdentityPresentation(unsigned, buyer.signHex(unsigned.message));
  const planned = planAgreement({ jobId, listing, buyerBundle, generatedAt: clock });
  // The buyer-side SDK coordinator runs to the anchor seam; its finalized
  // Agreement artifact is captured in memory (no fixture write).
  await exchangeAgreement({ plan: planned.plan, draft: planned.draft, buyerClaim: buyer.claim, buyerBundle,
    agreementSignature: buyer.signHex(planned.agreementMessage), anchorSignature: buyer.signHex(planned.anchorMessage),
    seller: { propose: (input) => agent.receiveProposal(input), agreementState: (identity) => agent.agreementState(identity) }, anchors: refusedAnchors,
    anchorAdapter: {
      anchorAgreement: async (input) => { agreement = clone(input.artifact); return { disposition: 'submitted' }; },
      reconcileAgreementAnchor: async () => (agreement ? { disposition: 'indeterminate', reason: 'TEST capture only' } : { disposition: 'absent', reason: 'TEST not yet captured' }),
      verifyAnchorReceipt: () => 'indeterminate',
    } });
  assert.ok(agreement, 'actual SDK exchange produced the finalized two-party Agreement');
  assert.equal(contentHash(agreement), planned.plan.agreementHash);
  const retained = async () => { agent.close(); const state = await createSellerDurableState({ dir: durableDirectory, signer: { claim: seller.claim, sign: (bytes) => seller.signBytes(bytes) }, listingPin: listingPin(listing) });
    try { return clone(state.loadSession(jobId)); } finally { state.close(); agent = await build(); } };
  const restart = async () => { agent.close(); agent = await build(); };
  const transport = (path = '/dacs/v1/commitments') => { const body = { jobId }, rawBody = Buffer.from(JSON.stringify(body));
    return { request: { method: 'POST', path, jobId, seller: seller.claim, buyer: buyer.claim, listingPin: agent.listingPin, agreementHash: planned.plan.agreementHash, bodyHash: sha256Hex(rawBody) }, body, rawBody }; };
  return { get agent() { return agent; }, jobId, native, effects, retained, restart, transport, clock };
}

const expectCode = async (promise, code) => { const error = await promise.then(() => null, (e) => e); assert.ok(error, `expected ${code}`); assert.equal(error.code, code, String(error?.message)); return error; };

test('native commitment: timestamp-only normalization resumes with the retained original receipt/phase bytes and no new CREATE', async (t) => {
  const w = await world(t);
  const first = await w.agent.commit({ jobId: w.jobId });
  assert.equal(first.status, 'committed'); assert.equal(first.resumed, false); assert.equal(w.effects.publish, 1);
  const before = await w.retained();
  assert.equal(before.commitment.anchorReceipt.blockRef.timestamp, w.clock + 1000);
  assert.equal(before.phaseResults[1].invokedAt, w.clock + 1000, 'native receipt time is the phase time');
  await w.restart();
  // A fresh observer normalizes only the block/observation timestamps.
  w.native.view = (value) => { value.receipt.blockRef.timestamp = w.clock + 4321; value.receipt.observedAt = w.clock + 9999; return value; };
  const resumed = await w.agent.commit({ jobId: w.jobId });
  assert.equal(resumed.status, 'committed'); assert.equal(resumed.resumed, true); assert.equal(w.effects.publish, 1);
  const after = await w.retained();
  assert.equal(canonicalize(after.commitment), canonicalize(before.commitment), 'retained SDK commitment bytes are unchanged');
  assert.equal(canonicalize(after.phaseResults), canonicalize(before.phaseResults), 'phase history is not rewritten');
  // reconcileTransport (uncertain /commitments) is read-only and agrees.
  const reduced = await w.agent.reconcileTransport(w.transport());
  assert.equal(reduced.disposition, 'present', JSON.stringify(reduced)); assert.equal(reduced.value.resumed, true);
  assert.equal(w.effects.publish, 1);
});

const changes = {
  'different block id': (v) => { v.receipt.blockRef.id = 'd4'.repeat(32); },
  'different block height': (v) => { v.receipt.blockRef.height = '10'; },
  'different receipt transactionRef only': (v) => { v.receipt.transactionRef.value = 'e5'.repeat(32); },
  'different anchorTxRef only': (v) => { v.txRef.txHash = 'e5'.repeat(32); },
  'different receipt writer': (v) => { v.receipt.writer = 'did:demos:agent:' + 'f6'.repeat(32); },
  'different receipt nonce': (v) => { v.receipt.nonce = '8'; },
  'different native address': (v) => { v.receipt.nativeAddress = 'TEST-native-other'; },
  'different substrate/finality profile': (v) => { v.receipt.finalityProfile = 'TEST-other-profile'; },
};
for (const [label, change] of Object.entries(changes)) {
  test(`native commitment HOLD (commitment_changed): ${label}; no new CREATE, retained bytes unchanged`, async (t) => {
    const w = await world(t);
    await w.agent.commit({ jobId: w.jobId });
    const before = await w.retained();
    w.native.view = (value) => { change(value); return value; };
    await expectCode(w.agent.commit({ jobId: w.jobId }), 'commitment_changed');
    assert.equal(w.effects.publish, 1);
    assert.equal(canonicalize((await w.retained()).commitment), canonicalize(before.commitment));
  });
}

const sdkRejects = {
  'malformed string timestamp': (v) => { v.receipt.blockRef.timestamp = String(v.receipt.blockRef.timestamp); },
  'non-safe timestamp': (v) => { v.receipt.blockRef.timestamp = 2 ** 53; },
  'negative timestamp': (v) => { v.receipt.blockRef.timestamp = -1; },
  'missing block ref': (v) => { delete v.receipt.blockRef; },
  'wrong content hash': (v) => { v.receipt.contentHash = '0'.repeat(64); },
  'wrong record content (tampered signature)': (v) => { v.artifact.signature.value = Buffer.alloc(64).toString('base64url'); },
  'not finalized state': (v) => { v.receipt.state = 'included'; },
};
for (const [label, change] of Object.entries(sdkRejects)) {
  test(`native commitment HOLD (SDK gate, commitment_failed): ${label}; sameNativeCommitmentReceipt guard subsumed`, async (t) => {
    const w = await world(t);
    await w.agent.commit({ jobId: w.jobId });
    w.native.view = (value) => { change(value); return value; };
    await expectCode(w.agent.commit({ jobId: w.jobId }), 'commitment_failed');
    assert.equal(w.effects.publish, 1);
    const held = await w.agent.reconcileTransport(w.transport());
    assert.notEqual(held.disposition, 'present'); assert.equal(w.effects.publish, 1);
  });
}

for (const [label, setup] of Object.entries({
  'indeterminate readback': (w) => { w.native.status = 'indeterminate'; },
  'rejected readback': (w) => { w.native.status = 'rejected'; },
  'receipt proof invalid': (w) => { w.native.verdict = 'invalid'; },
  'receipt proof indeterminate': (w) => { w.native.verdict = 'indeterminate'; },
})) {
  test(`native commitment HOLD: ${label}; commit fails closed and uncertain transport stays held without CREATE`, async (t) => {
    const w = await world(t);
    await w.agent.commit({ jobId: w.jobId });
    setup(w);
    await expectCode(w.agent.commit({ jobId: w.jobId }), 'commitment_failed');
    const held = await w.agent.reconcileTransport(w.transport());
    assert.equal(held.disposition, 'indeterminate'); assert.equal(w.effects.publish, 1);
  });
}

test('native commitment absent on fresh readback: transport and direct retry hold without another CREATE', async (t) => {
  const w = await world(t);
  await w.agent.commit({ jobId: w.jobId });
  assert.equal(w.effects.publish, 1);
  const before = await w.retained();
  w.native.stored = null;
  const held = await w.agent.reconcileTransport(w.transport());
  assert.equal(held.disposition, 'indeterminate'); assert.equal(w.effects.publish, 1, 'read-only reducer never publishes');
  await expectCode(w.agent.commit({ jobId: w.jobId }), 'commitment_failed');
  assert.equal(w.effects.publish, 1, 'retained native commitment retry is readback-only');
  assert.equal(w.native.stored, null, 'retry did not replace the absent native observation');
  const after = await w.retained();
  assert.equal(canonicalize(after.commitment), canonicalize(before.commitment), 'retained finalized commitment is unchanged');
  assert.equal(canonicalize(after.phaseResults), canonicalize(before.phaseResults), 'retained phase history is unchanged');
});

for (const [label, change] of Object.entries({
  'different immutable block id': (value) => { value.receipt.blockRef.id = 'd4'.repeat(32); },
  'different receipt transactionRef': (value) => { value.receipt.transactionRef.value = 'e5'.repeat(32); },
  'different anchorTxRef': (value) => { value.txRef.txHash = 'e5'.repeat(32); },
  'different receipt writer': (value) => { value.receipt.writer = 'did:demos:agent:' + 'f6'.repeat(32); },
  'different receipt content hash': (value) => { value.receipt.contentHash = '0'.repeat(64); },
  'different signed record': (value) => { value.artifact.signature.value = Buffer.alloc(64).toString('base64url'); },
})) {
  test(`native commitment: uncertain transport holds same record at ${label}`, async (t) => {
    const w = await world(t);
    await w.agent.commit({ jobId: w.jobId });
    const before = await w.retained();
    w.native.view = (value) => { change(value); return value; };
    const reduced = await w.agent.reconcileTransport(w.transport());
    assert.equal(reduced.disposition, 'indeterminate', JSON.stringify(reduced));
    assert.equal(w.effects.publish, 1, 'read-only reducer never publishes');
    const after = await w.retained();
    assert.equal(canonicalize(after.commitment), canonicalize(before.commitment), 'retained finalized commitment is unchanged');
    assert.equal(canonicalize(after.phaseResults), canonicalize(before.phaseResults), 'retained phase history is unchanged');
  });
}

test('native commitment: receipt evidence/observedAt are outside the stable set (characterization)', async (t) => {
  const w = await world(t);
  await w.agent.commit({ jobId: w.jobId });
  w.native.view = (value) => { value.receipt.evidence = { kind: 'demos-tx', value: 'e5'.repeat(32) }; value.receipt.replacementTransactionRef = { kind: 'demos-tx', value: 'e5'.repeat(32) }; return value; };
  const resumed = await w.agent.commit({ jobId: w.jobId });
  t.diagnostic(JSON.stringify({ observation: 'evidence/replacementTransactionRef not compared by sameNativeCommitmentReceipt', status: resumed.status }));
  assert.equal(resumed.status, 'committed'); assert.equal(w.effects.publish, 1);
});
