import { types as nodeTypes } from "node:util";

import type { VerificationDecision } from "../artifacts/types.js";
import { canonicalize, sha256Hex } from "../canonical/index.js";
import { snapshotCanonicalJson } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import {
  parseCanonicalClaimReference,
  sameCanonicalClaimIdentity,
} from "../identity/claimReference.js";

/** DACS-3 §8.3.3 v0.x closed channel-message type set. */
export type ChannelMessageType =
  | "offer"
  | "counter"
  | "accept"
  | "reject"
  | "sealed-envelope-commit"
  | "sealed-envelope-reveal"
  | "abort";

/**
 * DACS-3 v0.6 §8.3.3 reader operations (DACS-Standard PR #367). A reader
 * selects the arm structurally before any cryptography and never falls back
 * to the other arm for the same object.
 */
export type ChannelMessageOperation = "current-read" | "legacy-import";

export const CANONICAL_CHANNEL_MESSAGE_VERSION = "1" as const;
/** CH-8 signed-byte domain for the current message type. */
export const CANONICAL_CHANNEL_MESSAGE_DOMAIN =
  "dacs-canonical-channel-message:v1:" as const;
/** Frozen historical Demos domain; `legacy-import` only. New producers MUST NOT emit it. */
export const LEGACY_CHANNEL_MESSAGE_DOMAIN = "dacs-channelmsg:v1:" as const;

export const CHANNEL_MESSAGE_SIGNATURE_ALGORITHMS = Object.freeze([
  "ed25519",
  "ecdsa-secp256k1",
  "sr1-aggregate",
] as const);
export type ChannelMessageSignatureAlgorithm =
  typeof CHANNEL_MESSAGE_SIGNATURE_ALGORITHMS[number];

/** Version-1 signature envelope carried by a `CanonicalChannelMessage`. */
export interface ChannelMessageSignatureV1 {
  signatureVersion: "1";
  signer: string;
  algorithm: ChannelMessageSignatureAlgorithm;
  /** CORE §B.7 SIG-6 unpadded Base64URL. */
  value: string;
}

/**
 * Substrate-independent DACS-3 channel envelope. `TSignature` is
 * `ChannelMessageSignatureV1` on `current-read` and a bare lowercase-hex
 * string on `legacy-import`; admission enforces the shape per operation.
 */
export interface ChannelMessage<TBody = unknown, TSignature = unknown> {
  /** Exclusive current-message discriminator; absent only on the frozen historical wire. */
  canonicalChannelMessageVersion?: typeof CANONICAL_CHANNEL_MESSAGE_VERSION;
  channelId: string;
  sequence: number;
  sender: string;
  sentAt: number;
  type: ChannelMessageType;
  body: TBody;
  refs?: { repliesTo?: number };
  signature: TSignature;
}

/** Durable anti-replay state owned by the session orchestrator. */
export interface ChannelAdmissionContext {
  sessionChannelId: string;
  lastSequence: number;
  priorChannelIds: string[];
}

export type UnsignedChannelMessage<TBody = unknown> = Omit<
  ChannelMessage<TBody, never>,
  "signature"
>;

export interface ChannelMessageSigningInput<TBody = unknown> {
  unsignedEnvelope: Readonly<UnsignedChannelMessage<TBody>>;
  /** Lowercase-hex SHA-256 of the JCS unsigned envelope (CH-8 `message_hash`). */
  envelopeHash: string;
  /** Exact CH-8 bytes to sign. Producers emit the current wire only (CH-10). */
  signedBytes: Uint8Array;
  /** Always `current-read`: `legacy-import` is a reader operation (§8.3.3). */
  operation: "current-read";
}

/**
 * Exact owned material handed to the substrate-specific signature verifier.
 * No signed-byte framing is imposed here: #349 must resolve raw-digest versus
 * lowercase-hex digest framing before the SDK can expose one as normative.
 */
export interface ChannelMessageSignatureVerificationInput<
  TBody = unknown,
  TSignature = unknown,
