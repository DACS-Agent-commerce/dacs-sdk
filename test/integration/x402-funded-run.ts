import { types as nodeTypes } from "node:util";

import {
  armFundedRun,
  inspectArmedFundedRun,
  recordFundedRunOutcome,
  type ArmedFundedRun,
} from "./funded-run-marker.js";

const BASE_UNITS_RE = /^[1-9][0-9]{0,31}$/;
const DEMOS_ADDRESS_RE = /^(?:0[xX])?([0-9a-fA-F]{64})$/;
const EVM_ADDRESS_RE = /^(?:0[xX])?([0-9a-fA-F]{40})$/;
const TX_HASH_RE = /^(?:0[xX])?([0-9a-fA-F]{64})$/;
const JOB_ID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Circle's canonical USDC contract on Base Sepolia. */
export const X402_FUNDED_BASE_SEPOLIA_USDC =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

export interface X402FundedRunIntent {
  directory: string;
  runId: string;
  jobId: string;
  network: "eip155:84532";
  paymentPhaseIndex: 2;
  authorizationNonce: string;
  payer: string;
  payee: string;
  asset: string;
  buyerDemosAddress: string;
  sellerDemosAddress: string;
  amountBaseUnits: string;
  maxTotalDebitBaseUnits: string;
}

export interface X402FundedRunOutcome {
  status: "included";
  jobId: string;
  network: "eip155:84532";
  paymentPhaseIndex: 2;
  authorizationNonce: string;
  chainId: 84532;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  blockHash: string;
  payer: string;
  payee: string;
  asset: string;
  assetSymbol: "USDC";
  assetDecimals: 6;
  amountBaseUnits: string;
  totalDebitBaseUnits: string;
  confirmations: number;
  includedAt: number;
  finalityObservedAt: number;
}

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

function exactKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key));
}

function canonicalEvmAddress(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(`funded-e2e:${code}-invalid`);
  const match = value.match(EVM_ADDRESS_RE);
  if (!match) throw new Error(`funded-e2e:${code}-invalid`);
  return `0x${match[1]!.toLowerCase()}`;
}

function canonicalDemosAddress(value: unknown, code: string): string {
  if (typeof value !== "string") throw new Error(`funded-e2e:${code}-invalid`);
  const match = value.match(DEMOS_ADDRESS_RE);
  if (!match) throw new Error(`funded-e2e:${code}-invalid`);
  return match[1]!.toLowerCase();
}

function canonicalBytes32(value: unknown, code: string): string {
  if (typeof value !== "string") {
    throw new Error(`funded-e2e:${code}-invalid`);
  }
  const match = value.match(TX_HASH_RE);
  if (!match) throw new Error(`funded-e2e:${code}-invalid`);
  return `0x${match[1]!.toLowerCase()}`;
}

function captureIntent(value: unknown): X402FundedRunIntent {
  const snapshot = snapshotDataRecord(value);
  const required = [
    "directory",
    "runId",
    "jobId",
    "network",
    "paymentPhaseIndex",
    "authorizationNonce",
    "payer",
    "payee",
    "asset",
    "buyerDemosAddress",
    "sellerDemosAddress",
    "amountBaseUnits",
    "maxTotalDebitBaseUnits",
  ] as const;
  if (!snapshot || !exactKeys(snapshot, required) ||
      typeof snapshot.directory !== "string" || typeof snapshot.runId !== "string" ||
      typeof snapshot.jobId !== "string" || !JOB_ID_RE.test(snapshot.jobId) ||
      snapshot.network !== "eip155:84532" || snapshot.paymentPhaseIndex !== 2 ||
      typeof snapshot.amountBaseUnits !== "string" ||
      !BASE_UNITS_RE.test(snapshot.amountBaseUnits) ||
      typeof snapshot.maxTotalDebitBaseUnits !== "string" ||
      !BASE_UNITS_RE.test(snapshot.maxTotalDebitBaseUnits)) {
    throw new Error("funded-e2e:x402-intent-invalid");
  }
  if (BigInt(snapshot.maxTotalDebitBaseUnits) < BigInt(snapshot.amountBaseUnits)) {
    throw new Error("funded-e2e:x402-max-total-debit-below-amount");
  }
  const asset = canonicalEvmAddress(snapshot.asset, "x402-asset");
  if (asset !== X402_FUNDED_BASE_SEPOLIA_USDC.toLowerCase()) {
    throw new Error("funded-e2e:x402-asset-not-canonical-usdc");
  }
  return {
    directory: snapshot.directory,
    runId: snapshot.runId,
    jobId: snapshot.jobId,
    network: "eip155:84532",
    paymentPhaseIndex: 2,
    authorizationNonce: canonicalBytes32(snapshot.authorizationNonce, "x402-authorization-nonce"),
    payer: canonicalEvmAddress(snapshot.payer, "x402-payer"),
    payee: canonicalEvmAddress(snapshot.payee, "x402-payee"),
    asset,
    buyerDemosAddress: canonicalDemosAddress(
      snapshot.buyerDemosAddress,
      "x402-buyer-demos-address",
    ),
    sellerDemosAddress: canonicalDemosAddress(
      snapshot.sellerDemosAddress,
      "x402-seller-demos-address",
    ),
    amountBaseUnits: snapshot.amountBaseUnits,
    maxTotalDebitBaseUnits: snapshot.maxTotalDebitBaseUnits,
  };
}

