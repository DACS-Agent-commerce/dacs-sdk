import {
  advanceCompletedBuyerBundleDurable,
  type BuyerBundleFinalizationDurability,
  type BuyerBundleTransport,
  type DurableBuyerBundleFinalizationInput,
  type DurableBuyerBundleFinalizationProvider,
  type DurableFinalizedBuyerBundle,
} from "@kynesyslabs/dacs";
import type {
  FixedPriceX402TrackOperation,
  FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import {
  finalizeCompletedSellerBundleDurable,
  prepareCompletedSellerBundleCounterSignatureRequest,
  type DurableSellerBundleFinalizationProvider,
  type FinalizeCompletedSellerBundleDurableInput,
  type FinalizeCompletedSellerBundleInput,
  type FinalizedSellerBundle,
  type SellerBundleFinalizationDurability,
} from "@kynesyslabs/dacs/seller";

import {
  loadDacsLiveOrderInputForTrackV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import type { DacsSellerBundleTransportRuntimeV1 } from "./bundleTransportRuntime.js";

const DEFAULT_RETRY_DELAY_MS = 1_000;

const BUYER_MATERIAL_RETRY_REASONS = new Set([
  "buyer-audit-anchor-unavailable",
  "buyer-audit-request-pending",
]);

const SELLER_MATERIAL_RETRY_REASONS = new Set([
  "seller-audit-anchor-unavailable",
  "seller-audit-authority-unavailable",
  "seller-audit-deliverable-unavailable",
  "seller-audit-terminal-wal-unavailable",
]);

export type DacsSellerAuditInputV1 = Omit<
  FinalizeCompletedSellerBundleDurableInput,
  "seller" | "counterSignatures" | "bindingSigner"
> & {
  seller: Omit<FinalizeCompletedSellerBundleInput["seller"], "signer">;
};

export interface DacsSellerAuditMaterialV1 {
  input: Readonly<DacsSellerAuditInputV1>;
  provider: Readonly<DurableSellerBundleFinalizationProvider>;
  durability: Readonly<Omit<
    SellerBundleFinalizationDurability,
    "store" | "workerId"
  >>;
}

export interface DacsBuyerAuditMaterialV1 {
  input: Readonly<Omit<DurableBuyerBundleFinalizationInput, "buyer"> & {
    buyer: Omit<DurableBuyerBundleFinalizationInput["buyer"], "signer">;
  }>;
  provider: Readonly<DurableBuyerBundleFinalizationProvider>;
  durability: Readonly<Omit<
    BuyerBundleFinalizationDurability,
    "store" | "workerId" | "transport"
  >>;
}

interface DacsAuditRuntimeCommonOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  workerId: string;
  retryDelayMs?: number;
}

export interface DacsSellerAuditRuntimeOptionsV1
  extends DacsAuditRuntimeCommonOptionsV1 {
  bundleTransport: Readonly<DacsSellerBundleTransportRuntimeV1>;
  resolveMaterial(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Promise<Readonly<DacsSellerAuditMaterialV1>> |
    Readonly<DacsSellerAuditMaterialV1>;
  authorizeFinalized(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    result: Readonly<FinalizedSellerBundle>;
  }>): Promise<boolean> | boolean;
}

export interface DacsBuyerAuditRuntimeOptionsV1
  extends DacsAuditRuntimeCommonOptionsV1 {
  bundleTransport: Readonly<BuyerBundleTransport>;
  resolveMaterial(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Promise<Readonly<DacsBuyerAuditMaterialV1>> |
    Readonly<DacsBuyerAuditMaterialV1>;
  authorizeFinalized(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    result: Readonly<DurableFinalizedBuyerBundle>;
  }>): Promise<boolean> | boolean;
}

export class DacsAuditRuntimeError extends Error {
  override readonly name = "DacsAuditRuntimeError";

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

function positiveInteger(value: unknown, fallback: number): number {
  const captured = value ?? fallback;
  if (!Number.isSafeInteger(captured) || Number(captured) <= 0 ||
      Number(captured) > 600_000) {
    throw new TypeError("audit runtime timing is invalid");
  }
  return Number(captured);
}

function operationBound(
  operation: Readonly<FixedPriceX402TrackOperationInput>,
  role: "buyer" | "seller",
): boolean {
  return operation.order.role === role && operation.fence.role === role &&
    operation.fence.track === "audit" &&
    operation.order.jobId === operation.fence.jobId &&
    operation.order.bindingHash === operation.fence.bindingHash &&
    operation.order.localBindingHash === operation.fence.localBindingHash;
}

function retryAt(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  delay: number,
): number {
  const value = context.database.readTime() + delay;
  if (!Number.isSafeInteger(value)) {
    throw new DacsAuditRuntimeError("audit-retry-time-overflow");
  }
  return value;
}

function validCommonOptions(
  options: Readonly<DacsAuditRuntimeCommonOptionsV1>,
  role: "buyer" | "seller",
): boolean {
  return plainObject(options) && plainObject(options.context) &&
    options.context.role === role && typeof options.workerId === "string" &&
    options.workerId.length > 0 && options.workerId.trim() === options.workerId;
}

function pending(
  context: Readonly<DacsLiveRoleOperationContextV1>,
  delay: number,
  reasonCode: string,
) {
  return Object.freeze({
    status: "pending-retry" as const,
    reasonCode,
    retryAt: retryAt(context, delay),
  });
}

function capturedReasonCode(error: unknown): string | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "reasonCode");
    if (descriptor === undefined || !("value" in descriptor) ||
        typeof descriptor.value !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(descriptor.value)) {
      return undefined;
    }
    return descriptor.value;
  } catch {
    return undefined;
  }
}

