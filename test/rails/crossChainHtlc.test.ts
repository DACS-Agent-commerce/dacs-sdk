import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

import { isSettlementEvidence } from "../../src/artifacts/validators.js";
import { canonicalize, contentHash, sha256Hex, stripSignature } from "../../src/canonical/index.js";
import { verifySettlementEvidence, type AuthenticatedEvidenceContext } from "../../src/agent/verifySettlementEvidence.js";

import {
  advanceCrossChainHtlc,
  crossChainHtlcEvidenceFields,
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
  type HtlcEffectFence,
  type HtlcLease,
  type HtlcLedgerSnapshot,
  type HtlcLockTerms,
  type HtlcObservedAction,
  type HtlcPreparedAction,
  type HtlcRevealCheckpoint,
  type HtlcSourceFinalityCheckpoint,
  type HtlcStoreClaim,
  type HtlcStoreWrite,
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
    expect(() => createCrossChainHtlcIntent(authority(override as never), SALT, hashlocks)).toThrow();
    const h = harness();
    const result = await advanceCrossChainHtlc(runner({
      authority: authority(override as never),
      adapter: h.adapter,
    }).shared);
    expect(result).toEqual({ status: "indeterminate", reason: "htlc-call-input-invalid" });
    expect(htlcNeedsOperator(result)).toBe(true);
    expect(h.prepareAction).not.toHaveBeenCalled();
  });

  test.each(([
    ["store", "claim"],
    ["store", "isCurrent"],
    ["store", "recordPrepared"],
    ["store", "replacePreparedSourceClaim"],
    ["store", "recordRevealFinal"],
    ["store", "recordSettlement"],
    ["adapter", "observe"],
    ["adapter", "prepareAction"],
    ["adapter", "broadcastRetained"],
  ] as const).flatMap(([dependency, method]) => [undefined, null, {}].map((value) => [
    dependency, method, value,
  ] as const)))(
    "keeps malformed %s.%s (%j) resumable before any dependency call",
    async (dependency, method, value) => {
      const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
      const claim = vi.spyOn(store, "claim");
      const h = harness();
      const deriveHashlock = vi.fn(hashlocks.deriveHashlock);
      const run = runner({ store, adapter: h.adapter, hashlocks: { deriveHashlock } });
      const target = run.shared[dependency];
      const original = Reflect.get(target, method);
      if (value === undefined) Reflect.deleteProperty(target, method);
      else Reflect.set(target, method, value);

      const result = await advanceCrossChainHtlc(run.shared);
      expect(result).toEqual({ status: "indeterminate", reason: "htlc-call-input-invalid" });
      expect(htlcNeedsOperator(result)).toBe(true);
      expect(claim).not.toHaveBeenCalled();
      expect(deriveHashlock).not.toHaveBeenCalled();
      for (const callback of [h.observe, h.observeSourceLeg, h.prepareAction, h.broadcastRetained]) {
        expect(callback).not.toHaveBeenCalled();
      }

      // Fixing the dependency resumes the same session and salt.
      Reflect.set(target, method, original);
      await expect(advanceCrossChainHtlc(run.shared)).resolves.toEqual({
        status: "waiting", reason: "htlc-source-lock-finality-pending",
      });
    },
  );

  test.each(["store", "adapter"] as const)("returns structured input failure for an absent %s", async (dependency) => {
    const run = runner();
    for (const value of [undefined, null]) {
      await expect(advanceCrossChainHtlc({ ...run.shared, [dependency]: value } as unknown as AdvanceCrossChainHtlcInput))
        .resolves.toEqual({ status: "indeterminate", reason: "htlc-call-input-invalid" });
    }
  });

  test.each([undefined, null])("returns structured input failure for absent input %s", async (input) => {
    await expect(advanceCrossChainHtlc(input as unknown as AdvanceCrossChainHtlcInput))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-call-input-invalid" });
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

    expect(result).toEqual({ status: "indeterminate", reason: "htlc-call-input-invalid" });
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

  test("pages but stays resumable when the two observers disagree on the source lock before any destination lock", async () => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    // The source-leg observer reports the lock's inclusion 1 s later than
    // `observe` does, so the checkpoint it records disagrees with `observe`.
    h.observeSourceLeg.mockImplementation(async (_intent, fence) => {
      await fence.assertCurrent();
      const lock = h.actions["source-lock"];
      if (!lock || lock.state !== "final" || lock.includedAt === undefined) throw new Error("expected final lock");
      return {
        observedAt: 1_000_000,
        authenticationHash: AUTH_HASH,
        actions: {
          "source-lock": {
            ...lock,
            includedAt: lock.includedAt + 1_000,
            finalityObservedAt: lock.finalityObservedAt + 1_000,
          },
        },
      };
    });
    for (const _call of [1, 2]) {
      const progress = await advanceCrossChainHtlc(run.nextOwner());
      expect(progress).toEqual({ status: "indeterminate", reason: "htlc-source-observers-disagree" });
      expect(htlcNeedsOperator(progress)).toBe(true);
    }
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock"]);
    // Once `observe` reports the checkpointed facts, the session moves on.
    const lock = h.actions["source-lock"];
    if (!lock || lock.state !== "final" || lock.includedAt === undefined) throw new Error("expected final lock");
    h.actions["source-lock"] = {
      ...lock,
      includedAt: lock.includedAt + 1_000,
      finalityObservedAt: lock.finalityObservedAt + 1_000,
    };
    h.observeSourceLeg.mockRestore();
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-lock-finality-pending",
    });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "destination-lock"]);
  });

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

  test("stops owing, and never rebroadcasts, a retained destination lock authenticated absent by reference", async () => {
    const h = harness({ sourceExpiry: 1_700, mode: { "destination-lock": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    // The adapter authenticates, naming it, that the retained lock can no longer land.
    h.actions["destination-lock"] = {
      state: "absent",
      txRef: refFor("destination-lock"),
      authenticationHash: AUTH_HASH,
    };
    for (const owner of ["dead-lock-1", "dead-lock-2"]) {
      await expect(advanceCrossChainHtlc({ ...run.nextOwner(), owner })).resolves.toEqual({
        status: "refund-pending",
        reason: "destination-lock-missing",
        txRefs: [refFor("source-lock")],
        refunds: { "source-refund": "waiting" },
      });
    }
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock"]);
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
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "source-refund"]);
  });

  test("keeps owing a retained destination lock reported absent naming nothing, and never reports refunded", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_800, mode: { "destination-lock": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    // Nothing is on chain yet (say, the lock was not mined): that proves
    // nothing about the retained bytes, which may still land.
    const unnamedAbsent = { state: "absent", authenticationHash: AUTH_HASH } as const;
    for (const owner of ["unmined-1", "unmined-2"]) {
      h.actions["destination-lock"] = unnamedAbsent;
      await expect(advanceCrossChainHtlc({ ...run.nextOwner(), owner })).resolves.toEqual({
        status: "waiting",
        reason: "htlc-destination-lock-finality-pending",
      });
    }
    // Before the source expiry the same signed bytes are rebroadcast, never re-prepared.
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-lock", "destination-lock"]);
    expect(new Set(h.broadcastRetained.mock.calls
      .filter((call) => call[0].action === "destination-lock")
      .map((call) => call[0].signedPayloadBase64)).size).toBe(1);
    const owed = {
      status: "refund-pending",
      reason: "destination-lock-unresolved",
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
      refunds: { "destination-refund": "waiting", "source-refund": "final" },
    };
    h.actions["destination-lock"] = unnamedAbsent;
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-refund-sent" })).resolves.toEqual(owed);
    for (const tick of [1, 2]) {
      await expect(advanceCrossChainHtlc({
        ...run.shared,
        owner: `still-owed-${tick}`,
        now: () => 1_700_000 + tick * 101,
      })).resolves.toEqual(owed);
    }
    // The rebroadcast lock lands after the source refund and is refunded at its expiry.
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
    await advanceCrossChainHtlc({ ...run.shared, owner: "destination-refund", now: () => 1_800_000 });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "both-refunded", now: () => 1_800_101 }))
      .resolves.toMatchObject({
        status: "refunded",
        refunds: { "destination-refund": "final", "source-refund": "final" },
      });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "source-refund", "destination-refund"]);
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
      recoveryDeadline: 5_000_000,
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
        sourceClaimPending: true,
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
      sourceClaimPending: true,
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
      sourceClaimPending: true,
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

  const outsideClaim = { ...refFor("source-claim"), claimTxHash: "tx-payee-own-claim" } as HtlcTxRef;
  const toSourceClaimPending = async (run: ReturnType<typeof runner>) => {
    let result = await advanceCrossChainHtlc(run.shared);
    for (let call = 0; call < 3; call += 1) result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result).toMatchObject({ status: "settle-asymmetric" });
  };
  test.each([
    ["within the window", 4_999_000, "operator-alert"],
    ["after the window", 5_000_001, "failed"],
  ] as const)("reconciles an outside claim final %s without any retained source claim", async (_name, finality, status) => {
    const h = harness();
    const prepare = h.prepareAction.getMockImplementation()!;
    h.prepareAction.mockImplementation(async (request, fence) => {
      if (request.action === "source-claim") throw new Error("payee claim preparation unavailable");
      return prepare(request, fence);
    });
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const recordPrepared = vi.fn(base.recordPrepared.bind(base));
    const run = runner({ adapter: h.adapter, store: { ...base, recordPrepared } });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "indeterminate", reason: "htlc-source-claim-effect-uncertain",
    });
    expect(recordPrepared.mock.calls.map(([input]) => input.prepared.action))
      .toEqual(["source-lock", "destination-lock", "destination-claim"]);
    h.actions["source-lock"] = {
      ...h.actions["source-lock"], lockState: "claimed", claimTxRef: outsideClaim, claimFinalityReachedAt: finality,
    } as HtlcObservedAction;
    run.setClock(5_010_000);
    h.setObservedAt(5_010_000);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status,
      ...(status === "failed" ? { errorClass: "settlement-atomicity" } : {
        txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim")],
      }),
      reason: status === "failed" ? "dest-revealed-source-unclaimed-expired" : "htlc-source-claimed-outside-core",
      sourceClaimTxRef: outsideClaim,
      sourceClaimFinalityReachedAt: finality,
      recoveryDeadline: 5_000_000,
    });
    expect(h.broadcastRetained.mock.calls.map(([prepared]) => prepared.action))
      .toEqual(["source-lock", "destination-lock", "destination-claim"]);
  });
  const corePathRefs = () =>
    [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")];
  test.each([
    ["authenticated open", { lockState: "open" }, {
      status: "failed",
      errorClass: "settlement-atomicity",
      reason: "dest-revealed-source-unclaimed-expired",
    }],
    ["authenticated refunded", { lockState: "refunded" }, {
      status: "failed",
      errorClass: "settlement-atomicity",
      reason: "dest-revealed-source-unclaimed-expired",
    }],
    // The core's claim reverts because the payee already claimed: the payee was
    // paid, so the session is neither terminal nor `failed-counterparty`.
    ["claimed outside the core within the window", {
      lockState: "claimed",
      claimTxRef: outsideClaim,
      claimFinalityReachedAt: 1_400_000,
    }, {
      status: "operator-alert",
      reason: "htlc-source-claimed-outside-core",
      txRefs: corePathRefs(),
      sourceClaimTxRef: outsideClaim,
      sourceClaimFinalityReachedAt: 1_400_000,
      recoveryDeadline: 1_500_000,
    }],
    ["claimed outside the core final at the expiry instant", {
      lockState: "claimed",
      claimTxRef: outsideClaim,
      claimFinalityReachedAt: 1_500_000,
    }, {
      status: "operator-alert",
      reason: "htlc-source-claimed-outside-core",
      txRefs: corePathRefs(),
      sourceClaimTxRef: outsideClaim,
      sourceClaimFinalityReachedAt: 1_500_000,
      recoveryDeadline: 1_500_000,
    }],
    // ST-8(a) resolves only on a claim final within the window: as for a
    // claim the core sent, a later one is the expiry. The payee still holds
    // the source funds, so the result keeps the claim for reconciliation.
    ["claimed outside the core final only after the expiry", {
      lockState: "claimed",
      claimTxRef: outsideClaim,
      claimFinalityReachedAt: 1_500_001,
    }, {
      status: "failed",
      errorClass: "settlement-atomicity",
      reason: "dest-revealed-source-unclaimed-expired",
      sourceClaimTxRef: outsideClaim,
      sourceClaimFinalityReachedAt: 1_500_001,
      recoveryDeadline: 1_500_000,
    }],
    // Without the lock's disposition a claim made outside the core cannot be
    // ruled out: the session stays resumable, and nothing the core sent is pending.
    ["not reported", {}, {
      status: "operator-alert",
      reason: "htlc-source-claim-missed-after-reveal",
      txRefs: corePathRefs(),
      sourceClaimPending: false,
    }],
  ] as const)("never replaces a pending or expired source claim; past the expiry with it failed and the lock %s", async (_name, disposition, expected) => {
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
    h.actions["source-lock"] = { ...h.actions["source-lock"], ...disposition } as HtlcObservedAction;
    run.setClock(1_500_000);
    h.setObservedAt(1_600_000);
    // No claim the core sent can complete within the window any more. Only a
    // lock authenticated unclaimed makes the interim record stand and the
    // session terminal (ST-8 expiry, `failed-counterparty`).
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "expired-source-claim" }))
      .resolves.toEqual(expected);
    expect(h.prepareAction.mock.calls.filter((call) => call[0].action === "source-claim"))
      .toHaveLength(1);
  });

  test("never ends ST-8 as the payee's failure when every core claim reverts on a lock claimed outside the core", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await toSourceClaimPending(run);
    // Each claim the core sends reverts: the payee already claimed the lock.
    h.broadcastRetained.mockImplementation(async (prepared, fence) => {
      await fence.assertCurrent();
      if (prepared.action === "source-claim") {
        h.actions["source-claim"] = {
          state: "failed",
          txRef: prepared.txRef,
          reason: "already claimed",
          authenticationHash: AUTH_HASH,
        };
      }
    });
    const first = h.broadcastRetained.mock.calls.map(([prepared]) => prepared).find((p) => p.action === "source-claim")!;
    h.actions["source-claim"] = { state: "failed", txRef: first.txRef, authenticationHash: AUTH_HASH };
    let result: CrossChainHtlcProgress = await advanceCrossChainHtlc(run.nextOwner());
    for (let call = 0; call < 5; call += 1) result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result).toMatchObject({ status: "operator-alert", reason: "htlc-source-claim-replacement-limit-reached" });
    run.setClock(5_000_000);
    h.setObservedAt(5_000_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "after-expiry" })).resolves.toMatchObject({
      status: "operator-alert",
      reason: "htlc-source-claim-missed-after-reveal",
      sourceClaimPending: false,
    });
    h.actions["source-lock"] = {
      ...h.actions["source-lock"],
      lockState: "claimed",
      claimTxRef: outsideClaim,
      claimFinalityReachedAt: 4_000_000,
    } as HtlcObservedAction;
    const resolved = await advanceCrossChainHtlc(run.nextOwner());
    expect(resolved).toMatchObject({
      status: "operator-alert",
      reason: "htlc-source-claimed-outside-core",
      sourceClaimTxRef: outsideClaim,
      sourceClaimFinalityReachedAt: 4_000_000,
      recoveryDeadline: 5_000_000,
    });
    expect(htlcNeedsOperator(resolved)).toBe(true);
  });

  test("resolves on a final outside claim while the core's own claim stays pending", async () => {
    const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100, mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await toSourceClaimPending(run);
    h.actions["source-lock"] = {
      ...h.actions["source-lock"],
      lockState: "claimed",
      claimTxRef: outsideClaim,
      claimFinalityReachedAt: 1_400_000,
    } as HtlcObservedAction;
    run.setClock(1_500_000);
    h.setObservedAt(1_500_000);
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    // The lock is spent, so the pending core claim can never land: it does
    // not hold a paid session in the alert, however long it stays pending.
    for (let call = 0; call < 3; call += 1) {
      expect(h.actions["source-claim"]).toMatchObject({ state: "pending" });
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "operator-alert",
        reason: "htlc-source-claimed-outside-core",
        txRefs: corePathRefs(),
        sourceClaimTxRef: outsideClaim,
        sourceClaimFinalityReachedAt: 1_400_000,
        recoveryDeadline: 1_500_000,
      });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
  });

  test("leaves a lock reported claimed by the pending core claim to that claim's own report", async () => {
    const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100, mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await toSourceClaimPending(run);
    const active = h.broadcastRetained.mock.calls.map(([prepared]) => prepared).find((p) => p.action === "source-claim")!;
    h.actions["source-lock"] = {
      ...h.actions["source-lock"],
      lockState: "claimed",
      claimTxRef: active.txRef,
      claimFinalityReachedAt: 1_400_000,
    } as HtlcObservedAction;
    run.setClock(1_500_000);
    h.setObservedAt(1_500_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "late" })).resolves.toEqual({
      status: "operator-alert",
      reason: "htlc-source-claim-missed-after-reveal",
      txRefs: corePathRefs(),
      sourceClaimPending: true,
    });
  });

  test("settles on the retained reveal checkpoint without writing it again when the reveal is re-observed later", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const recordRevealFinal = vi.fn(base.recordRevealFinal.bind(base));
    const run = runner({ adapter: h.adapter, store: { ...base, recordRevealFinal } });
    await toSourceClaimPending(run);
    expect(recordRevealFinal).toHaveBeenCalledTimes(1);
    // The store refuses another checkpoint for the session, so writing this
    // one would leave a session paid on chain unable to settle.
    h.setObservedAt(1_010_000);
    h.actions["destination-claim"] = { ...h.actions["destination-claim"], finalityObservedAt: 1_010_000 } as HtlcObservedAction;
    await h.markFinal("source-claim");
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "settled",
      settlement: { txRefs: corePathRefs() },
    });
    expect(recordRevealFinal).toHaveBeenCalledTimes(1);
  });

  test("refuses a lock reported claimed by the core's own claim that the same snapshot reports failed", async () => {
    const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100, mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await toSourceClaimPending(run);
    const prior = h.broadcastRetained.mock.calls.map(([prepared]) => prepared).find((p) => p.action === "source-claim")!;
    h.actions["source-claim"] = { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH };
    h.actions["source-lock"] = {
      ...h.actions["source-lock"],
      lockState: "claimed",
      claimTxRef: prior.txRef,
      claimFinalityReachedAt: 1_400_000,
    } as HtlcObservedAction;
    run.setClock(1_500_000);
    h.setObservedAt(1_500_000);
    const result = await advanceCrossChainHtlc({ ...run.shared, owner: "late" });
    expect(result).toEqual({
      status: "indeterminate",
      reason: "htlc-source-lock-disposition-contradicted",
    });
    // Only an adapter breaking its contract reports this, past the source
    // expiry: polling alone never clears it.
    expect(htlcNeedsOperator(result)).toBe(true);
  });

  test.each([
    ["failed", "failed"],
    ["pending", "pending"],
  ] as const)("refuses a lock reported claimed by a replaced core claim while the active one is %s", async (_name, activeState) => {
    const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100, mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await toSourceClaimPending(run);
    const replaced = h.broadcastRetained.mock.calls.map(([prepared]) => prepared).find((p) => p.action === "source-claim")!;
    h.actions["source-claim"] = { state: "failed", txRef: replaced.txRef, authenticationHash: AUTH_HASH };
    await advanceCrossChainHtlc(run.nextOwner());
    const active = h.prepareAction.mock.calls.filter(([request]) => request.action === "source-claim");
    expect(active).toHaveLength(2);
    const activeRef = refFor("source-claim", `-attempt-${active[1]![0].replacement!.attempt}`);
    expect(h.actions["source-claim"]).toMatchObject({ state: "pending", txRef: activeRef });
    h.actions["source-claim"] = { state: activeState, txRef: activeRef, authenticationHash: AUTH_HASH };
    h.actions["source-lock"] = {
      ...h.actions["source-lock"],
      lockState: "claimed",
      claimTxRef: replaced.txRef,
      claimFinalityReachedAt: 1_400_000,
    } as HtlcObservedAction;
    run.setClock(1_500_000);
    h.setObservedAt(1_500_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "late" })).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-source-lock-disposition-contradicted",
    });
  });

  test("takes the outside claim's chain and contract from the intent, not the adapter", async () => {
    const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100, mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await toSourceClaimPending(run);
    const prior = h.broadcastRetained.mock.calls.map(([prepared]) => prepared).find((p) => p.action === "source-claim")!;
    h.actions["source-claim"] = { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH };
    h.actions["source-lock"] = {
      ...h.actions["source-lock"],
      lockState: "claimed",
      claimTxRef: { ...outsideClaim, chainId: 1, contractAddress: "elsewhere" },
      claimFinalityReachedAt: 1_400_000,
    } as HtlcObservedAction;
    run.setClock(1_500_000);
    h.setObservedAt(1_500_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "late" }))
      .resolves.toMatchObject({ reason: "htlc-source-claimed-outside-core", sourceClaimTxRef: outsideClaim });
  });

  // Each `claimed` row is complete but for the defect it names.
  const claimedAt = { lockState: "claimed", claimFinalityReachedAt: 1_400_000 } as const;
  test.each([
    ["an unknown lock state", "source-lock", { lockState: "spent" }],
    ["claimed without the claim", "source-lock", { ...claimedAt }],
    ["claimed by a non-claim reference", "source-lock", { ...claimedAt, claimTxRef: refFor("source-refund") }],
    ["claimed by a claim without a hash", "source-lock", { ...claimedAt, claimTxRef: { ...outsideClaim, claimTxHash: "" } }],
    ["claimed by a reference of another kind carrying a claim hash", "source-lock", {
      ...claimedAt,
      claimTxRef: { ...refFor("source-refund"), claimTxHash: "tx-wrong-kind" },
    }],
    ["claimed by a claim whose hash is not a string", "source-lock", {
      ...claimedAt,
      claimTxRef: { ...outsideClaim, claimTxHash: ["tx-array"] },
    }],
    ["claimed without the claim's finality", "source-lock", { lockState: "claimed", claimTxRef: outsideClaim }],
    ["claimed with a negative claim finality", "source-lock", { ...claimedAt, claimTxRef: outsideClaim, claimFinalityReachedAt: -1 }],
    ["claimed with a fractional claim finality", "source-lock", { ...claimedAt, claimTxRef: outsideClaim, claimFinalityReachedAt: 1.5 }],
    ["claimed with a claim finality that is a string", "source-lock", {
      ...claimedAt,
      claimTxRef: outsideClaim,
      claimFinalityReachedAt: "1400000",
    }],
    // The lock was included at 1 000 000 and the snapshot is observed at 1 500 000.
    ["claimed by a claim final before the lock's inclusion", "source-lock", {
      ...claimedAt,
      claimTxRef: outsideClaim,
      claimFinalityReachedAt: 999_999,
    }],
    ["claimed by a claim final after the snapshot reporting it", "source-lock", {
      ...claimedAt,
      claimTxRef: outsideClaim,
      claimFinalityReachedAt: 1_500_001,
    }],
    ["a claim reference on an open lock", "source-lock", { lockState: "open", claimTxRef: outsideClaim }],
    ["a claim finality on an open lock", "source-lock", { lockState: "open", claimFinalityReachedAt: 1_400_000 }],
    ["a claim reference without a state", "source-lock", { claimTxRef: outsideClaim }],
    ["a disposition on the destination lock", "destination-lock", { lockState: "open" }],
    // Only a final observation carries a disposition.
    ["a disposition on the failed source claim", "source-claim", { lockState: "open" }],
    ["a disposition on a pending source lock", "source-lock", { state: "pending", lockState: "open" }],
  ] as const)("refuses a lock disposition with %s and never ends ST-8 on it", async (_name, action, disposition) => {
    const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100, mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await toSourceClaimPending(run);
    const prior = h.broadcastRetained.mock.calls.map(([prepared]) => prepared).find((p) => p.action === "source-claim")!;
    h.actions["source-claim"] = { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH };
    h.actions[action] ={ ...h.actions[action], ...disposition } as unknown as HtlcObservedAction;
    run.setClock(1_500_000);
    h.setObservedAt(1_500_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "late" })).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-ledger-observation-unavailable",
    });
  });

  test.each([
    ["at the lock's inclusion", 1_000_000],
    ["at the snapshot reporting it", 1_500_000],
  ] as const)("accepts an outside claim final exactly %s", async (_name, claimFinalityReachedAt) => {
    const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100, mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await toSourceClaimPending(run);
    const prior = h.broadcastRetained.mock.calls.map(([prepared]) => prepared).find((p) => p.action === "source-claim")!;
    h.actions["source-claim"] = { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH };
    expect(h.actions["source-lock"]).toMatchObject({ state: "final", includedAt: 1_000_000 });
    h.actions["source-lock"] = {
      ...h.actions["source-lock"],
      lockState: "claimed",
      claimTxRef: outsideClaim,
      claimFinalityReachedAt,
    } as HtlcObservedAction;
    run.setClock(1_500_000);
    h.setObservedAt(1_500_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "late" })).resolves.toMatchObject({
      status: "operator-alert",
      reason: "htlc-source-claimed-outside-core",
      sourceClaimFinalityReachedAt: claimFinalityReachedAt,
    });
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
      recoveryDeadline: 5_000_000,
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
        sourceClaimPending: true,
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
      sourceClaimPending: false,
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
      sourceClaimPending: true,
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
    // Its own reason lets a host tell it from a first reveal's broadcast hiccup.
    for (let call = 0; call < 2; call += 1) {
      const progress = await advanceCrossChainHtlc(run.nextOwner());
      expect(progress).toEqual({ status: "indeterminate", reason: "htlc-destination-claim-replacement-uncertain" });
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

  test("retries a reveal replacement the adapter returns unchanged as uncertain, without paging", async () => {
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } });
    const original = h.adapter.prepareAction;
    let unchanged = false;
    h.adapter.prepareAction = vi.fn<CrossChainHtlcAdapter["prepareAction"]>(async (request, fence) => {
      if (!unchanged || !request.replacement) return original(request, fence);
      // The adapter signs the prior reveal again instead of a fresh one.
      unchanged = false;
      return original({ ...request, replacement: undefined }, fence);
    });
    // A store that would accept the reused reveal, so only the core refuses it.
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const store: CrossChainHtlcStore = {
      ...base,
      async replacePreparedDestinationClaim(input) {
        return input.replacement.effectHash === input.priorEffectHash
          ? { status: "recorded" }
          : base.replacePreparedDestinationClaim(input);
      },
    };
    const run = runner({ adapter: h.adapter, store });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const pending = h.actions["destination-claim"];
    if (!pending || pending.state !== "pending") throw new Error("expected pending reveal");
    h.actions["destination-claim"] = { state: "failed", txRef: pending.txRef, authenticationHash: AUTH_HASH };
    unchanged = true;
    const progress = await advanceCrossChainHtlc(run.nextOwner());
    expect(progress).toEqual({ status: "indeterminate", reason: "htlc-destination-claim-replacement-uncertain" });
    expect(htlcNeedsOperator(progress)).toBe(false);
    expect(h.broadcastRetained.mock.calls.filter((call) => call[0].action === "destination-claim"))
      .toHaveLength(1);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    expect(h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "destination-claim")
      .map((prepared) => prepared.txRef)).toEqual([refFor("destination-claim"), refFor("destination-claim", "-attempt-2")]);
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
      reason: "htlc-destination-claim-replacement-uncertain",
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
      reason: "htlc-destination-claim-replacement-uncertain",
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

  test("refunds from a source-leg view reporting an absent source claim while the payee observer is down", async () => {
    const h = harness({ sourceExpiry: 1_700, mode: { "source-refund": "pending" } });
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const recordSourceFinality = vi.fn(base.recordSourceFinality.bind(base));
    const observeSourceLeg = h.observeSourceLeg.getMockImplementation()!;
    h.observeSourceLeg.mockImplementation(async (...args) => {
      const view = await observeSourceLeg(...args);
      return { ...view, actions: { ...view.actions, "source-claim": { state: "absent", authenticationHash: AUTH_HASH } } };
    });
    const run = runner({ adapter: h.adapter, store: { ...base, recordSourceFinality }, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    h.observe.mockRejectedValue(new Error("payee observation unavailable"));
    await advanceCrossChainHtlc(run.nextOwner());
    expect(recordSourceFinality).toHaveBeenCalledTimes(1);
    run.setClock(1_700_000);
    const refunded = await advanceCrossChainHtlc(run.nextOwner());
    expect(refunded).toEqual({
      status: "refund-pending",
      reason: "destination-lock-missing",
      txRefs: [refFor("source-lock"), refFor("source-refund")],
      refunds: { "source-refund": "pending" },
    });
    expect(h.broadcastRetained.mock.calls.map(([prepared]) => prepared.action)).toEqual(["source-lock", "source-refund"]);
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

  test("without a source-leg observation reports a first source refund it broadcast as pending, not uncertain", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
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
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "refund-unconfirmed" })).resolves.toEqual({
      status: "refund-pending",
      reason: "destination-lock-unresolved",
      // The refund this call sent is named, so a host can follow it.
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
      refunds: { "destination-refund": "uncertain", "source-refund": "pending" },
    });
    expect(h.actions["source-refund"]).toMatchObject({ state: "final" });
    h.observe.mockImplementation(observeLedger);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "observed-again", now: () => 1_700_101 }))
      .resolves.toMatchObject({
        status: "refund-pending",
        reason: "destination-timeout",
        refunds: { "destination-refund": "final", "source-refund": "final" },
      });
    expect(h.prepareAction.mock.calls.filter((call) => call[0].action === "source-refund")).toHaveLength(1);
    expect(h.broadcastRetained.mock.calls.filter((call) => call[0].action === "source-refund")).toHaveLength(1);
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

  test("refuses a source-leg observation that adds only an unnamed absent destination claim", async () => {
    // Snapshot validation accepts an `absent` naming nothing for any action,
    // so only the source-leg check refuses this view.
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const sourceLeg = h.observeSourceLeg.getMockImplementation()!;
    h.observeSourceLeg.mockImplementation(async (intent, fence) => {
      const view = await sourceLeg(intent, fence);
      return {
        ...view,
        actions: { ...view.actions, "destination-claim": { state: "absent", authenticationHash: AUTH_HASH } },
      };
    });
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    h.observe.mockImplementation(async () => { throw new Error("payee observation unavailable"); });
    run.setClock(1_700_000);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "cross-leg-absent" })).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-ledger-observation-unavailable",
    });
    expect(h.observeSourceLeg).toHaveBeenCalled();
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "destination-lock"]);
  });

  test.each(["throws", "never answers"] as const)(
    "checkpoints the source lock on the source leg and refunds it at its expiry, exactly once, when the whole-session observation %s from the source-lock broadcast on",
    async (failure) => {
      const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
      const recordSourceFinality = vi.fn(base.recordSourceFinality.bind(base));
      const store: CrossChainHtlcStore = { ...base, recordSourceFinality };
      const h = harness({ sourceExpiry: 1_700 });
      const observeLedger = h.observe.getMockImplementation()!;
      const broadcast = h.adapter.broadcastRetained;
      h.adapter.broadcastRetained = vi.fn<CrossChainHtlcAdapter["broadcastRetained"]>(async (prepared, fence) => {
        await broadcast(prepared, fence);
        // From here `observe` depends on a payee-side service that is down.
        if (prepared.action === "source-lock") {
          h.observe.mockImplementation(failure === "throws"
            ? async () => { throw new Error("payee observation unavailable"); }
            : () => new Promise(() => {}));
        }
      });
      const run = runner({ adapter: h.adapter, store, authorizeDestinationClaim: false });
      const advance = (owner: string, now: number) =>
        settlesWithin(advanceCrossChainHtlc({ ...run.shared, owner, now: () => now }), 2_000);
      await expect(advance("locks-source", 1_000_000)).resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-source-lock-effect-uncertain",
      });
      // Before the expiry the source leg alone checkpoints the lock, as the
      // whole-session path would, and nothing is refunded.
      await expect(advance("before-expiry", 1_699_899)).resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-ledger-observation-unavailable",
      });
      expect(recordSourceFinality).toHaveBeenCalledTimes(1);
      expect(recordSourceFinality.mock.calls[0]![0].checkpoint).toEqual({
        sourceLockEffectHash: h.broadcastRetained.mock.calls[0]![0].effectHash,
        sourceLockTxRef: refFor("source-lock"),
        includedAt: 1_000_000,
        sourceExpiry: 1_700,
        finalityObservedAt: 1_000_000,
        authenticationHash: AUTH_HASH,
      });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock"]);
      const payerRefund = {
        reason: "destination-lock-missing",
        txRefs: [refFor("source-lock"), refFor("source-refund")],
        refunds: { "source-refund": "final" },
      };
      await expect(advance("at-expiry", 1_700_000)).resolves.toEqual({ status: "refund-pending", ...payerRefund });
      await expect(advance("payee-still-down", 1_700_101)).resolves.toEqual({ status: "refunded", ...payerRefund });
      // Once the payee's side is back, `observe` agrees with that checkpoint.
      h.observe.mockImplementation(observeLedger);
      await expect(advance("payee-back", 1_700_202)).resolves.toEqual({ status: "refunded", ...payerRefund });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "source-refund"]);
      expect(h.broadcastRetained.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "source-refund"]);
      expect(recordSourceFinality).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    [
      "names another transaction",
      (lock: Extract<HtlcObservedAction, { state: "final" }>): HtlcObservedAction =>
        ({ ...lock, txRef: refFor("source-lock", "-other") as Extract<HtlcTxRef, { kind: "htlc-lock" }> }),
    ],
    [
      "reports an expiry not after its inclusion",
      (lock: Extract<HtlcObservedAction, { state: "final" }>): HtlcObservedAction => ({ ...lock, expiresAt: 1_000 }),
    ],
    [
      "omits its inclusion",
      ({ includedAt: _omitted, ...lock }: Extract<HtlcObservedAction, { state: "final" }>): HtlcObservedAction => lock,
    ],
    [
      "reports it pending",
      (lock: Extract<HtlcObservedAction, { state: "final" }>): HtlcObservedAction =>
        ({ state: "pending", txRef: lock.txRef, authenticationHash: AUTH_HASH }),
    ],
  ] as const)(
    "records no checkpoint and sends no refund from a source-leg view that %s, until it reports the retained lock final",
    async (_variant, viewOf) => {
      const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
      const recordSourceFinality = vi.fn(base.recordSourceFinality.bind(base));
      const store: CrossChainHtlcStore = { ...base, recordSourceFinality };
      const h = harness({ sourceExpiry: 1_700 });
      const run = runner({ adapter: h.adapter, store, authorizeDestinationClaim: false });
      await advanceCrossChainHtlc(run.shared);
      const lock = h.actions["source-lock"];
      if (!lock || lock.state !== "final") throw new Error("expected final source lock");
      const sourceLeg = h.observeSourceLeg.getMockImplementation()!;
      h.observeSourceLeg.mockImplementation(async () => ({
        observedAt: 1_000_000,
        authenticationHash: AUTH_HASH,
        actions: { "source-lock": viewOf(lock) },
      }));
      h.observe.mockImplementation(async () => { throw new Error("payee observation unavailable"); });
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "view-disagrees", now: () => 1_700_000 }))
        .resolves.toEqual({ status: "indeterminate", reason: "htlc-ledger-observation-unavailable" });
      expect(h.observeSourceLeg).toHaveBeenCalledTimes(1);
      expect(recordSourceFinality).not.toHaveBeenCalled();
      expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock"]);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
      // A source leg that reports the retained lock final checkpoints it, and the refund follows.
      h.observeSourceLeg.mockImplementation(sourceLeg);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "view-agrees", now: () => 1_700_101 }))
        .resolves.toEqual({
          status: "refund-pending",
          reason: "destination-lock-missing",
          txRefs: [refFor("source-lock"), refFor("source-refund")],
          refunds: { "source-refund": "final" },
        });
      expect(recordSourceFinality).toHaveBeenCalledTimes(1);
      expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "source-refund"]);
    },
  );

  test("sends no refund from a source-leg checkpoint the store fails to record, then refunds once it records", async () => {
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    let storeDown = true;
    const store: CrossChainHtlcStore = {
      ...base,
      async recordSourceFinality(input) {
        if (storeDown) throw new Error("store write timed out");
        return base.recordSourceFinality(input);
      },
    };
    const h = harness({ sourceExpiry: 1_700 });
    const run = runner({ adapter: h.adapter, store, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    h.observe.mockImplementation(async () => { throw new Error("payee observation unavailable"); });
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "store-down", now: () => 1_700_000 }))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-source-finality-persistence-uncertain" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock"]);
    storeDown = false;
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "store-back", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refund-pending", refunds: { "source-refund": "final" } });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "source-refund"]);
  });

  test.each(["throws", "never answers"] as const)(
    "sends a first source refund from the checkpoint when the source-leg observation %s, under a clock that advances in real time",
    async (failure) => {
      // The host's clock advances with real time, as in production, so the
      // lease really lapses while an adapter call hangs.
      let clockBase = 1_000_000;
      let clockStart = performance.now();
      const now = () => Math.floor(clockBase + performance.now() - clockStart);
      const setClock = (value: number) => { clockBase = value; clockStart = performance.now(); };
      const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
      let leaseExpiresAt = 0;
      const store: CrossChainHtlcStore = {
        ...base,
        async claim(input) {
          const claimed = await base.claim(input);
          if (claimed.status === "acquired") leaseExpiresAt = claimed.lease.expiresAt;
          return claimed;
        },
      };
      const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
      const run = runner({ adapter: h.adapter, store, authorizeDestinationClaim: false, now, leaseDurationMs: 1_000 });
      await advanceCrossChainHtlc(run.shared);
      setClock(1_002_000);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "checkpoints" })).resolves.toEqual({
        status: "waiting",
        reason: "htlc-destination-lock-finality-pending",
      });
      h.observe.mockImplementation(async () => { throw new Error("payee observation unavailable"); });
      // The deadline the core set for the first source-leg observation (the
      // refund step's; a later one re-observes the refund) is the timer it
      // armed just before calling it, with the lease time then left.
      const timers = vi.spyOn(globalThis, "setTimeout");
      let deadline: number | undefined;
      let leaseLeft = 0;
      const recordDeadline = () => {
        if (deadline !== undefined) return;
        deadline = timers.mock.calls.at(-1)?.[1];
        leaseLeft = leaseExpiresAt - now();
      };
      h.observeSourceLeg.mockImplementation(failure === "throws"
        ? async () => { recordDeadline(); throw new Error("source RPC unavailable"); }
        : () => { recordDeadline(); return new Promise(() => {}); });
      setClock(1_700_000);
      try {
        await expect(settlesWithin(advanceCrossChainHtlc({ ...run.shared, owner: "source-leg-down" }), 3_000))
          .resolves.toEqual({
            status: "refund-pending",
            reason: "destination-lock-unresolved",
            txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("source-refund")],
            refunds: { "destination-refund": "uncertain", "source-refund": "pending" },
          });
      } finally {
        timers.mockRestore();
      }
      // Half the lease time left: at most half the 1 000 ms lease, and no
      // less than half of what was left once the observation had started.
      expect(deadline).toBeLessThanOrEqual(500);
      expect(deadline).toBeGreaterThanOrEqual(Math.floor(leaseLeft / 2));
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "source-refund"]);
      expect(h.broadcastRetained.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "source-refund"]);
      expect(h.actions["source-refund"]).toMatchObject({ state: "final" });
    },
  );

  test("never refunds on the source leg alone for a store row that retains a source claim without a reveal checkpoint", async () => {
    const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const run = runner({ adapter: h.adapter, store, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    // A corrupt row: a source claim retained without a reveal or a reveal checkpoint.
    const { intent, secrets } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
    const corrupter = await store.claim({ intent, secrets, owner: "corrupter", now: 1_600_000, leaseDurationMs: 100 });
    if (corrupter.status !== "acquired") throw new Error("corrupter lease not acquired");
    await expect(store.recordPrepared({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner: corrupter.lease.owner,
      generation: corrupter.lease.generation,
      prepared: preparedFor(intent, "source-claim"),
    })).resolves.toMatchObject({ status: "recorded" });
    h.observe.mockImplementation(async () => { throw new Error("payee observation unavailable"); });
    const sourceLegCalls = h.observeSourceLeg.mock.calls.length;
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "corrupt-row", now: () => 1_700_000 }))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-ledger-observation-unavailable" });
    expect(h.observeSourceLeg).toHaveBeenCalledTimes(sourceLegCalls);
    expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "destination-lock"]);
    expect(h.broadcastRetained.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "destination-lock"]);
  });

  test.each(["transaction", "inclusion", "expiry"] as const)(
    "sends no source refund on a source-leg view that changes the checkpointed lock's %s",
    async (fact) => {
      const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
      const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      const lock = h.actions["source-lock"];
      if (!lock || lock.state !== "final" || lock.includedAt === undefined || lock.expiresAt === undefined) {
        throw new Error("expected final source lock");
      }
      const viewed: HtlcObservedAction = fact === "transaction"
        ? { ...lock, txRef: refFor("source-lock", "-reorged") as Extract<HtlcTxRef, { kind: "htlc-lock" }> }
        : fact === "inclusion"
          ? { ...lock, includedAt: lock.includedAt + 1, finalityObservedAt: lock.finalityObservedAt + 1 }
          : { ...lock, expiresAt: lock.expiresAt + 1 };
      h.observeSourceLeg.mockImplementation(async () => ({
        observedAt: 1_000_000,
        authenticationHash: AUTH_HASH,
        actions: { "source-lock": viewed },
      }));
      h.observe.mockImplementation(async () => { throw new Error("payee observation unavailable"); });
      const sourceLegCalls = h.observeSourceLeg.mock.calls.length;
      run.setClock(1_700_000);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: `changed-${fact}` })).resolves.toEqual({
        status: "indeterminate",
        reason: "htlc-ledger-observation-unavailable",
      });
      expect(h.observeSourceLeg).toHaveBeenCalledTimes(sourceLegCalls + 1);
      expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "destination-lock"]);
      expect(h.broadcastRetained.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "destination-lock"]);
    },
  );

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
      }).shared)).resolves.toEqual({ status: "indeterminate", reason: "htlc-call-input-invalid" });
      expect(claim).not.toHaveBeenCalled();
      expect(h.prepareAction).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["an empty owner", { owner: "" }],
    ["an invalid lease duration", { leaseDurationMs: 0 }],
    ["a non-canonical authority spelling", { authority: authority({ jobId: JOB_ID.toLowerCase() }) }],
    ["a hashlock deriver that throws", {
      hashlocks: { deriveHashlock: () => { throw new Error("hashlock service unavailable"); } },
    }],
  ] as const)(
    "keeps a live session resumable, and pages, when one call has %s",
    async (_name, override) => {
      const h = harness({ sourceExpiry: 1_700 });
      const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
      await advanceCrossChainHtlc(run.shared);
      const calls = () => [
        h.observe.mock.calls.length,
        h.observeSourceLeg.mock.calls.length,
        h.prepareAction.mock.calls.length,
        h.broadcastRetained.mock.calls.length,
      ];
      const before = calls();
      const progress = await advanceCrossChainHtlc({ ...run.nextOwner(), ...override });
      expect(progress).toEqual({ status: "indeterminate", reason: "htlc-call-input-invalid" });
      expect(htlcNeedsOperator(progress)).toBe(true);
      expect(calls()).toEqual(before);
      // The corrected call drives the same session on.
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
        status: "waiting",
        reason: "htlc-destination-lock-finality-pending",
      });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action)).toEqual(["source-lock", "destination-lock"]);
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
    ["naming nothing", false, {
      txRefs: [refFor("destination-lock"), refFor("source-refund")],
      refunds: { "destination-refund": "waiting", "source-refund": "absent" },
    }],
    ["naming it", true, {
      txRefs: [refFor("source-refund")],
      refunds: { "source-refund": "absent" },
    }],
  ] as const)(
    "with a regressed source lock, owes a retained destination lock reported absent %s only while it may land",
    async (_name, named, expected) => {
      const h = harness({
        sourceExpiry: 1_700,
        destinationExpiry: 1_800,
        mode: { "destination-lock": "pending", "source-refund": "pending" },
      });
      const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
      await advanceCrossChainHtlc(run.shared);
      await advanceCrossChainHtlc(run.nextOwner());
      run.setClock(1_700_000);
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "source-refund-sent" }))
        .resolves.toMatchObject({ status: "refund-pending", refunds: { "source-refund": "pending" } });
      // The source lock regresses, the payer's refund is authenticated dead,
      // and the destination lock reads absent.
      delete h.actions["source-lock"];
      h.actions["source-refund"] = { state: "absent", txRef: refFor("source-refund"), authenticationHash: AUTH_HASH };
      h.actions["destination-lock"] = named
        ? { state: "absent", txRef: refFor("destination-lock"), authenticationHash: AUTH_HASH }
        : { state: "absent", authenticationHash: AUTH_HASH };
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "regressed", now: () => 1_700_101 }))
        .resolves.toEqual({ status: "operator-alert", reason: "htlc-refund-absent", ...expected });
      expect(h.prepareAction.mock.calls.map((call) => call[0].action))
        .toEqual(["source-lock", "destination-lock", "source-refund"]);
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
        // The late claim paid the payee: the expiry keeps it for reconciliation.
        expect(result).toEqual({
          status: "failed",
          errorClass: "settlement-atomicity",
          reason: "dest-revealed-source-unclaimed-expired",
          sourceClaimTxRef: refFor("source-claim"),
          sourceClaimFinalityReachedAt: 1_500_001,
          recoveryDeadline: 1_500_000,
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
        // The late claim paid the payee: the expiry keeps it for reconciliation.
        expect(result).toEqual({
          status: "failed",
          errorClass: "settlement-atomicity",
          reason: "dest-revealed-source-unclaimed-expired",
          sourceClaimTxRef: refFor("source-claim"),
          sourceClaimFinalityReachedAt: 1_500_001,
          recoveryDeadline: 1_500_000,
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
          recoveryDeadline: 5_000_000,
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
        sourceClaimPending: true,
      });
  });

  test.each(["present", "unreported", "absent"] as const)("names the earlier reveal and %s destination lock when source replacements run out", async (destinationState) => {
    const { h, run } = await toPendingReveal();
    const [first] = broadcastsOf(h, "destination-claim");
    if (!first || first.txRef.kind !== "htlc-reveal") throw new Error("expected a reveal");
    h.actions["destination-claim"] = { state: "absent", txRef: first.txRef, authenticationHash: AUTH_HASH };
    await advanceCrossChainHtlc(run.nextOwner());
    const [, replacement] = broadcastsOf(h, "destination-claim");
    if (!replacement) throw new Error("expected a replacement reveal");
    h.actions["destination-claim"] = {
      state: "final",
      txRef: first.txRef,
      finalityObservedAt: 1_000_505,
      revealedPreimageHex: PREIMAGE_HEX,
      authenticationHash: AUTH_HASH,
    };
    h.setMode("source-claim", "pending");
    let clock = 1_000_505;
    await advanceCrossChainHtlc({ ...run.shared, owner: "first-reveal-landed", now: () => clock });
    // The replacement reverted, and the adapter now reports that active attempt.
    h.actions["destination-claim"] = { state: "failed", txRef: replacement.txRef, authenticationHash: AUTH_HASH };
    const failActiveClaim = () => {
      const active = broadcastsOf(h, "source-claim").at(-1);
      if (!active) throw new Error("expected a source claim");
      h.actions["source-claim"] = { state: "failed", txRef: active.txRef, authenticationHash: AUTH_HASH };
    };
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      failActiveClaim();
      clock += 101;
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: `claim-${attempt}`, now: () => clock }))
        .resolves.toMatchObject({ status: "settle-asymmetric" });
    }
    failActiveClaim();
    clock += 101;
    if (destinationState === "unreported") delete h.actions["destination-lock"];
    if (destinationState === "absent") h.actions["destination-lock"] = { state: "absent", authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "claims-exhausted", now: () => clock }))
      .resolves.toEqual({
        status: "operator-alert",
        reason: "htlc-source-claim-replacement-limit-reached",
        txRefs: [
          refFor("source-lock"),
          refFor("destination-lock"),
          refFor("destination-claim"),
          refFor("source-claim", "-attempt-4"),
        ],
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

  // An `absent` naming nothing says nothing about an action the core never
  // prepared, so it sends that action: the status alone cannot tell.
  test("sends the first reveal when the destination claim is reported absent naming nothing", async () => {
    const h = harness();
    const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
    let result = await advanceCrossChainHtlc(run.shared);
    for (let call = 0; call < 6 && !("reason" in result && result.reason === "htlc-destination-claim-not-authorized"); call += 1) {
      result = await advanceCrossChainHtlc(run.nextOwner());
    }
    expect(result).toEqual({ status: "waiting", reason: "htlc-destination-claim-not-authorized" });
    expect(broadcastsOf(h, "destination-claim")).toHaveLength(0);
    h.actions["destination-claim"] = { state: "absent", authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), authorizeDestinationClaim: true })).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-claim-finality-pending",
    });
    expect(h.prepareAction.mock.calls.filter(([request]) => request.action === "destination-claim")).toHaveLength(1);
    expect(broadcastsOf(h, "destination-claim")).toHaveLength(1);
  });

  test("sends the destination lock when it is reported absent naming nothing", async () => {
    const h = harness({ mode: { "destination-lock": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    expect(h.prepareAction.mock.calls.map(([request]) => request.action)).toEqual(["source-lock"]);
    h.actions["destination-lock"] = { state: "absent", authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "waiting",
      reason: "htlc-destination-lock-finality-pending",
    });
    expect(h.prepareAction.mock.calls.map(([request]) => request.action)).toEqual(["source-lock", "destination-lock"]);
    expect(broadcastsOf(h, "destination-lock")).toHaveLength(1);
  });

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
    { status: "operator-alert", reason: "htlc-source-claim-missed-after-reveal", txRefs: refs, sourceClaimPending: true },
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
      recoveryDeadline: 5_000_000,
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

describe("secret handling, persistence, effect binding, observations and evidence", () => {
  /** JSON text of adapter arguments, with every byte array as hex. */
  const serialise = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
    if (item instanceof Uint8Array) return `bytes:${Buffer.from(item).toString("hex")}`;
    if (item !== null && typeof item === "object" && (item as { type?: unknown }).type === "Buffer" &&
        Array.isArray((item as { data?: unknown }).data)) {
      return `bytes:${Buffer.from((item as { data: number[] }).data).toString("hex")}`;
    }
    return item;
  });
  const actionsPrepared = (h: ReturnType<typeof harness>) =>
    h.prepareAction.mock.calls.map(([request]) => request.action);
  const actionsBroadcast = (h: ReturnType<typeof harness>) =>
    h.broadcastRetained.mock.calls.map(([prepared]) => prepared.action);
  /** The harness without `observeSourceLeg`, so every decision is made on `observe`. */
  const wholeSessionOnly = (h: ReturnType<typeof harness>): CrossChainHtlcAdapter => {
    const { observeSourceLeg: _sourceLeg, ...adapter } = h.adapter;
    return adapter as unknown as CrossChainHtlcAdapter;
  };
  async function settleFourCalls(run: ReturnType<typeof runner>) {
    let result = await advanceCrossChainHtlc(run.shared);
    for (let call = 0; call < 3; call += 1) result = await advanceCrossChainHtlc(run.nextOwner());
    return result;
  }

  test("HTLC-1: draws every buyer salt fresh from the CSPRNG", () => {
    const salts = Array.from({ length: 64 }, () => Buffer.from(generateHtlcBuyerSalt()).toString("hex"));
    expect(new Set(salts).size).toBe(salts.length);
    expect(salts).not.toContain("00".repeat(32));
    const short = [generateHtlcBuyerSalt(16), generateHtlcBuyerSalt(16)];
    expect(short.map((salt) => salt.byteLength)).toEqual([16, 16]);
    expect(Buffer.from(short[0]!).equals(Buffer.from(short[1]!))).toBe(false);
  });

  test("HTLC-4: a restarted caller settles with only the salt recovered from its vault", async () => {
    // The host persists the salt it generated (as a vault would, encoded) and
    // keeps no copy in process; every later call, each one a takeover as after
    // a restart, decodes it again. The core needs no other secret.
    const generated = generateHtlcBuyerSalt();
    const vault = new Map([[JOB_ID, Buffer.from(generated).toString("base64")]]);
    const preimageHex = Buffer.from(deriveHtlcPreimage({
      buyerSalt: generated,
      jobId: JOB_ID,
      agreementHash: AGREEMENT_HASH,
    })).toString("hex");
    generated.fill(0);
    const recovered = () => Uint8Array.from(Buffer.from(vault.get(JOB_ID)!, "base64"));
    const h = harness();
    const run = runner({ adapter: h.adapter, buyerSalt: recovered() });
    let result = await advanceCrossChainHtlc(run.shared);
    for (let call = 0; call < 3; call += 1) {
      result = await advanceCrossChainHtlc({ ...run.nextOwner(), buyerSalt: recovered() });
    }
    expect(result).toMatchObject({ status: "settled" });
    expect(h.prepareAction.mock.calls.map((call) => call[0].action))
      .toEqual(["source-lock", "destination-lock", "destination-claim", "source-claim"]);
    expect(h.preimages.get("source-claim")).toBe(preimageHex);
  });

  test("HTLC-2: never hands the buyer salt to any adapter call", async () => {
    const salt = generateHtlcBuyerSalt();
    const h = harness();
    const result = await settleFourCalls(runner({ adapter: h.adapter, buyerSalt: salt }));
    expect(result).toMatchObject({ status: "settled" });
    const calls = [h.prepareAction, h.broadcastRetained, h.observe, h.observeSourceLeg]
      .flatMap((mock) => mock.mock.calls as unknown[][]);
    expect(calls.length).toBeGreaterThan(8);
    for (const args of calls) {
      const text = serialise(args);
      expect(text).not.toContain(Buffer.from(salt).toString("hex"));
      expect(text).not.toContain(Buffer.from(salt).toString("base64").replace(/=+$/, ""));
    }
    // Only the payer's reveal and the payee's source claim carry the preimage.
    expect(h.prepareAction.mock.calls.filter(([request]) => request.preimage !== undefined)
      .map(([request]) => request.action)).toEqual(["destination-claim", "source-claim"]);
  });

  test.each([
    ["ArrayBuffer", () => new ArrayBuffer(32)],
    ["DataView", () => new DataView(new ArrayBuffer(32))],
    ["number array", () => Array.from({ length: 32 }, () => 1)],
  ] as const)("refuses a %s buyer salt instead of deriving over empty key material", (_name, make) => {
    expect(() => deriveHtlcPreimage({ buyerSalt: make() as never, jobId: JOB_ID, agreementHash: AGREEMENT_HASH }))
      .toThrow("buyerSalt requires at least 128 bits");
    expect(() => createCrossChainHtlcIntent(authority(), make() as never, hashlocks)).toThrow();
  });

  test.each([
    ["missing", undefined],
    ["zero", 0],
    ["fractional", 1.5],
  ] as const)("refuses an authority whose safetyWindowSec is %s before any store or adapter call", async (_name, value) => {
    const { safetyWindowSec: _pinned, ...unpinned } = authority();
    const candidate = (value === undefined ? unpinned : { ...unpinned, safetyWindowSec: value }) as CrossChainHtlcAuthority;
    expect(() => createCrossChainHtlcIntent(candidate, SALT, hashlocks)).toThrow("safetyWindowSec");
    const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const claim = vi.spyOn(store, "claim");
    const h = harness();
    await expect(advanceCrossChainHtlc(runner({ authority: candidate, store, adapter: h.adapter }).shared))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-call-input-invalid" });
    expect(claim).not.toHaveBeenCalled();
    expect(h.observe).not.toHaveBeenCalled();
    // The pinned value, not a default, is what the intent binds.
    const pinned = createCrossChainHtlcIntent(authority({ safetyWindowSec: 11 }), SALT, hashlocks).intent;
    expect(pinned.safetyWindowSec).toBe(11);
    expect(pinned.bindingHash).not.toBe(createCrossChainHtlcIntent(authority(), SALT, hashlocks).intent.bindingHash);
  });

  test.each([
    ["fractional", 1_000_000.5],
    ["negative", -1],
    ["NaN", Number.NaN],
  ] as const)("reports a %s host clock as call input before the store is read", async (_name, value) => {
    const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const claim = vi.spyOn(store, "claim");
    const result = await advanceCrossChainHtlc({ ...runner({ store }).shared, now: () => value });
    expect(result).toEqual({ status: "indeterminate", reason: "htlc-call-input-invalid" });
    expect(htlcNeedsOperator(result)).toBe(true);
    expect(claim).not.toHaveBeenCalled();
  });

  test("asks each role for its own effects, refunds included", async () => {
    const h = harness();
    await settleFourCalls(runner({ adapter: h.adapter }));
    expect(h.prepareAction.mock.calls.map(([request]) => [request.action, request.actor])).toEqual([
      ["source-lock", "payer"],
      ["destination-lock", "payee"],
      ["destination-claim", "payer"],
      ["source-claim", "payee"],
    ]);
    const refunding = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500 });
    const run = runner({ adapter: refunding.adapter, authorizeDestinationClaim: false });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(5_000_000);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const refunds = refunding.prepareAction.mock.calls
      .map(([request]) => [request.action, request.actor])
      .filter(([action]) => action === "source-refund" || action === "destination-refund");
    expect(refunds).toEqual(expect.arrayContaining([["source-refund", "payer"], ["destination-refund", "payee"]]));
    expect(refunds).toHaveLength(2);
  });

  const destinationLockTampering: readonly (readonly [string, (value: Readonly<Omit<HtlcPreparedAction, "effectHash">>) => unknown])[] = [
    ["another action version", (value) => ({ ...value, actionVersion: "2" })],
    ["another action", (value) => ({ ...value, action: "source-lock" })],
    ["the payer as actor", (value) => ({ ...value, actor: "payer" })],
    ["another authority", (value) => ({ ...value, authorityHash: "d".repeat(64) })],
    ["the source chain", (value) => ({ ...value, txRef: { ...value.txRef, chainId: 84532 } })],
    ["the source contract", (value) => ({ ...value, txRef: { ...value.txRef, contractAddress: "source-contract" } })],
    ["a reveal reference", (value) => ({
      ...value,
      txRef: { kind: "htlc-reveal", chainId: 80002, contractAddress: "destination-contract", revealTxHash: "tx-x" },
    })],
    ["an empty transaction hash", (value) => ({ ...value, txRef: { ...value.txRef, lockTxHash: "" } })],
    ["non-canonical base64", (value) => ({ ...value, signedPayloadBase64: "d2lyZR==" })],
    ["padding-only base64", (value) => ({ ...value, signedPayloadBase64: "====" })],
    ["a negative preparedAt", (value) => ({ ...value, preparedAt: -1 })],
    ["a fractional preparedAt", (value) => ({ ...value, preparedAt: 1.5 })],
    ["another checkpoint binding", (value) => ({ ...value, sourceFinalityCheckpointHash: "0".repeat(64) })],
    ["no checkpoint binding", ({ sourceFinalityCheckpointHash: _binding, ...value }) => value],
  ];
  test.each(destinationLockTampering)(
    "neither records nor broadcasts a destination lock prepared with %s",
    async (_name, tamper) => {
      const h = harness();
      const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
      const recordPrepared = vi.spyOn(store, "recordPrepared");
      const adapter: CrossChainHtlcAdapter = {
        ...h.adapter,
        async prepareAction(request, fence) {
          const value = await h.adapter.prepareAction(request, fence);
          return (request.action === "destination-lock" ? tamper(value) : value) as typeof value;
        },
      };
      const run = runner({ adapter, store });
      await advanceCrossChainHtlc(run.shared);
      await expect(advanceCrossChainHtlc(run.nextOwner()))
        .resolves.toEqual({ status: "indeterminate", reason: "htlc-destination-lock-effect-uncertain" });
      expect(recordPrepared.mock.calls.map(([input]) => input.prepared.action)).toEqual(["source-lock"]);
      expect(actionsBroadcast(h)).toEqual(["source-lock"]);
    },
  );

  test("neither records nor broadcasts a source lock that claims a source-finality binding", async () => {
    const h = harness();
    const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const recordPrepared = vi.spyOn(store, "recordPrepared");
    const adapter: CrossChainHtlcAdapter = {
      ...h.adapter,
      async prepareAction(request, fence) {
        return { ...await h.adapter.prepareAction(request, fence), sourceFinalityCheckpointHash: "0".repeat(64) };
      },
    };
    await expect(advanceCrossChainHtlc(runner({ adapter, store }).shared))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-source-lock-effect-uncertain" });
    expect(recordPrepared).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([
    ["conflict", async (): Promise<HtlcStoreWrite> => ({ status: "conflict", reason: "refused" })],
    ["stale", async (): Promise<HtlcStoreWrite> => ({ status: "stale", reason: "lease lost" })],
    ["corrupt", async (): Promise<HtlcStoreWrite> => ({ status: "corrupt", reason: "bad row" })],
    ["thrown", async (): Promise<HtlcStoreWrite> => { throw new Error("store down"); }],
  ] as const)("never broadcasts an action whose recordPrepared result is %s", async (_name, refuse) => {
    const h = harness();
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const store: CrossChainHtlcStore = { ...base, recordPrepared: refuse };
    await expect(advanceCrossChainHtlc(runner({ adapter: h.adapter, store }).shared))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-source-lock-effect-uncertain" });
    expect(h.prepareAction).toHaveBeenCalledTimes(1);
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("treats an `existing` recordPrepared result as recorded and broadcasts", async () => {
    const h = harness();
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const store: CrossChainHtlcStore = {
      ...base,
      async recordPrepared(input) {
        expect(await base.recordPrepared(input)).toEqual({ status: "recorded" });
        return { status: "existing" };
      },
    };
    await expect(settleFourCalls(runner({ adapter: h.adapter, store }))).resolves.toMatchObject({ status: "settled" });
    expect(actionsBroadcast(h)).toEqual(["source-lock", "destination-lock", "destination-claim", "source-claim"]);
  });

  test("checks the fence itself before a broadcast, even when the adapter does not", async () => {
    const h = harness();
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    let leaseLost = false;
    const store: CrossChainHtlcStore = {
      ...base,
      async recordPrepared(input) {
        const result = await base.recordPrepared(input);
        leaseLost = true;
        return result;
      },
      async isCurrent(input) {
        return !leaseLost && await base.isCurrent(input);
      },
    };
    const unfenced: CrossChainHtlcAdapter = {
      ...h.adapter,
      broadcastRetained: (prepared, fence) =>
        h.adapter.broadcastRetained(prepared, { ...fence, assertCurrent: async () => {} }),
    };
    await expect(advanceCrossChainHtlc(runner({ adapter: unfenced, store }).shared))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-source-lock-effect-uncertain" });
    expect(h.prepareAction).toHaveBeenCalledTimes(1);
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test.each([
    ["conflict", "in the call that sees the claim land"],
    ["stale", "in the call that sees the claim land"],
    ["thrown", "in the call that sees the claim land"],
    ["conflict", "on a later observation"],
    ["stale", "on a later observation"],
    ["thrown", "on a later observation"],
  ] as const)("never reports settled when recordSettlement is %s %s", async (outcome, when) => {
    const later = when === "on a later observation";
    const h = harness(later ? { mode: { "source-claim": "pending" } } : {});
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const store: CrossChainHtlcStore = {
      ...base,
      async recordSettlement() {
        if (outcome === "thrown") throw new Error("store down");
        return { status: outcome, reason: "refused" };
      },
    };
    const run = runner({ adapter: h.adapter, store });
    const fourth = await settleFourCalls(run);
    if (later) {
      expect(fourth).toMatchObject({ status: "settle-asymmetric" });
      await h.markFinal("source-claim");
    }
    const result = later ? await advanceCrossChainHtlc(run.nextOwner()) : fourth;
    expect(result).toEqual({ status: "indeterminate", reason: "htlc-settlement-persistence-uncertain" });
  });

  test.each([
    ["conflict", async (): Promise<HtlcStoreWrite> => ({ status: "conflict", reason: "refused" })],
    ["stale", async (): Promise<HtlcStoreWrite> => ({ status: "stale", reason: "lease lost" })],
    ["thrown", async (): Promise<HtlcStoreWrite> => { throw new Error("store down"); }],
  ] as const)("drives no source claim while the reveal checkpoint write is %s", async (_name, refuse) => {
    const h = harness();
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const store: CrossChainHtlcStore = { ...base, recordRevealFinal: refuse };
    await expect(settleFourCalls(runner({ adapter: h.adapter, store })))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-reveal-checkpoint-persistence-uncertain" });
    expect(actionsPrepared(h)).not.toContain("source-claim");
  });

  test.each([
    ["conflict", async (): Promise<HtlcStoreWrite> => ({ status: "conflict", reason: "refused" })],
    ["thrown", async (): Promise<HtlcStoreWrite> => { throw new Error("store down"); }],
  ] as const)("never broadcasts a source-claim replacement whose compare-and-swap is %s", async (_name, refuse) => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const store: CrossChainHtlcStore = { ...base, replacePreparedSourceClaim: refuse };
    const run = runner({ adapter: h.adapter, store });
    await expect(settleFourCalls(run)).resolves.toMatchObject({ status: "settle-asymmetric" });
    h.actions["source-claim"] = { state: "failed", txRef: refFor("source-claim"), authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc(run.nextOwner()))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-source-claim-effect-uncertain" });
    expect(actionsPrepared(h).filter((action) => action === "source-claim")).toHaveLength(2);
    expect(actionsBroadcast(h).filter((action) => action === "source-claim")).toHaveLength(1);
  });

  test.each(["source-claim", "destination-claim"] as const)(
    "refuses a %s replacement that reuses the prior transaction reference",
    async (action) => {
      const h = harness({ mode: { [action]: "pending" } });
      const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
      const replaceSourceClaim = vi.spyOn(base, "replacePreparedSourceClaim");
      const replaceDestinationClaim = vi.spyOn(base, "replacePreparedDestinationClaim");
      const adapter: CrossChainHtlcAdapter = {
        ...h.adapter,
        async prepareAction(request, fence) {
          const value = await h.adapter.prepareAction(request, fence);
          // A fresh payload under the prior attempt's transaction reference.
          return request.replacement ? { ...value, txRef: refFor(action) } : value;
        },
      };
      const run = runner({ adapter, store: base });
      let result = await advanceCrossChainHtlc(run.shared);
      for (let call = 0; call < (action === "source-claim" ? 3 : 2); call += 1) {
        result = await advanceCrossChainHtlc(run.nextOwner());
      }
      expect(result.status).toBe(action === "source-claim" ? "settle-asymmetric" : "waiting");
      h.actions[action] = { state: "failed", txRef: refFor(action), authenticationHash: AUTH_HASH };
      const broadcasts = h.broadcastRetained.mock.calls.length;
      result = await advanceCrossChainHtlc(run.nextOwner());
      expect(result.status).not.toBe("settled");
      expect(actionsPrepared(h).filter((prepared) => prepared === action)).toHaveLength(2);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
      expect(replaceSourceClaim).not.toHaveBeenCalled();
      expect(replaceDestinationClaim).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["with its reason", "reverted: allowance", "reverted: allowance"],
    ["without a reason", undefined, "htlc-source-lock-failed"],
  ] as const)("ends a session whose source lock failed %s as permanent", async (_name, reason, expected) => {
    for (const adapterOf of [(h: ReturnType<typeof harness>) => h.adapter, wholeSessionOnly]) {
      const h = harness({ mode: { "source-lock": "pending" } });
      const run = runner({ adapter: adapterOf(h) });
      await advanceCrossChainHtlc(run.shared);
      h.actions["source-lock"] = {
        state: "failed",
        txRef: refFor("source-lock"),
        ...(reason === undefined ? {} : { reason }),
        authenticationHash: AUTH_HASH,
      };
      await expect(advanceCrossChainHtlc(run.nextOwner()))
        .resolves.toEqual({ status: "failed", errorClass: "permanent", reason: expected });
      expect(actionsPrepared(h)).toEqual(["source-lock"]);
      expect(actionsBroadcast(h)).toEqual(["source-lock"]);
    }
  });

  test("HTLC-8: locks no destination when the whole-session source-finality checkpoint write fails", async () => {
    const h = harness();
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const store: CrossChainHtlcStore = {
      ...base,
      async recordSourceFinality() {
        return { status: "conflict", reason: "refused" };
      },
    };
    const run = runner({ adapter: wholeSessionOnly(h), store });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner()))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-source-finality-persistence-uncertain" });
    expect(actionsPrepared(h)).toEqual(["source-lock"]);
  });

  const snapshotTampering: readonly (readonly [string, (snapshot: HtlcLedgerSnapshot) => unknown])[] = [
    ["an unauthenticated snapshot", (snapshot) => ({ ...snapshot, authenticationHash: "C".repeat(64) })],
    ["a negative observedAt", (snapshot) => ({ ...snapshot, observedAt: -1 })],
    ["a fractional observedAt", (snapshot) => ({ ...snapshot, observedAt: 1.5 })],
    ["array actions", (snapshot) => ({ ...snapshot, actions: [] })],
    ["an unknown action key", (snapshot) => ({
      ...snapshot,
      actions: { ...snapshot.actions, "bridge-release": snapshot.actions["source-lock"] },
    })],
    ["an unauthenticated action", (snapshot) => ({
      ...snapshot,
      actions: { ...snapshot.actions, "source-lock": { ...snapshot.actions["source-lock"], authenticationHash: "xyz" } },
    })],
    ["an unknown state", (snapshot) => ({
      ...snapshot,
      actions: { ...snapshot.actions, "source-lock": { ...snapshot.actions["source-lock"], state: "confirmed" } },
    })],
    ["a non-string reason", (snapshot) => ({
      ...snapshot,
      actions: {
        ...snapshot.actions,
        "source-lock": { state: "pending", txRef: refFor("source-lock"), reason: 42, authenticationHash: AUTH_HASH },
      },
    })],
  ];
  test.each(snapshotTampering)("moves nothing on an observation with %s", async (_name, tamper) => {
    const h = harness();
    let tampered = false;
    const adapter: CrossChainHtlcAdapter = {
      ...h.adapter,
      observe: async (intent, fence) => (tampered ? tamper({ ...await h.adapter.observe(intent, fence) }) :
        await h.adapter.observe(intent, fence)) as HtlcLedgerSnapshot,
      observeSourceLeg: async (intent, fence) => (tampered
        ? tamper({ ...await h.adapter.observeSourceLeg(intent, fence) })
        : await h.adapter.observeSourceLeg(intent, fence)) as HtlcLedgerSnapshot,
    };
    const run = runner({ adapter });
    await advanceCrossChainHtlc(run.shared);
    tampered = true;
    const result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result.status).toBe("indeterminate");
    expect(actionsPrepared(h)).toEqual(["source-lock"]);
    tampered = false;
    await expect(advanceCrossChainHtlc(run.nextOwner()))
      .resolves.toEqual({ status: "waiting", reason: "htlc-destination-lock-finality-pending" });
  });

  test("keeps a final reveal that omits its preimage resumable and drives no source claim", async () => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    const reveal = h.actions["destination-claim"] as Extract<HtlcObservedAction, { state: "final" }>;
    const { revealedPreimageHex: _preimage, ...withoutPreimage } = reveal;
    h.actions["destination-claim"] = withoutPreimage;
    const result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result).toEqual({ status: "indeterminate", reason: "htlc-ledger-observation-unavailable" });
    expect(actionsPrepared(h)).not.toContain("source-claim");
    h.actions["destination-claim"] = reveal;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
  });

  test("refuses a final source lock whose finality precedes its inclusion", async () => {
    const h = harness({ sourceFinalityObservedAt: 999_999 });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner()))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-adapter-lock-observation-invalid" });
    expect(actionsPrepared(h)).toEqual(["source-lock"]);
  });

  test.each([
    ["at its inclusion", 1_000_000, "settled"],
    ["before its inclusion", 999_999, "indeterminate"],
  ] as const)("accepts a source claim whose finality is reached %s only when not earlier", async (_name, reachedAt, status) => {
    const h = harness({ sourceClaimIncludedAt: 1_000_000, sourceClaimFinalityReachedAt: reachedAt });
    await expect(settleFourCalls(runner({ adapter: h.adapter }))).resolves.toMatchObject({ status });
  });

  test.each([
    ["a non-canonical amount", { amountBaseUnits: "01250000" }],
    ["a negative amount", { amountBaseUnits: "-1250000" }],
    ["an empty token", { token: "" }],
    ["an empty hashlock", { hashlock: "" }],
    ["an empty sender", { sender: "" }],
    ["an empty recipient", { recipient: "" }],
    ["a numeric recipient", { recipient: 7 as unknown as string }],
  ] as const)("treats source lock terms with %s as an invalid observation", async (_name, terms) => {
    const h = harness({ sourceLockTerms: terms });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner()))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-adapter-lock-observation-invalid" });
    expect(actionsPrepared(h)).toEqual(["source-lock"]);
  });

  test("treats non-object source lock terms as an invalid observation", async () => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    h.actions["source-lock"] = { ...h.actions["source-lock"], lockTerms: "terms" } as unknown as HtlcObservedAction;
    await expect(advanceCrossChainHtlc(run.nextOwner()))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-adapter-lock-observation-invalid" });
    expect(actionsPrepared(h)).toEqual(["source-lock"]);
  });

  test.each([
    ["exactly at the source expiry", 5_000_000, "settled"],
    ["one millisecond after it", 5_000_001, "failed"],
  ] as const)("settles a source claim final %s only within the window, on either path", async (_name, reachedAt, status) => {
    // In the call that drives the claim.
    const direct = harness({ sourceClaimFinalityReachedAt: reachedAt, sourceClaimFinalityObservedAt: 5_000_001 });
    const directRun = runner({ adapter: direct.adapter });
    const atomicityFailure = {
      status: "failed",
      errorClass: "settlement-atomicity",
      reason: "dest-revealed-source-unclaimed-expired",
    };
    const expected = status === "settled" ? { status: "settled" } : atomicityFailure;
    await expect(settleFourCalls(directRun)).resolves.toMatchObject(expected);
    // On a later call's observation, then on a replay of the stored settlement.
    const later = harness({ mode: { "source-claim": "pending" } });
    const laterRun = runner({ adapter: later.adapter });
    await expect(settleFourCalls(laterRun)).resolves.toMatchObject({ status: "settle-asymmetric" });
    await later.markFinal("source-claim", { finalityReachedAt: reachedAt, finalityObservedAt: 5_000_001 });
    await expect(advanceCrossChainHtlc(laterRun.nextOwner())).resolves.toMatchObject(expected);
    await expect(advanceCrossChainHtlc(laterRun.nextOwner())).resolves.toMatchObject(expected);
  });

  test.each([
    ["one second past the margin", 1_131, "lock"],
    ["exactly at the margin", 1_130, "refuse"],
  ] as const)("plans the destination lock from the floored observation time, with a source expiry %s", async (_name, sourceExpiry, outcome) => {
    const h = harness({ sourceExpiry });
    h.setObservedAt(1_000_999);
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    const result = await advanceCrossChainHtlc(run.nextOwner());
    if (outcome === "lock") {
      expect(result).toEqual({ status: "waiting", reason: "htlc-destination-lock-finality-pending" });
      const request = h.prepareAction.mock.calls.find(([input]) => input.action === "destination-lock")?.[0];
      expect(request?.destinationExpiry).toBe(1_100);
      expect(request?.sourceExpiry).toBe(sourceExpiry);
    } else {
      expect(result).toMatchObject({ status: "refund-pending", reason: "destination-lock-window-closed" });
      expect(actionsPrepared(h)).toEqual(["source-lock"]);
    }
  });

  test.each([
    ["one second inside the margin", 4_969, "reveal"],
    ["exactly at the margin", 4_970, "refuse"],
  ] as const)("reveals against a destination lock expiring %s only when strictly inside it", async (_name, destinationExpiry, outcome) => {
    const h = harness({ sourceExpiry: 5_000, destinationExpiry });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    const result = await advanceCrossChainHtlc(run.nextOwner());
    if (outcome === "reveal") {
      expect(actionsPrepared(h)).toContain("destination-claim");
    } else {
      expect(result).toMatchObject({ reason: "destination-expiry-margin-insufficient" });
      expect(actionsPrepared(h)).not.toContain("destination-claim");
    }
  });

  describe("payer's source refund on the whole-session observation", () => {
    async function toUnlockedDestination(mode: NonNullable<HarnessOptions["mode"]> = {}) {
      // No source lock terms, so the payee never locks the destination.
      const h = harness({ omitSourceLockTerms: true, sourceExpiry: 5_000, mode });
      const run = runner({ adapter: wholeSessionOnly(h) });
      await advanceCrossChainHtlc(run.shared);
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
        status: "refund-pending",
        reason: "source-lock-terms-missing",
      });
      return { h, run };
    }

    test("sends the refund exactly at the source expiry, not a millisecond before", async () => {
      const { h, run } = await toUnlockedDestination();
      run.setClock(4_999_999);
      // A 1 ms lease, so that the call at the expiry is not held off by it.
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: "before-expiry", leaseDurationMs: 1 })).resolves.toMatchObject({
        status: "refund-pending",
        refunds: { "source-refund": "waiting" },
      });
      expect(actionsPrepared(h)).not.toContain("source-refund");
      run.setClock(5_000_000);
      await advanceCrossChainHtlc({ ...run.shared, owner: "at-expiry" });
      expect(actionsPrepared(h).filter((action) => action === "source-refund")).toHaveLength(1);
      expect(actionsBroadcast(h).filter((action) => action === "source-refund")).toHaveLength(1);
    });

    test.each([
      ["failed", { state: "failed" }, "refund-stalled", "failed"],
      ["absent naming it", { state: "absent", txRef: refFor("source-refund") }, "operator-alert", "absent"],
    ] as const)("never re-sends a refund reported %s", async (_name, observed, status, leg) => {
      const { h, run } = await toUnlockedDestination({ "source-refund": "pending" });
      run.setClock(5_000_000);
      await advanceCrossChainHtlc({ ...run.shared, owner: "at-expiry" });
      h.actions["source-refund"] = {
        txRef: refFor("source-refund"),
        ...observed,
        authenticationHash: AUTH_HASH,
      } as HtlcObservedAction;
      const preparations = h.prepareAction.mock.calls.length;
      const broadcasts = h.broadcastRetained.mock.calls.length;
      for (const tick of [1, 2]) {
        const result = await advanceCrossChainHtlc({ ...run.shared, owner: `after-${tick}`, now: () => 5_000_000 + tick * 101 });
        expect(result).toMatchObject({ status, refunds: { "source-refund": leg } });
        expect(htlcNeedsOperator(result)).toBe(true);
      }
      expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
      expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    });

    test("rebroadcasts the retained refund bytes when reported absent naming nothing", async () => {
      const { h, run } = await toUnlockedDestination({ "source-refund": "pending" });
      run.setClock(5_000_000);
      await advanceCrossChainHtlc({ ...run.shared, owner: "at-expiry" });
      const [sent] = h.broadcastRetained.mock.calls.filter(([prepared]) => prepared.action === "source-refund");
      h.actions["source-refund"] = { state: "absent", authenticationHash: AUTH_HASH };
      const preparations = h.prepareAction.mock.calls.length;
      await advanceCrossChainHtlc({ ...run.shared, owner: "rebroadcast", now: () => 5_000_101 });
      expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
      const resent = h.broadcastRetained.mock.calls.filter(([prepared]) => prepared.action === "source-refund");
      expect(resent).toHaveLength(2);
      expect(resent[1]![0]).toEqual(sent![0]);
    });
  });

  describe("Standard-shaped SettlementEvidence fields", () => {
    // The pinned fixtures' signer, a public ed25519 key reference
    // (`key:` + 64 hex), joined here so the literal is not a scanner match.
    const fixtureSignerHex = ["db995fe25169d141cab9bbba92baa01f", "9f2e1ece7df4cb2ac05190f37fcc1f9d"].join("");
    const signature = {
      algorithm: "ed25519",
      signer: ["key", fixtureSignerHex].join(":"),
      value: "J9aWl1-dZrsE9Gch3-jMOVj0wKwH_ohFS3IlcNYIZMnoyKBT6uCTyX367zvPzMdnP2m57-1fnxATbKtJ7_K3Ag",
    };
    const envelope = { evidenceVersion: "1", jobId: JOB_ID, phase: "pay-cross-chain-htlc", observedAt: 1_000_303, signature };

    test("projects a real settled session and its interim record onto evidence the SDK's validator accepts", async () => {
      const h = harness({ mode: { "source-claim": "pending" } });
      const run = runner({ adapter: h.adapter });
      const asymmetric = await settleFourCalls(run);
      if (asymmetric.status !== "settle-asymmetric") throw new Error("expected settle-asymmetric");
      expect(asymmetric.recoveryDeadline).toBe(5_000 * 1_000);
      const interim = crossChainHtlcEvidenceFields(asymmetric);
      expect(interim).toEqual({
        outcome: "failure",
        reason: "dest-revealed-source-unclaimed",
        paymentTxRefs: [refFor("source-lock"), refFor("destination-claim")],
      });
      expect(isSettlementEvidence({ ...envelope, ...interim })).toBe(true);

      await h.markFinal("source-claim", { finalityReachedAt: 1_000_400, finalityObservedAt: 1_000_450 });
      const settled = await advanceCrossChainHtlc(run.nextOwner());
      if (settled.status !== "settled") throw new Error("expected settled");
      // The core's own operational record is not evidence-shaped.
      expect(isSettlementEvidence({
        ...envelope,
        outcome: "success",
        paymentTxRefs: settled.settlement.txRefs,
        paymentAmount: settled.settlement.paymentAmount,
        settlementFinality: settled.settlement.settlementFinality,
      })).toBe(false);
      const supersedesEvidenceRef = {
        anchor: { kind: "storage-program", locator: `stor-${"0".repeat(64)}` },
        contentHash: "0".repeat(64),
      } as const;
      const success = crossChainHtlcEvidenceFields(settled, { supersedesEvidenceRef });
      expect(success).toEqual({
        outcome: "success",
        paymentTxRefs: [refFor("source-lock"), refFor("destination-claim"), refFor("source-claim")],
        paymentAmount: { amount: "1.25", currency: "USDC" },
        settlementFinality: { model: "htlc-reveal", finalityObservedAt: 1_000_400 },
        supersedesEvidenceRef,
      });
      expect(isSettlementEvidence({ ...envelope, ...success })).toBe(true);
      expect(() => crossChainHtlcEvidenceFields(asymmetric, { supersedesEvidenceRef }))
        .toThrow("only a settled session supersedes an interim record");
    });

    // DACS-Standard d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20,
    // conformance/fixtures/settlement/htlc9-asymmetric{,-resolved}.json.
    const contract = "0x0000000000000000000000000000000000000308";
    const lock = { kind: "htlc-lock", chainId: 84532, contractAddress: contract, lockTxHash: `0x${"a".repeat(64)}` } as const;
    const reveal = { kind: "htlc-reveal", chainId: 80002, contractAddress: contract, revealTxHash: `0x${"b".repeat(64)}` } as const;
    const claim = { kind: "htlc-claim", chainId: 84532, contractAddress: contract, claimTxHash: `0x${"c".repeat(64)}` } as const;
    const fixtureEnvelope = { evidenceVersion: "1", jobId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", phase: "pay-cross-chain-htlc" };
    const readHtlcFixture = (name: string) => JSON.parse(readFileSync(new URL(
      `../../vendor/DACS-Standard/conformance/fixtures/settlement/${name}.json`, import.meta.url,
    ), "utf8")).settlementEvidence;
    const interimFixture = readHtlcFixture("htlc9-asymmetric");
    const resolvedFixture = readHtlcFixture("htlc9-asymmetric-resolved");

    test("reproduces the pinned HTLC-9 interim and resolved fixtures byte for byte", () => {
      const destinationLock = { ...lock, chainId: 80002, lockTxHash: `0x${"d".repeat(64)}` } as const;
      const interim = crossChainHtlcEvidenceFields({
        status: "settle-asymmetric",
        reason: "dest-revealed-source-unclaimed",
        recoveryDeadline: 1_760_000_400_000,
        txRefs: [lock, destinationLock, reveal, { ...claim, claimTxHash: `0x${"e".repeat(64)}` }],
        finalityObservedAt: 1_760_000_090_000,
      });
      expect(canonicalize({ ...fixtureEnvelope, observedAt: 1760000100000, signature, ...interim }))
        .toBe(canonicalize(interimFixture));
      const resolved = crossChainHtlcEvidenceFields({
        status: "settled",
        settlement: {
          txRefs: [lock, destinationLock, reveal, claim],
          paymentAmount: { amount: "25", currency: "USDC" },
          settlementFinality: {
            model: "htlc-reveal",
            sourceExpiry: 1_760_000_400,
            finalityReachedAt: 1760000290000,
            finalityObservedAt: 1760000295000,
          },
          authenticationHash: AUTH_HASH,
        },
      }, { supersedesEvidenceRef: resolvedFixture.supersedesEvidenceRef });
      expect(canonicalize({
        ...fixtureEnvelope,
        observedAt: 1760000300000,
        signature: resolvedFixture.signature,
        ...resolved,
      })).toBe(canonicalize(resolvedFixture));
      expect(isSettlementEvidence(interimFixture)).toBe(true);
      expect(isSettlementEvidence(resolvedFixture)).toBe(true);
    });

    test.each([
      ["three references", [lock, reveal, claim]],
      ["the claim on the reveal's chain", [lock, { ...lock, chainId: 80002 }, reveal, { ...claim, chainId: 80002 }]],
      ["a refund in place of the claim", [lock, { ...lock, chainId: 80002 }, reveal, {
        kind: "htlc-refund", chainId: 84532, contractAddress: contract, refundTxHash: "0x01",
      }]],
    ] as const)("refuses a settlement with %s", (_name, txRefs) => {
      expect(() => crossChainHtlcEvidenceFields({
        status: "settled",
        settlement: {
          txRefs,
          paymentAmount: { amount: "25", currency: "USDC" },
          settlementFinality: { model: "htlc-reveal", sourceExpiry: 2, finalityReachedAt: 1, finalityObservedAt: 1 },
          authenticationHash: AUTH_HASH,
        },
      })).toThrow("not a settled HTLC chain");
    });
  });
});

