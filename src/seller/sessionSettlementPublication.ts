import type {
  AnchorReceipt,
  AttestationRef,
  ComponentSignature,
  SettlementEvidence,
} from "../artifacts/types.js";
import {
  ARTIFACT_SEPARATORS,
  isAnchorReceipt,
  isAttestationRef,
  isCanonicalBase64Url,
  isComponentSignature,
  isSettlementEvidence,
  type BuildComponentSignatureOptions,
} from "../artifacts/index.js";
import {
  canonicalize,
  contentHash,
  encodeAddressSegment,
  sha256Hex,
} from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import {
  type FinalizedSessionSettlement,
  type SessionSettlementDisposition,
  type SessionSettlementNativeProofRef,
} from "../agent/sessionSettlement.js";
import {
  verifySettlementEvidence,
  type EvidenceDeps,
} from "../agent/verifySettlementEvidence.js";
import {
  isSellerFulfilmentHandoff,
  isValidSellerReceiptClaim,
  type SellerFulfilmentHandoff,
  type SellerPaymentAuthorization,
  type SellerPaymentFinality,
  type SellerReceiptClaim,
  type SellerReceiptInspectionResult,
  type SellerSettlementIdentity,
} from "./paymentIntake.js";

const HASH_RE = /^[0-9a-f]{64}$/;
const INERT_RECEIVER = Object.freeze(Object.create(null)) as object;

/**
 * Expected seller-side settlement scope. This is only an anti-substitution
 * assertion: authority is recovered again from the consumed receipt-store
 * permit and is never granted by this caller-owned value.
 */
export interface SellerSessionSettlementPublicationRequest {
  paymentPermitId: string;
  authorization: SellerPaymentAuthorization;
  /** Optional equality-only expectation; this value never grants proof authority. */
  nativeProofRef?: SessionSettlementNativeProofRef;
}

/** Exact facts independently authenticated from the retained native proof. */
export interface SellerSessionSettlementNativeProofBinding {
  bindingVersion: "1";
  jobId: string;
  railId: string;
  phaseIndex: number;
  phase: "pay-dem" | "pay-x402";
  evidenceHash: string;
  settlementId: string;
  /** Canonical producer network (`demos` or `eip155:<chainId>`). */
  network: string;
  event: SellerSettlementIdentity;
  settlementFinality: SellerPaymentFinality;
}

export type SellerSessionSettlementAuthenticatedNativeProof =
  | {
      encoding: "jcs";
      kind: string;
      locator: string;
      artifact: Record<string, unknown>;
    }
  | {
      encoding: "bytes";
      kind: string;
      locator: string;
      bytes: Uint8Array;
    };

/** Four-state authenticated native-proof resolution. */
export type SellerSessionSettlementNativeProofAuthentication =
  | {
      disposition: "authenticated";
      binding: SellerSessionSettlementNativeProofBinding;
      proof: SellerSessionSettlementAuthenticatedNativeProof;
    }
  | {
      disposition: "rejected" | "error" | "indeterminate";
      reason: string;
    };

/** Durable signed-artifact reconciliation before a possibly nondeterministic sign. */
export type SellerSessionSettlementSignedEvidenceResolution =
  | { disposition: "present"; effectId: string; evidence: SettlementEvidence }
  | {
      /** Authoritative: neither a signature WAL nor publication exists for this effect. */
      disposition: "absent";
    }
  | {
      disposition: "rejected" | "error" | "indeterminate";
      reason: string;
    };

export type SellerSessionSettlementAnchorResult =
  | {
      disposition: "anchored";
      evidenceRef: AttestationRef;
      anchorReceipt: AnchorReceipt;
    }
  | {
      disposition: "rejected" | "error" | "indeterminate";
      reason: string;
    };

export type SellerSessionSettlementEvidenceResolution =
  | { disposition: "present"; evidence: SettlementEvidence }
  | { disposition: "absent" }
  | { disposition: "indeterminate"; reason: string };

/** The settlement verifier currently authenticates ed25519 evidence only. */
export type SellerSessionSettlementEvidenceSigner =
  Omit<BuildComponentSignatureOptions, "algorithm"> & {
    algorithm: "ed25519";
  };

/**
 * Authenticated actor whose native wallet owns the evidence publication.
 *
 * The phase orchestrator still authors and signs the normative evidence. A
 * distinct buyer writer is permitted only when that exact primary claim is
 * retained as the buyer in the consumed, store-backed fulfilment handoff.
 */
export interface SellerSessionSettlementAnchorWriter {
  role: "phase-orchestrator" | "buyer";
  primaryClaim: string;
}

/**
 * Transport-neutral publication boundary. Implementations that require
 * instance state must pass pre-bound functions; callbacks are captured once
 * and invoked with an inert receiver.
 */
