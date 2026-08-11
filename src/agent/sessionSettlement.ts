import {
  canonicalize,
  contentHash,
  sha256Hex,
} from "../canonical/index.js";
import type {
  AnchorReceipt,
  AttestationRef,
  PaymentAmount,
  PaymentPhaseType,
  SettlementEvidence,
  SettlementFinality,
  SettlementFinalityModel,
} from "../artifacts/types.js";
import {
  isAnchorReceipt,
  isAttestationRef,
  isSettlementEvidence,
} from "../artifacts/validators.js";
import {
  verifySettlementEvidence,
  type EvidenceDeps,
} from "./verifySettlementEvidence.js";

/** Four-valued trust-boundary decision used by settlement providers. */
export type SessionSettlementDisposition =
  | { disposition: "pass" }
  | {
      disposition: "fail" | "error" | "indeterminate";
      reason: string;
    };

/** Authenticated SB-1 binding recovered from the native settlement. */
export interface SessionSettlementIdentityBinding {
  jobId: string;
  railId: string;
  phaseIndex: number;
  settlementId: string;
}

/** Native verification must return facts, never only a boolean assertion. */
export type SessionSettlementRevalidation =
  | {
      disposition: "pass";
      binding: SessionSettlementIdentityBinding;
    }
  | {
      disposition: "fail" | "error" | "indeterminate";
      reason: string;
    };

/** Stable ownership offered to the atomic SB-2 identity store. */
export interface SessionSettlementIdentityClaimInput {
  binding: SessionSettlementIdentityBinding;
  ownerHash: string;
}

/** Exact result of atomically binding or recovering one settlement identity. */
export type SessionSettlementIdentityClaim =
  | {
      disposition: "pass";
      ownership: "bound" | "existing";
      binding: SessionSettlementIdentityBinding;
      ownerHash: string;
    }
  | {
      disposition: "fail" | "error" | "indeterminate";
      reason: string;
    };

/** Exact finality policy retained from the authenticated rail descriptor. */
export type SessionSettlementFinalityPolicy =
  | { model: "block-depth"; finalityBlocks: number }
  | {
      model: "commitment-level";
      finalityCommitmentLevel: "processed" | "confirmed" | "finalized";
    }
  | {
      model: Exclude<
        SettlementFinalityModel,
        "block-depth" | "commitment-level"
      >;
    };

/**
 * Immutable, authenticated registry pin that controls settlement verification.
 * This is operational session state, not a new DACS wire artifact.
 */
export interface SessionSettlementRailPin {
  railId: string;
  railRegistryVersion: number;
  descriptorHash: string;
  railType: string;
  handler: PaymentPhaseType;
  asset: string;
  network: string;
  finality: SessionSettlementFinalityPolicy;
}

/** Exact deal/session facts against which native payment evidence is checked. */
export interface SessionSettlementContext {
  contextVersion: "1";
  jobId: string;
  agreementRef: AttestationRef;
  agreementHash: string;
  paymentPhaseIndex: number;
  orchestrator: string;
  payer: {
    primaryClaim: string;
    payingKey: string;
  };
  payee: {
    primaryClaim: string;
    receivingKey: string;
  };
  paymentAmount: PaymentAmount;
  rail: SessionSettlementRailPin;
}

/**
 * Content-addressed operational proof. Raw x402 headers and chain observation
 * details stay behind this reference and never extend the closed ChainTxRef.
 */
export interface SessionSettlementNativeProofRef {
  proofVersion: "1";
  kind: string;
  locator: string;
  contentHash: string;
  encoding: "jcs" | "bytes";
}

/** Finalized signed evidence plus its independently authenticated publication. */
export interface FinalizedSessionSettlement {
  settlementVersion: "1";
  outcome: "success" | "failure";
  evidence: SettlementEvidence;
  evidenceRef: AttestationRef;
  anchorReceipt: AnchorReceipt;
  nativeProofRef: SessionSettlementNativeProofRef;
}

export type SessionSettlementNativeProofLookup =
  | { disposition: "present"; artifact: Record<string, unknown>; bytes?: never }
  | { disposition: "present"; bytes: Uint8Array; artifact?: never }
  | { disposition: "absent" }
  | { disposition: "indeterminate"; reason: string };

