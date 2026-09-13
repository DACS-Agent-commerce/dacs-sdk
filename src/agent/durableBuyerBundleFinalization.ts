import { types as nodeTypes } from "node:util";

import type {
  BundleBinding,
  BundleSignature,
  FaultAttestationBundle,
} from "../artifacts/types.js";
import {
  BUNDLE_BINDING_SEPARATOR,
  isAnchorReceipt,
  isBundleBinding,
  isCanonicalBase64Url,
  isFaultAttestationBundle,
} from "../artifacts/index.js";
import { canonicalize, contentHash, sha256Hex } from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  FENCED_SESSION_STORE_VERSION,
  sessionRecordShapeViolation,
  sessionReceiptKey,
  type CheckpointValue,
  type FencedSessionStoreV2,
  type SessionCheckpoint,
  type SessionLeaseToken,
  type SessionRecord,
} from "./fencedSessionStore.js";
import {
  verifyFinalizedSessionSettlement,
  type FinalizedSessionSettlement,
  type SessionSettlementContext,
  type SessionSettlementVerificationProvider,
  type VerifiedSessionSettlement,
} from "./sessionSettlement.js";
import {
  createCompletedBuyerBundleCounterSignature,
  finalizeCompletedBuyerBundleCore,
  type BuyerBundleFinalizationProvider,
  type FinalizedBuyerBundle,
} from "./buyerBundleFinalization.js";
import { attestationBundleHash } from "./twoSidedBundle.js";
import {
  verifyCompletedSellerBundleCounterSignatureRequest,
  verifyFinalizedSellerBundleReadOnly,
  type CompletedSellerBundleCounterSignatureRequest,
  type FinalizedSellerBundle,
  type SellerBundleBindingPublication,
  type SellerBundleFinalizationReadProvider,
  type VerifyCompletedSellerBundleCounterSignatureRequestInput,
  type VerifyFinalizedSellerBundleInput,
} from "../seller/bundleFinalization.js";

const MAX_CAS_ATTEMPTS = 16;
const MAX_RELEASE_ATTEMPTS = 8;

export interface BuyerBundleEffectFence extends SessionLeaseToken {
  /** Stable across lease generations for one logical side effect. */
  idempotencyKey: string;
}

export type BuyerBundleSignaturePurpose =
  | "counter-signature"
  | "bundle-binding";

export type BuyerBundleFencedSigner = (
  bytes: Uint8Array,
  fence: Readonly<BuyerBundleEffectFence>,
) => Promise<Uint8Array | string> | Uint8Array | string;

export interface DurableBuyerBundleFinalizationInput {
  /** Data-only buyer-local facts used to authenticate the seller request. */
  sellerVerificationInput: VerifyCompletedSellerBundleCounterSignatureRequestInput;
  /** Exact finalized settlement; successful native revalidation gates all work. */
  settlementContext: SessionSettlementContext;
  settlement: FinalizedSessionSettlement;
  buyer: {
    primaryClaim: string;
    bundleHash: string;
    signer: BuyerBundleFencedSigner;
  };
}

export type DurableBuyerBundleFinalizationProvider = Omit<
  BuyerBundleFinalizationProvider,
  "submitBuyerBundle" | "publishBundleBinding"
> & {
  submitBuyerBundle: (
    logicalAddress: string,
    bundle: Readonly<FaultAttestationBundle>,
    fence: Readonly<BuyerBundleEffectFence>,
  ) => Promise<void> | void;
  publishBundleBinding?: (
    binding: Readonly<BundleBinding>,
    fence: Readonly<BuyerBundleEffectFence>,
  ) => Promise<SellerBundleBindingPublication> | SellerBundleBindingPublication;
};

export interface BuyerBundleTransportIdentity {
  jobId: string;
  agreementHash: string;
  settlementId: string;
  settlementIdentityHash: string;
  buyer: string;
  buyerBundleHash: string;
  seller: string;
}

export type BuyerBundleTransportResolution<T> =
  | { disposition: "present"; value: T }
  | { disposition: "absent"; reason: string }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type BuyerCounterSignaturePublication =
  | { disposition: "published" }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export interface AuthenticatedBundleRolePublication {
  role: "buyer" | "seller";
  logicalAddress: string;
  nativeAddress: string;
  bundleContentHash: string;
  anchorReceipt: FinalizedBuyerBundle["anchorReceipt"];
  anchorTx?: string;
  binding?: Readonly<BundleBinding>;
}

export interface DurableFinalizedBuyerBundle extends FinalizedBuyerBundle {
  /** Authenticated native refs usable by Agent.verifyBundle, plus canonical logical ids. */
  publications: {
    buyer: Readonly<AuthenticatedBundleRolePublication>;
    seller: Readonly<AuthenticatedBundleRolePublication>;
  };
}

/**
 * Data-only authenticated seller closure retained by the buyer finalizer.
 * It contains no signing authority and is safe to pass to an independent
 * two-copy completion verifier after both role publications exist.
 */
export interface DurableBuyerSessionCompletion {
  sellerClosure: {
    verificationInput: Readonly<VerifyFinalizedSellerBundleInput>;
    result: Readonly<FinalizedSellerBundle>;
  };
}

export interface BuyerBundleTransport {
  resolveSellerRequest: (
    identity: Readonly<BuyerBundleTransportIdentity>,
  ) =>
    | Promise<BuyerBundleTransportResolution<unknown>>
    | BuyerBundleTransportResolution<unknown>;
  publishCounterSignature: (
    input: {
      identity: Readonly<BuyerBundleTransportIdentity>;
      requestHash: string;
      signature: Readonly<BundleSignature>;
    },
    fence: Readonly<BuyerBundleEffectFence>,
  ) => Promise<BuyerCounterSignaturePublication> | BuyerCounterSignaturePublication;
  /** Resolve the complete detached signer set required by the authenticated request. */
  resolveCounterSignatures: (
    input: {
      identity: Readonly<BuyerBundleTransportIdentity>;
      requestHash: string;
      requiredCounterSignersHash: string;
      buyerSignature: Readonly<BundleSignature>;
    },
  ) =>
    | Promise<BuyerBundleTransportResolution<unknown>>
    | BuyerBundleTransportResolution<unknown>;
  resolveSellerFinalization: (
    input: {
      identity: Readonly<BuyerBundleTransportIdentity>;
      requestHash: string;
      counterSignatureHash: string;
      counterSignatureSetHash: string;
    },
  ) =>
    | Promise<BuyerBundleTransportResolution<unknown>>
    | BuyerBundleTransportResolution<unknown>;
}

export type BuyerBundleSignatureReconciliation =
  | { disposition: "signed"; value: Uint8Array | string }
  | { disposition: "authoritatively-absent"; reason: string }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type BuyerCounterSignaturePublicationReconciliation =
  | { disposition: "present"; signature: BundleSignature }
  | { disposition: "authoritatively-absent"; reason: string }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type BuyerBundleAnchorReconciliation =
  | { disposition: "present" }
  | { disposition: "authoritatively-absent"; reason: string }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type BuyerBundleBindingPublicationReconciliation =
  | { disposition: "published" }
  | { disposition: "authoritatively-absent"; reason: string }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export interface BuyerBundleFinalizationDurability {
  store: FencedSessionStoreV2;
  workerId: string;
  leaseTtlMs: number;
  leaseNowMs?: () => number;
  settlementVerification: SessionSettlementVerificationProvider;
  transport: BuyerBundleTransport;
  reconcileSignature: (input: {
    purpose: BuyerBundleSignaturePurpose;
    signer: string;
    messageHash: string;
    signedBytes: Uint8Array;
    fence: Readonly<BuyerBundleEffectFence>;
  }) =>
    | Promise<BuyerBundleSignatureReconciliation>
    | BuyerBundleSignatureReconciliation;
  reconcileCounterSignaturePublication: (
    input: {
      identity: Readonly<BuyerBundleTransportIdentity>;
      requestHash: string;
      signature: Readonly<BundleSignature>;
    },
    fence: Readonly<BuyerBundleEffectFence>,
  ) =>
    | Promise<BuyerCounterSignaturePublicationReconciliation>
    | BuyerCounterSignaturePublicationReconciliation;
  reconcileBuyerBundleAnchor: (
    input: {
      logicalAddress: string;
      bundleContentHash: string;
    },
    fence: Readonly<BuyerBundleEffectFence>,
  ) => Promise<BuyerBundleAnchorReconciliation> | BuyerBundleAnchorReconciliation;
  reconcileBindingPublication: (
    binding: Readonly<BundleBinding>,
    fence: Readonly<BuyerBundleEffectFence>,
  ) =>
    | Promise<BuyerBundleBindingPublicationReconciliation>
    | BuyerBundleBindingPublicationReconciliation;
}

export type BuyerBundleFinalizationStage =
  | "lease"
  | "settlement"
  | "seller-request"
  | "counter-signature"
  | "counter-signature-publication"
  | "counter-signature-set"
  | "seller-finalisation"
  | "buyer-bundle-anchor"
  | "buyer-bundle-binding"
  | "terminal-recovery";

export type DurableBuyerBundleFinalizationProgress =
  | {
      disposition: "finalised";
      result: DurableFinalizedBuyerBundle;
      completion: DurableBuyerSessionCompletion;
      recovered: boolean;
    }
  | {
      disposition: "waiting" | "rejected" | "indeterminate";
      stage: BuyerBundleFinalizationStage;
      reason: string;
    };

export const buyerBundleFinalizationCheckpointKey = {
  settlement: "buyer:settlement-verification",
  request: "buyer:bundle-review",
  counterSignature: "buyer:counter-signature",
  counterSignaturePublication: "buyer:counter-signature-publication",
  counterSignatureSet: "buyer:counter-signature-set",
  sellerFinalization: "buyer:seller-finalization",
  anchor: "buyer:bundle-anchor",
  bindingSignature: "buyer:bundle-binding-signature",
  bindingPublication: "buyer:bundle-binding-publication",
  result: "buyer:bundle-finalization-result",
} as const;

export type BuyerBundleCheckpointState = "not-started" | "intent" | "outcome";

export type BuyerBundleFinalizationStatusLoad =
  | { status: "missing" }
  | { status: "corrupt"; reason: string }
  | { status: "unsupported"; version: number }
  | {
      status: "ok";
      jobId: string;
      phase: string;
      revision: number;
      lease?: { owner: string; generation: number; expiresAt: number };
      checkpoints: Record<
        keyof typeof buyerBundleFinalizationCheckpointKey,
        BuyerBundleCheckpointState
      >;
      bundleReceipt?: string;
      updatedAt: number;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;

const clone = <T>(value: T): T => structuredClone(value);

function snapshotDataValue(
  value: unknown,
  subject: string,
  ancestors: Set<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${subject} contains a non-canonical number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${subject} must contain data values only`);
  }
  if (nodeTypes.isProxy(value)) {
    throw new TypeError(`${subject} cannot contain proxies`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${subject} must be acyclic`);
  }
  ancestors.add(value);
  try {
    if (value instanceof Uint8Array) {
      if (
        Object.getPrototypeOf(value) !== Uint8Array.prototype ||
        Object.getPrototypeOf(value.buffer) !== ArrayBuffer.prototype ||
        value.byteOffset !== 0 ||
        value.byteLength !== value.buffer.byteLength
      ) {
        throw new TypeError(`${subject} contains a non-canonical byte array`);
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.byteLength ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new TypeError(`${subject} byte arrays cannot carry extra fields`);
      }
      return Uint8Array.from(value);
    }
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new TypeError(`${subject} cannot contain symbol fields`);
    }
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        throw new TypeError(`${subject} arrays must use the intrinsic prototype`);
      }
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        throw new TypeError(`${subject} arrays must be dense data arrays`);
      }
      return keys.map((key) => {
        const descriptor = descriptors[key]!;
        if (descriptor.enumerable !== true || !("value" in descriptor)) {
          throw new TypeError(`${subject} cannot contain accessors`);
        }
        return snapshotDataValue(descriptor.value, subject, ancestors);
      });
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${subject} must contain plain records only`);
    }
    const copy = Object.create(prototype) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        descriptor.value === undefined
      ) {
        throw new TypeError(`${subject} cannot contain accessors or hidden fields`);
      }
      Object.defineProperty(copy, key, {
        value: snapshotDataValue(descriptor.value, subject, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${subject} cannot be inspected safely`, { cause: error });
  } finally {
    ancestors.delete(value);
  }
}

function snapshotData<T>(value: T, subject: string): T {
  return snapshotDataValue(value, subject, new Set()) as T;
}

async function callbackResult<T>(
  value: Promise<T> | T,
  subject: string,
): Promise<T> {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    nodeTypes.isProxy(value)
  ) {
    throw new TypeError(`${subject} cannot return a proxy`);
  }
  return value instanceof Promise ? await value : value;
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    value instanceof Uint8Array ||
    Object.isFrozen(value)
  ) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function immutable<T>(value: T): T {
  return deepFreeze(clone(value));
}

