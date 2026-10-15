// One vector per documented check that no other test fails without: each
// test here passes only while the core keeps that check.
import { describe, expect, test, vi } from "vitest";

import type { BundlePhaseErrorClass } from "../../src/artifacts/types.js";
import {
  advanceLiquidityTankSettlement,
  createInMemoryLiquidityTankStore,
  createLiquidityTankIntent,
  liquidityTankPhaseOutcome,
  type AdvanceLiquidityTankInput,
  type LiquidityTankAdapter,
  type LiquidityTankAuthority,
  type LiquidityTankObservation,
  type LiquidityTankProgress,
  type LiquidityTankStore,
  type LiquidityTankVerifier,
} from "../../src/rails/liquidityTank.js";
import * as rails from "../../src/rails/index.js";
import * as root from "../../src/index.js";

const AUTH_HASH = "a".repeat(64);
const BRIDGE_ID = "abc123def456gh78";
const D = 1_785_436_800_000;
const PREPARED_AT = D - 5 * 86_400_000;
const VOLATILE = { acknowledgeVolatile: true } as const;
const APPROVE: LiquidityTankVerifier = {
  authenticateObservation: async () => true,
  verifySignedSubmission: async () => true,
};

function authority(overrides: Partial<Record<keyof LiquidityTankAuthority, unknown>> = {}): LiquidityTankAuthority {
  return {
    jobId: "01JZ0000000000000000000001",
    phaseIndex: 2,
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
    amount: "1.25",
    currency: "USDC",
    originAddress: "origin-address",
    destinationAddress: "destination-address",
    sourceLiquidityTankId: "tank-source",
    destinationLiquidityTankId: "tank-destination",
    supportedScope: "dacs-v0.1-eth-sepolia-polygon-amoy-usdc",
    ...overrides,
  } as LiquidityTankAuthority;
}

const OP = createLiquidityTankIntent(authority()).operationHash;
const base = (observedAt: number | string, bridgeId = BRIDGE_ID) => ({
  bridgeId, operationHash: OP, observedAt, authenticationHash: AUTH_HASH,
});
const empty = (observedAt = PREPARED_AT, bridgeId = BRIDGE_ID): LiquidityTankObservation =>
  ({ status: "empty", history: ["empty"], ...base(observedAt, bridgeId) }) as LiquidityTankObservation;
const locked = (observedAt: number | string, recoveryDeadline: number = D) =>
  ({
    status: "pending", history: ["empty", "pending"], ...base(observedAt), lockTxHash: "source-lock-tx", recoveryDeadline,
  }) as LiquidityTankObservation;
const completed = (finalityObservedAt: number, extra: Record<string, unknown> = {}) =>
  ({
    status: "completed", history: ["empty", "pending", "completed"], ...base(finalityObservedAt),
    lockTxHash: "source-lock-tx", releaseTxHash: "destination-release-tx", recoveryDeadline: D,
    finalityObservedAt, ...extra,
  }) as LiquidityTankObservation;
const failed = (observedAt: number, extra: Record<string, unknown>) =>
  ({
    status: "failed", history: ["empty", "pending", "failed"], ...base(observedAt),
    reason: "release rejected by tank shard", ...extra,
  }) as LiquidityTankObservation;
const lockBearingFailure = (observedAt = PREPARED_AT + 2_000) =>
  failed(observedAt, { lockTxHash: "source-lock-tx", recoveryDeadline: D });

/**
 * One phase on a shared store, with a scripted bridge and a clock. The adapter
 * never calls the fence itself, so only the core's own checks fence it.
 */
function phase(options: {
  store?: LiquidityTankStore;
  verifier?: LiquidityTankVerifier;
  auth?: LiquidityTankAuthority;
  events?: string[];
} = {}) {
  let clock = PREPARED_AT + 500;
  let now = (): number => clock;
  let observation: LiquidityTankObservation = empty();
  let afterBroadcast: LiquidityTankObservation | undefined;
  let prepared: Record<string, unknown> = {};
  const events = options.events;
  const prepareSubmission = vi.fn<LiquidityTankAdapter["prepareSubmission"]>(async (bound) => {
    events?.push("prepareSubmission");
    return {
      submissionVersion: "1",
      authorityHash: bound.bindingHash,
      operationHash: bound.operationHash,
      bridgeId: BRIDGE_ID,
      substrateTxHash: "demos-native-bridge-tx",
      signedSubmissionBase64: Buffer.from("signed-native-bridge", "utf8").toString("base64"),
      preparedAt: PREPARED_AT,
      ...prepared,
    } as never;
  });
  const broadcastRetained = vi.fn<LiquidityTankAdapter["broadcastRetained"]>(async () => {
    events?.push("broadcastRetained");
    if (afterBroadcast) observation = afterBroadcast;
  });
  const observe = vi.fn<LiquidityTankAdapter["observe"]>(async () => {
    events?.push("observe");
    return observation;
  });
  const store = options.store ?? createInMemoryLiquidityTankStore(VOLATILE);
  let owner = 0;
  const input = (): AdvanceLiquidityTankInput => ({
    authority: options.auth ?? authority(),
    owner: `worker-${owner += 1}`,
    store,
    adapter: { prepareSubmission, broadcastRetained, observe },
    verifier: options.verifier ?? APPROVE,
    now: () => now(),
    leaseDurationMs: 10,
  });
  return {
    store, prepareSubmission, broadcastRetained, observe,
    run: () => advanceLiquidityTankSettlement(input()),
    /** Moves the clock; past the last lease when used between runs. */
    at(value: number) { clock = value; },
    tick() { clock += 11; },
    clockFrom(next: () => number) { now = next; },
    see(value: LiquidityTankObservation) { observation = value; },
    seeAfterBroadcast(value: LiquidityTankObservation) { afterBroadcast = value; },
    prepareWith(fields: Record<string, unknown>) { prepared = fields; },
  };
}