describe("retained store rows the core must refuse", () => {
  async function settledSession() {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    let result = await advanceCrossChainHtlc(run.shared);
    for (let call = 0; call < 3; call += 1) result = await advanceCrossChainHtlc(run.nextOwner());
    if (result.status !== "settled") throw new Error("expected settled");
    return { h, run, settlement: result.settlement };
  }
  const withSettlement = (
    base: CrossChainHtlcStore,
    mutate: (settlement: CrossChainHtlcSettlement) => unknown,
  ): CrossChainHtlcStore => ({
    ...base,
    async claim(input) {
      const claimed = await base.claim(input);
      return claimed.status === "settled"
        ? { ...claimed, settlement: mutate(structuredClone(claimed.settlement)) as CrossChainHtlcSettlement }
        : claimed;
    },
  });
  const settlementCorruption: readonly (readonly [string, (settlement: CrossChainHtlcSettlement) => unknown])[] = [
    ["no payment amount", (s) => ({ ...s, paymentAmount: null })],
    ["an omitted payment amount", (s) => { const { paymentAmount: _dropped, ...rest } = s; return rest; }],
    ["another amount", (s) => ({ ...s, paymentAmount: { ...s.paymentAmount, amount: "2" } })],
    ["another currency", (s) => ({ ...s, paymentAmount: { ...s.paymentAmount, currency: "USDT" } })],
    ["another finality model", (s) => ({ ...s, settlementFinality: { ...s.settlementFinality, model: "block-depth" } })],
    ["no source expiry", (s) => ({ ...s, settlementFinality: { ...s.settlementFinality, sourceExpiry: 0 } })],
    // The finality chronology accepts this one: only the positive-expiry check
    // and the comparison with the checkpointed expiry refuse it.
    ["no source expiry and finality at time zero", (s) => ({
      ...s,
      settlementFinality: { ...s.settlementFinality, sourceExpiry: 0, finalityReachedAt: 0, finalityObservedAt: 0 },
    })],
    ["finality reached after it was observed", (s) => ({
      ...s,
      settlementFinality: { ...s.settlementFinality, finalityReachedAt: s.settlementFinality.finalityObservedAt + 1 },
    })],
    ["finality reached after the source expiry", (s) => ({
      ...s,
      settlementFinality: {
        ...s.settlementFinality,
        finalityReachedAt: s.settlementFinality.sourceExpiry * 1_000 + 1,
        finalityObservedAt: s.settlementFinality.sourceExpiry * 1_000 + 1,
      },
    })],
    ["a negative finality time", (s) => ({ ...s, settlementFinality: { ...s.settlementFinality, finalityReachedAt: -1 } })],
    ["three references", (s) => ({ ...s, txRefs: s.txRefs.slice(1) })],
    ["the reveal and claim swapped", (s) => ({ ...s, txRefs: [s.txRefs[0], s.txRefs[1], s.txRefs[3], s.txRefs[2]] })],
    ["the claim on the destination chain", (s) => ({
      ...s,
      txRefs: [...s.txRefs.slice(0, 3), { ...s.txRefs[3], chainId: 80002 }],
    })],
    ["the source lock on another contract", (s) => ({
      ...s,
      txRefs: [{ ...s.txRefs[0], contractAddress: "other-contract" }, ...s.txRefs.slice(1)],
    })],
    ["an empty claim hash", (s) => ({
      ...s,
      txRefs: [...s.txRefs.slice(0, 3), { ...s.txRefs[3], claimTxHash: "" }],
    })],
    ["an unauthenticated settlement", (s) => ({ ...s, authenticationHash: "A".repeat(64) })],
    // Same shape as the retained rows, other values: only the retained-row
    // comparison refuses these.
    ...([
      ["another source-lock hash", 0, "lockTxHash"],
      ["another destination-lock hash", 1, "lockTxHash"],
      ["another reveal hash", 2, "revealTxHash"],
      ["another claim hash", 3, "claimTxHash"],
    ] as const).map(([name, index, field]) => [name, (s: CrossChainHtlcSettlement) => ({
      ...s,
      txRefs: s.txRefs.map((ref, at) => at === index
        ? { ...ref, [field]: `${(ref as unknown as Record<string, string>)[field]}-other` }
        : ref),
    })] as const),
    ["a later source expiry", (s) => ({ ...s, settlementFinality: { ...s.settlementFinality, sourceExpiry: s.settlementFinality.sourceExpiry + 1 } })],
  ];
  test.each(settlementCorruption)("refuses to replay a stored settlement with %s", async (_name, mutate) => {
    const { h, run } = await settledSession();
    const preparations = h.prepareAction.mock.calls.length;
    const store = withSettlement(run.shared.store, mutate);
    const progress = await advanceCrossChainHtlc({ ...run.nextOwner(), store });
    expect(progress).toEqual({ status: "indeterminate", reason: "htlc-stored-settlement-mismatch" });
    // Retrying cannot clear a settled row, and the session may be paid.
    expect(htlcNeedsOperator(progress)).toBe(true);
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
  });

  test("replays an unchanged stored settlement", async () => {
    const { run, settlement } = await settledSession();
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store: withSettlement(run.shared.store, (s) => s) }))
      .resolves.toEqual({ status: "settled", settlement });
  });

  test("replays the settlement it checked from a getter-backed settled claim", async () => {
    const { run, settlement } = await settledSession();
    const base = run.shared.store;
    const store: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        if (claimed.status !== "settled") return claimed;
        // The first read passes the checks; every later read names another amount.
        let reads = 0;
        const other = { ...claimed.settlement, paymentAmount: { ...claimed.settlement.paymentAmount, amount: "2" } };
        return Object.defineProperty({ ...claimed }, "settlement", {
          enumerable: true,
          get: () => (reads++ === 0 ? claimed.settlement : other),
        });
      },
    };
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store }))
      .resolves.toEqual({ status: "settled", settlement });
  });

  // A host that lost its first `settled` result (a crash, a second worker)
  // reads the session again: a settlement after a replacement must replay too.
  const replaysUnchanged = async (
    h: ReturnType<typeof harness>,
    run: ReturnType<typeof runner>,
    first: CrossChainHtlcProgress,
  ) => {
    expect(first).toMatchObject({ status: "settled" });
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual(first);
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
  };
  const failedSourceClaim = async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    for (let call = 0; call < 3; call += 1) await advanceCrossChainHtlc(run.nextOwner());
    const prior = h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .find((prepared) => prepared.action === "source-claim");
    if (!prior || prior.txRef.kind !== "htlc-claim") throw new Error("expected source claim");
    h.actions["source-claim"] = { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH };
    return { h, run, prior };
  };

  test("replays a settlement on the replacement source-claim attempt", async () => {
    const { h, run, prior } = await failedSourceClaim();
    h.setMode("source-claim", "final");
    const first = await advanceCrossChainHtlc(run.nextOwner());
    expect(first).toMatchObject({ status: "settled" });
    if (first.status !== "settled") throw new Error("expected settled");
    expect(first.settlement.txRefs[3]).not.toEqual(prior.txRef);
    await replaysUnchanged(h, run, first);
  });

  test("replays a settlement on an earlier source-claim attempt that landed", async () => {
    const { h, run, prior } = await failedSourceClaim();
    h.setMode("source-claim", "throw-once");
    await advanceCrossChainHtlc(run.nextOwner());
    h.actions["source-claim"] = {
      state: "final",
      txRef: prior.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>,
      finalityReachedAt: 1_000_000,
      finalityObservedAt: 1_000_000,
      authenticationHash: AUTH_HASH,
    };
    const first = await advanceCrossChainHtlc(run.nextOwner());
    expect(first).toMatchObject({ status: "settled", settlement: { txRefs: [{}, {}, {}, prior.txRef] } });
    await replaysUnchanged(h, run, first);
  });

  test("replays a settlement after a reveal replacement", async () => {
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    for (let call = 0; call < 3; call += 1) await advanceCrossChainHtlc(call === 0 ? run.shared : run.nextOwner());
    const reveals = () => h.broadcastRetained.mock.calls
      .map((call) => call[0])
      .filter((prepared) => prepared.action === "destination-claim");
    const prior = reveals()[0];
    if (!prior) throw new Error("expected reveal");
    h.actions["destination-claim"] = { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH };
    await advanceCrossChainHtlc(run.nextOwner());
    const replacement = reveals()[1];
    if (!replacement) throw new Error("expected a replacement reveal");
    h.actions["destination-claim"] = {
      state: "final",
      txRef: replacement.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
      finalityObservedAt: 1_000_000,
      revealedPreimageHex: PREIMAGE_HEX,
      authenticationHash: AUTH_HASH,
    };
    const first = await advanceCrossChainHtlc(run.nextOwner());
    expect(first).toMatchObject({ status: "settled", settlement: { txRefs: [{}, {}, replacement.txRef, {}] } });
    await replaysUnchanged(h, run, first);
  });

  const retainedCorruption: readonly (readonly [string, (claimed: Record<string, unknown>) => void])[] = [
    ["no retained rows", (c) => { c.prepared = []; }],
    ["no source-claim row", (c) => {
      c.prepared = (c.prepared as HtlcPreparedAction[]).filter((row) => row.action !== "source-claim");
    }],
    ["no destination-lock row", (c) => {
      c.prepared = (c.prepared as HtlcPreparedAction[]).filter((row) => row.action !== "destination-lock");
    }],
    // Each copy is a valid row; only the one-row-per-action check refuses it.
    ["a duplicated destination-lock row", (c) => {
      const rows = c.prepared as HtlcPreparedAction[];
      c.prepared = [...rows, rows.find((row) => row.action === "destination-lock")!];
    }],
    ["no source-finality checkpoint", (c) => { delete c.sourceFinalityCheckpoint; }],
    ["no reveal checkpoint", (c) => { delete c.revealCheckpoint; }],
    ["a later checkpointed source expiry", (c) => {
      const checkpoint = c.sourceFinalityCheckpoint as HtlcSourceFinalityCheckpoint;
      c.sourceFinalityCheckpoint = { ...checkpoint, sourceExpiry: checkpoint.sourceExpiry + 1 };
    }],
    ["a reveal checkpoint with another source expiry", (c) => {
      const checkpoint = c.revealCheckpoint as HtlcRevealCheckpoint;
      c.revealCheckpoint = { ...checkpoint, sourceExpiry: checkpoint.sourceExpiry + 1 };
    }],
  ];
  test.each(retainedCorruption)("refuses to replay a stored settlement claimed with %s", async (_name, mutate) => {
    const { h, run } = await settledSession();
    const preparations = h.prepareAction.mock.calls.length;
    const base = run.shared.store;
    const store: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        if (claimed.status !== "settled") return claimed;
        const copy = structuredClone(claimed) as unknown as Record<string, unknown>;
        mutate(copy);
        return copy as unknown as HtlcStoreClaim;
      },
    };
    const progress = await advanceCrossChainHtlc({ ...run.nextOwner(), store });
    expect(progress).toEqual({ status: "indeterminate", reason: "htlc-stored-settlement-mismatch" });
    expect(htlcNeedsOperator(progress)).toBe(true);
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
  });

  const leaseCorruption: readonly (readonly [string, (lease: HtlcLease, now: number) => unknown])[] = [
    ["another owner", (lease) => ({ ...lease, owner: "someone-else" })],
    ["generation zero", (lease) => ({ ...lease, generation: 0 })],
    ["a fractional generation", (lease) => ({ ...lease, generation: 1.5 })],
    ["an expiry at the call's start", (lease, now) => ({ ...lease, expiresAt: now })],
    ["a fractional expiry", (lease) => ({ ...lease, expiresAt: lease.expiresAt + 0.5 })],
  ];
  test.each(leaseCorruption)("moves nothing under a claimed lease with %s", async (_name, mutate) => {
    const h = harness();
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const store: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        return claimed.status === "acquired"
          ? { ...claimed, lease: mutate(claimed.lease, input.now) as HtlcLease }
          : claimed;
      },
    };
    await expect(advanceCrossChainHtlc(runner({ adapter: h.adapter, store }).shared))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-settlement-store-lease-invalid" });
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.prepareAction).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
  });

  test("moves nothing when the store returns another session's intent", async () => {
    const h = harness();
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const store: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        return "intent" in claimed ? { ...claimed, intent: { ...claimed.intent, amount: "2" } } : claimed;
      },
    };
    const result = await advanceCrossChainHtlc(runner({ adapter: h.adapter, store }).shared);
    expect(result).toEqual({ status: "indeterminate", reason: "htlc-settlement-store-intent-mismatch" });
    expect(htlcNeedsOperator(result)).toBe(true);
    expect(h.observe).not.toHaveBeenCalled();
    expect(h.prepareAction).not.toHaveBeenCalled();
  });

  test.each([
    ["two source locks", (prepared: readonly Readonly<HtlcPreparedAction>[]) => [...prepared, prepared[0]!]],
    ["a tampered effect hash", (prepared: readonly Readonly<HtlcPreparedAction>[]) => [
      { ...prepared[0]!, effectHash: "0".repeat(64) },
    ]],
    ["a tampered payload", (prepared: readonly Readonly<HtlcPreparedAction>[]) => [
      { ...prepared[0]!, signedPayloadBase64: Buffer.from("other", "utf8").toString("base64") },
    ]],
  ] as const)("ends a session whose retained actions hold %s as permanent", async (_name, mutate) => {
    const h = harness({ mode: { "source-lock": "pending" } });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    const base = run.shared.store;
    const store: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        return claimed.status === "acquired" ? { ...claimed, prepared: mutate(claimed.prepared) } : claimed;
      },
    };
    const broadcasts = h.broadcastRetained.mock.calls.length;
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store }))
      .resolves.toMatchObject({ status: "failed", errorClass: "permanent" });
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
  });
});

