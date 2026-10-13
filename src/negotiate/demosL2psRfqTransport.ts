import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";
import { types as nodeTypes } from "node:util";

import { canonicalize } from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError, TransientError } from "../errors.js";
import {
  parseRfqLifecyclePacket,
  type DurableRfqLifecycleResult,
  type DurableRfqLifecycleTransport,
  type RfqLifecyclePacket,
  type RfqLifecycleTransportResult,
} from "./durableRfqLifecycle.js";

const AES_ALGORITHM: CipherGCMTypes = "aes-256-gcm";
const AES_KEY_BYTES = 32;
const AES_NONCE_BYTES = 12;
const AES_TAG_BYTES = 16;
const MAX_RFQ_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_RFQ_PLAINTEXT_BYTES + AES_TAG_BYTES;
const MAX_NONCE_BYTES = 64;
const MAX_CANONICAL_STRING_CHARS = 16_384;
const MAX_EPHEMERAL_KEY_CHARS = 4_096;
/**
 * One history page may carry a maximum-size frame plus ordinary ones. A page
 * over this budget is refused before the deep snapshot; a smaller
 * historyPageSize splits large frames across pages.
 */
const MAX_HISTORY_PAGE_CHARS = 32 * 1024 * 1024;
// Include the active ingest in both limits. Charge two bytes per string code
// unit plus 1 KiB per event for the bounded record/queue metadata.
const MAX_LIVE_EVENTS = 100;
const MAX_LIVE_BYTES = 64 * 1024 * 1024;
const WIRE_DOMAIN = "dacs-rfq-l2ps-wire:v1";
const HASH = /^[0-9a-f]{64}$/;
const PEER_KEY = /^[0-9a-f]{64,}$/;
// Matched against a WHATWG-parsed hostname, where IPv4 is already dotted
// decimal (127.1 and 0x7f000001 become 127.0.0.1).
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const DEFAULT_HISTORY_PAGE_SIZE = 100;
const DEFAULT_HISTORY_MAX_PAGES = 100;
const DEFAULT_OPERATION_TIMEOUT_MS = 20_000;
const DEFAULT_CONSUMER_TIMEOUT_MS = 30_000;
// Only reduces noise. Resend safety rests on node 61b8e75's unique
// messageHash (the packet ID) and byte-identical resends; no finite grace
// bounds a late send (docs/rfq-negotiation-core.md).
const DEFAULT_SEND_ABSENCE_GRACE_MS = 60_000;
const SEND_ABSENCE_REASON =
  "Demos L2PS history cannot yet prove packet absence after a timed-out send";
// The node's error text, which demosdk rejects with unchanged (node 61b8e75
// L2PSMessagingService.ts:51,143; demosdk L2PSMessagingPeer.js:324-330).
const NODE_DUPLICATE_MESSAGE = "Duplicate message";
const DUPLICATE_REASON =
  "Demos L2PS refused the packet hash as a duplicate that history does not show";
const STORED_FRAME_REASON =
  "Demos L2PS RFQ stored send frame does not open to this packet";
const CONSUMER_TIMEOUT_MESSAGE = "Demos L2PS RFQ consumer timed out";
const HISTORY_STATUSES = new Set<DemosL2psRfqMessageStatus>([
  "delivered",
  "queued",
  "sent",
  "failed",
  "l2ps_pending",
  "l2ps_batched",
  "l2ps_confirmed",
]);
const HISTORY_ENTRY_KEYS = [
  "id",
  "from",
  "to",
  "messageHash",
  "encrypted",
  "l2psUid",
  "l2psTxHash",
  "timestamp",
  "status",
] as const;

type JsonRecord = Record<string, unknown>;

class TransientTransportCapabilityError extends DacsError {}
class OperationTimeoutError extends DacsError {}
class ConsumerTimeoutError extends TransientError {}
/** The built-in codec proved a stored frame cannot open for its route. */
class WireFrameAuthenticationError extends DacsError {}

const PEER_CHANNEL_MESSAGES = {
  unstated:
    'Demos L2PS RFQ peer does not expose its URL; set peerChannel to "wss" or "loopback"',
  malformed: "Demos L2PS RFQ peer URL is malformed",
  insecure:
    "Demos L2PS RFQ peer URL must be wss://, or ws:// to a loopback IP literal (127.0.0.0/8 or [::1])",
  mismatch: "Demos L2PS RFQ peerChannel does not match the peer's URL",
} as const;

/**
 * Construction refused the peer's channel to its node. The message never
 * repeats the URL, which may carry credentials.
 */
export class DemosL2psRfqPeerChannelError extends DacsError {
  constructor(readonly code: keyof typeof PEER_CHANNEL_MESSAGES) {
    super(PEER_CHANNEL_MESSAGES[code]);
    this.name = "DemosL2psRfqPeerChannelError";
  }
}

export interface DemosL2psRfqEncryptedMessage {
  ciphertext: string;
  nonce: string;
  ephemeralKey?: string;
}

export interface DemosL2psRfqIncomingPayload {
  from: string;
  encrypted: DemosL2psRfqEncryptedMessage;
  messageHash: string;
  offline?: boolean;
}

export type DemosL2psRfqMessageStatus =
  | "delivered"
  | "queued"
  | "sent"
  | "failed"
  | "l2ps_pending"
  | "l2ps_batched"
  | "l2ps_confirmed";

export interface DemosL2psRfqStoredMessage {
  id: string;
  from: string;
  to: string;
  messageHash: string;
  encrypted: DemosL2psRfqEncryptedMessage;
  l2psUid: string;
  l2psTxHash: string | null;
  timestamp: number;
  status: DemosL2psRfqMessageStatus;
}

export interface DemosL2psRfqHistoryPage {
  messages: DemosL2psRfqStoredMessage[];
  hasMore: boolean;
}

export type DemosL2psRfqSendResult =
  | { messageHash: string; l2psStatus: "submitted" | "failed" }
  | { messageHash: string; status: "queued" };

export type DemosL2psRfqMessageHandler = (
  payload: DemosL2psRfqIncomingPayload,
) => void;

/** Structural surface of demosdk 4.x L2PSMessagingPeer. */
export interface DemosL2psRfqPeerLike {
  readonly isConnected?: boolean;
  readonly isRegistered?: boolean;
  readonly peers?: string[];
  connect?(): Promise<{ success: boolean; [key: string]: unknown }>;
  disconnect?(): void;
  send(
    to: string,
    encrypted: DemosL2psRfqEncryptedMessage,
    messageHash: string,
  ): Promise<DemosL2psRfqSendResult>;
  history(
    peerKey: string,
    options?: { before?: number; limit?: number },
  ): Promise<DemosL2psRfqHistoryPage>;
  onMessage(handler: DemosL2psRfqMessageHandler): void;
  removeMessageHandler?(handler: DemosL2psRfqMessageHandler): void;
}

export interface DemosL2psRfqWireContext {
  messageHash: string;
  fromPeer: string;
  toPeer: string;
}

/**
 * The Demos server treats ciphertext as opaque. A codec must authenticate the
 * route context as well as the plaintext and use a fresh nonce for every seal.
 */
export interface DemosL2psRfqWireCodec {
  readonly codecId: string;
  seal(
    plaintext: Uint8Array,
    context: Readonly<DemosL2psRfqWireContext>,
  ):
    | Promise<Readonly<DemosL2psRfqEncryptedMessage>>
    | Readonly<DemosL2psRfqEncryptedMessage>;
  open(
    encrypted: Readonly<DemosL2psRfqEncryptedMessage>,
    context: Readonly<DemosL2psRfqWireContext>,
  ): Promise<Uint8Array> | Uint8Array;
}

export interface DemosL2psRfqAesGcmCodecOptions {
  /**
   * Exact role-shared L2PS subnet key. It is copied and never persisted.
   *
   * Reconciliation treats our own history frame that fails AES-GCM
   * authentication as a terminal conflict, and it cannot tell tampering from a
   * key change. Restarting with a wrong or rotated key therefore permanently
   * fails every job whose outbox still needs reconciliation; keep the old key
   * until those jobs have settled.
   */
  sharedKey: Uint8Array;
}

/** Private, role-local companion to the lifecycle's signed-packet outbox. */
type SendOutboxEntry = {
  packetId: string;
  fromPeer: string;
  toPeer: string;
  l2psUid: string;
  codecId: string;
  encrypted: DemosL2psRfqEncryptedMessage;
  /** "duplicate": the node refused the hash as already stored. */
  state: "sending" | "indeterminate" | "acknowledged" | "duplicate";
  /** 1 for the first committed entry, then +1 per committed save. */
  generation: number;
  attemptEndedAtMs?: number;
};

