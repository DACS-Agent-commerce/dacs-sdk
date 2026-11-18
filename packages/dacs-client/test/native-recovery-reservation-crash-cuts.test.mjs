// The sole resend of a CREATE recovery: once it is reserved (or its record started), a crash
// consumes it. Neither a restart nor two recoveries at once send again, wherever the first
// recovery stopped. The real transport, boundary and durable journal run in this process
// against a scripted TEST node; a failing write or request stands for the process ending
// there. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedCreateWorld } from './helpers/native-create-boundary.mjs';
import { JOB_IDS } from './helpers/native-create-world.mjs';

const reserved = prefix => (key, value) => key.startsWith(prefix) && value.storageWriteResends === 1;

// Sends one CREATE, lets the node forget it, and recovers it with `inject` active; then checks that nothing
// more is sent after a repeat, two recoveries at once and a restart.
async function assertResendConsumed(t, inject, broadcasts) {
  const c = await boundedCreateWorld(t), { tx } = await c.send(JOB_IDS[0], 1);
  inject(c);
  const first = await c.world.recover(tx).catch(error => error);
  assert.equal(c.calls.broadcastTx, broadcasts, 'the first recovery sends the resend or not, once at most');
  c.putFault = null; c.nodeHook = null;
  assert.deepEqual(await c.world.recover(tx), { disposition: 'pending', hash: tx.hash, noResend: true });
  const both = await Promise.all([c.world.recover(tx), c.world.recover(tx)]);
  assert.deepEqual(both.map(result => result.disposition), ['pending', 'pending']);
  c.restart();
  assert.deepEqual(await c.world.recover(tx), { disposition: 'pending', hash: tx.hash, noResend: true });
  assert.equal(c.calls.broadcastTx, broadcasts, 'a repeat, two recoveries at once and a restart send nothing more');
  return { c, tx, first };
}

test('a crash while the resend reservation is written to the intent consumes the resend: no recovery sends it afterwards', async t => {
  await assertResendConsumed(t, c => { c.putFault = reserved('devnet/native-transfer/'); }, 1);
});

test('a crash after the intent holds the reservation and before the lane does consumes the resend', async t => {
  await assertResendConsumed(t, c => { c.putFault = reserved('devnet/native-wallet/'); }, 1);
});

test('a crash after the reservation and during the resend request consumes the resend and records it unknown', async t => {
  const { c, tx } = await assertResendConsumed(t, c => { c.nodeHook = async (message) => { if (message === 'broadcastTx' && c.calls.broadcastTx === 2) throw new Error('TEST-process-ended'); }; }, 2);
  assert.equal((await c.states(tx)).at(-1), 'recovery-dispatch-unknown');
});
