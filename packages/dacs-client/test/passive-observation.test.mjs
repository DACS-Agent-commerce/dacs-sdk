import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { fetchBoundedJson, observeWithDeadline } from '../src/util/http.mjs';
import { passiveNativeWorld, HASH, INTENT, NOW, PAYEE } from './helpers/passive-native-world.mjs';

const OTHER = '0x' + 'e'.repeat(64);
const json = (response, init = {}) => new Response(JSON.stringify({ result: 200, response }), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
const flush = async (turns = 20) => { for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve)); };
const settledWithin = async (promise, turns = 20) => Promise.race([promise.then(value => ({ value }), error => ({ error })), flush(turns).then(() => 'stalled')]);
// Tick mocked timers in steps until the promise settles.
async function drive(t, promise, stepMs, steps = 50) {
  let outcome = 'pending';
  promise.then(value => { outcome = { value }; }, error => { outcome = { error }; });
  for (let i = 0; i < steps && outcome === 'pending'; i++) { await flush(); t.mock.timers.tick(stepMs); await flush(); }
  return outcome;
}
function durableWorld(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-passive-'));
  const journal = openDurableWalletJournal({ path: join(dir, 'journal.sqlite'), mode: 'create' });
  const w = passiveNativeWorld({ ...options, journal });
  t.after(async () => { await w.source.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
  return w;
}
async function memoryWorld(t, options = {}, { seed = true } = {}) {
  const w = passiveNativeWorld(options); t.after(() => w.source.close());
  if (seed) await w.seed();
  return w;
}
async function editIntent(w, edit) {
  const row = await w.journal.get(INTENT); edit(row);
  await w.journal.put(INTENT, row); w.writes.length = 0;
}
async function assertUnchanged(w, before) {
  assert.deepEqual(await w.journal.entries(), before); assert.deepEqual(w.writes, []);
  assert.equal(w.fences.acquired, w.fences.released); assert.equal(w.held(), false);
}
const passive = (w, hash = HASH, options) => w.source.chainReader().observePassiveTransfer(hash, options);

// Entry check: only the canonical spelling is read.
for (const [spelling, hash] of [['prefix', `0x${HASH}`], ['uppercase', HASH.toUpperCase()], ['whitespace', ` ${HASH} `],
  ['combined', ` 0x${HASH.toUpperCase()} `], ['trailing newline', `${HASH}\n`]]) {
  test(`passive readback refuses a ${spelling} hash alias before any read or lock`, async t => {
    const w = await memoryWorld(t); w.transaction.content.nonce = 8;
    const before = await w.journal.entries();
    await assert.rejects(() => passive(w, hash), { code: 'invalid_params' });
    assert.deepEqual(w.calls, []); assert.deepEqual(w.lockKeys, []); assert.equal(w.fences.acquired, 0);
    await assertUnchanged(w, before);
  });
}

// Included facts need this hash's own retained native intent.
test('passive included readback without an intent row is unverified', async t => {
  const w = await memoryWorld(t, {}, { seed: false });
  await assert.rejects(() => passive(w), { code: 'readback_unverified' });
  await assertUnchanged(w, []);
});
for (const changed of [false, true]) {
  test(`passive readback refuses a reopened lane-only prefix with ${changed ? 'changed' : 'matching'} node bytes`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'TEST-passive-prefix-')), path = join(dir, 'journal.sqlite');
    let journal = openDurableWalletJournal({ path, mode: 'create' }), w;
    t.after(async () => { await w?.source.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
    w = passiveNativeWorld({ journal }); await w.seed({ laneOnly: true });
    const before = await journal.entries(), journalId = journal.journalId;
    assert.equal(await journal.get(INTENT), undefined);
    assert.ok(before.some(([key]) => key.startsWith('devnet/native-wallet/')));
    await w.source.close(); journal.close();
    journal = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: journalId });
    w = passiveNativeWorld({ journal });
    if (changed) { w.transaction.content.amount = '2000000000'; w.transaction.content.data[1].args[1] = '2000000000'; }
    for (let repeat = 0; repeat < 2; repeat++) {
      await assert.rejects(() => passive(w), { code: 'readback_unverified' });
      await assertUnchanged(w, before);
    }
  });
}
for (const [name, edit] of [
  ['a non-native intent', row => { row.signedTransaction.content.type = 'storageProgram'; }],
  ['an intent whose hash differs from its key', row => { row.hash = 'e'.repeat(64); }],
  ['an intent whose signed hash differs from its key', row => { row.signedTransaction.hash = 'e'.repeat(64); }],
  ['an intent with no network binding', row => { delete row.networkBinding; }],
]) {
  test(`passive included readback refuses ${name}`, async t => {
    const w = await memoryWorld(t); await editIntent(w, edit);
    const before = await w.journal.entries();
    await assert.rejects(() => passive(w), { code: 'readback_unverified' });
    await assertUnchanged(w, before);
  });
}

