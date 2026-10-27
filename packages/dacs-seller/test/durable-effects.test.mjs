import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import DatabaseSync from 'better-sqlite3';
import { canonicalize, contentHash, privateKeyFromSeed } from '@kynesyslabs/dacs';
import { signAnchorWrite } from '../src/dacs/fixture-anchors.mjs';
import { SELLER_ANCHOR_ARTIFACT_BYTES } from '../src/dacs/seller-durable-state.mjs';
import { durableFixture } from './helpers/durable-state-fixture.mjs';
import { fixtureRecord, seller, buyer, JOB, NOW } from './helpers/protocol-fixture.mjs';
import { localAnchor } from './helpers/local-anchor-fixture.mjs';
const logicalAddress = `TEST-anchor-${JOB}`, artifact = { TEST: 'immutable' };
const sellerAuthorization = (address, value) => () => signAnchorWrite(seller.signBytes, address, contentHash(value));
const scope = (f, anchors, extra = {}) => ({ jobId: JOB, logicalAddress, artifact, anchors, authorize: sellerAuthorization(logicalAddress, artifact), ...extra });
const otherJob = JOB.slice(0,-1) + 'B', thirdJob = JOB.slice(0,-1) + 'C';
const seedKey = () => privateKeyFromSeed(new Uint8Array(32).fill(17)).export({ format: 'der', type: 'pkcs8' }).toString('base64');
// Read one retained row's signed body straight from the database file.
function retainedBody(f, sql, id) {
  const db = new DatabaseSync(f.path, { readonly: true });
  try { const row = db.prepare(sql).get(id); return row ? JSON.parse(row.value).payload.body : null; } finally { db.close(); }
}
const anchorState = (f, address = logicalAddress) => retainedBody(f, 'SELECT value FROM seller_anchors WHERE address=?', address)?.state ?? null;
const settlementRowBytes = (f, id) => { const db = new DatabaseSync(f.path, { readonly: true }); try { return db.prepare('SELECT length(value) AS n FROM seller_settlements WHERE id=?').get(id).n; } finally { db.close(); } };
// A store with only the session tables, as the build before these effects made it.
async function sessionOnlyStore(t, statements = ['DROP TABLE seller_effects', 'DROP TABLE seller_settlements', 'DROP TABLE seller_anchors']) {
  const f = await durableFixture(t); f.store.close();
  const db = new DatabaseSync(f.path); db.exec(statements.join(';')); db.close();
  return f;
}

