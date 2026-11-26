// A keyless relay of a buyer wallet's own signed TP-1 payment or Agreement CREATE. The wallet signs every transaction and every
// RPC authentication; the relay checks them and confirms and broadcasts the exact signed bytes through the client's effect
// boundary. It holds no key, signs nothing and loads no demosdk.
import { POSITIVE_OS_AMOUNT } from '../public-admission.mjs';
import { approvedSourcePolicy, checkAdmission, checkConstruction, fail, hasOnlyDataMembers, readExpectedPins } from './approved-record-pins.mjs';
import { createDevnetAgreementTransport, registerHeldTransportFacade } from './devnet-native-transport.mjs';
import { createHeldTransportFacade } from './held-transport-facade.mjs';
import { JOURNAL_METHODS } from './keystore-wallet-opener.mjs';
import { relayPassContext } from './pass-context.mjs';
import { hasKeys } from './payload-helpers.mjs';
import { finalizeEffectBoundary } from './shared-wallet-effect-boundary.mjs';

const RELAY_OPTION_NAMES = ['admission', 'owner', 'journal', 'stopped', 'feeCeilingOs'];
const RELAY_OWNER_METHODS = ['currentLocal', 'getContext', 'acquireConnectionFence', 'fetchImpl'];
const RELAY_NODE_READS = ['getNetworkInfo', 'getNetworkParameters', 'getAddressNonce'];
const RELAY_EXECUTE_STAGES = ['confirmTx', 'broadcastTx'];
// The exact members of each wallet phase the relay forwards; a signature request may also name its transfer.
const WALLET_PHASE_KEYS = Object.freeze({ bind: ['phase', 'address'], signature: ['phase', 'address', 'binding'], broadcast: ['phase', 'address', 'leaseId', 'hash'],
  release: ['phase', 'address', 'leaseId'], readback: ['phase', 'address', 'hash'] });
const WALLET_PHASES = Object.keys(WALLET_PHASE_KEYS);
const READBACK_PHASES = ['readback'];
const TRANSFER_KEYS = ['nonce', 'to', 'amountOs', 'payloadDigest'];
const WRITE_REFUSED = 'keyless_relay_write_refused';

// The construction checks after the admission shape, in order; none of them calls the owner or the journal.
function checkRelayOptions(options) {
  if (!hasKeys(options, RELAY_OPTION_NAMES)) throw new TypeError('keyless_relay_options_invalid');
  const { owner, journal, stopped, feeCeilingOs } = options;
  if (typeof feeCeilingOs !== 'string' || !POSITIVE_OS_AMOUNT.test(feeCeilingOs)) throw new TypeError('keyless_relay_fee_ceiling_invalid');
  if (typeof stopped !== 'function') throw new TypeError('keyless_relay_stop_invalid');
  if (!RELAY_OWNER_METHODS.every(name => typeof owner?.[name] === 'function')) throw new TypeError('keyless_relay_owner_invalid');
  if (!JOURNAL_METHODS.every(name => typeof journal?.[name] === 'function')) throw new TypeError('keyless_relay_journal_invalid');
}

// A wallet request the relay forwards: one of `phases` with exactly that phase's members, a string lease id and hash, and for a
// signature an optional transfer of exactly its four terms. It is rebuilt from the checked members, so no server proof gets through.
function checkWalletRequest(request, phases) {
  const keys = request !== null && typeof request === 'object' && phases.includes(request.phase) ? WALLET_PHASE_KEYS[request.phase] : null;
  if (!keys) fail(WRITE_REFUSED);
  const named = Object.hasOwn(request, 'transfer');
  if (!hasOnlyDataMembers(request, named ? [...keys, 'transfer'] : keys) || (named && (request.phase !== 'signature' || !hasOnlyDataMembers(request.transfer, TRANSFER_KEYS)))
    || ['leaseId', 'hash'].some(name => Object.hasOwn(request, name) && typeof request[name] !== 'string')) fail(WRITE_REFUSED);
  return named ? { ...request, transfer: { ...request.transfer } } : { ...request };
}

// Whether `body` is one of the three preparation reads (taking no relay check) or else one confirmTx or broadcastTx (taking at most one).
function isPreparationRead(body, relay) {
  const call = Array.isArray(body?.params) && body.params.length === 1 ? body.params[0] : null;
  if (body?.method === 'nodeCall' && RELAY_NODE_READS.includes(call?.message) && relay.length === 0) return true;
  if (body?.method !== 'execute' || !RELAY_EXECUTE_STAGES.includes(call?.extra) || relay.length > 1) fail(WRITE_REFUSED);
  return false;
}

