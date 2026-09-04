import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { describe, expect, test } from "vitest";

import { ed25519Verify, publicKeyFromRaw } from "../../src/crypto/ed25519.js";
import {
  readAuthenticatedDomainClaims,
  verifyDemosGcrDomainClaims,
  type DemosGcrResolution,
  type DomainArtifactAuthentication,
  type DomainArtifactProfile,
  type DomainClaimArtifactLike,
} from "../../src/identity/domainClaimVerification.js";

interface VectorArtifact {
  unsigned: DomainClaimArtifactLike & { producerDacs1Version: string };
  canonicalHex: string;
  contentHash: string;
  signingPublicKey: string;
  signature: string;
}

interface DomainVector {
  name: string;
  expected: "pass" | "fail" | "indeterminate" | "error";
  artifact: VectorArtifact;
  authoritativeGcr: Record<string, unknown>;
  registrationValidation: { profile: string; proofPayload: string };
  sourceAvailable: boolean;
  sourceAuthentication?: {
    inclusionProofCoversTransaction?: boolean;
    blockFinalized?: boolean;
  };
  writerAuthorization?: {
    authenticated?: boolean;
    writer?: string;
    authorizedAccount?: string;
  };
  validationProfileAvailable: boolean;
  requiredMethod: string;
  evaluatedAt: number;
  recipeDefaultMaxAgeSec: number;
  evaluationScope?: "semantic-claim-set";
  reportedVerifyResult?: {
    verifiedAt: number;
    fetchedAt: number;
    validUntil: number;
  };
  authenticatedSr1Binding?: {
    authenticated?: boolean;
    account?: unknown;
    sessionPublicKey?: unknown;
    boundPresentationHash?: unknown;
  };
  want?: { semanticClaims?: string[] };
}

interface DomainFixture {
  set: string;
  count: number;
  hash: string;
  vectors: DomainVector[];
}

const fixtureBytes = readFileSync(
  new URL(
    "../fixtures/standard-next/domain-claim-gcr-v0.4.json",
    import.meta.url,
  ),
);
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as DomainFixture;

// This map models authenticated release provenance. The production API never
// reads producerDacs1Version from the signed artifact to authorize aliases.
const historicalVectors = new Set([
  "legacy-decomposed-unicode-nfc-idna-read",
  "legacy-mixed-case-ascii-read",
  "legacy-alias-original-byte-preservation",
  "historical-alias-pair-deduplicates",
]);
const trustedProfiles = new Map<string, DomainArtifactProfile>(
  fixture.vectors.map((vector) => [
    vector.artifact.contentHash,
    historicalVectors.has(vector.name)
      ? "historical-domain-alias"
      : "canonical-domain-v0.6",
  ]),
);

function authenticate(
  envelope: VectorArtifact,
): (artifact: Readonly<DomainClaimArtifactLike>) => DomainArtifactAuthentication {
  return (artifact) => {
    const originalBytes = Buffer.from(envelope.canonicalHex, "hex");
    let original: unknown;
    try {
      original = JSON.parse(originalBytes.toString("utf8"));
    } catch {
      return { status: "error", reason: "original artifact bytes are not JSON" };
    }
    if (!isDeepStrictEqual(original, artifact)) {
      return { status: "invalid", reason: "artifact does not equal original bytes" };
    }
    const digest = createHash("sha256").update(originalBytes).digest("hex");
    if (digest !== envelope.contentHash) {
      return { status: "invalid", reason: "content hash mismatch" };
    }
    let signatureValid = false;
    try {
      signatureValid = ed25519Verify(
        Buffer.concat([
          Buffer.from("dacs-bundle-presentation:v1:", "utf8"),
          Buffer.from(digest, "hex"),
        ]),
        Buffer.from(envelope.signature, "hex"),
        publicKeyFromRaw(Buffer.from(envelope.signingPublicKey, "hex")),
      );
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      return { status: "invalid", reason: "presentation signature is invalid" };
    }
    const profile = trustedProfiles.get(digest);
    if (!profile) {
      return {
        status: "indeterminate",
        reason: "authenticated producer profile is unavailable",
      };
    }
    return {
      status: "authenticated",
      profile,
      signingPublicKey: envelope.signingPublicKey,
      contentHash: digest,
    };
  };
}

function resolution(vector: DomainVector): DemosGcrResolution {
  if (!vector.sourceAvailable) {
    return { status: "indeterminate", reason: "GCR source is unavailable" };
  }
  const sourceAuthentication = vector.sourceAuthentication ?? {};
  const writer = vector.writerAuthorization;
  return {
    status: "authenticated",
    record: structuredClone(vector.authoritativeGcr) as never,
    sourceAuthentication: {
      inclusionProofCoversTransaction:
        sourceAuthentication.inclusionProofCoversTransaction === true,
      blockFinalized: sourceAuthentication.blockFinalized === true,
    },
    ...(writer?.authenticated === true
      ? {
          writerAuthorization: {
            writer: writer.writer as string,
            authorizedAccount: writer.authorizedAccount as string,
          },
        }
      : {}),
    ...(vector.validationProfileAvailable
      ? { validationProfile: structuredClone(vector.registrationValidation) }
      : {}),
  };
}