/** Broadcasts once and makes the locked pending durable. */
async function lockDurably(p: ReturnType<typeof phase>, observedAt = PREPARED_AT + 1_000) {
  p.seeAfterBroadcast(locked(observedAt));
  await expect(p.run()).resolves.toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
}

/** The reference store with some methods replaced. */
function patched(patch: (inner: LiquidityTankStore) => Partial<LiquidityTankStore>): LiquidityTankStore {
  const inner = createInMemoryLiquidityTankStore(VOLATILE);
  return { ...inner, restartSafety: "volatile-acknowledged", ...patch(inner) };
}

describe("§9.5.5 step 6: success only with both lock and release hashes", () => {
  test.each([
    ["an empty release hash", { releaseTxHash: "" }],
    ["an empty lock hash", { lockTxHash: "" }],
    ["no release hash", { releaseTxHash: undefined }],
  ])("a completion with %s never settles", async (_label, extra) => {
    const p = phase();
    const value = completed(PREPARED_AT + 2_000, extra) as unknown as Record<string, unknown>;
    for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
    p.seeAfterBroadcast(value as never);
    const recordSettlement = vi.spyOn(p.store, "recordSettlement");
    await expect(p.run()).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-status-unavailable" });
    expect(recordSettlement).not.toHaveBeenCalled();
  });
});

describe("a lock-bearing observation must carry both lock fields", () => {
  test.each([
    ["a failure carrying a lock hash but no deadline", () => failed(PREPARED_AT + 2_000, { lockTxHash: "source-lock-tx" })],
    ["a failure carrying a deadline but no lock hash", () => failed(PREPARED_AT + 2_000, { recoveryDeadline: D })],
    ["a failure carrying an empty lock hash", () => failed(PREPARED_AT + 2_000, { lockTxHash: "", recoveryDeadline: D })],
    ["a pending carrying an empty lock hash", () => ({ ...locked(PREPARED_AT + 2_000), lockTxHash: "" }) as LiquidityTankObservation],
  ])("%s is refused, never permanent or locked", async (_label, make) => {
    const p = phase();
    p.seeAfterBroadcast(make());
    await expect(p.run()).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-status-unavailable" });
  });
});

describe("timestamp units on observations", () => {
  test("a lock-bearing failure with a seconds-scale deadline is refused and expires nothing", async () => {
    const p = phase();
    p.seeAfterBroadcast(failed(PREPARED_AT + 2_000, { lockTxHash: "source-lock-tx", recoveryDeadline: Math.floor(D / 1_000) }));
    const recordRecoveryExpired = vi.spyOn(p.store, "recordRecoveryExpired");
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-recovery-deadline-before-preparation",
    });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
  });

  test("a locked pending past the deadline whose observedAt is a numeric string does not expire the lock", async () => {
    const p = phase();
    await lockDurably(p);
    p.see(locked(String(D + 5)));
    p.at(D + 10);
    const recordRecoveryExpired = vi.spyOn(p.store, "recordRecoveryExpired");
    await expect(p.run()).resolves.toMatchObject({ status: "settle-asymmetric", pastDeadline: true });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
  });
});

