import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";
import { snapshotWireJsonRead } from "../canonical/snapshot.js";
import { hasAp2ProfileAdmission, readAp2ProfileAdmission, type Ap2ProfileAdmission } from "./ap2Admission.js";

import {
  assertPositiveAmount,
  canonicalize,
  sha256Hex,
} from "../canonical/index.js";
import { DacsError } from "../errors.js";
import type { AttestationRef } from "../artifacts/types.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const BASE64URL_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_LEASE_MS = 30_000;

export type Ap2CheckoutSignatureGeneration =
  | "non-deterministic"
  | "deterministic";

export interface Ap2CheckoutSignaturePolicyInput {
  algorithm: string;
  signatureGeneration: Ap2CheckoutSignatureGeneration;
}

export interface Ap2RegistrationCapabilities {
  createCredential: boolean;
  statusOnlyCredential: boolean;
  credentialsDistinct: boolean;
  createCredentialRelayed: boolean;
  providerMetadataWritable: boolean;
  providerMetadataReadable: boolean;
  providerIdempotencyKeys: boolean;
}

export interface Ap2MandateAdmissionInput extends Ap2CheckoutSignaturePolicyInput {
  jobId: string;
  phaseIndex: number;
  peerIdentity: string;
  profileAdmission: Ap2ProfileAdmission;
  checkoutMandatePresent: boolean;
  checkoutMandateVerified: boolean;
  paymentMandatePresent: boolean;
  paymentMandateVerified: boolean;
  checkoutJws: string;
  paymentTransactionId: string;
  sdAlg?: string;
}

export type Ap2MandateAdmission =
  | {
      decision: "pass";
      derivedTransactionId: string;
      reserveAp2Binding: true;
      submitProviderPayment: true;
    }
  | {
      decision: "fail" | "error";
      reason: string;
      derivedTransactionId?: string;
      reserveAp2Binding: false;
      submitProviderPayment: false;
    };

export type Ap2BindingState = "in-flight" | "settled" | "recovery-pending";

export interface Ap2TransactionBinding {
  transactionId: string;
  jobId: string;
  phaseIndex: number;
  state: Ap2BindingState;
  idempotencyKey: string;
  operationFingerprint: string;
  operationPayload: Readonly<{
    transactionId: string; jobId: string; phaseIndex: number;
    providerRequest: Readonly<Record<string, unknown>>;
  }>;
  providerRecoveryReference?: string;
  settlement?: Readonly<{ status: "captured"; transactionId: string; operationFingerprint: string }>;
}

export type Ap2TransactionBindingDecision =
  | { decision: "pass"; action: "bind-new"; submitNewPayment: true }
  | {
      decision: "pass";
      action: "resubmit-same-key" | "reconcile-reference" | "resume-settlement";
      submitNewPayment: false;
    }
  | { decision: "fail"; action: "reject-replay"; submitNewPayment: false }
  | { decision: "error"; action: "refuse-conflict"; submitNewPayment: false };

/**
 * AP2-6 byte-exact provider idempotency key. AP2-6 / CORE JID-3: the job id
 * must pass JID-1 before it is hashed.
 */
export function deriveAp2IdempotencyKey(
  jobId: string,
  phaseIndex: number,
): string {
  requireCanonicalJobId(jobId, "pay-ap2: jobId");
  if (!Number.isSafeInteger(phaseIndex) || phaseIndex < 0) {
    throw new DacsError("pay-ap2: phaseIndex must be a non-negative safe integer");
  }
  // A JID-1 id is ASCII, so it is already in NFC.
  return sha256Hex(`dacs-ap2-idem:v1:${jobId}:${phaseIndex}`);
}

/**
 * Derive AP2's transaction_id from the exact compact CheckoutMandate JWS.
 * DACS currently supports the AP2 default/explicit `sha-256` branch only.
 */
export function deriveAp2TransactionId(
  checkoutJws: string,
  sdAlg?: string,
): string {
  if (typeof checkoutJws !== "string") {
    throw new DacsError("pay-ap2: checkout JWT must be a string");
  }
  const segments = checkoutJws.split(".");
  if (
    segments.length !== 3 ||
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment.includes("=") ||
        !BASE64URL_SEGMENT_RE.test(segment),
    )
  ) {
    throw new DacsError(
      "pay-ap2: checkout JWT must be an unpadded three-segment compact JWS",
    );
  }
  if (sdAlg !== undefined && sdAlg !== "sha-256") {
    throw new DacsError(`pay-ap2: unsupported CheckoutMandate _sd_alg ${sdAlg}`);
  }
  return createHash("sha256")
    .update(Buffer.from(checkoutJws, "utf8"))
    .digest("base64url");
}

/** DACS selects AP2 v0.2's stricter non-deterministic checkout signature arm. */
export function ap2CheckoutSignaturePolicy(
  input: Ap2CheckoutSignaturePolicyInput,
): "pass" | "fail" {
  return typeof input.algorithm === "string" &&
    input.algorithm.length > 0 &&
    input.signatureGeneration === "non-deterministic"
    ? "pass"
    : "fail";
}

/** AP2-3 plus the AP2-1/AP2-2/AP2-6 registration-time capability gates. */
export function ap2RegistrationEligibility(
  input: Ap2RegistrationCapabilities,
): "pass" | "fail" {
  return input.createCredential === true &&
    input.statusOnlyCredential === true &&
    input.credentialsDistinct === true &&
    input.createCredentialRelayed === false &&
    input.providerMetadataWritable === true &&
    input.providerMetadataReadable === true &&
    input.providerIdempotencyKeys === true
    ? "pass"
    : "fail";
}

