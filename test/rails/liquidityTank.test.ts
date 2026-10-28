import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  assertPositiveAmount,
  baseUnits,
  canonicalize,
  sha256Hex,
} from "../../src/canonical/index.js";
import {
  advanceLiquidityTankSettlement,
  createInMemoryLiquidityTankStore,
  createLiquidityTankIntent,
  liquidityTankSettlementKey,
  type AdvanceLiquidityTankInput,
  type LiquidityTankAdapter,
  type LiquidityTankAuthority,
  type LiquidityTankObservation,
  type LiquidityTankRecoveryEvidence,
  type LiquidityTankStore,
  type LiquidityTankVerifier,
} from "../../src/rails/liquidityTank.js";

const AUTH_HASH = "a".repeat(64);
const RAIL_HASH = "b".repeat(64);
const AGREEMENT_HASH = "c".repeat(64);
const SR5_HASH = "d".repeat(64);
const BRIDGE_ID = "abc123def456gh78";
const JOB_ID = "01JZ0000000000000000000001";
const SECOND_JOB_ID = "01JZ0000000000000000000002";
const DIFFERENT_JOB_ID = "01JZ0000000000000000000003";
const RECOVERY_DEADLINE_MS = 1_785_436_800_000;
/** These tests exercise the reference store within one process. */
const VOLATILE = { acknowledgeVolatile: true } as const;
/** Approves every observation and submission: the flows below test the core, not the host's checks. */
const APPROVING_VERIFIER: LiquidityTankVerifier = {
  authenticateObservation: async () => true,
  verifySignedSubmission: async () => true,
};

function unreadableProxy<T extends object>(value: T, touched: () => void): T {
  const reject = () => {
    touched();
    throw new Error("proxy trap must not run");
  };
  return new Proxy(value, {
    // Promise resolution necessarily probes `then` before an async boundary
    // can deliver a value. Permit only that engine-level probe.
    get(_target, key) {
      if (key === "then") return undefined;
      return reject();
    },
    getOwnPropertyDescriptor: reject,
    getPrototypeOf: reject,
    has: reject,
    ownKeys: reject,
  });
}

function authority(overrides: Partial<LiquidityTankAuthority> = {}): LiquidityTankAuthority {
  return {
    jobId: JOB_ID,
    phaseIndex: 2,
    railId: "demos-tank-sepolia-amoy-usdc",
    railDescriptorHash: RAIL_HASH,
    agreementHash: AGREEMENT_HASH,
    sr5BindingHash: SR5_HASH,
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
    amount: "01.2500",
    currency: "USDC",
    originAddress: "origin-address",
    destinationAddress: "destination-address",
    sourceLiquidityTankId: "tank-source",
    destinationLiquidityTankId: "tank-destination",
    supportedScope: "dacs-v0.1-eth-sepolia-polygon-amoy-usdc",
    ...overrides,
  };
}

function empty(operationHash: string): LiquidityTankObservation {
  return {
    status: "empty",
    bridgeId: BRIDGE_ID,
    operationHash,
    history: ["empty"],
    observedAt: 1_000,
    authenticationHash: AUTH_HASH,
  };
}

function pending(
  operationHash: string,
  locked = false,
  recoveryDeadline = RECOVERY_DEADLINE_MS,
  observedAt = 2_000,
): Extract<LiquidityTankObservation, { status: "pending" }> {
  return {
    status: "pending",
    bridgeId: BRIDGE_ID,
    operationHash,
    history: ["empty", "pending"],
    observedAt,
    authenticationHash: AUTH_HASH,
    lockTxHash: locked ? "source-lock-tx" : undefined,
    recoveryDeadline: locked ? recoveryDeadline : undefined,
  };
}

/** The bridge's authenticated locked pending, observed at `observedAt`. */
function lockedPendingAt(operationHash: string, observedAt: number) {
  return pending(operationHash, true, RECOVERY_DEADLINE_MS, observedAt);
}

function failedAfterLock(
  operationHash: string,
  observedAt: number,
): Extract<LiquidityTankObservation, { status: "failed" }> {
  return {
    status: "failed",
    bridgeId: BRIDGE_ID,
    operationHash,
    history: ["empty", "pending", "failed"],
    observedAt,
    authenticationHash: AUTH_HASH,
    reason: "release rejected by tank shard",
    lockTxHash: "source-lock-tx",
    recoveryDeadline: RECOVERY_DEADLINE_MS,
  };
}

function completed(
  operationHash: string,
  finalityObservedAt = 3_000,
  recoveryDeadline = RECOVERY_DEADLINE_MS,
): Extract<LiquidityTankObservation, { status: "completed" }> {
  return {
    status: "completed",
    bridgeId: BRIDGE_ID,
    operationHash,
    history: ["empty", "pending", "completed"],
    observedAt: 3_000,
    finalityObservedAt,
    recoveryDeadline,
    authenticationHash: AUTH_HASH,
    lockTxHash: "source-lock-tx",
    releaseTxHash: "destination-release-tx",
  };
}

/** The lock an expiry ends, which every committed expiry carries for the interim record. */
function lockTxRef(recoveryDeadline = RECOVERY_DEADLINE_MS, lockTxHash = "source-lock-tx") {
  return {
    kind: "liquidity-tank",
    bridgeId: BRIDGE_ID,
    sourceChainId: 11_155_111,
    destChainId: 80_002,
    lockTxHash,
    recoveryDeadline,
  };
}

/** The committed expiry of `completed(…, finalityObservedAt, recoveryDeadline)`: late, with its evidence. */
function releasedLate(finalityObservedAt: number, recoveryDeadline = RECOVERY_DEADLINE_MS) {
  return {
    status: "failed",
    errorClass: "failed-substrate",
    reason: "tank-released-after-recovery-deadline",
    reputationNeutral: true,
    lockTxRef: lockTxRef(recoveryDeadline),
    txRef: {
      kind: "liquidity-tank",
      bridgeId: BRIDGE_ID,
      sourceChainId: 11_155_111,
      destChainId: 80_002,
      lockTxHash: "source-lock-tx",
      releaseTxHash: "destination-release-tx",
      recoveryDeadline,
    },
    finalityObservedAt,
  };
}

function harness(initial?: LiquidityTankObservation) {
  const intent = createLiquidityTankIntent(authority());
  let observation: LiquidityTankObservation = initial ?? empty(intent.operationHash);
  let throwOnce = false;
  let nextAfterBroadcast: LiquidityTankObservation | undefined;
  let preparedAt = 900;
  const prepareSubmission = vi.fn<LiquidityTankAdapter["prepareSubmission"]>(async (bound, fence) => {
    await fence.assertCurrent();
    return {
      submissionVersion: "1",
      authorityHash: bound.bindingHash,
      operationHash: bound.operationHash,
      bridgeId: BRIDGE_ID,
      substrateTxHash: "demos-native-bridge-tx",
      signedSubmissionBase64: Buffer.from("signed-native-bridge", "utf8").toString("base64"),
      preparedAt,
    };
  });
  const broadcastRetained = vi.fn<LiquidityTankAdapter["broadcastRetained"]>(async (_submission, fence) => {
    await fence.assertCurrent();
    if (throwOnce) {
      throwOnce = false;
      throw new Error("ambiguous broadcast");
    }
    if (nextAfterBroadcast) observation = nextAfterBroadcast;
  });
  const observe = vi.fn<LiquidityTankAdapter["observe"]>(async (_bound, _submission, fence) => {
    await fence.assertCurrent();
    return observation;
  });
  return {
    adapter: { prepareSubmission, broadcastRetained, observe } satisfies LiquidityTankAdapter,
    prepareSubmission,
    broadcastRetained,
    observe,
    setObservation(value: LiquidityTankObservation) { observation = value; },
    setAfterBroadcast(value: LiquidityTankObservation) { nextAfterBroadcast = value; },
    /** The adapter stamps `preparedAt` from its clock, which must be near the host's. */
    setPreparedAt(value: number) { preparedAt = value; },
    failNextBroadcast() { throwOnce = true; },
    operationHash: intent.operationHash,
  };
}

function runner(overrides: Partial<AdvanceLiquidityTankInput> = {}) {
  let clock = 1_000;
  const shared: AdvanceLiquidityTankInput = {
    authority: authority(),
    owner: "worker-a",
    store: createInMemoryLiquidityTankStore(VOLATILE),
    adapter: harness().adapter,
    now: () => clock,
    leaseDurationMs: 100,
    verifier: APPROVING_VERIFIER,
    ...overrides,
  };
  return {
    shared,
    nextOwner() {
      clock += 101;
      return { ...shared, owner: `worker-${clock}` };
    },
    setClock(value: number) { clock = value; },
  };
}

/** A lock expired on an authenticated read that contradicted it. */
const CONTRADICTED_EXPIRY = {
  status: "failed",
  errorClass: "failed-substrate",
  reason: "tank-lock-contradicted-recovery-expired",
  reputationNeutral: true,
  lockTxRef: lockTxRef(),
} as const;

/** Broadcasts once and durably records the locked pending checkpoint. */
async function lockDurably(store: LiquidityTankStore, h: ReturnType<typeof harness>) {
  h.setAfterBroadcast(pending(h.operationHash, true));
  const run = runner({ adapter: h.adapter, store, leaseDurationMs: 1 });
  await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
    status: "settle-asymmetric", reason: "tank-locked-unreleased",
  });
  h.broadcastRetained.mockClear();
  return run;
}

test("malformed persistence results resolve indeterminate without throwing or broadcasting", async () => {
  for (const method of ["recordSubmission", "recordObservation", "recordSettlement"] as const) {
    for (const result of [null, undefined, {}, { status: "unexpected" }, { get status() { throw new Error("unsafe accessor"); } }]) {
      const h = harness(completed(createLiquidityTankIntent(authority()).operationHash));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      store[method] = async () => result as never;
      await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared)).resolves.toMatchObject({ status: "indeterminate" });
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    }
  }
});

test("persistence status is captured before the post-write fence await", async () => {
  const h = harness();
  const store = createInMemoryLiquidityTankStore(VOLATILE);
  const result = { status: "corrupt" };
  let mutate = false;
  const isCurrent = store.isCurrent.bind(store);
  store.recordSubmission = async () => { mutate = true; return result as never; };
  store.isCurrent = async (input) => {
    if (mutate) result.status = "recorded";
    return isCurrent(input);
  };
  await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared)).resolves.toMatchObject({ status: "indeterminate" });
  expect(h.observe).not.toHaveBeenCalled();
  expect(h.broadcastRetained).not.toHaveBeenCalled();
});

test("persistence result proxies are rejected without invoking traps", async () => {
  for (const method of ["recordSubmission", "recordObservation", "recordSettlement"] as const) {
    const touched = vi.fn();
    const result = unreadableProxy({ status: "recorded" }, touched);
    const h = harness(completed(createLiquidityTankIntent(authority()).operationHash));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    store[method] = async () => result as never;

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
      .resolves.toMatchObject({ status: "indeterminate" });
    expect(touched).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  }
});

