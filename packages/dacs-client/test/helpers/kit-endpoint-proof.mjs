// The buyer's endpoint proof for the kit's seller at its fixture endpoint. It loads no client source, so a world can import it
// before or after the client's admission hook.
import * as wire from '@kynesyslabs/dacs/wire';
import { seller } from '../../../dacs-seller/test/helpers/protocol-fixture.mjs';
import { FIXTURE_ENDPOINT } from '../../../dacs-seller/test/helpers/wire-buyer.mjs';

const DISCOVERY_LIFETIME_MS = 600_000;
const LISTING_WINDOW_MS = 86_400_000;

/** Verifies, under `binding` and `local` at `now`, a discovery document the kit's seller signed at `now` for `listingPin`, announcing `ready`. */
export async function kitEndpointProof({ binding, local, listingPin, ready = true, now }) {
  const listing = { seller: seller.claim, publicEndpoint: FIXTURE_ENDPOINT, listingPin };
  const document = await wire.signDiscoveryDocument({ format: wire.DACS_SELLER_DISCOVERY_FORMAT, profile: binding.profile, seller: seller.claim, publicEndpoint: FIXTURE_ENDPOINT,
    transport: [wire.DACS_SELLER_HTTP_V1], listings: [listingPin], capabilities: wire.TP1_CAPABILITIES, ready, issuedAt: now, expiresAt: now + DISCOVERY_LIFETIME_MS },
  { claim: seller.claim, sign: seller.signBytes }, binding, { ...local });
  const eligibility = () => ({ ...listing, pricingKind: 'fixed', negotiation: 'negotiate-fixed-price', commitPhase: wire.TP1_COMMIT_PHASE, rail: 'pay-dem', delivery: wire.TP1_CAPABILITIES.delivery,
    service: { kind: 'fixed-text' }, output: wire.TP1_CAPABILITIES.output, buyerRequestInput: false, notBefore: now - LISTING_WINDOW_MS, expiresAt: now + LISTING_WINDOW_MS });
  return wire.verifyEndpointProof(document, { listing, binding, local: { ...local }, now, readListingEligibility: eligibility });
}
