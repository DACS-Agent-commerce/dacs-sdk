// Test-only world: the demo transport of native-create-world with a real effect
// boundary (real history, fence and durable journal) bound by the approved record.
// `restart()` closes the journal and reopens the same file with a new transport. The
// node is scripted; `calls` counts every request it received, across restarts. No
// network, chain or funds.
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDurableWalletJournal } from '../../src/wallet/durable-journal.mjs';
import { createEffectFence } from '../../src/wallet/effect-fence.mjs';
import { createEffectHistory } from '../../src/wallet/effect-history.mjs';
import { bindFixture } from '../fixtures/tp1-authority-reader.mjs';
import { contextGate } from './context-gate.mjs';
import { controlledClock, createEffectBoundary, digest, setPurchaseAdmission } from './effect-boundary-fixture.mjs';
import { createWorld, NOW, queuingFenceOwner } from './native-create-world.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

/**
 * Opens the world. `feeCeilingOs` and `gas` (the `gas_operation` the node confirms with) are fixed for its life.
 * `journalOptions` go to the durable journal, `wrap(journal)` gives the journal the transport and the history use (to
 * count its lane locks), and `events` is where the transport owner's fence acquisitions are logged.
 * Set `putFault(key, value)` to a function that returns true to make that journal write of the transport fail, and
 * `nodeHook(message, call)` to run before the node answers a call. `gate.hold()` holds the next getContext call.
 * `referenceBlock` is the reference block the node's next confirmation carries (`null`: none) and `elapsedMs` moves the transport's clock.
 */
export async function boundedCreateWorld(t, { feeCeilingOs = '50000000000', gas = null, journalOptions = {}, wrap = journal => journal, events = [] } = {}) {
  setPurchaseAdmission('testnet-tp1');
  const bound = await bindFixture();
  const directory = mkdtempSync(join(tmpdir(), 'native-create-boundary-')), path = join(directory, 'journal.sqlite');
  const clock = controlledClock(), gate = contextGate();
  const w = { bound, clock, gate, stopped: false, putFault: null, nodeHook: null, referenceBlock: 0, elapsedMs: 0, calls: { confirmTx: 0, broadcastTx: 0 }, journal: null, history: null, boundary: null, world: null, owner: null };
  const open = (mode) => {
    w.journal = openDurableWalletJournal({ path, mode, ...journalOptions });
    const owner = queuingFenceOwner(events), ownerContext = owner.getContext;
    owner.getContext = async () => { await gate.pass(); return ownerContext(); };
    const fence = createEffectFence({ acquire: () => owner.acquireConnectionFence({}), currentLocal: () => digest(bound.currentLocal()), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const journal = wrap(w.journal);
    w.history = createEffectHistory({ journal });
    w.boundary = createEffectBoundary({ binding: bound.binding, currentLocal: bound.currentLocal, stopped: async () => w.stopped, feeCeilingOs, history: w.history, fence, clock });
    const faulty = { get: (key) => journal.get(key), entries: () => journal.entries(), withWalletLock: (key, work) => journal.withWalletLock(key, work),
      put: (key, value) => { if (w.putFault?.(key, value)) throw new Error('TEST-journal-cut'); return journal.put(key, value); } };
    w.owner = owner;
    w.world = createWorld({ journal: faulty, owner, boundary: w.boundary, pinVersion: bound.binding.profile.pinVersion, gas,
      referenceBlock: () => w.referenceBlock, now: () => NOW + w.elapsedMs,
      onNode: async (message, call) => { if (message in w.calls) w.calls[message]++; await w.nodeHook?.(message, call); } });
    return w.world;
  };
  open('create');
  t.after(() => { w.journal.close(); rmSync(directory, { recursive: true, force: true }); setPurchaseAdmission('held'); });
  w.restart = () => { w.journal.close(); w.putFault = null; return open('open'); };
  /** A CREATE of `jobId` at `nonce` through a fresh lease: confirmation, then broadcast. */
  w.send = async (jobId, nonce) => {
    const tx = await w.world.makeCreate(jobId, nonce), lease = await w.world.lease();
    const confirmation = await w.world.confirm(tx);
    return { tx, lease, confirmation, answer: await w.world.broadcast(lease, confirmation, tx.hash) };
  };
  w.records = (tx) => w.history.read({ lane: w.world.laneKey, artifactHash: sha(JSON.stringify(tx)) });
  w.states = async (tx) => (await w.records(tx)).map((record) => record.state);
  return w;
}
