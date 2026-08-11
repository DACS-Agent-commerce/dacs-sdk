import { types as nodeTypes } from "node:util";

import type {
  AgreementArtifact,
  AnchorReceipt,
  AttestationRef,
  ComponentSignatureAlgorithm,
} from "../artifacts/types.js";
import {
  isAgreementArtifact,
  isAnchorReceipt,
  isAttestationRef,
} from "../artifacts/validators.js";
import { canonicalize, contentHash, sha256Hex } from "../canonical/index.js";
import type { AnchorBinding } from "../discovery/binding.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  FENCED_SESSION_STORE_VERSION,
  sessionRecordShapeViolation,
  sessionReceiptKey,
  type CheckpointValue,
  type FencedSessionStoreV2,
  type SessionCheckpoint,
  type SessionLeaseToken,
  type SessionRecord,
} from "../agent/fencedSessionStore.js";
import type { AgreementSigner, UnsignedAgreementArtifact } from "./fixedPrice.js";
import {
  createFixedPriceAgreementSignatureContribution,
  createFixedPriceAgreementSigningPlan,
  finalizeFixedPriceAgreementContributions,
  fixedPriceAgreementSignedBytes,
  type FixedPriceAgreementContributionVerificationDisposition,
  type FixedPriceAgreementContributionVerificationInput,
  type FixedPriceAgreementContributionVerifier,
  type FixedPriceAgreementSignatureContribution,
  type FixedPriceAgreementSigningPlan,
} from "./fixedPriceExchange.js";

const MAX_CAS_ATTEMPTS = 16;
const MAX_RELEASE_ATTEMPTS = 8;
const INERT_RECEIVER = Object.freeze(Object.create(null)) as object;

export interface FixedPriceAgreementEffectFence extends SessionLeaseToken {
  /** Stable across lease generations for one exact logical effect. */
  idempotencyKey: string;
}

export type DurableFixedPriceAgreementSigner = (
  bytes: Uint8Array,
  context: Readonly<{
    party: string;
    algorithm: ComponentSignatureAlgorithm;
  }>,
  fence: Readonly<FixedPriceAgreementEffectFence>,
) => Promise<Uint8Array | string> | Uint8Array | string;

export interface DurableFixedPriceAgreementInput {
  draft: Readonly<UnsignedAgreementArtifact>;
  buyer: {
    party: string;
    algorithm: ComponentSignatureAlgorithm;
    sign: DurableFixedPriceAgreementSigner;
  };
}

export interface FixedPriceAgreementTransportIdentity {
  jobId: string;
  planHash: string;
  agreementHash: string;
  buyer: string;
  seller: string;
  proposalHash: string;
}

export interface FixedPriceAgreementProposal {
  proposalVersion: "1";
  plan: Readonly<FixedPriceAgreementSigningPlan>;
  buyerContribution: Readonly<FixedPriceAgreementSignatureContribution>;
  proposalHash: string;
}

/** Four-state read/reconciliation result. Only `absent` permits redrive. */
export type FixedPriceAgreementResolution<T> =
  | { disposition: "present"; value: T }
  | { disposition: "absent"; reason: string }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type FixedPriceAgreementEffectSubmission =
  | { disposition: "submitted" }
  | { disposition: "rejected"; reason: string }
  | { disposition: "indeterminate"; reason: string };

export type FixedPriceAgreementSignatureReconciliation =
  FixedPriceAgreementResolution<Uint8Array | string>;

export interface FixedPriceAgreementTransport {
  publishProposal: (
    proposal: Readonly<FixedPriceAgreementProposal>,
    identity: Readonly<FixedPriceAgreementTransportIdentity>,
    fence: Readonly<FixedPriceAgreementEffectFence>,
  ) =>
    | Promise<FixedPriceAgreementEffectSubmission>
    | FixedPriceAgreementEffectSubmission;
  reconcileProposalPublication: (
    identity: Readonly<FixedPriceAgreementTransportIdentity>,
    fence: Readonly<FixedPriceAgreementEffectFence>,
  ) =>
    | Promise<FixedPriceAgreementResolution<unknown>>
    | FixedPriceAgreementResolution<unknown>;
  /**
   * Resolve the seller-owned detached contribution set. The present value must
   * be an intrinsic array containing exactly one seller contribution.
   */
  resolveSellerContributions: (
    identity: Readonly<FixedPriceAgreementTransportIdentity>,
  ) =>
    | Promise<FixedPriceAgreementResolution<unknown>>
    | FixedPriceAgreementResolution<unknown>;
}

export interface AnchoredFixedPriceAgreementReadback {
  artifact: Readonly<AgreementArtifact>;
  ref: Readonly<AttestationRef>;
  anchorReceipt: Readonly<AnchorReceipt>;
}

export type FixedPriceAgreementAnchorVerificationDisposition =
  | "valid"
  | "invalid"
  | "indeterminate"
  | "error";

export interface FixedPriceAgreementAnchorProvider {
  anchorAgreement: (
    input: Readonly<{
      logicalAddress: string;
      agreementHash: string;
      artifact: Readonly<AgreementArtifact>;
    }>,
    fence: Readonly<FixedPriceAgreementEffectFence>,
  ) =>
    | Promise<FixedPriceAgreementEffectSubmission>
    | FixedPriceAgreementEffectSubmission;
  reconcileAgreementAnchor: (
    input: Readonly<{
      logicalAddress: string;
      agreementHash: string;
    }>,
    fence: Readonly<FixedPriceAgreementEffectFence>,
  ) =>
    | Promise<FixedPriceAgreementResolution<unknown>>
    | FixedPriceAgreementResolution<unknown>;
  /** Independently authenticate the exact native receipt retained by readback. */
  verifyAnchorReceipt: (
    input: Readonly<{
      expectedWriter: string;
      ref: Readonly<AttestationRef>;
      receipt: Readonly<AnchorReceipt>;
    }>,
  ) =>
    | Promise<FixedPriceAgreementAnchorVerificationDisposition>
    | FixedPriceAgreementAnchorVerificationDisposition;
  /** Optional logical-to-native publication. Both callbacks must be supplied together. */
  publishBinding?: (
    binding: Readonly<AnchorBinding>,
    fence: Readonly<FixedPriceAgreementEffectFence>,
  ) =>
    | Promise<FixedPriceAgreementEffectSubmission>
    | FixedPriceAgreementEffectSubmission;
  reconcileBindingPublication?: (
    binding: Readonly<AnchorBinding>,
    fence: Readonly<FixedPriceAgreementEffectFence>,
  ) =>
    | Promise<FixedPriceAgreementResolution<unknown>>
    | FixedPriceAgreementResolution<unknown>;
}

export interface DurableFixedPriceAgreementDurability {
  store: FencedSessionStoreV2;
  workerId: string;
  leaseTtlMs: number;
  leaseNowMs?: () => number;
  reconcileBuyerSignature: (
    input: Readonly<{
      planHash: string;
      agreementHash: string;
      party: string;
      algorithm: ComponentSignatureAlgorithm;
      signedBytes: Uint8Array;
    }>,
    fence: Readonly<FixedPriceAgreementEffectFence>,
  ) =>
    | Promise<FixedPriceAgreementSignatureReconciliation>
    | FixedPriceAgreementSignatureReconciliation;
  verifyContribution: FixedPriceAgreementContributionVerifier;
  transport: FixedPriceAgreementTransport;
  anchor: FixedPriceAgreementAnchorProvider;
}

export interface DurableAnchoredFixedPriceAgreement {
  agreement: Readonly<AgreementArtifact>;
  agreementHash: string;
  agreementRef: Readonly<AttestationRef>;
  anchorReceipt: Readonly<AnchorReceipt>;
  binding?: Readonly<AnchorBinding>;
}

export type DurableFixedPriceAgreementStage =
  | "lease"
  | "plan"
  | "buyer-signature"
  | "proposal-publication"
  | "seller-contribution"
  | "agreement-anchor"
  | "agreement-binding"
  | "terminal-recovery";

export type DurableFixedPriceAgreementProgress =
  | {
      disposition: "anchored";
      result: Readonly<DurableAnchoredFixedPriceAgreement>;
      recovered: boolean;
    }
  | {
      disposition: "waiting" | "rejected" | "indeterminate";
      stage: DurableFixedPriceAgreementStage;
      reason: string;
    };

export const durableFixedPriceAgreementCheckpointKey = Object.freeze({
  plan: "agreement:fixed-price-plan",
  buyerSignature: "agreement:buyer-signature",
  proposal: "agreement:proposal-publication",
  sellerContribution: "agreement:seller-contribution",
  anchor: "agreement:artifact-anchor",
  binding: "agreement:logical-native-binding",
  result: "agreement:durable-result",
} as const);

const AGREEMENT_PHASE_RANK = new Map<string, number>([
  ["agreement:plan-binding", 0],
  ["agreement:buyer-signing", 1],
  ["agreement:proposal-publication-pending", 2],
  ["agreement:awaiting-seller-contribution", 3],
  ["agreement:anchor-pending", 4],
  ["agreement:binding-publication-pending", 5],
  ["agreement:finalizing", 6],
  ["agreement:anchored", 7],
]);

type DataRecord = Record<string, unknown>;
type DescriptorMap = Record<PropertyKey, PropertyDescriptor>;

const isRecord = (value: unknown): value is DataRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.trim() === value &&
  value.normalize("NFC") === value;
