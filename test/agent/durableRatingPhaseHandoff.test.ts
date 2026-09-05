import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { RatingRecord } from "../../src/artifacts/types.js";
import {
  RATING_PHASE_HANDOFF_CHECKPOINT_KEY,
  persistRatingPhaseHandoffDurably,
  recoverRatingPhaseHandoff,
  type AuthenticateRatingPhaseHandoff,
  type PersistRatingPhaseHandoffDeps,
} from "../../src/agent/durableRatingPhaseHandoff.js";
import type { DurablePublishedRating } from "../../src/agent/durableRatingPublication.js";
import {
  completeRatingPhase,
  createRatingPhasePlan,
  type RatingPhaseAuthorityInput,
  type RatingPhaseReadyHandoff,
} from "../../src/agent/ratingPhase.js";
import {
  createInMemoryFencedSessionStore,
  type FencedSessionStoreV2,
  type SessionLeaseToken,
} from "../../src/agent/fencedSessionStore.js";
import { createFsFencedSessionStore } from "../../src/agent/fencedSessionStoreFs.js";
import {
  contentHash,
  ratingAddress,
  stripSignature,
} from "../../src/canonical/index.js";

const BUYER = `did:demos:agent:${"11".repeat(32)}`;
const SELLER = `did:demos:agent:${"22".repeat(32)}`;
const JOB = "01J00000000000000000000040";
const SESSION_HASH = "a".repeat(64);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

