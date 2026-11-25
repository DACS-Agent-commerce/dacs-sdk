// Node e6af8f40's storage-write replies: its mempool broadcast reply, its refusal on a node that is not a staked
// validator, and its not-found lookup that names the block it searched through (endpointExecution.ts and
// transactionHandlers.ts there). The classifiers run directly, then through the real transport, boundary and durable
// journal against a scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyStorageWriteSubmission, storageWriteAbsent } from '../src/devnet-demo/storage-write-recovery.mjs';
import { boundedCreateWorld } from './helpers/native-create-boundary.mjs';
import { JOB_IDS } from './helpers/native-create-world.mjs';

const HASH = 'a'.repeat(64), R = 41;
const mempoolReply = (hash, extra = {}) => ({ result: 200, response: null, require_reply: false,
  extra: { confirmationBlock: R + 1, lastBlockNumber: R, published: true, hash, disposition: 'mempool', ...extra } });
const notValidatorReply = () => ({ result: 400, require_reply: false, extra: { error: 'NOT_A_VALIDATOR' },
  response: { message: 'This node is not a staked validator and does not accept transactions; submit to a validator RPC' } });
const notFound = (extra) => ({ result: 404, response: null, require_reply: false, extra });
const unknownStatus = { result: 200, response: { state: 'unknown' }, require_reply: false, extra: '' };
const withoutKey = (reply, key) => { const extra = { ...reply.extra }; delete extra[key]; return { ...reply, extra }; };

// Mempool replies that must stay unknown, each built for the hash that was sent.
const unboundMempoolReplies = (hash) => [
  ['another hash', mempoolReply('b'.repeat(64))],
  ['another disposition', mempoolReply(hash, { disposition: 'relay' })],
  ['an extra key', mempoolReply(hash, { error: 'TEST' })],
  ...['confirmationBlock', 'lastBlockNumber', 'published', 'hash', 'disposition'].map((key) => [`no ${key}`, withoutKey(mempoolReply(hash), key)]),
];

// Not-found answers that never prove absence through R+2.
const nonProofs = [
  ['one block short', notFound({ reason: 'not_found', checkedThroughBlock: R + 1 })],
  ['no block', notFound({ reason: 'not_found' })],
  ['a negative block', notFound({ reason: 'not_found', checkedThroughBlock: -1 })],
  ['a fractional block', notFound({ reason: 'not_found', checkedThroughBlock: R + 2.5 })],
  ['an extra key', notFound({ reason: 'not_found', checkedThroughBlock: R + 2, error: 'TEST' })],
  ['a failed lookup', { result: 500, response: null, require_reply: false, extra: { reason: 'lookup_failed', error: 'TEST' } }],
];

test('the mempool broadcast reply is accepted only when it names the hash that was sent, and both older replies keep their reading', () => {
  assert.equal(classifyStorageWriteSubmission(mempoolReply(HASH), HASH), 'accepted');
  assert.equal(classifyStorageWriteSubmission(mempoolReply(HASH, { published: false }), HASH), 'accepted');
  for (const [label, reply] of unboundMempoolReplies(HASH)) assert.equal(classifyStorageWriteSubmission(reply, HASH), 'unknown', label);
  for (const reply of [mempoolReply(HASH, { confirmationBlock: null }), mempoolReply(HASH, { published: 1 }), { ...mempoolReply(HASH), response: { hash: HASH } }, { ...mempoolReply(HASH), result: 400 }])
    assert.equal(classifyStorageWriteSubmission(reply, HASH), 'unknown', JSON.stringify(reply));
  assert.equal(classifyStorageWriteSubmission({ result: 200, response: { hash: HASH }, require_reply: false, extra: null }, HASH), 'accepted');
  assert.equal(classifyStorageWriteSubmission({ result: 200, response: { message: 'Transaction relayed to validators' }, require_reply: false, extra: { confirmationBlock: 1 } }, HASH), 'accepted');
});

test('the refusal of a node that is not a staked validator is its own definite answer, never an acceptance', () => {
  assert.equal(classifyStorageWriteSubmission(notValidatorReply(), HASH), 'refused-not-validator');
  for (const reply of [{ ...notValidatorReply(), result: 200 }, { ...notValidatorReply(), extra: { error: 'OTHER' } }, { ...notValidatorReply(), response: null }, { ...notValidatorReply(), extra: { error: 'NOT_A_VALIDATOR', hash: HASH } }])
    assert.notEqual(classifyStorageWriteSubmission(reply, HASH), 'refused-not-validator', JSON.stringify(reply));
});