// The one body the core validated is compared with the retained content.
test('passive readback refuses changed retained bytes (nonce 7 to 8)', async t => {
  const w = await memoryWorld(t); w.transaction.content.nonce = 8;
  const before = await w.journal.entries();
  await assert.rejects(() => passive(w), { code: 'readback_unverified' });
  await assertUnchanged(w, before);
});
for (const [field, edit] of [
  ['payer', w => { w.transaction.content.from = OTHER; w.transaction.content.from_ed25519_address = OTHER; }],
  ['payee', w => { w.transaction.content.to = OTHER; w.transaction.content.data[1].args[0] = OTHER; }],
  ['amount', w => { w.transaction.content.amount = '2000000000'; w.transaction.content.data[1].args[1] = '2000000000'; }],
  ['nonce', w => { w.transaction.content.nonce = 8; }],
  ['timestamp', w => { w.transaction.content.timestamp = NOW + 1; }],
  ['payload', w => { w.transaction.content.data[1].memo = 'TEST-extra'; }],
  ['hash', w => { w.transaction.hash = 'e'.repeat(64); }],
  ['block', w => { w.transaction.blockNumber = 8; }],
]) {
  test(`passive readback refuses a node body with a changed ${field} after one body read`, async t => {
    const w = await memoryWorld(t); edit(w);
    const before = await w.journal.entries();
    const outcome = await passive(w).then(result => result, error => error);
    assert.ok(outcome.code === 'readback_unverified' || outcome.status === 'invalid', JSON.stringify(outcome));
    assert.equal(w.calls.filter(call => call === 'getTxByHash').length, 1);
    await assertUnchanged(w, before);
  });
}
// node() owns the wire envelope; a second one must not change the transaction
// interpreted by the core while the retained comparison still sees the outer.
async function assertReadOnlyAttempt(w, before, check, bodyReads = 1) {
  const reads = w.calls.filter(call => call === 'getTxByHash').length;
  const { acquired, released } = w.fences;
  try { await check(); } finally {
    assert.equal(w.calls.filter(call => call === 'getTxByHash').length - reads, bodyReads);
    assert.equal(w.fences.acquired - acquired, 1); assert.equal(w.fences.released - released, 1);
    await assertUnchanged(w, before);
  }
}
function nestedTransaction(transaction, edit, result) {
  const inner = structuredClone(transaction); edit(inner.content);
  if (result !== undefined) inner.result = result;
  return { ...transaction, response: inner };
}
const changeAmount = (content, amount) => { content.amount = amount; content.data[1].args[1] = amount; };
for (const result of [undefined, 200]) {
  for (const [field, edit] of [
    ['payee and amount', c => { c.to = OTHER; c.data[1].args[0] = OTHER; changeAmount(c, '2000000000'); }],
    ['one OS amount difference', c => changeAmount(c, '1000000001')],
    ['minimum positive amount', c => changeAmount(c, '1')],
    ['payer', c => { c.from = OTHER; c.from_ed25519_address = OTHER; }],
    ['nonce', c => { c.nonce++; }],
    ['signed timestamp', c => { c.timestamp++; }],
    ['added payload memo', c => { c.data[1].memo = 'TEST-extra'; }],
    ['deleted owner', c => { delete c.from_ed25519_address; }],
  ]) {
    test(`passive readback refuses nested ${field} with inner result ${result ?? 'absent'}`, async t => {
      const w = await memoryWorld(t), before = await w.journal.entries();
      w.transaction = nestedTransaction(w.transaction, edit, result);
      await assertReadOnlyAttempt(w, before, () => assert.rejects(() => passive(w), { code: 'readback_unverified' }));
    });
  }
}
test('passive readback accepts one wire envelope and preserves a non-included nested result', async t => {
  const w = await memoryWorld(t), before = await w.journal.entries();
  await assertReadOnlyAttempt(w, before, async () => {
    const observation = await passive(w);
    assert.equal(observation.sourceDisposition, 'included'); assert.equal(observation.payee, PAYEE.slice(2));
    assert.equal(observation.amountOs, '1000000000');
  });
  w.transaction = { ...w.transaction, response: { ...w.transaction, status: 'failed' } };
  await assertReadOnlyAttempt(w, before, async () => assert.equal((await passive(w)).status, 'invalid'));
});
for (const stage of ['broadcast-started', 'broadcast-accepted', 'broadcast-answered', 'observed', 'failed']) {
  test(`reopened ${stage} intent refuses nested nonce on both passive attempts`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'TEST-passive-nested-')), path = join(dir, 'journal.sqlite');
    let journal = openDurableWalletJournal({ path, mode: 'create' }), w = passiveNativeWorld({ journal });
    t.after(async () => { await w.source.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
    await w.seed(); await editIntent(w, row => { row.stage = stage; });
    const before = await w.journal.entries(), journalId = journal.journalId;
    await w.source.close(); journal.close();
    journal = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: journalId });
    w = passiveNativeWorld({ journal }); w.transaction = nestedTransaction(w.transaction, c => { c.nonce++; });
    for (let repeat = 0; repeat < 2; repeat++) {
      await assertReadOnlyAttempt(w, before, () => assert.rejects(() => passive(w), { code: 'readback_unverified' }));
    }
  });
}
test('concurrent passive reads independently refuse nested bodies around a valid body', async t => {
  let bodyReads = 0;
  const w = await memoryWorld(t, { onFetch: message => {
    if (message === 'getTxByHash') return json(++bodyReads === 2 ? w.transaction : nestedTransaction(w.transaction, c => { c.nonce++; }));
  } });
  const before = await w.journal.entries();
  const results = await Promise.allSettled([passive(w), passive(w), passive(w)]);
  assert.deepEqual(results.map(r => r.status), ['rejected', 'fulfilled', 'rejected']);
  assert.equal(results[0].reason.code, 'readback_unverified'); assert.equal(results[2].reason.code, 'readback_unverified');
  assert.equal(results[1].value.sourceDisposition, 'included'); assert.equal(results[1].value.payee, PAYEE.slice(2));
  assert.equal(bodyReads, 3); assert.equal(w.calls.filter(call => call === 'getTxByHash').length, 3);
  assert.deepEqual(w.fences, { acquired: 3, released: 3 }); await assertUnchanged(w, before);
});
for (const initial of ['pending', 'body error']) {
  test(`passive retry after ${initial} refuses a nested changed nonce`, async t => {
    let failBody = initial === 'body error';
    const w = await memoryWorld(t, { state: initial === 'pending' ? 'pending' : 'included', onFetch: message => {
      if (message === 'getTxByHash' && failBody) { failBody = false; throw new Error('TEST-body-read'); }
    } });
    const before = await w.journal.entries();
    await assertReadOnlyAttempt(w, before, async () => assert.equal((await passive(w)).status, initial === 'pending' ? 'pending' : 'unavailable'), initial === 'pending' ? 0 : 1);
    w.statusAnswer.state = 'included'; w.transaction = nestedTransaction(w.transaction, c => { c.nonce++; });
    await assertReadOnlyAttempt(w, before, () => assert.rejects(() => passive(w), { code: 'readback_unverified' }));
  });
}
for (const status of ['confirmed', 'included', 'finalized', 'Confirmed', 'FINALIZED']) {
  test(`passive readback accepts the core body label ${status}`, async t => {
    const w = await memoryWorld(t, { status });
    const before = await w.journal.entries();
    assert.equal((await passive(w)).sourceDisposition, 'included');
    assert.equal(w.calls.filter(call => call === 'getTxByHash').length, 1);
    await assertUnchanged(w, before);
  });
}
test('passive readback rejects a corrupted retained network binding and releases the fence once', async t => {
  const w = await memoryWorld(t); await editIntent(w, row => { row.networkBinding.bindingId = 'TEST-corrupt'; });
  const before = await w.journal.entries();
  await assert.rejects(() => passive(w), { code: 'binding_mismatch' });
  assert.deepEqual(w.fences, { acquired: 1, released: 1 }); assert.deepEqual(w.calls, []);
  await assertUnchanged(w, before);
});