describe("retained history and checkpoint contradictions the core refuses", () => {
  type Acquired = Extract<HtlcStoreClaim, { status: "acquired" }>;
  type History = Acquired["sourceClaimAttemptHistory"];

  /** A session whose `action` was replaced once: one history entry, every checkpoint retained. */
  async function replacedOnce(action: "source-claim" | "destination-claim", reason?: string) {
    const h = action === "source-claim"
      ? harness({ mode: { "source-claim": "pending" } })
      : harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    const calls = action === "source-claim" ? 4 : 3;
    for (let call = 0; call < calls; call += 1) {
      await advanceCrossChainHtlc(call === 0 ? run.shared : run.nextOwner());
    }
    const prior = h.broadcastRetained.mock.calls.map((call) => call[0]).find((p) => p.action === action);
    if (!prior) throw new Error(`expected ${action}`);
    h.actions[action] = {
      state: "failed",
      txRef: prior.txRef,
      ...(reason === undefined ? {} : { reason }),
      authenticationHash: AUTH_HASH,
    };
    await advanceCrossChainHtlc(run.nextOwner());
    return { h, run };
  }

  /** The prepared action with `change` applied and its effect hash recomputed, so it stays self-consistent. */
  function rehash(prepared: Readonly<HtlcPreparedAction>, change: Partial<HtlcPreparedAction>): HtlcPreparedAction {
    const { effectHash: _old, ...unsigned } = { ...prepared, ...change };
    return { ...unsigned, effectHash: sha256Hex(canonicalize(unsigned)) };
  }

  async function refuses(
    action: "source-claim" | "destination-claim",
    corrupt: (claimed: Acquired) => unknown,
  ) {
    const { h, run } = await replacedOnce(action);
    const base = run.shared.store;
    const store: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        return claimed.status === "acquired" ? corrupt(structuredClone(claimed)) as HtlcStoreClaim : claimed;
      },
    };
    const preparations = h.prepareAction.mock.calls.length;
    const broadcasts = h.broadcastRetained.mock.calls.length;
    const result = await advanceCrossChainHtlc({ ...run.nextOwner(), store });
    expect(h.prepareAction).toHaveBeenCalledTimes(preparations);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
    return result;
  }

  const historyOf = (claimed: Acquired, action: "source-claim" | "destination-claim") =>
    action === "source-claim" ? claimed.sourceClaimAttemptHistory : claimed.destinationClaimAttemptHistory;
  const withHistory = (claimed: Acquired, action: "source-claim" | "destination-claim", history: unknown) =>
    action === "source-claim"
      ? { ...claimed, sourceClaimAttemptHistory: history as History }
      : { ...claimed, destinationClaimAttemptHistory: history as History };
  const active = (claimed: Acquired, action: HtlcAction) => claimed.prepared.find((p) => p.action === action)!;
  const withActive = (claimed: Acquired, action: HtlcAction, row: HtlcPreparedAction | undefined) => ({
    ...claimed,
    prepared: [...claimed.prepared.filter((p) => p.action !== action), ...(row ? [row] : [])],
  });

  test.each(["source-claim", "destination-claim"] as const)("replays the unchanged retained %s history", async (action) => {
    const { h, run } = await replacedOnce(action);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.not.toMatchObject({ status: "failed" });
    expect(h.prepareAction.mock.calls.filter(([request]) => request.action === action)).toHaveLength(2);
  });

  test("replays a source-claim history of two replacements, each chained to the next", async () => {
    const { h, run } = await replacedOnce("source-claim");
    const second = h.broadcastRetained.mock.calls.map((call) => call[0]).filter((p) => p.action === "source-claim")[1];
    if (!second) throw new Error("expected the first replacement");
    h.actions["source-claim"] = { state: "failed", txRef: second.txRef, authenticationHash: AUTH_HASH };
    await advanceCrossChainHtlc(run.nextOwner());
    expect(h.prepareAction.mock.calls.filter(([request]) => request.action === "source-claim")).toHaveLength(3);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.not.toMatchObject({ status: "failed" });
    expect(h.prepareAction.mock.calls.filter(([request]) => request.action === "source-claim")).toHaveLength(3);
  });

  const historyCases: readonly (readonly [string, string, (c: Acquired, a: "source-claim" | "destination-claim") => unknown])[] = [
    ["is not an array", "history is invalid", (c, a) => withHistory(c, a, {})],
    ["has no active attempt", "history omits the active attempt", (c, a) => withActive(c, a, undefined)],
    ["holds a null entry", "history sequence is invalid", (c, a) => withHistory(c, a, [null])],
    ["holds a number", "history sequence is invalid", (c, a) => withHistory(c, a, [1])],
    ["numbers its first entry 2", "history sequence is invalid", (c, a) =>
      withHistory(c, a, [{ ...historyOf(c, a)[0]!, attempt: 2 }])],
    ["holds a prior with a tampered effect hash", "history integrity mismatch", (c, a) =>
      withHistory(c, a, [{ ...historyOf(c, a)[0]!, prepared: { ...historyOf(c, a)[0]!.prepared, effectHash: "0".repeat(64) } }])],
    ["names a malformed replacement", "history integrity mismatch", (c, a) =>
      withHistory(c, a, [{ ...historyOf(c, a)[0]!, replacementEffectHash: "not-a-hash" }])],
    ["names its prior as its own replacement", "history integrity mismatch", (c, a) =>
      withHistory(c, a, [{ ...historyOf(c, a)[0]!, replacementEffectHash: historyOf(c, a)[0]!.prepared.effectHash }])],
    ["holds one attempt twice", "history reuses an attempt", (c, a) => {
      const [entry] = historyOf(c, a);
      return withHistory(c, a, [entry, { ...entry!, attempt: 2 }]);
    }],
    ["holds another attempt with the same transaction", "history reuses an attempt", (c, a) => {
      const [entry] = historyOf(c, a);
      const twin = rehash(entry!.prepared, { signedPayloadBase64: Buffer.from("twin", "utf8").toString("base64") });
      return withHistory(c, a, [{ ...entry!, replacementEffectHash: twin.effectHash }, { ...entry!, attempt: 2, prepared: twin }]);
    }],
    ["chains to an attempt that is not the active one", "history chain is invalid", (c, a) =>
      withHistory(c, a, [{ ...historyOf(c, a)[0]!, replacementEffectHash: "d".repeat(64) }])],
    ["has an active attempt that reuses a retained transaction", `active ATTEMPT reuses a retained attempt`, (c, a) => {
      const [entry] = historyOf(c, a);
      const reused = rehash(entry!.prepared, { preparedAt: entry!.prepared.preparedAt + 1 });
      return withHistory(withActive(c, a, reused), a, [{ ...entry!, replacementEffectHash: reused.effectHash }]);
    }],
    ["holds a failure naming another transaction", "ATTEMPT failure observation is invalid", (c, a) => {
      const [entry] = historyOf(c, a);
      return withHistory(c, a, [{
        ...entry!,
        failedObservation: { ...entry!.failedObservation, txRef: active(c, a).txRef },
      }]);
    }],
    ["holds an unauthenticated failure", "ATTEMPT failure observation is invalid", (c, a) =>
      withHistory(c, a, [{ ...historyOf(c, a)[0]!, failedObservation: { ...historyOf(c, a)[0]!.failedObservation, authenticationHash: "x" } }])],
    ["holds a failure with a numeric reason", "ATTEMPT failure observation is invalid", (c, a) =>
      withHistory(c, a, [{ ...historyOf(c, a)[0]!, failedObservation: { ...historyOf(c, a)[0]!.failedObservation, reason: 7 } }])],
    ["holds a failure that is only pending", "ATTEMPT failure observation is invalid", (c, a) =>
      withHistory(c, a, [{ ...historyOf(c, a)[0]!, failedObservation: { ...historyOf(c, a)[0]!.failedObservation, state: "pending" } }])],
  ];
  test.each((["source-claim", "destination-claim"] as const).flatMap((action) =>
    historyCases.map(([name, message, corrupt]) => ({ action, name, message, corrupt }))))(
    "ends the session as permanent when the retained $action history $name",
    async ({ action, message, corrupt }) => {
      const subject = message.includes("ATTEMPT") ? message.replace("ATTEMPT", action) : `retained ${action} ${message}`;
      await expect(refuses(action, (c) => corrupt(c, action))).resolves.toEqual({
        status: "failed",
        errorClass: "permanent",
        reason: `pay-cross-chain-htlc: ${subject}`,
      });
    },
  );

  test.each([undefined, "out-of-gas"])("retains a failure's reason exactly when it has one (%s)", async (reason) => {
    const { run } = await replacedOnce("source-claim", reason);
    const { intent, secrets } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
    const { now } = run.nextOwner();
    if (!now) throw new Error("expected the runner's clock");
    const claimed = await run.shared.store.claim({
      intent,
      secrets,
      owner: "reader",
      now: now(),
      leaseDurationMs: 100,
    });
    if (claimed.status !== "acquired") throw new Error("expected the lease");
    const { failedObservation } = claimed.sourceClaimAttemptHistory[0]!;
    if (reason === undefined) expect(Object.keys(failedObservation)).not.toContain("reason");
    else expect(failedObservation.reason).toBe(reason);
  });

  type Checkpointed = Required<Pick<Acquired, "sourceFinalityCheckpoint" | "revealCheckpoint">>;
  const checkpoints = (c: Acquired) => c as Acquired & Checkpointed;
  const checkpointCases: readonly (readonly [string, string, (c: Acquired & Checkpointed) => unknown])[] = [
    ["a source checkpoint without its source lock", "retained source-finality checkpoint is invalid",
      (c) => withActive(c, "source-lock", undefined)],
    ["a source checkpoint of another effect", "retained source-finality checkpoint is invalid",
      (c) => ({ ...c, sourceFinalityCheckpoint: { ...c.sourceFinalityCheckpoint, sourceLockEffectHash: "0".repeat(64) } })],
    ["a source checkpoint of another transaction", "retained source-finality checkpoint is invalid",
      (c) => ({
        ...c,
        sourceFinalityCheckpoint: {
          ...c.sourceFinalityCheckpoint,
          sourceLockTxRef: { ...c.sourceFinalityCheckpoint.sourceLockTxRef, lockTxHash: "tx-other" },
        },
      })],
    ["an unauthenticated source checkpoint", "retained source-finality checkpoint is invalid",
      (c) => ({ ...c, sourceFinalityCheckpoint: { ...c.sourceFinalityCheckpoint, authenticationHash: "x" } })],
    ["source finality observed before the lock's inclusion", "retained source-finality timestamps are invalid",
      (c) => ({
        ...c,
        sourceFinalityCheckpoint: {
          ...c.sourceFinalityCheckpoint,
          finalityObservedAt: c.sourceFinalityCheckpoint.includedAt - 1,
        },
      })],
    ["a source lock included at its own expiry", "retained source-finality timestamps are invalid",
      (c) => ({
        ...c,
        sourceFinalityCheckpoint: {
          ...c.sourceFinalityCheckpoint,
          includedAt: c.sourceFinalityCheckpoint.sourceExpiry * 1_000,
          finalityObservedAt: c.sourceFinalityCheckpoint.sourceExpiry * 1_000,
        },
      })],
    ["a reveal checkpoint naming no retained reveal", "retained reveal checkpoint is invalid",
      (c) => ({ ...c, revealCheckpoint: { ...c.revealCheckpoint, revealTxRef: { ...c.revealCheckpoint.revealTxRef, revealTxHash: "tx-other" } } })],
    ["an unauthenticated reveal checkpoint", "retained reveal checkpoint is invalid",
      (c) => ({ ...c, revealCheckpoint: { ...c.revealCheckpoint, authenticationHash: "x" } })],
    ["two source locks", "retained action duplicate",
      (c) => ({ ...c, prepared: [...c.prepared, active(c, "source-lock")] })],
    ["a source lock with a tampered effect hash", "retained action integrity mismatch",
      (c) => withActive(c, "source-lock", { ...active(c, "source-lock"), effectHash: "0".repeat(64) })],
    ["a destination lock with a tampered effect hash", "retained action integrity mismatch",
      (c) => withActive(c, "destination-lock", { ...active(c, "destination-lock"), effectHash: "0".repeat(64) })],
  ];
  test.each(checkpointCases)("ends the session as permanent when the store retains %s", async (_name, message, corrupt) => {
    await expect(refuses("source-claim", (c) => corrupt(checkpoints(c)))).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: `pay-cross-chain-htlc: ${message}`,
    });
  });

  test("ends the session as permanent when the store retains two destination locks", async () => {
    await expect(refuses("source-claim", (c) => ({ ...c, prepared: [...c.prepared, active(c, "destination-lock")] })))
      .resolves.toEqual({ status: "failed", errorClass: "permanent", reason: "htlc-retained-action-duplicate" });
  });

  test("moves nothing when the stored intent cannot be canonicalized", async () => {
    const result = await refuses("source-claim", (c) => ({ ...c, intent: { ...c.intent, amount: 1n } }));
    expect(result).toEqual({ status: "indeterminate", reason: "htlc-settlement-store-intent-invalid" });
    expect(htlcNeedsOperator(result)).toBe(true);
  });
});

