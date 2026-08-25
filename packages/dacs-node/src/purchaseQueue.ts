import {
  getAuthenticatedRailProvenance,
  isAuthenticatedRailDefinition,
} from "@kynesyslabs/dacs";
import {
  captureFixedPricePayDemProtocolBinding,
  createFixedPricePayDemBuyerCoordinator,
  captureFixedPriceX402ProtocolBinding,
  createFixedPriceX402BuyerCoordinator,
  fixedPricePayDemOrderBindingHash,
  fixedPricePayDemOrderLocalBindingHash,
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
  FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
  FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
  FIXED_PRICE_X402_COMMERCE_PROFILE,
  FIXED_PRICE_X402_REGISTRY_INDEX_REF,
  FIXED_PRICE_X402_STANDARD_REVISION,
  type FixedPriceX402ProtocolBinding,
  type FixedPricePayDemProtocolBinding,
} from "@kynesyslabs/dacs/commerce";
import { isListing } from "@kynesyslabs/dacs/artifacts";
import {
  canonicalize,
  contentHash,
  listingAddress,
  sha256Hex,
} from "@kynesyslabs/dacs/canonical";
import {
  canonicalDemosAgentPublicKey,
  sameCanonicalClaimIdentity,
} from "@kynesyslabs/dacs/identity";
import { isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";

import {
  createDacsGuardedPurchasePlanV1,
  createDacsGuardedPayDemPurchasePlanV1,
  type DacsGuardedExecutorV1,
  type DacsGuardedPurchasePlanV1,
} from "./guardedCommands.js";
import type {
  DacsPayDemExistingListingAdmissionV1,
  DacsX402ExistingListingAdmissionV1,
} from "./listingDoctor.js";
import {
  createDacsFixedPricePayDemRoleOrderV1,
  createDacsFixedPriceX402RoleOrderV1,
} from "./liveOrder.js";
import {
  loadDacsLiveOrderInputV1,
  putDacsLiveOrderInputV1,
} from "./orderInput.js";
import type { DacsNodeSqliteDatabase } from "./sqlite.js";

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export interface DacsPrepareX402PurchaseOptionsV1 {
  admission: Readonly<DacsX402ExistingListingAdmissionV1>;
  jobId: string;
  buyerAuthority: string;
  payer: string;
  request: Readonly<Record<string, unknown>>;
  maximumServiceAmount: string;
  maximumNetworkFeeEth: string;
  maximumDemosStorageWriteFeeDem: Readonly<Record<"buyer" | "seller", string>>;
  resume?: boolean;
}

export interface DacsPreparedX402PurchaseV1 {
  plan: Readonly<DacsGuardedPurchasePlanV1>;
  order: Readonly<ReturnType<typeof createDacsFixedPriceX402RoleOrderV1>>;
  application: Readonly<{
    applicationVersion: "1";
    listingRef: string;
    listingContentHash: string;
    listingLogicalAddress: string;
    listing: Readonly<DacsX402ExistingListingAdmissionV1["listing"]>;
    requestHash: string;
    request: Readonly<Record<string, unknown>>;
  }>;
}

export interface DacsPreparePayDemPurchaseOptionsV1 {
  admission: Readonly<DacsPayDemExistingListingAdmissionV1>;
  jobId: string;
  buyerAuthority: string;
  payer: string;
  request: Readonly<Record<string, unknown>>;
  maximumServiceAmount: string;
  maximumTotalDebitDem: string;
  maximumDemosStorageWriteFeeDem: Readonly<Record<"buyer" | "seller", string>>;
  resume?: boolean;
}

export interface DacsPreparedPayDemPurchaseV1 {
  plan: Readonly<ReturnType<typeof createDacsGuardedPayDemPurchasePlanV1>>;
  order: Readonly<ReturnType<typeof createDacsFixedPricePayDemRoleOrderV1>>;
  application: DacsPreparedX402PurchaseV1["application"];
}

export type DacsPreparedLivePurchaseV1 =
  | DacsPreparedX402PurchaseV1
  | DacsPreparedPayDemPurchaseV1;

export interface DacsPurchaseQueueExecutorOptionsV1 {
  prepared: Readonly<DacsPreparedLivePurchaseV1>;
  database: DacsNodeSqliteDatabase;
  workerId: string;
}

export class DacsPurchaseQueueError extends Error {
  override readonly name = "DacsPurchaseQueueError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function canonicalCopy<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function factString(
  admission: Readonly<DacsX402ExistingListingAdmissionV1>,
  name: string,
): string {
  const value = admission.facts[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new DacsPurchaseQueueError("purchase-listing-facts-invalid");
  }
  return value;
}

/** Convert resolver-retained PA-2 provenance into the exact coordinator pin. */
export function createDacsFixedPriceX402ProtocolBindingV1(
  admission: Readonly<DacsX402ExistingListingAdmissionV1>,
): Readonly<FixedPriceX402ProtocolBinding> {
  if (admission === null || typeof admission !== "object" ||
      !isAuthenticatedRailDefinition(admission.rail)) {
    throw new TypeError("authenticated x402 Listing admission is invalid");
  }
  const provenance = getAuthenticatedRailProvenance(admission.rail);
  const rail = admission.rail;
  const seller = factString(admission, "seller");
  const network = factString(admission, "network");
  const listing = admission.listing;
  const accepted = listing.acceptedRails?.find((candidate) =>
    candidate.railId === rail.railId && candidate.railVersion === rail.railVersion);
  if (provenance === null || !isListing(listing) ||
      !/^stor-[0-9a-f]{40}$/.test(admission.listingRef) ||
      contentHash(listing as unknown as Record<string, unknown>) !==
        admission.listingContentHash ||
      listingAddress(listing.seller.identity.presentedBy, listing.listingId,
        listing.listingVersion) !== admission.logicalAddress ||
      factString(admission, "listingRef") !== admission.listingRef ||
      factString(admission, "logicalAddress") !== admission.logicalAddress ||
      factString(admission, "listingContentHash") !== admission.listingContentHash ||
      rail.railType !== "x402" ||
      rail.phaseHandler !== "pay-x402" || rail.availability !== "live" ||
      rail.asset.kind !== "erc20" || network !== `eip155:${rail.asset.chainId}` ||
      rail.railId !== factString(admission, "railId") ||
      rail.railVersion !== admission.facts.railVersion ||
      accepted === undefined || accepted.parameters?.network !== network ||
      String(accepted.parameters.payTo).toLowerCase() !== factString(admission, "payee") ||
      String(accepted.parameters.asset).toLowerCase() !== rail.asset.contract.toLowerCase() ||
      listing.pricing.kind !== "fixed" ||
      listing.pricing.price.amount !== factString(admission, "amount") ||
      listing.pricing.price.currency !== factString(admission, "asset") ||
      !sameCanonicalClaimIdentity(seller, admission.listing.seller.identity.presentedBy)) {
    throw new DacsPurchaseQueueError("purchase-protocol-binding-invalid");
  }
  return deepFreeze(captureFixedPriceX402ProtocolBinding({
    commerceProfile: FIXED_PRICE_X402_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_X402_STANDARD_REVISION,
    phase: "pay-x402",
    orchestratorTopology: "seller-as-phase-orchestrator-v1",
    orchestrator: seller,
    rail: {
      registryIndexRef: FIXED_PRICE_X402_REGISTRY_INDEX_REF,
      registryIndexHash: provenance.indexContentHash,
      railDefinitionRef: provenance.definitionRef.logicalAddress,
      railDefinitionHash: provenance.definitionContentHash,
      railId: rail.railId,
      railVersion: rail.railVersion,
      railType: "x402",
      phaseHandler: "pay-x402",
      network,
      availability: "live",
    },
  }));
}

/** Convert an authenticated native DEM Listing into the exact coordinator pin. */
export function createDacsFixedPricePayDemProtocolBindingV1(
  admission: Readonly<DacsPayDemExistingListingAdmissionV1>,
): Readonly<FixedPricePayDemProtocolBinding> {
  if (admission === null || typeof admission !== "object" ||
      !isAuthenticatedRailDefinition(admission.rail)) {
    throw new TypeError("authenticated pay-dem Listing admission is invalid");
  }
  const provenance = getAuthenticatedRailProvenance(admission.rail);
  const rail = admission.rail;
  const seller = factString(admission, "seller");
  const payee = factString(admission, "payee");
  const listing = admission.listing;
  const accepted = listing.acceptedRails?.find((candidate) =>
    candidate.railId === rail.railId && candidate.railVersion === rail.railVersion);
  if (provenance === null || !isListing(listing) ||
      !/^stor-[0-9a-f]{40}$/.test(admission.listingRef) ||
      contentHash(listing as unknown as Record<string, unknown>) !==
        admission.listingContentHash ||
      listingAddress(listing.seller.identity.presentedBy, listing.listingId,
        listing.listingVersion) !== admission.logicalAddress ||
      factString(admission, "listingRef") !== admission.listingRef ||
      factString(admission, "logicalAddress") !== admission.logicalAddress ||
      factString(admission, "listingContentHash") !== admission.listingContentHash ||
      rail.railType !== "demos-native" || rail.phaseHandler !== "pay-dem" ||
      rail.availability !== "live" || rail.asset.kind !== "native-dem" ||
      rail.asset.symbol !== "DEM" || rail.asset.decimals !== 9 ||
      rail.network.kind !== "demos" || factString(admission, "network") !== "demos" ||
      rail.railId !== factString(admission, "railId") ||
      rail.railVersion !== admission.facts.railVersion || accepted === undefined ||
      accepted.parameters?.network !== "demos" || accepted.parameters?.payTo !== payee ||
      !/^[0-9a-f]{64}$/.test(payee) || listing.pricing.kind !== "fixed" ||
      listing.pricing.price.amount !== factString(admission, "amount") ||
      listing.pricing.price.currency !== "DEM" || factString(admission, "asset") !== "DEM" ||
      !sameCanonicalClaimIdentity(seller, listing.seller.identity.presentedBy)) {
    throw new DacsPurchaseQueueError("purchase-protocol-binding-invalid");
  }
  return deepFreeze(captureFixedPricePayDemProtocolBinding({
    commerceProfile: FIXED_PRICE_PAY_DEM_COMMERCE_PROFILE,
    standardRevision: FIXED_PRICE_PAY_DEM_STANDARD_REVISION,
    phase: "pay-dem",
    orchestratorTopology: "seller-as-phase-orchestrator-v1",
    orchestrator: seller,
    rail: {
      registryIndexRef: FIXED_PRICE_PAY_DEM_REGISTRY_INDEX_REF,
      registryIndexHash: provenance.indexContentHash,
      railDefinitionRef: provenance.definitionRef.logicalAddress,
      railDefinitionHash: provenance.definitionContentHash,
      railId: rail.railId,
      railVersion: rail.railVersion,
      railType: "demos-native",
      phaseHandler: "pay-dem",
      network: "demos",
      availability: "live",
    },
  }));
}

/** Build the exact immutable purchase intent displayed before consent. */
export function prepareDacsX402PurchaseV1(
  options: Readonly<DacsPrepareX402PurchaseOptionsV1>,
): Readonly<DacsPreparedX402PurchaseV1> {
  if (options === null || typeof options !== "object" ||
      !isCanonicalJobId(options.jobId) || !EVM_ADDRESS_RE.test(options.payer) ||
      options.request === null || typeof options.request !== "object" ||
      Array.isArray(options.request) ||
      (options.resume !== undefined && typeof options.resume !== "boolean")) {
    throw new TypeError("x402 purchase preparation options are invalid");
  }
  let request: Readonly<Record<string, unknown>>;
  try {
    request = deepFreeze(canonicalCopy(options.request));
  } catch {
    throw new DacsPurchaseQueueError("purchase-request-not-canonical");
  }
  const admission = options.admission;
  const protocol = createDacsFixedPriceX402ProtocolBindingV1(admission);
  const seller = factString(admission, "seller");
  const payee = factString(admission, "payee");
  const network = factString(admission, "network");
  const asset = factString(admission, "asset");
  const amount = factString(admission, "amount");
  const requestHash = sha256Hex(canonicalize(request));
  const order = createDacsFixedPriceX402RoleOrderV1({
    role: "buyer",
    jobId: options.jobId,
    buyer: options.buyerAuthority,
    seller,
    protocol,
  });
  const plan = createDacsGuardedPurchasePlanV1({
    effectId: `purchase:${options.jobId}:${requestHash}`,
    jobId: options.jobId,
    resume: options.resume,
    listingRef: admission.listingRef,
    requestHash,
    buyerAuthority: options.buyerAuthority,
    sellerAuthority: seller,
    payer: options.payer,
    payee,
    railId: admission.rail.railId,
    network,
    asset,
    serviceAmount: amount,
    maximumServiceAmount: options.maximumServiceAmount,
    estimatedNetworkFeeEth: "0",
    maximumNetworkFeeEth: options.maximumNetworkFeeEth,
    maximumDemosStorageWriteFeeDem: options.maximumDemosStorageWriteFeeDem,
  });
  return deepFreeze({
    plan,
    order,
    application: {
      applicationVersion: "1" as const,
      listingRef: admission.listingRef,
      listingContentHash: admission.listingContentHash,
      listingLogicalAddress: admission.logicalAddress,
      listing: canonicalCopy(admission.listing),
      requestHash,
      request,
    },
  });
}

/** Build a consent-bound native DEM order after the buyer selects that sibling. */
export function prepareDacsPayDemPurchaseV1(
  options: Readonly<DacsPreparePayDemPurchaseOptionsV1>,
): Readonly<DacsPreparedPayDemPurchaseV1> {
  const payerKey = canonicalDemosAgentPublicKey(options?.buyerAuthority);
  if (options === null || typeof options !== "object" ||
      !isCanonicalJobId(options.jobId) || payerKey === null ||
      Buffer.from(payerKey).toString("hex") !== options.payer ||
      options.request === null || typeof options.request !== "object" ||
      Array.isArray(options.request) ||
      (options.resume !== undefined && typeof options.resume !== "boolean")) {
    throw new TypeError("pay-dem purchase preparation options are invalid");
  }
  let request: Readonly<Record<string, unknown>>;
  try {
    request = deepFreeze(canonicalCopy(options.request));
  } catch {
    throw new DacsPurchaseQueueError("purchase-request-not-canonical");
  }
  const admission = options.admission;
  const protocol = createDacsFixedPricePayDemProtocolBindingV1(admission);
  const seller = factString(admission, "seller");
  const payee = factString(admission, "payee");
  const amount = factString(admission, "amount");
  const requestHash = sha256Hex(canonicalize(request));
  const order = createDacsFixedPricePayDemRoleOrderV1({
    role: "buyer",
    jobId: options.jobId,
    buyer: options.buyerAuthority,
    seller,
    protocol,
  });
  const plan = createDacsGuardedPayDemPurchasePlanV1({
    effectId: `purchase:${options.jobId}:${requestHash}`,
    jobId: options.jobId,
    resume: options.resume,
    listingRef: admission.listingRef,
    requestHash,
    buyerAuthority: options.buyerAuthority,
    sellerAuthority: seller,
    payer: options.payer,
    payee,
    railId: admission.rail.railId,
    serviceAmount: amount,
    maximumServiceAmount: options.maximumServiceAmount,
    maximumTotalDebitDem: options.maximumTotalDebitDem,
    maximumDemosStorageWriteFeeDem: options.maximumDemosStorageWriteFeeDem,
  });
  return deepFreeze({
    plan,
    order,
    application: {
      applicationVersion: "1" as const,
      listingRef: admission.listingRef,
      listingContentHash: admission.listingContentHash,
      listingLogicalAddress: admission.logicalAddress,
      listing: canonicalCopy(admission.listing),
      requestHash,
      request,
    },
  });
}

/**
 * Enqueue a consent-bound buyer order. Exact replay is idempotent in both the
 * retained input and coordinator store, so a lost local response never creates
 * a second job or payment authority.
 */
export function createDacsPurchaseQueueExecutorV1(
  options: Readonly<DacsPurchaseQueueExecutorOptionsV1>,
): DacsGuardedExecutorV1 {
  if (options === null || typeof options !== "object" ||
      options.database === null || typeof options.database !== "object" ||
      typeof options.workerId !== "string" || options.workerId.length === 0 ||
      options.workerId.trim() !== options.workerId) {
    throw new TypeError("purchase queue executor options are invalid");
  }
  const prepared = deepFreeze(canonicalCopy(options.prepared)) as
    Readonly<DacsPreparedLivePurchaseV1>;
  const expectedPlan = canonicalize(prepared.plan);
  const payDem = prepared.order.protocol.phase === "pay-dem";
  const expectedPlanKind = payDem ? "purchase-pay-dem" : "purchase";
  if (prepared.plan.kind !== expectedPlanKind ||
      prepared.order.sdkJobs.role !== "buyer" ||
      prepared.plan.jobId !== prepared.order.jobId ||
      prepared.plan.buyerAuthority !== prepared.order.buyer ||
      prepared.plan.sellerAuthority !== prepared.order.seller ||
      prepared.application.requestHash !== prepared.plan.requestHash ||
      sha256Hex(canonicalize(prepared.application.request)) !== prepared.plan.requestHash) {
    throw new TypeError("prepared purchase queue input is inconsistent");
  }

  return async ({ plan, fence }) => {
    if (plan.kind !== expectedPlanKind || canonicalize(plan) !== expectedPlan) {
      return Object.freeze({ status: "operator-action" as const,
        reasonCode: "purchase-queue-plan-mismatch" });
    }
    try {
      await fence.assertCurrent();
      const coordinator = payDem
        ? createFixedPricePayDemBuyerCoordinator({
            store: options.database.createPayDemCoordinatorStore("buyer"),
            workerId: options.workerId,
            operations: {},
          })
        : createFixedPriceX402BuyerCoordinator({
            store: options.database.createLiveCoordinatorStore("buyer"),
            workerId: options.workerId,
            operations: {},
          });
      if (prepared.plan.resume) {
        const [existingOrder, existingInput] = await Promise.all([
          coordinator.getOrderStatus(prepared.order.jobId),
          Promise.resolve(payDem
            ? loadDacsLiveOrderInputV1({
                database: options.database,
                order: prepared.order as DacsPreparedPayDemPurchaseV1["order"],
              })
            : loadDacsLiveOrderInputV1({
                database: options.database,
                order: prepared.order as DacsPreparedX402PurchaseV1["order"],
              })),
        ]);
        if (existingOrder === null || existingInput === undefined) {
          return Object.freeze({ status: "operator-action" as const,
            reasonCode: "purchase-resume-target-missing" });
        }
        const bindingHash = payDem
          ? fixedPricePayDemOrderBindingHash(prepared.order as
              DacsPreparedPayDemPurchaseV1["order"])
          : fixedPriceX402OrderBindingHash(prepared.order as
              DacsPreparedX402PurchaseV1["order"]);
        const localBindingHash = payDem
          ? fixedPricePayDemOrderLocalBindingHash(prepared.order as
              DacsPreparedPayDemPurchaseV1["order"])
          : fixedPriceX402OrderLocalBindingHash(prepared.order as
              DacsPreparedX402PurchaseV1["order"]);
        if (existingOrder.bindingHash !== bindingHash ||
            existingOrder.localBindingHash !== localBindingHash ||
            canonicalize(existingInput.application) !== canonicalize(prepared.application)) {
          return Object.freeze({ status: "operator-action" as const,
            reasonCode: "purchase-resume-binding-mismatch" });
        }
      }
      await fence.assertCurrent();
      const retained = putDacsLiveOrderInputV1({
        database: options.database,
        order: prepared.order,
        application: prepared.application,
      });
      if (retained.status === "conflict") {
        return Object.freeze({ status: "operator-action" as const,
          reasonCode: "purchase-order-input-conflict" });
      }
      await fence.assertCurrent();
      const status = payDem
        ? await (coordinator as ReturnType<typeof createFixedPricePayDemBuyerCoordinator>)
            .startOrder(prepared.order as DacsPreparedPayDemPurchaseV1["order"])
        : await (coordinator as ReturnType<typeof createFixedPriceX402BuyerCoordinator>)
            .startOrder(prepared.order as DacsPreparedX402PurchaseV1["order"]);
      await fence.assertCurrent();
      const result = Object.freeze({
        jobId: status.jobId,
        bindingHash: status.bindingHash,
        localBindingHash: status.localBindingHash,
        milestone: status.milestone,
        orderInputStatus: retained.status,
      });
      return fence.mode === "perform"
        ? Object.freeze({ status: "completed" as const, result })
        : Object.freeze({ status: "reconciled-performed" as const, result });
    } catch {
      return fence.mode === "perform"
        ? Object.freeze({ status: "ambiguous" as const,
            reasonCode: "purchase-queue-reconciliation-required" })
        : Object.freeze({ status: "reconciled-indeterminate" as const,
            reasonCode: "purchase-queue-reconciliation-required" });
    }
  };
}
