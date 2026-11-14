// Unshipped test helper: a buyer that signs with the wire's `signWireRequest` against a seller-signed fixture
// discovery document, and the `authentication` adapter `createSellerAgentClient` takes. Its `verifyResponse`
// returns the Promise from `verifyWireResponse` over the exact received bytes.
import { DACS_SELLER_DISCOVERY_FORMAT, DACS_SELLER_HTTP_V1, TP1_APPROVED_IDENTITY_RECORD, TP1_CAPABILITIES, TP1_COMMIT_PHASE, bindTp1Profile, signDiscoveryDocument, signWireRequest, verifyEndpointProof, verifyWireResponse } from '@kynesyslabs/dacs/wire';
import { WIRE_ROUTE_PATHS } from '../../src/dacs/seller-wire-requests.mjs';
import { TEST_CONNECTION, authorityReader } from './wire-authority-fixture.mjs';

export const FIXTURE_ENDPOINT = 'https://seller.example.invalid';
const DISCOVERY_LIFETIME_MS = 600_000;
const LISTING_WINDOW_MS = 86_400_000;
const REQUEST_LIFETIME_MS = 30_000;

const eligibilityFor = (listing, now) => () => ({
  ...listing, pricingKind: 'fixed', negotiation: 'negotiate-fixed-price', commitPhase: TP1_COMMIT_PHASE, rail: 'pay-dem', delivery: TP1_CAPABILITIES.delivery,
  service: { kind: 'fixed-text' }, output: TP1_CAPABILITIES.output, buyerRequestInput: false, notBefore: now - LISTING_WINDOW_MS, expiresAt: now + LISTING_WINDOW_MS,
});

/**
 * One binding over the fixture authority, the seller's signed discovery document, and the buyer's endpoint proof of it.
 * `buyer` and `seller` are `{ claim, sign }` signers; `clock()` is the buyer's and seller's shared test time.
 */
export async function wireBuyer({ buyer, seller, listingPin, clock, connection = () => ({ ...TEST_CONNECTION }), readAuthority = authorityReader(), evidenceFor = async () => ({}), readCommitmentReceipt, publicEndpoint = FIXTURE_ENDPOINT, discoveryLifetimeMs = DISCOVERY_LIFETIME_MS }) {
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: connection(), readAuthority });
  const now = clock();
  const payload = { format: DACS_SELLER_DISCOVERY_FORMAT, profile: binding.profile, seller: seller.claim, publicEndpoint, transport: [DACS_SELLER_HTTP_V1],
    listings: [listingPin], capabilities: TP1_CAPABILITIES, ready: true, issuedAt: now, expiresAt: now + discoveryLifetimeMs };
  const document = await signDiscoveryDocument(payload, seller, binding, connection());
  const listing = { seller: seller.claim, publicEndpoint, listingPin };
  const endpointProof = await verifyEndpointProof(document, { listing, binding, local: connection(), now, readListingEligibility: eligibilityFor(listing, now), readCommitmentReceipt });

  /** A signed request for `path`: `{ payload, header, text }`. `agreementHash` is the buyer's own view of the Agreement. */
  const signRequest = async (path, body, { jobId, agreementHash, nonce, lifetimeMs = REQUEST_LIFETIME_MS, delegation = null, signer = buyer, text = JSON.stringify(body) } = {}) => {
    const { payload, header } = await signWireRequest({ signer, binding, local: connection(), endpointProof, publicEndpoint, path, jobId, text, seller: seller.claim,
      job: { listingPin, agreementHash, profile: binding.profile }, ...await evidenceFor(path, jobId), delegation, now: clock(), lifetimeMs, ...(nonce === undefined ? {} : { nonce }) });
    return { payload, header, text };
  };
  /** The `authentication` adapter of `createSellerAgentClient`: `jobFor(jobId)` supplies the buyer's Agreement hash. */
  const authentication = (jobFor) => ({
    request: async (path, body, text) => {
      const jobId = body.transportIdentity?.jobId ?? body.jobId;
      const { payload, header } = await signRequest(path, body, { jobId, agreementHash: jobFor(jobId), text });
      return { payload, header };
    },
    verifyResponse: (request, { header, status, responseBytes }) => verifyWireResponse(request, { header, status, body: responseBytes, now: clock(), binding, local: connection() }),
  });
  /** The buyer's endpoint proof of discovery bytes a seller served. Rejects with the wire's refusal. */
  const verifyDiscovery = (bytes) => verifyEndpointProof(bytes, { listing, binding, local: connection(), now: clock(), readListingEligibility: eligibilityFor(listing, clock()), readCommitmentReceipt });
  return { binding, connection, endpointProof, signRequest, authentication, verifyDiscovery };
}

/**
 * The `authentication` adapter for a client of a running host: the buyer is built on first use. `options` are `wireBuyer`'s,
 * and `jobFor(jobId)` gives the buyer's Agreement hash for the job.
 */
export function wireAuthentication(options, jobFor) {
  let built = null;
  const adapter = () => (built ??= wireBuyer(options).then((buyer) => buyer.authentication(jobFor)));
  return { request: async (...args) => (await adapter()).request(...args), verifyResponse: async (...args) => (await adapter()).verifyResponse(...args) };
}

/**
 * The `authentication` adapter for a client of a host that still has routes on the old auth: the routes on the wire are signed and
 * verified by the wire buyer (`options`, `jobFor` as for `wireAuthentication`), every other route by `old`, a
 * `createSellerTransportClientAuth`.
 */
export function mixedAuthentication(options, jobFor, old) {
  const wire = wireAuthentication(options, jobFor);
  const wired = new WeakSet();
  return {
    request: async (path, body, text) => {
      const signed = await (WIRE_ROUTE_PATHS.includes(path) ? wire : old).request(path, body, text);
      if (WIRE_ROUTE_PATHS.includes(path)) wired.add(signed.payload);
      return signed;
    },
    verifyResponse: (request, received) => (wired.has(request) ? wire : old).verifyResponse(request, received),
  };
}
