// The held facade over a registered native transport, and the client effect boundary a composition gives that transport.
// Neither loads the Demos SDK or holds a key, so the package root can use them as well as the Node wallet session.
import { createHash } from 'node:crypto';
import { canonicalize } from '@kynesyslabs/dacs';
import { admitPublicFactory } from '../public-admission.mjs';
import { fail } from './approved-record-pins.mjs';
import { registerHeldTransportFacade } from './devnet-native-transport.mjs';
import { createEffectBoundary } from './effect-boundary.mjs';
import { createEffectFence } from './effect-fence.mjs';
import { createEffectHistory } from './effect-history.mjs';
import { JOURNAL_METHODS } from './keystore-wallet-opener.mjs';
import { currentPassContext, relayPassContext, runInPassContext } from './pass-context.mjs';

// The facade members that only read or observe; every other function member is an effect entry. `binding` is split by phase.
const PASSIVE_TRANSPORT_METHODS = ['readRpc', 'observeBinding', 'chainReader', 'nativeTransferClaimed', 'nativeTransferCancelled',
  'nativeTransferRefused', 'nativeNonceConsumer', 'isWalletIdle', 'profile', 'onPurchaseStep', 'onStorageWriteResend', 'reserveRpcAuth', 'close'];
const READBACK_PHASE = 'readback';

/** A positive decimal OS amount with no leading zero, the form of every fee ceiling. */
export const POSITIVE_OS_AMOUNT = /^[1-9][0-9]*$/;

const localDigestOf = local => createHash('sha256').update(canonicalize(local)).digest('hex');

/**
 * Returns a frozen facade over a registered transport, itself registered so the `isDevnet*Transport` checks accept it. Active members (`rpc`, `walletBinding`,
 * `recoverStorageWrite`, `cancelNativeTransfer`, `withWalletNonceLock` and `binding` for every phase but `readback`) run the admission wrapper and reject `profile_not_admitted` while held;
 * the passive members listed in the README keep their signatures. `readback` is read once, before the call, so a request changed afterwards cannot move it
 * between the two classes. Options: `{admission, transport}`. Throws TypeError(admission_required | admission_input_untrusted | an unregistered transport) and
 * OperationError(runtime_unsupported); active calls reject with `profile_not_admitted`, `runtime_unsupported` or the transport's own error.
 *
 * `rpc(body, headers, { currentAuthorization }?)` takes an optional relay check: a synchronous function that returns `true` while the relay's authority
 * is current and throws its cause otherwise. The transport runs it as the last check before each node send of that call, after every wait, and sends
 * only when it answered `true`; a throw refuses with the thrown error and any other answer with `context_authorization_refused`. A refusal sends nothing.
 * `rpc` rejects `relay_authorization_invalid` (TypeError) for any other option and `relay_authorization_nested` inside another pass. The check is not run for
 * preparation reads or for a confirmation the retained record answers, and it can run twice for one broadcast. Without the option `rpc` runs no relay check,
 * and the other members (`walletBinding`, `recoverStorageWrite`, `cancelNativeTransfer`) never take one.
 */
export function createHeldTransportFacade({ admission, transport } = {}) {
  const wrapped = admitPublicFactory(() => transport, { passive: PASSIVE_TRANSPORT_METHODS, purchase: true })({ admission });
  // The reopen entry is the composition's own (`withheldReopen`), never a member a host or a relay holds.
  const members = Object.fromEntries(Object.entries(wrapped).filter(([name]) => !['actionsAdmitted', 'reopenWithheldBroadcast'].includes(name)));
  const facade = Object.freeze({ ...members, binding(request, ...args) {
    try {
      return request?.phase === READBACK_PHASE ? transport.binding({ ...request, phase: READBACK_PHASE }, ...args) : wrapped.binding(request, ...args);
    } catch (error) { return Promise.reject(error); }
  }, rpc(body, headers, relayOptions) {
    try {
      if (relayOptions === undefined) return wrapped.rpc(body, headers);
      const relay = relayPassContext(relayOptions);
      if (currentPassContext().operationClass !== null) fail('relay_authorization_nested');
      return runInPassContext(relay, () => wrapped.rpc(body, headers));
    } catch (error) { return Promise.reject(error); }
  } });
  registerHeldTransportFacade(facade, transport);
  return facade;
}

/**
 * Returns the client's effect boundary for a composition over `owner` and `journal`: built over the admitted binding, the journal's dispatch history
 * and the owner's connection fence, with the host's stop check and fee ceiling, both required with no default. Nothing is opened, so a TypeError here
 * leaves nothing to close. Throws TypeError for a journal without the durable journal's methods, a `feeCeilingOs` that is not a positive decimal OS
 * amount, or a missing boundary source (see `createEffectBoundary`).
 */
export function finalizeEffectBoundary({ owner, journal, admission, stopped, feeCeilingOs }) {
  if (!JOURNAL_METHODS.every(name => typeof journal?.[name] === 'function')) throw new TypeError(`the journal needs ${JOURNAL_METHODS.join(', ')}`);
  if (typeof feeCeilingOs !== 'string' || !POSITIVE_OS_AMOUNT.test(feeCeilingOs)) throw new TypeError('feeCeilingOs must be a positive decimal OS amount');
  const fence = createEffectFence({ acquire: () => owner.acquireConnectionFence(), currentLocal: () => localDigestOf(owner.currentLocal()) });
  return createEffectBoundary({ binding: admission.binding, currentLocal: owner.currentLocal, stopped, feeCeilingOs, history: createEffectHistory({ journal }), fence });
}
