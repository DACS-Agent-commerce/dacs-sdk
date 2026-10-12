import {
  assertPositiveAmount,
  baseUnits,
  canonicalize,
  sha256Hex,
} from "../canonical/index.js";
import { DacsError } from "../errors.js";

const DEFAULT_LEASE_MS = 30_000;
const HASH_RE = /^[0-9a-f]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export type SolanaCluster = "mainnet" | "devnet" | "testnet";
export type SolanaCommitmentLevel = "processed" | "confirmed" | "finalized";

export interface SolanaSplSettlementAuthority {
  jobId: string;
  phaseIndex: number;
  railId: string;
  railDescriptorHash: string;
  agreementHash: string;
  assetKind: "spl";
  cluster: SolanaCluster;
  commitmentLevel?: SolanaCommitmentLevel;
  payer: string;
  payee: string;
  mint: string;
  assetSymbol: string;
  amount: string;
  currency: string;
  tokenDecimals: number;
  createPayeeAtaIfMissing?: boolean;
}

export interface SolanaSplSettlementIntent {
  intentVersion: "1";
  settlementKey: string;
  bindingHash: string;
  jobId: string;
  phaseIndex: number;
  railId: string;
  railDescriptorHash: string;
  agreementHash: string;
  assetKind: "spl";
  cluster: SolanaCluster;
  commitmentLevel: SolanaCommitmentLevel;
  payer: string;
  payee: string;
  mint: string;
  assetSymbol: string;
  amount: string;
  amountBaseUnits: string;
  tokenDecimals: number;
  createPayeeAtaIfMissing: boolean;
}

export interface SolanaSplPreflight {
  payerTokenAccount: string;
  payerTokenBalanceBaseUnits: string;
  payerNativeBalanceLamports: string;
  payeeAta: string;
  payeeAtaExists: boolean;
  payeeAtaOwner: string;
  payeeAtaMint: string;
  networkFeeLamports: string;
  ataRentExemptReserveLamports: string;
}

export interface SolanaSplTransferPlan {
  intent: Readonly<SolanaSplSettlementIntent>;
  payerTokenAccount: string;
  payeeAta: string;
  createPayeeAta: boolean;
  payerFundsAtaRentLamports: string;
  instruction: "TransferChecked";
}

export interface SolanaSplSignedAttempt {
  attemptVersion: "1";
  attempt: number;
  authorityHash: string;
  signature: string;
  signedTransactionBase64: string;
  lastValidBlockHeight: number;
  transferInstructionIndex: number;
  preparedAt: number;
  attemptHash: string;
}

export interface SolanaSplExpiryEvidence {
  signature: string;
  observedBlockHeight: number;
  commitmentLevel: "confirmed";
  authenticationHash: string;
}

export interface SolanaSplObservedTransfer {
  cluster: SolanaCluster;
  signature: string;
  instructionIndex: number;
  standard: "spl-transfer-checked";
  mint: string;
  payer: string;
  payee: string;
  amountBaseUnits: string;
  tokenDecimals: number;
  commitmentLevel: SolanaCommitmentLevel;
  finalityObservedAt: number;
  authenticationHash: string;
}

export type SolanaSplReconciliation =
  | { disposition: "settled-same"; transfer: Readonly<SolanaSplObservedTransfer> }
  | { disposition: "pending"; reason: string }
  | { disposition: "absent-valid"; authenticationHash: string }
  | {
      disposition: "absent-expired";
      authenticationHash: string;
      observedBlockHeight?: number;
      commitmentLevel?: SolanaCommitmentLevel;
    }
  | { disposition: "settled-different"; reason: string; authenticationHash: string }
  | { disposition: "indeterminate"; reason: string };

export type SolanaSplBroadcastResult =
  | { disposition: "submitted" }
  | { disposition: "rejected" | "indeterminate"; reason: string };

export interface SolanaSplEffectFence {
  settlementKey: string;
  bindingHash: string;
  owner: string;
  generation: number;
  assertCurrent(): Promise<void>;
}

/**
 * Wallet/RPC boundary. Implementations must inspect the exact retained signed
 * transaction and authenticate reconciliation against Solana ledger state. An
 * absent-expired result must derive absence and block height from one coherent
 * confirmed view, and its authentication hash must bind the cluster,
 * signature, last-valid bound, observed height and commitment level.
 */
export interface SolanaSplAdapter {
  preflight(
    intent: Readonly<SolanaSplSettlementIntent>,
    fence: Readonly<SolanaSplEffectFence>,
  ): Promise<Readonly<SolanaSplPreflight>>;
  prepareSignedTransfer(
    plan: Readonly<SolanaSplTransferPlan>,
    attempt: number,
    fence: Readonly<SolanaSplEffectFence>,
  ): Promise<Readonly<Omit<SolanaSplSignedAttempt, "attemptHash">>>;
  broadcastRetained(
    attempt: Readonly<SolanaSplSignedAttempt>,
    fence: Readonly<SolanaSplEffectFence>,
  ): Promise<SolanaSplBroadcastResult>;
  reconcile(
    intent: Readonly<SolanaSplSettlementIntent>,
    attempt: Readonly<SolanaSplSignedAttempt>,
    fence: Readonly<SolanaSplEffectFence>,
  ): Promise<SolanaSplReconciliation>;
}

export interface SolanaSplSettlementResult {
  txRef: Readonly<{
    kind: "solana-instruction";
    cluster: SolanaCluster;
    signature: string;
    instructionIndex: number;
  }>;
  paymentAmount: Readonly<{ amount: string; currency: string }>;
  settlementFinality: Readonly<{
    model: "commitment-level";
    finalityCommitmentLevel: SolanaCommitmentLevel;
    finalityObservedAt: number;
  }>;
  authenticationHash: string;
}

export interface SolanaSplLease {
  owner: string;
  generation: number;
  expiresAt: number;
}

