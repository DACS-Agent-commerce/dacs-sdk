// A confirmation retained before the process died: after the restart its exact bytes and
// gas are still the transaction's, nothing is broadcast on its own, and a new lease is
// answered from it without asking the node again. The real transport and durable
// journal run in this process against a scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { nativeWorld as world } from './helpers/native-effect-world.mjs';

const fees = (network, rpc, additional) => ({ fees: { network_fee: network, rpc_fee: rpc, additional_fee: additional } });

test('a confirmation retained before a restart keeps its bytes and gas, and the restart broadcasts nothing', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  w.node.gas = fees('1000000000', '1000000000', '0');
  const lease = await w.lease(), tx = w.signedTransfer(1), confirmation = await w.confirm(tx);
  await w.restart({});
  const retained = (await w.records(tx)).findLast(record => record.state === 'confirm-acknowledged');
  assert.deepEqual(retained.confirmation, confirmation, 'the confirmation is kept exactly');
  assert.deepEqual(retained.gasOperation, w.node.gas);
  assert.deepEqual(w.node.broadcasts, []);
  // The old lease died with the process: its confirmation cannot be broadcast.
  await assert.rejects(w.prepareBroadcast(lease.leaseId, tx.hash), { code: 'network_binding_required' });
  await assert.rejects(w.broadcast(confirmation), { code: 'network_binding_required' });
  assert.deepEqual(w.node.broadcasts, []);
});

test('after a restart a new lease is answered from the retained confirmation without asking the node again, and the bytes are sent once', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.open({});
  await w.lease();
  const tx = w.signedTransfer(1), first = await w.confirm(tx);
  await w.restart({});
  const lease = await w.lease();
  assert.deepEqual(await w.confirm(tx), first);
  assert.equal(w.node.confirms, 1);
  assert.deepEqual((await w.records(tx)).map(record => record.state), ['signed', 'confirm-started', 'confirm-acknowledged']);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  await w.broadcast(first);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});
