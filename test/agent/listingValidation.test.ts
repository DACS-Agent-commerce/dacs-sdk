import { describe, expect, test, vi } from "vitest";

import {
  probeListingReachability,
  resolveListingRails,
  validateListingArtifact,
  type ListingValidationDeps,
  type RailDefinition,
  type RailResolutionAttempt,
  type RevocationMarker,
} from "../../src/agent/listingValidation.js";
import type { Listing } from "../../src/artifacts/types.js";
import {
  contentHash,
  listingRevocationAddress,
} from "../../src/canonical/index.js";

const NOW = 1_800_000_000_000;
const SELLER = "did:demos:seller";

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    dacsVersion: "1",
    listingVersion: 1,
    listingId: "market-data",
    seller: {
      identity: {
        bundleVersion: "1",
        presentedBy: SELLER,
        presentedAt: NOW - 1_000,
        claims: [{ ref: SELLER }],
        presentation: {
          kind: "per-claim",
          signatures: [{ ref: SELLER, signature: "presentation" }],
        },
      },
      displayName: "Seller",
      publicEndpoint: "https://seller.example/.well-known/dacs",
    },
    offering: {
      title: "Market data",
      description: "A feed",
      category: "data.finance",
      tags: ["markets"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
      },
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: "pay-x402", parameters: { rail: "x402:default" } },
      { kind: "deliver-attested-payload" },
    ],
    pricing: { kind: "fixed", price: { amount: "1", currency: "USDC" } },
    acceptedRails: [{ railId: "x402:default", railVersion: 2 }],
    terms: {},
    validity: { notBefore: NOW - 10_000, notAfter: NOW + 10_000 },
    signature: { algorithm: "ed25519", signer: SELLER, value: "AQ" },
    ...overrides,
  };
}

function railDefinition(
  railId = "x402:default",
  railVersion = 2,
  phaseHandler = "pay-x402",
): RailDefinition {
  return {
    railVersion,
    railId,
    railType: "x402",
    asset: { kind: "erc20" },
    network: { kind: "x402-resource" },
    phaseHandler,
    parameters: {},
    availability: "live",
    governance: { anchoring: "single-signer" },
    signature: { algorithm: "ed25519", signer: "key:steward", value: "AQ" },
  };
}

function resolvedRail(definition = railDefinition()): RailResolutionAttempt {
  return {
    status: "resolved",
    authority: "pa2-single-signer",
    authenticated: true,
    finalized: true,
    snapshotId: "registry-v7",
    index: {
      railId: definition.railId,
      railVersion: definition.railVersion,
      contentHash: contentHash(definition),
    },
    definition,
  };
}

function deps(overrides: Partial<ListingValidationDeps> = {}): ListingValidationDeps {
  return {
    nowMs: () => NOW,
    verifyArtifactSignature: async () => ({ status: "valid" }),
    verifyIdentityBundle: async (bundle) => ({
      status: "verified",
      controlledClaims: bundle.claims.map((claim) => claim.ref),
    }),
    readRevocationObservations: async () => [
      { source: "well-known", status: "active", integrity: "consistent" },
    ],
    readRevocationMarker: async () => null,
    resolveRail: async () => resolvedRail(),
    validateRailDefinition: async () => true,
    ...overrides,
  };
}

function markerFor(value: Listing): RevocationMarker {
  return {
    listingId: value.listingId,
    listingVersion: value.listingVersion,
    listingContentHash: contentHash(value as unknown as Record<string, unknown>),
    revokedAt: NOW,
    signature: { ...value.signature },
  };
}