describe("createLiquidityTankIntent", () => {
  test("binds the exact v0.1 route and per-chain base units", () => {
    expect(createLiquidityTankIntent(authority())).toMatchObject({
      amount: "1.25",
      sourceChainId: 11_155_111,
      destinationChainId: 80_002,
      sourceAmountBaseUnits: "1250000",
      destinationAmountBaseUnits: "1250000",
      mechanism: "liquidity-tank",
      operationHash: "cbbd1b1d178191fda9acce350aa52b4993cf17ae63d2afa7b5db692d912df402",
      bindingHash: "4d574c7e251d0d90d9e1ae6ffff412b9ef7ac63df69499b436bba3061e94dbbf",
    });
  });

  test.each([
    ["source", { sourceTokenDecimals: 18 }],
    ["destination", { destinationTokenDecimals: 18 }],
  ])("rejects contradictory %s decimals before store or adapter access", async (_label, override) => {
    expect(() => createLiquidityTankIntent(authority(override))).toThrow(/must both be exactly 6/);

    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const claim = vi.spyOn(store, "claim");
    const h = harness();
    // The phase may already hold a lock under the same settlement key.
    await expect(advanceLiquidityTankSettlement(runner({
      authority: authority(override),
      store,
      adapter: h.adapter,
    }).shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "pay-cross-chain-liquidity-tank: fixed USDC route token decimals must both be exactly 6",
    });
    expect(claim).not.toHaveBeenCalled();
    expect(h.prepareSubmission).not.toHaveBeenCalled();
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([JOB_ID.toLowerCase(), "tank-job-1"])(
    "rejects non-canonical job identity %s in both exported derivation paths",
    (jobId) => {
      expect(() => createLiquidityTankIntent(authority({ jobId })))
        .toThrow(/canonical uppercase ULID/);
      expect(() => liquidityTankSettlementKey({
        jobId,
        railId: authority().railId,
        phaseIndex: authority().phaseIndex,
      })).toThrow(/canonical uppercase ULID/);
    },
  );

  test.each([
    ["asset kind", { assetKind: "erc20" }],
    ["mechanism", { mechanism: "htlc" }],
    ["reverse route", { sourceChainId: 80_002, destinationChainId: 11_155_111 }],
    ["wrong asset", { destinationAsset: "USDT" }],
    ["wrong scope", { supportedScope: "future-scope" }],
    ["same tank", { destinationLiquidityTankId: "tank-source" }],
    ["overprecision", { amount: "1.0000001" }],
  ])("rejects %s as indeterminate before adapter access", async (_name, override) => {
    const h = harness();
    const result = await advanceLiquidityTankSettlement(runner({
      authority: authority(override as never),
      adapter: h.adapter,
    }).shared);
    expect(result).toEqual({ status: "indeterminate", reason: expect.any(String) });
    expect(h.prepareSubmission).not.toHaveBeenCalled();
  });

  test.each(["accessor", "proxy"] as const)(
    "refuses %s authority as indeterminate without invoking caller code",
    async (kind) => {
      const touched = vi.fn();
      let hostile: LiquidityTankAuthority;
      if (kind === "accessor") {
        hostile = authority();
        Object.defineProperty(hostile, "agreementHash", {
          enumerable: true,
          configurable: true,
          get() {
            touched();
            return touched.mock.calls.length === 1 ? AGREEMENT_HASH : RAIL_HASH;
          },
        });
      } else {
        hostile = unreadableProxy(authority(), touched);
      }
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const claim = vi.spyOn(store, "claim");

      expect(() => createLiquidityTankIntent(hostile)).toThrow();
      // The representation, not the content, is refused: the same data could
      // already hold a lock, so this is never a settlement failure.
      await expect(advanceLiquidityTankSettlement(runner({
        authority: hostile,
        store,
        adapter: h.adapter,
      }).shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank authority is not stable canonical JSON",
      });
      expect(touched).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    },
  );
});

describe("advanceLiquidityTankSettlement", () => {
  test("persists, broadcasts and accepts completed only with both transaction hashes", async () => {
    const h = harness();
    h.setAfterBroadcast(completed(h.operationHash));
    const result = await advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared);
    expect(result).toEqual({
      status: "settled",
      settlement: {
        txRef: {
          kind: "liquidity-tank",
          bridgeId: BRIDGE_ID,
          sourceChainId: 11_155_111,
          destChainId: 80_002,
          lockTxHash: "source-lock-tx",
          releaseTxHash: "destination-release-tx",
          recoveryDeadline: RECOVERY_DEADLINE_MS,
        },
        paymentAmount: { amount: "1.25", currency: "USDC" },
        settlementFinality: { model: "liquidity-tank", finalityObservedAt: 3_000 },
        authenticationHash: AUTH_HASH,
      },
    });
    expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
  });

  test("records the complete signed submission before broadcast", async () => {
    const events: string[] = [];
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const store: LiquidityTankStore = {
      ...inner,
      async recordSubmission(input) {
        events.push("persist");
        return inner.recordSubmission(input);
      },
    };
    const h = harness();
    const broadcast = h.adapter.broadcastRetained;
    h.adapter.broadcastRetained = vi.fn(async (...args) => {
      events.push("broadcast");
      return broadcast(...args);
    });
    await advanceLiquidityTankSettlement(runner({ adapter: h.adapter, store }).shared);
    expect(events).toEqual(["persist", "broadcast"]);
  });

  test("takeover replays settlement from a durable completed observation before adapter effects", async () => {
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordObservation = vi.spyOn(store, "recordObservation");
    const baseRecordSettlement = store.recordSettlement.bind(store);
    let settlementAttempts = 0;
    const recordSettlement = vi.fn<LiquidityTankStore["recordSettlement"]>(async (input) => {
      settlementAttempts += 1;
      if (settlementAttempts === 1) throw new Error("simulated crash before settlement write");
      await baseRecordSettlement(input);
      return { status: "existing" };
    });
    store.recordSettlement = recordSettlement;
    const h = harness();
    h.setAfterBroadcast(completed(h.operationHash));
    const run = runner({ store, adapter: h.adapter });

    await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-settlement-persistence-uncertain",
    });
    expect(recordObservation).toHaveBeenLastCalledWith(expect.objectContaining({
      observation: expect.objectContaining({ status: "completed" }),
    }));

    recordObservation.mockClear();
    recordSettlement.mockClear();
    h.prepareSubmission.mockClear();
    h.observe.mockClear();
    h.broadcastRetained.mockClear();
    h.setObservation({ status: "indeterminate", reason: "status API unavailable" });

    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settled",
    });
    expect(recordSettlement).toHaveBeenCalledTimes(1);
    expect(recordSettlement).toHaveBeenCalledWith(expect.objectContaining({
      settlement: expect.objectContaining({
        txRef: expect.objectContaining({ recoveryDeadline: RECOVERY_DEADLINE_MS }),
      }),
    }));
    expect(recordObservation).not.toHaveBeenCalled();
    expect(h.prepareSubmission).not.toHaveBeenCalled();
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test.each(["conflict", "corrupt"] as const)(
    "durable completed replay maps settlement %s to indeterminate without adapter effects",
    async (status) => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      store.recordSettlement = vi.fn<LiquidityTankStore["recordSettlement"]>(async () => {
        throw new Error("simulated crash before settlement write");
      });
      const h = harness();
      h.setAfterBroadcast(completed(h.operationHash));
      const run = runner({ store, adapter: h.adapter });
      await advanceLiquidityTankSettlement(run.shared);

      store.recordSettlement = vi.fn<LiquidityTankStore["recordSettlement"]>(
        async () => ({ status, reason: `simulated-${status}` }),
      );
      h.prepareSubmission.mockClear();
      h.observe.mockClear();
      h.broadcastRetained.mockClear();

      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-settlement-persistence-uncertain",
      });
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    },
  );

  test.each(["accessor", "proxy"] as const)(
    "rejects a prepared-submission %s before persistence and safely retries",
    async (kind) => {
      const touched = vi.fn();
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordSubmission = vi.spyOn(store, "recordSubmission");
      let attempts = 0;
      h.adapter.prepareSubmission = vi.fn(async (intent) => {
        attempts += 1;
        const prepared = {
          submissionVersion: "1" as const,
          authorityHash: intent.bindingHash,
          operationHash: intent.operationHash,
          bridgeId: BRIDGE_ID,
          substrateTxHash: "demos-native-bridge-tx",
          signedSubmissionBase64: Buffer.from("signed-native-bridge").toString("base64"),
          preparedAt: 900,
        };
        if (attempts > 1) return prepared;
        if (kind === "accessor") {
          Object.defineProperty(prepared, "authorityHash", {
            enumerable: true,
            configurable: true,
            get() {
              touched();
              return touched.mock.calls.length === 1 ? intent.bindingHash : RAIL_HASH;
            },
          });
          return prepared;
        }
        return unreadableProxy(prepared, touched);
      });
      const run = runner({ store, adapter: h.adapter });

      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-submission-preparation-unavailable",
      });
      expect(touched).not.toHaveBeenCalled();
      expect(recordSubmission).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();

      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-status-transition-unresolved",
      });
      expect(h.adapter.prepareSubmission).toHaveBeenCalledTimes(2);
      expect(recordSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["accessor", "proxy"] as const)(
    "rejects an observation %s before observation effects and reuses retained submission",
    async (kind) => {
      const touched = vi.fn();
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordObservation = vi.spyOn(store, "recordObservation");
      let attempts = 0;
      const observe = vi.fn<LiquidityTankAdapter["observe"]>(async () => {
        attempts += 1;
        if (attempts > 1) return pending(h.operationHash);
        const observed = empty(h.operationHash);
        if (kind === "accessor") {
          Object.defineProperty(observed, "status", {
            enumerable: true,
            configurable: true,
            get() {
              touched();
              return touched.mock.calls.length === 1 ? "empty" : "completed";
            },
          });
          return observed;
        }
        return unreadableProxy(observed, touched);
      });
      h.adapter.observe = observe;
      const run = runner({ store, adapter: h.adapter });

      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-status-unavailable",
      });
      expect(touched).not.toHaveBeenCalled();
      expect(recordObservation).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();

      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
        status: "waiting",
        reason: "liquidity-tank-pending",
        pendingDeadline: expect.any(Number),
        pastDeadline: false,
      });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(recordObservation).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    },
  );

  test("accepts read-only observations with explicit undefined optional fields", async () => {
    const h = harness();
    h.adapter.observe = vi.fn(async () => Object.freeze(pending(h.operationHash)));

    await expect(advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared))
      .resolves.toEqual({
        status: "waiting", reason: "liquidity-tank-pending", pendingDeadline: expect.any(Number), pastDeadline: false,
      });
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("rejects an unknown authenticated status before history persistence or broadcast", async () => {
    const h = harness();
    h.adapter.observe = vi.fn(async () => ({
      status: "bogus",
      bridgeId: BRIDGE_ID,
      operationHash: h.operationHash,
      history: ["empty", "failed"],
      observedAt: 2_000,
      authenticationHash: AUTH_HASH,
      reason: "invented status",
    }) as never);
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordObservation = vi.spyOn(store, "recordObservation");

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-status-unavailable",
      });
    expect(recordObservation).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("ambiguous broadcast reuses the exact retained transaction", async () => {
    const h = harness();
    h.failNextBroadcast();
    const run = runner({ adapter: h.adapter });
    await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-broadcast-outcome-uncertain",
    });
    h.setAfterBroadcast(pending(h.operationHash));
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "liquidity-tank-pending",
      pendingDeadline: expect.any(Number),
      pastDeadline: false,
    });
    expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(2);
    const wires = h.broadcastRetained.mock.calls.map((call) => call[0].signedSubmissionBase64);
    expect(new Set(wires).size).toBe(1);
  });

  test.each([
    ["null", null],
    ["false", false],
    ["empty string", ""],
    ["undefined", undefined],
  ] as const)(
    "a present %s retained submission is corrupt before any effects",
    async (_label, malformedSubmission) => {
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const store: LiquidityTankStore = {
        ...inner,
        claim: vi.fn(async (input) => ({
          status: "acquired",
          intent: input.intent,
          lease: {
            owner: input.owner,
            generation: 1,
            expiresAt: input.now + input.leaseDurationMs,
          },
          submission: malformedSubmission,
        }) as never),
      };
      const isCurrent = vi.spyOn(store, "isCurrent");
      const recordSubmission = vi.spyOn(store, "recordSubmission");
      const recordObservation = vi.spyOn(store, "recordObservation");
      const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
      const recordSettlement = vi.spyOn(store, "recordSettlement");
      const h = harness();

      await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
        .resolves.toEqual({
          status: "indeterminate",
          reason: "liquidity-tank-retained-state-corrupt",
        });
      expect(isCurrent).not.toHaveBeenCalled();
      expect(recordSubmission).not.toHaveBeenCalled();
      expect(recordObservation).not.toHaveBeenCalled();
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
      expect(recordSettlement).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["null", null],
    ["false", false],
    ["empty string", ""],
    ["undefined", undefined],
  ] as const)(
    "a present %s retained observation is corrupt before any effects",
    async (_label, malformedObservation) => {
      let retainedSubmission:
        | Parameters<LiquidityTankStore["recordSubmission"]>[0]["submission"]
        | undefined;
      let retainedReceipt = 0;
      let exposeMalformedObservation = false;
      let generation = 0;
      const claim = vi.fn<LiquidityTankStore["claim"]>(async (input) => {
        generation += 1;
        return {
          status: "acquired",
          intent: input.intent,
          lease: {
            owner: input.owner,
            generation,
            expiresAt: input.now + input.leaseDurationMs,
          },
          ...(retainedSubmission === undefined
            ? {}
            : { submission: retainedSubmission, submissionRecordedAt: retainedReceipt }),
          ...(exposeMalformedObservation ? { observation: malformedObservation } : {}),
        } as never;
      });
      const store: LiquidityTankStore = {
        restartSafety: "volatile-acknowledged",
        claim,
        isCurrent: vi.fn<LiquidityTankStore["isCurrent"]>(async () => true),
        recordSubmission: vi.fn<LiquidityTankStore["recordSubmission"]>(async (input) => {
          retainedSubmission = input.submission;
          retainedReceipt = input.now;
          return { status: "recorded" };
        }),
        recordObservation: vi.fn<LiquidityTankStore["recordObservation"]>(
          async () => ({ status: "recorded" }),
        ),
        recordRecoveryFailure: vi.fn<LiquidityTankStore["recordRecoveryFailure"]>(
          async (input) => ({ status: "recorded", recoveryFailure: input.recoveryFailure }),
        ),
        recordRecoveryExpired: vi.fn<LiquidityTankStore["recordRecoveryExpired"]>(
          async () => ({ status: "recorded" }),
        ),
        recordSettlement: vi.fn<LiquidityTankStore["recordSettlement"]>(
          async () => ({ status: "recorded" }),
        ),
      };
      const h = harness({ status: "indeterminate", reason: "status API unavailable" });
      const run = runner({ store, adapter: h.adapter });
      await advanceLiquidityTankSettlement(run.shared);
      expect(retainedSubmission).toBeDefined();

      exposeMalformedObservation = true;
      vi.mocked(store.isCurrent).mockClear();
      vi.mocked(store.recordSubmission).mockClear();
      vi.mocked(store.recordObservation).mockClear();
      vi.mocked(store.recordRecoveryFailure).mockClear();
      vi.mocked(store.recordRecoveryExpired).mockClear();
      vi.mocked(store.recordSettlement).mockClear();
      h.prepareSubmission.mockClear();
      h.observe.mockClear();
      h.broadcastRetained.mockClear();

      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-retained-state-corrupt",
      });
      expect(store.isCurrent).not.toHaveBeenCalled();
      expect(store.recordSubmission).not.toHaveBeenCalled();
      expect(store.recordObservation).not.toHaveBeenCalled();
      expect(store.recordRecoveryFailure).not.toHaveBeenCalled();
      expect(store.recordRecoveryExpired).not.toHaveBeenCalled();
      expect(store.recordSettlement).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    },
  );

  test("truly absent retained fields take the fresh preparation path", async () => {
    const store: LiquidityTankStore = {
      restartSafety: "volatile-acknowledged",
      claim: vi.fn<LiquidityTankStore["claim"]>(async (input) => ({
        status: "acquired",
        intent: input.intent,
        lease: {
          owner: input.owner,
          generation: 1,
          expiresAt: input.now + input.leaseDurationMs,
        },
      })),
      isCurrent: vi.fn<LiquidityTankStore["isCurrent"]>(async () => true),
      recordSubmission: vi.fn<LiquidityTankStore["recordSubmission"]>(
        async () => ({ status: "recorded" }),
      ),
      recordObservation: vi.fn<LiquidityTankStore["recordObservation"]>(
        async () => ({ status: "recorded" }),
      ),
      recordRecoveryFailure: vi.fn<LiquidityTankStore["recordRecoveryFailure"]>(
        async (input) => ({ status: "recorded", recoveryFailure: input.recoveryFailure }),
      ),
      recordRecoveryExpired: vi.fn<LiquidityTankStore["recordRecoveryExpired"]>(
        async () => ({ status: "recorded" }),
      ),
      recordSettlement: vi.fn<LiquidityTankStore["recordSettlement"]>(
        async () => ({ status: "recorded" }),
      ),
    };
    const recordSubmission = vi.spyOn(store, "recordSubmission");
    const h = harness({ status: "indeterminate", reason: "status API unavailable" });

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-adapter-indeterminate: status API unavailable",
      });
    expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
    expect(recordSubmission).toHaveBeenCalledTimes(1);
    expect(h.observe).toHaveBeenCalledTimes(1);
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("corrupt retained submission is indeterminate and exact restoration resumes without preparation", async () => {
    const intent = createLiquidityTankIntent(authority());
    let retainedSubmission: Parameters<LiquidityTankStore["recordSubmission"]>[0]["submission"]
      | undefined;
    let retainedReceipt = 0;
    let corruption: "hash" | "bytes" | undefined;
    let claimGeneration = 0;
    const claim = vi.fn<LiquidityTankStore["claim"]>(async (input) => {
      claimGeneration += 1;
      const submission = retainedSubmission === undefined
        ? undefined
        : corruption === "hash"
          ? { ...retainedSubmission, submissionHash: "f".repeat(64) }
          : corruption === "bytes"
            ? {
                ...retainedSubmission,
                signedSubmissionBase64: Buffer.from("corrupted-retained-bytes").toString("base64"),
              }
            : retainedSubmission;
      return {
        status: "acquired",
        intent: input.intent,
        lease: {
          owner: input.owner,
          generation: claimGeneration,
          expiresAt: input.now + input.leaseDurationMs,
        },
        ...(submission === undefined ? {} : { submission, submissionRecordedAt: retainedReceipt }),
      };
    });
    const store: LiquidityTankStore = {
      restartSafety: "volatile-acknowledged",
      claim,
      isCurrent: vi.fn<LiquidityTankStore["isCurrent"]>(async () => true),
      recordSubmission: vi.fn<LiquidityTankStore["recordSubmission"]>(async (input) => {
        retainedSubmission = input.submission;
        retainedReceipt = input.now;
        return { status: "recorded" };
      }),
      recordObservation: vi.fn<LiquidityTankStore["recordObservation"]>(
        async () => ({ status: "recorded" }),
      ),
      recordRecoveryFailure: vi.fn<LiquidityTankStore["recordRecoveryFailure"]>(
        async (input) => ({ status: "recorded", recoveryFailure: input.recoveryFailure }),
      ),
      recordRecoveryExpired: vi.fn<LiquidityTankStore["recordRecoveryExpired"]>(
        async () => ({ status: "recorded" }),
      ),
      recordSettlement: vi.fn<LiquidityTankStore["recordSettlement"]>(
        async () => ({ status: "recorded" }),
      ),
    };
    const h = harness({ status: "indeterminate", reason: "status API unavailable" });
    const run = runner({ store, adapter: h.adapter });

    await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-adapter-indeterminate: status API unavailable",
    });
    expect(retainedSubmission).toBeDefined();
    expect(h.prepareSubmission).toHaveBeenCalledTimes(1);

    for (const variant of ["hash", "bytes"] as const) {
      corruption = variant;
      vi.mocked(store.isCurrent).mockClear();
      vi.mocked(store.recordSubmission).mockClear();
      vi.mocked(store.recordObservation).mockClear();
      vi.mocked(store.recordSettlement).mockClear();
      h.prepareSubmission.mockClear();
      h.observe.mockClear();
      h.broadcastRetained.mockClear();

      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-retained-state-corrupt",
      });
      expect(store.isCurrent).not.toHaveBeenCalled();
      expect(store.recordSubmission).not.toHaveBeenCalled();
      expect(store.recordObservation).not.toHaveBeenCalled();
      expect(store.recordSettlement).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    }

    corruption = undefined;
    h.setObservation(completed(intent.operationHash));
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settled",
    });
    expect(h.prepareSubmission).not.toHaveBeenCalled();
    expect(h.observe).toHaveBeenCalledTimes(1);
    expect(h.broadcastRetained).not.toHaveBeenCalled();
    expect(store.recordSubmission).not.toHaveBeenCalled();
    expect(store.recordObservation).toHaveBeenCalledTimes(1);
    expect(store.recordSettlement).toHaveBeenCalledTimes(1);
  });

  test("capacity exhaustion stays on the pinned tank mechanism", async () => {
    const h = harness({
      status: "capacity-unavailable",
      bridgeId: BRIDGE_ID,
      operationHash: createLiquidityTankIntent(authority()).operationHash,
      history: ["empty"],
      observedAt: 1_000,
      authenticationHash: AUTH_HASH,
      reason: "destination tank insufficient",
    });
    await expect(advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared)).resolves.toEqual({
      status: "waiting",
      reason: "liquidity-tank-capacity-unavailable",
    });
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("capacity recovery later submits the same pinned tank operation", async () => {
    const h = harness({
      status: "capacity-unavailable",
      bridgeId: BRIDGE_ID,
      operationHash: createLiquidityTankIntent(authority()).operationHash,
      history: ["empty"],
      observedAt: 1_000,
      authenticationHash: AUTH_HASH,
      reason: "destination tank insufficient",
    });
    const run = runner({ adapter: h.adapter });
    await advanceLiquidityTankSettlement(run.shared);
    h.setObservation(empty(h.operationHash));
    h.setAfterBroadcast(pending(h.operationHash));
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "liquidity-tank-pending",
      pendingDeadline: expect.any(Number),
      pastDeadline: false,
    });
    expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
  });

  test("pending without a committed lock is ordinary substrate waiting", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash));
    await expect(advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared)).resolves.toEqual({
      status: "waiting",
      reason: "liquidity-tank-pending",
      pendingDeadline: expect.any(Number),
      pastDeadline: false,
    });
  });

  test("a committed source lock enters machine-readable ST-8 recovery", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const result = await advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared);
    expect(result).toEqual({
      status: "settle-asymmetric",
      reason: "tank-locked-unreleased",
      recoveryDeadline: RECOVERY_DEADLINE_MS,
      pastDeadline: false,
      txRef: {
        kind: "liquidity-tank",
        bridgeId: BRIDGE_ID,
        sourceChainId: 11_155_111,
        destChainId: 80_002,
        lockTxHash: "source-lock-tx",
        recoveryDeadline: RECOVERY_DEADLINE_MS,
      },
    });
  });

  test("a Unix-millisecond recovery deadline remains open at deadline minus one", async () => {
    const h = harness();
    h.setPreparedAt(RECOVERY_DEADLINE_MS - 1);
    h.setAfterBroadcast(pending(h.operationHash, true, RECOVERY_DEADLINE_MS, RECOVERY_DEADLINE_MS - 1));
    const run = runner({ adapter: h.adapter });
    run.setClock(RECOVERY_DEADLINE_MS - 1);

    await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
      status: "settle-asymmetric",
      recoveryDeadline: RECOVERY_DEADLINE_MS,
      txRef: { recoveryDeadline: RECOVERY_DEADLINE_MS },
    });
  });

  test("a completed observation without a durable pending checkpoint settles before its deadline", async () => {
    const h = harness(completed(
      createLiquidityTankIntent(authority()).operationHash,
      RECOVERY_DEADLINE_MS - 1,
    ));
    h.setPreparedAt(RECOVERY_DEADLINE_MS - 1);
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    run.setClock(RECOVERY_DEADLINE_MS - 1);

    await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
      status: "settled",
      settlement: { txRef: { recoveryDeadline: RECOVERY_DEADLINE_MS } },
    });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([
    ["a millisecond after", RECOVERY_DEADLINE_MS + 1],
    ["a second after", RECOVERY_DEADLINE_MS + 1_000],
  ] as const)(
    "a direct completion finalized %s the deadline after ambiguous broadcast expires durably",
    async (_label, finalityObservedAt) => {
      const h = harness();
      h.failNextBroadcast();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordObservation = vi.spyOn(store, "recordObservation");
      const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
      const recordSettlement = vi.spyOn(store, "recordSettlement");
      const run = runner({ adapter: h.adapter, store });

      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-broadcast-outcome-uncertain",
      });
      recordObservation.mockClear();
      recordRecoveryExpired.mockClear();
      recordSettlement.mockClear();
      h.prepareSubmission.mockClear();
      h.observe.mockClear();
      h.broadcastRetained.mockClear();

      run.setClock(finalityObservedAt);
      h.setObservation(completed(h.operationHash, finalityObservedAt));
      await expect(advanceLiquidityTankSettlement({
        ...run.shared,
        owner: `direct-expiry-${_label}`,
      })).resolves.toEqual(releasedLate(finalityObservedAt));
      expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);
      expect(recordRecoveryExpired).toHaveBeenCalledWith(expect.objectContaining({
        expectedObservation: expect.objectContaining({ status: "empty" }),
        observation: expect.objectContaining({
          status: "completed",
          recoveryDeadline: RECOVERY_DEADLINE_MS,
        }),
      }));
      expect(recordObservation).not.toHaveBeenCalled();
      expect(recordSettlement).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();

      recordRecoveryExpired.mockClear();
      h.prepareSubmission.mockClear();
      h.observe.mockClear();
      await expect(advanceLiquidityTankSettlement({
        ...run.shared,
        owner: `direct-expiry-retry-${_label}`,
      })).resolves.toEqual(releasedLate(finalityObservedAt));
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
    },
  );

  test("durable locked state expires durably one Unix millisecond after the deadline, not at it", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const recordObservation = vi.spyOn(store, "recordObservation");
    const recordSettlement = vi.spyOn(store, "recordSettlement");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    // At the deadline a release is still timely: the lock stays open.
    run.setClock(RECOVERY_DEADLINE_MS);
    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS));
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "deadline-worker" })).resolves.toMatchObject({
      status: "settle-asymmetric", reason: "tank-locked-unreleased", pastDeadline: false,
    });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
    // After the deadline lease expires, the bridge still authenticates the same locked pending status.
    run.setClock(RECOVERY_DEADLINE_MS + 101);
    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS + 101));
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "recovery-worker" })).resolves.toEqual({
      status: "failed",
      errorClass: "failed-substrate",
      reason: "tank-locked-unreleased-recovery-expired",
      reputationNeutral: true,
      lockTxRef: lockTxRef(),
    });
    expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);

    recordRecoveryExpired.mockClear();
    recordObservation.mockClear();
    recordSettlement.mockClear();
    h.prepareSubmission.mockClear();
    h.observe.mockClear();
    h.broadcastRetained.mockClear();
    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));

    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
    expect(recordObservation).not.toHaveBeenCalled();
    expect(recordSettlement).not.toHaveBeenCalled();
    expect(h.prepareSubmission).not.toHaveBeenCalled();
    expect(h.observe).toHaveBeenCalledTimes(1);
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("an unavailable status at the deadline keeps the lock open for a timely completion", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS);
    h.setObservation({ status: "indeterminate", reason: "status API unavailable" });

    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "unavailable-worker" }))
      .resolves.toMatchObject({
        status: "settle-asymmetric",
        reason: "tank-locked-unreleased",
        recoveryDeadline: RECOVERY_DEADLINE_MS,
      });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();

    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settled",
      settlement: { settlementFinality: { finalityObservedAt: RECOVERY_DEADLINE_MS - 1 } },
    });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
  });

  test.each([
    ["the retained checkpoint", 2_000],
    ["a newer snapshot", RECOVERY_DEADLINE_MS - 1],
    ["a snapshot at the deadline", RECOVERY_DEADLINE_MS],
  ] as const)(
    "a stale pending snapshot (%s) read after the deadline stays locked for a timely completion",
    async (_label, observedAt) => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
      const run = runner({ adapter: h.adapter, store });
      await advanceLiquidityTankSettlement(run.shared);

      // A caching adapter serves a pre-deadline snapshot to a post-deadline request.
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      h.setObservation(lockedPendingAt(h.operationHash, observedAt));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "cached-read-worker" }))
        .resolves.toEqual({
          status: "settle-asymmetric",
          reason: "tank-locked-unreleased",
          recoveryDeadline: RECOVERY_DEADLINE_MS,
          pastDeadline: true,
          txRef: {
            kind: "liquidity-tank",
            bridgeId: BRIDGE_ID,
            sourceChainId: 11_155_111,
            destChainId: 80_002,
            lockTxHash: "source-lock-tx",
            recoveryDeadline: RECOVERY_DEADLINE_MS,
          },
        });
      expect(recordRecoveryExpired).not.toHaveBeenCalled();

      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        status: "settled",
        settlement: { settlementFinality: { finalityObservedAt: RECOVERY_DEADLINE_MS - 1 } },
      });
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["a millisecond after", RECOVERY_DEADLINE_MS + 1],
    ["a second after", RECOVERY_DEADLINE_MS + 1_000],
  ] as const)("a locked pending observed %s the deadline expires", async (_label, observedAt) => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(observedAt);
    h.setObservation(lockedPendingAt(h.operationHash, observedAt));

    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "fresh-read-worker" }))
      .resolves.toEqual({
        status: "failed",
        errorClass: "failed-substrate",
        reason: "tank-locked-unreleased-recovery-expired",
        reputationNeutral: true,
        lockTxRef: lockTxRef(),
      });
    expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);
    expect(recordRecoveryExpired).toHaveBeenCalledWith(expect.objectContaining({
      observation: lockedPendingAt(h.operationHash, observedAt),
    }));
  });

  test("reference store and claim replay both re-check pending evidence time", async () => {
    const intent = createLiquidityTankIntent(authority());
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    let retainedSubmission: Parameters<LiquidityTankStore["recordSubmission"]>[0]["submission"]
      | undefined;
    let retainedReceipt = 0;
    const recordSubmission = store.recordSubmission.bind(store);
    store.recordSubmission = async (input) => {
      retainedSubmission = input.submission;
      retainedReceipt = input.now;
      return recordSubmission(input);
    };
    await advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared);
    const claim = await store.claim({
      intent,
      owner: "stale-evidence-writer",
      now: RECOVERY_DEADLINE_MS + 1,
      leaseDurationMs: 100,
    });
    if (claim.status !== "acquired" || claim.observation?.status !== "pending") {
      throw new Error("expected an acquired locked recovery checkpoint");
    }
    const stale = claim.observation as Extract<LiquidityTankRecoveryEvidence, { status: "pending" }>;
    await expect(store.recordRecoveryExpired({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner: claim.lease.owner,
      generation: claim.lease.generation,
      now: RECOVERY_DEADLINE_MS + 1,
      expectedObservation: stale,
      observation: stale,
    })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });

    const replay = (observation: LiquidityTankRecoveryEvidence): LiquidityTankStore => ({
      ...createInMemoryLiquidityTankStore(VOLATILE),
      claim: async (input) => ({
        status: "recovery-expired",
        intent: input.intent,
        submission: retainedSubmission!,
        submissionRecordedAt: retainedReceipt,
        observation,
      }),
    });
    const checkpoint = pending(intent.operationHash, true) as
      Extract<LiquidityTankRecoveryEvidence, { status: "pending" }>;
    for (const observation of [
      stale,
      {
        status: "failed-after-lock",
        checkpoint,
        failure: { ...failedAfterLock(intent.operationHash, RECOVERY_DEADLINE_MS - 1), lockTxHash: "wrong-lock" },
      },
      {
        status: "failed-after-lock",
        checkpoint,
        failure: { ...failedAfterLock(intent.operationHash, RECOVERY_DEADLINE_MS), history: ["empty", "completed", "failed"] },
      },
    ] as LiquidityTankRecoveryEvidence[]) {
      await expect(advanceLiquidityTankSettlement(runner({
        store: replay(observation),
        adapter: h.adapter,
      }).shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-retained-state-corrupt",
      });
    }
    for (const observation of [
      lockedPendingAt(intent.operationHash, RECOVERY_DEADLINE_MS + 1),
      {
        status: "failed-after-lock",
        checkpoint,
        failure: failedAfterLock(intent.operationHash, RECOVERY_DEADLINE_MS + 1),
      },
    ] as LiquidityTankRecoveryEvidence[]) {
      const run = runner({ store: replay(observation), adapter: h.adapter });
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
        status: "failed",
        errorClass: "failed-substrate",
        reputationNeutral: true,
      });
    }
    // Post-deadline bridge evidence still needs a post-deadline host clock.
    const early = runner({ store: replay({
      status: "failed-after-lock",
      checkpoint,
      failure: failedAfterLock(intent.operationHash, RECOVERY_DEADLINE_MS + 1),
    } as LiquidityTankRecoveryEvidence), adapter: h.adapter });
    early.setClock(RECOVERY_DEADLINE_MS - 1);
    await expect(advanceLiquidityTankSettlement(early.shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-recovery-expiry-not-due",
    });
  });

  test("a timely completion whose write fails after the deadline does not commit expiry", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    const baseRecordObservation = store.recordObservation.bind(store);
    store.recordObservation = vi.fn<LiquidityTankStore["recordObservation"]>(async () => {
      throw new Error("simulated observation write failure");
    });
    run.setClock(RECOVERY_DEADLINE_MS + 1);
    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));

    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "write-loss-worker" }))
      .resolves.toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();

    store.recordObservation = baseRecordObservation;
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settled",
    });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
  });

  test("a failure for another lock contradicts the lock, and expires it apart once a read after the deadline reports it", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    h.setObservation({ ...failedAfterLock(h.operationHash, 3_000), lockTxHash: "wrong-lock" });
    run.setClock(RECOVERY_DEADLINE_MS - 200);
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "before-deadline" }))
      .resolves.toMatchObject({
        status: "settle-asymmetric",
        reason: "tank-locked-unreleased",
        pastDeadline: false,
        bridgeStatus: "conflicting",
      });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();

    // Unlike a failure of the lock itself, a contradiction needs the bridge's
    // time: one stamped before the deadline leaves the lock open past host D.
    run.setClock(RECOVERY_DEADLINE_MS + 1);
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "stale-worker" }))
      .resolves.toMatchObject({
        status: "settle-asymmetric",
        reason: "lock-contradicted",
        pastDeadline: true,
        bridgeStatus: "conflicting",
      });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
    // Stamped at the deadline itself, the lock may still be released in time.
    h.setObservation({ ...failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS), lockTxHash: "wrong-lock" });
    run.setClock(RECOVERY_DEADLINE_MS + 101);
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "deadline-read-worker" }))
      .resolves.toMatchObject({ status: "settle-asymmetric", reason: "lock-contradicted", pastDeadline: true });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
    h.setObservation({ ...failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS + 1), lockTxHash: "wrong-lock" });
    run.setClock(RECOVERY_DEADLINE_MS + 202);
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "conflict-worker" }))
      .resolves.toEqual(CONTRADICTED_EXPIRY);
    expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);
    expect(recordRecoveryExpired.mock.calls[0]![0].observation).toMatchObject({
      status: "contradicted-after-lock",
      checkpoint: { lockTxHash: "source-lock-tx" },
      contradiction: { status: "failed", lockTxHash: "wrong-lock" },
    });
  });

  test("a pending status observed before the deadline does not commit expiry when it arrives after it", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS - 1);
    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS - 1));
    const adapter: LiquidityTankAdapter = {
      ...h.adapter,
      observe: async (...args) => {
        const observed = await h.observe(...args);
        run.setClock(RECOVERY_DEADLINE_MS + 1);
        return observed;
      },
    };

    await expect(advanceLiquidityTankSettlement({
      ...run.shared,
      adapter,
      owner: "straddling-worker",
    })).resolves.toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();

    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS + 1));
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "failed",
      errorClass: "failed-substrate",
      reason: "tank-locked-unreleased-recovery-expired",
    });
    expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);
  });

  test("durable locked state expires after the Unix-millisecond deadline", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS + 1);
    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS + 1));

    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "late-recovery-worker" }))
      .resolves.toMatchObject({
        status: "failed",
        errorClass: "failed-substrate",
      });
    expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);
  });

  test("does not report recovery expiry until the checkpoint CAS is durable", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const baseRecordRecoveryExpired = store.recordRecoveryExpired.bind(store);
    store.recordRecoveryExpired = vi.fn<LiquidityTankStore["recordRecoveryExpired"]>(
      async () => ({ status: "conflict", reason: "simulated-cas-loss" }),
    );
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS + 1);
    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS + 1));

    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "expiry-cas-worker" }))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-recovery-expiry-persistence-uncertain",
      });

    store.recordRecoveryExpired = baseRecordRecoveryExpired;
    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settled",
    });
  });

  test("a post-deadline checkpoint whose expiry write was lost still expires only on fresh evidence", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const baseRecordRecoveryExpired = store.recordRecoveryExpired.bind(store);
    const baseRecordObservation = store.recordObservation.bind(store);
    store.recordRecoveryExpired = vi.fn<LiquidityTankStore["recordRecoveryExpired"]>(
      async () => ({ status: "conflict", reason: "simulated-cas-loss" }),
    );
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS + 1);
    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS + 1));
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "lost-expiry-worker" }))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-recovery-expiry-persistence-uncertain",
      });
    store.recordRecoveryExpired = vi.fn(baseRecordRecoveryExpired);

    // The durable checkpoint is now post-deadline evidence, but neither an
    // unavailable status nor a failed write of a timely completion expires it.
    h.setObservation({ status: "indeterminate", reason: "status API unavailable" });
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      pastDeadline: true,
    });
    store.recordObservation = vi.fn<LiquidityTankStore["recordObservation"]>(async () => {
      throw new Error("simulated observation write failure");
    });
    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      pastDeadline: true,
    });
    expect(store.recordRecoveryExpired).not.toHaveBeenCalled();

    store.recordObservation = baseRecordObservation;
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settled",
    });
    expect(store.recordRecoveryExpired).not.toHaveBeenCalled();
  });

  test("does not reinterpret a seconds-scale deadline as Unix milliseconds", async () => {
    const h = harness();
    // Prepared at the host clock, as the adapter must: the seconds-scale
    // deadline falls before it and is refused, neither converted nor expired.
    h.setPreparedAt(RECOVERY_DEADLINE_MS - 1);
    const secondsScale = RECOVERY_DEADLINE_MS / 1_000;
    h.setAfterBroadcast(pending(h.operationHash, true, secondsScale, RECOVERY_DEADLINE_MS - 1));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    run.setClock(RECOVERY_DEADLINE_MS - 1);

    await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-recovery-deadline-before-preparation",
    });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
  });

  test("locked-unreleased resolves forward to success when release lands", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const run = runner({ adapter: h.adapter });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS - 1);
    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "release-worker" }))
      .resolves.toMatchObject({ status: "settled" });
    expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["a millisecond after", RECOVERY_DEADLINE_MS + 1],
    ["a second after", RECOVERY_DEADLINE_MS + 1_000],
  ] as const)("a completion finalized %s the recovery deadline loses to durable expiry", async (
    _label,
    finalityObservedAt,
  ) => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordSettlement = vi.spyOn(store, "recordSettlement");
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(finalityObservedAt);
    h.setObservation(completed(h.operationHash, finalityObservedAt));

    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "late-release-worker" }))
      .resolves.toEqual(releasedLate(finalityObservedAt));
    expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);
    expect(recordSettlement).not.toHaveBeenCalled();
  });

  test("a later failed status cannot erase a durable locked-unreleased checkpoint", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const run = runner({ adapter: h.adapter });
    await advanceLiquidityTankSettlement(run.shared);
    h.setObservation({
      status: "failed",
      bridgeId: BRIDGE_ID,
      operationHash: h.operationHash,
      history: ["empty", "pending", "failed"],
      observedAt: 3_000,
      authenticationHash: AUTH_HASH,
      reason: "conflicting terminal report",
      lockTxHash: "source-lock-tx",
      recoveryDeadline: RECOVERY_DEADLINE_MS,
    });
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      reason: "tank-locked-unreleased",
      pastDeadline: false,
      bridgeStatus: "failed",
    });
  });

  test("a failure after the lock is retained before the deadline and expires across a restart", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordObservation = vi.spyOn(store, "recordObservation");
    const recordRecoveryFailure = vi.spyOn(store, "recordRecoveryFailure");
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const recordSettlement = vi.spyOn(store, "recordSettlement");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    recordObservation.mockClear();

    // Before the deadline the failure is reported but the lock stays open.
    run.setClock(RECOVERY_DEADLINE_MS - 200);
    h.setObservation(failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS - 200));
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "worker-before" }))
      .resolves.toMatchObject({
        status: "settle-asymmetric",
        reason: "tank-locked-unreleased",
        pastDeadline: false,
        bridgeStatus: "failed",
        txRef: { lockTxHash: "source-lock-tx", recoveryDeadline: RECOVERY_DEADLINE_MS },
      });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
    expect(recordObservation).not.toHaveBeenCalled();
    expect(recordRecoveryFailure).toHaveBeenCalledTimes(1);
    expect(recordRecoveryFailure).toHaveBeenCalledWith(expect.objectContaining({
      recoveryFailure: expect.objectContaining({ status: "failed-after-lock" }),
    }));

    // A new worker after a restart reads the failure just past the deadline.
    run.setClock(RECOVERY_DEADLINE_MS + 1);
    h.setObservation(failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS + 1));
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "worker-after-restart" }))
      .resolves.toEqual({
        status: "failed",
        errorClass: "failed-substrate",
        reason: "tank-locked-unreleased-recovery-expired",
        reputationNeutral: true,
        lockTxRef: lockTxRef(),
      });
    expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);
    expect(recordRecoveryExpired).toHaveBeenCalledWith(expect.objectContaining({
      expectedObservation: expect.objectContaining({ status: "pending", observedAt: 2_000 }),
      observation: {
        status: "failed-after-lock",
        checkpoint: pending(h.operationHash, true),
        failure: failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS + 1),
      },
    }));
    expect(recordObservation).not.toHaveBeenCalled();
    expect(recordRecoveryFailure).toHaveBeenCalledTimes(1);

    // A delayed timely completion corrects the expiry durably.
    recordRecoveryExpired.mockClear();
    h.observe.mockClear();
    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    expect(h.observe).toHaveBeenCalledTimes(1);
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
    expect(recordSettlement).not.toHaveBeenCalled();
    await expect(store.claim({
      intent: createLiquidityTankIntent(authority()),
      owner: "expiry-inspector",
      now: RECOVERY_DEADLINE_MS + 1_000,
      leaseDurationMs: 100,
    })).resolves.toMatchObject({
      status: "settled",
    });
  });

  test.each([
    ["empty", (operationHash: string, observedAt: number): LiquidityTankObservation => ({
      status: "empty",
      bridgeId: BRIDGE_ID,
      operationHash,
      history: ["empty"],
      observedAt,
      authenticationHash: AUTH_HASH,
    })],
    ["capacity-unavailable", (operationHash: string, observedAt: number): LiquidityTankObservation => ({
      status: "capacity-unavailable",
      bridgeId: BRIDGE_ID,
      operationHash,
      history: ["empty"],
      observedAt,
      authenticationHash: AUTH_HASH,
      reason: "destination tank insufficient",
    })],
    ["failed without checkpoint binding", (operationHash: string, observedAt: number): LiquidityTankObservation => ({
      ...failedAfterLock(operationHash, observedAt),
      lockTxHash: undefined,
      recoveryDeadline: undefined,
      history: ["empty", "failed"],
    })],
  ] as const)(
    "an authenticated %s status after the lock conflicts, and past the deadline expires the lock apart",
    async (_label, status) => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordObservation = vi.spyOn(store, "recordObservation");
      const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
      const run = runner({ adapter: h.adapter, store });
      await advanceLiquidityTankSettlement(run.shared);
      recordObservation.mockClear();
      h.broadcastRetained.mockClear();

      run.setClock(RECOVERY_DEADLINE_MS - 200);
      h.setObservation(status(h.operationHash, RECOVERY_DEADLINE_MS - 200));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "worker-before" }))
        .resolves.toMatchObject({
          status: "settle-asymmetric",
          pastDeadline: false,
          bridgeStatus: "conflicting",
        });
      expect(recordRecoveryExpired).not.toHaveBeenCalled();

      // After a restart, a status observed past the deadline shows the bridge
      // without the release by then: the lock expires, reported apart.
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      h.setObservation(status(h.operationHash, RECOVERY_DEADLINE_MS + 1));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "worker-after-restart" }))
        .resolves.toEqual(CONTRADICTED_EXPIRY);
      expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);
      expect(recordObservation).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();

      // Reconciliation corrects a delayed timely completion.
      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
      expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    },
  );

  test.each(["pending history", "empty history"] as const)(
    "round 3: the same pre-deadline failure stays open after restart (%s)",
    async (history) => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = runner({ adapter: h.adapter, store });
      await advanceLiquidityTankSettlement(run.shared);
      const failure = {
        ...failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS - 200),
        lockTxHash: "source-lock-tx",
        recoveryDeadline: RECOVERY_DEADLINE_MS,
        history: history === "empty history" ? ["empty", "failed"] : ["empty", "pending", "failed"],
      } as Extract<LiquidityTankObservation, { status: "failed" }>;
      h.setObservation(failure);
      run.setClock(RECOVERY_DEADLINE_MS - 200);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "before" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", bridgeStatus: "failed" });
      // Same object and transition time, with a new process/owner just past the deadline.
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restart" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", pastDeadline: true });
      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
      await expect(advanceLiquidityTankSettlement(run.nextOwner()))
        .resolves.toMatchObject({ status: "settled" });
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["unavailable", "empty", "timely completion"] as const)(
    "round 3: retained terminal evidence survives restart with %s",
    async (next) => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = runner({ adapter: h.adapter, store });
      await advanceLiquidityTankSettlement(run.shared);
      run.setClock(RECOVERY_DEADLINE_MS - 200);
      h.setObservation({ ...failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS - 200),
        lockTxHash: "source-lock-tx", recoveryDeadline: RECOVERY_DEADLINE_MS });
      await advanceLiquidityTankSettlement({ ...run.shared, owner: "before" });
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      h.setObservation(next === "unavailable" ? { status: "indeterminate", reason: "offline" }
        : next === "empty" ? empty(h.operationHash)
        : completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restart" }))
        .resolves.toMatchObject(next === "timely completion" ? { status: "settled" }
          : { status: "settle-asymmetric", pastDeadline: true });
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["empty", "capacity-unavailable"] as const)(
    "a cached pre-deadline %s snapshot never expires the lock, however late the host clock, so its timely release settles",
    async (status) => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const run = runner({ adapter: h.adapter, store, leaseDurationMs: 1 });
      await advanceLiquidityTankSettlement(run.shared);
      // The replica keeps serving one snapshot stamped after the lock but before the deadline.
      h.setObservation({ ...emptyAt(h.operationHash, RECOVERY_DEADLINE_MS - 1), status,
        reason: "no capacity" } as LiquidityTankObservation);
      run.setClock(RECOVERY_DEADLINE_MS - 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "before" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased",
          pastDeadline: false, bridgeStatus: "conflicting" });
      // The bridge's time has not passed the deadline, whatever this host's clock reads.
      for (const at of [RECOVERY_DEADLINE_MS + 1, RECOVERY_DEADLINE_MS + 86_400_000]) {
        run.setClock(at);
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: `restart-${at}` }))
          .resolves.toMatchObject({ status: "settle-asymmetric", reason: "lock-contradicted",
            pastDeadline: true, bridgeStatus: "conflicting" });
      }
      expect(expire).not.toHaveBeenCalled();
      // The lock is still open: its timely completion, read afterwards, settles it.
      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        status: "settled", settlement: { txRef: { lockTxHash: "source-lock-tx", releaseTxHash: "destination-release-tx" } },
      });
      expect(expire).not.toHaveBeenCalled();
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    },
  );

  test("round 3: failure retention and expiry CAS reject mismatched evidence and preserve the first failure", async () => {
    const h = harness();
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    h.setAfterBroadcast(pending(h.operationHash, true));
    await advanceLiquidityTankSettlement(runner({ adapter: h.adapter, store }).shared);
    const intent = createLiquidityTankIntent(authority());
    const claim = await store.claim({ intent, owner: "retainer", now: RECOVERY_DEADLINE_MS - 200, leaseDurationMs: 500 });
    if (claim.status !== "acquired" || claim.observation?.status !== "pending") throw new Error("expected lock");
    const checkpoint = claim.observation as Extract<LiquidityTankRecoveryEvidence, { status: "pending" }>;
    const evidence = { status: "failed-after-lock", checkpoint,
      failure: failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS - 200) } as
      Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>;
    const write = { settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
      owner: claim.lease.owner, generation: claim.lease.generation, now: RECOVERY_DEADLINE_MS - 200,
      recoveryFailure: evidence };
    for (const failure of [
      { ...evidence.failure, lockTxHash: "another-lock" },
      { ...evidence.failure, recoveryDeadline: RECOVERY_DEADLINE_MS + 1 },
      { ...evidence.failure, bridgeId: "another-bridge" },
      { ...evidence.failure, operationHash: "f".repeat(64) },
      { ...evidence.failure, authenticationHash: "invalid" },
      { ...evidence.failure, history: ["empty", "completed", "failed"] },
    ]) {
      await expect(store.recordRecoveryFailure({ ...write,
        recoveryFailure: { ...evidence, failure } as typeof evidence,
      })).resolves.toMatchObject({ status: "conflict" });
    }
    await expect(store.recordRecoveryFailure({ ...write, owner: "stale" })).resolves.toMatchObject({ status: "stale" });
    await expect(store.recordRecoveryFailure({ ...write, generation: claim.lease.generation + 1 })).resolves.toMatchObject({ status: "stale" });
    await expect(store.recordRecoveryFailure({ ...write, now: claim.lease.expiresAt })).resolves.toMatchObject({ status: "stale" });
    await expect(store.recordRecoveryFailure({ ...write,
      recoveryFailure: { ...evidence, checkpoint: pending(h.operationHash) } as typeof evidence,
    })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.recordRecoveryFailure({ ...write,
      recoveryFailure: { ...evidence, checkpoint: { ...checkpoint, observedAt: checkpoint.observedAt + 1 } },
    })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.recordRecoveryFailure(write)).resolves.toEqual({ status: "recorded", recoveryFailure: evidence });
    await expect(store.recordRecoveryFailure(write)).resolves.toEqual({ status: "existing", recoveryFailure: evidence });
    const changedEvidence = { ...evidence, failure: { ...evidence.failure, observedAt: RECOVERY_DEADLINE_MS + 1 } };
    await expect(store.recordRecoveryFailure({ ...write, recoveryFailure: changedEvidence })).resolves.toMatchObject({ status: "conflict" });
    const expiry = { settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
      owner: claim.lease.owner, generation: claim.lease.generation,
      now: RECOVERY_DEADLINE_MS + 1, expectedObservation: checkpoint, observation: evidence };
    await expect(store.claim({ intent, owner: "inspector", now: RECOVERY_DEADLINE_MS - 100, leaseDurationMs: 100 }))
      .resolves.toMatchObject({ status: "waiting", observation: checkpoint, recoveryFailure: evidence });
    await expect(store.recordRecoveryExpired({ ...expiry, now: RECOVERY_DEADLINE_MS - 1 })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.recordRecoveryExpired(expiry)).resolves.toMatchObject({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
    await expect(store.recordRecoveryExpired({ ...expiry, observation: changedEvidence })).resolves.toEqual({ status: "recorded" });
  });

  test("round 3: completion persistence beats retained failure expiry CAS", async () => {
    const h = harness();
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const run = runner({ adapter: h.adapter, store });
    h.setAfterBroadcast(pending(h.operationHash, true));
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS - 200);
    h.setObservation(failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS - 200));
    await advanceLiquidityTankSettlement({ ...run.shared, owner: "before" });
    const expire = store.recordRecoveryExpired.bind(store);
    store.recordRecoveryExpired = async (input) => {
      await expect(store.recordObservation({ ...input,
        observation: completed(h.operationHash, RECOVERY_DEADLINE_MS - 1),
      })).resolves.toEqual({ status: "recorded" });
      return expire(input);
    };
    run.setClock(RECOVERY_DEADLINE_MS + 1);
    h.setObservation(failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS + 1));
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "racer" }))
      .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-recovery-expiry-persistence-uncertain" });
    h.observe.mockClear();
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    expect(h.observe).not.toHaveBeenCalled();
  });

  test("round 3: a timely completion with a lost write suppresses retained failure expiry", async () => {
    const h = harness();
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const run = runner({ adapter: h.adapter, store });
    h.setAfterBroadcast(pending(h.operationHash, true));
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS - 200);
    h.setObservation(failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS - 200));
    await advanceLiquidityTankSettlement({ ...run.shared, owner: "before" });
    const record = store.recordObservation.bind(store);
    const expiry = vi.spyOn(store, "recordRecoveryExpired");
    store.recordObservation = async () => { throw new Error("lost completion write"); };
    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
    run.setClock(RECOVERY_DEADLINE_MS);
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restart" }))
      .resolves.toMatchObject({ status: "settle-asymmetric" });
    expect(expiry).not.toHaveBeenCalled();
    store.recordObservation = record;
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
  });

  test.each([
    ["a thrown write", async () => { throw new Error("lost failure write"); }],
    ["stale", async () => ({ status: "stale", reason: "simulated" })],
    ["conflict", async () => ({ status: "conflict", reason: "simulated" })],
    ["corrupt", async () => ({ status: "corrupt", reason: "simulated" })],
  ] as const)("round 3: a failure-retention write that returns %s never expires or broadcasts", async (_label, reply) => {
    const h = harness();
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const run = runner({ adapter: h.adapter, store });
    h.setAfterBroadcast(pending(h.operationHash, true));
    await advanceLiquidityTankSettlement(run.shared);
    const retain = store.recordRecoveryFailure.bind(store);
    const expiry = vi.spyOn(store, "recordRecoveryExpired");
    const lost = vi.fn(reply);
    store.recordRecoveryFailure = lost as unknown as LiquidityTankStore["recordRecoveryFailure"];
    h.setObservation(failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS - 200));
    run.setClock(RECOVERY_DEADLINE_MS);
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restart" }))
      .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain" });
    expect(lost).toHaveBeenCalledTimes(1);
    expect(expiry).not.toHaveBeenCalled();
    expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    store.recordRecoveryFailure = retain;
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settle-asymmetric", pastDeadline: true });
  });

  test.each([undefined, null, false, {}, "bad"])(
    "round 3: corrupt retained terminal evidence %s fails closed before effects",
    async (recoveryFailure) => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = runner({ adapter: h.adapter, store });
      h.setAfterBroadcast(pending(h.operationHash, true));
      await advanceLiquidityTankSettlement(run.shared);
      const claim = store.claim.bind(store);
      store.claim = async (input) => ({ ...await claim(input), recoveryFailure }) as never;
      h.observe.mockClear();
      h.broadcastRetained.mockClear();
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" });
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    },
  );

  test("round 3: retained terminal evidence must match the claimed checkpoint exactly", async () => {
    const h = harness();
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const run = runner({ adapter: h.adapter, store });
    h.setAfterBroadcast(pending(h.operationHash, true));
    await advanceLiquidityTankSettlement(run.shared);
    const claim = store.claim.bind(store);
    store.claim = async (input) => ({ ...await claim(input), recoveryFailure: {
      status: "failed-after-lock",
      checkpoint: { ...pending(h.operationHash, true), observedAt: 2_001 },
      failure: failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS - 200),
    } }) as never;
    h.observe.mockClear();
    await expect(advanceLiquidityTankSettlement(run.nextOwner()))
      .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" });
    expect(h.observe).not.toHaveBeenCalled();
  });

  describe("round 4", () => {
    const D = RECOVERY_DEADLINE_MS;
    type RetentionInput = Parameters<LiquidityTankStore["recordRecoveryFailure"]>[0];

    test("a store without recordRecoveryFailure is refused before any effect, even with a lock", async () => {
      const h = harness();
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(inner, h);
      const { recordRecoveryFailure: _missing, ...legacy } = inner;
      const claim = vi.spyOn(legacy, "claim");
      h.observe.mockClear();
      h.prepareSubmission.mockClear();
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await expect(advanceLiquidityTankSettlement({
        ...run.shared,
        owner: "un-upgraded",
        store: legacy as unknown as LiquidityTankStore,
      })).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-store-recovery-capability-unavailable",
      });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      // The durable lock is untouched and an upgraded store still resolves it.
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "upgraded" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", bridgeStatus: "failed" });
    });

    test.each([
      ["existing without an echo", (_input: RetentionInput) => ({ status: "existing" })],
      ["existing echoing another failure", (input: RetentionInput) => ({
        status: "existing",
        recoveryFailure: { ...input.recoveryFailure,
          failure: { ...input.recoveryFailure.failure, reason: "another failure" } },
      })],
      ["recorded echoing another checkpoint", (input: RetentionInput) => ({
        status: "recorded",
        recoveryFailure: { ...input.recoveryFailure,
          checkpoint: { ...input.recoveryFailure.checkpoint, observedAt: 2_001 } },
      })],
      ["existing with an accessor echo", (input: RetentionInput) => Object.defineProperty(
        { status: "existing" }, "recoveryFailure", { enumerable: true, get: () => input.recoveryFailure },
      )],
    ] as const)("a retention reply %s is not retained and never expires", async (_label, reply) => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const dropped = vi.fn(async (input: RetentionInput) => reply(input));
      store.recordRecoveryFailure = dropped as unknown as LiquidityTankStore["recordRecoveryFailure"];
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "f" }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain" });
      expect(dropped).toHaveBeenCalledTimes(1);
      // Restart past D with the bridge unavailable: nothing was retained.
      run.setClock(D + 1);
      h.setObservation({ status: "indeterminate", reason: "offline" });
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restart" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased", pastDeadline: true });
      // The same failure read again is still not retained.
      run.setClock(D + 2);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restart-2" }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain" });
      expect(expire).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("replaying a failure expiry waits until this host passes the deadline (P8)", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const intent = createLiquidityTankIntent(authority());
      const peek = await store.claim({ intent, owner: "peek", now: 5_000, leaseDurationMs: 100 });
      if (peek.status !== "acquired" || !peek.submission) throw new Error("expected acquired");
      const { submission, submissionRecordedAt } = peek;
      store.claim = async () => ({
        status: "recovery-expired", intent, submission, submissionRecordedAt,
        observation: { status: "failed-after-lock", checkpoint: pending(h.operationHash, true),
          failure: failedAfterLock(h.operationHash, D + 1) },
      }) as never;
      h.observe.mockClear();
      h.prepareSubmission.mockClear();
      for (const at of [D - 9_000, D - 1]) {
        run.setClock(at);
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: `replay-${at}` }))
          .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-recovery-expiry-not-due" });
      }
      run.setClock(D + 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "replay-at-deadline" }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate", reputationNeutral: true });
      expect(h.observe).toHaveBeenCalledTimes(1);
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("P1: a pending snapshot stamped after D while the host is before D never writes expiry", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      run.setClock(D - 1);
      h.setObservation(lockedPendingAt(h.operationHash, D + 5));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "skew" })).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased", pastDeadline: false,
      });
      expect(expire).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("P13: a retained failure then a lagging same-lock pending at D stays open", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await advanceLiquidityTankSettlement({ ...run.shared, owner: "f" });
      run.setClock(D + 1);
      h.setObservation(lockedPendingAt(h.operationHash, D - 300));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "r" })).resolves.toMatchObject({
        status: "settle-asymmetric", pastDeadline: true,
      });
    });

    test("P14: a non-success retention write is not treated as retained", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      store.recordRecoveryFailure = async () => ({ status: "conflict", reason: "simulated" });
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "f" }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain" });
      run.setClock(D);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "g" }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain" });
      expect(expire).not.toHaveBeenCalled();
    });

    test("P15: the reference store refuses to move the checkpoint once a failure is retained", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await advanceLiquidityTankSettlement({ ...run.shared, owner: "f" });
      const intent = createLiquidityTankIntent(authority());
      const c = await store.claim({ intent, owner: "s", now: D - 100, leaseDurationMs: 50 });
      if (c.status !== "acquired") throw new Error("expected acquired");
      await expect(store.recordObservation({ settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
        owner: "s", generation: c.lease.generation, now: D - 100,
        observation: lockedPendingAt(h.operationHash, D - 150),
      })).resolves.toMatchObject({ status: "conflict" });
    });

    test("P16: a lease lost right after the retention write is not reported as retained", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const retain = store.recordRecoveryFailure.bind(store);
      let lost = false;
      store.recordRecoveryFailure = async (input) => {
        const r = await retain(input);
        lost = true;
        return r;
      };
      const isCurrent = store.isCurrent.bind(store);
      store.isCurrent = async (input) => lost ? false : isCurrent(input);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      run.setClock(D + 5);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "f" }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain" });
      expect(expire).not.toHaveBeenCalled();
    });
  });

  describe("round 5", () => {
    const D = RECOVERY_DEADLINE_MS;
    const unavailable = {
      status: "indeterminate",
      reason: "liquidity-tank-store-recovery-capability-unavailable",
    };

    function withoutRetention(store: LiquidityTankStore): LiquidityTankStore {
      const { recordRecoveryFailure: _missing, ...legacy } = store;
      return legacy as unknown as LiquidityTankStore;
    }

    test("Q7: a lock, then an un-upgraded store, then the release lands: never a settlement failure", async () => {
      const h = harness();
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(inner, h);
      const legacy = withoutRetention(inner);
      const claim = vi.spyOn(legacy, "claim");
      h.observe.mockClear();
      run.setClock(D - 500);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "legacy", store: legacy }))
        .resolves.toEqual(unavailable);
      expect(claim).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      // The lock was live all along: the bridge releases to the seller.
      run.setClock(D - 400);
      h.setObservation(completed(h.operationHash, D - 450));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "upgraded" }))
        .resolves.toMatchObject({ status: "settled" });
    });

    test("Q8: a Proxy-instrumented store holding a lock is refused as indeterminate", async () => {
      const h = harness();
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(inner, h);
      const claim = vi.spyOn(inner, "claim");
      h.observe.mockClear();
      run.setClock(D - 500);
      await expect(advanceLiquidityTankSettlement({
        ...run.shared,
        owner: "traced",
        store: new Proxy(inner, {}),
      })).resolves.toEqual({
        status: "indeterminate",
        reason: "pay-cross-chain-liquidity-tank: store.claim must be stable data",
      });
      expect(claim).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "plain" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
    });

    test("an already settled phase seen through an un-upgraded store is not a settlement failure", async () => {
      const h = harness();
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(inner, h);
      run.setClock(D - 400);
      h.setObservation(completed(h.operationHash, D - 450));
      const settled = await advanceLiquidityTankSettlement({ ...run.shared, owner: "complete" });
      expect(settled).toMatchObject({ status: "settled" });
      const legacy = withoutRetention(inner);
      const claim = vi.spyOn(legacy, "claim");
      h.observe.mockClear();
      run.setClock(D - 300);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "legacy", store: legacy }))
        .resolves.toEqual(unavailable);
      expect(claim).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "upgraded" }))
        .resolves.toEqual(settled);
    });

    test.each([
      ["a frozen authority", (shared: AdvanceLiquidityTankInput) =>
        ({ ...shared, authority: Object.freeze({ ...shared.authority }) }),
        "liquidity-tank authority is not stable canonical JSON"],
      ["a Proxy authority", (shared: AdvanceLiquidityTankInput) =>
        ({ ...shared, authority: new Proxy({ ...shared.authority }, {}) }),
        "liquidity-tank authority is not stable canonical JSON"],
      ["a Proxy input", (shared: AdvanceLiquidityTankInput) => new Proxy({ ...shared }, {}),
        "pay-cross-chain-liquidity-tank: authority must be stable data"],
      ["an accessor authority", (shared: AdvanceLiquidityTankInput) => {
        const { authority: value, ...rest } = shared;
        return Object.defineProperty(rest, "authority", { enumerable: true, get: () => value });
      }, "pay-cross-chain-liquidity-tank: authority must be stable data"],
    ] as const)("a lock, then the same authority as %s, is indeterminate and still settles", async (_label, reshape, reason) => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const claim = vi.spyOn(store, "claim");
      h.observe.mockClear();
      run.setClock(D - 500);
      await expect(advanceLiquidityTankSettlement(reshape({ ...run.shared, owner: "reshaped" }) as never))
        .resolves.toEqual({ status: "indeterminate", reason });
      expect(claim).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      run.setClock(D - 400);
      h.setObservation(completed(h.operationHash, D - 450));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "plain" }))
        .resolves.toMatchObject({ status: "settled" });
    });

    test("Q1: a host clock stepping back across D after expiry waits without effects, then replays", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "retain" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", bridgeStatus: "failed", pastDeadline: false });
      run.setClock(D + 1);
      h.setObservation(failedAfterLock(h.operationHash, D + 1));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "expire" }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
      h.observe.mockClear();
      h.prepareSubmission.mockClear();
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const retain = vi.spyOn(store, "recordRecoveryFailure");
      run.setClock(D - 50);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "stepped-back" }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-recovery-expiry-not-due" });
      run.setClock(D + 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "back-at-d" }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
      expect(h.observe).toHaveBeenCalledTimes(1);
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      expect(expire).not.toHaveBeenCalled();
      expect(retain).not.toHaveBeenCalled();
    });

    test("Q10: a lock contradicted past D expires once a consistent same-lock pending read at or after D arrives", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      run.setClock(D + 1);
      // A pending without a lock leaves the operation live, so it never expires the lock.
      h.setObservation(pending(h.operationHash, false, D, D + 1));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "contradicted" })).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "lock-contradicted", bridgeStatus: "conflicting", pastDeadline: true,
      });
      run.setClock(D + 500);
      h.setObservation(lockedPendingAt(h.operationHash, D + 400));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "consistent" }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("a lock contradicted past D expires once lock-bound terminal failure evidence arrives", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      run.setClock(D + 1);
      // Another lock still inside its own window leaves the operation live.
      h.setObservation({ ...pending(h.operationHash, true, D + 600_000, D + 1), lockTxHash: "another-lock-tx" });
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "contradicted" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", reason: "lock-contradicted", pastDeadline: true });
      run.setClock(D + 500);
      h.setObservation(failedAfterLock(h.operationHash, D + 300));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "bound-failure" }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate", reputationNeutral: true });
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });
  });

  describe("round 6", () => {
    const D = RECOVERY_DEADLINE_MS;

    /** The lock was live all along: the bridge releases and a plain call settles. */
    async function releasesLater(run: Awaited<ReturnType<typeof lockDurably>>, h: ReturnType<typeof harness>) {
      run.setClock(D - 400);
      h.setObservation(completed(h.operationHash, D - 450));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "plain" }))
        .resolves.toMatchObject({ status: "settled" });
    }

    // The settlement key binds only jobId, railId and phaseIndex, so each of
    // these shares the key of the durable lock.
    test.each([
      ["phaseIndex as a string (a bigint column)", { phaseIndex: "2" },
        "pay-cross-chain-liquidity-tank: phaseIndex must be a non-negative safe integer"],
      ["sourceTokenDecimals as a string", { sourceTokenDecimals: "6" },
        "pay-cross-chain-liquidity-tank: sourceTokenDecimals must be a non-negative safe integer"],
      ["amount as a number", { amount: 1.25 },
        "pay-cross-chain-liquidity-tank: amount must be a plain decimal string"],
      ["an upper-cased hash", { agreementHash: AGREEMENT_HASH.toUpperCase() },
        "pay-cross-chain-liquidity-tank: authority hashes must be 32-byte lower-case hex"],
    ] as const)("a lock, then the authority with %s, is indeterminate before claim and still settles", async (_label, shift, reason) => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const claim = vi.spyOn(store, "claim");
      h.observe.mockClear();
      run.setClock(D - 500);
      await expect(advanceLiquidityTankSettlement({
        ...run.shared,
        owner: "reloaded",
        authority: { ...run.shared.authority, ...shift } as never,
      })).resolves.toEqual({ status: "indeterminate", reason });
      expect(claim).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      await releasesLater(run, h);
    });

    // Pinning: capture normalizes every string to NFC and the core validates
    // that snapshot, so the adapter signs from the same payee spelling the
    // binding commits to, and either spelling continues one lock.
    test("an NFD-spelled address binds, prepares and continues as its NFC form", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const nfdAuthority = authority({ destinationAddress: "café-address" });
      const nfcIntent = createLiquidityTankIntent(authority({ destinationAddress: "café-address" }));
      h.setObservation(empty(nfcIntent.operationHash));
      h.setAfterBroadcast(pending(nfcIntent.operationHash, true));
      const nfd = runner({ adapter: h.adapter, store, leaseDurationMs: 1, authority: nfdAuthority });
      await expect(advanceLiquidityTankSettlement(nfd.shared)).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased",
      });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.prepareSubmission.mock.calls[0]?.[0]).toEqual(nfcIntent);
      h.broadcastRetained.mockClear();
      nfd.setClock(D - 500);
      await expect(advanceLiquidityTankSettlement({
        ...nfd.shared,
        owner: "nfc",
        authority: authority({ destinationAddress: "café-address" }),
      })).resolves.toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    const differentBindings = [
      ["a changed amount", { amount: "2.5" }],
      ["a recased destinationAddress", { destinationAddress: "DESTINATION-ADDRESS" }],
    ] as const;

    test.each(differentBindings)(
      "a lock, then a valid authority with %s for the same phase, is an indeterminate binding conflict",
      async (_label, change) => {
        const h = harness();
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const run = await lockDurably(store, h);
        h.observe.mockClear();
        run.setClock(D - 500);
        await expect(advanceLiquidityTankSettlement({
          ...run.shared,
          owner: "rebound",
          authority: authority(change),
        })).resolves.toEqual({
          status: "indeterminate",
          reason: "liquidity-tank-settlement-binding-conflict",
        });
        expect(h.observe).not.toHaveBeenCalled();
        expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
        expect(h.broadcastRetained).not.toHaveBeenCalled();
        await releasesLater(run, h);
      },
    );

    test.each(differentBindings)(
      "a settled phase, then a valid authority with %s, is an indeterminate binding conflict",
      async (_label, change) => {
        const h = harness();
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const run = await lockDurably(store, h);
        run.setClock(D - 400);
        h.setObservation(completed(h.operationHash, D - 450));
        const settled = await advanceLiquidityTankSettlement({ ...run.shared, owner: "complete" });
        expect(settled).toMatchObject({ status: "settled" });
        h.observe.mockClear();
        run.setClock(D - 300);
        await expect(advanceLiquidityTankSettlement({
          ...run.shared,
          owner: "rebound",
          authority: authority(change),
        })).resolves.toEqual({
          status: "indeterminate",
          reason: "liquidity-tank-settlement-binding-conflict",
        });
        expect(h.observe).not.toHaveBeenCalled();
        expect(h.broadcastRetained).not.toHaveBeenCalled();
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "plain" }))
          .resolves.toEqual(settled);
      },
    );

    const HASH_REFUSED = "pay-cross-chain-liquidity-tank: authority hashes must be 32-byte lower-case hex";

    // The boxed string is already refused at capture (not JSON data); the
    // one-element array is JSON data and was coerced by `RegExp.prototype.test`.
    test.each([
      ["a one-element array", [AGREEMENT_HASH], HASH_REFUSED],
      ["a boxed string", Object(AGREEMENT_HASH), "liquidity-tank authority is not stable canonical JSON"],
    ] as const)("refuses an agreementHash given as %s instead of coercing it", async (_label, hash, reason) => {
      const coerced = authority({ agreementHash: hash as never });
      expect(() => createLiquidityTankIntent(coerced)).toThrow(reason);
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const claim = vi.spyOn(store, "claim");
      const h = harness();
      await expect(advanceLiquidityTankSettlement(runner({ authority: coerced, store, adapter: h.adapter }).shared))
        .resolves.toEqual({ status: "indeterminate", reason });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    });

    test("a polluted Object.prototype cannot supply a missing authority field", async () => {
      const { sr5BindingHash: _missing, ...partial } = authority();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const claim = vi.spyOn(store, "claim");
      const h = harness();
      const proto = Object.prototype as Record<string, unknown>;
      let result: unknown;
      try {
        proto.sr5BindingHash = SR5_HASH;
        proto.phaseIndex = 2;
        expect(() => createLiquidityTankIntent(partial as never)).toThrow(HASH_REFUSED);
        expect(() => liquidityTankSettlementKey({ jobId: JOB_ID, railId: authority().railId } as never))
          .toThrow(/phaseIndex must be a non-negative safe integer/);
        result = await advanceLiquidityTankSettlement(runner({
          authority: partial as never,
          store,
          adapter: h.adapter,
        }).shared);
      } finally {
        delete proto.sr5BindingHash;
        delete proto.phaseIndex;
      }
      expect(result).toEqual({ status: "indeterminate", reason: HASH_REFUSED });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    });

    test.each([
      "1", "01.2500", "0.000001", ".5", "5.", "100.100", "000120", "999999999999999999999.999999",
      "0", "000", "0.0", ".", "", "1.0000001", "1e3", "-1", "+1", " 1", "1 ", "1.2.3", "١", "0x10",
    ])("amount %j gives the CD-1 canonical amount and 6-decimal base units, or is refused", (amount) => {
      let expected: { amount: string; units: string } | undefined;
      try {
        const canonical = assertPositiveAmount(amount);
        expected = { amount: canonical, units: baseUnits(canonical, 6) };
      } catch {
        expected = undefined;
      }
      if (expected === undefined) {
        expect(() => createLiquidityTankIntent(authority({ amount }))).toThrow();
        return;
      }
      expect(createLiquidityTankIntent(authority({ amount }))).toMatchObject({
        amount: expected.amount,
        sourceAmountBaseUnits: expected.units,
        destinationAmountBaseUnits: expected.units,
      });
    });

    test("identical content under a throwing RegExp.prototype.test never runs it and continues the lock", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      run.setClock(D - 500);
      const originalTest = RegExp.prototype.test;
      const poisoned = vi.fn(() => {
        throw new Error("prototype poisoned");
      });
      let result: unknown;
      try {
        RegExp.prototype.test = poisoned;
        result = await advanceLiquidityTankSettlement({ ...run.shared, owner: "poisoned" });
      } finally {
        RegExp.prototype.test = originalTest;
      }
      expect(poisoned).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      await releasesLater(run, h);
    });

    test("an always-true RegExp.prototype.test cannot admit an upper-cased hash for a locked phase", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const claim = vi.spyOn(store, "claim");
      run.setClock(D - 500);
      const originalTest = RegExp.prototype.test;
      let result: unknown;
      try {
        RegExp.prototype.test = () => true;
        result = await advanceLiquidityTankSettlement({
          ...run.shared,
          owner: "lenient",
          authority: authority({ agreementHash: AGREEMENT_HASH.toUpperCase() }),
        });
      } finally {
        RegExp.prototype.test = originalTest;
      }
      expect(result).toEqual({ status: "indeterminate", reason: HASH_REFUSED });
      expect(claim).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      await releasesLater(run, h);
    });

    // Pinning: capture already refused this as indeterminate on 4a9ae7b. The
    // shared canonical-JSON capture still dispatches through
    // `String.prototype.normalize`, so this is the replaced intrinsic the core
    // cannot avoid; it must stay a retry-safe refusal before any claim.
    test("identical content under a throwing String.prototype.normalize is indeterminate before claim", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const claim = vi.spyOn(store, "claim");
      h.observe.mockClear();
      run.setClock(D - 500);
      const originalNormalize = String.prototype.normalize;
      let result: unknown;
      try {
        String.prototype.normalize = () => {
          throw new Error("prototype poisoned");
        };
        result = await advanceLiquidityTankSettlement({ ...run.shared, owner: "poisoned" });
      } finally {
        String.prototype.normalize = originalNormalize;
      }
      expect(result).toEqual({
        status: "indeterminate",
        reason: "liquidity-tank authority is not stable canonical JSON",
      });
      expect(claim).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      await releasesLater(run, h);
    });

    test("binding store and adapter methods reads no getter on the method", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      h.setAfterBroadcast(completed(h.operationHash));
      const touched = vi.fn();
      for (const method of [store.claim, store.recordRecoveryFailure, h.adapter.observe]) {
        Object.defineProperty(method, "name", { get() { touched("name"); return "m"; } });
        Object.defineProperty(method, "length", { get() { touched("length"); return 1; } });
      }
      await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
        .resolves.toMatchObject({ status: "settled" });
      expect(touched).not.toHaveBeenCalled();
    });

    // Pinning for the last two rows: a conflict without a string reason was
    // already refused as claim-invalid on 4a9ae7b.
    test.each([
      ["its own reason", { reason: "host-binding-mismatch" }, "host-binding-mismatch"],
      ["no reason", {}, "liquidity-tank-settlement-store-claim-invalid"],
      ["a non-string reason", { reason: 7 }, "liquidity-tank-settlement-store-claim-invalid"],
    ] as const)("a host store's claim conflict with %s is indeterminate", async (_label, fields, reason) => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      store.claim = vi.fn(async () => ({ status: "conflict", ...fields }) as never);
      const h = harness();
      await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
        .resolves.toEqual({ status: "indeterminate", reason });
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });
  });

  /** The lock was live all along: the bridge releases and a plain call settles. */
  async function releasesLater(run: Awaited<ReturnType<typeof lockDurably>>, h: ReturnType<typeof harness>) {
    run.setClock(RECOVERY_DEADLINE_MS - 400);
    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 450));
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "plain" }))
      .resolves.toMatchObject({ status: "settled" });
  }

  /** An adapter with its own bridge ID, so only the settlement key can stop it. */
  function secondAdapter() {
    const bridgeId = "xyz123def456gh78";
    const prepareSubmission = vi.fn<LiquidityTankAdapter["prepareSubmission"]>(async (bound, fence) => {
      await fence.assertCurrent();
      return {
        submissionVersion: "1",
        authorityHash: bound.bindingHash,
        operationHash: bound.operationHash,
        bridgeId,
        substrateTxHash: "second-native-bridge-tx",
        signedSubmissionBase64: Buffer.from("second-signed", "utf8").toString("base64"),
        preparedAt: 1_900,
      };
    });
    const broadcastRetained = vi.fn<LiquidityTankAdapter["broadcastRetained"]>(async (_submission, fence) => {
      await fence.assertCurrent();
    });
    const observe = vi.fn<LiquidityTankAdapter["observe"]>(async (bound, _submission, fence) => {
      await fence.assertCurrent();
      return { ...empty(bound.operationHash), bridgeId } as LiquidityTankObservation;
    });
    return {
      adapter: { prepareSubmission, broadcastRetained, observe } satisfies LiquidityTankAdapter,
      prepareSubmission,
      broadcastRetained,
      observe,
    };
  }

  describe("round 7", () => {
    const D = RECOVERY_DEADLINE_MS;
    const RAIL_ID = "demos-tank-sepolia-amoy-usdc";
    const BINDING_CONFLICT = {
      status: "indeterminate",
      reason: "liquidity-tank-settlement-binding-conflict",
    } as const;
    const PRECISION_REFUSED =
      "pay-cross-chain-liquidity-tank: amount has more precision than 6 decimals";

    function expectNoEffects(second: ReturnType<typeof secondAdapter>, h: ReturnType<typeof harness>) {
      expect(second.prepareSubmission).not.toHaveBeenCalled();
      expect(second.broadcastRetained).not.toHaveBeenCalled();
      expect(second.observe).not.toHaveBeenCalled();
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    }

    // Daybreak's round-7 probe: on b6aef30 the key was derived from the shared
    // snapshot, which normalizes through the live prototype, so the store saw a
    // new phase and the core prepared, persisted and broadcast a second time.
    test.each([
      ["railId", { railId: "other-tank-rail" }, RAIL_ID, "other-tank-rail"],
      ["jobId", { jobId: SECOND_JOB_ID }, JOB_ID, SECOND_JOB_ID],
    ] as const)("a String.prototype.normalize replaced to rename the %s cannot open a second phase", async (_label, renamed, from, to) => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const lockedKey = createLiquidityTankIntent(authority()).settlementKey;
      expect(createLiquidityTankIntent(authority(renamed)).settlementKey).not.toBe(lockedKey);
      const claim = vi.spyOn(store, "claim");
      h.observe.mockClear();
      run.setClock(D - 500);
      const second = secondAdapter();
      const originalNormalize = String.prototype.normalize;
      let intent: unknown;
      let key: unknown;
      let result: unknown;
      try {
        String.prototype.normalize = function (this: unknown, form?: string) {
          const value = String(this);
          if (value === from) return to;
          return Reflect.apply(originalNormalize, value, form === undefined ? [] : [form]) as string;
        };
        intent = createLiquidityTankIntent(authority());
        key = liquidityTankSettlementKey({ jobId: JOB_ID, railId: RAIL_ID, phaseIndex: 2 });
        result = await advanceLiquidityTankSettlement({
          ...run.shared,
          owner: "renamed",
          authority: authority(),
          adapter: second.adapter,
        });
      } finally {
        String.prototype.normalize = originalNormalize;
      }
      expect(intent).toMatchObject({ settlementKey: lockedKey, jobId: JOB_ID, railId: RAIL_ID });
      expect(key).toBe(lockedKey);
      // The lie reaches only the shared binding hash: a conflict on the same key.
      expect(result).toEqual(BINDING_CONFLICT);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(claim.mock.calls[0]?.[0].intent.settlementKey).toBe(lockedKey);
      expectNoEffects(second, h);
      expect(h.observe).not.toHaveBeenCalled();
      await releasesLater(run, h);
    });

    // On b6aef30 the key hashed through the live `Hash.prototype.digest`.
    test("a Hash.prototype.digest replaced after load cannot rename a locked phase", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const lockedKey = createLiquidityTankIntent(authority()).settlementKey;
      const claim = vi.spyOn(store, "claim");
      run.setClock(D - 500);
      const second = secondAdapter();
      const hashPrototype = Object.getPrototypeOf(createHash("sha256")) as { digest: unknown };
      const originalDigest = hashPrototype.digest;
      let key: unknown;
      let result: unknown;
      try {
        hashPrototype.digest = () => "0".repeat(64);
        key = liquidityTankSettlementKey({ jobId: JOB_ID, railId: RAIL_ID, phaseIndex: 2 });
        result = await advanceLiquidityTankSettlement({ ...run.shared, owner: "digest", adapter: second.adapter });
      } finally {
        hashPrototype.digest = originalDigest;
      }
      expect(key).toBe(lockedKey);
      expect(result).toEqual(BINDING_CONFLICT);
      expect(claim.mock.calls[0]?.[0].intent.settlementKey).toBe(lockedKey);
      expectNoEffects(second, h);
      await releasesLater(run, h);
    });

    // On b6aef30 `requireUInt` returned the global `Number(value)`, so the key
    // took phaseIndex 3 while the intent still said 2.
    test("a global Number replaced after load cannot shift phaseIndex in the key", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const lockedKey = createLiquidityTankIntent(authority()).settlementKey;
      const claim = vi.spyOn(store, "claim");
      run.setClock(D - 500);
      const global = globalThis as { Number: NumberConstructor };
      const originalNumber = global.Number;
      let intent: unknown;
      let result: unknown;
      try {
        global.Number = new Proxy(originalNumber, {
          apply(target, thisArg, args: unknown[]) {
            return args[0] === 2 ? 3 : Reflect.apply(target, thisArg, args);
          },
        });
        intent = createLiquidityTankIntent(authority());
        result = await advanceLiquidityTankSettlement({ ...run.shared, owner: "number" });
      } finally {
        global.Number = originalNumber;
      }
      expect(intent).toMatchObject({ settlementKey: lockedKey, phaseIndex: 2 });
      // Same key, same binding: the call continues the lock.
      expect(result).toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
      expect(claim.mock.calls[0]?.[0].intent.settlementKey).toBe(lockedKey);
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      await releasesLater(run, h);
    });

    // On b6aef30 the shared snapshot's `"value" in descriptor` read the
    // polluted value, so the intent carried the attacker's payee.
    test("a polluted Object.prototype.value cannot stand in for an accessor-backed payee", async () => {
      const getter = vi.fn(() => "destination-address");
      const accessor = authority();
      Object.defineProperty(accessor, "destinationAddress", { get: getter, enumerable: true, configurable: true });
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const claim = vi.spyOn(store, "claim");
      const h = harness();
      const proto = Object.prototype as Record<string, unknown>;
      let outcome: unknown;
      let result: unknown;
      try {
        proto.value = "attacker-address";
        proto.writable = true;
        try {
          outcome = createLiquidityTankIntent(accessor);
        } catch (error) {
          outcome = error;
        }
        result = await advanceLiquidityTankSettlement(runner({ authority: accessor, store, adapter: h.adapter }).shared);
      } finally {
        delete proto.value;
        delete proto.writable;
      }
      const refused = "pay-cross-chain-liquidity-tank: authority must be stable data";
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(refused);
      expect(result).toEqual({ status: "indeterminate", reason: refused });
      expect(getter).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    });

    // On b6aef30 the shared snapshot's surrogate check went through the live
    // `charCodeAt`, and the key's UTF-8 encoding turns a lone surrogate into
    // U+FFFD, so the railId took the key of another, well-formed one.
    test("a replaced String.prototype.charCodeAt cannot admit a lone-surrogate railId", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const claim = vi.spyOn(store, "claim");
      const h = harness();
      const loneSurrogate = authority({ railId: "rail-\ud800" });
      const originalCharCodeAt = String.prototype.charCodeAt;
      let outcome: unknown;
      let result: unknown;
      try {
        String.prototype.charCodeAt = () => 0x41;
        try {
          outcome = createLiquidityTankIntent(loneSurrogate);
        } catch (error) {
          outcome = error;
        }
        result = await advanceLiquidityTankSettlement(runner({ authority: loneSurrogate, store, adapter: h.adapter }).shared);
      } finally {
        String.prototype.charCodeAt = originalCharCodeAt;
      }
      const refused = "pay-cross-chain-liquidity-tank: authority must be stable data";
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(refused);
      expect(result).toEqual({ status: "indeterminate", reason: refused });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    });

    // Pinning, and kills an NFC-to-NFD mutant: every expected value is the
    // NFC spelling, computed independently of the rail.
    test("an NFD-spelled railId gives the NFC railId, intent key and helper key", async () => {
      const nfc = "rail-café";
      const nfd = "rail-café";
      const nfcKey = sha256Hex(`dacs-liquidity-tank:v1:${JOB_ID}:${nfc}:2`);
      const fromNfd = createLiquidityTankIntent(authority({ railId: nfd }));
      const fromNfc = createLiquidityTankIntent(authority({ railId: nfc }));
      expect(fromNfd.railId).toBe(nfc);
      expect(fromNfd.settlementKey).toBe(nfcKey);
      expect(fromNfd).toEqual(fromNfc);
      expect(liquidityTankSettlementKey({ jobId: JOB_ID, railId: nfd, phaseIndex: 2 })).toBe(nfcKey);
      expect(liquidityTankSettlementKey({ jobId: JOB_ID, railId: nfc, phaseIndex: 2 })).toBe(nfcKey);
      const h = harness();
      await advanceLiquidityTankSettlement(runner({ authority: authority({ railId: nfd }), adapter: h.adapter }).shared);
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.prepareSubmission.mock.calls[0]?.[0]).toEqual(fromNfc);
    });

    // Pinning, and kills a mutant that calls methods without their receiver:
    // each method here reaches its state through `this`.
    test("a store and an adapter written as classes keep their receiver", async () => {
      const h = harness();
      h.setAfterBroadcast(completed(h.operationHash));
      class ClassStore implements LiquidityTankStore {
        readonly restartSafety = "volatile-acknowledged";
        readonly #inner = createInMemoryLiquidityTankStore(VOLATILE);
        claim(input: Parameters<LiquidityTankStore["claim"]>[0]) {
          return this.#inner.claim(input);
        }
        isCurrent(input: Parameters<LiquidityTankStore["isCurrent"]>[0]) {
          return this.#inner.isCurrent(input);
        }
        recordSubmission(input: Parameters<LiquidityTankStore["recordSubmission"]>[0]) {
          return this.#inner.recordSubmission(input);
        }
        recordObservation(input: Parameters<LiquidityTankStore["recordObservation"]>[0]) {
          return this.#inner.recordObservation(input);
        }
        recordRecoveryFailure(input: Parameters<LiquidityTankStore["recordRecoveryFailure"]>[0]) {
          return this.#inner.recordRecoveryFailure(input);
        }
        recordRecoveryExpired(input: Parameters<LiquidityTankStore["recordRecoveryExpired"]>[0]) {
          return this.#inner.recordRecoveryExpired(input);
        }
        recordSettlement(input: Parameters<LiquidityTankStore["recordSettlement"]>[0]) {
          return this.#inner.recordSettlement(input);
        }
      }
      class ClassAdapter implements LiquidityTankAdapter {
        readonly #inner = h.adapter;
        prepareSubmission(...args: Parameters<LiquidityTankAdapter["prepareSubmission"]>) {
          return this.#inner.prepareSubmission(...args);
        }
        broadcastRetained(...args: Parameters<LiquidityTankAdapter["broadcastRetained"]>) {
          return this.#inner.broadcastRetained(...args);
        }
        observe(...args: Parameters<LiquidityTankAdapter["observe"]>) {
          return this.#inner.observe(...args);
        }
      }
      await expect(advanceLiquidityTankSettlement(runner({
        store: new ClassStore(),
        adapter: new ClassAdapter(),
      }).shared)).resolves.toMatchObject({ status: "settled" });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    });

    // On b6aef30 the base64 check stripped padding with `.replace(/=+$/)`,
    // which dispatches through the live `exec`, so the valid retained row read
    // as `liquidity-tank-retained-state-corrupt`.
    test("a throwing RegExp.prototype.exec cannot make a valid retained row read as corrupt", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      run.setClock(D - 500);
      const originalExec = RegExp.prototype.exec;
      const poisoned = vi.fn(() => {
        throw new Error("prototype poisoned");
      });
      let result: unknown;
      try {
        RegExp.prototype.exec = poisoned;
        result = await advanceLiquidityTankSettlement({ ...run.shared, owner: "poisoned" });
      } finally {
        RegExp.prototype.exec = originalExec;
      }
      expect(poisoned).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      await releasesLater(run, h);
    });

    // Daybreak's round-7 probe: on b6aef30 an `exec` lying for `/=+$/` made
    // both sides strip to "", so a retained row with invalid base64 passed
    // and was broadcast.
    test("a lying RegExp.prototype.exec cannot admit a retained row with invalid base64", async () => {
      const intent = createLiquidityTankIntent(authority());
      const unsigned = {
        submissionVersion: "1" as const,
        authorityHash: intent.bindingHash,
        operationHash: intent.operationHash,
        bridgeId: BRIDGE_ID,
        substrateTxHash: "retained-tx",
        signedSubmissionBase64: "AAAA!!!!",
        preparedAt: 900,
      };
      const submission = Object.freeze({ ...unsigned, submissionHash: sha256Hex(canonicalize(unsigned)) });
      const store: LiquidityTankStore = {
        ...createInMemoryLiquidityTankStore(VOLATILE),
        claim: vi.fn(async () => ({
          status: "acquired" as const,
          intent,
          lease: { owner: "worker-a", generation: 1, expiresAt: 1_100 },
          submission,
          submissionRecordedAt: 1_000,
        })),
        isCurrent: vi.fn(async () => true),
      };
      const h = harness();
      const originalExec = RegExp.prototype.exec;
      let result: unknown;
      try {
        RegExp.prototype.exec = function (this: RegExp, input: string) {
          if (this.source === "=+$") return Object.assign([input], { index: 0, input }) as unknown as RegExpExecArray;
          return Reflect.apply(originalExec, this, [input]) as RegExpExecArray | null;
        };
        result = await advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared);
      } finally {
        RegExp.prototype.exec = originalExec;
      }
      expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" });
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    });

    // Pinning: b6aef30 already refused these through its null-prototype record.
    test.each([
      ["destinationAddress", "attacker-address", "pay-cross-chain-liquidity-tank: destinationAddress must be a non-empty string"],
      ["amount", "1000", "pay-cross-chain-liquidity-tank: amount must be a plain decimal string"],
      ["railId", "other-tank-rail", "pay-cross-chain-liquidity-tank: railId must be a non-empty string"],
      ["jobId", SECOND_JOB_ID, "jobId must be a canonical uppercase ULID"],
    ] as const)("a polluted Object.prototype.%s never reaches the intent of an authority that lacks it", async (field, value, reason) => {
      const partial: Record<string, unknown> = { ...authority() };
      delete partial[field];
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const claim = vi.spyOn(store, "claim");
      const h = harness();
      const proto = Object.prototype as Record<string, unknown>;
      let intentError: unknown;
      let keyError: unknown;
      let result: unknown;
      try {
        proto[field] = value;
        try {
          createLiquidityTankIntent(partial as never);
        } catch (error) {
          intentError = error;
        }
        if (field === "railId" || field === "jobId") {
          const keyInput: Record<string, unknown> = { jobId: JOB_ID, railId: RAIL_ID, phaseIndex: 2 };
          delete keyInput[field];
          try {
            liquidityTankSettlementKey(keyInput as never);
          } catch (error) {
            keyError = error;
          }
        }
        result = await advanceLiquidityTankSettlement(runner({ authority: partial as never, store, adapter: h.adapter }).shared);
      } finally {
        delete proto[field];
      }
      expect((intentError as Error).message).toBe(reason);
      if (field === "railId" || field === "jobId") expect((keyError as Error).message).toBe(reason);
      expect(result).toEqual({ status: "indeterminate", reason });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    });

    // On b6aef30 the padding lookup indexed -1/-2 and read the polluted
    // prototype, giving 10x and 100x the base units.
    test.each([
      ["Object.prototype[\"-1\"]", Object.prototype, "-1", "1.0000001"],
      ["Array.prototype[\"-2\"]", Array.prototype, "-2", "1.00000001"],
    ] as const)("a polluted %s cannot pad an over-precise amount", async (_label, prototype, index, amount) => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const claim = vi.spyOn(store, "claim");
      const h = harness();
      const polluted = prototype as unknown as Record<string, unknown>;
      let thrown: unknown;
      let result: unknown;
      try {
        polluted[index] = "";
        try {
          createLiquidityTankIntent(authority({ amount }));
        } catch (error) {
          thrown = error;
        }
        result = await advanceLiquidityTankSettlement(runner({
          authority: authority({ amount }),
          store,
          adapter: h.adapter,
        }).shared);
      } finally {
        delete polluted[index];
      }
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe(PRECISION_REFUSED);
      expect(result).toEqual({ status: "indeterminate", reason: PRECISION_REFUSED });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });
  });

  // Replaced built-ins are outside the rail's threat model (see the docs);
  // each test here closes a route the round-8 reviews found on 19ff64c, where
  // one changed the payee, the amount or the settlement key, or broadcast twice
  // for a locked phase.
  describe("round 8", () => {
    const D = RECOVERY_DEADLINE_MS;
    const RAIL_ID = "demos-tank-sepolia-amoy-usdc";
    const LOCK_CONTINUES = { status: "settle-asymmetric", reason: "tank-locked-unreleased" } as const;

    /** A plain object a well-behaved hook can still write to. */
    function writable(value: unknown): value is Record<string, unknown> {
      return typeof value === "object" && value !== null && !Object.isFrozen(value);
    }

    /** Runs `body` with `Set.prototype.has` calling `hook` first; restored in `finally`. */
    async function withSetHasHook<T>(hook: (value: unknown) => void, body: () => Promise<T>): Promise<T> {
      const originalHas = Set.prototype.has;
      try {
        Set.prototype.has = function (this: Set<unknown>, value: unknown) {
          hook(value);
          return Reflect.apply(originalHas, this, [value]) as boolean;
        };
        return await body();
      } finally {
        Set.prototype.has = originalHas;
      }
    }

    function expectNothingNew(second: ReturnType<typeof secondAdapter>, h: ReturnType<typeof harness>) {
      expect(second.prepareSubmission).not.toHaveBeenCalled();
      expect(second.broadcastRetained).not.toHaveBeenCalled();
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    }

    // Code review G1: the captured `update`/`digest` still read the native
    // handle from the instance's `kHandle` slot, so an accessor for it on
    // `Hash.prototype` forged the key.
    test("a hijacked Hash handle slot cannot rename a locked phase", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const lockedKey = createLiquidityTankIntent(authority()).settlementKey;
      const claim = vi.spyOn(store, "claim");
      run.setClock(D - 500);
      const second = secondAdapter();
      const probe = createHash("sha256");
      const hashPrototype = Object.getPrototypeOf(probe) as object;
      const kHandle = Object.getOwnPropertySymbols(probe).find((symbol) => symbol.description === "kHandle");
      expect(kHandle).toBeDefined();
      type NativeHandle = { update(data: unknown, encoding?: string): unknown; digest(encoding?: string): unknown };
      const handles = new WeakMap<object, NativeHandle>();
      const seen = new WeakMap<object, string>();
      const forged = "e".repeat(64);
      let hijacked: unknown;
      let key: unknown;
      let result: unknown;
      try {
        Object.defineProperty(hashPrototype, kHandle as symbol, {
          configurable: true,
          set(this: object, handle: NativeHandle) {
            handles.set(this, handle);
          },
          get(this: object) {
            const self = this;
            const handle = handles.get(self) as NativeHandle;
            return {
              update(data: unknown, encoding?: string) {
                const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8");
                seen.set(self, `${seen.get(self) ?? ""}${text}`);
                return handle.update(data, encoding);
              },
              digest(encoding?: string) {
                return (seen.get(self) ?? "").startsWith("dacs-liquidity-tank:v1:")
                  ? forged
                  : handle.digest(encoding);
              },
            };
          },
        });
        hijacked = createHash("sha256").update(`dacs-liquidity-tank:v1:${JOB_ID}:${RAIL_ID}:2`).digest("hex");
        key = liquidityTankSettlementKey({ jobId: JOB_ID, railId: RAIL_ID, phaseIndex: 2 });
        result = await advanceLiquidityTankSettlement({ ...run.shared, owner: "hijacked", adapter: second.adapter });
      } finally {
        delete (hashPrototype as Record<symbol, unknown>)[kHandle as symbol];
      }
      expect(hijacked).toBe(forged);
      expect(key).toBe(lockedKey);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(claim.mock.calls[0]?.[0].intent.settlementKey).toBe(lockedKey);
      expect(result).toMatchObject(LOCK_CONTINUES);
      expectNothingNew(second, h);
      await releasesLater(run, h);
    });

    // Code review G2 and Daybreak's second scenario: the shared gate ran
    // before the owned read, so a built-in it calls with the authority could
    // rename the phase first.
    test.each([
      ["Set.prototype.has", "has"],
      ["Object.getOwnPropertyDescriptors", "descriptors"],
    ] as const)("a %s that renames the railId during the gate cannot open a second phase", async (_label, route) => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const lockedKey = createLiquidityTankIntent(authority()).settlementKey;
      const claim = vi.spyOn(store, "claim");
      run.setClock(D - 500);
      const second = secondAdapter();
      // The host rebuilds the identical authority from its records on each call.
      const presented = authority();
      const keyInput = { jobId: JOB_ID, railId: RAIL_ID, phaseIndex: 2 };
      const rename = (value: unknown) => {
        if ((value === presented || value === keyInput) && writable(value)) value["railId"] = "other-tank-rail";
      };
      const originalDescriptors = Object.getOwnPropertyDescriptors;
      let key: unknown;
      let result: unknown;
      const body = async () => {
        key = liquidityTankSettlementKey(keyInput);
        result = await advanceLiquidityTankSettlement({
          ...run.shared,
          owner: "renamed",
          authority: presented,
          adapter: second.adapter,
        });
      };
      if (route === "has") {
        await withSetHasHook(rename, body);
      } else {
        try {
          Object.getOwnPropertyDescriptors = ((value: object) => {
            rename(value);
            return originalDescriptors(value);
          }) as typeof Object.getOwnPropertyDescriptors;
          await body();
        } finally {
          Object.getOwnPropertyDescriptors = originalDescriptors;
        }
      }
      expect(presented.railId).toBe("other-tank-rail");
      expect(keyInput.railId).toBe("other-tank-rail");
      expect(key).toBe(lockedKey);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(claim.mock.calls[0]?.[0].intent.settlementKey).toBe(lockedKey);
      expect(result).toMatchObject(LOCK_CONTINUES);
      expectNothingNew(second, h);
      await releasesLater(run, h);
    });

    // Code review G5: a crash after the lock, then a restart in a process
    // where a dependency hooks the gate to shift `phaseIndex`.
    test("a restart under a Set.prototype.has hook that shifts phaseIndex signs nothing new", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const lockedKey = createLiquidityTankIntent(authority()).settlementKey;
      const claim = vi.spyOn(store, "claim");
      run.setClock(D - 500);
      const second = secondAdapter();
      const presented = authority();
      let result: unknown;
      await withSetHasHook((value) => {
        if (value === presented && writable(value)) value["phaseIndex"] = 3;
      }, async () => {
        result = await advanceLiquidityTankSettlement({
          ...run.shared,
          owner: "restarted",
          authority: presented,
          adapter: second.adapter,
        });
      });
      expect(presented.phaseIndex).toBe(3);
      expect(claim.mock.calls[0]?.[0].intent).toMatchObject({ settlementKey: lockedKey, phaseIndex: 2 });
      expect(result).toMatchObject(LOCK_CONTINUES);
      expectNothingNew(second, h);
      await releasesLater(run, h);
    });

    // Code review G3 and Daybreak's first scenario: the operation was hashed
    // unfrozen, and the intent read the payee and base units back from it.
    // The unsigned intent is hashed frozen too, so its binding hash holds.
    test.each([
      ["Set.prototype.has", "has"],
      ["Object.entries", "entries"],
    ] as const)("a %s that rewrites the hashed objects cannot change the payee, base units or binding", async (_label, route) => {
      const clean = createLiquidityTankIntent(authority());
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const claim = vi.spyOn(store, "claim");
      let seen = 0;
      const rewrite = (value: unknown) => {
        // The operation, or the unsigned intent (no binding hash yet).
        if (typeof value !== "object" || value === null || !(Object.hasOwn(value, "originAmount") ||
            (Object.hasOwn(value, "sourceAmountBaseUnits") && !Object.hasOwn(value, "bindingHash")))) {
          return;
        }
        seen += 1;
        // A hook that ignores the freeze throws in strict code; one that
        // respects it leaves the operation alone.
        if (route === "has" && !writable(value)) return;
        const operation = value as Record<string, unknown>;
        operation["destinationAddress"] = "attacker-address";
        operation["originAmount"] = "999000000";
        operation["destinationAmount"] = "999000000";
      };
      const input = runner({ store, adapter: h.adapter }).shared;
      const originalEntries = Object.entries;
      let result: unknown;
      const body = async () => {
        result = await advanceLiquidityTankSettlement(input);
      };
      if (route === "has") {
        await withSetHasHook(rewrite, body);
      } else {
        try {
          Object.entries = ((value: object) => {
            rewrite(value);
            return originalEntries(value);
          }) as typeof Object.entries;
          await body();
        } finally {
          Object.entries = originalEntries;
        }
      }
      expect(seen).toBeGreaterThan(0);
      if (route === "has") {
        // The hook respected the freeze: the intent is the clean one.
        expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
        expect(h.prepareSubmission.mock.calls[0]?.[0]).toEqual(clean);
        expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
        expect(h.broadcastRetained.mock.calls[0]?.[0].operationHash).toBe(clean.operationHash);
      } else {
        // The write to the frozen operation threw: refused before any claim.
        expect(result).toMatchObject({ status: "indeterminate" });
        expect(claim).not.toHaveBeenCalled();
        expect(h.prepareSubmission).not.toHaveBeenCalled();
        expect(h.broadcastRetained).not.toHaveBeenCalled();
      }
    });

    // Code review G4: a replaced `Set.prototype.has` hid the locked row from
    // the claim's presence check, so the core prepared again; with the store's
    // `conflict` also read as `recorded` through a replaced
    // `Object.getOwnPropertyDescriptor`, it broadcast the second submission.
    test.each([
      ["hidden", false],
      ["hidden, with the store's refusal read as recorded,", true],
    ] as const)("a locked row %s is neither prepared again nor broadcast", async (_label, forge) => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      run.setClock(D - 500);
      const second = secondAdapter();
      const recordSubmission = vi.spyOn(store, "recordSubmission");
      const originalHas = Set.prototype.has;
      const originalDescriptor = Object.getOwnPropertyDescriptor;
      let result: unknown;
      try {
        Set.prototype.has = function (this: Set<unknown>, value: unknown) {
          if (value === "submission" || value === "observation" || value === "recoveryFailure") return false;
          return Reflect.apply(originalHas, this, [value]) as boolean;
        };
        if (forge) {
          Object.getOwnPropertyDescriptor = function (target: unknown, key: PropertyKey) {
            const descriptor = Reflect.apply(originalDescriptor, Object, [target, key]) as
              PropertyDescriptor | undefined;
            return key === "status" && (descriptor?.value === "conflict" || descriptor?.value === "stale")
              ? { value: "recorded", writable: true, enumerable: true, configurable: true }
              : descriptor;
          } as typeof Object.getOwnPropertyDescriptor;
        }
        result = await advanceLiquidityTankSettlement({ ...run.shared, owner: "hidden", adapter: second.adapter });
      } finally {
        Set.prototype.has = originalHas;
        Object.getOwnPropertyDescriptor = originalDescriptor;
      }
      expect(result).toMatchObject(LOCK_CONTINUES);
      expect(recordSubmission).not.toHaveBeenCalled();
      expectNothingNew(second, h);
      await releasesLater(run, h);
    });

    // Daybreak's third scenario: one replaced `util.types.isProxy` deleted the
    // retained fields from the claim and rewrote the store's `conflict` for
    // the second submission as `recorded`, so the core broadcast it.
    test("a replaced util.types.isProxy can neither hide a locked row nor forge a store write", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      run.setClock(D - 500);
      const second = secondAdapter();
      const recordSubmission = vi.spyOn(store, "recordSubmission");
      const utilTypes = nodeTypes as typeof nodeTypes & { isProxy: (value: unknown) => boolean };
      const originalIsProxy = utilTypes.isProxy;
      const calls = vi.fn();
      let result: unknown;
      try {
        utilTypes.isProxy = (value: unknown) => {
          if (value !== null && typeof value === "object") {
            const record = value as Record<string, unknown>;
            if (record["status"] === "acquired" && Object.hasOwn(record, "submission")) {
              calls("hide");
              delete record["submission"];
              delete record["observation"];
              delete record["recoveryFailure"];
            } else if (record["status"] === "conflict" || record["status"] === "stale") {
              calls("forge");
              record["status"] = "recorded";
            }
          }
          return originalIsProxy(value);
        };
        result = await advanceLiquidityTankSettlement({ ...run.shared, owner: "proxied", adapter: second.adapter });
      } finally {
        utilTypes.isProxy = originalIsProxy;
      }
      // The shared snapshot still calls the live helper on its own copy of the
      // claim; the core's owned presence check then reads that copy as corrupt.
      expect(calls).toHaveBeenCalledWith("hide");
      expect(calls).not.toHaveBeenCalledWith("forge");
      expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" });
      expect(recordSubmission).not.toHaveBeenCalled();
      expectNothingNew(second, h);
      await releasesLater(run, h);
    });

    // Code review P3-1 and Daybreak's third scenario, write half: the store's
    // answer was read through the live helpers, so a refusal could read as
    // `recorded` and the refused submission was broadcast.
    test.each([
      ["Object.getOwnPropertyDescriptor", "descriptor"],
      ["util.types.isProxy", "isProxy"],
    ] as const)("a replaced %s cannot read a store's refusal of a submission as recorded", async (_label, route) => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const refusal = { status: "conflict", reason: "host-submission-refused" };
      store.recordSubmission = vi.fn(async () => ({ ...refusal }) as never);
      const input = runner({ store, adapter: h.adapter }).shared;
      const forged = vi.fn();
      const utilTypes = nodeTypes as typeof nodeTypes & { isProxy: (value: unknown) => boolean };
      const originalIsProxy = utilTypes.isProxy;
      const originalDescriptor = Object.getOwnPropertyDescriptor;
      let result: unknown;
      try {
        if (route === "descriptor") {
          Object.getOwnPropertyDescriptor = function (target: unknown, key: PropertyKey) {
            const descriptor = Reflect.apply(originalDescriptor, Object, [target, key]) as
              PropertyDescriptor | undefined;
            if (key !== "status" || descriptor?.value !== "conflict") return descriptor;
            forged();
            return { value: "recorded", writable: true, enumerable: true, configurable: true };
          } as typeof Object.getOwnPropertyDescriptor;
        } else {
          utilTypes.isProxy = (value: unknown) => {
            const record = value as Record<string, unknown> | null;
            if (record !== null && typeof record === "object" && record["status"] === "conflict") {
              forged();
              record["status"] = "recorded";
            }
            return originalIsProxy(value);
          };
        }
        result = await advanceLiquidityTankSettlement(input);
      } finally {
        Object.getOwnPropertyDescriptor = originalDescriptor;
        utilTypes.isProxy = originalIsProxy;
      }
      expect(forged).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-submission-persistence-uncertain",
      });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(store.recordSubmission).toHaveBeenCalledTimes(1);
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    // The same for the failure-retention echo: a store that answered
    // `recorded` without the evidence has not retained it, whatever a replaced
    // `Object.getOwnPropertyDescriptor` says.
    test("a replaced Object.getOwnPropertyDescriptor cannot supply a missing failure-retention echo", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      const dropped = { status: "recorded" };
      let sent: unknown;
      store.recordRecoveryFailure = vi.fn<LiquidityTankStore["recordRecoveryFailure"]>(async (input) => {
        sent = input.recoveryFailure;
        return dropped as never;
      });
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      const forged = vi.fn();
      const originalDescriptor = Object.getOwnPropertyDescriptor;
      let result: unknown;
      try {
        Object.getOwnPropertyDescriptor = function (target: unknown, key: PropertyKey) {
          if (target !== dropped || key !== "recoveryFailure") {
            return Reflect.apply(originalDescriptor, Object, [target, key]) as PropertyDescriptor | undefined;
          }
          forged();
          return { value: sent, writable: true, enumerable: true, configurable: true };
        } as typeof Object.getOwnPropertyDescriptor;
        result = await advanceLiquidityTankSettlement({ ...run.shared, owner: "echo" });
      } finally {
        Object.getOwnPropertyDescriptor = originalDescriptor;
      }
      expect(forged).not.toHaveBeenCalled();
      expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain" });
      expect(store.recordRecoveryFailure).toHaveBeenCalledTimes(1);
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    // Pinning, and kills a mutant that refuses supplementary-plane text: a
    // surrogate pair is well-formed and keyed by its UTF-8 bytes.
    test("a supplementary-plane character in authority strings is kept and keyed", async () => {
      const railId = "rail-\u{1F680}";
      const destinationAddress = "payee-\u{10348}";
      const key = sha256Hex(`dacs-liquidity-tank:v1:${JOB_ID}:${railId}:2`);
      const intent = createLiquidityTankIntent(authority({ railId, destinationAddress }));
      expect(intent).toMatchObject({ railId, destinationAddress, settlementKey: key });
      expect(liquidityTankSettlementKey({ jobId: JOB_ID, railId, phaseIndex: 2 })).toBe(key);
      const h = harness();
      await advanceLiquidityTankSettlement(runner({
        authority: authority({ railId, destinationAddress }),
        adapter: h.adapter,
      }).shared);
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.prepareSubmission.mock.calls[0]?.[0]).toEqual(intent);
    });

    // Kills a mutant that accepts a lone low surrogate: with the shared check
    // passed by a replaced `charCodeAt`, only the owned check refuses it.
    test("a replaced String.prototype.charCodeAt cannot admit a lone low surrogate", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const claim = vi.spyOn(store, "claim");
      const h = harness();
      const loneLow = authority({ railId: "rail-\udc00" });
      const originalCharCodeAt = String.prototype.charCodeAt;
      let outcome: unknown;
      let result: unknown;
      try {
        String.prototype.charCodeAt = () => 0x41;
        try {
          outcome = createLiquidityTankIntent(loneLow);
        } catch (error) {
          outcome = error;
        }
        result = await advanceLiquidityTankSettlement(runner({ authority: loneLow, store, adapter: h.adapter }).shared);
      } finally {
        String.prototype.charCodeAt = originalCharCodeAt;
      }
      const refused = "pay-cross-chain-liquidity-tank: authority must be stable data";
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe(refused);
      expect(result).toEqual({ status: "indeterminate", reason: refused });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    });

    // Pinning, and kills a mutant that strips at most one `=`: base64 with
    // both padding characters omitted is canonical, and the retained row is
    // rebroadcast exactly as stored.
    test.each(["YQ", "YQ=="])("a retained row with base64 %s is rebroadcast as stored", async (signed) => {
      const intent = createLiquidityTankIntent(authority());
      const unsigned = {
        submissionVersion: "1" as const,
        authorityHash: intent.bindingHash,
        operationHash: intent.operationHash,
        bridgeId: BRIDGE_ID,
        substrateTxHash: "retained-tx",
        signedSubmissionBase64: signed,
        preparedAt: 900,
      };
      const submission = Object.freeze({ ...unsigned, submissionHash: sha256Hex(canonicalize(unsigned)) });
      const store: LiquidityTankStore = {
        ...createInMemoryLiquidityTankStore(VOLATILE),
        claim: vi.fn(async () => ({
          status: "acquired" as const,
          intent,
          lease: { owner: "worker-a", generation: 1, expiresAt: 1_100 },
          submission,
          submissionRecordedAt: 1_000,
        })),
        isCurrent: vi.fn(async () => true),
        recordObservation: vi.fn(async () => ({ status: "recorded" as const })),
      };
      const h = harness();
      const result = await advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared);
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained.mock.calls[0]?.[0]).toEqual(submission);
      expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-status-transition-unresolved" });
    });
  });

  // Data-only prototype pollution, as a JSON merge writes it: plain values on
  // `Object.prototype`, no built-in replaced. A field a store or adapter result
  // does not hold must read as absent, never as the polluted value.
  describe("round 9", () => {
    const D = RECOVERY_DEADLINE_MS;
    const WAITING = {
      status: "waiting", reason: "liquidity-tank-pending", pendingDeadline: expect.any(Number), pastDeadline: false,
    } as const;

    /** Runs `body` with `fields` set on `Object.prototype`; removed in `finally`. */
    async function withPollution<T>(fields: Record<string, unknown>, body: () => Promise<T>): Promise<T> {
      const proto = Object.prototype as Record<string, unknown>;
      try {
        for (const [key, value] of Object.entries(fields)) proto[key] = value;
        return await body();
      } finally {
        for (const key of Object.keys(fields)) delete proto[key];
      }
    }

    function retainedSubmission(omit?: "substrateTxHash" | "submissionHash") {
      const intent = createLiquidityTankIntent(authority());
      const unsigned: Record<string, unknown> = {
        submissionVersion: "1",
        authorityHash: intent.bindingHash,
        operationHash: intent.operationHash,
        bridgeId: BRIDGE_ID,
        substrateTxHash: "retained-tx",
        signedSubmissionBase64: Buffer.from("signed", "utf8").toString("base64"),
        preparedAt: 900,
      };
      if (omit === "substrateTxHash") delete unsigned["substrateTxHash"];
      const submissionHash = sha256Hex(canonicalize(unsigned));
      return {
        intent,
        submissionHash,
        submission: omit === "submissionHash" ? unsigned : { ...unsigned, submissionHash },
      };
    }

    /** A store whose claim answers `claimed` for a lease the core holds. */
    function claimingStore(claimed: unknown): LiquidityTankStore {
      return {
        ...createInMemoryLiquidityTankStore(VOLATILE),
        claim: vi.fn(async () => claimed as never),
        isCurrent: vi.fn(async () => true),
        recordObservation: vi.fn(async () => ({ status: "recorded" as const })),
      };
    }

    // Code review P2 (probes R1 and R2): an unlocked pending holds no own
    // `lockTxHash` or `recoveryDeadline`, so both fell through to the
    // prototype and the core committed a terminal recovery expiry for a
    // transfer the bridge then paid.
    test.each([
      ["polluted", { lockTxHash: "forged-lock", recoveryDeadline: 500 }],
      ["unpolluted control", {}],
    ] as const)("%s: an unlocked pending stays waiting and later settles", async (_label, fields) => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const run = runner({ store, adapter: h.adapter, leaseDurationMs: 1 });
      const results = await withPollution(fields, async () => [
        await advanceLiquidityTankSettlement(run.shared),
        await advanceLiquidityTankSettlement(run.nextOwner()),
      ]);
      expect(results).toEqual([WAITING, WAITING]);
      expect(expire).not.toHaveBeenCalled();
      h.setObservation(completed(h.operationHash));
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
    });

    // The observation is validated on its own fields too: a failure without a
    // reason is refused, not reported as a permanent failure.
    test("a polluted Object.prototype cannot supply a failed observation's missing reason", async () => {
      const intent = createLiquidityTankIntent(authority());
      const h = harness({
        status: "failed", bridgeId: BRIDGE_ID, operationHash: intent.operationHash,
        history: ["empty", "failed"], observedAt: 2_000, authenticationHash: AUTH_HASH,
      } as unknown as LiquidityTankObservation);
      const result = await withPollution({ reason: "forged-failure" }, () =>
        advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared));
      expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-status-unavailable" });
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test.each([
      ["acquired", "lease", { owner: "worker-a", generation: 1, expiresAt: 1_100 }],
      ["acquired", "owner", "worker-a"],
      ["waiting", "lease", { owner: "worker-b", generation: 1, expiresAt: 1_100 }],
      ["waiting", "owner", "worker-b"],
    ] as const)("a polluted Object.prototype cannot supply the lease of a claim that is %s: missing %s", async (status, field, value) => {
      const intent = createLiquidityTankIntent(authority());
      const store = claimingStore(field === "lease"
        ? { status, intent }
        : { status, intent, lease: { generation: 1, expiresAt: 1_100 } });
      const h = harness();
      const result = await withPollution({ [field]: value }, () =>
        advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared));
      expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-settlement-store-lease-invalid" });
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    });

    test.each([
      ["settlement", undefined],
      ["lockTxHash", "txRef"],
      ["currency", "paymentAmount"],
      ["finalityObservedAt", "settlementFinality"],
      ["authenticationHash", ""],
    ] as const)("a polluted Object.prototype cannot supply a stored settlement's missing %s", async (field, holder) => {
      const intent = createLiquidityTankIntent(authority());
      const settlement: Record<string, Record<string, unknown> | string> = {
        txRef: {
          kind: "liquidity-tank", bridgeId: BRIDGE_ID, sourceChainId: 11_155_111, destChainId: 80_002,
          lockTxHash: "source-lock-tx", releaseTxHash: "destination-release-tx", recoveryDeadline: D,
        },
        paymentAmount: { amount: intent.amount, currency: intent.currency },
        settlementFinality: { model: "liquidity-tank", finalityObservedAt: 3_000 },
        authenticationHash: AUTH_HASH,
      };
      const value = holder === undefined
        ? settlement
        : holder === "" ? settlement[field] : (settlement[holder] as Record<string, unknown>)[field];
      if (holder === "") delete settlement[field];
      else if (holder !== undefined) delete (settlement[holder] as Record<string, unknown>)[field];
      const store = claimingStore(holder === undefined
        ? { status: "settled", intent }
        : { status: "settled", intent, settlement });
      const result = await withPollution({ [field]: value }, () =>
        advanceLiquidityTankSettlement(runner({ store }).shared));
      expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-stored-settlement-mismatch" });
    });

    test.each([
      "substrateTxHash",
      "submissionHash",
    ] as const)("a polluted Object.prototype cannot supply a retained submission's missing %s", async (field) => {
      const { intent, submission, submissionHash } = retainedSubmission(field);
      const store = claimingStore({
        status: "acquired", intent, lease: { owner: "worker-a", generation: 1, expiresAt: 1_100 }, submission,
        submissionRecordedAt: 1_000,
      });
      const h = harness();
      const result = await withPollution({ [field]: field === "submissionHash" ? submissionHash : "forged-tx" }, () =>
        advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared));
      expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" });
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("a polluted Object.prototype cannot supply retained recovery evidence's missing checkpoint", async () => {
      const { intent, submission } = retainedSubmission();
      const store = claimingStore({
        status: "recovery-expired", intent, submission, submissionRecordedAt: 1_000,
        observation: { status: "failed-after-lock", failure: failedAfterLock(intent.operationHash, D) },
      });
      const run = runner({ store });
      run.setClock(D);
      const result = await withPollution({ checkpoint: lockedPendingAt(intent.operationHash, 2_000) }, () =>
        advanceLiquidityTankSettlement(run.shared));
      expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" });
    });

    // Code review P3-2 (probe R3), kills mutant M3: a store's refusal held in
    // an accessor has a descriptor without an own `value`, so a polluted
    // `Object.prototype.value` must not read as the write status.
    test("a polluted Object.prototype.value cannot read an accessor refusal of a submission as recorded", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      store.recordSubmission = vi.fn(async () => ({ get status() { return "conflict"; } }) as never);
      const result = await withPollution({ value: "recorded" }, () =>
        advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared));
      expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-submission-persistence-uncertain" });
      expect(store.recordSubmission).toHaveBeenCalledTimes(1);
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    // The same for the failure-retention echo, kills mutant M4: an echo held
    // in an accessor is not retained evidence, even when a polluted
    // `Object.prototype.value` equals what was sent.
    test("a polluted Object.prototype.value cannot stand in for an accessor failure-retention echo", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      store.recordRecoveryFailure = vi.fn<LiquidityTankStore["recordRecoveryFailure"]>(async (input) => {
        const sent = input.recoveryFailure;
        return { status: "recorded", get recoveryFailure() { return sent; } } as never;
      });
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      const evidence = {
        status: "failed-after-lock",
        checkpoint: pending(h.operationHash, true),
        failure: failedAfterLock(h.operationHash, D - 200),
      };
      const result = await withPollution({ value: evidence }, () =>
        advanceLiquidityTankSettlement({ ...run.shared, owner: "echo" }));
      expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain" });
      expect(store.recordRecoveryFailure).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });
  });

  test("reference store accepts failure-after-lock expiry only for the exact checkpoint after the deadline", async () => {
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    await advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared);
    const intent = createLiquidityTankIntent(authority());
    const claim = await store.claim({
      intent,
      owner: "failure-expiry-racer",
      now: RECOVERY_DEADLINE_MS + 1,
      leaseDurationMs: 100,
    });
    if (claim.status !== "acquired" || claim.observation?.status !== "pending") {
      throw new Error("expected an acquired locked recovery checkpoint");
    }
    const checkpoint = claim.observation as Extract<
      LiquidityTankRecoveryEvidence,
      { status: "pending" }
    >;
    const write = {
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner: claim.lease.owner,
      generation: claim.lease.generation,
      now: RECOVERY_DEADLINE_MS + 1,
      expectedObservation: checkpoint,
    };
    const evidence = (failure: LiquidityTankObservation, lock = checkpoint) => ({
      status: "failed-after-lock",
      checkpoint: lock,
      failure,
    }) as LiquidityTankRecoveryEvidence;
    const timely = failedAfterLock(intent.operationHash, RECOVERY_DEADLINE_MS + 1);

    await expect(store.recordRecoveryExpired({
      ...write,
      observation: evidence(failedAfterLock(intent.operationHash, RECOVERY_DEADLINE_MS - 1)),
    })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
    await expect(store.recordRecoveryExpired({
      ...write,
      now: RECOVERY_DEADLINE_MS - 1,
      observation: evidence(timely),
    })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
    await expect(store.recordRecoveryExpired({
      ...write,
      observation: evidence(timely, { ...checkpoint, lockTxHash: "replacement-lock-tx" }),
    })).resolves.toEqual({
      status: "conflict",
      reason: "liquidity-tank-recovery-evidence-invalid",
    });
    await expect(store.recordRecoveryExpired({
      ...write,
      observation: evidence({ ...timely, history: ["empty", "completed", "failed"] } as unknown as LiquidityTankObservation),
    })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-evidence-invalid" });
    await expect(store.claim({
      intent,
      owner: "still-locked-inspector",
      now: RECOVERY_DEADLINE_MS + 101,
      leaseDurationMs: 100,
    })).resolves.toMatchObject({ status: "acquired", observation: { status: "pending" } });

    const winner = await store.claim({
      intent,
      owner: "failure-expiry-winner",
      now: RECOVERY_DEADLINE_MS + 202,
      leaseDurationMs: 100,
    });
    if (winner.status !== "acquired") throw new Error("expected an acquired lease");
    const winnerWrite = {
      ...write,
      owner: winner.lease.owner,
      generation: winner.lease.generation,
      now: RECOVERY_DEADLINE_MS + 202,
    };
    await expect(store.recordRecoveryFailure({ ...winnerWrite,
      recoveryFailure: evidence(timely) as Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>,
    })).resolves.toEqual({ status: "recorded", recoveryFailure: evidence(timely) });
    await expect(store.recordRecoveryExpired({ ...winnerWrite, observation: evidence(timely) }))
      .resolves.toEqual({ status: "recorded" });
    await expect(store.recordRecoveryExpired({ ...winnerWrite, observation: evidence(timely) }))
      .resolves.toEqual({ status: "existing" });
    await expect(store.recordObservation({
      ...winnerWrite,
      observation: completed(intent.operationHash, RECOVERY_DEADLINE_MS - 1),
    })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.claim({
      intent,
      owner: "expired-inspector",
      now: RECOVERY_DEADLINE_MS + 303,
      leaseDurationMs: 100,
    })).resolves.toMatchObject({
      status: "recovery-expired",
      observation: { status: "failed-after-lock", checkpoint: { observedAt: 2_000 } },
    });
  });

  test.each([
    ["drops the checkpoint", (operationHash: string) => pending(operationHash)],
    ["replaces the lock hash", (operationHash: string) => ({
      ...pending(operationHash, true),
      lockTxHash: "replacement-lock-tx",
    })],
    ["extends the recovery deadline", (operationHash: string) => ({
      ...pending(operationHash, true),
      recoveryDeadline: RECOVERY_DEADLINE_MS + 1_000,
    })],
    ["completes a replacement lock", (operationHash: string) => ({
      ...completed(operationHash),
      lockTxHash: "replacement-lock-tx",
    })],
  ] as const)("durable recovery checkpoint rejects a later observation that %s", async (_label, next) => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordObservation = vi.spyOn(store, "recordObservation");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    recordObservation.mockClear();
    h.broadcastRetained.mockClear();
    h.setObservation(next(h.operationHash) as LiquidityTankObservation);

    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      reason: "tank-locked-unreleased",
      recoveryDeadline: RECOVERY_DEADLINE_MS,
      txRef: { lockTxHash: "source-lock-tx", recoveryDeadline: RECOVERY_DEADLINE_MS },
    });
    expect(recordObservation).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("a completed observation cannot replace a retained recovery deadline", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordObservation = vi.spyOn(store, "recordObservation");
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const recordSettlement = vi.spyOn(store, "recordSettlement");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    recordObservation.mockClear();
    recordRecoveryExpired.mockClear();
    recordSettlement.mockClear();
    h.broadcastRetained.mockClear();
    run.setClock(RECOVERY_DEADLINE_MS - 1);
    h.setObservation(completed(
      h.operationHash,
      RECOVERY_DEADLINE_MS - 2,
      RECOVERY_DEADLINE_MS + 1,
    ));

    await expect(advanceLiquidityTankSettlement({
      ...run.shared,
      owner: "deadline-conflict-worker",
    })).resolves.toMatchObject({
      status: "settle-asymmetric",
      recoveryDeadline: RECOVERY_DEADLINE_MS,
    });
    expect(recordObservation).not.toHaveBeenCalled();
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
    expect(recordSettlement).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("rejects an unsafe recovery deadline without poisoning the durable checkpoint", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordObservation = vi.spyOn(store, "recordObservation");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    recordObservation.mockClear();
    h.setObservation({
      ...pending(h.operationHash, true),
      recoveryDeadline: Number.MAX_SAFE_INTEGER + 1,
    });

    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      recoveryDeadline: RECOVERY_DEADLINE_MS,
      txRef: { lockTxHash: "source-lock-tx", recoveryDeadline: RECOVERY_DEADLINE_MS },
    });
    expect(recordObservation).not.toHaveBeenCalled();
  });

  test("reference store preserves its recovery checkpoint after rejecting an extension", async () => {
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const intent = createLiquidityTankIntent(authority());
    const claim = await store.claim({
      intent,
      owner: "checkpoint-worker",
      now: 1_000,
      leaseDurationMs: 100,
    });
    expect(claim.status).toBe("acquired");
    if (claim.status !== "acquired") throw new Error("expected acquired reference-store lease");
    const writeAuthority = {
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner: claim.lease.owner,
      generation: claim.lease.generation,
      now: 1_000,
    };
    await expect(store.recordSubmission({
      ...writeAuthority,
      submission: {
        submissionVersion: "1",
        authorityHash: intent.bindingHash,
        operationHash: intent.operationHash,
        bridgeId: BRIDGE_ID,
        substrateTxHash: "demos-native-bridge-tx",
        signedSubmissionBase64: Buffer.from("signed-native-bridge").toString("base64"),
        preparedAt: 900,
        submissionHash: "e".repeat(64),
      },
    })).resolves.toEqual({ status: "recorded" });
    await expect(store.recordObservation({
      ...writeAuthority,
      observation: pending(intent.operationHash, true),
    })).resolves.toEqual({ status: "recorded" });
    await expect(store.recordObservation({
      ...writeAuthority,
      observation: {
        ...pending(intent.operationHash, true),
        recoveryDeadline: RECOVERY_DEADLINE_MS + 1_000,
      },
    })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.recordObservation({
      ...writeAuthority,
      observation: completed(intent.operationHash),
    })).resolves.toEqual({ status: "recorded" });
  });

  test("reference store atomically elects completion or expiry and rejects the loser", async () => {
    const seed = async (owner: string) => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      await advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared);
      const intent = createLiquidityTankIntent(authority());
      const claim = await store.claim({
        intent,
        owner,
        now: RECOVERY_DEADLINE_MS + 1,
        leaseDurationMs: 100,
      });
      if (claim.status !== "acquired" || claim.observation?.status !== "pending" ||
          claim.observation.lockTxHash === undefined ||
          claim.observation.recoveryDeadline === undefined) {
        throw new Error("expected an acquired locked recovery checkpoint");
      }
      const writeAuthority = {
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: claim.lease.owner,
        generation: claim.lease.generation,
        now: RECOVERY_DEADLINE_MS + 1,
      };
      // The bridge still reports the same lock as pending just past the deadline.
      const checkpoint = lockedPendingAt(intent.operationHash, RECOVERY_DEADLINE_MS + 1) as
        Extract<LiquidityTankRecoveryEvidence, { status: "pending" }>;
      await expect(store.recordObservation({ ...writeAuthority, observation: checkpoint }))
        .resolves.toEqual({ status: "recorded" });
      return { store, intent, checkpoint, writeAuthority };
    };

    const completionFirst = await seed("completion-racer");
    await expect(completionFirst.store.recordObservation({
      ...completionFirst.writeAuthority,
      observation: completed(
        completionFirst.intent.operationHash,
        RECOVERY_DEADLINE_MS - 1,
      ),
    })).resolves.toEqual({ status: "recorded" });
    await expect(completionFirst.store.recordRecoveryExpired({
      ...completionFirst.writeAuthority,
      now: RECOVERY_DEADLINE_MS + 1,
      expectedObservation: completionFirst.checkpoint,
      observation: completionFirst.checkpoint,
    })).resolves.toMatchObject({ status: "conflict" });
    await expect(completionFirst.store.claim({
      intent: completionFirst.intent,
      owner: "completion-inspector",
      now: RECOVERY_DEADLINE_MS + 101,
      leaseDurationMs: 100,
    })).resolves.toMatchObject({
      status: "acquired",
      observation: { status: "completed" },
    });

    const expiryFirst = await seed("expiry-racer");
    await expect(expiryFirst.store.recordRecoveryExpired({
      ...expiryFirst.writeAuthority,
      now: RECOVERY_DEADLINE_MS + 1,
      expectedObservation: expiryFirst.checkpoint,
      observation: expiryFirst.checkpoint,
    })).resolves.toEqual({ status: "recorded" });
    await expect(expiryFirst.store.recordObservation({
      ...expiryFirst.writeAuthority,
      observation: completed(expiryFirst.intent.operationHash, RECOVERY_DEADLINE_MS - 1),
    })).resolves.toMatchObject({ status: "conflict" });
    await expect(expiryFirst.store.claim({
      intent: expiryFirst.intent,
      owner: "expiry-inspector",
      now: RECOVERY_DEADLINE_MS + 101,
      leaseDurationMs: 100,
    })).resolves.toMatchObject({
      status: "recovery-expired",
      observation: {
        lockTxHash: "source-lock-tx",
        recoveryDeadline: RECOVERY_DEADLINE_MS,
      },
    });
  });

  test("deterministic bridge failure is permanent", async () => {
    const operationHash = createLiquidityTankIntent(authority()).operationHash;
    const h = harness({
      status: "failed",
      bridgeId: BRIDGE_ID,
      operationHash,
      history: ["empty", "pending", "failed"],
      observedAt: 3_000,
      authenticationHash: AUTH_HASH,
      reason: "validator shard rejected operation",
    });
    await expect(advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared)).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "validator shard rejected operation",
    });
  });

  test("invalid completed history never produces success", async () => {
    const h = harness();
    h.setAfterBroadcast({
      ...completed(h.operationHash),
      history: ["empty", "completed"],
    } as never);
    await expect(advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared))
      .resolves.toMatchObject({ status: "indeterminate" });
  });

  test("completed status without an authenticated recovery deadline never produces success", async () => {
    const h = harness();
    h.setAfterBroadcast({
      ...completed(h.operationHash),
      recoveryDeadline: undefined,
    } as never);
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordSettlement = vi.spyOn(store, "recordSettlement");

    await expect(advanceLiquidityTankSettlement(runner({ adapter: h.adapter, store }).shared))
      .resolves.toMatchObject({ status: "indeterminate" });
    expect(recordSettlement).not.toHaveBeenCalled();
  });

  test("bridge IDs are globally unique across local settlements", async () => {
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const firstHarness = harness();
    await advanceLiquidityTankSettlement(runner({ store, adapter: firstHarness.adapter }).shared);
    const secondHarness = harness();
    const second = runner({
      authority: authority({ jobId: SECOND_JOB_ID }),
      store,
      adapter: secondHarness.adapter,
      now: () => 2_000,
    });
    await expect(advanceLiquidityTankSettlement(second.shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-submission-persistence-uncertain",
    });
    expect(secondHarness.broadcastRetained).not.toHaveBeenCalled();
  });

  test("a live generation lease prevents concurrent submission", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness();
    const prepare = h.adapter.prepareSubmission;
    h.adapter.prepareSubmission = vi.fn(async (...args) => {
      await gate;
      return prepare(...args);
    });
    const run = runner({ adapter: h.adapter });
    const first = advanceLiquidityTankSettlement(run.shared);
    await vi.waitFor(() => expect(h.adapter.prepareSubmission).toHaveBeenCalledTimes(1));
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "worker-b" })).resolves.toEqual({
      status: "waiting",
      reason: "liquidity-tank-settlement-held",
    });
    release();
    await expect(first).resolves.toMatchObject({ status: "indeterminate" });
    expect(h.adapter.prepareSubmission).toHaveBeenCalledTimes(1);
  });

  test("lease loss during preparation cannot persist or broadcast stale bytes", async () => {
    let clock = 1_000;
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const recordSubmission = vi.spyOn(inner, "recordSubmission");
    const h = harness();
    h.adapter.prepareSubmission = vi.fn(async (intent) => {
      clock = 1_101;
      return {
        submissionVersion: "1",
        authorityHash: intent.bindingHash,
        operationHash: intent.operationHash,
        bridgeId: BRIDGE_ID,
        substrateTxHash: "stale-prepared-transaction",
        signedSubmissionBase64: Buffer.from("stale-signed-transaction").toString("base64"),
        preparedAt: 1_000,
      };
    });

    await expect(advanceLiquidityTankSettlement(runner({
      store: inner,
      adapter: h.adapter,
      now: () => clock,
      leaseDurationMs: 100,
    }).shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-submission-preparation-unavailable",
    });
    expect(recordSubmission).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("lease loss during observation cannot become a stale permanent outcome", async () => {
    let clock = 1_000;
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const recordObservation = vi.spyOn(inner, "recordObservation");
    const h = harness();
    h.adapter.observe = vi.fn(async (_intent, submission) => {
      clock = 1_101;
      return {
        status: "failed",
        bridgeId: submission.bridgeId,
        operationHash: submission.operationHash,
        history: ["empty", "failed"],
        observedAt: 1_000,
        authenticationHash: AUTH_HASH,
        reason: "stale permanent failure",
      };
    });

    await expect(advanceLiquidityTankSettlement(runner({
      store: inner,
      adapter: h.adapter,
      now: () => clock,
      leaseDurationMs: 100,
    }).shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-status-unavailable",
    });
    expect(recordObservation).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("lease loss during broadcast stops before a stale follow-up observation", async () => {
    let clock = 1_000;
    const h = harness();
    const staleBroadcast = vi.fn(async () => { clock = 1_101; });
    h.adapter.broadcastRetained = staleBroadcast;

    await expect(advanceLiquidityTankSettlement(runner({
      adapter: h.adapter,
      now: () => clock,
      leaseDurationMs: 100,
    }).shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-broadcast-outcome-uncertain",
    });
    expect(staleBroadcast).toHaveBeenCalledTimes(1);
    expect(h.observe).toHaveBeenCalledTimes(1);
  });

  test("captures store and adapter callbacks before the claim await", async () => {
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const h = harness();
    const replacement = vi.fn<LiquidityTankAdapter["prepareSubmission"]>(async () => {
      throw new Error("mutated callback must not run");
    });
    const isCurrent = vi.fn(inner.isCurrent.bind(inner));
    const replacementIsCurrent = vi.fn(async () => false);
    const store: LiquidityTankStore = {
      ...inner,
      isCurrent,
      async claim(input) {
        h.adapter.prepareSubmission = replacement;
        store.isCurrent = replacementIsCurrent;
        return inner.claim(input);
      },
    };

    await advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared);
    expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    expect(isCurrent).toHaveBeenCalled();
    expect(replacementIsCurrent).not.toHaveBeenCalled();
  });

  test.each(["store accessor", "store proxy", "adapter accessor", "adapter proxy"] as const)(
    "rejects a %s dependency without invoking it",
    async (kind) => {
      const touched = vi.fn();
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      let store: LiquidityTankStore = inner;
      let adapter: LiquidityTankAdapter = h.adapter;
      if (kind === "store accessor") {
        store = { ...inner };
        Object.defineProperty(store, "claim", {
          enumerable: true,
          configurable: true,
          get() {
            touched();
            return inner.claim;
          },
        });
      } else if (kind === "store proxy") {
        store = unreadableProxy(inner, touched);
      } else if (kind === "adapter accessor") {
        adapter = { ...h.adapter };
        Object.defineProperty(adapter, "prepareSubmission", {
          enumerable: true,
          configurable: true,
          get() {
            touched();
            return h.prepareSubmission;
          },
        });
      } else {
        adapter = unreadableProxy(h.adapter, touched);
      }
      const claim = vi.spyOn(inner, "claim");

      await expect(advanceLiquidityTankSettlement(runner({ store, adapter }).shared))
        .resolves.toMatchObject({ status: "indeterminate" });
      expect(touched).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    },
  );

  test("requires the effect fence read to return the literal boolean true", async () => {
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const recordSubmission = vi.spyOn(store, "recordSubmission");
    store.isCurrent = vi.fn(async () => ({ current: true }) as never);
    const h = harness();

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-submission-preparation-unavailable",
      });
    expect(recordSubmission).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid lease duration %s before store or adapter access",
    async (leaseDurationMs) => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const claim = vi.spyOn(store, "claim");
      const h = harness();
      await expect(advanceLiquidityTankSettlement(runner({
        store,
        adapter: h.adapter,
        leaseDurationMs,
      }).shared)).resolves.toMatchObject({ status: "indeterminate" });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["owner", { owner: "" }, "pay-cross-chain-liquidity-tank: owner must be a non-empty string"],
    ["clock", { now: "x" as never }, "pay-cross-chain-liquidity-tank: now must be a stable function"],
  ] as const)("rejects an invalid %s as indeterminate before store or adapter access", async (_label, config, reason) => {
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const claim = vi.spyOn(store, "claim");
    const h = harness();
    await expect(advanceLiquidityTankSettlement({
      ...runner({ store, adapter: h.adapter }).shared,
      ...config,
    })).resolves.toEqual({ status: "indeterminate", reason });
    expect(claim).not.toHaveBeenCalled();
    expect(h.prepareSubmission).not.toHaveBeenCalled();
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("rejects an overflowing lease expiry before claiming", async () => {
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const claim = vi.spyOn(store, "claim");
    const h = harness();

    await expect(advanceLiquidityTankSettlement(runner({
      store,
      adapter: h.adapter,
      now: () => Number.MAX_SAFE_INTEGER,
      leaseDurationMs: 1,
    }).shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-clock-invalid",
    });
    expect(claim).not.toHaveBeenCalled();
    expect(h.prepareSubmission).not.toHaveBeenCalled();
  });

  test("requires an acquired lease to have the exact authorized expiry", async () => {
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const store: LiquidityTankStore = {
      ...inner,
      claim: vi.fn<LiquidityTankStore["claim"]>(async (input) => ({
        status: "acquired" as const,
        intent: input.intent,
        lease: {
          owner: input.owner,
          generation: 1,
          expiresAt: input.now + input.leaseDurationMs + 1,
        },
      })),
    };
    const h = harness();

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-settlement-store-lease-invalid",
      });
    expect(h.prepareSubmission).not.toHaveBeenCalled();
  });

  test("reference store rejects unsafe lease arithmetic before retaining state", async () => {
    const store = createInMemoryLiquidityTankStore(VOLATILE);
    const intent = createLiquidityTankIntent(authority());
    await expect(store.claim({
      intent,
      owner: "overflow-worker",
      now: Number.MAX_SAFE_INTEGER,
      leaseDurationMs: 1,
    })).rejects.toThrow(/lease expiry must be a safe integer/);

    await expect(store.claim({
      intent,
      owner: "safe-worker",
      now: 1_000,
      leaseDurationMs: 100,
    })).resolves.toMatchObject({
      status: "acquired",
      lease: { owner: "safe-worker", generation: 1, expiresAt: 1_100 },
    });
  });

  test("rejects a settled claim whose durable result does not match the intent", async () => {
    const intent = createLiquidityTankIntent(authority());
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const store: LiquidityTankStore = {
      ...inner,
      async claim() {
        return {
          status: "settled" as const,
          intent,
          settlement: {
            txRef: {
              kind: "liquidity-tank",
              bridgeId: BRIDGE_ID,
              sourceChainId: intent.sourceChainId,
              destChainId: 1,
              lockTxHash: "source-lock-tx",
              releaseTxHash: "destination-release-tx",
              recoveryDeadline: RECOVERY_DEADLINE_MS,
            },
            paymentAmount: { amount: intent.amount, currency: "USDC" },
            settlementFinality: { model: "liquidity-tank", finalityObservedAt: 3_000 },
            authenticationHash: AUTH_HASH,
          },
        };
      },
    };
    const h = harness();

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-stored-settlement-mismatch",
    });
    expect(h.prepareSubmission).not.toHaveBeenCalled();
  });

  test.each([
    ["accepts", "at", RECOVERY_DEADLINE_MS],
    ["rejects", "a millisecond after", RECOVERY_DEADLINE_MS + 1],
  ] as const)("%s stored settlement evidence finalized %s its recovery deadline", async (verdict, _at, finality) => {
    const intent = createLiquidityTankIntent(authority());
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const store: LiquidityTankStore = {
      ...inner,
      async claim() {
        return {
          status: "settled" as const,
          intent,
          settlement: {
            txRef: {
              kind: "liquidity-tank" as const,
              bridgeId: BRIDGE_ID,
              sourceChainId: intent.sourceChainId,
              destChainId: intent.destinationChainId,
              lockTxHash: "source-lock-tx",
              releaseTxHash: "destination-release-tx",
              recoveryDeadline: RECOVERY_DEADLINE_MS,
            },
            paymentAmount: { amount: intent.amount, currency: "USDC" as const },
            settlementFinality: {
              model: "liquidity-tank" as const,
              finalityObservedAt: finality,
            },
            authenticationHash: AUTH_HASH,
          },
        };
      },
    };
    const h = harness();

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
      .resolves.toMatchObject(verdict === "accepts"
        ? { status: "settled", settlement: { settlementFinality: { finalityObservedAt: finality } } }
        : { status: "indeterminate", reason: "liquidity-tank-stored-settlement-mismatch" });
    expect(h.prepareSubmission).not.toHaveBeenCalled();
    expect(h.observe).not.toHaveBeenCalled();
  });

  test.each(["accessor", "proxy"] as const)(
    "rejects a stored settlement %s without invoking caller code",
    async (kind) => {
      const intent = createLiquidityTankIntent(authority());
      const touched = vi.fn();
      const settlement = {
        txRef: {
          kind: "liquidity-tank" as const,
          bridgeId: BRIDGE_ID,
          sourceChainId: intent.sourceChainId,
          destChainId: intent.destinationChainId,
          lockTxHash: "source-lock-tx",
          releaseTxHash: "destination-release-tx",
          recoveryDeadline: RECOVERY_DEADLINE_MS,
        },
        paymentAmount: { amount: intent.amount, currency: "USDC" as const },
        settlementFinality: { model: "liquidity-tank" as const, finalityObservedAt: 3_000 },
        authenticationHash: AUTH_HASH,
      };
      let hostile = settlement;
      if (kind === "accessor") {
        Object.defineProperty(settlement, "authenticationHash", {
          enumerable: true,
          configurable: true,
          get() {
            touched();
            return touched.mock.calls.length === 1 ? AUTH_HASH : RAIL_HASH;
          },
        });
      } else {
        hostile = unreadableProxy(settlement, touched);
      }
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const store: LiquidityTankStore = {
        ...inner,
        claim: vi.fn(async () => ({ status: "settled", intent, settlement: hostile }) as never),
      };
      const h = harness();

      await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
        .resolves.toMatchObject({ status: "indeterminate" });
      expect(touched).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    },
  );

  test("rejects a claim carrying a different durable intent", async () => {
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const store: LiquidityTankStore = {
      ...inner,
      async claim() {
        return {
          status: "waiting" as const,
          intent: createLiquidityTankIntent(authority({ jobId: DIFFERENT_JOB_ID })),
          lease: { owner: "other-worker", generation: 1, expiresAt: 2_000 },
        };
      },
    };
    const h = harness();

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-settlement-store-intent-mismatch",
    });
    expect(h.prepareSubmission).not.toHaveBeenCalled();
  });

  test("malformed store claims fail closed", async () => {
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const store: LiquidityTankStore = {
      ...inner,
      claim: vi.fn(async () => null as never),
    };
    const h = harness();

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-settlement-store-claim-invalid",
    });
    expect(h.prepareSubmission).not.toHaveBeenCalled();
  });

  test("a corrupt store claim is retry-safe indeterminate before any effects", async () => {
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const store: LiquidityTankStore = {
      ...inner,
      claim: vi.fn<LiquidityTankStore["claim"]>(async () => ({
        status: "corrupt",
        reason: "implementation-specific-corrupt-retained-row",
      })),
    };
    const isCurrent = vi.spyOn(store, "isCurrent");
    const recordSubmission = vi.spyOn(store, "recordSubmission");
    const recordObservation = vi.spyOn(store, "recordObservation");
    const recordSettlement = vi.spyOn(store, "recordSettlement");
    const h = harness();

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-retained-state-corrupt",
      });
    expect(isCurrent).not.toHaveBeenCalled();
    expect(recordSubmission).not.toHaveBeenCalled();
    expect(recordObservation).not.toHaveBeenCalled();
    expect(recordSettlement).not.toHaveBeenCalled();
    expect(h.prepareSubmission).not.toHaveBeenCalled();
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test.each(["own accessor", "inherited", "proxy"] as const)(
    "rejects a claim with %s status without invoking caller code",
    async (kind) => {
      const intent = createLiquidityTankIntent(authority());
      const touched = vi.fn();
      const fields = {
        intent,
        lease: { owner: "worker-a", generation: 1, expiresAt: 2_000 },
      };
      let claimValue: object;
      if (kind === "own accessor") {
        claimValue = { ...fields };
        Object.defineProperty(claimValue, "status", {
          enumerable: true,
          configurable: true,
          get() {
            touched();
            return touched.mock.calls.length === 1 ? "acquired" : "settled";
          },
        });
      } else if (kind === "inherited") {
        claimValue = Object.assign(Object.create({ status: "acquired" }), fields);
      } else {
        claimValue = unreadableProxy({ status: "acquired", ...fields }, touched);
      }
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const store: LiquidityTankStore = {
        ...inner,
        claim: vi.fn(async () => claimValue as never),
      };
      const h = harness();

      await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
        .resolves.toEqual({
          status: "indeterminate",
          reason: "liquidity-tank-settlement-store-claim-invalid",
        });
      expect(touched).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    },
  );

  test("stateful store claims must carry the exact durable intent", async () => {
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const store: LiquidityTankStore = {
      ...inner,
      claim: vi.fn(async () => ({
        status: "acquired",
        lease: { owner: "worker-a", generation: 1, expiresAt: 2_000 },
      }) as never),
    };
    const h = harness();

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-settlement-store-claim-invalid",
    });
    expect(h.prepareSubmission).not.toHaveBeenCalled();
  });
});

