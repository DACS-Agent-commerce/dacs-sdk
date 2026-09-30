import { describe, expect, test, vi } from "vitest";

import { canonicalize, sha256Hex } from "../../src/canonical/index.js";

import {
  advanceCrossChainHtlc,
  crossChainHtlcSettlementKey,
  crossChainHtlcSourceFinalityCheckpointHash,
  createCrossChainHtlcIntent,
  createInMemoryCrossChainHtlcStore,
  deriveHtlcPreimage,
  generateHtlcBuyerSalt,
  type AdvanceCrossChainHtlcInput,
  type CrossChainHtlcAdapter,
  type CrossChainHtlcAuthority,
  type CrossChainHtlcIntent,
  type CrossChainHtlcStore,
  type HtlcAction,
  type HtlcLedgerSnapshot,
  type HtlcObservedAction,
  type HtlcPreparedAction,
  type HtlcTxRef,
} from "../../src/rails/crossChainHtlc.js";

const AGREEMENT_HASH = "a".repeat(64);
const RAIL_HASH = "b".repeat(64);
const AUTH_HASH = "c".repeat(64);
const SALT = Uint8Array.from({ length: 16 }, () => 1);
const PREIMAGE_HEX = Buffer.from(deriveHtlcPreimage({
  buyerSalt: SALT,
  jobId: "job-1",
  agreementHash: AGREEMENT_HASH,
})).toString("hex");

function authority(overrides: Partial<CrossChainHtlcAuthority> = {}): CrossChainHtlcAuthority {
  return {
    jobId: "job-1",
    phaseIndex: 2,
    railId: "htlc-route-1",
    railDescriptorHash: RAIL_HASH,
    agreementHash: AGREEMENT_HASH,
    assetKind: "stablecoin-cross-chain",
    networkKind: "cross-chain",
    mechanism: "htlc",
    sourceChainId: 84532,
    destinationChainId: 80002,
    sourceAsset: "USDC",
    destinationAsset: "USDC",
    sourceTokenDecimals: 6,
    destinationTokenDecimals: 6,
    amount: "01.2500",
    currency: "USDC",
    payerSourceAddress: "payer-source",
    payerDestinationAddress: "payer-destination",
    payeeSourceAddress: "payee-source",
    payeeDestinationAddress: "payee-destination",
    sourceContractAddress: "source-contract",
    destinationContractAddress: "destination-contract",
    sourceFinalitySec: 20,
    destinationFinalitySec: 15,
    safetyWindowSec: 10,
    sourceTimelockSec: 500,
    destinationTimelockSec: 100,
    ...overrides,
  };
}

const hashlocks = {
  deriveHashlock({ chainId, preimage }: { chainId: number; preimage: Uint8Array }): string {
    return `${chainId}:${Buffer.from(preimage).toString("hex")}`;
  },
};

function refFor(action: HtlcAction, suffix = ""): HtlcTxRef {
  const txHash = `tx-${action}${suffix}`;
  if (action === "source-lock") return {
    kind: "htlc-lock",
    chainId: 84532,
    contractAddress: "source-contract",
    lockTxHash: txHash,
  };
  if (action === "destination-lock") return {
    kind: "htlc-lock",
    chainId: 80002,
    contractAddress: "destination-contract",
    lockTxHash: txHash,
  };
  if (action === "destination-claim") return {
    kind: "htlc-reveal",
    chainId: 80002,
    contractAddress: "destination-contract",
    revealTxHash: txHash,
  };
  if (action === "source-claim") return {
    kind: "htlc-claim",
    chainId: 84532,
    contractAddress: "source-contract",
    claimTxHash: txHash,
  };
  return {
    kind: "htlc-refund",
    chainId: action === "source-refund" ? 84532 : 80002,
    contractAddress: action === "source-refund" ? "source-contract" : "destination-contract",
    refundTxHash: txHash,
  };
}

function preparedFor(
  intent: Readonly<CrossChainHtlcIntent>,
  action: HtlcAction,
  suffix = "",
  sourceFinalityCheckpointHash?: string,
): Readonly<HtlcPreparedAction> {
  const unsigned = {
    actionVersion: "1" as const,
    action,
    actor: action === "destination-lock" || action === "source-claim" ||
      action === "destination-refund" ? "payee" as const : "payer" as const,
    authorityHash: intent.bindingHash,
    txRef: refFor(action, suffix),
    signedPayloadBase64: Buffer.from(`wire-${action}${suffix}`, "utf8").toString("base64"),
    preparedAt: 1_000,
    ...(sourceFinalityCheckpointHash === undefined ? {} : { sourceFinalityCheckpointHash }),
  };
  return Object.freeze({ ...unsigned, effectHash: sha256Hex(canonicalize(unsigned)) });
}

interface HarnessOptions {
  mode?: Partial<Record<HtlcAction, "final" | "pending" | "throw-once">>;
  sourceExpiry?: number;
  destinationExpiry?: number;
  revealedPreimageHex?: string;
  sourceFinalityObservedAt?: number;
  destinationIncludedAt?: number;
}