export type SolanaSplStoreClaim =
  | {
      status: "acquired";
      intent: Readonly<SolanaSplSettlementIntent>;
      lease: Readonly<SolanaSplLease>;
      attempts: readonly Readonly<SolanaSplSignedAttempt>[];
      expiredSignatures: readonly string[];
      expiryEvidence?: readonly Readonly<SolanaSplExpiryEvidence>[];
    }
  | {
      status: "waiting";
      intent: Readonly<SolanaSplSettlementIntent>;
      lease: Readonly<SolanaSplLease>;
      attempts: readonly Readonly<SolanaSplSignedAttempt>[];
      expiredSignatures: readonly string[];
      expiryEvidence?: readonly Readonly<SolanaSplExpiryEvidence>[];
    }
  | {
      status: "settled";
      intent: Readonly<SolanaSplSettlementIntent>;
      settlement: Readonly<SolanaSplSettlementResult>;
    }
  | { status: "conflict" | "corrupt"; reason: string };

export type SolanaSplStoreWrite =
  | {
      status: "recorded" | "existing";
      /** Required for markAttemptExpired: exact evidence durably retained. */
      expiryEvidence?: Readonly<SolanaSplExpiryEvidence>;
    }
  | { status: "stale" | "conflict" | "corrupt"; reason: string };

/** Atomic durable retained-transaction store. */
export interface SolanaSplSettlementStore {
  claim(input: {
    intent: Readonly<SolanaSplSettlementIntent>;
    owner: string;
    now: number;
    leaseDurationMs: number;
  }): Promise<SolanaSplStoreClaim>;
  isCurrent(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    now: number;
  }): Promise<boolean>;
  recordAttempt(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    attempt: Readonly<SolanaSplSignedAttempt>;
  }): Promise<SolanaSplStoreWrite>;
  markAttemptExpired(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    signature: string;
    observedBlockHeight: number;
    commitmentLevel: "confirmed";
    authenticationHash: string;
  }): Promise<SolanaSplStoreWrite>;
  recordSettlement(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    signature: string;
    settlement: Readonly<SolanaSplSettlementResult>;
  }): Promise<SolanaSplStoreWrite>;
}

/**
 * The result of one `advanceSolanaSplSettlement` call. `reason` is always a
 * fixed `solana-spl-*` code; it never carries adapter, RPC, store or caller
 * text.
 *
 * - `settled`: the exact transfer reached the intent's commitment and the
 *   store recorded it.
 * - `waiting`: try the same authority again later. It never authorizes a
 *   fresh payment.
 * - `indeterminate`: the phase may or may not be paid. A transfer may have
 *   landed or may still land. It never authorizes a fresh payment; resolve it
 *   by resuming the same authority or out of band.
 * - `failed`: nothing under this settlement key can land *now*. Every
 *   retained attempt has durable expiry evidence, and no new transfer was
 *   signed. The store record stays open, so a later call with the same
 *   authority can still sign and settle. Stop advancing this key before
 *   paying the phase any other way.
 */
export type SolanaSplProgress =
  | { status: "waiting" | "indeterminate"; reason: string }
  | {
      status: "failed";
      errorClass: "permanent" | "counterparty";
      reason: string;
    }
  | { status: "settled"; settlement: Readonly<SolanaSplSettlementResult> };

export interface AdvanceSolanaSplSettlementInput {
  authority: Readonly<SolanaSplSettlementAuthority>;
  owner: string;
  store: SolanaSplSettlementStore;
  adapter: SolanaSplAdapter;
  now?: () => number;
  leaseDurationMs?: number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DacsError(`pay-solana-spl: ${label} must be a non-empty string`);
  }
  return value;
}

function requireBase58(
  value: unknown,
  label: string,
  minLength = 1,
  maxLength = 128,
): string {
  const parsed = requireString(value, label);
  if (!BASE58_RE.test(parsed) || parsed.length < minLength || parsed.length > maxLength) {
    throw new DacsError(`pay-solana-spl: ${label} must be base58`);
  }
  return parsed;
}

function requireBase58Bytes(
  value: unknown,
  label: string,
  expectedBytes: number,
): string {
  // Canonical Base58 encodes each leading zero byte as one leading `1`.
  // Bound the attacker-controlled input before BigInt accumulation: 32-byte
  // Solana public keys need at most 44 digits and 64-byte signatures at most 88.
  const maxLength = expectedBytes === 32 ? 44 : expectedBytes === 64 ? 88 : 128;
  const parsed = requireBase58(value, label, expectedBytes, maxLength);
  let decoded = 0n;
  for (const character of parsed) {
    decoded = decoded * 58n + BigInt(BASE58_ALPHABET.indexOf(character));
  }
  let nonZeroBytes = 0;
  for (let cursor = decoded; cursor > 0n; cursor >>= 8n) nonZeroBytes += 1;
  let leadingZeroBytes = 0;
  while (leadingZeroBytes < parsed.length && parsed[leadingZeroBytes] === "1") {
    leadingZeroBytes += 1;
  }
  if (leadingZeroBytes + nonZeroBytes !== expectedBytes) {
    throw new DacsError(
      `pay-solana-spl: ${label} must decode to exactly ${expectedBytes} bytes`,
    );
  }
  return parsed;
}

function uint(value: string, label: string): bigint {
  if (!UINT_RE.test(value)) {
    throw new DacsError(`pay-solana-spl: ${label} must be canonical unsigned decimal`);
  }
  return BigInt(value);
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DacsError(`pay-solana-spl: ${label} must be a positive safe integer`);
  }
  return value;
}

function clockValue(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DacsError("pay-solana-spl: clock must return a non-negative safe integer");
  }
  return value;
}

export function solanaSplSettlementKey(input: {
  jobId: string;
  railId: string;
  phaseIndex: number;
}): string {
  if (!Number.isSafeInteger(input.phaseIndex) || input.phaseIndex < 0) {
    throw new DacsError("pay-solana-spl: phaseIndex must be a non-negative safe integer");
  }
  return sha256Hex(`dacs-solana-spl-settlement:v1:${canonicalize({
    jobId: requireString(input.jobId, "jobId").normalize("NFC"),
    phaseIndex: input.phaseIndex,
    railId: requireString(input.railId, "railId").normalize("NFC"),
  })}`);
}

