import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { DacsError } from "../errors.js";
import { deriveX402ReceiptCommitment } from "../seller/x402Receipt.js";

/** Durable wire/schema version for the normative buyer x402 boundary. */
export const X402_BUYER_SETTLEMENT_STORE_VERSION = 1 as const;

const HASH_RE = /^[0-9a-f]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const RECEIPT_TX_RE = /^0x[0-9a-fA-F]{64}$/;
const CANONICAL_EVENT_TX_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^0x[0-9a-f]{64}$/;
const UNSIGNED_RE = /^(0|[1-9][0-9]*)$/;
const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2})+$/;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const MAX_HEADER_CHARACTERS = 1_048_576;
const DEFAULT_LEASE_MS = 30_000;
const JSON_WHITESPACE_RE = /[\u0009\u000a\u000d\u0020]/;

export type X402BuyerJson =
  | null
  | boolean
  | number
  | string
  | X402BuyerJson[]
  | { [key: string]: X402BuyerJson };

export interface X402BuyerPaymentRequirements {
  scheme: string;
  network: `eip155:${string}`;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Readonly<Record<string, X402BuyerJson>>;
}

/**
 * Immutable authorization retained before the paid request can move value.
 * Every authority-bearing session/rail field is explicit and hash-bound.
 */
export interface X402BuyerSettlementIntent {
  intentVersion: "1";
  settlementKey: string;
  bindingHash: string;
  jobId: string;
  phaseIndex: number;
  railId: string;
  railVersion: string;
  railDescriptorHash: string;
  agreementHash: string;
  termsHash: string;
  sessionBindingHash: string;
  network: `eip155:${string}`;
  payer: string;
  payee: string;
  asset: string;
  amount: string;
  httpResource: string;
  method: "GET";
  chosenRequirements: Readonly<X402BuyerPaymentRequirements>;
  /** Complete x402 v2 payload, including EIP-3009 authorization + signature. */
  signedPaymentPayload: Readonly<Record<string, X402BuyerJson>>;
  paymentHeader: Readonly<{
    name: "PAYMENT-SIGNATURE";
    value: string;
  }>;
  authorizationNonce: `0x${string}`;
}

export type X402BuyerSettlementIntentDraft = Omit<
  X402BuyerSettlementIntent,
  "intentVersion" | "settlementKey" | "bindingHash"
>;

/** Exact DACS-4 v0.6 signed event arm required for current x402 success. */
export interface X402BuyerSignedEventReference {
  kind: "x402-event";
  httpResource: string;
  paymentReceiptHash: string;
  protocolVersion: "2";
  /** Canonical 32-byte lower-case transaction hex, without a `0x` prefix. */
  settlementTxHash: string;
  chainId: number;
  logIndex: number;
}

/** Complete X402-1..4 disclosure plus the authenticated signed event arm. */
export interface X402BuyerCapturedSettlement {
  captureVersion: "1";
  protocolVersion: "2";
  headerName: "PAYMENT-RESPONSE";
  encodedSettlementHeader: string;
  httpResource: string;
  signedEvent: Readonly<X402BuyerSignedEventReference>;
  /** Hash of the provider-authenticated observation/signature proof. */
  authenticationHash: string;
}

export type X402BuyerTerminalFailureKind = "used-different" | "cancelled";

export type X402BuyerSettlementOutcome =
  | {
      outcomeVersion: "1";
      status: "captured";
      settlement: Readonly<X402BuyerCapturedSettlement>;
    }
  | {
      outcomeVersion: "1";
      status: "failed";
      failure: X402BuyerTerminalFailureKind;
      reason: string;
      authenticationHash: string;
    };

export interface X402BuyerLeaseToken {
  owner: string;
  generation: number;
}

export interface X402BuyerSettlementLease extends X402BuyerLeaseToken {
  stage: "fresh" | "reconcile" | "replay";
  expiresAt: number;
}

