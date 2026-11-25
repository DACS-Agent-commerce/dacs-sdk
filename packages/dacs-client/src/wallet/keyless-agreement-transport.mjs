// Key-free Agreement transports over a caller's transport owner and journal: a readback view that signs and sends nothing, a relay
// that confirms and broadcasts what the buyer's own wallet signed, and the pure public Agreement profile.
import { canonicalize } from '@kynesyslabs/dacs';
import { assertTp1Binding } from '@kynesyslabs/dacs/wire';
import { notAdmittedError, purchaseActionsAdmitted } from '../public-admission.mjs';
import { normalizeDemosAddress } from '../signatures.mjs';
import { settleOnAbort } from '../util/http.mjs';
import { approvedPins, approvedSourcePolicy, checkConstruction, fail, readExpectedPins, withinAuthorityDeadline } from './approved-record-pins.mjs';
import { agreementProfileFor, createDevnetAgreementTransport, registerHeldTransportFacade, BOUNDARY_METHODS } from './devnet-native-transport.mjs';
import { createHeldTransportFacade, finalizeEffectBoundary } from './held-transport-facade.mjs';
import { JOURNAL_METHODS } from './keystore-wallet-opener.mjs';

const KEYLESS_OPTION_NAMES = ['admission', 'owner', 'journal', 'walletAddress'];
const SIGNED_RELAY_OPTION_NAMES = ['admission', 'owner', 'journal', 'stopped', 'feeCeilingOs'];
const SIGNED_RELAY_OPTIONS_INVALID = 'keyless_relay_options_invalid';
const RELAY_CHECK_REQUIRED = 'relay_authorization_required';
const KEYLESS_OWNER_METHODS = ['currentLocal', 'getContext', 'acquireConnectionFence', 'fetchImpl'];
const READBACK_PHASE = 'readback';
const RELEASE_PHASE = 'release';
const KEYLESS_READBACK_KEYS = 'address,hash,phase';
const KEYLESS_RELEASE_KEYS = 'address,leaseId,phase';
const KEYLESS_NODE_READS = ['getNetworkInfo', 'getNetworkParameters', 'getAddressNonce'];
const KEYLESS_WRITE_REFUSED = 'keyless_transport_write_refused';

/** Returns true for an `https:` origin written exactly as `URL.origin` writes it: no path, query, fragment or trailing slash. */
function isHttpsOrigin(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
}

// The effect boundary of a keyless transport: it has every method the transport calls on a boundary, and each refuses.
function createRefusingBoundary() {
  const refuse = () => fail(KEYLESS_WRITE_REFUSED);
  return Object.freeze(Object.fromEntries(BOUNDARY_METHODS.map(name => [name, refuse])));
}

function checkKeylessOptions(options) {
  if (Object.keys(options).some(name => !KEYLESS_OPTION_NAMES.includes(name))) throw new TypeError('keyless_transport_options_invalid');
  const { owner, journal, walletAddress } = options;
  if (!KEYLESS_OWNER_METHODS.every(name => typeof owner?.[name] === 'function') || !JOURNAL_METHODS.every(name => typeof journal?.[name] === 'function')) throw new TypeError('keyless_transport_options_invalid');
  let canonical = false;
  try { canonical = normalizeDemosAddress(walletAddress) === walletAddress; } catch { /* a malformed address is refused below */ }
  if (!canonical) throw new TypeError('wallet_address_invalid');
}

// The wire's binding check under the authority deadline, then the connection must be the one that was checked.
async function checkKeylessAdmission({ binding, currentLocal }, owner) {
  const local = owner.currentLocal(), checked = canonicalize(local);
  try { await withinAuthorityDeadline(({ signal }) => settleOnAbort(assertTp1Binding(binding, local), signal)); }
  catch (error) { throw notAdmittedError(error); }
  if (canonicalize(currentLocal()) !== checked || canonicalize(owner.currentLocal()) !== checked) fail('tp1_local_binding_changed');
}

// A request the relay may forward: exactly a readback or a release of the bound wallet, rebuilt from the checked values.
function checkKeylessRequest(request, walletAddress) {
  if (request === null || typeof request !== 'object') fail(KEYLESS_WRITE_REFUSED);
  const { phase, address, hash, leaseId } = request, keys = Object.keys(request).sort().join();
  const shaped = (phase === READBACK_PHASE && keys === KEYLESS_READBACK_KEYS && typeof hash === 'string')
    || (phase === RELEASE_PHASE && keys === KEYLESS_RELEASE_KEYS && typeof leaseId === 'string');
  if (!shaped || address !== walletAddress) fail(KEYLESS_WRITE_REFUSED);
  return phase === READBACK_PHASE ? { phase, address, hash } : { phase, address, leaseId };
}

