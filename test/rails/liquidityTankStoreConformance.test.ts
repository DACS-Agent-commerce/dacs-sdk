import { describe, expect, test, vi } from "vitest";

import {
  createInMemoryLiquidityTankStore,
  type LiquidityTankLease,
  type LiquidityTankObservation,
  type LiquidityTankStore,
  type LiquidityTankStoreClaim,
} from "../../src/rails/liquidityTank.js";
import {
  runLiquidityTankStoreConformance,
  type LiquidityTankStoreConformanceOptions,
  type LiquidityTankStoreConformanceResult,
} from "../../src/rails/liquidityTankStoreConformance.js";
import * as rails from "../../src/rails/index.js";
import * as root from "../../src/index.js";

const VOLATILE = { acknowledgeVolatile: true } as const;

test.each([undefined, "", "production", "staging"])("conformance requires an explicit isolated test/development environment, got %s", async (mode) => {
  const createStore = vi.fn();
  vi.stubEnv("NODE_ENV", mode);
  try {
    await expect(runLiquidityTankStoreConformance({ createStore, reopenStore: vi.fn() }))
      .rejects.toThrow("requires NODE_ENV=test or NODE_ENV=development in a dedicated conformance process");
    expect(createStore).not.toHaveBeenCalled();
  } finally { vi.unstubAllEnvs(); }
});

test.each(["test", "development"])("conformance accepts its documented %s environment", async (mode) => {
  vi.stubEnv("NODE_ENV", mode);
  try { expect(failedNames(await runLiquidityTankStoreConformance(database()))).toEqual([]); }
  finally { vi.unstubAllEnvs(); }
});
const IDENTITY_REOPEN =
  "reopenStore returned the handle it was given; it must open a new handle on the same durable state";

const CASE = {
  exactLease: "claim acquires an exact lease and echoes the intent",
  liveLease: "claim waits on a live lease held by another owner",
  binding: "claim refuses a different binding for the same phase",
  takeover: "lease takeover raises the generation and fences the old owner",
  writeExpiry: "every ordinary write refuses a lease that has expired at its now",
  firstSubmission: "the first submission is kept and a replacement is refused",
  receipt: "the first submission's receipt is its write's now, kept across replays and restarts",
  bridge:"a bridge operation serves one settlement only",
  ordering: "observations need the retained submission and never regress",
  lateCompletion: "a completion after the deadline is never recorded as an observation; one at the deadline is timely",
  settlementNeedsCompletion: "a settlement needs a durable timely completion",
  settlementExact: "a settlement is exact, replayable and terminal",
  settlementBlocksExpiry: "a settlement blocks recovery expiry",
  completionBlocksExpiry: "a durable timely completion blocks recovery expiry before its settlement is written",
  expiryCas: "recovery expiry is a compare-and-swap on the exact durable checkpoint",
  expiryBlocks: "recovery expiry blocks a later completion and settlement",
  failureRetention: "terminal failure evidence is retained once, echoed and expires the lock",
  failureCleared: "a timely completion clears retained failure evidence and wins",
  failureLockCompletion: "a timely completion of the lock a durable failure carries replaces it and blocks expiry",
  failureEvidence: "a failure that carries its lock is expiry evidence only as the durable observation",
  completionLock: "a late completion is expiry evidence only for the durable lock and its deadline",
  contradictionCas: "a contradiction expires a lock only when stamped after its checkpoint and after the deadline, never while the operation is live",
  restart: "retained state survives a restart",
  settles: "through the core, crashes and restarts never double-send, lock more than the intent or settle an expired phase",
  expires: "through the core, an expired phase stays expired across restarts and a late release",
  claimRace: "concurrent claims elect exactly one owner, on a fresh phase or a takeover",
  submissionRace: "concurrent submissions for one phase keep exactly one",
  bridgeRace: "concurrent submissions on one bridge operation serve one settlement",
  completionExpiryRace: "a timely completion racing recovery expiry: exactly one wins",
  settlementExpiryRace: "a settlement racing recovery expiry after a durable timely completion: only the settlement wins",
  takeoverRace: "a takeover racing each ordinary write: the write lands before the takeover or not at all",
  coreRace: "through the core, two workers starting one phase at once broadcast at most once",
} as const;

const RESTART_CASES = [CASE.receipt, CASE.bridge, CASE.restart, CASE.settles, CASE.expires];
const RACE_CASES = [
  CASE.claimRace, CASE.submissionRace, CASE.bridgeRace, CASE.completionExpiryRace,
  CASE.settlementExpiryRace, CASE.takeoverRace, CASE.coreRace,
];

const failedNames = (results: readonly LiquidityTankStoreConformanceResult[]) =>
  results.filter((result) => !result.passed).map((result) => result.name);
const failureOf = (results: readonly LiquidityTankStoreConformanceResult[], name: string) =>
  results.find((result) => result.name === name)?.failure;

/** A macrotask turn: two operations started together interleave here. */
const yieldTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

type WriteInput = { settlementKey: string; bindingHash: string; owner: string; generation: number; now: number };

/**
 * The reference store standing in for a database: every handle, including one
 * from `reopenStore`, is a new object reaching the same rows, as connections
 * to one database would. `patch` replaces methods of that database, once per
 * database, to break one rule.
 */
function database(
  patch: (inner: LiquidityTankStore) => Partial<LiquidityTankStore> = () => ({}),
): LiquidityTankStoreConformanceOptions {
  const databases = new WeakMap<LiquidityTankStore, LiquidityTankStore>();
  const open = (db: LiquidityTankStore): LiquidityTankStore => {
    const handle: LiquidityTankStore = {
      claim: (input) => db.claim(input),
      isCurrent: (input) => db.isCurrent(input),
      recordSubmission: (input) => db.recordSubmission(input),
      recordObservation: (input) => db.recordObservation(input),
      recordRecoveryFailure: (input) => db.recordRecoveryFailure(input),
      recordRecoveryExpired: (input) => db.recordRecoveryExpired(input),
      recordSettlement: (input) => db.recordSettlement(input),
    };
    databases.set(handle, db);
    return handle;
  };
  return {
    createStore: () => {
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      return open({ ...inner, ...patch(inner) });
    },
    reopenStore: (store) => open(databases.get(store) as LiquidityTankStore),
  };
}

