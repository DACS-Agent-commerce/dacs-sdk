import { types as nodeTypes } from "node:util";

import {
  hasDefinitiveDemosFailure,
  type DemosFailedRecordProof,
} from "../agent/settlementFailure.js";
import type { SettleRequest, SettleResult } from "../agent/runSessionCore.js";
import { baseUnits, canonicalize } from "../canonical/index.js";
import {
  snapshotCanonicalJsonRead,
  snapshotWireJsonRead,
} from "../canonical/snapshot.js";
import { DacsError } from "../errors.js";
import { demosAddressFromClaim, normalizeDemosNativeAddress } from "./demosAddress.js";
export { demosAddressFromClaim, normalizeDemosNativeAddress } from "./demosAddress.js";
import {
  createIdempotencyStore,
  settlementKey,
  type SettlementBinding,
  type SettlementEffectFence,
  type SettlementIdempotencyStore,
  type SettlementNotInvokedResult,
  type SettlementReconcile,
} from "./idempotency.js";

/** §9.5.9: the native asset this rail settles. */
export const DEM_CURRENCY = "DEM";
/** §9.5.9: 1 DEM = 10^9 OS base units. The chain moves integer OS. */
export const DEM_DECIMALS = 9;

const DEMOS_TX_HASH_RE = /^(?:0[xX])?([0-9a-fA-F]{64})$/;
const DEFAULT_INCLUSION_TIMEOUT_MS = 60_000;
const DEFAULT_INCLUSION_POLL_INTERVAL_MS = 500;
const DEFAULT_STATUS_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_NONCE_VISIBILITY_TIMEOUT_MS = 60_000;
const DEFAULT_TRANSACTION_RECORD_TIMEOUT_MS = 30_000;
const DACS_DEMOS_INCLUDED_STATE = "included";
const DEMOS_EXECUTED_RECORD_STATUS = "confirmed";
const DEMOS_FAILED_RECORD_STATUS = "failed";

/**
 * Capabilities whose verdicts come from a node transaction record the SDK read
 * and bound itself (#338): the native client `createPayDemRail` builds around
 * demosdk, that rail's `settle`, and `payDemSettle` submissions around such a
 * settle. Keyed by identity and private to this module: nothing exported from
 * any shipped file adds to them, and a wrapper is a different object.
 */
const sdkRecordReadingClients = new WeakSet<object>();
const sdkRecordReadingSettles = new WeakSet<object>();
const sdkRecordReadingSubmissions = new WeakSet<object>();
/**
 * Fresh successes `payDemSettleCore` returned for the SDK's own client, frozen,
 * each with the exact transfer terms that client signed. Private like the sets
 * above: a copy, a caller-built object or a relabelled result is not in it.
 */
const sdkRecordVerifiedResults = new WeakMap<object, Readonly<PayDemRecordVerifiedTransfer>>();

/** The exact transfer an SDK record-verified pay-dem success settled. */
export interface PayDemRecordVerifiedTransfer {
  /** Native payer and payee: 64 lowercase hex characters, no `0x`. */
  readonly payer: string;
  readonly payee: string;
  /** Integer OS base units. */
  readonly amountOs: string;
  readonly network: string;
  /** The recovery context's settlement key, when the settle carried one. */
  readonly settlementKey?: string;
}

/**
 * The transfer terms of `result` when it is a fresh success that
 * `createPayDemRail`'s own settle returned after reading and binding the
 * node's executed transaction record itself (#338); otherwise `undefined`.
 * Read-only: a host accepting any `PayDemRail` checks this, never the
 * result's `execution` string, before it settles anything on the payment.
 */
export function payDemRecordVerifiedTransfer(
  result: unknown,
): Readonly<PayDemRecordVerifiedTransfer> | undefined {
  // WeakMap#get answers undefined for any value it cannot hold.
  return sdkRecordVerifiedResults.get(result as object);
}

/**
 * @internal Whether `submission` is a `payDemSettle` submission around
 * `createPayDemRail`'s own settle, whose failure proof the SDK built from a
 * node record it read. Read-only: there is no way to add a source.
 */
export function isRecordVerifiedSource(submission: unknown): boolean {
  // WeakSet#has answers false for any value it cannot hold.
  return sdkRecordReadingSubmissions.has(submission as object);
}

type AnyMethod = (...args: never[]) => unknown;