export function createSolanaSplSettlementIntent(
  authority: Readonly<SolanaSplSettlementAuthority>,
): Readonly<SolanaSplSettlementIntent> {
  if (authority.assetKind !== "spl") {
    throw new DacsError("pay-solana-spl: rail asset kind must be spl");
  }
  if (!HASH_RE.test(authority.railDescriptorHash) || !HASH_RE.test(authority.agreementHash)) {
    throw new DacsError("pay-solana-spl: authority hashes must be 32-byte lower-case hex");
  }
  if (!Number.isSafeInteger(authority.tokenDecimals) ||
      authority.tokenDecimals < 0 || authority.tokenDecimals > 255) {
    throw new DacsError("pay-solana-spl: tokenDecimals must be an unsigned byte");
  }
  if (authority.currency !== authority.assetSymbol) {
    throw new DacsError("pay-solana-spl: payment currency does not match rail asset symbol");
  }
  const commitmentLevel = authority.commitmentLevel ?? "confirmed";
  if (!["processed", "confirmed", "finalized"].includes(commitmentLevel)) {
    throw new DacsError("pay-solana-spl: unsupported commitment level");
  }
  if (!["mainnet", "devnet", "testnet"].includes(authority.cluster)) {
    throw new DacsError("pay-solana-spl: unsupported cluster");
  }
  const amount = assertPositiveAmount(authority.amount);
  const amountBaseUnits = baseUnits(amount, authority.tokenDecimals);
  const unsigned = {
    intentVersion: "1" as const,
    settlementKey: solanaSplSettlementKey(authority),
    jobId: requireString(authority.jobId, "jobId").normalize("NFC"),
    phaseIndex: authority.phaseIndex,
    railId: requireString(authority.railId, "railId"),
    railDescriptorHash: authority.railDescriptorHash,
    agreementHash: authority.agreementHash,
    assetKind: authority.assetKind,
    cluster: authority.cluster,
    commitmentLevel,
    payer: requireBase58Bytes(authority.payer, "payer", 32),
    payee: requireBase58Bytes(authority.payee, "payee", 32),
    mint: requireBase58Bytes(authority.mint, "mint", 32),
    assetSymbol: requireString(authority.assetSymbol, "assetSymbol"),
    amount,
    amountBaseUnits,
    tokenDecimals: authority.tokenDecimals,
    createPayeeAtaIfMissing: authority.createPayeeAtaIfMissing === true,
  };
  return Object.freeze({
    ...unsigned,
    bindingHash: sha256Hex(canonicalize(unsigned)),
  });
}

function validatePreflight(
  intent: Readonly<SolanaSplSettlementIntent>,
  preflight: Readonly<SolanaSplPreflight>,
): SolanaSplTransferPlan | SolanaSplProgress {
  try {
    requireBase58Bytes(preflight.payerTokenAccount, "payerTokenAccount", 32);
    requireBase58Bytes(preflight.payeeAta, "payeeAta", 32);
    const tokenBalance = uint(preflight.payerTokenBalanceBaseUnits, "payerTokenBalanceBaseUnits");
    const nativeBalance = uint(preflight.payerNativeBalanceLamports, "payerNativeBalanceLamports");
    const networkFee = uint(preflight.networkFeeLamports, "networkFeeLamports");
    const ataRent = uint(preflight.ataRentExemptReserveLamports, "ataRentExemptReserveLamports");
    if (tokenBalance < BigInt(intent.amountBaseUnits)) {
      return { status: "failed", errorClass: "permanent", reason: "solana-spl-insufficient-token-balance" };
    }
    if (!preflight.payeeAtaExists && !intent.createPayeeAtaIfMissing) {
      return { status: "failed", errorClass: "counterparty", reason: "solana-spl-payee-ata-missing" };
    }
    if (preflight.payeeAtaExists &&
        (preflight.payeeAtaOwner !== intent.payee || preflight.payeeAtaMint !== intent.mint)) {
      return { status: "failed", errorClass: "counterparty", reason: "solana-spl-payee-ata-binding-mismatch" };
    }
    const requiredNative = networkFee + (preflight.payeeAtaExists ? 0n : ataRent);
    if (nativeBalance < requiredNative) {
      return {
        status: "failed",
        errorClass: "permanent",
        reason: preflight.payeeAtaExists
          ? "solana-spl-insufficient-network-fee-balance"
          : "solana-spl-insufficient-ata-rent-and-fee-balance",
      };
    }
    return Object.freeze({
      intent,
      payerTokenAccount: preflight.payerTokenAccount,
      payeeAta: preflight.payeeAta,
      createPayeeAta: !preflight.payeeAtaExists,
      payerFundsAtaRentLamports: preflight.payeeAtaExists ? "0" : preflight.ataRentExemptReserveLamports,
      instruction: "TransferChecked" as const,
    });
  } catch {
    // The adapter's message may carry RPC or account detail; never echo it.
    return { status: "failed", errorClass: "permanent", reason: "solana-spl-preflight-invalid" };
  }
}

function createAttempt(
  value: Readonly<Omit<SolanaSplSignedAttempt, "attemptHash">>,
  expectedAttempt: number,
  intent: Readonly<SolanaSplSettlementIntent>,
): Readonly<SolanaSplSignedAttempt> {
  if (value.attemptVersion !== "1" || value.attempt !== expectedAttempt ||
      value.authorityHash !== intent.bindingHash) {
    throw new DacsError("pay-solana-spl: prepared transaction authority mismatch");
  }
  requireBase58Bytes(value.signature, "signature", 64);
  if (typeof value.signedTransactionBase64 !== "string" ||
      value.signedTransactionBase64.length === 0) {
    throw new DacsError("pay-solana-spl: signed transaction bytes are required");
  }
  const encoded = value.signedTransactionBase64;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length === 0 ||
      decoded.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) {
    throw new DacsError("pay-solana-spl: signed transaction must be base64");
  }
  for (const [label, number] of [
    ["lastValidBlockHeight", value.lastValidBlockHeight],
    ["transferInstructionIndex", value.transferInstructionIndex],
    ["preparedAt", value.preparedAt],
  ] as const) {
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new DacsError(`pay-solana-spl: ${label} must be a non-negative safe integer`);
    }
  }
  const unsigned = { ...value };
  return Object.freeze({
    ...unsigned,
    attemptHash: sha256Hex(canonicalize(unsigned)),
  });
}

