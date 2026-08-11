import { canonicalize, contentHash, encodeAddressSegment, sha256Hex } from "../canonical/index.js";
import type {
  AttestationRef,
  ComponentSignature,
  CompositeVerificationRecord,
  SupplementarySignal,
  VerificationDecision,
  VerificationWarning,
  VerifyResult,
  VerifyResultRef,
} from "../artifacts/types.js";
import {
  isAttestationRef,
  isCompositeVerificationRecord,
  isExactJsonRecord,
  isVerifyResult,
} from "../artifacts/validators.js";
import {
  signComponentArtifact,
  type BuildComponentSignatureOptions,
} from "../artifacts/signatures.js";
import { ed25519Verify, publicKeyFromRaw, signedBytes } from "../crypto/index.js";
import { DacsError } from "../errors.js";
import {
  isAuthenticatedRecipeDescriptor,
  type AuthenticatedRecipeDescriptor,
} from "../registry/resolve.js";
import type {
  RecipeDescriptor,
  VerificationMethod,
} from "../registry/types.js";
import {
  aggregateCompositeVerification,
  isCompositeBundleRequirement,
  verifyResultRefFromAnchor,
  type CompositeClaimRequirement,
  type CompositeBundleRequirement,
} from "./compositeVerification.js";
import {
  evaluateParserSpec,
  defaultParserEngine,
  type ParserEngine,
} from "./parserSpec.js";

/** SIG-4 domain for the method-native self-signed assertion evidence. */
export const SELF_SIGNED_ASSERTION_SEPARATOR =
  "dacs-x-self-signed-assertion:v1:" as const;

const KEY_CLAIM = /^key:([0-9a-f]{64})(?:\?(.+))?$/;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/;

function deepFreezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  if (ArrayBuffer.isView(value)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreezeSnapshot(child, seen);
  }
  return Object.freeze(value);
}

function snapshotValue(
  value: unknown,
  label: string,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") {
      throw new DacsError(`${label} must contain only data values`);
    }
    return value;
  }
  if (seen.has(value)) {
    throw new DacsError(`${label} must be acyclic`);
  }
  seen.add(value);
  if (
    value instanceof Uint8Array &&
    Object.getPrototypeOf(value) === Uint8Array.prototype
  ) {
    const copy = Uint8Array.from(value);
    seen.delete(value);
    return copy;
  }
  let descriptors: PropertyDescriptorMap;
  let symbols: symbol[];
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    symbols = Object.getOwnPropertySymbols(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new DacsError(`${label} fields could not be captured`);
  }
  if (symbols.length !== 0) {
    throw new DacsError(`${label} cannot contain symbol fields`);
  }
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new DacsError(`${label} arrays must use the intrinsic prototype`);
    }
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    ) {
      throw new DacsError(`${label} arrays must be dense data arrays`);
    }
    const copy = keys.map((key) => {
      const descriptor = descriptors[key]!;
      if (
        descriptor.enumerable !== true ||
        !("value" in descriptor)
      ) {
        throw new DacsError(`${label} cannot contain accessors`);
      }
      return snapshotValue(descriptor.value, label, seen);
    });
    seen.delete(value);
    return copy;
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DacsError(`${label} must contain only plain records`);
  }
  const copy: Record<string, unknown> = prototype === null
    ? Object.create(null) as Record<string, unknown>
    : {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      throw new DacsError(`${label} cannot contain accessors or hidden fields`);
    }
    copy[key] = snapshotValue(descriptor.value, label, seen);
  }
  seen.delete(value);
  return copy;
}

function snapshot<T>(value: T, label: string): T {
  return snapshotValue(value, label, new WeakSet()) as T;
}

function captureVetDeps(source: VetDeps): VetDeps {
  try {
    const proxyFetch = source.proxyFetch.bind(source);
    const nowMs = source.nowMs.bind(source);
    const anchorFinalizedArtifact = source.anchorFinalizedArtifact.bind(source);
    const verifyFinalizedAnchor = source.verifyFinalizedAnchor.bind(source);
    const readAnchoredJson = source.readAnchoredJson.bind(source);
    const resolveFinalizedArtifact =
      source.resolveFinalizedArtifact.bind(source);
    const operationStoreSource = source.operationStore;
    const operationStore = Object.freeze({
      load: operationStoreSource.load.bind(operationStoreSource),
      compareAndSet:
        operationStoreSource.compareAndSet.bind(operationStoreSource),
      runOnce: operationStoreSource.runOnce.bind(operationStoreSource),
    });
    const matchRequirementParameters =
      source.matchRequirementParameters?.bind(source);
    const signerSource = source.componentSigner;
    const componentSigner: BuildComponentSignatureOptions = Object.freeze({
      algorithm: signerSource.algorithm,
      signer: signerSource.signer,
      sign: signerSource.sign.bind(signerSource),
    });
    const parserSource = source.parserEngine;
    const parserEngine = parserSource
      ? Object.freeze({
          evalPredicate: parserSource.evalPredicate.bind(parserSource),
          ...(parserSource.extract
            ? { extract: parserSource.extract.bind(parserSource) }
            : {}),
        })
      : undefined;
    return Object.freeze({
      proxyFetch,
      nowMs,
      componentSigner,
      anchorFinalizedArtifact,
      verifyFinalizedAnchor,
      readAnchoredJson,
      resolveFinalizedArtifact,
      operationStore,
      ...(matchRequirementParameters ? { matchRequirementParameters } : {}),
      ...(parserEngine ? { parserEngine } : {}),
    });
  } catch {
    throw new DacsError("Vet dependencies must expose stable callable capabilities");
  }
}

