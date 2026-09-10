import {
  x402BuyerSettlementKey,
  type FixedPriceX402TrackOperation,
  type FixedPriceX402TrackOperationInput,
  type X402BuyerCapturedSettlement,
  type X402BuyerSettlementIntent,
} from "@kynesyslabs/dacs";
import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";

import {
  loadDacsLiveOrderInputForTrackV1,
  type DacsLiveOrderInputV1,
} from "./orderInput.js";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";
import { createDacsPublicHttpsFetchV1 } from "./publicFetch.js";

const BUYER_RECEIVED_BINDING_VERSION = "1" as const;
const BUYER_RECEIVED_BINDING_DOMAIN = "dacs-live-buyer-received:v1:" as const;
const DEFAULT_RETRY_DELAY_MS = 1_000;
export const DACS_BUYER_RECEIVED_DEFAULT_MAX_BODY_BYTES_V1 = 8 * 1_024 * 1_024;
const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsBuyerReceivedPaymentScopeV1 {
  paymentPhaseIndex: number;
}

export interface DacsBuyerReceivedRecordV1 {
  buyerReceivedVersion: typeof BUYER_RECEIVED_BINDING_VERSION;
  localBindingHash: string;
  settlementKey: string;
  settlementAuthenticationHash: string;
  httpResource: string;
  status: number;
  contentType: string;
  bodyBase64Url: string;
  bodyHash: string;
  receivedAt: number;
}

export interface DacsBuyerReceivedRuntimeOptionsV1 {
  context: Readonly<DacsLiveRoleOperationContextV1>;
  resolvePaymentScope(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
  }>): Promise<Readonly<DacsBuyerReceivedPaymentScopeV1>> |
    Readonly<DacsBuyerReceivedPaymentScopeV1>;
  authorizeReceived(input: Readonly<{
    operation: Readonly<FixedPriceX402TrackOperationInput>;
    retained: Readonly<DacsLiveOrderInputV1>;
    intent: Readonly<X402BuyerSettlementIntent>;
    settlement: Readonly<X402BuyerCapturedSettlement>;
    response: Readonly<DacsBuyerReceivedRecordV1>;
    body: Uint8Array;
  }>): Promise<boolean | "indeterminate"> | boolean | "indeterminate";
  /** Defaults to the locked-down public HTTPS transport when omitted. */
  fetchImpl?: typeof fetch;
  maxBodyBytes?: number;
  retryDelayMs?: number;
}

export class DacsBuyerReceivedRuntimeError extends Error {
  override readonly name = "DacsBuyerReceivedRuntimeError";

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

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  const captured = value ?? fallback;
  if (!Number.isSafeInteger(captured) || Number(captured) <= 0 ||
      Number(captured) > maximum) {
    throw new TypeError("buyer received runtime limit is invalid");
  }
  return Number(captured);
}

function bindingId(jobId: string, paymentPhaseIndex: number): string {
  return sha256Hex(`${BUYER_RECEIVED_BINDING_DOMAIN}${canonicalize({
    jobId,
    paymentPhaseIndex,
  })}`);
}

function operationBound(operation: Readonly<FixedPriceX402TrackOperationInput>): boolean {
  return operation.order.role === "buyer" && operation.fence.role === "buyer" &&
    operation.fence.track === "buyer-received" &&
    operation.order.jobId === operation.fence.jobId &&
    operation.order.bindingHash === operation.fence.bindingHash &&
    operation.order.localBindingHash === operation.fence.localBindingHash;
}

function captureScope(value: unknown): Readonly<DacsBuyerReceivedPaymentScopeV1> {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 1 ||
      !Number.isSafeInteger(value.paymentPhaseIndex) ||
      Number(value.paymentPhaseIndex) < 0) {
    throw new DacsBuyerReceivedRuntimeError("buyer-received-payment-scope-invalid");
  }
  return Object.freeze({ paymentPhaseIndex: Number(value.paymentPhaseIndex) });
}

