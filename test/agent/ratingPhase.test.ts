import { describe, expect, test, vi } from "vitest";

import type {
  AttestationRef,
  RatingRecord,
} from "../../src/artifacts/types.js";
import {
  completeRatingPhase,
  createRatingPhasePlan,
  type CompleteRatingPhaseDeps,
  type RatingPhaseAuthorityInput,
  type RatingPhasePlan,
  type RatingPhaseSubmission,
} from "../../src/agent/ratingPhase.js";
import type { DurablePublishedRating } from "../../src/agent/durableRatingPublication.js";
import { buildTwoSidedBundle } from "../../src/agent/twoSidedBundle.js";
import {
  contentHash,
  ratingAddress,
  stripSignature,
} from "../../src/canonical/index.js";

const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;
const JOB = "rating-phase-job";
const SESSION_HASH = "a".repeat(64);

function authority(required = false): RatingPhaseAuthorityInput {
  const pipeline = [
    { kind: "vet-credentials" as const },
    { kind: "negotiate-fixed-price" as const },
    { kind: "commit-payee-bound-agreement" as const },
    { kind: "pay-x402" as const, parameters: { rail: "x402" } },
    { kind: "deliver-attested-payload" as const },
    { kind: "rate" as const, parameters: { required } },
  ];
  return {
    jobId: JOB,
    sessionRecordHash: SESSION_HASH,
    state: "rate-pending",
    parties: [
      { role: "buyer", primaryClaim: BUYER },
      { role: "seller", primaryClaim: SELLER },
    ],
    pipeline,
    phaseResults: pipeline.slice(0, -1).map((step, index) => ({
      index,
      step,
      ok: true,
    })),
  };
}

async function plan(required = false): Promise<Readonly<RatingPhasePlan>> {
  return createRatingPhasePlan(authority(required), {
    authenticateAuthority: async () => ({ disposition: "valid" }),
  });
}

function published(
  role: "buyer" | "seller",
  value: number,
  ratedAt: number,
): DurablePublishedRating {
  const rater = role === "buyer" ? BUYER : SELLER;
  const target = role === "buyer" ? SELLER : BUYER;
  const targetRole = role === "buyer" ? "seller" as const : "buyer" as const;
  const record: RatingRecord = {
    ratingVersion: "1",
    jobId: JOB,
    rater,
    target,
    targetRole,
    value,
    ratedAt,
    signature: {
      algorithm: "ed25519",
      signer: rater,
      value: Buffer.alloc(64, value).toString("base64url"),
    },
  };
  const nativeAddress = `native-${role}`;
  return {
    publicationVersion: "1",
    logicalAddress: ratingAddress(JOB, rater),
    expectedOwner: `${role}-owner`,
    nativeAddress,
    bindingContentHash: contentHash(record as unknown as Record<string, unknown>),
    record,
    ref: {
      anchor: { kind: "storage-program", locator: nativeAddress },
      contentHash: contentHash(
        stripSignature(record as unknown as Record<string, unknown>),
      ),
      signer: rater,
    },
  };
}

const validPublication = async () => ({ disposition: "valid" as const });
const completeDeps = (
  authenticatePublication: CompleteRatingPhaseDeps["authenticatePublication"] =
    validPublication,
): CompleteRatingPhaseDeps => ({
  authenticatePlan: async () => ({ disposition: "valid" as const }),
  authenticatePublication,
});