export interface DemosL2psRfqTransportOptions {
  /**
   * The peer, its WebSocket channel and the node behind it are the
   * acknowledgement authority. An acknowledgement is that node's unsigned
   * statement that it saved the message, and a stored one is final, so a
   * node that lies, or anyone who can rewrite frames on the channel, can make
   * the transport stop resending a message the recipient never received.
   * Connect the peer over authenticated wss:// to a node you trust (your own,
   * or one the operator pins), and use that same node for history and
   * reconcile. Plain ws:// is accepted only to a loopback IP literal.
   *
   * demosdk 4.0.16 declares the peer's config private, but at runtime the URL
   * it dials is the own data property config.serverUrl. That is not public
   * API. At construction the transport reads it through own data descriptors
   * only (no getter runs, no prototype is consulted) and refuses anything but
   * wss:// or ws:// to 127.0.0.0/8 or [::1] with a
   * DemosL2psRfqPeerChannelError; a readable value that is not a URL string
   * is refused too. A peer without a readable config.serverUrl, such as a
   * wrapper, must state its channel in `peerChannel`.
   */
  peer: DemosL2psRfqPeerLike;
  /**
   * The channel of a peer that does not expose its URL: "wss" for TLS to the
   * node, or "loopback" for plain ws:// to 127.0.0.0/8 or [::1]. "loopback" is
   * the only way to allow plain WebSocket for such a peer. Without a readable
   * URL or this option, construction fails. When the peer exposes its URL,
   * the URL decides and this option must match it.
   */
  peerChannel?: "wss" | "loopback";
  codec: DemosL2psRfqWireCodec;
  l2psUid: string;
  localClaim: string;
  /**
   * Hex public key, with or without 0x, in any case. The transport keeps every
   * peer key in the node's canonical form: lower-case hex without 0x.
   */
  localPeerKey: string;
  /** May return any accepted key form; the result is canonicalized. */
  peerForClaim(claim: string): string | undefined;
  /** Always called with a canonical key (lower-case hex, no 0x). */
  claimForPeer(peerKey: string): string | undefined;
  onError(error: Error): void;
  /**
   * Authenticated, durable, role-local send outbox, keyed by packetId. A
   * missing load returns undefined. Every save is a compare-and-swap: commit
   * the entry only if the stored generation (0 when there is no entry) equals
   * expectedGeneration, then resolve true; otherwise change nothing and
   * resolve false. Expected generation 0 matches only an absent entry; a
   * present entry with a missing or invalid generation never matches. Any
   * other result, including undefined from an older save(): void store,
   * counts as not committed. entry.generation is always
   * expectedGeneration + 1. Compare at commit time, atomically with the
   * write, so a save that commits after the transport stopped waiting can
   * never replace a newer generation. The host must serialize drivers of the
   * same outbox, including across processes. Retain entries until the
   * corresponding lifecycle job is retired. The entry type is not exported:
   * Parameters<DemosL2psRfqTransportOptions["outboxStore"]["save"]>[1] names it.
   */
  outboxStore: {
    load(packetId: string): Promise<unknown> | unknown;
    save(
      packetId: string,
      entry: Readonly<SendOutboxEntry>,
      expectedGeneration: number,
    ): Promise<boolean> | boolean;
  };
  /** Absence hold after an ambiguous send, default 60,000 ms; max 600,000. */
  sendAbsenceGraceMs?: number;
  /**
   * Trusted monotonic milliseconds with a common origin across process
   * restarts. Defaults to the host's process.hrtime clock (same machine boot).
   * A clock rollback conservatively starts a new grace period.
   */
  monotonicNowMs?: () => number;
  historyPageSize?: number;
  historyMaxPages?: number;
  operationTimeoutMs?: number;
  /**
   * Time limit for each inbound consumer call, live or recovered (default
   * 30,000 ms, at most 600,000 ms). The call's signal is aborted when it runs
   * out or stop() retires its generation; a later result is ignored.
   */
  consumerTimeoutMs?: number;
}

export interface DemosL2psRfqTransport<TSignature = unknown>
  extends DurableRfqLifecycleTransport<TSignature> {
  /**
   * Register one inbound consumer. Calling start twice is rejected. Each call
   * receives a signal that is aborted on consumerTimeoutMs or stop().
   */
  start(
    onPacket: (
      packet: Readonly<RfqLifecyclePacket<TSignature>>,
      options: { readonly signal: AbortSignal },
    ) =>
      | Promise<DurableRfqLifecycleResult<TSignature>>
      | DurableRfqLifecycleResult<TSignature>,
  ): void;
  /**
   * Replay role-bound inbound packets after a process restart. Each job's
   * packets are delivered in order. A packet the consumer does not accept
   * holds back only the later packets of its own job, which are reported in
   * `skipped`; other jobs are still delivered.
   */
  resumeInbound(remoteClaim: string): Promise<DemosL2psRfqInboundRecoveryResult>;
  /** Stop accepting inbound packets and detach when the peer supports it. */
  stop(): void;
  /**
   * Wait until every payload the peer delivered to the current generation has
   * been handled. Work retired by stop() is not awaited.
   */
  drain(): Promise<void>;
}

/** A job whose recovered packets were not all accepted by the consumer. */
export interface DemosL2psRfqInboundSkip {
  jobId: string;
  channelId: string;
  /** The first packet of the job that the consumer did not accept. */
  packetId: string;
  /** That packet plus the job's later packets; none of them was delivered. */
  packets: number;
  /** The consumer's reason, or why the consumer call failed. */
  reason: string;
}

/**
 * "complete": history was read to its end and every recovered packet was
 * handed to the consumer. A packet the lifecycle rejected (for example for a
 * job that is retired, not open yet, or failed) is listed in `skipped` and
 * does not make the call indeterminate. Any other uncertainty does.
 */
export type DemosL2psRfqInboundRecoveryResult =
  | { status: "complete"; delivered: number; skipped: DemosL2psRfqInboundSkip[] }
  | {
      status: "indeterminate";
      delivered: number;
      skipped: DemosL2psRfqInboundSkip[];
      reason: string;
    };

function isRecord(value: unknown): value is JsonRecord {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    nodeTypes.isProxy(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const permitted = new Set([...required, ...optional]);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => permitted.has(key))
  );
}

function ownedJson(value: unknown, label: string): unknown {
  try {
    return snapshotCanonicalJsonRead(value, label);
  } catch {
    throw new DacsError(`${label} is not owned canonical JSON data`);
  }
}

function canonicalString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CANONICAL_STRING_CHARS ||
    value.trim() !== value ||
    value.normalize("NFC") !== value
  ) {
    throw new DacsError(`${label} must be a non-empty canonical string`);
  }
  return value;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  label: string,
  maximum: number,
): number {
  const selected = value === undefined ? fallback : value;
  if (
    !Number.isSafeInteger(selected) ||
    (selected as number) <= 0 ||
    (selected as number) > maximum
  ) {
    throw new DacsError(`${label} must be a positive safe integer at most ${maximum}`);
  }
  return selected as number;
}