test('SB-2 conflicting phases suspend one payment even for the same job across restart', async t => {
  const f = await durableFixture(t);
  assert.equal(await f.store.withJob(JOB, () => f.store.bindSettlement('TEST-payment', JOB, { phaseIndex: 0 })), true);
  assert.equal(await f.store.withJob(JOB, () => f.store.bindSettlement('TEST-payment', JOB, { phaseIndex: 1 })), false);
  assert.equal(f.store.settlementJob('TEST-payment'), null); f.store.close();
  const again = await f.reopen(); assert.equal(again.settlementJob('TEST-payment'), null);
  assert.equal(await again.withJob(JOB, () => again.bindSettlement('TEST-payment', JOB, { phaseIndex: 0 })), false); again.close();
});
test('missing phase cannot create a successful settlement claim', async t => {
  const f = await durableFixture(t); assert.equal(await f.store.withJob(JOB, () => f.store.bindSettlement('TEST-payment', JOB)), false); f.store.close();
});
test('an exact repeated settlement claim is idempotent and keeps its credit across restart', async t => {
  const f = await durableFixture(t), claim = { phaseIndex: 0, evidenceHash: 'a'.repeat(64) };
  assert.equal(await f.store.withJob(JOB, () => f.store.bindSettlement('TEST-payment', JOB, claim)), true);
  assert.equal(await f.store.withJob(JOB, () => f.store.bindSettlement('TEST-payment', JOB, structuredClone(claim))), true); f.store.close();
  const again = await f.reopen();
  assert.equal(await again.withJob(JOB, () => again.bindSettlement('TEST-payment', JOB, claim)), true);
  assert.equal(again.settlementJob('TEST-payment'), JOB); again.close();
});
test('a retry of a kept settlement tuple with a moved observation keeps the first claim and its credit', async t => {
  const f = await durableFixture(t), first = { phaseIndex: 0, observedAt: NOW, evidenceHash: 'a'.repeat(64) };
  assert.equal(await f.store.withJob(JOB, () => f.store.bindSettlement('TEST-payment', JOB, first)), true);
  assert.equal(await f.store.withJob(JOB, () => f.store.bindSettlement('TEST-payment', JOB, { ...first, observedAt: NOW + 1, evidenceHash: 'b'.repeat(64) })), true);
  assert.deepEqual(retainedBody(f, 'SELECT value FROM seller_settlements WHERE id=?', 'TEST-payment').claims.map(c => c.claim), [first]);
  assert.equal(f.store.settlementJob('TEST-payment'), JOB); f.store.close();
});
for (const [label, id, jobId, claim] of [
  ['an empty id', '', JOB, { phaseIndex: 0 }], ['an oversized id', 'x'.repeat(513), JOB, { phaseIndex: 0 }],
  ['a malformed job', 'TEST-payment', 'TEST-job', { phaseIndex: 0 }], ['a negative phase', 'TEST-payment', JOB, { phaseIndex: -1 }],
  ['a fractional phase', 'TEST-payment', JOB, { phaseIndex: 0.5 }], ['a string phase', 'TEST-payment', JOB, { phaseIndex: '0' }],
  ['no phase', 'TEST-payment', JOB, {}], ['a scalar claim', 'TEST-payment', JOB, 7],
]) test(`a settlement claim with ${label} is refused`, async t => {
  const f = await durableFixture(t);
  await assert.rejects(f.store.withJob(JOB, () => f.store.bindSettlement(id, jobId, claim)), e => e.code === 'seller_state_binding_invalid');
  assert.equal(f.store.settlementJob('TEST-payment'), null); f.store.close();
});
test('a thousand competing settlement claims keep a constant-size row and credit nobody', async t => {
  const f = await durableFixture(t);
  assert.equal(await f.store.withJob(JOB, () => f.store.bindSettlement('TEST-payment', JOB, { phaseIndex: 0 })), true);
  assert.equal(await f.store.withJob(otherJob, () => f.store.bindSettlement('TEST-payment', otherJob, { phaseIndex: 0 })), false);
  const contested = settlementRowBytes(f, 'TEST-payment');
  await f.store.withJob(otherJob, () => { for (let phase = 1; phase < 1000; phase++) assert.equal(f.store.bindSettlement('TEST-payment', otherJob, { phaseIndex: phase }), false); });
  assert.equal(settlementRowBytes(f, 'TEST-payment'), contested);
  assert.equal(retainedBody(f, 'SELECT value FROM seller_settlements WHERE id=?', 'TEST-payment').claims.length, 2);
  assert.equal(f.store.settlementJob('TEST-payment'), null);
  for (const jobId of [JOB, otherJob]) assert.equal(await f.store.withJob(jobId, () => f.store.bindSettlement('TEST-payment', jobId)), false);
  f.store.close();
});

