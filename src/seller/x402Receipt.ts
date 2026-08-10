import { canonicalize, sha256Hex } from "../canonical/index.js";

/** DACS-4 §9.5.7 X402-1..X402-4 verification disposition. */
export type X402ReceiptDisposition = "pass" | "fail" | "error";

export interface X402ResponseHeader {
  name: string;
  value: string;
}

/** The normative x402 ChainTxRef fields checked against the off-chain receipt. */
export interface X402ReceiptEvidence {
  paymentReceiptHash: string;
  settlementTxHash?: string;
  chainId?: number;
}

export interface X402ReceiptVerification {
  disposition: X402ReceiptDisposition;
  reason: string;
  /** X402-2 canonical receipt bytes, present after a successful decode/parse. */
  canonicalReceipt?: string;
  /** X402-2 independently computed lower-case SHA-256. */
  computedPaymentReceiptHash?: string;
  /** The complete decoded response, including unknown and extension members. */
  receipt?: Record<string, unknown>;
}

/** Registered legacy network names used by x402 v1 (X402-3). */
export const X402_V1_CHAIN_IDS: Readonly<Record<string, number>> = Object.freeze({
  ethereum: 1,
  sepolia: 11155111,
  abstract: 2741,
  "abstract-testnet": 11124,
  "base-sepolia": 84532,
  base: 8453,
  "avalanche-fuji": 43113,
  avalanche: 43114,
  iotex: 4689,
  sei: 1329,
  "sei-testnet": 1328,
  polygon: 137,
  "polygon-amoy": 80002,
  peaq: 3338,
  story: 1514,
  educhain: 41923,
  "skale-base-sepolia": 324705682,
  megaeth: 4326,
  monad: 143,
  stable: 988,
  "stable-testnet": 2201,
});

const HASH_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^(0|[1-9][0-9]*)$/;
const JSON_WHITESPACE_RE = /[\u0009\u000a\u000d\u0020]/;

/**
 * JSON.parse keeps only the last occurrence of a duplicate object member, so
 * it cannot by itself establish the I-JSON input required by RFC 8785 §3.1.
 * Walk the already syntax-validated source and compare decoded member names in
 * every object before the parsed value is allowed to reach canonicalization.
 */
function hasDuplicateJsonObjectNames(source: string): boolean {
  let offset = 0;

  const skipWhitespace = (): void => {
    while (offset < source.length && JSON_WHITESPACE_RE.test(source[offset]!)) {
      offset += 1;
    }
  };

  const scanString = (): string => {
    const start = offset;
    offset += 1; // opening quote; JSON.parse already established valid syntax
    while (offset < source.length) {
      const character = source[offset++]!;
      if (character === '"') return source.slice(start, offset);
      if (character === "\\") {
        const escape = source[offset++]!;
        if (escape === "u") offset += 4;
      }
    }
    throw new Error("unterminated JSON string");
  };

  const scanValue = (depth: number): boolean => {
    if (depth > 64) throw new Error("JSON nesting exceeds canonical limit");
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
        offset += 1; // colon
        if (scanValue(depth + 1)) return true;
        skipWhitespace();
        if (source[offset] === "}") {
          offset += 1;
          return false;
        }
        offset += 1; // comma
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
        offset += 1; // comma
      }
    }
    if (character === '"') {
      scanString();
      return false;
    }
    while (
      offset < source.length &&
      !JSON_WHITESPACE_RE.test(source[offset]!) &&
      !",]}".includes(source[offset]!)
    ) {
      offset += 1;
    }
    return false;
  };

  return scanValue(0);
}

