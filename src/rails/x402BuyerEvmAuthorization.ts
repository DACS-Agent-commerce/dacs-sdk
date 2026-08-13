import { types as nodeTypes } from "node:util";

import { canonicalize, sha256Hex } from "../canonical/index.js";
import { deriveX402ReceiptCommitment } from "../seller/x402Receipt.js";
import {
  x402BuyerSettlementAuthenticationHash,
  type X402BuyerAuthorizationLookup,
  type X402BuyerAuthorizationProvider,
  type X402BuyerAuthorizationReconciliation,
  type X402BuyerEffectFence,
  type X402BuyerIntentAuthorization,
  type X402BuyerSettlementDisclosure,
  type X402BuyerSettlementIntent,
} from "./x402BuyerSettlement.js";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const NONCE_RE = /^0x[0-9a-f]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;
const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2})+$/;

/** keccak256("AuthorizationUsed(address,bytes32)"). */
export const EIP3009_AUTHORIZATION_USED_TOPIC =
  "0x98de503528ee59b575ef0c0a2576a82497bfc029a5685b209e9ec333479b10a5" as const;
/** keccak256("AuthorizationCanceled(address,bytes32)"). */
export const EIP3009_AUTHORIZATION_CANCELED_TOPIC =
  "0x1cdd46ff242716cdaa72d159d339a485b3438398348d68f09d7c8c0a59353d81" as const;
/** keccak256("Transfer(address,address,uint256)"). */
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

export interface X402BuyerEip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
  signature: `0x${string}`;
  domain: Readonly<{
    name: string;
    version: string;
    chainId: number;
    verifyingContract: string;
  }>;
}

export interface X402BuyerEvmFinalityHead {
  chainId: number;
  blockNumber: number;
  blockHash: string;
  timestamp: number;
}

export interface X402BuyerEvmLog {
  address: string;
  topics: readonly string[];
  data: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  removed: false;
}

export interface X402BuyerEvmTransactionReceipt {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  status: "success" | "reverted";
  logs: readonly X402BuyerEvmLog[];
}

export interface X402BuyerEvmAuthorizationState {
  used: boolean;
  blockNumber: number;
  blockHash: string;
}

export interface X402BuyerEvmBlockAncestry {
  canonical: boolean;
  blockNumber: number;
  blockHash: string;
  headBlockNumber: number;
  headBlockHash: string;
}

/**
 * Minimal authenticated EVM read boundary. Implementations must execute every
 * read against the requested chain and block. `getLogs` is intentionally raw:
 * this module independently validates topics, addresses and event coordinates.
 */
export interface X402BuyerEvmReadClient {
  getFinalityHead(): Promise<unknown>;
  getLogs(input: Readonly<{
    address: string;
    topics: readonly [string, string, string];
    fromBlock: number;
    toBlock: number;
  }>): Promise<unknown>;
  getTransactionReceipt(transactionHash: string): Promise<unknown>;
  readAuthorizationState(input: Readonly<{
    asset: string;
    payer: string;
    nonce: `0x${string}`;
    blockNumber: number;
    blockHash: string;
  }>): Promise<unknown>;
  confirmBlockAncestor(input: Readonly<{
    blockNumber: number;
    blockHash: string;
    headBlockNumber: number;
    headBlockHash: string;
  }>): Promise<unknown>;
}

export type X402BuyerEvmIntentAuthority = (input: Readonly<{
  intent: Readonly<X402BuyerSettlementIntent>;
  authorization: Readonly<X402BuyerEip3009Authorization>;
  fence: Readonly<X402BuyerEffectFence>;
}>) => Promise<unknown>;

export type X402BuyerEvmSignatureVerifier = (input: Readonly<{
  intent: Readonly<X402BuyerSettlementIntent>;
  authorization: Readonly<X402BuyerEip3009Authorization>;
}>) => Promise<unknown>;

export type X402BuyerEvmUnusedConfirmer = (input: Readonly<{
  intent: Readonly<X402BuyerSettlementIntent>;
  authorization: Readonly<X402BuyerEip3009Authorization>;
  finalityHead: Readonly<X402BuyerEvmFinalityHead>;
  authorizationState: Readonly<X402BuyerEvmAuthorizationState>;
  fence: Readonly<X402BuyerEffectFence>;
}>) => Promise<unknown>;

export type X402BuyerEvmDisclosureRecovery = (input: Readonly<{
  intent: Readonly<X402BuyerSettlementIntent>;
  transactionHash: string;
  fence: Readonly<X402BuyerEffectFence>;
}>) => Promise<unknown>;

export interface X402BuyerEvmAuthorizationProviderOptions {
  chainId: number;
  minimumConfirmations: number;
  /** Earliest block in which this token deployment can emit nonce events. */
  authorizationSearchFromBlock: number;
  client: X402BuyerEvmReadClient;
  /** Application-owned DACS authority check; must bind the exact intent hash. */
  authorizeIntent: X402BuyerEvmIntentAuthority;
  /** Defaults to lazy viem EIP-712 verification. */
  verifySignature?: X402BuyerEvmSignatureVerifier;
  /**
   * Required before absence can become `unused`. This callback is where a
   * deployment proves that no still-live facilitator/request can race replay.
   */
  confirmUnused?: X402BuyerEvmUnusedConfirmer;
  /** Optional authoritative settlement-response recovery by exact settled tx hash. */
  recoverDisclosure?: X402BuyerEvmDisclosureRecovery;
}

interface ParsedDisclosure {
  disclosure: X402BuyerSettlementDisclosure;
  paymentReceiptHash: string;
  transactionHash: string;
}

