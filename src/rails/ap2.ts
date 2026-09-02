import { createHash } from "node:crypto";

import {
  assertPositiveAmount,
  canonicalize,
  sha256Hex,
} from "../canonical/index.js";
import { DacsError } from "../errors.js";
import type { AttestationRef } from "../artifacts/types.js";

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

export type Ap2BindingState = "in-flight" | "settled" | "failed";

export interface Ap2TransactionBinding {
  transactionId: string;
  jobId: string;
  phaseIndex: number;
  state: Ap2BindingState;
}

export type Ap2TransactionBindingDecision =
  | { decision: "pass"; action: "bind-new"; submitNewPayment: true }
  | {
      decision: "pass";
      action: "resume-existing" | "resume-settlement";
      submitNewPayment: false;
    }
  | { decision: "fail"; action: "reject-replay"; submitNewPayment: false }
  | { decision: "error"; action: "refuse-conflict"; submitNewPayment: false };

/** AP2-6 byte-exact provider idempotency key. */
export function deriveAp2IdempotencyKey(
  jobId: string,
  phaseIndex: number,
): string {
  if (typeof jobId !== "string" || jobId.length === 0) {
    throw new DacsError("pay-ap2: jobId must be a non-empty string");
  }
  if (!Number.isSafeInteger(phaseIndex) || phaseIndex < 0) {
    throw new DacsError("pay-ap2: phaseIndex must be a non-negative safe integer");
  }
  return sha256Hex(
    `dacs-ap2-idem:v1:${jobId.normalize("NFC")}:${phaseIndex}`,
  );
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

/** AP2-7 replay decision over an authenticated atomic-store snapshot. */
export function evaluateAp2TransactionBinding(input: {
  transactionId: string;
  jobId: string;
  phaseIndex: number;
  priorBindings: readonly Ap2TransactionBinding[];
}): Ap2TransactionBindingDecision {
  if (input.priorBindings.length === 0) {
    return { decision: "pass", action: "bind-new", submitNewPayment: true };
  }
  if (input.priorBindings.length !== 1) {
    return {
      decision: "error",
      action: "refuse-conflict",
      submitNewPayment: false,
    };
  }
  const prior = input.priorBindings[0]!;
  if (
    prior.transactionId !== input.transactionId ||
    prior.jobId !== input.jobId ||
    prior.phaseIndex !== input.phaseIndex
  ) {
    return {
      decision: "fail",
      action: "reject-replay",
      submitNewPayment: false,
    };
  }
  return prior.state === "settled"
    ? {
        decision: "pass",
        action: "resume-settlement",
        submitNewPayment: false,
      }
    : {
        decision: "pass",
        action: "resume-existing",
        submitNewPayment: false,
      };
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
  intentVersion: "1";
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
  | { status: "acquired"; intent: Readonly<Ap2SettlementIntent>; lease: Ap2BindingLease; providerRef?: string }
  | { status: "waiting"; intent: Readonly<Ap2SettlementIntent>; lease: Ap2BindingLease; providerRef?: string }
  | { status: "settled"; intent: Readonly<Ap2SettlementIntent>; settlement: Readonly<Ap2CapturedSettlement> }
  | { status: "failed"; intent: Readonly<Ap2SettlementIntent>; reason: string }
  | { status: "conflict" | "corrupt"; reason: string };

export type Ap2BindingWrite =
  | { status: "recorded" | "existing" }
  | { status: "stale" | "conflict" | "corrupt"; reason: string };

/** Atomic durable store. Production implementations must persist this state. */
export interface Ap2BindingStore {
  claim(input: {
    intent: Readonly<Ap2SettlementIntent>;
    owner: string;
    now: number;
    leaseDurationMs: number;
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

function intentFrom(input: {
  jobId: string;
  phaseIndex: number;
  agreementHash: string;
  protocolVersion: string;
  verifiedPayment: Readonly<Ap2VerifiedPaymentMandate>;
}): Ap2SettlementIntent {
  const amount = assertPositiveAmount(input.verifiedPayment.amount);
  if (!HASH_RE.test(input.agreementHash)) {
    throw new DacsError("pay-ap2: agreementHash must be 32-byte lower-case hex");
  }
  const unsigned = {
    intentVersion: "1" as const,
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

/**
 * Restart-safe AP2 settlement. Ambiguous submission never authorizes a fresh
 * charge: recovery reuses the AP2-6 key, while the provider must deduplicate it.
 */
export async function advanceAp2Settlement<TCheckout, TPayment>(
  input: AdvanceAp2SettlementInput<TCheckout, TPayment>,
): Promise<Ap2SettlementProgress> {
  const provider = input.provider;
  const verifier = input.verifier;
  const store = input.store;
  const now = input.now ?? Date.now;
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_MS;
  const authority = Object.freeze({
    jobId: input.jobId,
    phaseIndex: input.phaseIndex,
    agreementHash: input.agreementHash,
    protocolVersion: input.protocolVersion,
    expected: Object.freeze({ ...input.expected }),
    owner: input.owner,
  });

  if (ap2RegistrationEligibility(provider.capabilities) !== "pass") {
    return { status: "failed", reason: "ap2-provider-registration-ineligible" };
  }

  let checkoutArtifact: Readonly<TCheckout>;
  let paymentArtifact: Readonly<TPayment>;
  let checkout: Ap2MandateVerification<Ap2VerifiedCheckoutMandate>;
  let payment: Ap2MandateVerification<Ap2VerifiedPaymentMandate>;
  try {
    checkoutArtifact = snapshotArtifact(input.checkoutMandate, "CheckoutMandate");
    paymentArtifact = snapshotArtifact(input.paymentMandate, "PaymentMandate");
    [checkout, payment] = await Promise.all([
      verifier.verifyCheckoutMandate(checkoutArtifact),
      verifier.verifyPaymentMandate(paymentArtifact),
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
    intent = intentFrom({
      jobId: authority.jobId,
      phaseIndex: authority.phaseIndex,
      agreementHash: authority.agreementHash,
      protocolVersion: authority.protocolVersion,
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

  const claimed = await store.claim({
    intent,
    owner: requireString(authority.owner, "owner"),
    now: now(),
    leaseDurationMs,
  });
  if (claimed.status === "waiting") {
    return { status: "waiting", reason: "ap2-binding-held" };
  }
  if (claimed.status === "settled") {
    return { status: "settled", settlement: claimed.settlement };
  }
  if (claimed.status === "failed") {
    return { status: "failed", reason: claimed.reason };
  }
  if (claimed.status !== "acquired") {
    return { status: "failed", reason: claimed.reason };
  }

  const fence: Ap2EffectFence = Object.freeze({
    transactionId: intent.transactionId,
    bindingHash: intent.bindingHash,
    owner: claimed.lease.owner,
    generation: claimed.lease.generation,
    idempotencyKey: intent.idempotencyKey,
    assertCurrent: async () => {
      if (!await store.isCurrent({
        transactionId: intent.transactionId,
        bindingHash: intent.bindingHash,
        owner: claimed.lease.owner,
        generation: claimed.lease.generation,
        now: now(),
      })) {
        throw new DacsError("pay-ap2: stale effect fence");
      }
    },
  });

  let providerRef = claimed.providerRef;
  if (!providerRef) {
    try {
      await fence.assertCurrent();
    } catch {
      return { status: "indeterminate", reason: "ap2-effect-fence-stale" };
    }
    let submitted: Ap2ProviderSubmission;
    try {
      submitted = await provider.submit({
        intent,
        checkoutMandate: checkoutArtifact,
        paymentMandate: paymentArtifact,
        metadata: Object.freeze({
          dacs_job_id: intent.jobId,
          dacs_agreement_hash: intent.agreementHash,
        }),
        idempotencyKey: intent.idempotencyKey,
        fence,
      });
    } catch {
      return { status: "indeterminate", reason: "ap2-provider-submission-unavailable" };
    }
    if (submitted.disposition === "indeterminate") {
      return { status: "indeterminate", reason: submitted.reason };
    }
    if (submitted.disposition === "declined") {
      const write = await store.recordFailure({
        transactionId: intent.transactionId,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        reason: submitted.reason,
      });
      return write.status === "recorded" || write.status === "existing"
        ? { status: "failed", reason: submitted.reason }
        : { status: "indeterminate", reason: "ap2-failure-persistence-uncertain" };
    }
    providerRef = requireString(submitted.providerRef, "providerRef");
    const persisted = await store.recordProviderRef({
      transactionId: intent.transactionId,
      bindingHash: intent.bindingHash,
      owner: fence.owner,
      generation: fence.generation,
      providerRef,
    });
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
    status = await provider.readAttestedStatus({ intent, providerRef, fence });
  } catch {
    return { status: "indeterminate", reason: "ap2-attested-status-unavailable" };
  }
  if (status.disposition === "pending") {
    return { status: "waiting", reason: status.reason };
  }
  if (status.disposition === "indeterminate") {
    return { status: "indeterminate", reason: status.reason };
  }
  if (status.disposition === "terminal-not-captured") {
    const write = await store.recordFailure({
      transactionId: intent.transactionId,
      bindingHash: intent.bindingHash,
      owner: fence.owner,
      generation: fence.generation,
      reason: status.reason,
    });
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
  const recorded = await store.recordSettlement({
    transactionId: intent.transactionId,
    bindingHash: intent.bindingHash,
    owner: fence.owner,
    generation: fence.generation,
    settlement,
  });
  return recorded.status === "recorded" || recorded.status === "existing"
    ? { status: "settled", settlement }
    : { status: "indeterminate", reason: "ap2-settlement-persistence-uncertain" };
}

interface MemoryAp2Record {
  intent: Ap2SettlementIntent;
  lease: Ap2BindingLease;
  providerRef?: string;
  settlement?: Ap2CapturedSettlement;
  failure?: string;
}

/** Test/development store; production callers must provide durable storage. */
export function createInMemoryAp2BindingStore(): Ap2BindingStore {
  const records = new Map<string, MemoryAp2Record>();
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
        if (existing.intent.bindingHash !== input.intent.bindingHash) {
          return { status: "conflict", reason: "ap2-transaction-id-replay" };
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
          ...(existing.providerRef ? { providerRef: existing.providerRef } : {}),
        };
      }
      const record: MemoryAp2Record = {
        intent: Object.freeze({ ...input.intent }),
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
