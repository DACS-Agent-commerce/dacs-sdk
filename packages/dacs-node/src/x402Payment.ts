import {
  advanceX402BuyerSettlement,
  assertX402BuyerSettlementIntent,
  type FixedPriceX402TrackOperation,
  type FixedPriceX402TrackOperationInput,
  type X402BuyerAuthorizationProvider,
  type X402BuyerCapturedSettlement,
  type X402BuyerEffectFence,
  type X402BuyerPaidRequestTransport,
  type X402BuyerSettlementDisclosure,
  type X402BuyerSettlementIntent,
  type X402BuyerSettlementStore,
} from "@kynesyslabs/dacs";

import {
  createDacsLiveEffectTrackV1,
  type DacsLiveEffectExecutionControlV1,
  type DacsLiveEffectFenceV1,
  type DacsLiveEffectReconciliationV1,
} from "./liveEffects.js";
import type { DacsNodeSqliteDatabase } from "./sqlite.js";

const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsX402BuyerPaymentInputV1 {
  paymentInputVersion: "1";
  orderBindingHash: string;
  orderLocalBindingHash: string;
  intent: Readonly<X402BuyerSettlementIntent>;
}

export interface DacsX402BuyerPaymentResultV1 {
  paymentResultVersion: "1";
  settlement: Readonly<X402BuyerCapturedSettlement>;
}

export interface DacsX402BuyerPaymentTrackOptionsV1<TObservation = unknown> {
  database: DacsNodeSqliteDatabase;
  workerId: string;
  settlementStore: X402BuyerSettlementStore;
  authorizationProvider: X402BuyerAuthorizationProvider<TObservation>;
  transport: X402BuyerPaidRequestTransport;
  /**
   * Prepare and sign the exact x402 bearer. It runs only when no authenticated
   * SQLite effect intent exists; restart recovery reuses those exact bytes.
   */
  prepareIntent(
    input: Readonly<FixedPriceX402TrackOperationInput>,
  ): Promise<Readonly<X402BuyerSettlementIntent>> |
    Readonly<X402BuyerSettlementIntent>;
  /** Application-owned agreement/rail/session authority for the prepared intent. */
  authorizePreparedIntent(input: Readonly<{
    order: Readonly<FixedPriceX402TrackOperationInput["order"]>;
    intent: Readonly<X402BuyerSettlementIntent>;
  }>): Promise<boolean> | boolean;
  effectLeaseDurationMs?: number;
  settlementLeaseDurationMs?: number;
  retryDelayMs?: number;
}

export class DacsX402BuyerPaymentError extends Error {
  override readonly name = "DacsX402BuyerPaymentError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function safeReasonCode(prefix: string, value: unknown): string {
  const reason = typeof value === "string" ? value.toLowerCase() : "unavailable";
  const normalized = reason.replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/g, "");
  return `${prefix}-${normalized || "unavailable"}`.slice(0, 80).replace(/-+$/g, "");
}

function control(
  status: "indeterminate" | "operator-action",
  reasonCode: string,
): DacsLiveEffectExecutionControlV1 {
  return Object.freeze({ effectControlVersion: "1", status, reasonCode });
}

function capturePaymentInput(value: unknown): Readonly<DacsX402BuyerPaymentInputV1> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DacsX402BuyerPaymentError("x402-payment-input-invalid");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4 || record.paymentInputVersion !== "1" ||
      typeof record.orderBindingHash !== "string" || !HASH_RE.test(record.orderBindingHash) ||
      typeof record.orderLocalBindingHash !== "string" ||
      !HASH_RE.test(record.orderLocalBindingHash)) {
    throw new DacsX402BuyerPaymentError("x402-payment-input-invalid");
  }
  assertX402BuyerSettlementIntent(record.intent);
  return record as unknown as Readonly<DacsX402BuyerPaymentInputV1>;
}

function resultFromSettlement(
  settlement: Readonly<X402BuyerCapturedSettlement>,
): Readonly<DacsX402BuyerPaymentResultV1> {
  return Object.freeze({
    paymentResultVersion: "1",
    settlement,
  });
}

function disclosureFromSettlement(
  settlement: Readonly<X402BuyerCapturedSettlement>,
): Readonly<X402BuyerSettlementDisclosure> {
  return Object.freeze({
    protocolVersion: settlement.protocolVersion,
    headerName: settlement.headerName,
    encodedSettlementHeader: settlement.encodedSettlementHeader,
    httpResource: settlement.httpResource,
  });
}

function referenceFromSettlement(settlement: Readonly<X402BuyerCapturedSettlement>): string {
  return `x402:${settlement.signedEvent.chainId}:` +
    `${settlement.signedEvent.settlementTxHash}:${settlement.signedEvent.logIndex}`;
}