describe("round 10", () => {
  const D = RECOVERY_DEADLINE_MS;
  /** A realistic Unix-millisecond preparation time, five days before the deadline. */
  const PREPARED_AT_MS = D - 5 * 86_400_000;
  const DEADLINE_SECONDS = D / 1_000;

  /** Toy signed bytes a host decoder can read back: what the adapter actually signed. */
  function signedTransfer(
    bound: Readonly<ReturnType<typeof createLiquidityTankIntent>>,
    overrides: Partial<{ amountBaseUnits: string; destinationAddress: string; nonce: number }> = {},
  ) {
    const bytes = Buffer.from(JSON.stringify({
      bridgeId: BRIDGE_ID,
      amountBaseUnits: bound.sourceAmountBaseUnits,
      destinationAddress: bound.destinationAddress,
      asset: bound.sourceAsset,
      nonce: 1,
      ...overrides,
    }), "utf8");
    return {
      signedSubmissionBase64: bytes.toString("base64"),
      substrateTxHash: createHash("sha256").update(bytes).digest("hex"),
    };
  }

  /** A host verifier that decodes the toy bytes and compares them with the intent. */
  const decodingVerifier: LiquidityTankVerifier = {
    authenticateObservation: async () => true,
    verifySignedSubmission: async ({ intent: bound, submission }) => {
      const bytes = Buffer.from(submission.signedSubmissionBase64, "base64");
      if (createHash("sha256").update(bytes).digest("hex") !== submission.substrateTxHash) return false;
      const signed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      return signed["bridgeId"] === submission.bridgeId &&
        signed["amountBaseUnits"] === bound.sourceAmountBaseUnits &&
        signed["destinationAddress"] === bound.destinationAddress &&
        signed["asset"] === bound.sourceAsset;
    },
  };

  function signingHarness(
    overrides: Parameters<typeof signedTransfer>[1] = {},
    preparedAt = 900,
  ) {
    const h = harness();
    h.adapter.prepareSubmission = vi.fn<LiquidityTankAdapter["prepareSubmission"]>(async (bound) => ({
      submissionVersion: "1",
      authorityHash: bound.bindingHash,
      operationHash: bound.operationHash,
      bridgeId: BRIDGE_ID,
      preparedAt,
      ...signedTransfer(bound, overrides),
    }));
    return h;
  }

  describe("finding 1: the volatile store must be acknowledged", () => {
    test.each([
      ["no options", undefined],
      ["null", null],
      ["empty options", {}],
      ["false", { acknowledgeVolatile: false }],
      ["a truthy string", { acknowledgeVolatile: "true" }],
      ["1", { acknowledgeVolatile: 1 }],
      ["an inherited acknowledgement", Object.create({ acknowledgeVolatile: true })],
      ["an accessor", { get acknowledgeVolatile() { return true; } }],
      ["a proxy", new Proxy({ acknowledgeVolatile: true }, {})],
    ])("refuses %s with a TypeError naming the restart double-lock", (_label, options) => {
      expect(() => createInMemoryLiquidityTankStore(options as never)).toThrow(TypeError);
      expect(() => createInMemoryLiquidityTankStore(options as never))
        .toThrow(/loses it on restart.*double-lock the buyer's funds/s);
    });

    test("constructs with the literal acknowledgement", () => {
      expect(typeof createInMemoryLiquidityTankStore({ acknowledgeVolatile: true }).claim)
        .toBe("function");
    });
  });

  describe("finding 2: observations are used only when the host authenticates them", () => {
    test.each([
      ["no verifier", undefined],
      ["a verifier without authenticateObservation", { verifySignedSubmission: APPROVING_VERIFIER.verifySignedSubmission }],
      ["a non-function authenticateObservation", {
        authenticateObservation: true, verifySignedSubmission: APPROVING_VERIFIER.verifySignedSubmission,
      }],
    ])("with %s, a completed observation with arbitrary hashes is refused before any claim",
      async (_label, verifier) => {
        const h = harness(completed(createLiquidityTankIntent(authority()).operationHash));
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const claim = vi.spyOn(store, "claim");
        const run = runner({ store, adapter: h.adapter, verifier: verifier as never });
        await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
          status: "indeterminate",
          reason: "liquidity-tank-observation-authenticator-unavailable",
        });
        expect(claim).not.toHaveBeenCalled();
        expect(h.prepareSubmission).not.toHaveBeenCalled();
        expect(h.observe).not.toHaveBeenCalled();
        expect(h.broadcastRetained).not.toHaveBeenCalled();
      });

    test.each([
      ["false", async () => false],
      ["the string true", async () => "true"],
      ["1", () => 1],
      ["an object", async () => ({ authenticated: true })],
      // A throw or "unavailable" is an outage, not a refusal: see the final-review tests.
      ["undefined", async () => undefined],
      ["a differently cased unavailable", async () => "Unavailable"],
    ])("a completed observation with arbitrary hashes is refused when the hook answers %s",
      async (_label, answer) => {
        const h = harness();
        h.setAfterBroadcast({
          ...completed(h.operationHash),
          lockTxHash: "x",
          releaseTxHash: "y",
          authenticationHash: "f".repeat(64),
        });
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const recordSettlement = vi.spyOn(store, "recordSettlement");
        const recordObservation = vi.spyOn(store, "recordObservation");
        const verifier: LiquidityTankVerifier = {
          ...APPROVING_VERIFIER,
          authenticateObservation: vi.fn(async ({ observation }) =>
            observation.status === "completed" ? answer() as never : true),
        };
        const run = runner({ store, adapter: h.adapter, verifier });
        await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
          status: "indeterminate",
          reason: "liquidity-tank-observation-unauthenticated",
        });
        expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
        expect(recordSettlement).not.toHaveBeenCalled();
        expect(recordObservation).not.toHaveBeenCalledWith(expect.objectContaining({
          observation: expect.objectContaining({ status: "completed" }),
        }));
        await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
          status: "indeterminate",
          reason: "liquidity-tank-observation-unauthenticated",
        });
        expect(recordSettlement).not.toHaveBeenCalled();
      });

    test("an unauthenticated empty status is never followed by a broadcast", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordObservation = vi.spyOn(store, "recordObservation");
      await expect(advanceLiquidityTankSettlement(runner({
        store, adapter: h.adapter, verifier: { ...APPROVING_VERIFIER, authenticateObservation: async () => false },
      }).shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-observation-unauthenticated",
      });
      expect(h.observe).toHaveBeenCalledTimes(1);
      expect(recordObservation).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("the hook sees the exact intent, retained submission and observation", async () => {
      const h = harness();
      h.setAfterBroadcast(completed(h.operationHash));
      const authenticateObservation = vi.fn<LiquidityTankVerifier["authenticateObservation"]>(async () => true);
      await expect(advanceLiquidityTankSettlement(runner({
        adapter: h.adapter, verifier: { ...APPROVING_VERIFIER, authenticateObservation },
      }).shared)).resolves.toMatchObject({ status: "settled" });
      const intent = createLiquidityTankIntent(authority());
      expect(authenticateObservation.mock.calls.map(([input]) => input.observation.status))
        .toEqual(["empty", "completed"]);
      for (const [input] of authenticateObservation.mock.calls) {
        expect(canonicalize(input.intent)).toBe(canonicalize(intent));
        expect(input.submission).toMatchObject({ bridgeId: BRIDGE_ID, substrateTxHash: "demos-native-bridge-tx" });
      }
      expect(authenticateObservation.mock.calls[1]?.[0].observation)
        .toEqual(completed(h.operationHash));
    });

    test("a retained completion that no longer authenticates is not settled from", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      h.setAfterBroadcast(completed(h.operationHash));
      store.recordSettlement = vi.fn(async () => { throw new Error("crash before settlement write"); });
      const run = runner({ store, adapter: h.adapter });
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
        status: "indeterminate",
      });
      const recordSettlement = vi.fn<LiquidityTankStore["recordSettlement"]>(async () => ({ status: "recorded" }));
      store.recordSettlement = recordSettlement;
      h.observe.mockClear();
      await expect(advanceLiquidityTankSettlement({
        ...run.nextOwner(),
        verifier: { ...APPROVING_VERIFIER, authenticateObservation: async () => false },
      })).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-retained-observation-unauthenticated",
      });
      expect(recordSettlement).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
    });

    test("an unauthenticated bound failure past the deadline never commits failed-substrate", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      const run = await lockDurably(store, h);
      const recordRecoveryFailure = vi.spyOn(store, "recordRecoveryFailure");
      const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
      run.setClock(D + 1_000);
      h.setObservation(failedAfterLock(h.operationHash, D + 1_000));
      const rejectFailures: LiquidityTankVerifier = {
        ...APPROVING_VERIFIER,
        authenticateObservation: async ({ observation }) => observation.status !== "failed",
      };
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "f", verifier: rejectFailures }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-observation-unauthenticated" });
      expect(recordRecoveryFailure).not.toHaveBeenCalled();
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("retained failure evidence and a committed expiry are re-authenticated before use", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      const run = await lockDurably(store, h);
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "retain" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", bridgeStatus: "failed" });
      const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
      const rejectFailures: LiquidityTankVerifier = {
        ...APPROVING_VERIFIER,
        authenticateObservation: async ({ observation }) => observation.status !== "failed",
      };
      run.setClock(D + 1_000);
      h.setObservation({ status: "indeterminate", reason: "status API unavailable" });
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "expire", verifier: rejectFailures }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated" });
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
      run.setClock(D + 1_500);
      h.setObservation(failedAfterLock(h.operationHash, D + 1_500));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "expire-2" }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
      run.setClock(D + 2_000);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "replay", verifier: rejectFailures }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated" });
    });
  });

  describe("finding 3: signed bytes must sign exactly the intent", () => {
    test.each([
      ["a verifier without verifySignedSubmission", { authenticateObservation: APPROVING_VERIFIER.authenticateObservation }],
      ["a non-function verifySignedSubmission", {
        authenticateObservation: APPROVING_VERIFIER.authenticateObservation, verifySignedSubmission: "yes",
      }],
    ])("with %s, the core refuses before any claim", async (_label, verifier) => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const claim = vi.spyOn(store, "claim");
      await expect(advanceLiquidityTankSettlement(runner({
        store, adapter: h.adapter, verifier: verifier as never,
      }).shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-submission-verifier-unavailable",
      });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    });

    test.each([
      ["10x the amount", { amountBaseUnits: "12500000" }],
      ["another destination", { destinationAddress: "attacker-address" }],
    ])("an adapter that signs %s is refused: nothing is stored or broadcast", async (_label, signed) => {
      const h = signingHarness(signed);
      h.setAfterBroadcast(completed(h.operationHash));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordSubmission = vi.spyOn(store, "recordSubmission");
      const run = runner({ store, adapter: h.adapter, verifier: decodingVerifier });
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-signed-submission-unverified",
      });
      expect(h.adapter.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(recordSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      const later = await store.claim({
        intent: createLiquidityTankIntent(authority()), owner: "inspector", now: 5_000, leaseDurationMs: 100,
      });
      expect(later).toMatchObject({ status: "acquired" });
      expect(later).not.toHaveProperty("submission");
    });

    test("an adapter that signs exactly the intent passes the decoding verifier and settles", async () => {
      const h = signingHarness();
      h.setAfterBroadcast(completed(h.operationHash));
      await expect(advanceLiquidityTankSettlement(runner({
        adapter: h.adapter, verifier: decodingVerifier,
      }).shared)).resolves.toMatchObject({ status: "settled" });
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    });

    test.each([
      ["false", async () => false],
      ["the string true", async () => "true"],
      ["1", () => 1],
      // A throw or "unavailable" is an outage, not a refusal: see the final-review tests.
      ["undefined", async () => undefined],
      ["a differently cased unavailable", async () => "Unavailable"],
    ])("a hook answering %s stores and broadcasts nothing", async (_label, answer) => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordSubmission = vi.spyOn(store, "recordSubmission");
      await expect(advanceLiquidityTankSettlement(runner({
        store, adapter: h.adapter,
        verifier: { ...APPROVING_VERIFIER, verifySignedSubmission: answer as never },
      }).shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-signed-submission-unverified",
      });
      expect(recordSubmission).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("a retained submission that fails verification is never observed against or rebroadcast", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      const run = runner({ store, adapter: h.adapter });
      h.failNextBroadcast();
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
        status: "indeterminate", reason: "liquidity-tank-broadcast-outcome-uncertain",
      });
      h.observe.mockClear();
      h.broadcastRetained.mockClear();
      await expect(advanceLiquidityTankSettlement({
        ...run.nextOwner(),
        verifier: { ...APPROVING_VERIFIER, verifySignedSubmission: async () => false },
      })).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-signed-submission-unverified",
      });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });
  });

  describe("finding 4: the core never settles a durable late completion", () => {
    test("a store holding a completion finalized after the deadline gets expiry, not a settlement", async () => {
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      const run = await lockDurably(inner, h);
      h.observe.mockClear();
      const late = completed(h.operationHash, D + 1, D);
      const recordSettlement = vi.fn<LiquidityTankStore["recordSettlement"]>(async () => ({ status: "recorded" }));
      const recordRecoveryExpired = vi.fn<LiquidityTankStore["recordRecoveryExpired"]>(
        async () => ({ status: "recorded" }),
      );
      // A non-conforming store that kept a late completion as the durable observation.
      const store: LiquidityTankStore = {
        ...inner,
        claim: async (input) => {
          const claimed = await inner.claim(input);
          return claimed.status === "acquired" ? { ...claimed, observation: late } : claimed;
        },
        recordSettlement,
        recordRecoveryExpired,
      };
      run.setClock(D + 1_000);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "late", store }))
        .resolves.toEqual(releasedLate(D + 1, D));
      expect(recordSettlement).not.toHaveBeenCalled();
      expect(recordRecoveryExpired).toHaveBeenCalledWith(expect.objectContaining({
        observation: late, expectedObservation: late,
      }));
      expect(h.observe).not.toHaveBeenCalled();
    });

    test("the reference store names which terminal transition won", async () => {
      const intent = createLiquidityTankIntent(authority());
      const seed = async () => {
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const claim = await store.claim({ intent, owner: "w", now: D - 10, leaseDurationMs: 1_000 });
        if (claim.status !== "acquired") throw new Error("expected acquired");
        const write = {
          settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
          owner: "w", generation: claim.lease.generation, now: D - 10,
        };
        await store.recordSubmission({ ...write, submission: {
          submissionVersion: "1", authorityHash: intent.bindingHash, operationHash: intent.operationHash,
          bridgeId: BRIDGE_ID, substrateTxHash: "demos-native-bridge-tx",
          signedSubmissionBase64: Buffer.from("signed-native-bridge").toString("base64"),
          preparedAt: 900, submissionHash: "e".repeat(64),
        } });
        const checkpoint = lockedPendingAt(intent.operationHash, D + 1) as
          Extract<LiquidityTankRecoveryEvidence, { status: "pending" }>;
        await expect(store.recordObservation({ ...write, observation: checkpoint }))
          .resolves.toEqual({ status: "recorded" });
        return { store, write, checkpoint };
      };
      const timely = completed(intent.operationHash, D - 5);
      const settlement = {
        txRef: {
          kind: "liquidity-tank" as const, bridgeId: BRIDGE_ID, sourceChainId: 11_155_111, destChainId: 80_002,
          lockTxHash: "source-lock-tx", releaseTxHash: "destination-release-tx", recoveryDeadline: D,
        },
        paymentAmount: { amount: "1.25", currency: "USDC" as const },
        settlementFinality: { model: "liquidity-tank" as const, finalityObservedAt: D - 5 },
        authenticationHash: AUTH_HASH,
      };

      const settledFirst = await seed();
      await settledFirst.store.recordObservation({ ...settledFirst.write, observation: timely });
      await expect(settledFirst.store.recordSettlement({ ...settledFirst.write, settlement }))
        .resolves.toEqual({ status: "recorded" });
      await expect(settledFirst.store.recordRecoveryExpired({
        ...settledFirst.write, now: D + 1, expectedObservation: timely,
        observation: completed(intent.operationHash, D + 1),
      })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-lost-to-settlement" });

      const completedFirst = await seed();
      await completedFirst.store.recordObservation({ ...completedFirst.write, observation: timely });
      await expect(completedFirst.store.recordRecoveryExpired({
        ...completedFirst.write, now: D + 1, expectedObservation: timely,
        observation: completed(intent.operationHash, D + 1),
      })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-lost-to-completion" });

      const expiredFirst = await seed();
      await expect(expiredFirst.store.recordRecoveryExpired({
        ...expiredFirst.write, now: D + 1, expectedObservation: expiredFirst.checkpoint,
        observation: expiredFirst.checkpoint,
      })).resolves.toEqual({ status: "recorded" });
      await expect(expiredFirst.store.recordSettlement({ ...expiredFirst.write, settlement }))
        .resolves.toEqual({
          status: "conflict", reason: "liquidity-tank-settlement-lost-to-recovery-expiry",
        });
    });
  });

  describe("finding 5: a recovery deadline before the submission was prepared is refused", () => {
    test("a seconds-scale deadline on a fresh lock never expires it (probe R2)", async () => {
      const h = signingHarness({}, PREPARED_AT_MS);
      const lockedAt = PREPARED_AT_MS + 1_000;
      h.setAfterBroadcast({
        ...pending(h.operationHash, true, DEADLINE_SECONDS, lockedAt),
      });
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordObservation = vi.spyOn(store, "recordObservation");
      const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
      const run = runner({ store, adapter: h.adapter });
      run.setClock(lockedAt + 1);
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-recovery-deadline-before-preparation",
      });
      expect(recordObservation).not.toHaveBeenCalledWith(expect.objectContaining({
        observation: expect.objectContaining({ status: "pending" }),
      }));
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
      // A later read in milliseconds still settles the same submission.
      h.setObservation(completed(h.operationHash, lockedAt + 2_000));
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        status: "settled",
      });
      expect(h.adapter.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    });

    test("a completion carrying a seconds-scale deadline is neither expired nor settled", async () => {
      const h = signingHarness({}, PREPARED_AT_MS);
      h.setAfterBroadcast(completed(h.operationHash, PREPARED_AT_MS + 2_000, DEADLINE_SECONDS));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
      const recordSettlement = vi.spyOn(store, "recordSettlement");
      const run = runner({ store, adapter: h.adapter });
      run.setClock(PREPARED_AT_MS + 3_000);
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-recovery-deadline-before-preparation",
      });
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
      expect(recordSettlement).not.toHaveBeenCalled();
    });

    test("legacy seconds-scale rows fail closed with the same reason and no effects", async () => {
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const h = signingHarness({}, PREPARED_AT_MS);
      h.setAfterBroadcast(lockedPendingAt(h.operationHash, PREPARED_AT_MS + 1_000));
      const run = runner({ store: inner, adapter: h.adapter, leaseDurationMs: 1 });
      run.setClock(PREPARED_AT_MS + 1_000);
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
        status: "settle-asymmetric",
      });
      h.observe.mockClear();
      h.broadcastRetained.mockClear();
      const legacy = (observation: Record<string, unknown>) => ({
        ...observation, recoveryDeadline: DEADLINE_SECONDS,
      });
      const recordRecoveryExpired = vi.spyOn(inner, "recordRecoveryExpired");
      const acquired: LiquidityTankStore = {
        ...inner,
        claim: async (input) => {
          const claimed = await inner.claim(input);
          return claimed.status === "acquired" && claimed.observation
            ? { ...claimed, observation: legacy(claimed.observation) as never }
            : claimed;
        },
      };
      run.setClock(PREPARED_AT_MS + 5_000);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "legacy", store: acquired }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-recovery-deadline-before-preparation" });
      const expired: LiquidityTankStore = {
        ...inner,
        claim: async (input) => {
          const claimed = await inner.claim(input);
          if (claimed.status !== "acquired" || !claimed.submission || !claimed.observation) return claimed;
          return {
            status: "recovery-expired",
            intent: claimed.intent,
            submission: claimed.submission,
            submissionRecordedAt: claimed.submissionRecordedAt as number,
            observation: legacy(claimed.observation) as never,
          };
        },
      };
      run.setClock(PREPARED_AT_MS + 10_000);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "legacy-expired", store: expired }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-recovery-deadline-before-preparation" });
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
    });
  });

  describe("finding 8: a crash between signing and the submission write", () => {
    test("leads to a fresh signature, and the first bytes are never broadcast", async () => {
      const h = harness();
      let signed = 0;
      h.adapter.prepareSubmission = vi.fn<LiquidityTankAdapter["prepareSubmission"]>(async (bound) => {
        signed += 1;
        return {
          submissionVersion: "1",
          authorityHash: bound.bindingHash,
          operationHash: bound.operationHash,
          bridgeId: BRIDGE_ID,
          preparedAt: 900,
          ...signedTransfer(bound, { nonce: signed }),
        };
      });
      h.setAfterBroadcast(completed(h.operationHash));
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      let crashed = false;
      const store: LiquidityTankStore = {
        ...inner,
        recordSubmission: async (input) => {
          if (!crashed) {
            crashed = true;
            throw new Error("worker stopped before the write committed");
          }
          return inner.recordSubmission(input);
        },
      };
      const run = runner({ store, adapter: h.adapter, verifier: decodingVerifier });
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-submission-persistence-uncertain",
      });
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      const first = signedTransfer(createLiquidityTankIntent(authority()), { nonce: 1 });
      const second = signedTransfer(createLiquidityTankIntent(authority()), { nonce: 2 });
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        status: "settled",
      });
      expect(h.adapter.prepareSubmission).toHaveBeenCalledTimes(2);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained.mock.calls.map(([submission]) => submission.signedSubmissionBase64))
        .toEqual([second.signedSubmissionBase64]);
      expect(h.broadcastRetained.mock.calls.map(([submission]) => submission.signedSubmissionBase64))
        .not.toContain(first.signedSubmissionBase64);
    });
  });

  describe("finding 9: the reference store re-checks lease expiry on ordinary writes", () => {
    test("submission, observation and settlement writes at or after expiresAt are stale", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const intent = createLiquidityTankIntent(authority());
      const claim = await store.claim({ intent, owner: "w", now: 1_000, leaseDurationMs: 100 });
      if (claim.status !== "acquired") throw new Error("expected acquired");
      const write = {
        settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
        owner: "w", generation: claim.lease.generation, now: 1_000,
      };
      const expired = { ...write, now: claim.lease.expiresAt };
      const submission = {
        submissionVersion: "1" as const, authorityHash: intent.bindingHash, operationHash: intent.operationHash,
        bridgeId: BRIDGE_ID, substrateTxHash: "demos-native-bridge-tx",
        signedSubmissionBase64: Buffer.from("signed-native-bridge").toString("base64"),
        preparedAt: 900, submissionHash: "e".repeat(64),
      };
      await expect(store.recordSubmission({ ...expired, submission }))
        .resolves.toEqual({ status: "stale", reason: "expired-lease" });
      await expect(store.recordSubmission({ ...write, submission })).resolves.toEqual({ status: "recorded" });
      await expect(store.recordObservation({ ...expired, observation: completed(intent.operationHash) }))
        .resolves.toEqual({ status: "stale", reason: "expired-lease" });
      await expect(store.recordObservation({ ...write, observation: completed(intent.operationHash) }))
        .resolves.toEqual({ status: "recorded" });
      const settlement = {
        txRef: {
          kind: "liquidity-tank" as const, bridgeId: BRIDGE_ID, sourceChainId: 11_155_111, destChainId: 80_002,
          lockTxHash: "source-lock-tx", releaseTxHash: "destination-release-tx", recoveryDeadline: D,
        },
        paymentAmount: { amount: "1.25", currency: "USDC" as const },
        settlementFinality: { model: "liquidity-tank" as const, finalityObservedAt: 3_000 },
        authenticationHash: AUTH_HASH,
      };
      await expect(store.recordSettlement({ ...expired, settlement }))
        .resolves.toEqual({ status: "stale", reason: "expired-lease" });
      await expect(store.recordSettlement({ ...write, settlement })).resolves.toEqual({ status: "recorded" });
    });

    test("the core passes its clock reading to every ordinary write", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const writes = [
        vi.spyOn(store, "recordSubmission"),
        vi.spyOn(store, "recordObservation"),
        vi.spyOn(store, "recordSettlement"),
      ];
      const h = harness();
      h.setAfterBroadcast(completed(h.operationHash));
      await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
        .resolves.toMatchObject({ status: "settled" });
      for (const write of writes) {
        expect(write).toHaveBeenCalled();
        for (const [input] of write.mock.calls) expect(input.now).toBe(1_000);
      }
    });
  });
});

