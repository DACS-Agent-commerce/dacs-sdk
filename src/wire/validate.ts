// Shared validators and exact-bytes (CF-5) admission for dacs-seller-http/v1.
//
// Ported from the plugin implementation's patterns and helpers, Listing pin
// check, signature byte decoding and wallet signature decoder. The ingress
// change is D7: every signed or hashed wire input is admitted from its received
// bytes with admitRawJson before anything parses it.
import { types } from "node:util";

import type { ListingPin } from "../artifacts/types.js";
import { canonicalize } from "../canonical/jcs.js";
import { admitRawJson, RawJsonAdmissionError } from "../canonical/rawJson.js";
import { snapshotCanonicalJsonConfig, snapshotCanonicalJsonRead } from "../canonical/snapshot.js";
import { publicKeyFromRaw, ed25519Verify } from "../crypto/ed25519.js";
import { DacsError, type FaultCategory } from "../errors.js";

/**
 * Who a refusal blames follows its status: 500 is this host's own
 * configuration or input (`permanent`), 503 a state that may clear
 * (`transient`, such as `seller_not_ready`), and every other status the peer
 * (`counterparty`, including 502 for a seller's malformed answer).
 */
export function wireFaultCategory(status: number): FaultCategory {
  if (status === 500) return "permanent";
  if (status === 503) return "transient";
  return "counterparty";
}