// Non-included results need no intent.
for (const [name, options, status] of [['pending', { state: 'pending' }, 'pending'], ['unknown', { state: 'unknown' }, 'not-found'],
  ['failed', { state: 'failed' }, 'failed'], ['failed body', { status: 'failed' }, 'invalid']]) {
  test(`passive ${name} readback returns the core result with no intent`, async t => {
    const w = await memoryWorld(t, options, { seed: false });
    assert.equal((await passive(w)).status, status);
    await assertUnchanged(w, []);
  });
}
for (const stage of ['broadcast-started', 'broadcast-accepted', 'broadcast-answered', 'observed', 'failed']) {
  test(`repeated passive readback over a durable journal authenticates a retained ${stage} intent`, async t => {
    const w = durableWorld(t); await w.seed(); await editIntent(w, row => { row.stage = stage; });
    const before = await w.journal.entries();
    for (let repeat = 0; repeat < 2; repeat++) {
      const result = await passive(w);
      assert.equal(result.status, 'included'); assert.equal(result.sourceDisposition, 'included'); assert.equal(result.payee, PAYEE.slice(2));
      await assertUnchanged(w, before);
    }
  });
}

// The shared transfer reader keeps per-request timeouts only.
test('the shared reader has no whole-observation deadline over slow healthy requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reader = createDemosChainReader({ rpcUrl: 'https://rpc.invalid/', network: 'testnet', timeoutMs: 1000, fetchImpl: async (_url, options) => {
    const { message } = JSON.parse(options.body).params[0];
    await new Promise(resolve => setTimeout(resolve, 600));
    if (message === 'getTransactionStatus') return json({ state: 'included', blockNumber: 7 });
    if (message === 'getTxByHash') return json({ hash: HASH, status: 'confirmed', blockNumber: 7, content: { type: 'native', from: OTHER, to: PAYEE, amount: '1000000000', data: ['native', { nativeOperation: 'send', args: [PAYEE, '1000000000'] }] } });
    return json({ number: 7, status: 'confirmed', content: { ordered_transactions: [HASH], timestamp: NOW / 1000 } });
  } });
  const outcome = await drive(t, reader.observeTransfer(HASH), 600);
  assert.equal(outcome.value?.status, 'included', String(outcome.error));
});
test('the devnet shared reader observes through slow healthy source reads', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await memoryWorld(t, { onFetch: () => new Promise(resolve => setTimeout(resolve, 2000)) }, { seed: false });
  const outcome = await drive(t, w.source.chainReader().observeTransfer(HASH), 2000);
  assert.equal(outcome.value?.status, 'included', String(outcome.error));
  assert.ok(w.calls.length >= 6);
});
for (const method of ['networkIdentity', 'observeTransfer', 'getTransaction']) {
  test(`shared reader ${method} refuses a pre-aborted caller without fetch`, async () => {
    let calls = 0; const reason = new Error('TEST-stop');
    const reader = createDemosChainReader({ rpcUrl: 'https://rpc.invalid/', network: 'testnet', fetchImpl: async () => { calls++; throw new Error('TEST-fetch'); } });
    const options = { signal: AbortSignal.abort(reason) };
    await assert.rejects(() => method === 'networkIdentity' ? reader[method](options) : reader[method](HASH, options), error => error === reason);
    assert.equal(calls, 0);
  });
}
for (const target of ['getTransactionStatus', 'getTxByHash', 'getBlockByNumber']) {
  test(`shared reader abort during ${target} rejects with the caller's reason`, async () => {
    const controller = new AbortController(), reason = new Error('TEST-stop'), calls = [];
    const reader = createDemosChainReader({ rpcUrl: 'https://rpc.invalid/', network: 'testnet', fetchImpl: async (_url, options) => {
      const { message } = JSON.parse(options.body).params[0]; calls.push(message);
      if (message === target) { controller.abort(reason); options.signal.throwIfAborted(); }
      return json(message === 'getTransactionStatus' ? { state: 'included', blockNumber: 7 } : {});
    } });
    await assert.rejects(() => reader.observeTransfer(HASH, { signal: controller.signal }), error => error === reason);
    assert.ok(calls.includes(target));
  });
}
test('shared identity abort after block zero prevents the block-one fallback', async () => {
  const controller = new AbortController(), reason = new Error('TEST-stop'); let calls = 0;
  const reader = createDemosChainReader({ rpcUrl: 'https://rpc.invalid/', network: 'testnet', fetchImpl: async () => { calls++; controller.abort(reason); return json({}); } });
  await assert.rejects(() => reader.networkIdentity({ signal: controller.signal }), error => error === reason);
  assert.equal(calls, 1);
});

