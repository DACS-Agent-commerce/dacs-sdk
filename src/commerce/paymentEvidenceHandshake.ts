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
import { encodeAddressSegment } from "../canonical/addressing.js";
import { canonicalize, contentHash, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import {
  isCanonicalClaimReference,
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";
import type {
  SellerSessionSettlementAnchorResult,
  SellerSessionSettlementAnchorWriter,
} from "../seller/sessionSettlementPublication.js";
import {
  captureFixedPriceX402ProtocolBinding,
  fixedPriceX402ProtocolBindingHash,
  type FixedPriceX402ProtocolBinding,
} from "./fixedPriceX402Protocol.js";

export const PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION = 3 as const;

export type PaymentEvidenceHandshakeRole = "seller" | "buyer";

export interface PaymentEvidenceHandshakeScope {
  seller: string;
  buyer: string;
  protocolHash: string;
}

export interface PaymentEvidenceAnchorRequest {
  requestVersion: "2";
  messageId: string;
  requestHash: string;
  jobId: string;
  effectId: string;
  seller: string;
  buyer: string;
  protocolHash: string;
  protocol: Readonly<FixedPriceX402ProtocolBinding>;
  logicalAddress: string;
  evidenceHash: string;
  evidence: Readonly<SettlementEvidence>;
  expectedWriter: Readonly<SellerSessionSettlementAnchorWriter & { role: "buyer" }>;
}

export interface PaymentEvidenceAnchorCompletion {
  completionVersion: "3";
  messageId: string;
  completionHash: string;
  requestMessageId: string;
  requestHash: string;
  jobId: string;
  effectId: string;
  seller: string;
  buyer: string;
  protocolHash: string;
  evidenceHash: string;
  evidenceRef: Readonly<AttestationRef>;
  anchorReceipt: Readonly<AnchorReceipt>;
}

/**
 * Result of host transport verification. The SDK checks every verified field
 * against the exact message, so a JWT/mTLS/signed-envelope result cannot be
 * replayed for another actor, audience, or payload.
 */
export interface PaymentEvidenceAuthenticatedPeer {
  principal: string;
  audience: string;
  messageId: string;
  messageHash: string;
  authenticationHash: string;
}

export type PaymentEvidenceTransportAuthentication =
  | {
      disposition: "authenticated";
      peer: Readonly<PaymentEvidenceAuthenticatedPeer>;
    }
  | { disposition: "rejected" | "indeterminate"; reason: string };

export type PaymentEvidenceAnchorVerification =
  | { disposition: "valid" }
  | { disposition: "invalid" | "indeterminate" | "error"; reason: string };

export type PaymentEvidenceAnchorReconciliation =
  | {
      disposition: "anchored";
      evidenceRef: Readonly<AttestationRef>;
      anchorReceipt: Readonly<AnchorReceipt>;
    }
  | { disposition: "absent"; absenceProofHash: string }
  | { disposition: "invalid" | "indeterminate" | "error"; reason: string };

export interface PaymentEvidenceHandshakeLease {
  owner: string;
  generation: number;
  expiresAt: number;
}

export type PaymentEvidenceBuyerWorkState =
  | "pending"
  | "reconciliation-required"
  | "operator-action"
  | "complete";

export interface PaymentEvidenceBuyerWork {
  state: PaymentEvidenceBuyerWorkState;
  generation: number;
  attempts: number;
  updatedAt: number;
  retryAt?: number;
  reasonCode?: string;
  absenceProofHash?: string;
  lease?: Readonly<PaymentEvidenceHandshakeLease>;
}

export type PaymentEvidenceOutboxState =
  | "pending"
  | "sending"
  | "acknowledged"
  | "operator-action";

export interface PaymentEvidenceOutbox {
  state: PaymentEvidenceOutboxState;
  generation: number;
  attempts: number;
  updatedAt: number;
  retryAt?: number;
  reasonCode?: string;
  lease?: Readonly<PaymentEvidenceHandshakeLease>;
}

export interface PaymentEvidenceHandshakeRecord {
  storeVersion: typeof PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION;
  revision: number;
  role: PaymentEvidenceHandshakeRole;
  messageId: string;
  request: Readonly<PaymentEvidenceAnchorRequest>;
  requestAuthentication?: Readonly<PaymentEvidenceAuthenticatedPeer>;
  requestOutbox?: Readonly<PaymentEvidenceOutbox>;
  buyerWork?: Readonly<PaymentEvidenceBuyerWork>;
  completion?: Readonly<PaymentEvidenceAnchorCompletion>;
  completionAuthentication?: Readonly<PaymentEvidenceAuthenticatedPeer>;
  completionOutbox?: Readonly<PaymentEvidenceOutbox>;
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
      mode: "anchor" | "reconcile";
      record: Readonly<PaymentEvidenceHandshakeRecord>;
      lease: Readonly<PaymentEvidenceHandshakeLease>;
    }
  | {
      status: "waiting";
      record: Readonly<PaymentEvidenceHandshakeRecord>;
      lease: Readonly<PaymentEvidenceHandshakeLease>;
    }
  | { status: "complete" | "not-runnable"; record: Readonly<PaymentEvidenceHandshakeRecord> }
  | { status: "missing" | "stale" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type PaymentEvidenceHandshakeWrite =
  | { status: "recorded" | "existing"; record: Readonly<PaymentEvidenceHandshakeRecord> }
  | { status: "missing" | "stale" | "conflict" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export interface PaymentEvidencePage<T> {
  items: readonly T[];
  nextCursor?: string;
}

export interface PaymentEvidenceOutboundRequestClaim {
  request: Readonly<PaymentEvidenceAnchorRequest>;
  lease: Readonly<PaymentEvidenceHandshakeLease>;
}

export interface PaymentEvidenceOutboundCompletionClaim {
  completion: Readonly<PaymentEvidenceAnchorCompletion>;
  lease: Readonly<PaymentEvidenceHandshakeLease>;
}

export interface PaymentEvidenceHandshakeStore {
  /** Store-authoritative time, normally a database/server clock in production. */
  readTime(): Promise<number>;
  /**
   * Atomically reserves messageId, effectId, and logicalAddress. Exact replay
   * returns existing; any different payload sharing one reservation conflicts.
   */
  putRequest(input: Readonly<{
    role: PaymentEvidenceHandshakeRole;
    scopeHash: string;
    request: Readonly<PaymentEvidenceAnchorRequest>;
    requestAuthentication?: Readonly<PaymentEvidenceAuthenticatedPeer>;
  }>): Promise<PaymentEvidenceHandshakePut>;
  load(
    role: PaymentEvidenceHandshakeRole,
    messageId: string,
    scopeHash: string,
  ): Promise<PaymentEvidenceHandshakeLoad>;
  listBuyerRunnable(input: Readonly<{
    scopeHash: string;
    cursor?: string;
    limit: number;
  }>): Promise<PaymentEvidencePage<Readonly<PaymentEvidenceHandshakeRecord>>>;
  /**
   * Atomically leases work and writes its irreversible-effect intent. An
   * `anchor` claim must already retain `reconciliation-required` with the
   * same lease before it is returned to the caller.
   */
  claimBuyer(input: Readonly<{
    scopeHash: string;
    messageId: string;
    requestHash: string;
    owner: string;
    leaseDurationMs: number;
  }>): Promise<PaymentEvidenceHandshakeClaim>;
  isCurrentBuyer(input: Readonly<{
    scopeHash: string;
    messageId: string;
    requestHash: string;
    lease: Readonly<PaymentEvidenceHandshakeLease>;
  }>): Promise<boolean>;
  recordBuyerAttempt(input: Readonly<{
    scopeHash: string;
    messageId: string;
    requestHash: string;
    lease: Readonly<PaymentEvidenceHandshakeLease>;
    state: "reconciliation-required" | "operator-action";
    reasonCode: string;
    retryAt?: number;
  }>): Promise<PaymentEvidenceHandshakeWrite>;
  recordBuyerAbsence(input: Readonly<{
    scopeHash: string;
    messageId: string;
    requestHash: string;
    lease: Readonly<PaymentEvidenceHandshakeLease>;
    absenceProofHash: string;
  }>): Promise<PaymentEvidenceHandshakeWrite>;
  recordBuyerCompletion(input: Readonly<{
    scopeHash: string;
    messageId: string;
    requestHash: string;
    lease: Readonly<PaymentEvidenceHandshakeLease>;
    completion: Readonly<PaymentEvidenceAnchorCompletion>;
  }>): Promise<PaymentEvidenceHandshakeWrite>;
  requeueBuyer(input: Readonly<{
    scopeHash: string;
    messageId: string;
    requestHash: string;
    operatorReasonCode: string;
  }>): Promise<PaymentEvidenceHandshakeWrite>;
  recordSellerCompletion(input: Readonly<{
    scopeHash: string;
    messageId: string;
    requestHash: string;
    completion: Readonly<PaymentEvidenceAnchorCompletion>;
    completionAuthentication: Readonly<PaymentEvidenceAuthenticatedPeer>;
  }>): Promise<PaymentEvidenceHandshakeWrite>;
  claimSellerRequests(input: Readonly<{
    scopeHash: string;
    owner: string;
    cursor?: string;
    limit: number;
    leaseDurationMs: number;
  }>): Promise<PaymentEvidencePage<PaymentEvidenceOutboundRequestClaim>>;
  acknowledgeSellerRequest(input: Readonly<{
    scopeHash: string;
    messageId: string;
    requestHash: string;
    lease: Readonly<PaymentEvidenceHandshakeLease>;
  }>): Promise<PaymentEvidenceHandshakeWrite>;
  releaseSellerRequest(input: Readonly<{
    scopeHash: string;
    messageId: string;
    requestHash: string;
    lease: Readonly<PaymentEvidenceHandshakeLease>;
    reasonCode: string;
    retryAt?: number;
  }>): Promise<PaymentEvidenceHandshakeWrite>;
  claimBuyerCompletions(input: Readonly<{
    scopeHash: string;
    owner: string;
    cursor?: string;
    limit: number;
    leaseDurationMs: number;
  }>): Promise<PaymentEvidencePage<PaymentEvidenceOutboundCompletionClaim>>;
  acknowledgeBuyerCompletion(input: Readonly<{
    scopeHash: string;
    messageId: string;
    completionHash: string;
    lease: Readonly<PaymentEvidenceHandshakeLease>;
  }>): Promise<PaymentEvidenceHandshakeWrite>;
  releaseBuyerCompletion(input: Readonly<{
    scopeHash: string;
    messageId: string;
    completionHash: string;
    lease: Readonly<PaymentEvidenceHandshakeLease>;
    reasonCode: string;
    retryAt?: number;
  }>): Promise<PaymentEvidenceHandshakeWrite>;
}

/**
 * Lease generation and stable effect identity for one buyer-owned anchor.
 * `assertCurrent` is a cooperative precondition, not an effect transaction:
 * adapters must also fence generations durably under `idempotencyKey`.
 */
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
  seller: string;
  buyer: string;
  protocol: Readonly<FixedPriceX402ProtocolBinding>;
  workerId: string;
  authenticateRequest(
    request: Readonly<PaymentEvidenceAnchorRequest>,
    transportContext: unknown,
  ): Promise<PaymentEvidenceTransportAuthentication> | PaymentEvidenceTransportAuthentication;
  verifyEvidence(
    request: Readonly<PaymentEvidenceAnchorRequest>,
  ): Promise<PaymentEvidenceAnchorVerification> | PaymentEvidenceAnchorVerification;
  /**
   * Perform through a durable intent/perform/commit journal keyed by
   * `fence.idempotencyKey`. The journal must monotonically fence generations,
   * and the adapter must call `fence.assertCurrent()` immediately before it
   * atomically acquires permission to perform the irreversible effect.
   */
  anchorEvidence(
    input: Readonly<{
      effectId: string;
      logicalAddress: string;
      evidenceHash: string;
      evidence: Readonly<SettlementEvidence>;
      expectedWriter: Readonly<SellerSessionSettlementAnchorWriter & { role: "buyer" }>;
      signal?: AbortSignal;
    }>,
    fence: Readonly<PaymentEvidenceAnchorFence>,
  ): Promise<SellerSessionSettlementAnchorResult> | SellerSessionSettlementAnchorResult;
  /**
   * Required before an ambiguous wallet effect may be attempted again.
   * `absent` is permitted only after authenticated substrate absence and after
   * the same durable journal has fenced or quiesced every older performer.
   */
  reconcileAnchor(
    input: Readonly<{
      effectId: string;
      logicalAddress: string;
      evidenceHash: string;
      evidence: Readonly<SettlementEvidence>;
      expectedWriter: Readonly<SellerSessionSettlementAnchorWriter & { role: "buyer" }>;
      signal?: AbortSignal;
    }>,
    fence: Readonly<PaymentEvidenceAnchorFence>,
  ): Promise<PaymentEvidenceAnchorReconciliation> | PaymentEvidenceAnchorReconciliation;
  verifyAnchorReceipt(input: Readonly<{
    request: Readonly<PaymentEvidenceAnchorRequest>;
    completion: Readonly<PaymentEvidenceAnchorCompletion>;
    signal?: AbortSignal;
  }>): Promise<PaymentEvidenceAnchorVerification> | PaymentEvidenceAnchorVerification;
  leaseDurationMs?: number;
  retryDelayMs?: number;
}

export interface SellerPaymentEvidenceHandshakeOptions {
  store: PaymentEvidenceHandshakeStore;
  seller: string;
  buyer: string;
  workerId: string;
  protocol: Readonly<FixedPriceX402ProtocolBinding>;
  authenticateCompletion(
    completion: Readonly<PaymentEvidenceAnchorCompletion>,
    transportContext: unknown,
  ): Promise<PaymentEvidenceTransportAuthentication> | PaymentEvidenceTransportAuthentication;
  verifyAnchorReceipt(input: Readonly<{
    request: Readonly<PaymentEvidenceAnchorRequest>;
    completion: Readonly<PaymentEvidenceAnchorCompletion>;
  }>): Promise<PaymentEvidenceAnchorVerification> | PaymentEvidenceAnchorVerification;
  leaseDurationMs?: number;
}

export interface PaymentEvidenceHandshakeRunResult {
  messageId: string;
  status:
    | "completed"
    | "waiting"
    | "reconciliation-required"
    | "operator-action"
    | "reconciled-absent"
    | "stale";
  reasonCode?: string;
}

export interface BuyerPaymentEvidenceHandshake {
  receiveRequest(
    request: Readonly<PaymentEvidenceAnchorRequest>,
    transportContext: unknown,
  ): Promise<"accepted" | "existing">;
  runPending(options?: Readonly<{
    cursor?: string;
    limit?: number;
    /** Run one already-retained request without advancing unrelated orders. */
    messageId?: string;
    requestHash?: string;
    signal?: AbortSignal;
  }>): Promise<PaymentEvidencePage<PaymentEvidenceHandshakeRunResult>>;
  claimOutboundCompletions(options?: Readonly<{
    cursor?: string;
    limit?: number;
  }>): Promise<PaymentEvidencePage<PaymentEvidenceOutboundCompletionClaim>>;
  acknowledgeOutboundCompletion(
    claim: Readonly<PaymentEvidenceOutboundCompletionClaim>,
  ): Promise<"acknowledged" | "existing">;
  releaseOutboundCompletion(
    claim: Readonly<PaymentEvidenceOutboundCompletionClaim>,
    input: Readonly<{ reasonCode: string; retryAt?: number }>,
  ): Promise<void>;
  repairRequest(
    messageId: string,
    requestHash: string,
    operatorReasonCode: string,
  ): Promise<void>;
}

export interface SellerPaymentEvidenceHandshake {
  anchorEvidence(input: Readonly<{
    effectId: string;
    logicalAddress: string;
    evidenceHash: string;
    evidence: Readonly<SettlementEvidence>;
    expectedWriter: Readonly<SellerSessionSettlementAnchorWriter>;
  }>): Promise<SellerSessionSettlementAnchorResult>;
  claimOutboundRequests(options?: Readonly<{
    cursor?: string;
    limit?: number;
  }>): Promise<PaymentEvidencePage<PaymentEvidenceOutboundRequestClaim>>;
  acknowledgeOutboundRequest(
    claim: Readonly<PaymentEvidenceOutboundRequestClaim>,
  ): Promise<"acknowledged" | "existing">;
  releaseOutboundRequest(
    claim: Readonly<PaymentEvidenceOutboundRequestClaim>,
    input: Readonly<{ reasonCode: string; retryAt?: number }>,
  ): Promise<void>;
  receiveCompletion(
    completion: Readonly<PaymentEvidenceAnchorCompletion>,
    transportContext: unknown,
  ): Promise<"accepted" | "existing">;
}

const HASH_RE = /^[0-9a-f]{64}$/;
const REASON_CODE_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const TRACK_MESSAGE_PREFIX = "dacs-sdk:x402:payment-evidence-anchor-request:";
const COMPLETION_MESSAGE_PREFIX = "dacs-sdk:x402:payment-evidence-anchor-completion:";
const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
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

/**
 * Pair/rail tenant key. CORE B.1 CF-3 identities deliberately exclude advisory
 * ClaimReference parameters, preventing qualifier aliases from creating a
 * second handshake tenant for the same actor.
 */
export function paymentEvidenceHandshakeScopeHash(
  input: Readonly<PaymentEvidenceHandshakeScope>,
): string {
  if (!plainRecord(input) || !exactKeys(input, ["seller", "buyer", "protocolHash"]) ||
      !isCanonicalClaimReference(input.seller) ||
      !isCanonicalClaimReference(input.buyer) ||
      sameCanonicalClaimIdentity(input.seller, input.buyer) ||
      typeof input.protocolHash !== "string" || !HASH_RE.test(input.protocolHash)) {
    throw new DacsError("payment-evidence handshake scope is malformed");
  }
  const seller = parseCanonicalClaimReference(input.seller)!.identity;
  const buyer = parseCanonicalClaimReference(input.buyer)!.identity;
  return sha256Hex(canonicalize({ scopeVersion: "1", seller, buyer, protocolHash: input.protocolHash }));
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function storeObject(value: unknown): value is object {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !nodeTypes.isProxy(value);
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
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
        descriptor.value === undefined) {
      throw new DacsError(`${label} must contain enumerable defined data properties only`);
    }
  }
  try {
    return clone(value);
  } catch {
    throw new DacsError(`${label} must be structured-cloneable data`);
  }
}

function validReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_RE.test(value);
}

function captureLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!safeUint(value) || value === 0) {
    throw new DacsError("payment-evidence handshake limit must be positive");
  }
  return value;
}

