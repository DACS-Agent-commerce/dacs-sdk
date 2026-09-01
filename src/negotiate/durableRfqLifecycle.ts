import { types as nodeTypes } from "node:util";

import type {
  AgreementArtifact,
  PaymentRailRef,
  PayoutBinding,
} from "../artifacts/types.js";
import {
  isAgreementArtifact,
  isAttestationRef,
  isListing,
} from "../artifacts/validators.js";
import {
  COMPONENT_SIGNATURE_ALGORITHMS,
  isCanonicalBase64Url,
} from "../artifacts/signatures.js";
import { canonicalize, contentHash, sha256Hex } from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { identityBundleHash } from "../identity/bundle.js";
import {
  advanceRfqSession,
  openRfqSession,
  rfqSessionCheckpointHash,
  type OpenRfqSessionInput,
  type RfqChannelReservation,
  type RfqProposal,
  type RfqSessionState,
  type RfqTurnBody,
} from "./rfq.js";
import {
  prepareChannelMessageSigningInput,
  type ChannelMessage,
  type ChannelMessageSignatureVerifier,
  type ChannelMessageSigningInput,
} from "./channel.js";
import {
  createFixedPriceAgreementSignatureContribution,
  createFixedPriceAgreementSigningPlan,
  finalizeFixedPriceAgreementContributions,
  type FixedPriceAgreementContributionVerifier,
  type FixedPriceAgreementSignatureContribution,
  type FixedPriceAgreementSigningPlan,
} from "./fixedPriceExchange.js";
import {
  deriveRfqAgreement,
  type RfqAgreementInput,
} from "./rfqAgreement.js";
import type { AgreementSigner } from "./fixedPrice.js";

export const DURABLE_RFQ_LIFECYCLE_STORE_VERSION = 1 as const;

export type DurableRfqLifecycleRole = "buyer" | "seller";

export interface DurableRfqAgreementAuthority
  extends Omit<RfqAgreementInput, "session" | "generatedAt"> {}

export interface OpenDurableRfqLifecycleInput
  extends Omit<OpenRfqSessionInput, "startedAt">,
    Omit<DurableRfqAgreementAuthority, "verifiedListing" | "buyer" | "seller"> {}

export interface RfqLifecyclePacketBase {
  packetVersion: "1";
  packetId: string;
  jobId: string;
  channelId: string;
  sender: string;
  recipient: string;
}

export interface RfqLifecycleTurnPacket<TSignature = unknown>
  extends RfqLifecyclePacketBase {
  kind: "turn";
  message: ChannelMessage<RfqTurnBody, TSignature>;
}

export interface RfqLifecycleAgreementProposalPacket
  extends RfqLifecyclePacketBase {
  kind: "agreement-proposal";
  plan: FixedPriceAgreementSigningPlan;
  buyerContribution: FixedPriceAgreementSignatureContribution;
}

export interface RfqLifecycleAgreementContributionPacket
  extends RfqLifecyclePacketBase {
  kind: "agreement-contribution";
  sellerContribution: FixedPriceAgreementSignatureContribution;
}

export type RfqLifecyclePacket<TSignature = unknown> =
  | RfqLifecycleTurnPacket<TSignature>
  | RfqLifecycleAgreementProposalPacket
  | RfqLifecycleAgreementContributionPacket;

export type RfqLifecycleOutboxState =
  | "pending"
  | "indeterminate"
  | "acknowledged"
  | "rejected";

export interface DurableRfqOutboxEntry<TSignature = unknown> {
  packet: RfqLifecyclePacket<TSignature>;
  state: RfqLifecycleOutboxState;
  attempts: number;
  updatedAt: number;
  reason?: string;
}

export interface DurableRfqAgreementState {
  plan: FixedPriceAgreementSigningPlan;
  contributions: FixedPriceAgreementSignatureContribution[];
  finalized?: AgreementArtifact;
}

export interface DurableRfqLifecycleFailure {
  failureVersion: "1";
  class: "transport" | "timeout";
  packetId?: string;
  reason: string;
  recordedAt: number;
}

/**
 * Role-local RFQ state. Implementations of the store contract MUST authenticate
 * persisted bytes and isolate buyer and seller authority; the public binding
 * hash is not treated as a substitute for keyed local authenticity.
 */
export interface DurableRfqLifecycleRecord<TSignature = unknown> {
  storeVersion: typeof DURABLE_RFQ_LIFECYCLE_STORE_VERSION;
  revision: number;
  role: DurableRfqLifecycleRole;
  jobId: string;
  channelId: string;
  bindingHash: string;
  authority: DurableRfqAgreementAuthority;
  session: RfqSessionState;
  transcript: ChannelMessage<RfqTurnBody, TSignature>[];
  inboxPacketIds: string[];
  outbox: DurableRfqOutboxEntry<TSignature>[];
  agreement?: DurableRfqAgreementState;
  failure?: DurableRfqLifecycleFailure;
  createdAt: number;
  updatedAt: number;
}

export type DurableRfqRecordLoad<TSignature = unknown> =
  | { status: "missing" }
  | { status: "ok"; record: Readonly<DurableRfqLifecycleRecord<TSignature>> }
  | { status: "unsupported"; version: number }
  | { status: "corrupt" | "unavailable"; reason: string };

export type DurableRfqRecordCreate<TSignature = unknown> =
  | {
      status: "created" | "existing";
      record: Readonly<DurableRfqLifecycleRecord<TSignature>>;
    }
  | { status: "conflict" | "corrupt" | "unavailable"; reason: string }
  | { status: "unsupported"; version: number };

export type DurableRfqRecordWrite<TSignature = unknown> =
  | { status: "written"; record: Readonly<DurableRfqLifecycleRecord<TSignature>> }
  | { status: "missing" | "stale" }
  | { status: "corrupt" | "unavailable"; reason: string }
  | { status: "unsupported"; version: number };

export interface DurableRfqLifecycleStore<TSignature = unknown> {
  load(
    role: DurableRfqLifecycleRole,
    jobId: string,
  ): Promise<DurableRfqRecordLoad<TSignature>> | DurableRfqRecordLoad<TSignature>;
  create(
    record: Readonly<DurableRfqLifecycleRecord<TSignature>>,
  ):
    | Promise<DurableRfqRecordCreate<TSignature>>
    | DurableRfqRecordCreate<TSignature>;
  compareAndSwap(
    role: DurableRfqLifecycleRole,
    jobId: string,
    expectedRevision: number,
    next: Readonly<DurableRfqLifecycleRecord<TSignature>>,
  ): Promise<DurableRfqRecordWrite<TSignature>> | DurableRfqRecordWrite<TSignature>;
}

export type RfqLifecycleTransportResult =
  | { disposition: "acknowledged" }
  | { disposition: "absent" }
  | { disposition: "rejected" | "indeterminate"; reason: string };

/**
 * Acknowledged means the exact packet is durably accepted by the confidential
 * member transport. After an ambiguous publish, only authenticated `absent`
 * reconciliation permits redrive of the same packetId and bytes.
 */
export interface DurableRfqLifecycleTransport<TSignature = unknown> {
  publish(
    packet: Readonly<RfqLifecyclePacket<TSignature>>,
  ): Promise<Exclude<RfqLifecycleTransportResult, { disposition: "absent" }>>;
  reconcile(
    packet: Readonly<RfqLifecyclePacket<TSignature>>,
  ): Promise<RfqLifecycleTransportResult>;
}

export type RfqChannelMessageSigner<TSignature = unknown> = (
  input: Readonly<ChannelMessageSigningInput<RfqTurnBody>>,
) => Promise<TSignature> | TSignature;

export type DurableRfqLifecycleResult<TSignature = unknown> =
  | {
      status: "ready" | "duplicate";
      record: Readonly<DurableRfqLifecycleRecord<TSignature>>;
    }
  | {
      status: "rejected" | "indeterminate" | "conflict";
      reason: string;
      record?: Readonly<DurableRfqLifecycleRecord<TSignature>>;
    };

