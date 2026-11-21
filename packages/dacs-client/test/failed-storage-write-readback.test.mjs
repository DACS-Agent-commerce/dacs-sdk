// Readback of a storage CREATE that the node recorded as failed, on the offline
// scripted node world. No network, chain or funds.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDurableWalletJournal } from '../src/wallet/durable-journal.mjs';
import { createWorld, JOB_IDS } from './helpers/native-create-world.mjs';

const BLOCK = 74004;
const REFERENCE_BLOCK = 74001;
const CODE = 'TX_EXPIRED_REFERENCE_BLOCK_OUT_OF_RANGE';
const NODE_MESSAGE = 'Reference block expired. Expected: 74002 - 74003 got 74001';
const reply = (response) => ({ result: 200, response, require_reply: false, extra: '' });
const unavailable = () => ({ result: 400, response: 'error', require_reply: false, extra: null });
const failedBody = (tx, overrides = {}) => ({ hash: tx.hash, blockNumber: BLOCK, status: 'failed', content: structuredClone(tx.content),
  attrs: { code: CODE, message: NODE_MESSAGE, reference_block: REFERENCE_BLOCK }, ...overrides });

/**
 * A world whose node answers `getTransactionStatus` and `getTxByHash` from `answers`, over a fresh durable journal.
 * `referenceBlock()` gives the reference block of each confirmation.
 */
function scriptedWorld(t, answers, timeoutMs, referenceBlock) {
  const dir = mkdtempSync(join(tmpdir(), 'failed-storage-write-'));
  const journal = openDurableWalletJournal({ path: join(dir, 'journal.sqlite'), mode: 'create' });
  t.after(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  const world = createWorld({ journal, answer: (message, call) => answers[message]?.(call), timeoutMs, referenceBlock });
  return { world, journal };
}

/** The node's confirmed block BLOCK lists `hashes`; every other block read gets the world's default. */
const confirmedBlock = (...hashes) => (call) => call.data?.blockNumber === BLOCK
  ? reply({ number: BLOCK, status: 'confirmed', hash: 'b'.repeat(64), content: { ordered_transactions: hashes } }) : undefined;

/** A retained storage CREATE at nonce 1, as an accepted broadcast left it. */
async function retainedCreate(world) {
  const tx = await world.makeCreate(JOB_IDS[0], 1);
  await world.retain(tx, 'broadcast-accepted');
  return tx;
}

/** The content of a native transfer of 5 by the world's wallet at `nonce`. */
const transferContent = (world, nonce) => ({ type: 'native', from: world.wallet.address, to: `0x${'d'.repeat(64)}`, amount: 5, nonce, timestamp: 1_900_000_000_000,
  data: ['native', { nativeOperation: 'send', args: [`0x${'d'.repeat(64)}`, 5] }] });

/** A retained native transfer by the world's wallet at nonce 3. */
async function retainedTransfer(world) {
  const tx = { hash: 'e'.repeat(64), content: transferContent(world, 3), signature: { type: 'ed25519', data: `0x${'33'.repeat(64)}` } };
  await world.retain(tx, 'broadcast-accepted');
  return tx;
}

const expectedFailure = (tx) => ({
  disposition: 'failed', hash: tx.hash, nonce: 1, noResend: true, resolved: false,
  failure: { blockNumber: BLOCK, code: CODE, message: NODE_MESSAGE, referenceBlock: REFERENCE_BLOCK },
  reason: `the node recorded storage write ${tx.hash} as failed in block ${BLOCK} (${CODE}: ${NODE_MESSAGE}); nothing was applied. It is never resent or re-made automatically.`,
});

test('a storage CREATE the node status calls failed reads back as failed, carries its proof and is never resent', async (t) => {
  const answers = {};
  const { world, journal } = scriptedWorld(t, answers);
  const tx = await retainedCreate(world);
  answers.getTransactionStatus = () => reply({ state: 'failed' });
  answers.getTxByHash = () => reply(failedBody(tx));
  answers.getBlockByNumber = confirmedBlock(tx.hash);
  const before =await journal.get(`devnet/native-transfer/${tx.hash}`);
  assert.deepEqual(await world.readback(tx.hash), expectedFailure(tx));
  assert.deepEqual(await world.recover(tx), { disposition: 'pending', hash: tx.hash, noResend: true }, 'recovery reads the failed write and sends nothing');
  assert.deepEqual(world.sent, { confirms: [], broadcasts: [] });
  assert.deepEqual(await journal.get(`devnet/native-transfer/${tx.hash}`), before, 'the retained intent is kept as it was');
});

test('a storage CREATE included with a failed body reads back as failed, not as differing', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedCreate(world);
  answers.getTransactionStatus = () => reply({ state: 'included', blockNumber: BLOCK });
  answers.getTxByHash = () => reply(failedBody(tx));
  answers.getBlockByNumber = confirmedBlock(tx.hash);
  assert.deepEqual(await world.readback(tx.hash), expectedFailure(tx));
  assert.deepEqual(world.sent, { confirms: [], broadcasts: [] });
});

