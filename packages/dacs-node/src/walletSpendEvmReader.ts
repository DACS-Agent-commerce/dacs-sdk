import {
  EIP3009_AUTHORIZATION_CANCELED_TOPIC,
  EIP3009_AUTHORIZATION_USED_TOPIC,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendPolicyV1,
} from "@kynesyslabs/dacs";

type Hex = `0x${string}`;

/** One block as the chain reported it. */
export interface DacsWalletSpendEvmBlockV1 { number: number; hash: Hex; timestamp: number }

/** One block read by its hash, with the parent hash that links it to the block below. */
export interface DacsWalletSpendEvmBlockLinkV1 extends DacsWalletSpendEvmBlockV1 { parentHash: Hex }

/** One event log, with every hex field in lowercase. */
export interface DacsWalletSpendEvmLogV1 {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: number;
}

/** One transaction receipt with its logs in the order the chain reported them. */
export interface DacsWalletSpendEvmReceiptV1 {
  transactionHash: Hex;
  blockNumber: number;
  blockHash: Hex;
  status: "success" | "reverted";
  logs: readonly Readonly<DacsWalletSpendEvmLogV1>[];
}

/** Bounded reads of the policy's wallet and asset on Base Sepolia. */
export interface DacsWalletSpendEvmReaderV1 {
  assertChain(): Promise<void>;
  readBalance: WalletSpendAuthorityDependenciesV1["readBalance"];
  readBlock(at: "latest" | number): Promise<Readonly<DacsWalletSpendEvmBlockV1>>;
  /** Rejects `wallet-spend-evm-rpc-response-invalid` unless the answer carries the hash asked for. */
  readBlockByHash(hash: Hex): Promise<Readonly<DacsWalletSpendEvmBlockLinkV1>>;
  readAuthorizationState(input: Readonly<{ nonce: Hex; blockHash: Hex }>): Promise<boolean>;
  readAuthorizationLogs(input: Readonly<{ nonce: Hex; toBlock: number }>):
    Promise<readonly Readonly<DacsWalletSpendEvmLogV1>[]>;
  readReceipt(transactionHash: Hex): Promise<Readonly<DacsWalletSpendEvmReceiptV1> | null>;
}

const BASE_SEPOLIA_CHAIN_ID = "0x14a34";
const SMALL_ANSWER_BYTES = 8 * 1024;
const LARGE_ANSWER_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const LOG_PAGE_BLOCKS = 2_000;
const MAX_RECEIPT_LOGS = 1_024;
const MAX_LOG_TOPICS = 4;
const BALANCE_OF_SELECTOR = "0x70a08231";
const AUTHORIZATION_STATE_SELECTOR = "0xe94a0102";
const QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const HASH32_RE = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/;

const RESPONSE_INVALID = "wallet-spend-evm-rpc-response-invalid";
const REQUEST_INVALID = "wallet-spend-evm-rpc-request-invalid";
const CHAIN_MISMATCH = "wallet-spend-testnet-authority-rpc-chain-mismatch";

const invalid = (): never => {
  throw new Error(RESPONSE_INVALID);
};

function answerObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : invalid();
}

function quantity(value: unknown): number {
  const parsed = typeof value === "string" && QUANTITY_RE.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : invalid();
}

function hexMatching(value: unknown, pattern: RegExp): Hex {
  return typeof value === "string" && pattern.test(value) ? value.toLowerCase() as Hex : invalid();
}

const hash32 = (value: unknown): Hex => hexMatching(value, HASH32_RE);

const toQuantity = (value: number): Hex => `0x${value.toString(16)}`;

const word = (address: string): string => address.slice(2).padStart(64, "0");

/** Shape checks every log passes, whether it comes from a receipt or a log search. */
function captureLogShape(raw: unknown): Readonly<DacsWalletSpendEvmLogV1> {
  const log = answerObject(raw);
  if (!Array.isArray(log.topics) || log.topics.length > MAX_LOG_TOPICS ||
      (log.removed !== undefined && log.removed !== false)) {
    invalid();
  }
  return Object.freeze({
    address: hexMatching(log.address, ADDRESS_RE),
    topics: Object.freeze((log.topics as unknown[]).map(hash32)),
    data: hexMatching(log.data, DATA_RE),
    blockNumber: quantity(log.blockNumber),
    blockHash: hash32(log.blockHash),
    transactionHash: hash32(log.transactionHash),
    logIndex: quantity(log.logIndex),
  });
}

/** The general receipt-log rule: a well-formed log that belongs to this receipt. */
function captureReceiptLog(
  raw: unknown,
  receipt: Readonly<{ transactionHash: Hex; blockNumber: number; blockHash: Hex }>,
): Readonly<DacsWalletSpendEvmLogV1> {
  const log = captureLogShape(raw);
  if (log.transactionHash !== receipt.transactionHash || log.blockNumber !== receipt.blockNumber ||
      log.blockHash !== receipt.blockHash) {
    invalid();
  }
  return log;
}