function captureRetainedAttempts(
  values: readonly Readonly<SolanaSplSignedAttempt>[],
  intent: Readonly<SolanaSplSettlementIntent>,
): readonly Readonly<SolanaSplSignedAttempt>[] {
  if (!Array.isArray(values)) {
    throw new DacsError("pay-solana-spl: retained attempts must be an array");
  }
  const signatures = new Set<string>();
  return Object.freeze(values.map((value, index) => {
    const { attemptHash, ...unsigned } = value;
    const captured = createAttempt(unsigned, index + 1, intent);
    if (captured.attemptHash !== attemptHash) {
      throw new DacsError("pay-solana-spl: retained attempt integrity mismatch");
    }
    if (signatures.has(captured.signature)) {
      throw new DacsError("pay-solana-spl: retained signature is duplicated");
    }
    signatures.add(captured.signature);
    return captured;
  }));
}

function captureExpiryEvidence(
  value: Readonly<{
    signature: unknown;
    observedBlockHeight: unknown;
    commitmentLevel: unknown;
    authenticationHash: unknown;
  }>,
  attempt: Readonly<SolanaSplSignedAttempt>,
): Readonly<SolanaSplExpiryEvidence> {
  if (value.signature !== attempt.signature) {
    throw new DacsError("pay-solana-spl: expiry evidence signature mismatch");
  }
  if (typeof value.observedBlockHeight !== "number" ||
      !Number.isSafeInteger(value.observedBlockHeight) ||
      value.observedBlockHeight < 0 ||
      value.observedBlockHeight <= attempt.lastValidBlockHeight) {
    throw new DacsError("pay-solana-spl: expiry evidence block height is invalid");
  }
  if (value.commitmentLevel !== "confirmed") {
    throw new DacsError("pay-solana-spl: expiry evidence must be confirmed");
  }
  if (typeof value.authenticationHash !== "string" ||
      !HASH_RE.test(value.authenticationHash)) {
    throw new DacsError("pay-solana-spl: expiry evidence authentication hash is invalid");
  }
  return Object.freeze({
    signature: attempt.signature,
    observedBlockHeight: value.observedBlockHeight,
    commitmentLevel: value.commitmentLevel,
    authenticationHash: value.authenticationHash,
  });
}

function captureRetainedExpiryEvidence(
  values: readonly Readonly<SolanaSplExpiryEvidence>[] | undefined,
  attempts: readonly Readonly<SolanaSplSignedAttempt>[],
  expiredSignatures: readonly string[],
): ReadonlyMap<string, Readonly<SolanaSplExpiryEvidence>> {
  if (values === undefined) return new Map();
  if (!Array.isArray(values)) {
    throw new DacsError("pay-solana-spl: retained expiry evidence must be an array");
  }
  const captured = new Map<string, Readonly<SolanaSplExpiryEvidence>>();
  for (const value of values) {
    if (typeof value !== "object" || value === null) {
      throw new DacsError("pay-solana-spl: retained expiry evidence is invalid");
    }
    const candidate = value as unknown as Record<string, unknown>;
    const attempt = attempts.find((retained) => retained.signature === candidate.signature);
    if (!attempt || !expiredSignatures.includes(attempt.signature) ||
        captured.has(attempt.signature)) {
      throw new DacsError("pay-solana-spl: retained expiry evidence is inconsistent");
    }
    captured.set(attempt.signature, captureExpiryEvidence({
      signature: candidate.signature,
      observedBlockHeight: candidate.observedBlockHeight,
      commitmentLevel: candidate.commitmentLevel,
      authenticationHash: candidate.authenticationHash,
    }, attempt));
  }
  return captured;
}

function storedSettlementMatchesIntent(
  settlement: Readonly<SolanaSplSettlementResult>,
  intent: Readonly<SolanaSplSettlementIntent>,
): boolean {
  try {
    return settlement.txRef.kind === "solana-instruction" &&
      settlement.txRef.cluster === intent.cluster &&
      requireBase58Bytes(settlement.txRef.signature, "stored signature", 64).length > 0 &&
      Number.isSafeInteger(settlement.txRef.instructionIndex) &&
      settlement.txRef.instructionIndex >= 0 &&
      settlement.paymentAmount.amount === intent.amount &&
      settlement.paymentAmount.currency === intent.assetSymbol &&
      settlement.settlementFinality.model === "commitment-level" &&
      settlement.settlementFinality.finalityCommitmentLevel === intent.commitmentLevel &&
      Number.isSafeInteger(settlement.settlementFinality.finalityObservedAt) &&
      settlement.settlementFinality.finalityObservedAt >= 0 &&
      HASH_RE.test(settlement.authenticationHash);
  } catch {
    return false;
  }
}

function settlementFrom(
  intent: Readonly<SolanaSplSettlementIntent>,
  attempt: Readonly<SolanaSplSignedAttempt>,
  value: Readonly<SolanaSplObservedTransfer>,
): Readonly<SolanaSplSettlementResult> | null {
  // Read each field once, so what is checked is what is reported.
  const observed: SolanaSplObservedTransfer = {
    cluster: value.cluster,
    signature: value.signature,
    instructionIndex: value.instructionIndex,
    standard: value.standard,
    mint: value.mint,
    payer: value.payer,
    payee: value.payee,
    amountBaseUnits: value.amountBaseUnits,
    tokenDecimals: value.tokenDecimals,
    commitmentLevel: value.commitmentLevel,
    finalityObservedAt: value.finalityObservedAt,
    authenticationHash: value.authenticationHash,
  };
  if (observed.cluster !== intent.cluster || observed.signature !== attempt.signature ||
      observed.instructionIndex !== attempt.transferInstructionIndex ||
      observed.standard !== "spl-transfer-checked" || observed.mint !== intent.mint ||
      observed.payer !== intent.payer || observed.payee !== intent.payee ||
      observed.amountBaseUnits !== intent.amountBaseUnits ||
      observed.tokenDecimals !== intent.tokenDecimals ||
      observed.commitmentLevel !== intent.commitmentLevel ||
      typeof observed.authenticationHash !== "string" ||
      !HASH_RE.test(observed.authenticationHash) ||
      !Number.isSafeInteger(observed.finalityObservedAt) || observed.finalityObservedAt < 0) {
    return null;
  }
  return Object.freeze({
    txRef: Object.freeze({
      kind: "solana-instruction" as const,
      cluster: intent.cluster,
      signature: attempt.signature,
      instructionIndex: attempt.transferInstructionIndex,
    }),
    paymentAmount: Object.freeze({ amount: intent.amount, currency: intent.assetSymbol }),
    settlementFinality: Object.freeze({
      model: "commitment-level" as const,
      finalityCommitmentLevel: intent.commitmentLevel,
      finalityObservedAt: observed.finalityObservedAt,
    }),
    authenticationHash: observed.authenticationHash,
  });
}