describe("round 11", () => {
  const D = RECOVERY_DEADLINE_MS;
  /** A Unix-millisecond preparation time, five days before the deadline. */
  const PREPARED_AT_MS = D - 5 * 86_400_000;
  const seconds = (ms: number) => Math.floor(ms / 1_000);

  /** An adapter stamping `PREPARED_AT_MS`, with the host clock one second later. */
  function preparedRun(store = createInMemoryLiquidityTankStore(VOLATILE)) {
    const h = harness();
    h.setPreparedAt(PREPARED_AT_MS);
    const run = runner({ store, adapter: h.adapter, leaseDurationMs: 1 });
    run.setClock(PREPARED_AT_MS + 1_000);
    return { h, run, store };
  }

  describe("finding 3: bridge times in another unit are refused", () => {
    test("a submission and deadline both in seconds are never stored, broadcast or expired (probe U1)", async () => {
      const { h, run, store } = preparedRun();
      h.setPreparedAt(seconds(PREPARED_AT_MS));
      h.setAfterBroadcast(pending(h.operationHash, true, seconds(D), PREPARED_AT_MS + 1_000));
      const recordSubmission = vi.spyOn(store, "recordSubmission");
      const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-preparation-time-off-host-clock",
      });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(recordSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
      // Once the adapter stamps milliseconds, the next owner signs afresh and locks.
      h.setPreparedAt(PREPARED_AT_MS + 1_000);
      h.setAfterBroadcast(lockedPendingAt(h.operationHash, PREPARED_AT_MS + 2_000));
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased", pastDeadline: false,
      });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(2);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    });

    test.each([
      ["a minute before the host clock", (now: number) => now - 60_000, true],
      ["more than a minute before it", (now: number) => now - 60_001, false],
      ["a minute after it", (now: number) => now + 60_000, true],
      ["more than a minute after it", (now: number) => now + 60_001, false],
      ["in microseconds", (now: number) => now * 1_000, false],
    ])("a fresh preparedAt %s is used only inside the window", async (_label, stamp, used) => {
      const { h, run, store } = preparedRun();
      const preparedAt = stamp(PREPARED_AT_MS + 1_000);
      h.setPreparedAt(preparedAt);
      h.setAfterBroadcast(lockedPendingAt(h.operationHash, Math.max(preparedAt, PREPARED_AT_MS + 1_000)));
      const recordSubmission = vi.spyOn(store, "recordSubmission");
      const result = await advanceLiquidityTankSettlement(run.shared);
      if (used) {
        expect(result).toMatchObject({ status: "settle-asymmetric" });
        expect(recordSubmission).toHaveBeenCalledWith(expect.objectContaining({
          submission: expect.objectContaining({ preparedAt }),
        }));
      } else {
        expect(result).toEqual({
          status: "indeterminate",
          reason: "liquidity-tank-preparation-time-off-host-clock",
        });
        expect(recordSubmission).not.toHaveBeenCalled();
        expect(h.broadcastRetained).not.toHaveBeenCalled();
      }
    });

    test("a seconds-scale finalityObservedAt never settles a release that missed the deadline (probe U2)", async () => {
      const { h, run, store } = preparedRun();
      h.setAfterBroadcast(lockedPendingAt(h.operationHash, PREPARED_AT_MS + 1_000));
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
        status: "settle-asymmetric",
      });
      const recordObservation = vi.spyOn(store, "recordObservation");
      const recordSettlement = vi.spyOn(store, "recordSettlement");
      const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
      // The release finalized 100 s after the deadline; the adapter sent the block time in seconds.
      h.setObservation(completed(h.operationHash, seconds(D + 100_000)));
      run.setClock(D + 200_000);
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-finality-before-preparation",
      });
      expect(recordObservation).not.toHaveBeenCalled();
      expect(recordSettlement).not.toHaveBeenCalled();
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
      // The same release sent in milliseconds is late, and the lock expires.
      h.setObservation(completed(h.operationHash, D + 100_000));
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        status: "failed", errorClass: "failed-substrate",
      });
      expect(recordSettlement).not.toHaveBeenCalled();
    });

    test("a seconds-scale observedAt on a locked pending is refused, not kept as the checkpoint", async () => {
      const { h, run, store } = preparedRun();
      const recordObservation = vi.spyOn(store, "recordObservation");
      h.setAfterBroadcast(lockedPendingAt(h.operationHash, seconds(PREPARED_AT_MS + 1_000)));
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-lock-observed-before-preparation",
      });
      expect(recordObservation).not.toHaveBeenCalledWith(expect.objectContaining({
        observation: expect.objectContaining({ status: "pending" }),
      }));
      // A later read in milliseconds locks the same submission.
      h.setObservation(lockedPendingAt(h.operationHash, PREPARED_AT_MS + 2_000));
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased",
      });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    });

    test("retained rows timed before preparation are refused with no effects", async () => {
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const { h, run } = preparedRun(inner);
      h.setAfterBroadcast(lockedPendingAt(h.operationHash, PREPARED_AT_MS + 1_000));
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
        status: "settle-asymmetric",
      });
      h.observe.mockClear();
      h.broadcastRetained.mockClear();
      const recordSettlement = vi.spyOn(inner, "recordSettlement");
      const recordRecoveryExpired = vi.spyOn(inner, "recordRecoveryExpired");
      const holding = (observation: LiquidityTankObservation): LiquidityTankStore => ({
        ...inner,
        claim: async (input) => {
          const claimed = await inner.claim(input);
          return claimed.status === "acquired" ? { ...claimed, observation: observation as never } : claimed;
        },
      });
      // Read as timely against the deadline, though finalized 100 s after it.
      const lateInSeconds = completed(h.operationHash, seconds(D + 100_000));
      run.setClock(D + 200_000);
      await expect(advanceLiquidityTankSettlement({ ...run.nextOwner(), store: holding(lateInSeconds) }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-finality-before-preparation" });
      await expect(advanceLiquidityTankSettlement({
        ...run.nextOwner(),
        store: holding(lockedPendingAt(h.operationHash, seconds(PREPARED_AT_MS + 1_000))),
      })).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-lock-observed-before-preparation" });
      const expired: LiquidityTankStore = {
        ...inner,
        claim: async (input) => {
          const claimed = await inner.claim(input);
          if (claimed.status !== "acquired" || !claimed.submission) return claimed;
          return {
            status: "recovery-expired",
            intent: claimed.intent,
            submission: claimed.submission,
            submissionRecordedAt: claimed.submissionRecordedAt as number,
            observation: lateInSeconds as never,
          };
        },
      };
      await expect(advanceLiquidityTankSettlement({ ...run.nextOwner(), store: expired }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-finality-before-preparation" });
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      expect(recordSettlement).not.toHaveBeenCalled();
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
    });

    test("the reference store refuses an observation timed before its submission was prepared", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const intent = createLiquidityTankIntent(authority());
      const claim = await store.claim({ intent, owner: "w", now: PREPARED_AT_MS, leaseDurationMs: 1_000 });
      if (claim.status !== "acquired") throw new Error("expected acquired");
      const write = {
        settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
        owner: "w", generation: claim.lease.generation, now: PREPARED_AT_MS,
      };
      await expect(store.recordSubmission({ ...write, submission: {
        submissionVersion: "1", authorityHash: intent.bindingHash, operationHash: intent.operationHash,
        bridgeId: BRIDGE_ID, substrateTxHash: "demos-native-bridge-tx",
        signedSubmissionBase64: Buffer.from("signed-native-bridge").toString("base64"),
        preparedAt: PREPARED_AT_MS, submissionHash: "e".repeat(64),
      } })).resolves.toEqual({ status: "recorded" });
      for (const early of [
        lockedPendingAt(intent.operationHash, seconds(PREPARED_AT_MS)),
        completed(intent.operationHash, seconds(D - 1_000)),
      ]) {
        await expect(store.recordObservation({ ...write, observation: early }))
          .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-observation-invalid" });
      }
      await expect(store.recordObservation({ ...write, observation: completed(intent.operationHash, D - 1_000) }))
        .resolves.toEqual({ status: "recorded" });
    });
  });

  describe("development-only settled replay and authenticated expiry replay", () => {
    test("development settled replay uses the store, while expiry rechecks submission and observation", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      h.setAfterBroadcast(completed(h.operationHash));
      const run = runner({ store, adapter: h.adapter });
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({ status: "settled" });
      const refusing = {
        authenticateObservation: vi.fn(async () => false),
        verifySignedSubmission: vi.fn(async () => false),
      } satisfies LiquidityTankVerifier;
      await expect(advanceLiquidityTankSettlement({ ...run.nextOwner(), verifier: refusing }))
        .resolves.toMatchObject({ status: "settled", settlement: { txRef: { bridgeId: BRIDGE_ID } } });
      expect(refusing.authenticateObservation).not.toHaveBeenCalled();
      expect(refusing.verifySignedSubmission).not.toHaveBeenCalled();

      const expiredStore = createInMemoryLiquidityTankStore(VOLATILE);
      const expiring = harness();
      const expiredRun = await lockDurably(expiredStore, expiring);
      expiredRun.setClock(D + 1_000);
      expiring.setObservation(lockedPendingAt(expiring.operationHash, D + 1_000));
      await expect(advanceLiquidityTankSettlement({ ...expiredRun.shared, owner: "expire" }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
      expiredRun.setClock(D + 2_000);
      await expect(advanceLiquidityTankSettlement({ ...expiredRun.shared, owner: "replay", verifier: refusing }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-signed-submission-unverified" });
      expect(refusing.verifySignedSubmission).toHaveBeenCalled();
      refusing.verifySignedSubmission.mockResolvedValue(true);
      await expect(advanceLiquidityTankSettlement({ ...expiredRun.shared, owner: "replay-auth", verifier: refusing }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated" });
      expect(refusing.authenticateObservation).toHaveBeenCalled();
    });
  });
});

describe("round 12", () => {
  const HOST_MS = 1_785_000_000_000;
  const DEADLINE_MS = HOST_MS + 5 * 86_400_000;
  const seconds = (ms: number) => Math.floor(ms / 1_000);
  const operationHash = createLiquidityTankIntent(authority()).operationHash;

  function retainedSubmission(preparedAt: number) {
    const intent = createLiquidityTankIntent(authority());
    const unsigned = {
      submissionVersion: "1" as const,
      authorityHash: intent.bindingHash,
      operationHash: intent.operationHash,
      bridgeId: BRIDGE_ID,
      substrateTxHash: "demos-native-bridge-tx",
      signedSubmissionBase64: Buffer.from("signed-native-bridge", "utf8").toString("base64"),
      preparedAt,
    };
    return { ...unsigned, submissionHash: sha256Hex(canonicalize(unsigned)) };
  }

  /**
   * A reference store whose earlier owner recorded `preparedAt`'s submission at
   * `recordedAt`, its receipt. `observation`, if any, is held in the claims
   * rather than written, so a row the reference store would refuse is
   * presented too.
   */
  async function retainedRow(preparedAt: number, recordedAt: number, observation?: LiquidityTankObservation) {
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const intent = createLiquidityTankIntent(authority());
    const seeded = await inner.claim({ intent, owner: "first-owner", now: recordedAt, leaseDurationMs: 1 });
    if (seeded.status !== "acquired") throw new Error("expected acquired");
    await expect(inner.recordSubmission({
      settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
      owner: "first-owner", generation: seeded.lease.generation, now: recordedAt,
      submission: retainedSubmission(preparedAt),
    })).resolves.toEqual({ status: "recorded" });
    const store: LiquidityTankStore = {
      ...inner,
      claim: async (input) => {
        const claimed = await inner.claim(input);
        return claimed.status === "acquired" && observation
          ? { ...claimed, observation: observation as never }
          : claimed;
      },
    };
    return { inner, store };
  }

  /** A resumed worker at `at` on `store`, with spies on every store write, adapter call and hook. */
  function resume(store: LiquidityTankStore, observation: LiquidityTankObservation, at = HOST_MS) {
    const h = harness(observation);
    const verifier = {
      authenticateObservation: vi.fn(async () => true),
      verifySignedSubmission: vi.fn(async () => true),
    } satisfies LiquidityTankVerifier;
    const writes = (["recordSubmission", "recordObservation", "recordRecoveryFailure",
      "recordRecoveryExpired", "recordSettlement"] as const).map((method) => vi.spyOn(store, method));
    const run = runner({ store, adapter: h.adapter, verifier, leaseDurationMs: 1_000 });
    run.setClock(at);
    const untouched = () => {
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    };
    return { h, verifier, run, untouched };
  }

  /** `claimed` without its receipt. */
  const withoutReceipt = <T extends object>(claimed: T): T => {
    const { submissionRecordedAt: _dropped, ...rest } = claimed as T & { submissionRecordedAt?: number };
    return rest as T;
  };

  describe("finding 1: a retained preparedAt is used only within the window of its durable receipt", () => {
    test("Daybreak's probe: a retained seconds-scale preparedAt and deadline never expire a millisecond lock", async () => {
      // Written through the reference store, as in the probe: neither the
      // deadline nor the observation falls before the seconds-scale preparedAt.
      const intent = createLiquidityTankIntent(authority());
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const seedNow = HOST_MS - 100;
      const seeded = await store.claim({ intent, owner: "seed", now: seedNow, leaseDurationMs: 10 });
      if (seeded.status !== "acquired") throw new Error("expected acquired");
      const write = {
        settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
        owner: "seed", generation: seeded.lease.generation, now: seedNow,
      };
      const lock = pending(intent.operationHash, true, seconds(DEADLINE_MS), HOST_MS);
      await expect(store.recordSubmission({ ...write, submission: retainedSubmission(seconds(HOST_MS)) }))
        .resolves.toEqual({ status: "recorded" });
      await expect(store.recordObservation({ ...write, observation: lock })).resolves.toEqual({ status: "recorded" });
      const { verifier, run, untouched } = resume(store, lock);
      // Retryable, never terminal: not now, and not after the real deadline either.
      for (const at of [HOST_MS, DEADLINE_MS + 1_000]) {
        run.setClock(at);
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: `resume-${at}` })).resolves.toEqual({
          status: "indeterminate", reason: "liquidity-tank-preparation-time-off-receipt",
        });
      }
      untouched();
      expect(verifier.verifySignedSubmission).not.toHaveBeenCalled();
      const inspected = await store.claim({ intent, owner: "inspector", now: DEADLINE_MS + 10_000, leaseDurationMs: 1 });
      expect(inspected).toMatchObject({ status: "acquired", submissionRecordedAt: seedNow, observation: lock });
    });

    test.each([
      ["seconds preparedAt, millisecond receipt, seconds deadline (the probe)",
        seconds(HOST_MS), HOST_MS, pending(operationHash, true, seconds(DEADLINE_MS), HOST_MS),
        "liquidity-tank-preparation-time-off-receipt"],
      ["seconds preparedAt, millisecond receipt, millisecond deadline",
        seconds(HOST_MS), HOST_MS, pending(operationHash, true, DEADLINE_MS, HOST_MS),
        "liquidity-tank-preparation-time-off-receipt"],
      ["millisecond preparedAt, seconds receipt",
        HOST_MS, seconds(HOST_MS), pending(operationHash, true, DEADLINE_MS, HOST_MS),
        "liquidity-tank-preparation-time-off-receipt"],
      ["millisecond preparedAt and receipt, seconds deadline",
        HOST_MS, HOST_MS, pending(operationHash, true, seconds(DEADLINE_MS), HOST_MS),
        "liquidity-tank-recovery-deadline-before-preparation"],
      ["millisecond preparedAt and receipt, seconds observedAt",
        HOST_MS, HOST_MS, pending(operationHash, true, DEADLINE_MS, seconds(HOST_MS)),
        "liquidity-tank-lock-observed-before-preparation"],
    ] as const)("a retained row with %s is refused with no effects", async (_label, preparedAt, recordedAt, lock, reason) => {
      const { store } = await retainedRow(preparedAt, recordedAt, lock);
      const { verifier, run, untouched } = resume(store, lock, DEADLINE_MS + 1_000);
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({ status: "indeterminate", reason });
      untouched();
      if (reason === "liquidity-tank-preparation-time-off-receipt") {
        expect(verifier.verifySignedSubmission).not.toHaveBeenCalled();
      }
    });

    test("control: a retained row all in milliseconds stays locked before its deadline and expires after it", async () => {
      const lock = pending(operationHash, true, DEADLINE_MS, HOST_MS);
      const { store } = await retainedRow(HOST_MS, HOST_MS, lock);
      const { h, run } = resume(store, lock, HOST_MS + 1_000);
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased", pastDeadline: false,
      });
      h.setObservation(pending(operationHash, true, DEADLINE_MS, DEADLINE_MS + 1_000));
      run.setClock(DEADLINE_MS + 1_000);
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        status: "failed", errorClass: "failed-substrate",
      });
    });

    test("a retained submission without its receipt is refused before any use, and resumes once the store returns it", async () => {
      const lock = lockedPendingAt(operationHash, HOST_MS + 500);
      const { store } = await retainedRow(HOST_MS, HOST_MS, lock);
      let drop = true;
      const dropping: LiquidityTankStore = {
        ...store,
        claim: async (input) => {
          const claimed = await store.claim(input);
          return drop ? withoutReceipt(claimed) : claimed;
        },
      };
      const { verifier, run, untouched } = resume(dropping, lock);
      // Each attempt starts after the last one's lease.
      for (const at of [HOST_MS + 1_000, HOST_MS + 5_000]) {
        run.setClock(at);
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: `attempt-${at}` })).resolves.toEqual({
          status: "indeterminate", reason: "liquidity-tank-submission-receipt-missing",
        });
      }
      untouched();
      expect(verifier.verifySignedSubmission).not.toHaveBeenCalled();
      expect(verifier.authenticateObservation).not.toHaveBeenCalled();
      drop = false;
      run.setClock(HOST_MS + 10_000);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restored" })).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased",
      });
    });

    test.each([
      ["no receipt", undefined, "liquidity-tank-submission-receipt-missing"],
      ["a seconds-scale receipt", seconds(HOST_MS), "liquidity-tank-preparation-time-off-receipt"],
      ["a receipt a minute and a millisecond away", HOST_MS + 60_001, "liquidity-tank-preparation-time-off-receipt"],
    ] as const)("a committed expiry with %s is not reported as failed-substrate", async (_label, receipt, reason) => {
      const intent = createLiquidityTankIntent(authority());
      const evidence = pending(operationHash, true, DEADLINE_MS, DEADLINE_MS + 1);
      const expiredClaim = (submissionRecordedAt: number | undefined): LiquidityTankStore => ({
        ...createInMemoryLiquidityTankStore(VOLATILE),
        claim: async () => ({
          status: "recovery-expired", intent, submission: retainedSubmission(HOST_MS),
          ...(submissionRecordedAt === undefined ? {} : { submissionRecordedAt }),
          observation: evidence as never,
        }) as never,
      });
      const { verifier, run, untouched } = resume(expiredClaim(receipt), evidence, DEADLINE_MS + 1_000);
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({ status: "indeterminate", reason });
      untouched();
      expect(verifier.authenticateObservation).not.toHaveBeenCalled();
      await expect(advanceLiquidityTankSettlement({ ...run.shared, store: expiredClaim(HOST_MS) }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
    });

    test.each([
      ["a receipt without a submission", { submissionRecordedAt: HOST_MS }],
      ["a string receipt", { submission: retainedSubmission(HOST_MS), submissionRecordedAt: String(HOST_MS) }],
      ["a negative receipt", { submission: retainedSubmission(HOST_MS), submissionRecordedAt: -1 }],
      ["a fractional receipt", { submission: retainedSubmission(HOST_MS), submissionRecordedAt: HOST_MS + 0.5 }],
      ["a null receipt", { submission: retainedSubmission(HOST_MS), submissionRecordedAt: null }],
    ] as const)("%s is retained-state corruption", async (_label, retained) => {
      const store: LiquidityTankStore = {
        ...createInMemoryLiquidityTankStore(VOLATILE),
        claim: async (input) => ({
          status: "acquired", intent: input.intent,
          lease: { owner: input.owner, generation: 1, expiresAt: input.now + input.leaseDurationMs },
          ...retained,
        }) as never,
      };
      const { run, untouched } = resume(store, lockedPendingAt(operationHash, HOST_MS + 500), HOST_MS + 1_000);
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt",
      });
      untouched();
    });

    test.each([
      ["a minute after preparedAt", 60_000, true],
      ["a minute and a millisecond after it", 60_001, false],
      ["a minute before it", -60_000, true],
      ["a minute and a millisecond before it", -60_001, false],
    ] as const)("a retained receipt %s is used only inside the window", async (_label, offset, used) => {
      const lock = lockedPendingAt(operationHash, HOST_MS + 500);
      const { store } = await retainedRow(HOST_MS, HOST_MS + offset, lock);
      const { run } = resume(store, lock, HOST_MS + 120_000);
      const result = await advanceLiquidityTankSettlement(run.shared);
      if (used) {
        expect(result).toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
      } else {
        expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-preparation-time-off-receipt" });
      }
    });

    test.each([
      [60_000, true],
      [60_001, false],
    ] as const)("a fresh submission whose verification ends %i ms after preparedAt is stored only inside the window", async (delay, stored) => {
      const intent = createLiquidityTankIntent(authority());
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordSubmission = vi.spyOn(store, "recordSubmission");
      const h = harness();
      h.setPreparedAt(HOST_MS);
      h.setAfterBroadcast(lockedPendingAt(h.operationHash, HOST_MS + 1_000));
      const run = runner({ store, adapter: h.adapter, leaseDurationMs: 120_000 });
      run.setClock(HOST_MS);
      const slow: LiquidityTankVerifier = {
        authenticateObservation: async () => true,
        verifySignedSubmission: async () => {
          run.setClock(HOST_MS + delay);
          return true;
        },
      };
      const result = await advanceLiquidityTankSettlement({ ...run.shared, verifier: slow });
      const inspected = await store.claim({ intent, owner: "inspector", now: HOST_MS + 200_000, leaseDurationMs: 1 });
      if (stored) {
        expect(result).toMatchObject({ status: "settle-asymmetric" });
        expect(recordSubmission).toHaveBeenCalledWith(expect.objectContaining({ now: HOST_MS + delay }));
        expect(inspected).toMatchObject({ status: "acquired", submissionRecordedAt: HOST_MS + delay });
      } else {
        expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-preparation-time-off-host-clock" });
        expect(recordSubmission).not.toHaveBeenCalled();
        expect(h.broadcastRetained).not.toHaveBeenCalled();
        expect(inspected).toMatchObject({ status: "acquired" });
        expect(inspected).not.toHaveProperty("submission");
      }
    });

    test("the receipt stored is the clock reading the window was checked against", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordSubmission = vi.spyOn(store, "recordSubmission");
      const h = harness();
      h.setPreparedAt(HOST_MS);
      h.setAfterBroadcast(lockedPendingAt(h.operationHash, HOST_MS + 1_000));
      // After verification the clock sits at the window's edge and ticks on every read.
      let clock = HOST_MS;
      let ticking = false;
      const verifier: LiquidityTankVerifier = {
        authenticateObservation: async () => true,
        verifySignedSubmission: async () => {
          if (!ticking) {
            clock = HOST_MS + 60_000;
            ticking = true;
          }
          return true;
        },
      };
      const input = {
        authority: authority(), store, adapter: h.adapter, verifier, leaseDurationMs: 120_000,
        now: () => (ticking ? clock++ : clock),
      };
      await expect(advanceLiquidityTankSettlement({ ...input, owner: "first" })).resolves.toMatchObject({
        status: "settle-asymmetric",
      });
      expect(recordSubmission).toHaveBeenCalledWith(expect.objectContaining({ now: HOST_MS + 60_000 }));
      clock = HOST_MS + 200_000;
      await expect(advanceLiquidityTankSettlement({ ...input, owner: "resumed" })).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased",
      });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
    });
  });

  describe("code P3-1: a bridge time may fall before preparedAt by the same skew", () => {
    test("the code review's probe: an adapter 30 s ahead and a release 20 s after signing settles", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      h.setPreparedAt(HOST_MS + 30_000);
      h.setAfterBroadcast(lockedPendingAt(h.operationHash, HOST_MS + 1_000));
      const run = runner({ store, adapter: h.adapter, leaseDurationMs: 10 });
      const at = async (clock: number) => {
        run.setClock(clock);
        return advanceLiquidityTankSettlement({ ...run.shared, owner: `worker-${clock}` });
      };
      await expect(at(HOST_MS + 1_000)).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased",
      });
      h.setObservation(lockedPendingAt(h.operationHash, HOST_MS + 10_000));
      await expect(at(HOST_MS + 10_000)).resolves.toMatchObject({ status: "settle-asymmetric" });
      h.setObservation(completed(h.operationHash, HOST_MS + 20_000));
      await expect(at(HOST_MS + 40_000)).resolves.toMatchObject({
        status: "settled", settlement: { settlementFinality: { finalityObservedAt: HOST_MS + 20_000 } },
      });
      await expect(at(RECOVERY_DEADLINE_MS + 1_000)).resolves.toMatchObject({ status: "settled" });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    });

    test.each([
      ["a locked pending observed", 60_000, (op: string, time: number) => lockedPendingAt(op, time),
        "settle-asymmetric", "liquidity-tank-lock-observed-before-preparation"],
      ["a completion finalized", 60_000, (op: string, time: number) => completed(op, time),
        "settled", "liquidity-tank-finality-before-preparation"],
    ] as const)("%s a minute before preparedAt is used, and a millisecond earlier is refused", async (
      _label, skew, observation, used, refused,
    ) => {
      for (const [early, expected] of [[skew, used], [skew + 1, refused]] as const) {
        const h = harness();
        h.setPreparedAt(HOST_MS);
        h.setAfterBroadcast(observation(h.operationHash, HOST_MS - early));
        const run = runner({ adapter: h.adapter });
        run.setClock(HOST_MS);
        const result = await advanceLiquidityTankSettlement(run.shared);
        if (expected === refused) {
          expect(result).toEqual({ status: "indeterminate", reason: refused });
        } else {
          expect(result).toMatchObject({ status: expected });
        }
      }
    });
  });
});

