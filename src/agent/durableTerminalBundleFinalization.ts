/**
 * Durable, role-local orchestration for DACS-5 failure and abort bundles.
 *
 * The pure terminal core owns all normative derivation and matrix verification. This layer owns
 * only fencing, write-ahead state, transport hand-off, own-role publication, and authenticated
 * restart recovery. It intentionally accepts exactly one local signing callback: remote roles
 * can contribute detached data, never executable signing capability.
 */
import { types as nodeTypes } from "node:util";

import type {
  AnchorReceipt,
  BundleBinding,
  BundlePartyRole,
  ComponentSignature,
  FaultAttestationBundle,
} from "../artifacts/types.js";
import {
  BUNDLE_BINDING_SEPARATOR,
  isAnchorReceipt,
  isBundleBinding,
  isCanonicalBase64Url,
  isFaultAttestationBundle,
} from "../artifacts/index.js";
import {
  bundleAddress,
  canonicalize,
  contentHash,
  sha256Hex,
} from "../canonical/index.js";
import { ed25519Verify, publicKeyFromRaw, signedBytes } from "../crypto/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  FENCED_SESSION_STORE_VERSION,
  sessionReceiptKey,
  sessionRecordShapeViolation,
  terminalBundleStorePhase,
  type CheckpointValue,
  type FencedSessionStoreV2,
  type SessionCheckpoint,
  type SessionLeaseToken,
  type SessionRecord,
  type TerminalBundleStoreRole,
  type TerminalBundleStoreStage,
} from "./fencedSessionStore.js";
import {
  assembleTerminalBundleForOwnRole,
  createTerminalBundlePlan,
  createTerminalBundleSignatureContribution,
  createTerminalBundleSignatureMatrix,
  terminalBundleSignedBytes,
  type TerminalBundleAuthority,
  type TerminalBundlePlan,
  type TerminalBundleSignatureContribution,
  type TerminalBundleSignatureMatrix,
  type TerminalBundleSignerPublicKey,
  type TerminalBundleSigningMode,
} from "./terminalBundleFinalization.js";
import { attestationBundleHash } from "./twoSidedBundle.js";

const MAX_CAS_ATTEMPTS = 16;
const MAX_RELEASE_ATTEMPTS = 8;

export interface TerminalBundleEffectFence extends SessionLeaseToken {
  /** Stable across generations for one exact logical effect. */
  idempotencyKey: string;
}

export type TerminalBundleFencedSigner = (
  bytes: Uint8Array,
  fence: Readonly<TerminalBundleEffectFence>,
) => Promise<Uint8Array | string> | Uint8Array | string;

export interface DurableTerminalBundleInput {
  /** Already-authenticated terminal authority; the pure core revalidates and snapshots it. */
  authority: Readonly<TerminalBundleAuthority>;
  signingMode: Readonly<TerminalBundleSigningMode>;
  local: {
    role: BundlePartyRole;
    primaryClaim: string;
    signer: TerminalBundleFencedSigner;
  };
  /** Exact authenticated Ed25519 key set for every signer required by the plan. */
  signerKeys: readonly Readonly<TerminalBundleSignerPublicKey>[];
}

export interface TerminalBundleTransportIdentity {
  jobId: string;
  authorityHash: string;
  planHash: string;
}

/** Four-state resolution. Absence must be authoritative before any effect can be driven. */
export type TerminalBundleResolution<T> =
  | { disposition: "present"; value: T }
  | { disposition: "authoritatively-absent"; reason: string }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export interface TerminalBundleTransport {
  resolveProposal: (
    identity: Readonly<TerminalBundleTransportIdentity>,
  ) => Promise<TerminalBundleResolution<unknown>> | TerminalBundleResolution<unknown>;
  publishProposal: (
    input: {
      identity: Readonly<TerminalBundleTransportIdentity>;
      plan: Readonly<TerminalBundlePlan>;
    },
    fence: Readonly<TerminalBundleEffectFence>,
  ) => Promise<void> | void;
  resolveContribution: (
    input: {
      identity: Readonly<TerminalBundleTransportIdentity>;
      signerRole: BundlePartyRole;
    },
  ) => Promise<TerminalBundleResolution<unknown>> | TerminalBundleResolution<unknown>;
  publishContribution: (
    input: {
      identity: Readonly<TerminalBundleTransportIdentity>;
      contribution: Readonly<TerminalBundleSignatureContribution>;
    },
    fence: Readonly<TerminalBundleEffectFence>,
  ) => Promise<void> | void;
}

export interface TerminalBundleAnchorPublication {
  role: BundlePartyRole;
  logicalAddress: string;
  nativeAddress: string;
  bundleContentHash: string;
  bundle: Readonly<FaultAttestationBundle>;
  anchorReceipt: Readonly<AnchorReceipt>;
  anchorTx?: string;
}

export type TerminalBundleVerification =
  | { disposition: "valid" }
  | { disposition: "invalid"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export interface DurableTerminalBundleProvider {
  resolveOwnBundle: (input: {
    role: BundlePartyRole;
    logicalAddress: string;
    bundleContentHash: string;
  }) =>
    | Promise<TerminalBundleResolution<unknown>>
    | TerminalBundleResolution<unknown>;
  submitOwnBundle: (
    input: {
      role: BundlePartyRole;
      logicalAddress: string;
      bundle: Readonly<FaultAttestationBundle>;
    },
    fence: Readonly<TerminalBundleEffectFence>,
  ) => Promise<void> | void;
  verifyOwnBundlePublication: (
    publication: Readonly<TerminalBundleAnchorPublication>,
  ) => Promise<TerminalBundleVerification> | TerminalBundleVerification;
  resolveOwnBundleBinding: (input: {
    role: BundlePartyRole;
    logicalAddress: string;
    signer: string;
  }) =>
    | Promise<TerminalBundleResolution<unknown>>
    | TerminalBundleResolution<unknown>;
  publishOwnBundleBinding: (
    binding: Readonly<BundleBinding>,
    fence: Readonly<TerminalBundleEffectFence>,
  ) => Promise<void> | void;
  verifyOwnBundleBinding: (
    binding: Readonly<BundleBinding>,
  ) => Promise<TerminalBundleVerification> | TerminalBundleVerification;
}

export type TerminalBundleSignaturePurpose = "bundle-copy" | "bundle-binding";

export interface TerminalBundleFinalizationDurability {
  store: FencedSessionStoreV2;
  workerId: string;
  leaseTtlMs: number;
  leaseNowMs?: () => number;
  transport: TerminalBundleTransport;
  reconcileSignature: (
    input: {
      purpose: TerminalBundleSignaturePurpose;
      role: BundlePartyRole;
      copyRole: BundlePartyRole;
      signer: string;
      messageHash: string;
      signedBytes: Uint8Array;
    },
    fence: Readonly<TerminalBundleEffectFence>,
  ) =>
    | Promise<TerminalBundleResolution<Uint8Array | string>>
    | TerminalBundleResolution<Uint8Array | string>;
}

export interface DurableFinalizedTerminalBundle {
  state: "finalised";
  role: BundlePartyRole;
  authorityHash: string;
  planHash: string;
  matrixHash: string;
  localContribution: Readonly<TerminalBundleSignatureContribution>;
  signatureMatrix: Readonly<TerminalBundleSignatureMatrix>;
  bundle: Readonly<FaultAttestationBundle>;
  publication: Readonly<TerminalBundleAnchorPublication>;
  binding: Readonly<BundleBinding>;
}

export type TerminalBundleFinalizationStage =
  | "lease"
  | "authority"
  | "proposal-publication"
  | "contribution-signing"
  | "contribution-publication"
  | "signature-matrix"
  | "bundle-anchor"
  | "bundle-binding"
  | "terminal-recovery";

export type DurableTerminalBundleProgress =
  | {
      disposition: "finalised";
      result: Readonly<DurableFinalizedTerminalBundle>;
      recovered: boolean;
    }
  | {
      disposition: "waiting" | "rejected" | "indeterminate";
      stage: TerminalBundleFinalizationStage;
      reason: string;
    };

export const terminalBundleFinalizationCheckpointName = {
  authority: "authority",
  proposalPublication: "proposal-publication",
  contributionPublication: "contribution-publication",
  matrix: "signature-matrix",
  anchor: "bundle-anchor",
  bindingSignature: "bundle-binding-signature",
  bindingPublication: "bundle-binding-publication",
  result: "result",
} as const;

export function terminalBundleFinalizationCheckpointKey(
  role: BundlePartyRole,
  name: string,
): string {
  return `terminal:${role}:${name}`;
}

export type TerminalBundleCheckpointState = "not-started" | "intent" | "outcome";

export type TerminalBundleFinalizationStatusLoad =
  | { status: "missing" }
  | { status: "corrupt"; reason: string }
  | { status: "unsupported"; version: number }
  | {
      status: "ok";
      jobId: string;
      role: BundlePartyRole;
      phase: string;
      revision: number;
      lease?: { owner: string; generation: number; expiresAt: number };
      checkpoints: Record<
        keyof typeof terminalBundleFinalizationCheckpointName,
        TerminalBundleCheckpointState
      >;
      signatureOutcomes: number;
      contributionOutcomes: number;
      bundleReceipt?: string;
      updatedAt: number;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value;
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

const clone = <T>(value: T): T => structuredClone(value);

function snapshotDataValue(
  value: unknown,
  subject: string,
  ancestors: Set<object>,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${subject} contains a non-canonical number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${subject} must contain data values only`);
  }
  if (nodeTypes.isProxy(value)) throw new TypeError(`${subject} cannot contain proxies`);
  if (ancestors.has(value)) throw new TypeError(`${subject} must be acyclic`);
  ancestors.add(value);
  try {
    if (value instanceof Uint8Array) {
      if (
        Object.getPrototypeOf(value) !== Uint8Array.prototype ||
        Object.getPrototypeOf(value.buffer) !== ArrayBuffer.prototype ||
        value.byteOffset !== 0 ||
        value.byteLength !== value.buffer.byteLength ||
        Reflect.ownKeys(value).some((key, index) => key !== String(index))
      ) {
        throw new TypeError(`${subject} contains a non-canonical byte array`);
      }
      return Uint8Array.from(value);
    }
    const prototype = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new TypeError(`${subject} cannot contain symbol fields`);
    }
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        throw new TypeError(`${subject} arrays must use the intrinsic prototype`);
      }
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new TypeError(`${subject} arrays must be dense data arrays`);
      }
      return keys.map((key) => {
        const descriptor = descriptors[key]!;
        if (descriptor.enumerable !== true || !("value" in descriptor)) {
          throw new TypeError(`${subject} cannot contain accessors`);
        }
        return snapshotDataValue(descriptor.value, `${subject}[${key}]`, ancestors);
      });
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${subject} must contain plain records only`);
    }
    const copy = Object.create(prototype) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        descriptor.enumerable !== true ||
        !("value" in descriptor) ||
        descriptor.value === undefined
      ) {
        throw new TypeError(`${subject}.${key} must be an enumerable data property`);
      }
      copy[key] = snapshotDataValue(descriptor.value, `${subject}.${key}`, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotData<T>(value: T, subject: string): T {
  return snapshotDataValue(value, subject, new Set<object>()) as T;
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    typeof value !== "object" ||
    value instanceof Uint8Array ||
    Object.isFrozen(value)
  ) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function immutable<T>(value: T): Readonly<T> {
  return deepFreeze(clone(value));
}

function exact(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function exactOwnKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.has(key));
}