// Only the three preparation reads, and only for the bound wallet's nonce.
function checkKeylessRead(body, walletAddress) {
  const call = body?.method === 'nodeCall' && Array.isArray(body.params) && body.params.length === 1 ? body.params[0] : null;
  if (!KEYLESS_NODE_READS.includes(call?.message) || (call.message === 'getAddressNonce' && call.data?.address !== walletAddress)) fail(KEYLESS_WRITE_REFUSED);
}

/**
 * Returns a Promise for a frozen, registered Agreement relay view, `{binding, walletBinding, rpc, close}`, over the caller's `owner` and `journal` for
 * one wallet. It holds no key and signs nothing: its transport's effect boundary refuses every method, and the view refuses every request but a
 * retained-hash readback or a release of this view's own (always empty) lease set, and the three node reads `getNetworkInfo`,
 * `getNetworkParameters` and `getAddressNonce` for the bound wallet. `isDevnetAgreementTransport(view)` is true. It has no `pins`, `journal`,
 * `observeBinding` or `profile` member, so it is not a purchase source; `keylessAgreementProfile` gives the public profile.
 *
 * Options, and only these: `{admission: {binding, currentLocal}, owner, journal, walletAddress}`. `owner` is a transport owner (see `createNodeTransportOwner`)
 * and `journal` a durable native-transfer journal; the caller owns both and closes them. `walletAddress` is the lowercase `0x` and 64 hex address
 * of the wallet to relay. The SDK-approved record is bound to `admission.binding` by the wire's check within 10 s, and the pins come from that binding alone.
 *
 * `binding(request)` and `walletBinding(request, headers)` take exactly `{phase: 'readback', address, hash}` or `{phase: 'release', address, leaseId}`;
 * `rpc(body, headers)` takes exactly one `nodeCall` and no third argument. Anything else, or another wallet's address, rejects with
 * OperationError(keyless_transport_write_refused) before any journal or node call. While purchase actions are held, `binding` readback still runs and
 * every other call rejects profile_not_admitted. After `close()` a call rejects transport_closed. Replies keep the transport's 4 MiB limit and 10 s deadline.
 * `close()` waits for reads in flight; it does not close the owner or the journal.
 *
 * Rejects with TypeError(admission_required | admission_input_untrusted | keyless_transport_options_invalid | wallet_address_invalid),
 * OperationError(runtime_unsupported | profile_not_admitted (cause kept) | tp1_local_binding_changed).
 */
export async function createKeylessAgreementTransport(options) {
  checkConstruction(options);
  checkKeylessOptions(options);
  const { admission, owner, journal, walletAddress } = options;
  await checkKeylessAdmission(admission, owner);
  const expected = readExpectedPins(admission.binding, owner);
  const inner = createDevnetAgreementTransport({ expected, transportOwner: owner, journal, fetchImpl: (input, init) => owner.fetchImpl(input, init),
    boundary: createRefusingBoundary(), ...approvedSourcePolicy() });
  let closed = false;
  const admitCall = ({ passive = false } = {}) => {
    if (closed) fail('transport_closed');
    if (!passive && !purchaseActionsAdmitted()) throw notAdmittedError();
  };
  const view = Object.freeze({
    async binding(request) {
      const checked = checkKeylessRequest(request, walletAddress);
      admitCall({ passive: checked.phase === READBACK_PHASE });
      return inner.binding(checked);
    },
    async walletBinding(request, headers) {
      const checked = checkKeylessRequest(request, walletAddress);
      admitCall();
      return inner.walletBinding(checked, headers);
    },
    async rpc(body, headers, ...unsupported) {
      if (unsupported.length > 0) fail(KEYLESS_WRITE_REFUSED);
      checkKeylessRead(body, walletAddress);
      admitCall();
      return inner.rpc(body, headers);
    },
    async close() { closed = true; await inner.close(); },
  });
  registerHeldTransportFacade(view, inner);
  return view;
}

