import test from 'node:test';
import assert from 'node:assert/strict';
import { attestationBundleHash, canonicalize, contentHash, demosSignedTransactionProofHash,
  demosWriteEvidenceToAnchorReceipt, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { createDemosSr2Adapter, createInMemoryDemosSr2Journal } from '../src/dacs/demos-sr2-adapter.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { NOW, seller } from './helpers/protocol-fixture.mjs';

const binding = { agreementHash: 'a'.repeat(64) };
const inputFor = (f, extra = {}) => ({ logicalAddress: f.logicalAddress, artifact: f.artifact, writer: seller.claim, artifactKind: f.native.metadata.artifactKind, ...extra });

// Build public receipt evidence independently of the reader so a signed false
// artifact hash can reach verifyReceipt without failing during test setup.
function fixtureReceipt(f) {
  const finalityProof = canonicalize(f.block.validation_data);
  return demosWriteEvidenceToAnchorReceipt({ logicalAddress: f.logicalAddress, writer: seller.claim,
    contentHash: f.native.metadata.contentHash, evidence: {
      evidenceVersion: '1', chainIdentity: f.block.validation_data.chainIdentity, writer: seller.address,
      logicalName: f.logicalAddress, nativeAddress: f.native.storageAddress, operation: 'create', nonce: 1,
      transactionRef: f.signed.hash, signedTransaction: canonicalize(f.signed), signedTransactionHash: demosSignedTransactionProofHash(f.signed),
      blockNumber: 1, blockHash: f.block.hash, blockTimestamp: NOW, finalityProof, finalityProofHash: sha256Hex(finalityProof),
      nativeRead: { owner: seller.address, programName: f.native.programName, valueHash: sha256Hex(canonicalize(f.artifact)),
        metadataHash: sha256Hex(canonicalize(f.native.metadata)), observedAt: NOW },
    } });
}

// A trusted restored plan whose exact signed CREATE is present at the node.
function authorizedFixture(options = {}) {
  const f = readbackFixture(options);
  f.journal.put({ ...inputFor(f), deliveryBinding: options.metadata?.deliveryBinding, owner: seller.address,
    scope: JSON.stringify(['http://127.0.0.1:9922', f.block.validation_data.chainIdentity]), planId: 'TEST-plan',
    programName: f.native.programName, nativeAddress: f.native.storageAddress, nonce: 1,
    hash: f.native.metadata.contentHash, envelopeHash: f.native.metadata.envelopeHash,
    payload: { content: structuredClone(f.signed.content) }, authorizationMessage: f.signed.hash, stage: 'authorization-issued' });
  return f;
}

test('first-write planning prepares the nonce and repeats unchanged across a journal restart', async () => {
  const f = readbackFixture(); f.state.rows = [];
  await assert.rejects(f.adapter.read(f.logicalAddress, { expectedWriter: seller.claim }), { code: 'indeterminate' });
  const plan = await f.adapter.planWrite(inputFor(f));
  assert.equal(plan.stage, 'prepared'); assert.equal(plan.nonce, 1);
  assert.equal(plan.contentHash, contentHash(f.artifact));
  assert.deepEqual(await f.adapter.planWrite(inputFor(f)), plan);
  const journal = createInMemoryDemosSr2Journal(f.journal.records());
  const restarted = readbackFixture({ journal });
  assert.deepEqual(await restarted.adapter.planWrite(inputFor(f)), plan);
  assert.equal(journal.records().length, 1);
});

test('first-write planning refuses malformed discovery without retaining a nonce plan', async () => {
  const f = readbackFixture(); f.state.rows = { status: 'absent' };
  await assert.rejects(f.adapter.planWrite(inputFor(f)), { code: 'indeterminate' });
  assert.deepEqual(f.journal.records(), []);
});

test('first-write discovery has an aggregate deadline even when the reader ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = readbackFixture({ respond: () => new Promise(() => {}) });
  const work = assert.rejects(f.adapter.planWrite(inputFor(f)), error => error.code === 'indeterminate' && error.cause?.name === 'TimeoutError');
  await new Promise(setImmediate); t.mock.timers.tick(10001); await work;
  assert.deepEqual(f.journal.records(), []);
});

test('planning authenticates an existing CREATE and does not trust a changed signature', async () => {
  const f = readbackFixture();
  assert.equal((await f.adapter.planWrite(inputFor(f))).stage, 'verified');
  const fresh = readbackFixture(); fresh.tx.signature.data = `0x${'00'.repeat(64)}`;
  await assert.rejects(fresh.adapter.planWrite(inputFor(fresh)), { code: 'invalid' });
  assert.deepEqual(fresh.journal.records(), []);
});

test('planning refuses a hash override that differs from the artifact signed scope', async () => {
  const f = readbackFixture({ metadata: { contentHash: 'b'.repeat(64) } });
  await assert.rejects(f.adapter.planWrite(inputFor(f, { receiptContentHash: 'b'.repeat(64) })), { code: 'invalid' });
  assert.deepEqual(f.journal.records(), []); assert.equal(f.calls.length, 0);
});