function latestCheckpoint(
  checkpoints: readonly SessionCheckpoint[],
  key: string,
): SessionCheckpoint | undefined {
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    if (checkpoints[index]?.key === key) return checkpoints[index];
  }
  return undefined;
}

function dataMatches(
  actual: Record<string, CheckpointValue> | undefined,
  expected: Record<string, CheckpointValue>,
): boolean {
  if (!actual) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every(
      (key, index) => key === expectedKeys[index] && actual[key] === expected[key],
    );
}

function encodeCanonical(value: unknown, subject: string): { encoded: string; hash: string } {
  try {
    const json = canonicalize(value);
    return {
      encoded: Buffer.from(json, "utf8").toString("base64url"),
      hash: sha256Hex(json),
    };
  } catch (error) {
    throw new DacsError(`${subject} cannot be encoded canonically`, { cause: error });
  }
}

function decodeCanonical(encoded: unknown, hash: unknown, subject: string): unknown {
  if (!isCanonicalBase64Url(encoded) || !isHash(hash)) {
    throw new DacsError(`${subject} encoding is malformed`);
  }
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) throw new Error("non-canonical base64url");
    const json = bytes.toString("utf8");
    if (!Buffer.from(json, "utf8").equals(bytes)) throw new Error("non-canonical UTF-8");
    if (sha256Hex(json) !== hash) throw new Error("hash mismatch");
    const parsed = JSON.parse(json) as unknown;
    if (canonicalize(parsed) !== json) throw new Error("non-canonical JSON");
    return parsed;
  } catch (error) {
    throw new DacsError(`${subject} cannot be decoded`, { cause: error });
  }
}

function normalizeSignature(value: Uint8Array | string, subject: string): string {
  const encoded = typeof value === "string"
    ? value
    : Buffer.from(value).toString("base64url");
  if (
    !isCanonicalBase64Url(encoded) ||
    Buffer.from(encoded, "base64url").byteLength !== 64
  ) {
    throw new DacsError(`${subject} is not one canonical Base64URL Ed25519 signature`);
  }
  return encoded;
}

const INERT_RECEIVER = Object.freeze(Object.create(null)) as object;
type DescriptorMap = Record<PropertyKey, PropertyDescriptor>;