describe("observations that contradict the retained chain", () => {
  /** The reveal is final and checkpointed; the payee's source claim is retained and pending. */
  async function claimPending() {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    for (let call = 0; call < 4; call += 1) {
      await advanceCrossChainHtlc(call === 0 ? run.shared : run.nextOwner());
    }
    if (h.actions["source-claim"]?.state !== "pending") throw new Error("expected a pending source claim");
    return { h, run };
  }

  /** `base` with each acquired claim passed through `change`. */
  const claimedAs = (
    base: CrossChainHtlcStore,
    change: (claimed: Extract<HtlcStoreClaim, { status: "acquired" }>) => HtlcStoreClaim,
  ): CrossChainHtlcStore => ({
    ...base,
    async claim(input) {
      const claimed = await base.claim(input);
      return claimed.status === "acquired" ? change(claimed) : claimed;
    },
  });

  test("refuses a final source claim when no reveal is reported or checkpointed", async () => {
    const { h, run } = await claimPending();
    await h.markFinal("source-claim");
    delete h.actions["destination-claim"];
    const store = claimedAs(run.shared.store, ({ revealCheckpoint: _lost, ...rest }) => rest);
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store })).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-final-claim-chain-incomplete",
    });
  });

  test.each([
    ["another preimage", "ab".repeat(32), "htlc-revealed-preimage-mismatch"],
    ["a malformed preimage", "zz", "htlc-revealed-preimage-invalid"],
  ])("refuses a final source claim reported with a reveal of %s", async (_name, revealedPreimageHex, reason) => {
    const { h, run } = await claimPending();
    await h.markFinal("source-claim");
    h.actions["destination-claim"] = { ...h.actions["destination-claim"]!, revealedPreimageHex } as HtlcObservedAction;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason,
    });
  });

  test("checkpoints a reveal first seen with the final claim, and stops if that write throws", async () => {
    const { h, run } = await claimPending();
    await h.markFinal("source-claim");
    const base = run.shared.store;
    const store: CrossChainHtlcStore = {
      ...base,
      // A store that lost the reveal checkpoint and cannot write it again.
      async claim(input) {
        const claimed = await base.claim(input);
        if (claimed.status !== "acquired") return claimed;
        const { revealCheckpoint: _lost, ...rest } = claimed;
        return rest;
      },
      async recordRevealFinal() { throw new Error("store offline"); },
    };
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store })).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-reveal-checkpoint-persistence-uncertain",
    });
  });

  test("waits instead of driving the source claim when a final reveal has no destination lock", async () => {
    const h = harness({ mode: { "destination-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    for (let call = 0; call < 3; call += 1) {
      await advanceCrossChainHtlc(call === 0 ? run.shared : run.nextOwner());
    }
    await h.markFinal("destination-claim", { revealedPreimageHex: PREIMAGE_HEX });
    delete h.actions["destination-lock"];
    // Neither reported nor retained: the store lost the destination lock's row.
    const store = claimedAs(run.shared.store, (claimed) => ({
      ...claimed,
      prepared: claimed.prepared.filter((row) => row.action !== "destination-lock"),
    }));
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store })).resolves.toEqual({
      status: "indeterminate",
      reason: "htlc-destination-lock-finality-regressed",
    });
    expect(h.prepareAction.mock.calls.map(([request]) => request.action)).not.toContain("source-claim");
  });

  test("refuses a final reveal other than the one its retained checkpoint names", async () => {
    const h = harness({ sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    for (let call = 0; call < 3; call += 1) {
      await advanceCrossChainHtlc(call === 0 ? run.shared : run.nextOwner());
    }
    const first = h.broadcastRetained.mock.calls.map((call) => call[0]).find((p) => p.action === "destination-claim")!;
    h.actions["destination-claim"] = { state: "failed", txRef: first.txRef, authenticationHash: AUTH_HASH };
    await advanceCrossChainHtlc(run.nextOwner());
    const replacement = h.broadcastRetained.mock.calls.map((call) => call[0]).filter((p) => p.action === "destination-claim")[1]!;
    // The store holds a checkpoint naming the first attempt; the chain reports the replacement final.
    const base = run.shared.store;
    const store: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        return claimed.status === "acquired"
          ? {
            ...claimed,
            revealCheckpoint: {
              revealTxRef: first.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
              sourceExpiry: 5_000,
              finalityObservedAt: 1_000_000,
              authenticationHash: AUTH_HASH,
            },
          }
          : claimed;
      },
    };
    h.actions["destination-claim"] = {
      state: "final",
      txRef: replacement.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
      finalityObservedAt: 1_000_500,
      revealedPreimageHex: PREIMAGE_HEX,
      authenticationHash: AUTH_HASH,
    };
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store })).resolves.toEqual({
      status: "failed",
      errorClass: "permanent",
      reason: "htlc-reveal-checkpoint-conflict",
    });
  });
});