/** Wire refusal: `code` is stable, `status` is the HTTP status a seller answers with. */
export class WireError extends DacsError {
  constructor(
    readonly code: string,
    readonly status: number = 401,
    readonly detail?: string,
    cause?: unknown,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`, { category: wireFaultCategory(status), ...(cause === undefined ? {} : { cause }) });
    this.name = "WireError";
  }
}

/** Refuse with `code`; `cause`, when given, is the underlying error, kept as the refusal's cause. */
export function fail(code: string, status = 401, detail?: string, cause?: unknown): never {
  throw new WireError(code, status, detail, cause);
}

export const HASH = /^[0-9a-f]{64}$/;
export const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
export const NONCE = /^[A-Za-z0-9_-]{22,86}$/;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export type JsonRecord = Record<string, unknown>;
export const isRecord = (v: unknown): v is JsonRecord =>
  v !== null && typeof v === "object" && !types.isProxy(v) && !Array.isArray(v);
/** Exactly these own keys, no more, no fewer. */
export const hasKeys = (v: unknown, expected: readonly string[]): v is JsonRecord =>
  isRecord(v) && Reflect.ownKeys(v).length === expected.length && expected.every((k) => {
    const descriptor = Object.getOwnPropertyDescriptor(v, k);
    return descriptor !== undefined && "value" in descriptor;
  });
/** The pre-TP-1 shape: exactly `fields` except `profile`. A profile-less message names its own refusal. */
export const lacksProfile = (v: unknown, fields: readonly string[]): boolean =>
  hasKeys(v, fields.filter((f) => f !== "profile"));
export const isUint = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0 && !Object.is(v, -0);
export const isHash = (v: unknown): v is string => typeof v === "string" && HASH.test(v);
export const isClaim = (v: unknown): v is string => typeof v === "string" && CLAIM.test(v);
export const sameCanonical = (a: unknown, b: unknown): boolean => canonicalize(a) === canonicalize(b);
export const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}
/**
 * One owned copy of a caller's configuration (an identity record, a local
 * connection), taken once, so every later check, digest and bound field reads
 * the same data. Proxies, accessors and exotic prototypes are refused
 * (src/canonical/snapshot.ts); `undefined` members count as absent. String
 * values come back CF-1 normalized, the form every digest here covers.
 */
export function ownedConfig(value: unknown, code: string): unknown {
  try { return snapshotCanonicalJsonConfig(value, code); } catch (cause) { return fail(code, 500, undefined, cause); }
}
/** The same for a signed artifact or payload the caller hands over; `undefined` members are refused. */
export function ownedArtifact(value: unknown, code: string, status = 401): unknown {
  try { return snapshotCanonicalJsonRead(value, code); } catch (cause) { return fail(code, status, undefined, cause); }
}
/** The owned copy, or `undefined` when the value is not data: what a predicate tests. */
export function ownedOrNothing(value: unknown): unknown {
  try { return snapshotCanonicalJsonRead(value, "wire value"); } catch { return undefined; }
}
/**
 * One read of each named field of a caller's options object, through its own
 * data properties, so no getter or Proxy trap runs. A Proxy, an accessor or a
 * prototype other than this realm's Object.prototype (or null) is refused.
 * Absent fields come back `undefined`. A field that is itself a record is
 * copied by the entry point that reads it.
 */
export function ownedFields<K extends string>(value: unknown, keys: readonly K[]): Record<K, unknown> {
  if (types.isProxy(value) || !isRecord(value)) return fail("wire_input_invalid", 500);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail("wire_input_invalid", 500);
  const fields = {} as Record<K, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && !("value" in descriptor)) return fail("wire_input_invalid", 500);
    Object.defineProperty(fields, key, { value: descriptor?.value, enumerable: true, writable: true, configurable: true });
  }
  return fields;
}
/** A received input's byte bound and the refusal its admission gives past it. */
export interface ByteLimit {
  maxBytes: number;
  code: string;
  status: number;
}
/**
 * One copy of caller bytes, taken through the typed array's own slots; anything but a Uint8Array is refused.
 * With `limit`, a view longer than `limit.maxBytes` is refused as its admission would refuse it
 * (`BYTE-LIMIT-EXCEEDED`), before a byte is copied. The length is the view's internal one, never a
 * `byteLength` an instance or subclass defines.
 */
export function ownedBytes(value: unknown, code = "wire_input_invalid", status = 500, limit?: ByteLimit): Buffer {
  if (!types.isUint8Array(value)) return fail(code, status);
  if (limit !== undefined && viewByteLength(value) > limit.maxBytes) return fail(limit.code, limit.status, "BYTE-LIMIT-EXCEEDED");
  try {
    const copy = new Uint8Array(value);
    return Buffer.from(copy.buffer, copy.byteOffset, copy.byteLength);
  } catch (cause) { return fail(code, status, undefined, cause); }
}
/** `method` taken at module load: a later patch of its prototype does not change what it does here. */
export const uncurry = <A extends unknown[], R>(method: (...args: A) => R) =>
  Function.prototype.call.bind(method) as unknown as (self: unknown, ...args: A) => R;
const viewByteLength = uncurry(
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype) as object, "byteLength")!.get as () => number,
);

export type { ListingPin } from "../artifacts/types.js";

/** Whether a value is the exact Listing pin tuple with a supported identifier, version and hash. */
export function isListingPin(pin: unknown): pin is ListingPin {
  return hasKeys(pin, ["listingId", "version", "contentHash"]) &&
    typeof pin.listingId === "string" && pin.listingId.length > 0 && pin.listingId.length <= 128 && !/[^A-Za-z0-9._~-]/.test(pin.listingId) &&
    isUint(pin.version) && pin.version > 0 && isHash(pin.contentHash);
}

/** The raw Ed25519 key behind a did:demos:agent claim or a bare 64-hex key. */
export function claimKey(claimOrHex: string): string {
  return claimOrHex.startsWith("did:demos:agent:") ? claimOrHex.slice("did:demos:agent:".length) : claimOrHex;
}

/** Verify an Ed25519 signature over exact bytes; malformed keys or signatures return false. */
export function verifyEd25519(message: Uint8Array, signature: Uint8Array, keyHex: string): boolean {
  if (!HASH.test(keyHex)) return false;
  try {
    return ed25519Verify(message, signature, publicKeyFromRaw(Buffer.from(keyHex, "hex")));
  } catch {
    return false;
  }
}

/** Transport and discovery signatures: 64 raw bytes, canonical base64url, or (0x)hex. */
export function envelopeSignatureBytes(signature: unknown, code = "peer_signature_invalid"): Buffer {
  if (types.isUint8Array(signature)) {
    if (viewByteLength(signature) !== 64) return fail(code);
    const bytes = ownedBytes(signature, code, 401);
    return bytes.length === 64 ? bytes : fail(code);
  }
  if (typeof signature === "string" && BASE64URL_SIGNATURE.test(signature)) {
    const bytes = Buffer.from(signature, "base64url");
    if (bytes.length === 64 && bytes.toString("base64url") === signature) return bytes;
  }
  if (typeof signature === "string" && /^(?:0x)?[0-9a-fA-F]{128}$/.test(signature)) {
    return Buffer.from(signature.replace(/^0x/, ""), "hex");
  }
  return fail(code);
}

/**
 * Wallet signatures (delegations), decoded as identity presentations are,
 * including the repeated "0x0x" prefix some wallets return.
 */
export function walletSignatureBytes(value: unknown, code = "peer_delegation_signature_invalid"): Buffer {
  if (typeof value !== "string") return fail(code);
  const trimmed = value.trim();
  if (BASE64URL_SIGNATURE.test(trimmed)) {
    const bytes = Buffer.from(trimmed, "base64url");
    if (bytes.length === 64 && bytes.toString("base64url") === trimmed) return bytes;
  }
  const stripped = trimmed.replace(/^(0x)+/i, "");
  if (/^[0-9a-fA-F]{128}$/.test(stripped)) return Buffer.from(stripped, "hex");
  if (BASE64URL_SIGNATURE.test(stripped)) {
    const bytes = Buffer.from(stripped, "base64url");
    if (bytes.length === 64 && bytes.toString("base64url") === stripped) return bytes;
  }
  return fail(code);
}

/** A signer holds one Ed25519 key; `claim` names it. It never sees anything but bytes. */
export interface WireSigner {
  readonly claim: string;
  sign(bytes: Uint8Array): Uint8Array | string | Promise<Uint8Array | string>;
}

// Every object and array inside a value the wire's own CF-5 admission returned
// (admitWireArtifact, admitted request and response bodies), frozen. Methods
// taken at module load (see profile.ts).
const sealed = new WeakSet<object>();
const sealedHas = uncurry(WeakSet.prototype.has) as (set: WeakSet<object>, value: object) => boolean;
const sealedAdd = uncurry(WeakSet.prototype.add) as (set: WeakSet<object>, value: object) => unknown;

/** Freeze an admitted value and record every container in it: what isAdmittedValue checks later. */
function sealAdmitted<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) sealAdmitted(item);
    Object.freeze(value);
    sealedAdd(sealed, value);
  }
  return value;
}

/**
 * Whether `value` is (part of) a value the wire's own admission returned: the
 * implementation-enforced guarantee CF-5 asks of a pre-parsed value. A caller's
 * object, a copy or a re-serialised value is not.
 */
export function isAdmittedValue(value: unknown): boolean {
  return value !== null && typeof value === "object" && sealedHas(sealed, value);
}

/**
 * CF-5 admission of one received wire input (D7), before canonicalization,
 * hashing, schema checks or signature verification. admitRawJson refuses
 * malformed UTF-8, BOMs, duplicate member names, out-of-profile numbers and
 * deep nesting. CF-1 NFC-normalizes values (never member names) later,
 * when canonicalizing the admitted value for hashing or verification.
 * Whitespace and member order need not be canonical.
 */
export function admitWireJson(bytes: Uint8Array, maxBytes: number, code: string, status = 400): unknown {
  try {
    const value = admitRawJson(bytes, { maxBytes });
    return sealAdmitted(value);
  } catch (error) {
    if (error instanceof RawJsonAdmissionError) return fail(code, status, error.code, error);
    throw error;
  }
}