interface X402BuyerEvmObservationBody {
  observationVersion: "1";
  intentBindingHash: string;
  finalityHead: X402BuyerEvmFinalityHead;
  authorizationState: X402BuyerEvmAuthorizationState;
  usedLogs: X402BuyerEvmLog[];
  cancelledLogs: X402BuyerEvmLog[];
  receipt?: X402BuyerEvmTransactionReceipt;
  ancestry?: X402BuyerEvmBlockAncestry;
  candidate?: ParsedDisclosure;
  candidateIssue?: string;
}

/** Opaque, hash-sealed output carried between `lookup` and `authenticate`. */
export interface X402BuyerEvmAuthorizationObservation
  extends X402BuyerEvmObservationBody {
  observationHash: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !nodeTypes.isProxy(value) &&
    !Array.isArray(value);
}

function arrayData(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Array.prototype) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).filter((key) => key !== "length");
  if (!Number.isSafeInteger(value.length) || keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))) return null;
  const result: unknown[] = [];
  for (const key of keys) {
    const descriptor = descriptors[key]!;
    if (!descriptor.enumerable || !("value" in descriptor)) return null;
    result.push(descriptor.value);
  }
  return result;
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> | null {
  if (!isRecord(value) || nodeTypes.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length !== 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key)) ||
      keys.some((key) => !allowed.has(key))) return null;
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !("value" in descriptor) ||
        descriptor.value === undefined) return null;
  }
  return value;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function safeInteger(value: unknown, positive = false): number | null {
  return Number.isSafeInteger(value) && (value as number) >= (positive ? 1 : 0) &&
    !Object.is(value, -0) ? value as number : null;
}

function canonicalAddress(value: unknown): string | null {
  return typeof value === "string" && ADDRESS_RE.test(value) ? value.toLowerCase() : null;
}

function canonicalHash(value: unknown): string | null {
  return typeof value === "string" && HASH_RE.test(value) ? value.toLowerCase() : null;
}

function sameAddress(left: unknown, right: string): boolean {
  const normalized = canonicalAddress(left);
  return normalized !== null && normalized === right.toLowerCase();
}

function addressTopic(value: string): string {
  return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
}

function exactTopic(value: unknown): string | null {
  return canonicalHash(value);
}