function base64Chars(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

function canonicalBase64(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > base64Chars(maximumBytes)
  ) {
    throw new DacsError(`${label} must be canonical Base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length === 0 ||
    decoded.length > maximumBytes ||
    decoded.toString("base64") !== value
  ) {
    throw new DacsError(`${label} must be canonical Base64`);
  }
  return value;
}

/**
 * Peer-supplied values are bounded by shape before the deep canonical snapshot
 * clones and serializes them. Only own data descriptors of plain records and
 * arrays are read, so no accessor or proxy trap runs; the snapshot and the
 * capture checks below still validate everything afterwards.
 */
function admittedFields(
  value: unknown,
  keys: readonly string[],
  label: string,
): JsonRecord {
  if (!isRecord(value)) throw new DacsError(`${label} is malformed`);
  const fields: JsonRecord = Object.create(null) as JsonRecord;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor =
      typeof key === "string" && keys.includes(key)
        ? Object.getOwnPropertyDescriptor(value, key)
        : undefined;
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new DacsError(`${label} is malformed`);
    }
    fields[key as string] = descriptor.value;
  }
  return fields;
}

function admittedChars(value: unknown, maximum: number, label: string): number {
  if (typeof value === "string") {
    if (value.length > maximum) throw new DacsError(`${label} exceeds its size limit`);
    return value.length;
  }
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    throw new DacsError(`${label} is malformed`);
  }
  return 0;
}

function admitEncrypted(value: unknown): number {
  const frame = admittedFields(
    value,
    ["ciphertext", "nonce", "ephemeralKey"],
    "Demos L2PS encrypted RFQ frame",
  );
  return (
    admittedChars(frame.ciphertext, base64Chars(MAX_CIPHERTEXT_BYTES), "ciphertext") +
    admittedChars(frame.nonce, base64Chars(MAX_NONCE_BYTES), "nonce") +
    admittedChars(frame.ephemeralKey, MAX_EPHEMERAL_KEY_CHARS, "ephemeralKey")
  );
}

function admitIncoming(value: unknown): number {
  const label = "Demos L2PS incoming RFQ payload";
  const payload = admittedFields(
    value,
    ["from", "encrypted", "messageHash", "offline"],
    label,
  );
  return 1024 + 2 * (
    admittedChars(payload.from, MAX_CANONICAL_STRING_CHARS, label) +
    admittedChars(payload.messageHash, MAX_CANONICAL_STRING_CHARS, label) +
    admittedChars(payload.offline, MAX_CANONICAL_STRING_CHARS, label) +
    admitEncrypted(payload.encrypted)
  );
}

function admitHistoryPage(value: unknown): void {
  const label = "Demos L2PS RFQ history response";
  const page = admittedFields(value, ["messages", "hasMore"], label);
  const messages = page.messages;
  if (
    typeof messages !== "object" ||
    messages === null ||
    nodeTypes.isProxy(messages) ||
    !Array.isArray(messages)
  ) {
    throw new DacsError(`${label} is malformed`);
  }
  const length = messages.length;
  if (length > DEFAULT_HISTORY_PAGE_SIZE) {
    throw new DacsError(`${label} exceeds ${DEFAULT_HISTORY_PAGE_SIZE} entries`);
  }
  if (Reflect.ownKeys(messages).length !== length + 1) {
    throw new DacsError(`${label} is malformed`);
  }
  let chars = admittedChars(page.hasMore, MAX_CANONICAL_STRING_CHARS, label);
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(messages, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new DacsError(`${label} is malformed`);
    }
    const entry = admittedFields(
      descriptor.value,
      HISTORY_ENTRY_KEYS,
      "Demos L2PS RFQ history entry",
    );
    for (const key of HISTORY_ENTRY_KEYS) {
      chars += key === "encrypted"
        ? admitEncrypted(entry[key])
        : admittedChars(entry[key], MAX_CANONICAL_STRING_CHARS, "Demos L2PS RFQ history entry");
    }
    if (chars > MAX_HISTORY_PAGE_CHARS) {
      throw new DacsError(`${label} exceeds its aggregate size budget`);
    }
  }
}

function captureEncrypted(value: unknown): DemosL2psRfqEncryptedMessage {
  admitEncrypted(value);
  value = ownedJson(value, "Demos L2PS encrypted RFQ frame");
  if (
    !isRecord(value) ||
    !exactKeys(value, ["ciphertext", "nonce"], ["ephemeralKey"])
  ) {
    throw new DacsError("Demos L2PS encrypted RFQ frame is malformed");
  }
  const encrypted: DemosL2psRfqEncryptedMessage = {
    ciphertext: canonicalBase64(value.ciphertext, "ciphertext", MAX_CIPHERTEXT_BYTES),
    nonce: canonicalBase64(value.nonce, "nonce", MAX_NONCE_BYTES),
  };
  if (value.ephemeralKey !== undefined) {
    if (
      typeof value.ephemeralKey !== "string" ||
      value.ephemeralKey.length > MAX_EPHEMERAL_KEY_CHARS
    ) {
      throw new DacsError("ephemeralKey is too large");
    }
    encrypted.ephemeralKey = canonicalString(value.ephemeralKey, "ephemeralKey");
  }
  return encrypted;
}

function captureContext(value: DemosL2psRfqWireContext): DemosL2psRfqWireContext {
  if (!isRecord(value) || !exactKeys(value, ["messageHash", "fromPeer", "toPeer"])) {
    throw new DacsError("Demos L2PS RFQ wire context is malformed");
  }
  if (!HASH.test(value.messageHash)) {
    throw new DacsError("Demos L2PS RFQ messageHash must be lowercase SHA-256");
  }
  const fromPeer = canonicalString(value.fromPeer, "fromPeer");
  const toPeer = canonicalString(value.toPeer, "toPeer");
  if (fromPeer === toPeer) {
    throw new DacsError("Demos L2PS RFQ wire route must cross two peers");
  }
  return { messageHash: value.messageHash, fromPeer, toPeer };
}

function wireAad(context: DemosL2psRfqWireContext): Buffer {
  return Buffer.from(
    canonicalize({ wireDomain: WIRE_DOMAIN, ...captureContext(context) }),
    "utf8",
  );
}

/** Demos messaging-compatible AES-256-GCM codec with route-bound AAD. */
export function createDemosL2psRfqAesGcmCodec(
  options: DemosL2psRfqAesGcmCodecOptions,
): DemosL2psRfqWireCodec {
  if (
    !isRecord(options) ||
    !exactKeys(options, ["sharedKey"]) ||
    !(options.sharedKey instanceof Uint8Array) ||
    nodeTypes.isProxy(options.sharedKey) ||
    options.sharedKey.byteLength !== AES_KEY_BYTES
  ) {
    throw new DacsError("Demos L2PS RFQ sharedKey must be exactly 32 bytes");
  }
  const key = Buffer.from(options.sharedKey);
  const codec: DemosL2psRfqWireCodec = {
    codecId: "demos-l2ps-aes-256-gcm:v1",
    seal(plaintext: Uint8Array, context: Readonly<DemosL2psRfqWireContext>) {
      if (
        !(plaintext instanceof Uint8Array) ||
        nodeTypes.isProxy(plaintext) ||
        plaintext.byteLength > MAX_RFQ_PLAINTEXT_BYTES
      ) {
        throw new DacsError("Demos L2PS RFQ plaintext must be bytes");
      }
      const nonce = randomBytes(AES_NONCE_BYTES);
      const cipher = createCipheriv(AES_ALGORITHM, key, nonce, {
        authTagLength: AES_TAG_BYTES,
      });
      cipher.setAAD(wireAad(context));
      const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(plaintext)),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return {
        ciphertext: ciphertext.toString("base64"),
        nonce: nonce.toString("base64"),
      };
    },
    open(
      candidate: Readonly<DemosL2psRfqEncryptedMessage>,
      context: Readonly<DemosL2psRfqWireContext>,
    ) {
      const encrypted = captureEncrypted(candidate);
      if (encrypted.ephemeralKey !== undefined) {
        throw new WireFrameAuthenticationError(
          "AES-GCM RFQ frames cannot contain an ephemeralKey",
        );
      }
      const nonce = Buffer.from(encrypted.nonce, "base64");
      const combined = Buffer.from(encrypted.ciphertext, "base64");
      if (nonce.length !== AES_NONCE_BYTES || combined.length < AES_TAG_BYTES) {
        throw new WireFrameAuthenticationError(
          "Demos L2PS AES-GCM RFQ frame has invalid lengths",
        );
      }
      const body = combined.subarray(0, combined.length - AES_TAG_BYTES);
      const tag = combined.subarray(combined.length - AES_TAG_BYTES);
      const decipher = createDecipheriv(AES_ALGORITHM, key, nonce, {
        authTagLength: AES_TAG_BYTES,
      });
      decipher.setAAD(wireAad(context));
      decipher.setAuthTag(tag);
      try {
        return Uint8Array.from(
          Buffer.concat([decipher.update(body), decipher.final()]),
        );
      } catch {
        throw new WireFrameAuthenticationError(
          "Demos L2PS AES-GCM RFQ authentication failed",
        );
      }
    },
  };
  return Object.freeze(codec);
}

function errorFrom(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new DacsError(fallback);
}

/**
 * Demos node 61b8e75 stores and returns peer keys as lower-case hex without a
 * 0x prefix (features/l2ps-messaging/keys.ts:13-16, L2PSMessagingService.ts:
 * 125-126) and registers only hex keys of at least 64 digits
 * (L2PSMessagingServer.ts:141-145). Every key is captured in that form, so
 * history, mapping and outbox comparisons match the node's rows.
 */
function capturePeerKey(value: unknown, label: string): string {
  const raw = canonicalString(value, label);
  const key = (raw.startsWith("0x") || raw.startsWith("0X") ? raw.slice(2) : raw).toLowerCase();
  if (!PEER_KEY.test(key)) throw new DacsError(`${label} must be a hex public key`);
  return key;
}

function isPeerKey(value: unknown, peerKey: string): boolean {
  try {
    return capturePeerKey(value, "peer key") === peerKey;
  } catch {
    return false;
  }
}

function encodePacket<TSignature>(
  value: unknown,
): { packet: Readonly<RfqLifecyclePacket<TSignature>>; bytes: Uint8Array } {
  const packet = parseRfqLifecyclePacket<TSignature>(value);
  const text = canonicalize(packet as unknown as JsonRecord);
  if (Buffer.byteLength(text, "utf8") > MAX_RFQ_PLAINTEXT_BYTES) {
    throw new DacsError("Demos L2PS RFQ packet exceeds the wire size limit");
  }
  return {
    packet,
    bytes: new TextEncoder().encode(text),
  };
}

function decodePacket<TSignature>(bytes: Uint8Array) {
  if (
    !(bytes instanceof Uint8Array) ||
    nodeTypes.isProxy(bytes) ||
    bytes.byteLength > MAX_RFQ_PLAINTEXT_BYTES
  ) {
    throw new DacsError("Demos L2PS RFQ plaintext exceeds the wire size limit");
  }
  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new DacsError("Demos L2PS RFQ plaintext is not valid UTF-8 JSON");
  }
  if (canonicalize(parsed) !== text) {
    throw new DacsError("Demos L2PS RFQ plaintext is not canonical JCS");
  }
  return parseRfqLifecyclePacket<TSignature>(parsed);
}

function captureSendResult(
  value: unknown,
  messageHash: string,
): "acknowledged" | "indeterminate" {
  // demosdk 4.0.16: instant_messaging/l2ps_types.d.ts:104-117;
  // L2PSMessagingPeer.js:116-126,319 returns frame.payload unchanged.
  // It is the node's unsigned reply (node 61b8e75 L2PSMessagingServer.ts:
  // 279-294,471-473), checked here only by shape and the echoed hash; the
  // trust rests on the peer's node and channel (see the `peer` option).
  try {
    const label = "Demos L2PS RFQ send acknowledgement";
    const fields = admittedFields(value, ["messageHash", "status", "l2psStatus"], label);
    for (const field of Object.values(fields)) {
      admittedChars(field, MAX_CANONICAL_STRING_CHARS, label);
    }
  } catch {
    return "indeterminate";
  }
  value = ownedJson(value, "Demos L2PS RFQ send acknowledgement");
  if (!isRecord(value) || value.messageHash !== messageHash) return "indeterminate";
  if (
    exactKeys(value, ["messageHash", "status"]) &&
    value.status === "queued"
  ) {
    return "acknowledged";
  }
  if (
    exactKeys(value, ["messageHash", "l2psStatus"]) &&
    (value.l2psStatus === "submitted" || value.l2psStatus === "failed")
  ) {
    return value.l2psStatus === "submitted" ? "acknowledged" : "indeterminate";
  }
  return "indeterminate";
}

function captureIncoming(value: unknown): DemosL2psRfqIncomingPayload {
  admitIncoming(value);
  value = ownedJson(value, "Demos L2PS incoming RFQ payload");
  if (
    !isRecord(value) ||
    !exactKeys(value, ["from", "encrypted", "messageHash"], ["offline"]) ||
    !HASH.test(value.messageHash as string) ||
    (value.offline !== undefined && typeof value.offline !== "boolean")
  ) {
    throw new DacsError("Demos L2PS incoming RFQ payload is malformed");
  }
  return {
    from: capturePeerKey(value.from, "incoming peer"),
    encrypted: captureEncrypted(value.encrypted),
    messageHash: value.messageHash as string,
    ...(value.offline === undefined ? {} : { offline: value.offline as boolean }),
  };
}

function captureHistoryPage(value: unknown): DemosL2psRfqHistoryPage {
  admitHistoryPage(value);
  value = ownedJson(value, "Demos L2PS RFQ history response");
  if (
    !isRecord(value) ||
    !exactKeys(value, ["messages", "hasMore"]) ||
    !Array.isArray(value.messages) ||
    value.messages.length > DEFAULT_HISTORY_PAGE_SIZE ||
    typeof value.hasMore !== "boolean"
  ) {
    throw new DacsError("Demos L2PS RFQ history response is malformed");
  }
  const messages = value.messages.map((candidate): DemosL2psRfqStoredMessage => {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, HISTORY_ENTRY_KEYS) ||
      !HASH.test(candidate.messageHash as string) ||
      !Number.isSafeInteger(candidate.timestamp) ||
      (candidate.timestamp as number) < 0 ||
      (candidate.l2psTxHash !== null && typeof candidate.l2psTxHash !== "string") ||
      !HISTORY_STATUSES.has(candidate.status as DemosL2psRfqMessageStatus)
    ) {
      throw new DacsError("Demos L2PS RFQ history entry is malformed");
    }
    return {
      id: canonicalString(candidate.id, "history id"),
      from: capturePeerKey(candidate.from, "history sender"),
      to: capturePeerKey(candidate.to, "history recipient"),
      messageHash: candidate.messageHash as string,
      encrypted: captureEncrypted(candidate.encrypted),
      l2psUid: canonicalString(candidate.l2psUid, "history L2PS UID"),
      l2psTxHash:
        candidate.l2psTxHash === null
          ? null
          : canonicalString(candidate.l2psTxHash, "history L2PS transaction hash"),
      timestamp: candidate.timestamp as number,
      status: candidate.status as DemosL2psRfqMessageStatus,
    };
  });
  return { messages, hasMore: value.hasMore };
}

/** An own data property of a non-proxy object; no getter or trap runs. */
function ownData(target: object, key: string): { value: unknown } | undefined {
  if (nodeTypes.isProxy(target)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && "value" in descriptor
    ? { value: descriptor.value }
    : undefined;
}

/**
 * demosdk 4.0.16 keeps the URL it dials on every (re)connect in the own data
 * property config.serverUrl (L2PSMessagingPeer.js:37,223). The WebSocket
 * client parses it with the same WHATWG URL parser used here. "localhost" is
 * a name the system resolver maps, not a loopback literal, so it is refused.
 */
function checkPeerChannel(peer: object, stated: unknown): void {
  if (stated !== undefined && stated !== "wss" && stated !== "loopback") {
    throw new DacsError('Demos L2PS RFQ peerChannel must be "wss" or "loopback"');
  }
  const config = ownData(peer, "config")?.value;
  const serverUrl = typeof config === "object" && config !== null
    ? ownData(config, "serverUrl")
    : undefined;
  if (serverUrl === undefined) {
    if (stated === undefined) throw new DemosL2psRfqPeerChannelError("unstated");
    return;
  }
  // A readable value that is not a URL string is refused, never deferred to
  // peerChannel: the peer dials it all the same.
  if (typeof serverUrl.value !== "string") {
    throw new DemosL2psRfqPeerChannelError("malformed");
  }
  let url: URL;
  try {
    url = new URL(serverUrl.value);
  } catch {
    // The parser's error carries the input, so it is never attached.
    throw new DemosL2psRfqPeerChannelError("malformed");
  }
  const channel = url.protocol === "wss:"
    ? "wss"
    : url.protocol === "ws:" &&
        (LOOPBACK_IPV4.test(url.hostname) || url.hostname === "[::1]")
      ? "loopback"
      : undefined;
  if (channel === undefined) throw new DemosL2psRfqPeerChannelError("insecure");
  if (stated !== undefined && stated !== channel) {
    throw new DemosL2psRfqPeerChannelError("mismatch");
  }
}

function captureTransportOptions(value: DemosL2psRfqTransportOptions) {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      [
        "peer",
        "codec",
        "l2psUid",
        "localClaim",
        "localPeerKey",
        "peerForClaim",
        "claimForPeer",
        "onError",
        "outboxStore",
      ],
      ["peerChannel", "historyPageSize", "historyMaxPages", "operationTimeoutMs", "consumerTimeoutMs", "sendAbsenceGraceMs", "monotonicNowMs"],
    )
  ) {
    throw new DacsError("Demos L2PS RFQ transport options are malformed or unsafe");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      descriptor.value === undefined
    ) {
      throw new DacsError(
        "Demos L2PS RFQ transport options must use enumerable data properties",
      );
    }
  }
  const peer = descriptors.peer?.value as DemosL2psRfqPeerLike | undefined;
  const codec = descriptors.codec?.value as DemosL2psRfqWireCodec | undefined;
  const peerForClaim = descriptors.peerForClaim?.value as
    DemosL2psRfqTransportOptions["peerForClaim"] | undefined;
  const claimForPeer = descriptors.claimForPeer?.value as
    DemosL2psRfqTransportOptions["claimForPeer"] | undefined;
  const onError = descriptors.onError?.value as
    DemosL2psRfqTransportOptions["onError"] | undefined;
  if (
    peer === undefined ||
    peer === null ||
    typeof peer !== "object" ||
    nodeTypes.isProxy(peer) ||
    codec === undefined ||
    codec === null ||
    typeof codec !== "object" ||
    nodeTypes.isProxy(codec) ||
    typeof peerForClaim !== "function" ||
    typeof claimForPeer !== "function" ||
    typeof onError !== "function" ||
    nodeTypes.isProxy(peerForClaim) ||
    nodeTypes.isProxy(claimForPeer) ||
    nodeTypes.isProxy(onError)
  ) {
    throw new DacsError("Demos L2PS RFQ transport options are malformed or unsafe");
  }
  // Before any of the peer's own properties is read.
  checkPeerChannel(peer, descriptors.peerChannel?.value);
  const store = descriptors.outboxStore?.value as DemosL2psRfqTransportOptions["outboxStore"];
  const clock = descriptors.monotonicNowMs?.value ??
    (() => Number(process.hrtime.bigint() / 1_000_000n));
  if (!isRecord(store) || nodeTypes.isProxy(store) ||
      typeof clock !== "function" || nodeTypes.isProxy(clock)) {
    throw new DacsError("Demos L2PS RFQ outbox or clock is malformed or unsafe");
  }
  const storeDescriptors = Object.getOwnPropertyDescriptors(store);
  const load = storeDescriptors.load?.value;
  const save = storeDescriptors.save?.value;
  if (typeof load !== "function" || typeof save !== "function" ||
      nodeTypes.isProxy(load) || nodeTypes.isProxy(save)) {
    throw new DacsError("Demos L2PS RFQ outbox capabilities are malformed or unsafe");
  }
  const send = peer.send;
  const history = peer.history;
  const onMessage = peer.onMessage;
  const removeMessageHandler = peer.removeMessageHandler;
  const seal = codec.seal;
  const open = codec.open;
  const codecId = codec.codecId;
  if (
    typeof send !== "function" ||
    typeof history !== "function" ||
    typeof onMessage !== "function" ||
    (removeMessageHandler !== undefined &&
      typeof removeMessageHandler !== "function") ||
    typeof seal !== "function" ||
    typeof open !== "function" ||
    typeof codecId !== "string" ||
    [send, history, onMessage, seal, open].some((fn) => nodeTypes.isProxy(fn)) ||
    (removeMessageHandler !== undefined && nodeTypes.isProxy(removeMessageHandler))
  ) {
    throw new DacsError("Demos L2PS RFQ transport capabilities are malformed or unsafe");
  }
  canonicalString(codecId, "L2PS RFQ codecId");
  return Object.freeze({
    load: (packetId: string) => Reflect.apply(load, store, [packetId]) as unknown,
    save: (packetId: string, entry: Readonly<SendOutboxEntry>, expectedGeneration: number) =>
      Reflect.apply(save, store, [packetId, entry, expectedGeneration]) as Promise<boolean> | boolean,
    monotonicNowMs: () => Reflect.apply(clock, value, []) as number,
    codecId,
    sendAbsenceGraceMs: positiveInteger(
      descriptors.sendAbsenceGraceMs?.value,
      DEFAULT_SEND_ABSENCE_GRACE_MS,
      "sendAbsenceGraceMs",
      600_000,
    ),
    send: (...args: Parameters<DemosL2psRfqPeerLike["send"]>) =>
      Reflect.apply(send, peer, args) as ReturnType<DemosL2psRfqPeerLike["send"]>,
    history: (...args: Parameters<DemosL2psRfqPeerLike["history"]>) =>
      Reflect.apply(history, peer, args) as ReturnType<DemosL2psRfqPeerLike["history"]>,
    onMessage: (...args: Parameters<DemosL2psRfqPeerLike["onMessage"]>) =>
      Reflect.apply(onMessage, peer, args) as ReturnType<DemosL2psRfqPeerLike["onMessage"]>,
    removeMessageHandler: removeMessageHandler === undefined
      ? undefined
      : (...args: Parameters<NonNullable<DemosL2psRfqPeerLike["removeMessageHandler"]>>) =>
          Reflect.apply(removeMessageHandler, peer, args) as ReturnType<
            NonNullable<DemosL2psRfqPeerLike["removeMessageHandler"]>
          >,
    seal: (...args: Parameters<DemosL2psRfqWireCodec["seal"]>) =>
      Reflect.apply(seal, codec, args) as ReturnType<DemosL2psRfqWireCodec["seal"]>,
    open: (...args: Parameters<DemosL2psRfqWireCodec["open"]>) =>
      Reflect.apply(open, codec, args) as ReturnType<DemosL2psRfqWireCodec["open"]>,
    l2psUid: canonicalString(descriptors.l2psUid?.value, "L2PS UID"),
    localClaim: canonicalString(descriptors.localClaim?.value, "localClaim"),
    localPeerKey: capturePeerKey(descriptors.localPeerKey?.value, "localPeerKey"),
    peerForClaim: (claim: string) => Reflect.apply(peerForClaim, value, [claim]) as
      ReturnType<DemosL2psRfqTransportOptions["peerForClaim"]>,
    claimForPeer: (peerKey: string) => Reflect.apply(claimForPeer, value, [peerKey]) as
      ReturnType<DemosL2psRfqTransportOptions["claimForPeer"]>,
    onError: (error: Error) => Reflect.apply(onError, value, [error]) as void,
    historyPageSize: positiveInteger(
      descriptors.historyPageSize?.value,
      DEFAULT_HISTORY_PAGE_SIZE,
      "historyPageSize",
      100,
    ),
    historyMaxPages: positiveInteger(
      descriptors.historyMaxPages?.value,
      DEFAULT_HISTORY_MAX_PAGES,
      "historyMaxPages",
      1_000,
    ),
    operationTimeoutMs: positiveInteger(
      descriptors.operationTimeoutMs?.value,
      DEFAULT_OPERATION_TIMEOUT_MS,
      "operationTimeoutMs",
      300_000,
    ),
    consumerTimeoutMs: positiveInteger(
      descriptors.consumerTimeoutMs?.value,
      DEFAULT_CONSUMER_TIMEOUT_MS,
      "consumerTimeoutMs",
      600_000,
    ),
  });
}

/**
 * Adapt demosdk L2PSMessagingPeer to the durable RFQ outbox contract.
 *
 * No message signature bytes are invented here: the lifecycle supplies the
 * already-signed packet and verifies it on receipt. Acknowledgement means the
 * Demos peer returned the exact message hash as submitted/queued, or history
 * contains an exact decryptable packet; both come, unsigned, from the peer's
 * node, which the host must trust. Construction refuses a peer whose channel
 * is not wss:// or loopback ws:// (see the `peer` option). Absence is returned
 * only from a fully exhausted first history page; ambiguous pagination never
 * authorizes redrive.
 */
export function createDemosL2psRfqTransport<TSignature = unknown>(
  options: DemosL2psRfqTransportOptions,
): DemosL2psRfqTransport<TSignature> {
  const captured = captureTransportOptions(options);
  type Consumer = Parameters<DemosL2psRfqTransport<TSignature>["start"]>[0];
  let started = false;
  let onPacket: Consumer | undefined;
  // Each start() gets its own serialized lane, so a consumer call left over
  // from a retired generation cannot hold back the next one. The lane also
  // tracks its in-flight consumer calls so stop() can abort them.
  let lane = { tail: Promise.resolve(), calls: new Set<AbortController>() };
  // Accounting spans generations: a retired lane stays charged until its
  // events settle, which consumerTimeoutMs bounds.
  let liveEvents = 0;
  let liveBytes = 0;
  let peerHandler: DemosL2psRfqMessageHandler | undefined;
  // A peer without removeMessageHandler keeps old handlers installed, so each
  // start() binds its handler to a generation that stop() retires.
  let generation = 0;
  // Tail of each packet's in-process outbox queue; removed once idle.
  const packetLocks = new Map<string, Promise<void>>();

  /**
   * Run outbox work for one packet after earlier work on it has settled. This
   * only orders callers in this process; the host still serializes drivers
   * across processes. Every step inside is bounded, so the queue cannot stall.
   */
  async function withPacketLock<T>(packetId: string, task: () => Promise<T>): Promise<T> {
    const prior = packetLocks.get(packetId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => current);
    packetLocks.set(packetId, tail);
    await prior;
    try {
      return await task();
    } finally {
      release();
      if (packetLocks.get(packetId) === tail) packetLocks.delete(packetId);
    }
  }

  async function bounded<T>(
    operation: () => Promise<T> | T,
    label: string,
    timeoutMs = captured.operationTimeoutMs,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new OperationTimeoutError(`${label} timed out`)),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function remotePeer(claim: string): string {
    let value: string | undefined;
    try {
      value = captured.peerForClaim(claim);
    } catch (cause) {
      throw new TransientTransportCapabilityError(
        "Demos L2PS RFQ peer mapping failed",
        { cause },
      );
    }
    const peerKey = capturePeerKey(value, "resolved peer key");
    if (peerKey === captured.localPeerKey) {
      throw new DacsError("Demos L2PS RFQ remote route resolved to the local peer");
    }
    let reciprocalClaim: string | undefined;
    try {
      reciprocalClaim = captured.claimForPeer(peerKey);
    } catch (cause) {
      throw new TransientTransportCapabilityError(
        "Demos L2PS RFQ reciprocal claim mapping failed",
        { cause },
      );
    }
    if (reciprocalClaim !== claim) {
      throw new DacsError("Demos L2PS RFQ peer/claim mapping is not reciprocal");
    }
    return peerKey;
  }

  function routePacket(candidate: unknown) {
    const { packet, bytes } = encodePacket<TSignature>(candidate);
    if (packet.sender !== captured.localClaim) {
      throw new DacsError("Demos L2PS RFQ packet sender is not the local claim");
    }
    const recipientPeer = remotePeer(packet.recipient);
    const context = {
      messageHash: packet.packetId,
      fromPeer: captured.localPeerKey,
      toPeer: recipientPeer,
    };
    return { packet, bytes, recipientPeer, context };
  }

  async function sealPacket(routed: ReturnType<typeof routePacket>) {
    const { packet, bytes, recipientPeer, context } = routed;
    let sealed: unknown;
    try {
      sealed = await bounded(
        () => captured.seal(bytes, context),
        "Demos L2PS RFQ encryption",
      );
    } catch (cause) {
      throw new TransientTransportCapabilityError(
        "Demos L2PS RFQ encryption capability failed",
        { cause },
      );
    }
    const encrypted = captureEncrypted(sealed);
    return { packet, recipientPeer, encrypted };
  }

  function monotonicNow(): number {
    const now = captured.monotonicNowMs();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new DacsError("Demos L2PS RFQ monotonic clock is invalid");
    }
    return now;
  }

  /**
   * Compare-and-swap from entry.generation (0 before the first commit). The
   * generation advances only on a confirmed commit; a refused, failed or
   * timed-out save throws and leaves it unchanged.
   */
  async function saveSendEntry(packetId: string, entry: SendOutboxEntry): Promise<void> {
    const next = { ...entry, generation: entry.generation + 1 };
    // Never lend the peer or the store our retained object.
    const committed = await bounded(
      () => captured.save(packetId, structuredClone(next), entry.generation),
      "Demos L2PS RFQ send outbox write",
    );
    if (committed !== true) {
      throw new DacsError("Demos L2PS RFQ send outbox generation changed");
    }
    entry.generation = next.generation;
  }

  async function loadSendEntry(routed: ReturnType<typeof routePacket>): Promise<SendOutboxEntry | undefined> {
    let value = await bounded(() => captured.load(routed.packet.packetId),
      "Demos L2PS RFQ send outbox read");
    if (value === undefined) return undefined;
    const label = "Demos L2PS RFQ send outbox entry";
    const fields = admittedFields(value,
      ["packetId", "fromPeer", "toPeer", "l2psUid", "codecId", "encrypted", "state", "generation", "attemptEndedAtMs"], label);
    admitEncrypted(fields.encrypted);
    for (const key of ["packetId", "fromPeer", "toPeer", "l2psUid", "codecId", "state", "generation"]) {
      admittedChars(fields[key], MAX_CANONICAL_STRING_CHARS, label);
    }
    value = ownedJson(value, label);
    if (!isRecord(value) || !exactKeys(value,
      ["packetId", "fromPeer", "toPeer", "l2psUid", "codecId", "encrypted", "state", "generation"], ["attemptEndedAtMs"]) ||
      !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 ||
      value.packetId !== routed.packet.packetId ||
      value.fromPeer !== captured.localPeerKey || value.toPeer !== routed.recipientPeer ||
      value.l2psUid !== captured.l2psUid || value.codecId !== captured.codecId ||
      !["sending", "indeterminate", "acknowledged", "duplicate"].includes(value.state as string) ||
      (value.attemptEndedAtMs !== undefined &&
        (!Number.isSafeInteger(value.attemptEndedAtMs) || (value.attemptEndedAtMs as number) < 0))) {
      throw new DacsError("Demos L2PS RFQ send outbox entry is invalid");
    }
    return { ...value, encrypted: captureEncrypted(value.encrypted) } as SendOutboxEntry;
  }

  async function absenceAfterSend(packetId: string, entry: SendOutboxEntry | undefined): Promise<RfqLifecycleTransportResult> {
    // No peer call took place, e.g. a seal refusal.
    if (entry === undefined) return { disposition: "absent" };
    // A stored acknowledgement is final; callers return it without history.
    if (entry.state === "acknowledged") return { disposition: "acknowledged" };
    // The node holds this hash, so absence can never be proven: no resend.
    if (entry.state === "duplicate") return { disposition: "indeterminate", reason: DUPLICATE_REASON };
    try {
      const now = monotonicNow();
      // A crash before the outcome write has no known end time. Start the
      // entire grace on recovery, once; also fail closed on clock rollback.
      if (entry.attemptEndedAtMs === undefined || now < entry.attemptEndedAtMs) {
        entry.attemptEndedAtMs = now;
        await saveSendEntry(packetId, entry);
      }
      if (now - entry.attemptEndedAtMs >= captured.sendAbsenceGraceMs) {
        return { disposition: "absent" };
      }
      return { disposition: "indeterminate", reason: SEND_ABSENCE_REASON };
    } catch {
      return { disposition: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable" };
    }
  }

  /**
   * Only a frame that opens to different bytes, or that the built-in codec
   * proves unauthenticated, is a conflict. A timeout or other codec failure
   * says nothing about the stored frame and stays retryable, as does an open
   * that the shared reconcile deadline no longer leaves time for.
   */
  async function openStored(
    encrypted: DemosL2psRfqEncryptedMessage,
    packet: Readonly<RfqLifecyclePacket<TSignature>>,
    recipientPeer: string,
    budget: { deadline: number; spent: boolean },
  ): Promise<"match" | "conflict" | "unavailable"> {
    const remainingMs = budget.deadline - performance.now();
    if (budget.spent || remainingMs <= 0) return "unavailable";
    let plaintext: Uint8Array;
    try {
      plaintext = await bounded(
        () =>
          captured.open(encrypted, {
            messageHash: packet.packetId,
            fromPeer: captured.localPeerKey,
            toPeer: recipientPeer,
          }),
        "Demos L2PS RFQ history decryption",
        remainingMs,
      );
    } catch (cause) {
      // Timers may fire slightly before the deadline; the budget is spent anyway.
      if (cause instanceof OperationTimeoutError) budget.spent = true;
      return cause instanceof WireFrameAuthenticationError ? "conflict" : "unavailable";
    }
    try {
      const decoded = decodePacket<TSignature>(plaintext);
      return canonicalize(decoded as unknown as JsonRecord) ===
        canonicalize(packet as unknown as JsonRecord)
        ? "match"
        : "conflict";
    } catch {
      return "conflict";
    }
  }

  async function reconcilePacket(
    candidate: unknown,
  ): Promise<RfqLifecycleTransportResult> {
    let prepared: ReturnType<typeof routePacket>;
    try {
      prepared = routePacket(candidate);
    } catch (cause) {
      return {
        disposition:
          cause instanceof TransientTransportCapabilityError
            ? "indeterminate"
            : "rejected",
        reason: errorFrom(cause, "RFQ packet failed").message,
      };
    }
    let absence: RfqLifecycleTransportResult;
    try {
      // Decide BEFORE the history snapshot is requested. A read started
      // inside the grace cannot prove absence merely by finishing after it.
      absence = await withPacketLock(prepared.packet.packetId, async () =>
        absenceAfterSend(prepared.packet.packetId, await loadSendEntry(prepared)));
    } catch {
      return { disposition: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable" };
    }
    if (absence.disposition === "acknowledged") return absence;
    return historyDisposition(prepared, absence);
  }

  /**
   * Search history for our exact frame. Without a match, an exhaustive single
   * page returns `absence`; anything else stays indeterminate.
   */
  async function historyDisposition(
    prepared: ReturnType<typeof routePacket>,
    absence: RfqLifecycleTransportResult,
  ): Promise<RfqLifecycleTransportResult> {
    let before: number | undefined;
    let paginated = false;
    const seenIds = new Set<string>();
    // All own frames in one reconcile share a single decryption budget, so
    // duplicate entries cannot multiply the wait on a slow or hanging codec.
    let openBudget: { deadline: number; spent: boolean } | undefined;
    for (let pageIndex = 0; pageIndex < captured.historyMaxPages; pageIndex += 1) {
      let page: DemosL2psRfqHistoryPage;
      try {
        page = captureHistoryPage(
          await bounded(
            () =>
              captured.history(prepared.recipientPeer, {
                ...(before === undefined ? {} : { before }),
                limit: captured.historyPageSize,
              }),
            "Demos L2PS RFQ history request",
          ),
        );
      } catch {
        return {
          disposition: "indeterminate",
          reason: "Demos L2PS RFQ history reconciliation failed",
        };
      }
      // History for a peer holds both directions; an entry we did not author
      // on this route is neither evidence of our submission nor a conflict.
      const matches = page.messages.filter(
        (message) =>
          message.messageHash === prepared.packet.packetId &&
          message.from === captured.localPeerKey &&
          message.to === prepared.recipientPeer,
      );
      let uncertainReason: string | undefined;
      for (const message of matches) {
        if (message.l2psUid !== captured.l2psUid) {
          uncertainReason = "Demos L2PS history records packetId on another subnet";
          continue;
        }
        openBudget ??= {
          deadline: performance.now() + captured.operationTimeoutMs,
          spent: false,
        };
        const opened = await openStored(
          message.encrypted,
          prepared.packet,
          prepared.recipientPeer,
          openBudget,
        );
        if (opened === "conflict") {
          return {
            disposition: "rejected",
            reason: "Demos L2PS history binds packetId to different bytes or route",
          };
        }
        if (opened === "unavailable") {
          uncertainReason = "Demos L2PS RFQ history decryption failed";
        } else if (message.status === "failed") {
          uncertainReason ??=
            "Demos L2PS history records a failed submission with unknown delivery";
        }
      }
      if (uncertainReason !== undefined) {
        return { disposition: "indeterminate", reason: uncertainReason };
      }
      if (matches.length > 0) return { disposition: "acknowledged" };
      if (!page.hasMore) {
        return paginated
          ? {
              disposition: "indeterminate",
              reason: "Demos L2PS timestamp pagination cannot prove packet absence",
            }
          : absence;
      }
      paginated = true;
      if (page.messages.length === 0) {
        return {
          disposition: "indeterminate",
          reason: "Demos L2PS history pagination made no progress",
        };
      }
      let oldest = Number.POSITIVE_INFINITY;
      let progress = false;
      for (const message of page.messages) {
        if (!seenIds.has(message.id)) progress = true;
        seenIds.add(message.id);
        oldest = Math.min(oldest, message.timestamp);
      }
      if (!progress || !Number.isSafeInteger(oldest) ||
          (before !== undefined && oldest >= before)) {
        return {
          disposition: "indeterminate",
          reason: "Demos L2PS history pagination cursor is ambiguous",
        };
      }
      before = oldest;
    }
    return {
      disposition: "indeterminate",
      reason: "Demos L2PS RFQ history reconciliation page limit reached",
    };
  }

  function reportInboundError(cause: unknown): void {
    try {
      captured.onError(errorFrom(cause, "RFQ inbound failed"));
    } catch {
      // An operator callback cannot poison the serialized receive lane.
    }
  }

  /**
   * Call the consumer under consumerTimeoutMs with its own abort signal, which
   * fires on timeout or when stop() retires the lane. Once the wait ends, the
   * call's eventual result or error is dropped: Promise.race already handles
   * it, and the lifecycle dedupes a late write by packet ID.
   */
  async function consume(
    handler: Consumer,
    packet: Readonly<RfqLifecyclePacket<TSignature>>,
    calls: Set<AbortController>,
  ): Promise<DurableRfqLifecycleResult<TSignature>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    calls.add(controller);
    try {
      return await Promise.race([
        Promise.resolve().then(() => handler(packet, { signal: controller.signal })),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            const timeout = new ConsumerTimeoutError(CONSUMER_TIMEOUT_MESSAGE);
            controller.abort(timeout);
            reject(timeout);
          }, captured.consumerTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      calls.delete(controller);
    }
  }

  async function ingest(
    payload: DemosL2psRfqIncomingPayload,
    active: number,
    calls: Set<AbortController>,
  ): Promise<void> {
    if (!started || active !== generation || onPacket === undefined) return;
    const handler = onPacket;
    const senderClaim = canonicalString(
      captured.claimForPeer(payload.from),
      "resolved sender claim",
    );
    if (!isPeerKey(captured.peerForClaim(senderClaim), payload.from)) {
      throw new DacsError("Demos L2PS RFQ peer/claim mapping is not reciprocal");
    }
    const plaintext = await bounded(
      () =>
        captured.open(payload.encrypted, {
          messageHash: payload.messageHash,
          fromPeer: payload.from,
          toPeer: captured.localPeerKey,
        }),
      "Demos L2PS RFQ inbound decryption",
    );
    const packet = decodePacket<TSignature>(plaintext);
    if (
      packet.packetId !== payload.messageHash ||
      packet.sender !== senderClaim ||
      packet.recipient !== captured.localClaim
    ) {
      throw new DacsError("Demos L2PS RFQ plaintext does not bind its peer route");
    }
    if (!started || active !== generation) return;
    let result: DurableRfqLifecycleResult<TSignature>;
    try {
      result = await consume(handler, packet, calls);
    } catch (cause) {
      // stop() aborted this call; the event stays in history for recovery.
      if (!started || active !== generation) return;
      throw cause;
    }
    if (!started || active !== generation) return;
    if (result.status !== "ready" && result.status !== "duplicate") {
      throw new DacsError(
        `Demos L2PS RFQ lifecycle receive failed: ${"reason" in result ? result.reason : "unknown result"}`,
      );
    }
  }

  function packetOrder(
    left: Readonly<RfqLifecyclePacket<TSignature>>,
    right: Readonly<RfqLifecyclePacket<TSignature>>,
  ): number {
    const binding = left.jobId.localeCompare(right.jobId) ||
      left.channelId.localeCompare(right.channelId);
    if (binding !== 0) return binding;
    const rank = (packet: Readonly<RfqLifecyclePacket<TSignature>>) =>
      packet.kind === "turn"
        ? packet.message.sequence
        : packet.kind === "agreement-proposal"
          ? Number.MAX_SAFE_INTEGER - 1
          : Number.MAX_SAFE_INTEGER;
    return rank(left) - rank(right) || left.packetId.localeCompare(right.packetId);
  }

  async function resumeInbound(
    remoteClaimValue: string,
  ): Promise<DemosL2psRfqInboundRecoveryResult> {
    if (!started || onPacket === undefined) {
      throw new DacsError("Demos L2PS RFQ transport must start before inbound recovery");
    }
    const active = generation;
    const handler = onPacket;
    const { calls } = lane;
    let remoteClaim: string;
    let remotePeerKey: string;
    try {
      remoteClaim = canonicalString(remoteClaimValue, "remoteClaim");
      remotePeerKey = remotePeer(remoteClaim);
      if (captured.claimForPeer(remotePeerKey) !== remoteClaim) {
        throw new DacsError("Demos L2PS RFQ recovery mapping is not reciprocal");
      }
    } catch (cause) {
      return {
        status: "indeterminate",
        delivered: 0,
        skipped: [],
        reason: errorFrom(cause, "RFQ recovery route failed").message,
      };
    }
    let before: number | undefined;
    let paginated = false;
    let uncertainReason: string | undefined;
    const packets = new Map<string, Readonly<RfqLifecyclePacket<TSignature>>>();
    // As in reconcile, start one shared decryption deadline at the first open.
    let openDeadline: number | undefined;
    recoveryPages: for (let pageIndex = 0; pageIndex < captured.historyMaxPages; pageIndex += 1) {
      if (!started || active !== generation) {
        uncertainReason = "Demos L2PS inbound recovery generation retired";
        break;
      }
      let page: DemosL2psRfqHistoryPage;
      try {
        page = captureHistoryPage(
          await bounded(
            () =>
              captured.history(remotePeerKey, {
                ...(before === undefined ? {} : { before }),
                limit: captured.historyPageSize,
              }),
            "Demos L2PS inbound history request",
          ),
        );
      } catch {
        uncertainReason = "Demos L2PS inbound history recovery failed";
        break;
      }
      for (const message of page.messages) {
        if (!started || active !== generation) {
          uncertainReason = "Demos L2PS inbound recovery generation retired";
          break recoveryPages;
        }
        if (message.from !== remotePeerKey || message.to !== captured.localPeerKey) {
          continue;
        }
        if (message.l2psUid !== captured.l2psUid) {
          uncertainReason = "Demos L2PS inbound history crossed subnet identity";
          continue;
        }
        openDeadline ??= performance.now() + captured.operationTimeoutMs;
        const remainingMs = openDeadline - performance.now();
        if (remainingMs <= 0) {
          uncertainReason = "Demos L2PS inbound history decryption budget exhausted";
          break recoveryPages;
        }
        try {
          const plaintext = await bounded(
            () =>
              captured.open(message.encrypted, {
                messageHash: message.messageHash,
                fromPeer: remotePeerKey,
                toPeer: captured.localPeerKey,
              }),
            "Demos L2PS recovered frame decryption",
            remainingMs,
          );
          const packet = decodePacket<TSignature>(plaintext);
          if (
            packet.packetId !== message.messageHash ||
            packet.sender !== remoteClaim ||
            packet.recipient !== captured.localClaim
          ) {
            throw new DacsError("recovered RFQ packet does not bind its peer route");
          }
          const prior = packets.get(packet.packetId);
          if (
            prior !== undefined &&
            canonicalize(prior as unknown as JsonRecord) !==
              canonicalize(packet as unknown as JsonRecord)
          ) {
            throw new DacsError("recovered RFQ packetId has conflicting bytes");
          }
          packets.set(packet.packetId, packet);
          if (message.status === "failed") {
            uncertainReason =
              "Demos L2PS inbound history includes failed submission status";
          }
        } catch (cause) {
          uncertainReason = "Demos L2PS inbound history contains an unreadable RFQ frame";
          // A timer can fire just before the deadline. Stop anyway, rather than
          // opening another frame with a fresh timeout or an early timer remainder.
          if (cause instanceof OperationTimeoutError) break recoveryPages;
        }
      }
      if (!page.hasMore) {
        if (paginated) {
          uncertainReason ??=
            "Demos L2PS timestamp pagination cannot prove inbound completeness";
        }
        break;
      }
      paginated = true;
      if (page.messages.length === 0) {
        uncertainReason = "Demos L2PS inbound history pagination made no progress";
        break;
      }
      const oldest = Math.min(...page.messages.map((message) => message.timestamp));
      if (!Number.isSafeInteger(oldest) ||
          (before !== undefined && oldest >= before)) {
        uncertainReason = "Demos L2PS inbound history cursor is ambiguous";
        break;
      }
      before = oldest;
      if (pageIndex === captured.historyMaxPages - 1) {
        uncertainReason = "Demos L2PS inbound history recovery page limit reached";
      }
    }
    let delivered = 0;
    const skipped: DemosL2psRfqInboundSkip[] = [];
    // Check even when retirement happened during a final failed/empty page.
    if (!started || active !== generation) {
      uncertainReason = "Demos L2PS inbound recovery generation retired";
    }
    // History is per peer pair, not per job. Sorting keeps each job's packets
    // together and in order, so a packet the consumer does not accept holds
    // back only the rest of its own job.
    let held: DemosL2psRfqInboundSkip | undefined;
    for (const packet of [...packets.values()].sort(packetOrder)) {
      if (held?.jobId === packet.jobId && held.channelId === packet.channelId) {
        held.packets += 1;
        continue;
      }
      if (!started || active !== generation) {
        uncertainReason = "Demos L2PS inbound recovery generation retired";
        break;
      }
      let refusal: string;
      try {
        const result = await consume(handler, packet, calls);
        if (result.status === "ready" || result.status === "duplicate") {
          delivered += 1;
          continue;
        }
        refusal = "reason" in result ? result.reason : "unknown result";
        // A rejection is the lifecycle's answer for this job (retired, not
        // open, failed); only a result that may change is uncertain.
        if (result.status !== "rejected") {
          uncertainReason = `Demos L2PS recovered packet was not accepted: ${refusal}`;
        }
      } catch (cause) {
        // A retired generation or a consumer that times out would stall
        // every later job too, so these still stop recovery.
        if (!started || active !== generation) {
          uncertainReason = "Demos L2PS inbound recovery generation retired";
          break;
        }
        if (cause instanceof ConsumerTimeoutError) {
          uncertainReason = CONSUMER_TIMEOUT_MESSAGE;
          break;
        }
        refusal = "Demos L2PS recovered packet handler failed";
        uncertainReason = refusal;
      }
      held = {
        jobId: packet.jobId,
        channelId: packet.channelId,
        packetId: packet.packetId,
        packets: 1,
        reason: refusal,
      };
      skipped.push(held);
    }
    return uncertainReason === undefined
      ? { status: "complete", delivered, skipped }
      : { status: "indeterminate", delivered, skipped, reason: uncertainReason };
  }

  async function publishRouted(
    routed: ReturnType<typeof routePacket>,
  ): Promise<Exclude<RfqLifecycleTransportResult, { disposition: "absent" }>> {
    let entry: SendOutboxEntry | undefined;
    try {
      entry = await loadSendEntry(routed);
    } catch {
      return { disposition: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable" };
    }
    try {
      if (entry !== undefined) {
        const absence = await absenceAfterSend(routed.packet.packetId, entry);
        // An acknowledged entry is neither resent nor overwritten.
        if (absence.disposition === "acknowledged" ||
            absence.disposition === "indeterminate") return absence;
        // Resend only a stored frame that still opens to this exact packet
        // (a custom codec, or a key rotated under the same codecId, may not).
        const opened = await openStored(entry.encrypted, routed.packet, routed.recipientPeer,
          { deadline: performance.now() + captured.operationTimeoutMs, spent: false });
        if (opened !== "match") {
          return { disposition: "indeterminate", reason: STORED_FRAME_REASON };
        }
      } else {
        const prepared = await sealPacket(routed);
        entry = {
          packetId: routed.packet.packetId,
          fromPeer: captured.localPeerKey,
          toPeer: prepared.recipientPeer,
          l2psUid: captured.l2psUid,
          codecId: captured.codecId,
          encrypted: prepared.encrypted,
          state: "sending",
          // Not stored yet: the first save commits only if no entry exists.
          generation: 0,
        };
      }
    } catch (cause) {
      return {
        disposition: cause instanceof TransientTransportCapabilityError
          ? "indeterminate" as const : "rejected" as const,
        reason: errorFrom(cause, "Demos L2PS RFQ packet encryption or outbox failed").message,
      };
    }
    // Persist the exact submitted payload and a crash marker BEFORE calling
    // the peer. Retries reuse ciphertext, nonce and optional ephemeral key.
    // A new frame commits only where no entry exists, and every later save
    // is fenced by generation, so the stored frame never changes once any
    // peer call could have used it.
    entry.state = "sending";
    delete entry.attemptEndedAtMs;
    try {
      monotonicNow();
      await saveSendEntry(routed.packet.packetId, entry);
    } catch {
      return { disposition: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable" };
    }
    let result: Exclude<RfqLifecycleTransportResult, { disposition: "absent" }>;
    let duplicate = false;
    try {
      const ack = captureSendResult(
        await bounded(() => captured.send(routed.recipientPeer,
          structuredClone(entry.encrypted), routed.packet.packetId), "Demos L2PS RFQ send"),
        routed.packet.packetId,
      );
      result = ack === "acknowledged"
        ? { disposition: "acknowledged" }
        : { disposition: "indeterminate", reason: "Demos L2PS RFQ send acknowledgement is missing or failed" };
    } catch (cause) {
      duplicate = cause instanceof Error && cause.message === NODE_DUPLICATE_MESSAGE;
      result = { disposition: "indeterminate", reason: "Demos L2PS RFQ send outcome is unknown" };
    }
    if (duplicate) {
      // The node already holds this hash and did not deliver it again. Only
      // our own frame in history acknowledges the packet.
      const found = await historyDisposition(
        routed,
        { disposition: "indeterminate", reason: DUPLICATE_REASON },
      );
      result = found.disposition === "absent"
        ? { disposition: "indeterminate", reason: DUPLICATE_REASON }
        : found;
    }
    try {
      entry.attemptEndedAtMs = monotonicNow();
      entry.state = result.disposition === "acknowledged"
        ? "acknowledged"
        : duplicate ? "duplicate" : "indeterminate";
      await saveSendEntry(routed.packet.packetId, entry);
    } catch {
      // The durable sending marker remains; recovery starts a full grace.
      return { disposition: "indeterminate", reason: "Demos L2PS RFQ send outbox is unavailable" };
    }
    return result;
  }

  return {
    async publish(candidate) {
      let routed: ReturnType<typeof routePacket>;
      try {
        routed = routePacket(candidate);
      } catch (cause) {
        return {
          disposition:
            cause instanceof TransientTransportCapabilityError
              ? "indeterminate" as const
              : "rejected" as const,
          reason: errorFrom(cause, "Demos L2PS RFQ packet preparation failed").message,
        };
      }
      // One publish per packet at a time in this process, so a concurrent
      // enqueueTurn publish and resumeOutbox cannot both seal a frame.
      return withPacketLock(routed.packet.packetId, () => publishRouted(routed));
    },
    reconcile: reconcilePacket,
    resumeInbound,
    start(handler) {
      if (started || typeof handler !== "function" || nodeTypes.isProxy(handler)) {
        throw new DacsError("Demos L2PS RFQ transport start is duplicate or malformed");
      }
      started = true;
      onPacket = handler;
      generation += 1;
      const active = generation;
      const current = { tail: Promise.resolve(), calls: new Set<AbortController>() };
      lane = current;
      peerHandler = (payload) => {
        if (!started || active !== generation) return;
        let bytes: number;
        let owned: DemosL2psRfqIncomingPayload;
        try {
          bytes = admitIncoming(payload);
          if (liveEvents >= MAX_LIVE_EVENTS || liveBytes + bytes > MAX_LIVE_BYTES) {
            throw new TransientError("Demos L2PS RFQ live queue exceeds its count or byte budget; recover from history");
          }
          owned = captureIncoming(payload);
        } catch (cause) {
          reportInboundError(cause);
          return;
        }
        liveEvents += 1;
        liveBytes += bytes;
        // The only release of this event's charge. ingest() settles once its
        // consumer call settles or times out, whichever comes first.
        current.tail = current.tail
          .then(() => ingest(owned, active, current.calls))
          .catch(reportInboundError)
          .finally(() => {
            liveEvents -= 1;
            liveBytes -= bytes;
          });
      };
      try {
        captured.onMessage(peerHandler);
      } catch (cause) {
        started = false;
        onPacket = undefined;
        peerHandler = undefined;
        throw errorFrom(cause, "Demos L2PS RFQ message handler registration failed");
      }
    },
    stop() {
      started = false;
      generation += 1;
      onPacket = undefined;
      // Each aborted call keeps its charge until it settles or times out.
      for (const call of lane.calls) {
        call.abort(new TransientError("Demos L2PS RFQ consumer generation retired"));
      }
      if (peerHandler !== undefined) {
        captured.removeMessageHandler?.(peerHandler);
        peerHandler = undefined;
      }
    },
    drain() {
      return lane.tail;
    },
  };
}
