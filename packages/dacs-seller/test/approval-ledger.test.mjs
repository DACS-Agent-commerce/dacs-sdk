import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256Hex } from '@kynesyslabs/dacs';
import { parsePolicyLedger, withContextHolds, heldPolicyBudget, SELLER_POLICY_WINDOW_MS, SELLER_LEDGER_HEADER_FORMAT, SELLER_ISSUANCE_JOURNALS } from '../src/devnet-demo/operator-approval.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';
const CONTEXT = 'dacs-node2-seller-context-admission/v1', SIGN = 'dacs-node2-seller-policy-sign-authorization/v1', EVIDENCE = 'dacs-node2-operator-approval-evidence/v1', ATTEMPT = 'dacs-node2-seller-policy-attempt/v1';
const reservationId = '00000000-0000-4000-8000-000000000001', attemptId = '00000000-0000-4000-8000-000000000002';
const requestBytes = JSON.stringify({ content: { jobId: JOB, artifactKind: 'CompositeVerificationRecord', debit: { totalOs: '4' } } }), approvalHash = sha256Hex(requestBytes);
const signRow = { format: SIGN, reservationId, approvalHash, requestBytes, totalOs: '4', recordedAt: 100 };
const hold = { format: CONTEXT, event: 'hold', holdId: 'TEST hold', jobId: JOB, effect: 'a'.repeat(64), writes: 2, totalOs: '4', recordedAt: 100 };
const completion = { format: ATTEMPT, reservationId, approvalHash, outcome: 'spent', recordedAt: 200 };
const confirmation = { format: EVIDENCE, decision: 'approved', approvalMode: 'policy', reservationId, confirmation: true, approvalHash, requestBytes, totalOs: '6', recordedAt: 101 };
const parse = rows => parsePolicyLedger(rows.map(row => JSON.stringify(row)).join('\n'));
const budget = (rows, at = 201) => heldPolicyBudget(withContextHolds(rows), at);

test('equal-time approvals before a context hold cannot consume its slots', () => {
  const first = parse([signRow, hold]), after = parse([hold, signRow]);
  assert.deepEqual(budget(first.rows), { writes: 3, totalOs: 12n }); assert.deepEqual(budget(after.rows), { writes: 2, totalOs: 8n });
});
for (const recordedAt of [99, 100, 101]) for (const order of ['before', 'after']) test(`projected attempt at ${recordedAt} ${order} a context hold cannot use synthetic equal-time order`, () => {
  const attempt = { format: EVIDENCE, decision: 'rejected', approvalMode: 'policy', policyReason: 'seller-record-missing', attemptId, approvalHash, requestBytes, recordedAt };
  const rows = parse(order === 'before' ? [attempt, hold] : [hold, attempt]).rows;
  assert.deepEqual(budget(rows), recordedAt > hold.recordedAt ? { writes: 2, totalOs: 8n } : { writes: 3, totalOs: 12n });
});
for (const totalOs of [4, [4], null, 9007199254740993]) for (const kind of ['context', 'sign', 'confirmation']) test(`${kind} amount refuses non-string ${JSON.stringify(totalOs)}`, () => {
  const rows = kind === 'context' ? [{ ...hold, totalOs }] : kind === 'sign' ? [{ ...signRow, totalOs }] : [signRow, { ...confirmation, totalOs }];
  assert.throws(() => parse(rows));
});
for (const recordedAt of [-1, 99]) test(`context release cannot precede its hold (${recordedAt})`, () => {
  assert.throws(() => parse([hold, { format: CONTEXT, event: 'release', holdId: hold.holdId, jobId: JOB, recordedAt }]));
});
test('header precedes every nonblank entry including ignored refusal entries', () => {
  const header = { format: SELLER_LEDGER_HEADER_FORMAT, journals: Object.fromEntries(SELLER_ISSUANCE_JOURNALS.map(name => [name, 'a'.repeat(32)])), recordedAt: 101 };
  assert.equal(parse([header, hold]).header.format, SELLER_LEDGER_HEADER_FORMAT);
  for (const row of [hold, { format: CONTEXT, event: 'refused', jobId: JOB, buyer: 'TEST buyer', reason: 'TEST limit', recordedAt: 100 }]) assert.throws(() => parse([row, header]));
});
test('unfinished signatures remain held across restart; confirmation counts larger debit once', () => {
  assert.deepEqual(budget(parse([signRow]).rows, 9e12), { writes: 1, totalOs: 4n });
  const result = parse([signRow, confirmation]); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].confirmed, 'approved'); assert.deepEqual(budget(result.rows), { writes: 1, totalOs: 6n });
});
test('spent reservations expire from completion; released ones stop counting immediately', () => {
  const rows = parse([signRow, confirmation, completion]).rows;
  assert.deepEqual(budget(rows, 200 + SELLER_POLICY_WINDOW_MS - 1), { writes: 1, totalOs: 6n });
  assert.deepEqual(budget(rows, 200 + SELLER_POLICY_WINDOW_MS), { writes: 0, totalOs: 0n });
  assert.deepEqual(budget(parse([signRow, { ...completion, outcome: 'released', reason: 'wallet-released' }]).rows), { writes: 0, totalOs: 0n });
});
test('held manual attempt converts once at signature authority and completes once', () => {
  const held = { format: EVIDENCE, decision: 'rejected', approvalMode: 'policy', policyReason: 'seller-record-missing', attemptId, approvalHash, requestBytes, recordedAt: 90 };
  const manual = { format: EVIDENCE, decision: 'approved', attemptId, approvalHash, requestBytes, recordedAt: 91 };
  assert.deepEqual(budget(parse([held, manual]).rows), { writes: 1, totalOs: 4n });
  const authorized = { ...signRow, attemptId }, completed = { ...completion, attemptId };
  const final = parse([held, manual, authorized, completed]); assert.equal(final.attempts.get(attemptId).outcome, 'spent'); assert.deepEqual(budget(final.rows), { writes: 1, totalOs: 4n });
  assert.throws(() => parse([held, manual, authorized, completed, completed]));
});
test('duplicate, mismatched and early completion cannot erase a live reservation', () => {
  for (const changed of [{ ...completion, approvalHash: 'b'.repeat(64) }, { ...completion, recordedAt: 99 }, { ...completion, reservationId: attemptId }]) assert.throws(() => parse([signRow, changed]));
  assert.throws(() => parse([signRow, completion, completion]));
});
test('original JSON failure retains its type and ledger line', () => {
  assert.throws(() => parsePolicyLedger(JSON.stringify(signRow) + '\n{'), error => error instanceof SyntaxError && error.ledgerLine === 2);
});
