import { types as nodeTypes } from "node:util";

import { canonicalize, contentHash, encodeAddressSegment, sha256Hex } from "../canonical/index.js";
import type {
  AttestationRef,
  ComponentSignature,
  CompositeVerificationRecord,
  IdentityBundle,
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
  isIdentityBundle,
  isVerifyResult,
} from "../artifacts/validators.js";
import {
  signComponentArtifact,
  verifyComponentSignature,
  type BuildComponentSignatureOptions,
  type VerifyComponentSignatureDeps,
} from "../artifacts/signatures.js";
import { ed25519Verify, publicKeyFromRaw, signedBytes } from "../crypto/index.js";
import { DacsError } from "../errors.js";
import { identityBundleHash } from "../identity/index.js";
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
import {
  advancePartyVetPlan,
  createPartyVetPlan,
  type PartyVetAttemptInput,
  type PartyVetAttemptOutcome,
  type PartyVetMethodInput,
  type PartyVetPlan,
  type PartyVetRequirementAttempt,
  type PartyVetRequirementPath,
} from "./partyVetPlan.js";
import {
  isDurableSessionRecipePin,
  type DurableSessionRecipePin,
} from "./durableRecipePin.js";

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
  if (nodeTypes.isProxy(value)) {
    throw new DacsError(`${label} cannot contain proxies`);
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
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as PropertyDescriptorMap;
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
    Object.defineProperty(copy, key, {
      value: snapshotValue(descriptor.value, label, seen),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(value);
  return copy;
}

function snapshot<T>(value: T, label: string): T {
  return snapshotValue(value, label, new WeakSet()) as T;
}

const INERT_VET_RECEIVER = Object.freeze(Object.create(null)) as object;

function exactOwnDataDescriptors(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): PropertyDescriptorMap {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    throw new DacsError(`${label} must be an exact plain data record`);
  }
  let prototype: object | null;
  let keys: (string | symbol)[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new DacsError(`${label} could not be captured`);
  }
  const allowed = new Set([...required, ...optional]);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    keys.some((key) => typeof key !== "string") ||
    !required.every((key) => keys.includes(key)) ||
    !keys.every((key) => typeof key === "string" && allowed.has(key))
  ) {
    throw new DacsError(`${label} must be an exact plain data record`);
  }
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.value === undefined
    ) {
      throw new DacsError(`${label} must contain only defined own data fields`);
    }
  }
  return descriptors;
}

function exactCallback<T extends (...args: never[]) => unknown>(
  value: unknown,
  label: string,
): T {
  if (typeof value !== "function" || nodeTypes.isProxy(value)) {
    throw new DacsError(`${label} must be a non-proxy callback`);
  }
  return value as T;
}

