import { createHash } from "node:crypto";
import { types as nodeTypes } from "node:util";

import {
  assertPositiveAmount,
  baseUnits,
  canonicalize,
  sha256Hex,
} from "../canonical/index.js";
import { DacsError } from "../errors.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";

const DEFAULT_LEASE_MS = 30_000;
const HASH_RE = /^[0-9a-f]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
// SPL token amounts and lamport balances are `u64` on chain.
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// The associated token account program, and the one token program this rail
// pays through: SPL Token. Token-2022 is not supported: a transfer-fee mint
// credits the payee less than the instruction's amount, so the amount the
// core checks would not be the amount paid. Both are public program ids.
const ATA_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SPL_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ED25519_P = 2n ** 255n - 19n;
// The system program's key is 32 zero bytes; `AdvanceNonceAccount` is its
// instruction 4, a little-endian u32.
const ADVANCE_NONCE_ACCOUNT = [4, 0, 0, 0] as const;

export type SolanaCluster = "mainnet" | "devnet" | "testnet";
export type SolanaCommitmentLevel = "processed" | "confirmed" | "finalized";
/** Commitment levels from weakest to strongest. */
const COMMITMENT_LEVELS: readonly SolanaCommitmentLevel[] = ["processed", "confirmed", "finalized"];

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
  /**
   * The program that owns the mint account, as the same read reports it. The
   * core pays only SPL Token mints: any other owner, Token-2022 included, is
   * refused before a balance or account decides a failure.
   */
  mintTokenProgram: string;
  payerTokenAccount: string;
  payerTokenBalanceBaseUnits: string;
  payerNativeBalanceLamports: string;
  payeeAta: string;
  payeeAtaExists: boolean;
  payeeAtaOwner: string;
  payeeAtaMint: string;
  networkFeeLamports: string;
  ataRentExemptReserveLamports: string;
  /**
   * The rent-exempt minimum of the payer's system account: the fee payer must
   * end the transaction with zero lamports or at least this many.
   */
  payerRentExemptMinimumLamports: string;
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

/**
 * Proof that a retained transaction's blockhash expired without it landing.
 * Only `finalized` proof lets the core sign a replacement or close the key: a
 * rolled-back confirmed block could still let the attempt land. `confirmed`
 * appears only in records an earlier version wrote.
 */
export interface SolanaSplExpiryEvidence {
  signature: string;
  observedBlockHeight: number;
  commitmentLevel: "finalized" | "confirmed";
  authenticationHash: string;
}

/**
 * Proof that a retained transaction landed and the chain refused it (its
 * status carries an error): no instruction took effect, and the signature can
 * never land again. The adapter authenticates the error status from ledger
 * history, under the same trust boundary as finalized expiry evidence.
 */
export interface SolanaSplLandedFailureEvidence {
  signature: string;
  slot: number;
  commitmentLevel: "finalized";
  authenticationHash: string;
}

export interface SolanaSplObservedTransfer {
  cluster: SolanaCluster;
  signature: string;
  instructionIndex: number;
  /**
   * The decoded instruction at `instructionIndex`: an SPL Token
   * `TransferChecked`. This is not the DACS ledger-event `standard`, which
   * names an authenticated event `spl-transfer` for either SPL instruction; see
   * "Store and adapter contract" in `docs/pay-solana-spl.md`.
   */
  standard: "spl-transfer-checked";
  mint: string;
  payer: string;
  payee: string;
  amountBaseUnits: string;
  tokenDecimals: number;
  /** The level the transfer was observed at, which may exceed the intent's. */
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
  | {
      /** The retained transaction landed with an error status. */
      disposition: "landed-failed";
      slot: number;
      commitmentLevel: SolanaCommitmentLevel;
      authenticationHash: string;
    }
  | { disposition: "settled-different"; reason: string; authenticationHash: string }
  | { disposition: "indeterminate"; reason: string };

/**
 * Advisory only: the core never acts on a broadcast answer, because a
 * synchronous RPC answer is not ledger state. It reconciles instead.
 */
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
 * transaction and authenticate reconciliation against Solana ledger state. The
 * core checks the shape of chain observations, not their authenticity.
 * An absent-expired result must derive absence and block height from one coherent
 * view, report that view's commitment level (the core acts only on
 * `finalized`), and its authentication hash must bind the cluster,
 * signature, last-valid bound, observed height and commitment level. A
 * landed-failed result must come from the transaction's authenticated status
 * with a non-null error, and its hash must bind the cluster, signature, slot,
 * error and commitment level. A settled-same or landed-failed result reports
 * the commitment level actually observed.
 *
 * `prepareUnsignedTransfer` must only build a message: no signing or submission.
 * The core retains its exact message, expiry bound, plan and metadata before
 * `prepareSignedTransfer` is called. The signer must sign that retained message
 * with the same Ed25519 keys, deterministically, and must not submit it. Every
 * retry uses that same preparation, including after a timeout or lost lease.
 * It must sign a recent-blockhash transaction, never a
 * durable-nonce one: expiry evidence proves nothing about a nonce transaction,
 * which stays valid past its blockhash's last valid block height. The core
 * refuses, before retaining it, any transaction agave would treat as one.
 */
export interface SolanaSplAdapter {
  preflight(
    intent: Readonly<SolanaSplSettlementIntent>,
    fence: Readonly<SolanaSplEffectFence>,
  ): Promise<Readonly<SolanaSplPreflight>>;
  /** Build only: no signing or submission. The core retains this before signing. */
  prepareUnsignedTransfer(
    plan: Readonly<SolanaSplTransferPlan>,
    attempt: number,
    fence: Readonly<SolanaSplEffectFence>,
  ): Promise<Readonly<SolanaSplUnsignedTransfer>>;
  prepareSignedTransfer(
    plan: Readonly<SolanaSplTransferPlan>,
    attempt: number,
    fence: Readonly<SolanaSplEffectFence>,
    preparation?: Readonly<SolanaSplPreparation>,
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

/** Exact message and blockhash lifetime, obtained together before signing. */
export interface SolanaSplUnsignedTransfer {
  unsignedMessageBase64: string;
  lastValidBlockHeight: number;
  transferInstructionIndex: number;
  preparedAt: number;
}

/** Retained before signing; retrying it must produce the identical transaction. */
export interface SolanaSplPreparation {
  attempt: number;
  plan: Readonly<SolanaSplTransferPlan>;
  transaction: Readonly<SolanaSplUnsignedTransfer>;
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
      /** Exact unsigned message retained until recordAttempt succeeds. */
      preparation?: Readonly<SolanaSplPreparation>;
    }
  | {
      status: "waiting";
      intent: Readonly<SolanaSplSettlementIntent>;
      lease: Readonly<SolanaSplLease>;
      attempts: readonly Readonly<SolanaSplSignedAttempt>[];
      expiredSignatures: readonly string[];
      expiryEvidence?: readonly Readonly<SolanaSplExpiryEvidence>[];
      preparation?: Readonly<SolanaSplPreparation>;
    }
  | {
      status: "settled";
      intent: Readonly<SolanaSplSettlementIntent>;
      settlement: Readonly<SolanaSplSettlementResult>;
    }
  | {
      /** The key was closed by `recordFailure`; nothing under it is ever signed again. */
      status: "failed";
      intent: Readonly<SolanaSplSettlementIntent>;
      failure: Readonly<{ errorClass: "permanent" | "counterparty"; reason: string }>;
    }
  | { status: "conflict" | "corrupt"; reason: string };

export type SolanaSplStoreWrite =
  | {
      status: "recorded" | "existing";
      /** Required for markAttemptExpired: exact evidence durably retained. */
      expiryEvidence?: Readonly<SolanaSplExpiryEvidence>;
    }
  | { status: "stale" | "conflict" | "corrupt"; reason: string };

/**
 * Atomic durable retained-transaction store. Every result, and each object
 * nested in it, must be plain data with exactly its type's keys: see
 * "Store and adapter contract" in `docs/pay-solana-spl.md`.
 */
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
  /**
   * Atomically retains the next attempt's exact unsigned message, plan and
   * metadata for the current lease generation before the wallet signs.
   * Repeating identical data is `existing`; conflicting data is refused.
   * Claims expose the complete preparation until recordAttempt replaces it
   * atomically with the matching signed bytes. Failure closure is refused
   * while a preparation stands.
   * The exact unsigned message must also be reserved across settlement keys,
   * including messages in retained attempts. A cross-key collision is refused
   * without retaining a preparation or invoking the wallet, so a later call can
   * build with a fresh blockhash. This reservation is local coordination, not
   * settlement-side session-binding evidence.
   */
  recordPreparation(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    attempt: number;
    preparation: Readonly<SolanaSplPreparation>;
  }): Promise<SolanaSplStoreWrite>;
  /**
   * Refuse signatures owned by another key. For an older colliding preparation,
   * atomically clear only that preparation when the supplied attempt matches it
   * exactly AND its complete signed bytes equal an attempt retained by the
   * owning key for the same cluster and transfer instruction. Keep that
   * signature's ownership and the owning attempt forever;
   * never record or settle the duplicate under this key. A signature-only
   * match, unknown owner, stale generation or mismatched preparation cannot
   * release anything. A later call may then reserve a different message.
   */
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
    commitmentLevel: "finalized";
    authenticationHash: string;
  }): Promise<SolanaSplStoreWrite>;
  /** Close only when every other attempt has finalized expiry or refusal evidence. */
  recordSettlement(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    signature: string;
    settlement: Readonly<SolanaSplSettlementResult>;
    /** Finalized refusals of other retained attempts, retained with settlement. */
    landedFailures?: readonly Readonly<SolanaSplLandedFailureEvidence>[];
  }): Promise<SolanaSplStoreWrite>;
  /**
   * Closes the key with a terminal failure, in one atomic write that succeeds
   * only for the current lease generation and only while every retained
   * attempt has `finalized` expiry or authenticated refusal evidence and no
   * preparation stands. The adapter authenticates ledger evidence.
   * From then on `claim` returns the `failed` claim with exactly this failure,
   * and every other write for the key is
   * refused.
   */
  recordFailure(input: {
    settlementKey: string;
    bindingHash: string;
    owner: string;
    generation: number;
    failure: Readonly<{ errorClass: "permanent" | "counterparty"; reason: string }>;
    landedFailure?: Readonly<SolanaSplLandedFailureEvidence>;
    landedFailures?: readonly Readonly<SolanaSplLandedFailureEvidence>[];
  }): Promise<SolanaSplStoreWrite>;
}