describe("DACS-1 Listing validation disposition", () => {
  test("returns verified only after all nine ordered gates succeed", async () => {
    const result = await validateListingArtifact(listing(), deps());
    expect(result.disposition).toBe("verified");
    expect(result.listingPin).toMatchObject({ listingId: "market-data", version: 1 });
    expect(result.evidence.map((entry) => entry.step)).toEqual([
      "schema",
      "version",
      "validity",
      "signature",
      "revocation",
      "identity",
      "pipeline",
      "rails",
      "signer-control",
    ]);
  });

  test("historical MVP reads remain explicitly non-normative and never verify", async () => {
    const result = await validateListingArtifact(
      {
        agentId: SELLER,
        serviceId: "legacy",
        name: "Legacy",
        description: "read only",
        claimRequirements: [],
        supportedNegotiation: ["negotiate-fixed-price"],
        supportedPaymentRails: ["pay-x402"],
        supportedDelivery: ["deliver-attested-payload"],
        signature: "aa",
      },
      deps(),
    );
    expect(result).toMatchObject({
      disposition: "rejected",
      reasons: [{ code: "legacy-read-only" }],
    });
  });

  test("halts stale listings before any authority lookup", async () => {
    const lookup = vi.fn();
    const value = listing({ validity: { notBefore: NOW - 10, notAfter: NOW - 1 } });
    const result = await validateListingArtifact(value, deps({ resolveRail: lookup }));
    expect(result).toMatchObject({ disposition: "rejected", reasons: [{ code: "outside-validity-window" }] });
    expect(lookup).not.toHaveBeenCalled();
  });

  test("valid marker beats a conflicting active record (RB-6)", async () => {
    const value = listing();
    const marker = markerFor(value);
    const markerHash = contentHash(marker as unknown as Record<string, unknown>);
    const result = await validateListingArtifact(
      value,
      deps({
        readRevocationObservations: async () => [
          { source: "catalog", status: "active", integrity: "consistent", catalogObservedAt: NOW },
          {
            source: "well-known",
            status: "revoked",
            integrity: "consistent",
            binding: {
              sellerPrimaryClaim: SELLER,
              listingId: value.listingId,
              listingVersion: value.listingVersion,
              listingContentHash: contentHash(value as unknown as Record<string, unknown>),
              logicalAddress: listingRevocationAddress(SELLER, value.listingId, value.listingVersion),
              markerAnchor: { kind: "storage-program", locator: "stor-marker" },
              markerContentHash: markerHash,
            },
          },
        ],
        readRevocationMarker: async () => marker,
      }),
    );
    expect(result.disposition).toBe("revoked");
    expect(result.evidence.some((entry) => entry.code === "revocation-marker-verified")).toBe(true);
  });

  test.each([
    ["wrong tuple", { listingVersion: 9 }, "revocation-binding-invalid"],
    ["wrong logical address", { logicalAddress: "dacs1-revoked:wrong" }, "revocation-binding-invalid"],
    ["wrong marker hash", { markerContentHash: "0".repeat(64) }, "revocation-marker-mismatch"],
  ])("returns indeterminate for %s instead of trusting a discovery pointer", async (_name, bindingOverride, code) => {
    const value = listing();
    const marker = markerFor(value);
    const result = await validateListingArtifact(
      value,
      deps({
        readRevocationObservations: async () => [{
          source: "catalog",
          status: "revoked",
          integrity: "consistent",
          binding: {
            sellerPrimaryClaim: SELLER,
            listingId: value.listingId,
            listingVersion: value.listingVersion,
            listingContentHash: contentHash(value as unknown as Record<string, unknown>),
            logicalAddress: listingRevocationAddress(SELLER, value.listingId, value.listingVersion),
            markerAnchor: { kind: "storage-program", locator: "stor-marker" },
            markerContentHash: contentHash(marker as unknown as Record<string, unknown>),
            ...bindingOverride,
          },
        }],
        readRevocationMarker: async () => marker,
      }),
    );
    expect(result.disposition).toBe("indeterminate");
    expect(result.evidence.some((entry) => entry.code === code)).toBe(true);
  });

  test("a stale catalog cannot establish revocation absence", async () => {
    const result = await validateListingArtifact(
      listing(),
      deps({
        readRevocationObservations: async () => [{
          source: "catalog",
          status: "active",
          integrity: "consistent",
          catalogObservedAt: NOW - 24 * 60 * 60 * 1_000 - 1,
        }],
      }),
    );
    expect(result).toMatchObject({ disposition: "indeterminate" });
    expect(result.reasons[0]?.code).toBe("revocation-catalog-stale");
  });

  test("rejects a bundle whose presentation does not control presentedBy", async () => {
    const result = await validateListingArtifact(
      listing(),
      deps({ verifyIdentityBundle: async () => ({ status: "verified", controlledClaims: [] }) }),
    );
    expect(result).toMatchObject({ disposition: "rejected", reasons: [{ code: "publisher-claim-uncontrolled" }] });
  });

  test("classifies pipeline coherence at step 7 instead of collapsing it into schema", async () => {
    const result = await validateListingArtifact(
      listing({
        pipeline: [
          { kind: "negotiate-fixed-price" },
          { kind: "commit-agreement" },
          { kind: "pay-x402", parameters: { rail: "x402:default" } },
        ],
      }),
      deps(),
    );
    expect(result).toMatchObject({
      disposition: "rejected",
      reasons: [{ step: "pipeline", code: "pipeline-references-invalid" }],
    });
  });

  test("classifies duplicate canonical PaymentRailRefs at step 8", async () => {
    const duplicate = { railId: "x402:default", railVersion: 2 };
    const result = await validateListingArtifact(
      listing({ acceptedRails: [duplicate, { ...duplicate }] }),
      deps(),
    );
    expect(result).toMatchObject({
      disposition: "rejected",
      reasons: [{ step: "rails", code: "duplicate-rail-reference" }],
    });
  });

  test("retains LRR indeterminate but lets step-9 signer-control failure override it", async () => {
    const value = listing({
      signature: { algorithm: "ed25519", signer: "key:uncontrolled", value: "AQ" },
    });
    const result = await validateListingArtifact(
      value,
      deps({ resolveRail: async () => ({ status: "indeterminate", reason: "registry timeout" }) }),
    );
    expect(result).toMatchObject({
      disposition: "rejected",
      reasons: [{ code: "listing-signer-uncontrolled" }],
      railResolution: { disposition: "indeterminate" },
    });
  });
});

