import { dirname } from "node:path";
import { types as nodeTypes } from "node:util";

import {
  PayDemIncludedNonceVisibilityError,
  type PayDemPreparedTransfer,
} from "../../src/rails/payDem.js";
import {
  executeFundedRun,
  openFundedRun,
  readFundedRunCheckpoint,
  recordFundedRunCheckpoint,
  recordFundedRunOutcome,
  type ArmedFundedRun,
} from "./funded-run-marker.js";

const INTEGER_RE = /^[1-9][0-9]{0,31}$/;
const ADDRESS_RE = /^(?:0[xX])?([0-9a-fA-F]{64})$/;
const TX_HASH_RE = /^(?:0[xX])?([0-9a-fA-F]{64})$/;
const PREPARED_CHECKPOINT = "pay-dem-prepared";

export interface PayDemFundedRunIntent {
  directory: string;
  runId: string;
  payer: string;
  payee: string;
  amountOs: string;
  maxTotalDebitOs: string;
  network: "demos";
}

export type PayDemFundedRunOutcome =
  | { status: "included"; txHash: string; blockNumber: number }
  | {
      status: "unresolved";
      reason: "inclusion-not-observed";
      txHash?: string;
    };

export interface PayDemFundedPreparedTransfer {
  txHash: string;
  nonce: number;
  payer: string;
  payee: string;
  amountOs: string;
  maxTotalDebitOs: string;
  network: "demos";
}

export type PayDemPreparedTransferJournal = (
  prepared: Readonly<PayDemPreparedTransfer>,
) => Promise<void>;

function snapshotDataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      nodeTypes.isProxy(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string")) {
      return undefined;
    }
    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (!descriptor.enumerable || !("value" in descriptor) ||
          descriptor.value === undefined) return undefined;
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function canonicalAddress(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(`pay-dem-live:${code}-invalid`);
  const match = value.match(ADDRESS_RE);
  if (!match) throw new Error(`pay-dem-live:${code}-invalid`);
  return match[1]!.toLowerCase();
}

function canonicalTxHash(value: unknown, code = "outcome"): string {
  if (typeof value !== "string") {
    throw new Error(`pay-dem-live:${code}-tx-hash-invalid`);
  }
  const match = value.match(TX_HASH_RE);
  if (!match) throw new Error(`pay-dem-live:${code}-tx-hash-invalid`);
  return match[1]!.toLowerCase();
}

function captureIntent(value: unknown): PayDemFundedRunIntent {
  const snapshot = snapshotDataRecord(value);
  if (!snapshot || !exactKeys(snapshot, [
    "directory",
    "runId",
    "payer",
    "payee",
    "amountOs",
    "maxTotalDebitOs",
    "network",
  ]) || typeof snapshot.directory !== "string" ||
      typeof snapshot.runId !== "string" || snapshot.network !== "demos" ||
      typeof snapshot.amountOs !== "string" || !INTEGER_RE.test(snapshot.amountOs) ||
      typeof snapshot.maxTotalDebitOs !== "string" ||
      !INTEGER_RE.test(snapshot.maxTotalDebitOs)) {
    throw new Error("pay-dem-live:funded-intent-invalid");
  }
  if (BigInt(snapshot.maxTotalDebitOs) < BigInt(snapshot.amountOs)) {
    throw new Error("pay-dem-live:max-total-debit-below-amount");
  }
  return {
    directory: snapshot.directory,
    runId: snapshot.runId,
    payer: canonicalAddress(snapshot.payer, "marker-payer"),
    payee: canonicalAddress(snapshot.payee, "marker-payee"),
    amountOs: snapshot.amountOs,
    maxTotalDebitOs: snapshot.maxTotalDebitOs,
    network: "demos",
  };
}

function capturePreparedTransfer(
  value: unknown,
  intent: Readonly<Pick<
    PayDemFundedRunIntent,
    "payer" | "payee" | "amountOs" | "maxTotalDebitOs" | "network"
  >>,
): PayDemFundedPreparedTransfer {
  const snapshot = snapshotDataRecord(value);
  if (!snapshot || !exactKeys(snapshot, [
    "txHash",
    "nonce",
    "payer",
    "payee",
    "amountOs",
    "maxTotalDebitOs",
    "network",
  ]) || !Number.isSafeInteger(snapshot.nonce) || (snapshot.nonce as number) < 0 ||
      Object.is(snapshot.nonce, -0) || typeof snapshot.amountOs !== "string" ||
      !INTEGER_RE.test(snapshot.amountOs) ||
      typeof snapshot.maxTotalDebitOs !== "string" ||
      !INTEGER_RE.test(snapshot.maxTotalDebitOs) || snapshot.network !== "demos") {
    throw new Error("pay-dem-live:prepared-transfer-invalid");
  }
  const prepared = {
    txHash: canonicalTxHash(snapshot.txHash, "prepared"),
    nonce: snapshot.nonce as number,
    payer: canonicalAddress(snapshot.payer, "prepared-payer"),
    payee: canonicalAddress(snapshot.payee, "prepared-payee"),
    amountOs: snapshot.amountOs,
    maxTotalDebitOs: snapshot.maxTotalDebitOs,
    network: "demos" as const,
  };
  if (
    prepared.payer !== intent.payer ||
    prepared.payee !== intent.payee ||
    prepared.amountOs !== intent.amountOs ||
    prepared.maxTotalDebitOs !== intent.maxTotalDebitOs ||
    prepared.network !== intent.network
  ) {
    throw new Error("pay-dem-live:prepared-transfer-intent-mismatch");
  }
  return prepared;
}

