// Test-only effect boundary world: real history, real fence and SQLite, controlled reads/clock.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { createEffectFence } from '../../src/wallet/effect-fence.mjs';
import { createEffectHistory } from '../../src/wallet/effect-history.mjs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { bindFixture } from '../fixtures/tp1-authority-reader.mjs';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './purchase-admission-hook.mjs';
installPurchaseAdmissionHook();
export const { setPurchaseAdmission } = await loadAdmissionDouble();
export const { createEffectBoundary } = await import('../../src/wallet/effect-boundary.mjs');
export const flush = () => new Promise(resolve => setImmediate(resolve));
export const code = expected => error => error.code === expected;
export const digest = value => createHash('sha256').update(canonicalize(value)).digest('hex');
export const signedBytes = Buffer.from('TEST-exact-signed-artifact');
export function controlledClock() {
  let at = 0, id = 0;
  const timers = new Map();
  return { now: () => at, setTimer: (fn, ms) => { timers.set(++id, { fn, at: at + ms }); return id; },
    clearTimer: key => timers.delete(key), advance: ms => { at += ms; for (const [key, timer] of timers) if (timer.at <= at) { timers.delete(key); timer.fn(); } }, timers };
}
export async function boundaryWorld(t) {
  setPurchaseAdmission('testnet-tp1');
  const bound = await bindFixture();
  const directory = mkdtempSync(join(tmpdir(), 'client-eb-'));
  const path = join(directory, 'wallet.sqlite');
  const world = { ...bound, clock: controlledClock(), stopped: false, revision: 1, approval: { rev: 1, open: true },
    events: [], sent: [], signatures: 0, acquired: 0, released: 0, held: false };
  const waiters = [];
  const grant = () => { if (!world.held && waiters.length) { world.held = true; waiters.shift()(); } };
  world.fence = createEffectFence({ currentLocal: () => digest(world.currentLocal()),
    acquire: () => { world.acquired++; return new Promise(resolve => { waiters.push(() => resolve({ release: () => { world.held = false; world.released++; grant(); } })); grant(); }); },
    setTimer: world.clock.setTimer, clearTimer: world.clock.clearTimer });
  world.journal = openDurableWalletJournal({ path, mode: 'create' });
  world.options = () => ({ binding: world.binding, currentLocal: world.currentLocal, stopped: async () => { world.events.push('stop'); return world.stopped; },
    feeCeilingOs: '50000000000', history: world.history, fence: world.fence, clock: world.clock,
    currentApproval: () => world.approval, currentRevision: () => world.revision });
  world.resetBoundary = patch => { world.boundary = createEffectBoundary({ ...world.options(), ...patch }); };
  world.reopen = () => { world.journal.close(); world.journal = openDurableWalletJournal({ path, mode: 'open' }); world.history = createEffectHistory({ journal: world.journal }); world.resetBoundary(); };
  world.history = createEffectHistory({ journal: world.journal });
  world.resetBoundary();
  world.op = { operationId: 'TEST-operation', lane: 'TEST-lane', kind: 'native', pinVersion: world.binding.profile.pinVersion,
    paidWrite: true, debitOs: '50000000000', approvalRef: { ...world.approval }, k1Rev: 1 };
  world.sign = op => world.boundary.signPass(op ?? world.op, () => { world.events.push('sign'); world.signatures++; return signedBytes; });
  world.send = (op, options) => world.boundary.dispatchPass(op, bytes => { world.events.push('send'); world.sent.push(Buffer.from(bytes)); return 'TEST-ack'; }, options);
  world.run = async (op = world.op) => world.boundary.withOperation(op, async () => { const signed = await world.sign(op); await world.send(signed); return signed; });
  t.after(() => { world.journal.close(); rmSync(directory, { recursive: true, force: true }); setPurchaseAdmission('held'); });
  return world;
}
export async function states(world, artifact) { return (await world.history.read(artifact)).map(record => record.state); }
export function cutAppend(world, state, { after = false, mutate, error = new Error('TEST-crash-cut') } = {}) {
  const real = world.history.append;
  world.history.append = async record => {
    if (record.state !== state) return real(record);
    if (mutate) { mutate(); return real(record); }
    if (after) await real(record);
    throw error;
  };
  return error;
}
export async function noEffects(world, promise, expected) {
  await assert.rejects(promise, code(expected));
  assert.equal(world.signatures, 0); assert.equal(world.sent.length, 0); assert.equal(world.held, false);
}
