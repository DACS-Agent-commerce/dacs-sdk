/**
 * DACS-5 §10.4.1/§10.4.2 — two-sided co-signed AttestationBundle production.
 *
 * Both parties co-sign ONE canonical content; each anchors its own copy, marked with its
 * own `anchoredByRole`. The copies are canonically EQUAL in the happy path because
 * `anchoredByRole` is excluded from the hashed scope alongside `signatures` (§10.4.1) —
 * a recognised, specified omission, integrity-checked against the anchor address (§10.4.2)
 * rather than by the signature.
 *
 * Why this module owns the omission set: `canonical/hash.ts` strips only
 * `signature`/`signatures`, so `contentHash()` — and therefore `signArtifact()` — computes
 * the WRONG scope for a bundle: it leaves `anchoredByRole` in. Every producer that hand-deletes
 * the field at its own call site duplicates that knowledge and can drift. `BUNDLE_SIGNED_SCOPE_OMIT`
 * below is the single source; signer and verifier MUST both go through it or signatures will not
 * round-trip across the two copies.
 */
import type { KeyObject } from "node:crypto";

import { canonicalize } from "../canonical/jcs.js";
import { sha256Hex } from "../canonical/hash.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import { ed25519Sign, privateKeyFromSeed } from "../crypto/ed25519.js";
import { signedBytes } from "../crypto/signing.js";
import { DacsError } from "../errors.js";
import type { AttestationBundle, BundleParty, BundleSignature } from "../artifacts/types.js";

/**
 * The bundle's hash-excluded fields (§10.4.1). SINGLE SOURCE — a producer and a verifier that
 * disagree on this set produce signatures that do not verify.
 */
export const BUNDLE_SIGNED_SCOPE_OMIT = Object.freeze(["signatures", "anchoredByRole"] as const);

/**
 * The ONLY outcomes a single-signed bundle may carry (§10.4.1): "A bundle whose outcome is
 * `aborted-by-self` or `aborted-by-other` MAY carry a single signature".
 *
 * This is an ALLOWLIST on purpose. The inverse — a denylist of outcomes that require both
 * signatures — fails OPEN: any outcome not on the list (a typo, an outcome added by a future
 * minor version) silently yields a single-signed bundle, which is precisely the artifact
 * §10.4.1 orders consumers to drop. The spec's own structure is an allowlist; mirror it.
 */
const SINGLE_SIGNATURE_PERMITTED = new Set<string>(["aborted-by-self", "aborted-by-other"]);

/**
 * The CLOSED set of bundle outcomes (§10.4.1, the `outcome` field of the AttestationBundle type).
 * An outcome outside this set is not a DACS-5 bundle at all, however many signatures it carries —
 * so it is rejected at construction, not merely when a signature is missing.
 */
export const BUNDLE_OUTCOMES = Object.freeze([
  "completed",
  "failed-perm",
  "failed-counterparty",
  "failed-substrate",
  "aborted-by-self",
  "aborted-by-other",
] as const);

export type BundleOutcome = (typeof BUNDLE_OUTCOMES)[number];

/** The roles that can anchor a copy of a bundle (§10.4.2). */
export type BundleRole = "buyer" | "seller" | "orchestrator";

type SessionSigner = Uint8Array | KeyObject | ((bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array);

/** The §B.2 canonical form of a bundle: the document minus `signatures` and `anchoredByRole`. */
export function bundleSignedScope(bundle: AttestationBundle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bundle)) {
    if (!(BUNDLE_SIGNED_SCOPE_OMIT as readonly string[]).includes(k)) out[k] = v;
  }
  return out;
}

/**
 * `attestation_bundle_hash` (§10.4.1): sha256 of the JCS canonical form of the signed scope.
 * Distinct from `BundleParty.bundleHash`, which hashes a party's IdentityBundle.
 */
export function attestationBundleHash(bundle: AttestationBundle): string {
  return sha256Hex(canonicalize(bundleSignedScope(bundle)));
}

