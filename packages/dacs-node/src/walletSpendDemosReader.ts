import { randomUUID } from "node:crypto";

import {
  DEMOS_HISTORY_MAX_PAGE_SIZE,
  DemosChainIdentityError,
  canonicalWalletSpendWalletV1,
  observePayDemTransferCore,
  type DemosTransferObservation,
  type WalletSpendAuthorityDependenciesV1,
  type WalletSpendPolicyV1,
} from "@kynesyslabs/dacs";
import { TP1_APPROVED_IDENTITY_RECORD, WireError, bindTp1Profile } from "@kynesyslabs/dacs/wire";

import { DacsWalletSpendTestnetAuthorityError } from "./walletSpendTestnetSettings.js";

/** Bounded reads of the policy's DEM wallet on the Demos testnet. */
export interface DacsWalletSpendDemosReaderV1 {
  /** Start check: `bindTp1Profile` binds the node to the approved testnet record, else rejects
   * `wallet-spend-testnet-authority-demos-network-mismatch` or `-demos-node-unavailable`. */
  assertNetwork(): Promise<void>;
  /** The policy wallet's DEM balance in OS, as a decimal string. */
  readBalance: WalletSpendAuthorityDependenciesV1["readBalance"];
  /** The SDK observation of a transfer, with the `getTxByHash` record it used, if it read one. */
  observeTransfer(txHash: string): Promise<Readonly<{
    observation: Readonly<DemosTransferObservation>;
    record?: unknown;
  }>>;
  /** The policy wallet's highest confirmed account nonce. An answer that is not one is refused, never read as 0. */
  readAccountNonce(): Promise<number>;
  /** The nonce the wallet's next transfer signs with: the confirmed account nonce plus one. */
  plannedTransferNonce(): Promise<number>;
  /** The node's `getTxByHash` answer for `txHash`, unparsed. */
  readRecord(txHash: string): Promise<unknown>;
  /**
   * The hash and block number of the wallet's one own confirmed transaction at `nonce` on its newest
   * history page, or undefined when the page does not show exactly one. They only locate the
   * transaction; the caller reads its record back and requires the same block before deciding anything.
   */
  findTransactionAtNonce(nonce: number): Promise<DemosHistorySlot | undefined>;
}

/** The own history row that took a nonce. */
export type DemosHistorySlot = Readonly<{ hash: string; blockNumber: number }>;

const RECORD_ANSWER_BYTES = 64 * 1024;
/** A block or a history page lists many transactions, so it gets a larger limit than a record. */
const LIST_ANSWER_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const OS_PER_DEM = 1_000_000_000n;
const AMOUNT_RE = /^(?:0|[1-9][0-9]*)$/;
const TX_HASH_RE = /^[0-9a-f]{64}$/;
const RESPONSE_INVALID = "wallet-spend-demos-rpc-response-invalid";
const RESPONSE_TOO_LARGE = "wallet-spend-demos-rpc-response-too-large";

const invalid = (): never => { throw new Error(RESPONSE_INVALID); };

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const answerObject = (value: unknown): Record<string, unknown> => (isObject(value) ? value : invalid());

/** A nonce as the node writes it: a non-negative safe integer, or a canonical decimal string of one. */
function nodeNonce(value: unknown): number | null {
  const nonce = typeof value === "string" && AMOUNT_RE.test(value) ? Number(value) : value;
  return typeof nonce === "number" && Number.isSafeInteger(nonce) && nonce >= 0 ? nonce : null;
}

/** A Demos account as `0x` and 64 lowercase hex digits, or null. */
function demosAccount(value: unknown): string | null {
  const account = canonicalWalletSpendWalletV1(value);
  return account?.length === 66 ? account : null;
}

/**
 * One history row of `wallet`: "skip" when it says nothing about the wallet's nonce (a failed row, or
 * another readable payer), the own confirmed row's nonce, hash and block number, or "unknown" for
 * anything else, which makes the whole page unknown. The payer is `from_ed25519_address` when present,
 * else `from`.
 */