describe("final review, round 1", () => {
  describe("finding 1: the core runs only on a store that declares its restart safety", () => {
    /** The reference store without its declaration, as a host store that never ran conformance. */
    function undeclared(): LiquidityTankStore {
      const { restartSafety: _declared, ...store } = createInMemoryLiquidityTankStore(VOLATILE);
      return store;
    }

    test.each([
      ["no declaration", () => undeclared()],
      ["an unknown value", () => ({ ...undeclared(), restartSafety: "durable" as never })],
      ["the boolean true", () => ({ ...undeclared(), restartSafety: true as never })],
      ["a differently cased value", () => ({ ...undeclared(), restartSafety: "Conformance-Tested" as never })],
      ["a getter", () => Object.defineProperty(undeclared(), "restartSafety", {
        get: () => "conformance-tested", enumerable: true,
      })],
    ])("a store with %s is refused before any claim or signature", async (_label, build) => {
      const h = harness();
      h.setAfterBroadcast(completed(h.operationHash));
      const store = build();
      const calls = (["claim", "isCurrent", "recordSubmission", "recordObservation",
        "recordRecoveryFailure", "recordRecoveryExpired", "recordSettlement"] as const)
        .map((method) => vi.spyOn(store, method));
      const verifier = {
        authenticateObservation: vi.fn(async () => true),
        verifySignedSubmission: vi.fn(async () => true),
      } satisfies LiquidityTankVerifier;
      await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter, verifier }).shared))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-store-restart-safety-undeclared" });
      for (const call of calls) expect(call).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(verifier.verifySignedSubmission).not.toHaveBeenCalled();
    });

    test("the in-memory store declares itself volatile and settles", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      expect(store.restartSafety).toBe("volatile-acknowledged");
      const h = harness();
      h.setAfterBroadcast(completed(h.operationHash));
      await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
        .resolves.toMatchObject({ status: "settled" });
    });

    // Launch review 1: a production process never runs on a volatile store.
    describe("volatile stores require explicit development/test mode", () => {
      afterEach(() => {
        vi.unstubAllEnvs();
      });

      test.each([
        ["production", () => vi.stubEnv("NODE_ENV", "production")],
        ["no NODE_ENV", () => vi.stubEnv("NODE_ENV", undefined)],
        ["an empty NODE_ENV", () => vi.stubEnv("NODE_ENV", "")],
        ["an unknown NODE_ENV", () => vi.stubEnv("NODE_ENV", "staging")],
        ["a differently cased NODE_ENV", () => vi.stubEnv("NODE_ENV", "Test")],
        ["an unreadable environment", () => {
          const env = Object.getOwnPropertyDescriptor(process, "env") as PropertyDescriptor;
          Object.defineProperty(process, "env", { configurable: true, get() { throw new Error("no environment"); } });
          return () => Object.defineProperty(process, "env", env);
        }],
      ] as const)("in %s, a volatile store is refused before any claim or signature", async (_label, setEnv) => {
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const calls = (["claim", "isCurrent", "recordSubmission", "recordObservation",
          "recordRecoveryFailure", "recordRecoveryExpired", "recordSettlement"] as const)
          .map((method) => vi.spyOn(store, method));
        const h = harness();
        h.setAfterBroadcast(completed(h.operationHash));
        const shared = runner({ store, adapter: h.adapter }).shared;
        const restore = setEnv();
        let result;
        try {
          result = await advanceLiquidityTankSettlement(shared);
        } finally {
          if (typeof restore === "function") restore();
        }
        expect(result).toEqual({ status: "indeterminate", reason: "liquidity-tank-store-volatile-in-production" });
        for (const call of calls) expect(call).not.toHaveBeenCalled();
        expect(h.prepareSubmission).not.toHaveBeenCalled();
        expect(h.broadcastRetained).not.toHaveBeenCalled();
        expect(h.observe).not.toHaveBeenCalled();
      });

      test.each(["development", "test"])("with NODE_ENV=%j a volatile store still settles", async (value) => {
        vi.stubEnv("NODE_ENV", value);
        const h = harness();
        h.setAfterBroadcast(completed(h.operationHash));
        await expect(advanceLiquidityTankSettlement(runner({
          store: createInMemoryLiquidityTankStore(VOLATILE), adapter: h.adapter,
        }).shared)).resolves.toMatchObject({ status: "settled" });
      });

      test("a store declaration alone cannot authorize production", async () => {
        vi.stubEnv("NODE_ENV", "production");
        const store = { ...createInMemoryLiquidityTankStore(VOLATILE), restartSafety: "conformance-tested" as const };
        const h = harness();
        h.setAfterBroadcast(completed(h.operationHash));
        await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
          .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-store-untrusted" });
      });
    });

    test.each([
      ["an object", () => ({ ...undeclared(), restartSafety: "conformance-tested" as const })],
      ["a class instance", () => {
        const inner = undeclared();
        class HostStore {
          readonly restartSafety = "conformance-tested" as const;
          claim = inner.claim;
          isCurrent = inner.isCurrent;
          recordSubmission = inner.recordSubmission;
          recordObservation = inner.recordObservation;
          recordRecoveryFailure = inner.recordRecoveryFailure;
          recordRecoveryExpired = inner.recordRecoveryExpired;
          recordSettlement = inner.recordSettlement;
        }
        return new HostStore() satisfies LiquidityTankStore;
      }],
    ])("a host store that declares it passed conformance, as %s, settles", async (_label, build) => {
      const h = harness();
      h.setAfterBroadcast(completed(h.operationHash));
      await expect(advanceLiquidityTankSettlement(runner({ store: build(), adapter: h.adapter }).shared))
        .resolves.toMatchObject({ status: "settled" });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
    });
  });
  describe("finding 2: a verifier outage is retried, not refused", () => {
    const OUTAGES = [
      ["throws ETIMEDOUT", async () => {
        throw Object.assign(new Error("verifier timed out"), { code: "ETIMEDOUT" });
      }],
      ["answers unavailable", async () => "unavailable" as const],
    ] as const;
    const WRITES = ["recordSubmission", "recordObservation", "recordRecoveryFailure",
      "recordRecoveryExpired", "recordSettlement"] as const;
    const lockedProgress = (pastDeadline: boolean) => ({
      status: "settle-asymmetric",
      reason: "tank-locked-unreleased",
      recoveryDeadline: RECOVERY_DEADLINE_MS,
      pastDeadline,
      txRef: {
        kind: "liquidity-tank",
        bridgeId: BRIDGE_ID,
        sourceChainId: 11_155_111,
        destChainId: 80_002,
        lockTxHash: "source-lock-tx",
        recoveryDeadline: RECOVERY_DEADLINE_MS,
      },
    });

    test.each([
      ...OUTAGES.map(([label, outage]) => [`both hooks ${label}`, outage, outage] as const),
      ...OUTAGES.map(([label, outage]) =>
        [`only authenticateObservation ${label}`, outage, async () => true as const] as const),
    ])("an overdue durable lock still reports settle-asymmetric past its deadline when %s",
      async (_label, authenticate, verify) => {
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const h = harness();
        await lockDurably(store, h);
        h.observe.mockClear();
        const writes = WRITES.map((method) => vi.spyOn(store, method));
        const run = runner({
          store, adapter: h.adapter, leaseDurationMs: 1,
          verifier: { authenticateObservation: vi.fn(authenticate), verifySignedSubmission: vi.fn(verify) },
        });
        run.setClock(RECOVERY_DEADLINE_MS - 5_000);
        await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual(lockedProgress(false));
        run.setClock(RECOVERY_DEADLINE_MS + 5_000);
        await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual(lockedProgress(true));
        for (const write of writes) expect(write).not.toHaveBeenCalled();
        expect(h.observe).not.toHaveBeenCalled();
        expect(h.broadcastRetained).not.toHaveBeenCalled();
        expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      });

    test("a refusal of a retained row outranks an outage on the retained bytes", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      await lockDurably(store, h);
      const run = runner({
        store, adapter: h.adapter, leaseDurationMs: 1,
        verifier: {
          authenticateObservation: async () => false,
          verifySignedSubmission: async () => "unavailable" as const,
        },
      });
      run.setClock(RECOVERY_DEADLINE_MS + 5_000);
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated",
      });
    });

    test.each(OUTAGES)(
      "on a fresh phase, a verifier that %s keeps the signed bytes unbroadcast, and retries re-check them instead of signing again",
      async (_label, outage) => {
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const recordSubmission = vi.spyOn(store, "recordSubmission");
        const h = harness();
        h.setAfterBroadcast(completed(h.operationHash));
        const verifySignedSubmission = vi.fn<LiquidityTankVerifier["verifySignedSubmission"]>(outage);
        const run = runner({ store, adapter: h.adapter, verifier: { ...APPROVING_VERIFIER, verifySignedSubmission } });
        const unavailable = { status: "indeterminate", reason: "liquidity-tank-verifier-unavailable" };
        await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual(unavailable);
        expect(recordSubmission).toHaveBeenCalledTimes(1);
        await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual(unavailable);
        expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
        expect(h.observe).not.toHaveBeenCalled();
        expect(h.broadcastRetained).not.toHaveBeenCalled();
        verifySignedSubmission.mockImplementation(async () => true);
        await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
        expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
        expect(recordSubmission).toHaveBeenCalledTimes(1);
        const checked = new Set(verifySignedSubmission.mock.calls.map(([input]) => input.submission.submissionHash));
        expect(checked.size).toBe(1);
        expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
        expect(checked.has(h.broadcastRetained.mock.calls[0]![0].submissionHash)).toBe(true);
      });

    test("bytes kept through an outage that the verifier then refuses are never broadcast or replaced", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      const verifySignedSubmission = vi.fn<LiquidityTankVerifier["verifySignedSubmission"]>(
        async () => "unavailable" as const,
      );
      const run = runner({ store, adapter: h.adapter, verifier: { ...APPROVING_VERIFIER, verifySignedSubmission } });
      await advanceLiquidityTankSettlement(run.shared);
      verifySignedSubmission.mockImplementation(async () => false);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
          status: "indeterminate", reason: "liquidity-tank-signed-submission-unverified",
        });
      }
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test.each(OUTAGES)("a fresh observation the authenticator %s for is retried: nothing settles until it answers",
      async (_label, outage) => {
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const recordSettlement = vi.spyOn(store, "recordSettlement");
        const h = harness();
        h.setAfterBroadcast(completed(h.operationHash));
        let down = true;
        const verifier: LiquidityTankVerifier = {
          ...APPROVING_VERIFIER,
          authenticateObservation: async ({ observation }) =>
            observation.status === "completed" && down ? outage() : true,
        };
        const run = runner({ store, adapter: h.adapter, verifier });
        await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
          status: "indeterminate", reason: "liquidity-tank-verifier-unavailable",
        });
        expect(recordSettlement).not.toHaveBeenCalled();
        down = false;
        await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
        expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      });

    test("a fresh observation the authenticator cannot check falls back on the durable lock", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      await lockDurably(store, h);
      h.setObservation(completed(h.operationHash));
      const run = runner({
        store, adapter: h.adapter, leaseDurationMs: 1,
        verifier: {
          ...APPROVING_VERIFIER,
          authenticateObservation: async ({ observation }) =>
            observation.status === "completed" ? "unavailable" : true,
        },
      });
      run.setClock(RECOVERY_DEADLINE_MS + 5_000);
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual(lockedProgress(true));
    });

    test.each(OUTAGES)("a committed expiry whose evidence the authenticator %s for is retried, not refused",
      async (_label, outage) => {
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const h = harness();
        await lockDurably(store, h);
        h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS + 1));
        const expire = runner({ store, adapter: h.adapter, leaseDurationMs: 1 });
        expire.setClock(RECOVERY_DEADLINE_MS + 1);
        await expect(advanceLiquidityTankSettlement(expire.shared)).resolves.toMatchObject({
          status: "failed", errorClass: "failed-substrate",
        });
        const run = runner({
          store, adapter: h.adapter, leaseDurationMs: 1,
          verifier: { ...APPROVING_VERIFIER, authenticateObservation: outage },
        });
        run.setClock(RECOVERY_DEADLINE_MS + 10);
        await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
          status: "indeterminate", reason: "liquidity-tank-verifier-unavailable",
        });
      });
  });
  describe("finding 3: a late release is reported apart, with its evidence", () => {
    test("a release finalized after the deadline commits failed-substrate and returns its txRef, now and on replay", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      const run = await lockDurably(store, h);
      h.observe.mockClear();
      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS + 500));
      run.setClock(RECOVERY_DEADLINE_MS + 1_000);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "late-release" }))
        .resolves.toEqual(releasedLate(RECOVERY_DEADLINE_MS + 500));
      // The committed expiry is replayed from the store with the same evidence.
      h.observe.mockClear();
      run.setClock(RECOVERY_DEADLINE_MS + 5_000);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "after-restart" }))
        .resolves.toEqual(releasedLate(RECOVERY_DEADLINE_MS + 500));
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      const claimed = await store.claim({
        intent: createLiquidityTankIntent(authority()), owner: "inspector",
        now: RECOVERY_DEADLINE_MS + 6_000, leaseDurationMs: 1,
      });
      expect(claimed).toMatchObject({
        status: "recovery-expired",
        observation: { status: "completed", finalityObservedAt: RECOVERY_DEADLINE_MS + 500 },
      });
    });

    test("a late release is reported only once its expiry commits", async () => {
      const inner = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      const run = await lockDurably(inner, h);
      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS + 500));
      let refuse = true;
      const store: LiquidityTankStore = {
        ...inner,
        recordRecoveryExpired: async (input) =>
          refuse ? { status: "stale", reason: "stale-lease" } : inner.recordRecoveryExpired(input),
      };
      run.setClock(RECOVERY_DEADLINE_MS + 1_000);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "refused-write", store }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-recovery-expiry-persistence-uncertain" });
      refuse = false;
      run.setClock(RECOVERY_DEADLINE_MS + 2_000);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "committed", store }))
        .resolves.toEqual(releasedLate(RECOVERY_DEADLINE_MS + 500));
    });

    test("an expiry without a release keeps the plain reason and carries no release evidence", async () => {
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const h = harness();
      const run = await lockDurably(store, h);
      h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS + 1));
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      const expired = {
        status: "failed",
        errorClass: "failed-substrate",
        reason: "tank-locked-unreleased-recovery-expired",
        reputationNeutral: true,
        lockTxRef: lockTxRef(),
      };
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "expiry" })).resolves.toEqual(expired);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "replay" })).resolves.toEqual(expired);
    });
  });
  describe("finding 4: a pending operation with no lock is bounded too", () => {
    test("an unlocked pending gets a deadline from the submission's receipt, and is past it later", async () => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = runner({ store, adapter: h.adapter });
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "waiting", reason: "liquidity-tank-pending", pendingDeadline: 601_000, pastDeadline: false,
      });
      // Each next owner reads the clock 101 ms later: 600_901, then 601_002.
      run.setClock(600_800);
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
        status: "waiting", reason: "liquidity-tank-pending", pendingDeadline: 601_000, pastDeadline: false,
      });
      // The deadline comes from the durable receipt, not from this call's clock.
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
        status: "waiting", reason: "liquidity-tank-pending", pendingDeadline: 601_000, pastDeadline: true,
      });
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
    });

    test("the host sets the bound with pendingLockDeadlineMs", async () => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash));
      const run = runner({ adapter: h.adapter, pendingLockDeadlineMs: 5_000 });
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "waiting", reason: "liquidity-tank-pending", pendingDeadline: 6_000, pastDeadline: false,
      });
      run.setClock(6_000);
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        pendingDeadline: 6_000, pastDeadline: true,
      });
    });

    test("a locked pending keeps its recovery deadline and gets no pending deadline", async () => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const result = await advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared);
      expect(result).toMatchObject({ status: "settle-asymmetric", recoveryDeadline: RECOVERY_DEADLINE_MS });
      expect(result).not.toHaveProperty("pendingDeadline");
    });

    test.each([0, -1, 1.5, "5000", Number.MAX_SAFE_INTEGER + 1])(
      "pendingLockDeadlineMs %s is refused before any claim",
      async (value) => {
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const claim = vi.spyOn(store, "claim");
        await expect(advanceLiquidityTankSettlement(runner({
          store, pendingLockDeadlineMs: value as never,
        }).shared)).resolves.toEqual({
          status: "indeterminate",
          reason: "pay-cross-chain-liquidity-tank: pendingLockDeadlineMs must be a positive safe integer",
        });
        expect(claim).not.toHaveBeenCalled();
      });
  });
});