/**
 * Returns a Promise for a frozen `{nativeTransport}`: a registered Agreement transport (`isDevnetAgreementTransport` is true) that relays what the buyer's own
 * wallet signed. It holds no key and signs nothing. `nativeTransport.rpc(body, headers, {currentAuthorization})` confirms and broadcasts a native payment or
 * an Agreement CREATE exactly as the wallet signed it, with the wallet's own RPC authentication headers, under a lease the wallet took through
 * `walletBinding`; it also makes the three preparation reads. Every other member is the held facade's (see `createHeldTransportFacade`).
 *
 * Options, and only these: `{admission: {binding, currentLocal}, owner, journal, stopped, feeCeilingOs}`. `owner` is a transport owner (see
 * `createNodeTransportOwner`) and `journal` a durable native-transfer journal; the caller owns both and closes them. `stopped()` is the host's stop check and
 * `feeCeilingOs` its fee ceiling, a positive decimal OS amount, both required with no default. The binding is checked by the wire within 10 s, and the pins
 * come from that binding alone.
 *
 * Right before the first byte of each confirmation or broadcast, the effect boundary checks that purchase actions are admitted, the binding is current,
 * `stopped()` answers false and the whole signed debit (the amount, plus every fee for a broadcast) is at most `feeCeilingOs`, and then runs
 * `currentAuthorization`. A failed check sends nothing and rejects with its code: `profile_not_admitted`, the wire's `tp1_*` refusal, `writes_stopped`,
 * `write-fee-cap`, or the check's own error. An `execute` body without the relay check rejects TypeError(relay_authorization_required) before anything runs.
 * A broadcast whose outcome is unknown stays in `journal` and is never sent again: later sends of those bytes and new leases for that wallet reject
 * `outcome_unknown`, and `binding({phase: 'readback', address, hash})` reads it back. `close()` closes the transport, not the owner or the journal.
 *
 * Rejects with TypeError(admission_required | admission_input_untrusted | keyless_relay_options_invalid | a missing or malformed `stopped`, `feeCeilingOs` or
 * journal), OperationError(runtime_unsupported | invalid_transport_owner | profile_not_admitted (cause kept) | tp1_local_binding_changed).
 */
export async function createKeylessSignedRelayTransport(options) {
  checkConstruction(options);
  if (Object.keys(options).some(name => !SIGNED_RELAY_OPTION_NAMES.includes(name))
    || !KEYLESS_OWNER_METHODS.every(name => typeof options.owner?.[name] === 'function')) throw new TypeError(SIGNED_RELAY_OPTIONS_INVALID);
  const { admission, owner, journal, stopped, feeCeilingOs } = options;
  const boundary = finalizeEffectBoundary({ owner, journal, admission, stopped, feeCeilingOs });
  await checkKeylessAdmission(admission, owner);
  const inner = createDevnetAgreementTransport({ expected: readExpectedPins(admission.binding, owner), transportOwner: owner, journal,
    fetchImpl: (input, init) => owner.fetchImpl(input, init), boundary, ...approvedSourcePolicy(), authorityBinding: admission.binding });
  const held = createHeldTransportFacade({ admission, transport: inner });
  const nativeTransport = Object.freeze({ ...held, rpc(body, headers, relayOptions) {
    if (body?.method === 'execute' && relayOptions === undefined) return Promise.reject(new TypeError(RELAY_CHECK_REQUIRED));
    return held.rpc(body, headers, relayOptions);
  } });
  registerHeldTransportFacade(nativeTransport, inner);
  return Object.freeze({ nativeTransport });
}

/**
 * Returns the public Agreement profile, `{profile, network, rpcUrl, bindingUrl, transportBinding, ...}`, of a transport pinned to the SDK-approved record
 * as `binding` carries it, with its URLs under `publicOrigin`. It is the profile `createKeylessAgreementTransport` and every plain Agreement transport
 * over the same pins give, with the same `transportBinding` and `bindingId`. It is synchronous and pure: no owner, journal or node is touched. It checks
 * only that `binding` carries the approved record's digest and pin fields, not the wire's binding check, so pass a binding that check has admitted.
 * Throws OperationError(admission_required) for a missing, malformed or other-record binding and TypeError(public_origin_invalid) unless `publicOrigin` is an `https:` origin.
 */
export function keylessAgreementProfile({ binding, publicOrigin } = {}) {
  const pins = approvedPins(binding);
  if (!isHttpsOrigin(publicOrigin)) throw new TypeError('public_origin_invalid');
  return agreementProfileFor(pins, publicOrigin);
}