function captureRecord(value: unknown): Readonly<DacsBuyerReceivedRecordV1> {
  if (!plainObject(value) || Reflect.ownKeys(value).length !== 10 ||
      value.buyerReceivedVersion !== BUYER_RECEIVED_BINDING_VERSION ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.settlementKey !== "string" || value.settlementKey.length === 0 ||
      typeof value.settlementAuthenticationHash !== "string" ||
        !HASH_RE.test(value.settlementAuthenticationHash) ||
      typeof value.httpResource !== "string" || value.httpResource.length === 0 ||
      !Number.isSafeInteger(value.status) || Number(value.status) < 200 ||
      Number(value.status) > 299 || typeof value.contentType !== "string" ||
      typeof value.bodyBase64Url !== "string" ||
      !/^[A-Za-z0-9_-]*$/.test(value.bodyBase64Url) ||
      typeof value.bodyHash !== "string" || !HASH_RE.test(value.bodyHash) ||
      !Number.isSafeInteger(value.receivedAt) || Number(value.receivedAt) < 0) {
    throw new DacsBuyerReceivedRuntimeError("buyer-received-record-corrupt");
  }
  const bytes = Buffer.from(value.bodyBase64Url, "base64url");
  if (bytes.toString("base64url") !== value.bodyBase64Url ||
      sha256Hex(bytes) !== value.bodyHash) {
    throw new DacsBuyerReceivedRuntimeError("buyer-received-record-corrupt");
  }
  return value as unknown as Readonly<DacsBuyerReceivedRecordV1>;
}

