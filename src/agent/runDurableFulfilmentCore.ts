import { canonicalize, sha256Hex } from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import type { AnchorReceipt } from "../artifacts/types.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import {
  isAnchorReceipt,
  isAttestationRef,
  isSettlementEvidence,
} from "../artifacts/validators.js";
import { isComponentSignature } from "../artifacts/signatures.js";
import {
  isSellerFulfilmentHandoff,
  isValidSellerReceiptClaim,
  type SellerFulfilmentHandoff,
  type SellerPaymentAuthorization,
  type SellerReceiptClaim,
  type SellerReceiptInspectionResult,
  type SellerReceiptPermitResult,
} from "../seller/paymentIntake.js";
import {
  runFulfilmentCore,
  sellerFulfilmentId,
  type SellerAttestationRef,
  type SellerDeliveryReconciliation,
  type SellerDeliverySubmission,
  type SellerEvidenceAnchorResult,
  type SellerFulfilmentDeps,
  type SellerFulfilmentResolution,
  type SellerFulfilmentRequest,
  type SellerFulfilmentResult,
  type SellerResolvedDelivery,
  type SellerResolvedPayloadAttestation,
} from "./runFulfilmentCore.js";
import {
  FENCED_SESSION_STORE_VERSION,
  sessionPhaseMutationFailure,
  sessionReceiptKey,
  sessionRecordShapeViolation,
  type CheckpointValue,
  type SessionLeaseToken,
  type SessionPaymentAuthorizationBinding,
  type SessionRecord,
  type SessionReceipt,
  type FencedSessionStoreV2,
} from "./fencedSessionStore.js";

type PayloadAnchor = NonNullable<SellerFulfilmentDeps["anchorPayloadAttestation"]>;
type PayloadAnchorInput = Parameters<PayloadAnchor>[0];
type DeliverySubmitInput = Parameters<SellerFulfilmentDeps["submitDelivery"]>[0];
type DeliveryReconciliationInput = Parameters<
  SellerFulfilmentDeps["reconcileDelivery"]
>[0];
type EvidenceAnchorInput = Parameters<SellerFulfilmentDeps["anchorEvidence"]>[0];
type PayloadReadback = Awaited<ReturnType<
  NonNullable<SellerFulfilmentDeps["resolvePayloadAttestation"]>
>>;
type DeliveryReadback = Awaited<ReturnType<SellerFulfilmentDeps["resolveDelivery"]>>;
type EvidenceReadback = Awaited<ReturnType<SellerFulfilmentDeps["resolveEvidence"]>>;
type TerminalFulfilmentResult = Extract<
  SellerFulfilmentResult,
  { decision: "completed" | "failed" }
>;

/** Monotonic authority delivered to every irreversible application adapter. */
export interface SellerEffectFence extends SessionLeaseToken {
  /** Stable across restarts and lease generations. */
  idempotencyKey: string;
}

type Fenced<T> = T & { fence: Readonly<SellerEffectFence> };

/**
 * The #120 dependency surface with explicit owner+generation fencing on every
 * irreversible callback. Reversible resolvers and verifiers retain their #120
 * signatures.
 */
export type DurableSellerFulfilmentDeps = Omit<
  SellerFulfilmentDeps,
  "submitDelivery" | "anchorPayloadAttestation" | "anchorEvidence"
> & {
  submitDelivery(input: Fenced<DeliverySubmitInput>): Promise<SellerDeliverySubmission>;
  anchorPayloadAttestation?: (
    input: Fenced<PayloadAnchorInput>,
  ) => Promise<SellerEvidenceAnchorResult>;
  anchorEvidence(input: Fenced<EvidenceAnchorInput>): Promise<SellerEvidenceAnchorResult>;
};

export type SellerFinalSessionReceiptResult =
  | { status: "recorded"; receipt: unknown }
  | { status: "rejected" | "indeterminate"; reason: string };

export interface SellerFinalSessionReceiptInput {
  fulfilmentId: string;
  authorizationBinding: SessionPaymentAuthorizationBinding;
  resultHash: string;
  result: Readonly<TerminalFulfilmentResult>;
}

/**
 * An authoritative idempotency-key read proving that an intent never committed
 * at the application boundary. The reconciler must atomically register the
 * supplied owner+generation as the minimum accepted fence before returning this
 * result, so an older in-flight generation cannot commit after the observation.
 * Only this result permits the new generation to invoke the exact retained input.
 */
export interface SellerEffectAuthoritativeAbsence {
  status: "absent";
  reason: string;
}

/** Recovery/readback adapters for WAL intents whose first response was lost. */
export interface SellerFulfilmentDurability {
  store: FencedSessionStoreV2;
  workerId: string;
  leaseTtlMs: number;
  /** Wall clock used only for leases and durable operational observations. */
  leaseNowMs?: () => number;
  reconcilePayloadAttestation(
    input: Fenced<PayloadAnchorInput>,
  ): Promise<SellerEvidenceAnchorResult | SellerEffectAuthoritativeAbsence>;
  reconcileDeliverySubmission(
    input: Fenced<DeliverySubmitInput>,
  ): Promise<SellerDeliverySubmission | SellerEffectAuthoritativeAbsence>;
  reconcileEvidencePublication(
    input: Fenced<EvidenceAnchorInput>,
  ): Promise<SellerEvidenceAnchorResult | SellerEffectAuthoritativeAbsence>;
  publishFinalSessionReceipt(
    input: Fenced<SellerFinalSessionReceiptInput>,
  ): Promise<SellerFinalSessionReceiptResult>;
  reconcileFinalSessionReceipt(
    input: Fenced<SellerFinalSessionReceiptInput>,
  ): Promise<SellerFinalSessionReceiptResult | SellerEffectAuthoritativeAbsence>;
}

export const sellerFulfilmentCheckpointKey = {
  handoff: (phaseIndex: number) => `seller:handoff:${phaseIndex}`,
  payloadPublication: (phaseIndex: number) => `seller:payload-publication:${phaseIndex}`,
  payloadReadback: (phaseIndex: number) => `seller:payload-readback:${phaseIndex}`,
  delivery: (phaseIndex: number) => `seller:delivery:${phaseIndex}`,
  deliveryReconciliation: (phaseIndex: number) =>
    `seller:delivery-reconciliation:${phaseIndex}`,
  deliveryReadback: (phaseIndex: number) => `seller:delivery-readback:${phaseIndex}`,
  dpaTerminalFailure: (phaseIndex: number) => `seller:dpa-terminal-failure:${phaseIndex}`,
  terminalFailureSource: (phaseIndex: number) =>
    `seller:terminal-failure-source:${phaseIndex}`,
  evidencePublication: (phaseIndex: number) => `seller:evidence-publication:${phaseIndex}`,
  evidenceReadback: (phaseIndex: number) => `seller:evidence-readback:${phaseIndex}`,
  finalReceipt: (phaseIndex: number) => `seller:final-receipt:${phaseIndex}`,
  result: (phaseIndex: number) => `seller:result:${phaseIndex}`,
} as const;

export type SellerFulfilmentCheckpointState = "not-started" | "intent" | "outcome";

export type SellerFulfilmentStatusLoad =
  | { status: "missing" }
  | { status: "corrupt"; reason: string }
  | { status: "unsupported"; version: number }
  | {
      status: "ok";
      jobId: string;
      phase: string;
      revision: number;
      lease?: { owner: string; generation: number; expiresAt: number };
      delivery: SellerFulfilmentCheckpointState;
      evidence: SellerFulfilmentCheckpointState;
      receipts: Record<string, string>;
      updatedAt: number;
    };

/** Read-only cryptographic dependencies for authenticating a persisted terminal result. */
export interface VerifyDurableSellerTerminalResultInput {
  record: unknown;
  suppliedResult: Extract<SellerFulfilmentResult, { decision: "completed" }>;
  verifyEvidenceSignature: SellerFulfilmentDeps["verifyEvidenceSignature"];
  verifyAnchorReceipt: SellerFulfilmentDeps["verifyAnchorReceipt"];
}

/** Cryptographic verification seam held by a durable bundle coordinator. */
export type DurableSellerTerminalVerification = Pick<
  VerifyDurableSellerTerminalResultInput,
  "verifyEvidenceSignature" | "verifyAnchorReceipt"
>;

/** Exact authority and hashes recovered from a fully authenticated durable completion. */
export interface VerifiedDurableSellerTerminalResult {
  result: Extract<SellerFulfilmentResult, { decision: "completed" }>;
  binding: SessionPaymentAuthorizationBinding;
  handoff: SellerFulfilmentHandoff;
  resultHash: string;
  finalReceiptHash: string;
}

interface ConsumedAuthority {
  claim: SellerReceiptClaim;
  handoff: SellerFulfilmentHandoff;
  handoffEncoded: string;
  binding: SessionPaymentAuthorizationBinding;
}

type DurableNode =
  | { t: "null" }
  | { t: "undefined" }
  | { t: "boolean"; v: boolean }
  | { t: "number"; v: number }
  | { t: "negative-zero" }
  | { t: "string"; v: string }
  | { t: "bytes"; v: string }
  | { t: "array"; v: DurableNode[] }
  | { t: "object"; v: Array<[string, DurableNode]> };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isSafeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  !Object.is(value, -0);
const clone = <T>(value: T): T => structuredClone(value);

function hasExactJcsView(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" ||
      typeof value === "bigint") return false;
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index) ||
          !hasExactJcsView(value[index], seen)) return false;
    }
    return true;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor) ||
        !hasExactJcsView(descriptor.value, seen)) return false;
  }
  return true;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function isDeliverySubmission(value: unknown): value is SellerDeliverySubmission {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "accepted") {
    return hasExactKeys(value, ["status", "reconciliationId"]) &&
      isNonEmpty(value.reconciliationId);
  }
  if (value.status === "rejected") {
    return hasExactKeys(value, ["status", "reason"]) && isNonEmpty(value.reason);
  }
  return value.status === "indeterminate" &&
    hasExactKeys(value, [
      "status",
      "reason",
      ...(value.reconciliationId === undefined ? [] : ["reconciliationId"]),
    ]) &&
    isNonEmpty(value.reason) &&
    (value.reconciliationId === undefined || isNonEmpty(value.reconciliationId));
}

function isDeliveryReconciliation(value: unknown): value is SellerDeliveryReconciliation {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "complete") {
    return hasExactKeys(value, ["status", "reconciliationId", "observedAt"]) &&
      isNonEmpty(value.reconciliationId) && isSafeUint(value.observedAt);
  }
  if (value.status === "failed") {
    return hasExactKeys(value, [
      "status",
      "reason",
      "observedAt",
      ...(value.reconciliationId === undefined ? [] : ["reconciliationId"]),
    ]) && isNonEmpty(value.reason) && isSafeUint(value.observedAt) &&
      (value.reconciliationId === undefined || isNonEmpty(value.reconciliationId));
  }
  if (value.status === "pending" || value.status === "indeterminate") {
    return hasExactKeys(value, [
      "status",
      "reason",
      ...(value.reconciliationId === undefined ? [] : ["reconciliationId"]),
    ]) && isNonEmpty(value.reason) &&
      (value.reconciliationId === undefined || isNonEmpty(value.reconciliationId));
  }
  return value.status === "absent" && hasExactKeys(value, ["status", "reason"]) &&
    isNonEmpty(value.reason);
}

function isEvidenceAnchorResult(value: unknown): value is SellerEvidenceAnchorResult {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "anchored") {
    return hasExactKeys(value, ["status", "ref", "anchorReceipt"]) &&
      isAttestationRef(value.ref) && isAnchorReceipt(value.anchorReceipt);
  }
  return (value.status === "rejected" || value.status === "indeterminate") &&
    hasExactKeys(value, ["status", "reason"]) && isNonEmpty(value.reason);
}

function hasDefinitiveAnchorBinding(
  value: Extract<SellerEvidenceAnchorResult, { status: "anchored" }>,
  expectedHash: string,
  expectedWriter: string,
): boolean {
  return value.ref.anchor.kind === "storage-program" &&
    value.ref.contentHash === expectedHash &&
    (value.ref.signer === undefined || value.ref.signer === expectedWriter) &&
    value.anchorReceipt.logicalAddress === value.ref.anchor.locator &&
    value.anchorReceipt.contentHash === expectedHash &&
    value.anchorReceipt.writer === expectedWriter &&
    value.anchorReceipt.observationDisposition === "established" &&
    (value.anchorReceipt.state === "included" ||
      value.anchorReceipt.state === "finalized");
}

function isDefinitivePayloadAnchorResult(
  value: unknown,
  input: Readonly<PayloadAnchorInput>,
): value is SellerEvidenceAnchorResult {
  if (!isEvidenceAnchorResult(value)) return false;
  if (value.status !== "anchored") return true;
  const signature = input.record.signature;
  return isComponentSignature(signature) &&
    exact(value.ref, input.ref) &&
    input.ref.contentHash === input.recordHash &&
    signedEvidenceHash(input.record) === input.recordHash &&
    hasDefinitiveAnchorBinding(value, input.recordHash, signature.signer);
}

function isDefinitiveEvidenceAnchorResult(
  value: unknown,
  input: Readonly<EvidenceAnchorInput>,
): value is SellerEvidenceAnchorResult {
  if (!isEvidenceAnchorResult(value)) return false;
  if (value.status !== "anchored") return true;
  if (!isSettlementEvidence(input.evidence) ||
      signedEvidenceHash(input.evidence) !== input.evidenceHash) {
    return false;
  }
  return hasDefinitiveAnchorBinding(
    value,
    input.evidenceHash,
    input.evidence.signature.signer,
  );
}

function isFinalSessionReceiptResult(
  value: unknown,
): value is SellerFinalSessionReceiptResult {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "recorded") {
    if (!hasExactKeys(value, ["status", "receipt"])) return false;
    try {
      encodeDurable(value.receipt);
      return true;
    } catch {
      return false;
    }
  }
  return (value.status === "rejected" || value.status === "indeterminate") &&
    hasExactKeys(value, ["status", "reason"]) && isNonEmpty(value.reason);
}

function isVerificationResult(value: unknown): value is
  | { disposition: "valid" }
  | { disposition: "invalid" | "indeterminate" | "error"; reason: string } {
  if (!isRecord(value) || typeof value.disposition !== "string") return false;
  return value.disposition === "valid"
    ? hasExactKeys(value, ["disposition"])
    : ["invalid", "indeterminate", "error"].includes(value.disposition) &&
      hasExactKeys(value, ["disposition", "reason"]) && isNonEmpty(value.reason);
}

function isAuthoritativeAbsence(value: unknown): value is SellerEffectAuthoritativeAbsence {
  return isRecord(value) && value.status === "absent" &&
    hasExactKeys(value, ["status", "reason"]) && isNonEmpty(value.reason);
}

function isFulfilmentResolution<T>(
  value: unknown,
  validateVerified: (candidate: unknown) => candidate is T,
): value is SellerFulfilmentResolution<T> {
  if (!isRecord(value) || typeof value.status !== "string") return false;
  if (value.status === "verified") {
    return hasExactKeys(value, ["status", "value"]) && validateVerified(value.value);
  }
  return (value.status === "rejected" || value.status === "indeterminate") &&
    hasExactKeys(value, ["status", "reason"]) && isNonEmpty(value.reason);
}

function isEstablishedIncludedReceipt(
  value: unknown,
  logicalAddress: string,
  contentHash?: string,
): value is AnchorReceipt {
  return isAnchorReceipt(value) && value.logicalAddress === logicalAddress &&
    (contentHash === undefined || value.contentHash === contentHash) &&
    value.observationDisposition === "established" &&
    (value.state === "included" || value.state === "finalized");
}

function isPayloadReadback(
  value: unknown,
  ref: Readonly<SellerAttestationRef>,
): value is PayloadReadback {
  return isFulfilmentResolution(value, (candidate): candidate is SellerResolvedPayloadAttestation =>
    isRecord(candidate) && hasExactKeys(candidate, ["record", "anchorReceipt"]) &&
    isRecord(candidate.record) &&
    isEstablishedIncludedReceipt(
      candidate.anchorReceipt,
      ref.anchor.locator,
      ref.contentHash,
    )
  );
}

function isDeliveryReadback(
  value: unknown,
  logicalAddress: string,
): value is DeliveryReadback {
  return isFulfilmentResolution(value, (candidate): candidate is SellerResolvedDelivery =>
    isRecord(candidate) && hasExactKeys(candidate, ["artifact", "anchorReceipt"]) &&
    isRecord(candidate.artifact) &&
    isEstablishedIncludedReceipt(candidate.anchorReceipt, logicalAddress)
  );
}

function isEvidenceReadback(
  value: unknown,
  ref: Readonly<SellerAttestationRef>,
): value is EvidenceReadback {
  return isFulfilmentResolution(value, (candidate): candidate is unknown =>
    isRecord(candidate) && isComponentSignature(candidate.signature) &&
    signedEvidenceHash(candidate) === ref.contentHash &&
    (ref.signer === undefined || candidate.signature.signer === ref.signer)
  );
}

function signedEvidenceHash(value: unknown): string | null {
  if (!isRecord(value) || !hasExactJcsView(value) ||
      !isComponentSignature(value.signature)) return null;
  const { signature: _signature, ...unsigned } = value;
  try {
    return sha256Hex(canonicalize(unsigned));
  } catch {
    return null;
  }
}

function retainedDeliverableBinding(
  handoff: SellerFulfilmentHandoff,
): { contentHash: string; attestationRef?: SellerAttestationRef } | null {
  if (handoff.candidate.status !== "prepared" ||
      !isRecord(handoff.candidate.delivery.artifact)) {
    return null;
  }
  const artifact = handoff.candidate.delivery.artifact;
  try {
    if (handoff.phase === "deliver-storage-program" &&
        artifact.kind === "deliver-storage-program") {
      return { contentHash: sha256Hex(canonicalize(artifact.cleartextPayload)) };
    }
    if (handoff.phase === "deliver-entitlement" &&
        artifact.kind === "deliver-entitlement") {
      const contentHash = signedEvidenceHash(artifact.cleartextPayload);
      return contentHash ? { contentHash } : null;
    }
    if (handoff.phase === "deliver-attested-payload" &&
        artifact.kind === "deliver-attested-payload" &&
        artifact.cleartextBytes instanceof Uint8Array &&
        isAttestationRef(artifact.attestationRef)) {
      return {
        contentHash: sha256Hex(artifact.cleartextBytes),
        attestationRef: clone(artifact.attestationRef),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function retainedAnchoredContentHash(handoff: SellerFulfilmentHandoff): string | null {
  if (handoff.candidate.status !== "prepared" ||
      !isRecord(handoff.candidate.delivery.artifact)) return null;
  const artifact = handoff.candidate.delivery.artifact;
  try {
    if (handoff.phase === "deliver-storage-program" &&
        artifact.kind === "deliver-storage-program") {
      return sha256Hex(canonicalize(artifact.anchoredValue));
    }
    if (handoff.phase === "deliver-entitlement" &&
        artifact.kind === "deliver-entitlement") {
      return signedEvidenceHash(artifact.anchoredValue);
    }
    if (handoff.phase === "deliver-attested-payload" &&
        artifact.kind === "deliver-attested-payload" &&
        artifact.anchoredValue instanceof Uint8Array) {
      return sha256Hex(artifact.anchoredValue);
    }
  } catch {
    return null;
  }
  return null;
}

function toDurableNode(value: unknown, seen = new Set<object>(), depth = 0): DurableNode {
  if (depth > 96) throw new TypeError("durable value exceeds maximum nesting depth");
  if (value === null) return { t: "null" };
  if (value === undefined) return { t: "undefined" };
  if (typeof value === "boolean") return { t: "boolean", v: value };
  if (typeof value === "string") return { t: "string", v: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("durable numbers must be finite");
    }
    if (Object.is(value, -0)) return { t: "negative-zero" };
    return { t: "number", v: value };
  }
  if (value instanceof Uint8Array) {
    return { t: "bytes", v: Buffer.from(value).toString("base64url") };
  }
  if (typeof value !== "object") {
    throw new TypeError(`unsupported durable value type ${typeof value}`);
  }
  if (seen.has(value)) throw new TypeError("cyclic durable value");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const expectedKeys = new Set<string>(["length"]);
      const items: DurableNode[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        expectedKeys.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("durable arrays must be dense data-value arrays");
        }
        items.push(toDurableNode(descriptor.value, seen, depth + 1));
      }
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key)) ||
          ownKeys.length !== expectedKeys.size) {
        throw new TypeError("durable arrays cannot have holes or extra properties");
      }
      return {
        t: "array",
        v: items,
      };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("durable objects must be plain records");
    }
    return {
      t: "object",
      v: Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [
          key,
          toDurableNode((value as Record<string, unknown>)[key], seen, depth + 1),
        ]),
    };
  } finally {
    seen.delete(value);
  }
}

function encodeDurable(value: unknown): string {
  return Buffer.from(JSON.stringify(toDurableNode(value)), "utf8").toString("base64url");
}

function fromDurableNode(node: unknown, depth = 0): unknown {
  if (depth > 96 || !isRecord(node) || !isNonEmpty(node.t)) {
    throw new TypeError("malformed durable value");
  }
  switch (node.t) {
    case "null":
      if (!hasExactKeys(node, ["t"])) throw new TypeError("malformed durable null");
      return null;
    case "undefined":
      if (!hasExactKeys(node, ["t"])) throw new TypeError("malformed durable undefined");
      return undefined;
    case "boolean":
      if (!hasExactKeys(node, ["t", "v"]) || typeof node.v !== "boolean") {
        throw new TypeError("malformed durable boolean");
      }
      return node.v;
    case "number":
      if (!hasExactKeys(node, ["t", "v"]) || typeof node.v !== "number" ||
          !Number.isFinite(node.v) || Object.is(node.v, -0)) {
        throw new TypeError("malformed durable number");
      }
      return node.v;
    case "negative-zero":
      if (!hasExactKeys(node, ["t"])) {
        throw new TypeError("malformed durable negative zero");
      }
      return -0;
    case "string":
      if (!hasExactKeys(node, ["t", "v"]) || typeof node.v !== "string") {
        throw new TypeError("malformed durable string");
      }
      return node.v;
    case "bytes": {
      if (!hasExactKeys(node, ["t", "v"]) || typeof node.v !== "string" ||
          node.v.length % 4 === 1 ||
          !/^[A-Za-z0-9_-]*$/.test(node.v)) {
        throw new TypeError("malformed durable bytes");
      }
      const bytes = Buffer.from(node.v, "base64url");
      if (bytes.toString("base64url") !== node.v) {
        throw new TypeError("non-canonical durable bytes");
      }
      return Uint8Array.from(bytes);
    }
    case "array":
      if (!hasExactKeys(node, ["t", "v"]) || !Array.isArray(node.v)) {
        throw new TypeError("malformed durable array");
      }
      return node.v.map((item) => fromDurableNode(item, depth + 1));
    case "object": {
      if (!hasExactKeys(node, ["t", "v"]) || !Array.isArray(node.v)) {
        throw new TypeError("malformed durable object");
      }
      const result: Record<string, unknown> = {};
      const keys = new Set<string>();
      for (const entry of node.v) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" ||
            keys.has(entry[0])) {
          throw new TypeError("malformed durable object entry");
        }
        keys.add(entry[0]);
        Object.defineProperty(result, entry[0], {
          value: fromDurableNode(entry[1], depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }
    default:
      throw new TypeError("unknown durable value tag");
  }
}

function decodeDurable<T>(encoded: string): T {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new TypeError("malformed durable encoding");
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) {
    throw new TypeError("non-canonical durable encoding");
  }
  const decoded = fromDurableNode(JSON.parse(bytes.toString("utf8"))) as T;
  if (encodeDurable(decoded) !== encoded) {
    throw new TypeError("non-canonical durable value encoding");
  }
  return decoded;
}

function durableHash(encoded: string): string {
  return sha256Hex(Buffer.from(encoded, "utf8"));
}

function exact(left: unknown, right: unknown): boolean {
  try {
    return encodeDurable(left) === encodeDurable(right);
  } catch {
    return false;
  }
}

function isCanonicalSettlementId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^demos:[0-9a-f]{64}$/.test(value)) return true;
  const match = /^evm:([1-9][0-9]*):([0-9a-f]{64}):(0|[1-9][0-9]*)$/.exec(value);
  if (!match) return false;
  const chainId = Number(match[1]);
  const logIndex = Number(match[3]);
  return Number.isSafeInteger(chainId) && chainId > 0 &&
    Number.isSafeInteger(logIndex) && logIndex >= 0;
}