/** A store claim after validation; every field was read exactly once. */
type ClaimView =
  | {
      status: "acquired";
      lease: Readonly<{ owner: unknown; generation: unknown; expiresAt: unknown }>;
      attempts: readonly Readonly<SolanaSplSignedAttempt>[];
      expiredSignatures: readonly string[];
      expiryEvidence: readonly Readonly<SolanaSplExpiryEvidence>[] | undefined;
    }
  | { status: "settled"; settlement: Readonly<SolanaSplSettlementResult> };

/**
 * Parses a store claim as the complete discriminated union before anything
 * acts on it. A partial, malformed or unreadable claim is never trusted: it
 * could belong to another binding or hide a retained broadcast.
 */
function readClaim(
  value: unknown,
  intent: Readonly<SolanaSplSettlementIntent>,
): ClaimView | SolanaSplProgress {
  const invalid = {
    status: "indeterminate",
    reason: "solana-spl-settlement-store-claim-invalid",
  } as const;
  try {
    if (typeof value !== "object" || value === null) return invalid;
    const claim = value as Record<string, unknown>;
    const status = claim.status;
    // A conflicting binding for the same phase, or a corrupt record, may hold
    // a broadcast this call cannot inspect, so neither proves the phase unpaid.
    if (status === "conflict") {
      return { status: "indeterminate", reason: "solana-spl-settlement-store-conflict" };
    }
    if (status === "corrupt") {
      return { status: "indeterminate", reason: "solana-spl-settlement-store-corrupt" };
    }
    if (status !== "acquired" && status !== "waiting" && status !== "settled") return invalid;
    const storedIntent = claim.intent;
    if (typeof storedIntent !== "object" || storedIntent === null) return invalid;
    try {
      if (canonicalize(storedIntent) !== canonicalize(intent)) {
        return { status: "indeterminate", reason: "solana-spl-settlement-store-intent-mismatch" };
      }
    } catch {
      return { status: "indeterminate", reason: "solana-spl-settlement-store-intent-invalid" };
    }
    if (status === "settled") {
      const settlement = claim.settlement;
      if (typeof settlement !== "object" || settlement === null) return invalid;
      return { status, settlement: settlement as Readonly<SolanaSplSettlementResult> };
    }
    const lease = claim.lease;
    const attempts = claim.attempts;
    const expiredSignatures = claim.expiredSignatures;
    const expiryEvidence = claim.expiryEvidence;
    if (typeof lease !== "object" || lease === null || !Array.isArray(attempts) ||
        !Array.isArray(expiredSignatures) ||
        (expiryEvidence !== undefined && !Array.isArray(expiryEvidence))) {
      return invalid;
    }
    if (status === "waiting") return { status, reason: "solana-spl-settlement-held" };
    const leaseFields = lease as Record<string, unknown>;
    return {
      status,
      lease: Object.freeze({
        owner: leaseFields.owner,
        generation: leaseFields.generation,
        expiresAt: leaseFields.expiresAt,
      }),
      attempts,
      expiredSignatures,
      expiryEvidence,
    };
  } catch {
    return invalid;
  }
}

/** A reconciliation result after validation; nothing else leaves `reconcile`. */
type ReconciledState =
  | { disposition: "settled-same"; settlement: Readonly<SolanaSplSettlementResult> | null }
  | { disposition: "settled-different" }
  | { disposition: "pending" }
  | { disposition: "absent-valid" }
  | { disposition: "absent-expired"; evidence: Readonly<SolanaSplExpiryEvidence> }
  | { disposition: "indeterminate"; reason: string };

/**
 * Validates an adapter's reconciliation result. A result that is not an
 * object, or whose disposition is unknown, is indeterminate, so it can never
 * fall through to a replacement signature.
 */
function readReconciliation(
  intent: Readonly<SolanaSplSettlementIntent>,
  attempt: Readonly<SolanaSplSignedAttempt>,
  value: unknown,
): ReconciledState {
  let result: Record<string, unknown>;
  let disposition: unknown;
  try {
    if (typeof value !== "object" || value === null) {
      throw new DacsError("pay-solana-spl: reconciliation must be an object");
    }
    result = value as Record<string, unknown>;
    disposition = result.disposition;
  } catch {
    return { disposition: "indeterminate", reason: "solana-spl-reconciliation-invalid" };
  }
  switch (disposition) {
    case "settled-same":
      try {
        return {
          disposition,
          settlement: settlementFrom(
            intent,
            attempt,
            result.transfer as Readonly<SolanaSplObservedTransfer>,
          ),
        };
      } catch {
        return { disposition, settlement: null };
      }
    case "absent-valid":
      try {
        const authenticationHash = result.authenticationHash;
        if (typeof authenticationHash === "string" && HASH_RE.test(authenticationHash)) {
          return { disposition };
        }
      } catch {
        // An unreadable proof is no proof.
      }
      return { disposition: "indeterminate", reason: "solana-spl-absence-proof-invalid" };
    case "absent-expired":
      try {
        return {
          disposition,
          evidence: captureExpiryEvidence({
            signature: attempt.signature,
            observedBlockHeight: result.observedBlockHeight,
            commitmentLevel: result.commitmentLevel,
            authenticationHash: result.authenticationHash,
          }, attempt),
        };
      } catch {
        return { disposition: "indeterminate", reason: "solana-spl-expiry-proof-invalid" };
      }
    // The adapter's own reasons may carry RPC detail; only fixed codes leave.
    case "settled-different":
    case "pending":
      return { disposition };
    case "indeterminate":
      return { disposition, reason: "solana-spl-reconciliation-indeterminate" };
    default:
      return { disposition: "indeterminate", reason: "solana-spl-reconciliation-invalid" };
  }
}