function harness(options: HarnessOptions = {}) {
  const actions: Partial<Record<HtlcAction, HtlcObservedAction>> = {};
  const preimages = new Map<HtlcAction, string | undefined>();
  const throwConsumed = new Set<HtlcAction>();
  const modes = { ...options.mode };
  let observedAt = 1_000_000;
  const prepareAction = vi.fn<CrossChainHtlcAdapter["prepareAction"]>(async (request, fence) => {
    await fence.assertCurrent();
    preimages.set(
      request.action,
      request.preimage ? Buffer.from(request.preimage).toString("hex") : undefined,
    );
    return {
      actionVersion: "1",
      action: request.action,
      actor: request.actor,
      authorityHash: request.intent.bindingHash,
      txRef: refFor(
        request.action,
        request.replacement ? `-attempt-${request.replacement.attempt}` : "",
      ),
      signedPayloadBase64: Buffer.from(
        `wire-${request.action}${request.replacement ? `-attempt-${request.replacement.attempt}` : ""}`,
        "utf8",
      ).toString("base64"),
      preparedAt: observedAt,
      ...(request.sourceFinalityCheckpoint === undefined
        ? {}
        : {
          sourceFinalityCheckpointHash: crossChainHtlcSourceFinalityCheckpointHash(
            request.sourceFinalityCheckpoint,
          ),
        }),
    };
  });
  const broadcastRetained = vi.fn<CrossChainHtlcAdapter["broadcastRetained"]>(async (prepared, fence) => {
    await fence.assertCurrent();
    const mode = modes[prepared.action] ?? "final";
    if (mode === "throw-once" && !throwConsumed.has(prepared.action)) {
      throwConsumed.add(prepared.action);
      throw new Error("ambiguous transport");
    }
    if (mode === "throw-once") return;
    if (mode === "pending") {
      actions[prepared.action] = {
        state: "pending",
        txRef: prepared.txRef,
        authenticationHash: AUTH_HASH,
      };
      return;
    }
    actions[prepared.action] = {
      state: "final",
      txRef: prepared.txRef,
      finalityObservedAt: prepared.action === "source-lock"
        ? options.sourceFinalityObservedAt ?? observedAt
        : observedAt,
      includedAt: prepared.action === "source-lock"
        ? observedAt
        : prepared.action === "destination-lock"
          ? options.destinationIncludedAt ?? observedAt
        : undefined,
      expiresAt: prepared.action === "source-lock"
        ? options.sourceExpiry ?? 5_000
        : prepared.action === "destination-lock"
          ? options.destinationExpiry ?? 1_500
          : undefined,
      revealedPreimageHex: prepared.action === "destination-claim"
        ? options.revealedPreimageHex ?? preimages.get(prepared.action)
        : undefined,
      authenticationHash: AUTH_HASH,
    };
  });
  const observe = vi.fn<CrossChainHtlcAdapter["observe"]>(async (_intent, fence) => {
    await fence.assertCurrent();
    return {
      observedAt,
      authenticationHash: AUTH_HASH,
      actions: { ...actions },
    } satisfies HtlcLedgerSnapshot;
  });
  return {
    adapter: { observe, prepareAction, broadcastRetained } satisfies CrossChainHtlcAdapter,
    actions,
    preimages,
    prepareAction,
    broadcastRetained,
    observe,
    setMode(action: HtlcAction, mode: NonNullable<HarnessOptions["mode"]>[HtlcAction]) {
      if (mode === undefined) delete modes[action];
      else modes[action] = mode;
    },
    setObservedAt(value: number) { observedAt = value; },
    markFinal(action: HtlcAction, overrides: Partial<Extract<HtlcObservedAction, { state: "final" }>> = {}) {
      const prepared = prepareAction.mock.results
        .map((result) => result.value)
        .find((_value, index) => prepareAction.mock.calls[index]?.[0].action === action);
      if (!prepared) throw new Error(`action ${action} was not prepared`);
      return Promise.resolve(prepared).then((value) => {
        actions[action] = {
          state: "final",
          txRef: value.txRef,
          finalityObservedAt: observedAt,
          authenticationHash: AUTH_HASH,
          ...overrides,
        };
      });
    },
  };
}

