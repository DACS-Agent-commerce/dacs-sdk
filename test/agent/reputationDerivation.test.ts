import { describe, expect, test } from "vitest";

import {
  deriveReputation,
  deriveReputationWithValidation,
  type ReputationWindow,
} from "../../src/agent/reputationDerivation.js";
import type { AttestationBundle, FaultAttestationBundle } from "../../src/artifacts/types.js";
import { bundleAddress } from "../../src/canonical/addressing.js";

const PARTY = "did:demos:buyer";
const CP = "did:demos:seller";
const WINDOW: ReputationWindow = {
  windowStart: 1000,
  windowEnd: 2000,
  computedAt: 3000,
  windowingBasis: "finalisedAt",
};
const TRUSTED_WITH_ABSENCE = {
  trustBundles: true,
  copyAbsence: () => "absent" as const,
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

function faultBundle(
  jobId: string,
  outcome: string,
  faultedParty: "buyer" | "seller" | "orchestrator" | "none",
  anchoredByRole: "buyer" | "seller",
  parties = [
    { role: "buyer", bundleHash: "h", primaryClaim: PARTY },
    { role: "seller", bundleHash: "h", primaryClaim: CP },
  ],
): FaultAttestationBundle {
  const { bundleVersion: _legacy, ...shared } = bundle(
    jobId,
    outcome,
    1100,
    anchoredByRole,
    parties,
  );
  return { ...shared, faultBundleVersion: "1", faultedParty } as FaultAttestationBundle;
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
      TRUSTED_WITH_ABSENCE,
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
      TRUSTED_WITH_ABSENCE,
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
      TRUSTED_WITH_ABSENCE,
    );
    expect(r.metrics.counterpartyFaultRate).toBe(0.5); // 2 / 4
    expect(r.metrics.completionRate).toBe(0.25); // 1 / 4
  });

  test("all-failed-substrate → denominator 0 → rates are null, not zero", () => {
    const r = deriveReputation(
      PARTY,
      [bundle("a", "failed-substrate", 1100), bundle("b", "failed-substrate", 1200)],
      WINDOW,
      TRUSTED_WITH_ABSENCE,
    );
    expect(r.metrics.completionRate).toBeNull();
    expect(r.metrics.counterpartyFaultRate).toBeNull();
  });

  test("empty scoped set → zeroed derivation with null scalar metrics", () => {
    const r = deriveReputation(PARTY, [], WINDOW, TRUSTED_WITH_ABSENCE);
    expect(r.bundleCount).toBe(0);
    expect(r.bundleRefs).toEqual([]);
    expect(r.metrics.completionRate).toBeNull();
    expect(r.metrics.observedTransactionalVolume).toEqual([]);
  });

  test("keys and matches reputation by parameter-free CF-3 identity", () => {
    const qualifiedParty = `${PARTY}?jurisdiction=GB`;
    const qualifiedBundle = bundle(
      "qualified",
      "completed",
      1100,
      "buyer",
      [
        {
          role: "buyer",
          bundleHash: "h",
          primaryClaim: `${PARTY}?jurisdiction=US`,
        },
        { role: "seller", bundleHash: "h", primaryClaim: CP },
      ],
    );
    expect(deriveReputation(
      qualifiedParty,
      [qualifiedBundle],
      WINDOW,
      TRUSTED_WITH_ABSENCE,
    )).toMatchObject({
      partyPrimaryClaim: PARTY,
      bundleCount: 1,
    });
  });

  test("rejects a non-canonical reputation key", () => {
    expect(() => deriveReputation(
      `DID:demos:buyer`,
      [],
      WINDOW,
      TRUSTED_WITH_ABSENCE,
    )).toThrow(/partyPrimaryClaim.*CF-2/);
  });

  test("per-jobId reconciliation: two copies of one job count once (self perspective)", () => {
    const r = deriveReputation(
      PARTY,
      [
        bundle("j1", "completed", 1100, "buyer"),
        bundle("j1", "completed", 1100, "seller"), // counterparty copy, same job
      ],
      WINDOW,
      TRUSTED_WITH_ABSENCE,
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
      TRUSTED_WITH_ABSENCE,
    );
    // j1 dropped (dispute); only j2 remains.
    expect(r.bundleCount).toBe(1);
    expect(r.metrics.completionRate).toBe(1);
  });

  test("legacy perspective-partner outcomes reconcile to one event", () => {
    const copies = [
      bundle("j1", "failed-counterparty", 1100, "buyer"),
      bundle("j1", "failed-perm", 1100, "seller"),
    ];
    const buyer = deriveReputation(PARTY, copies, WINDOW, TRUSTED_WITH_ABSENCE);
    expect(buyer.bundleCount).toBe(1);
    expect(buyer.metrics.counterpartyFaultRate).toBe(1);

    const seller = deriveReputation(CP, copies, WINDOW, TRUSTED_WITH_ABSENCE);
    expect(seller.bundleCount).toBe(1);
    expect(seller.metrics.counterpartyFaultRate).toBe(0);
    expect(seller.metrics.completionRate).toBe(0);
  });

  test("fault-bundle perspective pair scores the same absolute fault for both parties", () => {
    const copies = [
      faultBundle("j1", "failed-counterparty", "seller", "buyer"),
      faultBundle("j1", "failed-perm", "seller", "seller"),
    ];
    const buyer = deriveReputation(PARTY, copies, WINDOW, TRUSTED_WITH_ABSENCE);
    expect(buyer.bundleCount).toBe(1);
    expect(buyer.metrics.counterpartyFaultRate).toBe(1);
    const seller = deriveReputation(CP, copies, WINDOW, TRUSTED_WITH_ABSENCE);
    expect(seller.bundleCount).toBe(1);
    expect(seller.metrics.counterpartyFaultRate).toBe(0);
  });

  test("mixed pair uses its compatible fault bundle and orchestrator fault is neutral", () => {
    const mixed = [
      bundle("j1", "failed-counterparty", 1100, "buyer"),
      faultBundle("j1", "failed-perm", "seller", "seller"),
    ];
    expect(deriveReputation(PARTY, mixed, WINDOW, TRUSTED_WITH_ABSENCE).metrics.counterpartyFaultRate).toBe(1);

    const parties = [
      { role: "buyer", bundleHash: "h", primaryClaim: PARTY },
      { role: "seller", bundleHash: "h", primaryClaim: CP },
      { role: "orchestrator", bundleHash: "h", primaryClaim: "did:demos:orchestrator" },
    ];
    const neutral = deriveReputation(
      PARTY,
      [faultBundle("j2", "failed-counterparty", "orchestrator", "buyer", parties)],
      WINDOW,
      TRUSTED_WITH_ABSENCE,
    );
    expect(neutral.bundleCount).toBe(1);
    expect(neutral.metrics.completionRate).toBeNull();
    expect(neutral.metrics.counterpartyFaultRate).toBeNull();
  });

  test("two present perspective-flipped phase error classes are divergent and excluded", () => {
    const buyerCopy = bundle("j1", "completed", 1100, "buyer");
    buyerCopy.phaseSummary = [
      { index: 0, kind: "settle", outcome: "fail", errorClass: "counterparty" } as never,
    ];
    const sellerCopy = bundle("j1", "completed", 1100, "seller");
    sellerCopy.phaseSummary = [
      { index: 0, kind: "settle", outcome: "fail", errorClass: "permanent" } as never,
    ];
    const r = deriveReputation(PARTY, [buyerCopy, sellerCopy], WINDOW, TRUSTED_WITH_ABSENCE);
    expect(r.bundleCount).toBe(0);
    expect(r.metrics.counterpartyFaultRate).toBeNull();
  });

  test("two present perspective-flipped phase outcomes are divergent and excluded", () => {
    const buyerCopy = bundle("j1", "completed", 1100, "buyer");
    buyerCopy.phaseSummary = [
      { index: 0, kind: "settle", outcome: "failed-counterparty" } as never,
    ];
    const sellerCopy = bundle("j1", "completed", 1100, "seller");
    sellerCopy.phaseSummary = [
      { index: 0, kind: "settle", outcome: "failed-perm" } as never,
    ];
    const r = deriveReputation(PARTY, [buyerCopy, sellerCopy], WINDOW, TRUSTED_WITH_ABSENCE);
    expect(r.bundleCount).toBe(0);
    expect(r.metrics.completionRate).toBeNull();
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
    const r = deriveReputation(PARTY, [buyerCopy, sellerCopy], WINDOW, TRUSTED_WITH_ABSENCE);
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

  test("self-only copy without authoritative absence evidence is excluded", () => {
    const r = deriveReputation(
      PARTY,
      [faultBundle("j1", "completed", "none", "buyer")],
      WINDOW,
      { trustBundles: true },
    );
    expect(r.bundleCount).toBe(0);
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
      { isValid: (b) => b.jobId === "a", copyAbsence: () => "absent" },
    );
    expect(r.bundleCount).toBe(1);
  });

  test("rejects an async predicate on the synchronous scorer instead of treating its Promise as valid", () => {
    expect(() =>
      deriveReputation(
        PARTY,
        [bundle("a", "completed", 1100)],
        WINDOW,
        {
          // JavaScript and casted callers can bypass the TypeScript return type;
          // the runtime boundary must still fail closed on Promise truthiness.
          isValid: (async () => false) as unknown as () => boolean,
          copyAbsence: () => "absent",
        },
      ),
    ).toThrow(/boolean synchronously|deriveReputationWithValidation/);
  });

  test("async validation admits only primitive true and excludes false, rejection, and non-boolean results", async () => {
    const r = await deriveReputationWithValidation(
      PARTY,
      [
        bundle("accepted", "completed", 1100),
        bundle("false", "completed", 1200),
        bundle("rejected", "completed", 1300),
        bundle("truthy-object", "completed", 1400),
      ],
      WINDOW,
      {
        validate: async (candidate) => {
          if (candidate.jobId === "accepted") return true;
          if (candidate.jobId === "rejected") throw new Error("indeterminate");
          if (candidate.jobId === "truthy-object") {
            return { valid: true } as unknown as boolean;
          }
          return Promise.resolve(false);
        },
        copyAbsence: () => "absent",
      },
    );

    expect(r.bundleCount).toBe(1);
    expect(r.bundleRefs[0]?.anchor.locator).toBe(
      bundleAddress("accepted", "buyer"),
    );
    expect(r.metrics.completionRate).toBe(1);
  });

  test("async validation rejects a hostile candidate before the scorer reads its fields", async () => {
    let propertyReads = 0;
    const hostile = new Proxy(
      {},
      {
        get() {
          propertyReads += 1;
          throw new Error("must not inspect rejected wire input");
        },
      },
    ) as unknown as ReturnType<typeof bundle>;

    const r = await deriveReputationWithValidation(
      PARTY,
      [hostile],
      WINDOW,
      {
        validate: async () => false,
        copyAbsence: () => "absent",
      },
    );

    expect(propertyReads).toBe(0);
    expect(r.bundleCount).toBe(0);
  });

  test("async validation snapshots each accepted copy before a later await permits caller mutation", async () => {
    const accepted = bundle("accepted", "completed", 1100);
    const delayed = bundle("delayed", "completed", 1200);
    let releaseDelayed!: () => void;
    const delayedGate = new Promise<void>((resolve) => {
      releaseDelayed = resolve;
    });
    let signalDelayed!: () => void;
    const delayedStarted = new Promise<void>((resolve) => {
      signalDelayed = resolve;
    });

    const pending = deriveReputationWithValidation(
      PARTY,
      [accepted, delayed],
      WINDOW,
      {
        validate: async (candidate) => {
          if (candidate === accepted) return true;
          signalDelayed();
          await delayedGate;
          return false;
        },
        copyAbsence: () => "absent",
      },
    );

    await delayedStarted;
    accepted.outcome = "failed-perm";
    accepted.parties[0]!.primaryClaim = "did:demos:mutated";
    releaseDelayed();

    const r = await pending;
    expect(r.bundleCount).toBe(1);
    expect(r.metrics.completionRate).toBe(1);
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
      TRUSTED_WITH_ABSENCE,
    );
    expect(r.metrics.counterpartyAdjustedCompletionRate).toBe(0.5);
  });

  test("counterpartyAdjustedCompletionRate is null when every outcome is counterparty-caused", () => {
    const r = deriveReputation(
      PARTY,
      [bundle("a", "failed-counterparty", 1100), bundle("b", "aborted-by-other", 1200)],
      WINDOW,
      TRUSTED_WITH_ABSENCE,
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