/** A party to the session, with whatever can sign on its behalf. */
export interface SessionParty {
  primaryClaim: string;
  /**
   * §10.4.1 `SessionParty.bundleHash`: "sha256 of the verified IdentityBundle". It is NOT a hash
   * of the agent id, and NOT the `attestation_bundle_hash`.
   *
   * Caller-supplied on purpose — this module cannot verify an IdentityBundle, and inventing a
   * value here would bake a wrong one into every bundle. NOTE for whoever wires this up:
   * `runSessionCore.ts:387` currently passes `sha256Hex(deps.buyerId)`, which is a hash of the
   * agent id, not of an IdentityBundle. That is a conformance gap in the caller, and it survives
   * this constructor because a 64-hex string is indistinguishable from the right one.
   */
  bundleHash: string;
  /** A 32-byte Ed25519 seed, a prepared KeyObject, or a remote signing function. */
  signer?: SessionSigner;
}

export interface SigningSessionParty extends SessionParty {
  signer: SessionSigner;
}

/** The facts of one completed (or aborted) session, from which both copies are derived. */
export interface TwoSidedSession {
  jobId: string;
  /**
   * The closed set (§10.4.1). Typed for TS callers; the runtime guard in `buildTwoSidedBundle`
   * still fires, because a JS caller or an `as any` erases the type and the spec's constraint is
   * on the artifact, not on the type system.
   */
  outcome: BundleOutcome;
  listingRef: AttestationBundle["listingRef"];
  agreementRef: AttestationBundle["agreementRef"];
  phaseSummary: AttestationBundle["phaseSummary"];
  vetRecords: AttestationBundle["vetRecords"];
  settlementEvidence: AttestationBundle["settlementEvidence"];
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  finalisedAt: number;
  buyer: SigningSessionParty;
  /**
   * The seller identity is required even for a single-signed abort bundle. §10.4.1 permits an
   * abort bundle to miss the seller signature, not to erase the seller from `parties[]`.
   */
  seller: SessionParty;
  /**
   * The orchestrator, when it is a party DISTINCT from buyer and seller. §10.4.1: "If the
   * orchestrator is a distinct party (not buyer or seller), the orchestrator signature is also
   * REQUIRED." Omit it for the ordinary two-party session, where no third signature is required.
   */
  orchestrator?: SigningSessionParty;
  bundleVersion?: "1";
}

export interface TwoSidedBundles {
  buyerCopy: AttestationBundle;
  sellerCopy?: AttestationBundle;
  orchestratorCopy?: AttestationBundle;
}

/** Party identity is the primary claim (§10.4.1 `parties[].primaryClaim` = `bundle.presentedBy`). */
function sameParty(a: SessionParty, b: SessionParty): boolean {
  return a.primaryClaim === b.primaryClaim;
}

function canSign(party: SessionParty): party is SigningSessionParty {
  return party.signer !== undefined;
}

async function signOver(party: SigningSessionParty, hash: string): Promise<BundleSignature> {
  const payload = signedBytes(ARTIFACT_SEPARATORS.AttestationBundle, hash);
  const raw =
    typeof party.signer === "function"
      ? await party.signer(payload)
      : ed25519Sign(
          payload,
          party.signer instanceof Uint8Array ? privateKeyFromSeed(party.signer) : party.signer,
        );
  return {
    party: party.primaryClaim,
    algorithm: "ed25519",
    value: Buffer.from(raw).toString("base64url"),
  };
}

/**
 * Build the two anchored copies of a session's AttestationBundle.
 *
 * Both copies carry both parties and both signatures over one identical canonical content; they
 * differ only in the unhashed `anchoredByRole`. Each copy is anchored by its named role
 * (§10.4.2), and a consumer rejects any copy whose `anchoredByRole` disagrees with the address it
 * came from.
 *
 * A single-signed bundle is valid ONLY for an abort outcome (§10.4.1): a single-signed
 * `completed`/`failed-*` MUST be dropped by every consumer, so this refuses to produce one.
 */
