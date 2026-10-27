import test from 'node:test';
import assert from 'node:assert/strict';
import { attestationBundleHash, canonicalize, contentHash, decodeDemosAnchorReceiptProof, identityBundleHash, isAnchorReceipt, sha256Hex } from '@kynesyslabs/dacs';
import { DEMOS_SR2_FIXTURE_RECEIPT } from '../src/dacs/demos-sr2-adapter.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { buyer, seller } from './helpers/protocol-fixture.mjs';
const read = f => f.adapter.read(f.logicalAddress, { expectedWriter: f.expectedWriter });
const TWIN = `stor-${'b'.repeat(40)}`;
// Once listed, the writer also owns a conflicting program at the same logical address.
const twinFixture = () => readbackFixture({ respond: (url, init, state) => {
  if (new URL(url).pathname === `/storage-program/${TWIN}`) return new Response(JSON.stringify({ ...state.native, storageAddress: TWIN }), { headers: { 'content-type': 'application/json', 'x-dacs-simulation': 'fixture' } });
} });
const listTwin = f => f.state.rows.push({ programName: f.native.programName, storageAddress: TWIN });

function signArtifact(f, artifact, artifactKind, hash) {
  const op = f.signed.content.data[1];
  op.data = structuredClone(artifact);
  op.metadata = { logicalAddress: f.logicalAddress, contentHash: hash, envelopeHash: sha256Hex(canonicalize(artifact)), ...(artifactKind === undefined ? {} : { artifactKind }) };
  f.signed.hash = sha256Hex(JSON.stringify(f.signed.content));
  f.signed.signature.data = `0x${seller.signBytes(Buffer.from(f.signed.hash)).toString('hex')}`;
  Object.assign(f.tx, structuredClone(f.signed), { status: 'confirmed', blockNumber: 1 });
  f.native.data = structuredClone(artifact); f.native.metadata = structuredClone(op.metadata);
  f.native.createdByTx = f.signed.hash; f.native.interactionTxs = [f.signed.hash];
  f.block.content.ordered_transactions = [f.signed.hash];
}
const payload = { report: 'TEST full payload', signature: 'TEST payload member', signatures: ['TEST payload member'] };
for (const [kind, artifact, hash] of [
  ['Deliverable', payload, sha256Hex(canonicalize(payload))],
  [undefined, payload, sha256Hex(canonicalize(payload))],
  ['Listing', { report: 'TEST signed artifact', signature: 'TEST signature' }, contentHash({ report: 'TEST signed artifact' })],
  ['Agreement', { report: 'TEST signed artifact', signatures: ['TEST signature'] }, contentHash({ report: 'TEST signed artifact' })],
  ['IdentityBundle', { claims: [], presentation: { signature: 'TEST presentation' } }, identityBundleHash({ claims: [] })],
  ...['AttestationBundle', 'FaultAttestationBundle', 'EvidenceBoundFaultAttestationBundle'].map(kind => [kind,
    { report: 'TEST bundle', signatures: ['TEST signature'], anchoredByRole: { buyer: 'TEST anchor' } }, attestationBundleHash({ report: 'TEST bundle' })]),
]) {
  test(`read accepts the artifact-specific digest for ${kind ?? 'raw JSON'}`, async () => {
    const f = readbackFixture(); signArtifact(f, artifact, kind, hash);
    const result = await read(f);
    assert.deepEqual(result.artifact, artifact); assert.equal(result.receipt.contentHash, hash);
    assert.equal((await f.adapter.recheck(result.receipt, { expectedWriter: f.expectedWriter })).status, 'present');
  });
  test(`read refuses a validly signed false artifact digest for ${kind ?? 'raw JSON'}`, async () => {
    const f = readbackFixture(); signArtifact(f, artifact, kind, 'b'.repeat(64));
    await assert.rejects(read(f), error => error.code === 'invalid' && /artifact content hash/.test(error.message));
  });
}
test('Deliverable digest retains signature-named payload fields', async () => {
  const f = readbackFixture(); signArtifact(f, payload, 'Deliverable', contentHash(payload));
  await assert.rejects(read(f), error => error.code === 'invalid' && /artifact content hash/.test(error.message));
});