function stableDataProperty(
  source: unknown,
  key: string,
  label: string,
): { found: boolean; value?: unknown } {
  if (
    (typeof source !== "object" && typeof source !== "function") ||
    source === null ||
    nodeTypes.isProxy(source)
  ) {
    throw new DacsError(`${label} must be stable data`);
  }
  let cursor: object | null = source;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      throw new DacsError(`${label} must be stable data`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) {
      if (!("value" in descriptor)) {
        throw new DacsError(`${label} must be stable data`);
      }
      return { found: true, value: descriptor.value };
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return { found: false };
}

function stableMethod<T extends AnyMethod>(
  source: unknown,
  key: string,
  label: string,
): T {
  // Never consult a caller-controlled own `.bind` property on the
  // capability. Capture the exact function while preserving class/private
  // receivers through the intrinsic Function.prototype operation.
  return Function.prototype.bind.call(
    stableMethodTarget(source, key, label),
    source,
  ) as T;
}

/** The exact data-property function {@link stableMethod} binds, unbound. */
function stableMethodTarget(
  source: unknown,
  key: string,
  label: string,
): AnyMethod {
  if (
    (typeof source !== "object" && typeof source !== "function") ||
    source === null ||
    nodeTypes.isProxy(source)
  ) {
    throw new DacsError(`${label} must be a stable method`);
  }
  let cursor: object | null = source;
  while (cursor !== null) {
    if (nodeTypes.isProxy(cursor)) {
      throw new DacsError(`${label} must be a stable method`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key);
    if (descriptor) {
      if (
        !("value" in descriptor) ||
        typeof descriptor.value !== "function" ||
        nodeTypes.isProxy(descriptor.value)
      ) {
        throw new DacsError(`${label} must be a stable method`);
      }
      return descriptor.value as AnyMethod;
    }
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  throw new DacsError(`${label} must be a stable method`);
}

function requiredStableString(source: unknown, key: string, label: string): string {
  const property = stableDataProperty(source, key, label);
  if (
    !property.found ||
    typeof property.value !== "string" ||
    property.value.length === 0 ||
    property.value.trim() !== property.value
  ) {
    throw new DacsError(`${label} must be a non-empty stable string`);
  }
  return property.value;
}

function optionalStableString(
  source: unknown,
  key: string,
  label: string,
): string | undefined {
  const property = stableDataProperty(source, key, label);
  if (!property.found || property.value === undefined) return undefined;
  if (
    typeof property.value !== "string" ||
    property.value.length === 0 ||
    property.value.trim() !== property.value
  ) {
    throw new DacsError(`${label} must be a non-empty stable string`);
  }
  return property.value;
}

function optionalPositiveInteger(
  source: unknown,
  key: string,
  label: string,
  fallback: number,
): number {
  const property = stableDataProperty(source, key, label);
  if (!property.found || property.value === undefined) return fallback;
  if (!Number.isSafeInteger(property.value) || (property.value as number) <= 0) {
    throw new DacsError(`${label} must be a positive safe integer`);
  }
  return property.value as number;
}

function canonicalDemosTxHash(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value) return null;
  return value.match(DEMOS_TX_HASH_RE)?.[1]?.toLowerCase() ?? null;
}

/**
 * pay-dem settlement rail — native DEM transfer (DACS-4 §9.5.9, SR-4).
 *
 * The plain native path: the buyer submits a `demos.transfer` of the agreed DEM
 * amount straight to the seller's address; the buyer-signed runtime agreement +
 * the on-chain transfer are the settlement inputs (no HTTP 402 flow — that's the separate,
 * experimental pay-d402). This is the live-settleable native rail: for Demos,
 * BFT *inclusion IS finality*, so the evidence carries `settlementFinality.model:
 * "bft-final"` and a `demos` txRef (hash + block height).
 *
 * INCLUSION-GATED (§9.5.9): `bft-final` is emitted ONLY on the exact terminal
 * Demos `included` state AND the finality-witness block height. Broadcast
 * *acceptance* (the node took the tx for submission) is NOT finality: a
 * merely-accepted tx can still be rejected in consensus, dropped, or never
 * included, so minting evidence on acceptance would attest an unobserved payment.
 * A transfer that doesn't reach observed inclusion settles `ok: false` and no
 * finality is stamped — evidence is never minted for a payment we didn't see land.
 *
 * EXECUTION-GATED (#338): inclusion alone is not execution. A node can include a
 * transaction and record it `failed` (for example a stale nonce). After the
 * status index reports `included`, the rail reads the node's transaction record
 * for the signed hash and reports success only for a `confirmed` record at the
 * same block whose body is exactly the prepared transfer (hash, payer, payee,
 * nonce, amount). A `failed` record settles `ok: false`; a record the bounded
 * read cannot establish stays indeterminate (`ok: false` with the hash retained,
 * so the settlement intent stays held). Neither ever causes another broadcast.
 *
 * Amount units (§9.5.9 step 2): the agreement's DACS `Price.amount` is a canonical
 * DECIMAL DEM string; the chain moves integer OS base units (1 DEM = 10^9 OS). The
 * `payDemSettle` seam is the converter — it asserts the currency is DEM and turns
 * decimal DEM → OS. `payDemSettleCore` then works purely in integer OS base units
 * (never floats). The core is pure over an injected native client, so it's tested
 * without a Demos node; createPayDemRail is the thin demosdk wiring
 * (transfer → confirm → write-ahead journal → one broadcast, with finality
 * independently observed by the canonical signed hash).
 */

export interface PayDemSettleParams {
  /** Recipient Demos address (payee). */
  recipient: string;
  /** Amount in integer OS base units (string). */
  amount: string;
  /** Network label recorded on the evidence (default "demos"). */
  network?: string;
  /**
   * Exact per-payment ceiling in OS for the transfer amount plus confirmed
   * Demos fees. Live coordinators bind this value to the retained purchase
   * authority so one long-lived rail can safely serve differently capped
   * orders. A rail-level ceiling, when configured, remains an additional
   * upper bound.
   */
  maxTotalDebitOs?: string;
  /**
   * Optional PC-7 recovery identity supplied by the runSession bridge. When
   * present it is persisted with the prepared transaction before broadcast so
   * a durable journal can bind the signed hash to the exact rail/session/phase
   * idempotency key instead of relying on transaction identity alone.
   */
  recovery?: Readonly<PayDemSettlementRecoveryContext>;
  /** Durable per-attempt journal committed after validation and before broadcast. */
  journalPreparedTransfer?: (
    transfer: Readonly<PayDemPreparedTransfer>,
  ) => Promise<void>;
  /** Generation fence asserted immediately before the irreversible broadcast. */
  assertCurrentBeforeBroadcast?: () => Promise<void>;
}

export interface PayDemSettlementRecoveryContext {
  /** Exact authenticated rail selected for this payment phase (SB-1). */
  railId: string;
  /** Exact committed session identifier (PC-7 / SB-1). */
  jobId: string;
  /** Exact repeated-phase discriminator (PC-2 / SB-1). */
  phaseIndex: number;
  /** Canonical `(railId, jobId, phaseIndex)` idempotency key. */
  settlementKey: string;
  /** Exact chain/network label the returned settlement must carry. */
  network: string;
  /** Canonical native Demos payer address. */
  payer: string;
  /** Canonical native Demos payee address. */
  payee: string;
  /** Exact positive integer OS amount submitted by this payment phase. */
  amountOs: string;
}

/**
 * Authoritative pay-DEM reconciliation observation. `amountOs` is repeated in
 * the observation so the SDK can compare the chain reader's answer with the
 * exact PC-7 recovery request before a generic idempotency store persists it.
 */
export interface PayDemReconciledSettlement extends SettleResult {
  amountOs: string;
  /**
   * The reconciler's statement, which the SDK cannot authenticate, that the
   * node's transaction record for `txHash` is `confirmed` at `blockNumber` and
   * binds the payer, payee and amount (#338). A status-index `included` alone
   * is not execution: the SDK
   * refuses a reconciliation without this, as {@link payDemSettleCore} refuses
   * a transfer result without {@link DemosTransferResult.execution}. It is not
   * persisted with the settlement.
   */
  execution: "executed";
}

/**
 * Reconcile one exact pay-DEM payment tuple. `null` is a positive proof that no
 * transfer for this tuple landed, but cannot by itself revoke an earlier process
 * or signed transaction. Native DEM therefore remains fail-closed after absence
 * unless a higher-level adapter supplies a separately fenced replay primitive.
 * Return a settlement only after reading the node's transaction record for the
 * hash and finding it `confirmed` at the inclusion block for this payer, payee
 * and amount, and set `execution: "executed"`. A node reports `included` in its
 * status index for a transaction whose record `failed` (#338), so inclusion
 * alone must not be returned as a settlement. A bound `failed` record may
 * return `PayDemReconciledFailure` with a permanent class and exact failure
 * proof. It can confirm a durable failure `createPayDemRail` recorded, but is
 * never itself recorded as the definitive outcome: a held intent stays held.
 * Indeterminate or non-final observations must throw.
 */
export interface PayDemReconciledFailure extends SettleResult {
  ok: false;
  amountOs: string;
  errorClass: "permanent";
  failureProof: DemosFailedRecordProof;
}

export type PayDemSettlementReconcile = (
  context: Readonly<PayDemSettlementRecoveryContext>,
) => Promise<PayDemReconciledSettlement | PayDemReconciledFailure | null>;

/** The result of submitting a native transfer and independently observing finality. */
export interface DemosTransferResult {
  ok: boolean;
  hash: string;
  /**
   * The terminal transaction state the client observed. DACS-4 §9.5.9 permits
   * `bft-final` only for the exact Demos `included` state; every other token
   * (`confirmed`, `finalized`, `failed`, `timeout`, `indeterminate`, a
   * nonterminal poll, …) fails closed. A client reports `included` with
   * `ok: true` only after the node's transaction record shows the prepared
   * transfer executed (#338).
   */
  state?: string;
  /**
   * `"executed"` when the client read the node's transaction record for the
   * signed hash and it shows the prepared transfer executed at `blockNumber`
   * (#338). Inclusion alone is not execution: {@link payDemSettleCore} reports
   * success only when this is present, and only from the client
   * `createPayDemRail` builds.
   */
  execution?: "executed";
  /**
   * Bound terminal failed record; a status-index failure alone cannot issue it.
   * Permanent only from the client `createPayDemRail` builds, which takes it
   * from the record it read.
   */
  failureProof?: DemosFailedRecordProof;
  /** The block height the tx landed at — the §9.5.9 finality witness. */
  blockNumber?: number;
  /** Confirmed transfer amount plus network fee, in integer OS. */
  totalDebitOs?: string;
  message?: string;
}

/**
 * DACS-4 §9.5.9 procedure step 5 and Finality define `included` as the sole
 * terminal Demos state that authorizes `bft-final`. The set-shaped export is
 * retained for API compatibility; normative settlement acceptance below uses an
 * exact token comparison and cannot be widened by mutating the exported set.
 */
export const TERMINAL_INCLUDED = new Set([DACS_DEMOS_INCLUDED_STATE]);

/** Minimal structural view of the native-transfer client this rail depends on. */
export interface DemosNativeClient {
  /** The payer's Demos address. */
  address: string;
  /**
   * Sign, confirm, and broadcast a native DEM transfer; resolve its receipt.
   * Resolve `ok: true, state: "included", execution: "executed"` only when the
   * node's transaction record for the signed hash shows the exact prepared
   * transfer executed; inclusion alone is not success (#338).
   * {@link payDemSettleCore} calls this only on the client `createPayDemRail`
   * builds, which signs, journals, fences and broadcasts the transfer and reads
   * that record itself. It refuses any other client before calling this: the
   * SDK could not bind another client's broadcast to the call, order it after
   * the journal and the fence, or read its fee, so its result could never be
   * final.
   */
  transfer(args: {
    to: string;
    amountOs: bigint;
    maxTotalDebitOs?: bigint;
    recovery?: Readonly<PayDemSettlementRecoveryContext>;
    journalPreparedTransfer?: (
      transfer: Readonly<PayDemPreparedTransfer>,
    ) => Promise<void>;
    assertCurrentBeforeBroadcast?: () => Promise<void>;
    effectFence?: Readonly<SettlementEffectFence>;
  }): Promise<DemosTransferResult>;
}

function captureSettlementEffectFence(
  value: unknown,
): Readonly<SettlementEffectFence> | undefined {
  if (value === undefined) return undefined;
  const owner = requiredStableString(value, "owner", "pay-dem effect fence owner");
  const settlementKey = requiredStableString(
    value,
    "settlementKey",
    "pay-dem effect fence settlementKey",
  );
  const bindingHash = requiredStableString(
    value,
    "bindingHash",
    "pay-dem effect fence bindingHash",
  );
  const generationProperty = stableDataProperty(
    value,
    "generation",
    "pay-dem effect fence generation",
  );
  if (!generationProperty.found ||
      !Number.isSafeInteger(generationProperty.value) ||
      (generationProperty.value as number) < 0) {
    throw new DacsError(
      "pay-dem effect fence generation must be a non-negative safe integer",
    );
  }
  const effectIdentity = optionalStableString(
    value,
    "effectIdentity",
    "pay-dem effect fence effectIdentity",
  );
  const assertCurrent = stableMethod<() => Promise<void>>(
    value,
    "assertCurrent",
    "pay-dem effect fence assertion",
  );
  return Object.freeze({
    owner,
    generation: generationProperty.value as number,
    settlementKey,
    bindingHash,
    ...(effectIdentity === undefined ? {} : { effectIdentity }),
    assertCurrent,
  });
}

function captureRecoveryContext(
  value: unknown,
): Readonly<PayDemSettlementRecoveryContext> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      nodeTypes.isProxy(value)) {
    throw new DacsError("pay-dem recovery context must be stable data");
  }
  const railId = requiredStableString(value, "railId", "pay-dem recovery railId");
  const jobId = requiredStableString(value, "jobId", "pay-dem recovery jobId");
  const phaseIndexProperty = stableDataProperty(
    value,
    "phaseIndex",
    "pay-dem recovery phaseIndex",
  );
  if (!phaseIndexProperty.found ||
      !Number.isSafeInteger(phaseIndexProperty.value) ||
      (phaseIndexProperty.value as number) < 0) {
    throw new DacsError(
      "pay-dem recovery phaseIndex must be a non-negative safe integer",
    );
  }
  const phaseIndex = phaseIndexProperty.value as number;
  const key = requiredStableString(
    value,
    "settlementKey",
    "pay-dem recovery settlementKey",
  );
  if (key !== settlementKey(railId, jobId, phaseIndex)) {
    throw new DacsError(
      "pay-dem recovery settlementKey does not match railId, jobId, and phaseIndex",
    );
  }
  const network = requiredStableString(
    value,
    "network",
    "pay-dem recovery network",
  );
  const payerValue = requiredStableString(
    value,
    "payer",
    "pay-dem recovery payer",
  );
  const payeeValue = requiredStableString(
    value,
    "payee",
    "pay-dem recovery payee",
  );
  const payer = normalizeDemosNativeAddress(payerValue);
  const payee = normalizeDemosNativeAddress(payeeValue);
  if (payer === null || payer !== payerValue) {
    throw new DacsError(
      "pay-dem recovery payer must be a canonical native Demos address",
    );
  }
  if (payee === null || payee !== payeeValue) {
    throw new DacsError(
      "pay-dem recovery payee must be a canonical native Demos address",
    );
  }
  const amountOs = requiredStableString(
    value,
    "amountOs",
    "pay-dem recovery amountOs",
  );
  if (!/^[1-9][0-9]*$/.test(amountOs)) {
    throw new DacsError(
      "pay-dem recovery amountOs must be a canonical positive OS integer",
    );
  }
  return Object.freeze({
    railId,
    jobId,
    phaseIndex,
    settlementKey: key,
    network,
    payer,
    payee,
    amountOs,
  });
}