export type X402BuyerSettlementLoad =
  | { status: "absent" }
  | {
      status: "held";
      intent: Readonly<X402BuyerSettlementIntent>;
      lease: Readonly<X402BuyerSettlementLease>;
    }
  | {
      status: "captured" | "failed";
      intent: Readonly<X402BuyerSettlementIntent>;
      outcome: Readonly<X402BuyerSettlementOutcome>;
    }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type X402BuyerSettlementClaim =
  | {
      status: "acquired";
      intent: Readonly<X402BuyerSettlementIntent>;
      lease: Readonly<X402BuyerSettlementLease>;
    }
  | {
      status: "waiting";
      intent: Readonly<X402BuyerSettlementIntent>;
      lease: Readonly<X402BuyerSettlementLease>;
    }
  | {
      status: "captured" | "failed";
      intent: Readonly<X402BuyerSettlementIntent>;
      outcome: Readonly<X402BuyerSettlementOutcome>;
    }
  | { status: "conflict" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type X402BuyerRecoveryGrant =
  | {
      status: "granted";
      intent: Readonly<X402BuyerSettlementIntent>;
      lease: Readonly<X402BuyerSettlementLease>;
    }
  | { status: "stale" | "conflict" }
  | {
      status: "captured" | "failed";
      intent: Readonly<X402BuyerSettlementIntent>;
      outcome: Readonly<X402BuyerSettlementOutcome>;
    }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

export type X402BuyerOutcomeWrite =
  | {
      status: "recorded" | "existing";
      intent: Readonly<X402BuyerSettlementIntent>;
      outcome: Readonly<X402BuyerSettlementOutcome>;
    }
  | { status: "stale" | "conflict" }
  | { status: "unsupported"; version: number }
  | { status: "corrupt"; reason: string };

/**
 * Atomic storage contract. Implementations must serialize every mutation by
 * settlement key and must never overwrite an intent or terminal outcome.
 */
export interface X402BuyerSettlementStore {
  load(settlementKey: string): Promise<X402BuyerSettlementLoad>;
  claim(input: {
    intent: Readonly<X402BuyerSettlementIntent>;
    owner: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<X402BuyerSettlementClaim>;
  isCurrent(input: {
    settlementKey: string;
    bindingHash: string;
    lease: Readonly<X402BuyerLeaseToken>;
    now: number;
  }): Promise<boolean>;
  grantRecovery(input: {
    settlementKey: string;
    bindingHash: string;
    lease: Readonly<X402BuyerLeaseToken>;
    owner: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<X402BuyerRecoveryGrant>;
  recordOutcome(input: {
    settlementKey: string;
    bindingHash: string;
    lease: Readonly<X402BuyerLeaseToken>;
    outcome: Readonly<X402BuyerSettlementOutcome>;
    now: number;
  }): Promise<X402BuyerOutcomeWrite>;
}

/** Fence supplied to every callback that can observe or move value. */
export interface X402BuyerEffectFence extends X402BuyerLeaseToken {
  settlementKey: string;
  bindingHash: string;
  idempotencyKey: string;
  assertCurrent(): Promise<void>;
}

export type X402BuyerAuthorizationLookup<TObservation = unknown> =
  | { disposition: "observed"; observation: TObservation }
  | { disposition: "unavailable"; reason: string };

/** Four-valued authenticated reconciliation; only unused can permit replay. */
export type X402BuyerAuthorizationReconciliation =
  | {
      disposition: "settled-same";
      settlement: Readonly<X402BuyerCapturedSettlement>;
    }
  | { disposition: "unused"; reason: string; authenticationHash: string }
  | {
      disposition: "used-different" | "cancelled";
      reason: string;
      authenticationHash: string;
    }
  | { disposition: "indeterminate"; reason: string };

/** Independent pre-effect authentication of the complete retained intent. */
export type X402BuyerIntentAuthorization =
  | { disposition: "authorized"; bindingHash: string }
  | { disposition: "rejected" | "indeterminate"; reason: string };

/**
 * Chain reads and their authentication are deliberately separate. A raw RPC
 * shape or a transport response never authorizes replay or success.
 */
export interface X402BuyerAuthorizationProvider<TObservation = unknown> {
  authorizeIntent(
    intent: Readonly<X402BuyerSettlementIntent>,
    fence: Readonly<X402BuyerEffectFence>,
  ): Promise<X402BuyerIntentAuthorization>;
  lookup(
    intent: Readonly<X402BuyerSettlementIntent>,
    candidate: Readonly<X402BuyerSettlementDisclosure> | undefined,
    fence: Readonly<X402BuyerEffectFence>,
  ): Promise<X402BuyerAuthorizationLookup<TObservation>>;
  authenticate(
    intent: Readonly<X402BuyerSettlementIntent>,
    lookup: Readonly<Extract<X402BuyerAuthorizationLookup<TObservation>, {
      disposition: "observed";
    }>>,
    candidate: Readonly<X402BuyerSettlementDisclosure> | undefined,
    fence: Readonly<X402BuyerEffectFence>,
  ): Promise<X402BuyerAuthorizationReconciliation>;
}

/** Paid HTTP response material is only a candidate until chain-authenticated. */
export interface X402BuyerSettlementDisclosure {
  protocolVersion: "2";
  headerName: "PAYMENT-RESPONSE";
  encodedSettlementHeader: string;
  httpResource: string;
}

export type X402BuyerPaidRequestResult =
  | {
      disposition: "response";
      disclosure?: Readonly<X402BuyerSettlementDisclosure>;
    }
  | { disposition: "indeterminate"; reason: string };

export interface X402BuyerPaidRequestTransport {
  /**
   * Submit only the retained bytes. Implementations must call
   * `fence.assertCurrent()` immediately before the external request.
   */
  submitRetained(
    intent: Readonly<X402BuyerSettlementIntent>,
    fence: Readonly<X402BuyerEffectFence>,
  ): Promise<X402BuyerPaidRequestResult>;
}

export type X402BuyerSettlementProgress =
  | { status: "waiting"; reason: string }
  | { status: "indeterminate"; reason: string }
  | {
      status: "failed";
      outcome: Readonly<Extract<X402BuyerSettlementOutcome, { status: "failed" }>>;
    }
  | {
      status: "captured";
      outcome: Readonly<Extract<X402BuyerSettlementOutcome, { status: "captured" }>>;
    };

export interface AdvanceX402BuyerSettlementInput<TObservation = unknown> {
  intent: Readonly<X402BuyerSettlementIntent>;
  owner: string;
  store: X402BuyerSettlementStore;
  authorizationProvider: X402BuyerAuthorizationProvider<TObservation>;
  transport: X402BuyerPaidRequestTransport;
  now?: () => number;
  leaseDurationMs?: number;
}

interface StoredRecord {
  storeVersion: typeof X402_BUYER_SETTLEMENT_STORE_VERSION;
  intent: X402BuyerSettlementIntent;
  generation: number;
  lease: X402BuyerSettlementLease;
  outcome?: X402BuyerSettlementOutcome;
  createdAt: number;
  updatedAt: number;
}

const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!isRecord(value) || nodeTypes.isProxy(value)) {
    throw new DacsError(`${label} must be a non-proxy record`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) {
    throw new DacsError(`${label} must use a plain prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.length !== 0) throw new DacsError(`${label} cannot contain symbols`);
  const keys = Object.keys(descriptors);
  const allowed = new Set([...required, ...optional]);
  const missing = required.find((key) => !hasOwn(descriptors, key));
  const extra = keys.find((key) => !allowed.has(key));
  if (missing) throw new DacsError(`${label}.${missing} is required`);
  if (extra) throw new DacsError(`${label}.${extra} is not permitted`);
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor) ||
        descriptor.value === undefined) {
      throw new DacsError(`${label}.${key} must be an enumerable data property`);
    }
  }
  return value;
}

function snapshotJson(
  value: unknown,
  label: string,
  ancestors = new Set<object>(),
  depth = 0,
): X402BuyerJson {
  if (depth > 64) throw new DacsError(`${label} exceeds the supported JSON depth`);
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    // This snapshot is also the retained x402/EIP-712 wire payload. Preserve
    // its exact Unicode spelling; canonicalize() applies CF-1 only when a DACS
    // hash/comparison is actually computed.
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER ||
        Object.is(value, -0)) {
      throw new DacsError(`${label} contains a non-canonical number`);
    }
    return value;
  }
  if (typeof value !== "object" || nodeTypes.isProxy(value)) {
    throw new DacsError(`${label} must contain only non-proxy JSON data`);
  }
  if (ancestors.has(value)) throw new DacsError(`${label} must be acyclic`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new DacsError(`${label} arrays must use the intrinsic prototype`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const length = value.length;
      const keys = Object.keys(descriptors).filter((key) => key !== "length");
      if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length ||
          keys.some((key, index) => key !== String(index))) {
        throw new DacsError(`${label} arrays must be dense`);
      }
      return keys.map((key) => {
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new DacsError(`${label} cannot contain array accessors`);
        }
        return snapshotJson(descriptor.value, label, ancestors, depth + 1);
      });
    }
    if (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) {
      throw new DacsError(`${label} must contain only plain records`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length !== 0) {
      throw new DacsError(`${label} cannot contain symbols`);
    }
    const result = Object.create(null) as Record<string, X402BuyerJson>;
    const normalized = new Set<string>();
    for (const [rawKey, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor) ||
          descriptor.value === undefined) {
        throw new DacsError(`${label}.${rawKey} must be an enumerable data property`);
      }
      const key = rawKey.normalize("NFC");
      if (normalized.has(key)) throw new DacsError(`${label} has an NFC key collision`);
      normalized.add(key);
      result[rawKey] = snapshotJson(descriptor.value, label, ancestors, depth + 1);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function snapshotRecord(
  value: unknown,
  label: string,
): Record<string, X402BuyerJson> {
  const captured = snapshotJson(value, label);
  if (!isRecord(captured)) throw new DacsError(`${label} must be a JSON record`);
  return captured as Record<string, X402BuyerJson>;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function nfcString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 ||
      value.normalize("NFC") !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DacsError(`${label} must be a non-empty NFC string without controls`);
  }
  return value;
}

function exactSessionString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new DacsError(`${label} must be a non-empty string without controls`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new DacsError(`${label} must contain only Unicode scalar values`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new DacsError(`${label} must contain only Unicode scalar values`);
    }
  }
  return value;
}

function asciiString(value: unknown, label: string): string {
  const captured = nfcString(value, label);
  if (!PRINTABLE_ASCII_RE.test(captured)) {
    throw new DacsError(`${label} must be printable ASCII`);
  }
  return captured;
}

function hashString(value: unknown, label: string): string {
  if (typeof value !== "string" || !HASH_RE.test(value)) {
    throw new DacsError(`${label} must be a lower-case sha256 hash`);
  }
  return value;
}

function uint(value: unknown, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0) ||
      Object.is(value, -0)) {
    throw new DacsError(`${label} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return value as number;
}

function finiteTime(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new DacsError(`${label} must be a finite timestamp`);
  }
  return value;
}

function address(value: unknown, label: string): string {
  if (typeof value !== "string" || !ADDRESS_RE.test(value)) {
    throw new DacsError(`${label} must be an EVM address`);
  }
  return value;
}

function amount(value: unknown, label: string): string {
  if (typeof value !== "string" || !UNSIGNED_RE.test(value) || BigInt(value) <= 0n) {
    throw new DacsError(`${label} must be positive integer base units`);
  }
  return value;
}

function network(value: unknown, label: string): `eip155:${string}` {
  if (typeof value !== "string") throw new DacsError(`${label} is invalid`);
  const match = /^eip155:([1-9][0-9]*)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1]))) {
    throw new DacsError(`${label} must be canonical eip155:<chainId>`);
  }
  return value as `eip155:${string}`;
}

function resource(value: unknown, label: string): string {
  const text = nfcString(value, label);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new DacsError(`${label} must be an absolute HTTP(S) URL`);
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    throw new DacsError(`${label} must be an uncredentialed HTTP(S) URL without a fragment`);
  }
  return text;
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function expectedNonce(jobId: string, phaseIndex: number): `0x${string}` {
  return `0x${sha256Hex(`dacs-sb3:v1:${jobId.normalize("NFC")}:${phaseIndex}`)}`;
}

/** Stable exact-byte key encoding of (railId, jobId, phaseIndex). */
export function x402BuyerSettlementKey(input: {
  railId: string;
  jobId: string;
  phaseIndex: number;
}): string {
  const railId = asciiString(input?.railId, "x402 buyer railId");
  const jobId = exactSessionString(input?.jobId, "x402 buyer jobId");
  const phaseIndex = uint(input?.phaseIndex, "x402 buyer phaseIndex");
  const keyPreimage =
    `dacs-x402-buyer-key:v1:${Buffer.byteLength(railId, "utf8")}:${railId}:` +
    `${Buffer.byteLength(jobId, "utf8")}:${jobId}:${phaseIndex}`;
  return `dacs:x402-buyer:${sha256Hex(keyPreimage)}`;
}

function captureRequirements(
  value: unknown,
): Readonly<X402BuyerPaymentRequirements> {
  const record = exactRecord(value, "x402 buyer chosenRequirements", [
    "scheme",
    "network",
    "amount",
    "asset",
    "payTo",
    "maxTimeoutSeconds",
    "extra",
  ]);
  const extra = snapshotRecord(record.extra, "x402 buyer requirements.extra");
  return deepFreeze({
    scheme: asciiString(record.scheme, "x402 buyer requirement scheme"),
    network: network(record.network, "x402 buyer requirement network"),
    amount: amount(record.amount, "x402 buyer requirement amount"),
    asset: address(record.asset, "x402 buyer requirement asset"),
    payTo: address(record.payTo, "x402 buyer requirement payTo"),
    maxTimeoutSeconds: uint(
      record.maxTimeoutSeconds,
      "x402 buyer requirement maxTimeoutSeconds",
      true,
    ),
    extra,
  });
}

/** JSON.parse drops all but the last duplicate member; reject that ambiguity. */
function hasDuplicateJsonObjectNames(source: string): boolean {
  let offset = 0;

  const skipWhitespace = (): void => {
    while (offset < source.length && JSON_WHITESPACE_RE.test(source[offset]!)) {
      offset += 1;
    }
  };

  const scanString = (): string => {
    const start = offset;
    offset += 1;
    while (offset < source.length) {
      const character = source[offset++]!;
      if (character === '"') return source.slice(start, offset);
      if (character === "\\") {
        const escape = source[offset++]!;
        if (escape === "u") offset += 4;
      }
    }
    throw new DacsError("x402 buyer JSON string is unterminated");
  };

  const scanValue = (depth: number): boolean => {
    if (depth > 64) throw new DacsError("x402 buyer JSON exceeds the supported depth");
    skipWhitespace();
    const character = source[offset];
    if (character === "{") {
      offset += 1;
      skipWhitespace();
      const names = new Set<string>();
      if (source[offset] === "}") {
        offset += 1;
        return false;
      }
      for (;;) {
        skipWhitespace();
        const rawName = scanString();
        const name = JSON.parse(rawName) as string;
        if (names.has(name)) return true;
        names.add(name);
        skipWhitespace();
        offset += 1;
        if (scanValue(depth + 1)) return true;
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return false;
        }
        offset += 1;
      }
    }
    if (character === "[") {
      offset += 1;
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return false;
      }
      for (;;) {
        if (scanValue(depth + 1)) return true;
        skipWhitespace();
        if (source[offset] === "]") {
          offset += 1;
          return false;
        }
        offset += 1;
      }
    }
    if (character === '"') {
      scanString();
      return false;
    }
    while (offset < source.length &&
        !JSON_WHITESPACE_RE.test(source[offset]!) &&
        !",]}".includes(source[offset]!)) {
      offset += 1;
    }
    return false;
  };

  return scanValue(0);
}

