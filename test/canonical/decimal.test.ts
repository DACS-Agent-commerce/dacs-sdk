import { describe, expect, it } from "vitest";

import {
  assertPositiveAmount,
  canonicalizeDecimal,
  contentHash,
} from "../../src/index.js";

// CD-1 decimal vectors (DACS-Standard §14.4 / §9.3).
describe("CD-1 decimals (§14.4)", () => {
  it("cd1-trailing-zeros: 1.50 / 01.5 / 1.500 all canonicalise to 1.5", () => {
    expect(["1.50", "01.5", "1.500"].map(canonicalizeDecimal)).toEqual([
      "1.5",
      "1.5",
      "1.5",
    ]);
  });

  it("cd1-normal-forms: 0.0 → 0 ; .5 → 0.5 ; 0.50 → 0.5", () => {
    expect(["0.0", ".5", "0.50"].map(canonicalizeDecimal)).toEqual([
      "0",
      "0.5",
      "0.5",
    ]);
  });

  it("cd1-reject-exponent: exponent / sign-plus / non-numeric are rejected", () => {
    expect(() => canonicalizeDecimal("1e5")).toThrow();
    expect(() => canonicalizeDecimal("+1")).toThrow();
    expect(() => canonicalizeDecimal("abc")).toThrow();
  });

  it("cd1-economic-equality: economically-equal amounts share a content hash; raw strings do not", () => {
    const a = canonicalizeDecimal("1.50");
    const b = canonicalizeDecimal("1.5");
    expect(contentHash({ amount: a })).toBe(contentHash({ amount: b }));
    expect(contentHash({ amount: "1.50" })).not.toBe(
      contentHash({ amount: "1.5" }),
    );
  });

  it("cd1-positivity: amount MUST be > 0", () => {
    expect(() => assertPositiveAmount("0")).toThrow();
    expect(() => assertPositiveAmount("0.0")).toThrow();
    expect(assertPositiveAmount("0.50")).toBe("0.5");
  });
});
