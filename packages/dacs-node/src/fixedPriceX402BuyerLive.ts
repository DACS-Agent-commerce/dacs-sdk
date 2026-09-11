import {
  baseUnits,
  type AuthenticatedRailDefinition,
  type X402BuyerEvmDisclosureRecovery,
  type X402BuyerEvmUnusedConfirmer,
} from "@kynesyslabs/dacs";

import {
  createDacsFixedPriceX402BuyerAuditV1,
} from "./fixedPriceX402BuyerAudit.js";
import {
  createDacsFixedPriceX402BuyerCommerceV1,
} from "./fixedPriceX402BuyerCommerce.js";
import {
  DACS_FIXED_PRICE_X402_EMPTY_REQUIREMENT_V1,
  captureDacsFixedPriceX402ApplicationV1,
  createDacsFixedPriceX402BuyerAgreementPolicyV1,
  createDacsFixedPriceX402BuyerPaymentPolicyV1,
} from "./fixedPriceX402Profile.js";
import {
  createDacsBuyerLiveCommerceAssemblyV1,
} from "./liveCommerceAssembly.js";
import type { DacsBuyerLiveCommerceGraphV1 } from "./liveCommerceGraph.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

export interface DacsFixedPriceX402BuyerLiveOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  rail: Readonly<AuthenticatedRailDefinition>;
  tokenDomain: Readonly<{ name: string; version: string }>;
  /** Operator-consented service ceiling in canonical major units. */
  maximumServiceAmount: string;
  maxTimeoutSeconds: number;
  minimumConfirmations: number;
  authorizationSearchFromBlock: number;
  evmRpcUrl: string;
  recipeRegistryVersion: number;
  finalityTag?: "finalized" | "safe" | "latest";
  logPageSize?: number;
  confirmUnused?: X402BuyerEvmUnusedConfirmer;
  recoverDisclosure?: X402BuyerEvmDisclosureRecovery;
  fetchImpl?: typeof fetch;
  effectLeaseDurationMs?: number;
  settlementLeaseDurationMs?: number;
  leaseDurationMs?: number;
  retryDelayMs?: number;
  maxBodyBytes?: number;
}

/**
 * Close the buyer graph around the fixed-price x402 policies. The remaining
 * DACS-5 review and publication are reconstructed from authenticated durable
 * protocol state; callers cannot inject an audit or counter-signing bypass.
 */
export async function createDacsFixedPriceX402BuyerLiveV1(
  options: Readonly<DacsFixedPriceX402BuyerLiveOptionsV1>,
): Promise<Readonly<DacsBuyerLiveCommerceGraphV1>> {
  const asset = options.rail.asset;
  if (asset.kind !== "erc20") {
    throw new TypeError("fixed-price x402 buyer requires an ERC-20 rail asset");
  }
  const maximumServiceAmount = baseUnits(
    options.maximumServiceAmount,
    asset.decimals,
  );
  const agreement = createDacsFixedPriceX402BuyerAgreementPolicyV1({
    context: options.context,
  });
  const payment = createDacsFixedPriceX402BuyerPaymentPolicyV1({
    context: options.context,
    rail: options.rail,
    tokenDomain: options.tokenDomain,
    maxTimeoutSeconds: options.maxTimeoutSeconds,
  });
  const commerce = createDacsFixedPriceX402BuyerCommerceV1({
    context: options.context,
    rail: options.rail,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
  });
  const audit = createDacsFixedPriceX402BuyerAuditV1({
    context: options.context,
    rail: options.rail,
    evmRpcUrl: options.evmRpcUrl,
    authorizationSearchFromBlock: options.authorizationSearchFromBlock,
    recipeRegistryVersion: options.recipeRegistryVersion,
    ...(options.finalityTag === undefined ? {} : { finalityTag: options.finalityTag }),
    ...(options.logPageSize === undefined ? {} : { logPageSize: options.logPageSize }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.leaseDurationMs === undefined ? {} : { leaseTtlMs: options.leaseDurationMs }),
  });

  return createDacsBuyerLiveCommerceAssemblyV1({
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
      ...payment,
      maximumServiceAmount,
      minimumConfirmations: options.minimumConfirmations,
      authorizationSearchFromBlock: options.authorizationSearchFromBlock,
      ...(options.confirmUnused === undefined ? {} : { confirmUnused: options.confirmUnused }),
      ...(options.recoverDisclosure === undefined
        ? {} : { recoverDisclosure: options.recoverDisclosure }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.maxBodyBytes === undefined
        ? {} : { maxResponseBytes: options.maxBodyBytes }),
      ...(options.effectLeaseDurationMs === undefined
        ? {} : { effectLeaseDurationMs: options.effectLeaseDurationMs }),
      ...(options.settlementLeaseDurationMs === undefined
        ? {} : { settlementLeaseDurationMs: options.settlementLeaseDurationMs }),
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    },
    paymentEvidence: {
      ...commerce.paymentEvidence,
      ...(options.leaseDurationMs === undefined
        ? {} : { leaseDurationMs: options.leaseDurationMs }),
      ...(options.retryDelayMs === undefined ? {} : { retryDelayMs: options.retryDelayMs }),
    },
    buyerReceived: commerce.buyerReceived,
    bundleTransport: audit.bundleTransport,
    audit: audit.audit,
  });
}
