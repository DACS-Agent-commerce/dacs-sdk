import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assessListingReachability,
  checkListingRevocation,
  resolveListingRails,
  validateListingArtifact,
  type ListingRailResolutionInput,
  type RevocationSurface,
} from "../../src/agent/listingValidation.js";
import { discoverListings } from "../../src/agent/discover.js";
import type {
  IdentityBundle,
  Listing,
  RevocationBinding,
  RevocationMarker,
} from "../../src/artifacts/types.js";
import { ed25519Verify, publicKeyFromRaw } from "../../src/crypto/index.js";
import { contentHash } from "../../src/canonical/index.js";

const ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance/vectors/security",
);
const STANDARD_NEXT_FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/standard-next",
);
const read = (name: string): unknown =>
  JSON.parse(readFileSync(join(ROOT, name), "utf8"));

describe("DACS-1 §6.3.4 LRR-1..LRR-6", () => {
  const vectors = JSON.parse(
    readFileSync(
      join(STANDARD_NEXT_FIXTURES, "listing-rail-registry-resolution-v0.4.json"),
      "utf8",
    ),
  ) as {
    vectors: Array<{
      name: string;
      input: ListingRailResolutionInput;
      expected: "pass" | "fail" | "indeterminate";
      reason: string;
    }>;
  };

  for (const vector of vectors.vectors) {
    it(`replays ${vector.name}`, () => {
      const result = resolveListingRails(vector.input);
      expect(result.disposition).toBe(
        vector.expected === "pass"
          ? "verified"
          : vector.expected === "fail"
            ? "rejected"
            : "indeterminate",
      );
      expect(result.reason).toBe(vector.reason);
    });
  }

});