export interface SellerSessionSettlementPublicationDeps {
  /** Must be backed by `SellerFulfilmentReceiptStore.inspectPermit`. */
  receiptStore: {
    inspectPermit(permitId: string): Promise<SellerReceiptInspectionResult>;
  };
  /** Locally owned authority authenticated by the consumed handoff. */
  evidenceSigner: SellerSessionSettlementEvidenceSigner;
  /**
   * Native publication lane. Omission preserves the phase-orchestrator lane;
   * selecting the buyer lane is checked against the consumed handoff.
   */
  anchorWriter?: SellerSessionSettlementAnchorWriter;
  /** Independent cryptographic primitives used to self-check signed evidence. */
  evidence: Required<Pick<EvidenceDeps, "resolvePublicKey" | "verify">>;
  /**
   * Independently resolve and authenticate the exact native proof. An
   * `authenticated` result asserts that the returned owned proof content was
   * checked against the native ledger/provider, finality policy, and complete
   * binding facts. Returning an x402 capture/header alone is insufficient.
   */
  resolveAuthenticatedNativeProof(input: Readonly<{
    authorization: Readonly<SellerPaymentAuthorization>;
    expectedNativeProofRef?: Readonly<SessionSettlementNativeProofRef>;
  }>): Promise<SellerSessionSettlementNativeProofAuthentication>;
  /**
   * Reconcile a previously signed artifact by stable effect identity before
   * invoking the signer. A `present` artifact may come from a signature WAL or
   * an idempotent publication read. `absent` MUST be authoritative and safe to
   * sign across both signer and publisher systems; after any ambiguous signer
   * or anchor response, unresolved state is `indeterminate`, never absent.
   */
  resolveRetainedSignedEvidence(input: Readonly<{
    effectId: string;
    evidenceHash: string;
    unsignedEvidence: Readonly<Record<string, unknown>>;
    expectedSigner: string;
    algorithm: "ed25519";
  }>): Promise<SellerSessionSettlementSignedEvidenceResolution>;
  /** Idempotently publish the exact evidence under `effectId`. */
  anchorEvidence(input: Readonly<{
    effectId: string;
    logicalAddress: string;
    evidenceHash: string;
    evidence: Readonly<SettlementEvidence>;
    expectedWriter: Readonly<SellerSessionSettlementAnchorWriter>;
  }>): Promise<SellerSessionSettlementAnchorResult>;
  /** Authenticate the binding-native finalized receipt. */
  verifyAnchorReceipt(input: Readonly<{
    effectId: string;
    expectedWriter: string;
    evidenceRef: Readonly<AttestationRef>;
    anchorReceipt: Readonly<AnchorReceipt>;
  }>): Promise<SessionSettlementDisposition> | SessionSettlementDisposition;
  /** Independent readback from the returned exact evidence reference. */
  resolveEvidence(input: Readonly<{
    effectId: string;
    evidenceRef: Readonly<AttestationRef>;
  }>): Promise<SellerSessionSettlementEvidenceResolution>;
}

export type SellerSessionSettlementPublicationResult =
  | {
      disposition: "published";
      effectId: string;
      authorizationHash: string;
      evidenceHash: string;
      settlement: FinalizedSessionSettlement;
    }
  | {
      disposition: "rejected" | "error" | "indeterminate";
      reason: string;
      effectId?: string;
    };

interface CapturedDeps {
  inspectPermit: (permitId: string) => Promise<SellerReceiptInspectionResult>;
  signer: {
    algorithm: "ed25519";
    signer: string;
    sign: BuildComponentSignatureOptions["sign"];
  };
  anchorWriter: SellerSessionSettlementAnchorWriter;
  evidence: Required<Pick<EvidenceDeps, "resolvePublicKey" | "verify">>;
  resolveAuthenticatedNativeProof:
    SellerSessionSettlementPublicationDeps["resolveAuthenticatedNativeProof"];
  resolveRetainedSignedEvidence:
    SellerSessionSettlementPublicationDeps["resolveRetainedSignedEvidence"];
  anchorEvidence: SellerSessionSettlementPublicationDeps["anchorEvidence"];
  verifyAnchorReceipt: SellerSessionSettlementPublicationDeps["verifyAnchorReceipt"];
  resolveEvidence: SellerSessionSettlementPublicationDeps["resolveEvidence"];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const isUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  !Object.is(value, -0);

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    optional.every((key) =>
      !Object.prototype.hasOwnProperty.call(value, key) || value[key] !== undefined
    );
}

/** Reject accessors, symbols, exotic prototypes, holes, cycles, and lossy JSON. */
function exactJson(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable ||
            !exactJson(descriptor.value, seen)) return false;
      }
      return Reflect.ownKeys(descriptors).every((key) =>
        key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key)
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(descriptors).every((key) => {
      if (typeof key !== "string") return false;
      const descriptor = descriptors[key];
      return !!descriptor && descriptor.enumerable && !descriptor.get &&
        !descriptor.set && descriptor.value !== undefined &&
        exactJson(descriptor.value, seen);
    });
  } catch {
    return false;
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

function ownedJson<T>(value: T): T | null {
  try {
    if (!exactJson(value)) return null;
    return deepFreeze(structuredClone(value));
  } catch {
    return null;
  }
}

/**
 * Capture a callback-owned plain record without invoking any property getter.
 * Proxy descriptor/prototype traps are untrusted too, so every reflective
 * operation is contained and malformed/revoked proxies simply fail capture.
 */
function captureOwnDataRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") return null;
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          !descriptor.enumerable || descriptor.value === undefined) return null;
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function copyUint8Array(value: unknown): Uint8Array | null {
  try {
    // ArrayBuffer.isView rejects proxies without consulting user properties.
    if (!ArrayBuffer.isView(value) || !(value instanceof Uint8Array)) return null;
    const snapshot = new Uint8Array(value);
    return snapshot.byteLength > 0 ? snapshot : null;
  } catch {
    return null;
  }
}

function ownData(source: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  return descriptor && !descriptor.get && !descriptor.set
    ? descriptor.value
    : undefined;
}

function advertisesEd25519EvidenceSigner(value: unknown): boolean {
  try {
    if (value === null || typeof value !== "object") return false;
    const signer = ownData(value, "evidenceSigner");
    return signer !== null && typeof signer === "object" &&
      ownData(signer, "algorithm") === "ed25519";
  } catch {
    return false;
  }
}

