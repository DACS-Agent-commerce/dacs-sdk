import { describe, expect, it } from "vitest";

// #14: the injectable buyer-session core must be reachable from the PUBLIC
// barrel — not only via a deep `src/agent/runSessionCore.js` import past the
// package `exports` map. These imports resolving is itself the assertion.
import {
  runFulfilmentCore,
  runSessionCore,
  sellerFulfilmentId,
  type SellerFulfilmentDeps,
  type SessionDeps,
} from "../../src/index.js";
import {
  runFulfilmentCore as sellerRunFulfilmentCore,
  sellerFulfilmentId as sellerSurfaceFulfilmentId,
} from "../../src/seller/index.js";

describe("public core surface (#14)", () => {
  it("F1: runSessionCore is exported from the barrel", () => {
    expect(typeof runSessionCore).toBe("function");
  });

  it("F1: SessionDeps is exported (compile-time) so a custom substrate can be wired", () => {
    // Type-only use — if SessionDeps weren't exported this file wouldn't compile.
    const partial: Partial<SessionDeps> = { buyerId: "did:demos:buyer" };
    expect(partial.buyerId).toBe("did:demos:buyer");
  });

  it("#17: seller fulfilment core and dependency contract are public", () => {
    expect(typeof runFulfilmentCore).toBe("function");
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
