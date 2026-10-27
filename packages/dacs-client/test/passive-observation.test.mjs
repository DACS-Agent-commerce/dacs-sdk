import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { createDemosChainReader } from '../src/dacs/chain.mjs';
import { fetchBoundedJson } from '../src/util/http.mjs';
import { passiveNativeWorld, HASH } from './helpers/passive-native-world.mjs';

for (const method of ['networkIdentity', 'observeTransfer']) {
  test(`actual reader ${method} refuses a pre-aborted caller without fetch`, async () => {
    let calls = 0;
    const reader = createDemosChainReader({ rpcUrl: 'https://rpc.invalid/', network: 'testnet', fetchImpl: async () => { calls++; throw new Error('TEST-fetch'); } });
    const options = { signal: AbortSignal.abort() };
    await assert.rejects(() => method === 'networkIdentity' ? reader[method](options) : reader[method](HASH, options));
    assert.equal(calls, 0);
  });
}
test('identity abort after block zero prevents the block-one fallback', async () => {
  const controller = new AbortController(); let calls = 0, forwarded;
  const reader = createDemosChainReader({ rpcUrl: 'https://rpc.invalid/', network: 'testnet', fetchImpl: async (_url, options) => {
    calls++; forwarded = options.signal; controller.abort();
    return new Response(JSON.stringify({ result: 200, response: {} }), { headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(() => reader.networkIdentity({ signal: controller.signal }));
  assert.equal(calls, 1); assert.equal(forwarded.aborted, true);
});
test('bounded fetch cancels a pending body read on caller abort', async () => {
  const controller = new AbortController(); let started, cancelled = false;
  const reading = new Promise(resolve => { started = resolve; });
  const request = fetchBoundedJson('https://rpc.invalid/', { timeoutMs: 10000, maxBytes: 1024, signal: controller.signal,
    fetchImpl: async () => new Response(new ReadableStream({ pull() { started(); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) });
  await reading; controller.abort();
  await assert.rejects(request);
  assert.equal(cancelled, true);
});
test('native passive included observations recheck exact retained facts without journal writes on repeat', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'TEST-passive-'));
  const journal = openDurableWalletJournal({ path: join(dir, 'journal.sqlite'), mode: 'create' });
  const w = passiveNativeWorld({ journal });
  t.after(async () => { await w.source.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
  await w.seed();
  const before = await w.journal.entries(), reader = w.source.chainReader();
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await reader.observePassiveTransfer(HASH);
    assert.equal(result.status, 'included'); assert.equal(result.sourceDisposition, 'included');
    assert.deepEqual(await w.journal.entries(), before); assert.deepEqual(w.writes, []);
  }
  assert.ok(w.calls.filter(call => call === 'getTxByHash').length >= 2);
  assert.equal(w.held(), false);
});
test('native passive observation rejects changed retained bytes without writing', async t => {
  const w = passiveNativeWorld(); t.after(() => w.source.close()); await w.seed();
  w.transaction.content = { ...w.transaction.content, nonce: 8 };
  const before = await w.journal.entries();
  await assert.rejects(() => w.source.chainReader().observePassiveTransfer(HASH), { code: 'readback_unverified' });
  assert.deepEqual(await w.journal.entries(), before); assert.deepEqual(w.writes, []);
});
for (const [spelling, hash] of [
  ['prefix', `0x${HASH}`],
  ['uppercase', HASH.toUpperCase()],
  ['whitespace', ` ${HASH} `],
  ['combined', ` 0x${HASH.toUpperCase()} `],
]) {
  test(`passive readback refuses a ${spelling} hash alias before source reads`, async t => {
    const w = passiveNativeWorld(); t.after(() => w.source.close()); await w.seed();
    w.transaction.content.nonce = 8;
    const before = await w.journal.entries(), calls = w.calls.length;
    await assert.rejects(() => w.source.chainReader().observePassiveTransfer(hash), { code: 'invalid_params' });
    assert.equal(w.calls.length, calls);
    assert.deepEqual(await w.journal.entries(), before); assert.deepEqual(w.writes, []);
  });
}
test('passive included readback requires a retained native intent', async t => {
  const w = passiveNativeWorld(); t.after(() => w.source.close());
  await assert.rejects(() => w.source.chainReader().observePassiveTransfer(HASH), { code: 'readback_unverified' });
  assert.deepEqual(await w.journal.entries(), []); assert.deepEqual(w.writes, []);
});
test('passive included readback refuses a retained non-native intent', async t => {
  const w = passiveNativeWorld(); t.after(() => w.source.close()); await w.seed();
  const key = `devnet/native-transfer/${HASH}`, row = await w.journal.get(key);
  row.signedTransaction.content.type = 'storageProgram';
  await w.journal.put(key, row); w.writes.length = 0;
  const before = await w.journal.entries();
  await assert.rejects(() => w.source.chainReader().observePassiveTransfer(HASH), { code: 'readback_unverified' });
  assert.deepEqual(await w.journal.entries(), before); assert.deepEqual(w.writes, []);
});
for (const changed of [false, true]) {
  test(`passive readback refuses a reopened lane-only prefix with ${changed ? 'changed' : 'matching'} node bytes`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'TEST-passive-prefix-')), path = join(dir, 'journal.sqlite');
    let journal = openDurableWalletJournal({ path, mode: 'create' }), w;
    t.after(async () => { await w?.source.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
    w = passiveNativeWorld({ journal }); await w.seed({ laneOnly: true });
    const before = await journal.entries(), journalId = journal.journalId;
    assert.equal(await journal.get(`devnet/native-transfer/${HASH}`), undefined);
    assert.ok(before.some(([key]) => key.startsWith('devnet/native-wallet/')));
    await w.source.close(); journal.close();
    journal = openDurableWalletJournal({ path, mode: 'open', expectedJournalId: journalId });
    w = passiveNativeWorld({ journal });
    if (changed) {
      w.transaction.content.amount = '2000000000';
      w.transaction.content.data[1].args[1] = '2000000000';
    }
    for (let repeat = 0; repeat < 2; repeat++) {
      await assert.rejects(() => w.source.chainReader().observePassiveTransfer(HASH), { code: 'readback_unverified' });
      assert.deepEqual(await journal.entries(), before); assert.deepEqual(w.writes, []);
    }
  });
}
for (const state of ['unknown', 'pending']) {
  test(`passive ${state} readback needs no retained intent`, async t => {
    const w = passiveNativeWorld({ state }); t.after(() => w.source.close());
    assert.notEqual((await w.source.chainReader().observePassiveTransfer(HASH)).status, 'included');
    assert.deepEqual(await w.journal.entries(), []); assert.deepEqual(w.writes, []);
  });
}
test('passive failed execution needs no retained intent', async t => {
  const w = passiveNativeWorld({ status: 'failed' }); t.after(() => w.source.close());
  assert.equal((await w.source.chainReader().observePassiveTransfer(HASH)).status, 'invalid');
  assert.deepEqual(await w.journal.entries(), []); assert.deepEqual(w.writes, []);
});
for (const stage of ['broadcast-started', 'broadcast-accepted', 'broadcast-answered', 'observed', 'failed']) {
  test(`passive readback authenticates fresh facts for a retained ${stage} intent`, async t => {
    const w = passiveNativeWorld(); t.after(() => w.source.close()); await w.seed();
    const key = `devnet/native-transfer/${HASH}`, row = await w.journal.get(key);
    row.stage = stage; await w.journal.put(key, row); w.writes.length = 0;
    const before = await w.journal.entries();
    assert.equal((await w.source.chainReader().observePassiveTransfer(HASH)).sourceDisposition, 'included');
    assert.deepEqual(await w.journal.entries(), before); assert.deepEqual(w.writes, []);
  });
}
test('native source abort reaches its actual bounded identity fetch and stops later reads', async t => {
  const controller = new AbortController(); let abort = false, forwarded;
  const w = passiveNativeWorld({ onFetch: async (_message, signal) => {
    if (!abort) return;
    forwarded = signal; controller.abort(); signal.throwIfAborted();
  } });
  t.after(() => w.source.close()); await w.seed(); abort = true;
  const before = await w.journal.entries(), count = w.calls.length;
  await assert.rejects(() => w.source.chainReader().observePassiveTransfer(HASH, { signal: controller.signal }));
  assert.equal(forwarded.aborted, true); assert.equal(w.calls.length, count + 1);
  await w.source.close();
  assert.deepEqual(await w.journal.entries(), before); assert.deepEqual(w.writes, []); assert.equal(w.held(), false);
});
for (const target of ['getTransactionStatus', 'getTxByHash', 'getBlockByNumber']) {
  test(`actual transfer reader forwards abort during ${target}`, async () => {
    const controller = new AbortController(), calls = [];
    const reader = createDemosChainReader({ rpcUrl: 'https://rpc.invalid/', network: 'testnet', fetchImpl: async (_url, options) => {
      const { message } = JSON.parse(options.body).params[0]; calls.push({ message, signal: options.signal });
      if (message === target) controller.abort();
      return new Response(JSON.stringify({ result: 200, response: message === 'getTransactionStatus' ? { state: 'included', blockNumber: 7 } : {} }), { headers: { 'content-type': 'application/json' } });
    } });
    await assert.rejects(() => reader.observeTransfer(HASH, { signal: controller.signal }));
    assert.ok(calls.some(call => call.message === target));
    assert.ok(calls.every(call => call.signal.aborted));
  });
}
test('failed execution is refused without releasing retained claims', async t => {
  const w = passiveNativeWorld({ status: 'failed' }); t.after(() => w.source.close()); await w.seed();
  const before = await w.journal.entries();
  const result = await w.source.chainReader().observePassiveTransfer(HASH);
  assert.equal(result.status, 'invalid');
  assert.deepEqual(await w.journal.entries(), before); assert.deepEqual(w.writes, []);
});

test('observation deadline aborts its reader using a controlled timer', async t => {
  const { observeWithDeadline } = await import('../src/util/http.mjs');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const read = observeWithDeadline(options => { signal = options.signal; return new Promise(() => {}); }, { timeoutMs: 123 });
  await Promise.resolve(); t.mock.timers.tick(123);
  await assert.rejects(read, { kind: 'timeout' });
  assert.equal(signal.aborted,true);
});
test('observation deadline preserves reader errors and aborts its signal on completion', async () => {
  const { observeWithDeadline } = await import('../src/util/http.mjs');
  const cause = new Error('TEST-cause'); let signal;
  await assert.rejects(observeWithDeadline(options => { signal = options.signal; throw cause; }, { timeoutMs: 10000 }), error => error === cause);
  assert.equal(signal.aborted,true);
});

for(const status of ['included','finalized'])test(`passive readback accepts the core final body label ${status}`, async t=>{
  const w=passiveNativeWorld({status});t.after(()=>w.source.close());await w.seed();
  const before=await w.journal.entries();
  assert.equal((await w.source.chainReader().observePassiveTransfer(HASH)).sourceDisposition,'included');
  assert.deepEqual(await w.journal.entries(),before);assert.deepEqual(w.writes,[]);
});
test('passive readback rejects inconsistent transfer facts across body reads', async t=>{
  let active=false,reads=0;
  const w=passiveNativeWorld({onFetch:message=>{
    if(active&&message==='getTxByHash'){
      const amount=++reads===1?'2000000000':'1000000000';
      w.transaction.content.amount=amount;w.transaction.content.data[1].args[1]=amount;
    }
  }});t.after(()=>w.source.close());await w.seed();active=true;
  const before=await w.journal.entries();
  await assert.rejects(()=>w.source.chainReader().observePassiveTransfer(HASH),{code:'readback_unverified'});
  assert.deepEqual(await w.journal.entries(),before);assert.deepEqual(w.writes,[]);
});
test('bounded fetch reports abort even when stream cancellation never settles', async()=>{
  const controller=new AbortController();let error;
  const read=fetchBoundedJson('https://rpc.invalid/',{timeoutMs:10000,maxBytes:1024,signal:controller.signal,
    fetchImpl:async()=>{
      controller.abort(new Error('TEST-abort'));
      return new Response(new ReadableStream({cancel(){return new Promise(()=>{});}}),{headers:{'content-type':'application/json'}});
    }}).catch(cause=>{error=cause;});
  for(let i=0;i<100;i++)await Promise.resolve();
  assert.equal(error?.message,'TEST-abort');await read;
});
test('the actual transfer reader enforces a deadline when fetch ignores abort', async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let started,error;
  const entered=new Promise(resolve=>{started=resolve;});
  const reader=createDemosChainReader({rpcUrl:'https://rpc.invalid/',network:'testnet',timeoutMs:123,
    fetchImpl:()=>{started();return new Promise(()=>{});}});
  const read=reader.observeTransfer(HASH).catch(cause=>{error=cause;});
  await entered;t.mock.timers.tick(123);
  for(let i=0;i<100;i++)await Promise.resolve();
  assert.equal(error?.kind,'timeout');await read;
});

test('the passive deadline also bounds a binding fence after included readback', async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  let active=false,stall=false,entered,release,error;
  const reached=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const w=passiveNativeWorld({
    onFetch:(message,_signal,data)=>{if(active&&message==='getBlockByNumber'&&data.blockNumber===7)stall=true;},
    onFence:()=>{if(stall){entered();return gate;}}
  });
  await w.seed();active=true;
  const before=await w.journal.entries();
  const read=w.source.chainReader().observePassiveTransfer(HASH).catch(cause=>{error=cause;});
  await reached;t.mock.timers.tick(10000);
  for(let i=0;i<100;i++)await Promise.resolve();
  try {assert.equal(error?.kind,'timeout');assert.deepEqual(await w.journal.entries(),before);assert.deepEqual(w.writes,[]);}
  finally {
    release();await read;await w.source.close();
    for(let i=0;i<100;i++)await Promise.resolve();
    assert.equal(w.held(),false);
  }
});