function decodeBase64Strict(value: string): Uint8Array | null {
  const paddingIndex = value.indexOf("=");
  if (
    value.length === 0 ||
    /\s/.test(value) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
    value.length % 4 === 1 ||
    paddingIndex !== -1 &&
      (paddingIndex < value.length - 2 || value.length % 4 !== 0)
  ) {
    return null;
  }
  try {
    const decoded = Buffer.from(value, "base64");
    const roundTrip = decoded.toString("base64");
    const canonical = paddingIndex === -1
      ? roundTrip.replace(/=+$/, "")
      : roundTrip;
    return value === canonical ? decoded : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * X402-1 requires parsing the decoded object as the negotiated version's
 * SettlementResponse. Keep unknown members intact for X402-2, but do not let
 * malformed values hide behind otherwise valid required members.
 */
function isSettlementResponse(
  value: Record<string, unknown>,
  protocolVersion: "1" | "2",
): boolean {
  if (
    typeof value.success !== "boolean" ||
    typeof value.transaction !== "string" ||
    typeof value.network !== "string"
  ) {
    return false;
  }

  for (const key of ["errorReason", "errorMessage", "payer"]) {
    if (hasOwn(value, key) && typeof value[key] !== "string") return false;
  }

  // amount, extensions, and extra are v2 SettlementResponse members. In v1
  // those names are unrecognised extension members and X402-1 says to retain
  // them without assigning v2 semantics.
  if (protocolVersion === "2") {
    if (hasOwn(value, "amount") && typeof value.amount !== "string") return false;
    for (const key of ["extensions", "extra"]) {
      if (hasOwn(value, key) && !isRecord(value[key])) return false;
    }
  }

  return true;
}

function mappedChainId(
  network: unknown,
  protocolVersion: string,
  legacyNetworkMap: Readonly<Record<string, number>>,
): number | null {
  if (typeof network !== "string") return null;
  if (protocolVersion === "2") {
    const match = /^eip155:(0|[1-9][0-9]*)$/.exec(network);
    if (!match) return null;
    const chainId = Number(match[1]);
    return Number.isSafeInteger(chainId) ? chainId : null;
  }
  return legacyNetworkMap[network] ?? null;
}

/**
 * Independently verifies an x402 settlement-response header against the exact
 * DACS-4 §9.5.7 `ChainTxRef` commitment. The complete receipt stays off-chain;
 * this returns it only so the caller can perform the rail/session checks before
 * constructing normative SettlementEvidence.
 */
export function verifyX402ReceiptClaim(input: {
  protocolVersion: string;
  responseHeader: X402ResponseHeader;
  evidence: X402ReceiptEvidence;
  legacyNetworkMap?: Readonly<Record<string, number>>;
}): X402ReceiptVerification {
  const { protocolVersion, responseHeader, evidence } = input;
  if (typeof protocolVersion !== "string" ||
      !VERSION_RE.test(protocolVersion) ||
      (protocolVersion !== "1" && protocolVersion !== "2")) {
    return { disposition: "error", reason: "unsupported-protocolVersion" };
  }
  if (!isRecord(responseHeader) || typeof responseHeader.name !== "string" ||
      typeof responseHeader.value !== "string" || !isRecord(evidence) ||
      typeof evidence.paymentReceiptHash !== "string") {
    return { disposition: "error", reason: "invalid-receipt-input" };
  }

  const expectedHeader = protocolVersion === "1"
    ? "X-PAYMENT-RESPONSE"
    : "PAYMENT-RESPONSE";
  if (responseHeader.name.toUpperCase() !== expectedHeader) {
    return {
      disposition: "error",
      reason: "response-header-does-not-match-protocolVersion",
    };
  }

  const decoded = decodeBase64Strict(responseHeader.value);
  if (!decoded) return { disposition: "error", reason: "invalid-base64" };

  let parsed: unknown;
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    parsed = JSON.parse(json);
  } catch {
    return { disposition: "error", reason: "invalid-json" };
  }
  try {
    if (hasDuplicateJsonObjectNames(json)) {
      return {
        disposition: "error",
        reason: "invalid-settlementResponse-schema",
      };
    }
  } catch {
    return {
      disposition: "error",
      reason: "invalid-settlementResponse-schema",
    };
  }
  if (!isRecord(parsed)) {
    return { disposition: "error", reason: "invalid-settlementResponse-schema" };
  }
  if (!isSettlementResponse(parsed, protocolVersion)) {
    return { disposition: "error", reason: "invalid-settlementResponse-schema" };
  }

  let canonicalReceipt: string;
  try {
    // canonicalize applies the recursive CORE CF-1 NFC pass to keys and values.
    canonicalReceipt = canonicalize(parsed);
  } catch {
    return { disposition: "error", reason: "invalid-settlementResponse-schema" };
  }
  const computedPaymentReceiptHash = sha256Hex(canonicalReceipt);
  const common = { canonicalReceipt, computedPaymentReceiptHash, receipt: parsed };

  if (parsed.success !== true) {
    return { disposition: "fail", reason: "settlementResponse-not-success", ...common };
  }
  if (
    typeof parsed.transaction !== "string" ||
    parsed.transaction.length === 0 ||
    typeof parsed.network !== "string" ||
    parsed.network.length === 0 ||
    typeof parsed.payer !== "string" ||
    parsed.payer.length === 0
  ) {
    return {
      disposition: "error",
      reason: "invalid-settlementResponse-schema",
      ...common,
    };
  }
  if (!HASH_RE.test(evidence.paymentReceiptHash)) {
    return { disposition: "fail", reason: "non-canonical-paymentReceiptHash", ...common };
  }
  if (computedPaymentReceiptHash !== evidence.paymentReceiptHash) {
    const placeholderHash = sha256Hex(parsed.transaction);
    return {
      disposition: "fail",
      reason: evidence.paymentReceiptHash === placeholderHash
        ? "settlementTxHash-alone-is-nonconforming"
        : "paymentReceiptHash-mismatch",
      ...common,
    };
  }
  if (
    evidence.settlementTxHash !== undefined &&
    parsed.transaction.toLowerCase() !== evidence.settlementTxHash.toLowerCase()
  ) {
    return {
      disposition: "fail",
      reason: "transaction-does-not-match-settlementTxHash",
      ...common,
    };
  }
  if (evidence.chainId !== undefined) {
    if (!Number.isSafeInteger(evidence.chainId) || evidence.chainId < 0) {
      return { disposition: "error", reason: "invalid-chainId", ...common };
    }
    const chainId = mappedChainId(
      parsed.network,
      protocolVersion,
      input.legacyNetworkMap ?? X402_V1_CHAIN_IDS,
    );
    if (chainId !== evidence.chainId) {
      return {
        disposition: "fail",
        reason: "network-does-not-map-to-chainId",
        ...common,
      };
    }
  }

  return { disposition: "pass", reason: "verified", ...common };
}
