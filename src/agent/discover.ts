import { types as nodeTypes } from "node:util";

import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { verifyComponentSignature } from "../artifacts/signatures.js";
import type {
  LegacyMvpListing,
  Listing,
  ReadableListing,
} from "../artifacts/types.js";
import { readListingArtifact } from "../artifacts/validators.js";
import { snapshotCanonicalJson } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { verifySignedArtifact, type Verifier } from "./signedArtifact.js";
import type { ListingValidationResult } from "./listingValidation.js";
import { contentHash } from "../canonical/index.js";

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
  /**
   * DACS-1 §6.3.4 ordered reader result. Required for normative Listings;
   * discovery returns only exact-hash `verified` records.
   */
  validateListing?: (
    raw: Record<string, unknown>,
  ) => Promise<ListingValidationResult> | ListingValidationResult;
}

export type DiscoveredListing =
  | { ref: string; compatibility: "normative"; listing: Listing }
  | { ref: string; compatibility: "legacy-mvp"; listing: LegacyMvpListing };

type CapturedDiscoverDeps = Readonly<{
  verify: DiscoverDeps["verify"];
  resolvePublicKey: DiscoverDeps["resolvePublicKey"];
  trustListings: DiscoverDeps["trustListings"];
  nowMs: DiscoverDeps["nowMs"];
}>;

function dataProperty(
  deps: DiscoverDeps,
  key: keyof DiscoverDeps,
): unknown {
  if (
    deps === null ||
    typeof deps !== "object" ||
    nodeTypes.isProxy(deps)
  ) {
    throw new DacsError("Listing verification dependencies must be stable data");
  }
  let owner: object | null = deps;
  try {
    while (owner !== null) {
      if (nodeTypes.isProxy(owner)) throw new TypeError("proxy prototype");
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (descriptor) {
        if (!("value" in descriptor)) throw new TypeError("accessor dependency");
        return descriptor.value;
      }
      owner = Object.getPrototypeOf(owner);
    }
  } catch (cause) {
    throw new DacsError(
      `Listing verification dependency ${String(key)} must be stable data`,
      { cause },
    );
  }
  return undefined;
}

function optionalDataMethod<K extends keyof DiscoverDeps>(
  deps: DiscoverDeps,
  key: K,
): DiscoverDeps[K] {
  const candidate = dataProperty(deps, key);
  if (candidate === undefined) return undefined as DiscoverDeps[K];
  if (typeof candidate !== "function" || nodeTypes.isProxy(candidate)) {
    throw new DacsError(
      `Listing verification dependency ${String(key)} must be a stable data method`,
    );
  }
  return Function.prototype.bind.call(candidate, deps) as DiscoverDeps[K];
}

/** Capture and validate callback identities before inspecting a Listing. */
function captureDiscoverDeps(deps: DiscoverDeps): CapturedDiscoverDeps {
  const trustListings = dataProperty(deps, "trustListings");
  if (trustListings !== undefined && typeof trustListings !== "boolean") {
    throw new DacsError("trustListings must be a boolean when provided");
  }
  return Object.freeze({
    verify: optionalDataMethod(deps, "verify"),
    resolvePublicKey: optionalDataMethod(deps, "resolvePublicKey"),
    trustListings,
    nowMs: optionalDataMethod(deps, "nowMs"),
  });
}

/**
 * Own the resolver value before validation or any await. A Listing is an
 * authenticated JSON artifact; the canonical wire round-trip rejects live
 * views and severs every nested alias retained by the resolver.
 */