describe("LRR-1..LRR-6 rail resolution", () => {
  test("resolves every advertised ref, including an unused one", async () => {
    const value = listing({
      acceptedRails: [
        { railId: "x402:default", railVersion: 2 },
        { railId: "demos-native:DEM", railVersion: 1 },
      ],
    });
    const seen: string[] = [];
    const result = await resolveListingRails(value, {
      verifyArtifactSignature: async () => ({ status: "valid" }),
      validateRailDefinition: async () => true,
      resolveRail: async (ref) => {
        seen.push(ref.railId);
        return resolvedRail(
          ref.railId === "x402:default"
            ? railDefinition()
            : railDefinition("demos-native:DEM", 1, "pay-dem"),
        );
      },
    });
    expect(seen).toEqual(["x402:default", "demos-native:DEM"]);
    expect(result.disposition).toBe("verified");
  });

  test("authenticated absence is rejected and wins over another indeterminate ref", async () => {
    const value = listing({
      acceptedRails: [
        { railId: "x402:default", railVersion: 2 },
        { railId: "missing:rail", railVersion: 1 },
      ],
    });
    const result = await resolveListingRails(value, {
      verifyArtifactSignature: async () => ({ status: "valid" }),
      validateRailDefinition: async () => true,
      resolveRail: async (ref) => ref.railId === "x402:default"
        ? { status: "indeterminate", reason: "definition unavailable" }
        : { status: "missing", authoritative: true, reason: "not indexed" },
    });
    expect(result.disposition).toBe("rejected");
    expect(result.reasons.map((entry) => entry.code)).toEqual([
      "rail-resolution-indeterminate",
      "rail-not-found",
    ]);
  });

  test.each([
    ["unauthenticated", { ...resolvedRail(), authenticated: false }, "rail-authority-unauthenticated"],
    ["non-final", { ...resolvedRail(), finalized: false }, "rail-receipt-not-finalized"],
  ])("classifies %s registry material as indeterminate", async (_name, attempt, code) => {
    const result = await resolveListingRails(listing(), {
      verifyArtifactSignature: async () => ({ status: "valid" }),
      validateRailDefinition: async () => true,
      resolveRail: async () => attempt as RailResolutionAttempt,
    });
    expect(result.disposition).toBe("indeterminate");
    expect(result.reasons[0]?.code).toBe(code);
  });

  test("rejects a definition whose handler contradicts the listing phase", async () => {
    const result = await resolveListingRails(listing(), {
      verifyArtifactSignature: async () => ({ status: "valid" }),
      validateRailDefinition: async () => true,
      resolveRail: async () => resolvedRail(railDefinition("x402:default", 2, "pay-dem")),
    });
    expect(result.disposition).toBe("rejected");
    expect(result.reasons.some((entry) => entry.code === "rail-handler-contradiction")).toBe(true);
  });

  test("different authenticated snapshots cannot be combined into one verified result", async () => {
    const value = listing({
      acceptedRails: [
        { railId: "x402:default", railVersion: 2 },
        { railId: "demos-native:DEM", railVersion: 1 },
      ],
    });
    const result = await resolveListingRails(value, {
      verifyArtifactSignature: async () => ({ status: "valid" }),
      validateRailDefinition: async () => true,
      resolveRail: async (ref) => ({
        ...resolvedRail(
          ref.railId === "x402:default"
            ? railDefinition()
            : railDefinition("demos-native:DEM", 1, "pay-dem"),
        ),
        snapshotId: ref.railId,
      }),
    });
    expect(result.disposition).toBe("indeterminate");
    expect(result.reasons.some((entry) => entry.code === "rail-snapshot-inconsistent")).toBe(true);
  });
});

