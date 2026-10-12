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
  htlcNeedsOperator,
  type AdvanceCrossChainHtlcInput,
  type CrossChainHtlcAdapter,
  type CrossChainHtlcAuthority,
  type CrossChainHtlcIntent,
  type CrossChainHtlcProgress,
  type CrossChainHtlcSettlement,
  type CrossChainHtlcStore,
  type HtlcAction,
  type HtlcLedgerSnapshot,
  type HtlcLockTerms,
  type HtlcObservedAction,
  type HtlcPreparedAction,
  type HtlcStoreClaim,
  type HtlcTxRef,
} from "../../src/rails/crossChainHtlc.js";

const AGREEMENT_HASH = "a".repeat(64);
const RAIL_HASH = "b".repeat(64);
const AUTH_HASH = "c".repeat(64);
const SALT = Uint8Array.from({ length: 16 }, () => 1);
const JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7F";
const OTHER_JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7G";
const RESERVATION_JOB_ID = "01J8ME0SXKQ4T9V2RC5HJ6WX7H";
const PREIMAGE_HEX = Buffer.from(deriveHtlcPreimage({
  buyerSalt: SALT,
  jobId: JOB_ID,
  agreementHash: AGREEMENT_HASH,
})).toString("hex");

function authority(overrides: Partial<CrossChainHtlcAuthority> = {}): CrossChainHtlcAuthority {
  return {
    jobId: JOB_ID,
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
    sourceTokenId: "source-usdc-token",
    destinationTokenId: "destination-usdc-token",
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
  sourceClaimIncludedAt?: number;
  sourceClaimFinalityReachedAt?: number;
  sourceClaimFinalityObservedAt?: number;
  sourceLockTerms?: Partial<HtlcLockTerms>;
  omitSourceLockTerms?: boolean;
  destinationLockTerms?: Partial<HtlcLockTerms>;
  omitDestinationLockTerms?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const actions: Partial<Record<HtlcAction, HtlcObservedAction>> = {};
  const preimages = new Map<HtlcAction, string | undefined>();
  const throwConsumed = new Set<HtlcAction>();
  const modes = { ...options.mode };
  let observedAt = 1_000_000;
  let lastIntent: Readonly<CrossChainHtlcIntent> | undefined;
  const prepareAction = vi.fn<CrossChainHtlcAdapter["prepareAction"]>(async (request, fence) => {
    await fence.assertCurrent();
    lastIntent = request.intent;
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
    const finalityObservedAt = prepared.action === "source-lock"
      ? options.sourceFinalityObservedAt ?? observedAt
      : prepared.action === "source-claim"
        ? options.sourceClaimFinalityObservedAt ?? observedAt
        : observedAt;
    const includedAt = prepared.action === "source-lock"
      ? observedAt
      : prepared.action === "destination-lock"
        ? options.destinationIncludedAt ?? observedAt
        : prepared.action === "source-claim"
          ? options.sourceClaimIncludedAt
          : undefined;
    const commonFinal = {
      state: "final" as const,
      finalityObservedAt,
      includedAt,
      expiresAt: prepared.action === "source-lock"
        ? options.sourceExpiry ?? 5_000
        : prepared.action === "destination-lock"
          ? options.destinationExpiry ?? 1_500
          : undefined,
      revealedPreimageHex: prepared.action === "destination-claim"
        ? options.revealedPreimageHex ?? preimages.get(prepared.action)
        : undefined,
      ...(prepared.action === "source-lock" && lastIntent && !options.omitSourceLockTerms
        ? {
          lockTerms: {
            token: lastIntent.sourceTokenId,
            amountBaseUnits: lastIntent.sourceAmountBaseUnits,
            hashlock: lastIntent.sourceHashlock,
            sender: lastIntent.payerSourceAddress,
            recipient: lastIntent.payeeSourceAddress,
            ...options.sourceLockTerms,
          },
        }
        : {}),
      ...(prepared.action === "destination-lock" && lastIntent && !options.omitDestinationLockTerms
        ? {
          lockTerms: {
            token: lastIntent.destinationTokenId,
            amountBaseUnits: lastIntent.destinationAmountBaseUnits,
            hashlock: lastIntent.destinationHashlock,
            sender: lastIntent.payeeDestinationAddress,
            recipient: lastIntent.payerDestinationAddress,
            ...options.destinationLockTerms,
          },
        }
        : {}),
      authenticationHash: AUTH_HASH,
    };
    if (prepared.action === "source-claim") {
      if (prepared.txRef.kind !== "htlc-claim") throw new Error("invalid source-claim ref");
      actions[prepared.action] = {
        ...commonFinal,
        txRef: prepared.txRef,
        finalityReachedAt: options.sourceClaimFinalityReachedAt ?? observedAt,
      };
    } else {
      if (prepared.txRef.kind === "htlc-claim") throw new Error("claim ref on non-claim action");
      actions[prepared.action] = { ...commonFinal, txRef: prepared.txRef };
    }
  });
  const observe = vi.fn<CrossChainHtlcAdapter["observe"]>(async (_intent, fence) => {
    await fence.assertCurrent();
    return {
      observedAt,
      authenticationHash: AUTH_HASH,
      actions: { ...actions },
    } satisfies HtlcLedgerSnapshot;
  });
  const observeSourceLeg = vi.fn<CrossChainHtlcAdapter["observeSourceLeg"]>(async (_intent, fence) => {
    await fence.assertCurrent();
    return {
      observedAt,
      authenticationHash: AUTH_HASH,
      actions: Object.fromEntries(Object.entries(actions).filter(([action]) => action.startsWith("source-"))),
    } satisfies HtlcLedgerSnapshot;
  });
  return {
    adapter: { observe, observeSourceLeg, prepareAction, broadcastRetained } satisfies CrossChainHtlcAdapter,
    actions,
    preimages,
    prepareAction,
    broadcastRetained,
    observe,
    observeSourceLeg,
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
          ...(action === "source-claim" ? { finalityReachedAt: observedAt } : {}),
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
    store: createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true }),
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

/** The promise's value, or "no result" if it has not settled within `ms` real milliseconds. */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<T | "no result"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<"no result">((resolve) => { timer = setTimeout(() => resolve("no result"), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function sourceClaimStoreFixture(options: {
  checkpoint?: boolean;
  leaseDurationMs?: number;
  sourceExpiry?: number;
} = {}) {
  const { intent, secrets } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
  const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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
      jobId: JOB_ID,
      agreementHash: AGREEMENT_HASH,
    })).toString("hex")).toBe(
      "436862ce4c59949393192d25592fa09197d439760bfdea3509697dda4863282e",
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
      jobId: JOB_ID,
      agreementHash: AGREEMENT_HASH,
    })).toString("hex");
    expect(intent).toMatchObject({
      jobId: JOB_ID,
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
    ["source token id", { sourceTokenId: "" }],
    ["destination token id", { destinationTokenId: undefined }],
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
    expect(crossChainHtlcSettlementKey({ jobId: JOB_ID, railId: "c", phaseIndex: 1 }))
      .not.toBe(crossChainHtlcSettlementKey({
        jobId: OTHER_JOB_ID,
        railId: "b:c",
        phaseIndex: 1,
      }));
  });

  test.each([
    ["lowercase", JOB_ID.toLowerCase()],
    ["leading whitespace", ` ${JOB_ID}`],
    ["trailing whitespace", `${JOB_ID} `],
    ["Unicode normalization alias", JOB_ID.replace("K", "\u212a")],
    ["wrong length", JOB_ID.slice(0, -1)],
    ["non-ULID alphabet", JOB_ID.replace("K", "I")],
  ])("rejects a %s jobId before derivation or effects", async (_name, jobId) => {
    expect(() => deriveHtlcPreimage({
      buyerSalt: SALT,
      jobId,
      agreementHash: AGREEMENT_HASH,
    })).toThrow("jobId must be a canonical uppercase ULID");
    expect(() => crossChainHtlcSettlementKey({
      jobId,
      railId: "htlc-route-1",
      phaseIndex: 2,
    })).toThrow("jobId must be a canonical uppercase ULID");

    const deriveHashlock = vi.fn(hashlocks.deriveHashlock);
    const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const claim = vi.spyOn(store, "claim");
    const h = harness();
    const result = await advanceCrossChainHtlc(runner({
      authority: authority({ jobId }),
      hashlocks: { deriveHashlock },
      store,
      adapter: h.adapter,
    }).shared);

    expect(result).toMatchObject({
      status: "failed",
      errorClass: "permanent",
      reason: "jobId must be a canonical uppercase ULID",
    });
    expect(deriveHashlock).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.prepareAction).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
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

  test.each(["sourceTokenId", "destinationTokenId"] as const)(
    "binds %s, not only the currency symbol, into the canonical intent",
    (field) => {
      const baseline = createCrossChainHtlcIntent(authority(), SALT, hashlocks).intent;
      const changed = createCrossChainHtlcIntent(
        authority({ [field]: "other-usdc-token" }),
        SALT,
        hashlocks,
      ).intent;
      expect(baseline[field]).toBe(authority()[field]);
      expect(changed[field]).toBe("other-usdc-token");
      expect(changed.bindingHash).not.toBe(baseline.bindingHash);
    },
  );

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
        settlementFinality: { model: "htlc-reveal", sourceExpiry: 5_000 },
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

  test("stops on a retained source lock reported absent by reference, and rebroadcasts one reported absent without", async () => {
    const h = harness({ mode: { "source-lock": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    const [lock] = h.broadcastRetained.mock.calls.map((call) => call[0]);
    if (!lock) throw new Error("expected a source lock");
    // Nothing on chain yet, e.g. after a failed send: the same bytes go out again.
    h.actions["source-lock"] = { state: "absent", authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-source-lock-finality-pending",
    });
    expect(h.broadcastRetained.mock.calls.map((call) => call[0])).toEqual([lock, lock]);
    // The lock can never land, so nothing was locked and nothing is left to drive.
    h.actions["source-lock"] = { state: "absent", txRef: lock.txRef, authenticationHash: AUTH_HASH };
    for (let call = 0; call < 2; call += 1) {
      const progress = await advanceCrossChainHtlc(run.nextOwner());
      expect(progress).toEqual({ status: "failed", errorClass: "permanent", reason: "htlc-source-lock-absent" });
      expect(htlcNeedsOperator(progress)).toBe(true);
    }
    expect(h.broadcastRetained).toHaveBeenCalledTimes(2);
    expect(h.prepareAction).toHaveBeenCalledTimes(1);
  });

  test("rejects cross-session buyer-salt reuse in the durable store without ending either session", async () => {
    const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const first = runner({ store, adapter: harness({ mode: { "source-lock": "pending" } }).adapter });
    await advanceCrossChainHtlc(first.shared);
    first.setClock(2_000_000);
    const secondAdapter = harness();
    const second = runner({
      authority: authority({ jobId: OTHER_JOB_ID }),
      store,
      adapter: secondAdapter.adapter,
      now: () => 2_000_000,
    });
    // The salt is the first session's, which still needs it: a page, never `failed`.
    await expect(advanceCrossChainHtlc(second.shared)).resolves.toEqual({
      status: "operator-alert",
      reason: "htlc-salt-mismatch",
      txRefs: [],
    });
    expect(secondAdapter.prepareAction).not.toHaveBeenCalled();
    await expect(advanceCrossChainHtlc({ ...first.shared, owner: "first-session" })).resolves.toEqual({
      status: "waiting",
      reason: "htlc-source-lock-finality-pending",
    });
  });

  test("still fails a claim the store reports corrupt", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const store: CrossChainHtlcStore = {
      ...base,
      async claim() { return { status: "corrupt", reason: "htlc-store-record-unreadable" }; },
    };
    const h = harness();
    await expect(advanceCrossChainHtlc(runner({ store, adapter: h.adapter }).shared)).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-store-record-unreadable",
    });
    expect(h.prepareAction).not.toHaveBeenCalled();
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

  test("rechecks actual absolute expiries before revealing and refunds both legs instead", async () => {
    const h = harness({ sourceExpiry: 1_600, destinationExpiry: 1_580 });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-expiry-margin-insufficient",
      txRefs: [refFor("source-lock"), refFor("destination-lock")],
      refunds: { "destination-refund": "waiting", "source-refund": "waiting" },
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock"]);
    run.setClock(1_580_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "margin-destination-refund" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-expiry-margin-insufficient" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("source-refund");
    run.setClock(1_600_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "margin-source-refund" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-expiry-margin-insufficient" });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "margin-refunded", now: () => 1_600_101 }))
      .resolves.toMatchObject({ status: "refunded", reason: "destination-expiry-margin-insufficient" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual([
      "source-lock",
      "destination-lock",
      "destination-refund",
      "source-refund",
    ]);
  });

  test("refunds the payer's source leg at source expiry when the destination lock outlives it", async () => {
    const h = harness({ sourceExpiry: 1_600, destinationExpiry: 1_700 });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner()))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-expiry-margin-insufficient" });
    run.setClock(1_599_800);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "before-source-expiry" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-expiry-margin-insufficient" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock"]);
    run.setClock(1_600_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-expired" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-expiry-margin-insufficient" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "source-refund"]);
    run.setClock(1_700_000);
    await advanceCrossChainHtlc({ ...run.shared, owner: "destination-expired" });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "both-refunded", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refunded", reason: "destination-expiry-margin-insufficient" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .not.toContain("destination-claim");
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
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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

  test("accepts fresh source-finality evidence metadata without replacing the checkpoint", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const recordSourceFinality = vi.fn(base.recordSourceFinality.bind(base));
    const store: CrossChainHtlcStore = { ...base, recordSourceFinality };
    const h = harness();
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    const sourceLock = h.actions["source-lock"];
    if (!sourceLock || sourceLock.state !== "final") throw new Error("source lock not final");
    h.actions["source-lock"] = {
      ...sourceLock,
      finalityObservedAt: sourceLock.finalityObservedAt + 1,
      authenticationHash: "d".repeat(64),
    };

    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    expect(recordSourceFinality).toHaveBeenCalledTimes(1);
    expect(recordSourceFinality.mock.calls[0]![0].checkpoint).toMatchObject({
      finalityObservedAt: sourceLock.finalityObservedAt,
      authenticationHash: AUTH_HASH,
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toContain("destination-claim");
  });

  test.each(["inclusion", "expiry"] as const)(
    "fails closed when a final source-lock changes its stable %s fact",
    async (changedFact) => {
      const h = harness();
      const run = runner({ adapter: h.adapter });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      const sourceLock = h.actions["source-lock"];
      if (!sourceLock || sourceLock.state !== "final" || sourceLock.includedAt === undefined ||
          sourceLock.expiresAt === undefined) {
        throw new Error("source lock not final");
      }
      h.actions["source-lock"] = changedFact === "inclusion"
        ? {
          ...sourceLock,
          includedAt: sourceLock.includedAt + 1,
          finalityObservedAt: sourceLock.finalityObservedAt + 1,
        }
        : { ...sourceLock, expiresAt: sourceLock.expiresAt + 1 };
      const preparations = h.prepareAction.mock.calls.length;

      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "failed",
        errorClass: "permanent",
        reason: "htlc-source-finality-checkpoint-conflict",
      });
      expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    },
  );

  test("does not prepare a destination lock when source-finality persistence fails", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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
    const h = harness({
      destinationExpiry: 4_900,
      mode: { "destination-lock": "throw-once" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-destination-lock-effect-uncertain",
    });
    h.setObservedAt(4_871_000);
    run.setClock(4_871_000);
    h.setMode("destination-lock", "final");
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-lock-finality-pending",
    });
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
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

  test("keeps waiting for a retained pending destination lock after the preparation window", async () => {
    const h = harness({ mode: { "destination-lock": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-lock-finality-pending",
    });
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    h.setObservedAt(4_871_000);
    run.setClock(4_871_000);

    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-lock-finality-pending",
    });
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
  });

  test("rejects a new destination lock after the preparation window and refunds the source", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    let interruptCheckpoint = true;
    const store: CrossChainHtlcStore = {
      ...base,
      async recordSourceFinality(input) {
        const recorded = await base.recordSourceFinality(input);
        if (interruptCheckpoint) {
          interruptCheckpoint = false;
          return { status: "stale", reason: "injected-checkpoint-result-ambiguity" };
        }
        return recorded;
      },
    };
    const h = harness();
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-source-finality-persistence-uncertain",
    });
    h.setObservedAt(4_871_000);
    run.setClock(4_871_000);

    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-lock-window-closed",
      txRefs: [refFor("source-lock")],
      refunds: { "source-refund": "waiting" },
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock"]);
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock"]);
    run.setClock(5_000_000);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "refund-pending",
      reason: "destination-lock-missing",
    });
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "refunded",
      reason: "destination-lock-missing",
      txRefs: [refFor("source-lock"), refFor("source-refund")],
      refunds: { "source-refund": "final" },
    });
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "source-refund"]);
  });

  test("keeps a failed destination lock refund-pending until the source refund lands", async () => {
    const h = harness({ sourceExpiry: 1_700, mode: { "destination-lock": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    const pending = h.actions["destination-lock"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending destination lock");
    h.actions["destination-lock"] = {
      state: "failed",
      txRef: pending.txRef,
      reason: "lock-reverted",
      authenticationHash: AUTH_HASH,
    };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-lock-failed",
      txRefs: [refFor("source-lock"), refFor("destination-lock")],
      refunds: { "source-refund": "waiting" },
    });
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "failed-lock-source-refund" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-lock-failed" });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "failed-lock-refunded", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refunded", reason: "destination-lock-failed" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "source-refund"]);
  });

  test.each(["pending", "retained but unreported"] as const)(
    "never reports refunded while a %s destination lock may still land",
    async (variant) => {
      const h = harness({
        sourceExpiry: 1_700,
        destinationExpiry: 1_800,
        mode: { "destination-lock": variant === "pending" ? "pending" : "throw-once" },
      });
      const run = runner({ adapter: h.adapter });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      expect(h.actions["destination-lock"]?.state)
        .toBe(variant === "pending" ? "pending" : undefined);
      run.setClock(1_700_000);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-refund-sent" })).resolves.toEqual({
        status: "refund-pending",
        reason: "destination-lock-unresolved",
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
        refunds: { "destination-refund": "waiting", "source-refund": "final" },
      });
      for (const tick of [1, 2]) {
        await expect(advanceCrossChainHtlc({
          ...run.shared,
          owner: `lock-unresolved-${tick}`,
          now: () => 1_700_000 + tick * 101,
        })).resolves.toEqual({
          status: "refund-pending",
          reason: "destination-lock-unresolved",
          txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
          refunds: { "destination-refund": "waiting", "source-refund": "final" },
        });
      }
      // The payee's destination lock lands late, after the source refund.
      const { intent } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
      h.setObservedAt(1_700_400);
      await h.markFinal("destination-lock", {
        includedAt: 1_700_300,
        expiresAt: 1_800,
        lockTerms: {
          token: intent.destinationTokenId,
          amountBaseUnits: intent.destinationAmountBaseUnits,
          hashlock: intent.destinationHashlock,
          sender: intent.payeeDestinationAddress,
          recipient: intent.payerDestinationAddress,
        },
      });
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "lock-landed", now: () => 1_700_500 }))
        .resolves.toMatchObject({
          status: "refund-pending",
          refunds: { "destination-refund": "waiting", "source-refund": "final" },
        });
      await advanceCrossChainHtlc({ ...run.shared, owner: "destination-refund", now: () => 1_800_000 });
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "both-refunded", now: () => 1_800_101 }))
        .resolves.toMatchObject({
          status: "refunded",
          refunds: { "destination-refund": "final", "source-refund": "final" },
        });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "source-refund", "destination-refund"]);
    },
  );

  test("stops owing a retained destination lock once it is authenticated absent", async () => {
    const h = harness({ sourceExpiry: 1_700, mode: { "destination-lock": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    // The adapter authenticates that the retained lock can no longer land.
    h.actions["destination-lock"] = { state: "absent", authenticationHash: AUTH_HASH };
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "absent-lock-source-refund" })).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-lock-missing",
      txRefs: [refFor("source-lock"), refFor("source-refund")],
      refunds: { "source-refund": "final" },
    });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "absent-lock-refunded", now: () => 1_700_101 }))
      .resolves.toEqual({
        status: "refunded",
        reason: "destination-lock-missing",
        txRefs: [refFor("source-lock"), refFor("source-refund")],
        refunds: { "source-refund": "final" },
      });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "source-refund"]);
  });

  test("keeps a pending destination lock owed past both expiries and refunds it once it lands", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-lock": "pending" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_700_000);
    await advanceCrossChainHtlc({ ...run.shared, owner: "source-refund-sent" });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "lock-still-pending", now: () => 1_700_101 }))
      .resolves.toEqual({
        status: "refund-pending",
        reason: "destination-lock-unresolved",
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
        refunds: { "destination-refund": "waiting", "source-refund": "final" },
      });
    const { intent } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
    await h.markFinal("destination-lock", {
      includedAt: 1_050_000,
      expiresAt: 1_200,
      finalityObservedAt: 1_100_000,
      lockTerms: {
        token: intent.destinationTokenId,
        amountBaseUnits: intent.destinationAmountBaseUnits,
        hashlock: intent.destinationHashlock,
        sender: intent.payeeDestinationAddress,
        recipient: intent.payerDestinationAddress,
      },
    });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "lock-landed", now: () => 1_700_202 }))
      .resolves.toMatchObject({
        status: "refund-pending",
        reason: "destination-timeout",
        refunds: { "destination-refund": "final", "source-refund": "final" },
      });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "both-refunded", now: () => 1_700_303 }))
      .resolves.toMatchObject({ status: "refunded", reason: "destination-timeout" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "source-refund", "destination-refund"]);
  });

  test("fails closed before effects when a runtime store lacks the reveal replacement contract", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const { replacePreparedDestinationClaim: _unsupported, ...legacyStore } = base;
    const h = harness();
    await expect(advanceCrossChainHtlc(runner({
      adapter: h.adapter,
      store: legacyStore as CrossChainHtlcStore,
    }).shared)).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-destination-claim-replacement-store-unsupported",
    });
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.prepareAction).not.toHaveBeenCalled();
  });

  test("fails closed before effects when a runtime store lacks the checkpoint contract", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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
      const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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
    // The payee's source claim missed the source expiry. Refunding the source
    // would give the payer both legs, so a person must act, on every call.
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    for (const tick of [0, 1, 2]) {
      await expect(advanceCrossChainHtlc({
        ...run.shared,
        owner: `after-expiry-${tick}`,
        now: () => 5_000_000 + tick * 101,
      })).resolves.toEqual({
        status: "operator-alert",
        reason: "htlc-source-claim-missed-after-reveal",
        txRefs: [
          refFor("source-lock"),
          refFor("destination-lock"),
          refFor("destination-claim"),
          refFor("source-claim"),
        ],
      });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("source-refund");
  });

  test("returns to normal progress when a source claim pending at expiry reaches finality in time", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(5_000_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "claim-pending-at-expiry" }))
      .resolves.toMatchObject({ status: "operator-alert", reason: "htlc-source-claim-missed-after-reveal" });
    h.setObservedAt(5_000_100);
    await h.markFinal("source-claim", { finalityReachedAt: 4_999_000 });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "claim-final", now: () => 5_000_101 }))
      .resolves.toMatchObject({ status: "settled" });
  });

  test("accepts fresh reveal evidence metadata without replacing the checkpoint", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const recordRevealFinal = vi.fn(base.recordRevealFinal.bind(base));
    const store: CrossChainHtlcStore = { ...base, recordRevealFinal };
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const destinationClaim = h.actions["destination-claim"];
    if (!destinationClaim || destinationClaim.state !== "final") {
      throw new Error("destination claim not final");
    }
    h.actions["destination-claim"] = {
      ...destinationClaim,
      finalityObservedAt: destinationClaim.finalityObservedAt + 1,
      authenticationHash: "d".repeat(64),
    };

    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      reason: "dest-revealed-source-unclaimed",
    });
    expect(recordRevealFinal).toHaveBeenCalledTimes(1);
    expect(recordRevealFinal.mock.calls[0]![0].checkpoint).toMatchObject({
      finalityObservedAt: destinationClaim.finalityObservedAt,
      authenticationHash: AUTH_HASH,
    });
  });

  test("fails closed when a final reveal changes its retained transaction", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const destinationClaim = h.actions["destination-claim"];
    if (!destinationClaim || destinationClaim.state !== "final" ||
        destinationClaim.txRef.kind !== "htlc-reveal") {
      throw new Error("destination claim not final");
    }
    h.actions["destination-claim"] = {
      ...destinationClaim,
      txRef: { ...destinationClaim.txRef, revealTxHash: "tx-destination-claim-other" },
    };
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;

    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-ledger-observation-unavailable",
    });
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
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
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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
      status: "operator-alert",
      reason: "htlc-source-claim-missed-after-reveal",
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim")],
    });
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .not.toContain("source-claim");
  });

  test("does not broadcast a replacement when expiry arrives after its CAS", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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
      status: "operator-alert",
      reason: "htlc-source-claim-missed-after-reveal",
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim")],
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
    const replacePreparedSourceClaim = vi.spyOn(run.shared.store, "replacePreparedSourceClaim");
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
    expect(replacePreparedSourceClaim).toHaveBeenCalledTimes(1);
  });

  test.each(["historical pending", "unknown failed"] as const)(
    "rejects a %s source-claim observation after durable replacement",
    async (observation) => {
      const h = harness({ mode: { "source-claim": "pending" } });
      const run = runner({ adapter: h.adapter });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      await advanceCrossChainHtlc(run.nextOwner());
      await advanceCrossChainHtlc(run.nextOwner());
      const prior = h.broadcastRetained.mock.calls
        .map((call) => call[0])
        .find((prepared) => prepared.action === "source-claim");
      if (!prior || prior.txRef.kind !== "htlc-claim") throw new Error("expected source claim");
      h.actions["source-claim"] = {
        state: "failed",
        txRef: prior.txRef,
        authenticationHash: AUTH_HASH,
      };
      h.setMode("source-claim", "throw-once");
      await advanceCrossChainHtlc(run.nextOwner());

      if (observation === "historical pending") {
        h.actions["source-claim"] = {
          state: "pending",
          txRef: prior.txRef,
          authenticationHash: AUTH_HASH,
        };
      } else {
        h.actions["source-claim"] = {
          state: "failed",
          txRef: { ...prior.txRef, claimTxHash: "tx-source-claim-unknown" },
          authenticationHash: AUTH_HASH,
        };
      }
      const preparations = h.prepareAction.mock.calls.length;
      const broadcasts = h.broadcastRetained.mock.calls.length;

      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-ledger-observation-unavailable",
      });
      expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    },
  );

  test("settles on a replaced source-claim attempt that landed after all", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const prior = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .find((prepared) => prepared.action === "source-claim");
    if (!prior || prior.txRef.kind !== "htlc-claim") throw new Error("expected source claim");
    h.actions["source-claim"] = { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH };
    h.setMode("source-claim", "throw-once");
    await advanceCrossChainHtlc(run.nextOwner());
    // Every attempt carries the same preimage, so the earlier claim landing
    // pays the payee: the adapter reports it, and the session settles on it.
    h.actions["source-claim"] = {
      state: "final",
      txRef: prior.txRef,
      finalityReachedAt: 1_000_000,
      finalityObservedAt: 1_000_000,
      authenticationHash: AUTH_HASH,
    };
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "settled",
      settlement: {
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")],
      },
    });
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
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
        status: "operator-alert",
        reason: "htlc-source-claim-missed-after-reveal",
        txRefs: [
          refFor("source-lock"),
          refFor("destination-lock"),
          refFor("destination-claim"),
          refFor("source-claim"),
        ],
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
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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

  test("does not refund while a retained destination claim may still finalize, and alerts once it is absent", async () => {
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
      reason: "htlc-destination-claim-unresolved-after-cutoff",
    });
    // The broadcast reveal can no longer land, but the preimage was broadcast
    // and the payee may still claim the source: a person must act.
    h.actions["destination-claim"] = { state: "absent", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({
      ...run.shared,
      owner: "claim-reconciler-after-absence",
      now: () => 1_200_101,
    })).resolves.toEqual({
      status: "operator-alert",
      reason: "htlc-destination-claim-absent-preimage-broadcast",
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim")],
    });
    const effects = h.prepareAction.mock.calls.map((call) => call[0].action);
    expect(effects).not.toContain("destination-refund");
    expect(effects).not.toContain("source-refund");
  });

  test("refunds both legs once a retained destination claim is authenticated absent after source expiry", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-claim": "pending" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "still-pending" })).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-unresolved-after-expiry",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("source-refund");
    h.actions["destination-claim"] = { state: "absent", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "claim-unlanded", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-claim-unlanded" });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "claim-unlanded-done", now: () => 1_700_202 }))
      .resolves.toMatchObject({ status: "refunded", reason: "destination-claim-unlanded" });
    // The payer's own refund goes first when both are due in one call.
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action)).toEqual([
      "source-lock",
      "destination-lock",
      "destination-claim",
      "source-refund",
      "destination-refund",
    ]);
  });

  test("never treats an unreported retained destination claim as unlanded", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-claim": "pending" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    delete h.actions["destination-claim"];
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "claim-unreported" })).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-unresolved-after-expiry",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-claim"]);
    h.actions["destination-claim"] = { state: "absent", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "claim-absent", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-claim-unlanded" });
  });

  test.each(["deleted", "pending", "absent"] as const)(
    "never refunds after a reveal when the destination-lock observation is %s",
    async (variant) => {
      const h = harness({
        sourceExpiry: 1_700,
        destinationExpiry: 1_200,
        mode: { "destination-claim": "pending" },
      });
      const run = runner({ adapter: h.adapter });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      await advanceCrossChainHtlc(run.nextOwner());
      const lock = h.actions["destination-lock"];
      if (!lock || lock.state !== "final") throw new Error("expected final destination lock");
      if (variant === "deleted") delete h.actions["destination-lock"];
      else if (variant === "pending") {
        h.actions["destination-lock"] = { state: "pending", txRef: lock.txRef, authenticationHash: AUTH_HASH };
      } else h.actions["destination-lock"] = { state: "absent", authenticationHash: AUTH_HASH };
      const preparations = h.prepareAction.mock.calls.length;
      const broadcasts = h.broadcastRetained.mock.calls.length;
      for (const tick of [0, 1]) {
        await expect(advanceCrossChainHtlc({
          ...run.shared,
          owner: `regressed-${variant}-${tick}`,
          now: () => 1_700_000 + tick * 101,
        })).resolves.toEqual({
          status: "indeterminate",
          reason: "htlc-destination-lock-finality-regressed",
        });
      }
      expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
      expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("source-refund");
      expect(h.actions["destination-claim"]).toMatchObject({ state: "pending" });
    },
  );

  // A contract that deletes its lock record on claim makes the destination
  // lock stop reading final exactly when the payer's reveal lands.
  async function toFinalRevealWithRegressedLock(
    variant: "deleted" | "pending" | "absent",
    options: HarnessOptions = {},
  ) {
    const h = harness({
      sourceExpiry: 5_000,
      destinationExpiry: 1_500,
      ...options,
      mode: { "destination-claim": "pending", ...options.mode },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const reveal = h.actions["destination-claim"];
    const lock = h.actions["destination-lock"];
    if (!reveal || reveal.state !== "pending" || reveal.txRef.kind !== "htlc-reveal") {
      throw new Error("expected pending reveal");
    }
    if (!lock || lock.state !== "final") throw new Error("expected final destination lock");
    h.actions["destination-claim"] = {
      state: "final",
      txRef: reveal.txRef,
      finalityObservedAt: 1_000_500,
      revealedPreimageHex: PREIMAGE_HEX,
      authenticationHash: AUTH_HASH,
    };
    if (variant === "deleted") delete h.actions["destination-lock"];
    else if (variant === "pending") {
      h.actions["destination-lock"] = { state: "pending", txRef: lock.txRef, authenticationHash: AUTH_HASH };
    } else h.actions["destination-lock"] = { state: "absent", authenticationHash: AUTH_HASH };
    return { h, run };
  }

  test.each(["deleted", "pending", "absent"] as const)(
    "rejects a final reveal of another preimage whose destination lock is now %s, recording nothing",
    async (variant) => {
      const { h, run } = await toFinalRevealWithRegressedLock(variant);
      const reveal = h.actions["destination-claim"];
      if (!reveal || reveal.state !== "final" || reveal.txRef.kind !== "htlc-reveal") {
        throw new Error("expected final reveal");
      }
      h.actions["destination-claim"] = {
        state: "final", txRef: reveal.txRef, finalityObservedAt: 1_000_500,
        revealedPreimageHex: "00".repeat(32), authenticationHash: AUTH_HASH,
      };
      const broadcasts = h.broadcastRetained.mock.calls.length;
      const r = await advanceCrossChainHtlc(run.nextOwner());
      expect(r).toEqual({ status: "failed", errorClass: "permanent", reason: "htlc-revealed-preimage-mismatch" });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "destination-claim"]);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
      const created = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
      const stored = await (run.shared.store as CrossChainHtlcStore).claim({ ...created, owner: "auditor", now: 9_000_000, leaseDurationMs: 1 });
      expect(stored).toMatchObject({ status: "acquired" });
      if (stored.status !== "acquired") throw new Error("expected acquired session");
      expect(stored.revealCheckpoint).toBeUndefined();
    },
  );

  // A wrong or missing salt is a host error, not the end of the session: the
  // original salt still settles it below. `failed` would tell a host following
  // the checklist that the salt can be discarded, so these page instead.
  test.each([
    ["missing", undefined as unknown as Uint8Array, "htlc-salt-missing"],
    ["too short", Uint8Array.from(SALT.subarray(1)), "htlc-salt-missing"],
    ["different", Uint8Array.from(SALT, (byte) => byte + 1), "htlc-salt-mismatch"],
  ] as const)(
    "pages without ending the session when the buyer salt after a final reveal is %s",
    async (_variant, buyerSalt, reason) => {
      const { h, run } = await toFinalRevealWithRegressedLock("deleted");
      const preparations = h.prepareAction.mock.calls.length;
      const broadcasts = h.broadcastRetained.mock.calls.length;
      const progress = await advanceCrossChainHtlc({ ...run.nextOwner(), buyerSalt });
      expect(progress).toEqual({ status: "operator-alert", reason, txRefs: [] });
      expect(htlcNeedsOperator(progress)).toBe(true);
      expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
        status: "settled",
        settlement: { settlementFinality: { sourceExpiry: 5_000 } },
      });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "destination-claim", "source-claim"]);
      expect(h.preimages.get("source-claim")).toBe(PREIMAGE_HEX);
    },
  );

  test("rejects a reveal checkpoint whose source expiry conflicts with the source-finality checkpoint", async () => {
    const { h, run } = await toFinalRevealWithRegressedLock("deleted");
    const base = run.shared.store;
    const recordRevealFinal = vi.fn(base.recordRevealFinal.bind(base));
    const store: CrossChainHtlcStore = {
      ...base,
      recordRevealFinal,
      async claim(input) {
        const claimed = await base.claim(input);
        if (claimed.status !== "acquired" || !claimed.sourceFinalityCheckpoint) {
          throw new Error("expected source-finality checkpoint");
        }
        const reveal = claimed.prepared.find((action) => action.action === "destination-claim");
        if (!reveal || reveal.txRef.kind !== "htlc-reveal") throw new Error("expected retained reveal");
        return {
          ...claimed,
          revealCheckpoint: {
            revealTxRef: reveal.txRef,
            sourceExpiry: claimed.sourceFinalityCheckpoint.sourceExpiry + 1,
            finalityObservedAt: 1_000_500,
            authenticationHash: AUTH_HASH,
          },
        };
      },
    };
    const broadcasts = h.broadcastRetained.mock.calls.length;
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store })).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-reveal-checkpoint-conflict",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-claim"]);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    expect(recordRevealFinal).not.toHaveBeenCalled();
  });

  test("fails closed with a result on a retained reveal checkpoint whose source expiry overflows", async () => {
    const { h, run } = await toFinalRevealWithRegressedLock("deleted");
    // With the reveal unreported, the checkpoint's expiry is what the core reads.
    delete h.actions["destination-claim"];
    const base = run.shared.store;
    const store: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        if (claimed.status !== "acquired") throw new Error("expected acquired session");
        const reveal = claimed.prepared.find((action) => action.action === "destination-claim");
        if (!reveal || reveal.txRef.kind !== "htlc-reveal") throw new Error("expected retained reveal");
        return {
          ...claimed,
          revealCheckpoint: {
            revealTxRef: reveal.txRef,
            sourceExpiry: 10_000_000_000_000,
            finalityObservedAt: 1_000_500,
            authenticationHash: AUTH_HASH,
          },
        };
      },
    };
    const observations = h.observe.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store })).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "pay-cross-chain-htlc: retained reveal sourceExpiry exceeds the safe-integer range",
    });
    // Rejected with the other retained records, before the ledger is observed.
    expect(h.observe).toHaveBeenCalledTimes(observations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
  });

  test.each(["deleted", "pending", "absent"] as const)(
    "drives the source claim to settlement after a final reveal whose destination lock is now %s",
    async (variant) => {
      const { h, run } = await toFinalRevealWithRegressedLock(variant);
      const settled = {
        status: "settled",
        settlement: {
          txRefs: [
            refFor("source-lock"),
            refFor("destination-lock"),
            refFor("destination-claim"),
            refFor("source-claim"),
          ],
          settlementFinality: { model: "htlc-reveal", sourceExpiry: 5_000 },
        },
      };
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject(settled);
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject(settled);
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "destination-claim", "source-claim"]);
      expect(h.prepareAction.mock.calls[3]![0].sourceExpiry).toBe(5_000);
    },
  );

  test("alerts when the source claim misses the expiry after a final reveal whose destination lock regressed", async () => {
    const { h, run } = await toFinalRevealWithRegressedLock("deleted", { mode: { "source-claim": "pending" } });
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      reason: "dest-revealed-source-unclaimed",
      recoveryDeadline: 5_000,
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")],
    });
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    for (const tick of [0, 1]) {
      await expect(advanceCrossChainHtlc({
        ...run.shared,
        owner: `claim-missed-${tick}`,
        now: () => 5_000_000 + tick * 101,
      })).resolves.toEqual({
        status: "operator-alert",
        reason: "htlc-source-claim-missed-after-reveal",
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")],
      });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    const effects = h.prepareAction.mock.calls.map((call) => call[0].action);
    expect(effects).not.toContain("source-refund");
    expect(effects).not.toContain("destination-refund");
  });

  test("alerts, preparing nothing, when such a final reveal is first observed after the source expiry", async () => {
    const { h, run } = await toFinalRevealWithRegressedLock("absent");
    run.setClock(5_000_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "late-observer" })).resolves.toEqual({
      status: "operator-alert",
      reason: "htlc-source-claim-missed-after-reveal",
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim")],
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-claim"]);
  });

  test("retains the destination-lock reference when source expiry arrives during claim persistence", async () => {
    const { h, run } = await toFinalRevealWithRegressedLock("absent");
    const base = run.shared.store;
    const store: CrossChainHtlcStore = {
      ...base,
      async recordPrepared(input) {
        const result = await base.recordPrepared(input);
        if (input.prepared.action === "source-claim") run.setClock(5_000_000);
        return result;
      },
    };
    const broadcasts = h.broadcastRetained.mock.calls.length;
    await expect(advanceCrossChainHtlc({
      ...run.nextOwner(), store, leaseDurationMs: 10_000_000,
    })).resolves.toEqual({
      status: "operator-alert",
      reason: "htlc-source-claim-missed-after-reveal",
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim")],
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-claim", "source-claim"]);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
  });

  test("keeps driving the source claim from the reveal checkpoint when the lock, then also the reveal, is no longer reported", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
    });
    const reveal = h.actions["destination-claim"];
    delete h.actions["destination-lock"];
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      reason: "dest-revealed-source-unclaimed",
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")],
    });
    delete h.actions["destination-claim"];
    delete h.actions["source-claim"];
    // The checkpointed reveal is still named, as the settlement names it.
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "settle-asymmetric",
      reason: "dest-revealed-source-unclaimed",
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")],
    });
    // The unreported source claim is rebroadcast from its retained bytes.
    const sourceClaims = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "source-claim");
    expect(sourceClaims.length).toBeGreaterThan(1);
    expect(sourceClaims.at(-1)).toEqual(sourceClaims[0]);
    h.actions["destination-claim"] = reveal;
    await h.markFinal("source-claim");
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "settled",
      settlement: { txRefs: [
        refFor("source-lock"),
        refFor("destination-lock"),
        refFor("destination-claim"),
        refFor("source-claim"),
      ] },
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-claim", "source-claim"]);
  });

  test("alerts on a failed reveal once the claim window has closed and refunds both legs after both expiries", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-claim": "pending" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const pending = h.actions["destination-claim"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending reveal");
    // Reverted at the destination-claim cutoff: its calldata published the preimage.
    h.actions["destination-claim"] = {
      state: "failed",
      txRef: pending.txRef,
      reason: "reveal-reverted",
      authenticationHash: AUTH_HASH,
    };
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    for (const [owner, now] of [["at-cutoff", 1_185_000], ["destination-expired", 1_200_000]] as const) {
      await expect(advanceCrossChainHtlc({ ...run.shared, owner, now: () => now })).resolves.toEqual({
        status: "operator-alert",
        reason: "htlc-destination-claim-failed-preimage-public",
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim")],
      });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "failed-after-source-expiry" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-claim-unlanded" });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "failed-refunded", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refunded", reason: "destination-claim-unlanded" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual([
      "source-lock",
      "destination-lock",
      "destination-claim",
      "source-refund",
      "destination-refund",
    ]);
  });

  test("reports refund-stalled when the source refund reverts after a public failed reveal", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-claim": "pending", "source-refund": "pending" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const pending = h.actions["destination-claim"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending reveal");
    h.actions["destination-claim"] = { state: "failed", txRef: pending.txRef, authenticationHash: AUTH_HASH };
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "both-refunds-sent" }))
      .resolves.toMatchObject({
        status: "refund-pending",
        reason: "destination-claim-unlanded",
        refunds: { "destination-refund": "final", "source-refund": "pending" },
      });
    // The payee claimed the source with the published preimage first.
    const sourceRefund = h.actions["source-refund"];
    if (!sourceRefund || sourceRefund.state !== "pending") throw new Error("expected pending source refund");
    h.actions["source-refund"] = { state: "failed", txRef: sourceRefund.txRef, authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-refund-reverted", now: () => 1_700_101 }))
      .resolves.toMatchObject({
        status: "refund-stalled",
        reason: "destination-claim-unlanded",
        refunds: { "destination-refund": "final", "source-refund": "failed" },
      });
  });

  test("replaces a failed reveal while the claim window is open and broadcasts the new bytes", async () => {
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const first = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .find((prepared) => prepared.action === "destination-claim");
    if (!first) throw new Error("expected a reveal");
    h.actions["destination-claim"] = {
      state: "failed",
      txRef: first.txRef,
      reason: "out-of-gas",
      authenticationHash: AUTH_HASH,
    };
    for (let call = 0; call < 3; call += 1) {
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "waiting",
        reason: "htlc-destination-claim-finality-pending",
      });
    }
    const revealRequests = h.prepareAction.mock.calls
      .map((call) => call[0])
      .filter((request) => request.action === "destination-claim");
    expect(revealRequests).toHaveLength(2);
    expect(revealRequests[1]!.replacement).toEqual({
      attempt: 2,
      priorEffectHash: first.effectHash,
      priorTxRef: first.txRef,
      failureAuthenticationHash: AUTH_HASH,
    });
    expect(Buffer.from(revealRequests[1]!.preimage!).toString("hex")).toBe(PREIMAGE_HEX);
    const reveals = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "destination-claim");
    expect(reveals).toHaveLength(2);
    expect(reveals[1]!.effectHash).not.toBe(first.effectHash);
    expect(reveals[1]!.txRef).toEqual(refFor("destination-claim", "-attempt-2"));
    // The replacement lands and the payee's source claim settles the session.
    h.actions["destination-claim"] = {
      state: "final",
      txRef: reveals[1]!.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
      finalityObservedAt: 1_000_000,
      revealedPreimageHex: PREIMAGE_HEX,
      authenticationHash: AUTH_HASH,
    };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "settled",
      settlement: { txRefs: [
        refFor("source-lock"),
        refFor("destination-lock"),
        refFor("destination-claim", "-attempt-2"),
        refFor("source-claim"),
      ] },
    });
  });

  test("replaces repeated reveal failures up to the cap, then raises an operator alert", async () => {
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const failActiveReveal = () => {
      const active = h.broadcastRetained.mock.calls
        .map((call) => call[0])
        .filter((prepared) => prepared.action === "destination-claim")
        .at(-1);
      if (!active) throw new Error("expected a reveal");
      h.actions["destination-claim"] = { state: "failed", txRef: active.txRef, authenticationHash: AUTH_HASH };
    };
    for (let replacement = 1; replacement <= 3; replacement += 1) {
      failActiveReveal();
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "waiting",
        reason: "htlc-destination-claim-finality-pending",
      });
    }
    failActiveReveal();
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    for (let call = 0; call < 2; call += 1) {
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "operator-alert",
        reason: "htlc-destination-claim-failed-preimage-public",
        txRefs: [
          refFor("source-lock"),
          refFor("destination-lock"),
          refFor("destination-claim", "-attempt-4"),
        ],
      });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    expect(h.prepareAction.mock.calls
      .filter((call) => call[0].action === "destination-claim")
      .map((call) => call[0].replacement?.attempt)).toEqual([undefined, 2, 3, 4]);
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("source-refund");
  });

  test("retries a reveal replacement the adapter fails to prepare as uncertain, without paging", async () => {
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } });
    const original = h.adapter.prepareAction;
    let refuse = false;
    h.adapter.prepareAction = vi.fn<CrossChainHtlcAdapter["prepareAction"]>(async (request, fence) => {
      if (refuse && request.replacement) throw new Error("payer role service: 503 Service Unavailable");
      return original(request, fence);
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const pending = h.actions["destination-claim"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending reveal");
    h.actions["destination-claim"] = { state: "failed", txRef: pending.txRef, authenticationHash: AUTH_HASH };
    refuse = true;
    // A timeout, a 5xx and a refusal look alike; as for a source claim, each is
    // uncertain and the next call retries while the claim window is open.
    for (let call = 0; call < 2; call += 1) {
      const progress = await advanceCrossChainHtlc(run.nextOwner());
      expect(progress).toEqual({ status: "indeterminate", reason: "htlc-destination-claim-effect-uncertain" });
      expect(htlcNeedsOperator(progress)).toBe(false);
    }
    expect(h.broadcastRetained.mock.calls.filter((call) => call[0].action === "destination-claim"))
      .toHaveLength(1);
    // Resumable: once the adapter prepares it, the next call replaces the reveal.
    refuse = false;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    expect(h.broadcastRetained.mock.calls.filter((call) => call[0].action === "destination-claim"))
      .toHaveLength(2);
  });

  test("never refunds on a failed observation of a replaced reveal while the replacement may land", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-claim": "pending" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const original = h.actions["destination-claim"];
    if (!original || original.state !== "pending") throw new Error("expected pending reveal");
    const failedOriginal = {
      state: "failed" as const,
      txRef: original.txRef,
      authenticationHash: AUTH_HASH,
    };
    h.actions["destination-claim"] = failedOriginal;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    expect(h.actions["destination-claim"]).toMatchObject({
      state: "pending",
      txRef: refFor("destination-claim", "-attempt-2"),
    });
    // Past both expiries the adapter reports only the replaced reveal, failed.
    // The replacement may still land, so neither leg is refunded.
    h.actions["destination-claim"] = failedOriginal;
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "stale-failure" })).resolves.toEqual({
      status: "operator-alert",
      reason: "htlc-destination-claim-failed-preimage-public",
      txRefs: [refFor("source-lock"), refFor("destination-lock")],
    });
    const effects = h.prepareAction.mock.calls.map((call) => call[0].action);
    expect(effects).not.toContain("source-refund");
    expect(effects).not.toContain("destination-refund");
  });

  test("still replaces a failed reveal after the payer withdraws authorization", async () => {
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const pending = h.actions["destination-claim"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending reveal");
    h.actions["destination-claim"] = { state: "failed", txRef: pending.txRef, authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), authorizeDestinationClaim: false }))
      .resolves.toEqual({ status: "waiting", reason: "htlc-destination-claim-finality-pending" });
    expect(h.prepareAction.mock.calls.filter((call) => call[0].action === "destination-claim"))
      .toHaveLength(2);
  });

  test("broadcasts nothing when the stored reveal changed under the replacement compare-and-swap", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const { intent } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
    const rival = preparedFor(intent, "destination-claim", "-rival");
    const store: CrossChainHtlcStore = {
      ...base,
      async replacePreparedDestinationClaim(input) {
        // Another writer swaps the stored reveal first.
        await base.replacePreparedDestinationClaim({ ...input, replacement: rival });
        return base.replacePreparedDestinationClaim(input);
      },
    };
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } });
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const pending = h.actions["destination-claim"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending reveal");
    h.actions["destination-claim"] = { state: "failed", txRef: pending.txRef, authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-destination-claim-effect-uncertain",
    });
    expect(h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "destination-claim")
      .map((prepared) => prepared.txRef)).toEqual([refFor("destination-claim")]);
  });

  test("rebroadcasts a persisted reveal replacement after a restart, never preparing a third reveal", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    let crashAfterCommit = true;
    const store: CrossChainHtlcStore = {
      ...base,
      async replacePreparedDestinationClaim(input) {
        const result = await base.replacePreparedDestinationClaim(input);
        if (crashAfterCommit) {
          crashAfterCommit = false;
          throw new Error("worker lost after the replacement committed");
        }
        return result;
      },
    };
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } });
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const pending = h.actions["destination-claim"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending reveal");
    h.actions["destination-claim"] = { state: "failed", txRef: pending.txRef, authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-destination-claim-effect-uncertain",
    });
    const reveals = () => h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "destination-claim");
    expect(reveals()).toHaveLength(1);
    // The adapter still reports the replaced reveal failed; the persisted
    // replacement is rebroadcast from the store, byte for byte.
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    const preparedReplacement = await h.prepareAction.mock.results[3]!.value;
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-claim", "destination-claim"]);
    expect(reveals()).toHaveLength(2);
    const { effectHash, ...rebroadcast } = reveals()[1]!;
    expect(rebroadcast).toEqual(preparedReplacement);
    expect(effectHash).toBe(sha256Hex(canonicalize(rebroadcast)));
  });

  // Source lock, destination lock and a reveal broadcast and pending; the
  // reveal is then authenticated failed (reverted on chain).
  async function toFailedReveal(options: HarnessOptions = {}) {
    const h = harness({
      sourceExpiry: 5_000,
      destinationExpiry: 1_500,
      ...options,
      mode: { "destination-claim": "pending", ...options.mode },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const pending = h.actions["destination-claim"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending reveal");
    h.actions["destination-claim"] = { state: "failed", txRef: pending.txRef, authenticationHash: AUTH_HASH };
    return { h, run };
  }

  test("fails closed, moving nothing, when the adapter reports the payee's own out-of-core source claim", async () => {
    // Adapters must report only the core's own transactions. This pins what
    // happens when one reports the payee's claim made with the public
    // preimage: the snapshot is rejected, and nothing is replaced, re-sent or
    // refunded, even after both expiries.
    const { h, run } = await toFailedReveal();
    h.actions["source-claim"] = {
      state: "final",
      txRef: refFor("source-claim", "-payee-own") as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
      finalityObservedAt: 1_000_600,
      finalityReachedAt: 1_000_600,
      authenticationHash: AUTH_HASH,
    };
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    for (const [owner, now] of [["in-window", 1_001_000], ["in-window-again", 1_001_101], ["both-expired", 5_000_000]] as const) {
      await expect(advanceCrossChainHtlc({ ...run.shared, owner, now: () => now })).resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-ledger-observation-unavailable",
      });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-claim"]);
  });

  test("does not broadcast a committed reveal replacement when the claim window closes after its CAS", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    let closeWindow = () => {};
    const store: CrossChainHtlcStore = {
      ...base,
      async replacePreparedDestinationClaim(input) {
        const result = await base.replacePreparedDestinationClaim(input);
        if (result.status === "recorded") closeWindow();
        return result;
      },
    };
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } });
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const pending = h.actions["destination-claim"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending reveal");
    h.actions["destination-claim"] = { state: "failed", txRef: pending.txRef, authenticationHash: AUTH_HASH };
    // A lease long enough to outlive the jump, so only the claim window stops
    // the broadcast: the destination-claim cutoff is 1_500 s - 15 s.
    let clock = 1_000_404;
    closeWindow = () => { clock = 1_485_000; };
    await expect(advanceCrossChainHtlc({
      ...run.shared,
      owner: "replacer",
      leaseDurationMs: 600_000,
      now: () => clock,
    })).resolves.toEqual({
      status: "operator-alert",
      reason: "htlc-destination-claim-failed-preimage-public",
      txRefs: [refFor("source-lock"), refFor("destination-lock")],
    });
    expect(h.prepareAction.mock.calls.filter((call) => call[0].action === "destination-claim"))
      .toHaveLength(2);
    expect(h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "destination-claim")
      .map((prepared) => prepared.txRef)).toEqual([refFor("destination-claim")]);
    // The committed replacement and its history stay durable for reconciliation.
    const created = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
    await expect(base.claim({ ...created, owner: "auditor", now: 1_600_405, leaseDurationMs: 100 }))
      .resolves.toMatchObject({
        status: "acquired",
        prepared: [{ action: "source-lock" }, { action: "destination-lock" }, {
          action: "destination-claim",
          txRef: refFor("destination-claim", "-attempt-2"),
        }],
        destinationClaimAttemptHistory: [{ attempt: 1, prepared: { txRef: refFor("destination-claim") } }],
      });
  });

  test("rebroadcasts a retained reveal after the payer withdraws authorization", async () => {
    // The reveal was persisted but its broadcast was ambiguous, so it may
    // already be public: the payer's withdrawal never holds back its bytes.
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "throw-once" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-destination-claim-effect-uncertain",
    });
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), authorizeDestinationClaim: false }))
      .resolves.toEqual({ status: "waiting", reason: "htlc-destination-claim-finality-pending" });
    expect(h.prepareAction.mock.calls.filter((call) => call[0].action === "destination-claim"))
      .toHaveLength(1);
    const reveals = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "destination-claim");
    expect(reveals).toHaveLength(2);
    expect(reveals[1]).toEqual(reveals[0]);
  });

  test("keeps waiting, paged but without an alert, while a replacement reveal is pending past the destination expiry", async () => {
    const { h, run } = await toFailedReveal({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    expect(h.actions["destination-claim"]).toMatchObject({
      state: "pending",
      txRef: refFor("destination-claim", "-attempt-2"),
    });
    run.setClock(1_200_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "replacement-pending" })).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-unresolved-after-cutoff",
    });
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "replacement-unresolved" })).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-unresolved-after-expiry",
    });
    const effects = h.prepareAction.mock.calls.map((call) => call[0].action);
    expect(effects).not.toContain("source-refund");
    expect(effects).not.toContain("destination-refund");
  });

  test("drives the payer's source refund when the payee's destination refund cannot be prepared", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const original = h.adapter.prepareAction;
    h.adapter.prepareAction = vi.fn<CrossChainHtlcAdapter["prepareAction"]>(async (request, fence) => {
      if (request.action === "destination-refund") throw new Error("payee role service unavailable");
      return original(request, fence);
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_200_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "payee-unavailable" })).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-timeout",
      txRefs: [refFor("source-lock"), refFor("destination-lock")],
      refunds: { "destination-refund": "uncertain", "source-refund": "waiting" },
    });
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "payer-refund" })).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-timeout",
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
      refunds: { "destination-refund": "uncertain", "source-refund": "final" },
    });
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "source-refund"]);
    expect(h.actions["source-refund"]).toMatchObject({ state: "final" });
  });

  test("sends the payer's source refund before asking a payee role service that never answers", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const original = h.adapter.prepareAction;
    let payeeAsked!: () => void;
    const asked = new Promise<void>((resolve) => { payeeAsked = resolve; });
    let payeeTimesOut!: (error: Error) => void;
    h.adapter.prepareAction = vi.fn<CrossChainHtlcAdapter["prepareAction"]>(async (request, fence) => {
      if (request.action !== "destination-refund") return original(request, fence);
      payeeAsked();
      // The payee's role service hangs until the test lets its adapter time out.
      return new Promise((_resolve, reject) => { payeeTimesOut = reject; });
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_700_000);
    const call = advanceCrossChainHtlc({ ...run.shared, owner: "payee-hangs" });
    await asked;
    // By the time the payee is asked anything, the payer's refund is on the wire.
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "source-refund"]);
    expect(h.actions["source-refund"]).toMatchObject({ state: "final" });
    payeeTimesOut(new Error("payee role service timed out"));
    await expect(call).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-timeout",
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
      refunds: { "destination-refund": "uncertain", "source-refund": "final" },
    });
  });

  test("sends the payer's source refund when the payee's refund preparation outlasts the lease", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const original = h.adapter.prepareAction;
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    let clock = 1_000_000;
    h.adapter.prepareAction = vi.fn<CrossChainHtlcAdapter["prepareAction"]>(async (request, fence) => {
      const prepared = await original(request, fence);
      // The payee's role service answers, but only after the 100 ms lease lapsed.
      if (request.action === "destination-refund") run.setClock(clock += 101);
      return prepared;
    });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    for (const tick of [1, 2]) {
      run.setClock(clock = 1_700_000 + tick * 1_000);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: `slow-payee-${tick}` })).resolves.toEqual({
        status: "refund-pending",
        reason: "destination-timeout",
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
        refunds: { "destination-refund": "uncertain", "source-refund": "final" },
      });
    }
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual([
      "source-lock",
      "destination-lock",
      "source-refund",
      "destination-refund",
      "destination-refund",
    ]);
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "source-refund"]);
  });

  test.each(["throws", "never answers"] as const)(
    "sends the payer's source refund when the whole-session observation %s on the payee's side",
    async (failure) => {
      const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
      const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      const observeLedger = h.observe.getMockImplementation()!;
      // From here `observe` depends on a payee-side service that is down.
      h.observe.mockImplementation(failure === "throws"
        ? async () => { throw new Error("payee observation unavailable"); }
        : () => new Promise(() => {}));
      const payerRefunded = {
        status: "refund-pending",
        reason: "destination-lock-unresolved",
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
        refunds: { "destination-refund": "uncertain", "source-refund": "final" },
      };
      run.setClock(1_700_000);
      await expect(settlesWithin(advanceCrossChainHtlc({ ...run.shared, owner: "payee-down" }), 2_000))
        .resolves.toEqual(payerRefunded);
      expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "source-refund"]);
      expect(h.actions["source-refund"]).toMatchObject({ state: "final" });
      // Later calls read the refund on the source leg and never send it again.
      await expect(settlesWithin(
        advanceCrossChainHtlc({ ...run.shared, owner: "payee-still-down", now: () => 1_700_101 }),
        2_000,
      )).resolves.toEqual(payerRefunded);
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "source-refund"]);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(3);
      // Once the payee's side is back, its own refund follows.
      h.observe.mockImplementation(observeLedger);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "payee-back", now: () => 1_700_202 }))
        .resolves.toMatchObject({
          status: "refund-pending",
          reason: "destination-timeout",
          refunds: { "destination-refund": "final", "source-refund": "final" },
        });
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "both-refunded", now: () => 1_700_303 }))
        .resolves.toMatchObject({ status: "refunded", reason: "destination-timeout" });
    },
  );

  test("returns at the lease when the payee hangs after the payer's refund broadcast failed, then resends it", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const prepare = h.adapter.prepareAction;
    const broadcast = h.adapter.broadcastRetained;
    const sent: Readonly<HtlcPreparedAction>[] = [];
    let rpcDown = true;
    h.adapter.prepareAction = vi.fn<CrossChainHtlcAdapter["prepareAction"]>(async (request, fence) =>
      request.action === "destination-refund" ? new Promise(() => {}) : prepare(request, fence));
    h.adapter.broadcastRetained = vi.fn<CrossChainHtlcAdapter["broadcastRetained"]>(async (prepared, fence) => {
      sent.push(prepared);
      if (prepared.action === "source-refund" && rpcDown) {
        rpcDown = false;
        throw new Error("RPC 503");
      }
      return broadcast(prepared, fence);
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_700_000);
    // A host that awaits each call before the next gets this one back.
    await expect(settlesWithin(advanceCrossChainHtlc({ ...run.shared, owner: "refund-503" }), 2_000))
      .resolves.toEqual({
        status: "refund-pending",
        reason: "destination-timeout",
        txRefs: [refFor("source-lock"), refFor("destination-lock")],
        refunds: { "destination-refund": "uncertain", "source-refund": "uncertain" },
      });
    await expect(settlesWithin(
      advanceCrossChainHtlc({ ...run.shared, owner: "refund-resent", now: () => 1_700_101 }),
      2_000,
    )).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-timeout",
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
      refunds: { "destination-refund": "uncertain", "source-refund": "final" },
    });
    const refunds = sent.filter((item) => item.action === "source-refund");
    expect(refunds).toHaveLength(2);
    expect(refunds[1]).toEqual(refunds[0]);
    expect(h.prepareAction.mock.calls.filter((call) => call[0].action === "source-refund")).toHaveLength(1);
  });

  test("without a source-leg observation sends only a first source refund, from the checkpoint", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const broadcast = h.adapter.broadcastRetained;
    let rpcDown = true;
    h.adapter.broadcastRetained = vi.fn<CrossChainHtlcAdapter["broadcastRetained"]>(async (prepared, fence) => {
      if (prepared.action === "source-refund" && rpcDown) {
        rpcDown = false;
        throw new Error("RPC 503");
      }
      return broadcast(prepared, fence);
    });
    const { observeSourceLeg: _sourceLeg, ...wholeSessionOnly } = h.adapter;
    const run = runner({
      adapter: wholeSessionOnly as unknown as CrossChainHtlcAdapter,
      authorizeDestinationClaim: false,
    });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    const observeLedger = h.observe.getMockImplementation()!;
    h.observe.mockImplementation(async () => { throw new Error("payee observation unavailable"); });
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "no-source-leg" })).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-lock-unresolved",
      txRefs: [refFor("source-lock"), refFor("destination-lock")],
      refunds: { "destination-refund": "uncertain", "source-refund": "uncertain" },
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "source-refund"]);
    // Nothing shows the retained refund is not dead, so it is not resent.
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "still-unobserved", now: () => 1_700_101 }))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-ledger-observation-unavailable" });
    expect(h.prepareAction).toHaveBeenCalledTimes(3);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(2);
    expect(h.actions["source-refund"]).toBeUndefined();
    h.observe.mockImplementation(observeLedger);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "observed-again", now: () => 1_700_202 }))
      .resolves.toMatchObject({
        status: "refund-pending",
        refunds: { "destination-refund": "final", "source-refund": "final" },
      });
    expect(h.prepareAction.mock.calls.filter((call) => call[0].action === "source-refund")).toHaveLength(1);
  });

  test.each([
    ["failed", "refund-stalled"],
    ["absent", "operator-alert"],
  ] as const)(
    "pages a source refund read %s on the source leg while the payee's side is down, never resending it",
    async (state, status) => {
      const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200, mode: { "source-refund": "pending" } });
      const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      run.setClock(1_700_000);
      await advanceCrossChainHtlc({ ...run.shared, owner: "refunds-sent" });
      const pending = h.actions["source-refund"];
      if (!pending || pending.state !== "pending") throw new Error("expected pending source refund");
      h.actions["source-refund"] = { state, txRef: pending.txRef, authenticationHash: AUTH_HASH };
      h.observe.mockImplementation(async () => { throw new Error("payee observation unavailable"); });
      const preparations = h.prepareAction.mock.calls.length;
      const broadcasts = h.broadcastRetained.mock.calls.length;
      const progress = await advanceCrossChainHtlc({ ...run.shared, owner: "payee-down", now: () => 1_700_101 });
      expect(progress).toEqual({
        status,
        reason: status === "operator-alert" ? "htlc-refund-absent" : "destination-lock-unresolved",
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
        refunds: { "destination-refund": "uncertain", "source-refund": state },
      });
      expect(htlcNeedsOperator(progress)).toBe(true);
      expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    },
  );

  test("refuses a source-leg observation that reports the destination leg", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    h.observeSourceLeg.mockImplementation(h.observe.getMockImplementation()!);
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    h.observe.mockImplementation(async () => { throw new Error("payee observation unavailable"); });
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "mixed-source-leg" })).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-ledger-observation-unavailable",
    });
    expect(h.observeSourceLeg).toHaveBeenCalled();
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "destination-lock"]);
  });

  test("abandons an adapter broadcast that outlasts the lease and resends the same bytes next call", async () => {
    const h = harness();
    const broadcast = h.adapter.broadcastRetained;
    const sent: Readonly<HtlcPreparedAction>[] = [];
    h.adapter.broadcastRetained = vi.fn<CrossChainHtlcAdapter["broadcastRetained"]>(async (prepared, fence) => {
      sent.push(prepared);
      return sent.length === 1 ? new Promise(() => {}) : broadcast(prepared, fence);
    });
    const run = runner({ adapter: h.adapter });
    await expect(settlesWithin(advanceCrossChainHtlc(run.shared), 2_000)).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-source-lock-effect-uncertain",
    });
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-source-lock-finality-pending",
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(h.prepareAction).toHaveBeenCalledTimes(1);
  });

  test("reports a reverted source refund as refund-stalled and never re-sends it", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "source-refund": "pending" },
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "both-refunds-sent" })).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-timeout",
      txRefs: [
        refFor("source-lock"),
        refFor("destination-lock"),
        refFor("source-refund"),
        refFor("destination-refund"),
      ],
      refunds: { "destination-refund": "final", "source-refund": "pending" },
    });
    // e.g. the local clock ran ahead of the chain and the refund reverted early
    const pending = h.actions["source-refund"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending source refund");
    h.actions["source-refund"] = {
      state: "failed",
      txRef: pending.txRef,
      reason: "not-yet-expired",
      authenticationHash: AUTH_HASH,
    };
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    for (const tick of [1, 2, 3]) {
      await expect(advanceCrossChainHtlc({
        ...run.shared,
        owner: `stalled-${tick}`,
        now: () => 1_700_000 + tick * 101,
      })).resolves.toEqual({
        status: "refund-stalled",
        reason: "destination-timeout",
        txRefs: [
          refFor("source-lock"),
          refFor("destination-lock"),
          refFor("source-refund"),
          refFor("destination-refund"),
        ],
        refunds: { "destination-refund": "final", "source-refund": "failed" },
      });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
  });

  test("keeps driving the payer's source refund when the destination refund reverted", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-refund": "pending" },
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_200_000);
    await advanceCrossChainHtlc({ ...run.shared, owner: "destination-refund-sent" });
    const pending = h.actions["destination-refund"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending destination refund");
    h.actions["destination-refund"] = {
      state: "failed",
      txRef: pending.txRef,
      authenticationHash: AUTH_HASH,
    };
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "destination-stalled", now: () => 1_200_101 }))
      .resolves.toEqual({
        status: "refund-stalled",
        reason: "destination-timeout",
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-refund")],
        refunds: { "destination-refund": "failed", "source-refund": "waiting" },
      });
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-refund-despite-stall" }))
      .resolves.toEqual({
        status: "refund-stalled",
        reason: "destination-timeout",
        txRefs: [
          refFor("source-lock"),
          refFor("destination-lock"),
          refFor("source-refund"),
          refFor("destination-refund"),
        ],
        refunds: { "destination-refund": "failed", "source-refund": "final" },
      });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual([
      "source-lock",
      "destination-lock",
      "destination-refund",
      "source-refund",
    ]);
  });

  test("reports a reverted source refund before any destination lock as refund-stalled", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      sourceLockTerms: { amountBaseUnits: "1" },
      mode: { "source-refund": "pending" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "underfunded-source-refund" }))
      .resolves.toEqual({
        status: "refund-pending",
        reason: "source-lock-terms-mismatch",
        txRefs: [refFor("source-lock"), refFor("source-refund")],
        refunds: { "source-refund": "pending" },
      });
    const pending = h.actions["source-refund"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending source refund");
    h.actions["source-refund"] = { state: "failed", txRef: pending.txRef, authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-stalled", now: () => 1_700_101 }))
      .resolves.toEqual({
        status: "refund-stalled",
        reason: "source-lock-terms-mismatch",
        txRefs: [refFor("source-lock"), refFor("source-refund")],
        refunds: { "source-refund": "failed" },
      });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "source-refund"]);
  });

  test("names both refund legs when neither can be prepared", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const original = h.adapter.prepareAction;
    h.adapter.prepareAction = vi.fn<CrossChainHtlcAdapter["prepareAction"]>(async (request, fence) => {
      if (request.action.endsWith("-refund")) throw new Error("role services unavailable");
      return original(request, fence);
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "both-uncertain" })).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-timeout",
      txRefs: [refFor("source-lock"), refFor("destination-lock")],
      refunds: { "destination-refund": "uncertain", "source-refund": "uncertain" },
    });
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock"]);
  });

  test("does not hold the payer's source refund behind an unobserved destination refund", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-refund": "throw-once" },
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_200_000);
    await advanceCrossChainHtlc({ ...run.shared, owner: "refund-ambiguous" });
    await advanceCrossChainHtlc({ ...run.shared, owner: "refund-rebroadcast", now: () => 1_200_101 });
    expect(h.actions["destination-refund"]).toBeUndefined();
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-refund-due" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-timeout" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toContain("source-refund");
    expect(h.actions["source-refund"]).toMatchObject({ state: "final" });
  });

  test.each([
    ["token", { token: "worthless-token" }],
    ["amount", { amountBaseUnits: "1249999" }],
    ["hashlock", { hashlock: `80002:${"0".repeat(64)}` }],
    ["sender", { sender: "someone-else" }],
    ["recipient", { recipient: "payee-destination" }],
  ] as const)("never reveals into a destination lock with a different %s and refunds instead", async (_name, terms) => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200, destinationLockTerms: terms });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-lock-terms-mismatch",
      txRefs: [refFor("source-lock"), refFor("destination-lock")],
      refunds: { "destination-refund": "waiting", "source-refund": "waiting" },
    });
    run.setClock(1_200_000);
    await advanceCrossChainHtlc({ ...run.shared, owner: "terms-destination-refund" });
    run.setClock(1_700_000);
    await advanceCrossChainHtlc({ ...run.shared, owner: "terms-source-refund" });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "terms-refunded", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refunded", reason: "destination-lock-terms-mismatch" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual([
      "source-lock",
      "destination-lock",
      "destination-refund",
      "source-refund",
    ]);
  });

  test("never reveals into a destination lock without terms and still refunds both legs", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200, omitDestinationLockTerms: true });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-lock-terms-missing",
      txRefs: [refFor("source-lock"), refFor("destination-lock")],
      refunds: { "destination-refund": "waiting", "source-refund": "waiting" },
    });
    run.setClock(1_200_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "no-terms-destination-refund" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-timeout" });
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "no-terms-source-refund" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-timeout" });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "no-terms-refunded", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refunded", reason: "destination-timeout" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual([
      "source-lock",
      "destination-lock",
      "destination-refund",
      "source-refund",
    ]);
  });

  test.each(["removed", "changed"] as const)(
    "drives the payee's source claim after a final reveal when destination terms are %s",
    async (change) => {
      const h = harness({ mode: { "source-claim": "pending" } });
      const run = runner({ adapter: h.adapter });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "waiting",
        reason: "htlc-destination-claim-finality-pending",
      });
      // The contract may delete or rewrite its lock record once the reveal lands.
      const destinationLock = h.actions["destination-lock"];
      if (!destinationLock || destinationLock.state !== "final") throw new Error("expected final lock");
      const { lockTerms: _terms, ...withoutTerms } = destinationLock;
      h.actions["destination-lock"] = change === "removed"
        ? withoutTerms
        : { ...destinationLock, lockTerms: { ...destinationLock.lockTerms!, amountBaseUnits: "0" } };
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
        status: "settle-asymmetric",
        reason: "dest-revealed-source-unclaimed",
      });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual([
        "source-lock",
        "destination-lock",
        "destination-claim",
        "source-claim",
      ]);
      h.setMode("source-claim", "final");
      await h.markFinal("source-claim");
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
    },
  );

  test.each([
    ["missing", undefined],
    ["a different token", { token: "worthless-token" }],
    ["a different amount", { amountBaseUnits: "1" }],
  ] as const)(
    "rebroadcasts a retained reveal byte-for-byte when destination terms read %s on restart",
    async (_name, terms) => {
      const h = harness({ mode: { "destination-claim": "throw-once" } });
      const run = runner({ adapter: h.adapter });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-destination-claim-effect-uncertain",
      });
      // The ambiguous broadcast may have exposed the preimage; the terms the
      // reveal was prepared against no longer read the same.
      const destinationLock = h.actions["destination-lock"];
      if (!destinationLock || destinationLock.state !== "final") throw new Error("expected final lock");
      const { lockTerms, ...withoutTerms } = destinationLock;
      h.actions["destination-lock"] = terms === undefined
        ? withoutTerms
        : { ...destinationLock, lockTerms: { ...lockTerms!, ...terms } };
      h.setMode("destination-claim", "final");
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "waiting",
        reason: "htlc-destination-claim-finality-pending",
      });
      const reveals = h.broadcastRetained.mock.calls
        .map((call) => call[0])
        .filter((prepared) => prepared.action === "destination-claim");
      expect(reveals).toHaveLength(2);
      expect(reveals[1]).toEqual(reveals[0]);
      expect(h.prepareAction.mock.calls.filter((call) => call[0].action === "destination-claim"))
        .toHaveLength(1);
      expect(h.actions["destination-claim"]).toMatchObject({ state: "final" });
    },
  );

  test.each([
    ["token", { token: "worthless-token" }],
    ["amount", { amountBaseUnits: "1249999" }],
    ["hashlock", { hashlock: `84532:${"0".repeat(64)}` }],
    ["sender", { sender: "someone-else" }],
    ["recipient", { recipient: "payer-source" }],
    ["missing", undefined],
  ] as const)("never locks the destination against a source lock with %s terms", async (name, terms) => {
    const h = harness({
      sourceExpiry: 1_700,
      ...(terms === undefined ? { omitSourceLockTerms: true } : { sourceLockTerms: terms }),
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "refund-pending",
      reason: name === "missing" ? "source-lock-terms-missing" : "source-lock-terms-mismatch",
      txRefs: [refFor("source-lock")],
      refunds: { "source-refund": "waiting" },
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock"]);
    const reason = name === "missing" ? "source-lock-terms-missing" : "source-lock-terms-mismatch";
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-terms-refund" }))
      .resolves.toMatchObject({ status: "refund-pending", reason });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-terms-refunded", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refunded", reason });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "source-refund"]);
  });

  test.each([
    ["source", { sourceLockTerms: { amountBaseUnits: "01250000" } }, ["source-lock"]],
    ["destination", { destinationLockTerms: { amountBaseUnits: "01250000" } }, ["source-lock", "destination-lock"]],
  ] as const)("fails closed on non-canonical %s lock amount terms", async (_leg, options, effects) => {
    const h = harness(options);
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-adapter-lock-observation-invalid",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(effects);
  });

  test("does not rebroadcast a retained destination lock while source terms are unavailable", async () => {
    const h = harness({ mode: { "destination-lock": "throw-once" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-destination-lock-effect-uncertain",
    });
    const sourceLock = h.actions["source-lock"];
    if (!sourceLock || sourceLock.state !== "final") throw new Error("expected final source lock");
    const { lockTerms: _terms, ...withoutTerms } = sourceLock;
    h.actions["source-lock"] = withoutTerms;
    h.setMode("destination-lock", "final");
    // The unreported retained lock may still land, so it stays an owed leg.
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "refund-pending",
      reason: "source-lock-terms-missing",
      txRefs: [refFor("source-lock"), refFor("destination-lock")],
      refunds: { "destination-refund": "waiting", "source-refund": "waiting" },
    });
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock"]);
    h.actions["source-lock"] = sourceLock;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-lock-finality-pending",
    });
    const destinationBroadcasts = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "destination-lock");
    expect(destinationBroadcasts).toHaveLength(2);
    expect(destinationBroadcasts[1]).toEqual(destinationBroadcasts[0]);
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock"]);
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
      const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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

  test.each([
    ["source-lock", "expiresAt"],
    ["source-lock", "includedAt"],
    ["destination-lock", "expiresAt"],
    ["destination-lock", "includedAt"],
  ] as const)("keeps a final %s observation without %s resumable with an explicit reason", async (action, field) => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    const valid = h.actions[action];
    if (!valid || valid.state !== "final") throw new Error("expected final lock");
    const { [field]: _dropped, ...malformed } = valid;
    h.actions[action] = malformed as HtlcObservedAction;
    run.setClock(1_700_000);
    if (action === "source-lock") {
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "malformed-lock" })).resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-adapter-lock-observation-invalid",
      });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock"]);
    } else {
      // A malformed destination lock is the payee's leg: the payer's source
      // refund, decided on the source leg, still goes out first.
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "malformed-lock" })).resolves.toEqual({
        status: "refund-pending",
        reason: "destination-lock-unresolved",
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
        refunds: { "destination-refund": "uncertain", "source-refund": "final" },
      });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "source-refund"]);
    }
    // A corrected observation resumes the refunds.
    h.actions[action] = valid;
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "corrected-lock", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-timeout" });
  });

  test.each(["deleted", "pending", "absent"] as const)(
    "keeps a checkpointed source lock that is now %s resumable, never failed",
    async (variant) => {
      const h = harness({ sourceExpiry: 1_700 });
      const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      const sourceLock = h.actions["source-lock"];
      if (!sourceLock || sourceLock.state !== "final") throw new Error("expected final source lock");
      if (variant === "deleted") delete h.actions["source-lock"];
      else if (variant === "pending") {
        h.actions["source-lock"] = { state: "pending", txRef: sourceLock.txRef, authenticationHash: AUTH_HASH };
      } else h.actions["source-lock"] = { state: "absent", authenticationHash: AUTH_HASH };
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-source-finality-checkpoint-without-final-lock",
      });
      run.setClock(1_700_000);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "regressed-at-expiry" })).resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-source-finality-checkpoint-without-final-lock",
      });
      // Only the payee's expired destination leg moves; the source leg never does.
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "destination-refund"]);
      h.actions["source-lock"] = sourceLock;
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-lock-back", now: () => 1_700_101 }))
        .resolves.toMatchObject({ status: "refund-pending", reason: "destination-timeout" });
    },
  );

  test.each([
    ["no reveal", false, ["source-lock", "destination-lock", "destination-refund"]],
    ["a retained reveal", true, ["source-lock", "destination-lock", "destination-claim"]],
  ] as const)(
    "with a regressed source lock and %s, drives only a safe destination refund",
    async (_name, reveal, effects) => {
      const h = harness({
        sourceExpiry: 1_700,
        destinationExpiry: 1_200,
        mode: { "destination-claim": "pending" },
      });
      const run = runner({ adapter: h.adapter, authorizeDestinationClaim: reveal });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      await advanceCrossChainHtlc(run.nextOwner());
      if (reveal) h.actions["destination-claim"] = { state: "absent", authenticationHash: AUTH_HASH };
      delete h.actions["source-lock"];
      run.setClock(1_200_000);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "regressed-source" })).resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-source-finality-checkpoint-without-final-lock",
      });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(effects);
      expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("source-refund");
    },
  );

  test("with a regressed source lock and no reveal, never refunds the destination before its expiry", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-not-authorized",
    });
    delete h.actions["source-lock"];
    // One-millisecond leases, so that each call can probe its exact instant.
    for (const [owner, now] of [["early", 1_100_000], ["just-before-expiry", 1_199_999]] as const) {
      await expect(advanceCrossChainHtlc({ ...run.shared, owner, leaseDurationMs: 1, now: () => now }))
        .resolves.toEqual({
          status: "indeterminate",
          reason: "htlc-source-finality-checkpoint-without-final-lock",
        });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock"]);
    }
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "at-expiry", leaseDurationMs: 1, now: () => 1_200_000 }))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-source-finality-checkpoint-without-final-lock",
      });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-refund"]);
  });

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

  test.each([
    ["before", 1_499_999, "settled"],
    ["after", 1_500_001, "failed"],
  ] as const)(
    "uses source-claim finality reached %s expiry when observation is delayed",
    async (_timing, finalityReachedAt, expectedStatus) => {
      const h = harness({
        sourceExpiry: 1_500,
        destinationExpiry: 1_100,
        sourceClaimIncludedAt: 1_400_000,
        sourceClaimFinalityReachedAt: finalityReachedAt,
        sourceClaimFinalityObservedAt: 1_600_000,
      });
      const run = runner({ adapter: h.adapter });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      await advanceCrossChainHtlc(run.nextOwner());
      const broadcastRetained = h.adapter.broadcastRetained;
      h.adapter.broadcastRetained = vi.fn(async (...args) => {
        await broadcastRetained(...args);
        if (args[0].action === "source-claim") {
          h.setObservedAt(1_600_000);
          run.setClock(1_600_000);
        }
      });
      const result = await advanceCrossChainHtlc({
        ...run.nextOwner(),
        leaseDurationMs: 1_000_000,
      });
      if (expectedStatus === "settled") {
        expect(result).toMatchObject({
          status: "settled",
          settlement: {
            settlementFinality: {
              sourceExpiry: 1_500,
              finalityReachedAt: 1_499_999,
              finalityObservedAt: 1_600_000,
            },
          },
        });
      } else {
        expect(result).toEqual({
          status: "failed",
          errorClass: "settlement-atomicity",
          reason: "dest-revealed-source-unclaimed-expired",
        });
      }
    },
  );

  test.each([
    ["before", 1_499_999, "settled"],
    ["after", 1_500_001, "failed"],
  ] as const)(
    "reconciles a retained source claim that reached finality %s expiry",
    async (_timing, finalityReachedAt, expectedStatus) => {
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
      h.setObservedAt(1_600_000);
      await h.markFinal("source-claim", {
        includedAt: 1_400_000,
        finalityReachedAt,
        finalityObservedAt: 1_600_000,
      });
      run.setClock(1_600_000);
      const result = await advanceCrossChainHtlc(run.nextOwner());
      if (expectedStatus === "settled") {
        expect(result).toMatchObject({
          status: "settled",
          settlement: {
            settlementFinality: {
              sourceExpiry: 1_500,
              finalityReachedAt: 1_499_999,
              finalityObservedAt: 1_600_000,
            },
          },
        });
      } else {
        expect(result).toEqual({
          status: "failed",
          errorClass: "settlement-atomicity",
          reason: "dest-revealed-source-unclaimed-expired",
        });
      }
    },
  );

  test.each([
    ["missing", { finalityReachedAt: undefined }],
    ["non-integer", { finalityReachedAt: Number.NaN }],
    ["before inclusion", { includedAt: 1_450_000, finalityReachedAt: 1_400_000 }],
    ["after observation", { finalityReachedAt: 1_600_001 }],
  ])("fails closed on %s retained source-claim finality timing", async (_name, timing) => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const recordSettlement = vi.fn(base.recordSettlement);
    const store: CrossChainHtlcStore = { ...base, recordSettlement };
    const h = harness({
      sourceExpiry: 1_500,
      destinationExpiry: 1_100,
      mode: { "source-claim": "pending" },
    });
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    h.setObservedAt(1_600_000);
    await h.markFinal("source-claim", {
      includedAt: 1_400_000,
      finalityObservedAt: 1_600_000,
      ...timing,
    });
    run.setClock(1_600_000);
    const prepareCalls = h.prepareAction.mock.calls.length;
    const broadcastCalls = h.broadcastRetained.mock.calls.length;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-ledger-observation-unavailable",
    });
    expect(recordSettlement).not.toHaveBeenCalled();
    expect(h.prepareAction).toHaveBeenCalledTimes(prepareCalls);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcastCalls);
  });

  test("fails closed on a retained settlement without finality-reached evidence", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const h = harness();
    const run = runner({ adapter: h.adapter, store: base });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const prepareCalls = h.prepareAction.mock.calls.length;
    const broadcastCalls = h.broadcastRetained.mock.calls.length;
    const legacyStore: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        if (claimed.status !== "settled") return claimed;
        const { finalityReachedAt: _missing, ...legacyFinality } =
          claimed.settlement.settlementFinality;
        return {
          ...claimed,
          settlement: {
            ...claimed.settlement,
            settlementFinality: legacyFinality,
          },
        } as HtlcStoreClaim;
      },
    };
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store: legacyStore }))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-stored-settlement-mismatch",
      });
    expect(h.prepareAction).toHaveBeenCalledTimes(prepareCalls);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcastCalls);
  });

  test("fails closed when retained settlement finality reached after its bound expiry", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const h = harness();
    const run = runner({ adapter: h.adapter, store: base });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const prepareCalls = h.prepareAction.mock.calls.length;
    const broadcastCalls = h.broadcastRetained.mock.calls.length;
    const corruptStore: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        if (claimed.status !== "settled") return claimed;
        return {
          ...claimed,
          settlement: {
            ...claimed.settlement,
            settlementFinality: {
              ...claimed.settlement.settlementFinality,
              finalityReachedAt: 5_000_001,
              finalityObservedAt: 5_000_001,
            },
          },
        };
      },
    };
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store: corruptStore }))
      .resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-stored-settlement-mismatch",
      });
    expect(h.prepareAction).toHaveBeenCalledTimes(prepareCalls);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcastCalls);
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
    if (refund.txRef.kind !== "htlc-refund") throw new Error("expected refund reference");
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