/** The bridge's authenticated `empty`, observed at `observedAt`. */
function emptyAt(operationHash: string, observedAt: number): LiquidityTankObservation {
  return { ...empty(operationHash) as Extract<LiquidityTankObservation, { status: "empty" }>, observedAt };
}

describe("final review, round 3", () => {
  describe("an unlocked pending keeps its deadline when a later read is refused", () => {
    test("an authenticated empty after a durable unlocked pending keeps the pending deadline and its alert", async () => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordObservation = vi.spyOn(store, "recordObservation");
      const run = runner({ adapter: h.adapter, store, pendingLockDeadlineMs: 5_000 });
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
        status: "waiting", reason: "liquidity-tank-pending", pendingDeadline: 6_000, pastDeadline: false,
      });
      h.broadcastRetained.mockClear();
      recordObservation.mockClear();

      h.setObservation(emptyAt(h.operationHash, 50_000));
      for (const at of [50_000, 60_000]) {
        run.setClock(at);
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: `worker-${at}` })).resolves.toEqual({
          status: "waiting", reason: "liquidity-tank-pending", pendingDeadline: 6_000, pastDeadline: true,
        });
      }
      // The regression was refused, not committed, and nothing was rebroadcast.
      expect(await recordObservation.mock.results[0]!.value).toEqual({
        status: "conflict", reason: "liquidity-tank-status-regression",
      });
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      const claim = await store.claim({
        intent: createLiquidityTankIntent(authority()), owner: "inspector", now: 70_000, leaseDurationMs: 1,
      });
      expect(claim).toMatchObject({ status: "acquired", observation: { status: "pending" } });
    });

    test("a failed observation write after a durable unlocked pending keeps the pending deadline", async () => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = runner({ adapter: h.adapter, store, pendingLockDeadlineMs: 5_000 });
      await advanceLiquidityTankSettlement(run.shared);
      store.recordObservation = vi.fn<LiquidityTankStore["recordObservation"]>(async () => {
        throw new Error("simulated observation write failure");
      });
      h.setObservation(pending(h.operationHash, false, RECOVERY_DEADLINE_MS, 7_000));
      run.setClock(7_000);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "write-loss-worker" })).resolves.toEqual({
        status: "waiting", reason: "liquidity-tank-pending", pendingDeadline: 6_000, pastDeadline: true,
      });
    });

    test("a failed observation write after a durable empty stays transient, with no deadline", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = runner({ adapter: h.adapter, store, pendingLockDeadlineMs: 5_000 });
      await advanceLiquidityTankSettlement(run.shared);
      store.recordObservation = vi.fn<LiquidityTankStore["recordObservation"]>(async () => {
        throw new Error("simulated observation write failure");
      });
      h.setObservation(pending(h.operationHash, false, RECOVERY_DEADLINE_MS, 7_000));
      run.setClock(7_000);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "write-loss-worker" })).resolves.toEqual({
        status: "indeterminate", reason: "liquidity-tank-observation-persistence-uncertain",
      });
    });
  });

  describe("a failure that carries its lock resolves through the lock's deadline", () => {
    test("after a crash before the lock's checkpoint, the failure is not permanent and expires neutral past the deadline", async () => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const recordObservation = store.recordObservation.bind(store);
      // The locked pending is read, but its checkpoint write is lost.
      store.recordObservation = vi.fn<LiquidityTankStore["recordObservation"]>(async (input) => {
        if (input.observation.status === "pending") throw new Error("simulated crash before the checkpoint");
        return recordObservation(input);
      });
      const run = runner({ adapter: h.adapter, store });
      await advanceLiquidityTankSettlement(run.shared);
      store.recordObservation = recordObservation;

      h.setObservation(failedAfterLock(h.operationHash, 3_000));
      const lockProgress = {
        status: "settle-asymmetric",
        reason: "tank-locked-unreleased",
        recoveryDeadline: RECOVERY_DEADLINE_MS,
        bridgeStatus: "failed",
        txRef: {
          kind: "liquidity-tank",
          bridgeId: BRIDGE_ID,
          sourceChainId: 11_155_111,
          destChainId: 80_002,
          lockTxHash: "source-lock-tx",
          recoveryDeadline: RECOVERY_DEADLINE_MS,
        },
      };
      await expect(advanceLiquidityTankSettlement(run.nextOwner()))
        .resolves.toEqual({ ...lockProgress, pastDeadline: false });
      // A restart before the deadline, with the bridge read unavailable, still reports the lock.
      h.setObservation({ status: "indeterminate", reason: "offline" });
      await expect(advanceLiquidityTankSettlement(run.nextOwner()))
        .resolves.toEqual({ ...lockProgress, pastDeadline: false });
      // So does a verifier outage past the deadline, which expires nothing.
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      await expect(advanceLiquidityTankSettlement({
        ...run.shared,
        owner: "outage-worker",
        verifier: { ...APPROVING_VERIFIER, authenticateObservation: async () => "unavailable" as const },
      })).resolves.toEqual({ ...lockProgress, pastDeadline: true });

      run.setClock(RECOVERY_DEADLINE_MS + 101);
      h.setObservation(failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS + 101));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "deadline-worker" })).resolves.toEqual({
        status: "failed", errorClass: "failed-substrate", reason: "tank-locked-unreleased-recovery-expired",
        reputationNeutral: true,
        lockTxRef: lockTxRef(),
      });
      run.setClock(RECOVERY_DEADLINE_MS + 10_000);
      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "replay-worker" })).resolves.toMatchObject({ status: "settled" });
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    });

    test("the first read after broadcast is a failure with a lock: never permanent", async () => {
      const h = harness();
      h.setAfterBroadcast(failedAfterLock(h.operationHash, 3_000));
      await expect(advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared)).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased", bridgeStatus: "failed", pastDeadline: false,
      });
    });

    test("a failure without a lock is still permanent", async () => {
      const h = harness();
      h.setAfterBroadcast({ ...failedAfterLock(h.operationHash, 3_000), lockTxHash: undefined, recoveryDeadline: undefined });
      await expect(advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared)).resolves.toEqual({
        status: "failed", errorClass: "permanent", reason: "release rejected by tank shard",
      });
    });

    test("a timely completion of the same lock still settles; another lock's completion does not", async () => {
      for (const [lockTxHash, expected] of [
        ["source-lock-tx", { status: "settled" }],
        ["another-lock-tx", { status: "settle-asymmetric", bridgeStatus: "failed", pastDeadline: false }],
      ] as const) {
        const h = harness();
        h.setAfterBroadcast(failedAfterLock(h.operationHash, 3_000));
        const run = runner({ adapter: h.adapter });
        await advanceLiquidityTankSettlement(run.shared);
        h.setObservation({ ...completed(h.operationHash, 4_000), lockTxHash });
        await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject(expected);
      }
    });

    test("a late completion of the same lock commits the late release", async () => {
      const h = harness();
      h.setAfterBroadcast(failedAfterLock(h.operationHash, 3_000));
      const run = runner({ adapter: h.adapter });
      await advanceLiquidityTankSettlement(run.shared);
      run.setClock(RECOVERY_DEADLINE_MS + 5);
      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS + 1));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "late" }))
        .resolves.toEqual(releasedLate(RECOVERY_DEADLINE_MS + 1));
    });

    test("a late completion of another lock cannot expire a stale failed lock", async () => {
      const h = harness();
      h.setAfterBroadcast(failedAfterLock(h.operationHash, 3_000));
      const run = runner({ adapter: h.adapter });
      await advanceLiquidityTankSettlement(run.shared);
      run.setClock(RECOVERY_DEADLINE_MS + 5);
      h.setObservation({ ...completed(h.operationHash, RECOVERY_DEADLINE_MS + 1), lockTxHash: "another-lock-tx" });
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "late" })).resolves.toMatchObject({ status: "settle-asymmetric", pastDeadline: true });
    });
  });

  describe("a contradicted lock expires past its deadline", () => {
    test("an authenticated empty read at and after the deadline expires the lock apart, and replays it", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      h.setObservation(emptyAt(h.operationHash, RECOVERY_DEADLINE_MS + 1));
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "first" })).resolves.toEqual(CONTRADICTED_EXPIRY);
      run.setClock(RECOVERY_DEADLINE_MS + 10_001);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "second" })).resolves.toEqual(CONTRADICTED_EXPIRY);
      // A replay authenticates both legs again: a refused leg is not reported as expired.
      await expect(advanceLiquidityTankSettlement({
        ...run.shared,
        owner: "refusing",
        verifier: { ...APPROVING_VERIFIER, authenticateObservation: async ({ observation }) => observation.status !== "empty" },
      })).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated" });
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("a contradiction does not expire before the host clock passes the deadline", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const run = await lockDurably(store, h);
      // The bridge stamps the read after the deadline, but this host's clock is behind it.
      h.setObservation(emptyAt(h.operationHash, RECOVERY_DEADLINE_MS + 1));
      run.setClock(RECOVERY_DEADLINE_MS - 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "behind" })).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased", bridgeStatus: "conflicting", pastDeadline: false,
      });
      expect(expire).not.toHaveBeenCalled();
    });

    test("a completion of another lock expires the lock apart once a read after the deadline reports it, with that release", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const run = await lockDurably(store, h);
      // Timely for its own lock, and stamped before the checkpoint's deadline.
      const otherRelease = {
        ...completed(h.operationHash, 4_000, RECOVERY_DEADLINE_MS + 600_000),
        lockTxHash: "another-lock-tx",
        releaseTxHash: "another-release-tx",
        observedAt: 4_000,
      };
      h.setObservation(otherRelease);
      run.setClock(RECOVERY_DEADLINE_MS - 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "before" })).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased", bridgeStatus: "conflicting", pastDeadline: false,
      });
      // Stamped before the deadline, it leaves the lock open past host D.
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "stale" })).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "lock-contradicted", bridgeStatus: "conflicting", pastDeadline: true,
      });
      expect(expire).not.toHaveBeenCalled();
      // Stamped at the deadline itself, the read still leaves the lock open.
      h.setObservation({ ...otherRelease, observedAt: RECOVERY_DEADLINE_MS });
      run.setClock(RECOVERY_DEADLINE_MS + 2);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "at" })).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "lock-contradicted", bridgeStatus: "conflicting", pastDeadline: true,
      });
      expect(expire).not.toHaveBeenCalled();
      // The bridge reports the same release in a read stamped after the deadline.
      h.setObservation({ ...otherRelease, observedAt: RECOVERY_DEADLINE_MS + 1 });
      const expired = {
        ...CONTRADICTED_EXPIRY,
        txRef: {
          kind: "liquidity-tank", bridgeId: BRIDGE_ID, sourceChainId: 11_155_111, destChainId: 80_002,
          lockTxHash: "another-lock-tx", releaseTxHash: "another-release-tx",
          recoveryDeadline: RECOVERY_DEADLINE_MS + 600_000,
        },
        finalityObservedAt: 4_000,
      };
      run.setClock(RECOVERY_DEADLINE_MS + 3);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "after" })).resolves.toEqual(expired);
      expect(expire).toHaveBeenCalledTimes(1);
      // Replay reconciles read-only and preserves the release evidence.
      h.observe.mockClear();
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual(expired);
      expect(h.observe).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("a pending of another lock still inside its own window never expires the lock; its release then does", async () => {
      // Re-review 3, RR3-A: past D the bridge reports the operation pending under
      // another lock whose own deadline is ten minutes later.
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const run = await lockDurably(store, h);
      const D2 = RECOVERY_DEADLINE_MS + 600_000;
      h.setObservation({ ...pending(h.operationHash, true, D2, RECOVERY_DEADLINE_MS + 1), lockTxHash: "another-lock-tx" });
      for (const at of [RECOVERY_DEADLINE_MS + 1, RECOVERY_DEADLINE_MS + 60_000]) {
        run.setClock(at);
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: `live-${at}` })).resolves.toMatchObject({
          status: "settle-asymmetric", reason: "lock-contradicted", bridgeStatus: "conflicting", pastDeadline: true,
        });
      }
      // At its own deadline it is still live: its release would still be timely.
      h.setObservation({ ...pending(h.operationHash, true, D2, D2), lockTxHash: "another-lock-tx" });
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "lock-contradicted",
      });
      expect(expire).not.toHaveBeenCalled();
      // The other lock releases inside its own window: the bridge says the payee
      // was paid, so the expiry carries that release.
      h.setObservation({ ...completed(h.operationHash, RECOVERY_DEADLINE_MS + 60_000, D2),
        observedAt: RECOVERY_DEADLINE_MS + 60_000, lockTxHash: "another-lock-tx", releaseTxHash: "another-release-tx" });
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        ...CONTRADICTED_EXPIRY,
        txRef: { lockTxHash: "another-lock-tx", releaseTxHash: "another-release-tx", recoveryDeadline: D2 },
        finalityObservedAt: RECOVERY_DEADLINE_MS + 60_000,
      });
      expect(expire).toHaveBeenCalledTimes(1);
    });

    test("a pending of another lock read after its own deadline expires the lock apart", async () => {
      for (const observedAt of [RECOVERY_DEADLINE_MS + 600_001, RECOVERY_DEADLINE_MS + 600_002]) {
        const h = harness();
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const run = await lockDurably(store, h);
        h.setObservation({
          ...pending(h.operationHash, true, RECOVERY_DEADLINE_MS + 600_000, observedAt),
          lockTxHash: "another-lock-tx",
        });
        run.setClock(RECOVERY_DEADLINE_MS + 1);
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "after" })).resolves.toEqual(CONTRADICTED_EXPIRY);
      }
    });

    test("a pending without a lock never expires the lock, however late it is stamped", async () => {
      // Re-review 3, RR3-B: the bridge may still lock it.
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const run = await lockDurably(store, h);
      for (const at of [RECOVERY_DEADLINE_MS + 1, RECOVERY_DEADLINE_MS + 86_400_000]) {
        h.setObservation(pending(h.operationHash, false, RECOVERY_DEADLINE_MS, at));
        run.setClock(at);
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: `unlocked-${at}` })).resolves.toMatchObject({
          status: "settle-asymmetric", reason: "lock-contradicted", bridgeStatus: "conflicting", pastDeadline: true,
        });
      }
      expect(expire).not.toHaveBeenCalled();
      // The lock still resolves as usual: here a timely completion of it settles.
      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    });

    test("a replayed contradicted expiry re-checks the host clock", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      h.setObservation(emptyAt(h.operationHash, RECOVERY_DEADLINE_MS + 1));
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "expire" })).resolves.toEqual(CONTRADICTED_EXPIRY);
      run.setClock(RECOVERY_DEADLINE_MS);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "stepped-back" }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-recovery-expiry-not-due" });
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "back-past-d" })).resolves.toEqual(CONTRADICTED_EXPIRY);
    });

    test("retained failure evidence outranks a contradiction", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      h.setObservation(failedAfterLock(h.operationHash, 3_000));
      run.setClock(RECOVERY_DEADLINE_MS - 10);
      await advanceLiquidityTankSettlement({ ...run.shared, owner: "retainer" });
      h.setObservation(emptyAt(h.operationHash, RECOVERY_DEADLINE_MS + 1));
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "after" })).resolves.toMatchObject({ status: "settle-asymmetric", pastDeadline: true });
    });

    test("the store commits contradiction and failure evidence only against the durable lock", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      await lockDurably(store, h);
      const intent = createLiquidityTankIntent(authority());
      const claim = await store.claim({ intent, owner: "cas", now: RECOVERY_DEADLINE_MS + 1, leaseDurationMs: 500 });
      if (claim.status !== "acquired" || claim.observation?.status !== "pending") throw new Error("expected lock");
      const checkpoint = claim.observation as Extract<LiquidityTankRecoveryEvidence, { status: "pending" }>;
      const write = (observation: LiquidityTankRecoveryEvidence, now = RECOVERY_DEADLINE_MS + 1) =>
        store.recordRecoveryExpired({
          settlementKey: intent.settlementKey, bindingHash: intent.bindingHash, owner: "cas",
          generation: claim.lease.generation, now, expectedObservation: checkpoint, observation,
        });
      // Stamped at the deadline, the store clock past it does not decide.
      await expect(write({ status: "contradicted-after-lock", checkpoint,
        contradiction: emptyAt(h.operationHash, RECOVERY_DEADLINE_MS) } as LiquidityTankRecoveryEvidence))
        .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
      const contradiction = emptyAt(h.operationHash, RECOVERY_DEADLINE_MS + 1);
      await expect(write({ status: "contradicted-after-lock", checkpoint: { ...checkpoint, observedAt: 2_001 },
        contradiction } as LiquidityTankRecoveryEvidence))
        .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" });
      await expect(write({ status: "contradicted-after-lock", checkpoint, contradiction } as LiquidityTankRecoveryEvidence,
        RECOVERY_DEADLINE_MS))
        .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
      // A pending that leaves the operation live is never expiry evidence.
      const { lockTxHash: _lock, recoveryDeadline: _deadline, ...unlocked } =
        pending(h.operationHash, false, RECOVERY_DEADLINE_MS, RECOVERY_DEADLINE_MS + 1);
      for (const live of [
        unlocked,
        { ...pending(h.operationHash, true, RECOVERY_DEADLINE_MS + 2, RECOVERY_DEADLINE_MS + 1), lockTxHash: "another-lock-tx" },
        { ...pending(h.operationHash, true, RECOVERY_DEADLINE_MS + 1, RECOVERY_DEADLINE_MS + 1), lockTxHash: "another-lock-tx" },
      ]) {
        await expect(write({ status: "contradicted-after-lock", checkpoint, contradiction: live } as LiquidityTankRecoveryEvidence))
          .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
      }
      await expect(write({ status: "contradicted-after-lock", checkpoint,
        contradiction: pending(h.operationHash, true, RECOVERY_DEADLINE_MS, RECOVERY_DEADLINE_MS + 1) } as never))
        .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-evidence-invalid" });
      // The checkpoint's own completion is never a contradiction.
      await expect(write({ status: "contradicted-after-lock", checkpoint,
        contradiction: completed(h.operationHash, RECOVERY_DEADLINE_MS - 1) } as LiquidityTankRecoveryEvidence))
        .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-evidence-invalid" });
      await expect(write(failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS + 1) as LiquidityTankRecoveryEvidence))
        .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" });
      await expect(write({ status: "contradicted-after-lock", checkpoint, contradiction } as LiquidityTankRecoveryEvidence))
        .resolves.toEqual({ status: "recorded" });
    });

    test("the store commits another lock's completion as contradiction evidence", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      await lockDurably(store, h);
      const intent = createLiquidityTankIntent(authority());
      const claim = await store.claim({ intent, owner: "cas", now: RECOVERY_DEADLINE_MS + 1, leaseDurationMs: 500 });
      if (claim.status !== "acquired" || claim.observation?.status !== "pending") throw new Error("expected lock");
      const checkpoint = claim.observation as Extract<LiquidityTankRecoveryEvidence, { status: "pending" }>;
      const evidence = (observedAt: number) => ({ status: "contradicted-after-lock", checkpoint,
        contradiction: { ...completed(h.operationHash, 4_000), observedAt, lockTxHash: "another-lock-tx" } }) as
        LiquidityTankRecoveryEvidence;
      const write = (observation: LiquidityTankRecoveryEvidence) => store.recordRecoveryExpired({
        settlementKey: intent.settlementKey, bindingHash: intent.bindingHash, owner: "cas",
        generation: claim.lease.generation, now: RECOVERY_DEADLINE_MS + 1, expectedObservation: checkpoint, observation,
      });
      // Stamped at the deadline it is refused; the bridge's read after the deadline is evidence.
      await expect(write(evidence(RECOVERY_DEADLINE_MS)))
        .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
      await expect(write(evidence(RECOVERY_DEADLINE_MS + 1))).resolves.toEqual({ status: "recorded" });
      await expect(store.claim({ intent, owner: "inspector", now: RECOVERY_DEADLINE_MS + 1_000, leaseDurationMs: 100 }))
        .resolves.toMatchObject({ status: "recovery-expired", observation: evidence(RECOVERY_DEADLINE_MS + 1) });
    });

    test("the store refuses contradiction evidence beside retained failure evidence", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      await lockDurably(store, h);
      const intent = createLiquidityTankIntent(authority());
      const claim = await store.claim({ intent, owner: "cas", now: RECOVERY_DEADLINE_MS + 1, leaseDurationMs: 500 });
      if (claim.status !== "acquired" || claim.observation?.status !== "pending") throw new Error("expected lock");
      const checkpoint = claim.observation as Extract<LiquidityTankRecoveryEvidence, { status: "pending" }>;
      const lease = { settlementKey: intent.settlementKey, bindingHash: intent.bindingHash, owner: "cas",
        generation: claim.lease.generation, now: RECOVERY_DEADLINE_MS + 1 };
      const recoveryFailure = { status: "failed-after-lock", checkpoint, failure: failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS + 1) } as
        Extract<LiquidityTankRecoveryEvidence, { status: "failed-after-lock" }>;
      await expect(store.recordRecoveryFailure({ ...lease, recoveryFailure })).resolves.toMatchObject({ status: "recorded" });
      await expect(store.recordRecoveryExpired({ ...lease, expectedObservation: checkpoint,
        observation: { status: "contradicted-after-lock", checkpoint,
          contradiction: emptyAt(h.operationHash, RECOVERY_DEADLINE_MS + 1) } as LiquidityTankRecoveryEvidence }))
        .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" });
      await expect(store.recordRecoveryExpired({ ...lease, expectedObservation: checkpoint, observation: recoveryFailure }))
        .resolves.toEqual({ status: "recorded" });
    });

    test("the store does not let a completion with the failed lock's hash but another deadline replace it", async () => {
      const h = harness();
      h.setAfterBroadcast(failedAfterLock(h.operationHash, 3_000));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      await advanceLiquidityTankSettlement(runner({ adapter: h.adapter, store }).shared);
      const intent = createLiquidityTankIntent(authority());
      const claim = await store.claim({ intent, owner: "writer", now: 5_000, leaseDurationMs: 500 });
      if (claim.status !== "acquired" || claim.observation?.status !== "failed") throw new Error("expected failure");
      const write = (observation: LiquidityTankObservation) => store.recordObservation({
        settlementKey: intent.settlementKey, bindingHash: intent.bindingHash, owner: "writer",
        generation: claim.lease.generation, now: 5_000,
        observation: observation as Exclude<LiquidityTankObservation, { status: "indeterminate" }>,
      });
      await expect(write(completed(h.operationHash, 4_000, RECOVERY_DEADLINE_MS + 1)))
        .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-terminal-status-conflict" });
      await expect(write(completed(h.operationHash, 4_000))).resolves.toEqual({ status: "recorded" });
    });

    test("a replayed expiry from a durable failure that carries its lock re-checks the host clock", async () => {
      const h = harness();
      h.setAfterBroadcast(failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS + 1));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = runner({ adapter: h.adapter, store });
      await advanceLiquidityTankSettlement(run.shared);
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      h.setObservation({ status: "indeterminate", reason: "offline" });
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "expire" })).resolves.toMatchObject({
        status: "failed", reason: "tank-locked-unreleased-recovery-expired",
      });
      await expect(store.claim({ intent: createLiquidityTankIntent(authority()), owner: "inspector",
        now: RECOVERY_DEADLINE_MS + 1, leaseDurationMs: 100 }))
        .resolves.toMatchObject({ status: "recovery-expired", observation: { status: "failed", lockTxHash: "source-lock-tx" } });
      run.setClock(RECOVERY_DEADLINE_MS);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "stepped-back" }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-recovery-expiry-not-due" });
    });
  });
});

