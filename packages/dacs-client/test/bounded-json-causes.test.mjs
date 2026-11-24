// Bounded JSON reads classify every interruption the same way: a deadline is
// kind 'timeout' with the deadline's own TimeoutError as cause, any other body
// failure is kind 'unavailable' with the original error as cause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBoundedJson } from '../src/util/http.mjs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';

const JSON_HEADERS = { 'content-type': 'application/json' };
const VALID_BODY = new TextEncoder().encode('{"ok":true}');
const never = () => new Promise(() => {});
const SETTLE_LIMIT_MS = 2000;
const DEADLINE_MS = 5;
// Fails the test, instead of hanging it, when work does not settle on its own.
const settles = async (work) => {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('did not settle')), SETTLE_LIMIT_MS); })]);
  } finally { clearTimeout(timer); }
};
const bounded = (fetchImpl, options = {}) => fetchBoundedJson('https://rpc.invalid/', { timeoutMs: DEADLINE_MS, maxBytes: 1024, fetchImpl, ...options });
const rejection = (work) => settles(work).then(() => assert.fail('expected a rejection'), (error) => error);
const afterAbort = (signal) => new Promise((resolve) => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
const isDeadlineTimeout = (error) => error.kind === 'timeout' && error.cause?.name === 'TimeoutError';
// A response whose body yields `first` and then runs `finish` for its next read.
const bodyThen = (finish) => {
  let reads = 0;
  return { status: 200, ok: true, headers: new Headers(JSON_HEADERS), body: {
    getReader: () => ({ read: async () => (reads++ === 0 ? { done: false, value: VALID_BODY } : finish()), cancel: async () => {} }),
    cancel: async () => {},
  } };
};

test('a stalled fetch and a stalled body each reject with kind timeout and the deadline TimeoutError as cause', async () => {
  const stalledFetch = await rejection(bounded(never));
  assert.ok(isDeadlineTimeout(stalledFetch), `${stalledFetch.kind} ${stalledFetch.cause}`);
  const stalledBody = await rejection(bounded(async () => bodyThen(never)));
  assert.ok(isDeadlineTimeout(stalledBody), `${stalledBody.kind} ${stalledBody.cause}`);
});

test('a body error mid-stream keeps kind unavailable and the original error as cause', async () => {
  const failure = new Error('connection reset');
  let reads = 0;
  const body = new ReadableStream({ pull(controller) { if (reads++ === 0) controller.enqueue(VALID_BODY.subarray(0, 4)); else controller.error(failure); } });
  const error = await rejection(bounded(async () => new Response(body, { headers: JSON_HEADERS })));
  assert.equal(error.kind, 'unavailable');
  assert.equal(error.cause, failure);
});

test('an abort right after headers and an abort after the final chunk get the same classification and never become JSON', async () => {
  const afterHeaders = await rejection(bounded(async (_url, init) => {
    await afterAbort(init.signal);
    return new Response(VALID_BODY, { headers: JSON_HEADERS });
  }));
  const afterFinalChunk = await rejection(bounded(async (_url, init) => bodyThen(async () => { await afterAbort(init.signal); return { done: true, value: undefined }; })));
  for (const error of [afterHeaders, afterFinalChunk]) assert.ok(isDeadlineTimeout(error), `${error.kind} ${error.cause}`);
  assert.equal(afterHeaders.message, afterFinalChunk.message);

  const callerStop = new AbortController();
  const reason = new Error('caller stopped');
  const callerAfterHeaders = rejection(bounded(async () => { callerStop.abort(reason); return new Response(VALID_BODY, { headers: JSON_HEADERS }); }, { signal: callerStop.signal, timeoutMs: 10_000 }));
  assert.equal(await callerAfterHeaders, reason);
  const lateStop = new AbortController();
  const callerAfterFinalChunk = rejection(bounded(async () => bodyThen(async () => { lateStop.abort(reason); return { done: true, value: undefined }; }), { signal: lateStop.signal, timeoutMs: 10_000 }));
  assert.equal(await callerAfterFinalChunk, reason);
});

test('a late response or late error after the deadline leaves the rejection kind and cause unchanged', async () => {
  let deliver;
  const lateResponse = bounded(() => new Promise((resolve) => { deliver = resolve; }));
  const first = await rejection(lateResponse);
  const kind = first.kind, cause = first.cause;
  deliver(new Response(VALID_BODY, { headers: JSON_HEADERS }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(isDeadlineTimeout(first));
  assert.equal(first.kind, kind);
  assert.equal(first.cause, cause);

  let fail;
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    const second = await rejection(bounded(() => new Promise((_, reject) => { fail = reject; })));
    fail(new Error('late failure'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(isDeadlineTimeout(second));
    assert.equal(second.cause.name, 'TimeoutError');
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', record); }
});

test('chain and native transport callers keep their not-found and invalid branches', async () => {
  const locator = `stor-${'a'.repeat(40)}`;
  const reader = (fetchImpl) => createDemosChainReader({ rpcUrl: 'https://rpc.invalid', network: 'testnet', timeoutMs: DEADLINE_MS, fetchImpl });
  const notFound = await reader(async () => new Response('{}', { status: 404, headers: JSON_HEADERS })).readStorageProgram(locator);
  assert.equal(notFound.status, 'indeterminate');
  await assert.rejects(reader(never).readStorageProgram('not-a-locator'), { kind: 'invalid' });
  await assert.rejects(reader(async () => new Response('{}', { status: 503, headers: JSON_HEADERS })).readStorageProgram(locator), { kind: 'unavailable', status: 503 });
  await settles(assert.rejects(reader(never).readStorageProgram(locator), isDeadlineTimeout));
  await assert.rejects(reader(async () => new Response('<html>', { headers: { 'content-type': 'text/html' } })).readStorageProgram(locator), { kind: 'invalid' });
});