export function payDemSettleCore(
  params: PayDemSettleParams,
  client: DemosNativeClient,
  effectFence?: Readonly<SettlementEffectFence>,
): Promise<PayDemRailResult>;
export function payDemSettleCore(
  params: PayDemSettleParams,
  client: DemosNativeClient,
  defaultNetwork?: string,
  effectFence?: Readonly<SettlementEffectFence>,
): Promise<PayDemRailResult>;
export async function payDemSettleCore(
  params: PayDemSettleParams,
  client: DemosNativeClient,
  defaultNetworkOrFence: string | Readonly<SettlementEffectFence> = "demos",
  effectFenceOverride?: Readonly<SettlementEffectFence>,
): Promise<PayDemRailResult> {
  // Capture all caller-controlled values and the effect method before the first
  // await. A mutable parameter/client object must not be able to change the
  // transfer destination and then make the returned evidence attest a different
  // payer or payee.
  const recipient = requiredStableString(
    params,
    "recipient",
    "pay-dem recipient",
  );
  const amount = requiredStableString(params, "amount", "pay-dem amount");
  const defaultNetwork = typeof defaultNetworkOrFence === "string"
    ? defaultNetworkOrFence
    : "demos";
  if (typeof defaultNetworkOrFence !== "string" &&
      effectFenceOverride !== undefined) {
    throw new DacsError(
      "pay-dem effect fence cannot be supplied in both argument positions",
    );
  }
  const effectFence = captureSettlementEffectFence(
    typeof defaultNetworkOrFence === "string"
      ? effectFenceOverride
      : defaultNetworkOrFence,
  );
  if (typeof defaultNetwork !== "string" || defaultNetwork.length === 0 ||
      defaultNetwork.trim() !== defaultNetwork || defaultNetwork.includes("\0")) {
    throw new DacsError("pay-dem default network must be stable text");
  }
  const network = optionalStableString(params, "network", "pay-dem network") ??
    defaultNetwork;
  const recoveryProperty = stableDataProperty(
    params,
    "recovery",
    "pay-dem recovery context",
  );
  const recovery = captureRecoveryContext(
    recoveryProperty.found ? recoveryProperty.value : undefined,
  );
  const journalProperty = stableDataProperty(
    params,
    "journalPreparedTransfer",
    "pay-dem per-settlement prepared-transfer journal",
  );
  const journalPreparedTransfer = !journalProperty.found ||
      journalProperty.value === undefined
    ? undefined
    : stableMethod<NonNullable<PayDemSettleParams["journalPreparedTransfer"]>>(
        params,
        "journalPreparedTransfer",
        "pay-dem per-settlement prepared-transfer journal",
      );
  const fenceProperty = stableDataProperty(
    params,
    "assertCurrentBeforeBroadcast",
    "pay-dem pre-broadcast fence",
  );
  const assertCurrentBeforeBroadcast = !fenceProperty.found ||
      fenceProperty.value === undefined
    ? undefined
    : stableMethod<NonNullable<PayDemSettleParams["assertCurrentBeforeBroadcast"]>>(
        params,
        "assertCurrentBeforeBroadcast",
        "pay-dem pre-broadcast fence",
      );
  const payer = requiredStableString(client, "address", "pay-dem payer");
  const transfer = stableMethod<DemosNativeClient["transfer"]>(
    client,
    "transfer",
    "pay-dem transfer",
  );
  // Only the client createPayDemRail builds signs, journals, fences and
  // broadcasts the transfer and reads the node's transaction record itself
  // (#338). Any other client's verdict, fee and ordering are its statements.
  const recordReading = sdkRecordReadingClients.has(client);

  let amountOs: bigint;
  try {
    amountOs = BigInt(amount);
  } catch {
    throw new DacsError(`pay-dem: invalid OS base-unit amount ${amount}`);
  }
  if (amountOs <= 0n) {
    throw new DacsError(`pay-dem: amount must be > 0 (got ${amount})`);
  }
  const maxTotalDebitProperty = stableDataProperty(
    params,
    "maxTotalDebitOs",
    "pay-dem maximum total debit",
  );
  let maxTotalDebitOs: bigint | undefined;
  if (maxTotalDebitProperty.found && maxTotalDebitProperty.value !== undefined) {
    if (typeof maxTotalDebitProperty.value !== "string" ||
        !/^[1-9][0-9]*$/.test(maxTotalDebitProperty.value)) {
      throw new DacsError("pay-dem maximum total debit must be positive integer OS text");
    }
    maxTotalDebitOs = BigInt(maxTotalDebitProperty.value);
    if (maxTotalDebitOs < amountOs) {
      throw new DacsError("pay-dem maximum total debit cannot be less than the amount");
    }
  }

  if (recovery !== undefined) {
    const canonicalPayer = normalizeDemosNativeAddress(payer);
    const canonicalPayee = normalizeDemosNativeAddress(recipient);
    const chainId = network ?? "demos";
    if (
      canonicalPayer === null ||
      canonicalPayee === null ||
      recovery.payer !== canonicalPayer ||
      recovery.payee !== canonicalPayee ||
      recovery.network !== chainId ||
      recovery.amountOs !== amountOs.toString()
    ) {
      throw new DacsError(
        "pay-dem recovery context does not bind the exact payer, payee, network, and OS amount",
      );
    }
  }
  // Decide before the effect: a result the SDK could never make final must
  // not cost the buyer a transfer first. A record the SDK reads after another
  // client's broadcast shows that a transfer with these terms executed, not
  // that this call made it after its journal and fence, nor at what fee.
  if (!recordReading) {
    throw new DacsError(
      "pay-dem client is not the one createPayDemRail built, so its result could never be final; refusing transfer",
    );
  }

  await effectFence?.assertCurrent();
  const response = await transfer({
    to: recipient,
    amountOs,
    ...(maxTotalDebitOs === undefined ? {} : { maxTotalDebitOs }),
    ...(recovery === undefined ? {} : { recovery }),
    ...(journalPreparedTransfer === undefined ? {} : { journalPreparedTransfer }),
    ...(assertCurrentBeforeBroadcast === undefined
      ? {}
      : { assertCurrentBeforeBroadcast }),
    ...(effectFence === undefined ? {} : { effectFence }),
  });
  const okProperty = stableDataProperty(response, "ok", "pay-dem transfer result ok");
  const hashProperty = stableDataProperty(
    response,
    "hash",
    "pay-dem transfer result hash",
  );
  const stateProperty = stableDataProperty(
    response,
    "state",
    "pay-dem transfer result state",
  );
  const blockProperty = stableDataProperty(
    response,
    "blockNumber",
    "pay-dem transfer result blockNumber",
  );
  const executionProperty = stableDataProperty(
    response,
    "execution",
    "pay-dem transfer result execution",
  );
  const totalDebitProperty = stableDataProperty(
    response,
    "totalDebitOs",
    "pay-dem transfer result totalDebitOs",
  );
  const failureProperty = stableDataProperty(response, "failureProof", "pay-dem failure proof");
  const failureProof = failureProperty.value === undefined ? undefined :
    snapshotCanonicalJsonRead(failureProperty.value, "pay-dem failure proof");
  const txHash = hashProperty.found
    ? canonicalDemosTxHash(hashProperty.value)
    : null;
  if (txHash === null) {
    // A returned transfer result is already past the rail's submission seam.
    // Missing or malformed identity can never be treated as a clean no-submit
    // result: throw so the write-ahead intent remains held for reconciliation.
    throw new DacsError("pay-dem transfer result hash must be a 32-byte hex value");
  }
  const state = typeof stateProperty.value === "string"
    ? stateProperty.value
    : undefined;
  const blockNumber = blockProperty.value;
  const chainId = network ?? "demos";
  const totalDebitOs = totalDebitProperty.value === undefined
    ? undefined
    : typeof totalDebitProperty.value === "string" &&
        /^[1-9][0-9]*$/.test(totalDebitProperty.value)
      ? BigInt(totalDebitProperty.value)
      : null;
  if (totalDebitOs === null ||
      (totalDebitOs !== undefined && totalDebitOs < amountOs) ||
      (totalDebitOs !== undefined && maxTotalDebitOs !== undefined &&
        totalDebitOs > maxTotalDebitOs)) {
    throw new DacsError("pay-dem transfer result has invalid total debit accounting");
  }

  // Observed inclusion (§9.5.9): a verifiable tx id AND the exact terminal
  // `included` state AND the finality-witness block height. Broadcast acceptance
  // or an unregistered status alias is NOT finality — without these three, we do
  // not stamp bft-final, because the tx may never have landed. Inclusion is not
  // execution either (#338): the SDK's own client must also report that the
  // node's transaction record it read shows the transfer executed.
  const observedFinal =
    okProperty.value === true &&
    txHash.length > 0 &&
    state === DACS_DEMOS_INCLUDED_STATE &&
    executionProperty.value === "executed" &&
    Number.isSafeInteger(blockNumber) &&
    (blockNumber as number) >= 0;

  if (!observedFinal) {
    const failed = {
      ok: false, txHash, chainId, payer, payee: recipient,
      errorClass: "permanent" as const, failureProof,
      blockNumber, txRefKind: "demos",
    };
    // Only the SDK's own client issues a failure proof: it builds it from the
    // signed transaction it journaled and the bound record it read.
    if (okProperty.value === false && state === "failed" &&
        hasDefinitiveDemosFailure(failed, amount, chainId)) {
      return failed as PayDemRailResult;
    }
    return {
      ok: false,
      txHash,
      chainId,
      payer,
      payee: recipient,
      // No finality / blockNumber: the SDK did not observe execution, so no
      // bft-final evidence is minted for a possibly-unexecuted payment. The
      // hash stays so the settlement intent is held for reconciliation.
    };
  }

  const executed = Object.freeze({
    ok: true as const,
    execution: "executed" as const,
    txHash,
    chainId,
    payer,
    payee: recipient,
    // §9.5.9: Demos inclusion is BFT-final, so the confirmed execution is
    // final at this inclusion block; the `demos` txRef carries that block.
    finality: Object.freeze({ model: "bft-final" as const }),
    blockNumber: blockNumber as number,
    txRefKind: "demos" as const,
    // Fee accounting only, never part of the verdict: it comes from the node's
    // confirmation, checked above against the amount and the debit ceiling.
    ...(totalDebitOs === undefined
      ? {}
      : { networkFeeOs: (totalDebitOs - amountOs).toString() }),
  });
  // Frozen, so a holder cannot change the hash or block after it is listed.
  const verifiedPayer = normalizeDemosNativeAddress(payer);
  const verifiedPayee = normalizeDemosNativeAddress(recipient);
  if (verifiedPayer !== null && verifiedPayee !== null) {
    sdkRecordVerifiedResults.set(executed, Object.freeze({
      payer: verifiedPayer,
      payee: verifiedPayee,
      amountOs: amountOs.toString(),
      network: chainId,
      ...(recovery === undefined ? {} : { settlementKey: recovery.settlementKey }),
    }));
  }
  return executed;
}

export interface PayDemRailConfig {
  /** Demos node RPC URL. */
  rpc: string;
  /** Buyer wallet secret — mnemonic or private key — used to sign the transfer. */
  secret: string;
  /** Network label recorded on the evidence (default "demos"). */
  network?: string;
  /**
   * Optional per-settlement ceiling, in OS, for transfer amount plus the
   * transaction fees returned by the Demos confirmation response. When set,
   * malformed/missing fee data and a debit above the ceiling fail before
   * broadcast. This is a safety limit, not a balance estimate or an
   * idempotency boundary.
   */
  maxTotalDebitOs?: bigint;
  /**
   * Durable write-ahead hook invoked after the signed and confirmed transfer,
   * denomination and maximum debit have all been validated, and before the one
   * broadcast call. A rejection prevents broadcast. Funded operators use this
   * to persist the canonical hash and nonce needed for ambiguous-response
   * recovery. Callers may omit it, but then cross-process hash/nonce recovery
   * requires an equivalent application-owned durable rail record.
   */
  journalPreparedTransfer?: (
    transfer: Readonly<PayDemPreparedTransfer>,
  ) => Promise<void>;
  /** Overall hash-first inclusion observation budget (default 60 seconds). */
  inclusionTimeoutMs?: number;
  /** Delay between independent transaction-status observations (default 500 ms). */
  inclusionPollIntervalMs?: number;
  /** Bound for each possibly non-cooperative status RPC (default 5 seconds). */
  statusRequestTimeoutMs?: number;
  /** Bound for the post-inclusion account-nonce projection (default 60 seconds). */
  nonceVisibilityTimeoutMs?: number;
  /**
   * Overall budget for reading the node's transaction record after inclusion
   * (default 30 seconds). Each read is also bounded by `statusRequestTimeoutMs`.
   * When execution is not established within it, the settlement is
   * indeterminate and never resubmitted. The transport of demosdk 4.0.16 and
   * 4.0.18 retries a connection error or a 502–504 up to four times inside one
   * read, backing
   * off 250, 500, 1 000 and 2 000 ms (up to 8 seconds only when the node sends
   * `Retry-After`). One transient error adds about 250 ms. Five fast failures
   * end the read in about 3.75 seconds with an error result, which is polled
   * again. A read outlasts a 5 second `statusRequestTimeoutMs` only when all
   * four backoffs (3.75 seconds) plus the requests' own time pass it, when the
   * node sends a `Retry-After` of 5 seconds or more, or when one response is
   * slow. It then counts as stalled and the settlement is indeterminate at
   * once (liveness only, never a resubmission).
   */
  transactionRecordTimeoutMs?: number;
}

