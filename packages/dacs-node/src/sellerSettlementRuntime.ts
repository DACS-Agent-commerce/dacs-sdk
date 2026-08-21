import {
  publishSellerSessionSettlement,
  type FixedPriceX402TrackOperation,
  type FixedPriceX402TrackOperationInput,
  type SellerSessionSettlementPublicationDeps,
  type SellerSessionSettlementPublicationRequest,
} from "@kynesyslabs/dacs";

import {
  loadDacsLiveOrderInputForTrackV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import type { DacsSellerPaymentEvidenceRuntimeV1 } from "./paymentEvidenceRuntime.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

const DEFAULT_RETRY_DELAY_MS = 1_000;
const INERT_RECEIVER = Object.freeze(Object.create(null)) as object;

export type DacsSellerSettlementPublicationDependenciesV1 = Omit<
  SellerSessionSettlementPublicationDeps,
  "receiptStore" | "evidenceSigner" | "anchorEvidence"
>;

export interface DacsSellerSettlementPublicationTrackOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  paymentEvidence: Readonly<DacsSellerPaymentEvidenceRuntimeV1>;
  resolvePublication(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Promise<Readonly<{
    request: Readonly<SellerSessionSettlementPublicationRequest>;
    dependencies: Readonly<DacsSellerSettlementPublicationDependenciesV1>;
  }>> | Readonly<{
    request: Readonly<SellerSessionSettlementPublicationRequest>;
    dependencies: Readonly<DacsSellerSettlementPublicationDependenciesV1>;
  }>;
  authorizePublished(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    evidenceHash: string;
    reference: string;
  }>): Promise<boolean> | boolean;
  retryDelayMs?: number;
}

export class DacsSellerSettlementRuntimeError extends Error {
  override readonly name = "DacsSellerSettlementRuntimeError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function plainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).every((key) => {
        if (typeof key !== "string") return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
      });
  } catch {
    return false;
  }
}

function retryDelay(value: unknown): number {
  const captured = value ?? DEFAULT_RETRY_DELAY_MS;
  if (!Number.isSafeInteger(captured) || Number(captured) <= 0 ||
      Number(captured) > 600_000) {
    throw new TypeError("seller settlement runtime timing is invalid");
  }
  return Number(captured);
}

function reasonCode(prefix: string, reason: string): string {
  const suffix = reason.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 80 - prefix.length - 1).replace(/-+$/g, "");
  return suffix.length === 0 ? prefix : `${prefix}-${suffix}`;
}

function nextRetry(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  delay: number,
): number {
  const value = context.database.readTime() + delay;
  if (!Number.isSafeInteger(value)) {
    throw new DacsSellerSettlementRuntimeError("seller-settlement-retry-time-overflow");
  }
  return value;
}

function bound(operation: Readonly<FixedPriceX402TrackOperationInput>): boolean {
  return operation.order.role === "seller" && operation.fence.role === "seller" &&
    operation.fence.track === "payment-evidence" &&
    operation.order.jobId === operation.fence.jobId &&
    operation.order.bindingHash === operation.fence.bindingHash &&
    operation.order.localBindingHash === operation.fence.localBindingHash;
}

/**
 * Compose the normative seller settlement publisher with the buyer-owned
 * payment-evidence handshake. The seller remains the evidence author while
 * the buyer owns only the Demos publication lane selected by PC-7.
 */
export function createDacsSellerSettlementPublicationTrackV1(
  options: Readonly<DacsSellerSettlementPublicationTrackOptionsV1>,
): FixedPriceX402TrackOperation {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "seller" ||
      options.context.demos.role !== "seller" ||
      options.context.commerceStores.role !== "seller" ||
      !plainObject(options.paymentEvidence) ||
      typeof options.paymentEvidence.anchorEvidence !== "function" ||
      typeof options.paymentEvidence.flushOutboundRequests !== "function" ||
      typeof options.resolvePublication !== "function" ||
      typeof options.authorizePublished !== "function") {
    throw new TypeError("seller settlement publication track options are invalid");
  }
  const context = options.context;
  const paymentEvidence = options.paymentEvidence;
  const delay = retryDelay(options.retryDelayMs);
  const commerceStores = context.commerceStores;
  if (commerceStores.role !== "seller") {
    throw new TypeError("seller settlement publication track options are invalid");
  }
  const receiptStore = commerceStores.sellerReceipts;
  if (typeof receiptStore.inspectPermit !== "function") {
    throw new TypeError("seller settlement publication track options are invalid");
  }

  return async (operation) => {
    if (!bound(operation)) {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-settlement-track-binding-mismatch",
      });
    }
    let retained: Readonly<DacsLiveOrderInputV1>;
    let resolved: Awaited<ReturnType<typeof options.resolvePublication>>;
    try {
      retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
      resolved = await options.resolvePublication({ operation, retained });
      if (!plainObject(resolved) || !plainObject(resolved.request) ||
          !plainObject(resolved.dependencies)) throw new Error();
      await operation.fence.assertCurrent();
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-settlement-publication-input-invalid",
      });
    }

    const dependencies = resolved.dependencies;
    const publicationDependencies: SellerSessionSettlementPublicationDeps = {
      ...dependencies,
      receiptStore: {
        inspectPermit: (permitId) => receiptStore.inspectPermit!(permitId),
      },
      evidenceSigner: {
        algorithm: "ed25519",
        signer: context.authority,
        sign: async (bytes, signatureContext) => {
          await operation.fence.assertCurrent();
          return Reflect.apply(context.demos.signComponent, INERT_RECEIVER, [
            bytes,
            signatureContext,
          ]);
        },
      },
      anchorEvidence: (input) => paymentEvidence.anchorEvidence(operation, input),
    };

    let result: Awaited<ReturnType<typeof publishSellerSessionSettlement>>;
    let transport: Awaited<ReturnType<
      DacsSellerPaymentEvidenceRuntimeV1["flushOutboundRequests"]
    >>;
    try {
      result = await publishSellerSessionSettlement(
        resolved.request,
        publicationDependencies,
      );
      transport = await paymentEvidence.flushOutboundRequests(operation);
    } catch {
      return Object.freeze({
        status: "pending-retry" as const,
        reasonCode: "seller-settlement-runtime-indeterminate",
        retryAt: nextRetry(context, delay),
      });
    }
    if (transport.status === "rejected") {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-payment-evidence-peer-rejected",
      });
    }
    if (result.disposition === "published") {
      const reference = result.settlement.evidenceRef.anchor.locator;
      try {
        await operation.fence.assertCurrent();
        if (await options.authorizePublished({
          operation,
          retained,
          evidenceHash: result.evidenceHash,
          reference,
        }) !== true) {
          throw new Error();
        }
        await operation.fence.assertCurrent();
      } catch {
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: "seller-settlement-publication-unauthorized",
        });
      }
      return Object.freeze({
        status: "final" as const,
        outcome: "success" as const,
        reference,
        authenticationHash: result.evidenceHash,
      });
    }
    if (result.disposition === "rejected" || result.disposition === "error") {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: reasonCode("seller-settlement", result.reason),
      });
    }
    return Object.freeze({
      status: "pending-retry" as const,
      reasonCode: reasonCode("seller-settlement-pending", result.reason),
      retryAt: nextRetry(context, delay),
    });
  };
}