export interface SessionSettlementVerificationProvider {
  /**
   * Callbacks are captured from own data descriptors and invoked with a frozen,
   * inert receiver. Implementations that need instance state must pre-bind it.
   */
  /** Authenticate the agreement, parties, phase, and exact steward registry pin. */
  authenticateContext: (
    context: Readonly<SessionSettlementContext>,
  ) => Promise<SessionSettlementDisposition> | SessionSettlementDisposition;
  /** Cryptographically authenticate the evidence's finalized SR-2 publication. */
  verifyEvidenceAnchor: (input: {
    context: Readonly<SessionSettlementContext>;
    evidence: Readonly<SettlementEvidence>;
    evidenceRef: Readonly<AttestationRef>;
    anchorReceipt: Readonly<AnchorReceipt>;
  }) => Promise<SessionSettlementDisposition> | SessionSettlementDisposition;
  /** Resolve the exact native proof bytes/value by its content-addressed ref. */
  resolveNativeProof: (
    proofRef: Readonly<SessionSettlementNativeProofRef>,
  ) =>
    | Promise<SessionSettlementNativeProofLookup>
    | SessionSettlementNativeProofLookup;
  /**
   * Re-observe native settlement truth under the authenticated context. This
   * runs on both initial admission and recovery; a cached finality verdict is
   * never sufficient after a possible reorg or provider ambiguity.
   */
  revalidateSettlement: (input: {
    mode: "initial" | "recovery";
    context: Readonly<SessionSettlementContext>;
    evidence: Readonly<SettlementEvidence>;
    nativeProofRef: Readonly<SessionSettlementNativeProofRef>;
    nativeProof: Readonly<Record<string, unknown>> | Uint8Array;
  }) => Promise<SessionSettlementRevalidation> | SessionSettlementRevalidation;
  /**
   * Atomically bind an SB-1 settlement id to its complete stable owner. A
   * durable implementation returns `existing` only for the exact prior input;
   * reuse by another job, rail, phase, or owner hash is a definite failure.
   */
  claimSettlementIdentity: (
    input: Readonly<SessionSettlementIdentityClaimInput>,
  ) => Promise<SessionSettlementIdentityClaim> | SessionSettlementIdentityClaim;
  /** Required key/signature implementation for the normative evidence verifier. */
  evidence: Required<Pick<EvidenceDeps, "resolvePublicKey" | "verify">>;
}

/** Owned verification result; hashes fit the primitive-only durable checkpoint. */
export interface VerifiedSessionSettlement {
  state: "verified";
  mode: "initial" | "recovery";
  outcome: "success" | "failure";
  contextHash: string;
  evidenceHash: string;
  nativeProofHash: string;
  /** Stable across refreshed proof observations of the same publication. */
  identityHash: string;
  /** Binds this exact initial/recovery observation and its claim disposition. */
  observationHash: string;
  settlementBinding: SessionSettlementIdentityBinding;
  settlementOwnership: "bound" | "existing";
  settlement: FinalizedSessionSettlement;
}

export type SessionSettlementVerification =
  | { disposition: "verified"; value: VerifiedSessionSettlement }
  | {
      disposition: "rejected" | "error" | "indeterminate";
      reason: string;
    };

const PAYMENT_PHASES = new Set<PaymentPhaseType>([
  "pay-evm-erc20",
  "pay-solana-spl",
  "pay-cross-chain-htlc",
  "pay-cross-chain-liquidity-tank",
  "pay-ap2",
  "pay-x402",
  "pay-dem",
]);

