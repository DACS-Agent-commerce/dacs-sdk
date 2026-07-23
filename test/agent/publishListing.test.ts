import { describe, expect, test } from "vitest";

import {
  publishListingCore,
  type PublishListingDeps,
} from "../../src/agent/publishListingCore.js";
import { listingAddress, logicalToStorageProgramName } from "../../src/canonical/index.js";
import { ed25519Sign, privateKeyFromSeed } from "../../src/crypto/index.js";

const SELLER = "did:demos:agent:seller";
const priv = privateKeyFromSeed(Uint8Array.from(Buffer.alloc(32, 7)));
const sign = (bytes: Uint8Array) => ed25519Sign(bytes, priv);

/** In-memory anchor store implementing the write-once seam. */
function fakeDeps() {
  const store = new Map<string, Record<string, unknown>>();
  const anchorAddress = (name: string) => `stor:${name}`;
  const deps: PublishListingDeps & { store: Map<string, Record<string, unknown>> } = {
    store,
    sign,
    anchorAddress,
    readAnchor: async (addr) => store.get(addr) ?? null,
    anchor: async (name, value) => {
      const address = anchorAddress(name);
      store.set(address, value as Record<string, unknown>);
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
    const logical = listingAddress(SELLER, "market-data", 1);
    // Anchored under the colon-free NATIVE name, not the colon-bearing logical one.
    expect(res.ref).toBe(`stor:${logicalToStorageProgramName(logical)}`);
    expect(res.txRef).toBeDefined();
  });

  test("§6.3.4: the native program name is colon-free and the logical address is the returned binding (#46)", async () => {
    const deps = fakeDeps();
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
  });

  test("CHANGED content at an existing version is REJECTED (write-once, #46)", async () => {
    const deps = fakeDeps();
    await publishListingCore(listing({ listingVersion: 1 }), deps);
    await expect(
      publishListingCore(listing({ listingVersion: 1, description: "changed!" }), deps),
    ).rejects.toThrow(/immutable|different content/);
  });

  test("rejects version 0, fractional, and negative (§6.3.4: positive integer ≥ 1)", async () => {
    for (const bad of [0, 1.5, -1]) {
      await expect(
        publishListingCore(listing({ listingVersion: bad }), fakeDeps()),
      ).rejects.toThrow(/positive integer/);
    }
  });
});
