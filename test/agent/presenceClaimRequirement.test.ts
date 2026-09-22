import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  aggregatePresenceAwareCompositeVerification,
  canonicalize,
  contentHash,
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
  resolvedResults: Array<{ ref: VerifyResultRef; artifact: VerifyResult | null }>;
}

const corpus = JSON.parse(readFileSync(new URL(
  "../../vendor/DACS-Standard/conformance/vectors/security/" +
    "presence-only-claim-requirement-v0.7.json",
  import.meta.url,
), "utf8")) as {
  count: number;
  vectors: PresenceVector[];
  trustedContext: {
    compositeSigner: string;
    verifyResultAuthorities: Array<{
      scheme: string; method: string; recipeVersion: number; signer: string;
    }>;
  };
};

function keyBytes(reference: unknown): Uint8Array | null {
  const parsed = parseCanonicalClaimReference(reference);
  if (!parsed || parsed.identity.scheme !== "key" ||
      !/^[0-9a-f]{64}$/.test(parsed.identity.identifier)) return null;
  return Uint8Array.from(Buffer.from(parsed.identity.identifier, "hex"));
}

async function componentAuthenticated(value: unknown, expectedSigner: string): Promise<boolean> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as Record<string, unknown>;
  const separator = Object.prototype.hasOwnProperty.call(artifact, "recordVersion")
    ? "dacs-composite:v1:"
    : "dacs-verifyresult:v1:";
  const verdict = await verifyComponentSignature(
    artifact,
    separator,
    {
      isSignerAuthorized: (_artifact, signature) => signature.signer === expectedSigner,
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

// Historical fixture replay through the pure SDK aggregator. This is not the
// durable producer or active reuse verifier; those retain their own authority
// and current-time gates. Corpus context is an immutable test trust root.
async function replay(
  vector: PresenceVector,
): Promise<VerificationDecision> {
  const record = vector.compositeRecord;
  if (!isCompositeVerificationRecord(record)) return "error";
  if (!(await componentAuthenticated(record, corpus.trustedContext.compositeSigner))) return "error";
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
  if (refs.length !== vector.resolvedResults.length || refs.some(
    (ref, index) => !exactRef(ref, vector.resolvedResults[index]!.ref),
  )) return "error";
  const verified: Array<{
    requirement: CompositeClaimRequirement;
    decision: VerificationDecision;
    claimRef: string;
    ref: VerifyResultRef;
  }> = [];
  if (new Set(refs.map((ref) => canonicalize(ref))).size !== refs.length) return "error";
  for (const [index, ref] of refs.entries()) {
    const resolved = vector.resolvedResults[index];
    if (resolved?.artifact !== null && resolved !== undefined) {
      if (!isVerifyResult(resolved.artifact)) return "error";
      const authorities = corpus.trustedContext.verifyResultAuthorities.filter(
        (authority) => authority.scheme === resolved.artifact!.scheme &&
          authority.method === resolved.artifact!.method &&
          authority.recipeVersion === resolved.artifact!.recipeVersion,
      );
      if (authorities.length !== 1) return "error";
      if (
        contentHash(resolved.artifact as unknown as Record<string, unknown>) !==
          ref.contentHash ||
        !(await componentAuthenticated(resolved.artifact, authorities[0]!.signer))
      ) {
        return "error";
      }
    }
    const scheme = resolved?.artifact?.scheme ?? bundle.claims.find(
      (claim) => claim.verifiedBy && exactRef(claim.verifiedBy, ref),
    )?.ref.split(":", 1)[0];
    const members = verifiedMembers.filter((candidate) =>
      candidate.scheme === scheme &&
      (candidate.recipeVersion === undefined ||
        candidate.recipeVersion === ref.recipeVersion)
    );
    if (members.length === 0) return "error";
    const claim = bundle.claims.find((candidate) =>
      candidate.verifiedBy !== undefined && exactRef(candidate.verifiedBy, ref)
    );
    const artifact = resolved?.artifact;
    const claimRef = artifact
      ? `${artifact.scheme}:${artifact.identifier}`
      : claim?.ref;
    if (!claimRef) return "error";
    for (const member of members) {
      const parametersMatch = artifact && Object.entries(member.parameters ?? {}).every(
        ([key, value]) => key === "verificationMethod"
          ? artifact.method === value
          : artifact.data !== undefined && Object.hasOwn(artifact.data, key) &&
            canonicalize(artifact.data[key]) === canonicalize(value),
      );
      verified.push({
        requirement: member,
        decision: !artifact ? "indeterminate"
          : artifact.decision === "pass" && !parametersMatch ? "fail" : artifact.decision,
        claimRef,
        ref,
      });
    }
  }
  const decision = aggregatePresenceAwareCompositeVerification({
    bundle,
    requirement: requirement as CompositeBundleRequirement,
    evaluatedAt: record.generatedAt,
    verified,
  });
  return record.overallDecision === decision ? decision : "error";
}

describe("DACS-1 v0.7 / DACS-2 v0.6 presence-only corpus", () => {
  test("uses CORE §B.2 signature-omitted refs for every resolved result", () => {
    const resolved = corpus.vectors.flatMap((vector) => vector.resolvedResults)
      .filter((entry): entry is { ref: VerifyResultRef; artifact: VerifyResult } => entry.artifact !== null);

    expect(resolved).toHaveLength(15);
    expect(resolved.every(({ ref, artifact }) =>
      contentHash(artifact as unknown as Record<string, unknown>) === ref.contentHash
    )).toBe(true);
    expect(resolved.every(({ ref, artifact }) =>
      sha256Hex(canonicalize(artifact)) !== ref.contentHash
    )).toBe(true);
  });

  test("strictly replays all 47 authenticated semantic outcomes", async () => {
    expect(corpus.count).toBe(47);
    const outcomes = await Promise.all(corpus.vectors.map(async (vector) => ({
      name: vector.name,
      expected: vector.expected,
      actual: await replay(vector),
    })));
    expect(outcomes.filter((outcome) => outcome.actual !== outcome.expected)).toEqual([]);
  });
});