function runner(overrides: Partial<AdvanceCrossChainHtlcInput> = {}) {
  let clock = 1_000_000;
  const shared: AdvanceCrossChainHtlcInput = {
    authority: authority(),
    buyerSalt: SALT,
    hashlocks,
    authorizeDestinationClaim: true,
    owner: "worker-a",
    store: createInMemoryCrossChainHtlcStore(),
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

async function sourceClaimStoreFixture(options: {
  checkpoint?: boolean;
  leaseDurationMs?: number;
  sourceExpiry?: number;
} = {}) {
  const { intent, secrets } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
  const store = createInMemoryCrossChainHtlcStore();
  const claimed = await store.claim({
    intent,
    secrets,
    owner: "direct-owner",
    now: 1_000,
    leaseDurationMs: options.leaseDurationMs ?? 100,
  });
  if (claimed.status !== "acquired") throw new Error("fixture lease not acquired");
  const prior = preparedFor(intent, "source-claim", "-attempt-1");
  const recorded = await store.recordPrepared({
    settlementKey: intent.settlementKey,
    bindingHash: intent.bindingHash,
    owner: claimed.lease.owner,
    generation: claimed.lease.generation,
    prepared: prior,
  });
  if (recorded.status !== "recorded") throw new Error("fixture source claim not recorded");
  if (options.checkpoint !== false) {
    const checkpointed = await store.recordRevealFinal({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner: claimed.lease.owner,
      generation: claimed.lease.generation,
      checkpoint: {
        revealTxRef: refFor("destination-claim") as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
        sourceExpiry: options.sourceExpiry ?? 5_000,
        finalityObservedAt: 1_000,
        authenticationHash: AUTH_HASH,
      },
    });
    if (checkpointed.status !== "recorded") throw new Error("fixture checkpoint not recorded");
  }
  const failedObservation = {
    state: "failed" as const,
    txRef: prior.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
    reason: "authenticated rejection",
    authenticationHash: AUTH_HASH,
  };
  const replacement = preparedFor(intent, "source-claim", "-attempt-2");
  return { store, intent, secrets, lease: claimed.lease, prior, failedObservation, replacement };
}

describe("HTLC-1..HTLC-8 authority and secret binding", () => {
  test("derives the byte-exact RFC 5869 SHA-256 preimage", () => {
    expect(Buffer.from(deriveHtlcPreimage({
      buyerSalt: SALT,
      jobId: "job-1",
      agreementHash: AGREEMENT_HASH,
    })).toString("hex")).toBe(
      "19b43e7a733e307df369891e948e92a4142bb330ddfe3ccbd8b7feb68d77d1bb",
    );
  });

  test("generates at least 128 bits and rejects shorter salts", () => {
    expect(generateHtlcBuyerSalt().byteLength).toBe(32);
    expect(() => generateHtlcBuyerSalt(15)).toThrow();
    expect(() => createCrossChainHtlcIntent(authority(), new Uint8Array(15), hashlocks)).toThrow();
  });

  test("normalizes amount and binds separate chain-native hashlocks", () => {
    const { intent } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
    const preimageHex = Buffer.from(deriveHtlcPreimage({
      buyerSalt: SALT,
      jobId: "job-1",
      agreementHash: AGREEMENT_HASH,
    })).toString("hex");
    expect(intent).toMatchObject({
      amount: "1.25",
      sourceAmountBaseUnits: "1250000",
      destinationAmountBaseUnits: "1250000",
      destinationFinalitySec: 15,
      sourceHashlock: `84532:${preimageHex}`,
      destinationHashlock: `80002:${preimageHex}`,
    });
  });

  test.each([
    ["asset", { assetKind: "erc20" }],
    ["network", { networkKind: "evm" }],
    ["mechanism", { mechanism: "liquidity-tank" }],
    ["same chain", { destinationChainId: 84532 }],
    ["source finality", { sourceFinalitySec: 0 }],
    ["destination finality", { destinationFinalitySec: 0 }],
    ["timelock margin", { sourceTimelockSec: 130 }],
    ["asset currency", { destinationAsset: "USDT" }],
    ["source precision", { amount: "1.0000001" }],
  ])("rejects invalid %s before effects", async (_name, override) => {
    const h = harness();
    const result = await advanceCrossChainHtlc(runner({
      authority: authority(override as never),
      adapter: h.adapter,
    }).shared);
    expect(result).toMatchObject({ status: "failed", errorClass: "permanent" });
    expect(h.prepareAction).not.toHaveBeenCalled();
  });

  test("uses an unambiguous structured settlement-key preimage", () => {
    expect(crossChainHtlcSettlementKey({ jobId: "a:b", railId: "c", phaseIndex: 1 }))
      .not.toBe(crossChainHtlcSettlementKey({ jobId: "a", railId: "b:c", phaseIndex: 1 }));
  });

  test("binds the required destination finality budget into the canonical intent", () => {
    const baseline = createCrossChainHtlcIntent(authority(), SALT, hashlocks).intent;
    const changed = createCrossChainHtlcIntent(
      authority({ destinationFinalitySec: 16 }),
      SALT,
      hashlocks,
    ).intent;
    expect(changed.destinationFinalitySec).toBe(16);
    expect(changed.bindingHash).not.toBe(baseline.bindingHash);
  });

  test("snapshots authority and salt before invoking hashlock callbacks", () => {
    const mutableAuthority = authority();
    const mutableSalt = Uint8Array.from(SALT);
    const baseline = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
    let calls = 0;
    const mutatingHashlocks = {
      deriveHashlock(args: { chainId: number; preimage: Uint8Array }) {
        calls += 1;
        if (calls === 1) {
          mutableAuthority.payeeSourceAddress = "substituted-payee";
          mutableSalt[0] = 9;
        }
        return hashlocks.deriveHashlock(args);
      },
    };
    const captured = createCrossChainHtlcIntent(
      mutableAuthority,
      mutableSalt,
      mutatingHashlocks,
    );
    expect(captured.intent.payeeSourceAddress).toBe("payee-source");
    expect(captured.intent.buyerSaltHash).toBe(baseline.intent.buyerSaltHash);
    expect(captured.intent.preimageHash).toBe(baseline.intent.preimageHash);
  });
});

describe("advanceCrossChainHtlc", () => {
  test("executes the canonical four-effect order and settles at source-claim finality", async () => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    await expect(advanceCrossChainHtlc(run.shared)).resolves.toMatchObject({ status: "waiting" });
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "waiting" });
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "waiting" });
    const result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result).toMatchObject({
      status: "settled",
      settlement: {
        paymentAmount: { amount: "1.25", currency: "USDC" },
        settlementFinality: { model: "htlc-reveal" },
      },
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual([
      "source-lock",
      "destination-lock",
      "destination-claim",
      "source-claim",
    ]);
    expect((result as Extract<typeof result, { status: "settled" }>).settlement.txRefs.map((ref) => ref.kind))
      .toEqual(["htlc-lock", "htlc-lock", "htlc-reveal", "htlc-claim"]);
    expect(h.preimages.get("source-lock")).toBeUndefined();
    expect(h.preimages.get("destination-lock")).toBeUndefined();
    expect(h.preimages.get("destination-claim")).toHaveLength(64);
  });

  test("never starts destination lock before source-lock finality", async () => {
    const h = harness({ mode: { "source-lock": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner()))
      .resolves.toEqual({ status: "waiting", reason: "htlc-source-lock-finality-pending" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock"]);
  });

  test("restarts by rebroadcasting retained bytes without preparing a replacement", async () => {
    const h = harness({ mode: { "source-lock": "throw-once" } });
    const run = runner({ adapter: h.adapter });
    await expect(advanceCrossChainHtlc(run.shared))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-source-lock-effect-uncertain" });
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "waiting" });
    expect(h.prepareAction).toHaveBeenCalledTimes(1);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(2);
    const wires = h.broadcastRetained.mock.calls.map((call) => call[0].signedPayloadBase64);
    expect(new Set(wires).size).toBe(1);
  });

  test("rejects cross-session buyer-salt reuse in the durable store", async () => {
    const store = createInMemoryCrossChainHtlcStore();
    const first = runner({ store, adapter: harness({ mode: { "source-lock": "pending" } }).adapter });
    await advanceCrossChainHtlc(first.shared);
    first.setClock(2_000_000);
    const second = runner({
      authority: authority({ jobId: "job-2" }),
      store,
      adapter: harness().adapter,
      now: () => 2_000_000,
    });
    await expect(advanceCrossChainHtlc(second.shared)).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-buyer-salt-cross-session-reuse",
    });
  });

  test("honours the payer free-option decision without revealing", async () => {
    const h = harness();
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-not-authorized",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock"]);
  });

  test("rechecks actual absolute expiries before revealing", async () => {
    const h = harness({ sourceExpiry: 1_600, destinationExpiry: 1_580 });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-absolute-expiry-margin-insufficient",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock"]);
  });

  test("reveals one millisecond before, but never at, the destination-finality cutoff", async () => {
    const before = harness({ destinationExpiry: 1_500 });
    const beforeRun = runner({ adapter: before.adapter });
    await advanceCrossChainHtlc(beforeRun.shared);
    await advanceCrossChainHtlc(beforeRun.nextOwner());
    beforeRun.setClock(1_484_999);
    await expect(advanceCrossChainHtlc({ ...beforeRun.shared, owner: "before-cutoff" }))
      .resolves.toEqual({
        status: "waiting",
        reason: "htlc-destination-claim-finality-pending",
      });
    expect(before.prepareAction.mock.calls.map((call) => call[0].action))
      .toContain("destination-claim");

    const at = harness({ destinationExpiry: 1_500 });
    const atRun = runner({ adapter: at.adapter });
    await advanceCrossChainHtlc(atRun.shared);
    await advanceCrossChainHtlc(atRun.nextOwner());
    atRun.setClock(1_485_000);
    await expect(advanceCrossChainHtlc({ ...atRun.shared, owner: "at-cutoff" }))
      .resolves.toEqual({
        status: "waiting",
        reason: "htlc-destination-claim-cutoff-reached",
      });
    expect(at.prepareAction.mock.calls.map((call) => call[0].action))
      .not.toContain("destination-claim");
  });

  test("checkpoints and recovers a delayed final reveal observed after the cutoff", async () => {
    const h = harness({
      destinationExpiry: 1_500,
      mode: { "destination-claim": "pending", "source-claim": "pending" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_490_000);
    await h.markFinal("destination-claim", {
      finalityObservedAt: 1_490_000,
      revealedPreimageHex: h.preimages.get("destination-claim"),
    });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "late-reveal-recovery" }))
      .resolves.toMatchObject({
        status: "settle-asymmetric",
        reason: "dest-revealed-source-unclaimed",
      });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toContain("source-claim");
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .not.toContain("destination-refund");
  });

  test("accepts causally prepared locks when the two chains' timestamps are skewed", async () => {
    const h = harness({ sourceFinalityObservedAt: 1_000_100, destinationIncludedAt: 999_950 });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual([
      "source-lock",
      "destination-lock",
      "destination-claim",
    ]);
  });

  test("persists source finality before preparing the causally bound destination lock", async () => {
    const events: string[] = [];
    const base = createInMemoryCrossChainHtlcStore();
    const store: CrossChainHtlcStore = {
      ...base,
      async recordSourceFinality(input) {
        events.push("source-finality-checkpoint");
        return base.recordSourceFinality(input);
      },
    };
    const h = harness();
    const prepareAction = h.adapter.prepareAction;
    h.adapter.prepareAction = vi.fn(async (...args) => {
      if (args[0].action === "destination-lock") events.push("destination-lock-prepare");
      return prepareAction(...args);
    });
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    expect(events).toEqual(["source-finality-checkpoint", "destination-lock-prepare"]);
    const destinationRequest = h.adapter.prepareAction.mock.calls
      .find((call) => call[0].action === "destination-lock")?.[0];
    expect(destinationRequest?.sourceFinalityCheckpoint).toMatchObject({
      authenticationHash: AUTH_HASH,
      sourceExpiry: 5_000,
      sourceLockTxRef: refFor("source-lock"),
    });
  });

  test("does not prepare a destination lock when source-finality persistence fails", async () => {
    const base = createInMemoryCrossChainHtlcStore();
    const store: CrossChainHtlcStore = {
      ...base,
      async recordSourceFinality() {
        return { status: "stale", reason: "injected-checkpoint-failure" };
      },
    };
    const h = harness();
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-source-finality-persistence-uncertain",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock"]);
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action)).toEqual(["source-lock"]);
  });

  test("reuses a causally bound destination lock byte-for-byte after ambiguous broadcast", async () => {
    const h = harness({ mode: { "destination-lock": "throw-once" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-destination-lock-effect-uncertain",
    });
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-lock-finality-pending",
    });
    const destinationPreparations = h.prepareAction.mock.calls
      .filter((call) => call[0].action === "destination-lock");
    const destinationBroadcasts = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "destination-lock");
    expect(destinationPreparations).toHaveLength(1);
    expect(destinationBroadcasts).toHaveLength(2);
    expect(destinationBroadcasts[1]).toEqual(destinationBroadcasts[0]);
  });

  test("fails closed before effects when a runtime store lacks the checkpoint contract", async () => {
    const base = createInMemoryCrossChainHtlcStore();
    const { recordSourceFinality: _unsupported, ...legacyStore } = base;
    const h = harness();
    await expect(advanceCrossChainHtlc(runner({
      adapter: h.adapter,
      store: legacyStore as CrossChainHtlcStore,
    }).shared)).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-source-finality-store-unsupported",
    });
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.prepareAction).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test.each(["missing", "mismatched"] as const)(
    "fails a takeover with a %s destination-lock causal checkpoint before effects",
    async (mode) => {
      const base = createInMemoryCrossChainHtlcStore();
      const h = harness();
      const run = runner({ adapter: h.adapter, store: base });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      const observeCalls = h.observe.mock.calls.length;
      const prepareCalls = h.prepareAction.mock.calls.length;
      const corruptStore: CrossChainHtlcStore = {
        ...base,
        async claim(input) {
          const claimed = await base.claim(input);
          if (claimed.status !== "acquired") return claimed;
          if (mode === "missing") {
            const { sourceFinalityCheckpoint: _checkpoint, ...withoutCheckpoint } = claimed;
            return withoutCheckpoint;
          }
          if (!claimed.sourceFinalityCheckpoint) throw new Error("expected source checkpoint");
          return {
            ...claimed,
            sourceFinalityCheckpoint: {
              ...claimed.sourceFinalityCheckpoint,
              authenticationHash: "d".repeat(64),
            },
          };
        },
      };
      await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store: corruptStore }))
        .resolves.toMatchObject({ status: "failed", errorClass: "permanent" });
      expect(h.observe).toHaveBeenCalledTimes(observeCalls);
      expect(h.prepareAction).toHaveBeenCalledTimes(prepareCalls);
    },
  );

  test("a final reveal durably blocks refund and enters ST-8 asymmetric recovery", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const asymmetric = await advanceCrossChainHtlc(run.nextOwner());
    expect(asymmetric).toMatchObject({
      status: "settle-asymmetric",
      reason: "dest-revealed-source-unclaimed",
      recoveryDeadline: 5_000,
    });
    run.setClock(5_000_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "after-expiry" })).resolves.toEqual({
      status: "failed",
      errorClass: "settlement-atomicity",
      reason: "dest-revealed-source-unclaimed-expired",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("source-refund");
  });

  test("atomically replaces an authenticated failed source claim and settles", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const prior = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .find((prepared) => prepared.action === "source-claim");
    if (!prior) throw new Error("expected source claim");
    h.actions["source-claim"] = {
      state: "failed",
      txRef: prior.txRef,
      reason: "authenticated rejection",
      authenticationHash: AUTH_HASH,
    };
    h.setMode("source-claim", "final");
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    const sourceClaimPreparations = h.prepareAction.mock.calls
      .filter((call) => call[0].action === "source-claim");
    expect(sourceClaimPreparations).toHaveLength(2);
    expect(sourceClaimPreparations[1]![0].replacement).toMatchObject({
      attempt: 2,
      priorEffectHash: prior.effectHash,
      failureAuthenticationHash: AUTH_HASH,
    });
    const sourceClaimBroadcasts = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "source-claim");
    expect(sourceClaimBroadcasts[1]!.effectHash).not.toBe(prior.effectHash);
    expect(sourceClaimBroadcasts[1]!.txRef).not.toEqual(prior.txRef);
  });

  test("persists a source-claim replacement before broadcasting it", async () => {
    const base = createInMemoryCrossChainHtlcStore();
    const order: string[] = [];
    const replacePreparedSourceClaim = vi.fn<CrossChainHtlcStore["replacePreparedSourceClaim"]>(
      async (input) => {
        order.push("persist");
        return base.replacePreparedSourceClaim(input);
      },
    );
    const store: CrossChainHtlcStore = { ...base, replacePreparedSourceClaim };
    const h = harness({ mode: { "source-claim": "pending" } });
    const originalBroadcast = h.adapter.broadcastRetained;
    h.adapter.broadcastRetained = vi.fn(async (prepared, fence) => {
      if (prepared.action === "source-claim" &&
          prepared.txRef.kind === "htlc-claim" &&
          prepared.txRef.claimTxHash.includes("attempt-2")) {
        order.push("broadcast");
      }
      return originalBroadcast(prepared, fence);
    });
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const prior = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .find((prepared) => prepared.action === "source-claim");
    if (!prior) throw new Error("expected source claim");
    h.actions["source-claim"] = {
      state: "failed",
      txRef: prior.txRef,
      authenticationHash: AUTH_HASH,
    };
    h.setMode("source-claim", "final");
    await advanceCrossChainHtlc(run.nextOwner());
    expect(order).toEqual(["persist", "broadcast"]);
  });

  test("does not broadcast an initial source claim when expiry arrives after persistence", async () => {
    const base = createInMemoryCrossChainHtlcStore();
    let expireClock = () => {};
    const store: CrossChainHtlcStore = {
      ...base,
      async recordPrepared(input) {
        const result = await base.recordPrepared(input);
        if (result.status === "recorded" && input.prepared.action === "source-claim") {
          expireClock();
        }
        return result;
      },
    };
    const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100 });
    const run = runner({ adapter: h.adapter, store });
    expireClock = () => run.setClock(1_500_000);
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "failed",
      errorClass: "settlement-atomicity",
      reason: "dest-revealed-source-unclaimed-expired",
    });
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .not.toContain("source-claim");
  });

  test("does not broadcast a replacement when expiry arrives after its CAS", async () => {
    const base = createInMemoryCrossChainHtlcStore();
    let expireClock = () => {};
    const store: CrossChainHtlcStore = {
      ...base,
      async replacePreparedSourceClaim(input) {
        const result = await base.replacePreparedSourceClaim(input);
        if (result.status === "recorded") expireClock();
        return result;
      },
    };
    const h = harness({
      sourceExpiry: 1_500,
      destinationExpiry: 1_100,
      mode: { "source-claim": "pending" },
    });
    const run = runner({ adapter: h.adapter, store });
    expireClock = () => run.setClock(1_500_000);
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const prior = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .find((prepared) => prepared.action === "source-claim");
    if (!prior) throw new Error("expected source claim");
    h.actions["source-claim"] = {
      state: "failed",
      txRef: prior.txRef,
      authenticationHash: AUTH_HASH,
    };
    h.setMode("source-claim", "final");
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "failed",
      errorClass: "settlement-atomicity",
      reason: "dest-revealed-source-unclaimed-expired",
    });
    const replacementBroadcasts = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "source-claim" &&
        prepared.txRef.kind === "htlc-claim" &&
        prepared.txRef.claimTxHash.includes("attempt-2"));
    expect(replacementBroadcasts).toHaveLength(0);

    const created = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
    const retained = await base.claim({
      ...created,
      owner: "post-expiry-auditor",
      now: 1_500_001,
      leaseDurationMs: 100,
    });
    expect(retained).toMatchObject({
      status: "acquired",
      prepared: [{ action: "source-lock" }, { action: "destination-lock" },
        { action: "destination-claim" }, {
          action: "source-claim",
          txRef: { kind: "htlc-claim", claimTxHash: "tx-source-claim-attempt-2" },
        }],
      sourceClaimAttemptHistory: [{
        attempt: 1,
        prepared: { effectHash: prior.effectHash },
      }],
    });
  });

  test("reuses a persisted ambiguous replacement byte-for-byte without a third preparation", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const prior = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .find((prepared) => prepared.action === "source-claim");
    if (!prior) throw new Error("expected source claim");
    h.actions["source-claim"] = {
      state: "failed",
      txRef: prior.txRef,
      authenticationHash: AUTH_HASH,
    };
    h.setMode("source-claim", "throw-once");
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-source-claim-effect-uncertain",
    });
    h.actions["source-claim"] = { state: "absent", authenticationHash: AUTH_HASH };
    h.setMode("source-claim", "final");
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    const sourceClaimPreparations = h.prepareAction.mock.calls
      .filter((call) => call[0].action === "source-claim");
    expect(sourceClaimPreparations).toHaveLength(2);
    const replacementBroadcasts = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "source-claim" &&
        prepared.txRef.kind === "htlc-claim" &&
        prepared.txRef.claimTxHash.includes("attempt-2"));
    expect(replacementBroadcasts).toHaveLength(2);
    expect(replacementBroadcasts[1]).toEqual(replacementBroadcasts[0]);
  });

  test("never replaces a pending or expired source claim", async () => {
    const h = harness({
      sourceExpiry: 1_500,
      destinationExpiry: 1_100,
      mode: { "source-claim": "pending" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
    });
    expect(h.prepareAction.mock.calls.filter((call) => call[0].action === "source-claim"))
      .toHaveLength(1);
    const prior = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .find((prepared) => prepared.action === "source-claim");
    if (!prior) throw new Error("expected source claim");
    h.actions["source-claim"] = {
      state: "failed",
      txRef: prior.txRef,
      authenticationHash: AUTH_HASH,
    };
    run.setClock(1_500_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "expired-source-claim" }))
      .resolves.toEqual({
        status: "failed",
        errorClass: "settlement-atomicity",
        reason: "dest-revealed-source-unclaimed-expired",
      });
    expect(h.prepareAction.mock.calls.filter((call) => call[0].action === "source-claim"))
      .toHaveLength(1);
  });

  test("rejects a final destination claim that reveals another preimage", async () => {
    const h = harness({ revealedPreimageHex: "00".repeat(32) });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-revealed-preimage-mismatch",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("source-claim");
  });

  test.each([
    ["uppercase", PREIMAGE_HEX.toUpperCase()],
    ["0x prefix", `0x${PREIMAGE_HEX}`],
  ])("accepts byte-equivalent %s revealed preimages and completes recovery", async (_name, revealed) => {
    const h = harness({ revealedPreimageHex: revealed });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toContain("source-claim");
  });

  test("accepts an equivalent 0X preimage when recovering an already-final source claim", async () => {
    const base = createInMemoryCrossChainHtlcStore();
    let failSettlementOnce = true;
    const store: CrossChainHtlcStore = {
      ...base,
      async recordSettlement(input) {
        if (failSettlementOnce) {
          failSettlementOnce = false;
          throw new Error("injected settlement persistence ambiguity");
        }
        return base.recordSettlement(input);
      },
    };
    const h = harness({ revealedPreimageHex: `0X${PREIMAGE_HEX.toUpperCase()}` });
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-settlement-persistence-uncertain",
    });
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    expect(h.prepareAction.mock.calls.filter((call) => call[0].action === "source-claim"))
      .toHaveLength(1);
  });

  test.each([
    ["leading whitespace", ` ${PREIMAGE_HEX}`],
    ["sign", `+${PREIMAGE_HEX}`],
    ["odd length", PREIMAGE_HEX.slice(1)],
    ["wrong length", `${PREIMAGE_HEX}00`],
    ["non-hex", `${PREIMAGE_HEX.slice(0, -1)}g`],
  ])("rejects a malformed revealed preimage with %s", async (_name, revealed) => {
    const h = harness({ revealedPreimageHex: revealed });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-revealed-preimage-invalid",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("source-claim");
  });

  test("refunds both legs on a benign destination timeout, never before each expiry", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_200_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "refund-destination" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-timeout" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("source-refund");
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "refund-source" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-timeout" });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "refund-complete", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refunded", reason: "destination-timeout" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toContain("source-refund");
  });

  test("does not refund while a retained destination claim may still finalize", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-claim": "pending" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_200_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "claim-reconciler" })).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    h.actions["destination-claim"] = { state: "absent", authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({
      ...run.shared,
      owner: "claim-reconciler-after-absence",
      now: () => 1_200_101,
    })).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    const effects = h.prepareAction.mock.calls.map((call) => call[0].action);
    expect(effects).not.toContain("destination-refund");
    expect(effects).not.toContain("source-refund");
  });

  test("a live lease prevents a second worker from preparing an effect", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = harness();
    const original = h.adapter.prepareAction;
    h.adapter.prepareAction = vi.fn(async (...args) => {
      await gate;
      return original(...args);
    });
    const run = runner({ adapter: h.adapter });
    const first = advanceCrossChainHtlc(run.shared);
    await vi.waitFor(() => expect(h.adapter.prepareAction).toHaveBeenCalledTimes(1));
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "worker-b" })).resolves.toEqual({
      status: "waiting",
      reason: "htlc-settlement-held",
    });
    release();
    await expect(first).resolves.toMatchObject({ status: "waiting" });
    expect(h.adapter.prepareAction).toHaveBeenCalledTimes(1);
  });

  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid lease duration %s before durable or chain effects",
    async (leaseDurationMs) => {
      const base = createInMemoryCrossChainHtlcStore();
      const claim = vi.fn(base.claim);
      const h = harness();
      await expect(advanceCrossChainHtlc(runner({
        leaseDurationMs,
        store: { ...base, claim },
        adapter: h.adapter,
      }).shared)).resolves.toMatchObject({ status: "failed", errorClass: "permanent" });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareAction).not.toHaveBeenCalled();
    },
  );

  test("rejects malformed authenticated lock expiry before the next effect", async () => {
    const h = harness({ sourceExpiry: Number.NaN });
    const run = runner({ adapter: h.adapter });
    await expect(advanceCrossChainHtlc(run.shared)).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-source-lock-effect-uncertain",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock"]);
  });

  test("does not accept source-claim finality observed after the source deadline", async () => {
    const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100 });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    h.setObservedAt(1_600_000);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "failed",
      errorClass: "settlement-atomicity",
      reason: "dest-revealed-source-unclaimed-expired",
    });
  });

  test("does not classify mismatched refund evidence as refunded", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_200_000);
    await advanceCrossChainHtlc({ ...run.shared, owner: "refund-destination" });
    const refund = h.actions["destination-refund"];
    if (!refund || refund.state !== "final") throw new Error("expected final refund fixture");
    h.actions["destination-refund"] = {
      ...refund,
      txRef: { ...refund.txRef, contractAddress: "substituted-contract" },
    };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-ledger-observation-unavailable",
    });
  });

  test("captures the payer reveal decision before adapter callbacks can mutate it", async () => {
    let activeInput!: AdvanceCrossChainHtlcInput;
    const mutatingHashlocks = {
      deriveHashlock(args: { chainId: number; preimage: Uint8Array }) {
        activeInput.authorizeDestinationClaim = true;
        return hashlocks.deriveHashlock(args);
      },
    };
    const h = harness();
    const run = runner({
      adapter: h.adapter,
      hashlocks: mutatingHashlocks,
      authorizeDestinationClaim: false,
    });
    activeInput = run.shared;
    await advanceCrossChainHtlc(activeInput);
    activeInput = { ...run.nextOwner(), authorizeDestinationClaim: false };
    await advanceCrossChainHtlc(activeInput);
    activeInput = { ...run.nextOwner(), authorizeDestinationClaim: false };
    await expect(advanceCrossChainHtlc(activeInput)).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-not-authorized",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock"]);
  });
});