// `lockDurably` records the checkpoint observed at 2_000.
const CHECKPOINT_OBSERVED_AT = 2_000;
const LOCK_CONTRADICTED = {
  status: "settle-asymmetric", reason: "lock-contradicted", bridgeStatus: "conflicting", pastDeadline: true,
  recoveryDeadline: RECOVERY_DEADLINE_MS,
} as const;
const OTHER_DEADLINE = RECOVERY_DEADLINE_MS + 600_000;
const otherRelease = (finalityObservedAt: number) => ({
  ...CONTRADICTED_EXPIRY,
  txRef: {
    kind: "liquidity-tank", bridgeId: BRIDGE_ID, sourceChainId: 11_155_111, destChainId: 80_002,
    lockTxHash: "another-lock-tx", releaseTxHash: "another-release-tx", recoveryDeadline: OTHER_DEADLINE,
  },
  finalityObservedAt,
});
/** Every kind of read that contradicts the checkpoint and is not a live pending, observed at `observedAt`. */
const CONTRADICTIONS: readonly [string, (operationHash: string, observedAt: number) => LiquidityTankObservation][] = [
  ["empty", (operationHash, observedAt) => emptyAt(operationHash, observedAt)],
  ["capacity-unavailable", (operationHash, observedAt) =>
    ({ ...emptyAt(operationHash, observedAt), status: "capacity-unavailable", reason: "no capacity" }) as LiquidityTankObservation],
  ["failed without a lock", (operationHash, observedAt) =>
    ({ ...emptyAt(operationHash, observedAt), status: "failed", history: ["empty", "failed"], reason: "rejected" }) as LiquidityTankObservation],
  ["failed of another lock", (operationHash, observedAt) =>
    ({ ...failedAfterLock(operationHash, observedAt), lockTxHash: "another-lock-tx" })],
  ["completion of another lock", (operationHash, observedAt) => ({
    ...completed(operationHash, observedAt, OTHER_DEADLINE), observedAt,
    lockTxHash: "another-lock-tx", releaseTxHash: "another-release-tx",
  })],
  ["pending of another lock past its own deadline", (operationHash, observedAt) =>
    ({ ...pending(operationHash, true, 1_500, observedAt), lockTxHash: "another-lock-tx" })],
];