> {
  message: Readonly<ChannelMessage<TBody, TSignature>>;
  unsignedEnvelope: Readonly<
    Omit<ChannelMessage<TBody, TSignature>, "signature">
  >;
  envelopeHash: string;
  /** Exact bytes the sender signed under the selected operation's framing. */
  signedBytes: Uint8Array;
  operation: ChannelMessageOperation;
}

export interface ChannelMessageAdmissionOptions {
  /** Defaults to `current-read`. `legacy-import` must be selected explicitly. */
  operation?: ChannelMessageOperation;
}

export type ChannelMessageSignatureVerifier<
  TBody = unknown,
  TSignature = unknown,
> = (
  input: Readonly<ChannelMessageSignatureVerificationInput<TBody, TSignature>>,
) => Promise<VerificationDecision> | VerificationDecision;

export interface ChannelMessageAdmissionFailure {
  decision: Exclude<VerificationDecision, "pass">;
  reason: string;
}

export type ChannelMessageAdmissionResult<
  TBody = unknown,
  TSignature = unknown,
> =
  | {
      decision: "pass";
      message: Readonly<ChannelMessage<TBody, TSignature>>;
      unsignedEnvelope: Readonly<
        Omit<ChannelMessage<TBody, TSignature>, "signature">
      >;
      envelopeHash: string;
      /**
       * The operation that admitted the message. §8.3.3 keeps historical
       * audit state separate from live negotiation state; a caller can check
       * that separation on the value instead of remembering the option.
       */
      operation: ChannelMessageOperation;
    }
  | ChannelMessageAdmissionFailure;

type DataRecord = Record<string, unknown>;

const MESSAGE_TYPES: ReadonlySet<string> = new Set<ChannelMessageType>([
  "offer",
  "counter",
  "accept",
  "reject",
  "sealed-envelope-commit",
  "sealed-envelope-reveal",
  "abort",
]);

const DECISIONS: ReadonlySet<string> = new Set<VerificationDecision>([
  "pass",
  "fail",
  "indeterminate",
  "error",
]);

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const SIGNATURE_ALGORITHMS: ReadonlySet<string> = new Set(
  CHANNEL_MESSAGE_SIGNATURE_ALGORITHMS,
);
const LEGACY_HEX_SIGNATURE = /^[0-9a-f]{128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function isCanonicalBase64Url(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || !BASE64URL.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64url").toString("base64url") === value;
}

/** CH-7: a registered DACS-1 claim scheme; the historical generic `cci:` is refused. */
function isRegisteredClaim(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  const parsed = parseCanonicalClaimReference(value);
  return parsed !== null && parsed.schemeStatus === "registered";
}

const HISTORICAL_CCI_IDENTIFIER = /^[0-9a-f]{64}$/;
const HISTORICAL_DID_IDENTIFIER = /^[a-z0-9]+:[A-Za-z0-9._-]+$/;

/**
 * CH-10 frozen historical ClaimReference grammar, closed to exactly the two
 * spellings the archived `channel-message-replay-v0.1` corpus carries (the
 * Standard reference reader's `parse_historical_claim_ref`): the generic
 * `cci:<64 lowercase hex>` Ed25519 sender and a pre-profile `did:<method>:<id>`.
 * The whole value must be lowercase and carry no `?` qualifier. Every other
 * spelling, registered or not (for example `key:`, `lei:`, `cci-xm:` or the
 * unregistered `demos:0x…` emitted by demosdk 4.0.11 to 4.0.18, DEMOS-MAPPING
 * A.1), is outside the frozen registry and rejects. Never reachable from
 * `current-read`, which uses the registered parser above.
 */
function isHistoricalClaim(value: unknown): value is string {
  if (
    !isNonEmptyString(value) ||
    value !== value.toLowerCase() ||
    value.includes("?")
  ) {
    return false;
  }
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) return false;
  const scheme = value.slice(0, colon);
  const identifier = value.slice(colon + 1);
  if (scheme === "cci") return HISTORICAL_CCI_IDENTIFIER.test(identifier);
  if (scheme === "did") return HISTORICAL_DID_IDENTIFIER.test(identifier);
  return false;
}