function exact(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function exactOwnKeys(
  value: Record<string, unknown>,
  required: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function latestCheckpoint(
  checkpoints: readonly SessionCheckpoint[],
  key: string,
): SessionCheckpoint | undefined {
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    if (checkpoints[index]?.key === key) return checkpoints[index];
  }
  return undefined;
}

function dataMatches(
  actual: Record<string, CheckpointValue> | undefined,
  expected: Record<string, CheckpointValue>,
): boolean {
  if (!actual) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) => key === expectedKeys[index] && actual[key] === expected[key],
    );
}

function withoutKeys(
  data: Record<string, CheckpointValue>,
  keys: readonly string[],
): Record<string, CheckpointValue> {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !keys.includes(key)),
  );
}

function encodeCanonical(value: unknown, subject: string): {
  encoded: string;
  hash: string;
} {
  try {
    const json = canonicalize(value);
    return {
      encoded: Buffer.from(json, "utf8").toString("base64url"),
      hash: sha256Hex(json),
    };
  } catch (error) {
    throw new DacsError(`${subject} cannot be encoded canonically`, { cause: error });
  }
}

function decodeCanonical(
  encoded: unknown,
  hash: unknown,
  subject: string,
): unknown {
  if (!isCanonicalBase64Url(encoded) || !isHash(hash)) {
    throw new DacsError(`${subject} encoding is malformed`);
  }
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("non-canonical base64url");
    const json = bytes.toString("utf8");
    if (!Buffer.from(json, "utf8").equals(bytes)) {
      throw new Error("non-canonical UTF-8");
    }
    if (sha256Hex(json) !== hash) throw new Error("hash mismatch");
    const parsed = JSON.parse(json) as unknown;
    if (canonicalize(parsed) !== json) throw new Error("non-canonical JSON");
    return parsed;
  } catch (error) {
    throw new DacsError(`${subject} cannot be decoded`, { cause: error });
  }
}

function requestWire(
  request: CompletedSellerBundleCounterSignatureRequest,
): Record<string, unknown> {
  return {
    bundleContentHash: request.bundleContentHash,
    signedScope: clone(request.signedScope),
    signedBytes: Buffer.from(request.signedBytes).toString("base64url"),
    requiredCounterSigners: [...request.requiredCounterSigners],
  };
}

function encodeRequest(request: CompletedSellerBundleCounterSignatureRequest): {
  encoded: string;
  hash: string;
  messageHash: string;
} {
  const encoded = encodeCanonical(requestWire(request), "authenticated seller request");
  return {
    ...encoded,
    messageHash: sha256Hex(request.signedBytes),
  };
}

function decodeRequest(encoded: unknown, hash: unknown): CompletedSellerBundleCounterSignatureRequest {
  const parsed = decodeCanonical(encoded, hash, "authenticated seller request");
  if (
    !isRecord(parsed) ||
    !exactOwnKeys(parsed, [
      "bundleContentHash",
      "signedScope",
      "signedBytes",
      "requiredCounterSigners",
    ]) ||
    !isHash(parsed.bundleContentHash) ||
    !isRecord(parsed.signedScope) ||
    !isCanonicalBase64Url(parsed.signedBytes) ||
    !Array.isArray(parsed.requiredCounterSigners) ||
    parsed.requiredCounterSigners.some((value) => !isNonEmpty(value))
  ) {
    throw new DacsError("authenticated seller request checkpoint is malformed");
  }
  const signedBytesValue = Uint8Array.from(
    Buffer.from(parsed.signedBytes, "base64url"),
  );
  if (Buffer.from(signedBytesValue).toString("base64url") !== parsed.signedBytes) {
    throw new DacsError("authenticated seller request bytes are non-canonical");
  }
  return {
    bundleContentHash: parsed.bundleContentHash,
    signedScope: clone(parsed.signedScope),
    signedBytes: signedBytesValue,
    requiredCounterSigners: [...parsed.requiredCounterSigners] as string[],
  };
}

function normalizeSignature(value: Uint8Array | string): string {
  const encoded =
    typeof value === "string" ? value : Buffer.from(value).toString("base64url");
  if (
    !isCanonicalBase64Url(encoded) ||
    Buffer.from(encoded, "base64url").byteLength !== 64
  ) {
    throw new DacsError(
      "durable buyer signer did not return one canonical Base64URL Ed25519 signature",
    );
  }
  return encoded;
}

function signatureHash(signature: BundleSignature): string {
  return sha256Hex(canonicalize(signature));
}

function captureBundleSignature(value: unknown, subject: string): BundleSignature {
  const snapshot = snapshotData(value, subject) as unknown;
  if (
    !isRecord(snapshot) ||
    !exactOwnKeys(snapshot, ["party", "algorithm", "value"]) ||
    !isNonEmpty(snapshot.party) ||
    snapshot.algorithm !== "ed25519" ||
    !isCanonicalBase64Url(snapshot.value) ||
    Buffer.from(snapshot.value, "base64url").byteLength !== 64
  ) {
    throw new DacsError(`${subject} is not one canonical detached signature`);
  }
  return snapshot as unknown as BundleSignature;
}

function decodeCounterSignatureSet(
  encoded: unknown,
  hash: unknown,
): BundleSignature[] {
  const parsed = decodeCanonical(encoded, hash, "authenticated counter-signature set");
  if (!Array.isArray(parsed)) {
    throw new DacsError("authenticated counter-signature set is malformed");
  }
  return parsed.map((signature, index) =>
    captureBundleSignature(signature, `counter-signature set entry ${index}`),
  );
}

function exactRecordFromLoad(
  loaded: Awaited<ReturnType<FencedSessionStoreV2["load"]>>,
): SessionRecord {
  if (loaded.status !== "ok") {
    throw new SubstrateError(
      loaded.status === "unsupported"
        ? `buyer bundle state uses unsupported store version ${loaded.version}`
        : loaded.status === "corrupt"
          ? `buyer bundle state is corrupt: ${loaded.reason}`
          : "buyer bundle finalization requires existing settled session state",
    );
  }
  const record = clone(loaded.record);
  const violation = sessionRecordShapeViolation(record);
  if (violation) {
    throw new SubstrateError(`buyer bundle state is corrupt: ${violation}`);
  }
  return record;
}

const BUYER_PHASE_RANK = new Map<string, number>([
  ["buyer:bundle-review", 0],
  ["buyer:counter-signing", 1],
  ["buyer:counter-signature-publication-pending", 2],
  ["buyer:awaiting-seller-finalisation", 3],
  ["buyer:bundle-anchor-pending", 4],
  ["buyer:bundle-binding-signing", 5],
  ["buyer:bundle-binding-publication-pending", 6],
]);

class ProgressSignal extends Error {
  readonly progress: Exclude<
    DurableBuyerBundleFinalizationProgress,
    { disposition: "finalised" }
  >;

  constructor(
    disposition: "waiting" | "rejected" | "indeterminate",
    stage: BuyerBundleFinalizationStage,
    reason: string,
  ) {
    super(reason);
    this.name = "ProgressSignal";
    this.progress = { disposition, stage, reason };
  }
}

function retainedProgressSignal(error: unknown): ProgressSignal | undefined {
  let cursor: unknown = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 8 && cursor !== undefined; depth += 1) {
    if (cursor instanceof ProgressSignal) return cursor;
    if (
      cursor === null ||
      (typeof cursor !== "object" && typeof cursor !== "function") ||
      visited.has(cursor)
    ) return undefined;
    visited.add(cursor);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, "cause");
      cursor = descriptor && "value" in descriptor ? descriptor.value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

const INERT_RECEIVER = Object.freeze(Object.create(null)) as object;
type DescriptorMap = Record<PropertyKey, PropertyDescriptor>;

function descriptors(value: unknown, subject: string): DescriptorMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object of owned data properties`);
  }
  if (nodeTypes.isProxy(value)) {
    throw new TypeError(`${subject} cannot be a proxy`);
  }
  try {
    const map = Object.getOwnPropertyDescriptors(value) as DescriptorMap;
    for (const [key, descriptor] of Object.entries(map)) {
      if (!("value" in descriptor)) {
        throw new TypeError(`${subject}.${key} must be an owned data property`);
      }
    }
    return map;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${subject} cannot be inspected safely`, { cause: error });
  }
}

function dataProperty<T>(map: DescriptorMap, key: string, subject: string): T {
  const descriptor = map[key];
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`${subject}.${key} must be an owned data property`);
  }
  return descriptor.value as T;
}

function optionalProperty<T>(
  map: DescriptorMap,
  key: string,
  subject: string,
): T | undefined {
  const descriptor = map[key];
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    throw new TypeError(`${subject}.${key} must be an owned data property`);
  }
  return descriptor.value as T;
}

function inertFunction<T>(value: unknown, subject: string): T {
  if (typeof value !== "function") throw new TypeError(`${subject} must be callable`);
  return ((...args: unknown[]) => Reflect.apply(value, INERT_RECEIVER, args)) as T;
}

function callback<T>(map: DescriptorMap, key: string, subject: string): T {
  return inertFunction<T>(dataProperty(map, key, subject), `${subject}.${key}`);
}

function optionalCallback<T>(
  map: DescriptorMap,
  key: string,
  subject: string,
): T | undefined {
  const value = optionalProperty<unknown>(map, key, subject);
  return value === undefined ? undefined : inertFunction<T>(value, `${subject}.${key}`);
}

function captureCallbackObject<T extends object>(
  value: unknown,
  subject: string,
  required: readonly string[],
  optional: readonly string[] = [],
): T {
  const map = descriptors(value, subject);
  const result: Record<string, unknown> = {};
  for (const key of required) result[key] = callback(map, key, subject);
  for (const key of optional) {
    const captured = optionalCallback(map, key, subject);
    if (captured) result[key] = captured;
  }
  return Object.freeze(result) as T;
}

function captureStore(value: unknown): FencedSessionStoreV2 {
  const subject = "buyer durability store";
  const map = descriptors(value, subject);
  const apiVersion = dataProperty<unknown>(map, "apiVersion", subject);
  if (apiVersion !== FENCED_SESSION_STORE_VERSION) {
    throw new TypeError("buyer durability requires FencedSessionStoreV2");
  }
  const create = callback<FencedSessionStoreV2["create"]>(map, "create", subject);
  const load = callback<FencedSessionStoreV2["load"]>(map, "load", subject);
  const transition = callback<FencedSessionStoreV2["transition"]>(map, "transition", subject);
  const claimCheckpoint = callback<FencedSessionStoreV2["claimCheckpoint"]>(
    map,
    "claimCheckpoint",
    subject,
  );
  const acquireLease = callback<FencedSessionStoreV2["acquireLease"]>(
    map,
    "acquireLease",
    subject,
  );
  const renewLease = callback<FencedSessionStoreV2["renewLease"]>(
    map,
    "renewLease",
    subject,
  );
  const bindSessionAuthorization = callback<
    FencedSessionStoreV2["bindSessionAuthorization"]
  >(map, "bindSessionAuthorization", subject);
  const bindHash = callback<FencedSessionStoreV2["bindHash"]>(map, "bindHash", subject);
  const list = callback<FencedSessionStoreV2["list"]>(map, "list", subject);
  const captured: FencedSessionStoreV2 = {
    apiVersion,
    create: async (input: Parameters<FencedSessionStoreV2["create"]>[0]) =>
      snapshotData(await create(clone(input)), "buyer store create result"),
    load: async (jobId: string) =>
      snapshotData(await load(jobId), "buyer store load result"),
    transition: async (input: Parameters<FencedSessionStoreV2["transition"]>[0]) =>
      snapshotData(
        await transition(clone(input)),
        "buyer store transition result",
      ),
    claimCheckpoint: async (
      input: Parameters<FencedSessionStoreV2["claimCheckpoint"]>[0],
    ) => snapshotData(
      await claimCheckpoint(clone(input)),
      "buyer store checkpoint result",
    ),
    acquireLease: async (
      input: Parameters<FencedSessionStoreV2["acquireLease"]>[0],
    ) => snapshotData(await acquireLease(clone(input)), "buyer store lease result"),
    renewLease: async (input: Parameters<FencedSessionStoreV2["renewLease"]>[0]) =>
      snapshotData(await renewLease(clone(input)), "buyer store renewal result"),
    bindSessionAuthorization: async (
      input: Parameters<FencedSessionStoreV2["bindSessionAuthorization"]>[0],
    ) =>
      snapshotData(
        await bindSessionAuthorization(clone(input)),
        "buyer store authorization result",
      ),
    bindHash: async (input: Parameters<FencedSessionStoreV2["bindHash"]>[0]) =>
      snapshotData(await bindHash(clone(input)), "buyer store hash-binding result"),
    list: async (filter: Parameters<FencedSessionStoreV2["list"]>[0]) =>
      snapshotData(
        await list(filter === undefined ? undefined : clone(filter)),
        "buyer store list result",
      ),
  };
  return Object.freeze(captured);
}