/** Admission is pure and must complete before AP2-7 reservation or side effects. */
export function admitAp2MandateChain(
  input: Ap2MandateAdmissionInput,
): Ap2MandateAdmission {
  const reject = (
    decision: "fail" | "error",
    reason: string,
    derivedTransactionId?: string,
  ): Ap2MandateAdmission => ({
    decision,
    reason,
    ...(derivedTransactionId ? { derivedTransactionId } : {}),
    reserveAp2Binding: false,
    submitProviderPayment: false,
  });

  try {
    if (!input || typeof input !== "object" || nodeTypes.isProxy(input)) throw new DacsError("pay-ap2: invalid scope");
    const job = Object.getOwnPropertyDescriptor(input, "jobId");
    const phase = Object.getOwnPropertyDescriptor(input, "phaseIndex");
    if (!job || !("value" in job) || !phase || !("value" in phase)) throw new DacsError("pay-ap2: scope must be stable own data");
    requireCanonicalJobId(job.value, "pay-ap2: jobId");
    if (!Number.isSafeInteger(phase.value) || phase.value < 0 || Object.is(phase.value, -0)) {
      throw new DacsError("pay-ap2: phaseIndex must be a non-negative safe integer");
    }
  } catch (error) {
    return reject("error", error instanceof Error ? error.message : "ap2-scope-invalid");
  }
  if (!hasAp2ProfileAdmission(input)) return reject("fail", "ap2-profile-admission-refused");

  if (!input.checkoutMandatePresent || !input.checkoutMandateVerified) {
    return reject("fail", "checkout-mandate-absent-or-unverified");
  }
  if (!input.paymentMandatePresent || !input.paymentMandateVerified) {
    return reject("fail", "payment-mandate-absent-or-unverified");
  }
  if (ap2CheckoutSignaturePolicy(input) !== "pass") {
    return reject("fail", "checkout-signature-policy-rejected");
  }

  let derivedTransactionId: string;
  try {
    derivedTransactionId = deriveAp2TransactionId(input.checkoutJws, input.sdAlg);
  } catch (error) {
    return reject(
      "error",
      error instanceof Error ? error.message : "transaction-id-derivation-error",
    );
  }
  if (derivedTransactionId !== input.paymentTransactionId) {
    return reject(
      "fail",
      "payment-mandate-transaction-id-mismatch",
      derivedTransactionId,
    );
  }
  return {
    decision: "pass",
    derivedTransactionId,
    reserveAp2Binding: true,
    submitProviderPayment: true,
  };
}

