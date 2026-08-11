import { types as nodeTypes } from "node:util";

import { isComponentSignature } from "../artifacts/signatures.js";
import { ARTIFACT_SEPARATORS } from "../artifacts/registry.js";
import type { ChainTxRef } from "../artifacts/types.js";
import {
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
  /** Consumer-local SB-2 index. Undefined means uniqueness is unavailable. */
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
  if (jobId.length === 0 || encodedRailId.length === 0 ||
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
 * Resolve a signed DACS-4 v0.6 event reference, or safely replay a frozen
 * legacy envelope reference. `ledgerEvents` must already be independently
 * authenticated; caller annotations and out-of-band indexes are deliberately
 * absent from the API. Legacy projection succeeds only for exactly one
 * semantically matching event.
 */
export async function resolveSettlementEventIdentity(
  evidenceValue: unknown,
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
      typeof evidenceValue.jobId !== "string" || evidenceValue.jobId.length === 0 ||
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
  if (context.priorClaims === undefined) {
    return { decision: "indeterminate", reason: "SB-2 uniqueness index unavailable" };
  }
  const previous = context.priorClaims[settlementId];
  if (previous !== undefined &&
      (previous.jobId !== evidenceValue.jobId ||
        previous.phaseIndex !== context.phaseIndex)) {
    return { decision: "fail", reason: "settlement event is already bound to another phase" };
  }
  return {
    decision: "pass",
    settlementId,
    replay: current ? "current" : "legacy",
  };
}