test('a failed storage CREATE body whose content differs from the retained bytes still fails as differing', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedCreate(world);
  const content = structuredClone(tx.content);
  content.data[1].programName = `${content.data[1].programName}x`;
  answers.getTransactionStatus = () => reply({ state: 'included', blockNumber: BLOCK });
  answers.getTxByHash = () => reply(failedBody(tx, { content }));
  await assert.rejects(world.readback(tx.hash), { code: 'readback_unverified', message: 'the failed storage write differs from the retained signed transaction' });
});

test('a failed storage CREATE body in another block than its status is refused', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedCreate(world);
  answers.getTransactionStatus = () => reply({ state: 'failed', blockNumber: BLOCK + 1 });
  answers.getTxByHash = () => reply(failedBody(tx));
  await assert.rejects(world.readback(tx.hash), { code: 'readback_unverified', message: 'the failed storage write differs from the retained signed transaction' });
});

test('node failure text longer than the limit is left out of the failed result', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedCreate(world);
  answers.getTransactionStatus = () => reply({ state: 'included', blockNumber: BLOCK });
  answers.getTxByHash = () => reply(failedBody(tx, { attrs: { code: CODE, message: 'x'.repeat(513), reference_block: -1 } }));
  answers.getBlockByNumber = confirmedBlock(tx.hash);
  const read = await world.readback(tx.hash);
  assert.deepEqual(read.failure, { blockNumber: BLOCK, code: CODE, message: null, referenceBlock: null });
  assert.equal(read.reason, `the node recorded storage write ${tx.hash} as failed in block ${BLOCK} (${CODE}); nothing was applied. It is never resent or re-made automatically.`);
});

test('a storage CREATE whose status is failed but whose body is pending stays pending', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedCreate(world);
  answers.getTransactionStatus = () => reply({ state: 'failed' });
  answers.getTxByHash = () => reply({ hash: tx.hash, status: 'pending', content: structuredClone(tx.content) });
  assert.deepEqual(await world.readback(tx.hash), { disposition: 'pending', hash: tx.hash, nonce: 1, noResend: true, referenceBlock: null });
  assert.deepEqual(world.sent, { confirms: [], broadcasts: [] });
});

test('a storage CREATE whose status is failed but whose body is unavailable is not read as failed', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedCreate(world);
  answers.getTransactionStatus = () => reply({ state: 'failed' });
  answers.getTxByHash = unavailable;
  await assert.rejects(world.readback(tx.hash), { code: 'upstream_unavailable' });
  assert.deepEqual(world.sent, { confirms: [], broadcasts: [] });
});

test('a storage CREATE included with no body is not read as failed', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedCreate(world);
  answers.getTransactionStatus = () => reply({ state: 'included', blockNumber: BLOCK });
  answers.getTxByHash = () => reply(null);
  await assert.rejects(world.readback(tx.hash), { code: 'readback_unverified' });
  assert.deepEqual(world.sent, { confirms: [], broadcasts: [] });
});

const STATUS_SHAPES = { 'failed status': { state: 'failed' }, 'included status': { state: 'included', blockNumber: BLOCK } };
const pendingRead = (tx) => ({ disposition: 'pending', hash: tx.hash, nonce: 1, noResend: true, referenceBlock: null });