function descriptors(value: unknown, subject: string): DescriptorMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object of owned data properties`);
  }
  if (nodeTypes.isProxy(value)) throw new TypeError(`${subject} cannot be a proxy`);
  try {
    const map = Object.getOwnPropertyDescriptors(value) as DescriptorMap;
    for (const [key, descriptor] of Object.entries(map)) {
      if (!("value" in descriptor)) {
        throw new TypeError(`${subject}.${key} must be an owned data property`);
      }
    }
    return map;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError(`${subject} cannot be inspected safely`, { cause: error });
  }
}

function dataProperty<T>(map: DescriptorMap, key: string, subject: string): T {
  const descriptor = map[key];
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`${subject}.${key} must be an owned data property`);
  }
  return descriptor.value as T;
}

function optionalProperty<T>(
  map: DescriptorMap,
  key: string,
  subject: string,
): T | undefined {
  const descriptor = map[key];
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) {
    throw new TypeError(`${subject}.${key} must be an owned data property`);
  }
  return descriptor.value as T;
}

function inertFunction<T>(value: unknown, subject: string): T {
  if (typeof value !== "function") throw new TypeError(`${subject} must be callable`);
  return ((...args: unknown[]) => Reflect.apply(value, INERT_RECEIVER, args)) as T;
}

function callback<T>(map: DescriptorMap, key: string, subject: string): T {
  return inertFunction<T>(dataProperty(map, key, subject), `${subject}.${key}`);
}

function optionalCallback<T>(map: DescriptorMap, key: string, subject: string): T | undefined {
  const value = optionalProperty<unknown>(map, key, subject);
  return value === undefined ? undefined : inertFunction<T>(value, `${subject}.${key}`);
}

function captureStore(value: unknown): FencedSessionStoreV2 {
  const subject = "terminal bundle durability store";
  const map = descriptors(value, subject);
  if (dataProperty(map, "apiVersion", subject) !== FENCED_SESSION_STORE_VERSION) {
    throw new TypeError("terminal bundle durability requires FencedSessionStoreV2");
  }
  const create = callback<FencedSessionStoreV2["create"]>(map, "create", subject);
  const load = callback<FencedSessionStoreV2["load"]>(map, "load", subject);
  const transition = callback<FencedSessionStoreV2["transition"]>(map, "transition", subject);
  const claimCheckpoint = callback<FencedSessionStoreV2["claimCheckpoint"]>(
    map,
    "claimCheckpoint",
    subject,
  );
  const acquireLease = callback<FencedSessionStoreV2["acquireLease"]>(
    map,
    "acquireLease",
    subject,
  );
  const renewLease = callback<FencedSessionStoreV2["renewLease"]>(
    map,
    "renewLease",
    subject,
  );
  const bindSessionAuthorization = callback<FencedSessionStoreV2["bindSessionAuthorization"]>(
    map,
    "bindSessionAuthorization",
    subject,
  );
  const bindHash = callback<FencedSessionStoreV2["bindHash"]>(map, "bindHash", subject);
  const list = callback<FencedSessionStoreV2["list"]>(map, "list", subject);
  return Object.freeze({
    apiVersion: FENCED_SESSION_STORE_VERSION,
    create: async (input) => snapshotData(await create(clone(input)), "terminal store create result"),
    load: async (jobId) => snapshotData(await load(jobId), "terminal store load result"),
    transition: async (input) =>
      snapshotData(await transition(clone(input)), "terminal store transition result"),
    claimCheckpoint: async (input) =>
      snapshotData(await claimCheckpoint(clone(input)), "terminal store checkpoint result"),
    acquireLease: async (input) =>
      snapshotData(await acquireLease(clone(input)), "terminal store lease result"),
    renewLease: async (input) =>
      snapshotData(await renewLease(clone(input)), "terminal store renewal result"),
    bindSessionAuthorization: async (input) =>
      snapshotData(
        await bindSessionAuthorization(clone(input)),
        "terminal store authorization result",
      ),
    bindHash: async (input) =>
      snapshotData(await bindHash(clone(input)), "terminal store hash binding result"),
    list: async (filter) =>
      snapshotData(await list(filter === undefined ? undefined : clone(filter)), "terminal store list result"),
  } satisfies FencedSessionStoreV2);
}

function captureTransport(value: unknown): TerminalBundleTransport {
  const subject = "terminal bundle transport";
  const map = descriptors(value, subject);
  return Object.freeze({
    resolveProposal: callback(map, "resolveProposal", subject),
    publishProposal: callback(map, "publishProposal", subject),
    resolveContribution: callback(map, "resolveContribution", subject),
    publishContribution: callback(map, "publishContribution", subject),
  }) as TerminalBundleTransport;
}

function captureProvider(value: unknown): DurableTerminalBundleProvider {
  const subject = "durable terminal bundle provider";
  const map = descriptors(value, subject);
  return Object.freeze({
    resolveOwnBundle: callback(map, "resolveOwnBundle", subject),
    submitOwnBundle: callback(map, "submitOwnBundle", subject),
    verifyOwnBundlePublication: callback(map, "verifyOwnBundlePublication", subject),
    resolveOwnBundleBinding: callback(map, "resolveOwnBundleBinding", subject),
    publishOwnBundleBinding: callback(map, "publishOwnBundleBinding", subject),
    verifyOwnBundleBinding: callback(map, "verifyOwnBundleBinding", subject),
  }) as DurableTerminalBundleProvider;
}

interface CapturedTerminalInput {
  plan: Readonly<TerminalBundlePlan>;
  local: {
    role: BundlePartyRole;
    primaryClaim: string;
    signer: TerminalBundleFencedSigner;
  };
  signerKeys: readonly Readonly<TerminalBundleSignerPublicKey>[];
  signerKeysHash: string;
}

function signerKeysWire(
  keys: readonly Readonly<TerminalBundleSignerPublicKey>[],
): Array<Record<string, unknown>> {
  return keys.map((key) => ({
    role: key.role,
    primaryClaim: key.primaryClaim,
    algorithm: key.algorithm,
    publicKey: Buffer.from(key.publicKey).toString("base64url"),
  }));
}

function captureSignerKeys(value: unknown): readonly Readonly<TerminalBundleSignerPublicKey>[] {
  const captured = snapshotData(value, "terminal signer keys") as unknown;
  if (!Array.isArray(captured)) throw new TypeError("terminal signer keys must be an array");
  const seen = new Set<BundlePartyRole>();
  return Object.freeze(captured.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      !exactOwnKeys(candidate, ["role", "primaryClaim", "algorithm", "publicKey"]) ||
      (candidate.role !== "buyer" &&
        candidate.role !== "seller" &&
        candidate.role !== "orchestrator") ||
      !isNonEmpty(candidate.primaryClaim) ||
      candidate.algorithm !== "ed25519" ||
      !(candidate.publicKey instanceof Uint8Array) ||
      candidate.publicKey.byteLength !== 32 ||
      seen.has(candidate.role)
    ) {
      throw new TypeError(`terminal signer keys[${index}] is malformed or duplicated`);
    }
    seen.add(candidate.role);
    return Object.freeze({
      role: candidate.role,
      primaryClaim: candidate.primaryClaim,
      algorithm: "ed25519" as const,
      publicKey: Uint8Array.from(candidate.publicKey),
    });
  }));
}

function captureInput(value: DurableTerminalBundleInput): CapturedTerminalInput {
  const subject = "durable terminal bundle input";
  const map = descriptors(value, subject);
  const authority = snapshotData(
    dataProperty(map, "authority", subject),
    `${subject}.authority`,
  );
  const signingMode = snapshotData(
    dataProperty(map, "signingMode", subject),
    `${subject}.signingMode`,
  );
  const plan = createTerminalBundlePlan(
    authority as Readonly<TerminalBundleAuthority>,
    signingMode as Readonly<TerminalBundleSigningMode>,
  );
  const localSubject = `${subject}.local`;
  const localMap = descriptors(dataProperty(map, "local", subject), localSubject);
  const role = dataProperty<unknown>(localMap, "role", localSubject);
  const primaryClaim = dataProperty<unknown>(localMap, "primaryClaim", localSubject);
  const signer = callback<TerminalBundleFencedSigner>(localMap, "signer", localSubject);
  if (
    (role !== "buyer" && role !== "seller" && role !== "orchestrator") ||
    !isNonEmpty(primaryClaim)
  ) {
    throw new TypeError("durable terminal local role identity is malformed");
  }
  const requiredLocal = plan.requiredSigners.find((candidate) => candidate.role === role);
  if (!requiredLocal || requiredLocal.primaryClaim !== primaryClaim) {
    throw new DacsError("durable terminal signer does not own one exact required role");
  }
  const suppliedSignerKeys = captureSignerKeys(dataProperty(map, "signerKeys", subject));
  const suppliedWire = signerKeysWire(suppliedSignerKeys);
  if (
    suppliedSignerKeys.length !== plan.requiredSigners.length ||
    plan.requiredSigners.some(
      (required) => !suppliedWire.some(
        (candidate) =>
          candidate.role === required.role && candidate.primaryClaim === required.primaryClaim,
      ),
    )
  ) {
    throw new DacsError("durable terminal signer key set is incomplete or substituted");
  }
  const signerKeys = Object.freeze(plan.requiredSigners.map((required) => {
    const key = suppliedSignerKeys.find((candidate) => candidate.role === required.role);
    if (!key) throw new DacsError(`durable terminal ${required.role} signer key is missing`);
    return key;
  }));
  const wire = signerKeysWire(signerKeys);
  return Object.freeze({
    plan,
    local: Object.freeze({ role, primaryClaim, signer }),
    signerKeys,
    signerKeysHash: sha256Hex(canonicalize(wire)),
  });
}

function captureDurability(value: TerminalBundleFinalizationDurability): TerminalBundleFinalizationDurability {
  const subject = "terminal bundle durability";
  const map = descriptors(value, subject);
  const workerId = dataProperty<unknown>(map, "workerId", subject);
  const leaseTtlMs = dataProperty<unknown>(map, "leaseTtlMs", subject);
  const leaseNowMs = optionalCallback<() => number>(map, "leaseNowMs", subject);
  if (!isNonEmpty(workerId) || !Number.isSafeInteger(leaseTtlMs) || (leaseTtlMs as number) <= 0) {
    throw new TypeError("terminal durability requires workerId and positive integer leaseTtlMs");
  }
  return Object.freeze({
    store: captureStore(dataProperty(map, "store", subject)),
    workerId,
    leaseTtlMs,
    ...(leaseNowMs ? { leaseNowMs } : {}),
    transport: captureTransport(dataProperty(map, "transport", subject)),
    reconcileSignature: callback(map, "reconcileSignature", subject),
  }) as TerminalBundleFinalizationDurability;
}

function captureResolution<T>(value: unknown, subject: string): TerminalBundleResolution<T> {
  const captured = snapshotData(value, `${subject} output`) as unknown;
  if (!isRecord(captured) || typeof captured.disposition !== "string") {
    throw new SubstrateError(`${subject} returned a malformed disposition`);
  }
  if (
    captured.disposition === "present" &&
    exactOwnKeys(captured, ["disposition", "value"])
  ) return captured as unknown as TerminalBundleResolution<T>;
  if (
    (captured.disposition === "authoritatively-absent" ||
      captured.disposition === "rejected" ||
      captured.disposition === "indeterminate") &&
    exactOwnKeys(captured, ["disposition", "reason"]) &&
    isNonEmpty(captured.reason)
  ) return captured as TerminalBundleResolution<T>;
  throw new SubstrateError(`${subject} returned a malformed disposition`);
}

function captureVerification(value: unknown, subject: string): TerminalBundleVerification {
  const captured = snapshotData(value, `${subject} output`) as unknown;
  if (!isRecord(captured) || typeof captured.disposition !== "string") {
    throw new SubstrateError(`${subject} returned a malformed disposition`);
  }
  if (captured.disposition === "valid" && exactOwnKeys(captured, ["disposition"])) {
    return captured as TerminalBundleVerification;
  }
  if (
    (captured.disposition === "invalid" || captured.disposition === "indeterminate") &&
    exactOwnKeys(captured, ["disposition", "reason"]) &&
    isNonEmpty(captured.reason)
  ) return captured as TerminalBundleVerification;
  throw new SubstrateError(`${subject} returned a malformed disposition`);
}

const TERMINAL_PHASE_RANK = new Map<TerminalBundleStoreStage, number>([
  ["authority", 0],
  ["proposal-publication-pending", 1],
  ["contribution-signing", 2],
  ["contribution-publication-pending", 3],
  ["matrix-review", 4],
  ["bundle-anchor-pending", 5],
  ["bundle-binding-signing", 6],
  ["bundle-binding-publication-pending", 7],
  ["finalised", 8],
]);

class ProgressSignal extends Error {
  readonly progress: Exclude<DurableTerminalBundleProgress, { disposition: "finalised" }>;

  constructor(
    disposition: "waiting" | "rejected" | "indeterminate",
    stage: TerminalBundleFinalizationStage,
    reason: string,
  ) {
    super(reason);
    this.name = "TerminalBundleProgressSignal";
    this.progress = { disposition, stage, reason };
  }
}

function retainedProgressSignal(error: unknown): ProgressSignal | undefined {
  let cursor: unknown = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 8 && cursor !== undefined; depth += 1) {
    if (cursor instanceof ProgressSignal) return cursor;
    if (
      cursor === null ||
      (typeof cursor !== "object" && typeof cursor !== "function") ||
      visited.has(cursor)
    ) return undefined;
    visited.add(cursor);
    try {
      const descriptor = Object.getOwnPropertyDescriptor(cursor, "cause");
      cursor = descriptor && "value" in descriptor ? descriptor.value : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function indeterminateCallbackFailure(
  error: unknown,
  stage: TerminalBundleFinalizationStage,
  subject: string,
): never {
  if (error instanceof ProgressSignal) throw error;
  throw new ProgressSignal(
    "indeterminate",
    stage,
    error instanceof Error ? `${subject} failed: ${error.message}` : `${subject} failed`,
  );
}

class DurableTerminalBundleCoordinator {
  readonly #input: CapturedTerminalInput;
  readonly #provider: DurableTerminalBundleProvider;
  readonly #durability: TerminalBundleFinalizationDurability;
  #lease?: SessionLeaseToken;

  constructor(
    input: CapturedTerminalInput,
    provider: DurableTerminalBundleProvider,
    durability: TerminalBundleFinalizationDurability,
  ) {
    this.#input = input;
    this.#provider = provider;
    this.#durability = durability;
  }

  #jobId(): string {
    return this.#input.plan.authority.jobId;
  }

  #role(): BundlePartyRole {
    return this.#input.local.role;
  }

  #phase(stage: TerminalBundleStoreStage): string {
    return terminalBundleStorePhase(this.#role() as TerminalBundleStoreRole, stage);
  }

  #key(name: string): string {
    return terminalBundleFinalizationCheckpointKey(this.#role(), name);
  }

  #identity(): Readonly<TerminalBundleTransportIdentity> {
    return Object.freeze({
      jobId: this.#jobId(),
      authorityHash: this.#input.plan.authorityHash,
      planHash: this.#input.plan.planHash,
    });
  }

  #now(): number {
    const now = this.#durability.leaseNowMs?.() ?? Date.now();
    if (!Number.isFinite(now)) throw new SubstrateError("terminal durability clock is invalid");
    return now;
  }

  async #load(): Promise<SessionRecord> {
    const loaded = await this.#durability.store.load(this.#jobId());
    if (loaded.status === "missing") {
      throw new SubstrateError(`terminal session ${this.#jobId()} is missing`);
    }
    if (loaded.status === "corrupt") {
      throw new DacsError(`terminal session is corrupt: ${loaded.reason}`);
    }
    if (loaded.status === "unsupported") {
      throw new DacsError(`terminal session store version ${loaded.version} is unsupported`);
    }
    if (loaded.record.jobId !== this.#jobId()) {
      throw new DacsError("terminal session load substituted its job id");
    }
    const violation = sessionRecordShapeViolation(loaded.record);
    if (violation) {
      throw new DacsError(`terminal session is corrupt: ${violation}`);
    }
    return loaded.record;
  }

  async #renew(): Promise<void> {
    if (!this.#lease) throw new SubstrateError("terminal bundle lease is unavailable");
    const renewed = await this.#durability.store.renewLease({
      jobId: this.#jobId(),
      leaseToken: this.#lease,
      ttlMs: this.#durability.leaseTtlMs,
      now: this.#now(),
    });
    if (!renewed.ok) {
      throw new SubstrateError(`terminal bundle lease is stale: ${renewed.reason}`);
    }
  }

  #fence(idempotencyKey: string): Readonly<TerminalBundleEffectFence> {
    if (!this.#lease) throw new SubstrateError("terminal bundle lease is unavailable");
    return Object.freeze({ ...this.#lease, idempotencyKey });
  }

  async #effect<T>(
    idempotencyKey: string,
    operation: (fence: Readonly<TerminalBundleEffectFence>) => Promise<T> | T,
  ): Promise<T> {
    await this.#renew();
    const fence = this.#fence(idempotencyKey);
    let heartbeat = Promise.resolve();
    let heartbeatError: unknown;
    const interval = Math.max(
      1,
      Math.min(30_000, Math.floor(this.#durability.leaseTtlMs / 3)),
    );
    const timer = setInterval(() => {
      heartbeat = heartbeat
        .then(() => this.#renew())
        .catch((error: unknown) => {
          heartbeatError ??= error;
        });
    }, interval);
    timer.unref();
    try {
      const result = await operation(fence);
      clearInterval(timer);
      await heartbeat;
      if (heartbeatError) throw heartbeatError;
      await this.#renew();
      return result;
    } finally {
      clearInterval(timer);
    }
  }

  #phaseFor(record: SessionRecord, requestedStage: TerminalBundleStoreStage): string | undefined {
    const prefix = `terminal:${this.#role()}:`;
    if (!record.phase.startsWith(prefix)) return this.#phase(requestedStage);
    const currentStage = record.phase.slice(prefix.length) as TerminalBundleStoreStage;
    const current = TERMINAL_PHASE_RANK.get(currentStage);
    const wanted = TERMINAL_PHASE_RANK.get(requestedStage);
    if (current === undefined || wanted === undefined) {
      throw new DacsError("terminal session carries an unrecognized role-local phase");
    }
    return current > wanted ? undefined : this.#phase(requestedStage);
  }

  async #claim(
    key: string,
    data: Record<string, CheckpointValue>,
    stage: TerminalBundleStoreStage,
  ): Promise<{
    state: "fresh" | "intent" | "outcome";
    data: Record<string, CheckpointValue>;
    record: SessionRecord;
  }> {
    if (!this.#lease) throw new SubstrateError("terminal bundle lease is unavailable");
    await this.#renew();
    const record = await this.#load();
    const phase = this.#phaseFor(record, stage);
    const claimed = await this.#durability.store.claimCheckpoint({
      jobId: this.#jobId(),
      key,
      data: clone(data),
      ...(phase ? { phase } : {}),
      leaseToken: this.#lease,
      now: this.#now(),
    });
    if (claimed.ok) {
      return { state: "fresh", data: clone(data), record: claimed.record };
    }
    if ((claimed.reason !== "held" && claimed.reason !== "completed") || !claimed.record) {
      throw new SubstrateError(`terminal checkpoint ${key} claim failed: ${claimed.reason}`);
    }
    const checkpoint = latestCheckpoint(claimed.record.checkpoints, key);
    if (!checkpoint?.data) throw new DacsError(`terminal checkpoint ${key} lacks data`);
    if (claimed.reason === "held" && !dataMatches(checkpoint.data, data)) {
      throw new DacsError(`terminal checkpoint ${key} binds different content`);
    }
    return {
      state: claimed.reason === "completed" ? "outcome" : "intent",
      data: clone(checkpoint.data),
      record: claimed.record,
    };
  }

  async #appendOutcome(
    key: string,
    intent: Record<string, CheckpointValue>,
    outcome: Record<string, CheckpointValue>,
    requestedStage?: TerminalBundleStoreStage,
  ): Promise<void> {
    if (!this.#lease) throw new SubstrateError("terminal bundle lease is unavailable");
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      await this.#renew();
      const record = await this.#load();
      const prior = latestCheckpoint(record.checkpoints, key);
      if (prior?.stage === "outcome") {
        if (!dataMatches(prior.data, outcome)) {
          throw new DacsError(`terminal checkpoint ${key} outcome is rebound`);
        }
        return;
      }
      if (prior?.stage !== "intent" || !dataMatches(prior.data, intent)) {
        throw new DacsError(`terminal checkpoint ${key} intent disappeared or changed`);
      }
      const phase = requestedStage ? this.#phaseFor(record, requestedStage) : undefined;
      const transitioned = await this.#durability.store.transition({
        jobId: this.#jobId(),
        expectedRevision: record.revision,
        leaseToken: this.#lease,
        ...(phase ? { phase } : {}),
        checkpoint: { key, stage: "outcome", data: clone(outcome) },
        now: this.#now(),
      });
      if (transitioned.ok) return;
      if (transitioned.reason !== "revision-mismatch") {
        throw new SubstrateError(
          `terminal checkpoint ${key} outcome failed: ${transitioned.reason}`,
        );
      }
    }
    throw new SubstrateError(`terminal checkpoint ${key} exceeded CAS retry limit`);
  }

  async #ensureOutcome(
    key: string,
    data: Record<string, CheckpointValue>,
    stage: TerminalBundleStoreStage,
  ): Promise<void> {
    const claimed = await this.#claim(key, data, stage);
    if (claimed.state === "outcome") {
      if (!dataMatches(claimed.data, data)) {
        throw new DacsError(`terminal checkpoint ${key} outcome is rebound`);
      }
      return;
    }
    await this.#appendOutcome(key, data, data, stage);
  }

  async #acquire(): Promise<void> {
    const acquired = await this.#durability.store.acquireLease({
      jobId: this.#jobId(),
      owner: this.#durability.workerId,
      ttlMs: this.#durability.leaseTtlMs,
      now: this.#now(),
    });
    if (!acquired.ok) {
      throw new ProgressSignal(
        "indeterminate",
        "lease",
        `terminal bundle lease unavailable: ${acquired.reason}`,
      );
    }
    this.#lease = {
      owner: acquired.lease.owner,
      generation: acquired.lease.generation,
    };
  }

  async #release(): Promise<void> {
    const lease = this.#lease;
    if (!lease) return;
    try {
      for (let attempt = 0; attempt < MAX_RELEASE_ATTEMPTS; attempt += 1) {
        const record = await this.#load();
        if (
          record.phase === this.#phase("finalised") ||
          record.lease?.owner !== lease.owner ||
          record.lease.generation !== lease.generation
        ) return;
        const released = await this.#durability.store.transition({
          jobId: this.#jobId(),
          expectedRevision: record.revision,
          leaseToken: lease,
          lease: null,
          now: this.#now(),
        });
        if (released.ok) {
          this.#lease = undefined;
          return;
        }
        if (released.reason !== "revision-mismatch") return;
      }
    } catch {
      // The exact generation remains fenced and expires naturally.
    }
  }

  #idempotencyKey(kind: string, effect: Record<string, unknown>): string {
    return `terminal:${kind}:${sha256Hex(canonicalize({
      ...this.#identity(),
      role: this.#role(),
      ...effect,
    }))}`;
  }

  #sharedIdempotencyKey(kind: string, effect: Record<string, unknown>): string {
    return `terminal:${kind}:${sha256Hex(canonicalize({
      ...this.#identity(),
      ...effect,
    }))}`;
  }

  #authorityData(): Record<string, CheckpointValue> {
    const encoded = encodeCanonical(this.#input.plan, "terminal bundle plan");
    return {
      authorityHash: this.#input.plan.authorityHash,
      planHash: this.#input.plan.planHash,
      plan: encoded.encoded,
      planEncodingHash: encoded.hash,
      signerKeysHash: this.#input.signerKeysHash,
      localRole: this.#role(),
      localClaim: this.#input.local.primaryClaim,
    };
  }

  async #persistAuthority(): Promise<void> {
    await this.#ensureOutcome(
      this.#key(terminalBundleFinalizationCheckpointName.authority),
      this.#authorityData(),
      "authority",
    );
  }

  #proposalIntent(): Record<string, CheckpointValue> {
    const idempotencyKey = this.#sharedIdempotencyKey("proposal", {
      planHash: this.#input.plan.planHash,
    });
    return {
      authorityHash: this.#input.plan.authorityHash,
      planHash: this.#input.plan.planHash,
      idempotencyKey,
    };
  }

  #signalResolution(
    resolution: Exclude<TerminalBundleResolution<unknown>, { disposition: "present" }>,
    stage: TerminalBundleFinalizationStage,
    absentDisposition: "waiting" | "indeterminate" = "waiting",
  ): never {
    if (resolution.disposition === "rejected") {
      throw new ProgressSignal("rejected", stage, resolution.reason);
    }
    if (resolution.disposition === "indeterminate") {
      throw new ProgressSignal("indeterminate", stage, resolution.reason);
    }
    throw new ProgressSignal(absentDisposition, stage, resolution.reason);
  }

  async #resolveProposal(): Promise<TerminalBundleResolution<unknown>> {
    try {
      return captureResolution(
        await this.#durability.transport.resolveProposal(immutable(this.#identity())),
        "terminal proposal resolution",
      );
    } catch (error) {
      indeterminateCallbackFailure(error, "proposal-publication", "terminal proposal resolution");
    }
  }

  #assertProposal(value: unknown): void {
    if (!exact(value, this.#input.plan)) {
      throw new DacsError("terminal transport proposal substitutes the exact retained plan");
    }
  }

  async #publishProposal(): Promise<void> {
    const intent = this.#proposalIntent();
    const key = this.#key(terminalBundleFinalizationCheckpointName.proposalPublication);
    const claimed = await this.#claim(key, intent, "proposal-publication-pending");
    if (claimed.state === "outcome") {
      if (!dataMatches(claimed.data, { ...intent, published: true })) {
        throw new DacsError("terminal proposal publication outcome is rebound");
      }
      const replay = await this.#resolveProposal();
      if (replay.disposition !== "present") {
        this.#signalResolution(replay, "proposal-publication", "indeterminate");
      }
      this.#assertProposal(replay.value);
      return;
    }

    let resolution = await this.#resolveProposal();
    if (resolution.disposition === "present") {
      this.#assertProposal(resolution.value);
    } else if (resolution.disposition === "authoritatively-absent") {
      try {
        await this.#effect(String(intent.idempotencyKey), (fence) =>
          this.#durability.transport.publishProposal(
            {
              identity: immutable(this.#identity()),
              plan: immutable(this.#input.plan),
            },
            fence,
          ),
        );
      } catch (error) {
        resolution = await this.#resolveProposal();
        if (resolution.disposition !== "present") {
          throw new ProgressSignal(
            "indeterminate",
            "proposal-publication",
            error instanceof Error
              ? `proposal publication outcome is ambiguous: ${error.message}`
              : "proposal publication outcome is ambiguous",
          );
        }
        this.#assertProposal(resolution.value);
      }
      if (resolution.disposition !== "present") {
        resolution = await this.#resolveProposal();
        if (resolution.disposition !== "present") {
          this.#signalResolution(resolution, "proposal-publication");
        }
        this.#assertProposal(resolution.value);
      }
    } else {
      this.#signalResolution(resolution, "proposal-publication");
    }
    await this.#appendOutcome(
      key,
      intent,
      { ...intent, published: true },
      "contribution-signing",
    );
  }

  #localKey(): Readonly<TerminalBundleSignerPublicKey> {
    const key = this.#input.signerKeys.find((candidate) => candidate.role === this.#role());
    if (!key || key.primaryClaim !== this.#input.local.primaryClaim) {
      throw new DacsError("terminal local signer key is missing or rebound");
    }
    return key;
  }

  #verifyLocalSignature(bytes: Uint8Array, value: string, subject: string): void {
    const signature = Uint8Array.from(Buffer.from(value, "base64url"));
    if (
      !ed25519Verify(bytes, signature, publicKeyFromRaw(this.#localKey().publicKey))
    ) {
      throw new DacsError(`${subject} does not verify under the authenticated local key`);
    }
  }

  #signatureIntent(
    purpose: TerminalBundleSignaturePurpose,
    copyRole: BundlePartyRole,
    bytes: Uint8Array,
  ): Record<string, CheckpointValue> {
    const messageHash = sha256Hex(bytes);
    const idempotencyKey = this.#idempotencyKey("signature", {
      purpose,
      copyRole,
      signer: this.#input.local.primaryClaim,
      messageHash,
    });
    return {
      authorityHash: this.#input.plan.authorityHash,
      planHash: this.#input.plan.planHash,
      purpose,
      copyRole,
      signer: this.#input.local.primaryClaim,
      messageHash,
      idempotencyKey,
    };
  }

  async #resolveSignature(
    purpose: TerminalBundleSignaturePurpose,
    copyRole: BundlePartyRole,
    bytes: Uint8Array,
    fence: Readonly<TerminalBundleEffectFence>,
  ): Promise<TerminalBundleResolution<Uint8Array | string>> {
    const stage = purpose === "bundle-copy" ? "contribution-signing" : "bundle-binding";
    try {
      return captureResolution(
        await this.#durability.reconcileSignature(
          {
            purpose,
            role: this.#role(),
            copyRole,
            signer: this.#input.local.primaryClaim,
            messageHash: sha256Hex(bytes),
            signedBytes: Uint8Array.from(bytes),
          },
          fence,
        ),
        "terminal signature reconciliation",
      );
    } catch (error) {
      indeterminateCallbackFailure(error, stage, "terminal signature reconciliation");
    }
  }

  async #sign(
    key: string,
    purpose: TerminalBundleSignaturePurpose,
    copyRole: BundlePartyRole,
    bytes: Uint8Array,
    stage: TerminalBundleStoreStage,
  ): Promise<string> {
    const intent = this.#signatureIntent(purpose, copyRole, bytes);
    const claimed = await this.#claim(key, intent, stage);
    if (claimed.state === "outcome") {
      const { signatureValue, ...retainedIntent } = claimed.data;
      if (!dataMatches(retainedIntent, intent) || typeof signatureValue !== "string") {
        throw new DacsError(`terminal signature checkpoint ${key} is rebound`);
      }
      const normalized = normalizeSignature(signatureValue, "retained terminal signature");
      this.#verifyLocalSignature(bytes, normalized, "retained terminal signature");
      return normalized;
    }

    const fence = this.#fence(String(intent.idempotencyKey));
    let reconciliation = await this.#resolveSignature(purpose, copyRole, bytes, fence);
    let signatureValue: string;
    if (reconciliation.disposition === "present") {
      signatureValue = normalizeSignature(
        reconciliation.value,
        "reconciled terminal signature",
      );
    } else if (reconciliation.disposition === "authoritatively-absent") {
      try {
        const produced = await this.#effect(String(intent.idempotencyKey), (effectFence) =>
          this.#input.local.signer(Uint8Array.from(bytes), effectFence),
        );
        signatureValue = normalizeSignature(produced, "durable terminal signer output");
      } catch (error) {
        reconciliation = await this.#resolveSignature(
          purpose,
          copyRole,
          bytes,
          this.#fence(String(intent.idempotencyKey)),
        );
        if (reconciliation.disposition !== "present") {
          throw new ProgressSignal(
            "indeterminate",
            purpose === "bundle-copy" ? "contribution-signing" : "bundle-binding",
            error instanceof Error
              ? `terminal signer outcome is ambiguous: ${error.message}`
              : "terminal signer outcome is ambiguous",
          );
        }
        signatureValue = normalizeSignature(
          reconciliation.value,
          "reconciled terminal signature",
        );
      }
    } else {
      this.#signalResolution(
        reconciliation,
        purpose === "bundle-copy" ? "contribution-signing" : "bundle-binding",
      );
    }
    this.#verifyLocalSignature(bytes, signatureValue, "terminal signature");
    await this.#appendOutcome(key, intent, { ...intent, signatureValue }, stage);
    return signatureValue;
  }

  #contributionData(
    contribution: Readonly<TerminalBundleSignatureContribution>,
  ): Record<string, CheckpointValue> {
    const encoded = encodeCanonical(contribution, "terminal signature contribution");
    return {
      authorityHash: this.#input.plan.authorityHash,
      planHash: this.#input.plan.planHash,
      signerRole: contribution.signerRole,
      contributionHash: contribution.contributionHash,
      contribution: encoded.encoded,
      contributionEncodingHash: encoded.hash,
    };
  }

  #decodeContribution(
    data: Record<string, CheckpointValue> | undefined,
    signerRole: BundlePartyRole,
  ): Readonly<TerminalBundleSignatureContribution> {
    if (
      !data ||
      data.authorityHash !== this.#input.plan.authorityHash ||
      data.planHash !== this.#input.plan.planHash ||
      data.signerRole !== signerRole ||
      !isHash(data.contributionHash)
    ) {
      throw new DacsError(`terminal ${signerRole} contribution checkpoint is rebound`);
    }
    const contribution = decodeCanonical(
      data.contribution,
      data.contributionEncodingHash,
      `terminal ${signerRole} contribution`,
    );
    if (
      !isRecord(contribution) ||
      contribution.signerRole !== signerRole ||
      contribution.contributionHash !== data.contributionHash
    ) {
      throw new DacsError(`terminal ${signerRole} contribution is malformed or rebound`);
    }
    return immutable(contribution as unknown as TerminalBundleSignatureContribution);
  }

  async #createLocalContribution(): Promise<Readonly<TerminalBundleSignatureContribution>> {
    const values = [];
    for (const copy of this.#input.plan.copies) {
      const value = await this.#sign(
        this.#key(`signature:${copy.role}`),
        "bundle-copy",
        copy.role,
        terminalBundleSignedBytes(copy),
        "contribution-signing",
      );
      values.push({ copyRole: copy.role, value });
    }
    const contribution = createTerminalBundleSignatureContribution(
      this.#input.plan,
      this.#role(),
      values,
    );
    await this.#ensureOutcome(
      this.#key(`contribution:${this.#role()}`),
      this.#contributionData(contribution),
      "contribution-signing",
    );
    return contribution;
  }

  async #resolveContribution(
    signerRole: BundlePartyRole,
  ): Promise<TerminalBundleResolution<unknown>> {
    const subject = `terminal ${signerRole} contribution resolution`;
    try {
      return captureResolution(
        await this.#durability.transport.resolveContribution({
          identity: immutable(this.#identity()),
          signerRole,
        }),
        subject,
      );
    } catch (error) {
      indeterminateCallbackFailure(error, "contribution-publication", subject);
    }
  }

  async #publishLocalContribution(
    contribution: Readonly<TerminalBundleSignatureContribution>,
  ): Promise<void> {
    const intent = this.#contributionPublicationIntent(contribution);
    const key = this.#key(terminalBundleFinalizationCheckpointName.contributionPublication);
    const claimed = await this.#claim(key, intent, "contribution-publication-pending");
    if (claimed.state === "outcome") {
      if (!dataMatches(claimed.data, { ...intent, published: true })) {
        throw new DacsError("terminal contribution publication outcome is rebound");
      }
      const replay = await this.#resolveContribution(this.#role());
      if (replay.disposition !== "present") {
        this.#signalResolution(replay, "contribution-publication", "indeterminate");
      }
      if (!exact(replay.value, contribution)) {
        throw new DacsError("published terminal contribution substitutes the local row");
      }
      return;
    }

    let resolution = await this.#resolveContribution(this.#role());
    if (resolution.disposition === "present") {
      if (!exact(resolution.value, contribution)) {
        throw new DacsError("published terminal contribution substitutes the local row");
      }
    } else if (resolution.disposition === "authoritatively-absent") {
      try {
        await this.#effect(String(intent.idempotencyKey), (fence) =>
          this.#durability.transport.publishContribution(
            {
              identity: immutable(this.#identity()),
              contribution: immutable(contribution),
            },
            fence,
          ),
        );
      } catch (error) {
        resolution = await this.#resolveContribution(this.#role());
        if (resolution.disposition !== "present") {
          throw new ProgressSignal(
            "indeterminate",
            "contribution-publication",
            error instanceof Error
              ? `contribution publication outcome is ambiguous: ${error.message}`
              : "contribution publication outcome is ambiguous",
          );
        }
      }
      if (resolution.disposition !== "present") {
        resolution = await this.#resolveContribution(this.#role());
        if (resolution.disposition !== "present") {
          this.#signalResolution(resolution, "contribution-publication");
        }
      }
      if (!exact(resolution.value, contribution)) {
        throw new DacsError("published terminal contribution substitutes the local row");
      }
    } else {
      this.#signalResolution(resolution, "contribution-publication");
    }
    await this.#appendOutcome(
      key,
      intent,
      { ...intent, published: true },
      "matrix-review",
    );
  }

  #contributionPublicationIntent(
    contribution: Readonly<TerminalBundleSignatureContribution>,
  ): Record<string, CheckpointValue> {
    return {
      authorityHash: this.#input.plan.authorityHash,
      planHash: this.#input.plan.planHash,
      signerRole: this.#role(),
      contributionHash: contribution.contributionHash,
      idempotencyKey: this.#idempotencyKey("contribution", {
        signerRole: this.#role(),
        contributionHash: contribution.contributionHash,
      }),
    };
  }

  async #collectContributions(
    local: Readonly<TerminalBundleSignatureContribution>,
  ): Promise<Readonly<TerminalBundleSignatureContribution>[]> {
    const contributions: Readonly<TerminalBundleSignatureContribution>[] = [];
    for (const required of this.#input.plan.requiredSigners) {
      const key = this.#key(`contribution:${required.role}`);
      if (required.role === this.#role()) {
        const retained = latestCheckpoint((await this.#load()).checkpoints, key);
        const decoded = this.#decodeContribution(retained?.data, required.role);
        if (!exact(decoded, local)) {
          throw new DacsError("retained local contribution differs from local signature outcomes");
        }
        contributions.push(decoded);
        continue;
      }
      const record = await this.#load();
      const retained = latestCheckpoint(record.checkpoints, key);
      if (retained?.stage === "outcome") {
        contributions.push(this.#decodeContribution(retained.data, required.role));
        continue;
      }
      if (retained) {
        throw new DacsError(`terminal ${required.role} contribution has an incomplete checkpoint`);
      }
      const resolution = await this.#resolveContribution(required.role);
      if (resolution.disposition !== "present") {
        this.#signalResolution(resolution, "contribution-publication");
      }
      const captured = snapshotData(
        resolution.value,
        `terminal ${required.role} contribution`,
      ) as TerminalBundleSignatureContribution;
      const data = this.#contributionData(captured);
      await this.#ensureOutcome(key, data, "matrix-review");
      contributions.push(this.#decodeContribution(data, required.role));
    }
    return contributions;
  }

  #matrixData(
    matrix: Readonly<TerminalBundleSignatureMatrix>,
  ): Record<string, CheckpointValue> {
    const encoded = encodeCanonical(matrix, "terminal signature matrix");
    return {
      authorityHash: this.#input.plan.authorityHash,
      planHash: this.#input.plan.planHash,
      matrixHash: matrix.matrixHash,
      matrix: encoded.encoded,
      matrixEncodingHash: encoded.hash,
    };
  }

  #decodeMatrix(
    data: Record<string, CheckpointValue> | undefined,
  ): Readonly<TerminalBundleSignatureMatrix> {
    if (
      !data ||
      data.authorityHash !== this.#input.plan.authorityHash ||
      data.planHash !== this.#input.plan.planHash ||
      !isHash(data.matrixHash)
    ) {
      throw new DacsError("terminal signature matrix checkpoint is rebound");
    }
    const matrix = decodeCanonical(
      data.matrix,
      data.matrixEncodingHash,
      "terminal signature matrix",
    );
    if (!isRecord(matrix) || matrix.matrixHash !== data.matrixHash) {
      throw new DacsError("terminal signature matrix is malformed or rebound");
    }
    return immutable(matrix as unknown as TerminalBundleSignatureMatrix);
  }

  async #createMatrix(
    local: Readonly<TerminalBundleSignatureContribution>,
  ): Promise<Readonly<TerminalBundleSignatureMatrix>> {
    const contributions = await this.#collectContributions(local);
    const derived = createTerminalBundleSignatureMatrix(
      this.#input.plan,
      contributions,
      this.#input.signerKeys,
    );
    const data = this.#matrixData(derived);
    await this.#ensureOutcome(
      this.#key(terminalBundleFinalizationCheckpointName.matrix),
      data,
      "matrix-review",
    );
    const retained = latestCheckpoint(
      (await this.#load()).checkpoints,
      this.#key(terminalBundleFinalizationCheckpointName.matrix),
    );
    const decoded = this.#decodeMatrix(retained?.data);
    if (!exact(decoded, derived)) {
      throw new DacsError("retained terminal signature matrix differs from verified rows");
    }
    // Re-run the pure verifier over the retained cells before any publication.
    const reverified = createTerminalBundleSignatureMatrix(
      this.#input.plan,
      contributions,
      this.#input.signerKeys,
    );
    if (!exact(reverified, decoded)) {
      throw new DacsError("terminal signature matrix failed deterministic replay");
    }
    return decoded;
  }

  #anchorIntent(
    bundle: Readonly<FaultAttestationBundle>,
    logicalAddress: string,
  ): Record<string, CheckpointValue> {
    const bundleContentHash = attestationBundleHash(bundle);
    const encoded = encodeCanonical(bundle, "own terminal bundle");
    return {
      authorityHash: this.#input.plan.authorityHash,
      planHash: this.#input.plan.planHash,
      role: this.#role(),
      logicalAddress,
      bundleContentHash,
      bundleEncodingHash: encoded.hash,
      idempotencyKey: this.#idempotencyKey("bundle-anchor", {
        logicalAddress,
        bundleContentHash,
      }),
    };
  }

  async #authenticateAnchor(
    value: unknown,
    expectedBundle: Readonly<FaultAttestationBundle>,
    logicalAddress: string,
    stage: "bundle-anchor" | "terminal-recovery" = "bundle-anchor",
  ): Promise<Readonly<TerminalBundleAnchorPublication>> {
    const publication = snapshotData(value, "own terminal bundle publication") as unknown;
    if (
      !isRecord(publication) ||
      !exactOwnKeys(
        publication,
        [
          "role",
          "logicalAddress",
          "nativeAddress",
          "bundleContentHash",
          "bundle",
          "anchorReceipt",
        ],
        ["anchorTx"],
      ) ||
      publication.role !== this.#role() ||
      publication.logicalAddress !== logicalAddress ||
      !isNonEmpty(publication.nativeAddress) ||
      publication.bundleContentHash !== attestationBundleHash(expectedBundle) ||
      !isFaultAttestationBundle(publication.bundle) ||
      !exact(publication.bundle, expectedBundle) ||
      !isAnchorReceipt(publication.anchorReceipt) ||
      publication.anchorReceipt.state !== "finalized" ||
      publication.anchorReceipt.observationDisposition !== "established" ||
      publication.anchorReceipt.logicalAddress !== logicalAddress ||
      publication.anchorReceipt.nativeAddress !== publication.nativeAddress ||
      publication.anchorReceipt.contentHash !== publication.bundleContentHash ||
      (publication.anchorTx !== undefined &&
        (!isNonEmpty(publication.anchorTx) ||
          publication.anchorTx !== publication.anchorReceipt.transactionRef.value))
    ) {
      throw new DacsError("own terminal bundle publication is malformed or rebound");
    }
    const retained = immutable(
      publication as unknown as TerminalBundleAnchorPublication,
    );
    let verification: TerminalBundleVerification;
    try {
      verification = captureVerification(
        await this.#provider.verifyOwnBundlePublication(retained),
        "own terminal bundle publication verification",
      );
    } catch (error) {
      indeterminateCallbackFailure(
        error,
        stage,
        "own terminal bundle publication verification",
      );
    }
    if (verification.disposition === "invalid") {
      throw new DacsError(
        `own terminal bundle publication is unauthenticated: ${verification.reason}`,
      );
    }
    if (verification.disposition === "indeterminate") {
      throw new ProgressSignal("indeterminate", stage, verification.reason);
    }
    return retained;
  }

  async #resolveAnchor(
    bundle: Readonly<FaultAttestationBundle>,
    logicalAddress: string,
    stage: "bundle-anchor" | "terminal-recovery" = "bundle-anchor",
  ): Promise<
    | { disposition: "present"; value: Readonly<TerminalBundleAnchorPublication> }
    | Exclude<TerminalBundleResolution<unknown>, { disposition: "present" }>
  > {
    let resolution: TerminalBundleResolution<unknown>;
    try {
      resolution = captureResolution(
        await this.#provider.resolveOwnBundle({
          role: this.#role(),
          logicalAddress,
          bundleContentHash: attestationBundleHash(bundle),
        }),
        "own terminal bundle resolution",
      );
    } catch (error) {
      indeterminateCallbackFailure(error, stage, "own terminal bundle resolution");
    }
    return resolution.disposition === "present"
      ? {
          disposition: "present",
          value: await this.#authenticateAnchor(
            resolution.value,
            bundle,
            logicalAddress,
            stage,
          ),
        }
      : resolution;
  }

  #anchorData(
    intent: Record<string, CheckpointValue>,
    publication: Readonly<TerminalBundleAnchorPublication>,
  ): Record<string, CheckpointValue> {
    const encoded = encodeCanonical(publication, "own terminal bundle publication");
    return {
      ...intent,
      nativeAddress: publication.nativeAddress,
      publication: encoded.encoded,
      publicationEncodingHash: encoded.hash,
    };
  }

  #decodeAnchor(
    data: Record<string, CheckpointValue> | undefined,
  ): TerminalBundleAnchorPublication {
    if (
      !data ||
      data.authorityHash !== this.#input.plan.authorityHash ||
      data.planHash !== this.#input.plan.planHash ||
      data.role !== this.#role() ||
      !isNonEmpty(data.logicalAddress) ||
      !isHash(data.bundleContentHash) ||
      !isNonEmpty(data.nativeAddress)
    ) {
      throw new DacsError("own terminal bundle anchor checkpoint is rebound");
    }
    const publication = decodeCanonical(
      data.publication,
      data.publicationEncodingHash,
      "own terminal bundle publication",
    );
    if (
      !isRecord(publication) ||
      publication.nativeAddress !== data.nativeAddress ||
      publication.logicalAddress !== data.logicalAddress ||
      publication.bundleContentHash !== data.bundleContentHash
    ) {
      throw new DacsError("own terminal bundle anchor outcome is malformed or rebound");
    }
    return publication as unknown as TerminalBundleAnchorPublication;
  }

  async #anchorBundle(
    bundle: Readonly<FaultAttestationBundle>,
  ): Promise<Readonly<TerminalBundleAnchorPublication>> {
    const logicalAddress = bundleAddress(this.#jobId(), this.#role());
    const intent = this.#anchorIntent(bundle, logicalAddress);
    const key = this.#key(terminalBundleFinalizationCheckpointName.anchor);
    const claimed = await this.#claim(key, intent, "bundle-anchor-pending");
    if (claimed.state === "outcome") {
      const persisted = await this.#authenticateAnchor(
        this.#decodeAnchor(claimed.data),
        bundle,
        logicalAddress,
        "terminal-recovery",
      );
      const replay = await this.#resolveAnchor(bundle, logicalAddress, "terminal-recovery");
      if (replay.disposition !== "present") {
        this.#signalResolution(replay, "terminal-recovery", "indeterminate");
      }
      if (!exact(replay.value, persisted)) {
        throw new DacsError("own terminal bundle publication changed after checkpointing");
      }
      return persisted;
    }

    let resolution = await this.#resolveAnchor(bundle, logicalAddress);
    if (resolution.disposition === "authoritatively-absent") {
      try {
        await this.#effect(String(intent.idempotencyKey), (fence) =>
          this.#provider.submitOwnBundle(
            {
              role: this.#role(),
              logicalAddress,
              bundle: immutable(bundle),
            },
            fence,
          ),
        );
      } catch (error) {
        resolution = await this.#resolveAnchor(bundle, logicalAddress);
        if (resolution.disposition !== "present") {
          throw new ProgressSignal(
            "indeterminate",
            "bundle-anchor",
            error instanceof Error
              ? `own bundle anchor outcome is ambiguous: ${error.message}`
              : "own bundle anchor outcome is ambiguous",
          );
        }
      }
      if (resolution.disposition !== "present") {
        resolution = await this.#resolveAnchor(bundle, logicalAddress);
      }
    }
    if (resolution.disposition !== "present") {
      this.#signalResolution(resolution, "bundle-anchor");
    }
    const outcome = this.#anchorData(intent, resolution.value);
    await this.#appendOutcome(key, intent, outcome, "bundle-binding-signing");
    return resolution.value;
  }

  #unsignedBinding(
    publication: Readonly<TerminalBundleAnchorPublication>,
  ): Omit<BundleBinding, "signature"> {
    return {
      bindingVersion: "1",
      jobId: this.#jobId(),
      role: this.#role(),
      logicalAddress: publication.logicalAddress,
      nativeAddress: publication.nativeAddress,
      bundleContentHash: publication.bundleContentHash,
      ...(publication.anchorTx ? { anchorTx: publication.anchorTx } : {}),
      signer: this.#input.local.primaryClaim,
    };
  }

  #bindingBytes(unsigned: Omit<BundleBinding, "signature">): Uint8Array {
    return signedBytes(
      BUNDLE_BINDING_SEPARATOR,
      contentHash(unsigned as unknown as Record<string, unknown>),
    );
  }

  async #createBinding(
    publication: Readonly<TerminalBundleAnchorPublication>,
  ): Promise<Readonly<BundleBinding>> {
    const unsigned = this.#unsignedBinding(publication);
    const bytes = this.#bindingBytes(unsigned);
    const value = await this.#sign(
      this.#key(terminalBundleFinalizationCheckpointName.bindingSignature),
      "bundle-binding",
      this.#role(),
      bytes,
      "bundle-binding-signing",
    );
    const signature: ComponentSignature = {
      signer: this.#input.local.primaryClaim,
      algorithm: "ed25519",
      value,
    };
    const binding: BundleBinding = { ...unsigned, signature };
    if (!isBundleBinding(binding)) {
      throw new DacsError("locally signed terminal BundleBinding is malformed");
    }
    this.#verifyLocalSignature(bytes, value, "terminal BundleBinding signature");
    return immutable(binding);
  }

  async #authenticateBinding(
    value: unknown,
    expected: Readonly<BundleBinding>,
    stage: "bundle-binding" | "terminal-recovery" = "bundle-binding",
  ): Promise<Readonly<BundleBinding>> {
    const binding = snapshotData(value, "own terminal BundleBinding") as unknown;
    if (!isBundleBinding(binding) || !exact(binding, expected)) {
      throw new DacsError("own terminal BundleBinding is malformed or rebound");
    }
    const signatureValue = normalizeSignature(
      binding.signature.value,
      "terminal BundleBinding signature",
    );
    const unsigned = { ...binding };
    delete (unsigned as Partial<BundleBinding>).signature;
    this.#verifyLocalSignature(
      this.#bindingBytes(unsigned as Omit<BundleBinding, "signature">),
      signatureValue,
      "terminal BundleBinding signature",
    );
    const retained = immutable(binding);
    let verification: TerminalBundleVerification;
    try {
      verification = captureVerification(
        await this.#provider.verifyOwnBundleBinding(retained),
        "own terminal BundleBinding verification",
      );
    } catch (error) {
      indeterminateCallbackFailure(
        error,
        stage,
        "own terminal BundleBinding verification",
      );
    }
    if (verification.disposition === "invalid") {
      throw new DacsError(`own terminal BundleBinding is unauthenticated: ${verification.reason}`);
    }
    if (verification.disposition === "indeterminate") {
      throw new ProgressSignal("indeterminate", stage, verification.reason);
    }
    return retained;
  }

  async #resolveBinding(
    expected: Readonly<BundleBinding>,
    stage: "bundle-binding" | "terminal-recovery" = "bundle-binding",
  ): Promise<
    | { disposition: "present"; value: Readonly<BundleBinding> }
    | Exclude<TerminalBundleResolution<unknown>, { disposition: "present" }>
  > {
    let resolution: TerminalBundleResolution<unknown>;
    try {
      resolution = captureResolution(
        await this.#provider.resolveOwnBundleBinding({
          role: this.#role(),
          logicalAddress: expected.logicalAddress,
          signer: this.#input.local.primaryClaim,
        }),
        "own terminal BundleBinding resolution",
      );
    } catch (error) {
      indeterminateCallbackFailure(error, stage, "own terminal BundleBinding resolution");
    }
    return resolution.disposition === "present"
      ? {
          disposition: "present",
          value: await this.#authenticateBinding(resolution.value, expected, stage),
        }
      : resolution;
  }

  #bindingPublicationIntent(binding: Readonly<BundleBinding>): Record<string, CheckpointValue> {
    const encoded = encodeCanonical(binding, "own terminal BundleBinding");
    return {
      authorityHash: this.#input.plan.authorityHash,
      planHash: this.#input.plan.planHash,
      role: this.#role(),
      logicalAddress: binding.logicalAddress,
      nativeAddress: binding.nativeAddress,
      bundleContentHash: binding.bundleContentHash,
      bindingHash: encoded.hash,
      binding: encoded.encoded,
      idempotencyKey: this.#idempotencyKey("bundle-binding", {
        logicalAddress: binding.logicalAddress,
        signer: binding.signer,
        bindingHash: encoded.hash,
      }),
    };
  }

  #decodeBinding(data: Record<string, CheckpointValue> | undefined): BundleBinding {
    if (
      !data ||
      data.authorityHash !== this.#input.plan.authorityHash ||
      data.planHash !== this.#input.plan.planHash ||
      data.role !== this.#role() ||
      !isHash(data.bindingHash)
    ) {
      throw new DacsError("own terminal BundleBinding checkpoint is rebound");
    }
    const binding = decodeCanonical(data.binding, data.bindingHash, "own terminal BundleBinding");
    if (!isBundleBinding(binding)) {
      throw new DacsError("own terminal BundleBinding checkpoint is malformed");
    }
    return binding;
  }

  async #publishBinding(
    binding: Readonly<BundleBinding>,
  ): Promise<Readonly<BundleBinding>> {
    const intent = this.#bindingPublicationIntent(binding);
    const outcome = { ...intent, published: true };
    const key = this.#key(terminalBundleFinalizationCheckpointName.bindingPublication);
    const claimed = await this.#claim(
      key,
      intent,
      "bundle-binding-publication-pending",
    );
    if (claimed.state === "outcome") {
      if (!dataMatches(claimed.data, outcome)) {
        throw new DacsError("own terminal BundleBinding publication outcome is rebound");
      }
      const persisted = await this.#authenticateBinding(
        this.#decodeBinding(claimed.data),
        binding,
        "terminal-recovery",
      );
      const replay = await this.#resolveBinding(binding, "terminal-recovery");
      if (replay.disposition !== "present") {
        this.#signalResolution(replay, "terminal-recovery", "indeterminate");
      }
      if (!exact(replay.value, persisted)) {
        throw new DacsError("own terminal BundleBinding changed after checkpointing");
      }
      return persisted;
    }

    let resolution = await this.#resolveBinding(binding);
    if (resolution.disposition === "authoritatively-absent") {
      try {
        await this.#effect(String(intent.idempotencyKey), (fence) =>
          this.#provider.publishOwnBundleBinding(immutable(binding), fence),
        );
      } catch (error) {
        resolution = await this.#resolveBinding(binding);
        if (resolution.disposition !== "present") {
          throw new ProgressSignal(
            "indeterminate",
            "bundle-binding",
            error instanceof Error
              ? `BundleBinding publication outcome is ambiguous: ${error.message}`
              : "BundleBinding publication outcome is ambiguous",
          );
        }
      }
      if (resolution.disposition !== "present") {
        resolution = await this.#resolveBinding(binding);
      }
    }
    if (resolution.disposition !== "present") {
      this.#signalResolution(resolution, "bundle-binding");
    }
    await this.#appendOutcome(
      key,
      intent,
      outcome,
      "bundle-binding-publication-pending",
    );
    return resolution.value;
  }

  #result(
    localContribution: Readonly<TerminalBundleSignatureContribution>,
    matrix: Readonly<TerminalBundleSignatureMatrix>,
    bundle: Readonly<FaultAttestationBundle>,
    publication: Readonly<TerminalBundleAnchorPublication>,
    binding: Readonly<BundleBinding>,
  ): Readonly<DurableFinalizedTerminalBundle> {
    return immutable({
      state: "finalised" as const,
      role: this.#role(),
      authorityHash: this.#input.plan.authorityHash,
      planHash: this.#input.plan.planHash,
      matrixHash: matrix.matrixHash,
      localContribution,
      signatureMatrix: matrix,
      bundle,
      publication,
      binding,
    });
  }

  #resultData(
    result: Readonly<DurableFinalizedTerminalBundle>,
  ): Record<string, CheckpointValue> {
    const encoded = encodeCanonical(result, "durable terminal bundle result");
    return {
      authorityHash: this.#input.plan.authorityHash,
      planHash: this.#input.plan.planHash,
      role: this.#role(),
      matrixHash: result.matrixHash,
      bundleContentHash: result.publication.bundleContentHash,
      nativeAddress: result.publication.nativeAddress,
      bindingHash: sha256Hex(canonicalize(result.binding)),
      result: encoded.encoded,
      resultEncodingHash: encoded.hash,
    };
  }

  #decodeResult(
    data: Record<string, CheckpointValue> | undefined,
  ): DurableFinalizedTerminalBundle {
    if (
      !data ||
      data.authorityHash !== this.#input.plan.authorityHash ||
      data.planHash !== this.#input.plan.planHash ||
      data.role !== this.#role() ||
      !isHash(data.matrixHash) ||
      !isHash(data.bundleContentHash) ||
      !isNonEmpty(data.nativeAddress) ||
      !isHash(data.bindingHash)
    ) {
      throw new DacsError("durable terminal result checkpoint is rebound");
    }
    const result = decodeCanonical(
      data.result,
      data.resultEncodingHash,
      "durable terminal bundle result",
    );
    if (
      !isRecord(result) ||
      result.state !== "finalised" ||
      result.role !== this.#role() ||
      result.authorityHash !== this.#input.plan.authorityHash ||
      result.planHash !== this.#input.plan.planHash ||
      result.matrixHash !== data.matrixHash ||
      !isRecord(result.publication) ||
      result.publication.bundleContentHash !== data.bundleContentHash ||
      result.publication.nativeAddress !== data.nativeAddress ||
      !isRecord(result.binding) ||
      sha256Hex(canonicalize(result.binding)) !== data.bindingHash
    ) {
      throw new DacsError("durable terminal result is malformed or rebound");
    }
    return result as unknown as DurableFinalizedTerminalBundle;
  }

  #assertExactResultSeal(
    record: SessionRecord,
    result: Readonly<DurableFinalizedTerminalBundle>,
  ): void {
    const violation = sessionRecordShapeViolation(record);
    if (violation) {
      throw new DacsError(`durable terminal result record is corrupt: ${violation}`);
    }
    const key = this.#key(terminalBundleFinalizationCheckpointName.result);
    const terminal = latestCheckpoint(record.checkpoints, key);
    const receipts = record.receipts.filter(
      (receipt) => sessionReceiptKey(receipt) === "bundle",
    );
    if (
      record.phase !== this.#phase("finalised") ||
      record.lease !== undefined ||
      terminal?.stage !== "outcome" ||
      !dataMatches(terminal.data, this.#resultData(result)) ||
      receipts.length !== 1 ||
      receipts[0]!.ref !== result.publication.nativeAddress
    ) {
      throw new DacsError(
        "durable terminal result is not in its exact sealed phase",
      );
    }
  }

  async #finish(result: Readonly<DurableFinalizedTerminalBundle>): Promise<void> {
    const data = this.#resultData(result);
    const key = this.#key(terminalBundleFinalizationCheckpointName.result);
    const claimed = await this.#claim(
      key,
      data,
      "bundle-binding-publication-pending",
    );
    if (claimed.state === "outcome") {
      this.#assertExactResultSeal(claimed.record, result);
      return;
    }
    if (!this.#lease) throw new SubstrateError("terminal bundle lease is unavailable");
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      await this.#renew();
      const record = await this.#load();
      if (record.phase === this.#phase("finalised")) {
        this.#assertExactResultSeal(record, result);
        return;
      }
      const prior = latestCheckpoint(record.checkpoints, key);
      if (prior?.stage !== "intent" || !dataMatches(prior.data, data)) {
        throw new DacsError("durable terminal result intent disappeared or changed");
      }
      const transitioned = await this.#durability.store.transition({
        jobId: this.#jobId(),
        expectedRevision: record.revision,
        leaseToken: this.#lease,
        phase: this.#phase("finalised"),
        checkpoint: { key, stage: "outcome", data: clone(data) },
        receipt: {
          kind: "bundle",
          ref: result.publication.nativeAddress,
        },
        lease: null,
        now: this.#now(),
      });
      if (transitioned.ok) {
        this.#assertExactResultSeal(transitioned.record, result);
        this.#lease = undefined;
        return;
      }
      if (transitioned.reason !== "revision-mismatch") {
        throw new SubstrateError(`terminal result commit failed: ${transitioned.reason}`);
      }
    }
    throw new SubstrateError("terminal result commit exceeded CAS retry limit");
  }

  #assertAuthorityCheckpoint(record: SessionRecord): void {
    const checkpoint = latestCheckpoint(
      record.checkpoints,
      this.#key(terminalBundleFinalizationCheckpointName.authority),
    );
    const expected = this.#authorityData();
    if (checkpoint?.stage !== "outcome" || !dataMatches(checkpoint.data, expected)) {
      throw new DacsError("terminal state lacks its exact authority and plan outcome");
    }
    const decoded = decodeCanonical(
      checkpoint.data?.plan,
      checkpoint.data?.planEncodingHash,
      "terminal retained plan",
    );
    if (!exact(decoded, this.#input.plan)) {
      throw new DacsError("terminal retained plan differs from current authenticated authority");
    }
  }

  #localContributionFromSignatureOutcomes(
    record: SessionRecord,
  ): Readonly<TerminalBundleSignatureContribution> {
    const values = this.#input.plan.copies.map((copy) => {
      const bytes = terminalBundleSignedBytes(copy);
      const key = this.#key(`signature:${copy.role}`);
      const checkpoint = latestCheckpoint(record.checkpoints, key);
      const intent = this.#signatureIntent("bundle-copy", copy.role, bytes);
      if (checkpoint?.stage !== "outcome" || !checkpoint.data) {
        throw new DacsError(`terminal state lacks local ${copy.role} signature outcome`);
      }
      const { signatureValue, ...retainedIntent } = checkpoint.data;
      if (!dataMatches(retainedIntent, intent) || typeof signatureValue !== "string") {
        throw new DacsError(`terminal local ${copy.role} signature outcome is rebound`);
      }
      const value = normalizeSignature(signatureValue, "terminal retained bundle signature");
      this.#verifyLocalSignature(bytes, value, "terminal retained bundle signature");
      return { copyRole: copy.role, value };
    });
    return createTerminalBundleSignatureContribution(
      this.#input.plan,
      this.#role(),
      values,
    );
  }

  #recoverContributions(
    record: SessionRecord,
    local: Readonly<TerminalBundleSignatureContribution>,
  ): Readonly<TerminalBundleSignatureContribution>[] {
    return this.#input.plan.requiredSigners.map((required) => {
      const checkpoint = latestCheckpoint(
        record.checkpoints,
        this.#key(`contribution:${required.role}`),
      );
      if (checkpoint?.stage !== "outcome") {
        throw new DacsError(`terminal state lacks ${required.role} contribution outcome`);
      }
      const contribution = this.#decodeContribution(checkpoint.data, required.role);
      if (required.role === this.#role() && !exact(contribution, local)) {
        throw new DacsError("terminal local contribution differs from retained signatures");
      }
      return contribution;
    });
  }

  async #recoverTerminal(record: SessionRecord): Promise<Readonly<DurableFinalizedTerminalBundle>> {
    if (record.phase !== this.#phase("finalised") || record.lease !== undefined) {
      throw new DacsError("read-only terminal recovery requires a sealed role-local phase");
    }
    this.#assertAuthorityCheckpoint(record);
    const proposalCheckpoint = latestCheckpoint(
      record.checkpoints,
      this.#key(terminalBundleFinalizationCheckpointName.proposalPublication),
    );
    if (
      proposalCheckpoint?.stage !== "outcome" ||
      !dataMatches(proposalCheckpoint.data, {
        ...this.#proposalIntent(),
        published: true,
      })
    ) {
      throw new DacsError("terminal state lacks its exact proposal publication outcome");
    }
    const local = this.#localContributionFromSignatureOutcomes(record);
    const localPublication = latestCheckpoint(
      record.checkpoints,
      this.#key(terminalBundleFinalizationCheckpointName.contributionPublication),
    );
    if (
      localPublication?.stage !== "outcome" ||
      !dataMatches(localPublication.data, {
        ...this.#contributionPublicationIntent(local),
        published: true,
      })
    ) {
      throw new DacsError("terminal state lacks its exact local contribution publication outcome");
    }
    const contributions = this.#recoverContributions(record, local);
    const matrix = createTerminalBundleSignatureMatrix(
      this.#input.plan,
      contributions,
      this.#input.signerKeys,
    );
    const matrixCheckpoint = latestCheckpoint(
      record.checkpoints,
      this.#key(terminalBundleFinalizationCheckpointName.matrix),
    );
    if (matrixCheckpoint?.stage !== "outcome") {
      throw new DacsError("terminal state lacks its signature matrix outcome");
    }
    const retainedMatrix = this.#decodeMatrix(matrixCheckpoint.data);
    if (!exact(matrix, retainedMatrix)) {
      throw new DacsError("terminal state matrix differs from its cryptographic contribution set");
    }
    const bundle = assembleTerminalBundleForOwnRole(
      this.#input.plan,
      retainedMatrix,
      { role: this.#role(), primaryClaim: this.#input.local.primaryClaim },
      this.#input.signerKeys,
    );

    const anchorCheckpoint = latestCheckpoint(
      record.checkpoints,
      this.#key(terminalBundleFinalizationCheckpointName.anchor),
    );
    if (anchorCheckpoint?.stage !== "outcome") {
      throw new DacsError("terminal state lacks its own bundle anchor outcome");
    }
    const persistedPublication = await this.#authenticateAnchor(
      this.#decodeAnchor(anchorCheckpoint.data),
      bundle,
      bundleAddress(this.#jobId(), this.#role()),
      "terminal-recovery",
    );
    const anchorReplay = await this.#resolveAnchor(
      bundle,
      persistedPublication.logicalAddress,
      "terminal-recovery",
    );
    if (anchorReplay.disposition !== "present") {
      this.#signalResolution(anchorReplay, "terminal-recovery", "indeterminate");
    }
    if (!exact(anchorReplay.value, persistedPublication)) {
      throw new DacsError("terminal bundle anchor differs from authenticated readback");
    }

    const bindingCheckpoint = latestCheckpoint(
      record.checkpoints,
      this.#key(terminalBundleFinalizationCheckpointName.bindingPublication),
    );
    if (bindingCheckpoint?.stage !== "outcome") {
      throw new DacsError("terminal state lacks its BundleBinding publication outcome");
    }
    const persistedBinding = this.#decodeBinding(bindingCheckpoint.data);
    const unsigned = this.#unsignedBinding(persistedPublication);
    const signatureCheckpoint = latestCheckpoint(
      record.checkpoints,
      this.#key(terminalBundleFinalizationCheckpointName.bindingSignature),
    );
    const signatureIntent = this.#signatureIntent(
      "bundle-binding",
      this.#role(),
      this.#bindingBytes(unsigned),
    );
    if (signatureCheckpoint?.stage !== "outcome" || !signatureCheckpoint.data) {
      throw new DacsError("terminal state lacks its BundleBinding signature outcome");
    }
    const { signatureValue, ...retainedSignatureIntent } = signatureCheckpoint.data;
    if (
      !dataMatches(retainedSignatureIntent, signatureIntent) ||
      signatureValue !== persistedBinding.signature.value
    ) {
      throw new DacsError("terminal BundleBinding signature differs from its fenced outcome");
    }
    const authenticatedBinding = await this.#authenticateBinding(
      persistedBinding,
      {
        ...unsigned,
        signature: {
          signer: this.#input.local.primaryClaim,
          algorithm: "ed25519",
          value: normalizeSignature(
            signatureValue as string,
            "terminal BundleBinding signature",
          ),
        },
      },
      "terminal-recovery",
    );
    const bindingReplay = await this.#resolveBinding(
      authenticatedBinding,
      "terminal-recovery",
    );
    if (bindingReplay.disposition !== "present") {
      this.#signalResolution(bindingReplay, "terminal-recovery", "indeterminate");
    }
    if (!exact(bindingReplay.value, authenticatedBinding)) {
      throw new DacsError("terminal BundleBinding differs from authenticated readback");
    }

    const expected = this.#result(
      local,
      retainedMatrix,
      bundle,
      persistedPublication,
      authenticatedBinding,
    );
    const resultCheckpoint = latestCheckpoint(
      record.checkpoints,
      this.#key(terminalBundleFinalizationCheckpointName.result),
    );
    if (resultCheckpoint?.stage !== "outcome") {
      throw new DacsError("terminal state lacks its exact result outcome");
    }
    const persisted = this.#decodeResult(resultCheckpoint.data);
    if (!exact(persisted, expected)) {
      throw new DacsError("terminal result differs from authenticated replay");
    }
    this.#assertExactResultSeal(record, expected);
    return expected;
  }

  async run(): Promise<DurableTerminalBundleProgress> {
    let record = await this.#load();
    if (record.phase === this.#phase("finalised")) {
      try {
        const result = await this.#recoverTerminal(record);
        return { disposition: "finalised", result, recovered: true };
      } catch (error) {
        const signal = retainedProgressSignal(error);
        if (signal) {
          return {
            disposition: signal.progress.disposition,
            stage: "terminal-recovery",
            reason: signal.progress.reason,
          };
        }
        if (error instanceof SubstrateError) {
          return {
            disposition: "indeterminate",
            stage: "terminal-recovery",
            reason: error.message,
          };
        }
        throw error;
      }
    }
    if (record.phase.startsWith("terminal:") && !record.phase.startsWith(`terminal:${this.#role()}:`)) {
      throw new DacsError("terminal session is already owned by a different local role");
    }
    await this.#acquire();
    await this.#persistAuthority();
    await this.#publishProposal();
    const localContribution = await this.#createLocalContribution();
    await this.#publishLocalContribution(localContribution);
    const matrix = await this.#createMatrix(localContribution);
    const bundle = assembleTerminalBundleForOwnRole(
      this.#input.plan,
      matrix,
      { role: this.#role(), primaryClaim: this.#input.local.primaryClaim },
      this.#input.signerKeys,
    );
    const publication = await this.#anchorBundle(bundle);
    const binding = await this.#createBinding(publication);
    const publishedBinding = await this.#publishBinding(binding);
    const result = this.#result(
      localContribution,
      matrix,
      bundle,
      publication,
      publishedBinding,
    );
    await this.#finish(result);
    return { disposition: "finalised", result, recovered: false };
  }

  async recoverOnly(): Promise<DurableTerminalBundleProgress> {
    const record = await this.#load();
    if (record.phase !== this.#phase("finalised")) {
      throw new DacsError("terminal bundle is not in its sealed role-local phase");
    }
    try {
      const result = await this.#recoverTerminal(record);
      return { disposition: "finalised", result, recovered: true };
    } catch (error) {
      const signal = retainedProgressSignal(error);
      if (signal) {
        return {
          disposition: signal.progress.disposition,
          stage: "terminal-recovery",
          reason: signal.progress.reason,
        };
      }
      if (error instanceof SubstrateError) {
        return {
          disposition: "indeterminate",
          stage: "terminal-recovery",
          reason: error.message,
        };
      }
      throw error;
    }
  }

  async release(): Promise<void> {
    await this.#release();
  }
}

