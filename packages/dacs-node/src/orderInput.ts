import { canonicalize, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  fixedPriceX402OrderBindingHash,
  fixedPriceX402OrderLocalBindingHash,
  type FixedPriceX402CoordinatorRole,
  type FixedPriceX402OrderInput,
  type FixedPriceX402TrackOperationInput,
} from "@kynesyslabs/dacs/commerce";
import { isCanonicalJobId } from "@kynesyslabs/dacs/negotiate";

import type { DacsNodeSqliteDatabase } from "./sqlite.js";

export const DACS_LIVE_ORDER_INPUT_VERSION = "1" as const;
export const DACS_LIVE_ORDER_INPUT_ID_DOMAIN = "dacs-live-order-input-id:v1:" as const;

const HASH_RE = /^[0-9a-f]{64}$/;

export interface DacsLiveOrderInputV1 {
  orderInputVersion: typeof DACS_LIVE_ORDER_INPUT_VERSION;
  role: FixedPriceX402CoordinatorRole;
  jobId: string;
  bindingHash: string;
  localBindingHash: string;
  applicationHash: string;
  application: Readonly<Record<string, unknown>>;
  order: Readonly<FixedPriceX402OrderInput>;
}

export type DacsLiveOrderInputPutV1 = Readonly<
  | { status: "created" | "existing"; effectId: string; record: DacsLiveOrderInputV1 }
  | { status: "conflict"; effectId: string }
>;

export class DacsLiveOrderInputError extends Error {
  override readonly name = "DacsLiveOrderInputError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function plainData(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function canonicalSnapshot(value: unknown, reasonCode: string): Readonly<Record<string, unknown>> {
  if (!plainData(value)) throw new DacsLiveOrderInputError(reasonCode);
  try {
    return Object.freeze(JSON.parse(canonicalize(value)) as Record<string, unknown>);
  } catch {
    throw new DacsLiveOrderInputError(reasonCode);
  }
}

function hashes(order: Readonly<FixedPriceX402OrderInput>): Readonly<{
  bindingHash: string;
  localBindingHash: string;
}> {
  try {
    const bindingHash = fixedPriceX402OrderBindingHash(order);
    const localBindingHash = fixedPriceX402OrderLocalBindingHash(order);
    if (!HASH_RE.test(bindingHash) || !HASH_RE.test(localBindingHash)) throw new Error();
    return { bindingHash, localBindingHash };
  } catch {
    throw new DacsLiveOrderInputError("live-order-binding-invalid");
  }
}

function effectId(input: Readonly<{
  role: FixedPriceX402CoordinatorRole;
  jobId: string;
  localBindingHash: string;
}>): string {
  return sha256Hex(`${DACS_LIVE_ORDER_INPUT_ID_DOMAIN}${canonicalize({
    role: input.role,
    jobId: input.jobId,
    localBindingHash: input.localBindingHash,
  })}`);
}

function captureRecord(value: unknown): Readonly<DacsLiveOrderInputV1> {
  if (!plainData(value) || Reflect.ownKeys(value).length !== 8 ||
      value.orderInputVersion !== DACS_LIVE_ORDER_INPUT_VERSION ||
      (value.role !== "buyer" && value.role !== "seller") ||
      typeof value.jobId !== "string" || !isCanonicalJobId(value.jobId) ||
      typeof value.bindingHash !== "string" || !HASH_RE.test(value.bindingHash) ||
      typeof value.localBindingHash !== "string" || !HASH_RE.test(value.localBindingHash) ||
      typeof value.applicationHash !== "string" || !HASH_RE.test(value.applicationHash) ||
      !plainData(value.application) || !plainData(value.order)) {
    throw new DacsLiveOrderInputError("live-order-input-corrupt");
  }
  const order = value.order as unknown as FixedPriceX402OrderInput;
  const expected = hashes(order);
  const applicationJson = canonicalize(value.application);
  if (order.sdkJobs.role !== value.role || order.jobId !== value.jobId ||
      expected.bindingHash !== value.bindingHash ||
      expected.localBindingHash !== value.localBindingHash ||
      sha256Hex(applicationJson) !== value.applicationHash) {
    throw new DacsLiveOrderInputError("live-order-input-corrupt");
  }
  return JSON.parse(canonicalize(value)) as DacsLiveOrderInputV1;
}

/**
 * Retain public application/session facts before a coordinator can claim its
 * first track. Bearers, private keys and reusable authorization material must
 * stay in their dedicated effect stores and are not accepted here.
 */
