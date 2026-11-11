// The manual operator approver records and returns approval only for the exact
// request bytes the operator was asked about. If the caller's request changes
// while the answer is pending, the approval is refused; on approval the request
// is frozen, as the seller package's approver does.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { createExactOperatorApproval, OPERATOR_CLOSING } from '../src/devnet-demo/operator-approval.mjs';

const MAX_TOTAL_OS = '4000000000', DECLARED_OS = '1000000000', FAR_ABOVE_LIMIT_OS = '900000000000000';
const requestOf = () => ({ method: 'sendTransaction', address: '0x' + '1'.repeat(64), purpose: 'store a record',
  content: { jobId: 'TEST-job', debit: { totalOs: DECLARED_OS, note: 'test debit' } } });

let directory, evidencePath;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'client-approval-bytes-')); evidencePath = join(directory, 'evidence', 'approvals.jsonl'); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const approverFor = (authorize, extra = {}) => createExactOperatorApproval({ maxTotalOs: MAX_TOTAL_OS, evidencePath, authorize, ...extra });
const evidenceLines = () => existsSync(evidencePath) ? readFileSync(evidencePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const assertRefusedWithoutApprovalLine = (request, originalBytes) => {
  const lines = evidenceLines();
  assert.equal(lines.some((line) => line.decision === 'approved'), false);
  assert.deepEqual(lines.map((line) => [line.decision, line.requestBytes, line.address]), [['rejected', originalBytes, JSON.parse(originalBytes).address]]);
  assert.equal(Object.isFrozen(request), false);
  assert.equal(Object.isFrozen(request.content.debit), false);
};

test('a callback that raises the total on the caller request while the answer is pending is refused', async () => {
  const request = requestOf(), originalBytes = JSON.stringify(request);
  const approve = approverFor(async () => { request.content.debit.totalOs = FAR_ABOVE_LIMIT_OS; return true; });
  assert.equal(await approve(request), false);
  assertRefusedWithoutApprovalLine(request, originalBytes);
});

test('code running while the answer is pending that changes the caller request is refused', async () => {
  const request = requestOf(), originalBytes = JSON.stringify(request);
  let reachAnswer;
  const asked = new Promise((resolveAsked) => { reachAnswer = resolveAsked; });
  const approve = approverFor(() => new Promise((resolveAnswer) => reachAnswer(resolveAnswer)));
  const deciding = approve(request);
  const resolveAnswer = await asked;
  request.address = '0x' + '2'.repeat(64);
  resolveAnswer(true);
  assert.equal(await deciding, false);
  assertRefusedWithoutApprovalLine(request, originalBytes);
});

test('an unchanged request is approved, recorded with its exact bytes and frozen', async () => {
  const request = requestOf(), originalBytes = JSON.stringify(request);
  const approve = approverFor(async () => true);
  assert.equal(await approve(request), true);
  assert.deepEqual(evidenceLines().map((line) => [line.decision, line.requestBytes]), [['approved', originalBytes]]);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen(request.content), true);
  assert.equal(Object.isFrozen(request.content.debit), true);
});

test('editing only the clone given to the callback still approves and freezes the caller request', async () => {
  const request = requestOf(), originalBytes = JSON.stringify(request);
  const approve = approverFor(async ({ request: shown }) => { shown.content.debit.totalOs = FAR_ABOVE_LIMIT_OS; return true; });
  assert.equal(await approve(request), true);
  assert.deepEqual(evidenceLines().map((line) => [line.decision, line.requestBytes]), [['approved', originalBytes]]);
  assert.equal(request.content.debit.totalOs, DECLARED_OS);
  assert.equal(Object.isFrozen(request.content.debit), true);
});

test('a callback answer of false is recorded as rejected and leaves the request unfrozen', async () => {
  const request = requestOf(), originalBytes = JSON.stringify(request);
  const approve = approverFor(async () => false);
  assert.equal(await approve(request), false);
  assertRefusedWithoutApprovalLine(request, originalBytes);
});

test('a request over the operator budget is refused without asking', async () => {
  const request = requestOf();
  request.content.debit.totalOs = FAR_ABOVE_LIMIT_OS;
  let asked = false;
  const approve = approverFor(async () => { asked = true; return true; });
  assert.equal(await approve(request), false);
  assert.equal(asked, false);
  assert.equal(existsSync(evidencePath), false);
  assert.equal(Object.isFrozen(request), false);
});

test('a stop while the answer is pending still ends with operator_closing and records nothing', async () => {
  const request = requestOf(), stop = new AbortController();
  let askedResolve;
  const asked = new Promise((resolveAsked) => { askedResolve = resolveAsked; });
  const approve = approverFor(() => { askedResolve(); return new Promise(() => {}); }, { signal: stop.signal });
  const deciding = approve(request);
  await asked;
  stop.abort();
  await assert.rejects(deciding, { code: OPERATOR_CLOSING });
  assert.equal(existsSync(evidencePath), false);
  assert.equal(Object.isFrozen(request), false);
});