function slotRow(row: unknown, wallet: string): "skip" | "unknown" | (DemosHistorySlot & Readonly<{ nonce: number }>) {
  if (!isObject(row) || (row.status !== "confirmed" && row.status !== "failed")) return "unknown";
  if (row.status === "failed") return "skip";
  if (!isObject(row.content)) return "unknown";
  const { content } = row;
  const payer = demosAccount(content.from_ed25519_address === undefined ? content.from : content.from_ed25519_address);
  if (payer === null) return "unknown";
  if (payer !== wallet) return "skip";
  const nonce = nodeNonce(content.nonce);
  const blockNumber = row.blockNumber;
  if (demosAccount(content.from) !== wallet || typeof blockNumber !== "number" || !Number.isSafeInteger(blockNumber) ||
      blockNumber < 0 || typeof row.hash !== "string" || !TX_HASH_RE.test(row.hash) || nonce === null) {
    return "unknown";
  }
  return { nonce, hash: row.hash, blockNumber };
}

/** The one own row at `nonce` on a page whose own rows are newest first by nonce, else undefined. */
function ownRowAtNonce(page: readonly unknown[], wallet: string, nonce: number): DemosHistorySlot | undefined {
  let found: DemosHistorySlot | undefined;
  let last = Number.POSITIVE_INFINITY;
  for (const row of page) {
    const slot = slotRow(row, wallet);
    if (slot === "unknown") return undefined;
    if (slot === "skip") continue;
    if (slot.nonce > last || (slot.nonce === nonce && found !== undefined)) return undefined;
    last = slot.nonce;
    if (slot.nonce === nonce) found = { hash: slot.hash, blockNumber: slot.blockNumber };
  }
  return found;
}

/** The live node's two not-found replies to `getTransactionStatus`, with exactly these two members. */
function isNotFoundEnvelope(envelope: Record<string, unknown>): boolean {
  return Object.keys(envelope).length === 2 && Object.hasOwn(envelope, "response") &&
    ((envelope.result === 400 && envelope.response === "error") ||
      (envelope.result === 404 && envelope.response === null));
}

/** OS as a decimal string: the balance as is after the denomination fork, in DEM before it. */
function balanceOs(info: unknown, network: unknown): string {
  const activated = answerObject(answerObject(answerObject(network).forks).osDenomination).activated;
  const balance = answerObject(info).balance;
  const amount = typeof balance === "number" && Number.isSafeInteger(balance) && balance >= 0 ? BigInt(balance)
    : typeof balance === "string" && AMOUNT_RE.test(balance) ? BigInt(balance) : invalid();
  if (typeof activated !== "boolean") invalid();
  return (amount * (activated ? 1n : OS_PER_DEM)).toString();
}

