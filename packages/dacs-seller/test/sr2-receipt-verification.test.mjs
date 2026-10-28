import test from 'node:test';
import assert from 'node:assert/strict';
import { attestationBundleHash, canonicalize, contentHash, demosSignedTransactionProofHash,
  demosWriteEvidenceToAnchorReceipt, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { DEMOS_SR2_FIXTURE_RECEIPT } from '../src/dacs/demos-sr2-adapter.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { buyer, NOW, seller } from './helpers/protocol-fixture.mjs';

const DEMOS_BFT_LABELS = { substrate: 'demos', finalityProfile: 'demos-bft-confirmed-native-read', state: 'finalized', evidenceKind: 'demos-bft-write-proof-v1' };
const relabel = (receipt, labels) => ({ ...receipt, substrate: labels.substrate, finalityProfile: labels.finalityProfile,
  state: labels.state, evidence: { kind: labels.evidenceKind, value: receipt.evidence.value } });
const verifyInput = (f, receipt, extra = {}) => ({ receipt, logicalAddress: f.logicalAddress, artifact: f.artifact,
  expectedWriter: seller.claim, artifactKind: f.native.metadata.artifactKind, ...extra });
const read = f => f.adapter.read(f.logicalAddress, { expectedWriter: seller.claim });

// Build the public receipt independently of the reader, with this adapter's
// fixture labels, so a signed false artifact hash still reaches verifyReceipt.
function fixtureReceipt(f) {
  const finalityProof = canonicalize(f.block.validation_data);
  return relabel(demosWriteEvidenceToAnchorReceipt({ logicalAddress: f.logicalAddress, writer: seller.claim,
    contentHash: f.native.metadata.contentHash, evidence: {
      evidenceVersion: '1', chainIdentity: f.block.validation_data.chainIdentity, writer: seller.address,
      logicalName: f.logicalAddress, nativeAddress: f.native.storageAddress, operation: 'create', nonce: 1,
      transactionRef: f.signed.hash, signedTransaction: canonicalize(f.signed), signedTransactionHash: demosSignedTransactionProofHash(f.signed),
      blockNumber: 1, blockHash: f.block.hash, blockTimestamp: NOW, finalityProof, finalityProofHash: sha256Hex(finalityProof),
      nativeRead: { owner: seller.address, programName: f.native.programName, valueHash: sha256Hex(canonicalize(f.artifact)),
        metadataHash: sha256Hex(canonicalize(f.native.metadata)), observedAt: NOW },
    } }), DEMOS_SR2_FIXTURE_RECEIPT);
}

const payload = { report: 'TEST payload', signature: 'TEST payload member', signatures: ['TEST payload member'] };
const component = { report: 'TEST component', signature: 'TEST signature' };
const bundle = { report: 'TEST bundle', signatures: ['TEST signature'], anchoredByRole: { buyer: 'TEST anchor' } };
const KINDS = [
  [undefined, payload, sha256Hex(canonicalize(payload))],
  ['Deliverable', payload, sha256Hex(canonicalize(payload))],
  ['Listing', component, contentHash(component)],
  ['Agreement', { report: 'TEST agreement', signatures: ['TEST signature'] }, contentHash({ report: 'TEST agreement' })],
  ['SettlementEvidence', component, contentHash(component)],
  ['FinalityCommitmentRecord', component, contentHash(component)],
  ['IdentityBundle', { claims: [], presentation: { signature: 'TEST presentation' } }, identityBundleHash({ claims: [] })],
  ...['AttestationBundle', 'FaultAttestationBundle', 'EvidenceBoundFaultAttestationBundle'].map(kind => [kind, bundle, attestationBundleHash(bundle)]),
];

for (const [kind, artifact, hash] of KINDS) {
  const label = kind ?? 'raw JSON';
  const options = { artifact, metadata: { artifactKind: kind, contentHash: hash } };
  test(`${label}: the independent labelled receipt equals the reader's receipt`, async () => {
    const f = readbackFixture(options);
    assert.deepEqual(fixtureReceipt(f), (await read(f)).receipt);
  });
  for (const explicit of [false, true]) test(`${label}: a genuine fixture receipt is valid with the ${explicit ? 'explicit' : 'default'} artifact hash`, async () => {
    const f = readbackFixture(options);
    const { receipt } = await read(f);
    assert.equal(await f.adapter.verifyReceipt(verifyInput(f, receipt, explicit ? { receiptContentHash: hash } : {})), 'valid');
  });
  test(`${label}: a signed CREATE and receipt that agree on a false artifact hash are refused before any read`, async () => {
    const f = readbackFixture({ artifact, metadata: { artifactKind: kind, contentHash: 'b'.repeat(64) } });
    assert.equal(await f.adapter.verifyReceipt(verifyInput(f, fixtureReceipt(f), { receiptContentHash: 'b'.repeat(64) })), 'invalid');
    assert.equal(f.calls.length, 0);
  });
}

test('a fixture receipt relabelled as Demos BFT finality is invalid', async () => {
  const f = readbackFixture(), { receipt } = await read(f);
  assert.equal(await f.adapter.verifyReceipt(verifyInput(f, relabel(receipt, DEMOS_BFT_LABELS))), 'invalid');
});
for (const [field, apply] of [
  ['substrate', r => { r.substrate = DEMOS_BFT_LABELS.substrate; }], ['finalityProfile', r => { r.finalityProfile = DEMOS_BFT_LABELS.finalityProfile; }],
  ['state', r => { r.state = DEMOS_BFT_LABELS.state; }], ['evidence.kind', r => { r.evidence.kind = DEMOS_BFT_LABELS.evidenceKind; }],
]) test(`a fixture receipt with one changed ${field} label is invalid`, async () => {
  const f = readbackFixture(), { receipt } = await read(f); apply(receipt);
  assert.equal(await f.adapter.verifyReceipt(verifyInput(f, receipt)), 'invalid');
});

test('a receipt content hash in another kind scope is refused before any read', async () => {
  const f = readbackFixture({ artifact: component, metadata: { artifactKind: 'Listing', contentHash: contentHash(component) } });
  const { receipt } = await read(f); f.state.calls.length = 0;
  assert.equal(await f.adapter.verifyReceipt(verifyInput(f, receipt, { receiptContentHash: sha256Hex(canonicalize(component)) })), 'invalid');
  assert.equal(f.calls.length, 0);
});
test('a caller artifact kind other than the signed kind is invalid', async () => {
  // Listing and SettlementEvidence share the component hash scope, so only the kind guard differs.
  const f = readbackFixture({ artifact: component, metadata: { artifactKind: 'SettlementEvidence', contentHash: contentHash(component) } });
  const { receipt } = await read(f);
  assert.equal(await f.adapter.verifyReceipt(verifyInput(f, receipt, { artifactKind: 'Listing' })), 'invalid');
});
test('a changed artifact with the same signed content hash is refused before any read', async () => {
  const f = readbackFixture({ artifact: component, metadata: { artifactKind: 'Listing', contentHash: contentHash(component) } });
  const { receipt } = await read(f); f.state.calls.length = 0;
  const changed = { ...component, signature: 'TEST other signature' };
  assert.equal(contentHash(changed), contentHash(component));
  assert.equal(await f.adapter.verifyReceipt(verifyInput(f, receipt, { artifact: changed })), 'invalid');
  assert.equal(f.calls.length, 0);
});

const binding = { agreementHash: 'a'.repeat(64), scope: 'TEST delivery scope' };
for (const [label, signed, expected] of [
  ['a changed', binding, { ...binding, agreementHash: 'b'.repeat(64) }],
  ['an omitted-member', binding, { agreementHash: binding.agreementHash }],
  ['an added-member', binding, { ...binding, extra: 'TEST member' }],
  ['an unsigned', undefined, binding],
]) test(`${label} delivery binding is invalid`, async () => {
  const f = readbackFixture({ metadata: signed ? { deliveryBinding: signed } : {} });
  const { receipt } = await read(f);
  assert.equal(await f.adapter.verifyReceipt(verifyInput(f, receipt, { deliveryBinding: expected })), 'invalid');
});
test('the signed delivery binding is valid', async () => {
  const f = readbackFixture({ metadata: { deliveryBinding: binding } });
  const { receipt } = await read(f);
  assert.equal(await f.adapter.verifyReceipt(verifyInput(f, receipt, { deliveryBinding: structuredClone(binding) })), 'valid');
});

test('the original signed projection verifies a receipt and a projection for another transaction does not', async () => {
  const f = readbackFixture(), { receipt } = await read(f);
  assert.equal(await f.adapter.verifyReceipt(verifyInput(f, receipt, { signedProjection: f.signed })), 'valid');
  assert.equal(await f.adapter.verifyReceipt(verifyInput(f, receipt, { signedProjection: { ...f.signed, hash: 'c'.repeat(64) } })), 'invalid');
});

test('verifyReceipt answers indeterminate when its aggregate read deadline expires', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let hang = false;
  const f = readbackFixture({ respond: () => hang ? new Promise(() => {}) : undefined });
  const { receipt } = await read(f); hang = true;
  const verdict = f.adapter.verifyReceipt(verifyInput(f, receipt));
  t.mock.timers.tick(10001);
  assert.equal(await verdict, 'indeterminate');
});