function readClock(nowMs: () => number, label: string, floor?: number): number {
  let value: number;
  try {
    value = nowMs();
  } catch {
    throw new DacsError(`${label} clock failed`);
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DacsError(`${label} must be a non-negative safe integer`);
  }
  if (floor !== undefined && value < floor) {
    throw new DacsError(`${label} precedes the prior verified event`);
  }
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function isFinalizedVetAnchorReceipt(
  value: unknown,
): value is FinalizedVetAnchorReceipt {
  if (!isExactJsonRecord(value)) return false;
  const transactionRef = value.transactionRef;
  const blockRef = value.blockRef;
  const evidence = value.evidence;
  return (
    hasExactKeys(value, [
      "receiptVersion",
      "substrate",
      "finalityProfile",
      "logicalAddress",
      "nativeAddress",
      "contentHash",
      "transactionRef",
      "writer",
      ...(value.nonce === undefined ? [] : ["nonce"]),
      "state",
      "observationDisposition",
      "observedAt",
      "blockRef",
      "evidence",
    ]) &&
    value.receiptVersion === "1" &&
    typeof value.substrate === "string" && value.substrate.length > 0 &&
    typeof value.finalityProfile === "string" && value.finalityProfile.length > 0 &&
    typeof value.logicalAddress === "string" && value.logicalAddress.length > 0 &&
    typeof value.nativeAddress === "string" && value.nativeAddress.length > 0 &&
    typeof value.contentHash === "string" && /^[0-9a-f]{64}$/.test(value.contentHash) &&
    isExactJsonRecord(transactionRef) &&
    hasExactKeys(transactionRef, ["kind", "value"]) &&
    typeof transactionRef.kind === "string" && transactionRef.kind.length > 0 &&
    typeof transactionRef.value === "string" && transactionRef.value.length > 0 &&
    typeof value.writer === "string" && value.writer.length > 0 &&
    (value.nonce === undefined || typeof value.nonce === "string") &&
    value.state === "finalized" &&
    value.observationDisposition === "established" &&
    Number.isSafeInteger(value.observedAt) &&
    (value.observedAt as number) >= 0 &&
    isExactJsonRecord(blockRef) &&
    hasExactKeys(blockRef, [
      "id",
      ...(blockRef.height === undefined ? [] : ["height"]),
      ...(blockRef.timestamp === undefined ? [] : ["timestamp"]),
    ]) &&
    typeof blockRef.id === "string" && blockRef.id.length > 0 &&
    (blockRef.height === undefined ||
      (typeof blockRef.height === "string" && /^(0|[1-9][0-9]*)$/.test(blockRef.height))) &&
    (blockRef.timestamp === undefined ||
      (Number.isSafeInteger(blockRef.timestamp) && (blockRef.timestamp as number) >= 0)) &&
    isExactJsonRecord(evidence) &&
    hasExactKeys(evidence, ["kind", "value"]) &&
    typeof evidence.kind === "string" && evidence.kind.length > 0 &&
    typeof evidence.value === "string" && evidence.value.length > 0
  );
}

async function authenticateFinalizedJson(
  logicalAddress: string,
  artifact: Record<string, unknown>,
  anchor: FinalizedVetAnchor,
  deps: VetDeps,
  validate: (value: unknown) => boolean,
  hashArtifact: (value: Record<string, unknown>) => string = contentHash,
): Promise<FinalizedVetAnchor> {
  if (!isExactJsonRecord(artifact)) {
    throw new DacsError(`${logicalAddress} artifact must be exact JSON data`);
  }
  const artifactSnapshot = deepFreezeSnapshot(
    snapshot(artifact, `${logicalAddress} artifact`),
  );
  const expectedHash = hashArtifact(artifactSnapshot);
  if (!isFinalizedVetAnchor(anchor)) {
    throw new DacsError(`${logicalAddress} returned a malformed finalized anchor`);
  }
  const anchored = snapshot(anchor, `${logicalAddress} anchor result`);
  if (
    !isRecord(anchored) ||
    !isAttestationRef(anchored.ref) ||
    !isFinalizedVetAnchorReceipt(anchored.receipt) ||
    anchored.ref.contentHash !== expectedHash ||
    anchored.ref.anchor.locator !== anchored.receipt.nativeAddress ||
    anchored.receipt.logicalAddress !== logicalAddress ||
    anchored.receipt.contentHash !== expectedHash
  ) {
    throw new DacsError(`${logicalAddress} returned a malformed or mismatched finalized anchor`);
  }
  let receiptValid = false;
  try {
    receiptValid =
      (await deps.verifyFinalizedAnchor(
        deepFreezeSnapshot({
          logicalAddress,
          artifact: deepFreezeSnapshot(snapshot(artifactSnapshot, "receipt artifact input")),
          ref: deepFreezeSnapshot(snapshot(anchored.ref, "receipt ref input")),
          receipt: deepFreezeSnapshot(snapshot(anchored.receipt, "receipt input")),
        }),
      )) === true;
  } catch {
    receiptValid = false;
  }
  if (!receiptValid) {
    throw new DacsError(`${logicalAddress} finalized receipt did not authenticate`);
  }
  const returnedReadback = await deps.readAnchoredJson(
    deepFreezeSnapshot(snapshot(anchored.ref, "readback ref input")),
  );
  if (
    returnedReadback !== null &&
    (!isExactJsonRecord(returnedReadback) || !validate(returnedReadback))
  ) {
    throw new DacsError(`${logicalAddress} finalized readback is malformed`);
  }
  const readback = returnedReadback === null
    ? null
    : deepFreezeSnapshot(snapshot(returnedReadback, `${logicalAddress} readback`));
  if (
    readback === null ||
    !validate(readback) ||
    hashArtifact(readback) !== expectedHash ||
    canonicalize(readback) !== canonicalize(artifactSnapshot)
  ) {
    throw new DacsError(`${logicalAddress} finalized readback does not match exact signed bytes`);
  }
  return {
    ref: snapshot(anchored.ref, "finalized ref"),
    receipt: snapshot(anchored.receipt, "finalized receipt"),
  };
}

async function persistFinalizedJson(
  logicalAddress: string,
  artifact: Record<string, unknown>,
  deps: VetDeps,
  validate: (value: unknown) => boolean,
  hashArtifact: (value: Record<string, unknown>) => string = contentHash,
): Promise<FinalizedVetAnchor> {
  const artifactSnapshot = deepFreezeSnapshot(
    snapshot(artifact, `${logicalAddress} artifact`),
  );
  const anchored = await deps.anchorFinalizedArtifact(
    deepFreezeSnapshot({
      logicalAddress,
      artifact: deepFreezeSnapshot(
        snapshot(artifactSnapshot, "anchor artifact input"),
      ),
    }),
  );
  return authenticateFinalizedJson(
    logicalAddress,
    artifactSnapshot,
    anchored,
    deps,
    validate,
    hashArtifact,
  );
}

function parseCanonicalKeyClaim(value: string): { identifier: string } | null {
  if (value.normalize("NFC") !== value) return null;
  const match = KEY_CLAIM.exec(value);
  if (!match) return null;
  const query = match[2];
  if (query === undefined) return { identifier: match[1]! };
  const keys: string[] = [];
  for (const parameter of query.split("&")) {
    const equals = parameter.indexOf("=");
    if (equals <= 0 || equals !== parameter.lastIndexOf("=")) return null;
    const key = parameter.slice(0, equals);
    const parameterValue = parameter.slice(equals + 1);
    if (
      !key ||
      /[:?&=]/.test(key) ||
      /[:?&=]/.test(parameterValue) ||
      /%(?!3A|3F|26|3D|25)/.test(key) ||
      /%(?!3A|3F|26|3D|25)/.test(parameterValue) ||
      keys.includes(key)
    ) {
      return null;
    }
    keys.push(key);
  }
  if (!keys.every((key, index) => index === 0 || keys[index - 1]! < key)) return null;
  return { identifier: match[1]! };
}

/** Exact proof supplied to the DACS-2 §7.3.9 self-signed method. */
export interface SelfSignedMethodInput {
  assertion: string;
  /** Method-native Ed25519 signature as 128 lowercase hex characters. */
  signature: string;
}

export interface SelfSignedAttestationArtifact {
  assertionVersion: "1";
  subject: string;
  assertion: string;
  signature: string;
}

export interface SelfSignedAnchorInput {
  logicalAddress: string;
  artifact: SelfSignedAttestationArtifact;
}

export function selfSignedAssertionBytes(assertion: string): Uint8Array {
  if (!parseCanonicalKeyClaim(assertion)) {
    throw new DacsError(
      "self-signed assertion must be a canonical key:<64-lowercase-hex> ClaimReference",
    );
  }
  return signedBytes(SELF_SIGNED_ASSERTION_SEPARATOR, sha256Hex(assertion));
}

/** DACS-2 CM-2 logical address for self-signed method evidence. */
export function selfSignedAssertionAddress(
  jobId: string,
  subject: string,
  recipeVersion: number,
): string {
  const claim = parseCanonicalKeyClaim(subject);
  if (!claim || !jobId || !Number.isSafeInteger(recipeVersion) || recipeVersion <= 0) {
    throw new DacsError("self-signed assertion address requires current job/claim/version");
  }
  return (
    `dacs2:evidence:${encodeAddressSegment(jobId)}:key:` +
    `${encodeAddressSegment(claim.identifier)}:v${recipeVersion}`
  );
}

function claimParts(claim: string): { scheme: string; identifier: string } {
  if (claim.normalize("NFC") !== claim) {
    throw new DacsError("Vet subject must be NFC-normalised");
  }
  const colon = claim.indexOf(":");
  if (colon <= 0 || !/^[a-z][a-z0-9-]*$/.test(claim.slice(0, colon))) {
    throw new DacsError("Vet subject must be a canonical ClaimReference");
  }
  const scheme = claim.slice(0, colon);
  const identifier = claim.slice(colon + 1).split("?", 1)[0]!;
  if (!identifier) throw new DacsError("Vet subject ClaimReference has no identifier");
  return { scheme, identifier };
}

function reasonFor(decision: VerificationDecision): string {
  switch (decision) {
    case "pass":
      return "authority confirmed claim";
    case "fail":
      return "authority contradicted claim";
    case "indeterminate":
      return "authority response was inconclusive";
    case "error":
      return "verification could not complete";
  }
}

function mapProxyStatus(
  httpStatus: number,
  negativeMatch: boolean,
): VerificationDecision | null {
  if (httpStatus >= 200 && httpStatus < 300) return null;
  if (httpStatus === 404) return negativeMatch ? "indeterminate" : "fail";
  return "error";
}

export interface VetProxyResult {
  status: number;
  /** Exact UTF-8 authority response bytes used for parsing and raw-byte hashing. */
  body: string;
  /** Independently resolvable SR-2 reference to those exact response bytes. */
  attestation: AttestationRef;
  fetchedAt: number;
  complete?: boolean;
}

function isVetProxyResult(value: unknown): value is VetProxyResult {
  if (!isExactJsonRecord(value)) return false;
  return (
    hasExactKeys(value, [
      "status",
      "body",
      "attestation",
      "fetchedAt",
      ...(value.complete === undefined ? [] : ["complete"]),
    ]) &&
    Number.isSafeInteger(value.status) &&
    (value.status as number) >= 100 &&
    (value.status as number) <= 599 &&
    typeof value.body === "string" &&
    isAttestationRef(value.attestation) &&
    Number.isSafeInteger(value.fetchedAt) &&
    (value.fetchedAt as number) >= 0 &&
    (value.complete === undefined || typeof value.complete === "boolean")
  );
}

/** CORE §5.1 finalized SR-2 receipt used by the current Vet write path. */
export interface FinalizedVetAnchorReceipt {
  receiptVersion: "1";
  substrate: string;
  finalityProfile: string;
  logicalAddress: string;
  nativeAddress: string;
  contentHash: string;
  transactionRef: { kind: string; value: string };
  writer: string;
  nonce?: string;
  state: "finalized";
  observationDisposition: "established";
  observedAt: number;
  blockRef: { id: string; height?: string; timestamp?: number };
  evidence: { kind: string; value: string };
}

export interface FinalizedVetAnchor {
  ref: AttestationRef;
  receipt: FinalizedVetAnchorReceipt;
}

export interface VetProduction {
  record: CompositeVerificationRecord;
  recordRef: AttestationRef;
  anchorReceipt: FinalizedVetAnchorReceipt;
}

export interface VetMethodOutcome {
  decision: VerificationDecision;
  attestation: AttestationRef;
  fetchedAt: number;
  verifiedAt: number;
  data?: Record<string, unknown>;
}

/**
 * Durable state for one immutable Vet output namespace. The operation key is
 * the composite logical address; `operationHash` binds every semantic input to
 * that namespace. A `*-submitting` state is deliberately reconciliation-only
 * after restart: a process may submit only when it performed that exact CAS.
 */
export type VetOperationCheckpoint =
  | {
      operationVersion: "1";
      operationKey: string;
      operationHash: string;
      stage: "intent";
    }
  | {
      operationVersion: "1";
      operationKey: string;
      operationHash: string;
      stage: "method-complete";
      methodOutcome: VetMethodOutcome;
      methodOutcomeHash: string;
    }
  | {
      operationVersion: "1";
      operationKey: string;
      operationHash: string;
      stage: "result-submitting";
      resultAddress: string;
      result: VerifyResult;
      resultArtifactHash: string;
    }
  | {
      operationVersion: "1";
      operationKey: string;
      operationHash: string;
      stage: "result-finalized";
      resultAddress: string;
      result: VerifyResult;
      resultArtifactHash: string;
      resultAnchor: FinalizedVetAnchor;
    }
  | {
      operationVersion: "1";
      operationKey: string;
      operationHash: string;
      stage: "composite-submitting";
      resultAddress: string;
      result: VerifyResult;
      resultArtifactHash: string;
      resultAnchor: FinalizedVetAnchor;
      recordAddress: string;
      record: CompositeVerificationRecord;
      recordArtifactHash: string;
    }
  | {
      operationVersion: "1";
      operationKey: string;
      operationHash: string;
      stage: "complete";
      resultAddress: string;
      result: VerifyResult;
      resultArtifactHash: string;
      resultAnchor: FinalizedVetAnchor;
      recordAddress: string;
      record: CompositeVerificationRecord;
      recordArtifactHash: string;
      recordAnchor: FinalizedVetAnchor;
    };

/**
 * Durable, atomic operation journal. A `null` load must mean definitively absent;
 * lookup errors are indeterminate. `compareAndSet` compares exact canonical
 * checkpoint bytes and durably commits `next` before returning exact `true`.
 * `runOnce` durably journals the exact step input, serializes/fences concurrent
 * callers, invokes `execute` at most once, and durably stores either its exact
 * result or terminal failure. A retry replays that result/failure and never
 * invokes the executor again. This is the boundary that closes the unavoidable
 * process-crash gap between an external method/sign/anchor call and WAL update.
 */
export interface VetOperationStore {
  load: (operationKey: string) => Promise<unknown>;
  compareAndSet: (input: {
    operationKey: string;
    expected: Readonly<VetOperationCheckpoint> | null;
    next: Readonly<VetOperationCheckpoint>;
  }) => Promise<boolean>;
  runOnce: (input: {
    operationKey: string;
    operationHash: string;
    step:
      | "method"
      | "method-evidence"
      | "verify-result"
      | "verify-result-anchor"
      | "composite"
      | "composite-anchor";
    inputHash: string;
    execute: () => Promise<unknown>;
  }) => Promise<unknown>;
}

export interface VetDeps {
  proxyFetch: (req: {
    url: string;
    method: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
  }) => Promise<VetProxyResult>;
  nowMs: () => number;
  parserEngine?: ParserEngine;
  /** Verifier signer used for both VerifyResults and the composite record. */
  componentSigner: BuildComponentSignatureOptions;
  /**
   * Idempotently submit the exact canonical artifact bytes and reconcile the
   * same transaction until CORE §5.1 `finalized`. Response loss MUST be
   * recovered by logical address + content hash, never by creating a second
   * logical record.
   */
  anchorFinalizedArtifact: (input: {
    logicalAddress: string;
    artifact: Readonly<Record<string, unknown>>;
  }) => Promise<FinalizedVetAnchor>;
  /** Cryptographically authenticate the binding-specific receipt evidence. */
  verifyFinalizedAnchor: (input: {
    logicalAddress: string;
    artifact: Readonly<Record<string, unknown>>;
    ref: Readonly<AttestationRef>;
    receipt: Readonly<FinalizedVetAnchorReceipt>;
  }) => Promise<boolean> | boolean;
  /** Independent SR-2 readback of the exact finalized artifact. */
  readAnchoredJson: (
    ref: Readonly<AttestationRef>,
  ) => Promise<Record<string, unknown> | null>;
  /**
   * Exact-hash lookup used before submission and to reconcile response loss.
   * `null` means definitely absent; errors are indeterminate and fail closed.
   */
  resolveFinalizedArtifact: (input: {
    logicalAddress: string;
    contentHash: string;
  }) => Promise<FinalizedVetAnchor | null>;
  /** Required durable WAL/CAS seam for restart-safe Vet production. */
  operationStore: VetOperationStore;
  /**
   * Method-specific enforcement of the exact authenticated
   * ClaimRequirement.parameters against extracted, attested data. Required
   * whenever `parameters` is present; only exact boolean `true` is a match.
   */
  matchRequirementParameters?: (input: {
    requirement: Readonly<CompositeClaimRequirement>;
    subject: string;
    recipe: Readonly<RecipeDescriptor & { signature: ComponentSignature }>;
    method: Readonly<VerificationMethod>;
    decision: VerificationDecision;
    attestation: Readonly<AttestationRef>;
    data?: Readonly<Record<string, unknown>>;
  }) => Promise<boolean> | boolean;
}

export interface VetRequest {
  jobId: string;
  /** Counterparty primary ClaimReference. */
  subject: string;
  /** Hash of the exact IdentityBundle this run evaluates. */
  bundleHash: string;
  requirement: CompositeBundleRequirement;
  /** Exact, steward-authenticated recipe returned by resolveRecipe(). */
  recipe: AuthenticatedRecipeDescriptor;
  classification?: "freshness" | "dealSpecific";
  supplementary?: SupplementarySignal[];
  warnings?: VerificationWarning[];
  selfSigned?: SelfSignedMethodInput;
}

const VET_REQUEST_KEYS = new Set([
  "jobId",
  "subject",
  "bundleHash",
  "requirement",
  "recipe",
  "classification",
  "supplementary",
  "warnings",
  "selfSigned",
]);

const REQUIRED_VET_REQUEST_KEYS = [
  "jobId",
  "subject",
  "bundleHash",
  "requirement",
  "recipe",
] as const;

/**
 * Capture the request without performing property reads. In particular, the
 * authenticated recipe provenance check and the later snapshot must operate on
 * the same object. Reading `request.recipe` and then cloning `request` would
 * allow an accessor to return a branded recipe for the first read and forged
 * recipe bytes for the clone.
 */
function captureVetRequest(source: VetRequest): VetRequest {
  if (!isRecord(source)) {
    throw new DacsError("Vet request must be a plain record");
  }
  let descriptors: PropertyDescriptorMap;
  try {
    const prototype = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new DacsError("Vet request must be a plain record");
    }
    if (Object.getOwnPropertySymbols(source).length !== 0) {
      throw new DacsError("Vet request cannot contain symbol fields");
    }
    descriptors = Object.getOwnPropertyDescriptors(source);
  } catch (error) {
    if (error instanceof DacsError) throw error;
    throw new DacsError("Vet request fields could not be captured");
  }

  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]!;
    if (
      !VET_REQUEST_KEYS.has(key) ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.value === undefined
    ) {
      throw new DacsError(
        "Vet request must contain only defined own enumerable data properties",
      );
    }
  }
  for (const key of REQUIRED_VET_REQUEST_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) {
      throw new DacsError(`Vet request is missing required field ${key}`);
    }
  }

  const recipe = descriptors.recipe!.value;
  if (!isAuthenticatedRecipeDescriptor(recipe)) {
    throw new DacsError(
      "Vet requires an exact steward-authenticated recipe returned by resolveRecipe",
    );
  }

  const captured: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    captured[key] = descriptor.value;
  }
  return deepFreezeSnapshot(
    snapshot(captured, "Vet request"),
  ) as unknown as VetRequest;
}

