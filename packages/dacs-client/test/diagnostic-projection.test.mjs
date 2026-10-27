import test from 'node:test';
import assert from 'node:assert/strict';
import { DIAGNOSTIC_LIMITS, DIAGNOSTIC_OMITTED, projectDiagnostic, projectDiagnosticOperation } from '../src/diagnostic-projection.mjs';

const REPLAY = 'TEST-replay-material';

test('projection omits values deeper than the depth limit', () => {
  let nested = 'TEST-leaf';
  for (let level = 0; level <= DIAGNOSTIC_LIMITS.depth; level++) nested = { nested };
  let cursor = projectDiagnostic(nested);
  for (let level = 0; level < DIAGNOSTIC_LIMITS.depth; level++) cursor = cursor.nested;
  assert.equal(cursor, DIAGNOSTIC_OMITTED);
});

test('projection keeps a long list to its limit and marks the omission', () => {
  const list = projectDiagnostic(Array.from({ length: DIAGNOSTIC_LIMITS.collectionItems + 5 }, (_, index) => index));
  assert.equal(list.length, DIAGNOSTIC_LIMITS.collectionItems + 1);
  assert.equal(list.at(-1), DIAGNOSTIC_OMITTED);
});

test('projection replaces a record with too many fields', () => {
  const record = Object.fromEntries(Array.from({ length: DIAGNOSTIC_LIMITS.collectionItems + 1 }, (_, index) => [`field${index}`, index]));
  assert.equal(projectDiagnostic({ record }).record, DIAGNOSTIC_OMITTED);
});

test('projection replaces a string over the string limit and keeps one at the limit', () => {
  const projected = projectDiagnostic({ atLimit: 'a'.repeat(DIAGNOSTIC_LIMITS.stringChars), over: 'a'.repeat(DIAGNOSTIC_LIMITS.stringChars + 1) });
  assert.equal(projected.atLimit.length, DIAGNOSTIC_LIMITS.stringChars);
  assert.equal(projected.over, DIAGNOSTIC_OMITTED);
});

test('projection spends one shared output budget across many mid-sized strings', () => {
  const strings = Array.from({ length: DIAGNOSTIC_LIMITS.collectionItems }, () => 'y'.repeat(DIAGNOSTIC_LIMITS.stringChars));
  const projected = projectDiagnostic({ first: strings, second: strings, third: strings });
  assert.ok(JSON.stringify(projected).length <= DIAGNOSTIC_LIMITS.outputChars);
  assert.equal(projected.third.at(-1), DIAGNOSTIC_OMITTED);
});

test('projection stays within the output limit for wide, deep and escaped content', () => {
  const escaped = '"\n\u0000'.repeat(DIAGNOSTIC_LIMITS.stringChars / 3 | 0);
  const wide = Array.from({ length: DIAGNOSTIC_LIMITS.collectionItems }, () => ({ key: Array.from({ length: DIAGNOSTIC_LIMITS.collectionItems }, () => escaped) }));
  assert.ok(JSON.stringify(projectDiagnostic({ wide, again: wide })).length <= DIAGNOSTIC_LIMITS.outputChars);
});

test('projection never copies signing or replay keys at any depth', () => {
  const saved = { id: 'TEST-id', payload: REPLAY, nested: { message: REPLAY, deeper: [{ signature: REPLAY, planned: REPLAY, keep: 'TEST-kept' }] }, payloadHash: 'TEST-hash' };
  const projected = projectDiagnostic(saved);
  assert.doesNotMatch(JSON.stringify(projected), new RegExp(REPLAY));
  assert.deepEqual(projected, { id: 'TEST-id', nested: { deeper: [{ keep: 'TEST-kept' }] }, payloadHash: 'TEST-hash' });
});

test('projection drops host objects, functions and unsafe numbers and keeps own __proto__ keys as data', () => {
  const saved = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
  const projected = projectDiagnostic({ saved, date: new Date(0), call() {}, big: 1n, nan: NaN, plain: [null, true, 'TEST'] });
  assert.deepEqual(Object.keys(projected).sort(), ['plain', 'saved']);
  assert.equal(Object.getPrototypeOf(projected.saved), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(projected.saved, '__proto__').value, { polluted: true });
  assert.equal(projected.saved.polluted, undefined);
  assert.deepEqual(projected.plain, [null, true, 'TEST']);
});

