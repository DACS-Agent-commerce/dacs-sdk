// Standard validation of a signed Listing and the catalog freshness check.
// Nothing here builds, signs or admits a purchase; purchase support stays in
// ./listing.mjs. Contract: the DACS-1 Listing reader and CORE SIG-1.
import { ed25519Verify, publicKeyFromRaw, validateListingArtifact } from '@kynesyslabs/dacs/listing/read-only';
import { normalizeCatalogObservedAt } from './directory.mjs';

/** The one payment rail the client reads: native DEM, version 1. */
export const DEM_RAIL = Object.freeze({ railId: 'demos-native:DEM', railVersion: 1 });

const DID_PREFIX = 'did:demos:agent:';
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** True only for a valid Ed25519 ComponentSignature by its did:demos:agent signer over `signedBytes`; malformed input returns false. */
export function verifyComponent({ signedBytes: bytes, signature }) {
  if (signature?.algorithm !== 'ed25519' || typeof signature.value !== 'string' || !signature.signer?.startsWith(DID_PREFIX)) return false;
  try {
    const raw = Buffer.from(signature.signer.slice(DID_PREFIX.length), 'hex');
    if (raw.length !== 32) return false;
    return ed25519Verify(bytes, Buffer.from(signature.value, 'base64url'), publicKeyFromRaw(raw));
  } catch {
    return false;
  }
}

/** Returns `{ observedAt, fresh }`; fresh only when present, not future and at most 24 hours before `checkedAt`. */
export function checkCatalogObservation(value, checkedAt) {
  const observedAt = normalizeCatalogObservedAt(value);
  const fresh = observedAt !== undefined && observedAt <= checkedAt && checkedAt - observedAt <= CATALOG_MAX_AGE_MS;
  return { observedAt, fresh };
}

/**
 * Resolves to the SDK's ordered DACS-1 Listing verdict. A missing or stale
 * catalog observation in the caller's revocation surfaces is `indeterminate`.
 */
export async function validateListing(listing, { now, revocationSurfaces, readMarker }) {
  return validateListingArtifact(listing, {
    nowMs: () => now(),
    verifyListingSignature: verifyComponent,
    verifyIdentityPresentation: ({ bundle, signedBytes: bytes }) => {
      const proof = bundle.presentation?.kind === 'per-claim' && bundle.presentation.signatures.find((entry) => entry.ref === bundle.presentedBy);
      return Boolean(proof && verifyComponent({ signedBytes: bytes, signature: { algorithm: 'ed25519', signer: bundle.presentedBy, value: proof.signature } }));
    },
    verifySellerControl: ({ bundle, signer }) => bundle.presentedBy === signer && bundle.claims.some((claim) => claim.ref === signer),
    revocation: { surfaces: revocationSurfaces, readMarker, verifyMarkerSignature: verifyComponent },
    loadRailResolution: () => ({
      trustPhase: 'PA-1',
      trustPolicyAcceptsPA1: true,
      registry: { state: 'not-used', entries: [], definitions: [] },
      inCodeDefinitions: [{ railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion, phaseHandler: 'pay-dem', governanceAnchoring: 'in-code', signatureValid: true, availability: 'disabled' }],
    }),
  });
}