async function selfSignedAttestation(
  req: VetRequest,
  deps: VetDeps,
  operation: {
    operationKey: string;
    operationHash: string;
    store: VetOperationStore;
  },
): Promise<{ decision: VerificationDecision; attestation: AttestationRef }> {
  const subject = parseCanonicalKeyClaim(req.subject);
  const input = req.selfSigned;
  if (
    !subject ||
    !input ||
    !parseCanonicalKeyClaim(input.assertion) ||
    !SIGNATURE_HEX.test(input.signature)
  ) {
    throw new DacsError("self-signed verification requires a canonical proof and SR-2 anchor");
  }

  const asserted = parseCanonicalKeyClaim(input.assertion)!;
  let decision: VerificationDecision;
  if (asserted.identifier !== subject.identifier) {
    decision = "fail";
  } else {
    try {
      const signature = Uint8Array.from(Buffer.from(input.signature, "hex"));
      const key = Uint8Array.from(Buffer.from(subject.identifier, "hex"));
      decision = ed25519Verify(
        selfSignedAssertionBytes(input.assertion),
        signature,
        publicKeyFromRaw(key),
      )
        ? "pass"
        : "fail";
    } catch {
      decision = "error";
    }
  }

  const artifact: SelfSignedAttestationArtifact = {
    assertionVersion: "1",
    subject: req.subject,
    assertion: input.assertion,
    signature: input.signature,
  };
  const logicalAddress = selfSignedAssertionAddress(
    req.jobId,
    req.subject,
    req.recipe.recipeVersion,
  );
  const validate = (value: unknown) =>
    isRecord(value) &&
    value.assertionVersion === "1" &&
    value.subject === artifact.subject &&
    value.assertion === artifact.assertion &&
    value.signature === artifact.signature;
  const evidenceInputHash = exactArtifactHash({ logicalAddress, artifact });
  const anchoredValue = await runVetStep(
    operation.store,
    operation,
    "method-evidence",
    evidenceInputHash,
    () => reconcileOrPersistFinalizedJson(
      logicalAddress,
      artifact as unknown as Record<string, unknown>,
      deps,
      validate,
      (value) => sha256Hex(canonicalize(value)),
    ),
  );
  if (!isFinalizedVetAnchor(anchoredValue)) {
    throw new DacsError("self-signed evidence step returned a corrupt anchor");
  }
  const anchored = await authenticateFinalizedJson(
    logicalAddress,
    artifact as unknown as Record<string, unknown>,
    anchoredValue,
    deps,
    validate,
    (value) => sha256Hex(canonicalize(value)),
  );
  const expectedHash = sha256Hex(canonicalize(artifact));
  if (anchored.ref.contentHash !== expectedHash || anchored.ref.signer !== req.subject) {
    throw new DacsError("self-signed SR-2 anchor does not bind the exact proof and signer");
  }
  return { decision, attestation: anchored.ref };
}