describe("source-finality checkpoint store contract", () => {
  test("rejects destination-lock persistence without the exact retained checkpoint", async () => {
    const { intent, secrets } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
    const store = createInMemoryCrossChainHtlcStore();
    const claimed = await store.claim({
      intent,
      secrets,
      owner: "checkpoint-owner",
      now: 1_000,
      leaseDurationMs: 100,
    });
    if (claimed.status !== "acquired") throw new Error("checkpoint fixture lease not acquired");
    const fence = {
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner: claimed.lease.owner,
      generation: claimed.lease.generation,
    };
    const sourceLock = preparedFor(intent, "source-lock");
    await expect(store.recordPrepared({ ...fence, prepared: sourceLock }))
      .resolves.toEqual({ status: "recorded" });
    const checkpoint = {
      sourceLockEffectHash: sourceLock.effectHash,
      sourceLockTxRef: sourceLock.txRef as Extract<HtlcTxRef, { kind: "htlc-lock" }>,
      includedAt: 1_000,
      sourceExpiry: 5_000,
      finalityObservedAt: 1_100,
      authenticationHash: AUTH_HASH,
    };
    await expect(store.recordPrepared({
      ...fence,
      prepared: preparedFor(intent, "destination-lock"),
    })).resolves.toEqual({
      status: "conflict",
      reason: "htlc-destination-lock-without-source-finality",
    });
    await expect(store.recordSourceFinality({ ...fence, checkpoint }))
      .resolves.toEqual({ status: "recorded" });
    await expect(store.recordPrepared({
      ...fence,
      prepared: preparedFor(intent, "destination-lock", "-wrong", "0".repeat(64)),
    })).resolves.toEqual({
      status: "conflict",
      reason: "htlc-destination-lock-without-source-finality",
    });
    const checkpointHash = crossChainHtlcSourceFinalityCheckpointHash(checkpoint);
    await expect(store.recordPrepared({
      ...fence,
      prepared: preparedFor(intent, "destination-lock", "", checkpointHash),
    })).resolves.toEqual({ status: "recorded" });
  });
});