function decodeCanonicalBase64Json(value: unknown, label: string): Record<string, X402BuyerJson> {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_HEADER_CHARACTERS ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new DacsError(`${label} must be canonical base64 JSON`);
  }
  const unpadded = value.replace(/=+$/, "");
  const padded = unpadded + "=".repeat((4 - unpadded.length % 4) % 4);
  const bytes = Buffer.from(padded, "base64");
  const canonicalPadded = bytes.toString("base64");
  const expected = value.includes("=")
    ? canonicalPadded
    : canonicalPadded.replace(/=+$/, "");
  if (expected !== value) throw new DacsError(`${label} must be canonical base64 JSON`);
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DacsError(`${label} must contain UTF-8 JSON`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
    if (hasDuplicateJsonObjectNames(json)) {
      throw new DacsError(`${label} contains duplicate JSON members`);
    }
  } catch {
    throw new DacsError(`${label} must contain valid JSON`);
  }
  return snapshotRecord(parsed, label);
}

interface CapturedBuyerSettlementReceipt {
  paymentReceiptHash: string;
  transaction: string;
  chainId: number;
  protocolVersion: "2";
  payer: string;
  amount?: string;
}

/** Adapt PR122's normative receipt foundation to the buyer recovery boundary. */
function captureBuyerSettlementReceipt(
  encodedHeader: unknown,
): Readonly<CapturedBuyerSettlementReceipt> {
  if (typeof encodedHeader !== "string" || encodedHeader.length === 0 ||
      encodedHeader.length > MAX_HEADER_CHARACTERS) {
    throw new DacsError("x402 buyer settlement header is invalid");
  }
  const commitment = deriveX402ReceiptCommitment({
    protocolVersion: "2",
    responseHeader: { name: "PAYMENT-RESPONSE", value: encodedHeader },
  });
  if (commitment.disposition !== "pass" || !commitment.receipt ||
      !commitment.computedPaymentReceiptHash) {
    throw new DacsError(`x402 buyer settlement header is invalid: ${commitment.reason}`);
  }
  const transaction = commitment.receipt.transaction;
  if (typeof transaction !== "string" || !RECEIPT_TX_RE.test(transaction)) {
    throw new DacsError("x402 buyer settlement receipt transaction is malformed");
  }
  const receiptNetwork = network(
    commitment.receipt.network,
    "x402 buyer settlement receipt network",
  );
  const payer = address(commitment.receipt.payer, "x402 buyer settlement receipt payer");
  const receiptAmount = commitment.receipt.amount === undefined
    ? undefined
    : amount(commitment.receipt.amount, "x402 buyer settlement receipt amount");
  return deepFreeze({
    paymentReceiptHash: hashString(
      commitment.computedPaymentReceiptHash,
      "x402 buyer settlement receipt hash",
    ),
    transaction,
    chainId: Number(receiptNetwork.slice("eip155:".length)),
    protocolVersion: "2",
    payer,
    ...(receiptAmount === undefined ? {} : { amount: receiptAmount }),
  });
}

function captureSignedPayload(
  value: unknown,
  requirements: Readonly<X402BuyerPaymentRequirements>,
  expected: {
    httpResource: string;
    payer: string;
    payee: string;
    amount: string;
    nonce: string;
  },
): Readonly<Record<string, X402BuyerJson>> {
  const payload = snapshotRecord(value, "x402 buyer signedPaymentPayload");
  if (payload.x402Version !== 2) {
    throw new DacsError("x402 buyer signedPaymentPayload must be protocol version 2");
  }
  if (canonicalize(payload.accepted) !== canonicalize(requirements)) {
    throw new DacsError("x402 buyer signedPaymentPayload accepted requirements mismatch");
  }
  if (payload.resource !== undefined) {
    if (!isRecord(payload.resource) || payload.resource.url !== expected.httpResource) {
      throw new DacsError("x402 buyer signedPaymentPayload resource mismatch");
    }
  }
  if (!isRecord(payload.payload)) {
    throw new DacsError("x402 buyer signedPaymentPayload.payload must be a record");
  }
  const authorization = payload.payload.authorization;
  const signature = payload.payload.signature;
  if (!isRecord(authorization) || typeof signature !== "string" ||
      !SIGNATURE_RE.test(signature)) {
    throw new DacsError("x402 buyer signedPaymentPayload must contain a signed EIP-3009 authorization");
  }
  const from = address(authorization.from, "x402 buyer authorization.from");
  const to = address(authorization.to, "x402 buyer authorization.to");
  const valueAmount = amount(authorization.value, "x402 buyer authorization.value");
  if (!sameAddress(from, expected.payer) || !sameAddress(to, expected.payee) ||
      valueAmount !== expected.amount || authorization.nonce !== expected.nonce) {
    throw new DacsError("x402 buyer signed authorization does not match the retained intent");
  }
  if (typeof authorization.validAfter !== "string" ||
      !UNSIGNED_RE.test(authorization.validAfter) ||
      typeof authorization.validBefore !== "string" ||
      !UNSIGNED_RE.test(authorization.validBefore) ||
      BigInt(authorization.validBefore) <= BigInt(authorization.validAfter)) {
    throw new DacsError("x402 buyer authorization window is malformed");
  }
  return deepFreeze(payload);
}

