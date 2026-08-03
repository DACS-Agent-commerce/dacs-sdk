import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deriveReputation } from "../../src/agent/reputationDerivation.js";
import type { AttestationBundle } from "../../src/artifacts/types.js";

/**
 * DACS-Standard §14 conformance — reputation derivation (DACS-5 §10.5). Drives
 * the reference session-bundles fixture through deriveReputation and asserts the
 * whole golden ReputationDerivation. The fixture contains only one copy per job
 * and no authoritative absence evidence, so guard (iv) excludes every bundle.
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

  const derived = deriveReputation(
    fixture.partyPrimaryClaim,
    fixture.bundles,
    {
      windowStart: fixture.windowStart,
      windowEnd: fixture.windowEnd,
      computedAt: fixture.computedAt,
      windowingBasis: fixture.windowingBasis,
    },
    {
      trustBundles: true,
      // Ordinary absence from this fixture is not authoritative SR-2 absence
      // evidence. Guard (iv) therefore excludes every one-copy record.
      copyAbsence: () => "indeterminate",
    },
  );

  it("excludes raw one-copy bundles without authoritative absence context", () => {
    expect(derived.bundleCount).toBe(golden.bundleCount);
    expect(derived.bundleCount).toBe(0);
  });

  it("returns null completionRate when guard (iv) leaves no denominator", () => {
    expect(derived.metrics.completionRate).toBe(golden.metrics.completionRate);
    expect(derived.metrics.completionRate).toBeNull();
  });

  it("returns null counterpartyFaultRate when guard (iv) excludes every job", () => {
    expect(derived.metrics.counterpartyFaultRate).toBe(
      golden.metrics.counterpartyFaultRate,
    );
    expect(derived.metrics.counterpartyFaultRate).toBeNull();
  });

  it("ratings + volume are null / [] until RatingRecords are wired", () => {
    expect(derived.metrics.averageBuyerRating).toBeNull();
    expect(derived.metrics.averageSellerRating).toBeNull();
    expect(derived.metrics.observedTransactionalVolume).toEqual([]);
  });

  it("emits no bundleRefs for excluded records", () => {
    expect(derived.bundleRefs).toEqual(golden.bundleRefs);
    expect(derived.bundleRefs).toEqual([]);
  });

  it("returns the golden v0.2 metric fields for the empty derivation", () => {
    expect(derived.metrics.counterpartyAdjustedCompletionRate).toBe(
      golden.metrics.counterpartyAdjustedCompletionRate,
    );
    expect(derived.metrics.transactionCountByCurrency).toEqual(
      golden.metrics.transactionCountByCurrency,
    );
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
