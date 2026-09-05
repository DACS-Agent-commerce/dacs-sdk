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
  | { disposition: "absent-expired"; authenticationHash: string }
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
 * transaction and authenticate reconciliation against Solana ledger state.
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
    }
  | {
      status: "waiting";
      intent: Readonly<SolanaSplSettlementIntent>;
      lease: Readonly<SolanaSplLease>;
      attempts: readonly Readonly<SolanaSplSignedAttempt>[];
      expiredSignatures: readonly string[];
    }
  | {
      status: "settled";
      intent: Readonly<SolanaSplSettlementIntent>;
      settlement: Readonly<SolanaSplSettlementResult>;
    }
  | { status: "conflict" | "corrupt"; reason: string };

export type SolanaSplStoreWrite =
  | { status: "recorded" | "existing" }
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
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "solana-spl-preflight-invalid",
    };
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
  observed: Readonly<SolanaSplObservedTransfer>,
): Readonly<SolanaSplSettlementResult> | null {
  if (observed.cluster !== intent.cluster || observed.signature !== attempt.signature ||
      observed.instructionIndex !== attempt.transferInstructionIndex ||
      observed.standard !== "spl-transfer-checked" || observed.mint !== intent.mint ||
      observed.payer !== intent.payer || observed.payee !== intent.payee ||
      observed.amountBaseUnits !== intent.amountBaseUnits ||
      observed.tokenDecimals !== intent.tokenDecimals ||
      observed.commitmentLevel !== intent.commitmentLevel ||
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

export async function advanceSolanaSplSettlement(
  input: Readonly<AdvanceSolanaSplSettlementInput>,
): Promise<SolanaSplProgress> {
  let intent: Readonly<SolanaSplSettlementIntent>;
  try {
    intent = createSolanaSplSettlementIntent({ ...input.authority });
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "solana-spl-authority-invalid",
    };
  }
  const store = input.store;
  const adapter = input.adapter;
  const now = input.now ?? Date.now;
  let owner: string;
  let leaseDurationMs: number;
  try {
    owner = requireString(input.owner, "owner");
    leaseDurationMs = positiveSafeInteger(
      input.leaseDurationMs ?? DEFAULT_LEASE_MS,
      "leaseDurationMs",
    );
  } catch (error) {
    return {
      status: "failed",
      errorClass: "permanent",
      reason: error instanceof Error ? error.message : "solana-spl-runtime-policy-invalid",
    };
  }
  const claimSettlement = store.claim.bind(store);
  const isCurrentSettlement = store.isCurrent.bind(store);
  const recordAttempt = store.recordAttempt.bind(store);
  const markAttemptExpired = store.markAttemptExpired.bind(store);
  const recordSettlement = store.recordSettlement.bind(store);
  const runPreflight = adapter.preflight.bind(adapter);
  const prepareSignedTransfer = adapter.prepareSignedTransfer.bind(adapter);
  const broadcastRetained = adapter.broadcastRetained.bind(adapter);
  const reconcileTransfer = adapter.reconcile.bind(adapter);
  const readNow = (): number => clockValue(now());
  let claimed: SolanaSplStoreClaim;
  let claimNow: number;
  try {
    claimNow = readNow();
    claimed = await claimSettlement({ intent, owner, now: claimNow, leaseDurationMs });
  } catch {
    return { status: "indeterminate", reason: "solana-spl-settlement-store-unavailable" };
  }
  if ("intent" in claimed) {
    try {
      if (canonicalize(claimed.intent) !== canonicalize(intent)) {
        return { status: "indeterminate", reason: "solana-spl-settlement-store-intent-mismatch" };
      }
    } catch {
      return { status: "indeterminate", reason: "solana-spl-settlement-store-intent-invalid" };
    }
  }
  if (claimed.status === "waiting") {
    return { status: "waiting", reason: "solana-spl-settlement-held" };
  }
  if (claimed.status === "settled") {
    return storedSettlementMatchesIntent(claimed.settlement, intent)
      ? { status: "settled", settlement: claimed.settlement }
      : { status: "indeterminate", reason: "solana-spl-stored-settlement-mismatch" };
  }
  if (claimed.status !== "acquired") {
    return { status: "failed", errorClass: "permanent", reason: claimed.reason };
  }
  if (claimed.lease.owner !== owner ||
      !Number.isSafeInteger(claimed.lease.generation) || claimed.lease.generation <= 0 ||
      !Number.isSafeInteger(claimed.lease.expiresAt) || claimed.lease.expiresAt <= claimNow) {
    return { status: "indeterminate", reason: "solana-spl-settlement-store-lease-invalid" };
  }
  let attempts: readonly Readonly<SolanaSplSignedAttempt>[];
  let expiredSignatures: readonly string[];
  try {
    attempts = captureRetainedAttempts(claimed.attempts, intent);
    if (!Array.isArray(claimed.expiredSignatures) ||
        new Set(claimed.expiredSignatures).size !== claimed.expiredSignatures.length ||
        claimed.expiredSignatures.some((signature) =>
          !attempts.some((attempt) => attempt.signature === signature))) {
      throw new DacsError("pay-solana-spl: retained expiry set is invalid");
    }
    expiredSignatures = Object.freeze([...claimed.expiredSignatures]);
  } catch {
    return { status: "indeterminate", reason: "solana-spl-retained-state-corrupt" };
  }
  const fence: SolanaSplEffectFence = Object.freeze({
    settlementKey: intent.settlementKey,
    bindingHash: intent.bindingHash,
    owner: claimed.lease.owner,
    generation: claimed.lease.generation,
    assertCurrent: async () => {
      if (!await isCurrentSettlement({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: claimed.lease.owner,
        generation: claimed.lease.generation,
        now: readNow(),
      })) throw new DacsError("pay-solana-spl: stale effect fence");
    },
  });

  const reconcile = async (
    attempt: Readonly<SolanaSplSignedAttempt>,
  ): Promise<SolanaSplReconciliation> => {
    try {
      await fence.assertCurrent();
      const result = await reconcileTransfer(intent, attempt, fence);
      await fence.assertCurrent();
      if ((result.disposition === "absent-valid" ||
          result.disposition === "absent-expired") &&
          !HASH_RE.test(result.authenticationHash)) {
        return {
          disposition: "indeterminate",
          reason: "solana-spl-absence-proof-invalid",
        };
      }
      return result;
    } catch {
      return { disposition: "indeterminate", reason: "solana-spl-reconciliation-unavailable" };
    }
  };
  const finalize = async (
    attempt: Readonly<SolanaSplSignedAttempt>,
    result: SolanaSplReconciliation,
  ): Promise<SolanaSplProgress | null> => {
    if (result.disposition === "settled-same") {
      const settlement = settlementFrom(intent, attempt, result.transfer);
      if (!settlement) {
        return { status: "failed", errorClass: "permanent", reason: "solana-spl-settled-instruction-mismatch" };
      }
      let write: SolanaSplStoreWrite;
      try {
        write = await recordSettlement({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          signature: attempt.signature,
          settlement,
        });
      } catch {
        return { status: "indeterminate", reason: "solana-spl-settlement-persistence-uncertain" };
      }
      return write.status === "recorded" || write.status === "existing"
        ? { status: "settled", settlement }
        : { status: "indeterminate", reason: "solana-spl-settlement-persistence-uncertain" };
    }
    if (result.disposition === "settled-different") {
      return { status: "failed", errorClass: "permanent", reason: result.reason };
    }
    if (result.disposition === "pending") return { status: "waiting", reason: result.reason };
    if (result.disposition === "indeterminate") return { status: "indeterminate", reason: result.reason };
    return null;
  };

  let latest = attempts.at(-1);
  if (latest && !expiredSignatures.includes(latest.signature)) {
    let state = await reconcile(latest);
    const terminal = await finalize(latest, state);
    if (terminal) return terminal;
    if (state.disposition === "absent-valid") {
      if (!HASH_RE.test(state.authenticationHash)) {
        return { status: "indeterminate", reason: "solana-spl-absence-proof-invalid" };
      }
      try {
        await fence.assertCurrent();
        await broadcastRetained(latest, fence);
        await fence.assertCurrent();
      } catch {
        return { status: "indeterminate", reason: "solana-spl-rebroadcast-unavailable" };
      }
      state = await reconcile(latest);
      const afterBroadcast = await finalize(latest, state);
      return afterBroadcast ?? {
        status: state.disposition === "absent-valid" ? "waiting" : "indeterminate",
        reason: state.disposition === "absent-valid"
          ? "solana-spl-broadcast-not-yet-visible"
          : "solana-spl-expiry-transition-raced",
      };
    }
    if (state.disposition === "absent-expired") {
      if (!HASH_RE.test(state.authenticationHash)) {
        return { status: "indeterminate", reason: "solana-spl-expiry-proof-invalid" };
      }
      let marked: SolanaSplStoreWrite;
      try {
        marked = await markAttemptExpired({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          signature: latest.signature,
          authenticationHash: state.authenticationHash,
        });
      } catch {
        return { status: "indeterminate", reason: "solana-spl-expiry-persistence-uncertain" };
      }
      if (marked.status !== "recorded" && marked.status !== "existing") {
        return { status: "indeterminate", reason: "solana-spl-expiry-persistence-uncertain" };
      }
      latest = undefined;
    }
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
  let attempt: Readonly<SolanaSplSignedAttempt>;
  try {
    await fence.assertCurrent();
    attempt = createAttempt(
      await prepareSignedTransfer(plan, attemptNumber, fence),
      attemptNumber,
      intent,
    );
    await fence.assertCurrent();
  } catch (error) {
    return {
      status: "indeterminate",
      reason: error instanceof Error ? error.message : "solana-spl-preparation-unavailable",
    };
  }
  let retained: SolanaSplStoreWrite;
  try {
    retained = await recordAttempt({
      settlementKey: intent.settlementKey,
      bindingHash: intent.bindingHash,
      owner: fence.owner,
      generation: fence.generation,
      attempt,
    });
  } catch {
    return { status: "indeterminate", reason: "solana-spl-retained-attempt-persistence-uncertain" };
  }
  if (retained.status !== "recorded" && retained.status !== "existing") {
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
  expired: Map<string, string>;
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
      if (!HASH_RE.test(input.authenticationHash) ||
          !record.attempts.some((attempt) => attempt.signature === input.signature)) {
        return { status: "conflict", reason: "solana-expiry-proof-or-signature-invalid" };
      }
      const prior = record.expired.get(input.signature);
      if (prior && prior !== input.authenticationHash) {
        return { status: "conflict", reason: "solana-expiry-proof-conflict" };
      }
      record.expired.set(input.signature, input.authenticationHash);
      return { status: prior ? "existing" : "recorded" };
    },
    async recordSettlement(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (!record.attempts.some((attempt) => attempt.signature === input.signature) ||
          record.expired.has(input.signature)) {
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