describe("§9.5.5 steps 1-2: each authority field outside the route is refused alone, before any effect", () => {
  test.each([
    ["sourceChainId", { sourceChainId: 1 }, "route is outside DACS v0.1 supported scope"],
    ["destinationChainId", { destinationChainId: 137 }, "route is outside DACS v0.1 supported scope"],
    ["sourceChainType", { sourceChainType: "SOLANA" }, "route is outside DACS v0.1 supported scope"],
    ["destinationChainType", { destinationChainType: "SOLANA" }, "route is outside DACS v0.1 supported scope"],
    ["sourceAsset", { sourceAsset: "USDT" }, "route is outside DACS v0.1 supported scope"],
    ["currency", { currency: "USDT" }, "route is outside DACS v0.1 supported scope"],
    ["networkKind", { networkKind: "evm" }, "selected rail mechanism mismatch"],
  ])("%s", async (_label, override, message) => {
    const p = phase({ auth: authority(override) });
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate", reason: `pay-cross-chain-liquidity-tank: ${message}`,
    });
    expect(p.prepareSubmission).not.toHaveBeenCalled();
  });
});

describe("the core binds prepared bytes to this phase", () => {
  test.each([
    ["another authority", { authorityHash: "f".repeat(64) }],
    ["another operation", { operationHash: "f".repeat(64) }],
    ["another submission version", { submissionVersion: "2" }],
    ["an empty bridge ID", { bridgeId: "" }],
    ["a bridge ID longer than 128 characters", { bridgeId: "b".repeat(129) }],
    ["a bridge ID with a character outside [A-Za-z0-9_-]", { bridgeId: "bridge/308" }],
    // A number would match the ID grammar once coerced to a string.
    ["a numeric bridge ID", { bridgeId: 308 }],
    ["a preparedAt that is not an integer", { preparedAt: String(PREPARED_AT) }],
  ])("a prepared submission with %s is neither stored nor broadcast", async (_label, fields) => {
    const p = phase();
    p.prepareWith(fields);
    const recordSubmission = vi.spyOn(p.store, "recordSubmission");
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-submission-preparation-unavailable",
    });
    expect(recordSubmission).not.toHaveBeenCalled();
    expect(p.broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([
    ["the Standard's txref-liquidity-tank vector", "tank-308"],
    ["a node-derived ID", `bridge_${"0123456789abcdef"}`],
    ["an SDK-derived ID", `bridge_${"ab".repeat(32)}`],
    ["the longest accepted ID", "b".repeat(128)],
    ["the shortest accepted ID", "A"],
    ["an ID with upper case and an underscore", "Tank_A1"],
  ])("%s is accepted as a bridge ID and settles", async (_label, bridgeId) => {
    const p = phase();
    p.prepareWith({ bridgeId });
    p.see(empty(PREPARED_AT, bridgeId));
    p.seeAfterBroadcast({ ...completed(PREPARED_AT + 2_000), bridgeId } as LiquidityTankObservation);
    await expect(p.run()).resolves.toMatchObject({ status: "settled", settlement: { txRef: { bridgeId } } });
    p.tick();
    await expect(p.run()).resolves.toMatchObject({ status: "settled", settlement: { txRef: { bridgeId } } });
  });

});

describe("a stored settlement is checked field by field before it is reported", () => {
  type Settlement = Record<string, Record<string, unknown> | unknown>;
  const at = (part: string, fields: Record<string, unknown>) => (settlement: Settlement) =>
    ({ ...settlement, [part]: { ...(settlement[part] as object), ...fields } });
  test.each([
    // A number would match the ID grammar once coerced to a string.
    ["a numeric bridge ID", at("txRef", { bridgeId: 308 })],
    ["another txRef kind", at("txRef", { kind: "htlc-lock" })],
    ["another source chain", at("txRef", { sourceChainId: 1 })],
    ["another destination chain", at("txRef", { destChainId: 1 })],
    ["another amount", at("paymentAmount", { amount: "1.26" })],
    ["another currency", at("paymentAmount", { currency: "USDT" })],
    ["another finality model", at("settlementFinality", { model: "htlc" })],
    ["an authentication hash that is not 64 hex", (s: Settlement) => ({ ...s, authenticationHash: "a".repeat(63) })],
    ["finality at the recovery deadline", at("settlementFinality", { finalityObservedAt: D })],
  ])("%s is refused", async (_label, rewrite) => {
    let rewriting = false;
    const store = patched((inner) => ({
      claim: async (input) => {
        const claimed = await inner.claim(input);
        return rewriting && claimed.status === "settled"
          ? { ...claimed, settlement: rewrite(claimed.settlement as never) }
          : claimed;
      },
    }) as Partial<LiquidityTankStore>);
    const p = phase({ store });
    p.seeAfterBroadcast(completed(PREPARED_AT + 2_000));
    await expect(p.run()).resolves.toMatchObject({ status: "settled" });
    rewriting = true;
    p.tick();
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-stored-settlement-mismatch",
    });
  });
});