function deriveConsumedAuthority(
  claimValue: unknown,
  handoffValue: unknown,
): ConsumedAuthority {
  const claim = clone(claimValue);
  const handoff = clone(handoffValue);
  if (!isValidSellerReceiptClaim(claim) || !isSellerFulfilmentHandoff(handoff)) {
    throw new TypeError("receipt store returned malformed consumed authority");
  }
  const authorization = claim.authorization;
  const authorizationHash = sha256Hex(canonicalize(authorization));
  const expectedFulfilmentId = sellerFulfilmentId({
    jobId: authorization.jobId,
    paymentPhaseIndex: authorization.phaseIndex,
    deliveryPhaseIndex: handoff.deliveryPhaseIndex,
    settlementId: authorization.settlementId,
    agreementHash: authorization.agreementHash,
    paymentEvidenceHash: authorization.evidenceHash,
  });
  if (
    handoff.jobId !== authorization.jobId ||
    handoff.agreementHash !== authorization.agreementHash ||
    handoff.authorizationHash !== authorizationHash ||
    handoff.fulfilmentId !== expectedFulfilmentId ||
    handoff.settlementId !== authorization.settlementId ||
    handoff.paymentEvidenceHash !== authorization.evidenceHash ||
    handoff.paymentPhaseIndex !== authorization.phaseIndex ||
    !isHash(handoff.authorizationHash) ||
    !isHash(handoff.fulfilmentId) ||
    !isHash(handoff.agreementHash) ||
    !isHash(handoff.paymentEvidenceHash) ||
    !isCanonicalSettlementId(handoff.settlementId) ||
    !isSafeUint(handoff.paymentPhaseIndex) ||
    !isSafeUint(handoff.deliveryPhaseIndex)
  ) {
    throw new TypeError("consumed handoff contradicts its retained payment authorization");
  }
  const handoffEncoded = encodeDurable(handoff);
  return {
    claim,
    handoff,
    handoffEncoded,
    binding: {
      authorizationHash,
      fulfilmentId: handoff.fulfilmentId,
      handoffBindingHash: durableHash(handoffEncoded),
      agreementHash: handoff.agreementHash,
      paymentEvidenceHash: handoff.paymentEvidenceHash,
      settlementId: handoff.settlementId,
      paymentPhaseIndex: handoff.paymentPhaseIndex,
      deliveryPhaseIndex: handoff.deliveryPhaseIndex,
    },
  };
}

function deriveCompletedAuthorityFromRecord(
  record: SessionRecord,
  suppliedResult: Extract<SellerFulfilmentResult, { decision: "completed" }>,
): ConsumedAuthority {
  if (!isRecord(suppliedResult) || suppliedResult.decision !== "completed" ||
      !isRecord(suppliedResult.consumedPaymentAuthorization) ||
      !isRecord(suppliedResult.bundleContribution) ||
      !isRecord(suppliedResult.bundleContribution.phaseSummary)) {
    throw new Error("supplied durable completion is malformed");
  }
  const authorization = clone(suppliedResult.consumedPaymentAuthorization);
  const claim: SellerReceiptClaim = {
    settlementId: authorization.settlementId,
    jobId: authorization.jobId,
    phaseIndex: authorization.phaseIndex,
    observedAt: authorization.evidenceInput?.observedAt,
    evidenceHash: authorization.evidenceHash,
    authorization,
  };
  if (!isValidSellerReceiptClaim(claim)) {
    throw new Error("supplied durable completion lacks a valid consumed authorization");
  }
  const deliveryPhaseIndex = suppliedResult.bundleContribution.phaseSummary.index;
  if (!isSafeUint(deliveryPhaseIndex)) {
    throw new Error("supplied durable completion has an invalid delivery phase index");
  }
  const authorizationHash = sha256Hex(canonicalize(authorization));
  const expectedFulfilmentId = sellerFulfilmentId({
    jobId: authorization.jobId,
    paymentPhaseIndex: authorization.phaseIndex,
    deliveryPhaseIndex,
    settlementId: authorization.settlementId,
    agreementHash: authorization.agreementHash,
    paymentEvidenceHash: authorization.evidenceHash,
  });
  if (suppliedResult.fulfilmentId !== expectedFulfilmentId ||
      record.jobId !== authorization.jobId ||
      record.agreementHash !== authorization.agreementHash) {
    throw new Error("supplied durable completion contradicts the persisted session identity");
  }
  const matchingBindings = record.paymentAuthorizations.filter((binding) =>
    binding.authorizationHash === authorizationHash &&
    binding.fulfilmentId === expectedFulfilmentId &&
    binding.agreementHash === authorization.agreementHash &&
    binding.paymentEvidenceHash === authorization.evidenceHash &&
    binding.settlementId === authorization.settlementId &&
    binding.paymentPhaseIndex === authorization.phaseIndex &&
    binding.deliveryPhaseIndex === deliveryPhaseIndex
  );
  if (matchingBindings.length !== 1) {
    throw new Error("durable session lacks the exact completed payment authorization binding");
  }
  const binding = matchingBindings[0]!;
  const handoffCheckpoint = latestCheckpoint(
    record,
    sellerFulfilmentCheckpointKey.handoff(deliveryPhaseIndex),
  );
  const handoffData = handoffCheckpoint?.data;
  if (handoffCheckpoint?.stage !== "outcome" || !handoffData ||
      !hasExactKeys(handoffData, ["fulfilmentId", "handoffBindingHash", "handoff"]) ||
      handoffData.fulfilmentId !== binding.fulfilmentId ||
      handoffData.handoffBindingHash !== binding.handoffBindingHash ||
      typeof handoffData.handoff !== "string" ||
      durableHash(handoffData.handoff) !== binding.handoffBindingHash) {
    throw new Error("durable completion lacks its exact consumed handoff outcome");
  }
  const handoff = decodeDurable<unknown>(handoffData.handoff);
  const authority = deriveConsumedAuthority(claim, handoff);
  if (!exact(authority.binding, binding) ||
      authority.handoffEncoded !== handoffData.handoff) {
    throw new Error("durable consumed handoff contradicts its payment authorization binding");
  }
  return authority;
}

function assertRequestBindsConsumedAuthority(
  request: SellerFulfilmentRequest,
  authority: ConsumedAuthority,
): void {
  const requestHasAdmission = Object.prototype.hasOwnProperty.call(
    request,
    "payloadVerificationProducerAdmission",
  );
  const retainedHasAdmission = Object.prototype.hasOwnProperty.call(
    authority.claim.authorization,
    "payloadVerificationProducerAdmission",
  );
  if (!hasExactKeys(request as unknown as Record<string, unknown>, [
    "agreementRef",
    "agreementHash",
    "commitmentRef",
    "deliveryPhaseIndex",
    "paymentPermitId",
    ...(requestHasAdmission ? ["payloadVerificationProducerAdmission"] : []),
  ]) || !isNonEmpty(request.paymentPermitId) ||
      !isNonEmpty(request.agreementRef) || !isHash(request.agreementHash) ||
      !isNonEmpty(request.commitmentRef) ||
      !isSafeUint(request.deliveryPhaseIndex) || request.deliveryPhaseIndex === 0 ||
      request.agreementRef !== authority.handoff.agreementRef ||
      request.agreementHash !== authority.handoff.agreementHash ||
      request.commitmentRef !== authority.handoff.commitmentRef ||
      request.deliveryPhaseIndex !== authority.handoff.deliveryPhaseIndex ||
      requestHasAdmission !== retainedHasAdmission ||
      (requestHasAdmission && !exact(
        request.payloadVerificationProducerAdmission,
        authority.claim.authorization.payloadVerificationProducerAdmission,
      ))) {
    throw new Error("current request contradicts the exact consumed fulfilment handoff");
  }
}

function bindCaptured<T>(callback: T, owner: unknown): T {
  return Function.prototype.bind.call(callback as unknown as Function, owner) as T;
}

function captureStore(source: FencedSessionStoreV2): FencedSessionStoreV2 {
  const apiVersion = source.apiVersion;
  const createSource = source.create;
  const loadSource = source.load;
  const transitionSource = source.transition;
  const claimCheckpointSource = source.claimCheckpoint;
  const acquireLeaseSource = source.acquireLease;
  const renewLeaseSource = source.renewLease;
  const bindSessionAuthorizationSource = source.bindSessionAuthorization;
  const bindHashSource = source.bindHash;
  const listSource = source.list;
  if (apiVersion !== FENCED_SESSION_STORE_VERSION) {
    throw new TypeError("seller durability requires an explicit generation-fenced store v2");
  }
  if ([
    createSource,
    loadSource,
    transitionSource,
    claimCheckpointSource,
    acquireLeaseSource,
    renewLeaseSource,
    bindSessionAuthorizationSource,
    bindHashSource,
    listSource,
  ].some((candidate) => typeof candidate !== "function")) {
    throw new TypeError("generation-fenced store v2 has a non-callable method");
  }
  const create = bindCaptured(createSource, source);
  const load = bindCaptured(loadSource, source);
  const transition = bindCaptured(transitionSource, source);
  const claimCheckpoint = bindCaptured(claimCheckpointSource, source);
  const acquireLease = bindCaptured(acquireLeaseSource, source);
  const renewLease = bindCaptured(renewLeaseSource, source);
  const bindSessionAuthorization = bindCaptured(bindSessionAuthorizationSource, source);
  const bindHash = bindCaptured(bindHashSource, source);
  const list = bindCaptured(listSource, source);
  const captured: FencedSessionStoreV2 = {
    apiVersion: FENCED_SESSION_STORE_VERSION,
    create: async (input) => clone(await create(clone(input))),
    load: async (jobId) => clone(await load(jobId)),
    transition: async (input) => clone(await transition(clone(input))),
    claimCheckpoint: async (input) => clone(await claimCheckpoint(clone(input))),
    acquireLease: async (input) => clone(await acquireLease(clone(input))),
    renewLease: async (input) => clone(await renewLease(clone(input))),
    bindSessionAuthorization: async (input) =>
      clone(await bindSessionAuthorization(clone(input))),
    bindHash: async (input) => clone(await bindHash(clone(input))),
    list: async (filter) => clone(await list(filter === undefined ? undefined : clone(filter))),
  };
  return Object.freeze(captured);
}

function captureDeps(source: DurableSellerFulfilmentDeps): DurableSellerFulfilmentDeps {
  const receiptStoreSource = source.receiptStore;
  const resolveAgreementSource = source.resolveAgreement;
  const resolveListingSource = source.resolveListing;
  const resolveSessionRecordSource = source.resolveSessionRecord;
  const prepareDeliverySource = source.prepareDelivery;
  const submitDeliverySource = source.submitDelivery;
  const reconcileDeliverySource = source.reconcileDelivery;
  const resolveDeliverySource = source.resolveDelivery;
  const verifyAnchorReceiptSource = source.verifyAnchorReceipt;
  const verifyDeliverySchemaSource = source.verifyDeliverySchema;
  const verifyEncryptedDeliverySource = source.verifyEncryptedDelivery;
  const resolvePayloadAttestationSource = source.resolvePayloadAttestation;
  const anchorPayloadAttestationSource = source.anchorPayloadAttestation;
  const resolvePayloadVerificationCapabilitySource = source.resolvePayloadVerificationCapability;
  const verifyPayloadAttestationSignatureSource = source.verifyPayloadAttestationSignature;
  const verifyPayloadMethodProofSource = source.verifyPayloadMethodProof;
  const verifyEntitlementSignatureSource = source.verifyEntitlementSignature;
  const evidenceSignerSource = source.evidenceSigner;
  const verifyEvidenceSignatureSource = source.verifyEvidenceSignature;
  const anchorEvidenceSource = source.anchorEvidence;
  const resolveEvidenceSource = source.resolveEvidence;
  const nowMsSource = source.nowMs;
  if (!receiptStoreSource || typeof receiptStoreSource !== "object" ||
      !evidenceSignerSource || typeof evidenceSignerSource !== "object") {
    throw new TypeError("receipt store or evidence signer is unavailable");
  }
  const claimSource = receiptStoreSource.claim;
  const inspectPermitSource = receiptStoreSource.inspectPermit;
  const consumePermitSource = receiptStoreSource.consumePermit;
  const evidenceAlgorithm = evidenceSignerSource.algorithm;
  const evidenceSignerClaim = evidenceSignerSource.signer;
  const evidenceSignSource = evidenceSignerSource.sign;
  if ([
    resolveAgreementSource,
    resolveListingSource,
    resolveSessionRecordSource,
    prepareDeliverySource,
    submitDeliverySource,
    reconcileDeliverySource,
    resolveDeliverySource,
    verifyAnchorReceiptSource,
    verifyEvidenceSignatureSource,
    anchorEvidenceSource,
    resolveEvidenceSource,
    nowMsSource,
    claimSource,
    inspectPermitSource,
    consumePermitSource,
    evidenceSignSource,
  ].some((candidate) => typeof candidate !== "function")) {
    throw new TypeError("a required durable fulfilment dependency is not callable");
  }
  if ([
    verifyDeliverySchemaSource,
    verifyEncryptedDeliverySource,
    resolvePayloadAttestationSource,
    anchorPayloadAttestationSource,
    resolvePayloadVerificationCapabilitySource,
    verifyPayloadAttestationSignatureSource,
    verifyPayloadMethodProofSource,
    verifyEntitlementSignatureSource,
  ].some((candidate) => candidate !== undefined && typeof candidate !== "function")) {
    throw new TypeError("an optional durable fulfilment dependency is not callable");
  }
  const captured: DurableSellerFulfilmentDeps = Object.freeze({
    receiptStore: Object.freeze({
      claim: bindCaptured(claimSource, receiptStoreSource),
      inspectPermit: bindCaptured(inspectPermitSource, receiptStoreSource),
      consumePermit: bindCaptured(consumePermitSource, receiptStoreSource),
    }),
    resolveAgreement: bindCaptured(resolveAgreementSource, source),
    resolveListing: bindCaptured(resolveListingSource, source),
    resolveSessionRecord: bindCaptured(resolveSessionRecordSource, source),
    prepareDelivery: bindCaptured(prepareDeliverySource, source),
    submitDelivery: bindCaptured(submitDeliverySource, source),
    reconcileDelivery: bindCaptured(reconcileDeliverySource, source),
    resolveDelivery: bindCaptured(resolveDeliverySource, source),
    verifyAnchorReceipt: bindCaptured(verifyAnchorReceiptSource, source),
    ...(verifyDeliverySchemaSource
      ? { verifyDeliverySchema: bindCaptured(verifyDeliverySchemaSource, source) }
      : {}),
    ...(verifyEncryptedDeliverySource
      ? { verifyEncryptedDelivery: bindCaptured(verifyEncryptedDeliverySource, source) }
      : {}),
    ...(resolvePayloadAttestationSource
      ? { resolvePayloadAttestation: bindCaptured(resolvePayloadAttestationSource, source) }
      : {}),
    ...(anchorPayloadAttestationSource
      ? { anchorPayloadAttestation: bindCaptured(anchorPayloadAttestationSource, source) }
      : {}),
    ...(resolvePayloadVerificationCapabilitySource
      ? {
          resolvePayloadVerificationCapability:
            bindCaptured(resolvePayloadVerificationCapabilitySource, source),
        }
      : {}),
    ...(verifyPayloadAttestationSignatureSource
      ? {
          verifyPayloadAttestationSignature:
            bindCaptured(verifyPayloadAttestationSignatureSource, source),
        }
      : {}),
    ...(verifyPayloadMethodProofSource
      ? { verifyPayloadMethodProof: bindCaptured(verifyPayloadMethodProofSource, source) }
      : {}),
    ...(verifyEntitlementSignatureSource
      ? { verifyEntitlementSignature: bindCaptured(verifyEntitlementSignatureSource, source) }
      : {}),
    evidenceSigner: Object.freeze({
      algorithm: evidenceAlgorithm,
      signer: evidenceSignerClaim,
      sign: bindCaptured(evidenceSignSource, evidenceSignerSource),
    }),
    verifyEvidenceSignature: bindCaptured(verifyEvidenceSignatureSource, source),
    anchorEvidence: bindCaptured(anchorEvidenceSource, source),
    resolveEvidence: bindCaptured(resolveEvidenceSource, source),
    nowMs: bindCaptured(nowMsSource, source),
  });
  return captured;
}

function captureDurability(source: SellerFulfilmentDurability): SellerFulfilmentDurability {
  const storeSource = source.store;
  const workerId = source.workerId;
  const leaseTtlMs = source.leaseTtlMs;
  const leaseNowMsSource = source.leaseNowMs;
  const reconcilePayloadAttestationSource = source.reconcilePayloadAttestation;
  const reconcileDeliverySubmissionSource = source.reconcileDeliverySubmission;
  const reconcileEvidencePublicationSource = source.reconcileEvidencePublication;
  const publishFinalSessionReceiptSource = source.publishFinalSessionReceipt;
  const reconcileFinalSessionReceiptSource = source.reconcileFinalSessionReceipt;
  if (!isNonEmpty(workerId) || !Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new TypeError("durability requires a workerId and positive leaseTtlMs");
  }
  if (leaseNowMsSource !== undefined && typeof leaseNowMsSource !== "function") {
    throw new TypeError("durability lease clock is not callable");
  }
  if ([
    reconcilePayloadAttestationSource,
    reconcileDeliverySubmissionSource,
    reconcileEvidencePublicationSource,
    publishFinalSessionReceiptSource,
    reconcileFinalSessionReceiptSource,
  ].some((candidate) => typeof candidate !== "function")) {
    throw new TypeError("a required durability callback is not callable");
  }
  return Object.freeze({
    store: captureStore(storeSource),
    workerId,
    leaseTtlMs,
    ...(leaseNowMsSource
      ? { leaseNowMs: bindCaptured(leaseNowMsSource, source) }
      : {}),
    reconcilePayloadAttestation:
      bindCaptured(reconcilePayloadAttestationSource, source),
    reconcileDeliverySubmission:
      bindCaptured(reconcileDeliverySubmissionSource, source),
    reconcileEvidencePublication:
      bindCaptured(reconcileEvidencePublicationSource, source),
    publishFinalSessionReceipt:
      bindCaptured(publishFinalSessionReceiptSource, source),
    reconcileFinalSessionReceipt:
      bindCaptured(reconcileFinalSessionReceiptSource, source),
  });
}

function recordFromLoad(value: Awaited<ReturnType<FencedSessionStoreV2["load"]>>): SessionRecord {
  if (value.status !== "ok") {
    throw new Error(`durable session is ${value.status}`);
  }
  const violation = sessionRecordShapeViolation(value.record);
  if (violation) throw new Error(`durable session is corrupt: ${violation}`);
  return value.record;
}

function latestCheckpoint(record: SessionRecord, key: string) {
  const history = record.checkpoints.filter((checkpoint) => checkpoint.key === key);
  if (history.length === 0) return undefined;
  if (history.length > 2 || history[0]?.stage !== "intent" ||
      (history.length === 2 && history[1]?.stage !== "outcome")) {
    throw new Error(`durable WAL ${key} has an invalid intent/outcome history`);
  }
  if (history.length === 2) {
    const outcomeData = history[1]!.data ?? {};
    const permitsAuthoritativeAbsence =
      /^seller:(?:payload-publication|delivery):(0|[1-9][0-9]*)$/.test(key) &&
      outcomeData.authoritativeAbsence === true;
    const retainedIntentData = Object.fromEntries(
      Object.entries(outcomeData).filter(([field]) =>
        field !== "outputHash" && field !== "output" &&
        !(permitsAuthoritativeAbsence && field === "authoritativeAbsence")
      ),
    );
    if (!exact(history[0]!.data ?? {}, retainedIntentData)) {
      throw new Error(`durable WAL ${key} outcome contradicts its retained intent`);
    }
  }
  return history[history.length - 1];
}

function checkpointState(record: SessionRecord, key: string): SellerFulfilmentCheckpointState {
  const checkpoint = latestCheckpoint(record, key);
  return checkpoint?.stage ?? "not-started";
}

function phase(
  state: "validation-pending" | "delivery-pending" | "delivery-recovery" |
    "evidence-pending" | "evidence-recovery" | "delivery-completed" |
    "delivery-failed" | "delivery-rejected",
  phaseIndex: number,
): string {
  return `seller:${state}:${phaseIndex}`;
}

const SELLER_DELIVERY_PHASE_RE =
  /^seller:(?:delivery-(?:pending|recovery|completed|failed|rejected)|evidence-(?:pending|recovery)|validation-pending):(0|[1-9][0-9]*)$/;

function terminalPhaseStillRepresented(
  persistedPhase: string,
  result: TerminalFulfilmentResult,
  phaseIndex: number,
): boolean {
  const exactPhase = result.decision === "completed"
    ? phase("delivery-completed", phaseIndex)
    : phase("delivery-failed", phaseIndex);
  if (persistedPhase === exactPhase) return true;
  if (persistedPhase === "seller:finalised") return true;
  if (result.decision === "completed" && [
    "seller:bundle-signing",
    "seller:bundle-anchor-pending",
    "seller:bundle-binding-signing",
    "seller:bundle-binding-publication-pending",
  ].includes(persistedPhase)) return true;
  // Failed phases cannot advance in FencedSessionStoreV2. A successful earlier
  // delivery, however, remains an immutable replayable result while the same
  // job progresses through a strictly later delivery or global finalisation.
  if (result.decision !== "completed") return false;
  const later = SELLER_DELIVERY_PHASE_RE.exec(persistedPhase);
  if (later === null) return false;
  const laterIndex = Number(later[1]);
  return Number.isSafeInteger(laterIndex) && laterIndex > phaseIndex;
}

interface ClaimedWal {
  state: "fresh" | "intent" | "outcome";
  record: SessionRecord;
  data: Record<string, CheckpointValue>;
}

interface RetainedDeliveryCheckpoint {
  stage: "intent" | "outcome";
  data: Record<string, CheckpointValue>;
  input: DeliverySubmitInput;
  output?: Exclude<SellerDeliverySubmission, { status: "indeterminate" }>;
  authoritativeAbsence?: true;
}