// fetchBoundedJson: one cancellation shape at every exit.
const bounded = (fetchImpl, options = {}) => fetchBoundedJson('https://rpc.invalid/', { timeoutMs: 10000, maxBytes: 1024, fetchImpl, ...options });
test('bounded fetch refuses a pre-aborted caller with its reason and no fetch', async () => {
  const reason = new Error('TEST-stop'); let calls = 0;
  await assert.rejects(bounded(async () => { calls++; return json({}); }, { signal: AbortSignal.abort(reason) }), error => error === reason);
  assert.equal(calls, 0);
});
test('bounded fetch abort during the request rejects with the caller reason', async () => {
  const controller = new AbortController(), reason = new Error('TEST-stop');
  const read = bounded((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('TEST-fetch-aborted')))), { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(read, error => error === reason);
});
test('bounded fetch abort after the response resolves rejects with the caller reason', async () => {
  const controller = new AbortController(), reason = new Error('TEST-stop');
  await assert.rejects(bounded(async () => { controller.abort(reason); return json({}); }, { signal: controller.signal }), error => error === reason);
});
test('bounded fetch abort during the body read rejects with the caller reason and cancels the body', async () => {
  const controller = new AbortController(), reason = new Error('TEST-stop'); let started, cancelled = false;
  const reading = new Promise(resolve => { started = resolve; });
  const read = bounded(async () => new Response(new ReadableStream({ pull() { started(); return new Promise(() => {}); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }), { signal: controller.signal });
  await reading; controller.abort(reason);
  await assert.rejects(read, error => error === reason);
  assert.equal(cancelled, true);
});
const stalledBody = (chunks = []) => new ReadableStream({ start(c) { for (const chunk of chunks) c.enqueue(chunk); }, cancel() { return new Promise(() => {}); } });
for (const [name, response, kind] of [
  ['declared oversize', () => new Response(stalledBody(), { headers: { 'content-type': 'application/json', 'content-length': '2048' } }), 'invalid'],
  ['streamed oversize', () => new Response(stalledBody([new Uint8Array(2048)]), { headers: { 'content-type': 'application/json' } }), 'invalid'],
  ['redirect', () => new Response(stalledBody(), { status: 302, headers: { location: 'https://elsewhere.invalid/' } }), 'invalid'],
  ['404', () => new Response(stalledBody(), { status: 404 }), 'not-found'],
  ['500', () => new Response(stalledBody(), { status: 500 }), 'unavailable'],
  ['non-JSON', () => new Response(stalledBody(), { headers: { 'content-type': 'text/html' } }), 'invalid'],
]) {
  test(`bounded fetch ${name} rejects without awaiting a stalled body cancel`, async () => {
    const outcome = await settledWithin(bounded(async () => response()));
    assert.notEqual(outcome, 'stalled'); assert.equal(outcome.error?.kind, kind);
  });
}
test('bounded fetch reports its own timeout in one documented shape', async () => {
  const read = bounded((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))), { timeoutMs: 1 });
  await assert.rejects(read, error => error.kind === 'unavailable' && error.message === 'request timed out');
});
test('bounded fetch keeps the cause of an ordinary network failure', async () => {
  const cause = new TypeError('TEST-network');
  await assert.rejects(bounded(async () => { throw cause; }), error => error.kind === 'unavailable' && error.message === 'request failed' && error.cause === cause);
});