async function proxyAttestation(
  req: VetRequest,
  deps: VetDeps,
  method: Extract<VerificationMethod, { kind: "consensus-backed-proxy" }>,
  requirement: CompositeClaimRequirement,
): Promise<{
  decision: VerificationDecision;
  attestation: AttestationRef;
  fetchedAt: number;
  data?: Record<string, unknown>;
}> {
  const { identifier } = claimParts(req.subject);
  if (
    requirement.parameters !== undefined &&
    Object.prototype.hasOwnProperty.call(requirement.parameters, "identifier")
  ) {
    throw new DacsError(
      "ClaimRequirement.parameters.identifier is reserved for the canonical subject",
    );
  }
  const values: Record<string, unknown> = {
    ...(requirement.parameters ?? {}),
    identifier,
  };
  const url = method.endpoint.urlTemplate.replace(
    /\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (_placeholder, key: string) => {
      const value = values[key];
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        throw new DacsError(`recipe URL template parameter "${key}" is unavailable`);
      }
      return encodeURIComponent(String(value));
    },
  );
  if (!url || /\{[^}]+\}/.test(url)) {
    throw new DacsError("consensus-backed-proxy URL template is incomplete");
  }
  const rawResponse = await deps.proxyFetch(
      deepFreezeSnapshot({
        url,
        method: method.endpoint.method,
        ...(method.endpoint.headers
          ? { headers: snapshot(method.endpoint.headers, "proxy headers") }
          : {}),
        ...(method.endpoint.body !== undefined
          ? { body: method.endpoint.body }
          : {}),
      }),
  );
  if (!isVetProxyResult(rawResponse)) {
    throw new DacsError("proxy result must be exact JSON evidence");
  }
  const response = snapshot(rawResponse, "proxy verification response");
  if (
    !isAttestationRef(response.attestation) ||
    response.attestation.signer === undefined ||
    response.attestation.contentHash !== sha256Hex(response.body) ||
    !Number.isSafeInteger(response.fetchedAt) ||
    response.fetchedAt < 0
  ) {
    throw new DacsError("proxy result is not exact, signer-authenticated SR-2 evidence");
  }

  const negativeMatch = req.recipe.negativeMatch === true;
  let decision = mapProxyStatus(response.status, negativeMatch);
  let data: Record<string, unknown> | undefined;
  if (decision === null) {
    try {
      const evaluation = evaluateParserSpec(
        req.recipe.parserRules,
        response.body,
        deps.parserEngine ?? defaultParserEngine,
        {
          negativeMatch,
          // A negative result founded on absence is never trusted unless the
          // attested response is independently complete (PSP-5).
          requiresCompleteness: negativeMatch,
          listComplete: response.complete === true,
        },
      );
      decision = evaluation.decision;
      data = evaluation.data;
    } catch {
      decision = "error";
    }
  }
  return {
    decision,
    attestation: snapshot(response.attestation, "proxy attestation"),
    fetchedAt: response.fetchedAt,
    ...(data ? { data: snapshot(data, "proxy extraction") } : {}),
  };
}

