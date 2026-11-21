// The fee ceiling of a storage CREATE's recovery resend reads the debit of the signed transaction it resends:
// the CREATE declares no amount, so that debit is its signed fees. A resend whose signed fees exceed the
// ceiling is withheld before the sole attempt is reserved, and nothing is broadcast. The real transport,
// effect boundary and durable journal run in this process against a scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { boundedCreateWorld } from './helpers/native-create-boundary.mjs';
import { JOB_IDS } from './helpers/native-create-world.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
// The CREATE below is signed with a 1 DEM network fee and a 1 DEM rpc fee.
const SIGNED_DEBIT_OS = '2000000000';

// A CREATE signed with 2 DEM in fees, retained as a prior run left it once its broadcast was accepted, then recovered
// under `feeCeilingOs`.
async function recovered(t, feeCeilingOs) {
  const c = await boundedCreateWorld(t, { feeCeilingOs });
  const tx = await c.world.makeCreate(JOB_IDS[0], 1);
  tx.content.transaction_fee = { ...tx.content.transaction_fee, network_fee: 1, rpc_fee: 1 };
  tx.hash = sha(JSON.stringify(tx.content));
  tx.signature = { type: 'ed25519', data: c.world.wallet.signHex(tx.hash) };
  await c.world.retain(tx, 'broadcast-accepted', { signed: true });
  const outcome = await c.world.recover(tx);
  return { c, tx, outcome, lane: await c.journal.get(c.world.laneKey) };
}

test("a recovery resend whose signed fees exceed the ceiling is withheld as write-fee-cap: nothing reserved, nothing broadcast", async t => {
  const { c, tx, outcome, lane } = await recovered(t, String(BigInt(SIGNED_DEBIT_OS) - 1n));
  assert.deepEqual(outcome, { disposition: 'pending', hash: tx.hash, noResend: true });
  assert.deepEqual(c.calls, { confirmTx: 1, broadcastTx: 0 }, 'recovery confirms and resends nothing');
  assert.deepEqual(c.world.sent.broadcasts, []);
  assert.deepEqual((await c.states(tx)).slice(-2), ['recovery-dispatch-started', 'recovery-dispatch-withheld']);
  assert.equal((await c.records(tx)).at(-1).cause.code, 'write-fee-cap');
  assert.equal(lane.storageWriteResends ?? 0, 0, 'the sole resend is not reserved');
});

test('a recovery resend whose signed fees are within the ceiling is resent once', async t => {
  const { c, tx, outcome, lane } = await recovered(t, SIGNED_DEBIT_OS);
  assert.deepEqual(outcome, { disposition: 'pending', hash: tx.hash, noResend: true });
  assert.deepEqual(c.calls, { confirmTx: 1, broadcastTx: 1 });
  assert.deepEqual(c.world.sent.broadcasts, [tx.hash]);
  assert.deepEqual((await c.states(tx)).slice(-2), ['recovery-dispatch-started', 'recovery-dispatch-acknowledged']);
  assert.equal(lane.storageWriteResends, 1);
});