// observeWithDeadline: a signal, never a race.
test('observation deadline aborts the reader signal with kind timeout on a controlled timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let signal;
  const read = observeWithDeadline(options => { signal = options.signal; return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('TEST-reader')))); }, { timeoutMs: 123 });
  t.mock.timers.tick(123);
  await assert.rejects(read, { kind: 'timeout' });
  assert.equal(signal.reason.kind, 'timeout');
});
test('observation deadline preserves reader errors and aborts its signal on completion', async () => {
  const cause = new Error('TEST-cause'); let signal;
  await assert.rejects(observeWithDeadline(options => { signal = options.signal; throw cause; }, { timeoutMs: 10000 }), error => error === cause);
  assert.equal(signal.aborted, true);
});
test('observation deadline returns the read result and clears its deadline timer', async t => {
  const cleared = t.mock.method(globalThis, 'clearTimeout'); let signal;
  assert.equal(await observeWithDeadline(options => { signal = options.signal; return 'TEST-result'; }, { timeoutMs: 10000 }), 'TEST-result');
  assert.equal(cleared.mock.callCount(), 1);
  assert.equal(signal.aborted, true); assert.notEqual(signal.reason?.kind, 'timeout');
});
test('observation deadline rejects with the caller reason over a reader error', async () => {
  const controller = new AbortController(), reason = new Error('TEST-stop');
  await assert.rejects(observeWithDeadline(() => { controller.abort(reason); throw new Error('TEST-reader'); }, { timeoutMs: 10000, signal: controller.signal }), error => error === reason);
});

