import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@kynesyslabs/dacs';
import { createSellerContextAdmission, releaseSellerContextHolds, releaseHeldSellerAttempt, composeSellerApproval, parsePolicyLedger, withContextHolds, heldPolicyBudget, SELLER_LEDGER_HEADER_FORMAT, SELLER_ISSUANCE_JOURNALS } from '../src/devnet-demo/operator-approval.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';
const effect = 'a'.repeat(64), otherJob = JOB.slice(0,-1) + 'B', CONTEXT = 'dacs-node2-seller-context-admission/v1';
async function fixture(t, limits = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'TEST-context-budget-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const evidencePath = join(dir, 'approval.jsonl'), config = { evidencePath, sellerApproval: { mode: 'policy', maxWriteTotalOs: '4', maxWritesPerHour: 100, maxTotalOsPerHour: '400', ...limits }, now: () => 300 };
  return { dir, evidencePath, config, admission: createSellerContextAdmission(config), reserve: { jobId: JOB, effect, writes: 1, hold: 'TEST hold' } };
}
const text = async f => readFile(f.evidencePath, 'utf8');
function attempt(index, released = false) {
  const attemptId = `00000000-0000-4000-8000-${String(index + 1).padStart(12,'0')}`, reservationId = `00000000-0000-4000-8001-${String(index + 1).padStart(12,'0')}`;
  const requestBytes = JSON.stringify({ content: { jobId: JOB, artifactKind: 'Deliverable', debit: { totalOs: '4' } } }), approvalHash = sha256Hex(requestBytes);
  const rows = [{ format: 'dacs-node2-operator-approval-evidence/v1', decision: 'rejected', approvalMode: 'policy', policyReason: 'seller-record-missing', attemptId, requestBytes, approvalHash, recordedAt: 100 },
    { format: 'dacs-node2-operator-approval-evidence/v1', decision: 'approved', attemptId, requestBytes, approvalHash, recordedAt: 101 },
    { format: 'dacs-node2-seller-policy-sign-authorization/v1', attemptId, reservationId, requestBytes, approvalHash, totalOs: '4', recordedAt: 102 }];
  if (released) rows.push({ format: 'dacs-node2-seller-policy-attempt/v1', attemptId, reservationId, approvalHash, outcome: 'released', reason: 'wallet-released', recordedAt: 200 });
  return rows;
}
const encode = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
for (const [count, released] of [[3,false],[6,true]]) test(`context job budget counts ${count} manual attempts once (released=${released})`, async t => {
  const f = await fixture(t); await writeFile(f.evidencePath, encode(Array.from({ length: count }, (_, i) => attempt(i, released)).flat()));
  assert.equal(await f.admission.reserve(f.reserve), null); assert.doesNotThrow(() => parsePolicyLedger(fs.readFileSync(f.evidencePath,'utf8')));
});
test('identical hold retries across reload are idempotent and exact scope reuse is refused', async t => {
  const f = await fixture(t); assert.equal(await f.admission.reserve(f.reserve), null); const before = await text(f);
  assert.equal(await createSellerContextAdmission(f.config).reserve(f.reserve), null); assert.equal(await text(f), before);
  for (const change of [{ jobId: otherJob }, { effect: 'b'.repeat(64) }, { writes: 2 }]) assert.equal(await f.admission.reserve({ ...f.reserve, ...change }), 'hold-conflict');
  assert.equal(await text(f), before);
});
test('released hold identity cannot be reopened or corrupt the ledger', async t => {
  const f = await fixture(t); await f.admission.reserve(f.reserve); await f.admission.release({ jobId: JOB, hold: f.reserve.hold }); const before = await text(f);
  assert.equal(await f.admission.reserve(f.reserve), 'hold-released'); assert.equal(await text(f), before); assert.equal(parsePolicyLedger(before).rows[0].released, true);
});
test('reserving after a header without its final newline preserves both lines', async t => {
  const f = await fixture(t), header = { format: SELLER_LEDGER_HEADER_FORMAT, journals: Object.fromEntries(SELLER_ISSUANCE_JOURNALS.map(name => [name, 'a'.repeat(32)])), recordedAt: 100 };
  await writeFile(f.evidencePath, JSON.stringify(header)); await f.admission.reserve(f.reserve);
  assert.equal(parsePolicyLedger(await text(f)).rows.length, 1);
});
test('release after a hold without its final newline preserves both lines', async t => {
  const f = await fixture(t); await f.admission.reserve(f.reserve); await writeFile(f.evidencePath, (await text(f)).trimEnd());
  await f.admission.release({ jobId: JOB, hold: f.reserve.hold }); assert.equal(parsePolicyLedger(await text(f)).rows[0].released, true);
});
test('sync failure prevents admission success; exact retry syncs retained state', async t => {
  const f = await fixture(t), original = fs.fsyncSync, cause = Object.assign(new Error('TEST fsync failed'), { code: 'EIO' }); let syncs = 0;
  try { fs.fsyncSync = () => { throw cause; }; syncBuiltinESMExports(); await assert.rejects(f.admission.reserve(f.reserve), error => error === cause); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  try { fs.fsyncSync = fd => { syncs++; return original(fd); }; syncBuiltinESMExports(); assert.equal(await f.admission.reserve(f.reserve), null); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
  assert(syncs >= 2); assert.equal(parsePolicyLedger(await text(f)).rows.length, 1);
});
for (const [limits, expected] of [[{ maxWritesPerHour: 1 }, 'hourly-write-limit'], [{ maxTotalOsPerHour: '4' }, 'hourly-dem-limit']]) test(`admission enforces ${expected} and exact release restores capacity`, async t => {
  const f = await fixture(t, limits); await f.admission.reserve(f.reserve); const second = { ...f.reserve, jobId: otherJob, hold: 'TEST second' };
  assert.equal(await f.admission.reserve(second), expected); await f.admission.release({ jobId: JOB, hold: f.reserve.hold }); assert.equal(await f.admission.reserve(second), null);
});
test('six live distinct writes enforce the job cap', async t => {
  const f = await fixture(t); await writeFile(f.evidencePath, encode(Array.from({ length: 6 }, (_, i) => attempt(i)).flat()));
  assert.equal(await f.admission.reserve(f.reserve), 'job-write-limit');
});
test('bad clocks and unreadable ledgers fail before appending with their cause', async t => {
  const f = await fixture(t); await writeFile(f.evidencePath, '{'); const before = await text(f);
  await assert.rejects(f.admission.reserve(f.reserve), error => error.code === 'seller_context_ledger_unreadable' && error.cause instanceof SyntaxError); assert.equal(await text(f), before);
  await writeFile(f.evidencePath, ''); const bad = createSellerContextAdmission({ ...f.config, now: () => -1 }); await assert.rejects(bad.reserve(f.reserve)); assert.equal(await text(f), '');
});
test('backward release clock cannot append an invalid completion', async t => {
  const f = await fixture(t); await f.admission.reserve(f.reserve); const before = await text(f);
  await assert.rejects(releaseSellerContextHolds({ evidencePath: f.evidencePath, jobId: JOB, now: () => 299 })); assert.equal(await text(f), before);
});
test('explicit held-attempt release closes one reservation durably and refuses a second completion', async t => {
  const f = await fixture(t); await writeFile(f.evidencePath, encode(attempt(0))); const attemptId = attempt(0)[0].attemptId;
  assert.equal((await releaseHeldSellerAttempt({ evidencePath: f.evidencePath, attemptId, now: () => 300 })).attemptId, attemptId);
  const before = await text(f); assert.equal(parsePolicyLedger(before).attempts.get(attemptId).outcome, 'released');
  await assert.rejects(releaseHeldSellerAttempt({ evidencePath: f.evidencePath, attemptId, now: () => 301 })); assert.equal(await text(f), before);
});
test('composition consumes preparation once and maps settlement to its exact retained copy', async () => {
  const calls = [], policy = Object.assign(async (...args) => { calls.push(args); return true; }, { prepare: async () => true, settle: (...args) => calls.push(args) });
  const approval = composeSellerApproval({ mode: 'policy', policy, manual: async () => false });
  const request = { content: { artifactKind: 'Deliverable', wallet: 'TEST wallet', nonce: 1, timestamp: 7, exactCreate: '{}' } };
  assert.equal(await approval(request), true); const validity = { response: { data: { transaction: { content: { from: 'TEST wallet', nonce: 1, timestamp: 7, data: ['storageProgram', {}] } } } } };
  assert.equal(await approval.confirm(validity), true); assert.equal(await approval.confirm(validity), false); approval.settle(request, 'spent'); assert.notEqual(calls[0][0], request); assert.equal(calls[1][0], calls[0][0]);
});
test('manual decline releases a held prepayment attempt without sign authorization', async () => {
  const calls = [], policy = Object.assign(async () => false, { prepare: async () => false, heldForManual: () => true, heldAttempt: () => 'TEST attempt', settle: (...args) => calls.push(args), authorizeSign: () => { throw new Error('must not sign'); } });
  const approval = composeSellerApproval({ mode: 'policy', policy, manual: async () => false });
  assert.equal(await approval({ content: { artifactKind: 'FinalityCommitmentRecord' } }), false); assert.equal(calls[0][1], 'released'); assert.equal(calls[0][2], 'manual-declined');
});

for (const at of [299, 300]) test(`new context hold refuses timestamp ${at} preceding or equal to an unfinished Vet attempt`, async t => {
  const f = await fixture(t, { maxWritesPerHour: 2, maxTotalOsPerHour: '8' });
  const row = attempt(0)[0], request = JSON.parse(row.requestBytes);
  request.content.artifactKind = 'CompositeVerificationRecord';
  row.requestBytes = JSON.stringify(request); row.approvalHash = sha256Hex(row.requestBytes); row.recordedAt = 300;
  await writeFile(f.evidencePath, encode([row])); const before = await text(f);
  assert.equal(await createSellerContextAdmission({ ...f.config, now: () => at }).reserve(f.reserve), 'hold-time-order');
  assert.equal(await text(f), before);
});
test('strictly later context holds count separately from preceding unfinished Vet attempts', async t => {
  const f = await fixture(t, { maxWritesPerHour: 2, maxTotalOsPerHour: '8' });
  const row = attempt(0)[0], request = JSON.parse(row.requestBytes);
  request.content.artifactKind = 'CompositeVerificationRecord';
  row.requestBytes = JSON.stringify(request); row.approvalHash = sha256Hex(row.requestBytes); row.recordedAt = 300;
  await writeFile(f.evidencePath, encode([row]));
  const admission = createSellerContextAdmission({ ...f.config, now: () => 301 });
  assert.equal(await admission.reserve(f.reserve), null);
  assert.deepEqual(heldPolicyBudget(withContextHolds(parsePolicyLedger(await text(f)).rows), 301), { writes: 2, totalOs: 8n });
  assert.equal(await admission.reserve({ ...f.reserve, jobId: otherJob, hold: 'TEST third' }), 'hourly-write-limit');
});

for (const operation of ['distinct hold', 'identical hold', 'context release', 'attempt release']) test(`a second process cannot perform ${operation} while a ledger transaction is reading`, { timeout: 15_000 }, async t => {
  const f = await fixture(t, { maxWritesPerHour: 1, maxTotalOsPerHour: '4' });
  const child = fork(new URL('./helpers/context-budget-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
  const reading = once(child, 'message'); child.send({ config: f.config, reserve: f.reserve });
  assert.deepEqual((await reading)[0], { type: 'reading' });
  const work = () => operation === 'context release' ? f.admission.release({ jobId: JOB, hold: f.reserve.hold })
    : operation === 'attempt release' ? releaseHeldSellerAttempt({ evidencePath: f.evidencePath, attemptId: attempt(0)[0].attemptId, now: () => 300 })
    : f.admission.reserve({ ...f.reserve, ...(operation === 'distinct hold' ? { jobId: otherJob, hold: 'TEST second' } : {}) });
  await assert.rejects(work(), error => error.code === 'seller_state_locked');
  await assert.rejects(readFile(f.evidencePath), error => error.code === 'ENOENT');
  const result = once(child, 'message'), exited = once(child, 'exit'); child.send({ type: 'continue' });
  assert.deepEqual((await result)[0], { type: 'result', value: null }); assert.equal((await exited)[0], 0);
  const retained = await text(f);
  assert.deepEqual(heldPolicyBudget(withContextHolds(parsePolicyLedger(retained).rows), 300), { writes: 1, totalOs: 4n });
  assert.equal(await f.admission.reserve(f.reserve), null); assert.equal(await text(f), retained);
  assert.equal(await f.admission.reserve({ ...f.reserve, jobId: otherJob, hold: 'TEST second' }), 'hourly-write-limit');
  await f.admission.release({ jobId: JOB, hold: f.reserve.hold });
  assert.equal(await f.admission.reserve({ ...f.reserve, jobId: otherJob, hold: 'TEST second' }), null);
});

test('transaction locking preserves one-leaf parent creation and refuses two missing levels', async t => {
  const f = await fixture(t), evidencePath = join(f.dir, 'TEST leaf', 'approval.jsonl');
  assert.equal(await createSellerContextAdmission({ ...f.config, evidencePath }).reserve(f.reserve), null);
  assert.equal(fs.statSync(join(f.dir, 'TEST leaf')).mode & 0o777, 0o700);
  const missing = join(f.dir, 'TEST absent', 'TEST leaf', 'approval.jsonl');
  await assert.rejects(createSellerContextAdmission({ ...f.config, evidencePath: missing }).reserve(f.reserve), error => error.code === 'ENOENT');
});