export async function buildTwoSidedBundle(
  session: TwoSidedSession,
): Promise<TwoSidedBundles> {
  const { buyer, seller, outcome } = session;

  // Gate 1 — the outcome is in the spec's CLOSED set. Without this, a plausible-looking but
  // non-existent outcome (`failed-buyer`, a typo, a future version's) rides through as a fully
  // co-signed bundle: every signature verifies, and the artifact is still not a DACS-5 bundle.
  // The missing-seller guard below cannot catch that, because nothing is missing.
  if (!(BUNDLE_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new DacsError(
      `outcome "${outcome}" is not a DACS-5 bundle outcome (§10.4.1). ` +
        `Expected one of: ${BUNDLE_OUTCOMES.join(", ")}.`,
    );
  }

  if (!session.agreementRef) {
    throw new DacsError(
      "agreementRef is required for a DACS-5 AttestationBundle: the builder refuses to sign " +
        "an artifact that is not accepted by the bundle validator.",
    );
  }

  if (session.bundleVersion !== undefined && session.bundleVersion !== "1") {
    throw new DacsError(
      `bundleVersion "${session.bundleVersion}" is not supported by this v1 bundle signer. ` +
        "Use bundleVersion \"1\" or omit it.",
    );
  }

  if (!seller) {
    throw new DacsError(
      `outcome "${outcome}" requires the seller party in parties[] (§10.4.1): a ` +
        "single-signed abort bundle may omit the seller signature, but not the seller identity.",
    );
  }

  // Gate 2 — §10.4.1: the orchestrator signature is REQUIRED only when the orchestrator is a
  // "distinct party (not buyer or seller)". When the orchestrator IS the buyer or the seller, it
  // is already a party and already a signer; adding it again produces a duplicate signature and a
  // phantom third role. Not distinct means not a separate party — so drop it.
  const orchestrator =
    session.orchestrator &&
    !sameParty(session.orchestrator, buyer) &&
    !(seller && sameParty(session.orchestrator, seller))
      ? session.orchestrator
      : undefined;

  const sellerSigner = canSign(seller) ? seller : undefined;
  if (!sellerSigner && !SINGLE_SIGNATURE_PERMITTED.has(outcome)) {
    throw new DacsError(
      `outcome "${outcome}" requires the seller's signature (§10.4.1): a bundle missing a ` +
        `required signature MUST be rejected by consumers. Only ${[...SINGLE_SIGNATURE_PERMITTED]
          .map((o) => `"${o}"`)
          .join(" or ")} may be single-signed.`,
    );
  }

  const parties: BundleParty[] = [
    { role: "buyer", bundleHash: buyer.bundleHash, primaryClaim: buyer.primaryClaim },
    { role: "seller", bundleHash: seller.bundleHash, primaryClaim: seller.primaryClaim },
    ...(orchestrator
      ? [
          {
            role: "orchestrator",
            bundleHash: orchestrator.bundleHash,
            primaryClaim: orchestrator.primaryClaim,
          },
        ]
      : []),
  ];

  // The shared body — identical for both copies. `anchoredByRole` is stamped per copy afterwards
  // and is outside the hashed scope, so it cannot change the hash or invalidate a signature.
  const body = {
    bundleVersion: session.bundleVersion ?? "1",
    jobId: session.jobId,
    outcome,
    listingRef: session.listingRef,
    agreementRef: session.agreementRef,
    parties,
    phaseSummary: session.phaseSummary,
    vetRecords: session.vetRecords,
    settlementEvidence: session.settlementEvidence,
    recipeRegistryVersion: session.recipeRegistryVersion,
    railRegistryVersion: session.railRegistryVersion,
    finalisedAt: session.finalisedAt,
  } as unknown as AttestationBundle;

  const hash = attestationBundleHash(body);

  // Both parties sign the SAME hash. This is what makes the copies canonically equal, and what
  // the ten live Directory deals are missing: each side there signed only its own self-portrait.
  const signatures: BundleSignature[] = [await signOver(buyer, hash)];
  if (sellerSigner) signatures.push(await signOver(sellerSigner, hash));
  if (orchestrator) signatures.push(await signOver(orchestrator, hash));

  const copy = (role: BundleRole): AttestationBundle =>
    ({ ...body, anchoredByRole: role, signatures }) as AttestationBundle;

  return {
    buyerCopy: copy("buyer"),
    ...(sellerSigner ? { sellerCopy: copy("seller") } : {}),
    ...(orchestrator ? { orchestratorCopy: copy("orchestrator") } : {}),
  };
}