function verifyResultAddress(
  jobId: string,
  scheme: string,
  identifier: string,
  recipeVersion: number,
): string {
  return (
    `dacs2:${encodeAddressSegment(jobId)}:${scheme}:` +
    `${encodeAddressSegment(identifier)}:v${recipeVersion}`
  );
}

/** DACS-2 §7.7.2 logical address for the finalized composite record. */
export function compositeVerificationAddress(
  jobId: string,
  evaluatedParty: string,
): string {
  if (!jobId || !evaluatedParty || evaluatedParty.normalize("NFC") !== evaluatedParty) {
    throw new DacsError("composite address requires a job and canonical evaluated party");
  }
  return (
    `dacs2:composite:${encodeAddressSegment(jobId)}:` +
    encodeAddressSegment(evaluatedParty)
  );
}

function selectExactRequirement(
  requirement: CompositeBundleRequirement,
  scheme: string,
  recipeVersion: number,
): CompositeClaimRequirement {
  const candidates = [
    ...requirement.required,
    ...(requirement.oneOf ?? []).flat(),
  ].filter(
    (claim) =>
      claim.scheme === scheme &&
      claim.recipeVersion === recipeVersion,
  );
  if (candidates.length === 0) {
    throw new DacsError(
      `requirement for ${scheme} must pin authenticated recipe v${recipeVersion}`,
    );
  }
  const distinct = new Map(
    candidates.map((claim) => [canonicalize(claim), claim] as const),
  );
  if (distinct.size !== 1) {
    throw new DacsError(
      `ambiguous complementary requirements for ${scheme}; exact provenance is required`,
    );
  }
  return snapshot([...distinct.values()][0]!, "selected claim requirement");
}

function selectVerificationMethod(
  recipe: RecipeDescriptor,
  requirement: CompositeClaimRequirement,
): VerificationMethod {
  const requested = requirement.parameters?.verificationMethod;
  if (requested !== undefined && typeof requested !== "string") {
    throw new DacsError("ClaimRequirement.parameters.verificationMethod must be a string");
  }
  const kind = requested ?? recipe.defaultMethod.kind;
  const matches = [recipe.defaultMethod, ...(recipe.alternatives ?? [])].filter(
    (method) => method.kind === kind,
  );
  if (matches.length !== 1) {
    throw new DacsError(
      `recipe does not unambiguously authorize verification method ${kind}`,
    );
  }
  return snapshot(matches[0]!, "selected verification method");
}

