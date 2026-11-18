import test from 'node:test';
import assert from 'node:assert/strict';
import { createImmutableReadbacks, IMMUTABLE_READBACK_TTL_MS } from '../src/util/immutable-readbacks.mjs';

const input = { purchaseId: 'purchase-1', locator: 'tx-1', contentHash: 'hash-1', scope: { reader: 'node' } };

function readbacksOnClock(start) {
  const clock = { at: start };
  return { clock, readbacks: createImmutableReadbacks({ now: () => clock.at }) };
}

test('a cached readback is returned until the injected clock reaches the TTL, then it is dropped', () => {
  const { clock, readbacks } = readbacksOnClock(1000);
  readbacks.put(input, { verified: true });
  clock.at = 1000 + IMMUTABLE_READBACK_TTL_MS - 1;
  assert.deepEqual(readbacks.get(input), { verified: true });
  clock.at = 1000 + IMMUTABLE_READBACK_TTL_MS;
  assert.equal(readbacks.get(input), null);
  clock.at = 1000;
  assert.equal(readbacks.get(input), null, 'an expired entry is deleted, not hidden');
});

test('cache expiry follows the injected clock, not the global Date.now', (t) => {
  const { clock, readbacks } = readbacksOnClock(5000);
  readbacks.put(input, { verified: true });
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  Date.now = () => realNow() + 10 * IMMUTABLE_READBACK_TTL_MS;
  assert.deepEqual(readbacks.get(input), { verified: true });
  clock.at = 5000 + IMMUTABLE_READBACK_TTL_MS;
  assert.equal(readbacks.get(input), null);
});