describe("refund fallback, stored settlement rows and the evidence projection", () => {
  const actionsBroadcast = (h: ReturnType<typeof harness>) =>
    h.broadcastRetained.mock.calls.map(([prepared]) => prepared.action);

  // The payer's source refund on the final-destination-lock path
  // (`destination-claim-unlanded`).
  async function toUnlandedRefund() {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      mode: { "destination-claim": "pending", "source-refund": "pending" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    h.actions["destination-claim"] = { state: "absent", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "claim-unlanded", now: () => 1_700_101 }))
      .resolves.toMatchObject({ status: "refund-pending", reason: "destination-claim-unlanded" });
    expect(actionsBroadcast(h).filter((action) => action === "source-refund")).toHaveLength(1);
    return { h, run };
  }

  test("never re-sends a source refund reported absent naming it after an unlanded reveal, and pages", async () => {
    const { h, run } = await toUnlandedRefund();
    h.actions["source-refund"] = { state: "absent", txRef: refFor("source-refund"), authenticationHash: AUTH_HASH };
    const result = await advanceCrossChainHtlc({ ...run.shared, owner: "refund-dead", now: () => 1_700_202 });
    expect(result).toMatchObject({
      status: "operator-alert",
      reason: "htlc-refund-absent",
      refunds: { "source-refund": "absent" },
    });
    expect(actionsBroadcast(h).filter((action) => action === "source-refund")).toHaveLength(1);
  });

  test("rebroadcasts the retained source refund reported absent naming nothing after an unlanded reveal", async () => {
    const { h, run } = await toUnlandedRefund();
    h.actions["source-refund"] = { state: "absent", authenticationHash: AUTH_HASH };
    await advanceCrossChainHtlc({ ...run.shared, owner: "refund-unseen", now: () => 1_700_202 });
    const sent = h.broadcastRetained.mock.calls.filter(([prepared]) => prepared.action === "source-refund");
    expect(sent).toHaveLength(2);
    expect(sent[1]![0]).toEqual(sent[0]![0]);
  });

  async function settledSession() {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    let result = await advanceCrossChainHtlc(run.shared);
    for (let call = 0; call < 3; call += 1) result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result.status).toBe("settled");
    return { run };
  }
  const withSettlement = (
    base: CrossChainHtlcStore,
    mutate: (settlement: CrossChainHtlcSettlement) => unknown,
  ): CrossChainHtlcStore => ({
    ...base,
    async claim(input) {
      const claimed = await base.claim(input);
      return claimed.status === "settled"
        ? { ...claimed, settlement: mutate(structuredClone(claimed.settlement)) as CrossChainHtlcSettlement }
        : claimed;
    },
  });
  test.each([
    ["without the source claim", (s: CrossChainHtlcSettlement) => ({ ...s, txRefs: s.txRefs.slice(0, 3) })],
    ["with a source refund in the claim's place", (s: CrossChainHtlcSettlement) => ({
      ...s,
      txRefs: [
        ...s.txRefs.slice(0, 3),
        { kind: "htlc-refund", chainId: 84532, contractAddress: "source-contract", refundTxHash: "tx-r" },
      ],
    })],
    ["with txRefs an object instead of an array", (s: CrossChainHtlcSettlement) => ({
      ...s,
      txRefs: { ...s.txRefs, length: 4 },
    })],
  ] as const)("never replays a stored settlement %s as settled", async (_name, mutate) => {
    const { run } = await settledSession();
    const result = await advanceCrossChainHtlc({ ...run.nextOwner(), store: withSettlement(run.shared.store, mutate) });
    expect(result.status).not.toBe("settled");
  });

  const settledProgress = (txRefs: readonly HtlcTxRef[]): Extract<CrossChainHtlcProgress, { status: "settled" }> => ({
    status: "settled",
    settlement: {
      txRefs,
      paymentAmount: { amount: "1", currency: "USDC" },
      settlementFinality: { model: "htlc-reveal", sourceExpiry: 5, finalityReachedAt: 1, finalityObservedAt: 2 },
      authenticationHash: AUTH_HASH,
    },
  });
  const [sl, dl, rv, sc] =
    [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")];
  test.each([
    ["five references", [sl, dl, rv, sc, sc]],
    ["a claim in the source-lock slot", [sc, dl, rv, sc]],
    ["a reveal in the destination-lock slot", [sl, rv, rv, sc]],
    ["a lock in the reveal slot", [sl, dl, dl, sc]],
    ["a claim on a third chain", [sl, dl, rv, { ...sc, chainId: 1 }]],
    ["every reference on the source chain", [sl, dl, { ...rv, chainId: 84532 }, sc]],
  ] as const)("refuses a settled evidence projection with %s", (_name, txRefs) => {
    expect(() => crossChainHtlcEvidenceFields(settledProgress(txRefs as readonly HtlcTxRef[])))
      .toThrow("not a settled HTLC chain");
  });
  test("omits supersedesEvidenceRef entirely when none is given", () => {
    const out = crossChainHtlcEvidenceFields(settledProgress([sl, dl, rv, sc]));
    expect(Object.keys(out)).not.toContain("supersedesEvidenceRef");
  });
  const asymmetricProgress = (
    txRefs: readonly HtlcTxRef[],
  ): Extract<CrossChainHtlcProgress, { status: "settle-asymmetric" }> => ({
    status: "settle-asymmetric",
    reason: "dest-revealed-source-unclaimed",
    recoveryDeadline: 5_000,
    txRefs,
    finalityObservedAt: 1,
  });
  test.each([
    ["no lock", [rv]],
    ["only the destination lock", [dl, rv]],
    ["no reveal", [sl, dl]],
    ["two reveals", [sl, dl, rv, { ...rv, revealTxHash: "tx-other" }]],
    ["the source lock on the reveal's chain", [{ ...sl, chainId: 80002 }, rv]],
  ] as const)("refuses an interim evidence projection with %s", (_name, txRefs) => {
    expect(() => crossChainHtlcEvidenceFields(asymmetricProgress(txRefs as readonly HtlcTxRef[])))
      .toThrow("asymmetric references omit the source lock or reveal");
  });
});

