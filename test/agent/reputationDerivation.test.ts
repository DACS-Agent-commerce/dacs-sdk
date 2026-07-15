import { describe, expect, test } from "vitest";

import {
  deriveReputation,
  type ReputationWindow,
} from "../../src/agent/reputationDerivation.js";
import type { AttestationBundle } from "../../src/artifacts/types.js";

const PARTY = "did:demos:buyer";
const CP = "did:demos:seller";
const WINDOW: ReputationWindow = {
  windowStart: 1000,
  windowEnd: 2000,
  computedAt: 3000,
  windowingBasis: "finalisedAt",
};

/** Minimal valid-enough AttestationBundle for the deriver (it reads a few fields). */
function bundle(
  jobId: string,
  outcome: string,
  finalisedAt: number,
  anchoredByRole: "buyer" | "seller" = "buyer",
  parties = [
    { role: "buyer", bundleHash: "h", primaryClaim: PARTY },
    { role: "seller", bundleHash: "h", primaryClaim: CP },
  ],
): AttestationBundle {
  return {
    bundleVersion: "1",
    jobId,
    outcome,
    anchoredByRole,
    listingRef: { listingId: "svc", version: 1, contentHash: "c" },
    agreementRef: { kind: "dacs-3-agreement", id: `a-${jobId}`, contentHash: "c" },
    parties,
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt,
  } as unknown as AttestationBundle;
}

