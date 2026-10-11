import type {
  FixedPricePayDemOrderInput,
  FixedPricePayDemTrackOperation,
  FixedPricePayDemTrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { canonicalDemosAgentPublicKey } from "@kynesyslabs/dacs/identity";

import { captureDacsFixedPriceX402ApplicationV1 } from "./fixedPriceX402Profile.js";
import {
  loadDacsLiveOrderInputForTrackV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

const RECEIVED_VERSION = "1" as const;
const RECEIVED_DOMAIN = "dacs-live-buyer-pay-dem-received:v1:" as const;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsPayDemBuyerReceivedRecordV1 {
  buyerReceivedVersion: typeof RECEIVED_VERSION;
  localBindingHash: string;
  jobId: string;
  logicalAddress: string;
  nativeAddress: string;
  contentHash: string;
  payload: Readonly<Record<string, unknown>>;
  anchorObservedAt: number;
  receivedAt: number;
}

export interface DacsPayDemBuyerReceivedRuntimeOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  authorizeReceived(input: Readonly<{
    operation: Readonly<FixedPricePayDemTrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1<FixedPricePayDemOrderInput>>;
    record: Readonly<DacsPayDemBuyerReceivedRecordV1>;
    payload: Readonly<Record<string, unknown>>;
  }>): Promise<boolean | "indeterminate"> | boolean | "indeterminate";
  retryDelayMs?: number;
}

export class DacsPayDemBuyerReceivedRuntimeError extends Error {
  override readonly name = "DacsPayDemBuyerReceivedRuntimeError";

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
    throw new TypeError("pay-dem buyer received timing is invalid");
  }
  return Number(captured);
}

function bindingId(jobId: string): string {
  return sha256Hex(`${RECEIVED_DOMAIN}${jobId}`);
}

function operationBound(operation: Readonly<FixedPricePayDemTrackOperationInput>): boolean {
  return operation.order.role === "buyer" && operation.fence.role === "buyer" &&
    operation.fence.track === "buyer-received" &&
    operation.order.protocol.phase === "pay-dem" &&
    operation.order.jobId === operation.fence.jobId &&
    operation.order.bindingHash === operation.fence.bindingHash &&
    operation.order.localBindingHash === operation.fence.localBindingHash;
}

function captureRecord(value: unknown): Readonly<DacsPayDemBuyerReceivedRecordV1> {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 9 ||
      value.buyerReceivedVersion !== RECEIVED_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.jobId !== "string" || value.jobId.length === 0 ||
      typeof value.logicalAddress !== "string" || value.logicalAddress.length === 0 ||
      typeof value.nativeAddress !== "string" || value.nativeAddress.length === 0 ||
      typeof value.contentHash !== "string" || !HASH_RE.test(value.contentHash) ||
      !plainObject(value.payload) || contentHash(value.payload) !== value.contentHash ||
      !Number.isSafeInteger(value.anchorObservedAt) || Number(value.anchorObservedAt) < 0 ||
      !Number.isSafeInteger(value.receivedAt) || Number(value.receivedAt) < 0) {
    throw new DacsPayDemBuyerReceivedRuntimeError("pay-dem-buyer-received-record-corrupt");
  }
  return Object.freeze(JSON.parse(canonicalize(value)) as DacsPayDemBuyerReceivedRecordV1);
}

/**
 * Read the exact public Storage Program deliverable after native payment. The
 * authenticated Demos receipt and canonical payload are retained before the
 * host can report that the buyer received the result.
 */