for (const [shape, status] of Object.entries(STATUS_SHAPES)) {
  const named = (answers, tx) => { answers.getTransactionStatus = () => reply(status); answers.getTxByHash = () => reply(failedBody(tx)); };

  test(`a failed storage CREATE (${shape}) whose named block omits the hash stays pending`, async (t) => {
    const answers = {};
    const { world } = scriptedWorld(t, answers);
    const tx = await retainedCreate(world);
    named(answers, tx);
    answers.getBlockByNumber = confirmedBlock('c'.repeat(64));
    assert.deepEqual(await world.readback(tx.hash), pendingRead(tx));
    assert.deepEqual(world.sent, { confirms: [], broadcasts: [] });
  });

  test(`a failed storage CREATE (${shape}) whose named block is not confirmed stays pending`, async (t) => {
    const answers = {};
    const { world } = scriptedWorld(t, answers);
    const tx = await retainedCreate(world);
    named(answers, tx);
    answers.getBlockByNumber = (call) => call.data?.blockNumber === BLOCK
      ? reply({ number: BLOCK, status: 'pending', hash: 'b'.repeat(64), content: { ordered_transactions: [tx.hash] } }) : undefined;
    assert.deepEqual(await world.readback(tx.hash), pendingRead(tx));
  });

  test(`a failed storage CREATE (${shape}) whose named block answers as another block stays pending`, async (t) => {
    const answers = {};
    const { world } = scriptedWorld(t, answers);
    const tx = await retainedCreate(world);
    named(answers, tx);
    answers.getBlockByNumber = (call) => call.data?.blockNumber === BLOCK
      ? reply({ number: BLOCK + 1, status: 'confirmed', hash: 'b'.repeat(64), content: { ordered_transactions: [tx.hash] } }) : undefined;
    assert.deepEqual(await world.readback(tx.hash), pendingRead(tx));
  });

  test(`a failed storage CREATE (${shape}) whose named block cannot be read stays pending`, async (t) => {
    const answers = {};
    const { world } = scriptedWorld(t, answers);
    const tx = await retainedCreate(world);
    named(answers, tx);
    answers.getBlockByNumber = (call) => call.data?.blockNumber === BLOCK ? unavailable() : undefined;
    assert.deepEqual(await world.readback(tx.hash), pendingRead(tx));
    assert.deepEqual(world.sent, { confirms: [], broadcasts: [] });
  });

  test(`a failed storage CREATE (${shape}) whose named block read times out stays pending`, async (t) => {
    const answers = {};
    // The read's own timer does not keep the process alive.
    const keepAlive = setInterval(() => {}, 20);
    t.after(() => clearInterval(keepAlive));
    const { world } = scriptedWorld(t, answers, 50);
    const tx = await retainedCreate(world);
    named(answers, tx);
    answers.getBlockByNumber = (call) => call.data?.blockNumber === BLOCK ? new Promise(() => {}) : undefined;
    assert.deepEqual(await world.readback(tx.hash), pendingRead(tx));
  });
}

test('a failed storage CREATE whose named block read is over the byte limit stays pending', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedCreate(world);
  answers.getTransactionStatus = () => reply({ state: 'failed' });
  answers.getTxByHash = () => reply(failedBody(tx));
  answers.getBlockByNumber = (call) => call.data?.blockNumber === BLOCK
    ? reply({ number: BLOCK, status: 'confirmed', hash: 'b'.repeat(64), content: { ordered_transactions: [tx.hash], padding: 'x'.repeat(4 * 1024 * 1024) } }) : undefined;
  assert.deepEqual(await world.readback(tx.hash), pendingRead(tx));
});

test('a sent storage CREATE recorded as failed whose named block omits the hash stays pending with the reference block its confirmation carried', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers, undefined, () => REFERENCE_BLOCK);
  const tx = await world.makeCreate(JOB_IDS[0], 1), lease = await world.lease();
  await world.broadcast(lease, await world.confirm(tx), tx.hash);
  answers.getTransactionStatus = () => reply({ state: 'failed' });
  answers.getTxByHash = () => reply(failedBody(tx));
  answers.getBlockByNumber = confirmedBlock('c'.repeat(64));
  assert.deepEqual(await world.readback(tx.hash), { ...pendingRead(tx), referenceBlock: REFERENCE_BLOCK });
  assert.deepEqual(world.sent, { confirms: [tx.hash], broadcasts: [tx.hash] });
});

test('a failed storage CREATE body that names another hash is refused', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedCreate(world);
  answers.getTransactionStatus = () => reply({ state: 'failed' });
  answers.getTxByHash = () => reply(failedBody(tx, { hash: 'c'.repeat(64) }));
  answers.getBlockByNumber = confirmedBlock(tx.hash);
  await assert.rejects(world.readback(tx.hash), { code: 'readback_unverified', message: 'the failed storage write differs from the retained signed transaction' });
});

for (const [label, blockNumber] of [['absent', undefined], ['negative', -1], ['fractional', 1.5], ['text', String(BLOCK)]]) {
  test(`a failed storage CREATE body whose block number is ${label} is refused`, async (t) => {
    const answers = {};
    const { world } = scriptedWorld(t, answers);
    const tx = await retainedCreate(world);
    answers.getTransactionStatus = () => reply({ state: 'failed' });
    answers.getTxByHash = () => reply(failedBody(tx, { blockNumber }));
    answers.getBlockByNumber = confirmedBlock(tx.hash);
    await assert.rejects(world.readback(tx.hash), { code: 'readback_unverified', message: 'the failed storage write differs from the retained signed transaction' });
  });
}

