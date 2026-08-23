import type { AuthenticatedRailDefinition } from "@kynesyslabs/dacs";

import {
  createDacsFixedPriceSellerFulfilmentV1,
  type DacsFixedPriceSellerFulfilmentV1,
  type DacsPublicStorageDeliverableInputV1,
} from "./fixedPriceX402SellerFulfilment.js";
import {
  createDacsFixedPricePayDemSellerAuthorityV1,
  type DacsFixedPricePayDemSellerAuthorityV1,
} from "./fixedPricePayDemSellerAuthority.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

export interface DacsFixedPricePayDemSellerFulfilmentOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  rail: Readonly<AuthenticatedRailDefinition>;
  workerId: string;
  recipeRegistryVersion: number;
  leaseTtlMs?: number;
  prepareDeliverable(
    input: Readonly<DacsPublicStorageDeliverableInputV1>,
  ): Promise<Readonly<Record<string, unknown>>> |
    Readonly<Record<string, unknown>>;
}

export interface DacsFixedPricePayDemSellerFulfilmentV1 {
  authority: Readonly<DacsFixedPricePayDemSellerAuthorityV1>;
  fulfilment: Readonly<DacsFixedPriceSellerFulfilmentV1>;
}

/**
 * Compose the native seller authority with the same permit-consuming durable
 * fulfilment engine used by x402. The selected rail changes payment proof, not
 * the delivery/evidence safety boundary.
 */
export function createDacsFixedPricePayDemSellerFulfilmentV1(
  options: Readonly<DacsFixedPricePayDemSellerFulfilmentOptionsV1>,
): Readonly<DacsFixedPricePayDemSellerFulfilmentV1> {
  const authority = createDacsFixedPricePayDemSellerAuthorityV1({
    context: options.context,
    rail: options.rail,
  });
  const fulfilment = createDacsFixedPriceSellerFulfilmentV1({
    context: options.context,
    authority,
    paymentProfile: "pay-dem",
    workerId: options.workerId,
    recipeRegistryVersion: options.recipeRegistryVersion,
    prepareDeliverable: options.prepareDeliverable,
    ...(options.leaseTtlMs === undefined ? {} : { leaseTtlMs: options.leaseTtlMs }),
  });
  return Object.freeze({ authority, fulfilment });
}
