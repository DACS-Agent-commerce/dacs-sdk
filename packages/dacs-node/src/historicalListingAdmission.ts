import {
  isAuthenticatedRailDefinition,
  isVerifiedListingAdmission,
  validateListingArtifact,
  type AuthenticatedRailDefinition,
  type ListingValidationResult,
  type ProfileExecutionPolicy,
  type SellerListingAtCommitResolution,
} from "@kynesyslabs/dacs";
import type { Listing } from "@kynesyslabs/dacs/artifacts";
import { admitRawJson, canonicalize } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw, signedBytes } from "@kynesyslabs/dacs/crypto";
import { canonicalDemosAgentPublicKey, identityBundleHash, sameCanonicalClaimIdentity } from "@kynesyslabs/dacs/identity";

/** Actor-local evidence, written only after authenticated ordered admission. */
export interface DacsHistoricalListingAdmissionV1 {
  receivedJsonBase64: string;
  revocation: "absent";
}

export function captureDacsHistoricalListingAdmissionV1(
  listing: Readonly<Listing>,
  validation: ListingValidationResult | undefined,
): Readonly<DacsHistoricalListingAdmissionV1> {
  if (!validation ||
      validation.revocation !== "absent" ||
      !isVerifiedListingAdmission(listing as unknown as Record<string, unknown>, validation)) {
    throw new TypeError("historical Listing requires original ordered admission");
  }
  return Object.freeze({ receivedJsonBase64: validation.receivedJsonBase64, revocation: "absent" });
}

/**
 * Rebuild non-serializable reader provenance from the trusted local admission
 * journal, never from a re-rendered storage response. The journal records that
 * revocation was absent at admittedAt; current discovery state is irrelevant to
 * this historical check. Signature, identity, rail and validity are checked anew.
 */
export async function restoreDacsHistoricalListingAdmissionV1(input: Readonly<{
  admission: Readonly<DacsHistoricalListingAdmissionV1> | undefined;
  listing: Readonly<Listing>;
  admittedAt: number;
  seller: string;
  rail: Readonly<AuthenticatedRailDefinition>;
}> & ProfileExecutionPolicy): Promise<Readonly<SellerListingAtCommitResolution>> {
  const encoded = input.admission?.receivedJsonBase64;
  const key = canonicalDemosAgentPublicKey(input.seller);
  if (typeof encoded !== "string" || input.admission?.revocation !== "absent" ||
      key === null || !isAuthenticatedRailDefinition(input.rail)) {
    throw new TypeError("historical Listing admission unavailable");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new TypeError("historical Listing bytes invalid");
  const rawListing = admitRawJson(bytes) as Record<string, unknown>;
  if (canonicalize(rawListing) !== canonicalize(input.listing)) {
    throw new TypeError("historical Listing snapshot mismatch");
  }
  const verify = (message: Uint8Array, signature: string): boolean => {
    const decoded = Buffer.from(signature, "base64url");
    return decoded.length === 64 && decoded.toString("base64url") === signature &&
      ed25519Verify(message, decoded, publicKeyFromRaw(key));
  };
  const identityValid = (bundle: Listing["seller"]["identity"]) =>
    sameCanonicalClaimIdentity(bundle.presentedBy, input.seller) && bundle.claims.length === 1 &&
    sameCanonicalClaimIdentity(bundle.claims[0]?.ref, input.seller) && bundle.presentation.kind === "per-claim" &&
    bundle.presentation.signatures.length === 1 &&
    sameCanonicalClaimIdentity(bundle.presentation.signatures[0]?.ref, input.seller) &&
    verify(signedBytes("dacs-bundle-presentation:v1:", identityBundleHash(bundle)),
      bundle.presentation.signatures[0]!.signature);
  const validation = await validateListingArtifact(bytes, {
    executionMode: input.executionMode,
    nowMs: () => input.admittedAt,
    verifyListingSignature: ({ signedBytes, signature }) =>
      signature.signer === input.seller && signature.algorithm === "ed25519" &&
      verify(signedBytes, signature.value),
    revocation: {
      surfaces: [{ kind: "well-known", status: "active", integrity: "verified" }],
      readMarker: async () => { throw new Error("historical admission has no revocation marker"); },
      verifyMarkerSignature: () => false,
    },
    verifyIdentityPresentation: ({ bundle }) => identityValid(bundle),
    loadRailResolution: () => ({
      trustPhase: "PA-2",
      registry: {
        state: "verified-finalized",
        entries: [{ railId: input.rail.railId, latestVersion: input.rail.railVersion,
          versions: [input.rail.railVersion] }],
        definitions: [{ railId: input.rail.railId, railVersion: input.rail.railVersion,
          phaseHandler: input.rail.phaseHandler, state: "verified-finalized" }],
      },
    }),
    verifySellerControl: ({ bundle, signer }) => signer === input.seller && identityValid(bundle),
  });
  if (!isVerifiedListingAdmission(rawListing, validation)) {
    throw new TypeError("historical Listing re-admission failed");
  }
  return { rawListing, validation };
}
