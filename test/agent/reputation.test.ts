import { describe, expect, test } from "vitest";

import { computeReputation } from "../../src/agent/reputation.js";
import type { AttestationBundle } from "../../src/artifacts/types.js";

function bundle(over: Partial<AttestationBundle>): AttestationBundle {
  return {
    bundleVersion: "1",
    jobId: "j",
    outcome: "completed",
    anchoredByRole: "seller",
    listingRef: { listingId: "svc", version: 1, contentHash: "a".repeat(64) },
    agreementRef: {
      anchor: { kind: "storage-program", locator: "a" },
      contentHash: "b".repeat(64),
    },
    parties: [
      { role: "seller", bundleHash: "c".repeat(64), primaryClaim: "did:alice" },
    ],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: 1780000000000,
    signatures: [{ party: "did:alice", algorithm: "ed25519", value: "sig" }],
    ...over,
  };
}

const party = (claim: string) => ({
  role: "seller",
  bundleHash: "d".repeat(64),
  primaryClaim: claim,
});

describe("computeReputation", () => {
  test("counts bundles the subject is a party to, and completed ones", () => {
    const r = computeReputation("did:alice", [
      bundle({ jobId: "j1", parties: [party("did:alice")], outcome: "completed" }),
      bundle({ jobId: "j2", parties: [party("did:alice")], outcome: "failed-perm" }),
      bundle({ jobId: "j3", parties: [party("did:bob")], outcome: "completed" }), // not a party
    ]);
    expect(r).toEqual({
      primaryClaim: "did:alice",
      totalAgreements: 2,
      completed: 1,
      avgRating: null,
      exclusions: [],
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
      exclusions: [],
    });
  });

  test("deduplicates multiple bundle copies for the same session", () => {
    const copies = [
      bundle({ jobId: "same", anchoredByRole: "buyer" }),
      bundle({ jobId: "same", anchoredByRole: "seller" }),
    ];
    expect(computeReputation("did:alice", copies).totalAgreements).toBe(1);
  });

  test("excludes divergent copies deterministically in either input order", () => {
    const buyer = bundle({
      jobId: "disputed",
      anchoredByRole: "buyer",
      outcome: "completed",
    });
    const seller = bundle({
      jobId: "disputed",
      anchoredByRole: "seller",
      outcome: "failed-substrate",
    });
    const forward = computeReputation("did:alice", [buyer, seller]);
    const reverse = computeReputation("did:alice", [seller, buyer]);
    expect(reverse).toEqual(forward);
    expect(forward).toMatchObject({
      totalAgreements: 0,
      completed: 0,
      exclusions: [
        {
          code: "divergent-copies",
          jobId: "disputed",
        },
      ],
    });
  });
});
