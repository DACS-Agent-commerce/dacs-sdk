import { describe, expect, test } from "vitest";

import { computeReputation } from "../../src/agent/reputation.js";
import type { AttestationBundle } from "../../src/artifacts/types.js";

function bundle(over: Partial<AttestationBundle>): AttestationBundle {
  return {
    jobId: "j",
    state: "completed",
    primaryClaim: "did:alice",
    artifactRefs: [],
    ratings: [],
    signedBy: [],
    completedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("computeReputation", () => {
  test("counts only the subject's bundles and completed ones", () => {
    const r = computeReputation("did:alice", [
      bundle({ primaryClaim: "did:alice", state: "completed" }),
      bundle({ primaryClaim: "did:alice", state: "failed" }),
      bundle({ primaryClaim: "did:bob", state: "completed" }), // not the subject
    ]);
    expect(r).toEqual({
      primaryClaim: "did:alice",
      totalAgreements: 2,
      completed: 1,
      avgRating: null,
    });
  });

  test("averages only ratings addressed to the subject", () => {
    const r = computeReputation("did:alice", [
      bundle({
        ratings: [
          { from: "did:bob", to: "did:alice", score: 5 },
          { from: "did:alice", to: "did:bob", score: 1 }, // about bob, ignored
        ],
      }),
      bundle({ ratings: [{ from: "did:carol", to: "did:alice", score: 3 }] }),
    ]);
    expect(r.avgRating).toBe(4); // (5 + 3) / 2
    expect(r.completed).toBe(2);
  });

  test("empty set yields zeros and null average", () => {
    expect(computeReputation("did:alice", [])).toEqual({
      primaryClaim: "did:alice",
      totalAgreements: 0,
      completed: 0,
      avgRating: null,
    });
  });
});