/**
 * Complete the seller-owned DACS-5 bundle only after the buyer has reviewed and
 * signed the exact SDK-produced request. The host supplies its actor signer and
 * outer commerce fence; all artifact construction and terminal verification
 * remain in the SDK durable finalizer.
 */
export function createDacsSellerAuditTrackV1(
  options: Readonly<DacsSellerAuditRuntimeOptionsV1>,
): FixedPriceX402TrackOperation {
  if (!validCommonOptions(options, "seller") ||
      !plainObject(options.bundleTransport) ||
      typeof options.bundleTransport.publishRequest !== "function" ||
      typeof options.bundleTransport.resolveCounterSignatures !== "function" ||
      typeof options.resolveMaterial !== "function" ||
      typeof options.authorizeFinalized !== "function") {
    throw new TypeError("seller audit runtime options are invalid");
  }
  const context = options.context;
  const delay = positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);

  return async (operation) => {
    if (!operationBound(operation, "seller")) {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-audit-track-binding-mismatch",
      });
    }
    let retained: Readonly<DacsLiveOrderInputV1>;
    try {
      retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-audit-material-invalid",
      });
    }
    let material: Readonly<DacsSellerAuditMaterialV1>;
    try {
      material = await options.resolveMaterial({ operation, retained });
    } catch (error) {
      const reasonCode = capturedReasonCode(error);
      if (reasonCode === undefined) {
        return pending(context, delay, "seller-audit-material-unavailable");
      }
      if (SELLER_MATERIAL_RETRY_REASONS.has(reasonCode)) {
        return pending(context, delay, reasonCode);
      }
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-audit-material-invalid",
      });
    }
    try {
      if (!plainObject(material) || !plainObject(material.input) ||
          !plainObject(material.input.seller) || !plainObject(material.provider) ||
          !plainObject(material.durability) ||
          material.input.seller.primaryClaim !== context.authority ||
          material.input.agreement.jobId !== operation.order.jobId) throw new Error();
      await operation.fence.assertCurrent();
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-audit-material-invalid",
      });
    }

    const signDemos = async (bytes: Uint8Array): Promise<Uint8Array> => {
        await operation.fence.assertCurrent();
        const signature = await context.demos.signComponent(Uint8Array.from(bytes), {
          algorithm: "ed25519",
          signer: context.authority,
        });
        return typeof signature === "string"
          ? Uint8Array.from(Buffer.from(signature, "base64url"))
          : Uint8Array.from(signature);
    };
    const signer: FinalizeCompletedSellerBundleDurableInput["seller"]["signer"] =
      async (bytes) => await signDemos(bytes);
    const { seller: sellerData, ...inputData } = material.input;
    const unsignedInput: FinalizeCompletedSellerBundleDurableInput = {
      ...inputData,
      seller: { ...sellerData, signer },
      ...(material.provider.mapping === "write-input"
        ? {
            bindingSigner: {
              algorithm: "ed25519" as const,
              signer: context.authority,
              sign: async (bytes, signatureContext) => {
                await operation.fence.assertCurrent();
                return await context.demos.signComponent(
                  Uint8Array.from(bytes),
                  signatureContext,
                );
              },
            },
          }
        : {}),
    };
    let request: ReturnType<typeof prepareCompletedSellerBundleCounterSignatureRequest>;
    try {
      const {
        verifiedListing: _verifiedListing,
        bindingSigner: _bindingSigner,
        ...coreInput
      } = unsignedInput;
      request = prepareCompletedSellerBundleCounterSignatureRequest({
        ...coreInput,
        seller: { ...sellerData, signer: async (bytes) => await signDemos(bytes) },
      });
      const publication = await options.bundleTransport.publishRequest({
        jobId: operation.order.jobId,
        request,
      });
      if (publication.status === "rejected") {
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: "seller-audit-signature-request-rejected",
        });
      }
      if (publication.status !== "acknowledged") {
        return pending(context, delay, "seller-audit-signature-request-pending");
      }
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-audit-signature-request-invalid",
      });
    }

    let counterSignatures;
    try {
      counterSignatures = await options.bundleTransport.resolveCounterSignatures(
        operation.order.jobId,
      );
    } catch {
      return pending(context, delay, "seller-audit-counter-signature-read-pending");
    }
    if (counterSignatures.length !== request.requiredCounterSigners.length) {
      return pending(context, delay, "seller-audit-counter-signature-pending");
    }

    const provider: DurableSellerBundleFinalizationProvider = {
      ...material.provider,
      submitSellerBundle: async (logicalAddress, bundle, fence) => {
        await operation.fence.assertCurrent();
        return await material.provider.submitSellerBundle(
          logicalAddress,
          bundle,
          fence,
        );
      },
      ...(material.provider.publishBundleBinding === undefined
        ? {}
        : {
            publishBundleBinding: async (binding, fence) => {
              await operation.fence.assertCurrent();
              return await material.provider.publishBundleBinding!(binding, fence);
            },
          }),
    };
    const durability: SellerBundleFinalizationDurability = {
      ...material.durability,
      store: context.sessionStore,
      workerId: options.workerId,
      reconcileSignature: async (input) => {
        await operation.fence.assertCurrent();
        return await material.durability.reconcileSignature(input);
      },
      reconcileBundleAnchor: async (input) => {
        await operation.fence.assertCurrent();
        return await material.durability.reconcileBundleAnchor(input);
      },
      reconcileBindingPublication: async (binding, fence) => {
        await operation.fence.assertCurrent();
        return await material.durability.reconcileBindingPublication(binding, fence);
      },
    };

    try {
      const result = await finalizeCompletedSellerBundleDurable(
        { ...unsignedInput, counterSignatures: [...counterSignatures] },
        provider,
        durability,
      );
      await operation.fence.assertCurrent();
      if (await options.authorizeFinalized({ operation, retained, result }) !== true) {
        throw new DacsAuditRuntimeError("seller-audit-result-unauthorized");
      }
      await operation.fence.assertCurrent();
      return Object.freeze({
        status: "final" as const,
        outcome: "success" as const,
        reference: result.logicalAddress,
        authenticationHash: result.bundleContentHash,
      });
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "seller-audit-finalization-failed",
      });
    }
  };
}

