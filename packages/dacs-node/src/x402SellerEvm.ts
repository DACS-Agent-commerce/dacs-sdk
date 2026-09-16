import { types as nodeTypes } from "node:util";

import {
  EIP3009_AUTHORIZATION_USED_TOPIC,
  ERC20_TRANSFER_TOPIC,
  getAuthenticatedRailProvenance,
  isAuthenticatedRailDefinition,
  type AuthenticatedRailDefinition,
  type SellerPaymentIntakeDeps,
  type X402PaywallSettlementIntent,
  type X402PaywallSettlementReconciliation,
  type X402PaywallSettlementResult,
} from "@kynesyslabs/dacs";
import { canonicalize } from "@kynesyslabs/dacs/canonical";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const INTEGER_RE = /^(0|[1-9][0-9]*)$/;
const AUTHORIZATION_STATE_SELECTOR = "0xe94a0102";
const DEFAULT_LOG_PAGE_SIZE = 2_000;

type ObserveX402Transfer = SellerPaymentIntakeDeps["observeX402Transfer"];
type VerifyReceiptExtensions = SellerPaymentIntakeDeps["verifyX402ReceiptExtensions"];
type ClassifySettlementChain = SellerPaymentIntakeDeps["classifyX402SettlementChain"];

export interface DacsX402SellerEvmObserverOptionsV1 {
  rail: Readonly<AuthenticatedRailDefinition>;
  rpcUrl: string;
  authorizationSearchFromBlock: number;
  finalityTag?: "finalized" | "safe" | "latest";
  logPageSize?: number;
  fetchImpl?: typeof fetch;
  /** @deprecated Finality time is derived from canonical chain history. */
  now?(): number;
}

export interface DacsX402SellerEvmObserverV1 {
  readonly network: `eip155:${string}`;
  readonly chainId: number;
  readonly observeX402Transfer: ObserveX402Transfer;
  readonly reconcileSettlement: (
    intent: Readonly<X402PaywallSettlementIntent>,
  ) => Promise<Readonly<X402PaywallSettlementReconciliation>>;
  readonly verifyX402ReceiptExtensions: VerifyReceiptExtensions;
  readonly classifyX402SettlementChain: ClassifySettlementChain;
}

export class DacsX402SellerEvmObserverError extends Error {
  override readonly name = "DacsX402SellerEvmObserverError";

  constructor(readonly reasonCode: string) {
    super(reasonCode);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    !nodeTypes.isProxy(value);
}

function quantity(value: unknown): number {
  if (typeof value !== "string" || !QUANTITY_RE.test(value)) {
    throw new DacsX402SellerEvmObserverError("seller-evm-quantity-invalid");
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DacsX402SellerEvmObserverError("seller-evm-quantity-unsafe");
  }
  return Number(parsed);
}

function blockTimestamp(value: unknown): number {
  const seconds = quantity(value);
  const milliseconds = BigInt(seconds) * 1_000n;
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DacsX402SellerEvmObserverError("seller-evm-timestamp-unsafe");
  }
  return Number(milliseconds);
}

function topicAddress(topic: unknown): string | undefined {
  if (typeof topic !== "string" || !HASH_RE.test(topic) ||
      !/^0{24}$/i.test(topic.slice(2, 26))) return undefined;
  return `0x${topic.slice(26)}`.toLowerCase();
}