test('writing refuses a hash override even when retained and signed metadata agree with it', async () => {
  const f = authorizedFixture({ metadata: { contentHash: 'b'.repeat(64) } });
  await assert.rejects(f.adapter.write(inputFor(f, { transactionHash: f.signed.hash, receiptContentHash: 'b'.repeat(64) })), { code: 'invalid' });
  assert.equal(f.journal.get('TEST-plan').stage, 'authorization-issued');
});

test('receipt verification rejects a signed CREATE with the wrong artifact content hash', async () => {
  const f = readbackFixture({ metadata: { contentHash: 'b'.repeat(64) } });
  const receipt = fixtureReceipt(f);
  assert.equal(await f.adapter.verifyReceipt({ ...inputFor(f), expectedWriter: seller.claim, receipt, receiptContentHash: 'b'.repeat(64) }), 'invalid');
});

test('writing and receipt verification accept a signed component hash with signature fields excluded', async () => {
  const f = authorizedFixture({ artifact: { report: 'TEST signed artifact', signature: { value: 'TEST-signature' } }, metadata: { artifactKind: 'SettlementEvidence' } });
  const receipt = await f.adapter.write(inputFor(f, { transactionHash: f.signed.hash, receiptContentHash: contentHash(f.artifact) }));
  assert.equal(await f.adapter.verifyReceipt({ ...inputFor(f), expectedWriter: seller.claim, receipt }), 'valid');
});

const payload = { report: 'TEST payload', signature: 'TEST payload member', signatures: ['TEST payload member'] };
const component = { report: 'TEST component', signature: 'TEST signature' };
const bundle = { report: 'TEST bundle', signatures: ['TEST signature'], anchoredByRole: { buyer: 'TEST anchor' } };
for (const [kind, artifact, hash] of [
  [undefined, payload, sha256Hex(canonicalize(payload))],
  ['Deliverable', payload, sha256Hex(canonicalize(payload))],
  ['Listing', component, contentHash(component)],
  ['Agreement', { report: 'TEST agreement', signatures: ['TEST signature'] }, contentHash({ report: 'TEST agreement' })],
  ['SettlementEvidence', component, contentHash(component)],
  ['IdentityBundle', { claims: [], presentation: { signature: 'TEST presentation' } }, identityBundleHash({ claims: [] })],
  ...['AttestationBundle', 'FaultAttestationBundle', 'EvidenceBoundFaultAttestationBundle'].map(kind => [kind, bundle, attestationBundleHash(bundle)]),
]) {
  const label = kind ?? 'raw JSON';
  const options = { artifact, metadata: { artifactKind: kind, contentHash: hash } };
  for (const explicit of [false, true]) {
    test(`${label} consumes retained authorization with its ${explicit ? 'explicit' : 'default'} artifact hash`, async () => {
      const f = authorizedFixture(options);
      const receipt = await f.adapter.write(inputFor(f, { transactionHash: f.signed.hash, ...(explicit ? { receiptContentHash: hash } : {}) }));
      assert.equal(receipt.contentHash, hash); assert.equal(f.journal.get('TEST-plan').stage, 'verified');
    });
    test(`${label} uses its ${explicit ? 'explicit' : 'default'} artifact hash through first write and restart`, async () => {
      const f = readbackFixture(options); f.state.rows = [];
      const input = inputFor(f, explicit ? { receiptContentHash: hash } : {});
      const plan = await f.adapter.planWrite(input);
      assert.equal(plan.stage, 'prepared'); assert.equal(plan.contentHash, hash);
      const journal = createInMemoryDemosSr2Journal(f.journal.records());
      const adapter = createDemosSr2Adapter({ rpcUrl: 'http://127.0.0.1:9922/', journal, fetchImpl: f.fetchImpl, now: () => NOW });
      assert.deepEqual(await adapter.planWrite(input), plan);
      await adapter.takeWalletHandoff({ planId: plan.planId, walletAddress: seller.address });
      const message = journal.get(plan.planId).authorizationMessage;
      const { signedTransaction } = await adapter.authorizeWrite({ planId: plan.planId, walletAddress: seller.address,
        writerSignature: seller.signBytes(Buffer.from(message)).toString('base64url') });
      Object.assign(f.tx, structuredClone(signedTransaction), { status: 'confirmed', blockNumber: 1 });
      f.native.createdByTx = signedTransaction.hash; f.native.interactionTxs = [signedTransaction.hash];
      f.block.content.ordered_transactions = [signedTransaction.hash];
      const receipt = await adapter.write({ ...input, transactionHash: signedTransaction.hash });
      assert.equal(receipt.contentHash, hash);
      assert.equal(await adapter.verifyReceipt({ ...input, expectedWriter: seller.claim, receipt }), 'valid');
      const restartedJournal = createInMemoryDemosSr2Journal(journal.records());
      const restarted = createDemosSr2Adapter({ rpcUrl: 'http://127.0.0.1:9922/', journal: restartedJournal, fetchImpl: f.fetchImpl, now: () => NOW });
      assert.deepEqual(await restarted.write({ ...input, transactionHash: signedTransaction.hash }), receipt);
      assert.equal((await restarted.planWrite(input)).stage, 'verified');
      assert.equal((await restarted.read(f.logicalAddress, { expectedWriter: seller.claim })).receipt.contentHash, hash);
      assert.equal((await restarted.recheck(receipt, { expectedWriter: seller.claim })).status, 'present');
    });
  }
  test(`${label} adopts an existing authenticated CREATE with the same artifact hash`, async () => {
    const f = readbackFixture(options);
    const plan = await f.adapter.planWrite(inputFor(f));
    assert.equal(plan.stage, 'verified'); assert.equal(plan.contentHash, hash);
  });
  test(`${label} refuses a false artifact hash before retaining a plan`, async () => {
    const f = readbackFixture(options); f.state.rows = [];
    await assert.rejects(f.adapter.planWrite(inputFor(f, { receiptContentHash: 'b'.repeat(64) })), { code: 'invalid' });
    assert.deepEqual(f.journal.records(), []); assert.equal(f.calls.length, 0);
  });
  test(`${label} refuses a false artifact hash before consuming authorization`, async () => {
    const f = authorizedFixture(options);
    await assert.rejects(f.adapter.write(inputFor(f, { transactionHash: f.signed.hash, receiptContentHash: 'b'.repeat(64) })), { code: 'invalid' });
    assert.equal(f.journal.get('TEST-plan').stage, 'authorization-issued'); assert.equal(f.calls.length, 0);
  });
  test(`${label} rejects a signed CREATE and receipt that agree on a false artifact hash`, async () => {
    const f = readbackFixture({ artifact, metadata: { artifactKind: kind, contentHash: 'b'.repeat(64) } });
    assert.equal(await f.adapter.verifyReceipt({ ...inputFor(f), expectedWriter: seller.claim,
      receipt: fixtureReceipt(f), receiptContentHash: 'b'.repeat(64) }), 'invalid');
  });
  test(`${label} verifies a reader receipt using the same default artifact hash`, async () => {
    const f = readbackFixture(options);
    const { receipt } = await f.adapter.read(f.logicalAddress, { expectedWriter: seller.claim });
    assert.deepEqual(fixtureReceipt(f), receipt, 'independent receipt fixture matches authenticated evidence');
    assert.equal(await f.adapter.verifyReceipt({ ...inputFor(f), expectedWriter: seller.claim, receipt }), 'valid');
  });
}