const FINALITY_MODELS = new Set<SettlementFinalityModel>([
  "block-depth",
  "commitment-level",
  "provider-receipt",
  "htlc-reveal",
  "liquidity-tank",
  "bft-final",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isUint = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  (value as number) >= 0 &&
  !Object.is(value, -0);
const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isCanonicalSettlementId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (/^demos:[0-9a-f]{64}$/.test(value)) return true;
  const match = /^evm:([1-9][0-9]*):([0-9a-f]{64}):(0|[1-9][0-9]*)$/.exec(
    value,
  );
  if (!match) return false;
  const chainId = Number(match[1]);
  const logIndex = Number(match[3]);
  return Number.isSafeInteger(chainId) && chainId > 0 &&
    Number.isSafeInteger(logIndex) && logIndex >= 0;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    optional.every((key) => !hasOwn(value, key) || value[key] !== undefined);
}

/** Reject accessors, exotic prototypes, lossy numbers, symbols, and undefined. */
function exactJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) return true;
  if (typeof value === "number") {
    return Number.isFinite(value) && !Object.is(value, -0);
  }
  if (typeof value !== "object" || value === undefined) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable ||
            !exactJsonValue(descriptor.value, seen)) return false;
      }
      return Reflect.ownKeys(descriptors).every(
        (key) => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key),
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Reflect.ownKeys(descriptors).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      return !!descriptor && descriptor.enumerable && !descriptor.get && !descriptor.set &&
        descriptor.value !== undefined && exactJsonValue(descriptor.value, seen);
    });
  } catch {
    return false;
  }
}