function captureCursor(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!nonEmpty(value)) throw new DacsError("payment-evidence cursor is malformed");
  return value;
}

function captureDuration(value: unknown, fallback: number, label: string): number {
  const duration = value ?? fallback;
  if (!safeUint(duration) || duration === 0) throw new DacsError(`${label} must be positive`);
  return duration;
}

function requestPayload(request: Readonly<PaymentEvidenceAnchorRequest>) {
  return {
    requestVersion: request.requestVersion,
    jobId: request.jobId,
    effectId: request.effectId,
    seller: request.seller,
    buyer: request.buyer,
    protocolHash: request.protocolHash,
    protocol: request.protocol,
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
    seller: completion.seller,
    buyer: completion.buyer,
    protocolHash: completion.protocolHash,
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

function requestScopeHash(request: Readonly<PaymentEvidenceAnchorRequest>): string {
  return paymentEvidenceHandshakeScopeHash({
    seller: request.seller,
    buyer: request.buyer,
    protocolHash: request.protocolHash,
  });
}

function completionScopeHash(completion: Readonly<PaymentEvidenceAnchorCompletion>): string {
  return paymentEvidenceHandshakeScopeHash({
    seller: completion.seller,
    buyer: completion.buyer,
    protocolHash: completion.protocolHash,
  });
}

function requestMatchesScope(
  request: Readonly<PaymentEvidenceAnchorRequest>,
  scope: Readonly<PaymentEvidenceHandshakeScope>,
): boolean {
  return sameCanonicalClaimIdentity(request.seller, scope.seller) &&
    sameCanonicalClaimIdentity(request.buyer, scope.buyer) &&
    request.protocolHash === scope.protocolHash;
}

function x402ChainId(protocol: Readonly<FixedPriceX402ProtocolBinding>): number {
  return Number(protocol.rail.network.slice("eip155:".length));
}

function supportedX402Evidence(
  value: SettlementEvidence,
  protocol: Readonly<FixedPriceX402ProtocolBinding>,
): boolean {
  if (value.phase !== "pay-x402" ||
      !sameCanonicalClaimIdentity(value.signature.signer, protocol.orchestrator)) return false;
  const refs = value.paymentTxRefs ?? [];
  if (value.outcome === "success") {
    return refs.length === 1 && refs[0]?.kind === "x402-event" &&
      refs[0].chainId === x402ChainId(protocol) && refs[0].protocolVersion === "2" &&
      "paymentAmount" in value && "settlementFinality" in value;
  }
  return refs.every((ref) => ref.kind === "x402-event" &&
    ref.chainId === x402ChainId(protocol) && ref.protocolVersion === "2");
}

function exactPaymentEvidenceAddress(
  logicalAddress: string,
  jobId: string,
  railId: string,
): boolean {
  const prefix = `dacs4:payment:${jobId}:${encodeAddressSegment(railId)}:`;
  if (!logicalAddress.startsWith(prefix)) return false;
  const suffix = logicalAddress.slice(prefix.length);
  return /^(0|[1-9][0-9]*)$/.test(suffix);
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
    "protocolHash",
    "protocol",
    "logicalAddress",
    "evidenceHash",
    "evidence",
    "expectedWriter",
  ]) || value.requestVersion !== "2" || !nonEmpty(value.messageId) ||
      typeof value.requestHash !== "string" || !HASH_RE.test(value.requestHash) ||
      !nonEmpty(value.jobId) || !nonEmpty(value.effectId) ||
      !isCanonicalClaimReference(value.seller) ||
      !isCanonicalClaimReference(value.buyer) ||
      sameCanonicalClaimIdentity(value.seller, value.buyer) ||
      typeof value.protocolHash !== "string" || !HASH_RE.test(value.protocolHash) ||
      !nonEmpty(value.logicalAddress) || typeof value.evidenceHash !== "string" ||
      !HASH_RE.test(value.evidenceHash) || !isSettlementEvidence(value.evidence) ||
      value.evidence.jobId !== value.jobId ||
      contentHash(value.evidence as unknown as Record<string, unknown>) !== value.evidenceHash ||
      !plainRecord(value.expectedWriter) || !exactKeys(
        value.expectedWriter,
        ["role", "primaryClaim"],
      ) || value.expectedWriter.role !== "buyer" ||
      !isCanonicalClaimReference(value.expectedWriter.primaryClaim) ||
      !sameCanonicalClaimIdentity(value.expectedWriter.primaryClaim, value.buyer)) return false;
  let protocol: FixedPriceX402ProtocolBinding;
  try {
    protocol = captureFixedPriceX402ProtocolBinding(value.protocol);
  } catch {
    return false;
  }
  if (!sameCanonicalClaimIdentity(protocol.orchestrator, value.seller) ||
      fixedPriceX402ProtocolBindingHash(protocol) !== value.protocolHash ||
      !supportedX402Evidence(value.evidence, protocol) ||
      !exactPaymentEvidenceAddress(value.logicalAddress, value.jobId, protocol.rail.railId)) {
    return false;
  }
  const request = value as unknown as PaymentEvidenceAnchorRequest;
  const expectedHash = paymentEvidenceAnchorRequestHash(request);
  return request.requestHash === expectedHash &&
    request.messageId === `${TRACK_MESSAGE_PREFIX}${expectedHash}`;
}

