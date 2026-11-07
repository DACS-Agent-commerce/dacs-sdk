import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '@kynesyslabs/dacs';
import { canonicalJson, IntentMismatch } from '../src/public/portal-intent/intent.mjs';

// CORE §B.2 CF-5: a top-level container has depth 1; depth 128 is admitted, 129 is refused.
const MAX_CONTAINER_DEPTH = 128;
const wrap = (depth, step) => {
  let value = null;
  for (let level = 0; level < depth; level += 1) value = step(value, level);
  return value;
};
const arrays = depth => wrap(depth, inner => [inner]);
const objects = depth => wrap(depth, inner => ({ value: inner }));
const mixed = depth => wrap(depth, (inner, level) => (level % 2 === 0 ? { value: inner } : [inner]));
const FAMILIES = [['arrays', arrays], ['objects', objects], ['mixed', mixed]];

for (const [family, build] of FAMILIES) {
  test(`canonicalJson admits nesting depth 128 of ${family}`, () => {
    const value = build(MAX_CONTAINER_DEPTH);
    assert.doesNotThrow(() => canonicalJson(value));
    assert.equal(canonicalJson(value), canonicalize(value));
  });
  test(`canonicalJson refuses nesting depth 129 of ${family}`, () => {
    assert.throws(() => canonicalJson(build(MAX_CONTAINER_DEPTH + 1)), IntentMismatch);
  });
}

test('canonicalJson refuses very deep input with IntentMismatch, not a stack error', () => {
  assert.throws(() => canonicalJson(arrays(200_000)), IntentMismatch);
});