function addressTopic(address: string): string {
  return `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;
}

function canonicalHash(value: unknown): string | undefined {
  return typeof value === "string" && HASH_RE.test(value)
    ? value.toLowerCase() : undefined;
}

interface RpcLogV1 {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  removed: boolean;
}

function captureLog(value: unknown): Readonly<RpcLogV1> {
  if (!record(value) || typeof value.address !== "string" ||
      !ADDRESS_RE.test(value.address) || !Array.isArray(value.topics) ||
      nodeTypes.isProxy(value.topics) || !value.topics.every((topic) =>
        typeof topic === "string" && HASH_RE.test(topic)) ||
      typeof value.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value.data) ||
      canonicalHash(value.transactionHash) === undefined ||
      canonicalHash(value.blockHash) === undefined ||
      (value.removed !== undefined && typeof value.removed !== "boolean")) {
    throw new DacsX402SellerEvmObserverError("seller-evm-log-invalid");
  }
  return Object.freeze({
    address: value.address.toLowerCase(),
    topics: value.topics.map((topic) => topic.toLowerCase()),
    data: value.data.toLowerCase(),
    transactionHash: canonicalHash(value.transactionHash)!,
    blockNumber: quantity(value.blockNumber),
    blockHash: canonicalHash(value.blockHash)!,
    logIndex: quantity(value.logIndex),
    removed: value.removed ?? false,
  });
}

interface RpcReceiptV1 {
  transactionHash: string;
  blockNumber: number;
  blockHash: string;
  status: "success" | "reverted";
  logs: readonly Readonly<RpcLogV1>[];
}

function captureReceipt(value: unknown): Readonly<RpcReceiptV1> | null {
  if (value === null) return null;
  if (!record(value) || canonicalHash(value.transactionHash) === undefined ||
      canonicalHash(value.blockHash) === undefined ||
      (value.status !== "0x1" && value.status !== "0x0") ||
      !Array.isArray(value.logs) || nodeTypes.isProxy(value.logs)) {
    throw new DacsX402SellerEvmObserverError("seller-evm-receipt-invalid");
  }
  const transactionHash = canonicalHash(value.transactionHash)!;
  const blockHash = canonicalHash(value.blockHash)!;
  const blockNumber = quantity(value.blockNumber);
  const logs = value.logs.map(captureLog);
  if (logs.some((log) => log.transactionHash !== transactionHash ||
      log.blockHash !== blockHash || log.blockNumber !== blockNumber || log.removed)) {
    throw new DacsX402SellerEvmObserverError("seller-evm-receipt-log-invalid");
  }
  return Object.freeze({
    transactionHash,
    blockNumber,
    blockHash,
    status: value.status === "0x1" ? "success" : "reverted",
    logs,
  });
}

interface RpcBlockV1 {
  number: number;
  hash: string;
  timestampMs: number;
}

function captureBlock(value: unknown): Readonly<RpcBlockV1> {
  if (!record(value) || canonicalHash(value.hash) === undefined) {
    throw new DacsX402SellerEvmObserverError("seller-evm-block-invalid");
  }
  return Object.freeze({
    number: quantity(value.number),
    hash: canonicalHash(value.hash)!,
    timestampMs: blockTimestamp(value.timestamp),
  });
}

function rpcEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError("seller EVM RPC URL is invalid");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("seller EVM RPC URL is invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const unbracketed = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1) : hostname;
  const loopback = unbracketed === "localhost" || unbracketed.endsWith(".localhost") ||
    unbracketed === "::1" || unbracketed === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(unbracketed);
  if ((url.protocol !== "https:" && (url.protocol !== "http:" || !loopback)) ||
      url.username || url.password || url.hash) {
    throw new TypeError("seller EVM RPC URL is invalid");
  }
  return url.toString();
}

function settlementReceiptHeader(receipt: Readonly<{
  transaction: string;
  network: string;
  payer: string;
  amount: string;
}>): string {
  return Buffer.from(JSON.stringify({
    success: true,
    transaction: receipt.transaction,
    network: receipt.network,
    payer: receipt.payer,
    amount: receipt.amount,
  }), "utf8").toString("base64");
}

function authorizationFromIntent(intent: Readonly<X402PaywallSettlementIntent>): Readonly<{
  from: string;
  to: string;
  value: string;
  nonce: string;
  validBefore: string;
}> | undefined {
  if (!record(intent) || !record(intent.paymentPayload)) return undefined;
  const payload = intent.paymentPayload.payload;
  if (!record(payload) || !record(payload.authorization)) return undefined;
  const authorization = payload.authorization;
  if (typeof authorization.from !== "string" || !ADDRESS_RE.test(authorization.from) ||
      typeof authorization.to !== "string" || !ADDRESS_RE.test(authorization.to) ||
      typeof authorization.value !== "string" || !INTEGER_RE.test(authorization.value) ||
      typeof authorization.nonce !== "string" || !HASH_RE.test(authorization.nonce) ||
      typeof authorization.validBefore !== "string" ||
      !INTEGER_RE.test(authorization.validBefore)) return undefined;
  return Object.freeze({
    from: authorization.from.toLowerCase(),
    to: authorization.to.toLowerCase(),
    value: authorization.value,
    nonce: authorization.nonce.toLowerCase(),
    validBefore: authorization.validBefore,
  });
}

/**
 * Authenticate seller-side x402 settlement directly from canonical EVM data.
 * The observer never treats a facilitator response or transaction hash alone
 * as finality: it requires the exact AuthorizationUsed and ERC-20 Transfer in
 * one successful canonical receipt beneath the configured finality head.
 */
export function createDacsX402SellerEvmObserverV1(
  options: Readonly<DacsX402SellerEvmObserverOptionsV1>,
): Readonly<DacsX402SellerEvmObserverV1> {
  if (!record(options) || !isAuthenticatedRailDefinition(options.rail) ||
      getAuthenticatedRailProvenance(options.rail) === null ||
      options.rail.railType !== "x402" || options.rail.phaseHandler !== "pay-x402" ||
      options.rail.asset.kind !== "erc20" ||
      !Number.isSafeInteger(options.authorizationSearchFromBlock) ||
      options.authorizationSearchFromBlock < 0 ||
      (options.finalityTag !== undefined &&
        !["finalized", "safe", "latest"].includes(options.finalityTag)) ||
      (options.fetchImpl !== undefined && typeof options.fetchImpl !== "function") ||
      (options.now !== undefined && typeof options.now !== "function")) {
    throw new TypeError("seller x402 EVM observer options are invalid");
  }
  const rpcUrl = rpcEndpoint(options.rpcUrl);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("seller x402 EVM observer requires fetch");
  }
  const logPageSize = options.logPageSize ?? DEFAULT_LOG_PAGE_SIZE;
  if (!Number.isSafeInteger(logPageSize) || logPageSize <= 0 || logPageSize > 100_000) {
    throw new TypeError("seller x402 EVM log page size is invalid");
  }
  const rail = options.rail;
  if (rail.asset.kind !== "erc20") throw new TypeError("seller x402 EVM rail is invalid");
  const railAsset = rail.asset;
  const chainId = railAsset.chainId;
  const network = `eip155:${chainId}` as const;
  const asset = railAsset.contract.toLowerCase();
  const minimumConfirmations = record(rail.parameters) &&
      Number.isSafeInteger(rail.parameters.finalityBlocks) &&
      Number(rail.parameters.finalityBlocks) > 0
    ? Number(rail.parameters.finalityBlocks) : 1;
  const finalityTag = options.finalityTag ?? "finalized";
  let requestId = 0;

  const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    requestId += 1;
    const id = requestId;
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) {
      throw new DacsX402SellerEvmObserverError("seller-evm-rpc-http-failed");
    }
    const value: unknown = await response.json();
    if (!record(value) || value.jsonrpc !== "2.0" || value.id !== id ||
        Object.hasOwn(value, "error") || !Object.hasOwn(value, "result")) {
      throw new DacsX402SellerEvmObserverError("seller-evm-rpc-response-invalid");
    }
    return value.result;
  };

  const head = async (): Promise<Readonly<RpcBlockV1>> => {
    const [rawChainId, block] = await Promise.all([
      rpc("eth_chainId", []),
      rpc("eth_getBlockByNumber", [finalityTag, false]),
    ]);
    if (quantity(rawChainId) !== chainId) {
      throw new DacsX402SellerEvmObserverError("seller-evm-chain-mismatch");
    }
    return captureBlock(block);
  };

  const receipt = async (transactionHash: string) => captureReceipt(
    await rpc("eth_getTransactionReceipt", [transactionHash]),
  );

  const canonicalBlock = async (blockNumber: number) => captureBlock(
    await rpc("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]),
  );

  const observe: ObserveX402Transfer = async ({ chainId: requestedChain, txHash }) => {
    if (requestedChain !== chainId || !HASH_RE.test(txHash)) {
      return { status: "failed", reason: "settlement-transaction-binding-invalid" };
    }
    try {
      const [transaction, finalityHead] = await Promise.all([
        receipt(txHash.toLowerCase()),
        head(),
      ]);
      if (transaction === null) {
        return { status: "not-found", reason: "settlement-transaction-not-found" };
      }
      if (transaction.status !== "success") {
        return { status: "failed", reason: "settlement-transaction-reverted" };
      }
      if (transaction.blockNumber > finalityHead.number) {
        return { status: "pending", reason: "settlement-finality-pending" };
      }
      const confirmations = finalityHead.number - transaction.blockNumber + 1;
      if (confirmations < minimumConfirmations) {
        return { status: "pending", reason: "settlement-confirmations-pending" };
      }
      const block = await canonicalBlock(transaction.blockNumber);
      if (block.hash !== transaction.blockHash) {
        return { status: "unavailable", reason: "settlement-block-not-canonical" };
      }
      const finalityBlockNumber = transaction.blockNumber + minimumConfirmations - 1;
      const finalityBlock = finalityBlockNumber === transaction.blockNumber
        ? block : await canonicalBlock(finalityBlockNumber);
      if (finalityBlock.number !== finalityBlockNumber ||
          finalityBlock.timestampMs < block.timestampMs) {
        return { status: "unavailable", reason: "settlement-finality-history-invalid" };
      }
      const transfers = transaction.logs.filter((log) =>
        log.address === asset && log.topics.length === 3 &&
        log.topics[0] === ERC20_TRANSFER_TOPIC && topicAddress(log.topics[1]) !== undefined &&
        topicAddress(log.topics[2]) !== undefined && /^0x[0-9a-f]{64}$/.test(log.data));
      const authorizations = transaction.logs.filter((log) =>
        log.address === asset && log.topics.length === 3 &&
        log.topics[0] === EIP3009_AUTHORIZATION_USED_TOPIC &&
        topicAddress(log.topics[1]) !== undefined && HASH_RE.test(log.topics[2] ?? "") &&
        log.data === "0x");
      if (transfers.length !== 1 || authorizations.length !== 1 ||
          transfers[0]!.topics[1] !== authorizations[0]!.topics[1]) {
        return { status: "failed", reason: "settlement-events-ambiguous" };
      }
      const transfer = transfers[0]!;
      const authorization = authorizations[0]!;
      const payer = topicAddress(transfer.topics[1])!;
      const payee = topicAddress(transfer.topics[2])!;
      const amount = BigInt(transfer.data).toString();
      return {
        status: "finalized",
        chainId,
        txHash: transaction.transactionHash,
        logIndex: transfer.logIndex,
        payer,
        payee,
        amountBaseUnits: amount,
        asset: {
          contract: railAsset.contract,
          symbol: railAsset.symbol,
          decimals: railAsset.decimals,
        },
        confirmations,
        includedAt: block.timestampMs,
        // The durable deadline decision must survive a late observer or a
        // process restart. Bind it to the canonical block where the rail's
        // required depth was first reached, not to this process's wall clock.
        finalityObservedAt: finalityBlock.timestampMs,
        sessionBinding: { kind: "eip3009", nonce: authorization.topics[2]! },
      };
    } catch {
      return { status: "unavailable", reason: "settlement-rpc-unavailable" };
    }
  };

  const authorizationLogs = async (
    payer: string,
    nonce: string,
    toBlock: number,
  ): Promise<readonly Readonly<RpcLogV1>[]> => {
    const found: Readonly<RpcLogV1>[] = [];
    for (let from = options.authorizationSearchFromBlock; from <= toBlock;
      from += logPageSize) {
      const last = Math.min(toBlock, from + logPageSize - 1);
      const raw = await rpc("eth_getLogs", [{
        address: railAsset.contract,
        topics: [EIP3009_AUTHORIZATION_USED_TOPIC, addressTopic(payer), nonce],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${last.toString(16)}`,
      }]);
      if (!Array.isArray(raw) || nodeTypes.isProxy(raw)) {
        throw new DacsX402SellerEvmObserverError("seller-evm-log-query-invalid");
      }
      found.push(...raw.map(captureLog));
      if (found.length > 1) break;
    }
    return found;
  };

  const authorizationUsed = async (
    payer: string,
    nonce: string,
    finalityHead: Readonly<RpcBlockV1>,
  ): Promise<boolean> => {
    const data = `${AUTHORIZATION_STATE_SELECTOR}${payer.slice(2).toLowerCase()
      .padStart(64, "0")}${nonce.slice(2).toLowerCase()}`;
    const raw = await rpc("eth_call", [{ to: railAsset.contract, data }, {
      blockHash: finalityHead.hash,
      requireCanonical: true,
    }]);
    if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(raw) ||
        (BigInt(raw) !== 0n && BigInt(raw) !== 1n)) {
      throw new DacsX402SellerEvmObserverError("seller-evm-authorization-state-invalid");
    }
    return BigInt(raw) === 1n;
  };

  const reconcileSettlement = async (
    intent: Readonly<X402PaywallSettlementIntent>,
  ): Promise<Readonly<X402PaywallSettlementReconciliation>> => {
    try {
      const authorization = authorizationFromIntent(intent);
      if (authorization === undefined || !record(intent.paymentPayload) ||
          !record(intent.paymentPayload.accepted) ||
          !record(intent.paymentRequirements)) {
        return { status: "indeterminate", reason: "settlement-intent-invalid" };
      }
      const accepted = intent.paymentPayload.accepted;
      const requirements = intent.paymentRequirements;
      if (accepted.network !== network || typeof accepted.asset !== "string" ||
          accepted.asset.toLowerCase() !== asset || requirements.network !== network ||
          typeof requirements.asset !== "string" || requirements.asset.toLowerCase() !== asset ||
          typeof intent.payer !== "string" || !ADDRESS_RE.test(intent.payer) ||
          intent.payer.toLowerCase() !== authorization.from ||
          typeof requirements.payTo !== "string" || !ADDRESS_RE.test(requirements.payTo) ||
          requirements.payTo.toLowerCase() !== authorization.to ||
          requirements.amount !== authorization.value) {
        return { status: "indeterminate", reason: "settlement-intent-invalid" };
      }
      const finalityHead = await head();
      const logs = await authorizationLogs(
        intent.payer,
        authorization.nonce,
        finalityHead.number,
      );
      const hashes = [...new Set(logs.map((log) => log.transactionHash))];
      if (hashes.length > 1 || logs.length > 1) {
        return { status: "indeterminate", reason: "settlement-events-ambiguous" };
      }
      if (hashes.length === 1) {
        const observation = await observe({ chainId, txHash: hashes[0]! });
        if (observation.status !== "finalized") {
          return { status: observation.status === "failed" ? "indeterminate" : "pending",
            reason: observation.reason ?? "settlement-observation-pending" };
        }
        if (observation.sessionBinding.kind !== "eip3009" ||
            observation.sessionBinding.nonce !== authorization.nonce ||
            observation.payer.toLowerCase() !== intent.payer.toLowerCase() ||
            observation.payee.toLowerCase() !== requirements.payTo.toLowerCase() ||
            observation.amountBaseUnits !== requirements.amount) {
          return { status: "indeterminate", reason: "settlement-observation-mismatch" };
        }
        const receipt = {
          success: true as const,
          transaction: observation.txHash,
          network,
          payer: observation.payer,
          amount: observation.amountBaseUnits,
        };
        const settlement: X402PaywallSettlementResult & { success: true } = {
          ...receipt,
          headers: { "PAYMENT-RESPONSE": settlementReceiptHeader(receipt) },
          requirements: structuredClone(requirements),
        };
        return { status: "settled", settlement };
      }
      const used = await authorizationUsed(intent.payer, authorization.nonce, finalityHead);
      if (used) {
        return { status: "indeterminate", reason: "authorization-used-event-unavailable" };
      }
      return BigInt(finalityHead.timestampMs) >= BigInt(authorization.validBefore) * 1_000n
        ? { status: "failed", reason: "authorization-expired-unused" }
        : {
            // The canonical chain proves this exact EIP-3009 nonce is still
            // unused. Re-driving the byte-identical retained authorization is
            // at-most-once even if an earlier facilitator request is still in
            // flight: the token contract can consume this nonce only once.
            status: "authoritatively-absent",
            reason: "authorization-live-unused-exact-redrive-safe",
          };
    } catch {
      return { status: "indeterminate", reason: "settlement-reconciliation-unavailable" };
    }
  };

  const verifyX402ReceiptExtensions: VerifyReceiptExtensions = ({
    protocolVersion,
    receipt,
  }) => {
    const allowed = new Set(["success", "transaction", "network", "payer", "amount"]);
    return protocolVersion === "2" && Object.keys(receipt).every((key) => allowed.has(key)) &&
        receipt.success === true && typeof receipt.transaction === "string" &&
        HASH_RE.test(receipt.transaction) && receipt.network === network &&
        typeof receipt.payer === "string" && ADDRESS_RE.test(receipt.payer) &&
        (receipt.amount === undefined ||
          typeof receipt.amount === "string" && INTEGER_RE.test(receipt.amount))
      ? { disposition: "pass" as const }
      : { disposition: "fail" as const, reason: "x402-receipt-extension-invalid" };
  };

  const classifyX402SettlementChain: ClassifySettlementChain = ({
    chainId: candidateChain,
    rail: candidateRail,
  }) => {
    try {
      return candidateChain === chainId &&
          canonicalize(candidateRail) === canonicalize(rail)
        ? { disposition: "l2" as const }
        : { disposition: "unsupported" as const,
          reason: "settlement-chain-unregistered" };
    } catch {
      return { disposition: "unsupported" as const,
        reason: "settlement-chain-unregistered" };
    }
  };

  return Object.freeze({
    network,
    chainId,
    observeX402Transfer: observe,
    reconcileSettlement,
    verifyX402ReceiptExtensions,
    classifyX402SettlementChain,
  });
}
