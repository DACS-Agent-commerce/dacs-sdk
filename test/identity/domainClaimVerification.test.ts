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
import { deriveIdentityTier } from "../../src/identity/tier.js";
import { aggregatePresenceAwareCompositeVerification } from "../../src/agent/compositeVerification.js";
import { authenticatedIdentityBundleSemantics } from "../../src/identity/domainClaimVerification.js";
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
        if (vector.want?.semanticClaims) {
          expect([...new Set(emitted.claims.map((claim) => claim.ref))]).toEqual(vector.want.semanticClaims);
        }
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
        expect(authenticatedIdentityBundleSemantics(original).claims.map((claim) => claim.ref))
          .toEqual(vector.want.semanticClaims);
        const baseline = { ...original, claims: original.claims.filter((claim) =>
          claim.ref === "domain:agent.example") };
        expect(baseline.claims).toHaveLength(1);
        for (const verified of [false, true]) {
          const baselineTier = deriveIdentityTier(baseline, () => verified);
          expect(baselineTier).toBe(verified ? "verified" : "self-declared");
          expect(deriveIdentityTier(original, () => verified) !== baselineTier)
            .toBe(vector.want.tierGain);
        }
        for (const scheme of ["domain", "lei"]) {
          const aggregate = (bundle: IdentityBundle) => aggregatePresenceAwareCompositeVerification({
            bundle, evaluatedAt: vector.evaluatedAt, verified: [],
            presentedClaimControlled: true,
            requirement: { requirementVersion: "1", required: [],
              oneOf: [[{ scheme, verificationRequired: false }]] },
          });
          const baselineDecision = aggregate(baseline);
          expect(baselineDecision).toBe(scheme === "domain" ? "pass" : "fail");
          expect(aggregate(original) !== baselineDecision).toBe(vector.want.oneOfGain);
        }
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

  test.each([
    ["a member beside demosGcrDomain", (m: Record<string, unknown>) => { m["extra"] = { note: "x" }; }],
    ["an extra native member", (m: Record<string, unknown>) => {
      (m["demosGcrDomain"] as Record<string, unknown>)["proofBody"] = "not-persistent-evidence";
    }],
    ["an extra source transaction member", (m: Record<string, unknown>) => {
      const native = m["demosGcrDomain"] as Record<string, unknown>;
      (native["sourceTransaction"] as Record<string, unknown>)["transactionIndex"] = 0;
    }],
  ] as const)("producer rejects %s in persistent metadata", (_name, change) => {
    const input = structuredClone(fixture.vectors.find((v) => v.name === "canonical-production")!.producerInput!);
    expect(() => serializeDomainClaimArtifact(structuredClone(input))).not.toThrow();
    change(input.claims[0]!.metadata);
    expect(() => serializeDomainClaimArtifact(input)).toThrow(/invalid persistent Demos domain metadata/);
  });

  test("producer output verifies through the GCR reader against the native record", async () => {
    const vector = fixture.vectors.find((v) => v.name === "canonical-production")!;
    const emitted = serializeDomainClaimArtifact(structuredClone(vector.producerInput!));
    expect(emitted).toBe(canonicalize(JSON.parse(emitted)));
    // The emitted bytes are the corpus bytes, so the corpus signature authenticates them.
    expect(Buffer.from(emitted, "utf8").toString("hex")).toBe(vector.artifact.canonicalHex);
    const verdict = await verifyDemosGcrDomainClaims(JSON.parse(emitted) as DomainClaimArtifactLike, {
      authenticateArtifact: authenticate(vector.artifact),
      requiredMethod: vector.requiredMethod,
      recipeDefaultMaxAgeSec: vector.recipeDefaultMaxAgeSec,
      evaluatedAt: vector.evaluatedAt,
      resolveGcr: () => resolution(vector),
    });
    expect(verdict.verdict).toBe("pass");
    expect(verdict.semanticClaims).toEqual(vector.want?.semanticClaims);
    expect(verdict.data?.demosGcrDomain).toEqual(vector.authoritativeGcr);
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

  describe("producer input boundary", () => {
    const base = () => structuredClone(
      fixture.vectors.find((v) => v.name === "canonical-production")!.producerInput!,
    );
    type Native = Record<string, unknown> & { sourceTransaction: Record<string, unknown> };
    const native = (input: DomainClaimProducerInput) =>
      input.claims[0]!.metadata["demosGcrDomain"] as Native;
    const hex = "11".repeat(32);
    const secondClaim = (input: DomainClaimProducerInput, hostname: string) => {
      const claim = structuredClone(input.claims[0]!);
      claim.hostname = hostname;
      const meta = claim.metadata["demosGcrDomain"] as Record<string, unknown>;
      meta["hostname"] = hostname;
      meta["proofUrl"] = `https://${hostname}/.well-known/demos-cci.txt`;
      input.claims.push(claim);
    };

    test("emits the corpus bytes for the unmodified control input", () => {
      expect(Buffer.from(serializeDomainClaimArtifact(base()), "utf8").toString("hex")).toBe(
        fixture.vectors.find((v) => v.name === "canonical-production")!.artifact.canonicalHex,
      );
    });

    test.each([
      ["an extra top-level member", (i: Record<string, unknown>) => { i["extra"] = 1; }],
      ["a missing top-level member", (i: Record<string, unknown>) => { delete i["presentedAt"]; }],
      ["another producer version", (i: Record<string, unknown>) => { i["producerVersion"] = "dacs1-domain-v2"; }],
      ["another bundle version", (i: Record<string, unknown>) => { i["bundleVersion"] = "2"; }],
      ["a numeric bundle version", (i: Record<string, unknown>) => { i["bundleVersion"] = 1; }],
      ["a numeric subject", (i: Record<string, unknown>) => { i["subject"] = 7; }],
      ["no claims", (i: Record<string, unknown>) => { i["claims"] = []; }],
      ["claims that are not an array", (i: Record<string, unknown>) => { i["claims"] = {}; }],
      ["a negative presenter index", (i: Record<string, unknown>) => { i["presentedByClaimIndex"] = -1; }],
      ["a presenter index equal to the claim count", (i: Record<string, unknown>) => { i["presentedByClaimIndex"] = 1; }],
      ["a fractional presenter index", (i: Record<string, unknown>) => { i["presentedByClaimIndex"] = 0.5; }],
      ["a negative presentation time", (i: Record<string, unknown>) => { i["presentedAt"] = -1; }],
      ["a fractional presentation time", (i: Record<string, unknown>) => { i["presentedAt"] = 1.5; }],
    ] as const)("refuses %s before emitting bytes", (_label, change) => {
      const input = base();
      change(input as unknown as Record<string, unknown>);
      expect(() => serializeDomainClaimArtifact(input)).toThrow("invalid domain producer input");
    });

    test.each([
      ["an extra member", (c: Record<string, unknown>) => { c["extra"] = 1; }],
      ["a missing member", (c: Record<string, unknown>) => { delete c["metadata"]; }],
    ] as const)("refuses a native claim with %s", (_label, change) => {
      const input = base();
      change(input.claims[0] as unknown as Record<string, unknown>);
      expect(() => serializeDomainClaimArtifact(input)).toThrow("invalid native domain claim input");
    });

    test("refuses a non-domain native context even with valid hostname and metadata", () => {
      const input = base();
      (input.claims[0] as { nativeContext: string }).nativeContext = "web2.other";
      expect(() => serializeDomainClaimArtifact(input)).toThrow(/valid native web2\.domain hostname/);
    });

    test.each([
      ["an array-wrapped account", (n: Native) => { n["account"] = [hex]; }],
      ["an account with a suffix", (n: Native) => { n["account"] = `${hex}x`; }],
      ["a short account", (n: Native) => { n["account"] = hex.slice(1); }],
      ["an array-wrapped transaction hash", (n: Native) => { n.sourceTransaction["txHash"] = [hex]; }],
      ["a transaction hash with a suffix", (n: Native) => { n.sourceTransaction["txHash"] = `${hex}x`; }],
      ["a transaction hash with a prefix", (n: Native) => { n.sourceTransaction["txHash"] = `x${hex}`; }],
      ["a negative recordedAt", (n: Native) => { n["recordedAt"] = -1; }],
      ["a negative blockNumber", (n: Native) => { n.sourceTransaction["blockNumber"] = -1; }],
      ["a fractional blockNumber", (n: Native) => { n.sourceTransaction["blockNumber"] = 0.5; }],
      ["a string recordedAt", (n: Native) => { n["recordedAt"] = "1"; }],
    ] as const)("refuses %s in native metadata", (_label, change) => {
      const input = base();
      change(native(input));
      expect(() => serializeDomainClaimArtifact(input)).toThrow("invalid persistent Demos domain metadata");
    });

    test("accepts zero for every nonnegative time and height", () => {
      const input = base();
      input.presentedAt = 0;
      native(input)["recordedAt"] = 0;
      native(input).sourceTransaction["blockNumber"] = 0;
      const emitted = JSON.parse(serializeDomainClaimArtifact(input));
      expect(emitted.presentedAt).toBe(0);
      expect(emitted.claims[0].metadata.demosGcrDomain.recordedAt).toBe(0);
      expect(emitted.claims[0].metadata.demosGcrDomain.sourceTransaction.blockNumber).toBe(0);
    });

    test("accepts the last claim index and binds presentedBy to that claim", () => {
      const input = base();
      secondClaim(input, "other.example");
      input.presentedByClaimIndex = 1;
      const emitted = JSON.parse(serializeDomainClaimArtifact(input));
      expect(emitted.claims.map((c: { ref: string }) => c.ref)).toEqual(["domain:agent.example", "domain:other.example"]);
      expect(emitted.presentedBy).toBe("domain:other.example");
      input.presentedByClaimIndex = 0;
      expect(JSON.parse(serializeDomainClaimArtifact(input)).presentedBy).toBe("domain:agent.example");
    });
  });

  describe("authenticatedIdentityBundleSemantics", () => {
    const presentation = { kind: "siwd", message: "m", signature: "s", address: "a" } as const;
    const bundle = (claims: IdentityBundle["claims"], presentedBy: string, bundleVersion: unknown = "1") =>
      ({ bundleVersion, presentedBy, presentedAt: 1, claims, presentation }) as unknown as IdentityBundle;

    test.each([undefined, "2", 1])("refuses bundleVersion %s before folding any claim", (version) => {
      const input = bundle([{ ref: "domain:agent.example" }], "domain:agent.example", version);
      if (version === undefined) delete (input as { bundleVersion?: unknown }).bundleVersion;
      expect(() => authenticatedIdentityBundleSemantics(input)).toThrow("domain aliases require bundleVersion 1");
    });

    test("refuses a domain presenter that the bundle does not carry", () => {
      for (const presentedBy of ["domain:other.example", "web2:domain:Other.Example"]) {
        expect(() => authenticatedIdentityBundleSemantics(
          bundle([{ ref: "domain:agent.example" }], presentedBy),
        )).toThrow("semantic domain presenter is not carried by the bundle");
      }
    });

    test("accepts a domain presenter beside another domain and keeps both claims", () => {
      for (const presentedBy of ["domain:other.example", "web2:domain:Other.Example"]) {
        const semantic = authenticatedIdentityBundleSemantics(bundle(
          [{ ref: "domain:agent.example" }, { ref: presentedBy }], presentedBy,
        ));
        expect(semantic.claims.map((c) => c.ref)).toEqual(["domain:agent.example", "domain:other.example"]);
        expect(semantic.presentedBy).toBe("domain:other.example");
      }
    });

    test("keeps every distinct non-presenter domain", () => {
      const semantic = authenticatedIdentityBundleSemantics(bundle([
        { ref: "domain:a.example", metadata: { n: 1 } },
        { ref: "domain:b.example", metadata: { n: 2 } },
        { ref: "web2:domain:C.Example", metadata: { n: 3 } },
      ], "domain:a.example"));
      expect(semantic.claims.map((c) => [c.ref, c.metadata])).toEqual([
        ["domain:a.example", { n: 1 }], ["domain:b.example", { n: 2 }], ["domain:c.example", { n: 3 }],
      ]);
    });

    test("folds aliases to one claim and keeps the one the presenter signed", () => {
      const claims = [
        { ref: "web2:domain:Agent.Example", metadata: { source: "alias" } },
        { ref: "domain:agent.example", metadata: { source: "canonical" } },
      ];
      for (const [presentedBy, source] of [
        ["domain:agent.example", "canonical"], ["web2:domain:Agent.Example", "alias"],
      ] as const) {
        const semantic = authenticatedIdentityBundleSemantics(bundle(structuredClone(claims), presentedBy));
        expect(semantic.claims).toEqual([{ ref: "domain:agent.example", metadata: { source } }]);
      }
    });

    test("preserves non-domain duplicates so ambiguity gates still see them", () => {
      const semantic = authenticatedIdentityBundleSemantics(bundle([
        { ref: "lei:5493001KJTIIGC8Y1R12" }, { ref: "lei:5493001KJTIIGC8Y1R12" },
        { ref: "key:ed25519:abc" }, { ref: "key:ed25519:abc" }, { ref: "domain:agent.example" },
      ], "key:ed25519:abc"));
      expect(semantic.claims.map((c) => c.ref)).toEqual([
        "lei:5493001KJTIIGC8Y1R12", "lei:5493001KJTIIGC8Y1R12", "key:ed25519:abc", "key:ed25519:abc", "domain:agent.example",
      ]);
    });

    test("does not mutate the authenticated original", () => {
      const original = bundle([{ ref: "web2:domain:Agent.Example" }], "web2:domain:Agent.Example");
      const before = structuredClone(original);
      authenticatedIdentityBundleSemantics(original);
      expect(original).toEqual(before);
    });
  });
});