function captureDeps(
  source: SellerSessionSettlementPublicationDeps,
): CapturedDeps | null {
  try {
    const receiptStore = ownData(source, "receiptStore");
    const evidenceSigner = ownData(source, "evidenceSigner");
    const anchorWriterInput = ownData(source, "anchorWriter");
    const evidence = ownData(source, "evidence");
    const resolveAuthenticatedNativeProof = ownData(
      source,
      "resolveAuthenticatedNativeProof",
    );
    const resolveRetainedSignedEvidence = ownData(
      source,
      "resolveRetainedSignedEvidence",
    );
    const anchorEvidence = ownData(source, "anchorEvidence");
    const verifyAnchorReceipt = ownData(source, "verifyAnchorReceipt");
    const resolveEvidence = ownData(source, "resolveEvidence");
    if (!isRecord(receiptStore) || !isRecord(evidenceSigner) || !isRecord(evidence) ||
        typeof resolveAuthenticatedNativeProof !== "function" ||
        typeof resolveRetainedSignedEvidence !== "function" ||
        typeof anchorEvidence !== "function" ||
        typeof verifyAnchorReceipt !== "function" ||
        typeof resolveEvidence !== "function") return null;
    const inspectPermit = ownData(receiptStore, "inspectPermit");
    const algorithm = ownData(evidenceSigner, "algorithm");
    const signer = ownData(evidenceSigner, "signer");
    const sign = ownData(evidenceSigner, "sign");
    const resolvePublicKey = ownData(evidence, "resolvePublicKey");
    const verify = ownData(evidence, "verify");
    if (typeof inspectPermit !== "function" || typeof sign !== "function" ||
        typeof resolvePublicKey !== "function" || typeof verify !== "function" ||
        algorithm !== "ed25519" ||
        !isNonEmpty(signer)) return null;
    let anchorWriter: SellerSessionSettlementAnchorWriter;
    if (anchorWriterInput === undefined) {
      anchorWriter = { role: "phase-orchestrator", primaryClaim: signer };
    } else {
      if (!isRecord(anchorWriterInput) ||
          !exactKeys(anchorWriterInput, ["role", "primaryClaim"]) ||
          (anchorWriterInput.role !== "phase-orchestrator" &&
            anchorWriterInput.role !== "buyer") ||
          !isNonEmpty(anchorWriterInput.primaryClaim)) return null;
      anchorWriter = {
        role: anchorWriterInput.role,
        primaryClaim: anchorWriterInput.primaryClaim,
      };
    }
    const call = <T extends Function>(fn: T, args: unknown[]): unknown =>
      Reflect.apply(fn, INERT_RECEIVER, args);
    return Object.freeze({
      inspectPermit: (permitId: string) =>
        call(inspectPermit, [permitId]) as Promise<SellerReceiptInspectionResult>,
      signer: Object.freeze({
        algorithm,
        signer,
        sign: ((bytes: Uint8Array, context: Pick<ComponentSignature, "algorithm" | "signer">) =>
          call(sign, [bytes, context])) as BuildComponentSignatureOptions["sign"],
      }),
      anchorWriter: Object.freeze(anchorWriter),
      evidence: Object.freeze({
        resolvePublicKey: async (candidateSigner: string) => {
          const value = await call(resolvePublicKey, [candidateSigner]);
          return value instanceof Uint8Array ? new Uint8Array(value) : null;
        },
        verify: async (bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) => {
          const bytesInput = new Uint8Array(bytes);
          const signatureInput = new Uint8Array(signature);
          const publicKeyInput = new Uint8Array(publicKey);
          const before = [bytesInput, signatureInput, publicKeyInput]
            .map((entry) => Buffer.from(entry).toString("base64url"));
          const result = await call(verify, [bytesInput, signatureInput, publicKeyInput]);
          const after = [bytesInput, signatureInput, publicKeyInput]
            .map((entry) => Buffer.from(entry).toString("base64url"));
          if (before.some((entry, index) => entry !== after[index]) ||
              typeof result !== "boolean") {
            throw new TypeError("evidence verifier mutated its input or returned a malformed result");
          }
          return result;
        },
      }),
      resolveAuthenticatedNativeProof: (input: Parameters<
        SellerSessionSettlementPublicationDeps["resolveAuthenticatedNativeProof"]
      >[0]) => call(resolveAuthenticatedNativeProof, [input]) as ReturnType<
        SellerSessionSettlementPublicationDeps["resolveAuthenticatedNativeProof"]
      >,
      resolveRetainedSignedEvidence: (input: Parameters<
        SellerSessionSettlementPublicationDeps["resolveRetainedSignedEvidence"]
      >[0]) => call(resolveRetainedSignedEvidence, [input]) as ReturnType<
        SellerSessionSettlementPublicationDeps["resolveRetainedSignedEvidence"]
      >,
      anchorEvidence: (input: Parameters<
        SellerSessionSettlementPublicationDeps["anchorEvidence"]
      >[0]) => call(anchorEvidence, [input]) as ReturnType<
        SellerSessionSettlementPublicationDeps["anchorEvidence"]
      >,
      verifyAnchorReceipt: (input: Parameters<
        SellerSessionSettlementPublicationDeps["verifyAnchorReceipt"]
      >[0]) => call(verifyAnchorReceipt, [input]) as ReturnType<
        SellerSessionSettlementPublicationDeps["verifyAnchorReceipt"]
      >,
      resolveEvidence: (input: Parameters<
        SellerSessionSettlementPublicationDeps["resolveEvidence"]
      >[0]) => call(resolveEvidence, [input]) as ReturnType<
        SellerSessionSettlementPublicationDeps["resolveEvidence"]
      >,
    });
  } catch {
    return null;
  }
}

function isProofRef(value: unknown): value is SessionSettlementNativeProofRef {
  return isRecord(value) && exactKeys(value, [
    "proofVersion",
    "kind",
    "locator",
    "contentHash",
    "encoding",
  ]) && value.proofVersion === "1" && isNonEmpty(value.kind) &&
    isNonEmpty(value.locator) && typeof value.contentHash === "string" &&
    HASH_RE.test(value.contentHash) &&
    (value.encoding === "jcs" || value.encoding === "bytes");
}