/** The body, decoded as UTF-8, refused once its declared or actual size passes `maximumBytes`. */
async function boundedText(response: Response, maximumBytes: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (response.body === null || (declared !== null && Number(declared) > maximumBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error(response.body === null ? RESPONSE_INVALID : RESPONSE_TOO_LARGE);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    length += chunk.value.byteLength;
    if (length > maximumBytes) {
      void reader.cancel().catch(() => undefined);
      throw new Error(RESPONSE_TOO_LARGE);
    }
    chunks.push(chunk.value);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return invalid();
  }
}

/**
 * Bounded reads of one Demos node for the policy's wallet and its DEM asset. Each `nodeCall` answer
 * has a byte limit, a deadline and shape checks, and no error message carries the node address.
 * @returns A reader whose methods reject with a named `Error`, such as `wallet-spend-demos-rpc-response-too-large`.
 * @throws Error `wallet-spend-demos-rpc-request-invalid` when the timeout is out of range.
 */
export function createDacsWalletSpendDemosReaderV1(input: Readonly<{
  rpcUrl: string;
  policy: Readonly<WalletSpendPolicyV1>;
  timeoutMs?: number;
  fetch?: typeof fetch;
}>): Readonly<DacsWalletSpendDemosReaderV1> {
  const { policy, rpcUrl } = input;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestFetch = input.fetch ?? globalThis.fetch;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("wallet-spend-demos-rpc-request-invalid");
  }

  /** One `nodeCall`, bounded in size and time. Only `{result: 200, response}` is an answer, except the
   * two not-found replies to `getTransactionStatus`, which become `{state: "not-found"}`. */
  async function nodeCall(message: string, data: Readonly<Record<string, unknown>>, maximumBytes: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await requestFetch(rpcUrl, {
        method: "POST",
        // A redirect comes back as its own 3xx answer, which the status check refuses.
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "nodeCall", params: [{ message, data }] }),
        signal: controller.signal,
      }).catch((cause: unknown) => {
        throw new Error("wallet-spend-demos-rpc-unavailable", { cause });
      });
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
      if (message === "getTransactionStatus" && isNotFoundEnvelope(envelope)) return { state: "not-found" };
      if (envelope.result !== 200 || !Object.hasOwn(envelope, "response")) invalid();
      return envelope.response;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("wallet-spend-demos-rpc-deadline-exceeded", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function assertNetwork(): Promise<void> {
    try {
      const { DemosAdapter } = await import("@kynesyslabs/dacs/substrate");
      const node = new DemosAdapter({ rpc: rpcUrl });
      const url = new URL(rpcUrl);
      const connectionId = randomUUID();
      await bindTp1Profile({
        record: TP1_APPROVED_IDENTITY_RECORD,
        local: { endpoint: url.href, transportAuthority: url.host, connectionId },
        readAuthority: async (scope) => ({
          local: scope.local, chainIdentity: await node.getChainIdentity(),
          provenance: `demos-node:${connectionId}`, sessionId: scope.sessionId, participants: [],
        }),
      });
    } catch (cause) {
      const mismatch = (cause instanceof DemosChainIdentityError && cause.code === "chain_identity_mismatch") ||
        (cause instanceof WireError && cause.code === "tp1_connection_unverified");
      const reasonCode = `wallet-spend-testnet-authority-demos-${mismatch ? "network-mismatch" : "node-unavailable"}`;
      throw new DacsWalletSpendTestnetAuthorityError(reasonCode, undefined, { cause });
    }
  }

  async function readBalance(scope: Readonly<{ wallet: string; chainId: string; asset: string }>): Promise<string> {
    if (canonicalWalletSpendWalletV1(scope.wallet) !== policy.wallet || scope.chainId !== "demos" ||
        scope.asset !== "DEM") {
      throw new Error("wallet-spend-demos-rpc-scope-refused");
    }
    const network = await nodeCall("getNetworkInfo", {}, RECORD_ANSWER_BYTES);
    return balanceOs(await nodeCall("getAddressInfo", { address: policy.wallet }, RECORD_ANSWER_BYTES), network);
  }

  async function observeTransfer(txHash: string) {
    let record: { value: unknown } | undefined;
    const observation = await observePayDemTransferCore(txHash, {
      getTransactionStatus: (hash) => nodeCall("getTransactionStatus", { hash }, RECORD_ANSWER_BYTES),
      getTxByHash: async (hash) => {
        record = { value: await nodeCall("getTxByHash", { hash }, RECORD_ANSWER_BYTES) };
        return record.value;
      },
      getBlockByNumber: (blockNumber) => nodeCall("getBlockByNumber", { blockNumber }, LIST_ANSWER_BYTES),
    });
    return Object.freeze(record === undefined ? { observation } : { observation, record: record.value });
  }

  async function readAccountNonce(): Promise<number> {
    const answer = await nodeCall("getAddressNonce", { address: policy.wallet }, RECORD_ANSWER_BYTES);
    // A node answers with the nonce itself or with `{ nonce }`; a missing member is never read as 0.
    return nodeNonce(isObject(answer) ? answer.nonce : answer) ?? invalid();
  }

  async function findTransactionAtNonce(nonce: number): Promise<DemosHistorySlot | undefined> {
    const page = await nodeCall("getTransactionHistory", {
      address: policy.wallet, type: "all", start: 0, limit: DEMOS_HISTORY_MAX_PAGE_SIZE,
    }, LIST_ANSWER_BYTES);
    if (!Array.isArray(page) || page.length > DEMOS_HISTORY_MAX_PAGE_SIZE) return invalid();
    return ownRowAtNonce(page, policy.wallet, nonce);
  }

  return Object.freeze({
    assertNetwork,
    readBalance,
    observeTransfer,
    readAccountNonce,
    plannedTransferNonce: async () => (await readAccountNonce()) + 1,
    readRecord: (txHash: string) => nodeCall("getTxByHash", { hash: txHash }, RECORD_ANSWER_BYTES),
    findTransactionAtNonce,
  });
}
