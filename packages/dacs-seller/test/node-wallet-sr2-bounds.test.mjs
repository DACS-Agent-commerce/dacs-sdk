// The SR-2 readback in source mode over the seller's Node wallet: one aggregate deadline per resolution reaches the source's
// reads as their signal and the time left, nothing starts after it, and the 1 MiB reply limit holds through the source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';
import { jsonResponse, ok, replyTo, sellerWalletWorld } from './helpers/seller-node-wallet-world.mjs';

const { createDemosSr2Adapter, createInMemoryDemosSr2Journal, DEMOS_SR2_REPLY_BYTES } = await import('../src/dacs/demos-sr2-adapter.mjs');
const { registerHeldTransportFacade, TP1_REVIEWED_BLOCK_TWO_HASH } = await import('../../dacs-client/src/wallet/devnet-native-transport.mjs');

const SR2_TIMEOUT_MS = 5_000;
const LOGICAL_ADDRESS = 'dacs4:payment:TEST-job-a:demos-native:DEM:2';
const settle = () => new Promise(resolve => setImmediate(resolve));
const causeMessages = error => { const messages = []; for (let link = error; link instanceof Error; link = link.cause) messages.push(link.message); return messages; };

// A full name-index page of another program's rows: the resolution reads the next page.
const FOREIGN_PAGE = Array.from({ length: 50 }, (_, index) => ({ storageAddress: `stor-${index.toString(16).padStart(40, '0')}`, programName: 'TEST-other-program' }));
// The Node2 identity layout: block 0 answers the reviewed error envelope, so the source falls back to the genesis projection
// (block "0") and then to blocks 1 and 2.
const NODE2_BLOCK_ONE_HASH = 'c'.repeat(64);
const node2Block = (id, number, hash, previousHash) => ({ result: 200, require_reply: false, extra: '', response: { id, number, hash, status: 'confirmed', proposer: '',
  next_proposer: '', validation_data: {}, attrs: {}, content: { ordered_transactions: [], encrypted_transactions_hashes: [], per_address_transactions: {}, web2data: {},
    previousHash, timestamp: 1, peerlist: [], l2ps_partecipating_nodes: [], l2ps_banned_nodes: [], native_tables_hashes: {} } } });
const NODE2_IDENTITY_BLOCKS = new Map([
  [0, { result: 400, response: 'error', require_reply: false, extra: 'Block number not provided' }],
  ['0', { result: 200, response: { number: 0, hash: TP1_APPROVED_IDENTITY_RECORD.chainIdentity }, require_reply: false, extra: '' }],
  [1, node2Block(2, 1, NODE2_BLOCK_ONE_HASH, TP1_APPROVED_IDENTITY_RECORD.chainIdentity)],
  [2, node2Block(3, 2, TP1_REVIEWED_BLOCK_TWO_HASH, NODE2_BLOCK_ONE_HASH)],
]);
const node2Identity = call => (call.message === 'getBlockByNumber' ? NODE2_IDENTITY_BLOCKS.get(call.data.blockNumber) : undefined);

// The wallet's source capability with every readRpc and observeBinding call recorded, registered as the client registers its facade.
async function recordedSource(t) {
  const world = await sellerWalletWorld(t), source = world.wallet.sourceCapability, calls = [];
  const recording = Object.freeze({ ...source,
    readRpc: (path, body, options) => { calls.push({ member: 'readRpc', message: body?.params?.[0]?.message, options }); return source.readRpc(path, body, options); },
    observeBinding: options => { calls.push({ member: 'observeBinding', options }); return source.observeBinding(options); } });
  registerHeldTransportFacade(recording, source);
  const adapter = createDemosSr2Adapter({ rpcUrl: source.pins.endpoint, journal: createInMemoryDemosSr2Journal(), sourceCapability: recording, timeoutMs: SR2_TIMEOUT_MS });
  return { world, adapter, calls, expectedWriter: `did:demos:agent:${world.wallet.address.slice(2)}` };
}

// Holds the first nodeCall that `stalls(call)` picks until `late()` answers it, and answers the others with `answer(call)` (the
// scripted node's own answer when that is undefined); `reached` resolves with the held request.
function stallWhere(node, stalls, answer = () => undefined) {
  const stalled = {};
  stalled.reached = new Promise(resolve => {
    let held = false;
    node.reply = row => {
      const call = row.body?.params[0];
      if (!call) return undefined;
      if (!held && stalls(call)) {
        held = true; resolve(row);
        return new Promise(answerLate => { stalled.late = () => answerLate(jsonResponse(ok([]))); });
      }
      const answered = answer(call);
      return answered === undefined ? undefined : jsonResponse(answered);
    };
  });
  return stalled;
}