/** Sorted wire JSON preserves provider strings, including distinct Unicode spellings. */
function sortedWireJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedWireJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${sortedWireJson((value as Record<string, unknown>)[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** AP2-7 replay decision over an authenticated atomic-store snapshot. */
export function evaluateAp2TransactionBinding(input: {
  transactionId: string;
  jobId: string;
  phaseIndex: number;
  providerRequest: Readonly<Record<string, unknown>>;
  priorBindings: readonly Ap2TransactionBinding[];
}): Ap2TransactionBindingDecision {
  const corrupt: Ap2TransactionBindingDecision = {
    decision: "error", action: "refuse-conflict", submitNewPayment: false,
  };
  try {
    const captured = snapshotWireJsonRead(input, "AP2 binding decision");
    const { transactionId, jobId, phaseIndex, providerRequest, priorBindings } = captured;
    requireCanonicalJobId(jobId, "pay-ap2: jobId");
    if (typeof transactionId !== "string" || !transactionId ||
        !Number.isSafeInteger(phaseIndex) || phaseIndex < 0 ||
        !providerRequest || typeof providerRequest !== "object" || Array.isArray(providerRequest) ||
        !Array.isArray(priorBindings) || priorBindings.length > 1) return corrupt;
    const required = ["transactionId", "jobId", "phaseIndex", "state", "idempotencyKey", "operationFingerprint", "operationPayload"];
    const allowed = [...required, "providerRecoveryReference", "settlement"];
    for (const prior of priorBindings) {
      if (!prior || typeof prior !== "object" || Array.isArray(prior) ||
          required.some((key) => !Object.hasOwn(prior, key)) || Object.keys(prior).some((key) => !allowed.includes(key)) ||
          typeof prior.transactionId !== "string" || !prior.transactionId ||
          !Number.isSafeInteger(prior.phaseIndex) || prior.phaseIndex < 0 ||
          !["in-flight", "settled", "recovery-pending"].includes(prior.state)) return corrupt;
      const retained = prior.operationPayload;
      if (!retained || typeof retained !== "object" || Array.isArray(retained) ||
          Object.keys(retained).length !== 4 ||
          !["transactionId", "jobId", "phaseIndex", "providerRequest"].every((key) => Object.hasOwn(retained, key)) ||
          retained.transactionId !== prior.transactionId || retained.jobId !== prior.jobId || retained.phaseIndex !== prior.phaseIndex ||
          !retained.providerRequest || typeof retained.providerRequest !== "object" || Array.isArray(retained.providerRequest) ||
          prior.idempotencyKey !== deriveAp2IdempotencyKey(prior.jobId, prior.phaseIndex) ||
          prior.operationFingerprint !== sha256Hex(sortedWireJson(retained)) ||
          (prior.providerRecoveryReference !== undefined && (typeof prior.providerRecoveryReference !== "string" || !prior.providerRecoveryReference))) return corrupt;
      if (prior.state === "settled") {
        const settlement = prior.settlement;
        if (!settlement || Object.keys(settlement).length !== 3 || settlement.status !== "captured" ||
            settlement.transactionId !== prior.transactionId || settlement.operationFingerprint !== prior.operationFingerprint) return corrupt;
      } else if (prior.settlement !== undefined) return corrupt;
    }
    if (priorBindings.length === 0) return { decision: "pass", action: "bind-new", submitNewPayment: true };
    const prior = priorBindings[0]!;
    if (prior.transactionId !== transactionId || prior.jobId !== jobId || prior.phaseIndex !== phaseIndex) {
      return { decision: "fail", action: "reject-replay", submitNewPayment: false };
    }
    const requested = { transactionId, jobId, phaseIndex, providerRequest };
    if (prior.operationFingerprint !== sha256Hex(sortedWireJson(requested)) ||
        sortedWireJson(prior.operationPayload) !== sortedWireJson(requested)) return corrupt;
    return {
      decision: "pass",
      action: prior.state === "settled" ? "resume-settlement" : prior.providerRecoveryReference ? "reconcile-reference" : "resubmit-same-key",
      submitNewPayment: false,
    };
  } catch { return corrupt; }
}

export interface Ap2VerifiedCheckoutMandate {
  checkoutJws: string;
  sdAlg?: string;
  algorithm: string;
  signatureGeneration: Ap2CheckoutSignatureGeneration;
}

export interface Ap2VerifiedPaymentMandate {
  transactionId: string;
  mandateId: string;
  payee: string;
  amount: string;
  currency: string;
  paymentInstrumentId: string;
}

export type Ap2MandateVerification<T> =
  | { disposition: "verified"; mandate: Readonly<T> }
  | { disposition: "rejected" | "indeterminate"; reason: string };

export interface Ap2MandateVerifier<TCheckout = unknown, TPayment = unknown> {
  /**
   * Verify the complete CheckoutMandate, its checkout_hash/SD-JWT relationship,
   * and the merchant signature profile. Returning `verified` is an authority
   * assertion, not a structural parse result.
   */
  verifyCheckoutMandate(
    artifact: Readonly<TCheckout>,
  ): Promise<Ap2MandateVerification<Ap2VerifiedCheckoutMandate>>;
  /** Verify the distinct PaymentMandate and the payer's AP2 authorisation. */
  verifyPaymentMandate(
    artifact: Readonly<TPayment>,
  ): Promise<Ap2MandateVerification<Ap2VerifiedPaymentMandate>>;
}

export interface Ap2SettlementIntent {
  intentVersion: "2";
  /** Sorted-key wire JSON; strings are retained exactly, without Unicode normalization. */
  operationJson: string;
  operationHash: string;
  bindingHash: string;
  transactionId: string;
  jobId: string;
  phaseIndex: number;
  agreementHash: string;
  idempotencyKey: string;
  mandateId: string;
  payee: string;
  amount: string;
  currency: string;
  protocolVersion: string;
  paymentInstrumentId: string;
}

export type Ap2ReceiptAttestation = AttestationRef;

export interface Ap2ReceiptTransactionRef {
  kind: string;
  value: string;
}

export interface Ap2CapturedSettlement {
  providerRef: string;
  mandateId: string;
  protocolVersion: string;
  receiptAttestation: Readonly<Ap2ReceiptAttestation>;
  receiptTransactionRef?: Readonly<Ap2ReceiptTransactionRef>;
  payee: string;
  amount: string;
  currency: string;
  capturedAt: number;
}

export interface Ap2BindingLease {
  owner: string;
  generation: number;
  expiresAt: number;
}

export type Ap2BindingClaim =
  | { status: "acquired"; intent: Readonly<Ap2SettlementIntent>; lease: Ap2BindingLease; createdAt: number; replayDeadline?: number; providerRef?: string }
  | { status: "waiting"; intent: Readonly<Ap2SettlementIntent>; lease: Ap2BindingLease; createdAt: number; replayDeadline?: number; providerRef?: string }
  | { status: "settled"; intent: Readonly<Ap2SettlementIntent>; settlement: Readonly<Ap2CapturedSettlement> }
  | { status: "failed"; intent: Readonly<Ap2SettlementIntent>; reason: string }
  | { status: "conflict" | "corrupt"; reason: string };

export type Ap2BindingWrite =
  | { status: "recorded" | "existing" }
  | { status: "stale" | "conflict" | "corrupt"; reason: string };

/**
 * AP2-7 claim refusal for a second transaction_id presented for a
 * (jobId, phaseIndex) whose AP2-6 key is already bound to another one.
 * @internal shared with the bundled filesystem store.
 */
export const AP2_PHASE_BOUND_ELSEWHERE = "ap2-phase-bound-to-another-transaction";

/**
 * AP2-7 claim refusal for a transaction_id already bound to a different
 * request. The same (jobId, phaseIndex) with a different retained operation
 * is an operation conflict, not a cross-session replay.
 * @internal shared with the bundled filesystem store.
 */
export function ap2BindingConflictReason(
  stored: Readonly<Pick<Ap2SettlementIntent, "jobId" | "phaseIndex">>,
  presented: Readonly<Pick<Ap2SettlementIntent, "jobId" | "phaseIndex">>,
): string {
  return stored.jobId === presented.jobId && stored.phaseIndex === presented.phaseIndex
    ? "ap2-retained-operation-conflict"
    : "ap2-transaction-id-replay";
}

/** Atomic durable store. Production implementations must persist this state. */
export interface Ap2BindingStore {
  /**
   * Reserve or resolve the binding for `intent.transactionId`. The first
   * claim must also atomically bind the phase (`intent.idempotencyKey`, the
   * AP2-6 key of `(jobId, phaseIndex)`) to that transaction_id: a claim for a
   * different transaction_id on an occupied phase returns `conflict` with
   * reason `"ap2-phase-bound-to-another-transaction"`, creating no record and
   * no replay deadline, whatever state the first binding is in.
   */
  claim(input: {
    intent: Readonly<Ap2SettlementIntent>;
    owner: string;
    now: number;
    leaseDurationMs: number;
    /** Persist now + this window on FIRST claim only; never refresh it on takeover. */
    noReferenceReplayWindowMs?: number;
  }): Promise<Ap2BindingClaim>;
  isCurrent(input: {
    transactionId: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
  }): Promise<boolean>;
  recordProviderRef(input: {
    transactionId: string;
    bindingHash: string;
    owner: string;
    generation: number;
    providerRef: string;
  }): Promise<Ap2BindingWrite>;
  recordSettlement(input: {
    transactionId: string;
    bindingHash: string;
    owner: string;
    generation: number;
    settlement: Readonly<Ap2CapturedSettlement>;
  }): Promise<Ap2BindingWrite>;
  recordFailure(input: {
    transactionId: string;
    bindingHash: string;
    owner: string;
    generation: number;
    reason: string;
  }): Promise<Ap2BindingWrite>;
}

export interface Ap2EffectFence {
  transactionId: string;
  bindingHash: string;
  owner: string;
  generation: number;
  idempotencyKey: string;
  assertCurrent(): Promise<void>;
  /** Recheck the fence and retained provider replay deadline immediately before create. */
  assertSubmissionAllowed(): Promise<void>;
}

export type Ap2ProviderSubmission =
  | { disposition: "accepted"; providerRef: string }
  | { disposition: "declined"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type Ap2AttestedProviderStatus =
  | {
      disposition: "captured";
      providerRef: string;
      payee: string;
      amount: string;
      currency: string;
      metadata: Readonly<Record<string, string>>;
      receiptAttestation: Readonly<Ap2ReceiptAttestation>;
      receiptTransactionRef?: Readonly<Ap2ReceiptTransactionRef>;
      capturedAt: number;
    }
  | { disposition: "pending"; reason: string }
  | { disposition: "indeterminate"; reason: string }
  | { disposition: "terminal-not-captured"; reason: string };

/**
 * Provider adapter boundary. `submit` owns the privileged create credential;
 * `readAttestedStatus` must use the distinct status-only credential through
 * the selected SR-3 binding and return only authenticated status material.
 */
export interface Ap2ProviderAdapter {
  /** Required guaranteed deduplication window, reduced by a clock/network safety margin and bound into the retained operation. */
  readonly noReferenceReplayWindowMs: number;
  /** Stable destination/account namespace and every effect-bearing adapter option. No credentials. */
  operation: Readonly<{ destination: string; idempotencyNamespace: string; parameters: Readonly<Record<string, unknown>> }>;
  capabilities: Readonly<Ap2RegistrationCapabilities>;
  submit(input: {
    intent: Readonly<Ap2SettlementIntent>;
    checkoutMandate: Readonly<unknown>;
    paymentMandate: Readonly<unknown>;
    metadata: Readonly<Record<string, string>>;
    idempotencyKey: string;
    fence: Readonly<Ap2EffectFence>;
  }): Promise<Ap2ProviderSubmission>;
  readAttestedStatus(input: {
    intent: Readonly<Ap2SettlementIntent>;
    providerRef: string;
    fence: Readonly<Ap2EffectFence>;
  }): Promise<Ap2AttestedProviderStatus>;
}

export interface AdvanceAp2SettlementInput<TCheckout = unknown, TPayment = unknown> {
  jobId: string;
  phaseIndex: number;
  peerIdentity: string;
  profileAdmission: Ap2ProfileAdmission;
  agreementHash: string;
  protocolVersion: string;
  expected: Readonly<{ payee: string; amount: string; currency: string }>;
  checkoutMandate: Readonly<TCheckout>;
  paymentMandate: Readonly<TPayment>;
  owner: string;
  verifier: Ap2MandateVerifier<TCheckout, TPayment>;
  provider: Ap2ProviderAdapter;
  store: Ap2BindingStore;
  now?: () => number;
  leaseDurationMs?: number;
}

export type Ap2SettlementProgress =
  | { status: "waiting" | "indeterminate"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "settled"; settlement: Readonly<Ap2CapturedSettlement> };

function requireString(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DacsError(`pay-ap2: ${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DacsError(`pay-ap2: ${label} must be a positive safe integer`);
  }
  return value;
}

function requireClockValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DacsError("pay-ap2: clock must return a non-negative safe integer");
  }
  return value;
}

function intentFrom(input: {
  jobId: string;
  phaseIndex: number;
  agreementHash: string;
  protocolVersion: string;
  operationJson: string;
  verifiedPayment: Readonly<Ap2VerifiedPaymentMandate>;
}): Ap2SettlementIntent {
  const amount = assertPositiveAmount(input.verifiedPayment.amount);
  if (!HASH_RE.test(input.agreementHash)) {
    throw new DacsError("pay-ap2: agreementHash must be 32-byte lower-case hex");
  }
  const unsigned = {
    intentVersion: "2" as const,
    operationJson: input.operationJson,
    operationHash: sha256Hex(input.operationJson),
    transactionId: requireString(input.verifiedPayment.transactionId, "transactionId"),
    jobId: requireString(input.jobId, "jobId").normalize("NFC"),
    phaseIndex: input.phaseIndex,
    agreementHash: input.agreementHash,
    idempotencyKey: deriveAp2IdempotencyKey(input.jobId, input.phaseIndex),
    mandateId: requireString(input.verifiedPayment.mandateId, "mandateId"),
    payee: requireString(input.verifiedPayment.payee, "payee"),
    amount,
    currency: requireString(input.verifiedPayment.currency, "currency"),
    protocolVersion: requireString(input.protocolVersion, "protocolVersion"),
    paymentInstrumentId: requireString(
      input.verifiedPayment.paymentInstrumentId,
      "paymentInstrumentId",
    ),
  };
  return Object.freeze({
    ...unsigned,
    bindingHash: sha256Hex(canonicalize(unsigned)),
  });
}

function validAttestation(value: Ap2ReceiptAttestation): boolean {
  return value !== null && typeof value === "object" &&
    value.anchor !== null && typeof value.anchor === "object" &&
    ["storage-program", "ipfs", "https"].includes(value.anchor.kind) &&
    typeof value.anchor.locator === "string" && value.anchor.locator.length > 0 &&
    HASH_RE.test(value.contentHash) &&
    (value.signer === undefined ||
      (typeof value.signer === "string" && value.signer.length > 0));
}

function validReceiptTransactionRef(value: Ap2ReceiptTransactionRef): boolean {
  return value !== null && typeof value === "object" &&
    typeof value.kind === "string" && value.kind.length > 0 &&
    typeof value.value === "string" && value.value.length > 0;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): Readonly<T> {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function snapshotArtifact<T>(value: Readonly<T>, label: string): Readonly<T> {
  try {
    return deepFreeze(structuredClone(value));
  } catch (error) {
    throw new DacsError(`pay-ap2: ${label} must be structured-cloneable`, {
      cause: error,
    });
  }
}

function settlementMatchesIntent(
  settlement: Readonly<Ap2CapturedSettlement>,
  intent: Readonly<Ap2SettlementIntent>,
): boolean {
  try {
    const amount = assertPositiveAmount(settlement.amount);
    return typeof settlement.providerRef === "string" && settlement.providerRef.length > 0 &&
      settlement.mandateId === intent.mandateId &&
      settlement.protocolVersion === intent.protocolVersion &&
      settlement.payee === intent.payee &&
      amount === intent.amount &&
      settlement.currency === intent.currency &&
      validAttestation(settlement.receiptAttestation) &&
      Number.isSafeInteger(settlement.capturedAt) && settlement.capturedAt >= 0;
  } catch {
    return false;
  }
}

/**
 * Restart-safe AP2 settlement. Ambiguous submission never authorizes a fresh
 * charge: recovery reuses the AP2-6 key within the provider's retained replay
 * deadline. Outside that deadline, a missing reference requires operator action.
 */
export async function advanceAp2Settlement<TCheckout, TPayment>(
  input: AdvanceAp2SettlementInput<TCheckout, TPayment>,
): Promise<Ap2SettlementProgress> {
  const admittedScope = readAp2ProfileAdmission(input);
  if (!admittedScope) return { status: "failed", reason: "ap2-profile-admission-refused" };
  // Capture the admitted scope before any callback can mutate the caller input.
  const admittedJobId = admittedScope.jobId;
  const admittedPhaseIndex = admittedScope.phaseIndex;
  const provider = input.provider;
  const verifier = input.verifier;
  const store = input.store;
  const now = input.now ?? Date.now;
  let leaseDurationMs: number;
  let owner: string;
  let noReferenceReplayWindowMs: number;
  try {
    noReferenceReplayWindowMs = requirePositiveSafeInteger(
      provider.noReferenceReplayWindowMs, "noReferenceReplayWindowMs",
    );
    leaseDurationMs = requirePositiveSafeInteger(
      input.leaseDurationMs ?? DEFAULT_LEASE_MS,
      "leaseDurationMs",
    );
    owner = requireString(input.owner, "owner");
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "ap2-runtime-policy-invalid",
    };
  }
  const verifyCheckoutMandate = verifier.verifyCheckoutMandate.bind(verifier);
  const verifyPaymentMandate = verifier.verifyPaymentMandate.bind(verifier);
  const submitProviderPayment = provider.submit.bind(provider);
  const readAttestedStatus = provider.readAttestedStatus.bind(provider);
  const claimBinding = store.claim.bind(store);
  const isCurrentBinding = store.isCurrent.bind(store);
  const recordProviderRef = store.recordProviderRef.bind(store);
  const recordSettlement = store.recordSettlement.bind(store);
  const recordFailure = store.recordFailure.bind(store);
  const capabilities = Object.freeze({ ...provider.capabilities });
  const readNow = (): number => requireClockValue(now());
  const authority = Object.freeze({
    jobId: admittedJobId,
    phaseIndex: admittedPhaseIndex,
    agreementHash: input.agreementHash,
    protocolVersion: input.protocolVersion,
    expected: Object.freeze({ ...input.expected }),
    owner,
  });

  if (ap2RegistrationEligibility(capabilities) !== "pass") {
    return { status: "failed", reason: "ap2-provider-registration-ineligible" };
  }

  let operationJson: string;
  let providerOperation: Ap2ProviderAdapter["operation"];
  let checkoutArtifact: Readonly<TCheckout>;
  let paymentArtifact: Readonly<TPayment>;
  let checkout: Ap2MandateVerification<Ap2VerifiedCheckoutMandate>;
  let payment: Ap2MandateVerification<Ap2VerifiedPaymentMandate>;
  try {
    const operation = snapshotWireJsonRead(provider.operation, "AP2 provider operation") as Ap2ProviderAdapter["operation"];
    requireString(operation.destination, "provider destination");
    requireString(operation.idempotencyNamespace, "provider idempotency namespace");
    if (!operation.parameters || typeof operation.parameters !== "object" || Array.isArray(operation.parameters)) throw new DacsError("invalid provider parameters");
    checkoutArtifact = snapshotWireJsonRead(input.checkoutMandate, "CheckoutMandate") as Readonly<TCheckout>;
    paymentArtifact = snapshotWireJsonRead(input.paymentMandate, "PaymentMandate") as Readonly<TPayment>;
    providerOperation = operation;
    deepFreeze(checkoutArtifact);
    deepFreeze(paymentArtifact);
    [checkout, payment] = await Promise.all([
      verifyCheckoutMandate(checkoutArtifact),
      verifyPaymentMandate(paymentArtifact),
    ]);
  } catch {
    return { status: "indeterminate", reason: "ap2-mandate-verification-unavailable" };
  }
  if (checkout.disposition === "indeterminate" || payment.disposition === "indeterminate") {
    return { status: "indeterminate", reason: "ap2-mandate-verification-indeterminate" };
  }
  if (checkout.disposition !== "verified" || payment.disposition !== "verified") {
    return { status: "failed", reason: "ap2-mandate-verification-rejected" };
  }

  const admission = admitAp2MandateChain({
    ...admittedScope,
    checkoutMandatePresent: true,
    checkoutMandateVerified: true,
    paymentMandatePresent: true,
    paymentMandateVerified: true,
    checkoutJws: checkout.mandate.checkoutJws,
    ...(checkout.mandate.sdAlg === undefined ? {} : { sdAlg: checkout.mandate.sdAlg }),
    algorithm: checkout.mandate.algorithm,
    signatureGeneration: checkout.mandate.signatureGeneration,
    paymentTransactionId: payment.mandate.transactionId,
  });
  if (admission.decision !== "pass") {
    return { status: "failed", reason: admission.reason };
  }

  let intent: Ap2SettlementIntent;
  try {
    // Key order is not part of the operation: a retry that presents the same
    // mandates in another order must compare equal, with exact string bytes.
    operationJson = sortedWireJson({
      provider: providerOperation,
      noReferenceReplayWindowMs,
      checkoutMandate: checkoutArtifact,
      paymentMandate: paymentArtifact,
      metadata: { dacs_job_id: authority.jobId, dacs_agreement_hash: authority.agreementHash },
    });
    intent = intentFrom({
      jobId: authority.jobId,
      phaseIndex: authority.phaseIndex,
      agreementHash: authority.agreementHash,
      protocolVersion: authority.protocolVersion,
      operationJson,
      verifiedPayment: payment.mandate,
    });
    if (
      intent.payee !== authority.expected.payee ||
      intent.amount !== assertPositiveAmount(authority.expected.amount) ||
      intent.currency !== authority.expected.currency
    ) {
      return { status: "failed", reason: "ap2-payment-mandate-terms-mismatch" };
    }
  } catch (error) {
    return {
      status: "failed",
      reason: error instanceof Error ? error.message : "ap2-intent-invalid",
    };
  }

  let claimed: Ap2BindingClaim;
  let claimNow: number;
  try {
    claimNow = readNow();
    claimed = await claimBinding({ intent, owner: authority.owner, now: claimNow, leaseDurationMs,
      noReferenceReplayWindowMs,
    });
  } catch {
    return { status: "indeterminate", reason: "ap2-binding-store-unavailable" };
  }
  if ("intent" in claimed) {
    try {
      if (claimed.intent.intentVersion !== "2" || claimed.intent.operationJson !== intent.operationJson ||
          claimed.intent.operationHash !== sha256Hex(claimed.intent.operationJson) ||
          canonicalize(claimed.intent) !== canonicalize(intent)) {
        return { status: "failed", reason: "ap2-binding-store-intent-mismatch" };
      }
    } catch {
      return { status: "failed", reason: "ap2-binding-store-intent-invalid" };
    }
  }
  if (claimed.status === "waiting") {
    return { status: "waiting", reason: "ap2-binding-held" };
  }
  if (claimed.status === "settled") {
    try {
      const settlement = snapshotArtifact(claimed.settlement, "stored settlement");
      return settlementMatchesIntent(settlement, intent)
        ? { status: "settled", settlement }
        : { status: "failed", reason: "ap2-binding-store-settlement-mismatch" };
    } catch {
      return { status: "failed", reason: "ap2-binding-store-settlement-invalid" };
    }
  }
  if (claimed.status === "failed") {
    return { status: "failed", reason: claimed.reason };
  }
  if (claimed.status !== "acquired") {
    return { status: "failed", reason: claimed.reason };
  }
  if (claimed.lease.owner !== authority.owner ||
      !Number.isSafeInteger(claimed.lease.generation) || claimed.lease.generation <= 0 ||
      !Number.isSafeInteger(claimed.lease.expiresAt) || claimed.lease.expiresAt <= claimNow) {
    return { status: "failed", reason: "ap2-binding-store-lease-invalid" };
  }

  const fence: Ap2EffectFence = Object.freeze({
    transactionId: intent.transactionId,
    bindingHash: intent.bindingHash,
    owner: claimed.lease.owner,
    generation: claimed.lease.generation,
    idempotencyKey: intent.idempotencyKey,
    assertCurrent: async () => {
      if (!await isCurrentBinding({
        transactionId: intent.transactionId,
        bindingHash: intent.bindingHash,
        owner: claimed.lease.owner,
        generation: claimed.lease.generation,
        now: readNow(),
      })) {
        throw new DacsError("pay-ap2: stale effect fence");
      }
    },
    assertSubmissionAllowed: async () => {
      await fence.assertCurrent();
      const currentTime = readNow();
      if (!Number.isSafeInteger(claimed.createdAt) || claimed.createdAt < 0 ||
          currentTime < claimed.createdAt ||
          !Number.isSafeInteger(claimed.replayDeadline) ||
          claimed.replayDeadline! <= claimed.createdAt ||
          claimed.replayDeadline! - claimed.createdAt > noReferenceReplayWindowMs ||
          currentTime >= claimed.replayDeadline!) {
        throw new DacsError("ap2-provider-replay-window-expired");
      }
    },
  });

  // Recovery consumes the store-retained operation itself, after exact comparison.
  const retained = JSON.parse(claimed.intent.operationJson) as { checkoutMandate: unknown; paymentMandate: unknown; metadata: Record<string, string> };
  intent = snapshotArtifact(claimed.intent, "retained intent");
  let providerRef = claimed.providerRef;
  if (!providerRef) {
    try {
      await fence.assertSubmissionAllowed();
    } catch (error) {
      return { status: "indeterminate", reason: error instanceof Error && error.message === "ap2-provider-replay-window-expired"
        ? error.message : "ap2-effect-fence-stale" };
    }
    let submitted: Ap2ProviderSubmission;
    try {
      submitted = await submitProviderPayment({
        intent,
        checkoutMandate: deepFreeze(retained.checkoutMandate),
        paymentMandate: deepFreeze(retained.paymentMandate),
        metadata: deepFreeze(retained.metadata),
        idempotencyKey: intent.idempotencyKey,
        fence,
      });
    } catch {
      return { status: "indeterminate", reason: "ap2-provider-submission-unavailable" };
    }
    try {
      await fence.assertCurrent();
    } catch {
      return { status: "indeterminate", reason: "ap2-effect-fence-stale" };
    }
    if (submitted.disposition === "indeterminate") {
      return { status: "indeterminate", reason: submitted.reason };
    }
    if (submitted.disposition === "declined") {
      let write: Ap2BindingWrite;
      try {
        write = await recordFailure({
          transactionId: intent.transactionId,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          reason: submitted.reason,
        });
      } catch {
        return { status: "indeterminate", reason: "ap2-failure-persistence-uncertain" };
      }
      return write.status === "recorded" || write.status === "existing"
        ? { status: "failed", reason: submitted.reason }
        : { status: "indeterminate", reason: "ap2-failure-persistence-uncertain" };
    }
    try {
      providerRef = requireString(submitted.providerRef, "providerRef");
    } catch {
      return { status: "indeterminate", reason: "ap2-provider-reference-invalid" };
    }
    let persisted: Ap2BindingWrite;
    try {
      persisted = await recordProviderRef({
        transactionId: intent.transactionId,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        providerRef,
      });
    } catch {
      return { status: "indeterminate", reason: "ap2-provider-reference-persistence-uncertain" };
    }
    if (persisted.status !== "recorded" && persisted.status !== "existing") {
      return { status: "indeterminate", reason: "ap2-provider-reference-persistence-uncertain" };
    }
  }

  try {
    await fence.assertCurrent();
  } catch {
    return { status: "indeterminate", reason: "ap2-effect-fence-stale" };
  }
  let status: Ap2AttestedProviderStatus;
  try {
    status = await readAttestedStatus({ intent, providerRef, fence });
  } catch {
    return { status: "indeterminate", reason: "ap2-attested-status-unavailable" };
  }
  try {
    await fence.assertCurrent();
  } catch {
    return { status: "indeterminate", reason: "ap2-effect-fence-stale" };
  }
  if (status.disposition === "pending") {
    return { status: "waiting", reason: status.reason };
  }
  if (status.disposition === "indeterminate") {
    return { status: "indeterminate", reason: status.reason };
  }
  if (status.disposition === "terminal-not-captured") {
    let write: Ap2BindingWrite;
    try {
      write = await recordFailure({
        transactionId: intent.transactionId,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        reason: status.reason,
      });
    } catch {
      return { status: "indeterminate", reason: "ap2-failure-persistence-uncertain" };
    }
    return write.status === "recorded" || write.status === "existing"
      ? { status: "failed", reason: status.reason }
      : { status: "indeterminate", reason: "ap2-failure-persistence-uncertain" };
  }

  let statusAmount: string | undefined;
  try {
    statusAmount = assertPositiveAmount(status.amount);
  } catch {
    statusAmount = undefined;
  }
  if (
    status.providerRef !== providerRef ||
    status.payee !== intent.payee ||
    statusAmount !== intent.amount ||
    status.currency !== intent.currency ||
    status.metadata === null || typeof status.metadata !== "object" ||
    status.metadata.dacs_job_id !== intent.jobId ||
    status.metadata.dacs_agreement_hash !== intent.agreementHash ||
    !validAttestation(status.receiptAttestation) ||
    (status.receiptTransactionRef !== undefined &&
      !validReceiptTransactionRef(status.receiptTransactionRef)) ||
    !Number.isSafeInteger(status.capturedAt) ||
    status.capturedAt < 0
  ) {
    return { status: "failed", reason: "ap2-attested-status-mismatch" };
  }

  const settlement: Ap2CapturedSettlement = Object.freeze({
    providerRef,
    mandateId: intent.mandateId,
    protocolVersion: intent.protocolVersion,
    receiptAttestation: snapshotArtifact(
      status.receiptAttestation,
      "receiptAttestation",
    ),
    ...(status.receiptTransactionRef === undefined
      ? {}
      : {
          receiptTransactionRef: snapshotArtifact(
            status.receiptTransactionRef,
            "receiptTransactionRef",
          ),
        }),
    payee: intent.payee,
    amount: intent.amount,
    currency: intent.currency,
    capturedAt: status.capturedAt,
  });
  let recorded: Ap2BindingWrite;
  try {
    recorded = await recordSettlement({
      transactionId: intent.transactionId,
      bindingHash: intent.bindingHash,
      owner: fence.owner,
      generation: fence.generation,
      settlement,
    });
  } catch {
    return { status: "indeterminate", reason: "ap2-settlement-persistence-uncertain" };
  }
  return recorded.status === "recorded" || recorded.status === "existing"
    ? { status: "settled", settlement }
    : { status: "indeterminate", reason: "ap2-settlement-persistence-uncertain" };
}

interface MemoryAp2Record {
  intent: Ap2SettlementIntent;
  lease: Ap2BindingLease;
  createdAt: number;
  replayDeadline?: number;
  providerRef?: string;
  settlement?: Ap2CapturedSettlement;
  failure?: string;
}

/** Test/development store; production callers must provide durable storage. */
export function createInMemoryAp2BindingStore(): Ap2BindingStore {
  const records = new Map<string, MemoryAp2Record>();
  // AP2-6 key, i.e. (jobId, phaseIndex), -> the first transaction_id bound to it.
  const phases = new Map<string, string>();
  const current = (
    record: MemoryAp2Record | undefined,
    input: { bindingHash: string; owner: string; generation: number },
  ): record is MemoryAp2Record =>
    record !== undefined &&
    record.intent.bindingHash === input.bindingHash &&
    record.lease.owner === input.owner &&
    record.lease.generation === input.generation;

  return {
    async claim(input) {
      const existing = records.get(input.intent.transactionId);
      if (existing) {
        if (existing.intent.intentVersion !== "2" || existing.intent.operationHash !== sha256Hex(existing.intent.operationJson) ||
            existing.intent.bindingHash !== input.intent.bindingHash) {
          return { status: "conflict", reason: ap2BindingConflictReason(existing.intent, input.intent) };
        }
        if (existing.settlement) {
          return { status: "settled", intent: existing.intent, settlement: existing.settlement };
        }
        if (existing.failure) {
          return { status: "failed", intent: existing.intent, reason: existing.failure };
        }
        if (existing.lease.expiresAt > input.now) {
          return {
            status: "waiting",
            intent: existing.intent,
            lease: { ...existing.lease },
            createdAt: existing.createdAt,
            ...(existing.replayDeadline === undefined ? {} : { replayDeadline: existing.replayDeadline }),
            ...(existing.providerRef ? { providerRef: existing.providerRef } : {}),
          };
        }
        existing.lease = {
          owner: input.owner,
          generation: existing.lease.generation + 1,
          expiresAt: input.now + input.leaseDurationMs,
        };
        return {
          status: "acquired",
          intent: existing.intent,
          lease: { ...existing.lease },
          createdAt: existing.createdAt,
          ...(existing.replayDeadline === undefined ? {} : { replayDeadline: existing.replayDeadline }),
          ...(existing.providerRef ? { providerRef: existing.providerRef } : {}),
        };
      }
      let phase: string;
      try {
        phase = deriveAp2IdempotencyKey(input.intent.jobId, input.intent.phaseIndex);
      } catch {
        return { status: "corrupt", reason: "ap2-binding-claim-input-invalid" };
      }
      if (input.intent.idempotencyKey !== phase) {
        return { status: "corrupt", reason: "ap2-binding-claim-input-invalid" };
      }
      const bound = phases.get(phase);
      if (bound !== undefined && bound !== input.intent.transactionId) {
        return { status: "conflict", reason: AP2_PHASE_BOUND_ELSEWHERE };
      }
      phases.set(phase, input.intent.transactionId);
      const record: MemoryAp2Record = {
        intent: Object.freeze({ ...input.intent }),
        createdAt: input.now,
        ...(input.noReferenceReplayWindowMs === undefined ? {} : { replayDeadline: input.now + input.noReferenceReplayWindowMs }),
        lease: {
          owner: input.owner,
          generation: 1,
          expiresAt: input.now + input.leaseDurationMs,
        },
      };
      records.set(input.intent.transactionId, record);
      return {
        status: "acquired",
        intent: record.intent,
        lease: { ...record.lease },
        createdAt: record.createdAt,
        ...(record.replayDeadline === undefined ? {} : { replayDeadline: record.replayDeadline }),
      };
    },
    async isCurrent(input) {
      const record = records.get(input.transactionId);
      return current(record, input) && record.lease.expiresAt > input.now &&
        !record.settlement && !record.failure;
    },
    async recordProviderRef(input) {
      const record = records.get(input.transactionId);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (record.providerRef && record.providerRef !== input.providerRef) {
        return { status: "conflict", reason: "provider-reference-conflict" };
      }
      const status = record.providerRef ? "existing" as const : "recorded" as const;
      record.providerRef ??= input.providerRef;
      return { status };
    },
    async recordSettlement(input) {
      const record = records.get(input.transactionId);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (record.failure) return { status: "conflict", reason: "terminal-failure-exists" };
      if (!record.providerRef || record.providerRef !== input.settlement.providerRef) {
        return { status: "conflict", reason: "provider-reference-not-bound" };
      }
      if (record.settlement) {
        return canonicalize(record.settlement) === canonicalize(input.settlement)
          ? { status: "existing" }
          : { status: "conflict", reason: "settlement-conflict" };
      }
      record.settlement = Object.freeze({ ...input.settlement });
      return { status: "recorded" };
    },
    async recordFailure(input) {
      const record = records.get(input.transactionId);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (record.settlement) return { status: "conflict", reason: "settlement-exists" };
      if (record.failure && record.failure !== input.reason) {
        return { status: "conflict", reason: "failure-conflict" };
      }
      const status = record.failure ? "existing" as const : "recorded" as const;
      record.failure ??= input.reason;
      return { status };
    },
  };
}