/** A database whose reopened handle starts empty, as the reference store does after a restart. */
function forgetful(): LiquidityTankStoreConformanceOptions {
  return {
    createStore: () => createInMemoryLiquidityTankStore(VOLATILE),
    reopenStore: () => createInMemoryLiquidityTankStore(VOLATILE),
  };
}

/** Durable rows, one reference store per settlement key, plus a cross-key bridge-ID index. */
interface Disk { rows: Map<string, LiquidityTankStore>; bridgeOwners: Map<string, string> }

/**
 * The code review's B2 store: rows are durable, but the bridge-ID index is
 * either per handle ("process", lost on every reopen) or read and written
 * around the row write ("racey", so two writes started together both pass).
 * The sweep's N1 store ("moved on refusal") shares the "racey" store's durable
 * index and its read, row write, index write order; it differs only in handing
 * the bridge ID to the settlement whose reuse it refuses, as reference-store
 * mutant 1989 did, so a retry of that reuse lands.
 */
function rowsWithBridgeIndex(index: "process" | "racey" | "moved on refusal"): LiquidityTankStoreConformanceOptions {
  const disks = new WeakMap<LiquidityTankStore, Disk>();
  const open = (disk: Disk): LiquidityTankStore => {
    const owners = index === "process" ? new Map<string, string>() : disk.bridgeOwners;
    const row = (key: string): LiquidityTankStore => {
      let store = disk.rows.get(key);
      if (!store) {
        store = createInMemoryLiquidityTankStore(VOLATILE);
        disk.rows.set(key, store);
      }
      return store;
    };
    const handle: LiquidityTankStore = {
      claim: (input) => row(input.intent.settlementKey).claim(input),
      isCurrent: (input) => row(input.settlementKey).isCurrent(input),
      recordSubmission: async (input) => {
        const owner = owners.get(input.submission.bridgeId);
        if (owner !== undefined && owner !== input.settlementKey) {
          if (index === "moved on refusal") owners.set(input.submission.bridgeId, input.settlementKey);
          return { status: "conflict", reason: "liquidity-tank-bridge-cross-settlement-reuse" };
        }
        const result = await row(input.settlementKey).recordSubmission(input);
        if (result.status === "recorded") owners.set(input.submission.bridgeId, input.settlementKey);
        return result;
      },
      recordObservation: (input) => row(input.settlementKey).recordObservation(input),
      recordRecoveryFailure: (input) => row(input.settlementKey).recordRecoveryFailure(input),
      recordRecoveryExpired: (input) => row(input.settlementKey).recordRecoveryExpired(input),
      recordSettlement: (input) => row(input.settlementKey).recordSettlement(input),
    };
    disks.set(handle, disk);
    return handle;
  };
  return {
    createStore: () => open({ rows: new Map(), bridgeOwners: new Map() }),
    reopenStore: (store) => open(disks.get(store) as Disk),
  };
}

/** `claimed` with its submission receipt replaced by `receipt(value)`, or removed where that is undefined. */
function withReceipt(
  claimed: LiquidityTankStoreClaim,
  receipt: (value: number) => number | undefined,
): LiquidityTankStoreClaim {
  if (!("submissionRecordedAt" in claimed) || claimed.submissionRecordedAt === undefined) return claimed;
  const { submissionRecordedAt, ...rest } = claimed;
  const replaced = receipt(submissionRecordedAt);
  return (replaced === undefined ? rest : { ...rest, submissionRecordedAt: replaced }) as LiquidityTankStoreClaim;
}

/** Rows are durable, but each handle keeps the receipts it wrote in its own memory. */
function receiptsInProcessMemory(): LiquidityTankStoreConformanceOptions {
  const durable = database();
  const handles = new WeakMap<LiquidityTankStore, LiquidityTankStore>();
  const open = (handle: LiquidityTankStore): LiquidityTankStore => {
    const receipts = new Map<string, number>();
    const wrapped: LiquidityTankStore = {
      ...handle,
      recordSubmission: async (input) => {
        const result = await handle.recordSubmission(input);
        if (result.status === "recorded") receipts.set(input.settlementKey, input.now);
        return result;
      },
      claim: async (input) =>
        withReceipt(await handle.claim(input), () => receipts.get(input.intent.settlementKey)),
    };
    handles.set(wrapped, handle);
    return wrapped;
  };
  return {
    createStore: async () => open(await durable.createStore()),
    reopenStore: async (store) => open(await durable.reopenStore(handles.get(store) as LiquidityTankStore)),
  };
}

/** Answers success where the reference store refuses `method` with `reason`. */
function accepting(
  method: "recordSubmission" | "recordObservation" | "recordRecoveryExpired" | "recordSettlement",
  reason: string,
  answer: "recorded" | "existing" = "recorded",
) {
  return (inner: LiquidityTankStore): Partial<LiquidityTankStore> => ({
    [method]: async (input: never) => {
      const result = await (inner[method] as (value: never) => Promise<{ status: string; reason?: string }>)(input);
      return result.status === "conflict" && result.reason === reason ? { status: answer } : result;
    },
  });
}

/** Remembers the lease of the latest acquired claim for each settlement key. */
function trackingLeases(inner: LiquidityTankStore) {
  const leases = new Map<string, LiquidityTankLease>();
  const claim: LiquidityTankStore["claim"] = async (input) => {
    const claimed = await inner.claim(input);
    if (claimed.status === "acquired") leases.set(input.intent.settlementKey, claimed.lease);
    return claimed;
  };
  return { claim, lease: (key: string) => leases.get(key) };
}

/** Every write and `isCurrent` goes through `rewrite` first. */
function rewritingWrites(
  inner: LiquidityTankStore,
  rewrite: <T extends WriteInput>(input: T) => T,
): Partial<LiquidityTankStore> {
  return {
    isCurrent: (input) => inner.isCurrent(rewrite(input)),
    recordSubmission: (input) => inner.recordSubmission(rewrite(input)),
    recordObservation: (input) => inner.recordObservation(rewrite(input)),
    recordRecoveryFailure: (input) => inner.recordRecoveryFailure(rewrite(input)),
    recordRecoveryExpired: (input) => inner.recordRecoveryExpired(rewrite(input)),
    recordSettlement: (input) => inner.recordSettlement(rewrite(input)),
  };
}

/**
 * Refuses a completion whenever the durable observation is a failure that
 * carries a lock, so that lock's timely release can never replace it.
 */