/**
 * Advance one role's terminal publication as far as authenticated transport state permits.
 * Non-final progress releases the exact lease; a later invocation receives a higher generation.
 */
export async function advanceTerminalBundleDurable(
  input: DurableTerminalBundleInput,
  provider: DurableTerminalBundleProvider,
  durability: TerminalBundleFinalizationDurability,
): Promise<DurableTerminalBundleProgress> {
  const coordinator = new DurableTerminalBundleCoordinator(
    captureInput(input),
    captureProvider(provider),
    captureDurability(durability),
  );
  try {
    return await coordinator.run();
  } catch (error) {
    await coordinator.release();
    const signal = retainedProgressSignal(error);
    if (signal) return signal.progress;
    if (error instanceof SubstrateError) {
      return {
        disposition: "indeterminate",
        stage: "lease",
        reason: error.message,
      };
    }
    throw error;
  }
}

export type VerifyFinalizedTerminalBundleInput = Omit<
  DurableTerminalBundleInput,
  "local"
> & {
  local: Omit<DurableTerminalBundleInput["local"], "signer">;
};

export type TerminalBundleFinalizationReadProvider = Pick<
  DurableTerminalBundleProvider,
  | "resolveOwnBundle"
  | "verifyOwnBundlePublication"
  | "resolveOwnBundleBinding"
  | "verifyOwnBundleBinding"
