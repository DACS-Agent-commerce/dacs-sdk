import { describe, expect, test } from "vitest";

import {
  publishListingCore,
  type PublishListingDeps,
} from "../../src/agent/publishListingCore.js";
import {
  contentHash,
  listingAddress,
  logicalToStorageProgramName,
} from "../../src/canonical/index.js";
import { ed25519Sign, privateKeyFromSeed } from "../../src/crypto/index.js";
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
        if (
          contentHash(existing) !==
          contentHash(value as Record<string, unknown>)
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
      store.set(address, value as Record<string, unknown>);
      stats.creates += 1;
      return { address, txRef: `tx-${address}` };
    },
  };
  return deps;
}

const listing = (over: Record<string, unknown> = {}) => ({
  agentId: SELLER,
  serviceId: "market-data",
  name: "Market Data",
  description: "EOD prices",
  claimRequirements: [],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-x402"],
  supportedDelivery: ["deliver-attested-payload"],
  ...over,
});

describe("publishListingCore (§6.3.4 versioned + write-once — #29/#46)", () => {
  test("anchors v1 (default) under the colon-free §6.3.4 program name", async () => {
    const deps = fakeDeps();
    const res = await publishListingCore(listing(), deps);
    expect(res.ref).toBe("stor-1");
    expect(res.txRef).toBeDefined();
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
          value: listing({ listingVersion: 1 }),
        },
        {
          address: "stor-v3",
          programName: `${prefix}3`,
          value: listing({ listingVersion: 3 }),
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
});
