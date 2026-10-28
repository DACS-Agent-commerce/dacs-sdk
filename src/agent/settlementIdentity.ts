import { MAX_NESTING_DEPTH } from "../canonical/jcs.js";
import { types as nodeTypes } from "node:util";

import { isComponentSignature } from "../artifacts/signatures.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { ChainTxRef } from "../artifacts/types.js";
import { isCanonicalJobId, isSettlementEvidence } from "../artifacts/validators.js";
import {
  canonicalizeDecimal,
  contentHash,
  decodeAddressSegment,
  encodeAddressSegment,
  stripSignature,
} from "../canonical/index.js";
import { signedBytes } from "../crypto/index.js";
import type { Verifier } from "./signedArtifact.js";

/** DACS-4 §9.5.8 SB-1 canonical event/instruction-level settlement identity. */

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAX_SOLANA_SIGNATURE_BASE58_LENGTH = 88;
const MAX_CANONICAL_SETTLEMENT_ID_LENGTH = 128;

/** True only when canonical Base58 decodes to exactly one 64-byte signature. */
export function isCanonicalSolanaSignature(value: string): boolean {
  // A 64-byte value needs at most 88 Base58 digits. Bound attacker-controlled
  // input before the BigInt accumulation below so a persisted/provider-supplied
  // pseudo-signature cannot turn validation into unbounded CPU/memory work.
  if (
    value.length === 0 ||
    value.length > MAX_SOLANA_SIGNATURE_BASE58_LENGTH
  ) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let nonZeroBytes = 0;
  for (let cursor = decoded; cursor > 0n; cursor >>= 8n) nonZeroBytes += 1;
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < value.length && value[leadingZeroBytes] === "1") {
    leadingZeroBytes += 1;
  }
  return leadingZeroBytes + nonZeroBytes === 64;
}

export function isCanonicalSettlementIdentity(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length > MAX_CANONICAL_SETTLEMENT_ID_LENGTH) return false;
  if (/^demos:[0-9a-f]{64}$/.test(value)) return true;

  const evm = /^evm:([1-9][0-9]*):([0-9a-f]{64}):(0|[1-9][0-9]*)$/.exec(
    value,
  );
  if (evm) {
    const chainId = Number(evm[1]);
    const logIndex = Number(evm[3]);
    return Number.isSafeInteger(chainId) && chainId > 0 &&
      Number.isSafeInteger(logIndex) && logIndex >= 0;
  }

  const solana = /^solana:(mainnet|devnet|testnet):([1-9A-HJ-NP-Za-km-z]+):(0|[1-9][0-9]*)$/.exec(
    value,
  );
  if (!solana || !isCanonicalSolanaSignature(solana[2]!)) return false;
  const instructionIndex = Number(solana[3]);
  return Number.isSafeInteger(instructionIndex) && instructionIndex >= 0;
}

export type SettlementEventIdentityDecision =
  | "pass"
  | "fail"
  | "error"
  | "indeterminate";

export type AuthenticatedSettlementLedgerEvent =
  | {
      ledger: "evm";
      chainId: number;
      txHash: string;
      logIndex: number;
      standard: string;
      asset: string;
      payer: string;
      payee: string;
      amount: string;
    }
  | {
      ledger: "solana";
      cluster: "mainnet" | "devnet" | "testnet";
      signature: string;
      instructionIndex: number;
      standard: string;
      asset: string;
      payer: string;
      payee: string;
      amount: string;
    };

export interface VerifiedX402ReceiptBinding {
  verified: true;
  paymentReceiptHash: string;
  settlementTxHash: string;
  chainId: number;
}

export interface SettlementEventIdentityContext {
  /** Exact SR-2 PC-2 address at which the evidence was resolved. */
  anchorAddress: string;
  /** Authenticated BundlePhaseEntry index for the selected payment phase. */
  phaseIndex: number;
  /** Exact rail selected by the authenticated agreement and phase. */
  railId: string;
  asset: string;
  payer: string;
  payee: string;
  amount: { amount: string; currency: string };
  /** Undefined means authenticated ledger history is unavailable. */
  ledgerEvents?: readonly AuthenticatedSettlementLedgerEvent[] | null;
  /** Independently verified X402-1..X402-4 receipt facts. */
  x402Receipt?: Readonly<VerifiedX402ReceiptBinding>;
  /** @deprecated Arrival-order claims supply no SB-2 authority. Use the complete-set resolver. */
  priorClaims?: Readonly<
    Record<string, Readonly<{ jobId: string; phaseIndex: number }>>
  >;
}