function captureSettlementProvider(
  value: unknown,
): SessionSettlementVerificationProvider {
  const subject = "buyer settlement verification provider";
  const map = descriptors(value, subject);
  return Object.freeze({
    authenticateContext: callback(map, "authenticateContext", subject),
    verifyEvidenceAnchor: callback(map, "verifyEvidenceAnchor", subject),
    resolveNativeProof: callback(map, "resolveNativeProof", subject),
    revalidateSettlement: callback(map, "revalidateSettlement", subject),
    evidence: captureCallbackObject(
      dataProperty(map, "evidence", subject),
      `${subject}.evidence`,
      ["resolvePublicKey", "verify"],
    ),
  }) as SessionSettlementVerificationProvider;
}

function captureTransport(value: unknown): BuyerBundleTransport {
  return captureCallbackObject<BuyerBundleTransport>(
    value,
    "buyer bundle transport",
    [
      "resolveSellerRequest",
      "publishCounterSignature",
      "resolveCounterSignatures",
      "resolveSellerFinalization",
    ],
  );
}

function captureProvider(
  value: DurableBuyerBundleFinalizationProvider,
): DurableBuyerBundleFinalizationProvider {
  const subject = "durable buyer bundle provider";
  const map = descriptors(value, subject);
  const mapping = dataProperty<unknown>(map, "mapping", subject);
  if (mapping !== "pure" && mapping !== "write-input") {
    throw new TypeError("durable buyer bundle provider has an invalid mapping");
  }
  const publish = optionalCallback<
    NonNullable<DurableBuyerBundleFinalizationProvider["publishBundleBinding"]>
  >(map, "publishBundleBinding", subject);
  const resolveBinding = optionalCallback<
    NonNullable<DurableBuyerBundleFinalizationProvider["resolveBundleBinding"]>
  >(map, "resolveBundleBinding", subject);
  const verifyBinding = optionalCallback<
    NonNullable<DurableBuyerBundleFinalizationProvider["verifyBundleBinding"]>
  >(map, "verifyBundleBinding", subject);
  if (
    mapping === "write-input" &&
    (!publish || !resolveBinding || !verifyBinding)
  ) {
    throw new TypeError("write-input durable buyer provider lacks binding seams");
  }
  const verifyPayloadMethodProof = optionalCallback(map, "verifyPayloadMethodProof", subject);
  const verifyPayloadMethodTransaction = optionalCallback(
    map,
    "verifyPayloadMethodTransaction",
    subject,
  );
  const resolvePaymentPhaseIndex = optionalCallback(map, "resolvePaymentPhaseIndex", subject);
  return Object.freeze({
    mapping,
    bundleCopyVerifier: captureCallbackObject(
      dataProperty(map, "bundleCopyVerifier", subject),
      `${subject}.bundleCopyVerifier`,
      ["resolvePublicKey", "verify"],
    ),
    compositeVerificationDeps: captureCallbackObject(
      dataProperty(map, "compositeVerificationDeps", subject),
      `${subject}.compositeVerificationDeps`,
      [
        "resolveRecipe",
        "isRecipeSignerAuthorized",
        "isVerifyResultSignerAuthorized",
        "resolvePublicKey",
        "verify",
        "verifyAuthorityAttestation",
      ],
      ["verifyRequirementParameters"],
    ),
    resolveDependency: callback(map, "resolveDependency", subject),
    verifyDependencyReceipt: callback(map, "verifyDependencyReceipt", subject),
    verifyDependencyBinding: callback(map, "verifyDependencyBinding", subject),
    verifyListingPublisherIdentityLinkage: callback(
      map,
      "verifyListingPublisherIdentityLinkage",
      subject,
    ),
    verifyVetRequirementProvenance: callback(
      map,
      "verifyVetRequirementProvenance",
      subject,
    ),
    ...(verifyPayloadMethodProof ? { verifyPayloadMethodProof } : {}),
    ...(verifyPayloadMethodTransaction ? { verifyPayloadMethodTransaction } : {}),
    ...(resolvePaymentPhaseIndex ? { resolvePaymentPhaseIndex } : {}),
    resolveSellerBundle: callback(map, "resolveSellerBundle", subject),
    verifyBundleAnchorReceipt: callback(map, "verifyBundleAnchorReceipt", subject),
    ...(resolveBinding ? { resolveBundleBinding: resolveBinding } : {}),
    ...(verifyBinding ? { verifyBundleBinding: verifyBinding } : {}),
    resolveBuyerBundle: callback(map, "resolveBuyerBundle", subject),
    submitBuyerBundle: callback(map, "submitBuyerBundle", subject),
    ...(publish ? { publishBundleBinding: publish } : {}),
  }) as DurableBuyerBundleFinalizationProvider;
}

function captureInput(
  value: DurableBuyerBundleFinalizationInput,
): DurableBuyerBundleFinalizationInput {
  const subject = "durable buyer bundle input";
  const map = descriptors(value, subject);
  const buyerMap = descriptors(dataProperty(map, "buyer", subject), `${subject}.buyer`);
  const buyer = {
    primaryClaim: dataProperty<unknown>(buyerMap, "primaryClaim", `${subject}.buyer`),
    bundleHash: dataProperty<unknown>(buyerMap, "bundleHash", `${subject}.buyer`),
    signer: callback<BuyerBundleFencedSigner>(buyerMap, "signer", `${subject}.buyer`),
  };
  if (!isNonEmpty(buyer.primaryClaim) || !isHash(buyer.bundleHash)) {
    throw new TypeError("durable buyer identity is malformed");
  }
  return Object.freeze({
    sellerVerificationInput: snapshotData(
      dataProperty(map, "sellerVerificationInput", subject),
      `${subject}.sellerVerificationInput`,
    ),
    settlementContext: snapshotData(
      dataProperty(map, "settlementContext", subject),
      `${subject}.settlementContext`,
    ),
    settlement: snapshotData(
      dataProperty(map, "settlement", subject),
      `${subject}.settlement`,
    ),
    buyer: Object.freeze(buyer),
  }) as DurableBuyerBundleFinalizationInput;
}

function captureDurability(
  value: BuyerBundleFinalizationDurability,
): BuyerBundleFinalizationDurability {
  const subject = "buyer bundle durability";
  const map = descriptors(value, subject);
  const workerId = dataProperty<unknown>(map, "workerId", subject);
  const leaseTtlMs = dataProperty<unknown>(map, "leaseTtlMs", subject);
  const leaseNowMs = optionalCallback<() => number>(map, "leaseNowMs", subject);
  if (!isNonEmpty(workerId) || !Number.isSafeInteger(leaseTtlMs) || (leaseTtlMs as number) <= 0) {
    throw new TypeError("buyer durability requires workerId and positive integer leaseTtlMs");
  }
  return Object.freeze({
    store: captureStore(dataProperty(map, "store", subject)),
    workerId,
    leaseTtlMs,
    ...(leaseNowMs ? { leaseNowMs } : {}),
    settlementVerification: captureSettlementProvider(
      dataProperty(map, "settlementVerification", subject),
    ),
    transport: captureTransport(dataProperty(map, "transport", subject)),
    reconcileSignature: callback(map, "reconcileSignature", subject),
    reconcileCounterSignaturePublication: callback(
      map,
      "reconcileCounterSignaturePublication",
      subject,
    ),
    reconcileBuyerBundleAnchor: callback(
      map,
      "reconcileBuyerBundleAnchor",
      subject,
    ),
    reconcileBindingPublication: callback(
      map,
      "reconcileBindingPublication",
      subject,
    ),
  }) as BuyerBundleFinalizationDurability;
}

function captureTransportResolution<T>(
  value: unknown,
  subject: string,
): BuyerBundleTransportResolution<T> {
  const snapshot = snapshotData(value, `${subject} output`) as unknown;
  if (!isRecord(snapshot) || !isNonEmpty(snapshot.disposition)) {
    throw new SubstrateError(`${subject} returned a malformed disposition`);
  }
  if (
    snapshot.disposition === "present" &&
    exactOwnKeys(snapshot, ["disposition", "value"])
  ) return snapshot as unknown as BuyerBundleTransportResolution<T>;
  if (
    ["absent", "rejected", "indeterminate"].includes(snapshot.disposition) &&
    exactOwnKeys(snapshot, ["disposition", "reason"]) &&
    isNonEmpty(snapshot.reason)
  ) return snapshot as BuyerBundleTransportResolution<T>;
  throw new SubstrateError(`${subject} returned a malformed disposition`);
}

function capturePublication(value: unknown): BuyerCounterSignaturePublication {
  const snapshot = snapshotData(value, "counter-signature publication output") as unknown;
  if (!isRecord(snapshot)) {
    throw new SubstrateError("counter-signature publisher returned malformed output");
  }
  if (
    snapshot.disposition === "published" &&
    exactOwnKeys(snapshot, ["disposition"])
  ) return snapshot as BuyerCounterSignaturePublication;
  if (
    (snapshot.disposition === "rejected" || snapshot.disposition === "indeterminate") &&
    exactOwnKeys(snapshot, ["disposition", "reason"]) &&
    isNonEmpty(snapshot.reason)
  ) return snapshot as BuyerCounterSignaturePublication;
  throw new SubstrateError("counter-signature publisher returned malformed output");
}

function captureBindingPublication(value: unknown): SellerBundleBindingPublication {
  return capturePublication(value) as SellerBundleBindingPublication;
}

function captureReasonReconciliation(
  value: unknown,
  subject: string,
  successes: readonly string[],
): Record<string, unknown> {
  const snapshot = snapshotData(value, `${subject} output`) as unknown;
  if (!isRecord(snapshot) || !isNonEmpty(snapshot.disposition)) {
    throw new SubstrateError(`${subject} returned malformed output`);
  }
  if (
    successes.includes(snapshot.disposition) &&
    exactOwnKeys(snapshot, ["disposition"])
  ) return snapshot;
  if (
    ["authoritatively-absent", "rejected", "indeterminate"].includes(
      snapshot.disposition,
    ) &&
    exactOwnKeys(snapshot, ["disposition", "reason"]) &&
    isNonEmpty(snapshot.reason)
  ) return snapshot;
  throw new SubstrateError(`${subject} returned malformed output`);
}

function captureSignatureReconciliation(
  value: unknown,
): BuyerBundleSignatureReconciliation {
  const snapshot = snapshotData(
    value,
    "buyer signature reconciliation output",
  ) as unknown;
  if (!isRecord(snapshot)) {
    throw new SubstrateError("buyer signature reconciliation returned malformed output");
  }
  if (
    snapshot.disposition === "signed" &&
    exactOwnKeys(snapshot, ["disposition", "value"]) &&
    (typeof snapshot.value === "string" || snapshot.value instanceof Uint8Array)
  ) return snapshot as unknown as BuyerBundleSignatureReconciliation;
  return captureReasonReconciliation(
    snapshot,
    "buyer signature reconciliation",
    [],
  ) as BuyerBundleSignatureReconciliation;
}

function captureCounterPublicationReconciliation(
  value: unknown,
): BuyerCounterSignaturePublicationReconciliation {
  const snapshot = snapshotData(
    value,
    "counter-signature publication reconciliation output",
  ) as unknown;
  if (
    isRecord(snapshot) &&
    snapshot.disposition === "present" &&
    exactOwnKeys(snapshot, ["disposition", "signature"]) &&
    isRecord(snapshot.signature)
  ) return snapshot as unknown as BuyerCounterSignaturePublicationReconciliation;
  return captureReasonReconciliation(
    snapshot,
    "counter-signature publication reconciliation",
    [],
  ) as BuyerCounterSignaturePublicationReconciliation;
}

class DurableBuyerCoordinator {
  readonly #input: DurableBuyerBundleFinalizationInput;
  readonly #provider: DurableBuyerBundleFinalizationProvider;
  readonly #durability: BuyerBundleFinalizationDurability;
  #lease?: SessionLeaseToken;
  #settlement?: Extract<VerifiedSessionSettlement, { outcome: "success" }>;
  #identity?: BuyerBundleTransportIdentity;
  #authority?: Record<string, CheckpointValue>;
  #request?: CompletedSellerBundleCounterSignatureRequest;
  #requestData?: Record<string, CheckpointValue>;
  #counterSignature?: BundleSignature;
  #counterSignatures?: BundleSignature[];
  #sellerFinalization?: FinalizedSellerBundle;

  constructor(
    input: DurableBuyerBundleFinalizationInput,
    provider: DurableBuyerBundleFinalizationProvider,
    durability: BuyerBundleFinalizationDurability,
  ) {
    this.#input = input;
    this.#provider = provider;
    this.#durability = durability;
  }