/**
 * The result of one `advanceSolanaSplSettlement` call. `reason` is always a
 * fixed `solana-spl-*` code; it never carries adapter, RPC, store or caller
 * text.
 *
 * - `settled`: the exact transfer reached at least the intent's commitment
 *   and the store recorded it.
 * - `waiting`: try the same authority again later. It never authorizes a
 *   fresh payment.
 * - `indeterminate`: the phase may or may not be paid. A transfer may have
 *   landed or may still land. It never authorizes a fresh payment; resolve it
 *   by resuming the same authority or out of band.
 * - `transient`: a preflight read or unsigned build failed before signing. This
 *   call left no transaction able to land, and every retained attempt had durable,
 *   `finalized` expiry evidence, so nothing under the key can land. The key
 *   stays open: retry the same authority. It never authorizes paying the
 *   phase another way.
 * - `failed`: nothing under this settlement key moved tokens or can land.
 *   Every retained attempt has finalized expiry or chain-refusal evidence.
 *   The store closed the key before
 *   this was reported. Every later call with the same authority returns the
 *   same result without signing or broadcasting, so the phase may be paid
 *   another way. A retry after a top-up needs a new phase, and so a new key.
 */
export type SolanaSplProgress =
  | { status: "waiting" | "indeterminate" | "transient"; reason: string }
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
  const decoded = base58Value(parsed);
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

function base58Value(parsed: string): bigint {
  let decoded = 0n;
  for (const character of parsed) {
    decoded = decoded * 58n + BigInt(BASE58_ALPHABET.indexOf(character));
  }
  return decoded;
}

/** The bytes of a Base58 value already checked to decode to `expectedBytes`. */
function base58Bytes(parsed: string, expectedBytes: number): Uint8Array {
  const bytes = new Uint8Array(expectedBytes);
  let cursor = base58Value(parsed);
  for (let index = expectedBytes - 1; cursor > 0n; index -= 1) {
    bytes[index] = Number(cursor & 0xffn);
    cursor >>= 8n;
  }
  return bytes;
}

/**
 * The first signature of a wire transaction: a compact-u16 signature count,
 * then that many 64-byte signatures. Null when the bytes cannot hold them.
 */
function firstSignature(transaction: Uint8Array): Uint8Array | null {
  const read = readCompactU16(transaction, 0);
  if (read === null) return null;
  const [count, offset] = read;
  if (count < 1 || offset + 64 * count > transaction.length) return null;
  return transaction.subarray(offset, offset + 64);
}

/**
 * A compact-u16 at `offset`: its value and the offset after it, or null for
 * bytes solana-short-vec 3.3.0 refuses. Seven bits a byte, low bits first, at
 * most three bytes; a zero byte after the first is an alias of a shorter
 * encoding, and a third byte above 3 does not fit in 16 bits.
 */
function readCompactU16(bytes: Uint8Array, offset: number): [number, number] | null {
  let value = 0;
  for (let index = 0; index < 3; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined || (index > 0 && byte === 0) || (index === 2 && byte > 3)) return null;
    value |= (byte & 0x7f) << (7 * index);
    if ((byte & 0x80) === 0) return [value, offset + index + 1];
  }
  return null;
}

function compactU16(bytes: Uint8Array, offset: number): [number, number] {
  const read = readCompactU16(bytes, offset);
  if (read === null) throw new DacsError("pay-solana-spl: compact-u16 is truncated or not canonical");
  return read;
}

/**
 * Whether a wire transaction may be a durable-nonce transaction: the message's
 * first instruction calls the system program with `AdvanceNonceAccount` data,
 * trailing bytes allowed. agave's rule (`get_durable_nonce`) also requires
 * that instruction's first account to be writable; this check ignores the
 * accounts, so it refuses every transaction agave treats as one, and a few
 * more. Throws for bytes that are not a legacy or v0 message through that
 * instruction. Expiry evidence proves nothing about a nonce transaction, which
 * stays valid past its blockhash's last valid block height.
 */
function isDurableNonceTransaction(transaction: Uint8Array): boolean {
  const invalid = () => new DacsError("pay-solana-spl: signed transaction message is malformed");
  const [signatures, afterSignatures] = compactU16(transaction, 0);
  let offset = afterSignatures + 64 * signatures;
  const prefix = transaction[offset];
  if (prefix === undefined) throw invalid();
  // A versioned message starts with 0x80 | version. agave accepts v0, and v1
  // only once SIMD-0385 is active; anything but v0 is refused.
  if ((prefix & 0x80) !== 0) {
    if (prefix !== 0x80) throw invalid();
    offset += 1;
  }
  // Three header bytes, the static account keys, then the recent blockhash.
  const [keys, keysAt] = compactU16(transaction, offset + 3);
  const [instructions, instructionAt] = compactU16(transaction, keysAt + 32 * keys + 32);
  if (instructions === 0) return false;
  const programIndex = transaction[instructionAt];
  if (programIndex === undefined || programIndex >= keys) throw invalid();
  const [accounts, accountsAt] = compactU16(transaction, instructionAt + 1);
  const [dataLength, dataAt] = compactU16(transaction, accountsAt + accounts);
  if (dataAt + dataLength > transaction.length) throw invalid();
  const program = transaction.subarray(keysAt + 32 * programIndex, keysAt + 32 * (programIndex + 1));
  return program.every((byte) => byte === 0) && dataLength >= ADVANCE_NONCE_ACCOUNT.length &&
    ADVANCE_NONCE_ACCOUNT.every((byte, index) => transaction[dataAt + index] === byte);
}

function uint(value: unknown, label: string): bigint {
  // Only a string: an object could print as one amount and convert to another.
  if (typeof value !== "string" || !UINT_RE.test(value) || BigInt(value) > U64_MAX) {
    throw new DacsError(`pay-solana-spl: ${label} must be a canonical decimal u64`);
  }
  return BigInt(value);
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let factor = base % modulus;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if (rest & 1n) result = (result * factor) % modulus;
    factor = (factor * factor) % modulus;
  }
  return result;
}

/**
 * Whether 32 bytes decompress to an ed25519 point, decided as Solana's
 * `create_program_address` decides it (curve25519-dalek `decompress`): the
 * low 255 bits, little-endian, are y, and the point exists when
 * (y² − 1) / (d·y² + 1) is a square mod p, zero included.
 */
function isOnEd25519Curve(bytes: Uint8Array): boolean {
  const p = ED25519_P;
  let y = 0n;
  for (let index = 31; index >= 0; index -= 1) y = (y << 8n) | BigInt(bytes[index] as number);
  y = (y & ((1n << 255n) - 1n)) % p;
  const d = ((p - 121665n) * modPow(121666n, p - 2n, p)) % p;
  const y2 = (y * y) % p;
  const ratio = (((y2 + p - 1n) % p) * modPow((d * y2 + 1n) % p, p - 2n, p)) % p;
  return ratio === 0n || modPow(ratio, (p - 1n) / 2n, p) === 1n;
}

/**
 * Solana `find_program_address`: the first off-curve candidate from bump 255
 * down to 1. Bump 0 is never tried.
 */
function programAddress(seeds: readonly Uint8Array[], program: Uint8Array): Buffer {
  for (let bump = 255; bump >= 1; bump -= 1) {
    const hash = createHash("sha256");
    for (const seed of seeds) hash.update(seed);
    const candidate = hash.update(Uint8Array.of(bump)).update(program)
      .update("ProgramDerivedAddress").digest();
    if (!isOnEd25519Curve(candidate)) return candidate;
  }
  throw new DacsError("pay-solana-spl: no program address");
}