test('operation projection keeps the listed state fields and returns a fresh copy', () => {
  const operation = { id: 'TEST-op', status: 'approved', terms: { price: { amountOs: '1' } },
    state: { unlisted: { value: 1 }, preparedVerification: { evidence: { chainMode: 'TEST' } },
      protocol: { stage: 'delivered', revision: 2, planned: { agreementMessage: REPLAY }, buyerBundle: { payload: REPLAY }, identity: { message: REPLAY },
        sessionDelegation: { signature: REPLAY }, claim: { id: 'TEST-claim' } } } };
  const projected = projectDiagnosticOperation(operation);
  assert.deepEqual(projected, { id: 'TEST-op', status: 'approved', terms: { price: { amountOs: '1' } },
    state: { preparedVerification: { evidence: { chainMode: 'TEST' } }, protocol: { stage: 'delivered', revision: 2, claim: { id: 'TEST-claim' } } } });
  projected.state.protocol.stage = 'TEST-changed';
  assert.equal(operation.state.protocol.stage, 'delivered');
});

test('operation projection of a non-record state yields an empty state', () => {
  assert.deepEqual(projectDiagnosticOperation({ id: 'TEST-op', state: 'TEST-not-a-record' }), { id: 'TEST-op', state: {} });
});

for (const [name, project] of [
  ['value', projectDiagnostic],
  ['operation', value => projectDiagnosticOperation({ state: { protocol: { listing: value } } }).state.protocol.listing],
]) {
  test(`${name} projection refuses overlong record keys`, () => {
    for (const key of ['x'.repeat(200000), '\u0000'.repeat(DIAGNOSTIC_LIMITS.stringChars + 1)]) {
      const projected = project({ [key]: 'TEST-value' });
      assert.equal(Object.hasOwn(projected, key), false);
      assert.match(JSON.stringify(projected), /omitted/);
      assert.ok(JSON.stringify(projected).length <= DIAGNOSTIC_LIMITS.outputChars);
    }
    const key = 'x'.repeat(DIAGNOSTIC_LIMITS.stringChars);
    assert.equal(project({ [key]: 'TEST-value' })[key], 'TEST-value');
  });

  test(`${name} projection checks escaped record keys against the remaining budget`, () => {
    const record = Object.fromEntries(Array.from({ length: DIAGNOSTIC_LIMITS.collectionItems }, (_, index) =>
      ['\u0000'.repeat(DIAGNOSTIC_LIMITS.stringChars - 2) + index, null]));
    const projected = project(record);
    assert.ok(JSON.stringify(projected).length <= DIAGNOSTIC_LIMITS.outputChars);
    assert.match(JSON.stringify(projected), /omitted/);
  });
}

test('saved bundle signatures are removed by both projections', () => {
  const bundle = { bundleHash: 'TEST-hash', finalisedAt: 123, buyerSignature: REPLAY, sellerSignature: REPLAY,
    copies: [{ buyerSignature: REPLAY, sellerSignature: REPLAY, ref: 'TEST-copy' }] };
  const operation = { id: 'TEST-op', state: { protocol: { bundle } } };
  const expected = { bundleHash: 'TEST-hash', finalisedAt: 123, copies: [{ ref: 'TEST-copy' }] };
  assert.deepEqual(projectDiagnostic(operation).state.protocol.bundle, expected);
  assert.deepEqual(projectDiagnosticOperation(operation).state.protocol.bundle, expected);
  assert.equal(bundle.buyerSignature, REPLAY);
  assert.equal(bundle.sellerSignature, REPLAY);
});

// Full lists of the same JSON value, nested `levels` deep.
function filled(leaf, levels) {
  let value = leaf;
  for (let level = 0; level < levels; level++) value = Array(DIAGNOSTIC_LIMITS.collectionItems).fill(value);
  return JSON.parse(JSON.stringify(value));
}
const assertWithinOutput = value => {
  const chars = JSON.stringify(value).length;
  assert.ok(chars <= DIAGNOSTIC_LIMITS.outputChars, `${chars} JSON characters`);
};
for (const [name, leaf, levels] of [
  ['empty lists', [], 3], ['empty lists', [], 4], ['empty records', {}, 3], ['false', false, 3],
  ['true', true, 3], ['null', null, 3], ['numbers', -1.5e-300, 3], ['empty strings', '', 3],
]) {
  test(`projection charges container syntax and every scalar: ${levels} levels of ${name}`, () => {
    const projected = projectDiagnostic(filled(leaf, levels));
    assertWithinOutput(projected);
    assert.match(JSON.stringify(projected), /omitted/);
  });
}

test('an operation projection charges container syntax in every allowed protocol field', () => {
  const fields = ['notSaved', 'revision', 'agreement', 'commitment', 'claim', 'paymentEvidence', 'delivery', 'bundle',
    'nativeEvidence', 'attempts', 'deliveryDeadline', 'storageGap', 'agreementContext'];
  const protocol = Object.fromEntries(fields.map(field => [field, filled([], 2)]));
  assertWithinOutput(projectDiagnosticOperation({ id: 'TEST-op', state: { protocol: { ...protocol, stage: 'TEST-stage', listing: filled(false, 3) } } }));
});