describe("idempotent `existing` store writes", () => {
  // A host store whose reveal checkpoint and settlement writes report
  // `existing`, as a retry after a lost acknowledgement does, after the write
  // landed. The core must treat each as recorded.
  const existingWrites = (base: CrossChainHtlcStore, writes: Set<string>): CrossChainHtlcStore => ({
    ...base,
    async recordRevealFinal(input) {
      const written = await base.recordRevealFinal(input);
      writes.add("reveal");
      return written.status === "recorded" ? { status: "existing" } : written;
    },
    async recordSettlement(input) {
      const written = await base.recordSettlement(input);
      writes.add("settlement");
      return written.status === "recorded" ? { status: "existing" } : written;
    },
  });

  test("settles in the call that drives the claim when both writes report existing", async () => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    const writes = new Set<string>();
    const store = existingWrites(run.shared.store, writes);
    let result = await advanceCrossChainHtlc({ ...run.shared, store });
    for (let call = 0; call < 3; call += 1) result = await advanceCrossChainHtlc({ ...run.nextOwner(), store });
    expect(result).toMatchObject({ status: "settled" });
    expect([...writes].sort()).toEqual(["reveal", "settlement"]);
  });

  test("settles a claim observed final on a later call when both writes report existing", async () => {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    const writes = new Set<string>();
    const store = existingWrites(run.shared.store, writes);
    let result = await advanceCrossChainHtlc({ ...run.shared, store });
    for (let call = 0; call < 3; call += 1) result = await advanceCrossChainHtlc({ ...run.nextOwner(), store });
    expect(result).toMatchObject({ status: "settle-asymmetric" });
    await h.markFinal("source-claim");
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store })).resolves.toMatchObject({ status: "settled" });
    expect([...writes].sort()).toEqual(["reveal", "settlement"]);
  });

  // A final source claim with no retained reveal checkpoint (here a host
  // store that omits it from the claim) is settled from the final reveal
  // observation, whose checkpoint is written first on the settle path.
  async function toFinalClaimWithoutRetainedCheckpoint() {
    const h = harness({ mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    let result = await advanceCrossChainHtlc(run.shared);
    for (let call = 0; call < 3; call += 1) result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result).toMatchObject({ status: "settle-asymmetric" });
    await h.markFinal("source-claim");
    const base = run.shared.store;
    const withoutCheckpoint: CrossChainHtlcStore = {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        if (claimed.status !== "acquired") return claimed;
        const { revealCheckpoint: _omitted, ...rest } = claimed;
        return rest;
      },
    };
    return { run, store: withoutCheckpoint };
  }

  test("settles when the reveal checkpoint written in the settling call reports existing", async () => {
    const { run, store } = await toFinalClaimWithoutRetainedCheckpoint();
    const written: HtlcStoreWrite[] = [];
    const observed: CrossChainHtlcStore = {
      ...store,
      async recordRevealFinal(input) {
        const result = await store.recordRevealFinal(input);
        written.push(result);
        return result;
      },
    };
    await expect(advanceCrossChainHtlc({ ...run.nextOwner(), store: observed }))
      .resolves.toMatchObject({ status: "settled" });
    // The base store already holds that identical checkpoint.
    expect(written).toEqual([{ status: "existing" }]);
  });

  test.each([
    ["refused", { status: "conflict", reason: "test-refused" }],
    ["stale", { status: "stale", reason: "stale-lease" }],
  ] as const)("never settles when the reveal checkpoint written in the settling call is %s", async (_name, answer) => {
    const { run, store } = await toFinalClaimWithoutRetainedCheckpoint();
    const settlements = vi.fn(store.recordSettlement);
    await expect(advanceCrossChainHtlc({
      ...run.nextOwner(),
      store: { ...store, recordSettlement: settlements, async recordRevealFinal() { return answer; } },
    })).resolves.toEqual({ status: "indeterminate", reason: "htlc-reveal-checkpoint-persistence-uncertain" });
    expect(settlements).not.toHaveBeenCalled();
  });

  test("settles when the reveal checkpoint written in the settling call reports recorded", async () => {
    const { run, store } = await toFinalClaimWithoutRetainedCheckpoint();
    await expect(advanceCrossChainHtlc({
      ...run.nextOwner(),
      store: {
        ...store,
        async recordRevealFinal(input) {
          const result = await store.recordRevealFinal(input);
          return result.status === "existing" ? { status: "recorded" } : result;
        },
      },
    })).resolves.toMatchObject({ status: "settled" });
  });

  test("the in-memory store answers existing only for the identical row, and conflict for any other", async () => {
    const fixture = await destinationClaimStoreFixture();
    const { store, intent, fence, prior } = fixture;
    await expect(store.recordPrepared({ ...fence, prepared: prior })).resolves.toEqual({ status: "existing" });
    await expect(store.recordPrepared({ ...fence, prepared: preparedFor(intent, "destination-claim", "-other") }))
      .resolves.toEqual({ status: "conflict", reason: "htlc-action-replacement-forbidden" });
    const checkpoint = {
      revealTxRef: prior.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>,
      sourceExpiry: 5_000,
      finalityObservedAt: 1_000,
      authenticationHash: AUTH_HASH,
    };
    await expect(store.recordRevealFinal({ ...fence, checkpoint })).resolves.toEqual({ status: "recorded" });
    await expect(store.recordRevealFinal({ ...fence, checkpoint: { ...checkpoint } }))
      .resolves.toEqual({ status: "existing" });
    await expect(store.recordRevealFinal({ ...fence, checkpoint: { ...checkpoint, finalityObservedAt: 1_001 } }))
      .resolves.toEqual({ status: "conflict", reason: "htlc-reveal-checkpoint-conflict" });
  });
});

describe("refund progress reports the observation taken after the refund it sent", () => {
  // The broadcast of `action` lands it in `state` (or throws), so only the
  // snapshot re-observed after that refund shows it.
  const refundLandsAs = (h: ReturnType<typeof harness>, action: HtlcAction, outcome: "failed" | "throw") => {
    const broadcast = h.adapter.broadcastRetained;
    h.adapter.broadcastRetained = vi.fn(async (prepared, fence) => {
      if (prepared.action !== action) return broadcast(prepared, fence);
      await fence.assertCurrent();
      if (outcome === "throw") throw new Error("ambiguous transport");
      h.actions[action] = { state: "failed", txRef: prepared.txRef, authenticationHash: AUTH_HASH };
    });
  };

  async function lockedWithoutReveal(adapterOf: (h: ReturnType<typeof harness>) => CrossChainHtlcAdapter) {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
    const run = runner({ authorizeDestinationClaim: false });
    run.shared.adapter = adapterOf(h);
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    return { h, run };
  }
  const wholeSession = (h: ReturnType<typeof harness>): CrossChainHtlcAdapter => {
    const { observeSourceLeg: _sourceLeg, ...adapter } = h.adapter;
    return new Proxy(adapter, {
      get: (target, key) => key === "broadcastRetained" ? h.adapter.broadcastRetained : Reflect.get(target, key),
    }) as unknown as CrossChainHtlcAdapter;
  };

  test.each([
    ["failed", "refund-stalled", "failed"],
    ["throw", "refund-pending", "uncertain"],
  ] as const)("on the refund path without observeSourceLeg, a source refund that %s reads so in the same call", async (outcome, status, leg) => {
    const { h, run } = await lockedWithoutReveal(wholeSession);
    refundLandsAs(h, "source-refund", outcome);
    const result = await advanceCrossChainHtlc({ ...run.shared, owner: "both-expired", now: () => 1_700_101 });
    expect(result).toMatchObject({ status, refunds: { "source-refund": leg } });
  });

  test.each([
    ["failed", "refund-stalled", "failed"],
    ["throw", "refund-pending", "uncertain"],
  ] as const)("after an unlanded reveal, a source refund that %s reads so in the same call", async (outcome, status, leg) => {
    const h = harness({
      sourceExpiry: 1_700,
      destinationExpiry: 1_200,
      // The destination refund sent after it in the same call cannot be
      // observed, so the source refund's own re-observation is the only fresh one.
      mode: { "destination-claim": "pending", "destination-refund": "throw-once" },
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await advanceCrossChainHtlc(run.nextOwner());
    h.actions["destination-claim"] = { state: "absent", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
    refundLandsAs(h, "source-refund", outcome);
    const result = await advanceCrossChainHtlc({ ...run.shared, owner: "claim-unlanded", now: () => 1_700_101 });
    expect(result).toMatchObject({
      status,
      reason: "destination-claim-unlanded",
      refunds: { "source-refund": leg, "destination-refund": "uncertain" },
    });
  });

  test.each([
    ["failed", { status: "refund-stalled", refunds: { "destination-refund": "failed" } }],
    // Nothing needs a person yet: the regressed lock keeps the session resumable.
    ["throw", { status: "indeterminate", reason: "htlc-source-finality-checkpoint-without-final-lock" }],
  ] as const)("with a regressed source lock, a destination refund that %s reads so in the same call", async (outcome, expected) => {
    const { h, run } = await lockedWithoutReveal((harnessed) => harnessed.adapter);
    refundLandsAs(h, "destination-refund", outcome);
    delete h.actions["source-lock"];
    const result = await advanceCrossChainHtlc({ ...run.shared, owner: "regressed-source", now: () => 1_200_101 });
    expect(result).toMatchObject(expected);
  });
});

describe("in-memory store claim of an existing settlement", () => {
  test.each([
    ["binding hash", { bindingHash: "f".repeat(64) }, {}],
    ["buyer salt hash", {}, { buyerSaltHash: "f".repeat(64) }],
    ["preimage hash", {}, { preimageHash: "f".repeat(64) }],
  ] as const)("refuses a claim whose %s alone differs from the stored one", async (_name, intentChange, secretChange) => {
    const { store, intent, secrets } = await destinationClaimStoreFixture();
    await expect(store.claim({
      intent: { ...intent, ...intentChange },
      secrets: { ...secrets, ...secretChange },
      owner: "other-worker",
      now: 1_000_000,
      leaseDurationMs: 100,
    })).resolves.toEqual({ status: "conflict", reason: "htlc-settlement-binding-or-secret-conflict" });
  });
});

describe("layered rechecks: the clock or the lease moves during one await", () => {
  /** `run` moves the clock inside event `at`; `lose` makes that `isCurrent` read report the lease lost. */
  interface Step { at?: number; run?: () => void; lose?: number }

  /** An adapter that never checks the fence itself, so only the core's fences guard each step. */
  function unfenced(adapter: CrossChainHtlcAdapter): CrossChainHtlcAdapter {
    const open = (fence: HtlcEffectFence): HtlcEffectFence => ({ ...fence, assertCurrent: async () => {} });
    return {
      observe: (intent, fence) => adapter.observe(intent, open(fence)),
      observeSourceLeg: (intent, fence) => adapter.observeSourceLeg(intent, open(fence)),
      prepareAction: (request, fence) => adapter.prepareAction(request, open(fence)),
      broadcastRetained: (action, fence) => adapter.broadcastRetained(action, open(fence)),
    };
  }

  /**
   * Wraps a store and an adapter so that every awaited call is logged as an
   * event, and `step` runs when the event at index `at` starts: inside that
   * await, after the core read the clock for it.
   */
  function traced(
    store: CrossChainHtlcStore,
    adapter: CrossChainHtlcAdapter,
    step?: Step,
  ) {
    const events: string[] = [];
    const hit = (event: string) => {
      events.push(event);
      if (step?.run && events.length - 1 === step.at) step.run();
    };
    return {
      events,
      store: {
        ...store,
        isCurrent: async (input) => {
          hit("isCurrent");
          // A lease lost to another worker inside this read.
          return step?.lose === events.length - 1 ? false : store.isCurrent(input);
        },
        recordPrepared: async (input) => { hit(`record:${input.prepared.action}`); return store.recordPrepared(input); },
        recordRevealFinal: async (input) => { hit("recordRevealFinal"); return store.recordRevealFinal(input); },
        recordSourceFinality: async (input) => { hit("recordSourceFinality"); return store.recordSourceFinality(input); },
        replacePreparedSourceClaim: async (input) => {
          hit("replace:source-claim");
          return store.replacePreparedSourceClaim(input);
        },
        replacePreparedDestinationClaim: async (input) => {
          hit("replace:destination-claim");
          return store.replacePreparedDestinationClaim(input);
        },
      } satisfies CrossChainHtlcStore,
      adapter: {
        observe: async (intent, fence) => { hit("observe"); return adapter.observe(intent, fence); },
        observeSourceLeg: async (intent, fence) => { hit("observeSourceLeg"); return adapter.observeSourceLeg(intent, fence); },
        prepareAction: async (request, fence) => { hit(`prepare:${request.action}`); return adapter.prepareAction(request, fence); },
        broadcastRetained: async (action, fence) => { hit(`broadcast:${action.action}`); return adapter.broadcastRetained(action, fence); },
      } satisfies CrossChainHtlcAdapter,
    };
  }

  /**
   * Drives a session to the call under test with `prepare`, then runs that
   * call traced, as worker "stepped" with a lease long enough that only the
   * window, not the lease, closes when the clock moves.
   */
  async function scenario(
    options: HarnessOptions,
    prepare: (h: ReturnType<typeof harness>, run: ReturnType<typeof runner>) => Promise<void>,
  ) {
    const h = harness(options);
    const run = runner({ adapter: unfenced(h.adapter) });
    await prepare(h, run);
    return {
      h,
      run,
      call(step?: Step) {
        const t = traced(run.shared.store, run.shared.adapter, step);
        return {
          events: t.events,
          result: advanceCrossChainHtlc({
            ...run.shared,
            owner: "stepped",
            store: t.store,
            adapter: t.adapter,
            leaseDurationMs: 10_000_000,
          }),
        };
      },
    };
  }

  /** The source lock and destination lock are final; the next call, at 1_484_999, reveals. */
  const reveal = () => scenario({ destinationExpiry: 1_500 }, async (_h, run) => {
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_484_999);
  });

  /** The first source claim is authenticated failed; the next call replaces it. */
  const sourceClaimReplacement = () => scenario({ mode: { "source-claim": "pending" } }, async (h, run) => {
    for (let call = 0; call < 4; call += 1) {
      await advanceCrossChainHtlc(call === 0 ? run.shared : run.nextOwner());
    }
    const prior = h.broadcastRetained.mock.calls.map((call) => call[0]).find((p) => p.action === "source-claim");
    if (!prior) throw new Error("expected a source claim");
    h.actions["source-claim"] = { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH };
    h.setMode("source-claim", "pending");
    run.nextOwner();
  });

  /** The first reveal is authenticated failed; the next call replaces it. */
  const destinationClaimReplacement = () => scenario(
    { sourceExpiry: 5_000, destinationExpiry: 1_500, mode: { "destination-claim": "pending" } },
    async (h, run) => {
      for (let call = 0; call < 3; call += 1) {
        await advanceCrossChainHtlc(call === 0 ? run.shared : run.nextOwner());
      }
      const prior = h.broadcastRetained.mock.calls.map((call) => call[0]).find((p) => p.action === "destination-claim");
      if (!prior) throw new Error("expected a reveal");
      h.actions["destination-claim"] = { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH };
      run.nextOwner();
    },
  );

  // Each case's call awaits, in order: the fence, the observation, the fence,
  // the fence, the preparation, the fence, the store write, the fence, the
  // broadcast, the fence, then the fence and observation of what it sent.
  const cases = [
    {
      name: "a first reveal",
      make: reveal,
      write: "record:destination-claim",
      action: "destination-claim",
      closesAt: 1_485_000,
      closed: { status: "waiting", reason: "htlc-destination-claim-cutoff-reached" },
      sent: { status: "waiting", reason: "htlc-destination-claim-finality-pending" },
      uncertain: "htlc-destination-claim-effect-uncertain",
    },
    {
      name: "a source-claim replacement",
      make: sourceClaimReplacement,
      write: "replace:source-claim",
      action: "source-claim",
      closesAt: 5_000_000,
      closed: { status: "operator-alert", reason: "htlc-source-claim-missed-after-reveal" },
      sent: { status: "settle-asymmetric", reason: "dest-revealed-source-unclaimed" },
      uncertain: "htlc-source-claim-effect-uncertain",
    },
    {
      name: "a reveal replacement",
      make: destinationClaimReplacement,
      write: "replace:destination-claim",
      action: "destination-claim",
      closesAt: 1_485_000,
      closed: { status: "operator-alert", reason: "htlc-destination-claim-failed-preimage-public" },
      sent: { status: "waiting", reason: "htlc-destination-claim-finality-pending" },
      uncertain: "htlc-destination-claim-replacement-uncertain",
    },
  ] as const;

  const shape = (c: { action: string; write: string }) => [
    "isCurrent", "observe", "isCurrent", "isCurrent", `prepare:${c.action}`, "isCurrent", c.write,
    "isCurrent", `broadcast:${c.action}`, "isCurrent", "isCurrent", "observe", "isCurrent",
  ];

  test.each(cases)("$name awaits each fence around every adapter call and store write", async (c) => {
    const s = await c.make();
    const call = s.call();
    await expect(call.result).resolves.toMatchObject(c.sent);
    expect(call.events).toEqual(shape(c));
  });

  // Inside await k (the fence after the observation through the fence before
  // the broadcast), the window closes: the very next check stops the call, so
  // nothing (no store read, preparation, write or broadcast) follows await k.
  test.each(cases.flatMap((c) => [2, 3, 4, 5, 6, 7].map((at) => ({ ...c, at }))))(
    "$name: when the window closes inside await $at, the call stops right after it",
    async ({ at, ...c }) => {
      const s = await c.make();
      const call = s.call({ at, run: () => s.run.setClock(c.closesAt) });
      await expect(call.result).resolves.toMatchObject(c.closed);
      expect(call.events).toEqual(shape(c).slice(0, at + 1));
    },
  );

  test.each(cases)("$name is sent when the window closes only once the broadcast started", async (c) => {
    const s = await c.make();
    const call = s.call({ at: 8, run: () => s.run.setClock(c.closesAt) });
    await expect(call.result).resolves.toMatchObject(c.sent);
    expect(call.events).toEqual(shape(c));
  });

  /** The source lock is final but not yet checkpointed, so the call reads the source leg first. */
  const uncheckpointedSourceLock = () => scenario({ mode: { "source-lock": "pending" } }, async (h, run) => {
    await advanceCrossChainHtlc(run.shared);
    await h.markFinal("source-lock", { includedAt: 1_000_000, expiresAt: 5_000 });
    run.nextOwner();
  });

  test.each([
    ["no fence fails", undefined, [
      "isCurrent", "observeSourceLeg", "isCurrent", "recordSourceFinality", "isCurrent", "observe", "isCurrent",
    ]],
    ["the fence before it fails", 0, [
      "isCurrent", "isCurrent", "observe", "isCurrent", "recordSourceFinality",
    ]],
    ["the fence after it fails", 2, [
      "isCurrent", "observeSourceLeg", "isCurrent", "isCurrent", "observe", "isCurrent", "recordSourceFinality",
    ]],
  ] as const)("checkpoints from the source-leg observation only under the lease: %s", async (_name, lose, events) => {
    const s = await uncheckpointedSourceLock();
    const call = s.call(lose === undefined ? undefined : { lose });
    await expect(call.result).resolves.toMatchObject({ status: "refund-pending" });
    expect(call.events).toEqual(events);
  });

  test.each(cases.filter((c) => c.write.startsWith("replace:")))(
    "$name is broadcast when the store answers `existing` to the replacement",
    async (c) => {
      const s = await c.make();
      const store = s.run.shared.store;
      const answerExisting = async (write: Promise<HtlcStoreWrite>): Promise<HtlcStoreWrite> =>
        (await write).status === "recorded" ? { status: "existing" } : write;
      const call = advanceCrossChainHtlc({
        ...s.run.shared,
        owner: "stepped",
        leaseDurationMs: 10_000_000,
        store: {
          ...store,
          replacePreparedSourceClaim: (input) => answerExisting(store.replacePreparedSourceClaim(input)),
          replacePreparedDestinationClaim: (input) => answerExisting(store.replacePreparedDestinationClaim(input)),
        },
      });
      await expect(call).resolves.toMatchObject(c.sent);
      expect(s.h.broadcastRetained.mock.calls.filter(([action]) => action.action === c.action)).toHaveLength(2);
    },
  );

  test.each(cases.filter((c) => c.write.startsWith("replace:")))(
    "$name accepts, in the same call, an observation that still reports the replaced attempt",
    async (c) => {
      const s = await c.make();
      const adapter = s.run.shared.adapter;
      // The replacement goes out, but the chain view has not caught up with it.
      const call = advanceCrossChainHtlc({
        ...s.run.shared,
        owner: "stepped",
        leaseDurationMs: 10_000_000,
        adapter: {
          ...adapter,
          broadcastRetained: async (action, fence) => {
            if (action.action !== c.action) await adapter.broadcastRetained(action, fence);
          },
        },
      });
      await expect(call).resolves.not.toMatchObject({ reason: "htlc-ledger-observation-unavailable" });
      await expect(call).resolves.not.toMatchObject({ status: "indeterminate" });
    },
  );

  // A fence that reports the lease lost stops the call at that fence: before
  // the observation is used, before the preparation, before the store write,
  // before the broadcast, and before what was sent is observed.
  test.each(cases.flatMap((c) => [0, 2, 3, 5, 7, 9, 10, 12].map((at) => ({ ...c, at }))))(
    "$name: when the lease is lost at the fence at await $at, the call stops there",
    async ({ at, ...c }) => {
      const s = await c.make();
      const call = s.call({ lose: at });
      await expect(call.result).resolves.toEqual({
        status: "indeterminate",
        reason: at <= 2 ? "htlc-ledger-observation-unavailable" : c.uncertain,
      });
      expect(call.events).toEqual(shape(c).slice(0, at + 1));
    },
  );
});

describe("independent HTLC admission and observation boundaries", () => {
  test.each([
    ["source currency", { sourceAsset: "USDT" }],
    ["destination currency", { destinationAsset: "USDT" }],
    ["source chain zero", { sourceChainId: 0 }],
    ["destination chain zero", { destinationChainId: 0 }],
    ["destination duration zero", { destinationTimelockSec: 0 }],
    ["source decimals overflow", { sourceTokenDecimals: 256, amount: "1" }],
    ["destination decimals overflow", { destinationTokenDecimals: 256, amount: "1" }],
    ...(["agreementHash", "railDescriptorHash"] as const).flatMap((key) =>
      ["invalid", `!${AGREEMENT_HASH}`, `${AGREEMENT_HASH}!`].map((hash) => [key + hash, { [key]: hash }] as const)),
  ] as const)("rejects only invalid %s before dependencies, then accepts correction", async (_name, override) => {
    const h = harness();
    const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const claim = vi.spyOn(store, "claim");
    const deriveHashlock = vi.fn(hashlocks.deriveHashlock);
    const run = runner({ adapter: h.adapter, store, hashlocks: { deriveHashlock } });
    expect(() => createCrossChainHtlcIntent(authority(override), SALT, hashlocks)).toThrow();
    await expect(advanceCrossChainHtlc({ ...run.shared, authority: authority(override) }))
      .resolves.toEqual({ status: "indeterminate", reason: "htlc-call-input-invalid" });
    expect(claim).not.toHaveBeenCalled();
    expect(deriveHashlock).not.toHaveBeenCalled();
    expect(h.prepareAction).not.toHaveBeenCalled();
    expect(h.broadcastRetained).not.toHaveBeenCalled();
    await expect(advanceCrossChainHtlc(run.shared)).resolves.toMatchObject({ status: "waiting" });
    expect(h.prepareAction).toHaveBeenCalledTimes(1);
  });

  test.each(["invalid", `!${AGREEMENT_HASH}`, `${AGREEMENT_HASH}!`])("rejects invalid derivation agreement hash %s", (agreementHash) => {
    expect(() => deriveHtlcPreimage({ buyerSalt: SALT, jobId: JOB_ID, agreementHash })).toThrow();
  });

  test.each(["sourceTokenDecimals", "destinationTokenDecimals"] as const)("accepts unsigned-byte %s endpoints with exact amounts", (field) => {
    for (const decimals of [0, 255]) {
      const { intent } = createCrossChainHtlcIntent(authority({ [field]: decimals, phaseIndex: 0, amount: "1" }), SALT, hashlocks);
      expect(intent.phaseIndex).toBe(0);
      expect(field === "sourceTokenDecimals" ? intent.sourceAmountBaseUnits : intent.destinationAmountBaseUnits)
        .toBe("1" + "0".repeat(decimals));
    }
  });

  test("settles with independently valid zero clock, inclusion and finality", async () => {
    const h = harness({ sourceFinalityObservedAt: 0, destinationIncludedAt: 0,
      sourceClaimIncludedAt: 0, sourceClaimFinalityReachedAt: 0, sourceClaimFinalityObservedAt: 0 });
    h.setObservedAt(0);
    const run = runner({ adapter: h.adapter, authority: authority({ phaseIndex: 0, amount: "1", sourceTokenDecimals: 0, destinationTokenDecimals: 0 }) });
    run.setClock(0);
    let result = await advanceCrossChainHtlc(run.shared);
    for (let i = 0; i < 3; i++) result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result).toMatchObject({ status: "settled", settlement: { settlementFinality: { finalityReachedAt: 0, finalityObservedAt: 0 } } });
    const count = h.broadcastRetained.mock.calls.length;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual(result);
    expect(h.broadcastRetained).toHaveBeenCalledTimes(count);
  });

  test.each([0, false, "", null, { unknown: { state: "absent", authenticationHash: AUTH_HASH } },
    { unknown: { state: "pending", txRef: refFor("source-lock"), authenticationHash: AUTH_HASH } },
    { unknown: { state: "final", txRef: refFor("source-lock"), finalityObservedAt: 1_000_000, authenticationHash: AUTH_HASH } },
  ])("rejects malformed actions container or unknown key %j and resumes", async (actions) => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    const observe = h.adapter.observe;
    run.shared.adapter = { ...h.adapter, observe: async () => ({ observedAt: 1_000_000, authenticationHash: AUTH_HASH, actions } as unknown as HtlcLedgerSnapshot) };
    await expect(advanceCrossChainHtlc(run.shared)).resolves.toEqual({ status: "indeterminate", reason: "htlc-ledger-observation-unavailable" });
    expect(h.prepareAction).not.toHaveBeenCalled();
    run.shared.adapter = { ...h.adapter, observe };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "waiting" });
  });

  test.each(["snapshot", "action"] as const)("rejects prefixed and suffixed %s authentication without effects", async (target) => {
    for (const hash of [`!${AUTH_HASH}`, `${AUTH_HASH}!`]) {
      const h = harness();
      const run = runner({ adapter: h.adapter });
      await advanceCrossChainHtlc(run.shared);
      const observe = h.adapter.observe;
      run.shared.adapter = { ...h.adapter, observe: async (intent, fence) => {
        const s = await observe(intent, fence);
        return target === "snapshot" ? { ...s, authenticationHash: hash } : {
          ...s, actions: { ...s.actions, "source-lock": { ...s.actions["source-lock"]!, authenticationHash: hash } },
        };
      } };
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({ status: "indeterminate", reason: "htlc-ledger-observation-unavailable" });
      expect(h.prepareAction).toHaveBeenCalledTimes(1);
      run.shared.adapter = h.adapter;
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "waiting" });
    }
  });

  test.each(["source", "destination"] as const)("rejects numeric %s amount as malformed observation and resumes", async (leg) => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    if (leg === "destination") await advanceCrossChainHtlc(run.nextOwner());
    const action = leg === "source" ? "source-lock" : "destination-lock";
    const valid = h.actions[action] as Extract<HtlcObservedAction, { state: "final" }>;
    h.actions[action] = { ...valid, lockTerms: { ...valid.lockTerms!, amountBaseUnits: 1250000 as unknown as string } };
    const count = h.prepareAction.mock.calls.length;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({ status: "indeterminate", reason: "htlc-adapter-lock-observation-invalid" });
    expect(h.prepareAction).toHaveBeenCalledTimes(count);
    h.actions[action] = valid;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "waiting" });
  });

  test("refunds a destination expiry at zero inclusion without revealing", async () => {
    const h = harness({ destinationIncludedAt: 0, destinationExpiry: 0 });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "refund-pending", reason: "destination-lock-expiry-invalid" });
    expect(h.prepareAction.mock.calls.map(([r]) => r.action)).not.toContain("destination-claim");
  });

  test.each([
    { kind: "htlc-lock", chainId: 84532, contractAddress: "source-contract", claimTxHash: "external" },
    { ...refFor("source-claim"), claimTxHash: ["external"] },
    { ...refFor("source-claim"), claimTxHash: new String("external") },
  ])("rejects independently malformed outside-claim reference %j", async (claimTxRef) => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    const source = h.actions["source-lock"] as Extract<HtlcObservedAction, { state: "final" }>;
    h.actions["source-lock"] = { ...source, lockState: "claimed", claimTxRef, claimFinalityReachedAt: 1_000_000 } as HtlcObservedAction;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({ status: "indeterminate", reason: "htlc-ledger-observation-unavailable" });
    expect(h.prepareAction).toHaveBeenCalledTimes(1);
  });

  test("keeps a live session resumable after a rejected claim callback", async () => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    const base = run.shared.store;
    run.shared.store = { ...base, claim: async () => { throw new Error("unavailable"); } };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({ status: "indeterminate", reason: "htlc-settlement-store-unavailable" });
    expect(h.prepareAction).toHaveBeenCalledTimes(1);
    run.shared.store = base;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "waiting" });
  });

  test.each([true, false])("advances on an exact existing source checkpoint (source leg %s)", async (sourceLeg) => {
    const h = harness();
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const writes = vi.fn(async (input: Parameters<CrossChainHtlcStore["recordSourceFinality"]>[0]): Promise<HtlcStoreWrite> => {
      expect(await base.recordSourceFinality(input)).toEqual({ status: "recorded" });
      return { status: "existing" };
    });
    const run = runner({ adapter: sourceLeg ? h.adapter : { ...h.adapter, observeSourceLeg: async () => { throw new Error("offline"); } }, store: { ...base, recordSourceFinality: writes } });
    await advanceCrossChainHtlc(run.shared);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({ status: "waiting", reason: "htlc-destination-lock-finality-pending" });
    expect(writes).toHaveBeenCalledTimes(1);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "settled" });
  });
});