export type RfqLifecyclePolicyDecision =
  | { action: "counter"; proposal: RfqProposal }
  | { action: "accept" }
  | { action: "reject" | "abort"; reason?: string };

export type RfqLifecyclePolicy = (
  input: Readonly<{
    role: DurableRfqLifecycleRole;
    session: RfqSessionState;
  }>,
) => Promise<RfqLifecyclePolicyDecision> | RfqLifecyclePolicyDecision;

export interface DurableRfqLifecycleClientOptions<TSignature = unknown> {
  role: DurableRfqLifecycleRole;
  store: DurableRfqLifecycleStore<TSignature>;
  transport: DurableRfqLifecycleTransport<TSignature>;
  reserveChannelId: RfqChannelReservation;
  signChannelMessage: RfqChannelMessageSigner<TSignature>;
  verifyChannelMessage: ChannelMessageSignatureVerifier<
    RfqTurnBody,
    TSignature
  >;
  agreementSigner: AgreementSigner;
  verifyAgreementContribution: FixedPriceAgreementContributionVerifier;
  /** Trusted role-local wall clock; policy callbacks never supply protocol time. */
  nowMs: () => number;
}

export interface DurableRfqLifecycleClient<TSignature = unknown> {
  open(
    input: OpenDurableRfqLifecycleInput,
  ): Promise<DurableRfqLifecycleResult<TSignature>>;
  sendOffer(
    jobId: string,
    proposal: RfqProposal,
  ): Promise<DurableRfqLifecycleResult<TSignature>>;
  sendCounter(
    jobId: string,
    proposal: RfqProposal,
  ): Promise<DurableRfqLifecycleResult<TSignature>>;
  sendAccept(jobId: string): Promise<DurableRfqLifecycleResult<TSignature>>;
  sendReject(
    jobId: string,
    reason?: string,
  ): Promise<DurableRfqLifecycleResult<TSignature>>;
  sendAbort(
    jobId: string,
    reason?: string,
  ): Promise<DurableRfqLifecycleResult<TSignature>>;
  respond(
    jobId: string,
    policy: RfqLifecyclePolicy,
  ): Promise<DurableRfqLifecycleResult<TSignature>>;
  receive(packet: unknown): Promise<DurableRfqLifecycleResult<TSignature>>;
  resumeOutbox(jobId: string): Promise<DurableRfqLifecycleResult<TSignature>>;
  startAgreement(jobId: string): Promise<DurableRfqLifecycleResult<TSignature>>;
  getStatus(jobId: string): Promise<DurableRfqRecordLoad<TSignature>>;
}

export interface InMemoryRfqLifecycleNetwork<TSignature = unknown> {
  transport: DurableRfqLifecycleTransport<TSignature>;
  take(recipient: string): Readonly<RfqLifecyclePacket<TSignature>> | undefined;
  pending(recipient: string): number;
}

type DataRecord = Record<string, unknown>;

const MAX_CAS_ATTEMPTS = 16;
const HASH = /^[0-9a-f]{64}$/;
const SIGNATURE_ALGORITHMS: ReadonlySet<string> = new Set(
  COMPONENT_SIGNATURE_ALGORITHMS,
);

function isRecord(value: unknown): value is DataRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: DataRecord, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => actual.includes(key));
}

function isNonEmptyCanonical(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value.normalize("NFC") === value
  );
}

const roleClaim = (
  record: Readonly<DurableRfqLifecycleRecord>,
  role: DurableRfqLifecycleRole,
): string =>
  role === "buyer"
    ? record.session.buyer.primaryClaim
    : record.session.seller.primaryClaim;

const otherRole = (role: DurableRfqLifecycleRole): DurableRfqLifecycleRole =>
  role === "buyer" ? "seller" : "buyer";

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    value === null ||
    typeof value !== "object" ||
    seen.has(value as object) ||
    Object.isFrozen(value)
  ) {
    return value;
  }
  seen.add(value as object);
  for (const child of Object.values(value as DataRecord)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function snapshot<T>(value: T, subject: string): T {
  return deepFreeze(snapshotCanonicalJsonRead(value, subject));
}

function lifecycleBindingMaterial(
  role: DurableRfqLifecycleRole,
  session: RfqSessionState,
): DataRecord {
  return {
    lifecycleVersion: "1",
    role,
    jobId: session.jobId,
    channelId: session.channelId,
    listingPin: session.listingPin,
    buyer: session.buyer,
    seller: session.seller,
    pricing: session.pricing,
    initiator: session.initiator,
    maxTurns: session.maxTurns,
    timeoutMs: session.timeoutMs,
    startedAt: session.startedAt,
  };
}

export function durableRfqLifecycleBindingHash(
  role: DurableRfqLifecycleRole,
  session: RfqSessionState,
): string {
  rfqSessionCheckpointHash(session);
  return sha256Hex(canonicalize(lifecycleBindingMaterial(role, session)));
}

function packetMaterial<TSignature>(
  packet: Omit<RfqLifecyclePacket<TSignature>, "packetId">,
): DataRecord {
  return packet as unknown as DataRecord;
}

export function rfqLifecyclePacketId<TSignature>(
  packet: Omit<RfqLifecyclePacket<TSignature>, "packetId">,
): string {
  return sha256Hex(canonicalize(snapshot(packetMaterial(packet), "RFQ packet")));
}

function withPacketId<TSignature>(
  packet: Omit<RfqLifecyclePacket<TSignature>, "packetId">,
): Readonly<RfqLifecyclePacket<TSignature>> {
  return snapshot(
    { ...packet, packetId: rfqLifecyclePacketId(packet) },
    "RFQ packet",
  ) as Readonly<RfqLifecyclePacket<TSignature>>;
}

function capturePacket<TSignature>(value: unknown): RfqLifecyclePacket<TSignature> {
  const packet = snapshot(value, "RFQ lifecycle packet") as RfqLifecyclePacket<TSignature>;
  const required =
    packet.kind === "turn"
      ? [
          "packetVersion",
          "packetId",
          "jobId",
          "channelId",
          "sender",
          "recipient",
          "kind",
          "message",
        ]
      : packet.kind === "agreement-proposal"
        ? [
            "packetVersion",
            "packetId",
            "jobId",
            "channelId",
            "sender",
            "recipient",
            "kind",
            "plan",
            "buyerContribution",
          ]
        : [
            "packetVersion",
            "packetId",
            "jobId",
            "channelId",
            "sender",
            "recipient",
            "kind",
            "sellerContribution",
          ];
  if (
    !isRecord(packet) ||
    !exactKeys(packet as unknown as DataRecord, required) ||
    packet.packetVersion !== "1" ||
    !HASH.test(packet.packetId) ||
    !isNonEmptyCanonical(packet.jobId) ||
    !isNonEmptyCanonical(packet.channelId) ||
    !isNonEmptyCanonical(packet.sender) ||
    !isNonEmptyCanonical(packet.recipient) ||
    packet.sender === packet.recipient ||
    !["turn", "agreement-proposal", "agreement-contribution"].includes(packet.kind)
  ) {
    throw new DacsError("RFQ lifecycle packet is malformed");
  }
  const { packetId, ...unsigned } = packet;
  if (rfqLifecyclePacketId(unsigned) !== packetId) {
    throw new DacsError("RFQ lifecycle packetId does not match exact bytes");
  }
  if (packet.kind === "turn") {
    const { signature: _signature, ...message } = packet.message;
    const prepared = prepareChannelMessageSigningInput(
      structuredClone(message),
    );
    if (
      !Object.prototype.hasOwnProperty.call(packet.message, "signature") ||
      packet.message.signature === null ||
      packet.message.channelId !== packet.channelId ||
      packet.message.sender !== packet.sender ||
      prepared.envelopeHash.length !== 64
    ) {
      throw new DacsError("RFQ turn packet does not bind its routing envelope");
    }
  } else if (packet.kind === "agreement-proposal") {
    const recreated = createFixedPriceAgreementSigningPlan(packet.plan.draft);
    if (
      canonicalize(recreated) !== canonicalize(packet.plan) ||
      !validContribution(packet.buyerContribution, "buyer", packet.sender) ||
      packet.buyerContribution.planHash !== packet.plan.planHash ||
      packet.plan.draft.jobId !== packet.jobId ||
      packet.plan.draft.derivedFromChannel?.subnet !== packet.channelId
    ) {
      throw new DacsError("RFQ agreement proposal packet is inconsistent");
    }
  } else if (
    !validContribution(packet.sellerContribution, "seller", packet.sender)
  ) {
    throw new DacsError("RFQ seller contribution packet is inconsistent");
  }
  return packet;
}

function validContribution(
  value: unknown,
  role: "buyer" | "seller",
  party: string,
): value is FixedPriceAgreementSignatureContribution {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "contributionVersion",
      "planHash",
      "role",
      "party",
      "signature",
      "contributionHash",
    ]) ||
    value.contributionVersion !== "1" ||
    value.role !== role ||
    value.party !== party ||
    typeof value.planHash !== "string" ||
    !HASH.test(value.planHash) ||
    typeof value.contributionHash !== "string" ||
    !HASH.test(value.contributionHash) ||
    !isRecord(value.signature) ||
    !exactKeys(value.signature, ["party", "algorithm", "value"]) ||
    value.signature.party !== party ||
    typeof value.signature.algorithm !== "string" ||
    !SIGNATURE_ALGORITHMS.has(value.signature.algorithm) ||
    typeof value.signature.value !== "string" ||
    !isCanonicalBase64Url(value.signature.value)
  ) {
    return false;
  }
  return (
    sha256Hex(
      canonicalize({
        contributionVersion: value.contributionVersion,
        planHash: value.planHash,
        role: value.role,
        party: value.party,
        signature: value.signature,
      }),
    ) === value.contributionHash
  );
}

