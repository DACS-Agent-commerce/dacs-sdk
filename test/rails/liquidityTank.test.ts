import { describe, expect, test, vi } from "vitest";

import {
  advanceLiquidityTankSettlement,
  createInMemoryLiquidityTankStore,
  createLiquidityTankIntent,
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

function authority(overrides: Partial<LiquidityTankAuthority> = {}): LiquidityTankAuthority {
  return {
    jobId: "tank-job-1",
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

function pending(operationHash: string, locked = false): LiquidityTankObservation {
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

function completed(operationHash: string): LiquidityTankObservation {
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
      authority: authority({ jobId: "tank-job-2" }),
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
});
