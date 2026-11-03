// How a failed bounded read is classified: only the admission bounds' own
// failures are a reply-limit, a reader's own error is a reader failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readRetainedBounded, readFailureCode } from '../src/dacs/bounded-reads.mjs';

const MAX_BYTES = 64 * 1024, MAX_VALUES = 4096, MAX_LIST_ITEMS = 256;
const anchorReplying = (reply) => ({ readRetained: async () => reply });
const failureOf = (reply) => readRetainedBounded(anchorReplying(reply), { logicalAddress: 'TEST' }).then(() => assert.fail('the read must fail'), (failure) => failure);

for (const [bound, reply] of [
  ['byte limit', { status: 'absent', padding: 'x'.repeat(MAX_BYTES + 1) }],
  ['value limit', { status: 'absent', values: Object.fromEntries(Array.from({ length: MAX_VALUES + 1 }, (_, index) => [`k${index}`, 0])) }],
  ['list limit', { status: 'absent', list: new Array(MAX_LIST_ITEMS + 1).fill(0) }],
  ['byte limit of a raw reply', new Uint8Array(MAX_BYTES + 1)],
]) {
  test(`a reply over the ${bound} is a reply-limit failure with a neutral message`, async () => {
    const failure = await failureOf(reply);
    assert.equal(readFailureCode(failure), 'reply-limit');
    assert.doesNotMatch(failure.message, /revocation/);
  });
}

test('a RangeError the reader throws itself is a reader failure, also when wrapped', () => {
  const own = new RangeError('TEST reader range');
  assert.deepEqual([readFailureCode(own), readFailureCode(new Error('TEST wrapper', { cause: own }))], ['reader', 'reader']);
});

test('a reply-limit failure keeps its code when another error wraps it', async () => {
  const failure = await failureOf({ status: 'absent', padding: 'x'.repeat(MAX_BYTES + 1) });
  assert.equal(readFailureCode(new Error('TEST wrapper', { cause: failure })), 'reply-limit');
});

test('a timeout is a timeout, also when wrapped, and any other error is a reader failure', () => {
  const timeout = new DOMException('TEST deadline', 'TimeoutError');
  assert.deepEqual([readFailureCode(timeout), readFailureCode(new Error('TEST wrapper', { cause: timeout })), readFailureCode(new Error('TEST other'))], ['timeout', 'timeout', 'reader']);
});
