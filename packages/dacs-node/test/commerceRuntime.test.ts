import { describe, expect, it, vi } from "vitest";

import {
  createDacsFixedPriceX402OperationSetV1,
  dacsFixedPriceX402RequiredTracksV1,
} from "../src/index.js";

function operation() {
  return vi.fn(async () => ({
    status: "final" as const,
    outcome: "success" as const,
    reference: "authenticated:test",
  }));
}

describe("production fixed-price x402 operation set", () => {
  it("admits and freezes the exact complete buyer graph", () => {
    const source = Object.fromEntries(
      dacsFixedPriceX402RequiredTracksV1("buyer").map((track) => [track, operation()]),
    );
    const graph = createDacsFixedPriceX402OperationSetV1({
      role: "buyer",
      operations: source,
    });
    expect(Object.keys(graph)).toEqual([
      "agreement",
      "payment",
      "payment-evidence",
      "buyer-received",
      "audit",
    ]);
    expect(Object.isFrozen(graph)).toBe(true);
  });

  it("rejects missing, cross-role, non-callable, and accessor tracks", () => {
    const buyer = Object.fromEntries(
      dacsFixedPriceX402RequiredTracksV1("buyer").map((track) => [track, operation()]),
    );
    delete buyer.audit;
    expect(() => createDacsFixedPriceX402OperationSetV1({
      role: "buyer",
      operations: buyer,
    })).toThrow(/role-incompatible/);

    const seller = Object.fromEntries(
      dacsFixedPriceX402RequiredTracksV1("seller").map((track) => [track, operation()]),
    );
    seller["buyer-received"] = operation();
    expect(() => createDacsFixedPriceX402OperationSetV1({
      role: "seller",
      operations: seller,
    })).toThrow(/role-incompatible/);

    const invalid = Object.fromEntries(
      dacsFixedPriceX402RequiredTracksV1("buyer").map((track) => [track, operation()]),
    ) as Record<string, unknown>;
    invalid.payment = "unsafe";
    expect(() => createDacsFixedPriceX402OperationSetV1({
      role: "buyer",
      operations: invalid,
    })).toThrow(/incomplete/);

    const accessor = Object.create(null) as Record<string, unknown>;
    for (const track of dacsFixedPriceX402RequiredTracksV1("buyer")) {
      Object.defineProperty(accessor, track, {
        enumerable: true,
        get: operation,
      });
    }
    expect(() => createDacsFixedPriceX402OperationSetV1({
      role: "buyer",
      operations: accessor,
    })).toThrow(/invalid/);
  });

  it("returns immutable shared track declarations", () => {
    expect(dacsFixedPriceX402RequiredTracksV1("seller")).toEqual([
      "agreement",
      "payment",
      "payment-evidence",
      "delivery",
      "delivery-evidence",
      "audit",
    ]);
    expect(Object.isFrozen(dacsFixedPriceX402RequiredTracksV1("seller"))).toBe(true);
  });
});