interface RetainedPayloadPublicationCheckpoint {
  stage: "intent" | "outcome";
  data: Record<string, CheckpointValue>;
  input: PayloadAnchorInput;
  output?: Exclude<SellerEvidenceAnchorResult, { status: "indeterminate" }>;
  authoritativeAbsence?: true;
}

interface TerminalSourceIdentity {
  decision: TerminalFulfilmentResult["decision"];
  effectSnapshotHash: string;
  failureSource: TerminalFailureSource | null;
}

interface RetainedEvidencePublicationCheckpoint {
  stage: "intent" | "outcome";
  data: Record<string, CheckpointValue>;
  input: EvidenceAnchorInput;
  terminalSource: TerminalSourceIdentity;
  output?: Extract<SellerEvidenceAnchorResult, { status: "anchored" }>;
}

type TerminalFailureSourceKind =
  | "dpa"
  | "preparation"
  | "delivery-reconciliation"
  | "delivery-readback-rejection"
  | "delivery-validation";

interface TerminalFailureSource {
  kind: TerminalFailureSourceKind;
  reason: string;
  observedAt: number;
  deliveryClosure:
    | "not-started"
    | "opening-reconciled-absent"
    | "submission-authoritatively-absent"
    | "reconciled-absent"
    | "reconciliation-failed"
    | "reconciliation-complete";
  payloadClosure:
    | "not-started"
    | "authoritatively-absent"
    | "rejected"
    | "anchored"
    | "legacy-readback";
}

const DPA_PAYLOAD_ABSENCE_REASON =
  "payload publication authoritatively absent before DPA terminalization";
const DPA_DELIVERY_ABSENCE_REASON =
  "delivery submission authoritatively absent before DPA terminalization";
const DPA_TERMINAL_REASON_PREFIX = "DPA terminal: ";
const NON_DPA_TERMINAL_REASON_PREFIX = "non-DPA terminal: ";

/** Keep the signed DPA reason namespace unambiguous without rejecting adapters. */
function nonDpaTerminalReason(reason: string): string {
  return reason.startsWith(DPA_TERMINAL_REASON_PREFIX)
    ? `${NON_DPA_TERMINAL_REASON_PREFIX}${reason}`
    : reason;
}

function nonDpaVerificationResult(value: unknown): unknown {
  if (isVerificationResult(value) && value.disposition === "invalid") {
    return {
      disposition: "invalid",
      reason: nonDpaTerminalReason(value.reason),
    };
  }
  return value;
}

class DurableCoordinator {
  readonly #request: SellerFulfilmentRequest;
  readonly #deps: DurableSellerFulfilmentDeps;
  readonly #durability: SellerFulfilmentDurability;
  #authority?: ConsumedAuthority;
  #leaseToken?: SessionLeaseToken;
  #terminalReplay?: TerminalFulfilmentResult;
  #initializePromise?: Promise<void>;
  #lastApplicationNow?: number;

