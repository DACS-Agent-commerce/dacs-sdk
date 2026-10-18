import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { describe, expect, test, vi } from "vitest";

import { ed25519Verify, publicKeyFromRaw } from "../../src/crypto/ed25519.js";
import {
  readAuthenticatedDomainClaims,
  verifyDemosGcrDomainClaims,
  type DemosGcrResolution,
  type DemosGcrDomainMetadata,
  type DomainArtifactAuthentication,
  type DomainClaimArtifactLike,
} from "../../src/identity/domainClaimVerification.js";

import { canonicalize } from "../../src/canonical/index.js";
import { authenticatedIdentityBundleSemantics } from "../../src/identity/domainClaimVerification.js";
import { aggregatePresenceAwareCompositeVerification } from "../../src/agent/compositeVerification.js";
import { deriveIdentityTier } from "../../src/identity/tier.js";
import type { IdentityBundle } from "../../src/artifacts/types.js";
import { serializeDomainClaimArtifact, type DomainClaimProducerInput } from "../../src/identity/index.js";

interface VectorArtifact {
  unsigned: DomainClaimArtifactLike;
  canonicalHex: string;
  contentHash: string;
  signingPublicKey: string;
  signature: string;
}

interface DomainVector {
  name: string;
  producerInput?: DomainClaimProducerInput;
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
  want?: {
    semanticClaims?: string[];
    metadataEqualsAuthority?: boolean;
    originalBytesPreserved?: boolean;
    tierGain?: boolean;
    oneOfGain?: boolean;
  };
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
    return {
      status: "authenticated",
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
  test("pins the exact package-pinned Standard corpus", () => {
    expect(fixture.set).toBe("domain-claim-gcr-v0.4");
    expect(fixture.vectors).toHaveLength(63);
    expect(fixture.count).toBe(63);
    expect(fixture.hash).toBe(
      "465395b6c94e20766838367539e9cd1609bfa40a952c7ed54965550a401fe024",
    );
    expect(createHash("sha256").update(fixtureBytes).digest("hex")).toBe(
      "0a28643dbd4d41423f204ae23dec6c4b8cb7312cdceac72d3be495a675a4b6d7",
    );
  });

  for (const vector of fixture.vectors) {
    test(`${vector.producerInput ? "produces" : "replays"} ${vector.name}`, async () => {
      if (vector.producerInput) {
        const emittedBytes = Buffer.from(serializeDomainClaimArtifact(vector.producerInput), "utf8");
        const emitted = JSON.parse(emittedBytes.toString("utf8")) as DomainClaimArtifactLike;
        // Producer cases judge actual output, never the supplied reader artifact.
        const matches = isDeepStrictEqual(emitted, vector.artifact.unsigned) &&
          emittedBytes.toString("hex") === vector.artifact.canonicalHex;
        expect(matches ? "pass" : "fail").toBe(vector.expected);
        expect(emitted.claims.every((claim) => claim.ref.startsWith("domain:"))).toBe(true);
        const nativeHosts = vector.producerInput.claims.map((claim) =>
          (claim.metadata["demosGcrDomain"] as { hostname: string }).hostname);
        expect(emitted.claims.map((claim) => claim.ref)).toEqual(
          [...new Set(nativeHosts)].map((hostname) => `domain:${hostname}`),
        );
        expect(emitted.presentedBy).toBe(`domain:${nativeHosts[vector.producerInput.presentedByClaimIndex]}`);
        return;
      }
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
      if (vector.want?.tierGain !== undefined || vector.want?.oneOfGain !== undefined) {
        // Authenticate original corpus bytes/signature before using the semantic view.
        expect(authenticate(vector.artifact)(vector.artifact.unsigned).status).toBe("authenticated");
        const original = vector.artifact.unsigned as unknown as IdentityBundle;
        const semantic = authenticatedIdentityBundleSemantics(original);
        const single = { ...semantic, claims: semantic.claims.slice(0, 1) };
        expect(deriveIdentityTier(semantic, () => false) !== deriveIdentityTier(single, () => false))
          .toBe(vector.want.tierGain);
        const requirement = { requirementVersion: "1" as const, required: [],
          oneOf: [[{ scheme: "domain", verificationRequired: false }]] };
        const decide = (bundle: IdentityBundle) => aggregatePresenceAwareCompositeVerification({
          bundle, requirement, evaluatedAt: vector.evaluatedAt, verified: [],
        });
        expect(decide(original)).toBe("pass");
        expect(decide(original) !== decide(single)).toBe(vector.want.oneOfGain);
      }
      if (vector.want?.metadataEqualsAuthority) {
        expect(verdict.data?.demosGcrDomain).toEqual(vector.authoritativeGcr);
      }
      if (vector.want?.originalBytesPreserved) {
        expect(verdict.originalRefs).toEqual(vector.artifact.unsigned.claims.map((claim) => claim.ref));
        expect(verdict.originalPresentedBy).toBe(vector.artifact.unsigned.presentedBy);
        expect(verdict.authentication?.contentHash).toBe(vector.artifact.contentHash);
      }
    });
  }

  test.each([
    ["inclusion height", (m: DemosGcrDomainMetadata) => { m.sourceTransaction.blockNumber += 1; }],
    ["inclusion time", (m: DemosGcrDomainMetadata) => { m.recordedAt += 1; }],
    ["context", (m: DemosGcrDomainMetadata) => { m.context = "web2.other"; }],
    ["proof URL", (m: DemosGcrDomainMetadata) => { m.proofUrl = "https://agent.example/other"; }],
  ] as const)("rejects an independently authenticated %s disagreement", async (_label, change) => {
    const vector = fixture.vectors.find((v) => v.name === "canonical-production")!;
    const authoritative = resolution(vector);
    expect(authoritative.status).toBe("authenticated");
    if (authoritative.status !== "authenticated") throw new Error("missing authenticated fixture");
    const resolveGcr = vi.fn(() => authoritative);
    const deps = {
      authenticateArtifact: authenticate(vector.artifact),
      requiredMethod: vector.requiredMethod,
      recipeDefaultMaxAgeSec: vector.recipeDefaultMaxAgeSec,
      evaluatedAt: vector.evaluatedAt,
      resolveGcr,
    };
    // Prove the unchanged signature, writer, proof profile and freshness pass.
    expect((await verifyDemosGcrDomainClaims(vector.artifact.unsigned, deps)).verdict).toBe("pass");
    change(authoritative.record);
    const verdict = await verifyDemosGcrDomainClaims(vector.artifact.unsigned, deps);
    expect(verdict.verdict).toBe("fail");
    expect(verdict.diagnostic.code).toBe("source-record-mismatch");
    const presented = vector.artifact.unsigned.claims[0]!.metadata!["demosGcrDomain"] as DemosGcrDomainMetadata;
    expect(resolveGcr).toHaveBeenCalledTimes(2);
    for (const args of resolveGcr.mock.calls) {
      expect(args).toEqual([presented.sourceTransaction]);
    }
  });

  test("preserves additive canonical JSON metadata at every extensible level", () => {
    const input = structuredClone(fixture.vectors.find((v) => v.name === "canonical-production")!.producerInput!);
    input.claims[0]!.metadata.extra = { enabled: true, note: "retained" };
    const native = input.claims[0]!.metadata.demosGcrDomain as Record<string, unknown>;
    native.extraNative = [1, "two"];
    (native.sourceTransaction as Record<string, unknown>).extraSource = "retained";
    const emitted = serializeDomainClaimArtifact(input);
    expect(JSON.parse(emitted).claims[0].metadata).toEqual(input.claims[0]!.metadata);
    expect(emitted).toBe(canonicalize(JSON.parse(emitted)));
  });

  test("rejects only a wrong reported query-time fetchedAt after a passing control", async () => {
    const vector = fixture.vectors.find((v) => v.name === "canonical-production")!;
    const metadata = vector.authoritativeGcr as unknown as DemosGcrDomainMetadata;
    const deps = {
      authenticateArtifact: authenticate(vector.artifact), requiredMethod: vector.requiredMethod,
      recipeDefaultMaxAgeSec: vector.recipeDefaultMaxAgeSec, evaluatedAt: vector.evaluatedAt,
      resolveGcr: () => resolution(vector),
      reportedResult: { verifiedAt: metadata.recordedAt, fetchedAt: vector.evaluatedAt,
        validUntil: metadata.recordedAt + vector.recipeDefaultMaxAgeSec * 1000 },
    };
    expect((await verifyDemosGcrDomainClaims(vector.artifact.unsigned, deps)).verdict).toBe("pass");
    deps.reportedResult.fetchedAt += 1;
    expect(await verifyDemosGcrDomainClaims(vector.artifact.unsigned, deps)).toMatchObject({
      verdict: "fail", diagnostic: { code: "reported-result-mismatch" },
    });
  });

  test.each([
    ["altered prefix", (p: string) => p.replace("demos:", "other:")],
    ["altered tag", (p: string) => p.replace(":dw2p:", ":other:")],
    ["uppercase signature", (p: string) => p.slice(0, 19) + p.slice(19).toUpperCase()],
    ["surrounding whitespace", (p: string) => ` ${p}\n`],
  ] as const)("rejects %s even with authenticated profile provenance and never refetches", async (_label, change) => {
    const vector = fixture.vectors.find((v) => v.name === "canonical-production")!;
    const source = resolution(vector);
    if (source.status !== "authenticated" || !source.validationProfile) throw new Error("fixture");
    const fetch = vi.fn(() => { throw new Error("historical proof fetch forbidden"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const deps = { authenticateArtifact: authenticate(vector.artifact), requiredMethod: vector.requiredMethod,
        recipeDefaultMaxAgeSec: vector.recipeDefaultMaxAgeSec, evaluatedAt: vector.evaluatedAt,
        resolveGcr: () => source };
      expect((await verifyDemosGcrDomainClaims(vector.artifact.unsigned, deps)).verdict).toBe("pass");
      source.validationProfile.proofPayload = change(source.validationProfile.proofPayload);
      expect(await verifyDemosGcrDomainClaims(vector.artifact.unsigned, deps)).toMatchObject({
        verdict: "fail", diagnostic: { code: "registration-proof-invalid" },
      });
      delete source.validationProfile;
      expect(await verifyDemosGcrDomainClaims(vector.artifact.unsigned, deps)).toMatchObject({
        verdict: "indeterminate", diagnostic: { code: "validation-profile-unavailable" },
      });
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  test.each([undefined, "canonical-domain-v0.6", "historical-domain-alias"] as const)(
    "authenticated bundle bytes preserve legacy reads with profile %s",
    async (profile) => {
      const vector = fixture.vectors.find((v) => v.name === "legacy-mixed-case-ascii-read")!;
      const verdict = await readAuthenticatedDomainClaims(vector.artifact.unsigned, {
        authenticateArtifact: (artifact) => ({ ...authenticate(vector.artifact)(artifact), profile }),
      });
      expect(verdict.verdict).toBe("pass");
      expect(verdict.semanticClaims).toEqual(["domain:agent.example"]);
      expect(verdict.originalRefs).toEqual(["web2:domain:Agent.Example"]);
    },
  );

  test.each([undefined, "2"])("reader rejects unsupported authenticated bundle version %s", async (bundleVersion) => {
    const artifact = structuredClone(fixture.vectors.find((v) => v.name === "canonical-production")!.artifact.unsigned);
    if (bundleVersion === undefined) delete artifact.bundleVersion;
    else artifact.bundleVersion = bundleVersion;
    const verdict = await readAuthenticatedDomainClaims(artifact, {
      authenticateArtifact: () => ({ status: "authenticated", signingPublicKey: "11".repeat(32), contentHash: "22".repeat(32) }),
    });
    expect(verdict.verdict).toBe("error");
    expect(verdict.semanticClaims).toEqual([]);
  });

  test("producer deduplicates aliases and keeps presentedBy bound to the source position", () => {
    const vector = fixture.vectors.find((v) => v.name === "current-producer-dual-alias-with-mixed-case-rejected")!;
    const input = structuredClone(vector.producerInput!);
    input.presentedByClaimIndex = 1;
    const emitted = JSON.parse(serializeDomainClaimArtifact(input));
    expect(emitted.claims).toHaveLength(1);
    expect(emitted.presentedBy).toBe("domain:agent.example");
    input.claims[1]!.metadata = structuredClone(input.claims[1]!.metadata);
    (input.claims[1]!.metadata["demosGcrDomain"] as { recordedAt: number }).recordedAt += 1;
    expect(() => serializeDomainClaimArtifact(input)).toThrow(/conflicting metadata/);
  });

  test.each([
    ["missing source transaction", (m: Record<string, unknown>) => { delete m["sourceTransaction"]; }],
    ["wrong context", (m: Record<string, unknown>) => { m["context"] = "web2.other"; }],
    ["wrong hostname", (m: Record<string, unknown>) => { m["hostname"] = "other.example"; }],
    ["uppercase account", (m: Record<string, unknown>) => { m["account"] = (m["account"] as string).toUpperCase(); }],
    ["wrong proof URL", (m: Record<string, unknown>) => { m["proofUrl"] = "https://agent.example/other"; }],
    ["unsafe time", (m: Record<string, unknown>) => { m["recordedAt"] = Number.MAX_SAFE_INTEGER + 1; }],
    ["boolean height", (m: Record<string, unknown>) => { (m["sourceTransaction"] as Record<string, unknown>)["blockNumber"] = true; }],
    ["prefixed hash", (m: Record<string, unknown>) => { (m["sourceTransaction"] as Record<string, unknown>)["txHash"] = "0x" + "11".repeat(32); }],
  ] as const)("producer rejects %s", (_name, change) => {
    const input = structuredClone(fixture.vectors.find((v) => v.name === "canonical-production")!.producerInput!);
    change(input.claims[0]!.metadata["demosGcrDomain"] as Record<string, unknown>);
    expect(() => serializeDomainClaimArtifact(input)).toThrow();
  });

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
