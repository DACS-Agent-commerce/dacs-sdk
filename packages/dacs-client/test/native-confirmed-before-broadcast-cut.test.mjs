// A crash between a durable confirm-acknowledged and the broadcast intent: the confirmed bytes and
// gas stay durable, and nothing is broadcast after the restart; the transaction stays unbroadcast
// and readback-only. A broadcast whose body is not the retained confirmation is refused.
// The real transport, effect boundary and durable journal run in this process against a scripted
// TEST node; a TEST key signs the transactions. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeWorld as world } from './helpers/native-effect-world.mjs';

const FEES = { fees:{ network_fee:'1000000000', rpc_fee:'1000000000', additional_fee:'0' } };
const broadcastPhase = (w, leaseId, signed) => w.transport().binding({ phase:'broadcast', address:w.address, leaseId, hash:signed.hash });

test('a restart after a durable confirm-acknowledged keeps the confirmed bytes and gas and broadcasts nothing', async (t) => {
  const w = world(t);
  w.node.gas = FEES;
  await w.openGuarded();
  const { leaseId } = await w.lease(), signed = w.sign(1), confirmed = await w.confirm(signed);
  await broadcastPhase(w, leaseId, signed);
  const before = await w.historyRecords();

  await w.restartGuarded();
  assert.deepEqual(await w.historyRecords(), before, 'the restart changes no record');
  const acknowledged = before.find((record) => record.state === 'confirm-acknowledged');
  assert.deepEqual([acknowledged.confirmation, acknowledged.gasOperation, acknowledged.confirmedDebitOs], [confirmed, FEES, '2000000000'], 'the answer, its gas and the debit derived from it are durable');
  assert.equal(Buffer.from(before[0].bytes, 'base64').toString('utf8'), JSON.stringify(signed), 'the exact signed bytes are retained');
  await assert.rejects(w.broadcast(confirmed), { code:'network_binding_required' });
  assert.deepEqual([w.node.broadcasts, await w.lanes()], [[], []], 'nothing was broadcast and no lane row exists');
  assert.equal((await w.historyStates()).length, before.length);
});

test('a broadcast body that is not the retained confirmation, gas included, is refused before any record or request', async (t) => {
  const w = world(t);
  w.node.gas = FEES;
  await w.openGuarded();
  const { leaseId } = await w.lease(), signed = w.sign(1), confirmed = await w.confirm(signed);
  await broadcastPhase(w, leaseId, signed);
  const states = await w.historyStates();
  const cheaper = structuredClone(confirmed);
  cheaper.response.data.gas_operation.fees.network_fee = '1';
  await assert.rejects(w.broadcast(cheaper), { code:'native_confirmation_required' });
  assert.deepEqual([w.node.broadcasts, await w.historyStates(), await w.lanes()], [[], states, []]);
});
