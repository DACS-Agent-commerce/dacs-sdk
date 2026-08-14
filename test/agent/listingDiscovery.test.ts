import { describe, expect, test, vi } from "vitest";

import {
  enumerateListingsForSeller,
  readListingByLogicalAddress,
  type ListingDiscoveryDeps,
} from "../../src/agent/listingDiscovery.js";
import type { ListingValidationDeps } from "../../src/agent/listingValidation.js";
import { buildSignedArtifact } from "../../src/agent/signedArtifact.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import { signComponentArtifact } from "../../src/artifacts/signatures.js";
import type { ListingDraft } from "../../src/artifacts/types.js";
import {
  contentHash,
  listingAddress,
  stripSignature,
} from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import {
  createInMemoryBindingIndex,
  type AnchorBinding,
  type BindingIndex,
} from "../../src/discovery/index.js";

const seller = (seedByte: number) => {
  const seed = Uint8Array.from(Buffer.alloc(32, seedByte));
  const privateKey = privateKeyFromSeed(seed);
  const publicKey = rawPublicKey(publicKeyFromSeed(seed));
  const owner = Buffer.from(publicKey).toString("hex");
  return {
    privateKey,
    publicKey,
    owner,
    did: `did:demos:agent:${owner}`,
  };
};

const SELLER = seller(7);
const OTHER = seller(9);
const verify = (
  bytes: Uint8Array,
  signature: Uint8Array,
  publicKey: Uint8Array,
) => ed25519Verify(bytes, signature, publicKeyFromRaw(publicKey));

interface Fixture {
  logicalAddress: string;
  nativeAddress: string;
  record: Record<string, unknown>;
  binding: AnchorBinding;
}

async function listingFixture(options: {
  serviceId?: string;
  version?: number;
  omitV1?: boolean;
  body?: Record<string, unknown>;
  signer?: typeof SELLER.privateKey;
  owner?: string;
  bindingOver?: Partial<AnchorBinding>;
} = {}): Promise<Fixture> {
  const serviceId = options.serviceId ?? "market-data";
  const version = options.version ?? 1;
  const body = options.body ?? {
    agentId: SELLER.did,
    serviceId,
    name: "Market Data",
    description: "End-of-day prices",
    claimRequirements: [],
    supportedNegotiation: ["negotiate-fixed-price"],
    supportedPaymentRails: ["pay-x402"],
    supportedDelivery: ["deliver-attested-payload"],
    ...(version === 1 && options.omitV1 ? {} : { listingVersion: version }),
  };
  const record = (await buildSignedArtifact(
    body,
    ARTIFACT_SEPARATORS.Listing,
    (bytes) => ed25519Sign(bytes, options.signer ?? SELLER.privateKey),
  )) as unknown as Record<string, unknown>;
  const logicalAddress = listingAddress(SELLER.did, serviceId, version);
  const nativeAddress = `stor-${serviceId}-${version}`;
  return {
    logicalAddress,
    nativeAddress,
    record,
    binding: {
      logicalAddress,
      nativeAddress,
      owner: options.owner ?? SELLER.owner,
      contentHash: contentHash(record),
      version,
      ...options.bindingOver,
    },
  };
}