/** Immutable public recovery facts persisted before a pay-DEM broadcast. */
export interface PayDemPreparedTransfer {
  txHash: string;
  nonce: number;
  payer: string;
  payee: string;
  amountOs: string;
  /**
   * Wire denomination authenticated before broadcast for exact restart
   * reconciliation. Current SDK rails always provide it; optionality preserves
   * read compatibility with prepared checkpoints written by older prereleases.
   */
  denomination?: "os" | "dem";
  network: string;
  maxTotalDebitOs?: string;
  /** Confirmed transfer amount plus network fee, retained before broadcast. */
  confirmedTotalDebitOs?: string;
  /** Exact PC-7 session/phase identity when invoked through payDemSettle. */
  recovery?: Readonly<PayDemSettlementRecoveryContext>;
}

/** Fresh native-rail outcome. Success attests a bound, confirmed record. */
export type PayDemRailResult = SettleResult & (
  | { ok: true; execution: "executed" }
  | { ok: false; execution?: never }
);

export interface PayDemRail {
  /** The buyer's Demos address. */
  readonly address: string;
  /**
   * Settle one payment. Success requires reading the transaction record and
   * verifying literal `confirmed` status, hash, nonce, inclusion block, payer,
   * payee and amount, then returning `execution: "executed"`. Status-index
   * inclusion alone must return a not-ok outcome retaining the signed hash.
   * {@link payDemSettle} calls only the `settle` `createPayDemRail` returned
   * and refuses any other rail before calling it.
   */
  settle(
    params: PayDemSettleParams,
    effectFence?: Readonly<SettlementEffectFence>,
  ): Promise<PayDemRailResult>;
}

/**
 * Compatibility signal for integrations that separately wait for the payer's
 * account projection after finality. It is deliberately permanent: the payment
 * is already final and only idempotent SettlementEvidence catch-up may retry
 * (DACS-4 §9.5.1 PC-7). `createPayDemRail` now returns the successful payment
 * result in this case instead of throwing this signal.
 */
export class PayDemIncludedNonceVisibilityError extends DacsError {
  readonly txHash: string;
  readonly blockNumber?: number;
  readonly nonce: number;

  constructor(input: {
    txHash: string;
    blockNumber?: number;
    nonce: number;
    cause?: unknown;
  }) {
    super(
      `pay-dem: transfer ${input.txHash} was included, but account nonce ${input.nonce} ` +
        "did not become readable; payment is final and only evidence catch-up may be retried",
      { cause: input.cause },
    );
    this.name = "PayDemIncludedNonceVisibilityError";
    this.txHash = input.txHash;
    if (typeof input.blockNumber === "number" &&
        Number.isSafeInteger(input.blockNumber) && input.blockNumber >= 0) {
      this.blockNumber = input.blockNumber;
    }
    this.nonce = input.nonce;
  }
}

const OS_PER_DEM = 1_000_000_000n;

function confirmedFeeComponentOs(value: unknown, postFork: boolean): bigint | null {
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  if (!postFork && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    // Pre-denomination-fork fee numbers are DEM. Post-fork fee numbers are
    // ambiguous (the transaction query surface has projected other numeric
    // fields in OS), so a capped write accepts only the normative decimal-
    // string OS form after the fork.
    return BigInt(value) * OS_PER_DEM;
  }
  return null;
}

function confirmedTransactionFeeOs(value: unknown, postFork: boolean): bigint | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const fee = value as Record<string, unknown>;
  const network = confirmedFeeComponentOs(fee.network_fee, postFork);
  const rpc = confirmedFeeComponentOs(fee.rpc_fee, postFork);
  const additional = confirmedFeeComponentOs(fee.additional_fee, postFork);
  if (network === null || rpc === null || additional === null) return null;
  return network + rpc + additional;
}

function confirmedWireAmountOs(value: unknown, postFork: boolean): bigint | null {
  if (postFork) {
    return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
      ? BigInt(value)
      : null;
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value) * OS_PER_DEM
    : null;
}

function confirmedProjectedBodyAmountOs(
  value: unknown,
  postFork: boolean,
): bigint | null {
  if (
    postFork &&
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  ) {
    // After the denomination fork the transaction-query projection has been
    // observed returning `content.amount` as a numeric OS value, while the
    // signed payload retains the canonical decimal-string OS amount. Accept
    // that projection only for this outer confirmed field; the payload below
    // must still retain and independently bind the canonical string amount.
    return BigInt(value);
  }
  return confirmedWireAmountOs(value, postFork);
}

function confirmedValidityFeeOs(value: unknown, postFork: boolean): bigint | null {
  const data = (
    value as {
      response?: {
        data?: {
          gas_operation?: unknown;
          transaction?: { content?: Record<string, unknown> };
        };
      };
    }
  )?.response?.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;

  let fees: unknown;
  if (data.gas_operation == null) {
    fees = data.transaction?.content?.transaction_fee;
  } else {
    if (typeof data.gas_operation !== "object" || Array.isArray(data.gas_operation)) {
      return null;
    }
    const gasOperation = data.gas_operation as Record<string, unknown>;
    if (!Object.hasOwn(gasOperation, "fees") || gasOperation.fees == null) return null;
    fees = gasOperation.fees;
  }

  // demosdk's programmatic runner defines `gas_operation.fees` as the
  // authoritative post-fork fee view when present, falling back to the fee
  // carried on the confirmed transaction for nodes that return no gas
  // operation. Do not fall back when an authoritative fee object is present
  // but malformed: that would let a bad response bypass the spend ceiling.
  return confirmedTransactionFeeOs(fees, postFork);
}

function normalizedDemosAccount(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(?:0[xX])?([0-9a-fA-F]{64})$/);
  return match?.[1]?.toLowerCase() ?? null;
}

function confirmedNonce(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
      ? value
      : null;
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  try {
    const parsed = BigInt(value);
    return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null;
  } catch {
    return null;
  }
}

type BoundedPromiseResult<T> =
  | Readonly<{ status: "fulfilled"; value: T }>
  | Readonly<{ status: "rejected"; reason: unknown }>
  | Readonly<{ status: "timeout" }>;

/**
 * Bound a promise even when the underlying dependency ignores cancellation.
 * Both fulfilment and rejection handlers remain attached after a timeout, so a
 * late transport result cannot become an unhandled rejection. This deliberately
 * does not retry or duplicate the underlying operation.
 */
function boundedPromise<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<BoundedPromiseResult<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BoundedPromiseResult<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    operation.then(
      (value) => finish({ status: "fulfilled", value }),
      (reason: unknown) => finish({ status: "rejected", reason }),
    );
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ObservedDemosTerminal =
  | Readonly<{ state: "included"; blockNumber: number }>
  | Readonly<{ state: "failed"; blockNumber?: number }>
  | Readonly<{ state: "timeout" }>;

async function observeDemosTerminalByHash(
  txHash: string,
  nodeCall: (message: string, args: Record<string, unknown>) => Promise<unknown>,
  options: Readonly<{
    inclusionTimeoutMs: number;
    inclusionPollIntervalMs: number;
    statusRequestTimeoutMs: number;
  }>,
): Promise<ObservedDemosTerminal> {
  const deadline = Date.now() + options.inclusionTimeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: "timeout" };

    const request = Promise.resolve().then(() =>
      nodeCall("getTransactionStatus", { hash: txHash }));
    const result = await boundedPromise(
      request,
      Math.max(1, Math.min(options.statusRequestTimeoutMs, remaining)),
    );
    // Do not stack another status request on top of a transport that ignored
    // its bound. One unresolved RPC is already enough to make finality
    // indeterminate; additional reads would only accumulate live sockets.
    if (result.status === "timeout") return { state: "timeout" };
    if (result.status === "fulfilled") {
      let status: unknown;
      try {
        status = snapshotCanonicalJsonRead(
          result.value,
          "pay-dem independent transaction status",
        );
      } catch {
        status = undefined;
      }
      if (status !== null && typeof status === "object" && !Array.isArray(status)) {
        const record = status as Record<string, unknown>;
        if (record.state === "included") {
          const blockNumber = confirmedNonce(record.blockNumber);
          if (blockNumber !== null) return { state: "included", blockNumber };
        } else if (record.state === "failed") {
          const blockNumber = record.blockNumber === undefined
            ? undefined
            : confirmedNonce(record.blockNumber);
          if (blockNumber !== null) {
            return blockNumber === undefined
              ? { state: "failed" }
              : { state: "failed", blockNumber };
          }
        }
      }
    }

    const afterRead = deadline - Date.now();
    if (afterRead <= 0) return { state: "timeout" };
    await wait(Math.min(options.inclusionPollIntervalMs, afterRead));
  }
}

type TransactionIdentityBinding =
  | Readonly<{ status: "bound"; transaction: Record<string, unknown> }>
  | Readonly<{ status: "no-body" }>
  | Readonly<{ status: "hash-mismatch" }>
  | Readonly<{ status: "nonce-mismatch" }>;

/**
 * Bind a node-supplied transaction body to the signed transfer's hash and
 * nonce. Shared by the pre-broadcast confirmation and the post-inclusion
 * transaction record, so both are held to the same signed identity.
 */
function transactionIdentityBinding(
  transaction: unknown,
  input: Readonly<{ signedHash: string; signedNonce: number }>,
): TransactionIdentityBinding {
  if (transaction === null || typeof transaction !== "object" ||
      Array.isArray(transaction)) {
    return { status: "no-body" };
  }
  const candidate = transaction as Record<string, unknown>;
  const candidateHash = canonicalDemosTxHash(candidate.hash);
  if (candidateHash === null || candidateHash !== input.signedHash) {
    return { status: "hash-mismatch" };
  }
  const content = candidate.content;
  if (content === null || typeof content !== "object" || Array.isArray(content) ||
      confirmedNonce((content as Record<string, unknown>).nonce) !== input.signedNonce) {
    return { status: "nonce-mismatch" };
  }
  return { status: "bound", transaction: candidate };
}

function confirmedTransactionBinding(
  value: unknown,
  input: Readonly<{ signedHash: string; signedNonce: number }>,
): Record<string, unknown> {
  const data = (
    value as {
      response?: {
        data?: {
          transaction?: unknown;
        };
      };
    }
  )?.response?.data;
  const binding = transactionIdentityBinding(data?.transaction, input);
  if (binding.status === "no-body") {
    throw new DacsError(
      "pay-dem: confirmation has no stable transaction body; refusing broadcast",
    );
  }
  if (binding.status === "hash-mismatch") {
    throw new DacsError(
      "pay-dem: confirmed transaction hash does not match the signed transfer; refusing broadcast",
    );
  }
  if (binding.status === "nonce-mismatch") {
    throw new DacsError(
      "pay-dem: confirmed transaction nonce does not match the signed transfer; refusing broadcast",
    );
  }
  return binding.transaction;
}