const UNSAFE_TEXTS = {
  'a line break': 'first line\nsecond line',
  'a terminal escape': '\u001b[31mred',
  'a delete character': 'before\u007fafter',
  'a C1 control character': 'before\u009bafter',
  'a bidirectional override': 'before\u202eafter',
  'a zero-width character': 'before\u200bafter',
  'a line separator': 'before\u2028after',
};

for (const [kind, text] of Object.entries(UNSAFE_TEXTS)) {
  test(`node failure message with ${kind} is left out of the failed result`, async (t) => {
    const answers = {};
    const { world } = scriptedWorld(t, answers);
    const tx = await retainedCreate(world);
    answers.getTransactionStatus = () => reply({ state: 'failed' });
    answers.getTxByHash = () => reply(failedBody(tx, { attrs: { code: CODE, message: text, reference_block: REFERENCE_BLOCK } }));
    answers.getBlockByNumber = confirmedBlock(tx.hash);
    const read = await world.readback(tx.hash);
    assert.deepEqual(read.failure, { blockNumber: BLOCK, code: CODE, message: null, referenceBlock: REFERENCE_BLOCK });
    assert.equal(read.reason, `the node recorded storage write ${tx.hash} as failed in block ${BLOCK} (${CODE}); nothing was applied. It is never resent or re-made automatically.`);
  });

  test(`node failure code with ${kind} is left out of the failed result`, async (t) => {
    const answers = {};
    const { world } = scriptedWorld(t, answers);
    const tx = await retainedCreate(world);
    answers.getTransactionStatus = () => reply({ state: 'failed' });
    answers.getTxByHash = () => reply(failedBody(tx, { attrs: { code: text, message: NODE_MESSAGE, reference_block: REFERENCE_BLOCK } }));
    answers.getBlockByNumber = confirmedBlock(tx.hash);
    const read = await world.readback(tx.hash);
    assert.deepEqual(read.failure, { blockNumber: BLOCK, code: null, message: NODE_MESSAGE, referenceBlock: REFERENCE_BLOCK });
    assert.equal(read.reason, `the node recorded storage write ${tx.hash} as failed in block ${BLOCK}; nothing was applied. It is never resent or re-made automatically.`);
  });
}

test('a storage CREATE read back as failed keeps its lane row and refuses a new signing lease after the journal is reopened', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'failed-storage-write-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'journal.sqlite');
  const created = openDurableWalletJournal({ path, mode: 'create' });
  const tx = await retainedCreate(createWorld({ journal: created }));
  created.close();
  const journal = openDurableWalletJournal({ path, mode: 'open' });
  t.after(() => journal.close());
  const answers = {
    getTransactionStatus: () => reply({ state: 'failed' }),
    getTxByHash: () => reply(failedBody(tx)),
    getBlockByNumber: confirmedBlock(tx.hash),
  };
  const world = createWorld({ journal, answer: (message, call) => answers[message]?.(call) });
  const laneBefore = await journal.get(world.laneKey);
  assert.deepEqual(await world.readback(tx.hash), expectedFailure(tx));
  assert.deepEqual(await journal.get(world.laneKey), laneBefore, 'the lane row is kept as it was');
  await assert.rejects(world.lease(), { code: 'outcome_unknown' });
  assert.deepEqual(world.sent, { confirms: [], broadcasts: [] });
});

test('a payment nonce whose only retained write is a storage CREATE recorded as failed has no consumer in the source', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedCreate(world);
  answers.getTransactionStatus = () => reply({ state: 'included', blockNumber: BLOCK });
  answers.getTxByHash = () => reply(failedBody(tx));
  answers.getBlockByNumber = confirmedBlock(tx.hash);
  assert.equal(await world.capability.nativeNonceConsumer(world.wallet.address, { content: transferContent(world, 1) }), null);
});

test('a native transfer included with a failed body keeps its failed result unchanged', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedTransfer(world);
  answers.getTransactionStatus = () => reply({ state: 'included', blockNumber: BLOCK });
  answers.getTxByHash = () => reply(failedBody(tx));
  assert.deepEqual(await world.readback(tx.hash), { disposition: 'failed', hash: tx.hash, nonce: 3, noResend: true, resolved: false });
});

test('a native transfer whose status is failed still reads back as pending', async (t) => {
  const answers = {};
  const { world } = scriptedWorld(t, answers);
  const tx = await retainedTransfer(world);
  answers.getTransactionStatus = () => reply({ state: 'failed' });
  answers.getTxByHash = () => reply(failedBody(tx));
  assert.deepEqual(await world.readback(tx.hash), { disposition: 'pending', hash: tx.hash, nonce: 3, noResend: true });
});