describe("a retained row without its submission", () => {
  test("a claim holding failure evidence but no submission never signs a new one", async () => {
    const store = patched((inner) => ({
      claim: async (input) => {
        const claimed = await inner.claim(input);
        return claimed.status === "acquired"
          ? { ...claimed, recoveryFailure: { status: "failed-after-lock" } } as never
          : claimed;
      },
    }));
    const p = phase({ store });
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt",
    });
    expect(p.prepareSubmission).not.toHaveBeenCalled();
    expect(p.broadcastRetained).not.toHaveBeenCalled();
  });
});

describe("a replayed expiry re-authenticates its evidence of every kind", () => {
  test.each(["pending", "completed", "failed"] as const)("refused %s evidence is not reported as terminal", async (kind) => {
    let refuse = false;
    const verifier: LiquidityTankVerifier = {
      authenticateObservation: async ({ observation }) => !(refuse && observation.status === kind),
      verifySignedSubmission: async () => true,
    };
    const p = phase({ verifier });
    if (kind === "pending") {
      await lockDurably(p, D);
      p.at(D + 100);
      p.see(locked(D));
      await expect(p.run()).resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
    } else if (kind === "completed") {
      await lockDurably(p);
      p.at(D + 100);
      p.see(completed(D + 1));
      await expect(p.run()).resolves.toMatchObject({ status: "failed", reason: "tank-released-after-recovery-deadline" });
    } else {
      p.seeAfterBroadcast(lockBearingFailure());
      await expect(p.run()).resolves.toMatchObject({ status: "settle-asymmetric", bridgeStatus: "failed" });
      p.at(D + 100);
      await expect(p.run()).resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
    }
    refuse = true;
    p.tick();
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-retained-observation-unauthenticated",
    });
  });
});

describe("a verifier outage on retained failure evidence never expires the lock", () => {
  test.each(["checkpoint", "failure"] as const)("the %s leg unavailable past the deadline", async (leg) => {
    let outage = false;
    const verifier: LiquidityTankVerifier = {
      authenticateObservation: async ({ observation }) =>
        outage && (leg === "failure" ? observation.status === "failed" : observation.status === "pending")
          ? "unavailable" : true,
      verifySignedSubmission: async () => true,
    };
    const p = phase({ verifier });
    await lockDurably(p);
    p.see(lockBearingFailure());
    p.tick();
    await expect(p.run()).resolves.toMatchObject({ status: "settle-asymmetric", bridgeStatus: "failed" });
    outage = true;
    p.at(D + 100);
    const recordRecoveryExpired = vi.spyOn(p.store, "recordRecoveryExpired");
    await expect(p.run()).resolves.toMatchObject({ status: "settle-asymmetric", pastDeadline: true });
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
  });
});

describe("failure retention counts only a successful write with an exact, readable echo", () => {
  test.each([
    ["a refusal that echoes the exact evidence", (sent: unknown) => ({ status: "conflict", reason: "x", recoveryFailure: sent })],
    ["a success whose echo is not canonical JSON", (sent: unknown) => ({ status: "recorded", recoveryFailure: { ...(sent as object), extra: -0 } })],
    ["a write that throws", () => { throw new Error("database unavailable"); }],
  ])("%s", async (_label, answer) => {
    const store = patched(() => ({ recordRecoveryFailure: async (input) => answer(input.recoveryFailure) as never }));
    const p = phase({ store });
    await lockDurably(p);
    p.see(lockBearingFailure());
    p.tick();
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-failure-persistence-uncertain",
    });
  });
});

describe("a late release with no prior durable observation", () => {
  test("a first read that is a completion finalized at the deadline commits its expiry, with the lock and the release", async () => {
    const p = phase();
    p.at(D + 100);
    p.prepareWith({ preparedAt: D + 100 });
    p.see(completed(D));
    const lock = {
      kind: "liquidity-tank", bridgeId: BRIDGE_ID, sourceChainId: 11_155_111, destChainId: 80_002,
      lockTxHash: "source-lock-tx", recoveryDeadline: D,
    };
    const release = { txRef: { ...lock, releaseTxHash: "destination-release-tx" }, finalityObservedAt: D };
    const result = await p.run();
    expect(result).toEqual({
      status: "failed", errorClass: "failed-substrate", reason: "tank-released-after-recovery-deadline",
      reputationNeutral: true, lockTxRef: lock, ...release,
    });
    // The host anchors the interim record from the lock and reconciles the paid release.
    expect(liquidityTankPhaseOutcome(result)).toMatchObject({ interimTxRef: lock, release });
  });
});