function nativeTransferBodyMatches(
  transaction: Record<string, unknown>,
  input: Readonly<{
    payer: string;
    payee: string;
    amountOs: bigint;
    nonce: number;
    postFork: boolean;
  }>,
  source: "signed" | "confirmed",
): boolean {
  const content = transaction.content;
  if (content === null || typeof content !== "object" || Array.isArray(content)) {
    return false;
  }
  const body = content as Record<string, unknown>;
  if (
    body.type !== "native" ||
    body.custom_charges != null ||
    confirmedNonce(body.nonce) !== input.nonce
  ) {
    return false;
  }

  const expectedPayer = normalizedDemosAccount(input.payer);
  const expectedPayee = normalizedDemosAccount(input.payee);
  if (expectedPayer === null || expectedPayee === null) return false;
  const payerFields = [body.from, body.from_ed25519_address]
    .filter((field) => field != null);
  if (
    payerFields.length === 0 ||
    payerFields.some((field) => normalizedDemosAccount(field) !== expectedPayer) ||
    normalizedDemosAccount(body.to) !== expectedPayee ||
    (
      source === "confirmed"
        ? confirmedProjectedBodyAmountOs(body.amount, input.postFork)
        : confirmedWireAmountOs(body.amount, input.postFork)
    ) !== input.amountOs
  ) {
    return false;
  }

  const transactionData = body.data;
  if (
    !Array.isArray(transactionData) ||
    transactionData.length !== 2 ||
    transactionData[0] !== "native" ||
    transactionData[1] === null ||
    typeof transactionData[1] !== "object" ||
    Array.isArray(transactionData[1])
  ) {
    return false;
  }
  const native = transactionData[1] as Record<string, unknown>;
  const args = native.args;
  return native.nativeOperation === "send" &&
    Array.isArray(args) &&
    args.length === 2 &&
    normalizedDemosAccount(args[0]) === expectedPayee &&
    confirmedWireAmountOs(args[1], input.postFork) === input.amountOs;
}

function confirmedDebitFromValidity(
  value: unknown,
  input: Readonly<{
    payer: string;
    payee: string;
    amountOs: bigint;
    nonce: number;
    postFork: boolean;
  }>,
): bigint | null {
  const data = (
    value as {
      response?: {
        data?: {
          custom_charges?: unknown;
          transaction?: { content?: Record<string, unknown> };
        };
      };
    }
  )?.response?.data;
  const transaction = data?.transaction;
  if (
    !transaction ||
    data?.custom_charges != null ||
    !nativeTransferBodyMatches(
      transaction as Record<string, unknown>,
      input,
      "confirmed",
    )
  ) return null;

  const feeOs = confirmedValidityFeeOs(value, input.postFork);
  return feeOs === null ? null : input.amountOs + feeOs;
}

type ObservedDemosExecution =
  | Readonly<{ state: "executed" }>
  | Readonly<{ state: "failed" }>
  | Readonly<{ state: "indeterminate"; reason: string }>;

/**
 * Establish whether an included transaction executed (#338). The status index
 * can report `included` for a transaction the node recorded as `failed`, so read
 * the node's transaction record for the retained signed hash. Only a
 * `confirmed` record at the observed inclusion block whose body is exactly the
 * prepared transfer is execution. A `failed` record bound the same way is not
 * settled. A record that is missing, pending, unreadable or malformed, or that
 * carries another hash, is polled again within the budget; a stalled read, or
 * a confirmed or failed record for the signed hash whose nonce, block or body
 * does not bind the prepared transfer, is indeterminate at once. Like the
 * status poll, this never retries or duplicates the broadcast.
 *
 * Node semantics this relies on, verified against the kynesyslabs/node sources
 * `stabilisation@61b8e75aa8db5e408c49e1c3a89db4d673f45578` and
 * `stabilisation@52e2e5698bd9785ddd709de33e4709d5dd7bc308`. Until early on
 * 2026-10-20 node2 reported 61b8e75 at `GET /version` from a build its
 * `getNetworkInfo` marks `dirty`, so the deployed bytes were never pinned to
 * that commit; later that day it reported 11e7c82 after a chain reset. Only the
 * served shape below is recorded, and the recorded envelopes are historical:
 * - `getTransactionStatus` reports `included` for every stored row, failed ones
 *   included, and never produces `failed` (`src/libs/blockchain/chainTypes.ts`
 *   `TxStatus`, `chainTransactions.ts` `getTransactionStatus`);
 * - the record `status` is `confirmed`, `failed` or `pending`
 *   (`src/utilities/constants.ts` `TRANSACTION_STATUS`);
 * - `content.nonce` is a pg `bigint` column, so it is served as a decimal
 *   string (`src/model/entities/Transactions.ts`);
 * - `content.amount` is served as a number up to `Number.MAX_SAFE_INTEGER` and
 *   as a decimal string above it (`src/libs/blockchain/transaction.ts`
 *   `fromEntityToWireNumber`); both forms are accepted;
 * - not-found is `{result: 400, response: "error"}` at 61b8e75 and
 *   `{result: 404, response: null, extra: {reason: "not_found", …}}` at
 *   52e2e569 and at
 *   `11e7c8207732e25035de5a04cab25c5346046493`, which serves the same record
 *   shape and status handler; both are polled.
 * The default branch (`testnet`) had no `getTransactionStatus` on 2026-10-20. The recorded
 * node2 records in `test/fixtures/demos-node2-records.json` pin this shape,
 * and any other shape is indeterminate; see `docs/pay-dem-execution.md`.
 *
 * @internal Exported for tests; terminal failed-record proof is issued only
 * after these binding checks. Not re-exported from the rails
 * index or the package root.
 */
export async function observeDemosExecutionByHash(
  txHash: string,
  getTxByHash: (hash: string) => Promise<unknown>,
  expected: Readonly<{
    blockNumber: number;
    transfer: Readonly<{
      payer: string;
      payee: string;
      amountOs: bigint;
      nonce: number;
      postFork: boolean;
    }>;
  }>,
  options: Readonly<{
    transactionRecordTimeoutMs: number;
    inclusionPollIntervalMs: number;
    statusRequestTimeoutMs: number;
  }>,
): Promise<ObservedDemosExecution> {
  const deadline = Date.now() + options.transactionRecordTimeoutMs;
  let pending = "transaction record was not observed";
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: "indeterminate", reason: pending };

    const request = Promise.resolve().then(() => getTxByHash(txHash));
    const result = await boundedPromise(
      request,
      Math.max(1, Math.min(options.statusRequestTimeoutMs, remaining)),
    );
    // As with the status poll, never stack reads on a transport that ignored
    // its bound.
    if (result.status === "timeout") {
      return { state: "indeterminate", reason: "transaction record read timed out" };
    }
    if (result.status === "rejected") {
      pending = "transaction record read failed";
    } else {
      let snapshot: unknown;
      try {
        snapshot = snapshotCanonicalJsonRead(
          result.value,
          "pay-dem transaction record",
        );
      } catch {
        snapshot = undefined;
      }
      const identity = transactionIdentityBinding(snapshot, {
        signedHash: txHash,
        signedNonce: expected.transfer.nonce,
      });
      const record = snapshot as Record<string, unknown>;
      if (identity.status === "no-body" || identity.status === "hash-mismatch") {
        pending = "transaction record is missing or malformed";
      } else if (record.status === DEMOS_FAILED_RECORD_STATUS ||
          record.status === DEMOS_EXECUTED_RECORD_STATUS) {
        // A terminal status says something about this transfer only when the
        // record binds it, whether the status is `failed` or `confirmed`.
        if (identity.status !== "bound") {
          return {
            state: "indeterminate",
            reason: "transaction record does not bind the signed nonce",
          };
        }
        if (confirmedNonce(record.blockNumber) !== expected.blockNumber) {
          return {
            state: "indeterminate",
            reason: "transaction record block does not match the observed inclusion",
          };
        }
        if (!nativeTransferBodyMatches(
          identity.transaction,
          expected.transfer,
          "confirmed",
        )) {
          return {
            state: "indeterminate",
            reason: "transaction record does not match the prepared transfer",
          };
        }
        return record.status === DEMOS_FAILED_RECORD_STATUS
          ? { state: "failed" }
          : { state: "executed" };
      } else {
        pending = "transaction record has no terminal execution status";
      }
    }

    const afterRead = deadline - Date.now();
    if (afterRead <= 0) return { state: "indeterminate", reason: pending };
    await wait(Math.min(options.inclusionPollIntervalMs, afterRead));
  }
}

/**
 * Construct a pay-dem rail from a Demos RPC + wallet secret. Lazily imports
 * demosdk so the SDK core stays importable without the chain deps installed.
 * Submits via sign → confirm → durable preparation journal → one broadcast,
 * while independently observing inclusion and then execution (the node's
 * transaction record) by the signed hash.
 *
 * The low-level rail signs a fresh transaction on every call. The exported
 * runSession bridge, {@link payDemSettle}, therefore wraps it in the shared
 * session/phase-keyed settlement idempotency store (#43/#52).
 */