function blocksCompletionAfterLockBearingFailure(inner: LiquidityTankStore): Partial<LiquidityTankStore> {
  const durable = new Map<string, LiquidityTankObservation>();
  return {
    recordObservation: async (input) => {
      const prior = durable.get(input.settlementKey) as { status?: string; lockTxHash?: string } | undefined;
      if (input.observation.status === "completed" && prior?.status === "failed" && prior.lockTxHash !== undefined) {
        return { status: "conflict", reason: "refuses-completion-after-failure" };
      }
      const result = await inner.recordObservation(input);
      if (result.status === "recorded") durable.set(input.settlementKey, input.observation);
      return result;
    },
  };
}

/** Records any contradicted-after-lock expiry without checking its checkpoint, time or the host clock. */
function acceptingAnyContradictionExpiry(inner: LiquidityTankStore): Partial<LiquidityTankStore> {
  return {
    recordRecoveryExpired: async (input) =>
      (input.observation as { status: string }).status === "contradicted-after-lock"
        ? { status: "recorded" }
        : inner.recordRecoveryExpired(input),
  };
}

/**
 * Records a late completion as expiry evidence wherever the reference store
 * refuses it on the durable lock, when `skips` says so for that durable
 * observation and the completion's lock.
 */
function skippingCompletionLockCas(
  skips: (durable: { status: string; lockTxHash?: string }, completion: { lockTxHash: string }) => boolean,
) {
  return (inner: LiquidityTankStore): Partial<LiquidityTankStore> => {
    const durable = new Map<string, LiquidityTankObservation>();
    return {
      recordObservation: async (input) => {
        const result = await inner.recordObservation(input);
        if (result.status === "recorded") durable.set(input.settlementKey, input.observation);
        return result;
      },
      recordRecoveryExpired: async (input) => {
        const result = await inner.recordRecoveryExpired(input);
        const evidence = input.observation as { status: string; lockTxHash: string };
        const prior = durable.get(input.settlementKey) as { status: string; lockTxHash?: string } | undefined;
        return evidence.status === "completed" && prior !== undefined && result.status === "conflict" &&
          result.reason === "liquidity-tank-recovery-checkpoint-cas-failed" && skips(prior, evidence)
          ? { status: "recorded" }
          : result;
      },
    };
  };
}

type ExpiryInput = Parameters<LiquidityTankStore["recordRecoveryExpired"]>[0];

/**
 * The boundary before the deadline ruling, where the deadline millisecond
 * itself already counted as missed: wherever the reference store refuses an
 * expiry as not due and `atDeadline` finds the time that sits exactly on a
 * deadline, the store records the expiry the reference store gives that input
 * moved one millisecond later.
 */
function expiringAtTheDeadline(atDeadline: (input: ExpiryInput) => ExpiryInput | undefined) {
  return (inner: LiquidityTankStore): Partial<LiquidityTankStore> => ({
    recordRecoveryExpired: async (input) => {
      const result = await inner.recordRecoveryExpired(input);
      const later = result.status === "conflict" && result.reason === "liquidity-tank-recovery-expiry-not-due"
        ? atDeadline(input)
        : undefined;
      return later === undefined ? result : inner.recordRecoveryExpired(later);
    },
  });
}

type WriteMethod = "recordSubmission" | "recordObservation" | "recordRecoveryExpired" | "recordSettlement";

/**
 * Answers `recorded` wherever the reference store refuses a `method` write
 * that `matches` picks out, given what the database has recorded for that
 * settlement key so far, so one store breaks one rule only (code P2-9).
 */
function acceptingWhere<M extends WriteMethod>(
  method: M,
  matches: (input: Parameters<LiquidityTankStore[M]>[0], recorded: ReadonlySet<WriteMethod>) => boolean,
) {
  return (inner: LiquidityTankStore): Partial<LiquidityTankStore> => {
    const recorded = new Map<string, Set<WriteMethod>>();
    const tracked = (name: WriteMethod) => async (input: { settlementKey: string }) => {
      const kinds = recorded.get(input.settlementKey) ?? new Set<WriteMethod>();
      recorded.set(input.settlementKey, kinds);
      const result = await (inner[name] as (value: unknown) => Promise<{ status: string }>)(input);
      if (result.status === "recorded" || result.status === "existing") {
        kinds.add(name);
        return result;
      }
      if (name === method && matches(input as never, kinds)) {
        kinds.add(name);
        return { status: "recorded" };
      }
      return result;
    };
    return {
      recordSubmission: tracked("recordSubmission") as LiquidityTankStore["recordSubmission"],
      recordObservation: tracked("recordObservation") as LiquidityTankStore["recordObservation"],
      recordRecoveryExpired: tracked("recordRecoveryExpired") as LiquidityTankStore["recordRecoveryExpired"],
      recordSettlement: tracked("recordSettlement") as LiquidityTankStore["recordSettlement"],
    };
  };
}

/**
 * Answers `recorded` to a refused `method` write that names another bridge
 * operation than the phase's first recorded submission.
 */
function onAnotherBridgeOperation(method: "recordSubmission" | "recordObservation") {
  return (inner: LiquidityTankStore): Partial<LiquidityTankStore> => {
    const bridges = new Map<string, string>();
    return {
      recordSubmission: async (input) => {
        const result = await inner.recordSubmission(input);
        const first = bridges.get(input.settlementKey);
        if (result.status === "recorded" && first === undefined) {
          bridges.set(input.settlementKey, input.submission.bridgeId);
        }
        return method === "recordSubmission" && result.status === "conflict" &&
          first !== undefined && first !== input.submission.bridgeId ? { status: "recorded" } : result;
      },
      recordObservation: async (input) => {
        const result = await inner.recordObservation(input);
        const first = bridges.get(input.settlementKey);
        return method === "recordObservation" && result.status === "conflict" &&
          first !== undefined && first !== input.observation.bridgeId ? { status: "recorded" } : result;
      },
    };
  };
}

/** Ignores lease expiry on `method` writes only, as the 996815e reference store did on all of them. */
function ignoringLeaseExpiryOn(method: "recordObservation" | "recordSettlement") {
  return (inner: LiquidityTankStore): Partial<LiquidityTankStore> => {
    const tracked = trackingLeases(inner);
    return {
      claim: tracked.claim,
      [method]: (input: WriteInput) => {
        const lease = tracked.lease(input.settlementKey);
        return (inner[method] as (value: WriteInput) => Promise<unknown>)(
          lease && lease.owner === input.owner && lease.generation === input.generation &&
            input.now >= lease.expiresAt ? { ...input, now: lease.expiresAt - 1 } : input,
        );
      },
    };
  };
}