// recheck and verifyReceipt share one reauthentication, so they must agree.
const recheckVerdict = async (f, receipt, options) => {
  try { await f.adapter.recheck(receipt, options); return 'valid'; }
  catch (error) { assert.match(error.code, /^(invalid|indeterminate)$/); return error.code; }
};
for (const [label, expected, change] of [
  ['genuine', 'valid', () => {}],
  ['relabelled as Demos BFT', 'invalid', (f, r) => relabel(r, DEMOS_BFT_LABELS)],
  ['changed native data', 'invalid', f => { f.native.data.report = 'TEST changed'; }],
  ['reorganized block', 'invalid', f => { f.block.hash = 'b'.repeat(64); }],
  ['changed transaction', 'invalid', (f, r) => ({ ...r, transactionRef: { ...r.transactionRef, value: 'b'.repeat(64) } })],
  ['another writer', 'invalid', (f, r, o) => { o.expectedWriter = buyer.claim; }],
  ['projection for another transaction', 'invalid', (f, r, o) => { o.signedProjection = { ...f.signed, hash: 'c'.repeat(64) }; }],
  ['unavailable node', 'indeterminate', f => { f.unavailable = true; }],
  ['missing native record', 'indeterminate', f => { f.missing = true; }],
]) test(`recheck and verifyReceipt agree on this case: ${label}`, async () => {
  const f = readbackFixture({ respond: url => {
    if (f.unavailable) throw new TypeError('TEST connection refused');
    if (f.missing && new URL(url).pathname.startsWith('/storage-program/')) return new Response('TEST missing', { status: 404, headers: { 'x-dacs-simulation': 'fixture' } });
  } });
  const genuine = (await read(f)).receipt;
  const options = { expectedWriter: seller.claim };
  const receipt = change(f, genuine, options) ?? genuine;
  assert.equal(await recheckVerdict(f, receipt, options), expected);
  assert.equal(await f.adapter.verifyReceipt(verifyInput(f, receipt, options)), expected);
});

test('the adapter exposes only read, recheck and verifyReceipt', () => {
  assert.deepEqual(Object.keys(readbackFixture().adapter).sort(), ['read', 'recheck', 'verifyReceipt']);
});

test('a malformed caller artifact is invalid without throwing', async () => {
  const f = readbackFixture(), { receipt } = await read(f);
  assert.equal(await f.adapter.verifyReceipt(verifyInput(f, receipt, { artifact: undefined })), 'invalid');
});