describe("store claims", () => {
  test.each(["settled", "waiting", "recovery-expired"] as const)("a %s claim without the intent echo is refused", async (status) => {
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const p = phase({ store: inner });
    p.seeAfterBroadcast(completed(PREPARED_AT + 2_000));
    await expect(p.run()).resolves.toMatchObject({ status: "settled" });
    const store: LiquidityTankStore = {
      ...inner,
      restartSafety: "volatile-acknowledged",
      claim: async (input) => {
        const { intent: _intent, ...rest } = await inner.claim(input) as Record<string, unknown>;
        return { ...rest, status } as never;
      },
    };
    await expect(phase({ store }).run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-settlement-store-claim-invalid",
    });
  });

  test("an unknown claim status with an exact lease is refused before any effect", async () => {
    const store = patched((inner) => ({
      claim: async (input) => ({ ...(await inner.claim(input)), status: "granted" }) as never,
    }));
    const p = phase({ store });
    await expect(p.run()).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-settlement-store-claim-invalid" });
    expect(p.prepareSubmission).not.toHaveBeenCalled();
  });

  test("a claim that throws is a store outage", async () => {
    const p = phase({ store: patched(() => ({ claim: async () => { throw new Error("database unavailable"); } })) });
    await expect(p.run()).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-settlement-store-unavailable" });
    expect(p.prepareSubmission).not.toHaveBeenCalled();
  });

  test.each([
    ["generation 0", { generation: 0 }],
    ["a fractional generation", { generation: 1.5 }],
    ["an expiry at the claim's now", { expiresAt: PREPARED_AT + 500 }],
    ["an empty owner", { owner: "" }],
  ])("a waiting lease with %s is refused", async (_label, lease) => {
    const store = patched((inner) => ({
      claim: async (input) => {
        const claimed = await inner.claim(input);
        return {
          ...claimed, status: "waiting",
          lease: { owner: "other-worker", generation: 3, expiresAt: input.now + 1_000, ...lease },
        } as never;
      },
    }));
    await expect(phase({ store }).run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-settlement-store-lease-invalid",
    });
  });

  test.each([
    ["another owner", { owner: "another-worker" }],
    ["generation 0", { generation: 0 }],
    ["a fractional generation", { generation: 1.5 }],
  ])("an acquired lease with %s is refused before any effect", async (_label, lease) => {
    const store = patched((inner) => ({
      claim: async (input) => {
        const claimed = await inner.claim(input) as { lease: object };
        return { ...claimed, lease: { ...claimed.lease, ...lease } } as never;
      },
    }));
    const p = phase({ store });
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-settlement-store-lease-invalid",
    });
    expect(p.prepareSubmission).not.toHaveBeenCalled();
  });

  test.each([
    ["an observation", { observation: empty() }],
    ["a submission receipt", { submissionRecordedAt: PREPARED_AT + 500 }],
  ])("an acquired row with %s but no submission is corrupt, and nothing is signed", async (_label, extra) => {
    const store = patched((inner) => ({
      claim: async (input) => ({ ...(await inner.claim(input)), ...extra }) as never,
    }));
    const p = phase({ store });
    await expect(p.run()).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" });
    expect(p.prepareSubmission).not.toHaveBeenCalled();
  });

  test("a recovery-expired claim whose submission is corrupt is reported, not thrown", async () => {
    const inner = createInMemoryLiquidityTankStore(VOLATILE);
    const p = phase({ store: inner });
    await lockDurably(p, D);
    p.at(D + 100);
    p.see(locked(D));
    await expect(p.run()).resolves.toMatchObject({ status: "failed", errorClass: "failed-substrate" });
    const store: LiquidityTankStore = {
      ...inner,
      restartSafety: "volatile-acknowledged",
      claim: async (input) => {
        const claimed = await inner.claim(input) as { submission: Record<string, unknown> };
        return {
          ...claimed,
          submission: { ...claimed.submission, signedSubmissionBase64: Buffer.from("other").toString("base64") },
        } as never;
      },
    };
    const q = phase({ store });
    q.at(D + 200);
    await expect(q.run()).resolves.toEqual({ status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" });
  });
});

