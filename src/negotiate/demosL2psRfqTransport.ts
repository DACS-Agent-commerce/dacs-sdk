import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";
import { types as nodeTypes } from "node:util";

import { canonicalize } from "../canonical/index.js";
import { snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
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
const MAX_CANONICAL_STRING_CHARS = 16_384;
const MAX_EPHEMERAL_KEY_CHARS = 4_096;
const WIRE_DOMAIN = "dacs-rfq-l2ps-wire:v1";
const HASH = /^[0-9a-f]{64}$/;
const DEFAULT_HISTORY_PAGE_SIZE = 100;
const DEFAULT_HISTORY_MAX_PAGES = 100;
const DEFAULT_OPERATION_TIMEOUT_MS = 20_000;
const HISTORY_STATUSES = new Set<DemosL2psRfqMessageStatus>([
  "delivered",
  "queued",
  "sent",
  "failed",
  "l2ps_pending",
  "l2ps_batched",
  "l2ps_confirmed",
]);

type JsonRecord = Record<string, unknown>;

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
  /** Exact role-shared L2PS subnet key. It is copied and never persisted. */
  sharedKey: Uint8Array;
}

export interface DemosL2psRfqTransportOptions {
  peer: DemosL2psRfqPeerLike;
  codec: DemosL2psRfqWireCodec;
  l2psUid: string;
  localClaim: string;
  localPeerKey: string;
  peerForClaim(claim: string): string | undefined;
  claimForPeer(peerKey: string): string | undefined;
  onError(error: Error): void;
  historyPageSize?: number;
  historyMaxPages?: number;
  operationTimeoutMs?: number;
}

export interface DemosL2psRfqTransport<TSignature = unknown>
  extends DurableRfqLifecycleTransport<TSignature> {
  /** Register one inbound consumer. Calling start twice is rejected. */
  start(
    onPacket: (
      packet: Readonly<RfqLifecyclePacket<TSignature>>,
    ) =>
      | Promise<DurableRfqLifecycleResult<TSignature>>
      | DurableRfqLifecycleResult<TSignature>,
  ): void;
  /** Replay role-bound inbound packets after a process restart. */
  resumeInbound(remoteClaim: string): Promise<DemosL2psRfqInboundRecoveryResult>;
  /** Stop accepting inbound packets and detach when the peer supports it. */
  stop(): void;
  /** Wait until every payload already delivered by the peer has been handled. */
  drain(): Promise<void>;
}

export type DemosL2psRfqInboundRecoveryResult =
  | { status: "complete"; delivered: number }
  | { status: "indeterminate"; delivered: number; reason: string };

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

function canonicalBase64(
  value: unknown,
  label: string,
  maximumBytes: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > Math.ceil(maximumBytes / 3) * 4
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

function captureEncrypted(value: unknown): DemosL2psRfqEncryptedMessage {
  value = ownedJson(value, "Demos L2PS encrypted RFQ frame");
  if (
    !isRecord(value) ||
    !exactKeys(value, ["ciphertext", "nonce"], ["ephemeralKey"])
  ) {
    throw new DacsError("Demos L2PS encrypted RFQ frame is malformed");
  }
  const encrypted: DemosL2psRfqEncryptedMessage = {
    ciphertext: canonicalBase64(
      value.ciphertext,
      "ciphertext",
      MAX_RFQ_PLAINTEXT_BYTES + AES_TAG_BYTES,
    ),
    nonce: canonicalBase64(value.nonce, "nonce", 64),
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
        throw new DacsError("AES-GCM RFQ frames cannot contain an ephemeralKey");
      }
      const nonce = Buffer.from(encrypted.nonce, "base64");
      const combined = Buffer.from(encrypted.ciphertext, "base64");
      if (nonce.length !== AES_NONCE_BYTES || combined.length < AES_TAG_BYTES) {
        throw new DacsError("Demos L2PS AES-GCM RFQ frame has invalid lengths");
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
        throw new DacsError("Demos L2PS AES-GCM RFQ authentication failed");
      }
    },
  };
  return Object.freeze(codec);
}

function errorFrom(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new DacsError(fallback);
}

