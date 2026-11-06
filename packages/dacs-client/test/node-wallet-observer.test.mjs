import test from 'node:test';
import assert from 'node:assert/strict';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { AUTHORITY_READ_DEADLINE_MS } from '../src/public-admission.mjs';
import { runFreshChild } from './helpers/fresh-node-child.mjs';
import { installNoEgress } from './helpers/no-egress.mjs';
import { queuedOwner } from './helpers/queued-owner.mjs';
import { api, scriptedNode, T0 } from './helpers/tp1-node-fixture.mjs';
import { deferred, jsonResponse, MIB, ok, sizedReply } from './helpers/source-read-world.mjs';

const CHAIN = TP1_APPROVED_IDENTITY_RECORD.chainIdentity;
const egress = installNoEgress();
test.after(() => { egress.restore(); assert.deepEqual(egress.attempts, []); });
const OTHER_CHAIN = 'e'.repeat(64);
const NODE_PATH = new URL('../src/wallet/node-wallet-session.mjs', import.meta.url).href;
const WIRE_PATH = import.meta.resolve('@kynesyslabs/dacs/wire');
const heightOf = row => row.body.params[0].data.blockNumber;
const blockZero = hash => ({ number: 0, status: 'confirmed', hash, content: {} });
const blockOne = previousHash => ({ number: 1, status: 'confirmed', hash: 'b'.repeat(64), content: { previousHash } });
const literalError = () => jsonResponse(JSON.stringify({ result: 400, response: 'error' }));
const flushLateWork = () => new Promise(resolve => setImmediate(resolve));

// An observer over a queued owner and the scripted node; `signals` has each request's AbortSignal.
function observerWorld(options = {}) {
  const node = scriptedNode(), signals = [];
  const owner = queuedOwner({ fetchImpl: (url, init) => { signals.push(init.signal); return node.fetch(url, init); } });
  const observer = api.createNodeObserver({ owner, clock: { now: () => T0 }, ...options });
  return { node, owner, observer, signals };
}
const answerWith = (w, byHeight) => { w.node.intercept = row => byHeight[heightOf(row)]?.(row); };

test('the observer is built from an unopened transport owner and bindTp1Profile completes with it while custody, SQLite and journal opens stay 0', async t => {
  const child = runFreshChild(t, `
    import { writeFileSync } from 'node:fs';
    import { registerHooks } from 'node:module';
    const [nodeUrl, wireUrl] = process.argv.slice(2);
    const node = await import(nodeUrl), wire = await import(wireUrl);
    let opens = 0, requests = 0;
    registerHooks({ resolve(specifier, context, next) { if (/sqlite|demosdk|durable-journal|custody|secret/.test(specifier)) opens++; return next(specifier, context); } });
    const record = wire.TP1_APPROVED_IDENTITY_RECORD;
    const fetchImpl = async () => { requests++; return new Response(JSON.stringify({ result: 200, response: { number: 0, status: 'confirmed', hash: record.chainIdentity, content: {} }, require_reply: false, extra: null }), { headers: { 'content-type': 'application/json' } }); };
    const owner = node.createNodeTransportOwner({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', fetchImpl });
    const observer = node.createNodeObserver({ owner, clock: { now: () => Date.now() } });
    const binding = await wire.bindTp1Profile({ record, local: owner.currentLocal(), readAuthority: async scope => ({ ...(await observer.observe({})), sessionId: scope.sessionId, participants: [] }) });
    writeFileSync('result.json', JSON.stringify({ opens, requests, chainIdentity: binding.profile.chainIdentity }));
  `, [NODE_PATH, WIRE_PATH]);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(child.result, { opens: 0, requests: 1, chainIdentity: CHAIN });
});

test('with a non-reentrant queued owner whose fence is held, a full observation completes with zero fence acquisitions', async t => {
  const w = observerWorld(), lease = await w.owner.acquireConnectionFence(), acquired = w.owner.acquisitions();
  t.after(() => lease.release());
  for (const answers of [{}, { 0: literalError, 1: () => jsonResponse(JSON.stringify(ok(blockOne(CHAIN)))) }]) {
    answerWith(w, answers);
    const decision = await w.observer.observe({});
    assert.equal(decision.chainIdentity, CHAIN);
    assert.deepEqual(decision.local, w.owner.local);
  }
  assert.equal(w.owner.acquisitions(), acquired, 'the observer acquired the fence');
  assert.equal(w.owner.held(), true);
  assert.equal(w.node.calls.length, 3, 'block zero, then block zero and the block-one fallback');
});

test('a connection replacement during an observation refuses; provenance is stable across observations on one generation and changes with it', async t => {
  const w = observerWorld(), first = w.observer.provenance();
  assert.deepEqual(await w.observer.observe({}), { local: w.owner.local, chainIdentity: CHAIN, provenance: first });
  assert.equal((await w.observer.observe({})).provenance, first);
  assert.equal(w.observer.provenance(), first);
  w.node.intercept = () => { w.owner.replaceConnection(); };
  await assert.rejects(w.observer.observe({}), { code: 'connection_changed' });
  w.node.intercept = null;
  const next = w.observer.provenance();
  assert.notEqual(next, first);
  assert.deepEqual(await w.observer.observe({}), { local: w.owner.local, chainIdentity: CHAIN, provenance: next });
});

