import test from 'node:test';
import assert from 'node:assert/strict';
import { DIAGNOSTIC_LIMITS, DIAGNOSTIC_OMITTED, projectDiagnostic, projectDiagnosticOperation } from '../src/diagnostic-projection.mjs';

const REPLAY = 'TEST-replay-material';
const { stringChars, collectionItems, depth, outputChars } = DIAGNOSTIC_LIMITS;
const SIGNING_NAMES = ['payload', 'message', 'agreementMessage', 'anchorMessage', 'rootBinding', 'planned', 'buyerBundle', 'rawTransaction'];
const OVERLONG_KEY = 'x'.repeat(stringChars + 1);
// Each way a value reaches the projection: directly, or inside an allowed protocol field of an operation.
const THROUGH = [
  ['value', value => projectDiagnostic(value), whole => whole],
  ['operation', value => projectDiagnosticOperation({ id: 'TEST-op', state: { protocol: { listing: value } } }), whole => whole.state.protocol.listing],
];

// Full lists of the same value, nested `levels` deep.
function filled(leaf, levels) {
  let value = leaf;
  for (let level = 0; level < levels; level++) value = Array(collectionItems).fill(value);
  return value;
}
// Within the output limit, plain JSON, and identical after a JSON round trip.
function assertSound(projected) {
  const text = JSON.stringify(projected);
  assert.ok(text.length <= outputChars, `${text.length} JSON characters`);
  assert.deepEqual(JSON.parse(text), projected);
  assert.equal(JSON.stringify(JSON.parse(text)), text);
}
function assertNoSigningKeys(value) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/signature/i.test(key) && !SIGNING_NAMES.includes(key), `signing key ${key} copied`);
    assertNoSigningKeys(child);
  }
}

test('projection omits values deeper than the depth limit', () => {
  let nested = 'TEST-leaf';
  for (let level = 0; level <= depth; level++) nested = { nested };
  let cursor = projectDiagnostic(nested);
  for (let level = 0; level < depth; level++) cursor = cursor.nested;
  assert.equal(cursor, DIAGNOSTIC_OMITTED);
});

test('projection keeps a long list to its limit and marks the omission', () => {
  const list = projectDiagnostic(Array.from({ length: collectionItems + 1 }, (_, index) => index));
  assert.deepEqual(list, [...Array.from({ length: collectionItems }, (_, index) => index), DIAGNOSTIC_OMITTED]);
});

test('projection replaces a record with too many fields', () => {
  const record = Object.fromEntries(Array.from({ length: collectionItems + 1 }, (_, index) => [`field${index}`, index]));
  assert.equal(projectDiagnostic({ record }).record, DIAGNOSTIC_OMITTED);
});

test('projection replaces a string over the string limit and keeps one at the limit', () => {
  const projected = projectDiagnostic({ atLimit: 'a'.repeat(stringChars), over: 'a'.repeat(stringChars + 1) });
  assert.deepEqual(projected, { atLimit: 'a'.repeat(stringChars), over: DIAGNOSTIC_OMITTED });
});

test('projection spends one shared output budget across many mid-sized strings', () => {
  const strings = Array(collectionItems).fill('y'.repeat(stringChars));
  const projected = projectDiagnostic({ first: strings, second: strings, third: strings });
  assertSound(projected);
  assert.deepEqual(projected.first, strings);
  assert.equal(projected.second.at(-1), DIAGNOSTIC_OMITTED);
  assert.deepEqual(Object.keys(projected), ['first', 'second', DIAGNOSTIC_OMITTED]);
});

test('projection stays within the output limit for wide, deep and escaped content', () => {
  const escaped = '"\n\u0000'.repeat(stringChars / 3 | 0);
  const wide = Array(collectionItems).fill({ key: Array(collectionItems).fill(escaped) });
  assertSound(projectDiagnostic({ wide, again: wide }));
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
  assert.equal(projectDiagnostic(() => 0), undefined);
});