  static async verifyCompletedRecord(
    record: SessionRecord,
    suppliedResult: Extract<SellerFulfilmentResult, { decision: "completed" }>,
    authority: ConsumedAuthority,
    verification: DurableSellerTerminalVerification,
  ): Promise<VerifiedDurableSellerTerminalResult> {
    const request: SellerFulfilmentRequest = {
      agreementRef: authority.handoff.agreementRef,
      agreementHash: authority.handoff.agreementHash,
      commitmentRef: authority.handoff.commitmentRef,
      deliveryPhaseIndex: authority.binding.deliveryPhaseIndex,
      paymentPermitId: "durable-terminal-record-verification",
      ...(authority.claim.authorization.payloadVerificationProducerAdmission
        ? {
            payloadVerificationProducerAdmission: clone(
              authority.claim.authorization.payloadVerificationProducerAdmission,
            ),
          }
        : {}),
    };
    // The terminal decoder is side-effect free and reads only #authority. The
    // authenticator additionally reads these two captured cryptographic seams.
    // Empty capabilities make any future accidental effect/store access fail
    // closed instead of granting the read-only verifier new authority.
    const dependencies = Object.freeze({
      verifyEvidenceSignature: verification.verifyEvidenceSignature,
      verifyAnchorReceipt: verification.verifyAnchorReceipt,
    }) as unknown as DurableSellerFulfilmentDeps;
    const coordinator = new DurableCoordinator(
      request,
      dependencies,
      Object.freeze({}) as unknown as SellerFulfilmentDurability,
    );
    coordinator.#authority = clone(authority);
    const decoded = coordinator.#decodeTerminal(record);
    if (!decoded || decoded.decision !== "completed" ||
        !exact(decoded, suppliedResult)) {
      throw new Error("supplied completion is not the exact durable terminal result");
    }
    await coordinator.#authenticateTerminalResult(decoded);
    const resultCheckpoint = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.result(authority.binding.deliveryPhaseIndex),
    );
    const resultHash = resultCheckpoint?.data?.resultHash;
    const finalReceiptHash = resultCheckpoint?.data?.finalReceiptHash;
    if (typeof resultHash !== "string" || typeof finalReceiptHash !== "string") {
      throw new Error("durable terminal result hashes disappeared after verification");
    }
    return {
      result: clone(decoded),
      binding: clone(authority.binding),
      handoff: clone(authority.handoff),
      resultHash,
      finalReceiptHash,
    };
  }

  constructor(
    request: SellerFulfilmentRequest,
    deps: DurableSellerFulfilmentDeps,
    durability: SellerFulfilmentDurability,
  ) {
    this.#request = request;
    this.#deps = deps;
    this.#durability = durability;
  }

  #now(): number {
    const now = this.#durability.leaseNowMs?.() ?? Date.now();
    if (!isSafeUint(now)) throw new Error("durability clock returned an invalid time");
    return now;
  }

  applicationNow(): number {
    const now = this.#deps.nowMs();
    if (isSafeUint(now)) {
      if (this.#lastApplicationNow !== undefined && now < this.#lastApplicationNow) {
        throw new Error("application clock moved backwards during durable fulfilment");
      }
      this.#lastApplicationNow = now;
    }
    return now;
  }

  async #load(): Promise<SessionRecord> {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    return recordFromLoad(await this.#durability.store.load(this.#authority.handoff.jobId));
  }

  async inspectInitialPermit(): Promise<void> {
    const inspection = clone(await this.#deps.receiptStore.inspectPermit(
      this.#request.paymentPermitId,
    ));
    if (inspection.status === "already-consumed") {
      await this.establish(inspection.claim, inspection.handoff);
    }
  }

  async establish(claim: unknown, handoff: unknown): Promise<void> {
    const authority = deriveConsumedAuthority(claim, handoff);
    assertRequestBindsConsumedAuthority(this.#request, authority);
    if (this.#authority) {
      if (!exact(this.#authority.binding, authority.binding) ||
          this.#authority.handoffEncoded !== authority.handoffEncoded ||
          !exact(this.#authority.claim, authority.claim)) {
        throw new Error("receipt store changed the consumed authorization or handoff");
      }
      return this.#ensureInitialized();
    }
    this.#authority = authority;
    return this.#ensureInitialized();
  }

  async #ensureInitialized(): Promise<void> {
    if (this.#initializePromise) return this.#initializePromise;
    const pending = this.#initialize();
    this.#initializePromise = pending;
    try {
      await pending;
    } catch (error) {
      // A lost store response can leave a valid partial initialization behind.
      // Permit a same-process authoritative inspection to resume it instead of
      // caching a rejected promise forever.
      if (this.#initializePromise === pending) this.#initializePromise = undefined;
      throw error;
    }
  }

  async #initialize(): Promise<void> {
    const authority = this.#authority!;
    const store = this.#durability.store;
    let loaded = await store.load(authority.handoff.jobId);
    if (loaded.status === "missing") {
      try {
        await store.create({
          jobId: authority.handoff.jobId,
          agreementHash: authority.binding.agreementHash,
          phase: "created",
          now: this.#now(),
        });
      } catch {
        // A concurrent process may have created the same consumed session.
      }
      loaded = await store.load(authority.handoff.jobId);
    }
    let record = recordFromLoad(loaded);
    const existingBinding = record.paymentAuthorizations.find(
      (item) => item.deliveryPhaseIndex === authority.binding.deliveryPhaseIndex,
    );
    if (existingBinding && !exact(existingBinding, authority.binding)) {
      throw new Error("durable session binds another consumed authorization");
    }
    if (existingBinding) {
      // Exact re-binding is also the store's idempotent repair/check path for
      // its global agreement and settlement anti-replay markers. Run it before
      // terminal replay so a missing marker is restored and a corrupt or
      // conflicting marker can never be bypassed by an already-complete job.
      const verified = await store.bindSessionAuthorization({
        jobId: authority.handoff.jobId,
        binding: clone(authority.binding),
        now: this.#now(),
      });
      if (!verified.ok) {
        throw new Error(`consumed authorization marker verification failed: ${verified.reason}`);
      }
      // The binding call is serialized by the store and returns the latest
      // coherent session snapshot. A concurrent later-phase worker may have
      // legitimately advanced revision/phase since the preceding load, so
      // revalidate authority and decode from this snapshot rather than demanding
      // byte equality across two awaits.
      const verifiedBinding = verified.record.paymentAuthorizations.find(
        (item) => item.deliveryPhaseIndex === authority.binding.deliveryPhaseIndex,
      );
      if (!verifiedBinding || !exact(verifiedBinding, authority.binding)) {
        throw new Error("consumed authorization marker verification changed authority");
      }
      record = verified.record;
    }
    const terminal = this.#decodeTerminal(record);
    if (terminal) {
      if (!existingBinding) throw new Error("terminal result lacks its consumed authorization");
      await this.#authenticateTerminalResult(terminal);
      this.#leaseToken = undefined;
      this.#terminalReplay = terminal;
      return;
    }
    if (!this.#leaseToken) {
      const acquired = await store.acquireLease({
        jobId: authority.handoff.jobId,
        owner: this.#durability.workerId,
        ttlMs: this.#durability.leaseTtlMs,
        sellerPhaseIndex: authority.binding.deliveryPhaseIndex,
        now: this.#now(),
      });
      if (!acquired.ok) {
        throw new Error(`durable lease unavailable: ${acquired.reason}`);
      }
      this.#leaseToken = {
        owner: acquired.lease.owner,
        generation: acquired.lease.generation,
      };
    }
    const bound = await store.bindSessionAuthorization({
      jobId: authority.handoff.jobId,
      binding: clone(authority.binding),
      leaseToken: this.#leaseToken,
      now: this.#now(),
    });
    if (!bound.ok) {
      throw new Error(`consumed authorization binding failed: ${bound.reason}`);
    }
    const handoffKey = sellerFulfilmentCheckpointKey.handoff(
      authority.binding.deliveryPhaseIndex,
    );
    const handoffData = {
      fulfilmentId: authority.binding.fulfilmentId,
      handoffBindingHash: authority.binding.handoffBindingHash,
      handoff: authority.handoffEncoded,
    };
    const claimed = await this.#claim(
      handoffKey,
      handoffData,
      phase("validation-pending", authority.binding.deliveryPhaseIndex),
    );
    if (!exact(claimed.data, handoffData)) {
      throw new Error("durable handoff intent contradicts consumed authority");
    }
    if (claimed.state !== "outcome") {
      await this.#appendOutcome(handoffKey, handoffData, handoffData);
    }
    await this.#ensureReceipt({
      kind: "agreement",
      ref: authority.handoff.agreementRef,
    });
    await this.#ensureReceipt({
      kind: "settlement",
      ref: authority.binding.settlementId,
      phaseIndex: authority.binding.paymentPhaseIndex,
    });
    record = await this.#load();
    const persistedBinding = record.paymentAuthorizations.find(
      (item) => item.deliveryPhaseIndex === authority.binding.deliveryPhaseIndex,
    );
    const persistedHandoff = latestCheckpoint(record, handoffKey);
    const agreementReceipt = record.receipts.find(
      (receipt) => sessionReceiptKey(receipt) === "agreement",
    );
    const settlementReceipt = record.receipts.find(
      (receipt) => sessionReceiptKey(receipt) ===
        `settlement:${authority.binding.paymentPhaseIndex}`,
    );
    if (!persistedBinding || !exact(persistedBinding, authority.binding) ||
        persistedHandoff?.stage !== "outcome" ||
        persistedHandoff.data?.handoff !== authority.handoffEncoded ||
        persistedHandoff.data.handoffBindingHash !== authority.binding.handoffBindingHash ||
        agreementReceipt?.ref !== authority.handoff.agreementRef ||
        settlementReceipt?.ref !== authority.binding.settlementId) {
      throw new Error("consumed authorization/handoff failed durable readback");
    }
  }

  terminalReplay(): TerminalFulfilmentResult | undefined {
    return this.#terminalReplay ? clone(this.#terminalReplay) : undefined;
  }

  #assertTerminalResult(value: unknown): asserts value is TerminalFulfilmentResult {
    if (!this.#authority || !isRecord(value) ||
        (value.decision !== "completed" && value.decision !== "failed")) {
      throw new Error("durable terminal result has an invalid decision");
    }
    const expectedKeys = [
      "decision",
      "fulfilmentId",
      ...(value.decision === "failed" ? ["errorClass"] : []),
      "evidence",
      "evidenceHash",
      "evidenceRef",
      "evidenceAnchorReceipt",
      "bundleContribution",
      "consumedPaymentAuthorization",
    ];
    const evidence = value.evidence;
    const bundle = value.bundleContribution;
    const retainedDeliverable = retainedDeliverableBinding(this.#authority.handoff);
    const expectedEvidenceKeys = value.decision === "completed"
      ? [
          "evidenceVersion",
          "jobId",
          "phase",
          "outcome",
          "deliverableContentHash",
          "deliverableAnchor",
          ...(this.#authority.handoff.phase === "deliver-attested-payload"
            ? ["attestationRef"]
            : []),
          "observedAt",
          "signature",
        ]
      : [
          "evidenceVersion",
          "jobId",
          "phase",
          "outcome",
          "reason",
          "observedAt",
          "signature",
        ];
    if (!hasExactKeys(value, expectedKeys) || !isRecord(evidence) || !isRecord(bundle) ||
        !isRecord(bundle.phaseSummary) ||
        !isSettlementEvidence(evidence) ||
        !hasExactKeys(evidence, expectedEvidenceKeys) ||
        value.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        !exact(value.consumedPaymentAuthorization, this.#authority.claim.authorization) ||
        !isHash(value.evidenceHash) ||
        signedEvidenceHash(evidence) !== value.evidenceHash ||
        evidence.jobId !== this.#authority.handoff.jobId ||
        evidence.phase !== this.#authority.handoff.phase ||
        evidence.outcome !== (value.decision === "completed" ? "success" : "failure") ||
        !isSafeUint(evidence.observedAt) ||
        (value.decision === "completed" &&
          (!retainedDeliverable ||
            evidence.deliverableContentHash !== retainedDeliverable.contentHash ||
            !isRecord(evidence.deliverableAnchor) ||
            evidence.deliverableAnchor.kind !== "storage-program" ||
            evidence.deliverableAnchor.locator !== this.#authority.handoff.logicalAddress ||
            (this.#authority.handoff.phase === "deliver-attested-payload"
              ? !exact(evidence.attestationRef, retainedDeliverable.attestationRef)
              : evidence.attestationRef !== undefined))) ||
        !isAttestationRef(value.evidenceRef) ||
        value.evidenceRef.anchor.kind !== "storage-program" ||
        value.evidenceRef.contentHash !== value.evidenceHash ||
        !isAnchorReceipt(value.evidenceAnchorReceipt) ||
        value.evidenceAnchorReceipt.contentHash !== value.evidenceHash ||
        value.evidenceAnchorReceipt.logicalAddress !== value.evidenceRef.anchor.locator ||
        value.evidenceAnchorReceipt.observationDisposition !== "established" ||
        (value.evidenceAnchorReceipt.state !== "included" &&
          value.evidenceAnchorReceipt.state !== "finalized") ||
        !isComponentSignature(evidence.signature) ||
        value.evidenceAnchorReceipt.writer !== evidence.signature.signer ||
        (value.evidenceRef.signer !== undefined &&
          value.evidenceRef.signer !== evidence.signature.signer) ||
        !hasExactKeys(bundle, ["phaseSummary", "settlementEvidence"]) ||
        !hasExactKeys(bundle.phaseSummary, [
          "index",
          "kind",
          "outcome",
          ...(value.decision === "failed" ? ["errorClass"] : []),
          "attestationRef",
        ]) ||
        bundle.phaseSummary.index !== this.#authority.binding.deliveryPhaseIndex ||
        bundle.phaseSummary.kind !== this.#authority.handoff.phase ||
        bundle.phaseSummary.outcome !== (value.decision === "completed" ? "ok" : "fail") ||
        (value.decision === "failed" && bundle.phaseSummary.errorClass !== value.errorClass) ||
        !isAttestationRef(bundle.phaseSummary.attestationRef) ||
        !isAttestationRef(bundle.settlementEvidence) ||
        !exact(bundle.phaseSummary.attestationRef, value.evidenceRef) ||
        !exact(bundle.settlementEvidence, value.evidenceRef) ||
        !isRecord(evidence.signature) ||
        !hasExactKeys(evidence.signature, ["algorithm", "signer", "value"])) {
      throw new Error("durable terminal result contradicts consumed authority or evidence");
    }
    if (value.decision === "failed" && value.errorClass !== "permanent") {
      throw new Error("durable terminal result has a non-derivable error class");
    }
    try {
      encodeDurable(value);
    } catch {
      throw new Error("durable terminal result is not losslessly encodable");
    }
  }

  async #authenticateTerminalResult(result: TerminalFulfilmentResult): Promise<void> {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const expectedSigner = this.#authority.handoff.evidenceAuthority.primaryClaim;
    const expectedAlgorithm = this.#authority.handoff.evidenceAuthority.algorithm;
    if (result.evidence.signature.signer !== expectedSigner ||
        result.evidence.signature.algorithm !== expectedAlgorithm) {
      throw new Error(
        "durable terminal evidence is not signed by the configured phase authority/algorithm",
      );
    }
    const signatureInput: Parameters<
      SellerFulfilmentDeps["verifyEvidenceSignature"]
    >[0] = {
      evidence: clone(result.evidence),
      signedBytes: signedBytes(
        ARTIFACT_SEPARATORS.SettlementEvidence,
        result.evidenceHash,
      ),
      signature: clone(result.evidence.signature),
      expectedSigner,
    };
    const signatureInputBefore = encodeDurable(signatureInput);
    const signatureResult = clone(
      await this.#deps.verifyEvidenceSignature(signatureInput),
    );
    if (encodeDurable(signatureInput) !== signatureInputBefore ||
        !isVerificationResult(signatureResult) ||
        signatureResult.disposition !== "valid") {
      throw new Error(
        `durable terminal evidence signature is not authenticated${
          isVerificationResult(signatureResult) && signatureResult.disposition !== "valid"
            ? `: ${signatureResult.reason}`
            : ""
        }`,
      );
    }

    const receiptInput: Parameters<SellerFulfilmentDeps["verifyAnchorReceipt"]>[0] = {
      purpose: "settlement-evidence",
      expectedWriter: {
        role: "phase-orchestrator",
        primaryClaim: expectedSigner,
      },
      ref: clone(result.evidenceRef),
      receipt: clone(result.evidenceAnchorReceipt),
    };
    const receiptInputBefore = encodeDurable(receiptInput);
    const receiptResult = clone(await this.#deps.verifyAnchorReceipt(receiptInput));
    if (encodeDurable(receiptInput) !== receiptInputBefore ||
        !isVerificationResult(receiptResult) || receiptResult.disposition !== "valid") {
      throw new Error(
        `durable terminal evidence anchor is not authenticated${
          isVerificationResult(receiptResult) && receiptResult.disposition !== "valid"
            ? `: ${receiptResult.reason}`
            : ""
        }`,
      );
    }
  }

  #readFinalReceiptCheckpoint(record: SessionRecord): {
    stage: "intent" | "outcome";
    input: SellerFinalSessionReceiptInput;
    output?: Extract<SellerFinalSessionReceiptResult, { status: "recorded" }>;
    outputEncoded?: string;
  } | undefined {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const key = sellerFulfilmentCheckpointKey.finalReceipt(
      this.#authority.binding.deliveryPhaseIndex,
    );
    const checkpoint = latestCheckpoint(record, key);
    if (!checkpoint) return undefined;
    const data = checkpoint.data;
    const commonKeys = [
      "fulfilmentId",
      "idempotencyKey",
      "identityHash",
      "inputHash",
      "input",
    ];
    if (!data || !hasExactKeys(data, [
      ...commonKeys,
      ...(checkpoint.stage === "outcome" ? ["outputHash", "output"] : []),
    ]) ||
        data.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        data.idempotencyKey !== `final:${this.#authority.binding.fulfilmentId}` ||
        typeof data.input !== "string" || !isHash(data.inputHash) ||
        durableHash(data.input) !== data.inputHash) {
      throw new Error("durable final-receipt checkpoint is malformed");
    }
    const input = decodeDurable<unknown>(data.input);
    if (!isRecord(input) || !hasExactKeys(input, [
      "fulfilmentId",
      "authorizationBinding",
      "resultHash",
      "result",
    ]) ||
        input.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        !exact(input.authorizationBinding, this.#authority.binding) ||
        !isHash(input.resultHash)) {
      throw new Error("durable final-receipt input is malformed or rebound");
    }
    this.#assertTerminalResult(input.result);
    const encodedResult = encodeDurable(input.result);
    if (durableHash(encodedResult) !== input.resultHash ||
        data.identityHash !== durableHash(encodeDurable({
          fulfilmentId: input.fulfilmentId,
          authorizationBinding: input.authorizationBinding,
          resultHash: input.resultHash,
        }))) {
      throw new Error("durable final-receipt input hash is inconsistent");
    }
    const persistedInput: SellerFinalSessionReceiptInput = {
      fulfilmentId: this.#authority.binding.fulfilmentId,
      authorizationBinding: clone(this.#authority.binding),
      resultHash: input.resultHash,
      result: clone(input.result),
    };
    if (checkpoint.stage === "intent") {
      return { stage: "intent", input: persistedInput };
    }
    if (typeof data.output !== "string" || !isHash(data.outputHash) ||
        durableHash(data.output) !== data.outputHash) {
      throw new Error("durable final-receipt outcome is malformed");
    }
    const output = decodeDurable<unknown>(data.output);
    if (!isFinalSessionReceiptResult(output) || output.status !== "recorded") {
      throw new Error("durable final-receipt outcome is not a recorded receipt");
    }
    return {
      stage: "outcome",
      input: persistedInput,
      output: clone(output),
      outputEncoded: data.output,
    };
  }

  async resumePendingFinalReceipt(): Promise<SellerFulfilmentResult | undefined> {
    if (!this.#authority || !this.#leaseToken) return undefined;
    const persisted = this.#readFinalReceiptCheckpoint(await this.#load());
    if (!persisted) return undefined;
    return this.finalise(clone(persisted.input.result));
  }

  #pendingEvidenceRecovery(
    input: Readonly<EvidenceAnchorInput>,
    reason: string,
  ): SellerFulfilmentResult {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    return {
      decision: "indeterminate",
      code: "delivery-evidence-publication-pending",
      reasons: [reason],
      fulfilmentId: this.#authority.binding.fulfilmentId,
      safeToRetryDelivery: false,
      recovery: { action: "retry-evidence-publication" },
      evidence: clone(input.evidence),
      evidenceHash: input.evidenceHash,
      consumedPaymentAuthorization: clone(this.#authority.claim.authorization),
    };
  }

  #terminalResultFromEvidence(
    input: Readonly<EvidenceAnchorInput>,
    output: Readonly<Extract<SellerEvidenceAnchorResult, { status: "anchored" }>>,
  ): TerminalFulfilmentResult {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const common = {
      fulfilmentId: this.#authority.binding.fulfilmentId,
      evidence: clone(input.evidence),
      evidenceHash: input.evidenceHash,
      evidenceRef: clone(output.ref),
      evidenceAnchorReceipt: clone(output.anchorReceipt),
      bundleContribution: {
        phaseSummary: {
          index: this.#authority.binding.deliveryPhaseIndex,
          kind: this.#authority.handoff.phase,
          outcome: input.evidence.outcome === "success" ? "ok" as const : "fail" as const,
          ...(input.evidence.outcome === "failure"
            ? { errorClass: "permanent" as const }
            : {}),
          attestationRef: clone(output.ref),
        },
        settlementEvidence: clone(output.ref),
      },
      consumedPaymentAuthorization: clone(this.#authority.claim.authorization),
    };
    return input.evidence.outcome === "success"
      ? { decision: "completed", ...common }
      : { decision: "failed", errorClass: "permanent", ...common };
  }

  /** Resume the first signed evidence intent before consulting mutable validators. */
  async resumePendingEvidence(): Promise<SellerFulfilmentResult | undefined> {
    if (!this.#authority || !this.#leaseToken) return undefined;
    const retained = await this.#readEvidencePublicationCheckpoint(await this.#load());
    if (!retained) return undefined;
    const publication = await this.evidencePublication(clone(retained.input));
    if (publication.status !== "anchored") {
      return this.#pendingEvidenceRecovery(retained.input, publication.reason);
    }
    const readback = await this.evidenceReadback(publication.ref);
    if (readback.status !== "verified") {
      return this.#pendingEvidenceRecovery(retained.input, readback.reason);
    }
    const result = this.#terminalResultFromEvidence(retained.input, publication);
    this.#assertTerminalResult(result);
    return this.finalise(result);
  }

  #readTerminalDeliveryReadback(record: SessionRecord):
    | {
        input: Parameters<SellerFulfilmentDeps["resolveDelivery"]>[0];
        output: Exclude<DeliveryReadback, { status: "indeterminate" }>;
      }
    | undefined {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const checkpoint = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.deliveryReadback(
        this.#authority.binding.deliveryPhaseIndex,
      ),
    );
    if (!checkpoint) return undefined;
    const data = checkpoint.data;
    if (checkpoint.stage !== "outcome" || !data || !hasExactKeys(data, [
      "fulfilmentId",
      "inputHash",
      "identityHash",
      "input",
      "outputHash",
      "output",
    ]) || data.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        typeof data.input !== "string" || !isHash(data.inputHash) ||
        durableHash(data.input) !== data.inputHash || !isHash(data.identityHash) ||
        typeof data.output !== "string" || !isHash(data.outputHash) ||
        durableHash(data.output) !== data.outputHash) {
      throw new Error("durable terminal delivery readback is malformed");
    }
    const input = decodeDurable<unknown>(data.input);
    if (!isRecord(input) || !hasExactKeys(input, [
      "logicalAddress",
      "jobId",
      "phaseIndex",
      "phase",
    ]) || input.logicalAddress !== this.#authority.handoff.logicalAddress ||
        input.jobId !== this.#authority.handoff.jobId ||
        input.phaseIndex !== this.#authority.binding.deliveryPhaseIndex ||
        input.phase !== this.#authority.handoff.phase ||
        data.identityHash !== durableHash(encodeDurable(input))) {
      throw new Error("durable terminal delivery readback input is rebound");
    }
    const output = decodeDurable<unknown>(data.output);
    if (!isDeliveryReadback(output, input.logicalAddress) ||
        output.status === "indeterminate") {
      throw new Error("durable terminal delivery readback is not definitive");
    }
    return {
      input: clone(input) as Parameters<SellerFulfilmentDeps["resolveDelivery"]>[0],
      output: clone(output),
    };
  }

  #assertTerminalPayloadSpine(
    record: SessionRecord,
    mode: "absent" | "verified-if-local" | "dpa",
    delivery: RetainedDeliveryCheckpoint | undefined,
    deliveryTerminalHistory = false,
  ): void {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const publication = this.#readPayloadPublicationCheckpoint(record);
    const readback = this.#readTerminalPayloadReadback(
      record,
      publication,
      mode !== "dpa",
    );
    if (this.#authority.handoff.phase !== "deliver-attested-payload") {
      if (publication || readback) {
        throw new Error("non-attested terminal result has payload-attestation history");
      }
      return;
    }
    if (mode === "absent") {
      if (publication || readback) {
        throw new Error("pre-publication terminal failure has payload-attestation history");
      }
      return;
    }
    if (mode === "dpa") {
      const deliveryStarted = deliveryTerminalHistory ||
        (delivery !== undefined && !delivery.authoritativeAbsence);
      if (!publication) {
        if (!deliveryStarted) return;
        const retainedRecord = this.#authority.handoff.candidate.status === "prepared"
          ? this.#authority.handoff.candidate.delivery.payloadAttestationRecord
          : undefined;
        if (!readback || (readback.output.status === "verified" &&
            (!retainedRecord || !exact(readback.output.value.record, retainedRecord)))) {
          throw new Error("legacy attested delivery lacks its exact payload readback");
        }
        return;
      }
      if (publication.stage !== "outcome") {
        throw new Error("DPA failure retains an ambiguous payload publication");
      }
      if (publication.authoritativeAbsence) {
        if (deliveryStarted || readback) {
          throw new Error("absent payload publication has contradictory readback history");
        }
        return;
      }
      if (!deliveryStarted && publication.output?.status === "rejected") return;
      if (!deliveryStarted) {
        if (!readback) {
          throw new Error("anchored DPA publication lacks its definitive readback");
        }
        return;
      }
      if (!readback || (readback.output.status === "verified" &&
          !exact(readback.output.value.record, publication.input.record))) {
        throw new Error("delivered DPA failure lacks its exact payload readback");
      }
      return;
    }

    const requiresVerifiedHistory = delivery !== undefined ||
      publication !== undefined || readback !== undefined;
    if (!requiresVerifiedHistory) {
      // A consumed handoff imported from pre-#121 recovery may have an
      // externally terminal delivery without local payload WAL history.
      return;
    }
    if (!publication && delivery === undefined &&
        readback?.output.status === "verified") {
      // Imported pre-#121 delivery: the exact raw record is bound directly to
      // the consumed handoff even though no local publication WAL exists.
      return;
    }
    if (!publication || publication.stage !== "outcome" ||
        publication.authoritativeAbsence || !readback ||
        readback.output.status !== "verified" ||
        !exact(readback.output.value.record, publication.input.record)) {
      throw new Error(
        "attested terminal delivery lacks its exact payload publication/readback spine",
      );
    }
  }

  #assertTerminalDeliverySpine(
    record: SessionRecord,
    decision: TerminalFulfilmentResult["decision"],
    evidence: TerminalFulfilmentResult["evidence"],
  ): TerminalFailureSource | undefined {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const baseReconciliationInput: DeliveryReconciliationInput = {
      fulfilmentId: this.#authority.binding.fulfilmentId,
      jobId: this.#authority.handoff.jobId,
      phaseIndex: this.#authority.binding.deliveryPhaseIndex,
      phase: this.#authority.handoff.phase,
    };
    const dpaFailure = this.#readDpaTerminalFailure(record);
    const reconciliation = this.#readDeliveryReconciliationCheckpoint(
      record,
      baseReconciliationInput,
    );
    const delivery = this.#readDeliveryCheckpoint(record);
    const readback = this.#readTerminalDeliveryReadback(record);
    const candidate = this.#authority.handoff.candidate;
    const payloadPublication = this.#readPayloadPublicationCheckpoint(record);
    const payloadClosure = (): TerminalFailureSource["payloadClosure"] => {
      if (payloadPublication?.authoritativeAbsence) return "authoritatively-absent";
      if (payloadPublication?.output?.status === "rejected") return "rejected";
      if (payloadPublication?.output?.status === "anchored") return "anchored";
      return latestCheckpoint(
        record,
        sellerFulfilmentCheckpointKey.payloadReadback(
          this.#authority!.binding.deliveryPhaseIndex,
        ),
      )
        ? "legacy-readback"
        : "not-started";
    };
    const deliveryClosure = (): TerminalFailureSource["deliveryClosure"] => {
      if (reconciliation?.output.status === "complete") {
        return "reconciliation-complete";
      }
      if (reconciliation?.output.status === "failed") {
        return "reconciliation-failed";
      }
      if (delivery?.authoritativeAbsence) {
        return "submission-authoritatively-absent";
      }
      if (!delivery) return "opening-reconciled-absent";
      return "reconciled-absent";
    };

    const assertPreparedHistory = (): void => {
      if (candidate.status !== "prepared" || !reconciliation ||
          reconciliation.stage !== "outcome") {
        throw new Error("durable terminal result lacks its terminal delivery reconciliation");
      }
      if (delivery?.stage === "intent" ||
          (!delivery && reconciliation.input.reconciliationId !== undefined)) {
        throw new Error("durable terminal result lacks its exact delivery outcome");
      }
      this.#assertDeliveryCheckpointMatchesReconciliation(
        delivery,
        reconciliation.output,
        reconciliation.deliveryStateAtObservation,
      );
      if (reconciliation.output.status === "failed") {
        if (readback !== undefined) {
          throw new Error("failed reconciliation has a contradictory delivery readback");
        }
        return;
      }
      if (!readback) {
        throw new Error("complete reconciliation lacks its definitive delivery readback");
      }
    };

    if (dpaFailure) {
      if (dpaFailure.stage !== "outcome" || candidate.status !== "prepared" ||
          decision !== "failed" || evidence.outcome !== "failure" ||
          !evidence.reason.startsWith(DPA_TERMINAL_REASON_PREFIX) ||
          evidence.reason !== dpaFailure.data.reason ||
          evidence.observedAt !== dpaFailure.data.observedAt) {
        throw new Error("durable DPA terminal result has a contradictory delivery spine");
      }
      this.#assertTerminalPayloadSpine(
        record,
        "dpa",
        delivery,
        reconciliation !== undefined,
      );
      if (reconciliation === undefined) {
        if (delivery?.stage === "intent" ||
            delivery?.output?.status === "accepted" || readback !== undefined) {
          throw new Error("pre-delivery DPA failure has partial delivery history");
        }
      } else {
        assertPreparedHistory();
      }
      return {
        kind: "dpa",
        reason: dpaFailure.data.reason,
        observedAt: dpaFailure.data.observedAt,
        deliveryClosure: deliveryClosure(),
        payloadClosure: payloadClosure(),
      };
    }

    if (candidate.status === "prepared" && evidence.outcome === "failure" &&
        evidence.reason.startsWith(DPA_TERMINAL_REASON_PREFIX)) {
      throw new Error("reserved DPA failure evidence lacks its authenticated terminal fact");
    }

    if (candidate.status === "preparation-failed") {
      if ((reconciliation !== undefined &&
            (reconciliation.stage !== "outcome" ||
              reconciliation.output.status !== "failed" ||
              reconciliation.output.reason !== candidate.reason)) ||
          delivery !== undefined || readback !== undefined ||
          decision !== "failed" || evidence.outcome !== "failure" ||
          evidence.reason !== candidate.reason ||
          evidence.observedAt !== candidate.validatedAt) {
        throw new Error("durable preparation failure has a contradictory delivery spine");
      }
      this.#assertTerminalPayloadSpine(record, "absent", delivery);
      return {
        kind: "preparation",
        reason: candidate.reason,
        observedAt: candidate.validatedAt,
        deliveryClosure: "not-started",
        payloadClosure: "not-started",
      };
    }

    assertPreparedHistory();
    if (!reconciliation || reconciliation.stage !== "outcome") {
      throw new Error("durable terminal reconciliation disappeared");
    }
    const terminalObservation = reconciliation.output;
    this.#assertTerminalPayloadSpine(record, "verified-if-local", delivery);

    if (decision === "completed") {
      const anchoredContentHash = retainedAnchoredContentHash(this.#authority.handoff);
      if (terminalObservation.status !== "complete" ||
          evidence.outcome !== "success" ||
          terminalObservation.observedAt !== evidence.observedAt ||
          readback?.output.status !== "verified" ||
          !exact(readback.output.value.artifact, candidate.delivery.artifact) ||
          anchoredContentHash === null ||
          readback.output.value.anchorReceipt.contentHash !==
            anchoredContentHash ||
          evidence.deliverableAnchor.locator !==
            this.#authority.handoff.logicalAddress ||
          (delivery?.output?.status === "accepted" &&
            delivery.output.reconciliationId !==
              terminalObservation.reconciliationId)) {
        throw new Error("durable successful result contradicts its delivery history");
      }
      return undefined;
    }

    if (evidence.outcome !== "failure" ||
        terminalObservation.observedAt !== evidence.observedAt ||
        (terminalObservation.status === "failed"
          ? terminalObservation.reason !== evidence.reason || readback !== undefined
          : readback?.output.status === "rejected"
            ? readback.output.reason !== evidence.reason
            : readback?.output.status !== "verified")) {
      throw new Error("durable failed result contradicts its delivery history");
    }
    return {
      kind: terminalObservation.status === "failed"
        ? "delivery-reconciliation"
        : readback?.output.status === "rejected"
          ? "delivery-readback-rejection"
          : "delivery-validation",
      reason: evidence.reason,
      observedAt: evidence.observedAt,
      deliveryClosure: deliveryClosure(),
      payloadClosure: payloadClosure(),
    };
  }

  #terminalEffectSnapshotHash(record: SessionRecord): string {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const phaseIndex = this.#authority.binding.deliveryPhaseIndex;
    const keys = new Set<string>([
      sellerFulfilmentCheckpointKey.payloadPublication(phaseIndex),
      sellerFulfilmentCheckpointKey.payloadReadback(phaseIndex),
      sellerFulfilmentCheckpointKey.delivery(phaseIndex),
      sellerFulfilmentCheckpointKey.deliveryReconciliation(phaseIndex),
      sellerFulfilmentCheckpointKey.deliveryReadback(phaseIndex),
      sellerFulfilmentCheckpointKey.dpaTerminalFailure(phaseIndex),
    ]);
    return durableHash(encodeDurable(record.checkpoints
      .filter((checkpoint) => keys.has(checkpoint.key))
      .map((checkpoint) => ({
        key: checkpoint.key,
        stage: checkpoint.stage,
        ...(checkpoint.data ? { data: checkpoint.data } : {}),
      }))));
  }

  #readTerminalFailureSource(record: SessionRecord):
    | {
        stage: "intent" | "outcome";
        data: Record<string, CheckpointValue>;
        source: TerminalFailureSource;
      }
    | undefined {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const checkpoint = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.terminalFailureSource(
        this.#authority.binding.deliveryPhaseIndex,
      ),
    );
    if (!checkpoint) return undefined;
    const data = checkpoint.data;
    const kinds: readonly TerminalFailureSourceKind[] = [
      "dpa",
      "preparation",
      "delivery-reconciliation",
      "delivery-readback-rejection",
      "delivery-validation",
    ];
    if (!data || !hasExactKeys(data, [
      "fulfilmentId",
      "authorizationHash",
      "handoffBindingHash",
      "sourceKind",
      "reason",
      "observedAt",
      "deliveryClosure",
      "payloadClosure",
      "effectSnapshotHash",
    ]) || data.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        data.authorizationHash !== this.#authority.binding.authorizationHash ||
        data.handoffBindingHash !== this.#authority.binding.handoffBindingHash ||
        typeof data.sourceKind !== "string" ||
        !kinds.includes(data.sourceKind as TerminalFailureSourceKind) ||
        !isNonEmpty(data.reason) || !isSafeUint(data.observedAt) ||
        ![
          "not-started",
          "opening-reconciled-absent",
          "submission-authoritatively-absent",
          "reconciled-absent",
          "reconciliation-failed",
          "reconciliation-complete",
        ].includes(String(data.deliveryClosure)) ||
        ![
          "not-started",
          "authoritatively-absent",
          "rejected",
          "anchored",
          "legacy-readback",
        ].includes(String(data.payloadClosure)) ||
        !isHash(data.effectSnapshotHash) ||
        data.effectSnapshotHash !== this.#terminalEffectSnapshotHash(record)) {
      throw new Error("durable terminal failure source is malformed or rebound");
    }
    return {
      stage: checkpoint.stage,
      data,
      source: {
        kind: data.sourceKind as TerminalFailureSourceKind,
        reason: data.reason,
        observedAt: data.observedAt,
        deliveryClosure: data.deliveryClosure as TerminalFailureSource["deliveryClosure"],
        payloadClosure: data.payloadClosure as TerminalFailureSource["payloadClosure"],
      },
    };
  }

  async #ensureTerminalFailureSource(
    source: TerminalFailureSource,
  ): Promise<void> {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const key = sellerFulfilmentCheckpointKey.terminalFailureSource(
      this.#authority.binding.deliveryPhaseIndex,
    );
    const record = await this.#load();
    const data = {
      fulfilmentId: this.#authority.binding.fulfilmentId,
      authorizationHash: this.#authority.binding.authorizationHash,
      handoffBindingHash: this.#authority.binding.handoffBindingHash,
      sourceKind: source.kind,
      reason: source.reason,
      observedAt: source.observedAt,
      deliveryClosure: source.deliveryClosure,
      payloadClosure: source.payloadClosure,
      effectSnapshotHash: this.#terminalEffectSnapshotHash(record),
    };
    const claimed = await this.#claim(
      key,
      data,
      phase("evidence-pending", this.#authority.binding.deliveryPhaseIndex),
      true,
    );
    if (!exact(claimed.data, data)) {
      throw new Error("durable terminal failure source changed before evidence publication");
    }
    if (claimed.state !== "outcome") {
      await this.#appendOutcome(key, claimed.data, claimed.data);
    }
  }

  #evidenceTerminalSource(
    record: SessionRecord,
    input: Readonly<EvidenceAnchorInput>,
  ): TerminalSourceIdentity {
    if (!this.#authority || !this.#evidenceAnchorInputBindsAuthority(input)) {
      throw new Error("durable evidence publication input is rebound");
    }
    const decision: TerminalFulfilmentResult["decision"] =
      input.evidence.outcome === "success" ? "completed" : "failed";
    const expectedFailureSource = this.#assertTerminalDeliverySpine(
      record,
      decision,
      input.evidence,
    );
    const retainedFailureSource = this.#readTerminalFailureSource(record);
    if (expectedFailureSource) {
      if (retainedFailureSource &&
          !exact(retainedFailureSource.source, expectedFailureSource)) {
        throw new Error("durable evidence changed its terminal failure source");
      }
    } else if (retainedFailureSource) {
      throw new Error("successful evidence contradicts a retained terminal failure source");
    }
    return {
      decision,
      effectSnapshotHash: this.#terminalEffectSnapshotHash(record),
      failureSource: expectedFailureSource ?? null,
    };
  }

  async #commitEvidenceTerminalSource(
    input: Readonly<EvidenceAnchorInput>,
    expectedIdentity: Readonly<TerminalSourceIdentity>,
  ): Promise<void> {
    // #walEffect calls this only after the evidence intent is durably claimed.
    // That intent is therefore the commit point for the exact signed outcome;
    // a crash cannot leave a free-standing failure source that poisons a later
    // evidence choice.
    await this.#authenticateEvidenceAnchorInput(input);
    let record = await this.#load();
    let identity = this.#evidenceTerminalSource(record, input);
    if (!exact(identity, expectedIdentity)) {
      throw new Error("durable evidence terminal source changed after intent");
    }
    if (identity.failureSource) {
      await this.#ensureTerminalFailureSource(identity.failureSource);
      record = await this.#load();
      identity = this.#evidenceTerminalSource(record, input);
      const retained = this.#readTerminalFailureSource(record);
      if (retained?.stage !== "outcome" ||
          !exact(retained.source, identity.failureSource)) {
        throw new Error("durable terminal failure source did not commit before evidence");
      }
    }
    if (!exact(identity, expectedIdentity)) {
      throw new Error("durable evidence terminal source changed before publication");
    }
  }

  async #readEvidencePublicationCheckpoint(
    record: SessionRecord,
  ): Promise<RetainedEvidencePublicationCheckpoint | undefined> {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const checkpoint = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.evidencePublication(
        this.#authority.binding.deliveryPhaseIndex,
      ),
    );
    if (!checkpoint) return undefined;
    const data = checkpoint.data;
    if (!data || !hasExactKeys(data, [
      "fulfilmentId",
      "idempotencyKey",
      "identityHash",
      "inputHash",
      "input",
      ...(checkpoint.stage === "outcome" ? ["outputHash", "output"] : []),
    ]) || data.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        data.idempotencyKey !== `evidence:${this.#authority.binding.fulfilmentId}` ||
        !isHash(data.identityHash) || typeof data.input !== "string" ||
        !isHash(data.inputHash) || durableHash(data.input) !== data.inputHash) {
      throw new Error("durable evidence-publication checkpoint is malformed");
    }
    const input = decodeDurable<unknown>(data.input);
    if (!this.#evidenceAnchorInputBindsAuthority(input)) {
      throw new Error("durable evidence-publication input is rebound");
    }
    await this.#authenticateEvidenceAnchorInput(input);
    const terminalSource = this.#evidenceTerminalSource(record, input);
    if (data.identityHash !== durableHash(encodeDurable({
      fulfilmentId: input.fulfilmentId,
      evidenceHash: input.evidenceHash,
      terminalSource,
    }))) {
      throw new Error("durable evidence-publication identity is rebound");
    }
    const retainedSource = this.#readTerminalFailureSource(record);
    if (checkpoint.stage === "outcome" && terminalSource.failureSource &&
        (retainedSource?.stage !== "outcome" ||
          !exact(retainedSource.source, terminalSource.failureSource))) {
      throw new Error("durable evidence outcome lacks its committed failure source");
    }
    if (checkpoint.stage === "intent") {
      return {
        stage: "intent",
        data,
        input: clone(input),
        terminalSource,
      };
    }
    if (typeof data.output !== "string" || !isHash(data.outputHash) ||
        durableHash(data.output) !== data.outputHash) {
      throw new Error("durable evidence-publication outcome is malformed");
    }
    const output = decodeDurable<unknown>(data.output);
    if (!isDefinitiveEvidenceAnchorResult(output, input) ||
        output.status !== "anchored") {
      throw new Error("durable evidence-publication outcome is not anchored");
    }
    return {
      stage: "outcome",
      data,
      input: clone(input),
      terminalSource,
      output: clone(output),
    };
  }

  #assertTerminalEvidenceSpine(
    record: SessionRecord,
    result: TerminalFulfilmentResult,
  ): void {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const expectedFailureSource = this.#assertTerminalDeliverySpine(
      record,
      result.decision,
      result.evidence,
    );
    const retainedFailureSource = this.#readTerminalFailureSource(record);
    if (expectedFailureSource) {
      if (retainedFailureSource?.stage !== "outcome" ||
          !exact(retainedFailureSource.source, expectedFailureSource)) {
        throw new Error("durable terminal failure lacks its exact source checkpoint");
      }
    } else if (retainedFailureSource) {
      throw new Error("durable successful result has a contradictory failure source");
    }
    const terminalSourceIdentity = {
      decision: result.decision,
      effectSnapshotHash: this.#terminalEffectSnapshotHash(record),
      failureSource: expectedFailureSource ?? null,
    };
    const phaseIndex = this.#authority.binding.deliveryPhaseIndex;
    const handoff = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.handoff(phaseIndex),
    );
    if (handoff?.stage !== "outcome" || !handoff.data ||
        !hasExactKeys(handoff.data, [
          "fulfilmentId",
          "handoffBindingHash",
          "handoff",
        ]) || handoff.data.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        handoff.data.handoffBindingHash !== this.#authority.binding.handoffBindingHash ||
        handoff.data.handoff !== this.#authority.handoffEncoded) {
      throw new Error("durable terminal result lacks its exact consumed handoff");
    }
    const publication = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.evidencePublication(phaseIndex),
    );
    const publicationData = publication?.data;
    if (publication?.stage !== "outcome" || !publicationData ||
        !hasExactKeys(publicationData, [
          "fulfilmentId",
          "idempotencyKey",
          "identityHash",
          "inputHash",
          "input",
          "outputHash",
          "output",
        ]) || publicationData.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        publicationData.idempotencyKey !==
          `evidence:${this.#authority.binding.fulfilmentId}` ||
        typeof publicationData.input !== "string" || !isHash(publicationData.inputHash) ||
        durableHash(publicationData.input) !== publicationData.inputHash ||
        typeof publicationData.output !== "string" || !isHash(publicationData.outputHash) ||
        durableHash(publicationData.output) !== publicationData.outputHash) {
      throw new Error("durable terminal result lacks its evidence publication outcome");
    }
    const publicationInput = decodeDurable<unknown>(publicationData.input);
    const expectedPublicationIdentityHash = isRecord(publicationInput)
      ? durableHash(encodeDurable({
          fulfilmentId: publicationInput.fulfilmentId,
          evidenceHash: publicationInput.evidenceHash,
          terminalSource: terminalSourceIdentity,
        }))
      : "";
    if (!isRecord(publicationInput) || !hasExactKeys(publicationInput, [
      "fulfilmentId",
      "evidence",
      "evidenceHash",
    ]) || publicationInput.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        publicationInput.evidenceHash !== result.evidenceHash ||
        !exact(publicationInput.evidence, result.evidence) ||
        publicationData.identityHash !== expectedPublicationIdentityHash) {
      throw new Error("durable evidence publication input is rebound");
    }
    const publicationOutput = decodeDurable<unknown>(publicationData.output);
    if (!isEvidenceAnchorResult(publicationOutput) ||
        publicationOutput.status !== "anchored" ||
        !exact(publicationOutput.ref, result.evidenceRef) ||
        !exact(publicationOutput.anchorReceipt, result.evidenceAnchorReceipt)) {
      throw new Error("durable evidence publication output contradicts terminal evidence");
    }

    const readback = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.evidenceReadback(phaseIndex),
    );
    const readbackData = readback?.data;
    if (readback?.stage !== "outcome" || !readbackData ||
        !hasExactKeys(readbackData, [
          "fulfilmentId",
          "inputHash",
          "identityHash",
          "input",
          "outputHash",
          "output",
        ]) || readbackData.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        typeof readbackData.input !== "string" || !isHash(readbackData.inputHash) ||
        durableHash(readbackData.input) !== readbackData.inputHash ||
        typeof readbackData.output !== "string" || !isHash(readbackData.outputHash) ||
        durableHash(readbackData.output) !== readbackData.outputHash) {
      throw new Error("durable terminal result lacks its evidence readback outcome");
    }
    const readbackInput = decodeDurable<unknown>(readbackData.input);
    if (!exact(readbackInput, result.evidenceRef) ||
        readbackData.identityHash !== durableHash(encodeDurable(result.evidenceRef))) {
      throw new Error("durable evidence readback input is rebound");
    }
    const readbackOutput = decodeDurable<unknown>(readbackData.output);
    if (!isEvidenceReadback(readbackOutput, result.evidenceRef) ||
        readbackOutput.status !== "verified" ||
        !exact(readbackOutput.value, result.evidence)) {
      throw new Error("durable evidence readback contradicts terminal evidence");
    }
  }

  #decodeTerminal(record: SessionRecord): TerminalFulfilmentResult | undefined {
    const key = sellerFulfilmentCheckpointKey.result(
      this.#authority!.binding.deliveryPhaseIndex,
    );
    const checkpoint = latestCheckpoint(record, key);
    if (!checkpoint || checkpoint.stage !== "outcome") return undefined;
    const data = checkpoint.data;
    if (!data || !hasExactKeys(data, [
      "fulfilmentId",
      "authorizationHash",
      "handoffBindingHash",
      "resultHash",
      "result",
      "finalOutputHash",
      "finalReceiptHash",
    ]) ||
        data.fulfilmentId !== this.#authority!.binding.fulfilmentId ||
        data.authorizationHash !== this.#authority!.binding.authorizationHash ||
        data.handoffBindingHash !== this.#authority!.binding.handoffBindingHash) {
      throw new Error("durable terminal result is malformed");
    }
    const encoded = data.result;
    const resultHash = data.resultHash;
    if (typeof encoded !== "string" || !isHash(resultHash) ||
        durableHash(encoded) !== resultHash || !isHash(data.finalOutputHash) ||
        !isHash(data.finalReceiptHash)) {
      throw new Error("durable terminal result hashes are malformed");
    }
    const result = decodeDurable<TerminalFulfilmentResult>(encoded);
    this.#assertTerminalResult(result);
    this.#assertTerminalEvidenceSpine(record, result);
    const finalReceipt = this.#readFinalReceiptCheckpoint(record);
    if (!finalReceipt || finalReceipt.stage !== "outcome" ||
        !finalReceipt.output || !finalReceipt.outputEncoded ||
        !exact(finalReceipt.input.result, result) ||
        finalReceipt.input.resultHash !== resultHash ||
        durableHash(finalReceipt.outputEncoded) !== data.finalOutputHash) {
      throw new Error("durable terminal result lacks its exact final receipt outcome");
    }
    const receiptHash = durableHash(encodeDurable(finalReceipt.output.receipt));
    const indexedReceipt = record.receipts.find(
      (receipt) => sessionReceiptKey(receipt) ===
        `fulfilment:${this.#authority!.binding.deliveryPhaseIndex}`,
    );
    const agreementReceipt = record.receipts.find(
      (receipt) => sessionReceiptKey(receipt) === "agreement",
    );
    const settlementReceipt = record.receipts.find(
      (receipt) => sessionReceiptKey(receipt) ===
        `settlement:${this.#authority!.binding.paymentPhaseIndex}`,
    );
    const deliveryReceipt = record.receipts.find(
      (receipt) => sessionReceiptKey(receipt) ===
        `delivery:${this.#authority!.binding.deliveryPhaseIndex}`,
    );
    if (receiptHash !== data.finalReceiptHash || indexedReceipt?.ref !== receiptHash ||
        agreementReceipt?.ref !== this.#authority!.handoff.agreementRef ||
        settlementReceipt?.ref !== this.#authority!.binding.settlementId ||
        deliveryReceipt?.ref !== result.evidenceRef.anchor.locator ||
        !terminalPhaseStillRepresented(
          record.phase,
          result,
          this.#authority!.binding.deliveryPhaseIndex,
        )) {
      throw new Error("durable terminal result has a missing or rebound receipt/phase");
    }
    return result;
  }

  async #renew(): Promise<void> {
    if (!this.#authority || !this.#leaseToken) {
      throw new Error("durable lease authority is unavailable");
    }
    const renewed = await this.#durability.store.renewLease({
      jobId: this.#authority.handoff.jobId,
      leaseToken: this.#leaseToken,
      ttlMs: this.#durability.leaseTtlMs,
      now: this.#now(),
    });
    if (!renewed.ok) throw new Error(`durable lease is stale: ${renewed.reason}`);
  }

  async #claim(
    key: string,
    data: Record<string, CheckpointValue>,
    nextPhase: string,
    allowPhasePreservingFresh = false,
  ): Promise<ClaimedWal> {
    if (!this.#authority || !this.#leaseToken) throw new Error("durable lease is unavailable");
    await this.#renew();
    const current = await this.#load();
    let claimPhase: string | undefined = nextPhase;
    if (sessionPhaseMutationFailure(current, nextPhase) && allowPhasePreservingFresh) {
      const currentMatch = SELLER_DELIVERY_PHASE_RE.exec(current.phase);
      const nextMatch = SELLER_DELIVERY_PHASE_RE.exec(nextPhase);
      const currentIndex = currentMatch ? Number(currentMatch[1]) : NaN;
      const nextIndex = nextMatch ? Number(nextMatch[1]) : NaN;
      if (!Number.isSafeInteger(currentIndex) || currentIndex !== nextIndex ||
          currentIndex !== this.#authority.binding.deliveryPhaseIndex) {
        throw new Error(`durable WAL ${key} cannot regress or escape its seller phase`);
      }
      // Recovery may discover an earlier effect/readback only after a later
      // stage was durably observed. Claim the missing checkpoint without
      // demoting the global phase; its indexed key and lease still fence it.
      claimPhase = undefined;
    }
    const result = await this.#durability.store.claimCheckpoint({
      jobId: this.#authority.handoff.jobId,
      key,
      data: clone(data),
      ...(claimPhase === undefined ? {} : { phase: claimPhase }),
      leaseToken: this.#leaseToken,
      now: this.#now(),
    });
    if (result.ok) return { state: "fresh", record: result.record, data };
    if ((result.reason !== "held" && result.reason !== "completed") || !result.record) {
      throw new Error(`durable WAL claim ${key} failed: ${result.reason}`);
    }
    const checkpoint = latestCheckpoint(result.record, key);
    if (!checkpoint?.data || checkpoint.data.fulfilmentId !== data.fulfilmentId) {
      throw new Error(`durable WAL ${key} binds another fulfilment`);
    }
    return {
      state: result.reason === "completed" ? "outcome" : "intent",
      record: result.record,
      data: checkpoint.data,
    };
  }

  async #appendOutcome(
    key: string,
    expectedIntentData: Record<string, CheckpointValue>,
    outcomeData: Record<string, CheckpointValue>,
    options: { phase?: string; release?: boolean; receiptRef?: string } = {},
  ): Promise<SessionRecord> {
    if (!this.#authority || !this.#leaseToken) throw new Error("durable lease is unavailable");
    for (let attempt = 0; attempt < 16; attempt += 1) {
      await this.#renew();
      const record = await this.#load();
      const checkpoint = latestCheckpoint(record, key);
      if (checkpoint?.stage === "outcome") {
        if (!exact(checkpoint.data, outcomeData)) {
          throw new Error(`durable WAL ${key} has a contradictory outcome`);
        }
        return record;
      }
      if (checkpoint?.stage !== "intent") {
        throw new Error(`durable WAL ${key} has no write-ahead intent`);
      }
      if (!exact(checkpoint.data ?? {}, expectedIntentData)) {
        throw new Error(`durable WAL ${key} intent changed before outcome`);
      }
      const transitioned = await this.#durability.store.transition({
        jobId: this.#authority.handoff.jobId,
        expectedRevision: record.revision,
        leaseToken: this.#leaseToken,
        ...(options.phase ? { phase: options.phase } : {}),
        checkpoint: { key, stage: "outcome", data: clone(outcomeData) },
        ...(options.receiptRef
          ? {
              receipt: {
                kind: "fulfilment" as const,
                ref: options.receiptRef,
                phaseIndex: this.#authority.binding.deliveryPhaseIndex,
              },
            }
          : {}),
        ...(options.release ? { lease: null } : {}),
        now: this.#now(),
      });
      if (transitioned.ok) return transitioned.record;
      if (transitioned.reason !== "revision-mismatch") {
        throw new Error(`durable WAL outcome ${key} failed: ${transitioned.reason}`);
      }
    }
    throw new Error(`durable WAL outcome ${key} exceeded CAS retries`);
  }

  async #ensureReceipt(receipt: SessionReceipt): Promise<void> {
    if (!this.#authority || !this.#leaseToken) throw new Error("durable lease is unavailable");
    const expectedKey = sessionReceiptKey(receipt);
    for (let attempt = 0; attempt < 16; attempt += 1) {
      await this.#renew();
      const record = await this.#load();
      const existing = record.receipts.find(
        (candidate) => sessionReceiptKey(candidate) === expectedKey,
      );
      if (existing) {
        if (existing.ref !== receipt.ref) {
          throw new Error(`durable receipt ${expectedKey} is rebound`);
        }
        return;
      }
      const transitioned = await this.#durability.store.transition({
        jobId: this.#authority.handoff.jobId,
        expectedRevision: record.revision,
        leaseToken: this.#leaseToken,
        receipt: clone(receipt),
        now: this.#now(),
      });
      if (transitioned.ok) return;
      if (transitioned.reason !== "revision-mismatch") {
        throw new Error(`durable receipt ${expectedKey} failed: ${transitioned.reason}`);
      }
    }
    throw new Error(`durable receipt ${expectedKey} exceeded CAS retries`);
  }

  #fence(idempotencyKey: string): SellerEffectFence {
    if (!this.#leaseToken) throw new Error("durable lease is unavailable");
    return Object.freeze({ ...this.#leaseToken, idempotencyKey });
  }

  async #withHeartbeat<T>(operation: () => Promise<T>): Promise<T> {
    await this.#renew();
    let stopped = false;
    let heartbeatError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interval = Math.max(1, Math.floor(this.#durability.leaseTtlMs / 3));
    const tick = (): void => {
      timer = setTimeout(() => {
        void this.#renew()
          .catch((error) => { heartbeatError = error; })
          .finally(() => { if (!stopped && heartbeatError === undefined) tick(); });
      }, interval);
    };
    tick();
    try {
      const value = await operation();
      if (heartbeatError !== undefined) throw heartbeatError;
      await this.#renew();
      return value;
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
    }
  }

  async #walEffect<I, O>(options: {
    key: string;
    stage: string;
    idempotencyKey: string;
    input: I;
    identity: unknown;
    deriveIdentity?: (input: Readonly<I>) => unknown;
    validatePersistedInput?: (input: unknown) => input is I;
    authenticatePersistedInput?: (input: Readonly<I>) => Promise<void>;
    requireExactInputOnResume?: boolean;
    invoke(input: Fenced<I>): Promise<O>;
    reconcile(input: Fenced<I>): Promise<O | SellerEffectAuthoritativeAbsence>;
    validate(output: unknown, input: Readonly<I>): output is O;
    indeterminate(output: O): boolean;
    onError(error: unknown): O;
  }): Promise<O> {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const input = clone(options.input);
    const encodedInput = encodeDurable(input);
    const inputHash = durableHash(encodedInput);
    const identityEncoded = encodeDurable(options.identity);
    const identityHash = durableHash(identityEncoded);
    const intentData = {
      fulfilmentId: this.#authority.binding.fulfilmentId,
      idempotencyKey: options.idempotencyKey,
      identityHash,
      inputHash,
      input: encodedInput,
    };
    const claimed = await this.#claim(options.key, intentData, options.stage);
    if (
      claimed.data.idempotencyKey !== options.idempotencyKey ||
      claimed.data.identityHash !== identityHash ||
      typeof claimed.data.input !== "string" ||
      !isHash(claimed.data.inputHash) ||
      durableHash(claimed.data.input) !== claimed.data.inputHash ||
      (options.requireExactInputOnResume !== false && claimed.data.inputHash !== inputHash)
    ) {
      throw new Error(`durable WAL ${options.key} input binding mismatch`);
    }
    const persistedInput = decodeDurable<I>(claimed.data.input);
    if (options.validatePersistedInput &&
        !options.validatePersistedInput(persistedInput)) {
      throw new Error(`durable WAL ${options.key} retained a rebound input`);
    }
    const persistedIdentityHash = durableHash(encodeDurable(
      options.deriveIdentity
        ? options.deriveIdentity(persistedInput)
        : options.identity,
    ));
    if (persistedIdentityHash !== claimed.data.identityHash) {
      throw new Error(`durable WAL ${options.key} identity contradicts its input`);
    }
    if (options.authenticatePersistedInput) {
      await options.authenticatePersistedInput(persistedInput);
    }
    if (claimed.state === "outcome") {
      if (typeof claimed.data.output !== "string" || !isHash(claimed.data.outputHash) ||
          durableHash(claimed.data.output) !== claimed.data.outputHash) {
        throw new Error(`durable WAL ${options.key} outcome is malformed`);
      }
      const replay = decodeDurable<unknown>(claimed.data.output);
      if (!options.validate(replay, persistedInput)) {
        throw new Error(`durable WAL ${options.key} persisted a malformed output`);
      }
      return clone(replay);
    }
    if (!hasExactKeys(claimed.data, [
      "fulfilmentId",
      "idempotencyKey",
      "identityHash",
      "inputHash",
      "input",
    ])) {
      throw new Error(`durable WAL ${options.key} intent has unexpected fields`);
    }
    const fence = this.#fence(options.idempotencyKey);
    const callExact = async <T>(
      operation: (input: Fenced<I>) => Promise<T>,
      label: "invoke" | "reconcile",
    ): Promise<T> => {
      const adapterInput = Object.assign(clone(persistedInput) as object, { fence }) as Fenced<I>;
      const before = encodeDurable(adapterInput);
      const result = clone(await this.#withHeartbeat(() => operation(adapterInput)));
      if (encodeDurable(adapterInput) !== before) {
        throw new Error(
          `durable effect ${label} mutated ${options.key} input/fence`,
        );
      }
      return result;
    };
    let output: O;
    try {
      if (claimed.state === "fresh") {
        output = await callExact(options.invoke, "invoke");
      } else {
        const reconciled = await callExact(options.reconcile, "reconcile");
        if (isAuthoritativeAbsence(reconciled)) {
          // The old generation may have died after committing its intent but
          // before invoking. Exact authoritative absence plus adapter-side
          // owner/generation fencing makes one invocation by this generation safe.
          output = await callExact(options.invoke, "invoke");
        } else if (options.validate(reconciled, persistedInput)) {
          output = reconciled;
        } else {
          throw new TypeError(
            `durable effect ${options.key} reconciler returned a malformed output`,
          );
        }
      }
    } catch (error) {
      output = clone(options.onError(error));
    }
    if (!options.validate(output, persistedInput)) {
      output = clone(options.onError(
        new TypeError(`durable effect ${options.key} returned a malformed output`),
      ));
    }
    if (!options.validate(output, persistedInput)) {
      throw new Error(`durable effect ${options.key} error mapper is malformed`);
    }
    if (options.indeterminate(output)) return output;
    const encodedOutput = encodeDurable(output);
    await this.#appendOutcome(options.key, claimed.data, {
      ...claimed.data,
      outputHash: durableHash(encodedOutput),
      output: encodedOutput,
    });
    return clone(output);
  }

  async inspectPermit(permitId: string): Promise<SellerReceiptInspectionResult> {
    const result = clone(await this.#deps.receiptStore.inspectPermit(permitId));
    if (result.status === "already-consumed") {
      await this.establish(result.claim, result.handoff);
    }
    return result;
  }

  async consumePermit(
    permitId: string,
    handoff: Readonly<SellerFulfilmentHandoff>,
  ): Promise<SellerReceiptPermitResult> {
    try {
      const result = clone(await this.#deps.receiptStore.consumePermit(permitId, clone(handoff)));
      if (result.status === "consumed" || result.status === "already-consumed") {
        await this.establish(result.claim, result.handoff);
      }
      return result;
    } catch (error) {
      // Consumption may have committed before its response was lost. Inspecting
      // and binding the store-retained handoff closes that crash window without
      // trusting the caller's proposed handoff.
      try {
        const inspection = clone(await this.#deps.receiptStore.inspectPermit(permitId));
        if (inspection.status === "already-consumed") {
          await this.establish(inspection.claim, inspection.handoff);
          // The authoritative store has proved both consumption and the exact
          // retained handoff. Return that proof so #120 can set its public
          // consumed-authorization context and continue in this same run.
          return inspection;
        }
      } catch {
        // Preserve the original ambiguous consumption error for #120.
      }
      throw error;
    }
  }

  claimReceipt(input: Readonly<SellerReceiptClaim>) {
    return this.#deps.receiptStore.claim(clone(input));
  }

  hasAuthority(): boolean {
    return this.#authority !== undefined;
  }

  consumedPaymentAuthorization(): SellerPaymentAuthorization | undefined {
    return this.#authority
      ? clone(this.#authority.claim.authorization)
      : undefined;
  }

  async prepareDelivery(
    input: Parameters<SellerFulfilmentDeps["prepareDelivery"]>[0],
  ): Promise<Awaited<ReturnType<SellerFulfilmentDeps["prepareDelivery"]>>> {
    const output = clone(await this.#deps.prepareDelivery(input));
    if (isRecord(output) && output.status === "rejected" && isNonEmpty(output.reason)) {
      return {
        ...output,
        reason: nonDpaTerminalReason(output.reason),
      } as Awaited<ReturnType<SellerFulfilmentDeps["prepareDelivery"]>>;
    }
    return output;
  }

  async terminalNeedsDpaReplay(result: SellerFulfilmentResult): Promise<boolean> {
    if (!this.#authority) return false;
    const failure = this.#readDpaTerminalFailure(await this.#load());
    if (!failure) return false;
    return result.decision !== "failed" || result.evidence.outcome !== "failure" ||
      result.evidence.reason !== failure.data.reason ||
      result.evidence.observedAt !== failure.data.observedAt;
  }

  async payloadPublication(input: PayloadAnchorInput): Promise<SellerEvidenceAnchorResult> {
    if (!this.#authority || !this.#deps.anchorPayloadAttestation) {
      return { status: "rejected", reason: "payload publication is unavailable" };
    }
    return this.#walEffect({
      key: sellerFulfilmentCheckpointKey.payloadPublication(
        this.#authority.binding.deliveryPhaseIndex,
      ),
      stage: phase("delivery-pending", this.#authority.binding.deliveryPhaseIndex),
      idempotencyKey: `payload:${this.#authority.binding.fulfilmentId}`,
      input,
      identity: { recordHash: input.recordHash, ref: input.ref },
      invoke: (fenced) => this.#deps.anchorPayloadAttestation!(fenced),
      reconcile: (fenced) => this.#durability.reconcilePayloadAttestation(fenced),
      validate: isDefinitivePayloadAnchorResult,
      indeterminate: (output) => output.status !== "anchored",
      onError: (error) => ({ status: "indeterminate", reason: String(error) }),
    });
  }

  #readPayloadPublicationCheckpoint(
    record: SessionRecord,
  ): RetainedPayloadPublicationCheckpoint | undefined {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const checkpoint = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.payloadPublication(
        this.#authority.binding.deliveryPhaseIndex,
      ),
    );
    if (!checkpoint) return undefined;
    const data = checkpoint.data;
    const hasAuthoritativeAbsence = checkpoint.stage === "outcome" &&
      data?.authoritativeAbsence === true;
    if (!data || !hasExactKeys(data, [
      "fulfilmentId",
      "idempotencyKey",
      "identityHash",
      "inputHash",
      "input",
      ...(checkpoint.stage === "outcome" ? ["outputHash", "output"] : []),
      ...(hasAuthoritativeAbsence ? ["authoritativeAbsence"] : []),
    ]) || data.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        data.idempotencyKey !== `payload:${this.#authority.binding.fulfilmentId}` ||
        typeof data.input !== "string" || !isHash(data.inputHash) ||
        durableHash(data.input) !== data.inputHash || !isHash(data.identityHash)) {
      throw new Error("durable payload-publication checkpoint is malformed");
    }
    const input = decodeDurable<unknown>(data.input);
    const candidate = this.#authority.handoff.candidate;
    const artifact = candidate.status === "prepared"
      ? candidate.delivery.artifact
      : undefined;
    const retainedRecord = candidate.status === "prepared"
      ? candidate.delivery.payloadAttestationRecord
      : undefined;
    if (this.#authority.handoff.phase !== "deliver-attested-payload" ||
        candidate.status !== "prepared" || !isRecord(artifact) ||
        !isRecord(input) || !hasExactKeys(input, ["record", "recordHash", "ref"]) ||
        !isRecord(input.record) || !isHash(input.recordHash) ||
        !isAttestationRef(input.ref) || !exact(input.record, retainedRecord) ||
        !exact(input.ref, artifact.attestationRef) ||
        signedEvidenceHash(input.record) !== input.recordHash ||
        input.ref.contentHash !== input.recordHash ||
        data.identityHash !== durableHash(encodeDurable({
          recordHash: input.recordHash,
          ref: input.ref,
        }))) {
      throw new Error("durable payload-publication input contradicts consumed handoff");
    }
    const typedInput = clone(input) as PayloadAnchorInput;
    if (checkpoint.stage === "intent") {
      return { stage: "intent", data, input: typedInput };
    }
    if (typeof data.output !== "string" || !isHash(data.outputHash) ||
        durableHash(data.output) !== data.outputHash) {
      throw new Error("durable payload-publication outcome is malformed");
    }
    const output = decodeDurable<unknown>(data.output);
    if (!isDefinitivePayloadAnchorResult(output, typedInput) ||
        output.status === "indeterminate" ||
        (hasAuthoritativeAbsence &&
          (output.status !== "rejected" || output.reason !== DPA_PAYLOAD_ABSENCE_REASON))) {
      throw new Error("durable payload-publication outcome is not definitive");
    }
    return {
      stage: "outcome",
      data,
      input: typedInput,
      output: clone(output),
      ...(hasAuthoritativeAbsence ? { authoritativeAbsence: true as const } : {}),
    };
  }

  #readTerminalPayloadReadback(
    record: SessionRecord,
    publication = this.#readPayloadPublicationCheckpoint(record),
    requireExactRecord = true,
  ):
    | {
        input: SellerAttestationRef;
        output: Exclude<PayloadReadback, { status: "indeterminate" }>;
      }
    | undefined {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const checkpoint = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.payloadReadback(
        this.#authority.binding.deliveryPhaseIndex,
      ),
    );
    if (!checkpoint) return undefined;
    const data = checkpoint.data;
    if (checkpoint.stage !== "outcome" || !data || !hasExactKeys(data, [
      "fulfilmentId",
      "inputHash",
      "identityHash",
      "input",
      "outputHash",
      "output",
    ]) || data.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        typeof data.input !== "string" || !isHash(data.inputHash) ||
        durableHash(data.input) !== data.inputHash || !isHash(data.identityHash) ||
        typeof data.output !== "string" || !isHash(data.outputHash) ||
        durableHash(data.output) !== data.outputHash) {
      throw new Error("durable terminal payload readback is malformed");
    }
    const candidate = this.#authority.handoff.candidate;
    const ref = candidate.status === "prepared" &&
        this.#authority.handoff.phase === "deliver-attested-payload" &&
        isRecord(candidate.delivery.artifact) &&
        isAttestationRef(candidate.delivery.artifact.attestationRef)
      ? candidate.delivery.artifact.attestationRef
      : undefined;
    const input = decodeDurable<unknown>(data.input);
    if (!ref || !isAttestationRef(input) || !exact(input, ref) ||
        data.identityHash !== durableHash(encodeDurable(input))) {
      throw new Error("durable terminal payload readback input is rebound");
    }
    const output = decodeDurable<unknown>(data.output);
    const retainedRecord = publication?.input.record ??
      (candidate.status === "prepared"
        ? candidate.delivery.payloadAttestationRecord
        : undefined);
    if (!isPayloadReadback(output, input) || output.status === "indeterminate" ||
        (requireExactRecord && output.status === "verified" &&
          (!retainedRecord || !exact(output.value.record, retainedRecord)))) {
      throw new Error("durable terminal payload readback is not definitive or exact");
    }
    return {
      input: clone(input),
      output: clone(output),
    };
  }

  async #settlePayloadIntentForDpa(): Promise<boolean> {
    if (!this.#authority) return false;
    const checkpoint = this.#readPayloadPublicationCheckpoint(await this.#load());
    if (!checkpoint || checkpoint.stage === "outcome") return true;
    const fence = this.#fence(`payload:${this.#authority.binding.fulfilmentId}`);
    const callbackInput = Object.assign(clone(checkpoint.input) as object, { fence }) as
      Fenced<PayloadAnchorInput>;
    const before = encodeDurable(callbackInput);
    const reconciled = clone(await this.#withHeartbeat(() =>
      this.#durability.reconcilePayloadAttestation(callbackInput)
    ));
    if (encodeDurable(callbackInput) !== before) {
      throw new Error("payload reconciliation mutated the retained DPA input");
    }
    let outcome: SellerEvidenceAnchorResult;
    if (isAuthoritativeAbsence(reconciled)) {
      outcome = {
        status: "rejected",
        reason: DPA_PAYLOAD_ABSENCE_REASON,
      };
    } else if (isDefinitivePayloadAnchorResult(reconciled, checkpoint.input)) {
      if (reconciled.status === "indeterminate") return false;
      outcome = reconciled;
    } else {
      throw new Error("payload reconciliation returned a malformed DPA fence result");
    }
    const encodedOutput = encodeDurable(outcome);
    await this.#appendOutcome(
      sellerFulfilmentCheckpointKey.payloadPublication(
        this.#authority.binding.deliveryPhaseIndex,
      ),
      checkpoint.data,
      {
        ...checkpoint.data,
        outputHash: durableHash(encodedOutput),
        output: encodedOutput,
        ...(isAuthoritativeAbsence(reconciled)
          ? { authoritativeAbsence: true }
          : {}),
      },
    );
    return true;
  }

  async deliverySubmission(input: DeliverySubmitInput): Promise<SellerDeliverySubmission> {
    if (!this.#authority) {
      return { status: "indeterminate", reason: "consumed authority is unavailable" };
    }
    if (!this.#deliverySubmissionInputBindsAuthority(input)) {
      return { status: "indeterminate", reason: "delivery input contradicts consumed handoff" };
    }
    return this.#walEffect({
      key: sellerFulfilmentCheckpointKey.delivery(
        this.#authority.binding.deliveryPhaseIndex,
      ),
      stage: phase("delivery-pending", this.#authority.binding.deliveryPhaseIndex),
      idempotencyKey: `delivery:${this.#authority.binding.fulfilmentId}`,
      input,
      identity: {
        fulfilmentId: input.fulfilmentId,
        artifactHash: input.artifactHash,
      },
      invoke: (fenced) => this.#deps.submitDelivery(fenced),
      reconcile: (fenced) => this.#durability.reconcileDeliverySubmission(fenced),
      validate: isDeliverySubmission,
      indeterminate: (output) => output.status === "indeterminate",
      onError: (error) => ({ status: "indeterminate", reason: String(error) }),
    });
  }

  #deliverySubmissionInputBindsAuthority(value: unknown): value is DeliverySubmitInput {
    if (!this.#authority || this.#authority.handoff.candidate.status !== "prepared" ||
        !isRecord(value) || !hasExactKeys(value, [
          "fulfilmentId",
          "jobId",
          "phaseIndex",
          "phase",
          "logicalAddress",
          "agreement",
          "deliverable",
          "artifact",
          "artifactHash",
        ]) || !isRecord(value.agreement) || !isRecord(value.deliverable) ||
        !isRecord(value.artifact) || !isRecord(value.agreement.commitment) ||
        !isRecord(value.agreement.deliverableRef)) return false;
    const authorization = this.#authority.claim.authorization;
    try {
      return value.fulfilmentId === this.#authority.binding.fulfilmentId &&
        value.jobId === this.#authority.handoff.jobId &&
        value.phaseIndex === this.#authority.binding.deliveryPhaseIndex &&
        value.phase === this.#authority.handoff.phase &&
        value.logicalAddress === this.#authority.handoff.logicalAddress &&
        value.artifactHash === this.#authority.handoff.candidate.artifactHash &&
        exact(value.artifact, this.#authority.handoff.candidate.delivery.artifact) &&
        sha256Hex(canonicalize(value.agreement)) ===
          this.#authority.handoff.agreementViewHash &&
        sha256Hex(canonicalize(value.deliverable)) ===
          this.#authority.handoff.deliverableSpecHash &&
        value.agreement.artifactKind === "payee-bound" &&
        value.agreement.ref === this.#authority.handoff.agreementRef &&
        value.agreement.contentHash === this.#authority.handoff.agreementHash &&
        value.agreement.jobId === this.#authority.handoff.jobId &&
        exact(value.agreement.listingPin, authorization.listingRef) &&
        value.agreement.deliverableRef.hash ===
          this.#authority.handoff.deliverableSpecHash &&
        value.agreement.commitment.status === "finalized" &&
        value.agreement.commitment.ref === this.#authority.handoff.commitmentRef &&
        value.agreement.commitment.agreementHash ===
          this.#authority.handoff.agreementHash &&
        value.agreement.commitment.recordContentHash ===
          authorization.commitment.contentHash &&
        value.agreement.commitment.finalizedAt ===
          authorization.commitment.finalizedAt;
    } catch {
      return false;
    }
  }

  async evidencePublication(input: EvidenceAnchorInput): Promise<SellerEvidenceAnchorResult> {
    if (!this.#authority || !this.#evidenceAnchorInputBindsAuthority(input)) {
      return { status: "indeterminate", reason: "evidence input contradicts consumed handoff" };
    }
    // Validate the source read-only, then claim the signed evidence intent.
    // The post-claim hook below commits any failure-source checkpoint before
    // the external anchor is reconciled or invoked.
    await this.#authenticateEvidenceAnchorInput(input);
    const terminalSourceIdentity = this.#evidenceTerminalSource(await this.#load(), input);
    return this.#walEffect({
      key: sellerFulfilmentCheckpointKey.evidencePublication(
        this.#authority.binding.deliveryPhaseIndex,
      ),
      stage: phase("evidence-pending", this.#authority.binding.deliveryPhaseIndex),
      idempotencyKey: `evidence:${this.#authority.binding.fulfilmentId}`,
      input,
      identity: {
        fulfilmentId: input.fulfilmentId,
        evidenceHash: input.evidenceHash,
        terminalSource: terminalSourceIdentity,
      },
      deriveIdentity: (persisted) => ({
        fulfilmentId: persisted.fulfilmentId,
        evidenceHash: persisted.evidenceHash,
        terminalSource: terminalSourceIdentity,
      }),
      validatePersistedInput: (persisted): persisted is EvidenceAnchorInput =>
        this.#evidenceAnchorInputBindsAuthority(persisted),
      authenticatePersistedInput: (persisted) =>
        this.#commitEvidenceTerminalSource(persisted, terminalSourceIdentity),
      // A signer may rotate after response loss. Reconciliation always receives
      // the exact first signed evidence retained in the intent.
      requireExactInputOnResume: false,
      invoke: (fenced) => this.#deps.anchorEvidence(fenced),
      reconcile: (fenced) => this.#durability.reconcileEvidencePublication(fenced),
      validate: isDefinitiveEvidenceAnchorResult,
      indeterminate: (output) => output.status !== "anchored",
      onError: (error) => ({ status: "indeterminate", reason: String(error) }),
    });
  }

  #evidenceAnchorInputBindsAuthority(value: unknown): value is EvidenceAnchorInput {
    if (!this.#authority || !isRecord(value) || !hasExactKeys(value, [
      "fulfilmentId",
      "evidence",
      "evidenceHash",
    ]) || value.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        !isHash(value.evidenceHash) || !isSettlementEvidence(value.evidence) ||
        !isRecord(value.evidence.signature) ||
        !hasExactKeys(value.evidence.signature, ["algorithm", "signer", "value"]) ||
        value.evidence.signature.signer !==
          this.#authority.handoff.evidenceAuthority.primaryClaim ||
        value.evidence.signature.algorithm !==
          this.#authority.handoff.evidenceAuthority.algorithm ||
        signedEvidenceHash(value.evidence) !== value.evidenceHash ||
        value.evidence.jobId !== this.#authority.handoff.jobId ||
        value.evidence.phase !== this.#authority.handoff.phase ||
        !isSafeUint(value.evidence.observedAt) ||
        value.evidence.observedAt < this.#authority.handoff.candidate.validatedAt) {
      return false;
    }
    if (value.evidence.outcome === "failure") return true;
    const deliverable = retainedDeliverableBinding(this.#authority.handoff);
    return deliverable !== null &&
      value.evidence.deliverableContentHash === deliverable.contentHash &&
      isRecord(value.evidence.deliverableAnchor) &&
      value.evidence.deliverableAnchor.kind === "storage-program" &&
      value.evidence.deliverableAnchor.locator ===
        this.#authority.handoff.logicalAddress &&
      (this.#authority.handoff.phase === "deliver-attested-payload"
        ? exact(value.evidence.attestationRef, deliverable.attestationRef)
        : value.evidence.attestationRef === undefined);
  }

  async #authenticateEvidenceAnchorInput(
    input: Readonly<EvidenceAnchorInput>,
  ): Promise<void> {
    if (!this.#authority || !this.#evidenceAnchorInputBindsAuthority(input)) {
      throw new Error("durable evidence publication input is rebound");
    }
    const expectedSigner = this.#authority.handoff.evidenceAuthority.primaryClaim;
    const verificationInput: Parameters<
      SellerFulfilmentDeps["verifyEvidenceSignature"]
    >[0] = {
      evidence: clone(input.evidence),
      signedBytes: signedBytes(
        ARTIFACT_SEPARATORS.SettlementEvidence,
        input.evidenceHash,
      ),
      signature: clone(input.evidence.signature),
      expectedSigner,
    };
    const before = encodeDurable(verificationInput);
    const verification = clone(
      await this.#deps.verifyEvidenceSignature(verificationInput),
    );
    if (encodeDurable(verificationInput) !== before ||
        !isVerificationResult(verification) || verification.disposition !== "valid") {
      throw new Error("durable evidence publication signature is not authenticated");
    }
  }

  async #readback<I, O>(options: {
    key: string;
    stage: string;
    input: I;
    identity: unknown;
    invoke(input: I): Promise<O>;
    validate(output: unknown): output is O;
    persist(output: O): boolean;
  }): Promise<O> {
    if (!this.#authority) return clone(await options.invoke(clone(options.input)));
    const encodedInput = encodeDurable(options.input);
    const inputHash = durableHash(encodedInput);
    const identityHash = durableHash(encodeDurable(options.identity));
    const intentData = {
      fulfilmentId: this.#authority.binding.fulfilmentId,
      inputHash,
      identityHash,
      input: encodedInput,
    };
    const claimed = await this.#claim(options.key, intentData, options.stage, true);
    if (claimed.data.inputHash !== inputHash || claimed.data.identityHash !== identityHash ||
        claimed.data.input !== encodedInput) {
      throw new Error(`durable readback ${options.key} binds another input`);
    }
    if (claimed.state === "outcome") {
      if (typeof claimed.data.output !== "string" || !isHash(claimed.data.outputHash) ||
          durableHash(claimed.data.output) !== claimed.data.outputHash) {
        throw new Error(`durable readback ${options.key} outcome is malformed`);
      }
      const replay = decodeDurable<unknown>(claimed.data.output);
      if (!options.validate(replay)) {
        throw new Error(`durable readback ${options.key} persisted a malformed output`);
      }
      return clone(replay);
    }
    const callbackInput = clone(options.input);
    const before = encodeDurable(callbackInput);
    const output = clone(await options.invoke(callbackInput));
    if (encodeDurable(callbackInput) !== before) {
      throw new Error(`readback adapter mutated ${options.key} input`);
    }
    if (!options.validate(output)) {
      throw new TypeError(`readback adapter returned malformed ${options.key} output`);
    }
    if (options.persist(output)) {
      const encodedOutput = encodeDurable(output);
      await this.#appendOutcome(options.key, claimed.data, {
        ...claimed.data,
        outputHash: durableHash(encodedOutput),
        output: encodedOutput,
      });
    }
    return output;
  }

  async payloadReadback(
    ref: Readonly<SellerAttestationRef>,
  ): Promise<ReturnType<NonNullable<SellerFulfilmentDeps["resolvePayloadAttestation"]>> extends Promise<infer T> ? T : never> {
    if (!this.#deps.resolvePayloadAttestation) {
      throw new Error("payload attestation resolver is unavailable");
    }
    if (!this.#authority) return this.#deps.resolvePayloadAttestation(clone(ref)) as never;
    const result = await this.#readback({
      key: sellerFulfilmentCheckpointKey.payloadReadback(
        this.#authority.binding.deliveryPhaseIndex,
      ),
      stage: phase("delivery-pending", this.#authority.binding.deliveryPhaseIndex),
      input: clone(ref),
      identity: ref,
      invoke: (input) => this.#deps.resolvePayloadAttestation!(input),
      validate: (output): output is PayloadReadback => isPayloadReadback(output, ref),
      persist: (output) => isRecord(output) && output.status !== "indeterminate",
    });
    if (isRecord(result) && result.status === "rejected") {
      await this.persistDpaFailure(`payload readback rejected: ${String(result.reason)}`);
    }
    if (isRecord(result) && result.status === "verified" && isRecord(result.value)) {
      const publicationKey = sellerFulfilmentCheckpointKey.payloadPublication(
        this.#authority.binding.deliveryPhaseIndex,
      );
      const record = await this.#load();
      const publication = latestCheckpoint(record, publicationKey);
      if (publication?.stage === "intent" && typeof publication.data?.input === "string") {
        const persisted = decodeDurable<PayloadAnchorInput>(publication.data.input);
        if (!exact((result.value as SellerResolvedPayloadAttestation).record, persisted.record)) {
          // The independently resolved raw signed record is itself evidence. Fence
          // this contradiction before returning it to #120 so a later resolver or
          // verifier outage cannot demote the permanent DPA failure.
          await this.persistDpaFailure(
            "payload readback differs from the exact retained publication record",
          );
          return result as never;
        }
        if (isRecord(result.value) && "anchorReceipt" in result.value) {
          const anchored: SellerEvidenceAnchorResult = {
            status: "anchored",
            ref: clone(persisted.ref),
            anchorReceipt: clone((result.value as SellerResolvedPayloadAttestation).anchorReceipt),
          };
          if (!isEvidenceAnchorResult(anchored)) {
            throw new Error("payload readback cannot establish a valid publication outcome");
          }
          const encodedOutput = encodeDurable(anchored);
          await this.#appendOutcome(publicationKey, publication.data, {
            ...publication.data,
            outputHash: durableHash(encodedOutput),
            output: encodedOutput,
          });
        }
      }
    }
    return result as never;
  }

  async deliveryReadback(
    input: Parameters<SellerFulfilmentDeps["resolveDelivery"]>[0],
  ): Promise<Awaited<ReturnType<SellerFulfilmentDeps["resolveDelivery"]>>> {
    if (!this.#authority) return this.#deps.resolveDelivery(clone(input));
    return this.#readback({
      key: sellerFulfilmentCheckpointKey.deliveryReadback(
        this.#authority.binding.deliveryPhaseIndex,
      ),
      stage: phase("delivery-recovery", this.#authority.binding.deliveryPhaseIndex),
      input,
      identity: input,
      invoke: async (value) => {
        const output = clone(await this.#deps.resolveDelivery(value));
        if (isRecord(output) && output.status === "rejected" &&
            isNonEmpty(output.reason)) {
          return {
            ...output,
            reason: nonDpaTerminalReason(output.reason),
          } as Awaited<ReturnType<SellerFulfilmentDeps["resolveDelivery"]>>;
        }
        return output;
      },
      validate: (output): output is DeliveryReadback =>
        isDeliveryReadback(output, input.logicalAddress),
      persist: (output) => output.status !== "indeterminate",
    });
  }

  async evidenceReadback(
    ref: Readonly<SellerAttestationRef>,
  ): Promise<Awaited<ReturnType<SellerFulfilmentDeps["resolveEvidence"]>>> {
    if (!this.#authority) return this.#deps.resolveEvidence(clone(ref));
    const publication = latestCheckpoint(
      await this.#load(),
      sellerFulfilmentCheckpointKey.evidencePublication(
        this.#authority.binding.deliveryPhaseIndex,
      ),
    );
    const publicationData = publication?.data;
    if (publication?.stage !== "outcome" || !publicationData ||
        !hasExactKeys(publicationData, [
          "fulfilmentId",
          "idempotencyKey",
          "identityHash",
          "inputHash",
          "input",
          "outputHash",
          "output",
        ]) || typeof publicationData.input !== "string" ||
        !isHash(publicationData.inputHash) ||
        durableHash(publicationData.input) !== publicationData.inputHash ||
        typeof publicationData.output !== "string" ||
        !isHash(publicationData.outputHash) ||
        durableHash(publicationData.output) !== publicationData.outputHash) {
      throw new Error("evidence readback lacks an exact durable publication outcome");
    }
    const retainedInput = decodeDurable<unknown>(publicationData.input);
    if (!isRecord(retainedInput) || !hasExactKeys(retainedInput, [
      "fulfilmentId",
      "evidence",
      "evidenceHash",
    ]) || retainedInput.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        retainedInput.evidenceHash !== ref.contentHash ||
        !isSettlementEvidence(retainedInput.evidence) ||
        signedEvidenceHash(retainedInput.evidence) !== retainedInput.evidenceHash) {
      throw new Error("evidence readback publication input is malformed or rebound");
    }
    const retainedOutput = decodeDurable<unknown>(publicationData.output);
    if (!isDefinitiveEvidenceAnchorResult(retainedOutput, retainedInput as EvidenceAnchorInput) ||
        retainedOutput.status !== "anchored" || !exact(retainedOutput.ref, ref)) {
      throw new Error("evidence readback ref contradicts its durable publication");
    }
    const retainedEvidence = clone(retainedInput.evidence);
    return this.#readback({
      key: sellerFulfilmentCheckpointKey.evidenceReadback(
        this.#authority.binding.deliveryPhaseIndex,
      ),
      stage: phase("evidence-pending", this.#authority.binding.deliveryPhaseIndex),
      input: clone(ref),
      identity: ref,
      invoke: (value) => this.#deps.resolveEvidence(value),
      validate: (output): output is EvidenceReadback =>
        isEvidenceReadback(output, ref) &&
        (output.status !== "verified" || exact(output.value, retainedEvidence)),
      persist: (output) => output.status === "verified",
    });
  }

  #readDpaTerminalFailure(record: SessionRecord): {
    stage: "intent" | "outcome";
    data: Record<string, CheckpointValue> & { reason: string; observedAt: number };
  } | undefined {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const checkpoint = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.dpaTerminalFailure(
        this.#authority.binding.deliveryPhaseIndex,
      ),
    );
    if (!checkpoint) return undefined;
    const data = checkpoint.data;
    if (!data || !hasExactKeys(data, [
      "fulfilmentId",
      "authorizationHash",
      "handoffBindingHash",
      "reason",
      "observedAt",
    ]) || data.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        data.authorizationHash !== this.#authority.binding.authorizationHash ||
        data.handoffBindingHash !== this.#authority.binding.handoffBindingHash ||
        !isNonEmpty(data.reason) || !isSafeUint(data.observedAt)) {
      throw new Error("durable DPA terminal failure contradicts consumed authority");
    }
    return {
      stage: checkpoint.stage,
      data: data as Record<string, CheckpointValue> & { reason: string; observedAt: number },
    };
  }

  async persistDpaFailure(reason: string): Promise<void> {
    if (!this.#authority || !this.#leaseToken || !isNonEmpty(reason)) return;
    const terminalReason = reason.startsWith(DPA_TERMINAL_REASON_PREFIX)
      ? reason
      : `${DPA_TERMINAL_REASON_PREFIX}${reason}`;
    const key = sellerFulfilmentCheckpointKey.dpaTerminalFailure(
      this.#authority.binding.deliveryPhaseIndex,
    );
    const existing = this.#readDpaTerminalFailure(await this.#load());
    if (existing?.stage === "outcome") return;
    let data = existing?.data;
    if (!data) {
      const observedAt = this.applicationNow();
      const minimumObservationTime = Math.max(
        this.#authority.claim.authorization.commitment.finalizedAt,
        this.#authority.claim.authorization.evidenceInput.observedAt,
        this.#authority.handoff.candidate.validatedAt,
      );
      if (!isSafeUint(observedAt) || observedAt < minimumObservationTime) {
        throw new Error(
          "normative clock cannot timestamp the durable DPA terminal observation",
        );
      }
      data = {
        fulfilmentId: this.#authority.binding.fulfilmentId,
        authorizationHash: this.#authority.binding.authorizationHash,
        handoffBindingHash: this.#authority.binding.handoffBindingHash,
        reason: terminalReason,
        observedAt,
      };
    }
    if (!existing) {
      const claimed = await this.#claim(
        key,
        data,
        phase("delivery-recovery", this.#authority.binding.deliveryPhaseIndex),
        true,
      );
      if (!exact(claimed.data, data)) {
        throw new Error("durable DPA terminal failure claim changed authority");
      }
    }
    await this.#appendOutcome(key, data, data, {
      phase: phase("delivery-recovery", this.#authority.binding.deliveryPhaseIndex),
    });
  }

  #deliveryReconciliationInputBindsAuthority(
    value: unknown,
  ): value is DeliveryReconciliationInput {
    if (!this.#authority || !isRecord(value) || !hasExactKeys(value, [
      "fulfilmentId",
      "jobId",
      "phaseIndex",
      "phase",
      ...(value.reconciliationId === undefined ? [] : ["reconciliationId"]),
    ])) return false;
    return value.fulfilmentId === this.#authority.binding.fulfilmentId &&
      value.jobId === this.#authority.handoff.jobId &&
      value.phaseIndex === this.#authority.binding.deliveryPhaseIndex &&
      value.phase === this.#authority.handoff.phase &&
      (value.reconciliationId === undefined || isNonEmpty(value.reconciliationId));
  }

  #deliveryReconciliationIdentity(input: DeliveryReconciliationInput) {
    return {
      fulfilmentId: input.fulfilmentId,
      jobId: input.jobId,
      phaseIndex: input.phaseIndex,
      phase: input.phase,
    };
  }

  #deliveryReconciliationBindsInput(
    output: Extract<SellerDeliveryReconciliation, { status: "complete" | "failed" }>,
    input: DeliveryReconciliationInput,
  ): boolean {
    if (input.reconciliationId === undefined) return true;
    if (output.status === "complete") {
      return output.reconciliationId === input.reconciliationId;
    }
    return output.reconciliationId === undefined ||
      output.reconciliationId === input.reconciliationId;
  }

  #deliveryReconciliationTimeIsValid(
    output: Extract<SellerDeliveryReconciliation, { status: "complete" | "failed" }>,
    checkedAt: number,
  ): boolean {
    if (!this.#authority) return false;
    const minimumDeliveryTime = Math.max(
      this.#authority.claim.authorization.commitment.finalizedAt,
      this.#authority.claim.authorization.evidenceInput.observedAt,
      this.#authority.handoff.candidate.validatedAt,
    );
    return isSafeUint(output.observedAt) &&
      output.observedAt >= minimumDeliveryTime && output.observedAt <= checkedAt;
  }

  #readDeliveryReconciliationCheckpoint(
    record: SessionRecord,
    requestedInput: DeliveryReconciliationInput,
  ):
    | {
        stage: "intent" | "outcome";
        data: Record<string, CheckpointValue>;
        deliveryStateAtObservation: "missing" | "intent" | "outcome";
        input: DeliveryReconciliationInput;
        output: Extract<
          SellerDeliveryReconciliation,
          { status: "complete" | "failed" }
        >;
      }
    | undefined {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const checkpoint = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.deliveryReconciliation(
        this.#authority.binding.deliveryPhaseIndex,
      ),
    );
    if (!checkpoint) return undefined;
    const data = checkpoint.data;
    if (!data || !hasExactKeys(data, [
      "fulfilmentId",
      "inputHash",
      "identityHash",
      "input",
      "deliveryStateAtObservation",
      "deliveryCheckpointHash",
      "observationHash",
      "observation",
    ]) || data.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        typeof data.input !== "string" || !isHash(data.inputHash) ||
        durableHash(data.input) !== data.inputHash || !isHash(data.identityHash) ||
        typeof data.observation !== "string" || !isHash(data.observationHash) ||
        durableHash(data.observation) !== data.observationHash) {
      throw new Error("durable delivery reconciliation checkpoint is malformed");
    }
    const retainedInput = decodeDurable<unknown>(data.input);
    if (!this.#deliveryReconciliationInputBindsAuthority(retainedInput) ||
        data.identityHash !== durableHash(encodeDurable(
          this.#deliveryReconciliationIdentity(retainedInput),
        ))) {
      throw new Error("durable delivery reconciliation input is rebound");
    }
    // The generic core intentionally polls without an id on restart. It may
    // replay an exact retained id, but a caller that supplies an id can never
    // switch to a different (or previously unbound) delivery operation.
    if (requestedInput.reconciliationId !== undefined &&
        retainedInput.reconciliationId !== requestedInput.reconciliationId) {
      throw new Error("durable delivery reconciliation id changed on resume");
    }
    const output = decodeDurable<unknown>(data.observation);
    if (!isDeliveryReconciliation(output) ||
        (output.status !== "complete" && output.status !== "failed") ||
        !this.#deliveryReconciliationBindsInput(output, retainedInput) ||
        !this.#deliveryReconciliationTimeIsValid(output, Number.MAX_SAFE_INTEGER)) {
      throw new Error("durable delivery reconciliation outcome is invalid or rebound");
    }
    this.#assertDeliveryObservationProvenance(
      record,
      data.deliveryStateAtObservation,
      data.deliveryCheckpointHash,
    );
    return {
      stage: checkpoint.stage,
      data,
      deliveryStateAtObservation: data.deliveryStateAtObservation as
        "missing" | "intent" | "outcome",
      input: clone(retainedInput),
      output: clone(output),
    };
  }

  #readDeliveryCheckpoint(record: SessionRecord): RetainedDeliveryCheckpoint | undefined {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const checkpoint = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.delivery(
        this.#authority.binding.deliveryPhaseIndex,
      ),
    );
    if (!checkpoint) return undefined;
    const data = checkpoint.data;
    const hasAuthoritativeAbsence = checkpoint.stage === "outcome" &&
      data?.authoritativeAbsence === true;
    if (!data || !hasExactKeys(data, [
      "fulfilmentId",
      "idempotencyKey",
      "identityHash",
      "inputHash",
      "input",
      ...(checkpoint.stage === "outcome" ? ["outputHash", "output"] : []),
      ...(hasAuthoritativeAbsence ? ["authoritativeAbsence"] : []),
    ]) || data.fulfilmentId !== this.#authority.binding.fulfilmentId ||
        data.idempotencyKey !== `delivery:${this.#authority.binding.fulfilmentId}` ||
        typeof data.input !== "string" || !isHash(data.inputHash) ||
        durableHash(data.input) !== data.inputHash || !isHash(data.identityHash)) {
      throw new Error("durable delivery checkpoint is malformed");
    }
    const input = decodeDurable<unknown>(data.input);
    if (!this.#deliverySubmissionInputBindsAuthority(input) ||
        data.identityHash !== durableHash(encodeDurable({
          fulfilmentId: input.fulfilmentId,
          artifactHash: input.artifactHash,
        }))) {
      throw new Error("durable delivery checkpoint contradicts consumed handoff");
    }
    if (checkpoint.stage === "intent") {
      return { stage: "intent", data, input: clone(input) };
    }
    if (typeof data.output !== "string" || !isHash(data.outputHash) ||
        durableHash(data.output) !== data.outputHash) {
      throw new Error("durable delivery outcome is malformed");
    }
    const output = decodeDurable<unknown>(data.output);
    if (!isDeliverySubmission(output) || output.status === "indeterminate" ||
        (hasAuthoritativeAbsence &&
          (output.status !== "rejected" || output.reason !== DPA_DELIVERY_ABSENCE_REASON))) {
      throw new Error("durable delivery outcome is not definitive");
    }
    return {
      stage: "outcome",
      data,
      input: clone(input),
      output: clone(output),
      ...(hasAuthoritativeAbsence ? { authoritativeAbsence: true as const } : {}),
    };
  }

  #deliveryObservationProvenance(
    checkpoint: RetainedDeliveryCheckpoint | undefined,
  ): { state: "missing" | "intent" | "outcome"; hash: string } {
    if (!checkpoint) {
      return {
        state: "missing",
        hash: durableHash(encodeDurable({ stage: "missing" })),
      };
    }
    if (checkpoint.stage === "intent") {
      return {
        state: "intent",
        hash: durableHash(encodeDurable({
          stage: "intent",
          data: checkpoint.data,
        })),
      };
    }
    const intentData = Object.fromEntries(
      Object.entries(checkpoint.data).filter(([field]) =>
        field !== "outputHash" && field !== "output"
      ),
    );
    return {
      state: "outcome",
      hash: durableHash(encodeDurable({
        stage: "outcome",
        intentData,
        outcomeData: checkpoint.data,
      })),
    };
  }

  #assertDeliveryObservationProvenance(
    record: SessionRecord,
    state: unknown,
    hash: unknown,
  ): void {
    if ((state !== "missing" && state !== "intent" && state !== "outcome") ||
        !isHash(hash)) {
      throw new Error("durable delivery reconciliation provenance is malformed");
    }
    const current = this.#readDeliveryCheckpoint(record);
    if (state === "missing") {
      const expected = this.#deliveryObservationProvenance(undefined);
      if (current !== undefined || hash !== expected.hash) {
        throw new Error("durable reconciliation lost its missing-delivery provenance");
      }
      return;
    }
    if (!current || (state === "outcome" && current.stage !== "outcome")) {
      throw new Error("durable reconciliation lost its retained delivery checkpoint");
    }
    if (state === "intent") {
      const intentData = current.stage === "intent"
        ? current.data
        : Object.fromEntries(Object.entries(current.data).filter(([field]) =>
            field !== "outputHash" && field !== "output"
          ));
      const expectedHash = durableHash(encodeDurable({
        stage: "intent",
        data: intentData,
      }));
      if (hash !== expectedHash) {
        throw new Error("durable reconciliation intent provenance changed");
      }
      return;
    }
    if (hash !== this.#deliveryObservationProvenance(current).hash) {
      throw new Error("durable reconciliation outcome provenance changed");
    }
  }

  async #settleDeliveryIntentForDpa(): Promise<boolean> {
    if (!this.#authority) return false;
    const checkpoint = this.#readDeliveryCheckpoint(await this.#load());
    if (!checkpoint || checkpoint.stage === "outcome") return true;
    const fence = this.#fence(`delivery:${this.#authority.binding.fulfilmentId}`);
    const callbackInput = Object.assign(clone(checkpoint.input) as object, { fence }) as
      Fenced<DeliverySubmitInput>;
    const before = encodeDurable(callbackInput);
    const reconciled = clone(await this.#withHeartbeat(() =>
      this.#durability.reconcileDeliverySubmission(callbackInput)
    ));
    if (encodeDurable(callbackInput) !== before) {
      throw new Error("delivery reconciliation mutated the retained DPA input");
    }
    let outcome: SellerDeliverySubmission;
    if (isAuthoritativeAbsence(reconciled)) {
      outcome = {
        status: "rejected",
        reason: DPA_DELIVERY_ABSENCE_REASON,
      };
    } else if (isDeliverySubmission(reconciled)) {
      if (reconciled.status === "indeterminate") return false;
      outcome = reconciled;
    } else {
      throw new Error("delivery reconciliation returned a malformed DPA fence result");
    }
    const encodedOutput = encodeDurable(outcome);
    await this.#appendOutcome(
      sellerFulfilmentCheckpointKey.delivery(
        this.#authority.binding.deliveryPhaseIndex,
      ),
      checkpoint.data,
      {
        ...checkpoint.data,
        outputHash: durableHash(encodedOutput),
        output: encodedOutput,
        ...(isAuthoritativeAbsence(reconciled)
          ? { authoritativeAbsence: true }
          : {}),
      },
    );
    return true;
  }

  async #dpaPayloadHistoryReady(deliveryStarted: boolean): Promise<boolean> {
    if (!this.#authority) return false;
    if (this.#authority.handoff.phase !== "deliver-attested-payload" ||
        this.#authority.handoff.candidate.status !== "prepared" ||
        !isRecord(this.#authority.handoff.candidate.delivery.artifact) ||
        !isAttestationRef(
          this.#authority.handoff.candidate.delivery.artifact.attestationRef,
        )) {
      throw new Error("DPA terminal failure lacks an attested-payload authority");
    }
    let record = await this.#load();
    const publication = this.#readPayloadPublicationCheckpoint(record);
    if (publication?.stage === "intent") return false;
    const readbackCheckpoint = latestCheckpoint(
      record,
      sellerFulfilmentCheckpointKey.payloadReadback(
        this.#authority.binding.deliveryPhaseIndex,
      ),
    );

    if (!deliveryStarted && !readbackCheckpoint &&
        (!publication || publication.authoritativeAbsence ||
          publication.output?.status === "rejected")) {
      // No delivery was attempted. A definitive publication acknowledgement
      // (including rejection/authoritative absence), or no publication at all,
      // closes every irreversible payload effect without requiring a new read.
      return true;
    }
    if (deliveryStarted && publication?.authoritativeAbsence) {
      throw new Error("delivery started after an authoritatively absent payload publication");
    }

    const ref = clone(
      this.#authority.handoff.candidate.delivery.artifact.attestationRef,
    );
    const resolved = await this.payloadReadback(ref);
    if (!isRecord(resolved) || resolved.status === "indeterminate") return false;
    record = await this.#load();
    const retainedPublication = this.#readPayloadPublicationCheckpoint(record);
    const readback = this.#readTerminalPayloadReadback(
      record,
      retainedPublication,
      deliveryStarted,
    );
    return readback !== undefined;
  }

  async #dpaTerminalReadiness(
    input: DeliveryReconciliationInput,
  ): Promise<"ready" | "pending"> {
    if (!this.#authority || !this.#deliveryReconciliationInputBindsAuthority(input)) {
      throw new Error("DPA reconciliation input contradicts consumed authority");
    }
    if (!await this.#settlePayloadIntentForDpa()) return "pending";
    const preexistingReconciliation = this.#readDeliveryReconciliationCheckpoint(
      await this.#load(),
      input,
    );
    if (preexistingReconciliation) {
      // Its intent already contains the complete terminal observation. Let it
      // derive/promote any delivery intent before consulting the lower-level
      // submission reconciler, whose absence result could otherwise conflict
      // with the stronger retained terminal fact.
      await this.#reconcileDeliveryEffect(input);
    } else if (!await this.#settleDeliveryIntentForDpa()) {
      return "pending";
    }
    let record = await this.#load();
    const delivery = this.#readDeliveryCheckpoint(record);
    if (delivery?.stage === "intent") return "pending";
    if (!delivery && !preexistingReconciliation) {
      // The DPA fact can only be recorded after #120's opening reconciliation
      // returned absent. With no durable delivery WAL, this generation never
      // started an effect; polling again could invent a later contradictory
      // observation instead of closing the already-observed pre-delivery fact.
      return await this.#dpaPayloadHistoryReady(false) ? "ready" : "pending";
    }
    if (delivery?.authoritativeAbsence) {
      if (this.#readDeliveryReconciliationCheckpoint(record, input) ||
          this.#readTerminalDeliveryReadback(record)) {
        throw new Error("authoritatively absent delivery has contradictory terminal history");
      }
      return await this.#dpaPayloadHistoryReady(false) ? "ready" : "pending";
    }

    const acceptedId = delivery?.output?.status === "accepted"
      ? delivery.output.reconciliationId
      : undefined;
    if (input.reconciliationId !== undefined && acceptedId !== undefined &&
        input.reconciliationId !== acceptedId) {
      throw new Error("DPA reconciliation id contradicts the retained delivery");
    }
    const authoritativeInput: DeliveryReconciliationInput = {
      fulfilmentId: this.#authority.binding.fulfilmentId,
      jobId: this.#authority.handoff.jobId,
      phaseIndex: this.#authority.binding.deliveryPhaseIndex,
      phase: this.#authority.handoff.phase,
      ...(acceptedId ? { reconciliationId: acceptedId } : {}),
    };
    const reconciled = await this.#reconcileDeliveryEffect(authoritativeInput);
    if (reconciled.status === "pending" || reconciled.status === "indeterminate") {
      return "pending";
    }
    if (reconciled.status === "absent") {
      if (delivery?.output?.status === "accepted") return "pending";
      if (this.#readTerminalDeliveryReadback(await this.#load())) {
        throw new Error("absent delivery reconciliation has a contradictory readback");
      }
      return await this.#dpaPayloadHistoryReady(delivery !== undefined)
        ? "ready"
        : "pending";
    }
    if (reconciled.status === "failed") {
      if (this.#readTerminalDeliveryReadback(await this.#load())) {
        throw new Error("failed delivery reconciliation has a contradictory readback");
      }
      return await this.#dpaPayloadHistoryReady(true) ? "ready" : "pending";
    }

    const readbackInput: Parameters<SellerFulfilmentDeps["resolveDelivery"]>[0] = {
      logicalAddress: this.#authority.handoff.logicalAddress,
      jobId: this.#authority.handoff.jobId,
      phaseIndex: this.#authority.binding.deliveryPhaseIndex,
      phase: this.#authority.handoff.phase,
    };
    const resolved = await this.deliveryReadback(readbackInput);
    if (resolved.status === "indeterminate") return "pending";
    if (!this.#readTerminalDeliveryReadback(await this.#load())) return "pending";
    return await this.#dpaPayloadHistoryReady(true) ? "ready" : "pending";
  }

  #assertDeliveryCheckpointMatchesReconciliation(
    checkpoint: RetainedDeliveryCheckpoint | undefined,
    reconciliation: Extract<
      SellerDeliveryReconciliation,
      { status: "complete" | "failed" }
    >,
    deliveryStateAtObservation?: "missing" | "intent" | "outcome",
  ): void {
    if (!checkpoint || checkpoint.stage !== "outcome") {
      if (deliveryStateAtObservation === "intent") {
        throw new Error("durable reconciliation did not promote its delivery intent");
      }
      return;
    }
    const submission = checkpoint.output!;
    if (deliveryStateAtObservation === "intent" &&
        (reconciliation.status === "complete"
          ? submission.status !== "accepted" ||
            submission.reconciliationId !== reconciliation.reconciliationId
          : submission.status !== "rejected" ||
            submission.reason !== reconciliation.reason)) {
      throw new Error("durable delivery intent has a non-derived terminal outcome");
    }
    if ((reconciliation.status === "complete" &&
        submission.status === "accepted" &&
        submission.reconciliationId !== reconciliation.reconciliationId) ||
        (reconciliation.status === "failed" && submission.status === "accepted" &&
          reconciliation.reconciliationId !== undefined &&
          submission.reconciliationId !== reconciliation.reconciliationId)) {
      throw new Error("durable delivery outcome contradicts terminal reconciliation");
    }
  }

  async #closeAmbiguousDeliveryIntent(
    reconciliation: Extract<
      SellerDeliveryReconciliation,
      { status: "complete" | "failed" }
    >,
    deliveryStateAtObservation?: "missing" | "intent" | "outcome",
  ): Promise<void> {
    if (!this.#authority) throw new Error("consumed authority is unavailable");
    const key = sellerFulfilmentCheckpointKey.delivery(
      this.#authority.binding.deliveryPhaseIndex,
    );
    const checkpoint = this.#readDeliveryCheckpoint(await this.#load());
    if (!checkpoint) return;
    if (checkpoint.stage === "outcome") {
      this.#assertDeliveryCheckpointMatchesReconciliation(
        checkpoint,
        reconciliation,
        deliveryStateAtObservation,
      );
      return;
    }
    const submission: SellerDeliverySubmission = reconciliation.status === "complete"
      ? { status: "accepted", reconciliationId: reconciliation.reconciliationId }
      : { status: "rejected", reason: reconciliation.reason };
    const encodedOutput = encodeDurable(submission);
    await this.#appendOutcome(key, checkpoint.data, {
      ...checkpoint.data,
      outputHash: durableHash(encodedOutput),
      output: encodedOutput,
    });
  }

  async reconcileDelivery(
    input: DeliveryReconciliationInput,
  ): Promise<SellerDeliveryReconciliation> {
    if (this.#authority) {
      const failure = this.#readDpaTerminalFailure(await this.#load());
      if (failure) {
        const readiness = await this.#dpaTerminalReadiness(input);
        if (readiness !== "ready") {
          return {
            status: "pending",
            reason: "durable DPA terminalization awaits authoritative effect reconciliation",
            ...(input.reconciliationId
              ? { reconciliationId: input.reconciliationId }
              : {}),
          };
        }
        if (failure.stage === "intent") {
          // The intent contains the complete authority-bound terminal fact and
          // is written only after an authenticated DPA contradiction. Promote
          // it generation-fencedly before consulting any now-unavailable
          // external reconciler.
          await this.#appendOutcome(
            sellerFulfilmentCheckpointKey.dpaTerminalFailure(
              this.#authority.binding.deliveryPhaseIndex,
            ),
            failure.data,
            failure.data,
            {
              phase: phase(
                "delivery-recovery",
                this.#authority.binding.deliveryPhaseIndex,
              ),
            },
          );
        }
        return {
          status: "failed",
          reason: failure.data.reason,
          observedAt: failure.data.observedAt,
          reconciliationId: `dpa:${this.#authority.binding.fulfilmentId}`,
        };
      }
    }
    return this.#reconcileDeliveryEffect(input);
  }

  async #reconcileDeliveryEffect(
    input: DeliveryReconciliationInput,
  ): Promise<SellerDeliveryReconciliation> {
    if (!this.#authority) {
      const callbackInput = clone(input);
      const before = encodeDurable(callbackInput);
      let result = clone(await this.#deps.reconcileDelivery(callbackInput));
      if (encodeDurable(callbackInput) !== before) {
        throw new Error("delivery reconciler mutated its exact input");
      }
      if (!isDeliveryReconciliation(result)) {
        throw new TypeError("delivery reconciler returned a malformed result");
      }
      if (result.status === "failed") {
        result = { ...result, reason: nonDpaTerminalReason(result.reason) };
      }
      return result;
    }
    if (!this.#deliveryReconciliationInputBindsAuthority(input)) {
      return {
        status: "indeterminate",
        reason: "delivery reconciliation input contradicts consumed handoff",
      };
    }

    const key = sellerFulfilmentCheckpointKey.deliveryReconciliation(
      this.#authority.binding.deliveryPhaseIndex,
    );
    const retained = this.#readDeliveryReconciliationCheckpoint(
      await this.#load(),
      input,
    );
    if (retained) {
      if (retained.stage === "intent") {
        await this.#appendOutcome(key, retained.data, retained.data);
      }
      await this.#closeAmbiguousDeliveryIntent(
        retained.output,
        retained.deliveryStateAtObservation,
      );
      return clone(retained.output);
    }

    const callbackInput = clone(input);
    const before = encodeDurable(callbackInput);
    let result = clone(await this.#deps.reconcileDelivery(callbackInput));
    if (encodeDurable(callbackInput) !== before) {
      throw new Error("delivery reconciler mutated its exact input");
    }
    if (!isDeliveryReconciliation(result)) {
      throw new TypeError("delivery reconciler returned a malformed result");
    }
    if (result.status === "failed") {
      result = { ...result, reason: nonDpaTerminalReason(result.reason) };
    }
    if (result.status !== "complete" && result.status !== "failed") return result;
    if (!this.#deliveryReconciliationBindsInput(result, callbackInput)) {
      throw new Error("delivery reconciliation changed its reconciliation identity");
    }

    // The generic #120 core validates the same terminal observation after this
    // callback returns. Commit only observations that are already within a
    // stronger lower bound: the exact candidate was validated after the
    // finalized agreement, payment observation and SessionRecord timestamp.
    // A transient early/future answer therefore remains retryable and cannot
    // poison this read-only recovery checkpoint.
    let checkedAt: number;
    try {
      checkedAt = this.applicationNow();
    } catch {
      return result;
    }
    if (!isSafeUint(checkedAt) || !this.#deliveryReconciliationTimeIsValid(
      result,
      checkedAt,
    )) {
      return result;
    }
    // Reject a contradictory accepted id before retaining the observation.
    // A rejected acknowledgement is intentionally not contradictory: #120
    // permits an authoritative complete/failed reconciliation to supersede it.
    const deliveryAtObservation = this.#readDeliveryCheckpoint(await this.#load());
    this.#assertDeliveryCheckpointMatchesReconciliation(
      deliveryAtObservation,
      result,
    );
    const deliveryProvenance = this.#deliveryObservationProvenance(
      deliveryAtObservation,
    );

    const encodedInput = encodeDurable(callbackInput);
    const encodedObservation = encodeDurable(result);
    const identity = this.#deliveryReconciliationIdentity(callbackInput);
    const intentData = {
      fulfilmentId: this.#authority.binding.fulfilmentId,
      inputHash: durableHash(encodedInput),
      identityHash: durableHash(encodeDurable(identity)),
      input: encodedInput,
      deliveryStateAtObservation: deliveryProvenance.state,
      deliveryCheckpointHash: deliveryProvenance.hash,
      observationHash: durableHash(encodedObservation),
      observation: encodedObservation,
    };
    const claimed = await this.#claim(
      key,
      intentData,
      phase("delivery-recovery", this.#authority.binding.deliveryPhaseIndex),
      true,
    );
    if (!exact(claimed.data, intentData)) {
      throw new Error("durable delivery reconciliation claim changed its exact observation");
    }
    if (claimed.state !== "fresh") {
      const replay = this.#readDeliveryReconciliationCheckpoint(
        claimed.record,
        input,
      );
      if (!replay) {
        throw new Error("durable delivery reconciliation checkpoint disappeared");
      }
      if (replay.stage === "intent") {
        await this.#appendOutcome(key, replay.data, replay.data);
      }
      await this.#closeAmbiguousDeliveryIntent(
        replay.output,
        replay.deliveryStateAtObservation,
      );
      return clone(replay.output);
    }
    await this.#appendOutcome(key, claimed.data, claimed.data);
    await this.#closeAmbiguousDeliveryIntent(result, deliveryProvenance.state);
    return result;
  }

  async notePayloadVerification<I>(
    label: string,
    input: I,
    operation: () => Promise<unknown> | unknown,
  ): Promise<unknown> {
    let inputBefore: string | undefined;
    try {
      inputBefore = encodeDurable(input);
    } catch {
      // #120 owns malformed verifier-input classification. Never turn an input
      // we cannot snapshot exactly into a durable terminal contradiction.
    }
    const output = clone(await operation());
    let inputUnchanged = false;
    try {
      inputUnchanged = inputBefore !== undefined && encodeDurable(input) === inputBefore;
    } catch {
      inputUnchanged = false;
    }
    if (inputUnchanged && isVerificationResult(output) &&
        output.disposition === "invalid") {
      if (!this.hasAuthority()) return nonDpaVerificationResult(output);
      await this.persistDpaFailure(`${label}: ${output.reason}`);
      // Do not let #120 publish differently worded/timestamped failure evidence
      // in this pass. The outer durable runner immediately re-enters through
      // the retained DPA reconciliation fact.
      return {
        disposition: "indeterminate",
        reason: "durable DPA terminal fact recorded; exact replay required",
      };
    }
    return output;
  }

  async finalise(result: TerminalFulfilmentResult): Promise<SellerFulfilmentResult> {
    if (!this.#authority) return clone(result);
    this.#assertTerminalResult(result);
    await this.#authenticateTerminalResult(result);
    // A final receipt is irreversible. Validate the exact retained handoff,
    // evidence publication and authenticated readback before invoking or
    // replaying that effect, including the crash window where its outcome was
    // committed but the terminal result checkpoint was not.
    this.#assertTerminalEvidenceSpine(await this.#load(), result);
    await this.#ensureReceipt({
      kind: "delivery",
      ref: result.evidenceRef.anchor.locator,
      phaseIndex: this.#authority.binding.deliveryPhaseIndex,
    });
    const encodedResult = encodeDurable(result);
    const resultHash = durableHash(encodedResult);
    const finalInput: SellerFinalSessionReceiptInput = {
      fulfilmentId: this.#authority.binding.fulfilmentId,
      authorizationBinding: clone(this.#authority.binding),
      resultHash,
      result: clone(result),
    };
    const finalOutput = await this.#walEffect<
      SellerFinalSessionReceiptInput,
      SellerFinalSessionReceiptResult
    >({
      key: sellerFulfilmentCheckpointKey.finalReceipt(
        this.#authority.binding.deliveryPhaseIndex,
      ),
      stage: phase("evidence-pending", this.#authority.binding.deliveryPhaseIndex),
      idempotencyKey: `final:${this.#authority.binding.fulfilmentId}`,
      input: finalInput,
      identity: {
        fulfilmentId: finalInput.fulfilmentId,
        authorizationBinding: finalInput.authorizationBinding,
        resultHash,
      },
      invoke: (fenced) => this.#durability.publishFinalSessionReceipt(fenced),
      reconcile: (fenced) => this.#durability.reconcileFinalSessionReceipt(fenced),
      validate: isFinalSessionReceiptResult,
      indeterminate: (output) => output.status !== "recorded",
      onError: (error): SellerFinalSessionReceiptResult => ({
        status: "indeterminate",
        reason: String(error),
      }),
    });
    if (finalOutput.status !== "recorded") {
      await this.release();
      return {
        decision: "indeterminate",
        code: "durable-final-session-receipt-pending",
        reasons: [finalOutput.reason],
        fulfilmentId: this.#authority.binding.fulfilmentId,
        safeToRetryDelivery: false,
        recovery: { action: "reconcile-delivery" },
        evidence: clone(result.evidence),
        evidenceHash: result.evidenceHash,
        consumedPaymentAuthorization: clone(result.consumedPaymentAuthorization),
      };
    }
    const finalOutputEncoded = encodeDurable(finalOutput);
    const finalReceiptEncoded = encodeDurable(finalOutput.receipt);
    const resultKey = sellerFulfilmentCheckpointKey.result(
      this.#authority.binding.deliveryPhaseIndex,
    );
    const resultData = {
      fulfilmentId: this.#authority.binding.fulfilmentId,
      authorizationHash: this.#authority.binding.authorizationHash,
      handoffBindingHash: this.#authority.binding.handoffBindingHash,
      resultHash,
      result: encodedResult,
      finalOutputHash: durableHash(finalOutputEncoded),
      finalReceiptHash: durableHash(finalReceiptEncoded),
    };
    const claimed = await this.#claim(
      resultKey,
      resultData,
      phase("evidence-pending", this.#authority.binding.deliveryPhaseIndex),
    );
    if (!exact(claimed.data, resultData)) {
      throw new Error("durable terminal result intent contradicts the exact final result");
    }
    const terminalPhase = result.decision === "completed"
      ? phase("delivery-completed", this.#authority.binding.deliveryPhaseIndex)
      : phase("delivery-failed", this.#authority.binding.deliveryPhaseIndex);
    await this.#appendOutcome(resultKey, claimed.data, resultData, {
      phase: terminalPhase,
      release: true,
      receiptRef: durableHash(finalReceiptEncoded),
    });
    this.#leaseToken = undefined;
    this.#terminalReplay = clone(result);
    return clone(result);
  }

  async release(): Promise<void> {
    if (!this.#authority || !this.#leaseToken) return;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const record = await this.#load();
      const released = await this.#durability.store.transition({
        jobId: this.#authority.handoff.jobId,
        expectedRevision: record.revision,
        leaseToken: this.#leaseToken,
        lease: null,
        now: this.#now(),
      });
      if (released.ok) {
        this.#leaseToken = undefined;
        return;
      }
      if (released.reason !== "revision-mismatch") return;
    }
  }
}