type Timed = { status: string; observedAt: number; recoveryDeadline?: number; finalityObservedAt?: number };
const evidenceOf = (input: ExpiryInput) => input.observation as unknown as Timed & {
  checkpoint?: { recoveryDeadline: number }; contradiction?: Timed;
};

/** Claims that overlap both read a free phase: the one that resumes first is granted a lease the store never wrote. */
function raceyClaims(inner: LiquidityTankStore): Partial<LiquidityTankStore> {
  let inFlight = 0;
  return {
    claim: async (input) => {
      inFlight += 1;
      await yieldTurn();
      const overlapped = inFlight > 1;
      inFlight -= 1;
      if (!overlapped) return inner.claim(input);
      return {
        status: "acquired",
        intent: input.intent,
        lease: { owner: input.owner, generation: 1, expiresAt: input.now + input.leaseDurationMs },
      };
    },
  };
}

/**
 * One kind of handle is honest. The other (the one `createStore` returns, or
 * every one from `reopenStore`) reads whether the phase has a row, yields a
 * turn, and on a phase it read as free grants itself a lease it never wrote.
 * Only a race that the stale handle enters first exposes it (Daybreak r11
 * P3-1).
 */
function handlesClaimingFromStaleReads(stale: "created" | "reopened"): LiquidityTankStoreConformanceOptions {
  const honest = database();
  const claimed = new Set<string>();
  const bases = new WeakMap<LiquidityTankStore, LiquidityTankStore>();
  const open = (base: LiquidityTankStore, staleReads: boolean): LiquidityTankStore => {
    const handle: LiquidityTankStore = {
      ...base,
      claim: async (input) => {
        const free = !claimed.has(input.intent.settlementKey);
        claimed.add(input.intent.settlementKey);
        if (!staleReads) return base.claim(input);
        await yieldTurn();
        return free
          ? { status: "acquired", intent: input.intent,
              lease: { owner: input.owner, generation: 1, expiresAt: input.now + input.leaseDurationMs } }
          : base.claim(input);
      },
    };
    bases.set(handle, base);
    return handle;
  };
  return {
    createStore: async () => open(await honest.createStore(), stale === "created"),
    reopenStore: async (store) =>
      open(await honest.reopenStore(bases.get(store) ?? store), stale === "reopened"),
  };
}