test('projection reads own data only and never calls a getter', () => {
  const record = { kept: 'TEST-kept' };
  const list = ['TEST-kept'];
  const explode = { enumerable: true, get() { throw new Error('getter called'); } };
  Object.defineProperty(record, 'computed', explode);
  Object.defineProperty(list, 1, explode);
  assert.deepEqual(projectDiagnostic({ record, list }), { record: { kept: 'TEST-kept' }, list: ['TEST-kept'] });
});

test('projection returns a fresh copy and leaves its input unchanged', () => {
  const saved = { list: [{ value: 'TEST' }], [OVERLONG_KEY]: 1, payload: REPLAY };
  const before = structuredClone(saved);
  const projected = projectDiagnostic(saved);
  assert.deepEqual(saved, before);
  assert.notEqual(projected.list, saved.list);
  assert.notEqual(projected.list[0], saved.list[0]);
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

for (const [name, protocol] of [['list', [{ private: REPLAY, identity: { key: REPLAY } }]], ['string', REPLAY], ['number', 5], ['null', null]]) {
  test(`operation projection of a ${name} protocol state yields an empty protocol`, () => {
    assert.deepEqual(projectDiagnosticOperation({ id: 'TEST-op', state: { protocol } }), { id: 'TEST-op', state: { protocol: {} } });
  });
}

for (const [name, operation] of [['string', REPLAY], ['list', [{ state: { protocol: { identity: { key: REPLAY } } } }]], ['null', null]]) {
  test(`operation projection refuses a ${name} operation`, () => {
    assert.throws(() => projectDiagnosticOperation(operation), TypeError);
  });
}

for (const [name, project, part] of THROUGH) {
  test(`${name} projection refuses overlong record keys`, () => {
    for (const key of ['x'.repeat(200000), '\u0000'.repeat(stringChars + 1)]) {
      const projected = project({ [key]: 'TEST-value' });
      assertSound(projected);
      assert.deepEqual(part(projected), { [DIAGNOSTIC_OMITTED]: DIAGNOSTIC_OMITTED });
    }
    const key = 'x'.repeat(stringChars);
    assert.equal(part(project({ [key]: 'TEST-value' }))[key], 'TEST-value');
  });

  test(`${name} projection checks escaped record keys against the remaining budget`, () => {
    const record = Object.fromEntries(Array.from({ length: collectionItems }, (_, index) => ['\u0000'.repeat(stringChars - 2) + index, null]));
    const projected = project(record);
    assertSound(projected);
    assert.equal(part(projected)[DIAGNOSTIC_OMITTED], DIAGNOSTIC_OMITTED);
  });

  test(`${name} projection removes every listed signing name at the top and nested`, () => {
    for (const key of SIGNING_NAMES) {
      const projected = part(project({ [key]: REPLAY, nested: [{ [key]: { inner: REPLAY }, keep: 'TEST-kept' }] }));
      assert.deepEqual(projected, { nested: [{ keep: 'TEST-kept' }] }, key);
    }
  });

  test(`${name} projection keeps a real omitted field when a record is cut short`, () => {
    assert.deepEqual(part(project({ omitted: 'TEST-real', [OVERLONG_KEY]: 1, after: 2 })), { omitted: 'TEST-real', [DIAGNOSTIC_OMITTED]: DIAGNOSTIC_OMITTED });
  });
}

test('operation projection removes every listed signing name from top-level operation fields', () => {
  for (const key of SIGNING_NAMES) assert.deepEqual(projectDiagnosticOperation({ id: 'TEST-op', [key]: REPLAY }), { id: 'TEST-op', state: {} }, key);
});

test('projecting a projection keeps exactly one marker and drops a forged marker field', () => {
  const once = projectDiagnostic({ a: 1, [OVERLONG_KEY]: 1 });
  const twice = projectDiagnostic({ operation: once });
  assert.deepEqual(twice, { operation: once });
  assert.equal(JSON.stringify(twice).split(JSON.stringify(DIAGNOSTIC_OMITTED)).length - 1, 2);
  assert.deepEqual(projectDiagnostic({ [DIAGNOSTIC_OMITTED]: 'TEST-forged', keep: 1 }), { keep: 1 });
});

test('dropped list items leave no marker and dropped record values spend no budget', () => {
  assert.deepEqual(projectDiagnostic([1, () => 0, 2]), [1, 2]);
  assert.deepEqual(projectDiagnostic([() => 0, 1n, NaN, new Date(0)]), []);
  const list = projectDiagnostic(Array.from({ length: collectionItems + 1 }, (_, index) => index === 3 ? () => 0 : index));
  assert.equal(list.length, collectionItems);
  assert.deepEqual(list.filter(item => item === DIAGNOSTIC_OMITTED), [DIAGNOSTIC_OMITTED]);
  assert.equal(list.at(-1), DIAGNOSTIC_OMITTED);
  const dropped = Object.fromEntries(Array.from({ length: collectionItems }, (_, index) => ['f'.repeat(stringChars - 2) + index, () => 0]));
  const fields = Object.fromEntries(Array.from({ length: 15 }, (_, index) => ['k'.repeat(stringChars - 2) + index, dropped]));
  assert.equal(projectDiagnostic({ ...fields, keep: 'TEST-kept' }).keep, 'TEST-kept');
});

test('both projections remove saved bundle signatures without changing the input', () => {
  const bundle = { bundleHash: 'TEST-hash', finalisedAt: 123, buyerSignature: REPLAY, sellerSignature: REPLAY,
    copies: [{ buyerSignature: REPLAY, sellerSignature: REPLAY, ref: 'TEST-copy' }] };
  const operation = { id: 'TEST-op', state: { protocol: { bundle } } };
  const expected = { bundleHash: 'TEST-hash', finalisedAt: 123, copies: [{ ref: 'TEST-copy' }] };
  assert.deepEqual(projectDiagnostic(operation).state.protocol.bundle, expected);
  assert.deepEqual(projectDiagnosticOperation(operation).state.protocol.bundle, expected);
  assert.equal(bundle.buyerSignature, REPLAY);
  assert.equal(bundle.sellerSignature, REPLAY);
});

// The four DACS-1 IdentityBundle presentation kinds; every one carries a signature.
for (const [presentation, kept] of [
  [{ kind: 'siwd', message: REPLAY, signature: REPLAY, address: 'TEST-address' }, { kind: 'siwd', address: 'TEST-address' }],
  [{ kind: 'per-claim', signatures: [{ ref: 'TEST-ref', signature: REPLAY }] }, { kind: 'per-claim' }],
  [{ kind: 'session-key', key: 'TEST-key', signature: REPLAY, rootBinding: REPLAY }, { kind: 'session-key', key: 'TEST-key' }],
  [{ kind: 'sr1-root', rootClaim: 'TEST-root', aggregateSignature: REPLAY }, { kind: 'sr1-root', rootClaim: 'TEST-root' }],
]) {
  test(`both projections remove the signatures of a ${presentation.kind} identity presentation`, () => {
    const operation = { id: 'TEST-op', state: { protocol: { listing: { presentedBy: 'TEST-ref', presentation } } } };
    for (const projected of [projectDiagnostic(operation), projectDiagnosticOperation(operation)]) {
      assert.deepEqual(projected.state.protocol.listing, { presentedBy: 'TEST-ref', presentation: kept });
    }
  });
}

test('both projections remove every field named as a signature', () => {
  const agreement = { delegationSignature: REPLAY, countersignature: REPLAY, presentationSignature: REPLAY, Signature: REPLAY,
    signatureBytes: REPLAY, agreementHash: 'TEST-hash' };
  const operation = { id: 'TEST-op', state: { protocol: { agreement } } };
  for (const projected of [projectDiagnostic(operation), projectDiagnosticOperation(operation)]) {
    assert.deepEqual(projected.state.protocol.agreement, { agreementHash: 'TEST-hash' });
  }
});

for (const [name, leaf, levels] of [
  ['empty lists', [], 3], ['empty lists', [], 4], ['empty records', {}, 3], ['false', false, 3], ['true', true, 3],
  ['null', null, 3], ['numbers', -1.5e-300, 3], ['empty strings', '', 3], ['records with an overlong key', { [OVERLONG_KEY]: 1 }, 3],
  ['records with a long string', { a: 'x'.repeat(1000), b: 1, c: 2 }, 3],
]) {
  test(`projection writes ${levels} levels of ${name} within the output limit`, () => {
    for (const [, project] of THROUGH) {
      const projected = project(filled(leaf, levels));
      assertSound(projected);
      assert.match(JSON.stringify(projected), /omitted/);
    }
  });
}

test('an operation with every allowed protocol field full stays within the output limit', () => {
  const fields = ['notSaved', 'revision', 'agreement', 'commitment', 'claim', 'paymentEvidence', 'delivery', 'bundle',
    'nativeEvidence', 'attempts', 'deliveryDeadline', 'storageGap', 'agreementContext'];
  const protocol = Object.fromEntries(fields.map(field => [field, filled([], 2)]));
  assertSound(projectDiagnosticOperation({ id: 'TEST-op', state: { protocol: { ...protocol, stage: 'TEST-stage', listing: filled(false, 3) } } }));
  const cutRecords = filled({ [OVERLONG_KEY]: 1 }, 2);
  const full = { listing: cutRecords, agreement: cutRecords, commitment: cutRecords, claim: cutRecords };
  const operation = projectDiagnosticOperation({ id: 'TEST-op', state: { protocol: full } });
  assertSound(operation);
  assertSound(projectDiagnostic({ operation }));
});

// Fills all but about 1,800 characters of the output, then moves the cut across every offset
// relative to the brackets, separators, keys and markers of the shape that follows.
const FILLER = Array(collectionItems - 1).fill('y'.repeat(stringChars));
const ADVERSARIAL = [
  ['overlong-key records', filled({ [OVERLONG_KEY]: 1 }, 3)], ['empty lists', filled([], 4)], ['empty records', filled({}, 3)],
  ['escaped strings', filled('\u0000"'.repeat(20), 3)], ['escaped keys', filled({ ['\u0001'.repeat(40)]: 'TEST' }, 3)],
  ['short scalars', filled([null, true, -1.5e-300, ''], 3)],
];
for (const [name, rest] of ADVERSARIAL) {
  test(`every cut offset within ${name} stays sound`, () => {
    for (let pad = 0; pad <= 300; pad++) {
      for (const [, project, part] of THROUGH) {
        const projected = project({ first: FILLER, second: FILLER, pad: 'x'.repeat(pad), rest });
        assertSound(projected);
        assert.equal(part(projected)[DIAGNOSTIC_OMITTED], DIAGNOSTIC_OMITTED);
      }
    }
  });
}

// A seeded generator mixing every token kind, cut records, escaped keys, lone surrogates and every limit.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}
const SCALARS = [null, true, false, 0, -1.5e-300, 1e21, NaN, Infinity, 1n, undefined, () => 0, new Date(0), '', 'TEST',
  '"\\\n\u0000'.repeat(256), '\ud800', '\udfff\ud800', 'y'.repeat(stringChars), 'y'.repeat(stringChars + 1), DIAGNOSTIC_OMITTED];
const KEYS = ['a', 'b', 'omitted', DIAGNOSTIC_OMITTED, '__proto__', 'signature', 'payload', OVERLONG_KEY,
  '\u0000'.repeat(stringChars), '\ud800', 'k'.repeat(stringChars)];
function generate(next, level) {
  const choose = list => list[Math.floor(next() * list.length)];
  const roll = next();
  if (level > depth + 1 || roll < 0.3) return choose(SCALARS);
  const width = choose([0, 1, 3, collectionItems, collectionItems + 1]);
  const shared = width > 3 || next() < 0.5 ? generate(next, level + 1) : undefined;
  const child = () => shared === undefined ? generate(next, level + 1) : shared;
  if (roll < 0.65) return Array.from({ length: width }, child);
  return Object.fromEntries(Array.from({ length: width }, (_, index) => [next() < 0.5 ? choose(KEYS) : `k${index}`, child()]));
}

test('seeded mixed inputs always project sound and without signing keys', () => {
  const next = seeded(376);
  for (let index = 0; index < 200; index++) {
    const value = generate(next, 0);
    for (const [, project] of THROUGH) {
      const projected = project(value);
      if (projected === undefined) continue;
      assertSound(projected);
      assertNoSigningKeys(projected);
    }
  }
});
