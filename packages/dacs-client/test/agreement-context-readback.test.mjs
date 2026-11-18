// A plan step can end with its DEM delivery context indeterminate before the
// seller's Vet record writes read back as included. A recheck at stage identity
// then asks the context to read them back (readback only) and notes when they
// do. Loopback stand-ins only: the seller context is a programmable capability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './helpers/purchase-admission-hook.mjs';

installPurchaseAdmissionHook();
const { setPurchaseAdmission } = await loadAdmissionDouble();
const { compositionWorld, ACCOUNT_ID } = await import('./helpers/public-composition-world.mjs');
const { createDemDeliveryContext } = await import('../src/dacs/dem-delivery-context-consumer.mjs');

const WRITER_PENDING = 'seller Vet record write failed (indeterminate: the write outcome is not known yet)';
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Every plan step's context read waits for `gate()`, then fails with the writer's
// pending cause; readBack answers the next of `answers` and counts each call.
async function heldPurchase(t, answers, { gate = async () => {} } = {}) {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const calls = { resolveBuyer: 0, readBack: [] };
  const capability = createDemDeliveryContext({ authority: 'TEST-context-readback',
    resolveBuyer: async () => { calls.resolveBuyer++; await gate(); throw new Error(WRITER_PENDING); },
    resolveSeller: async () => { throw new Error('TEST unexpected seller resolver'); },
    readBack: async (request) => { calls.readBack.push(request); return answers.shift(); } });
  const world = await compositionWorld(t, { demDeliveryContext: capability });
  const args = await world.preparedWithIdentity();
  await assert.rejects(world.service.agreementPlan(args), { code: 'agreement_context_held' });
  const recheck = async () => (await world.service.protocolRecheck({ operationId: args.operationId, token: args.token })).operation;
  // The newest attempt note without its time.
  const lastAttempt = () => ({ ...world.ops.get(ACCOUNT_ID, args.operationId).state.protocol.attempts.at(-1), at: undefined });
  return { world, args, calls, recheck, lastAttempt };
}

test('a recheck at identity after an indeterminate plan step reads the retained records back and sends nothing', async (t) => {
  const p = await heldPurchase(t, [{ disposition: 'indeterminate', reason: 'TEST still pending' }, { disposition: 'present', reason: 'TEST read back' }]);
  const { jobId } = p.world.ops.get(ACCOUNT_ID, p.args.operationId).terms.protocol;
  const before = { lookups: p.world.counters.sellerLookups, coordinates: p.world.tableCounts().write_coordinates };
  assert.deepEqual(p.lastAttempt(), { at: undefined, step: 'agreement-context', outcome: 'indeterminate', reason: `DEM delivery context failed: ${WRITER_PENDING}` });
  assert.equal((await p.recheck()).state.protocol.stage, 'identity');
  assert.equal(p.lastAttempt().step, 'agreement-context', 'a pending readback changes nothing');
  assert.equal((await p.recheck()).state.protocol.stage, 'identity');
  assert.deepEqual(p.lastAttempt(), { at: undefined, step: 'agreement-context-readback', outcome: 'present', reason: 'TEST read back' });
  await p.recheck();
  assert.deepEqual(p.calls.readBack, [{ jobId, buyer: p.world.wallet.claim }, { jobId, buyer: p.world.wallet.claim }], 'no readback once noted');
  assert.equal(p.calls.resolveBuyer, 1, 'no plan step was started');
  assert.equal(p.world.chain.broadcasts, 0);
  assert.deepEqual({ lookups: p.world.counters.sellerLookups, coordinates: p.world.tableCounts().write_coordinates }, before);
});

test('a recheck at identity reads nothing while a plan step runs', async (t) => {
  let release = () => {}, holding = false;
  const p = await heldPurchase(t, [{ disposition: 'present', reason: 'TEST read back' }],
    { gate: () => (holding ? new Promise((resolve) => { release = resolve; }) : undefined) });
  holding = true;
  const running = p.world.service.agreementPlan(p.args).catch((error) => error);
  while (p.calls.resolveBuyer < 2) await settle();
  await p.recheck();
  assert.equal(p.calls.readBack.length, 0);
  release();
  assert.equal((await running).code, 'agreement_context_held');
  await p.recheck();
  assert.equal(p.calls.readBack.length, 1);
});