function combinedFence(
  inner: Readonly<X402BuyerEffectFence>,
  outer: Readonly<DacsLiveEffectFenceV1>,
): Readonly<X402BuyerEffectFence> {
  return Object.freeze({
    owner: inner.owner,
    generation: inner.generation,
    settlementKey: inner.settlementKey,
    bindingHash: inner.bindingHash,
    idempotencyKey: inner.idempotencyKey,
    async assertCurrent() {
      await outer.assertCurrent();
      await inner.assertCurrent();
    },
  });
}

function reconciliationFence(
  intent: Readonly<X402BuyerSettlementIntent>,
  outer: Readonly<DacsLiveEffectFenceV1>,
  owner: string,
): Readonly<X402BuyerEffectFence> {
  return Object.freeze({
    owner,
    generation: outer.generation,
    settlementKey: intent.settlementKey,
    bindingHash: intent.bindingHash,
    idempotencyKey: intent.settlementKey,
    assertCurrent: () => outer.assertCurrent(),
  });
}

/**
 * Compose the core durable buyer settlement state machine into the buyer's
 * payment track. The outer keyed SQLite fence is the only replay grant; the
 * inner x402 store retains the exact paid response for chain reconciliation.
 */
export function createDacsX402BuyerPaymentTrackV1<TObservation = unknown>(
  options: Readonly<DacsX402BuyerPaymentTrackOptionsV1<TObservation>>,
): FixedPriceX402TrackOperation {
  if (options === null || typeof options !== "object" ||
      typeof options.workerId !== "string" || options.workerId.length === 0 ||
      !options.settlementStore || typeof options.settlementStore.load !== "function" ||
      !options.authorizationProvider ||
      typeof options.authorizationProvider.authorizeIntent !== "function" ||
      typeof options.authorizationProvider.lookup !== "function" ||
      typeof options.authorizationProvider.authenticate !== "function" ||
      !options.transport || typeof options.transport.submitRetained !== "function" ||
      typeof options.prepareIntent !== "function" ||
      typeof options.authorizePreparedIntent !== "function") {
    throw new TypeError("x402 buyer payment track options are invalid");
  }
  if (options.database.metadata.mode !== "live-demos" ||
      options.database.metadata.role !== "buyer") {
    throw new TypeError("x402 buyer payment track requires a live buyer database");
  }
  const database = options.database;
  const workerId = options.workerId;
  const settlementStore = options.settlementStore;
  const provider = options.authorizationProvider;
  const transport = options.transport;
  const settlementLeaseDurationMs = options.settlementLeaseDurationMs ?? 30_000;
  if (!Number.isSafeInteger(settlementLeaseDurationMs) ||
      settlementLeaseDurationMs <= 0 || settlementLeaseDurationMs > 600_000) {
    throw new TypeError("x402 buyer settlement lease duration is invalid");
  }

  async function reconcileFromChain(
    paymentInput: Readonly<DacsX402BuyerPaymentInputV1>,
    outerFence: Readonly<DacsLiveEffectFenceV1>,
    candidate?: Readonly<X402BuyerSettlementDisclosure>,
  ): Promise<Readonly<DacsLiveEffectReconciliationV1<DacsX402BuyerPaymentResultV1>>> {
    const fence = reconciliationFence(paymentInput.intent, outerFence, workerId);
    try {
      await fence.assertCurrent();
      const lookup = await provider.lookup(paymentInput.intent, candidate, fence);
      await fence.assertCurrent();
      if (lookup.disposition !== "observed") {
        return {
          status: "indeterminate",
          reasonCode: safeReasonCode("x402", lookup.reason),
        };
      }
      const recovered = await provider.authenticate(
        paymentInput.intent,
        lookup,
        candidate,
        fence,
      );
      await fence.assertCurrent();
      if (recovered.disposition === "settled-same") {
        return {
          status: "completed",
          result: resultFromSettlement(recovered.settlement),
        };
      }
      if (recovered.disposition === "unused") {
        if (!HASH_RE.test(recovered.authenticationHash)) {
          return { status: "indeterminate", reasonCode: "x402-absence-proof-invalid" };
        }
        return { status: "absent", absenceProofHash: recovered.authenticationHash };
      }
      if (recovered.disposition === "used-different" ||
          recovered.disposition === "cancelled" ||
          recovered.disposition === "expired-unused") {
        return {
          status: "operator-action",
          reasonCode: `x402-terminal-${recovered.disposition}`,
        };
      }
      return {
        status: "indeterminate",
        reasonCode: safeReasonCode("x402", recovered.reason),
      };
    } catch {
      return {
        status: "indeterminate",
        reasonCode: "x402-authorization-reconciliation-unavailable",
      };
    }
  }

  const adapter = {
    async execute(invocation: Readonly<{
      input: Readonly<DacsX402BuyerPaymentInputV1>;
      fence: Readonly<DacsLiveEffectFenceV1>;
    }>) {
      const paymentInput = capturePaymentInput(invocation.input);
      if (paymentInput.orderLocalBindingHash !== invocation.fence.bindingHash ||
          paymentInput.intent.jobId !== invocation.fence.jobId) {
        return control("operator-action", "x402-payment-binding-mismatch");
      }
      const wrap = (fence: Readonly<X402BuyerEffectFence>) =>
        combinedFence(fence, invocation.fence);
      const progress = await advanceX402BuyerSettlement({
        intent: paymentInput.intent,
        owner: `${workerId}-${invocation.fence.generation}`,
        store: settlementStore,
        authorizationProvider: {
          authorizeIntent: (intent, fence) =>
            provider.authorizeIntent(intent, wrap(fence)),
          lookup: (intent, candidate, fence) =>
            provider.lookup(intent, candidate, wrap(fence)),
          authenticate: (intent, lookup, candidate, fence) =>
            provider.authenticate(intent, lookup, candidate, wrap(fence)),
        },
        transport: {
          submitRetained: (intent, fence) =>
            transport.submitRetained(intent, wrap(fence)),
        },
        now: () => database.readTime(),
        leaseDurationMs: settlementLeaseDurationMs,
      });
      if (progress.status === "captured") {
        // The inner store is a recovery checkpoint, not the keyed authority.
        // Re-authenticate even a retained terminal result before the outer
        // SQLite effect can become complete.
        const recovered = await reconcileFromChain(
          paymentInput,
          invocation.fence,
          disclosureFromSettlement(progress.outcome.settlement),
        );
        if (recovered.status === "completed") return recovered.result;
        if (recovered.status === "operator-action") {
          return control("operator-action", recovered.reasonCode);
        }
        return control(
          "indeterminate",
          recovered.status === "absent"
            ? "x402-paid-response-not-chain-final"
            : recovered.reasonCode,
        );
      }
      if (progress.status === "failed") {
        return control("operator-action", `x402-terminal-${progress.outcome.failure}`);
      }
      return control(
        "indeterminate",
        safeReasonCode("x402", progress.reason),
      );
    },

    async reconcile(invocation: Readonly<{
      input: Readonly<DacsX402BuyerPaymentInputV1>;
      fence: Readonly<DacsLiveEffectFenceV1>;
    }>): Promise<Readonly<DacsLiveEffectReconciliationV1<DacsX402BuyerPaymentResultV1>>> {
      const paymentInput = capturePaymentInput(invocation.input);
      if (paymentInput.orderLocalBindingHash !== invocation.fence.bindingHash ||
          paymentInput.intent.jobId !== invocation.fence.jobId) {
        return { status: "operator-action", reasonCode: "x402-payment-binding-mismatch" };
      }
      let candidate: Readonly<X402BuyerSettlementDisclosure> | undefined;
      try {
        const stored = await settlementStore.load(paymentInput.intent.settlementKey);
        if (stored.status === "captured") {
          if (stored.outcome.status !== "captured") {
            return { status: "indeterminate", reasonCode: "x402-store-terminal-invalid" };
          }
          candidate = disclosureFromSettlement(stored.outcome.settlement);
        } else if (stored.status === "failed") {
          if (stored.outcome.status !== "failed") {
            return { status: "indeterminate", reasonCode: "x402-store-terminal-invalid" };
          }
          // The inner filesystem store is deliberately not a terminal trust
          // root. Reconcile its retained intent against chain state below.
        } else if (stored.status === "held") candidate = stored.pendingDisclosure;
        else if (stored.status === "corrupt" || stored.status === "unsupported") {
          return {
            status: "indeterminate",
            reasonCode: stored.status === "corrupt"
              ? "x402-store-corrupt" : "x402-store-version-unsupported",
          };
        }
      } catch {
        return { status: "indeterminate", reasonCode: "x402-store-unavailable" };
      }
      return reconcileFromChain(paymentInput, invocation.fence, candidate);
    },
  };

  return createDacsLiveEffectTrackV1({
    database,
    kind: "payment",
    role: "buyer",
    track: "payment",
    workerId,
    ...(options.effectLeaseDurationMs === undefined
      ? {} : { leaseDurationMs: options.effectLeaseDurationMs }),
    ...(options.retryDelayMs === undefined
      ? {} : { retryDelayMs: options.retryDelayMs }),
    async buildInput(operationInput) {
      const intent = await options.prepareIntent(operationInput);
      assertX402BuyerSettlementIntent(intent);
      if (intent.jobId !== operationInput.order.jobId ||
          await options.authorizePreparedIntent({
            order: operationInput.order,
            intent,
          }) !== true) {
        throw new DacsX402BuyerPaymentError("x402-prepared-intent-unauthorized");
      }
      return {
        paymentInputVersion: "1" as const,
        orderBindingHash: operationInput.order.bindingHash,
        orderLocalBindingHash: operationInput.order.localBindingHash,
        intent,
      };
    },
    adapter,
    projectResult: (result) => ({
      reference: referenceFromSettlement(result.settlement),
      authenticationHash: result.settlement.authenticationHash,
    }),
  });
}
