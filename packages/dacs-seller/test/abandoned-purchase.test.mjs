// The session state the host reads when the operator supplies none: a settled purchase reads as aborted by the seller once no payment can
// still come for it (an hour after admission with no proposal or commitment, past its Agreement deadline with no commitment, an hour past
// that deadline with a commitment). A purchase with a payment operation, and every other purchase, reads as unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { ABANDONED_PURCHASE_MS, createAbandonedPurchaseState } from '../src/dacs/abandoned-purchase.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';

const ADMITTED_AT = 1_000_000;
const DEADLINE = ADMITTED_AT + 2 * ABANDONED_PURCHASE_MS;
const { proposals: PROPOSALS, commitments: COMMITMENTS, payments: PAYMENTS } = DACS_SELLER_HTTP_PATHS;

/**
 * A reader over a settled row admitted at `ADMITTED_AT` whose Agreement's deadline is `DEADLINE`; `started` names the later routes with an
 * operation (in `operation`'s state), `row`, `clock`, `operationState` and `agreementDeadline` replace the defaults.
 */
function reader({ started = [], operation = 'completed', row = {}, clock = ADMITTED_AT + ABANDONED_PURCHASE_MS, operationState, agreementDeadline = () => DEADLINE } = {}) {
  const reads = [];
  const state = createAbandonedPurchaseState({
    admissionRecord: (jobId) => { reads.push(['row', jobId]); return { jobId, state: 'settled', admittedAt: ADMITTED_AT, ...row }; },
    operationState: operationState ?? (({ path }) => { reads.push(['operation', path]); return started.includes(path) ? operation : 'none'; }),
    agreementDeadline: (jobId) => { reads.push(['deadline', jobId]); return agreementDeadline(jobId); },
    now: () => clock,
  });
  return { state, reads };
}
const at = (clock, options) => reader({ ...options, clock }).state({ jobId: JOB });

test('a settled purchase with no later operation reads as aborted by the seller once an hour has passed', () => {
  assert.equal(reader().state({ jobId: JOB }), 'aborted-by-self');
});

test('a settled purchase younger than an hour reads as unknown', () => {
  const { state, reads } = reader({ clock: ADMITTED_AT + ABANDONED_PURCHASE_MS - 1 });
  assert.equal(state({ jobId: JOB }), null);
  assert.deepEqual(reads.filter(([kind]) => kind === 'operation'), [], 'no operation is inspected while the purchase is young');
});

test('a purchase with a payment operation in any state reads as unknown at any age', () => {
  for (const operation of ['pending', 'ended', 'completed']) {
    for (const started of [[PAYMENTS], [PROPOSALS, PAYMENTS], [PROPOSALS, COMMITMENTS, PAYMENTS]]) {
      assert.equal(at(DEADLINE + 100 * ABANDONED_PURCHASE_MS, { started, operation }), null, `${operation} ${started}`);
    }
  }
});

test('a purchase with a proposal and no commitment reads as aborted once its Agreement deadline has passed', () => {
  for (const operation of ['pending', 'ended', 'completed']) {
    const options = { started: [PROPOSALS], operation };
    assert.equal(at(DEADLINE - 1, options), null, `${operation}: a commitment may still come before the deadline`);
    assert.equal(at(DEADLINE, options), 'aborted-by-self', operation);
  }
});

test('a purchase with a proposal and no retained Agreement reads as aborted an hour after its admission', () => {
  for (const agreementDeadline of [() => null, () => undefined, () => 'later']) {
    assert.equal(at(ADMITTED_AT + ABANDONED_PURCHASE_MS - 1, { started: [PROPOSALS], agreementDeadline }), null);
    assert.equal(at(ADMITTED_AT + ABANDONED_PURCHASE_MS, { started: [PROPOSALS], agreementDeadline }), 'aborted-by-self');
  }
});

test('a committed purchase with no payment operation reads as aborted only an hour after its Agreement deadline', () => {
  for (const operation of ['pending', 'ended', 'completed']) {
    for (const started of [[COMMITMENTS], [PROPOSALS, COMMITMENTS]]) {
      assert.equal(at(DEADLINE, { started, operation }), null, `${operation} ${started}: the deadline itself`);
      assert.equal(at(DEADLINE + ABANDONED_PURCHASE_MS - 1, { started, operation }), null, `${operation} ${started}: a claim may still arrive`);
      assert.equal(at(DEADLINE + ABANDONED_PURCHASE_MS, { started, operation }), 'aborted-by-self', `${operation} ${started}`);
    }
  }
});

test('a committed purchase whose Agreement deadline cannot be read reads as unknown at any age', () => {
  const unreadable = [() => null, () => 'later', () => { throw new Error('TEST the session read failed'); }];
  for (const agreementDeadline of unreadable) {
    assert.equal(at(DEADLINE + 100 * ABANDONED_PURCHASE_MS, { started: [PROPOSALS, COMMITMENTS], agreementDeadline }), null);
  }
  const { state, reads } = reader({ started: [PROPOSALS], agreementDeadline: () => { throw new Error('TEST the session read failed'); } });
  assert.equal(state({ jobId: JOB }), null, 'a deadline read that throws is unknown with no commitment too');
  assert.ok(reads.some(([kind]) => kind === 'deadline'));
});

test('a job with no admission row, or a row that has not settled, reads as unknown', () => {
  const missing = createAbandonedPurchaseState({ admissionRecord: () => null, operationState: () => 'none', now: () => ADMITTED_AT + ABANDONED_PURCHASE_MS });
  assert.equal(missing({ jobId: JOB }), null);
  for (const state of ['intent', 'admitted', 'running', 'compensating', 'aborted']) {
    assert.equal(reader({ row: { state } }).state({ jobId: JOB }), null, state);
  }
  assert.equal(reader({ row: { admittedAt: null } }).state({ jobId: JOB }), null, 'a row with no admission time');
});

test('a reader that cannot read the row or an operation answers unknown rather than aborted', () => {
  const rowFails = createAbandonedPurchaseState({ admissionRecord: () => { throw new Error('TEST the row read failed'); }, operationState: () => 'none', now: () => ADMITTED_AT + ABANDONED_PURCHASE_MS });
  assert.equal(rowFails({ jobId: JOB }), null);
  assert.equal(reader({ operationState: () => { throw new Error('TEST the journal read failed'); } }).state({ jobId: JOB }), null);
});