function intentHashScope(intent: Omit<X402BuyerSettlementIntent, "bindingHash">): string {
  return sha256Hex(canonicalize(intent));
}

/** Validate, snapshot and hash a complete pre-signed durable intent. */
export function createX402BuyerSettlementIntent(
  draft: Readonly<X402BuyerSettlementIntentDraft>,
): Readonly<X402BuyerSettlementIntent> {
  const record = exactRecord(draft, "x402 buyer intent draft", [
    "jobId",
    "phaseIndex",
    "railId",
    "railVersion",
    "railDescriptorHash",
    "agreementHash",
    "termsHash",
    "sessionBindingHash",
    "network",
    "payer",
    "payee",
    "asset",
    "amount",
    "httpResource",
    "method",
    "chosenRequirements",
    "signedPaymentPayload",
    "paymentHeader",
    "authorizationNonce",
  ]);
  const jobId = exactSessionString(record.jobId, "x402 buyer jobId");
  const phaseIndex = uint(record.phaseIndex, "x402 buyer phaseIndex");
  const railId = asciiString(record.railId, "x402 buyer railId");
  const railVersion = asciiString(record.railVersion, "x402 buyer railVersion");
  const selectedNetwork = network(record.network, "x402 buyer network");
  const payer = address(record.payer, "x402 buyer payer");
  const payee = address(record.payee, "x402 buyer payee");
  const asset = address(record.asset, "x402 buyer asset");
  const selectedAmount = amount(record.amount, "x402 buyer amount");
  const httpResource = resource(record.httpResource, "x402 buyer httpResource");
  if (record.method !== "GET") throw new DacsError("x402 buyer method must be GET");
  const nonce = record.authorizationNonce;
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce) ||
      nonce !== expectedNonce(jobId, phaseIndex)) {
    throw new DacsError("x402 buyer authorization nonce does not satisfy DACS-4 SB-3");
  }
  const requirements = captureRequirements(record.chosenRequirements);
  if (requirements.scheme !== "exact" || requirements.network !== selectedNetwork ||
      !sameAddress(requirements.payTo, payee) ||
      !sameAddress(requirements.asset, asset) || requirements.amount !== selectedAmount) {
    throw new DacsError("x402 buyer chosen requirements do not match authenticated terms");
  }
  const signedPaymentPayload = captureSignedPayload(record.signedPaymentPayload, requirements, {
    httpResource,
    payer,
    payee,
    amount: selectedAmount,
    nonce,
  });
  const header = exactRecord(record.paymentHeader, "x402 buyer paymentHeader", [
    "name",
    "value",
  ]);
  if (header.name !== "PAYMENT-SIGNATURE") {
    throw new DacsError("x402 v2 requires PAYMENT-SIGNATURE");
  }
  const decoded = decodeCanonicalBase64Json(header.value, "x402 buyer PAYMENT-SIGNATURE");
  if (canonicalize(decoded) !== canonicalize(signedPaymentPayload)) {
    throw new DacsError("x402 buyer PAYMENT-SIGNATURE does not encode the retained signed payload");
  }
  const settlementKey = x402BuyerSettlementKey({ railId, jobId, phaseIndex });
  const withoutHash: Omit<X402BuyerSettlementIntent, "bindingHash"> = {
    intentVersion: "1",
    settlementKey,
    jobId,
    phaseIndex,
    railId,
    railVersion,
    railDescriptorHash: hashString(record.railDescriptorHash, "x402 buyer railDescriptorHash"),
    agreementHash: hashString(record.agreementHash, "x402 buyer agreementHash"),
    termsHash: hashString(record.termsHash, "x402 buyer termsHash"),
    sessionBindingHash: hashString(record.sessionBindingHash, "x402 buyer sessionBindingHash"),
    network: selectedNetwork,
    payer,
    payee,
    asset,
    amount: selectedAmount,
    httpResource,
    method: "GET",
    chosenRequirements: requirements,
    signedPaymentPayload,
    paymentHeader: deepFreeze({ name: "PAYMENT-SIGNATURE", value: header.value as string }),
    authorizationNonce: nonce as `0x${string}`,
  };
  return deepFreeze({ ...withoutHash, bindingHash: intentHashScope(withoutHash) });
}

function captureIntent(value: unknown): Readonly<X402BuyerSettlementIntent> {
  const record = exactRecord(value, "x402 buyer settlement intent", [
    "intentVersion",
    "settlementKey",
    "bindingHash",
    "jobId",
    "phaseIndex",
    "railId",
    "railVersion",
    "railDescriptorHash",
    "agreementHash",
    "termsHash",
    "sessionBindingHash",
    "network",
    "payer",
    "payee",
    "asset",
    "amount",
    "httpResource",
    "method",
    "chosenRequirements",
    "signedPaymentPayload",
    "paymentHeader",
    "authorizationNonce",
  ]);
  if (record.intentVersion !== "1") {
    throw new DacsError("unsupported x402 buyer intentVersion");
  }
  const bindingHash = hashString(record.bindingHash, "x402 buyer bindingHash");
  const rebuilt = createX402BuyerSettlementIntent({
    jobId: record.jobId as string,
    phaseIndex: record.phaseIndex as number,
    railId: record.railId as string,
    railVersion: record.railVersion as string,
    railDescriptorHash: record.railDescriptorHash as string,
    agreementHash: record.agreementHash as string,
    termsHash: record.termsHash as string,
    sessionBindingHash: record.sessionBindingHash as string,
    network: record.network as `eip155:${string}`,
    payer: record.payer as string,
    payee: record.payee as string,
    asset: record.asset as string,
    amount: record.amount as string,
    httpResource: record.httpResource as string,
    method: record.method as "GET",
    chosenRequirements: record.chosenRequirements as X402BuyerPaymentRequirements,
    signedPaymentPayload: record.signedPaymentPayload as Record<string, X402BuyerJson>,
    paymentHeader: record.paymentHeader as X402BuyerSettlementIntent["paymentHeader"],
    authorizationNonce: record.authorizationNonce as `0x${string}`,
  });
  if (record.settlementKey !== rebuilt.settlementKey || bindingHash !== rebuilt.bindingHash) {
    throw new DacsError("x402 buyer intent key or binding hash mismatch");
  }
  return rebuilt;
}

/** Strict persisted/public intent assertion. */
export function assertX402BuyerSettlementIntent(
  value: unknown,
): asserts value is X402BuyerSettlementIntent {
  captureIntent(value);
}

function captureDisclosure(value: unknown): Readonly<X402BuyerSettlementDisclosure> {
  const record = exactRecord(value, "x402 buyer settlement disclosure", [
    "protocolVersion",
    "headerName",
    "encodedSettlementHeader",
    "httpResource",
  ]);
  if (record.protocolVersion !== "2" || record.headerName !== "PAYMENT-RESPONSE") {
    throw new DacsError("x402 buyer disclosure must use v2 PAYMENT-RESPONSE");
  }
  // Full receipt parsing is repeated after the authenticated signed event is known.
  captureBuyerSettlementReceipt(record.encodedSettlementHeader);
  return deepFreeze({
    protocolVersion: "2",
    headerName: "PAYMENT-RESPONSE",
    encodedSettlementHeader: record.encodedSettlementHeader as string,
    httpResource: resource(record.httpResource, "x402 buyer disclosure httpResource"),
  });
}