for (const [label, savedBinding, requestedBinding] of [
  ['changed', binding, { agreementHash: 'b'.repeat(64) }], ['omitted', binding, undefined], ['added', undefined, binding],
]) {
  test(`repeated planning refuses a ${label} delivery binding`, async () => {
    const f = authorizedFixture({ metadata: { ...(savedBinding ? { deliveryBinding: savedBinding } : {}) } });
    await assert.rejects(f.adapter.planWrite(inputFor(f, { deliveryBinding: requestedBinding })), { code: 'conflict' });
  });
  test(`writing refuses a ${label} delivery binding before verifying the plan`, async () => {
    const f = authorizedFixture({ metadata: { ...(savedBinding ? { deliveryBinding: savedBinding } : {}) } });
    await assert.rejects(f.adapter.write(inputFor(f, { deliveryBinding: requestedBinding, transactionHash: f.signed.hash })), { code: 'conflict' });
    assert.equal(f.journal.get('TEST-plan').stage, 'authorization-issued');
  });
  test(`existing native CREATE refuses a ${label} delivery binding`, async () => {
    const f = readbackFixture({ metadata: { ...(savedBinding ? { deliveryBinding: savedBinding } : {}) } });
    await assert.rejects(f.adapter.planWrite(inputFor(f, { deliveryBinding: requestedBinding })), { code: 'conflict' });
    assert.deepEqual(f.journal.records(), []);
  });
}

test('the same delivery binding repeats its plan and verifies its native write', async () => {
  const f = authorizedFixture({ metadata: { deliveryBinding: binding } });
  const input = inputFor(f, { deliveryBinding: binding });
  assert.equal((await f.adapter.planWrite(input)).planId, 'TEST-plan');
  const receipt = await f.adapter.write({ ...input, transactionHash: f.signed.hash });
  assert.equal(await f.adapter.verifyReceipt({ ...input, receipt, expectedWriter: seller.claim }), 'valid');
});

test('planning accepts an existing authenticated CREATE with the same delivery binding', async () => {
  const f = readbackFixture({ metadata: { deliveryBinding: binding } });
  assert.equal((await f.adapter.planWrite(inputFor(f, { deliveryBinding: binding }))).stage, 'verified');
});