export async function createPayDemRail(config: PayDemRailConfig): Promise<PayDemRail> {
  const rpc = requiredStableString(config, "rpc", "pay-dem rail rpc");
  const secret = requiredStableString(config, "secret", "pay-dem rail secret");
  const network = optionalStableString(config, "network", "pay-dem rail network");
  const maxTotalDebitProperty = stableDataProperty(
    config,
    "maxTotalDebitOs",
    "pay-dem rail maxTotalDebitOs",
  );
  const configuredMaxTotalDebitOs = maxTotalDebitProperty.found
    ? maxTotalDebitProperty.value
    : undefined;
  if (configuredMaxTotalDebitOs !== undefined &&
      (typeof configuredMaxTotalDebitOs !== "bigint" || configuredMaxTotalDebitOs <= 0n)) {
    throw new DacsError("pay-dem rail maxTotalDebitOs must be positive");
  }
  const journalProperty = stableDataProperty(
    config,
    "journalPreparedTransfer",
    "pay-dem prepared-transfer journal",
  );
  const journalPreparedTransfer = !journalProperty.found ||
      journalProperty.value === undefined
    ? undefined
    : stableMethod<(
        transfer: Readonly<PayDemPreparedTransfer>,
      ) => Promise<void>>(
        config,
        "journalPreparedTransfer",
        "pay-dem prepared-transfer journal",
      );
  const inclusionTimeoutMs = optionalPositiveInteger(
    config,
    "inclusionTimeoutMs",
    "pay-dem inclusionTimeoutMs",
    DEFAULT_INCLUSION_TIMEOUT_MS,
  );
  const inclusionPollIntervalMs = optionalPositiveInteger(
    config,
    "inclusionPollIntervalMs",
    "pay-dem inclusionPollIntervalMs",
    DEFAULT_INCLUSION_POLL_INTERVAL_MS,
  );
  const statusRequestTimeoutMs = optionalPositiveInteger(
    config,
    "statusRequestTimeoutMs",
    "pay-dem statusRequestTimeoutMs",
    DEFAULT_STATUS_REQUEST_TIMEOUT_MS,
  );
  const nonceVisibilityTimeoutMs = optionalPositiveInteger(
    config,
    "nonceVisibilityTimeoutMs",
    "pay-dem nonceVisibilityTimeoutMs",
    DEFAULT_NONCE_VISIBILITY_TIMEOUT_MS,
  );
  const transactionRecordTimeoutMs = optionalPositiveInteger(
    config,
    "transactionRecordTimeoutMs",
    "pay-dem transactionRecordTimeoutMs",
    DEFAULT_TRANSACTION_RECORD_TIMEOUT_MS,
  );

  const { Demos } = await import("@kynesyslabs/demosdk/websdk");
  const demos = new Demos();
  // Capture the complete Demos authority before its first asynchronous call.
  // This supports ordinary class instances while rejecting accessors/proxies
  // that could swap the signer, confirmer, broadcaster, or nonce authority at
  // an await boundary.
  const connect = stableMethod<(rpcUrl: string) => Promise<unknown>>(
    demos,
    "connect",
    "pay-dem Demos.connect",
  );
  const connectWallet = stableMethod<(walletSecret: string) => Promise<unknown>>(
    demos,
    "connectWallet",
    "pay-dem Demos.connectWallet",
  );
  const getAddress = stableMethod<() => string>(
    demos,
    "getAddress",
    "pay-dem Demos.getAddress",
  );
  const transfer = stableMethod<(
    to: string,
    amountOs: bigint,
  ) => Promise<unknown>>(
    demos,
    "transfer",
    "pay-dem Demos.transfer",
  );
  const getNetworkInfo = stableMethod<() => Promise<unknown>>(
    demos,
    "getNetworkInfo",
    "pay-dem Demos.getNetworkInfo",
  );
  const broadcast = stableMethod<(validity: unknown) => Promise<unknown>>(
    demos,
    "broadcast",
    "pay-dem Demos.broadcast",
  );
  const nodeCall = stableMethod<(
    message: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>>(
    demos,
    "nodeCall",
    "pay-dem Demos.nodeCall",
  );
  const getTxByHash = stableMethod<(hash: string) => Promise<unknown>>(
    demos,
    "getTxByHash",
    "pay-dem Demos.getTxByHash",
  );
  const waitForNonce = stableMethod<(
    address: string,
    nonce: number,
  ) => Promise<unknown>>(
    demos,
    "waitForNonce",
    "pay-dem Demos.waitForNonce",
  );
  const txProperty = stableDataProperty(demos, "tx", "pay-dem Demos.tx");
  const confirm = stableMethod<(
    signed: unknown,
    client: unknown,
  ) => Promise<unknown>>(
    txProperty.value,
    "confirm",
    "pay-dem Demos.tx.confirm",
  );

  await connect(rpc);
  await connectWallet(secret);
  const address = getAddress();
  if (
    typeof address !== "string" ||
    address.length === 0 ||
    address.trim() !== address ||
    normalizedDemosAccount(address) === null
  ) {
    throw new DacsError("pay-dem wallet returned an invalid payer address");
  }

  const client: DemosNativeClient = {
    address,
    transfer: async ({
      to,
      amountOs,
      maxTotalDebitOs: invocationMaxTotalDebitOs,
      recovery,
      journalPreparedTransfer: invocationJournal,
      assertCurrentBeforeBroadcast,
      effectFence,
    }) => {
      if (configuredMaxTotalDebitOs !== undefined &&
          invocationMaxTotalDebitOs !== undefined &&
          invocationMaxTotalDebitOs > configuredMaxTotalDebitOs) {
        throw new DacsError(
          "pay-dem per-payment maximum total debit exceeds the rail ceiling",
        );
      }
      const effectiveMaxTotalDebitOs = invocationMaxTotalDebitOs ??
        configuredMaxTotalDebitOs;
      // The transaction is already signed. Demos nodes compare GCR edits via
      // order-sensitive JSON bytes, so JCS key sorting here would invalidate
      // an otherwise valid signature/confirmation payload.
      const signed = snapshotWireJsonRead(
        await transfer(to, amountOs),
        "pay-dem signed transfer",
      ) as unknown;
      const signedHashValue = requiredStableString(
        signed,
        "hash",
        "pay-dem signed transfer hash",
      );
      const signedHash = canonicalDemosTxHash(signedHashValue);
      if (signedHash === null) {
        throw new DacsError(
          "pay-dem: signed transfer hash must be a 32-byte hex value; refusing confirmation and broadcast",
        );
      }
      const signedContent = stableDataProperty(
        signed,
        "content",
        "pay-dem signed transfer content",
      ).value;
      const signedNonceValue = stableDataProperty(
        signedContent,
        "nonce",
        "pay-dem signed transfer nonce",
      ).value;
      if (
        !Number.isSafeInteger(signedNonceValue) ||
        (signedNonceValue as number) < 0
      ) {
        throw new DacsError(
          "pay-dem: signed transfer has no valid transaction nonce",
        );
      }
      const signedNonce = signedNonceValue as number;
      // Confirmation returns the exact validity envelope consumed by
      // broadcast. Own it without changing its byte-significant wire order.
      const validity = snapshotWireJsonRead(
        await confirm(signed, demos),
        "pay-dem confirmation",
      ) as unknown;
      const confirmedTransaction = confirmedTransactionBinding(
        validity,
        { signedHash, signedNonce },
      );
      const networkInfo = snapshotCanonicalJsonRead(
        await getNetworkInfo(),
        "pay-dem network information",
      ) as {
        forks?: { osDenomination?: { activated?: unknown } };
      };
      const forkActive = networkInfo?.forks?.osDenomination?.activated;
      if (typeof forkActive !== "boolean") {
        throw new DacsError(
          "pay-dem: denomination fork state is unavailable; refusing broadcast",
        );
      }
      const postFork = forkActive;
      const transferBinding = {
        payer: address,
        payee: to,
        amountOs,
        nonce: signedNonce,
        postFork,
      } as const;
      const confirmedData = (
        validity as {
          response?: { data?: { custom_charges?: unknown } };
        }
      )?.response?.data;
      if (
        !nativeTransferBodyMatches(
          signed as Record<string, unknown>,
          transferBinding,
          "signed",
        ) ||
        confirmedData?.custom_charges != null ||
        !nativeTransferBodyMatches(
          confirmedTransaction,
          transferBinding,
          "confirmed",
        )
      ) {
        throw new DacsError(
          "pay-dem: signed and confirmed transaction bodies do not bind the requested native transfer; refusing broadcast",
        );
      }
      const confirmedDebitOs = confirmedDebitFromValidity(validity, {
        ...transferBinding,
      });
      if (effectiveMaxTotalDebitOs !== undefined) {
        if (confirmedDebitOs === null) {
          throw new DacsError(
            "pay-dem: confirmed transaction has no unambiguous bound OS debit; refusing broadcast under maxTotalDebitOs",
          );
        }
        if (confirmedDebitOs > effectiveMaxTotalDebitOs) {
          throw new DacsError(
            "pay-dem: confirmed transaction exceeds maxTotalDebitOs; refusing broadcast",
          );
        }
      }
      // The node-confirmed body has already been required to retain the signed
      // hash and nonce, so this one identity is authoritative throughout
      // journalling, broadcast, finality observation, recovery and evidence.
      const txHash = signedHash;
      const canonicalPayer = normalizedDemosAccount(address)!;
      const canonicalPayee = normalizedDemosAccount(to)!;
      const prepared = Object.freeze({
        txHash,
        nonce: signedNonce,
        payer: canonicalPayer,
        payee: canonicalPayee,
        amountOs: amountOs.toString(),
        denomination: postFork ? "os" : "dem",
        network: network ?? "demos",
        ...(effectiveMaxTotalDebitOs === undefined
          ? {}
          : { maxTotalDebitOs: effectiveMaxTotalDebitOs.toString() }),
        ...(confirmedDebitOs === null
          ? {}
          : { confirmedTotalDebitOs: confirmedDebitOs.toString() }),
        ...(recovery === undefined ? {} : { recovery }),
      }) satisfies Readonly<PayDemPreparedTransfer>;

      // This is the last operation before the only irreversible call. A funded
      // runner's hook fsyncs hash + nonce and the already-validated immutable
      // transfer facts. Any journal failure aborts before broadcast.
      const preparedJournal = invocationJournal ?? journalPreparedTransfer;
      if (preparedJournal) await preparedJournal(prepared);
      if (assertCurrentBeforeBroadcast) await assertCurrentBeforeBroadcast();

      // Start exactly one submission. Do not await the HTTP response: demosdk's
      // transport has no request timeout, so the response can remain pending
      // after the transaction has already landed. The attached handlers absorb a
      // late fulfilment/rejection; inclusion is established independently below
      // from the pre-journaled signed hash, and ambiguity never authorises a
      // second submission.
      await effectFence?.assertCurrent();
      const broadcastAttempt = Promise.resolve().then(() => broadcast(validity));
      void broadcastAttempt.then(
        () => undefined,
        () => undefined,
      );

      const terminal = await observeDemosTerminalByHash(txHash, nodeCall, {
        inclusionTimeoutMs,
        inclusionPollIntervalMs,
        statusRequestTimeoutMs,
      });
      if (terminal.state === "timeout") {
        return {
          ok: false,
          state: "timeout",
          hash: txHash,
          message: "pay-dem inclusion was not observed before the hash-first timeout",
        };
      }
      if (terminal.state === "failed") {
        return {
          ok: false,
          state: "failed",
          hash: txHash,
          ...(terminal.blockNumber === undefined
            ? {}
            : { blockNumber: terminal.blockNumber }),
        };
      }

      // `included` is not execution (#338): the node can include the signed
      // transaction and record it failed. Require the transaction record to
      // show this exact prepared transfer executed before reporting success.
      const execution = await observeDemosExecutionByHash(
        txHash,
        getTxByHash,
        { blockNumber: terminal.blockNumber, transfer: transferBinding },
        {
          transactionRecordTimeoutMs,
          inclusionPollIntervalMs,
          statusRequestTimeoutMs,
        },
      );
      if (execution.state === "failed") {
        return {
          ok: false,
          state: "failed",
          hash: txHash,
          blockNumber: terminal.blockNumber,
          failureProof: {
            kind: "demos-failed-record",
            txHash, nonce: signedNonce, blockNumber: terminal.blockNumber,
            payer: canonicalPayer, payee: canonicalPayee,
            amountOs: amountOs.toString(),
          },
          message: "pay-dem transaction was included but its record reports it failed",
        };
      }
      if (execution.state === "indeterminate") {
        return {
          ok: false,
          state: "indeterminate",
          hash: txHash,
          message: `pay-dem execution was not established: ${execution.reason}`,
        };
      }

      // Inclusion can precede the account read reflecting the consumed nonce.
      // Bound even a non-cooperative projection read. DACS-4 §9.5.1 PC-7 makes
      // the executed payment final regardless: a lag may delay only idempotent
      // evidence-anchor bookkeeping and can never authorise resubmission.
      await boundedPromise(
        Promise.resolve().then(() => waitForNonce(address, signedNonce)),
        nonceVisibilityTimeoutMs,
      );

      return {
        ok: true,
        state: "included",
        execution: "executed",
        hash: txHash,
        blockNumber: terminal.blockNumber,
        ...(confirmedDebitOs === null
          ? {}
          : { totalDebitOs: confirmedDebitOs.toString() }),
      };
    },
  };

  const settle: PayDemRail["settle"] = async (params, effectFence) => {
    const invocationJournal = stableDataProperty(
      params,
      "journalPreparedTransfer",
      "pay-dem per-settlement prepared-transfer journal",
    );
    if (journalPreparedTransfer !== undefined && invocationJournal.found &&
        invocationJournal.value !== undefined) {
      throw new DacsError(
        "pay-dem cannot combine configured and per-settlement prepared-transfer journals",
      );
    }
    return payDemSettleCore(
      params,
      client,
      network ?? "demos",
      effectFence,
    );
  };
  // This client's verdicts come only from the record it read above, so
  // payDemSettleCore may report them as final, and payDemSettle may let the
  // settlement store keep this settle's failure proof as the definitive outcome.
  // Neither object is reachable outside this function except `settle` itself.
  sdkRecordReadingClients.add(client);
  sdkRecordReadingSettles.add(settle);
  return {
    address: client.address,
    settle,
  };
}

/**
 * Whether `rail`'s `settle` is the one `createPayDemRail` returned: the only
 * rail whose success the SDK can make final. A host checks this before calling
 * `settle`, so it never debits through a rail whose result it would have to
 * hold. Read-only.
 */
export function isPayDemRecordVerifyingRail(rail: unknown): boolean {
  let settle: AnyMethod;
  try {
    settle = stableMethodTarget(rail, "settle", "pay-dem rail settle");
  } catch {
    return false;
  }
  return sdkRecordReadingSettles.has(settle);
}

const PAY_DEM_RESULT_KEYS = new Set([
  "ok",
  "txHash",
  "chainId",
  "payer",
  "payee",
  "finality",
  "blockNumber",
  "txRefKind",
  "networkFeeOs",
  "errorClass",
  "failureProof",
]);

function sameRecoveryContext(
  left: Readonly<PayDemSettlementRecoveryContext>,
  right: Readonly<PayDemSettlementRecoveryContext>,
): boolean {
  return left.railId === right.railId &&
    left.jobId === right.jobId &&
    left.phaseIndex === right.phaseIndex &&
    left.settlementKey === right.settlementKey &&
    left.network === right.network &&
    left.payer === right.payer &&
    left.payee === right.payee &&
    left.amountOs === right.amountOs;
}

function sameFailureProof(left: SettleResult, right: SettleResult): boolean {
  return left.failureProof === undefined || right.failureProof === undefined
    ? left.failureProof === right.failureProof
    : canonicalize(left.failureProof) === canonicalize(right.failureProof);
}

function samePayDemResult(left: SettleResult, right: SettleResult): boolean {
  return left.ok === right.ok &&
    left.errorClass === right.errorClass &&
    sameFailureProof(left, right) &&
    left.txHash === right.txHash &&
    left.chainId === right.chainId &&
    left.payer === right.payer &&
    left.payee === right.payee &&
    left.finality?.model === right.finality?.model &&
    left.finality?.finalityBlocks === right.finality?.finalityBlocks &&
    left.blockNumber === right.blockNumber &&
    left.txRefKind === right.txRefKind &&
    left.networkFeeOs === right.networkFeeOs;
}

function capturePayDemResult(
  value: unknown,
  context: Readonly<PayDemSettlementRecoveryContext>,
  label: string,
): SettleResult {
  let snapshot: unknown;
  try {
    snapshot = snapshotCanonicalJsonRead(value, label);
  } catch (cause) {
    throw new DacsError(`${label} must be stable canonical settlement data`, {
      cause,
    });
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new DacsError(`${label} must be a settlement result object`);
  }
  const result = snapshot as Record<string, unknown>;
  if (
    Object.keys(result).some((key) => !PAY_DEM_RESULT_KEYS.has(key)) ||
    typeof result.ok !== "boolean" ||
    typeof result.txHash !== "string" ||
    typeof result.chainId !== "string" ||
    typeof result.payer !== "string" ||
    typeof result.payee !== "string"
  ) {
    throw new DacsError(`${label} has a malformed pay-dem settlement shape`);
  }

  const txHash = result.txHash.length === 0
    ? ""
    : canonicalDemosTxHash(result.txHash);
  if (txHash === null) {
    throw new DacsError(`${label} has a malformed Demos transaction hash`);
  }
  const payer =
    demosAddressFromClaim(result.payer) ??
    normalizeDemosNativeAddress(result.payer);
  const payee =
    demosAddressFromClaim(result.payee) ??
    normalizeDemosNativeAddress(result.payee);
  if (
    result.chainId !== context.network ||
    payer !== context.payer ||
    payee !== context.payee
  ) {
    throw new DacsError(
      `${label} does not bind the exact pay-dem network, payer, and payee`,
    );
  }

  if ((result.errorClass !== undefined || result.failureProof !== undefined) &&
      !hasDefinitiveDemosFailure(result as unknown as SettleResult, context.amountOs, context.network)) {
    throw new DacsError(`${label} has an invalid terminal-failure proof`);
  }
  const blockNumber = result.blockNumber;
  if (
    blockNumber !== undefined &&
    (!Number.isSafeInteger(blockNumber) || (blockNumber as number) < 0)
  ) {
    throw new DacsError(`${label} has an invalid Demos block number`);
  }
  if (result.txRefKind !== undefined && result.txRefKind !== "demos") {
    throw new DacsError(`${label} has a non-Demos transaction reference`);
  }
  const networkFeeOs = result.networkFeeOs;
  if (networkFeeOs !== undefined &&
      (typeof networkFeeOs !== "string" ||
        !/^(?:0|[1-9][0-9]*)$/.test(networkFeeOs))) {
    throw new DacsError(`${label} has invalid Demos network-fee accounting`);
  }

  if (result.ok) {
    if (
      txHash.length === 0 ||
      blockNumber === undefined ||
      result.txRefKind !== "demos" ||
      result.finality === null ||
      typeof result.finality !== "object" ||
      Array.isArray(result.finality)
    ) {
      throw new DacsError(
        `${label} success lacks canonical tx identity, block evidence, or bft-final finality`,
      );
    }
    const finality = result.finality as Record<string, unknown>;
    if (
      Object.keys(finality).length !== 1 ||
      finality.model !== "bft-final"
    ) {
      throw new DacsError(
        `${label} success must carry exact Demos bft-final finality`,
      );
    }
  } else if (result.finality !== undefined) {
    throw new DacsError(`${label} failure must not claim settlement finality`);
  }

  return {
    ok: result.ok,
    ...(result.errorClass === "permanent" ? { errorClass: "permanent" as const,
      failureProof: result.failureProof as DemosFailedRecordProof } : {}),
    txHash,
    chainId: context.network,
    payer: context.payer,
    payee: context.payee,
    ...(result.finality === undefined
      ? {}
      : { finality: { model: "bft-final" as const } }),
    ...(blockNumber === undefined ? {} : { blockNumber: blockNumber as number }),
    ...(result.txRefKind === undefined ? {} : { txRefKind: "demos" }),
    ...(networkFeeOs === undefined ? {} : { networkFeeOs }),
  };
}

function capturePayDemReconciliation(
  value: unknown,
  context: Readonly<PayDemSettlementRecoveryContext>,
): SettleResult {
  const snapshot = snapshotCanonicalJsonRead(
    value,
    "pay-dem reconciliation result",
  );
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new DacsError("pay-dem reconciliation must return a settlement object or null");
  }
  const record = snapshot as Record<string, unknown>;
  if (
    typeof record.amountOs !== "string" ||
    record.amountOs !== context.amountOs
  ) {
    throw new DacsError(
      "pay-dem reconciliation does not bind the exact requested OS amount",
    );
  }
  const settlement = { ...record };
  delete settlement.amountOs;
  delete settlement.execution;
  const captured = capturePayDemResult(
    settlement,
    context,
    "pay-dem reconciliation result",
  );
  if (!captured.ok && !hasDefinitiveDemosFailure(captured, context.amountOs, context.network)) {
    throw new DacsError(
      "pay-dem reconciliation is indeterminate; a definitive finalized result is required",
    );
  }
  // Inclusion is not execution (#338): a reconciler written when `included`
  // alone meant success must not turn an included-but-failed transfer into a
  // settlement on recovery.
  if (!captured.ok && record.execution !== undefined) {
    throw new DacsError("pay-dem permanent failure must not attest successful execution");
  }
  if (captured.ok && record.execution !== "executed") {
    throw new DacsError(
      "pay-dem reconciliation does not attest that the transaction record shows the transfer executed (#338); refusing reuse or rebroadcast",
    );
  }
  return captured;
}

