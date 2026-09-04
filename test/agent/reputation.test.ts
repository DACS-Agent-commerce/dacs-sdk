import { describe, expect, test } from "vitest";

import { computeReputation } from "../../src/agent/reputation.js";
import type { AttestationBundle } from "../../src/artifacts/types.js";

const ALICE = "did:example:alice";
const BOB = "did:example:bob";

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
      { role: "seller", bundleHash: "c".repeat(64), primaryClaim: ALICE },
    ],
    phaseSummary: [],
    vetRecords: [],
    settlementEvidence: [],
    recipeRegistryVersion: 1,
    railRegistryVersion: 1,
    finalisedAt: 1780000000000,
    signatures: [{ party: ALICE, algorithm: "ed25519", value: "sig" }],
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
    const r = computeReputation(ALICE, [
      bundle({ jobId: "j1", parties: [party(ALICE)], outcome: "completed" }),
      bundle({ jobId: "j2", parties: [party(ALICE)], outcome: "failed-perm" }),
      bundle({ jobId: "j3", parties: [party(BOB)], outcome: "completed" }), // not a party
    ]);
    expect(r).toEqual({
      primaryClaim: ALICE,
      totalAgreements: 2,
      completed: 1,
      avgRating: null,
      exclusions: [],
    });
  });

  test("matches the subject in any party slot (buyer or seller)", () => {
    const r = computeReputation(ALICE, [
      bundle({
        parties: [party(BOB), party(ALICE)],
        outcome: "completed",
      }),
    ]);
    expect(r.totalAgreements).toBe(1);
    expect(r.completed).toBe(1);
  });

  test("empty set yields zeros and null average", () => {
    expect(computeReputation(ALICE, [])).toEqual({
      primaryClaim: ALICE,
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
    expect(computeReputation(ALICE, copies).totalAgreements).toBe(1);
  });

  test("coalesces parameter variants under the parameter-free CF-3 identity", () => {
    const r = computeReputation(`${ALICE}?jurisdiction=GB`, [
      bundle({
        jobId: "qualified",
        parties: [party(`${ALICE}?jurisdiction=US`)],
      }),
    ]);
    expect(r).toMatchObject({ primaryClaim: ALICE, totalAgreements: 1 });
  });

  test("does not alias native or foreign references that share Demos key bytes", () => {
    const key = "ab".repeat(32);
    const demos = `did:demos:agent:${key}`;
    expect(computeReputation(demos, [
      bundle({ parties: [party(`did:ethr:${key}`)] }),
      bundle({ parties: [party(`demos:0x${key}`)] }),
    ])).toMatchObject({ primaryClaim: demos, totalAgreements: 0 });
    expect(() => computeReputation(`0x${key}`, [])).toThrow(/CF-2/);
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
    const forward = computeReputation(ALICE, [buyer, seller]);
    const reverse = computeReputation(ALICE, [seller, buyer]);
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