describe("unlanded effects, unusable destination locks and operator paging", () => {
  async function toPendingReveal(options: HarnessOptions = {}) {
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" }, ...options });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    return { h, run };
  }
  const broadcastsOf = (h: ReturnType<typeof harness>, action: HtlcAction) => h.broadcastRetained.mock.calls
    .map((call) => call[0])
    .filter((prepared) => prepared.action === action);

  test("replaces a reveal authenticated absent while the claim window is open instead of rebroadcasting it", async () => {
    const { h, run } = await toPendingReveal();
    const [first] = broadcastsOf(h, "destination-claim");
    if (!first) throw new Error("expected a reveal");
    h.actions["destination-claim"] = { state: "absent", txRef: first.txRef, authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    const revealRequests = h.prepareAction.mock.calls
      .map((call) => call[0])
      .filter((request) => request.action === "destination-claim");
    expect(revealRequests).toHaveLength(2);
    expect(revealRequests[1]!.replacement).toEqual({
      attempt: 2,
      priorEffectHash: first.effectHash,
      priorTxRef: first.txRef,
      failureAuthenticationHash: AUTH_HASH,
    });
    const reveals = broadcastsOf(h, "destination-claim");
    expect(reveals.map((prepared) => prepared.txRef))
      .toEqual([refFor("destination-claim"), refFor("destination-claim", "-attempt-2")]);
    const created = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
    const retained = await run.shared.store.claim({
      ...created,
      owner: "auditor",
      now: 2_000_000,
      leaseDurationMs: 100,
    });
    expect(retained).toMatchObject({
      status: "acquired",
      destinationClaimAttemptHistory: [{
        attempt: 1,
        prepared: { effectHash: first.effectHash },
        failedObservation: { state: "absent", txRef: first.txRef, authenticationHash: AUTH_HASH },
      }],
    });
  });

  test.each([
    ["absent", "htlc-destination-claim-absent-preimage-broadcast"],
    ["failed", "htlc-destination-claim-failed-preimage-public"],
  ] as const)(
    "replaces unlanded reveals up to the cap after a first %s attempt, then raises %s",
    async (firstOutcome, reason) => {
      const { h, run } = await toPendingReveal();
      const unlandActiveReveal = (state: "absent" | "failed") => {
        const active = broadcastsOf(h, "destination-claim").at(-1);
        if (!active) throw new Error("expected a reveal");
        h.actions["destination-claim"] = { state, txRef: active.txRef, authenticationHash: AUTH_HASH };
      };
      for (let replacement = 1; replacement <= 3; replacement += 1) {
        unlandActiveReveal(replacement === 1 ? firstOutcome : "absent");
        await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
          status: "waiting",
          reason: "htlc-destination-claim-finality-pending",
        });
      }
      unlandActiveReveal("absent");
      const preparations = h.prepareAction.mock.calls.length;
      const broadcasts = h.broadcastRetained.mock.calls.length;
      for (let call = 0; call < 2; call += 1) {
        await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
          status: "operator-alert",
          reason,
          txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim", "-attempt-4")],
        });
      }
      expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
      expect(h.prepareAction.mock.calls
        .filter((call) => call[0].action === "destination-claim")
        .map((call) => call[0].replacement?.attempt)).toEqual([undefined, 2, 3, 4]);
    },
  );

  test("alerts when a broadcast reveal is authenticated absent after the claim window closed, and refunds after both expiries", async () => {
    const { h, run } = await toPendingReveal({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    h.actions["destination-claim"] = { state: "absent", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    // At the claim cutoff, then after the destination expiry and before the
    // source expiry: the payee may still claim the source with the preimage.
    for (const [owner, now] of [["at-cutoff", 1_185_000], ["destination-expired", 1_200_000]] as const) {
      await expect(advanceCrossChainHtlc({ ...run.shared, owner, now: () => now })).resolves.toEqual({
        status: "operator-alert",
        reason: "htlc-destination-claim-absent-preimage-broadcast",
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim")],
      });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "absent-after-source-expiry" }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-claim-unlanded" });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "absent-refunded", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refunded", reason: "destination-claim-unlanded" });
  });

  test("replaces a source claim authenticated absent instead of rebroadcasting it, and settles", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const [prior] = broadcastsOf(h, "source-claim");
    if (!prior) throw new Error("expected source claim");
    h.actions["source-claim"] = { state: "absent", txRef: prior.txRef, authenticationHash: AUTH_HASH };
    h.setMode("source-claim", "final");
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "settled",
      settlement: { txRefs: [
        refFor("source-lock"),
        refFor("destination-lock"),
        refFor("destination-claim"),
        refFor("source-claim", "-attempt-2"),
      ] },
    });
    const claimRequests = h.prepareAction.mock.calls
      .map((call) => call[0])
      .filter((request) => request.action === "source-claim");
    expect(claimRequests.map((request) => request.replacement)).toEqual([undefined, {
      attempt: 2,
      priorEffectHash: prior.effectHash,
      priorTxRef: prior.txRef,
      failureAuthenticationHash: AUTH_HASH,
    }]);
    expect(broadcastsOf(h, "source-claim").map((prepared) => prepared.txRef))
      .toEqual([refFor("source-claim"), refFor("source-claim", "-attempt-2")]);
  });

  test("replaces a reverting source claim at most three times, then raises an operator alert", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const failActiveClaim = () => {
      const active = broadcastsOf(h, "source-claim").at(-1);
      if (!active) throw new Error("expected a source claim");
      h.actions["source-claim"] = { state: "failed", txRef: active.txRef, authenticationHash: AUTH_HASH };
    };
    for (let replacement = 1; replacement <= 3; replacement += 1) {
      failActiveClaim();
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
        status: "settle-asymmetric",
        reason: "dest-revealed-source-unclaimed",
      });
    }
    failActiveClaim();
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    for (let call = 0; call < 2; call += 1) {
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "operator-alert",
        reason: "htlc-source-claim-replacement-limit-reached",
        txRefs: [
          refFor("source-lock"),
          refFor("destination-lock"),
          refFor("destination-claim"),
          refFor("source-claim", "-attempt-4"),
        ],
      });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    expect(h.prepareAction.mock.calls
      .filter((call) => call[0].action === "source-claim")
      .map((call) => call[0].replacement?.attempt)).toEqual([undefined, 2, 3, 4]);
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).not.toContain("source-refund");
  });

  test("alerts on retained refunds reported absent by reference, showing those legs absent and re-sending nothing", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-refund": "pending", "source-refund": "pending" },
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "refunds-sent" })).resolves.toMatchObject({
      status: "refund-pending",
      refunds: { "destination-refund": "pending", "source-refund": "pending" },
    });
    h.actions["destination-refund"] = { state: "absent", txRef: refFor("destination-refund"), authenticationHash: AUTH_HASH };
    h.actions["source-refund"] = { state: "absent", txRef: refFor("source-refund"), authenticationHash: AUTH_HASH };
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    for (const tick of [1, 2]) {
      await expect(advanceCrossChainHtlc({
        ...run.shared,
        owner: `refunds-absent-${tick}`,
        now: () => 1_700_000 + tick * 101,
      })).resolves.toEqual({
        status: "operator-alert",
        reason: "htlc-refund-absent",
        txRefs: [
          refFor("source-lock"),
          refFor("destination-lock"),
          refFor("source-refund"),
          refFor("destination-refund"),
        ],
        refunds: { "destination-refund": "absent", "source-refund": "absent" },
      });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
  });

  test("rebroadcasts retained refunds reported absent without a reference instead of alerting", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-refund": "pending", "source-refund": "pending" },
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_700_000);
    await advanceCrossChainHtlc({ ...run.shared, owner: "refunds-sent" });
    // Both were dropped before landing; the adapter reports nothing on chain for either leg.
    h.actions["destination-refund"] = { state: "absent", authenticationHash: AUTH_HASH };
    h.actions["source-refund"] = { state: "absent", authenticationHash: AUTH_HASH };
    const preparations = h.prepareAction.mock.calls.length;
    const progress = await advanceCrossChainHtlc({ ...run.shared, owner: "refunds-rebroadcast", now: () => 1_700_101 });
    expect(progress).toEqual({
      status: "refund-pending",
      reason: "destination-timeout",
      txRefs: [
        refFor("source-lock"),
        refFor("destination-lock"),
        refFor("source-refund"),
        refFor("destination-refund"),
      ],
      refunds: { "destination-refund": "pending", "source-refund": "pending" },
    });
    expect(htlcNeedsOperator(progress)).toBe(false);
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    for (const leg of ["source-refund", "destination-refund"] as const) {
      const sent = broadcastsOf(h, leg);
      expect(sent).toHaveLength(2);
      expect(sent[1]).toEqual(sent[0]);
    }
  });

  test("still drives the payer's source refund while the payee's retained refund is absent", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200, mode: { "destination-refund": "pending" } });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_200_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "destination-refund-sent" }))
      .resolves.toMatchObject({ status: "refund-pending", refunds: { "destination-refund": "pending" } });
    h.actions["destination-refund"] = { state: "absent", txRef: refFor("destination-refund"), authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-refund-due", now: () => 1_700_000 }))
      .resolves.toMatchObject({
        status: "operator-alert",
        reason: "htlc-refund-absent",
        refunds: { "destination-refund": "absent", "source-refund": "final" },
      });
    expect(broadcastsOf(h, "destination-refund")).toHaveLength(1);
    expect(broadcastsOf(h, "source-refund")).toHaveLength(1);
  });

  test("alerts on an absent source refund before any destination lock", async () => {
    const h = harness({ sourceLockTerms: { amountBaseUnits: "1" }, mode: { "source-refund": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    run.setClock(5_000_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-refund-sent" })).resolves.toMatchObject({
      status: "refund-pending",
      reason: "source-lock-terms-mismatch",
      refunds: { "source-refund": "pending" },
    });
    h.actions["source-refund"] = { state: "absent", txRef: refFor("source-refund"), authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-refund-absent", now: () => 5_000_101 }))
      .resolves.toEqual({
        status: "operator-alert",
        reason: "htlc-refund-absent",
        txRefs: [refFor("source-lock"), refFor("source-refund")],
        refunds: { "source-refund": "absent" },
      });
    expect(broadcastsOf(h, "source-refund")).toHaveLength(1);
  });

  test("resends a retained source refund whose broadcast failed while it reads absent without a reference", async () => {
    const h = harness({ sourceExpiry: 1_700, sourceLockTerms: { amountBaseUnits: "1" } });
    let rpcDown = true;
    const broadcast = h.adapter.broadcastRetained;
    const sends = vi.fn<CrossChainHtlcAdapter["broadcastRetained"]>(async (prepared, fence) => {
      if (prepared.action === "source-refund" && rpcDown) throw new Error("RPC 503 on send");
      await broadcast(prepared, fence);
    });
    h.adapter.broadcastRetained = sends;
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    // Before and after the refund is prepared, the adapter reports nothing on chain for the leg.
    h.actions["source-refund"] = { state: "absent", authenticationHash: AUTH_HASH };
    const progress: CrossChainHtlcProgress[] = [];
    for (const [owner, now] of [["refund-503", 1_700_000], ["rpc-still-down", 1_700_101]] as const) {
      progress.push(await advanceCrossChainHtlc({ ...run.shared, owner, now: () => now }));
    }
    rpcDown = false;
    for (const [owner, now] of [["rpc-recovered", 1_700_202], ["refunded", 1_700_303]] as const) {
      progress.push(await advanceCrossChainHtlc({ ...run.shared, owner, now: () => now }));
    }
    const reason = "source-lock-terms-mismatch";
    expect(progress).toEqual([
      { status: "refund-pending", reason, txRefs: [refFor("source-lock")], refunds: { "source-refund": "uncertain" } },
      { status: "refund-pending", reason, txRefs: [refFor("source-lock")], refunds: { "source-refund": "uncertain" } },
      {
        status: "refund-pending",
        reason,
        txRefs: [refFor("source-lock"), refFor("source-refund")],
        refunds: { "source-refund": "final" },
      },
      {
        status: "refunded",
        reason,
        txRefs: [refFor("source-lock"), refFor("source-refund")],
        refunds: { "source-refund": "final" },
      },
    ]);
    expect(progress.map((item) => htlcNeedsOperator(item))).toEqual([false, false, false, false]);
    // One refund, prepared once and sent three times with the same retained bytes.
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "source-refund"]);
    const refundSends = sends.mock.calls.map((call) => call[0]).filter((sent) => sent.action === "source-refund");
    expect(refundSends).toHaveLength(3);
    expect(new Set(refundSends.map((sent) => sent.effectHash)).size).toBe(1);
    expect(new Set(refundSends.map((sent) => sent.signedPayloadBase64)).size).toBe(1);
  });

  test.each([
    ["beyond the safe-integer range", 10_000_000_000_000],
    ["at its own inclusion", 1_000],
    ["before its own inclusion", 0],
  ] as const)(
    "never reveals into a destination lock whose expiry is %s and refunds the source at its expiry",
    async (_name, destinationExpiry) => {
      const h = harness({ sourceExpiry: 5_000, destinationExpiry });
      const run = runner({ adapter: h.adapter });
      await advanceCrossChainHtlc(run.shared);
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "waiting",
        reason: "htlc-destination-lock-finality-pending",
      });
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
        status: "refund-pending",
        reason: "destination-lock-expiry-invalid",
        refunds: { "source-refund": "waiting" },
      });
      run.setClock(5_000_000);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "after-source-expiry" })).resolves.toMatchObject({
        status: "refund-pending",
        reason: "destination-lock-expiry-invalid",
        refunds: { "source-refund": "final" },
      });
      const effects = h.prepareAction.mock.calls.map((call) => call[0].action);
      expect(effects).not.toContain("destination-claim");
      expect(effects).toContain("source-refund");
    },
  );

  test("keeps a regressed source lock resumable beside a destination lock whose expiry is out of range", async () => {
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 10_000_000_000_000 });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    delete h.actions["source-lock"];
    run.setClock(5_000_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-regressed" })).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-source-finality-checkpoint-without-final-lock",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "destination-lock"]);
  });

  test("settles from the reveal checkpoint when the source claim is final but the reveal is unreported", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "settle-asymmetric" });
    const reveal = h.actions["destination-claim"];
    delete h.actions["destination-claim"];
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "settle-asymmetric" });
    await h.markFinal("source-claim");
    const settled = {
      status: "settled",
      settlement: {
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")],
        settlementFinality: { model: "htlc-reveal", sourceExpiry: 5_000 },
      },
    };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject(settled);
    h.actions["destination-claim"] = reveal;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject(settled);
  });

  test.each([
    ["absent", 1_200, "operator-alert", "htlc-refund-absent"],
    ["failed", 1_200, "refund-stalled", "destination-timeout"],
    ["failed", 1_680, "refund-stalled", "destination-expiry-margin-insufficient"],
  ] as const)(
    "with a regressed source lock, never re-sends a destination refund authenticated %s and pages (expiry %i)",
    async (refundState, destinationExpiry, status, reason) => {
      const h = harness({ sourceExpiry: 1_700, destinationExpiry, mode: { "destination-refund": "pending" } });
      const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      run.setClock(destinationExpiry * 1_000);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "destination-refund-sent" }))
        .resolves.toMatchObject({ status: "refund-pending", refunds: { "destination-refund": "pending" } });
      const [refund] = broadcastsOf(h, "destination-refund");
      if (!refund) throw new Error("expected a destination refund");
      h.actions["destination-refund"] = refundState === "absent"
        ? { state: "absent", txRef: refund.txRef, authenticationHash: AUTH_HASH }
        : { state: "failed", txRef: refund.txRef, authenticationHash: AUTH_HASH };
      // The checkpointed source lock is no longer reported final.
      delete h.actions["source-lock"];
      for (const tick of [1, 2]) {
        const progress = await advanceCrossChainHtlc({
          ...run.shared,
          owner: `source-regressed-${tick}`,
          now: () => destinationExpiry * 1_000 + tick * 101,
        });
        expect(progress).toMatchObject({
          status,
          reason,
          refunds: { "destination-refund": refundState, "source-refund": "waiting" },
        });
        expect(htlcNeedsOperator(progress)).toBe(true);
      }
      expect(broadcastsOf(h, "destination-refund")).toHaveLength(1);
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "destination-refund"]);
    },
  );

  test("with a regressed source lock, resends a destination refund reported absent without a reference", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200, mode: { "destination-refund": "pending" } });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_200_000);
    await advanceCrossChainHtlc({ ...run.shared, owner: "destination-refund-sent" });
    h.actions["destination-refund"] = { state: "absent", authenticationHash: AUTH_HASH };
    delete h.actions["source-lock"];
    const progress = await advanceCrossChainHtlc({ ...run.shared, owner: "source-regressed", now: () => 1_200_101 });
    expect(progress).toEqual({
      status: "indeterminate",
      reason: "htlc-source-finality-checkpoint-without-final-lock",
    });
    expect(htlcNeedsOperator(progress)).toBe(false);
    const sent = broadcastsOf(h, "destination-refund");
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-refund"]);
  });

  test("reads a refund observed absent in the call that first sends it as pending, then alerts", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-refund": "pending", "source-refund": "pending" },
    });
    // The observation lags the broadcast: the new source refund still reads absent.
    const broadcast = h.adapter.broadcastRetained;
    h.adapter.broadcastRetained = vi.fn<CrossChainHtlcAdapter["broadcastRetained"]>(async (prepared, fence) => {
      await broadcast(prepared, fence);
      if (prepared.action === "source-refund") {
        h.actions["source-refund"] = { state: "absent", txRef: prepared.txRef, authenticationHash: AUTH_HASH };
      }
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "refunds-sent" })).resolves.toMatchObject({
      status: "refund-pending",
      reason: "destination-timeout",
      refunds: { "destination-refund": "pending", "source-refund": "pending" },
    });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "still-absent", now: () => 1_700_101 }))
      .resolves.toMatchObject({
        status: "operator-alert",
        reason: "htlc-refund-absent",
        refunds: { "destination-refund": "pending", "source-refund": "absent" },
      });
    expect(broadcastsOf(h, "source-refund")).toHaveLength(1);
  });

  test("prepares the first refund of a leg the adapter reports absent before any refund was prepared", async () => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-refund": "pending", "source-refund": "pending" },
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    h.actions["destination-refund"] = { state: "absent", authenticationHash: AUTH_HASH };
    h.actions["source-refund"] = { state: "absent", authenticationHash: AUTH_HASH };
    run.setClock(1_700_000);
    const progress = await advanceCrossChainHtlc({ ...run.shared, owner: "refunds-due" });
    expect(progress).toMatchObject({
      status: "refund-pending",
      refunds: { "destination-refund": "pending", "source-refund": "pending" },
    });
    expect(htlcNeedsOperator(progress)).toBe(false);
    expect(broadcastsOf(h, "destination-refund")).toHaveLength(1);
    expect(broadcastsOf(h, "source-refund")).toHaveLength(1);
  });

  test.each([
    ["at once", 1_000_505],
    ["only after the destination expiry", 1_500_101],
  ] as const)(
    "settles when a reveal replaced on a premature absent lands after all, observed %s, and never refunds",
    async (_when, landedAt) => {
      const { h, run } = await toPendingReveal();
      const [first] = broadcastsOf(h, "destination-claim");
      if (!first || first.txRef.kind !== "htlc-reveal") throw new Error("expected a reveal");
      // A lagging node reports the first reveal absent while it is still in a mempool.
      h.actions["destination-claim"] = { state: "absent", txRef: first.txRef, authenticationHash: AUTH_HASH };
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "waiting",
        reason: "htlc-destination-claim-finality-pending",
      });
      expect(broadcastsOf(h, "destination-claim").map((prepared) => prepared.txRef))
        .toEqual([refFor("destination-claim"), refFor("destination-claim", "-attempt-2")]);
      // The first reveal lands, so the payer holds the destination funds and the
      // replacement reverts; the adapter reports the attempt that landed.
      h.actions["destination-claim"] = {
        state: "final",
        txRef: first.txRef,
        finalityObservedAt: landedAt,
        revealedPreimageHex: PREIMAGE_HEX,
        authenticationHash: AUTH_HASH,
      };
      h.setMode("source-claim", "pending");
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "first-reveal-landed", now: () => landedAt }))
        .resolves.toEqual({
          status: "settle-asymmetric",
          reason: "dest-revealed-source-unclaimed",
          recoveryDeadline: 5_000,
          // The reveal that landed is named, not the replacement that reverted.
          txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")],
          finalityObservedAt: landedAt,
        });
      await h.markFinal("source-claim");
      const settled = {
        status: "settled",
        settlement: {
          txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")],
        },
      };
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-claimed", now: () => landedAt + 101 }))
        .resolves.toMatchObject(settled);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "after-both-expiries", now: () => 5_000_101 }))
        .resolves.toMatchObject(settled);
      const effects = h.prepareAction.mock.calls.map((call) => call[0].action);
      expect(effects).not.toContain("source-refund");
      expect(effects).not.toContain("destination-refund");
      expect(effects.filter((action) => action === "destination-claim")).toHaveLength(2);
    },
  );

  test("names the earlier reveal that landed when the payee's source claim misses the source expiry", async () => {
    const { h, run } = await toPendingReveal();
    const [first] = broadcastsOf(h, "destination-claim");
    if (!first || first.txRef.kind !== "htlc-reveal") throw new Error("expected a reveal");
    h.actions["destination-claim"] = { state: "absent", txRef: first.txRef, authenticationHash: AUTH_HASH };
    await advanceCrossChainHtlc(run.nextOwner());
    h.actions["destination-claim"] = {
      state: "final",
      txRef: first.txRef,
      finalityObservedAt: 1_000_505,
      revealedPreimageHex: PREIMAGE_HEX,
      authenticationHash: AUTH_HASH,
    };
    h.setMode("source-claim", "pending");
    await advanceCrossChainHtlc({ ...run.shared, owner: "first-reveal-landed", now: () => 1_000_505 });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-expired", now: () => 5_000_000 }))
      .resolves.toEqual({
        status: "operator-alert",
        reason: "htlc-source-claim-missed-after-reveal",
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")],
      });
  });

  test.each([
    ["names no attempt", "htlc-destination-claim-absent-unbound"],
    ["names a replaced attempt", "htlc-destination-claim-absent-unbound"],
    ["names a transaction the core never prepared", "htlc-ledger-observation-unavailable"],
  ] as const)(
    "never replaces a reveal on an absent that %s",
    async (variant, reason) => {
      const { h, run } = await toPendingReveal();
      const [first] = broadcastsOf(h, "destination-claim");
      if (!first) throw new Error("expected a reveal");
      if (variant === "names a replaced attempt") {
        h.actions["destination-claim"] = { state: "failed", txRef: first.txRef, authenticationHash: AUTH_HASH };
        await advanceCrossChainHtlc(run.nextOwner());
        expect(broadcastsOf(h, "destination-claim")).toHaveLength(2);
        h.actions["destination-claim"] = { state: "absent", txRef: first.txRef, authenticationHash: AUTH_HASH };
      } else {
        h.actions["destination-claim"] = variant === "names no attempt"
          ? { state: "absent", authenticationHash: AUTH_HASH }
          : { state: "absent", txRef: refFor("destination-claim", "-elsewhere"), authenticationHash: AUTH_HASH };
      }
      const preparations = h.prepareAction.mock.calls.length;
      const broadcasts = h.broadcastRetained.mock.calls.length;
      for (let call = 0; call < 2; call += 1) {
        await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({ status: "indeterminate", reason });
      }
      expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    },
  );

  test("never replaces a source claim on an absent that does not name it", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    h.actions["source-claim"] = { state: "absent", authenticationHash: AUTH_HASH };
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-source-claim-absent-unbound",
    });
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
  });

  test("refunds nothing after both expiries on a reveal absent that does not name the active attempt", async () => {
    const { h, run } = await toPendingReveal({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    h.actions["destination-claim"] = { state: "absent", authenticationHash: AUTH_HASH };
    run.setClock(1_700_000);
    const progress = await advanceCrossChainHtlc({ ...run.shared, owner: "unbound-absent-after-expiries" });
    expect(progress).toEqual({ status: "waiting", reason: "htlc-destination-claim-unresolved-after-expiry" });
    expect(htlcNeedsOperator(progress)).toBe(true);
    const effects = h.prepareAction.mock.calls.map((call) => call[0].action);
    expect(effects).not.toContain("source-refund");
    expect(effects).not.toContain("destination-refund");
  });

  test("fails closed when the active reveal is reported final after a replaced one was checkpointed", async () => {
    const { h, run } = await toPendingReveal();
    const [first] = broadcastsOf(h, "destination-claim");
    if (!first || first.txRef.kind !== "htlc-reveal") throw new Error("expected a reveal");
    h.actions["destination-claim"] = { state: "absent", txRef: first.txRef, authenticationHash: AUTH_HASH };
    await advanceCrossChainHtlc(run.nextOwner());
    h.actions["destination-claim"] = {
      state: "final",
      txRef: first.txRef,
      finalityObservedAt: 1_000_000,
      revealedPreimageHex: PREIMAGE_HEX,
      authenticationHash: AUTH_HASH,
    };
    h.setMode("source-claim", "pending");
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "settle-asymmetric" });
    // Only one reveal can claim the lock, so the replacement final as well
    // contradicts the checkpoint of the first.
    const second = broadcastsOf(h, "destination-claim")[1];
    if (!second || second.txRef.kind !== "htlc-reveal") throw new Error("expected a replacement reveal");
    h.actions["destination-claim"] = {
      state: "final",
      txRef: second.txRef,
      finalityObservedAt: 1_000_000,
      revealedPreimageHex: PREIMAGE_HEX,
      authenticationHash: AUTH_HASH,
    };
    await h.markFinal("source-claim");
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-reveal-checkpoint-conflict",
    });
  });

  test.each([
    ["failed", { state: "failed", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH }],
    ["pending", { state: "pending", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH }],
    ["absent", { state: "absent", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH }],
    ["absent, naming no attempt", { state: "absent", authenticationHash: AUTH_HASH }],
  ] as const)(
    "fails closed instead of settling when a checkpointed reveal is reported %s",
    async (_state, reveal) => {
      const h = harness({ mode: { "source-claim": "pending" } });
      const run = runner({ adapter: h.adapter });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      await advanceCrossChainHtlc(run.nextOwner());
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "settle-asymmetric" });
      h.actions["destination-claim"] = reveal;
      await h.markFinal("source-claim");
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "failed",
        errorClass: "permanent",
        reason: "htlc-reveal-checkpoint-contradicted",
      });
    },
  );

  test.each(["pending", "unreported", "reported absent without naming it"] as const)(
    "pages on a retained reveal still %s after the claim cutoff, before both expiries pass",
    async (variant) => {
      const { h, run } = await toPendingReveal({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
      if (variant === "unreported") delete h.actions["destination-claim"];
      if (variant === "reported absent without naming it") {
        h.actions["destination-claim"] = { state: "absent", authenticationHash: AUTH_HASH };
      }
      const preparations = h.prepareAction.mock.calls.length;
      const broadcasts = h.broadcastRetained.mock.calls.length;
      // The claim cutoff is the destination expiry less its 15 s finality budget.
      for (const now of [1_185_000, 1_199_999, 1_200_000, 1_699_999]) {
        const progress = await advanceCrossChainHtlc({ ...run.shared, owner: `at-${now}`, leaseDurationMs: 1, now: () => now });
        expect(progress).toEqual({ status: "waiting", reason: "htlc-destination-claim-unresolved-after-cutoff" });
        expect(htlcNeedsOperator(progress)).toBe(true);
      }
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "both-expired", leaseDurationMs: 1, now: () => 1_700_000 }))
        .resolves.toEqual({ status: "waiting", reason: "htlc-destination-claim-unresolved-after-expiry" });
      expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    },
  );

  test("treats a destination expiry far below the safe-integer range as long passed", async () => {
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: -10_000_000_000_000 });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "refund-pending",
      reason: "destination-lock-expiry-invalid",
      refunds: { "destination-refund": "final", "source-refund": "waiting" },
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-refund"]);
  });

  test("refuses to create the volatile in-memory store without an explicit acknowledgement", () => {
    for (const options of [undefined, {}, { acknowledgeVolatile: false }, { acknowledgeVolatile: "true" }]) {
      expect(() => createInMemoryCrossChainHtlcStore(options as never)).toThrow(TypeError);
      expect(() => createInMemoryCrossChainHtlcStore(options as never))
        .toThrow(/loses all state on restart, which would double-send/);
    }
    expect(createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true }).claim).toBeTypeOf("function");
  });

  const refs = [refFor("source-lock")];
  test.each([
    { status: "operator-alert", reason: "htlc-source-claim-missed-after-reveal", txRefs: refs },
    { status: "operator-alert", reason: "htlc-source-claim-replacement-limit-reached", txRefs: refs },
    { status: "operator-alert", reason: "htlc-destination-claim-failed-preimage-public", txRefs: refs },
    { status: "operator-alert", reason: "htlc-destination-claim-absent-preimage-broadcast", txRefs: refs },
    { status: "operator-alert", reason: "htlc-salt-missing", txRefs: [] },
    { status: "operator-alert", reason: "htlc-salt-mismatch", txRefs: [] },
    { status: "operator-alert", reason: "htlc-refund-absent", txRefs: refs, refunds: { "source-refund": "absent" } },
    { status: "refund-stalled", reason: "destination-timeout", txRefs: refs, refunds: { "source-refund": "failed" } },
    { status: "waiting", reason: "htlc-destination-claim-unresolved-after-cutoff" },
    { status: "waiting", reason: "htlc-destination-claim-unresolved-after-expiry" },
    { status: "failed", errorClass: "permanent", reason: "htlc-final-claim-chain-incomplete" },
  ] satisfies CrossChainHtlcProgress[])("pages an operator on $status $reason", (progress) => {
    expect(htlcNeedsOperator(progress)).toBe(true);
  });

  test.each([
    { status: "waiting", reason: "htlc-destination-claim-finality-pending" },
    { status: "waiting", reason: "htlc-destination-claim-cutoff-reached" },
    { status: "indeterminate", reason: "htlc-adapter-lock-observation-invalid" },
    { status: "refund-pending", reason: "destination-lock-expiry-invalid", txRefs: refs, refunds: { "source-refund": "pending" } },
    { status: "refunded", reason: "destination-timeout", txRefs: refs, refunds: { "source-refund": "final" } },
    {
      status: "settle-asymmetric",
      reason: "dest-revealed-source-unclaimed",
      recoveryDeadline: 5_000,
      txRefs: refs,
      finalityObservedAt: 1_000,
    },
  ] satisfies CrossChainHtlcProgress[])("does not page on $status $reason", (progress) => {
    expect(htlcNeedsOperator(progress)).toBe(false);
  });
});