// Passive cancellation with an abort-honouring fetch, at every step.
async function abortAt(t, point) {
  const controller = new AbortController(), reason = new Error(`TEST-stop-${point}`);
  let armed = false, reached, callsAtAbort;
  const arrived = new Promise(resolve => { reached = resolve; });
  const stop = () => { callsAtAbort = w.calls.length; controller.abort(reason); };
  const hold = () => { reached(); return new Promise(() => {}); };
  const w = await memoryWorld(t, {
    onFence: () => { if (armed && point === 'fence') { reached(); return new Promise(resolve => controller.signal.addEventListener('abort', resolve)); } },
    onFetch: (message, _signal, data) => {
      if (!armed) return;
      if (point === 'binding' && message === 'getBlockByNumber' && data.blockNumber === 0) return hold();
      if (point === message || (point === 'block' && message === 'getBlockByNumber' && data.blockNumber === 7)) return hold();
      if (point === 'body' && message === 'getTxByHash') { reached(); return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"result":200,')); } }), { headers: { 'content-type': 'application/json' } }); }
    },
  });
  const before = await w.journal.entries();
  let releaseLock;
  if (point === 'lock') w.journal.withWalletLock(`devnet/source-read/${w.source.transportBinding.bindingId}`, () => { reached(); return new Promise(resolve => { releaseLock = resolve; }); });
  armed = true;
  const read = passive(w, HASH, { signal: point === 'admission' ? AbortSignal.abort(reason) : controller.signal });
  if (point !== 'admission') { await arrived; await flush(); stop(); }
  releaseLock?.();
  await assert.rejects(read, error => error === reason);
  await flush();
  if (callsAtAbort !== undefined) assert.equal(w.calls.length, callsAtAbort);
  if (point === 'admission' || point === 'lock') { assert.deepEqual(w.calls, []); assert.equal(w.fences.acquired, 0); }
  await assertUnchanged(w, before);
  armed = false;
  assert.equal((await passive(w)).sourceDisposition, 'included');
  await w.source.close();
}
for (const point of ['admission', 'lock', 'fence', 'binding', 'getTransactionStatus', 'getTxByHash', 'block', 'body']) {
  test(`passive abort at ${point} rejects with the caller reason and releases the fence once`, t => abortAt(t, point));
}
test('a stalled connection fence past the passive deadline runs no read and rejects with timeout once released', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let stall = false, reached, release;
  const arrived = new Promise(resolve => { reached = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const w = await memoryWorld(t, { onFence: () => { if (stall) { reached(); return gate; } } });
  const before = await w.journal.entries(); stall = true;
  let outcome = 'pending';
  const read = passive(w).then(value => { outcome = { value }; }, error => { outcome = { error }; });
  await arrived; t.mock.timers.tick(10_000); await flush();
  assert.equal(outcome, 'pending');
  release(); await read;
  assert.equal(outcome.error?.kind, 'timeout'); assert.deepEqual(w.calls, []);
  assert.deepEqual(w.fences, { acquired: 1, released: 1 });
  await assertUnchanged(w, before);
  await w.source.close();
});
test('close aborts an in-flight passive read and waits for it', async t => {
  let reached; const arrived = new Promise(resolve => { reached = resolve; });
  const w = await memoryWorld(t, { onFetch: message => { if (message === 'getTransactionStatus') { reached(); return new Promise(() => {}); } } });
  const before = await w.journal.entries();
  const read = passive(w).catch(error => error);
  await arrived; assert.equal(w.held(), true);
  await w.source.close();
  assert.equal(w.held(), false); assert.deepEqual(w.fences, { acquired: 1, released: 1 });
  assert.equal((await read).code, 'transport_closed');
  await assertUnchanged(w, before);
  await assert.rejects(() => passive(w), { code: 'transport_closed' });
});

// A single wire envelope is removed by node(); direct facts cannot hide behind another.
for (const state of ['failed', 'pending', 'unknown', 'included']) {
  for (const result of [undefined, 200]) test(`passive status with direct ${state} refuses nested included status, result=${result}`, async t => {
    const w = await memoryWorld(t), before = await w.journal.entries();
    w.statusAnswer = { state, blockNumber: 8, response: { state: 'included', blockNumber: 7, ...(result === undefined ? {} : { result }) } };
    for (let repeat = 0; repeat < 2; repeat++) {
      await assert.rejects(() => passive(w), { code: 'readback_unverified' });
      await assertUnchanged(w, before);
    }
    assert.equal(w.calls.filter(call => call === 'getTxByHash').length, 0);
  });
}
for (const [name, edit] of [
  ['failed', b => { b.status = 'failed'; }],
  ['wrong height', b => { b.number = 8; }],
  ['missing transaction', b => { b.content.ordered_transactions = []; }],
  ['matching direct facts', () => {}],
]) {
  for (const result of [undefined, 200]) test(`passive inclusion block with ${name} refuses nested confirmed block, result=${result}`, async t => {
    const w = await memoryWorld(t), before = await w.journal.entries();
    const inner = structuredClone(w.block);
    if (result !== undefined) inner.result = result;
    edit(w.block); w.block.response = inner;
    for (let repeat = 0; repeat < 2; repeat++) {
      await assert.rejects(() => passive(w), { code: 'readback_unverified' });
      await assertUnchanged(w, before);
    }
    assert.equal(w.calls.filter(call => call === 'getTxByHash').length, 2);
  });
}