function ownedJson<T>(value: T): T | null {
  if (!exactJsonValue(value)) return null;
  try {
    return deepFreeze(structuredClone(value));
  } catch {
    return null;
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function isPaymentAmount(value: unknown): value is PaymentAmount {
  if (!isRecord(value) || !exactKeys(value, ["amount", "currency"], ["unit"])) {
    return false;
  }
  return isNonEmpty(value.amount) && isNonEmpty(value.currency) &&
    (value.unit === undefined || isNonEmpty(value.unit));
}

function isFinalityPolicy(value: unknown): value is SessionSettlementFinalityPolicy {
  if (!isRecord(value) || !isNonEmpty(value.model) ||
      !FINALITY_MODELS.has(value.model as SettlementFinalityModel)) return false;
  if (value.model === "block-depth") {
    return exactKeys(value, ["model", "finalityBlocks"]) &&
      isUint(value.finalityBlocks) && value.finalityBlocks > 0;
  }
  if (value.model === "commitment-level") {
    return exactKeys(value, ["model", "finalityCommitmentLevel"]) &&
      ["processed", "confirmed", "finalized"].includes(
        String(value.finalityCommitmentLevel),
      );
  }
  return exactKeys(value, ["model"]);
}

function isRailPin(value: unknown): value is SessionSettlementRailPin {
  return isRecord(value) && exactKeys(value, [
    "railId",
    "railRegistryVersion",
    "descriptorHash",
    "railType",
    "handler",
    "asset",
    "network",
    "finality",
  ]) &&
    isNonEmpty(value.railId) && isUint(value.railRegistryVersion) &&
    value.railRegistryVersion > 0 && isHash(value.descriptorHash) &&
    isNonEmpty(value.railType) && PAYMENT_PHASES.has(value.handler as PaymentPhaseType) &&
    isNonEmpty(value.asset) && isNonEmpty(value.network) &&
    isFinalityPolicy(value.finality);
}

function isPartyBinding(value: unknown, key: "payingKey" | "receivingKey"): boolean {
  return isRecord(value) && exactKeys(value, ["primaryClaim", key]) &&
    isNonEmpty(value.primaryClaim) && isNonEmpty(value[key]);
}

function isContext(value: unknown): value is SessionSettlementContext {
  return isRecord(value) && exactKeys(value, [
    "contextVersion",
    "jobId",
    "agreementRef",
    "agreementHash",
    "paymentPhaseIndex",
    "orchestrator",
    "payer",
    "payee",
    "paymentAmount",
    "rail",
  ]) && value.contextVersion === "1" && isNonEmpty(value.jobId) &&
    isAttestationRef(value.agreementRef) && isHash(value.agreementHash) &&
    value.agreementRef.contentHash === value.agreementHash &&
    isUint(value.paymentPhaseIndex) && isNonEmpty(value.orchestrator) &&
    isPartyBinding(value.payer, "payingKey") &&
    isPartyBinding(value.payee, "receivingKey") &&
    isPaymentAmount(value.paymentAmount) && isRailPin(value.rail);
}

function isIdentityBinding(
  value: unknown,
): value is SessionSettlementIdentityBinding {
  return isRecord(value) && exactKeys(value, [
    "jobId",
    "railId",
    "phaseIndex",
    "settlementId",
  ]) && isNonEmpty(value.jobId) && isNonEmpty(value.railId) &&
    isUint(value.phaseIndex) && isCanonicalSettlementId(value.settlementId);
}

function bindingMatchesContext(
  binding: SessionSettlementIdentityBinding,
  context: SessionSettlementContext,
): boolean {
  return binding.jobId === context.jobId &&
    binding.railId === context.rail.railId &&
    binding.phaseIndex === context.paymentPhaseIndex;
}

function anchorPublicationIdentity(
  receipt: AnchorReceipt,
): Record<string, unknown> {
  return {
    receiptVersion: receipt.receiptVersion,
    substrate: receipt.substrate,
    logicalAddress: receipt.logicalAddress,
    nativeAddress: receipt.nativeAddress,
    contentHash: receipt.contentHash,
    transactionRef: receipt.transactionRef,
    writer: receipt.writer,
    ...(receipt.nonce === undefined ? {} : { nonce: receipt.nonce }),
  };
}

function sameBinding(
  left: SessionSettlementIdentityBinding,
  right: SessionSettlementIdentityBinding,
): boolean {
  return left.jobId === right.jobId && left.railId === right.railId &&
    left.phaseIndex === right.phaseIndex &&
    left.settlementId === right.settlementId;
}

function isProofRef(value: unknown): value is SessionSettlementNativeProofRef {
  return isRecord(value) && exactKeys(value, [
    "proofVersion",
    "kind",
    "locator",
    "contentHash",
    "encoding",
  ]) && value.proofVersion === "1" && isNonEmpty(value.kind) &&
    isNonEmpty(value.locator) && isHash(value.contentHash) &&
    (value.encoding === "jcs" || value.encoding === "bytes");
}

function isFinalizedSettlement(value: unknown): value is FinalizedSessionSettlement {
  return isRecord(value) && exactKeys(value, [
    "settlementVersion",
    "outcome",
    "evidence",
    "evidenceRef",
    "anchorReceipt",
    "nativeProofRef",
  ]) && value.settlementVersion === "1" &&
    (value.outcome === "success" || value.outcome === "failure") &&
    isSettlementEvidence(value.evidence) && isAttestationRef(value.evidenceRef) &&
    isAnchorReceipt(value.anchorReceipt) && isProofRef(value.nativeProofRef);
}

function finalityMatchesPolicy(
  finality: SettlementFinality,
  policy: SessionSettlementFinalityPolicy,
): boolean {
  if (finality.model !== policy.model) return false;
  if (policy.model === "block-depth") {
    return finality.model === "block-depth" &&
      finality.finalityBlocks === policy.finalityBlocks;
  }
  if (policy.model === "commitment-level") {
    return finality.model === "commitment-level" &&
      finality.finalityCommitmentLevel === policy.finalityCommitmentLevel;
  }
  return true;
}

function contextMatchesEvidence(
  context: SessionSettlementContext,
  settlement: FinalizedSessionSettlement,
): string | null {
  const evidence = settlement.evidence;
  if (evidence.jobId !== context.jobId) return "settlement evidence jobId mismatch";
  if (evidence.phase !== context.rail.handler) return "settlement evidence phase mismatch";
  if (evidence.outcome !== settlement.outcome) return "settlement outcome mismatch";
  if (evidence.outcome === "success") {
    if (evidence.paymentAmount.amount !== context.paymentAmount.amount ||
        evidence.paymentAmount.currency !== context.paymentAmount.currency ||
        evidence.paymentAmount.unit !== context.paymentAmount.unit) {
      return "settlement payment amount mismatch";
    }
    if (!finalityMatchesPolicy(evidence.settlementFinality, context.rail.finality)) {
      return "settlement finality does not match the authenticated rail pin";
    }
  }
  const evidenceHash = contentHash(evidence as unknown as Record<string, unknown>);
  if (settlement.evidenceRef.contentHash !== evidenceHash ||
      settlement.anchorReceipt.contentHash !== evidenceHash) {
    return "settlement evidence reference/receipt hash mismatch";
  }
  if (settlement.anchorReceipt.writer !== context.orchestrator ||
      settlement.anchorReceipt.logicalAddress !== settlement.evidenceRef.anchor.locator ||
      (settlement.evidenceRef.signer !== undefined &&
        settlement.evidenceRef.signer !== evidence.signature.signer) ||
      settlement.anchorReceipt.state !== "finalized" ||
      settlement.anchorReceipt.observationDisposition !== "established") {
    return "settlement evidence lacks an exact finalized orchestrator receipt";
  }
  return null;
}

function captureDisposition(value: unknown): SessionSettlementDisposition | null {
  const snapshot = ownedJson(value);
  if (!snapshot || !isRecord(snapshot) || !isNonEmpty(snapshot.disposition)) return null;
  if (snapshot.disposition === "pass" && exactKeys(snapshot, ["disposition"])) {
    return { disposition: "pass" };
  }
  if (
    ["fail", "error", "indeterminate"].includes(snapshot.disposition) &&
    exactKeys(snapshot, ["disposition", "reason"]) &&
    isNonEmpty(snapshot.reason)
  ) {
    return snapshot as SessionSettlementDisposition;
  }
  return null;
}

function captureRevalidation(
  value: unknown,
): SessionSettlementRevalidation | null {
  const snapshot = ownedJson(value);
  if (!snapshot || !isRecord(snapshot) || !isNonEmpty(snapshot.disposition)) {
    return null;
  }
  if (
    snapshot.disposition === "pass" &&
    exactKeys(snapshot, ["disposition", "binding"]) &&
    isIdentityBinding(snapshot.binding)
  ) {
    return snapshot as unknown as SessionSettlementRevalidation;
  }
  if (
    ["fail", "error", "indeterminate"].includes(snapshot.disposition) &&
    exactKeys(snapshot, ["disposition", "reason"]) &&
    isNonEmpty(snapshot.reason)
  ) {
    return snapshot as SessionSettlementRevalidation;
  }
  return null;
}

function captureIdentityClaim(
  value: unknown,
): SessionSettlementIdentityClaim | null {
  const snapshot = ownedJson(value);
  if (!snapshot || !isRecord(snapshot) || !isNonEmpty(snapshot.disposition)) {
    return null;
  }
  if (
    snapshot.disposition === "pass" &&
    exactKeys(snapshot, [
      "disposition",
      "ownership",
      "binding",
      "ownerHash",
    ]) &&
    (snapshot.ownership === "bound" || snapshot.ownership === "existing") &&
    isIdentityBinding(snapshot.binding) &&
    isHash(snapshot.ownerHash)
  ) {
    return snapshot as unknown as SessionSettlementIdentityClaim;
  }
  if (
    ["fail", "error", "indeterminate"].includes(snapshot.disposition) &&
    exactKeys(snapshot, ["disposition", "reason"]) &&
    isNonEmpty(snapshot.reason)
  ) {
    return snapshot as SessionSettlementIdentityClaim;
  }
  return null;
}

function rejected(
  disposition: Exclude<SessionSettlementVerification["disposition"], "verified">,
  reason: string,
): SessionSettlementVerification {
  return { disposition, reason };
}

function mapTrustDisposition(
  value: SessionSettlementDisposition,
  subject: string,
): SessionSettlementVerification | null {
  if (value.disposition === "pass") return null;
  return rejected(
    value.disposition === "fail" ? "rejected" : value.disposition,
    `${subject}: ${value.reason}`,
  );
}

const INERT_PROVIDER_RECEIVER = Object.freeze(Object.create(null)) as object;

function captureProvider(source: SessionSettlementVerificationProvider):
SessionSettlementVerificationProvider | null {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(source);
    const required = [
      "authenticateContext",
      "verifyEvidenceAnchor",
      "resolveNativeProof",
      "revalidateSettlement",
      "claimSettlementIdentity",
      "evidence",
    ];
    if (!required.every((key) => {
      const descriptor = descriptors[key];
      return !!descriptor && !descriptor.get && !descriptor.set &&
        typeof descriptor.value !== "undefined";
    })) return null;
    const evidence = descriptors.evidence!.value as unknown;
    if (!isRecord(evidence)) return null;
    const evidenceDescriptors = Object.getOwnPropertyDescriptors(evidence);
    if (
      typeof descriptors.authenticateContext?.value !== "function" ||
      typeof descriptors.verifyEvidenceAnchor?.value !== "function" ||
      typeof descriptors.resolveNativeProof?.value !== "function" ||
      typeof descriptors.revalidateSettlement?.value !== "function" ||
      typeof descriptors.claimSettlementIdentity?.value !== "function" ||
      typeof evidenceDescriptors.resolvePublicKey?.value !== "function" ||
      typeof evidenceDescriptors.verify?.value !== "function"
    ) return null;
    const authenticateContext = descriptors.authenticateContext.value as Function;
    const verifyEvidenceAnchor = descriptors.verifyEvidenceAnchor.value as Function;
    const resolveNativeProof = descriptors.resolveNativeProof.value as Function;
    const revalidateSettlement = descriptors.revalidateSettlement.value as Function;
    const claimSettlementIdentity =
      descriptors.claimSettlementIdentity.value as Function;
    const resolvePublicKey = evidenceDescriptors.resolvePublicKey.value as Function;
    const verify = evidenceDescriptors.verify.value as Function;
    return Object.freeze({
      authenticateContext: (context: Readonly<SessionSettlementContext>) =>
        Reflect.apply(authenticateContext, INERT_PROVIDER_RECEIVER, [context]),
      verifyEvidenceAnchor: (input: Parameters<
        SessionSettlementVerificationProvider["verifyEvidenceAnchor"]
      >[0]) => Reflect.apply(
        verifyEvidenceAnchor,
        INERT_PROVIDER_RECEIVER,
        [input],
      ),
      resolveNativeProof: (proofRef: Readonly<SessionSettlementNativeProofRef>) =>
        Reflect.apply(resolveNativeProof, INERT_PROVIDER_RECEIVER, [proofRef]),
      revalidateSettlement: (input: Parameters<
        SessionSettlementVerificationProvider["revalidateSettlement"]
      >[0]) => Reflect.apply(
        revalidateSettlement,
        INERT_PROVIDER_RECEIVER,
        [input],
      ),
      claimSettlementIdentity: (input: Readonly<
        SessionSettlementIdentityClaimInput
      >) => Reflect.apply(
        claimSettlementIdentity,
        INERT_PROVIDER_RECEIVER,
        [input],
      ),
      evidence: Object.freeze({
        resolvePublicKey: (signer: string) =>
          Reflect.apply(resolvePublicKey, INERT_PROVIDER_RECEIVER, [signer]),
        verify: (...args: Parameters<NonNullable<EvidenceDeps["verify"]>>) =>
          Reflect.apply(verify, INERT_PROVIDER_RECEIVER, args),
      }),
    });
  } catch {
    return null;
  }
}

function captureProofLookup(
  value: unknown,
  expectedEncoding: SessionSettlementNativeProofRef["encoding"],
): SessionSettlementNativeProofLookup | null {
  if (!isRecord(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
  if (Object.values(descriptors).some((descriptor) => descriptor.get || descriptor.set)) {
    return null;
  }
  if (value.disposition === "absent" && exactKeys(value, ["disposition"])) {
    return { disposition: "absent" };
  }
  if (value.disposition === "indeterminate" &&
      exactKeys(value, ["disposition", "reason"]) && isNonEmpty(value.reason)) {
    return { disposition: "indeterminate", reason: value.reason };
  }
  if (value.disposition !== "present") return null;
  if (expectedEncoding === "bytes" && exactKeys(value, ["disposition", "bytes"]) &&
      value.bytes instanceof Uint8Array) {
    return { disposition: "present", bytes: new Uint8Array(value.bytes) };
  }
  if (expectedEncoding === "jcs" && exactKeys(value, ["disposition", "artifact"]) &&
      isRecord(value.artifact)) {
    const artifact = ownedJson(value.artifact);
    return artifact ? { disposition: "present", artifact } : null;
  }
  return null;
}

/**
 * Authenticate one finalized settlement. Calling with `mode: "recovery"`
 * deliberately repeats every live/native observation before returning the
 * retained result.
 */
export async function verifyFinalizedSessionSettlement(
  contextInput: unknown,
  settlementInput: unknown,
  providerInput: SessionSettlementVerificationProvider,
  mode: "initial" | "recovery" = "initial",
): Promise<SessionSettlementVerification> {
  if (mode !== "initial" && mode !== "recovery") {
    return rejected("error", "settlement verification mode is invalid");
  }
  const context = ownedJson(contextInput);
  const settlement = ownedJson(settlementInput);
  const provider = captureProvider(providerInput);
  if (!context || !isContext(context)) {
    return rejected("error", "settlement context is not exact canonical data");
  }
  if (!settlement || !isFinalizedSettlement(settlement)) {
    return rejected("error", "finalized settlement is not exact canonical data");
  }
  if (!provider) {
    return rejected("error", "settlement verification provider is incomplete or unsafe");
  }

  let contextDisposition: SessionSettlementDisposition | null;
  try {
    contextDisposition = captureDisposition(await provider.authenticateContext(context));
  } catch {
    return rejected("indeterminate", "settlement context authentication threw");
  }
  if (!contextDisposition) return rejected("error", "settlement context verdict is malformed");
  const contextFailure = mapTrustDisposition(contextDisposition, "settlement context");
  if (contextFailure) return contextFailure;

  let mismatch: string | null;
  try {
    mismatch = contextMatchesEvidence(context, settlement);
  } catch {
    return rejected("error", "settlement evidence cannot be canonicalized safely");
  }
  if (mismatch) return rejected("rejected", mismatch);

  let evidenceVerification: Awaited<ReturnType<typeof verifySettlementEvidence>>;
  try {
    evidenceVerification = await verifySettlementEvidence(
      settlement.evidence,
      {
        orchestrator: context.orchestrator,
        agreement: {
          amount: context.paymentAmount.amount,
          currency: context.paymentAmount.currency,
        },
        rail: {
          railId: context.rail.railId,
          railType: context.rail.railType,
          asset: context.rail.asset,
          network: context.rail.network,
          handler: context.rail.handler,
        },
        attestationRef: settlement.evidenceRef,
        result: settlement.outcome === "success"
          ? { ok: true }
          : { ok: false, errorClass: settlement.evidence.reason },
      },
      provider.evidence,
    );
  } catch {
    return rejected(
      "indeterminate",
      "normative settlement evidence verification threw",
    );
  }
  if (evidenceVerification.decision !== "pass") {
    return rejected(
      evidenceVerification.decision === "fail"
        ? "rejected"
        : evidenceVerification.decision,
      `normative settlement evidence: ${evidenceVerification.reasons.join("; ")}`,
    );
  }

  let anchorDisposition: SessionSettlementDisposition | null;
  try {
    anchorDisposition = captureDisposition(await provider.verifyEvidenceAnchor({
      context,
      evidence: settlement.evidence,
      evidenceRef: settlement.evidenceRef,
      anchorReceipt: settlement.anchorReceipt,
    }));
  } catch {
    return rejected("indeterminate", "settlement evidence anchor verification threw");
  }
  if (!anchorDisposition) return rejected("error", "settlement evidence anchor verdict is malformed");
  const anchorFailure = mapTrustDisposition(anchorDisposition, "settlement evidence anchor");
  if (anchorFailure) return anchorFailure;

  let lookup: SessionSettlementNativeProofLookup | null;
  try {
    lookup = captureProofLookup(
      await provider.resolveNativeProof(settlement.nativeProofRef),
      settlement.nativeProofRef.encoding,
    );
  } catch {
    return rejected("indeterminate", "native settlement proof resolution threw");
  }
  if (!lookup) return rejected("error", "native settlement proof lookup is malformed");
  if (lookup.disposition === "absent") {
    return rejected("rejected", "native settlement proof is authoritatively absent");
  }
  if (lookup.disposition === "indeterminate") {
    return rejected("indeterminate", `native settlement proof: ${lookup.reason}`);
  }
  const nativeProof = lookup.bytes ?? lookup.artifact;
  let nativeProofHash: string;
  try {
    nativeProofHash = lookup.bytes
      ? sha256Hex(lookup.bytes)
      : sha256Hex(canonicalize(lookup.artifact));
  } catch {
    return rejected("error", "native settlement proof cannot be canonicalized safely");
  }
  if (nativeProofHash !== settlement.nativeProofRef.contentHash) {
    return rejected("rejected", "native settlement proof content hash mismatch");
  }

  const nativeProofForVerification = lookup.bytes
    ? new Uint8Array(lookup.bytes)
    : nativeProof;
  let nativeDisposition: SessionSettlementRevalidation | null;
  try {
    nativeDisposition = captureRevalidation(await provider.revalidateSettlement({
      mode,
      context,
      evidence: settlement.evidence,
      nativeProofRef: settlement.nativeProofRef,
      nativeProof: nativeProofForVerification,
    }));
  } catch {
    return rejected("indeterminate", "native settlement revalidation threw");
  }
  if (!nativeDisposition) return rejected("error", "native settlement verdict is malformed");
  const nativeFailure = mapTrustDisposition(nativeDisposition, "native settlement");
  if (nativeFailure) return nativeFailure;
  if (
    nativeDisposition.disposition !== "pass" ||
    !bindingMatchesContext(nativeDisposition.binding, context)
  ) {
    return rejected(
      "rejected",
      "native settlement binding does not match the authenticated session",
    );
  }
  if (
    lookup.bytes &&
    sha256Hex(nativeProofForVerification as Uint8Array) !== nativeProofHash
  ) {
    return rejected("error", "native settlement verifier mutated its proof input");
  }

  let contextHash: string;
  let evidenceHash: string;
  let identityHash: string;
  try {
    contextHash = sha256Hex(canonicalize(context));
    evidenceHash = contentHash(
      settlement.evidence as unknown as Record<string, unknown>,
    );
    identityHash = sha256Hex(canonicalize({
      settlementVersion: settlement.settlementVersion,
      outcome: settlement.outcome,
      contextHash,
      evidenceHash,
      evidenceRef: settlement.evidenceRef,
      anchorPublication: anchorPublicationIdentity(settlement.anchorReceipt),
      nativeProofRef: settlement.nativeProofRef,
      settlementBinding: nativeDisposition.binding,
    }));
  } catch {
    return rejected("error", "settlement identity cannot be canonicalized safely");
  }

  const claimInput = ownedJson<SessionSettlementIdentityClaimInput>({
    binding: nativeDisposition.binding,
    ownerHash: identityHash,
  });
  if (!claimInput) {
    return rejected("error", "settlement identity claim cannot be snapshotted safely");
  }
  let claim: SessionSettlementIdentityClaim | null;
  try {
    claim = captureIdentityClaim(await provider.claimSettlementIdentity(claimInput));
  } catch {
    return rejected("indeterminate", "settlement identity claim threw");
  }
  if (!claim) return rejected("error", "settlement identity claim verdict is malformed");
  const claimFailure = mapTrustDisposition(claim, "settlement identity claim");
  if (claimFailure) return claimFailure;
  if (
    claim.disposition !== "pass" ||
    claim.ownerHash !== identityHash ||
    !sameBinding(claim.binding, nativeDisposition.binding)
  ) {
    return rejected(
      "error",
      "settlement identity claim returned rebound ownership",
    );
  }

  let observationHash: string;
  try {
    observationHash = sha256Hex(canonicalize({
      identityHash,
      mode,
      anchorReceipt: settlement.anchorReceipt,
      nativeProofRef: settlement.nativeProofRef,
      nativeProofHash,
      settlementOwnership: claim.ownership,
    }));
  } catch {
    return rejected("error", "settlement observation cannot be canonicalized safely");
  }
  const value = ownedJson<VerifiedSessionSettlement>({
    state: "verified",
    mode,
    outcome: settlement.outcome,
    contextHash,
    evidenceHash,
    nativeProofHash,
    identityHash,
    observationHash,
    settlementBinding: nativeDisposition.binding,
    settlementOwnership: claim.ownership,
    settlement,
  });
  if (!value) return rejected("error", "verified settlement snapshot failed");
  return { disposition: "verified", value };
}
