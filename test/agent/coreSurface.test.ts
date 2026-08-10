import { describe, expect, it } from "vitest";

// #14: the injectable buyer-session core must be reachable from the PUBLIC
// barrel — not only via a deep `src/agent/runSessionCore.js` import past the
// package `exports` map. These imports resolving is itself the assertion.
import {
  FENCED_SESSION_STORE_VERSION,
  SESSION_STORE_VERSION,
  createInMemoryFencedSessionStore,
  createInMemorySessionStore,
  runFulfilmentCore,
  runDurableFulfilmentCore,
  getSellerFulfilmentStatus,
  finalizeCompletedSellerBundleCore,
  runSessionCore,
  sellerFulfilmentId,
  type SellerFulfilmentDeps,
  type DurableSellerFulfilmentDeps,
  type FencedSessionRecordV2,
  type FencedSessionStoreV2,
  type SellerFulfilmentDurability,
  type SessionRecord,
  type SessionStore,
  type SessionDeps,
} from "../../src/index.js";
import {
  FENCED_SESSION_STORE_VERSION as sellerFencedSessionStoreVersion,
  createInMemoryFencedSessionStore as sellerCreateInMemoryFencedSessionStore,
  finalizeCompletedSellerBundleCore as sellerFinalizeCompletedBundleCore,
  getSellerFulfilmentStatus as sellerGetFulfilmentStatus,
  runFulfilmentCore as sellerRunFulfilmentCore,
  runDurableFulfilmentCore as sellerRunDurableFulfilmentCore,
  sellerFulfilmentId as sellerSurfaceFulfilmentId,
} from "../../src/seller/index.js";

describe("public core surface (#14)", () => {
  it("F1: runSessionCore is exported from the barrel", () => {
    expect(typeof runSessionCore).toBe("function");
  });

  it("#55: durable seller recovery is exported from root and seller surfaces", () => {
    expect(typeof runDurableFulfilmentCore).toBe("function");
    expect(typeof getSellerFulfilmentStatus).toBe("function");
    expect(sellerRunDurableFulfilmentCore).toBe(runDurableFulfilmentCore);
    const deps: Partial<DurableSellerFulfilmentDeps> = { nowMs: () => 2 };
    const durability: Partial<SellerFulfilmentDurability> = { workerId: "worker" };
    expect(deps.nowMs?.()).toBe(2);
    expect(durability.workerId).toBe("worker");
  });

  it("#55: legacy v1 and generation-fenced v2 stores have distinct public APIs", () => {
    const legacy: SessionStore = createInMemorySessionStore();
    const fenced: FencedSessionStoreV2 = createInMemoryFencedSessionStore();
    const legacyRecord: Partial<SessionRecord> = { storeVersion: SESSION_STORE_VERSION };
    const fencedRecord: Partial<FencedSessionRecordV2> = {
      storeVersion: FENCED_SESSION_STORE_VERSION,
      leaseGeneration: 0,
    };

    expect(SESSION_STORE_VERSION).toBe(1);
    expect(FENCED_SESSION_STORE_VERSION).toBe(2);
    expect("apiVersion" in legacy).toBe(false);
    expect(fenced.apiVersion).toBe(FENCED_SESSION_STORE_VERSION);
    expect(legacyRecord.storeVersion).toBe(1);
    expect(fencedRecord.storeVersion).toBe(2);
    expect(sellerFencedSessionStoreVersion).toBe(FENCED_SESSION_STORE_VERSION);
    expect(sellerCreateInMemoryFencedSessionStore).toBe(
      createInMemoryFencedSessionStore,
    );
  });

  it("F1: SessionDeps is exported (compile-time) so a custom substrate can be wired", () => {
    // Type-only use — if SessionDeps weren't exported this file wouldn't compile.
    const partial: Partial<SessionDeps> = { buyerId: "did:demos:buyer" };
    expect(partial.buyerId).toBe("did:demos:buyer");
  });

  it("#17: seller fulfilment core and dependency contract are public", () => {
    expect(typeof runFulfilmentCore).toBe("function");
    expect(typeof finalizeCompletedSellerBundleCore).toBe("function");
    expect(sellerFinalizeCompletedBundleCore).toBe(finalizeCompletedSellerBundleCore);
    expect(sellerRunFulfilmentCore).toBe(runFulfilmentCore);
    expect(sellerSurfaceFulfilmentId).toBe(sellerFulfilmentId);
    const partial: Partial<SellerFulfilmentDeps> = { nowMs: () => 1 };
    expect(partial.nowMs?.()).toBe(1);
  });

  // NOTE (#48): `sessionAnchorName` is intentionally NOT part of the public
  // surface yet — its MVP address strings are not the normative §6.3.x schemes,
  // so exporting them as "the scheme a verifier reproduces" would mislead. It
  // stays internal until canonical addressing lands; no public-API test asserts
  // those strings as normative.
});
