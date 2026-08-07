import { describe, expect, test } from "vitest";

import { computeReputation } from "../../src/agent/reputation.js";
import type { AttestationBundle } from "../../src/artifacts/types.js";

function bundle(over: Partial<AttestationBundle>): AttestationBundle {
  return {
    bundleVersion: "1",
    jobId: "j",
    outcome: "completed",
    listingRef: { listingId: "svc", version: 1, contentHash: "h" },
    agreementRef: { kind: "dacs-3-agreement", id: "a", contentHash: "h" },
    parties: [{ role: "seller", bundleHash: "h", primaryClaim: "did:alice" }],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: 1780000000000,
    ...over,
  };
}

const party = (claim: string) => ({ role: "seller", bundleHash: "h", primaryClaim: claim });

describe("computeReputation", () => {
  test("counts bundles the subject is a party to, and completed ones", () => {
    const r = computeReputation("did:alice", [
      bundle({ jobId: "j1", parties: [party("did:alice")], outcome: "completed" }),
      bundle({ jobId: "j2", parties: [party("did:alice")], outcome: "failed" }),
      bundle({ jobId: "j3", parties: [party("did:bob")], outcome: "completed" }), // not a party
    ]);
    expect(r).toEqual({
      primaryClaim: "did:alice",
      totalAgreements: 2,
      completed: 1,
      avgRating: null,
    });
  });

  test("matches the subject in any party slot (buyer or seller)", () => {
    const r = computeReputation("did:alice", [
      bundle({
        parties: [party("did:bob"), party("did:alice")],
        outcome: "completed",
      }),
    ]);
    expect(r.totalAgreements).toBe(1);
    expect(r.completed).toBe(1);
  });

  test("empty set yields zeros and null average", () => {
    expect(computeReputation("did:alice", [])).toEqual({
      primaryClaim: "did:alice",
      totalAgreements: 0,
      completed: 0,
      avgRating: null,
    });
  });

  test("deduplicates multiple bundle copies for the same session", () => {
    const copies = [
      bundle({ jobId: "same", anchoredByRole: "buyer" }),
      bundle({ jobId: "same", anchoredByRole: "seller" }),
    ];
    expect(computeReputation("did:alice", copies).totalAgreements).toBe(1);
  });
});
