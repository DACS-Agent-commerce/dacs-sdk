import { describe, expect, test, vi } from "vitest";

import {
  advanceCrossChainHtlc,
  createCrossChainHtlcIntent,
  createInMemoryCrossChainHtlcStore,
  deriveHtlcPreimage,
  generateHtlcBuyerSalt,
  type AdvanceCrossChainHtlcInput,
  type CrossChainHtlcAdapter,
  type CrossChainHtlcAuthority,
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

function refFor(action: HtlcAction): HtlcTxRef {
  const txHash = `tx-${action}`;
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
      txRef: refFor(request.action),
      signedPayloadBase64: Buffer.from(`wire-${request.action}`, "utf8").toString("base64"),
      preparedAt: observedAt,
    };
  });
  const broadcastRetained = vi.fn<CrossChainHtlcAdapter["broadcastRetained"]>(async (prepared, fence) => {
    await fence.assertCurrent();
    const mode = options.mode?.[prepared.action] ?? "final";
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

  test("rejects a destination lock included before source-lock finality", async () => {
    const h = harness({ sourceFinalityObservedAt: 1_000_100, destinationIncludedAt: 1_000_050 });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-destination-lock-precedes-source-finality",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("destination-claim");
  });

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
});
