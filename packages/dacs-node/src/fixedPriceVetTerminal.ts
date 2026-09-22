import {
  getAuthenticatedRailProvenance,
  isFinalizedVetAnchorReceipt,
  type AuthenticatedRailDefinition,
  type PrepareVetTerminalBundleInput,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";
import { sameCanonicalClaimIdentity } from "@kynesyslabs/dacs/identity";

import { captureDacsFixedPriceX402ApplicationV1 } from
  "./fixedPriceX402Profile.js";
import type { DacsSessionVetTerminalTrackV1 } from
  "./sessionBootstrapAgreementRuntime.js";

export interface DacsFixedPriceVetTerminalProjectionOptionsV1 {
  rail: Readonly<AuthenticatedRailDefinition>;
  recipeRegistryVersion: number;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshot<T>(value: T): Readonly<T> {
  return deepFreeze(JSON.parse(canonicalize(value)) as T);
}

/**
 * Project the exact Listing/session/registry facts retained before agreement
 * into the DACS-2 -> DACS-5 terminal bridge. No caller-selected phase, party,
 * rail, or Listing reference enters the signed failure bundle.
 */
export function createDacsFixedPriceVetTerminalInputFactoryV1(
  options: Readonly<DacsFixedPriceVetTerminalProjectionOptionsV1>,
): DacsSessionVetTerminalTrackV1["createInput"] {
  const railProvenance = getAuthenticatedRailProvenance(options.rail);
  if (railProvenance === null ||
      !Number.isSafeInteger(railProvenance.registryVersion) ||
      railProvenance.registryVersion <= 0 ||
      !Number.isSafeInteger(options.recipeRegistryVersion) ||
      options.recipeRegistryVersion <= 0) {
    throw new TypeError("fixed-price Vet terminal registry provenance is invalid");
  }
  const railRegistryVersion = railProvenance.registryVersion;
  const recipeRegistryVersion = options.recipeRegistryVersion;
  return (input): Readonly<PrepareVetTerminalBundleInput> => {
    const application = captureDacsFixedPriceX402ApplicationV1(
      input.retained.application,
    );
    const operation = input.operation;
    const listingVetIndexes = application.listing.pipeline.flatMap((step, index) =>
      step.kind === "vet-credentials" ? [index] : []);
    if (listingVetIndexes.length !== 1 ||
        input.retained.jobId !== operation.order.jobId ||
        input.retained.localBindingHash !== operation.order.localBindingHash ||
        !sameCanonicalClaimIdentity(
          input.buyerIdentity.presentedBy,
          operation.order.buyer,
        ) ||
        !sameCanonicalClaimIdentity(
          input.sellerIdentity.presentedBy,
          operation.order.seller,
        ) ||
        !Number.isSafeInteger(input.vetInvokedAt) || input.vetInvokedAt < 0 ||
        !Number.isSafeInteger(operation.order.createdAt) ||
        operation.order.createdAt < 0 || input.vetInvokedAt < operation.order.createdAt ||
        !isFinalizedVetAnchorReceipt(input.production.anchorReceipt)) {
      throw new TypeError("fixed-price Vet terminal session projection is invalid");
    }
    // The signed Listing is the single source of truth for the ordered
    // pipeline. Never synthesize a Vet phase that the seller did not sign.
    const pipeline = application.listing.pipeline;
    const vetPhaseIndex = listingVetIndexes[0]!;
    const production: PrepareVetTerminalBundleInput["production"] = {
      record: input.production.record,
      recordRef: input.production.recordRef,
      anchorReceipt: input.production.anchorReceipt,
    };
    return snapshot({
      jobId: operation.order.jobId,
      listingRef: {
        listingId: application.listing.listingId,
        version: application.listing.listingVersion,
        contentHash: application.listingContentHash,
      },
      pipeline,
      vetPhaseIndex,
      vetInvokedAt: input.vetInvokedAt,
      startedAt: operation.order.createdAt,
      recipeRegistryVersion,
      railRegistryVersion,
      parties: [
        { role: "buyer" as const, identityBundle: input.buyerIdentity },
        { role: "seller" as const, identityBundle: input.sellerIdentity },
      ],
      evaluatedRole: input.evaluatedRole,
      production,
    });
  };
}