/**
 * Advance buyer review/signing and buyer-bundle publication from independently
 * resolved local facts. Waiting transport states are resumable; rejected facts
 * remain fail-closed and can never be projected as audit success.
 */
export function createDacsBuyerAuditTrackV1(
  options: Readonly<DacsBuyerAuditRuntimeOptionsV1>,
): FixedPriceX402TrackOperation {
  if (!validCommonOptions(options, "buyer") ||
      !plainObject(options.bundleTransport) ||
      typeof options.bundleTransport.resolveSellerRequest !== "function" ||
      typeof options.bundleTransport.publishCounterSignature !== "function" ||
      typeof options.bundleTransport.resolveCounterSignatures !== "function" ||
      typeof options.bundleTransport.resolveSellerFinalization !== "function" ||
      typeof options.resolveMaterial !== "function" ||
      typeof options.authorizeFinalized !== "function") {
    throw new TypeError("buyer audit runtime options are invalid");
  }
  const context = options.context;
  const delay = positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS);

  return async (operation) => {
    if (!operationBound(operation, "buyer")) {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-audit-track-binding-mismatch",
      });
    }
    let retained: Readonly<DacsLiveOrderInputV1>;
    try {
      retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-audit-material-invalid",
      });
    }
    let material: Readonly<DacsBuyerAuditMaterialV1>;
    try {
      material = await options.resolveMaterial({ operation, retained });
    } catch (error) {
      const reasonCode = capturedReasonCode(error);
      if (reasonCode === undefined) {
        return pending(context, delay, "buyer-audit-material-unavailable");
      }
      if (BUYER_MATERIAL_RETRY_REASONS.has(reasonCode)) {
        return pending(context, delay, reasonCode);
      }
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-audit-material-invalid",
      });
    }
    try {
      if (!plainObject(material) || !plainObject(material.input) ||
          !plainObject(material.input.buyer) || !plainObject(material.provider) ||
          !plainObject(material.durability) ||
          material.input.buyer.primaryClaim !== context.authority ||
          material.input.sellerVerificationInput.agreement.jobId !== operation.order.jobId) {
        throw new Error();
      }
      await operation.fence.assertCurrent();
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-audit-material-invalid",
      });
    }

    const { buyer: buyerData, ...inputData } = material.input;
    const input: DurableBuyerBundleFinalizationInput = {
      ...inputData,
      buyer: {
        ...buyerData,
        signer: async (bytes) => {
          await operation.fence.assertCurrent();
          return await context.demos.signComponent(Uint8Array.from(bytes), {
            algorithm: "ed25519",
            signer: context.authority,
          });
        },
      },
    };
    const provider: DurableBuyerBundleFinalizationProvider = {
      ...material.provider,
      submitBuyerBundle: async (logicalAddress, bundle, fence) => {
        await operation.fence.assertCurrent();
        return await material.provider.submitBuyerBundle(logicalAddress, bundle, fence);
      },
      ...(material.provider.publishBundleBinding === undefined
        ? {}
        : {
            publishBundleBinding: async (binding, fence) => {
              await operation.fence.assertCurrent();
              return await material.provider.publishBundleBinding!(binding, fence);
            },
          }),
    };
    const transport: BuyerBundleTransport = {
      ...options.bundleTransport,
      publishCounterSignature: async (publication, fence) => {
        await operation.fence.assertCurrent();
        return await options.bundleTransport.publishCounterSignature(publication, fence);
      },
    };
    const durability: BuyerBundleFinalizationDurability = {
      ...material.durability,
      store: context.sessionStore,
      workerId: options.workerId,
      transport,
      reconcileSignature: async (reconciliation) => {
        await operation.fence.assertCurrent();
        return await material.durability.reconcileSignature(reconciliation);
      },
      reconcileCounterSignaturePublication: async (publication, fence) => {
        await operation.fence.assertCurrent();
        return await material.durability.reconcileCounterSignaturePublication(
          publication,
          fence,
        );
      },
      reconcileBuyerBundleAnchor: async (anchor, fence) => {
        await operation.fence.assertCurrent();
        return await material.durability.reconcileBuyerBundleAnchor(anchor, fence);
      },
      reconcileBindingPublication: async (binding, fence) => {
        await operation.fence.assertCurrent();
        return await material.durability.reconcileBindingPublication(binding, fence);
      },
    };

    let progress: Awaited<ReturnType<typeof advanceCompletedBuyerBundleDurable>>;
    try {
      progress = await advanceCompletedBuyerBundleDurable(input, provider, durability);
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-audit-finalization-failed",
      });
    }
    if (progress.disposition !== "finalised") {
      if (progress.disposition === "waiting") {
        return pending(context, delay, `buyer-audit-${progress.stage}-pending`);
      }
      if (progress.disposition === "indeterminate") {
        return Object.freeze({
          status: "indeterminate" as const,
          reasonCode: `buyer-audit-${progress.stage}-indeterminate`,
        });
      }
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: `buyer-audit-${progress.stage}-rejected`,
      });
    }
    try {
      await operation.fence.assertCurrent();
      if (await options.authorizeFinalized({
        operation,
        retained,
        result: progress.result,
      }) !== true) {
        throw new DacsAuditRuntimeError("buyer-audit-result-unauthorized");
      }
      await operation.fence.assertCurrent();
      return Object.freeze({
        status: "final" as const,
        outcome: "success" as const,
        reference: progress.result.logicalAddress,
        authenticationHash: progress.result.bundleContentHash,
      });
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-audit-result-unauthorized",
      });
    }
  };
}
