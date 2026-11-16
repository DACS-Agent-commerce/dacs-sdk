// A failure after the broadcast request was made: its answer is written to the intent row, the
// lane row and the dispatch history one after another. Whatever subset is durable, the lane keeps
// the hash and the transaction is never broadcast again, also after a restart; it stays
// readback-only. The real transport, effect boundary and durable journal run in this process
// against a scripted TEST node; a TEST key signs the transactions. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutAppend } from './helpers/effect-boundary-fixture.mjs';
import { LANE_PREFIX, nativeWorld as world } from './helpers/native-effect-world.mjs';

const INTENT_PREFIX = 'devnet/native-transfer/';
const CUT = new Error('TEST-journal-cut');

// Lets the journal write the first record whose key starts with `prefix` and fails the second one.
function failSecondPut(journal, prefix) {
  const put = journal.put.bind(journal);
  let writes = 0;
  journal.put = async (key, value) => {
    if (key.startsWith(prefix) && ++writes === 2) throw CUT;
    return put(key, value);
  };
}

async function confirmedPayment(t) {
  const w = world(t);
  return { w, ...(await w.confirmedPayment()) };
}

async function assertReadbackOnlyAfterRestart(w, signed) {
  await w.restartGuarded();
  await assert.rejects(w.lease(), { code:'outcome_unknown' });
  assert.equal((await w.transport().binding({ phase:'readback', address:w.address, hash:signed.hash })).disposition, 'included');
  assert.deepEqual(w.node.broadcasts, [signed.hash], 'the restart sent nothing more');
}

test('a failed write of the answer to the intent row leaves the lane at broadcast-started and the transaction readback-only after a restart', async (t) => {
  const { w, signed, confirmed } = await confirmedPayment(t);
  failSecondPut(w.journal(), INTENT_PREFIX);
  await assert.rejects(w.broadcast(confirmed), (error) => error === CUT);
  assert.deepEqual(w.node.broadcasts, [signed.hash]);
  assert.deepEqual([(await w.lanes())[0][1].stage, (await w.historyStates()).at(-1)], ['broadcast-started', 'p2/dispatch-unknown']);
  await assertReadbackOnlyAfterRestart(w, signed);
});

test('only the intent row answered, with the lane row still at broadcast-started, stays readback-only after a restart', async (t) => {
  const { w, signed, confirmed } = await confirmedPayment(t);
  failSecondPut(w.journal(), LANE_PREFIX);
  await assert.rejects(w.broadcast(confirmed), (error) => error === CUT);
  assert.equal((await w.journal().get(`${INTENT_PREFIX}${signed.hash}`)).stage, 'broadcast-accepted');
  assert.equal((await w.lanes())[0][1].stage, 'broadcast-started');
  assert.equal((await w.historyStates()).at(-1), 'p2/dispatch-unknown');
  await assertReadbackOnlyAfterRestart(w, signed);
});

test('a failed write of dispatch-acknowledged leaves both answered rows and dispatch-unknown, and the transaction readback-only after a restart', async (t) => {
  const { w, g, signed, confirmed } = await confirmedPayment(t);
  const crash = cutAppend({ history:g.history }, 'dispatch-acknowledged');
  await assert.rejects(w.broadcast(confirmed), { code:'eb_persist_failed', cause:crash });
  assert.deepEqual([w.node.broadcasts, (await w.lanes())[0][1].stage, (await w.historyStates()).at(-1)], [[signed.hash], 'broadcast-accepted', 'p2/dispatch-unknown']);
  await assertReadbackOnlyAfterRestart(w, signed);
});