describe("source-claim replacement store contract", () => {
  test("rejects stale, missing-checkpoint, wrong-prior, same-ref, non-source, pending, and expired replacements", async () => {
    const fixture = await sourceClaimStoreFixture();
    const valid = {
      settlementKey: fixture.intent.settlementKey,
      bindingHash: fixture.intent.bindingHash,
      owner: fixture.lease.owner,
      generation: fixture.lease.generation,
      now: 1_050,
      priorEffectHash: fixture.prior.effectHash,
      priorTxRef: fixture.prior.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
      failedObservation: fixture.failedObservation,
      replacement: fixture.replacement,
    };
    await expect(fixture.store.replacePreparedSourceClaim({
      ...valid,
      generation: valid.generation + 1,
    })).resolves.toEqual({ status: "stale", reason: "stale-lease" });
    await expect(fixture.store.replacePreparedSourceClaim({
      ...valid,
      priorEffectHash: "0".repeat(64),
    })).resolves.toEqual({
      status: "conflict",
      reason: "htlc-source-claim-replacement-prior-mismatch",
    });
    const { effectHash: _effectHash, ...replacementUnsigned } = fixture.replacement;
    const sameRefUnsigned = {
      ...replacementUnsigned,
      txRef: fixture.prior.txRef,
      signedPayloadBase64: Buffer.from("fresh-wire-same-ref", "utf8").toString("base64"),
    };
    const sameRefReplacement = {
      ...sameRefUnsigned,
      effectHash: sha256Hex(canonicalize(sameRefUnsigned)),
    };
    await expect(fixture.store.replacePreparedSourceClaim({
      ...valid,
      replacement: sameRefReplacement,
    })).resolves.toEqual({
      status: "conflict",
      reason: "htlc-source-claim-replacement-not-fresh",
    });
    await expect(fixture.store.replacePreparedSourceClaim({
      ...valid,
      replacement: preparedFor(fixture.intent, "source-lock", "-not-a-claim"),
    })).resolves.toEqual({
      status: "corrupt",
      reason: "htlc-source-claim-replacement-invalid",
    });
    await expect(fixture.store.replacePreparedSourceClaim({
      ...valid,
      failedObservation: {
        ...fixture.failedObservation,
        state: "pending",
      } as never,
    })).resolves.toEqual({
      status: "corrupt",
      reason: "htlc-source-claim-replacement-invalid",
    });

    const missingCheckpoint = await sourceClaimStoreFixture({ checkpoint: false });
    await expect(missingCheckpoint.store.replacePreparedSourceClaim({
      ...valid,
      settlementKey: missingCheckpoint.intent.settlementKey,
      bindingHash: missingCheckpoint.intent.bindingHash,
      owner: missingCheckpoint.lease.owner,
      generation: missingCheckpoint.lease.generation,
      priorEffectHash: missingCheckpoint.prior.effectHash,
      priorTxRef: missingCheckpoint.prior.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
      failedObservation: missingCheckpoint.failedObservation,
      replacement: missingCheckpoint.replacement,
    })).resolves.toEqual({
      status: "conflict",
      reason: "htlc-source-claim-replacement-without-reveal",
    });

    const expired = await sourceClaimStoreFixture({
      leaseDurationMs: 10_000,
      sourceExpiry: 2,
    });
    await expect(expired.store.replacePreparedSourceClaim({
      ...valid,
      settlementKey: expired.intent.settlementKey,
      bindingHash: expired.intent.bindingHash,
      owner: expired.lease.owner,
      generation: expired.lease.generation,
      now: 2_000,
      priorEffectHash: expired.prior.effectHash,
      priorTxRef: expired.prior.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
      failedObservation: expired.failedObservation,
      replacement: expired.replacement,
    })).resolves.toEqual({
      status: "conflict",
      reason: "htlc-source-claim-replacement-expired",
    });
  });

  test("retains the immutable attempt history and old reservations on takeover", async () => {
    const fixture = await sourceClaimStoreFixture();
    await expect(fixture.store.replacePreparedSourceClaim({
      settlementKey: fixture.intent.settlementKey,
      bindingHash: fixture.intent.bindingHash,
      owner: fixture.lease.owner,
      generation: fixture.lease.generation,
      now: 1_050,
      priorEffectHash: fixture.prior.effectHash,
      priorTxRef: fixture.prior.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
      failedObservation: fixture.failedObservation,
      replacement: fixture.replacement,
    })).resolves.toEqual({ status: "recorded" });
    const takeover = await fixture.store.claim({
      intent: fixture.intent,
      secrets: fixture.secrets,
      owner: "takeover-owner",
      now: 1_101,
      leaseDurationMs: 100,
    });
    expect(takeover).toMatchObject({
      status: "acquired",
      prepared: [{ effectHash: fixture.replacement.effectHash }],
      sourceClaimAttemptHistory: [{
        attempt: 1,
        prepared: { effectHash: fixture.prior.effectHash },
        failedObservation: { state: "failed", authenticationHash: AUTH_HASH },
        replacementEffectHash: fixture.replacement.effectHash,
      }],
    });

    const other = createCrossChainHtlcIntent(
      authority({ jobId: "reservation-probe" }),
      Uint8Array.from({ length: 16 }, () => 2),
      hashlocks,
    );
    const otherClaim = await fixture.store.claim({
      intent: other.intent,
      secrets: other.secrets,
      owner: "reservation-probe",
      now: 1_101,
      leaseDurationMs: 100,
    });
    if (otherClaim.status !== "acquired") throw new Error("reservation probe not acquired");
    await expect(fixture.store.recordPrepared({
      settlementKey: other.intent.settlementKey,
      bindingHash: other.intent.bindingHash,
      owner: otherClaim.lease.owner,
      generation: otherClaim.lease.generation,
      prepared: fixture.prior,
    })).resolves.toEqual({
      status: "conflict",
      reason: "htlc-effect-cross-settlement-reuse",
    });
    const { effectHash: _replacementEffect, ...freshUnsigned } = preparedFor(
      other.intent,
      "source-claim",
      "-fresh-effect",
    );
    const oldRefUnsigned = { ...freshUnsigned, txRef: fixture.prior.txRef };
    await expect(fixture.store.recordPrepared({
      settlementKey: other.intent.settlementKey,
      bindingHash: other.intent.bindingHash,
      owner: otherClaim.lease.owner,
      generation: otherClaim.lease.generation,
      prepared: {
        ...oldRefUnsigned,
        effectHash: sha256Hex(canonicalize(oldRefUnsigned)),
      },
    })).resolves.toEqual({
      status: "conflict",
      reason: "htlc-transaction-cross-settlement-reuse",
    });
  });

  test("fails corrupted retained history before observing or preparing effects", async () => {
    const base = createInMemoryCrossChainHtlcStore();
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter, store: base });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const prior = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .find((prepared) => prepared.action === "source-claim");
    if (!prior) throw new Error("expected source claim");
    h.actions["source-claim"] = {
      state: "failed",
      txRef: prior.txRef,
      authenticationHash: AUTH_HASH,
    };
    h.setMode("source-claim", "throw-once");
    await advanceCrossChainHtlc(run.nextOwner());
    const observeCalls = h.observe.mock.calls.length;
    const prepareCalls = h.prepareAction.mock.calls.length;
    const corruptStore: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        if (claimed.status !== "acquired") return claimed;
        return {
          ...claimed,
          sourceClaimAttemptHistory: claimed.sourceClaimAttemptHistory.map((entry) => ({
            ...entry,
            replacementEffectHash: "0".repeat(64),
          })),
        };
      },
    };
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store: corruptStore }))
      .resolves.toMatchObject({ status: "failed", errorClass: "permanent" });
    expect(h.observe).toHaveBeenCalledTimes(observeCalls);
    expect(h.prepareAction).toHaveBeenCalledTimes(prepareCalls);
  });
});
