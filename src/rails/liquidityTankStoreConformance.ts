import { canonicalize, sha256Hex } from "../canonical/index.js";
import {
  advanceLiquidityTankSettlement,
  createLiquidityTankIntent,
  type LiquidityTankAdapter,
  type LiquidityTankAuthority,
  type LiquidityTankIntent,
  type LiquidityTankObservation,
  type LiquidityTankPreparedSubmission,
  type LiquidityTankProgress,
  type LiquidityTankRecoveryEvidence,
  type LiquidityTankSettlement,
  type LiquidityTankStore,
  type LiquidityTankStoreClaim,
  type LiquidityTankStoreWrite,
  type LiquidityTankVerifier,
} from "./liquidityTank.js";

/**
 * How the conformance run reaches the store under test. Production stores
 * must pass every case before the liquidity-tank core relies on them.
 */
export interface LiquidityTankStoreConformanceOptions {
  /** A store holding no liquidity-tank rows. Called once per case. */
  createStore(): LiquidityTankStore | Promise<LiquidityTankStore>;
  /**
   * A new handle on the same durable state as `store`, opened the way a
   * restarted process or a second worker would open it (for example a new
   * connection to the same database). It must not share in-process state with
   * `store`. The restart cases use it in place of `store`; the race cases keep
   * both handles and write through them at once. A run whose `reopenStore`
   * returns the handle it was given fails every case.
   */
  reopenStore(store: LiquidityTankStore): LiquidityTankStore | Promise<LiquidityTankStore>;
}

export interface LiquidityTankStoreConformanceResult {
  readonly name: string;
  readonly passed: boolean;
  /** Why the case failed; absent when it passed. */
  readonly failure?: string;
}

type ObservationValue = Exclude<LiquidityTankObservation, { status: "indeterminate" }>;
type FailedAfterLock = Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>;
type AcquiredClaim = Extract<LiquidityTankStoreClaim, { status: "acquired" }>;
type WriteAuthority = {
  settlementKey: string;
  bindingHash: string;
  owner: string;
  generation: number;
  now: number;
};

const T0 = 1_700_000_000_000;
const DEADLINE = T0 + 86_400_000;
// A release final at the deadline is timely: the first millisecond after it is
// the earliest a finality, a bridge snapshot or a host clock shows it missed.
const DUE = DEADLINE + 1;
const LEASE_MS = 1_000;
// The store is not the authenticator, so a well-formed hash is enough here.
const AUTHENTICATION_HASH = "a".repeat(64);
const IDENTITY_REOPEN =
  "reopenStore returned the handle it was given; it must open a new handle on the same durable state";

class ConformanceFailure extends Error {}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ConformanceFailure(message);
}

function succeeded(write: LiquidityTankStoreWrite | { status: string }): boolean {
  return write.status === "recorded" || write.status === "existing";
}

/** How many of the writes the store reported as successful. */
function successes(...writes: readonly { status: string }[]): number {
  return writes.filter(succeeded).length;
}

