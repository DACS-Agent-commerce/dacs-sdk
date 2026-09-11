import { describe, expect, test } from "vitest";

import {
  deriveReputation,
  deriveReputationWithValidation,
  type ReputationWindow,
} from "../../src/agent/reputationDerivation.js";
import type {
  AttestationBundle,
  AttestationRef,
  FaultAttestationBundle,
  RatingRecord,
} from "../../src/artifacts/types.js";
import { bundleAddress } from "../../src/canonical/addressing.js";
import { contentHash, stripSignature } from "../../src/canonical/index.js";

const PARTY = `did:demos:agent:${"11".repeat(32)}`;
const CP = `did:demos:agent:${"22".repeat(32)}`;
const RATED_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7D";
const ADVERSARIAL_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7E";
const OTHER_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7F";
const DUPLICATE_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7G";
const TIE_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7H";
const MALFORMED_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7J";
const MUTATION_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7K";
const QUALIFIED_JOB = "01J8ME0SXKQ4T9V2RC5HJ6WX7M";
const WINDOW: ReputationWindow = {
  windowStart: 1000,
  windowEnd: 2000,
  computedAt: 3000,
  windowingBasis: "finalisedAt",
};
const TRUSTED_WITH_ABSENCE = {
  trustBundles: true,
  trustBundlePartyRoles: true,
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

function rating(
  input: Omit<RatingRecord, "ratingVersion" | "signature">,
  locator = `rating-${input.jobId}-${input.targetRole}-${input.ratedAt}`,
): { record: RatingRecord; ref: AttestationRef } {
  const record: RatingRecord = {
    ratingVersion: "1",
    ...input,
    signature: {
      algorithm: "ed25519",
      signer: input.rater,
      value: Buffer.alloc(64, input.value).toString("base64url"),
    },
  };
  return {
    record,
    ref: {
      anchor: { kind: "storage-program", locator },
      contentHash: contentHash(
        stripSignature(record as unknown as Record<string, unknown>),
      ),
    },
  };
}

function withRatings(
  candidate: AttestationBundle,
  refs: AttestationRef[],
): AttestationBundle {
  return { ...candidate, ratingRefs: refs };
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

  test("uses the independently resolved per-job role instead of relabelled bundle parties", () => {
    const relabelled = bundle("relabelled", "aborted-by-self", 1100, "buyer", [
      { role: "seller", bundleHash: "h", primaryClaim: PARTY },
      { role: "buyer", bundleHash: "h", primaryClaim: CP },
    ]);
    const resolved: Array<Readonly<{
      jobId: string;
      partyPrimaryClaim: string;
    }>> = [];
    const r = deriveReputation(PARTY, [relabelled], WINDOW, {
      trustBundles: true,
      resolvePartyRole: (context) => {
        resolved.push(context);
        return "buyer";
      },
      copyAbsence: () => "absent",
    });

    expect(resolved).toEqual([
      { jobId: "relabelled", partyPrimaryClaim: PARTY },
    ]);
    expect(Object.isFrozen(resolved[0])).toBe(true);
    expect(r.bundleCount).toBe(1);
    expect(r.metrics.counterpartyFaultRate).toBe(0);
    expect(r.metrics.completionRate).toBe(0);
  });

  test("passes the parameter-free identity to the independent role resolver", () => {
    const qualifiedParty = `${PARTY}?jurisdiction=GB`;
    const qualifiedBundle = bundle(
      "qualified-role",
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
    const resolved: string[] = [];

    const r = deriveReputation(qualifiedParty, [qualifiedBundle], WINDOW, {
      trustBundles: true,
      resolvePartyRole: ({ partyPrimaryClaim }) => {
        resolved.push(partyPrimaryClaim);
        return partyPrimaryClaim === PARTY ? "buyer" : undefined;
      },
      copyAbsence: () => "absent",
    });

    expect(resolved).toEqual([PARTY]);
    expect(r).toMatchObject({
      partyPrimaryClaim: PARTY,
      bundleCount: 1,
    });
  });

  test("does not score Promise-like, unresolved, or thrown role results", () => {
    const candidate = bundle("a", "completed", 1100);
    const promised = deriveReputation(PARTY, [candidate], WINDOW, {
      trustBundles: true,
      resolvePartyRole: (() => Promise.resolve("buyer")) as unknown as () =>
        | "buyer"
        | "seller",
      copyAbsence: () => "absent",
    });
    const unresolved = deriveReputation(PARTY, [candidate], WINDOW, {
      trustBundles: true,
      resolvePartyRole: () => undefined,
      copyAbsence: () => "absent",
    });
    const thrown = deriveReputation(PARTY, [candidate], WINDOW, {
      trustBundles: true,
      resolvePartyRole: () => {
        throw new Error("session context unavailable");
      },
      copyAbsence: () => "absent",
    });

    expect(promised.bundleCount).toBe(0);
    expect(unresolved.bundleCount).toBe(0);
    expect(thrown.bundleCount).toBe(0);
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
      { trustBundles: true, trustBundlePartyRoles: true },
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
      { trustBundles: true, trustBundlePartyRoles: true },
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
        trustBundlePartyRoles: true,
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
      {
        isValid: (b) => b.jobId === "a",
        trustBundlePartyRoles: true,
        copyAbsence: () => "absent",
      },
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
          trustBundlePartyRoles: true,
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
        trustBundlePartyRoles: true,
        copyAbsence: () => "absent",
      },
    );

    expect(r.bundleCount).toBe(1);
    expect(r.bundleRefs[0]?.anchor.locator).toBe(
      bundleAddress("accepted", "buyer"),
    );
    expect(r.metrics.completionRate).toBe(1);
  });

  test("async validation rejects a candidate that cannot be captured as inert data", async () => {
    let propertyReads = 0;
    let validationCalls = 0;
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
        validate: async () => {
          validationCalls += 1;
          return false;
        },
        trustBundlePartyRoles: true,
        copyAbsence: () => "absent",
      },
    );

    expect(propertyReads).toBe(0);
    expect(validationCalls).toBe(0);
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
          if (candidate.jobId === "accepted") return true;
          signalDelayed();
          await delayedGate;
          return false;
        },
        trustBundlePartyRoles: true,
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

  test("owns each bundle and the window before asynchronous validation", async () => {
    const candidate = bundle("owned-input", "completed", 1500);
    const mutableWindow = { ...WINDOW };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const pending = deriveReputationWithValidation(
      PARTY,
      [candidate],
      mutableWindow,
      {
        validate: async () => {
          signalStarted();
          await gate;
          return true;
        },
        trustBundlePartyRoles: true,
        copyAbsence: () => "absent",
      },
    );
    await started;
    candidate.outcome = "failed-perm";
    mutableWindow.windowStart = 1600;
    release();

    const result = await pending;
    expect(result.bundleCount).toBe(1);
    expect(result.metrics.completionRate).toBe(1);
    expect(result.windowStart).toBe(1000);
  });

  test("preserves the receiver of captured validation methods", async () => {
    const dependencies = {
      allow: true,
      validate() {
        return this.allow;
      },
      trustBundlePartyRoles: true as const,
      copyAbsence() {
        return "absent" as const;
      },
    };
    const result = await deriveReputationWithValidation(
      PARTY,
      [bundle("bound-validator", "completed", 1500)],
      WINDOW,
      dependencies,
    );

    expect(result.bundleCount).toBe(1);
    expect(result.metrics.completionRate).toBe(1);
  });

  test("async validation forwards the independent role resolver", async () => {
    const relabelled = bundle("relabelled", "aborted-by-self", 1100, "buyer", [
      { role: "seller", bundleHash: "h", primaryClaim: PARTY },
      { role: "buyer", bundleHash: "h", primaryClaim: CP },
    ]);
    const r = await deriveReputationWithValidation(
      PARTY,
      [relabelled],
      WINDOW,
      {
        validate: async () => true,
        resolvePartyRole: ({ jobId, partyPrimaryClaim }) =>
          jobId === "relabelled" && partyPrimaryClaim === PARTY
            ? "buyer"
            : undefined,
        copyAbsence: () => "absent",
      },
    );

    expect(r.bundleCount).toBe(1);
    expect(r.metrics.counterpartyFaultRate).toBe(0);
    expect(r.metrics.completionRate).toBe(0);
  });

  test("requires an explicit isValid or trustBundles — no fail-open default", () => {
    expect(() =>
      deriveReputation(PARTY, [bundle("a", "completed", 1100)], WINDOW),
    ).toThrow(/isValid|trustBundles/);
  });

  test("requires independent role resolution or an explicit authenticated-role assertion", () => {
    expect(() =>
      deriveReputation(
        PARTY,
        [bundle("a", "completed", 1100)],
        WINDOW,
        { trustBundles: true },
      ),
    ).toThrow(/resolvePartyRole|trustBundlePartyRoles/);
  });

  test("trust assertions accept only primitive true", () => {
    const candidate = bundle("a", "completed", 1100);
    expect(() =>
      deriveReputation(PARTY, [candidate], WINDOW, {
        trustBundles: {} as unknown as true,
        trustBundlePartyRoles: true,
      }),
    ).toThrow(/isValid|trustBundles/);
    expect(() =>
      deriveReputation(PARTY, [candidate], WINDOW, {
        trustBundles: true,
        trustBundlePartyRoles: {} as unknown as true,
      }),
    ).toThrow(/resolvePartyRole|trustBundlePartyRoles/);
  });

  test("async validation checks role configuration before invoking the validator", async () => {
    let calls = 0;
    await expect(
      deriveReputationWithValidation(
        PARTY,
        [bundle("a", "completed", 1100)],
        WINDOW,
        {
          validate: async () => {
            calls += 1;
            return true;
          },
        },
      ),
    ).rejects.toThrow(/resolvePartyRole|trustBundlePartyRoles/);
    expect(calls).toBe(0);
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
      trustBundlePartyRoles: true,
    });
    expect(r.metrics.transactionCountByCurrency).toEqual([]);
  });

  test("derives both role directions only from independently authenticated RatingRecords", async () => {
    const buyerRatesSeller = rating({
      jobId: RATED_JOB,
      rater: PARTY,
      target: CP,
      targetRole: "seller",
      value: 5,
      ratedAt: 1200,
    });
    const sellerRatesBuyer = rating({
      jobId: RATED_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 4,
      ratedAt: 1201,
    });
    const candidate = withRatings(
      bundle(RATED_JOB, "completed", 1500),
      [buyerRatesSeller.ref, sellerRatesBuyer.ref],
    );
    const byLocator = new Map([
      [buyerRatesSeller.ref.anchor.locator, buyerRatesSeller.record],
      [sellerRatesBuyer.ref.anchor.locator, sellerRatesBuyer.record],
    ]);
    const deps = {
      validate: async () => true,
      trustBundlePartyRoles: true as const,
      copyAbsence: () => "absent" as const,
      resolveAndAuthenticateRating: async ({ ref }: { ref: AttestationRef }) => ({
        disposition: "authenticated" as const,
        record: byLocator.get(ref.anchor.locator)!,
      }),
    };

    const buyer = await deriveReputationWithValidation(
      PARTY,
      [candidate],
      WINDOW,
      deps,
    );
    const seller = await deriveReputationWithValidation(
      CP,
      [candidate],
      WINDOW,
      deps,
    );

    expect(buyer.metrics.averageBuyerRating).toBe(4);
    expect(buyer.metrics.averageSellerRating).toBeNull();
    expect(seller.metrics.averageSellerRating).toBe(5);
    expect(seller.metrics.averageBuyerRating).toBeNull();
  });

  test("excludes invalid, indeterminate, misbound, non-RT-1, and hash-mismatched ratings", async () => {
    const accepted = rating({
      jobId: ADVERSARIAL_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 4,
      ratedAt: 1200,
    }, "accepted");
    const wrongJob = rating({
      jobId: OTHER_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 1,
      ratedAt: 1201,
    }, "wrong-job");
    const relabelled = rating({
      jobId: ADVERSARIAL_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "seller",
      value: 1,
      ratedAt: 1202,
    }, "relabelled");
    const wrongHash = rating({
      jobId: ADVERSARIAL_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 1,
      ratedAt: 1203,
    }, "wrong-hash");
    wrongHash.ref.contentHash = "0".repeat(64);
    const wrongSigner = rating({
      jobId: ADVERSARIAL_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 1,
      ratedAt: 1204,
    }, "wrong-signer");
    wrongSigner.record.signature.signer = PARTY;
    const outOfRange = rating({
      jobId: ADVERSARIAL_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 1,
      ratedAt: 1205,
    }, "out-of-range");
    outOfRange.record.value = 6;
    const invalid = rating({
      jobId: ADVERSARIAL_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 1,
      ratedAt: 1206,
    }, "invalid");
    const indeterminate = rating({
      jobId: ADVERSARIAL_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 1,
      ratedAt: 1207,
    }, "indeterminate");
    const thrown = rating({
      jobId: ADVERSARIAL_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 1,
      ratedAt: 1208,
    }, "thrown");
    const all = [
      accepted,
      wrongJob,
      relabelled,
      wrongHash,
      wrongSigner,
      outOfRange,
      invalid,
      indeterminate,
      thrown,
    ];
    const records = new Map(all.map(({ ref, record }) => [ref.anchor.locator, record]));
    const result = await deriveReputationWithValidation(
      PARTY,
      [withRatings(bundle(ADVERSARIAL_JOB, "completed", 1500), all.map(({ ref }) => ref))],
      WINDOW,
      {
        validate: async () => true,
        trustBundlePartyRoles: true,
        copyAbsence: () => "absent",
        resolveAndAuthenticateRating: async ({ ref }) => {
          if (ref.anchor.locator === "invalid") {
            return { disposition: "invalid", reason: "signature invalid" };
          }
          if (ref.anchor.locator === "indeterminate") {
            return { disposition: "indeterminate", reason: "read unavailable" };
          }
          if (ref.anchor.locator === "thrown") throw new Error("transport down");
          return {
            disposition: "authenticated",
            record: records.get(ref.anchor.locator)!,
          };
        },
      },
    );

    expect(result.metrics.averageBuyerRating).toBe(4);
    expect(result.metrics.averageSellerRating).toBeNull();
  });

  test("deduplicates one session direction by latest ratedAt independent of input order", async () => {
    const early = rating({
      jobId: DUPLICATE_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 2,
      ratedAt: 1200,
    }, "early");
    const latest = rating({
      jobId: DUPLICATE_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 5,
      ratedAt: 1300,
    }, "latest");
    const records = new Map([
      [early.ref.anchor.locator, early.record],
      [latest.ref.anchor.locator, latest.record],
    ]);
    const derive = (refs: AttestationRef[]) =>
      deriveReputationWithValidation(
        PARTY,
        [withRatings(bundle(DUPLICATE_JOB, "completed", 1500), refs)],
        WINDOW,
        {
          validate: async () => true,
          trustBundlePartyRoles: true,
          copyAbsence: () => "absent" as const,
          resolveAndAuthenticateRating: async ({ ref }) => ({
            disposition: "authenticated" as const,
            record: records.get(ref.anchor.locator)!,
          }),
        },
      );

    const forward = await derive([early.ref, latest.ref, early.ref]);
    const reversed = await derive([latest.ref, early.ref, latest.ref]);
    expect(forward.metrics.averageBuyerRating).toBe(5);
    expect(reversed.metrics.averageBuyerRating).toBe(5);
  });

  test("uses a canonical tie-break for same-timestamp conflicting authenticated records", async () => {
    const low = rating({
      jobId: TIE_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 1,
      ratedAt: 1200,
    }, "tie-low");
    const high = rating({
      jobId: TIE_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 5,
      ratedAt: 1200,
    }, "tie-high");
    const records = new Map([
      [low.ref.anchor.locator, low.record],
      [high.ref.anchor.locator, high.record],
    ]);
    const derive = (refs: AttestationRef[]) =>
      deriveReputationWithValidation(
        PARTY,
        [withRatings(bundle(TIE_JOB, "completed", 1500), refs)],
        WINDOW,
        {
          validate: async () => true,
          trustBundlePartyRoles: true,
          copyAbsence: () => "absent" as const,
          resolveAndAuthenticateRating: async ({ ref }) => ({
            disposition: "authenticated" as const,
            record: records.get(ref.anchor.locator)!,
          }),
        },
      );

    const forward = await derive([low.ref, high.ref]);
    const reversed = await derive([high.ref, low.ref]);
    expect(forward.metrics.averageBuyerRating).toBe(
      reversed.metrics.averageBuyerRating,
    );
    expect([1, 5]).toContain(forward.metrics.averageBuyerRating);
  });

  test("rejects a truthy or non-canonical rating authentication envelope", async () => {
    const candidateRating = rating({
      jobId: MALFORMED_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 5,
      ratedAt: 1200,
    });
    const result = await deriveReputationWithValidation(
      PARTY,
      [withRatings(bundle(MALFORMED_JOB, "completed", 1500), [candidateRating.ref])],
      WINDOW,
      {
        validate: async () => true,
        trustBundlePartyRoles: true,
        copyAbsence: () => "absent",
        resolveAndAuthenticateRating: async () => ({
          disposition: "authenticated",
          record: candidateRating.record,
          trusted: true,
        }) as never,
      },
    );
    expect(result.metrics.averageBuyerRating).toBeNull();
  });

  test("captures the rating authority before asynchronous bundle validation", async () => {
    const candidateRating = rating({
      jobId: MUTATION_JOB,
      rater: CP,
      target: PARTY,
      targetRole: "buyer",
      value: 5,
      ratedAt: 1200,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const deps = {
      validate: async () => {
        signalStarted();
        await gate;
        return true;
      },
      trustBundlePartyRoles: true as const,
      copyAbsence: () => "absent" as const,
      resolveAndAuthenticateRating: async () => ({
        disposition: "authenticated" as const,
        record: candidateRating.record,
      }),
    };
    const pending = deriveReputationWithValidation(
      PARTY,
      [withRatings(bundle(MUTATION_JOB, "completed", 1500), [candidateRating.ref])],
      WINDOW,
      deps,
    );
    await started;
    deps.resolveAndAuthenticateRating = async () => ({
      disposition: "invalid" as const,
      reason: "mutated dependency",
    }) as never;
    release();

    expect((await pending).metrics.averageBuyerRating).toBe(5);
  });

  test("deduplicates CF-3-equivalent qualified rater references", async () => {
    const first = rating({
      jobId: QUALIFIED_JOB,
      rater: `${CP}?jurisdiction=GB`,
      target: PARTY,
      targetRole: "buyer",
      value: 2,
      ratedAt: 1200,
    }, "qualified-first");
    const latest = rating({
      jobId: QUALIFIED_JOB,
      rater: `${CP}?jurisdiction=US`,
      target: PARTY,
      targetRole: "buyer",
      value: 4,
      ratedAt: 1300,
    }, "qualified-latest");
    const records = new Map([
      [first.ref.anchor.locator, first.record],
      [latest.ref.anchor.locator, latest.record],
    ]);
    const result = await deriveReputationWithValidation(
      PARTY,
      [withRatings(bundle(QUALIFIED_JOB, "completed", 1500), [first.ref, latest.ref])],
      WINDOW,
      {
        validate: async () => true,
        trustBundlePartyRoles: true,
        copyAbsence: () => "absent",
        resolveAndAuthenticateRating: async ({ ref }) => ({
          disposition: "authenticated",
          record: records.get(ref.anchor.locator)!,
        }),
      },
    );

    expect(result.metrics.averageBuyerRating).toBe(4);
  });
});