/**
 * Authenticate an already-completed fulfilment directly from its durable v2
 * record. This is deliberately read-only: callers supply only the two
 * cryptographic verification seams, and no store or effect capability.
 */
export async function verifyDurableSellerTerminalResult(
  input: VerifyDurableSellerTerminalResultInput,
): Promise<VerifiedDurableSellerTerminalResult> {
  if (!isRecord(input) || !hasExactKeys(input, [
    "record",
    "suppliedResult",
    "verifyEvidenceSignature",
    "verifyAnchorReceipt",
  ])) {
    throw new TypeError("durable terminal verification input is malformed");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const expectedFields = [
    "record",
    "suppliedResult",
    "verifyEvidenceSignature",
    "verifyAnchorReceipt",
  ] as const;
  if (expectedFields.some((field) => {
    const descriptor = descriptors[field];
    return !descriptor || !("value" in descriptor);
  })) {
    throw new TypeError("durable terminal verification input requires data properties");
  }
  const recordInput = descriptors.record!.value as unknown;
  const suppliedResultInput = descriptors.suppliedResult!.value as unknown;
  const verifyEvidenceSignatureSource = descriptors.verifyEvidenceSignature!.value as unknown;
  const verifyAnchorReceiptSource = descriptors.verifyAnchorReceipt!.value as unknown;
  if (typeof verifyEvidenceSignatureSource !== "function" ||
      typeof verifyAnchorReceiptSource !== "function") {
    throw new TypeError("durable terminal verification callbacks must be callable");
  }
  const violation = sessionRecordShapeViolation(recordInput);
  if (violation) throw new Error(`durable session is corrupt: ${violation}`);

  // Snapshot every caller-controlled value and executable authority before the
  // first await. Revalidate the clone so hostile clone hooks cannot weaken the
  // record shape accepted by the terminal decoder.
  const record = clone(recordInput) as SessionRecord;
  const suppliedResult = clone(suppliedResultInput) as Extract<
    SellerFulfilmentResult,
    { decision: "completed" }
  >;
  const snapshotViolation = sessionRecordShapeViolation(record);
  if (snapshotViolation) {
    throw new Error(`durable session snapshot is corrupt: ${snapshotViolation}`);
  }
  const verifyEvidenceSignature = bindCaptured(verifyEvidenceSignatureSource, input) as
    SellerFulfilmentDeps["verifyEvidenceSignature"];
  const verifyAnchorReceipt = bindCaptured(verifyAnchorReceiptSource, input) as
    SellerFulfilmentDeps["verifyAnchorReceipt"];
  const authority = deriveCompletedAuthorityFromRecord(record, suppliedResult);
  return DurableCoordinator.verifyCompletedRecord(
    record,
    suppliedResult,
    authority,
    { verifyEvidenceSignature, verifyAnchorReceipt },
  );
}

function durableIndeterminate(
  code: string,
  reason: string,
  consumedPaymentAuthorization?: SellerPaymentAuthorization,
): SellerFulfilmentResult {
  return {
    decision: "indeterminate",
    code,
    reasons: [reason],
    safeToRetryDelivery: false,
    ...(consumedPaymentAuthorization
      ? { consumedPaymentAuthorization: clone(consumedPaymentAuthorization) }
      : {}),
  };
}

/** Stable, clone-isolated projection over the durable session state. */
export async function getSellerFulfilmentStatus(
  store: FencedSessionStoreV2,
  jobId: string,
  deliveryPhaseIndex: number,
): Promise<SellerFulfilmentStatusLoad> {
  if (!isSafeUint(deliveryPhaseIndex)) {
    return { status: "corrupt", reason: "delivery phase index must be a safe unsigned integer" };
  }
  const loaded = clone(await store.load(jobId));
  if (loaded.status !== "ok") return loaded;
  const violation = sessionRecordShapeViolation(loaded.record);
  if (violation) return { status: "corrupt", reason: violation };
  const receipts: Record<string, string> = {};
  for (const receipt of loaded.record.receipts) {
    receipts[sessionReceiptKey(receipt)] = receipt.ref;
  }
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
    delivery: checkpointState(
      loaded.record,
      sellerFulfilmentCheckpointKey.delivery(deliveryPhaseIndex),
    ),
    evidence: checkpointState(
      loaded.record,
      sellerFulfilmentCheckpointKey.evidencePublication(deliveryPhaseIndex),
    ),
    receipts,
    updatedAt: loaded.record.updatedAt,
  };
}

