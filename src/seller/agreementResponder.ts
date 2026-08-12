import { types as nodeTypes } from "node:util";

import type {
  ComponentSignatureAlgorithm,
  ListingPin,
} from "../artifacts/types.js";
import {
  FENCED_SESSION_STORE_VERSION,
  sessionRecordShapeViolation,
  type CheckpointValue,
  type FencedSessionStoreV2,
  type SessionCheckpoint,
  type SessionLeaseToken,
  type SessionRecord,
} from "../agent/fencedSessionStore.js";
import { canonicalize, sha256Hex } from "../canonical/index.js";
import { DacsError, SubstrateError } from "../errors.js";
import {
  deriveFixedPriceAgreement,
  type AgreementSigner,
  type FixedPriceAgreementInput,
  type UnsignedAgreementArtifact,
} from "../negotiate/fixedPrice.js";
import {
  createFixedPriceAgreementSignatureContribution,
  createFixedPriceAgreementSigningPlan,
  fixedPriceAgreementSignedBytes,
  type FixedPriceAgreementContributionVerifier,
  type FixedPriceAgreementSignatureContribution,
  type FixedPriceAgreementSigningPlan,
} from "../negotiate/fixedPriceExchange.js";
import type {
  FixedPriceAgreementEffectFence,
  FixedPriceAgreementEffectSubmission,
  FixedPriceAgreementProposal,
  FixedPriceAgreementResolution,
  FixedPriceAgreementSignatureReconciliation,
  FixedPriceAgreementTransportIdentity,
} from "../negotiate/durableFixedPriceExchange.js";

const MAX_CAS_ATTEMPTS = 16;
const MAX_RELEASE_ATTEMPTS = 8;
const INERT_RECEIVER = Object.freeze(Object.create(null)) as object;

export type SellerFixedPriceAgreementEffectFence = FixedPriceAgreementEffectFence;

export type DurableSellerFixedPriceAgreementSigner = (
  bytes: Uint8Array,
  context: Readonly<{
    party: string;
    algorithm: ComponentSignatureAlgorithm;
  }>,
  fence: Readonly<SellerFixedPriceAgreementEffectFence>,
) => Promise<Uint8Array | string> | Uint8Array | string;

/** Exact transport request accepted by the seller-owned responder. */
export interface DurableSellerFixedPriceAgreementInput {
  proposal: Readonly<FixedPriceAgreementProposal>;
  transportIdentity: Readonly<FixedPriceAgreementTransportIdentity>;
  /** Local authority only. This callback is never exposed through the transport request. */
  seller: {
    party: string;
    algorithm: ComponentSignatureAlgorithm;
    sign: DurableSellerFixedPriceAgreementSigner;
  };
}

/**
 * Lookup key for seller-local policy and authenticated artifacts. The Listing
 * pin is only a query key: a resolver must authenticate the returned Listing,
 * identity bundles, Vet refs, rail, payout, and policy independently.
 */
export interface SellerFixedPriceAgreementContextQuery {
  queryVersion: "1";
  jobId: string;
  listingPin: Readonly<ListingPin>;
  /** Untrusted candidate terms supplied only so local policy can validate rail, payout, and time. */
  candidateDraft: Readonly<UnsignedAgreementArtifact>;
  planHash: string;
  agreementHash: string;
  proposalHash: string;
  buyer: string;
  seller: string;
}

export type SellerFixedPriceAgreementContextResolution =
  FixedPriceAgreementResolution<Readonly<FixedPriceAgreementInput>>;

export interface SellerFixedPriceAgreementSignatureReconciliationInput {
  transportIdentity: Readonly<FixedPriceAgreementTransportIdentity>;
  planHash: string;
  agreementHash: string;
  party: string;
  algorithm: ComponentSignatureAlgorithm;
  signedBytes: Uint8Array;
}

export interface SellerFixedPriceAgreementContributionTransport {
  publishSellerContribution: (
    contribution: Readonly<FixedPriceAgreementSignatureContribution>,
    identity: Readonly<FixedPriceAgreementTransportIdentity>,
    fence: Readonly<SellerFixedPriceAgreementEffectFence>,
  ) => Promise<FixedPriceAgreementEffectSubmission> | FixedPriceAgreementEffectSubmission;
  reconcileSellerContributionPublication: (
    identity: Readonly<FixedPriceAgreementTransportIdentity>,
    fence: Readonly<SellerFixedPriceAgreementEffectFence>,
  ) => Promise<FixedPriceAgreementResolution<unknown>> | FixedPriceAgreementResolution<unknown>;
}

export interface DurableSellerFixedPriceAgreementDurability {
  store: FencedSessionStoreV2;
  workerId: string;
  leaseTtlMs: number;
  leaseNowMs?: () => number;
  /**
   * Resolve seller-local authenticated inputs. A `present` result asserts that
   * Listing signature/validity/revocation, identities, Vet refs, rail snapshot,
   * payout policy, and generatedAt were authenticated independently.
   */
  resolveAuthenticatedAgreementContext: (
    query: Readonly<SellerFixedPriceAgreementContextQuery>,
  ) =>
    | Promise<SellerFixedPriceAgreementContextResolution>
    | SellerFixedPriceAgreementContextResolution;
  verifyContribution: FixedPriceAgreementContributionVerifier;
  reconcileSellerSignature: (
    input: Readonly<SellerFixedPriceAgreementSignatureReconciliationInput>,
    fence: Readonly<SellerFixedPriceAgreementEffectFence>,
  ) =>
    | Promise<FixedPriceAgreementSignatureReconciliation>
    | FixedPriceAgreementSignatureReconciliation;
  transport: SellerFixedPriceAgreementContributionTransport;
}

export interface DurableSellerFixedPriceAgreementResponse {
  responseVersion: "1";
  transportIdentity: Readonly<FixedPriceAgreementTransportIdentity>;
  sellerContribution: Readonly<FixedPriceAgreementSignatureContribution>;
}

export type DurableSellerFixedPriceAgreementStage =
  | "proposal"
  | "context"
  | "buyer-contribution"
  | "lease"
  | "seller-signature"
  | "contribution-publication"
  | "terminal-recovery";

