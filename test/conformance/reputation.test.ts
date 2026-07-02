import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deriveReputation } from "../../src/agent/reputationDerivation.js";
import type { AttestationBundle } from "../../src/artifacts/types.js";

/**
 * DACS-Standard §14 conformance — reputation derivation (DACS-5 §10.5). Drives
 * the reference session-bundles fixture through deriveReputation and asserts the
 * whole golden ReputationDerivation (window, bundleCount, completion /
 * counterparty-fault rates, and the byte-stable ascending-contentHash bundleRefs).
 */

const VENDOR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../vendor/DACS-Standard",
);
const haveVectors = existsSync(join(VENDOR, "conformance/vectors/golden.json"));
const load = (rel: string) => JSON.parse(readFileSync(join(VENDOR, rel), "utf8"));

describe.skipIf(!haveVectors)("§14 conformance — reputation (§10.5)", () => {
  const fixture = load("conformance/fixtures/session-bundles-reputation.json") as {
    windowStart: number;
    windowEnd: number;
    windowingBasis: "finalisedAt" | "sr2-anchor-timestamp";
    computedAt: number;
    partyPrimaryClaim: string;
    bundles: AttestationBundle[];
  };
  const golden = load("conformance/vectors/golden.json").verify.reputation;

  const derived = deriveReputation(fixture.partyPrimaryClaim, fixture.bundles, {
    windowStart: fixture.windowStart,
    windowEnd: fixture.windowEnd,
    computedAt: fixture.computedAt,
    windowingBasis: fixture.windowingBasis,
  });

  it("excludes the out-of-window bundle (bundleCount matches golden)", () => {
    // 6 bundles in, one finalised past windowEnd → 5 counted.
    expect(derived.bundleCount).toBe(golden.bundleCount);
  });

  it("completionRate excludes blameless failed-substrate from the denominator", () => {
    expect(derived.metrics.completionRate).toBe(golden.metrics.completionRate);
  });

  it("counterpartyFaultRate matches golden (aborted-by-other + failed-counterparty)", () => {
    expect(derived.metrics.counterpartyFaultRate).toBe(
      golden.metrics.counterpartyFaultRate,
    );
  });

  it("ratings + volume are null / [] until RatingRecords are wired", () => {
    expect(derived.metrics.averageBuyerRating).toBeNull();
    expect(derived.metrics.averageSellerRating).toBeNull();
    expect(derived.metrics.observedTransactionalVolume).toEqual([]);
  });

  it("bundleRefs match the golden set in ascending-contentHash order (byte-stable)", () => {
    expect(derived.bundleRefs).toEqual(golden.bundleRefs);
  });

  it("reproduces the full golden ReputationDerivation", () => {
    expect(derived).toEqual({
      derivationVersion: "1",
      partyPrimaryClaim: fixture.partyPrimaryClaim,
      windowStart: golden.windowStart,
      windowEnd: golden.windowEnd,
      bundleCount: golden.bundleCount,
      metrics: golden.metrics,
      computedAt: golden.computedAt,
      windowingBasis: golden.windowingBasis,
      bundleRefs: golden.bundleRefs,
    });
  });
});
