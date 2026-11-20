// The whole debit of a confirmed native send against the host fee ceiling at broadcast, when the node's
// confirmation carries no fee view (`gas_operation: null`): the fees come from the confirmed transaction
// itself. The real transport and durable journal run in this process against a scripted TEST node. No
// network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { LANE_PREFIX, nativeWorld as world } from './helpers/native-effect-world.mjs';

const states = records => records.map(record => record.state);
// A signed TEST transfer pays a 1 DEM network fee and a 1 DEM rpc fee on top of its amount.
const AMOUNT_OS = '2500000000', WHOLE_DEBIT_OS = '4500000000';

// Confirms one transfer of AMOUNT_OS under `feeCeilingOs` with a node that gives no fee view, then broadcasts it.
async function confirmedSend(t, feeCeilingOs) {
  const w = world(t, { bound: await bindFixture() });
  w.feeCeilingOs = feeCeilingOs;
  w.open({});
  w.node.gas = null;
  const lease = await w.lease(), tx = w.signedTransfer(1, AMOUNT_OS), confirmation = await w.confirm(tx);
  assert.equal(confirmation.response.data.gas_operation, null);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  return { w, tx, outcome: await w.broadcast(confirmation).then(answer => ({ answer }), error => ({ error })) };
}

test('a confirmation without a fee view whose amount fits the ceiling but whose amount plus fees does not is refused before broadcast and sends nothing', async t => {
  for (const feeCeilingOs of [AMOUNT_OS, String(BigInt(WHOLE_DEBIT_OS) - 1n)]) {
    const { w, tx, outcome } = await confirmedSend(t, feeCeilingOs);
    assert.equal(outcome.error?.code, 'write-fee-cap', feeCeilingOs);
    assert.deepEqual(w.node.broadcasts, [], feeCeilingOs);
    assert.deepEqual(states(await w.records(tx)).slice(-2), ['dispatch-started', 'dispatch-withheld'], feeCeilingOs);
    assert.equal((await w.journalEntries()).some(([key]) => key.startsWith(LANE_PREFIX)), false, `${feeCeilingOs}: no lane row is written`);
  }
});

test('a confirmation without a fee view whose amount plus fees is within the ceiling is broadcast once', async t => {
  const { w, tx, outcome } = await confirmedSend(t, WHOLE_DEBIT_OS);
  assert.equal(outcome.answer?.result, 200, JSON.stringify(outcome.error?.code));
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});