function authorityBindsSession(
  authority: DurableRfqAgreementAuthority,
  session: RfqSessionState,
): boolean {
  try {
    const { listing, pin } = authority.verifiedListing;
    return (
      authority.verifiedListing.disposition === "verified" &&
      isListing(listing) &&
      canonicalize(pin) === canonicalize(session.listingPin) &&
      pin.contentHash === contentHash(listing as unknown as DataRecord) &&
      canonicalize(listing.pricing) === canonicalize(session.pricing) &&
      authority.buyer.identityBundle.presentedBy === session.buyer.primaryClaim &&
      identityBundleHash(authority.buyer.identityBundle) === session.buyer.bundleHash &&
      isAttestationRef(authority.buyer.vetRecordRef) &&
      canonicalize(authority.buyer.vetRecordRef) ===
        canonicalize(session.buyer.vetRecordRef) &&
      authority.seller.identityBundle.presentedBy === session.seller.primaryClaim &&
      identityBundleHash(authority.seller.identityBundle) === session.seller.bundleHash &&
      isAttestationRef(authority.seller.vetRecordRef) &&
      canonicalize(authority.seller.vetRecordRef) ===
        canonicalize(session.seller.vetRecordRef)
    );
  } catch {
    return false;
  }
}

export function durableRfqLifecycleRecordViolation<TSignature = unknown>(
  value: unknown,
): string | null {
  let record: DurableRfqLifecycleRecord<TSignature>;
  try {
    record = snapshot(value, "RFQ lifecycle record") as
      DurableRfqLifecycleRecord<TSignature>;
  } catch {
    return "record is not canonical JSON data";
  }
  if (record.storeVersion !== DURABLE_RFQ_LIFECYCLE_STORE_VERSION) {
    return "unsupported store version";
  }
  if (
    !Number.isSafeInteger(record.revision) ||
    record.revision < 0 ||
    (record.role !== "buyer" && record.role !== "seller") ||
    record.jobId !== record.session.jobId ||
    record.channelId !== record.session.channelId ||
    !HASH.test(record.bindingHash) ||
    record.bindingHash !== durableRfqLifecycleBindingHash(record.role, record.session) ||
    !authorityBindsSession(record.authority, record.session) ||
    !Array.isArray(record.transcript) ||
    record.transcript.length !== record.session.turnCount ||
    !Array.isArray(record.inboxPacketIds) ||
    new Set(record.inboxPacketIds).size !== record.inboxPacketIds.length ||
    record.inboxPacketIds.some((id) => !HASH.test(id)) ||
    !Array.isArray(record.outbox) ||
    !Number.isSafeInteger(record.createdAt) ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < record.createdAt
  ) {
    return "record binding, counters, or collections are inconsistent";
  }
  if (
    record.failure !== undefined &&
    (!isRecord(record.failure) ||
      !exactKeys(
        record.failure,
        record.failure.packetId === undefined
          ? ["failureVersion", "class", "reason", "recordedAt"]
          : ["failureVersion", "class", "packetId", "reason", "recordedAt"],
      ) ||
      record.failure.failureVersion !== "1" ||
      (record.failure.class !== "transport" && record.failure.class !== "timeout") ||
      !isNonEmptyCanonical(record.failure.reason) ||
      !Number.isSafeInteger(record.failure.recordedAt) ||
      record.failure.recordedAt < record.createdAt ||
      (record.failure.packetId !== undefined && !HASH.test(record.failure.packetId)))
  ) {
    return "terminal lifecycle failure is malformed";
  }
  const transcriptSequences = new Set<number>();
  let previousSequence = 0;
  for (const message of record.transcript) {
    if (
      message.channelId !== record.channelId ||
      (message.sender !== record.session.buyer.primaryClaim &&
        message.sender !== record.session.seller.primaryClaim) ||
      transcriptSequences.has(message.sequence) ||
      message.sequence <= previousSequence
    ) {
      return "transcript channel or sequence is inconsistent";
    }
    transcriptSequences.add(message.sequence);
    previousSequence = message.sequence;
  }
  const lastMessage = record.transcript.at(-1);
  if (
    (lastMessage === undefined &&
      (record.session.lastSequence !== 0 ||
        record.session.lastMessageHash !== undefined)) ||
    (lastMessage !== undefined &&
      (lastMessage.sequence !== record.session.lastSequence ||
        prepareChannelMessageSigningInput(
          structuredClone((({ signature: _signature, ...rest }) => rest)(lastMessage)),
        ).envelopeHash !== record.session.lastMessageHash))
  ) {
    return "transcript endpoint does not match the RFQ checkpoint";
  }
  const packetIds = new Set<string>();
  for (const entry of record.outbox) {
    let packet: RfqLifecyclePacket<TSignature>;
    try {
      packet = capturePacket(entry.packet);
    } catch {
      return "outbox contains a malformed packet";
    }
    if (
      packetIds.has(packet.packetId) ||
      packet.sender !== roleClaim(record, record.role) ||
      packet.recipient !== roleClaim(record, otherRole(record.role)) ||
      !["pending", "indeterminate", "acknowledged", "rejected"].includes(entry.state) ||
      !Number.isSafeInteger(entry.attempts) ||
      entry.attempts < 0 ||
      !Number.isSafeInteger(entry.updatedAt)
    ) {
      return "outbox routing or state is inconsistent";
    }
    packetIds.add(packet.packetId);
  }
  if (record.agreement !== undefined) {
    try {
      const expectedPlan = createFixedPriceAgreementSigningPlan(
        record.agreement.plan.draft,
      );
      if (
        canonicalize(expectedPlan) !== canonicalize(record.agreement.plan) ||
        record.agreement.plan.draft.jobId !== record.jobId ||
        record.agreement.plan.draft.derivedFromPattern !== "rfq" ||
        record.agreement.plan.draft.derivedFromChannel?.subnet !== record.channelId ||
        record.session.status !== "accepted" ||
        !Array.isArray(record.agreement.contributions) ||
        (record.agreement.contributions.length !== 1 &&
          record.agreement.contributions.length !== 2) ||
        (record.agreement.contributions.length === 2) !==
          (record.agreement.finalized !== undefined) ||
        !validContribution(
          record.agreement.contributions[0],
          "buyer",
          record.session.buyer.primaryClaim,
        ) ||
        record.agreement.contributions[0]!.planHash !== record.agreement.plan.planHash
      ) {
        return "agreement plan or buyer contribution is inconsistent";
      }
      if (
        record.agreement.contributions.length === 2 &&
        (!validContribution(
          record.agreement.contributions[1],
          "seller",
          record.session.seller.primaryClaim,
        ) ||
          record.agreement.contributions[1]!.planHash !==
            record.agreement.plan.planHash)
      ) {
        return "seller agreement contribution is inconsistent";
      }
      if (record.agreement.finalized !== undefined) {
        const signatures = record.agreement.contributions.map(
          (contribution) => contribution.signature,
        );
        if (
          record.agreement.contributions.length !== 2 ||
          !isAgreementArtifact(record.agreement.finalized) ||
          contentHash(record.agreement.finalized as unknown as DataRecord) !==
            record.agreement.plan.agreementHash ||
          canonicalize(record.agreement.finalized.signatures) !==
            canonicalize(signatures)
        ) {
          return "finalized agreement does not match its exact contributions";
        }
      }
    } catch {
      return "agreement state is malformed";
    }
  }
  return null;
}