describe("DACS-1 §6.3.4 RB-1..RB-6", () => {
  const vectors = read("revocation-binding-v0.3.json") as {
    publicKeys: Record<string, string>;
    fixtures: {
      listing: {
        sellerPrimaryClaim: string;
        listingId: string;
        listingVersion: number;
        listingContentHash: string;
        signer: string;
      };
      markers: Record<string, RevocationMarker>;
      bindings: Record<string, RevocationBinding>;
    };
    vectors: Array<{
      name: string;
      surface?: Record<string, unknown>;
      surfaces?: Record<string, unknown>[];
      bindingOverrides?: Partial<RevocationBinding>;
      markerRead: {
        status: string;
        fixture?: string | null;
        signatureOverride?: string;
      };
      want: { revocationCheck: "absent" | "revoked" | "indeterminate" };
    }>;
  };
  const baseListing = read("listing-preserve-unknown-v0.1.json") as {
    fixtures: { "listing-with-inert-extension": { listing: Listing } };
  };
  const now = 1_784_073_600_000;

  const listingForVector = (): Listing => {
    const listing = structuredClone(
      baseListing.fixtures["listing-with-inert-extension"].listing,
    );
    listing.listingId = vectors.fixtures.listing.listingId;
    listing.listingVersion = vectors.fixtures.listing.listingVersion;
    listing.seller.identity.presentedBy =
      vectors.fixtures.listing.sellerPrimaryClaim;
    listing.seller.identity.claims[0]!.ref =
      vectors.fixtures.listing.sellerPrimaryClaim;
    listing.signature.signer = vectors.fixtures.listing.signer;
    return listing;
  };

  const surfaceFor = (raw: Record<string, unknown>): RevocationSurface => {
    const bindingName = raw.binding;
    const baseBinding =
      typeof bindingName === "string"
        ? structuredClone(vectors.fixtures.bindings[bindingName]!)
        : undefined;
    return {
      kind: raw.kind as "well-known" | "catalog",
      status: raw.status as "active" | "revoked",
      ...(raw.kind === "well-known"
        ? {
            integrity:
              raw.integrity === "current-indexHash"
                ? ("verified" as const)
                : ("indeterminate" as const),
          }
        : {
            catalogObservedAt:
              now - Number(raw.catalogAgeHours ?? 0) * 60 * 60 * 1_000,
          }),
      ...(baseBinding ? { binding: baseBinding } : {}),
    };
  };

  for (const vector of vectors.vectors) {
    it(`replays ${vector.name}`, async () => {
      const surfaces = (vector.surfaces ?? [vector.surface!]).map(surfaceFor);
      if (vector.bindingOverrides) {
        for (const surface of surfaces) {
          if (surface.binding) Object.assign(surface.binding, vector.bindingOverrides);
        }
      }
      const result = await checkListingRevocation(
        listingForVector(),
        vectors.fixtures.listing.listingContentHash,
        {
          nowMs: () => now,
          surfaces,
          readMarker: async () => {
            if (vector.markerRead.status === "transport-error") {
              throw new Error("offline");
            }
            const name = vector.markerRead.fixture;
            if (!name) return null;
            const marker = structuredClone(vectors.fixtures.markers[name]!);
            if (vector.markerRead.signatureOverride) {
              marker.signature.value = vector.markerRead.signatureOverride;
            }
            return marker as unknown as Record<string, unknown>;
          },
          verifyMarkerSignature: ({ signedBytes, signature }) => {
            const encoded = vectors.publicKeys[signature.signer];
            if (!encoded) return false;
            return ed25519Verify(
              signedBytes,
              Buffer.from(signature.value, "base64url"),
              publicKeyFromRaw(Buffer.from(encoded, "base64url")),
            );
          },
        },
      );
      expect(result.disposition).toBe(vector.want.revocationCheck);
    });
  }

  it("does not erase a failed consulted surface with an active mirror", async () => {
    const result = await checkListingRevocation(
      listingForVector(),
      vectors.fixtures.listing.listingContentHash,
      {
        nowMs: () => now,
        surfaces: [
          {
            kind: "well-known",
            status: "active",
            readStatus: "unavailable",
            readFailureReason: "surface-transport-failed",
          },
          {
            kind: "catalog",
            status: "active",
            catalogObservedAt: now,
          },
        ],
        readMarker: async () => null,
        verifyMarkerSignature: () => false,
      },
    );
    expect(result).toEqual({
      disposition: "indeterminate",
      reason: "surface-transport-failed",
    });
  });
});

