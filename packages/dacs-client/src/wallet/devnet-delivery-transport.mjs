// The installed delivery-transport entry: the Deliverable publication transport, handed out only behind the held facade.
import { readAdmission } from '../public-admission.mjs';
import { createDevnetDeliveryTransport as constructDeliveryTransport } from './devnet-native-transport.mjs';
import { createHeldTransportFacade } from './node-wallet-session.mjs';

/**
 * Builds the Deliverable publication transport from `transportOptions` (the transport owner, journal, effect boundary, pins and
 * the exact `settlementPublication` and `deliveryPublication` policies) and returns only its held facade, registered so
 * `isDevnetSettlementTransport` accepts it. `admission` is `{binding, currentLocal}` of the same owner. Active members reject
 * `profile_not_admitted` while purchase actions are held; passive members keep their behaviour. Throws TypeError(admission_required
 * or admission_input_untrusted) before anything is built, and the transport's TypeError for a missing or wrong publication policy
 * or authority.
 */
export function createDevnetDeliveryTransport(options = {}) {
  readAdmission(options);
  const { admission, ...transportOptions } = options;
  return createHeldTransportFacade({ admission, transport: constructDeliveryTransport(transportOptions) });
}
