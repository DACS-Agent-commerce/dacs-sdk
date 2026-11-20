// Effect boundaries for tests that build a native transport that writes. The transport requires one.
import { createEffectBoundary, digest, setPurchaseAdmission } from './effect-boundary-fixture.mjs'; // first: it installs the purchase-admission hook
import { createEffectFence } from '../../src/wallet/effect-fence.mjs';
import { createEffectHistory } from '../../src/wallet/effect-history.mjs';
import { bindFixture } from '../fixtures/tp1-authority-reader.mjs';

const bound = await bindFixture();

/** The pin version a transport must carry to write through `writingBoundary`: the one in the binding the boundary holds. */
export const BOUND_PIN_VERSION = bound.binding.profile.pinVersion;

/**
 * A real boundary over `journal` and the transport owner's fence, for a transport that writes (give the transport `BOUND_PIN_VERSION`).
 * `feeCeilingOs` is the host ceiling and `stopped` the stop check; both default to an unstopped 50 DEM host. It admits purchase actions, as a host does.
 */
export function writingBoundary({ owner, journal, feeCeilingOs = '50000000000', stopped = async () => false } = {}) {
  setPurchaseAdmission('testnet-tp1');
  const fence = createEffectFence({ acquire: () => owner.acquireConnectionFence({}), currentLocal: () => digest(bound.currentLocal()) });
  return createEffectBoundary({ binding: bound.binding, currentLocal: bound.currentLocal, stopped, feeCeilingOs, history: createEffectHistory({ journal }), fence });
}