describe("deriveReputation (DACS-5 §10.5)", () => {
  test("windowing: bundles outside [start,end] on finalisedAt are excluded", () => {
    const r = deriveReputation(
      PARTY,
      [
        bundle("in", "completed", 1500),
        bundle("early", "completed", 500),
        bundle("late", "completed", 2500),
      ],
      WINDOW,
      { trustBundles: true },
    );
    expect(r.bundleCount).toBe(1);
    expect(r.metrics.completionRate).toBe(1);
  });

  test("failed-substrate is blameless — excluded from the denominator", () => {
    // completed + failed-substrate → denom 1 (substrate excluded) → completionRate 1.
    const r = deriveReputation(
      PARTY,
      [
        bundle("a", "completed", 1100),
        bundle("b", "failed-substrate", 1200),
      ],
      WINDOW,
      { trustBundles: true },
    );
    expect(r.bundleCount).toBe(2); // both counted in bundleCount
    expect(r.metrics.completionRate).toBe(1); // but denom excludes substrate
    expect(r.metrics.counterpartyFaultRate).toBe(0);
  });

  test("counterparty fault = aborted-by-other + failed-counterparty", () => {
    const r = deriveReputation(
      PARTY,
      [
        bundle("a", "completed", 1100),
        bundle("b", "failed-counterparty", 1200),
        bundle("c", "aborted-by-other", 1300),
        bundle("d", "aborted-by-self", 1400), // party's own fault, not counterparty
      ],
      WINDOW,
      { trustBundles: true },
    );
    expect(r.metrics.counterpartyFaultRate).toBe(0.5); // 2 / 4
    expect(r.metrics.completionRate).toBe(0.25); // 1 / 4
  });

  test("all-failed-substrate → denominator 0 → rates are null, not zero", () => {
    const r = deriveReputation(
      PARTY,
      [bundle("a", "failed-substrate", 1100), bundle("b", "failed-substrate", 1200)],
      WINDOW,
      { trustBundles: true },
    );
    expect(r.metrics.completionRate).toBeNull();
    expect(r.metrics.counterpartyFaultRate).toBeNull();
  });

  test("empty scoped set → zeroed derivation with null scalar metrics", () => {
    const r = deriveReputation(PARTY, [], WINDOW, { trustBundles: true });
    expect(r.bundleCount).toBe(0);
    expect(r.bundleRefs).toEqual([]);
    expect(r.metrics.completionRate).toBeNull();
    expect(r.metrics.observedTransactionalVolume).toEqual([]);
  });

  test("per-jobId reconciliation: two copies of one job count once (self perspective)", () => {
    const r = deriveReputation(
      PARTY,
      [
        bundle("j1", "completed", 1100, "buyer"),
        bundle("j1", "completed", 1100, "seller"), // counterparty copy, same job
      ],
      WINDOW,
      { trustBundles: true },
    );
    expect(r.bundleCount).toBe(1); // deduped by jobId
  });

  test("divergent copies of one job are excluded from all metrics (§10.4.3d)", () => {
    const r = deriveReputation(
      PARTY,
      [
        bundle("j1", "completed", 1100, "buyer"),
        bundle("j1", "failed-counterparty", 1100, "seller"), // contradicts the buyer copy
        bundle("j2", "completed", 1200, "buyer"),
      ],
      WINDOW,
      { trustBundles: true },
    );
    // j1 dropped (dispute); only j2 remains.
    expect(r.bundleCount).toBe(1);
    expect(r.metrics.completionRate).toBe(1);
  });

  test("perspective-flipped buyer/seller fault copies reconcile as one event", () => {
    const copies = [
      bundle("j1", "failed-counterparty", 1100, "buyer"),
      bundle("j1", "failed-perm", 1100, "seller"),
    ];
    const buyer = deriveReputation(PARTY, copies, WINDOW, { trustBundles: true });
    expect(buyer.bundleCount).toBe(1);
    expect(buyer.metrics.counterpartyFaultRate).toBe(1);

    const seller = deriveReputation(CP, copies, WINDOW, { trustBundles: true });
    expect(seller.bundleCount).toBe(1);
    expect(seller.metrics.counterpartyFaultRate).toBe(0);
    expect(seller.metrics.completionRate).toBe(0);
  });

  test("perspective-flipped phase attribution does not create a false divergence", () => {
    const buyerCopy = bundle("j1", "failed-counterparty", 1100, "buyer");
    buyerCopy.phaseSummary = [
      { index: 0, kind: "settle", outcome: "fail", errorClass: "counterparty" } as never,
    ];
    const sellerCopy = bundle("j1", "failed-perm", 1100, "seller");
    sellerCopy.phaseSummary = [
      { index: 0, kind: "settle", outcome: "fail", errorClass: "permanent" } as never,
    ];
    const r = deriveReputation(PARTY, [buyerCopy, sellerCopy], WINDOW, { trustBundles: true });
    expect(r.bundleCount).toBe(1);
    expect(r.metrics.counterpartyFaultRate).toBe(1);
  });

  test("shared-index phase kind mismatch is divergent and excluded", () => {
    const buyerCopy = bundle("j1", "completed", 1100, "buyer");
    buyerCopy.phaseSummary = [
      { index: 2, kind: "commit-agreement", outcome: "ok" } as never,
    ];
    const sellerCopy = bundle("j1", "completed", 1100, "seller");
    sellerCopy.phaseSummary = [
      { index: 2, kind: "deliver-storage-program", outcome: "ok" } as never,
    ];
    const r = deriveReputation(PARTY, [buyerCopy, sellerCopy], WINDOW, { trustBundles: true });
    expect(r.bundleCount).toBe(0);
    expect(r.metrics.completionRate).toBeNull();
  });

  test("counterparty-only copy without authoritative absence evidence is excluded", () => {
    const r = deriveReputation(
      PARTY,
      [bundle("j1", "aborted-by-self", 1100, "seller")],
      WINDOW,
      { trustBundles: true },
    );
    expect(r.bundleCount).toBe(0);
    expect(r.metrics.counterpartyFaultRate).toBeNull();
    expect(r.metrics.completionRate).toBeNull();
  });

  test("counterparty-only copy is attributed with authoritative absence evidence", () => {
    const r = deriveReputation(
      PARTY,
      [bundle("j1", "aborted-by-self", 1100, "seller")],
      WINDOW,
      {
        trustBundles: true,
        copyAbsence: ({ jobId, missingRole, presentRole }) => {
          expect(jobId).toBe("j1");
          expect(missingRole).toBe("buyer");
          expect(presentRole).toBe("seller");
          return "absent";
        },
      },
    );
    expect(r.metrics.counterpartyFaultRate).toBe(1);
    expect(r.metrics.completionRate).toBe(0);
  });

  test("signature validation hook drops invalid copies", () => {
    const r = deriveReputation(
      PARTY,
      [bundle("a", "completed", 1100), bundle("b", "completed", 1200)],
      WINDOW,
      { isValid: (b) => b.jobId === "a" },
    );
    expect(r.bundleCount).toBe(1);
  });

  test("requires an explicit isValid or trustBundles — no fail-open default", () => {
    expect(() =>
      deriveReputation(PARTY, [bundle("a", "completed", 1100)], WINDOW),
    ).toThrow(/isValid|trustBundles/);
  });

  test("counterpartyAdjustedCompletionRate strips counterparty-caused failures from the denom", () => {
    // completed 1, failed-counterparty 1, aborted-by-other 1, aborted-by-self 1.
    // party_fault_denom 4; counterparty-caused 2; blame denom 4-2=2 → 1/2.
    const r = deriveReputation(
      PARTY,
      [
        bundle("a", "completed", 1100),
        bundle("b", "failed-counterparty", 1200),
        bundle("c", "aborted-by-other", 1300),
        bundle("d", "aborted-by-self", 1400),
      ],
      WINDOW,
      { trustBundles: true },
    );
    expect(r.metrics.counterpartyAdjustedCompletionRate).toBe(0.5);
  });

  test("counterpartyAdjustedCompletionRate is null when every outcome is counterparty-caused", () => {
    const r = deriveReputation(
      PARTY,
      [bundle("a", "failed-counterparty", 1100), bundle("b", "aborted-by-other", 1200)],
      WINDOW,
      { trustBundles: true },
    );
    expect(r.metrics.counterpartyAdjustedCompletionRate).toBeNull(); // blame denom 0
  });

  test("transactionCountByCurrency is schema-present ([]) until volume wiring", () => {
    const r = deriveReputation(PARTY, [bundle("a", "completed", 1100)], WINDOW, {
      trustBundles: true,
    });
    expect(r.metrics.transactionCountByCurrency).toEqual([]);
  });
});
