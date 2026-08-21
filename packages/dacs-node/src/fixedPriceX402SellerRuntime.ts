import type {
  AuthenticatedRailDefinition,
  X402PaywallConfig,
  X402SellerRenderedResponse,
} from "@kynesyslabs/dacs";

import {
  createDacsFixedPriceX402SellerFulfilmentV1,
  type DacsPublicStorageDeliverableInputV1,
  type DacsFixedPriceX402SellerFulfilmentV1,
} from "./fixedPriceX402SellerFulfilment.js";
import {
  createDacsFixedPriceX402SellerSettlementV1,
  type DacsFixedPriceX402SellerSettlementV1,
} from
  "./fixedPriceX402SellerSettlement.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import {
  createDacsSellerX402RuntimeV1,
  type DacsSellerX402RuntimeOptionsV1,
  type DacsSellerX402RuntimeV1,
} from "./sellerX402Runtime.js";

export interface DacsFixedPriceX402SellerRuntimeOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  rail: Readonly<AuthenticatedRailDefinition>;
  tokenDomain: Readonly<{ name: string; version: string }>;
  amount: string;
  facilitator: X402PaywallConfig["facilitator"];
  evmRpcUrl: string;
  authorizationSearchFromBlock: number;
  recipeRegistryVersion: number;
  prepareDeliverable(
    input: Readonly<DacsPublicStorageDeliverableInputV1>,
  ): Promise<Readonly<Record<string, unknown>>> |
    Readonly<Record<string, unknown>>;
  maxTimeoutSeconds?: number;
  finalityTag?: "finalized" | "safe" | "latest";
  logPageSize?: number;
  fetchImpl?: typeof fetch;
  description?: string;
  serviceName?: string;
  retryDelayMs?: number;
  leaseTtlMs?: number;
  maxResponseBytes?: number;
}

export interface DacsFixedPriceX402SellerX402CompositionV1 {
  readonly settlement: Readonly<DacsFixedPriceX402SellerSettlementV1>;
  readonly fulfilment: Readonly<DacsFixedPriceX402SellerFulfilmentV1>;
  readonly x402: Readonly<Omit<
    DacsSellerX402RuntimeOptionsV1<unknown>,
    "context" | "workerId"
  >>;
}

function jsonResponse(
  body: unknown,
): Readonly<X402SellerRenderedResponse<unknown>> {
  return Object.freeze({
    status: 200,
    headers: Object.freeze({ "content-type": "application/json" }),
    body,
  });
}

/**
 * One-call composition of authenticated x402 settlement and durable public
 * Storage Program fulfilment. Audit/payment-evidence tracks remain owned by
 * the surrounding role graph, while this factory owns the complete paid HTTP
 * resource and its payment/delivery/evidence replay boundaries.
 */
export function createDacsFixedPriceX402SellerX402CompositionV1(
  options: Readonly<DacsFixedPriceX402SellerRuntimeOptionsV1>,
): Readonly<DacsFixedPriceX402SellerX402CompositionV1> {
  const settlement = createDacsFixedPriceX402SellerSettlementV1({
    context: options.context,
    rail: options.rail,
    tokenDomain: options.tokenDomain,
    amount: options.amount,
    facilitator: options.facilitator,
    evmRpcUrl: options.evmRpcUrl,
    authorizationSearchFromBlock: options.authorizationSearchFromBlock,
    ...(options.maxTimeoutSeconds === undefined
      ? {} : { maxTimeoutSeconds: options.maxTimeoutSeconds }),
    ...(options.finalityTag === undefined ? {} : { finalityTag: options.finalityTag }),
    ...(options.logPageSize === undefined ? {} : { logPageSize: options.logPageSize }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.description === undefined ? {} : { description: options.description }),
    mimeType: "application/json",
    ...(options.serviceName === undefined ? {} : { serviceName: options.serviceName }),
  });
  const fulfilment = createDacsFixedPriceX402SellerFulfilmentV1({
    context: options.context,
    authority: settlement.authority,
    workerId: options.workerId,
    recipeRegistryVersion: options.recipeRegistryVersion,
    prepareDeliverable: options.prepareDeliverable,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });
  const readCompletedPayload = async (input: Readonly<{
    logicalAddress: string;
    jobId: string;
    phaseIndex: number;
    phase: "deliver-storage-program" | "deliver-entitlement" |
      "deliver-attested-payload";
  }>) => {
    const resolved = await fulfilment.fulfilmentDeps.resolveDelivery(input);
    if (resolved.status !== "verified" ||
        resolved.value.artifact.cleartextPayload === undefined) {
      throw new Error("seller response deliverable readback unavailable");
    }
    return resolved.value.artifact.cleartextPayload;
  };
  const x402: DacsFixedPriceX402SellerX402CompositionV1["x402"] = {
    paywall: settlement.paywall,
    publicBaseUrl: settlement.publicBaseUrl,
    resolveHttpRequest: settlement.resolveHttpRequest,
    resolveOrderScope: settlement.resolveOrderScope,
    authorizePaymentComplete: settlement.authorizePaymentComplete,
    spine: {
      ...settlement.spine,
      fulfilmentDeps: fulfilment.fulfilmentDeps,
      fulfilmentDurability: fulfilment.fulfilmentDurability,
      deliveryReady: {
        renderResponse: ({ deliveryReady }) => {
          const payload = deliveryReady.result.artifact.cleartextPayload;
          if (payload === undefined) {
            throw new Error("seller delivery-ready payload unavailable");
          }
          return jsonResponse(payload);
        },
      },
      renderResponse: async ({ jobId, deliveryPhaseIndex, fulfilment: completed }) =>
        jsonResponse(await readCompletedPayload({
          logicalAddress: completed.evidence.outcome === "success"
            ? completed.evidence.deliverableAnchor.locator
            : `dacs4:deliverable:${jobId}`,
          jobId,
          phaseIndex: deliveryPhaseIndex,
          phase: completed.evidence.phase,
        })),
    },
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    ...(options.maxResponseBytes === undefined
      ? {} : { maxResponseBytes: options.maxResponseBytes }),
  };
  return Object.freeze({
    settlement,
    fulfilment,
    x402: Object.freeze(x402),
  });
}

/**
 * Standalone paid-resource wrapper. Full role graphs should consume
 * `createDacsFixedPriceX402SellerX402CompositionV1` so their assembly remains
 * the single owner of the x402 runtime instance.
 */
export async function createDacsFixedPriceX402SellerRuntimeProfileV1(
  options: Readonly<DacsFixedPriceX402SellerRuntimeOptionsV1>,
): Promise<Readonly<DacsSellerX402RuntimeV1<unknown>>> {
  const composition = createDacsFixedPriceX402SellerX402CompositionV1(options);
  return createDacsSellerX402RuntimeV1({
    ...composition.x402,
    context: options.context,
    workerId: options.workerId,
  });
}