export function createDacsPayDemBuyerReceivedTrackV1(
  options: Readonly<DacsPayDemBuyerReceivedRuntimeOptionsV1>,
): FixedPricePayDemTrackOperation {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "buyer" || typeof options.authorizeReceived !== "function") {
    throw new TypeError("pay-dem buyer received options are invalid");
  }
  const context = options.context;
  const delay = retryDelay(options.retryDelayMs);

  return async (operation) => {
    if (!operationBound(operation)) {
      return Object.freeze({ status: "operator-action" as const,
        reasonCode: "pay-dem-buyer-received-track-binding-mismatch" });
    }
    let retained: Readonly<DacsLiveOrderInputV1<FixedPricePayDemOrderInput>>;
    try {
      retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
      const application = captureDacsFixedPriceX402ApplicationV1(retained.application);
      const delivery = application.listing.offering.deliverable;
      if (application.listing.pipeline.length !== 4 ||
          application.listing.pipeline[2]?.kind !== "pay-dem" ||
          application.listing.pipeline[3]?.kind !== "deliver-storage-program" ||
          delivery.kind !== "storage-program" ||
          (delivery.accessModel !== undefined && delivery.accessModel !== "public") ||
          delivery.schemaUrl !== undefined) {
        throw new DacsPayDemBuyerReceivedRuntimeError(
          "pay-dem-buyer-received-deliverable-unsupported",
        );
      }
    } catch (error) {
      return Object.freeze({ status: "operator-action" as const,
        reasonCode: error instanceof DacsPayDemBuyerReceivedRuntimeError
          ? error.reasonCode : "pay-dem-buyer-received-input-invalid" });
    }
    const logicalAddress = `dacs4:deliverable:${operation.order.jobId}`;
    const id = bindingId(operation.order.jobId);
    let record: Readonly<DacsPayDemBuyerReceivedRecordV1>;
    const existing = context.database.loadEffectInput("session", id);
    if (existing !== undefined) {
      try {
        record = captureRecord(existing);
      } catch {
        return Object.freeze({ status: "operator-action" as const,
          reasonCode: "pay-dem-buyer-received-record-invalid" });
      }
    } else {
      const sellerKey = canonicalDemosAgentPublicKey(operation.order.seller);
      if (sellerKey === null) {
        return Object.freeze({ status: "operator-action" as const,
          reasonCode: "pay-dem-buyer-received-seller-invalid" });
      }
      try {
        const resolved = await context.demos.adapter.resolveAnchorByName(
          logicalAddress,
          Buffer.from(sellerKey).toString("hex"),
        );
        if (resolved.status === "absent") {
          return Object.freeze({ status: "pending-retry" as const,
            reasonCode: "pay-dem-buyer-received-delivery-pending",
            retryAt: context.database.readTime() + delay });
        }
        if (resolved.status !== "present") throw new Error(resolved.reason);
        const payload = await context.demos.adapter.readAnchor(resolved.address);
        if (!plainObject(payload)) {
          return Object.freeze({ status: "pending-retry" as const,
            reasonCode: "pay-dem-buyer-received-readback-pending",
            retryAt: context.database.readTime() + delay });
        }
        const hash = contentHash(payload);
        const receipt = await context.demos.adapter.resolveDemosAnchorReceipt({
          logicalAddress,
          nativeAddress: resolved.address,
          contentHash: hash,
          writer: operation.order.seller,
        });
        if (receipt === null || receipt.writer !== operation.order.seller ||
            receipt.logicalAddress !== logicalAddress ||
            receipt.nativeAddress !== resolved.address || receipt.contentHash !== hash ||
            receipt.observationDisposition !== "established" ||
            (receipt.state !== "included" && receipt.state !== "finalized") ||
            await context.demos.adapter.verifyDemosAnchorReceipt(receipt) !== true) {
          throw new Error("delivery receipt unavailable");
        }
        await operation.fence.assertCurrent();
        const candidate: DacsPayDemBuyerReceivedRecordV1 = {
          buyerReceivedVersion: RECEIVED_VERSION,
          localBindingHash: operation.order.localBindingHash,
          jobId: operation.order.jobId,
          logicalAddress,
          nativeAddress: resolved.address,
          contentHash: hash,
          payload: JSON.parse(canonicalize(payload)) as Record<string, unknown>,
          anchorObservedAt: receipt.blockRef?.timestamp ?? receipt.observedAt,
          receivedAt: context.database.readTime(),
        };
        const put = context.database.putEffectIntent({
          kind: "session",
          effectId: id,
          bindingHash: operation.order.localBindingHash,
          input: candidate,
          idempotencyKey: id,
          jobId: operation.order.jobId,
        });
        if (put.status === "conflict") {
          return Object.freeze({ status: "operator-action" as const,
            reasonCode: "pay-dem-buyer-received-record-conflict" });
        }
        record = captureRecord(context.database.loadEffectInput("session", id));
      } catch {
        return Object.freeze({ status: "pending-retry" as const,
          reasonCode: "pay-dem-buyer-received-anchor-pending",
          retryAt: context.database.readTime() + delay });
      }
    }
    if (record.jobId !== operation.order.jobId ||
        record.localBindingHash !== operation.order.localBindingHash ||
        record.logicalAddress !== logicalAddress) {
      return Object.freeze({ status: "operator-action" as const,
        reasonCode: "pay-dem-buyer-received-record-binding-invalid" });
    }
    try {
      await operation.fence.assertCurrent();
      const authorized = await options.authorizeReceived({
        operation,
        retained,
        record,
        payload: record.payload,
      });
      if (authorized === "indeterminate") {
        return Object.freeze({ status: "pending-retry" as const,
          reasonCode: "pay-dem-buyer-received-authorization-pending",
          retryAt: context.database.readTime() + delay });
      }
      if (authorized !== true) {
        return Object.freeze({ status: "operator-action" as const,
          reasonCode: "pay-dem-buyer-received-unauthorized" });
      }
      await operation.fence.assertCurrent();
    } catch {
      return Object.freeze({ status: "pending-retry" as const,
        reasonCode: "pay-dem-buyer-received-authorization-pending",
        retryAt: context.database.readTime() + delay });
    }
    return Object.freeze({ status: "final" as const, outcome: "success" as const,
      reference: record.logicalAddress, authenticationHash: record.contentHash });
  };
}