function vetOperationHash(
  req: VetRequest,
  signer: BuildComponentSignatureOptions,
): string {
  const identity = {
    operationVersion: "1",
    jobId: req.jobId,
    evaluatedParty: req.subject,
    bundleHash: req.bundleHash,
    requirement: req.requirement,
    recipe: req.recipe,
    classification: req.classification ?? "dealSpecific",
    supplementary: req.supplementary ?? [],
    ...(req.warnings !== undefined ? { warnings: req.warnings } : {}),
    ...(req.selfSigned !== undefined ? { selfSigned: req.selfSigned } : {}),
    verifier: { algorithm: signer.algorithm, signer: signer.signer },
  };
  try {
    return sha256Hex(canonicalize(identity));
  } catch {
    throw new DacsError("Vet operation identity is not canonicalizable");
  }
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function exactArtifactHash(value: unknown): string {
  try {
    return sha256Hex(canonicalize(value));
  } catch {
    throw new DacsError("Vet durable artifact is not canonicalizable");
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isFinalizedVetAnchor(value: unknown): value is FinalizedVetAnchor {
  return (
    isExactJsonRecord(value) &&
    hasExactKeys(value, ["ref", "receipt"]) &&
    isAttestationRef(value.ref) &&
    isFinalizedVetAnchorReceipt(value.receipt)
  );
}

interface VetCheckpointContext {
  operationKey: string;
  operationHash: string;
  resultAddress: string;
  recordAddress: string;
  scheme: string;
  identifier: string;
  method: VerificationMethod["kind"];
  recipeVersion: number;
  req: VetRequest;
  signer: BuildComponentSignatureOptions;
}

type VetOperationStep = Parameters<
  VetOperationStore["runOnce"]
>[0]["step"];

function captureMethodOutcome(value: unknown): VetMethodOutcome {
  if (!isExactJsonRecord(value)) {
    throw new DacsError("Vet method outcome is not exact JSON data");
  }
  const outcome = snapshot(value, "Vet method outcome");
  if (
    !isRecord(outcome) ||
    !hasExactKeys(outcome, [
      "decision",
      "attestation",
      "fetchedAt",
      "verifiedAt",
      ...(outcome.data === undefined ? [] : ["data"]),
    ]) ||
    (outcome.decision !== "pass" &&
      outcome.decision !== "fail" &&
      outcome.decision !== "indeterminate" &&
      outcome.decision !== "error") ||
    !isAttestationRef(outcome.attestation) ||
    !Number.isSafeInteger(outcome.fetchedAt) ||
    (outcome.fetchedAt as number) < 0 ||
    !Number.isSafeInteger(outcome.verifiedAt) ||
    (outcome.verifiedAt as number) < (outcome.fetchedAt as number) ||
    (outcome.data !== undefined && !isExactJsonRecord(outcome.data))
  ) {
    throw new DacsError("Vet method outcome is corrupt or mismatched");
  }
  return outcome as unknown as VetMethodOutcome;
}

async function runVetStep(
  store: VetOperationStore,
  context: Pick<VetCheckpointContext, "operationKey" | "operationHash">,
  step: VetOperationStep,
  inputHash: string,
  execute: () => Promise<unknown>,
): Promise<unknown> {
  if (!/^[0-9a-f]{64}$/.test(inputHash)) {
    throw new DacsError(`Vet ${step} step requires an exact input hash`);
  }
  try {
    const raw = await store.runOnce(
        deepFreezeSnapshot({
          operationKey: context.operationKey,
          operationHash: context.operationHash,
          step,
          inputHash,
          execute,
        }),
      );
    if (!isExactJsonRecord(raw)) {
      throw new DacsError(`Vet ${step} result is not exact JSON data`);
    }
    return snapshot(raw, `Vet ${step} result`);
  } catch (error) {
    const detail = error instanceof Error && error.message
      ? `: ${error.message}`
      : "";
    throw new DacsError(`Vet ${step} step failed${detail}`);
  }
}

function assertResultBindings(
  result: VerifyResult,
  context: VetCheckpointContext,
): void {
  if (
    result.scheme !== context.scheme ||
    result.identifier !== context.identifier ||
    result.recipeVersion !== context.recipeVersion ||
    result.method !== context.method ||
    result.signature.algorithm !== context.signer.algorithm ||
    result.signature.signer !== context.signer.signer ||
    result.fetchedAt > result.verifiedAt
  ) {
    throw new DacsError("Vet operation contains a mismatched VerifyResult");
  }
}

function assertRecordBindings(
  record: CompositeVerificationRecord,
  result: VerifyResult,
  resultAnchor: FinalizedVetAnchor,
  context: VetCheckpointContext,
): void {
  const resultRef = verifyResultRefFromAnchor(result, resultAnchor.ref);
  const freshness = context.req.classification === "freshness" ? [resultRef] : [];
  const dealSpecific =
    context.req.classification === "freshness" ? [] : [resultRef];
  const expectedUnsigned: Omit<CompositeVerificationRecord, "signature"> = {
    recordVersion: "1",
    jobId: context.req.jobId,
    evaluatedParty: context.req.subject,
    bundleHash: context.req.bundleHash,
    requirementHash: sha256Hex(canonicalize(context.req.requirement)),
    freshness,
    supplementary: context.req.supplementary ?? [],
    dealSpecific,
    overallDecision: aggregateCompositeVerification(
      [result],
      context.req.requirement,
    ),
    ...(context.req.warnings !== undefined
      ? { warnings: context.req.warnings }
      : {}),
    generatedAt: record.generatedAt,
  };
  const { signature: _signature, ...actualUnsigned } = record;
  if (
    record.generatedAt < result.verifiedAt ||
    record.signature.algorithm !== context.signer.algorithm ||
    record.signature.signer !== context.signer.signer ||
    !canonicalEqual(actualUnsigned, expectedUnsigned)
  ) {
    throw new DacsError(
      "Vet operation contains a mismatched CompositeVerificationRecord",
    );
  }
}

function captureVetCheckpoint(
  value: unknown,
  context: VetCheckpointContext,
): VetOperationCheckpoint {
  if (!isExactJsonRecord(value)) {
    throw new DacsError("Vet operation checkpoint is not exact JSON data");
  }
  const checkpoint = snapshot(value, "Vet operation checkpoint");
  if (
    !isRecord(checkpoint) ||
    checkpoint.operationVersion !== "1" ||
    checkpoint.operationKey !== context.operationKey ||
    checkpoint.operationHash !== context.operationHash ||
    typeof checkpoint.stage !== "string"
  ) {
    throw new DacsError("Vet operation checkpoint is corrupt or mismatched");
  }
  const common = ["operationVersion", "operationKey", "operationHash", "stage"];
  if (checkpoint.stage === "intent") {
    if (!hasExactKeys(checkpoint, common)) {
      throw new DacsError("Vet intent checkpoint contains unexpected fields");
    }
    return checkpoint as unknown as VetOperationCheckpoint;
  }
  if (checkpoint.stage === "method-complete") {
    if (
      !hasExactKeys(checkpoint, [
        ...common,
        "methodOutcome",
        "methodOutcomeHash",
      ]) ||
      !canonicalEqual(captureMethodOutcome(checkpoint.methodOutcome), checkpoint.methodOutcome) ||
      checkpoint.methodOutcomeHash !== exactArtifactHash(checkpoint.methodOutcome)
    ) {
      throw new DacsError("Vet method checkpoint is corrupt");
    }
    return checkpoint as unknown as VetOperationCheckpoint;
  }
  if (
    checkpoint.resultAddress !== context.resultAddress ||
    !isVerifyResult(checkpoint.result) ||
    checkpoint.resultArtifactHash !== exactArtifactHash(checkpoint.result)
  ) {
    throw new DacsError("Vet result checkpoint is corrupt or mismatched");
  }
  assertResultBindings(checkpoint.result, context);
  const resultKeys = [
    ...common,
    "resultAddress",
    "result",
    "resultArtifactHash",
  ];
  if (checkpoint.stage === "result-submitting") {
    if (!hasExactKeys(checkpoint, resultKeys)) {
      throw new DacsError("Vet result submission checkpoint is corrupt");
    }
    return checkpoint as unknown as VetOperationCheckpoint;
  }
  if (!isFinalizedVetAnchor(checkpoint.resultAnchor)) {
    throw new DacsError("Vet finalized result checkpoint is corrupt");
  }
  const finalizedResultKeys = [...resultKeys, "resultAnchor"];
  if (checkpoint.stage === "result-finalized") {
    if (!hasExactKeys(checkpoint, finalizedResultKeys)) {
      throw new DacsError("Vet finalized result checkpoint is corrupt");
    }
    return checkpoint as unknown as VetOperationCheckpoint;
  }
  if (
    checkpoint.recordAddress !== context.recordAddress ||
    !isCompositeVerificationRecord(checkpoint.record) ||
    checkpoint.recordArtifactHash !== exactArtifactHash(checkpoint.record)
  ) {
    throw new DacsError("Vet composite checkpoint is corrupt or mismatched");
  }
  assertRecordBindings(
    checkpoint.record,
    checkpoint.result,
    checkpoint.resultAnchor,
    context,
  );
  const recordKeys = [
    ...finalizedResultKeys,
    "recordAddress",
    "record",
    "recordArtifactHash",
  ];
  if (checkpoint.stage === "composite-submitting") {
    if (!hasExactKeys(checkpoint, recordKeys)) {
      throw new DacsError("Vet composite submission checkpoint is corrupt");
    }
    return checkpoint as unknown as VetOperationCheckpoint;
  }
  if (
    checkpoint.stage !== "complete" ||
    !isFinalizedVetAnchor(checkpoint.recordAnchor) ||
    !hasExactKeys(checkpoint, [...recordKeys, "recordAnchor"])
  ) {
    throw new DacsError("Vet completed checkpoint is corrupt");
  }
  return checkpoint as unknown as VetOperationCheckpoint;
}

async function loadVetCheckpoint(
  store: VetOperationStore,
  context: VetCheckpointContext,
): Promise<VetOperationCheckpoint | null> {
  let loaded: unknown;
  try {
    loaded = await store.load(context.operationKey);
  } catch {
    throw new DacsError("Vet operation lookup is indeterminate");
  }
  if (loaded === null) return null;
  return captureVetCheckpoint(loaded, context);
}

async function transitionVetCheckpoint(
  store: VetOperationStore,
  context: VetCheckpointContext,
  expected: VetOperationCheckpoint | null,
  next: VetOperationCheckpoint,
): Promise<{ checkpoint: VetOperationCheckpoint; owned: boolean }> {
  let changed: boolean | undefined;
  try {
    const response = await store.compareAndSet(
      deepFreezeSnapshot({
        operationKey: context.operationKey,
        expected: expected === null
          ? null
          : snapshot(expected, "expected Vet checkpoint"),
        next: snapshot(next, "next Vet checkpoint"),
      }),
    );
    if (response !== true && response !== false) {
      throw new DacsError("Vet operation CAS returned a non-boolean verdict");
    }
    changed = response;
  } catch (error) {
    if (error instanceof DacsError) throw error;
    // A lost CAS response is ambiguous. Loading the exact next state permits
    // reconciliation, but never grants ownership of a submission.
  }
  const loaded = await loadVetCheckpoint(store, context);
  if (loaded === null || !canonicalEqual(loaded, next)) {
    if (changed === false) {
      throw new DacsError("Vet operation was claimed by a conflicting writer");
    }
    throw new DacsError("Vet operation CAS did not durably store exact bytes");
  }
  return { checkpoint: loaded, owned: changed === true };
}

async function resolveFinalizedJson(
  logicalAddress: string,
  artifact: Record<string, unknown>,
  deps: VetDeps,
  validate: (value: unknown) => boolean,
  hashArtifact: (value: Record<string, unknown>) => string = contentHash,
): Promise<FinalizedVetAnchor | null> {
  const expectedHash = hashArtifact(artifact);
  let resolved: FinalizedVetAnchor | null;
  try {
    resolved = await deps.resolveFinalizedArtifact(
      deepFreezeSnapshot({ logicalAddress, contentHash: expectedHash }),
    );
  } catch {
    throw new DacsError(`${logicalAddress} finalized lookup is indeterminate`);
  }
  if (resolved === null) return null;
  if (!isFinalizedVetAnchor(resolved)) {
    throw new DacsError(`${logicalAddress} finalized lookup returned malformed state`);
  }
  return authenticateFinalizedJson(
    logicalAddress,
    artifact,
    resolved,
    deps,
    validate,
    hashArtifact,
  );
}

async function reconcileOrPersistFinalizedJson(
  logicalAddress: string,
  artifact: Record<string, unknown>,
  deps: VetDeps,
  validate: (value: unknown) => boolean,
  hashArtifact: (value: Record<string, unknown>) => string = contentHash,
): Promise<FinalizedVetAnchor> {
  const existing = await resolveFinalizedJson(
    logicalAddress,
    artifact,
    deps,
    validate,
    hashArtifact,
  );
  if (existing) return existing;
  try {
    return await persistFinalizedJson(
      logicalAddress,
      artifact,
      deps,
      validate,
      hashArtifact,
    );
  } catch {
    // The anchor call may have committed before its response was lost. Resolve
    // once by exact logical address + content hash; never call the writer again.
    const recovered = await resolveFinalizedJson(
      logicalAddress,
      artifact,
      deps,
      validate,
      hashArtifact,
    );
    if (recovered) return recovered;
    throw new DacsError(
      `${logicalAddress} submission outcome is indeterminate; refusing to resubmit`,
    );
  }
}

/**
 * Run one current DACS-2 method, sign and anchor its VerifyResult, aggregate the
 * exact §7.7 record, and sign that record. No legacy entry/record is emitted and
 * no VerifyResultRef is synthesised before an anchor callback succeeds.
 */
export async function vetCore(
  request: VetRequest,
  dependencySource: VetDeps,
): Promise<VetProduction> {
  const req = captureVetRequest(request);
  const deps = captureVetDeps(dependencySource);
  if (
    !req.jobId ||
    !/^[0-9a-f]{64}$/.test(req.bundleHash) ||
    !isCompositeBundleRequirement(req.requirement)
  ) {
    throw new DacsError("Vet requires exact job, bundle, recipe and BundleRequirement bindings");
  }
  const { scheme, identifier } = claimParts(req.subject);
  if (req.recipe.scheme !== scheme) {
    throw new DacsError(
      `authenticated recipe scheme ${req.recipe.scheme} cannot verify ${scheme}`,
    );
  }
  const selectedRequirement = selectExactRequirement(
    req.requirement,
    scheme,
    req.recipe.recipeVersion,
  );
  const selectedMethod = selectVerificationMethod(
    req.recipe,
    selectedRequirement,
  );
  if (
    req.recipe.governance.deprecated === true &&
    selectedRequirement.verificationRequired
  ) {
    throw new DacsError("deprecated recipes cannot start required-claim verification");
  }
  if (
    req.recipe.availability === "disabled" ||
    req.recipe.availability === "failed" ||
    req.recipe.availability === "mocked"
  ) {
    throw new DacsError(
      `${req.recipe.availability} recipes cannot start a new verification attempt`,
    );
  }
  const resultAddress = verifyResultAddress(
    req.jobId,
    scheme,
    identifier,
    req.recipe.recipeVersion,
  );
  const recordAddress = compositeVerificationAddress(req.jobId, req.subject);
  if (
    req.classification !== undefined &&
    req.classification !== "freshness" &&
    req.classification !== "dealSpecific"
  ) {
    throw new DacsError("Vet classification must be freshness or dealSpecific");
  }
  if (
    selectedMethod.kind === "consensus-backed-proxy" &&
    selectedRequirement.parameters !== undefined &&
    Object.prototype.hasOwnProperty.call(
      selectedRequirement.parameters,
      "identifier",
    )
  ) {
    throw new DacsError(
      "ClaimRequirement.parameters.identifier is reserved for the canonical subject",
    );
  }
  if (
    selectedRequirement.parameters !== undefined &&
    !deps.matchRequirementParameters
  ) {
    throw new DacsError(
      "parameterized ClaimRequirement requires matchRequirementParameters",
    );
  }
  const operationHash = vetOperationHash(req, deps.componentSigner);
  const context: VetCheckpointContext = {
    operationKey: recordAddress,
    operationHash,
    resultAddress,
    recordAddress,
    scheme,
    identifier,
    method: selectedMethod.kind,
    recipeVersion: req.recipe.recipeVersion,
    req,
    signer: deps.componentSigner,
  };
  const intent: VetOperationCheckpoint = {
    operationVersion: "1",
    operationKey: recordAddress,
    operationHash,
    stage: "intent",
  };
  let checkpoint = await loadVetCheckpoint(deps.operationStore, context);
  if (checkpoint === null) {
    checkpoint = (
      await transitionVetCheckpoint(
        deps.operationStore,
        context,
        null,
        intent,
      )
    ).checkpoint;
  }
  if (checkpoint === null) {
    throw new DacsError("Vet operation intent could not be established");
  }

  if (checkpoint.stage === "intent") {
    const outcomeValue = await runVetStep(
      deps.operationStore,
      context,
      "method",
      operationHash,
      async () => {
        const methodStartedAt = readClock(deps.nowMs, "Vet method start");
        let outcome: {
          decision: VerificationDecision;
          attestation: AttestationRef;
          fetchedAt: number;
          data?: Record<string, unknown>;
        };
        switch (selectedMethod.kind) {
          case "self-signed": {
            const selfSigned = await selfSignedAttestation(req, deps, {
              operationKey: context.operationKey,
              operationHash,
              store: deps.operationStore,
            });
            outcome = { ...selfSigned, fetchedAt: methodStartedAt };
            break;
          }
          case "consensus-backed-proxy":
            outcome = await proxyAttestation(
              req,
              deps,
              selectedMethod,
              selectedRequirement,
            );
            break;
          default:
            throw new DacsError(
              `unsupported current verification method: ${selectedMethod.kind}`,
            );
        }
        if (outcome.fetchedAt < methodStartedAt) {
          throw new DacsError(
            "authority fetchedAt predates this verification attempt",
          );
        }
        if (selectedRequirement.parameters !== undefined) {
          try {
            const matched = await deps.matchRequirementParameters!(
              deepFreezeSnapshot({
                requirement: snapshot(
                  selectedRequirement,
                  "parameter requirement",
                ),
                subject: req.subject,
                recipe: snapshot(req.recipe, "parameter recipe"),
                method: snapshot(selectedMethod, "parameter method"),
                decision: outcome.decision,
                attestation: snapshot(
                  outcome.attestation,
                  "parameter attestation",
                ),
                ...(outcome.data
                  ? { data: snapshot(outcome.data, "parameter extracted data") }
                  : {}),
              }),
            );
            if (matched !== true) outcome.decision = "fail";
          } catch {
            outcome.decision = "error";
          }
        }
        return {
          ...outcome,
          verifiedAt: readClock(
            deps.nowMs,
            "VerifyResult verifiedAt",
            outcome.fetchedAt,
          ),
        } satisfies VetMethodOutcome;
      },
    );
    const methodOutcome = captureMethodOutcome(outcomeValue);
    const next: VetOperationCheckpoint = {
      ...intent,
      stage: "method-complete",
      methodOutcome,
      methodOutcomeHash: exactArtifactHash(methodOutcome),
    };
    checkpoint = (
      await transitionVetCheckpoint(
        deps.operationStore,
        context,
        checkpoint,
        next,
      )
    ).checkpoint;
  }

  if (checkpoint.stage === "method-complete") {
    const outcome = checkpoint.methodOutcome;
    const unsignedResult: Omit<VerifyResult, "signature"> = {
      resultVersion: "1",
      scheme,
      identifier,
      recipeVersion: req.recipe.recipeVersion,
      method: selectedMethod.kind,
      decision: outcome.decision,
      reason: reasonFor(outcome.decision),
      attestation: outcome.attestation,
      ...(outcome.data ? { data: outcome.data } : {}),
      fetchedAt: outcome.fetchedAt,
      verifiedAt: outcome.verifiedAt,
    };
    const unsignedResultHash = contentHash(
      unsignedResult as unknown as Record<string, unknown>,
    );
    const result = snapshot(
      await runVetStep(
        deps.operationStore,
        context,
        "verify-result",
        exactArtifactHash(unsignedResult),
        () => signComponentArtifact(
          deepFreezeSnapshot(snapshot(unsignedResult, "unsigned VerifyResult")),
          "dacs-verifyresult:v1:",
          deps.componentSigner,
        ),
      ),
      "signed VerifyResult",
    ) as VerifyResult;
    if (!isVerifyResult(result)) {
      throw new DacsError("VerifyResult signer produced a non-current artifact");
    }
    if (
      contentHash(result as unknown as Record<string, unknown>) !==
      unsignedResultHash
    ) {
      throw new DacsError("VerifyResult signer changed the signed result scope");
    }
    const next: VetOperationCheckpoint = {
      ...intent,
      stage: "result-submitting",
      resultAddress,
      result,
      resultArtifactHash: exactArtifactHash(result),
    };
    checkpoint = (
      await transitionVetCheckpoint(
        deps.operationStore,
        context,
        checkpoint,
        next,
      )
    ).checkpoint;
  }

  if (checkpoint.stage === "result-submitting") {
    const submittingResult = checkpoint;
    const resultAnchorValue = await runVetStep(
      deps.operationStore,
      context,
      "verify-result-anchor",
      exactArtifactHash({
        logicalAddress: submittingResult.resultAddress,
        artifactHash: submittingResult.resultArtifactHash,
      }),
      () => reconcileOrPersistFinalizedJson(
        submittingResult.resultAddress,
        submittingResult.result as unknown as Record<string, unknown>,
        deps,
        isVerifyResult,
      ),
    );
    if (!isFinalizedVetAnchor(resultAnchorValue)) {
      throw new DacsError("VerifyResult anchor step returned corrupt state");
    }
    const resultAnchor = await authenticateFinalizedJson(
      submittingResult.resultAddress,
      submittingResult.result as unknown as Record<string, unknown>,
      resultAnchorValue,
      deps,
      isVerifyResult,
    );
    const next: VetOperationCheckpoint = {
      ...checkpoint,
      stage: "result-finalized",
      resultAnchor,
    };
    checkpoint = (
      await transitionVetCheckpoint(
        deps.operationStore,
        context,
        checkpoint,
        next,
      )
    ).checkpoint;
  }

  if (
    checkpoint.stage === "intent" ||
    checkpoint.stage === "method-complete" ||
    checkpoint.stage === "result-submitting"
  ) {
    throw new DacsError("Vet operation could not advance beyond result submission");
  }
  const authenticatedResultAnchor = await authenticateFinalizedJson(
    checkpoint.resultAddress,
    checkpoint.result as unknown as Record<string, unknown>,
    checkpoint.resultAnchor,
    deps,
    isVerifyResult,
  );

  if (checkpoint.stage === "result-finalized") {
    const finalizedResult = checkpoint;
    const resultRef = verifyResultRefFromAnchor(
      finalizedResult.result,
      authenticatedResultAnchor.ref,
    );
    const freshness: VerifyResultRef[] =
      req.classification === "freshness" ? [resultRef] : [];
    const dealSpecific: VerifyResultRef[] =
      req.classification === "freshness" ? [] : [resultRef];
    const compositeInputHash = exactArtifactHash({
      operationHash,
      resultArtifactHash: finalizedResult.resultArtifactHash,
      resultRef,
      recordAddress,
    });
    const record = snapshot(
      await runVetStep(
        deps.operationStore,
        context,
        "composite",
        compositeInputHash,
        async () => {
          const unsignedRecord: Omit<CompositeVerificationRecord, "signature"> = {
            recordVersion: "1",
            jobId: req.jobId,
            evaluatedParty: req.subject,
            bundleHash: req.bundleHash,
            requirementHash: sha256Hex(canonicalize(req.requirement)),
            freshness,
            supplementary: req.supplementary ?? [],
            dealSpecific,
            overallDecision: aggregateCompositeVerification(
              [finalizedResult.result],
              req.requirement,
            ),
            ...(req.warnings !== undefined ? { warnings: req.warnings } : {}),
            generatedAt: readClock(
              deps.nowMs,
              "composite generatedAt",
              finalizedResult.result.verifiedAt,
            ),
          };
          return signComponentArtifact(
            deepFreezeSnapshot(
              snapshot(unsignedRecord, "unsigned composite record"),
            ),
            "dacs-composite:v1:",
            deps.componentSigner,
          );
        },
      ),
      "signed composite record",
    ) as CompositeVerificationRecord;
    if (!isCompositeVerificationRecord(record)) {
      throw new DacsError("composite signer produced a non-current DACS-2 record");
    }
    assertRecordBindings(
      record,
      finalizedResult.result,
      authenticatedResultAnchor,
      context,
    );
    const next: VetOperationCheckpoint = {
      ...checkpoint,
      resultAnchor: authenticatedResultAnchor,
      stage: "composite-submitting",
      recordAddress,
      record,
      recordArtifactHash: exactArtifactHash(record),
    };
    checkpoint = (
      await transitionVetCheckpoint(
        deps.operationStore,
        context,
        checkpoint,
        next,
      )
    ).checkpoint;
  }

  if (checkpoint.stage === "composite-submitting") {
    const submittingComposite = checkpoint;
    const recordAnchorValue = await runVetStep(
      deps.operationStore,
      context,
      "composite-anchor",
      exactArtifactHash({
        logicalAddress: submittingComposite.recordAddress,
        artifactHash: submittingComposite.recordArtifactHash,
      }),
      () => reconcileOrPersistFinalizedJson(
        submittingComposite.recordAddress,
        submittingComposite.record as unknown as Record<string, unknown>,
        deps,
        isCompositeVerificationRecord,
      ),
    );
    if (!isFinalizedVetAnchor(recordAnchorValue)) {
      throw new DacsError("composite anchor step returned corrupt state");
    }
    const recordAnchor = await authenticateFinalizedJson(
      submittingComposite.recordAddress,
      submittingComposite.record as unknown as Record<string, unknown>,
      recordAnchorValue,
      deps,
      isCompositeVerificationRecord,
    );
    const next: VetOperationCheckpoint = {
      ...checkpoint,
      stage: "complete",
      recordAnchor,
    };
    checkpoint = (
      await transitionVetCheckpoint(
        deps.operationStore,
        context,
        checkpoint,
        next,
      )
    ).checkpoint;
  }

  if (checkpoint.stage !== "complete") {
    throw new DacsError("Vet operation could not reach a complete checkpoint");
  }
  const authenticatedRecordAnchor = await authenticateFinalizedJson(
    checkpoint.recordAddress,
    checkpoint.record as unknown as Record<string, unknown>,
    checkpoint.recordAnchor,
    deps,
    isCompositeVerificationRecord,
  );
  return structuredClone({
    record: checkpoint.record,
    recordRef: authenticatedRecordAnchor.ref,
    anchorReceipt: authenticatedRecordAnchor.receipt,
  });
}
