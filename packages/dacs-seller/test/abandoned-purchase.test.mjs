// The session state the host reads when the operator supplies none: a purchase that retains no commitment work and holds no payment reads as
// aborted by the seller an hour after the later of its admission and its Agreement's deadline. A purchase that retains commitment work, holds
// a payment or has a proposal, commitment or payment attempt pending, and every other purchase, reads as unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { ABANDONED_PURCHASE_MS, createAbandonedPurchaseState } from '../src/dacs/abandoned-purchase.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';

const ADMITTED_AT = 1_000_000;
const AGREEMENT_DEADLINE = ADMITTED_AT + 2 * ABANDONED_PURCHASE_MS;
const { proposals, commitments, payments } = DACS_SELLER_HTTP_PATHS;
const LONG_AFTER = AGREEMENT_DEADLINE + 100 * ABANDONED_PURCHASE_MS;

/**
 * A reader over a settled row admitted at `ADMITTED_AT`. `states` maps a later route to its journal state (a route not named has no operation),
 * `deadline` is the Agreement's deadline the agent retains, `retainsCommitmentWork` and `holdsPayment` are what the agent answers (neither by
 * default), and `row`, `clock` and `operationState` replace the defaults.
 */
function reader({ states = {}, deadline = AGREEMENT_DEADLINE, retainsCommitmentWork = false, holdsPayment = false, row = {}, clock = ADMITTED_AT + ABANDONED_PURCHASE_MS, operationState } = {}) {
  const reads = [];
  const state = createAbandonedPurchaseState({
    admissionRecord: (jobId) => { reads.push(['row', jobId]); return { jobId, state: 'settled', admittedAt: ADMITTED_AT, ...row }; },
    operationState: operationState ?? (({ path }) => { reads.push(['operation', path]); return states[path] ?? 'none'; }),
    retainsCommitmentWork: (jobId) => (typeof retainsCommitmentWork === 'function' ? retainsCommitmentWork(jobId) : retainsCommitmentWork),
    holdsPayment: (jobId) => (typeof holdsPayment === 'function' ? holdsPayment(jobId) : holdsPayment),
    agreementDeadline: (jobId) => { reads.push(['deadline', jobId]); return deadline; },
    now: () => clock,
  });
  return { state, reads };
}
const read = (options) => reader(options).state({ jobId: JOB });
const HOUR_AFTER_DEADLINE = AGREEMENT_DEADLINE + ABANDONED_PURCHASE_MS;

test('a settled purchase with no later operation reads as aborted by the seller once an hour has passed', () => {
  assert.equal(read(), 'aborted-by-self');
});

test('a settled purchase younger than an hour reads as unknown', () => {
  const { state, reads } = reader({ clock: ADMITTED_AT + ABANDONED_PURCHASE_MS - 1 });
  assert.equal(state({ jobId: JOB }), null);
  assert.deepEqual(reads.filter(([kind]) => kind === 'operation'), [], 'no operation is inspected while the purchase is young');
});

test('a purchase whose payment attempt is pending reads as unknown at any age', () => {
  assert.equal(read({ states: { [payments]: 'pending', [proposals]: 'completed', [commitments]: 'completed' }, clock: LONG_AFTER }), null);
  assert.equal(read({ states: { [payments]: 'pending' }, clock: LONG_AFTER }), null);
});

test('a purchase that holds a recorded or retained payment reads as unknown at any age, whatever state its operations are in', () => {
  for (const state of ['pending', 'ended', 'completed']) {
    for (const states of [{}, { [payments]: state }, { [proposals]: 'completed', [payments]: state }, { [proposals]: 'completed', [commitments]: 'completed', [payments]: state }]) {
      assert.equal(read({ states, holdsPayment: true, clock: LONG_AFTER }), null, `${state} ${Object.keys(states)}`);
    }
  }
});

test('a payment refused with no effect on a purchase with no commitment work reads as aborted like one with no payment', () => {
  for (const state of ['ended', 'completed']) {
    const states = { [proposals]: 'completed', [payments]: state };
    assert.equal(read({ states, clock: HOUR_AFTER_DEADLINE - 1 }), null, `${state}: a commitment may still come before the deadline`);
    assert.equal(read({ states, clock: HOUR_AFTER_DEADLINE }), 'aborted-by-self', state);
  }
});