describe("final review, round 4", () => {
  describe("a contradiction expires the lock only when observed after the checkpoint", () => {
    // Round 5 adds the reads after the checkpoint but before the deadline.
    test.each(CONTRADICTIONS.flatMap(([kind, read]) =>
      [1_500, CHECKPOINT_OBSERVED_AT, CHECKPOINT_OBSERVED_AT + 1, RECOVERY_DEADLINE_MS - 120_000, RECOVERY_DEADLINE_MS - 1,
        RECOVERY_DEADLINE_MS]
        .map((observedAt) => [kind, observedAt, read] as const)))(
      "a %s observed at %d, not after the checkpoint or not after the deadline, never expires the lock, whatever the host clock",
      async (_kind, observedAt, read) => {
        const h = harness();
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const expire = vi.spyOn(store, "recordRecoveryExpired");
        const run = await lockDurably(store, h);
        h.setObservation(read(h.operationHash, observedAt));
        for (const at of [RECOVERY_DEADLINE_MS + 1, RECOVERY_DEADLINE_MS + 86_400_000]) {
          run.setClock(at);
          await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: `stale-${at}` }))
            .resolves.toEqual({ ...LOCK_CONTRADICTED, txRef: expect.objectContaining({ lockTxHash: "source-lock-tx" }) });
        }
        expect(expire).not.toHaveBeenCalled();
        // The lock is still open: its timely completion settles it.
        h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
        await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
          status: "settled", settlement: { txRef: { lockTxHash: "source-lock-tx", releaseTxHash: "destination-release-tx" } },
        });
        expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
        expect(h.broadcastRetained).not.toHaveBeenCalled();
      },
    );

    test.each(CONTRADICTIONS)(
      "a %s observed after the checkpoint and one millisecond after the deadline expires the lock once the host clock passes it",
      async (kind, read) => {
        const h = harness();
        const store = createInMemoryLiquidityTankStore(VOLATILE);
        const expire = vi.spyOn(store, "recordRecoveryExpired");
        const run = await lockDurably(store, h);
        h.setObservation(read(h.operationHash, RECOVERY_DEADLINE_MS + 1));
        run.setClock(RECOVERY_DEADLINE_MS + 1);
        const expired = kind === "completion of another lock"
          ? otherRelease(RECOVERY_DEADLINE_MS + 1)
          : CONTRADICTED_EXPIRY;
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "fresh" })).resolves.toEqual(expired);
        expect(expire).toHaveBeenCalledTimes(1);
        await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual(expired);
        expect(h.broadcastRetained).not.toHaveBeenCalled();
      },
    );

    test("M1/M2: a cached empty older than the lock, read past D by a host clock ahead of the bridge, leaves the lock to its timely release", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const run = await lockDurably(store, h);
      // The host clock reads D while the bridge is two minutes behind it, and a
      // replica serves an empty snapshot stamped before the lock was observed.
      h.setObservation(emptyAt(h.operationHash, 1_500));
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "fast-clock" }))
        .resolves.toMatchObject(LOCK_CONTRADICTED);
      expect(expire).not.toHaveBeenCalled();
      // The release lands inside the window by the bridge's time.
      h.setObservation({ ...completed(h.operationHash, RECOVERY_DEADLINE_MS - 30_000), observedAt: RECOVERY_DEADLINE_MS - 30_000 });
      run.setClock(RECOVERY_DEADLINE_MS + 2);
      const settled = {
        status: "settled",
        settlement: {
          txRef: {
            kind: "liquidity-tank", bridgeId: BRIDGE_ID, sourceChainId: 11_155_111, destChainId: 80_002,
            lockTxHash: "source-lock-tx", releaseTxHash: "destination-release-tx", recoveryDeadline: RECOVERY_DEADLINE_MS,
          },
          paymentAmount: { amount: "1.25", currency: "USDC" },
          settlementFinality: { model: "liquidity-tank", finalityObservedAt: RECOVERY_DEADLINE_MS - 30_000 },
          authenticationHash: AUTH_HASH,
        },
      };
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "later" })).resolves.toEqual(settled);
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual(settled);
      expect(expire).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("a worker whose clock runs ahead cannot expire a live lock on a read older than the lock, so a host never pays twice", async () => {
      // Daybreak's scenario: two workers share the store; one clock is in step
      // with the bridge, the other two minutes ahead. A replica serves an empty
      // snapshot older than the lock, and the lock then releases in time.
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const run = await lockDurably(store, h);
      let bridgeTime = RECOVERY_DEADLINE_MS - 120_000;
      const inStep = { ...run.shared, owner: "in-step", now: () => bridgeTime };
      const ahead = { ...run.shared, owner: "ahead", now: () => bridgeTime + 120_000 };
      // A host that reads any terminal `failed` as unpaid and pays the phase again.
      let replacementPayments = 0;
      const host = async (input: AdvanceLiquidityTankInput) => {
        const progress = await advanceLiquidityTankSettlement(input);
        if (progress.status === "failed") replacementPayments += 1;
        return progress;
      };
      h.setObservation(emptyAt(h.operationHash, 1_500));
      await expect(host(inStep)).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased", bridgeStatus: "conflicting", pastDeadline: false,
      });
      bridgeTime += 1;
      await expect(host(ahead)).resolves.toMatchObject(LOCK_CONTRADICTED);
      // The store refuses the same evidence written directly at the fast clock.
      const intent = createLiquidityTankIntent(authority());
      bridgeTime += 1;
      const claim = await store.claim({ intent, owner: "direct", now: bridgeTime + 120_000, leaseDurationMs: 1 });
      if (claim.status !== "acquired" || claim.observation?.status !== "pending") throw new Error("expected lock");
      const checkpoint = claim.observation as Extract<LiquidityTankRecoveryEvidence, { status: "pending" }>;
      await expect(store.recordRecoveryExpired({
        settlementKey: intent.settlementKey, bindingHash: intent.bindingHash, owner: "direct",
        generation: claim.lease.generation, now: bridgeTime + 120_000, expectedObservation: checkpoint,
        observation: { status: "contradicted-after-lock", checkpoint, contradiction: emptyAt(h.operationHash, 1_500) } as
          LiquidityTankRecoveryEvidence,
      })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
      expect(expire).toHaveBeenCalledTimes(1);
      // The release lands at D - 30 s by the bridge's time.
      bridgeTime = RECOVERY_DEADLINE_MS - 30_000;
      h.setObservation({ ...completed(h.operationHash, bridgeTime), observedAt: bridgeTime });
      bridgeTime += 1;
      await expect(host(ahead)).resolves.toMatchObject({
        status: "settled", settlement: { txRef: { lockTxHash: "source-lock-tx", releaseTxHash: "destination-release-tx" } },
      });
      bridgeTime += 200_000;
      await expect(host(inStep)).resolves.toMatchObject({ status: "settled" });
      expect(replacementPayments).toBe(0);
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("a claim that replays an expiry committed on a read not after the checkpoint, or not after the deadline, refuses it, and never signs or broadcasts", async () => {
      // Such rows are what the round-4 rule (stamps 1_500 and 2_000), the
      // round-5 rule (2_001 and D - 1) and the at-deadline rule (D) committed;
      // a replay re-checks them.
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const run = await lockDurably(store, h);
      h.setObservation(emptyAt(h.operationHash, RECOVERY_DEADLINE_MS + 1));
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "expire" })).resolves.toEqual(CONTRADICTED_EXPIRY);
      let restamp: number | undefined;
      const claim = store.claim.bind(store);
      store.claim = async (input) => {
        const claimed = await claim(input);
        if (claimed.status !== "recovery-expired" || restamp === undefined) return claimed;
        const evidence = claimed.observation as Extract<LiquidityTankRecoveryEvidence, { status: "contradicted-after-lock" }>;
        return { ...claimed, observation: { ...evidence, contradiction: { ...evidence.contradiction, observedAt: restamp } } };
      };
      h.observe.mockClear();
      for (const stamp of [CHECKPOINT_OBSERVED_AT, 1_500, CHECKPOINT_OBSERVED_AT + 1, RECOVERY_DEADLINE_MS - 1, RECOVERY_DEADLINE_MS]) {
        restamp = stamp;
        await expect(advanceLiquidityTankSettlement(run.nextOwner()))
          .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" });
      }
      restamp = undefined;
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual(CONTRADICTED_EXPIRY);
      expect(h.observe).toHaveBeenCalledTimes(1);
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("the store refuses a contradiction observed at or before the checkpoint or the deadline, and records one after both", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      await lockDurably(store, h);
      const intent = createLiquidityTankIntent(authority());
      const claim = await store.claim({ intent, owner: "cas", now: RECOVERY_DEADLINE_MS + 1, leaseDurationMs: 86_400_000 });
      if (claim.status !== "acquired" || claim.observation?.status !== "pending") throw new Error("expected lock");
      const checkpoint = claim.observation as Extract<LiquidityTankRecoveryEvidence, { status: "pending" }>;
      // However far past the deadline the store clock is.
      const write = (observedAt: number) => store.recordRecoveryExpired({
        settlementKey: intent.settlementKey, bindingHash: intent.bindingHash, owner: "cas",
        generation: claim.lease.generation, now: RECOVERY_DEADLINE_MS + 86_400_000 - 1, expectedObservation: checkpoint,
        observation: { status: "contradicted-after-lock", checkpoint, contradiction: emptyAt(h.operationHash, observedAt) } as
          LiquidityTankRecoveryEvidence,
      });
      for (const observedAt of [1_500, CHECKPOINT_OBSERVED_AT, CHECKPOINT_OBSERVED_AT + 1, RECOVERY_DEADLINE_MS - 1, RECOVERY_DEADLINE_MS]) {
        await expect(write(observedAt))
          .resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
      }
      await expect(write(RECOVERY_DEADLINE_MS + 1)).resolves.toEqual({ status: "recorded" });
    });
  });
});

describe("final review, round 5", () => {
  describe("a contradiction expires the lock only when the bridge stamped it after the deadline", () => {
    test("Daybreak's M2: a read two minutes before the deadline, at a host clock two minutes ahead, authorizes no second payment", async () => {
      // Two workers share the store: one clock in step with the bridge, the
      // other two minutes ahead. A replica serves an empty stamped after the
      // checkpoint but two minutes before the deadline, and the lock then
      // releases thirty seconds before it.
      const h = harness();
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const run = await lockDurably(store, h);
      let bridgeTime = RECOVERY_DEADLINE_MS - 120_000;
      const inStep = { ...run.shared, owner: "in-step", now: () => bridgeTime };
      const ahead = { ...run.shared, owner: "ahead", now: () => bridgeTime + 120_001 };
      // A host that reads any terminal `failed` as unpaid and pays the phase again.
      const results: Awaited<ReturnType<typeof advanceLiquidityTankSettlement>>[] = [];
      let replacementPayments = 0;
      const host = async (input: AdvanceLiquidityTankInput) => {
        const progress = await advanceLiquidityTankSettlement(input);
        results.push(progress);
        if (progress.status === "failed") replacementPayments += 1;
        return progress;
      };
      h.setObservation(emptyAt(h.operationHash, RECOVERY_DEADLINE_MS - 120_000));
      await expect(host(inStep)).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased", bridgeStatus: "conflicting", pastDeadline: false,
      });
      // The fast worker's clock reads one millisecond past the deadline.
      await expect(host(ahead))
        .resolves.toEqual({ ...LOCK_CONTRADICTED, txRef: expect.objectContaining({ lockTxHash: "source-lock-tx" }) });
      expect(expire).not.toHaveBeenCalled();
      // The store refuses the same evidence written directly at the fast clock.
      bridgeTime += 1;
      const intent = createLiquidityTankIntent(authority());
      const claim = await store.claim({ intent, owner: "direct", now: bridgeTime + 120_001, leaseDurationMs: 1 });
      if (claim.status !== "acquired" || claim.observation?.status !== "pending") throw new Error("expected lock");
      const checkpoint = claim.observation as Extract<LiquidityTankRecoveryEvidence, { status: "pending" }>;
      await expect(store.recordRecoveryExpired({
        settlementKey: intent.settlementKey, bindingHash: intent.bindingHash, owner: "direct",
        generation: claim.lease.generation, now: bridgeTime + 120_001, expectedObservation: checkpoint,
        observation: { status: "contradicted-after-lock", checkpoint,
          contradiction: emptyAt(h.operationHash, RECOVERY_DEADLINE_MS - 120_000) } as LiquidityTankRecoveryEvidence,
      })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });
      // The original lock releases at D - 30 s by the bridge's time.
      bridgeTime = RECOVERY_DEADLINE_MS - 30_000;
      h.setObservation({ ...completed(h.operationHash, bridgeTime), observedAt: bridgeTime });
      const settled = {
        status: "settled",
        settlement: {
          txRef: { lockTxHash: "source-lock-tx", releaseTxHash: "destination-release-tx", recoveryDeadline: RECOVERY_DEADLINE_MS },
          settlementFinality: { finalityObservedAt: RECOVERY_DEADLINE_MS - 30_000 },
        },
      };
      bridgeTime += 1;
      await expect(host(ahead)).resolves.toMatchObject(settled);
      bridgeTime += 200_000;
      await expect(host(inStep)).resolves.toMatchObject(settled);
      // No result either worker returned is a failure a host could pay again on.
      expect(results.map((progress) => progress.status))
        .toEqual(["settle-asymmetric", "settle-asymmetric", "settled", "settled"]);
      expect(replacementPayments).toBe(0);
      await expect(store.claim({ intent, owner: "inspector", now: bridgeTime + 120_000, leaseDurationMs: 1 }))
        .resolves.toMatchObject({ status: "settled" });
      expect(expire).toHaveBeenCalledTimes(1);
      expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("a read after the deadline but not after a checkpoint observed later still never expires the lock", async () => {
      // This host's clock is behind the bridge's: the checkpoint itself is
      // stamped ten milliseconds after the deadline.
      const h = harness();
      h.setAfterBroadcast(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS + 10));
      const store = createInMemoryLiquidityTankStore(VOLATILE);
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const run = runner({ adapter: h.adapter, store, leaseDurationMs: 1 });
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
        status: "settle-asymmetric", reason: "tank-locked-unreleased", pastDeadline: false,
      });
      for (const stamp of [RECOVERY_DEADLINE_MS + 1, RECOVERY_DEADLINE_MS + 10]) {
        h.setObservation(emptyAt(h.operationHash, stamp));
        run.setClock(stamp + 20);
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: `stale-${stamp}` }))
          .resolves.toMatchObject(LOCK_CONTRADICTED);
      }
      expect(expire).not.toHaveBeenCalled();
      h.setObservation(emptyAt(h.operationHash, RECOVERY_DEADLINE_MS + 11));
      run.setClock(RECOVERY_DEADLINE_MS + 100);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "fresh" })).resolves.toEqual(CONTRADICTED_EXPIRY);
      expect(expire).toHaveBeenCalledTimes(1);
    });
  });
});