export interface SettlementEventIdentityDeps {
  resolvePublicKey(signer: string): Promise<Uint8Array | null> | Uint8Array | null;
  verify: Verifier;
}

export type SettlementEventIdentityResolution =
  | {
      decision: "pass";
      settlementId: string;
      replay: "current" | "legacy";
    }
  | {
      decision: Exclude<SettlementEventIdentityDecision, "pass">;
      reason: string;
    };

type ParsedSettlementRef =
  | {
      mode: "current-evm";
      chainId: number;
      txHash: string;
      index: number;
      ref: Record<string, unknown>;
    }
  | {
      mode: "current-x402";
      chainId: number;
      txHash: string;
      index: number;
      ref: Record<string, unknown>;
    }
  | {
      mode: "current-solana";
      cluster: "mainnet" | "devnet" | "testnet";
      signature: string;
      index: number;
      ref: Record<string, unknown>;
    }
  | {
      mode: "legacy-evm";
      chainId: number;
      txHash: string;
      ref: Record<string, unknown>;
    }
  | {
      mode: "legacy-solana";
      cluster: "mainnet" | "devnet" | "testnet";
      signature: string;
      ref: Record<string, unknown>;
    }
  | {
      mode: "legacy-x402";
      paymentReceiptHash: string;
      signedTxHash?: string;
      signedChainId?: number;
      chainId?: number;
      txHash?: string;
      ref: Record<string, unknown>;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  !nodeTypes.isProxy(value);
const isSafeUint = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  !Object.is(value, -0);
const isPositiveSafeInt = (value: unknown): value is number =>
  isSafeUint(value) && value > 0;
const exactKeys = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) =>
    typeof key === "string" && (required.includes(key) || optional.includes(key))) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};

