import { describe, expect, test, vi } from "vitest";

import {
  advanceLiquidityTankSettlement,
  createInMemoryLiquidityTankStore,
  createLiquidityTankIntent,
  liquidityTankSettlementKey,
  type AdvanceLiquidityTankInput,
  type LiquidityTankAdapter,
  type LiquidityTankAuthority,
  type LiquidityTankObservation,
  type LiquidityTankStore,
} from "../../src/rails/liquidityTank.js";

const AUTH_HASH = "a".repeat(64);
const RAIL_HASH = "b".repeat(64);
const AGREEMENT_HASH = "c".repeat(64);
const SR5_HASH = "d".repeat(64);
const BRIDGE_ID = "abc123def456gh78";
const JOB_ID = "01JZ0000000000000000000001";
const SECOND_JOB_ID = "01JZ0000000000000000000002";
const DIFFERENT_JOB_ID = "01JZ0000000000000000000003";

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
): Extract<LiquidityTankObservation, { status: "pending" }> {
  return {
    status: "pending",
    bridgeId: BRIDGE_ID,
    operationHash,
    history: ["empty", "pending"],
    observedAt: 2_000,
    authenticationHash: AUTH_HASH,
    lockTxHash: locked ? "source-lock-tx" : undefined,
    recoveryDeadline: locked ? 5_000 : undefined,
  };
}

function completed(
  operationHash: string,
): Extract<LiquidityTankObservation, { status: "completed" }> {
  return {
    status: "completed",
    bridgeId: BRIDGE_ID,
    operationHash,
    history: ["empty", "pending", "completed"],
    observedAt: 3_000,
    finalityObservedAt: 3_000,
    authenticationHash: AUTH_HASH,
    lockTxHash: "source-lock-tx",
    releaseTxHash: "destination-release-tx",
  };
}