/**
 * Whether `account` is the owner's associated token account for the mint
 * under SPL Token: the address the associated token account program derives
 * from the seeds owner, token program and mint. Each value must already be a
 * checked 32-byte Base58 key.
 */
function isAssociatedTokenAccount(account: string, owner: string, mint: string): boolean {
  return programAddress(
    [base58Bytes(owner, 32), base58Bytes(SPL_PROGRAM_ID, 32), base58Bytes(mint, 32)],
    base58Bytes(ATA_PROGRAM_ID, 32),
  ).equals(base58Bytes(account, 32));
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
  // CORE JID-1/JID-3: validated before it is hashed, and never repaired or
  // normalized. A canonical jobId is ASCII, so keys derived before the check
  // (which applied NFC) are unchanged for it.
  return sha256Hex(`dacs-solana-spl-settlement:v1:${canonicalize({
    jobId: requireCanonicalJobId(input.jobId, "pay-solana-spl: jobId"),
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
  if (!COMMITMENT_LEVELS.includes(commitmentLevel)) {
    throw new DacsError("pay-solana-spl: unsupported commitment level");
  }
  if (!["mainnet", "devnet", "testnet"].includes(authority.cluster)) {
    throw new DacsError("pay-solana-spl: unsupported cluster");
  }
  const amount = assertPositiveAmount(authority.amount);
  const amountBaseUnits = baseUnits(amount, authority.tokenDecimals);
  // TransferChecked carries a u64 amount; a larger one cannot be encoded.
  if (BigInt(amountBaseUnits) > U64_MAX) {
    throw new DacsError("pay-solana-spl: amount exceeds the SPL u64 range");
  }
  const unsigned = {
    intentVersion: "1" as const,
    settlementKey: solanaSplSettlementKey(authority),
    jobId: requireCanonicalJobId(authority.jobId, "pay-solana-spl: jobId"),
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
  value: Readonly<SolanaSplPreflight>,
): SolanaSplTransferPlan | SolanaSplProgress {
  try {
    // Read each field once, so what is checked is what is planned.
    const preflight: SolanaSplPreflight = {
      mintTokenProgram: value.mintTokenProgram,
      payerTokenAccount: value.payerTokenAccount,
      payerTokenBalanceBaseUnits: value.payerTokenBalanceBaseUnits,
      payerNativeBalanceLamports: value.payerNativeBalanceLamports,
      payeeAta: value.payeeAta,
      payeeAtaExists: value.payeeAtaExists,
      payeeAtaOwner: value.payeeAtaOwner,
      payeeAtaMint: value.payeeAtaMint,
      networkFeeLamports: value.networkFeeLamports,
      ataRentExemptReserveLamports: value.ataRentExemptReserveLamports,
      payerRentExemptMinimumLamports: value.payerRentExemptMinimumLamports,
    };
    // Every account and balance below is read under SPL Token. For a mint
    // another program owns, refuse that unsupported rail permanently rather
    // than attributing a missing SPL account to either participant.
    requireBase58Bytes(preflight.mintTokenProgram, "mintTokenProgram", 32);
    if (preflight.mintTokenProgram !== SPL_PROGRAM_ID) {
      return { status: "failed", errorClass: "permanent", reason: "solana-spl-mint-program-unsupported" };
    }
    requireBase58Bytes(preflight.payerTokenAccount, "payerTokenAccount", 32);
    requireBase58Bytes(preflight.payeeAta, "payeeAta", 32);
    if (typeof preflight.payeeAtaExists !== "boolean") {
      throw new DacsError("pay-solana-spl: payeeAtaExists must be a boolean");
    }
    // DACS-4 §9.5.3: the destination is the payee's associated token account.
    // The address is derived, not observed, so another one is the adapter's
    // fault, never a failure that closes the key.
    if (!isAssociatedTokenAccount(preflight.payeeAta, intent.payee, intent.mint)) {
      return { status: "indeterminate", reason: "solana-spl-payee-ata-not-associated" };
    }
    // An existing account's owner and mint decide a binding mismatch, which
    // closes the key, so only well-formed keys may reach that comparison.
    if (preflight.payeeAtaExists) {
      requireBase58Bytes(preflight.payeeAtaOwner, "payeeAtaOwner", 32);
      requireBase58Bytes(preflight.payeeAtaMint, "payeeAtaMint", 32);
    }
    const tokenBalance = uint(preflight.payerTokenBalanceBaseUnits, "payerTokenBalanceBaseUnits");
    const nativeBalance = uint(preflight.payerNativeBalanceLamports, "payerNativeBalanceLamports");
    const networkFee = uint(preflight.networkFeeLamports, "networkFeeLamports");
    const ataRent = uint(preflight.ataRentExemptReserveLamports, "ataRentExemptReserveLamports");
    const rentExemptMinimum = uint(
      preflight.payerRentExemptMinimumLamports,
      "payerRentExemptMinimumLamports",
    );
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
    const remaining = nativeBalance - requiredNative;
    const leftRentPaying = remaining > 0n && remaining < rentExemptMinimum;
    // A payer already below its minimum may stay there under agave's older
    // rent-state rules, but not once SIMD-0392 is active. The core cannot see
    // which applies, so it neither signs nor closes the key.
    if (leftRentPaying && nativeBalance < rentExemptMinimum) {
      return { status: "indeterminate", reason: "solana-spl-payer-rent-state-unknown" };
    }
    // The runtime refuses a rent-exempt fee payer left between zero and its
    // minimum, at the fee check or after execution, so such a transfer can
    // never succeed.
    if (remaining < 0n || leftRentPaying) {
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
    // A malformed answer, a payee account's owner or mint included, is an
    // adapter or RPC fault, not a chain refusal, so it is never a failure that
    // closes the key. The adapter's message may carry RPC or account detail;
    // never echo it.
    return { status: "indeterminate", reason: "solana-spl-preflight-invalid" };
  }
}

function createAttempt(
  prepared: Readonly<Omit<SolanaSplSignedAttempt, "attemptHash">>,
  expectedAttempt: number,
  intent: Readonly<SolanaSplSettlementIntent>,
): Readonly<SolanaSplSignedAttempt> {
  // Copy each field once, so what is checked is what is retained, hashed and
  // broadcast. Only these fields are kept, so every attempt the core retains
  // has exactly the keys a retained attempt is later required to have.
  const value = {
    attemptVersion: prepared.attemptVersion,
    attempt: prepared.attempt,
    authorityHash: prepared.authorityHash,
    signature: prepared.signature,
    signedTransactionBase64: prepared.signedTransactionBase64,
    lastValidBlockHeight: prepared.lastValidBlockHeight,
    transferInstructionIndex: prepared.transferInstructionIndex,
    preparedAt: prepared.preparedAt,
  };
  if (value.attemptVersion !== "1" || value.attempt !== expectedAttempt ||
      value.authorityHash !== intent.bindingHash) {
    throw new DacsError("pay-solana-spl: prepared transaction authority mismatch");
  }
  const signature = requireBase58Bytes(value.signature, "signature", 64);
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
  // The bytes broadcast must be the transaction tracked: proof that another
  // signature expired must never authorize a replacement while these can land.
  const carried = firstSignature(decoded);
  if (carried === null || !Buffer.from(carried).equals(base58Bytes(signature, 64))) {
    throw new DacsError("pay-solana-spl: signed transaction does not carry the signature");
  }
  // Expiry evidence for these bytes may authorize a replacement, so they must
  // be a transaction that can never land after its blockhash expires.
  if (isDurableNonceTransaction(decoded)) {
    throw new DacsError("pay-solana-spl: signed transaction uses a durable nonce");
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
  return Object.freeze({
    ...value,
    attemptHash: sha256Hex(canonicalize(value)),
  });
}

/**
 * True for a non-null object that is not a proxy, checked without running any
 * trap. A proxy answers each read (`length`, own keys, each index) from its
 * own code, so its answers need not agree and nothing it reports proves what
 * the store holds. Every caller is inside a handled step, so a runtime without
 * `util.types.isProxy` fails closed.
 */
function isDataObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !nodeTypes.isProxy(value);
}

/**
 * The value of an own, enumerable data property, read once from its
 * descriptor, so no getter runs. A missing, inherited, non-enumerable or
 * accessor property throws.
 */
function ownDataValue(value: object, key: string, label: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (field === undefined || !Object.hasOwn(field, "value") || !field.enumerable) {
    throw new DacsError(`pay-solana-spl: ${label} ${key} must be an own data property`);
  }
  return field.value;
}

const ATTEMPT_KEYS = [
  "attemptVersion", "attempt", "authorityHash", "signature", "signedTransactionBase64",
  "lastValidBlockHeight", "transferInstructionIndex", "preparedAt", "attemptHash",
] as const;
const EVIDENCE_KEYS = [
  "signature", "observedBlockHeight", "commitmentLevel", "authenticationHash",
] as const;
const LEASE_KEYS = ["owner", "generation", "expiresAt"] as const;
/** Each `failed` reason and its class: the only failures a store may hold. */
const FAILURES: ReadonlyMap<string, "permanent" | "counterparty"> = new Map([
  ["solana-spl-insufficient-token-balance", "permanent"],
  ["solana-spl-insufficient-network-fee-balance", "permanent"],
  ["solana-spl-insufficient-ata-rent-and-fee-balance", "permanent"],
  ["solana-spl-payee-ata-missing", "counterparty"],
  ["solana-spl-payee-ata-binding-mismatch", "counterparty"],
  ["solana-spl-transfer-failed-on-chain", "permanent"],
  ["solana-spl-mint-program-unsupported", "permanent"],
]);
/**
 * Checks a landed-failure proof for a retained attempt. Returns null for a
 * well-formed proof below `finalized`, which a fork could still roll back,
 * and throws for a malformed one.
 */
function captureLandedFailure(
  value: Readonly<{
    signature: unknown;
    slot: unknown;
    commitmentLevel: unknown;
    authenticationHash: unknown;
  }>,
  attempt: Readonly<SolanaSplSignedAttempt>,
): Readonly<SolanaSplLandedFailureEvidence> | null {
  if (value.signature !== attempt.signature) {
    throw new DacsError("pay-solana-spl: landed failure signature mismatch");
  }
  if (typeof value.slot !== "number" || !Number.isSafeInteger(value.slot) || value.slot < 0 ||
      typeof value.authenticationHash !== "string" ||
      !HASH_RE.test(value.authenticationHash) ||
      !COMMITMENT_LEVELS.includes(value.commitmentLevel as SolanaCommitmentLevel)) {
    throw new DacsError("pay-solana-spl: landed failure proof is invalid");
  }
  if (value.commitmentLevel !== "finalized") return null;
  return Object.freeze({
    signature: attempt.signature,
    slot: value.slot,
    commitmentLevel: value.commitmentLevel,
    authenticationHash: value.authenticationHash,
  });
}

/**
 * Captures a store object as plain data: the one meaning of "plain data" for
 * every store result the core relies on. The object must not be a proxy, its
 * prototype must be `Object.prototype` or null, and its own keys must be
 * exactly `required` plus any of `optional`: no symbol, extra or missing key.
 * Each must be an own, enumerable data property. Each value is read once from
 * its descriptor into a fresh object, which is the only thing checked and used
 * afterwards. A proxy is refused before any trap runs, and no getter runs. A
 * host object that is not a proxy, such as a `vm` context global, can still
 * run native interceptors while its keys are listed (for a proxy sandbox, its
 * `ownKeys` and descriptor traps); their answers are never used, because such
 * an object is refused.
 */
function plainData(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
  anyKey = false,
): Readonly<Record<string, unknown>> {
  if (!isDataObject(value)) {
    throw new DacsError(`pay-solana-spl: ${label} must be plain data`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DacsError(`pay-solana-spl: ${label} must be plain data`);
  }
  const keys = Reflect.ownKeys(value);
  const snapshot: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" ||
        (!anyKey && !required.includes(key) && !optional.includes(key))) {
      throw new DacsError(`pay-solana-spl: ${label} has an unexpected key`);
    }
    snapshot[key] = ownDataValue(value, key, label);
  }
  return anyKey
    ? Object.freeze(snapshot)
    : exactKeys(Object.freeze(snapshot), label, required, optional);
}

/** Throws unless a snapshot has every `required` key and no key outside `optional`. */
function exactKeys(
  snapshot: Readonly<Record<string, unknown>>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  if (required.some((key) => !Object.hasOwn(snapshot, key)) ||
      Object.keys(snapshot).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new DacsError(`pay-solana-spl: ${label} must have exactly its keys`);
  }
  return snapshot;
}

/**
 * Reads a store array once into a fresh array. Element n must be an own,
 * enumerable data property at index n, and the array has no other own keys. A
 * proxy is refused before any of its traps runs. A hole, an inherited index,
 * an accessor or a length that disagrees with the own keys could hide a
 * retained attempt or its expiry record, so each throws.
 */
function ownElements(values: unknown, label: string): unknown[] {
  if (!isDataObject(values) || !Array.isArray(values)) {
    throw new DacsError(`pay-solana-spl: ${label} must be a plain array`);
  }
  const length = values.length;
  if (!Number.isSafeInteger(length) || length < 0 ||
      Reflect.ownKeys(values).length !== length + 1) {
    throw new DacsError(`pay-solana-spl: ${label} must be a dense array`);
  }
  const elements: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    elements.push(ownDataValue(values, String(index), label));
  }
  return elements;
}

/** Snapshot nested legacy metadata before canonicalization, without executing it. */
function captureJson(value: unknown, ancestors = new Set<object>(), depth = 0): unknown {
  if (value === null || value === undefined ||
      ["string", "number", "boolean"].includes(typeof value)) return value;
  if (!isDataObject(value) || ancestors.has(value) || depth >= 128) {
    throw new DacsError("pay-solana-spl: metadata must be plain JSON");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new DacsError("pay-solana-spl: metadata must be plain JSON");
      }
      return ownElements(value, "metadata").map((entry) => captureJson(entry, ancestors, depth + 1));
    }
    const snapshot = plainData(value, "metadata", [], [], true);
    return Object.fromEntries(Object.entries(snapshot)
      .map(([key, entry]) => [key, captureJson(entry, ancestors, depth + 1)]));
  } finally {
    ancestors.delete(value);
  }
}

function capturePreparation(
  value: unknown,
  intent: Readonly<SolanaSplSettlementIntent>,
): Readonly<SolanaSplPreparation> {
  const row = plainData(value, "preparation", ["attempt", "plan", "transaction"]);
  if (typeof row.attempt !== "number") {
    throw new DacsError("pay-solana-spl: invalid preparation number");
  }
  positiveSafeInteger(row.attempt, "preparation attempt");
  const plan = plainData(row.plan, "preparation plan", [
    "intent", "payerTokenAccount", "payeeAta", "createPayeeAta",
    "payerFundsAtaRentLamports", "instruction",
  ]);
  const storedIntent = plainData(plan.intent, "preparation intent", Object.keys(intent));
  if (canonicalize(captureJson(storedIntent)) !== canonicalize(intent) || plan.instruction !== "TransferChecked" ||
      typeof plan.createPayeeAta !== "boolean") {
    throw new DacsError("pay-solana-spl: invalid preparation plan");
  }
  requireBase58Bytes(plan.payerTokenAccount, "payerTokenAccount", 32);
  requireBase58Bytes(plan.payeeAta, "payeeAta", 32);
  uint(plan.payerFundsAtaRentLamports, "payerFundsAtaRentLamports");
  if (!isAssociatedTokenAccount(plan.payeeAta as string, intent.payee, intent.mint) ||
      (plan.createPayeeAta && !intent.createPayeeAtaIfMissing)) {
    throw new DacsError("pay-solana-spl: invalid preparation destination");
  }
  const transaction = plainData(row.transaction, "unsigned transfer", [
    "unsignedMessageBase64", "lastValidBlockHeight", "transferInstructionIndex", "preparedAt",
  ]);
  const message = requireString(transaction.unsignedMessageBase64, "unsigned message");
  const bytes = Buffer.from(message, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== message ||
      isDurableNonceTransaction(Buffer.concat([Buffer.from([1]), Buffer.alloc(64), bytes]))) {
    throw new DacsError("pay-solana-spl: invalid unsigned message");
  }
  for (const key of ["lastValidBlockHeight", "transferInstructionIndex", "preparedAt"]) {
    const field = transaction[key];
    if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
      throw new DacsError("pay-solana-spl: invalid unsigned metadata");
    }
  }
  return Object.freeze({
    attempt: row.attempt,
    plan: Object.freeze({ ...plan, intent }) as unknown as Readonly<SolanaSplTransferPlan>,
    transaction: Object.freeze({ ...transaction }) as unknown as Readonly<SolanaSplUnsignedTransfer>,
  });
}

function assertPreparedMessage(
  attempt: Readonly<SolanaSplSignedAttempt>,
  preparation: Readonly<SolanaSplPreparation>,
): void {
  const bytes = Buffer.from(attempt.signedTransactionBase64, "base64");
  const [count, offset] = compactU16(bytes, 0);
  const transaction = preparation.transaction;
  if (attempt.attempt !== preparation.attempt ||
      bytes.subarray(offset + count * 64).toString("base64") !== transaction.unsignedMessageBase64 ||
      attempt.lastValidBlockHeight !== transaction.lastValidBlockHeight ||
      attempt.transferInstructionIndex !== transaction.transferInstructionIndex || attempt.preparedAt !== transaction.preparedAt) {
    throw new DacsError("pay-solana-spl: signed transfer differs from preparation");
  }
}

function captureRetainedAttempts(
  values: unknown,
  intent: Readonly<SolanaSplSettlementIntent>,
): readonly Readonly<SolanaSplSignedAttempt>[] {
  // Attempt n is the element at index n - 1, so the latest retained attempt
  // is always the last element and can never be hidden.
  const elements = ownElements(values, "retained attempts");
  const signatures = new Set<string>();
  const retained: Readonly<SolanaSplSignedAttempt>[] = [];
  for (let index = 0; index < elements.length; index += 1) {
    // Only the snapshot is validated, hashed and used: a getter could
    // otherwise answer the integrity check with one row and the use with
    // another.
    const row = plainData(elements[index], "retained attempt", ATTEMPT_KEYS, [], true);
    const captured = createAttempt(
      row as unknown as Readonly<Omit<SolanaSplSignedAttempt, "attemptHash">>,
      index + 1,
      intent,
    );
    if (Object.keys(row).some((key) => !ATTEMPT_KEYS.includes(key as never))) {
      // An earlier version hashed every field an adapter returned, so a row
      // with extra keys is read only if that whole-row hash still verifies.
      // `createAttempt` kept just the nine typed fields, which is all that is
      // used from here on; the extras are dropped, never passed on.
      if (ATTEMPT_KEYS.some((key) => !Object.hasOwn(row, key))) {
        throw new DacsError("pay-solana-spl: retained attempt must have exactly its keys");
      }
      const { attemptHash: stored, ...unsigned } = row;
      if (stored !== sha256Hex(canonicalize(captureJson(unsigned)))) {
        throw new DacsError("pay-solana-spl: retained attempt integrity mismatch");
      }
    } else if (captured.attemptHash !== row.attemptHash) {
      throw new DacsError("pay-solana-spl: retained attempt integrity mismatch");
    }
    if (signatures.has(captured.signature)) {
      throw new DacsError("pay-solana-spl: retained signature is duplicated");
    }
    signatures.add(captured.signature);
    retained.push(captured);
  }
  return Object.freeze(retained);
}

/**
 * Checks expiry evidence for a retained attempt. Returns null for well-formed
 * evidence below `finalized`, which a rolled-back block could still undo, and
 * throws for malformed evidence. With `retained`, `confirmed` evidence an
 * earlier version stored is captured too; the caller decides what it allows.
 */
function captureExpiryEvidence(
  value: Readonly<{
    signature: unknown;
    observedBlockHeight: unknown;
    commitmentLevel: unknown;
    authenticationHash: unknown;
  }>,
  attempt: Readonly<SolanaSplSignedAttempt>,
  retained = false,
): Readonly<SolanaSplExpiryEvidence> | null {
  if (value.signature !== attempt.signature) {
    throw new DacsError("pay-solana-spl: expiry evidence signature mismatch");
  }
  if (typeof value.observedBlockHeight !== "number" ||
      !Number.isSafeInteger(value.observedBlockHeight) ||
      value.observedBlockHeight < 0 ||
      value.observedBlockHeight <= attempt.lastValidBlockHeight) {
    throw new DacsError("pay-solana-spl: expiry evidence block height is invalid");
  }
  if (!COMMITMENT_LEVELS.includes(value.commitmentLevel as SolanaCommitmentLevel)) {
    throw new DacsError("pay-solana-spl: expiry evidence commitment level is invalid");
  }
  if (typeof value.authenticationHash !== "string" ||
      !HASH_RE.test(value.authenticationHash)) {
    throw new DacsError("pay-solana-spl: expiry evidence authentication hash is invalid");
  }
  if (value.commitmentLevel !== "finalized" &&
      !(retained && value.commitmentLevel === "confirmed")) {
    return null;
  }
  return Object.freeze({
    signature: attempt.signature,
    observedBlockHeight: value.observedBlockHeight,
    commitmentLevel: value.commitmentLevel as SolanaSplExpiryEvidence["commitmentLevel"],
    authenticationHash: value.authenticationHash,
  });
}

function captureRetainedExpiryEvidence(
  values: unknown,
  attempts: readonly Readonly<SolanaSplSignedAttempt>[],
  expiredSignatures: readonly string[],
): ReadonlyMap<string, Readonly<SolanaSplExpiryEvidence>> {
  if (values === undefined) return new Map();
  const captured = new Map<string, Readonly<SolanaSplExpiryEvidence>>();
  for (const value of ownElements(values, "retained expiry evidence")) {
    const candidate = plainData(value, "retained expiry evidence", EVIDENCE_KEYS);
    const attempt = attempts.find((retained) => retained.signature === candidate.signature);
    if (!attempt || !expiredSignatures.includes(attempt.signature) ||
        captured.has(attempt.signature)) {
      throw new DacsError("pay-solana-spl: retained expiry evidence is inconsistent");
    }
    const evidence = captureExpiryEvidence(
      candidate as Readonly<SolanaSplExpiryEvidence>,
      attempt,
      true,
    );
    if (!evidence) throw new DacsError("pay-solana-spl: retained expiry evidence is inconsistent");
    captured.set(attempt.signature, evidence);
  }
  return captured;
}

/**
 * A store write result as a plain-data snapshot. A successful write has only
 * `status` and an optional `expiryEvidence`; any other has `status` and
 * `reason`. Anything else throws, so it never counts as a success.
 */
function storeWrite(value: unknown): Readonly<Record<string, unknown>> {
  const write = plainData(value, "store write", ["status"], ["expiryEvidence", "reason"]);
  return write.status === "recorded" || write.status === "existing"
    ? exactKeys(write, "store write", ["status"], ["expiryEvidence"])
    : exactKeys(write, "store write", ["status", "reason"]);
}

/**
 * Copies a stored settlement into fresh frozen plain data, then checks the
 * copy against the intent. The settlement and each nested object are captured
 * by `plainData`, so a store accessor, `toJSON` hook or extra field never
 * reaches the caller. Returns null when any of them is not plain data with
 * exactly its keys, or a field is invalid.
 */
function captureStoredSettlement(
  value: unknown,
  intent: Readonly<SolanaSplSettlementIntent>,
): Readonly<SolanaSplSettlementResult> | null {
  try {
    const settlement = plainData(value, "stored settlement",
      ["txRef", "paymentAmount", "settlementFinality", "authenticationHash"]);
    const txRef = plainData(settlement.txRef, "stored txRef",
      ["kind", "cluster", "signature", "instructionIndex"]);
    const paymentAmount = plainData(settlement.paymentAmount, "stored paymentAmount",
      ["amount", "currency"]);
    const finality = plainData(settlement.settlementFinality, "stored settlementFinality",
      ["model", "finalityCommitmentLevel", "finalityObservedAt"]);
    const stored = {
      kind: txRef.kind,
      cluster: txRef.cluster,
      signature: txRef.signature,
      instructionIndex: txRef.instructionIndex,
      amount: paymentAmount.amount,
      currency: paymentAmount.currency,
      model: finality.model,
      finalityCommitmentLevel: finality.finalityCommitmentLevel,
      finalityObservedAt: finality.finalityObservedAt,
      authenticationHash: settlement.authenticationHash,
    };
    const signature = requireBase58Bytes(stored.signature, "stored signature", 64);
    const { instructionIndex, finalityObservedAt, authenticationHash } = stored;
    if (stored.kind !== "solana-instruction" || stored.cluster !== intent.cluster ||
        typeof instructionIndex !== "number" || !Number.isSafeInteger(instructionIndex) ||
        instructionIndex < 0 ||
        stored.amount !== intent.amount || stored.currency !== intent.assetSymbol ||
        stored.model !== "commitment-level" ||
        stored.finalityCommitmentLevel !== intent.commitmentLevel ||
        typeof finalityObservedAt !== "number" || !Number.isSafeInteger(finalityObservedAt) ||
        finalityObservedAt < 0 ||
        typeof authenticationHash !== "string" || !HASH_RE.test(authenticationHash)) {
      return null;
    }
    return Object.freeze({
      txRef: Object.freeze({
        kind: "solana-instruction" as const,
        cluster: intent.cluster,
        signature,
        instructionIndex,
      }),
      paymentAmount: Object.freeze({ amount: intent.amount, currency: intent.assetSymbol }),
      settlementFinality: Object.freeze({
        model: "commitment-level" as const,
        finalityCommitmentLevel: intent.commitmentLevel,
        finalityObservedAt,
      }),
      authenticationHash,
    });
  } catch {
    return null;
  }
}

/**
 * The settlement an observed transfer proves, `pending` when it is exactly
 * the retained transfer but below the intent's commitment, or null when it is
 * not the retained transfer.
 */
function settlementFrom(
  intent: Readonly<SolanaSplSettlementIntent>,
  attempt: Readonly<SolanaSplSignedAttempt>,
  value: Readonly<SolanaSplObservedTransfer>,
): Readonly<SolanaSplSettlementResult> | "pending" | null {
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
      !COMMITMENT_LEVELS.includes(observed.commitmentLevel) ||
      typeof observed.authenticationHash !== "string" ||
      !HASH_RE.test(observed.authenticationHash) ||
      !Number.isSafeInteger(observed.finalityObservedAt) || observed.finalityObservedAt < 0) {
    return null;
  }
  // Commitment only strengthens, so a transfer observed above the intent's
  // level has reached it, as Solana's own confirmation treats it. The result
  // still records the intent's level: DACS-4 `SettlementFinalityRecord`
  // sources it from the rail parameter.
  if (COMMITMENT_LEVELS.indexOf(observed.commitmentLevel) <
      COMMITMENT_LEVELS.indexOf(intent.commitmentLevel)) {
    return "pending";
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

/**
 * A store claim after validation; every field was read exactly once. The
 * lease is a `plainData` snapshot with exactly `LEASE_KEYS`. A settlement is a
 * frozen copy already checked against the intent.
 */
type ClaimView =
  | {
      status: "acquired";
      lease: Readonly<Record<string, unknown>>;
      attempts: readonly Readonly<SolanaSplSignedAttempt>[];
      expiredSignatures: readonly string[];
      expiryEvidence: readonly Readonly<SolanaSplExpiryEvidence>[] | undefined;
      preparation: Readonly<SolanaSplPreparation> | undefined;
    }
  | { status: "settled"; settlement: Readonly<SolanaSplSettlementResult> };

/**
 * Parses a store claim as the complete discriminated union before anything
 * acts on it. A partial, malformed or unreadable claim is never trusted: it
 * could belong to another binding or hide a retained broadcast. The claim, its
 * intent, its lease and its failure are captured by `plainData` with exactly
 * their variant's keys before any field is used. A `failed` claim is returned
 * as the fixed failure it names, and only for a reason the core can report.
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
    const claim = plainData(value, "claim", ["status"], [
      "reason", "intent", "lease", "attempts", "expiredSignatures", "expiryEvidence", "settlement",
      "failure", "preparation",
    ]);
    const status = claim.status;
    // A conflicting binding for the same phase, or a corrupt record, may hold
    // a broadcast this call cannot inspect, so neither proves the phase unpaid.
    if (status === "conflict" || status === "corrupt") {
      exactKeys(claim, "claim", ["status", "reason"]);
      return {
        status: "indeterminate",
        reason: status === "conflict"
          ? "solana-spl-settlement-store-conflict"
          : "solana-spl-settlement-store-corrupt",
      };
    }
    if (status === "settled") {
      exactKeys(claim, "claim", ["status", "intent", "settlement"]);
    } else if (status === "failed") {
      exactKeys(claim, "claim", ["status", "intent", "failure"]);
    } else if (status === "acquired" || status === "waiting") {
      exactKeys(claim, "claim",
        ["status", "intent", "lease", "attempts", "expiredSignatures"],
        ["expiryEvidence", "preparation"]);
    } else {
      return invalid;
    }
    const storedIntent = plainData(claim.intent, "stored intent", Object.keys(intent));
    // Every intent field is a string, number or boolean; an object here could
    // only run store code while it is compared.
    if (Object.values(storedIntent).some((field) => typeof field === "object" && field !== null)) {
      return { status: "indeterminate", reason: "solana-spl-settlement-store-intent-invalid" };
    }
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
      // The store's object never leaves: only a checked copy is returned.
      const captured = captureStoredSettlement(settlement, intent);
      return captured
        ? { status, settlement: captured }
        : { status: "indeterminate", reason: "solana-spl-stored-settlement-mismatch" };
    }
    if (status === "failed") {
      // A closed key stays closed: the store's failure is returned without
      // touching the adapter, but only as a fixed failure the core reports.
      const failure = plainData(claim.failure, "stored failure", ["errorClass", "reason"]);
      const reason = failure.reason;
      const errorClass = typeof reason === "string" ? FAILURES.get(reason) : undefined;
      if (errorClass === undefined || failure.errorClass !== errorClass) return invalid;
      return { status: "failed", errorClass, reason: reason as string };
    }
    const lease = plainData(claim.lease, "lease", LEASE_KEYS);
    const attempts = claim.attempts;
    const expiredSignatures = claim.expiredSignatures;
    const expiryEvidence = claim.expiryEvidence;
    if (!Array.isArray(attempts) || !Array.isArray(expiredSignatures) ||
        (expiryEvidence !== undefined && !Array.isArray(expiryEvidence))) {
      return invalid;
    }
    if (status === "waiting") return { status, reason: "solana-spl-settlement-held" };
    const preparation = claim.preparation === undefined
      ? undefined : capturePreparation(claim.preparation, intent);
    return {
      status,
      lease,
      attempts,
      expiredSignatures,
      expiryEvidence,
      preparation,
    };
  } catch {
    return invalid;
  }
}

/** The only expiry evidence the core writes or acts on. */
type FinalizedExpiryEvidence = Readonly<SolanaSplExpiryEvidence & { commitmentLevel: "finalized" }>;

/** A reconciliation result after validation; nothing else leaves `reconcile`. */
type ReconciledState =
  | { disposition: "settled-same"; settlement: Readonly<SolanaSplSettlementResult> | null }
  | { disposition: "settled-different" }
  | { disposition: "pending" }
  | { disposition: "absent-valid" }
  | { disposition: "absent-expired"; evidence: FinalizedExpiryEvidence }
  | { disposition: "landed-failed"; evidence: Readonly<SolanaSplLandedFailureEvidence> }
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
        const settlement = settlementFrom(
          intent,
          attempt,
          result.transfer as Readonly<SolanaSplObservedTransfer>,
        );
        return settlement === "pending" ? { disposition: "pending" } : { disposition, settlement };
      } catch {
        return { disposition, settlement: null };
      }
    case "landed-failed":
      try {
        const evidence = captureLandedFailure({
          signature: attempt.signature,
          slot: result.slot,
          commitmentLevel: result.commitmentLevel,
          authenticationHash: result.authenticationHash,
        }, attempt);
        return evidence ? { disposition, evidence } : { disposition: "pending" };
      } catch {
        return { disposition: "indeterminate", reason: "solana-spl-landed-failure-proof-invalid" };
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
        const evidence = captureExpiryEvidence({
          signature: attempt.signature,
          observedBlockHeight: result.observedBlockHeight,
          commitmentLevel: result.commitmentLevel,
          authenticationHash: result.authenticationHash,
        }, attempt);
        // Expiry seen below finalized is awaited, never acted on: if its block
        // were rolled back, the attempt could still land on another fork.
        return evidence?.commitmentLevel === "finalized"
          ? { disposition, evidence: evidence as FinalizedExpiryEvidence }
          : { disposition: "pending" };
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
 * successful landed transfer is never `failed`. A new transfer is signed only after
 * every retained attempt has authenticated, durably acknowledged `finalized`
 * expiry evidence; a retained attempt is otherwise only rebroadcast byte-identically.
 *
 * `failed` is terminal: it is reported only after the store has closed the
 * key with `recordFailure`, and every later call on the key returns it again
 * without signing. See `SolanaSplProgress` and `docs/pay-solana-spl.md` for
 * the reason codes.
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
  let recordPreparation: SolanaSplSettlementStore["recordPreparation"];
  let recordAttempt: SolanaSplSettlementStore["recordAttempt"];
  let markAttemptExpired: SolanaSplSettlementStore["markAttemptExpired"];
  let recordSettlement: SolanaSplSettlementStore["recordSettlement"];
  let recordFailure: SolanaSplSettlementStore["recordFailure"];
  let runPreflight: SolanaSplAdapter["preflight"];
  let prepareUnsignedTransfer: SolanaSplAdapter["prepareUnsignedTransfer"];
  let prepareSignedTransfer: SolanaSplAdapter["prepareSignedTransfer"];
  let broadcastRetained: SolanaSplAdapter["broadcastRetained"];
  let reconcileTransfer: SolanaSplAdapter["reconcile"];
  try {
    // Bind every method before the claim, so a missing one cannot surface
    // after a lease is taken or a transfer is broadcast.
    claimSettlement = store.claim.bind(store);
    isCurrentSettlement = store.isCurrent.bind(store);
    recordPreparation = store.recordPreparation.bind(store);
    recordAttempt = store.recordAttempt.bind(store);
    markAttemptExpired = store.markAttemptExpired.bind(store);
    recordSettlement = store.recordSettlement.bind(store);
    recordFailure = store.recordFailure.bind(store);
    runPreflight = adapter.preflight.bind(adapter);
    prepareUnsignedTransfer = adapter.prepareUnsignedTransfer.bind(adapter);
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
    return { status: "settled", settlement: claimed.settlement };
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
    const storedExpired = ownElements(claimed.expiredSignatures, "retained expiry set");
    if (new Set(storedExpired).size !== storedExpired.length ||
        storedExpired.some((signature) =>
          !attempts.some((attempt) => attempt.signature === signature))) {
      throw new DacsError("pay-solana-spl: retained expiry set is invalid");
    }
    // Each entry equals a retained attempt's signature, so each is a string.
    expiredSignatures = Object.freeze(storedExpired as string[]);
    expiryEvidence = captureRetainedExpiryEvidence(
      claimed.expiryEvidence,
      attempts,
      expiredSignatures,
    );
    if (attempts.slice(0, -1).some((attempt) => !expiryEvidence.has(attempt.signature))) {
      throw new DacsError("pay-solana-spl: predecessor expiry evidence is missing");
    }
    // A reservation can only be for the next attempt: a later one names a
    // preparation this record cannot account for.
    if (claimed.preparation !== undefined && claimed.preparation.attempt !== attempts.length + 1) {
      throw new DacsError("pay-solana-spl: reserved preparation is out of sequence");
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
  // A failure lets the caller pay the phase another way, so it is reported
  // only once the store has closed the key under this lease: no later call
  // can then sign under it.
  const close = async (
    failure: Readonly<Extract<SolanaSplProgress, { status: "failed" }>>,
    landedFailure?: Readonly<SolanaSplLandedFailureEvidence>,
    landedFailures?: readonly Readonly<SolanaSplLandedFailureEvidence>[],
  ): Promise<SolanaSplProgress> => {
    // Read once into the record and a fresh result: the caller owns what it
    // gets back, so an edit to it never reaches another call or record.
    const { errorClass, reason } = failure;
    try {
      const closed = storeWrite(await recordFailure({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        failure: Object.freeze({ errorClass, reason }),
        ...(landedFailure ? { landedFailure } : {}),
        ...(landedFailures?.length ? { landedFailures } : {}),
      }));
      const status = closed.status;
      if (status === "recorded" || status === "existing") return { status: "failed", errorClass, reason };
    } catch {
      // Falls through to the uncertain result.
    }
    return { status: "indeterminate", reason: "solana-spl-failure-persistence-uncertain" };
  };
  // Returns null only for the two absent dispositions, which the caller handles.
  const finalize = async (
    attempt: Readonly<SolanaSplSignedAttempt>,
    result: ReconciledState,
    landedFailures: readonly Readonly<SolanaSplLandedFailureEvidence>[] = [],
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
        const write = storeWrite(await recordSettlement({
          settlementKey: intent.settlementKey,
          bindingHash: intent.bindingHash,
          owner: fence.owner,
          generation: fence.generation,
          signature: attempt.signature,
          settlement,
          ...(landedFailures.length ? { landedFailures } : {}),
        }));
        const status = write.status;
        if (status === "recorded" || status === "existing") {
          return { status: "settled", settlement };
        }
      } catch {
        // Falls through to the uncertain result.
      }
      return { status: "indeterminate", reason: "solana-spl-settlement-persistence-uncertain" };
    }
    if (result.disposition === "landed-failed") {
      return close({ status: "failed", errorClass: "permanent", reason: "solana-spl-transfer-failed-on-chain" }, result.evidence);
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
    evidence: FinalizedExpiryEvidence,
  ): Promise<SolanaSplProgress | null> => {
    try {
      const marked = storeWrite(await markAttemptExpired({
        settlementKey: intent.settlementKey,
        bindingHash: intent.bindingHash,
        owner: fence.owner,
        generation: fence.generation,
        ...evidence,
      }));
      const status = marked.status;
      if (status === "recorded" || status === "existing") {
        const acknowledged = plainData(
          marked.expiryEvidence,
          "acknowledged expiry evidence",
          EVIDENCE_KEYS,
        ) as Readonly<SolanaSplExpiryEvidence>;
        const captured = captureExpiryEvidence(acknowledged, attempt);
        if (captured && canonicalize(captured) === canonicalize(evidence)) return null;
      }
    } catch {
      // An unavailable, unreadable or invalid acknowledgement cannot
      // authorize a replacement.
    }
    return { status: "indeterminate", reason: "solana-spl-expiry-persistence-uncertain" };
  };

  // A legacy predecessor that landed invalidates the old replacement premise.
  // Inspect every successor without signing or broadcasting: closing the key
  // would hide a second payment if any successor has landed or can still land.
  const recoverLandedPredecessor = async (
    predecessor: Readonly<SolanaSplSignedAttempt>,
    first: Extract<ReconciledState, { disposition: "settled-same" | "landed-failed" }>,
  ): Promise<SolanaSplProgress> => {
    const payments: { attempt: Readonly<SolanaSplSignedAttempt>; state: ReconciledState }[] = [];
    const failures: Readonly<SolanaSplLandedFailureEvidence>[] = [];
    let unresolved: SolanaSplProgress | undefined;
    for (const attempt of attempts.slice(predecessor.attempt - 1)) {
      const state = attempt === predecessor ? first : await reconcile(attempt);
      if (state.disposition === "settled-same" && state.settlement) {
        payments.push({ attempt, state });
      } else if (state.disposition === "landed-failed") {
        failures.push(state.evidence);
      } else if (state.disposition === "absent-expired") {
        if (expiryEvidence.get(attempt.signature)?.commitmentLevel !== "finalized") {
          const failure = await persistExpiry(attempt, state.evidence);
          if (failure) unresolved = failure;
        }
      } else {
        unresolved = state.disposition === "absent-valid" || state.disposition === "pending"
          ? { status: "indeterminate", reason: "solana-spl-other-attempt-unresolved" }
          : await finalize(attempt, state) ??
            { status: "indeterminate", reason: "solana-spl-reconciliation-invalid" };
      }
    }
    if (payments.length > 1) {
      return { status: "indeterminate", reason: "solana-spl-multiple-settlements" };
    }
    if (unresolved) return unresolved;
    const payment = payments[0];
    if (payment) return (await finalize(payment.attempt, payment.state, failures))!;
    return close({
      status: "failed", errorClass: "permanent", reason: "solana-spl-transfer-failed-on-chain",
    }, undefined, failures);
  };

  // Confirmed expiry evidence an earlier version stored for a predecessor is
  // checked again before anything relies on it: if the block that showed the
  // expiry were rolled back, the predecessor could still land. Only finalized
  // expiry the store acknowledges clears it, and it is never rebroadcast,
  // because a later attempt already replaced it.
  for (const predecessor of attempts.slice(0, -1)) {
    if (expiryEvidence.get(predecessor.signature)?.commitmentLevel === "finalized") continue;
    const state = await reconcile(predecessor);
    if (state.disposition === "absent-expired") {
      const persistenceFailure = await persistExpiry(predecessor, state.evidence);
      if (persistenceFailure) return persistenceFailure;
      continue;
    }
    if (state.disposition === "absent-valid") {
      return { status: "waiting", reason: "solana-spl-reconciliation-pending" };
    }
    if (state.disposition === "settled-same" || state.disposition === "landed-failed") {
      return recoverLandedPredecessor(predecessor, state);
    }
    return await finalize(predecessor, state) ??
      { status: "indeterminate", reason: "solana-spl-reconciliation-invalid" };
  }

  const latest = attempts.at(-1);
  // Only finalized expiry evidence lets the latest attempt be replaced or the
  // key closed. Confirmed evidence an earlier version stored is checked again.
  if (latest && expiryEvidence.get(latest.signature)?.commitmentLevel !== "finalized") {
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

  const attemptNumber = attempts.length + 1;
  let preparation = claimed.preparation;
  if (!preparation) {
    let preflight: Readonly<SolanaSplPreflight>;
    try { await fence.assertCurrent(); }
    catch { return { status: "indeterminate", reason: "solana-spl-preflight-fence-lost" }; }
    try { preflight = await runPreflight(intent, fence); }
    catch {
      try { await fence.assertCurrent(); }
      catch { return { status: "indeterminate", reason: "solana-spl-preflight-fence-lost" }; }
      return { status: "transient", reason: "solana-spl-preflight-unavailable" };
    }
    try { await fence.assertCurrent(); }
    catch { return { status: "indeterminate", reason: "solana-spl-preflight-fence-lost" }; }
    const plan = validatePreflight(intent, preflight);
    if ("status" in plan) return plan.status === "failed" ? close(plan) : plan;
    let transaction: Readonly<SolanaSplUnsignedTransfer>;
    try {
      await fence.assertCurrent();
      transaction = await prepareUnsignedTransfer(plan, attemptNumber, fence);
      await fence.assertCurrent();
      preparation = capturePreparation({ attempt: attemptNumber, plan, transaction }, intent);
    } catch {
      // This boundary only builds: no signature exists and no reservation was made.
      try { await fence.assertCurrent(); }
      catch { return { status: "indeterminate", reason: "solana-spl-preflight-fence-lost" }; }
      return { status: "transient", reason: "solana-spl-unsigned-preparation-unavailable" };
    }
    try {
      await fence.assertCurrent();
      const reserved = storeWrite(await recordPreparation({
        settlementKey: intent.settlementKey, bindingHash: intent.bindingHash,
        owner: fence.owner, generation: fence.generation,
        attempt: attemptNumber, preparation,
      })).status;
      if (reserved !== "recorded") {
        return { status: "indeterminate", reason: "solana-spl-preparation-reservation-uncertain" };
      }
    } catch {
      return { status: "indeterminate", reason: "solana-spl-preparation-reservation-uncertain" };
    }
  }
  // Re-sign exactly the retained message with the same Ed25519 signers.
  // Deterministic signing recovers the same transaction id after a lost reply.
  let prepared: Readonly<Omit<SolanaSplSignedAttempt, "attemptHash">>;
  try {
    await fence.assertCurrent();
    prepared = await prepareSignedTransfer(preparation.plan, attemptNumber, fence, preparation);
  } catch {
    return { status: "indeterminate", reason: "solana-spl-preparation-unavailable" };
  }
  let attempt: Readonly<SolanaSplSignedAttempt>;
  try {
    attempt = createAttempt(prepared, attemptNumber, intent);
    assertPreparedMessage(attempt, preparation);
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
    retained = storeWrite(await recordAttempt({
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
  if (claimed.preparation) {
    // A previous wallet call may already have returned or submitted these
    // exact bytes. PC-7 requires checking the original signature before
    // retrying its broadcast; an expired message may also be rejected by RPC.
    const recovered = await reconcile(attempt);
    const terminal = await finalize(attempt, recovered);
    if (terminal) return terminal;
    if (recovered.disposition === "absent-expired") {
      const persistenceFailure = await persistExpiry(attempt, recovered.evidence);
      return persistenceFailure ?? {
        status: "indeterminate", reason: "solana-spl-new-attempt-expired-before-observation",
      };
    }
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
  landedFailures?: readonly Readonly<SolanaSplLandedFailureEvidence>[];
  settlement?: Readonly<SolanaSplSettlementResult>;
  failure?: Readonly<{ errorClass: "permanent" | "counterparty"; reason: string }>;
  /** Exact preparation retained before any wallet handoff. */
  preparation?: Readonly<SolanaSplPreparation>;
}

/** Test/development store. Production callers must persist encrypted signed bytes. */
export function createInMemorySolanaSplSettlementStore(): SolanaSplSettlementStore {
  const records = new Map<string, MemoryRecord>();
  const signatures = new Map<string, string>();
  const messages = new Map<string, string>();
  const current = (
    record: MemoryRecord | undefined,
    input: { bindingHash: string; owner: string; generation: number },
  ): record is MemoryRecord => record !== undefined &&
    record.intent.bindingHash === input.bindingHash &&
    record.lease.owner === input.owner && record.lease.generation === input.generation;
  const closed = { status: "conflict", reason: "solana-settlement-closed" } as const;
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
        if (existing.failure) {
          return { status: "failed", intent: existing.intent, failure: { ...existing.failure } };
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
            ...(existing.preparation === undefined ? {} : { preparation: structuredClone(existing.preparation) }),
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
          ...(existing.preparation === undefined ? {} : { preparation: structuredClone(existing.preparation) }),
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
      return current(record, input) && record.lease.expiresAt > input.now &&
        !record.settlement && !record.failure;
    },
    async recordPreparation(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (record.failure || record.settlement) return closed;
      if (input.attempt !== record.attempts.length + 1) {
        return { status: "conflict", reason: "solana-attempt-sequence-gap" };
      }
      let preparation: Readonly<SolanaSplPreparation>;
      try {
        preparation = capturePreparation(input.preparation, record.intent);
        if (preparation.attempt !== input.attempt) throw new Error("attempt mismatch");
      } catch { return { status: "conflict", reason: "solana-preparation-invalid" }; }
      if (record.preparation !== undefined && canonicalize(record.preparation) === canonicalize(preparation)) {
        return { status: "existing" };
      }
      if (record.preparation !== undefined) {
        return { status: "conflict", reason: "solana-preparation-conflict" };
      }
      const message = preparation.transaction.unsignedMessageBase64;
      const messageOwner = messages.get(message);
      if (messageOwner && messageOwner !== input.settlementKey) {
        return { status: "conflict", reason: "solana-message-cross-settlement-reuse" };
      }
      record.preparation = preparation;
      messages.set(message, input.settlementKey);
      return { status: "recorded" };
    },
    async recordAttempt(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (record.failure) return closed;
      const owner = signatures.get(input.attempt.signature);
      if (owner && owner !== input.settlementKey) {
        const owningRecord = records.get(owner);
        const owned = owningRecord?.attempts.find((attempt) =>
          attempt.signature === input.attempt.signature);
        // Older stores could reserve the same message for two keys. A wallet
        // may still return its original result, so never discard a preparation
        // merely on a signature conflict. Exact bytes already retained under
        // the other key prove that all deterministic re-signings can produce
        // only that same transaction, whose ownership stays with the other key.
        if (record.preparation && owned && owningRecord?.intent.cluster === record.intent.cluster &&
            owned.transferInstructionIndex === input.attempt.transferInstructionIndex &&
            owned.signedTransactionBase64 === input.attempt.signedTransactionBase64) {
          try {
            assertPreparedMessage(input.attempt, record.preparation);
            messages.set(record.preparation.transaction.unsignedMessageBase64, owner);
            record.preparation = undefined;
          } catch { /* An uncertain preparation must remain reserved. */ }
        }
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
      if (record.preparation) {
        try { assertPreparedMessage(input.attempt, record.preparation); }
        catch { return { status: "conflict", reason: "solana-prepared-message-mismatch" }; }
      }
      // Include historical attempts that were recorded without a preparation.
      const bytes = Buffer.from(input.attempt.signedTransactionBase64, "base64");
      const [count, offset] = compactU16(bytes, 0);
      const message = bytes.subarray(offset + count * 64).toString("base64");
      if (!messages.has(message)) messages.set(message, input.settlementKey);
      record.attempts.push(Object.freeze({ ...input.attempt }));
      if (record.preparation?.attempt === input.attempt.attempt) record.preparation = undefined;
      signatures.set(input.attempt.signature, input.settlementKey);
      return { status: "recorded" };
    },
    async markAttemptExpired(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (record.failure) return closed;
      const attempt = record.attempts.find(
        (retained) => retained.signature === input.signature,
      );
      if (!attempt) {
        return { status: "conflict", reason: "solana-expiry-proof-or-signature-invalid" };
      }
      let evidence: Readonly<SolanaSplExpiryEvidence> | null;
      try {
        evidence = captureExpiryEvidence(input, attempt);
      } catch {
        evidence = null;
      }
      if (!evidence) {
        return { status: "conflict", reason: "solana-expiry-proof-or-signature-invalid" };
      }
      // Only finalized evidence is ever written here, so a prior record is final.
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
      if (record.failure) return closed;
      if (!record.attempts.some((attempt) => attempt.signature === input.signature)) {
        return { status: "conflict", reason: "solana-settlement-attempt-not-live" };
      }
      if (record.settlement) {
        return canonicalize(record.settlement) === canonicalize(input.settlement)
          ? { status: "existing" }
          : { status: "conflict", reason: "solana-settlement-conflict" };
      }
      if (record.preparation !== undefined) {
        return { status: "conflict", reason: "solana-settlement-preparation-unresolved" };
      }
      const failures: Readonly<SolanaSplLandedFailureEvidence>[] = [];
      try {
        for (const proof of input.landedFailures ?? []) {
          const attempt = record.attempts.find((row) => row.signature === proof.signature);
          const captured = attempt && captureLandedFailure(proof, attempt);
          if (!captured || proof.signature === input.signature ||
              failures.some((row) => row.signature === proof.signature)) {
            return { status: "conflict", reason: "solana-landed-failure-invalid" };
          }
          failures.push(captured);
        }
      } catch {
        return { status: "conflict", reason: "solana-landed-failure-invalid" };
      }
      if (record.attempts.some((attempt) => attempt.signature !== input.signature &&
          !record.expired.has(attempt.signature) &&
          !failures.some((row) => row.signature === attempt.signature))) {
        return { status: "conflict", reason: "solana-settlement-other-attempt-live" };
      }
      record.landedFailures = Object.freeze(failures);
      record.settlement = Object.freeze({ ...input.settlement });
      return { status: "recorded" };
    },
    async recordFailure(input) {
      const record = records.get(input.settlementKey);
      if (!current(record, input)) return { status: "stale", reason: "stale-lease" };
      if (record.settlement) return { status: "conflict", reason: "solana-settlement-already-settled" };
      const failures: Readonly<SolanaSplLandedFailureEvidence>[] = [];
      try {
        for (const proof of [...(input.landedFailure ? [input.landedFailure] : []), ...(input.landedFailures ?? [])]) {
          const attempt = record.attempts.find((row) => row.signature === proof.signature);
          const captured = attempt && captureLandedFailure(proof, attempt);
          if (!captured || failures.some((row) => row.signature === captured.signature)) {
            return { status: "conflict", reason: "solana-landed-failure-invalid" };
          }
          failures.push(captured);
        }
      } catch { return { status: "conflict", reason: "solana-landed-failure-invalid" }; }
      // A reserved preparation may hold a transaction the store never saw.
      if (record.preparation !== undefined) {
        return { status: "conflict", reason: "solana-failure-preparation-unresolved" };
      }
      // Only a key with no attempt that can still land may be closed. This
      // store holds only finalized expiry evidence and authenticated refusals.
      if (record.attempts.some((attempt) => !record.expired.has(attempt.signature) &&
          !failures.some((row) => row.signature === attempt.signature))) {
        return { status: "conflict", reason: "solana-failure-attempt-live" };
      }
      const failure = Object.freeze({
        errorClass: input.failure.errorClass,
        reason: input.failure.reason,
      });
      if (record.failure) {
        return canonicalize(record.failure) === canonicalize(failure)
          ? { status: "existing" }
          : { status: "conflict", reason: "solana-failure-conflict" };
      }
      record.landedFailures = Object.freeze(failures);
      record.failure = failure;
      record.preparation = undefined;
      return { status: "recorded" };
    },
  };
}
