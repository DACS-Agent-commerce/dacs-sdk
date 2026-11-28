// The whole debit of a confirmed native send against the host fee ceiling at broadcast, when the node's
// confirmation carries a fee view (`gas_operation`): the ceiling reads the signed fees only, and a fee view
// other than the signed fees refuses the send before any dispatch or lane record, as a refusal relays answer
// as not sent. The real transport and durable journal run in this process against a scripted TEST node. No
// network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { LANE_PREFIX, nativeWorld as world } from './helpers/native-effect-world.mjs';
import { transferRefusal } from '../src/wallet/devnet-native-transport.mjs';

const states = records => records.map(record => record.state);
const fees = (network, rpc, additional) => ({ fees: { network_fee: network, rpc_fee: rpc, additional_fee: additional } });
// A signed TEST transfer pays a 1 DEM network fee, a 1 DEM rpc fee and the SDK's 1 DEM gas on top of its amount.
const AMOUNT_OS = '2500000000', FEES_OS = '3000000000', WHOLE_DEBIT_OS = '5500000000';

// Confirms one transfer of AMOUNT_OS under `feeCeilingOs` with a node that answers with the fee view `gas`, then broadcasts it.
async function confirmedSend(t, feeCeilingOs, gas) {
  const w = world(t, { bound: await bindFixture() });
  w.feeCeilingOs = feeCeilingOs;
  w.open({});
  w.node.gas = gas;
  const lease = await w.lease(), tx = w.signedTransfer(1, AMOUNT_OS), confirmation = await w.confirm(tx);
  assert.deepEqual(confirmation.response.data.gas_operation, gas);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  return { w, tx, outcome: await w.broadcast(confirmation).then(answer => ({ answer }), error => ({ error })) };
}

test('a zero fee view for a transfer signed with 2 DEM in fees, under a ceiling of its fees, is refused as not sent and nothing is dispatched or broadcast', async t => {
  const { w, tx, outcome } = await confirmedSend(t, FEES_OS, fees('0', '0', '0'));
  assert.equal(outcome.error?.code, 'fee_view_mismatch', JSON.stringify(outcome.answer));
  assert.equal(transferRefusal(outcome.error)?.[0], 409, 'relays answer the refusal as not sent');
  assert.deepEqual(w.node.broadcasts, []);
  assert.deepEqual(states(await w.records(tx)), ['signed', 'confirm-started', 'confirm-acknowledged'], 'no dispatch is started');
  assert.equal((await w.journalEntries()).some(([key]) => key.startsWith(LANE_PREFIX)), false, 'no lane row is written');
  assert.equal(w.fence.released, w.fence.acquired, 'the lease holds nothing');
});

test('a fee view equal to the signed fees, under a ceiling of the amount plus the signed fees, is broadcast once', async t => {
  const { w, tx, outcome } = await confirmedSend(t, WHOLE_DEBIT_OS, fees('1000000000', '1000000000', '0'));
  assert.equal(outcome.answer?.result, 200, JSON.stringify(outcome.error?.code));
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});