describe("reachability stays separate and SSRF-guarded", () => {
  async function* body(...chunks: string[]): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield Buffer.from(chunk);
  }

  test("reports a public HTTPS response as reachable", async () => {
    const result = await probeListingReachability("https://seller.example/dacs", {
      resolveHost: async () => ["93.184.216.34"],
      request: async () => ({ status: 200, body: body("ok") }),
    }, () => NOW);
    expect(result).toMatchObject({ reachability: "reachable", code: "responded", checkedAt: NOW });
  });

  test.each(["127.0.0.1", "10.0.0.2", "169.254.169.254", "::1", "fd00::1"])(
    "blocks private/link-local DNS target %s before request",
    async (address) => {
      const request = vi.fn();
      const result = await probeListingReachability("https://seller.example", {
        resolveHost: async () => [address],
        request,
      });
      expect(result.code).toBe("ssrf-address-blocked");
      expect(request).not.toHaveBeenCalled();
    },
  );

  test("rejects credentials embedded in the endpoint URL", async () => {
    const request = vi.fn();
    const result = await probeListingReachability(
      "https://token:secret@seller.example/dacs",
      { resolveHost: async () => ["93.184.216.34"], request },
    );
    expect(result.code).toBe("unsafe-url");
    expect(request).not.toHaveBeenCalled();
  });

  test("re-resolves and blocks a redirect that pivots to a private host", async () => {
    const request = vi.fn(async () => ({ status: 302, headers: { location: "https://internal.example/secret" } }));
    const result = await probeListingReachability("https://seller.example", {
      resolveHost: async (host) => host === "seller.example" ? ["93.184.216.34"] : ["10.0.0.2"],
      request,
    });
    expect(result.code).toBe("ssrf-address-blocked");
    expect(request).toHaveBeenCalledTimes(1);
  });

  test("caps response bodies", async () => {
    const result = await probeListingReachability("https://seller.example", {
      maxResponseBytes: 3,
      resolveHost: async () => ["93.184.216.34"],
      request: async () => ({ status: 200, body: body("12", "34") }),
    });
    expect(result).toMatchObject({ reachability: "indeterminate", code: "response-too-large" });
  });

  test("enforces timeout even when the request implementation ignores AbortSignal", async () => {
    const result = await probeListingReachability("https://seller.example", {
      timeoutMs: 5,
      resolveHost: async () => ["93.184.216.34"],
      request: async () => new Promise(() => {}),
    });
    expect(result).toMatchObject({ reachability: "unreachable", code: "timeout" });
  });
});
