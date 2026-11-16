// A failure between the broadcast's records: the lane row, the intent row and the dispatch history
// are written one after another before the one request. Any durable prefix keeps the hash and the
// signed bytes and forbids a second ordinary broadcast; a record that never became durable sends
// nothing. The real transport, effect boundary and durable journal run in this process against a
// scripted TEST node; a TEST key signs the transactions. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutAppend } from './helpers/effect-boundary-fixture.mjs';
import { LANE_PREFIX, nativeWorld as world } from './helpers/native-effect-world.mjs';

const INTENT_PREFIX = 'devnet/native-transfer/';
const CUT = new Error('TEST-journal-cut');

// Fails the journal's write of the first record whose key starts with `prefix`.
function failFirstPut(journal, prefix) {
  const put = journal.put.bind(journal);
  journal.put = async (key, value) => {
    if (!key.startsWith(prefix)) return put(key, value);
    journal.put = put;
    throw CUT;
  };
}

async function confirmedPayment(t) {
  const w = world(t);
  return { w, ...(await w.confirmedPayment()) };
}

test('a failed write of the lane row sends nothing and leaves dispatch-unknown', async (t) => {
  const { w, signed, confirmed } = await confirmedPayment(t);
  failFirstPut(w.journal(), LANE_PREFIX);
  await assert.rejects(w.broadcast(confirmed), (error) => error === CUT);
  assert.deepEqual([w.node.broadcasts, await w.lanes()], [[], []]);
  assert.deepEqual((await w.historyStates()).slice(-2), ['p2/dispatch-started', 'p2/dispatch-unknown']);
  assert.equal((await w.historyRecords()).at(-1).cause.code, 'effect_failed');
  assert.ok(signed.hash);
});

test('a failed write of the intent row after the lane row keeps the hash on the lane and forbids a second broadcast, also after a restart', async (t) => {
  const { w, signed, confirmed } = await confirmedPayment(t);
  failFirstPut(w.journal(), INTENT_PREFIX);
  await assert.rejects(w.broadcast(confirmed), (error) => error === CUT);
  assert.deepEqual(w.node.broadcasts, [], 'the request was never made');
  const [[laneKey, lane]] = await w.lanes();
  assert.deepEqual([lane.stage, lane.hash, JSON.stringify(lane.signedTransaction)], ['broadcast-started', signed.hash, JSON.stringify(signed)]);
  assert.equal((await w.historyStates()).at(-1), 'p2/dispatch-unknown');

  for (const restart of [false, true]) {
    if (restart) await w.restartGuarded();
    await assert.rejects(w.lease(), { code:'outcome_unknown' }, restart ? 'after the restart' : 'before it');
    const read = await w.transport().binding({ phase:'readback', address:w.address, hash:signed.hash });
    assert.equal(read.hash ?? signed.hash, signed.hash);
    assert.deepEqual((await w.journal().get(laneKey)).signedTransaction, signed, 'the original transaction is still found');
  }
  assert.deepEqual(w.node.broadcasts, []);
});

test('a failed write of the dispatch-started record leaves no lane row and sends nothing', async (t) => {
  const { w, g, confirmed } = await confirmedPayment(t);
  const crash = cutAppend({ history:g.history }, 'dispatch-started');
  await assert.rejects(w.broadcast(confirmed), { code:'eb_persist_failed', cause:crash });
  assert.deepEqual([w.node.broadcasts, await w.lanes()], [[], []]);
  assert.equal((await w.historyStates()).at(-1), 'p2/signed');
});
