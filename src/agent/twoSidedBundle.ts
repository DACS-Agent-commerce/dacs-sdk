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
export const BUNDLE_SIGNED_SCOPE_OMIT: readonly string[] = ["signatures", "anchoredByRole"];

/** Outcomes that are terminal performance claims and therefore REQUIRE both parties' signatures. */
const CO_SIGNATURE_REQUIRED = new Set([
  "completed",
  "failed-counterparty",
  "failed-substrate",
  "failed-buyer",
  "failed-seller",
]);

/** The §B.2 canonical form of a bundle: the document minus `signatures` and `anchoredByRole`. */
export function bundleSignedScope(bundle: AttestationBundle): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bundle)) {
    if (!BUNDLE_SIGNED_SCOPE_OMIT.includes(k)) out[k] = v;
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
  /** Stands in for the party's DACS-1 IdentityBundle hash. */
  bundleHash: string;
  /** A 32-byte Ed25519 seed, a prepared KeyObject, or a remote signing function. */
  signer: Uint8Array | KeyObject | ((bytes: Uint8Array) => Promise<Uint8Array> | Uint8Array);
}

/** The facts of one completed (or aborted) session, from which both copies are derived. */
export interface TwoSidedSession {
  jobId: string;
  outcome: string;
  listingRef: AttestationBundle["listingRef"];
  agreementRef?: AttestationBundle["agreementRef"];
  phaseSummary: AttestationBundle["phaseSummary"];
  vetRecords: AttestationBundle["vetRecords"];
  settlementEvidence: AttestationBundle["settlementEvidence"];
  recipeRegistryVersion: number;
  railRegistryVersion: number;
  finalisedAt: number;
  buyer: SessionParty;
  /**
   * The seller. MAY be omitted ONLY for an abort outcome, where §10.11 bundle-suppression lets
   * the non-withdrawing party's single-signed copy stand.
   */
  seller?: SessionParty;
  bundleVersion?: string;
}

export interface TwoSidedBundles {
  buyerCopy: AttestationBundle;
  sellerCopy?: AttestationBundle;
}

async function signOver(party: SessionParty, hash: string): Promise<BundleSignature> {
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

  if (CO_SIGNATURE_REQUIRED.has(outcome) && seller === undefined) {
    throw new DacsError(
      `outcome "${outcome}" requires two signatures (§10.4.1): a single-signed non-abort bundle ` +
        `MUST be dropped by consumers. Only an abort outcome may be single-signed.`,
    );
  }

  const parties: BundleParty[] = [
    { role: "buyer", bundleHash: buyer.bundleHash, primaryClaim: buyer.primaryClaim },
    ...(seller
      ? [{ role: "seller", bundleHash: seller.bundleHash, primaryClaim: seller.primaryClaim }]
      : []),
  ];

  // The shared body — identical for both copies. `anchoredByRole` is stamped per copy afterwards
  // and is outside the hashed scope, so it cannot change the hash or invalidate a signature.
  const body = {
    bundleVersion: session.bundleVersion ?? "1",
    jobId: session.jobId,
    outcome,
    listingRef: session.listingRef,
    ...(session.agreementRef ? { agreementRef: session.agreementRef } : {}),
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
  if (seller) signatures.push(await signOver(seller, hash));

  const copy = (role: "buyer" | "seller"): AttestationBundle =>
    ({ ...body, anchoredByRole: role, signatures }) as AttestationBundle;

  return seller
    ? { buyerCopy: copy("buyer"), sellerCopy: copy("seller") }
    : { buyerCopy: copy("buyer") };
}
