import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  assessListingReachability,
  checkListingRevocation,
  resolveListingPayloadVerificationCapability,
  resolveListingRails,
  validateListingArtifact,
  type ListingRailResolutionInput,
  type ListingValidationDeps,
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
import {
  canonicalize,
  contentHash,
  sha256Hex,
} from "../../src/canonical/index.js";

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

  it("does not treat an empty pay-rail definition match as a handler pass", () => {
    expect(
      resolveListingRails({
        trustPhase: "PA-2",
        payPhases: [{ kind: "pay-x402", rail: "x402:default" }],
        acceptedRails: [{ railId: "x402:default" }],
        registry: {
          state: "verified-finalized",
          entries: [
            { railId: "x402:default", latestVersion: 1, versions: [1] },
          ],
          definitions: [],
        },
      }),
    ).toEqual({
      disposition: "indeterminate",
      reason: "rail-definition-unavailable",
      authorityBasis: "pa2",
    });
  });

  const validPa1 = (): ListingRailResolutionInput => ({
    trustPhase: "PA-1",
    trustPolicyAcceptsPA1: true,
    payPhases: [{ kind: "pay-x402", rail: "x402:default" }],
    acceptedRails: [{ railId: "x402:default" }],
    registry: { state: "not-used", entries: [], definitions: [] },
    inCodeDefinitions: [{
      railId: "x402:default",
      railVersion: 1,
      phaseHandler: "pay-x402",
      governanceAnchoring: "in-code",
      signatureValid: true,
    }],
  });

  it.each([
    ["trust phase", (input: Record<string, unknown>) => {
      input.trustPhase = "PA-future";
    }],
    ["PA-1 policy", (input: Record<string, unknown>) => {
      input.trustPolicyAcceptsPA1 = "yes";
    }],
    ["registry state", (input: Record<string, unknown>) => {
      (input.registry as Record<string, unknown>).state = "future";
    }],
  ] as const)("fails closed on a malformed runtime %s", (_name, mutate) => {
    const input = validPa1() as unknown as Record<string, unknown>;
    mutate(input);
    expect(resolveListingRails(input as unknown as ListingRailResolutionInput))
      .toEqual({
        disposition: "indeterminate",
        reason: "rail-authority-malformed",
      });
  });

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
  const admissionCapability = (listing: Listing) => {
    const deliverable = listing.offering.deliverable;
    if (
      deliverable.kind !== "attested-payload" ||
      !deliverable.verificationMethod
    ) {
      throw new Error("fixture drift");
    }
    return {
      operation: "verify" as const,
      disposition: "supported" as const,
      reason: "supported",
      verificationMethodKind: deliverable.verificationMethod.kind,
      verificationMethodHash: sha256Hex(
        canonicalize(deliverable.verificationMethod),
      ),
      deliverableSpecHash: sha256Hex(canonicalize(deliverable)),
    };
  };
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
  const baseDeps = (): ListingValidationDeps => ({
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
    resolvePayloadVerificationCapability: () => ({
      disposition: "supported" as const,
    }),
    verifySellerControl: () => true,
  });

  it("rejects a known but locally unconfigured DPA-1 method at step 7", async () => {
    const listing = fixture();
    const deps = baseDeps();
    delete deps.resolvePayloadVerificationCapability;
    deps.verifyListingSignature = () => true;
    let railReads = 0;
    let controlReads = 0;
    deps.loadRailResolution = () => {
      railReads += 1;
      throw new Error("must not resolve rails after DPA-1 failure");
    };
    deps.verifySellerControl = () => {
      controlReads += 1;
      return true;
    };

    await expect(
      validateListingArtifact(
        listing as unknown as Record<string, unknown>,
        deps,
      ),
    ).resolves.toMatchObject({
      disposition: "rejected",
      step: 7,
      reason: "payload-verification-method-unsupported",
      payloadVerificationCapability: {
        disposition: "unsupported",
        reason: "payload-verification-capability-unconfigured",
      },
    });
    expect(railReads).toBe(0);
    expect(controlReads).toBe(0);
  });

  it("rejects an unknown capability operation without invoking the resolver", async () => {
    let calls = 0;
    await expect(
      resolveListingPayloadVerificationCapability(
        fixture(),
        "future" as never,
        () => {
          calls += 1;
          return { disposition: "supported" };
        },
      ),
    ).resolves.toEqual({
      disposition: "error",
      reason: "payload-verification-capability-operation-invalid",
    });
    expect(calls).toBe(0);
  });

  it.each([
    ["indeterminate", "notary-temporarily-unavailable"],
    ["error", "method-dependency-failed"],
  ] as const)(
    "preserves DPA-1 %s while returning an overall indeterminate Listing",
    async (disposition, reason) => {
      const listing = fixture();
      const deps = baseDeps();
      deps.verifyListingSignature = () => true;
      deps.resolvePayloadVerificationCapability = () => ({
        disposition,
        reason,
      });
      let railReads = 0;
      deps.loadRailResolution = () => {
        railReads += 1;
        throw new Error("must not resolve rails");
      };

      await expect(
        validateListingArtifact(
          listing as unknown as Record<string, unknown>,
          deps,
        ),
      ).resolves.toMatchObject({
        disposition: "indeterminate",
        step: 7,
        reason: `payload-verification-method-${disposition}`,
        payloadVerificationCapability: { disposition, reason },
      });
      expect(railReads).toBe(0);
    },
  );

  it("maps a thrown DPA-1 dependency resolver to method error and Listing indeterminate", async () => {
    const listing = fixture();
    const deps = baseDeps();
    deps.verifyListingSignature = () => true;
    deps.resolvePayloadVerificationCapability = () => {
      throw new Error("offline");
    };

    await expect(
      validateListingArtifact(
        listing as unknown as Record<string, unknown>,
        deps,
      ),
    ).resolves.toMatchObject({
      disposition: "indeterminate",
      step: 7,
      reason: "payload-verification-method-error",
      payloadVerificationCapability: {
        disposition: "error",
        reason: "payload-verification-capability-resolution-threw",
      },
    });
  });

  it("fails closed on a non-snapshotable DPA-1 capability decision", async () => {
    const listing = fixture();
    const deps = baseDeps();
    deps.verifyListingSignature = () => true;
    deps.resolvePayloadVerificationCapability = () => new Proxy(
      { disposition: "supported" as const },
      {},
    );

    await expect(
      validateListingArtifact(
        listing as unknown as Record<string, unknown>,
        deps,
      ),
    ).resolves.toMatchObject({
      disposition: "indeterminate",
      step: 7,
      reason: "payload-verification-method-error",
      payloadVerificationCapability: {
        disposition: "error",
        reason: "payload-verification-capability-resolution-invalid",
      },
    });
  });

  it("requires exact boolean passes from security verifiers", async () => {
    const listing = fixture();
    const deps = baseDeps();
    deps.verifyListingSignature = () => ({}) as unknown as boolean;

    await expect(
      validateListingArtifact(
        listing as unknown as Record<string, unknown>,
        deps,
      ),
    ).resolves.toMatchObject({
      disposition: "rejected",
      step: 4,
      reason: "listing-signature-invalid",
    });
  });

  it("passes the exact signed method/spec and extension-inclusive hashes to the verifier", async () => {
    const listing = fixture();
    const deliverable = listing.offering.deliverable;
    if (deliverable.kind !== "attested-payload") throw new Error("fixture drift");
    const method = {
      kind: "tlsnotary" as const,
      endpoint: "https://notary.example/session",
      extension: { policy: "exact-bytes" },
    };
    deliverable.verificationMethod = method;
    const deps = baseDeps();
    deps.verifyListingSignature = () => true;
    deps.resolvePayloadVerificationCapability = (input) => {
      expect(input.operation).toBe("verify");
      expect(input.verificationMethod).not.toBe(method);
      expect(input.deliverableSpec).not.toBe(deliverable);
      expect(input.verificationMethod).toEqual(method);
      expect(input.deliverableSpec).toEqual(deliverable);
      expect(input.verificationMethod).toHaveProperty(
        "extension.policy",
        "exact-bytes",
      );
      expect(input.verificationMethodHash).toBe(
        sha256Hex(canonicalize(method)),
      );
      expect(input.deliverableSpecHash).toBe(
        sha256Hex(canonicalize(deliverable)),
      );
      return { disposition: "supported" };
    };

    await expect(
      validateListingArtifact(
        listing as unknown as Record<string, unknown>,
        deps,
      ),
    ).resolves.toMatchObject({
      disposition: "verified",
      payloadVerificationCapability: {
        disposition: "supported",
        verificationMethodKind: "tlsnotary",
        verificationMethodHash: sha256Hex(canonicalize(method)),
      },
    });
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

  it("validates and returns an owned snapshot when caller bytes mutate during an await", async () => {
    const listing = fixture();
    const original = structuredClone(listing);
    const deps = baseDeps();
    deps.verifyListingSignature = async () => {
      await Promise.resolve();
      listing.listingId = "mutated-by-caller";
      return true;
    };

    const result = await validateListingArtifact(
      listing as unknown as Record<string, unknown>,
      deps,
    );
    expect(result).toMatchObject({
      disposition: "verified",
      listing: { listingId: original.listingId },
    });
    expect(listing.listingId).toBe("mutated-by-caller");
    expect(result.listing).not.toBe(listing);
    expect(
      contentHash(result.listing as unknown as Record<string, unknown>),
    ).toBe(result.listingContentHash);
    expect(result.listingContentHash).not.toBe(
      contentHash(listing as unknown as Record<string, unknown>),
    );
  });

  it("keeps non-verified normative Listings out of discovery", async () => {
    const listing = fixture() as unknown as Record<string, unknown>;
    const exactListing = listing as unknown as Listing;
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
          listing: exactListing,
          listingContentHash: contentHash(listing),
          payloadVerificationCapability: admissionCapability(exactListing),
        }),
      }),
    ).resolves.toHaveLength(1);

    const liveAdmission = {
      disposition: "verified" as const,
      step: 9 as const,
      reason: "verified",
      listing: exactListing,
      listingContentHash: contentHash(listing),
      payloadVerificationCapability: admissionCapability(exactListing),
    };
    await expect(
      discoverListings(["listing"], async () => listing, {
        ...common,
        validateListing: () => new Proxy(liveAdmission, {}),
      }),
    ).resolves.toEqual([]);

    await expect(
      discoverListings(["listing"], async () => listing, {
        ...common,
        validateListing: (candidate) => {
          const rewritten = candidate as unknown as Listing;
          const deliverable = rewritten.offering.deliverable;
          if (deliverable.kind !== "attested-payload") {
            throw new Error("fixture drift");
          }
          deliverable.payloadFormat = "text/plain";
          return {
            disposition: "verified",
            step: 9,
            reason: "mutated-validator-pass",
            listing: rewritten,
            listingContentHash: contentHash(candidate),
            payloadVerificationCapability: admissionCapability(rewritten),
          };
        },
      }),
    ).resolves.toEqual([]);

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

    const substituted = fixture();
    substituted.listingId = "substituted-listing";
    await expect(
      discoverListings(["listing"], async () => listing, {
        ...common,
        validateListing: () => ({
          disposition: "verified",
          step: 9,
          reason: "verified",
          listing: substituted,
          listingContentHash: contentHash(listing),
          payloadVerificationCapability: admissionCapability(substituted),
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

  it.each([
    ["trust phase", (authority: Record<string, unknown>) => {
      authority.trustPhase = "PA-future";
    }],
    ["PA-1 policy", (authority: Record<string, unknown>) => {
      authority.trustPolicyAcceptsPA1 = "yes";
    }],
    ["registry state", (authority: Record<string, unknown>) => {
      (authority.registry as Record<string, unknown>).state = "future";
    }],
  ] as const)(
    "keeps malformed runtime rail authority %s out of Listing admission",
    async (_name, mutate) => {
      const listing = fixture();
      listing.pipeline.splice(2, 0, {
        kind: "pay-x402",
        parameters: { rail: "x402:default" },
      });
      listing.acceptedRails = [{ railId: "x402:default" }];
      const authority: Record<string, unknown> = {
        trustPhase: "PA-1",
        trustPolicyAcceptsPA1: true,
        registry: { state: "not-used", entries: [], definitions: [] },
        inCodeDefinitions: [{
          railId: "x402:default",
          railVersion: 1,
          phaseHandler: "pay-x402",
          governanceAnchoring: "in-code",
          signatureValid: true,
        }],
      };
      mutate(authority);

      await expect(
        validateListingArtifact(
          listing as unknown as Record<string, unknown>,
          {
            ...baseDeps(),
            verifyListingSignature: () => true,
            verifyIdentityPresentation: () => true,
            loadRailResolution: () => authority as never,
          },
        ),
      ).resolves.toMatchObject({
        disposition: "indeterminate",
        step: 8,
        reason: "rail-authority-malformed",
      });
    },
  );

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

  it("rejects a missing DPA-1 method at step 7 before capability, rail, or control reads", async () => {
    const listing = fixture();
    const deliverable = listing.offering.deliverable;
    if (deliverable.kind !== "attested-payload") throw new Error("fixture drift");
    delete deliverable.verificationMethod;
    let capabilityReads = 0;
    let railReads = 0;
    let controlReads = 0;
    const deps = baseDeps();
    deps.verifyListingSignature = () => true;
    deps.resolvePayloadVerificationCapability = () => {
      capabilityReads += 1;
      return { disposition: "supported" };
    };
    deps.loadRailResolution = () => {
      railReads += 1;
      throw new Error("must not resolve rails");
    };
    deps.verifySellerControl = () => {
      controlReads += 1;
      return true;
    };

    await expect(
      validateListingArtifact(
        listing as unknown as Record<string, unknown>,
        deps,
      ),
    ).resolves.toMatchObject({
      disposition: "rejected",
      step: 7,
      reason: "pipeline-invalid",
    });
    expect(capabilityReads).toBe(0);
    expect(railReads).toBe(0);
    expect(controlReads).toBe(0);

    let orderedReads = 0;
    await expect(
      discoverListings(
        ["listing"],
        async () => listing as unknown as Record<string, unknown>,
        {
        trustListings: true,
        nowMs: deps.nowMs,
        validateListing: (raw) => {
          orderedReads += 1;
          return validateListingArtifact(raw, deps);
        },
        },
      ),
    ).resolves.toEqual([]);
    expect(orderedReads).toBe(1);
  });

  it.each([
    ["tlsnotary", { kind: "tlsnotary", endpoint: "" }],
    ["zktls-provider", { kind: "zktls", provider: "", programId: "program" }],
    ["zktls-program", { kind: "zktls", provider: "reclaim", programId: "" }],
    ["proxy", { kind: "consensus-backed-proxy", endpoint: { method: "GET", urlTemplate: "" } }],
    ["oauth-provider", { kind: "oauth-attested", provider: "", scopes: ["openid"], maxTokenAgeSec: 60 }],
    ["oauth-scope", { kind: "oauth-attested", provider: "oidc", scopes: [""], maxTokenAgeSec: 60 }],
    ["evm-contract", { kind: "evm-rpc", chainId: 1, contract: "0xabc", method: "ownerOf" }],
    ["evm-method", { kind: "evm-rpc", chainId: 1, contract: `0x${"1".repeat(40)}`, method: "" }],
  ])("classifies malformed DPA-1 method $0 at ordered reader step 1 before resolution", async (_name, method) => {
    const listing = fixture();
    const deliverable = listing.offering.deliverable;
    if (deliverable.kind !== "attested-payload") throw new Error("fixture drift");
    deliverable.verificationMethod = method as never;
    let capabilityReads = 0;
    const deps = baseDeps();
    deps.resolvePayloadVerificationCapability = () => {
      capabilityReads += 1;
      return { disposition: "supported" };
    };
    await expect(
      validateListingArtifact(
        listing as unknown as Record<string, unknown>,
        deps,
      ),
    ).resolves.toMatchObject({
      disposition: "rejected",
      step: 1,
      reason: "schema-invalid",
    });
    expect(capabilityReads).toBe(0);
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
