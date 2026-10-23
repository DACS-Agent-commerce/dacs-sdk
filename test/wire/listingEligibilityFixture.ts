// Test-only authenticated Listing reader. Tests control the source of truth;
// production integrations must authenticate the full Listing at this boundary.
import type { ListingEligibilityReader, VerifiedListingEligibility } from "../../src/wire/index.js";

export const readFixtureListingEligibility = (scope: Parameters<ListingEligibilityReader>[0]) => ({
  seller: scope.seller, publicEndpoint: scope.publicEndpoint, listingPin: { ...scope.listingPin },
  pricingKind: "fixed", negotiation: "negotiate-fixed-price", commitPhase: "commit-payee-bound-agreement", rail: "pay-dem",
  delivery: { channel: "demos-storage", address: "dacs4:deliverable:{jobId}" }, service: { kind: "fixed-text" }, output: { envelope: "dacs-chatgpt-plugin/devnet-purchased-report", reportVersion: "1", mediaType: "text/plain; charset=utf-8", maxCharacters: 16384, synchronous: true },
  buyerRequestInput: false, notBefore: 0, expiresAt: Number.MAX_SAFE_INTEGER,
} satisfies VerifiedListingEligibility);