function harness(initial?: LiquidityTankObservation) {
  const intent = createLiquidityTankIntent(authority());
  let observation: LiquidityTankObservation = initial ?? empty(intent.operationHash);
  let throwOnce = false;
  let nextAfterBroadcast: LiquidityTankObservation | undefined;
  const prepareSubmission = vi.fn<LiquidityTankAdapter["prepareSubmission"]>(async (bound, fence) => {
    await fence.assertCurrent();
    return {
      submissionVersion: "1",
      authorityHash: bound.bindingHash,
      operationHash: bound.operationHash,
      bridgeId: BRIDGE_ID,
      substrateTxHash: "demos-native-bridge-tx",
      signedSubmissionBase64: Buffer.from("signed-native-bridge", "utf8").toString("base64"),
      preparedAt: 900,
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
    failNextBroadcast() { throwOnce = true; },
    operationHash: intent.operationHash,
  };
}

function runner(overrides: Partial<AdvanceLiquidityTankInput> = {}) {
  let clock = 1_000;
  const shared: AdvanceLiquidityTankInput = {
    authority: authority(),
    owner: "worker-a",
    store: createInMemoryLiquidityTankStore(),
    adapter: harness().adapter,
    now: () => clock,
    leaseDurationMs: 100,
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

test("malformed persistence results resolve indeterminate without throwing or broadcasting", async () => {
  for (const method of ["recordSubmission", "recordObservation", "recordSettlement"] as const) {
    for (const result of [null, undefined, {}, { status: "unexpected" }, { get status() { throw new Error("unsafe accessor"); } }]) {
      const h = harness(completed(createLiquidityTankIntent(authority()).operationHash));
      const store = createInMemoryLiquidityTankStore();
      store[method] = async () => result as never;
      await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared)).resolves.toMatchObject({ status: "indeterminate" });
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    }
  }
});

test("persistence status is captured before the post-write fence await", async () => {
  const h = harness();
  const store = createInMemoryLiquidityTankStore();
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
    const store = createInMemoryLiquidityTankStore();
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
    });
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
  ])("rejects %s before adapter access", async (_name, override) => {
    const h = harness();
    const result = await advanceLiquidityTankSettlement(runner({
      authority: authority(override as never),
      adapter: h.adapter,
    }).shared);
    expect(result).toMatchObject({ status: "failed", errorClass: "permanent" });
    expect(h.prepareSubmission).not.toHaveBeenCalled();
  });

  test.each(["accessor", "proxy"] as const)(
    "rejects %s authority without invoking caller code",
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

      expect(() => createLiquidityTankIntent(hostile)).toThrow();
      await expect(advanceLiquidityTankSettlement(runner({
        authority: hostile,
        adapter: h.adapter,
      }).shared)).resolves.toMatchObject({ status: "failed", errorClass: "permanent" });
      expect(touched).not.toHaveBeenCalled();
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
    const inner = createInMemoryLiquidityTankStore();
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

  test.each(["accessor", "proxy"] as const)(
    "rejects a prepared-submission %s before persistence and safely retries",
    async (kind) => {
      const touched = vi.fn();
      const h = harness();
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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
      .resolves.toEqual({ status: "waiting", reason: "liquidity-tank-pending" });
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
    const store = createInMemoryLiquidityTankStore();
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
    });
    expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(2);
    const wires = h.broadcastRetained.mock.calls.map((call) => call[0].signedSubmissionBase64);
    expect(new Set(wires).size).toBe(1);
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
    });
  });

  test("a committed source lock enters machine-readable ST-8 recovery", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const result = await advanceLiquidityTankSettlement(runner({ adapter: h.adapter }).shared);
    expect(result).toEqual({
      status: "settle-asymmetric",
      reason: "tank-locked-unreleased",
      recoveryDeadline: 5_000,
      txRef: {
        kind: "liquidity-tank",
        bridgeId: BRIDGE_ID,
        sourceChainId: 11_155_111,
        destChainId: 80_002,
        lockTxHash: "source-lock-tx",
        recoveryDeadline: 5_000,
      },
    });
  });

  test("durable locked state expires as reputation-neutral failed-substrate", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const run = runner({ adapter: h.adapter });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(5_000_000);
    h.setObservation({ status: "indeterminate", reason: "status API unavailable" });
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "recovery-worker" })).resolves.toEqual({
      status: "failed",
      errorClass: "failed-substrate",
      reason: "tank-locked-unreleased-recovery-expired",
      reputationNeutral: true,
    });
  });

  test("locked-unreleased resolves forward to success when release lands", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const run = runner({ adapter: h.adapter });
    await advanceLiquidityTankSettlement(run.shared);
    h.setObservation(completed(h.operationHash));
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
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
    });
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      reason: "tank-locked-unreleased",
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
      recoveryDeadline: 6_000,
    })],
    ["completes a replacement lock", (operationHash: string) => ({
      ...completed(operationHash),
      lockTxHash: "replacement-lock-tx",
    })],
  ] as const)("durable recovery checkpoint rejects a later observation that %s", async (_label, next) => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore();
    const recordObservation = vi.spyOn(store, "recordObservation");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    recordObservation.mockClear();
    h.broadcastRetained.mockClear();
    h.setObservation(next(h.operationHash) as LiquidityTankObservation);

    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      reason: "tank-locked-unreleased",
      recoveryDeadline: 5_000,
      txRef: { lockTxHash: "source-lock-tx", recoveryDeadline: 5_000 },
    });
    expect(recordObservation).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("rejects an unsafe recovery deadline without poisoning the durable checkpoint", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore();
    const recordObservation = vi.spyOn(store, "recordObservation");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    recordObservation.mockClear();
    h.setObservation({
      ...pending(h.operationHash, true),
      recoveryDeadline: Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1,
    });

    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      recoveryDeadline: 5_000,
      txRef: { lockTxHash: "source-lock-tx", recoveryDeadline: 5_000 },
    });
    expect(recordObservation).not.toHaveBeenCalled();
  });

  test("reference store preserves its recovery checkpoint after rejecting an extension", async () => {
    const store = createInMemoryLiquidityTankStore();
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
      observation: { ...pending(intent.operationHash, true), recoveryDeadline: 6_000 },
    })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.recordObservation({
      ...writeAuthority,
      observation: completed(intent.operationHash),
    })).resolves.toEqual({ status: "recorded" });
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

  test("bridge IDs are globally unique across local settlements", async () => {
    const store = createInMemoryLiquidityTankStore();
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
    const inner = createInMemoryLiquidityTankStore();
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
    const inner = createInMemoryLiquidityTankStore();
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
    const inner = createInMemoryLiquidityTankStore();
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
      const inner = createInMemoryLiquidityTankStore();
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
        .resolves.toMatchObject({ status: "failed", errorClass: "permanent" });
      expect(touched).not.toHaveBeenCalled();
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    },
  );

  test("requires the effect fence read to return the literal boolean true", async () => {
    const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
      const claim = vi.spyOn(store, "claim");
      const h = harness();
      await expect(advanceLiquidityTankSettlement(runner({
        store,
        adapter: h.adapter,
        leaseDurationMs,
      }).shared)).resolves.toMatchObject({ status: "failed", errorClass: "permanent" });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    },
  );

  test("rejects an overflowing lease expiry before claiming", async () => {
    const store = createInMemoryLiquidityTankStore();
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
    const inner = createInMemoryLiquidityTankStore();
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
    const store = createInMemoryLiquidityTankStore();
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
    const inner = createInMemoryLiquidityTankStore();
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
      const inner = createInMemoryLiquidityTankStore();
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
    const inner = createInMemoryLiquidityTankStore();
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
    const inner = createInMemoryLiquidityTankStore();
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
      const inner = createInMemoryLiquidityTankStore();
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
    const inner = createInMemoryLiquidityTankStore();
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
