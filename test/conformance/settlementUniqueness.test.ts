import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  verifySettlementClaimUniqueness,
  type ConsumedSettlementSet,
} from "../../src/agent/settlementIdentity.js";

interface Sb2Vector {
  name: string;
  decision: "pass" | "fail" | "error" | "indeterminate";
  effect:
    | "count"
    | "already-counted"
    | "reject"
    | "verifier-error"
    | "no-decision";
  consumed: ConsumedSettlementSet;
  record: {
    settlementRef?: Record<string, unknown>;
    jobId: string;
    phaseIndex: number;
  };
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../vendor/DACS-Standard/conformance/vectors/security/sb2-settlement-uniqueness-v0.1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { count: number; vectors: Sb2Vector[] };

function normativeTxRef(
  settlementRef: Record<string, unknown> | undefined,
): unknown {
  if (!settlementRef) return undefined;
  const { rail, ...fields } = settlementRef;
  const kind = rail === "demos-native" ? "demos" : rail;
  return { kind, ...fields };
}

describe("promoted DACS SB-2 settlement uniqueness vectors", () => {
  test("fixture count is pinned", () => {
    expect(fixture.vectors).toHaveLength(fixture.count);
  });

  test.each(fixture.vectors)("$name", (vector) => {
    const result = verifySettlementClaimUniqueness(
      normativeTxRef(vector.record.settlementRef),
      {
        jobId: vector.record.jobId,
        phaseIndex: vector.record.phaseIndex,
      },
      vector.consumed,
    );
    expect(result).toMatchObject({
      decision: vector.decision,
      effect: vector.effect,
    });
  });
});