test('a first valid attempt survives restart and only it is admitted', async t => {
  const f = await durableFixture(t); f.store.issueChallenge('TEST nonce', { jobId: JOB });
  const first = { presentationHash: 'a'.repeat(64) };
  assert.equal(f.store.attemptChallenge('TEST nonce', first).attempt, null); f.store.close();
  const again = await f.reopen(); assert.deepEqual(again.attemptChallenge('TEST nonce', { presentationHash: 'b'.repeat(64) }).attempt, first);
  assert.throws(() => again.admitChallenge('TEST nonce', 'b'.repeat(64))); again.admitChallenge('TEST nonce', first.presentationHash); again.close();
});
// CORE SN-4: a malformed first attempt consumes its nonce before it is refused.
for (const [label, attempt] of [
  ['null', null], ['an array', [{ presentationHash: 'a'.repeat(64) }]], ['without a hash', {}], ['with an array hash', { presentationHash: [] }],
  ['with a non-hex hash', { presentationHash: 'A'.repeat(64) }], ['with a field JSON cannot hold', { presentationHash: 'a'.repeat(64), TEST: 1n }],
  ['whose JSON form is null', { presentationHash: 'a'.repeat(64), toJSON: () => null }],
]) test(`a first attempt ${label} is refused, consumes its nonce across restart and is never admitted`, async t => {
  const f = await durableFixture(t); f.store.issueChallenge('TEST nonce', { jobId: JOB });
  assert.throws(() => f.store.attemptChallenge('TEST nonce', attempt), e => e.code === 'seller_challenge_attempt_invalid'); f.store.close();
  const again = await f.reopen(), later = { presentationHash: 'b'.repeat(64) };
  assert.notEqual(again.attemptChallenge('TEST nonce', later).attempt, null);
  for (const hash of [later.presentationHash, null, undefined]) assert.throws(() => again.admitChallenge('TEST nonce', hash), e => e.code === 'seller_state_corrupt');
  again.close();
});

test('signature bytes persist once and a failed signer remains retryable under the fence', async t => {
  let fail = false, count = 0;
  const f = await durableFixture(t, { signer: { claim: seller.claim, sign(bytes) { if (bytes.toString() === 'TEST exact bytes') { count++; if (fail) throw new Error('TEST sign failed'); } return seller.signBytes(bytes); } } });
  const bytes = Buffer.from('TEST exact bytes'); fail = true;
  await assert.rejects(f.store.withJob(JOB, () => f.store.signOnce('TEST-signature', bytes)), /TEST sign failed/); fail = false;
  const signed = await f.store.withJob(JOB, () => f.store.signOnce('TEST-signature', bytes)); f.store.close();
  const again = await f.reopen(); assert.deepEqual(await again.withJob(JOB, () => again.signOnce('TEST-signature', bytes)), signed); assert.equal(count, 2);
  await assert.rejects(again.withJob(JOB, () => again.signOnce('TEST-signature', Buffer.from('changed'))), e => e.code === 'seller_effect_conflict'); again.close();
});
for (const [label, answer] of [['a short signature', Buffer.alloc(10)], ['a signature that does not verify', Buffer.alloc(64)]]) test(`a signer returning ${label} records no completion`, async t => {
  const bytes = Buffer.from('TEST refused signature');
  const f = await durableFixture(t, { signer: { claim: seller.claim, sign: value => value.equals(bytes) ? answer : seller.signBytes(value) } });
  await assert.rejects(f.store.withJob(JOB, () => f.store.signOnce('TEST-signature', bytes)), e => e.code === 'seller_state_signer_invalid');
  assert.equal(f.store.signature('TEST-signature').disposition, 'indeterminate'); f.store.close();
});

test('buyer reservation conflicts until exact fenced release', async t => {
  const f = await durableFixture(t); await f.store.withJob(JOB, () => f.store.reserveSignatureCommitment(buyer.claim, JOB));
  await assert.rejects(f.store.withJob(otherJob, () => f.store.reserveSignatureCommitment(buyer.claim, otherJob)), e => e.code === 'seller_signature_buyer_unresolved');
  await f.store.withJob(JOB, () => f.store.releaseSignatureCommitment(buyer.claim, JOB));
  await f.store.withJob(otherJob, () => f.store.reserveSignatureCommitment(buyer.claim, otherJob)); f.store.close();
});
test('a release from another job changes nothing, also across restart', async t => {
  const f = await durableFixture(t); await f.store.withJob(JOB, () => f.store.reserveSignatureCommitment(buyer.claim, JOB));
  await f.store.withJob(otherJob, () => f.store.releaseSignatureCommitment(buyer.claim, otherJob)); f.store.close();
  const again = await f.reopen();
  await assert.rejects(again.withJob(otherJob, () => again.reserveSignatureCommitment(buyer.claim, otherJob)), e => e.code === 'seller_signature_buyer_unresolved');
  await again.withJob(JOB, () => again.releaseSignatureCommitment(buyer.claim, JOB));
  await again.withJob(otherJob, () => again.reserveSignatureCommitment(buyer.claim, otherJob)); again.close();
});
for (const [label, value] of [['an empty', ''], ['a missing', undefined], ['an oversized', 'x'.repeat(513)], ['a non-string', 7]]) test(`${label} buyer identifier is refused for reservation and release`, async t => {
  const f = await durableFixture(t);
  for (const method of ['reserveSignatureCommitment', 'releaseSignatureCommitment']) {
    await assert.rejects(f.store.withJob(JOB, () => f.store[method](value, JOB)), e => e.code === 'seller_state_binding_invalid');
  }
  f.store.close();
});