test('a purchase with a completed proposal and no commitment reads as aborted an hour after the Agreement deadline, and unknown before', () => {
  const states = { [proposals]: 'completed' };
  assert.equal(read({ states, clock: HOUR_AFTER_DEADLINE - 1 }), null);
  assert.equal(read({ states, clock: HOUR_AFTER_DEADLINE }), 'aborted-by-self');
});

test('a commitment attempt that ended or completed with a refusal and left no commitment work reads as aborted an hour after the deadline, and unknown before', () => {
  for (const state of ['ended', 'completed']) {
    for (const states of [{ [commitments]: state }, { [proposals]: 'completed', [commitments]: state }]) {
      assert.equal(read({ states, clock: HOUR_AFTER_DEADLINE - 1 }), null, `${state}: a commitment may still come before the deadline`);
      assert.equal(read({ states, clock: HOUR_AFTER_DEADLINE }), 'aborted-by-self', state);
      assert.equal(read({ states, clock: LONG_AFTER }), 'aborted-by-self', state);
    }
  }
});

test('a purchase that retains commitment work reads as unknown at any age, since a payment made before the deadline may be claimed late', () => {
  for (const state of ['none', 'pending', 'ended', 'completed']) {
    for (const states of [{ [commitments]: state }, { [proposals]: 'completed', [commitments]: state }]) {
      for (const clock of [AGREEMENT_DEADLINE - 1, AGREEMENT_DEADLINE, HOUR_AFTER_DEADLINE, LONG_AFTER]) {
        assert.equal(read({ states, retainsCommitmentWork: true, clock }), null, `${state} ${Object.keys(states)} at ${clock - AGREEMENT_DEADLINE}`);
      }
      for (const deadline of [null, NaN, ADMITTED_AT - 1]) {
        assert.equal(read({ states, deadline, retainsCommitmentWork: true, clock: LONG_AFTER }), null);
      }
    }
  }
});

test('a purchase with a proposal whose Agreement deadline is already behind its admission is aborted an hour after its admission', () => {
  assert.equal(read({ states: { [proposals]: 'completed' }, deadline: ADMITTED_AT - 1 }), 'aborted-by-self');
});

test('a purchase with proposal or commitment work still open reads as unknown at any age, even when no commitment work is retained yet', () => {
  for (const path of [proposals, commitments]) {
    assert.equal(read({ states: { [path]: 'pending' }, clock: LONG_AFTER }), null, path);
  }
});

test('a purchase past its first step whose Agreement deadline is unknown reads as unknown', () => {
  for (const deadline of [null, NaN, -1, 1.5, '3600']) {
    assert.equal(read({ states: { [proposals]: 'completed' }, deadline, clock: LONG_AFTER }), null, String(deadline));
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

test('a reader that cannot read the row, an operation, the commitment work, the payment or the deadline answers unknown rather than aborted', () => {
  const failing = (changes) => createAbandonedPurchaseState({ admissionRecord: () => ({ state: 'settled', admittedAt: ADMITTED_AT }), operationState: ({ path }) => path === proposals ? 'completed' : 'none',
    retainsCommitmentWork: () => false, holdsPayment: () => false, agreementDeadline: () => AGREEMENT_DEADLINE, now: () => LONG_AFTER, ...changes });
  const fails = () => { throw new Error('TEST the read failed'); };
  assert.equal(failing({})({ jobId: JOB }), 'aborted-by-self', 'control: the same reader with every read answering');
  for (const name of ['admissionRecord', 'operationState', 'retainsCommitmentWork', 'holdsPayment', 'agreementDeadline']) {
    assert.equal(failing({ [name]: fails })({ jobId: JOB }), null, name);
  }
  assert.equal(failing({ operationState: () => 'none', retainsCommitmentWork: fails })({ jobId: JOB }), null, 'a purchase with no proposal still asks what commitment work the seller retains');
});
