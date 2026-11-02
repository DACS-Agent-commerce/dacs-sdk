import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchBoundedJson } from '../src/util/http.mjs';
import { createSellerAgentClient } from '../src/dacs/seller-http.mjs';
import { passiveNativeWorld, HASH } from './helpers/passive-native-world.mjs';

const JSON_HEADERS = { 'content-type': 'application/json' };
const never = () => new Promise(() => {});
const SETTLE_LIMIT_MS = 2000;
// Fails the test, instead of hanging it, when work does not settle on its own.
const settles = async work => {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('did not settle')), SETTLE_LIMIT_MS); })]);
  } finally { clearTimeout(timer); }
};
// A response whose body never yields and never finishes cancelling.
const stuckResponse = ({ status = 200, ok = true } = {}) => ({
  status, ok, headers: new Headers(JSON_HEADERS),
  body: { getReader: () => ({ read: never, cancel: never }), cancel: never },
});
const bounded = (fetchImpl, options = {}) => fetchBoundedJson('https://rpc.invalid/', { timeoutMs: 10000, maxBytes: 1024, fetchImpl, ...options });
const trackedStream = () => {
  const state = { cancelled: false };
  return { state, body: new ReadableStream({ pull() {}, cancel() { state.cancelled = true; } }) };
};

test('bounded fetch settles on caller abort when fetchImpl ignores abort', async () => {
  const controller = new AbortController();
  const request = bounded(never, { signal: controller.signal }), reason = new Error('caller stopped');
  controller.abort(reason);
  await assert.rejects(settles(request), error => error === reason);
});
test('bounded fetch settles on its deadline when fetchImpl ignores abort', async () => {
  await assert.rejects(settles(bounded(never, { timeoutMs: 1 })), { kind: 'unavailable', message: 'request timed out' });
});
test('bounded fetch cancels the body of a response that arrives after abort', async () => {
  const controller = new AbortController(), { state, body } = trackedStream();
  let deliver;
  const request = bounded(() => new Promise(resolve => { deliver = resolve; }), { signal: controller.signal });
  controller.abort();
  await assert.rejects(settles(request), error => error === controller.signal.reason);
  deliver(new Response(body, { headers: JSON_HEADERS }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.cancelled, true);
});
test('bounded fetch leaves no unhandled rejection when fetchImpl fails after abort', async () => {
  const controller = new AbortController(), unhandled = [];
  const record = reason => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    let fail;
    const request = bounded(() => new Promise((_, reject) => { fail = reject; }), { signal: controller.signal });
    controller.abort();
    await assert.rejects(settles(request), error => error === controller.signal.reason);
    fail(new Error('late failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', record); }
});
test('bounded fetch settles on abort when the response body never yields and cancel never finishes', async () => {
  const controller = new AbortController();
  const request = bounded(async () => stuckResponse(), { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(settles(request), error => error === controller.signal.reason);
});
test('bounded fetch reports not-found without waiting for the body to cancel', async () => {
  await assert.rejects(settles(bounded(async () => stuckResponse({ status: 404, ok: false }))), { kind: 'not-found' });
});
test('bounded fetch reports an oversized body without waiting for the body to cancel', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2048)); }, cancel: never });
  await assert.rejects(settles(bounded(async () => new Response(body, { headers: JSON_HEADERS }))), { kind: 'invalid' });
});

const SELLER_URL = 'http://127.0.0.1:9/';
const sellerPost = fetchImpl => createSellerAgentClient({ url: SELLER_URL, fetchImpl, timeoutMs: 1 });
const sellerCall = client => client.propose({});
test('seller client settles on its deadline when fetchImpl ignores abort', async () => {
  const client = sellerPost(never);
  await assert.rejects(settles(sellerCall(client)), { name: 'SellerUnavailableError' });
  assert.equal(client.failureCause, 'timeout');
});
test('seller client settles on its deadline when the response body ignores abort', async () => {
  const client = sellerPost(async () => stuckResponse());
  await assert.rejects(settles(sellerCall(client)), { name: 'SellerUnavailableError' });
  assert.equal(client.failureCause, 'timeout');
});
test('seller client cancels the body of a response that arrives after its deadline', async () => {
  const { state, body } = trackedStream();
  let deliver;
  const client = sellerPost(() => new Promise(resolve => { deliver = resolve; }));
  await assert.rejects(settles(sellerCall(client)), { name: 'SellerUnavailableError' });
  deliver(new Response(body, { headers: JSON_HEADERS }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.cancelled, true);
});

for (const method of ['observePassiveTransfer', 'observeTransfer']) {
  test(`source close resolves and the fence is released after ${method} is aborted while fetch hangs`, async () => {
    let reachedTransaction;
    const reached = new Promise(resolve => { reachedTransaction = resolve; });
    const w = passiveNativeWorld({ onFetch: message => {
      if (message !== 'getTxByHash') return undefined;
      reachedTransaction();
      return never();
    } });
    await w.seed();
    const controller = new AbortController();
    const read = w.source.chainReader()[method](HASH, { signal: controller.signal });
    await settles(reached);
    controller.abort(new Error('caller stopped'));
    await assert.rejects(settles(read), { message: 'caller stopped' });
    await settles(w.source.close());
    assert.equal(w.held(), false);
  });
}