// D-1: the writer authorization is checked before anything is kept or sent.
for (const [label, authorize, cause] of [
  ['throws', () => { throw new Error('TEST approval unavailable'); }, true],
  ['is not a signature', () => 'TEST', false], ['is not a string', () => 42, false], ['is a promise', async () => signAnchorWrite(seller.signBytes, logicalAddress, contentHash(artifact)), false],
  ['is signed by another key', () => signAnchorWrite(buyer.signBytes, logicalAddress, contentHash(artifact)), false],
  ['names another address', sellerAuthorization('TEST-other-address', artifact), false],
  ['names another hash', () => signAnchorWrite(seller.signBytes, logicalAddress, 'b'.repeat(64)), false],
]) test(`an authorization that ${label} keeps no intent and writes nothing; a corrected retry after restart writes once`, async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW });
  await assert.rejects(f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors, { authorize }))),
    e => e.code === 'seller_anchor_authorization_invalid' && (!cause || e.cause?.message === 'TEST approval unavailable'));
  assert.equal(f.store.hasAnchor(logicalAddress), false); assert.equal(anchors.writes.length, 0); f.store.close();
  const again = await f.reopen();
  assert.equal((await again.withJob(JOB, () => again.anchor(scope(f, anchors)))).state, 'finalized');
  assert.equal(anchors.writes.length, 1); assert.equal(anchorState(f), 'complete'); again.close();
});
for (const [label, encode] of [['0x-hex', value => value], ['hex', value => value.slice(2)], ['base64url', value => Buffer.from(value.slice(2), 'hex').toString('base64url')]]) {
  test(`a ${label} writer authorization is accepted`, async t => {
    const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW });
    const receipt = await f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors, { authorize: () => encode(sellerAuthorization(logicalAddress, artifact)()) })));
    assert.equal(receipt.state, 'finalized'); assert.equal(anchors.writes.length, 1); f.store.close();
  });
}

