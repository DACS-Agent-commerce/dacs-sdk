// The offline demo transport world (native-create-world.mjs, which carries CREATE and its
// recovery) composed over a real effect boundary: real dispatch history and actor fence over
// the same durable journal, the owner's connection as the fence, and a controllable stop.
// No network, chain or funds.
import { setPurchaseAdmission, createEffectBoundary, controlledClock, digest } from './effect-boundary-fixture.mjs';
import { bindFixture } from '../fixtures/tp1-authority-reader.mjs';
import { createEffectFence } from '../../src/wallet/effect-fence.mjs';
import { createEffectHistory } from '../../src/wallet/effect-history.mjs';
import { createWorld, queuingFenceOwner } from './native-create-world.mjs';

const HISTORY_PREFIX = 'eb/', FEE_CEILING_OS = '50000000000';

/**
 * `createWorld` with an effect boundary over `journal`. `state.stopped` is the stop seam,
 * `bound.liveLocal()` the connection record the boundary compares, `clock` the boundary's
 * controlled clock, and `states()` the dispatch history of the journal as `passId/state`.
 * `feeCeilingOs` is the boundary's host ceiling (null for none). The purchase admission
 * is open until the test ends.
 */
export async function guardedCreateWorld(t, { journal, owner = queuingFenceOwner(), feeCeilingOs = FEE_CEILING_OS, ...worldOptions }) {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const bound = await bindFixture(), clock = controlledClock(), state = { stopped: false }, history = createEffectHistory({ journal });
  const fence = createEffectFence({ acquire: () => owner.acquireConnectionFence(), currentLocal: () => digest(bound.currentLocal()), setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const boundary = createEffectBoundary({ binding: bound.binding, currentLocal: bound.currentLocal, stopped: async () => state.stopped, feeCeilingOs, history, fence, clock });
  const world = createWorld({ journal, owner, boundary, pinVersion: bound.binding.profile.pinVersion, ...worldOptions });
  const records = async () => (await journal.entries()).filter(([key]) => key.startsWith(HISTORY_PREFIX)).map(([, record]) => record);
  return { ...world, bound, clock, state, history, fence, boundary, records, states: async () => (await records()).map((record) => `${record.passId}/${record.state}`) };
}
