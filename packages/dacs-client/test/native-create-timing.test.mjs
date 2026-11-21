// A storage CREATE reads the chain before it asks for confirmation. After the confirmation the node receives only its
// broadcast (or a recovery's single resend), plus one getNetworkInfo read for the signature-domain check when the kept
// answer is past its lifetime by then. The confirmation's reference block is kept with the write and handed back. The
// real transport, boundary and durable journal run against a scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedCreateWorld } from './helpers/native-create-boundary.mjs';
import { JOB_IDS } from './helpers/native-create-world.mjs';

// The transport reuses an inactive signature-domain answer for 60 s and a lease lasts 30 s: the second lease starts
// when the first answer is 31 s old, and the broadcast runs just before or when it is 60 s old.
const ANSWER_LIFETIME_MS = 60_000, SECOND_LEASE_AT_MS = 31_000;
const FIRST_REFERENCE_BLOCK = 41, RECONFIRMED_REFERENCE_BLOCK = 57, LATER_REFERENCE_BLOCK = 73;

// Records every request the TEST node receives, in order. `atConfirmation()` runs when the node is asked to confirm.
function recordNodeRequests(c, atConfirmation = () => {}) {
  const seen = [];
  c.nodeHook = async (message) => { seen.push(message); if (message === 'confirmTx') atConfirmation(); };
  return seen;
}
const after = (seen, message) => seen.slice(seen.indexOf(message) + 1);
// All the node may receive after a confirmation: the one write, preceded by a getNetworkInfo read only when the kept
// signature-domain answer is past its lifetime by then.
const afterConfirmation = (stale) => (stale ? ['getNetworkInfo', 'broadcastTx'] : ['broadcastTx']);
const rows = async (c, tx) => [await c.journal.get(c.world.laneKey), await c.journal.get(`devnet/native-transfer/${tx.hash}`)];

for (const stale of [false, true]) {
  test(`a storage CREATE reads the chain before its confirmation and after it sends only the broadcast, ${stale ? 'with one getNetworkInfo read as the kept answer is past its lifetime' : 'with no read while the kept answer is current'}`, async (t) => {
    const c = await boundedCreateWorld(t), seen = recordNodeRequests(c);
    const earlier = await c.world.lease();
    await c.world.confirm(await c.world.makeCreate(JOB_IDS[1], 1));
    await c.world.release(earlier);
    c.elapsedMs = SECOND_LEASE_AT_MS;
    seen.length = 0;
    c.referenceBlock = FIRST_REFERENCE_BLOCK;
    const tx = await c.world.makeCreate(JOB_IDS[0], 1), lease = await c.world.lease();
    const confirmation = await c.world.confirm(tx);
    c.referenceBlock = LATER_REFERENCE_BLOCK;
    c.elapsedMs = stale ? ANSWER_LIFETIME_MS : ANSWER_LIFETIME_MS - 1;
    const answer = await c.world.broadcast(lease, confirmation, tx.hash);
    assert.ok(seen.slice(0, seen.indexOf('confirmTx')).includes('getBlockByNumber'), 'the chain is read before the confirmation');
    assert.deepEqual(after(seen, 'confirmTx'), afterConfirmation(stale), 'nothing else reaches the node after the confirmation');
    assert.equal(answer.referenceBlock, FIRST_REFERENCE_BLOCK, 'the kept reference block is the confirmation\'s');
    for (const row of await rows(c, tx)) assert.equal(row.storageWriteReferenceBlock, FIRST_REFERENCE_BLOCK);
  });

  test(`a CREATE recovery reads the node before its confirmation and after it sends only the resend, ${stale ? 'with one getNetworkInfo read as the kept answer is past its lifetime' : 'with no read while the kept answer is current'}`, async (t) => {
    const c = await boundedCreateWorld(t), { tx } = await c.send(JOB_IDS[0], 1);
    c.referenceBlock = RECONFIRMED_REFERENCE_BLOCK;
    const seen = recordNodeRequests(c, () => { if (stale) c.elapsedMs = ANSWER_LIFETIME_MS; });
    assert.deepEqual(await c.world.recover(tx), { disposition: 'pending', hash: tx.hash, noResend: true });
    assert.equal(c.calls.broadcastTx, 2, 'the sole resend is sent');
    assert.ok(seen.includes('getTransactionStatus') && seen.includes('getAddressNonce'), 'the absence reads still happen');
    assert.deepEqual(after(seen, 'confirmTx'), afterConfirmation(stale), 'nothing else reaches the node after the confirmation');
    for (const row of await rows(c, tx)) assert.equal(row.storageWriteReferenceBlock, RECONFIRMED_REFERENCE_BLOCK, 'the kept reference block is the reconfirmation\'s');
  });
}