/**
 * Restart-safe seller fulfilment. Durable identity is established only from an
 * already-consumed #120 receipt-store handoff; an available permit cannot create
 * session state. All irreversible adapters share one generation-fenced WAL.
 */
export async function runDurableFulfilmentCore(
  request: SellerFulfilmentRequest,
  deps: DurableSellerFulfilmentDeps,
  durability: SellerFulfilmentDurability,
): Promise<SellerFulfilmentResult> {
  let requestSnapshot: SellerFulfilmentRequest;
  let capturedDeps: DurableSellerFulfilmentDeps;
  let capturedDurability: SellerFulfilmentDurability;
  try {
    requestSnapshot = clone(request);
    // Capture every executable authority synchronously before the first await.
    capturedDeps = captureDeps(deps);
    capturedDurability = captureDurability(durability);
  } catch (error) {
    return durableIndeterminate("durable-dependencies-invalid", String(error));
  }

  const coordinator = new DurableCoordinator(
    requestSnapshot,
    capturedDeps,
    capturedDurability,
  );
  try {
    await coordinator.inspectInitialPermit();
  } catch (error) {
    await coordinator.release().catch(() => {});
    return durableIndeterminate(
      "durable-permit-inspection-failed",
      String(error),
      coordinator.consumedPaymentAuthorization(),
    );
  }
  const replay = coordinator.terminalReplay();
  if (replay) return replay;
  try {
    const pendingFinalReceipt = await coordinator.resumePendingFinalReceipt();
    if (pendingFinalReceipt) return pendingFinalReceipt;
  } catch (error) {
    await coordinator.release().catch(() => {});
    return durableIndeterminate(
      "durable-final-session-receipt-recovery-failed",
      String(error),
      coordinator.consumedPaymentAuthorization(),
    );
  }
  try {
    const pendingEvidence = await coordinator.resumePendingEvidence();
    if (pendingEvidence) {
      if (pendingEvidence.decision === "indeterminate") {
        await coordinator.release();
      }
      return pendingEvidence;
    }
  } catch (error) {
    await coordinator.release().catch(() => {});
    return durableIndeterminate(
      "durable-evidence-recovery-failed",
      String(error),
      coordinator.consumedPaymentAuthorization(),
    );
  }

  const wrapped: SellerFulfilmentDeps = {
    ...(capturedDeps as unknown as SellerFulfilmentDeps),
    nowMs: () => coordinator.applicationNow(),
    receiptStore: {
      claim: (input) => coordinator.claimReceipt(input),
      inspectPermit: (permitId) => coordinator.inspectPermit(permitId),
      consumePermit: (permitId, handoff) => coordinator.consumePermit(permitId, handoff),
    },
    prepareDelivery: (input) => coordinator.prepareDelivery(input),
    submitDelivery: (input) => coordinator.deliverySubmission(input),
    reconcileDelivery: (input) => coordinator.reconcileDelivery(input),
    resolveDelivery: (input) => coordinator.deliveryReadback(input),
    ...(capturedDeps.anchorPayloadAttestation
      ? { anchorPayloadAttestation: (input) => coordinator.payloadPublication(input) }
      : {}),
    ...(capturedDeps.resolvePayloadAttestation
      ? { resolvePayloadAttestation: (ref) => coordinator.payloadReadback(ref) }
      : {}),
    ...(capturedDeps.verifyPayloadAttestationSignature
      ? {
          verifyPayloadAttestationSignature: (input) =>
            coordinator.notePayloadVerification(
              "payload signature contradiction",
              input,
              () => capturedDeps.verifyPayloadAttestationSignature!(input),
            ) as ReturnType<NonNullable<SellerFulfilmentDeps["verifyPayloadAttestationSignature"]>>,
        }
      : {}),
    ...(capturedDeps.verifyPayloadMethodProof
      ? {
          verifyPayloadMethodProof: (input) =>
            coordinator.notePayloadVerification(
              "payload method-proof contradiction",
              input,
              () => capturedDeps.verifyPayloadMethodProof!(input),
            ) as ReturnType<NonNullable<SellerFulfilmentDeps["verifyPayloadMethodProof"]>>,
        }
      : {}),
    verifyAnchorReceipt: async (input) => {
      let inputBefore: string | undefined;
      try {
        inputBefore = encodeDurable(input);
      } catch {
        // Let #120 classify malformed verifier inputs without persisting them.
      }
      const output = clone(await capturedDeps.verifyAnchorReceipt(input));
      let inputUnchanged = false;
      try {
        inputUnchanged = inputBefore !== undefined && encodeDurable(input) === inputBefore;
      } catch {
        inputUnchanged = false;
      }
      if (inputUnchanged && input.purpose === "payload-attestation" &&
          isVerificationResult(output) && output.disposition === "invalid" &&
          coordinator.hasAuthority()) {
        await coordinator.persistDpaFailure(
          `payload anchor-receipt contradiction: ${output.reason}`,
        );
        return {
          disposition: "indeterminate",
          reason: "durable DPA terminal fact recorded; exact replay required",
        };
      }
      return nonDpaVerificationResult(output) as typeof output;
    },
    ...(capturedDeps.verifyDeliverySchema
      ? {
          verifyDeliverySchema: async (input) => nonDpaVerificationResult(
            clone(await capturedDeps.verifyDeliverySchema!(input)),
          ) as ReturnType<NonNullable<SellerFulfilmentDeps["verifyDeliverySchema"]>>,
        }
      : {}),
    ...(capturedDeps.verifyEncryptedDelivery
      ? {
          verifyEncryptedDelivery: async (input) => nonDpaVerificationResult(
            clone(await capturedDeps.verifyEncryptedDelivery!(input)),
          ) as ReturnType<NonNullable<SellerFulfilmentDeps["verifyEncryptedDelivery"]>>,
        }
      : {}),
    ...(capturedDeps.verifyEntitlementSignature
      ? {
          verifyEntitlementSignature: async (input) => nonDpaVerificationResult(
            clone(await capturedDeps.verifyEntitlementSignature!(input)),
          ) as ReturnType<NonNullable<SellerFulfilmentDeps["verifyEntitlementSignature"]>>,
        }
      : {}),
    anchorEvidence: (input) => coordinator.evidencePublication(input),
    resolveEvidence: (ref) => coordinator.evidenceReadback(ref),
  };

  let result: SellerFulfilmentResult;
  try {
    result = await runFulfilmentCore(requestSnapshot, wrapped);
    if (result.decision === "rejected" && coordinator.hasAuthority()) {
      result = durableIndeterminate(
        "durable-consumed-fulfilment-rejected",
        `${result.code}: ${result.reasons.join("; ")}`,
        coordinator.consumedPaymentAuthorization(),
      );
    }
    if (result.decision === "indeterminate" && coordinator.hasAuthority()) {
      result = {
        ...clone(result),
        safeToRetryDelivery: false,
        consumedPaymentAuthorization: coordinator.consumedPaymentAuthorization(),
      };
    }
    if (
      result.decision === "indeterminate" &&
      result.code === "payload-attestation-publication-invalid" &&
      coordinator.hasAuthority()
    ) {
      await coordinator.persistDpaFailure(result.reasons.join("; "));
    }
    if (await coordinator.terminalNeedsDpaReplay(result)) {
      // #120 reconciles before candidate verifiers, so the exact durable fact
      // produces one consistently worded/timestamped DPA-7 failure without
      // allowing the first pass to publish a competing evidence record.
      result = await runFulfilmentCore(requestSnapshot, wrapped);
      if (await coordinator.terminalNeedsDpaReplay(result)) {
        if (result.decision !== "indeterminate") {
          throw new Error("durable DPA terminal fact did not control exact replay");
        }
        // Authoritative effect reconciliation/readback may remain temporarily
        // unavailable. Preserve the nonterminal recovery result; no evidence
        // publication has been allowed through the source-spine gate.
      }
    }
    if (result.decision === "completed" || result.decision === "failed") {
      return await coordinator.finalise(result);
    }
    await coordinator.release();
    return clone(result);
  } catch (error) {
    await coordinator.release().catch(() => {});
    return durableIndeterminate(
      "durable-fulfilment-failed",
      String(error),
      coordinator.consumedPaymentAuthorization(),
    );
  }
}
