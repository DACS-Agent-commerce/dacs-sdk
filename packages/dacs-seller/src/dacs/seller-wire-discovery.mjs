// The seller's signed discovery document: the first thing a buyer fetches, and the source of the endpoint proof it signs requests under.
import { DACS_SELLER_DISCOVERY_FORMAT, DACS_SELLER_HTTP_V1, TP1_CAPABILITIES, WireError, signDiscoveryDocument } from '@kynesyslabs/dacs/wire';
import { SellerTransportError } from './seller-transport-auth.mjs';

// How long a buyer may keep one document. Each request signs a fresh one, so this only bounds a buyer's cache.
const DISCOVERY_LIFETIME_MS = 5 * 60 * 1000;

/**
 * Signs a discovery document for the wire context's seller: its bound profile, public endpoint, the one Listing it serves
 * (`listingPin`), the wire's capabilities and its readiness at this moment. The signature comes from the key's read-only
 * discovery role, which signs a `ready: true` document only while the kit operation guard admits.
 * Returns the exact bytes to serve. Throws the wire's own refusal (`discovery_invalid` 500 for an endpoint that is not an
 * HTTPS origin, a refused binding or authority), or SellerTransportError `discovery_unavailable` 503 carrying the role's
 * refusal or the reader's failure as its cause.
 */
export async function signedDiscovery(wire, listingPin) {
  const issuedAt = wire.now();
  const payload = { format: DACS_SELLER_DISCOVERY_FORMAT, profile: wire.binding.profile, seller: wire.signer.claim, publicEndpoint: wire.publicEndpoint,
    transport: [DACS_SELLER_HTTP_V1], listings: [listingPin], capabilities: TP1_CAPABILITIES, ready: wire.ready(), issuedAt, expiresAt: issuedAt + DISCOVERY_LIFETIME_MS };
  try {
    return await signDiscoveryDocument(payload, await wire.readSigner('discovery'), wire.binding, wire.local());
  } catch (error) {
    if (error instanceof WireError) throw error;
    throw new SellerTransportError('discovery_unavailable', 503, { cause: error });
  }
}