function capturePeerKey(value: unknown, label: string): string {
  return canonicalString(value, label);
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
      !exactKeys(candidate, [
        "id",
        "from",
        "to",
        "messageHash",
        "encrypted",
        "l2psUid",
        "l2psTxHash",
        "timestamp",
        "status",
      ]) ||
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
      ],
      ["historyPageSize", "historyMaxPages", "operationTimeoutMs"],
    ) ||
    value.peer === null ||
    typeof value.peer !== "object" ||
    nodeTypes.isProxy(value.peer) ||
    typeof value.peer.send !== "function" ||
    typeof value.peer.history !== "function" ||
    typeof value.peer.onMessage !== "function" ||
    value.codec === null ||
    typeof value.codec !== "object" ||
    nodeTypes.isProxy(value.codec) ||
    typeof value.codec.seal !== "function" ||
    typeof value.codec.open !== "function" ||
    typeof value.codec.codecId !== "string" ||
    typeof value.peerForClaim !== "function" ||
    typeof value.claimForPeer !== "function" ||
    typeof value.onError !== "function" ||
    nodeTypes.isProxy(value.peerForClaim) ||
    nodeTypes.isProxy(value.claimForPeer) ||
    nodeTypes.isProxy(value.onError)
  ) {
    throw new DacsError("Demos L2PS RFQ transport options are malformed or unsafe");
  }
  canonicalString(value.codec.codecId, "L2PS RFQ codecId");
  return {
    peer: value.peer,
    codec: value.codec,
    l2psUid: canonicalString(value.l2psUid, "L2PS UID"),
    localClaim: canonicalString(value.localClaim, "localClaim"),
    localPeerKey: capturePeerKey(value.localPeerKey, "localPeerKey"),
    peerForClaim: value.peerForClaim,
    claimForPeer: value.claimForPeer,
    onError: value.onError,
    historyPageSize: positiveInteger(
      value.historyPageSize,
      DEFAULT_HISTORY_PAGE_SIZE,
      "historyPageSize",
      100,
    ),
    historyMaxPages: positiveInteger(
      value.historyMaxPages,
      DEFAULT_HISTORY_MAX_PAGES,
      "historyMaxPages",
      1_000,
    ),
    operationTimeoutMs: positiveInteger(
      value.operationTimeoutMs,
      DEFAULT_OPERATION_TIMEOUT_MS,
      "operationTimeoutMs",
      300_000,
    ),
  };
}

/**
 * Adapt demosdk L2PSMessagingPeer to the durable RFQ outbox contract.
 *
 * No message signature bytes are invented here: the lifecycle supplies the
 * already-signed packet and verifies it on receipt. Acknowledgement means the
 * Demos peer returned the exact message hash as submitted/queued, or history
 * contains an exact decryptable packet. Absence is returned only from a fully
 * exhausted first history page; ambiguous pagination never authorizes redrive.
 */
