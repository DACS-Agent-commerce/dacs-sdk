// The session state the host reads when the operator supplies none: a purchase that has made no commitment and paid nothing reads as aborted
// by the seller an hour after the later of its admission and its Agreement's deadline. Every other purchase reads as unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { ABANDONED_PURCHASE_MS, createAbandonedPurchaseState } from '../src/dacs/abandoned-purchase.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';

const ADMITTED_AT = 1_000_000;
const AGREEMENT_DEADLINE = ADMITTED_AT + 2 * ABANDONED_PURCHASE_MS;
const { proposals, commitments, payments } = DACS_SELLER_HTTP_PATHS;

/**
 * A reader over a settled row admitted at `ADMITTED_AT`. `states` maps a later route to its journal state (a route not named has no operation),
 * `deadline` is the Agreement's deadline the agent retains, and `row`, `clock` and `operationState` replace the defaults.
 */
function reader({ states = {}, deadline = AGREEMENT_DEADLINE, row = {}, clock = ADMITTED_AT + ABANDONED_PURCHASE_MS, operationState } = {}) {
  const reads = [];
  const state = createAbandonedPurchaseState({
    admissionRecord: (jobId) => { reads.push(['row', jobId]); return { jobId, state: 'settled', admittedAt: ADMITTED_AT, ...row }; },
    operationState: operationState ?? (({ path }) => { reads.push(['operation', path]); return states[path] ?? 'none'; }),
    agreementDeadline: (jobId) => { reads.push(['deadline', jobId]); return deadline; },
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

test('a purchase with a started payment reads as unknown at any age', () => {
  for (const state of ['pending', 'ended', 'completed']) {
    assert.equal(reader({ states: { [payments]: state, [proposals]: 'completed', [commitments]: 'completed' }, clock: AGREEMENT_DEADLINE + 100 * ABANDONED_PURCHASE_MS }).state({ jobId: JOB }), null, state);
  }
});

test('a purchase with a completed proposal and no commitment reads as aborted an hour after the Agreement deadline, and unknown before', () => {
  const states = { [proposals]: 'completed' };
  assert.equal(reader({ states, clock: AGREEMENT_DEADLINE + ABANDONED_PURCHASE_MS - 1 }).state({ jobId: JOB }), null);
  assert.equal(reader({ states, clock: AGREEMENT_DEADLINE + ABANDONED_PURCHASE_MS }).state({ jobId: JOB }), 'aborted-by-self');
});

test('a committed purchase with no payment reads as unknown at any age, since a payment made before the deadline may be claimed late', () => {
  for (const state of ['pending', 'ended', 'completed']) {
    for (const states of [{ [commitments]: state }, { [proposals]: 'completed', [commitments]: state }]) {
      for (const clock of [AGREEMENT_DEADLINE - 1, AGREEMENT_DEADLINE, AGREEMENT_DEADLINE + ABANDONED_PURCHASE_MS, AGREEMENT_DEADLINE + 100 * ABANDONED_PURCHASE_MS]) {
        assert.equal(reader({ states, clock }).state({ jobId: JOB }), null, `${state} ${Object.keys(states).length} at ${clock - AGREEMENT_DEADLINE}`);
      }
      for (const deadline of [null, NaN, ADMITTED_AT - 1]) {
        assert.equal(reader({ states, deadline, clock: AGREEMENT_DEADLINE + 100 * ABANDONED_PURCHASE_MS }).state({ jobId: JOB }), null);
      }
    }
  }
});

test('a purchase with a proposal whose Agreement deadline is already behind its admission is aborted an hour after its admission', () => {
  assert.equal(reader({ states: { [proposals]: 'completed' }, deadline: ADMITTED_AT - 1 }).state({ jobId: JOB }), 'aborted-by-self');
});

test('a purchase with proposal or commitment work still open reads as unknown at any age', () => {
  for (const path of [proposals, commitments]) {
    assert.equal(reader({ states: { [path]: 'pending' }, clock: AGREEMENT_DEADLINE + 100 * ABANDONED_PURCHASE_MS }).state({ jobId: JOB }), null, path);
  }
});

test('a purchase past its first step whose Agreement deadline is unknown reads as unknown', () => {
  for (const deadline of [null, NaN, -1, 1.5, '3600']) {
    assert.equal(reader({ states: { [proposals]: 'completed' }, deadline, clock: AGREEMENT_DEADLINE + 100 * ABANDONED_PURCHASE_MS }).state({ jobId: JOB }), null, String(deadline));
  }
});

test('a job with no admission row, or a row that has not settled, reads as unknown', () => {
  const missing = createAbandonedPurchaseState({ admissionRecord: () => null, operationState: () => 'none', agreementDeadline: () => null, now: () => ADMITTED_AT + ABANDONED_PURCHASE_MS });
  assert.equal(missing({ jobId: JOB }), null);
  for (const state of ['intent', 'admitted', 'running', 'compensating', 'aborted']) {
    assert.equal(reader({ row: { state } }).state({ jobId: JOB }), null, state);
  }
  assert.equal(reader({ row: { admittedAt: null } }).state({ jobId: JOB }), null, 'a row with no admission time');
});

test('a reader that cannot read the row, an operation or the deadline answers unknown rather than aborted', () => {
  const failing = (changes) => createAbandonedPurchaseState({ admissionRecord: () => ({ state: 'settled', admittedAt: ADMITTED_AT }), operationState: ({ path }) => path === proposals ? 'completed' : 'none', agreementDeadline: () => AGREEMENT_DEADLINE,
    now: () => AGREEMENT_DEADLINE + 100 * ABANDONED_PURCHASE_MS, ...changes });
  const fails = () => { throw new Error('TEST the read failed'); };
  assert.equal(failing({ admissionRecord: fails })({ jobId: JOB }), null);
  assert.equal(failing({ operationState: fails })({ jobId: JOB }), null);
  assert.equal(failing({ agreementDeadline: fails })({ jobId: JOB }), null);
});
