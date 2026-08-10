import { describe, expect, test } from "vitest";

import {
  publishListingCore,
  type PublishListingDeps,
} from "../../src/agent/publishListingCore.js";
import { ARTIFACT_SEPARATORS } from "../../src/artifacts/registry.js";
import {
  signComponentArtifact,
  verifyComponentSignature,
} from "../../src/artifacts/signatures.js";
import {
  contentHash,
  listingAddress,
  logicalToStorageProgramName,
} from "../../src/canonical/index.js";
import {
  ed25519Sign,
  ed25519Verify,
  privateKeyFromSeed,
  publicKeyFromRaw,
  publicKeyFromSeed,
  rawPublicKey,
} from "../../src/crypto/index.js";
import { DacsError, SubstrateError } from "../../src/errors.js";

const SELLER = "did:demos:agent:seller";
const priv = privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 7)));
const sign = (bytes: Uint8Array) => ed25519Sign(bytes, priv);

/** In-memory anchor store implementing the write-once seam. */
function fakeDeps() {
  const store = new Map<string, Record<string, unknown>>();
  const addresses = new Map<string, string>();
  const stats = { creates: 0 };
  const deps: PublishListingDeps & {
    store: Map<string, Record<string, unknown>>;
    stats: { creates: number };
  } = {
    store,
    stats,
    sign,
    loadRailResolution: (draft) => ({
      trustPhase: "PA-1",
      trustPolicyAcceptsPA1: true,
      payPhases: draft.pipeline
        .filter((phase) => phase.kind.startsWith("pay-"))
        .map((phase) => ({ kind: phase.kind, rail: phase.parameters?.rail })),
      acceptedRails: draft.acceptedRails ?? [],
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
    scanOwnAnchorsByNamePrefix: async (prefix) => ({
      status: "ok",
      anchors: [...addresses.entries()]
        .filter(([name]) => name.startsWith(prefix))
        .map(([programName, address]) => ({
          address,
          programName,
          value: store.get(address)!,
        })),
    }),
    anchorWriteOnce: async (name, value) => {
      const existingAddress = addresses.get(name);
      if (existingAddress) {
        const existing = store.get(existingAddress)!;
        const candidate = structuredClone(
          value as Record<string, unknown>,
        );
        if (
          contentHash(existing) !==
          contentHash(candidate)
        ) {
          throw new DacsError(
            `immutable anchor ${name} already exists with different signed-scope content`,
          );
        }
        return { address: existingAddress };
      }

      // Deliberately nonce-like rather than name-derived: current Demos create
      // addresses are not predictable from the logical program name (#70).
      const address = `stor-${addresses.size + 1}`;
      addresses.set(name, address);
      // Model a storage serialization boundary rather than retaining the
      // immutable callback object by reference.
      store.set(address, structuredClone(value as Record<string, unknown>));
      stats.creates += 1;
      return { address, txRef: `tx-${address}` };
    },
  };
  return deps;
}

const listing = (over: Record<string, unknown> = {}) => {
  const { description, ...topLevel } = over;
  return {
    dacsVersion: "1" as const,
    listingVersion: 1,
    listingId: "market-data",
    seller: {
      identity: {
        bundleVersion: "1" as const,
        presentedBy: SELLER,
        presentedAt: 1_780_000_000_000,
        claims: [{ ref: SELLER }],
        presentation: {
          kind: "per-claim" as const,
          signatures: [{ ref: SELLER, signature: "identity-presentation" }],
        },
      },
      displayName: "Market Data",
      publicEndpoint: "https://seller.example/dacs",
    },
    offering: {
      title: "Market Data",
      description:
        typeof description === "string" ? description : "EOD prices",
      category: "data.finance",
      tags: ["market-data"],
      deliverable: {
        kind: "attested-payload" as const,
        payloadFormat: "application/json",
        verificationMethod: { kind: "self-signed" as const },
      },
    },
    buyerRequirement: { requirementVersion: "1" as const, required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" as const },
      { kind: "commit-agreement" as const },
      { kind: "pay-x402" as const, parameters: { rail: "x402:default" } },
      { kind: "deliver-attested-payload" as const },
    ],
    pricing: {
      kind: "fixed" as const,
      price: { amount: "1", currency: "USDC" },
    },
    acceptedRails: [{ railId: "x402:default" }],
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: 1_780_000_000_000 },
    ...topLevel,
  };
};

const signedListing = (over: Record<string, unknown> = {}) =>
  signComponentArtifact(listing(over), ARTIFACT_SEPARATORS.Listing, {
    algorithm: "ed25519",
    signer: SELLER,
    sign,
  });

describe("publishListingCore (§6.3.4 versioned + write-once — #29/#46)", () => {
  test("LP-6 refuses pay-bearing publication without authoritative rail resolution", async () => {
    const deps = fakeDeps();
    delete deps.loadRailResolution;
    await expect(publishListingCore(listing(), deps)).rejects.toThrow(/LP-6/);
    expect(deps.stats.creates).toBe(0);
  });

  test("LP-6 refuses an indeterminate rail authority before signing or anchoring", async () => {
    const deps = fakeDeps();
    deps.loadRailResolution = (draft) => ({
      trustPhase: "PA-2",
      payPhases: draft.pipeline
        .filter((phase) => phase.kind.startsWith("pay-"))
        .map((phase) => ({ kind: phase.kind, rail: phase.parameters?.rail })),
      acceptedRails: draft.acceptedRails ?? [],
      registry: { state: "unavailable", entries: [], definitions: [] },
    });
    await expect(publishListingCore(listing(), deps)).rejects.toThrow(
      /indeterminate.*registry-unavailable.*LP-6/,
    );
    expect(deps.stats.creates).toBe(0);
  });

  test("publishes a normative signed v1 and returns its exact LR-1 pin", async () => {
    const deps = fakeDeps();
    const res = await publishListingCore(listing(), deps);
    expect(res.ref).toBe("stor-1");
    expect(res.txRef).toBeDefined();
    const stored = deps.store.get(res.ref)!;
    expect(stored.seller).toMatchObject({
      displayName: "Market Data",
      publicEndpoint: "https://seller.example/dacs",
    });
    expect(stored.signature).toMatchObject({
      algorithm: "ed25519",
      signer: SELLER,
    });
    expect((stored.signature as { value: string }).value).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
    expect(res.listingPin).toEqual({
      listingId: "market-data",
      version: 1,
      contentHash: contentHash(stored),
    });
  });

  test("publishes the exact input snapshot signed before an async signer mutates the caller draft", async () => {
    const deps = fakeDeps();
    const draft = listing({ description: "authenticated publication A" });
    deps.sign = async (bytes) => {
      const signature = ed25519Sign(bytes, priv);
      draft.offering.description = "unsigned publication B";
      await Promise.resolve();
      return signature;
    };

    const result = await publishListingCore(draft, deps);
    const stored = deps.store.get(result.ref)!;
    expect(draft.offering.description).toBe("unsigned publication B");
    expect(
      (stored.offering as { description: string }).description,
    ).toBe("authenticated publication A");

    const verdict = await verifyComponentSignature(
      stored,
      ARTIFACT_SEPARATORS.Listing,
      {
        isSignerAuthorized: (_artifact, signature) =>
          signature.signer === SELLER,
        resolvePublicKey: () =>
          rawPublicKey(
            publicKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 7))),
          ),
        verify: ({ signedBytes, signature, publicKey }) =>
          ed25519Verify(
            signedBytes,
            Uint8Array.from(Buffer.from(signature.value, "base64url")),
            publicKeyFromRaw(publicKey),
          ),
      },
    );
    expect(verdict.status).toBe("valid");
    expect(result.listingPin.contentHash).toBe(contentHash(stored));
  });

  test("publishes immutable signed bytes when an async anchor attempts nested mutation", async () => {
    const deps = fakeDeps();
    const anchor = deps.anchorWriteOnce;
    let mutationBlocked = false;
    deps.anchorWriteOnce = async (name, value) => {
      try {
        ((value as Record<string, unknown>).offering as { description: string })
          .description = "unsigned publication B";
      } catch {
        mutationBlocked = true;
      }
      await Promise.resolve();
      return anchor(name, value);
    };

    const result = await publishListingCore(
      listing({ description: "authenticated publication A" }),
      deps,
    );
    const stored = deps.store.get(result.ref)!;
    expect(mutationBlocked).toBe(true);
    expect((stored.offering as { description: string }).description)
      .toBe("authenticated publication A");
    expect(result.listingPin.contentHash).toBe(contentHash(stored));
    expect(await verifyComponentSignature(
      stored,
      ARTIFACT_SEPARATORS.Listing,
      {
        isSignerAuthorized: (_artifact, signature) => signature.signer === SELLER,
        resolvePublicKey: () => rawPublicKey(publicKeyFromSeed(
          Uint8Array.from(Buffer.alloc(32, 7)),
        )),
        verify: ({ signedBytes, signature, publicKey }) => ed25519Verify(
          signedBytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(publicKey),
        ),
      },
    )).toMatchObject({ status: "valid" });
  });

  test("rejects accessor-backed dependency methods without invoking them", async () => {
    const deps = fakeDeps();
    const draft = listing({ description: "entry snapshot" });
    let getterCalls = 0;
    Object.defineProperty(deps, "sign", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        draft.offering.description = "getter-mutated draft";
        return sign;
      },
    });

    await expect(publishListingCore(draft, deps)).rejects.toThrow(
      /dependency sign must be a stable data method/,
    );
    expect(getterCalls).toBe(0);
    expect(draft.offering.description).toBe("entry snapshot");
    expect(deps.stats.creates).toBe(0);
  });

  test("rejects proxy-backed Listing drafts without running proxy traps", async () => {
    const deps = fakeDeps();
    let traps = 0;
    const draft = new Proxy(listing(), {
      get(target, key, receiver) {
        traps += 1;
        return Reflect.get(target, key, receiver);
      },
      ownKeys(target) {
        traps += 1;
        return Reflect.ownKeys(target);
      },
    });

    await expect(publishListingCore(draft, deps)).rejects.toThrow(
      /not stable canonical JSON/,
    );
    expect(traps).toBe(0);
    expect(deps.stats.creates).toBe(0);
  });

  test("owns and enforces the exact listing-history callback envelope", async () => {
    const extra = fakeDeps();
    let signs = 0;
    extra.sign = (bytes) => {
      signs += 1;
      return sign(bytes);
    };
    extra.scanOwnAnchorsByNamePrefix = async () => ({
      status: "ok",
      anchors: [],
      ignored: true,
    } as never);
    await expect(publishListingCore(listing(), extra)).rejects.toThrow(
      /history scan returned a malformed envelope/,
    );
    expect(signs).toBe(0);
    expect(extra.stats.creates).toBe(0);

    const accessor = fakeDeps();
    let getterCalls = 0;
    accessor.scanOwnAnchorsByNamePrefix = async () => {
      const scan = { status: "ok" } as Record<string, unknown>;
      Object.defineProperty(scan, "anchors", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return [];
        },
      });
      return scan as never;
    };
    await expect(publishListingCore(listing(), accessor)).rejects.toThrow(
      /history scan returned an unstable or non-wire result/,
    );
    expect(getterCalls).toBe(0);
    expect(accessor.stats.creates).toBe(0);

    const outsidePrefix = fakeDeps();
    outsidePrefix.scanOwnAnchorsByNamePrefix = async () => ({
      status: "ok",
      anchors: [{
        address: "stor-other",
        programName: "outside-the-requested-prefix",
        value: await signedListing(),
      }],
    });
    await expect(publishListingCore(listing(), outsidePrefix)).rejects.toThrow(
      /history scan returned a malformed anchor/,
    );
    expect(outsidePrefix.stats.creates).toBe(0);
  });

  test("pins callback identities before history discovery can swap them", async () => {
    const deps = fakeDeps();
    const originalSign = deps.sign;
    deps.scanOwnAnchorsByNamePrefix = async () => {
      deps.sign = () => new Uint8Array(64);
      return { status: "ok", anchors: [] };
    };

    const result = await publishListingCore(listing(), deps);
    const stored = deps.store.get(result.ref)!;
    expect(deps.sign).not.toBe(originalSign);
    expect(await verifyComponentSignature(
      stored,
      ARTIFACT_SEPARATORS.Listing,
      {
        isSignerAuthorized: (_artifact, signature) => signature.signer === SELLER,
        resolvePublicKey: () => rawPublicKey(publicKeyFromSeed(
          Uint8Array.from(Buffer.alloc(32, 7)),
        )),
        verify: ({ signedBytes, signature, publicKey }) => ed25519Verify(
          signedBytes,
          Uint8Array.from(Buffer.from(signature.value, "base64url")),
          publicKeyFromRaw(publicKey),
        ),
      },
    )).toMatchObject({ status: "valid" });
  });

  test("owns and enforces the exact immutable-write result envelope", async () => {
    const extra = fakeDeps();
    extra.anchorWriteOnce = async () => ({
      address: "stor-1",
      txRef: "tx-1",
      completion: "read-visible",
    } as never);
    await expect(publishListingCore(listing(), extra)).rejects.toThrow(
      /anchor returned a malformed result/,
    );

    const accessor = fakeDeps();
    let getterCalls = 0;
    accessor.anchorWriteOnce = async () => {
      const result = { address: "stor-1" } as Record<string, unknown>;
      Object.defineProperty(result, "txRef", {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "tx-1";
        },
      });
      return result as never;
    };
    await expect(publishListingCore(listing(), accessor)).rejects.toThrow(
      /anchor returned an unstable or non-wire result/,
    );
    expect(getterCalls).toBe(0);
  });

  test("§6.3.4: the native program name is colon-free and the logical address is the returned binding (#46)", async () => {
    const deps = fakeDeps();
    await publishListingCore(listing({ listingVersion: 1 }), deps);
    const res = await publishListingCore(listing({ listingVersion: 2 }), deps);
    const logical = listingAddress(SELLER, "market-data", 2);
    expect(logical).toContain(":"); // logical is colon-bearing…
    expect(res.storageName).not.toContain(":"); // …native program name is not (Demos rejects ":")
    expect(res.storageName).toContain("%3A"); // colons encoded, not dropped
    expect(res.logicalAddress).toBe(logical);
    expect(res.storageName).toBe(logicalToStorageProgramName(logical));
  });

  test("a new version anchors at a NEW address; the old slot is untouched", async () => {
    const deps = fakeDeps();
    const v1 = await publishListingCore(listing({ listingVersion: 1 }), deps);
    const v2 = await publishListingCore(
      listing({ listingVersion: 2, description: "EOD + intraday" }),
      deps,
    );
    expect(v2.ref).not.toBe(v1.ref);
    expect(deps.store.has(v1.ref)).toBe(true); // v1 immutable, still there
    expect(deps.store.has(v2.ref)).toBe(true);
  });

  test("re-publishing IDENTICAL content at the same version is idempotent (no error)", async () => {
    const deps = fakeDeps();
    const first = await publishListingCore(listing({ listingVersion: 1 }), deps);
    const again = await publishListingCore(listing({ listingVersion: 1 }), deps);
    expect(again.ref).toBe(first.ref);
    expect(deps.store.size).toBe(1); // no second write
    expect(deps.stats.creates).toBe(1);
  });

  test("CHANGED content at an existing version is REJECTED (write-once, #46)", async () => {
    const deps = fakeDeps();
    await publishListingCore(listing({ listingVersion: 1 }), deps);
    await expect(
      publishListingCore(listing({ listingVersion: 1, description: "changed!" }), deps),
    ).rejects.toThrow(/immutable|different content/);
  });

  test("requires v1 first and rejects a skipped version", async () => {
    const deps = fakeDeps();
    await expect(
      publishListingCore(listing({ listingVersion: 2 }), deps),
    ).rejects.toThrow(/expected 1, got 2/);

    await publishListingCore(listing({ listingVersion: 1 }), deps);
    await expect(
      publishListingCore(listing({ listingVersion: 3 }), deps),
    ).rejects.toThrow(/expected 2, got 3/);
    expect(deps.stats.creates).toBe(1);
  });

  test("accepts only a contiguous v1 → v2 → v3 history", async () => {
    const deps = fakeDeps();
    const v1 = await publishListingCore(listing({ listingVersion: 1 }), deps);
    const v2 = await publishListingCore(
      listing({ listingVersion: 2, description: "v2" }),
      deps,
    );
    const v3 = await publishListingCore(
      listing({ listingVersion: 3, description: "v3" }),
      deps,
    );

    expect(new Set([v1.ref, v2.ref, v3.ref]).size).toBe(3);
    expect(deps.stats.creates).toBe(3);
  });

  test("reads an existing legacy MVP version only through the compatibility boundary", async () => {
    const deps = fakeDeps();
    const prefix = logicalToStorageProgramName(
      listingAddress(SELLER, "market-data", "v"),
    );
    deps.scanOwnAnchorsByNamePrefix = async () => ({
      status: "ok",
      anchors: [
        {
          address: "stor-legacy-v1",
          programName: `${prefix}1`,
          value: {
            agentId: SELLER,
            serviceId: "market-data",
            name: "Legacy Market Data",
            description: "Historical SDK Listing",
            claimRequirements: [],
            supportedNegotiation: ["negotiate-fixed-price"],
            supportedPaymentRails: ["pay-x402"],
            supportedDelivery: ["deliver-attested-payload"],
            listingVersion: 1,
            signature: "legacy-signature",
          },
        },
      ],
    });

    const result = await publishListingCore(
      listing({ listingVersion: 2 }),
      deps,
    );
    expect(result.listingPin.version).toBe(2);
  });

  test("fails closed when the visible owner-bound history already has a gap", async () => {
    const deps = fakeDeps();
    const prefix = logicalToStorageProgramName(
      listingAddress(SELLER, "market-data", "v"),
    );
    deps.scanOwnAnchorsByNamePrefix = async () => ({
      status: "ok",
      anchors: [
        {
          address: "stor-v1",
          programName: `${prefix}1`,
          value: await signedListing({ listingVersion: 1 }),
        },
        {
          address: "stor-v3",
          programName: `${prefix}3`,
          value: await signedListing({ listingVersion: 3 }),
        },
      ],
    });

    await expect(
      publishListingCore(listing({ listingVersion: 2 }), deps),
    ).rejects.toThrow(/history has a gap/);
    expect(deps.stats.creates).toBe(0);
  });

  test("fails closed when listing-history discovery is indeterminate", async () => {
    const deps = fakeDeps();
    deps.scanOwnAnchorsByNamePrefix = async () => ({
      status: "indeterminate",
      reason: "RPC unavailable",
    });

    await expect(publishListingCore(listing(), deps)).rejects.toThrow(
      /history lookup was indeterminate/,
    );
    expect(deps.stats.creates).toBe(0);
  });

  test("two concurrent publishers cannot both create or overwrite one version slot", async () => {
    const deps = fakeDeps();
    const results = await Promise.allSettled([
      publishListingCore(listing({ description: "first" }), deps),
      publishListingCore(listing({ description: "second" }), deps),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(deps.stats.creates).toBe(1);
    expect(deps.store.size).toBe(1);
  });

  test("fails closed when immutable name resolution is indeterminate", async () => {
    const deps = fakeDeps();
    deps.anchorWriteOnce = async () => {
      throw new SubstrateError(
        "immutable anchor lookup was indeterminate (candidate unreadable)",
      );
    };

    await expect(publishListingCore(listing(), deps)).rejects.toThrow(
      /indeterminate/,
    );
    expect(deps.stats.creates).toBe(0);
  });

  test("rejects version 0, fractional, and negative (§6.3.4: positive integer ≥ 1)", async () => {
    for (const bad of [0, 1.5, -1]) {
      await expect(
        publishListingCore(listing({ listingVersion: bad }), fakeDeps()),
      ).rejects.toThrow(/positive integer/);
    }
  });

  test("refuses the historical MVP shape on the write path", async () => {
    const deps = fakeDeps();
    await expect(
      publishListingCore(
        {
          listingVersion: 1,
          agentId: SELLER,
          serviceId: "legacy",
        } as never,
        deps,
      ),
    ).rejects.toThrow(/normative unsigned|legacy MVP shapes are read-only/);
    expect(deps.stats.creates).toBe(0);
  });
});