export function createPaymentEvidenceAnchorRequest(input: Readonly<{
  seller: string;
  buyer: string;
  protocol: Readonly<FixedPriceX402ProtocolBinding>;
  effectId: string;
  logicalAddress: string;
  evidenceHash: string;
  evidence: Readonly<SettlementEvidence>;
  expectedWriter: Readonly<SellerSessionSettlementAnchorWriter>;
}>): PaymentEvidenceAnchorRequest {
  const captured = ownClone(input, "payment-evidence anchor request input");
  let protocol: FixedPriceX402ProtocolBinding;
  try {
    protocol = captureFixedPriceX402ProtocolBinding(captured.protocol);
  } catch {
    throw new DacsError("payment-evidence anchor request protocol is unsupported");
  }
  if (!isCanonicalClaimReference(captured.seller) ||
      !isCanonicalClaimReference(captured.buyer) ||
      sameCanonicalClaimIdentity(captured.seller, captured.buyer) ||
      !sameCanonicalClaimIdentity(protocol.orchestrator, captured.seller) ||
      !nonEmpty(captured.effectId) || !nonEmpty(captured.logicalAddress) ||
      typeof captured.evidenceHash !== "string" || !HASH_RE.test(captured.evidenceHash) ||
      !isSettlementEvidence(captured.evidence) ||
      !supportedX402Evidence(captured.evidence, protocol) ||
      !plainRecord(captured.expectedWriter) || !exactKeys(
        captured.expectedWriter,
        ["role", "primaryClaim"],
      ) ||
      captured.expectedWriter.role !== "buyer" ||
      !isCanonicalClaimReference(captured.expectedWriter.primaryClaim) ||
      !sameCanonicalClaimIdentity(captured.expectedWriter.primaryClaim, captured.buyer)) {
    throw new DacsError("payment-evidence anchor request input is malformed");
  }
  const payload = {
    requestVersion: "2" as const,
    jobId: captured.evidence.jobId,
    effectId: captured.effectId,
    seller: captured.seller,
    buyer: captured.buyer,
    protocolHash: fixedPriceX402ProtocolBindingHash(protocol),
    protocol,
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
    "seller",
    "buyer",
    "protocolHash",
    "evidenceHash",
    "evidenceRef",
    "anchorReceipt",
  ]) || value.completionVersion !== "3" || !nonEmpty(value.messageId) ||
      typeof value.completionHash !== "string" || !HASH_RE.test(value.completionHash) ||
      !nonEmpty(value.requestMessageId) || typeof value.requestHash !== "string" ||
      !HASH_RE.test(value.requestHash) || !nonEmpty(value.jobId) ||
      !nonEmpty(value.effectId) || !isCanonicalClaimReference(value.seller) ||
      !isCanonicalClaimReference(value.buyer) ||
      sameCanonicalClaimIdentity(value.seller, value.buyer) ||
      typeof value.protocolHash !== "string" || !HASH_RE.test(value.protocolHash) ||
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
    completion.seller === request.seller &&
    completion.buyer === request.buyer &&
    completion.protocolHash === request.protocolHash &&
    completion.evidenceHash === request.evidenceHash &&
    completion.evidenceRef.anchor.kind === "storage-program" &&
    completion.evidenceRef.anchor.locator === request.logicalAddress &&
    completion.evidenceRef.contentHash === request.evidenceHash &&
    (completion.evidenceRef.signer === undefined ||
      sameCanonicalClaimIdentity(
        completion.evidenceRef.signer,
        request.protocol.orchestrator,
      )) &&
    completion.anchorReceipt.logicalAddress === request.logicalAddress &&
    completion.anchorReceipt.contentHash === request.evidenceHash &&
    sameCanonicalClaimIdentity(completion.anchorReceipt.writer, request.buyer) &&
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
    completionVersion: "3" as const,
    requestMessageId: captured.request.messageId,
    requestHash: captured.request.requestHash,
    jobId: captured.request.jobId,
    effectId: captured.request.effectId,
    seller: captured.request.seller,
    buyer: captured.request.buyer,
    protocolHash: captured.request.protocolHash,
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

function validPeer(value: unknown): value is PaymentEvidenceAuthenticatedPeer {
  return plainRecord(value) && exactKeys(value, [
    "principal",
    "audience",
    "messageId",
    "messageHash",
    "authenticationHash",
  ]) && isCanonicalClaimReference(value.principal) &&
    isCanonicalClaimReference(value.audience) &&
    nonEmpty(value.messageId) && typeof value.messageHash === "string" &&
    HASH_RE.test(value.messageHash) && typeof value.authenticationHash === "string" &&
    HASH_RE.test(value.authenticationHash);
}

function validBuyerWork(value: unknown): value is PaymentEvidenceBuyerWork {
  if (!plainRecord(value) || !exactKeys(value, [
    "state",
    "generation",
    "attempts",
    "updatedAt",
  ], ["retryAt", "reasonCode", "absenceProofHash", "lease"]) ||
      !["pending", "reconciliation-required", "operator-action", "complete"].includes(
        value.state as string,
      ) || !safeUint(value.generation) || value.generation !== value.attempts ||
      !safeUint(value.updatedAt) ||
      (value.retryAt !== undefined && !safeUint(value.retryAt)) ||
      (value.reasonCode !== undefined && !validReasonCode(value.reasonCode)) ||
      (value.absenceProofHash !== undefined &&
        (typeof value.absenceProofHash !== "string" || !HASH_RE.test(value.absenceProofHash))) ||
      (value.lease !== undefined && !validLease(value.lease))) return false;
  if (value.lease !== undefined && value.lease.generation !== value.generation) return false;
  if (value.state === "pending") {
    return value.retryAt === undefined && value.reasonCode === undefined;
  }
  if (value.state === "reconciliation-required") {
    return value.reasonCode !== undefined;
  }
  if (value.state === "operator-action") {
    return value.lease === undefined && value.reasonCode !== undefined;
  }
  return value.lease === undefined && value.retryAt === undefined &&
    value.reasonCode === undefined;
}

function validOutbox(value: unknown): value is PaymentEvidenceOutbox {
  if (!plainRecord(value) || !exactKeys(value, [
    "state",
    "generation",
    "attempts",
    "updatedAt",
  ], ["retryAt", "reasonCode", "lease"]) ||
      !["pending", "sending", "acknowledged", "operator-action"].includes(
        value.state as string,
      ) || !safeUint(value.generation) || value.generation !== value.attempts ||
      !safeUint(value.updatedAt) ||
      (value.retryAt !== undefined && !safeUint(value.retryAt)) ||
      (value.reasonCode !== undefined && !validReasonCode(value.reasonCode)) ||
      (value.lease !== undefined && !validLease(value.lease))) return false;
  if (value.state === "sending") {
    return value.lease !== undefined && value.lease.generation === value.generation &&
      value.retryAt === undefined && value.reasonCode === undefined;
  }
  if (value.lease !== undefined) return false;
  if (value.state === "pending") return value.reasonCode === undefined || value.generation > 0;
  if (value.state === "operator-action") return value.reasonCode !== undefined;
  return value.retryAt === undefined && value.reasonCode === undefined;
}

export function paymentEvidenceHandshakeViolation(value: unknown): string | null {
  if (!plainRecord(value) || !exactKeys(value, [
    "storeVersion",
    "revision",
    "role",
    "messageId",
    "request",
    "createdAt",
    "updatedAt",
  ], [
    "requestAuthentication",
    "requestOutbox",
    "buyerWork",
    "completion",
    "completionAuthentication",
    "completionOutbox",
  ])) return "payment-evidence handshake record fields are malformed";
  if (value.storeVersion !== PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION) {
    return "payment-evidence handshake store version is unsupported";
  }
  if (!safeUint(value.revision) || value.revision === 0 ||
      (value.role !== "seller" && value.role !== "buyer") ||
      !nonEmpty(value.messageId) || !isPaymentEvidenceAnchorRequest(value.request) ||
      value.messageId !== value.request.messageId || !safeUint(value.createdAt) ||
      !safeUint(value.updatedAt) || value.updatedAt < value.createdAt ||
      (value.requestAuthentication !== undefined && !validPeer(value.requestAuthentication)) ||
      (value.requestOutbox !== undefined && !validOutbox(value.requestOutbox)) ||
      (value.buyerWork !== undefined && !validBuyerWork(value.buyerWork)) ||
      (value.completion !== undefined &&
        (!isPaymentEvidenceAnchorCompletion(value.completion) ||
          !completionMatchesRequest(value.request, value.completion))) ||
      (value.completionAuthentication !== undefined &&
        !validPeer(value.completionAuthentication)) ||
      (value.completionOutbox !== undefined && !validOutbox(value.completionOutbox))) {
    return "payment-evidence handshake record is malformed";
  }
  const request = value.request;
  if (value.role === "buyer") {
    if (!value.requestAuthentication || !value.buyerWork || value.requestOutbox ||
        value.completionAuthentication) {
      return "buyer handshake record has invalid role-local state";
    }
    if (!sameCanonicalClaimIdentity(value.requestAuthentication.principal, request.seller) ||
        !sameCanonicalClaimIdentity(value.requestAuthentication.audience, request.buyer) ||
        value.requestAuthentication.messageId !== request.messageId ||
        value.requestAuthentication.messageHash !== request.requestHash) {
      return "buyer handshake request authentication is not actor/message bound";
    }
    if ((value.completion === undefined) !== (value.buyerWork.state !== "complete") ||
        (value.completion === undefined) !== (value.completionOutbox === undefined)) {
      return "buyer handshake completion state is inconsistent";
    }
  } else {
    if (value.requestAuthentication || value.buyerWork || value.completionOutbox ||
        !value.requestOutbox) {
      return "seller handshake record has invalid role-local state";
    }
    if ((value.completion === undefined) !== (value.completionAuthentication === undefined)) {
      return "seller handshake completion authentication is inconsistent";
    }
    if (value.completionAuthentication &&
        (!sameCanonicalClaimIdentity(value.completionAuthentication.principal, request.buyer) ||
          !sameCanonicalClaimIdentity(value.completionAuthentication.audience, request.seller) ||
          value.completionAuthentication.messageId !== value.completion!.messageId ||
          value.completionAuthentication.messageHash !== value.completion!.completionHash)) {
      return "seller handshake completion authentication is not actor/message bound";
    }
  }
  const timed = [value.requestOutbox, value.buyerWork, value.completionOutbox].filter(
    (entry): entry is PaymentEvidenceOutbox | PaymentEvidenceBuyerWork => entry !== undefined,
  );
  const createdAt = value.createdAt as number;
  const updatedAt = value.updatedAt as number;
  if (timed.some((entry) => entry.updatedAt < createdAt ||
      entry.updatedAt > updatedAt)) {
    return "payment-evidence handshake substate time is inconsistent";
  }
  return null;
}

