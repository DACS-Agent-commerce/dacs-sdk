// Test-only world for the kit's effect boundary (K0): a controllable monotonic
// clock, barriers, instrumented signer, transport, stop check and authority reader,
// and a boundary over real history files. Never in `files`, never under `src/`.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TP1_APPROVED_IDENTITY_RECORD, bindTp1Profile } from '@kynesyslabs/dacs/wire';
import * as guard from '../../src/kit-operation-guard.mjs';
import { createEffectBoundary } from '../../src/dacs/effect-boundary.mjs';
import { createEffectHistory } from '../../src/dacs/effect-history.mjs';
import { TEST_CONNECTION, authorityReader } from './wire-authority-fixture.mjs';

export const FEE_CEILING_OS = '50000000000';
export const SIGNED_BYTES = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
export const NEVER = new Promise(() => {});

/** Lets every queued microtask and I/O callback run; not a sleep. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/** A monotonic clock the test moves: `now()`, `after(ms, fn)` returning a cancel function, `advance(ms)` firing due timers in order. */
export function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    after(ms, callback) {
      const timer = { at: now + ms, callback };
      timers.push(timer);
      return () => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); };
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers.splice(timers.indexOf(due), 1);
        now = due.at;
        due.callback();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

/** A one-use barrier: `await gate.arrive()` inside the pass parks it, the test awaits `gate.reached`, then calls `gate.release()`. */
export function gate() {
  let release;
  let reach;
  const reached = new Promise((resolve) => { reach = resolve; });
  const open = new Promise((resolve) => { release = resolve; });
  return { reached, release, arrive: () => { reach(); return open; } };
}

/**
 * A fresh world: data directory, binding, counters and hooks. `control.readHook(n, scope, base)` answers the
 * n-th authority read, `control.stopHook(n)` the n-th stop check, `control.appendHook(record)` runs before
 * each history append; `build()` makes a boundary over the same directory, as after a restart. The guard
 * is set to admit when the world is made and again when the test ends.
 */
export async function ebWorld(t, { historyIo } = {}) {
  guard.setKitOperationGuardForTest('testnet-tp1');
  const dataDirectory = await mkdtemp(join(tmpdir(), 'TEST-effect-boundary-'));
  const clock = fakeClock();
  const trace = [];
  const control = { local: { ...TEST_CONNECTION }, stopped: false, reads: 0, stops: 0, readHook: null, stopHook: null, appendHook: null };
  const counts = { signer: 0, transport: 0 };
  const sent = [];
  const base = authorityReader();
  const readAuthority = (scope) => {
    control.reads += 1;
    trace.push('authority');
    return control.readHook ? control.readHook(control.reads, scope, base) : base(scope);
  };
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: { ...control.local }, readAuthority });
  control.reads = 0;
  trace.length = 0;
  t.after(async () => { guard.setKitOperationGuardForTest('testnet-tp1'); await rm(dataDirectory, { recursive: true, force: true }); });
  const stopped = () => {
    control.stops += 1;
    trace.push('stop');
    return control.stopHook ? control.stopHook(control.stops) : control.stopped;
  };
  const world = {
    dataDirectory, clock, control, counts, sent, trace, binding, guard,
    sign: (bytes = SIGNED_BYTES) => () => { counts.signer += 1; trace.push('sign'); return bytes; },
    send: (answer = 'accepted') => (bytes) => { counts.transport += 1; trace.push('send'); sent.push(bytes); return answer; },
    op: (overrides = {}) => ({ operationId: 'op-1', lane: 'lane-1', kind: 'native-transaction', paidWrite: true, debitOs: '1000', approvalRef: null, k1Rev: null, pinVersion: binding.profile.pinVersion, ...overrides }),
    /** A new boundary and history over the same data directory, as after a restart. */
    build({ feeCeilingOs = FEE_CEILING_OS } = {}) {
      const realHistory = createEffectHistory({ dataDirectory, io: historyIo });
      const history = { ...realHistory, append: async (lane, record) => {
        trace.push(`append:${record.state}`);
        if (control.appendHook) await control.appendHook(record);
        return realHistory.append(lane, record);
      } };
      const boundary = createEffectBoundary({ stopped, binding, currentLocal: () => ({ ...control.local }), feeCeilingOs, history, clock });
      return { boundary, history: realHistory };
    },
  };
  return world;
}

/** Settles a promise that must still be pending (the pass is parked or the process "crashed"). */
export async function stillPending(promise) {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  return !settled;
}