function captureSignedEvent(value: unknown): Readonly<X402BuyerSignedEventReference> {
  const record = exactRecord(value, "x402 buyer signed x402-event", [
    "kind",
    "httpResource",
    "paymentReceiptHash",
    "protocolVersion",
    "settlementTxHash",
    "chainId",
    "logIndex",
  ]);
  if (record.kind !== "x402-event" || record.protocolVersion !== "2") {
    throw new DacsError("x402 buyer settlement requires a current signed x402-event");
  }
  if (typeof record.settlementTxHash !== "string" ||
      !CANONICAL_EVENT_TX_RE.test(record.settlementTxHash)) {
    throw new DacsError(
      "x402 buyer signed event transaction hash must be canonical lower-case hex without 0x",
    );
  }
  return deepFreeze({
    kind: "x402-event",
    httpResource: resource(record.httpResource, "x402 buyer signed event httpResource"),
    paymentReceiptHash: hashString(
      record.paymentReceiptHash,
      "x402 buyer signed event paymentReceiptHash",
    ),
    protocolVersion: "2",
    settlementTxHash: record.settlementTxHash,
    chainId: uint(record.chainId, "x402 buyer signed event chainId", true),
    logIndex: uint(record.logIndex, "x402 buyer signed event logIndex"),
  });
}

/**
 * Stable retained authentication envelope. The provider returns this only
 * after verifying the signed evidence/ledger observation; it prevents a
 * caller from changing an authenticated event coordinate after that check.
 */
export function x402BuyerSettlementAuthenticationHash(input: {
  intent: Readonly<X402BuyerSettlementIntent>;
  signedEvent: Readonly<X402BuyerSignedEventReference>;
}): string {
  const intent = captureIntent(input?.intent);
  const signedEvent = captureSignedEvent(input?.signedEvent);
  return sha256Hex(canonicalize({
    authenticationVersion: "1",
    bindingHash: intent.bindingHash,
    signedEvent,
  }));
}

function captureSettlement(
  value: unknown,
  intent: Readonly<X402BuyerSettlementIntent>,
): Readonly<X402BuyerCapturedSettlement> {
  const record = exactRecord(value, "x402 buyer captured settlement", [
    "captureVersion",
    "protocolVersion",
    "headerName",
    "encodedSettlementHeader",
    "httpResource",
    "signedEvent",
    "authenticationHash",
  ]);
  if (record.captureVersion !== "1") {
    throw new DacsError("unsupported x402 buyer captureVersion");
  }
  const disclosure = captureDisclosure({
    protocolVersion: record.protocolVersion,
    headerName: record.headerName,
    encodedSettlementHeader: record.encodedSettlementHeader,
    httpResource: record.httpResource,
  });
  const signedEvent = captureSignedEvent(record.signedEvent);
  if (disclosure.httpResource !== intent.httpResource ||
      signedEvent.httpResource !== intent.httpResource ||
      `eip155:${signedEvent.chainId}` !== intent.network) {
    throw new DacsError("x402 buyer captured settlement does not match the retained intent");
  }
  const receipt = captureBuyerSettlementReceipt(disclosure.encodedSettlementHeader);
  if (receipt.paymentReceiptHash !== signedEvent.paymentReceiptHash ||
      receipt.transaction.slice(2).toLowerCase() !== signedEvent.settlementTxHash ||
      receipt.chainId !== signedEvent.chainId || receipt.protocolVersion !== signedEvent.protocolVersion) {
    throw new DacsError("x402 buyer complete receipt does not match the signed x402-event");
  }
  if (receipt.payer !== undefined && !sameAddress(receipt.payer, intent.payer)) {
    throw new DacsError("x402 buyer receipt payer does not match the retained intent");
  }
  if (receipt.amount !== undefined && receipt.amount !== intent.amount) {
    throw new DacsError("x402 buyer receipt amount does not match the retained intent");
  }
  const authenticationHash = hashString(
    record.authenticationHash,
    "x402 buyer capture authenticationHash",
  );
  if (authenticationHash !== x402BuyerSettlementAuthenticationHash({
    intent,
    signedEvent,
  })) {
    throw new DacsError("x402 buyer authentication hash does not bind the signed event");
  }
  return deepFreeze({
    captureVersion: "1",
    protocolVersion: "2",
    headerName: "PAYMENT-RESPONSE",
    encodedSettlementHeader: disclosure.encodedSettlementHeader,
    httpResource: disclosure.httpResource,
    signedEvent,
    authenticationHash,
  });
}

function captureOutcome(
  value: unknown,
  intent: Readonly<X402BuyerSettlementIntent>,
): Readonly<X402BuyerSettlementOutcome> {
  if (!isRecord(value)) throw new DacsError("x402 buyer outcome must be a record");
  if (value.outcomeVersion !== "1") throw new DacsError("unsupported x402 buyer outcomeVersion");
  if (value.status === "captured") {
    exactRecord(value, "x402 buyer captured outcome", [
      "outcomeVersion",
      "status",
      "settlement",
    ]);
    return deepFreeze({
      outcomeVersion: "1",
      status: "captured",
      settlement: captureSettlement(value.settlement, intent),
    });
  }
  if (value.status === "failed") {
    exactRecord(value, "x402 buyer failed outcome", [
      "outcomeVersion",
      "status",
      "failure",
      "reason",
      "authenticationHash",
    ]);
    if (value.failure !== "used-different" && value.failure !== "cancelled") {
      throw new DacsError("x402 buyer failure is not terminal-authenticated");
    }
    return deepFreeze({
      outcomeVersion: "1",
      status: "failed",
      failure: value.failure,
      reason: nfcString(value.reason, "x402 buyer terminal failure reason"),
      authenticationHash: hashString(
        value.authenticationHash,
        "x402 buyer terminal failure authenticationHash",
      ),
    });
  }
  throw new DacsError("x402 buyer outcome status is invalid");
}

function captureLease(value: unknown): Readonly<X402BuyerSettlementLease> {
  const record = exactRecord(value, "x402 buyer lease", [
    "owner",
    "generation",
    "stage",
    "expiresAt",
  ]);
  if (record.stage !== "fresh" && record.stage !== "reconcile" && record.stage !== "replay") {
    throw new DacsError("x402 buyer lease stage is invalid");
  }
  return deepFreeze({
    owner: asciiString(record.owner, "x402 buyer lease owner"),
    generation: uint(record.generation, "x402 buyer lease generation", true),
    stage: record.stage,
    expiresAt: finiteTime(record.expiresAt, "x402 buyer lease expiry"),
  });
}