function captureVetDeps(source: VetDeps): VetDeps {
  try {
    const descriptors = exactOwnDataDescriptors(
      source,
      [
        "proxyFetch",
        "nowMs",
        "componentSigner",
        "anchorFinalizedArtifact",
        "verifyFinalizedAnchor",
        "readAnchoredJson",
        "resolveFinalizedArtifact",
        "operationStore",
      ],
      ["matchRequirementParameters", "parserEngine"],
      "Vet dependencies",
    );
    const rawProxyFetch = exactCallback<VetDeps["proxyFetch"]>(
      descriptors.proxyFetch!.value,
      "Vet proxyFetch",
    );
    const rawNowMs = exactCallback<VetDeps["nowMs"]>(
      descriptors.nowMs!.value,
      "Vet nowMs",
    );
    const rawAnchorFinalizedArtifact = exactCallback<
      VetDeps["anchorFinalizedArtifact"]
    >(
      descriptors.anchorFinalizedArtifact!.value,
      "Vet anchorFinalizedArtifact",
    );
    const rawVerifyFinalizedAnchor = exactCallback<
      VetDeps["verifyFinalizedAnchor"]
    >(
      descriptors.verifyFinalizedAnchor!.value,
      "Vet verifyFinalizedAnchor",
    );
    const rawReadAnchoredJson = exactCallback<VetDeps["readAnchoredJson"]>(
      descriptors.readAnchoredJson!.value,
      "Vet readAnchoredJson",
    );
    const rawResolveFinalizedArtifact = exactCallback<
      VetDeps["resolveFinalizedArtifact"]
    >(
      descriptors.resolveFinalizedArtifact!.value,
      "Vet resolveFinalizedArtifact",
    );
    const operationStoreSource = descriptors.operationStore!.value;
    const storeDescriptors = exactOwnDataDescriptors(
      operationStoreSource,
      ["load", "compareAndSet", "runOnce"],
      [],
      "Vet operation store",
    );
    const rawLoad = exactCallback<VetOperationStore["load"]>(
      storeDescriptors.load!.value,
      "Vet operation store load",
    );
    const rawCompareAndSet = exactCallback<VetOperationStore["compareAndSet"]>(
      storeDescriptors.compareAndSet!.value,
      "Vet operation store compareAndSet",
    );
    const rawRunOnce = exactCallback<VetOperationStore["runOnce"]>(
      storeDescriptors.runOnce!.value,
      "Vet operation store runOnce",
    );
    const operationStore = Object.freeze({
      load: (operationKey: string) =>
        Reflect.apply(rawLoad, INERT_VET_RECEIVER, [operationKey]),
      compareAndSet: (input: Parameters<VetOperationStore["compareAndSet"]>[0]) =>
        Reflect.apply(rawCompareAndSet, INERT_VET_RECEIVER, [input]),
      runOnce: (input: Parameters<VetOperationStore["runOnce"]>[0]) =>
        Reflect.apply(rawRunOnce, INERT_VET_RECEIVER, [input]),
    });
    const matchRequirementParameters = descriptors.matchRequirementParameters
      ? exactCallback<NonNullable<VetDeps["matchRequirementParameters"]>>(
          descriptors.matchRequirementParameters.value,
          "Vet matchRequirementParameters",
        )
      : undefined;
    const signerSource = descriptors.componentSigner!.value;
    const signerDescriptors = exactOwnDataDescriptors(
      signerSource,
      ["algorithm", "signer", "sign"],
      [],
      "Vet component signer",
    );
    const algorithm = signerDescriptors.algorithm!.value;
    const signer = signerDescriptors.signer!.value;
    const rawSign = exactCallback<BuildComponentSignatureOptions["sign"]>(
      signerDescriptors.sign!.value,
      "Vet component signer sign",
    );
    if (
      algorithm !== "ed25519" &&
      algorithm !== "ecdsa-secp256k1" &&
      algorithm !== "sr1-aggregate"
    ) {
      throw new DacsError("Vet component signer algorithm is unsupported");
    }
    if (
      typeof signer !== "string" ||
      signer.length === 0 ||
      signer.trim() !== signer ||
      signer.normalize("NFC") !== signer
    ) {
      throw new DacsError("Vet component signer identity is not canonical");
    }
    claimParts(signer);
    const componentSigner: BuildComponentSignatureOptions = Object.freeze({
      algorithm,
      signer,
      sign: (
        bytes: Parameters<BuildComponentSignatureOptions["sign"]>[0],
        context: Parameters<BuildComponentSignatureOptions["sign"]>[1],
      ) =>
        Reflect.apply(rawSign, INERT_VET_RECEIVER, [bytes, context]),
    });
    const parserSource = descriptors.parserEngine?.value;
    const parserEngine = parserSource
      ? (() => {
          const parserDescriptors = exactOwnDataDescriptors(
            parserSource,
            ["evalPredicate"],
            ["extract"],
            "Vet parser engine",
          );
          const rawEvalPredicate = exactCallback<ParserEngine["evalPredicate"]>(
            parserDescriptors.evalPredicate!.value,
            "Vet parser evalPredicate",
          );
          const rawExtract = parserDescriptors.extract
            ? exactCallback<NonNullable<ParserEngine["extract"]>>(
                parserDescriptors.extract.value,
                "Vet parser extract",
              )
            : undefined;
          return Object.freeze({
            evalPredicate: (...args: Parameters<ParserEngine["evalPredicate"]>) =>
              Reflect.apply(rawEvalPredicate, INERT_VET_RECEIVER, args),
            ...(rawExtract
              ? {
                  extract: (...args: Parameters<NonNullable<ParserEngine["extract"]>>) =>
                    Reflect.apply(rawExtract, INERT_VET_RECEIVER, args),
                }
              : {}),
          });
        })()
      : undefined;
    return Object.freeze({
      proxyFetch: (request: Parameters<VetDeps["proxyFetch"]>[0]) =>
        Reflect.apply(rawProxyFetch, INERT_VET_RECEIVER, [request]),
      nowMs: () => Reflect.apply(rawNowMs, INERT_VET_RECEIVER, []),
      componentSigner,
      anchorFinalizedArtifact: (
        input: Parameters<VetDeps["anchorFinalizedArtifact"]>[0],
      ) =>
        Reflect.apply(rawAnchorFinalizedArtifact, INERT_VET_RECEIVER, [input]),
      verifyFinalizedAnchor: (
        input: Parameters<VetDeps["verifyFinalizedAnchor"]>[0],
      ) =>
        Reflect.apply(rawVerifyFinalizedAnchor, INERT_VET_RECEIVER, [input]),
      readAnchoredJson: (ref: Parameters<VetDeps["readAnchoredJson"]>[0]) =>
        Reflect.apply(rawReadAnchoredJson, INERT_VET_RECEIVER, [ref]),
      resolveFinalizedArtifact: (
        input: Parameters<VetDeps["resolveFinalizedArtifact"]>[0],
      ) =>
        Reflect.apply(rawResolveFinalizedArtifact, INERT_VET_RECEIVER, [input]),
      operationStore,
      ...(matchRequirementParameters
        ? {
            matchRequirementParameters: (
              input: Parameters<
                NonNullable<VetDeps["matchRequirementParameters"]>
              >[0],
            ) => Reflect.apply(
              matchRequirementParameters,
              INERT_VET_RECEIVER,
              [input],
            ),
          }
        : {}),
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

export interface PartyVetAttemptRequest {
  requirementPath: PartyVetRequirementPath;
  claimSubject: string;
  /** Exact generation-fenced recipe pin produced by #143. */
  recipePin: DurableSessionRecipePin;
  methodInput: PartyVetMethodInput;
}

export interface PartyVetRequest {
  jobId: string;
  evaluatedParty: string;
  identityBundle: IdentityBundle;
  requirement: CompositeBundleRequirement;
  attempts: PartyVetAttemptRequest[];
  supplementary?: SupplementarySignal[];
  warnings?: VerificationWarning[];
}

/** Additional trust capabilities required by the public party-scoped producer. */
export interface PartyVetDeps<TKey> extends VetDeps {
  /** Authenticate BP-4 over the exact captured bundle hash. */
  verifyIdentityPresentation: (input: {
    bundle: Readonly<IdentityBundle>;
    signedBytes: Uint8Array;
  }) => Promise<boolean> | boolean;
  /** Role policy, key resolution and cryptographic verifier for signed components. */
  componentVerifier: VerifyComponentSignatureDeps<TKey>;
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
  if (!isRecord(source) || nodeTypes.isProxy(source)) {
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

  const captured: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    Object.defineProperty(captured, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return deepFreezeSnapshot(
    snapshot(captured, "Vet request"),
  ) as unknown as VetRequest;
}

function denseOwnArrayValues(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw new DacsError(`${label} must be a dense intrinsic array`);
  }
  let prototype: object | null;
  let keys: (string | symbol)[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(
      value,
    ) as unknown as PropertyDescriptorMap;
  } catch {
    throw new DacsError(`${label} could not be captured`);
  }
  if (
    prototype !== Array.prototype ||
    keys.length !== value.length + 1 ||
    !keys.includes("length")
  ) {
    throw new DacsError(`${label} must be a dense intrinsic array`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor) ||
      descriptor.value === undefined
    ) {
      throw new DacsError(`${label} must contain only own data elements`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function capturePartyVetRequest(source: PartyVetRequest): PartyVetRequest {
  const descriptors = exactOwnDataDescriptors(
    source,
    [
      "jobId",
      "evaluatedParty",
      "identityBundle",
      "requirement",
      "attempts",
    ],
    ["supplementary", "warnings"],
    "party Vet request",
  );
  const attempts = denseOwnArrayValues(
    descriptors.attempts!.value,
    "party Vet attempts",
  ).map((raw, index): PartyVetAttemptRequest => {
    const attempt = exactOwnDataDescriptors(
      raw,
      ["requirementPath", "claimSubject", "recipePin", "methodInput"],
      [],
      `party Vet attempt ${index}`,
    );
    const recipePin = attempt.recipePin!.value;
    if (!isDurableSessionRecipePin(recipePin)) {
      throw new DacsError(
        `party Vet attempt ${index} requires a runtime-authenticated durable recipe pin`,
      );
    }
    return deepFreezeSnapshot({
      requirementPath: snapshot(
        attempt.requirementPath!.value,
        `party Vet attempt ${index} requirement path`,
      ),
      claimSubject: attempt.claimSubject!.value,
      recipePin,
      methodInput: snapshot(
        attempt.methodInput!.value,
        `party Vet attempt ${index} method input`,
      ),
    }) as PartyVetAttemptRequest;
  });
  return deepFreezeSnapshot({
    jobId: descriptors.jobId!.value,
    evaluatedParty: descriptors.evaluatedParty!.value,
    identityBundle: snapshot(
      descriptors.identityBundle!.value,
      "party Vet IdentityBundle",
    ),
    requirement: snapshot(
      descriptors.requirement!.value,
      "party Vet BundleRequirement",
    ),
    attempts,
    ...(descriptors.supplementary
      ? {
          supplementary: snapshot(
            descriptors.supplementary.value,
            "party Vet supplementary signals",
          ),
        }
      : {}),
    ...(descriptors.warnings
      ? {
          warnings: snapshot(
            descriptors.warnings.value,
            "party Vet warnings",
          ),
        }
      : {}),
  }) as unknown as PartyVetRequest;
}

interface CapturedPartyVetDeps<TKey> {
  vet: VetDeps;
  verifyIdentityPresentation: PartyVetDeps<TKey>["verifyIdentityPresentation"];
  componentVerifier: VerifyComponentSignatureDeps<TKey>;
}

function capturePartyVetDeps<TKey>(
  source: PartyVetDeps<TKey>,
): CapturedPartyVetDeps<TKey> {
  try {
    const baseKeys = [
      "proxyFetch",
      "nowMs",
      "componentSigner",
      "anchorFinalizedArtifact",
      "verifyFinalizedAnchor",
      "readAnchoredJson",
      "resolveFinalizedArtifact",
      "operationStore",
    ] as const;
    const optionalBaseKeys = [
      "matchRequirementParameters",
      "parserEngine",
    ] as const;
    const descriptors = exactOwnDataDescriptors(
      source,
      [...baseKeys, "verifyIdentityPresentation", "componentVerifier"],
      optionalBaseKeys,
      "party Vet dependencies",
    );
    const baseSource = Object.create(null) as Record<string, unknown>;
    for (const key of [...baseKeys, ...optionalBaseKeys]) {
      const descriptor = descriptors[key];
      if (!descriptor) continue;
      Object.defineProperty(baseSource, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    const vet = captureVetDeps(baseSource as unknown as VetDeps);
    const rawVerifyIdentityPresentation = exactCallback<
      PartyVetDeps<TKey>["verifyIdentityPresentation"]
    >(
      descriptors.verifyIdentityPresentation!.value,
      "party Vet identity presentation verifier",
    );
    const componentSource = descriptors.componentVerifier!.value;
    const componentDescriptors = exactOwnDataDescriptors(
      componentSource,
      ["isSignerAuthorized", "resolvePublicKey", "verify"],
      [],
      "party Vet component verifier",
    );
    const rawAuthorize = exactCallback<
      VerifyComponentSignatureDeps<TKey>["isSignerAuthorized"]
    >(
      componentDescriptors.isSignerAuthorized!.value,
      "party Vet component signer policy",
    );
    const rawResolvePublicKey = exactCallback<
      VerifyComponentSignatureDeps<TKey>["resolvePublicKey"]
    >(
      componentDescriptors.resolvePublicKey!.value,
      "party Vet component key resolver",
    );
    const rawVerify = exactCallback<
      VerifyComponentSignatureDeps<TKey>["verify"]
    >(
      componentDescriptors.verify!.value,
      "party Vet component signature verifier",
    );
    return {
      vet,
      verifyIdentityPresentation: (input) => Reflect.apply(
        rawVerifyIdentityPresentation,
        INERT_VET_RECEIVER,
        [input],
      ),
      componentVerifier: Object.freeze({
        isSignerAuthorized: (
          artifact: Parameters<
            VerifyComponentSignatureDeps<TKey>["isSignerAuthorized"]
          >[0],
          signature: Parameters<
            VerifyComponentSignatureDeps<TKey>["isSignerAuthorized"]
          >[1],
        ) => Reflect.apply(
          rawAuthorize,
          INERT_VET_RECEIVER,
          [artifact, signature],
        ),
        resolvePublicKey: (
          signature: Parameters<
            VerifyComponentSignatureDeps<TKey>["resolvePublicKey"]
          >[0],
        ) => Reflect.apply(
          rawResolvePublicKey,
          INERT_VET_RECEIVER,
          [signature],
        ),
        verify: (
          input: Parameters<VerifyComponentSignatureDeps<TKey>["verify"]>[0],
        ) => Reflect.apply(
          rawVerify,
          INERT_VET_RECEIVER,
          [input],
        ),
      }),
    };
  } catch {
    throw new DacsError(
      "party Vet dependencies must expose stable trusted capabilities",
    );
  }
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

type FinalizedVetResultCheckpoint = Extract<
  VetOperationCheckpoint,
  { stage: "result-finalized" | "composite-submitting" | "complete" }
>;

type VetSignedArtifactAuthenticator = (
  artifact: Readonly<Record<string, unknown>>,
  separator: "dacs-verifyresult:v1:" | "dacs-composite:v1:",
) => Promise<void>;

async function executeVetMethod(
  req: VetRequest,
  deps: VetDeps,
  selectedRequirement: CompositeClaimRequirement,
  selectedMethod: VerificationMethod,
  context: VetCheckpointContext,
): Promise<VetMethodOutcome> {
  const operationHash = context.operationHash;
  const outcomeValue = await runVetStep(
    deps.operationStore,
    context,
    "method",
    operationHash,
    async () => {
      const methodStartedAt = readClock(deps.nowMs, "Vet method start");
      if (
        req.recipe.availability === "mocked" ||
        req.recipe.availability === "failed"
      ) {
        const evidence = deepFreezeSnapshot({
          availabilityEvidenceVersion: "1",
          jobId: req.jobId,
          subject: req.subject,
          scheme: req.recipe.scheme,
          recipeVersion: req.recipe.recipeVersion,
          method: selectedMethod.kind,
          availability: req.recipe.availability,
          recipeContentHash: contentHash(
            req.recipe as unknown as Record<string, unknown>,
          ),
        });
        const logicalAddress = `${context.operationKey}:recipe-availability`;
        const evidenceValue = await runVetStep(
          deps.operationStore,
          context,
          "method-evidence",
          exactArtifactHash({ logicalAddress, evidence }),
          () => reconcileOrPersistFinalizedJson(
            logicalAddress,
            evidence,
            deps,
            (value) =>
              isExactJsonRecord(value) && canonicalEqual(value, evidence),
          ),
        );
        if (!isFinalizedVetAnchor(evidenceValue)) {
          throw new DacsError(
            "recipe availability evidence returned a corrupt anchor",
          );
        }
        const anchored = await authenticateFinalizedJson(
          logicalAddress,
          evidence,
          evidenceValue,
          deps,
          (value) =>
            isExactJsonRecord(value) && canonicalEqual(value, evidence),
        );
        return {
          decision: "error",
          attestation: anchored.ref,
          fetchedAt: methodStartedAt,
          verifiedAt: readClock(
            deps.nowMs,
            "VerifyResult verifiedAt",
            methodStartedAt,
          ),
          data: {
            recipeAvailability: {
              availability: req.recipe.availability,
              recipeContentHash: evidence.recipeContentHash,
            },
          },
        } satisfies VetMethodOutcome;
      }
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
  return captureMethodOutcome(outcomeValue);
}

/**
 * Shared durable claim boundary. It owns method execution, result signing,
 * finalized anchoring and exact readback, but deliberately does not create a
 * composite record. The legacy producer and the party producer therefore use
 * the same crash-safe result semantics.
 */
async function produceDurableVetResult(
  req: VetRequest,
  deps: VetDeps,
  selectedRequirement: CompositeClaimRequirement,
  selectedMethod: VerificationMethod,
  context: VetCheckpointContext,
  authenticateSignedArtifact?: VetSignedArtifactAuthenticator,
): Promise<{
  checkpoint: FinalizedVetResultCheckpoint;
  authenticatedResultAnchor: FinalizedVetAnchor;
}> {
  const intent: VetOperationCheckpoint = {
    operationVersion: "1",
    operationKey: context.operationKey,
    operationHash: context.operationHash,
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
    const methodOutcome = await executeVetMethod(
      req,
      deps,
      selectedRequirement,
      selectedMethod,
      context,
    );
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
      scheme: context.scheme,
      identifier: context.identifier,
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
    await authenticateSignedArtifact?.(
      result as unknown as Record<string, unknown>,
      "dacs-verifyresult:v1:",
    );
    const next: VetOperationCheckpoint = {
      ...intent,
      stage: "result-submitting",
      resultAddress: context.resultAddress,
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

  if (
    checkpoint.stage === "result-submitting" ||
    checkpoint.stage === "result-finalized" ||
    checkpoint.stage === "composite-submitting" ||
    checkpoint.stage === "complete"
  ) {
    await authenticateSignedArtifact?.(
      checkpoint.result as unknown as Record<string, unknown>,
      "dacs-verifyresult:v1:",
    );
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
  return { checkpoint, authenticatedResultAnchor };
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
  const durableResult = await produceDurableVetResult(
    req,
    deps,
    selectedRequirement,
    selectedMethod,
    context,
  );
  let checkpoint: VetOperationCheckpoint = durableResult.checkpoint;
  const { authenticatedResultAnchor } = durableResult;

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

interface PartyVetFinalizedAttempt {
  attemptId: string;
  resultAddress: string;
  result: VerifyResult;
  resultArtifactHash: string;
  resultAnchor: FinalizedVetAnchor;
}

export type PartyVetOperationCheckpoint =
  | {
      operationVersion: "party-vet-1";
      operationKey: string;
      operationHash: string;
      stage: "planned";
      plan: PartyVetPlan;
    }
  | {
      operationVersion: "party-vet-1";
      operationKey: string;
      operationHash: string;
      stage: "composite-submitting";
      plan: PartyVetPlan;
      executedAttempts: PartyVetFinalizedAttempt[];
      recordAddress: string;
      record: CompositeVerificationRecord;
      recordArtifactHash: string;
    }
  | {
      operationVersion: "party-vet-1";
      operationKey: string;
      operationHash: string;
      stage: "complete";
      plan: PartyVetPlan;
      executedAttempts: PartyVetFinalizedAttempt[];
      recordAddress: string;
      record: CompositeVerificationRecord;
      recordArtifactHash: string;
      recordAnchor: FinalizedVetAnchor;
    };

async function authenticatePartyComponent<TKey>(
  artifact: Readonly<Record<string, unknown>>,
  separator: "dacs-verifyresult:v1:" | "dacs-composite:v1:",
  deps: CapturedPartyVetDeps<TKey>,
  expectedSigner?: Readonly<Pick<ComponentSignature, "algorithm" | "signer">>,
): Promise<void> {
  let verdict: Awaited<ReturnType<typeof verifyComponentSignature<TKey>>>;
  try {
    verdict = await verifyComponentSignature(
      deepFreezeSnapshot(snapshot(artifact, "party Vet signed component")),
      separator,
      {
        isSignerAuthorized: async (candidate, signature) => {
          if (
            expectedSigner &&
            (signature.algorithm !== expectedSigner.algorithm ||
              signature.signer !== expectedSigner.signer)
          ) {
            return false;
          }
          return (
            (await deps.componentVerifier.isSignerAuthorized(
              candidate,
              signature,
            )) === true
          );
        },
        resolvePublicKey: deps.componentVerifier.resolvePublicKey,
        verify: deps.componentVerifier.verify,
      },
    );
  } catch {
    throw new DacsError("party Vet component signature verification errored");
  }
  if (verdict.status !== "valid") {
    throw new DacsError(
      `party Vet component signature is not authenticated (${verdict.status})`,
    );
  }
}

function assertPartyResultTime(
  result: Readonly<VerifyResult>,
  now: number,
  label: string,
): void {
  if (
    result.fetchedAt > result.verifiedAt ||
    result.fetchedAt > now ||
    result.verifiedAt > now ||
    (result.validUntil !== undefined && result.validUntil < result.verifiedAt)
  ) {
    throw new DacsError(`${label} contains future or inconsistent timestamps`);
  }
}

async function authenticateCarriedResult<TKey>(
  bundle: Readonly<IdentityBundle>,
  claimSubject: string,
  deps: CapturedPartyVetDeps<TKey>,
  now: number,
): Promise<"freshness" | "dealSpecific"> {
  const matches = bundle.claims.filter((claim) => claim.ref === claimSubject);
  if (matches.length !== 1) {
    throw new DacsError(
      `party Vet claim ${claimSubject} has ambiguous bundle provenance`,
    );
  }
  const claim = matches[0]!;
  if (!claim.verifiedBy) {
    if (claim.issuedAt !== undefined) {
      throw new DacsError(
        `party Vet claim ${claimSubject} has unauthenticated issuedAt`,
      );
    }
    return "dealSpecific";
  }
  let raw: Record<string, unknown> | null;
  try {
    raw = await deps.vet.readAnchoredJson(
      deepFreezeSnapshot(snapshot(claim.verifiedBy, "carried VerifyResult ref")),
    );
  } catch {
    throw new DacsError(
      `party Vet carried VerifyResult for ${claimSubject} is unresolved`,
    );
  }
  if (
    raw === null ||
    nodeTypes.isProxy(raw) ||
    !isExactJsonRecord(raw) ||
    !isVerifyResult(raw)
  ) {
    throw new DacsError(
      `party Vet carried VerifyResult for ${claimSubject} is malformed`,
    );
  }
  const result = deepFreezeSnapshot(
    snapshot(raw, `party Vet carried VerifyResult ${claimSubject}`),
  ) as VerifyResult;
  const { scheme, identifier } = claimParts(claimSubject);
  if (
    contentHash(result as unknown as Record<string, unknown>) !==
      claim.verifiedBy.contentHash ||
    result.recipeVersion !== claim.verifiedBy.recipeVersion ||
    result.scheme !== scheme ||
    result.identifier !== identifier
  ) {
    throw new DacsError(
      `party Vet carried VerifyResult for ${claimSubject} is mismatched`,
    );
  }
  await authenticatePartyComponent(
    result as unknown as Record<string, unknown>,
    "dacs-verifyresult:v1:",
    deps,
  );
  assertPartyResultTime(result, now, `party Vet carried VerifyResult ${claimSubject}`);
  if (
    (claim.issuedAt !== undefined &&
      (claim.issuedAt > now || claim.issuedAt > result.verifiedAt)) ||
    (claim.expiresAt !== undefined &&
      ((claim.issuedAt !== undefined && claim.expiresAt < claim.issuedAt) ||
        (result.validUntil !== undefined &&
          claim.expiresAt > result.validUntil)))
  ) {
    throw new DacsError(
      `party Vet claim ${claimSubject} has future or inconsistent issuedAt/expiresAt`,
    );
  }
  return "freshness";
}

function finalizedAttemptFor(
  plan: Readonly<PartyVetPlan>,
  attempt: Readonly<PartyVetRequirementAttempt>,
  checkpoint: FinalizedVetResultCheckpoint,
  authenticatedResultAnchor: FinalizedVetAnchor,
): PartyVetFinalizedAttempt {
  if (
    checkpoint.resultAddress !== attempt.resultAddress ||
    checkpoint.resultArtifactHash !== exactArtifactHash(checkpoint.result)
  ) {
    throw new DacsError("party Vet finalized attempt is mismatched");
  }
  const outcome: PartyVetAttemptOutcome = {
    attemptId: attempt.attemptId,
    result: checkpoint.result,
  };
  // Reuse the pure path-provenance guard for this exact execution prefix.
  const priorIds = plan.attempts
    .slice(0, attempt.index)
    .map((candidate) => candidate.attemptId);
  if (priorIds.includes(outcome.attemptId)) {
    throw new DacsError("party Vet attempt identity is duplicated");
  }
  return deepFreezeSnapshot({
    attemptId: attempt.attemptId,
    resultAddress: checkpoint.resultAddress,
    result: checkpoint.result,
    resultArtifactHash: checkpoint.resultArtifactHash,
    resultAnchor: authenticatedResultAnchor,
  });
}

function partyAttemptRefs(
  attempts: readonly PartyVetFinalizedAttempt[],
  plan: Readonly<PartyVetPlan>,
): { freshness: VerifyResultRef[]; dealSpecific: VerifyResultRef[] } {
  const freshness: VerifyResultRef[] = [];
  const dealSpecific: VerifyResultRef[] = [];
  const addresses = new Set<string>();
  const refs = new Set<string>();
  for (const finalized of attempts) {
    const attempt = plan.attempts.find(
      (candidate) => candidate.attemptId === finalized.attemptId,
    );
    if (!attempt) {
      throw new DacsError("party Vet result has no requirement-path provenance");
    }
    if (addresses.has(finalized.resultAddress)) {
      throw new DacsError("party Vet repeats a finalized result address");
    }
    addresses.add(finalized.resultAddress);
    const ref = verifyResultRefFromAnchor(
      finalized.result,
      finalized.resultAnchor.ref,
    );
    const refIdentity = canonicalize(ref);
    if (refs.has(refIdentity)) {
      throw new DacsError("party Vet repeats a VerifyResult reference");
    }
    refs.add(refIdentity);
    (attempt.classification === "freshness" ? freshness : dealSpecific).push(ref);
  }
  return { freshness, dealSpecific };
}

function completePartyState(
  plan: PartyVetPlan,
  finalized: readonly PartyVetFinalizedAttempt[],
): Extract<ReturnType<typeof advancePartyVetPlan>, { status: "complete" }> {
  const outcomes = finalized.map((attempt) => ({
    attemptId: attempt.attemptId,
    result: attempt.result,
  }));
  const state = advancePartyVetPlan(plan, outcomes);
  if (state.status !== "complete") {
    throw new DacsError("party Vet composite checkpoint has an incomplete result set");
  }
  return state;
}

function assertPartyRecordBindings(
  record: Readonly<CompositeVerificationRecord>,
  finalized: readonly PartyVetFinalizedAttempt[],
  plan: PartyVetPlan,
): void {
  const state = completePartyState(plan, finalized);
  const refs = partyAttemptRefs(finalized, plan);
  const latestResultTime = finalized.reduce(
    (latest, attempt) => Math.max(latest, attempt.result.verifiedAt),
    0,
  );
  const expectedUnsigned: Omit<CompositeVerificationRecord, "signature"> = {
    recordVersion: "1",
    jobId: plan.jobId,
    evaluatedParty: plan.evaluatedParty,
    bundleHash: plan.bundleHash,
    requirementHash: plan.requirementHash,
    freshness: refs.freshness,
    supplementary: plan.supplementary,
    dealSpecific: refs.dealSpecific,
    overallDecision: state.overallDecision,
    ...(plan.warnings !== undefined ? { warnings: plan.warnings } : {}),
    generatedAt: record.generatedAt,
  };
  const { signature: _signature, ...actualUnsigned } = record;
  if (
    record.signature.algorithm !== plan.verifier.algorithm ||
    record.signature.signer !== plan.verifier.signer ||
    record.generatedAt < latestResultTime ||
    !canonicalEqual(actualUnsigned, expectedUnsigned)
  ) {
    throw new DacsError("party Vet composite record is mismatched");
  }
}

function capturePartyFinalizedAttempts(
  value: unknown,
  plan: PartyVetPlan,
): PartyVetFinalizedAttempt[] {
  const values = denseOwnArrayValues(value, "party Vet finalized attempts");
  const captured = values.map((raw, index): PartyVetFinalizedAttempt => {
    if (!isExactJsonRecord(raw) || !hasExactKeys(raw, [
      "attemptId",
      "resultAddress",
      "result",
      "resultArtifactHash",
      "resultAnchor",
    ])) {
      throw new DacsError(`party Vet finalized attempt ${index} is malformed`);
    }
    const attempt = plan.attempts.find(
      (candidate) => candidate.attemptId === raw.attemptId,
    );
    if (
      !attempt ||
      raw.resultAddress !== attempt.resultAddress ||
      !isVerifyResult(raw.result) ||
      raw.resultArtifactHash !== exactArtifactHash(raw.result) ||
      !isFinalizedVetAnchor(raw.resultAnchor)
    ) {
      throw new DacsError(`party Vet finalized attempt ${index} is mismatched`);
    }
    const result = raw.result;
    const { scheme, identifier } = claimParts(attempt.claimSubject);
    if (
      result.scheme !== scheme ||
      result.identifier !== identifier ||
      result.recipeVersion !== attempt.recipeVersion ||
      result.method !== attempt.method.kind ||
      result.signature.algorithm !== plan.verifier.algorithm ||
      result.signature.signer !== plan.verifier.signer
    ) {
      throw new DacsError(`party Vet finalized attempt ${index} bindings differ`);
    }
    return deepFreezeSnapshot(
      snapshot(raw, `party Vet finalized attempt ${index}`),
    ) as unknown as PartyVetFinalizedAttempt;
  });
  completePartyState(plan, captured);
  return captured;
}

function capturePartyCheckpoint(
  value: unknown,
  plan: PartyVetPlan,
): PartyVetOperationCheckpoint {
  if (!isExactJsonRecord(value)) {
    throw new DacsError("party Vet checkpoint is not exact JSON data");
  }
  const checkpoint = snapshot(value, "party Vet checkpoint");
  if (
    !isRecord(checkpoint) ||
    checkpoint.operationVersion !== "party-vet-1" ||
    checkpoint.operationKey !== plan.recordAddress ||
    checkpoint.operationHash !== plan.planHash ||
    !canonicalEqual(checkpoint.plan, plan) ||
    typeof checkpoint.stage !== "string"
  ) {
    throw new DacsError("party Vet checkpoint is corrupt or mismatched");
  }
  const common = [
    "operationVersion",
    "operationKey",
    "operationHash",
    "stage",
    "plan",
  ];
  if (checkpoint.stage === "planned") {
    if (!hasExactKeys(checkpoint, common)) {
      throw new DacsError("party Vet planned checkpoint contains extra fields");
    }
    return checkpoint as unknown as PartyVetOperationCheckpoint;
  }
  const executedAttempts = capturePartyFinalizedAttempts(
    checkpoint.executedAttempts,
    plan,
  );
  if (
    checkpoint.recordAddress !== plan.recordAddress ||
    !isCompositeVerificationRecord(checkpoint.record) ||
    checkpoint.recordArtifactHash !== exactArtifactHash(checkpoint.record)
  ) {
    throw new DacsError("party Vet composite checkpoint is corrupt");
  }
  assertPartyRecordBindings(checkpoint.record, executedAttempts, plan);
  const compositeKeys = [
    ...common,
    "executedAttempts",
    "recordAddress",
    "record",
    "recordArtifactHash",
  ];
  if (checkpoint.stage === "composite-submitting") {
    if (!hasExactKeys(checkpoint, compositeKeys)) {
      throw new DacsError("party Vet composite checkpoint contains extra fields");
    }
    return checkpoint as unknown as PartyVetOperationCheckpoint;
  }
  if (
    checkpoint.stage !== "complete" ||
    !isFinalizedVetAnchor(checkpoint.recordAnchor) ||
    !hasExactKeys(checkpoint, [...compositeKeys, "recordAnchor"])
  ) {
    throw new DacsError("party Vet complete checkpoint is partial or corrupt");
  }
  return checkpoint as unknown as PartyVetOperationCheckpoint;
}

async function loadPartyCheckpoint(
  store: VetOperationStore,
  plan: PartyVetPlan,
): Promise<PartyVetOperationCheckpoint | null> {
  let loaded: unknown;
  try {
    loaded = await store.load(plan.recordAddress);
  } catch {
    throw new DacsError("party Vet plan lookup is indeterminate");
  }
  return loaded === null ? null : capturePartyCheckpoint(loaded, plan);
}

type PartyVetCompareAndSet = (input: {
  operationKey: string;
  expected: Readonly<PartyVetOperationCheckpoint> | null;
  next: Readonly<PartyVetOperationCheckpoint>;
}) => Promise<boolean>;

async function transitionPartyCheckpoint(
  store: VetOperationStore,
  plan: PartyVetPlan,
  expected: PartyVetOperationCheckpoint | null,
  next: PartyVetOperationCheckpoint,
): Promise<PartyVetOperationCheckpoint> {
  let changed: boolean | undefined;
  try {
    const compareAndSet = store.compareAndSet as unknown as PartyVetCompareAndSet;
    const response = await compareAndSet(
      deepFreezeSnapshot({
        operationKey: plan.recordAddress,
        expected: expected === null
          ? null
          : snapshot(expected, "expected party Vet checkpoint"),
        next: snapshot(next, "next party Vet checkpoint"),
      }),
    );
    if (response !== true && response !== false) {
      throw new DacsError("party Vet plan CAS returned a non-boolean verdict");
    }
    changed = response;
  } catch (error) {
    if (error instanceof DacsError) throw error;
  }
  const loaded = await loadPartyCheckpoint(store, plan);
  if (loaded === null || !canonicalEqual(loaded, next)) {
    if (changed === false) {
      throw new DacsError("party Vet plan was claimed by a conflicting writer");
    }
    throw new DacsError("party Vet plan CAS did not durably store exact bytes");
  }
  return loaded;
}

async function authenticatePartyAttempt<TKey>(
  finalized: PartyVetFinalizedAttempt,
  attempt: PartyVetRequirementAttempt,
  deps: CapturedPartyVetDeps<TKey>,
): Promise<PartyVetFinalizedAttempt> {
  await authenticatePartyComponent(
    finalized.result as unknown as Record<string, unknown>,
    "dacs-verifyresult:v1:",
    deps,
    deps.vet.componentSigner,
  );
  const now = readClock(deps.vet.nowMs, "party Vet result acceptance");
  assertPartyResultTime(finalized.result, now, "party Vet VerifyResult");
  const anchor = await authenticateFinalizedJson(
    attempt.resultAddress,
    finalized.result as unknown as Record<string, unknown>,
    finalized.resultAnchor,
    deps.vet,
    isVerifyResult,
  );
  return deepFreezeSnapshot({ ...finalized, resultAnchor: anchor });
}

/**
 * Public VPC-2 producer: one exact bundle, one evaluated party, all required
 * claim attempts, and exactly one finalized party-level CVR.
 */
export async function partyVetCore<TKey>(
  requestSource: PartyVetRequest,
  dependencySource: PartyVetDeps<TKey>,
): Promise<VetProduction> {
  const request = capturePartyVetRequest(requestSource);
  const deps = capturePartyVetDeps(dependencySource);
  if (
    !isIdentityBundle(request.identityBundle) ||
    !isCompositeBundleRequirement(request.requirement)
  ) {
    throw new DacsError(
      "party Vet requires a current IdentityBundle and BundleRequirement",
    );
  }
  const claimRefs = request.identityBundle.claims.map((claim) => claim.ref);
  if (new Set(claimRefs).size !== claimRefs.length) {
    throw new DacsError("party Vet IdentityBundle repeats a claim reference");
  }
  const bundleHash = identityBundleHash(request.identityBundle);
  let presentationValid = false;
  try {
    presentationValid = (
      await deps.verifyIdentityPresentation(
        deepFreezeSnapshot({
          bundle: snapshot(request.identityBundle, "party Vet presentation bundle"),
          signedBytes: signedBytes(
            "dacs-bundle-presentation:v1:",
            bundleHash,
          ),
        }),
      )
    ) === true;
  } catch {
    presentationValid = false;
  }
  if (!presentationValid) {
    throw new DacsError("party Vet IdentityBundle presentation is not authenticated");
  }

  const classificationCache = new Map<
    string,
    "freshness" | "dealSpecific"
  >();
  const preparedAttempts: PartyVetAttemptInput[] = [];
  for (const attempt of request.attempts) {
    let classification = classificationCache.get(attempt.claimSubject);
    if (!classification) {
      classification = await authenticateCarriedResult(
        request.identityBundle,
        attempt.claimSubject,
        deps,
        readClock(deps.vet.nowMs, "party Vet bundle acceptance"),
      );
      classificationCache.set(attempt.claimSubject, classification);
    }
    preparedAttempts.push({
      requirementPath: attempt.requirementPath,
      claimSubject: attempt.claimSubject,
      classification,
      recipePin: attempt.recipePin,
      methodInput: attempt.methodInput,
    });
  }
  const plan = createPartyVetPlan({
    jobId: request.jobId,
    evaluatedParty: request.evaluatedParty,
    identityBundle: request.identityBundle,
    requirement: request.requirement,
    verifier: {
      algorithm: deps.vet.componentSigner.algorithm,
      signer: deps.vet.componentSigner.signer,
    },
    attempts: preparedAttempts,
    ...(request.supplementary !== undefined
      ? { supplementary: request.supplementary }
      : {}),
    ...(request.warnings !== undefined ? { warnings: request.warnings } : {}),
  });
  for (const attempt of plan.attempts) {
    if (
      attempt.recipe.availability !== "mocked" &&
      attempt.recipe.availability !== "failed" &&
      attempt.method.kind !== "self-signed" &&
      attempt.method.kind !== "consensus-backed-proxy"
    ) {
      throw new DacsError(
        `unsupported current verification method: ${attempt.method.kind}`,
      );
    }
    if (
      attempt.method.kind === "consensus-backed-proxy" &&
      attempt.requirement.parameters !== undefined &&
      Object.prototype.hasOwnProperty.call(
        attempt.requirement.parameters,
        "identifier",
      )
    ) {
      throw new DacsError(
        "ClaimRequirement.parameters.identifier is reserved for the canonical subject",
      );
    }
    if (
      attempt.requirement.parameters !== undefined &&
      !deps.vet.matchRequirementParameters &&
      attempt.recipe.availability !== "mocked" &&
      attempt.recipe.availability !== "failed"
    ) {
      throw new DacsError(
        "parameterized ClaimRequirement requires matchRequirementParameters",
      );
    }
  }

  const planned: PartyVetOperationCheckpoint = {
    operationVersion: "party-vet-1",
    operationKey: plan.recordAddress,
    operationHash: plan.planHash,
    stage: "planned",
    plan,
  };
  let partyCheckpoint = await loadPartyCheckpoint(deps.vet.operationStore, plan);
  if (partyCheckpoint === null) {
    partyCheckpoint = await transitionPartyCheckpoint(
      deps.vet.operationStore,
      plan,
      null,
      planned,
    );
  }

  const finalizedAttempts: PartyVetFinalizedAttempt[] = [];
  let execution = advancePartyVetPlan(plan, []);
  while (execution.status === "pending") {
    const attempt = execution.nextAttempt;
    const vetRequest = deepFreezeSnapshot({
      jobId: plan.jobId,
      subject: attempt.claimSubject,
      bundleHash: plan.bundleHash,
      requirement: plan.requirement,
      recipe: attempt.recipe,
      classification: attempt.classification,
      ...(attempt.methodInput.kind === "self-signed"
        ? {
            selfSigned: {
              assertion: attempt.methodInput.assertion,
              signature: attempt.methodInput.signature,
            },
          }
        : {}),
    }) as unknown as VetRequest;
    const { scheme, identifier } = claimParts(attempt.claimSubject);
    const context: VetCheckpointContext = {
      operationKey: attempt.operationKey,
      operationHash: attempt.attemptId,
      resultAddress: attempt.resultAddress,
      recordAddress: plan.recordAddress,
      scheme,
      identifier,
      method: attempt.method.kind,
      recipeVersion: attempt.recipeVersion,
      req: vetRequest,
      signer: deps.vet.componentSigner,
    };
    const existingAttemptCheckpoint = partyCheckpoint.stage === "planned"
      ? null
      : await loadVetCheckpoint(deps.vet.operationStore, context);
    if (
      partyCheckpoint.stage !== "planned" &&
      (existingAttemptCheckpoint === null ||
        existingAttemptCheckpoint.stage !== "result-finalized")
    ) {
      throw new DacsError(
        "party Vet advanced checkpoint is missing an exact finalized attempt checkpoint",
      );
    }
    const durable = await produceDurableVetResult(
      vetRequest,
      deps.vet,
      attempt.requirement,
      attempt.method,
      context,
      (artifact, separator) => authenticatePartyComponent(
        artifact,
        separator,
        deps,
        plan.verifier,
      ),
    );
    if (durable.checkpoint.stage !== "result-finalized") {
      throw new DacsError(
        "party Vet attempt checkpoint contains an unexpected composite stage",
      );
    }
    const finalized = await authenticatePartyAttempt(
      finalizedAttemptFor(
        plan,
        attempt,
        durable.checkpoint,
        durable.authenticatedResultAnchor,
      ),
      attempt,
      deps,
    );
    finalizedAttempts.push(finalized);
    execution = advancePartyVetPlan(
      plan,
      finalizedAttempts.map((entry) => ({
        attemptId: entry.attemptId,
        result: entry.result,
      })),
    );
  }

  if (
    partyCheckpoint.stage !== "planned" &&
    !canonicalEqual(
      finalizedAttempts,
      partyCheckpoint.executedAttempts,
    )
  ) {
    throw new DacsError(
      "party Vet advanced checkpoint does not match its finalized attempt checkpoints",
    );
  }

  if (partyCheckpoint.stage === "planned") {
    const state = completePartyState(plan, finalizedAttempts);
    const refs = partyAttemptRefs(finalizedAttempts, plan);
    const latestResultTime = finalizedAttempts.reduce(
      (latest, attempt) => Math.max(latest, attempt.result.verifiedAt),
      0,
    );
    const compositeInputHash = exactArtifactHash({
      planHash: plan.planHash,
      executedAttempts: finalizedAttempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        resultAddress: attempt.resultAddress,
        resultArtifactHash: attempt.resultArtifactHash,
        resultRef: verifyResultRefFromAnchor(
          attempt.result,
          attempt.resultAnchor.ref,
        ),
      })),
    });
    const record = snapshot(
      await runVetStep(
        deps.vet.operationStore,
        { operationKey: plan.recordAddress, operationHash: plan.planHash },
        "composite",
        compositeInputHash,
        async () => {
          const unsignedRecord: Omit<CompositeVerificationRecord, "signature"> = {
            recordVersion: "1",
            jobId: plan.jobId,
            evaluatedParty: plan.evaluatedParty,
            bundleHash: plan.bundleHash,
            requirementHash: plan.requirementHash,
            freshness: refs.freshness,
            supplementary: plan.supplementary,
            dealSpecific: refs.dealSpecific,
            overallDecision: state.overallDecision,
            ...(plan.warnings !== undefined ? { warnings: plan.warnings } : {}),
            generatedAt: readClock(
              deps.vet.nowMs,
              "party Vet composite generatedAt",
              latestResultTime,
            ),
          };
          return signComponentArtifact(
            deepFreezeSnapshot(
              snapshot(unsignedRecord, "unsigned party Vet composite"),
            ),
            "dacs-composite:v1:",
            deps.vet.componentSigner,
          );
        },
      ),
      "signed party Vet composite",
    ) as CompositeVerificationRecord;
    if (!isCompositeVerificationRecord(record)) {
      throw new DacsError("party Vet composite signer produced a malformed record");
    }
    assertPartyRecordBindings(record, finalizedAttempts, plan);
    await authenticatePartyComponent(
      record as unknown as Record<string, unknown>,
      "dacs-composite:v1:",
      deps,
      plan.verifier,
    );
    const next: PartyVetOperationCheckpoint = {
      ...planned,
      stage: "composite-submitting",
      executedAttempts: finalizedAttempts,
      recordAddress: plan.recordAddress,
      record,
      recordArtifactHash: exactArtifactHash(record),
    };
    partyCheckpoint = await transitionPartyCheckpoint(
      deps.vet.operationStore,
      plan,
      partyCheckpoint,
      next,
    );
  }

  if (partyCheckpoint.stage === "composite-submitting") {
    const submitting = partyCheckpoint;
    await authenticatePartyComponent(
      submitting.record as unknown as Record<string, unknown>,
      "dacs-composite:v1:",
      deps,
      plan.verifier,
    );
    const anchorValue = await runVetStep(
      deps.vet.operationStore,
      { operationKey: plan.recordAddress, operationHash: plan.planHash },
      "composite-anchor",
      exactArtifactHash({
        logicalAddress: plan.recordAddress,
        artifactHash: submitting.recordArtifactHash,
      }),
      () => reconcileOrPersistFinalizedJson(
        plan.recordAddress,
        submitting.record as unknown as Record<string, unknown>,
        deps.vet,
        isCompositeVerificationRecord,
      ),
    );
    if (!isFinalizedVetAnchor(anchorValue)) {
      throw new DacsError("party Vet composite anchor returned corrupt state");
    }
    const recordAnchor = await authenticateFinalizedJson(
      plan.recordAddress,
      submitting.record as unknown as Record<string, unknown>,
      anchorValue,
      deps.vet,
      isCompositeVerificationRecord,
    );
    const next: PartyVetOperationCheckpoint = {
      ...submitting,
      stage: "complete",
      recordAnchor,
    };
    partyCheckpoint = await transitionPartyCheckpoint(
      deps.vet.operationStore,
      plan,
      partyCheckpoint,
      next,
    );
  }

  if (partyCheckpoint.stage !== "complete") {
    throw new DacsError("party Vet operation could not reach complete state");
  }
  assertPartyRecordBindings(
    partyCheckpoint.record,
    partyCheckpoint.executedAttempts,
    plan,
  );
  await authenticatePartyComponent(
    partyCheckpoint.record as unknown as Record<string, unknown>,
    "dacs-composite:v1:",
    deps,
    plan.verifier,
  );
  const acceptedAt = readClock(deps.vet.nowMs, "party Vet composite acceptance");
  if (partyCheckpoint.record.generatedAt > acceptedAt) {
    throw new DacsError("party Vet composite record is future-dated");
  }
  const recordAnchor = await authenticateFinalizedJson(
    plan.recordAddress,
    partyCheckpoint.record as unknown as Record<string, unknown>,
    partyCheckpoint.recordAnchor,
    deps.vet,
    isCompositeVerificationRecord,
  );
  return structuredClone({
    record: partyCheckpoint.record,
    recordRef: recordAnchor.ref,
    anchorReceipt: recordAnchor.receipt,
  });
}