const clone = <T>(value: T): T => structuredClone(value);

function exactKeys(
  value: DataRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.has(key)) &&
    optional.every((key) =>
      !Object.prototype.hasOwnProperty.call(value, key) || value[key] !== undefined
    );
}

function snapshotDataValue(
  value: unknown,
  subject: string,
  ancestors: Set<object>,
): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || !Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError(`${subject} contains a non-canonical number`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${subject} must contain JSON data only`);
  }
  if (nodeTypes.isProxy(value)) throw new TypeError(`${subject} cannot contain proxies`);
  if (ancestors.has(value)) throw new TypeError(`${subject} must be acyclic`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${subject} must use the intrinsic array prototype`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const expected = new Set<PropertyKey>([
        "length",
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ]);
      const keys = Reflect.ownKeys(value);
      if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
        throw new TypeError(`${subject} cannot be sparse or carry extra fields`);
      }
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
          throw new TypeError(`${subject}[${index}] must be an enumerable data property`);
        }
        return snapshotDataValue(descriptor.value, `${subject}[${index}]`, ancestors);
      });
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${subject} objects must use a plain prototype`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as DescriptorMap;
    const out: DataRecord = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(`${subject} cannot contain symbol fields`);
      }
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
        throw new TypeError(`${subject}.${key} must be an enumerable data property`);
      }
      if (descriptor.value === undefined) {
        throw new TypeError(`${subject}.${key} cannot be undefined`);
      }
      out[key] = snapshotDataValue(descriptor.value, `${subject}.${key}`, ancestors);
    }
    return out;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotData<T>(value: T, subject: string): T {
  return snapshotDataValue(value, subject, new Set<object>()) as T;
}

function immutable<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as DataRecord)) immutable(child);
  return Object.freeze(value);
}

function exact(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(snapshotData(left, "left comparison value") as never) ===
      canonicalize(snapshotData(right, "right comparison value") as never);
  } catch {
    return false;
  }
}

function encode(value: unknown, subject: string): string {
  return canonicalize(snapshotData(value, subject) as never);
}

function decode<T>(value: unknown, subject: string): T {
  if (typeof value !== "string") throw new DacsError(`${subject} is not encoded data`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new DacsError(`${subject} is not valid JSON`, { cause: error });
  }
  return snapshotData(parsed, subject) as T;
}

function descriptors(value: unknown, subject: string): DescriptorMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object of owned data properties`);
  }
  if (nodeTypes.isProxy(value)) throw new TypeError(`${subject} cannot be a proxy`);
  let map: DescriptorMap;
  try {
    map = Object.getOwnPropertyDescriptors(value) as DescriptorMap;
  } catch (error) {
    throw new TypeError(`${subject} cannot be inspected safely`, { cause: error });
  }
  for (const key of Reflect.ownKeys(map)) {
    const descriptor = map[key];
    if (
      typeof key !== "string" ||
      !descriptor ||
      !("value" in descriptor) ||
      descriptor.enumerable !== true
    ) {
      throw new TypeError(`${subject}.${String(key)} must be an owned data property`);
    }
  }
  return map;
}

function exactDescriptors(
  value: unknown,
  subject: string,
  required: readonly string[],
  optional: readonly string[] = [],
): DescriptorMap {
  const map = descriptors(value, subject);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(map);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(map, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw new TypeError(
      `${subject} must contain exactly ${required.join(", ")}` +
        (optional.length > 0 ? ` and optional ${optional.join(", ")}` : ""),
    );
  }
  return map;
}

function dataProperty<T>(map: DescriptorMap, key: string, subject: string): T {
  const descriptor = map[key];
  if (!descriptor || !("value" in descriptor)) {
    throw new TypeError(`${subject}.${key} must be an owned data property`);
  }
  return descriptor.value as T;
}

function optionalProperty<T>(map: DescriptorMap, key: string): T | undefined {
  const descriptor = map[key];
  return descriptor && "value" in descriptor ? descriptor.value as T : undefined;
}

function inertFunction<T>(value: unknown, subject: string): T {
  if (typeof value !== "function" || nodeTypes.isProxy(value)) {
    throw new TypeError(`${subject} must be a non-proxy callable`);
  }
  return ((...args: unknown[]) => Reflect.apply(value, INERT_RECEIVER, args)) as T;
}

function callback<T>(map: DescriptorMap, key: string, subject: string): T {
  return inertFunction<T>(dataProperty(map, key, subject), `${subject}.${key}`);
}

function optionalCallback<T>(map: DescriptorMap, key: string, subject: string): T | undefined {
  const value = optionalProperty<unknown>(map, key);
  return value === undefined ? undefined : inertFunction<T>(value, `${subject}.${key}`);
}

