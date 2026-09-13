import { types as nodeTypes } from "node:util";

import type { VerificationDecision } from "../artifacts/types.js";
import { canonicalize, sha256Hex } from "../canonical/index.js";
import { snapshotCanonicalJson } from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";

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
 * Substrate-independent DACS-3 channel envelope. The signature stays generic
 * until DACS-Standard#349 resolves the normative signature container and byte
 * representation used by current Demos L2PS.
 */
export interface ChannelMessage<TBody = unknown, TSignature = unknown> {
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
  envelopeHash: string;
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
    Object.isFrozen(value)
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

function validateMessage(
  value: unknown,
): value is ChannelMessage<unknown, unknown> {
  if (
    !isRecord(value) ||
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
  const { channelId, sequence, sender, sentAt, type, body, refs } = message;
  return {
    channelId,
    sequence,
    sender,
    sentAt,
    type,
    body,
    ...(refs === undefined ? {} : { refs }),
  };
}

/**
 * Validate and own a producer envelope, then expose the exact canonical digest
 * that a substrate-specific signer must frame after DACS-Standard#349 is
 * resolved. This function intentionally returns no guessed `signedBytes`.
 */
export function prepareChannelMessageSigningInput<TBody = unknown>(
  candidate: unknown,
): Readonly<ChannelMessageSigningInput<TBody>> {
  const envelope = snapshotCanonicalJson(
    candidate,
    "unsigned channel message",
  );
  if (!isRecord(envelope) || hasOwn(envelope, "signature")) {
    throw new DacsError("unsigned channel message must omit signature");
  }
  const probe = { ...envelope, signature: "validation-probe" };
  if (!validateMessage(probe)) {
    throw new DacsError("unsigned channel message envelope is malformed");
  }
  const owned = deepFreeze(
    envelope as unknown as UnsignedChannelMessage<TBody>,
  );
  return deepFreeze({
    unsignedEnvelope: owned,
    envelopeHash: sha256Hex(canonicalize(owned)),
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
  if (!validateMessage(message)) {
    return failure("error", "channel message envelope is malformed");
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
  };
}
