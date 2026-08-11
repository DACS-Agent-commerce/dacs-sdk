import type {
  AnchorReceipt,
  AttestationRef,
  ComponentSignature,
  ComponentSignatureAlgorithm,
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
  type SellerReceiptClaim,
  type SellerReceiptInspectionResult,
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
  nativeProofRef: SessionSettlementNativeProofRef;
}

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
  evidenceSigner: BuildComponentSignatureOptions;
  /** Independent cryptographic primitives used to self-check signed evidence. */
  evidence: Required<Pick<EvidenceDeps, "resolvePublicKey" | "verify">>;
  /** Idempotently publish the exact evidence under `effectId`. */
  anchorEvidence(input: Readonly<{
    effectId: string;
    logicalAddress: string;
    evidenceHash: string;
    evidence: Readonly<SettlementEvidence>;
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
    algorithm: ComponentSignatureAlgorithm;
    signer: string;
    sign: BuildComponentSignatureOptions["sign"];
  };
  evidence: Required<Pick<EvidenceDeps, "resolvePublicKey" | "verify">>;
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
  if (!exactJson(value)) return null;
  try {
    return deepFreeze(structuredClone(value));
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

function captureDeps(
  source: SellerSessionSettlementPublicationDeps,
): CapturedDeps | null {
  try {
    const receiptStore = ownData(source, "receiptStore");
    const evidenceSigner = ownData(source, "evidenceSigner");
    const evidence = ownData(source, "evidence");
    const anchorEvidence = ownData(source, "anchorEvidence");
    const verifyAnchorReceipt = ownData(source, "verifyAnchorReceipt");
    const resolveEvidence = ownData(source, "resolveEvidence");
    if (!isRecord(receiptStore) || !isRecord(evidenceSigner) || !isRecord(evidence) ||
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
        !["ed25519", "ecdsa-secp256k1", "sr1-aggregate"].includes(String(algorithm)) ||
        !isNonEmpty(signer)) return null;
    const call = <T extends Function>(fn: T, args: unknown[]): unknown =>
      Reflect.apply(fn, INERT_RECEIVER, args);
    return Object.freeze({
      inspectPermit: (permitId: string) =>
        call(inspectPermit, [permitId]) as Promise<SellerReceiptInspectionResult>,
      signer: Object.freeze({
        algorithm: algorithm as ComponentSignatureAlgorithm,
        signer,
        sign: ((bytes: Uint8Array, context: Pick<ComponentSignature, "algorithm" | "signer">) =>
          call(sign, [bytes, context])) as BuildComponentSignatureOptions["sign"],
      }),
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
    "nativeProofRef",
  ]) || !isNonEmpty(snapshot.paymentPermitId) ||
      !validAuthorization(snapshot.authorization) ||
      !isProofRef(snapshot.nativeProofRef)) return null;
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

function signedSettlementId(
  authorization: SellerPaymentAuthorization,
): string | undefined {
  const ref = authorization.evidenceInput.paymentTxRefs[0];
  if (ref.kind === "demos") {
    const txHash = ref.txHash.toLowerCase().replace(/^0x/, "");
    return `demos:${txHash}`;
  }
  if (ref.kind === "x402-event") {
    const txHash = ref.settlementTxHash.toLowerCase().replace(/^0x/, "");
    return `evm:${ref.chainId}:${txHash}:${ref.logIndex}`;
  }
  // Legacy transaction-level x402 evidence has no signed logIndex. Consumers
  // MUST project it through resolveSettlementEventIdentity before granting any
  // event-level authority; this publisher never invents that missing field.
  return undefined;
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
    result: { ok: true as const },
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

/** Stable identity for the complete publication effect and retained proof. */
export function sellerSessionSettlementPublicationEffectId(input: {
  authorization: Readonly<SellerPaymentAuthorization>;
  nativeProofRef: Readonly<SessionSettlementNativeProofRef>;
  evidenceAuthority: Readonly<{
    primaryClaim: string;
    algorithm: ComponentSignatureAlgorithm;
  }>;
}): string {
  if (!validAuthorization(input.authorization) || !isProofRef(input.nativeProofRef) ||
      !isNonEmpty(input.evidenceAuthority?.primaryClaim) ||
      !["ed25519", "ecdsa-secp256k1", "sr1-aggregate"].includes(
        String(input.evidenceAuthority?.algorithm),
      )) throw new TypeError("settlement publication identity input is malformed");
  const authorizationHash = sha256Hex(canonicalize(input.authorization));
  return `seller-settlement:v1:${sha256Hex(canonicalize({
    publicationVersion: "1",
    authorizationHash,
    settlementId: input.authorization.settlementId,
    evidenceHash: input.authorization.evidenceHash,
    nativeProofRef: input.nativeProofRef,
    evidenceAuthority: input.evidenceAuthority,
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
  const deps = captureDeps(depsInput);
  if (!request) return failure("error", "settlement publication request is not exact canonical data");
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
  const projectedSettlementId = signedSettlementId(request.authorization);
  if (projectedSettlementId !== undefined &&
      projectedSettlementId !== request.authorization.settlementId) {
    return failure("rejected", "signed settlement event differs from the authorized settlement identity");
  }

  let effectId: string;
  try {
    effectId = sellerSessionSettlementPublicationEffectId({
      authorization: request.authorization,
      nativeProofRef: request.nativeProofRef,
      evidenceAuthority: {
        primaryClaim: deps.signer.signer,
        algorithm: deps.signer.algorithm,
      },
    });
  } catch {
    return failure("error", "settlement publication identity cannot be derived");
  }

  const unsigned = deepFreeze(structuredClone(request.authorization.evidenceInput));
  const evidenceHash = contentHash(unsigned as unknown as Record<string, unknown>);
  if (evidenceHash !== request.authorization.evidenceHash) {
    return failure("rejected", "payment evidence differs from the store-authorized hash", effectId);
  }
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
  const evidence = deepFreeze({ ...structuredClone(unsigned), signature }) as SettlementEvidence;
  if (!isComponentSignature(signature) || !isSettlementEvidence(evidence) ||
      contentHash(evidence as unknown as Record<string, unknown>) !== evidenceHash) {
    return failure("error", "signed payment evidence is not normative", effectId);
  }

  const context = evidenceContext(request.authorization);
  context.orchestrator = deps.signer.signer;
  const signatureCheck = await verifySettlementEvidence(evidence, context, deps.evidence);
  if (signatureCheck.decision !== "pass") {
    return failure(
      mapEvidenceDecision(signatureCheck.decision),
      `signed payment evidence verification failed: ${signatureCheck.reasons.join("; ")}`,
      effectId,
    );
  }

  const logicalAddress =
    `dacs4:payment:${request.authorization.jobId}:` +
    `${encodeAddressSegment(request.authorization.railId)}:` +
    `${request.authorization.phaseIndex}`;
  const anchorInput = deepFreeze({
    effectId,
    logicalAddress,
    evidenceHash,
    evidence: structuredClone(evidence),
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
      anchorReceipt.writer !== deps.signer.signer ||
      anchorReceipt.state !== "finalized" ||
      anchorReceipt.observationDisposition !== "established") {
    return failure("rejected", "publication lacks the exact finalized evidence binding", effectId);
  }

  const receiptInput = deepFreeze({
    effectId,
    expectedWriter: deps.signer.signer,
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
  const readCheck = await verifySettlementEvidence(
    readEvidence,
    { ...context, attestationRef: evidenceRef },
    deps.evidence,
  );
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
    nativeProofRef: structuredClone(request.nativeProofRef),
  });
  return deepFreeze({
    disposition: "published" as const,
    effectId,
    authorizationHash,
    evidenceHash,
    settlement,
  });
}