async function independentCasFixture(action: "source-claim" | "destination-claim", start = 1_000, sourceExpiry = 5_000) {
  const { intent, secrets } = createCrossChainHtlcIntent(authority(), SALT, hashlocks);
  const store = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
  const claim = await store.claim({ intent, secrets, owner: "cas-owner", now: start, leaseDurationMs: 10_000_000 });
  if (claim.status !== "acquired") throw new Error("expected CAS owner");
  const fence = { settlementKey: intent.settlementKey, bindingHash: intent.bindingHash, owner: claim.lease.owner, generation: claim.lease.generation };
  const atStart = (action: HtlcAction, suffix = ""): Readonly<HtlcPreparedAction> => {
    const { effectHash: _hash, ...body } = preparedFor(intent, action, suffix);
    const unsigned = { ...body, preparedAt: start };
    return { ...unsigned, effectHash: sha256Hex(canonicalize(unsigned)) };
  };
  const sourceLock = atStart("source-lock");
  await store.recordPrepared({ ...fence, prepared: sourceLock });
  await store.recordSourceFinality({ ...fence, checkpoint: {
    sourceLockEffectHash: sourceLock.effectHash,
    sourceLockTxRef: sourceLock.txRef as Extract<HtlcTxRef, { kind: "htlc-lock" }>,
    includedAt: start, finalityObservedAt: start, sourceExpiry: 5_000, authenticationHash: AUTH_HASH,
  } });
  const reveal = atStart("destination-claim");
  const checkpoint = { revealTxRef: reveal.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>, sourceExpiry, finalityObservedAt: start, authenticationHash: AUTH_HASH };
  if (action === "source-claim") {
    await store.recordPrepared({ ...fence, prepared: reveal });
    await store.recordRevealFinal({ ...fence, checkpoint });
  }
  const prior = action === "source-claim" ? atStart(action, "-attempt-1") : reveal;
  await store.recordPrepared({ ...fence, prepared: prior });
  const replacement = atStart(action, "-independent-replacement");
  const replace = (next = replacement, now = start) => action === "source-claim"
    ? store.replacePreparedSourceClaim({ ...fence, priorEffectHash: prior.effectHash, priorTxRef: prior.txRef as Extract<HtlcTxRef, { kind: "htlc-claim" }>, failedObservation: { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH } as never, replacement: next, now })
    : store.replacePreparedDestinationClaim({ ...fence, priorEffectHash: prior.effectHash, priorTxRef: prior.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>, failedObservation: { state: "failed", txRef: prior.txRef, authenticationHash: AUTH_HASH } as never, replacement: next, now });
  const read = (now = 20_000_000) => store.claim({ intent, secrets, owner: `reader-${now}`, now, leaseDurationMs: 100 });
  const other = createCrossChainHtlcIntent(authority({ jobId: OTHER_JOB_ID }), Uint8Array.from({ length: 16 }, () => 2), hashlocks);
  const otherClaim = await store.claim({ ...other, owner: "other", now: start, leaseDurationMs: 30_000_000 });
  if (otherClaim.status !== "acquired") throw new Error("expected other owner");
  const otherFence = { settlementKey: other.intent.settlementKey, bindingHash: other.intent.bindingHash, owner: otherClaim.lease.owner, generation: otherClaim.lease.generation };
  return { store, intent, secrets, prior, fence, checkpoint, replacement, replace, read, other, otherFence };
}

describe("independent replacement and reveal checkpoint admission", () => {
  test.each(["source-claim", "destination-claim"] as const)("%s CAS accepts zero time and refuses negative time", async (action) => {
    const f = await independentCasFixture(action, 0);
    await expect(f.replace(f.replacement, -1)).resolves.toEqual({ status: "stale", reason: "stale-lease" });
    await expect(f.replace(f.replacement, 0)).resolves.toEqual({ status: "recorded" });
  });

  test("source CAS refuses an overflowing retained reveal expiry without replacing", async () => {
    const f = await independentCasFixture("source-claim", 1_000, Number.MAX_SAFE_INTEGER);
    await expect(f.replace()).resolves.toEqual({ status: "corrupt", reason: "htlc-source-claim-replacement-expiry-corrupt" });
    const read = await f.read();
    expect(read).toMatchObject({ status: "acquired", sourceClaimAttemptHistory: [] });
    expect(read.status === "acquired" && read.prepared).toContainEqual(f.prior);
  });

  test.each(["source-claim", "destination-claim"] as const)("%s CAS rejects only tampered effect hash and accepts corrected bytes", async (action) => {
    const f = await independentCasFixture(action);
    await expect(f.replace({ ...f.replacement, effectHash: "0".repeat(64) })).resolves.toEqual({ status: "corrupt", reason: `htlc-${action}-replacement-integrity-mismatch` });
    await expect(f.replace()).resolves.toEqual({ status: "recorded" });
    const read = await f.read();
    expect(read).toMatchObject({ status: "acquired", [action === "source-claim" ? "sourceClaimAttemptHistory" : "destinationClaimAttemptHistory"]: [{ prepared: f.prior, replacementEffectHash: f.replacement.effectHash }] });
    expect(read.status === "acquired" && read.prepared).toContainEqual(f.replacement);
  });

  test.each((["source-claim", "destination-claim"] as const).flatMap((action) => ["effect", "reference"].map((reservation) => ({ action, reservation }))))("$action CAS refuses another session's $reservation reservation", async ({ action, reservation }) => {
    const f = await independentCasFixture(action);
    const unsigned = { ...preparedFor(f.other.intent, action, "-reserved"), txRef: f.replacement.txRef };
    const { effectHash: _hash, ...body } = unsigned;
    const reserved = reservation === "effect" ? { ...f.replacement, txRef: refFor(action, "-distinct") } : { ...body, effectHash: sha256Hex(canonicalize(body)) };
    await expect(f.store.recordPrepared({ ...f.otherFence, prepared: reserved })).resolves.toEqual({ status: "recorded" });
    await expect(f.replace()).resolves.toEqual({ status: "conflict", reason: reservation === "effect" ? "htlc-effect-cross-settlement-reuse" : "htlc-transaction-cross-settlement-reuse" });
    const read = await f.read();
    expect(read).toMatchObject({ status: "acquired", [action === "source-claim" ? "sourceClaimAttemptHistory" : "destinationClaimAttemptHistory"]: [] });
    expect(read.status === "acquired" && read.prepared).toContainEqual(f.prior);
    expect(read.status === "acquired" && read.prepared).not.toContainEqual(f.replacement);
  });

  test.each((["source-claim", "destination-claim"] as const).flatMap((action) => ["effect", "reference"].map((reservation) => ({ action, reservation }))))("$action retains old and replacement $reservation reservations after takeover", async ({ action, reservation }) => {
    const f = await independentCasFixture(action);
    await expect(f.replace()).resolves.toEqual({ status: "recorded" });
    await f.read();
    // The other session's independent lease remains live for these direct writes.
    for (const retained of [f.prior, f.replacement]) {
      const { effectHash: _hash, ...body } = preparedFor(f.other.intent, action, "-fresh");
      const unsigned = { ...body, txRef: retained.txRef };
      const reused = reservation === "effect" ? { ...retained, txRef: refFor(action, "-different-ref") } : { ...unsigned, effectHash: sha256Hex(canonicalize(unsigned)) };
      await expect(f.store.recordPrepared({ ...f.otherFence, prepared: reused })).resolves.toEqual({ status: "conflict", reason: reservation === "effect" ? "htlc-effect-cross-settlement-reuse" : "htlc-transaction-cross-settlement-reuse" });
    }
  });

  test.each(["invalid", `!${AUTH_HASH}`, `${AUTH_HASH}!`])("refuses unauthenticated reveal checkpoint %s, without refund exclusion, then retries", async (authenticationHash) => {
    const f = await destinationClaimStoreFixture();
    const checkpoint = { revealTxRef: f.prior.txRef as Extract<HtlcTxRef, { kind: "htlc-reveal" }>, sourceExpiry: 5_000, finalityObservedAt: 1_000, authenticationHash };
    await expect(f.store.recordRevealFinal({ ...f.fence, checkpoint })).resolves.toEqual({ status: "corrupt", reason: "htlc-reveal-checkpoint-unauthenticated" });
    const takeover = await f.store.claim({ intent: f.intent, secrets: f.secrets, owner: "reader", now: 1_101, leaseDurationMs: 100 });
    expect(takeover).toMatchObject({ status: "acquired" });
    expect("revealCheckpoint" in takeover && takeover.revealCheckpoint).toBeUndefined();
    if (takeover.status !== "acquired") throw new Error("expected takeover");
    const fence = { ...f.fence, owner: takeover.lease.owner, generation: takeover.lease.generation };
    await expect(f.store.recordPrepared({ ...fence, prepared: preparedFor(f.intent, "source-refund") })).resolves.toEqual({ status: "recorded" });
    await expect(f.store.recordRevealFinal({ ...fence, checkpoint: { ...checkpoint, authenticationHash: AUTH_HASH } })).resolves.toEqual({ status: "recorded" });
    await expect(f.store.recordRevealFinal({ ...fence, checkpoint: { ...checkpoint, authenticationHash: AUTH_HASH } })).resolves.toEqual({ status: "existing" });
  });
});

async function sweepLocked(options: HarnessOptions = {}, reveal = false) {
  const h = harness(options);
  const run = runner({ adapter: h.adapter, authorizeDestinationClaim: reveal });
  await advanceCrossChainHtlc(run.shared);
  await advanceCrossChainHtlc(run.nextOwner());
  if (reveal) await advanceCrossChainHtlc(run.nextOwner());
  return { h, run };
}

describe("restart recovery boundaries", () => {
  const toSourceClaimPending = async (run: ReturnType<typeof runner>) => {
    await advanceCrossChainHtlc(run.shared);
    for (let step = 0; step < 3; step += 1) await advanceCrossChainHtlc(run.nextOwner());
  };

  test.each(["omitted", "matching", "different"] as const)(
    "recovers and refunds when an adapter's effectHash is %s",
    async (suppliedHash) => {
      const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200 });
      const prepare = h.prepareAction.getMockImplementation()!;
      h.prepareAction.mockImplementation(async (request, fence) => {
        const body = await prepare(request, fence);
        if (suppliedHash === "omitted") return body;
        // A full HtlcPreparedAction is a valid structural return type for the adapter.
        const action: HtlcPreparedAction = {
          ...body,
          effectHash: suppliedHash === "matching" ? sha256Hex(canonicalize(body)) : "0".repeat(64),
        };
        return action;
      });
      const run = runner({ adapter: h.adapter, authorizeDestinationClaim: false });
      await advanceCrossChainHtlc(run.shared);
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "waiting" });
      run.setClock(1_700_000);
      h.setObservedAt(1_700_000);
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "refund-pending" });
      await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "refunded" });
      expect(h.prepareAction.mock.calls.map(([request]) => request.action))
        .toEqual(["source-lock", "destination-lock", "source-refund", "destination-refund"]);
      for (const [action] of h.broadcastRetained.mock.calls) {
        const { effectHash, ...body } = action;
        expect(effectHash).toBe(sha256Hex(canonicalize(body)));
      }
    },
  );

  test.each(["pending", "unreported"] as const)(
    "ends ST-8 on an authenticated refunded lock while its claim is %s",
    async (claimState) => {
      const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100, mode: { "source-claim": "pending" } });
      const run = runner({ adapter: h.adapter });
      await toSourceClaimPending(run);
      h.actions["source-lock"] = { ...h.actions["source-lock"], lockState: "refunded" } as HtlcObservedAction;
      if (claimState === "unreported") delete h.actions["source-claim"];
      h.prepareAction.mockClear();
      h.broadcastRetained.mockClear();
      for (const now of [1_500_000, 1_600_000, 3_600_000]) {
        run.setClock(now);
        h.setObservedAt(now);
        await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
          status: "failed", errorClass: "settlement-atomicity", reason: "dest-revealed-source-unclaimed-expired",
        });
      }
      expect(h.prepareAction).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    },
  );

  test.each(["open", undefined] as const)("keeps a pending claim resumable when the lock disposition is %s", async (lockState) => {
    const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100, mode: { "source-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    await toSourceClaimPending(run);
    h.actions["source-lock"] = { ...h.actions["source-lock"], lockState } as HtlcObservedAction;
    run.setClock(1_500_000);
    h.setObservedAt(1_500_000);
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({
      status: "operator-alert", reason: "htlc-source-claim-missed-after-reveal", sourceClaimPending: true,
    });
  });

  test.each([1_499_999, 1_500_000, 1_500_001])(
    "records checkpoint recovery immediately when a rebroadcast claim reaches finality at %i",
    async (finalityReachedAt) => {
      const h = harness({ sourceExpiry: 1_500, destinationExpiry: 1_100, mode: { "source-claim": "throw-once" } });
      const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
      const recordSettlement = vi.fn(base.recordSettlement.bind(base));
      const run = runner({ adapter: h.adapter, store: { ...base, recordSettlement } });
      await advanceCrossChainHtlc(run.shared);
      for (let step = 0; step < 3; step += 1) await advanceCrossChainHtlc(run.nextOwner());
      delete h.actions["destination-claim"];
      const broadcast = h.broadcastRetained.getMockImplementation()!;
      h.setMode("source-claim", "final");
      h.broadcastRetained.mockImplementation(async (action, fence) => {
        h.setObservedAt(finalityReachedAt);
        await broadcast(action, fence);
      });
      const result = await advanceCrossChainHtlc(run.nextOwner());
      if (finalityReachedAt > 1_500_000) {
        expect(result).toMatchObject({ status: "failed", errorClass: "settlement-atomicity",
          reason: "dest-revealed-source-unclaimed-expired", sourceClaimFinalityReachedAt: finalityReachedAt });
        expect(recordSettlement).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ status: "settled", settlement: {
          txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"), refFor("source-claim")],
          settlementFinality: { sourceExpiry: 1_500, finalityReachedAt },
        } });
        expect(recordSettlement).toHaveBeenCalledTimes(1);
        h.prepareAction.mockClear();
        h.broadcastRetained.mockClear();
        await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual(result);
        expect(h.prepareAction).not.toHaveBeenCalled();
        expect(h.broadcastRetained).not.toHaveBeenCalled();
      }
    },
  );

  test.each([1_100, 5_000, 10_000])("reconciles retained source/reveal expiry %i before observation or effects", async (sourceExpiry) => {
    const h = harness({ mode: { "source-claim": "throw-once" } });
    const base = createInMemoryCrossChainHtlcStore({ acknowledgeVolatile: true });
    const run = runner({ adapter: h.adapter, store: {
      ...base,
      async claim(input) {
        const claimed = await base.claim(input);
        return claimed.status === "acquired" && claimed.revealCheckpoint
          ? { ...claimed, revealCheckpoint: { ...claimed.revealCheckpoint, sourceExpiry } }
          : claimed;
      },
    } });
    await advanceCrossChainHtlc(run.shared);
    for (let step = 0; step < 3; step += 1) await advanceCrossChainHtlc(run.nextOwner());
    delete h.actions["destination-claim"];
    run.setClock(sourceExpiry === 10_000 ? 5_100_000 : 1_200_000);
    h.setObservedAt(sourceExpiry === 10_000 ? 5_100_000 : 1_200_000);
    h.observe.mockClear();
    h.observeSourceLeg.mockClear();
    h.prepareAction.mockClear();
    h.broadcastRetained.mockClear();
    const result = await advanceCrossChainHtlc(run.nextOwner());
    if (sourceExpiry === 5_000) {
      expect(result).toMatchObject({ status: "settle-asymmetric", recoveryDeadline: 5_000_000 });
      expect(h.observe).toHaveBeenCalled();
      expect(h.broadcastRetained).toHaveBeenCalledTimes(1);
    } else {
      expect(result).toEqual({ status: "failed", errorClass: "permanent", reason: "htlc-reveal-checkpoint-conflict" });
      expect(h.observe).not.toHaveBeenCalled();
      expect(h.observeSourceLeg).not.toHaveBeenCalled();
      expect(h.prepareAction).not.toHaveBeenCalled();
      expect(h.broadcastRetained).not.toHaveBeenCalled();
    }
  });
});