describe("ordered ListingValidationDisposition", () => {
  const source = read("listing-preserve-unknown-v0.1.json") as {
    publicKeys: Record<string, string>;
    fixtures: { "listing-with-inert-extension": { listing: Listing } };
  };
  const fixture = (): Listing =>
    structuredClone(source.fixtures["listing-with-inert-extension"].listing);
  const verify = ({
    signedBytes,
    signature,
  }: {
    signedBytes: Uint8Array;
    signature: { signer: string; value: string };
  }) => {
    const encoded = source.publicKeys[signature.signer];
    return !!encoded &&
      ed25519Verify(
        signedBytes,
        Buffer.from(signature.value, "base64url"),
        publicKeyFromRaw(Buffer.from(encoded, "base64url")),
      );
  };
  const baseDeps = () => ({
    nowMs: () => 1_790_000_000_000,
    verifyListingSignature: verify,
    revocation: {
      surfaces: [
        {
          kind: "well-known" as const,
          status: "active" as const,
          integrity: "verified" as const,
        },
      ],
      readMarker: async () => null,
      verifyMarkerSignature: verify,
    },
    verifyIdentityPresentation: ({ bundle, signedBytes }: {
      bundle: Readonly<IdentityBundle>;
      signedBytes: Uint8Array;
    }) => {
      if (bundle.presentation.kind !== "per-claim") return false;
      const signature = bundle.presentation.signatures.find(
        (candidate) => candidate.ref === bundle.presentedBy,
      );
      if (!signature) return false;
      return verify({
        signedBytes,
        signature: { signer: signature.ref, value: signature.signature },
      });
    },
    verifySellerControl: () => true,
  });

  it("returns verified only after every applicable step succeeds", async () => {
    await expect(
      validateListingArtifact(
        fixture() as unknown as Record<string, unknown>,
        baseDeps(),
      ),
    ).resolves.toMatchObject({
      disposition: "verified",
      step: 9,
      revocation: "absent",
      railResolution: { disposition: "verified", reason: "not-applicable" },
    });
  });

  it("keeps non-verified normative Listings out of discovery", async () => {
    const listing = fixture() as unknown as Record<string, unknown>;
    const common = {
      trustListings: true as const,
      nowMs: () => 1_790_000_000_000,
    };
    await expect(
      discoverListings(["listing"], async () => listing, common),
    ).rejects.toThrow(/validateListing.*signature validity alone/);

    await expect(
      discoverListings(["listing"], async () => listing, {
        ...common,
        validateListing: () => ({
          disposition: "indeterminate",
          step: 5,
          reason: "revocation-unavailable",
          listingContentHash: contentHash(listing),
        }),
      }),
    ).resolves.toEqual([]);

    await expect(
      discoverListings(["listing"], async () => listing, {
        ...common,
        validateListing: () => ({
          disposition: "verified",
          step: 9,
          reason: "verified",
          listingContentHash: contentHash(listing),
        }),
      }),
    ).resolves.toHaveLength(1);

    await expect(
      discoverListings(["listing"], async () => listing, {
        ...common,
        validateListing: () => ({
          disposition: "verified",
          step: 9,
          reason: "verified-different-content",
          listingContentHash: "0".repeat(64),
        }),
      }),
    ).resolves.toEqual([]);
  });

  it("keeps a failed revocation lookup indeterminate", async () => {
    const deps = baseDeps();
    deps.revocation.surfaces = [];
    await expect(
      validateListingArtifact(
        fixture() as unknown as Record<string, unknown>,
        deps,
      ),
    ).resolves.toMatchObject({ disposition: "indeterminate", step: 5 });
  });

  it("applies the supported-major gate as reader step 2", async () => {
    const listing = fixture() as unknown as Record<string, unknown>;
    listing.dacsVersion = "2";
    await expect(
      validateListingArtifact(listing, baseDeps()),
    ).resolves.toMatchObject({
      disposition: "rejected",
      step: 2,
      reason: "unsupported-dacs-major-version",
    });
  });

  it.each([
    {
      name: "schema",
      step: 1,
      mutate: (listing: Record<string, unknown>) => delete listing.listingId,
      deps: {},
    },
    {
      name: "validity",
      step: 3,
      mutate: (listing: Record<string, unknown>) => {
        listing.validity = { notBefore: 1_800_000_000_000 };
      },
      deps: {},
    },
    {
      name: "listing signature",
      step: 4,
      mutate: () => undefined,
      deps: { verifyListingSignature: () => false },
    },
    {
      name: "identity presentation",
      step: 6,
      mutate: () => undefined,
      deps: { verifyIdentityPresentation: () => false },
    },
    {
      name: "seller control",
      step: 9,
      mutate: () => undefined,
      deps: { verifySellerControl: () => false },
    },
  ])("halts at ordered reader step $step for a $name failure", async ({ step, mutate, deps }) => {
    const listing = fixture() as unknown as Record<string, unknown>;
    mutate(listing);
    await expect(
      validateListingArtifact(listing, { ...baseDeps(), ...deps }),
    ).resolves.toMatchObject({ disposition: "rejected", step });
  });

  it("verifies a pay-bearing Listing only after every advertised rail resolves", async () => {
    const listing = fixture();
    listing.pipeline.splice(2, 0, {
      kind: "pay-x402",
      parameters: { rail: "x402:default" },
    });
    listing.acceptedRails = [{ railId: "x402:default" }];
    await expect(
      validateListingArtifact(
        listing as unknown as Record<string, unknown>,
        {
          ...baseDeps(),
          verifyListingSignature: () => true,
          verifyIdentityPresentation: () => true,
          loadRailResolution: () => ({
            trustPhase: "PA-1",
            trustPolicyAcceptsPA1: true,
            registry: { state: "not-used", entries: [], definitions: [] },
            inCodeDefinitions: [
              {
                railId: "x402:default",
                railVersion: 1,
                phaseHandler: "pay-x402",
                governanceAnchoring: "in-code",
                signatureValid: true,
              },
            ],
          }),
        },
      ),
    ).resolves.toMatchObject({
      disposition: "verified",
      step: 9,
      railResolution: {
        disposition: "verified",
        authorityBasis: "pa1-in-code",
      },
    });
  });

  it("rejects an unknown action discriminator at reader step 7", async () => {
    const listing = fixture();
    listing.pipeline[0] = {
      kind: "future-negotiate" as never,
      parameters: {},
    };
    await expect(
      validateListingArtifact(
        listing as unknown as Record<string, unknown>,
        { ...baseDeps(), verifyListingSignature: () => true },
      ),
    ).resolves.toMatchObject({
      disposition: "rejected",
      step: 7,
      reason: "pipeline-invalid",
    });
  });

  it("rejects a pay phase not bound to an accepted rail at reader step 8", async () => {
    const listing = fixture();
    listing.pipeline.splice(2, 0, {
      kind: "pay-x402",
      parameters: { rail: "x402:default" },
    });
    listing.acceptedRails = [{ railId: "evm-erc20:8453:USDC" }];
    await expect(
      validateListingArtifact(
        listing as unknown as Record<string, unknown>,
        {
          ...baseDeps(),
          verifyListingSignature: () => true,
          loadRailResolution: () => ({
            trustPhase: "PA-2",
            registry: { state: "verified-finalized", entries: [], definitions: [] },
          }),
        },
      ),
    ).resolves.toMatchObject({
      disposition: "rejected",
      step: 8,
      reason: "pay-rail-not-accepted",
    });
  });

  it("lets step 9 rejection override a retained LRR indeterminate", async () => {
    const listing = fixture();
    listing.pipeline.splice(2, 0, {
      kind: "pay-x402",
      parameters: { rail: "x402:default" },
    });
    listing.acceptedRails = [{ railId: "x402:default" }];
    listing.signature.signer = "key:uncontrolled";
    const deps = {
      ...baseDeps(),
      verifyListingSignature: () => true,
      verifyIdentityPresentation: () => true,
      loadRailResolution: () => ({
        trustPhase: "PA-2" as const,
        payPhases: [{ kind: "pay-x402", rail: "x402:default" }],
        acceptedRails: listing.acceptedRails!,
        registry: { state: "unavailable" as const, entries: [], definitions: [] },
      }),
    };
    await expect(
      validateListingArtifact(
        listing as unknown as Record<string, unknown>,
        deps,
      ),
    ).resolves.toMatchObject({
      disposition: "rejected",
      step: 9,
      railResolution: { disposition: "indeterminate" },
    });
  });
});