describe("DACS-1 DCR / DACS-2 DGCR authenticated domain boundary", () => {
  test("pins the exact merged Standard #346 corpus", () => {
    expect(fixture.set).toBe("domain-claim-gcr-v0.4");
    expect(fixture.vectors).toHaveLength(52);
    expect(fixture.count).toBe(52);
    expect(fixture.hash).toBe(
      "ce7982c76a78066f9ae5c13e2737b6a5a574755cec1d3b6ed7c48e9bca23e7b8",
    );
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      "fc1734ddbd148e09738abdcc9e017ae5a0ad961a7fd022cc75c75dfd9e108e2e",
    );
  });

  for (const vector of fixture.vectors) {
    test(`replays ${vector.name}`, async () => {
      const verdict = await verifyDemosGcrDomainClaims(vector.artifact.unsigned, {
        authenticateArtifact: authenticate(vector.artifact),
        requiredMethod: vector.requiredMethod,
        recipeDefaultMaxAgeSec: vector.recipeDefaultMaxAgeSec,
        evaluatedAt: vector.evaluatedAt,
        evaluationScope: vector.evaluationScope ?? "demos-gcr-domain",
        resolveGcr: () => resolution(vector),
        ...(vector.reportedVerifyResult
          ? { reportedResult: structuredClone(vector.reportedVerifyResult) }
          : {}),
        resolvePresentationBinding: () => {
          const binding = vector.authenticatedSr1Binding;
          return binding?.authenticated === true
            ? {
                account: binding.account,
                sessionPublicKey: binding.sessionPublicKey,
                boundPresentationHash: binding.boundPresentationHash,
              }
            : null;
        },
      });

      expect(verdict.verdict).toBe(vector.expected);
      if (vector.want?.semanticClaims) {
        expect(verdict.semanticClaims).toEqual(vector.want.semanticClaims);
      }
    });
  }

  test("invalid historical bytes never cross the alias-fold boundary", async () => {
    const vector = fixture.vectors.find(
      (candidate) => candidate.name === "legacy-mixed-case-ascii-read",
    )!;
    const invalid = structuredClone(vector.artifact);
    invalid.signature = `${invalid.signature.slice(0, -2)}00`;
    const verdict = await readAuthenticatedDomainClaims(invalid.unsigned, {
      authenticateArtifact: authenticate(invalid),
    });
    expect(verdict.verdict).toBe("fail");
    expect(verdict.diagnostic.code).toBe("artifact-invalid");
    expect(verdict.semanticClaims).toEqual([]);
    expect(verdict.originalRefs).toEqual(["web2:domain:Agent.Example"]);
    expect(verdict.semanticPresentedBy).toBeUndefined();
  });

  test("mutation after capture cannot change authenticated semantic output", async () => {
    const vector = fixture.vectors.find(
      (candidate) => candidate.name === "legacy-mixed-case-ascii-read",
    )!;
    const artifact = structuredClone(vector.artifact.unsigned);
    let releaseAuthentication!: () => void;
    const waiting = new Promise<void>((resolve) => {
      releaseAuthentication = resolve;
    });
    const verification = readAuthenticatedDomainClaims(artifact, {
      authenticateArtifact: async (captured) => {
        await waiting;
        return authenticate(vector.artifact)(captured);
      },
    });
    artifact.claims[0]!.ref = "web2:domain:mallory.example";
    releaseAuthentication();
    const verdict = await verification;
    expect(verdict.verdict).toBe("pass");
    expect(verdict.originalRefs).toEqual(["web2:domain:Agent.Example"]);
    expect(verdict.semanticClaims).toEqual(["domain:agent.example"]);
    expect(verdict.semanticPresentedBy).toBe("domain:agent.example");
  });

  test("semantic alias deduplication cannot manufacture a second requirement", async () => {
    const vector = fixture.vectors.find(
      (candidate) => candidate.name === "historical-alias-pair-deduplicates",
    )!;
    const verdict = await readAuthenticatedDomainClaims(vector.artifact.unsigned, {
      authenticateArtifact: authenticate(vector.artifact),
    });
    expect(verdict.verdict).toBe("pass");
    expect(verdict.originalRefs).toHaveLength(2);
    expect(verdict.semanticClaims).toEqual(["domain:agent.example"]);
    expect(verdict.semanticPresentedBy).toBe("domain:agent.example");
  });

  test("a reader cannot rewrite and re-present historical bytes as canonical", async () => {
    const vector = fixture.vectors.find(
      (candidate) => candidate.name === "legacy-alias-original-byte-preservation",
    )!;
    const rewritten = structuredClone(vector.artifact.unsigned);
    rewritten.claims[0]!.ref = "domain:agent.example";
    rewritten.presentedBy = "domain:agent.example";
    const verdict = await readAuthenticatedDomainClaims(rewritten, {
      authenticateArtifact: authenticate(vector.artifact),
    });
    expect(verdict.verdict).toBe("fail");
    expect(verdict.diagnostic.code).toBe("artifact-invalid");
    expect(verdict.semanticClaims).toEqual([]);
  });

  test("malformed authority responses stay discriminated instead of throwing", async () => {
    const vector = fixture.vectors.find(
      (candidate) => candidate.name === "canonical-production",
    )!;
    const verdict = await verifyDemosGcrDomainClaims(vector.artifact.unsigned, {
      authenticateArtifact: authenticate(vector.artifact),
      requiredMethod: vector.requiredMethod,
      recipeDefaultMaxAgeSec: vector.recipeDefaultMaxAgeSec,
      evaluatedAt: vector.evaluatedAt,
      resolveGcr: (() => null) as never,
    });
    expect(verdict.verdict).toBe("error");
    expect(verdict.diagnostic.code).toBe("source-malformed");
  });
});