function requireHandshakeRecord(
  value: unknown,
  role: PaymentEvidenceHandshakeRole,
  messageId?: string,
  expectedScopeHash?: string,
): PaymentEvidenceHandshakeRecord {
  const violation = paymentEvidenceHandshakeViolation(value);
  if (violation) throw new DacsError(violation);
  const record = clone(value as PaymentEvidenceHandshakeRecord);
  if (record.role !== role ||
      (messageId !== undefined && record.messageId !== messageId) ||
      (expectedScopeHash !== undefined && requestScopeHash(record.request) !== expectedScopeHash)) {
    throw new DacsError(
      "payment-evidence store returned a different actor/pair/protocol/message binding",
    );
  }
  return record;
}

const recordKey = (role: PaymentEvidenceHandshakeRole, messageId: string): string =>
  `${role}:${messageId}`;

function currentLease(
  retained: Readonly<PaymentEvidenceHandshakeLease> | undefined,
  supplied: Readonly<PaymentEvidenceHandshakeLease>,
): boolean {
  return retained !== undefined && retained.owner === supplied.owner &&
    retained.generation === supplied.generation && retained.expiresAt === supplied.expiresAt;
}

/**
 * Process-local reference implementation of the atomic store contract. A
 * production adapter must enforce the same reservations, revisions, leases,
 * and outbox transitions in one durable database authority.
 */