function sameParty(left: string, right: string): boolean {
  return left === right || sameCanonicalClaimIdentity(left, right);
}

/**
 * Version-1 signature envelope. `signer` must parse under the current
 * registered ClaimReference grammar: a signer that does not parse is
 * malformed input (`error`), and only a well-formed signer naming another
 * party reaches the CH-7 comparison that yields an attributable `fail`.
 */
function validateSignatureEnvelopeV1(
  value: unknown,
): value is ChannelMessageSignatureV1 {
  return (
    isRecord(value) &&
    exactKeys(value, ["signatureVersion", "signer", "algorithm", "value"]) &&
    value.signatureVersion === "1" &&
    isRegisteredClaim(value.signer) &&
    typeof value.algorithm === "string" &&
    SIGNATURE_ALGORITHMS.has(value.algorithm) &&
    isCanonicalBase64Url(value.value)
  );
}

/** CH-8: `UTF8(domain) || ASCII(lowercase-hex sha256(JCS(unsigned_message)))`. */
export function canonicalChannelMessageSignedBytes(envelopeHash: string): Uint8Array {
  return Buffer.concat([
    Buffer.from(CANONICAL_CHANNEL_MESSAGE_DOMAIN, "utf8"),
    Buffer.from(envelopeHash, "ascii"),
  ]);
}

/** CH-10 frozen historical framing: `UTF8(domain) || raw 32-byte sha256 digest`. */
export function legacyChannelMessageSignedBytes(envelopeHash: string): Uint8Array {
  return Buffer.concat([
    Buffer.from(LEGACY_CHANNEL_MESSAGE_DOMAIN, "utf8"),
    Buffer.from(envelopeHash, "hex"),
  ]);
}

function signedBytesFor(
  operation: ChannelMessageOperation,
  envelopeHash: string,
): Uint8Array {
  return operation === "current-read"
    ? canonicalChannelMessageSignedBytes(envelopeHash)
    : legacyChannelMessageSignedBytes(envelopeHash);
}

function selectOperation(options: unknown): ChannelMessageOperation | null {
  if (options === undefined) return "current-read";
  if (!isRecord(options) || !exactKeys(options, [], ["operation"])) return null;
  const operation = options.operation ?? "current-read";
  return operation === "current-read" || operation === "legacy-import"
    ? operation
    : null;
}

function isRecord(value: unknown): value is DataRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !nodeTypes.isProxy(value)
  );
}

function exactKeys(
  value: Readonly<DataRecord>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key)) &&
    optional.every((key) => !hasOwn(value, key) || value[key] !== undefined)
  );
}

function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    value.normalize("NFC") === value
  );
}

function isSafeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (
    value === null ||
    typeof value !== "object" ||
    seen.has(value as object) ||
    Object.isFrozen(value) ||
    // Typed arrays with elements cannot be frozen; `signedBytes` is a fresh
    // owned copy per call, so leaving it unfrozen exposes no shared state.
    ArrayBuffer.isView(value)
  ) {
    return value;
  }
  seen.add(value as object);
  for (const child of Object.values(value as DataRecord)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function failure(
  decision: Exclude<VerificationDecision, "pass">,
  reason: string,
): ChannelMessageAdmissionFailure {
  return { decision, reason };
}

function validateContext(value: unknown): value is ChannelAdmissionContext {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "sessionChannelId",
      "lastSequence",
      "priorChannelIds",
    ]) ||
    !isNonEmptyString(value.sessionChannelId) ||
    !Number.isSafeInteger(value.lastSequence) ||
    (value.lastSequence as number) < 0 ||
    !Array.isArray(value.priorChannelIds)
  ) {
    return false;
  }
  return value.priorChannelIds.every(isNonEmptyString);
}

