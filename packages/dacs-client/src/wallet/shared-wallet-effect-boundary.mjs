// The client's effect boundary over an admitted binding, a durable journal and a transport owner's connection fence, shared
// by the keyed wallet composition and the keyless signed relay. It loads no demosdk and holds no key.
import { createHash } from 'node:crypto';
import { canonicalize } from '@kynesyslabs/dacs';
import { POSITIVE_OS_AMOUNT } from '../public-admission.mjs';
import { createEffectBoundary } from './effect-boundary.mjs';
import { createEffectFence } from './effect-fence.mjs';
import { createEffectHistory } from './effect-history.mjs';
import { JOURNAL_METHODS } from './keystore-wallet-opener.mjs';

const localDigestOf = local => createHash('sha256').update(canonicalize(local)).digest('hex');

/**
 * Returns the effect boundary (see `createEffectBoundary`) over `admission.binding`, the journal's dispatch history and the owner's
 * connection fence, with the host's stop check and fee ceiling, both required with no default. Nothing is opened, so a TypeError
 * here (a journal without its six methods, a ceiling that is not a positive decimal OS amount) leaves nothing to close.
 */
export function finalizeEffectBoundary({ owner, journal, admission, stopped, feeCeilingOs }) {
  if (!JOURNAL_METHODS.every(name => typeof journal?.[name] === 'function')) throw new TypeError(`the journal needs ${JOURNAL_METHODS.join(', ')}`);
  if (typeof feeCeilingOs !== 'string' || !POSITIVE_OS_AMOUNT.test(feeCeilingOs)) throw new TypeError('feeCeilingOs must be a positive decimal OS amount');
  const fence = createEffectFence({ acquire: () => owner.acquireConnectionFence(), currentLocal: () => localDigestOf(owner.currentLocal()) });
  return createEffectBoundary({ binding: admission.binding, currentLocal: owner.currentLocal, stopped, feeCeilingOs, history: createEffectHistory({ journal }), fence });
}