export type DurableSellerFixedPriceAgreementProgress =
  | {
      disposition: "complete";
      result: Readonly<DurableSellerFixedPriceAgreementResponse>;
      recovered: boolean;
    }
  | {
      disposition: "waiting" | "rejected" | "indeterminate";
      stage: DurableSellerFixedPriceAgreementStage;
      reason: string;
    };

export const durableSellerFixedPriceAgreementCheckpointKey = Object.freeze({
  proposal: "agreement-responder:proposal-binding",
  sellerSignature: "agreement-responder:seller-signature",
  publication: "agreement-responder:contribution-publication",
  result: "agreement-responder:durable-result",
} as const);

const AGREEMENT_RESPONDER_PHASE_RANK = new Map<string, number>([
  ["agreement-responder:proposal-binding", 0],
  ["agreement-responder:seller-signing", 1],
  ["agreement-responder:contribution-publication-pending", 2],
  ["agreement-responder:finalizing", 3],
  ["agreement-responder:complete", 4],
]);

type DataRecord = Record<string, unknown>;
type DescriptorMap = Record<PropertyKey, PropertyDescriptor>;

const isRecord = (value: unknown): value is DataRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.trim() === value &&
  value.normalize("NFC") === value;

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
      if (Reflect.ownKeys(value).some((key) => !expected.has(key)) ||
          Reflect.ownKeys(value).length !== expected.size) {
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
      Object.defineProperty(out, key, {
        value: snapshotDataValue(descriptor.value, `${subject}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
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

const clone = <T>(value: T): T => structuredClone(value);

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
  const map = Object.getOwnPropertyDescriptors(value) as DescriptorMap;
  for (const key of Reflect.ownKeys(map)) {
    const descriptor = map[key];
    if (typeof key !== "string" || !descriptor || !("value" in descriptor) ||
        descriptor.enumerable !== true) {
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
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(map, key)) ||
      keys.some((key) => !allowed.has(key))) {
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

function captureStore(value: unknown): FencedSessionStoreV2 {
  const subject = "seller agreement durability store";
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
    throw new TypeError("seller agreement durability requires FencedSessionStoreV2");
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

function captureInput(value: unknown): DurableSellerFixedPriceAgreementInput {
  const subject = "durable seller agreement input";
  const map = exactDescriptors(value, subject, ["proposal", "transportIdentity", "seller"]);
  const sellerSubject = `${subject}.seller`;
  const sellerMap = exactDescriptors(
    dataProperty(map, "seller", subject),
    sellerSubject,
    ["party", "algorithm", "sign"],
  );
  const party = dataProperty<unknown>(sellerMap, "party", sellerSubject);
  const algorithm = dataProperty<unknown>(sellerMap, "algorithm", sellerSubject);
  if (!isNonEmpty(party)) throw new TypeError("seller party must be canonical and non-empty");
  if (algorithm !== "ed25519" && algorithm !== "ecdsa-secp256k1" &&
      algorithm !== "sr1-aggregate") {
    throw new TypeError("seller algorithm is not a supported component signature algorithm");
  }
  return Object.freeze({
    proposal: immutable(snapshotData(
      dataProperty(map, "proposal", subject),
      "seller agreement proposal",
    )),
    transportIdentity: immutable(snapshotData(
      dataProperty(map, "transportIdentity", subject),
      "seller agreement transport identity",
    )),
    seller: Object.freeze({
      party,
      algorithm,
      sign: callback<DurableSellerFixedPriceAgreementSigner>(sellerMap, "sign", sellerSubject),
    }),
  }) as DurableSellerFixedPriceAgreementInput;
}

function captureDurability(value: unknown): DurableSellerFixedPriceAgreementDurability {
  const subject = "durable seller agreement dependencies";
  const map = exactDescriptors(value, subject, [
    "store",
    "workerId",
    "leaseTtlMs",
    "resolveAuthenticatedAgreementContext",
    "verifyContribution",
    "reconcileSellerSignature",
    "transport",
  ], ["leaseNowMs"]);
  const workerId = dataProperty<unknown>(map, "workerId", subject);
  const leaseTtlMs = dataProperty<unknown>(map, "leaseTtlMs", subject);
  if (!isNonEmpty(workerId) || !Number.isSafeInteger(leaseTtlMs) ||
      (leaseTtlMs as number) <= 0) {
    throw new TypeError("seller agreement durability requires workerId and positive leaseTtlMs");
  }
  const leaseNowMsValue = optionalProperty<unknown>(map, "leaseNowMs");
  const transportSubject = `${subject}.transport`;
  const transportMap = exactDescriptors(
    dataProperty(map, "transport", subject),
    transportSubject,
    ["publishSellerContribution", "reconcileSellerContributionPublication"],
  );
  return Object.freeze({
    store: captureStore(dataProperty(map, "store", subject)),
    workerId,
    leaseTtlMs: leaseTtlMs as number,
    ...(leaseNowMsValue === undefined
      ? {}
      : { leaseNowMs: inertFunction<() => number>(leaseNowMsValue, `${subject}.leaseNowMs`) }),
    resolveAuthenticatedAgreementContext:
      callback<DurableSellerFixedPriceAgreementDurability["resolveAuthenticatedAgreementContext"]>(
        map,
        "resolveAuthenticatedAgreementContext",
        subject,
      ),
    verifyContribution:
      callback<FixedPriceAgreementContributionVerifier>(map, "verifyContribution", subject),
    reconcileSellerSignature:
      callback<DurableSellerFixedPriceAgreementDurability["reconcileSellerSignature"]>(
        map,
        "reconcileSellerSignature",
        subject,
      ),
    transport: Object.freeze({
      publishSellerContribution:
        callback<SellerFixedPriceAgreementContributionTransport["publishSellerContribution"]>(
          transportMap,
          "publishSellerContribution",
          transportSubject,
        ),
      reconcileSellerContributionPublication:
        callback<SellerFixedPriceAgreementContributionTransport["reconcileSellerContributionPublication"]>(
          transportMap,
          "reconcileSellerContributionPublication",
          transportSubject,
        ),
    }),
  });
}

function captureResolution<T>(
  value: unknown,
  subject: string,
  capturePresent: (present: unknown) => T,
): FixedPriceAgreementResolution<T> {
  const map = exactDescriptors(value, subject, ["disposition"], ["value", "reason"]);
  const disposition = dataProperty<unknown>(map, "disposition", subject);
  const hasValue = Object.prototype.hasOwnProperty.call(map, "value");
  const hasReason = Object.prototype.hasOwnProperty.call(map, "reason");
  if (disposition === "present") {
    if (!hasValue || hasReason) throw new TypeError(`${subject} present result is malformed`);
    return { disposition, value: capturePresent(dataProperty(map, "value", subject)) };
  }
  if ((disposition !== "absent" && disposition !== "rejected" &&
      disposition !== "indeterminate") || hasValue || !hasReason) {
    throw new TypeError(`${subject} is malformed`);
  }
  const reason = dataProperty<unknown>(map, "reason", subject);
  if (!isNonEmpty(reason)) throw new TypeError(`${subject} reason is invalid`);
  return { disposition, reason };
}

function captureSignatureValue(value: unknown, subject: string): Uint8Array | string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array && !nodeTypes.isProxy(value) &&
      (Object.getPrototypeOf(value) === Uint8Array.prototype || Buffer.isBuffer(value))) {
    return Uint8Array.from(value);
  }
  throw new TypeError(`${subject} must be a string or intrinsic Uint8Array`);
}

function captureSignatureResolution(value: unknown): FixedPriceAgreementSignatureReconciliation {
  return captureResolution(
    value,
    "seller signature reconciliation",
    (present) => captureSignatureValue(present, "reconciled seller signature"),
  );
}

function captureSubmission(value: unknown, subject: string): FixedPriceAgreementEffectSubmission {
  const map = exactDescriptors(value, subject, ["disposition"], ["reason"]);
  const disposition = dataProperty<unknown>(map, "disposition", subject);
  const hasReason = Object.prototype.hasOwnProperty.call(map, "reason");
  if (disposition === "submitted") {
    if (hasReason) throw new TypeError(`${subject} submitted result cannot carry a reason`);
    return { disposition };
  }
  if ((disposition !== "rejected" && disposition !== "indeterminate") || !hasReason) {
    throw new TypeError(`${subject} is malformed`);
  }
  const reason = dataProperty<unknown>(map, "reason", subject);
  if (!isNonEmpty(reason)) throw new TypeError(`${subject} reason is invalid`);
  return { disposition, reason };
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
        ? `seller agreement state uses unsupported store version ${loaded.version}`
        : loaded.status === "corrupt"
          ? `seller agreement state is corrupt: ${loaded.reason}`
          : "seller agreement state is missing",
    );
  }
  const record = clone(loaded.record);
  const violation = sessionRecordShapeViolation(record);
  if (violation) throw new SubstrateError(`seller agreement state is corrupt: ${violation}`);
  return record;
}

class ProgressSignal extends Error {
  readonly progress: Exclude<
    DurableSellerFixedPriceAgreementProgress,
    { disposition: "complete" }
  >;

  constructor(
    disposition: "waiting" | "rejected" | "indeterminate",
    stage: DurableSellerFixedPriceAgreementStage,
    reason: string,
  ) {
    super(reason);
    this.name = "SellerFixedPriceAgreementProgressSignal";
    this.progress = { disposition, stage, reason };
  }
}

function retainedProgressSignal(error: unknown): ProgressSignal | undefined {
  let cursor: unknown = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth < 8 && cursor !== undefined; depth += 1) {
    if (cursor instanceof ProgressSignal) return cursor;
    if (cursor === null || (typeof cursor !== "object" && typeof cursor !== "function") ||
        visited.has(cursor)) return undefined;
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

interface AuthenticatedSellerAgreementRequest {
  input: DurableSellerFixedPriceAgreementInput;
  plan: Readonly<FixedPriceAgreementSigningPlan>;
  context: Readonly<FixedPriceAgreementInput>;
  contextHash: string;
  buyerContribution: Readonly<FixedPriceAgreementSignatureContribution>;
  query: Readonly<SellerFixedPriceAgreementContextQuery>;
}

function validateProposalEnvelope(
  input: DurableSellerFixedPriceAgreementInput,
): Readonly<FixedPriceAgreementSigningPlan> {
  const proposal = input.proposal;
  if (!isRecord(proposal) || !exactKeys(proposal as unknown as DataRecord, [
    "proposalVersion",
    "plan",
    "buyerContribution",
    "proposalHash",
  ]) || proposal.proposalVersion !== "1" || !isHash(proposal.proposalHash)) {
    throw new ProgressSignal("rejected", "proposal", "fixed-price agreement proposal is malformed");
  }
  try {
    fixedPriceAgreementSignedBytes(proposal.plan);
  } catch (error) {
    throw new ProgressSignal(
      "rejected",
      "proposal",
      `fixed-price agreement proposal plan is invalid: ${String(error)}`,
    );
  }
  const material = {
    proposalVersion: proposal.proposalVersion,
    plan: proposal.plan,
    buyerContribution: proposal.buyerContribution,
  };
  if (sha256Hex(canonicalize(material)) !== proposal.proposalHash) {
    throw new ProgressSignal("rejected", "proposal", "fixed-price agreement proposal hash differs");
  }
  const identity = input.transportIdentity;
  if (!isRecord(identity) || !exactKeys(identity as unknown as DataRecord, [
    "jobId",
    "planHash",
    "agreementHash",
    "buyer",
    "seller",
    "proposalHash",
  ]) || !isNonEmpty(identity.jobId) || !isNonEmpty(identity.buyer) ||
      !isNonEmpty(identity.seller) || identity.buyer === identity.seller ||
      !isHash(identity.planHash) || !isHash(identity.agreementHash) ||
      !isHash(identity.proposalHash)) {
    throw new ProgressSignal("rejected", "proposal", "agreement transport identity is malformed");
  }
  const buyer = proposal.plan.requiredSigners.find((entry) => entry.role === "buyer")?.party;
  const seller = proposal.plan.requiredSigners.find((entry) => entry.role === "seller")?.party;
  const expectedIdentity: FixedPriceAgreementTransportIdentity = {
    jobId: proposal.plan.draft.jobId,
    planHash: proposal.plan.planHash,
    agreementHash: proposal.plan.agreementHash,
    buyer: buyer ?? "",
    seller: seller ?? "",
    proposalHash: proposal.proposalHash,
  };
  if (!buyer || !seller || !exact(identity, expectedIdentity)) {
    throw new ProgressSignal(
      "rejected",
      "proposal",
      "agreement transport identity does not bind the exact proposal",
    );
  }
  return proposal.plan;
}

function contextQuery(
  input: DurableSellerFixedPriceAgreementInput,
  plan: Readonly<FixedPriceAgreementSigningPlan>,
): Readonly<SellerFixedPriceAgreementContextQuery> {
  return immutable({
    queryVersion: "1" as const,
    jobId: input.transportIdentity.jobId,
    listingPin: clone(plan.draft.listingRef),
    candidateDraft: clone(plan.draft),
    planHash: plan.planHash,
    agreementHash: plan.agreementHash,
    proposalHash: input.proposal.proposalHash,
    buyer: input.transportIdentity.buyer,
    seller: input.transportIdentity.seller,
  });
}

function captureAgreementContext(value: unknown): FixedPriceAgreementInput {
  const captured = snapshotData(value, "authenticated seller agreement context");
  if (!isRecord(captured) || !exactKeys(captured, [
    "jobId",
    "verifiedListing",
    "buyer",
    "seller",
    "generatedAt",
  ], ["selectedRail", "payoutBindings"])) {
    throw new TypeError("authenticated seller agreement context is malformed");
  }
  return captured as unknown as FixedPriceAgreementInput;
}

async function verifyContribution(
  verify: FixedPriceAgreementContributionVerifier,
  plan: Readonly<FixedPriceAgreementSigningPlan>,
  contribution: Readonly<FixedPriceAgreementSignatureContribution>,
  stage: DurableSellerFixedPriceAgreementStage,
): Promise<void> {
  let disposition: unknown;
  try {
    disposition = await verify({
      role: contribution.role,
      party: contribution.party,
      algorithm: contribution.signature.algorithm,
      value: contribution.signature.value,
      signedBytes: fixedPriceAgreementSignedBytes(plan),
    });
  } catch (error) {
    throw new ProgressSignal(
      "indeterminate",
      stage,
      `agreement contribution verification failed: ${String(error)}`,
    );
  }
  if (disposition === "valid") return;
  if (disposition !== "invalid" && disposition !== "indeterminate" &&
      disposition !== "error") {
    throw new ProgressSignal(
      "indeterminate",
      stage,
      "agreement contribution verifier returned an invalid disposition",
    );
  }
  throw new ProgressSignal(
    disposition === "invalid" ? "rejected" : "indeterminate",
    stage,
    `${contribution.role} agreement contribution verification was ${disposition}`,
  );
}

async function recreateContribution(
  plan: Readonly<FixedPriceAgreementSigningPlan>,
  contribution: Readonly<FixedPriceAgreementSignatureContribution>,
  role: "buyer" | "seller",
): Promise<Readonly<FixedPriceAgreementSignatureContribution>> {
  const signer: AgreementSigner = {
    party: contribution.party,
    algorithm: contribution.signature.algorithm,
    sign: () => contribution.signature.value,
  };
  const recreated = await createFixedPriceAgreementSignatureContribution(plan, role, signer);
  if (!exact(recreated, contribution)) {
    throw new DacsError(`${role} agreement contribution is non-canonical or substituted`);
  }
  return immutable(recreated);
}

async function authenticateRequest(
  input: DurableSellerFixedPriceAgreementInput,
  durability: DurableSellerFixedPriceAgreementDurability,
): Promise<AuthenticatedSellerAgreementRequest> {
  const offeredPlan = validateProposalEnvelope(input);
  const query = contextQuery(input, offeredPlan);
  let resolution: SellerFixedPriceAgreementContextResolution;
  try {
    resolution = captureResolution(
      await durability.resolveAuthenticatedAgreementContext(clone(query)),
      "authenticated seller agreement context resolution",
      captureAgreementContext,
    );
  } catch (error) {
    throw new ProgressSignal(
      "indeterminate",
      "context",
      `seller agreement context resolution failed: ${String(error)}`,
    );
  }
  if (resolution.disposition !== "present") {
    throw new ProgressSignal(
      resolution.disposition === "absent"
        ? "waiting"
        : resolution.disposition === "rejected"
          ? "rejected"
          : "indeterminate",
      "context",
      resolution.reason,
    );
  }
  const context = immutable(resolution.value);
  let derivedPlan: Readonly<FixedPriceAgreementSigningPlan>;
  try {
    if (context.jobId !== query.jobId) {
      throw new DacsError("authenticated context job does not match transport identity");
    }
    derivedPlan = createFixedPriceAgreementSigningPlan(
      deriveFixedPriceAgreement(structuredClone(context)),
    );
  } catch (error) {
    throw new ProgressSignal(
      "rejected",
      "context",
      `seller-local agreement derivation rejected the proposal: ${String(error)}`,
    );
  }
  if (!exact(derivedPlan, offeredPlan)) {
    throw new ProgressSignal(
      "rejected",
      "context",
      "proposal plan differs from the independently derived seller agreement",
    );
  }
  if (input.seller.party !== query.seller ||
      context.seller.identityBundle.presentedBy !== query.seller) {
    throw new ProgressSignal(
      "rejected",
      "context",
      "local seller identity does not own the proposal seller role",
    );
  }
  let buyerContribution: Readonly<FixedPriceAgreementSignatureContribution>;
  try {
    buyerContribution = await recreateContribution(
      derivedPlan,
      input.proposal.buyerContribution,
      "buyer",
    );
  } catch (error) {
    throw new ProgressSignal(
      "rejected",
      "buyer-contribution",
      `buyer contribution is malformed or rebound: ${String(error)}`,
    );
  }
  await verifyContribution(
    durability.verifyContribution,
    derivedPlan,
    buyerContribution,
    "buyer-contribution",
  );
  return {
    input,
    plan: derivedPlan,
    context,
    contextHash: sha256Hex(encode(context, "authenticated seller agreement context")),
    buyerContribution,
    query,
  };
}

class DurableSellerFixedPriceAgreementCoordinator {
  readonly #authenticated: AuthenticatedSellerAgreementRequest;
  readonly #durability: DurableSellerFixedPriceAgreementDurability;
  readonly #jobId: string;
  #lease?: SessionLeaseToken;
  #sellerContribution?: Readonly<FixedPriceAgreementSignatureContribution>;

  constructor(
    authenticated: AuthenticatedSellerAgreementRequest,
    durability: DurableSellerFixedPriceAgreementDurability,
  ) {
    this.#authenticated = authenticated;
    this.#durability = durability;
    this.#jobId = authenticated.query.jobId;
  }

  #now(): number {
    const value = this.#durability.leaseNowMs?.() ?? Date.now();
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new DacsError("seller agreement durability clock returned an invalid time");
    }
    return value;
  }

  #authorityData(): Record<string, CheckpointValue> {
    const { input, plan, contextHash, buyerContribution } = this.#authenticated;
    return {
      jobId: this.#jobId,
      planHash: plan.planHash,
      agreementHash: plan.agreementHash,
      proposalHash: input.proposal.proposalHash,
      buyer: input.transportIdentity.buyer,
      seller: input.transportIdentity.seller,
      listingId: plan.draft.listingRef.listingId,
      listingVersion: plan.draft.listingRef.version,
      listingHash: plan.draft.listingRef.contentHash,
      contextHash,
      buyerContributionHash: buyerContribution.contributionHash,
      signedBytesHash: sha256Hex(fixedPriceAgreementSignedBytes(plan)),
    };
  }

  #bindingData(): Record<string, CheckpointValue> {
    const { input, plan, context } = this.#authenticated;
    return {
      ...this.#authorityData(),
      planJson: encode(plan, "seller-derived agreement plan"),
      proposalJson: encode(input.proposal, "seller-retained agreement proposal"),
      transportIdentityJson: encode(
        input.transportIdentity,
        "seller-retained agreement transport identity",
      ),
      contextJson: encode(context, "seller-retained authenticated agreement context"),
    };
  }

  #idempotencyKey(kind: string, extra: Record<string, CheckpointValue> = {}): string {
    return `agreement-responder:${kind}:${sha256Hex(canonicalize({
      ...this.#authorityData(),
      ...extra,
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
          agreementHash: this.#authenticated.plan.agreementHash,
          phase: "agreement-responder:proposal-binding",
          now: this.#now(),
        });
      } catch (error) {
        loaded = await this.#durability.store.load(this.#jobId);
        if (loaded.status === "missing") throw error;
      }
      loaded = await this.#durability.store.load(this.#jobId);
    }
    let record = exactRecordFromLoad(loaded);
    if (record.agreementHash === undefined) {
      if (record.leaseGeneration !== 0 || record.checkpoints.length !== 0) {
        throw new DacsError("existing seller session cannot be rebound to this agreement plan");
      }
      const bound = await this.#durability.store.bindHash({
        hash: this.#authenticated.plan.agreementHash,
        jobId: this.#jobId,
        kind: "agreement",
      });
      if (!bound.ok || (bound.boundTo !== undefined && bound.boundTo !== this.#jobId)) {
        throw new DacsError(
          `seller agreement hash is already bound to ${bound.boundTo ?? "another session"}`,
        );
      }
      record = await this.#load();
    }
    if (record.agreementHash !== this.#authenticated.plan.agreementHash) {
      throw new DacsError("seller agreement session is bound to a conflicting plan");
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
          "another generation currently owns the seller agreement response",
        );
      }
      throw new SubstrateError(`seller agreement lease acquisition failed: ${result.reason}`);
    }
    this.#lease = Object.freeze({
      owner: result.lease.owner,
      generation: result.lease.generation,
    });
  }

  async #renew(): Promise<void> {
    if (!this.#lease) throw new SubstrateError("seller agreement lease is unavailable");
    const renewed = await this.#durability.store.renewLease({
      jobId: this.#jobId,
      leaseToken: this.#lease,
      ttlMs: this.#durability.leaseTtlMs,
      now: this.#now(),
    });
    if (!renewed.ok) {
      throw new SubstrateError(`seller agreement lease is stale: ${renewed.reason}`);
    }
  }

  #fence(idempotencyKey: string): Readonly<SellerFixedPriceAgreementEffectFence> {
    if (!this.#lease) throw new SubstrateError("seller agreement lease is unavailable");
    return Object.freeze({ ...this.#lease, idempotencyKey });
  }

  async #invokeFenced<T>(
    idempotencyKey: string,
    operation: (
      fence: Readonly<SellerFixedPriceAgreementEffectFence>,
    ) => Promise<T> | T,
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
      heartbeat = heartbeat.then(() => this.#renew()).catch((error: unknown) => {
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
    const current = AGREEMENT_RESPONDER_PHASE_RANK.get(record.phase);
    const wanted = AGREEMENT_RESPONDER_PHASE_RANK.get(requested);
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
    if (!this.#lease) throw new SubstrateError("seller agreement lease is unavailable");
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
    if (claimed.ok) return { state: "fresh", data: clone(data), record: claimed.record };
    if ((claimed.reason !== "held" && claimed.reason !== "completed") || !claimed.record) {
      throw new SubstrateError(`seller agreement checkpoint ${key} failed: ${claimed.reason}`);
    }
    const checkpoint = latestCheckpoint(claimed.record.checkpoints, key);
    if (!checkpoint?.data || !this.#dataContains(checkpoint.data, data)) {
      throw new DacsError(`seller agreement checkpoint ${key} binds conflicting content`);
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
    options: { phase?: string; release?: boolean } = {},
  ): Promise<SessionRecord> {
    if (!this.#lease) throw new SubstrateError("seller agreement lease is unavailable");
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      await this.#renew();
      const record = await this.#load();
      const prior = latestCheckpoint(record.checkpoints, key);
      if (prior?.stage === "outcome") {
        if (!this.#dataContains(prior.data, data)) {
          throw new DacsError(`seller agreement checkpoint ${key} has conflicting outcome`);
        }
        return record;
      }
      if (prior?.stage !== "intent") {
        throw new DacsError(`seller agreement checkpoint ${key} lacks durable intent`);
      }
      const phase = options.phase ? this.#phaseFor(record, options.phase) : undefined;
      const transitioned = await this.#durability.store.transition({
        jobId: this.#jobId,
        expectedRevision: record.revision,
        leaseToken: this.#lease,
        ...(phase ? { phase } : {}),
        checkpoint: { key, stage: "outcome", data: clone(data) },
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
        `seller agreement checkpoint ${key} outcome failed: ${transitioned.reason}`,
      );
    }
    throw new SubstrateError(`seller agreement checkpoint ${key} exhausted CAS retries`);
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
      if (!record.lease || record.lease.owner !== token.owner ||
          record.lease.generation !== token.generation) {
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

  #requireOutcome(record: SessionRecord, key: string): Record<string, CheckpointValue> {
    const checkpoint = latestCheckpoint(record.checkpoints, key);
    if (checkpoint?.stage !== "outcome" || !checkpoint.data) {
      throw new DacsError(`terminal seller agreement state lacks ${key} outcome`);
    }
    return clone(checkpoint.data);
  }

  #validateBindingData(data: Record<string, CheckpointValue>): void {
    const expected = this.#bindingData();
    if (!this.#dataContains(data, expected)) {
      throw new DacsError("persisted seller agreement proposal binding is substituted");
    }
    const plan = decode<FixedPriceAgreementSigningPlan>(
      data.planJson,
      "persisted seller-derived agreement plan",
    );
    fixedPriceAgreementSignedBytes(plan);
    const proposal = decode<FixedPriceAgreementProposal>(
      data.proposalJson,
      "persisted seller agreement proposal",
    );
    const identity = decode<FixedPriceAgreementTransportIdentity>(
      data.transportIdentityJson,
      "persisted seller agreement transport identity",
    );
    const context = decode<FixedPriceAgreementInput>(
      data.contextJson,
      "persisted authenticated seller agreement context",
    );
    if (!exact(plan, this.#authenticated.plan) ||
        !exact(proposal, this.#authenticated.input.proposal) ||
        !exact(identity, this.#authenticated.input.transportIdentity) ||
        !exact(context, this.#authenticated.context) ||
        sha256Hex(encode(context, "persisted authenticated context")) !==
          this.#authenticated.contextHash) {
      throw new DacsError("persisted seller agreement authority differs from the exact request");
    }
  }

  async #bindProposal(): Promise<void> {
    const data = this.#bindingData();
    const claimed = await this.#claim(
      durableSellerFixedPriceAgreementCheckpointKey.proposal,
      data,
      "agreement-responder:proposal-binding",
    );
    this.#validateBindingData(claimed.data);
    if (claimed.state !== "outcome") {
      await this.#complete(durableSellerFixedPriceAgreementCheckpointKey.proposal, data, {
        phase: "agreement-responder:seller-signing",
      });
    }
  }

  #signatureIntent(): Record<string, CheckpointValue> {
    return {
      ...this.#authorityData(),
      algorithm: this.#authenticated.input.seller.algorithm,
      idempotencyKey: this.#idempotencyKey("seller-signature", {
        algorithm: this.#authenticated.input.seller.algorithm,
      }),
    };
  }

  async #contributionFromSignature(
    raw: Uint8Array | string,
  ): Promise<Readonly<FixedPriceAgreementSignatureContribution>> {
    const signer: AgreementSigner = {
      party: this.#authenticated.input.seller.party,
      algorithm: this.#authenticated.input.seller.algorithm,
      sign: () => typeof raw === "string" ? raw : Uint8Array.from(raw),
    };
    return createFixedPriceAgreementSignatureContribution(
      this.#authenticated.plan,
      "seller",
      signer,
    );
  }

  async #restoreSellerContribution(
    data: Record<string, CheckpointValue>,
  ): Promise<Readonly<FixedPriceAgreementSignatureContribution>> {
    const contribution = decode<FixedPriceAgreementSignatureContribution>(
      data.contributionJson,
      "persisted seller agreement contribution",
    );
    if (!isHash(data.contributionHash) ||
        data.contributionHash !== contribution.contributionHash ||
        contribution.planHash !== this.#authenticated.plan.planHash ||
        contribution.role !== "seller" ||
        contribution.party !== this.#authenticated.query.seller) {
      throw new DacsError("persisted seller agreement contribution is rebound or malformed");
    }
    const recreated = await this.#contributionFromSignature(contribution.signature.value);
    if (!exact(recreated, contribution)) {
      throw new DacsError("persisted seller agreement contribution is non-canonical");
    }
    await verifyContribution(
      this.#durability.verifyContribution,
      this.#authenticated.plan,
      contribution,
      "seller-signature",
    );
    return immutable(contribution);
  }

  async #createSellerContribution(): Promise<void> {
    const intent = this.#signatureIntent();
    const claimed = await this.#claim(
      durableSellerFixedPriceAgreementCheckpointKey.sellerSignature,
      intent,
      "agreement-responder:seller-signing",
    );
    if (claimed.state === "outcome") {
      this.#sellerContribution = await this.#restoreSellerContribution(claimed.data);
      return;
    }
    const idempotencyKey = String(intent.idempotencyKey);
    let raw: Uint8Array | string;
    if (claimed.state === "intent") {
      let resolution: FixedPriceAgreementSignatureReconciliation;
      try {
        resolution = captureSignatureResolution(await this.#invokeFenced(
          idempotencyKey,
          (fence) => this.#durability.reconcileSellerSignature(
            {
              transportIdentity: clone(this.#authenticated.input.transportIdentity),
              planHash: this.#authenticated.plan.planHash,
              agreementHash: this.#authenticated.plan.agreementHash,
              party: this.#authenticated.query.seller,
              algorithm: this.#authenticated.input.seller.algorithm,
              signedBytes: fixedPriceAgreementSignedBytes(this.#authenticated.plan),
            },
            fence,
          ),
        ));
      } catch (error) {
        throw new ProgressSignal(
          "indeterminate",
          "seller-signature",
          `seller signature reconciliation failed: ${String(error)}`,
        );
      }
      if (resolution.disposition === "present") {
        raw = resolution.value;
      } else if (resolution.disposition === "absent") {
        raw = await this.#sign(idempotencyKey);
      } else {
        throw new ProgressSignal(
          resolution.disposition === "rejected" ? "rejected" : "indeterminate",
          "seller-signature",
          resolution.reason,
        );
      }
    } else {
      raw = await this.#sign(idempotencyKey);
    }
    let contribution: Readonly<FixedPriceAgreementSignatureContribution>;
    try {
      contribution = await this.#contributionFromSignature(raw);
    } catch (error) {
      throw new ProgressSignal(
        "rejected",
        "seller-signature",
        `seller signer returned an invalid contribution: ${String(error)}`,
      );
    }
    await verifyContribution(
      this.#durability.verifyContribution,
      this.#authenticated.plan,
      contribution,
      "seller-signature",
    );
    const outcome = {
      ...intent,
      contributionHash: contribution.contributionHash,
      contributionJson: encode(contribution, "seller agreement contribution"),
    };
    await this.#complete(durableSellerFixedPriceAgreementCheckpointKey.sellerSignature, outcome, {
      phase: "agreement-responder:contribution-publication-pending",
    });
    this.#sellerContribution = immutable(contribution);
  }

  async #sign(idempotencyKey: string): Promise<Uint8Array | string> {
    try {
      const raw = await this.#invokeFenced(idempotencyKey, (fence) =>
        this.#authenticated.input.seller.sign(
          fixedPriceAgreementSignedBytes(this.#authenticated.plan),
          Object.freeze({
            party: this.#authenticated.query.seller,
            algorithm: this.#authenticated.input.seller.algorithm,
          }),
          fence,
        )
      );
      return captureSignatureValue(raw, "seller signer output");
    } catch (error) {
      const retained = retainedProgressSignal(error);
      if (retained) throw retained;
      throw new ProgressSignal(
        "indeterminate",
        "seller-signature",
        `seller signature outcome is ambiguous: ${String(error)}`,
      );
    }
  }

  #publicationIntent(): Record<string, CheckpointValue> {
    if (!this.#sellerContribution) {
      throw new DacsError("seller contribution is unavailable for publication");
    }
    return {
      ...this.#authorityData(),
      contributionHash: this.#sellerContribution.contributionHash,
      contributionJson: encode(
        this.#sellerContribution,
        "seller agreement contribution publication",
      ),
      idempotencyKey: this.#idempotencyKey("contribution-publication", {
        contributionHash: this.#sellerContribution.contributionHash,
      }),
    };
  }

  #authenticatePublishedContribution(value: unknown): void {
    const captured = snapshotData(value, "published seller agreement contribution");
    if (!this.#sellerContribution || !exact(captured, this.#sellerContribution)) {
      throw new ProgressSignal(
        "rejected",
        "contribution-publication",
        "published seller agreement contribution is substituted",
      );
    }
  }

  async #reconcilePublication(
    idempotencyKey: string,
  ): Promise<FixedPriceAgreementResolution<unknown>> {
    try {
      return captureResolution(
        await this.#invokeFenced(idempotencyKey, (fence) =>
          this.#durability.transport.reconcileSellerContributionPublication(
            clone(this.#authenticated.input.transportIdentity),
            fence,
          )
        ),
        "seller contribution publication reconciliation",
        (present) => snapshotData(present, "reconciled seller contribution"),
      );
    } catch (error) {
      const retained = retainedProgressSignal(error);
      if (retained) throw retained;
      throw new ProgressSignal(
        "indeterminate",
        "contribution-publication",
        `seller contribution publication reconciliation failed: ${String(error)}`,
      );
    }
  }

  async #publishContribution(): Promise<void> {
    const intent = this.#publicationIntent();
    const claimed = await this.#claim(
      durableSellerFixedPriceAgreementCheckpointKey.publication,
      intent,
      "agreement-responder:contribution-publication-pending",
    );
    const persisted = decode<FixedPriceAgreementSignatureContribution>(
      claimed.data.contributionJson,
      "persisted seller contribution publication",
    );
    if (!this.#sellerContribution || !exact(persisted, this.#sellerContribution)) {
      throw new DacsError("seller publication checkpoint contains substituted contribution");
    }
    if (claimed.state === "outcome") {
      if (claimed.data.published !== true) {
        throw new DacsError("seller contribution publication outcome lacks confirmation");
      }
      return;
    }
    const idempotencyKey = String(intent.idempotencyKey);
    let resolution = await this.#reconcilePublication(idempotencyKey);
    if (resolution.disposition === "present") {
      this.#authenticatePublishedContribution(resolution.value);
    } else if (resolution.disposition === "absent") {
      let submission: FixedPriceAgreementEffectSubmission;
      try {
        submission = captureSubmission(
          await this.#invokeFenced(idempotencyKey, (fence) =>
            this.#durability.transport.publishSellerContribution(
              clone(this.#sellerContribution!),
              clone(this.#authenticated.input.transportIdentity),
              fence,
            )
          ),
          "seller contribution publication submission",
        );
      } catch (error) {
        const retained = retainedProgressSignal(error);
        if (retained) throw retained;
        throw new ProgressSignal(
          "indeterminate",
          "contribution-publication",
          `seller contribution publication outcome is ambiguous: ${String(error)}`,
        );
      }
      if (submission.disposition !== "submitted") {
        throw new ProgressSignal(
          submission.disposition === "rejected" ? "rejected" : "indeterminate",
          "contribution-publication",
          submission.reason,
        );
      }
      resolution = await this.#reconcilePublication(idempotencyKey);
      if (resolution.disposition !== "present") {
        throw new ProgressSignal(
          resolution.disposition === "rejected" ? "rejected" : "indeterminate",
          "contribution-publication",
          resolution.disposition === "absent"
            ? "submitted seller contribution is not yet authoritatively observable"
            : resolution.reason,
        );
      }
      this.#authenticatePublishedContribution(resolution.value);
    } else {
      throw new ProgressSignal(
        resolution.disposition === "rejected" ? "rejected" : "indeterminate",
        "contribution-publication",
        resolution.reason,
      );
    }
    await this.#complete(durableSellerFixedPriceAgreementCheckpointKey.publication, {
      ...intent,
      published: true,
    }, { phase: "agreement-responder:finalizing" });
  }

  #result(): Readonly<DurableSellerFixedPriceAgreementResponse> {
    if (!this.#sellerContribution) {
      throw new DacsError("seller agreement response contribution is unavailable");
    }
    return immutable({
      responseVersion: "1" as const,
      transportIdentity: clone(this.#authenticated.input.transportIdentity),
      sellerContribution: clone(this.#sellerContribution),
    });
  }

  #resultIntent(result: Readonly<DurableSellerFixedPriceAgreementResponse>):
    Record<string, CheckpointValue> {
    const resultJson = encode(result, "durable seller agreement response");
    return {
      ...this.#authorityData(),
      resultHash: sha256Hex(resultJson),
      resultJson,
    };
  }

  async #finish(): Promise<Readonly<DurableSellerFixedPriceAgreementResponse>> {
    const result = this.#result();
    const intent = this.#resultIntent(result);
    const claimed = await this.#claim(
      durableSellerFixedPriceAgreementCheckpointKey.result,
      intent,
      "agreement-responder:finalizing",
    );
    const persisted = decode<DurableSellerFixedPriceAgreementResponse>(
      claimed.data.resultJson,
      "persisted durable seller agreement response",
    );
    if (!exact(persisted, result)) {
      throw new DacsError("persisted seller agreement response is substituted");
    }
    if (claimed.state !== "outcome") {
      await this.#complete(durableSellerFixedPriceAgreementCheckpointKey.result, intent, {
        phase: "agreement-responder:complete",
        release: true,
      });
    } else {
      await this.#release();
    }
    return result;
  }

  async #recoverTerminal(
    record: SessionRecord,
  ): Promise<Readonly<DurableSellerFixedPriceAgreementResponse>> {
    const proposalData = this.#requireOutcome(
      record,
      durableSellerFixedPriceAgreementCheckpointKey.proposal,
    );
    this.#validateBindingData(proposalData);
    const signatureData = this.#requireOutcome(
      record,
      durableSellerFixedPriceAgreementCheckpointKey.sellerSignature,
    );
    if (!this.#dataContains(signatureData, this.#signatureIntent())) {
      throw new DacsError("terminal seller signature authority is substituted");
    }
    this.#sellerContribution = await this.#restoreSellerContribution(signatureData);
    const publicationData = this.#requireOutcome(
      record,
      durableSellerFixedPriceAgreementCheckpointKey.publication,
    );
    if (!this.#dataContains(publicationData, this.#publicationIntent()) ||
        publicationData.published !== true) {
      throw new DacsError("terminal seller contribution publication is incomplete");
    }
    const result = this.#result();
    const resultData = this.#requireOutcome(
      record,
      durableSellerFixedPriceAgreementCheckpointKey.result,
    );
    if (!this.#dataContains(resultData, this.#resultIntent(result))) {
      throw new DacsError("terminal seller agreement result authority is substituted");
    }
    const persisted = decode<DurableSellerFixedPriceAgreementResponse>(
      resultData.resultJson,
      "terminal durable seller agreement response",
    );
    if (!exact(persisted, result)) {
      throw new DacsError("terminal seller agreement response differs from exact contribution");
    }
    return result;
  }

  async run(): Promise<DurableSellerFixedPriceAgreementProgress> {
    const record = await this.#ensureState();
    const result = latestCheckpoint(
      record.checkpoints,
      durableSellerFixedPriceAgreementCheckpointKey.result,
    );
    if (record.phase === "agreement-responder:complete" && result?.stage !== "outcome") {
      throw new DacsError("seller agreement terminal phase/checkpoint is incomplete");
    }
    if (result?.stage === "outcome") {
      if (record.phase !== "agreement-responder:complete" || record.lease) {
        throw new DacsError("seller agreement terminal result is not atomically sealed");
      }
      try {
        return {
          disposition: "complete",
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
    await this.#bindProposal();
    await this.#createSellerContribution();
    await this.#publishContribution();
    const completed = await this.#finish();
    return { disposition: "complete", result: completed, recovered: false };
  }

  async release(): Promise<void> {
    await this.#release();
  }
}

/**
 * Advance a seller-owned agreement response. All untrusted proposal terms are
 * independently re-derived from seller-local authenticated context before the
 * local signer or contribution publisher can be invoked.
 */
export async function respondToFixedPriceAgreementProposalDurable(
  inputValue: DurableSellerFixedPriceAgreementInput,
  durabilityValue: DurableSellerFixedPriceAgreementDurability,
): Promise<DurableSellerFixedPriceAgreementProgress> {
  const durability = captureDurability(durabilityValue);
  let input: DurableSellerFixedPriceAgreementInput;
  try {
    input = captureInput(inputValue);
  } catch (error) {
    return {
      disposition: "rejected",
      stage: "proposal",
      reason: `seller agreement request is malformed: ${String(error)}`,
    };
  }
  let authenticated: AuthenticatedSellerAgreementRequest;
  try {
    authenticated = await authenticateRequest(input, durability);
  } catch (error) {
    const progress = retainedProgressSignal(error);
    if (progress) return progress.progress;
    throw error;
  }
  const coordinator = new DurableSellerFixedPriceAgreementCoordinator(
    authenticated,
    durability,
  );
  try {
    return await coordinator.run();
  } catch (error) {
    await coordinator.release();
    const progress = retainedProgressSignal(error);
    if (progress) return progress.progress;
    if (error instanceof SubstrateError) {
      return { disposition: "indeterminate", stage: "lease", reason: error.message };
    }
    if (error instanceof DacsError) {
      return { disposition: "rejected", stage: "proposal", reason: error.message };
    }
    throw error;
  }
}