/**
 * Structural selection per DACS-3 v0.6 §8.3.3. `current-read` requires the
 * exclusive discriminator, a registered sender scheme, the version-1
 * signature envelope whose signer identifies the sender (CF-3), and retains
 * unknown top-level members in the signed scope (SIG-5). `legacy-import`
 * requires the discriminator to be absent, the exact historical member set,
 * and a bare 128-character lowercase-hex signature. Partial mixtures reject
 * on both operations.
 */
function validateMessage(
  value: unknown,
  operation: ChannelMessageOperation,
): value is ChannelMessage<unknown, unknown> {
  if (!isRecord(value)) return false;
  if (operation === "current-read") {
    if (
      value.canonicalChannelMessageVersion !== CANONICAL_CHANNEL_MESSAGE_VERSION ||
      !["channelId", "sequence", "sender", "sentAt", "type", "body", "signature"]
        .every((key) => hasOwn(value, key)) ||
      Object.values(value).some((member) => member === undefined) ||
      !isRegisteredClaim(value.sender) ||
      !validateSignatureEnvelopeV1(value.signature)
    ) {
      return false;
    }
  } else if (
    hasOwn(value, "canonicalChannelMessageVersion") ||
    !exactKeys(
      value,
      [
        "channelId",
        "sequence",
        "sender",
        "sentAt",
        "type",
        "body",
        "signature",
      ],
      ["refs"],
    ) ||
    typeof value.signature !== "string" ||
    !LEGACY_HEX_SIGNATURE.test(value.signature) ||
    !isHistoricalClaim(value.sender)
  ) {
    return false;
  }
  if (
    !isNonEmptyString(value.channelId) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    !isNonEmptyString(value.sender) ||
    !isSafeTime(value.sentAt) ||
    typeof value.type !== "string" ||
    !MESSAGE_TYPES.has(value.type) ||
    value.signature === null
  ) {
    return false;
  }
  if (value.refs === undefined) return true;
  if (!isRecord(value.refs) || !exactKeys(value.refs, [], ["repliesTo"])) {
    return false;
  }
  if (value.refs.repliesTo === undefined) return true;
  return (
    Number.isSafeInteger(value.refs.repliesTo) &&
    (value.refs.repliesTo as number) >= 1 &&
    (value.refs.repliesTo as number) < (value.sequence as number)
  );
}

function unsignedEnvelope<TBody, TSignature>(
  message: Readonly<ChannelMessage<TBody, TSignature>>,
): Omit<ChannelMessage<TBody, TSignature>, "signature"> {
  // CH-8 / SIG-5: the signed scope is the complete received message with only
  // the top-level `signature` member omitted; unknown members are retained.
  const unsigned: DataRecord = {};
  for (const key of Object.keys(message)) {
    if (key !== "signature") unsigned[key] = (message as DataRecord)[key];
  }
  return unsigned as Omit<ChannelMessage<TBody, TSignature>, "signature">;
}

/**
 * Validate and own a producer envelope and expose the exact CH-8 bytes a
 * substrate-specific signer must sign. This is producer-side and therefore
 * current-only: `legacy-import` is a reader operation (DACS-3 §8.3.3) and
 * CH-10 forbids new producers from emitting the frozen historical wire, so
 * no option can select it here.
 */
export function prepareChannelMessageSigningInput<TBody = unknown>(
  candidate: unknown,
): Readonly<ChannelMessageSigningInput<TBody>> {
  const operation = "current-read" as const;
  const envelope = snapshotCanonicalJson(
    candidate,
    "unsigned channel message",
  );
  if (!isRecord(envelope) || hasOwn(envelope, "signature")) {
    throw new DacsError("unsigned channel message must omit signature");
  }
  // Probe with a structurally valid current signature envelope so the
  // remaining envelope rules are checked exactly as a reader would check them.
  const probe = {
    ...envelope,
    signature: {
      signatureVersion: "1",
      signer: envelope.sender,
      algorithm: "ed25519",
      value: "AA",
    },
  };
  if (!validateMessage(probe, operation)) {
    throw new DacsError("unsigned channel message envelope is malformed");
  }
  const owned = deepFreeze(
    envelope as unknown as UnsignedChannelMessage<TBody>,
  );
  const envelopeHash = sha256Hex(canonicalize(owned));
  return deepFreeze({
    unsignedEnvelope: owned,
    envelopeHash,
    signedBytes: canonicalChannelMessageSignedBytes(envelopeHash),
    operation,
  });
}