  #jobId(): string {
    return this.#input.sellerVerificationInput.agreement.jobId;
  }

  #agreementHash(): string {
    return this.#input.sellerVerificationInput.agreement.contentHash;
  }

  #now(): number {
    const now = this.#durability.leaseNowMs?.() ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0 || Object.is(now, -0)) {
      throw new DacsError("buyer durability clock returned an invalid time");
    }
    return now;
  }

  async #load(): Promise<SessionRecord> {
    return exactRecordFromLoad(await this.#durability.store.load(this.#jobId()));
  }

  async #verifySettlement(mode: "initial" | "recovery"): Promise<void> {
    const verification = await verifyFinalizedSessionSettlement(
      clone(this.#input.settlementContext),
      clone(this.#input.settlement),
      this.#durability.settlementVerification,
      mode,
    );
    if (verification.disposition !== "verified") {
      if (verification.disposition === "indeterminate") {
        throw new ProgressSignal("indeterminate", "settlement", verification.reason);
      }
      if (verification.disposition === "rejected") {
        throw new ProgressSignal("rejected", "settlement", verification.reason);
      }
      throw new DacsError(`settlement verification failed: ${verification.reason}`);
    }
    const settlement = clone(verification.value);
    if (settlement.outcome !== "success") {
      throw new ProgressSignal(
        "rejected",
        "settlement",
        "buyer bundle finalization requires successful settlement",
      );
    }
    const binding = settlement.settlementBinding;
    if (
      binding.jobId !== this.#jobId() ||
      this.#input.settlementContext.agreementHash !== this.#agreementHash() ||
      !isHash(settlement.identityHash) ||
      !isHash(settlement.contextHash) ||
      !isHash(settlement.evidenceHash) ||
      !isHash(settlement.nativeProofHash) ||
      !isHash(settlement.nativeObservationHash) ||
      !isHash(settlement.observationHash)
    ) {
      throw new DacsError("verified settlement is rebound to another buyer session");
    }
    const seller = this.#input.sellerVerificationInput.seller.primaryClaim;
    if (!isNonEmpty(seller)) throw new DacsError("seller identity is unavailable");
    const agreement = this.#input.sellerVerificationInput.agreement;
    const context = this.#input.settlementContext;
    if (
      context.jobId !== this.#jobId() ||
      context.payer.primaryClaim !== this.#input.buyer.primaryClaim ||
      context.payee.primaryClaim !== seller ||
      agreement.buyer.primaryClaim !== this.#input.buyer.primaryClaim ||
      agreement.buyer.bundleHash !== this.#input.buyer.bundleHash ||
      agreement.seller.primaryClaim !== seller
    ) {
      throw new DacsError(
        "verified settlement parties do not match the exact buyer/seller agreement",
      );
    }
    this.#settlement = settlement;
    this.#identity = Object.freeze({
      jobId: this.#jobId(),
      agreementHash: this.#agreementHash(),
      settlementId: binding.settlementId,
      settlementIdentityHash: settlement.identityHash,
      buyer: this.#input.buyer.primaryClaim,
      buyerBundleHash: this.#input.buyer.bundleHash,
      seller,
    });
    this.#authority = {
      jobId: this.#jobId(),
      agreementHash: this.#agreementHash(),
      settlementId: binding.settlementId,
      settlementIdentityHash: settlement.identityHash,
      settlementContextHash: settlement.contextHash,
      settlementEvidenceHash: settlement.evidenceHash,
      settlementNativeProofHash: settlement.nativeProofHash,
      settlementRailId: binding.railId,
      settlementPhaseIndex: binding.phaseIndex,
      buyer: this.#input.buyer.primaryClaim,
      buyerBundleHash: this.#input.buyer.bundleHash,
      seller,
    };
  }

  #stableAuthority(): Record<string, CheckpointValue> {
    if (!this.#authority) throw new DacsError("buyer durable authority is unavailable");
    return clone(this.#authority);
  }

  #fullAuthority(): Record<string, CheckpointValue> {
    if (!this.#requestData) throw new DacsError("buyer request authority is unavailable");
    return { ...this.#stableAuthority(), ...clone(this.#requestData) };
  }

  #idempotencyKey(
    kind: string,
    effectIdentity: Record<string, CheckpointValue>,
  ): string {
    return `buyer:${kind}:${sha256Hex(canonicalize({
      ...this.#stableAuthority(),
      ...effectIdentity,
    }))}`;
  }

  #sellerResultIdentityHash(): string {
    if (!this.#sellerFinalization) {
      throw new DacsError("authenticated seller finalization is unavailable");
    }
    return String(
      this.#sellerResultData(this.#sellerFinalization).sellerResultIdentityHash,
    );
  }

  async #renew(): Promise<void> {
    if (!this.#lease) throw new SubstrateError("buyer bundle lease is unavailable");
    const renewed = await this.#durability.store.renewLease({
      jobId: this.#jobId(),
      leaseToken: this.#lease,
      ttlMs: this.#durability.leaseTtlMs,
      now: this.#now(),
    });
    if (!renewed.ok) {
      throw new SubstrateError(`buyer bundle lease is stale: ${renewed.reason}`);
    }
  }

  #fence(idempotencyKey: string): Readonly<BuyerBundleEffectFence> {
    if (!this.#lease) throw new SubstrateError("buyer bundle lease is unavailable");
    return Object.freeze({ ...this.#lease, idempotencyKey });
  }

  async #effect<T>(
    idempotencyKey: string,
    operation: (fence: Readonly<BuyerBundleEffectFence>) => Promise<T> | T,
  ): Promise<T> {
    await this.#renew();
    const fence = this.#fence(idempotencyKey);
    let heartbeat = Promise.resolve();
    let heartbeatError: unknown;
    const interval = Math.max(
      1,
      Math.min(30_000, Math.floor(this.#durability.leaseTtlMs / 3)),
    );
    const timer = setInterval(() => {
      heartbeat = heartbeat
        .then(() => this.#renew())
        .catch((error: unknown) => {
          heartbeatError ??= error;
        });
    }, interval);
    timer.unref();
    try {
      const result = await callbackResult(operation(fence), "buyer effect callback");
      clearInterval(timer);
      await heartbeat;
      if (heartbeatError) throw heartbeatError;
      await this.#renew();
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  #phaseFor(record: SessionRecord, requested: string): string | undefined {
    const current = BUYER_PHASE_RANK.get(record.phase);
    const wanted = BUYER_PHASE_RANK.get(requested);
    return current !== undefined && wanted !== undefined && current > wanted
      ? undefined
      : requested;
  }

  #buyerPublicationStage(record: SessionRecord): BuyerBundleFinalizationStage {
    const hasBindingState =
      latestCheckpoint(
        record.checkpoints,
        buyerBundleFinalizationCheckpointKey.bindingSignature,
      ) !== undefined ||
      latestCheckpoint(
        record.checkpoints,
        buyerBundleFinalizationCheckpointKey.bindingPublication,
      ) !== undefined ||
      (BUYER_PHASE_RANK.get(record.phase) ?? -1) >=
        (BUYER_PHASE_RANK.get("buyer:bundle-binding-signing") ?? Number.MAX_SAFE_INTEGER);
    return hasBindingState ? "buyer-bundle-binding" : "buyer-bundle-anchor";
  }

  async #claim(
    key: string,
    data: Record<string, CheckpointValue>,
    phase: string,
  ): Promise<{
    state: "fresh" | "intent" | "outcome";
    data: Record<string, CheckpointValue>;
    record: SessionRecord;
  }> {
    if (!this.#lease) throw new SubstrateError("buyer bundle lease is unavailable");
    await this.#renew();
    const record = await this.#load();
    const requested = this.#phaseFor(record, phase);
    const claimed = await this.#durability.store.claimCheckpoint({
      jobId: this.#jobId(),
      key,
      data: clone(data),
      ...(requested ? { phase: requested } : {}),
      leaseToken: this.#lease,
      now: this.#now(),
    });
    if (claimed.ok) {
      return { state: "fresh", data: clone(data), record: claimed.record };
    }
    if ((claimed.reason !== "held" && claimed.reason !== "completed") || !claimed.record) {
      throw new SubstrateError(`buyer checkpoint ${key} claim failed: ${claimed.reason}`);
    }
    const checkpoint = latestCheckpoint(claimed.record.checkpoints, key);
    if (!checkpoint?.data) throw new DacsError(`buyer checkpoint ${key} is malformed`);
    if (claimed.reason === "held" && !dataMatches(checkpoint.data, data)) {
      throw new DacsError(`buyer checkpoint ${key} binds different content`);
    }
    return {
      state: claimed.reason === "completed" ? "outcome" : "intent",
      data: clone(checkpoint.data),
      record: claimed.record,
    };
  }

  async #appendOutcome(
    key: string,
    intent: Record<string, CheckpointValue>,
    outcome: Record<string, CheckpointValue>,
    requestedPhase?: string,
  ): Promise<void> {
    if (!this.#lease) throw new SubstrateError("buyer bundle lease is unavailable");
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      await this.#renew();
      const record = await this.#load();
      const prior = latestCheckpoint(record.checkpoints, key);
      if (prior?.stage === "outcome") {
        if (!dataMatches(prior.data, outcome)) {
          throw new DacsError(`buyer checkpoint ${key} outcome is rebound`);
        }
        return;
      }
      if (prior?.stage !== "intent" || !dataMatches(prior.data, intent)) {
        throw new DacsError(`buyer checkpoint ${key} intent disappeared or changed`);
      }
      const phase = requestedPhase ? this.#phaseFor(record, requestedPhase) : undefined;
      const transitioned = await this.#durability.store.transition({
        jobId: this.#jobId(),
        expectedRevision: record.revision,
        leaseToken: this.#lease,
        ...(phase ? { phase } : {}),
        checkpoint: { key, stage: "outcome", data: clone(outcome) },
        now: this.#now(),
      });
      if (transitioned.ok) return;
      if (transitioned.reason !== "revision-mismatch") {
        throw new SubstrateError(
          `buyer checkpoint ${key} outcome failed: ${transitioned.reason}`,
        );
      }
    }
    throw new SubstrateError(`buyer checkpoint ${key} exceeded CAS retry limit`);
  }

  async #ensureOutcome(
    key: string,
    data: Record<string, CheckpointValue>,
    phase: string,
  ): Promise<void> {
    const claimed = await this.#claim(key, data, phase);
    if (claimed.state === "outcome") {
      if (!dataMatches(claimed.data, data)) {
        throw new DacsError(`buyer checkpoint ${key} outcome is rebound`);
      }
      return;
    }
    await this.#appendOutcome(key, data, data, phase);
  }

  async #advancePhase(phase: string): Promise<void> {
    if (!this.#lease) throw new SubstrateError("buyer bundle lease is unavailable");
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      await this.#renew();
      const record = await this.#load();
      const requested = this.#phaseFor(record, phase);
      if (!requested) return;
      const result = await this.#durability.store.transition({
        jobId: this.#jobId(),
        expectedRevision: record.revision,
        leaseToken: this.#lease,
        phase: requested,
        now: this.#now(),
      });
      if (result.ok) return;
      if (result.reason !== "revision-mismatch") {
        throw new SubstrateError(`buyer phase ${phase} failed: ${result.reason}`);
      }
    }
    throw new SubstrateError(`buyer phase ${phase} exceeded CAS retry limit`);
  }

  async #acquire(): Promise<void> {
    const acquired = await this.#durability.store.acquireLease({
      jobId: this.#jobId(),
      owner: this.#durability.workerId,
      ttlMs: this.#durability.leaseTtlMs,
      now: this.#now(),
    });
    if (!acquired.ok) {
      throw new ProgressSignal(
        "indeterminate",
        "lease",
        `buyer bundle lease unavailable: ${acquired.reason}`,
      );
    }
    this.#lease = {
      owner: acquired.lease.owner,
      generation: acquired.lease.generation,
    };
  }

  async #release(): Promise<void> {
    const lease = this.#lease;
    if (!lease) return;
    try {
      for (let attempt = 0; attempt < MAX_RELEASE_ATTEMPTS; attempt += 1) {
        const record = await this.#load();
        if (
          record.phase === "buyer:finalised" ||
          record.lease?.owner !== lease.owner ||
          record.lease.generation !== lease.generation
        ) return;
        const result = await this.#durability.store.transition({
          jobId: this.#jobId(),
          expectedRevision: record.revision,
          leaseToken: lease,
          lease: null,
          now: this.#now(),
        });
        if (result.ok) {
          this.#lease = undefined;
          return;
        }
        if (result.reason !== "revision-mismatch") return;
      }
    } catch {
      // The exact token remains fenced and expires by TTL.
    }
  }

  #settlementCheckpointData(): Record<string, CheckpointValue> {
    if (!this.#settlement) throw new DacsError("verified settlement is unavailable");
    return {
      ...this.#stableAuthority(),
      settlementObservationHash: this.#settlement.observationHash,
      settlementNativeObservationHash: this.#settlement.nativeObservationHash,
    };
  }

  #hasExactSettlementCheckpoint(record: SessionRecord): boolean {
    const current = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.settlement,
    );
    if (!current) return false;
    const stable = this.#stableAuthority();
    if (
      current.stage !== "outcome" ||
      !current.data ||
      !dataMatches(
        withoutKeys(current.data, [
          "settlementObservationHash",
          "settlementNativeObservationHash",
        ]),
        stable,
      ) ||
      !isHash(current.data.settlementObservationHash) ||
      !isHash(current.data.settlementNativeObservationHash)
    ) {
      throw new DacsError("durable settlement checkpoint is malformed or rebound");
    }
    return true;
  }

  async #ensureSettlementCheckpoint(record: SessionRecord): Promise<void> {
    if (this.#hasExactSettlementCheckpoint(record)) return;
    await this.#ensureOutcome(
      buyerBundleFinalizationCheckpointKey.settlement,
      this.#settlementCheckpointData(),
      "buyer:bundle-review",
    );
  }

  async #resolveRequest(record: SessionRecord): Promise<void> {
    const retained = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.request,
    );
    let supplied: unknown;
    if (retained) {
      if (!retained.data) throw new DacsError("durable seller request checkpoint lacks data");
      supplied = decodeRequest(retained.data.request, retained.data.requestHash);
    } else {
      let resolution: BuyerBundleTransportResolution<unknown>;
      try {
        resolution = captureTransportResolution(
          await callbackResult(
            this.#durability.transport.resolveSellerRequest(
              immutable(this.#identity!),
            ),
            "seller request resolver",
          ),
          "seller request resolver",
        );
      } catch (error) {
        if (error instanceof DacsError) throw error;
        throw new ProgressSignal(
          "indeterminate",
          "seller-request",
          error instanceof Error
            ? `seller request resolution failed: ${error.message}`
            : "seller request resolution failed",
        );
      }
      if (resolution.disposition === "absent") {
        throw new ProgressSignal("waiting", "seller-request", resolution.reason);
      }
      if (resolution.disposition === "rejected") {
        throw new ProgressSignal("rejected", "seller-request", resolution.reason);
      }
      if (resolution.disposition === "indeterminate") {
        throw new ProgressSignal("indeterminate", "seller-request", resolution.reason);
      }
      supplied = resolution.value;
    }
    const authenticated = await verifyCompletedSellerBundleCounterSignatureRequest(
      clone(this.#input.sellerVerificationInput),
      clone(supplied),
      this.#readProvider(),
    );
    const encoded = encodeRequest(authenticated);
    const requestData = {
      requestHash: encoded.hash,
      requestMessageHash: encoded.messageHash,
      requestBundleContentHash: authenticated.bundleContentHash,
      request: encoded.encoded,
      requiredCounterSignersHash: sha256Hex(
        canonicalize(authenticated.requiredCounterSigners),
      ),
    };
    if (
      authenticated.requiredCounterSigners.filter(
        (signer) => signer === this.#input.buyer.primaryClaim,
      ).length !== 1
    ) {
      throw new DacsError("authenticated seller request does not require this buyer");
    }
    this.#request = clone(authenticated);
    this.#requestData = requestData;
    await this.#ensureSettlementCheckpoint(await this.#load());
    await this.#ensureOutcome(
      buyerBundleFinalizationCheckpointKey.request,
      { ...this.#stableAuthority(), ...requestData },
      "buyer:bundle-review",
    );
  }

  #signatureIntent(
    purpose: BuyerBundleSignaturePurpose,
    messageHash: string,
  ): Record<string, CheckpointValue> {
    const idempotencyKey = purpose === "counter-signature"
      ? this.#idempotencyKey("counter-signature", {
          requestHash: String(this.#requestData!.requestHash),
          signer: this.#input.buyer.primaryClaim,
          messageHash,
        })
      : this.#idempotencyKey("bundle-binding-signature", {
          requestHash: String(this.#requestData!.requestHash),
          sellerResultIdentityHash: this.#sellerResultIdentityHash(),
          signer: this.#input.buyer.primaryClaim,
          messageHash,
        });
    return {
      ...this.#fullAuthority(),
      idempotencyKey,
      purpose,
      signer: this.#input.buyer.primaryClaim,
      messageHash,
      algorithm: "ed25519",
      ...(purpose === "bundle-binding"
        ? { sellerResultIdentityHash: this.#sellerResultIdentityHash() }
        : {}),
    };
  }

  async #verifyEd25519Signature(
    signer: string,
    signatureValue: string,
    bytes: Uint8Array,
    stage: BuyerBundleFinalizationStage,
    subject: string,
  ): Promise<void> {
    let key: Uint8Array | null;
    try {
      key = await this.#provider.bundleCopyVerifier.resolvePublicKey(signer);
    } catch {
      throw new ProgressSignal(
        "indeterminate",
        stage,
        `${subject} key resolution failed`,
      );
    }
    if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
      throw new ProgressSignal(
        "rejected",
        stage,
        `${subject} key is unavailable`,
      );
    }
    let verified: boolean;
    try {
      verified = await this.#provider.bundleCopyVerifier.verify(
        new Uint8Array(bytes),
        Uint8Array.from(Buffer.from(signatureValue, "base64url")),
        new Uint8Array(key),
      );
    } catch {
      throw new ProgressSignal(
        "indeterminate",
        stage,
        `${subject} verification failed`,
      );
    }
    if (verified !== true) {
      throw new ProgressSignal(
        "rejected",
        stage,
        `${subject} does not verify under the authenticated signer key`,
      );
    }
  }

  async #verifySignatureValue(
    purpose: BuyerBundleSignaturePurpose,
    signatureValue: string,
    bytes: Uint8Array,
  ): Promise<void> {
    await this.#verifyEd25519Signature(
      this.#input.buyer.primaryClaim,
      signatureValue,
      bytes,
      purpose === "counter-signature"
        ? "counter-signature"
        : "buyer-bundle-binding",
      "buyer signature",
    );
  }

  async #sign(
    purpose: BuyerBundleSignaturePurpose,
    bytes: Uint8Array,
  ): Promise<string> {
    const messageHash = sha256Hex(bytes);
    const key = purpose === "counter-signature"
      ? buyerBundleFinalizationCheckpointKey.counterSignature
      : buyerBundleFinalizationCheckpointKey.bindingSignature;
    const intent = this.#signatureIntent(purpose, messageHash);
    const idempotencyKey = String(intent.idempotencyKey);
    const phase = purpose === "counter-signature"
      ? "buyer:counter-signing"
      : "buyer:bundle-binding-signing";
    const claimed = await this.#claim(key, intent, phase);
    if (claimed.state === "outcome") {
      const retainedIntent = withoutKeys(claimed.data, ["signatureValue"]);
      if (
        !dataMatches(retainedIntent, intent) ||
        !isCanonicalBase64Url(claimed.data.signatureValue) ||
        Buffer.from(String(claimed.data.signatureValue), "base64url").byteLength !== 64
      ) {
        throw new DacsError(`durable buyer signature ${key} is malformed or rebound`);
      }
      const retainedValue = String(claimed.data.signatureValue);
      await this.#verifySignatureValue(purpose, retainedValue, bytes);
      return retainedValue;
    }

    let value: Uint8Array | string;
    if (claimed.state === "fresh") {
      try {
        value = await this.#effect(idempotencyKey, (fence) =>
          this.#input.buyer.signer(new Uint8Array(bytes), fence),
        );
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          purpose === "counter-signature" ? "counter-signature" : "buyer-bundle-binding",
          error instanceof Error
            ? `buyer signer outcome is ambiguous: ${error.message}`
            : "buyer signer outcome is ambiguous",
        );
      }
    } else {
      let reconciliation: BuyerBundleSignatureReconciliation;
      try {
        reconciliation = captureSignatureReconciliation(
          await this.#effect(idempotencyKey, (fence) =>
            this.#durability.reconcileSignature({
              purpose,
              signer: this.#input.buyer.primaryClaim,
              messageHash,
              signedBytes: new Uint8Array(bytes),
              fence,
            }),
          ),
        );
      } catch (error) {
        if (error instanceof ProgressSignal) throw error;
        throw new ProgressSignal(
          "indeterminate",
          purpose === "counter-signature" ? "counter-signature" : "buyer-bundle-binding",
          "buyer signature reconciliation failed",
        );
      }
      if (reconciliation.disposition === "rejected") {
        throw new ProgressSignal(
          "rejected",
          purpose === "counter-signature" ? "counter-signature" : "buyer-bundle-binding",
          reconciliation.reason,
        );
      }
      if (reconciliation.disposition === "indeterminate") {
        throw new ProgressSignal(
          "indeterminate",
          purpose === "counter-signature" ? "counter-signature" : "buyer-bundle-binding",
          reconciliation.reason,
        );
      }
      value = reconciliation.disposition === "signed"
        ? reconciliation.value
        : await this.#effect(idempotencyKey, (fence) =>
            this.#input.buyer.signer(new Uint8Array(bytes), fence),
          );
    }
    const signatureValue = normalizeSignature(value);
    await this.#verifySignatureValue(purpose, signatureValue, bytes);
    await this.#appendOutcome(
      key,
      intent,
      { ...intent, signatureValue },
      phase,
    );
    return signatureValue;
  }

  async #createCounterSignature(): Promise<void> {
    if (!this.#request) throw new DacsError("authenticated seller request is unavailable");
    const signature = await createCompletedBuyerBundleCounterSignature(
      {
        sellerVerificationInput: clone(this.#input.sellerVerificationInput),
        buyer: {
          primaryClaim: this.#input.buyer.primaryClaim,
          bundleHash: this.#input.buyer.bundleHash,
          signer: async (bytes) =>
            Uint8Array.from(
              Buffer.from(await this.#sign("counter-signature", bytes), "base64url"),
            ),
        },
      },
      clone(this.#request),
      this.#readProvider(),
    );
    const checkpoint = latestCheckpoint(
      (await this.#load()).checkpoints,
      buyerBundleFinalizationCheckpointKey.counterSignature,
    );
    if (
      checkpoint?.stage !== "outcome" ||
      checkpoint.data?.signatureValue !== signature.value ||
      signature.party !== this.#input.buyer.primaryClaim ||
      signature.algorithm !== "ed25519"
    ) {
      throw new DacsError("buyer core returned a signature outside its durable outcome");
    }
    this.#counterSignature = immutable(signature);
  }

  #counterPublicationIntent(): Record<string, CheckpointValue> {
    if (!this.#counterSignature || !this.#identity || !this.#requestData) {
      throw new DacsError("buyer counter-signature publication authority is unavailable");
    }
    return {
      ...this.#fullAuthority(),
      idempotencyKey: this.#idempotencyKey("counter-signature-publication", {
        requestHash: String(this.#requestData.requestHash),
        counterSignatureHash: signatureHash(this.#counterSignature),
      }),
      counterSignatureHash: signatureHash(this.#counterSignature),
      counterSignatureValue: this.#counterSignature.value,
    };
  }

  async #publishCounterSignature(): Promise<void> {
    const intent = this.#counterPublicationIntent();
    const key = buyerBundleFinalizationCheckpointKey.counterSignaturePublication;
    const claimed = await this.#claim(
      key,
      intent,
      "buyer:counter-signature-publication-pending",
    );
    if (claimed.state === "outcome") {
      if (!dataMatches(claimed.data, { ...intent, published: true })) {
        throw new DacsError("durable counter-signature publication outcome is rebound");
      }
      await this.#advancePhase("buyer:awaiting-seller-finalisation");
      return;
    }
    const idempotencyKey = String(intent.idempotencyKey);
    let publication: BuyerCounterSignaturePublication;
    if (claimed.state === "fresh") {
      try {
        publication = capturePublication(
          await this.#effect(idempotencyKey, (fence) =>
            this.#durability.transport.publishCounterSignature(
              {
                identity: immutable(this.#identity!),
                requestHash: String(this.#requestData!.requestHash),
                signature: immutable(this.#counterSignature!),
              },
              fence,
            ),
          ),
        );
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          "counter-signature-publication",
          error instanceof Error ? error.message : "counter-signature publication failed",
        );
      }
    } else {
      let reconciliation: BuyerCounterSignaturePublicationReconciliation;
      try {
        reconciliation = captureCounterPublicationReconciliation(
          await this.#effect(idempotencyKey, (fence) =>
            this.#durability.reconcileCounterSignaturePublication(
              {
                identity: immutable(this.#identity!),
                requestHash: String(this.#requestData!.requestHash),
                signature: immutable(this.#counterSignature!),
              },
              fence,
            ),
          ),
        );
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          "counter-signature-publication",
          error instanceof Error ? error.message : "publication reconciliation failed",
        );
      }
      if (reconciliation.disposition === "present") {
        if (!exact(reconciliation.signature, this.#counterSignature)) {
          throw new DacsError("published counter-signature is substituted");
        }
        publication = { disposition: "published" };
      } else if (reconciliation.disposition === "authoritatively-absent") {
        publication = capturePublication(
          await this.#effect(idempotencyKey, (fence) =>
            this.#durability.transport.publishCounterSignature(
              {
                identity: immutable(this.#identity!),
                requestHash: String(this.#requestData!.requestHash),
                signature: immutable(this.#counterSignature!),
              },
              fence,
            ),
          ),
        );
      } else {
        throw new ProgressSignal(
          reconciliation.disposition === "rejected" ? "rejected" : "indeterminate",
          "counter-signature-publication",
          reconciliation.reason,
        );
      }
    }
    if (publication.disposition !== "published") {
      throw new ProgressSignal(
        publication.disposition === "rejected" ? "rejected" : "indeterminate",
        "counter-signature-publication",
        publication.reason,
      );
    }
    if (claimed.state === "fresh") {
      let confirmation: BuyerCounterSignaturePublicationReconciliation;
      try {
        confirmation = captureCounterPublicationReconciliation(
          await this.#effect(idempotencyKey, (fence) =>
            this.#durability.reconcileCounterSignaturePublication(
              {
                identity: immutable(this.#identity!),
                requestHash: String(this.#requestData!.requestHash),
                signature: immutable(this.#counterSignature!),
              },
              fence,
            ),
          ),
        );
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          "counter-signature-publication",
          error instanceof Error
            ? error.message
            : "counter-signature readback failed",
        );
      }
      if (
        confirmation.disposition === "present" &&
        !exact(confirmation.signature, this.#counterSignature)
      ) {
        throw new DacsError("published counter-signature is substituted");
      }
      if (confirmation.disposition !== "present") {
        throw new ProgressSignal(
          confirmation.disposition === "rejected" ? "rejected" : "indeterminate",
          "counter-signature-publication",
          confirmation.disposition === "authoritatively-absent"
            ? "published counter-signature is not independently readable"
            : confirmation.reason,
        );
      }
    }
    await this.#appendOutcome(
      key,
      intent,
      { ...intent, published: true },
      "buyer:counter-signature-publication-pending",
    );
    await this.#advancePhase("buyer:awaiting-seller-finalisation");
  }

  #requiredCounterSigners(): string[] {
    if (!this.#request) throw new DacsError("authenticated seller request is unavailable");
    const required = [...this.#request.requiredCounterSigners];
    if (
      required.length === 0 ||
      new Set(required).size !== required.length ||
      required.filter((signer) => signer === this.#input.buyer.primaryClaim).length !== 1
    ) {
      throw new DacsError("authenticated request has an invalid counter-signer set");
    }
    return required;
  }

  async #authenticateCounterSignatureSet(value: unknown): Promise<BundleSignature[]> {
    if (!this.#counterSignature || !this.#request) {
      throw new DacsError("durable buyer counter-signature is unavailable");
    }
    const snapshot = snapshotData(value, "resolved counter-signature set") as unknown;
    if (!Array.isArray(snapshot)) {
      throw new DacsError("resolved counter-signature set must be an array");
    }
    const required = this.#requiredCounterSigners();
    const captured = snapshot.map((signature, index) =>
      captureBundleSignature(signature, `resolved counter-signature ${index}`),
    );
    if (
      captured.length !== required.length ||
      new Set(captured.map((signature) => signature.party)).size !== captured.length ||
      captured.some((signature) => !required.includes(signature.party))
    ) {
      throw new DacsError(
        "resolved counter-signatures do not form the exact authenticated signer set",
      );
    }
    const ordered = required.map((signer) => {
      const signature = captured.find((candidate) => candidate.party === signer);
      if (!signature) {
        throw new DacsError(`resolved counter-signature for ${signer} is missing`);
      }
      return signature;
    });
    const buyerSignature = ordered.find(
      (signature) => signature.party === this.#input.buyer.primaryClaim,
    );
    if (!buyerSignature || !exact(buyerSignature, this.#counterSignature)) {
      throw new DacsError("resolved counter-signature set substituted the durable buyer signature");
    }
    for (const signature of ordered) {
      await this.#verifyEd25519Signature(
        signature.party,
        signature.value,
        this.#request.signedBytes,
        "counter-signature-set",
        `counter-signature by ${signature.party}`,
      );
    }
    return immutable(ordered);
  }

  #counterSignatureSetData(
    signatures: readonly BundleSignature[],
  ): Record<string, CheckpointValue> {
    const encoded = encodeCanonical(signatures, "authenticated counter-signature set");
    return {
      ...this.#fullAuthority(),
      buyerCounterSignatureHash: signatureHash(this.#counterSignature!),
      counterSignatureSet: encoded.encoded,
      counterSignatureSetHash: encoded.hash,
      counterSignaturePartiesHash: sha256Hex(
        canonicalize(signatures.map((signature) => signature.party)),
      ),
    };
  }

  async #resolveCounterSignatureSet(record: SessionRecord): Promise<void> {
    const key = buyerBundleFinalizationCheckpointKey.counterSignatureSet;
    const retained = latestCheckpoint(record.checkpoints, key);
    let candidate: unknown;
    if (retained) {
      if (!retained.data) {
        throw new DacsError("durable counter-signature set checkpoint lacks data");
      }
      candidate = decodeCounterSignatureSet(
        retained.data.counterSignatureSet,
        retained.data.counterSignatureSetHash,
      );
    } else if (this.#requiredCounterSigners().length === 1) {
      candidate = [clone(this.#counterSignature!)];
    } else {
      let resolution: BuyerBundleTransportResolution<unknown>;
      try {
        resolution = captureTransportResolution(
          await callbackResult(
            this.#durability.transport.resolveCounterSignatures({
              identity: immutable(this.#identity!),
              requestHash: String(this.#requestData!.requestHash),
              requiredCounterSignersHash: String(
                this.#requestData!.requiredCounterSignersHash,
              ),
              buyerSignature: immutable(this.#counterSignature!),
            }),
            "counter-signature set resolver",
          ),
          "counter-signature set resolver",
        );
      } catch (error) {
        if (error instanceof DacsError) throw error;
        throw new ProgressSignal(
          "indeterminate",
          "counter-signature-set",
          "counter-signature set resolution failed",
        );
      }
      if (resolution.disposition === "absent") {
        throw new ProgressSignal("waiting", "counter-signature-set", resolution.reason);
      }
      if (resolution.disposition === "rejected") {
        throw new ProgressSignal("rejected", "counter-signature-set", resolution.reason);
      }
      if (resolution.disposition === "indeterminate") {
        throw new ProgressSignal(
          "indeterminate",
          "counter-signature-set",
          resolution.reason,
        );
      }
      candidate = resolution.value;
    }
    let authenticated: BundleSignature[];
    try {
      authenticated = await this.#authenticateCounterSignatureSet(candidate);
    } catch (error) {
      if (error instanceof ProgressSignal || retained) throw error;
      throw new ProgressSignal(
        "rejected",
        "counter-signature-set",
        error instanceof Error
          ? error.message
          : "resolved counter-signature set is invalid",
      );
    }
    const data = this.#counterSignatureSetData(authenticated);
    await this.#ensureOutcome(
      key,
      data,
      "buyer:awaiting-seller-finalisation",
    );
    this.#counterSignatures = authenticated;
  }

  #finalVerificationInput(): VerifyFinalizedSellerBundleInput {
    if (!this.#counterSignature || !this.#counterSignatures) {
      throw new DacsError("complete authenticated counter-signature set is unavailable");
    }
    return {
      ...clone(this.#input.sellerVerificationInput),
      counterSignatures: clone(this.#counterSignatures),
    };
  }

  async #authenticateSellerFinalization(value: unknown): Promise<FinalizedSellerBundle> {
    const verified = await verifyFinalizedSellerBundleReadOnly(
      this.#finalVerificationInput(),
      clone(value),
      this.#readProvider(),
    );
    const buyerSignatures = verified.buyerBundle.signatures.filter(
      (signature) => signature.party === this.#input.buyer.primaryClaim,
    );
    if (
      buyerSignatures.length !== 1 ||
      !exact(buyerSignatures[0], this.#counterSignature)
    ) {
      throw new DacsError("seller finalization substituted the durable buyer signature");
    }
    return immutable(verified);
  }

  #sellerResultData(result: FinalizedSellerBundle): Record<string, CheckpointValue> {
    const encoded = encodeCanonical(result, "authenticated seller finalization");
    const identityHash = sha256Hex(canonicalize({
      bundleContentHash: result.bundleContentHash,
      logicalAddress: result.logicalAddress,
      nativeAddress: result.nativeAddress,
      anchorReceipt: result.anchorReceipt,
      binding: result.binding ?? null,
    }));
    return {
      ...this.#fullAuthority(),
      counterSignatureHash: signatureHash(this.#counterSignature!),
      counterSignatureSetHash: String(
        this.#counterSignatureSetData(this.#counterSignatures!).counterSignatureSetHash,
      ),
      sellerResult: encoded.encoded,
      sellerResultHash: encoded.hash,
      sellerResultIdentityHash: identityHash,
      sellerBundleContentHash: result.bundleContentHash,
      sellerLogicalAddress: result.logicalAddress,
      sellerNativeAddress: result.nativeAddress,
    };
  }

  async #resolveSellerFinalization(record: SessionRecord): Promise<void> {
    const retained = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.sellerFinalization,
    );
    let candidate: unknown;
    if (retained) {
      if (!retained.data) throw new DacsError("seller finalization checkpoint lacks data");
      candidate = decodeCanonical(
        retained.data.sellerResult,
        retained.data.sellerResultHash,
        "authenticated seller finalization",
      );
    } else {
      let resolution: BuyerBundleTransportResolution<unknown>;
      try {
        resolution = captureTransportResolution(
          await callbackResult(
            this.#durability.transport.resolveSellerFinalization({
              identity: immutable(this.#identity!),
              requestHash: String(this.#requestData!.requestHash),
              counterSignatureHash: signatureHash(this.#counterSignature!),
              counterSignatureSetHash: String(
                this.#counterSignatureSetData(this.#counterSignatures!)
                  .counterSignatureSetHash,
              ),
            }),
            "seller finalization resolver",
          ),
          "seller finalization resolver",
        );
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          "seller-finalisation",
          error instanceof Error ? error.message : "seller finalization resolution failed",
        );
      }
      if (resolution.disposition === "absent") {
        throw new ProgressSignal("waiting", "seller-finalisation", resolution.reason);
      }
      if (resolution.disposition === "rejected") {
        throw new ProgressSignal("rejected", "seller-finalisation", resolution.reason);
      }
      if (resolution.disposition === "indeterminate") {
        throw new ProgressSignal("indeterminate", "seller-finalisation", resolution.reason);
      }
      candidate = resolution.value;
    }
    const verified = await this.#authenticateSellerFinalization(candidate);
    const data = this.#sellerResultData(verified);
    await this.#ensureOutcome(
      buyerBundleFinalizationCheckpointKey.sellerFinalization,
      data,
      "buyer:bundle-anchor-pending",
    );
    this.#sellerFinalization = verified;
  }

  #anchorIntent(
    logicalAddress: string,
    bundleContentHash: string,
  ): Record<string, CheckpointValue> {
    const sellerResultIdentityHash = this.#sellerResultIdentityHash();
    const idempotencyKey = this.#idempotencyKey("bundle-anchor", {
      sellerResultIdentityHash,
      logicalAddress,
      bundleContentHash,
    });
    return {
      ...this.#fullAuthority(),
      idempotencyKey,
      logicalAddress,
      bundleContentHash,
      sellerResultIdentityHash,
    };
  }

  async #submitBuyerBundle(
    logicalAddress: string,
    bundle: Readonly<FaultAttestationBundle>,
  ): Promise<void> {
    const bundleContentHash = attestationBundleHash(bundle);
    const intent = this.#anchorIntent(logicalAddress, bundleContentHash);
    const idempotencyKey = String(intent.idempotencyKey);
    const key = buyerBundleFinalizationCheckpointKey.anchor;
    const claimed = await this.#claim(key, intent, "buyer:bundle-anchor-pending");
    if (claimed.state === "outcome") {
      const retained = withoutKeys(claimed.data, ["nativeAddress"]);
      if (!dataMatches(retained, intent)) {
        throw new DacsError("durable buyer bundle anchor outcome is rebound");
      }
      return;
    }
    if (claimed.state === "fresh") {
      await this.#effect(idempotencyKey, (fence) =>
        this.#provider.submitBuyerBundle(logicalAddress, immutable(bundle), fence),
      );
      return;
    }
    let reconciliation: BuyerBundleAnchorReconciliation;
    try {
      reconciliation = captureReasonReconciliation(
        await this.#effect(idempotencyKey, (fence) =>
          this.#durability.reconcileBuyerBundleAnchor(
            { logicalAddress, bundleContentHash },
            fence,
          ),
        ),
        "buyer bundle anchor reconciliation",
        ["present"],
      ) as BuyerBundleAnchorReconciliation;
    } catch (error) {
      throw new ProgressSignal(
        "indeterminate",
        "buyer-bundle-anchor",
        error instanceof Error ? error.message : "buyer bundle anchor reconciliation failed",
      );
    }
    if (reconciliation.disposition === "present") return;
    if (reconciliation.disposition === "authoritatively-absent") {
      await this.#effect(idempotencyKey, (fence) =>
        this.#provider.submitBuyerBundle(logicalAddress, immutable(bundle), fence),
      );
      return;
    }
    throw new ProgressSignal(
      reconciliation.disposition === "rejected" ? "rejected" : "indeterminate",
      "buyer-bundle-anchor",
      reconciliation.reason,
    );
  }

  #bindingIntent(binding: Readonly<BundleBinding>): Record<string, CheckpointValue> {
    const envelopeHash = sha256Hex(canonicalize(binding));
    const sellerResultIdentityHash = this.#sellerResultIdentityHash();
    return {
      ...this.#fullAuthority(),
      idempotencyKey: this.#idempotencyKey("bundle-binding-publication", {
        sellerResultIdentityHash,
        bindingEnvelopeHash: envelopeHash,
      }),
      sellerResultIdentityHash,
      logicalAddress: binding.logicalAddress,
      bundleContentHash: binding.bundleContentHash,
      bindingEnvelopeHash: envelopeHash,
    };
  }

  async #publishBinding(
    binding: Readonly<BundleBinding>,
  ): Promise<SellerBundleBindingPublication> {
    if (!this.#provider.publishBundleBinding) {
      throw new DacsError("durable binding publisher is unavailable");
    }
    const intent = this.#bindingIntent(binding);
    const key = buyerBundleFinalizationCheckpointKey.bindingPublication;
    const claimed = await this.#claim(
      key,
      intent,
      "buyer:bundle-binding-publication-pending",
    );
    if (claimed.state === "outcome") {
      if (!dataMatches(claimed.data, { ...intent, applicable: true })) {
        throw new DacsError("durable buyer binding publication outcome is rebound");
      }
      return { disposition: "published" };
    }
    const idempotencyKey = String(intent.idempotencyKey);
    if (claimed.state === "fresh") {
      return captureBindingPublication(
        await this.#effect(idempotencyKey, (fence) =>
          this.#provider.publishBundleBinding!(immutable(binding), fence),
        ),
      );
    }
    let reconciliation: BuyerBundleBindingPublicationReconciliation;
    try {
      reconciliation = captureReasonReconciliation(
        await this.#effect(idempotencyKey, (fence) =>
          this.#durability.reconcileBindingPublication(immutable(binding), fence),
        ),
        "buyer binding publication reconciliation",
        ["published"],
      ) as BuyerBundleBindingPublicationReconciliation;
    } catch (error) {
      throw new ProgressSignal(
        "indeterminate",
        "buyer-bundle-binding",
        error instanceof Error ? error.message : "binding reconciliation failed",
      );
    }
    if (reconciliation.disposition === "published") {
      return { disposition: "published" };
    }
    if (reconciliation.disposition === "authoritatively-absent") {
      return captureBindingPublication(
        await this.#effect(idempotencyKey, (fence) =>
          this.#provider.publishBundleBinding!(immutable(binding), fence),
        ),
      );
    }
    throw new ProgressSignal(
      reconciliation.disposition === "rejected" ? "rejected" : "indeterminate",
      "buyer-bundle-binding",
      reconciliation.reason,
    );
  }

  #readProvider(): SellerBundleFinalizationReadProvider {
    const {
      submitBuyerBundle: _submitBuyerBundle,
      publishBundleBinding: _publishBundleBinding,
      resolveBuyerBundle: _resolveBuyerBundle,
      ...read
    } = this.#provider;
    return Object.freeze(read);
  }

  #coreProvider(readOnly = false): BuyerBundleFinalizationProvider {
    const provider = this.#provider;
    return Object.freeze({
      ...provider,
      submitBuyerBundle: readOnly
        ? () => {
            throw new SubstrateError("terminal buyer verification cannot submit a bundle");
          }
        : (logicalAddress: string, bundle: Readonly<FaultAttestationBundle>) =>
            this.#submitBuyerBundle(logicalAddress, bundle),
      ...(provider.publishBundleBinding
        ? {
            publishBundleBinding: readOnly
              ? () => {
                  throw new SubstrateError(
                    "terminal buyer verification cannot publish a binding",
                  );
                }
              : (binding: Readonly<BundleBinding>) => this.#publishBinding(binding),
          }
        : {}),
    }) as BuyerBundleFinalizationProvider;
  }

  async #finalizeBuyer(readOnly = false): Promise<FinalizedBuyerBundle> {
    if (!this.#sellerFinalization || !this.#counterSignature) {
      throw new DacsError("authenticated seller finalization is unavailable");
    }
    return finalizeCompletedBuyerBundleCore(
      {
        sellerVerificationInput: this.#finalVerificationInput(),
        sellerFinalization: clone(this.#sellerFinalization),
        counterSignature: clone(this.#counterSignature),
        buyer: {
          primaryClaim: this.#input.buyer.primaryClaim,
          bundleHash: this.#input.buyer.bundleHash,
          signer: readOnly
            ? () => {
                throw new SubstrateError("terminal buyer verification cannot sign");
              }
            : async (bytes) =>
                Uint8Array.from(
                  Buffer.from(await this.#sign("bundle-binding", bytes), "base64url"),
                ),
        },
      },
      this.#coreProvider(readOnly),
    );
  }

  #bindingSignatureIntent(
    binding: Readonly<BundleBinding>,
  ): Record<string, CheckpointValue> {
    const messageHash = sha256Hex(
      signedBytes(
        BUNDLE_BINDING_SEPARATOR,
        contentHash(binding as unknown as Record<string, unknown>),
      ),
    );
    return this.#signatureIntent("bundle-binding", messageHash);
  }

  #verifyBindingSignatureOutcome(
    checkpoint: SessionCheckpoint | undefined,
    binding: Readonly<BundleBinding>,
  ): void {
    const intent = this.#bindingSignatureIntent(binding);
    if (
      binding.signer !== this.#input.buyer.primaryClaim ||
      binding.signature.signer !== this.#input.buyer.primaryClaim ||
      binding.signature.algorithm !== "ed25519" ||
      !isCanonicalBase64Url(binding.signature.value) ||
      Buffer.from(binding.signature.value, "base64url").byteLength !== 64 ||
      checkpoint?.stage !== "outcome" ||
      !dataMatches(checkpoint.data, {
        ...intent,
        signatureValue: binding.signature.value,
      })
    ) {
      throw new DacsError(
        "finalized buyer binding lacks its exact fenced signature outcome",
      );
    }
  }

  async #recordEffectOutcomes(result: FinalizedBuyerBundle): Promise<void> {
    if ((this.#provider.mapping === "write-input") !== (result.binding !== undefined)) {
      throw new DacsError("finalized buyer result contradicts the retained mapping");
    }
    const anchorIntent = this.#anchorIntent(
      result.logicalAddress,
      result.bundleContentHash,
    );
    const anchor = await this.#claim(
      buyerBundleFinalizationCheckpointKey.anchor,
      anchorIntent,
      "buyer:bundle-anchor-pending",
    );
    const anchorOutcome = { ...anchorIntent, nativeAddress: result.nativeAddress };
    if (anchor.state === "outcome") {
      if (!dataMatches(anchor.data, anchorOutcome)) {
        throw new DacsError("finalized buyer anchor contradicts its durable outcome");
      }
    } else {
      await this.#appendOutcome(
        buyerBundleFinalizationCheckpointKey.anchor,
        anchorIntent,
        anchorOutcome,
        "buyer:bundle-anchor-pending",
      );
    }

    if (result.binding) {
      const signatureCheckpoint = latestCheckpoint(
        (await this.#load()).checkpoints,
        buyerBundleFinalizationCheckpointKey.bindingSignature,
      );
      this.#verifyBindingSignatureOutcome(signatureCheckpoint, result.binding);
      const bindingIntent = this.#bindingIntent(result.binding);
      const publication = await this.#claim(
        buyerBundleFinalizationCheckpointKey.bindingPublication,
        bindingIntent,
        "buyer:bundle-binding-publication-pending",
      );
      const publicationOutcome = { ...bindingIntent, applicable: true };
      if (publication.state === "outcome") {
        if (!dataMatches(publication.data, publicationOutcome)) {
          throw new DacsError("finalized buyer binding publication is rebound");
        }
      } else {
        await this.#appendOutcome(
          buyerBundleFinalizationCheckpointKey.bindingPublication,
          bindingIntent,
          publicationOutcome,
          "buyer:bundle-binding-publication-pending",
        );
      }
    } else {
      const data = {
        ...this.#fullAuthority(),
        mapping: "pure",
        logicalAddress: result.logicalAddress,
        bundleContentHash: result.bundleContentHash,
      };
      await this.#ensureOutcome(
        buyerBundleFinalizationCheckpointKey.bindingPublication,
        { ...data, applicable: false },
        "buyer:bundle-anchor-pending",
      );
      const signatureCheckpoint = latestCheckpoint(
        (await this.#load()).checkpoints,
        buyerBundleFinalizationCheckpointKey.bindingSignature,
      );
      if (signatureCheckpoint) {
        throw new DacsError("pure buyer finalization carries a binding signature checkpoint");
      }
    }
  }

  #withRolePublications(
    result: FinalizedBuyerBundle,
  ): DurableFinalizedBuyerBundle {
    if (!this.#sellerFinalization) {
      throw new DacsError("authenticated seller publication is unavailable");
    }
    const seller = this.#sellerFinalization;
    return immutable({
      ...result,
      publications: {
        buyer: {
          role: "buyer" as const,
          logicalAddress: result.logicalAddress,
          nativeAddress: result.nativeAddress,
          bundleContentHash: result.bundleContentHash,
          anchorReceipt: clone(result.anchorReceipt),
          ...(result.anchorTx === undefined ? {} : { anchorTx: result.anchorTx }),
          ...(result.binding === undefined ? {} : { binding: clone(result.binding) }),
        },
        seller: {
          role: "seller" as const,
          logicalAddress: seller.logicalAddress,
          nativeAddress: seller.nativeAddress,
          bundleContentHash: seller.bundleContentHash,
          anchorReceipt: clone(seller.anchorReceipt),
          ...(seller.anchorTx === undefined ? {} : { anchorTx: seller.anchorTx }),
          ...(seller.binding === undefined ? {} : { binding: clone(seller.binding) }),
        },
      },
    });
  }

  #completion(): DurableBuyerSessionCompletion {
    if (!this.#sellerFinalization) {
      throw new DacsError("authenticated seller completion is unavailable");
    }
    return immutable({
      sellerClosure: {
        verificationInput: this.#finalVerificationInput(),
        result: clone(this.#sellerFinalization),
      },
    });
  }

  #resultData(result: DurableFinalizedBuyerBundle): Record<string, CheckpointValue> {
    const encoded = encodeCanonical(result, "terminal buyer bundle result");
    return {
      ...this.#fullAuthority(),
      sellerResultIdentityHash: String(
        this.#sellerResultData(this.#sellerFinalization!).sellerResultIdentityHash,
      ),
      mapping: this.#provider.mapping,
      logicalAddress: result.logicalAddress,
      nativeAddress: result.nativeAddress,
      bundleContentHash: result.bundleContentHash,
      result: encoded.encoded,
      resultHash: encoded.hash,
    };
  }

  async #finish(result: DurableFinalizedBuyerBundle): Promise<void> {
    await this.#recordEffectOutcomes(result);
    const resultData = this.#resultData(result);
    const resultIntent = withoutKeys(resultData, ["result", "resultHash"]);
    const claim = await this.#claim(
      buyerBundleFinalizationCheckpointKey.result,
      resultIntent,
      result.binding
        ? "buyer:bundle-binding-publication-pending"
        : "buyer:bundle-anchor-pending",
    );
    if (claim.state === "outcome") {
      throw new DacsError("non-terminal buyer state already carries a terminal result");
    }
    if (!dataMatches(claim.data, resultIntent)) {
      throw new DacsError("terminal buyer result intent is rebound");
    }
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      await this.#renew();
      const record = await this.#load();
      const prior = latestCheckpoint(
        record.checkpoints,
        buyerBundleFinalizationCheckpointKey.result,
      );
      if (prior?.stage !== "intent" || !dataMatches(prior.data, resultIntent)) {
        throw new DacsError("terminal buyer result intent disappeared or changed");
      }
      const receipt = record.receipts.find(
        (value) => sessionReceiptKey(value) === "bundle",
      );
      if (receipt) {
        throw new DacsError("non-terminal buyer state already carries a bundle receipt");
      }
      const transitioned = await this.#durability.store.transition({
        jobId: this.#jobId(),
        expectedRevision: record.revision,
        leaseToken: this.#lease,
        checkpoint: {
          key: buyerBundleFinalizationCheckpointKey.result,
          stage: "outcome",
          data: resultData,
        },
        receipt: { kind: "bundle", ref: result.nativeAddress },
        phase: "buyer:finalised",
        lease: null,
        now: this.#now(),
      });
      if (transitioned.ok) {
        this.#lease = undefined;
        return;
      }
      if (transitioned.reason === "terminal-state") {
        throw new ProgressSignal(
          "indeterminate",
          "terminal-recovery",
          "buyer state became terminal concurrently; authenticate it on retry",
        );
      }
      if (transitioned.reason !== "revision-mismatch") {
        throw new SubstrateError(`terminal buyer result failed: ${transitioned.reason}`);
      }
    }
    throw new SubstrateError("terminal buyer result exceeded CAS retry limit");
  }

  async #recoverTerminal(record: SessionRecord): Promise<DurableFinalizedBuyerBundle> {
    if (record.lease) throw new DacsError("terminal buyer state retains a lease");
    if (!this.#hasExactSettlementCheckpoint(record)) {
      throw new DacsError("terminal buyer state lacks settlement cross-check outcome");
    }
    const requestCheckpoint = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.request,
    );
    if (requestCheckpoint?.stage !== "outcome" || !requestCheckpoint.data) {
      throw new DacsError("terminal buyer state lacks authenticated request outcome");
    }
    const request = decodeRequest(
      requestCheckpoint.data.request,
      requestCheckpoint.data.requestHash,
    );
    const authenticatedRequest = await verifyCompletedSellerBundleCounterSignatureRequest(
      clone(this.#input.sellerVerificationInput),
      request,
      this.#readProvider(),
    );
    const encodedRequest = encodeRequest(authenticatedRequest);
    this.#request = authenticatedRequest;
    this.#requestData = {
      requestHash: encodedRequest.hash,
      requestMessageHash: encodedRequest.messageHash,
      requestBundleContentHash: authenticatedRequest.bundleContentHash,
      request: encodedRequest.encoded,
      requiredCounterSignersHash: sha256Hex(
        canonicalize(authenticatedRequest.requiredCounterSigners),
      ),
    };
    if (
      authenticatedRequest.requiredCounterSigners.filter(
        (signer) => signer === this.#input.buyer.primaryClaim,
      ).length !== 1 ||
      !dataMatches(requestCheckpoint.data, this.#fullAuthority())
    ) {
      throw new DacsError("terminal buyer request contradicts recovery authority");
    }
    const signatureCheckpoint = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.counterSignature,
    );
    const signatureValue = signatureCheckpoint?.data?.signatureValue;
    const counterSignatureIntent = this.#signatureIntent(
      "counter-signature",
      encodedRequest.messageHash,
    );
    if (
      signatureCheckpoint?.stage !== "outcome" ||
      !isCanonicalBase64Url(signatureValue) ||
      Buffer.from(String(signatureValue), "base64url").byteLength !== 64 ||
      !dataMatches(signatureCheckpoint.data, {
        ...counterSignatureIntent,
        signatureValue: String(signatureValue),
      })
    ) {
      throw new DacsError("terminal buyer state lacks counter-signature outcome");
    }
    this.#counterSignature = {
      party: this.#input.buyer.primaryClaim,
      algorithm: "ed25519",
      value: String(signatureValue),
    };
    const publication = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.counterSignaturePublication,
    );
    const publicationOutcome = {
      ...this.#counterPublicationIntent(),
      published: true,
    };
    if (
      publication?.stage !== "outcome" ||
      !dataMatches(publication.data, publicationOutcome)
    ) {
      throw new DacsError("terminal buyer state lacks publication outcome");
    }
    const signatureSetCheckpoint = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.counterSignatureSet,
    );
    if (signatureSetCheckpoint?.stage !== "outcome" || !signatureSetCheckpoint.data) {
      throw new DacsError("terminal buyer state lacks counter-signature set outcome");
    }
    const counterSignatures = await this.#authenticateCounterSignatureSet(
      decodeCounterSignatureSet(
        signatureSetCheckpoint.data.counterSignatureSet,
        signatureSetCheckpoint.data.counterSignatureSetHash,
      ),
    );
    const expectedSignatureSet = this.#counterSignatureSetData(counterSignatures);
    if (!dataMatches(signatureSetCheckpoint.data, expectedSignatureSet)) {
      throw new DacsError("terminal counter-signature set is malformed or rebound");
    }
    this.#counterSignatures = counterSignatures;
    const sellerCheckpoint = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.sellerFinalization,
    );
    if (sellerCheckpoint?.stage !== "outcome" || !sellerCheckpoint.data) {
      throw new DacsError("terminal buyer state lacks seller finalization outcome");
    }
    const sellerCandidate = decodeCanonical(
      sellerCheckpoint.data.sellerResult,
      sellerCheckpoint.data.sellerResultHash,
      "terminal seller finalization",
    );
    this.#sellerFinalization = await this.#authenticateSellerFinalization(sellerCandidate);
    const expectedSellerData = this.#sellerResultData(this.#sellerFinalization);
    if (!dataMatches(sellerCheckpoint.data, expectedSellerData)) {
      throw new DacsError("terminal seller finalization checkpoint is rebound");
    }
    const resultCheckpoint = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.result,
    );
    if (resultCheckpoint?.stage !== "outcome" || !resultCheckpoint.data) {
      throw new DacsError("terminal buyer state lacks exact result outcome");
    }
    const decoded = decodeCanonical(
      resultCheckpoint.data.result,
      resultCheckpoint.data.resultHash,
      "terminal buyer bundle result",
    );
    if (!isRecord(decoded)) throw new DacsError("terminal buyer result is malformed");
    const persisted = decoded as unknown as DurableFinalizedBuyerBundle;
    const receipt = record.receipts.find(
      (value) => sessionReceiptKey(value) === "bundle",
    );
    if (
      persisted.state !== "finalised" ||
      !isFaultAttestationBundle(persisted.buyerBundle) ||
      persisted.buyerBundle.anchoredByRole !== "buyer" ||
      persisted.buyerBundle.jobId !== this.#jobId() ||
      !isAnchorReceipt(persisted.anchorReceipt) ||
      persisted.anchorReceipt.state !== "finalized" ||
      persisted.anchorReceipt.observationDisposition !== "established" ||
      persisted.logicalAddress !== persisted.anchorReceipt.logicalAddress ||
      persisted.nativeAddress !== persisted.anchorReceipt.nativeAddress ||
      persisted.bundleContentHash !== attestationBundleHash(persisted.buyerBundle) ||
      receipt?.ref !== persisted.nativeAddress ||
      (persisted.binding !== undefined &&
        (!isBundleBinding(persisted.binding) || persisted.binding.role !== "buyer"))
    ) {
      throw new DacsError("terminal buyer result is malformed or rebound");
    }
    const expectedResultData = this.#resultData(persisted);
    if (!dataMatches(resultCheckpoint.data, expectedResultData)) {
      throw new DacsError("terminal buyer result contradicts durable authority");
    }
    if ((this.#provider.mapping === "write-input") !== (persisted.binding !== undefined)) {
      throw new DacsError("terminal buyer result contradicts the retained mapping");
    }
    const anchor = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.anchor,
    );
    const anchorIntent = this.#anchorIntent(
      persisted.logicalAddress,
      persisted.bundleContentHash,
    );
    if (
      anchor?.stage !== "outcome" ||
      !dataMatches(anchor.data, {
        ...anchorIntent,
        nativeAddress: persisted.nativeAddress,
      })
    ) {
      throw new DacsError("terminal buyer result lacks its exact anchor outcome");
    }
    const bindingSignature = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.bindingSignature,
    );
    const bindingPublication = latestCheckpoint(
      record.checkpoints,
      buyerBundleFinalizationCheckpointKey.bindingPublication,
    );
    if (persisted.binding) {
      this.#verifyBindingSignatureOutcome(bindingSignature, persisted.binding);
      const bindingIntent = this.#bindingIntent(persisted.binding);
      if (
        bindingPublication?.stage !== "outcome" ||
        !dataMatches(bindingPublication.data, {
          ...bindingIntent,
          applicable: true,
        })
      ) {
        throw new DacsError(
          "terminal buyer result lacks its exact binding publication outcome",
        );
      }
    } else {
      if (bindingSignature) {
        throw new DacsError("pure terminal buyer result carries a binding signature");
      }
      const purePublication = {
        ...this.#fullAuthority(),
        mapping: "pure",
        logicalAddress: persisted.logicalAddress,
        bundleContentHash: persisted.bundleContentHash,
        applicable: false,
      };
      if (
        bindingPublication?.stage !== "outcome" ||
        !dataMatches(bindingPublication.data, purePublication)
      ) {
        throw new DacsError(
          "terminal buyer result lacks its pure-mapping publication outcome",
        );
      }
    }
    const authenticated = this.#withRolePublications(await this.#finalizeBuyer(true));
    if (!exact(authenticated, persisted)) {
      throw new DacsError("terminal buyer publication differs from authenticated readback");
    }
    return immutable(authenticated);
  }

  async run(): Promise<DurableBuyerBundleFinalizationProgress> {
    let record = await this.#load();
    const hasRetainedBuyerState =
      record.phase === "buyer:finalised" ||
      BUYER_PHASE_RANK.has(record.phase) ||
      record.checkpoints.some((checkpoint) => checkpoint.key.startsWith("buyer:"));
    await this.#verifySettlement(hasRetainedBuyerState ? "recovery" : "initial");
    if (record.agreementHash !== this.#agreementHash()) {
      throw new DacsError("durable buyer session agreement hash is missing or rebound");
    }
    if (record.phase === "buyer:finalised") {
      try {
        const result = await this.#recoverTerminal(record);
        return {
          disposition: "finalised",
          result,
          completion: this.#completion(),
          recovered: true,
        };
      } catch (error) {
        if (error instanceof SubstrateError) {
          return {
            disposition: "indeterminate",
            stage: "terminal-recovery",
            reason: error.message,
          };
        }
        throw error;
      }
    }
    await this.#acquire();
    record = await this.#load();
    await this.#resolveRequest(record);
    await this.#createCounterSignature();
    await this.#publishCounterSignature();
    await this.#resolveCounterSignatureSet(await this.#load());
    await this.#resolveSellerFinalization(await this.#load());
    let coreResult: FinalizedBuyerBundle;
    try {
      coreResult = await this.#finalizeBuyer(false);
    } catch (error) {
      if (error instanceof ProgressSignal) throw error;
      if (error instanceof SubstrateError) {
        throw new ProgressSignal(
          "indeterminate",
          this.#buyerPublicationStage(await this.#load()),
          error.message,
        );
      }
      throw error;
    }
    try {
      const result = this.#withRolePublications(coreResult);
      await this.#finish(result);
      return {
        disposition: "finalised",
        result: immutable(result),
        completion: this.#completion(),
        recovered: false,
      };
    } catch (error) {
      if (error instanceof ProgressSignal) throw error;
      if (error instanceof SubstrateError) {
        throw new ProgressSignal(
          "indeterminate",
          "terminal-recovery",
          error.message,
        );
      }
      throw error;
    }
  }

  async release(): Promise<void> {
    await this.#release();
  }
}