>;

/** Read-only authenticated replay; this API accepts no signing or publication callback. */
export async function verifyFinalizedTerminalBundleReadOnly(
  input: VerifyFinalizedTerminalBundleInput,
  provider: TerminalBundleFinalizationReadProvider,
  store: FencedSessionStoreV2,
): Promise<DurableTerminalBundleProgress> {
  const inputMap = descriptors(input, "terminal read-only verification input");
  const local = snapshotData(
    dataProperty(inputMap, "local", "terminal read-only verification input"),
    "terminal read-only local identity",
  ) as VerifyFinalizedTerminalBundleInput["local"];
  const fullInput: DurableTerminalBundleInput = {
    authority: dataProperty(inputMap, "authority", "terminal read-only verification input"),
    signingMode: dataProperty(inputMap, "signingMode", "terminal read-only verification input"),
    signerKeys: dataProperty(inputMap, "signerKeys", "terminal read-only verification input"),
    local: {
      role: local.role,
      primaryClaim: local.primaryClaim,
      signer: () => {
        throw new DacsError("read-only terminal verification cannot sign");
      },
    },
  };
  const readMap = descriptors(provider, "terminal read-only provider");
  const fullProvider: DurableTerminalBundleProvider = {
    resolveOwnBundle: callback(readMap, "resolveOwnBundle", "terminal read-only provider"),
    verifyOwnBundlePublication: callback(
      readMap,
      "verifyOwnBundlePublication",
      "terminal read-only provider",
    ),
    resolveOwnBundleBinding: callback(
      readMap,
      "resolveOwnBundleBinding",
      "terminal read-only provider",
    ),
    verifyOwnBundleBinding: callback(
      readMap,
      "verifyOwnBundleBinding",
      "terminal read-only provider",
    ),
    submitOwnBundle: () => {
      throw new DacsError("read-only terminal verification cannot publish");
    },
    publishOwnBundleBinding: () => {
      throw new DacsError("read-only terminal verification cannot publish");
    },
  };
  const coordinator = new DurableTerminalBundleCoordinator(
    captureInput(fullInput),
    captureProvider(fullProvider),
    captureDurability({
      store,
      workerId: "terminal-read-only",
      leaseTtlMs: 1,
      transport: {
        resolveProposal: () => ({ disposition: "indeterminate", reason: "read-only" }),
        publishProposal: () => {
          throw new DacsError("read-only terminal verification cannot publish");
        },
        resolveContribution: () => ({ disposition: "indeterminate", reason: "read-only" }),
        publishContribution: () => {
          throw new DacsError("read-only terminal verification cannot publish");
        },
      },
      reconcileSignature: () => ({ disposition: "indeterminate", reason: "read-only" }),
    }),
  );
  return coordinator.recoverOnly();
}