describe("reasons", () => {
  test("an adapter's own indeterminate reason is prefixed, so it never reads as a core reason", async () => {
    const p = phase();
    p.see({ status: "indeterminate", reason: "liquidity-tank-retained-state-corrupt" });
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate",
      reason: "liquidity-tank-adapter-indeterminate: liquidity-tank-retained-state-corrupt",
    });
  });

  test("a late completion read before the host clock reaches the deadline is neither settled nor expired", async () => {
    const p = phase();
    await lockDurably(p);
    p.see(completed(D));
    p.at(D - 100);
    const recordSettlement = vi.spyOn(p.store, "recordSettlement");
    const recordRecoveryExpired = vi.spyOn(p.store, "recordRecoveryExpired");
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-completion-finality-invalid",
    });
    expect(recordSettlement).not.toHaveBeenCalled();
    expect(recordRecoveryExpired).not.toHaveBeenCalled();
  });

  test("an expiry write that throws is uncertain persistence, not a terminal result", async () => {
    const store = patched(() => ({ recordRecoveryExpired: async () => { throw new Error("database unavailable"); } }));
    const p = phase({ store });
    await lockDurably(p, D);
    p.at(D + 100);
    p.see(locked(D));
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-recovery-expiry-persistence-uncertain",
    });
  });

  test("a clock that fails before the submission write stores nothing", async () => {
    let broken = false;
    const verifier: LiquidityTankVerifier = {
      authenticateObservation: async () => true,
      verifySignedSubmission: async () => { broken = true; return true; },
    };
    const p = phase({ verifier });
    p.clockFrom(() => {
      if (broken) throw new Error("clock unavailable");
      return PREPARED_AT + 500;
    });
    const recordSubmission = vi.spyOn(p.store, "recordSubmission");
    await expect(p.run()).resolves.toEqual({
      status: "indeterminate", reason: "liquidity-tank-submission-persistence-uncertain",
    });
    expect(recordSubmission).not.toHaveBeenCalled();
  });

  test("a clock that fails at expiry time commits nothing", async () => {
    // A dry run counts the clock readings up to the expiry write; the second run fails exactly that one.
    const expiryReading = async (failAt: number) => {
      let readings = 0;
      let readingAtExpiry: number | undefined;
      const store = patched((inner) => ({
        recordRecoveryExpired: (input) => {
          readingAtExpiry ??= readings;
          return inner.recordRecoveryExpired(input);
        },
      }));
      const p = phase({ store });
      await lockDurably(p, D);
      p.see(locked(D));
      p.clockFrom(() => {
        readings += 1;
        if (readings === failAt) throw new Error("clock unavailable");
        return D + 100;
      });
      return { result: await p.run(), readingAtExpiry };
    };
    const dry = await expiryReading(0);
    expect(dry.result).toMatchObject({ status: "failed", errorClass: "failed-substrate" });
    const failing = await expiryReading(dry.readingAtExpiry as number);
    expect(failing).toEqual({
      result: { status: "indeterminate", reason: "liquidity-tank-clock-invalid" },
      readingAtExpiry: undefined,
    });
  });
});

describe("ST-8 source-lock finality is the verifier's gate", () => {
  test.each([
    ["not final yet", "unavailable" as const, "liquidity-tank-verifier-unavailable"],
    ["refused", false, "liquidity-tank-observation-unauthenticated"],
  ])("a lock the verifier answers %s for never enters settle-asymmetric", async (_label, answer, reason) => {
    let final = false;
    const verifier: LiquidityTankVerifier = {
      authenticateObservation: async ({ observation }) =>
        !final && observation.status === "pending" && "lockTxHash" in observation ? answer : true,
      verifySignedSubmission: async () => true,
    };
    const p = phase({ verifier });
    p.seeAfterBroadcast(locked(PREPARED_AT + 1_000));
    const recordObservation = vi.spyOn(p.store, "recordObservation");
    await expect(p.run()).resolves.toEqual({ status: "indeterminate", reason });
    expect(recordObservation.mock.calls.map(([input]) => input.observation.status)).toEqual(["empty"]);
    final = true;
    p.tick();
    await expect(p.run()).resolves.toMatchObject({ status: "settle-asymmetric", reason: "tank-locked-unreleased" });
  });
});