// D-2: an artifact whose readback could not fit one anchor reply is refused before anything is kept.
const sized = (bytes, unit = 'x') => ({ TEST: unit.repeat((bytes - canonicalize({ TEST: '' }).length) / Buffer.byteLength(unit)) });
// An array of zeros whose canonical form is exactly `bytes` long: each element writes "0,".
const zeros = bytes => ({ TEST: Array((bytes - canonicalize({ TEST: [] }).length + 1) / 2).fill(0) });
for (const [label, value] of [['one byte over the limit', sized(SELLER_ANCHOR_ARTIFACT_BYTES + 1)], ['multibyte, one byte over the limit and fewer characters than it', sized(SELLER_ANCHOR_ARTIFACT_BYTES + 1, 'é')]]) {
  test(`an artifact ${label} is refused before authorization, intent or write`, async t => {
    const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW }); let authorizations = 0;
    await assert.rejects(f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors, { artifact: value, authorize: () => { authorizations++; return 'TEST'; } }))),
      e => e.code === 'seller_anchor_artifact_too_large');
    assert.equal(authorizations, 0); assert.equal(anchors.writes.length, 0); assert.equal(f.store.hasAnchor(logicalAddress), false); f.store.close();
  });
}
for (const [label, value] of [
  ['exactly at the limit', sized(SELLER_ANCHOR_ARTIFACT_BYTES)], ['multibyte at the limit', sized(SELLER_ANCHOR_ARTIFACT_BYTES - 1, 'é')],
  ['the size of a 128 KiB inline Deliverable', { report: 'x'.repeat(128 * 1024), jobId: JOB }],
  ['of 180,000 small numbers', { TEST: Array(180000).fill(0) }], ['of small numbers exactly at the limit', zeros(SELLER_ANCHOR_ARTIFACT_BYTES)],
]) test(`an artifact ${label} is written once and read back with its receipt`, async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW }), address = `TEST-sized-${JOB}`;
  const receipt = await f.store.withJob(JOB, () => f.store.anchor({ jobId: JOB, logicalAddress: address, artifact: value, anchors, authorize: sellerAuthorization(address, value) }));
  assert.equal(receipt.state, 'finalized');
  assert.deepEqual((await f.store.readAnchor({ jobId: JOB, logicalAddress: address, anchors })).artifact, value);
  assert.equal(anchors.writes.length, 1); f.store.close();
});
test('a decoded readback is not charged for members JSON drops', async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW }), value = sized(SELLER_ANCHOR_ARTIFACT_BYTES), address = `TEST-sized-${JOB}`;
  const dropped = Object.fromEntries(Array.from({ length: 4096 }, (_, i) => [`TEST-unset-${i}`, undefined]));
  anchors.controls.read = row => ({ ...row, ...dropped });
  const receipt = await f.store.withJob(JOB, () => f.store.anchor({ jobId: JOB, logicalAddress: address, artifact: value, anchors, authorize: sellerAuthorization(address, value) }));
  assert.equal(receipt.state, 'finalized'); assert.equal(anchors.writes.length, 1); f.store.close();
});
for (const [label, value] of [['an array', ['TEST']], ['a string', 'TEST'], ['undefined', undefined], ['a value JSON cannot hold', { TEST: 1n }]]) test(`an artifact that is ${label} is refused before anything is kept`, async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW });
  await assert.rejects(f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors, { artifact: value, authorize: () => assert.fail('TEST not authorized') }))), e => e.code === 'seller_anchor_artifact_invalid');
  assert.equal(anchors.writes.length, 0); f.store.close();
});
for (const [label, extra] of [['an empty address', { logicalAddress: '' }], ['an oversized address', { logicalAddress: 'x'.repeat(513) }], ['a malformed job', { jobId: 'TEST-job' }]]) test(`an anchor with ${label} is refused before anything is kept`, async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW });
  await assert.rejects(f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors, { ...extra, authorize: () => assert.fail('TEST not authorized') }))), e => e.code === 'seller_state_binding_invalid');
  assert.equal(anchors.writes.length, 0); f.store.close();
});
test('the caller changing its artifact during or after anchoring changes no retained or sent byte', async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW }), input = structuredClone(artifact);
  const authorize = () => { const signature = sellerAuthorization(logicalAddress, artifact)(); input.TEST = 'TEST changed'; return signature; };
  await f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors, { artifact: input, authorize })));
  input.TEST = 'TEST changed again';
  assert.deepEqual(anchors.rows.get(logicalAddress).artifact, artifact);
  assert.deepEqual((await f.store.readAnchor({ jobId: JOB, logicalAddress, anchors })).artifact, artifact); f.store.close();
});
test('an anchor kept for another job or other bytes is a conflict and is not authorized again', async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW });
  await f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors)));
  await assert.rejects(f.store.withJob(otherJob, () => f.store.anchor(scope(f, anchors, { jobId: otherJob, authorize: () => assert.fail('TEST not authorized') }))), e => e.code === 'seller_effect_conflict');
  await assert.rejects(f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors, { artifact: { TEST: 'other' }, authorize: () => assert.fail('TEST not authorized') }))), e => e.code === 'seller_effect_conflict');
  assert.equal((await f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors, { authorize: () => assert.fail('TEST not authorized') })))).state, 'finalized');
  assert.equal(anchors.writes.length, 1); f.store.close();
});