describe("DACS-5 ST-4/ST-5 rating phase handoff", () => {
  test("authenticates a rate-pending projection only after every prior phase succeeded", async () => {
    const authenticateAuthority = vi.fn(async () => ({ disposition: "valid" as const }));
    const result = await createRatingPhasePlan(authority(true), {
      authenticateAuthority,
    });

    expect(result).toMatchObject({
      planVersion: "1",
      jobId: JOB,
      buyer: BUYER,
      seller: SELLER,
      phaseIndex: 5,
      settlementPhaseIndices: [3, 4],
      requiredAdvisory: true,
    });
    expect(result.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(authenticateAuthority).toHaveBeenCalledOnce();
  });

  test("rejects missing, failed, reordered, duplicate-party, and non-final rate authority", async () => {
    const cases: RatingPhaseAuthorityInput[] = [];
    const missing = authority();
    missing.phaseResults = missing.phaseResults.slice(0, -1);
    cases.push(missing);
    const failed = authority();
    failed.phaseResults[3]!.ok = false;
    cases.push(failed);
    const reordered = authority();
    reordered.phaseResults[3]!.index = 2;
    cases.push(reordered);
    const duplicate = authority();
    (duplicate.parties as Array<{ role: "buyer"; primaryClaim: string }>)[1] = {
      role: "buyer",
      primaryClaim: SELLER,
    };
    cases.push(duplicate);
    const nonFinal = authority();
    nonFinal.pipeline = [
      ...nonFinal.pipeline.slice(0, -1),
      { kind: "rate" },
      { kind: "deliver-attested-payload" },
    ];
    nonFinal.phaseResults = nonFinal.pipeline.slice(0, -1).map((step, index) => ({
      index,
      step,
      ok: true,
    }));
    cases.push(nonFinal);

    for (const candidate of cases) {
      await expect(createRatingPhasePlan(candidate, {
        authenticateAuthority: async () => ({ disposition: "valid" }),
      })).rejects.toThrow();
    }
  });

  test("fails closed on invalid, indeterminate, thrown, or malformed authority verdicts", async () => {
    for (const verdict of [
      { disposition: "invalid", reason: "bad session" },
      { disposition: "indeterminate", reason: "session unavailable" },
      { disposition: "valid", extra: true },
    ]) {
      await expect(createRatingPhasePlan(authority(), {
        authenticateAuthority: async () => verdict as never,
      })).rejects.toThrow(/authority/);
    }
    await expect(createRatingPhasePlan(authority(), {
      authenticateAuthority: async () => {
        throw new Error("transport down");
      },
    })).rejects.toThrow(/indeterminate/);
  });

  test("snapshots authority before its asynchronous verifier permits mutation", async () => {
    const input = authority();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const verifierStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = createRatingPhasePlan(input, {
      authenticateAuthority: async () => {
        started();
        await gate;
        return { disposition: "valid" };
      },
    });
    await verifierStarted;
    input.jobId = "mutated";
    input.parties[0]!.primaryClaim = SELLER;
    release();

    const result = await pending;
    expect(result.jobId).toBe(JOB);
    expect(result.buyer).toBe(BUYER);
  });

  test("carries two independently authenticated directions into one exact terminal handoff", async () => {
    const buyer = published("buyer", 5, 1_000);
    const seller = published("seller", 4, 1_001);
    const authenticatePublication = vi.fn(validPublication);
    const result = await completeRatingPhase(
      await plan(),
      [
        { role: "seller", disposition: "published", publication: seller },
        { role: "buyer", disposition: "published", publication: buyer },
      ],
      1_100,
      completeDeps(authenticatePublication as never),
    );

    expect(result.disposition).toBe("ready");
    if (result.disposition !== "ready") throw new Error("unreachable");
    expect(result.ratingRefs).toEqual([buyer.ref, seller.ref]);
    expect(result.roleResults.map(({ role }) => role)).toEqual(["buyer", "seller"]);
    expect(result.phaseEntry).toEqual({
      index: 5,
      step: { kind: "rate", parameters: { required: false } },
      invokedAt: 1_100,
      result: { ok: true, contextDelta: { ratingRefs: [buyer.ref, seller.ref] } },
      contextDelta: { ratingRefs: [buyer.ref, seller.ref] },
    });
    expect(result.requiredAdvisoryMissingRoles).toEqual([]);
    expect(result.handoffHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(result.phaseEntry)).toBe(true);
    expect(authenticatePublication).toHaveBeenCalledTimes(2);
  });

  test("feeds the handoff refs and phase summary into the existing two-sided finalizer", async () => {
    const buyer = published("buyer", 5, 1_000);
    const seller = published("seller", 4, 1_001);
    const handoff = await completeRatingPhase(
      await plan(),
      [
        { role: "buyer", disposition: "published", publication: buyer },
        { role: "seller", disposition: "published", publication: seller },
      ],
      1_100,
      completeDeps(),
    );
    if (handoff.disposition !== "ready") throw new Error("unreachable");
    const fakeSigner = async () => Uint8Array.from(Buffer.alloc(64, 7));
    const bundles = await buildTwoSidedBundle({
      jobId: JOB,
      outcome: "completed",
      listingRef: { listingId: "listing", version: 1, contentHash: "b".repeat(64) },
      agreementRef: {
        anchor: { kind: "storage-program", locator: "agreement-native" },
        contentHash: "c".repeat(64),
      },
      phaseSummary: [
        { index: 0, kind: "vet-credentials", outcome: "ok" },
        { index: 1, kind: "negotiate-fixed-price", outcome: "ok" },
        { index: 2, kind: "commit-payee-bound-agreement", outcome: "ok" },
        { index: 3, kind: "pay-x402", outcome: "ok" },
        { index: 4, kind: "deliver-attested-payload", outcome: "ok" },
        {
          index: handoff.phaseEntry.index,
          kind: handoff.phaseEntry.step.kind,
          outcome: handoff.phaseEntry.result.ok ? "ok" : "fail",
        },
      ],
      vetRecords: [],
      settlementEvidence: [],
      ratingRefs: [...handoff.ratingRefs],
      recipeRegistryVersion: 1,
      railRegistryVersion: 1,
      finalisedAt: 1_200,
      buyer: { primaryClaim: BUYER, bundleHash: "d".repeat(64), signer: fakeSigner },
      seller: { primaryClaim: SELLER, bundleHash: "e".repeat(64), signer: fakeSigner },
    });

    expect(bundles.buyerCopy?.ratingRefs).toEqual(handoff.ratingRefs);
    expect(bundles.sellerCopy?.ratingRefs).toEqual(handoff.ratingRefs);
    expect(bundles.buyerCopy?.phaseSummary.at(-1)).toMatchObject({
      kind: "rate",
      outcome: "ok",
    });
  });

  test("keeps decline and absence non-fatal even when required is advisory", async () => {
    const result = await completeRatingPhase(
      await plan(true),
      [{ role: "buyer", disposition: "declined", reason: "no comment" }],
      1_100,
      completeDeps(),
    );

    expect(result.disposition).toBe("ready");
    if (result.disposition !== "ready") throw new Error("unreachable");
    expect(result.ratingRefs).toEqual([]);
    expect(result.phaseEntry.result).toEqual({
      ok: false,
      reason: "rating absent, declined, or rejected",
      contextDelta: {},
    });
    expect(result.requiredAdvisoryMissingRoles).toEqual(["buyer", "seller"]);
    expect(result.roleResults).toEqual([
      { role: "buyer", disposition: "declined", reason: "no comment" },
      { role: "seller", disposition: "absent", reason: "no rating submitted" },
    ]);
  });

  test("keeps one valid direction when the other direction is invalid", async () => {
    const buyer = published("buyer", 5, 1_000);
    const seller = published("seller", 4, 1_001);
    const result = await completeRatingPhase(
      await plan(true),
      [
        { role: "buyer", disposition: "published", publication: buyer },
        { role: "seller", disposition: "published", publication: seller },
      ],
      1_100,
      completeDeps(async ({ role }) =>
        role === "buyer"
          ? { disposition: "valid" }
          : { disposition: "invalid", reason: "bad signature" }),
    );

    expect(result.disposition).toBe("ready");
    if (result.disposition !== "ready") throw new Error("unreachable");
    expect(result.ratingRefs).toEqual([buyer.ref]);
    expect(result.phaseEntry.result.ok).toBe(true);
    expect(result.requiredAdvisoryMissingRoles).toEqual(["seller"]);
  });

  test("waits rather than omitting a submitted publication whose authentication is indeterminate", async () => {
    const result = await completeRatingPhase(
      await plan(),
      [{ role: "buyer", disposition: "published", publication: published("buyer", 5, 1_000) }],
      1_100,
      completeDeps(async () => ({
        disposition: "indeterminate",
        reason: "anchor read unavailable",
      })),
    );

    expect(result).toEqual({
      disposition: "waiting",
      jobId: JOB,
      planHash: (await plan()).planHash,
      pendingRoles: ["buyer"],
      reason: "one or more submitted ratings remain authentication-indeterminate",
    });
  });

  test("treats thrown or malformed publication verdicts as indeterminate", async () => {
    const submission: RatingPhaseSubmission = {
      role: "buyer",
      disposition: "published",
      publication: published("buyer", 5, 1_000),
    };
    for (const authenticatePublication of [
      async () => {
        throw new Error("transport down");
      },
      async () => ({ disposition: "valid", extra: true }) as never,
    ]) {
      const result = await completeRatingPhase(
        await plan(),
        [submission],
        1_100,
        completeDeps(authenticatePublication as never),
      );
      expect(result.disposition).toBe("waiting");
    }
  });

  test("re-authenticates a replayed plan before inspecting any submission", async () => {
    const authenticatePublication = vi.fn(validPublication);
    await expect(completeRatingPhase(
      await plan(),
      [{ role: "buyer", disposition: "published", publication: published("buyer", 5, 1_000) }],
      1_100,
      {
        authenticatePlan: async () => ({
          disposition: "invalid",
          reason: "session no longer matches",
        }),
        authenticatePublication,
      },
    )).rejects.toThrow(/plan is invalid/);
    expect(authenticatePublication).not.toHaveBeenCalled();

    const waiting = await completeRatingPhase(
      await plan(),
      [],
      1_100,
      {
        authenticatePlan: async () => ({
          disposition: "indeterminate",
          reason: "session store unavailable",
        }),
        authenticatePublication,
      },
    );
    expect(waiting).toMatchObject({
      disposition: "waiting",
      pendingRoles: ["buyer", "seller"],
      reason: "session store unavailable",
    });
  });

  test("rejects a publication with wrong job, direction, ref, signer, address, or binding hash", async () => {
    const mutations: Array<(value: DurablePublishedRating) => void> = [
      (value) => { (value.record as RatingRecord).jobId = "other"; },
      (value) => { (value.record as RatingRecord).targetRole = "buyer"; },
      (value) => { (value.ref as AttestationRef).contentHash = "0".repeat(64); },
      (value) => { (value.ref as AttestationRef).signer = SELLER; },
      (value) => { value.logicalAddress = "wrong"; },
      (value) => { value.bindingContentHash = "0".repeat(64); },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(published("buyer", 5, 1_000));
      mutate(candidate);
      const result = await completeRatingPhase(
        await plan(),
        [{ role: "buyer", disposition: "published", publication: candidate }],
        1_100,
        completeDeps(),
      );
      expect(result.disposition).toBe("ready");
      if (result.disposition !== "ready") throw new Error("unreachable");
      expect(result.roleResults[0]?.disposition).toBe("rejected");
    }
  });

  test("rejects duplicate roles, empty decline reasons, invalid time, and a tampered plan", async () => {
    const current = await plan();
    await expect(completeRatingPhase(
      current,
      [
        { role: "buyer", disposition: "declined", reason: "first" },
        { role: "buyer", disposition: "declined", reason: "second" },
      ],
      1_100,
      completeDeps(),
    )).rejects.toThrow(/duplicated/);
    await expect(completeRatingPhase(
      current,
      [{ role: "buyer", disposition: "declined", reason: "" }],
      1_100,
      completeDeps(),
    )).rejects.toThrow(/malformed/);
    await expect(completeRatingPhase(
      current,
      [],
      -1,
      completeDeps(),
    )).rejects.toThrow(/invokedAt/);
    await expect(completeRatingPhase(
      { ...current, jobId: "tampered" },
      [],
      1_100,
      completeDeps(),
    )).rejects.toThrow(/hash/);
  });

  test("snapshots publications before async authentication and returns isolated refs", async () => {
    const publication = published("buyer", 5, 1_000);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const verifierStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = completeRatingPhase(
      await plan(),
      [{ role: "buyer", disposition: "published", publication }],
      1_100,
      completeDeps(async () => {
        started();
        await gate;
        return { disposition: "valid" };
      }),
    );
    await verifierStarted;
    (publication.record as RatingRecord).value = 1;
    (publication.ref as AttestationRef).contentHash = "0".repeat(64);
    release();

    const result = await pending;
    expect(result.disposition).toBe("ready");
    if (result.disposition !== "ready") throw new Error("unreachable");
    expect(result.ratingRefs[0]?.contentHash).not.toBe("0".repeat(64));
    expect(Object.isFrozen(result.ratingRefs[0])).toBe(true);
  });
});