function arrayPrefix(left: readonly unknown[], right: readonly unknown[]): boolean {
  return (
    right.length >= left.length &&
    left.every((value, index) => canonicalize(value) === canonicalize(right[index]))
  );
}

/** Append-only/monotonic CAS gate shared by every persistent store adapter. */
export function durableRfqLifecycleTransitionViolation<TSignature = unknown>(
  priorValue: unknown,
  nextValue: unknown,
): string | null {
  const priorViolation = durableRfqLifecycleRecordViolation<TSignature>(priorValue);
  if (priorViolation !== null) return `prior record: ${priorViolation}`;
  const nextViolation = durableRfqLifecycleRecordViolation<TSignature>(nextValue);
  if (nextViolation !== null) return `next record: ${nextViolation}`;
  const prior = priorValue as DurableRfqLifecycleRecord<TSignature>;
  const next = nextValue as DurableRfqLifecycleRecord<TSignature>;
  if (
    next.role !== prior.role ||
    next.jobId !== prior.jobId ||
    next.channelId !== prior.channelId ||
    next.bindingHash !== prior.bindingHash ||
    canonicalize(next.authority) !== canonicalize(prior.authority) ||
    next.revision !== prior.revision + 1 ||
    next.createdAt !== prior.createdAt ||
    next.updatedAt < prior.updatedAt
  ) {
    return "static authority or revision is non-monotonic";
  }
  if (
    !arrayPrefix(prior.transcript, next.transcript) ||
    next.transcript.length > prior.transcript.length + 1 ||
    !arrayPrefix(prior.inboxPacketIds, next.inboxPacketIds) ||
    next.inboxPacketIds.length > prior.inboxPacketIds.length + 1 ||
    next.outbox.length < prior.outbox.length ||
    next.outbox.length > prior.outbox.length + 1
  ) {
    return "transcript, inbox, or outbox history is not append-only";
  }
  for (let index = 0; index < prior.outbox.length; index += 1) {
    const before = prior.outbox[index]!;
    const after = next.outbox[index]!;
    if (
      canonicalize(before.packet) !== canonicalize(after.packet) ||
      after.attempts < before.attempts ||
      after.updatedAt < before.updatedAt ||
      ((before.state === "acknowledged" || before.state === "rejected") &&
        canonicalize(before) !== canonicalize(after)) ||
      (before.state === "indeterminate" && after.state === "pending")
    ) {
      return "an existing outbox entry was replaced or rolled back";
    }
  }
  if (next.outbox.length === prior.outbox.length + 1) {
    const added = next.outbox.at(-1)!;
    if (added.state !== "pending" || added.attempts !== 0) {
      return "a new outbox entry did not begin as an unattempted intent";
    }
  }
  if (
    next.session.turnCount < prior.session.turnCount ||
    next.session.lastSequence < prior.session.lastSequence ||
    next.session.awaitingSince < prior.session.awaitingSince ||
    (prior.session.status !== "open" &&
      canonicalize(next.session) !== canonicalize(prior.session))
  ) {
    return "RFQ session checkpoint was rolled back or reopened";
  }
  if (
    prior.failure !== undefined &&
    canonicalize(next.failure) !== canonicalize(prior.failure)
  ) {
    return "terminal lifecycle failure was removed or replaced";
  }
  if (prior.agreement !== undefined) {
    if (
      next.agreement === undefined ||
      canonicalize(next.agreement.plan) !== canonicalize(prior.agreement.plan) ||
      !arrayPrefix(
        prior.agreement.contributions,
        next.agreement.contributions,
      ) ||
      (prior.agreement.finalized !== undefined &&
        canonicalize(next.agreement.finalized) !==
          canonicalize(prior.agreement.finalized))
    ) {
      return "agreement signing state was removed or replaced";
    }
  }
  return null;
}

function captureRecord<TSignature>(
  value: unknown,
): Readonly<DurableRfqLifecycleRecord<TSignature>> {
  const violation = durableRfqLifecycleRecordViolation<TSignature>(value);
  if (violation) throw new DacsError(`RFQ lifecycle ${violation}`);
  return snapshot(value, "RFQ lifecycle record") as Readonly<
    DurableRfqLifecycleRecord<TSignature>
  >;
}

function storeKey(role: DurableRfqLifecycleRole, jobId: string): string {
  return `${role}\u0000${jobId}`;
}

export function createInMemoryDurableRfqLifecycleStore<TSignature = unknown>():
  DurableRfqLifecycleStore<TSignature> {
  const records = new Map<string, DurableRfqLifecycleRecord<TSignature>>();
  return {
    load(role, jobId) {
      const existing = records.get(storeKey(role, jobId));
      if (!existing) return { status: "missing" };
      try {
        return { status: "ok", record: captureRecord<TSignature>(existing) };
      } catch (cause) {
        return {
          status: "corrupt",
          reason: cause instanceof Error ? cause.message : "record is corrupt",
        };
      }
    },
    create(candidate) {
      let record: Readonly<DurableRfqLifecycleRecord<TSignature>>;
      try {
        record = captureRecord(candidate);
      } catch (cause) {
        return {
          status: "corrupt",
          reason: cause instanceof Error ? cause.message : "record is corrupt",
        };
      }
      const key = storeKey(record.role, record.jobId);
      const existing = records.get(key);
      if (existing) {
        try {
          const owned = captureRecord<TSignature>(existing);
          return owned.bindingHash === record.bindingHash
            ? { status: "existing", record: owned }
            : { status: "conflict", reason: "jobId already binds another RFQ" };
        } catch (cause) {
          return {
            status: "corrupt",
            reason: cause instanceof Error ? cause.message : "record is corrupt",
          };
        }
      }
      records.set(key, structuredClone(record));
      return { status: "created", record };
    },
    compareAndSwap(role, jobId, expectedRevision, candidate) {
      const key = storeKey(role, jobId);
      const existing = records.get(key);
      if (!existing) return { status: "missing" };
      if (existing.revision !== expectedRevision) return { status: "stale" };
      let next: Readonly<DurableRfqLifecycleRecord<TSignature>>;
      try {
        next = captureRecord(candidate);
      } catch (cause) {
        return {
          status: "corrupt",
          reason: cause instanceof Error ? cause.message : "record is corrupt",
        };
      }
      if (
        next.role !== role ||
        next.jobId !== jobId ||
        next.revision !== expectedRevision + 1 ||
        next.bindingHash !== existing.bindingHash ||
        next.createdAt !== existing.createdAt ||
        next.updatedAt < existing.updatedAt
      ) {
        return { status: "corrupt", reason: "CAS attempted a non-monotonic write" };
      }
      const transitionViolation = durableRfqLifecycleTransitionViolation<TSignature>(
        existing,
        next,
      );
      if (transitionViolation !== null) {
        return { status: "corrupt", reason: transitionViolation };
      }
      records.set(key, structuredClone(next));
      return { status: "written", record: next };
    },
  };
}