/**
 * Advances one `pay-solana-spl` phase by at most one signed transfer.
 *
 * Never rejects: every refusal, store or adapter failure, and out-of-contract
 * result is classified as a `SolanaSplProgress`. It reports `failed` only after
 * the store has proved that nothing earlier under this key can land, and a
 * landed transfer is never `failed`. A new transfer is signed only after the
 * latest retained attempt has authenticated, durably acknowledged expiry
 * evidence; a retained attempt is otherwise only rebroadcast byte-identically.
 *
 * `failed` is not terminal in the store. A caller that pays the phase another
 * way must first stop advancing this settlement key. See `SolanaSplProgress`
 * and `docs/pay-solana-spl.md` for the reason codes.
 */
export async function advanceSolanaSplSettlement(
  input: Readonly<AdvanceSolanaSplSettlementInput>,
): Promise<SolanaSplProgress> {
  // Until the store has been read, a retained broadcast or a settled phase
  // cannot be ruled out, so a refusal here is never reported as a failure.
  let intent: Readonly<SolanaSplSettlementIntent>;
  try {
    intent = createSolanaSplSettlementIntent({ ...input.authority });
  } catch {
    return { status: "indeterminate", reason: "solana-spl-authority-invalid" };
  }
  let store: SolanaSplSettlementStore;
  let adapter: SolanaSplAdapter;
  let now: () => number;
  try {
    store = input.store;
    adapter = input.adapter;
    now = input.now ?? Date.now;
  } catch {
    return { status: "indeterminate", reason: "solana-spl-dependencies-invalid" };
  }
  let owner: string;
  let leaseDurationMs: number;
  try {
    owner = requireString(input.owner, "owner");
    leaseDurationMs = positiveSafeInteger(
      input.leaseDurationMs ?? DEFAULT_LEASE_MS,
      "leaseDurationMs",
    );
  } catch {
    return { status: "indeterminate", reason: "solana-spl-runtime-policy-invalid" };
  }
  let claimSettlement: SolanaSplSettlementStore["claim"];
  let isCurrentSettlement: SolanaSplSettlementStore["isCurrent"];
  let recordAttempt: SolanaSplSettlementStore["recordAttempt"];
  let markAttemptExpired: SolanaSplSettlementStore["markAttemptExpired"];
  let recordSettlement: SolanaSplSettlementStore["recordSettlement"];
  let runPreflight: SolanaSplAdapter["preflight"];
  let prepareSignedTransfer: SolanaSplAdapter["prepareSignedTransfer"];
  let broadcastRetained: SolanaSplAdapter["broadcastRetained"];
  let reconcileTransfer: SolanaSplAdapter["reconcile"];
  try {
    // Bind every method before the claim, so a missing one cannot surface
    // after a lease is taken or a transfer is broadcast.
    claimSettlement = store.claim.bind(store);
    isCurrentSettlement = store.isCurrent.bind(store);
    recordAttempt = store.recordAttempt.bind(store);
    markAttemptExpired = store.markAttemptExpired.bind(store);
    recordSettlement = store.recordSettlement.bind(store);
    runPreflight = adapter.preflight.bind(adapter);
    prepareSignedTransfer = adapter.prepareSignedTransfer.bind(adapter);
    broadcastRetained = adapter.broadcastRetained.bind(adapter);
    reconcileTransfer = adapter.reconcile.bind(adapter);
  } catch {
    return { status: "indeterminate", reason: "solana-spl-dependencies-invalid" };
  }
  const readNow = (): number => clockValue(now());
  let stored: unknown;
  let claimNow: number;
  try {
    claimNow = readNow();
    stored = await claimSettlement({ intent, owner, now: claimNow, leaseDurationMs });
  } catch {
    return { status: "indeterminate", reason: "solana-spl-settlement-store-unavailable" };
  }
  const claimed = readClaim(stored, intent);
  if (claimed.status === "settled") {
    return storedSettlementMatchesIntent(claimed.settlement, intent)
      ? { status: "settled", settlement: claimed.settlement }
      : { status: "indeterminate", reason: "solana-spl-stored-settlement-mismatch" };
  }
  if (claimed.status !== "acquired") return claimed;
  const lease = claimed.lease;
  if (lease.owner !== owner ||
      typeof lease.generation !== "number" || !Number.isSafeInteger(lease.generation) ||
      lease.generation <= 0 ||
      typeof lease.expiresAt !== "number" || !Number.isSafeInteger(lease.expiresAt) ||
      lease.expiresAt <= claimNow) {
    return { status: "indeterminate", reason: "solana-spl-settlement-store-lease-invalid" };
  }
  const generation = lease.generation;
  let attempts: readonly Readonly<SolanaSplSignedAttempt>[];
  let expiredSignatures: readonly string[];
  let expiryEvidence: ReadonlyMap<string, Readonly<SolanaSplExpiryEvidence>>;
  try {
    attempts = captureRetainedAttempts(claimed.attempts, intent);
    const storedExpired = [...claimed.expiredSignatures];
    if (new Set(storedExpired).size !== storedExpired.length ||
        storedExpired.some((signature) =>
          !attempts.some((attempt) => attempt.signature === signature))) {
      throw new DacsError("pay-solana-spl: retained expiry set is invalid");
    }
    expiredSignatures = Object.freeze(storedExpired);
    expiryEvidence = captureRetainedExpiryEvidence(
      claimed.expiryEvidence,
      attempts,
      expiredSignatures,
    );
    if (attempts.slice(0, -1).some((attempt) => !expiryEvidence.has(attempt.signature))) {
      throw new DacsError("pay-solana-spl: predecessor expiry evidence is missing");
    }
  } catch {
    return { status: "indeterminate", reason: "solana-spl-retained-state-corrupt" };
  }
  const fence: SolanaSplEffectFence = Object.freeze({
    settlementKey: intent.settlementKey,
    bindingHash: intent.bindingHash,
    owner,
    generation,
    assertCurrent: async () => {
      // Only a literal `true` keeps the fence; anything else is stale.
      if (await isCurrentSettlement({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner,
        generation,
        now: readNow(),
      }) !== true) throw new DacsError("pay-solana-spl: stale effect fence");
    },
  });

  const reconcile = async (
    attempt: Readonly<SolanaSplSignedAttempt>,
  ): Promise<ReconciledState> => {
    let result: unknown;
    try {
      await fence.assertCurrent();
      result = await reconcileTransfer(intent, attempt, fence);
      await fence.assertCurrent();
    } catch {
      return { disposition: "indeterminate", reason: "solana-spl-reconciliation-unavailable" };
    }
    return readReconciliation(intent, attempt, result);
  };
  // Returns null only for the two absent dispositions, which the caller handles.
  const finalize = async (
    attempt: Readonly<SolanaSplSignedAttempt>,
    result: ReconciledState,
  ): Promise<SolanaSplProgress | null> => {
    // A retained signature landed in both settled dispositions: funds may have
    // moved, so neither is ever a failure a caller could pay again after.
    if (result.disposition === "settled-same") {
      const settlement = result.settlement;
      if (!settlement) {
        return { status: "indeterminate", reason: "solana-spl-settled-instruction-mismatch" };
      }
      // The transfer landed; an unreadable acknowledgement is still uncertain.
      try {
        const write = await recordSettlement({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          signature: attempt.signature,
          settlement,
        });
        const status = write.status;
        if (status === "recorded" || status === "existing") {
          return { status: "settled", settlement };
        }
      } catch {
        // Falls through to the uncertain result.
      }
      return { status: "indeterminate", reason: "solana-spl-settlement-persistence-uncertain" };
    }
    if (result.disposition === "settled-different") {
      return { status: "indeterminate", reason: "solana-spl-settled-different" };
    }
    if (result.disposition === "pending") {
      return { status: "waiting", reason: "solana-spl-reconciliation-pending" };
    }
    if (result.disposition === "indeterminate") return { status: "indeterminate", reason: result.reason };
    if (result.disposition === "absent-valid" || result.disposition === "absent-expired") {
      return null;
    }
    return { status: "indeterminate", reason: "solana-spl-reconciliation-invalid" };
  };
  // Returns null only when the store acknowledged exactly this evidence.
  const persistExpiry = async (
    attempt: Readonly<SolanaSplSignedAttempt>,
    evidence: Readonly<SolanaSplExpiryEvidence>,
  ): Promise<SolanaSplProgress | null> => {
    try {
      const marked = await markAttemptExpired({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        ...evidence,
      });
      const status = marked.status;
      if (status === "recorded" || status === "existing") {
        const acknowledged = marked.expiryEvidence;
        if (acknowledged &&
            canonicalize(captureExpiryEvidence(acknowledged, attempt)) ===
              canonicalize(evidence)) return null;
      }
    } catch {
      // An unavailable, unreadable or invalid acknowledgement cannot
      // authorize a replacement.
    }
    return { status: "indeterminate", reason: "solana-spl-expiry-persistence-uncertain" };
  };

  const latest = attempts.at(-1);
  if (latest && !expiryEvidence.has(latest.signature)) {
    const state = await reconcile(latest);
    const terminal = await finalize(latest, state);
    if (terminal) return terminal;
    if (state.disposition === "absent-valid") {
      try {
        await fence.assertCurrent();
        await broadcastRetained(latest, fence);
        await fence.assertCurrent();
      } catch {
        return { status: "indeterminate", reason: "solana-spl-rebroadcast-unavailable" };
      }
      const after = await reconcile(latest);
      const afterBroadcast = await finalize(latest, after);
      if (afterBroadcast) return afterBroadcast;
      if (after.disposition === "absent-valid") {
        return { status: "waiting", reason: "solana-spl-broadcast-not-yet-visible" };
      }
      if (after.disposition === "absent-expired") {
        const persistenceFailure = await persistExpiry(latest, after.evidence);
        if (persistenceFailure) return persistenceFailure;
      }
      return { status: "indeterminate", reason: "solana-spl-expiry-transition-raced" };
    }
    // The latest attempt can still land unless the chain proved it expired
    // and the store acknowledged exactly that proof; nothing else reaches
    // preflight.
    if (state.disposition !== "absent-expired") {
      return { status: "indeterminate", reason: "solana-spl-reconciliation-invalid" };
    }
    const persistenceFailure = await persistExpiry(latest, state.evidence);
    if (persistenceFailure) return persistenceFailure;
  }

  let preflight: Readonly<SolanaSplPreflight>;
  try {
    await fence.assertCurrent();
    preflight = await runPreflight(intent, fence);
    await fence.assertCurrent();
  } catch {
    return { status: "indeterminate", reason: "solana-spl-preflight-unavailable" };
  }
  const plan = validatePreflight(intent, preflight);
  if ("status" in plan) return plan;

  const attemptNumber = attempts.length + 1;
  // The signer's errors may carry key or wallet detail; only fixed codes leave.
  let prepared: Readonly<Omit<SolanaSplSignedAttempt, "attemptHash">>;
  try {
    await fence.assertCurrent();
    prepared = await prepareSignedTransfer(plan, attemptNumber, fence);
  } catch {
    return { status: "indeterminate", reason: "solana-spl-preparation-unavailable" };
  }
  let attempt: Readonly<SolanaSplSignedAttempt>;
  try {
    attempt = createAttempt(prepared, attemptNumber, intent);
  } catch {
    return { status: "indeterminate", reason: "solana-spl-prepared-transaction-invalid" };
  }
  try {
    await fence.assertCurrent();
  } catch {
    return { status: "indeterminate", reason: "solana-spl-preparation-unavailable" };
  }
  let retained: unknown;
  try {
    retained = (await recordAttempt({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner: fence.owner,
      generation: fence.generation,
      attempt,
    })).status;
  } catch {
    return { status: "indeterminate", reason: "solana-spl-retained-attempt-persistence-uncertain" };
  }
  if (retained !== "recorded" && retained !== "existing") {
    return { status: "indeterminate", reason: "solana-spl-retained-attempt-persistence-uncertain" };
  }
  try {
    await fence.assertCurrent();
    await broadcastRetained(attempt, fence);
    await fence.assertCurrent();
  } catch {
    return { status: "indeterminate", reason: "solana-spl-broadcast-unavailable" };
  }
  const state = await reconcile(attempt);
  const completed = await finalize(attempt, state);
  return completed ?? {
    status: state.disposition === "absent-valid" ? "waiting" : "indeterminate",
    reason: state.disposition === "absent-valid"
      ? "solana-spl-broadcast-not-yet-visible"
      : "solana-spl-new-attempt-expired-before-observation",
  };
}

