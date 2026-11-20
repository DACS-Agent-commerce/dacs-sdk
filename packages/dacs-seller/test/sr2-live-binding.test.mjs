// The seller host's production authority reader over the kit session's real authority capability: the capability's byte,
// list and deadline bounds, no connection fence and no signature from the reader, and the causes of failures injected into
// the real fetch, response body and cancellation paths, through the reader and the host composition.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertTp1Authority, assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { isBoundedCallTimeout } from '../src/dacs/bounded-call.mjs';
import { openSellerStages } from '../src/dacs/host-stages.mjs';
import { contextHostFixture, hostBuyer } from './helpers/host-context-client.mjs';
import { enrollment, jsonResponse, scriptedNode, testWalletSession } from './helpers/kit-wallet-session.mjs';
import { JOB, buyer, seller } from './helpers/protocol-fixture.mjs';

const MIB = 1024 * 1024;
const AUTHORITY_DEADLINE_MS = 10000;
const LIST_LIMIT = 1024;
const TEST_TIMEOUT_MS = 300000;
const BLOCK_ZERO = { method: 'nodeCall', params: [{ message: 'getBlockByNumber', data: { blockNumber: 0 } }] };
const nodeAnswer = (response) => JSON.stringify({ result: 200, response, require_reply: false, extra: null });
const causesOf = (error) => { const causes = []; for (let next = error; next; next = next.cause) causes.push(next); return causes; };
const flush = async () => { for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve)); };

// The host composition on a fresh data directory with the port's node answering every read through `reply(call)` (or as scripted
// when `reply` answers nothing). Resolves the started host, or rejects with the startup error.
async function startWith(t, reply) {
  const f = await contextHostFixture(t);
  const node = scriptedNode();
  node.intercept = ({ call }) => reply(call);
  return f.start({ walletSession: testWalletSession({ node }).walletSession, participantImplementations: enrollment() });
}