/** Canonical equality; a missing or non-JSON value is never the expected one. */
function same(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function bridgeIdFor(tag: string, n: number): string {
  return `cfm${tag}-prep-${String(n).padStart(2, "0")}`;
}

function authorityFor(tag: string, phaseIndex: number, amount = "1.25"): LiquidityTankAuthority {
  return {
    jobId: `01JZ${"0".repeat(17)}${tag}`,
    phaseIndex,
    railId: "demos-tank-sepolia-amoy-usdc",
    railDescriptorHash: "b".repeat(64),
    agreementHash: "c".repeat(64),
    sr5BindingHash: "d".repeat(64),
    assetKind: "stablecoin-cross-chain",
    networkKind: "cross-chain",
    mechanism: "liquidity-tank",
    sourceChainId: 11_155_111,
    destinationChainId: 80_002,
    sourceChainType: "EVM",
    destinationChainType: "EVM",
    sourceAsset: "USDC",
    destinationAsset: "USDC",
    sourceTokenDecimals: 6,
    destinationTokenDecimals: 6,
    amount,
    currency: "USDC",
    originAddress: "conformance-origin",
    destinationAddress: "conformance-destination",
    sourceLiquidityTankId: "conformance-tank-source",
    destinationLiquidityTankId: "conformance-tank-destination",
    supportedScope: "dacs-v0.1-eth-sepolia-polygon-amoy-usdc",
  };
}

/** The signed bytes of the model bridge: what a decoder would read back. */
interface ModelSignedTransfer {
  bridgeId: string;
  nonce: number;
  amountBaseUnits: string;
  originAddress: string;
  destinationAddress: string;
  asset: string;
  sourceLiquidityTankId: string;
  destinationLiquidityTankId: string;
}

function signedSubmission(
  intent: Readonly<LiquidityTankIntent>,
  bridgeId: string,
  nonce: number,
  preparedAt = T0,
): Omit<LiquidityTankPreparedSubmission, "submissionHash"> {
  const transfer: ModelSignedTransfer = {
    bridgeId,
    nonce,
    amountBaseUnits: intent.sourceAmountBaseUnits,
    originAddress: intent.originAddress,
    destinationAddress: intent.destinationAddress,
    asset: intent.sourceAsset,
    sourceLiquidityTankId: intent.sourceLiquidityTankId,
    destinationLiquidityTankId: intent.destinationLiquidityTankId,
  };
  const bytes = Buffer.from(canonicalize(transfer), "utf8");
  return {
    submissionVersion: "1",
    authorityHash: intent.bindingHash,
    operationHash: intent.operationHash,
    bridgeId,
    substrateTxHash: sha256Hex(bytes),
    signedSubmissionBase64: bytes.toString("base64"),
    preparedAt,
  };
}

/** The retained form the core stores: the submission and the hash of its canonical JSON. */
function retained(
  unsigned: Omit<LiquidityTankPreparedSubmission, "submissionHash">,
): LiquidityTankPreparedSubmission {
  return { ...unsigned, submissionHash: sha256Hex(canonicalize(unsigned)) };
}

function decodeTransfer(submission: Readonly<LiquidityTankPreparedSubmission>): ModelSignedTransfer | null {
  try {
    const bytes = Buffer.from(submission.signedSubmissionBase64, "base64");
    if (sha256Hex(bytes) !== submission.substrateTxHash) return null;
    return JSON.parse(bytes.toString("utf8")) as ModelSignedTransfer;
  } catch {
    return null;
  }
}

class Fixture {
  readonly intent: Readonly<LiquidityTankIntent>;
  readonly bridgeId: string;
  readonly otherBridgeId: string;
  readonly submission: LiquidityTankPreparedSubmission;

  constructor(readonly tag: string, readonly phaseIndex = 0) {
    this.intent = createLiquidityTankIntent(authorityFor(tag, phaseIndex));
    this.bridgeId = bridgeIdFor(tag, 1 + phaseIndex * 10);
    this.otherBridgeId = bridgeIdFor(tag, 2 + phaseIndex * 10);
    this.submission = retained(signedSubmission(this.intent, this.bridgeId, 1));
  }

  private base(bridgeId: string, observedAt: number) {
    return {
      bridgeId,
      operationHash: this.intent.operationHash,
      observedAt,
      authenticationHash: AUTHENTICATION_HASH,
    };
  }

  empty(observedAt = T0, bridgeId = this.bridgeId): ObservationValue {
    return { status: "empty", history: ["empty"], ...this.base(bridgeId, observedAt) };
  }

  lockedPending(observedAt = T0, bridgeId = this.bridgeId, lockTxHash = `lock-${bridgeId}`) {
    return {
      status: "pending" as const,
      history: ["empty", "pending"] as const,
      ...this.base(bridgeId, observedAt),
      lockTxHash,
      recoveryDeadline: DEADLINE,
    };
  }

  completed(finalityObservedAt: number, bridgeId = this.bridgeId, releaseTxHash = `release-${bridgeId}`) {
    return {
      status: "completed" as const,
      history: ["empty", "pending", "completed"] as const,
      ...this.base(bridgeId, finalityObservedAt),
      lockTxHash: `lock-${bridgeId}`,
      releaseTxHash,
      recoveryDeadline: DEADLINE,
      finalityObservedAt,
    };
  }

  failedAfterLock(observedAt: number, bridgeId = this.bridgeId) {
    return {
      status: "failed" as const,
      history: ["empty", "pending", "failed"] as const,
      ...this.base(bridgeId, observedAt),
      reason: "release rejected by the destination tank",
      lockTxHash: `lock-${bridgeId}`,
      recoveryDeadline: DEADLINE,
    };
  }

  /** The settlement the core writes for a timely completion. */
  settlement(observation: ReturnType<Fixture["completed"]>): LiquidityTankSettlement {
    return {
      txRef: {
        kind: "liquidity-tank",
        bridgeId: observation.bridgeId,
        sourceChainId: this.intent.sourceChainId,
        destChainId: this.intent.destinationChainId,
        lockTxHash: observation.lockTxHash,
        releaseTxHash: observation.releaseTxHash,
        recoveryDeadline: observation.recoveryDeadline,
      },
      paymentAmount: { amount: this.intent.amount, currency: this.intent.currency },
      settlementFinality: {
        model: "liquidity-tank",
        finalityObservedAt: observation.finalityObservedAt,
      },
      authenticationHash: observation.authenticationHash,
    };
  }
}

async function claim(
  store: LiquidityTankStore,
  intent: Readonly<LiquidityTankIntent>,
  owner: string,
  now: number,
  leaseDurationMs = LEASE_MS,
): Promise<LiquidityTankStoreClaim> {
  return store.claim({ intent, owner, now, leaseDurationMs });
}

/** Claims and expects a fresh lease; returns the write authority at `now`. */
async function acquire(
  store: LiquidityTankStore,
  intent: Readonly<LiquidityTankIntent>,
  owner: string,
  now: number,
  leaseDurationMs = LEASE_MS,
): Promise<WriteAuthority> {
  const claimed = await claim(store, intent, owner, now, leaseDurationMs);
  check(claimed.status === "acquired", `claim by ${owner} at ${now} returned ${claimed.status}, not acquired`);
  return {
    settlementKey: intent.settlementKey,
    bindingHash: intent.bindingHash,
    owner,
    generation: claimed.lease.generation,
    now,
  };
}

async function record(
  label: string,
  write: Promise<LiquidityTankStoreWrite>,
  shouldSucceed: boolean,
): Promise<void> {
  const result = await write;
  check(
    succeeded(result) === shouldSucceed,
    `${label}: store answered ${result.status}; expected ${shouldSucceed ? "recorded or existing" : "a refusal"}`,
  );
}

/** A fixture lock: the submission and the locked pending checkpoint, written at `now`. */
async function lockWith(
  store: LiquidityTankStore,
  fixture: Fixture,
  owner: string,
  now: number,
  leaseDurationMs = LEASE_MS,
  checkpointObservedAt = now,
) {
  const write = await acquire(store, fixture.intent, owner, now, leaseDurationMs);
  await record("first submission", store.recordSubmission({ ...write, submission: fixture.submission }), true);
  const checkpoint = fixture.lockedPending(checkpointObservedAt);
  await record("locked pending checkpoint", store.recordObservation({ ...write, observation: checkpoint }), true);
  return { write, checkpoint };
}

/** `reopenStore`, refusing the handle it was given: a restart or race through it tests nothing. */
type Reopen = (store: LiquidityTankStore) => Promise<LiquidityTankStore>;

function reopener(options: LiquidityTankStoreConformanceOptions): Reopen {
  return async (store) => {
    const reopened = await options.reopenStore(store);
    check(reopened !== store, IDENTITY_REOPEN);
    return reopened;
  };
}

/** Both start orders, so a store that loses only one interleaving is still raced. */
const ORDERS = ["given order", "reversed order"] as const;
type Order = (typeof ORDERS)[number];

/**
 * Starts both operations before either settles, in `order`, and returns their
 * results in argument order. Over an async store the two can interleave
 * between a read and the write that depends on it.
 */
async function race<A, B>(order: Order, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  if (order === "given order") return Promise.all([first(), second()]);
  const [secondResult, firstResult] = await Promise.all([second(), first()]);
  return [firstResult, secondResult];
}

/** One ordinary write by an owner whose lease is still current at its `now`, raced by a takeover. */
interface TakeoverRace {
  write(handle: LiquidityTankStore): Promise<{ status: string }>;
  /** When another owner claims the lease the write's owner holds. */
  takeoverAt: number;
  /** Whether a claim result shows the write. */
  shows(claimed: LiquidityTankStoreClaim): boolean;
}

const TAKEOVER_RACES: readonly (readonly [string, (store: LiquidityTankStore, fixture: Fixture) => Promise<TakeoverRace>])[] = [
  ["recordSubmission", async (store, fixture) => {
    const write = await acquire(store, fixture.intent, "owner-a", T0);
    return {
      write: (handle) => handle.recordSubmission({ ...write, now: T0 + LEASE_MS - 1, submission: fixture.submission }),
      takeoverAt: T0 + LEASE_MS,
      shows: (claimed) => claimed.status === "acquired" && same(claimed.submission, fixture.submission),
    };
  }],
  ["recordObservation", async (store, fixture) => {
    const write = await acquire(store, fixture.intent, "owner-a", T0);
    await record("submission", store.recordSubmission({ ...write, submission: fixture.submission }), true);
    const checkpoint = fixture.lockedPending(T0 + 1);
    return {
      write: (handle) => handle.recordObservation({ ...write, now: T0 + LEASE_MS - 1, observation: checkpoint }),
      takeoverAt: T0 + LEASE_MS,
      shows: (claimed) => claimed.status === "acquired" && same(claimed.observation, checkpoint),
    };
  }],
  ["recordRecoveryFailure", async (store, fixture) => {
    const { write, checkpoint } = await lockWith(store, fixture, "owner-a", T0);
    const evidence: FailedAfterLock = {
      status: "failed-after-lock",
      checkpoint,
      failure: fixture.failedAfterLock(T0 + 1),
    };
    return {
      write: (handle) => handle.recordRecoveryFailure({ ...write, now: T0 + LEASE_MS - 1, recoveryFailure: evidence }),
      takeoverAt: T0 + LEASE_MS,
      shows: (claimed) => claimed.status === "acquired" && same(claimed.recoveryFailure, evidence),
    };
  }],
  ["recordRecoveryExpired", async (store, fixture) => {
    // The lease runs out one millisecond after expiry falls due.
    const { write, checkpoint } = await lockWith(store, fixture, "owner-a", DUE + 1 - LEASE_MS, LEASE_MS, DUE);
    return {
      write: (handle) => handle.recordRecoveryExpired({
        ...write, now: DUE, expectedObservation: checkpoint, observation: checkpoint,
      }),
      takeoverAt: DUE + 1,
      shows: (claimed) => claimed.status === "recovery-expired" && same(claimed.observation, checkpoint),
    };
  }],
  ["recordSettlement", async (store, fixture) => {
    const { write } = await lockWith(store, fixture, "owner-a", T0);
    const completion = fixture.completed(T0 + 1);
    await record("timely completion", store.recordObservation({ ...write, observation: completion }), true);
    const settlement = fixture.settlement(completion);
    return {
      write: (handle) => handle.recordSettlement({ ...write, now: T0 + LEASE_MS - 1, settlement }),
      takeoverAt: T0 + LEASE_MS,
      shows: (claimed) => claimed.status === "settled" && same(claimed.settlement, settlement),
    };
  }],
];

type ConformanceCase = (store: LiquidityTankStore, tag: string, reopen: Reopen) => Promise<void>;

const CASES: readonly (readonly [string, ConformanceCase])[] = [
  ["claim acquires an exact lease and echoes the intent", async (store, tag) => {
    const fixture = new Fixture(tag);
    const claimed = await claim(store, fixture.intent, "owner-a", T0);
    check(claimed.status === "acquired", `claim returned ${claimed.status}`);
    check(same(claimed.intent, fixture.intent), "claim did not echo the exact intent");
    check(claimed.lease.owner === "owner-a", "lease owner is not the caller");
    check(Number.isSafeInteger(claimed.lease.generation) && claimed.lease.generation > 0,
      "lease generation is not a positive safe integer");
    check(claimed.lease.expiresAt === T0 + LEASE_MS,
      "lease expiresAt is not exactly now + leaseDurationMs from the claim input");
    check(claimed.submission === undefined && claimed.observation === undefined &&
      claimed.recoveryFailure === undefined, "a new phase returned retained state");
  }],

  ["claim waits on a live lease held by another owner", async (store, tag) => {
    const fixture = new Fixture(tag);
    await acquire(store, fixture.intent, "owner-a", T0);
    const claimed = await claim(store, fixture.intent, "owner-b", T0 + LEASE_MS - 1);
    check(claimed.status === "waiting", `claim under a live lease returned ${claimed.status}`);
    check(claimed.lease.owner === "owner-a" && claimed.lease.expiresAt === T0 + LEASE_MS,
      "waiting claim does not report the live lease");
  }],

  ["claim refuses a different binding for the same phase", async (store, tag) => {
    const fixture = new Fixture(tag);
    await acquire(store, fixture.intent, "owner-a", T0);
    const other = createLiquidityTankIntent(authorityFor(tag, 0, "2"));
    check(other.settlementKey === fixture.intent.settlementKey, "fixture error: keys differ");
    const claimed = await claim(store, other, "owner-b", T0 + LEASE_MS * 10);
    check(claimed.status === "conflict", `claim with another binding returned ${claimed.status}`);
  }],

  ["lease takeover raises the generation and fences the old owner", async (store, tag) => {
    const fixture = new Fixture(tag);
    const first = await acquire(store, fixture.intent, "owner-a", T0);
    await record("submission", store.recordSubmission({ ...first, submission: fixture.submission }), true);
    const takeover = await claim(store, fixture.intent, "owner-b", T0 + LEASE_MS);
    check(takeover.status === "acquired", `claim after lease expiry returned ${takeover.status}`);
    check(takeover.lease.generation > first.generation, "takeover did not raise the generation");
    check(same(takeover.submission, fixture.submission), "takeover lost the retained submission");
    const now = T0 + LEASE_MS;
    check(!await store.isCurrent({ ...first, now }), "old owner is still current after takeover");
    check(await store.isCurrent({ ...first, owner: "owner-b", generation: takeover.lease.generation, now }),
      "new owner is not current");
    check(!await store.isCurrent({
      ...first, owner: "owner-b", generation: takeover.lease.generation, now: takeover.lease.expiresAt,
    }), "a lease is current at its expiresAt");
    await record("write by the fenced owner",
      store.recordObservation({ ...first, now, observation: fixture.empty() }), false);
    const later = await claim(store, fixture.intent, "owner-c", takeover.lease.expiresAt);
    check(later.status === "acquired" && later.observation === undefined,
      "the fenced owner's observation was retained");

    // Hosts often reuse an owner ID across restarts: the generation, not the
    // owner, fences the earlier lease.
    const again = new Fixture(tag, 1);
    const stale = await acquire(store, again.intent, "owner-a", T0);
    const renewed = await acquire(store, again.intent, "owner-a", T0 + LEASE_MS);
    check(renewed.generation > stale.generation, "a re-claim by the same owner did not raise the generation");
    check(!await store.isCurrent({ ...stale, now: T0 + LEASE_MS }),
      "the same owner's stale generation is still current after its re-claim");
    await record("write with the same owner's stale generation",
      store.recordSubmission({ ...stale, now: T0 + LEASE_MS, submission: again.submission }), false);
    const inspected = await claim(store, again.intent, "owner-c", T0 + LEASE_MS * 2);
    check(inspected.status === "acquired" && inspected.submission === undefined,
      "a write with the same owner's stale generation was retained");
  }],

  ["every ordinary write refuses a lease that has expired at its now", async (store, tag) => {
    const fixture = new Fixture(tag);
    const write = await acquire(store, fixture.intent, "owner-a", T0);
    const expired = { ...write, now: T0 + LEASE_MS };
    await record("submission after lease expiry",
      store.recordSubmission({ ...expired, submission: fixture.submission }), false);
    await record("submission", store.recordSubmission({ ...write, submission: fixture.submission }), true);
    await record("observation after lease expiry",
      store.recordObservation({ ...expired, observation: fixture.lockedPending() }), false);
    await record("checkpoint", store.recordObservation({ ...write, observation: fixture.lockedPending() }), true);
    const completion = fixture.completed(T0 + 1);
    await record("completion", store.recordObservation({ ...write, observation: completion }), true);
    await record("settlement after lease expiry",
      store.recordSettlement({ ...expired, settlement: fixture.settlement(completion) }), false);
    await record("settlement", store.recordSettlement({ ...write, settlement: fixture.settlement(completion) }), true);
  }],

  ["the first submission is kept and a replacement is refused", async (store, tag) => {
    const fixture = new Fixture(tag);
    const write = await acquire(store, fixture.intent, "owner-a", T0);
    await record("first submission", store.recordSubmission({ ...write, submission: fixture.submission }), true);
    await record("exact replay", store.recordSubmission({ ...write, submission: fixture.submission }), true);
    await record("re-signed replacement", store.recordSubmission({
      ...write, submission: retained(signedSubmission(fixture.intent, fixture.bridgeId, 2)),
    }), false);
    await record("replacement on another bridge operation", store.recordSubmission({
      ...write, submission: retained(signedSubmission(fixture.intent, fixture.otherBridgeId, 1)),
    }), false);
    const reclaimed = await claim(store, fixture.intent, "owner-b", T0 + LEASE_MS);
    check(reclaimed.status === "acquired" && same(reclaimed.submission, fixture.submission),
      "the retained submission is not the first one");
  }],

  ["the first submission's receipt is its write's now, kept across replays and restarts", async (store, tag, reopen) => {
    const fixture = new Fixture(tag, 0);
    const write = await acquire(store, fixture.intent, "owner-a", T0);
    await record("first submission", store.recordSubmission({ ...write, now: T0 + 1, submission: fixture.submission }), true);
    await record("exact replay a millisecond later",
      store.recordSubmission({ ...write, now: T0 + 2, submission: fixture.submission }), true);
    const waiting = await claim(store, fixture.intent, "owner-b", T0 + 3);
    check(waiting.status === "waiting" && waiting.submissionRecordedAt === T0 + 1,
      "a waiting claim does not return the first submission write's now as submissionRecordedAt");
    const resumed = await claim(await reopen(store), fixture.intent, "owner-b", T0 + LEASE_MS);
    check(resumed.status === "acquired" && same(resumed.submission, fixture.submission) &&
      resumed.submissionRecordedAt === T0 + 1,
      "after a restart, the acquired claim does not return the first submission write's now as submissionRecordedAt");

    const expiring = new Fixture(tag, 1);
    const { write: expiryWrite, checkpoint } = await lockWith(store, expiring, "owner-c", DEADLINE - 10, LEASE_MS, DUE);
    await record("expiry", store.recordRecoveryExpired({
      ...expiryWrite, now: DUE, expectedObservation: checkpoint, observation: checkpoint,
    }), true);
    const expired = await claim(await reopen(store), expiring.intent, "owner-d", DEADLINE + LEASE_MS);
    check(expired.status === "recovery-expired" && expired.submissionRecordedAt === DEADLINE - 10,
      "after a restart, the recovery-expired claim does not return the first submission write's now as submissionRecordedAt");
  }],

  ["a bridge operation serves one settlement only", async (store, tag, reopen) => {
    const first = new Fixture(tag, 0);
    const second = new Fixture(tag, 1);
    const firstWrite = await acquire(store, first.intent, "owner-a", T0);
    await record("first settlement's submission",
      store.recordSubmission({ ...firstWrite, submission: first.submission }), true);
    const secondWrite = await acquire(store, second.intent, "owner-b", T0);
    const reuse = retained(signedSubmission(second.intent, first.bridgeId, 1));
    await record("second settlement reusing the bridge ID",
      store.recordSubmission({ ...secondWrite, submission: reuse }), false);
    // A refusal moves nothing: the bridge ID stays with the first settlement,
    // so the core's retry of a refused write is refused again.
    await record("second settlement reusing the bridge ID again",
      store.recordSubmission({ ...secondWrite, submission: reuse }), false);
    await record("first settlement's submission replayed after the refused reuse",
      store.recordSubmission({ ...firstWrite, submission: first.submission }), true);
    const reopened = await reopen(store);
    const resumed = await acquire(reopened, second.intent, "owner-c", T0 + LEASE_MS);
    await record("after a restart, the second settlement reusing the bridge ID",
      reopened.recordSubmission({ ...resumed, submission: reuse }), false);
    const inspected = await claim(reopened, second.intent, "inspector", T0 + LEASE_MS * 2);
    check(inspected.status === "acquired" && inspected.submission === undefined,
      "a refused reuse of another settlement's bridge ID was retained");
  }],

  ["observations need the retained submission and never regress", async (store, tag) => {
    const fixture = new Fixture(tag);
    const write = await acquire(store, fixture.intent, "owner-a", T0);
    await record("observation before any submission",
      store.recordObservation({ ...write, observation: fixture.empty() }), false);
    await record("submission", store.recordSubmission({ ...write, submission: fixture.submission }), true);
    await record("observation for another bridge operation",
      store.recordObservation({ ...write, observation: fixture.empty(T0, fixture.otherBridgeId) }), false);
    await record("empty", store.recordObservation({ ...write, observation: fixture.empty() }), true);
    const checkpoint = fixture.lockedPending(T0 + 1);
    await record("checkpoint", store.recordObservation({ ...write, observation: checkpoint }), true);
    await record("regression to empty",
      store.recordObservation({ ...write, observation: fixture.empty(T0 + 2) }), false);
    await record("a different lock", store.recordObservation({
      ...write, observation: fixture.lockedPending(T0 + 2, fixture.bridgeId, "another-lock"),
    }), false);
    const reclaimed = await claim(store, fixture.intent, "owner-b", T0 + LEASE_MS);
    check(reclaimed.status === "acquired" && same(reclaimed.observation, checkpoint),
      "the checkpoint did not survive the refused writes");
  }],

  ["a completion after the deadline is never recorded as an observation; one at the deadline is timely", async (store, tag) => {
    const fixture = new Fixture(tag);
    const { write, checkpoint } = await lockWith(store, fixture, "owner-a", DEADLINE - 10);
    await record("completion finalized a millisecond after the deadline",
      store.recordObservation({ ...write, observation: fixture.completed(DUE) }), false);
    await record("completion finalized later after the deadline",
      store.recordObservation({ ...write, observation: fixture.completed(DUE + 1) }), false);
    const reclaimed = await claim(store, fixture.intent, "owner-b", DEADLINE - 10 + LEASE_MS);
    check(reclaimed.status === "acquired" && same(reclaimed.observation, checkpoint),
      "a late completion replaced the checkpoint");
    await record("completion finalized at the deadline", store.recordObservation({
      ...write, owner: "owner-b", generation: reclaimed.lease.generation, now: DEADLINE - 10 + LEASE_MS,
      observation: fixture.completed(DEADLINE),
    }), true);
  }],

  ["a settlement needs a durable timely completion", async (store, tag) => {
    const fixture = new Fixture(tag);
    const { write } = await lockWith(store, fixture, "owner-a", T0);
    await record("settlement while only the lock is durable", store.recordSettlement({
      ...write, settlement: fixture.settlement(fixture.completed(T0 + 1)),
    }), false);
    const reclaimed = await claim(store, fixture.intent, "owner-b", T0 + LEASE_MS);
    check(reclaimed.status === "acquired", `settlement before completion left the phase ${reclaimed.status}`);
  }],

  ["a settlement is exact, replayable and terminal", async (store, tag) => {
    const fixture = new Fixture(tag);
    const { write } = await lockWith(store, fixture, "owner-a", T0);
    const completion = fixture.completed(T0 + 1);
    await record("timely completion", store.recordObservation({ ...write, observation: completion }), true);
    const settlement = fixture.settlement(completion);
    await record("settlement other than the completion's", store.recordSettlement({
      ...write, settlement: fixture.settlement(fixture.completed(T0 + 1, fixture.bridgeId, "another-release")),
    }), false);
    await record("settlement", store.recordSettlement({ ...write, settlement }), true);
    await record("exact settlement replay", store.recordSettlement({ ...write, settlement }), true);
    check(!await store.isCurrent(write), "a settled phase still has a current lease");
    await record("observation after settlement",
      store.recordObservation({ ...write, observation: fixture.lockedPending(T0 + 2) }), false);
    const later = await claim(store, fixture.intent, "owner-b", DEADLINE + LEASE_MS);
    check(later.status === "settled" && same(later.settlement, settlement),
      "a later claim does not return the exact settlement");
  }],

  ["a settlement blocks recovery expiry", async (store, tag) => {
    const fixture = new Fixture(tag);
    const { write } = await lockWith(store, fixture, "owner-a", DEADLINE - 10);
    const completion = fixture.completed(DEADLINE - 5);
    await record("timely completion", store.recordObservation({ ...write, observation: completion }), true);
    await record("settlement", store.recordSettlement({ ...write, settlement: fixture.settlement(completion) }), true);
    await record("expiry after the settlement", store.recordRecoveryExpired({
      ...write, now: DUE, expectedObservation: completion, observation: fixture.completed(DUE),
    }), false);
    const later = await claim(store, fixture.intent, "owner-b", DEADLINE + LEASE_MS);
    check(later.status === "settled", `expiry after settlement left the phase ${later.status}`);
  }],

  ["a durable timely completion blocks recovery expiry before its settlement is written", async (store, tag) => {
    const fixture = new Fixture(tag);
    const { write } = await lockWith(store, fixture, "owner-a", DEADLINE - 10);
    const completion = fixture.completed(DEADLINE - 5);
    await record("timely completion", store.recordObservation({ ...write, observation: completion }), true);
    await record("expiry from a late completion", store.recordRecoveryExpired({
      ...write, now: DUE, expectedObservation: completion, observation: fixture.completed(DUE),
    }), false);
    await record("settlement", store.recordSettlement({
      ...write, now: DUE, settlement: fixture.settlement(completion),
    }), true);
  }],

  ["recovery expiry is a compare-and-swap on the exact durable checkpoint", async (store, tag) => {
    const fixture = new Fixture(tag);
    const { write, checkpoint } = await lockWith(store, fixture, "owner-a", DEADLINE - 10, LEASE_MS, DUE);
    const expire = (input: Partial<Parameters<LiquidityTankStore["recordRecoveryExpired"]>[0]>) =>
      store.recordRecoveryExpired({
        ...write, now: DUE, expectedObservation: checkpoint, observation: checkpoint, ...input,
      });
    await record("expiry with the host clock at the deadline", expire({ now: DEADLINE }), false);
    await record("expiry from a snapshot at the deadline",
      expire({ observation: fixture.lockedPending(DEADLINE) }), false);
    await record("expiry against another expected observation",
      expire({ expectedObservation: fixture.empty() }), false);
    await record("expiry after the lease expired", expire({ now: DEADLINE - 10 + LEASE_MS }), false);
    await record("expiry", expire({}), true);
    await record("exact expiry replay", expire({}), true);
    const later = await claim(store, fixture.intent, "owner-b", DEADLINE + LEASE_MS);
    check(later.status === "recovery-expired" && same(later.observation, checkpoint) &&
      same(later.submission, fixture.submission), "a later claim does not return the exact expiry");
  }],

  ["recovery expiry blocks a later completion and settlement", async (store, tag) => {
    const fixture = new Fixture(tag);
    const { write, checkpoint } = await lockWith(store, fixture, "owner-a", DEADLINE - 10, LEASE_MS, DUE);
    await record("expiry", store.recordRecoveryExpired({
      ...write, now: DUE, expectedObservation: checkpoint, observation: checkpoint,
    }), true);
    const completion = fixture.completed(DEADLINE - 5);
    await record("completion after expiry", store.recordObservation({ ...write, observation: completion }), false);
    await record("settlement after expiry", store.recordSettlement({
      ...write, settlement: fixture.settlement(completion),
    }), false);
    const later = await claim(store, fixture.intent, "owner-b", DEADLINE + LEASE_MS);
    check(later.status === "recovery-expired", `a settlement after expiry left the phase ${later.status}`);
  }],

  ["terminal failure evidence is retained once, echoed and expires the lock", async (store, tag) => {
    const fixture = new Fixture(tag);
    const { write, checkpoint } = await lockWith(store, fixture, "owner-a", DEADLINE - 200, 500, DEADLINE - 300);
    const evidence: FailedAfterLock = {
      status: "failed-after-lock",
      checkpoint,
      failure: fixture.failedAfterLock(DEADLINE - 200),
    };
    const retain = (input: Partial<Parameters<LiquidityTankStore["recordRecoveryFailure"]>[0]>) =>
      store.recordRecoveryFailure({ ...write, recoveryFailure: evidence, ...input });
    const expiredLease = await retain({ now: DEADLINE + 300 });
    check(!succeeded(expiredLease), "failure retained under an expired lease");
    const mismatched = await retain({
      recoveryFailure: { ...evidence, checkpoint: fixture.lockedPending(DEADLINE - 299) },
    });
    check(!succeeded(mismatched), "failure retained against another checkpoint");
    const first = await retain({});
    check(first.status === "recorded" && same(first.recoveryFailure, evidence),
      `failure retention answered ${first.status} without echoing the evidence`);
    const replay = await retain({});
    check(succeeded(replay) && "recoveryFailure" in replay && same(replay.recoveryFailure, evidence),
      "exact failure replay is not echoed");
    const replacement = await retain({
      recoveryFailure: { ...evidence, failure: fixture.failedAfterLock(DEADLINE - 150) },
    });
    check(!succeeded(replacement), "a second failure replaced the first");
    await record("checkpoint refresh after a retained failure",
      store.recordObservation({ ...write, observation: fixture.lockedPending(DEADLINE - 150) }), false);
    const waiting = await claim(store, fixture.intent, "owner-b", DEADLINE - 100);
    check(waiting.status === "waiting" && same(waiting.recoveryFailure, evidence) &&
      same(waiting.observation, checkpoint), "a claim does not return the retained failure");
    await record("expiry from the retained failure with the host clock at the deadline", store.recordRecoveryExpired({
      ...write, now: DEADLINE, expectedObservation: checkpoint, observation: evidence,
    }), false);
    await record("stale pre-deadline failure cannot expire", store.recordRecoveryExpired({
      ...write, now: DUE, expectedObservation: checkpoint, observation: evidence,
    }), false);
    await record("expiry from the reconciled failure", store.recordRecoveryExpired({
      ...write, now: DUE, expectedObservation: checkpoint,
      observation: { ...evidence, failure: fixture.failedAfterLock(DUE) },
    }), true);
  }],

  ["a timely completion clears retained failure evidence and wins", async (store, tag) => {
    const fixture = new Fixture(tag);
    const { write, checkpoint } = await lockWith(store, fixture, "owner-a", DEADLINE - 200, 500, DEADLINE - 300);
    const evidence: FailedAfterLock = {
      status: "failed-after-lock",
      checkpoint,
      failure: fixture.failedAfterLock(DEADLINE - 200),
    };
    const retainedFailure = await store.recordRecoveryFailure({ ...write, recoveryFailure: evidence });
    check(succeeded(retainedFailure), `failure retention answered ${retainedFailure.status}`);
    const completion = fixture.completed(DEADLINE - 1);
    await record("timely completion", store.recordObservation({ ...write, observation: completion }), true);
    await record("expiry from the cleared failure", store.recordRecoveryExpired({
      ...write, now: DUE, expectedObservation: completion, observation: evidence,
    }), false);
    await record("settlement", store.recordSettlement({
      ...write, now: DEADLINE, settlement: fixture.settlement(completion),
    }), true);
  }],

  ["a timely completion of the lock a durable failure carries replaces it and blocks expiry", async (store, tag) => {
    const fixture = new Fixture(tag);
    const write = await acquire(store, fixture.intent, "owner-a", DEADLINE - 200, 500);
    await record("first submission", store.recordSubmission({ ...write, submission: fixture.submission }), true);
    // No checkpoint first: the bridge's first locked report is a failure that carries the lock.
    const failure = fixture.failedAfterLock(DEADLINE - 200);
    await record("failure carrying its lock", store.recordObservation({ ...write, observation: failure }), true);
    await record("locked pending after that failure",
      store.recordObservation({ ...write, observation: fixture.lockedPending(DEADLINE - 150) }), false);
    const completion = fixture.completed(DEADLINE - 1);
    await record("completion of another lock after that failure",
      store.recordObservation({ ...write, observation: { ...completion, lockTxHash: "another-lock" } }), false);
    await record("timely completion of that failure's lock",
      store.recordObservation({ ...write, observation: completion }), true);
    await record("expiry from the replaced failure", store.recordRecoveryExpired({
      ...write, now: DUE, expectedObservation: failure, observation: failure,
    }), false);
    await record("expiry from the replaced failure against the completion", store.recordRecoveryExpired({
      ...write, now: DUE, expectedObservation: completion, observation: failure,
    }), false);
    await record("settlement", store.recordSettlement({
      ...write, now: DEADLINE, settlement: fixture.settlement(completion),
    }), true);
  }],

  ["a failure that carries its lock is expiry evidence only as the durable observation", async (store, tag) => {
    const durable = new Fixture(tag, 0);
    const write = await acquire(store, durable.intent, "owner-a", DEADLINE - 10);
    await record("first submission", store.recordSubmission({ ...write, submission: durable.submission }), true);
    const failure = durable.failedAfterLock(DUE);
    await record("failure carrying its lock", store.recordObservation({ ...write, observation: failure }), true);
    const expire = (observation: LiquidityTankRecoveryEvidence, now = DUE) =>
      store.recordRecoveryExpired({ ...write, now, expectedObservation: failure, observation });
    await record("expiry from the durable failure with the host clock at the deadline",
      expire(failure, DEADLINE), false);
    await record("expiry from a failure that is not the durable one", expire(durable.failedAfterLock(DUE + 1)), false);
    await record("expiry from the durable failure", expire(failure), true);
    await record("exact expiry replay", expire(failure), true);

    const beside = new Fixture(tag, 1);
    const locked = await lockWith(store, beside, "owner-a", DEADLINE - 200, 500, DEADLINE - 300);
    const retainedFailure = beside.failedAfterLock(DUE);
    const evidence: FailedAfterLock = { status: "failed-after-lock", checkpoint: locked.checkpoint, failure: retainedFailure };
    const kept = await store.recordRecoveryFailure({ ...locked.write, recoveryFailure: evidence });
    check(succeeded(kept), `failure retention answered ${kept.status}`);
    await record("expiry from a bare failure retained beside a checkpoint", store.recordRecoveryExpired({
      ...locked.write, now: DUE, expectedObservation: locked.checkpoint, observation: retainedFailure,
    }), false);
    await record("expiry from the retained failure", store.recordRecoveryExpired({
      ...locked.write, now: DUE, expectedObservation: locked.checkpoint, observation: evidence,
    }), true);
  }],

  ["a late completion is expiry evidence only for the durable lock and its deadline", async (store, tag) => {
    const expireAgainst = async (label: string, fixture: Fixture, write: WriteAuthority, durable: ObservationValue) => {
      const late = fixture.completed(DUE);
      const expire = (observation: LiquidityTankRecoveryEvidence) =>
        store.recordRecoveryExpired({ ...write, now: DUE, expectedObservation: durable, observation });
      await record(`late completion of another lock against ${label}`,
        expire({ ...late, lockTxHash: "another-lock" }), false);
      await record(`late completion of the lock with another deadline against ${label}`,
        expire({ ...late, recoveryDeadline: DEADLINE - 100 }), false);
      await record(`completion of the lock finalized at the deadline against ${label}`,
        expire(fixture.completed(DEADLINE)), false);
      await record(`late completion of the lock against ${label}`, expire(late), true);
    };
    const checkpointed = new Fixture(tag, 0);
    const locked = await lockWith(store, checkpointed, "owner-a", DEADLINE - 10, LEASE_MS, DEADLINE - 500);
    await expireAgainst("a checkpoint", checkpointed, locked.write, locked.checkpoint);

    const failing = new Fixture(tag, 1);
    const write = await acquire(store, failing.intent, "owner-a", DEADLINE - 10);
    await record("first submission", store.recordSubmission({ ...write, submission: failing.submission }), true);
    const failure = failing.failedAfterLock(DEADLINE - 200);
    await record("failure carrying its lock", store.recordObservation({ ...write, observation: failure }), true);
    await expireAgainst("a durable failure that carries its lock", failing, write, failure);
  }],

  ["a contradiction expires a lock only when stamped after its checkpoint and after the deadline, never while the operation is live",
    async (store, tag) => {
      const contradicted = (checkpoint: ObservationValue, contradiction: ObservationValue) =>
        ({ status: "contradicted-after-lock", checkpoint, contradiction }) as LiquidityTankRecoveryEvidence;
      const fixture = new Fixture(tag, 0);
      const { write, checkpoint } = await lockWith(store, fixture, "owner-a", DEADLINE - 10, LEASE_MS, DEADLINE - 500);
      const expire = (contradiction: ObservationValue, now = DUE, against = checkpoint) =>
        store.recordRecoveryExpired({
          ...write, now, expectedObservation: checkpoint, observation: contradicted(against, contradiction),
        });
      const { lockTxHash: _lock, recoveryDeadline: _deadline, ...unlocked } = fixture.lockedPending(DUE);
      await record("contradiction stamped at the deadline", expire(fixture.empty(DEADLINE)), false);
      await record("contradiction after the deadline with the host clock at it",
        expire(fixture.empty(DUE), DEADLINE), false);
      await record("pending without a lock after the deadline", expire(unlocked as ObservationValue), false);
      await record("pending of another lock inside its own window", expire({
        ...fixture.lockedPending(DUE), lockTxHash: "another-lock", recoveryDeadline: DEADLINE + 1_000,
      }), false);
      await record("pending of another lock at its own deadline", expire({
        ...fixture.lockedPending(DUE), lockTxHash: "another-lock", recoveryDeadline: DUE,
      }), false);
      await record("contradiction of another checkpoint",
        expire(fixture.empty(DUE), DUE, fixture.lockedPending(DEADLINE - 499)), false);
      await record("contradiction stamped after the checkpoint and the deadline", expire(fixture.empty(DUE)), true);
      await record("exact contradiction expiry replay", expire(fixture.empty(DUE)), true);

      const late = new Fixture(tag, 1);
      const lateLock = await lockWith(store, late, "owner-a", DEADLINE + 50, LEASE_MS, DEADLINE + 100);
      const expireLate = (contradiction: ObservationValue) => store.recordRecoveryExpired({
        ...lateLock.write, expectedObservation: lateLock.checkpoint,
        observation: contradicted(lateLock.checkpoint, contradiction),
      });
      await record("contradiction past the deadline but before the checkpoint", expireLate(late.empty(DEADLINE + 50)), false);
      await record("contradiction stamped with the checkpoint's time", expireLate(late.empty(DEADLINE + 100)), false);
      await record("contradiction stamped after a checkpoint past the deadline", expireLate(late.empty(DEADLINE + 101)), true);

      const failing = new Fixture(tag, 2);
      const failingLock = await lockWith(store, failing, "owner-a", DEADLINE - 200, 500, DEADLINE - 300);
      const kept = await store.recordRecoveryFailure({
        ...failingLock.write,
        recoveryFailure: { status: "failed-after-lock", checkpoint: failingLock.checkpoint, failure: failing.failedAfterLock(DEADLINE - 200) },
      });
      check(succeeded(kept), `failure retention answered ${kept.status}`);
      await record("contradiction beside retained failure evidence", store.recordRecoveryExpired({
        ...failingLock.write, now: DUE, expectedObservation: failingLock.checkpoint,
        observation: contradicted(failingLock.checkpoint, failing.empty(DUE)),
      }), false);
    }],

  ["retained state survives a restart", async (store, tag, reopen) => {
    const locked = new Fixture(tag, 0);
    const { write, checkpoint } = await lockWith(store, locked, "owner-a", T0);
    let reopened = await reopen(store);
    const resumed = await claim(reopened, locked.intent, "owner-b", T0 + LEASE_MS);
    check(resumed.status === "acquired" && same(resumed.submission, locked.submission) &&
      same(resumed.observation, checkpoint), "the reopened store lost the submission or the checkpoint");
    check(resumed.lease.generation > write.generation, "the reopened store reused a generation");
    const resumedWrite = { ...write, owner: "owner-b", generation: resumed.lease.generation, now: T0 + LEASE_MS };
    const completion = locked.completed(T0 + LEASE_MS);
    await record("completion", reopened.recordObservation({ ...resumedWrite, observation: completion }), true);
    await record("settlement", reopened.recordSettlement({
      ...resumedWrite, settlement: locked.settlement(completion),
    }), true);

    const expiring = new Fixture(tag, 1);
    const expiry = await lockWith(reopened, expiring, "owner-c", DEADLINE - 10, LEASE_MS, DUE);
    await record("expiry", reopened.recordRecoveryExpired({
      ...expiry.write, now: DUE, expectedObservation: expiry.checkpoint, observation: expiry.checkpoint,
    }), true);
    reopened = await reopen(reopened);
    const settled = await claim(reopened, locked.intent, "owner-d", DEADLINE + LEASE_MS);
    check(settled.status === "settled" && same(settled.settlement, locked.settlement(completion)),
      "the settlement did not survive a restart");
    const expired = await claim(reopened, expiring.intent, "owner-d", DEADLINE + LEASE_MS);
    check(expired.status === "recovery-expired", "the recovery expiry did not survive a restart");
    // The bridge-ID index survives too: no other phase may take the settled
    // phase's bridge operation, while its own is still free.
    const third = new Fixture(tag, 2);
    const thirdWrite = await acquire(reopened, third.intent, "owner-e", DEADLINE + LEASE_MS);
    await record("after a restart, another phase reusing a settled bridge operation", reopened.recordSubmission({
      ...thirdWrite, submission: retained(signedSubmission(third.intent, locked.bridgeId, 1)),
    }), false);
    await record("after a restart, another phase on its own bridge operation", reopened.recordSubmission({
      ...thirdWrite, submission: third.submission,
    }), true);
  }],

  ["through the core, crashes and restarts never double-send, lock more than the intent or settle an expired phase",
    async (store, tag, reopen) => {
      await phaseSequence(store, tag, reopen, "settles");
    }],

  ["through the core, an expired phase stays expired across restarts and a late release",
    async (store, tag, reopen) => {
      await phaseSequence(store, tag, reopen, "expires");
    }],

  ["concurrent claims elect exactly one owner, on a fresh phase or a takeover", async (store, tag, reopen) => {
    for (let index = 0; index < ORDERS.length; index += 1) {
      const order = ORDERS[index] as Order;
      for (const takeover of [false, true]) {
        const fixture = new Fixture(tag, index * 2 + (takeover ? 1 : 0));
        const kind = takeover ? "takeovers of an expired lease" : "claims on a fresh phase";
        const at = takeover ? T0 + LEASE_MS : T0;
        if (takeover) await acquire(store, fixture.intent, "owner-0", T0);
        const other = await reopen(store);
        const claims = await race(order,
          () => claim(store, fixture.intent, "owner-a", at),
          () => claim(other, fixture.intent, "owner-b", at));
        const acquired = claims.filter((claimed): claimed is AcquiredClaim => claimed.status === "acquired");
        check(acquired.length === 1, `${acquired.length} of two concurrent ${kind} acquired the phase (${order})`);
        const winner = (acquired[0] as AcquiredClaim).lease;
        const loser = claims.find((claimed) => claimed.status !== "acquired") as LiquidityTankStoreClaim;
        check(loser.status === "waiting" && loser.lease.owner === winner.owner &&
          loser.lease.generation === winner.generation,
          `the other of two concurrent ${kind} does not wait on the winner's lease (${order})`);
        const inspected = await claim(await reopen(store), fixture.intent, "inspector", at);
        check(inspected.status === "waiting" && inspected.lease.owner === winner.owner &&
          inspected.lease.generation === winner.generation && inspected.lease.expiresAt === at + LEASE_MS,
          `a fresh handle does not see the winner's lease after two concurrent ${kind} (${order})`);
      }
    }
  }],

  ["concurrent submissions for one phase keep exactly one", async (store, tag, reopen) => {
    for (let index = 0; index < ORDERS.length; index += 1) {
      const order = ORDERS[index] as Order;
      const fixture = new Fixture(tag, index);
      const write = await acquire(store, fixture.intent, "owner-a", T0);
      const other = await reopen(store);
      const resigned = retained(signedSubmission(fixture.intent, fixture.otherBridgeId, 2));
      const writes = await race(order,
        () => store.recordSubmission({ ...write, submission: fixture.submission }),
        () => other.recordSubmission({ ...write, submission: resigned }));
      check(successes(...writes) === 1,
        `${successes(...writes)} of two concurrent submissions for one phase were recorded (${order})`);
      const kept = succeeded(writes[0]) ? fixture.submission : resigned;
      const inspected = await claim(await reopen(store), fixture.intent, "inspector", T0 + LEASE_MS);
      check(inspected.status === "acquired" && same(inspected.submission, kept),
        `a fresh handle does not hold the one submission the store recorded (${order})`);
    }
  }],

  ["concurrent submissions on one bridge operation serve one settlement", async (store, tag, reopen) => {
    for (let index = 0; index < ORDERS.length; index += 1) {
      const order = ORDERS[index] as Order;
      const first = new Fixture(tag, index * 2);
      const second = new Fixture(tag, index * 2 + 1);
      const other = await reopen(store);
      const firstWrite = await acquire(store, first.intent, "owner-a", T0);
      const secondWrite = await acquire(other, second.intent, "owner-b", T0);
      const writes = await race(order,
        () => store.recordSubmission({ ...firstWrite, submission: first.submission }),
        () => other.recordSubmission({
          ...secondWrite, submission: retained(signedSubmission(second.intent, first.bridgeId, 1)),
        }));
      check(successes(...writes) === 1,
        `${successes(...writes)} of two concurrent submissions on one bridge operation were recorded (${order})`);
      const inspector = await reopen(store);
      const held = [
        await claim(inspector, first.intent, "inspector", T0 + LEASE_MS),
        await claim(inspector, second.intent, "inspector", T0 + LEASE_MS),
      ];
      check(held.every((claimed, at) => claimed.status === "acquired" &&
        (claimed.submission !== undefined) === succeeded(writes[at] as LiquidityTankStoreWrite)),
        `a fresh handle does not show the bridge operation held by the one phase the store recorded (${order})`);
    }
  }],

  ["a timely completion racing recovery expiry: exactly one wins", async (store, tag, reopen) => {
    for (let index = 0; index < ORDERS.length; index += 1) {
      const order = ORDERS[index] as Order;
      const fixture = new Fixture(tag, index);
      // Observed after the deadline, the checkpoint makes expiry due while the completion is still timely.
      const { write, checkpoint } = await lockWith(store, fixture, "owner-a", DEADLINE - 10, LEASE_MS, DUE);
      const other = await reopen(store);
      const completion = fixture.completed(DEADLINE - 1);
      const due = { ...write, now: DUE };
      const writes = await race(order,
        () => store.recordObservation({ ...due, observation: completion }),
        () => other.recordRecoveryExpired({ ...due, expectedObservation: checkpoint, observation: checkpoint }));
      check(successes(...writes) === 1,
        `${successes(...writes)} of a concurrent timely completion and recovery expiry were recorded (${order})`);
      const completionWon = succeeded(writes[0]);
      const inspected = await claim(await reopen(store), fixture.intent, "inspector", DEADLINE + LEASE_MS);
      check(completionWon
        ? inspected.status === "acquired" && same(inspected.observation, completion)
        : inspected.status === "recovery-expired" && same(inspected.observation, checkpoint),
        `a fresh handle does not show the ${completionWon ? "completion" : "expiry"} the store recorded (${order})`);
    }
  }],

  ["a settlement racing recovery expiry after a durable timely completion: only the settlement wins",
    async (store, tag, reopen) => {
      for (let index = 0; index < ORDERS.length; index += 1) {
        const order = ORDERS[index] as Order;
        const fixture = new Fixture(tag, index);
        const { write } = await lockWith(store, fixture, "owner-a", DEADLINE - 10);
        const completion = fixture.completed(DEADLINE - 5);
        await record("timely completion", store.recordObservation({ ...write, observation: completion }), true);
        const other = await reopen(store);
        const afterDeadline = { ...write, now: DUE };
        const settlement = fixture.settlement(completion);
        const [settled, expired] = await race(order,
          () => store.recordSettlement({ ...afterDeadline, settlement }),
          () => other.recordRecoveryExpired({
            ...afterDeadline, expectedObservation: completion, observation: fixture.completed(DUE),
          }));
        const outcome = succeeded(expired)
          ? (succeeded(settled) ? "both the settlement and the expiry were recorded" : "the expiry won")
          : (succeeded(settled) ? undefined : "neither was recorded");
        check(outcome === undefined,
          `a settlement racing recovery expiry after a durable timely completion: ${outcome} (${order})`);
        const inspected = await claim(await reopen(store), fixture.intent, "inspector", DEADLINE + LEASE_MS);
        check(inspected.status === "settled" && same(inspected.settlement, settlement),
          `a fresh handle does not show the settlement that won the race with expiry (${order})`);
      }
    }],

  ["a takeover racing each ordinary write: the write lands before the takeover or not at all",
    async (store, tag, reopen) => {
      for (let index = 0; index < ORDERS.length; index += 1) {
        const order = ORDERS[index] as Order;
        for (let kind = 0; kind < TAKEOVER_RACES.length; kind += 1) {
          const [method, setUp] = TAKEOVER_RACES[kind] as (typeof TAKEOVER_RACES)[number];
          const fixture = new Fixture(tag, index * TAKEOVER_RACES.length + kind);
          const racing = await setUp(store, fixture);
          const other = await reopen(store);
          const [written, takeover] = await race(order,
            () => racing.write(store),
            () => claim(other, fixture.intent, "owner-b", racing.takeoverAt));
          const landed = succeeded(written);
          check(racing.shows(takeover) === landed, landed
            ? `${method} by the old owner landed after another owner took its lease over (${order})`
            : `a takeover saw a ${method} the store refused (${order})`);
          check(landed || takeover.status === "acquired",
            `a takeover racing a refused ${method} returned ${takeover.status} (${order})`);
          const inspected = await claim(await reopen(store), fixture.intent, "inspector", racing.takeoverAt + LEASE_MS);
          check(racing.shows(inspected) === landed,
            `a fresh handle ${landed ? "lacks" : "shows"} the ${method} the store ${landed ? "recorded" : "refused"} (${order})`);
        }
      }
    }],

  ["through the core, two workers starting one phase at once broadcast at most once",
    async (store, tag, reopen) => {
      for (let index = 0; index < ORDERS.length; index += 1) {
        await concurrentStart(store, tag, reopen, ORDERS[index] as Order, index);
      }
    }],
];

/**
 * A model native bridge for one operation: it locks the amount its decoded
 * signed bytes carry when they are broadcast, and reports every operation it
 * has seen. It keeps no tank balance; pool accounting is the bridge's own
 * invariant. The host checks it supplies authenticate only observations it
 * issued and verify that signed bytes carry exactly the intent.
 */
function modelBridge(intent: Readonly<LiquidityTankIntent>, tag: string, clock: () => number, phaseIndex = 0) {
  const locked = new Map<string, bigint>();
  const broadcast = new Set<string>();
  const issued = new Set<string>();
  let prepared = 0;
  let releasedAt: number | undefined;
  let ambiguousNextBroadcast = false;
  const issue = (observation: ObservationValue): ObservationValue => {
    issued.add(canonicalize(observation));
    return observation;
  };
  const fixture = new Fixture(tag, phaseIndex);
  const adapter: LiquidityTankAdapter = {
    async prepareSubmission(bound) {
      prepared += 1;
      return signedSubmission(bound, bridgeIdFor(tag, prepared + phaseIndex * 10), prepared, clock());
    },
    async broadcastRetained(submission) {
      const transfer = decodeTransfer(submission);
      if (transfer === null) throw new Error("model bridge: undecodable submission");
      broadcast.add(submission.submissionHash);
      if (!locked.has(transfer.bridgeId)) locked.set(transfer.bridgeId, BigInt(transfer.amountBaseUnits));
      if (ambiguousNextBroadcast) {
        ambiguousNextBroadcast = false;
        throw new Error("model bridge: broadcast response lost");
      }
    },
    async observe(_bound, submission) {
      if (!locked.has(submission.bridgeId)) return issue(fixture.empty(clock(), submission.bridgeId));
      return issue(releasedAt === undefined
        ? fixture.lockedPending(clock(), submission.bridgeId)
        : fixture.completed(releasedAt, submission.bridgeId));
    },
  };
  const verifier: LiquidityTankVerifier = {
    authenticateObservation: ({ observation }) => issued.has(canonicalize(observation)),
    verifySignedSubmission: ({ intent: bound, submission }) => {
      const transfer = decodeTransfer(submission);
      return transfer !== null && transfer.bridgeId === submission.bridgeId &&
        transfer.amountBaseUnits === bound.sourceAmountBaseUnits &&
        transfer.originAddress === bound.originAddress &&
        transfer.destinationAddress === bound.destinationAddress &&
        transfer.asset === bound.sourceAsset &&
        transfer.sourceLiquidityTankId === bound.sourceLiquidityTankId &&
        transfer.destinationLiquidityTankId === bound.destinationLiquidityTankId;
    },
  };
  return {
    adapter,
    verifier,
    prepared: () => prepared,
    broadcast,
    lockedTotal: () => [...locked.values()].reduce((total, amount) => total + amount, 0n),
    release(at: number) { releasedAt = at; },
    loseNextBroadcastResponse() { ambiguousNextBroadcast = true; },
    intent,
  };
}

/**
 * `store` as the core-level cases hand it to the core, which runs only on a
 * store that declares its restart safety: a host runs these cases to earn
 * `restartSafety: "conformance-tested"`, so they declare it for the run.
 */
function declaredUnderTest(store: LiquidityTankStore): LiquidityTankStore {
  return {
    restartSafety: "conformance-tested",
    claim: (input) => store.claim(input),
    isCurrent: (input) => store.isCurrent(input),
    recordSubmission: (input) => store.recordSubmission(input),
    recordObservation: (input) => store.recordObservation(input),
    recordRecoveryFailure: (input) => store.recordRecoveryFailure(input),
    recordRecoveryExpired: (input) => store.recordRecoveryExpired(input),
    recordSettlement: (input) => store.recordSettlement(input),
  };
}

/** A handle on `store` whose next `recordSubmission` dies before reaching the store. */
function crashingBeforeSubmissionCommit(store: LiquidityTankStore): LiquidityTankStore {
  return {
    claim: (input) => store.claim(input),
    isCurrent: (input) => store.isCurrent(input),
    recordSubmission: async () => {
      throw new Error("worker stopped before the submission write committed");
    },
    recordObservation: (input) => store.recordObservation(input),
    recordRecoveryFailure: (input) => store.recordRecoveryFailure(input),
    recordRecoveryExpired: (input) => store.recordRecoveryExpired(input),
    recordSettlement: (input) => store.recordSettlement(input),
  };
}

/**
 * Drives the core over one phase through worker crashes, a lost broadcast
 * response and restarts. After every step it checks that no second signed
 * submission was broadcast and the funds this one operation locked never
 * exceed its intent (in this model a second bridge operation fails both), and
 * that settled and expired are never both reported. The phase must end in
 * exactly one of them, and the store must agree.
 */
async function phaseSequence(
  initial: LiquidityTankStore,
  tag: string,
  reopen: Reopen,
  ending: "settles" | "expires",
): Promise<void> {
  const intent = createLiquidityTankIntent(authorityFor(tag, 0));
  let now = T0;
  const bridge = modelBridge(intent, tag, () => now);
  const amount = BigInt(intent.sourceAmountBaseUnits);
  let store = initial;
  let settled = false;
  let expired = false;
  let step = 0;
  const run = async (owner: string, handle: LiquidityTankStore = store): Promise<LiquidityTankProgress> => {
    step += 1;
    const progress = await advanceLiquidityTankSettlement({
      authority: authorityFor(tag, 0),
      owner,
      store: declaredUnderTest(handle),
      adapter: bridge.adapter,
      verifier: bridge.verifier,
      now: () => now,
      leaseDurationMs: LEASE_MS,
    });
    if (progress.status === "settled") settled = true;
    if (progress.status === "failed" && progress.errorClass === "failed-substrate") expired = true;
    check(bridge.broadcast.size <= 1 && bridge.lockedTotal() <= amount,
      `step ${step} (${owner}): ${bridge.broadcast.size} different signed submissions were broadcast, ` +
        `locking ${bridge.lockedTotal()} base units for an intent of ${amount}`);
    check(!(settled && expired), `step ${step} (${owner}): the phase was reported both settled and expired`);
    return progress;
  };
  const restart = async () => {
    store = await reopen(store);
    now += LEASE_MS;
  };

  if (ending === "settles") {
    // The worker stops after signing, before the submission is durable.
    let progress = await run("worker-1", crashingBeforeSubmissionCommit(store));
    check(progress.status === "indeterminate" && bridge.broadcast.size === 0,
      "a submission whose write never committed was broadcast");
    await restart();
    // A fresh signature is stored and broadcast; the response is lost.
    bridge.loseNextBroadcastResponse();
    progress = await run("worker-2");
    check(progress.status === "indeterminate", `lost broadcast response returned ${progress.status}`);
    await restart();
    progress = await run("worker-3");
    check(progress.status === "settle-asymmetric", `locked bridge read returned ${progress.status}`);
    bridge.release(now);
    await restart();
    progress = await run("worker-4");
    check(progress.status === "settled", `timely release returned ${progress.status}`);
    await restart();
    now = DEADLINE + LEASE_MS;
    progress = await run("worker-5");
    check(progress.status === "settled", `settled phase after a restart returned ${progress.status}`);
    check(bridge.prepared() === 2, `${bridge.prepared()} submissions were signed; expected 2`);
  } else {
    let progress = await run("worker-1");
    check(progress.status === "settle-asymmetric", `locked bridge read returned ${progress.status}`);
    await restart();
    // At the deadline a release is still timely: the lock is not yet overdue.
    now = DEADLINE;
    progress = await run("worker-2");
    check(progress.status === "settle-asymmetric" && !progress.pastDeadline,
      `a lock at its deadline returned ${progress.status}${progress.status === "settle-asymmetric" ? " past its deadline" : ""}`);
    await restart();
    now = DEADLINE + LEASE_MS;
    progress = await run("worker-3");
    check(expired, `a lock still pending after its deadline returned ${progress.status}`);
    // The release lands after the deadline: it cannot reopen the phase.
    bridge.release(now);
    await restart();
    progress = await run("worker-4");
    check(expired && !settled, `an expired phase after a late release returned ${progress.status}`);
    check(bridge.prepared() === 1, `${bridge.prepared()} submissions were signed; expected 1`);
  }
  check(bridge.broadcast.size === 1 && bridge.lockedTotal() === amount,
    "the phase did not broadcast and lock exactly one submission");
  const final = await claim(await reopen(store), intent, "inspector", DEADLINE + LEASE_MS * 10);
  check(final.status === (ending === "settles" ? "settled" : "recovery-expired"),
    `the store reports ${final.status} after the phase ${ending === "settles" ? "settled" : "expired"}`);
}

/**
 * Two workers start one fresh phase through the core at once, each through
 * its own handle, in `order`. A worker that acquires the phase waits at
 * preparation until the other has also prepared or has returned, so if both
 * acquired they would both sign before either writes. Exactly one may go past
 * the claim, and at most one signed submission may be broadcast.
 */
async function concurrentStart(
  store: LiquidityTankStore,
  tag: string,
  reopen: Reopen,
  order: Order,
  phaseIndex: number,
): Promise<void> {
  const intent = createLiquidityTankIntent(authorityFor(tag, phaseIndex));
  const now = T0;
  const bridge = modelBridge(intent, tag, () => now, phaseIndex);
  const amount = BigInt(intent.sourceAmountBaseUnits);
  const preparing = new Set<string>();
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const adapter: LiquidityTankAdapter = {
    ...bridge.adapter,
    async prepareSubmission(bound, fence) {
      preparing.add(fence.owner);
      if (preparing.size > 1) release();
      await barrier;
      return bridge.adapter.prepareSubmission(bound, fence);
    },
  };
  const start = (owner: string, handle: LiquidityTankStore) => advanceLiquidityTankSettlement({
    authority: authorityFor(tag, phaseIndex),
    owner,
    store: declaredUnderTest(handle),
    adapter,
    verifier: bridge.verifier,
    now: () => now,
    leaseDurationMs: LEASE_MS,
  }).finally(release);
  const other = await reopen(store);
  const results = await race(order, () => start("worker-a", store), () => start("worker-b", other));
  check(bridge.broadcast.size <= 1 && bridge.lockedTotal() <= amount,
    `two workers starting one phase at once broadcast ${bridge.broadcast.size} different signed ` +
      `submissions, locking ${bridge.lockedTotal()} base units for an intent of ${amount} (${order})`);
  const past = results.filter((progress) => progress.status !== "waiting");
  check(past.length === 1, `${past.length} of two workers starting one phase at once went past the claim (${order})`);
  check(past[0]?.status === "settle-asymmetric",
    `the worker that acquired the phase returned ${past[0]?.status}, not settle-asymmetric (${order})`);
  const inspected = await claim(await reopen(store), intent, "inspector", now + LEASE_MS);
  check(inspected.status === "acquired" && inspected.submission !== undefined &&
    bridge.broadcast.size === 1 && bridge.broadcast.has(inspected.submission.submissionHash),
    `a fresh handle does not hold the one submission that was broadcast (${order})`);
}

/**
 * Runs the liquidity-tank store contract against a store implementation and
 * returns one result per case. The sequential cases check one write at a
 * time: exact leases and generation fencing, lease expiry on every write,
 * first-submission retention and its host-clock receipt, bridge-ID
 * uniqueness, observation ordering, the completion-versus-expiry election,
 * failure retention, settlement replay,
 * state that survives `reopenStore`, and two phase sequences through the core.
 * The race cases start two operations through two handles before either
 * settles and require one winner, seen from a fresh handle. Passing shows the
 * store keeps the contract in these sequences and races; it does not prove
 * that the store commits atomically under every interleaving. Every result
 * must pass before a store is used in production.
 * Run in a dedicated NODE_ENV=test or NODE_ENV=development process: the model
 * bridge and wrapped store intentionally do not carry production capabilities.
 */
export async function runLiquidityTankStoreConformance(
  options: LiquidityTankStoreConformanceOptions,
): Promise<readonly LiquidityTankStoreConformanceResult[]> {
  if (process.env["NODE_ENV"] !== "test" && process.env["NODE_ENV"] !== "development") {
    throw new TypeError("runLiquidityTankStoreConformance requires NODE_ENV=test or NODE_ENV=development in a dedicated conformance process");
  }
  // A handle reopened as itself would make every restart and race case test
  // nothing, so such a run is refused outright.
  let identity = false;
  try {
    const store = await options.createStore();
    identity = await options.reopenStore(store) === store;
  } catch {
    // A store that cannot be opened fails each case below on its own.
  }
  if (identity) {
    return Object.freeze(CASES.map(([name]) => Object.freeze({ name, passed: false, failure: IDENTITY_REOPEN })));
  }
  const reopen = reopener(options);
  const results: LiquidityTankStoreConformanceResult[] = [];
  for (let index = 0; index < CASES.length; index += 1) {
    const [name, run] = CASES[index] as readonly [string, ConformanceCase];
    try {
      await run(await options.createStore(), String(index).padStart(5, "0"), reopen);
      results.push(Object.freeze({ name, passed: true }));
    } catch (error) {
      results.push(Object.freeze({
        name,
        passed: false,
        failure: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  return Object.freeze(results);
}
