import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import DatabaseSync from 'better-sqlite3';
import { contentHash, privateKeyFromSeed } from '@kynesyslabs/dacs';
import { signAnchorWrite } from '../src/dacs/fixture-anchors.mjs';
import { durableFixture } from './helpers/durable-state-fixture.mjs';
import { fixtureRecord, seller, buyer, JOB, NOW } from './helpers/protocol-fixture.mjs';
import { localAnchor } from './helpers/local-anchor-fixture.mjs';
const logicalAddress = `TEST-anchor-${JOB}`, artifact = { TEST: 'immutable' };
const scope = (f, anchors, extra = {}) => ({ jobId: JOB, logicalAddress, artifact, anchors, authorize: () => signAnchorWrite(seller.signBytes, logicalAddress, contentHash(artifact)), ...extra });
const otherJob = JOB.slice(0,-1) + 'B';

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
test('malformed attempts refuse without retaining null; first valid attempt survives restart', async t => {
  const f = await durableFixture(t); f.store.issueChallenge('TEST nonce', { jobId: JOB });
  assert.throws(() => f.store.attemptChallenge('TEST nonce', null), e => e.code === 'seller_challenge_attempt_invalid');
  const first = { presentationHash: 'a'.repeat(64) };
  assert.equal(f.store.attemptChallenge('TEST nonce', first).attempt, null); f.store.close();
  const again = await f.reopen(); assert.deepEqual(again.attemptChallenge('TEST nonce', { presentationHash: 'b'.repeat(64) }).attempt, first);
  assert.throws(() => again.admitChallenge('TEST nonce', 'b'.repeat(64))); again.admitChallenge('TEST nonce', first.presentationHash); again.close();
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
test('buyer reservation conflicts until exact fenced release', async t => {
  const f = await durableFixture(t); await f.store.withJob(JOB, () => f.store.reserveSignatureCommitment(buyer.claim, JOB));
  await assert.rejects(f.store.withJob(otherJob, () => f.store.reserveSignatureCommitment(buyer.claim, otherJob)), e => e.code === 'seller_signature_buyer_unresolved');
  await f.store.withJob(JOB, () => f.store.releaseSignatureCommitment(buyer.claim, JOB));
  await f.store.withJob(otherJob, () => f.store.reserveSignatureCommitment(buyer.claim, otherJob)); f.store.close();
});
test('authorization failure before submission is retryable after restart', async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW }), cause = new Error('TEST approval unavailable');
  await assert.rejects(f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors, { authorize: () => { throw cause; } }))), error => error.cause === cause);
  f.store.close(); const again = await f.reopen();
  const receipt = await again.withJob(JOB, () => again.anchor(scope(f, anchors))); assert.equal(receipt.state, 'finalized'); assert.equal(anchors.writes.length, 1); again.close();
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
  f.store.close(); const again = await f.reopen(); const result = await again.withJob(JOB, () => again.anchor(scope(f, anchors)));
  assert.equal(result.state, 'finalized'); assert.equal(anchors.writes.length, 1); again.close();
});
test('completed anchors are rechecked and held on missing source after restart', async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW });
  await f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors))); f.store.close(); anchors.controls.read = () => ({ status: 'absent' });
  const again = await f.reopen(), result = await again.reconcileJob(JOB, anchors); assert.equal(result.status, 'held'); assert.equal(result.outcomes.length, 1); again.close();
});
for (const answer of [null, { status: 'present', artifact: { TEST: 'x'.repeat(1024 * 1024 + 1) } }]) test(`malformed/oversized readback is coded indeterminate (${answer === null ? 'null' : 'large'})`, async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW });
  await f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors))); anchors.controls.read = () => answer;
  await assert.rejects(f.store.readAnchor({ jobId: JOB, logicalAddress, anchors }), e => e.code === 'seller_anchor_reconciliation_required' && e.cause instanceof Error); f.store.close();
});
for (const code of ['ETIMEDOUT', 'ECONNREFUSED']) test(`readback preserves ${code} cause`, async t => {
  const f = await durableFixture(t), anchors = localAnchor({ now: () => NOW }); await f.store.withJob(JOB, () => f.store.anchor(scope(f, anchors)));
  const cause = Object.assign(new Error('TEST ' + code), { code }); anchors.controls.read = () => { throw cause; };
  await assert.rejects(f.store.readAnchor({ jobId: JOB, logicalAddress, anchors }), e => e.code === 'seller_anchor_reconciliation_required' && e.cause === cause); f.store.close();
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
test('exact authenticated session schema upgrades atomically to effects', async t => {
  const f = await durableFixture(t); f.store.close(); const db = new DatabaseSync(f.path); db.exec('DROP TABLE seller_effects; DROP TABLE seller_settlements'); db.close();
  const again = await f.reopen(); assert.equal(await again.withJob(JOB, () => again.bindSettlement('TEST-upgrade', JOB, { phaseIndex: 0 })), true); again.close();
});
test('real held child lock fences effects until process exit', async t => {
  const f = await durableFixture(t), child = fork(new URL('./helpers/seller-durable-state-lock-holder.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); }); await once(child, 'message');
  const held = once(child, 'message'); child.send({ type: 'hold', dir: f.dir, claim: seller.claim, listingPin: f.config.listingPin, jobId: JOB, pkcs8: privateKeyFromSeed(new Uint8Array(32).fill(17)).export({ format: 'der', type: 'pkcs8' }).toString('base64') });
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