test('one aggregate SR-2 deadline covers a multi-read resolution through the composition, reaches readRpc and observeBinding as signal and remaining time, and no request starts after it', async t => {
  const { world, adapter, calls, expectedWriter } = await recordedSource(t);
  let pages = 0;
  const stalled = stallWhere(world.node, call => call.message === 'searchStoragePrograms' && ++pages === 2,
    call => (call.message === 'searchStoragePrograms' ? ok(FOREIGN_PAGE) : node2Identity(call)));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reading = adapter.read(LOGICAL_ADDRESS, { expectedWriter }).then(() => null, error => error);
  const row = await stalled.reached;
  t.mock.timers.tick(SR2_TIMEOUT_MS);
  const error = await reading;
  t.mock.timers.reset();
  assert.equal(error?.code, 'indeterminate', 'the aggregate deadline ends the resolution');
  assert.ok(calls.some(call => call.member === 'observeBinding') && calls.filter(call => call.member === 'readRpc').length >= 2, `several reads in one resolution: ${calls.map(call => call.message ?? call.member)}`);
  const [{ options: first }] = calls;
  for (const { member, options } of calls) {
    assert.equal(options.signal, first.signal, `${member} gets the resolution's one signal`);
    assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 1 && options.timeoutMs <= SR2_TIMEOUT_MS, `${member} gets the time left: ${options.timeoutMs}`);
  }
  assert.ok(calls.every(({ options }, index) => index === 0 || options.timeoutMs <= calls[index - 1].options.timeoutMs), 'the time left never grows');
  assert.ok(calls.filter(call => call.member === 'readRpc').every(({ options }) => options.maxBytes === DEMOS_SR2_REPLY_BYTES));
  assert.ok(first.signal.aborted && row.signal?.aborted, 'the deadline aborts the signal the stalled request carries');
  const callsAtDeadline = calls.length, requestsAtDeadline = world.node.calls.length;
  stalled.late();
  await settle();
  assert.equal(calls.length, callsAtDeadline, 'no read starts after the deadline');
  assert.equal(world.node.calls.length, requestsAtDeadline, 'no request reaches the node after the deadline');
});

test('cancellation inside the source identity acquisition and between its fallback reads starts no later request', async t => {
  // Block 0 is the identity acquisition's first read; "0", 1 and 2 are its fallback reads after the block-zero error.
  for (const height of [0, '0', 1, 2]) {
    const { world, adapter, calls, expectedWriter } = await recordedSource(t);
    const label = `block ${JSON.stringify(height)}`;
    const stalled = stallWhere(world.node, call => call.message === 'getBlockByNumber' && call.data.blockNumber === height, node2Identity);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const reading = adapter.read(LOGICAL_ADDRESS, { expectedWriter }).then(() => null, error => error);
    const row = await stalled.reached;
    t.mock.timers.tick(SR2_TIMEOUT_MS);
    const error = await reading;
    t.mock.timers.reset();
    assert.equal(error?.code, 'indeterminate', label);
    assert.deepEqual(calls.map(call => call.member), ['observeBinding'], `${label}: cancelled inside the identity acquisition`);
    assert.ok(row.signal?.aborted, `${label}: its request is aborted`);
    const requests = world.node.calls.length;
    stalled.late();
    await settle();
    assert.equal(world.node.calls.length, requests, `${label}: no later fallback or identity read starts`);
    await world.wallet.close();
  }
});

// A JSON-RPC answer whose UTF-8 body is exactly `bytes` long.
function replyOfSize(bytes) {
  const empty = JSON.stringify({ result: 200, response: '', require_reply: false, extra: null });
  return JSON.stringify({ result: 200, response: 'x'.repeat(bytes - Buffer.byteLength(empty)), require_reply: false, extra: null });
}

test('through the real source readRpc, an SR-2 reply of 1 MiB is admitted and 1 MiB plus one is refused before decode with its cause, with and without content-length', async t => {
  for (const declared of [true, false]) {
    for (const bytes of [DEMOS_SR2_REPLY_BYTES, DEMOS_SR2_REPLY_BYTES + 1]) {
      const { world, adapter, expectedWriter } = await recordedSource(t);
      const body = replyOfSize(bytes);
      assert.equal(Buffer.byteLength(body), bytes);
      replyTo(world.node, 'searchStoragePrograms', () => new Response(body, { headers: { 'content-type': 'application/json', ...(declared ? { 'content-length': String(bytes) } : {}) } }));
      const error = await adapter.read(LOGICAL_ADDRESS, { expectedWriter }).then(() => null, refused => refused);
      const messages = causeMessages(error).join(' | ');
      const label = `${bytes} bytes, content-length ${declared ? 'declared' : 'absent'}`;
      if (bytes === DEMOS_SR2_REPLY_BYTES) assert.doesNotMatch(messages, /exceeds byte limit/, `${label} is admitted: ${messages}`);
      else assert.match(messages, /response exceeds byte limit/, `${label} is refused with its cause: ${messages}`);
      await world.wallet.close();
    }
  }
});
