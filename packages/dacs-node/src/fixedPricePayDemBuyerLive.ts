import {
  createPayDemSellerObserver,
  type AuthenticatedRailDefinition,
  type DemosTransferObservation,
} from "@kynesyslabs/dacs";

import { createDacsFixedPricePayDemBuyerAuditV1 } from
  "./fixedPriceX402BuyerAudit.js";
import { createDacsFixedPricePayDemBuyerCommerceV1 } from
  "./fixedPricePayDemBuyerCommerce.js";
import {
  createDacsFixedPricePayDemBuyerPaymentV1,
  createDacsFixedPricePayDemBuyerReconciliationV1,
} from "./fixedPricePayDemBuyerPayment.js";
import {
  createDacsFixedPricePayDemBuyerAgreementPolicyV1,
} from "./fixedPricePayDemProfile.js";
import {
  captureDacsFixedPriceX402ApplicationV1,
  DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
} from "./fixedPriceX402Profile.js";
import { createDacsBuyerPayDemLiveCommerceAssemblyV1 } from
  "./livePayDemCommerceAssembly.js";
import type { DacsBuyerPayDemLiveCommerceGraphV1 } from
  "./livePayDemCommerceGraph.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import type { DacsVetTerminalBundleTransportOptionsV1 } from
  "./terminalBundleTransportRuntime.js";

export interface DacsFixedPricePayDemBuyerLiveOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  rail: Readonly<AuthenticatedRailDefinition>;
  demosRpcUrl: string;
  recipeRegistryVersion: number;
  observeDemosTransfer?(txHash: string): Promise<DemosTransferObservation>;
  observerTimeoutMs?: number;
  observerMaxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  effectLeaseDurationMs?: number;
  leaseDurationMs?: number;
  retryDelayMs?: number;
  terminalBundle?: Readonly<Omit<
    DacsVetTerminalBundleTransportOptionsV1,
    "context"
  >>;
}

/** Close the complete fixed-price native DEM buyer graph. */
export async function createDacsFixedPricePayDemBuyerLiveV1(
  options: Readonly<DacsFixedPricePayDemBuyerLiveOptionsV1>,
): Promise<Readonly<DacsBuyerPayDemLiveCommerceGraphV1>> {
  const observer = options.observeDemosTransfer === undefined
    ? createPayDemSellerObserver({
        rpc: options.demosRpcUrl,
        ...(options.observerTimeoutMs === undefined
          ? {} : { timeoutMs: options.observerTimeoutMs }),
        ...(options.observerMaxResponseBytes === undefined
          ? {} : { maxResponseBytes: options.observerMaxResponseBytes }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      }).observeDemosTransfer
    : options.observeDemosTransfer;
  const agreement = createDacsFixedPricePayDemBuyerAgreementPolicyV1({
    context: options.context,
  });
  const payment = createDacsFixedPricePayDemBuyerPaymentV1({
    context: options.context,
    rail: options.rail,
  });
  const commerce = createDacsFixedPricePayDemBuyerCommerceV1({
    context: options.context,
    rail: options.rail,
    observeDemosTransfer: observer,
    ...(options.retryDelayMs === undefined
      ? {} : { retryDelayMs: options.retryDelayMs }),
  });
  const audit = createDacsFixedPricePayDemBuyerAuditV1({
    context: options.context,
    rail: options.rail,
    observeDemosTransfer: observer,
    recipeRegistryVersion: options.recipeRegistryVersion,
    ...(options.leaseDurationMs === undefined
      ? {} : { leaseTtlMs: options.leaseDurationMs }),
  });
  return createDacsBuyerPayDemLiveCommerceAssemblyV1({
    context: options.context,
    workerId: options.workerId,
    sessionBootstrap: {
      resolveRequirements({ retained }) {
        const application = captureDacsFixedPriceX402ApplicationV1(
          retained.application,
        );
        return Object.freeze({
          buyer: application.listing.buyerRequirement,
          seller: DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
        });
      },
    },
    agreement,
    payment: {
      resolveAuthority: payment.resolveAuthority,
      reconcile: createDacsFixedPricePayDemBuyerReconciliationV1(observer),
      ...(options.effectLeaseDurationMs === undefined
        ? {} : { effectLeaseDurationMs: options.effectLeaseDurationMs }),
      ...(options.retryDelayMs === undefined
        ? {} : { retryDelayMs: options.retryDelayMs }),
    },
    paymentEvidence: {
      ...commerce.paymentEvidence,
      ...(options.leaseDurationMs === undefined
        ? {} : { leaseDurationMs: options.leaseDurationMs }),
      ...(options.retryDelayMs === undefined
        ? {} : { retryDelayMs: options.retryDelayMs }),
    },
    buyerReceived: commerce.buyerReceived,
    bundleTransport: audit.bundleTransport,
    audit: audit.audit,
    ...(options.terminalBundle === undefined
      ? {} : { terminalBundle: options.terminalBundle }),
  });
}