export function putDacsLiveOrderInputV1(input: Readonly<{
  database: DacsNodeSqliteDatabase;
  order: Readonly<FixedPriceX402OrderInput>;
  application: Readonly<Record<string, unknown>>;
}>): DacsLiveOrderInputPutV1 {
  if (!plainData(input) || Reflect.ownKeys(input).length !== 3 ||
      input.database === null || typeof input.database !== "object" ||
      !plainData(input.order)) {
    throw new TypeError("live order input options are invalid");
  }
  const order = JSON.parse(canonicalize(input.order)) as FixedPriceX402OrderInput;
  const application = canonicalSnapshot(input.application, "live-order-application-invalid");
  const derived = hashes(order);
  if (input.database.metadata.mode !== "live-demos" ||
      input.database.metadata.role !== order.sdkJobs.role ||
      input.database.metadata.authority !==
        (order.sdkJobs.role === "buyer" ? order.buyer : order.seller)) {
    throw new DacsLiveOrderInputError("live-order-database-binding-mismatch");
  }
  const retained: DacsLiveOrderInputV1 = {
    orderInputVersion: DACS_LIVE_ORDER_INPUT_VERSION,
    role: order.sdkJobs.role,
    jobId: order.jobId,
    bindingHash: derived.bindingHash,
    localBindingHash: derived.localBindingHash,
    applicationHash: sha256Hex(canonicalize(application)),
    application,
    order,
  };
  const id = effectId(retained);
  const result = input.database.putEffectIntent({
    kind: "session",
    effectId: id,
    bindingHash: retained.localBindingHash,
    input: retained,
    idempotencyKey: id,
    jobId: retained.jobId,
  });
  return result.status === "conflict"
    ? Object.freeze({ status: "conflict", effectId: id })
    : Object.freeze({
        status: result.status,
        effectId: id,
        record: captureRecord(input.database.loadEffectInput("session", id)),
      });
}

export function loadDacsLiveOrderInputV1(input: Readonly<{
  database: DacsNodeSqliteDatabase;
  order: Readonly<FixedPriceX402OrderInput>;
}>): Readonly<DacsLiveOrderInputV1> | undefined {
  if (!plainData(input) || Reflect.ownKeys(input).length !== 2 ||
      input.database === null || typeof input.database !== "object" ||
      !plainData(input.order)) {
    throw new TypeError("live order input lookup is invalid");
  }
  const derived = hashes(input.order);
  const id = effectId({
    role: input.order.sdkJobs.role,
    jobId: input.order.jobId,
    localBindingHash: derived.localBindingHash,
  });
  const value = input.database.loadEffectInput("session", id);
  if (value === undefined) return undefined;
  const record = captureRecord(value);
  if (record.bindingHash !== derived.bindingHash ||
      record.localBindingHash !== derived.localBindingHash) {
    throw new DacsLiveOrderInputError("live-order-input-corrupt");
  }
  return Object.freeze(structuredClone(record));
}

/** Resolve the retained application facts from an already fenced track claim. */
export function loadDacsLiveOrderInputForTrackV1(
  operation: Readonly<FixedPriceX402TrackOperationInput>,
  database: DacsNodeSqliteDatabase,
): Readonly<DacsLiveOrderInputV1> {
  if (!plainData(operation) || !plainData(operation.order) ||
      operation.fence === null || typeof operation.fence !== "object" ||
      database === null || typeof database !== "object") {
    throw new TypeError("live order track input is invalid");
  }
  const order = operation.order;
  const fence = operation.fence;
  if (order.role !== fence.role || order.jobId !== fence.jobId ||
      order.bindingHash !== fence.bindingHash ||
      order.localBindingHash !== fence.localBindingHash ||
      database.metadata.role !== fence.role) {
    throw new DacsLiveOrderInputError("live-order-track-binding-mismatch");
  }
  const id = effectId({
    role: fence.role,
    jobId: fence.jobId,
    localBindingHash: fence.localBindingHash,
  });
  const value = database.loadEffectInput("session", id);
  if (value === undefined) {
    throw new DacsLiveOrderInputError("live-order-input-missing");
  }
  const retained = captureRecord(value);
  const projected = {
    jobId: order.jobId,
    buyer: order.buyer,
    seller: order.seller,
    protocol: order.protocol,
    sdkJobs: order.sdkJobs,
  };
  if (retained.bindingHash !== fence.bindingHash ||
      retained.localBindingHash !== fence.localBindingHash ||
      canonicalize(retained.order) !== canonicalize(projected)) {
    throw new DacsLiveOrderInputError("live-order-track-binding-mismatch");
  }
  return Object.freeze(structuredClone(retained));
}