function captureOutcome(value: unknown): X402FundedRunOutcome {
  const snapshot = snapshotDataRecord(value);
  if (!snapshot || !exactKeys(snapshot, [
    "status",
    "jobId",
    "network",
    "paymentPhaseIndex",
    "authorizationNonce",
    "chainId",
    "transactionHash",
    "logIndex",
    "blockNumber",
    "blockHash",
    "payer",
    "payee",
    "asset",
    "assetSymbol",
    "assetDecimals",
    "amountBaseUnits",
    "totalDebitBaseUnits",
    "confirmations",
    "includedAt",
    "finalityObservedAt",
  ]) || snapshot.status !== "included" ||
      typeof snapshot.jobId !== "string" || !JOB_ID_RE.test(snapshot.jobId) ||
      snapshot.network !== "eip155:84532" || snapshot.paymentPhaseIndex !== 2 ||
      snapshot.chainId !== 84_532 || snapshot.assetSymbol !== "USDC" ||
      snapshot.assetDecimals !== 6 ||
      typeof snapshot.amountBaseUnits !== "string" ||
      !BASE_UNITS_RE.test(snapshot.amountBaseUnits) ||
      typeof snapshot.totalDebitBaseUnits !== "string" ||
      !BASE_UNITS_RE.test(snapshot.totalDebitBaseUnits) ||
      !Number.isSafeInteger(snapshot.logIndex) || (snapshot.logIndex as number) < 0 ||
      !Number.isSafeInteger(snapshot.blockNumber) || (snapshot.blockNumber as number) < 0 ||
      !Number.isSafeInteger(snapshot.confirmations) || (snapshot.confirmations as number) < 1 ||
      !Number.isSafeInteger(snapshot.includedAt) || (snapshot.includedAt as number) < 0 ||
      !Number.isSafeInteger(snapshot.finalityObservedAt) ||
      (snapshot.finalityObservedAt as number) < (snapshot.includedAt as number)) {
    throw new Error("funded-e2e:x402-outcome-invalid");
  }
  const asset = canonicalEvmAddress(snapshot.asset, "x402-outcome-asset");
  if (asset !== X402_FUNDED_BASE_SEPOLIA_USDC.toLowerCase()) {
    throw new Error("funded-e2e:x402-outcome-asset-not-canonical-usdc");
  }
  if (BigInt(snapshot.totalDebitBaseUnits) < BigInt(snapshot.amountBaseUnits)) {
    throw new Error("funded-e2e:x402-outcome-total-debit-below-payment");
  }
  return {
    status: "included",
    jobId: snapshot.jobId,
    network: "eip155:84532",
    paymentPhaseIndex: 2,
    authorizationNonce: canonicalBytes32(
      snapshot.authorizationNonce,
      "x402-outcome-authorization-nonce",
    ),
    chainId: 84_532,
    transactionHash: canonicalBytes32(
      snapshot.transactionHash,
      "x402-outcome-transaction-hash",
    ),
    logIndex: snapshot.logIndex as number,
    blockNumber: snapshot.blockNumber as number,
    blockHash: canonicalBytes32(snapshot.blockHash, "x402-outcome-block-hash"),
    payer: canonicalEvmAddress(snapshot.payer, "x402-outcome-payer"),
    payee: canonicalEvmAddress(snapshot.payee, "x402-outcome-payee"),
    asset,
    assetSymbol: "USDC",
    assetDecimals: 6,
    amountBaseUnits: snapshot.amountBaseUnits,
    totalDebitBaseUnits: snapshot.totalDebitBaseUnits,
    confirmations: snapshot.confirmations as number,
    includedAt: snapshot.includedAt as number,
    finalityObservedAt: snapshot.finalityObservedAt as number,
  };
}