function authority(jobId = JOB): RatingPhaseAuthorityInput {
  const pipeline = [
    { kind: "pay-x402" as const, parameters: { rail: "x402" } },
    { kind: "deliver-attested-payload" as const },
    { kind: "rate" as const, parameters: { required: true } },
  ];
  return {
    jobId,
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

function buyerPublication(jobId = JOB): DurablePublishedRating {
  const record: RatingRecord = {
    ratingVersion: "1",
    jobId,
    rater: BUYER,
    target: SELLER,
    targetRole: "seller",
    value: 5,
    ratedAt: 100,
    signature: {
      algorithm: "ed25519",
      signer: BUYER,
      value: Buffer.alloc(64, 7).toString("base64url"),
    },
  };
  const nativeAddress = "native-buyer-rating";
  return {
    publicationVersion: "1",
    logicalAddress: ratingAddress(jobId, BUYER),
    expectedOwner: "buyer-owner",
    nativeAddress,
    bindingContentHash: contentHash(record as unknown as Record<string, unknown>),
    record,
    ref: {
      anchor: { kind: "storage-program", locator: nativeAddress },
      contentHash: contentHash(
        stripSignature(record as unknown as Record<string, unknown>),
      ),
      signer: BUYER,
    },
  };
}

async function handoff(
  invokedAt = 200,
  jobId = JOB,
): Promise<Readonly<RatingPhaseReadyHandoff>> {
  const plan = await createRatingPhasePlan(authority(jobId), {
    authenticateAuthority: async () => ({ disposition: "valid" }),
  });
  const result = await completeRatingPhase(
    plan,
    [{
      role: "buyer",
      disposition: "published",
      publication: buyerPublication(jobId),
    }],
    invokedAt,
    {
      authenticatePlan: async () => ({ disposition: "valid" }),
      authenticatePublication: async () => ({ disposition: "valid" }),
    },
  );
  if (result.disposition !== "ready") throw new Error("rating handoff was not ready");
  return result;
}

const validAuthentication = async () => ({ disposition: "valid" as const });

function deps(
  store: FencedSessionStoreV2,
  overrides: Partial<{
    workerId: string;
    leaseTtlMs: number;
    nowMs: () => number;
    authenticateHandoff: AuthenticateRatingPhaseHandoff;
  }> = {},
): PersistRatingPhaseHandoffDeps {
  return {
    store,
    workerId: overrides.workerId ?? "rating-worker",
    leaseTtlMs: overrides.leaseTtlMs ?? 100,
    nowMs: overrides.nowMs ?? (() => 0),
    authenticateHandoff: overrides.authenticateHandoff ?? validAuthentication,
  };
}

describe("durable DACS-5 rating-to-audit handoff", () => {
  test("commits the exact handoff and audit-pending transition atomically", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    const ready = await handoff();
    const authenticateHandoff = vi.fn(validAuthentication);

    const result = await persistRatingPhaseHandoffDurably(
      ready,
      deps(store, { authenticateHandoff }),
    );

    expect(result).toEqual({ disposition: "persisted", handoff: ready, recovered: false });
    expect(authenticateHandoff).toHaveBeenCalledOnce();
    const loaded = await store.load(JOB);
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.phase).toBe("audit-pending");
    expect(loaded.record.lease).toBeUndefined();
    expect(loaded.record.checkpoints.map(({ stage }) => stage)).toEqual([
      "intent",
      "outcome",
    ]);
    expect(loaded.record.checkpoints[1]?.data).toMatchObject({
      jobId: JOB,
      handoffHash: ready.handoffHash,
      planHash: ready.planHash,
    });
  });

  test("recovers the committed handoff read-only without minting another lease", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    const ready = await handoff();
    await persistRatingPhaseHandoffDurably(ready, deps(store));
    const before = await store.load(JOB);
    if (before.status !== "ok") throw new Error("session missing");

    const recovered = await recoverRatingPhaseHandoff(JOB, {
      store,
      authenticateHandoff: validAuthentication,
    });
    const replay = await persistRatingPhaseHandoffDurably(ready, deps(store));
    const after = await store.load(JOB);

    expect(recovered).toEqual({ disposition: "recovered", handoff: ready });
    expect(replay).toEqual({ disposition: "persisted", handoff: ready, recovered: true });
    expect(after).toEqual(before);
    expect(recovered.disposition === "recovered" && recovered.handoff.ratingRefs)
      .toEqual(ready.ratingRefs);
    expect(recovered.disposition === "recovered" && recovered.handoff.phaseEntry)
      .toEqual(ready.phaseEntry);
  });

  test("rejects a second valid handoff instead of rebinding the session", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    const first = await handoff(200);
    const second = await handoff(201);
    await persistRatingPhaseHandoffDurably(first, deps(store));

    await expect(persistRatingPhaseHandoffDurably(second, deps(store)))
      .resolves.toMatchObject({
        disposition: "rejected",
        stage: "checkpoint",
        reason: expect.stringContaining("different rating handoff"),
      });
    const recovered = await recoverRatingPhaseHandoff(JOB, {
      store,
      authenticateHandoff: validAuthentication,
    });
    expect(recovered.disposition === "recovered" && recovered.handoff.handoffHash)
      .toBe(first.handoffHash);
  });

  test("recovers when another worker commits between the initial load and lease", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    const ready = await handoff();
    let competitorResult: Awaited<ReturnType<typeof persistRatingPhaseHandoffDurably>> | undefined;
    const racingStore: FencedSessionStoreV2 = {
      ...store,
      acquireLease: async (input) => {
        competitorResult = await persistRatingPhaseHandoffDurably(
          ready,
          deps(store, { workerId: "competitor" }),
        );
        return store.acquireLease(input);
      },
    };

    const result = await persistRatingPhaseHandoffDurably(
      ready,
      deps(racingStore, { workerId: "delayed-worker" }),
    );

    expect(competitorResult?.disposition).toBe("persisted");
    expect(result).toEqual({ disposition: "persisted", handoff: ready, recovered: true });
    const loaded = await store.load(JOB);
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.checkpoints).toHaveLength(2);
    expect(loaded.record.lease).toBeUndefined();
  });

  test("stops before the WAL on invalid authority and releases its lease", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    const result = await persistRatingPhaseHandoffDurably(
      await handoff(),
      {
        ...deps(store),
        authenticateHandoff: async () => ({
          disposition: "invalid",
          reason: "retained SessionRecord hash differs",
        }),
      },
    );

    expect(result).toMatchObject({
      disposition: "rejected",
      stage: "authentication",
    });
    const loaded = await store.load(JOB);
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.checkpoints).toEqual([]);
    expect(loaded.record.lease).toBeUndefined();
  });

  test("recovers one exact intent after process restart and fences the stale generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dacs-rating-handoff-"));
    directories.push(directory);
    const firstStore = await createFsFencedSessionStore({ dir: directory });
    await firstStore.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    let staleLease: SessionLeaseToken | undefined;
    const crashingStore: FencedSessionStoreV2 = {
      ...firstStore,
      acquireLease: async (input) => {
        const result = await firstStore.acquireLease(input);
        if (result.ok) {
          staleLease = {
            owner: result.lease.owner,
            generation: result.lease.generation,
          };
        }
        return result;
      },
      transition: async (input) => {
        if (
          input.checkpoint?.key === RATING_PHASE_HANDOFF_CHECKPOINT_KEY &&
          input.checkpoint.stage === "outcome"
        ) {
          throw new Error("simulated process death after WAL intent");
        }
        return firstStore.transition(input);
      },
    };
    const ready = await handoff();
    const interrupted = await persistRatingPhaseHandoffDurably(
      ready,
      deps(crashingStore, { leaseTtlMs: 10, nowMs: () => 0 }),
    );
    expect(interrupted).toMatchObject({ disposition: "indeterminate", stage: "commit" });

    const restartedStore = await createFsFencedSessionStore({ dir: directory });
    const pending = await recoverRatingPhaseHandoff(JOB, {
      store: restartedStore,
      authenticateHandoff: validAuthentication,
    });
    expect(pending.disposition).toBe("pending");

    const resumed = await persistRatingPhaseHandoffDurably(
      ready,
      deps(restartedStore, {
        workerId: "recovery-worker",
        leaseTtlMs: 10,
        nowMs: () => 11,
      }),
    );
    expect(resumed).toEqual({ disposition: "persisted", handoff: ready, recovered: true });
    const after = await restartedStore.load(JOB);
    if (after.status !== "ok" || !staleLease) throw new Error("recovery state missing");
    const staleWrite = await restartedStore.transition({
      jobId: JOB,
      expectedRevision: after.record.revision,
      leaseToken: staleLease,
      phase: "finalised",
      now: 12,
    });
    expect(staleWrite).toMatchObject({ ok: false, reason: "lease-fenced" });
  });

  test("reconciles a lost commit acknowledgement without writing a second outcome", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    const ready = await handoff();
    let lost = false;
    const lostAcknowledgementStore: FencedSessionStoreV2 = {
      ...store,
      transition: async (input) => {
        const result = await store.transition(input);
        if (
          !lost &&
          input.checkpoint?.key === RATING_PHASE_HANDOFF_CHECKPOINT_KEY &&
          input.checkpoint.stage === "outcome"
        ) {
          lost = true;
          throw new Error("simulated lost durable commit acknowledgement");
        }
        return result;
      },
    };

    const uncertain = await persistRatingPhaseHandoffDurably(
      ready,
      deps(lostAcknowledgementStore),
    );
    expect(uncertain).toMatchObject({ disposition: "indeterminate", stage: "commit" });
    const replay = await persistRatingPhaseHandoffDurably(ready, deps(store));
    expect(replay).toEqual({ disposition: "persisted", handoff: ready, recovered: true });
    const loaded = await store.load(JOB);
    if (loaded.status !== "ok") throw new Error("session missing");
    expect(loaded.record.phase).toBe("audit-pending");
    expect(loaded.record.checkpoints).toHaveLength(2);
  });

  test("does not trust a success response without the exact committed outcome", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    const lyingStore: FencedSessionStoreV2 = {
      ...store,
      transition: async (input) => {
        if (
          input.checkpoint?.key === RATING_PHASE_HANDOFF_CHECKPOINT_KEY &&
          input.checkpoint.stage === "outcome"
        ) {
          const retained = await store.load(input.jobId);
          if (retained.status !== "ok") throw new Error("session missing");
          return { ok: true, record: retained.record };
        }
        return store.transition(input);
      },
    };

    await expect(persistRatingPhaseHandoffDurably(
      await handoff(),
      deps(lyingStore),
    )).resolves.toMatchObject({
      disposition: "indeterminate",
      stage: "commit",
      reason: expect.stringContaining("atomically advance"),
    });
  });

  test("re-authenticates an outcome discovered while claiming the checkpoint", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    const racingStore: FencedSessionStoreV2 = {
      ...store,
      claimCheckpoint: async (input) => {
        const claimed = await store.claimCheckpoint(input);
        if (!claimed.ok) return claimed;
        const committed = await store.transition({
          jobId: input.jobId,
          expectedRevision: claimed.record.revision,
          leaseToken: input.leaseToken,
          phase: "audit-pending",
          checkpoint: {
            key: RATING_PHASE_HANDOFF_CHECKPOINT_KEY,
            stage: "outcome",
            data: input.data,
          },
          lease: null,
          now: input.now,
        });
        if (!committed.ok) throw new Error("competing commit failed");
        return { ok: false, reason: "completed", record: committed.record };
      },
    };
    let authenticationCalls = 0;

    const result = await persistRatingPhaseHandoffDurably(
      await handoff(),
      deps(racingStore, {
        authenticateHandoff: async () => {
          authenticationCalls += 1;
          return authenticationCalls === 1
            ? { disposition: "valid" }
            : { disposition: "invalid", reason: "retained authority changed" };
        },
      }),
    );

    expect(result).toMatchObject({
      disposition: "rejected",
      stage: "authentication",
      reason: "retained authority changed",
    });
    expect(authenticationCalls).toBe(2);
  });

  test("rejects tampering before invoking session authentication", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    const candidate = structuredClone(await handoff()) as RatingPhaseReadyHandoff;
    (candidate.phaseEntry as unknown as { invokedAt: number }).invokedAt += 1;
    const authenticateHandoff = vi.fn(validAuthentication);

    await expect(persistRatingPhaseHandoffDurably(
      candidate,
      deps(store, { authenticateHandoff }),
    )).rejects.toThrow(/handoff hash/);
    expect(authenticateHandoff).not.toHaveBeenCalled();
  });

  test("fails closed on a malformed completed checkpoint", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    const acquired = await store.acquireLease({
      jobId: JOB,
      owner: "corruptor",
      ttlMs: 100,
      now: 0,
    });
    if (!acquired.ok) throw new Error("lease missing");
    const claimed = await store.claimCheckpoint({
      jobId: JOB,
      key: RATING_PHASE_HANDOFF_CHECKPOINT_KEY,
      data: { schema: "wrong" },
      leaseToken: acquired.lease,
      now: 1,
    });
    if (!claimed.ok) throw new Error("checkpoint claim failed");
    const completed = await store.transition({
      jobId: JOB,
      expectedRevision: claimed.record.revision,
      leaseToken: acquired.lease,
      phase: "audit-pending",
      checkpoint: {
        key: RATING_PHASE_HANDOFF_CHECKPOINT_KEY,
        stage: "outcome",
        data: { schema: "wrong" },
      },
      lease: null,
      now: 2,
    });
    if (!completed.ok) throw new Error("checkpoint completion failed");

    await expect(recoverRatingPhaseHandoff(JOB, {
      store,
      authenticateHandoff: validAuthentication,
    })).resolves.toMatchObject({
      disposition: "indeterminate",
      stage: "checkpoint",
    });
  });

  test("snapshots caller data and callback authority before awaiting authentication", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    const ready = structuredClone(await handoff()) as RatingPhaseReadyHandoff;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const callbackStarted = new Promise<void>((resolve) => { started = resolve; });
    const authenticateHandoff = vi.fn(async () => {
      started();
      await gate;
      return { disposition: "valid" as const };
    });
    const dependencies = deps(store, { authenticateHandoff });
    const pending = persistRatingPhaseHandoffDurably(ready, dependencies);
    await callbackStarted;
    ready.jobId = "mutated";
    dependencies.workerId = "mutated-worker";
    dependencies.authenticateHandoff = async () => ({
      disposition: "invalid",
      reason: "mutated callback",
    });
    release();

    const result = await pending;
    expect(result.disposition).toBe("persisted");
    expect(result.disposition === "persisted" && result.handoff.jobId).toBe(JOB);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.disposition === "persisted" && result.handoff.phaseEntry))
      .toBe(true);
  });

  test("captures dependency properties once and preserves callback receivers", async () => {
    const store = createInMemoryFencedSessionStore();
    await store.create({ jobId: JOB, phase: "rate-pending", now: 0 });
    let workerReads = 0;
    const dependencies = {
      store,
      get workerId() {
        workerReads += 1;
        if (workerReads > 1) throw new Error("workerId read twice");
        return "receiver-worker";
      },
      leaseTtlMs: 100,
      nowMs() {
        expect(this).toBe(dependencies);
        return 0;
      },
      authenticateHandoff() {
        expect(this).toBe(dependencies);
        return { disposition: "valid" as const };
      },
    };

    await expect(persistRatingPhaseHandoffDurably(
      await handoff(),
      dependencies,
    )).resolves.toMatchObject({ disposition: "persisted" });
    expect(workerReads).toBe(1);
  });

  test("requires a canonical ULID for persisted and recovered handoffs", async () => {
    const store = createInMemoryFencedSessionStore();
    await expect(recoverRatingPhaseHandoff("durable-rating-handoff-job", {
      store,
      authenticateHandoff: validAuthentication,
    })).rejects.toThrow(/jobId is malformed/);
  });
});