export function createInMemoryPaymentEvidenceHandshakeStore(
  options: Readonly<{ now?: () => number }> = {},
): PaymentEvidenceHandshakeStore {
  if (!plainRecord(options) || !exactKeys(options, [], ["now"]) ||
      (options.now !== undefined && typeof options.now !== "function")) {
    throw new DacsError("in-memory payment-evidence store options are malformed");
  }
  const clock = options.now ?? Date.now;
  const records = new Map<string, PaymentEvidenceHandshakeRecord>();
  const effectReservations = new Map<string, string>();
  const addressReservations = new Map<string, string>();

  const readTime = (): number => {
    const value = Reflect.apply(clock, INERT_RECEIVER, []);
    if (!safeUint(value)) throw new DacsError("payment-evidence store clock is invalid");
    return value;
  };
  const stamp = (record: Readonly<PaymentEvidenceHandshakeRecord>, value = readTime()): number =>
    Math.max(record.updatedAt, value);
  const save = (
    current: Readonly<PaymentEvidenceHandshakeRecord>,
    next: PaymentEvidenceHandshakeRecord,
  ): PaymentEvidenceHandshakeRecord => {
    next.revision = current.revision + 1;
    const violation = paymentEvidenceHandshakeViolation(next);
    if (violation) throw new DacsError(violation);
    records.set(recordKey(next.role, next.messageId), clone(next));
    return clone(next);
  };
  const loadRecord = (
    role: PaymentEvidenceHandshakeRole,
    messageId: string,
    scopeHash: string,
  ): PaymentEvidenceHandshakeLoad => {
    const found = records.get(recordKey(role, messageId));
    if (!found || requestScopeHash(found.request) !== scopeHash) {
      return { status: "missing" };
    }
    const violation = paymentEvidenceHandshakeViolation(found);
    return violation
      ? { status: "corrupt", reason: violation }
      : { status: "ok", record: clone(found) };
  };
  const reservation = (
    role: PaymentEvidenceHandshakeRole,
    scopeHash: string,
    identity: string,
  ): string => `${role}:${scopeHash}:${identity}`;

  const claimOutbox = (
    role: PaymentEvidenceHandshakeRole,
    field: "requestOutbox" | "completionOutbox",
    scopeHash: string,
    owner: string,
    cursor: string | undefined,
    limit: number,
    leaseDurationMs: number,
  ): PaymentEvidencePage<PaymentEvidenceOutboundRequestClaim | PaymentEvidenceOutboundCompletionClaim> => {
    if (typeof scopeHash !== "string" || !HASH_RE.test(scopeHash) ||
        !nonEmpty(owner) || (cursor !== undefined && !nonEmpty(cursor)) ||
        !safeUint(limit) || limit === 0 || !safeUint(leaseDurationMs) ||
        leaseDurationMs === 0) {
      throw new DacsError("payment-evidence outbox claim is malformed");
    }
    const now = readTime();
    const eligible = [...records.values()]
      .filter((record) => {
        if (record.role !== role || requestScopeHash(record.request) !== scopeHash ||
            (cursor !== undefined && record.messageId <= cursor)) {
          return false;
        }
        const outbox = record[field];
        if (!outbox) return false;
        if (role === "seller" && record.completion) return false;
        return (outbox.state === "pending" &&
            (outbox.retryAt === undefined || outbox.retryAt <= now)) ||
          (outbox.state === "sending" && outbox.lease!.expiresAt <= now);
      })
      .sort((left, right) => left.messageId.localeCompare(right.messageId));
    const selected = eligible.slice(0, limit);
    const items = selected.map((current) => {
      const outbox = current[field]!;
      const expiresAt = now + leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new DacsError("payment-evidence outbox lease expiry overflows");
      }
      const lease: PaymentEvidenceHandshakeLease = {
        owner,
        generation: outbox.generation + 1,
        expiresAt,
      };
      const nextOutbox: PaymentEvidenceOutbox = {
        state: "sending",
        generation: lease.generation,
        attempts: outbox.attempts + 1,
        updatedAt: stamp(current, now),
        lease,
      };
      const next = {
        ...clone(current),
        [field]: nextOutbox,
        updatedAt: stamp(current, now),
      } as PaymentEvidenceHandshakeRecord;
      save(current, next);
      return field === "requestOutbox"
        ? { request: clone(current.request), lease: clone(lease) }
        : { completion: clone(current.completion!), lease: clone(lease) };
    });
    return {
      items,
      ...(eligible.length > selected.length && selected.length > 0
        ? { nextCursor: selected.at(-1)!.messageId }
        : {}),
    };
  };

  const writeOutbox = (
    role: PaymentEvidenceHandshakeRole,
    field: "requestOutbox" | "completionOutbox",
    scopeHash: string,
    messageId: string,
    messageHash: string,
    lease: Readonly<PaymentEvidenceHandshakeLease>,
    result: Readonly<
      | { state: "acknowledged" }
      | { state: "pending"; reasonCode: string; retryAt?: number }
    >,
  ): PaymentEvidenceHandshakeWrite => {
    const loaded = loadRecord(role, messageId, scopeHash);
    if (loaded.status !== "ok") return loaded;
    const current = records.get(recordKey(role, messageId))!;
    const expectedHash = field === "requestOutbox"
      ? current.request.requestHash
      : current.completion?.completionHash;
    if (expectedHash !== messageHash) return { status: "stale" };
    const outbox = current[field];
    if (!outbox) return { status: "conflict" };
    if (outbox.state === "acknowledged" && result.state === "acknowledged") {
      return { status: "existing", record: clone(current) };
    }
    if (outbox.state !== "sending" || !currentLease(outbox.lease, lease)) {
      return { status: "stale" };
    }
    if (result.state === "pending" && (!validReasonCode(result.reasonCode) ||
        (result.retryAt !== undefined && !safeUint(result.retryAt)))) {
      return { status: "corrupt", reason: "payment-evidence outbox release is malformed" };
    }
    const updatedAt = stamp(current);
    const nextOutbox: PaymentEvidenceOutbox = result.state === "acknowledged"
      ? {
          state: "acknowledged",
          generation: outbox.generation,
          attempts: outbox.attempts,
          updatedAt,
        }
      : {
          state: "pending",
          generation: outbox.generation,
          attempts: outbox.attempts,
          updatedAt,
          ...(result.retryAt === undefined ? {} : { retryAt: result.retryAt }),
          reasonCode: result.reasonCode,
        };
    const next = {
      ...clone(current),
      [field]: nextOutbox,
      updatedAt,
    } as PaymentEvidenceHandshakeRecord;
    return { status: "recorded", record: save(current, next) };
  };

  return {
    async readTime() {
      return readTime();
    },

    async putRequest(input) {
      if ((input.role !== "seller" && input.role !== "buyer") ||
          typeof input.scopeHash !== "string" || !HASH_RE.test(input.scopeHash) ||
          !isPaymentEvidenceAnchorRequest(input.request) ||
          requestScopeHash(input.request) !== input.scopeHash ||
          (input.role === "buyer" && !validPeer(input.requestAuthentication)) ||
          (input.role === "seller" && input.requestAuthentication !== undefined)) {
        return { status: "corrupt", reason: "payment-evidence request put is malformed" };
      }
      const key = recordKey(input.role, input.request.messageId);
      const effectKey = reservation(input.role, input.scopeHash, input.request.effectId);
      const addressKey = reservation(input.role, input.scopeHash, input.request.logicalAddress);
      const reservedEffect = effectReservations.get(effectKey);
      const reservedAddress = addressReservations.get(addressKey);
      if ((reservedEffect !== undefined && reservedEffect !== input.request.messageId) ||
          (reservedAddress !== undefined && reservedAddress !== input.request.messageId)) {
        return { status: "conflict" };
      }
      const existing = records.get(key);
      if (existing) {
        const violation = paymentEvidenceHandshakeViolation(existing);
        if (violation) return { status: "corrupt", reason: violation };
        const same = canonicalize(existing.request) === canonicalize(input.request) &&
          canonicalize(existing.requestAuthentication ?? null) ===
            canonicalize(input.requestAuthentication ?? null);
        return same
          ? { status: "existing", record: clone(existing) }
          : { status: "conflict" };
      }
      const now = readTime();
      const record: PaymentEvidenceHandshakeRecord = {
        storeVersion: PAYMENT_EVIDENCE_HANDSHAKE_STORE_VERSION,
        revision: 1,
        role: input.role,
        messageId: input.request.messageId,
        request: clone(input.request),
        ...(input.role === "buyer"
          ? {
              requestAuthentication: clone(input.requestAuthentication!),
              buyerWork: {
                state: "pending" as const,
                generation: 0,
                attempts: 0,
                updatedAt: now,
              },
            }
          : {
              requestOutbox: {
                state: "pending" as const,
                generation: 0,
                attempts: 0,
                updatedAt: now,
              },
            }),
        createdAt: now,
        updatedAt: now,
      };
      const violation = paymentEvidenceHandshakeViolation(record);
      if (violation) return { status: "corrupt", reason: violation };
      records.set(key, clone(record));
      effectReservations.set(effectKey, input.request.messageId);
      addressReservations.set(addressKey, input.request.messageId);
      return { status: "created", record: clone(record) };
    },

    async load(role, messageId, scopeHash) {
      return loadRecord(role, messageId, scopeHash);
    },

    async listBuyerRunnable(input) {
      if (!safeUint(input.limit) || input.limit === 0 ||
          typeof input.scopeHash !== "string" || !HASH_RE.test(input.scopeHash) ||
          (input.cursor !== undefined && !nonEmpty(input.cursor))) {
        throw new DacsError("payment-evidence runnable query is malformed");
      }
      const now = readTime();
      const eligible = [...records.values()]
        .filter((record) => {
          if (record.role !== "buyer" || requestScopeHash(record.request) !== input.scopeHash ||
              record.completion ||
              (input.cursor !== undefined && record.messageId <= input.cursor)) return false;
          const work = record.buyerWork!;
          return (work.state === "pending" || work.state === "reconciliation-required") &&
            (work.retryAt === undefined || work.retryAt <= now) &&
            (work.lease === undefined || work.lease.expiresAt <= now);
        })
        .sort((left, right) => left.messageId.localeCompare(right.messageId));
      const selected = eligible.slice(0, input.limit);
      return {
        items: selected.map(clone),
        ...(eligible.length > selected.length && selected.length > 0
          ? { nextCursor: selected.at(-1)!.messageId }
          : {}),
      };
    },

    async claimBuyer(input) {
      const loaded = loadRecord("buyer", input.messageId, input.scopeHash);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(recordKey("buyer", input.messageId))!;
      if (current.request.requestHash !== input.requestHash) return { status: "stale" };
      if (current.completion) return { status: "complete", record: clone(current) };
      if (!nonEmpty(input.owner) || !safeUint(input.leaseDurationMs) ||
          input.leaseDurationMs === 0) {
        return { status: "corrupt", reason: "buyer handshake claim is malformed" };
      }
      const work = current.buyerWork!;
      if (work.state === "operator-action") {
        return { status: "not-runnable", record: clone(current) };
      }
      const now = readTime();
      if (work.retryAt !== undefined && work.retryAt > now) {
        return { status: "not-runnable", record: clone(current) };
      }
      if (work.lease && work.lease.expiresAt > now) {
        return { status: "waiting", record: clone(current), lease: clone(work.lease) };
      }
      const expiresAt = now + input.leaseDurationMs;
      if (!Number.isSafeInteger(expiresAt)) {
        return { status: "corrupt", reason: "buyer handshake lease expiry overflows" };
      }
      const lease: PaymentEvidenceHandshakeLease = {
        owner: input.owner,
        generation: work.generation + 1,
        expiresAt,
      };
      const nextWork: PaymentEvidenceBuyerWork = {
        // The claim is the write-ahead intent for the irreversible callback.
        // A lost worker therefore leaves an expired reconciliation claim, not
        // a pending record that another worker could anchor again directly.
        state: "reconciliation-required",
        generation: lease.generation,
        attempts: work.attempts + 1,
        updatedAt: stamp(current, now),
        ...(work.state === "reconciliation-required"
          ? { reasonCode: work.reasonCode! }
          : { reasonCode: "anchor-attempt-in-flight" }),
        ...(work.absenceProofHash ? { absenceProofHash: work.absenceProofHash } : {}),
        lease,
      };
      const next: PaymentEvidenceHandshakeRecord = {
        ...clone(current),
        buyerWork: nextWork,
        updatedAt: stamp(current, now),
      };
      const saved = save(current, next);
      return {
        status: "acquired",
        mode: work.state === "reconciliation-required" ? "reconcile" : "anchor",
        record: saved,
        lease: clone(lease),
      };
    },

    async isCurrentBuyer(input) {
      const loaded = loadRecord("buyer", input.messageId, input.scopeHash);
      if (loaded.status !== "ok" || loaded.record.request.requestHash !== input.requestHash ||
          loaded.record.completion || !loaded.record.buyerWork?.lease) return false;
      const now = readTime();
      return currentLease(loaded.record.buyerWork.lease, input.lease) &&
        loaded.record.buyerWork.lease.expiresAt > now;
    },

    async recordBuyerAttempt(input) {
      const loaded = loadRecord("buyer", input.messageId, input.scopeHash);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(recordKey("buyer", input.messageId))!;
      if (current.request.requestHash !== input.requestHash || current.completion ||
          !validReasonCode(input.reasonCode) ||
          (input.retryAt !== undefined && !safeUint(input.retryAt)) ||
          (input.state === "operator-action" && input.retryAt !== undefined)) {
        return { status: "conflict" };
      }
      const now = readTime();
      const work = current.buyerWork!;
      if (!currentLease(work.lease, input.lease) || input.lease.expiresAt <= now) {
        return { status: "stale" };
      }
      const updatedAt = stamp(current, now);
      const nextWork: PaymentEvidenceBuyerWork = {
        state: input.state,
        generation: work.generation,
        attempts: work.attempts,
        updatedAt,
        reasonCode: input.reasonCode,
        ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
        ...(work.absenceProofHash ? { absenceProofHash: work.absenceProofHash } : {}),
      };
      const next = { ...clone(current), buyerWork: nextWork, updatedAt };
      return { status: "recorded", record: save(current, next) };
    },

    async recordBuyerAbsence(input) {
      const loaded = loadRecord("buyer", input.messageId, input.scopeHash);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(recordKey("buyer", input.messageId))!;
      const work = current.buyerWork!;
      const now = readTime();
      if (current.request.requestHash !== input.requestHash || current.completion ||
          typeof input.absenceProofHash !== "string" || !HASH_RE.test(input.absenceProofHash) ||
          work.state !== "reconciliation-required" ||
          !currentLease(work.lease, input.lease) || input.lease.expiresAt <= now) {
        return { status: "stale" };
      }
      const updatedAt = stamp(current, now);
      const nextWork: PaymentEvidenceBuyerWork = {
        state: "pending",
        generation: work.generation,
        attempts: work.attempts,
        updatedAt,
        absenceProofHash: input.absenceProofHash,
      };
      const next = { ...clone(current), buyerWork: nextWork, updatedAt };
      return { status: "recorded", record: save(current, next) };
    },

    async recordBuyerCompletion(input) {
      const loaded = loadRecord("buyer", input.messageId, input.scopeHash);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(recordKey("buyer", input.messageId))!;
      if (current.request.requestHash !== input.requestHash) return { status: "stale" };
      if (current.completion) {
        return canonicalize(current.completion) === canonicalize(input.completion)
          ? { status: "existing", record: clone(current) }
          : { status: "conflict" };
      }
      const now = readTime();
      const work = current.buyerWork!;
      if (!currentLease(work.lease, input.lease) || input.lease.expiresAt <= now ||
          !isPaymentEvidenceAnchorCompletion(input.completion) ||
          !completionMatchesRequest(current.request, input.completion)) {
        return { status: "stale" };
      }
      const updatedAt = stamp(current, now);
      const next: PaymentEvidenceHandshakeRecord = {
        ...clone(current),
        buyerWork: {
          state: "complete",
          generation: work.generation,
          attempts: work.attempts,
          updatedAt,
          ...(work.absenceProofHash ? { absenceProofHash: work.absenceProofHash } : {}),
        },
        completion: clone(input.completion),
        completionOutbox: {
          state: "pending",
          generation: 0,
          attempts: 0,
          updatedAt,
        },
        updatedAt,
      };
      return { status: "recorded", record: save(current, next) };
    },

    async requeueBuyer(input) {
      const loaded = loadRecord("buyer", input.messageId, input.scopeHash);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(recordKey("buyer", input.messageId))!;
      if (current.request.requestHash !== input.requestHash || current.completion ||
          !validReasonCode(input.operatorReasonCode)) return { status: "conflict" };
      const work = current.buyerWork!;
      if (work.lease) return { status: "stale" };
      const updatedAt = stamp(current);
      const next: PaymentEvidenceHandshakeRecord = {
        ...clone(current),
        buyerWork: {
          state: "reconciliation-required",
          generation: work.generation,
          attempts: work.attempts,
          updatedAt,
          reasonCode: input.operatorReasonCode,
          ...(work.absenceProofHash ? { absenceProofHash: work.absenceProofHash } : {}),
        },
        updatedAt,
      };
      return { status: "recorded", record: save(current, next) };
    },

    async recordSellerCompletion(input) {
      const loaded = loadRecord("seller", input.messageId, input.scopeHash);
      if (loaded.status !== "ok") return loaded;
      const current = records.get(recordKey("seller", input.messageId))!;
      if (current.request.requestHash !== input.requestHash ||
          !isPaymentEvidenceAnchorCompletion(input.completion) ||
          !completionMatchesRequest(current.request, input.completion) ||
          !validPeer(input.completionAuthentication) ||
          !sameCanonicalClaimIdentity(
            input.completionAuthentication.principal,
            current.request.buyer,
          ) ||
          !sameCanonicalClaimIdentity(
            input.completionAuthentication.audience,
            current.request.seller,
          ) ||
          input.completionAuthentication.messageId !== input.completion.messageId ||
          input.completionAuthentication.messageHash !== input.completion.completionHash) {
        return { status: "conflict" };
      }
      if (current.completion) {
        const same = canonicalize(current.completion) === canonicalize(input.completion) &&
          canonicalize(current.completionAuthentication) ===
            canonicalize(input.completionAuthentication);
        return same
          ? { status: "existing", record: clone(current) }
          : { status: "conflict" };
      }
      const updatedAt = stamp(current);
      const next: PaymentEvidenceHandshakeRecord = {
        ...clone(current),
        requestOutbox: {
          state: "acknowledged",
          generation: current.requestOutbox!.generation,
          attempts: current.requestOutbox!.attempts,
          updatedAt,
        },
        completion: clone(input.completion),
        completionAuthentication: clone(input.completionAuthentication),
        updatedAt,
      };
      return { status: "recorded", record: save(current, next) };
    },

    async claimSellerRequests(input) {
      return claimOutbox(
        "seller",
        "requestOutbox",
        input.scopeHash,
        input.owner,
        input.cursor,
        input.limit,
        input.leaseDurationMs,
      ) as PaymentEvidencePage<PaymentEvidenceOutboundRequestClaim>;
    },

    async acknowledgeSellerRequest(input) {
      return writeOutbox(
        "seller",
        "requestOutbox",
        input.scopeHash,
        input.messageId,
        input.requestHash,
        input.lease,
        { state: "acknowledged" },
      );
    },

    async releaseSellerRequest(input) {
      return writeOutbox(
        "seller",
        "requestOutbox",
        input.scopeHash,
        input.messageId,
        input.requestHash,
        input.lease,
        {
          state: "pending",
          reasonCode: input.reasonCode,
          ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
        },
      );
    },

    async claimBuyerCompletions(input) {
      return claimOutbox(
        "buyer",
        "completionOutbox",
        input.scopeHash,
        input.owner,
        input.cursor,
        input.limit,
        input.leaseDurationMs,
      ) as PaymentEvidencePage<PaymentEvidenceOutboundCompletionClaim>;
    },

    async acknowledgeBuyerCompletion(input) {
      return writeOutbox(
        "buyer",
        "completionOutbox",
        input.scopeHash,
        input.messageId,
        input.completionHash,
        input.lease,
        { state: "acknowledged" },
      );
    },

    async releaseBuyerCompletion(input) {
      return writeOutbox(
        "buyer",
        "completionOutbox",
        input.scopeHash,
        input.messageId,
        input.completionHash,
        input.lease,
        {
          state: "pending",
          reasonCode: input.reasonCode,
          ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
        },
      );
    },
  };
}

