// Test-only effect boundary for the session-key request path: real durable history and journal, and a
// real actor fence over a queuing owner, bound to the wire world's binding and live connection.
// `control.stopped` and `control.onStop(call)` steer the host's stop check; `control.acquired` counts fence acquisitions.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize } from '@kynesyslabs/dacs';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { createEffectFence } from '../../src/wallet/effect-fence.mjs';
import { createEffectHistory } from '../../src/wallet/effect-history.mjs';
import { createEffectBoundary } from './effect-boundary-fixture.mjs';

const digestOf = (value) => createHash('sha256').update(canonicalize(value)).digest('hex');

export function requestBoundary(t, { binding, currentLocal }) {
  const directory = mkdtempSync(join(tmpdir(), 'request-boundary-'));
  const path = join(directory, 'journal.sqlite');
  const control = { stopped: false, stopCalls: 0, onStop: null, acquired: 0 };
  const waiters = [];
  let held = false;
  const grant = () => { if (!held && waiters.length) { held = true; waiters.shift()(); } };
  const fence = createEffectFence({ currentLocal: () => digestOf(currentLocal()),
    acquire: () => { control.acquired++; return new Promise((resolve) => { waiters.push(() => resolve({ release: () => { held = false; grant(); } })); grant(); }); } });
  const state = { journal: openDurableWalletJournal({ path, mode: 'create' }) };
  const build = () => {
    state.history = createEffectHistory({ journal: state.journal });
    state.boundary = createEffectBoundary({ binding, currentLocal, feeCeilingOs: '50000000000', history: state.history, fence,
      stopped: async () => { control.stopCalls++; await control.onStop?.(control.stopCalls); return control.stopped; } });
  };
  build();
  t.after(() => { state.journal.close(); rmSync(directory, { recursive: true, force: true }); });
  return { control, get boundary() { return state.boundary; }, get history() { return state.history; }, get journal() { return state.journal; },
    reopen() { state.journal.close(); state.journal = openDurableWalletJournal({ path, mode: 'open' }); build(); },
    records: async () => (await state.journal.entries()).filter(([key]) => key.startsWith('eb/')).map(([, record]) => record) };
}