describe("DACS-1 §6.3.4 LP-5 reachability evidence", () => {
  const source = read("listing-preserve-unknown-v0.1.json") as {
    fixtures: { "listing-with-inert-extension": { listing: Listing } };
  };
  const listing = (): Listing => {
    const value = structuredClone(
      source.fixtures["listing-with-inert-extension"].listing,
    );
    value.seller.publicEndpoint = "https://seller.example/.well-known/dacs";
    return value;
  };

  it("reports an actionable public HTTPS surface separately from validity", async () => {
    await expect(
      assessListingReachability(listing(), {
        nowMs: () => 1,
        resolveHost: async () => ["203.0.114.10"],
        probe: async ({ approvedAddresses }) => ({
          status: 200,
          bytes: 100,
          actionable: approvedAddresses[0] === "203.0.114.10",
        }),
      }),
    ).resolves.toMatchObject({ status: "reachable", reason: "actionable" });
  });

  it("accepts a coordinate from the authenticated owning registry without adding a Listing field", async () => {
    const value = listing();
    delete value.seller.publicEndpoint;
    await expect(
      assessListingReachability(value, {
        nowMs: () => 1,
        registryHttpsSurfaces: ["https://rail.example/discovery"],
        resolveHost: async () => ["203.0.114.11"],
        probe: async () => ({ status: 200, bytes: 10, actionable: true }),
      }),
    ).resolves.toMatchObject({
      status: "reachable",
      url: "https://rail.example/discovery",
    });
    expect("communication" in value).toBe(false);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["private", "10.0.0.1"],
    ["link-local", "169.254.169.254"],
    ["IPv6 loopback", "::1"],
    ["expanded IPv4-mapped IPv6", "0:0:0:0:0:ffff:127.0.0.1"],
  ])("blocks %s address resolution before probing", async (_name, address) => {
    let probed = false;
    const result = await assessListingReachability(listing(), {
      nowMs: () => 1,
      resolveHost: async () => [address],
      probe: async () => {
        probed = true;
        return { status: 200, bytes: 1, actionable: true };
      },
    });
    expect(result).toMatchObject({ status: "unreachable", reason: "non-public-address" });
    expect(probed).toBe(false);
  });

  it("validates every DNS answer before probing", async () => {
    let probed = false;
    const result = await assessListingReachability(listing(), {
      nowMs: () => 1,
      resolveHost: async () => ["203.0.114.10", "127.0.0.1"],
      probe: async () => {
        probed = true;
        return { status: 200, bytes: 1, actionable: true };
      },
    });
    expect(result).toMatchObject({
      status: "unreachable",
      reason: "non-public-address",
    });
    expect(probed).toBe(false);
  });

  it("refuses URL credentials and instructs probes to omit ambient credentials", async () => {
    const value = listing();
    value.seller.publicEndpoint = "https://user:secret@seller.example/discovery";
    let probed = false;
    await expect(
      assessListingReachability(value, {
        nowMs: () => 1,
        resolveHost: async () => ["203.0.114.10"],
        probe: async () => {
          probed = true;
          return { status: 200, bytes: 1, actionable: true };
        },
      }),
    ).resolves.toMatchObject({ status: "unreachable", reason: "unsafe-endpoint" });
    expect(probed).toBe(false);

    value.seller.publicEndpoint = "https://seller.example/discovery";
    await assessListingReachability(value, {
      nowMs: () => 2,
      resolveHost: async () => ["203.0.114.10"],
      probe: async (input) => {
        expect(input).toMatchObject({ credentials: "omit", redirect: "error" });
        return { status: 200, bytes: 1, actionable: true };
      },
    });
  });

  it("enforces a whole-request timeout even when the probe does not", async () => {
    const result = await assessListingReachability(listing(), {
      nowMs: () => 1,
      timeoutMs: 5,
      resolveHost: async () => ["203.0.114.10"],
      probe: async () => new Promise<never>(() => undefined),
    });
    expect(result).toMatchObject({ status: "indeterminate", reason: "probe-timeout" });
  });

  it("refuses redirects and oversized responses", async () => {
    const redirected = await assessListingReachability(listing(), {
      nowMs: () => 1,
      resolveHost: async () => ["203.0.114.10"],
      probe: async () => ({ status: 302, bytes: 0, redirected: true, actionable: false }),
    });
    expect(redirected.reason).toBe("redirect-refused");

    const oversized = await assessListingReachability(listing(), {
      nowMs: () => 1,
      maxBytes: 32,
      resolveHost: async () => ["203.0.114.10"],
      probe: async () => ({ status: 200, bytes: 33, actionable: true }),
    });
    expect(oversized.reason).toBe("response-too-large");
  });
});