test('a new lease that continues a storage CREATE\'s signed operation reads the chain under the fence it takes over', async (t) => {
  const events = [], c = await boundedCreateWorld(t, { events });
  const tx = await c.world.makeCreate(JOB_IDS[0], 1), earlier = await c.world.lease();
  await c.world.confirm(tx);
  await c.world.release(earlier);
  const lease = await c.world.lease();
  c.nodeHook = async (message) => { events.push({ kind: message }); };
  const start = events.length, confirmation = await c.world.confirm(tx);
  const during = events.slice(start).map((event) => event.kind);
  assert.ok(during.includes('fence'), 'the new lease takes over the signed operation\'s fence');
  assert.ok(during.lastIndexOf('fence') < during.indexOf('getBlockByNumber'), 'the chain is read after the takeover');
  await c.world.broadcast(lease, confirmation, tx.hash);
  assert.deepEqual(c.calls, { confirmTx: 1, broadcastTx: 1 });
});

test('the reference block of a storage CREATE confirmation is kept on its lane and intent rows', async (t) => {
  const c = await boundedCreateWorld(t);
  c.referenceBlock = FIRST_REFERENCE_BLOCK;
  const { tx } = await c.send(JOB_IDS[0], 1);
  for (const row of await rows(c, tx)) assert.equal(row.storageWriteReferenceBlock, FIRST_REFERENCE_BLOCK);
});

test('the wallet request result of a storage CREATE broadcast carries the kept reference block', async (t) => {
  const c = await boundedCreateWorld(t);
  c.referenceBlock = FIRST_REFERENCE_BLOCK;
  const { answer } = await c.send(JOB_IDS[0], 1);
  assert.equal(answer.referenceBlock, FIRST_REFERENCE_BLOCK);
});

test('readback of a storage CREATE that is not yet included carries its reference block across a restart', async (t) => {
  const c = await boundedCreateWorld(t);
  c.referenceBlock = FIRST_REFERENCE_BLOCK;
  const { tx } = await c.send(JOB_IDS[0], 1);
  assert.deepEqual(await c.world.readback(tx.hash), { disposition: 'pending', hash: tx.hash, nonce: 1, noResend: true, referenceBlock: FIRST_REFERENCE_BLOCK });
  c.restart();
  assert.equal((await c.world.readback(tx.hash)).referenceBlock, FIRST_REFERENCE_BLOCK);
});

test('a storage CREATE confirmed without a reference block reports it absent and never fills it from a height', async (t) => {
  const c = await boundedCreateWorld(t);
  c.referenceBlock = null;
  const { tx, answer } = await c.send(JOB_IDS[0], 1);
  assert.equal(answer.referenceBlock, null);
  for (const row of await rows(c, tx)) assert.equal(row.storageWriteReferenceBlock, null);
  assert.equal((await c.world.readback(tx.hash)).referenceBlock, null);
});