test('the production authority reader bounds bytes before decode and lists after decode, keeps the read deadline, and adds zero fence acquisitions and signatures before and while the boundary owns the fence; two overlapping initial checks both finish; errors injected through fetch, the body reader and cancellation keep their identity in the cause chain through the reader and the composition; a late, a malformed and an oversized reply each give their own failure', { timeout: TEST_TIMEOUT_MS }, async (t) => {
  // The composition's own stages over a counting port, finalized onto a private data directory.
  const dataDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'TEST-sr2-live-binding-')));
  chmodSync(dataDirectory, 0o700);
  t.after(() => rmSync(dataDirectory, { recursive: true, force: true }));
  const port = testWalletSession();
  assert.deepEqual(Object.keys(port.walletSession.authority).filter((name) => /sign|send|broadcast/i.test(name)), [], 'the capability the reader reads through can neither sign nor send');
  const stages = await openSellerStages({ walletSession: port.walletSession, participantImplementations: enrollment(), sellerClaim: seller.claim,
    listingPin: { listingId: 'TEST-listing', version: 1, contentHash: 'c'.repeat(64) }, retainedJob: () => null, maxConcurrent: 1 });
  t.after(() => stages.close());
  const { effectBoundary } = await stages.finalize({ dataDirectory, stopped: () => false, stateLock: null });
  const check = () => assertTp1Binding(stages.binding, stages.local());
  await Promise.all([check(), check()]);
  assert.equal(port.owner.acquisitions, 0, 'the reader takes no connection fence before the boundary holds one');
  const op = { operationId: 'TEST-op', lane: 'TEST-lane', kind: 'wire-request', paidWrite: false, debitOs: '0', approvalRef: null, k1Rev: null, pinVersion: stages.binding.profile.pinVersion };
  const insideFence = await effectBoundary.withFence(op, async () => {
    await Promise.all([check(), check(), assertTp1Authority(stages.binding, stages.local(), [], null)]);
    return 'checked';
  });
  assert.equal(insideFence, 'checked', 'checks made while the boundary holds its fence finish');
  assert.equal(port.owner.acquisitions, 0, 'the reader took no connection fence while the boundary held its own');

  // Through the session's capability: a reply over the byte bound is refused before it is decoded, a list over its bound after.
  const replies = [];
  const bounded = testWalletSession({ node: { fetch: async () => replies.shift(), calls: [] } }).walletSession.authority;
  replies.push(jsonResponse(nodeAnswer({ pad: 'a'.repeat(4 * MIB) })));
  await assert.rejects(bounded.authorityRpc(BLOCK_ZERO), (error) => error.kind === 'invalid' && /exceeds byte limit/.test(error.message));
  replies.push(jsonResponse(nodeAnswer({ rows: new Array(LIST_LIMIT + 1).fill(0) })));
  await assert.rejects(bounded.authorityRpc(BLOCK_ZERO), { code: 'authority_list_too_large' });
  // A caller's cancellation keeps its own reason.
  const cancelled = new Error('TEST-cancel-reason'), controller = new AbortController();
  replies.push(new Promise(() => {}));
  const pending = bounded.authorityRpc(BLOCK_ZERO, { signal: controller.signal });
  controller.abort(cancelled);
  await assert.rejects(pending, (error) => error === cancelled);

  // Through the host composition: each injected failure keeps its identity in the cause chain.
  const fetchFailure = new Error('TEST-fetch-failure'), bodyFailure = new Error('TEST-body-failure');
  const failingBody = () => new Response(new ReadableStream({ pull() { throw bodyFailure; } }), { headers: { 'content-type': 'application/json' } });
  await assert.rejects(startWith(t, () => { throw fetchFailure; }), (error) => causesOf(error).includes(fetchFailure), 'a fetch failure');
  await assert.rejects(startWith(t, () => failingBody()), (error) => causesOf(error).includes(bodyFailure), 'a body failure');
  const outcome = (reply) => startWith(t, reply).then(() => 'started', (error) => error);
  const oversized = await outcome(() => jsonResponse(nodeAnswer({ pad: 'a'.repeat(4 * MIB) })));
  const longList = await outcome(() => jsonResponse(nodeAnswer({ rows: new Array(LIST_LIMIT + 1).fill(0) })));
  const malformed = await outcome(() => jsonResponse('{not json'));
  assert.ok(causesOf(oversized).some((error) => error.kind === 'invalid' && /exceeds byte limit/.test(error.message)), 'an oversized reply is refused before decoding');
  assert.ok(causesOf(longList).some((error) => error.code === 'authority_list_too_large'), 'a long list is refused after decoding');
  assert.ok(!causesOf(malformed).some((error) => error.code === 'authority_list_too_large' || /exceeds byte limit/.test(error.message ?? '')), 'a malformed reply is neither');
  assert.ok(causesOf(malformed).length > 1, 'a malformed reply keeps its cause');

  // A reply that never comes ends at the deadline, and its late arrival opens nothing.
  const f = await contextHostFixture(t);
  const node = scriptedNode();
  let lateReply;
  node.intercept = () => new Promise((resolve) => { lateReply = resolve; });
  mock.timers.enable({ apis: ['setTimeout'] });
  let stalled = 'pending';
  try {
    const starting = f.start({ walletSession: testWalletSession({ node }).walletSession, participantImplementations: enrollment() }).then(() => 'started', (error) => { stalled = error; });
    await flush();
    assert.equal(stalled, 'pending');
    mock.timers.tick(AUTHORITY_DEADLINE_MS);
    await starting;
    const timedOut = (error) => error.code === 'tp1_authority_timeout' || error.kind === 'timeout' || isBoundedCallTimeout(error);
    assert.ok(causesOf(stalled).some(timedOut), `a stalled read ends by the deadline: ${causesOf(stalled).map((error) => error.code ?? error.kind ?? error.name).join(' < ')}`);
    lateReply(jsonResponse(nodeAnswer({ number: 0 })));
    await flush();
  } finally { mock.timers.reset(); }
  // The deepest cause of each failure names it.
  const failureOf = (error) => { const deepest = causesOf(error).at(-1); return `${deepest.code ?? deepest.kind ?? deepest.name}: ${deepest.message}`; };
  const distinct = [stalled, oversized, longList, malformed].map(failureOf);
  assert.equal(new Set(distinct).size, 4, `four distinct failures: ${distinct.join(' | ')}`);

  // A host composed over the session serves a buyer, and its reads still take no fence.
  const served = await contextHostFixture(t);
  const servedPort = testWalletSession();
  const host = await served.start({ walletSession: servedPort.walletSession, participantImplementations: enrollment() });
  await (await hostBuyer(host, served.config.listing, { jobId: JOB, buyer })).admit(JOB);
  assert.equal(servedPort.owner.acquisitions, 0);
});