describe("mapping progress to DACS phase results", () => {
  const LOCK = {
    kind: "liquidity-tank", bridgeId: BRIDGE_ID, sourceChainId: 11_155_111, destChainId: 80_002,
    lockTxHash: "source-lock-tx", recoveryDeadline: D,
  } as const;
  const RELEASE = { ...LOCK, releaseTxHash: "destination-release-tx" } as const;
  const expiry = (reason: string, release?: { txRef: Record<string, unknown>; finalityObservedAt: number }) => [
    { status: "failed", errorClass: "failed-substrate", reason, reputationNeutral: true, lockTxRef: LOCK,
      ...(release ?? {}) },
    {
      kind: "result", ok: false, errorClass: "substrate", evidenceOutcome: "failure",
      evidenceReason: "tank-locked-unreleased", interimTxRef: LOCK, bundleCause: "failed-substrate",
      progressReason: reason, ...(release ? { release } : {}),
    },
  ] as const;
  const MAPPINGS: readonly (readonly [string, unknown, unknown])[] = [
    ["settled", { status: "settled", settlement: {} }, { kind: "result", ok: true, evidenceOutcome: "success" }],
    ["locked", { status: "settle-asymmetric", reason: "tank-locked-unreleased", txRef: LOCK },
      { kind: "interim", evidenceOutcome: "failure", evidenceReason: "tank-locked-unreleased", interimTxRef: LOCK }],
    ["contradicted", { status: "settle-asymmetric", reason: "lock-contradicted", txRef: LOCK },
      { kind: "interim", evidenceOutcome: "failure", evidenceReason: "tank-locked-unreleased", interimTxRef: LOCK }],
    ["tank-locked-unreleased-recovery-expired", ...expiry("tank-locked-unreleased-recovery-expired")],
    ["tank-lock-contradicted-recovery-expired", ...expiry("tank-lock-contradicted-recovery-expired")],
    ["tank-released-after-recovery-deadline, with the release",
      ...expiry("tank-released-after-recovery-deadline", { txRef: RELEASE, finalityObservedAt: D })],
    ["tank-lock-contradicted-recovery-expired, with another lock's release",
      ...expiry("tank-lock-contradicted-recovery-expired", {
        txRef: { ...RELEASE, lockTxHash: "other-lock-tx" }, finalityObservedAt: D + 1,
      })],
    ["permanent", { status: "failed", errorClass: "permanent", reason: "bridge rejected" },
      { kind: "result", ok: false, errorClass: "permanent", progressReason: "bridge rejected" }],
    ["waiting", { status: "waiting", reason: "liquidity-tank-settlement-held" }, { kind: "none" }],
    ["indeterminate", { status: "indeterminate", reason: "liquidity-tank-status-unavailable" }, { kind: "none" }],
  ];

  test.each(MAPPINGS)("%s", (_label, progress, outcome) => {
    expect(liquidityTankPhaseOutcome(progress as LiquidityTankProgress)).toEqual(outcome);
  });

  test.each([
    ["without its lock", { lockTxRef: undefined }],
    ["with a release but no finality", { txRef: RELEASE }],
  ])("a failed-substrate progress %s is refused, never mapped", (_label, fields) => {
    const progress = { ...expiry("tank-locked-unreleased-recovery-expired")[0], ...fields };
    expect(() => liquidityTankPhaseOutcome(progress as LiquidityTankProgress))
      .toThrow("failed-substrate progress lacks its lock evidence");
  });

  test("every errorClass it returns is in the SDK's DACS errorClass vocabulary", () => {
    const classes: BundlePhaseErrorClass[] = [];
    for (const progress of [
      expiry("tank-locked-unreleased-recovery-expired")[0],
      { status: "failed", errorClass: "permanent", reason: "bridge rejected" },
    ] as LiquidityTankProgress[]) {
      const outcome = liquidityTankPhaseOutcome(progress);
      if (outcome.kind === "result" && !outcome.ok) classes.push(outcome.errorClass);
    }
    expect(classes).toEqual(["substrate", "permanent"]);
  });

  test("is exported from the rails and root barrels", () => {
    expect(typeof liquidityTankPhaseOutcome).toBe("function");
    expect(rails.liquidityTankPhaseOutcome).toBe(liquidityTankPhaseOutcome);
    expect(root.liquidityTankPhaseOutcome).toBe(liquidityTankPhaseOutcome);
  });
});

describe("an expiry is the first result a host sees", () => {
  // The host never saw settle-asymmetric, so the expiry itself must carry the
  // lock the interim record names (DACS-5 SEB-3).
  const LOCKED_EXPIRY = {
    status: "failed", errorClass: "failed-substrate", reason: "tank-locked-unreleased-recovery-expired",
    reputationNeutral: true,
    lockTxRef: {
      kind: "liquidity-tank", bridgeId: BRIDGE_ID, sourceChainId: 11_155_111, destChainId: 80_002,
      lockTxHash: "source-lock-tx", recoveryDeadline: D,
    },
  };

  test.each([
    ["a locked pending stamped past the deadline", locked(D + 50)],
    ["a lock-bearing failure", lockBearingFailure(D - 20_000)],
  ])("the first read after broadcast is %s, and the host clock is past the deadline", async (_label, first) => {
    const p = phase();
    p.at(D + 100);
    p.prepareWith({ preparedAt: D - 30_000 });
    p.see(empty(D - 30_000));
    p.seeAfterBroadcast(first);
    const result = await p.run();
    expect(result).toEqual(LOCKED_EXPIRY);
    expect(liquidityTankPhaseOutcome(result)).toMatchObject({ interimTxRef: LOCKED_EXPIRY.lockTxRef });
    p.tick();
    await expect(p.run()).resolves.toEqual(LOCKED_EXPIRY);
  });

  test("a host that lost its settle-asymmetric result still gets the lock with the expiry", async () => {
    const p = phase();
    await lockDurably(p);
    p.see(locked(D + 1));
    p.at(D + 100);
    await expect(p.run()).resolves.toEqual(LOCKED_EXPIRY);
  });
});