export function createDemosL2psRfqTransport<TSignature = unknown>(
  options: DemosL2psRfqTransportOptions,
): DemosL2psRfqTransport<TSignature> {
  const captured = captureTransportOptions(options);
  let started = false;
  let onPacket:
    | ((
        packet: Readonly<RfqLifecyclePacket<TSignature>>,
      ) =>
        | Promise<DurableRfqLifecycleResult<TSignature>>
        | DurableRfqLifecycleResult<TSignature>)
    | undefined;
  let inbound = Promise.resolve();
  let peerHandler: DemosL2psRfqMessageHandler | undefined;

  async function bounded<T>(
    operation: () => Promise<T> | T,
    label: string,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(operation),
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new DacsError(`${label} timed out`)),
            captured.operationTimeoutMs,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  function remotePeer(claim: string): string {
    const value = captured.peerForClaim(claim);
    const peerKey = capturePeerKey(value, "resolved peer key");
    if (peerKey === captured.localPeerKey) {
      throw new DacsError("Demos L2PS RFQ remote route resolved to the local peer");
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

  async function sealPacket(candidate: unknown) {
    const routed = routePacket(candidate);
    const { packet, bytes, recipientPeer, context } = routed;
    const encrypted = captureEncrypted(
      await bounded(
        () => captured.codec.seal(bytes, context),
        "Demos L2PS RFQ encryption",
      ),
    );
    return { packet, recipientPeer, encrypted };
  }

  async function openStored(
    message: DemosL2psRfqStoredMessage,
    packet: Readonly<RfqLifecyclePacket<TSignature>>,
    recipientPeer: string,
  ): Promise<boolean> {
    if (
      message.from !== captured.localPeerKey ||
      message.to !== recipientPeer ||
      message.messageHash !== packet.packetId ||
      message.l2psUid !== captured.l2psUid
    ) {
      return false;
    }
    try {
      const plaintext = await bounded(
        () =>
          captured.codec.open(message.encrypted, {
            messageHash: packet.packetId,
            fromPeer: captured.localPeerKey,
            toPeer: recipientPeer,
          }),
        "Demos L2PS RFQ history decryption",
      );
      const decoded = decodePacket<TSignature>(plaintext);
      return canonicalize(decoded as unknown as JsonRecord) ===
        canonicalize(packet as unknown as JsonRecord);
    } catch {
      return false;
    }
  }

  async function reconcilePacket(
    candidate: unknown,
  ): Promise<RfqLifecycleTransportResult> {
    let prepared: ReturnType<typeof routePacket>;
    try {
      prepared = routePacket(candidate);
    } catch (cause) {
      return { disposition: "rejected", reason: errorFrom(cause, "RFQ packet failed").message };
    }
    let before: number | undefined;
    let paginated = false;
    const seenIds = new Set<string>();
    for (let pageIndex = 0; pageIndex < captured.historyMaxPages; pageIndex += 1) {
      let page: DemosL2psRfqHistoryPage;
      try {
        page = captureHistoryPage(
          await bounded(
            () =>
              captured.peer.history(prepared.recipientPeer, {
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
      const matches = page.messages.filter(
        (message) => message.messageHash === prepared.packet.packetId,
      );
      for (const message of matches) {
        if (!(await openStored(message, prepared.packet, prepared.recipientPeer))) {
          return {
            disposition: "rejected",
            reason: "Demos L2PS history binds packetId to different bytes or route",
          };
        }
      }
      if (matches.some((message) => message.status === "failed")) {
        return {
          disposition: "indeterminate",
          reason: "Demos L2PS history records a failed submission with unknown delivery",
        };
      }
      if (matches.length > 0) return { disposition: "acknowledged" };
      if (!page.hasMore) {
        return paginated
          ? {
              disposition: "indeterminate",
              reason: "Demos L2PS timestamp pagination cannot prove packet absence",
            }
          : { disposition: "absent" };
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

  async function ingest(payloadValue: unknown): Promise<void> {
    if (!started || onPacket === undefined) return;
    const payload = captureIncoming(payloadValue);
    const senderClaim = canonicalString(
      captured.claimForPeer(payload.from),
      "resolved sender claim",
    );
    if (captured.peerForClaim(senderClaim) !== payload.from) {
      throw new DacsError("Demos L2PS RFQ peer/claim mapping is not reciprocal");
    }
    const plaintext = await bounded(
      () =>
        captured.codec.open(payload.encrypted, {
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
    const result = await onPacket(packet);
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
        reason: errorFrom(cause, "RFQ recovery route failed").message,
      };
    }
    let before: number | undefined;
    let paginated = false;
    let uncertainReason: string | undefined;
    const packets = new Map<string, Readonly<RfqLifecyclePacket<TSignature>>>();
    for (let pageIndex = 0; pageIndex < captured.historyMaxPages; pageIndex += 1) {
      let page: DemosL2psRfqHistoryPage;
      try {
        page = captureHistoryPage(
          await bounded(
            () =>
              captured.peer.history(remotePeerKey, {
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
        if (message.from !== remotePeerKey || message.to !== captured.localPeerKey) {
          continue;
        }
        if (message.l2psUid !== captured.l2psUid) {
          uncertainReason = "Demos L2PS inbound history crossed subnet identity";
          continue;
        }
        try {
          const plaintext = await bounded(
            () =>
              captured.codec.open(message.encrypted, {
                messageHash: message.messageHash,
                fromPeer: remotePeerKey,
                toPeer: captured.localPeerKey,
              }),
            "Demos L2PS recovered frame decryption",
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
        } catch {
          uncertainReason = "Demos L2PS inbound history contains an unreadable RFQ frame";
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
    for (const packet of [...packets.values()].sort(packetOrder)) {
      try {
        const result = await onPacket(packet);
        if (result.status !== "ready" && result.status !== "duplicate") {
          uncertainReason =
            `Demos L2PS recovered packet was not accepted: ${"reason" in result ? result.reason : "unknown result"}`;
          break;
        }
        delivered += 1;
      } catch {
        uncertainReason = "Demos L2PS recovered packet handler failed";
        break;
      }
    }
    return uncertainReason === undefined
      ? { status: "complete", delivered }
      : { status: "indeterminate", delivered, reason: uncertainReason };
  }

  return {
    async publish(candidate) {
      let prepared: Awaited<ReturnType<typeof sealPacket>>;
      try {
        prepared = await sealPacket(candidate);
      } catch (cause) {
        return {
          disposition: "rejected",
          reason: errorFrom(cause, "Demos L2PS RFQ packet preparation failed").message,
        };
      }
      try {
        const result = captureSendResult(
          await bounded(
            () =>
              captured.peer.send(
                prepared.recipientPeer,
                prepared.encrypted,
                prepared.packet.packetId,
              ),
            "Demos L2PS RFQ send",
          ),
          prepared.packet.packetId,
        );
        return result === "acknowledged"
          ? { disposition: "acknowledged" }
          : {
              disposition: "indeterminate",
              reason: "Demos L2PS RFQ send acknowledgement is missing or failed",
            };
      } catch {
        return {
          disposition: "indeterminate",
          reason: "Demos L2PS RFQ send outcome is unknown",
        };
      }
    },
    reconcile: reconcilePacket,
    resumeInbound,
    start(handler) {
      if (started || typeof handler !== "function" || nodeTypes.isProxy(handler)) {
        throw new DacsError("Demos L2PS RFQ transport start is duplicate or malformed");
      }
      started = true;
      onPacket = handler;
      peerHandler = (payload) => {
        if (!started) return;
        inbound = inbound
          .then(() => ingest(payload))
          .catch((cause) => {
            try {
              captured.onError(errorFrom(cause, "RFQ inbound failed"));
            } catch {
              // An operator callback cannot poison the serialized receive lane.
            }
          });
      };
      try {
        captured.peer.onMessage(peerHandler);
      } catch (cause) {
        started = false;
        onPacket = undefined;
        peerHandler = undefined;
        throw errorFrom(cause, "Demos L2PS RFQ message handler registration failed");
      }
    },
    stop() {
      started = false;
      onPacket = undefined;
      if (peerHandler !== undefined) {
        captured.peer.removeMessageHandler?.(peerHandler);
        peerHandler = undefined;
      }
    },
    drain() {
      return inbound;
    },
  };
}