interface MemoryRecord {
  intent: Readonly<SolanaSplSettlementIntent>;
  lease: SolanaSplLease;
  attempts: SolanaSplSignedAttempt[];
  expired: Map<string, Readonly<SolanaSplExpiryEvidence>>;
  settlement?: Readonly<SolanaSplSettlementResult>;
}

/** Test/development store. Production callers must persist encrypted signed bytes. */
export function createInMemorySolanaSplSettlementStore(): SolanaSplSettlementStore {
  const records = new Map<string, MemoryRecord>();
  const signatures = new Map<string, string>();
  const current = (
    record: MemoryRecord | undefined,
    input: { bindingHash: string; owner: string; generation: number },
  ): record is MemoryRecord => record !== undefined &&
    record.intent.bindingHash === input.bindingHash &&
    record.lease.owner === input.owner && record.lease.generation === input.generation;
  return {
    async claim(input) {
      const existing = records.get(input.intent.settlementKey);
      if (existing) {
        if (existing.intent.bindingHash !== input.intent.bindingHash) {
          return { status: "conflict", reason: "solana-spl-settlement-binding-conflict" };
        }
        if (existing.settlement) {
          return { status: "settled", intent: existing.intent, settlement: existing.settlement };
        }
        if (existing.lease.expiresAt > input.now) {
          return {
            status: "waiting",
            intent: existing.intent,
            lease: { ...existing.lease },
            attempts: existing.attempts.map((attempt) => Object.freeze({ ...attempt })),
            expiredSignatures: [...existing.expired.keys()],
            expiryEvidence: [...existing.expired.values()]
              .map((evidence) => Object.freeze({ ...evidence })),
          };
        }
        existing.lease = {
          owner: input.owner,
          generation: existing.lease.generation + 1,
          expiresAt: input.now + input.leaseDurationMs,
        };
        return {
          status: "acquired",
          intent: existing.intent,
          lease: { ...existing.lease },
          attempts: existing.attempts.map((attempt) => Object.freeze({ ...attempt })),
          expiredSignatures: [...existing.expired.keys()],
          expiryEvidence: [...existing.expired.values()]
            .map((evidence) => Object.freeze({ ...evidence })),
        };
      }
      const record: MemoryRecord = {
        intent: input.intent,
        lease: { owner: input.owner, generation: 1, expiresAt: input.now + input.leaseDurationMs },
        attempts: [],
        expired: new Map(),
      };
      records.set(input.intent.settlementKey, record);
      return {
        status: "acquired",
        intent: record.intent,
        lease: { ...record.lease },
        attempts: [],
        expiredSignatures: [],
        expiryEvidence: [],
      };
    },
    async isCurrent(input) {
      const record = records.get(input.settlementKey);
      return current(record, input) && record.lease.expiresAt > input.now && !record.settlement;
    },
    async recordAttempt(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      const owner = signatures.get(input.attempt.signature);
      if (owner && owner !== input.settlementKey) {
        return { status: "conflict", reason: "solana-signature-cross-settlement-reuse" };
      }
      const at = record.attempts[input.attempt.attempt - 1];
      if (at) {
        return at.attemptHash === input.attempt.attemptHash
          ? { status: "existing" }
          : { status: "conflict", reason: "solana-attempt-number-conflict" };
      }
      if (input.attempt.attempt !== record.attempts.length + 1) {
        return { status: "conflict", reason: "solana-attempt-sequence-gap" };
      }
      record.attempts.push(Object.freeze({ ...input.attempt }));
      signatures.set(input.attempt.signature, input.settlementKey);
      return { status: "recorded" };
    },
    async markAttemptExpired(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      const attempt = record.attempts.find(
        (retained) => retained.signature === input.signature,
      );
      if (!attempt) {
        return { status: "conflict", reason: "solana-expiry-proof-or-signature-invalid" };
      }
      let evidence: Readonly<SolanaSplExpiryEvidence>;
      try {
        evidence = captureExpiryEvidence(input, attempt);
      } catch {
        return { status: "conflict", reason: "solana-expiry-proof-or-signature-invalid" };
      }
      const prior = record.expired.get(input.signature);
      if (prior && canonicalize(prior) !== canonicalize(evidence)) {
        return { status: "conflict", reason: "solana-expiry-proof-conflict" };
      }
      record.expired.set(input.signature, evidence);
      return { status: prior ? "existing" : "recorded", expiryEvidence: evidence };
    },
    async recordSettlement(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (!record.attempts.some((attempt) => attempt.signature === input.signature)) {
        return { status: "conflict", reason: "solana-settlement-attempt-not-live" };
      }
      if (record.settlement) {
        return canonicalize(record.settlement) === canonicalize(input.settlement)
          ? { status: "existing" }
          : { status: "conflict", reason: "solana-settlement-conflict" };
      }
      record.settlement = Object.freeze({ ...input.settlement });
      return { status: "recorded" };
    },
  };
}