function snapshotExactJson(
  value: unknown,
  label: string,
  seen = new WeakSet<object>(),
  depth = 0,
): unknown {
  if (value !== null && typeof value === "object" && depth >= MAX_NESTING_DEPTH) {
    throw new TypeError(`${label} exceeds the supported JSON depth`);
  }
  if (value === null || typeof value !== "object") {
    if (
      value === undefined || typeof value === "function" ||
      typeof value === "symbol" || typeof value === "bigint" ||
      (typeof value === "number" &&
        (!Number.isFinite(value) || Object.is(value, -0)))
    ) {
      throw new TypeError(`${label} must contain exact JSON data`);
    }
    return value;
  }
  if (nodeTypes.isProxy(value)) throw new TypeError(`${label} cannot contain proxies`);
  if (seen.has(value)) throw new TypeError(`${label} must be acyclic`);
  seen.add(value);

  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new TypeError(`${label} could not be captured`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    throw new TypeError(`${label} cannot contain symbol fields`);
  }

  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      throw new TypeError(`${label} arrays must use the intrinsic prototype`);
    }
    const keys = Object.keys(descriptors).filter((key) => key !== "length");
    const length = descriptors.length?.value;
    if (
      !Number.isSafeInteger(length) || (length as number) < 0 ||
      keys.length !== length || keys.some((key, index) => key !== String(index))
    ) {
      throw new TypeError(`${label} arrays must be dense`);
    }
    const copy = keys.map((key) => {
      const descriptor = descriptors[key]!;
      if (descriptor.enumerable !== true || !("value" in descriptor)) {
        throw new TypeError(`${label} cannot contain accessors`);
      }
      return snapshotExactJson(descriptor.value, label, seen, depth + 1);
    });
    seen.delete(value);
    return copy;
  }

  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must contain only plain records`);
  }
  const copy = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (
      descriptor.enumerable !== true || !("value" in descriptor) ||
      descriptor.value === undefined
    ) {
      throw new TypeError(`${label} cannot contain accessors, hidden or undefined fields`);
    }
    Object.defineProperty(copy, key, {
      value: snapshotExactJson(descriptor.value, label, seen, depth + 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(value);
  return copy;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

function isAuthenticatedLedgerEvent(
  value: unknown,
): value is AuthenticatedSettlementLedgerEvent {
  if (!isRecord(value)) return false;
  const common = ["standard", "asset", "payer", "payee", "amount"] as const;
  if (!common.every((key) => isNonEmptyString(value[key]))) return false;
  if (value.ledger === "evm") {
    return exactKeys(value, [
      "ledger", "chainId", "txHash", "logIndex", ...common,
    ]) && isPositiveSafeInt(value.chainId) && isSafeUint(value.logIndex) &&
      canonicalEvmHash(value.txHash) !== null;
  }
  if (value.ledger === "solana") {
    return exactKeys(value, [
      "ledger", "cluster", "signature", "instructionIndex", ...common,
    ]) &&
      (value.cluster === "mainnet" || value.cluster === "devnet" ||
        value.cluster === "testnet") &&
      typeof value.signature === "string" &&
      isCanonicalSolanaSignature(value.signature) &&
      isSafeUint(value.instructionIndex);
  }
  return false;
}

function isSettlementIdentityContext(
  value: unknown,
): value is SettlementEventIdentityContext {
  if (!isRecord(value) || !exactKeys(value, [
    "anchorAddress", "phaseIndex", "railId", "asset", "payer", "payee",
    "amount",
  ], ["ledgerEvents", "x402Receipt", "priorClaims"])) return false;
  if (
    !isNonEmptyString(value.anchorAddress) || !isSafeUint(value.phaseIndex) ||
    !isNonEmptyString(value.railId) || !isNonEmptyString(value.asset) ||
    !isNonEmptyString(value.payer) || !isNonEmptyString(value.payee) ||
    !isRecord(value.amount) || !exactKeys(value.amount, ["amount", "currency"]) ||
    !isNonEmptyString(value.amount.amount) ||
    !isNonEmptyString(value.amount.currency)
  ) return false;
  try {
    if (canonicalizeDecimal(value.amount.amount) !== value.amount.amount ||
        value.amount.amount === "0") return false;
  } catch {
    return false;
  }
  if (
    value.ledgerEvents !== undefined && value.ledgerEvents !== null &&
    (!Array.isArray(value.ledgerEvents) ||
      !value.ledgerEvents.every(isAuthenticatedLedgerEvent))
  ) return false;
  if (value.x402Receipt !== undefined) {
    if (!isRecord(value.x402Receipt) || !exactKeys(value.x402Receipt, [
      "verified", "paymentReceiptHash", "settlementTxHash", "chainId",
    ]) || value.x402Receipt.verified !== true ||
      typeof value.x402Receipt.paymentReceiptHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.x402Receipt.paymentReceiptHash) ||
      canonicalEvmHash(value.x402Receipt.settlementTxHash) === null ||
      !isPositiveSafeInt(value.x402Receipt.chainId)) return false;
  }
  if (value.priorClaims !== undefined) {
    if (!isRecord(value.priorClaims)) return false;
    for (const [settlementId, claim] of Object.entries(value.priorClaims)) {
      if (!isCanonicalSettlementIdentity(settlementId) || !isRecord(claim) ||
          !exactKeys(claim, ["jobId", "phaseIndex"]) ||
          !isNonEmptyString(claim.jobId) || !isSafeUint(claim.phaseIndex)) {
        return false;
      }
    }
  }
  return true;
}

function captureSettlementIdentityDeps(
  value: unknown,
): SettlementEventIdentityDeps | null {
  if (!isRecord(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null) ||
      !exactKeys(value, ["resolvePublicKey", "verify"])) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const resolvePublicKey = descriptors.resolvePublicKey;
  const verify = descriptors.verify;
  if (
    resolvePublicKey?.enumerable !== true || !("value" in resolvePublicKey) ||
    verify?.enumerable !== true || !("value" in verify) ||
    typeof resolvePublicKey.value !== "function" ||
    typeof verify.value !== "function" ||
    nodeTypes.isProxy(resolvePublicKey.value) || nodeTypes.isProxy(verify.value)
  ) return null;
  return Object.freeze({
    resolvePublicKey: resolvePublicKey.value as SettlementEventIdentityDeps["resolvePublicKey"],
    verify: verify.value as Verifier,
  });
}

function canonicalEvmHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = /^0x/i.test(value) ? value.slice(2) : value;
  return /^[0-9a-fA-F]{64}$/.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function parseSettlementRef(value: unknown): ParsedSettlementRef | null {
  if (!isRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "evm-event") {
    const txHash = canonicalEvmHash(value.txHash);
    return exactKeys(value, ["kind", "chainId", "txHash", "logIndex"]) &&
      isPositiveSafeInt(value.chainId) && isSafeUint(value.logIndex) &&
      txHash !== null && value.txHash === txHash
      ? {
          mode: "current-evm",
          chainId: value.chainId,
          txHash,
          index: value.logIndex,
          ref: value,
        }
      : null;
  }
  if (value.kind === "solana-instruction") {
    return exactKeys(value, [
      "kind", "cluster", "signature", "instructionIndex",
    ]) &&
      (value.cluster === "mainnet" || value.cluster === "devnet" ||
        value.cluster === "testnet") &&
      typeof value.signature === "string" &&
      isCanonicalSolanaSignature(value.signature) &&
      isSafeUint(value.instructionIndex)
      ? {
          mode: "current-solana",
          cluster: value.cluster,
          signature: value.signature,
          index: value.instructionIndex,
          ref: value,
        }
      : null;
  }
  if (value.kind === "x402-event") {
    const txHash = canonicalEvmHash(value.settlementTxHash);
    return exactKeys(value, [
      "kind", "httpResource", "paymentReceiptHash", "settlementTxHash",
      "chainId", "logIndex", "protocolVersion",
    ]) &&
      typeof value.httpResource === "string" && value.httpResource.length > 0 &&
      typeof value.paymentReceiptHash === "string" &&
      /^[0-9a-f]{64}$/.test(value.paymentReceiptHash) &&
      txHash !== null && value.settlementTxHash === txHash &&
      isPositiveSafeInt(value.chainId) && isSafeUint(value.logIndex) &&
      typeof value.protocolVersion === "string" &&
      /^(0|[1-9][0-9]*)$/.test(value.protocolVersion)
      ? {
          mode: "current-x402",
          chainId: value.chainId,
          txHash,
          index: value.logIndex,
          ref: value,
        }
      : null;
  }
  if (value.kind === "evm") {
    const txHash = canonicalEvmHash(value.txHash);
    return exactKeys(value, ["kind", "chainId", "txHash"]) &&
      isPositiveSafeInt(value.chainId) && txHash !== null
      ? {
          mode: "legacy-evm",
          chainId: value.chainId,
          txHash,
          ref: value,
        }
      : null;
  }
  if (value.kind === "solana") {
    return exactKeys(value, ["kind", "cluster", "signature"]) &&
      (value.cluster === "mainnet" || value.cluster === "devnet" ||
        value.cluster === "testnet") &&
      typeof value.signature === "string" &&
      isCanonicalSolanaSignature(value.signature)
      ? {
          mode: "legacy-solana",
          cluster: value.cluster,
          signature: value.signature,
          ref: value,
        }
      : null;
  }
  if (value.kind === "x402") {
    if (!exactKeys(value, [
      "kind", "httpResource", "paymentReceiptHash", "protocolVersion",
    ], ["settlementTxHash", "chainId"]) ||
      typeof value.httpResource !== "string" || value.httpResource.length === 0 ||
      typeof value.paymentReceiptHash !== "string" ||
      !/^[0-9a-f]{64}$/.test(value.paymentReceiptHash) ||
      typeof value.protocolVersion !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(value.protocolVersion)) return null;
    const parsed: ParsedSettlementRef = {
      mode: "legacy-x402",
      paymentReceiptHash: value.paymentReceiptHash,
      ref: value,
    };
    if (Object.prototype.hasOwnProperty.call(value, "settlementTxHash")) {
      const txHash = canonicalEvmHash(value.settlementTxHash);
      if (txHash === null) return null;
      parsed.signedTxHash = txHash;
    }
    if (Object.prototype.hasOwnProperty.call(value, "chainId")) {
      if (!isPositiveSafeInt(value.chainId)) return null;
      parsed.signedChainId = value.chainId;
    }
    return parsed;
  }
  return null;
}

function parsePaymentAnchor(
  value: unknown,
): { jobId: string; railId: string; phaseIndex: number } | null {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (parts.length === 6) {
    if (parts[5] !== "resolved") return null;
    parts.pop();
  }
  if (parts.length !== 5 || parts[0] !== "dacs4" || parts[1] !== "payment") {
    return null;
  }
  const jobId = parts[2]!;
  const encodedRailId = parts[3]!;
  const phaseText = parts[4]!;
  if (!isCanonicalJobId(jobId) || encodedRailId.length === 0 ||
      !/^(0|[1-9][0-9]*)$/.test(phaseText)) return null;
  const phaseIndex = Number(phaseText);
  if (!isSafeUint(phaseIndex)) return null;
  const railId = decodeAddressSegment(encodedRailId);
  if (encodeAddressSegment(railId) !== encodedRailId) return null;
  return { jobId, railId, phaseIndex };
}

function eventIndex(
  event: AuthenticatedSettlementLedgerEvent,
): number {
  return event.ledger === "evm" ? event.logIndex : event.instructionIndex;
}

function inEnvelope(
  event: AuthenticatedSettlementLedgerEvent,
  parsed: ParsedSettlementRef,
): boolean {
  if (parsed.mode === "current-solana" || parsed.mode === "legacy-solana") {
    return event.ledger === "solana" && event.cluster === parsed.cluster &&
      event.signature === parsed.signature;
  }
  return event.ledger === "evm" && event.chainId === parsed.chainId &&
    canonicalEvmHash(event.txHash) === parsed.txHash;
}

function semanticMatch(
  event: AuthenticatedSettlementLedgerEvent,
  context: SettlementEventIdentityContext,
  evidence: Record<string, unknown>,
): boolean {
  const paymentAmount = evidence.paymentAmount;
  return isRecord(paymentAmount) &&
    event.asset === context.asset && event.payer === context.payer &&
    event.payee === context.payee && event.amount === context.amount.amount &&
    event.amount === paymentAmount.amount &&
    paymentAmount.currency === context.amount.currency;
}

async function authenticateEvidence(
  evidence: Record<string, unknown>,
  deps: SettlementEventIdentityDeps,
): Promise<SettlementEventIdentityDecision> {
  const signature = evidence.signature;
  if (!isComponentSignature(signature) || signature.algorithm !== "ed25519") {
    return "fail";
  }
  let key: Uint8Array | null;
  try {
    key = await deps.resolvePublicKey(signature.signer);
  } catch {
    return "indeterminate";
  }
  if (key === null) return "indeterminate";
  if (!(key instanceof Uint8Array) || key.length !== 32) return "error";
  try {
    const message = signedBytes(
      ARTIFACT_SEPARATORS.SettlementEvidence,
      contentHash(stripSignature(evidence)),
    );
    const bytes = Uint8Array.from(Buffer.from(signature.value, "base64url"));
    return await deps.verify(message, bytes, key) ? "pass" : "fail";
  } catch {
    return "error";
  }
}

/**
 * Project a signed event reference using independently authenticated ledger
 * events. An envelope-only reference projects only when exactly one event
 * matches. Projection alone supplies no SB-2 counting authority.
 */
async function projectSettlementEventIdentity(
  evidenceValue: unknown,
  context: Readonly<SettlementEventIdentityContext>,
  deps: SettlementEventIdentityDeps,
): Promise<SettlementEventIdentityResolution> {
  try {
    const evidence = snapshotExactJson(
      evidenceValue,
      "settlement evidence",
    );
    if (!isRecord(evidence) || !isCanonicalJobId(evidence.jobId) || !isSettlementEvidence(evidence)) {
      return { decision: "error", reason: "settlement evidence is malformed" };
    }
    const capturedContext = snapshotExactJson(
      context,
      "settlement identity context",
    );
    if (!isSettlementIdentityContext(capturedContext)) {
      return { decision: "error", reason: "settlement identity context is malformed" };
    }
    const capturedDeps = captureSettlementIdentityDeps(deps);
    if (capturedDeps === null) {
      return { decision: "error", reason: "settlement identity dependencies are malformed" };
    }
    return await resolveCapturedSettlementEventIdentity(
      evidence,
      capturedContext,
      capturedDeps,
    );
  } catch {
    return {
      decision: "error",
      reason: "settlement identity inputs could not be safely captured",
    };
  }
}

async function resolveCapturedSettlementEventIdentity(
  evidenceValue: Record<string, unknown>,
  context: Readonly<SettlementEventIdentityContext>,
  deps: SettlementEventIdentityDeps,
): Promise<SettlementEventIdentityResolution> {
  if (!isRecord(evidenceValue)) {
    return { decision: "error", reason: "settlement evidence is malformed" };
  }
  const authenticity = await authenticateEvidence(evidenceValue, deps);
  if (authenticity !== "pass") {
    return {
      decision: authenticity,
      reason: authenticity === "fail"
        ? "settlement evidence signature is invalid"
        : "settlement evidence signer could not be authenticated",
    };
  }
  if (evidenceValue.outcome !== "success" ||
      !isCanonicalJobId(evidenceValue.jobId) ||
      !Array.isArray(evidenceValue.paymentTxRefs) ||
      evidenceValue.paymentTxRefs.length !== 1) {
    return { decision: "error", reason: "success evidence has no singular transaction ref" };
  }
  const parsed = parseSettlementRef(evidenceValue.paymentTxRefs[0]);
  if (parsed === null) {
    return { decision: "error", reason: "transaction ref cannot project an SB-1 identity" };
  }
  if (!isSafeUint(context.phaseIndex) || typeof context.railId !== "string" ||
      context.railId.length === 0) {
    return { decision: "error", reason: "authenticated phase context is malformed" };
  }
  const anchor = parsePaymentAnchor(context.anchorAddress);
  if (anchor === null) {
    return { decision: "error", reason: "payment evidence anchor is non-canonical" };
  }
  if (anchor.jobId !== evidenceValue.jobId || anchor.railId !== context.railId ||
      anchor.phaseIndex !== context.phaseIndex) {
    return { decision: "fail", reason: "payment evidence anchor tuple mismatch" };
  }
  if (context.ledgerEvents === undefined || context.ledgerEvents === null) {
    return { decision: "indeterminate", reason: "authenticated ledger history unavailable" };
  }
  if (!Array.isArray(context.ledgerEvents)) {
    return { decision: "error", reason: "authenticated ledger events are malformed" };
  }

  if (parsed.mode === "current-x402" || parsed.mode === "legacy-x402") {
    const receipt = context.x402Receipt;
    if (receipt?.verified !== true) {
      return { decision: "indeterminate", reason: "x402 receipt is not independently verified" };
    }
    if (receipt.paymentReceiptHash !== parsed.ref.paymentReceiptHash) {
      return { decision: "fail", reason: "x402 receipt hash mismatch" };
    }
    const receiptTxHash = canonicalEvmHash(receipt.settlementTxHash);
    if (receiptTxHash === null || !isPositiveSafeInt(receipt.chainId)) {
      return { decision: "fail", reason: "verified x402 receipt identity is malformed" };
    }
    if (parsed.mode === "current-x402") {
      if (receiptTxHash !== parsed.txHash || receipt.chainId !== parsed.chainId) {
        return { decision: "fail", reason: "x402 receipt event tuple mismatch" };
      }
    } else {
      if ((parsed.signedTxHash !== undefined && parsed.signedTxHash !== receiptTxHash) ||
          (parsed.signedChainId !== undefined && parsed.signedChainId !== receipt.chainId)) {
        return { decision: "fail", reason: "legacy x402 signed receipt tuple mismatch" };
      }
      parsed.txHash = receiptTxHash;
      parsed.chainId = receipt.chainId;
    }
  }

  const envelope = context.ledgerEvents.filter((event) =>
    inEnvelope(event, parsed));
  let index: number;
  const current = parsed.mode === "current-evm" ||
    parsed.mode === "current-solana" || parsed.mode === "current-x402";
  if (
    parsed.mode === "current-evm" || parsed.mode === "current-solana" ||
    parsed.mode === "current-x402"
  ) {
    const selected = envelope.filter((event) => eventIndex(event) === parsed.index);
    if (selected.length !== 1 ||
        !semanticMatch(selected[0]!, context, evidenceValue)) {
      return { decision: "fail", reason: "signed event coordinate does not select the settlement" };
    }
    index = parsed.index;
  } else {
    const matching = envelope.filter((event) =>
      semanticMatch(event, context, evidenceValue));
    if (matching.length === 0) {
      return { decision: "fail", reason: "legacy transaction has no matching settlement event" };
    }
    if (matching.length !== 1) {
      return { decision: "indeterminate", reason: "legacy transaction event is ambiguous" };
    }
    index = eventIndex(matching[0]!);
    if (!isSafeUint(index)) {
      return { decision: "error", reason: "authenticated event coordinate is malformed" };
    }
  }

  const settlementId = parsed.mode === "current-solana" ||
      parsed.mode === "legacy-solana"
    ? `solana:${parsed.cluster}:${parsed.signature}:${index}`
    : `evm:${parsed.chainId}:${parsed.txHash}:${index}`;
  if (!isCanonicalSettlementIdentity(settlementId)) {
    return { decision: "error", reason: "projected settlement identity is non-canonical" };
  }
  return {
    decision: "pass",
    settlementId,
    replay: current ? "current" : "legacy",
  };
}


/** One member of the consumer's complete presented evidence set. */
export interface SettlementEventIdentityRecord {
  evidence: unknown;
  context: Readonly<SettlementEventIdentityContext>;
  /** Exact RailDefinition hash and registered binding profile from authenticated agreement context. */
  railProfile?: Readonly<{ definitionHash: string; bindingProfile: string }>;
}

export interface SettlementCollisionAuthority {
  settlementId: string;
  railId: string;
  definitionHash: string;
  bindingProfile: string;
  jobId: string;
  phaseIndex: number;
}

/**
 * Trusted verifier capability. Resolve independently authenticated, finalized
 * settlement-side relations, never outer evidence signatures or caller hints.
 * Return every relation for this group; conflicting authority selects nobody.
 * Job-only Permit2/AP2 proofs cannot supply a phaseIndex in this revision.
 */
export type AuthenticateSettlementCollision = (input: Readonly<{
  settlementId: string;
  claims: readonly Readonly<{
    jobId: string; phaseIndex: number; railId: string;
    railProfile?: Readonly<{ definitionHash: string; bindingProfile: string }>;
  }>[];
}>) => Promise<readonly SettlementCollisionAuthority[] | null> |
  readonly SettlementCollisionAuthority[] | null;

export interface SettlementEventIdentitySetResolution {
  records: SettlementEventIdentityResolution[];
  /** Unique countable events. Recompute this list whenever the presented set changes. */
  countable: { settlementId: string; jobId: string; phaseIndex: number }[];
}

/**
 * SB-1 point inspection cannot establish SB-2 count authority. In particular an
 * empty priorClaims index cannot authorize the first claimant. Use the complete
 * presented-set API below for countable decisions.
 */
export async function resolveSettlementEventIdentity(
  evidence: unknown,
  context: Readonly<SettlementEventIdentityContext>,
  deps: SettlementEventIdentityDeps,
): Promise<SettlementEventIdentityResolution> {
  const result = await projectSettlementEventIdentity(evidence, context, deps);
  return result.decision === "pass"
    ? { decision: "indeterminate", reason: "SB-2 requires the complete presented evidence set" }
    : result;
}

/** DACS-4 §9.5.8 SB-2: authenticate all records, then decide entire groups. */
export async function resolveSettlementEventIdentities(
  records: readonly SettlementEventIdentityRecord[],
  deps: SettlementEventIdentityDeps,
  authenticateCollision?: AuthenticateSettlementCollision,
): Promise<SettlementEventIdentitySetResolution> {
  // Own the entire set and capture capabilities before the first await. Mutation
  // during one signature check cannot hide another claimant or switch authority.
  const captured = snapshotExactJson(records, "settlement evidence set");
  const capturedDeps = captureSettlementIdentityDeps(deps);
  if (!Array.isArray(captured) || capturedDeps === null ||
      (authenticateCollision !== undefined &&
        (typeof authenticateCollision !== "function" || nodeTypes.isProxy(authenticateCollision)))) {
    throw new TypeError("settlement evidence set dependencies are malformed");
  }
  for (const record of captured) {
    if (!isRecord(record) || !exactKeys(record, ["evidence", "context"], ["railProfile"]) ||
        !isSettlementIdentityContext(record.context) ||
        (record.railProfile !== undefined && (!isRecord(record.railProfile) ||
          !exactKeys(record.railProfile, ["definitionHash", "bindingProfile"]) ||
          typeof record.railProfile.definitionHash !== "string" ||
          !/^[0-9a-f]{64}$/.test(record.railProfile.definitionHash) ||
          !isNonEmptyString(record.railProfile.bindingProfile)))) {
      throw new TypeError("settlement evidence set record is malformed");
    }
  }
  const owned = captured as unknown as SettlementEventIdentityRecord[];
  const results: SettlementEventIdentityResolution[] = [];
  const groups = new Map<string, number[]>();
  for (const [index, record] of owned.entries()) {
    const result = await projectSettlementEventIdentity(record.evidence, record.context, capturedDeps);
    results.push(result);
    if (result.decision === "pass") {
      const members = groups.get(result.settlementId) ?? [];
      members.push(index);
      groups.set(result.settlementId, members);
    }
  }
  const countable: SettlementEventIdentitySetResolution["countable"] = [];
  for (const [settlementId, members] of groups) {
    const claims = members.map((index) => {
      const record = owned[index]!;
      return {
        jobId: (record.evidence as { jobId: string }).jobId,
        phaseIndex: record.context.phaseIndex,
        railId: record.context.railId,
        ...(record.railProfile === undefined ? {} : { railProfile: record.railProfile }),
      };
    });
    const tupleKey = (claim: { jobId: string; phaseIndex: number }) =>
      `${claim.jobId}:${claim.phaseIndex}`;
    const tuples = new Set(claims.map(tupleKey));
    // A retained first-claim index can reveal omitted evidence, but cannot
    // select its winner. The complete records must be presented for a decision.
    const omitted = members.some((index) => Object.entries(owned[index]!.context.priorClaims ?? {})
      .some(([id, claim]) => id === settlementId && !tuples.has(tupleKey(claim))));
    let winner: string | undefined;
    let winningAuthority: SettlementCollisionAuthority[] | undefined;
    if (tuples.size === 1 && !omitted) winner = tupleKey(claims[0]!);
    else if (!omitted && authenticateCollision !== undefined) {
      let authority: unknown;
      try {
        const input = snapshotExactJson({ settlementId, claims }, "collision verifier input");
        const freeze = (value: unknown): void => {
          if (value !== null && typeof value === "object") {
            for (const child of Object.values(value)) freeze(child);
            Object.freeze(value);
          }
        };
        freeze(input);
        authority = snapshotExactJson(await authenticateCollision(
          input as Parameters<AuthenticateSettlementCollision>[0],
        ), "collision authority");
      } catch { authority = null; }
      // Do not discard a conflicting or incomplete relation and then select
      // the remaining one. Every authenticated relation must establish the
      // same exact tuple and applicable rail/profile in this collision group.
      if (Array.isArray(authority) && authority.length > 0 && authority.every((binding) =>
        isRecord(binding) && exactKeys(binding, ["settlementId", "railId", "definitionHash", "bindingProfile", "jobId", "phaseIndex"]) &&
        binding.settlementId === settlementId && isCanonicalJobId(binding.jobId) &&
        isSafeUint(binding.phaseIndex) && claims.some((claim) =>
          binding.jobId === claim.jobId && binding.phaseIndex === claim.phaseIndex &&
          binding.railId === claim.railId && binding.definitionHash === claim.railProfile?.definitionHash &&
          binding.bindingProfile === claim.railProfile?.bindingProfile))) {
        const selected = new Set(authority.map((binding) => tupleKey(binding as unknown as { jobId: string; phaseIndex: number })));
        if (selected.size === 1) {
          winner = [...selected][0];
          winningAuthority = authority as SettlementCollisionAuthority[];
        }
      }
    }
    if (winner === undefined) {
      for (const index of members) results[index] = {
        decision: "indeterminate", reason: "SB-2 collision has no exact finalized settlement-side authority",
      };
    } else {
      const selected = claims.find((claim) => tupleKey(claim) === winner)!;
      countable.push({ settlementId, jobId: selected.jobId, phaseIndex: selected.phaseIndex });
      for (let offset = 0; offset < members.length; offset += 1) {
        const claim = claims[offset]!;
        if (tupleKey(claim) !== winner) results[members[offset]!] = {
          decision: "fail", reason: "SB-2 settlement-side authority binds another tuple",
        };
        else if (winningAuthority !== undefined && !winningAuthority.some((binding) =>
          binding.railId === claim.railId && binding.definitionHash === claim.railProfile?.definitionHash &&
          binding.bindingProfile === claim.railProfile?.bindingProfile)) results[members[offset]!] = {
          decision: "indeterminate", reason: "SB-2 authority does not authenticate this record's pinned rail/profile",
        };
      }
    }
  }
  return { records: results, countable };
}