function isSettlementIdentity(value: unknown): value is SellerSettlementIdentity {
  if (!isRecord(value) || !isNonEmpty(value.kind)) return false;
  if (value.kind === "demos") {
    return exactKeys(value, ["kind", "txHash", "blockNumber", "includedAt"]) &&
      typeof value.txHash === "string" && /^(?:0[xX])?[0-9a-fA-F]{64}$/.test(value.txHash) &&
      isUint(value.blockNumber) && isUint(value.includedAt);
  }
  return value.kind === "evm" &&
    exactKeys(value, ["kind", "chainId", "txHash", "logIndex", "includedAt"]) &&
    isUint(value.chainId) && value.chainId > 0 &&
    typeof value.txHash === "string" && /^(?:0[xX])?[0-9a-fA-F]{64}$/.test(value.txHash) &&
    isUint(value.logIndex) && isUint(value.includedAt);
}

function isPaymentFinality(value: unknown): value is SellerPaymentFinality {
  if (!isRecord(value)) return false;
  if (value.model === "bft-final") {
    return exactKeys(value, ["model", "finalityObservedAt"]) &&
      isUint(value.finalityObservedAt);
  }
  return value.model === "block-depth" &&
    exactKeys(value, ["model", "finalityBlocks", "finalityObservedAt"]) &&
    isUint(value.finalityBlocks) && value.finalityBlocks > 0 &&
    isUint(value.finalityObservedAt);
}

function isNativeProofBinding(
  value: unknown,
): value is SellerSessionSettlementNativeProofBinding {
  return isRecord(value) && exactKeys(value, [
    "bindingVersion",
    "jobId",
    "railId",
    "phaseIndex",
    "phase",
    "evidenceHash",
    "settlementId",
    "network",
    "event",
    "settlementFinality",
  ]) && value.bindingVersion === "1" && isNonEmpty(value.jobId) &&
    isNonEmpty(value.railId) && isUint(value.phaseIndex) &&
    (value.phase === "pay-dem" || value.phase === "pay-x402") &&
    typeof value.evidenceHash === "string" && HASH_RE.test(value.evidenceHash) &&
    isNonEmpty(value.settlementId) && isNonEmpty(value.network) &&
    isSettlementIdentity(value.event) && isPaymentFinality(value.settlementFinality);
}

function captureNativeProofAuthentication(
  value: unknown,
): SellerSessionSettlementNativeProofAuthentication | null {
  try {
    const snapshot = captureOwnDataRecord(value);
    if (!snapshot) return null;
    if (snapshot.disposition !== "authenticated") {
      if ((snapshot.disposition !== "rejected" && snapshot.disposition !== "error" &&
          snapshot.disposition !== "indeterminate") ||
          !exactKeys(snapshot as Record<string, unknown>, ["disposition", "reason"]) ||
          !isNonEmpty(snapshot.reason)) return null;
      return {
        disposition: snapshot.disposition,
        reason: snapshot.reason,
      };
    }
    if (!exactKeys(
      snapshot as Record<string, unknown>,
      ["disposition", "binding", "proof"],
    )) return null;
    const binding = ownedJson(snapshot.binding);
    const proof = captureOwnDataRecord(snapshot.proof);
    if (!binding || !isNativeProofBinding(binding) || !proof) return null;
    if (proof.encoding === "jcs" &&
        exactKeys(proof as Record<string, unknown>, [
          "encoding",
          "kind",
          "locator",
          "artifact",
        ]) &&
        isNonEmpty(proof.kind) && isNonEmpty(proof.locator)) {
      const artifact = ownedJson(proof.artifact);
      if (!artifact || !isRecord(artifact)) return null;
      return {
        disposition: "authenticated",
        binding,
        proof: {
          encoding: "jcs",
          kind: proof.kind,
          locator: proof.locator,
          artifact,
        },
      };
    }
    if (proof.encoding === "bytes" &&
        exactKeys(proof as Record<string, unknown>, [
          "encoding",
          "kind",
          "locator",
          "bytes",
        ]) &&
        isNonEmpty(proof.kind) && isNonEmpty(proof.locator)) {
      const bytes = copyUint8Array(proof.bytes);
      if (!bytes) return null;
      return {
        disposition: "authenticated",
        binding,
        proof: {
          encoding: "bytes",
          kind: proof.kind,
          locator: proof.locator,
          bytes,
        },
      };
    }
    return null;
  } catch {
    // Callback output is untrusted; no malformed object may escape this API.
    return null;
  }
}

function captureSignedEvidenceResolution(
  value: unknown,
): SellerSessionSettlementSignedEvidenceResolution | null {
  const snapshot = ownedJson(value);
  if (!isRecord(snapshot)) return null;
  if (snapshot.disposition === "absent" && exactKeys(snapshot, ["disposition"])) {
    return { disposition: "absent" };
  }
  if (snapshot.disposition === "present" &&
      exactKeys(snapshot, ["disposition", "effectId", "evidence"]) &&
      isNonEmpty(snapshot.effectId) &&
      isSettlementEvidence(snapshot.evidence)) {
    return snapshot as unknown as SellerSessionSettlementSignedEvidenceResolution;
  }
  if ((snapshot.disposition === "rejected" || snapshot.disposition === "error" ||
      snapshot.disposition === "indeterminate") &&
      exactKeys(snapshot, ["disposition", "reason"]) &&
      isNonEmpty(snapshot.reason)) {
    return snapshot as SellerSessionSettlementSignedEvidenceResolution;
  }
  return null;
}

function unsignedSettlementScope(
  evidence: SettlementEvidence,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== "signature"),
  );
}

function nativeProofBindingMatches(
  binding: SellerSessionSettlementNativeProofBinding,
  authorization: SellerPaymentAuthorization,
): boolean {
  const expectedNetwork = authorization.settlementIdentity.kind === "demos"
    ? "demos"
    : `eip155:${authorization.settlementIdentity.chainId}`;
  return binding.jobId === authorization.jobId &&
    binding.railId === authorization.railId &&
    binding.phaseIndex === authorization.phaseIndex &&
    binding.phase === authorization.evidenceInput.phase &&
    binding.evidenceHash === authorization.evidenceHash &&
    binding.settlementId === authorization.settlementId &&
    binding.network === expectedNetwork &&
    canonicalize(binding.event) === canonicalize(authorization.settlementIdentity) &&
    canonicalize(binding.settlementFinality) ===
      canonicalize(authorization.evidenceInput.settlementFinality);
}