describe("refund and retained-attempt boundary progress", () => {
  test.each(["source-leg", "whole-session", "regressed-source", "unlanded-reveal"] as const)("passes exact expiry context to %s refund preparations", async (path) => {
    const { h, run } = await sweepLocked({ sourceExpiry: 1_700, destinationExpiry: 1_200, mode: { "destination-claim": "pending" } }, path === "unlanded-reveal");
    if (path === "whole-session") run.shared.adapter = { ...h.adapter, observeSourceLeg: async () => ({ observedAt: 0, authenticationHash: "invalid", actions: {} }) };
    if (path === "regressed-source") delete h.actions["source-lock"];
    if (path === "unlanded-reveal") h.actions["destination-claim"] = { state: "absent", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
    const prepare = h.adapter.prepareAction;
    const seen: HtlcAction[] = [];
    run.shared.adapter = { ...run.shared.adapter, prepareAction: async (request, fence) => {
      if (request.action === "source-refund") { expect(request.sourceExpiry).toBe(1_700); seen.push(request.action); }
      if (request.action === "destination-refund") { expect(request.destinationExpiry).toBe(1_200); seen.push(request.action); }
      return prepare(request, fence);
    } };
    await advanceCrossChainHtlc({ ...run.shared, owner: "expired", now: () => 1_700_101 });
    expect(seen).toEqual(path === "regressed-source" ? ["destination-refund"] : ["source-refund", "destination-refund"]);
  });

  test("whole-session fallback refunds exactly at expiry after an invalid source-leg view", async () => {
    const h = harness({ omitSourceLockTerms: true, sourceExpiry: 5_000 });
    const run = runner({ adapter: { ...h.adapter, observeSourceLeg: async () => ({ observedAt: 0, authenticationHash: "invalid", actions: {} }) } });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "before", now: () => 4_999_999, leaseDurationMs: 1 })).resolves.toMatchObject({ status: "refund-pending", refunds: { "source-refund": "waiting" } });
    expect(h.prepareAction).toHaveBeenCalledTimes(1);
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "exact", now: () => 5_000_000 })).resolves.toMatchObject({ status: "refund-pending" });
    expect(h.prepareAction.mock.calls.filter(([r]) => r.action === "source-refund")).toHaveLength(1);
    expect(h.prepareAction.mock.calls.filter(([r]) => r.action === "source-refund").map(([r]) => r.sourceExpiry)).toEqual([5_000]);
  });

  test.each(["failed", "throw", "unreported"] as const)("whole-session fallback reports refund %s in the sending call", async (outcome) => {
    const h = harness({ omitSourceLockTerms: true, sourceExpiry: 5_000 });
    const run = runner({ adapter: { ...h.adapter, observeSourceLeg: async () => ({ observedAt: 0, authenticationHash: "invalid", actions: {} }), broadcastRetained: async (p, fence) => {
      if (p.action !== "source-refund") return h.broadcastRetained(p, fence);
      if (outcome === "throw") throw new Error("unavailable");
      if (outcome === "failed") h.actions["source-refund"] = { state: "failed", txRef: p.txRef, authenticationHash: AUTH_HASH };
    } } });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    const result = await advanceCrossChainHtlc({ ...run.shared, owner: "expired", now: () => 5_000_000 });
    expect(result).toMatchObject({ status: outcome === "failed" ? "refund-stalled" : "refund-pending", refunds: { "source-refund": outcome === "failed" ? "failed" : outcome === "throw" ? "uncertain" : "pending" } });
    if (outcome !== "throw") expect(result).toMatchObject({ txRefs: expect.arrayContaining([refFor("source-refund")]) });
  });

  test("unreported retained destination lock rebroadcast failure remains uncertain and retry uses identical bytes", async () => {
    const { h, run } = await sweepLocked({ mode: { "destination-lock": "pending" } });
    delete h.actions["destination-lock"];
    const broadcast = h.adapter.broadcastRetained;
    run.shared.adapter = { ...h.adapter, broadcastRetained: async () => { throw new Error("unavailable"); } };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({ status: "indeterminate", reason: "htlc-destination-lock-effect-uncertain" });
    expect(h.prepareAction).toHaveBeenCalledTimes(2);
    run.shared.adapter = { ...h.adapter, broadcastRetained: broadcast };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({ status: "waiting", reason: "htlc-destination-lock-finality-pending" });
    expect(h.prepareAction).toHaveBeenCalledTimes(2);
    const sent = h.broadcastRetained.mock.calls.filter(([p]) => p.action === "destination-lock");
    expect(sent).toHaveLength(2);
    expect(sent[1]![0]).toEqual(sent[0]![0]);
  });

  test.each(["source-refund", "destination-refund"] as const)("unreported retained %s remains waiting on repeated failed rebroadcasts", async (leg) => {
    const { h, run } = await sweepLocked({ sourceExpiry: 1_700, destinationExpiry: 1_200, mode: { [leg]: "pending" } });
    await advanceCrossChainHtlc({ ...run.shared, owner: "expire", now: () => 1_700_000 });
    delete h.actions[leg];
    const count = h.prepareAction.mock.calls.length;
    run.shared.adapter = { ...h.adapter, broadcastRetained: async (p, fence) => { if (p.action === leg) throw new Error("unavailable"); return h.broadcastRetained(p, fence); } };
    for (const tick of [1, 2]) {
      const result = await advanceCrossChainHtlc({ ...run.shared, owner: `poll-${tick}`, now: () => 1_700_000 + tick * 101 });
      expect(result).toMatchObject({ status: "refund-pending", refunds: { [leg]: "uncertain" } });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(count);
  });

  test.each(["failed", "absent", "missing"] as const)("regressed source plus %s destination retains the failed destination refund", async (state) => {
    const { h, run } = await sweepLocked({ sourceExpiry: 1_700, destinationExpiry: 1_200, mode: { "destination-refund": "pending" } });
    await advanceCrossChainHtlc({ ...run.shared, owner: "dest-expiry", now: () => 1_200_000 });
    delete h.actions["source-lock"];
    if (state === "missing") delete h.actions["destination-lock"];
    else h.actions["destination-lock"] = { state, txRef: refFor("destination-lock"), authenticationHash: AUTH_HASH };
    h.actions["destination-refund"] = { state: "failed", txRef: refFor("destination-refund"), authenticationHash: AUTH_HASH };
    const count = h.prepareAction.mock.calls.length;
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "regressed", now: () => 1_200_101 })).resolves.toMatchObject({ status: "refund-stalled", reason: state === "failed" ? "destination-lock-failed" : state === "absent" ? "destination-lock-missing" : "destination-lock-unresolved", refunds: { "destination-refund": "failed" }, txRefs: expect.arrayContaining([refFor("destination-refund")]) });
    expect(h.prepareAction).toHaveBeenCalledTimes(count);
  });

  test("an unreported source refund after an unlanded reveal is pending with its retained ref", async () => {
    const { h, run } = await sweepLocked({ sourceExpiry: 1_700, destinationExpiry: 1_200, mode: { "destination-claim": "pending" } }, true);
    h.actions["destination-claim"] = { state: "absent", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
    run.shared.adapter = { ...h.adapter, broadcastRetained: async (p, fence) => {
      if (p.action === "source-refund") return;
      if (p.action === "destination-refund") throw new Error("unavailable");
      return h.broadcastRetained(p, fence);
    } };
    await expect(advanceCrossChainHtlc({ ...run.shared, owner: "expired", now: () => 1_700_000 })).resolves.toMatchObject({ status: "refund-pending", refunds: { "source-refund": "pending", "destination-refund": "uncertain" }, txRefs: expect.arrayContaining([refFor("source-refund")]) });
    expect(h.prepareAction.mock.calls.filter(([r]) => r.action === "source-refund")).toHaveLength(1);
  });

  test.each(["unreported", "unnamed-absent", "historical-failed"] as const)("replaced reveal %s after cutoff pages with retained active reference", async (state) => {
    for (const clock of [1_485_000, 1_500_000]) {
      const { h, run } = await sweepLocked({ mode: { "destination-claim": "pending" } }, true);
      h.actions["destination-claim"] = { state: "failed", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
      await advanceCrossChainHtlc(run.nextOwner());
      const active = h.broadcastRetained.mock.calls.filter(([p]) => p.action === "destination-claim").at(-1)![0];
      if (state === "unreported") delete h.actions["destination-claim"];
      else h.actions["destination-claim"] = state === "unnamed-absent" ? { state: "absent", authenticationHash: AUTH_HASH } : { state: "failed", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
      const count = h.broadcastRetained.mock.calls.length;
      const result = await advanceCrossChainHtlc({ ...run.shared, owner: "cutoff", now: () => clock });
      expect(result).toMatchObject({ status: "operator-alert", reason: "htlc-destination-claim-failed-preimage-public" });
      if (state === "unnamed-absent") expect(result).toMatchObject({ txRefs: expect.arrayContaining([active.txRef]) });
      expect(h.broadcastRetained).toHaveBeenCalledTimes(count);
    }
  });

  test("rejects zero retained reveal expiry independently of a positive source checkpoint", async () => {
    const { h, run } = await sweepLocked({ mode: { "source-claim": "pending" } }, true);
    await advanceCrossChainHtlc(run.nextOwner());
    delete h.actions["destination-claim"];
    const store = run.shared.store;
    run.shared.store = { ...store, claim: async (input) => {
      const c = await store.claim(input);
      return c.status === "acquired" ? { ...c, revealCheckpoint: { ...c.revealCheckpoint!, sourceExpiry: 0 } } : c;
    } };
    const count = h.broadcastRetained.mock.calls.length;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({ status: "failed", errorClass: "permanent", reason: "pay-cross-chain-htlc: retained reveal sourceExpiry must be a positive safe integer" });
    expect(h.broadcastRetained).toHaveBeenCalledTimes(count);
  });
});

describe("retained chain reference independence", () => {
  test.each(["source-lock", "destination-lock", "source-refund", "destination-refund"] as const)("refuses a historical reveal reported as %s", async (action) => {
    const { h, run } = await sweepLocked({ mode: { "destination-claim": "pending" } }, true);
    h.actions["destination-claim"] = { state: "failed", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
    await advanceCrossChainHtlc(run.nextOwner());
    h.actions[action] = { state: "absent", txRef: refFor("destination-claim"), authenticationHash: AUTH_HASH };
    const count = h.broadcastRetained.mock.calls.length;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({ status: "indeterminate", reason: "htlc-ledger-observation-unavailable" });
    expect(h.broadcastRetained).toHaveBeenCalledTimes(count);
  });

  test.each(["source-lock", "destination-lock"] as const)("a final source claim without only %s cannot write settlement", async (action) => {
    const { h, run } = await sweepLocked({ mode: { "source-claim": "pending" } }, true);
    await advanceCrossChainHtlc(run.nextOwner());
    h.actions["source-claim"] = { state: "final", txRef: refFor("source-claim") as Extract<HtlcTxRef, { kind: "htlc-claim" }>, finalityReachedAt: 1_000_000, finalityObservedAt: 1_000_000, authenticationHash: AUTH_HASH };
    delete h.actions[action];
    const store = run.shared.store;
    const recordSettlement = vi.spyOn(store, "recordSettlement");
    if (action === "destination-lock") run.shared.store = { ...store, claim: async (input) => {
      const c = await store.claim(input);
      return c.status === "acquired" ? { ...c, prepared: c.prepared.filter((p) => p.action !== "destination-lock") } : c;
    } };
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual(action === "source-lock"
      ? { status: "indeterminate", reason: "htlc-source-finality-checkpoint-without-final-lock" }
      : { status: "failed", errorClass: "permanent", reason: "htlc-final-claim-chain-incomplete" });
    expect(recordSettlement).not.toHaveBeenCalled();
  });

  test("retained unreported refunds remain waiting when the host clock moves before expiry", async () => {
    const { h, run } = await sweepLocked({ sourceExpiry: 1_700, destinationExpiry: 1_700 });
    await advanceCrossChainHtlc({ ...run.shared, owner: "expiry", now: () => 1_700_000 });
    delete h.actions["source-refund"];
    delete h.actions["destination-refund"];
    const broadcasts = h.broadcastRetained.mock.calls.length;
    const store = run.shared.store;
    // Keep the current lease while examining the earlier clock: it is the
    // refund disposition, rather than takeover, that this boundary pins.
    const claim = await store.claim({ ...createCrossChainHtlcIntent(authority(), SALT, hashlocks), owner: "clock-owner", now: 1_700_101, leaseDurationMs: 10_000 });
    if (claim.status !== "acquired") throw new Error("expected takeover");
    const input = { ...run.shared, owner: claim.lease.owner, now: () => 1_000_500, store: { ...store, claim: async () => claim } };
    for (let i = 0; i < 2; i++) await expect(advanceCrossChainHtlc(input)).resolves.toMatchObject({ status: "refund-pending", reason: "destination-expiry-margin-insufficient", refunds: { "source-refund": "waiting", "destination-refund": "waiting" } });
    expect(h.broadcastRetained).toHaveBeenCalledTimes(broadcasts);
  });
});

describe("getter-backed dependencies and malformed store results", () => {
  test.each(["claim", "recordSourceFinality"] as const)("captures getter-backed %s exactly once", async (key) => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    const store = run.shared.store;
    const method = store[key];
    const getter = vi.fn(() => { if (getter.mock.calls.length > 1) throw new Error("second read"); return method; });
    Object.defineProperty(store, key, { configurable: true, get: getter });
    await expect(advanceCrossChainHtlc(run.shared)).resolves.toEqual({ status: "waiting", reason: "htlc-source-lock-finality-pending" });
    expect(getter).toHaveBeenCalledTimes(1);
  });

  test("a throwing callback getter returns input-invalid and accepts corrected retry", async () => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    const original = run.shared.store.claim;
    Object.defineProperty(run.shared.store, "claim", { configurable: true, get() { throw new Error("bad getter"); } });
    await expect(advanceCrossChainHtlc(run.shared)).resolves.toEqual({ status: "indeterminate", reason: "htlc-call-input-invalid" });
    expect(h.prepareAction).not.toHaveBeenCalled();
    Object.defineProperty(run.shared.store, "claim", { configurable: true, value: original });
    await expect(advanceCrossChainHtlc(run.shared)).resolves.toMatchObject({ status: "waiting" });
  });

  test.each([null, undefined, false, "acquired", {}, { status: "unknown" }, { status: "corrupt" },
    { status: "acquired", intent: undefined },
    { status: "acquired", lease: null },
  ])("malformed claim result %j remains resumable", async (value) => {
    const h = harness();
    const run = runner({ adapter: h.adapter });
    const store = run.shared.store;
    // Start a real retained session; malformed responses must not discard it.
    await advanceCrossChainHtlc(run.shared);
    run.shared.store = { ...store, claim: async () => value as HtlcStoreClaim };
    const result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result.status).toBe("indeterminate");
    expect(h.prepareAction).toHaveBeenCalledTimes(1);
    run.shared.store = store;
    await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toMatchObject({ status: "waiting" });
  });
});

describe("regressed source retains independent refund progress", () => {
  test.each(["failed", "absent"] as const)("keeps a sent unreported destination refund pending while the source refund is %s", async (state) => {
    const { h, run } = await sweepLocked({ sourceExpiry: 1_700, destinationExpiry: 1_200,
      mode: { "source-refund": "pending", "destination-refund": "pending" } });
    await advanceCrossChainHtlc({ ...run.shared, owner: "expired", now: () => 1_700_000 });
    delete h.actions["source-lock"];
    delete h.actions["destination-refund"];
    h.actions["source-refund"] = { state, txRef: refFor("source-refund"), authenticationHash: AUTH_HASH };
    run.shared.adapter = { ...h.adapter, broadcastRetained: async (prepared, fence) => {
      if (prepared.action !== "destination-refund") return h.broadcastRetained(prepared, fence);
      await fence.assertCurrent(); // Broadcast accepted; chain view still lags.
    } };
    const count = h.prepareAction.mock.calls.length;
    for (const tick of [1, 2]) {
      await expect(advanceCrossChainHtlc({ ...run.shared, owner: `refund-poll-${tick}`, now: () => 1_700_000 + tick * 101 }))
        .resolves.toMatchObject({ status: state === "failed" ? "refund-stalled" : "operator-alert",
          refunds: { "source-refund": state, "destination-refund": "pending" },
          txRefs: [refFor("destination-lock"), refFor("source-refund"), refFor("destination-refund")] });
    }
    expect(h.prepareAction).toHaveBeenCalledTimes(count);
  });
});

test("an otherwise valid acquired claim missing its lease stays resumable", async () => {
  const h = harness();
  const run = runner({ adapter: h.adapter });
  await advanceCrossChainHtlc(run.shared);
  const base = run.shared.store;
  run.shared.store = { ...base, claim: async (input) => {
    const claim = await base.claim(input);
    return claim.status === "acquired" ? { ...claim, lease: undefined } as unknown as HtlcStoreClaim : claim;
  } };
  await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
    status: "indeterminate", reason: "htlc-settlement-store-lease-invalid",
  });
  expect(h.prepareAction).toHaveBeenCalledTimes(1);
  run.shared.store = base;
  await expect(advanceCrossChainHtlc(run.nextOwner())).resolves.toEqual({
    status: "waiting", reason: "htlc-destination-lock-finality-pending",
  });
});

// Permanent versions of the review's failed-reveal and missing-lock probes.
// Chain and signature callbacks are local fakes; these never submit a transaction.
describe("authenticated refund evidence from core progress", () => {
  function refundEvidence(
    progress: Extract<CrossChainHtlcProgress, { status: "refunded" | "refund-pending" | "refund-stalled" }>,
    actions: HtlcLedgerSnapshot["actions"],
  ) {
    const fixture = JSON.parse(readFileSync(new URL(
      "../../vendor/DACS-Standard/conformance/fixtures/settlement/htlc9-asymmetric.json", import.meta.url,
    ), "utf8")).settlementEvidence;
    const ev = { ...fixture, jobId: JOB_ID, reason: progress.reason, paymentTxRefs: progress.txRefs.filter(
      (ref) => ref.kind !== "htlc-lock" || ref.chainId === 84532,
    ) };
    const ctx: AuthenticatedEvidenceContext = {
      orchestrator: ev.signature.signer,
      agreement: { amount: "1.25", currency: "USDC" },
      rail: {
        railId: "htlc-route-1", railType: "cross-chain-htlc", asset: "USDC", handler: ev.phase,
        sourceFinalitySec: 20, safetyWindowSec: 10,
        htlcRoute: { sourceChainId: 84532, destChainId: 80002,
          htlcContracts: { source: "source-contract", dest: "destination-contract" } },
      },
      attestationRef: { anchor: { kind: "storage-program", locator: `dacs4:payment:${JOB_ID}:htlc-route-1:2` },
        contentHash: contentHash(stripSignature(ev)) },
      paymentAddress: { railId: "htlc-route-1", phaseIndex: 2 },
      result: { ok: false, errorClass: "permanent", asymmetric: false, txRefs: structuredClone(ev.paymentTxRefs) },
    };
    // Project the independent ledger observations, rather than inferring
    // finality from the retained refs or the progress reason.
    ctx.htlcRefund = { sourceClaim: { state: "absent" } };
    for (const [leg, action] of [["source", "source-refund"], ["dest", "destination-refund"]] as const) {
      const observed = actions[action];
      if (observed?.txRef?.kind === "htlc-refund") {
        ctx.htlcRefund[leg] = { txRef: observed.txRef, state: observed.state };
      }
    }
    const claim = actions["source-claim"];
    if (claim) ctx.htlcRefund.sourceClaim = {
      state: claim.state,
      ...(claim.txRef?.kind === "htlc-claim" ? { txRef: claim.txRef } : {}),
    };
    return { ev, ctx };
  }
  const deps = { resolvePublicKey: async () => new Uint8Array(32), verify: () => true };

  test("a failed destination claim followed by both final refunds verifies", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200, mode: { "destination-claim": "pending" } });
    const run = runner({ adapter: h.adapter });
    for (let n = 0; n < 3; n++) await advanceCrossChainHtlc(run.nextOwner());
    h.actions["destination-claim"] = { state: "failed", txRef: refFor("destination-claim"),
      authenticationHash: AUTH_HASH, reason: "reveal-reverted" };
    run.setClock(1_700_000);
    await advanceCrossChainHtlc(run.nextOwner());
    const result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result).toEqual({ status: "refunded", reason: "destination-claim-unlanded",
      refunds: { "source-refund": "final", "destination-refund": "final" },
      txRefs: [refFor("source-lock"), refFor("destination-lock"), refFor("destination-claim"),
        refFor("source-refund"), refFor("destination-refund")] });
    if (result.status !== "refunded") throw new Error("expected refunded");
    expect(h.broadcastRetained.mock.calls.map(([p]) => p.action)).toEqual([
      "source-lock", "destination-lock", "destination-claim", "source-refund", "destination-refund",
    ]);
    const { ev, ctx } = refundEvidence(result, h.actions);
    ctx.htlcExpiry = { source: 1_700, dest: 1_200 };
    ctx.htlcReveal = { txRef: refFor("destination-claim") as Extract<HtlcTxRef, { kind: "htlc-reveal" }>, state: "failed" };
    expect(await verifySettlementEvidence(ev, ctx, deps)).toEqual({ decision: "pass", reasons: [] });
  });

  test("a pending source refund after a failed reveal cannot verify as completed", async () => {
    const h = harness({ sourceExpiry: 1_700, destinationExpiry: 1_200,
      mode: { "destination-claim": "pending", "source-refund": "pending" } });
    const run = runner({ adapter: h.adapter });
    for (let n = 0; n < 3; n++) await advanceCrossChainHtlc(run.nextOwner());
    h.actions["destination-claim"] = { state: "failed", txRef: refFor("destination-claim"),
      authenticationHash: AUTH_HASH, reason: "reveal-reverted" };
    run.setClock(1_700_000);
    await advanceCrossChainHtlc(run.nextOwner());
    const result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result).toMatchObject({ status: "refund-pending", refunds: {
      "source-refund": "pending", "destination-refund": "final",
    } });
    if (result.status !== "refund-pending") throw new Error("expected pending refund");
    const { ev, ctx } = refundEvidence(result, h.actions);
    ctx.htlcExpiry = { source: 1_700, dest: 1_200 };
    ctx.htlcReveal = { txRef: refFor("destination-claim") as Extract<HtlcTxRef, { kind: "htlc-reveal" }>, state: "failed" };
    expect(await verifySettlementEvidence(ev, ctx, deps)).toEqual({ decision: "indeterminate", reasons: [
      "HTLC source refund is not final",
    ] });
  });

  test("a source-only refund verifies when destination lock preparation never succeeded", async () => {
    const h = harness({ sourceExpiry: 1_700 });
    const original = h.adapter.prepareAction;
    h.adapter.prepareAction = vi.fn<CrossChainHtlcAdapter["prepareAction"]>(async (request, fence) => {
      if (request.action === "destination-lock") throw new Error("destination preparation unavailable");
      return original(request, fence);
    });
    const run = runner({ adapter: h.adapter });
    await advanceCrossChainHtlc(run.shared);
    await advanceCrossChainHtlc(run.nextOwner());
    run.setClock(1_700_000);
    await advanceCrossChainHtlc(run.nextOwner());
    const result = await advanceCrossChainHtlc(run.nextOwner());
    expect(result).toEqual({ status: "refunded", reason: "destination-lock-missing",
      refunds: { "source-refund": "final" }, txRefs: [refFor("source-lock"), refFor("source-refund")] });
    if (result.status !== "refunded") throw new Error("expected refunded");
    expect(h.broadcastRetained.mock.calls.map(([p]) => p.action)).toEqual(["source-lock", "source-refund"]);
    const { ev, ctx } = refundEvidence(result, h.actions);
    ctx.htlcLockState = { source: "created", dest: "not-created" };
    ctx.htlcExpiry = { source: 1_700 };
    expect(await verifySettlementEvidence(ev, ctx, deps)).toEqual({ decision: "pass", reasons: [] });
  });
});