/** Deterministic confidential-member queue for tests and local two-agent runs. */
export function createInMemoryRfqLifecycleNetwork<TSignature = unknown>():
  InMemoryRfqLifecycleNetwork<TSignature> {
  const packets = new Map<string, RfqLifecyclePacket<TSignature>>();
  const queues = new Map<string, string[]>();
  return {
    transport: {
      async publish(candidate) {
        let packet: RfqLifecyclePacket<TSignature>;
        try {
          packet = capturePacket(candidate);
        } catch (cause) {
          return {
            disposition: "rejected",
            reason: cause instanceof Error ? cause.message : "packet is malformed",
          };
        }
        const existing = packets.get(packet.packetId);
        if (existing !== undefined) {
          return canonicalize(existing) === canonicalize(packet)
            ? { disposition: "acknowledged" }
            : {
                disposition: "rejected",
                reason: "packetId is already bound to different bytes",
              };
        }
        packets.set(packet.packetId, structuredClone(packet));
        const queue = queues.get(packet.recipient) ?? [];
        queue.push(packet.packetId);
        queues.set(packet.recipient, queue);
        return { disposition: "acknowledged" };
      },
      async reconcile(candidate) {
        let packet: RfqLifecyclePacket<TSignature>;
        try {
          packet = capturePacket(candidate);
        } catch (cause) {
          return {
            disposition: "rejected",
            reason: cause instanceof Error ? cause.message : "packet is malformed",
          };
        }
        const existing = packets.get(packet.packetId);
        if (existing === undefined) return { disposition: "absent" };
        return canonicalize(existing) === canonicalize(packet)
          ? { disposition: "acknowledged" }
          : {
              disposition: "rejected",
              reason: "packetId is bound to different bytes",
            };
      },
    },
    take(recipient) {
      const queue = queues.get(recipient);
      const packetId = queue?.shift();
      if (packetId === undefined) return undefined;
      const packet = packets.get(packetId);
      return packet === undefined
        ? undefined
        : capturePacket<TSignature>(packet);
    },
    pending(recipient) {
      return queues.get(recipient)?.length ?? 0;
    },
  };
}

function loadFailure<TSignature>(
  loaded: Exclude<DurableRfqRecordLoad<TSignature>, { status: "ok" }>,
): DurableRfqLifecycleResult<TSignature> {
  if (loaded.status === "missing") {
    return { status: "rejected", reason: "RFQ lifecycle job does not exist" };
  }
  if (loaded.status === "unavailable") {
    return { status: "indeterminate", reason: loaded.reason };
  }
  return {
    status: "rejected",
    reason:
      loaded.status === "unsupported"
        ? `RFQ lifecycle store version ${loaded.version} is unsupported`
        : loaded.reason,
  };
}

function admissionFailure<TSignature>(input: {
  decision: "fail" | "indeterminate" | "error";
  reason: string;
}, record?: Readonly<DurableRfqLifecycleRecord<TSignature>>):
  DurableRfqLifecycleResult<TSignature> {
  return {
    status: input.decision === "indeterminate" ? "indeterminate" : "rejected",
    reason: input.reason,
    ...(record === undefined ? {} : { record }),
  };
}

function transportState(
  result: Exclude<RfqLifecycleTransportResult, { disposition: "absent" }>,
): RfqLifecycleOutboxState {
  return result.disposition === "acknowledged"
    ? "acknowledged"
    : result.disposition;
}

function packetReason(
  result: Exclude<RfqLifecycleTransportResult, { disposition: "absent" }>,
): string | undefined {
  return result.disposition === "acknowledged" ? undefined : result.reason;
}

function authorityFromInput(
  input: OpenDurableRfqLifecycleInput,
): DurableRfqAgreementAuthority {
  return snapshot(
    {
      verifiedListing: input.verifiedListing,
      buyer: input.buyer,
      seller: input.seller,
      ...(input.selectedRail === undefined
        ? {}
        : { selectedRail: input.selectedRail as PaymentRailRef }),
      ...(input.payoutBindings === undefined
        ? {}
        : { payoutBindings: input.payoutBindings as PayoutBinding[] }),
    },
    "RFQ agreement authority",
  );
}

function makePacket<TSignature>(
  record: Readonly<DurableRfqLifecycleRecord<TSignature>>,
  content:
    | { kind: "turn"; message: ChannelMessage<RfqTurnBody, TSignature> }
    | {
        kind: "agreement-proposal";
        plan: FixedPriceAgreementSigningPlan;
        buyerContribution: FixedPriceAgreementSignatureContribution;
      }
    | {
        kind: "agreement-contribution";
        sellerContribution: FixedPriceAgreementSignatureContribution;
      },
): Readonly<RfqLifecyclePacket<TSignature>> {
  return withPacketId({
    packetVersion: "1",
    jobId: record.jobId,
    channelId: record.channelId,
    sender: roleClaim(record, record.role),
    recipient: roleClaim(record, otherRole(record.role)),
    ...content,
  } as Omit<RfqLifecyclePacket<TSignature>, "packetId">);
}

function nextRecord<TSignature>(
  record: Readonly<DurableRfqLifecycleRecord<TSignature>>,
  now: number,
  patch: Partial<DurableRfqLifecycleRecord<TSignature>>,
): DurableRfqLifecycleRecord<TSignature> {
  return {
    ...structuredClone(record),
    ...structuredClone(patch),
    revision: record.revision + 1,
    updatedAt: Math.max(record.updatedAt, now),
  };
}