function deriveNativeProofRef(
  proof: SellerSessionSettlementAuthenticatedNativeProof,
): SessionSettlementNativeProofRef {
  const contentHash = proof.encoding === "jcs"
    ? sha256Hex(canonicalize(proof.artifact))
    : sha256Hex(proof.bytes);
  return {
    proofVersion: "1",
    kind: proof.kind,
    locator: proof.locator,
    contentHash,
    encoding: proof.encoding,
  };
}

function validAuthorization(value: unknown): value is SellerPaymentAuthorization {
  if (!isRecord(value) || !isRecord(value.evidenceInput) ||
      !isNonEmpty(value.settlementId) || !isNonEmpty(value.jobId) ||
      !isUint(value.phaseIndex) || typeof value.evidenceHash !== "string") return false;
  return isValidSellerReceiptClaim({
    settlementId: value.settlementId,
    jobId: value.jobId,
    phaseIndex: value.phaseIndex,
    observedAt: value.evidenceInput.observedAt,
    evidenceHash: value.evidenceHash,
    authorization: value,
  });
}

function parseRequest(value: unknown): SellerSessionSettlementPublicationRequest | null {
  const snapshot = ownedJson(value);
  if (!isRecord(snapshot) || !exactKeys(snapshot, [
    "paymentPermitId",
    "authorization",
  ], ["nativeProofRef"]) || !isNonEmpty(snapshot.paymentPermitId) ||
      !validAuthorization(snapshot.authorization) ||
      (snapshot.nativeProofRef !== undefined &&
        !isProofRef(snapshot.nativeProofRef))) return null;
  return snapshot as unknown as SellerSessionSettlementPublicationRequest;
}

function handoffMatches(
  handoff: SellerFulfilmentHandoff,
  authorization: SellerPaymentAuthorization,
  authorizationHash: string,
  signer: CapturedDeps["signer"],
): boolean {
  return handoff.jobId === authorization.jobId &&
    handoff.agreementHash === authorization.agreementHash &&
    handoff.commitmentRef === authorization.commitment.ref &&
    handoff.authorizationHash === authorizationHash &&
    handoff.settlementId === authorization.settlementId &&
    handoff.paymentEvidenceHash === authorization.evidenceHash &&
    handoff.paymentPhaseIndex === authorization.phaseIndex &&
    handoff.evidenceAuthority.primaryClaim === signer.signer &&
    handoff.evidenceAuthority.algorithm === signer.algorithm;
}

function anchorWriterMatchesHandoff(
  handoff: SellerFulfilmentHandoff,
  signer: CapturedDeps["signer"],
  writer: SellerSessionSettlementAnchorWriter,
): boolean {
  if (writer.role === "phase-orchestrator") {
    return writer.primaryClaim === signer.signer;
  }
  const buyers = handoff.auditSource.session.parties.filter(
    (party) => party.role === "buyer",
  );
  return buyers.length === 1 && buyers[0]!.primaryClaim === writer.primaryClaim;
}

function signedSettlementId(
  authorization: SellerPaymentAuthorization,
): string | null {
  const ref = authorization.evidenceInput.paymentTxRefs[0];
  if (ref.kind === "demos") {
    const txHash = ref.txHash.toLowerCase().replace(/^0x/, "");
    return `demos:${txHash}`;
  }
  if (ref.kind === "x402-event") {
    const txHash = ref.settlementTxHash.toLowerCase().replace(/^0x/, "");
    return `evm:${ref.chainId}:${txHash}:${ref.logIndex}`;
  }
  // Legacy transaction-level x402 evidence has no signed logIndex. Readers of
  // retained legacy evidence MUST use resolveSettlementEventIdentity. This
  // current producer cannot invent the coordinate and therefore rejects it.
  return null;
}

function evidenceContext(authorization: SellerPaymentAuthorization) {
  const input = authorization.evidenceInput;
  const identity = authorization.settlementIdentity;
  return {
    orchestrator: undefined as string | undefined,
    agreement: {
      amount: input.paymentAmount.amount,
      currency: input.paymentAmount.currency,
    },
    rail: {
      railId: authorization.railId,
      railType: input.phase === "pay-dem" ? "demos-native" : "x402",
      asset: input.paymentAmount.currency,
      network: input.phase === "pay-dem"
        ? "demos"
        : `eip155:${identity.kind === "evm" ? identity.chainId : "invalid"}`,
      handler: input.phase,
    },
    paymentAddress: {
      railId: authorization.railId,
      phaseIndex: authorization.phaseIndex,
    },
    result: {
      ok: true as const,
      txRefs: structuredClone(input.paymentTxRefs),
    },
  };
}

function mapEvidenceDecision(
  decision: "fail" | "error" | "indeterminate",
): "rejected" | "error" | "indeterminate" {
  return decision === "fail" ? "rejected" : decision;
}

function parseDisposition(value: unknown): SessionSettlementDisposition | null {
  const snapshot = ownedJson(value);
  if (!isRecord(snapshot)) return null;
  if (snapshot.disposition === "pass" && exactKeys(snapshot, ["disposition"])) {
    return { disposition: "pass" };
  }
  if ((snapshot.disposition === "fail" || snapshot.disposition === "error" ||
      snapshot.disposition === "indeterminate") &&
      exactKeys(snapshot, ["disposition", "reason"]) &&
      isNonEmpty(snapshot.reason)) return snapshot as SessionSettlementDisposition;
  return null;
}

function failure(
  disposition: "rejected" | "error" | "indeterminate",
  reason: string,
  effectId?: string,
): SellerSessionSettlementPublicationResult {
  return { disposition, reason, ...(effectId ? { effectId } : {}) };
}