const BROKEN: readonly (readonly [string, string, () => LiquidityTankStoreConformanceOptions, RegExp])[] = [
  [CASE.exactLease, "stamps expiresAt one millisecond late", () => database((inner) => ({
    claim: async (input) => {
      const claimed = await inner.claim(input);
      return claimed.status === "acquired"
        ? { ...claimed, lease: { ...claimed.lease, expiresAt: claimed.lease.expiresAt + 1 } }
        : claimed;
    },
  })), /lease expiresAt is not exactly now \+ leaseDurationMs/],
  [CASE.liveLease, "takes over a live lease", () => database((inner) => ({
    claim: async (input) => {
      const claimed = await inner.claim(input);
      return claimed.status === "waiting" ? inner.claim({ ...input, now: claimed.lease.expiresAt }) : claimed;
    },
  })), /claim under a live lease returned acquired/],
  [CASE.binding, "reports a binding conflict as corruption", () => database((inner) => ({
    claim: async (input) => {
      const claimed = await inner.claim(input);
      return claimed.status === "conflict" ? { status: "corrupt", reason: claimed.reason } : claimed;
    },
  })), /claim with another binding returned corrupt/],
  [CASE.takeover, "fences by owner and ignores the generation", () => database((inner) => {
    const tracked = trackingLeases(inner);
    return {
      claim: tracked.claim,
      ...rewritingWrites(inner, (input) => {
        const lease = tracked.lease(input.settlementKey);
        return lease && lease.owner === input.owner ? { ...input, generation: lease.generation } : input;
      }),
    };
  }), /the same owner's stale generation is still current/],
  [CASE.writeExpiry, "ignores lease expiry on ordinary writes (the 996815e reference store)", () => database((inner) => {
    const tracked = trackingLeases(inner);
    const beforeExpiry = <T extends WriteInput>(input: T): T => {
      const lease = tracked.lease(input.settlementKey);
      return lease && lease.owner === input.owner && lease.generation === input.generation &&
        input.now >= lease.expiresAt ? { ...input, now: lease.expiresAt - 1 } : input;
    };
    return {
      claim: tracked.claim,
      recordSubmission: (input) => inner.recordSubmission(beforeExpiry(input)),
      recordObservation: (input) => inner.recordObservation(beforeExpiry(input)),
      recordSettlement: (input) => inner.recordSettlement(beforeExpiry(input)),
    };
  }), /submission after lease expiry: store answered recorded/],
  [CASE.writeExpiry, "ignores lease expiry on observation writes only",
    () => database(ignoringLeaseExpiryOn("recordObservation")),
    /observation after lease expiry: store answered recorded/],
  [CASE.writeExpiry, "ignores lease expiry on settlement writes only",
    () => database(ignoringLeaseExpiryOn("recordSettlement")),
    /settlement after lease expiry: store answered recorded/],
  [CASE.firstSubmission, "refuses a re-signed replacement but not one on another bridge operation",
    () => database(onAnotherBridgeOperation("recordSubmission")),
    /replacement on another bridge operation: store answered recorded/],
  [CASE.ordering, "records an observation before any submission", () => database(acceptingWhere(
    "recordObservation", (_input, recorded) => !recorded.has("recordSubmission"),
  )), /observation before any submission: store answered recorded/],
  [CASE.ordering, "records an observation of another bridge operation",
    () => database(onAnotherBridgeOperation("recordObservation")),
    /observation for another bridge operation: store answered recorded/],
  [CASE.ordering, "replaces the durable lock with a different one", () => database(acceptingWhere(
    "recordObservation", (input) => input.observation.status === "pending" &&
      (input.observation as { lockTxHash?: string }).lockTxHash === "another-lock",
  )), /a different lock: store answered recorded/],
  [CASE.settlementExact, "records an observation after the settlement", () => database(acceptingWhere(
    "recordObservation", (_input, recorded) => recorded.has("recordSettlement"),
  )), /observation after settlement: store answered recorded/],
  [CASE.expiryBlocks, "settles after the expiry", () => database(acceptingWhere(
    "recordSettlement", (_input, recorded) => recorded.has("recordRecoveryExpired"),
  )), /settlement after expiry: store answered recorded/],
  [CASE.expiryCas, "expires from a locked pending observed at the deadline", () => database(acceptingWhere(
    "recordRecoveryExpired", (input) => {
      const evidence = evidenceOf(input);
      return evidence.status === "pending" && evidence.observedAt === evidence.recoveryDeadline &&
        input.now > evidence.observedAt;
    },
  )), /expiry from a snapshot at the deadline: store answered recorded/],
  [CASE.firstSubmission, "accepts a replacement submission",
    () => database(accepting("recordSubmission", "liquidity-tank-submission-replacement-forbidden", "existing")),
    /re-signed replacement: store answered existing/],
  [CASE.receipt, "drops the submission's receipt from its claims", () => database((inner) => ({
    claim: async (input) => withReceipt(await inner.claim(input), () => undefined),
  })), /a waiting claim does not return the first submission write's now/],
  [CASE.receipt, "rewrites the receipt with each replay's now", () => database((inner) => {
    const latest = new Map<string, number>();
    return {
      recordSubmission: async (input) => {
        const result = await inner.recordSubmission(input);
        if (result.status === "recorded" || result.status === "existing") latest.set(input.settlementKey, input.now);
        return result;
      },
      claim: async (input) => withReceipt(await inner.claim(input),
        (value) => latest.get(input.intent.settlementKey) ?? value),
    };
  }), /a waiting claim does not return the first submission write's now/],
  [CASE.receipt, "stamps the receipt in seconds (Daybreak r11 P2-1)", () => database((inner) => ({
    claim: async (input) => withReceipt(await inner.claim(input), (value) => Math.floor(value / 1_000)),
  })), /a waiting claim does not return the first submission write's now/],
  [CASE.receipt, "keeps each receipt in the memory of the handle that wrote it", receiptsInProcessMemory,
    /after a restart, the acquired claim does not return the first submission write's now/],
  [CASE.receipt, "drops the receipt once the phase has expired", () => database((inner) => ({
    claim: async (input) => {
      const claimed = await inner.claim(input);
      return claimed.status === "recovery-expired" ? withReceipt(claimed, () => undefined) : claimed;
    },
  })), /after a restart, the recovery-expired claim does not return the first submission write's now/],
  [CASE.bridge, "lets a second settlement reuse a bridge ID",
    () => database(accepting("recordSubmission", "liquidity-tank-bridge-cross-settlement-reuse")),
    /second settlement reusing the bridge ID: store answered recorded/],
  [CASE.bridge, "hands the bridge ID to a settlement whose reuse it refuses (sweep N1)",
    () => rowsWithBridgeIndex("moved on refusal"),
    /second settlement reusing the bridge ID again: store answered recorded/],
  [CASE.bridge, "forgets its bridge-ID index on a restart", () => rowsWithBridgeIndex("process"),
    /after a restart, the second settlement reusing the bridge ID: store answered recorded/],
  [CASE.ordering, "accepts a status regression",
    () => database(accepting("recordObservation", "liquidity-tank-status-regression")),
    /regression to empty: store answered recorded/],
  [CASE.lateCompletion, "records a late completion as an observation",
    () => database(accepting("recordObservation", "liquidity-tank-completion-after-recovery-deadline")),
    /completion finalized a millisecond after the deadline: store answered recorded/],
  [CASE.lateCompletion, "refuses a completion finalized at the deadline", () => database((inner) => ({
    recordObservation: async (input) => {
      const observation = input.observation as unknown as Timed;
      return observation.status === "completed" && observation.finalityObservedAt === observation.recoveryDeadline
        ? { status: "conflict", reason: "liquidity-tank-completion-after-recovery-deadline" }
        : inner.recordObservation(input);
    },
  })), /completion finalized at the deadline: store answered conflict; expected recorded or existing/],
  [CASE.settlementNeedsCompletion, "settles with only the lock durable",
    () => database(accepting("recordSettlement", "liquidity-tank-settlement-before-completion")),
    /settlement while only the lock is durable: store answered recorded/],
  [CASE.settlementExact, "accepts a settlement other than the completion's",
    () => database(accepting("recordSettlement", "liquidity-tank-settlement-evidence-conflict")),
    /settlement other than the completion's: store answered recorded/],
  [CASE.settlementBlocksExpiry, "expires a settled phase",
    () => database(accepting("recordRecoveryExpired", "liquidity-tank-recovery-lost-to-settlement")),
    /expiry after the settlement: store answered recorded/],
  [CASE.completionBlocksExpiry, "expires past a durable timely completion",
    () => database(accepting("recordRecoveryExpired", "liquidity-tank-recovery-lost-to-completion")),
    /expiry from a late completion: store answered recorded/],
  [CASE.expiryCas, "expires against another expected observation",
    () => database(accepting("recordRecoveryExpired", "liquidity-tank-recovery-checkpoint-cas-failed")),
    /expiry against another expected observation: store answered recorded/],
  [CASE.expiryCas, "ignores lease expiry on recovery expiry", () => database((inner) => {
    const tracked = trackingLeases(inner);
    return {
      claim: tracked.claim,
      recordRecoveryExpired: (input) => {
        const lease = tracked.lease(input.settlementKey);
        return inner.recordRecoveryExpired(lease && lease.generation === input.generation &&
          input.now >= lease.expiresAt ? { ...input, now: lease.expiresAt - 1 } : input);
      },
    };
  }), /expiry after the lease expired: store answered recorded/],
  [CASE.expiryCas, "expires once the host clock reaches the deadline", () => database(expiringAtTheDeadline((input) => {
    const evidence = evidenceOf(input);
    return input.now === (evidence.checkpoint?.recoveryDeadline ?? evidence.recoveryDeadline)
      ? { ...input, now: input.now + 1 }
      : undefined;
  })), /expiry with the host clock at the deadline: store answered recorded/],
  [CASE.expiryBlocks, "records an observation after expiry",
    () => database(accepting("recordObservation", "liquidity-tank-observation-after-terminal")),
    /completion after expiry: store answered recorded/],
  [CASE.failureRetention, "lets a second failure replace the first", () => database((inner) => ({
    recordRecoveryFailure: async (input) => {
      const result = await inner.recordRecoveryFailure(input);
      return result.status === "conflict" && result.reason === "liquidity-tank-recovery-failure-conflict"
        ? { status: "existing", recoveryFailure: input.recoveryFailure }
        : result;
    },
  })), /a second failure replaced the first/],
  [CASE.failureCleared, "expires past a completion that cleared a retained failure",
    () => database(accepting("recordRecoveryExpired", "liquidity-tank-recovery-lost-to-completion")),
    /expiry from the cleared failure: store answered recorded/],
  [CASE.failureLockCompletion, "refuses a completion once a failure that carries its lock is durable",
    () => database(blocksCompletionAfterLockBearingFailure),
    /timely completion of that failure's lock: store answered conflict; expected recorded or existing/],
  [CASE.failureLockCompletion, "expires past a completion that replaced a failure carrying its lock",
    () => database(accepting("recordRecoveryExpired", "liquidity-tank-recovery-lost-to-completion")),
    /expiry from the replaced failure: store answered recorded/],
  [CASE.failureEvidence, "expires from a failure that is not the durable observation",
    () => database(accepting("recordRecoveryExpired", "liquidity-tank-recovery-checkpoint-cas-failed")),
    /expiry from a failure that is not the durable one: store answered recorded/],
  [CASE.failureEvidence, "expires from a bare failure retained beside a checkpoint", () => database((inner) => {
    const failures = new Set<string>();
    return {
      recordRecoveryFailure: async (input) => {
        const result = await inner.recordRecoveryFailure(input);
        if (result.status === "recorded") failures.add(input.settlementKey);
        return result;
      },
      recordRecoveryExpired: async (input) => {
        const result = await inner.recordRecoveryExpired(input);
        return input.observation.status === "failed" && failures.has(input.settlementKey) &&
          result.status === "conflict" ? { status: "recorded" } : result;
      },
    };
  }), /expiry from a bare failure retained beside a checkpoint: store answered recorded/],
  [CASE.completionLock, "takes a late completion of any lock as expiry evidence",
    () => database(skippingCompletionLockCas(() => true)),
    /late completion of another lock against a checkpoint: store answered recorded/],
  [CASE.completionLock, "checks a late completion's lock hash but not its deadline",
    () => database(skippingCompletionLockCas((prior, completion) => prior.lockTxHash === completion.lockTxHash)),
    /late completion of the lock with another deadline against a checkpoint: store answered recorded/],
  [CASE.completionLock, "checks a late completion against a checkpoint but not against a durable failure",
    () => database(skippingCompletionLockCas((prior) => prior.status === "failed")),
    /late completion of another lock against a durable failure that carries its lock: store answered recorded/],
  [CASE.completionLock, "refuses every late completion as expiry evidence (sweep N2)", () => database((inner) => ({
    recordRecoveryExpired: async (input) => evidenceOf(input).status === "completed"
      ? { status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" }
      : inner.recordRecoveryExpired(input),
  })), /late completion of the lock against a checkpoint: store answered conflict/],
  [CASE.completionLock, "takes a completion finalized at the deadline as expiry evidence",
    () => database(expiringAtTheDeadline((input) => {
      const { status, finalityObservedAt, recoveryDeadline } = evidenceOf(input);
      return status === "completed" && finalityObservedAt !== undefined && finalityObservedAt === recoveryDeadline
        ? { ...input, observation: { ...input.observation, finalityObservedAt: finalityObservedAt + 1 } as never }
        : undefined;
    })), /completion of the lock finalized at the deadline against a checkpoint: store answered recorded/],
  [CASE.contradictionCas, "records any contradiction expiry without its CAS",
    () => database(acceptingAnyContradictionExpiry),
    /contradiction stamped at the deadline: store answered recorded/],
  [CASE.contradictionCas, "checks only the deadline on a contradiction", () => database((inner) => ({
    recordRecoveryExpired: async (input) => {
      const result = await inner.recordRecoveryExpired(input);
      const evidence = input.observation as {
        status: string; checkpoint?: { recoveryDeadline: number }; contradiction?: { observedAt: number };
      };
      const deadline = evidence.checkpoint?.recoveryDeadline ?? Infinity;
      return evidence.status === "contradicted-after-lock" && result.status === "conflict" &&
        result.reason === "liquidity-tank-recovery-expiry-not-due" &&
        input.now > deadline && (evidence.contradiction?.observedAt ?? 0) > deadline
        ? { status: "recorded" }
        : result;
    },
  })), /pending without a lock after the deadline: store answered recorded/],
  [CASE.contradictionCas, "takes any pending of another lock as a contradiction", () => database(acceptingWhere(
    "recordRecoveryExpired", (input) => {
      const { checkpoint, contradiction } = evidenceOf(input) as ReturnType<typeof evidenceOf> & {
        checkpoint?: { lockTxHash?: string }; contradiction?: { lockTxHash?: string };
      };
      return contradiction?.status === "pending" && contradiction.lockTxHash !== undefined &&
        contradiction.lockTxHash !== checkpoint?.lockTxHash;
    },
  )), /pending of another lock inside its own window: store answered recorded/],
  [CASE.contradictionCas, "expires against a contradiction of another checkpoint", () => database(acceptingWhere(
    "recordRecoveryExpired", (input) => {
      const { status, checkpoint } = evidenceOf(input) as ReturnType<typeof evidenceOf> & {
        checkpoint?: { observedAt?: number };
      };
      return status === "contradicted-after-lock" &&
        checkpoint?.observedAt !== (input.expectedObservation as unknown as Timed).observedAt;
    },
  )), /contradiction of another checkpoint: store answered recorded/],
  [CASE.contradictionCas, "takes a contradiction stamped at the deadline as expiry evidence",
    () => database(expiringAtTheDeadline((input) => {
      const { checkpoint, contradiction } = evidenceOf(input);
      return contradiction !== undefined && contradiction.observedAt === checkpoint?.recoveryDeadline
        ? { ...input, observation: { ...input.observation,
            contradiction: { ...contradiction, observedAt: contradiction.observedAt + 1 } } as never }
        : undefined;
    })), /contradiction stamped at the deadline: store answered recorded/],
  [CASE.contradictionCas, "takes another lock's pending at its own deadline as past it",
    () => database(expiringAtTheDeadline((input) => {
      const { contradiction } = evidenceOf(input);
      return contradiction?.status === "pending" && contradiction.observedAt === contradiction.recoveryDeadline
        ? { ...input, observation: { ...input.observation,
            contradiction: { ...contradiction, recoveryDeadline: contradiction.observedAt - 1 } } as never }
        : undefined;
    })), /pending of another lock at its own deadline: store answered recorded/],
  [CASE.contradictionCas, "accepts a contradiction beside retained failure evidence", () => database((inner) => {
    const failures = new Set<string>();
    return {
      recordRecoveryFailure: async (input) => {
        const result = await inner.recordRecoveryFailure(input);
        if (result.status === "recorded") failures.add(input.settlementKey);
        return result;
      },
      recordRecoveryExpired: async (input) => {
        const result = await inner.recordRecoveryExpired(input);
        return (input.observation as { status: string }).status === "contradicted-after-lock" &&
          failures.has(input.settlementKey) && result.status === "conflict" ? { status: "recorded" } : result;
      },
    };
  }), /contradiction beside retained failure evidence: store answered recorded/],
  [CASE.restart, "starts empty after a restart", forgetful,
    /the reopened store lost the submission or the checkpoint/],
  [CASE.restart, "keeps its bridge-ID index in process memory (code review B2)",
    () => rowsWithBridgeIndex("process"),
    /after a restart, another phase reusing a settled bridge operation: store answered recorded/],
  [CASE.settles, "starts empty after a restart", forgetful,
    /step 3 \(worker-3\): 2 different signed submissions were broadcast, locking 2500000 base units for an intent of 1250000/],
  [CASE.settles, "hands back retained observations the bridge never issued", () => database((inner) => ({
    claim: async (input) => {
      const claimed = await inner.claim(input);
      return (claimed.status === "acquired" || claimed.status === "waiting") && claimed.observation
        ? { ...claimed, observation: { ...claimed.observation, authenticationHash: "f".repeat(64) } }
        : claimed;
    },
  })), /locked bridge read returned indeterminate/],
  [CASE.expires, "starts empty after a restart", forgetful,
    /step 2 \(worker-2\): 2 different signed submissions were broadcast/],
  [CASE.expires, "reports an expired phase settled", () => database((inner) => ({
    claim: async (input) => {
      const claimed = await inner.claim(input);
      if (claimed.status !== "recovery-expired") return claimed;
      return {
        status: "settled",
        intent: claimed.intent,
        settlement: {
          txRef: {
            kind: "liquidity-tank",
            bridgeId: claimed.submission.bridgeId,
            sourceChainId: claimed.intent.sourceChainId,
            destChainId: claimed.intent.destinationChainId,
            lockTxHash: "forged-lock",
            releaseTxHash: "forged-release",
            recoveryDeadline: 1_700_086_400_000,
          },
          paymentAmount: { amount: claimed.intent.amount, currency: "USDC" },
          settlementFinality: { model: "liquidity-tank", finalityObservedAt: 1_700_086_399_999 },
          authenticationHash: "f".repeat(64),
        },
      };
    },
  })), /step 4 \(worker-4\): the phase was reported both settled and expired/],
  [CASE.claimRace, "grants two overlapping claims", () => database(raceyClaims),
    /2 of two concurrent claims on a fresh phase acquired the phase/],
  [CASE.submissionRace, "records two overlapping submissions", () => database((inner) => {
    let inFlight = 0;
    return {
      recordSubmission: async (input) => {
        inFlight += 1;
        await yieldTurn();
        const overlapped = inFlight > 1;
        inFlight -= 1;
        return overlapped ? { status: "recorded" } : inner.recordSubmission(input);
      },
    };
  }), /2 of two concurrent submissions for one phase were recorded/],
  [CASE.bridgeRace, "reads and writes its bridge-ID index around the row write (code review B2-control)",
    () => rowsWithBridgeIndex("racey"),
    /2 of two concurrent submissions on one bridge operation were recorded/],
  [CASE.completionExpiryRace, "records an overlapping completion and expiry", () => database((inner) => {
    let completions = 0;
    let expiries = 0;
    return {
      recordObservation: async (input) => {
        if (input.observation.status !== "completed") return inner.recordObservation(input);
        completions += 1;
        await yieldTurn();
        const raced = expiries > 0;
        completions -= 1;
        return raced ? { status: "recorded" } : inner.recordObservation(input);
      },
      recordRecoveryExpired: async (input) => {
        expiries += 1;
        await yieldTurn();
        const raced = completions > 0;
        expiries -= 1;
        return raced ? { status: "recorded" } : inner.recordRecoveryExpired(input);
      },
    };
  }), /2 of a concurrent timely completion and recovery expiry were recorded/],
  [CASE.completionExpiryRace, "refuses both an overlapping completion and expiry", () => database((inner) => {
    let completions = 0;
    let expiries = 0;
    let overlapped = false;
    return {
      recordObservation: async (input) => {
        if (input.observation.status !== "completed") return inner.recordObservation(input);
        completions += 1;
        await yieldTurn();
        overlapped ||= expiries > 0;
        completions -= 1;
        return overlapped ? { status: "conflict", reason: "serialization-failure" } : inner.recordObservation(input);
      },
      recordRecoveryExpired: async (input) => {
        expiries += 1;
        await yieldTurn();
        overlapped ||= completions > 0;
        expiries -= 1;
        return overlapped ? { status: "conflict", reason: "serialization-failure" } : inner.recordRecoveryExpired(input);
      },
    };
  }), /0 of a concurrent timely completion and recovery expiry were recorded/],
  [CASE.completionExpiryRace, "lets an expiry it checked before a completion arrived win anyway", () => database((inner) => {
    let completions = 0;
    return {
      recordObservation: (input) => {
        if (input.observation.status === "completed") completions += 1;
        return inner.recordObservation(input);
      },
      recordRecoveryExpired: async (input) => {
        const seen = completions;
        await yieldTurn();
        const result = await inner.recordRecoveryExpired(input);
        // Decided on the row it read before the completion arrived, so only the reversed order loses.
        return result.status === "conflict" && completions > seen ? { status: "recorded" } : result;
      },
    };
  }), /2 of a concurrent timely completion and recovery expiry were recorded \(reversed order\)/],
  [CASE.settlementExpiryRace, "records an overlapping settlement and expiry (Daybreak's racey store)",
    () => database((inner) => {
      let settlementsInFlight = 0;
      let expiriesInFlight = 0;
      let terminalRace = false;
      return {
        async recordSettlement(input) {
          settlementsInFlight += 1;
          await yieldTurn();
          terminalRace ||= expiriesInFlight > 0;
          settlementsInFlight -= 1;
          return terminalRace ? { status: "recorded" } : inner.recordSettlement(input);
        },
        async recordRecoveryExpired(input) {
          expiriesInFlight += 1;
          await yieldTurn();
          terminalRace ||= settlementsInFlight > 0;
          expiriesInFlight -= 1;
          return terminalRace ? { status: "recorded" } : inner.recordRecoveryExpired(input);
        },
      };
    }), /both the settlement and the expiry were recorded/],
  [CASE.takeoverRace, "checks the lease, then writes a turn later without checking again", () => database((inner) => {
    const tracked = trackingLeases(inner);
    const checkThenWrite = <T extends WriteInput, R>(write: (input: T) => Promise<R>) => async (input: T) => {
      if (!await inner.isCurrent(input)) return { status: "stale", reason: "stale-lease" } as R;
      await yieldTurn();
      // Writes on the lease it checked, whoever holds the phase by now.
      const lease = tracked.lease(input.settlementKey);
      return write(lease ? { ...input, owner: lease.owner, generation: lease.generation } : input);
    };
    return {
      claim: tracked.claim,
      recordSubmission: checkThenWrite((input) => inner.recordSubmission(input)),
      recordObservation: checkThenWrite((input) => inner.recordObservation(input)),
      recordRecoveryFailure: checkThenWrite((input) => inner.recordRecoveryFailure(input)),
      recordRecoveryExpired: checkThenWrite((input) => inner.recordRecoveryExpired(input)),
      recordSettlement: checkThenWrite((input) => inner.recordSettlement(input)),
    };
  }), /recordSubmission by the old owner landed after another owner took its lease over/],
  [CASE.coreRace, "grants two overlapping claims", () => database(raceyClaims),
    /2 of two workers starting one phase at once went past the claim/],
  [CASE.coreRace, "treats a phase as free until its submission is written", () => database((inner) => ({
    claim: async (input) => {
      await yieldTurn();
      const claimed = await inner.claim(input);
      // Only a worker held before its submission write is exposed: the case's barrier holds it there.
      return claimed.status === "waiting" && claimed.submission === undefined
        ? inner.claim({ ...input, now: claimed.lease.expiresAt })
        : claimed;
    },
  })), /2 of two workers starting one phase at once went past the claim/],
  [CASE.coreRace, "grants a reopened handle a phase it read as free a turn earlier (Daybreak r11 P3-1)",
    () => handlesClaimingFromStaleReads("reopened"),
    /2 of two workers starting one phase at once went past the claim \(reversed order\)/],
  [CASE.coreRace, "grants its first handle a phase it read as free a turn earlier",
    () => handlesClaimingFromStaleReads("created"),
    /2 of two workers starting one phase at once went past the claim \(given order\)/],
];

describe("runLiquidityTankStoreConformance", () => {
  test("the reference store passes every case behind handles that stand in for a database", async () => {
    const results = await runLiquidityTankStoreConformance(database());
    expect(results.filter((result) => !result.passed)).toEqual([]);
    expect(results.map((result) => result.name)).toEqual(Object.values(CASE));
  });

  test("the reference store fails the restart and race cases when a restart really drops its memory", async () => {
    const results = await runLiquidityTankStoreConformance(forgetful());
    expect(failedNames(results)).toEqual([...RESTART_CASES, ...RACE_CASES]);
    // After the restart the core signs and broadcasts a second bridge operation.
    expect(failureOf(results, CASE.settles)).toMatch(/2 different signed submissions were broadcast/);
  });

  test("refuses to run when reopenStore returns the handle it was given (code review B3)", async () => {
    const results = await runLiquidityTankStoreConformance({
      createStore: () => createInMemoryLiquidityTankStore(VOLATILE),
      reopenStore: (store) => store,
    });
    expect(results).toHaveLength(Object.values(CASE).length);
    expect(results.every((result) => !result.passed && result.failure === IDENTITY_REOPEN)).toBe(true);
  });

  test("a reopenStore that returns the same handle later fails the cases that reach it", async () => {
    let calls = 0;
    const honest = database();
    const results = await runLiquidityTankStoreConformance({
      createStore: honest.createStore,
      // The first call, the run's own check, gets a new handle.
      reopenStore: (store) => (calls++ === 0 ? honest.reopenStore(store) : store),
    });
    expect(failedNames(results)).toEqual([...RESTART_CASES, ...RACE_CASES]);
    expect(results.filter((result) => !result.passed).every((result) => result.failure === IDENTITY_REOPEN))
      .toBe(true);
  });

  test("a store that accepts a submission replacement fails its cases", async () => {
    const results = await runLiquidityTankStoreConformance(database((inner) => ({
      recordSubmission: async (input) => {
        const result = await inner.recordSubmission(input);
        return result.status === "conflict" ? { status: "existing" } : result;
      },
    })));
    expect(failedNames(results)).toEqual([
      CASE.firstSubmission, CASE.bridge, CASE.restart, CASE.submissionRace, CASE.bridgeRace,
    ]);
  });

  test("a store that throws reports a failed case instead of rejecting the run", async () => {
    const results = await runLiquidityTankStoreConformance({
      createStore: () => {
        throw new Error("database unavailable");
      },
      reopenStore: (store) => store,
    });
    expect(results.every((result) => !result.passed && result.failure === "database unavailable"))
      .toBe(true);
  });

  test("every case has a broken store that fails it on its own check", () => {
    expect(new Set(BROKEN.map(([name]) => name))).toEqual(new Set(Object.values(CASE)));
  });

  test.each(BROKEN)("%s: refused for a store that %s", async (name, _store, options, failure) => {
    const results = await runLiquidityTankStoreConformance(options());
    expect(failureOf(results, name)).toMatch(failure);
  });

  test("is exported from the rails and root barrels", () => {
    expect(rails.runLiquidityTankStoreConformance).toBe(runLiquidityTankStoreConformance);
    expect(root.runLiquidityTankStoreConformance).toBe(runLiquidityTankStoreConformance);
  });
});
