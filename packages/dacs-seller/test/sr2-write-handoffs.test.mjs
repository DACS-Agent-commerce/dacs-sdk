import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHash } from '@kynesyslabs/dacs';
import { createInMemoryDemosSr2Journal } from '../src/dacs/demos-sr2-adapter.mjs';
import { readbackFixture } from './helpers/sr2-readback-fixture.mjs';
import { seller } from './helpers/protocol-fixture.mjs';

const binding = { agreementHash: 'a'.repeat(64) };
const inputFor = (f, extra = {}) => ({ logicalAddress: f.logicalAddress, artifact: f.artifact, writer: seller.claim, artifactKind: 'Deliverable', ...extra });

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
  const { receipt } = await f.adapter.read(f.logicalAddress, { expectedWriter: seller.claim });
  assert.equal(await f.adapter.verifyReceipt({ ...inputFor(f), expectedWriter: seller.claim, receipt, receiptContentHash: 'b'.repeat(64) }), 'invalid');
});

test('writing and receipt verification accept the exact signed-scope hash with signature fields excluded', async () => {
  const f = authorizedFixture({ artifact: { report: 'TEST signed artifact', signature: { value: 'TEST-signature' } } });
  const receipt = await f.adapter.write(inputFor(f, { transactionHash: f.signed.hash, receiptContentHash: contentHash(f.artifact) }));
  assert.equal(await f.adapter.verifyReceipt({ ...inputFor(f), expectedWriter: seller.claim, receipt }), 'valid');
});

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
