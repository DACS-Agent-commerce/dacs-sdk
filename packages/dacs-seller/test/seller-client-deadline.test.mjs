// The kit client's own deadline: a wall clock step does not end it, and a timeout the client could not honour is refused before
// anything is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSellerAgentClient } from '../src/dacs/seller-http.mjs';

const CLIENT_TIMEOUT_MS = 5_000;
const ANSWER = '{"ok":true}';
const JSON_HEADERS = { 'content-type': 'application/json' };

for (const jumpMs of [-60_000, 60_000]) {
  test(`the client deadline ignores a ${jumpMs} ms wall clock step while the response is awaited`, async (t) => {
    let wallMs = Date.now();
    t.mock.method(Date, 'now', () => wallMs);
    const client = createSellerAgentClient({
      url: 'http://127.0.0.1:1',
      timeoutMs: CLIENT_TIMEOUT_MS,
      fetchImpl: async () => { wallMs += jumpMs; return new Response(ANSWER, { status: 200, headers: JSON_HEADERS }); },
    });
    assert.deepEqual(await client.propose({}), { ok: true });
  });
}

test('the client deadline: a timeout that is not an integer from 1 to 2^31 - 1 is refused at construction', () => {
  const clientWith = (timeoutMs) => createSellerAgentClient({ url: 'http://127.0.0.1:1', timeoutMs, fetchImpl: async () => new Response(ANSWER, { status: 200, headers: JSON_HEADERS }) });
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, '5000']) {
    assert.throws(() => clientWith(timeoutMs), TypeError, String(timeoutMs));
  }
  for (const timeoutMs of [1, 2 ** 31 - 1]) assert.doesNotThrow(() => clientWith(timeoutMs), String(timeoutMs));
});