async function boundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) ||
      BigInt(declared) > BigInt(maximum))) {
    throw new DacsBuyerReceivedRuntimeError("buyer-received-body-too-large");
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new DacsBuyerReceivedRuntimeError("buyer-received-body-too-large");
      }
      chunks.push(Uint8Array.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Re-read the exact paid resource with its retained authorization after x402
 * finality. The seller WAL makes this a replay of one payment and one delivery,
 * while this buyer-local record proves the response bytes actually arrived.
 */
export function createDacsBuyerReceivedTrackV1(
  options: Readonly<DacsBuyerReceivedRuntimeOptionsV1>,
): FixedPriceX402TrackOperation {
  if (!plainObject(options) || !plainObject(options.context) ||
      options.context.role !== "buyer" || options.context.commerceStores.role !== "buyer" ||
      typeof options.resolvePaymentScope !== "function" ||
      typeof options.authorizeReceived !== "function" ||
      (options.fetchImpl !== undefined && typeof options.fetchImpl !== "function")) {
    throw new TypeError("buyer received runtime options are invalid");
  }
  const context = options.context;
  const stores = context.commerceStores;
  if (stores.role !== "buyer") throw new TypeError("buyer received runtime options are invalid");
  const maximum = positiveInteger(
    options.maxBodyBytes,
    DACS_BUYER_RECEIVED_DEFAULT_MAX_BODY_BYTES_V1,
    64 * 1_024 * 1_024,
  );
  const fetchImpl = options.fetchImpl ?? createDacsPublicHttpsFetchV1({ maxBytes: maximum });
  const delay = positiveInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 600_000);

  return async (operation) => {
    if (!operationBound(operation)) {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-received-track-binding-mismatch",
      });
    }
    let retained: Readonly<DacsLiveOrderInputV1>;
    let scope: Readonly<DacsBuyerReceivedPaymentScopeV1>;
    try {
      retained = loadDacsLiveOrderInputForTrackV1(operation, context.database);
      scope = captureScope(await options.resolvePaymentScope({ operation, retained }));
      await operation.fence.assertCurrent();
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-received-input-invalid",
      });
    }
    const settlementKey = x402BuyerSettlementKey({
      railId: operation.order.protocol.rail.railId,
      jobId: operation.order.jobId,
      phaseIndex: scope.paymentPhaseIndex,
    });
    let stored: Awaited<ReturnType<typeof stores.x402Settlement.load>>;
    try {
      stored = await stores.x402Settlement.load(settlementKey);
    } catch {
      return Object.freeze({
        status: "pending-retry" as const,
        reasonCode: "buyer-received-settlement-read-pending",
        retryAt: context.database.readTime() + delay,
      });
    }
    if (stored.status !== "captured" || stored.outcome.status !== "captured") {
      return Object.freeze({
        status: stored.status === "failed" || stored.status === "corrupt" ||
            stored.status === "unsupported"
          ? "operator-action" as const
          : "pending-retry" as const,
        reasonCode: stored.status === "failed"
          ? "buyer-received-payment-failed"
          : stored.status === "corrupt" || stored.status === "unsupported"
            ? "buyer-received-settlement-invalid"
            : "buyer-received-payment-pending",
        ...(stored.status === "failed" || stored.status === "corrupt" ||
          stored.status === "unsupported"
          ? {} : { retryAt: context.database.readTime() + delay }),
      });
    }
    const intent = stored.intent;
    const settlement = stored.outcome.settlement;
    if (intent.settlementKey !== settlementKey || intent.jobId !== operation.order.jobId ||
        intent.phaseIndex !== scope.paymentPhaseIndex ||
        settlement.httpResource !== intent.httpResource) {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-received-settlement-binding-invalid",
      });
    }
    const id = bindingId(operation.order.jobId, scope.paymentPhaseIndex);
    let record: Readonly<DacsBuyerReceivedRecordV1>;
    const existing = context.database.loadEffectInput("session", id);
    if (existing !== undefined) {
      try {
        record = captureRecord(existing);
      } catch {
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: "buyer-received-record-invalid",
        });
      }
    } else {
      let response: Response;
      let body: Uint8Array;
      try {
        await operation.fence.assertCurrent();
        response = await fetchImpl(intent.httpResource, {
          method: "GET",
          headers: { [intent.paymentHeader.name]: intent.paymentHeader.value },
          redirect: "error",
        });
        if (response.status === 408 || response.status === 425 ||
            response.status === 429 || response.status >= 500) {
          await response.body?.cancel().catch(() => undefined);
          return Object.freeze({
            status: "pending-retry" as const,
            reasonCode: "buyer-received-response-pending",
            retryAt: context.database.readTime() + delay,
          });
        }
        if (response.status < 200 || response.status > 299 ||
            response.headers.get("PAYMENT-RESPONSE") !== settlement.encodedSettlementHeader) {
          return Object.freeze({
            status: "operator-action" as const,
            reasonCode: "buyer-received-paid-response-invalid",
          });
        }
        body = await boundedBody(response, maximum);
      } catch (error) {
        return Object.freeze({
          status: error instanceof DacsBuyerReceivedRuntimeError &&
              error.reasonCode === "buyer-received-body-too-large"
            ? "operator-action" as const
            : "pending-retry" as const,
          reasonCode: error instanceof DacsBuyerReceivedRuntimeError
            ? error.reasonCode : "buyer-received-response-pending",
          ...(error instanceof DacsBuyerReceivedRuntimeError &&
            error.reasonCode === "buyer-received-body-too-large"
            ? {} : { retryAt: context.database.readTime() + delay }),
        });
      }
      const candidate: DacsBuyerReceivedRecordV1 = {
        buyerReceivedVersion: BUYER_RECEIVED_BINDING_VERSION,
        localBindingHash: operation.order.localBindingHash,
        settlementKey,
        settlementAuthenticationHash: settlement.authenticationHash,
        httpResource: intent.httpResource,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
        bodyBase64Url: Buffer.from(body).toString("base64url"),
        bodyHash: sha256Hex(body),
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
        return Object.freeze({
          status: "operator-action" as const,
          reasonCode: "buyer-received-record-conflict",
        });
      }
      record = captureRecord(context.database.loadEffectInput("session", id));
    }
    if (record.localBindingHash !== operation.order.localBindingHash ||
        record.settlementKey !== settlementKey ||
        record.settlementAuthenticationHash !== settlement.authenticationHash ||
        record.httpResource !== intent.httpResource) {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-received-record-binding-invalid",
      });
    }
    try {
      const body = Uint8Array.from(Buffer.from(record.bodyBase64Url, "base64url"));
      await operation.fence.assertCurrent();
      const authorization = await options.authorizeReceived({
        operation,
        retained,
        intent,
        settlement,
        response: record,
        body,
      });
      if (authorization === "indeterminate") {
        return Object.freeze({
          status: "pending-retry" as const,
          reasonCode: "buyer-received-authorization-pending",
          retryAt: context.database.readTime() + delay,
        });
      }
      if (authorization !== true) {
        throw new DacsBuyerReceivedRuntimeError("buyer-received-result-unauthorized");
      }
      await operation.fence.assertCurrent();
      return Object.freeze({
        status: "final" as const,
        outcome: "success" as const,
        reference: record.httpResource,
        authenticationHash: record.bodyHash,
      });
    } catch {
      return Object.freeze({
        status: "operator-action" as const,
        reasonCode: "buyer-received-result-unauthorized",
      });
    }
  };
}