function snapshotListingArtifact(
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  try {
    const snapshot = snapshotCanonicalJson(raw, "Listing artifact") as unknown;
    return snapshot !== null &&
      typeof snapshot === "object" &&
      !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The intrinsic Demos claim→key resolution: a CCI *is* the ed25519 pubkey hex. */
function intrinsicKey(claim: string): Uint8Array | null {
  const hex = claim.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
}

/**
 * Authenticate a structurally valid Listing without applying its admission
 * clock. Recovery uses this narrower gate only after runSessionCore proves an
 * exact, cryptographically authenticated Agreement and successful payment for
 * the requested job. Discovery uses verifyReadableListingArtifact below;
 * runSessionCore retains the DACS-1 §6.3.4 fresh-admission clock policy.
 */
async function authenticateListingSnapshot(
  raw: Record<string, unknown>,
  deps: CapturedDiscoverDeps,
): Promise<ReadableListing | null> {
  const readable = readListingArtifact(raw);
  if (!readable) return null;
  if (!deps.verify && !deps.trustListings) {
    throw new DacsError(
      "Listing verification requires deps.verify or explicit trustListings: true",
    );
  }
  if (readable.compatibility === "normative") {
    // DACS-1 permits a Listing signer to be any claim carried by the seller's
    // IdentityBundle. Until this SDK verifies the complete §6.3.2 presentation,
    // however, claim membership alone cannot prove control of `presentedBy`.
    // The current producer profile signs with `presentedBy`, so readers enforce
    // that same fail-closed profile before exposing a Listing that can steer the
    // downstream payee. `isListing` remains the normative structural predicate.
    if (
      readable.listing.signature.signer !==
      readable.listing.seller.identity.presentedBy
    ) {
      return null;
    }
  }
  if (!deps.verify) return readable;

  const resolveKey = deps.resolvePublicKey ?? intrinsicKey;
  if (readable.compatibility === "legacy-mvp") {
    try {
      const resolved = await resolveKey(readable.listing.agentId);
      if (!(resolved instanceof Uint8Array) || resolved.length !== 32) return null;
      const key = Uint8Array.from(resolved);
      const valid = await verifySignedArtifact(
        raw,
        ARTIFACT_SEPARATORS.Listing,
        key,
        deps.verify,
      );
      return valid === true ? readable : null;
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
        const resolved = await resolveKey(signature.signer);
        return resolved instanceof Uint8Array && resolved.length === 32
          ? Uint8Array.from(resolved)
          : null;
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

export async function authenticateReadableListingArtifact(
  raw: Record<string, unknown>,
  deps: DiscoverDeps,
): Promise<ReadableListing | null> {
  const capturedDeps = captureDiscoverDeps(deps);
  const snapshot = snapshotListingArtifact(raw);
  return snapshot
    ? authenticateListingSnapshot(snapshot, capturedDeps)
    : null;
}

/**
 * DACS-1 §6.3.4 discovery/fresh-admission gate with an explicit historical
 * read arm. It applies the reader validity step, then authenticates the exact
 * artifact before returning it.
 */
export async function verifyReadableListingArtifact(
  raw: Record<string, unknown>,
  deps: DiscoverDeps,
): Promise<ReadableListing | null> {
  const capturedDeps = captureDiscoverDeps(deps);
  if (!capturedDeps.verify && !capturedDeps.trustListings) {
    throw new DacsError(
      "Listing verification requires deps.verify or explicit trustListings: true",
    );
  }
  const snapshot = snapshotListingArtifact(raw);
  if (!snapshot) return null;
  const readable = readListingArtifact(snapshot);
  if (!readable) return null;
  if (readable.compatibility === "normative") {
    const now = capturedDeps.nowMs?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new DacsError("Listing verification clock must return unix-ms safe integer data");
    }
    const validity = readable.listing.validity;
    if (
      now < validity.notBefore ||
      (validity.notAfter !== undefined && now > validity.notAfter)
    ) {
      return null;
    }
  }
  return authenticateListingSnapshot(snapshot, capturedDeps);
}

export async function discoverListings(
  listingRefs: string[],
  readAnchor: (ref: string) => Promise<Record<string, unknown> | null>,
  deps: DiscoverDeps = {},
): Promise<DiscoveredListing[]> {
  const capturedDeps = captureDiscoverDeps(deps);
  if (!capturedDeps.verify && !capturedDeps.trustListings) {
    throw new DacsError(
      "discoverListings requires deps.verify or an explicit deps.trustListings: true opt-out — " +
        "returning unverified listings lets a forged listing drive negotiation and payment (#41)",
    );
  }
  if (typeof readAnchor !== "function" || nodeTypes.isProxy(readAnchor)) {
    throw new DacsError("discoverListings readAnchor must be a stable function");
  }
  const refs = snapshotCanonicalJson(listingRefs, "Listing refs");
  if (
    !Array.isArray(refs) ||
    refs.some(
      (ref) =>
        typeof ref !== "string" || ref.length === 0 || ref.trim() !== ref,
    )
  ) {
    throw new DacsError("discoverListings requires non-empty canonical Listing refs");
  }
  const found: DiscoveredListing[] = [];
  for (const ref of refs) {
    const raw = await readAnchor(ref);
    if (!raw) continue;
    const readable = await verifyReadableListingArtifact(raw, capturedDeps);
    if (!readable) continue;
    if (readable.compatibility === "normative") {
      if (!deps.validateListing) {
        throw new DacsError(
          "discoverListings requires deps.validateListing for normative DACS-1 " +
            "Listings; signature validity alone is not a verified disposition",
        );
      }
      let validation: ListingValidationResult;
      try {
        validation = await deps.validateListing(raw);
      } catch {
        continue;
      }
      if (
        validation.disposition !== "verified" ||
        validation.listingContentHash !== contentHash(raw)
      ) {
        continue;
      }
    }
    found.push({ ref, ...readable });
  }
  return found;
}
