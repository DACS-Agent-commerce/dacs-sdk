// The kit client's own deadline: a response that arrives after it is refused as a timeout before verification starts,
// and a timeout the client could not honour is refused before anything is sent.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSellerAgentClient } from '../src/dacs/seller-http.mjs';

const CLIENT_TIMEOUT_MS = 5_000;
const LATE_MS = CLIENT_TIMEOUT_MS + 30;
const ANSWER = '{"ok":true}';
const JSON_HEADERS = { 'content-type': 'application/json' };

// The client's deadline runs on `performance.now()`, so the tests move that clock together with the mocked timers.
let elapsedMs = 0;
function advance(ms) {
  mock.timers.tick(ms);
  elapsedMs += ms;
}

/**
 * A client whose `fetchImpl` moves the mocked clock by `ticksMs` before it answers, and a verifier that counts its calls.
 * `body` supplies the response body; by default the whole answer arrives with the headers.
 */
function clientAfter(ticksMs, { verify = () => ({}), body, timeoutMs = CLIENT_TIMEOUT_MS } = {}) {
  const calls = { fetch: 0, verify: 0 };
  const client = createSellerAgentClient({
    url: 'http://127.0.0.1:1',
    timeoutMs,
    fetchImpl: async () => {
      calls.fetch += 1;
      if (body === undefined) advance(ticksMs);
      return new Response(body === undefined ? ANSWER : body(), { status: 200, headers: JSON_HEADERS });
    },
    authentication: {
      request: async () => ({ header: 'fixture', payload: {} }),
      verifyResponse: (...args) => { calls.verify += 1; return verify(...args); },
    },
  });
  return { client, calls };
}

/** A body whose bytes end only after the mocked clock has moved by `ticksMs`. */
const bodyEndingAfter = (ticksMs) => () => new ReadableStream({
  pull(controller) {
    advance(ticksMs);
    controller.enqueue(new TextEncoder().encode(ANSWER));
    controller.close();
  },
});

test('the client deadline: a response that arrives after the deadline, or exactly at it, is refused as a timeout before verification starts; one millisecond before it is accepted', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  elapsedMs = 0;
  t.mock.method(performance, 'now', () => elapsedMs);
  const timedOut = { code: 'seller_unavailable', causeCode: 'timeout' };

  const late = clientAfter(LATE_MS);
  await assert.rejects(late.client.propose({}), timedOut, 'a late response with a synchronous verifier');
  assert.deepEqual(late.calls, { fetch: 1, verify: 0 });

  const lateAsync = clientAfter(LATE_MS, { verify: async () => ({}) });
  await assert.rejects(lateAsync.client.propose({}), timedOut, 'a late response with an asynchronous verifier');
  assert.deepEqual(lateAsync.calls, { fetch: 1, verify: 0 });

  const atDeadline = clientAfter(CLIENT_TIMEOUT_MS);
  await assert.rejects(atDeadline.client.propose({}), timedOut, 'a response that arrives with no time left');
  assert.deepEqual(atDeadline.calls, { fetch: 1, verify: 0 });

  const lateBody = clientAfter(0, { body: bodyEndingAfter(LATE_MS) });
  await assert.rejects(lateBody.client.propose({}), timedOut, 'headers in time, body ended late');
  assert.deepEqual(lateBody.calls, { fetch: 1, verify: 0 });

  const inTime = clientAfter(CLIENT_TIMEOUT_MS - 1);
  assert.deepEqual(await inTime.client.propose({}), { ok: true }, 'one millisecond left is enough');
  assert.deepEqual(inTime.calls, { fetch: 1, verify: 1 });

  assert.deepEqual(unhandled, [], 'no rejection is left unhandled');
});

for (const jumpMs of [-60_000, 60_000]) {
  test(`the client deadline ignores a ${jumpMs} ms wall clock step while the response is awaited`, async (t) => {
    let wallMs = Date.now();
    t.mock.method(Date, 'now', () => wallMs);
    const client = createSellerAgentClient({
      url: 'http://127.0.0.1:1',
      timeoutMs: CLIENT_TIMEOUT_MS,
      fetchImpl: async () => { wallMs += jumpMs; return new Response(ANSWER, { status: 200, headers: JSON_HEADERS }); },
      authentication: { request: async () => ({ header: 'fixture', payload: {} }), verifyResponse: async () => ({}) },
    });
    assert.deepEqual(await client.propose({}), { ok: true });
  });
}

test('the client deadline: a timeout that is not an integer from 1 to 2^31 - 1 is refused at construction', () => {
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, '5000']) {
    assert.throws(() => clientAfter(0, { timeoutMs }), TypeError, String(timeoutMs));
  }
  for (const timeoutMs of [1, 2 ** 31 - 1]) assert.doesNotThrow(() => clientAfter(0, { timeoutMs }), String(timeoutMs));
});
