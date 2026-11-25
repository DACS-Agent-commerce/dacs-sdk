// The fees of a native send against the host fee ceiling at confirmation and at broadcast: the fees come from
// the signed transaction itself, and the amount the send pays is not counted. The real transport and durable
// journal run in this process against a scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildNativeTransferPayload } from '../src/dacs/wallet-transactions.mjs';
import { nativePayloadDigest } from '../src/wallet/payload-helpers.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { LANE_PREFIX, nativeWorld as world } from './helpers/native-effect-world.mjs';

// A signed TEST transfer pays a 1 DEM network fee and a 1 DEM rpc fee on top of its amount.
const AMOUNT_OS = '2500000000', FEES_OS = '2000000000', PAYEE = '0x' + '7'.repeat(64);

// Opens a world under `feeCeilingOs` whose node gives no fee view, and holds a lease for one transfer of AMOUNT_OS.
async function leasedSend(t, feeCeilingOs) {
  const w = world(t, { bound: await bindFixture() });
  w.feeCeilingOs = feeCeilingOs;
  w.open({});
  w.node.gas = null;
  const lease = await w.lease();
  return { w, lease, tx: w.signedTransfer(1, AMOUNT_OS) };
}

test('a signature lease for a transfer whose amount is above the ceiling is granted', async t => {
  const w = world(t, { bound: await bindFixture() });
  w.feeCeilingOs = FEES_OS;
  w.open({}, {}, { agreement: true });
  const payload = buildNativeTransferPayload({ from: w.address, to: PAYEE, amountOs: AMOUNT_OS, nonce: 1, timestamp: 1, encoding: 'os-string' });
  const transfer = { nonce: 1, to: PAYEE, amountOs: AMOUNT_OS, payloadDigest: await nativePayloadDigest(payload.content) };
  const lease = await w.signature(await w.bind(), w.address, transfer);
  assert.equal(typeof lease.leaseId, 'string');
  await w.release(lease.leaseId);
});

test('a send whose signed fees are above the ceiling is refused at confirmation and sends nothing', async t => {
  const { w, tx } = await leasedSend(t, String(BigInt(FEES_OS) - 1n));
  await assert.rejects(w.confirm(tx), { code: 'write-fee-cap' });
  assert.deepEqual(w.node.broadcasts, []);
  assert.equal((await w.journalEntries()).some(([key]) => key.startsWith(LANE_PREFIX)), false, 'no lane row is written');
});

test('a confirmation without a fee view whose signed fees are within the ceiling is broadcast once even when the amount is above it', async t => {
  assert.ok(BigInt(AMOUNT_OS) > BigInt(FEES_OS), 'the amount sent is above the ceiling under test');
  const { w, lease, tx } = await leasedSend(t, FEES_OS);
  const confirmation = await w.confirm(tx);
  assert.equal(confirmation.response.data.gas_operation, null);
  await w.prepareBroadcast(lease.leaseId, tx.hash);
  const answer = await w.broadcast(confirmation);
  assert.equal(answer.result, 200);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
});