test('write acknowledgement cannot replace independent authenticated readback', async t => {
  const f = await durableFixture(t); let reads = 0;
  const anchors = { write: async () => fixtureRecord(logicalAddress, artifact).receipt, read: async () => { reads++; return { status: 'absent' }; } };
  await assert.rejects(f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors))), e => e.code === 'seller_anchor_reconciliation_required'); assert.equal(reads, 1); f.store.close();
});
test('mutating writer input cannot change the retained artifact or authorize another hash', async t => {
  const f = await durableFixture(t), input = { TEST: 'immutable' };
  const anchors = { write: async request => { request.artifact.TEST = 'changed'; return fixtureRecord(logicalAddress, request.artifact).receipt; }, read: async () => fixtureRecord(logicalAddress, { TEST: 'changed' }) };
  await assert.rejects(f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors, { artifact: input }))), e => e.code === 'seller_anchor_reconciliation_invalid');
  assert.deepEqual(input, artifact); f.store.close();
});
test('lost write answer reconciles exact bytes after restart without another write', async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW }); anchors.controls.failAfterWrite = logicalAddress;
  await assert.rejects(f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors))), e => e.code === 'seller_anchor_reconciliation_required');
  f.store.close(); const again = await f.reopen(); const result = await again.withJob(JOB, () => again.anchor(scope(f, anchors, { authorize: () => assert.fail('TEST not authorized') })));
  assert.equal(result.state, 'finalized'); assert.equal(anchors.writes.length, 1); again.close();
});
test('a write refused before it was sent holds the intent: retries only read', async t => {
  const f = await durableFixture(t); let writes = 0, reads = 0;
  const anchors = { write: async () => { writes++; throw Object.assign(new Error('TEST refused'), { code: 'ECONNREFUSED' }); }, read: async () => { reads++; return { status: 'absent' }; } };
  await assert.rejects(f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors))), e => e.code === 'seller_anchor_reconciliation_required' && e.cause?.code === 'ECONNREFUSED');
  f.store.close(); const again = await f.reopen();
  await assert.rejects(again.withJob(JOB, () => again.anchor(scope(f, anchors))), e => e.code === 'seller_anchor_reconciliation_required');
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(anchorState(f), 'intent'); again.close();
});
test('completed anchors are rechecked and held on missing source after restart', async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW });
  await f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors))); f.store.close(); anchors.controls.read = () => ({ status: 'absent' });
  const again = await f.reopen(), result = await again.reconcileJob(JOB, anchors); assert.equal(result.status, 'held'); assert.equal(result.outcomes.length, 1); again.close();
});
// Every readback failure of a kept intent is coded, keeps its cause and completes nothing.
const otherWriter = fixtureRecord(logicalAddress, artifact, buyer);
for (const [label, code, answer] of [
  ['absent', 'required', () => ({ status: 'absent' })], ['indeterminate', 'required', () => ({ status: 'indeterminate' })],
  ['null', 'required', () => null], ['an oversized raw reply', 'required', () => new Uint8Array(1024 * 1024 + 1)],
  ['an oversized decoded reply', 'required', row => ({ ...row, padding: 'x'.repeat(1024 * 1024) })],
  ['a thrown error', 'required', () => { throw Object.assign(new Error('TEST read failed'), { code: 'ECONNRESET' }); }],
  ['present only', 'invalid', () => ({ status: 'present' })], ['present without an artifact', 'invalid', row => ({ status: 'present', receipt: row.receipt })],
  ['present without a receipt', 'invalid', row => ({ status: 'present', artifact: row.artifact })],
  ['another artifact', 'invalid', row => ({ ...row, artifact: { TEST: 'other' } })], ['another writer', 'invalid', () => otherWriter],
  ['another address', 'invalid', row => ({ ...row, receipt: { ...row.receipt, logicalAddress: 'TEST-other-address' } })],
  ['another hash', 'invalid', row => ({ ...row, receipt: { ...row.receipt, contentHash: 'b'.repeat(64) } })],
  ['a forged writer signature', 'invalid', row => ({ ...row, receipt: { ...row.receipt, evidence: otherWriter.receipt.evidence } })],
  ['a non-final receipt', 'invalid', row => ({ ...row, receipt: { ...row.receipt, state: 'included' } })],
]) test(`a readback that is ${label} is seller_anchor_reconciliation_${code} with its cause and completes nothing`, async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW }); anchors.controls.failAfterWrite = logicalAddress;
  await assert.rejects(f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors))));
  anchors.controls.read = answer;
  await assert.rejects(f.store.readAnchor({ jobId: JOB, logicalAddress, anchors }), e => e instanceof Error && e.code === `seller_anchor_reconciliation_${code}` && e.cause instanceof Error);
  assert.equal(anchorState(f), 'intent');
  anchors.controls.read = row => row;
  assert.equal((await f.store.readAnchor({ jobId: JOB, logicalAddress, anchors })).receipt.state, 'finalized');
  assert.equal(anchorState(f), 'complete'); assert.equal(anchors.writes.length, 1); f.store.close();
});
test('a never-settling anchor read has an overall abortable deadline', async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW }); await f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors)));
  t.mock.timers.enable({ apis: ['setTimeout'] }); let signal;
  anchors.read = (address, options) => { signal = options?.signal; return new Promise(() => {}); };
  const work = assert.rejects(f.store.readAnchor({ jobId: JOB, logicalAddress, anchors }), e => e.code === 'seller_anchor_reconciliation_required' && e.cause?.name === 'TimeoutError');
  await Promise.resolve(); t.mock.timers.tick(10001); await work; assert.equal(signal.aborted, true); f.store.close();
});
for (const lateAnswer of [false, true]) test(`an unanswered anchor write releases the job and retries read-only after restart (late answer=${lateAnswer})`, async t => {
  const f = await durableFixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered, answer, writes = 0, reads = 0, authorizations = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { answer = resolve; });
  const anchors = {
    write(request) { writes++; entered(request); return pending; },
    async read() { reads++; return fixtureRecord(logicalAddress, artifact); },
  };
  let result;
  const work = f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors, { authorize: () => { authorizations++; return signAnchorWrite(seller.signBytes, logicalAddress, contentHash(artifact)); } })))
    .then(value => { result = { value }; }, error => { result = { error }; });
  const request = await started;
  t.mock.timers.tick(10000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(result?.error?.code, 'seller_anchor_reconciliation_required');
  assert.equal(result.error.cause?.name, 'TimeoutError');
  assert.equal(request.signal.aborted, true);
  assert.equal(request.signal.reason, result.error.cause);
  assert.equal(request.timeoutMs, 10000); assert.equal(request.maxBytes, 1024 * 1024);
  await work;
  assert.equal(await f.store.withJob(JOB, () => true), true);
  f.store.close();
  if (lateAnswer) { answer(fixtureRecord(logicalAddress, artifact).receipt); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(reads, 0);
  const again = await f.reopen();
  const receipt = await again.withJob(JOB, () => again.anchor(scope(f, anchors)));
  assert.equal(receipt.state, 'finalized');
  assert.equal(writes, 1); assert.equal(reads, 1); assert.equal(authorizations, 1);
  again.close();
});
test('reconciling one job reads only its own anchors among other jobs, signatures and challenges', async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW }), read = anchors.read, addresses = [];
  for (const jobId of [JOB, otherJob, thirdJob]) {
    const address = `TEST-anchor-${jobId}`;
    await f.store.withJob(jobId, async () => {
      await f.store.anchor({ jobId, logicalAddress: address, artifact, anchors, authorize: sellerAuthorization(address, artifact) });
      f.store.signOnce(`TEST-signature-${jobId}`, Buffer.from(jobId));
    });
    f.store.issueChallenge(`TEST nonce ${jobId}`, { jobId });
  }
  anchors.read = (address, options) => { addresses.push(address); return read(address, options); };
  assert.deepEqual(await f.store.reconcileJob(JOB, anchors), { status: 'reconciled', outcomes: [{ address: logicalAddress, status: 'present-authenticated' }] });
  assert.deepEqual(addresses, [logicalAddress]); f.store.close();
});