function captureFreshPayDemResult(
  value: unknown,
  context: Readonly<PayDemSettlementRecoveryContext>,
): SettleResult {
  const snapshot = snapshotCanonicalJsonRead(value, "fresh pay-dem settlement");
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new DacsError("fresh pay-dem settlement must be a settlement result object");
  }
  const { execution, ...settlement } = snapshot as Record<string, unknown>;
  const captured = capturePayDemResult(settlement, context, "fresh pay-dem settlement");
  if (captured.ok && execution !== "executed") {
    throw new DacsError("fresh pay-dem settlement does not attest executed transaction record; refusing success or rebroadcast");
  }
  if (!captured.ok && execution !== undefined) {
    throw new DacsError("failed pay-dem settlement must not attest successful execution");
  }
  // The attestation authenticates this invocation, not a durable cache entry.
  return captured;
}

/**
 * Bridge a PayDemRail to the runSession `settle` seam.
 *
 * DESTINATION (legacy safety guard, not PB-2 conformance): the transfer
 * destination is derived from the request's `req.payee` — the seller primary
 * claim carried from the Listing into the buyer-signed legacy Agreement — never
 * from separate config. A Demos primary claim intrinsically resolves to the
 * address, so the runtime request cannot redirect payment to an unrelated key.
 * `cfg.recipient` is therefore an optional CROSS-CHECK: if it disagrees with the
 * agreement's payee the settle ABORTS **before** any transfer, rather than paying
 * a third address while returning evidence for the session price.
 *
 * This is a guard on the current §9.5.1-legacy `AgreementDocument` path — NOT
 * PB-1..PB-3 conformance, which apply to a `PayeeBoundAgreementDocument` whose
 * destination is selected from a signed `terms.payoutBindings`. The
 * payee-bound-artifact path is separate follow-up work; here `req.payee` is the
 * listing seller carried through the fixed-price agreement.
 *
 * SAFE BY DEFAULT (#43/#52): settlement is submitted at most once per
 * `(railId, jobId, phaseIndex)`. The default store protects concurrent and
 * same-process retries; inject a durable store and reconcile capability for
 * restart/crash recovery.
 *
 * The seam is also the DEM converter (§9.5.9 step 2): the agreement's
 * `Price.amount` is a canonical DECIMAL DEM string (e.g. "5" or "5.1"), but the
 * chain moves integer OS base units (1 DEM = 10^9 OS). This asserts the currency
 * is DEM and converts decimal → OS before handing off to the rail — WITHOUT this,
 * "5" DEM was submitted as 5 OS (a billionth of the agreed amount), settled silently.
 */