function captureStore(value: unknown): FencedSessionStoreV2 {
  const subject = "agreement durability store";
  const map = exactDescriptors(value, subject, [
    "apiVersion",
    "create",
    "load",
    "transition",
    "claimCheckpoint",
    "acquireLease",
    "renewLease",
    "bindSessionAuthorization",
    "bindHash",
    "list",
  ]);
  if (dataProperty(map, "apiVersion", subject) !== FENCED_SESSION_STORE_VERSION) {
    throw new TypeError("agreement durability requires FencedSessionStoreV2");
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
  const captured: FencedSessionStoreV2 = {
    apiVersion: FENCED_SESSION_STORE_VERSION,
    create: async (input) => snapshotData(await create(clone(input)), "store create result"),
    load: async (jobId) => snapshotData(await load(jobId), "store load result"),
    transition: async (input) =>
      snapshotData(await transition(clone(input)), "store transition result"),
    claimCheckpoint: async (input) =>
      snapshotData(await claimCheckpoint(clone(input)), "store checkpoint result"),
    acquireLease: async (input) =>
      snapshotData(await acquireLease(clone(input)), "store lease result"),
    renewLease: async (input) =>
      snapshotData(await renewLease(clone(input)), "store renewal result"),
    bindSessionAuthorization: async (input) =>
      snapshotData(
        await bindSessionAuthorization(clone(input)),
        "store authorization result",
      ),
    bindHash: async (input) =>
      snapshotData(await bindHash(clone(input)), "store hash-binding result"),
    list: async (filter) =>
      snapshotData(
        await list(filter === undefined ? undefined : clone(filter)),
        "store list result",
      ),
  };
  return Object.freeze(captured);
}

function captureInput(value: unknown): DurableFixedPriceAgreementInput {
  const subject = "durable fixed-price agreement input";
  const map = exactDescriptors(value, subject, ["draft", "buyer"]);
  const buyerSubject = `${subject}.buyer`;
  const buyerMap = exactDescriptors(
    dataProperty(map, "buyer", subject),
    buyerSubject,
    ["party", "algorithm", "sign"],
  );
  const party = dataProperty<unknown>(buyerMap, "party", buyerSubject);
  const algorithm = dataProperty<unknown>(buyerMap, "algorithm", buyerSubject);
  if (!isNonEmpty(party)) throw new TypeError("buyer party must be canonical and non-empty");
  if (
    algorithm !== "ed25519" &&
    algorithm !== "ecdsa-secp256k1" &&
    algorithm !== "sr1-aggregate"
  ) {
    throw new TypeError("buyer algorithm is not a supported component signature algorithm");
  }
  return Object.freeze({
    draft: immutable(snapshotData(
      dataProperty<UnsignedAgreementArtifact>(map, "draft", subject),
      "agreement draft",
    )),
    buyer: Object.freeze({
      party,
      algorithm,
      sign: callback<DurableFixedPriceAgreementSigner>(buyerMap, "sign", buyerSubject),
    }),
  });
}

function captureTransport(value: unknown): FixedPriceAgreementTransport {
  const subject = "fixed-price agreement transport";
  const map = exactDescriptors(value, subject, [
    "publishProposal",
    "reconcileProposalPublication",
    "resolveSellerContributions",
  ]);
  const publishProposal = callback<FixedPriceAgreementTransport["publishProposal"]>(
    map,
    "publishProposal",
    subject,
  );
  const reconcileProposalPublication = callback<
    FixedPriceAgreementTransport["reconcileProposalPublication"]
  >(map, "reconcileProposalPublication", subject);
  const resolveSellerContributions = callback<
    FixedPriceAgreementTransport["resolveSellerContributions"]
  >(map, "resolveSellerContributions", subject);
  const captured: FixedPriceAgreementTransport = {
    publishProposal: async (proposal, identity, fence) =>
      captureSubmission(
        await publishProposal(clone(proposal), clone(identity), clone(fence)),
        "proposal submission",
      ),
    reconcileProposalPublication: async (identity, fence) =>
      captureResolution(
        await reconcileProposalPublication(clone(identity), clone(fence)),
        "proposal reconciliation",
      ),
    resolveSellerContributions: async (identity) =>
      captureResolution(
        await resolveSellerContributions(clone(identity)),
        "seller contribution resolution",
      ),
  };
  return Object.freeze(captured);
}

function captureAnchor(value: unknown): FixedPriceAgreementAnchorProvider {
  const subject = "fixed-price agreement anchor provider";
  const map = exactDescriptors(
    value,
    subject,
    ["anchorAgreement", "reconcileAgreementAnchor", "verifyAnchorReceipt"],
    ["publishBinding", "reconcileBindingPublication"],
  );
  const anchorAgreement = callback<FixedPriceAgreementAnchorProvider["anchorAgreement"]>(
    map,
    "anchorAgreement",
    subject,
  );
  const reconcileAgreementAnchor = callback<
    FixedPriceAgreementAnchorProvider["reconcileAgreementAnchor"]
  >(map, "reconcileAgreementAnchor", subject);
  const verifyAnchorReceipt = callback<
    FixedPriceAgreementAnchorProvider["verifyAnchorReceipt"]
  >(map, "verifyAnchorReceipt", subject);
  const publishBinding = optionalCallback<
    NonNullable<FixedPriceAgreementAnchorProvider["publishBinding"]>
  >(map, "publishBinding", subject);
  const reconcileBindingPublication = optionalCallback<
    NonNullable<FixedPriceAgreementAnchorProvider["reconcileBindingPublication"]>
  >(map, "reconcileBindingPublication", subject);
  if ((publishBinding === undefined) !== (reconcileBindingPublication === undefined)) {
    throw new TypeError("agreement binding publication and reconciliation must be supplied together");
  }
  const captured: FixedPriceAgreementAnchorProvider = {
    anchorAgreement: async (input, fence) =>
      captureSubmission(
        await anchorAgreement(clone(input), clone(fence)),
        "agreement anchor submission",
      ),
    reconcileAgreementAnchor: async (input, fence) =>
      captureResolution(
        await reconcileAgreementAnchor(clone(input), clone(fence)),
        "agreement anchor reconciliation",
      ),
    verifyAnchorReceipt: async (input) => {
      const result = await verifyAnchorReceipt(clone(input));
      if (!["valid", "invalid", "indeterminate", "error"].includes(String(result))) {
        throw new TypeError("anchor receipt verifier returned an invalid disposition");
      }
      return result;
    },
    ...(publishBinding && reconcileBindingPublication
      ? {
          publishBinding: async (binding, fence) =>
            captureSubmission(
              await publishBinding(clone(binding), clone(fence)),
              "agreement binding submission",
            ),
          reconcileBindingPublication: async (binding, fence) =>
            captureResolution(
              await reconcileBindingPublication(clone(binding), clone(fence)),
              "agreement binding reconciliation",
            ),
        }
      : {}),
  };
  return Object.freeze(captured);
}

function captureDurability(value: unknown): DurableFixedPriceAgreementDurability {
  const subject = "durable fixed-price agreement dependencies";
  const map = exactDescriptors(
    value,
    subject,
    [
      "store",
      "workerId",
      "leaseTtlMs",
      "reconcileBuyerSignature",
      "verifyContribution",
      "transport",
      "anchor",
    ],
    ["leaseNowMs"],
  );
  const workerId = dataProperty<unknown>(map, "workerId", subject);
  const leaseTtlMs = dataProperty<unknown>(map, "leaseTtlMs", subject);
  if (!isNonEmpty(workerId)) throw new TypeError("agreement workerId must be canonical");
  if (typeof leaseTtlMs !== "number" || !Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new TypeError("agreement leaseTtlMs must be a positive safe integer");
  }
  const reconcileBuyerSignatureSource = callback<
    DurableFixedPriceAgreementDurability["reconcileBuyerSignature"]
  >(map, "reconcileBuyerSignature", subject);
  const verifyContributionSource = callback<FixedPriceAgreementContributionVerifier>(
    map,
    "verifyContribution",
    subject,
  );
  const leaseNowMsSource = optionalCallback<() => number>(map, "leaseNowMs", subject);
  const captured: DurableFixedPriceAgreementDurability = {
    store: captureStore(dataProperty(map, "store", subject)),
    workerId,
    leaseTtlMs,
    ...(leaseNowMsSource ? { leaseNowMs: leaseNowMsSource } : {}),
    reconcileBuyerSignature: async (input, fence) => {
      const output = await reconcileBuyerSignatureSource(
        {
          ...clone(input),
          signedBytes: Uint8Array.from(input.signedBytes),
        },
        clone(fence),
      );
      return captureSignatureResolution(output);
    },
    verifyContribution: async (input) => {
      const output = await verifyContributionSource({
        ...clone(input),
        signedBytes: Uint8Array.from(input.signedBytes),
      });
      if (!["valid", "invalid", "indeterminate", "error"].includes(String(output))) {
        throw new TypeError("agreement contribution verifier returned an invalid disposition");
      }
      return output;
    },
    transport: captureTransport(dataProperty(map, "transport", subject)),
    anchor: captureAnchor(dataProperty(map, "anchor", subject)),
  };
  return Object.freeze(captured);
}

function captureSubmission(value: unknown, subject: string): FixedPriceAgreementEffectSubmission {
  const captured = snapshotData(value, subject) as unknown;
  if (!isRecord(captured) || typeof captured.disposition !== "string") {
    throw new TypeError(`${subject} is malformed`);
  }
  if (captured.disposition === "submitted" && exactKeys(captured, ["disposition"])) {
    return captured as FixedPriceAgreementEffectSubmission;
  }
  if (
    (captured.disposition === "rejected" || captured.disposition === "indeterminate") &&
    exactKeys(captured, ["disposition", "reason"]) &&
    isNonEmpty(captured.reason)
  ) {
    return captured as FixedPriceAgreementEffectSubmission;
  }
  throw new TypeError(`${subject} is malformed`);
}

function captureResolution(
  value: unknown,
  subject: string,
): FixedPriceAgreementResolution<unknown> {
  const captured = snapshotData(value, subject) as unknown;
  if (!isRecord(captured) || typeof captured.disposition !== "string") {
    throw new TypeError(`${subject} is malformed`);
  }
  if (captured.disposition === "present" && exactKeys(captured, ["disposition", "value"])) {
    return captured as FixedPriceAgreementResolution<unknown>;
  }
  if (
    ["absent", "rejected", "indeterminate"].includes(captured.disposition) &&
    exactKeys(captured, ["disposition", "reason"]) &&
    isNonEmpty(captured.reason)
  ) {
    return captured as FixedPriceAgreementResolution<unknown>;
  }
  throw new TypeError(`${subject} is malformed`);
}

function captureSignatureValue(value: unknown, subject: string): Uint8Array | string {
  if (typeof value === "string") return value;
  if (
    value instanceof Uint8Array &&
    !nodeTypes.isProxy(value) &&
    (Object.getPrototypeOf(value) === Uint8Array.prototype || Buffer.isBuffer(value))
  ) {
    return Uint8Array.from(value);
  }
  throw new TypeError(`${subject} must be a string or intrinsic Uint8Array`);
}

function captureSignatureResolution(value: unknown): FixedPriceAgreementSignatureReconciliation {
  if (value === null || typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new TypeError("buyer signature reconciliation is malformed");
  }
  const map = exactDescriptors(
    value,
    "buyer signature reconciliation",
    ["disposition"],
    ["value", "reason"],
  );
  const disposition = dataProperty<unknown>(map, "disposition", "buyer signature reconciliation");
  if (disposition === "present") {
    if (map.reason || !map.value) {
      throw new TypeError("present buyer signature reconciliation is malformed");
    }
    return {
      disposition,
      value: captureSignatureValue(
        dataProperty(map, "value", "buyer signature reconciliation"),
        "reconciled buyer signature",
      ),
    };
  }
  if (!["absent", "rejected", "indeterminate"].includes(String(disposition)) ||
      map.value || !map.reason) {
    throw new TypeError("buyer signature reconciliation is malformed");
  }
  const reason = dataProperty<unknown>(map, "reason", "buyer signature reconciliation");
  if (!isNonEmpty(reason)) throw new TypeError("buyer signature reconciliation reason is invalid");
  return { disposition, reason } as FixedPriceAgreementSignatureReconciliation;
}

function latestCheckpoint(
  checkpoints: readonly SessionCheckpoint[],
  key: string,
): SessionCheckpoint | undefined {
  return [...checkpoints].reverse().find((checkpoint) => checkpoint.key === key);
}

function exactRecordFromLoad(
  loaded: Awaited<ReturnType<FencedSessionStoreV2["load"]>>,
): SessionRecord {
  if (loaded.status !== "ok") {
    throw new SubstrateError(
      loaded.status === "unsupported"
        ? `agreement state uses unsupported store version ${loaded.version}`
        : loaded.status === "corrupt"
          ? `agreement state is corrupt: ${loaded.reason}`
          : "agreement state is missing",
    );
  }
  const record = clone(loaded.record);
  const violation = sessionRecordShapeViolation(record);
  if (violation) throw new SubstrateError(`agreement state is corrupt: ${violation}`);
  return record;
}

class ProgressSignal extends Error {
  readonly progress: Exclude<
    DurableFixedPriceAgreementProgress,
    { disposition: "anchored" }
  >;

  constructor(
    disposition: "waiting" | "rejected" | "indeterminate",
    stage: DurableFixedPriceAgreementStage,
    reason: string,
  ) {
    super(reason);
    this.name = "FixedPriceAgreementProgressSignal";
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

/** Canonical logical SR-2 address used by the durable fixed-price exchange. */
export function fixedPriceAgreementLogicalAddress(jobId: string): string {
  if (!isNonEmpty(jobId)) throw new DacsError("agreement jobId must be canonical and non-empty");
  return `dacs3:agreement:${jobId}`;
}

class DurableFixedPriceAgreementCoordinator {
  readonly #input: DurableFixedPriceAgreementInput;
  readonly #durability: DurableFixedPriceAgreementDurability;
  readonly #plan: Readonly<FixedPriceAgreementSigningPlan>;
  readonly #buyer: string;
  readonly #seller: string;
  readonly #jobId: string;
  readonly #logicalAddress: string;
  #lease?: SessionLeaseToken;
  #buyerContribution?: Readonly<FixedPriceAgreementSignatureContribution>;
  #proposal?: Readonly<FixedPriceAgreementProposal>;
  #identity?: Readonly<FixedPriceAgreementTransportIdentity>;
  #sellerContribution?: Readonly<FixedPriceAgreementSignatureContribution>;
  #agreement?: Readonly<AgreementArtifact>;
  #readback?: Readonly<AnchoredFixedPriceAgreementReadback>;
  #binding?: Readonly<AnchorBinding>;

  constructor(
    input: DurableFixedPriceAgreementInput,
    durability: DurableFixedPriceAgreementDurability,
  ) {
    this.#input = input;
    this.#durability = durability;
    this.#plan = createFixedPriceAgreementSigningPlan(input.draft);
    const buyer = this.#plan.requiredSigners.find((entry) => entry.role === "buyer")?.party;
    const seller = this.#plan.requiredSigners.find((entry) => entry.role === "seller")?.party;
    if (!buyer || !seller || input.buyer.party !== buyer) {
      throw new DacsError("durable buyer signer does not own the agreement buyer role");
    }
    this.#buyer = buyer;
    this.#seller = seller;
    this.#jobId = this.#plan.draft.jobId;
    this.#logicalAddress = fixedPriceAgreementLogicalAddress(this.#jobId);
  }

  #now(): number {
    const value = this.#durability.leaseNowMs?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new DacsError("agreement durability clock returned an invalid time");
    }
    return value;
  }

  #authorityData(): Record<string, CheckpointValue> {
    return {
      jobId: this.#jobId,
      planHash: this.#plan.planHash,
      agreementHash: this.#plan.agreementHash,
      buyer: this.#buyer,
      seller: this.#seller,
      logicalAddress: this.#logicalAddress,
      signedBytesHash: sha256Hex(fixedPriceAgreementSignedBytes(this.#plan)),
    };
  }

  #planData(): Record<string, CheckpointValue> {
    return {
      ...this.#authorityData(),
      planJson: encode(this.#plan, "fixed-price agreement plan"),
    };
  }

  #idempotencyKey(
    kind: string,
    identity: Record<string, CheckpointValue> = {},
  ): string {
    return `agreement:${kind}:${sha256Hex(canonicalize({
      ...this.#authorityData(),
      ...identity,
    }))}`;
  }

  async #load(): Promise<SessionRecord> {
    return exactRecordFromLoad(await this.#durability.store.load(this.#jobId));
  }

  async #ensureState(): Promise<SessionRecord> {
    let loaded = await this.#durability.store.load(this.#jobId);
    if (loaded.status === "missing") {
      try {
        await this.#durability.store.create({
          jobId: this.#jobId,
          agreementHash: this.#plan.agreementHash,
          phase: "agreement:plan-binding",
          now: this.#now(),
        });
      } catch (error) {
        // A concurrent creator may have won. Reload and authenticate its exact
        // set-once authority; do not classify an arbitrary create failure as a race.
        loaded = await this.#durability.store.load(this.#jobId);
        if (loaded.status === "missing") throw error;
      }
      loaded = await this.#durability.store.load(this.#jobId);
    }
    let record = exactRecordFromLoad(loaded);
    if (record.agreementHash === undefined) {
      if (record.leaseGeneration !== 0 || record.checkpoints.length !== 0) {
        throw new DacsError("existing session cannot be rebound to this agreement plan");
      }
      const bound = await this.#durability.store.bindHash({
        hash: this.#plan.agreementHash,
        jobId: this.#jobId,
        kind: "agreement",
      });
      if (!bound.ok || (bound.boundTo !== undefined && bound.boundTo !== this.#jobId)) {
        throw new DacsError(
          `agreement hash is already bound to ${bound.boundTo ?? "another session"}`,
        );
      }
      record = await this.#load();
    }
    if (record.agreementHash !== this.#plan.agreementHash) {
      throw new DacsError("durable agreement session is bound to a conflicting plan");
    }
    return record;
  }

  async #acquire(): Promise<void> {
    const result = await this.#durability.store.acquireLease({
      jobId: this.#jobId,
      owner: this.#durability.workerId,
      ttlMs: this.#durability.leaseTtlMs,
      now: this.#now(),
    });
    if (!result.ok) {
      if (result.reason === "lease-held") {
        throw new ProgressSignal(
          "waiting",
          "lease",
          "another generation currently owns the agreement exchange",
        );
      }
      throw new SubstrateError(`agreement lease acquisition failed: ${result.reason}`);
    }
    this.#lease = Object.freeze({
      owner: result.lease.owner,
      generation: result.lease.generation,
    });
  }

  async #renew(): Promise<void> {
    if (!this.#lease) throw new SubstrateError("agreement lease is unavailable");
    const renewed = await this.#durability.store.renewLease({
      jobId: this.#jobId,
      leaseToken: this.#lease,
      ttlMs: this.#durability.leaseTtlMs,
      now: this.#now(),
    });
    if (!renewed.ok) {
      throw new SubstrateError(`agreement lease is stale: ${renewed.reason}`);
    }
  }

  #fence(idempotencyKey: string): Readonly<FixedPriceAgreementEffectFence> {
    if (!this.#lease) throw new SubstrateError("agreement lease is unavailable");
    return Object.freeze({ ...this.#lease, idempotencyKey });
  }

  async #invokeFenced<T>(
    idempotencyKey: string,
    operation: (fence: Readonly<FixedPriceAgreementEffectFence>) => Promise<T> | T,
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

  #phaseFor(record: SessionRecord, requested: string): string | undefined {
    const current = AGREEMENT_PHASE_RANK.get(record.phase);
    const wanted = AGREEMENT_PHASE_RANK.get(requested);
    return current !== undefined && wanted !== undefined && current > wanted
      ? undefined
      : requested;
  }

  #dataContains(
    actual: Record<string, CheckpointValue> | undefined,
    expected: Record<string, CheckpointValue>,
  ): boolean {
    return actual !== undefined && Object.entries(expected).every(
      ([key, value]) => actual[key] === value,
    );
  }

  async #claim(
    key: string,
    data: Record<string, CheckpointValue>,
    phase: string,
  ): Promise<{
    state: "fresh" | "intent" | "outcome";
    data: Record<string, CheckpointValue>;
    record: SessionRecord;
  }> {
    if (!this.#lease) throw new SubstrateError("agreement lease is unavailable");
    await this.#renew();
    const current = await this.#load();
    const requested = this.#phaseFor(current, phase);
    const claimed = await this.#durability.store.claimCheckpoint({
      jobId: this.#jobId,
      key,
      data: clone(data),
      ...(requested ? { phase: requested } : {}),
      leaseToken: this.#lease,
      now: this.#now(),
    });
    if (claimed.ok) {
      return { state: "fresh", data: clone(data), record: claimed.record };
    }
    if ((claimed.reason !== "held" && claimed.reason !== "completed") || !claimed.record) {
      throw new SubstrateError(`agreement checkpoint ${key} claim failed: ${claimed.reason}`);
    }
    const checkpoint = latestCheckpoint(claimed.record.checkpoints, key);
    if (!checkpoint?.data || !this.#dataContains(checkpoint.data, data)) {
      throw new DacsError(`agreement checkpoint ${key} binds conflicting content`);
    }
    return {
      state: claimed.reason === "completed" ? "outcome" : "intent",
      data: clone(checkpoint.data),
      record: claimed.record,
    };
  }

  async #complete(
    key: string,
    data: Record<string, CheckpointValue>,
    options: {
      phase?: string;
      receipt?: { kind: "agreement"; ref: string };
      release?: boolean;
    } = {},
  ): Promise<SessionRecord> {
    if (!this.#lease) throw new SubstrateError("agreement lease is unavailable");
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      await this.#renew();
      const record = await this.#load();
      const prior = latestCheckpoint(record.checkpoints, key);
      if (prior?.stage === "outcome") {
        if (!this.#dataContains(prior.data, data)) {
          throw new DacsError(`agreement checkpoint ${key} has a conflicting outcome`);
        }
        return record;
      }
      if (prior?.stage !== "intent") {
        throw new DacsError(`agreement checkpoint ${key} lacks its durable intent`);
      }
      const phase = options.phase
        ? this.#phaseFor(record, options.phase)
        : undefined;
      const transitioned = await this.#durability.store.transition({
        jobId: this.#jobId,
        expectedRevision: record.revision,
        leaseToken: this.#lease,
        ...(phase ? { phase } : {}),
        checkpoint: { key, stage: "outcome", data: clone(data) },
        ...(options.receipt ? { receipt: clone(options.receipt) } : {}),
        ...(options.release ? { lease: null } : {}),
        now: this.#now(),
      });
      if (transitioned.ok) {
        if (options.release) this.#lease = undefined;
        return transitioned.record;
      }
      if (transitioned.reason === "revision-mismatch") continue;
      if (transitioned.reason === "checkpoint-state" && transitioned.record) {
        const outcome = latestCheckpoint(transitioned.record.checkpoints, key);
        if (outcome?.stage === "outcome" && this.#dataContains(outcome.data, data)) {
          return transitioned.record;
        }
      }
      throw new SubstrateError(
        `agreement checkpoint ${key} outcome failed: ${transitioned.reason}`,
      );
    }
    throw new SubstrateError(`agreement checkpoint ${key} outcome exhausted CAS retries`);
  }

  async #release(): Promise<void> {
    const token = this.#lease;
    if (!token) return;
    for (let attempt = 0; attempt < MAX_RELEASE_ATTEMPTS; attempt += 1) {
      let record: SessionRecord;
      try {
        record = await this.#load();
      } catch {
        return;
      }
      if (
        !record.lease ||
        record.lease.owner !== token.owner ||
        record.lease.generation !== token.generation
      ) {
        this.#lease = undefined;
        return;
      }
      const released = await this.#durability.store.transition({
        jobId: this.#jobId,
        expectedRevision: record.revision,
        leaseToken: token,
        lease: null,
        now: this.#now(),
      });
      if (released.ok || released.reason === "lease-fenced" ||
          released.reason === "lease-expired") {
        this.#lease = undefined;
        return;
      }
      if (released.reason !== "revision-mismatch") return;
    }
  }

  async #bindPlan(): Promise<void> {
    const expected = this.#planData();
    const claimed = await this.#claim(
      durableFixedPriceAgreementCheckpointKey.plan,
      expected,
      "agreement:plan-binding",
    );
    const persisted = decode<FixedPriceAgreementSigningPlan>(
      claimed.data.planJson,
      "persisted fixed-price agreement plan",
    );
    // fixedPriceAgreementSignedBytes revalidates every derived plan field and hash.
    fixedPriceAgreementSignedBytes(persisted);
    if (!exact(persisted, this.#plan)) {
      throw new DacsError("durable agreement plan differs from the requested exact plan");
    }
    if (claimed.state !== "outcome") {
      await this.#complete(durableFixedPriceAgreementCheckpointKey.plan, expected, {
        phase: "agreement:buyer-signing",
      });
    }
  }

  async #contributionFromSignature(
    raw: Uint8Array | string,
  ): Promise<Readonly<FixedPriceAgreementSignatureContribution>> {
    const signer: AgreementSigner = {
      party: this.#buyer,
      algorithm: this.#input.buyer.algorithm,
      sign: () => typeof raw === "string" ? raw : Uint8Array.from(raw),
    };
    return createFixedPriceAgreementSignatureContribution(this.#plan, "buyer", signer);
  }

  async #verifyOneContribution(
    contribution: Readonly<FixedPriceAgreementSignatureContribution>,
    stage: DurableFixedPriceAgreementStage,
  ): Promise<void> {
    let disposition: FixedPriceAgreementContributionVerificationDisposition;
    try {
      disposition = await this.#durability.verifyContribution({
        role: contribution.role,
        party: contribution.party,
        algorithm: contribution.signature.algorithm,
        value: contribution.signature.value,
        signedBytes: fixedPriceAgreementSignedBytes(this.#plan),
      });
    } catch (error) {
      throw new ProgressSignal(
        "indeterminate",
        stage,
        `agreement signature verification failed: ${String(error)}`,
      );
    }
    if (disposition === "valid") return;
    throw new ProgressSignal(
      disposition === "invalid" ? "rejected" : "indeterminate",
      stage,
      `${contribution.role} agreement signature verification was ${disposition}`,
    );
  }

  #signatureIntent(): Record<string, CheckpointValue> {
    const idempotencyKey = this.#idempotencyKey("buyer-signature", {
      algorithm: this.#input.buyer.algorithm,
    });
    return {
      ...this.#authorityData(),
      algorithm: this.#input.buyer.algorithm,
      idempotencyKey,
    };
  }

  async #restoreBuyerContribution(
    data: Record<string, CheckpointValue>,
  ): Promise<Readonly<FixedPriceAgreementSignatureContribution>> {
    const contribution = decode<FixedPriceAgreementSignatureContribution>(
      data.contributionJson,
      "persisted buyer agreement contribution",
    );
    if (
      !isHash(data.contributionHash) ||
      contribution.contributionHash !== data.contributionHash ||
      contribution.planHash !== this.#plan.planHash ||
      contribution.role !== "buyer" ||
      contribution.party !== this.#buyer
    ) {
      throw new DacsError("persisted buyer agreement contribution is rebound or malformed");
    }
    // Recreate through the pure exchange constructor to validate exact wire data.
    const recreated = await this.#contributionFromSignature(contribution.signature.value);
    if (!exact(recreated, contribution)) {
      throw new DacsError("persisted buyer agreement contribution is not canonical");
    }
    await this.#verifyOneContribution(contribution, "buyer-signature");
    return immutable(contribution);
  }

  async #createBuyerContribution(): Promise<void> {
    const intent = this.#signatureIntent();
    const claimed = await this.#claim(
      durableFixedPriceAgreementCheckpointKey.buyerSignature,
      intent,
      "agreement:buyer-signing",
    );
    if (claimed.state === "outcome") {
      this.#buyerContribution = await this.#restoreBuyerContribution(claimed.data);
      return;
    }
    const idempotencyKey = String(intent.idempotencyKey);
    let raw: Uint8Array | string;
    if (claimed.state === "intent") {
      let resolution: FixedPriceAgreementSignatureReconciliation;
      try {
        resolution = await this.#invokeFenced(idempotencyKey, (fence) =>
          this.#durability.reconcileBuyerSignature(
            {
              planHash: this.#plan.planHash,
              agreementHash: this.#plan.agreementHash,
              party: this.#buyer,
              algorithm: this.#input.buyer.algorithm,
              signedBytes: fixedPriceAgreementSignedBytes(this.#plan),
            },
            fence,
          )
        );
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          "buyer-signature",
          `buyer signature reconciliation failed: ${String(error)}`,
        );
      }
      if (resolution.disposition === "present") {
        raw = resolution.value;
      } else if (resolution.disposition === "absent") {
        try {
          raw = await this.#invokeFenced(idempotencyKey, (fence) =>
            this.#input.buyer.sign(
              fixedPriceAgreementSignedBytes(this.#plan),
              Object.freeze({
                party: this.#buyer,
                algorithm: this.#input.buyer.algorithm,
              }),
              fence,
            )
          );
          raw = captureSignatureValue(raw, "buyer signer output");
        } catch (error) {
          throw new ProgressSignal(
            "indeterminate",
            "buyer-signature",
            `buyer signature outcome is ambiguous: ${String(error)}`,
          );
        }
      } else {
        throw new ProgressSignal(
          resolution.disposition === "rejected" ? "rejected" : "indeterminate",
          "buyer-signature",
          resolution.reason,
        );
      }
    } else {
      try {
        raw = await this.#invokeFenced(idempotencyKey, (fence) =>
          this.#input.buyer.sign(
            fixedPriceAgreementSignedBytes(this.#plan),
            Object.freeze({
              party: this.#buyer,
              algorithm: this.#input.buyer.algorithm,
            }),
            fence,
          )
        );
        raw = captureSignatureValue(raw, "buyer signer output");
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          "buyer-signature",
          `buyer signature outcome is ambiguous: ${String(error)}`,
        );
      }
    }
    const contribution = await this.#contributionFromSignature(raw);
    await this.#verifyOneContribution(contribution, "buyer-signature");
    const outcome = {
      ...intent,
      contributionHash: contribution.contributionHash,
      contributionJson: encode(contribution, "buyer agreement contribution"),
    };
    await this.#complete(durableFixedPriceAgreementCheckpointKey.buyerSignature, outcome, {
      phase: "agreement:proposal-publication-pending",
    });
    this.#buyerContribution = immutable(contribution);
  }

  #createProposal(): Readonly<FixedPriceAgreementProposal> {
    if (!this.#buyerContribution) {
      throw new DacsError("buyer agreement contribution is unavailable");
    }
    const material = {
      proposalVersion: "1" as const,
      plan: this.#plan,
      buyerContribution: this.#buyerContribution,
    };
    return immutable(snapshotData({
      ...material,
      proposalHash: sha256Hex(canonicalize(material)),
    }, "fixed-price agreement proposal"));
  }

  #setProposal(proposal: Readonly<FixedPriceAgreementProposal>): void {
    if (!exactKeys(proposal as unknown as DataRecord, [
      "proposalVersion",
      "plan",
      "buyerContribution",
      "proposalHash",
    ]) || proposal.proposalVersion !== "1" || !isHash(proposal.proposalHash)) {
      throw new DacsError("fixed-price agreement proposal is malformed");
    }
    const expected = this.#createProposal();
    if (!exact(proposal, expected)) {
      throw new DacsError("fixed-price agreement proposal is substituted");
    }
    this.#proposal = expected;
    this.#identity = Object.freeze({
      jobId: this.#jobId,
      planHash: this.#plan.planHash,
      agreementHash: this.#plan.agreementHash,
      buyer: this.#buyer,
      seller: this.#seller,
      proposalHash: expected.proposalHash,
    });
  }

  #proposalIntent(): Record<string, CheckpointValue> {
    const proposal = this.#createProposal();
    return {
      ...this.#authorityData(),
      proposalHash: proposal.proposalHash,
      proposalJson: encode(proposal, "fixed-price agreement proposal"),
      idempotencyKey: this.#idempotencyKey("proposal-publication", {
        proposalHash: proposal.proposalHash,
      }),
    };
  }

  async #reconcileProposal(
    idempotencyKey: string,
  ): Promise<FixedPriceAgreementResolution<unknown>> {
    if (!this.#identity) throw new DacsError("agreement transport identity is unavailable");
    try {
      return await this.#invokeFenced(idempotencyKey, (fence) =>
        this.#durability.transport.reconcileProposalPublication(this.#identity!, fence)
      );
    } catch (error) {
      throw new ProgressSignal(
        "indeterminate",
        "proposal-publication",
        `proposal reconciliation failed: ${String(error)}`,
      );
    }
  }

  #authenticateProposalResolution(value: unknown): void {
    const captured = snapshotData(value, "published fixed-price agreement proposal");
    if (!this.#proposal || !exact(captured, this.#proposal)) {
      throw new ProgressSignal(
        "rejected",
        "proposal-publication",
        "published buyer proposal differs from the exact durable proposal",
      );
    }
  }

  async #publishProposal(): Promise<void> {
    const intent = this.#proposalIntent();
    const claimed = await this.#claim(
      durableFixedPriceAgreementCheckpointKey.proposal,
      intent,
      "agreement:proposal-publication-pending",
    );
    const persisted = decode<FixedPriceAgreementProposal>(
      claimed.data.proposalJson,
      "persisted fixed-price agreement proposal",
    );
    this.#setProposal(persisted);
    if (claimed.state === "outcome") {
      if (claimed.data.published !== true) {
        throw new DacsError("proposal publication outcome lacks exact publication proof");
      }
      return;
    }
    const idempotencyKey = String(intent.idempotencyKey);
    let resolution = await this.#reconcileProposal(idempotencyKey);
    if (resolution.disposition === "present") {
      this.#authenticateProposalResolution(resolution.value);
    } else if (resolution.disposition === "absent") {
      let submission: FixedPriceAgreementEffectSubmission;
      try {
        submission = await this.#invokeFenced(idempotencyKey, (fence) =>
          this.#durability.transport.publishProposal(
            this.#proposal!,
            this.#identity!,
            fence,
          )
        );
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          "proposal-publication",
          `proposal publication outcome is ambiguous: ${String(error)}`,
        );
      }
      if (submission.disposition !== "submitted") {
        throw new ProgressSignal(
          submission.disposition === "rejected" ? "rejected" : "indeterminate",
          "proposal-publication",
          submission.reason,
        );
      }
      resolution = await this.#reconcileProposal(idempotencyKey);
      if (resolution.disposition !== "present") {
        throw new ProgressSignal(
          resolution.disposition === "rejected" ? "rejected" : "indeterminate",
          "proposal-publication",
          resolution.disposition === "absent"
            ? "submitted proposal is not yet authoritatively observable"
            : resolution.reason,
        );
      }
      this.#authenticateProposalResolution(resolution.value);
    } else {
      throw new ProgressSignal(
        resolution.disposition === "rejected" ? "rejected" : "indeterminate",
        "proposal-publication",
        resolution.reason,
      );
    }
    await this.#complete(durableFixedPriceAgreementCheckpointKey.proposal, {
      ...intent,
      published: true,
    }, { phase: "agreement:awaiting-seller-contribution" });
  }

  async #finalizeContributions(
    sellerValues: unknown,
  ): Promise<{
    seller: Readonly<FixedPriceAgreementSignatureContribution>;
    agreement: Readonly<AgreementArtifact>;
  }> {
    const values = snapshotData(sellerValues, "seller agreement contributions");
    if (!Array.isArray(values)) {
      throw new ProgressSignal(
        "rejected",
        "seller-contribution",
        "seller contribution transport value must be an intrinsic array",
      );
    }
    if (values.length === 0) {
      throw new ProgressSignal(
        "waiting",
        "seller-contribution",
        "seller contribution is not yet available",
      );
    }
    if (values.length !== 1) {
      throw new ProgressSignal(
        "rejected",
        "seller-contribution",
        "seller contribution is duplicated",
      );
    }
    if (!this.#buyerContribution) {
      throw new DacsError("buyer contribution is unavailable for agreement assembly");
    }
    let verificationFailure:
      | { disposition: FixedPriceAgreementContributionVerificationDisposition; role: string }
      | undefined;
    const verify: FixedPriceAgreementContributionVerifier = async (
      input: Readonly<FixedPriceAgreementContributionVerificationInput>,
    ) => {
      let disposition: FixedPriceAgreementContributionVerificationDisposition;
      try {
        disposition = await this.#durability.verifyContribution(input);
      } catch {
        disposition = "error";
      }
      if (disposition !== "valid") {
        verificationFailure ??= { disposition, role: input.role };
      }
      return disposition;
    };
    let agreement: AgreementArtifact;
    try {
      agreement = await finalizeFixedPriceAgreementContributions(
        this.#plan,
        [this.#buyerContribution, values[0] as FixedPriceAgreementSignatureContribution],
        verify,
      );
    } catch (error) {
      if (verificationFailure) {
        throw new ProgressSignal(
          verificationFailure.disposition === "invalid" ? "rejected" : "indeterminate",
          "seller-contribution",
          `${verificationFailure.role} agreement signature verification was ` +
            verificationFailure.disposition,
        );
      }
      throw new ProgressSignal(
        "rejected",
        "seller-contribution",
        `seller agreement contribution failed exact verification: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const seller = snapshotData(values[0], "verified seller agreement contribution") as
      FixedPriceAgreementSignatureContribution;
    if (
      seller.role !== "seller" ||
      seller.party !== this.#seller ||
      seller.planHash !== this.#plan.planHash ||
      contentHash(agreement as unknown as DataRecord) !== this.#plan.agreementHash
    ) {
      throw new ProgressSignal(
        "rejected",
        "seller-contribution",
        "seller contribution or assembled agreement is rebound",
      );
    }
    return {
      seller: immutable(seller),
      agreement: immutable(snapshotData(agreement, "assembled fixed-price agreement")),
    };
  }

  #sellerIntent(): Record<string, CheckpointValue> {
    if (!this.#proposal) throw new DacsError("agreement proposal is unavailable");
    return {
      ...this.#authorityData(),
      proposalHash: this.#proposal.proposalHash,
    };
  }

  async #resolveSellerContribution(): Promise<void> {
    if (!this.#identity) throw new DacsError("agreement transport identity is unavailable");
    const intent = this.#sellerIntent();
    const claimed = await this.#claim(
      durableFixedPriceAgreementCheckpointKey.sellerContribution,
      intent,
      "agreement:awaiting-seller-contribution",
    );
    let sellerValues: unknown;
    if (claimed.state === "outcome") {
      sellerValues = [decode<FixedPriceAgreementSignatureContribution>(
        claimed.data.sellerContributionJson,
        "persisted seller agreement contribution",
      )];
    } else {
      let resolution: FixedPriceAgreementResolution<unknown>;
      try {
        resolution = await this.#durability.transport.resolveSellerContributions(
          clone(this.#identity),
        );
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          "seller-contribution",
          `seller contribution resolution failed: ${String(error)}`,
        );
      }
      if (resolution.disposition === "absent") {
        throw new ProgressSignal("waiting", "seller-contribution", resolution.reason);
      }
      if (resolution.disposition !== "present") {
        throw new ProgressSignal(
          resolution.disposition === "rejected" ? "rejected" : "indeterminate",
          "seller-contribution",
          resolution.reason,
        );
      }
      sellerValues = resolution.value;
    }
    const finalized = await this.#finalizeContributions(sellerValues);
    if (claimed.state !== "outcome") {
      await this.#complete(durableFixedPriceAgreementCheckpointKey.sellerContribution, {
        ...intent,
        sellerContributionHash: finalized.seller.contributionHash,
        sellerContributionJson: encode(
          finalized.seller,
          "seller agreement contribution",
        ),
        agreementJson: encode(finalized.agreement, "fixed-price agreement artifact"),
      }, { phase: "agreement:anchor-pending" });
    } else {
      if (claimed.data.sellerContributionHash !== finalized.seller.contributionHash) {
        throw new DacsError("persisted seller contribution hash is inconsistent");
      }
      const persistedAgreement = decode<AgreementArtifact>(
        claimed.data.agreementJson,
        "persisted fixed-price agreement artifact",
      );
      if (!exact(persistedAgreement, finalized.agreement)) {
        throw new DacsError("persisted fixed-price agreement differs from verified contributions");
      }
    }
    this.#sellerContribution = finalized.seller;
    this.#agreement = finalized.agreement;
  }

  #anchorIntent(): Record<string, CheckpointValue> {
    if (!this.#agreement) throw new DacsError("fixed-price agreement is unavailable");
    const artifactJson = encode(this.#agreement, "agreement anchor artifact");
    const artifactBytesHash = sha256Hex(artifactJson);
    return {
      ...this.#authorityData(),
      artifactBytesHash,
      artifactJson,
      idempotencyKey: this.#idempotencyKey("artifact-anchor", {
        artifactBytesHash,
      }),
    };
  }

  async #authenticateReadback(
    value: unknown,
  ): Promise<Readonly<AnchoredFixedPriceAgreementReadback>> {
    const captured = snapshotData(value, "anchored fixed-price agreement readback") as unknown;
    if (
      !isRecord(captured) ||
      !exactKeys(captured, ["artifact", "ref", "anchorReceipt"]) ||
      !isAgreementArtifact(captured.artifact) ||
      !isAttestationRef(captured.ref) ||
      !isAnchorReceipt(captured.anchorReceipt)
    ) {
      throw new ProgressSignal(
        "rejected",
        "agreement-anchor",
        "agreement anchor readback is not normative",
      );
    }
    if (!this.#agreement || !exact(captured.artifact, this.#agreement)) {
      throw new ProgressSignal(
        "rejected",
        "agreement-anchor",
        "agreement anchor readback contains substituted artifact bytes",
      );
    }
    const ref = captured.ref;
    const receipt = captured.anchorReceipt;
    if (
      ref.anchor.kind !== "storage-program" ||
      ref.anchor.locator !== this.#logicalAddress ||
      ref.contentHash !== this.#plan.agreementHash ||
      (ref.signer !== undefined && ref.signer !== this.#buyer) ||
      receipt.logicalAddress !== this.#logicalAddress ||
      receipt.contentHash !== this.#plan.agreementHash ||
      receipt.writer !== this.#buyer ||
      receipt.observationDisposition !== "established" ||
      (receipt.state !== "included" && receipt.state !== "finalized") ||
      !isNonEmpty(receipt.nativeAddress)
    ) {
      throw new ProgressSignal(
        "rejected",
        "agreement-anchor",
        "agreement anchor receipt/readback is rebound or non-final",
      );
    }
    let verification: FixedPriceAgreementAnchorVerificationDisposition;
    try {
      verification = await this.#durability.anchor.verifyAnchorReceipt({
        expectedWriter: this.#buyer,
        ref: clone(ref),
        receipt: clone(receipt),
      });
    } catch (error) {
      throw new ProgressSignal(
        "indeterminate",
        "agreement-anchor",
        `agreement anchor receipt authentication failed: ${String(error)}`,
      );
    }
    if (verification !== "valid") {
      throw new ProgressSignal(
        verification === "invalid" ? "rejected" : "indeterminate",
        "agreement-anchor",
        `agreement anchor receipt authentication was ${verification}`,
      );
    }
    return immutable(captured as unknown as AnchoredFixedPriceAgreementReadback);
  }

  async #reconcileAnchor(
    idempotencyKey: string,
  ): Promise<FixedPriceAgreementResolution<unknown>> {
    try {
      return await this.#invokeFenced(idempotencyKey, (fence) =>
        this.#durability.anchor.reconcileAgreementAnchor(
          {
            logicalAddress: this.#logicalAddress,
            agreementHash: this.#plan.agreementHash,
          },
          fence,
        )
      );
    } catch (error) {
      throw new ProgressSignal(
        "indeterminate",
        "agreement-anchor",
        `agreement anchor reconciliation failed: ${String(error)}`,
      );
    }
  }

  async #restoreAnchorOutcome(
    data: Record<string, CheckpointValue>,
  ): Promise<Readonly<AnchoredFixedPriceAgreementReadback>> {
    const readback = decode<AnchoredFixedPriceAgreementReadback>(
      data.readbackJson,
      "persisted agreement anchor readback",
    );
    const authenticated = await this.#authenticateReadback(readback);
    if (
      data.nativeAddress !== authenticated.anchorReceipt.nativeAddress ||
      data.receiptHash !== sha256Hex(encode(authenticated.anchorReceipt, "anchor receipt"))
    ) {
      throw new DacsError("persisted agreement anchor outcome is internally inconsistent");
    }
    return authenticated;
  }

  async #anchorAgreement(): Promise<void> {
    const intent = this.#anchorIntent();
    const claimed = await this.#claim(
      durableFixedPriceAgreementCheckpointKey.anchor,
      intent,
      "agreement:anchor-pending",
    );
    if (claimed.state === "outcome") {
      this.#readback = await this.#restoreAnchorOutcome(claimed.data);
      const receipt = claimed.record.receipts.find(
        (value) => sessionReceiptKey(value) === "agreement",
      );
      if (!receipt || receipt.ref !== this.#readback.anchorReceipt.nativeAddress) {
        throw new DacsError("durable agreement anchor outcome lacks its immutable receipt");
      }
      return;
    }
    const idempotencyKey = String(intent.idempotencyKey);
    let resolution = await this.#reconcileAnchor(idempotencyKey);
    let readback: Readonly<AnchoredFixedPriceAgreementReadback>;
    if (resolution.disposition === "present") {
      readback = await this.#authenticateReadback(resolution.value);
    } else if (resolution.disposition === "absent") {
      let submission: FixedPriceAgreementEffectSubmission;
      try {
        submission = await this.#invokeFenced(idempotencyKey, (fence) =>
          this.#durability.anchor.anchorAgreement(
            {
              logicalAddress: this.#logicalAddress,
              agreementHash: this.#plan.agreementHash,
              artifact: this.#agreement!,
            },
            fence,
          )
        );
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          "agreement-anchor",
          `agreement anchor outcome is ambiguous: ${String(error)}`,
        );
      }
      if (submission.disposition !== "submitted") {
        throw new ProgressSignal(
          submission.disposition === "rejected" ? "rejected" : "indeterminate",
          "agreement-anchor",
          submission.reason,
        );
      }
      resolution = await this.#reconcileAnchor(idempotencyKey);
      if (resolution.disposition !== "present") {
        throw new ProgressSignal(
          resolution.disposition === "rejected" ? "rejected" : "indeterminate",
          "agreement-anchor",
          resolution.disposition === "absent"
            ? "submitted agreement anchor is not yet authoritatively observable"
            : resolution.reason,
        );
      }
      readback = await this.#authenticateReadback(resolution.value);
    } else {
      throw new ProgressSignal(
        resolution.disposition === "rejected" ? "rejected" : "indeterminate",
        "agreement-anchor",
        resolution.reason,
      );
    }
    const outcome = {
      ...intent,
      nativeAddress: readback.anchorReceipt.nativeAddress,
      receiptHash: sha256Hex(encode(readback.anchorReceipt, "agreement anchor receipt")),
      readbackJson: encode(readback, "agreement anchor readback"),
    };
    await this.#complete(durableFixedPriceAgreementCheckpointKey.anchor, outcome, {
      phase: this.#durability.anchor.publishBinding
        ? "agreement:binding-publication-pending"
        : "agreement:finalizing",
      receipt: { kind: "agreement", ref: readback.anchorReceipt.nativeAddress },
    });
    this.#readback = readback;
  }

  #expectedBinding(): Readonly<AnchorBinding> {
    if (!this.#readback) throw new DacsError("agreement anchor readback is unavailable");
    return immutable({
      logicalAddress: this.#logicalAddress,
      nativeAddress: this.#readback.anchorReceipt.nativeAddress,
      owner: this.#buyer,
      contentHash: this.#plan.agreementHash,
    });
  }

  #bindingIntent(binding: Readonly<AnchorBinding>): Record<string, CheckpointValue> {
    const bindingJson = encode(binding, "agreement logical-to-native binding");
    const bindingHash = sha256Hex(bindingJson);
    return {
      ...this.#authorityData(),
      bindingHash,
      bindingJson,
      idempotencyKey: this.#idempotencyKey("binding-publication", { bindingHash }),
    };
  }

  async #reconcileBinding(
    binding: Readonly<AnchorBinding>,
    idempotencyKey: string,
  ): Promise<FixedPriceAgreementResolution<unknown>> {
    const reconcile = this.#durability.anchor.reconcileBindingPublication;
    if (!reconcile) throw new DacsError("agreement binding reconciliation is unavailable");
    try {
      return await this.#invokeFenced(idempotencyKey, (fence) =>
        reconcile(binding, fence)
      );
    } catch (error) {
      throw new ProgressSignal(
        "indeterminate",
        "agreement-binding",
        `agreement binding reconciliation failed: ${String(error)}`,
      );
    }
  }

  #authenticateBinding(value: unknown, expected: Readonly<AnchorBinding>): void {
    const captured = snapshotData(value, "published agreement binding");
    if (!exact(captured, expected)) {
      throw new ProgressSignal(
        "rejected",
        "agreement-binding",
        "published agreement binding is substituted",
      );
    }
  }

  async #publishBinding(): Promise<void> {
    if (!this.#durability.anchor.publishBinding) return;
    const binding = this.#expectedBinding();
    const intent = this.#bindingIntent(binding);
    const claimed = await this.#claim(
      durableFixedPriceAgreementCheckpointKey.binding,
      intent,
      "agreement:binding-publication-pending",
    );
    const persisted = decode<AnchorBinding>(
      claimed.data.bindingJson,
      "persisted agreement binding",
    );
    if (!exact(persisted, binding)) {
      throw new DacsError("persisted agreement binding differs from authenticated anchor");
    }
    if (claimed.state === "outcome") {
      if (claimed.data.published !== true) {
        throw new DacsError("agreement binding outcome lacks exact publication proof");
      }
      this.#binding = binding;
      return;
    }
    const idempotencyKey = String(intent.idempotencyKey);
    let resolution = await this.#reconcileBinding(binding, idempotencyKey);
    if (resolution.disposition === "present") {
      this.#authenticateBinding(resolution.value, binding);
    } else if (resolution.disposition === "absent") {
      const publish = this.#durability.anchor.publishBinding;
      let submission: FixedPriceAgreementEffectSubmission;
      try {
        submission = await this.#invokeFenced(idempotencyKey, (fence) =>
          publish(binding, fence)
        );
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          "agreement-binding",
          `agreement binding publication outcome is ambiguous: ${String(error)}`,
        );
      }
      if (submission.disposition !== "submitted") {
        throw new ProgressSignal(
          submission.disposition === "rejected" ? "rejected" : "indeterminate",
          "agreement-binding",
          submission.reason,
        );
      }
      resolution = await this.#reconcileBinding(binding, idempotencyKey);
      if (resolution.disposition !== "present") {
        throw new ProgressSignal(
          resolution.disposition === "rejected" ? "rejected" : "indeterminate",
          "agreement-binding",
          resolution.disposition === "absent"
            ? "submitted agreement binding is not yet authoritatively observable"
            : resolution.reason,
        );
      }
      this.#authenticateBinding(resolution.value, binding);
    } else {
      throw new ProgressSignal(
        resolution.disposition === "rejected" ? "rejected" : "indeterminate",
        "agreement-binding",
        resolution.reason,
      );
    }
    await this.#complete(durableFixedPriceAgreementCheckpointKey.binding, {
      ...intent,
      published: true,
    }, { phase: "agreement:finalizing" });
    this.#binding = binding;
  }

  #result(): Readonly<DurableAnchoredFixedPriceAgreement> {
    if (!this.#agreement || !this.#readback) {
      throw new DacsError("authenticated agreement result is unavailable");
    }
    return immutable({
      agreement: this.#agreement,
      agreementHash: this.#plan.agreementHash,
      agreementRef: this.#readback.ref,
      anchorReceipt: this.#readback.anchorReceipt,
      ...(this.#binding ? { binding: this.#binding } : {}),
    });
  }

  #resultIntent(result: Readonly<DurableAnchoredFixedPriceAgreement>):
    Record<string, CheckpointValue> {
    const resultJson = encode(result, "durable fixed-price agreement result");
    return {
      ...this.#authorityData(),
      resultHash: sha256Hex(resultJson),
      resultJson,
    };
  }

  async #finish(): Promise<Readonly<DurableAnchoredFixedPriceAgreement>> {
    const result = this.#result();
    const intent = this.#resultIntent(result);
    const claimed = await this.#claim(
      durableFixedPriceAgreementCheckpointKey.result,
      intent,
      "agreement:finalizing",
    );
    const persisted = decode<DurableAnchoredFixedPriceAgreement>(
      claimed.data.resultJson,
      "persisted durable agreement result",
    );
    if (!exact(persisted, result)) {
      throw new DacsError("durable agreement result checkpoint is substituted");
    }
    if (claimed.state !== "outcome") {
      await this.#complete(durableFixedPriceAgreementCheckpointKey.result, intent, {
        phase: "agreement:anchored",
        release: true,
      });
    } else {
      await this.#release();
    }
    return result;
  }

  #requireOutcome(record: SessionRecord, key: string): Record<string, CheckpointValue> {
    const checkpoint = latestCheckpoint(record.checkpoints, key);
    if (checkpoint?.stage !== "outcome" || !checkpoint.data) {
      throw new DacsError(`durable agreement terminal state lacks ${key} outcome`);
    }
    return clone(checkpoint.data);
  }

  async #recoverTerminal(record: SessionRecord):
    Promise<Readonly<DurableAnchoredFixedPriceAgreement>> {
    const planData = this.#requireOutcome(
      record,
      durableFixedPriceAgreementCheckpointKey.plan,
    );
    const persistedPlan = decode<FixedPriceAgreementSigningPlan>(
      planData.planJson,
      "terminal fixed-price agreement plan",
    );
    fixedPriceAgreementSignedBytes(persistedPlan);
    if (!exact(persistedPlan, this.#plan) || !this.#dataContains(planData, this.#planData())) {
      throw new DacsError("terminal agreement plan differs from the requested exact plan");
    }

    const signatureData = this.#requireOutcome(
      record,
      durableFixedPriceAgreementCheckpointKey.buyerSignature,
    );
    if (!this.#dataContains(signatureData, this.#signatureIntent())) {
      throw new DacsError("terminal buyer signature authority is substituted");
    }
    this.#buyerContribution = await this.#restoreBuyerContribution(signatureData);

    const proposalData = this.#requireOutcome(
      record,
      durableFixedPriceAgreementCheckpointKey.proposal,
    );
    const proposal = decode<FixedPriceAgreementProposal>(
      proposalData.proposalJson,
      "terminal fixed-price agreement proposal",
    );
    this.#setProposal(proposal);
    if (!this.#dataContains(proposalData, this.#proposalIntent()) || proposalData.published !== true) {
      throw new DacsError("terminal proposal publication authority is substituted");
    }

    const sellerData = this.#requireOutcome(
      record,
      durableFixedPriceAgreementCheckpointKey.sellerContribution,
    );
    if (!this.#dataContains(sellerData, this.#sellerIntent())) {
      throw new DacsError("terminal seller contribution authority is substituted");
    }
    const seller = decode<FixedPriceAgreementSignatureContribution>(
      sellerData.sellerContributionJson,
      "terminal seller agreement contribution",
    );
    const finalized = await this.#finalizeContributions([seller]);
    if (sellerData.sellerContributionHash !== finalized.seller.contributionHash) {
      throw new DacsError("terminal seller contribution hash is inconsistent");
    }
    const persistedAgreement = decode<AgreementArtifact>(
      sellerData.agreementJson,
      "terminal fixed-price agreement artifact",
    );
    if (!exact(finalized.agreement, persistedAgreement)) {
      throw new DacsError("terminal fixed-price agreement bytes are substituted");
    }
    this.#sellerContribution = finalized.seller;
    this.#agreement = finalized.agreement;

    const anchorData = this.#requireOutcome(
      record,
      durableFixedPriceAgreementCheckpointKey.anchor,
    );
    if (!this.#dataContains(anchorData, this.#anchorIntent())) {
      throw new DacsError("terminal agreement anchor authority is substituted");
    }
    this.#readback = await this.#restoreAnchorOutcome(anchorData);
    const receipt = record.receipts.find((value) => sessionReceiptKey(value) === "agreement");
    if (!receipt || receipt.ref !== this.#readback.anchorReceipt.nativeAddress) {
      throw new DacsError("terminal agreement result lacks its immutable anchor receipt");
    }

    if (this.#durability.anchor.publishBinding) {
      const binding = this.#expectedBinding();
      const bindingData = this.#requireOutcome(
        record,
        durableFixedPriceAgreementCheckpointKey.binding,
      );
      if (!this.#dataContains(bindingData, this.#bindingIntent(binding)) ||
          bindingData.published !== true) {
        throw new DacsError("terminal agreement binding authority is substituted");
      }
      const persistedBinding = decode<AnchorBinding>(
        bindingData.bindingJson,
        "terminal agreement binding",
      );
      if (!exact(persistedBinding, binding)) {
        throw new DacsError("terminal agreement binding is substituted");
      }
      this.#binding = binding;
    } else if (
      latestCheckpoint(record.checkpoints, durableFixedPriceAgreementCheckpointKey.binding)
    ) {
      throw new DacsError(
        "terminal agreement includes binding state but no binding provider was configured",
      );
    }

    const expected = this.#result();
    const resultData = this.#requireOutcome(
      record,
      durableFixedPriceAgreementCheckpointKey.result,
    );
    if (!this.#dataContains(resultData, this.#resultIntent(expected))) {
      throw new DacsError("terminal durable agreement result authority is substituted");
    }
    const persistedResult = decode<DurableAnchoredFixedPriceAgreement>(
      resultData.resultJson,
      "terminal durable agreement result",
    );
    if (!exact(persistedResult, expected)) {
      throw new DacsError("terminal durable agreement result differs from authenticated readback");
    }
    return expected;
  }

  async run(): Promise<DurableFixedPriceAgreementProgress> {
    let record = await this.#ensureState();
    const result = latestCheckpoint(
      record.checkpoints,
      durableFixedPriceAgreementCheckpointKey.result,
    );
    if (record.phase === "agreement:anchored" && result?.stage !== "outcome") {
      throw new DacsError("durable agreement terminal phase/checkpoint is incomplete");
    }
    if (result?.stage === "outcome") {
      try {
        return {
          disposition: "anchored",
          result: await this.#recoverTerminal(record),
          recovered: true,
        };
      } catch (error) {
        const progress = retainedProgressSignal(error);
        if (progress) return progress.progress;
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
    await this.#acquire();
    await this.#bindPlan();
    await this.#createBuyerContribution();
    await this.#publishProposal();
    await this.#resolveSellerContribution();
    await this.#anchorAgreement();
    await this.#publishBinding();
    const anchored = await this.#finish();
    return { disposition: "anchored", result: anchored, recovered: false };
  }

  async release(): Promise<void> {
    await this.#release();
  }
}

/**
 * Advance the buyer-owned durable agreement exchange as far as authenticated
 * transport and substrate state allow. This API accepts no seller signer.
 */
export async function advanceFixedPriceAgreementDurable(
  input: DurableFixedPriceAgreementInput,
  durability: DurableFixedPriceAgreementDurability,
): Promise<DurableFixedPriceAgreementProgress> {
  const coordinator = new DurableFixedPriceAgreementCoordinator(
    captureInput(input),
    captureDurability(durability),
  );
  try {
    return await coordinator.run();
  } catch (error) {
    await coordinator.release();
    const progress = retainedProgressSignal(error);
    if (progress) return progress.progress;
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