/** Stable identity derived only after proof authentication succeeds. */
function settlementPublicationEffectId(input: {
  authorization: Readonly<SellerPaymentAuthorization>;
  nativeProofRef: Readonly<SessionSettlementNativeProofRef>;
  evidenceAuthority: Readonly<{
    primaryClaim: string;
    algorithm: "ed25519";
  }>;
  anchorWriter: Readonly<SellerSessionSettlementAnchorWriter>;
}): string {
  if (!validAuthorization(input.authorization) || !isProofRef(input.nativeProofRef) ||
      !isNonEmpty(input.evidenceAuthority?.primaryClaim) ||
      input.evidenceAuthority?.algorithm !== "ed25519" ||
      !isNonEmpty(input.anchorWriter?.primaryClaim) ||
      (input.anchorWriter?.role !== "phase-orchestrator" &&
        input.anchorWriter?.role !== "buyer")) {
    throw new TypeError("settlement publication identity input is malformed");
  }
  const authorizationHash = sha256Hex(canonicalize(input.authorization));
  return `seller-settlement:v1:${sha256Hex(canonicalize({
    publicationVersion: "1",
    authorizationHash,
    settlementId: input.authorization.settlementId,
    evidenceHash: input.authorization.evidenceHash,
    nativeProofRef: input.nativeProofRef,
    evidenceAuthority: input.evidenceAuthority,
    anchorWriter: input.anchorWriter,
  }))}`;
}

/**
 * Sign and publish one consumed seller payment observation as normative
 * `SettlementEvidence`, returning the exact public shape accepted by
 * `verifyFinalizedSessionSettlement`.
 */
