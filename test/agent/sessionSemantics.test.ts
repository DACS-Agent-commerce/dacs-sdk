import { describe, expect, test } from "vitest";

import {
  dacs5BundleOutcomeForTerminalState,
  isDacs5SessionTransitionAllowed,
  type Dacs5ResumableSessionState,
  type Dacs5SessionTransitionContext,
  type Dacs5SessionState,
} from "../../src/agent/sessionSemantics.js";

describe("DACS-5 §10.3.1 session semantics", () => {
  const ordinary: ReadonlyArray<readonly [Dacs5SessionState, Dacs5SessionState]> = [
    ["draft", "vet-pending"],
    ["vet-pending", "vet-completed"],
    ["vet-pending", "vet-failed"],
    ["vet-pending", "aborted-by-self"],
    ["vet-pending", "aborted-by-other"],
    ["vet-completed", "negotiate-pending"],
    ["negotiate-pending", "negotiate-completed"],
    ["negotiate-pending", "negotiate-failed"],
    ["negotiate-pending", "aborted-by-self"],
    ["negotiate-pending", "aborted-by-other"],
    ["negotiate-completed", "commit-pending"],
    ["commit-pending", "commit-completed"],
    ["commit-pending", "commit-failed"],
    ["commit-pending", "aborted-by-self"],
    ["commit-pending", "aborted-by-other"],
    ["commit-completed", "settle-pending"],
    ["settle-pending", "settle-completed"],
    ["settle-pending", "settle-asymmetric"],
    ["settle-pending", "settle-failed"],
    ["settle-asymmetric", "settle-completed"],
    ["settle-asymmetric", "settle-failed"],
    ["settle-completed", "rate-pending"],
    ["settle-completed", "audit-pending"],
    ["rate-pending", "rate-completed"],
    ["rate-pending", "audit-pending"],
    ["rate-completed", "audit-pending"],
    ["audit-pending", "finalised"],
  ];

  test("accepts every ordinary forward edge in the normative table", () => {
    for (const [from, to] of ordinary) {
      expect(isDacs5SessionTransitionAllowed(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  test("binds every ST-7 pause and resume to its exact paused-from state", () => {
    const resumable: Dacs5ResumableSessionState[] = [
      "vet-pending",
      "negotiate-pending",
      "commit-pending",
      "settle-pending",
      "settle-asymmetric",
      "audit-pending",
    ];
    for (const pausedFrom of resumable) {
      const context = { pausedFrom } as const;
      expect(
        isDacs5SessionTransitionAllowed(
          pausedFrom,
          "substrate-failure-paused",
          context,
        ),
      ).toBe(true);
      expect(
        isDacs5SessionTransitionAllowed(
          "substrate-failure-paused",
          pausedFrom,
          context,
        ),
      ).toBe(true);
      expect(
        isDacs5SessionTransitionAllowed(
          "substrate-failure-paused",
          "failed-substrate",
          context,
        ),
      ).toBe(true);
    }
  });

  test("allows settle-stage abort only before an irreversible effect", () => {
    for (const to of ["aborted-by-self", "aborted-by-other"] as const) {
      expect(isDacs5SessionTransitionAllowed("settle-pending", to)).toBe(false);
      expect(
        isDacs5SessionTransitionAllowed("settle-pending", to, {
          settlementIrreversible: true,
        }),
      ).toBe(false);
      expect(
        isDacs5SessionTransitionAllowed("settle-pending", to, {
          settlementIrreversible: false,
        }),
      ).toBe(true);
    }
  });

  test("rejects unbound pauses, wrong resumes, and terminal re-entry", () => {
    const invalidRatePauseContext = {
      pausedFrom: "rate-pending",
    } as unknown as Dacs5SessionTransitionContext;
    expect(
      isDacs5SessionTransitionAllowed("settle-pending", "substrate-failure-paused"),
    ).toBe(false);
    expect(
      isDacs5SessionTransitionAllowed(
        "substrate-failure-paused",
        "vet-pending",
        { pausedFrom: "settle-pending" },
      ),
    ).toBe(false);
    expect(
      isDacs5SessionTransitionAllowed(
        "rate-pending",
        "substrate-failure-paused",
        invalidRatePauseContext,
      ),
    ).toBe(false);
    expect(
      isDacs5SessionTransitionAllowed(
        "substrate-failure-paused",
        "rate-pending",
        invalidRatePauseContext,
      ),
    ).toBe(false);
    expect(isDacs5SessionTransitionAllowed("finalised", "rate-pending")).toBe(false);
    expect(isDacs5SessionTransitionAllowed("commit-completed", "negotiate-pending"))
      .toBe(false);
    expect(
      isDacs5SessionTransitionAllowed(
        "toString" as Dacs5SessionState,
        "vet-pending",
      ),
    ).toBe(false);
  });

  test("maps every terminal family and rejects non-terminal/contradictory inputs", () => {
    expect(dacs5BundleOutcomeForTerminalState("finalised")).toBe("completed");
    expect(dacs5BundleOutcomeForTerminalState("vet-failed", "permanent"))
      .toBe("failed-perm");
    expect(dacs5BundleOutcomeForTerminalState("commit-failed", "transient"))
      .toBe("failed-perm");
    expect(dacs5BundleOutcomeForTerminalState("negotiate-failed", "counterparty"))
      .toBe("failed-counterparty");
    expect(dacs5BundleOutcomeForTerminalState("settle-failed", "settlement-atomicity"))
      .toBe("failed-counterparty");
    expect(dacs5BundleOutcomeForTerminalState("failed-substrate", "substrate"))
      .toBe("failed-substrate");
    expect(dacs5BundleOutcomeForTerminalState("aborted-by-self")).toBe("aborted-by-self");
    expect(dacs5BundleOutcomeForTerminalState("aborted-by-other")).toBe("aborted-by-other");
    expect(dacs5BundleOutcomeForTerminalState("settle-asymmetric")).toBeNull();
    expect(dacs5BundleOutcomeForTerminalState("settle-failed", "substrate")).toBeNull();
    expect(dacs5BundleOutcomeForTerminalState("failed-substrate", "permanent")).toBeNull();
    expect(dacs5BundleOutcomeForTerminalState("finalised", "permanent")).toBeNull();
    expect(dacs5BundleOutcomeForTerminalState("aborted-by-self", "counterparty"))
      .toBeNull();
  });
});
