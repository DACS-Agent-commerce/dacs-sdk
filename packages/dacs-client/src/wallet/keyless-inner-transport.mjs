// The keyless Agreement transport both keyless node-wallet factories build over a caller's transport owner and durable
// journal: the construction checks, the binding check, the approved pins, the client's effect boundary and the inner
// native transport. It holds no key, signs nothing and loads no demosdk. Not in the package `exports` map.
import { POSITIVE_OS_AMOUNT } from '../public-admission.mjs';
import { approvedSourcePolicy, checkAdmission, checkConstruction, readExpectedPins } from './approved-record-pins.mjs';
import { createDevnetAgreementTransport } from './devnet-native-transport.mjs';
import { JOURNAL_METHODS } from './keystore-wallet-opener.mjs';
import { hasKeys } from './payload-helpers.mjs';
import { finalizeEffectBoundary } from './shared-wallet-effect-boundary.mjs';

const KEYLESS_OPTION_NAMES = ['admission', 'owner', 'journal', 'stopped', 'feeCeilingOs'];
const KEYLESS_OWNER_METHODS = ['currentLocal', 'getContext', 'acquireConnectionFence', 'fetchImpl'];

// The construction checks after the admission shape, in order; none of them calls the owner or the journal.
function checkKeylessOptions(options) {
  if (!hasKeys(options, KEYLESS_OPTION_NAMES)) throw new TypeError('keyless_relay_options_invalid');
  const { owner, journal, stopped, feeCeilingOs } = options;
  if (typeof feeCeilingOs !== 'string' || !POSITIVE_OS_AMOUNT.test(feeCeilingOs)) throw new TypeError('keyless_relay_fee_ceiling_invalid');
  if (typeof stopped !== 'function') throw new TypeError('keyless_relay_stop_invalid');
  if (!KEYLESS_OWNER_METHODS.every(name => typeof owner?.[name] === 'function')) throw new TypeError('keyless_relay_owner_invalid');
  if (!JOURNAL_METHODS.every(name => typeof journal?.[name] === 'function')) throw new TypeError('keyless_relay_journal_invalid');
}

/**
 * Returns a Promise for a frozen `{inner, admission}`: `inner` is a registered Agreement-only native transport over `owner` and
 * `journal`, pinned to the admitted binding, whose effects go through the client's effect boundary with the host's `stopped` check
 * and `feeCeilingOs` bounding the signed network fee only; `admission` is the caller's own. The caller wraps `inner` and closes it.
 *
 * Options, exactly: `{admission: {binding, currentLocal}, owner, journal, stopped, feeCeilingOs}`. `stopped` is never called here.
 * Rejects, in this order and before anything is built: TypeError(admission_required | admission_input_untrusted),
 * OperationError(runtime_unsupported), TypeError(keyless_relay_options_invalid | keyless_relay_fee_ceiling_invalid |
 * keyless_relay_stop_invalid | keyless_relay_owner_invalid | keyless_relay_journal_invalid), none of which calls the owner or the
 * journal; then OperationError(profile_not_admitted, cause kept | tp1_local_binding_changed) from the binding check.
 */
export async function openKeylessInnerTransport(options) {
  checkConstruction(options);
  checkKeylessOptions(options);
  const { admission, owner, journal, stopped, feeCeilingOs } = options;
  await checkAdmission(admission, owner);
  const expected = readExpectedPins(admission.binding, owner);
  const boundary = finalizeEffectBoundary({ owner, journal, admission, stopped, feeCeilingOs });
  const inner = createDevnetAgreementTransport({ expected, transportOwner: owner, journal, fetchImpl: (input, init) => owner.fetchImpl(input, init), boundary,
    ...approvedSourcePolicy(), networkFeeCeilingOnly: true, noRepeatUnknownConfirm: true });
  return Object.freeze({ inner, admission });
}
