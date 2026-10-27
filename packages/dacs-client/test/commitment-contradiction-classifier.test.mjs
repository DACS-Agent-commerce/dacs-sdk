// the source change classifier: a commitment readback is rejected only on an authenticated
// contradiction, either a CounterpartyError (a signature the plugin's verifier
// finds invalid) or a permanent SDK fault after this plugin's anchor answered the
// receipt proof invalid (receiptContradicted). One value per category, with and
// without that mark. Review findings: PR the source change an earlier review, code P3-1 and a review P3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CounterpartyError, DacsError, NotImplementedError, SubstrateError, TransientError, UnsupportedCapabilityError } from '@kynesyslabs/dacs';
import * as classifier from '../src/devnet-demo/commitment-consumer.mjs';
const commitmentContradicted = (...args) => classifier.commitmentContradicted(...args);
import * as adapter from '../src/dacs/demos-sr2-adapter.mjs';
const { DemosSr2Error } = adapter;
const isDemosSr2Contradiction = (...args) => adapter.isDemosSr2Contradiction(...args);

// [label, value, rejected without the mark, rejected with it]
const cases = [
  ['null', null, false, false],
  ['undefined', undefined, false, false],
  ['a string', 'fetch failed', false, false],
  ['a number', 503, false, false],
  ['TypeError("fetch failed")', new TypeError('fetch failed'), false, false],
  ['a plain Error', new Error('boom'), false, false],
  ['a {category:"permanent"} look-alike', { category: 'permanent', message: 'commitment receipt proof is invalid' }, false, false],
  ['a {category:"counterparty"} look-alike', { category: 'counterparty', name: 'CounterpartyError' }, false, false],
  ['an adapter contradiction (not an SDK fault)', Object.assign(new DemosSr2Error('invalid', 'x'), { contradiction: true }), false, false],
  ['DacsError (permanent)', new DacsError('existing commitment binds different authenticated session content (CA-3/CA-7)'), false, true],
  ['TransientError', new TransientError('signature verification is uncertain'), false, false],
  ['SubstrateError', new SubstrateError('commitment receipt proof is not established (indeterminate)'), false, false],
  ['UnsupportedCapabilityError (permanent)', new UnsupportedCapabilityError('unsupported'), false, false],
  ['NotImplementedError (permanent)', new NotImplementedError('feature'), false, false],
  ['CounterpartyError', new CounterpartyError('finality-commitment signature is not verified (invalid)'), true, true],
];

for (const [label, value, plain, marked] of cases) {
  test(`commitmentContradicted: ${label}`, () => {
    assert.equal(commitmentContradicted(value), plain, 'without the receipt mark');
    assert.equal(commitmentContradicted(value, { receiptContradicted: false }), plain, 'mark false');
    assert.equal(commitmentContradicted(value, { receiptContradicted: true }), marked, 'with the receipt mark');
    assert.equal(commitmentContradicted(value, { recordContradicted: true }), marked, 'with the record mark');
    assert.equal(commitmentContradicted(value, { receiptContradicted: false, recordContradicted: false }), plain, 'both marks false');
  });
}

test('commitmentContradicted: only a literal true mark counts', () => {
  const permanent = new DacsError('commitment receipt proof is invalid');
  for (const mark of [1, 'true', {}, [], null, undefined]) {
    assert.equal(commitmentContradicted(permanent, { receiptContradicted: mark }), false, String(mark));
    assert.equal(commitmentContradicted(permanent, { recordContradicted: mark }), false, String(mark));
  }
});

test('isDemosSr2Contradiction: only the adapter\'s marked invalid error', () => {
  assert.equal(isDemosSr2Contradiction(Object.assign(new DemosSr2Error('invalid', 'x'), { contradiction: true })), true);
  for (const value of [new DemosSr2Error('invalid', 'x'), new DemosSr2Error('indeterminate', 'x'), Object.assign(new DemosSr2Error('invalid-chain', 'x'), { contradiction: true }),
    Object.assign(new Error('x'), { code: 'invalid', contradiction: true }), { code: 'invalid', contradiction: true }, null, 'invalid']) {
    assert.equal(isDemosSr2Contradiction(value), false, JSON.stringify(value) ?? String(value));
  }
});
