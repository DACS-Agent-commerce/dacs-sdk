// A keyless purchase source: the members the server-side purchase flow reads from its source capability, over a caller's
// transport owner and durable journal. It holds no key, signs nothing, has no member that confirms or broadcasts, and
// loads no demosdk.
import { admitPublicFactory } from '../public-admission.mjs';
import { fail } from './approved-record-pins.mjs';
import { registerHeldTransportFacade } from './devnet-native-transport.mjs';
import { openKeylessInnerTransport } from './keyless-inner-transport.mjs';

// The inner transport's members the purchase flow reads, taken as they are.
const INNER_SOURCE_MEMBERS = ['pins', 'transportBinding', 'journal', 'observeBinding', 'readRpc', 'chainReader', 'isWalletIdle', 'nativeTransferClaimed',
  'nativeTransferCancelled', 'nativeTransferRefused', 'nativeNonceConsumer', 'cancelNativeTransfer'];
// The one effect member; it waits for the purchase admission and the host's stop check. Every other member is passive.
const EFFECT_MEMBER = 'cancelNativeTransfer';
const READBACK_PHASE = 'readback';

/**
 * Returns a Promise for a frozen `{sourceCapability}`: a frozen, registered Agreement transport the purchase flow takes as
 * `walletAgreement.sourceCapability`, with exactly `pins`, `transportBinding`, `journal` (the caller's), `observeBinding`, `readRpc`
 * (read-only), `chainReader`, `isWalletIdle`, `nativeTransferClaimed`, `nativeTransferCancelled`, `nativeTransferRefused`,
 * `nativeNonceConsumer`, `cancelNativeTransfer`, `binding` and `close`. `isDevnetAgreementTransport(sourceCapability)` is true.
 * It holds no key, and no member signs, confirms or broadcasts.
 *
 * Options, exactly: `{admission: {binding, currentLocal}, owner, journal, stopped, feeCeilingOs}`, checked as for
 * `createKeylessSignedRelayTransport`; the caller owns `owner` and `journal` and closes them. `binding(request)` takes only a
 * `readback`, with the lane proofs the purchase flow passes, and runs while purchase actions are held.
 * `cancelNativeTransfer` writes the payer's durable cancelled-transfer record and sends nothing; it rejects
 * OperationError(profile_not_admitted) while held or when the binding check fails or the connection changed, and
 * writes_stopped, stop_check_failed or stop_check_invalid unless `stopped()` answers `false` synchronously. `close()` closes
 * only the source's own transport; later calls reject `transport_closed`.
 *
 * Rejects at construction with TypeError(admission_required | admission_input_untrusted | keyless_relay_options_invalid |
 * keyless_relay_fee_ceiling_invalid | keyless_relay_stop_invalid | keyless_relay_owner_invalid | keyless_relay_journal_invalid) and
 * OperationError(runtime_unsupported | profile_not_admitted (cause kept) | tp1_local_binding_changed). `binding` rejects
 * OperationError(keyless_source_phase_refused) for any request but a readback, before the transport sees it.
 */
export async function createKeylessPurchaseSource(options) {
  const stopped = options?.stopped;
  const { inner, admission } = await openKeylessInnerTransport(options);
  const members = {
    ...Object.fromEntries(INNER_SOURCE_MEMBERS.map(name => [name, inner[name]])),
    async binding(request) {
      if (request?.phase !== READBACK_PHASE) fail('keyless_source_phase_refused');
      return inner.binding({ ...request, phase: READBACK_PHASE });
    },
    close: () => inner.close(),
  };
  const passive = Object.keys(members).filter(name => name !== EFFECT_MEMBER);
  // The arrow keeps an async `stopped` accepted here, as the signed relay accepts it; the stop check refuses it at use.
  const admitted = admitPublicFactory(() => members, { passive, purchase: true, hostStop: true })({ admission, stopped: () => stopped() });
  const sourceCapability = Object.freeze(Object.fromEntries(Object.entries(admitted).filter(([name]) => name !== 'actionsAdmitted')));
  registerHeldTransportFacade(sourceCapability, inner);
  return Object.freeze({ sourceCapability });
}