function captureAuthentication(
  value: unknown,
  expected: Readonly<Omit<PaymentEvidenceAuthenticatedPeer, "authenticationHash">>,
): PaymentEvidenceTransportAuthentication {
  const result = ownClone(value, "payment-evidence transport authentication") as unknown as
    Record<string, unknown>;
  if (result.disposition === "authenticated" &&
      exactKeys(result, ["disposition", "peer"]) && validPeer(result.peer)) {
    const peer = result.peer;
    if (!sameCanonicalClaimIdentity(peer.principal, expected.principal) ||
        !sameCanonicalClaimIdentity(peer.audience, expected.audience) ||
        peer.messageId !== expected.messageId || peer.messageHash !== expected.messageHash) {
      return { disposition: "rejected", reason: "authenticated peer binding mismatch" };
    }
    return { disposition: "authenticated", peer: clone(peer) };
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

function captureReconciliation(value: unknown): PaymentEvidenceAnchorReconciliation {
  const result = ownClone(value, "payment-evidence anchor reconciliation") as unknown as
    Record<string, unknown>;
  if (result.disposition === "anchored" && exactKeys(
    result,
    ["disposition", "evidenceRef", "anchorReceipt"],
  ) && isAttestationRef(result.evidenceRef) && isAnchorReceipt(result.anchorReceipt)) {
    return result as unknown as PaymentEvidenceAnchorReconciliation;
  }
  if (result.disposition === "absent" && exactKeys(
    result,
    ["disposition", "absenceProofHash"],
  ) && typeof result.absenceProofHash === "string" && HASH_RE.test(result.absenceProofHash)) {
    return result as unknown as PaymentEvidenceAnchorReconciliation;
  }
  if (["invalid", "indeterminate", "error"].includes(result.disposition as string) &&
      exactKeys(result, ["disposition", "reason"]) && nonEmpty(result.reason)) {
    return result as unknown as PaymentEvidenceAnchorReconciliation;
  }
  throw new DacsError("payment-evidence anchor reconciliation is malformed");
}

function requireStore(value: unknown): PaymentEvidenceHandshakeStore {
  if (!storeObject(value)) throw new DacsError("payment-evidence handshake store is malformed");
  const store = value as unknown as PaymentEvidenceHandshakeStore;
  for (const method of [
    "readTime",
    "putRequest",
    "load",
    "listBuyerRunnable",
    "claimBuyer",
    "isCurrentBuyer",
    "recordBuyerAttempt",
    "recordBuyerAbsence",
    "recordBuyerCompletion",
    "requeueBuyer",
    "recordSellerCompletion",
    "claimSellerRequests",
    "acknowledgeSellerRequest",
    "releaseSellerRequest",
    "claimBuyerCompletions",
    "acknowledgeBuyerCompletion",
    "releaseBuyerCompletion",
  ] as const) {
    if (typeof store[method] !== "function") {
      throw new DacsError(`payment-evidence handshake store.${method} is required`);
    }
  }
  return store;
}

async function retryAt(
  store: PaymentEvidenceHandshakeStore,
  delayMs: number,
): Promise<number> {
  const now = await store.readTime();
  if (!safeUint(now)) throw new DacsError("payment-evidence store returned invalid time");
  const value = now + delayMs;
  if (!Number.isSafeInteger(value)) throw new DacsError("payment-evidence retry time overflows");
  return value;
}

function requireWrite(
  value: PaymentEvidenceHandshakeWrite,
  label: string,
): "recorded" | "existing" {
  if (value.status === "corrupt") throw new DacsError(value.reason);
  if (value.status === "unsupported") {
    throw new DacsError(`payment-evidence store version ${value.version} is unsupported`);
  }
  if (value.status !== "recorded" && value.status !== "existing") {
    throw new DacsError(`${label} is stale or conflicts with retained state`);
  }
  return value.status;
}

function requireScopedWrite(
  value: PaymentEvidenceHandshakeWrite,
  label: string,
  role: PaymentEvidenceHandshakeRole,
  messageId: string,
  scopeHash: string,
): "recorded" | "existing" {
  const status = requireWrite(value, label);
  const retained = value as Extract<
    PaymentEvidenceHandshakeWrite,
    { status: "recorded" | "existing" }
  >;
  requireHandshakeRecord(retained.record, role, messageId, scopeHash);
  return status;
}

function claimInput(
  input: unknown,
  kind: "request" | "completion",
  expectedScopeHash: string,
): PaymentEvidenceOutboundRequestClaim | PaymentEvidenceOutboundCompletionClaim {
  const value = ownClone(input, `payment-evidence outbound ${kind} claim`) as unknown as
    Record<string, unknown>;
  const messageKey = kind === "request" ? "request" : "completion";
  if (!exactKeys(value, [messageKey, "lease"]) || !validLease(value.lease) ||
      (kind === "request" && !isPaymentEvidenceAnchorRequest(value.request)) ||
      (kind === "completion" && !isPaymentEvidenceAnchorCompletion(value.completion)) ||
      (kind === "request" &&
        requestScopeHash(value.request as PaymentEvidenceAnchorRequest) !== expectedScopeHash) ||
      (kind === "completion" &&
        completionScopeHash(value.completion as PaymentEvidenceAnchorCompletion) !==
          expectedScopeHash)) {
    throw new DacsError(`payment-evidence outbound ${kind} claim is malformed`);
  }
  return value as unknown as
    PaymentEvidenceOutboundRequestClaim | PaymentEvidenceOutboundCompletionClaim;
}

function claimPage(
  input: unknown,
  kind: "request" | "completion",
  cursor: string | undefined,
  limit: number,
  expectedScopeHash: string,
): PaymentEvidencePage<
  PaymentEvidenceOutboundRequestClaim | PaymentEvidenceOutboundCompletionClaim
> {
  const value = ownClone(input, `payment-evidence outbound ${kind} page`) as unknown as
    Record<string, unknown>;
  if (!exactKeys(value, ["items"], ["nextCursor"]) || !Array.isArray(value.items) ||
      value.items.length > limit ||
      (value.nextCursor !== undefined && !nonEmpty(value.nextCursor))) {
    throw new DacsError(`payment-evidence outbound ${kind} page is malformed`);
  }
  const items = value.items.map((item) => claimInput(item, kind, expectedScopeHash));
  const messageIds = items.map((item) => kind === "request"
    ? (item as PaymentEvidenceOutboundRequestClaim).request.messageId
    : (item as PaymentEvidenceOutboundCompletionClaim).completion.requestMessageId);
  let previous = cursor;
  for (const messageId of messageIds) {
    if (previous !== undefined && messageId <= previous) {
      throw new DacsError(`payment-evidence outbound ${kind} page is not cursor ordered`);
    }
    previous = messageId;
  }
  if (value.nextCursor !== undefined &&
      (messageIds.length === 0 || value.nextCursor !== messageIds.at(-1))) {
    throw new DacsError(`payment-evidence outbound ${kind} page has an invalid next cursor`);
  }
  return {
    items,
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
  };
}

export function createBuyerPaymentEvidenceHandshake(
  options: BuyerPaymentEvidenceHandshakeOptions,
): BuyerPaymentEvidenceHandshake {
  if (!plainRecord(options) || !exactKeys(options, [
    "store",
    "seller",
    "buyer",
    "protocol",
    "workerId",
    "authenticateRequest",
    "verifyEvidence",
    "anchorEvidence",
    "reconcileAnchor",
    "verifyAnchorReceipt",
  ], ["leaseDurationMs", "retryDelayMs"]) ||
      !isCanonicalClaimReference(options.seller) ||
      !isCanonicalClaimReference(options.buyer) ||
      sameCanonicalClaimIdentity(options.seller, options.buyer) ||
      !nonEmpty(options.workerId) || typeof options.authenticateRequest !== "function" ||
      typeof options.verifyEvidence !== "function" ||
      typeof options.anchorEvidence !== "function" ||
      typeof options.reconcileAnchor !== "function" ||
      typeof options.verifyAnchorReceipt !== "function") {
    throw new DacsError("buyer payment-evidence handshake options are malformed");
  }
  const store = requireStore(options.store);
  const seller = options.seller;
  const buyer = options.buyer;
  const protocol = captureFixedPriceX402ProtocolBinding(options.protocol);
  if (!sameCanonicalClaimIdentity(protocol.orchestrator, seller)) {
    throw new DacsError("buyer handshake requires the pinned seller-orchestrator topology");
  }
  const scope: PaymentEvidenceHandshakeScope = {
    seller,
    buyer,
    protocolHash: fixedPriceX402ProtocolBindingHash(protocol),
  };
  const scopeHash = paymentEvidenceHandshakeScopeHash(scope);
  const workerId = options.workerId;
  const authenticateRequest = options.authenticateRequest;
  const verifyEvidence = options.verifyEvidence;
  const anchorEvidence = options.anchorEvidence;
  const reconcileAnchor = options.reconcileAnchor;
  const verifyAnchorReceipt = options.verifyAnchorReceipt;
  const leaseDurationMs = captureDuration(
    options.leaseDurationMs,
    DEFAULT_LEASE_DURATION_MS,
    "buyer handshake leaseDurationMs",
  );
  const retryDelayMs = captureDuration(
    options.retryDelayMs,
    DEFAULT_RETRY_DELAY_MS,
    "buyer handshake retryDelayMs",
  );

  const recordAttempt = async (
    request: Readonly<PaymentEvidenceAnchorRequest>,
    lease: Readonly<PaymentEvidenceHandshakeLease>,
    state: "reconciliation-required" | "operator-action",
    reasonCode: string,
  ): Promise<PaymentEvidenceHandshakeRunResult> => {
    const written = clone(await store.recordBuyerAttempt({
      scopeHash,
      messageId: request.messageId,
      requestHash: request.requestHash,
      lease,
      state,
      reasonCode,
      ...(state === "reconciliation-required"
        ? { retryAt: await retryAt(store, retryDelayMs) }
        : {}),
    }));
    if (written.status === "corrupt") throw new DacsError(written.reason);
    if (written.status === "unsupported") {
      throw new DacsError(`payment-evidence store version ${written.version} is unsupported`);
    }
    if (written.status === "recorded" || written.status === "existing") {
      requireHandshakeRecord(written.record, "buyer", request.messageId, scopeHash);
    }
    return {
      messageId: request.messageId,
      status: written.status === "recorded" || written.status === "existing"
        ? state
        : "stale",
      ...(written.status === "recorded" || written.status === "existing"
        ? { reasonCode }
        : {}),
    };
  };

  const handshake: BuyerPaymentEvidenceHandshake = {
    async receiveRequest(input, transportContext) {
      const request = ownClone(input, "payment-evidence anchor request");
      if (!isPaymentEvidenceAnchorRequest(request)) {
        throw new DacsError("payment-evidence anchor request is malformed");
      }
      if (!requestMatchesScope(request, scope) ||
          !sameCanonicalClaimIdentity(request.expectedWriter.primaryClaim, buyer)) {
        throw new DacsError(
          "payment-evidence anchor request targets a different actor pair or protocol",
        );
      }
      const before = canonicalize(request);
      const authentication = captureAuthentication(
        await Reflect.apply(authenticateRequest, INERT_RECEIVER, [
          clone(request),
          transportContext,
        ]),
        {
          principal: request.seller,
          audience: request.buyer,
          messageId: request.messageId,
          messageHash: request.requestHash,
        },
      );
      if (canonicalize(request) !== before) {
        throw new DacsError("request authenticator mutated payment-evidence input");
      }
      if (authentication.disposition !== "authenticated") {
        throw new DacsError(`payment-evidence request ${authentication.disposition}`);
      }
      const verification = captureVerification(await Reflect.apply(
        verifyEvidence,
        INERT_RECEIVER,
        [clone(request)],
      ));
      if (canonicalize(request) !== before) {
        throw new DacsError("evidence verifier mutated payment-evidence input");
      }
      if (verification.disposition !== "valid") {
        throw new DacsError(`payment evidence ${verification.disposition}`);
      }
      const stored = clone(await store.putRequest({
        role: "buyer",
        scopeHash,
        request,
        requestAuthentication: authentication.peer,
      }));
      if (stored.status === "conflict") {
        throw new DacsError(
          "payment-evidence request conflicts with a retained message, effect, or payment slot",
        );
      }
      if (stored.status === "corrupt") throw new DacsError(stored.reason);
      if (stored.status === "unsupported") {
        throw new DacsError(`payment-evidence store version ${stored.version} is unsupported`);
      }
      if (stored.status !== "created" && stored.status !== "existing") {
        throw new DacsError("payment-evidence store returned an unknown request-put result");
      }
      requireHandshakeRecord(stored.record, "buyer", request.messageId, scopeHash);
      return stored.status === "created" ? "accepted" : "existing";
    },

    async runPending(input = {}) {
      if (!plainRecord(input) || !exactKeys(input, [], [
        "cursor", "limit", "messageId", "requestHash", "signal",
      ]) ||
          (input.signal !== undefined && !(input.signal instanceof AbortSignal))) {
        throw new DacsError("buyer handshake run options are malformed");
      }
      const exactRequest = input.messageId !== undefined || input.requestHash !== undefined;
      if (exactRequest && (!nonEmpty(input.messageId) ||
          typeof input.requestHash !== "string" || !HASH_RE.test(input.requestHash) ||
          input.cursor !== undefined || input.limit !== undefined)) {
        throw new DacsError("buyer handshake exact-request options are malformed");
      }
      const cursor = exactRequest ? undefined : captureCursor(input.cursor);
      const limit = exactRequest ? 1 : captureLimit(input.limit);
      let page: PaymentEvidencePage<Readonly<PaymentEvidenceHandshakeRecord>>;
      if (exactRequest) {
        const loaded = clone(await store.load("buyer", input.messageId!, scopeHash));
        if (loaded.status === "corrupt") throw new DacsError(loaded.reason);
        if (loaded.status === "unsupported") {
          throw new DacsError(`payment-evidence store version ${loaded.version} is unsupported`);
        }
        if (loaded.status === "missing") {
          page = { items: [] };
        } else {
          const record = requireHandshakeRecord(
            loaded.record,
            "buyer",
            input.messageId,
            scopeHash,
          );
          if (record.request.requestHash !== input.requestHash) {
            throw new DacsError("buyer handshake exact request conflicts with retained state");
          }
          page = { items: [record] };
        }
      } else {
        page = clone(await store.listBuyerRunnable({ scopeHash, cursor, limit }));
      }
      if (!plainRecord(page) || !exactKeys(page, ["items"], ["nextCursor"]) ||
          !Array.isArray(page.items) || page.items.length > limit ||
          (page.nextCursor !== undefined && !nonEmpty(page.nextCursor))) {
        throw new DacsError("payment-evidence store returned a malformed runnable page");
      }
      const listedRecords = page.items.map((rawRecord) =>
        requireHandshakeRecord(rawRecord, "buyer", undefined, scopeHash)
      );
      let previousMessageId = cursor;
      for (const listed of listedRecords) {
        if (previousMessageId !== undefined && listed.messageId <= previousMessageId) {
          throw new DacsError("payment-evidence runnable page is not cursor ordered");
        }
        previousMessageId = listed.messageId;
      }
      if (page.nextCursor !== undefined &&
          (listedRecords.length === 0 || page.nextCursor !== listedRecords.at(-1)!.messageId)) {
        throw new DacsError("payment-evidence runnable page has an invalid next cursor");
      }
      const results: PaymentEvidenceHandshakeRunResult[] = [];
      let visitedCount = 0;
      let lastVisitedMessageId: string | undefined;
      for (const listed of listedRecords) {
        if (input.signal?.aborted) break;
        visitedCount += 1;
        lastVisitedMessageId = listed.messageId;
        const request = clone(listed.request);
        const claim = clone(await store.claimBuyer({
          scopeHash,
          messageId: request.messageId,
          requestHash: request.requestHash,
          owner: workerId,
          leaseDurationMs,
        }));
        if (claim.status !== "acquired") {
          if (claim.status === "corrupt") throw new DacsError(claim.reason);
          if (claim.status === "unsupported") {
            throw new DacsError(`payment-evidence store version ${claim.version} is unsupported`);
          }
          if (claim.status === "waiting" || claim.status === "complete" ||
              claim.status === "not-runnable") {
            requireHandshakeRecord(claim.record, "buyer", request.messageId, scopeHash);
          }
          if (!["waiting", "complete", "not-runnable", "missing", "stale"].includes(
            claim.status,
          )) {
            throw new DacsError("payment-evidence store returned an unknown buyer-claim result");
          }
          results.push({
            messageId: request.messageId,
            status: claim.status === "waiting" || claim.status === "not-runnable" ||
                claim.status === "complete"
              ? "waiting"
              : "stale",
          });
          continue;
        }
        if (claim.mode !== "anchor" && claim.mode !== "reconcile") {
          throw new DacsError("payment-evidence store returned an unknown buyer-claim mode");
        }
        const claimed = requireHandshakeRecord(
          claim.record,
          "buyer",
          request.messageId,
          scopeHash,
        );
        const retainedRequest = clone(claimed.request);
        const lease = clone(claim.lease);
        if (!validLease(lease) || !claimed.buyerWork?.lease ||
            canonicalize(lease) !== canonicalize(claimed.buyerWork.lease)) {
          throw new DacsError("payment-evidence store returned an invalid buyer lease");
        }
        if (claimed.buyerWork.state !== "reconciliation-required" ||
            (claim.mode === "anchor" &&
              claimed.buyerWork.reasonCode !== "anchor-attempt-in-flight")) {
          throw new DacsError(
            "payment-evidence store did not durably mark the buyer anchor claim",
          );
        }
        const fence: PaymentEvidenceAnchorFence = Object.freeze({
          messageId: retainedRequest.messageId,
          requestHash: retainedRequest.requestHash,
          effectId: retainedRequest.effectId,
          owner: lease.owner,
          generation: lease.generation,
          idempotencyKey: sha256Hex(canonicalize({
            role: "buyer",
            effectId: retainedRequest.effectId,
            logicalAddress: retainedRequest.logicalAddress,
            requestHash: retainedRequest.requestHash,
          })),
          assertCurrent: async () => {
            if (!await store.isCurrentBuyer({
              scopeHash,
              messageId: retainedRequest.messageId,
              requestHash: retainedRequest.requestHash,
              lease,
            })) throw new DacsError("buyer payment-evidence anchor fence is stale");
          },
        });
        const effectInput = {
          effectId: retainedRequest.effectId,
          logicalAddress: retainedRequest.logicalAddress,
          evidenceHash: retainedRequest.evidenceHash,
          evidence: clone(retainedRequest.evidence),
          expectedWriter: clone(retainedRequest.expectedWriter),
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        };
        let anchored: SellerSessionSettlementAnchorResult | undefined;
        if (claim.mode === "reconcile") {
          let reconciled: PaymentEvidenceAnchorReconciliation;
          try {
            reconciled = captureReconciliation(await Reflect.apply(
              reconcileAnchor,
              INERT_RECEIVER,
              [effectInput, fence],
            ));
          } catch {
            results.push(await recordAttempt(
              retainedRequest,
              lease,
              "reconciliation-required",
              "reconciliation-threw",
            ));
            continue;
          }
          if (reconciled.disposition === "absent") {
            const written = clone(await store.recordBuyerAbsence({
              scopeHash,
              messageId: retainedRequest.messageId,
              requestHash: retainedRequest.requestHash,
              lease,
              absenceProofHash: reconciled.absenceProofHash,
            }));
            if (written.status === "corrupt") throw new DacsError(written.reason);
            if (written.status === "unsupported") {
              throw new DacsError(`payment-evidence store version ${written.version} is unsupported`);
            }
            if (written.status === "recorded" || written.status === "existing") {
              requireHandshakeRecord(
                written.record,
                "buyer",
                retainedRequest.messageId,
                scopeHash,
              );
            }
            if (!["recorded", "existing", "missing", "stale", "conflict"].includes(
              written.status,
            )) {
              throw new DacsError("payment-evidence store returned an unknown absence-write result");
            }
            results.push({
              messageId: retainedRequest.messageId,
              status: written.status === "recorded" ? "reconciled-absent" : "stale",
            });
            continue;
          }
          if (reconciled.disposition !== "anchored") {
            results.push(await recordAttempt(
              retainedRequest,
              lease,
              reconciled.disposition === "invalid"
                ? "operator-action"
                : "reconciliation-required",
              `reconciliation-${reconciled.disposition}`,
            ));
            continue;
          }
          anchored = {
            disposition: "anchored",
            evidenceRef: reconciled.evidenceRef,
            anchorReceipt: reconciled.anchorReceipt,
          };
        } else {
          try {
            await fence.assertCurrent();
            anchored = captureAnchorResult(await Reflect.apply(
              anchorEvidence,
              INERT_RECEIVER,
              [effectInput, fence],
            ));
          } catch {
            results.push(await recordAttempt(
              retainedRequest,
              lease,
              "reconciliation-required",
              "anchor-threw",
            ));
            continue;
          }
          if (anchored.disposition !== "anchored") {
            results.push(await recordAttempt(
              retainedRequest,
              lease,
              anchored.disposition === "rejected"
                ? "operator-action"
                : "reconciliation-required",
              `anchor-${anchored.disposition}`,
            ));
            continue;
          }
        }
        let completion: PaymentEvidenceAnchorCompletion;
        try {
          completion = createPaymentEvidenceAnchorCompletion({
            request: retainedRequest,
            evidenceRef: anchored.evidenceRef,
            anchorReceipt: anchored.anchorReceipt,
          });
        } catch {
          results.push(await recordAttempt(
            retainedRequest,
            lease,
            "operator-action",
            "anchor-result-invalid",
          ));
          continue;
        }
        let verification: PaymentEvidenceAnchorVerification;
        try {
          verification = captureVerification(await Reflect.apply(
            verifyAnchorReceipt,
            INERT_RECEIVER,
            [{
              request: clone(retainedRequest),
              completion: clone(completion),
              ...(input.signal === undefined ? {} : { signal: input.signal }),
            }],
          ));
        } catch {
          results.push(await recordAttempt(
            retainedRequest,
            lease,
            "reconciliation-required",
            "receipt-verifier-threw",
          ));
          continue;
        }
        if (verification.disposition !== "valid") {
          results.push(await recordAttempt(
            retainedRequest,
            lease,
            verification.disposition === "invalid"
              ? "operator-action"
              : "reconciliation-required",
            `receipt-${verification.disposition}`,
          ));
          continue;
        }
        const written = clone(await store.recordBuyerCompletion({
          scopeHash,
          messageId: retainedRequest.messageId,
          requestHash: retainedRequest.requestHash,
          lease,
          completion,
        }));
        if (written.status === "corrupt") throw new DacsError(written.reason);
        if (written.status === "unsupported") {
          throw new DacsError(`payment-evidence store version ${written.version} is unsupported`);
        }
        if (written.status === "recorded" || written.status === "existing") {
          requireHandshakeRecord(
            written.record,
            "buyer",
            retainedRequest.messageId,
            scopeHash,
          );
        }
        if (!["recorded", "existing", "missing", "stale", "conflict"].includes(
          written.status,
        )) {
          throw new DacsError("payment-evidence store returned an unknown completion-write result");
        }
        results.push({
          messageId: retainedRequest.messageId,
          status: written.status === "recorded" || written.status === "existing"
            ? "completed"
            : "stale",
        });
      }
      const nextCursor = visitedCount === listedRecords.length
        ? page.nextCursor
        : lastVisitedMessageId;
      return {
        items: clone(results),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    },

    async claimOutboundCompletions(input = {}) {
      if (!plainRecord(input) || !exactKeys(input, [], ["cursor", "limit"])) {
        throw new DacsError("buyer completion outbox options are malformed");
      }
      const cursor = captureCursor(input.cursor);
      const limit = captureLimit(input.limit);
      return claimPage(await store.claimBuyerCompletions({
        scopeHash,
        owner: workerId,
        cursor,
        limit,
        leaseDurationMs,
      }), "completion", cursor, limit, scopeHash) as
        PaymentEvidencePage<PaymentEvidenceOutboundCompletionClaim>;
    },

    async acknowledgeOutboundCompletion(input) {
      const claim = claimInput(
        input,
        "completion",
        scopeHash,
      ) as PaymentEvidenceOutboundCompletionClaim;
      const written = clone(await store.acknowledgeBuyerCompletion({
        scopeHash,
        messageId: claim.completion.requestMessageId,
        completionHash: claim.completion.completionHash,
        lease: claim.lease,
      }));
      const status = requireScopedWrite(
        written,
        "payment-evidence completion acknowledgement",
        "buyer",
        claim.completion.requestMessageId,
        scopeHash,
      );
      return status === "recorded" ? "acknowledged" : "existing";
    },

    async releaseOutboundCompletion(input, release) {
      const claim = claimInput(
        input,
        "completion",
        scopeHash,
      ) as PaymentEvidenceOutboundCompletionClaim;
      if (!plainRecord(release) || !exactKeys(release, ["reasonCode"], ["retryAt"]) ||
          !validReasonCode(release.reasonCode) ||
          (release.retryAt !== undefined && !safeUint(release.retryAt))) {
        throw new DacsError("payment-evidence completion release is malformed");
      }
      requireScopedWrite(clone(await store.releaseBuyerCompletion({
        scopeHash,
        messageId: claim.completion.requestMessageId,
        completionHash: claim.completion.completionHash,
        lease: claim.lease,
        reasonCode: release.reasonCode,
        ...(release.retryAt === undefined ? {} : { retryAt: release.retryAt }),
      })), "payment-evidence completion release", "buyer",
      claim.completion.requestMessageId, scopeHash);
    },

    async repairRequest(messageId, requestHash, operatorReasonCode) {
      if (!nonEmpty(messageId) || typeof requestHash !== "string" || !HASH_RE.test(requestHash) ||
          !validReasonCode(operatorReasonCode)) {
        throw new DacsError("payment-evidence repair request is malformed");
      }
      requireScopedWrite(clone(await store.requeueBuyer({
        scopeHash,
        messageId,
        requestHash,
        operatorReasonCode,
      })), "payment-evidence repair request", "buyer", messageId, scopeHash);
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
    "workerId",
    "protocol",
    "authenticateCompletion",
    "verifyAnchorReceipt",
  ], ["leaseDurationMs"]) || !isCanonicalClaimReference(options.seller) ||
      !isCanonicalClaimReference(options.buyer) ||
      sameCanonicalClaimIdentity(options.seller, options.buyer) || !nonEmpty(options.workerId) ||
      typeof options.authenticateCompletion !== "function" ||
      typeof options.verifyAnchorReceipt !== "function") {
    throw new DacsError("seller payment-evidence handshake options are malformed");
  }
  const store = requireStore(options.store);
  const seller = options.seller;
  const buyer = options.buyer;
  const workerId = options.workerId;
  const protocol = captureFixedPriceX402ProtocolBinding(options.protocol);
  if (!sameCanonicalClaimIdentity(protocol.orchestrator, seller)) {
    throw new DacsError("seller handshake requires the pinned seller-orchestrator topology");
  }
  const scope: PaymentEvidenceHandshakeScope = {
    seller,
    buyer,
    protocolHash: fixedPriceX402ProtocolBindingHash(protocol),
  };
  const scopeHash = paymentEvidenceHandshakeScopeHash(scope);
  const authenticateCompletion = options.authenticateCompletion;
  const verifyAnchorReceipt = options.verifyAnchorReceipt;
  const leaseDurationMs = captureDuration(
    options.leaseDurationMs,
    DEFAULT_LEASE_DURATION_MS,
    "seller handshake leaseDurationMs",
  );

  const handshake: SellerPaymentEvidenceHandshake = {
    async anchorEvidence(input) {
      let request: PaymentEvidenceAnchorRequest;
      try {
        request = createPaymentEvidenceAnchorRequest({
          ...ownClone(input, "seller payment-evidence anchor input"),
          seller,
          buyer,
          protocol,
        });
      } catch {
        return {
          disposition: "rejected",
          reason: "seller payment-evidence request is malformed or unsupported",
        };
      }
      const stored = clone(await store.putRequest({
        role: "seller",
        scopeHash,
        request,
      }));
      if (stored.status !== "created" && stored.status !== "existing") {
        return {
          disposition: stored.status === "conflict" ? "rejected" : "indeterminate",
          reason: stored.status === "corrupt"
            ? "payment-evidence store rejected malformed retained state"
            : "payment-evidence request conflicts with retained outbox state",
        };
      }
      const record = requireHandshakeRecord(
        stored.record,
        "seller",
        request.messageId,
        scopeHash,
      );
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

    async claimOutboundRequests(input = {}) {
      if (!plainRecord(input) || !exactKeys(input, [], ["cursor", "limit"])) {
        throw new DacsError("seller request outbox options are malformed");
      }
      const cursor = captureCursor(input.cursor);
      const limit = captureLimit(input.limit);
      return claimPage(await store.claimSellerRequests({
        scopeHash,
        owner: workerId,
        cursor,
        limit,
        leaseDurationMs,
      }), "request", cursor, limit, scopeHash) as
        PaymentEvidencePage<PaymentEvidenceOutboundRequestClaim>;
    },

    async acknowledgeOutboundRequest(input) {
      const claim = claimInput(input, "request", scopeHash) as
        PaymentEvidenceOutboundRequestClaim;
      const written = clone(await store.acknowledgeSellerRequest({
        scopeHash,
        messageId: claim.request.messageId,
        requestHash: claim.request.requestHash,
        lease: claim.lease,
      }));
      const status = requireScopedWrite(
        written,
        "payment-evidence request acknowledgement",
        "seller",
        claim.request.messageId,
        scopeHash,
      );
      return status === "recorded" ? "acknowledged" : "existing";
    },

    async releaseOutboundRequest(input, release) {
      const claim = claimInput(input, "request", scopeHash) as
        PaymentEvidenceOutboundRequestClaim;
      if (!plainRecord(release) || !exactKeys(release, ["reasonCode"], ["retryAt"]) ||
          !validReasonCode(release.reasonCode) ||
          (release.retryAt !== undefined && !safeUint(release.retryAt))) {
        throw new DacsError("payment-evidence request release is malformed");
      }
      requireScopedWrite(clone(await store.releaseSellerRequest({
        scopeHash,
        messageId: claim.request.messageId,
        requestHash: claim.request.requestHash,
        lease: claim.lease,
        reasonCode: release.reasonCode,
        ...(release.retryAt === undefined ? {} : { retryAt: release.retryAt }),
      })), "payment-evidence request release", "seller",
      claim.request.messageId, scopeHash);
    },

    async receiveCompletion(input, transportContext) {
      const completion = ownClone(input, "payment-evidence anchor completion");
      if (!isPaymentEvidenceAnchorCompletion(completion)) {
        throw new DacsError("payment-evidence anchor completion is malformed");
      }
      if (completionScopeHash(completion) !== scopeHash) {
        throw new DacsError(
          "payment-evidence completion targets a different actor pair or protocol",
        );
      }
      const loaded = clone(await store.load(
        "seller",
        completion.requestMessageId,
        scopeHash,
      ));
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
        scopeHash,
      );
      if (!completionMatchesRequest(record.request, completion)) {
        throw new DacsError("payment-evidence completion does not bind the retained request");
      }
      const authentication = captureAuthentication(await Reflect.apply(
        authenticateCompletion,
        INERT_RECEIVER,
        [clone(completion), transportContext],
      ), {
        principal: record.request.buyer,
        audience: record.request.seller,
        messageId: completion.messageId,
        messageHash: completion.completionHash,
      });
      if (authentication.disposition !== "authenticated") {
        throw new DacsError(`payment-evidence completion ${authentication.disposition}`);
      }
      const verification = captureVerification(await Reflect.apply(
        verifyAnchorReceipt,
        INERT_RECEIVER,
        [{ request: clone(record.request), completion: clone(completion) }],
      ));
      if (verification.disposition !== "valid") {
        throw new DacsError(`payment-evidence completion ${verification.disposition}`);
      }
      const written = clone(await store.recordSellerCompletion({
        scopeHash,
        messageId: record.messageId,
        requestHash: record.request.requestHash,
        completion,
        completionAuthentication: authentication.peer,
      }));
      if (written.status !== "recorded" && written.status !== "existing") {
        if (written.status === "corrupt") throw new DacsError(written.reason);
        if (written.status === "unsupported") {
          throw new DacsError(`payment-evidence store version ${written.version} is unsupported`);
        }
        throw new DacsError("payment-evidence completion conflicts with retained seller state");
      }
      requireHandshakeRecord(written.record, "seller", record.messageId, scopeHash);
      return written.status === "recorded" ? "accepted" : "existing";
    },
  };
  return Object.freeze(handshake);
}