function captureReason(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.normalize("NFC") === value &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function captureHead(value: unknown): X402BuyerEvmFinalityHead | null {
  const record = exactRecord(value, ["chainId", "blockNumber", "blockHash", "timestamp"]);
  if (!record) return null;
  const chainId = safeInteger(record.chainId, true);
  const blockNumber = safeInteger(record.blockNumber);
  const blockHash = canonicalHash(record.blockHash);
  const timestamp = safeInteger(record.timestamp);
  if (chainId === null || blockNumber === null || !blockHash || timestamp === null) return null;
  return deepFreeze({ chainId, blockNumber, blockHash, timestamp });
}

function captureLog(value: unknown): X402BuyerEvmLog | null {
  const record = exactRecord(value, [
    "address", "topics", "data", "transactionHash", "blockNumber",
    "blockHash", "logIndex", "removed",
  ]);
  const topicData = record ? arrayData(record.topics) : null;
  if (!record || record.removed !== false || !topicData ||
      typeof record.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(record.data)) return null;
  const normalizedTopics = topicData.map(exactTopic);
  const blockNumber = safeInteger(record.blockNumber);
  const logIndex = safeInteger(record.logIndex);
  const logAddress = canonicalAddress(record.address);
  const transactionHash = canonicalHash(record.transactionHash);
  const blockHash = canonicalHash(record.blockHash);
  if (normalizedTopics.some((topic) => topic === null) || blockNumber === null ||
      logIndex === null || !logAddress || !transactionHash || !blockHash) return null;
  return deepFreeze({
    address: logAddress,
    topics: normalizedTopics as string[],
    data: record.data.toLowerCase(),
    transactionHash,
    blockNumber,
    blockHash,
    logIndex,
    removed: false,
  });
}

function captureLogs(value: unknown): X402BuyerEvmLog[] | null {
  const values = arrayData(value);
  if (!values) return null;
  const captured = values.map(captureLog);
  if (captured.some((log) => log === null)) return null;
  const unique = new Map<string, X402BuyerEvmLog>();
  for (const log of captured as X402BuyerEvmLog[]) {
    const key = canonicalize(log);
    unique.set(key, log);
  }
  return [...unique.values()];
}

function captureReceipt(value: unknown): X402BuyerEvmTransactionReceipt | null {
  const record = exactRecord(value, [
    "transactionHash", "blockNumber", "blockHash", "status", "logs",
  ]);
  if (!record || (record.status !== "success" && record.status !== "reverted")) return null;
  const transactionHash = canonicalHash(record.transactionHash);
  const blockHash = canonicalHash(record.blockHash);
  const blockNumber = safeInteger(record.blockNumber);
  const logs = captureLogs(record.logs);
  if (!transactionHash || !blockHash || blockNumber === null || !logs) return null;
  if (logs.some((log) => log.transactionHash !== transactionHash ||
      log.blockHash !== blockHash || log.blockNumber !== blockNumber) ||
      new Set(logs.map((log) => log.logIndex)).size !== logs.length) return null;
  return deepFreeze({ transactionHash, blockNumber, blockHash, status: record.status, logs });
}

function captureAuthorizationState(value: unknown): X402BuyerEvmAuthorizationState | null {
  const record = exactRecord(value, ["used", "blockNumber", "blockHash"]);
  if (!record || typeof record.used !== "boolean") return null;
  const blockNumber = safeInteger(record.blockNumber);
  const blockHash = canonicalHash(record.blockHash);
  if (blockNumber === null || !blockHash) return null;
  return deepFreeze({ used: record.used, blockNumber, blockHash });
}

function captureBlockAncestry(value: unknown): X402BuyerEvmBlockAncestry | null {
  const record = exactRecord(value, [
    "canonical", "blockNumber", "blockHash", "headBlockNumber", "headBlockHash",
  ]);
  if (!record || typeof record.canonical !== "boolean") return null;
  const blockNumber = safeInteger(record.blockNumber);
  const blockHash = canonicalHash(record.blockHash);
  const headBlockNumber = safeInteger(record.headBlockNumber);
  const headBlockHash = canonicalHash(record.headBlockHash);
  if (blockNumber === null || !blockHash || headBlockNumber === null || !headBlockHash) return null;
  return deepFreeze({ canonical: record.canonical, blockNumber, blockHash, headBlockNumber, headBlockHash });
}

function captureAuthorizationLog(
  log: X402BuyerEvmLog,
  intent: Readonly<X402BuyerSettlementIntent>,
  topic: string,
  head: Readonly<X402BuyerEvmFinalityHead>,
): boolean {
  return log.address === intent.asset.toLowerCase() && log.topics.length === 3 &&
    log.topics[0] === topic && log.topics[1] === addressTopic(intent.payer) &&
    log.topics[2] === intent.authorizationNonce && log.data === "0x" &&
    log.blockNumber <= head.blockNumber;
}

function extractAuthorization(
  intent: Readonly<X402BuyerSettlementIntent>,
): Readonly<X402BuyerEip3009Authorization> | null {
  const payload = intent.signedPaymentPayload.payload;
  if (!isRecord(payload)) return null;
  const authorization = exactRecord(payload.authorization, [
    "from", "to", "value", "validAfter", "validBefore", "nonce",
  ]);
  const extra = intent.chosenRequirements.extra;
  if (!authorization || typeof payload.signature !== "string" ||
      !SIGNATURE_RE.test(payload.signature) || typeof extra.name !== "string" ||
      typeof extra.version !== "string" || extra.name.length === 0 || extra.version.length === 0 ||
      extra.assetTransferMethod !== "eip3009" ||
      !sameAddress(authorization.from, intent.payer) ||
      !sameAddress(authorization.to, intent.payee) || authorization.value !== intent.amount ||
      authorization.nonce !== intent.authorizationNonce ||
      typeof authorization.validAfter !== "string" || !UINT_RE.test(authorization.validAfter) ||
      typeof authorization.validBefore !== "string" || !UINT_RE.test(authorization.validBefore) ||
      BigInt(authorization.validBefore) <= BigInt(authorization.validAfter) ||
      !NONCE_RE.test(intent.authorizationNonce)) return null;
  return deepFreeze({
    from: intent.payer.toLowerCase(),
    to: intent.payee.toLowerCase(),
    value: intent.amount,
    validAfter: authorization.validAfter,
    validBefore: authorization.validBefore,
    nonce: intent.authorizationNonce,
    signature: payload.signature as `0x${string}`,
    domain: {
      name: extra.name,
      version: extra.version,
      chainId: Number(intent.network.slice("eip155:".length)),
      verifyingContract: intent.asset.toLowerCase(),
    },
  });
}

async function defaultViemSignatureVerifier(input: Readonly<{
  intent: Readonly<X402BuyerSettlementIntent>;
  authorization: Readonly<X402BuyerEip3009Authorization>;
}>): Promise<unknown> {
  let verifyTypedData: typeof import("viem")["verifyTypedData"];
  try {
    ({ verifyTypedData } = await import("viem"));
  } catch {
    return { disposition: "indeterminate", reason: "viem-unavailable" };
  }
  const authorization = input.authorization;
  try {
    const valid = await verifyTypedData({
      address: authorization.from as `0x${string}`,
      domain: {
        name: authorization.domain.name,
        version: authorization.domain.version,
        chainId: authorization.domain.chainId,
        verifyingContract: authorization.domain.verifyingContract as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from as `0x${string}`,
        to: authorization.to as `0x${string}`,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
      signature: authorization.signature,
    });
    return valid
      ? { disposition: "valid", signer: authorization.from }
      : { disposition: "invalid", reason: "eip3009-signature-invalid" };
  } catch {
    return { disposition: "invalid", reason: "eip3009-signature-invalid" };
  }
}

function captureSignatureVerdict(value: unknown, payer: string): X402BuyerIntentAuthorization {
  const valid = exactRecord(value, ["disposition", "signer"]);
  if (valid?.disposition === "valid") {
    if (!sameAddress(valid.signer, payer)) {
      return { disposition: "rejected", reason: "eip3009-signer-mismatch" };
    }
    return { disposition: "authorized", bindingHash: "" };
  }
  const negative = exactRecord(value, ["disposition", "reason"]);
  if (negative?.disposition === "invalid" || negative?.disposition === "indeterminate") {
    const reason = captureReason(negative.reason);
    return {
      disposition: negative.disposition === "invalid" ? "rejected" : "indeterminate",
      reason: reason ?? "signature-verifier-invalid",
    };
  }
  return { disposition: "indeterminate", reason: "signature-verifier-invalid" };
}

function captureAuthorityVerdict(
  value: unknown,
  bindingHash: string,
): X402BuyerIntentAuthorization {
  const authorized = exactRecord(value, ["disposition", "bindingHash"]);
  if (authorized?.disposition === "authorized") {
    return authorized.bindingHash === bindingHash
      ? { disposition: "authorized", bindingHash }
      : { disposition: "indeterminate", reason: "intent-authority-binding-mismatch" };
  }
  const negative = exactRecord(value, ["disposition", "reason"]);
  if (negative?.disposition === "rejected" || negative?.disposition === "indeterminate") {
    const reason = captureReason(negative.reason);
    return {
      disposition: negative.disposition,
      reason: reason ?? "intent-authority-invalid",
    };
  }
  return { disposition: "indeterminate", reason: "intent-authority-invalid" };
}

function parseDisclosure(
  value: unknown,
  intent: Readonly<X402BuyerSettlementIntent>,
): ParsedDisclosure | null {
  const record = exactRecord(value, [
    "protocolVersion", "headerName", "encodedSettlementHeader", "httpResource",
  ]);
  if (!record || record.protocolVersion !== "2" || record.headerName !== "PAYMENT-RESPONSE" ||
      record.httpResource !== intent.httpResource ||
      typeof record.encodedSettlementHeader !== "string") return null;
  const derived = deriveX402ReceiptCommitment({
    protocolVersion: "2",
    responseHeader: { name: "PAYMENT-RESPONSE", value: record.encodedSettlementHeader },
  });
  if (derived.disposition !== "pass" || !derived.receipt ||
      !derived.computedPaymentReceiptHash) return null;
  const txHash = canonicalHash(derived.receipt.transaction);
  if (!txHash || derived.receipt.network !== intent.network ||
      !sameAddress(derived.receipt.payer, intent.payer) ||
      (derived.receipt.amount !== undefined && derived.receipt.amount !== intent.amount)) return null;
  return deepFreeze({
    disclosure: {
      protocolVersion: "2",
      headerName: "PAYMENT-RESPONSE",
      encodedSettlementHeader: record.encodedSettlementHeader,
      httpResource: intent.httpResource,
    },
    paymentReceiptHash: derived.computedPaymentReceiptHash,
    transactionHash: txHash,
  });
}

function observationHash(body: X402BuyerEvmObservationBody): string {
  return sha256Hex(canonicalize(body));
}

function captureObservation(value: unknown): X402BuyerEvmAuthorizationObservation | null {
  const record = exactRecord(value, [
    "observationVersion", "intentBindingHash", "finalityHead", "authorizationState",
    "usedLogs", "cancelledLogs", "observationHash",
  ], ["receipt", "ancestry", "candidate", "candidateIssue"]);
  if (!record || record.observationVersion !== "1" ||
      typeof record.intentBindingHash !== "string" ||
      typeof record.observationHash !== "string" || !/^[0-9a-f]{64}$/.test(record.observationHash)) {
    return null;
  }
  const finalityHead = captureHead(record.finalityHead);
  const authorizationState = captureAuthorizationState(record.authorizationState);
  const usedLogs = captureLogs(record.usedLogs);
  const cancelledLogs = captureLogs(record.cancelledLogs);
  const receipt = record.receipt === undefined ? undefined : captureReceipt(record.receipt);
  const ancestry = record.ancestry === undefined ? undefined : captureBlockAncestry(record.ancestry);
  const candidateRecord = record.candidate === undefined ? undefined : exactRecord(
    record.candidate,
    ["disclosure", "paymentReceiptHash", "transactionHash"],
  );
  const candidate = candidateRecord ? (() => {
    const disclosureRecord = exactRecord(candidateRecord.disclosure, [
      "protocolVersion", "headerName", "encodedSettlementHeader", "httpResource",
    ]);
    const paymentReceiptHash = typeof candidateRecord.paymentReceiptHash === "string" &&
      /^[0-9a-f]{64}$/.test(candidateRecord.paymentReceiptHash)
      ? candidateRecord.paymentReceiptHash : null;
    const transactionHash = canonicalHash(candidateRecord.transactionHash);
    if (!disclosureRecord || disclosureRecord.protocolVersion !== "2" ||
        disclosureRecord.headerName !== "PAYMENT-RESPONSE" ||
        typeof disclosureRecord.encodedSettlementHeader !== "string" ||
        typeof disclosureRecord.httpResource !== "string" || !paymentReceiptHash ||
        !transactionHash) return null;
    return {
      disclosure: disclosureRecord as unknown as X402BuyerSettlementDisclosure,
      paymentReceiptHash,
      transactionHash,
    };
  })() : undefined;
  const candidateIssue = record.candidateIssue === undefined
    ? undefined : captureReason(record.candidateIssue) ?? null;
  if (!finalityHead || !authorizationState || !usedLogs || !cancelledLogs ||
      (record.receipt !== undefined && !receipt) ||
      (record.ancestry !== undefined && !ancestry) ||
      (record.candidate !== undefined && !candidate) || candidateIssue === null) return null;
  const body: X402BuyerEvmObservationBody = {
    observationVersion: "1",
    intentBindingHash: record.intentBindingHash,
    finalityHead,
    authorizationState,
    usedLogs,
    cancelledLogs,
    ...(receipt ? { receipt } : {}),
    ...(ancestry ? { ancestry } : {}),
    ...(candidate ? { candidate } : {}),
    ...(candidateIssue ? { candidateIssue } : {}),
  };
  if (observationHash(body) !== record.observationHash) return null;
  return deepFreeze({ ...body, observationHash: record.observationHash });
}

function receiptContainsEvent(
  receipt: Readonly<X402BuyerEvmTransactionReceipt>,
  event: Readonly<X402BuyerEvmLog>,
): boolean {
  return receipt.logs.some((log) => canonicalize(log) === canonicalize(event));
}

function finalizedReceipt(
  receipt: Readonly<X402BuyerEvmTransactionReceipt>,
  event: Readonly<X402BuyerEvmLog>,
  head: Readonly<X402BuyerEvmFinalityHead>,
  minimumConfirmations: number,
  ancestry: Readonly<X402BuyerEvmBlockAncestry>,
): boolean {
  return receipt.status === "success" && receipt.transactionHash === event.transactionHash &&
    receipt.blockNumber === event.blockNumber && receipt.blockHash === event.blockHash &&
    receipt.blockNumber <= head.blockNumber &&
    head.blockNumber - receipt.blockNumber + 1 >= minimumConfirmations &&
    ancestry.canonical && ancestry.blockNumber === receipt.blockNumber &&
    ancestry.blockHash === receipt.blockHash &&
    ancestry.headBlockNumber === head.blockNumber &&
    ancestry.headBlockHash === head.blockHash &&
    receiptContainsEvent(receipt, event);
}

function matchingTransfers(
  receipt: Readonly<X402BuyerEvmTransactionReceipt>,
  intent: Readonly<X402BuyerSettlementIntent>,
): X402BuyerEvmLog[] {
  const fromTopic = addressTopic(intent.payer);
  const toTopic = addressTopic(intent.payee);
  return receipt.logs.filter((log) => {
    if (log.address !== intent.asset.toLowerCase() || log.topics.length !== 3 ||
        log.topics[0] !== ERC20_TRANSFER_TOPIC || log.topics[1] !== fromTopic ||
        log.topics[2] !== toTopic || !/^0x[0-9a-f]{64}$/.test(log.data)) return false;
    try {
      return BigInt(log.data) === BigInt(intent.amount);
    } catch {
      return false;
    }
  });
}

function terminalAuthenticationHash(input: {
  intent: Readonly<X402BuyerSettlementIntent>;
  disposition: "used-different" | "cancelled" | "expired-unused" | "unused";
  head: Readonly<X402BuyerEvmFinalityHead>;
  state: Readonly<X402BuyerEvmAuthorizationState>;
  event?: Readonly<X402BuyerEvmLog>;
  receipt?: Readonly<X402BuyerEvmTransactionReceipt>;
  ancestry?: Readonly<X402BuyerEvmBlockAncestry>;
}): string {
  return sha256Hex(canonicalize({
    authenticationVersion: "x402-evm-v1",
    bindingHash: input.intent.bindingHash,
    authorizationNonce: input.intent.authorizationNonce,
    disposition: input.disposition,
    finalityHead: input.head,
    authorizationState: input.state,
    ...(input.event ? { event: input.event } : {}),
    ...(input.receipt ? { receipt: input.receipt } : {}),
    ...(input.ancestry ? { ancestry: input.ancestry } : {}),
  }));
}

/**
 * Build the production buyer-side x402/EIP-3009 reconciliation provider.
 * Raw provider receipts are never treated as success: settlement requires a
 * finalized AuthorizationUsed event and the exact ERC-20 Transfer in its tx.
 */
export function createX402BuyerEvmAuthorizationProvider(
  options: Readonly<X402BuyerEvmAuthorizationProviderOptions>,
): X402BuyerAuthorizationProvider<X402BuyerEvmAuthorizationObservation> {
  const configRecord = exactRecord(options, [
    "chainId", "minimumConfirmations", "authorizationSearchFromBlock", "client",
    "authorizeIntent",
  ], ["verifySignature", "confirmUnused", "recoverDisclosure"]);
  const clientRecord = configRecord && exactRecord(configRecord.client, [
    "getFinalityHead", "getLogs", "getTransactionReceipt", "readAuthorizationState",
    "confirmBlockAncestor",
  ]);
  if (!configRecord || !clientRecord) {
    throw new TypeError("x402 buyer EVM authorization provider options are invalid");
  }
  const chainId = safeInteger(options?.chainId, true);
  const minimumConfirmations = safeInteger(options?.minimumConfirmations, true);
  const authorizationSearchFromBlock = safeInteger(options?.authorizationSearchFromBlock);
  if (chainId === null || minimumConfirmations === null ||
      authorizationSearchFromBlock === null || !options?.client ||
      typeof options.client.getFinalityHead !== "function" ||
      typeof options.client.getLogs !== "function" ||
      typeof options.client.getTransactionReceipt !== "function" ||
      typeof options.client.readAuthorizationState !== "function" ||
      typeof options.client.confirmBlockAncestor !== "function" ||
      typeof options.authorizeIntent !== "function" ||
      (options.verifySignature !== undefined && typeof options.verifySignature !== "function") ||
      (options.confirmUnused !== undefined && typeof options.confirmUnused !== "function") ||
      (options.recoverDisclosure !== undefined && typeof options.recoverDisclosure !== "function")) {
    throw new TypeError("x402 buyer EVM authorization provider options are invalid");
  }
  const verifySignature = options.verifySignature ?? defaultViemSignatureVerifier;
  // Observations are ephemeral security capabilities, not caller-constructible
  // DTOs. Their public hash detects mutation; this identity check also prevents
  // a caller from fabricating a self-consistent chain observation from scratch.
  const issuedObservations = new WeakSet<object>();

  const authenticateIntent = async (
    intent: Readonly<X402BuyerSettlementIntent>,
    fence: Readonly<X402BuyerEffectFence>,
    requireLiveWindow: boolean,
  ): Promise<X402BuyerIntentAuthorization> => {
    const authorization = extractAuthorization(intent);
    if (!authorization || Number(intent.network.slice("eip155:".length)) !== chainId) {
      return { disposition: "rejected", reason: "eip3009-intent-invalid" };
    }
    try {
      await fence.assertCurrent();
      const signatureVerdict = captureSignatureVerdict(
        await verifySignature(deepFreeze({ intent, authorization })),
        intent.payer,
      );
      await fence.assertCurrent();
      if (signatureVerdict.disposition !== "authorized") return signatureVerdict;
      const authorityVerdict = captureAuthorityVerdict(
        await options.authorizeIntent(deepFreeze({ intent, authorization, fence })),
        intent.bindingHash,
      );
      await fence.assertCurrent();
      if (authorityVerdict.disposition !== "authorized" || !requireLiveWindow) {
        return authorityVerdict;
      }
      const head = captureHead(await options.client.getFinalityHead());
      await fence.assertCurrent();
      if (!head || head.chainId !== chainId) {
        return { disposition: "indeterminate", reason: "evm-finality-head-invalid" };
      }
      const timestamp = BigInt(head.timestamp);
      if (timestamp >= BigInt(authorization.validBefore)) {
        return { disposition: "expired", reason: "eip3009-authorization-expired" };
      }
      if (timestamp <= BigInt(authorization.validAfter)) {
        return { disposition: "indeterminate", reason: "eip3009-authorization-not-yet-valid" };
      }
      return authorityVerdict;
    } catch {
      return { disposition: "indeterminate", reason: "intent-authorization-unavailable" };
    }
  };

  const provider: X402BuyerAuthorizationProvider<X402BuyerEvmAuthorizationObservation> = {
    authorizeIntent: (intent, fence) => authenticateIntent(intent, fence, true),

    async lookup(intent, candidate, fence): Promise<X402BuyerAuthorizationLookup<X402BuyerEvmAuthorizationObservation>> {
      if (Number(intent.network.slice("eip155:".length)) !== chainId) {
        return { disposition: "unavailable", reason: "evm-chain-mismatch" };
      }
      const authorization = extractAuthorization(intent);
      if (!authorization) return { disposition: "unavailable", reason: "eip3009-intent-invalid" };
      try {
        await fence.assertCurrent();
        const head = captureHead(await options.client.getFinalityHead());
        await fence.assertCurrent();
        if (!head || head.chainId !== chainId || head.blockNumber < authorizationSearchFromBlock) {
          return { disposition: "unavailable", reason: "evm-finality-head-invalid" };
        }
        const commonFilter = {
          address: intent.asset.toLowerCase(),
          fromBlock: authorizationSearchFromBlock,
          toBlock: head.blockNumber,
        };
        const payerTopic = addressTopic(intent.payer);
        const [rawUsed, rawCancelled, rawState] = await Promise.all([
          options.client.getLogs(deepFreeze({
            ...commonFilter,
            topics: [EIP3009_AUTHORIZATION_USED_TOPIC, payerTopic, intent.authorizationNonce] as const,
          })),
          options.client.getLogs(deepFreeze({
            ...commonFilter,
            topics: [EIP3009_AUTHORIZATION_CANCELED_TOPIC, payerTopic, intent.authorizationNonce] as const,
          })),
          options.client.readAuthorizationState(deepFreeze({
            asset: intent.asset.toLowerCase(),
            payer: intent.payer.toLowerCase(),
            nonce: intent.authorizationNonce,
            blockNumber: head.blockNumber,
            blockHash: head.blockHash,
          })),
        ]);
        await fence.assertCurrent();
        const usedLogs = captureLogs(rawUsed);
        const cancelledLogs = captureLogs(rawCancelled);
        const state = captureAuthorizationState(rawState);
        if (!usedLogs || !cancelledLogs || !state || state.blockNumber !== head.blockNumber ||
            state.blockHash !== head.blockHash ||
            usedLogs.some((log) => !captureAuthorizationLog(
              log, intent, EIP3009_AUTHORIZATION_USED_TOPIC, head,
            )) || cancelledLogs.some((log) => !captureAuthorizationLog(
              log, intent, EIP3009_AUTHORIZATION_CANCELED_TOPIC, head,
            ))) {
          return { disposition: "unavailable", reason: "evm-authorization-observation-invalid" };
        }

        let parsedCandidate = candidate === undefined ? undefined : parseDisclosure(candidate, intent) ?? undefined;
        let candidateIssue = candidate !== undefined && !parsedCandidate
          ? "payment-response-invalid" : undefined;
        const allEvents = [...usedLogs, ...cancelledLogs];
        let receipt: X402BuyerEvmTransactionReceipt | undefined;
        let ancestry: X402BuyerEvmBlockAncestry | undefined;
        if (allEvents.length === 1) {
          const event = allEvents[0]!;
          receipt = captureReceipt(await options.client.getTransactionReceipt(event.transactionHash)) ?? undefined;
          await fence.assertCurrent();
          if (!receipt) candidateIssue = candidateIssue ?? "transaction-receipt-invalid";
          const rawAncestry = await options.client.confirmBlockAncestor(deepFreeze({
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            headBlockNumber: head.blockNumber,
            headBlockHash: head.blockHash,
          }));
          await fence.assertCurrent();
          ancestry = captureBlockAncestry(rawAncestry) ?? undefined;
          if (!ancestry || ancestry.blockNumber !== event.blockNumber ||
              ancestry.blockHash !== event.blockHash ||
              ancestry.headBlockNumber !== head.blockNumber ||
              ancestry.headBlockHash !== head.blockHash) {
            return { disposition: "unavailable", reason: "evm-block-ancestry-invalid" };
          }
          if (usedLogs.length === 1 && (!parsedCandidate ||
              parsedCandidate.transactionHash !== event.transactionHash) && options.recoverDisclosure) {
            const recovered = await options.recoverDisclosure(deepFreeze({
              intent,
              transactionHash: event.transactionHash,
              fence,
            }));
            await fence.assertCurrent();
            const parsedRecovered = parseDisclosure(recovered, intent);
            if (parsedRecovered && parsedRecovered.transactionHash === event.transactionHash) {
              parsedCandidate = parsedRecovered;
              candidateIssue = undefined;
            } else {
              candidateIssue = candidateIssue ?? "payment-response-recovery-unavailable";
            }
          }
        }
        const body: X402BuyerEvmObservationBody = {
          observationVersion: "1",
          intentBindingHash: intent.bindingHash,
          finalityHead: head,
          authorizationState: state,
          usedLogs,
          cancelledLogs,
          ...(receipt ? { receipt } : {}),
          ...(ancestry ? { ancestry } : {}),
          ...(parsedCandidate ? { candidate: parsedCandidate } : {}),
          ...(candidateIssue ? { candidateIssue } : {}),
        };
        const finalHead = captureHead(await options.client.getFinalityHead());
        await fence.assertCurrent();
        if (!finalHead) {
          return { disposition: "unavailable", reason: "evm-finality-head-changed" };
        }
        if (canonicalize(finalHead) !== canonicalize(head)) {
          // A faster chain can advance while the hash-pinned read set is being
          // collected. Forward progress does not invalidate that snapshot: it
          // is safe only when the original head is still canonical beneath the
          // newer head. Same-height substitution, rollback, and reorg all
          // remain fail-closed.
          if (finalHead.chainId !== head.chainId ||
              finalHead.blockNumber <= head.blockNumber) {
            return { disposition: "unavailable", reason: "evm-finality-head-changed" };
          }
          const rawHeadAncestry = await options.client.confirmBlockAncestor(deepFreeze({
            blockNumber: head.blockNumber,
            blockHash: head.blockHash,
            headBlockNumber: finalHead.blockNumber,
            headBlockHash: finalHead.blockHash,
          }));
          await fence.assertCurrent();
          const headAncestry = captureBlockAncestry(rawHeadAncestry);
          if (!headAncestry || !headAncestry.canonical ||
              headAncestry.blockNumber !== head.blockNumber ||
              headAncestry.blockHash !== head.blockHash ||
              headAncestry.headBlockNumber !== finalHead.blockNumber ||
              headAncestry.headBlockHash !== finalHead.blockHash) {
            return { disposition: "unavailable", reason: "evm-finality-head-changed" };
          }
        }
        const observation = deepFreeze({ ...body, observationHash: observationHash(body) });
        issuedObservations.add(observation);
        return {
          disposition: "observed",
          observation,
        };
      } catch {
        return { disposition: "unavailable", reason: "evm-authorization-lookup-unavailable" };
      }
    },

    async authenticate(intent, lookup, candidate, fence): Promise<X402BuyerAuthorizationReconciliation> {
      if (!isRecord(lookup.observation) || !issuedObservations.has(lookup.observation)) {
        return { disposition: "indeterminate", reason: "evm-observation-not-issued" };
      }
      const observation = captureObservation(lookup.observation);
      if (!observation || observation.intentBindingHash !== intent.bindingHash) {
        return { disposition: "indeterminate", reason: "evm-observation-authentication-invalid" };
      }
      const authorization = extractAuthorization(intent);
      if (!authorization) return { disposition: "indeterminate", reason: "eip3009-intent-invalid" };
      const authority = await authenticateIntent(intent, fence, false);
      if (authority.disposition !== "authorized") {
        return {
          disposition: "indeterminate",
          reason: authority.disposition === "rejected"
            ? `intent-authorization-rejected:${authority.reason}`
            : `intent-authorization-indeterminate:${authority.reason}`,
        };
      }
      if (candidate !== undefined) {
        const callerCandidate = parseDisclosure(candidate, intent);
        if (!callerCandidate || !observation.candidate ||
            callerCandidate.transactionHash !== observation.candidate.transactionHash ||
            callerCandidate.paymentReceiptHash !== observation.candidate.paymentReceiptHash) {
          return { disposition: "indeterminate", reason: "payment-response-candidate-mismatch" };
        }
      }
      const { finalityHead: head, authorizationState: state } = observation;
      if (head.chainId !== chainId || state.blockNumber !== head.blockNumber ||
          state.blockHash !== head.blockHash) {
        return { disposition: "indeterminate", reason: "evm-finality-binding-mismatch" };
      }
      if (observation.usedLogs.some((log) => !captureAuthorizationLog(
        log, intent, EIP3009_AUTHORIZATION_USED_TOPIC, head,
      )) || observation.cancelledLogs.some((log) => !captureAuthorizationLog(
        log, intent, EIP3009_AUTHORIZATION_CANCELED_TOPIC, head,
      ))) {
        return { disposition: "indeterminate", reason: "evm-nonce-event-binding-mismatch" };
      }
      if (observation.candidate) {
        const reparsed = parseDisclosure(observation.candidate.disclosure, intent);
        if (!reparsed || reparsed.transactionHash !== observation.candidate.transactionHash ||
            reparsed.paymentReceiptHash !== observation.candidate.paymentReceiptHash) {
          return { disposition: "indeterminate", reason: "payment-response-authentication-invalid" };
        }
      }
      if (observation.usedLogs.length > 1 || observation.cancelledLogs.length > 1 ||
          (observation.usedLogs.length === 1 && observation.cancelledLogs.length === 1)) {
        return { disposition: "indeterminate", reason: "eip3009-nonce-events-ambiguous" };
      }
      if (observation.cancelledLogs.length === 1) {
        const event = observation.cancelledLogs[0]!;
        if (!state.used || !observation.receipt || !observation.ancestry || !finalizedReceipt(
          observation.receipt, event, head, minimumConfirmations, observation.ancestry,
        )) return { disposition: "indeterminate", reason: "eip3009-cancellation-not-finalized" };
        return {
          disposition: "cancelled",
          reason: "eip3009-authorization-cancelled",
          authenticationHash: terminalAuthenticationHash({
            intent,
            disposition: "cancelled",
            head,
            state,
            event,
            receipt: observation.receipt,
            ancestry: observation.ancestry,
          }),
        };
      }
      if (observation.usedLogs.length === 1) {
        const event = observation.usedLogs[0]!;
        if (!state.used || !observation.receipt || !observation.ancestry || !finalizedReceipt(
          observation.receipt, event, head, minimumConfirmations, observation.ancestry,
        )) return { disposition: "indeterminate", reason: "eip3009-settlement-not-finalized" };
        const transfers = matchingTransfers(observation.receipt, intent);
        if (transfers.length > 1) {
          return { disposition: "indeterminate", reason: "erc20-transfer-events-ambiguous" };
        }
        if (transfers.length === 0) {
          return {
            disposition: "used-different",
            reason: "eip3009-authorization-used-without-agreed-transfer",
            authenticationHash: terminalAuthenticationHash({
              intent,
              disposition: "used-different",
              head,
              state,
              event,
              receipt: observation.receipt,
              ancestry: observation.ancestry,
            }),
          };
        }
        const transfer = transfers[0]!;
        const disclosure = observation.candidate;
        if (!disclosure) {
          return {
            disposition: "indeterminate",
            reason: observation.candidateIssue ?? "payment-response-recovery-unavailable",
          };
        }
        if (disclosure.transactionHash !== event.transactionHash ||
            disclosure.transactionHash !== observation.receipt.transactionHash) {
          return { disposition: "indeterminate", reason: "payment-response-transaction-mismatch" };
        }
        const signedEvent = {
          kind: "x402-event" as const,
          httpResource: intent.httpResource,
          paymentReceiptHash: disclosure.paymentReceiptHash,
          protocolVersion: "2" as const,
          settlementTxHash: event.transactionHash.slice(2),
          chainId,
          // DACS x402-event identity names the exact value-transfer event. The
          // AuthorizationUsed log authenticates nonce consumption but is not
          // itself the settlement value movement.
          logIndex: transfer.logIndex,
        };
        return {
          disposition: "settled-same",
          settlement: deepFreeze({
            captureVersion: "1" as const,
            protocolVersion: "2" as const,
            headerName: "PAYMENT-RESPONSE" as const,
            encodedSettlementHeader: disclosure.disclosure.encodedSettlementHeader,
            httpResource: intent.httpResource,
            signedEvent,
            authenticationHash: x402BuyerSettlementAuthenticationHash({ intent, signedEvent }),
          }),
        };
      }
      if (state.used) {
        return { disposition: "indeterminate", reason: "eip3009-used-event-lookup-incomplete" };
      }
      const finalityTimestamp = BigInt(head.timestamp);
      if (finalityTimestamp >= BigInt(authorization.validBefore)) {
        return {
          disposition: "expired-unused",
          reason: "eip3009-authorization-expired-unused",
          authenticationHash: terminalAuthenticationHash({
            intent, disposition: "expired-unused", head, state,
          }),
        };
      }
      if (observation.candidate) {
        return { disposition: "indeterminate", reason: "payment-response-not-finalized" };
      }
      if (finalityTimestamp <= BigInt(authorization.validAfter)) {
        return { disposition: "indeterminate", reason: "eip3009-authorization-not-yet-valid" };
      }
      if (!options.confirmUnused) {
        return { disposition: "indeterminate", reason: "eip3009-replay-safety-unproven" };
      }
      try {
        await fence.assertCurrent();
        const verdict = await options.confirmUnused(deepFreeze({
          intent,
          authorization,
          finalityHead: head,
          authorizationState: state,
          fence,
        }));
        await fence.assertCurrent();
        const checked = exactRecord(verdict, ["disposition"], ["bindingHash", "reason"]);
        if (!checked || checked.disposition !== "safe" ||
            checked.bindingHash !== intent.bindingHash ||
            Object.keys(checked).length !== 2) {
          const reason = checked && captureReason(checked.reason);
          return {
            disposition: "indeterminate",
            reason: reason ?? "eip3009-replay-safety-unproven",
          };
        }
        return {
          disposition: "unused",
          reason: "authenticated-unused-and-replay-safe",
          authenticationHash: terminalAuthenticationHash({
            intent, disposition: "unused", head, state,
          }),
        };
      } catch {
        return { disposition: "indeterminate", reason: "eip3009-replay-safety-unavailable" };
      }
    },
  };
  return Object.freeze(provider);
}