export function payDemSettle(
  rail: PayDemRail,
  cfg: {
    recipient?: string;
    network?: string;
    /** Exact registry descriptor id when dispatched through settleFromRail. */
    railId?: string;
    /** Exact payment invocation selected from the committed pipeline. */
    phaseIndex?: number;
  } = {},
  opts: {
    store?: SettlementIdempotencyStore;
    reconcile?: PayDemSettlementReconcile;
  } = {},
): (req: SettleRequest) => Promise<SettleResult> {
  const storeProperty = stableDataProperty(
    opts,
    "store",
    "pay-dem settlement store",
  );
  const store = !storeProperty.found || storeProperty.value === undefined
    ? createIdempotencyStore()
    : storeProperty.value as SettlementIdempotencyStore;
  const storeOnce = stableMethod<SettlementIdempotencyStore["once"]>(
    store,
    "once",
    "pay-dem settlement store once",
  );
  const configuredRecipient = optionalStableString(
    cfg,
    "recipient",
    "pay-dem configured recipient",
  );
  const network = optionalStableString(
    cfg,
    "network",
    "pay-dem configured network",
  ) ?? "demos";
  const configuredRailId = optionalStableString(
    cfg,
    "railId",
    "pay-dem configured railId",
  );
  const configuredPhaseProperty = stableDataProperty(
    cfg,
    "phaseIndex",
    "pay-dem configured phaseIndex",
  );
  let configuredPhaseIndex: number | undefined;
  if (configuredPhaseProperty.found && configuredPhaseProperty.value !== undefined) {
    if (
      typeof configuredPhaseProperty.value !== "number" ||
      !Number.isSafeInteger(configuredPhaseProperty.value) ||
      configuredPhaseProperty.value < 0
    ) {
      throw new DacsError(
        "pay-dem configured phaseIndex must be a non-negative safe integer",
      );
    }
    configuredPhaseIndex = configuredPhaseProperty.value;
  }
  const railAddress = requiredStableString(
    rail,
    "address",
    "pay-dem rail payer address",
  );
  const payerAddress =
    demosAddressFromClaim(railAddress) ??
    normalizeDemosNativeAddress(railAddress);
  if (payerAddress === null) {
    throw new DacsError("pay-dem rail returned an invalid native payer address");
  }
  const railSettleTarget = stableMethodTarget(
    rail,
    "settle",
    "pay-dem rail settle",
  );
  const railSettle = Function.prototype.bind.call(
    railSettleTarget,
    rail,
  ) as PayDemRail["settle"];
  // Only createPayDemRail's own settle reads and binds the transaction record
  // itself. Any other rail could never settle, so its settle is never called
  // for a fresh attempt (`submit` below). The bridge is still built around it,
  // so a payment it already made reconciles.
  const recordVerifiedRail = sdkRecordReadingSettles.has(railSettleTarget);
  const reconcileProperty = stableDataProperty(
    opts,
    "reconcile",
    "pay-dem reconciliation",
  );
  const reconcile = !reconcileProperty.found || reconcileProperty.value === undefined
    ? undefined
    : stableMethod<PayDemSettlementReconcile>(
        opts,
        "reconcile",
        "pay-dem reconciliation",
      );
  // An in-memory authority cache distinguishes a result produced or
  // reconciled by this exact bridge from a result returned immediately by an
  // injected durable store. After restart the cache is empty, so a cached
  // outcome is independently reconciled against the full amount/address tuple
  // before reuse. This prevents a `(railId, jobId, phaseIndex)` collision from
  // inheriting a result for different committed terms.
  const authenticatedResults = new Map<
    string,
    Readonly<{
      context: Readonly<PayDemSettlementRecoveryContext>;
      result: SettleResult;
    }>
  >();
  return async (req) => {
    const {
      amount,
      asset,
      expectedPayee,
      jobId,
      payee,
      phase,
      rail: railId,
    } = req;
    if (phase !== "pay-dem") {
      throw new DacsError(
        `pay-dem executor requires phase "pay-dem", got "${phase}"`,
      );
    }
    if (configuredRailId !== undefined && railId !== configuredRailId) {
      throw new DacsError(
        `pay-dem request rail "${railId}" does not match authenticated descriptor "${configuredRailId}"`,
      );
    }
    if (req.phaseIndex === undefined) {
      throw new DacsError(
        "pay-dem request must carry the exact phaseIndex required by PC-2 and SB-1",
      );
    }
    const phaseIndex = req.phaseIndex;
    if (
      configuredPhaseIndex !== undefined &&
      phaseIndex !== configuredPhaseIndex
    ) {
      throw new DacsError(
        `pay-dem request phaseIndex ${phaseIndex} does not match configured phaseIndex ${configuredPhaseIndex}`,
      );
    }
    if (asset !== DEM_CURRENCY) {
      throw new DacsError(
        `pay-dem settles ${DEM_CURRENCY} only, got asset "${asset}" (§9.5.9)`,
      );
    }
    // Destination guard: resolve the address from the agreement's payee claim.
    const payeeAddress = demosAddressFromClaim(payee);
    if (!payeeAddress) {
      throw new DacsError(
        `pay-dem: payee "${payee}" does not intrinsically resolve to a Demos ` +
          `address; refusing to transfer`,
      );
    }
    const expectedPayeeAddress =
      demosAddressFromClaim(expectedPayee) ??
      normalizeDemosNativeAddress(expectedPayee);
    if (expectedPayeeAddress !== payeeAddress) {
      throw new DacsError(
        `pay-dem destination mismatch: request binds ${expectedPayee}, agreement claim resolves to ${payeeAddress}`,
      );
    }
    // A configured recipient may only CONFIRM the agreement's payee, never replace it.
    if (configuredRecipient) {
      const configured =
        demosAddressFromClaim(configuredRecipient) ??
        normalizeDemosNativeAddress(configuredRecipient);
      if (!configured) {
        throw new DacsError(
          "pay-dem: configured recipient is not a Demos claim or native address (PB-2)",
        );
      }
      if (configured !== payeeAddress) {
        throw new DacsError(
          `pay-dem destination mismatch: configured recipient "${configuredRecipient}" is not the ` +
            `agreement payee "${payee}"; refusing to transfer`,
        );
      }
    }
    // Decimal DEM → integer OS base units (string/integer math, no float).
    // baseUnits also rejects sub-OS precision (> 9 fractional digits).
    const amountOs = baseUnits(amount, DEM_DECIMALS);
    if (amountOs === "0") {
      throw new DacsError(`pay-dem: amount must be > 0 (got ${amount})`);
    }
    const key = settlementKey(railId, jobId, phaseIndex);
    const context = Object.freeze({
      railId,
      jobId,
      phaseIndex,
      settlementKey: key,
      network,
      payer: payerAddress,
      payee: payeeAddress,
      amountOs,
    }) satisfies Readonly<PayDemSettlementRecoveryContext>;
    const priorAuthenticated = authenticatedResults.get(key);
    if (
      priorAuthenticated !== undefined &&
      !sameRecoveryContext(priorAuthenticated.context, context) &&
      priorAuthenticated.result.txHash.length > 0
    ) {
      throw new DacsError(
        "pay-dem retained intent/outcome belongs to different payment terms; refusing reconciliation or rebroadcast",
      );
    }
    const binding = Object.freeze({
      bindingVersion: "1",
      railId,
      jobId,
      phaseIndex,
      phase,
      amount: amountOs,
      agreementAsset: asset,
      settlementAsset: DEM_CURRENCY,
      payer: payerAddress,
      payee: payeeAddress,
      network,
      finality: Object.freeze({ model: "bft-final" }),
    }) satisfies Readonly<SettlementBinding>;
    const submit = async (
      effectFence?: Readonly<SettlementEffectFence>,
    ): Promise<SettleResult | SettlementNotInvokedResult> => {
      // Decide before the effect: the store calls submit only for a fresh
      // attempt or a reconciler-granted replay, never to recover a retained
      // one. Nothing runs, so the store releases the key rather than hold it.
      if (!recordVerifiedRail) {
        return Object.freeze({
          disposition: "not-invoked" as const,
          result: Object.freeze({
            ok: false,
            txHash: "",
            chainId: network,
            payer: payerAddress,
            payee: payeeAddress,
          }),
        });
      }
      const submitted = await railSettle({
        recipient: payeeAddress,
        amount: amountOs,
        network,
        recovery: context,
      }, effectFence);
      const captured = captureFreshPayDemResult(submitted, context);
      authenticatedResults.set(key, { context, result: captured });
      return captured;
    };
    if (recordVerifiedRail) sdkRecordReadingSubmissions.add(submit);
    const reconcileForStore: SettlementReconcile | undefined = reconcile === undefined
      ? undefined
      : async (reconcileKey) => {
          if (reconcileKey !== key) {
            throw new DacsError(
              "pay-dem idempotency store requested reconciliation under a different settlement key",
            );
          }
          const found = await reconcile(context);
          if (found === null) return null;
          const captured = capturePayDemReconciliation(found, context);
          authenticatedResults.set(key, { context, result: captured });
          return captured;
        };
    const result = await storeOnce(
      key,
      binding,
      submit,
      reconcileForStore,
    );
    let captured = capturePayDemResult(
      result,
      context,
      "cached or completed pay-dem settlement",
    );
    // This rail's settle is never called, so a result with no transaction is
    // submit's refusal: this call's, or a concurrent call's it shared.
    if (!recordVerifiedRail && !captured.ok && captured.txHash === "") {
      throw new DacsError(
        "pay-dem rail settle must be the one createPayDemRail returned: another rail's result could never be final; refusing",
      );
    }
    const known = authenticatedResults.get(key);
    if (
      known === undefined ||
      !sameRecoveryContext(known.context, context) ||
      !samePayDemResult(known.result, captured)
    ) {
      if (reconcile === undefined) {
        throw new DacsError(
          "pay-dem durable outcome cannot be authenticated after restart without reconciliation; refusing reuse or rebroadcast",
        );
      }
      const recovered = await reconcile(context);
      if (recovered === null) {
        throw new DacsError(
          "pay-dem durable outcome contradicts reconciliation proof of absence; refusing reuse or rebroadcast",
        );
      }
      const reconciled = capturePayDemReconciliation(recovered, context);
      if (
        reconciled.txHash !== captured.txHash ||
        reconciled.blockNumber !== captured.blockNumber
      ) {
        throw new DacsError(
          "pay-dem durable outcome does not match the authoritative reconciled transaction",
        );
      }
      // The same transaction recorded as executed in one place and failed in
      // the other (or failed under another proof) is a contradiction, not a
      // reason to prefer the reconciliation over the durable outcome.
      if (
        reconciled.ok !== captured.ok ||
        reconciled.errorClass !== captured.errorClass ||
        !sameFailureProof(reconciled, captured)
      ) {
        throw new DacsError(
          "pay-dem durable outcome contradicts the authoritative reconciled outcome; refusing reuse or rebroadcast",
        );
      }
      authenticatedResults.set(key, { context, result: reconciled });
      captured = reconciled;
    }
    // The low-level native rail reports the exact on-chain address. The public
    // settlement seam must return the request-bound identifier verbatim so the
    // orchestrator can check it without applying rail-specific normalization.
    // Verify the equivalence here before restoring that identifier.
    const resultPayeeAddress =
      demosAddressFromClaim(captured.payee) ??
      normalizeDemosNativeAddress(captured.payee);
    if (resultPayeeAddress !== payeeAddress) {
      throw new DacsError(
        `pay-dem settlement returned payee ${captured.payee}, expected Demos address ${payeeAddress}`,
      );
    }
    return Object.freeze({
      ...captured,
      payee: expectedPayee,
      ...(captured.finality === undefined
        ? {}
        : { finality: Object.freeze({ ...captured.finality }) }),
    });
  };
}