test('a not-found lookup proves absence only once it reaches R+2 of the kept reference block, and the older answer keeps its reading', () => {
  for (const through of [R + 2, R + 30]) assert.equal(storageWriteAbsent(unknownStatus, notFound({ reason: 'not_found', checkedThroughBlock: through }), R), true);
  for (const [label, answer] of nonProofs) assert.equal(storageWriteAbsent(unknownStatus, answer, R), false, label);
  for (const reference of [undefined, null, -1, 1.5, Number.MAX_SAFE_INTEGER]) assert.equal(storageWriteAbsent(unknownStatus, notFound({ reason: 'not_found', checkedThroughBlock: Number.MAX_SAFE_INTEGER }), reference), false, String(reference));
  for (const reference of [R, undefined]) assert.equal(storageWriteAbsent(unknownStatus, { result: 400, response: 'error', require_reply: false, extra: null }, reference), true);
});

const rows = async (c, tx) => [await c.journal.get(c.world.laneKey), await c.journal.get(`devnet/native-transfer/${tx.hash}`)];

/** A storage CREATE at nonce 1 confirmed against R whose broadcast the node answers with `broadcastReply(hash)`. */
async function sendAnswered(t, broadcastReply, referenceBlock = R) {
  const c = await boundedCreateWorld(t);
  c.referenceBlock = referenceBlock;
  c.answer = (message, call) => (message === 'broadcastTx' ? broadcastReply(call.data.response.data.transaction.hash) : undefined);
  const { tx } = await c.send(JOB_IDS[0], 1);
  return { c, tx };
}

test('a mempool reply naming the sent hash is kept as accepted, and a not-found lookup through R+2 lets recovery resend once', async (t) => {
  const { c, tx } = await sendAnswered(t, (hash) => mempoolReply(hash));
  for (const row of await rows(c, tx)) assert.deepEqual([row.stage, row.storageWriteSubmission, row.storageWriteReferenceBlock], ['broadcast-accepted', 'accepted', R]);
  c.answer = (message, call) => (message === 'getTxByHash' ? notFound({ reason: 'not_found', checkedThroughBlock: R + 2 })
    : message === 'broadcastTx' ? mempoolReply(call.data.response.data.transaction.hash) : undefined);
  assert.deepEqual(await c.world.recover(tx), { disposition: 'pending', hash: tx.hash, noResend: true });
  assert.deepEqual(c.calls, { confirmTx: 2, broadcastTx: 2 }, 'the sole resend is sent');
  await c.world.recover(tx);
  assert.equal(c.calls.broadcastTx, 2, 'the resend is never sent again');
});

for (const [index, [label]] of unboundMempoolReplies(HASH).entries()) test(`a mempool reply with ${label} stays unknown and recovery sends nothing`, async (t) => {
  const { c, tx } = await sendAnswered(t, (hash) => unboundMempoolReplies(hash)[index][1]);
  for (const row of await rows(c, tx)) assert.equal(row.storageWriteSubmission, 'unknown');
  c.answer = (message) => (message === 'getTxByHash' ? notFound({ reason: 'not_found', checkedThroughBlock: R + 2 }) : undefined);
  assert.deepEqual(await c.world.recover(tx), { disposition: 'pending', hash: tx.hash, noResend: true });
  assert.deepEqual(c.calls, { confirmTx: 1, broadcastTx: 1 });
});

test('a node that is not a staked validator refuses the broadcast: the refusal is recorded and recovery never resends', async (t) => {
  const { c, tx } = await sendAnswered(t, () => notValidatorReply());
  for (const row of await rows(c, tx)) assert.deepEqual([row.stage, row.storageWriteSubmission], ['broadcast-answered', 'refused-not-validator']);
  c.answer = (message) => (message === 'getTxByHash' ? notFound({ reason: 'not_found', checkedThroughBlock: R + 2 }) : undefined);
  assert.deepEqual(await c.world.recover(tx), { disposition: 'pending', hash: tx.hash, noResend: true });
  assert.deepEqual(c.calls, { confirmTx: 1, broadcastTx: 1 }, 'the broadcast was sent once and never again');
});

for (const [label, answer] of nonProofs) test(`a not-found lookup with ${label} is no absence proof and recovery sends nothing`, async (t) => {
  const { c, tx } = await sendAnswered(t, (hash) => mempoolReply(hash));
  c.answer = (message) => (message === 'getTxByHash' ? answer : undefined);
  assert.deepEqual(await c.world.recover(tx), { disposition: 'pending', hash: tx.hash, noResend: true });
  assert.deepEqual(c.calls, { confirmTx: 1, broadcastTx: 1 });
});

test('a not-found lookup is no absence proof for a write whose confirmation carried no reference block', async (t) => {
  const { c, tx } = await sendAnswered(t, (hash) => mempoolReply(hash), null);
  c.answer = (message) => (message === 'getTxByHash' ? notFound({ reason: 'not_found', checkedThroughBlock: Number.MAX_SAFE_INTEGER }) : undefined);
  assert.deepEqual(await c.world.recover(tx), { disposition: 'pending', hash: tx.hash, noResend: true });
  assert.deepEqual(c.calls, { confirmTx: 1, broadcastTx: 1 });
});
