import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { verifyComponentSignature } from "../artifacts/signatures.js";
import type {
  LegacyMvpListing,
  Listing,
  ReadableListing,
} from "../artifacts/types.js";
import { readListingArtifact } from "../artifacts/validators.js";
import { DacsError } from "../errors.js";
import { verifySignedArtifact, type Verifier } from "./signedArtifact.js";

/**
 * Resolve, structurally validate, and VERIFY anchored listings at the given refs
 * (the core of Agent.discover). Refs are caller-supplied — a marketplace crawl
 * needs an indexer the deterministic substrate doesn't provide.
 *
 * Signature verification is load-bearing (#41): a listing drives negotiation,
 * vetting, rail/recipient selection and ultimately payment, so a forged or
 * tampered listing that reaches discovery output can steer real money. Every
 * listing is therefore verified before it is returned, and anything that fails
 * is SKIPPED rather than surfaced.
 *
 * SIGNER↔SELLER BINDING is intrinsic: a Demos primary claim *is* the signer's
 * ed25519 public key, so we verify against the key embedded in the listing's own
 * `agentId`. A signature that verifies therefore proves the advertised seller
 * signed this exact content — there is no separate signer field to trust, and a
 * valid signature lifted from another seller's listing fails.
 *
 * Fails CLOSED: a missing, malformed, wrong-key or tampered signature drops the
 * listing. A seller claim that doesn't embed a resolvable key is also dropped
 * (we cannot establish who signed it). The gate is REQUIRED — pass `verify`, or
 * set `trustListings: true` to opt out explicitly when listings were verified
 * upstream. Neither → throws, because silently returning unverified listings is
 * the fail-open trap this exists to close.
 */

export interface DiscoverDeps {
  /** Verify a signature over raw bytes for a public key. */
  verify?: Verifier;
  /**
   * Resolve a seller claim to its ed25519 public key. Defaults to the intrinsic
   * Demos form — a claim embedding a 64-hex key (`did:…:<hex>`, `0x<hex>`, bare
   * `<hex>`). Return null for a claim whose key can't be established.
   */
  resolvePublicKey?: (claim: string) => Promise<Uint8Array | null> | Uint8Array | null;
  /**
   * Explicit, grep-able opt-out of verification. Only for callers that already
   * verified the listings. Ignored when `verify` is supplied.
   */
  trustListings?: boolean;
  /** DACS-1 §6.3.4 reader step 3 clock; defaults to Date.now(). */
  nowMs?: () => number;
}

export type DiscoveredListing =
  | { ref: string; compatibility: "normative"; listing: Listing }
  | { ref: string; compatibility: "legacy-mvp"; listing: LegacyMvpListing };

/** The intrinsic Demos claim→key resolution: a CCI *is* the ed25519 pubkey hex. */
function intrinsicKey(claim: string): Uint8Array | null {
  const hex = claim.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
}

/**
 * DACS-1 §6.3.4 signature gate with an explicit historical read arm. New
 * normative Listings use ListingSignature; the legacy string signature is
 * accepted only for already-anchored MVP artifacts (#41 compatibility policy).
 */
export async function verifyReadableListingArtifact(
  raw: Record<string, unknown>,
  deps: DiscoverDeps,
): Promise<ReadableListing | null> {
  const readable = readListingArtifact(raw);
  if (!readable) return null;
  if (!deps.verify && !deps.trustListings) {
    throw new DacsError(
      "Listing verification requires deps.verify or explicit trustListings: true",
    );
  }
  if (readable.compatibility === "normative") {
    const now = deps.nowMs?.() ?? Date.now();
    const validity = readable.listing.validity;
    if (
      now < validity.notBefore ||
      (validity.notAfter !== undefined && now > validity.notAfter)
    ) {
      return null;
    }
  }
  if (!deps.verify) return readable;

  const resolveKey = deps.resolvePublicKey ?? intrinsicKey;
  if (readable.compatibility === "legacy-mvp") {
    try {
      const key = await resolveKey(readable.listing.agentId);
      if (!key || key.length !== 32) return null;
      const valid = await verifySignedArtifact(
        raw,
        ARTIFACT_SEPARATORS.Listing,
        key,
        deps.verify,
      );
      return valid ? readable : null;
    } catch {
      return null;
    }
  }

  // This SDK currently has only an Ed25519 key resolver/verifier. CORE §B.7
  // SIG-2 requires algorithm-specific verification; never reinterpret an
  // ecdsa-secp256k1 or sr1-aggregate envelope as Ed25519.
  if (readable.listing.signature.algorithm !== "ed25519") return null;

  const verdict = await verifyComponentSignature(
    raw,
    ARTIFACT_SEPARATORS.Listing,
    {
      // DACS-1 §6.3.4: signer MUST occur in seller.identity.claims.
      isSignerAuthorized: (_artifact, signature) =>
        readable.listing.seller.identity.claims.some(
          (claim) => claim.ref === signature.signer,
        ),
      resolvePublicKey: async (signature) => {
        const key = await resolveKey(signature.signer);
        return key && key.length === 32 ? key : null;
      },
      verify: ({ signedBytes, signature, publicKey }) => {
        const bytes = Uint8Array.from(
          Buffer.from(signature.value, "base64url"),
        );
        return bytes.length === 64
          ? deps.verify!(signedBytes, bytes, publicKey)
          : false;
      },
    },
  );
  return verdict.status === "valid" ? readable : null;
}

export async function discoverListings(
  listingRefs: string[],
  readAnchor: (ref: string) => Promise<Record<string, unknown> | null>,
  deps: DiscoverDeps = {},
): Promise<DiscoveredListing[]> {
  if (!deps.verify && !deps.trustListings) {
    throw new DacsError(
      "discoverListings requires deps.verify or an explicit deps.trustListings: true opt-out — " +
        "returning unverified listings lets a forged listing drive negotiation and payment (#41)",
    );
  }
  const found: DiscoveredListing[] = [];
  for (const ref of listingRefs) {
    const raw = await readAnchor(ref);
    if (!raw) continue;
    const readable = await verifyReadableListingArtifact(raw, deps);
    if (!readable) continue;
    found.push({ ref, ...readable });
  }
  return found;
}