test('one aggregate deadline covers every read of an observation; past it the observation refuses tp1_authority_timeout and a late answer authorizes nothing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = observerWorld(), blockZeroStalled = deferred(), blockOneStalled = deferred(), blockOneStarted = deferred();
  answerWith(w, { 0: () => blockZeroStalled.promise, 1: () => { blockOneStarted.resolve(); return blockOneStalled.promise; } });
  const observation = w.observer.observe({});
  const outcome = observation.then(() => 'authorized', error => error);
  t.mock.timers.tick(AUTHORITY_READ_DEADLINE_MS - 4000);
  blockZeroStalled.resolve(literalError());
  await blockOneStarted.promise;
  t.mock.timers.tick(4000);
  const error = await outcome;
  assert.equal(error.code, 'tp1_authority_timeout');
  assert.equal(error.cause.kind, 'timeout');
  blockOneStalled.resolve(jsonResponse(JSON.stringify(ok(blockOne(CHAIN)))));
  await flushLateWork();
  assert.deepEqual(w.node.calls.map(heightOf), [0, 1], 'the late answer started nothing');
});

test('a cancelled observation aborts its in-flight read, starts no queued read and returns no late decision', async t => {
  const w = observerWorld(), late = deferred(), started = deferred(), reason = new Error('TEST-observation-cancelled'), controller = new AbortController();
  answerWith(w, { 0: () => { started.resolve(); return late.promise; } });
  const observation = w.observer.observe({ signal: controller.signal });
  await started.promise;
  controller.abort(reason);
  await assert.rejects(observation, error => error === reason);
  assert.equal(w.signals[0].aborted, true, 'the in-flight read was aborted');
  late.resolve(jsonResponse(JSON.stringify(ok(blockZero(CHAIN)))));
  await flushLateWork();
  assert.equal(w.node.calls.length, 1, 'no later read started');
  await assert.rejects(w.observer.observe({ signal: AbortSignal.abort(reason) }), error => error === reason);
  assert.equal(w.node.calls.length, 1, 'an already cancelled observation starts no read');
});

test('the expected identity and block-one fallback come from TP1_APPROVED_IDENTITY_RECORD; a node answering another chain or an oversized block is refused with its cause', async t => {
  const refusals = [
    [{ 0: () => jsonResponse(JSON.stringify(ok(blockZero(OTHER_CHAIN)))) }, error => error.code === 'identity_mismatch'],
    [{ 0: literalError, 1: () => jsonResponse(JSON.stringify(ok(blockOne(OTHER_CHAIN)))) }, error => error.code === 'identity_mismatch'],
    ...[true, false].map(declared => [{ 0: () => sizedReply(4 * MIB + 1, { declared }) }, error => error.code === 'unavailable' && error.cause.kind === 'invalid' && /exceeds byte limit/.test(error.cause.message)]),
  ];
  for (const [answers, refused] of refusals) {
    const w = observerWorld();
    answerWith(w, answers);
    await assert.rejects(w.observer.observe({}), refused);
  }
  const fallback = observerWorld();
  answerWith(fallback, { 0: literalError, 1: () => jsonResponse(JSON.stringify(ok(blockOne(CHAIN)))) });
  assert.equal((await fallback.observer.observe({})).chainIdentity, CHAIN, 'the record supplies the block-one fallback');
  const supplied = observerWorld({ record: { ...TP1_APPROVED_IDENTITY_RECORD, chainIdentity: OTHER_CHAIN }, expected: { chainIdentity: OTHER_CHAIN } });
  answerWith(supplied, { 0: () => jsonResponse(JSON.stringify(ok(blockZero(OTHER_CHAIN)))) });
  await assert.rejects(supplied.observer.observe({}), { code: 'identity_mismatch' }, 'a caller-supplied identity is ignored');
});

test('readNodeInfo admits only getNetworkInfo and getNetworkParameters, bounded the same way', async t => {
  const w = observerWorld();
  assert.deepEqual(await w.observer.readNodeInfo('getNetworkInfo', {}), { forks: { osDenomination: { activated: true } } });
  assert.deepEqual(await w.observer.readNodeInfo('getNetworkParameters'), { networkFee: 1, rpcFee: 0, additionalFee: 0 });
  const answered = w.node.calls.length;
  for (const message of ['getTxByHash', 'getAddressNonce', 'broadcastTx', 'constructor', undefined]) {
    await assert.rejects(w.observer.readNodeInfo(message), { code: 'readonly_only' }, String(message));
  }
  assert.equal(w.node.calls.length, answered, 'a refused message sends nothing');
  w.node.intercept = () => sizedReply(4 * MIB + 1, { declared: false });
  await assert.rejects(w.observer.readNodeInfo('getNetworkInfo'), error => error.kind === 'invalid' && /exceeds byte limit/.test(error.message));
  const reason = new Error('TEST-node-info-cancelled');
  await assert.rejects(w.observer.readNodeInfo('getNetworkInfo', { signal: AbortSignal.abort(reason) }), error => error === reason);
});