describe("source-finality checkpoint store contract", () => {
  test("rejects destination-lock persistence without the exact retained checkpoint", async () => {
    const { intent, secrets } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
    const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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

describe("source-claim finality settlement store contract", () => {
  test("rejects post-expiry and wrong-expiry writes but preserves exact idempotent timing", async () => {
    const fixture = await sourceClaimStoreFixture({ sourceExpiry: 5_000 });
    const fence = {
      settlementKey: fixture.intent.settlementKey,
      bindingHash: fixture.intent.bindingHash,
      owner: fixture.lease.owner,
      generation: fixture.lease.generation,
    };
    const settlement = (
      finalityReachedAt: number,
      sourceExpiry = 5_000,
    ): Readonly<CrossChainHtlcSettlement> => ({
      txRefs: [
        refFor("source-lock"),
        refFor("destination-lock"),
        refFor("destination-claim"),
        refFor("source-claim"),
      ],
      paymentAmount: { amount: fixture.intent.amount, currency: fixture.intent.currency },
      settlementFinality: {
        model: "htlc-reveal",
        sourceExpiry,
        finalityReachedAt,
        finalityObservedAt: 5_100_000,
      },
      authenticationHash: AUTH_HASH,
    });

    await expect(fixture.store.recordSettlement({
      ...fence,
      settlement: settlement(5_000_001),
    })).resolves.toEqual({ status: "corrupt", reason: "htlc-settlement-invalid" });
    await expect(fixture.store.recordSettlement({
      ...fence,
      settlement: settlement(4_999_999, 5_001),
    })).resolves.toEqual({
      status: "conflict",
      reason: "htlc-settlement-source-expiry-mismatch",
    });

    const valid = settlement(4_999_999);
    await expect(fixture.store.recordSettlement({ ...fence, settlement: valid }))
      .resolves.toEqual({ status: "recorded" });
    await expect(fixture.store.recordSettlement({ ...fence, settlement: valid }))
      .resolves.toEqual({ status: "existing" });
  });
});

async function destinationClaimStoreFixture(options: {
  leaseDurationMs?: number;
  sourceExpiry?: number;
} = {}) {
  const { intent, secrets } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
  const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
  const claimed = await store.claim({
    intent,
    secrets,
    owner: "direct-owner",
    now: 1_000,
    leaseDurationMs: options.leaseDurationMs ?? 100,
  });
  if (claimed.status !== "acquired") throw new Error("fixture lease not acquired");
  const fence = {
    settlementKey: intent.settlementKey,
    bindingHash: intent.bindingHash,
    owner: claimed.lease.owner,
    generation: claimed.lease.generation,
  };
  const sourceLock = preparedFor(intent, "source-lock");
  await store.recordPrepared({ ...fence, prepared: sourceLock });
  await store.recordSourceFinality({
    ...fence,
    checkpoint: {
      sourceLockEffectHash: sourceLock.effectHash,
      sourceLockTxRef: sourceLock.txRef as Extract<HtlcTxRef, { kind: "htlc-lock" }>,
      includedAt: 1_000,
      sourceExpiry: options.sourceExpiry ?? 5_000,
      finalityObservedAt: 1_000,
      authenticationHash: AUTH_HASH,
    },
  });
  const prior = preparedFor(intent, "destination-claim");
  const recorded = await store.recordPrepared({ ...fence, prepared: prior });
  if (recorded.status !== "recorded") throw new Error("fixture reveal not recorded");
  const failed = (prepared: Readonly<HtlcPreparedAction>) => ({
    state: "failed" as const,
    txRef: prepared.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
    authenticationHash: AUTH_HASH,
  });
  const replace = (
    from: Readonly<HtlcPreparedAction>,
    to: Readonly<HtlcPreparedAction>,
    now = 1_050,
  ) => store.replacePreparedDestinationClaim({
    ...fence,
    now,
    priorEffectHash: from.effectHash,
    priorTxRef: from.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
    failedObservation: failed(from),
    replacement: to,
  });
  return { store, intent, secrets, fence, prior, failed, replace };
}

describe("destination-claim replacement store contract", () => {
  test("swaps only the stored failed reveal, up to the cap, and keeps the history on takeover", async () => {
    const fixture = await destinationClaimStoreFixture();
    const attempt = (n: number) => preparedFor(fixture.intent, "destination-claim", `-attempt-${n}`);
    await expect(fixture.store.replacePreparedDestinationClaim({
      ...fixture.fence,
      generation: fixture.fence.generation + 1,
      now: 1_050,
      priorEffectHash: fixture.prior.effectHash,
      priorTxRef: fixture.prior.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
      failedObservation: fixture.failed(fixture.prior),
      replacement: attempt(2),
    })).resolves.toEqual({ status: "stale", reason: "stale-lease" });
    await expect(fixture.replace(attempt(9), attempt(2))).resolves.toEqual({
      status: "conflict",
      reason: "htlc-destination-claim-replacement-prior-mismatch",
    });
    await expect(fixture.replace(fixture.prior, preparedFor(fixture.intent, "source-claim", "-x")))
      .resolves.toEqual({ status: "corrupt", reason: "htlc-destination-claim-replacement-invalid" });
    const { effectHash: _effect, ...attemptUnsigned } = attempt(2);
    const sameRefUnsigned = { ...attemptUnsigned, txRef: fixture.prior.txRef };
    await expect(fixture.replace(fixture.prior, {
      ...sameRefUnsigned,
      effectHash: sha256Hex(canonicalize(sameRefUnsigned)),
    })).resolves.toEqual({ status: "conflict", reason: "htlc-destination-claim-replacement-not-fresh" });

    await expect(fixture.replace(fixture.prior, attempt(2))).resolves.toEqual({ status: "recorded" });
    // The stored reveal is now attempt 2: a second swap of the original is stale.
    await expect(fixture.replace(fixture.prior, attempt(3))).resolves.toEqual({
      status: "conflict",
      reason: "htlc-destination-claim-replacement-prior-mismatch",
    });
    await expect(fixture.replace(attempt(2), fixture.prior)).resolves.toEqual({
      status: "conflict",
      reason: "htlc-destination-claim-replacement-reuses-history",
    });
    await expect(fixture.replace(attempt(2), attempt(3))).resolves.toEqual({ status: "recorded" });
    await expect(fixture.replace(attempt(3), attempt(4))).resolves.toEqual({ status: "recorded" });
    await expect(fixture.replace(attempt(4), attempt(5))).resolves.toEqual({
      status: "conflict",
      reason: "htlc-destination-claim-replacement-limit",
    });
    const takeover = await fixture.store.claim({
      intent: fixture.intent,
      secrets: fixture.secrets,
      owner: "takeover-owner",
      now: 1_101,
      leaseDurationMs: 100,
    });
    expect(takeover).toMatchObject({
      status: "acquired",
      prepared: [{ action: "source-lock" }, { effectHash: attempt(4).effectHash }],
      destinationClaimAttemptHistory: [
        { attempt: 1, prepared: { effectHash: fixture.prior.effectHash }, replacementEffectHash: attempt(2).effectHash },
        { attempt: 2, prepared: { effectHash: attempt(2).effectHash }, replacementEffectHash: attempt(3).effectHash },
        { attempt: 3, prepared: { effectHash: attempt(3).effectHash }, replacementEffectHash: attempt(4).effectHash },
      ],
    });
  });

  test("rejects a replacement once the caller's lease has expired", async () => {
    // The fixture's lease runs from 1_000 ms for 100 ms.
    const fixture = await destinationClaimStoreFixture();
    const replacement = preparedFor(fixture.intent, "destination-claim", "-attempt-2");
    await expect(fixture.replace(fixture.prior, replacement, 1_100)).resolves.toEqual({
      status: "stale",
      reason: "stale-lease",
    });
    await expect(fixture.replace(fixture.prior, replacement, 1_099)).resolves.toEqual({ status: "recorded" });
  });

  test("rejects a replacement after the source-recovery cutoff, a final reveal or a refund", async () => {
    // Source expiry 40 s, so the source-recovery cutoff (40 s - 20 s - 10 s) is 10_000 ms.
    const expired = await destinationClaimStoreFixture({ leaseDurationMs: 20_000, sourceExpiry: 40 });
    const late = preparedFor(expired.intent, "destination-claim", "-attempt-2");
    await expect(expired.replace(expired.prior, late, 9_999)).resolves.toEqual({ status: "recorded" });
    const second = preparedFor(expired.intent, "destination-claim", "-attempt-3");
    await expect(expired.replace(late, second, 10_000)).resolves.toEqual({
      status: "conflict",
      reason: "htlc-destination-claim-replacement-expired",
    });

    const revealed = await destinationClaimStoreFixture();
    await revealed.store.recordRevealFinal({
      ...revealed.fence,
      checkpoint: {
        revealTxRef: revealed.prior.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
        sourceExpiry: 5_000,
        finalityObservedAt: 1_000,
        authenticationHash: AUTH_HASH,
      },
    });
    await expect(revealed.replace(
      revealed.prior,
      preparedFor(revealed.intent, "destination-claim", "-attempt-2"),
    )).resolves.toEqual({ status: "conflict", reason: "htlc-destination-claim-replacement-after-reveal" });

    const refunded = await destinationClaimStoreFixture();
    await refunded.store.recordPrepared({
      ...refunded.fence,
      prepared: preparedFor(refunded.intent, "source-refund"),
    });
    await expect(refunded.replace(
      refunded.prior,
      preparedFor(refunded.intent, "destination-claim", "-attempt-2"),
    )).resolves.toEqual({ status: "conflict", reason: "htlc-destination-claim-replacement-after-refund" });
  });
});

describe("source-claim replacement store contract", () => {
  test("records failed or absent attempts and rejects a fourth replacement", async () => {
    const { store, intent, lease, prior } = await sourceClaimStoreFixture();
    let active = prior;
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      const replacement = preparedFor(intent, "source-claim", `-attempt-${attempt}`);
      const result = await store.replacePreparedSourceClaim({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: lease.owner,
        generation: lease.generation,
        now: 1_050,
        priorEffectHash: active.effectHash,
        priorTxRef: active.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
        failedObservation: {
          state: attempt % 2 === 0 ? "absent" : "failed",
          txRef: active.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
          authenticationHash: AUTH_HASH,
        },
        replacement,
      });
      if (attempt <= 4) {
        expect(result).toEqual({ status: "recorded" });
        active = replacement;
      } else {
        expect(result).toEqual({ status: "conflict", reason: "htlc-source-claim-replacement-limit" });
      }
    }
  });

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
      authority({ jobId: RESERVATION_JOB_ID }),
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
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
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
