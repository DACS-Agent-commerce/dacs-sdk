import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, test } from "vitest";

import {
  bundleConsistency,
  bundlesDiverge,
} from "../../src/agent/bundleConsistency.js";

const CONF = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard/conformance",
);
const haveVectors = existsSync(join(CONF, "vectors/golden.json"));
const read = (p: string) => JSON.parse(readFileSync(join(CONF, p), "utf8"));

describe("bundleConsistency (§10.4.3 two-sided verdict)", () => {
  test("absent — no copy anchored", () => {
    expect(bundleConsistency({})).toBe("absent");
    expect(bundleConsistency({ buyer: null, seller: null })).toBe("absent");
  });

  test("oneSided — exactly one valid copy", () => {
    const b = { outcome: "completed", phaseSummary: [] };
    expect(bundleConsistency({ buyer: b })).toBe("oneSided");
    expect(bundleConsistency({ seller: b })).toBe("oneSided");
  });

  test("unified — both present, differing only in advisory fields", () => {
    const buyer = {
      outcome: "completed",
      anchoredByRole: "buyer",
      finalisedAt: 1000,
      phaseSummary: [{ index: 0, kind: "settle", outcome: "ok" }],
    };
    const seller = {
      outcome: "completed",
      anchoredByRole: "seller", // per-copy, excluded from divergence
      finalisedAt: 1002, // advisory skew
      ratingRefs: ["stor-r"], // one-sided advisory
      phaseSummary: [{ index: 0, kind: "settle", outcome: "ok" }],
    };
    expect(bundlesDiverge(buyer, seller)).toBe(false);
    expect(bundleConsistency({ buyer, seller })).toBe("unified");
  });

  test("divergent — copies contradict on outcome", () => {
    const buyer = { outcome: "completed", phaseSummary: [] };
    const seller = { outcome: "failed-counterparty", phaseSummary: [] };
    expect(bundleConsistency({ buyer, seller })).toBe("divergent");
  });

  test("divergent — copies contradict on a phase outcome/errorClass", () => {
    const buyer = { outcome: "completed", phaseSummary: [{ index: 1, outcome: "ok" }] };
    const seller = {
      outcome: "completed",
      phaseSummary: [{ index: 1, outcome: "fail", errorClass: "counterparty" }],
    };
    expect(bundlesDiverge(buyer, seller)).toBe(true);
    expect(bundleConsistency({ buyer, seller })).toBe("divergent");
  });

  test("a phase present in only one copy is not itself a contradiction", () => {
    const buyer = { outcome: "completed", phaseSummary: [{ index: 0, outcome: "ok" }] };
    const seller = {
      outcome: "completed",
      phaseSummary: [
        { index: 0, outcome: "ok" },
        { index: 1, outcome: "ok" }, // extra advisory phase
      ],
    };
    expect(bundleConsistency({ buyer, seller })).toBe("unified");
  });

  test("isValid gate drops an invalid copy (treated as not-present)", () => {
    const buyer = { outcome: "completed", phaseSummary: [] };
    const seller = { outcome: "failed-counterparty", phaseSummary: [] };
    // Seller copy fails validation → only buyer remains → oneSided, not divergent.
    expect(
      bundleConsistency({ buyer, seller }, (_b, role) => role === "buyer"),
    ).toBe("oneSided");
    // Both invalid → absent.
    expect(bundleConsistency({ buyer, seller }, () => false)).toBe("absent");
  });
});

describe.skipIf(!haveVectors)("§14 verify golden — two-sided verdicts over reference bundles", () => {
  it("the buyer/seller copies of session 0004 canonically diverge", () => {
    const buyer = read("fixtures/attestation-bundle-0004.json");
    const seller = read("fixtures/attestation-bundle-0004-seller.json");
    // buyer says completed; seller says failed-counterparty (settle phase fail) → dispute.
    expect(bundleConsistency({ buyer, seller })).toBe("divergent");
  });

  it("a lone anchored copy is oneSided (anchoring omission, not an abort)", () => {
    const buyer = read("fixtures/session-bundle-one-sided.json");
    expect(bundleConsistency({ buyer })).toBe("oneSided");
  });
});