/**
 * Bounded reads of one Base Sepolia JSON-RPC endpoint for the policy's wallet
 * and its one asset. Each answer has a byte limit, a deadline and strict shape
 * checks, and no error message carries the RPC address.
 *
 * @returns A reader whose methods reject with a named `Error` (for example
 *   `wallet-spend-evm-rpc-response-too-large`) and never take a wallet or asset argument.
 * @throws Error `wallet-spend-evm-rpc-request-invalid` when the policy is not one
 *   20-byte wallet and one 20-byte asset, or the timeout or search floor is out of range.
 */
export function createDacsWalletSpendEvmReaderV1(input: Readonly<{
  rpcUrl: string;
  policy: Readonly<WalletSpendPolicyV1>;
  authorizationSearchFromBlock: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}>): Readonly<DacsWalletSpendEvmReaderV1> {
  const { policy, rpcUrl, authorizationSearchFromBlock: floor } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestFetch = input.fetch ?? globalThis.fetch;
  const [assetPolicy, ...otherAssets] = policy.assets;
  if (assetPolicy === undefined || otherAssets.length > 0 || !ADDRESS_RE.test(assetPolicy.asset) ||
      !ADDRESS_RE.test(policy.wallet) || !Number.isSafeInteger(floor) || floor < 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(REQUEST_INVALID);
  }
  const policyAsset = assetPolicy.asset;
  const asset = policyAsset.toLowerCase();
  const walletWord = word(policy.wallet.toLowerCase());
  const walletTopic = `0x${walletWord}`;
  let nextId = 1;

  async function boundedText(response: Response, maximumBytes: number): Promise<string> {
    const declared = response.headers.get("content-length");
    if (response.body === null || (declared !== null && Number(declared) > maximumBytes)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(response.body === null ? RESPONSE_INVALID : "wallet-spend-evm-rpc-response-too-large");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new Error("wallet-spend-evm-rpc-unavailable", { cause: error });
      }
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximumBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error("wallet-spend-evm-rpc-response-too-large");
      }
      chunks.push(chunk.value);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      return invalid();
    }
  }

  async function exchange(
    method: string,
    params: readonly unknown[],
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    const id = nextId++;
    let response: Response;
    try {
      response = await requestFetch(rpcUrl, {
        method: "POST",
        // A redirect comes back as its own 3xx answer, which the status check refuses.
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal,
      });
    } catch (error) {
      throw new Error("wallet-spend-evm-rpc-unavailable", { cause: error });
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      invalid();
    }
    const text = await boundedText(response, maximumBytes);
    let envelope: Record<string, unknown>;
    try {
      envelope = answerObject(JSON.parse(text));
    } catch {
      return invalid();
    }
    if (envelope.jsonrpc !== "2.0" || envelope.id !== id || Object.hasOwn(envelope, "error") ||
        !Object.hasOwn(envelope, "result")) {
      invalid();
    }
    return envelope.result;
  }

  /** One JSON-RPC call with a byte limit and a deadline that covers the whole answer. */
  async function rpc(method: string, params: readonly unknown[], maximumBytes: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await exchange(method, params, maximumBytes, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error("wallet-spend-evm-rpc-deadline-exceeded", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function assertChain(): Promise<void> {
    let chainId: unknown;
    try {
      chainId = await rpc("eth_chainId", [], SMALL_ANSWER_BYTES);
    } catch (error) {
      throw new Error("wallet-spend-testnet-authority-rpc-unavailable", { cause: error });
    }
    if (typeof chainId !== "string" || chainId.toLowerCase() !== BASE_SEPOLIA_CHAIN_ID) {
      throw new Error(CHAIN_MISMATCH);
    }
  }

  async function readBalance(
    scope: Readonly<{ wallet: string; chainId: string; asset: string }>,
  ): Promise<string> {
    if (scope.wallet !== policy.wallet || scope.chainId !== policy.chainId ||
        scope.asset !== policyAsset) {
      throw new Error("wallet-spend-evm-rpc-scope-refused");
    }
    const answer = await rpc("eth_call", [
      { to: asset, data: `${BALANCE_OF_SELECTOR}${walletWord}` }, "latest",
    ], SMALL_ANSWER_BYTES);
    return BigInt(hash32(answer)).toString(10);
  }

  async function readBlock(at: "latest" | number): Promise<Readonly<DacsWalletSpendEvmBlockV1>> {
    if (at !== "latest" && (!Number.isSafeInteger(at) || at < 0)) throw new Error(REQUEST_INVALID);
    const [, raw] = await Promise.all([
      assertChain(),
      rpc("eth_getBlockByNumber", [at === "latest" ? at : toQuantity(at), false], LARGE_ANSWER_BYTES),
    ]);
    const block = answerObject(raw);
    const number = quantity(block.number);
    if (at !== "latest" && number !== at) invalid();
    return Object.freeze({ number, hash: hash32(block.hash), timestamp: quantity(block.timestamp) });
  }

  async function readBlockByHash(hash: Hex): Promise<Readonly<DacsWalletSpendEvmBlockLinkV1>> {
    if (!HASH32_RE.test(hash)) throw new Error(REQUEST_INVALID);
    const asked = hash.toLowerCase() as Hex;
    const [, raw] = await Promise.all([
      assertChain(),
      rpc("eth_getBlockByHash", [asked, false], LARGE_ANSWER_BYTES),
    ]);
    const block = answerObject(raw);
    const number = quantity(block.number);
    if (hash32(block.hash) !== asked) invalid();
    return Object.freeze({
      number, hash: asked, parentHash: hash32(block.parentHash), timestamp: quantity(block.timestamp),
    });
  }

  async function readAuthorizationState(
    query: Readonly<{ nonce: Hex; blockHash: Hex }>,
  ): Promise<boolean> {
    if (!HASH32_RE.test(query.nonce) || !HASH32_RE.test(query.blockHash)) throw new Error(REQUEST_INVALID);
    const data = `${AUTHORIZATION_STATE_SELECTOR}${walletWord}${query.nonce.slice(2).toLowerCase()}`;
    const answer = BigInt(hash32(await rpc("eth_call", [
      { to: asset, data },
      { blockHash: query.blockHash.toLowerCase(), requireCanonical: true },
    ], SMALL_ANSWER_BYTES)));
    return answer > 1n ? invalid() : answer === 1n;
  }

  /** The authorization-log rule: one of the two events, on the asset, for this wallet and nonce. */
  function captureAuthorizationLog(
    raw: unknown,
    nonce: Hex,
    page: Readonly<{ from: number; to: number }>,
  ): Readonly<DacsWalletSpendEvmLogV1> {
    const log = captureLogShape(raw);
    const [event, payer, loggedNonce, ...rest] = log.topics;
    if (log.address !== asset || rest.length > 0 || log.data !== "0x" ||
        (event !== EIP3009_AUTHORIZATION_USED_TOPIC && event !== EIP3009_AUTHORIZATION_CANCELED_TOPIC) ||
        payer !== walletTopic || loggedNonce !== nonce ||
        log.blockNumber < page.from || log.blockNumber > page.to) {
      invalid();
    }
    return log;
  }

  async function readAuthorizationLogs(
    query: Readonly<{ nonce: Hex; toBlock: number }>,
  ): Promise<readonly Readonly<DacsWalletSpendEvmLogV1>[]> {
    if (!HASH32_RE.test(query.nonce) || !Number.isSafeInteger(query.toBlock) || query.toBlock < floor) {
      throw new Error(REQUEST_INVALID);
    }
    const nonce = query.nonce.toLowerCase() as Hex;
    const topics = [[EIP3009_AUTHORIZATION_USED_TOPIC, EIP3009_AUTHORIZATION_CANCELED_TOPIC], walletTopic, nonce];
    for (let to = query.toBlock; to >= floor; to -= LOG_PAGE_BLOCKS) {
      const page = { from: Math.max(floor, to - LOG_PAGE_BLOCKS + 1), to };
      const answer = await rpc("eth_getLogs", [{
        address: asset, topics, fromBlock: toQuantity(page.from), toBlock: toQuantity(page.to),
      }], LARGE_ANSWER_BYTES);
      if (!Array.isArray(answer)) invalid();
      const logs = (answer as unknown[]).map((raw) => captureAuthorizationLog(raw, nonce, page));
      if (logs.length > 0) return Object.freeze(logs);
    }
    return Object.freeze([]);
  }

  async function readReceipt(transactionHash: Hex): Promise<Readonly<DacsWalletSpendEvmReceiptV1> | null> {
    if (!HASH32_RE.test(transactionHash)) throw new Error(REQUEST_INVALID);
    const answer = await rpc("eth_getTransactionReceipt", [transactionHash], LARGE_ANSWER_BYTES);
    if (answer === null) return null;
    const raw = answerObject(answer);
    if (!Array.isArray(raw.logs) || raw.logs.length > MAX_RECEIPT_LOGS ||
        (raw.status !== "0x1" && raw.status !== "0x0")) {
      invalid();
    }
    const receipt = {
      transactionHash: hash32(raw.transactionHash),
      blockNumber: quantity(raw.blockNumber),
      blockHash: hash32(raw.blockHash),
    };
    if (receipt.transactionHash !== transactionHash.toLowerCase()) invalid();
    const logs = (raw.logs as unknown[]).map((log) => captureReceiptLog(log, receipt));
    if (new Set(logs.map((log) => log.logIndex)).size !== logs.length) invalid();
    return Object.freeze({
      ...receipt,
      status: raw.status === "0x1" ? "success" as const : "reverted" as const,
      logs: Object.freeze(logs),
    });
  }

  return Object.freeze({
    assertChain,
    readBalance,
    readBlock,
    readBlockByHash,
    readAuthorizationState,
    readAuthorizationLogs,
    readReceipt,
  });
}