describe("the core fences its own effects when the adapter never calls the fence", () => {
  /**
   * The phase's lease reads as lapsed from the `lapseAt`-th `isCurrent` call of
   * the armed run on; every call and effect is logged in order.
   */
  function lapsing() {
    const events: string[] = [];
    let calls = 0;
    let lapseAt = Infinity;
    const logged = (name: string, inner: LiquidityTankStore) =>
      (async (input: never) => {
        events.push(name);
        return (inner[name as keyof LiquidityTankStore] as (value: never) => Promise<unknown>)(input);
      }) as never;
    const store = patched((inner) => ({
      isCurrent: async (input) => {
        calls += 1;
        events.push("isCurrent");
        return calls >= lapseAt ? false : inner.isCurrent(input);
      },
      recordSubmission: logged("recordSubmission", inner),
      recordObservation: logged("recordObservation", inner),
      recordRecoveryFailure: logged("recordRecoveryFailure", inner),
      recordRecoveryExpired: logged("recordRecoveryExpired", inner),
      recordSettlement: logged("recordSettlement", inner),
    }));
    return {
      store, events,
      arm(at: number) { calls = 0; lapseAt = at; events.length = 0; },
    };
  }

  /** The 1-based index, among the armed run's `isCurrent` calls, of the one just before or after `effect`. */
  function fenceIndex(events: readonly string[], effect: string, side: "before" | "after"): number {
    const at = events.indexOf(effect);
    expect(at).toBeGreaterThanOrEqual(0);
    const checksBefore = events.slice(0, at).filter((event) => event === "isCurrent").length;
    if (side === "before") {
      expect(events[at - 1]).toBe("isCurrent");
      return checksBefore;
    }
    expect(events.slice(at + 1).includes("isCurrent")).toBe(true);
    return checksBefore + 1;
  }

  type Scenario = {
    setup?: (p: ReturnType<typeof phase>) => Promise<void>;
    effect: string;
    side: "before" | "after";
    reason: string;
    never: string;
  };
  const SCENARIOS: Record<string, Scenario> = {
    "before preparation": {
      effect: "prepareSubmission", side: "before", never: "prepareSubmission",
      reason: "liquidity-tank-submission-preparation-unavailable",
    },
    "after preparation": {
      effect: "prepareSubmission", side: "after", never: "recordSubmission",
      reason: "liquidity-tank-submission-preparation-unavailable",
    },
    "after the submission write": {
      effect: "recordSubmission", side: "after", never: "broadcastRetained",
      reason: "liquidity-tank-submission-persistence-uncertain",
    },
    "before the status read": {
      effect: "observe", side: "before", never: "observe",
      reason: "liquidity-tank-status-unavailable",
    },
    "after the status read": {
      effect: "observe", side: "after", never: "broadcastRetained",
      reason: "liquidity-tank-status-unavailable",
    },
    "before the broadcast": {
      effect: "broadcastRetained", side: "before", never: "broadcastRetained",
      reason: "liquidity-tank-broadcast-outcome-uncertain",
    },
    "after the broadcast": {
      effect: "broadcastRetained", side: "after", never: "recordObservation",
      reason: "liquidity-tank-broadcast-outcome-uncertain",
    },
    "before the settlement write": {
      setup: async (p) => { p.seeAfterBroadcast(completed(PREPARED_AT + 2_000)); },
      effect: "recordSettlement", side: "before", never: "recordSettlement",
      reason: "liquidity-tank-settlement-persistence-uncertain",
    },
    "before retaining failure evidence": {
      setup: async (p) => { await lockDurably(p); p.see(lockBearingFailure()); p.tick(); },
      effect: "recordRecoveryFailure", side: "before", never: "recordRecoveryFailure",
      reason: "liquidity-tank-failure-persistence-uncertain",
    },
    "after retaining failure evidence": {
      setup: async (p) => { await lockDurably(p); p.see(lockBearingFailure()); p.at(D + 100); },
      effect: "recordRecoveryFailure", side: "after", never: "recordRecoveryExpired",
      reason: "liquidity-tank-failure-persistence-uncertain",
    },
  };

  test.each(Object.keys(SCENARIOS))("a lease lapsing %s stops the next effect", async (name) => {
    const scenario = SCENARIOS[name] as Scenario;
    const runArmed = async (at: number) => {
      const lapse = lapsing();
      const p = phase({ store: lapse.store, events: lapse.events });
      await scenario.setup?.(p);
      lapse.arm(at);
      const result = await p.run();
      return { result, events: [...lapse.events] };
    };
    const dry = await runArmed(Infinity);
    const index = fenceIndex(dry.events, scenario.effect, scenario.side);
    const armed = await runArmed(index);
    expect(armed.result).toMatchObject({ reason: scenario.reason });
    const fenceEvent = armed.events.reduce((seen, event, at) =>
      event === "isCurrent" && armed.events.slice(0, at + 1).filter((e) => e === "isCurrent").length === index ? at : seen, -1);
    expect(armed.events.slice(fenceEvent + 1)).not.toContain(scenario.never);
  });
});
