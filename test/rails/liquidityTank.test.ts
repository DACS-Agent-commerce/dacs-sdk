import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import { assertPositiveAmount, baseUnits } from "../../src/canonical/index.js";
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
      operationHash: "cbbd1b1d178191fda9acce350aa52b4993cf17ae63d2afa7b5db692d912df402",
      bindingHash: "4d574c7e251d0d90d9e1ae6ffff412b9ef7ac63df69499b436bba3061e94dbbf",
    });
  });

  test.each([
    ["source", { sourceTokenDecimals: 18 }],
    ["destination", { destinationTokenDecimals: 18 }],
  ])("rejects contradictory %s decimals before store or adapter access", async (_label, override) => {
    expect(() => createLiquidityTankIntent(authority(override))).toThrow(/must both be exactly 6/);

    const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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

  test("takeover replays settlement from a durable completed observation before adapter effects", async () => {
    const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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

  test.each([
    ["null", null],
    ["false", false],
    ["empty string", ""],
    ["undefined", undefined],
  ] as const)(
    "a present %s retained submission is corrupt before any effects",
    async (_label, malformedSubmission) => {
      const inner = createInMemoryLiquidityTankStore();
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
          ...(retainedSubmission === undefined ? {} : { submission: retainedSubmission }),
          ...(exposeMalformedObservation ? { observation: malformedObservation } : {}),
        } as never;
      });
      const store: LiquidityTankStore = {
        claim,
        isCurrent: vi.fn<LiquidityTankStore["isCurrent"]>(async () => true),
        recordSubmission: vi.fn<LiquidityTankStore["recordSubmission"]>(async (input) => {
          retainedSubmission = input.submission;
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
      .resolves.toEqual({ status: "indeterminate", reason: "status API unavailable" });
    expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
    expect(recordSubmission).toHaveBeenCalledTimes(1);
    expect(h.observe).toHaveBeenCalledTimes(1);
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("corrupt retained submission is indeterminate and exact restoration resumes without preparation", async () => {
    const intent = createLiquidityTankIntent(authority());
    let retainedSubmission: Parameters<LiquidityTankStore["recordSubmission"]>[0]["submission"]
      | undefined;
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
        ...(submission === undefined ? {} : { submission }),
      };
    });
    const store: LiquidityTankStore = {
      claim,
      isCurrent: vi.fn<LiquidityTankStore["isCurrent"]>(async () => true),
      recordSubmission: vi.fn<LiquidityTankStore["recordSubmission"]>(async (input) => {
        retainedSubmission = input.submission;
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
      reason: "status API unavailable",
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
    h.setAfterBroadcast(pending(h.operationHash, true));
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
    const store = createInMemoryLiquidityTankStore();
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
    ["at", RECOVERY_DEADLINE_MS],
    ["after", RECOVERY_DEADLINE_MS + 1],
  ] as const)(
    "a direct completion finalized %s the deadline after ambiguous broadcast expires durably",
    async (_label, finalityObservedAt) => {
      const h = harness();
      h.failNextBroadcast();
      const store = createInMemoryLiquidityTankStore();
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
      })).resolves.toEqual({
        status: "failed",
        errorClass: "failed-substrate",
        reason: "tank-locked-unreleased-recovery-expired",
        reputationNeutral: true,
      });
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
      })).resolves.toMatchObject({
        status: "failed",
        reason: "tank-locked-unreleased-recovery-expired",
      });
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
    },
  );

  test("durable locked state expires durably at the exact Unix-millisecond deadline", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore();
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const recordObservation = vi.spyOn(store, "recordObservation");
    const recordSettlement = vi.spyOn(store, "recordSettlement");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS);
    // The bridge still authenticates the same locked pending status at the deadline.
    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS));
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "recovery-worker" })).resolves.toEqual({
      status: "failed",
      errorClass: "failed-substrate",
      reason: "tank-locked-unreleased-recovery-expired",
      reputationNeutral: true,
    });
    expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);

    recordRecoveryExpired.mockClear();
    recordObservation.mockClear();
    recordSettlement.mockClear();
    h.prepareSubmission.mockClear();
    h.observe.mockClear();
    h.broadcastRetained.mockClear();
    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));

    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
      status: "failed",
      errorClass: "failed-substrate",
      reason: "tank-locked-unreleased-recovery-expired",
      reputationNeutral: true,
    });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
    expect(recordObservation).not.toHaveBeenCalled();
    expect(recordSettlement).not.toHaveBeenCalled();
    expect(h.prepareSubmission).not.toHaveBeenCalled();
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("an unavailable status at the deadline keeps the lock open for a timely completion", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore();
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
  ] as const)(
    "a stale pending snapshot (%s) read after the deadline stays locked for a timely completion",
    async (_label, observedAt) => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const store = createInMemoryLiquidityTankStore();
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
    ["at", RECOVERY_DEADLINE_MS],
    ["after", RECOVERY_DEADLINE_MS + 1],
  ] as const)("a locked pending observed %s the deadline expires", async (_label, observedAt) => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore();
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS + 1);
    h.setObservation(lockedPendingAt(h.operationHash, observedAt));

    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "fresh-read-worker" }))
      .resolves.toEqual({
        status: "failed",
        errorClass: "failed-substrate",
        reason: "tank-locked-unreleased-recovery-expired",
        reputationNeutral: true,
      });
    expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);
    expect(recordRecoveryExpired).toHaveBeenCalledWith(expect.objectContaining({
      observation: lockedPendingAt(h.operationHash, observedAt),
    }));
  });

  test("reference store and claim replay both re-check pending evidence time", async () => {
    const intent = createLiquidityTankIntent(authority());
    const store = createInMemoryLiquidityTankStore();
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    let retainedSubmission: Parameters<LiquidityTankStore["recordSubmission"]>[0]["submission"]
      | undefined;
    const recordSubmission = store.recordSubmission.bind(store);
    store.recordSubmission = async (input) => {
      retainedSubmission = input.submission;
      return recordSubmission(input);
    };
    await advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared);
    const claim = await store.claim({
      intent,
      owner: "stale-evidence-writer",
      now: RECOVERY_DEADLINE_MS,
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
      now: RECOVERY_DEADLINE_MS,
      expectedObservation: stale,
      observation: stale,
    })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-expiry-not-due" });

    const replay = (observation: LiquidityTankRecoveryEvidence): LiquidityTankStore => ({
      ...createInMemoryLiquidityTankStore(),
      claim: async (input) => ({
        status: "recovery-expired",
        intent: input.intent,
        submission: retainedSubmission!,
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
      lockedPendingAt(intent.operationHash, RECOVERY_DEADLINE_MS),
      {
        status: "failed-after-lock",
        checkpoint,
        failure: failedAfterLock(intent.operationHash, RECOVERY_DEADLINE_MS),
      },
    ] as LiquidityTankRecoveryEvidence[]) {
      const run = runner({ store: replay(observation), adapter: h.adapter });
      run.setClock(RECOVERY_DEADLINE_MS);
      await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toMatchObject({
        status: "failed",
        errorClass: "failed-substrate",
        reputationNeutral: true,
      });
    }
    // Failure evidence carries no time of its own, so before D replay waits.
    const early = runner({ store: replay({
      status: "failed-after-lock",
      checkpoint,
      failure: failedAfterLock(intent.operationHash, RECOVERY_DEADLINE_MS),
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
    const store = createInMemoryLiquidityTankStore();
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

  test("a failure for another lock does not commit expiry after the deadline", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore();
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS);
    h.setObservation({ ...failedAfterLock(h.operationHash, 3_000), lockTxHash: "wrong-lock" });

    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "conflict-worker" }))
      .resolves.toMatchObject({
        status: "settle-asymmetric",
        reason: "lock-contradicted",
        pastDeadline: true,
        bridgeStatus: "conflicting",
      });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
  });

  test("a pending status observed before the deadline does not commit expiry when it arrives after it", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore();
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS - 1);
    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS - 1));
    const adapter: LiquidityTankAdapter = {
      ...h.adapter,
      observe: async (...args) => {
        const observed = await h.observe(...args);
        run.setClock(RECOVERY_DEADLINE_MS);
        return observed;
      },
    };

    await expect(advanceLiquidityTankSettlement({
      ...run.shared,
      adapter,
      owner: "straddling-worker",
    })).resolves.toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();

    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS));
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
    const store = createInMemoryLiquidityTankStore();
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
    const store = createInMemoryLiquidityTankStore();
    const baseRecordRecoveryExpired = store.recordRecoveryExpired.bind(store);
    store.recordRecoveryExpired = vi.fn<LiquidityTankStore["recordRecoveryExpired"]>(
      async () => ({ status: "conflict", reason: "simulated-cas-loss" }),
    );
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS);
    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS));

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
    const store = createInMemoryLiquidityTankStore();
    const baseRecordRecoveryExpired = store.recordRecoveryExpired.bind(store);
    const baseRecordObservation = store.recordObservation.bind(store);
    store.recordRecoveryExpired = vi.fn<LiquidityTankStore["recordRecoveryExpired"]>(
      async () => ({ status: "conflict", reason: "simulated-cas-loss" }),
    );
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(RECOVERY_DEADLINE_MS);
    h.setObservation(lockedPendingAt(h.operationHash, RECOVERY_DEADLINE_MS));
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
    const secondsScale = RECOVERY_DEADLINE_MS / 1_000;
    h.setAfterBroadcast(pending(h.operationHash, true, secondsScale, RECOVERY_DEADLINE_MS - 1));
    const run = runner({ adapter: h.adapter });
    run.setClock(RECOVERY_DEADLINE_MS - 1);

    await expect(advanceLiquidityTankSettlement(run.shared)).resolves.toEqual({
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
    run.setClock(RECOVERY_DEADLINE_MS - 1);
    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "release-worker" }))
      .resolves.toMatchObject({ status: "settled" });
    expect(h.prepareSubmission).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["at", RECOVERY_DEADLINE_MS],
    ["after", RECOVERY_DEADLINE_MS + 1],
  ] as const)("a completion finalized %s the recovery deadline loses to durable expiry", async (
    _label,
    finalityObservedAt,
  ) => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore();
    const recordSettlement = vi.spyOn(store, "recordSettlement");
    const recordRecoveryExpired = vi.spyOn(store, "recordRecoveryExpired");
    const run = runner({ adapter: h.adapter, store });
    await advanceLiquidityTankSettlement(run.shared);
    run.setClock(finalityObservedAt);
    h.setObservation(completed(h.operationHash, finalityObservedAt));

    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "late-release-worker" }))
      .resolves.toEqual({
        status: "failed",
        errorClass: "failed-substrate",
        reason: "tank-locked-unreleased-recovery-expired",
        reputationNeutral: true,
      });
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
    const store = createInMemoryLiquidityTankStore();
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

    // A new worker after a restart reads the failure at the deadline.
    run.setClock(RECOVERY_DEADLINE_MS);
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "worker-after-restart" }))
      .resolves.toEqual({
        status: "failed",
        errorClass: "failed-substrate",
        reason: "tank-locked-unreleased-recovery-expired",
        reputationNeutral: true,
      });
    expect(recordRecoveryExpired).toHaveBeenCalledTimes(1);
    expect(recordRecoveryExpired).toHaveBeenCalledWith(expect.objectContaining({
      expectedObservation: expect.objectContaining({ status: "pending", observedAt: 2_000 }),
      observation: {
        status: "failed-after-lock",
        checkpoint: pending(h.operationHash, true),
        failure: failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS - 200),
      },
    }));
    expect(recordObservation).not.toHaveBeenCalled();
    expect(recordRecoveryFailure).toHaveBeenCalledTimes(1);

    // A timely completion reported later cannot change the committed expiry.
    recordRecoveryExpired.mockClear();
    h.observe.mockClear();
    h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toEqual({
      status: "failed",
      errorClass: "failed-substrate",
      reason: "tank-locked-unreleased-recovery-expired",
      reputationNeutral: true,
    });
    expect(h.observe).not.toHaveBeenCalled();
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
    expect(recordSettlement).not.toHaveBeenCalled();
    await expect(store.claim({
      intent: createLiquidityTankIntent(authority()),
      owner: "expiry-inspector",
      now: RECOVERY_DEADLINE_MS + 1_000,
      leaseDurationMs: 100,
    })).resolves.toMatchObject({
      status: "recovery-expired",
      observation: { status: "failed-after-lock", failure: { observedAt: RECOVERY_DEADLINE_MS - 200 } },
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
    "an authenticated %s status after the lock conflicts, never expires and leaves the lock open",
    async (_label, status) => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const store = createInMemoryLiquidityTankStore();
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

      // After a restart, even a status observed past the deadline is no evidence.
      run.setClock(RECOVERY_DEADLINE_MS + 1);
      h.setObservation(status(h.operationHash, RECOVERY_DEADLINE_MS + 1));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "worker-after-restart" }))
        .resolves.toMatchObject({
          status: "settle-asymmetric",
          recoveryDeadline: RECOVERY_DEADLINE_MS,
          reason: "lock-contradicted",
          pastDeadline: true,
          bridgeStatus: "conflicting",
        });
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
      expect(recordObservation).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();

      // The lock was never expired, so a timely completion still settles.
      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({
        status: "settled",
      });
      expect(recordRecoveryExpired).not.toHaveBeenCalled();
    },
  );

  test.each(["pending history", "empty history"] as const)(
    "round 3: the same pre-deadline terminal failure expires after restart (%s)",
    async (history) => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const store = createInMemoryLiquidityTankStore();
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
      // Same object and transition time, with a new process/owner at the deadline.
      run.setClock(RECOVERY_DEADLINE_MS);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restart" }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate", reputationNeutral: true });
      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
      await expect(advanceLiquidityTankSettlement(run.nextOwner()))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["unavailable", "empty", "timely completion"] as const)(
    "round 3: retained terminal evidence survives restart with %s",
    async (next) => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const store = createInMemoryLiquidityTankStore();
      const run = runner({ adapter: h.adapter, store });
      await advanceLiquidityTankSettlement(run.shared);
      run.setClock(RECOVERY_DEADLINE_MS - 200);
      h.setObservation({ ...failedAfterLock(h.operationHash, RECOVERY_DEADLINE_MS - 200),
        lockTxHash: "source-lock-tx", recoveryDeadline: RECOVERY_DEADLINE_MS });
      await advanceLiquidityTankSettlement({ ...run.shared, owner: "before" });
      run.setClock(RECOVERY_DEADLINE_MS);
      h.setObservation(next === "unavailable" ? { status: "indeterminate", reason: "offline" }
        : next === "empty" ? empty(h.operationHash)
        : completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restart" }))
        .resolves.toMatchObject(next === "timely completion" ? { status: "settled" }
          : { status: "failed", errorClass: "failed-substrate", reputationNeutral: true });
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["empty", "capacity-unavailable"] as const)(
    "round 3: overdue %s contradicts the lock distinctly without expiry",
    async (status) => {
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      const store = createInMemoryLiquidityTankStore();
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const run = runner({ adapter: h.adapter, store });
      await advanceLiquidityTankSettlement(run.shared);
      run.setClock(RECOVERY_DEADLINE_MS);
      h.setObservation({ ...empty(h.operationHash), status, reason: "no capacity" } as LiquidityTankObservation);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restart" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", reason: "lock-contradicted",
          pastDeadline: true, bridgeStatus: "conflicting" });
      expect(expire).not.toHaveBeenCalled();
      h.setObservation(completed(h.operationHash, RECOVERY_DEADLINE_MS - 1));
      await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    },
  );

  test("round 3: failure retention and expiry CAS reject mismatched evidence and preserve the first failure", async () => {
    const h = harness();
    const store = createInMemoryLiquidityTankStore();
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
    const changedEvidence = { ...evidence, failure: { ...evidence.failure, observedAt: RECOVERY_DEADLINE_MS } };
    await expect(store.recordRecoveryFailure({ ...write, recoveryFailure: changedEvidence })).resolves.toMatchObject({ status: "conflict" });
    const expiry = { settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
      owner: claim.lease.owner, generation: claim.lease.generation,
      now: RECOVERY_DEADLINE_MS, expectedObservation: checkpoint, observation: evidence };
    await expect(store.recordRecoveryExpired({ ...expiry, observation: changedEvidence })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.claim({ intent, owner: "inspector", now: RECOVERY_DEADLINE_MS - 100, leaseDurationMs: 100 }))
      .resolves.toMatchObject({ status: "waiting", observation: checkpoint, recoveryFailure: evidence });
    await expect(store.recordRecoveryExpired({ ...expiry, now: RECOVERY_DEADLINE_MS - 1 })).resolves.toMatchObject({ status: "conflict" });
    await expect(store.recordRecoveryExpired(expiry)).resolves.toEqual({ status: "recorded" });
  });

  test("round 3: completion persistence beats retained failure expiry CAS", async () => {
    const h = harness();
    const store = createInMemoryLiquidityTankStore();
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
    run.setClock(RECOVERY_DEADLINE_MS);
    await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "racer" }))
      .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-recovery-expiry-persistence-uncertain" });
    h.observe.mockClear();
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    expect(h.observe).not.toHaveBeenCalled();
  });

  test("round 3: a timely completion with a lost write suppresses retained failure expiry", async () => {
    const h = harness();
    const store = createInMemoryLiquidityTankStore();
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
    const store = createInMemoryLiquidityTankStore();
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
    await expect(advanceLiquidityTankSettlement(run.nextOwner())).resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
  });

  test.each([undefined, null, false, {}, "bad"])(
    "round 3: corrupt retained terminal evidence %s fails closed before effects",
    async (recoveryFailure) => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore();
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
    const store = createInMemoryLiquidityTankStore();
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
      const inner = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
      const run = await lockDurably(store, h);
      const dropped = vi.fn(async (input: RetentionInput) => reply(input));
      store.recordRecoveryFailure = dropped as unknown as LiquidityTankStore["recordRecoveryFailure"];
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "f" }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain" });
      expect(dropped).toHaveBeenCalledTimes(1);
      // Restart at D with the bridge unavailable: nothing was retained.
      run.setClock(D);
      h.setObservation({ status: "indeterminate", reason: "offline" });
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restart" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased", pastDeadline: true });
      // The same failure read again is still not retained.
      run.setClock(D + 1);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "restart-2" }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain" });
      expect(expire).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("replaying a failure expiry waits until this host reaches the deadline (P8)", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore();
      const run = await lockDurably(store, h);
      const intent = createLiquidityTankIntent(authority());
      const peek = await store.claim({ intent, owner: "peek", now: 5_000, leaseDurationMs: 100 });
      if (peek.status !== "acquired" || !peek.submission) throw new Error("expected acquired");
      const submission = peek.submission;
      store.claim = async () => ({
        status: "recovery-expired", intent, submission,
        observation: { status: "failed-after-lock", checkpoint: pending(h.operationHash, true),
          failure: failedAfterLock(h.operationHash, D - 10_000) },
      }) as never;
      h.observe.mockClear();
      h.prepareSubmission.mockClear();
      for (const at of [D - 9_000, D - 1]) {
        run.setClock(at);
        await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: `replay-${at}` }))
          .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-recovery-expiry-not-due" });
      }
      run.setClock(D);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "replay-at-deadline" }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate", reputationNeutral: true });
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });

    test("P1: a pending snapshot stamped after D while the host is before D never writes expiry", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore();
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

    test("P13: a retained failure then a lagging same-lock pending at D still expires", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore();
      const run = await lockDurably(store, h);
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await advanceLiquidityTankSettlement({ ...run.shared, owner: "f" });
      run.setClock(D);
      h.setObservation(lockedPendingAt(h.operationHash, D - 300));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "r" })).resolves.toMatchObject({
        status: "failed", errorClass: "failed-substrate",
      });
    });

    test("P14: a non-success retention write is not treated as retained", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
      const run = await lockDurably(store, h);
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await advanceLiquidityTankSettlement({ ...run.shared, owner: "f" });
      const intent = createLiquidityTankIntent(authority());
      const c = await store.claim({ intent, owner: "s", now: D - 100, leaseDurationMs: 50 });
      if (c.status !== "acquired") throw new Error("expected acquired");
      await expect(store.recordObservation({ settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
        owner: "s", generation: c.lease.generation, observation: lockedPendingAt(h.operationHash, D - 150),
      })).resolves.toMatchObject({ status: "conflict" });
    });

    test("P16: a lease lost right after the retention write is not reported as retained", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore();
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
      const inner = createInMemoryLiquidityTankStore();
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
      const inner = createInMemoryLiquidityTankStore();
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
      const inner = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
      const run = await lockDurably(store, h);
      run.setClock(D - 200);
      h.setObservation(failedAfterLock(h.operationHash, D - 200));
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "retain" }))
        .resolves.toMatchObject({ status: "settle-asymmetric", bridgeStatus: "failed", pastDeadline: false });
      run.setClock(D + 1);
      h.setObservation({ status: "indeterminate", reason: "offline" });
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "expire" }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
      h.observe.mockClear();
      h.prepareSubmission.mockClear();
      const expire = vi.spyOn(store, "recordRecoveryExpired");
      const retain = vi.spyOn(store, "recordRecoveryFailure");
      run.setClock(D - 50);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "stepped-back" }))
        .resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-recovery-expiry-not-due" });
      run.setClock(D);
      await expect(advanceLiquidityTankSettlement({ ...run.shared, owner: "back-at-d" }))
        .resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
      expect(expire).not.toHaveBeenCalled();
      expect(retain).not.toHaveBeenCalled();
    });

    test("Q10: a lock contradicted past D expires once a consistent same-lock pending read at or after D arrives", async () => {
      const h = harness();
      const store = createInMemoryLiquidityTankStore();
      const run = await lockDurably(store, h);
      run.setClock(D + 1);
      h.setObservation(empty(h.operationHash));
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
      const store = createInMemoryLiquidityTankStore();
      const run = await lockDurably(store, h);
      run.setClock(D + 1);
      h.setObservation(empty(h.operationHash));
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
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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
        const store = createInMemoryLiquidityTankStore();
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
        const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
      const claim = vi.spyOn(store, "claim");
      const h = harness();
      await expect(advanceLiquidityTankSettlement(runner({ authority: coerced, store, adapter: h.adapter }).shared))
        .resolves.toEqual({ status: "indeterminate", reason });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    });

    test("a polluted Object.prototype cannot supply a missing authority field", async () => {
      const { sr5BindingHash: _missing, ...partial } = authority();
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
      store.claim = vi.fn(async () => ({ status: "conflict", ...fields }) as never);
      const h = harness();
      await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
        .resolves.toEqual({ status: "indeterminate", reason });
      expect(h.prepareSubmission).not.toHaveBeenCalled();
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    });
  });

  describe("round 7", () => {
    const D = RECOVERY_DEADLINE_MS;
    const RAIL_ID = "demos-tank-sepolia-amoy-usdc";
    const BINDING_CONFLICT = {
      status: "indeterminate",
      reason: "liquidity-tank-settlement-binding-conflict",
    } as const;
    const PRECISION_REFUSED =
      "pay-cross-chain-liquidity-tank: amount has more precision than 6 decimals";

    /** The lock was live all along: the bridge releases and a plain call settles. */
    async function releasesLater(run: Awaited<ReturnType<typeof lockDurably>>, h: ReturnType<typeof harness>) {
      run.setClock(D - 400);
      h.setObservation(completed(h.operationHash, D - 450));
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
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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

    // Pinning: b6aef30 already refused these through its null-prototype record.
    test.each([
      ["destinationAddress", "attacker-address", "pay-cross-chain-liquidity-tank: destinationAddress must be a non-empty string"],
      ["amount", "1000", "pay-cross-chain-liquidity-tank: amount must be a plain decimal string"],
      ["railId", "other-tank-rail", "pay-cross-chain-liquidity-tank: railId must be a non-empty string"],
      ["jobId", SECOND_JOB_ID, "jobId must be a canonical uppercase ULID"],
    ] as const)("a polluted Object.prototype.%s never reaches the intent of an authority that lacks it", async (field, value, reason) => {
      const partial: Record<string, unknown> = { ...authority() };
      delete partial[field];
      const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
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

  test("reference store accepts failure-after-lock expiry only for the exact checkpoint at or after the deadline", async () => {
    const store = createInMemoryLiquidityTankStore();
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    await advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared);
    const intent = createLiquidityTankIntent(authority());
    const claim = await store.claim({
      intent,
      owner: "failure-expiry-racer",
      now: RECOVERY_DEADLINE_MS,
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
      now: RECOVERY_DEADLINE_MS,
      expectedObservation: checkpoint,
    };
    const evidence = (failure: LiquidityTankObservation, lock = checkpoint) => ({
      status: "failed-after-lock",
      checkpoint: lock,
      failure,
    }) as LiquidityTankRecoveryEvidence;
    const timely = failedAfterLock(intent.operationHash, RECOVERY_DEADLINE_MS);

    await expect(store.recordRecoveryExpired({
      ...write,
      observation: evidence(failedAfterLock(intent.operationHash, RECOVERY_DEADLINE_MS - 1)),
    })).resolves.toEqual({ status: "conflict", reason: "liquidity-tank-recovery-checkpoint-cas-failed" });
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
      recoveryDeadline: RECOVERY_DEADLINE_MS,
      txRef: { lockTxHash: "source-lock-tx", recoveryDeadline: RECOVERY_DEADLINE_MS },
    });
    expect(recordObservation).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("a completed observation cannot replace a retained recovery deadline", async () => {
    const h = harness();
    h.setAfterBroadcast(pending(h.operationHash, true));
    const store = createInMemoryLiquidityTankStore();
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
    const store = createInMemoryLiquidityTankStore();
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
      const store = createInMemoryLiquidityTankStore();
      const h = harness();
      h.setAfterBroadcast(pending(h.operationHash, true));
      await advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared);
      const intent = createLiquidityTankIntent(authority());
      const claim = await store.claim({
        intent,
        owner,
        now: RECOVERY_DEADLINE_MS,
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
      };
      // The bridge still reports the same lock as pending at the deadline.
      const checkpoint = lockedPendingAt(intent.operationHash, RECOVERY_DEADLINE_MS) as
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
      now: RECOVERY_DEADLINE_MS,
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
      now: RECOVERY_DEADLINE_MS,
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
    const store = createInMemoryLiquidityTankStore();
    const recordSettlement = vi.spyOn(store, "recordSettlement");

    await expect(advanceLiquidityTankSettlement(runner({ adapter: h.adapter, store }).shared))
      .resolves.toMatchObject({ status: "indeterminate" });
    expect(recordSettlement).not.toHaveBeenCalled();
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
        .resolves.toMatchObject({ status: "indeterminate" });
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
      }).shared)).resolves.toMatchObject({ status: "indeterminate" });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareSubmission).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["owner", { owner: "" }, "pay-cross-chain-liquidity-tank: owner must be a non-empty string"],
    ["clock", { now: "x" as never }, "pay-cross-chain-liquidity-tank: now must be a stable function"],
  ] as const)("rejects an invalid %s as indeterminate before store or adapter access", async (_label, config, reason) => {
    const store = createInMemoryLiquidityTankStore();
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

  test("rejects stored settlement evidence finalized at its recovery deadline", async () => {
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
              finalityObservedAt: RECOVERY_DEADLINE_MS,
            },
            authenticationHash: AUTH_HASH,
          },
        };
      },
    };
    const h = harness();

    await expect(advanceLiquidityTankSettlement(runner({ store, adapter: h.adapter }).shared))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "liquidity-tank-stored-settlement-mismatch",
      });
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

  test("a corrupt store claim is retry-safe indeterminate before any effects", async () => {
    const inner = createInMemoryLiquidityTankStore();
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