test('authenticates signed CREATE and freshly rechecks across a journal restart', async () => {
  const f = readbackFixture(), result = await read(f);
  assert.equal(result.status, 'present'); assert.deepEqual(result.artifact, f.artifact);
  assert.equal((await f.adapter.recheck(result.receipt, { expectedWriter: f.expectedWriter })).status, 'present');
  const restarted = readbackFixture({ journal: f.journal });
  assert.equal((await read(restarted)).receipt.transactionRef.value, result.receipt.transactionRef.value);
});
test('an empty name index cannot prove authenticated absence', async () => {
  const f = readbackFixture(); f.state.rows = [];
  await assert.rejects(read(f), error => error.code === 'indeterminate');
});
test('a known signed native address survives stale index visibility', async () => {
  const f = readbackFixture(); f.state.rows = [];
  const result = await f.adapter.read(f.logicalAddress, { expectedWriter: f.expectedWriter, signedProjection: f.signed });
  assert.equal(result.status, 'present'); assert(f.calls.some(c => c.path.startsWith('/storage-program/')));
});
test('receipt recheck survives index disappearance through its known native address', async () => {
  const f = readbackFixture(), result = await read(f); f.state.rows = [];
  assert.equal((await f.adapter.recheck(result.receipt, { expectedWriter: f.expectedWriter })).status, 'present');
});
for (const [label, supplied] of [
  ['signed projection', f => ({ signedProjection: f.signed })], ['native address', f => ({ nativeAddress: f.native.storageAddress })],
]) test(`a supplied ${label} still refuses multiple owned programs`, async () => {
  const f = twinFixture(); listTwin(f);
  await assert.rejects(f.adapter.read(f.logicalAddress, { expectedWriter: f.expectedWriter, ...supplied(f) }), /multiple programs/);
});
test('recheck refuses a receipt once the writer owns a conflicting program', async () => {
  const f = twinFixture(), { receipt } = await read(f); listTwin(f);
  await assert.rejects(f.adapter.recheck(receipt, { expectedWriter: f.expectedWriter }), /multiple programs/);
});
test('a simulated fixture receipt names itself and never claims Demos finality', async () => {
  const { receipt } = await read(readbackFixture());
  assert.equal(isAnchorReceipt(receipt), true);
  assert.deepEqual({ substrate: receipt.substrate, finalityProfile: receipt.finalityProfile, state: receipt.state, evidenceKind: receipt.evidence.kind }, DEMOS_SR2_FIXTURE_RECEIPT);
  assert.throws(() => decodeDemosAnchorReceiptProof(receipt), /Demos write evidence/);
});
for (const [label, mutate] of [
  ['content hash', r => { r.contentHash = 'b'.repeat(64); }], ['nonce', r => { r.nonce = '2'; }],
  ['writer', r => { r.writer = buyer.claim; }], ['native address', r => { r.nativeAddress = `stor-${'b'.repeat(40)}`; }],
  ['transaction', r => { r.transactionRef.value = 'b'.repeat(64); }],
  ['substrate to demos', r => { r.substrate = 'demos'; }], ['profile to Demos finality', r => { r.finalityProfile = 'demos-bft-confirmed-native-read'; }],
  ['state to finalized', r => { r.state = 'finalized'; }], ['proof kind to Demos', r => { r.evidence.kind = 'demos-bft-write-proof-v1'; }],
]) test(`recheck refuses changed receipt ${label}`, async () => {
  const f = readbackFixture(), { receipt } = await read(f); mutate(receipt);
  await assert.rejects(f.adapter.recheck(receipt, { expectedWriter: f.expectedWriter }));
});
test('recheck authenticates the current block and detects a reorg', async () => {
  const f = readbackFixture(), { receipt } = await read(f); f.block.hash = 'b'.repeat(64);
  await assert.rejects(f.adapter.recheck(receipt, { expectedWriter: f.expectedWriter }));
});
for (const [label, mutate] of [
  ['signature', f => { f.tx.signature.data = `0x${'00'.repeat(64)}`; }],
  ['data', f => { f.native.data.report = 'changed'; }], ['metadata', f => { f.native.metadata.contentHash = 'b'.repeat(64); }],
  ['owner', f => { f.native.owner = buyer.address; }], ['provenance', f => { f.native.createdByTx = 'b'.repeat(64); }],
  ['inclusion', f => { f.tx.status = 'pending'; }],
]) test(`read refuses unauthenticated ${label}`, async () => { const f = readbackFixture(); mutate(f); await assert.rejects(read(f)); });
test('original signed projection authenticates permitted executed integer normalization', async () => {
  const f = readbackFixture(); f.tx.content.nonce = '1'; f.tx.content.amount = '0'; f.tx.content.timestamp = String(f.tx.content.timestamp);
  assert.equal((await f.adapter.read(f.logicalAddress, { expectedWriter: f.expectedWriter, signedProjection: f.signed })).status, 'present');
});
test('distinct candidate discovery is capped before sequential native fanout', async () => {
  const f = readbackFixture(); f.state.rows = Array.from({ length: 50 }, (_, i) => ({ programName: f.native.programName, storageAddress: `stor-${i.toString(16).padStart(40, '0')}` }));
  await assert.rejects(read(f), /candidate/); assert.equal(f.calls.filter(c => c.path.startsWith('/storage-program/')).length, 0);
});
test('multiple owned native programs remain ambiguous', async () => {
  const f = twinFixture(); listTwin(f);
  await assert.rejects(read(f), /multiple programs/);
});
test('a full page followed by the same program never establishes bounded completeness', async () => {
  const f = readbackFixture(); f.state.rows = Array(50).fill(f.state.rows[0]); await assert.rejects(read(f), /pagination/);
});
for (const status of [403, 404]) test(`HTTP ${status} remains distinguishable with its cause`, async () => {
  const f = readbackFixture({ respond: () => new Response('TEST refused', { status, headers: { 'x-dacs-simulation': 'fixture' } }) });
  await assert.rejects(read(f), error => error.code === 'indeterminate' && error.status === status && error.cause?.status === status && error.message.includes(status === 404 ? 'not found' : String(status)));
});
test('transport timeout retains the original nested cause', async () => {
  const cause = new DOMException('TEST timeout', 'TimeoutError');
  const f = readbackFixture({ respond: () => { throw cause; } });
  await assert.rejects(read(f), error => error.code === 'indeterminate' && error.cause?.cause === cause && /timed out/i.test(error.message));
});
test('one aggregate deadline aborts a reader that ignores per-request deadlines', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = readbackFixture({ respond: () => new Promise(() => {}) });
  const work = assert.rejects(read(f), error => error.code === 'indeterminate' && error.cause?.name === 'TimeoutError');
  t.mock.timers.tick(10001); await work;
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init.signal.aborted, true);
});