async function normativeListingFixture(options: {
  listingId?: string;
  version?: number;
  signer?: typeof SELLER.privateKey;
} = {}): Promise<Fixture> {
  const listingId = options.listingId ?? "normative-market-data";
  const version = options.version ?? 1;
  const draft: ListingDraft = {
    dacsVersion: "1",
    listingVersion: version,
    listingId,
    seller: {
      identity: {
        bundleVersion: "1",
        presentedBy: SELLER.did,
        presentedAt: 1_780_000_000_000,
        claims: [{ ref: SELLER.did }],
        presentation: {
          kind: "per-claim",
          signatures: [{ ref: SELLER.did, signature: "identity-presentation" }],
        },
      },
      displayName: "Normative Market Data",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Normative Market Data",
      description: "Authenticated logical discovery",
      category: "data.finance",
      tags: ["market-data"],
      deliverable: {
        kind: "attested-payload",
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" },
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
    acceptedRails: [{ railId: "x402:default" }],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: 1_700_000_000_000 },
  };
  const record = await signComponentArtifact(
    draft,
    ARTIFACT_SEPARATORS.Listing,
    {
      algorithm: "ed25519",
      signer: SELLER.did,
      sign: (bytes) => ed25519Sign(
        bytes,
        options.signer ?? SELLER.privateKey,
      ),
    },
  ) as unknown as Record<string, unknown>;
  const logicalAddress = listingAddress(SELLER.did, listingId, version);
  const nativeAddress = `stor-${listingId}-${version}`;
  return {
    logicalAddress,
    nativeAddress,
    record,
    binding: {
      logicalAddress,
      nativeAddress,
      owner: SELLER.owner,
      contentHash: contentHash(record),
      version,
    },
  };
}

function depsFor(
  fixtures: readonly Fixture[],
  over: Partial<ListingDiscoveryDeps> = {},
): ListingDiscoveryDeps {
  const records = new Map(
    fixtures.map((fixture) => [fixture.nativeAddress, fixture.record]),
  );
  return {
    index: createInMemoryBindingIndex(
      fixtures.map((fixture) => fixture.binding),
    ),
    readAnchor: async (nativeAddress) => records.get(nativeAddress) ?? null,
    verify,
    ...over,
  };
}

function normativeValidationDeps(): ListingValidationDeps {
  return {
    nowMs: () => 1_780_000_000_000,
    verifyListingSignature: ({ signedBytes, signature }) =>
      signature.signer === SELLER.did &&
      ed25519Verify(
        signedBytes,
        Uint8Array.from(Buffer.from(signature.value, "base64url")),
        publicKeyFromRaw(SELLER.publicKey),
      ),
    revocation: {
      surfaces: [{
        kind: "well-known",
        status: "active",
        integrity: "verified",
      }],
      readMarker: async () => null,
      verifyMarkerSignature: () => false,
    },
    verifyIdentityPresentation: () => true,
    loadRailResolution: () => ({
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
    }),
    resolvePayloadVerificationCapability: () => ({
      disposition: "supported",
    }),
    verifySellerControl: ({ signer }) => signer === SELLER.did,
  };
}

describe("readListingByLogicalAddress (#54)", () => {
  test("authenticates a normative component-signed Listing", async () => {
    const fixture = await normativeListingFixture();
    await expect(
      readListingByLogicalAddress(
        fixture.logicalAddress,
        depsFor([fixture], {
          listingValidationDeps: normativeValidationDeps(),
        }),
      ),
    ).resolves.toMatchObject({
      status: "verified",
      compatibility: "normative",
      logicalAddress: fixture.logicalAddress,
      ref: fixture.nativeAddress,
      version: 1,
      contentHash: fixture.binding.contentHash,
      listingPin: {
        listingId: "normative-market-data",
        version: 1,
        contentHash: fixture.binding.contentHash,
      },
      listing: {
        listingId: "normative-market-data",
        seller: { identity: { presentedBy: SELLER.did } },
        signature: { algorithm: "ed25519", signer: SELLER.did },
      },
    });
  });

  test("rejects a normative Listing signed with the wrong seller key", async () => {
    const fixture = await normativeListingFixture({ signer: OTHER.privateKey });
    await expect(
      readListingByLogicalAddress(
        fixture.logicalAddress,
        depsFor([fixture], {
          listingValidationDeps: normativeValidationDeps(),
        }),
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      check: "validation",
      code: "listing-validation-failed",
      validation: { disposition: "rejected", step: 4 },
    });
  });

  test("fails indeterminate when normative ordered-validation policy is absent", async () => {
    const fixture = await normativeListingFixture();
    await expect(
      readListingByLogicalAddress(
        fixture.logicalAddress,
        depsFor([fixture]),
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      stage: "validation",
      reason: expect.stringContaining("ordered validation dependencies"),
    });
  });

  test("authenticates a v1 Listing from only its logical address", async () => {
    const fixture = await listingFixture({ omitV1: true });
    const result = await readListingByLogicalAddress(
      fixture.logicalAddress,
      depsFor([fixture]),
    );

    expect(result).toMatchObject({
      status: "authenticated",
      compatibility: "legacy-mvp",
      logicalAddress: fixture.logicalAddress,
      ref: fixture.nativeAddress,
      version: 1,
      contentHash: fixture.binding.contentHash,
      listing: {
        agentId: SELLER.did,
        serviceId: "market-data",
      },
    });
    if (result.status === "authenticated") {
      expect("signature" in result.listing).toBe(false);
    }
  });

  test("rejects noncanonical and unsafe logical addresses before index I/O", async () => {
    const resolve = vi.fn(async () => ({ status: "absent" as const }));
    const deps = depsFor([], { index: { resolve } });
    const invalid = [
      `dacs1:did%3ademos%3Aagent%3A${SELLER.owner}:svc:v1`,
      `dacs1:did%3Ademos%3Aagent%3A${SELLER.owner.toUpperCase()}:svc:v1`,
      `dacs1:did%3Ademos%3Aagent%3A${SELLER.owner}:svc:v9007199254740992`,
      ` dacs1:did%3Ademos%3Aagent%3A${SELLER.owner}:svc:v1`,
      `dacs1:did%3Ademos%3Aagent%3A${SELLER.owner}:svc\ud800:v1`,
    ];

    for (const address of invalid) {
      await expect(readListingByLogicalAddress(address, deps)).resolves.toMatchObject({
        status: "invalid-address",
      });
    }
    await expect(
      readListingByLogicalAddress(null as never, deps),
    ).resolves.toMatchObject({
      status: "invalid-address",
      logicalAddress: null,
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  test("distinguishes absent, index failure, unreadable, and read failure", async () => {
    const fixture = await listingFixture();
    await expect(
      readListingByLogicalAddress(fixture.logicalAddress, {
        ...depsFor([]),
        index: { resolve: async () => ({ status: "absent" }) },
      }),
    ).resolves.toMatchObject({ status: "absent" });
    await expect(
      readListingByLogicalAddress(fixture.logicalAddress, {
        ...depsFor([]),
        index: {
          resolve: async () => {
            throw new Error("catalog offline");
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "indeterminate",
      stage: "index",
      reason: expect.stringContaining("catalog offline"),
    });
    await expect(
      readListingByLogicalAddress(fixture.logicalAddress, {
        ...depsFor([fixture]),
        readAnchor: async () => null,
      }),
    ).resolves.toMatchObject({
      status: "unreadable",
      nativeAddress: fixture.nativeAddress,
    });
    await expect(
      readListingByLogicalAddress(fixture.logicalAddress, {
        ...depsFor([fixture]),
        readAnchor: async () => {
          throw new Error("RPC timeout");
        },
      }),
    ).resolves.toMatchObject({
      status: "indeterminate",
      stage: "read",
      reason: expect.stringContaining("RPC timeout"),
    });
  });

  test("rejects a lying index's logical address, owner, version, and native tuple", async () => {
    const fixture = await listingFixture();
    const cases: Array<[Partial<AnchorBinding>, string]> = [
      [{ logicalAddress: listingAddress(SELLER.did, "other", 1) }, "logical-address-mismatch"],
      [{ owner: OTHER.owner }, "owner-mismatch"],
      [{ version: 2 }, "version-mismatch"],
      [{ nativeAddress: "stor-other" }, "native-address-mismatch"],
      [{ nativeAddress: ` ${fixture.nativeAddress}` }, "malformed-binding"],
      [{ revoked: "true" as never }, "malformed-binding"],
    ];
    for (const [over, code] of cases) {
      const index: BindingIndex = {
        resolve: async () => ({
          status: "present",
          binding: { ...fixture.binding, ...over },
        }),
      };
      const result = await readListingByLogicalAddress(
        fixture.logicalAddress,
        depsFor([fixture], { index }),
        code === "native-address-mismatch" ? fixture.nativeAddress : undefined,
      );
      expect(result).toMatchObject({ status: "rejected", code });
      expect("ref" in result).toBe(false);
      expect("listing" in result).toBe(false);
    }
  });

  test("rejects hash mismatch, wrong signer, cross-service lift, and cross-version lift", async () => {
    const valid = await listingFixture();
    const wrongSigner = await listingFixture({ signer: OTHER.privateKey });
    const crossService = await listingFixture({
      body: {
        ...stripSignature(valid.record),
        serviceId: "other-service",
      },
    });
    const crossVersion = await listingFixture({
      body: {
        agentId: SELLER.did,
        serviceId: "market-data",
        name: "Market Data",
        description: "v2 lifted into v1",
        claimRequirements: [],
        supportedNegotiation: ["negotiate-fixed-price"],
        supportedPaymentRails: ["pay-x402"],
        supportedDelivery: ["deliver-attested-payload"],
        listingVersion: 2,
      },
    });

    const hashMismatch = {
      ...valid,
      binding: { ...valid.binding, contentHash: "0".repeat(64) },
    };
    expect(
      await readListingByLogicalAddress(
        valid.logicalAddress,
        depsFor([hashMismatch]),
      ),
    ).toMatchObject({ status: "rejected", code: "content-hash-mismatch" });
    expect(
      await readListingByLogicalAddress(
        wrongSigner.logicalAddress,
        depsFor([wrongSigner]),
      ),
    ).toMatchObject({ status: "rejected", code: "signature-invalid" });

    const liftedService = {
      ...crossService,
      logicalAddress: valid.logicalAddress,
      binding: {
        ...valid.binding,
        contentHash: contentHash(crossService.record),
      },
    };
    expect(
      await readListingByLogicalAddress(
        valid.logicalAddress,
        depsFor([liftedService]),
      ),
    ).toMatchObject({ status: "rejected", code: "service-mismatch" });

    const liftedVersion = {
      ...crossVersion,
      logicalAddress: valid.logicalAddress,
      binding: {
        ...valid.binding,
        contentHash: contentHash(crossVersion.record),
      },
    };
    expect(
      await readListingByLogicalAddress(
        valid.logicalAddress,
        depsFor([liftedVersion]),
      ),
    ).toMatchObject({ status: "rejected", code: "version-mismatch" });
  });

  test("rejects invalid standalone envelopes and structurally invalid signed bytes", async () => {
    const valid = await listingFixture();
    const signatures = {
      ...valid.record,
      signatures: [{ signer: SELLER.did }],
    };
    const withSignatures: Fixture = {
      ...valid,
      record: signatures,
      binding: { ...valid.binding, contentHash: contentHash(signatures) },
    };
    expect(
      await readListingByLogicalAddress(
        valid.logicalAddress,
        depsFor([withSignatures]),
      ),
    ).toMatchObject({
      status: "rejected",
      code: "invalid-signature-envelope",
    });

    const malformed = await listingFixture({
      body: {
        agentId: SELLER.did,
        serviceId: "market-data",
        name: "Market Data",
        description: "bad",
        claimRequirements: [],
        supportedNegotiation: [],
        supportedPaymentRails: [],
        supportedDelivery: "not-an-array",
        listingVersion: 1,
      },
    });
    expect(
      await readListingByLogicalAddress(
        malformed.logicalAddress,
        depsFor([malformed]),
      ),
    ).toMatchObject({
      status: "rejected",
      code: "unsupported-listing-shape",
    });

    const oddSignature: Fixture = {
      ...valid,
      record: { ...valid.record, signature: "abc" },
    };
    oddSignature.binding = {
      ...valid.binding,
      contentHash: contentHash(oddSignature.record),
    };
    expect(
      await readListingByLogicalAddress(
        valid.logicalAddress,
        depsFor([oddSignature]),
      ),
    ).toMatchObject({
      status: "rejected",
      code: "invalid-signature-envelope",
    });
  });

  test("does not allow an unsigned __proto__ field to ride on a valid hash/signature", async () => {
    const valid = await listingFixture();
    const injectedRecord = Object.fromEntries([
      ...Object.entries(valid.record),
      ["__proto__", { serviceId: "unsigned-service" }],
    ]);
    const injected: Fixture = { ...valid, record: injectedRecord };

    await expect(
      readListingByLogicalAddress(valid.logicalAddress, depsFor([injected])),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "content-hash-mismatch",
    });
  });

  test("rejects a sparse array that would otherwise collide with a signed empty array", async () => {
    const valid = await listingFixture();
    const sparse = new Array(1);
    const injected: Fixture = {
      ...valid,
      record: { ...valid.record, supportedDelivery: sparse },
    };

    await expect(
      readListingByLogicalAddress(valid.logicalAddress, depsFor([injected])),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "content-not-canonical",
    });
  });

  test("pins the record before an asynchronous verifier observes caller mutation", async () => {
    const fixture = await listingFixture();
    let entered!: () => void;
    const verifierEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = readListingByLogicalAddress(
      fixture.logicalAddress,
      depsFor([fixture], {
        verify: async (bytes, signature, key) => {
          entered();
          await gate;
          return verify(bytes, signature, key);
        },
      }),
    );
    await verifierEntered;
    fixture.record.serviceId = "mutated-after-read";
    release();

    await expect(pending).resolves.toMatchObject({
      status: "authenticated",
      listing: { serviceId: "market-data" },
    });
  });

  test("keeps an execution failure distinct from a definitively invalid signature", async () => {
    const fixture = await listingFixture();
    await expect(
      readListingByLogicalAddress(
        fixture.logicalAddress,
        depsFor([fixture], {
          verify: async () => {
            throw new Error("crypto provider unavailable");
          },
        }),
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      stage: "verification",
      reason: expect.stringContaining("crypto provider unavailable"),
    });
  });
});

describe("enumerateListingsForSeller (#54)", () => {
  test("pages through authenticated historical versions and ignores other artifact kinds", async () => {
    const v1 = await listingFixture({ omitV1: true });
    const v2 = await listingFixture({ version: 2 });
    const seenOwners: string[] = [];
    const pages = [
      {
        entries: [
          {
            nativeAddress: v1.nativeAddress,
            logicalAddress: v1.logicalAddress,
            owner: `0x${SELLER.owner}`,
          },
          {
            nativeAddress: "stor-agreement",
            logicalAddress: "dacs3:commit:job-1",
            owner: SELLER.owner,
          },
        ],
        nextCursor: "page-2",
      },
      {
        entries: [
          {
            nativeAddress: v2.nativeAddress,
            logicalAddress: v2.logicalAddress,
            owner: SELLER.owner,
          },
        ],
        nextCursor: null,
      },
    ];
    const deps = depsFor([v1, v2], {
      createHistoryPageFetcher: (owner) => {
        seenOwners.push(owner);
        return async (cursor) => pages[cursor === null ? 0 : 1]!;
      },
    });

    const first = await enumerateListingsForSeller(SELLER.did, deps);
    expect(first).toMatchObject({
      status: "page",
      listings: [{ ref: v1.nativeAddress, version: 1 }],
      diagnostics: [],
      nextCursor: "page-2",
    });
    const second = await enumerateListingsForSeller(SELLER.did, deps, {
      cursor: "page-2",
    });
    expect(second).toMatchObject({
      status: "page",
      listings: [{ ref: v2.nativeAddress, version: 2 }],
      diagnostics: [],
      nextCursor: null,
    });
    expect(seenOwners).toEqual([SELLER.owner, SELLER.owner]);
  });

  test("a deterministic bad candidate is diagnosed without suppressing a later valid one", async () => {
    const bad = await listingFixture({ serviceId: "bad", signer: OTHER.privateKey });
    const good = await listingFixture({ serviceId: "good" });
    const deps = depsFor([bad, good], {
      createHistoryPageFetcher: () => async () => ({
        entries: [bad, good].map((fixture) => ({
          nativeAddress: fixture.nativeAddress,
          logicalAddress: fixture.logicalAddress,
          owner: SELLER.owner,
        })),
        nextCursor: null,
      }),
    });

    const result = await enumerateListingsForSeller(SELLER.did, deps);
    expect(result).toMatchObject({
      status: "page",
      listings: [{ ref: good.nativeAddress }],
      diagnostics: [
        {
          nativeAddress: bad.nativeAddress,
          result: { status: "rejected", code: "signature-invalid" },
        },
      ],
    });
  });

  test("history and mid-page index/read uncertainty are atomic and retry the input cursor", async () => {
    const first = await listingFixture({ serviceId: "first" });
    const second = await listingFixture({ serviceId: "second" });
    const page = {
      entries: [first, second].map((fixture) => ({
        nativeAddress: fixture.nativeAddress,
        logicalAddress: fixture.logicalAddress,
        owner: SELLER.owner,
      })),
      nextCursor: "next",
    };

    await expect(
      enumerateListingsForSeller(
        SELLER.did,
        depsFor([], {
          createHistoryPageFetcher: () => async () => {
            throw new Error("history offline");
          },
        }),
        { cursor: "retry-me" },
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      stage: "history",
      listings: [],
      retryCursor: "retry-me",
    });

    const baseIndex = createInMemoryBindingIndex([first.binding, second.binding]);
    const index: BindingIndex = {
      resolve: async (logical, owner) => {
        if (logical === second.logicalAddress) {
          return { status: "indeterminate", reason: "catalog timeout" };
        }
        return baseIndex.resolve(logical, owner);
      },
    };
    await expect(
      enumerateListingsForSeller(
        SELLER.did,
        depsFor([first, second], {
          index,
          createHistoryPageFetcher: () => async () => page,
        }),
        { cursor: "retry-me" },
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      stage: "index",
      listings: [],
      diagnostics: [],
      retryCursor: "retry-me",
    });

    let verificationCount = 0;
    await expect(
      enumerateListingsForSeller(
        SELLER.did,
        depsFor([first, second], {
          verify: async (...args) => {
            verificationCount += 1;
            if (verificationCount === 2) {
              throw new Error("crypto provider offline");
            }
            return verify(...args);
          },
          createHistoryPageFetcher: () => async () => page,
        }),
        { cursor: "retry-me" },
      ),
    ).resolves.toMatchObject({
      status: "indeterminate",
      stage: "verification",
      listings: [],
      diagnostics: [],
      retryCursor: "retry-me",
    });
  });

  test("defines independent cursor pages as at-least-once", async () => {
    const fixture = await listingFixture();
    const entry = {
      nativeAddress: fixture.nativeAddress,
      logicalAddress: fixture.logicalAddress,
      owner: SELLER.owner,
    };
    const deps = depsFor([fixture], {
      createHistoryPageFetcher: () => async (cursor) =>
        cursor === null
          ? { entries: [entry], nextCursor: "overlap" }
          : { entries: [entry], nextCursor: null },
    });

    const first = await enumerateListingsForSeller(SELLER.did, deps);
    const second = await enumerateListingsForSeller(SELLER.did, deps, {
      cursor: "overlap",
    });
    expect(first).toMatchObject({
      status: "page",
      listings: [{ ref: fixture.nativeAddress }],
      nextCursor: "overlap",
    });
    expect(second).toMatchObject({
      status: "page",
      listings: [{ ref: fixture.nativeAddress }],
      nextCursor: null,
    });
  });

  test("advances past definitive binding absence and finds a late repair on restart", async () => {
    const fixture = await listingFixture();
    let repaired = false;
    const index: BindingIndex = {
      resolve: async () =>
        repaired
          ? { status: "present", binding: fixture.binding }
          : { status: "absent" },
    };
    const deps = depsFor([fixture], {
      index,
      createHistoryPageFetcher: () => async () => ({
        entries: [
          {
            nativeAddress: fixture.nativeAddress,
            logicalAddress: fixture.logicalAddress,
            owner: SELLER.owner,
          },
        ],
        nextCursor: null,
      }),
    });

    await expect(
      enumerateListingsForSeller(SELLER.did, deps),
    ).resolves.toMatchObject({
      status: "page",
      listings: [],
      diagnostics: [{ result: { status: "absent" } }],
      nextCursor: null,
    });
    repaired = true;
    await expect(
      enumerateListingsForSeller(SELLER.did, deps, { cursor: null }),
    ).resolves.toMatchObject({
      status: "page",
      listings: [{ ref: fixture.nativeAddress }],
      diagnostics: [],
    });
  });

  test("rejects invalid sellers and history/native owner mismatches", async () => {
    const fixture = await listingFixture();
    const fetch = vi.fn(async () => ({ entries: [], nextCursor: null }));
    await expect(
      enumerateListingsForSeller(SELLER.owner, depsFor([], {
        createHistoryPageFetcher: () => fetch,
      })),
    ).resolves.toMatchObject({ status: "invalid-seller" });
    await expect(
      enumerateListingsForSeller(null as never, depsFor([], {
        createHistoryPageFetcher: () => fetch,
      })),
    ).resolves.toMatchObject({ status: "invalid-seller", sellerId: null });
    expect(fetch).not.toHaveBeenCalled();

    const result = await enumerateListingsForSeller(
      SELLER.did,
      depsFor([fixture], {
        createHistoryPageFetcher: () => async () => ({
          entries: [
            {
              nativeAddress: fixture.nativeAddress,
              logicalAddress: fixture.logicalAddress,
              owner: OTHER.owner,
            },
          ],
          nextCursor: null,
        }),
      }),
    );
    expect(result).toMatchObject({
      status: "page",
      listings: [],
      diagnostics: [
        { result: { status: "rejected", code: "history-owner-mismatch" } },
      ],
    });
  });

  test("rejects invalid paging options before history adapter setup", async () => {
    const fetch = vi.fn(async () => ({ entries: [], nextCursor: null }));
    const setup = vi.fn(() => fetch);
    const deps = depsFor([], { createHistoryPageFetcher: setup });
    for (const options of [
      { cursor: "" },
      { cursor: 42 },
      { historyPageSize: 0 },
      { historyPageSize: 1.5 },
      { historyPageSize: 101 },
      null,
    ]) {
      await expect(
        enumerateListingsForSeller(SELLER.did, deps, options as never),
      ).resolves.toMatchObject({ status: "invalid-options" });
    }
    expect(setup).not.toHaveBeenCalled();

    await expect(
      enumerateListingsForSeller(SELLER.did, deps, { historyPageSize: 37 }),
    ).resolves.toMatchObject({ status: "page" });
    expect(fetch).toHaveBeenCalledWith(null, 37);
  });
});