test('a CREATE recovery replaces the kept reference block with its exact-byte reconfirmation', async (t) => {
  const c = await boundedCreateWorld(t);
  c.referenceBlock = FIRST_REFERENCE_BLOCK;
  const { tx } = await c.send(JOB_IDS[0], 1);
  c.referenceBlock = RECONFIRMED_REFERENCE_BLOCK;
  await c.world.recover(tx);
  assert.equal(c.calls.broadcastTx, 2);
  for (const row of await rows(c, tx)) assert.equal(row.storageWriteReferenceBlock, RECONFIRMED_REFERENCE_BLOCK);
  assert.equal((await c.world.readback(tx.hash)).referenceBlock, RECONFIRMED_REFERENCE_BLOCK);
});

test('a CREATE recovery whose confirmation fails its checks keeps the first reference block', async (t) => {
  const c = await boundedCreateWorld(t);
  c.referenceBlock = FIRST_REFERENCE_BLOCK;
  const { tx } = await c.send(JOB_IDS[0], 1);
  c.referenceBlock = -1;
  await c.world.recover(tx);
  assert.equal(c.calls.broadcastTx, 1, 'no resend follows a confirmation that fails its checks');
  for (const row of await rows(c, tx)) assert.equal(row.storageWriteReferenceBlock, FIRST_REFERENCE_BLOCK);
});

test('a storage CREATE whose chain read fails before its confirmation sends no confirmation', async (t) => {
  const c = await boundedCreateWorld(t);
  const tx = await c.world.makeCreate(JOB_IDS[0], 1);
  await c.world.lease();
  c.nodeHook = async (message) => { if (message === 'getBlockByNumber') throw new Error('TEST-node-unreachable'); };
  await assert.rejects(c.world.confirm(tx));
  assert.equal(c.calls.confirmTx, 0);
  assert.equal(c.calls.broadcastTx, 0);
});

test('a crash between the resend reservation on the intent and on the lane leaves readback with the reconfirmed reference block', async (t) => {
  const c = await boundedCreateWorld(t);
  c.referenceBlock = FIRST_REFERENCE_BLOCK;
  const { tx } = await c.send(JOB_IDS[0], 1);
  c.referenceBlock = RECONFIRMED_REFERENCE_BLOCK;
  c.putFault = (key, value) => key.startsWith('devnet/native-wallet/') && value.storageWriteResends === 1;
  await c.world.recover(tx);
  c.restart();
  assert.equal((await c.world.readback(tx.hash)).referenceBlock, RECONFIRMED_REFERENCE_BLOCK);
  assert.deepEqual(await c.world.recover(tx), { disposition: 'pending', hash: tx.hash, noResend: true });
  assert.equal(c.calls.broadcastTx, 1, 'the consumed resend is never sent again');
});

test('a CREATE confirmation retained before a restart keeps its reference block and the restart broadcasts nothing', async (t) => {
  const c = await boundedCreateWorld(t);
  c.referenceBlock = FIRST_REFERENCE_BLOCK;
  const tx = await c.world.makeCreate(JOB_IDS[0], 1);
  await c.world.lease();
  await c.world.confirm(tx);
  c.restart();
  const retained = (await c.records(tx)).findLast((record) => record.state === 'confirm-acknowledged');
  assert.equal(retained.confirmation.response.data.reference_block, FIRST_REFERENCE_BLOCK);
  assert.equal(c.calls.broadcastTx, 0);
});

test('a broadcast cut off at the node keeps the reference block on its started intent across a restart', async (t) => {
  const c = await boundedCreateWorld(t);
  c.referenceBlock = FIRST_REFERENCE_BLOCK;
  const tx = await c.world.makeCreate(JOB_IDS[0], 1), lease = await c.world.lease();
  const confirmation = await c.world.confirm(tx);
  c.nodeHook = async (message) => { if (message === 'broadcastTx') throw new Error('TEST-process-ended'); };
  await assert.rejects(c.world.broadcast(lease, confirmation, tx.hash));
  const [lane] = await rows(c, tx);
  assert.equal(lane.stage, 'broadcast-started');
  assert.equal(lane.storageWriteReferenceBlock, FIRST_REFERENCE_BLOCK);
  c.restart();
  assert.equal((await c.world.readback(tx.hash)).referenceBlock, FIRST_REFERENCE_BLOCK);
});
