// What the Agreement transport's `networkFeeCeilingOnly` option hands the effect boundary's fee check at each gate:
// zero at the lease holds, where nothing is signed yet, and the exact sum of the three signed fees at signing,
// confirmation and broadcast. Without it each gate gets what it always did. The real transport, boundary and durable
// journal run in this process against a scripted TEST node. No network, chain or funds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { nativeWorld } from './helpers/native-effect-world.mjs';
import { createDevnetDeliveryTransport, createDevnetDemoTransport, createDevnetNativeTransport, createDevnetSettlementTransport } from '../src/wallet/devnet-native-transport.mjs';
import { nativePayloadDigest } from '../src/wallet/payload-helpers.mjs';

const AMOUNT_OS = '2500000000';
// Three signed fees summing to 2.3 DEM; `rpc_address` reads like a decimal so a sum that took it would show.
const SIGNED_FEE = { network_fee: '1000000000', rpc_fee: '1000000000', additional_fee: '300000000', rpc_address: '5000000000' };
const FEE_SUM_OS = '2300000000', AMOUNT_PLUS_FEES_OS = '4800000000';

// The world's real boundary, with each call's fee input noted in `seen`.
function spiedBoundary(w, seen) {
  const real = () => w.boundary;
  return {
    holdFence: (operation) => { seen.holds.push(operation.debitOs); return real().holdFence(operation); },
    withOperation: (...args) => real().withOperation(...args),
    signPass: (operation, sign, ...options) => { seen.signs.push(options); return real().signPass(operation, sign, ...options); },
    dispatchPass: (artifact, send, options) => { seen.dispatches.push([options.stage, options.confirmedDebitOs, Object.hasOwn(options, 'confirmedDebitOs')]); return real().dispatchPass(artifact, send, options); },
    signAuthentication: (...args) => real().signAuthentication(...args),
  };
}

// Confirms one transfer under a lease whose node answer is not a confirmation, then again under a second lease, which
// takes over the signed operation (the re-hold), then broadcasts it.
async function sendWithTakeover(t, networkFeeCeilingOnly) {
  const w = nativeWorld(t, { bound: await bindFixture(), agreement: true });
  const seen = { holds: [], signs: [], dispatches: [] };
  w.open({}, { boundary: spiedBoundary(w, seen), ...(networkFeeCeilingOnly ? { networkFeeCeilingOnly } : {}) });
  const tx = w.signedTransfer(1, AMOUNT_OS, undefined, SIGNED_FEE);
  // Each lease names the transfer, so its hold has the amount to compare when the option is off.
  const transfer = { nonce: 1, to: tx.content.to, amountOs: AMOUNT_OS, payloadDigest: await nativePayloadDigest(tx.content) };
  const lease = async () => w.transport().binding({ phase: 'signature', address: w.address, binding: await w.bind(), transfer });
  const first = await lease();
  w.node.invalid = true;
  await w.confirm(tx);
  await w.release(first.leaseId);
  w.node.invalid = false;
  const second = await lease();
  const confirmation = await w.confirm(tx);
  await w.prepareBroadcast(second.leaseId, tx.hash);
  const answer = await w.broadcast(confirmation);
  assert.equal(answer.result, 200);
  assert.deepEqual(w.node.broadcasts, [tx.hash]);
  return { w, tx, seen };
}

test('the network-fee option gives the lease hold zero and signing, confirm and broadcast the decimal sum of the three signed fees', async t => {
  const { w, tx, seen } = await sendWithTakeover(t, true);
  assert.deepEqual(seen.holds, ['0', '0', '0'], 'two signature leases and the takeover re-hold');
  assert.ok(seen.signs.length > 0);
  for (const options of seen.signs) assert.deepEqual(options, [{ confirmedDebitOs: FEE_SUM_OS }]);
  assert.deepEqual(seen.dispatches, [['confirm', FEE_SUM_OS, true], ['confirm', FEE_SUM_OS, true], ['dispatch', FEE_SUM_OS, true]]);
  const records = await w.records(tx);
  assert.ok(records.length > 0);
  for (const record of records) assert.equal(record.debitOs, AMOUNT_OS, `${record.state} keeps the transfer amount as its debit`);

  const control = await sendWithTakeover(t, false);
  assert.deepEqual(control.seen.holds, [AMOUNT_OS, AMOUNT_OS, AMOUNT_OS]);
  for (const options of control.seen.signs) assert.deepEqual(options, [undefined], 'no signing option');
  assert.deepEqual(control.seen.dispatches, [['confirm', undefined, false], ['confirm', undefined, false], ['dispatch', AMOUNT_PLUS_FEES_OS, true]]);
});

test('only the Agreement transport constructor takes the network-fee and no-repeat options', async t => {
  const w = nativeWorld(t, { bound: await bindFixture(), agreement: true });
  const refused = { name: 'TypeError', message: /boolean options of the Agreement transport only/ };
  for (const option of ['networkFeeCeilingOnly', 'noRepeatUnknownConfirm']) {
    assert.throws(() => w.open({}, { [option]: 'yes' }), refused, `${option} is a boolean`);
    for (const create of [createDevnetNativeTransport, createDevnetSettlementTransport, createDevnetDeliveryTransport, createDevnetDemoTransport]) {
      assert.throws(() => create({ [option]: true }), refused, `${create.name} ${option}`);
    }
  }
  assert.ok(w.open({}, { networkFeeCeilingOnly: true, noRepeatUnknownConfirm: true }));
});
