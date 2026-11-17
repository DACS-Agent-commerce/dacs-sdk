// The session state the host reads when the operator supplies none: a purchase that settled its context step and started nothing after it
// reads as aborted by the seller once an hour has passed. Every other purchase reads as unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { ABANDONED_PURCHASE_MS, createAbandonedPurchaseState } from '../src/dacs/abandoned-purchase.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';

const ADMITTED_AT = 1_000_000;
const LATER_PATHS = [DACS_SELLER_HTTP_PATHS.proposals, DACS_SELLER_HTTP_PATHS.commitments, DACS_SELLER_HTTP_PATHS.payments];

/** A reader over a settled row admitted at `ADMITTED_AT`; `started` names the later routes with an operation, `row`, `clock` and `operationState` replace the defaults. */
function reader({ started = [], row = {}, clock = ADMITTED_AT + ABANDONED_PURCHASE_MS, operationState } = {}) {
  const reads = [];
  const state = createAbandonedPurchaseState({
    admissionRecord: (jobId) => { reads.push(['row', jobId]); return { jobId, state: 'settled', admittedAt: ADMITTED_AT, ...row }; },
    operationState: operationState ?? (({ path }) => { reads.push(['operation', path]); return started.includes(path) ? 'completed' : 'none'; }),
    now: () => clock,
  });
  return { state, reads };
}

test('a settled purchase with no later operation reads as aborted by the seller once an hour has passed', () => {
  assert.equal(reader().state({ jobId: JOB }), 'aborted-by-self');
});

test('a settled purchase younger than an hour reads as unknown', () => {
  const { state, reads } = reader({ clock: ADMITTED_AT + ABANDONED_PURCHASE_MS - 1 });
  assert.equal(state({ jobId: JOB }), null);
  assert.deepEqual(reads.filter(([kind]) => kind === 'operation'), [], 'no operation is inspected while the purchase is young');
});

test('a purchase that started a proposal, a commitment or a payment reads as unknown at any age', () => {
  for (const path of LATER_PATHS) {
    assert.equal(reader({ started: [path], clock: ADMITTED_AT + 100 * ABANDONED_PURCHASE_MS }).state({ jobId: JOB }), null, path);
  }
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
