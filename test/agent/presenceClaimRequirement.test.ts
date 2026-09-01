import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  aggregatePresenceAwareCompositeVerification,
  canonicalContentHash,
  canonicalize,
  contentHash,
  ed25519Sign,
  ed25519Verify,
  identityBundleHash,
  isCompositeBundleRequirement,
  isCompositeVerificationRecord,
  isIdentityBundle,
  isVerifyResult,
  parseCanonicalClaimReference,
  presenceRequirementPreflight,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
  sha256Hex,
  signComponentArtifact,
  signedBytes,
  verifyComponentSignature,
  verifyCompositeVerificationRecord,
  type CompositeBundleRequirement,
  type CompositeClaimRequirement,
  type CompositeVerificationRecord,
  type IdentityBundle,
  type VerificationDecision,
  type VerifyResult,
  type VerifyResultRef,
} from "../../src/index.js";

const RECIPE_SEED = new Uint8Array(32).fill(119);
const RECIPE_SIGNER = `key:${Buffer.from(
  rawPublicKey(publicKeyFromSeed(RECIPE_SEED)),
).toString("hex")}`;

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

  test("resolves the exact adopted complete-artifact VerifyResultRef through the strict API", async () => {
    const vector = corpus.vectors.find(
      (candidate) => candidate.name === "mixed-required-presence-and-verified-pass",
    )!;
    expect(isCompositeVerificationRecord(vector.compositeRecord)).toBe(true);
    expect(isCompositeBundleRequirement(vector.requirement)).toBe(true);
    expect(isIdentityBundle(vector.bundle)).toBe(true);
    const record = vector.compositeRecord as CompositeVerificationRecord;
    const requirement = vector.requirement as CompositeBundleRequirement;
    const bundle = vector.bundle as IdentityBundle;
    const exact = vector.resolvedResults[0]!;
    expect(exact.ref.contentHash).toBe(
      canonicalContentHash(exact.artifact as unknown as Record<string, unknown>),
    );
    expect(exact.ref.contentHash).not.toBe(
      contentHash(exact.artifact as unknown as Record<string, unknown>),
    );

    const recipe = await signComponentArtifact(
      {
        recipeVersion: 1,
        scheme: "did",
        defaultMethod: { kind: "self-signed" as const },
        defaultMaxAgeSec: 3_600,
        parserRules: { format: "raw" as const, matcher: "identity" },
        retryClass: "permanent" as const,
        availability: "live" as const,
        governance: {
          proposedBy: RECIPE_SIGNER,
          acceptedAt: vector.evaluatedAt - 20_000,
          anchoring: "single-signer" as const,
        },
      },
      "dacs-recipe:v1:",
      {
        algorithm: "ed25519",
        signer: RECIPE_SIGNER,
        sign: (bytes) => ed25519Sign(bytes, privateKeyFromSeed(RECIPE_SEED)),
      },
    );
    const authorityBytes = Uint8Array.from(Buffer.from(
      `attestation:did:example:presence-vector:pass:${exact.artifact.verifiedAt}`,
      "utf8",
    ));

    const result = await verifyCompositeVerificationRecord(
      record,
      {
        jobId: record.jobId,
        evaluatedParty: record.evaluatedParty,
        bundleHash: record.bundleHash,
        requirement,
        verifier: record.signature.signer,
        freshness: [],
        dealSpecific: [{
          ref: exact.ref,
          scheme: "did",
          identifier: "example:presence-vector",
          method: "self-signed",
          requirement: requirement.required[1]!,
        }],
        presence: {
          bundle,
          sessionRecipeRegistrySnapshotHash: "a".repeat(64),
        },
      },
      {
        nowMs: () => vector.evaluatedAt,
        resolve: async (ref) => {
          if (ref.anchor.locator === exact.ref.anchor.locator) {
            return {
              encoding: "canonical-json" as const,
              value: structuredClone(
                exact.artifact as unknown as Record<string, unknown>,
              ),
            };
          }
          if (ref.anchor.locator === exact.artifact.attestation.anchor.locator) {
            return { encoding: "bytes" as const, value: authorityBytes };
          }
          return null;
        },
        resolveRecipe: async () => recipe,
        isRecipeSignerAuthorized: (_value, signature) =>
          signature.signer === RECIPE_SIGNER,
        isVerifyResultSignerAuthorized: (_value, signature) =>
          signature.signer === exact.artifact.signature.signer,
        resolvePublicKey: ({ signer }) => keyBytes(signer),
        verify: ({ signedBytes: bytes, signature, publicKey }) =>
          ed25519Verify(
            bytes,
            Uint8Array.from(Buffer.from(signature.value, "base64url")),
            publicKeyFromRaw(publicKey),
          ),
        verifyAuthorityAttestation: ({ result: verified, content }) =>
          verified.attestation.signer === exact.artifact.signature.signer &&
          content.encoding === "bytes" &&
          sha256Hex(content.value) === verified.attestation.contentHash
            ? "valid"
            : "invalid",
        isSessionRecipeRegistrySnapshotAuthenticated: () => true,
        verifyIdentityPresentation: ({ bundle: presented }) =>
          presentationAuthenticated(presented),
      },
    );

    expect(result).toMatchObject({
      status: "valid",
      dealSpecific: [exact.artifact],
    });
  });
});
