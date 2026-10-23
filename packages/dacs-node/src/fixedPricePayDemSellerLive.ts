import {
  createPayDemSellerObserver,
  type AuthenticatedRailDefinition,
  type DemosTransferObservation,
} from "@kynesyslabs/dacs";

import { createDacsFixedPricePayDemSellerAuditV1 } from
  "./fixedPriceX402SellerAudit.js";
import { createDacsFixedPricePayDemSellerPaymentEvidenceV1 } from
  "./fixedPriceX402SellerPaymentEvidence.js";
import {
  createDacsFixedPricePayDemSellerFulfilmentV1,
} from "./fixedPricePayDemSellerFulfilment.js";
import {
  createDacsFixedPricePayDemSellerAgreementPolicyV1,
  createDacsFixedPricePayDemSellerSessionPolicyV1,
} from "./fixedPricePayDemProfile.js";
import { createDacsSellerPayDemLiveCommerceAssemblyV1 } from
  "./livePayDemCommerceAssembly.js";
import type { DacsSellerPayDemLiveCommerceGraphV1 } from
  "./livePayDemCommerceGraph.js";
import type { DacsPublicStorageDeliverableInputV1 } from
  "./fixedPriceX402SellerFulfilment.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

export interface DacsFixedPricePayDemSellerLiveOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  rail: Readonly<AuthenticatedRailDefinition>;
  demosRpcUrl: string;
  sellerPublicEndpoint: string;
  sellerPayee: string;
  maximumServiceAmount: string;
  recipeRegistryVersion: number;
  prepareDeliverable(
    input: Readonly<DacsPublicStorageDeliverableInputV1>,
  ): Promise<Readonly<Record<string, unknown>>> |
    Readonly<Record<string, unknown>>;
  observeDemosTransfer?(txHash: string): Promise<DemosTransferObservation>;
  observerTimeoutMs?: number;
  observerMaxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  maximumClockSkewMs?: number;
  effectLeaseDurationMs?: number;
  leaseTtlMs?: number;
  retryDelayMs?: number;
}

/** Close the complete fixed-price native DEM seller graph. */
export async function createDacsFixedPricePayDemSellerLiveV1(
  options: Readonly<DacsFixedPricePayDemSellerLiveOptionsV1>,
): Promise<Readonly<DacsSellerPayDemLiveCommerceGraphV1>> {
  if (options.context.role !== "seller" ||
      options.context.commerceStores.role !== "seller") {
    throw new TypeError("fixed-price pay-dem seller live options are invalid");
  }
  const sellerReceipts = options.context.commerceStores.sellerReceipts;
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
  const session = createDacsFixedPricePayDemSellerSessionPolicyV1({
    context: options.context,
    rail: options.rail,
    sellerPublicEndpoint: options.sellerPublicEndpoint,
    sellerPayee: options.sellerPayee,
    maximumServiceAmount: options.maximumServiceAmount,
  });
  const agreement = createDacsFixedPricePayDemSellerAgreementPolicyV1({
    context: options.context,
    ...(options.maximumClockSkewMs === undefined
      ? {} : { maximumClockSkewMs: options.maximumClockSkewMs }),
  });
  const fulfilment = createDacsFixedPricePayDemSellerFulfilmentV1({
    context: options.context,
    rail: options.rail,
    workerId: options.workerId,
    recipeRegistryVersion: options.recipeRegistryVersion,
    prepareDeliverable: options.prepareDeliverable,
    ...(options.leaseTtlMs === undefined
      ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });
  const paymentEvidence = createDacsFixedPricePayDemSellerPaymentEvidenceV1({
    context: options.context,
    observeDemosTransfer: observer,
  });
  const audit = createDacsFixedPricePayDemSellerAuditV1({
    context: options.context,
    fulfilment: fulfilment.fulfilment,
    ...(options.leaseTtlMs === undefined
      ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });
  return createDacsSellerPayDemLiveCommerceAssemblyV1({
    context: options.context,
    workerId: options.workerId,
    sessionBootstrap: {
      admitInit: session.admitInit,
      resolveBuyerRequirement: session.resolveBuyerRequirement,
      resolveSellerRequirement: session.resolveSellerRequirement,
    },
    agreementTransport: { admitProposal: session.admitProposal },
    agreement,
    payment: {
      resolvePayerPayingKey: ({ operation }) => operation.order.buyer,
      intakeDeps: {
        resolveCommittedAgreement: fulfilment.authority.resolveCommittedAgreement,
        resolveListingAtCommit: fulfilment.authority.resolveListingAtCommit,
        resolveRail: fulfilment.authority.resolveRail,
        resolveIdentityBundle: fulfilment.authority.resolveIdentityBundle,
        observeDemosTransfer: observer,
        receiptStore: sellerReceipts,
      },
      ...(options.effectLeaseDurationMs === undefined
        ? {} : { effectLeaseDurationMs: options.effectLeaseDurationMs }),
      ...(options.retryDelayMs === undefined
        ? {} : { retryDelayMs: options.retryDelayMs }),
    },
    paymentEvidence: {
      ...paymentEvidence.paymentEvidence,
      ...(options.retryDelayMs === undefined
        ? {} : { retryDelayMs: options.retryDelayMs }),
    },
    settlement: paymentEvidence.settlement,
    fulfilment: {
      fulfilment: fulfilment.fulfilment,
      ...(options.retryDelayMs === undefined
        ? {} : { retryDelayMs: options.retryDelayMs }),
    },
    audit,
  });
}
