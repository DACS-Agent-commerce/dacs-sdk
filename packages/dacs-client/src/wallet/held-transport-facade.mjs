// The held facade over a registered native transport: its active members wait for the purchase admission, and `rpc` can
// run a relay's own synchronous authorization check before each node send. It loads no demosdk and holds no key.
import { admitPublicFactory } from '../public-admission.mjs';
import { fail } from './approved-record-pins.mjs';
import { registerHeldTransportFacade } from './devnet-native-transport.mjs';
import { currentPassContext, relayPassContext, runInPassContext } from './pass-context.mjs';

// The facade members that only read or observe; every other function member is an effect entry. `binding` is split by phase.
const PASSIVE_TRANSPORT_METHODS = ['readRpc', 'observeBinding', 'chainReader', 'nativeTransferClaimed', 'nativeTransferCancelled',
  'nativeTransferRefused', 'nativeNonceConsumer', 'isWalletIdle', 'profile', 'onPurchaseStep', 'onStorageWriteResend', 'reserveRpcAuth', 'close'];
const READBACK_PHASE = 'readback';

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
  // The reopen entry (`withheldReopen`) and the nonce-lane inspection are the composition's own, never members a host or a relay holds.
  const members = Object.fromEntries(Object.entries(wrapped).filter(([name]) => !['actionsAdmitted', 'reopenWithheldBroadcast', 'inspectWalletNonceLane'].includes(name)));
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