export async function publishSellerSessionSettlement(
  requestInput: SellerSessionSettlementPublicationRequest,
  depsInput: SellerSessionSettlementPublicationDeps,
): Promise<SellerSessionSettlementPublicationResult> {
  const request = parseRequest(requestInput);
  if (!request) return failure("error", "settlement publication request is not exact canonical data");
  if (!advertisesEd25519EvidenceSigner(depsInput)) {
    return failure(
      "error",
      "settlement publication evidence signer must use ed25519",
    );
  }
  const deps = captureDeps(depsInput);
  if (!deps) return failure("error", "settlement publication dependencies are incomplete or unsafe");

  let inspection: SellerReceiptInspectionResult | null;
  try {
    inspection = ownedJson(await deps.inspectPermit(request.paymentPermitId));
  } catch {
    return failure("indeterminate", "payment permit inspection threw");
  }
  if (!inspection || !isRecord(inspection)) {
    return failure("error", "payment permit inspection is malformed");
  }
  if (inspection.status === "invalid" && exactKeys(inspection, ["status"])) {
    return failure("rejected", "payment permit is invalid");
  }
  if (inspection.status === "available" && exactKeys(inspection, ["status", "claim"])) {
    return failure("rejected", "payment permit has not been consumed with a durable handoff");
  }
  if (inspection.status !== "already-consumed" ||
      !exactKeys(inspection, ["status", "claim", "handoff"]) ||
      !isValidSellerReceiptClaim(inspection.claim) ||
      !isSellerFulfilmentHandoff(inspection.handoff)) {
    return failure("error", "payment permit inspection is malformed");
  }

  const claim = inspection.claim as SellerReceiptClaim;
  const handoff = inspection.handoff;
  let authorizationHash: string;
  try {
    authorizationHash = sha256Hex(canonicalize(request.authorization));
  } catch {
    return failure("error", "payment authorization is not canonicalizable");
  }
  if (canonicalize(claim.authorization) !== canonicalize(request.authorization)) {
    return failure("rejected", "payment permit resolves to a substituted authorization");
  }
  if (!handoffMatches(handoff, request.authorization, authorizationHash, deps.signer)) {
    return failure("rejected", "consumed handoff does not bind the exact authorization and signer");
  }
  if (!anchorWriterMatchesHandoff(handoff, deps.signer, deps.anchorWriter)) {
    return failure(
      "rejected",
      "settlement evidence anchor writer is not the authenticated phase orchestrator or buyer",
    );
  }
  const projectedSettlementId = signedSettlementId(request.authorization);
  if (projectedSettlementId === null) {
    return failure(
      "rejected",
      "current pay-x402 publication requires a signed x402-event chain/tx/log coordinate",
    );
  }
  if (projectedSettlementId !== request.authorization.settlementId) {
    return failure("rejected", "signed settlement event differs from the authorized settlement identity");
  }

  const proofInput = deepFreeze({
    authorization: structuredClone(request.authorization),
    ...(request.nativeProofRef === undefined
      ? {}
      : { expectedNativeProofRef: structuredClone(request.nativeProofRef) }),
  });
  const proofInputBefore = canonicalize(proofInput);
  let rawProofResolution: unknown;
  try {
    rawProofResolution = await deps.resolveAuthenticatedNativeProof(proofInput);
  } catch {
    return failure("indeterminate", "authenticated native proof resolution threw");
  }
  if (canonicalize(proofInput) !== proofInputBefore) {
    return failure("indeterminate", "native proof resolver mutated its exact input");
  }
  const proofResolution = captureNativeProofAuthentication(rawProofResolution);
  if (!proofResolution) {
    return failure("error", "authenticated native proof resolution is malformed");
  }
  if (proofResolution.disposition !== "authenticated") {
    return failure(
      proofResolution.disposition,
      `authenticated native proof: ${proofResolution.reason}`,
    );
  }
  if (!nativeProofBindingMatches(proofResolution.binding, request.authorization)) {
    return failure(
      "rejected",
      "authenticated native proof does not bind the exact settlement event, network, and evidence",
    );
  }
  let authenticatedNativeProofRef: SessionSettlementNativeProofRef;
  try {
    authenticatedNativeProofRef = deriveNativeProofRef(proofResolution.proof);
  } catch {
    return failure("error", "authenticated native proof content is not canonicalizable");
  }
  if (request.nativeProofRef !== undefined &&
      canonicalize(request.nativeProofRef) !== canonicalize(authenticatedNativeProofRef)) {
    return failure("rejected", "caller native proof expectation differs from authenticated proof");
  }

  let effectId: string;
  try {
    effectId = settlementPublicationEffectId({
      authorization: request.authorization,
      nativeProofRef: authenticatedNativeProofRef,
      evidenceAuthority: {
        primaryClaim: deps.signer.signer,
        algorithm: deps.signer.algorithm,
      },
      anchorWriter: deps.anchorWriter,
    });
  } catch {
    return failure("error", "settlement publication identity cannot be derived");
  }

  const unsigned = deepFreeze(structuredClone(request.authorization.evidenceInput));
  const evidenceHash = contentHash(unsigned as unknown as Record<string, unknown>);
  if (evidenceHash !== request.authorization.evidenceHash) {
    return failure("rejected", "payment evidence differs from the store-authorized hash", effectId);
  }
  const reconciliationInput = deepFreeze({
    effectId,
    evidenceHash,
    unsignedEvidence: structuredClone(unsigned) as unknown as Record<string, unknown>,
    expectedSigner: deps.signer.signer,
    algorithm: deps.signer.algorithm,
  });
  const reconciliationBefore = canonicalize(reconciliationInput);
  let rawReconciliation: unknown;
  try {
    rawReconciliation = await deps.resolveRetainedSignedEvidence(reconciliationInput);
  } catch {
    return failure("indeterminate", "signed evidence reconciliation threw", effectId);
  }
  if (canonicalize(reconciliationInput) !== reconciliationBefore) {
    return failure("indeterminate", "signed evidence reconciler mutated its exact input", effectId);
  }
  const reconciliation = captureSignedEvidenceResolution(rawReconciliation);
  if (!reconciliation) {
    return failure("error", "signed evidence reconciliation is malformed", effectId);
  }
  if (reconciliation.disposition !== "present" &&
      reconciliation.disposition !== "absent") {
    return failure(
      reconciliation.disposition,
      `signed evidence reconciliation: ${reconciliation.reason}`,
      effectId,
    );
  }

  let evidence: SettlementEvidence;
  if (reconciliation.disposition === "present") {
    evidence = deepFreeze(structuredClone(reconciliation.evidence));
    if (reconciliation.effectId !== effectId ||
        evidence.signature.signer !== deps.signer.signer ||
        evidence.signature.algorithm !== deps.signer.algorithm ||
        contentHash(evidence as unknown as Record<string, unknown>) !== evidenceHash ||
        canonicalize(unsignedSettlementScope(evidence)) !== canonicalize(unsigned)) {
      return failure(
        "rejected",
        "retained signed evidence does not bind the exact effect, scope, signer, and algorithm",
        effectId,
      );
    }
  } else {
    const bytes = signedBytes(ARTIFACT_SEPARATORS.SettlementEvidence, evidenceHash);
    const signerBytes = new Uint8Array(bytes);
    const signerContext = deepFreeze({
      algorithm: deps.signer.algorithm,
      signer: deps.signer.signer,
    });
    const bytesBefore = Buffer.from(signerBytes).toString("base64url");
    const contextBefore = canonicalize(signerContext);
    let signatureValue: string;
    try {
      const raw = await deps.signer.sign(signerBytes, signerContext);
      if (Buffer.from(signerBytes).toString("base64url") !== bytesBefore ||
          canonicalize(signerContext) !== contextBefore) {
        return failure("indeterminate", "evidence signer mutated its exact input", effectId);
      }
      signatureValue = typeof raw === "string"
        ? raw
        : raw instanceof Uint8Array
          ? Buffer.from(new Uint8Array(raw)).toString("base64url")
          : "";
    } catch {
      return failure("indeterminate", "evidence signing threw", effectId);
    }
    if (!isCanonicalBase64Url(signatureValue)) {
      return failure("error", "evidence signer returned a non-canonical signature", effectId);
    }
    const signature: ComponentSignature = {
      ...signerContext,
      value: signatureValue,
    };
    evidence = deepFreeze({ ...structuredClone(unsigned), signature }) as SettlementEvidence;
    if (!isComponentSignature(signature) || !isSettlementEvidence(evidence) ||
        contentHash(evidence as unknown as Record<string, unknown>) !== evidenceHash) {
      return failure("error", "signed payment evidence is not normative", effectId);
    }
  }

  const logicalAddress =
    `dacs4:payment:${request.authorization.jobId}:` +
    `${encodeAddressSegment(request.authorization.railId)}:` +
    `${request.authorization.phaseIndex}`;
  const context = {
    ...evidenceContext(request.authorization),
    orchestrator: deps.signer.signer,
    // The content-addressed target is deterministic before publication. The
    // finalized receipt and readback below must independently reproduce it.
    attestationRef: {
      anchor: { kind: "storage-program" as const, locator: logicalAddress },
      contentHash: evidenceHash,
    },
  };
  let signatureCheck: Awaited<ReturnType<typeof verifySettlementEvidence>>;
  try {
    signatureCheck = await verifySettlementEvidence(evidence, context, deps.evidence);
  } catch {
    return failure(
      "indeterminate",
      "signed payment evidence verification threw",
      effectId,
    );
  }
  if (signatureCheck.decision !== "pass") {
    return failure(
      mapEvidenceDecision(signatureCheck.decision),
      `signed payment evidence verification failed: ${signatureCheck.reasons.join("; ")}`,
      effectId,
    );
  }

  const anchorInput = deepFreeze({
    effectId,
    logicalAddress,
    evidenceHash,
    evidence: structuredClone(evidence),
    expectedWriter: structuredClone(deps.anchorWriter),
  });
  const anchorBefore = canonicalize(anchorInput);
  let rawAnchor: unknown;
  try {
    rawAnchor = await deps.anchorEvidence(anchorInput);
  } catch {
    return failure("indeterminate", "settlement evidence publication threw", effectId);
  }
  if (canonicalize(anchorInput) !== anchorBefore) {
    return failure("indeterminate", "settlement evidence publisher mutated its exact input", effectId);
  }
  const anchored = ownedJson(rawAnchor);
  if (!isRecord(anchored)) {
    return failure("error", "settlement evidence publisher returned a malformed result", effectId);
  }
  if (anchored.disposition !== "anchored") {
    if ((anchored.disposition === "rejected" || anchored.disposition === "error" ||
        anchored.disposition === "indeterminate") &&
        exactKeys(anchored, ["disposition", "reason"]) && isNonEmpty(anchored.reason)) {
      return failure(anchored.disposition, anchored.reason, effectId);
    }
    return failure("error", "settlement evidence publisher returned a malformed result", effectId);
  }
  if (!exactKeys(anchored, ["disposition", "evidenceRef", "anchorReceipt"]) ||
      !isAttestationRef(anchored.evidenceRef) || !isAnchorReceipt(anchored.anchorReceipt)) {
    return failure("error", "settlement evidence publisher returned a malformed anchor", effectId);
  }
  const evidenceRef = anchored.evidenceRef;
  const anchorReceipt = anchored.anchorReceipt;
  if (evidenceRef.anchor.kind !== "storage-program" ||
      evidenceRef.anchor.locator !== logicalAddress ||
      evidenceRef.contentHash !== evidenceHash ||
      (evidenceRef.signer !== undefined && evidenceRef.signer !== deps.signer.signer) ||
      anchorReceipt.logicalAddress !== logicalAddress ||
      anchorReceipt.contentHash !== evidenceHash ||
      anchorReceipt.writer !== deps.anchorWriter.primaryClaim ||
      anchorReceipt.state !== "finalized" ||
      anchorReceipt.observationDisposition !== "established") {
    return failure("rejected", "publication lacks the exact finalized evidence binding", effectId);
  }

  const receiptInput = deepFreeze({
    effectId,
    expectedWriter: deps.anchorWriter.primaryClaim,
    evidenceRef: structuredClone(evidenceRef),
    anchorReceipt: structuredClone(anchorReceipt),
  });
  const receiptBefore = canonicalize(receiptInput);
  let receiptDisposition: SessionSettlementDisposition | null;
  try {
    receiptDisposition = parseDisposition(await deps.verifyAnchorReceipt(receiptInput));
  } catch {
    return failure("indeterminate", "anchor receipt authentication threw", effectId);
  }
  if (canonicalize(receiptInput) !== receiptBefore) {
    return failure("indeterminate", "anchor receipt verifier mutated its exact input", effectId);
  }
  if (!receiptDisposition) {
    return failure("error", "anchor receipt verifier returned a malformed result", effectId);
  }
  if (receiptDisposition.disposition !== "pass") {
    return failure(
      receiptDisposition.disposition === "fail"
        ? "rejected"
        : receiptDisposition.disposition,
      `anchor receipt authentication failed: ${receiptDisposition.reason}`,
      effectId,
    );
  }

  const readInput = deepFreeze({
    effectId,
    evidenceRef: structuredClone(evidenceRef),
  });
  const readBefore = canonicalize(readInput);
  let rawResolution: unknown;
  try {
    rawResolution = await deps.resolveEvidence(readInput);
  } catch {
    return failure("indeterminate", "settlement evidence readback threw", effectId);
  }
  if (canonicalize(readInput) !== readBefore) {
    return failure("indeterminate", "settlement evidence resolver mutated its exact input", effectId);
  }
  const resolution = ownedJson(rawResolution);
  if (!isRecord(resolution)) {
    return failure("error", "settlement evidence readback is malformed", effectId);
  }
  if (resolution.disposition === "absent" && exactKeys(resolution, ["disposition"])) {
    return failure("rejected", "settlement evidence is absent at the published reference", effectId);
  }
  if (resolution.disposition === "indeterminate" &&
      exactKeys(resolution, ["disposition", "reason"]) && isNonEmpty(resolution.reason)) {
    return failure("indeterminate", resolution.reason, effectId);
  }
  if (resolution.disposition !== "present" ||
      !exactKeys(resolution, ["disposition", "evidence"]) ||
      !isSettlementEvidence(resolution.evidence)) {
    return failure("error", "settlement evidence readback is malformed", effectId);
  }
  const readEvidence = resolution.evidence;
  if (canonicalize(readEvidence) !== canonicalize(evidence) ||
      contentHash(readEvidence as unknown as Record<string, unknown>) !== evidenceHash ||
      readEvidence.signature.signer !== deps.signer.signer) {
    return failure("rejected", "settlement evidence readback differs from the signed publication", effectId);
  }
  let readCheck: Awaited<ReturnType<typeof verifySettlementEvidence>>;
  try {
    readCheck = await verifySettlementEvidence(
      readEvidence,
      { ...context, attestationRef: structuredClone(evidenceRef) },
      deps.evidence,
    );
  } catch {
    return failure(
      "indeterminate",
      "published payment evidence verification threw",
      effectId,
    );
  }
  if (readCheck.decision !== "pass") {
    return failure(
      mapEvidenceDecision(readCheck.decision),
      `published payment evidence verification failed: ${readCheck.reasons.join("; ")}`,
      effectId,
    );
  }

  const settlement = deepFreeze({
    settlementVersion: "1" as const,
    outcome: "success" as const,
    evidence: structuredClone(readEvidence),
    evidenceRef: structuredClone(evidenceRef),
    anchorReceipt: structuredClone(anchorReceipt),
    nativeProofRef: structuredClone(authenticatedNativeProofRef),
  });
  return deepFreeze({
    disposition: "published" as const,
    effectId,
    authorizationHash,
    evidenceHash,
    settlement,
  });
}