// The host's stop check, read synchronously as the relay's last check before a node send: only `false` lets the send go.
function assertNotStopped(stopped) {
  let answer;
  try { answer = stopped(); } catch (cause) { fail('stop_check_failed', cause); }
  if (typeof answer?.then === 'function') Promise.resolve(answer).catch(() => {});
  if (typeof answer !== 'boolean') fail('stop_check_invalid');
  if (answer) fail('writes_stopped');
}

/**
 * Returns a Promise for `{nativeTransport}`: a frozen, registered Agreement transport view `{binding, walletBinding, rpc, close}` that relays a
 * buyer wallet's own signed TP-1 native payment or Agreement CREATE, which the wallet claims for broadcast, through the confirm and broadcast
 * checks of the client's native transport. It holds no key and signs nothing. `isDevnetAgreementTransport(nativeTransport)` is true.
 *
 * Options, exactly: `{admission: {binding, currentLocal}, owner, journal, stopped, feeCeilingOs}`. `owner` is a transport owner (see
 * `createNodeTransportOwner`) and `journal` a durable native-transfer journal; the caller owns both and closes them. `stopped` is the host's
 * synchronous stop check, never called during construction. `feeCeilingOs` (a positive decimal OS amount, no default) bounds the sum of the
 * three fees the wallet signed; the payment amount is never compared with it.
 *
 * `walletBinding(request, headers)` takes the wallet phases `bind`, `signature` (with an optional `transfer`), `broadcast`, `release` and
 * `readback`, each with exactly its own members; `binding(request)` takes only a `readback`, which also runs while purchase actions are held.
 * `rpc(body, headers)` takes one `getNetworkInfo`, `getNetworkParameters` or `getAddressNonce` node call, and `rpc(body, headers,
 * {currentAuthorization})` one `confirmTx` or `broadcastTx`; the transport sends it only when `stopped()` answers `false` and
 * `currentAuthorization()` answers `true`, both synchronously, after every wait. Bytes whose confirmation may have reached the node unanswered
 * reject `eb_readback_required`, also after a restart: read them back and sign new ones. `close()` drains calls in flight; later calls reject
 * `transport_closed`.
 *
 * Rejects at construction with TypeError(admission_required | admission_input_untrusted | keyless_relay_options_invalid |
 * keyless_relay_fee_ceiling_invalid | keyless_relay_stop_invalid | keyless_relay_owner_invalid | keyless_relay_journal_invalid) and
 * OperationError(runtime_unsupported | profile_not_admitted (cause kept) | tp1_local_binding_changed). A call rejects
 * OperationError(keyless_relay_write_refused) for any other request or body before the transport sees it, TypeError(relay_authorization_invalid)
 * for a missing or malformed relay check, OperationError(profile_not_admitted) while held, the stop codes (writes_stopped | stop_check_failed |
 * stop_check_invalid), write-fee-cap over the ceiling, or the transport's own refusal.
 */
export async function createKeylessSignedRelayTransport(options) {
  checkConstruction(options);
  checkRelayOptions(options);
  const { admission, owner, journal, stopped, feeCeilingOs } = options;
  await checkAdmission(admission, owner);
  const expected = readExpectedPins(admission.binding, owner);
  const boundary = finalizeEffectBoundary({ owner, journal, admission, stopped, feeCeilingOs });
  const inner = createDevnetAgreementTransport({ expected, transportOwner: owner, journal, fetchImpl: (input, init) => owner.fetchImpl(input, init), boundary,
    ...approvedSourcePolicy(), networkFeeCeilingOnly: true, noRepeatUnknownConfirm: true });
  const held = createHeldTransportFacade({ admission, transport: inner });
  const nativeTransport = Object.freeze({
    async binding(request) { return held.binding(checkWalletRequest(request, READBACK_PHASES)); },
    async walletBinding(request, headers) { return held.walletBinding(checkWalletRequest(request, WALLET_PHASES), headers); },
    async rpc(body, headers, ...relay) {
      if (isPreparationRead(body, relay)) return held.rpc(body, headers);
      const [authorization] = relay;
      relayPassContext(authorization);
      return held.rpc(body, headers, { currentAuthorization: () => { assertNotStopped(stopped); return authorization.currentAuthorization(); } });
    },
    async close() { await inner.close(); },
  });
  registerHeldTransportFacade(nativeTransport, inner);
  return Object.freeze({ nativeTransport });
}