test('an exact session-only store upgrades atomically to the effects schema', async t => {
  const f = await sessionOnlyStore(t);
  const again = await f.reopen(); assert.equal(await again.withJob(JOB, () => again.bindSettlement('TEST-upgrade', JOB, { phaseIndex: 0 })), true);
  assert.equal(await again.withJob(JOB, () => again.anchor(scope(f, localAnchor({ now: () => NOW })))).then(r => r.state), 'finalized'); again.close();
});
test('processes opening one session-only store at the same time all succeed on one upgrade', async t => {
  const f = await sessionOnlyStore(t), children = [];
  for (const jobId of [JOB, otherJob, thirdJob, JOB.slice(0,-1) + 'D', JOB.slice(0,-1) + 'E']) {
    const child = fork(new URL('./helpers/seller-durable-state-lock-holder.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    await once(child, 'message'); children.push({ child, jobId });
  }
  const held = children.map(({ child }) => once(child, 'message'));
  for (const { child, jobId } of children) child.send({ type: 'hold', dir: f.dir, claim: seller.claim, listingPin: f.config.listingPin, jobId, pkcs8: seedKey() });
  for (const [message] of await Promise.all(held)) assert.deepEqual([message.type, message.code], ['hold', null], JSON.stringify(message));
  for (const { child } of children) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
  const again = await f.reopen(); assert.equal(again.hasAnchor(logicalAddress), false); again.close();
});
for (const [label, statements] of [
  ['only some effects tables', ['DROP TABLE seller_settlements', 'DROP TABLE seller_anchors']],
  ['the earlier effects tables without anchors', ['DROP TABLE seller_anchors']],
  ['the anchors table without its index', ['DROP INDEX seller_anchors_job']],
  ['an extra object', ['CREATE TABLE TEST_extra (id TEXT)']],
]) test(`a store with ${label} is refused as corrupt`, async t => {
  const f = await sessionOnlyStore(t, statements);
  await assert.rejects(f.reopen(), e => e.code === 'seller_state_corrupt');
});
test('real held child lock fences effects until process exit', async t => {
  const f = await durableFixture(t), child = fork(new URL('./helpers/seller-durable-state-lock-holder.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); }); await once(child, 'message');
  const held = once(child, 'message'); child.send({ type: 'hold', dir: f.dir, claim: seller.claim, listingPin: f.config.listingPin, jobId: JOB, pkcs8: seedKey() });
  const [message] = await held; assert.equal(message.type, 'hold', JSON.stringify(message)); assert.equal(message.code, null);
  await assert.rejects(f.store.withJob(JOB, () => {}), e => e.code === 'seller_state_busy');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await f.store.withJob(JOB, () => f.store.saveSession({ jobId: JOB })); f.store.close();
});
test('losing a job fence during signing releases no signature completion', async t => {
  let db;
  const bytes = Buffer.from('TEST lost fence');
  const f = await durableFixture(t, { signer: { claim: seller.claim, sign(value) { if (value.equals(bytes)) db.prepare('DELETE FROM seller_locks WHERE job=?').run(JOB); return seller.signBytes(value); } } });
  db = new DatabaseSync(f.path);
  await assert.rejects(f.store.withJob(JOB, () => f.store.signOnce('TEST-lost-fence', bytes)), e => e.code === 'seller_state_fenced');
  assert.equal(f.store.signature('TEST-lost-fence').disposition, 'indeterminate'); db.close(); f.store.close();
});