function captureOutcome(value: unknown): PayDemFundedRunOutcome {
  const snapshot = snapshotDataRecord(value);
  if (!snapshot || typeof snapshot.status !== "string") {
    throw new Error("pay-dem-live:outcome-invalid");
  }
  if (snapshot.status === "included" &&
      exactKeys(snapshot, ["status", "txHash", "blockNumber"]) &&
      Number.isSafeInteger(snapshot.blockNumber) &&
      (snapshot.blockNumber as number) >= 0) {
    return {
      status: "included",
      txHash: canonicalTxHash(snapshot.txHash),
      blockNumber: snapshot.blockNumber as number,
    };
  }
  if (snapshot.status === "unresolved" &&
      exactKeys(snapshot, ["status", "reason"], ["txHash"]) &&
      snapshot.reason === "inclusion-not-observed") {
    return {
      status: "unresolved",
      reason: "inclusion-not-observed",
      ...(Object.hasOwn(snapshot, "txHash")
        ? { txHash: canonicalTxHash(snapshot.txHash) }
        : {}),
    };
  }
  throw new Error("pay-dem-live:outcome-invalid");
}

/** Arm the shared durable guard with a pay-DEM-specific, validated public intent. */
export async function executePayDemFundedRun<T>(
  input: Readonly<PayDemFundedRunIntent>,
  operation: (
    marker: Readonly<ArmedFundedRun>,
    journalPreparedTransfer: PayDemPreparedTransferJournal,
  ) => Promise<T>,
): Promise<Readonly<{ marker: Readonly<ArmedFundedRun>; result: T }>> {
  const captured = captureIntent(input);
  return executeFundedRun({
    directory: captured.directory,
    operation: "pay-dem-funded-e2e",
    runId: captured.runId,
    details: {
      amountOs: captured.amountOs,
      maxTotalDebitOs: captured.maxTotalDebitOs,
      network: captured.network,
      payer: captured.payer,
      payee: captured.payee,
    },
  }, async (marker) => {
    const journalPreparedTransfer: PayDemPreparedTransferJournal = async (value) => {
      const prepared = capturePreparedTransfer(value, captured);
      await recordFundedRunCheckpoint(marker, {
        name: PREPARED_CHECKPOINT,
        details: { ...prepared },
      });
    };
    try {
      return await operation(marker, journalPreparedTransfer);
    } catch (error) {
      if (error instanceof PayDemIncludedNonceVisibilityError) {
        await recordPayDemFundedRunOutcome(marker, error.blockNumber === undefined
          ? {
              status: "unresolved",
              reason: "inclusion-not-observed",
              txHash: error.txHash,
            }
          : {
              status: "included",
              txHash: error.txHash,
              blockNumber: error.blockNumber,
            });
      }
      throw error;
    }
  });
}

/** Validate pay-DEM reconciliation facts before recording the generic outcome. */
export async function recordPayDemFundedRunOutcome(
  marker: Readonly<ArmedFundedRun>,
  outcome: Readonly<PayDemFundedRunOutcome>,
): Promise<void> {
  const captured = captureOutcome(outcome);
  await recordFundedRunOutcome(marker, {
    status: captured.status,
    details: captured.status === "included"
      ? { txHash: captured.txHash, blockNumber: captured.blockNumber }
      : {
          reason: captured.reason,
          ...(captured.txHash === undefined ? {} : { txHash: captured.txHash }),
        },
  });
}

/**
 * Recover the immutable pre-broadcast identity for read-only chain
 * reconciliation. This is deliberately not a resubmission primitive: a crash
 * after the checkpoint cannot distinguish "before broadcast call" from
 * "broadcast accepted, response lost", so callers must only observe `txHash`
 * and must never submit a newly signed or reconstructed transfer under this
 * wallet/run id.
 */
export async function readPayDemFundedPreparedTransfer(
  marker: Readonly<ArmedFundedRun>,
): Promise<Readonly<PayDemFundedPreparedTransfer>> {
  const recovered = await readFundedRunCheckpoint(marker, PREPARED_CHECKPOINT);
  if (recovered.intent.operation !== "pay-dem-funded-e2e") {
    throw new Error("pay-dem-live:prepared-transfer-intent-mismatch");
  }
  const intent = captureIntent({
    directory: dirname(marker.markerPath),
    runId: recovered.intent.runId,
    ...recovered.intent.details,
  });
  return Object.freeze(capturePreparedTransfer(recovered.details, intent));
}

/**
 * Reopen a prior funded attempt from public operator input after process loss.
 * This returns observation coordinates only; it never authorises settlement or
 * reconstructs the signed transaction.
 */
export async function reopenPayDemFundedRun(
  input: Readonly<PayDemFundedRunIntent>,
): Promise<Readonly<{
  marker: Readonly<ArmedFundedRun>;
  prepared: Readonly<PayDemFundedPreparedTransfer>;
}>> {
  const captured = captureIntent(input);
  const marker = await openFundedRun({
    directory: captured.directory,
    operation: "pay-dem-funded-e2e",
    runId: captured.runId,
    details: {
      amountOs: captured.amountOs,
      maxTotalDebitOs: captured.maxTotalDebitOs,
      network: captured.network,
      payer: captured.payer,
      payee: captured.payee,
    },
  });
  const prepared = await readPayDemFundedPreparedTransfer(marker);
  return Object.freeze({ marker, prepared });
}