/** Permanently arm the shared ledger with one exact funded x402 attempt. */
export async function armX402FundedRun(
  input: Readonly<X402FundedRunIntent>,
): Promise<Readonly<ArmedFundedRun>> {
  const captured = captureIntent(input);
  return armFundedRun({
    directory: captured.directory,
    operation: "x402-two-agent-e2e",
    runId: captured.runId,
    details: {
      amountBaseUnits: captured.amountBaseUnits,
      asset: captured.asset,
      authorizationNonce: captured.authorizationNonce,
      buyerDemosAddress: captured.buyerDemosAddress,
      jobId: captured.jobId,
      maxTotalDebitBaseUnits: captured.maxTotalDebitBaseUnits,
      network: captured.network,
      paymentPhaseIndex: captured.paymentPhaseIndex,
      payee: captured.payee,
      payer: captured.payer,
      sellerDemosAddress: captured.sellerDemosAddress,
    },
  });
}

/** Record the first validated settlement observation; this is not independent DACS proof. */
export async function recordX402FundedRunOutcome(
  marker: Readonly<ArmedFundedRun>,
  outcome: Readonly<X402FundedRunOutcome>,
): Promise<void> {
  const captured = captureOutcome(outcome);
  const armed = await inspectArmedFundedRun(marker);
  const requiredIntentDetails = [
    "amountBaseUnits",
    "asset",
    "authorizationNonce",
    "buyerDemosAddress",
    "jobId",
    "maxTotalDebitBaseUnits",
    "network",
    "paymentPhaseIndex",
    "payee",
    "payer",
    "sellerDemosAddress",
  ] as const;
  if (armed.operation !== "x402-two-agent-e2e" ||
      !exactKeys(armed.details as Record<string, unknown>, requiredIntentDetails)) {
    throw new Error("funded-e2e:x402-armed-intent-invalid");
  }
  const intent = armed.details;
  if (captured.jobId !== intent.jobId || captured.network !== intent.network ||
      captured.paymentPhaseIndex !== intent.paymentPhaseIndex ||
      captured.authorizationNonce !== intent.authorizationNonce ||
      captured.payer !== intent.payer || captured.payee !== intent.payee ||
      captured.asset !== intent.asset ||
      captured.amountBaseUnits !== intent.amountBaseUnits) {
    throw new Error("funded-e2e:x402-outcome-intent-mismatch");
  }
  if (typeof intent.maxTotalDebitBaseUnits !== "string" ||
      !BASE_UNITS_RE.test(intent.maxTotalDebitBaseUnits) ||
      BigInt(captured.totalDebitBaseUnits) > BigInt(intent.maxTotalDebitBaseUnits)) {
    throw new Error("funded-e2e:x402-outcome-total-debit-exceeds-cap");
  }
  await recordFundedRunOutcome(armed.marker, {
    status: captured.status,
    details: {
      amountBaseUnits: captured.amountBaseUnits,
      asset: captured.asset,
      assetDecimals: captured.assetDecimals,
      assetSymbol: captured.assetSymbol,
      authorizationNonce: captured.authorizationNonce,
      blockHash: captured.blockHash,
      blockNumber: captured.blockNumber,
      chainId: captured.chainId,
      confirmations: captured.confirmations,
      finalityObservedAt: captured.finalityObservedAt,
      includedAt: captured.includedAt,
      jobId: captured.jobId,
      logIndex: captured.logIndex,
      network: captured.network,
      payee: captured.payee,
      payer: captured.payer,
      paymentPhaseIndex: captured.paymentPhaseIndex,
      totalDebitBaseUnits: captured.totalDebitBaseUnits,
      transactionHash: captured.transactionHash,
    },
  });
}
