import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@kynesyslabs/dacs';
import { createSellerContextAdmission, releaseSellerContextHolds, parsePolicyLedger, withContextHolds, heldPolicyBudget, SELLER_LEDGER_HEADER_FORMAT, SELLER_ISSUANCE_JOURNALS } from '../src/devnet-demo/operator-approval.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';
const effect = 'a'.repeat(64), otherJob = JOB.slice(0,-1) + 'B';
const EVIDENCE = 'dacs-node2-operator-approval-evidence/v1', SIGN = 'dacs-node2-seller-policy-sign-authorization/v1', ATTEMPT = 'dacs-node2-seller-policy-attempt/v1';
async function fixture(t, limits = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'TEST-context-budget-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const evidencePath = join(dir, 'approval.jsonl'), config = { evidencePath, sellerApproval: { mode: 'policy', maxWriteTotalOs: '4', maxWritesPerHour: 100, maxTotalOsPerHour: '400', ...limits }, now: () => 300 };
  return { dir, evidencePath, config, admission: createSellerContextAdmission(config), reserve: { jobId: JOB, effect, writes: 1, hold: 'TEST hold' } };
}
const text = async f => readFile(f.evidencePath, 'utf8');
const budget = async (f, at = 300) => heldPolicyBudget(withContextHolds(parsePolicyLedger(await text(f)).rows), at);
const id = (series, index) => `00000000-0000-4000-800${series}-${String(index + 1).padStart(12,'0')}`;
const requestOf = artifactKind => JSON.stringify({ content: { jobId: JOB, artifactKind, debit: { totalOs: '4' } } });
function attempt(index, released = false) {
  const attemptId = id(0, index), reservationId = id(1, index);
  const requestBytes = requestOf('Deliverable'), approvalHash = sha256Hex(requestBytes);
  const rows = [{ format: EVIDENCE, decision: 'rejected', approvalMode: 'policy', policyReason: 'seller-record-missing', attemptId, requestBytes, approvalHash, recordedAt: 100 },
    { format: EVIDENCE, decision: 'approved', attemptId, requestBytes, approvalHash, recordedAt: 101 },
    { format: SIGN, attemptId, reservationId, requestBytes, approvalHash, totalOs: '4', recordedAt: 102 }];
  if (released) rows.push({ format: ATTEMPT, attemptId, reservationId, approvalHash, outcome: 'released', reason: 'wallet-released', recordedAt: 200 });
  return rows;
}
// The lines of one held Vet attempt in the order the approval path writes them.
function vetAttempt([opened, manual, signed, confirmed, spent]) {
  const attemptId = id(2, 0), reservationId = id(3, 0), requestBytes = requestOf('CompositeVerificationRecord'), approvalHash = sha256Hex(requestBytes);
  return [
    ['opened', { format: EVIDENCE, decision: 'rejected', approvalMode: 'policy', policyReason: 'seller-record-missing', attemptId, requestBytes, approvalHash, recordedAt: opened }],
    ['manual', { format: EVIDENCE, decision: 'approved', attemptId, requestBytes, approvalHash, recordedAt: manual }],
    ['signed', { format: SIGN, attemptId, reservationId, requestBytes, approvalHash, totalOs: '4', recordedAt: signed }],
    ['confirmed', { format: EVIDENCE, decision: 'approved', approvalMode: 'policy', policyHold: 'seller-record-missing', confirmation: true, attemptId, reservationId, requestBytes, approvalHash, totalOs: '4', recordedAt: confirmed }],
    ['spent', { format: ATTEMPT, attemptId, reservationId, approvalHash, outcome: 'spent', recordedAt: spent }],
  ];
}
// A policy-approved Vet write with no held attempt.
function vetWrite(index, recordedAt) {
  const requestBytes = requestOf('CompositeVerificationRecord');
  return { format: SIGN, reservationId: id(4, index), requestBytes, approvalHash: sha256Hex(requestBytes), totalOs: '4', recordedAt };
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
  const otherFee = createSellerContextAdmission({ ...f.config, sellerApproval: { ...f.config.sellerApproval, maxWriteTotalOs: '5' } });
  assert.equal(await otherFee.reserve(f.reserve), 'hold-conflict');
  assert.equal(await text(f), before);
});
test('released hold identity cannot be reopened or corrupt the ledger', async t => {
  const f = await fixture(t); await f.admission.reserve(f.reserve); await f.admission.release({ jobId: JOB, hold: f.reserve.hold }); const before = await text(f);
  assert.equal(await f.admission.reserve(f.reserve), 'hold-released'); assert.equal(await text(f), before); assert.equal(parsePolicyLedger(before).rows[0].released, true);
});
test('a release naming another job ends nothing', async t => {
  const f = await fixture(t); await f.admission.reserve(f.reserve); const before = await text(f);
  await f.admission.release({ jobId: otherJob, hold: f.reserve.hold });
  assert.equal(await text(f), before); assert.equal(parsePolicyLedger(before).rows[0].released, false);
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

// A crash mid-append leaves the last context line torn: no newline and no complete JSON.
const torn = row => { const line = JSON.stringify({ format: 'dacs-node2-seller-context-admission/v1', ...row }); return line.slice(0, line.length - 12); };
const tornHold = torn({ event: 'hold', holdId: 'TEST hold', jobId: JOB, effect, writes: 1, totalOs: '4', recordedAt: 300 });
const tornRelease = torn({ event: 'release', holdId: 'TEST hold', jobId: JOB, recordedAt: 300 });
test('a hold line torn by a crash is cut and the exact reserve retry reserves once', async t => {
  const f = await fixture(t); await writeFile(f.evidencePath, tornHold);
  assert.equal(await f.admission.reserve(f.reserve), null);
  assert.deepEqual(parsePolicyLedger(await text(f)).rows.map(row => [row.contextHold, row.released]), [['TEST hold', false]]);
});
test('a hold line torn by a crash does not block releasing an earlier hold', async t => {
  const f = await fixture(t), second = { ...f.reserve, jobId: otherJob, hold: 'TEST second' };
  await f.admission.reserve(second); await appendFile(f.evidencePath, tornHold);
  assert.deepEqual(await releaseSellerContextHolds({ evidencePath: f.evidencePath, jobId: otherJob, now: () => 300 }), ['TEST second']);
  assert.deepEqual(parsePolicyLedger(await text(f)).rows.map(row => [row.contextHold, row.released]), [['TEST second', true]]);
});
test('a release line torn by a crash is cut and the release retry ends the hold', async t => {
  const f = await fixture(t); await f.admission.reserve(f.reserve); await appendFile(f.evidencePath, tornRelease);
  assert.deepEqual(await releaseSellerContextHolds({ evidencePath: f.evidencePath, jobId: JOB, now: () => 300 }), ['TEST hold']);
  assert.equal(parsePolicyLedger(await text(f)).rows[0].released, true);
});
test('a release line torn by a crash does not block a reserve for another job and keeps the hold open', async t => {
  const f = await fixture(t); await f.admission.reserve(f.reserve); await appendFile(f.evidencePath, tornRelease);
  assert.equal(await f.admission.reserve({ ...f.reserve, jobId: otherJob, hold: 'TEST second' }), null);
  assert.deepEqual(parsePolicyLedger(await text(f)).rows.map(row => [row.contextHold, row.released]), [['TEST hold', false], ['TEST second', false]]);
});
for (const [label, value] of [['a complete malformed context line', `${tornHold}\n`], ['an unterminated line not shown to be a context line', '{"format":"dacs-node2-se']]) test(`${label} is still refused and kept`, async t => {
  const f = await fixture(t); await writeFile(f.evidencePath, value);
  await assert.rejects(f.admission.reserve(f.reserve), error => error.code === 'seller_context_ledger_unreadable');
  await assert.rejects(f.admission.release({ jobId: JOB, hold: f.reserve.hold }));
  assert.equal(await text(f), value);
});

// The hold is taken at 300. Each clock gives the attempt's five lines their times.
const clocks = { earlier: [290, 291, 292, 293, 294], forward: [290, 305, 310, 311, 312], equal: [300, 300, 300, 300, 300], later: [310, 311, 312, 313, 314], backward: [330, 320, 310, 290, 310] };
for (const [clock, times] of Object.entries(clocks)) {
  test(`a Vet attempt opened before a hold never takes its slot as it is approved, signed and spent (${clock} clock)`, async t => {
    const f = await fixture(t, { maxWritesPerHour: 2, maxTotalOsPerHour: '8' }), [opened, ...steps] = vetAttempt(times), second = { ...f.reserve, jobId: otherJob, hold: 'TEST second' };
    await writeFile(f.evidencePath, encode([opened[1]]));
    assert.equal(await f.admission.reserve(f.reserve), null);
    assert.deepEqual(await budget(f), { writes: 2, totalOs: 8n }, 'hold');
    for (const [step, row] of steps) {
      await appendFile(f.evidencePath, encode([row]));
      assert.deepEqual(await budget(f), { writes: 2, totalOs: 8n }, step);
      assert.equal(await f.admission.reserve(second), 'hourly-write-limit', step);
    }
    await f.admission.release({ jobId: JOB, hold: f.reserve.hold });
    assert.deepEqual(await budget(f), { writes: 1, totalOs: 4n }, 'released');
    assert.equal(await f.admission.reserve(second), null);
  });
  test(`a Vet attempt opened after a hold takes exactly one slot as it is approved, signed and spent (${clock} clock)`, async t => {
    const f = await fixture(t, { maxWritesPerHour: 2, maxTotalOsPerHour: '8' });
    assert.equal(await f.admission.reserve({ ...f.reserve, writes: 2 }), null);
    for (const [step, row] of vetAttempt(times)) {
      await appendFile(f.evidencePath, encode([row]));
      assert.deepEqual(await budget(f), { writes: 2, totalOs: 8n }, step);
    }
    await f.admission.release({ jobId: JOB, hold: f.reserve.hold });
    assert.deepEqual(await budget(f), { writes: 1, totalOs: 4n }, 'released');
  });
}
test('an earlier build\'s held confirmation of an attempt opened before a hold never takes its slot', async t => {
  const f = await fixture(t, { maxWritesPerHour: 2, maxTotalOsPerHour: '8' }), [[, opened], , , [, linked]] = vetAttempt(clocks.forward);
  await writeFile(f.evidencePath, encode([opened]));
  assert.equal(await f.admission.reserve(f.reserve), null);
  await appendFile(f.evidencePath, encode([{ ...linked, reservationId: id(5, 0) }]));
  assert.deepEqual(await budget(f), { writes: 2, totalOs: 8n });
  assert.equal(await f.admission.reserve({ ...f.reserve, jobId: otherJob, hold: 'TEST second' }), 'hourly-write-limit');
});
for (const released of ['TEST first', 'TEST second']) test(`two open holds of one job convert one slot per Vet write, and releasing ${released} keeps outstanding writes counted`, async t => {
  const f = await fixture(t);
  assert.equal(await f.admission.reserve({ ...f.reserve, writes: 2, hold: 'TEST first' }), null);
  assert.equal(await f.admission.reserve({ ...f.reserve, writes: 2, hold: 'TEST second' }), null);
  await appendFile(f.evidencePath, encode([vetWrite(0, 299)]));
  assert.deepEqual(await budget(f), { writes: 4, totalOs: 16n });
  await f.admission.release({ jobId: JOB, hold: released });
  assert.deepEqual(await budget(f), { writes: 2, totalOs: 8n });
});
test('two open holds of one job still exhaust its six-write cap', async t => {
  const f = await fixture(t);
  assert.equal(await f.admission.reserve({ ...f.reserve, writes: 3, hold: 'TEST first' }), null);
  assert.equal(await f.admission.reserve({ ...f.reserve, writes: 3, hold: 'TEST second' }), null);
  await appendFile(f.evidencePath, encode([vetWrite(0, 299)]));
  assert.equal(await f.admission.reserve({ ...f.reserve, hold: 'TEST third' }), 'job-write-limit');
});

for (const operation of ['distinct hold', 'identical hold', 'context release']) test(`a second process cannot perform ${operation} while a ledger transaction is reading`, { timeout: 15_000 }, async t => {
  const f = await fixture(t, { maxWritesPerHour: 1, maxTotalOsPerHour: '4' });
  const child = fork(new URL('./helpers/context-budget-worker.mjs', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } });
  const reading = once(child, 'message'); child.send({ config: f.config, reserve: f.reserve });
  assert.deepEqual((await reading)[0], { type: 'reading' });
  const work = () => operation === 'context release' ? f.admission.release({ jobId: JOB, hold: f.reserve.hold })
    : f.admission.reserve({ ...f.reserve, ...(operation === 'distinct hold' ? { jobId: otherJob, hold: 'TEST second' } : {}) });
  await assert.rejects(work(), error => error.code === 'seller_state_locked');
  await assert.rejects(readFile(f.evidencePath), error => error.code === 'ENOENT');
  const result = once(child, 'message'), exited = once(child, 'exit'); child.send({ type: 'continue' });
  assert.deepEqual((await result)[0], { type: 'result', value: null }); assert.equal((await exited)[0], 0);
  const retained = await text(f);
  assert.deepEqual(await budget(f), { writes: 1, totalOs: 4n });
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

test('final effect release covers only that effect and its resume owners',async t=>{
 const f=await fixture(t),base={...f.reserve,hold:effect};
 for(const hold of [effect,`${effect}:owner`,`${'b'.repeat(64)}:other`])assert.equal(await f.admission.reserve({...base,hold}),null);
 await f.admission.release({jobId:JOB,hold:effect});
 const rows=parsePolicyLedger(await text(f)).rows.filter(row=>row.contextHold);
 assert.equal(rows.find(row=>row.contextHold===effect).released,true);
 assert.equal(rows.find(row=>row.contextHold===`${effect}:owner`).released,true);
 assert.equal(rows.find(row=>row.contextHold===`${'b'.repeat(64)}:other`).released,false);
});