export async function getTerminalBundleFinalizationStatus(
  store: FencedSessionStoreV2,
  jobId: string,
  role: BundlePartyRole,
): Promise<TerminalBundleFinalizationStatusLoad> {
  const loaded = await store.load(jobId);
  if (loaded.status !== "ok") return loaded;
  const checkpoints = Object.fromEntries(
    Object.entries(terminalBundleFinalizationCheckpointName).map(([name, suffix]) => [
      name,
      latestCheckpoint(
        loaded.record.checkpoints,
        terminalBundleFinalizationCheckpointKey(role, suffix),
      )?.stage ?? "not-started",
    ]),
  ) as Record<
    keyof typeof terminalBundleFinalizationCheckpointName,
    TerminalBundleCheckpointState
  >;
  const prefix = `terminal:${role}:`;
  const receipt = loaded.record.receipts.find(
    (candidate) => sessionReceiptKey(candidate) === "bundle",
  );
  return {
    status: "ok",
    jobId: loaded.record.jobId,
    role,
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
    checkpoints,
    signatureOutcomes: loaded.record.checkpoints.filter(
      (checkpoint) =>
        checkpoint.stage === "outcome" && checkpoint.key.startsWith(`${prefix}signature:`),
    ).length,
    contributionOutcomes: loaded.record.checkpoints.filter(
      (checkpoint) =>
        checkpoint.stage === "outcome" && checkpoint.key.startsWith(`${prefix}contribution:`),
    ).length,
    ...(receipt ? { bundleReceipt: receipt.ref } : {}),
    updatedAt: loaded.record.updatedAt,
  };
}