export function createDurableRfqLifecycleClient<TSignature = unknown>(
  options: DurableRfqLifecycleClientOptions<TSignature>,
): DurableRfqLifecycleClient<TSignature> {
  if (
    (options.role !== "buyer" && options.role !== "seller") ||
    options.store === null ||
    typeof options.store !== "object" ||
    nodeTypes.isProxy(options.store) ||
    typeof options.store.load !== "function" ||
    typeof options.store.create !== "function" ||
    typeof options.store.compareAndSwap !== "function" ||
    options.transport === null ||
    typeof options.transport !== "object" ||
    nodeTypes.isProxy(options.transport) ||
    typeof options.transport.publish !== "function" ||
    typeof options.transport.reconcile !== "function" ||
    typeof options.reserveChannelId !== "function" ||
    nodeTypes.isProxy(options.reserveChannelId) ||
    options.agreementSigner === null ||
    typeof options.agreementSigner !== "object" ||
    nodeTypes.isProxy(options.agreementSigner) ||
    !isNonEmptyCanonical(options.agreementSigner.party) ||
    typeof options.signChannelMessage !== "function" ||
    typeof options.verifyChannelMessage !== "function" ||
    typeof options.verifyAgreementContribution !== "function" ||
    typeof options.nowMs !== "function" ||
    nodeTypes.isProxy(options.signChannelMessage) ||
    nodeTypes.isProxy(options.verifyChannelMessage) ||
    nodeTypes.isProxy(options.verifyAgreementContribution) ||
    nodeTypes.isProxy(options.nowMs)
  ) {
    throw new DacsError("durable RFQ lifecycle options are malformed or unsafe");
  }
  const { role, store, transport } = options;

  function trustedNow(): number {
    const value = options.nowMs();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new DacsError("durable RFQ clock returned an invalid unix-ms value");
    }
    return value;
  }

  async function load(jobId: string) {
    try {
      return await store.load(role, jobId);
    } catch {
      return {
        status: "unavailable" as const,
        reason: "RFQ lifecycle store load failed",
      };
    }
  }

  async function write(
    prior: Readonly<DurableRfqLifecycleRecord<TSignature>>,
    next: Readonly<DurableRfqLifecycleRecord<TSignature>>,
  ): Promise<DurableRfqLifecycleResult<TSignature>> {
    let result: DurableRfqRecordWrite<TSignature>;
    try {
      result = await store.compareAndSwap(
        role,
        prior.jobId,
        prior.revision,
        next,
      );
    } catch {
      return { status: "indeterminate", reason: "RFQ lifecycle store write failed" };
    }
    if (result.status === "written") return { status: "ready", record: result.record };
    if (result.status === "stale") {
      return { status: "conflict", reason: "RFQ lifecycle state changed concurrently" };
    }
    if (result.status === "missing") {
      return { status: "rejected", reason: "RFQ lifecycle job disappeared" };
    }
    if (result.status === "unsupported") {
      return {
        status: "rejected",
        reason: `RFQ lifecycle store version ${result.version} is unsupported`,
      };
    }
    if (result.status === "unavailable") {
      return { status: "indeterminate", reason: result.reason };
    }
    return {
      status: "rejected",
      reason:
        "reason" in result
          ? result.reason
          : "RFQ lifecycle state changed concurrently",
    };
  }

  async function updateOutbox(
    jobId: string,
    packetId: string,
    result: Exclude<RfqLifecycleTransportResult, { disposition: "absent" }>,
  ): Promise<DurableRfqLifecycleResult<TSignature>> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const loaded = await load(jobId);
      if (loaded.status !== "ok") return loadFailure(loaded);
      const index = loaded.record.outbox.findIndex(
        (entry) => entry.packet.packetId === packetId,
      );
      if (index < 0) {
        return { status: "rejected", reason: "RFQ outbox packet is missing" };
      }
      const current = loaded.record.outbox[index]!;
      if (current.state === "acknowledged") {
        return { status: "ready", record: loaded.record };
      }
      if (current.state === "rejected") {
        return {
          status: "rejected",
          reason: current.reason ?? "RFQ transport permanently rejected packet",
          record: loaded.record,
        };
      }
      const outbox = structuredClone(loaded.record.outbox);
      let observedAt: number;
      try {
        observedAt = trustedNow();
      } catch (cause) {
        return {
          status: "rejected",
          reason: cause instanceof Error ? cause.message : "RFQ clock failed",
          record: loaded.record,
        };
      }
      outbox[index] = {
        ...outbox[index]!,
        state: transportState(result),
        attempts: outbox[index]!.attempts + 1,
        updatedAt: observedAt,
        ...(packetReason(result) === undefined
          ? { reason: undefined }
          : { reason: packetReason(result) }),
      };
      if (outbox[index]!.reason === undefined) delete outbox[index]!.reason;
      let written: DurableRfqRecordWrite<TSignature>;
      try {
        written = await store.compareAndSwap(
          role,
          jobId,
          loaded.record.revision,
          nextRecord(loaded.record, observedAt, {
            outbox,
            ...(result.disposition === "rejected"
              ? {
                  failure: {
                    failureVersion: "1" as const,
                    class: "transport" as const,
                    packetId,
                    reason: result.reason,
                    recordedAt: observedAt,
                  },
                }
              : {}),
          }),
        );
      } catch {
        return {
          status: "indeterminate",
          reason: "RFQ lifecycle store write failed after transport publication",
        };
      }
      if (written.status === "stale") continue;
      if (written.status === "written") {
        return {
          status:
            result.disposition === "acknowledged"
              ? "ready"
              : result.disposition,
          ...(result.disposition === "acknowledged" ? {} : { reason: result.reason }),
          record: written.record,
        } as DurableRfqLifecycleResult<TSignature>;
      }
      if (written.status === "missing") {
        return { status: "rejected", reason: "RFQ lifecycle job disappeared" };
      }
      if (written.status === "unsupported") {
        return {
          status: "rejected",
          reason: `RFQ lifecycle store version ${written.version} is unsupported`,
        };
      }
      if (written.status === "unavailable") {
        return { status: "indeterminate", reason: written.reason };
      }
      return {
        status: "rejected",
        reason:
          "reason" in written
            ? written.reason
            : "RFQ lifecycle state changed concurrently",
      };
    }
    return { status: "conflict", reason: "RFQ outbox CAS retry limit reached" };
  }

  async function publishPacket(
    packet: Readonly<RfqLifecyclePacket<TSignature>>,
  ): Promise<DurableRfqLifecycleResult<TSignature>> {
    let result: Exclude<RfqLifecycleTransportResult, { disposition: "absent" }>;
    try {
      result = await transport.publish(packet);
    } catch {
      result = { disposition: "indeterminate", reason: "RFQ transport publish threw" };
    }
    if (
      result.disposition !== "acknowledged" &&
      result.disposition !== "rejected" &&
      result.disposition !== "indeterminate"
    ) {
      result = {
        disposition: "indeterminate",
        reason: "RFQ transport returned malformed publication state",
      };
    }
    return updateOutbox(packet.jobId, packet.packetId, result);
  }

  async function enqueueTurn(
    jobId: string,
    type: "offer" | "counter" | "accept" | "reject" | "abort",
    body: RfqTurnBody,
  ): Promise<DurableRfqLifecycleResult<TSignature>> {
    const loaded = await load(jobId);
    if (loaded.status !== "ok") return loadFailure(loaded);
    const record = loaded.record;
    if (record.failure !== undefined) {
      return {
        status: "rejected",
        reason: record.failure.reason,
        record,
      };
    }
    if (record.session.status !== "open") {
      return { status: "rejected", reason: "RFQ session is already terminal", record };
    }
    const sender = roleClaim(record, role);
    if (record.session.expectedSender !== sender) {
      return { status: "rejected", reason: "counterparty owns the next RFQ turn", record };
    }
    let sentAt: number;
    try {
      sentAt = trustedNow();
    } catch (cause) {
      return {
        status: "rejected",
        reason: cause instanceof Error ? cause.message : "RFQ clock failed",
        record,
      };
    }
    const repliesTo = record.session.standingProposal?.sequence;
    const unsigned = {
      channelId: record.channelId,
      sequence: record.session.lastSequence + 1,
      sender,
      sentAt,
      type,
      body: structuredClone(body),
      ...(repliesTo === undefined ? {} : { refs: { repliesTo } }),
    };
    let signingInput: Readonly<ChannelMessageSigningInput<RfqTurnBody>>;
    let signature: TSignature;
    try {
      signingInput = prepareChannelMessageSigningInput<RfqTurnBody>(unsigned);
      signature = await options.signChannelMessage(signingInput);
    } catch {
      return { status: "rejected", reason: "RFQ channel signing failed", record };
    }
    const message = snapshot(
      { ...signingInput.unsignedEnvelope, signature },
      "signed RFQ turn",
    ) as ChannelMessage<RfqTurnBody, TSignature>;
    const advanced = await advanceRfqSession<TSignature>(
      record.session,
      structuredClone(message),
      sentAt,
      options.verifyChannelMessage,
    );
    if (advanced.decision !== "pass") {
      return admissionFailure(advanced, record);
    }
    if (
      advanced.state.status === "timed-out" &&
      advanced.state.turnCount === record.session.turnCount
    ) {
      const timedOut = await write(
        record,
        nextRecord(record, sentAt, {
          session: advanced.state as RfqSessionState,
          failure: {
            failureVersion: "1",
            class: "timeout",
            reason: advanced.state.terminalReason ?? "RFQ turn timeout elapsed",
            recordedAt: sentAt,
          },
        }),
      );
      return timedOut.status === "ready"
        ? {
            status: "rejected",
            reason: advanced.state.terminalReason ?? "RFQ turn timeout elapsed",
            record: timedOut.record,
          }
        : timedOut;
    }
    const packet = makePacket(record, { kind: "turn", message });
    const outbox = [
      ...structuredClone(record.outbox),
      { packet, state: "pending" as const, attempts: 0, updatedAt: sentAt },
    ];
    const staged = await write(
      record,
      nextRecord(record, sentAt, {
        session: advanced.state as RfqSessionState,
        transcript: [...structuredClone(record.transcript), message],
        outbox,
      }),
    );
    if (staged.status !== "ready") return staged;
    return publishPacket(packet);
  }

  async function receiveTurn(
    record: Readonly<DurableRfqLifecycleRecord<TSignature>>,
    packet: RfqLifecycleTurnPacket<TSignature>,
    receivedAt: number,
  ): Promise<DurableRfqLifecycleResult<TSignature>> {
    const advanced = await advanceRfqSession<TSignature>(
      record.session,
      structuredClone(packet.message),
      receivedAt,
      options.verifyChannelMessage,
    );
    if (advanced.decision !== "pass") {
      return admissionFailure(advanced, record);
    }
    if (
      advanced.state.status === "timed-out" &&
      advanced.state.turnCount === record.session.turnCount
    ) {
      const timedOut = await write(
        record,
        nextRecord(record, receivedAt, {
          session: advanced.state as RfqSessionState,
          failure: {
            failureVersion: "1",
            class: "timeout",
            reason: advanced.state.terminalReason ?? "RFQ turn timeout elapsed",
            recordedAt: receivedAt,
          },
        }),
      );
      return timedOut.status === "ready"
        ? {
            status: "rejected",
            reason: advanced.state.terminalReason ?? "RFQ turn timeout elapsed",
            record: timedOut.record,
          }
        : timedOut;
    }
    return write(
      record,
      nextRecord(record, receivedAt, {
        session: advanced.state as RfqSessionState,
        transcript: [...structuredClone(record.transcript), packet.message],
        inboxPacketIds: [...record.inboxPacketIds, packet.packetId],
      }),
    );
  }

  async function receiveAgreementProposal(
    record: Readonly<DurableRfqLifecycleRecord<TSignature>>,
    packet: RfqLifecycleAgreementProposalPacket,
    receivedAt: number,
  ): Promise<DurableRfqLifecycleResult<TSignature>> {
    if (role !== "seller" || record.session.status !== "accepted") {
      return { status: "rejected", reason: "agreement proposal is not expected", record };
    }
    let expectedPlan: Readonly<FixedPriceAgreementSigningPlan>;
    let sellerContribution: Readonly<FixedPriceAgreementSignatureContribution>;
    let finalized: AgreementArtifact;
    try {
      const expectedDraft = deriveRfqAgreement({
        ...record.authority,
        session: record.session,
        generatedAt: packet.plan.draft.generatedAt,
      });
      expectedPlan = createFixedPriceAgreementSigningPlan(expectedDraft);
      if (canonicalize(expectedPlan) !== canonicalize(packet.plan)) {
        throw new DacsError("buyer substituted the RFQ agreement signing plan");
      }
      sellerContribution = await createFixedPriceAgreementSignatureContribution(
        expectedPlan,
        "seller",
        options.agreementSigner,
      );
      finalized = await finalizeFixedPriceAgreementContributions(
        expectedPlan,
        [packet.buyerContribution, sellerContribution],
        options.verifyAgreementContribution,
      );
    } catch (cause) {
      return {
        status: "rejected",
        reason: cause instanceof Error ? cause.message : "agreement proposal is invalid",
        record,
      };
    }
    const response = makePacket(record, {
      kind: "agreement-contribution",
      sellerContribution,
    });
    const outbox = [
      ...structuredClone(record.outbox),
      { packet: response, state: "pending" as const, attempts: 0, updatedAt: receivedAt },
    ];
    const staged = await write(
      record,
      nextRecord(record, receivedAt, {
        inboxPacketIds: [...record.inboxPacketIds, packet.packetId],
        outbox,
        agreement: {
          plan: expectedPlan,
          contributions: [packet.buyerContribution, sellerContribution],
          finalized,
        },
      }),
    );
    if (staged.status !== "ready") return staged;
    return publishPacket(response);
  }

  async function receiveAgreementContribution(
    record: Readonly<DurableRfqLifecycleRecord<TSignature>>,
    packet: RfqLifecycleAgreementContributionPacket,
    receivedAt: number,
  ): Promise<DurableRfqLifecycleResult<TSignature>> {
    if (
      role !== "buyer" ||
      record.session.status !== "accepted" ||
      record.agreement === undefined ||
      record.agreement.contributions.length !== 1
    ) {
      return { status: "rejected", reason: "seller contribution is not expected", record };
    }
    let finalized: AgreementArtifact;
    try {
      finalized = await finalizeFixedPriceAgreementContributions(
        record.agreement.plan,
        [record.agreement.contributions[0]!, packet.sellerContribution],
        options.verifyAgreementContribution,
      );
    } catch (cause) {
      return {
        status: "rejected",
        reason: cause instanceof Error ? cause.message : "seller contribution is invalid",
        record,
      };
    }
    return write(
      record,
      nextRecord(record, receivedAt, {
        inboxPacketIds: [...record.inboxPacketIds, packet.packetId],
        agreement: {
          plan: record.agreement.plan,
          contributions: [
            record.agreement.contributions[0]!,
            packet.sellerContribution,
          ],
          finalized,
        },
      }),
    );
  }

  return {
    async open(callerInput) {
      let input: OpenDurableRfqLifecycleInput;
      try {
        input = snapshot(callerInput, "durable RFQ open input");
      } catch {
        return { status: "rejected", reason: "durable RFQ open input is malformed" };
      }
      let startedAt: number;
      try {
        startedAt = trustedNow();
      } catch (cause) {
        return {
          status: "rejected",
          reason: cause instanceof Error ? cause.message : "RFQ clock failed",
        };
      }
      const opened = await openRfqSession(
        { ...structuredClone(input), startedAt },
        options.reserveChannelId,
      );
      if (opened.decision !== "pass") {
        return admissionFailure(opened);
      }
      const session = opened.state as RfqSessionState;
      const expectedClaim =
        role === "buyer" ? session.buyer.primaryClaim : session.seller.primaryClaim;
      if (options.agreementSigner.party !== expectedClaim) {
        return { status: "rejected", reason: "agreement signer does not own local RFQ role" };
      }
      const record: DurableRfqLifecycleRecord<TSignature> = {
        storeVersion: DURABLE_RFQ_LIFECYCLE_STORE_VERSION,
        revision: 0,
        role,
        jobId: session.jobId,
        channelId: session.channelId,
        bindingHash: durableRfqLifecycleBindingHash(role, session),
        authority: authorityFromInput(input),
        session,
        transcript: [],
        inboxPacketIds: [],
        outbox: [],
        createdAt: session.startedAt,
        updatedAt: session.startedAt,
      };
      let created: DurableRfqRecordCreate<TSignature>;
      try {
        created = await store.create(record);
      } catch {
        return {
          status: "indeterminate",
          reason: "RFQ lifecycle store create failed",
        };
      }
      if (created.status === "created" || created.status === "existing") {
        return { status: created.status === "created" ? "ready" : "duplicate", record: created.record };
      }
      if (created.status === "unsupported") {
        return {
          status: "rejected",
          reason: `RFQ lifecycle store version ${created.version} is unsupported`,
        };
      }
      if (created.status === "unavailable") {
        return { status: "indeterminate", reason: created.reason };
      }
      return {
        status: created.status === "conflict" ? "conflict" : "rejected",
        reason:
          "reason" in created
            ? created.reason
            : "RFQ lifecycle record already exists",
      };
    },
    sendOffer(jobId, proposal) {
      return enqueueTurn(jobId, "offer", { rfqBodyVersion: "1", proposal });
    },
    sendCounter(jobId, proposal) {
      return enqueueTurn(jobId, "counter", { rfqBodyVersion: "1", proposal });
    },
    async sendAccept(jobId) {
      const loaded = await load(jobId);
      if (loaded.status !== "ok") return loadFailure(loaded);
      const sequence = loaded.record.session.standingProposal?.sequence;
      if (sequence === undefined) {
        return { status: "rejected", reason: "RFQ has no proposal to accept", record: loaded.record };
      }
      return enqueueTurn(
        jobId,
        "accept",
        { rfqBodyVersion: "1", acceptedSequence: sequence },
      );
    },
    sendReject(jobId, reason) {
      return enqueueTurn(
        jobId,
        "reject",
        { rfqBodyVersion: "1", ...(reason === undefined ? {} : { reason }) },
      );
    },
    sendAbort(jobId, reason) {
      return enqueueTurn(
        jobId,
        "abort",
        { rfqBodyVersion: "1", ...(reason === undefined ? {} : { reason }) },
      );
    },
    async respond(jobId, policy) {
      if (typeof policy !== "function" || nodeTypes.isProxy(policy)) {
        return { status: "rejected", reason: "RFQ response policy is unsafe" };
      }
      const loaded = await load(jobId);
      if (loaded.status !== "ok") return loadFailure(loaded);
      let decision: RfqLifecyclePolicyDecision;
      try {
        decision = snapshot(
          await policy(deepFreeze({ role, session: loaded.record.session })),
          "RFQ policy decision",
        );
      } catch {
        return { status: "rejected", reason: "RFQ response policy failed", record: loaded.record };
      }
      if (decision.action === "counter") {
        return enqueueTurn(jobId, "counter", {
          rfqBodyVersion: "1",
          proposal: decision.proposal,
        });
      }
      if (decision.action === "accept") {
        const sequence = loaded.record.session.standingProposal?.sequence;
        return sequence === undefined
          ? {
              status: "rejected",
              reason: "RFQ has no proposal to accept",
              record: loaded.record,
            }
          : enqueueTurn(jobId, "accept", {
              rfqBodyVersion: "1",
              acceptedSequence: sequence,
            });
      }
      if (decision.action === "reject") {
        return enqueueTurn(jobId, "reject", {
          rfqBodyVersion: "1",
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        });
      }
      if (decision.action === "abort") {
        return enqueueTurn(jobId, "abort", {
          rfqBodyVersion: "1",
          ...(decision.reason === undefined ? {} : { reason: decision.reason }),
        });
      }
      return { status: "rejected", reason: "RFQ policy returned an unknown action" };
    },
    async receive(candidate) {
      let packet: RfqLifecyclePacket<TSignature>;
      try {
        packet = capturePacket(candidate);
      } catch (cause) {
        return {
          status: "rejected",
          reason: cause instanceof Error ? cause.message : "RFQ packet is malformed",
        };
      }
      let receivedAt: number;
      try {
        receivedAt = trustedNow();
      } catch (cause) {
        return {
          status: "rejected",
          reason: cause instanceof Error ? cause.message : "RFQ clock failed",
        };
      }
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const loaded = await load(packet.jobId);
        if (loaded.status !== "ok") return loadFailure(loaded);
        const record = loaded.record;
        if (record.failure !== undefined) {
          return {
            status: "rejected",
            reason: record.failure.reason,
            record,
          };
        }
        if (
          packet.channelId !== record.channelId ||
          packet.recipient !== roleClaim(record, role) ||
          packet.sender !== roleClaim(record, otherRole(role))
        ) {
          return { status: "rejected", reason: "RFQ packet routing does not bind this session", record };
        }
        if (record.inboxPacketIds.includes(packet.packetId)) {
          return { status: "duplicate", record };
        }
        const result =
          packet.kind === "turn"
            ? await receiveTurn(record, packet, receivedAt)
            : packet.kind === "agreement-proposal"
              ? await receiveAgreementProposal(record, packet, receivedAt)
              : await receiveAgreementContribution(record, packet, receivedAt);
        if (result.status !== "conflict") return result;
      }
      return { status: "conflict", reason: "RFQ receive CAS retry limit reached" };
    },
    async resumeOutbox(jobId) {
      const loaded = await load(jobId);
      if (loaded.status !== "ok") return loadFailure(loaded);
      if (loaded.record.failure !== undefined) {
        return {
          status: "rejected",
          reason: loaded.record.failure.reason,
          record: loaded.record,
        };
      }
      const pending = loaded.record.outbox.filter(
        (entry) => entry.state !== "acknowledged" && entry.state !== "rejected",
      );
      if (pending.length === 0) return { status: "ready", record: loaded.record };
      let latest: DurableRfqLifecycleResult<TSignature> = {
        status: "ready",
        record: loaded.record,
      };
      for (const entry of pending) {
        let reconciled: RfqLifecycleTransportResult;
        try {
          reconciled = await transport.reconcile(entry.packet);
        } catch {
          reconciled = { disposition: "indeterminate", reason: "RFQ reconciliation threw" };
        }
        if (reconciled.disposition === "absent") {
          latest = await publishPacket(entry.packet);
        } else if (
          reconciled.disposition === "acknowledged" ||
          reconciled.disposition === "rejected" ||
          reconciled.disposition === "indeterminate"
        ) {
          latest = await updateOutbox(jobId, entry.packet.packetId, reconciled);
        } else {
          latest = await updateOutbox(jobId, entry.packet.packetId, {
            disposition: "indeterminate",
            reason: "RFQ reconciliation returned malformed state",
          });
        }
        if (latest.status !== "ready") return latest;
      }
      return latest;
    },
    async startAgreement(jobId) {
      const loaded = await load(jobId);
      if (loaded.status !== "ok") return loadFailure(loaded);
      const record = loaded.record;
      if (record.failure !== undefined) {
        return { status: "rejected", reason: record.failure.reason, record };
      }
      if (role !== "buyer" || record.session.status !== "accepted") {
        return { status: "rejected", reason: "buyer may start agreement only after RFQ acceptance", record };
      }
      if (record.agreement !== undefined) {
        return { status: "duplicate", record };
      }
      let generatedAt: number;
      try {
        generatedAt = trustedNow();
      } catch (cause) {
        return {
          status: "rejected",
          reason: cause instanceof Error ? cause.message : "RFQ clock failed",
          record,
        };
      }
      let plan: Readonly<FixedPriceAgreementSigningPlan>;
      let buyerContribution: Readonly<FixedPriceAgreementSignatureContribution>;
      try {
        const draft = deriveRfqAgreement({
          ...record.authority,
          session: record.session,
          generatedAt,
        });
        plan = createFixedPriceAgreementSigningPlan(draft);
        buyerContribution = await createFixedPriceAgreementSignatureContribution(
          plan,
          "buyer",
          options.agreementSigner,
        );
      } catch (cause) {
        return {
          status: "rejected",
          reason: cause instanceof Error ? cause.message : "RFQ agreement preparation failed",
          record,
        };
      }
      const packet = makePacket(record, {
        kind: "agreement-proposal",
        plan,
        buyerContribution,
      });
      const staged = await write(
        record,
        nextRecord(record, generatedAt, {
          agreement: { plan, contributions: [buyerContribution] },
          outbox: [
            ...structuredClone(record.outbox),
            { packet, state: "pending", attempts: 0, updatedAt: generatedAt },
          ],
        }),
      );
      if (staged.status !== "ready") return staged;
      return publishPacket(packet);
    },
    getStatus(jobId) {
      return load(jobId);
    },
  };
}
