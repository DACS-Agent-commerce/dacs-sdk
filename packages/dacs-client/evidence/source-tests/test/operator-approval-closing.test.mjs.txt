import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExactOperatorApproval } from '../src/devnet-demo/operator-approval.mjs';
import { createOperatorApprovalAttempt } from '../src/devnet-demo/operator-custody.mjs';

// A shutdown cut is not an operator decision: the manual approval throws
// operator_closing, writes no evidence line (never `rejected`), and ignores a
// later answer; the custody turns the wallet's answer for that request into
// operator_closing only while nothing was signed.
const OPERATOR_CLOSING = 'operator_closing';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const request = (n) => ({ method: 'sendTransaction', address: `0x${'ab'.repeat(32)}`, content: { artifactKind: 'SettlementEvidence', jobId: `closing-job-${n}`, debit: { totalOs: '1000' } } });
const lines = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
async function evidencePath(t) {
  const root = await mkdtemp(join(tmpdir(), 'approval-closing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'evidence', 'seller-approvals.jsonl');
}

test('a waiting manual approval cut by its signal throws operator_closing and records nothing, and a late answer changes nothing', async t => {
  const path = await evidencePath(t), stop = new AbortController(), answer = deferred(), asked = deferred();
  let calls = 0;
  const approve = createExactOperatorApproval({ maxTotalOs: '10000000000', evidencePath: path, signal: stop.signal, now: () => 1,
    authorize: () => { calls++; asked.resolve(); return answer.promise; } });
  const first = approve(request(1));
  await asked.promise;
  stop.abort();
  await assert.rejects(first, { code: OPERATOR_CLOSING });
  answer.resolve(true);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(lines(path), [], 'no decision line, approved or rejected');
  // After the cut a new approval is not asked at all.
  await assert.rejects(approve(request(2)), { code: OPERATOR_CLOSING });
  assert.equal(calls, 1);
  assert.deepEqual(lines(path), []);
});

test('an operator answer is still recorded as before: approved and rejected lines are decisions, not cuts', async t => {
  const path = await evidencePath(t), stop = new AbortController();
  const approve = createExactOperatorApproval({ maxTotalOs: '10000000000', evidencePath: path, signal: stop.signal, now: () => 1, authorize: ({ request: r }) => r.content.jobId === 'closing-job-1' });
  assert.equal(await approve(request(1)), true);
  assert.equal(await approve(request(2)), false);
  assert.deepEqual(lines(path).map(line => line.decision), ['approved', 'rejected']);
});

test('a function signal is asked for each approval, so an approval asked later gets its own signal', async t => {
  const path = await evidencePath(t), signals = [];
  const approve = createExactOperatorApproval({ maxTotalOs: '10000000000', evidencePath: path, now: () => 1, authorize: () => true,
    signal: () => { const controller = new AbortController(); signals.push(controller); if (signals.length === 2) controller.abort(); return controller.signal; } });
  assert.equal(await approve(request(1)), true);
  await assert.rejects(approve(request(2)), { code: OPERATOR_CLOSING }, 'the second ask got an aborted signal');
  assert.equal(await approve(request(3)), true, 'the third ask got a live one');
  assert.equal(signals.length, 3);
  assert.deepEqual(lines(path).map(line => line.decision), ['approved', 'approved']);
  assert.throws(() => createExactOperatorApproval({ maxTotalOs: '1', evidencePath: path, signal: 'stop' }), /AbortSignal/);
});

// The terminal prompt (no authorize callback) on a piped stdin that the child
// reports as a TTY: the cut ends the prompt as operator_closing, records
// nothing, and the exact APPROVE typed afterwards is ignored.
test('the terminal prompt cut by its signal ends as operator_closing and ignores a late exact APPROVE', { timeout: 60000 }, async t => {
  const path = await evidencePath(t);
  const module = new URL('../src/devnet-demo/operator-approval.mjs', import.meta.url).href;
  const source = `
    import { createExactOperatorApproval } from ${JSON.stringify(module)};
    process.stdin.isTTY = true; process.stdout.isTTY = true;
    const stop = new AbortController();
    const approve = createExactOperatorApproval({ maxTotalOs: '10000000000', evidencePath: ${JSON.stringify(path)}, signal: stop.signal, now: () => 1 });
    const asked = approve(${JSON.stringify(request(1))}).then(v => v, e => e.code);
    process.stdout.write('ASKED\\n');
    process.once('SIGUSR2', () => stop.abort());
    const first = await asked;
    process.stdout.write('FIRST ' + first + '\\n');
    await new Promise(r => process.stdin.once('data', r).resume());
    process.stdout.write('LATE-SEEN\\n');
    process.exit(0);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', d => { out += d; });
  child.stderr.setEncoding('utf8').on('data', d => { err += d; });
  const until = async (pattern) => { for (let i = 0; i < 400 && !pattern.test(out + err); i++) await new Promise(r => setTimeout(r, 25)); assert.match(out + err, pattern); };
  await until(/Type APPROVE ([0-9a-f]{64})/);
  const hash = (out + err).match(/Type APPROVE ([0-9a-f]{64})/)[1];
  child.kill('SIGUSR2');
  await until(/FIRST /);
  child.stdin.write(`APPROVE ${hash}\n`);
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.equal(code, 0, out + err);
  assert.match(out, /^FIRST operator_closing$/m, out + err);
  assert.match(out, /^LATE-SEEN$/m, 'the late answer reached the process');
  assert.deepEqual(lines(path), [], 'nothing recorded, before or after the late APPROVE');
});

test('the custody reports operator_closing for a wallet request whose approval was cut before anything was sent, and nothing else', async () => {
  const closing = () => { throw Object.assign(new Error('cut'), { code: OPERATOR_CLOSING }); };
  const internal = { success: false, data: null, error: { code: 'internal_error', message: 'the embedded wallet could not complete the request' } };
  // The wallet answers a thrown approval with internal_error.
  const wallet = (attempt, { sentFirst = false } = {}) => attempt.run(async () => {
    if (sentFirst) attempt.issuing({ stage: 'broadcast-started' });
    try { await attempt.approve({}); } catch { return internal; }
    return { success: true, data: {} };
  });
  const cut = await wallet(createOperatorApprovalAttempt(closing));
  assert.equal(cut.success, false);
  assert.equal(cut.error.code, OPERATOR_CLOSING);
  // Once the issuance marker exists the request may have reached the node:
  // the answer is left as the wallet gave it.
  assert.deepEqual(await wallet(createOperatorApprovalAttempt(closing), { sentFirst: true }), internal);
  // Any other thrown approval is not a cut.
  assert.deepEqual(await wallet(createOperatorApprovalAttempt(() => { throw new Error('other'); })), internal);
  // A settled approval still reports its outcome to settle().
  const settled = [];
  const approve = Object.assign(async () => true, { settle: async (r, outcome) => { settled.push(outcome); } });
  assert.deepEqual(await wallet(createOperatorApprovalAttempt(approve)), { success: true, data: {} });
  assert.deepEqual(settled, ['released']);
});