function captureStoredRecord(value: unknown): Readonly<StoredRecord> {
  const record = exactRecord(value, "x402 buyer stored record", [
    "storeVersion",
    "intent",
    "generation",
    "lease",
    "createdAt",
    "updatedAt",
  ], ["outcome"]);
  if (record.storeVersion !== X402_BUYER_SETTLEMENT_STORE_VERSION) {
    throw new DacsError("unsupported x402 buyer storeVersion");
  }
  const intent = captureIntent(record.intent);
  const generation = uint(record.generation, "x402 buyer stored generation", true);
  const lease = captureLease(record.lease);
  if (lease.generation !== generation) {
    throw new DacsError("x402 buyer lease generation is inconsistent");
  }
  const outcome = record.outcome === undefined
    ? undefined
    : captureOutcome(record.outcome, intent);
  return deepFreeze({
    storeVersion: X402_BUYER_SETTLEMENT_STORE_VERSION,
    intent,
    generation,
    lease,
    ...(outcome === undefined ? {} : { outcome }),
    createdAt: finiteTime(record.createdAt, "x402 buyer record createdAt"),
    updatedAt: finiteTime(record.updatedAt, "x402 buyer record updatedAt"),
  });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function terminalLoad(record: Readonly<StoredRecord>): X402BuyerSettlementLoad | null {
  if (!record.outcome) return null;
  return {
    status: record.outcome.status,
    intent: deepFreeze(clone(record.intent)),
    outcome: deepFreeze(clone(record.outcome)),
  };
}

function terminalClaim(record: Readonly<StoredRecord>): X402BuyerSettlementClaim | null {
  return terminalLoad(record) as X402BuyerSettlementClaim | null;
}

/** Process-local atomic reference store with the same fencing semantics as FS. */
export function createInMemoryX402BuyerSettlementStore(
  initial: readonly unknown[] = [],
): X402BuyerSettlementStore {
  const records = new Map<string, StoredRecord>();
  for (const candidate of initial) {
    const record = captureStoredRecord(candidate);
    if (records.has(record.intent.settlementKey)) {
      throw new DacsError("duplicate initial x402 buyer settlement key");
    }
    records.set(record.intent.settlementKey, clone(record));
  }

  const read = (settlementKey: string): StoredRecord | undefined =>
    records.get(settlementKey);

  return {
    async load(settlementKey) {
      const record = read(settlementKey);
      if (!record) return { status: "absent" };
      const terminal = terminalLoad(record);
      if (terminal) return terminal;
      return {
        status: "held",
        intent: deepFreeze(clone(record.intent)),
        lease: deepFreeze(clone(record.lease)),
      };
    },
    async claim(input) {
      const intent = captureIntent(input.intent);
      const owner = asciiString(input.owner, "x402 buyer claim owner");
      const now = finiteTime(input.now, "x402 buyer claim time");
      const leaseDurationMs = uint(
        input.leaseDurationMs,
        "x402 buyer lease duration",
        true,
      );
      const current = read(intent.settlementKey);
      if (!current) {
        const lease: X402BuyerSettlementLease = {
          owner,
          generation: 1,
          stage: "fresh",
          expiresAt: now + leaseDurationMs,
        };
        const installed: StoredRecord = {
          storeVersion: X402_BUYER_SETTLEMENT_STORE_VERSION,
          intent: clone(intent),
          generation: 1,
          lease,
          createdAt: now,
          updatedAt: now,
        };
        records.set(intent.settlementKey, installed);
        return {
          status: "acquired",
          intent: deepFreeze(clone(intent)),
          lease: deepFreeze(clone(lease)),
        };
      }
      if (current.intent.bindingHash !== intent.bindingHash) return { status: "conflict" };
      const terminal = terminalClaim(current);
      if (terminal) return terminal;
      if (current.lease.expiresAt > now) {
        return {
          status: "waiting",
          intent: deepFreeze(clone(current.intent)),
          lease: deepFreeze(clone(current.lease)),
        };
      }
      const generation = current.generation + 1;
      if (!Number.isSafeInteger(generation)) return { status: "corrupt", reason: "lease generation exhausted" };
      const lease: X402BuyerSettlementLease = {
        owner,
        generation,
        stage: "reconcile",
        expiresAt: now + leaseDurationMs,
      };
      current.generation = generation;
      current.lease = lease;
      current.updatedAt = now;
      return {
        status: "acquired",
        intent: deepFreeze(clone(current.intent)),
        lease: deepFreeze(clone(lease)),
      };
    },
    async isCurrent(input) {
      const current = read(input.settlementKey);
      if (!current || current.outcome || current.intent.bindingHash !== input.bindingHash) return false;
      return current.lease.owner === input.lease.owner &&
        current.lease.generation === input.lease.generation &&
        current.lease.expiresAt > input.now;
    },
    async grantRecovery(input) {
      const current = read(input.settlementKey);
      if (!current) return { status: "stale" };
      if (current.intent.bindingHash !== input.bindingHash) return { status: "conflict" };
      const terminal = terminalClaim(current);
      if (terminal) return terminal as X402BuyerRecoveryGrant;
      if (current.lease.owner !== input.lease.owner ||
          current.lease.generation !== input.lease.generation ||
          current.lease.stage !== "reconcile" || current.lease.expiresAt <= input.now) {
        return { status: "stale" };
      }
      const generation = current.generation + 1;
      if (!Number.isSafeInteger(generation)) return { status: "corrupt", reason: "lease generation exhausted" };
      const lease: X402BuyerSettlementLease = {
        owner: asciiString(input.owner, "x402 buyer recovery owner"),
        generation,
        stage: "replay",
        expiresAt: input.now + uint(input.leaseDurationMs, "x402 buyer lease duration", true),
      };
      current.generation = generation;
      current.lease = lease;
      current.updatedAt = input.now;
      return {
        status: "granted",
        intent: deepFreeze(clone(current.intent)),
        lease: deepFreeze(clone(lease)),
      };
    },
    async recordOutcome(input) {
      const current = read(input.settlementKey);
      if (!current) return { status: "stale" };
      if (current.intent.bindingHash !== input.bindingHash) return { status: "conflict" };
      if (current.outcome) {
        return {
          status: "existing",
          intent: deepFreeze(clone(current.intent)),
          outcome: deepFreeze(clone(current.outcome)),
        };
      }
      if (current.lease.owner !== input.lease.owner ||
          current.lease.generation !== input.lease.generation ||
          current.lease.expiresAt <= input.now) {
        return { status: "stale" };
      }
      const outcome = captureOutcome(input.outcome, current.intent);
      current.outcome = clone(outcome);
      current.updatedAt = input.now;
      return {
        status: "recorded",
        intent: deepFreeze(clone(current.intent)),
        outcome,
      };
    },
  };
}

function validReason(value: unknown, fallback: string): string {
  try {
    return nfcString(value, "x402 buyer reason");
  } catch {
    return fallback;
  }
}

function progressFromOutcome(
  outcome: Readonly<X402BuyerSettlementOutcome>,
): X402BuyerSettlementProgress {
  return outcome.status === "captured"
    ? { status: "captured", outcome }
    : { status: "failed", outcome };
}

function captureStoreTerminal(
  value: unknown,
  expectedIntent: Readonly<X402BuyerSettlementIntent>,
  label: string,
): {
  status: "captured" | "failed";
  intent: Readonly<X402BuyerSettlementIntent>;
  outcome: Readonly<X402BuyerSettlementOutcome>;
} {
  const record = exactRecord(value, label, ["status", "intent", "outcome"]);
  if (record.status !== "captured" && record.status !== "failed") {
    throw new DacsError(`${label}.status is not terminal`);
  }
  const intent = captureIntent(record.intent);
  if (intent.bindingHash !== expectedIntent.bindingHash ||
      intent.settlementKey !== expectedIntent.settlementKey) {
    throw new DacsError(`${label} returned a different intent`);
  }
  const outcome = captureOutcome(record.outcome, intent);
  if (outcome.status !== record.status) {
    throw new DacsError(`${label} status and outcome disagree`);
  }
  return { status: record.status, intent, outcome };
}

function captureStoreClaim(
  value: unknown,
  expectedIntent: Readonly<X402BuyerSettlementIntent>,
): X402BuyerSettlementClaim {
  if (!isRecord(value)) throw new DacsError("x402 buyer store claim is malformed");
  if (value.status === "captured" || value.status === "failed") {
    return captureStoreTerminal(value, expectedIntent, "x402 buyer store claim");
  }
  if (value.status === "acquired" || value.status === "waiting") {
    const record = exactRecord(value, "x402 buyer store claim", [
      "status",
      "intent",
      "lease",
    ]);
    const intent = captureIntent(record.intent);
    if (intent.bindingHash !== expectedIntent.bindingHash ||
        intent.settlementKey !== expectedIntent.settlementKey) {
      throw new DacsError("x402 buyer store claim returned a different intent");
    }
    return { status: value.status, intent, lease: captureLease(record.lease) };
  }
  if (value.status === "conflict") {
    exactRecord(value, "x402 buyer store claim", ["status"]);
    return { status: "conflict" };
  }
  if (value.status === "unsupported") {
    const record = exactRecord(value, "x402 buyer store claim", ["status", "version"]);
    return {
      status: "unsupported",
      version: uint(record.version, "x402 buyer unsupported store version"),
    };
  }
  if (value.status === "corrupt") {
    const record = exactRecord(value, "x402 buyer store claim", ["status", "reason"]);
    return { status: "corrupt", reason: nfcString(record.reason, "x402 buyer corruption reason") };
  }
  throw new DacsError("x402 buyer store claim status is invalid");
}

function captureOutcomeWrite(
  value: unknown,
  expectedIntent: Readonly<X402BuyerSettlementIntent>,
): X402BuyerOutcomeWrite {
  if (!isRecord(value)) throw new DacsError("x402 buyer outcome write is malformed");
  if (value.status === "recorded" || value.status === "existing") {
    const record = exactRecord(value, "x402 buyer outcome write", [
      "status",
      "intent",
      "outcome",
    ]);
    const intent = captureIntent(record.intent);
    if (intent.bindingHash !== expectedIntent.bindingHash ||
        intent.settlementKey !== expectedIntent.settlementKey) {
      throw new DacsError("x402 buyer outcome write returned a different intent");
    }
    return {
      status: value.status,
      intent,
      outcome: captureOutcome(record.outcome, intent),
    };
  }
  if (value.status === "stale" || value.status === "conflict") {
    exactRecord(value, "x402 buyer outcome write", ["status"]);
    return { status: value.status };
  }
  if (value.status === "unsupported") {
    const record = exactRecord(value, "x402 buyer outcome write", ["status", "version"]);
    return { status: "unsupported", version: uint(record.version, "x402 buyer store version") };
  }
  if (value.status === "corrupt") {
    const record = exactRecord(value, "x402 buyer outcome write", ["status", "reason"]);
    return { status: "corrupt", reason: nfcString(record.reason, "x402 buyer corruption reason") };
  }
  throw new DacsError("x402 buyer outcome write status is invalid");
}

function captureRecoveryGrant(
  value: unknown,
  expectedIntent: Readonly<X402BuyerSettlementIntent>,
): X402BuyerRecoveryGrant {
  if (!isRecord(value)) throw new DacsError("x402 buyer recovery grant is malformed");
  if (value.status === "captured" || value.status === "failed") {
    return captureStoreTerminal(
      value,
      expectedIntent,
      "x402 buyer recovery grant",
    ) as X402BuyerRecoveryGrant;
  }
  if (value.status === "granted") {
    const record = exactRecord(value, "x402 buyer recovery grant", [
      "status",
      "intent",
      "lease",
    ]);
    const intent = captureIntent(record.intent);
    if (intent.bindingHash !== expectedIntent.bindingHash ||
        intent.settlementKey !== expectedIntent.settlementKey) {
      throw new DacsError("x402 buyer recovery grant returned a different intent");
    }
    const lease = captureLease(record.lease);
    if (lease.stage !== "replay") {
      throw new DacsError("x402 buyer recovery grant did not issue a replay lease");
    }
    return { status: "granted", intent, lease };
  }
  if (value.status === "stale" || value.status === "conflict") {
    exactRecord(value, "x402 buyer recovery grant", ["status"]);
    return { status: value.status };
  }
  if (value.status === "unsupported") {
    const record = exactRecord(value, "x402 buyer recovery grant", ["status", "version"]);
    return { status: "unsupported", version: uint(record.version, "x402 buyer store version") };
  }
  if (value.status === "corrupt") {
    const record = exactRecord(value, "x402 buyer recovery grant", ["status", "reason"]);
    return { status: "corrupt", reason: nfcString(record.reason, "x402 buyer corruption reason") };
  }
  throw new DacsError("x402 buyer recovery grant status is invalid");
}

function validateLeaseDuration(value: number | undefined): number {
  return uint(value ?? DEFAULT_LEASE_MS, "x402 buyer leaseDurationMs", true);
}

function captureLookup<T>(value: unknown): X402BuyerAuthorizationLookup<T> {
  try {
    if (!isRecord(value)) throw new DacsError("lookup must be a record");
    if (value.disposition === "unavailable") {
      const record = exactRecord(value, "x402 buyer authorization lookup", [
        "disposition",
        "reason",
      ]);
      return {
        disposition: "unavailable",
        reason: nfcString(record.reason, "x402 buyer authorization lookup reason"),
      };
    }
    if (value.disposition === "observed") {
      const record = exactRecord(value, "x402 buyer authorization lookup", [
        "disposition",
        "observation",
      ]);
      return { disposition: "observed", observation: record.observation as T };
    }
  } catch {
    // Invalid provider output cannot establish authoritative absence.
  }
  return { disposition: "unavailable", reason: "authorization-lookup-invalid" };
}

function captureReconciliation(
  value: unknown,
  intent: Readonly<X402BuyerSettlementIntent>,
): X402BuyerAuthorizationReconciliation {
  try {
    if (!isRecord(value)) throw new DacsError("reconciliation must be a record");
    if (value.disposition === "settled-same") {
      const record = exactRecord(value, "x402 buyer settled-same reconciliation", [
        "disposition",
        "settlement",
      ]);
      return {
        disposition: "settled-same",
        settlement: captureSettlement(record.settlement, intent),
      };
    }
    if (value.disposition === "unused") {
      const record = exactRecord(value, "x402 buyer unused reconciliation", [
        "disposition",
        "reason",
        "authenticationHash",
      ]);
      return {
        disposition: "unused",
        reason: nfcString(record.reason, "x402 buyer unused reason"),
        authenticationHash: hashString(
          record.authenticationHash,
          "x402 buyer unused authenticationHash",
        ),
      };
    }
    if (value.disposition === "used-different" || value.disposition === "cancelled") {
      const record = exactRecord(value, "x402 buyer terminal reconciliation", [
        "disposition",
        "reason",
        "authenticationHash",
      ]);
      return {
        disposition: value.disposition,
        reason: nfcString(record.reason, "x402 buyer terminal reconciliation reason"),
        authenticationHash: hashString(
          record.authenticationHash,
          "x402 buyer terminal reconciliation authenticationHash",
        ),
      };
    }
    if (value.disposition === "indeterminate") {
      const record = exactRecord(value, "x402 buyer indeterminate reconciliation", [
        "disposition",
        "reason",
      ]);
      return {
        disposition: "indeterminate",
        reason: nfcString(record.reason, "x402 buyer indeterminate reason"),
      };
    }
  } catch (error) {
    return {
      disposition: "indeterminate",
      reason: isRecord(value) && value.disposition === "settled-same"
        ? "settled-same-capture-invalid"
        : "authorization-reconciliation-invalid",
    };
  }
  return { disposition: "indeterminate", reason: "authorization-reconciliation-invalid" };
}

/**
 * One money-safe durable step. It never treats an HTTP response as settlement,
 * never redrives without authenticated absence, and never records through a
 * stale generation.
 */
export async function advanceX402BuyerSettlement<TObservation = unknown>(
  input: AdvanceX402BuyerSettlementInput<TObservation>,
): Promise<X402BuyerSettlementProgress> {
  const intent = captureIntent(input?.intent);
  const owner = asciiString(input?.owner, "x402 buyer owner");
  const now = typeof input?.now === "function" ? input.now : Date.now;
  const leaseDurationMs = validateLeaseDuration(input?.leaseDurationMs);
  if (!input?.store || typeof input.store.load !== "function" ||
      typeof input.store.claim !== "function" ||
      typeof input.store.isCurrent !== "function" ||
      typeof input.store.grantRecovery !== "function" ||
      typeof input.store.recordOutcome !== "function" ||
      !input.authorizationProvider || typeof input.authorizationProvider.lookup !== "function" ||
      typeof input.authorizationProvider.authorizeIntent !== "function" ||
      typeof input.authorizationProvider.authenticate !== "function" ||
      !input.transport || typeof input.transport.submitRetained !== "function") {
    throw new DacsError("x402 buyer durable coordinator dependencies are incomplete");
  }

  let claim: X402BuyerSettlementClaim;
  try {
    claim = captureStoreClaim(await input.store.claim({
      intent,
      owner,
      now: now(),
      leaseDurationMs,
    }), intent);
  } catch {
    return { status: "indeterminate", reason: "settlement-store-unavailable" };
  }
  if (claim.status === "captured" || claim.status === "failed") {
    return progressFromOutcome(claim.outcome);
  }
  if (claim.status === "waiting") {
    return { status: "waiting", reason: "settlement-generation-held" };
  }
  if (claim.status === "conflict") {
    return { status: "indeterminate", reason: "settlement-intent-conflict" };
  }
  if (claim.status === "unsupported" || claim.status === "corrupt") {
    return {
      status: "indeterminate",
      reason: claim.status === "unsupported"
        ? `settlement-store-version-${claim.version}-unsupported`
        : `settlement-store-corrupt:${claim.reason}`,
    };
  }
  if (claim.status !== "acquired") {
    return { status: "indeterminate", reason: "settlement-claim-invalid" };
  }

  let lease = claim.lease;
  const makeFence = (): Readonly<X402BuyerEffectFence> => {
    const token = { owner: lease.owner, generation: lease.generation };
    const fence: X402BuyerEffectFence = {
      ...token,
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      idempotencyKey: intent.settlementKey,
      async assertCurrent() {
        const current = await input.store.isCurrent({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          lease: token,
          now: now(),
        });
        if (!current) throw new DacsError("x402 buyer effect fence is stale");
      },
    };
    return Object.freeze(fence);
  };

  const persist = async (
    outcome: Readonly<X402BuyerSettlementOutcome>,
    fence: Readonly<X402BuyerEffectFence>,
  ): Promise<X402BuyerSettlementProgress> => {
    try {
      await fence.assertCurrent();
    } catch {
      return { status: "indeterminate", reason: "settlement-generation-stale" };
    }
    let result: X402BuyerOutcomeWrite;
    try {
      result = captureOutcomeWrite(await input.store.recordOutcome({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        lease: fence,
        outcome,
        now: now(),
      }), intent);
    } catch {
      // The write may have committed before its acknowledgement was lost.
      try {
        const loaded = await input.store.load(intent.settlementKey);
        if (loaded.status === "captured" || loaded.status === "failed") {
          return progressFromOutcome(captureStoreTerminal(
            loaded,
            intent,
            "x402 buyer store load",
          ).outcome);
        }
      } catch {
        // Preserve ambiguity; never infer absence from a failed store read.
      }
      return { status: "indeterminate", reason: "settlement-outcome-write-indeterminate" };
    }
    if (result.status === "recorded" || result.status === "existing") {
      return progressFromOutcome(result.outcome);
    }
    if (result.status === "corrupt") {
      return {
        status: "indeterminate",
        reason: `settlement-store-corrupt:${result.reason}`,
      };
    }
    if (result.status === "unsupported") {
      return {
        status: "indeterminate",
        reason: `settlement-store-version-${result.version}-unsupported`,
      };
    }
    return {
      status: "indeterminate",
      reason: result.status === "stale" ? "settlement-generation-stale" :
        "settlement-intent-conflict",
    };
  };

  const reconcile = async (
    fence: Readonly<X402BuyerEffectFence>,
    candidate?: Readonly<X402BuyerSettlementDisclosure>,
  ): Promise<X402BuyerAuthorizationReconciliation> => {
    try {
      await fence.assertCurrent();
      const rawLookup = await input.authorizationProvider.lookup(intent, candidate, fence);
      await fence.assertCurrent();
      const lookup = captureLookup<TObservation>(rawLookup);
      if (lookup.disposition === "unavailable") {
        return { disposition: "indeterminate", reason: lookup.reason };
      }
      const result = await input.authorizationProvider.authenticate(
        intent,
        lookup,
        candidate,
        fence,
      );
      await fence.assertCurrent();
      return captureReconciliation(result, intent);
    } catch {
      return { disposition: "indeterminate", reason: "authorization-reconciliation-unavailable" };
    }
  };

  const submitThenReconcile = async (
    fence: Readonly<X402BuyerEffectFence>,
  ): Promise<X402BuyerSettlementProgress> => {
    let candidate: Readonly<X402BuyerSettlementDisclosure> | undefined;
    try {
      await fence.assertCurrent();
      const intentAuthorization = await input.authorizationProvider.authorizeIntent(intent, fence);
      await fence.assertCurrent();
      if (!isRecord(intentAuthorization)) {
        return { status: "indeterminate", reason: "intent-authorization-invalid" };
      }
      if (intentAuthorization.disposition === "rejected" ||
          intentAuthorization.disposition === "indeterminate") {
        let checked: Record<string, unknown>;
        try {
          checked = exactRecord(intentAuthorization, "x402 buyer intent authorization", [
            "disposition",
            "reason",
          ]);
        } catch {
          return { status: "indeterminate", reason: "intent-authorization-invalid" };
        }
        return {
          status: "indeterminate",
          reason: `intent-authorization-${intentAuthorization.disposition}:${validReason(
            checked.reason,
            "unspecified",
          )}`,
        };
      }
      if (intentAuthorization.disposition !== "authorized") {
        return { status: "indeterminate", reason: "intent-authorization-invalid" };
      }
      let authorized: Record<string, unknown>;
      try {
        authorized = exactRecord(intentAuthorization, "x402 buyer intent authorization", [
          "disposition",
          "bindingHash",
        ]);
      } catch {
        return { status: "indeterminate", reason: "intent-authorization-invalid" };
      }
      if (authorized.bindingHash !== intent.bindingHash) {
        return { status: "indeterminate", reason: "intent-authorization-binding-mismatch" };
      }
      await fence.assertCurrent();
      const raw = await input.transport.submitRetained(intent, fence);
      await fence.assertCurrent();
      if (!isRecord(raw)) {
        return { status: "indeterminate", reason: "paid-request-result-invalid" };
      }
      if (raw.disposition === "indeterminate") {
        try {
          exactRecord(raw, "x402 buyer paid request result", ["disposition", "reason"]);
        } catch {
          return { status: "indeterminate", reason: "paid-request-result-invalid" };
        }
      } else if (raw.disposition === "response") {
        try {
          exactRecord(raw, "x402 buyer paid request result", ["disposition"], ["disclosure"]);
        } catch {
          return { status: "indeterminate", reason: "paid-request-result-invalid" };
        }
      } else {
        return { status: "indeterminate", reason: "paid-request-result-invalid" };
      }
      if (raw.disposition === "response" && raw.disclosure !== undefined) {
        try {
          candidate = captureDisclosure(raw.disclosure);
          if (candidate.httpResource !== intent.httpResource) {
            return { status: "indeterminate", reason: "paid-response-resource-mismatch" };
          }
        } catch {
          // A malformed/no-transaction response is ambiguous after submission.
          return { status: "indeterminate", reason: "paid-response-incomplete" };
        }
      }
    } catch {
      return { status: "indeterminate", reason: "paid-request-response-indeterminate" };
    }
    const observed = await reconcile(fence, candidate);
    if (observed.disposition === "settled-same") {
      return persist({
        outcomeVersion: "1",
        status: "captured",
        settlement: observed.settlement,
      }, fence);
    }
    if (observed.disposition === "used-different" || observed.disposition === "cancelled") {
      return persist({
        outcomeVersion: "1",
        status: "failed",
        failure: observed.disposition,
        reason: observed.reason,
        authenticationHash: observed.authenticationHash,
      }, fence);
    }
    // Even authenticated unused immediately after a request is not a replay
    // grant: settlement can still be in flight. A later generation reconciles.
    return {
      status: "indeterminate",
      reason: observed.disposition === "unused"
        ? "submitted-authorization-not-yet-settled"
        : observed.reason,
    };
  };

  let fence = makeFence();
  if (lease.stage === "fresh" || lease.stage === "replay") {
    return submitThenReconcile(fence);
  }

  const recovered = await reconcile(fence);
  if (recovered.disposition === "settled-same") {
    return persist({
      outcomeVersion: "1",
      status: "captured",
      settlement: recovered.settlement,
    }, fence);
  }
  if (recovered.disposition === "used-different" || recovered.disposition === "cancelled") {
    return persist({
      outcomeVersion: "1",
      status: "failed",
      failure: recovered.disposition,
      reason: recovered.reason,
      authenticationHash: recovered.authenticationHash,
    }, fence);
  }
  if (recovered.disposition === "indeterminate") {
    return { status: "indeterminate", reason: recovered.reason };
  }

  let granted: X402BuyerRecoveryGrant;
  try {
    granted = captureRecoveryGrant(await input.store.grantRecovery({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      lease: fence,
      owner,
      now: now(),
      leaseDurationMs,
    }), intent);
  } catch {
    return { status: "indeterminate", reason: "recovery-grant-indeterminate" };
  }
  if (granted.status === "captured" || granted.status === "failed") {
    return progressFromOutcome(granted.outcome);
  }
  if (granted.status !== "granted") {
    if (granted.status === "corrupt") {
      return {
        status: "indeterminate",
        reason: `settlement-store-corrupt:${granted.reason}`,
      };
    }
    if (granted.status === "unsupported") {
      return {
        status: "indeterminate",
        reason: `settlement-store-version-${granted.version}-unsupported`,
      };
    }
    return {
      status: "indeterminate",
      reason: granted.status === "stale" ? "recovery-grant-stale" :
        "settlement-intent-conflict",
    };
  }
  lease = granted.lease;
  fence = makeFence();
  return submitThenReconcile(fence);
}

/** Internal strict record helpers shared by the filesystem implementation. */
export const x402BuyerSettlementStoreInternals = Object.freeze({
  captureIntent,
  captureOutcome,
  captureStoredRecord,
  captureLease,
  terminalLoad,
});

export type { StoredRecord as X402BuyerStoredRecord };