export async function getBuyerBundleFinalizationStatus(
  store: FencedSessionStoreV2,
  jobId: string,
): Promise<BuyerBundleFinalizationStatusLoad> {
  const loaded = await store.load(jobId);
  if (loaded.status !== "ok") return loaded;
  const checkpoints = Object.fromEntries(
    Object.entries(buyerBundleFinalizationCheckpointKey).map(([name, key]) => [
      name,
      latestCheckpoint(loaded.record.checkpoints, key)?.stage ?? "not-started",
    ]),
  ) as Record<
    keyof typeof buyerBundleFinalizationCheckpointKey,
    BuyerBundleCheckpointState
  >;
  const receipt = loaded.record.receipts.find(
    (value) => sessionReceiptKey(value) === "bundle",
  );
  return {
    status: "ok",
    jobId: loaded.record.jobId,
    phase: loaded.record.phase,
    revision: loaded.record.revision,
    ...(loaded.record.lease
      ? {
          lease: {
            owner: loaded.record.lease.owner,
            generation: loaded.record.lease.generation,
            expiresAt: loaded.record.lease.expiresAt,
          },
        }
      : {}),
    checkpoints,
    ...(receipt ? { bundleReceipt: receipt.ref } : {}),
    updatedAt: loaded.record.updatedAt,
  };
}

/**
 * Advance the two-stage buyer protocol by as much as authenticated transport
 * state permits. Waiting/indeterminate results retain WAL state and release the
 * exact lease; the next invocation receives a higher generation.
 */
export async function advanceCompletedBuyerBundleDurable(
  input: DurableBuyerBundleFinalizationInput,
  provider: DurableBuyerBundleFinalizationProvider,
  durability: BuyerBundleFinalizationDurability,
): Promise<DurableBuyerBundleFinalizationProgress> {
  const coordinator = new DurableBuyerCoordinator(
    captureInput(input),
    captureProvider(provider),
    captureDurability(durability),
  );
  try {
    return await coordinator.run();
  } catch (error) {
    await coordinator.release();
    const progress = retainedProgressSignal(error);
    if (progress) return progress.progress;
    if (error instanceof SubstrateError) {
      return {
        disposition: "indeterminate",
        stage: "lease",
        reason: error.message,
      };
    }
    throw error;
  }
}
