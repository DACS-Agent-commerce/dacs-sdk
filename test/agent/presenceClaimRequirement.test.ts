import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  aggregatePresenceAwareCompositeVerification,
  canonicalize,
  ed25519Verify,
  identityBundleHash,
  isCompositeBundleRequirement,
  isCompositeVerificationRecord,
  isIdentityBundle,
  isVerifyResult,
  parseCanonicalClaimReference,
  presenceRequirementPreflight,
  publicKeyFromRaw,
  sha256Hex,
  signedBytes,
  verifyComponentSignature,
  type CompositeBundleRequirement,
  type CompositeClaimRequirement,
  type IdentityBundle,
  type VerificationDecision,
  type VerifyResult,
  type VerifyResultRef,
} from "../../src/index.js";

interface PresenceVector {
  name: string;
  expected: VerificationDecision;
  evaluatedAt: number;
  registryAvailable: boolean;
  registryAuthenticated: boolean;
  bundleAvailable: boolean;
  bundle: unknown;
  requirement: unknown;
  compositeRecord: unknown;
  resolvedResults: Array<{ ref: VerifyResultRef; artifact: VerifyResult }>;
}

const corpus = JSON.parse(readFileSync(new URL(
  "../../vendor/DACS-Standard/conformance/vectors/security/" +
    "presence-only-claim-requirement-v0.7.json",
  import.meta.url,
), "utf8")) as { count: number; vectors: PresenceVector[] };

function keyBytes(reference: unknown): Uint8Array | null {
  const parsed = parseCanonicalClaimReference(reference);
  if (!parsed || parsed.identity.scheme !== "key" ||
      !/^[0-9a-f]{64}$/.test(parsed.identity.identifier)) return null;
  return Uint8Array.from(Buffer.from(parsed.identity.identifier, "hex"));
}

async function componentAuthenticated(value: unknown): Promise<boolean> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  const separator = Object.prototype.hasOwnProperty.call(artifact, "recordVersion")
    ? "dacs-composite:v1:"
    : "dacs-verifyresult:v1:";
  const verdict = await verifyComponentSignature(
    artifact,
    separator,
    {
      isSignerAuthorized: () => true,
      resolvePublicKey: ({ signer }) => keyBytes(signer),
      verify: ({ signedBytes: bytes, signature, publicKey }) =>
        ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(publicKey),
        ),
    },
  );
  return verdict.status === "valid";
}

function presentationAuthenticated(bundle: IdentityBundle): boolean {
  if (bundle.presentation.kind !== "per-claim") return false;
  const bytes = signedBytes(
    "dacs-bundle-presentation:v1:",
    identityBundleHash(bundle),
  );
  return bundle.presentation.signatures.length > 0 &&
    bundle.presentation.signatures.every((signature) => {
      const publicKey = keyBytes(signature.ref);
      if (!publicKey) return false;
      try {
        return ed25519Verify(
          bytes,
          Uint8Array.from(Buffer.from(signature.signature, "base64url")),
          publicKeyFromRaw(publicKey),
        );
      } catch {
        return false;
      }
    });
}

function exactRef(left: VerifyResultRef, right: VerifyResultRef): boolean {
  return canonicalize(left) === canonicalize(right);
}

async function replay(vector: PresenceVector): Promise<VerificationDecision> {
  const record = vector.compositeRecord;
  if (!isCompositeVerificationRecord(record)) return "error";
  if (!(await componentAuthenticated(record))) return "error";
  if (!isCompositeBundleRequirement(vector.requirement)) return "error";
  const requirement = vector.requirement;
  if (presenceRequirementPreflight(requirement) !== null) return "error";
  if (!vector.registryAvailable || !vector.registryAuthenticated) return "error";
  if (!vector.bundleAvailable || vector.bundle === null) return "indeterminate";
  if (!isIdentityBundle(vector.bundle)) return "error";
  const bundle = vector.bundle;
  if (!presentationAuthenticated(bundle)) return "error";
  if (
    identityBundleHash(bundle) !== record.bundleHash ||
    sha256Hex(canonicalize(requirement)) !== record.requirementHash
  ) {
    return "error";
  }

  const verifiedMembers = [
    ...requirement.required,
    ...(requirement.oneOf ?? []).flat(),
  ].filter((member) => member.verificationRequired === true);
  const refs = [...record.freshness, ...record.dealSpecific];
  const verified: Array<{
    requirement: CompositeClaimRequirement;
    decision: VerificationDecision;
    claimRef: string;
    ref: VerifyResultRef;
  }> = [];
  for (const ref of refs) {
    const resolved = vector.resolvedResults.find((entry) => exactRef(entry.ref, ref));
    if (resolved && (
      !isVerifyResult(resolved.artifact) ||
      sha256Hex(canonicalize(resolved.artifact)) !==
        ref.contentHash ||
      !(await componentAuthenticated(resolved.artifact))
    )) {
      return "error";
    }
    const scheme = resolved?.artifact.scheme ?? bundle.claims.find(
      (claim) => claim.verifiedBy && exactRef(claim.verifiedBy, ref),
    )?.ref.split(":", 1)[0];
    const member = verifiedMembers.find((candidate) =>
      candidate.scheme === scheme &&
      (candidate.recipeVersion === undefined ||
        candidate.recipeVersion === ref.recipeVersion)
    );
    if (!member) return "error";
    const claim = bundle.claims.find((candidate) =>
      candidate.verifiedBy !== undefined && exactRef(candidate.verifiedBy, ref)
    );
    const claimRef = resolved
      ? `${resolved.artifact.scheme}:${resolved.artifact.identifier}`
      : claim?.ref;
    if (!claimRef) return "error";
    verified.push({
      requirement: member,
      decision: resolved?.artifact.decision ?? "indeterminate",
      claimRef,
      ref,
    });
  }
  const decision = aggregatePresenceAwareCompositeVerification({
    bundle,
    requirement: requirement as CompositeBundleRequirement,
    evaluatedAt: vector.evaluatedAt,
    verified,
  });
  return record.overallDecision === decision ? decision : "error";
}

describe("DACS-1 v0.7 / DACS-2 v0.6 presence-only corpus", () => {
  test("replays the exact adopted 38-case corpus", async () => {
    expect(corpus.count).toBe(38);
    const outcomes = await Promise.all(corpus.vectors.map(async (vector) => ({
      name: vector.name,
      expected: vector.expected,
      actual: await replay(vector),
    })));
    expect(outcomes.filter((outcome) => outcome.actual !== outcome.expected)).toEqual([]);
  });
});
