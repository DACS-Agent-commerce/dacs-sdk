import { types as nodeTypes } from "node:util";

import type {
  AnchorReceipt,
  AttestationRef,
  SettlementEvidence,
} from "../artifacts/types.js";
import {
  isAnchorReceipt,
  isAttestationRef,
  isSettlementEvidence,
} from "../artifacts/validators.js";
import { canonicalize, contentHash, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import type {
  SellerSessionSettlementAnchorResult,
  SellerSessionSettlementAnchorWriter,
} from "../seller/sessionSettlementPublication.js";

export const PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION = 1 as const;

export type PaymentEvidenceHandshakeRole = "seller" | "buyer";

export interface PaymentEvidenceAnchorRequest {
  requestVersion: "1";
  messageId: string;
  requestHash: string;
  jobId: string;
  effectId: string;
  seller: string;
  buyer: string;
  logicalAddress: string;
  evidenceHash: string;
  evidence: Readonly<SettlementEvidence>;
  expectedWriter: Readonly<SellerSessionSettlementAnchorWriter & { role: "buyer" }>;
}

export interface PaymentEvidenceAnchorCompletion {
  completionVersion: "1";
  messageId: string;
  completionHash: string;
  requestMessageId: string;
  requestHash: string;
  jobId: string;
  effectId: string;
  buyer: string;
  evidenceHash: string;
  evidenceRef: Readonly<AttestationRef>;
  anchorReceipt: Readonly<AnchorReceipt>;
}

export type PaymentEvidenceTransportAuthentication =
  | { disposition: "authenticated"; authenticationHash: string }
  | { disposition: "rejected" | "indeterminate"; reason: string };

export type PaymentEvidenceAnchorVerification =
  | { disposition: "valid" }
  | { disposition: "invalid" | "indeterminate" | "error"; reason: string };

export interface PaymentEvidenceHandshakeLease {
  owner: string;
  generation: number;
  expiresAt: number;
}

export interface PaymentEvidenceHandshakeRecord {
  storeVersion: typeof PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION;
  role: PaymentEvidenceHandshakeRole;
  messageId: string;
  request: Readonly<PaymentEvidenceAnchorRequest>;
  requestAuthenticationHash?: string;
  completion?: Readonly<PaymentEvidenceAnchorCompletion>;
  completionAuthenticationHash?: string;
  leaseGeneration: number;
  lease?: Readonly<PaymentEvidenceHandshakeLease>;
  createdAt: number;
  updatedAt: number;
}

export type PaymentEvidenceHandshakeLoad =
  | { status: "missing" }
  | { status: "ok"; record: Readonly<PaymentEvidenceHandshakeRecord> }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type PaymentEvidenceHandshakePut =
  | { status: "created" | "existing"; record: Readonly<PaymentEvidenceHandshakeRecord> }
  | { status: "conflict" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type PaymentEvidenceHandshakeClaim =
  | {
      status: "acquired";
      record: Readonly<PaymentEvidenceHandshakeRecord>;
      lease: Readonly<PaymentEvidenceHandshakeLease>;
    }
  | {
      status: "waiting";
      record: Readonly<PaymentEvidenceHandshakeRecord>;
      lease: Readonly<PaymentEvidenceHandshakeLease>;
    }
  | { status: "complete"; record: Readonly<PaymentEvidenceHandshakeRecord> }
  | { status: "missing" | "stale" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type PaymentEvidenceHandshakeWrite =
  | { status: "recorded" | "existing"; record: Readonly<PaymentEvidenceHandshakeRecord> }
  | { status: "missing" | "stale" | "conflict" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export interface PaymentEvidenceHandshakeStore {
  putRequest(input: Readonly<{
    role: PaymentEvidenceHandshakeRole;
    request: Readonly<PaymentEvidenceAnchorRequest>;
    requestAuthenticationHash?: string;
    now: number;
  }>): Promise<PaymentEvidenceHandshakePut>;
  load(
    role: PaymentEvidenceHandshakeRole,
    messageId: string,
  ): Promise<PaymentEvidenceHandshakeLoad>;
  list(role: PaymentEvidenceHandshakeRole): Promise<readonly PaymentEvidenceHandshakeLoad[]>;
  claimBuyer(input: Readonly<{
    messageId: string;
    requestHash: string;
    owner: string;
    now: number;
    leaseDurationMs: number;
  }>): Promise<PaymentEvidenceHandshakeClaim>;
  isCurrentBuyer(input: Readonly<{
    messageId: string;
    requestHash: string;
    lease: Readonly<PaymentEvidenceHandshakeLease>;
    now: number;
  }>): Promise<boolean>;
  recordBuyerCompletion(input: Readonly<{
    messageId: string;
    requestHash: string;
    lease: Readonly<PaymentEvidenceHandshakeLease>;
    completion: Readonly<PaymentEvidenceAnchorCompletion>;
    now: number;
  }>): Promise<PaymentEvidenceHandshakeWrite>;
  recordSellerCompletion(input: Readonly<{
    messageId: string;
    requestHash: string;
    completion: Readonly<PaymentEvidenceAnchorCompletion>;
    completionAuthenticationHash: string;
    now: number;
  }>): Promise<PaymentEvidenceHandshakeWrite>;
}

export interface PaymentEvidenceAnchorFence {
  messageId: string;
  requestHash: string;
  effectId: string;
  owner: string;
  generation: number;
  idempotencyKey: string;
  assertCurrent(): Promise<void>;
}

export interface BuyerPaymentEvidenceHandshakeOptions {
  store: PaymentEvidenceHandshakeStore;
  /** Local buyer authority. Requests addressed to any other actor are refused. */
  buyer: string;
  workerId: string;
  authenticateRequest(
    request: Readonly<PaymentEvidenceAnchorRequest>,
  ): Promise<PaymentEvidenceTransportAuthentication> | PaymentEvidenceTransportAuthentication;
  /** Cryptographically and semantically verify the seller-signed evidence. */
  verifyEvidence(
    request: Readonly<PaymentEvidenceAnchorRequest>,
  ): Promise<PaymentEvidenceAnchorVerification> | PaymentEvidenceAnchorVerification;
  anchorEvidence(
    input: Readonly<{
      effectId: string;
      logicalAddress: string;
      evidenceHash: string;
      evidence: Readonly<SettlementEvidence>;
      expectedWriter: Readonly<SellerSessionSettlementAnchorWriter & { role: "buyer" }>;
    }>,
    fence: Readonly<PaymentEvidenceAnchorFence>,
  ): Promise<SellerSessionSettlementAnchorResult> | SellerSessionSettlementAnchorResult;
  verifyAnchorReceipt(input: Readonly<{
    request: Readonly<PaymentEvidenceAnchorRequest>;
    completion: Readonly<PaymentEvidenceAnchorCompletion>;
  }>): Promise<PaymentEvidenceAnchorVerification> | PaymentEvidenceAnchorVerification;
  leaseDurationMs?: number;
  now?: () => number;
}

export interface SellerPaymentEvidenceHandshakeOptions {
  store: PaymentEvidenceHandshakeStore;
  seller: string;
  buyer: string;
  authenticateCompletion(
    completion: Readonly<PaymentEvidenceAnchorCompletion>,
  ): Promise<PaymentEvidenceTransportAuthentication> | PaymentEvidenceTransportAuthentication;
  verifyAnchorReceipt(input: Readonly<{
    request: Readonly<PaymentEvidenceAnchorRequest>;
    completion: Readonly<PaymentEvidenceAnchorCompletion>;
  }>): Promise<PaymentEvidenceAnchorVerification> | PaymentEvidenceAnchorVerification;
  now?: () => number;
}

export interface BuyerPaymentEvidenceHandshake {
  receiveRequest(
    request: Readonly<PaymentEvidenceAnchorRequest>,
  ): Promise<"accepted" | "existing">;
  runPending(options?: Readonly<{
    limit?: number;
    signal?: AbortSignal;
  }>): Promise<readonly PaymentEvidenceHandshakeRunResult[]>;
  listOutboundCompletions(
    limit?: number,
  ): Promise<readonly PaymentEvidenceAnchorCompletion[]>;
}

export interface SellerPaymentEvidenceHandshake {
  anchorEvidence(input: Readonly<{
    effectId: string;
    logicalAddress: string;
    evidenceHash: string;
    evidence: Readonly<SettlementEvidence>;
    expectedWriter: Readonly<SellerSessionSettlementAnchorWriter>;
  }>): Promise<SellerSessionSettlementAnchorResult>;
  listOutboundRequests(limit?: number): Promise<readonly PaymentEvidenceAnchorRequest[]>;
  receiveCompletion(
    completion: Readonly<PaymentEvidenceAnchorCompletion>,
  ): Promise<"accepted" | "existing">;
}

export interface PaymentEvidenceHandshakeRunResult {
  messageId: string;
  status: "completed" | "waiting" | "indeterminate" | "rejected" | "stale";
  reason?: string;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const TRACK_MESSAGE_PREFIX = "dacs-sdk:x402:payment-evidence-anchor-request:";
const COMPLETION_MESSAGE_PREFIX = "dacs-sdk:x402:payment-evidence-anchor-completion:";
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_LIMIT = 10;
const INERT_RECEIVER = Object.freeze(Object.create(null)) as object;

const clone = <T>(value: T): T => structuredClone(value);
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const safeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  !Object.is(value, -0);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    optional.every((key) => !hasOwn(value, key) || value[key] !== undefined);
}

function ownClone<T>(value: T, label: string): T {
  if (!plainRecord(value)) throw new DacsError(`${label} must be a plain object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new DacsError(`${label} must contain enumerable defined data properties only`);
    }
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable ||
        !("value" in descriptor) || descriptor.value === undefined) {
      throw new DacsError(`${label} must contain enumerable defined data properties only`);
    }
  }
  try {
    return clone(value);
  } catch {
    throw new DacsError(`${label} must be structured-cloneable data`);
  }
}

function requestPayload(request: Readonly<PaymentEvidenceAnchorRequest>) {
  return {
    requestVersion: request.requestVersion,
    jobId: request.jobId,
    effectId: request.effectId,
    seller: request.seller,
    buyer: request.buyer,
    logicalAddress: request.logicalAddress,
    evidenceHash: request.evidenceHash,
    evidence: request.evidence,
    expectedWriter: request.expectedWriter,
  };
}

function completionPayload(completion: Readonly<PaymentEvidenceAnchorCompletion>) {
  return {
    completionVersion: completion.completionVersion,
    requestMessageId: completion.requestMessageId,
    requestHash: completion.requestHash,
    jobId: completion.jobId,
    effectId: completion.effectId,
    buyer: completion.buyer,
    evidenceHash: completion.evidenceHash,
    evidenceRef: completion.evidenceRef,
    anchorReceipt: completion.anchorReceipt,
  };
}

export function paymentEvidenceAnchorRequestHash(
  request: Readonly<PaymentEvidenceAnchorRequest>,
): string {
  return sha256Hex(canonicalize(requestPayload(request)));
}

export function paymentEvidenceAnchorCompletionHash(
  completion: Readonly<PaymentEvidenceAnchorCompletion>,
): string {
  return sha256Hex(canonicalize(completionPayload(completion)));
}

function paymentEvidenceSuccess(value: SettlementEvidence): boolean {
  return value.outcome === "success" && value.phase.startsWith("pay-") &&
    "paymentAmount" in value && "settlementFinality" in value;
}

function isExactPaymentEvidenceAddress(logicalAddress: string, jobId: string): boolean {
  const escapedJobId = jobId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^dacs4:payment:${escapedJobId}:[^:]+:(0|[1-9][0-9]*)$`,
  ).test(logicalAddress);
}

export function isPaymentEvidenceAnchorRequest(
  value: unknown,
): value is PaymentEvidenceAnchorRequest {
  if (!plainRecord(value) || !exactKeys(value, [
    "requestVersion",
    "messageId",
    "requestHash",
    "jobId",
    "effectId",
    "seller",
    "buyer",
    "logicalAddress",
    "evidenceHash",
    "evidence",
    "expectedWriter",
  ]) || value.requestVersion !== "1" || !nonEmpty(value.messageId) ||
      typeof value.requestHash !== "string" || !HASH_RE.test(value.requestHash) ||
      !nonEmpty(value.jobId) || !nonEmpty(value.effectId) || !nonEmpty(value.seller) ||
      !nonEmpty(value.buyer) || value.seller === value.buyer ||
      !nonEmpty(value.logicalAddress) || typeof value.evidenceHash !== "string" ||
      !HASH_RE.test(value.evidenceHash) || !isSettlementEvidence(value.evidence) ||
      !paymentEvidenceSuccess(value.evidence) || value.evidence.jobId !== value.jobId ||
      value.evidence.signature.signer !== value.seller ||
      contentHash(value.evidence as unknown as Record<string, unknown>) !== value.evidenceHash ||
      !plainRecord(value.expectedWriter) || !exactKeys(
        value.expectedWriter,
        ["role", "primaryClaim"],
      ) || value.expectedWriter.role !== "buyer" ||
      value.expectedWriter.primaryClaim !== value.buyer ||
      !isExactPaymentEvidenceAddress(value.logicalAddress, value.jobId)) return false;
  const request = value as unknown as PaymentEvidenceAnchorRequest;
  const expectedHash = paymentEvidenceAnchorRequestHash(request);
  return request.requestHash === expectedHash &&
    request.messageId === `${TRACK_MESSAGE_PREFIX}${expectedHash}`;
}

export function createPaymentEvidenceAnchorRequest(input: Readonly<{
  seller: string;
  buyer: string;
  effectId: string;
  logicalAddress: string;
  evidenceHash: string;
  evidence: Readonly<SettlementEvidence>;
  expectedWriter: Readonly<SellerSessionSettlementAnchorWriter>;
}>): PaymentEvidenceAnchorRequest {
  const captured = ownClone(input, "payment-evidence anchor request input");
  if (!nonEmpty(captured.seller) || !nonEmpty(captured.buyer) ||
      captured.seller === captured.buyer || !nonEmpty(captured.effectId) ||
      !nonEmpty(captured.logicalAddress) || typeof captured.evidenceHash !== "string" ||
      !HASH_RE.test(captured.evidenceHash) || !isSettlementEvidence(captured.evidence) ||
      !paymentEvidenceSuccess(captured.evidence) ||
      captured.evidence.signature.signer !== captured.seller ||
      captured.expectedWriter.role !== "buyer" ||
      captured.expectedWriter.primaryClaim !== captured.buyer) {
    throw new DacsError("payment-evidence anchor request input is malformed");
  }
  const payload = {
    requestVersion: "1" as const,
    jobId: captured.evidence.jobId,
    effectId: captured.effectId,
    seller: captured.seller,
    buyer: captured.buyer,
    logicalAddress: captured.logicalAddress,
    evidenceHash: captured.evidenceHash,
    evidence: clone(captured.evidence),
    expectedWriter: {
      role: "buyer" as const,
      primaryClaim: captured.buyer,
    },
  };
  const requestHash = sha256Hex(canonicalize(payload));
  const request: PaymentEvidenceAnchorRequest = {
    ...payload,
    messageId: `${TRACK_MESSAGE_PREFIX}${requestHash}`,
    requestHash,
  };
  if (!isPaymentEvidenceAnchorRequest(request)) {
    throw new DacsError("payment-evidence anchor request cannot be derived safely");
  }
  return clone(request);
}

export function isPaymentEvidenceAnchorCompletion(
  value: unknown,
): value is PaymentEvidenceAnchorCompletion {
  if (!plainRecord(value) || !exactKeys(value, [
    "completionVersion",
    "messageId",
    "completionHash",
    "requestMessageId",
    "requestHash",
    "jobId",
    "effectId",
    "buyer",
    "evidenceHash",
    "evidenceRef",
    "anchorReceipt",
  ]) || value.completionVersion !== "1" || !nonEmpty(value.messageId) ||
      typeof value.completionHash !== "string" || !HASH_RE.test(value.completionHash) ||
      !nonEmpty(value.requestMessageId) || typeof value.requestHash !== "string" ||
      !HASH_RE.test(value.requestHash) || !nonEmpty(value.jobId) ||
      !nonEmpty(value.effectId) || !nonEmpty(value.buyer) ||
      typeof value.evidenceHash !== "string" || !HASH_RE.test(value.evidenceHash) ||
      !isAttestationRef(value.evidenceRef) || !isAnchorReceipt(value.anchorReceipt)) return false;
  const completion = value as unknown as PaymentEvidenceAnchorCompletion;
  const expectedHash = paymentEvidenceAnchorCompletionHash(completion);
  return completion.completionHash === expectedHash &&
    completion.messageId === `${COMPLETION_MESSAGE_PREFIX}${expectedHash}`;
}

function completionMatchesRequest(
  request: Readonly<PaymentEvidenceAnchorRequest>,
  completion: Readonly<PaymentEvidenceAnchorCompletion>,
): boolean {
  return completion.requestMessageId === request.messageId &&
    completion.requestHash === request.requestHash &&
    completion.jobId === request.jobId &&
    completion.effectId === request.effectId &&
    completion.buyer === request.buyer &&
    completion.evidenceHash === request.evidenceHash &&
    completion.evidenceRef.anchor.kind === "storage-program" &&
    completion.evidenceRef.anchor.locator === request.logicalAddress &&
    completion.evidenceRef.contentHash === request.evidenceHash &&
    (completion.evidenceRef.signer === undefined ||
      completion.evidenceRef.signer === request.seller) &&
    completion.anchorReceipt.logicalAddress === request.logicalAddress &&
    completion.anchorReceipt.contentHash === request.evidenceHash &&
    completion.anchorReceipt.writer === request.buyer &&
    completion.anchorReceipt.state === "finalized" &&
    completion.anchorReceipt.observationDisposition === "established";
}

export function createPaymentEvidenceAnchorCompletion(input: Readonly<{
  request: Readonly<PaymentEvidenceAnchorRequest>;
  evidenceRef: Readonly<AttestationRef>;
  anchorReceipt: Readonly<AnchorReceipt>;
}>): PaymentEvidenceAnchorCompletion {
  const captured = ownClone(input, "payment-evidence anchor completion input");
  if (!isPaymentEvidenceAnchorRequest(captured.request) ||
      !isAttestationRef(captured.evidenceRef) || !isAnchorReceipt(captured.anchorReceipt)) {
    throw new DacsError("payment-evidence anchor completion input is malformed");
  }
  const payload = {
    completionVersion: "1" as const,
    requestMessageId: captured.request.messageId,
    requestHash: captured.request.requestHash,
    jobId: captured.request.jobId,
    effectId: captured.request.effectId,
    buyer: captured.request.buyer,
    evidenceHash: captured.request.evidenceHash,
    evidenceRef: clone(captured.evidenceRef),
    anchorReceipt: clone(captured.anchorReceipt),
  };
  const completionHash = sha256Hex(canonicalize(payload));
  const completion: PaymentEvidenceAnchorCompletion = {
    ...payload,
    messageId: `${COMPLETION_MESSAGE_PREFIX}${completionHash}`,
    completionHash,
  };
  if (!isPaymentEvidenceAnchorCompletion(completion) ||
      !completionMatchesRequest(captured.request, completion)) {
    throw new DacsError("payment-evidence anchor completion does not bind the request");
  }
  return clone(completion);
}

function validLease(value: unknown): value is PaymentEvidenceHandshakeLease {
  return plainRecord(value) && exactKeys(value, ["owner", "generation", "expiresAt"]) &&
    nonEmpty(value.owner) && safeUint(value.generation) && value.generation > 0 &&
    safeUint(value.expiresAt);
}

export function paymentEvidenceHandshakeViolation(value: unknown): string | null {
  if (!plainRecord(value) || !exactKeys(value, [
    "storeVersion",
    "role",
    "messageId",
    "request",
    "leaseGeneration",
    "createdAt",
    "updatedAt",
  ], [
    "requestAuthenticationHash",
    "completion",
    "completionAuthenticationHash",
    "lease",
  ])) return "payment-evidence handshake record fields are malformed";
  if (value.storeVersion !== PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION) {
    return "payment-evidence handshake store version is unsupported";
  }
  if ((value.role !== "seller" && value.role !== "buyer") ||
      !nonEmpty(value.messageId) || !isPaymentEvidenceAnchorRequest(value.request) ||
      value.messageId !== value.request.messageId || !safeUint(value.leaseGeneration) ||
      !safeUint(value.createdAt) || !safeUint(value.updatedAt) ||
      value.updatedAt < value.createdAt ||
      (value.requestAuthenticationHash !== undefined &&
        (typeof value.requestAuthenticationHash !== "string" ||
          !HASH_RE.test(value.requestAuthenticationHash))) ||
      (value.completionAuthenticationHash !== undefined &&
        (typeof value.completionAuthenticationHash !== "string" ||
          !HASH_RE.test(value.completionAuthenticationHash))) ||
      (value.lease !== undefined && !validLease(value.lease)) ||
      (value.completion !== undefined &&
        (!isPaymentEvidenceAnchorCompletion(value.completion) ||
          !completionMatchesRequest(value.request, value.completion)))) {
    return "payment-evidence handshake record is malformed";
  }
  if (value.role === "buyer" && value.requestAuthenticationHash === undefined) {
    return "buyer handshake record lacks authenticated request provenance";
  }
  if (value.role === "seller" && value.requestAuthenticationHash !== undefined) {
    return "seller handshake record carries buyer-only request provenance";
  }
  if (value.role === "seller" && value.completion !== undefined &&
      value.completionAuthenticationHash === undefined) {
    return "seller handshake completion lacks authenticated provenance";
  }
  if (value.role === "buyer" && value.completionAuthenticationHash !== undefined) {
    return "buyer handshake record carries seller-only completion provenance";
  }
  if (value.lease !== undefined && value.role !== "buyer") {
    return "seller handshake record cannot own a buyer anchor lease";
  }
  if (value.lease !== undefined && value.lease.generation !== value.leaseGeneration) {
    return "buyer handshake lease generation is inconsistent";
  }
  if (value.role === "seller" && value.leaseGeneration !== 0) {
    return "seller handshake record cannot carry a buyer lease generation";
  }
  if (value.role === "buyer" &&
      ((value.leaseGeneration === 0 && value.completion !== undefined) ||
        (value.leaseGeneration > 0 && value.lease === undefined && value.completion === undefined))) {
    return "buyer handshake lease history is inconsistent";
  }
  if (value.completion !== undefined && value.lease !== undefined) {
    return "completed handshake record cannot retain a lease";
  }
  return null;
}

function requireHandshakeRecord(
  value: unknown,
  role: PaymentEvidenceHandshakeRole,
  messageId?: string,
): PaymentEvidenceHandshakeRecord {
  const violation = paymentEvidenceHandshakeViolation(value);
  if (violation) throw new DacsError(violation);
  const record = clone(value as PaymentEvidenceHandshakeRecord);
  if (record.role !== role ||
      (messageId !== undefined && record.messageId !== messageId)) {
    throw new DacsError("payment-evidence store returned a different actor/message binding");
  }
  return record;
}

const recordKey = (role: PaymentEvidenceHandshakeRole, messageId: string): string =>
  `${role}:${messageId}`;

export function createInMemoryPaymentEvidenceHandshakeStore():
  PaymentEvidenceHandshakeStore {
  const records = new Map<string, PaymentEvidenceHandshakeRecord>();
  const loadRecord = (
    role: PaymentEvidenceHandshakeRole,
    messageId: string,
  ): PaymentEvidenceHandshakeLoad => {
    const found = records.get(recordKey(role, messageId));
    if (!found) return { status: "missing" };
    const violation = paymentEvidenceHandshakeViolation(found);
    return violation
      ? { status: "corrupt", reason: violation }
      : { status: "ok", record: clone(found) };
  };
  return {
    async putRequest(input) {
      if ((input.role !== "seller" && input.role !== "buyer") ||
          !isPaymentEvidenceAnchorRequest(input.request) || !safeUint(input.now) ||
          (input.role === "buyer" &&
            (typeof input.requestAuthenticationHash !== "string" ||
              !HASH_RE.test(input.requestAuthenticationHash))) ||
          (input.role === "seller" && input.requestAuthenticationHash !== undefined)) {
        return { status: "corrupt", reason: "payment-evidence request put is malformed" };
      }
      const key = recordKey(input.role, input.request.messageId);
      const existing = records.get(key);
      if (existing) {
        const violation = paymentEvidenceHandshakeViolation(existing);
        if (violation) return { status: "corrupt", reason: violation };
        const same = canonicalize(existing.request) === canonicalize(input.request) &&
          existing.requestAuthenticationHash === input.requestAuthenticationHash;
        return same
          ? { status: "existing", record: clone(existing) }
          : { status: "conflict" };
      }
      const record: PaymentEvidenceHandshakeRecord = {
        storeVersion: PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION,
        role: input.role,
        messageId: input.request.messageId,
        request: clone(input.request),
        ...(input.requestAuthenticationHash === undefined
          ? {}
          : { requestAuthenticationHash: input.requestAuthenticationHash }),
        leaseGeneration: 0,
        createdAt: input.now,
        updatedAt: input.now,
      };
      records.set(key, clone(record));
      return { status: "created", record: clone(record) };
    },

    async load(role, messageId) {
      return loadRecord(role, messageId);
    },

    async list(role) {
      return [...records.values()]
        .filter((record) => record.role === role)
        .sort((left, right) => left.messageId.localeCompare(right.messageId))
        .map((record) => {
          const violation = paymentEvidenceHandshakeViolation(record);
          return violation
            ? { status: "corrupt" as const, reason: violation }
            : { status: "ok" as const, record: clone(record) };
        });
    },

    async claimBuyer(input) {
      const loaded = loadRecord("buyer", input.messageId);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(recordKey("buyer", input.messageId))!;
      if (current.request.requestHash !== input.requestHash) return { status: "stale" };
      if (current.completion) return { status: "complete", record: clone(current) };
      if (!nonEmpty(input.owner) || !safeUint(input.now) ||
          !safeUint(input.leaseDurationMs) || input.leaseDurationMs === 0) {
        return { status: "corrupt", reason: "buyer handshake claim is malformed" };
      }
      if (current.lease && current.lease.expiresAt > input.now) {
        return { status: "waiting", record: clone(current), lease: clone(current.lease) };
      }
      const expiresAt = input.now + input.leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) {
        return { status: "corrupt", reason: "buyer handshake lease expiry overflows" };
      }
      const lease: PaymentEvidenceHandshakeLease = {
        owner: input.owner,
        generation: current.leaseGeneration + 1,
        expiresAt,
      };
      const next: PaymentEvidenceHandshakeRecord = {
        ...clone(current),
        leaseGeneration: lease.generation,
        lease,
        updatedAt: input.now,
      };
      records.set(recordKey("buyer", input.messageId), clone(next));
      return { status: "acquired", record: clone(next), lease: clone(lease) };
    },

    async isCurrentBuyer(input) {
      const loaded = loadRecord("buyer", input.messageId);
      if (loaded.status !== "ok" || loaded.record.request.requestHash !== input.requestHash ||
          loaded.record.completion || !loaded.record.lease) return false;
      const lease = loaded.record.lease;
      return lease.owner === input.lease.owner &&
        lease.generation === input.lease.generation &&
        lease.expiresAt === input.lease.expiresAt && lease.expiresAt > input.now;
    },

    async recordBuyerCompletion(input) {
      const loaded = loadRecord("buyer", input.messageId);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(recordKey("buyer", input.messageId))!;
      if (current.request.requestHash !== input.requestHash || !safeUint(input.now)) {
        return { status: "stale" };
      }
      if (current.completion) {
        return canonicalize(current.completion) === canonicalize(input.completion)
          ? { status: "existing", record: clone(current) }
          : { status: "conflict" };
      }
      const lease = current.lease;
      if (!lease || lease.owner !== input.lease.owner ||
          lease.generation !== input.lease.generation ||
          lease.expiresAt !== input.lease.expiresAt || lease.expiresAt <= input.now ||
          !isPaymentEvidenceAnchorCompletion(input.completion) ||
          !completionMatchesRequest(current.request, input.completion)) {
        return { status: "stale" };
      }
      const next: PaymentEvidenceHandshakeRecord = {
        ...clone(current),
        completion: clone(input.completion),
        updatedAt: input.now,
      };
      delete next.lease;
      records.set(recordKey("buyer", input.messageId), clone(next));
      return { status: "recorded", record: clone(next) };
    },

    async recordSellerCompletion(input) {
      const loaded = loadRecord("seller", input.messageId);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(recordKey("seller", input.messageId))!;
      if (current.request.requestHash !== input.requestHash || !safeUint(input.now) ||
          typeof input.completionAuthenticationHash !== "string" ||
          !HASH_RE.test(input.completionAuthenticationHash) ||
          !isPaymentEvidenceAnchorCompletion(input.completion) ||
          !completionMatchesRequest(current.request, input.completion)) {
        return { status: "conflict" };
      }
      if (current.completion) {
        const same = canonicalize(current.completion) === canonicalize(input.completion) &&
          current.completionAuthenticationHash === input.completionAuthenticationHash;
        return same
          ? { status: "existing", record: clone(current) }
          : { status: "conflict" };
      }
      const next: PaymentEvidenceHandshakeRecord = {
        ...clone(current),
        completion: clone(input.completion),
        completionAuthenticationHash: input.completionAuthenticationHash,
        updatedAt: input.now,
      };
      records.set(recordKey("seller", input.messageId), clone(next));
      return { status: "recorded", record: clone(next) };
    },
  };
}

function captureAuthentication(value: unknown): PaymentEvidenceTransportAuthentication {
  const result = ownClone(value, "payment-evidence transport authentication") as unknown as
    Record<string, unknown>;
  if (result.disposition === "authenticated" && exactKeys(
    result,
    ["disposition", "authenticationHash"],
  ) && typeof result.authenticationHash === "string" && HASH_RE.test(result.authenticationHash)) {
    return result as unknown as PaymentEvidenceTransportAuthentication;
  }
  if ((result.disposition === "rejected" || result.disposition === "indeterminate") &&
      exactKeys(result, ["disposition", "reason"]) && nonEmpty(result.reason)) {
    return result as unknown as PaymentEvidenceTransportAuthentication;
  }
  throw new DacsError("payment-evidence transport authentication is malformed");
}

function captureVerification(value: unknown): PaymentEvidenceAnchorVerification {
  const result = ownClone(value, "payment-evidence anchor verification") as unknown as
    Record<string, unknown>;
  if (result.disposition === "valid" && exactKeys(result, ["disposition"])) {
    return { disposition: "valid" };
  }
  if (["invalid", "indeterminate", "error"].includes(result.disposition as string) &&
      exactKeys(result, ["disposition", "reason"]) && nonEmpty(result.reason)) {
    return result as unknown as PaymentEvidenceAnchorVerification;
  }
  throw new DacsError("payment-evidence anchor verification is malformed");
}

function captureAnchorResult(value: unknown): SellerSessionSettlementAnchorResult {
  const result = ownClone(value, "payment-evidence anchor result") as unknown as
    Record<string, unknown>;
  if (result.disposition === "anchored" && exactKeys(
    result,
    ["disposition", "evidenceRef", "anchorReceipt"],
  ) && isAttestationRef(result.evidenceRef) && isAnchorReceipt(result.anchorReceipt)) {
    return result as unknown as SellerSessionSettlementAnchorResult;
  }
  if (["rejected", "indeterminate", "error"].includes(result.disposition as string) &&
      exactKeys(result, ["disposition", "reason"]) && nonEmpty(result.reason)) {
    return result as unknown as SellerSessionSettlementAnchorResult;
  }
  throw new DacsError("payment-evidence anchor result is malformed");
}

function captureClock(value: unknown): () => number {
  const clock = value ?? Date.now;
  if (typeof clock !== "function") throw new DacsError("handshake now must be a function");
  return () => {
    const result = Reflect.apply(clock, INERT_RECEIVER, []);
    if (!safeUint(result)) throw new DacsError("handshake clock returned an invalid time");
    return result;
  };
}

function captureLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!safeUint(value) || value === 0) {
    throw new DacsError("payment-evidence handshake limit must be positive");
  }
  return value;
}

function requireStore(value: unknown): PaymentEvidenceHandshakeStore {
  if (!plainRecord(value)) throw new DacsError("payment-evidence handshake store is malformed");
  const store = value as unknown as PaymentEvidenceHandshakeStore;
  for (const method of [
    "putRequest",
    "load",
    "list",
    "claimBuyer",
    "isCurrentBuyer",
    "recordBuyerCompletion",
    "recordSellerCompletion",
  ] as const) {
    if (typeof store[method] !== "function") {
      throw new DacsError(`payment-evidence handshake store.${method} is required`);
    }
  }
  return store;
}

export function createBuyerPaymentEvidenceHandshake(
  options: BuyerPaymentEvidenceHandshakeOptions,
): BuyerPaymentEvidenceHandshake {
  if (!plainRecord(options) || !exactKeys(options, [
    "store",
    "buyer",
    "workerId",
    "authenticateRequest",
    "verifyEvidence",
    "anchorEvidence",
    "verifyAnchorReceipt",
  ], ["leaseDurationMs", "now"]) || !nonEmpty(options.buyer) ||
      !nonEmpty(options.workerId) ||
      typeof options.authenticateRequest !== "function" ||
      typeof options.verifyEvidence !== "function" ||
      typeof options.anchorEvidence !== "function" ||
      typeof options.verifyAnchorReceipt !== "function") {
    throw new DacsError("buyer payment-evidence handshake options are malformed");
  }
  const store = requireStore(options.store);
  const buyer = options.buyer;
  const workerId = options.workerId;
  const authenticateRequest = options.authenticateRequest;
  const verifyEvidence = options.verifyEvidence;
  const anchorEvidence = options.anchorEvidence;
  const verifyAnchorReceipt = options.verifyAnchorReceipt;
  const now = captureClock(options.now);
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  if (!safeUint(leaseDurationMs) || leaseDurationMs === 0) {
    throw new DacsError("buyer handshake leaseDurationMs must be positive");
  }

  const handshake: BuyerPaymentEvidenceHandshake = {
    async receiveRequest(input) {
      const request = ownClone(input, "payment-evidence anchor request");
      if (!isPaymentEvidenceAnchorRequest(request)) {
        throw new DacsError("payment-evidence anchor request is malformed");
      }
      if (request.buyer !== buyer || request.expectedWriter.primaryClaim !== buyer) {
        throw new DacsError("payment-evidence anchor request targets a different buyer");
      }
      const before = canonicalize(request);
      const authentication = captureAuthentication(
        await Reflect.apply(authenticateRequest, INERT_RECEIVER, [clone(request)]),
      );
      if (canonicalize(request) !== before) {
        throw new DacsError("request authenticator mutated payment-evidence input");
      }
      if (authentication.disposition !== "authenticated") {
        throw new DacsError(
          `payment-evidence request ${authentication.disposition}: ${authentication.reason}`,
        );
      }
      const evidenceVerification = captureVerification(await Reflect.apply(
        verifyEvidence,
        INERT_RECEIVER,
        [clone(request)],
      ));
      if (canonicalize(request) !== before) {
        throw new DacsError("evidence verifier mutated payment-evidence input");
      }
      if (evidenceVerification.disposition !== "valid") {
        throw new DacsError(
          `payment evidence ${evidenceVerification.disposition}: ${evidenceVerification.reason}`,
        );
      }
      const stored = clone(await store.putRequest({
        role: "buyer",
        request,
        requestAuthenticationHash: authentication.authenticationHash,
        now: now(),
      }));
      if (stored.status === "conflict") {
        throw new DacsError("payment-evidence request conflicts with retained inbox state");
      }
      if (stored.status === "corrupt") throw new DacsError(stored.reason);
      if (stored.status === "unsupported") {
        throw new DacsError(`payment-evidence store version ${stored.version} is unsupported`);
      }
      requireHandshakeRecord(stored.record, "buyer", request.messageId);
      return stored.status === "created" ? "accepted" : "existing";
    },

    async runPending(input = {}) {
      if (!plainRecord(input) || !exactKeys(input, [], ["limit", "signal"]) ||
          (input.signal !== undefined && !(input.signal instanceof AbortSignal))) {
        throw new DacsError("buyer handshake run options are malformed");
      }
      const limit = captureLimit(input.limit);
      const results: PaymentEvidenceHandshakeRunResult[] = [];
      const listed = clone(await store.list("buyer"));
      for (const load of listed) {
        if (results.length >= limit || input.signal?.aborted) break;
        if (load.status === "corrupt") throw new DacsError(load.reason);
        if (load.status === "unsupported") {
          throw new DacsError(`payment-evidence store version ${load.version} is unsupported`);
        }
        if (load.status !== "ok") continue;
        const listedRecord = requireHandshakeRecord(load.record, "buyer");
        if (listedRecord.completion) continue;
        let request = clone(listedRecord.request);
        const claim = clone(await store.claimBuyer({
          messageId: request.messageId,
          requestHash: request.requestHash,
          owner: workerId,
          now: now(),
          leaseDurationMs,
        }));
        if (claim.status !== "acquired") {
          if (claim.status === "corrupt") throw new DacsError(claim.reason);
          if (claim.status === "unsupported") {
            throw new DacsError(`payment-evidence store version ${claim.version} is unsupported`);
          }
          if (claim.status === "waiting" || claim.status === "complete") {
            requireHandshakeRecord(claim.record, "buyer", request.messageId);
          }
          results.push({
            messageId: request.messageId,
            status: claim.status === "waiting" ? "waiting" :
              claim.status === "stale" ? "stale" : "waiting",
          });
          continue;
        }
        const claimedRecord = requireHandshakeRecord(
          claim.record,
          "buyer",
          request.messageId,
        );
        request = clone(claimedRecord.request);
        const lease = clone(claim.lease);
        if (!validLease(lease) || !claimedRecord.lease ||
            canonicalize(lease) !== canonicalize(claimedRecord.lease)) {
          throw new DacsError("payment-evidence store returned an invalid buyer lease");
        }
        const fence: PaymentEvidenceAnchorFence = Object.freeze({
          messageId: request.messageId,
          requestHash: request.requestHash,
          effectId: request.effectId,
          owner: lease.owner,
          generation: lease.generation,
          idempotencyKey: request.messageId,
          assertCurrent: async () => {
            if (!await store.isCurrentBuyer({
              messageId: request.messageId,
              requestHash: request.requestHash,
              lease,
              now: now(),
            })) throw new DacsError("buyer payment-evidence anchor fence is stale");
          },
        });
        let anchored: SellerSessionSettlementAnchorResult;
        try {
          anchored = captureAnchorResult(await Reflect.apply(anchorEvidence, INERT_RECEIVER, [{
            effectId: request.effectId,
            logicalAddress: request.logicalAddress,
            evidenceHash: request.evidenceHash,
            evidence: clone(request.evidence),
            expectedWriter: clone(request.expectedWriter),
          }, fence]));
        } catch (error) {
          results.push({
            messageId: request.messageId,
            status: "indeterminate",
            reason: String(error),
          });
          continue;
        }
        if (anchored.disposition !== "anchored") {
          results.push({
            messageId: request.messageId,
            status: anchored.disposition === "rejected" ? "rejected" : "indeterminate",
            reason: anchored.reason,
          });
          continue;
        }
        let completion: PaymentEvidenceAnchorCompletion;
        try {
          completion = createPaymentEvidenceAnchorCompletion({
            request,
            evidenceRef: anchored.evidenceRef,
            anchorReceipt: anchored.anchorReceipt,
          });
        } catch (error) {
          results.push({
            messageId: request.messageId,
            status: "rejected",
            reason: String(error),
          });
          continue;
        }
        const verification = captureVerification(await Reflect.apply(
          verifyAnchorReceipt,
          INERT_RECEIVER,
          [{ request: clone(request), completion: clone(completion) }],
        ));
        if (verification.disposition !== "valid") {
          results.push({
            messageId: request.messageId,
            status: verification.disposition === "invalid" ? "rejected" : "indeterminate",
            reason: verification.reason,
          });
          continue;
        }
        const written = clone(await store.recordBuyerCompletion({
          messageId: request.messageId,
          requestHash: request.requestHash,
          lease,
          completion,
          now: now(),
        }));
        if (written.status === "corrupt") throw new DacsError(written.reason);
        if (written.status === "unsupported") {
          throw new DacsError(`payment-evidence store version ${written.version} is unsupported`);
        }
        if (written.status === "recorded" || written.status === "existing") {
          requireHandshakeRecord(written.record, "buyer", request.messageId);
        }
        results.push({
          messageId: request.messageId,
          status: written.status === "recorded" || written.status === "existing"
            ? "completed"
            : "stale",
        });
      }
      return clone(results);
    },

    async listOutboundCompletions(limit = DEFAULT_LIMIT) {
      const max = captureLimit(limit);
      const listed = clone(await store.list("buyer"));
      const completions: PaymentEvidenceAnchorCompletion[] = [];
      for (const load of listed) {
        if (load.status === "corrupt") throw new DacsError(load.reason);
        if (load.status === "unsupported") {
          throw new DacsError(`payment-evidence store version ${load.version} is unsupported`);
        }
        if (load.status !== "ok") continue;
        const record = requireHandshakeRecord(load.record, "buyer");
        if (record.completion) completions.push(clone(record.completion));
      }
      return completions.slice(0, max);
    },
  };
  return Object.freeze(handshake);
}

export function createSellerPaymentEvidenceHandshake(
  options: SellerPaymentEvidenceHandshakeOptions,
): SellerPaymentEvidenceHandshake {
  if (!plainRecord(options) || !exactKeys(options, [
    "store",
    "seller",
    "buyer",
    "authenticateCompletion",
    "verifyAnchorReceipt",
  ], ["now"]) || !nonEmpty(options.seller) || !nonEmpty(options.buyer) ||
      options.seller === options.buyer || typeof options.authenticateCompletion !== "function" ||
      typeof options.verifyAnchorReceipt !== "function") {
    throw new DacsError("seller payment-evidence handshake options are malformed");
  }
  const store = requireStore(options.store);
  const seller = options.seller;
  const buyer = options.buyer;
  const authenticateCompletion = options.authenticateCompletion;
  const verifyAnchorReceipt = options.verifyAnchorReceipt;
  const now = captureClock(options.now);

  const handshake: SellerPaymentEvidenceHandshake = {
    async anchorEvidence(input) {
      let request: PaymentEvidenceAnchorRequest;
      try {
        request = createPaymentEvidenceAnchorRequest({
          ...ownClone(input, "seller payment-evidence anchor input"),
          seller,
          buyer,
        });
      } catch (error) {
        return { disposition: "rejected", reason: String(error) };
      }
      const stored = clone(await store.putRequest({
        role: "seller",
        request,
        now: now(),
      }));
      if (stored.status !== "created" && stored.status !== "existing") {
        return {
          disposition: stored.status === "conflict" ? "rejected" : "indeterminate",
          reason: stored.status === "corrupt"
            ? stored.reason
            : "payment-evidence request conflicts with retained outbox state",
        };
      }
      const record = requireHandshakeRecord(stored.record, "seller", request.messageId);
      if (record.completion) {
        return {
          disposition: "anchored",
          evidenceRef: clone(record.completion.evidenceRef),
          anchorReceipt: clone(record.completion.anchorReceipt),
        };
      }
      return {
        disposition: "indeterminate",
        reason: "payment-evidence buyer anchor request is durably pending",
      };
    },

    async listOutboundRequests(limit = DEFAULT_LIMIT) {
      const max = captureLimit(limit);
      const listed = clone(await store.list("seller"));
      const requests: PaymentEvidenceAnchorRequest[] = [];
      for (const load of listed) {
        if (load.status === "corrupt") throw new DacsError(load.reason);
        if (load.status === "unsupported") {
          throw new DacsError(`payment-evidence store version ${load.version} is unsupported`);
        }
        if (load.status !== "ok") continue;
        const record = requireHandshakeRecord(load.record, "seller");
        if (!record.completion) requests.push(clone(record.request));
      }
      return requests.slice(0, max);
    },

    async receiveCompletion(input) {
      const completion = ownClone(input, "payment-evidence anchor completion");
      if (!isPaymentEvidenceAnchorCompletion(completion)) {
        throw new DacsError("payment-evidence anchor completion is malformed");
      }
      const loaded = clone(await store.load("seller", completion.requestMessageId));
      if (loaded.status === "corrupt") throw new DacsError(loaded.reason);
      if (loaded.status === "unsupported") {
        throw new DacsError(`payment-evidence store version ${loaded.version} is unsupported`);
      }
      if (loaded.status !== "ok") {
        throw new DacsError("payment-evidence completion has no retained seller request");
      }
      const record = requireHandshakeRecord(
        loaded.record,
        "seller",
        completion.requestMessageId,
      );
      if (!completionMatchesRequest(record.request, completion)) {
        throw new DacsError("payment-evidence completion does not bind the retained request");
      }
      const authentication = captureAuthentication(await Reflect.apply(
        authenticateCompletion,
        INERT_RECEIVER,
        [clone(completion)],
      ));
      if (authentication.disposition !== "authenticated") {
        throw new DacsError(
          `payment-evidence completion ${authentication.disposition}: ${authentication.reason}`,
        );
      }
      const verification = captureVerification(await Reflect.apply(
        verifyAnchorReceipt,
        INERT_RECEIVER,
        [{ request: clone(record.request), completion: clone(completion) }],
      ));
      if (verification.disposition !== "valid") {
        throw new DacsError(
          `payment-evidence completion ${verification.disposition}: ${verification.reason}`,
        );
      }
      const written = clone(await store.recordSellerCompletion({
        messageId: record.messageId,
        requestHash: record.request.requestHash,
        completion,
        completionAuthenticationHash: authentication.authenticationHash,
        now: now(),
      }));
      if (written.status !== "recorded" && written.status !== "existing") {
        throw new DacsError("payment-evidence completion conflicts with retained seller state");
      }
      requireHandshakeRecord(written.record, "seller", record.messageId);
      return written.status === "recorded" ? "accepted" : "existing";
    },
  };
  return Object.freeze(handshake);
}
