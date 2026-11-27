// A keyless evidence source: the read members the native payment evidence consumer takes from a settlement source
// capability, over a caller's transport owner and durable journal. It holds no key, signs nothing, has no member that
// confirms, broadcasts, cancels or recovers a write, and loads no demosdk.
import { createHostStop } from '../host-stop.mjs';
import { createDevnetSettlementTransport, DEVNET_SETTLEMENT_POLICY, registerHeldTransportFacade } from './devnet-native-transport.mjs';
import { openKeylessInnerTransport } from './keyless-inner-transport.mjs';

// The settlement transport constructor requires a publication policy with a TEST label or a token as its authority. This
// source never publishes, so its declaration names a fixed TEST label and never a caller value.
const KEYLESS_EVIDENCE_AUTHORITY = 'TEST-keyless-evidence-read';
const KEYLESS_EVIDENCE_PUBLICATION = Object.freeze({ policy: DEVNET_SETTLEMENT_POLICY, artifactKind: 'SettlementEvidence', phase: 'pay-dem', railId: 'demos-native:DEM',
  phaseIndex: 2, authority: KEYLESS_EVIDENCE_AUTHORITY });

// The chain reader's reads the inner transport's read-only RPC admits; the reader's other members are not published.
const READER_MEMBERS = ['observeTransfer', 'observePurchaseTransfer', 'observePassiveTransfer'];

/**
 * Returns a Promise for a frozen `{evidenceSourceCapability}`: a frozen, registered settlement transport to pass to
 * `createNativePaymentEvidenceConsumer` as `sourceCapability`, with `rpcUrl` set to its `pins.endpoint`. It has exactly
 * `pins`, `transportBinding` (with a fixed SettlementEvidence publication declaration), `observeBinding`, `readRpc` (read-only),
 * `chainReader()` (a frozen reader with `observeTransfer`, `observePurchaseTransfer` and `observePassiveTransfer`) and `close`.
 * `isDevnetSettlementTransport` and `isDevnetAgreementTransport` are true for it. No member signs, confirms, broadcasts,
 * cancels or recovers a write.
 *
 * Options, exactly: `{admission: {binding, currentLocal}, owner, journal, stopped, feeCeilingOs}`, checked as for
 * `createKeylessPurchaseSource`; the caller owns `owner` and `journal` and closes them. Every node read calls `stopped()` first
 * and rejects OperationError(writes_stopped | stop_check_failed (cause kept) | stop_check_invalid) unless it answers `false`
 * synchronously. Reads run while purchase actions are held. `pins`, `transportBinding`, the `chainReader()` call and `close()`
 * do not check the stop. `close()` closes only the source's own transport; after it `readRpc`, `observeBinding` and
 * `observePassiveTransfer` reject `transport_closed`, and the reader's other two reads answer `unavailable` without a request.
 *
 * Rejects at construction with the codes of `createKeylessPurchaseSource`: TypeError(admission_required |
 * admission_input_untrusted | keyless_relay_options_invalid | keyless_relay_fee_ceiling_invalid | keyless_relay_stop_invalid |
 * keyless_relay_owner_invalid | keyless_relay_journal_invalid) and OperationError(runtime_unsupported | profile_not_admitted
 * (cause kept) | tp1_local_binding_changed).
 */
export async function createKeylessEvidenceSource(options) {
  const stopped = options?.stopped;
  const { inner } = await openKeylessInnerTransport(options, { construct: createDevnetSettlementTransport, innerOptions: { settlementPublication: KEYLESS_EVIDENCE_PUBLICATION } });
  // The arrow keeps an async `stopped` accepted here, as the purchase source accepts it; the stop check refuses it at use.
  const hostStop = createHostStop(() => stopped());
  const gated = read => (...args) => {
    try { hostStop.assert(); } catch (refused) { return Promise.reject(refused); }
    return read(...args);
  };
  const gatedReader = reader => Object.freeze(Object.fromEntries(READER_MEMBERS.map(name => [name, gated((...args) => reader[name](...args))])));
  const evidenceSourceCapability = Object.freeze({
    pins: inner.pins,
    transportBinding: inner.transportBinding,
    observeBinding: gated(inner.observeBinding),
    readRpc: gated(inner.readRpc),
    chainReader: () => gatedReader(inner.chainReader()),
    close: () => inner.close(),
  });
  registerHeldTransportFacade(evidenceSourceCapability, inner);
  return Object.freeze({ evidenceSourceCapability });
}