/**
 * Apply the DACS-3 §8.3.3 / CH-6 admission gate without collapsing the
 * normative four-value result. Structural/context errors never become an
 * attacker-attributable `fail`; signature uncertainty remains indeterminate.
 *
 * The caller must persist `message.sequence` as the new `lastSequence` only
 * after this function returns `pass`, in the same durable transition that
 * accepts the RFQ turn.
 */
export async function admitChannelMessage<
  TBody = unknown,
  TSignature = unknown,
>(
  candidate: unknown,
  candidateContext: unknown,
  verifySignature: ChannelMessageSignatureVerifier<TBody, TSignature>,
  options?: Readonly<ChannelMessageAdmissionOptions>,
): Promise<ChannelMessageAdmissionResult<TBody, TSignature>> {
  if (
    typeof verifySignature !== "function" ||
    nodeTypes.isProxy(verifySignature)
  ) {
    return failure(
      "error",
      "channel signature verifier is unavailable or unsafe",
    );
  }
  const operation = selectOperation(options);
  if (operation === null) {
    return failure("error", "channel message operation is malformed");
  }

  let message: ChannelMessage<TBody, TSignature>;
  let context: ChannelAdmissionContext;
  try {
    message = snapshotCanonicalJson(
      candidate,
      "channel message",
    ) as ChannelMessage<TBody, TSignature>;
    context = snapshotCanonicalJson(
      candidateContext,
      "channel admission context",
    ) as ChannelAdmissionContext;
  } catch {
    return failure(
      "error",
      "channel message or admission context is malformed",
    );
  }

  if (!validateContext(context)) {
    return failure("error", "channel admission context is malformed");
  }
  if (!validateMessage(message, operation)) {
    return failure("error", "channel message envelope is malformed");
  }
  if (
    operation === "current-read" &&
    !sameParty(
      (message.signature as ChannelMessageSignatureV1).signer,
      message.sender,
    )
  ) {
    // CH-7: a well-formed envelope whose signer is another party is a
    // binding failure attributable to the message, not malformed input.
    return failure("fail", "signature signer does not identify the sender (CH-7)");
  }
  if (context.priorChannelIds.includes(context.sessionChannelId)) {
    return failure(
      "fail",
      "session channelId was used by a prior session (CH-6)",
    );
  }
  if (message.channelId !== context.sessionChannelId) {
    return failure("fail", "message belongs to a different channel");
  }
  if (message.sequence <= context.lastSequence) {
    return failure("fail", "message sequence is not strictly increasing");
  }

  const ownedMessage = deepFreeze(message);
  const unsigned = deepFreeze(unsignedEnvelope(ownedMessage));
  const envelopeHash = sha256Hex(canonicalize(unsigned));
  const callbackInput = deepFreeze({
    message: ownedMessage,
    unsignedEnvelope: unsigned,
    envelopeHash,
    signedBytes: signedBytesFor(operation, envelopeHash),
    operation,
  });

  let decision: unknown;
  try {
    decision = await verifySignature(callbackInput);
  } catch {
    return failure("error", "channel signature verifier failed");
  }
  if (typeof decision !== "string" || !DECISIONS.has(decision)) {
    return failure(
      "error",
      "channel signature verifier returned a malformed decision",
    );
  }
  if (decision !== "pass") {
    return failure(
      decision as Exclude<VerificationDecision, "pass">,
      `channel signature verification returned ${decision}`,
    );
  }

  return {
    decision: "pass",
    message: ownedMessage,
    unsignedEnvelope: unsigned,
    envelopeHash,
    operation,
  };
}
