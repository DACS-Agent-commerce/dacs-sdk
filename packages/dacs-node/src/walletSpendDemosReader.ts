import { randomUUID } from "node:crypto";

import {
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
  /**
   * The start check: the node's chain identity must be the SDK's approved
   * testnet identity record, checked by `bindTp1Profile`.
   * Rejects `DacsWalletSpendTestnetAuthorityError`
   * `wallet-spend-testnet-authority-demos-network-mismatch` or `-demos-node-unavailable`.
   */
  assertNetwork(): Promise<void>;
  /** The policy wallet's DEM balance in OS, as a decimal string. */
  readBalance: WalletSpendAuthorityDependenciesV1["readBalance"];
  /** The SDK observation of a transfer, with the `getTxByHash` record it used, if it read one. */
  observeTransfer(txHash: string): Promise<Readonly<{
    observation: Readonly<DemosTransferObservation>;
    record?: unknown;
  }>>;
}

const DEMOS_CHAIN_ID = "demos";
const DEM_ASSET = "DEM";
const RECORD_ANSWER_BYTES = 64 * 1024;
/** A block lists its transaction hashes, so it gets a larger limit than a record. */
const BLOCK_ANSWER_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const OS_PER_DEM = 1_000_000_000n;
const WALLET_RE = /^0x[0-9a-f]{64}$/;
const AMOUNT_RE = /^(?:0|[1-9][0-9]*)$/;

const RESPONSE_INVALID = "wallet-spend-demos-rpc-response-invalid";
const RESPONSE_TOO_LARGE = "wallet-spend-demos-rpc-response-too-large";
const NETWORK_MISMATCH = "wallet-spend-testnet-authority-demos-network-mismatch";
const NODE_UNAVAILABLE = "wallet-spend-testnet-authority-demos-node-unavailable";

const invalid = (): never => {
  throw new Error(RESPONSE_INVALID);
};

function answerObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : invalid();
}

/** The live node's two not-found replies to `getTransactionStatus`, compared member by member. */
function isNotFoundEnvelope(envelope: Record<string, unknown>): boolean {
  const keys = Object.keys(envelope);
  return keys.length === 2 && keys.includes("result") && keys.includes("response") &&
    ((envelope.result === 400 && envelope.response === "error") ||
      (envelope.result === 404 && envelope.response === null));
}

function balanceOs(info: unknown, network: unknown): string {
  const forks = answerObject(answerObject(network).forks);
  const activated = answerObject(forks.osDenomination).activated;
  const balance = answerObject(info).balance;
  const amount = typeof balance === "number" && Number.isSafeInteger(balance) && balance >= 0
    ? BigInt(balance)
    : typeof balance === "string" && AMOUNT_RE.test(balance) ? BigInt(balance) : invalid();
  if (typeof activated !== "boolean") invalid();
  return (activated ? amount : amount * OS_PER_DEM).toString();
}

/**
 * Bounded reads of one Demos node for the policy's wallet and its DEM asset.
 * Each `nodeCall` answer has a byte limit, a deadline and shape checks, and no
 * error message carries the node address.
 *
 * @returns A reader whose methods reject with a named `Error`, for example
 *   `wallet-spend-demos-rpc-response-too-large`.
 * @throws Error `wallet-spend-demos-rpc-request-invalid` when the policy is not
 *   one canonical 32-byte wallet on `demos` with the one asset `DEM`, or the
 *   timeout is out of range.
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
  const [assetPolicy, ...otherAssets] = policy.assets;
  if (assetPolicy?.asset !== DEM_ASSET || otherAssets.length > 0 || policy.chainId !== DEMOS_CHAIN_ID ||
      !WALLET_RE.test(policy.wallet) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error("wallet-spend-demos-rpc-request-invalid");
  }

  async function boundedText(response: Response, maximumBytes: number): Promise<string> {
    const declared = response.headers.get("content-length");
    if (response.body === null || (declared !== null && Number(declared) > maximumBytes)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(response.body === null ? RESPONSE_INVALID : RESPONSE_TOO_LARGE);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
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

  async function exchange(
    message: string,
    data: Readonly<Record<string, unknown>>,
    maximumBytes: number,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await requestFetch(rpcUrl, {
        method: "POST",
        // A redirect comes back as its own 3xx answer, which the status check refuses.
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method: "nodeCall", params: [{ message, data }] }),
        signal,
      });
    } catch (error) {
      throw new Error("wallet-spend-demos-rpc-unavailable", { cause: error });
    }
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => undefined);
      invalid();
    }
    const text = await boundedText(response, maximumBytes);
    try {
      return answerObject(JSON.parse(text));
    } catch {
      return invalid();
    }
  }

  /**
   * One `nodeCall` with a byte limit and a deadline that covers the whole
   * answer. Only `{result: 200, response}` is an answer, except the two
   * not-found replies to `getTransactionStatus`, which become `{state: "not-found"}`.
   */
  async function nodeCall(message: string, data: Readonly<Record<string, unknown>>, maximumBytes: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const envelope = await exchange(message, data, maximumBytes, controller.signal);
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
          local: scope.local,
          chainIdentity: await node.getChainIdentity(),
          provenance: `demos-node:${connectionId}`,
          sessionId: scope.sessionId,
          participants: [],
        }),
      });
    } catch (error) {
      const mismatch = (error instanceof DemosChainIdentityError && error.code === "chain_identity_mismatch") ||
        (error instanceof WireError && error.code === "tp1_connection_unverified");
      throw new DacsWalletSpendTestnetAuthorityError(mismatch ? NETWORK_MISMATCH : NODE_UNAVAILABLE, undefined, {
        cause: error,
      });
    }
  }

  async function readBalance(
    scope: Readonly<{ wallet: string; chainId: string; asset: string }>,
  ): Promise<string> {
    if (canonicalWalletSpendWalletV1(scope.wallet) !== policy.wallet || scope.chainId !== DEMOS_CHAIN_ID ||
        scope.asset !== DEM_ASSET) {
      throw new Error("wallet-spend-demos-rpc-scope-refused");
    }
    const network = await nodeCall("getNetworkInfo", {}, RECORD_ANSWER_BYTES);
    const info = await nodeCall("getAddressInfo", { address: policy.wallet }, RECORD_ANSWER_BYTES);
    return balanceOs(info, network);
  }

  async function observeTransfer(txHash: string) {
    let record: { value: unknown } | undefined;
    const observation = await observePayDemTransferCore(txHash, {
      getTransactionStatus: (hash) => nodeCall("getTransactionStatus", { hash }, RECORD_ANSWER_BYTES),
      getTxByHash: async (hash) => {
        const value = await nodeCall("getTxByHash", { hash }, RECORD_ANSWER_BYTES);
        record = { value };
        return value;
      },
      getBlockByNumber: (blockNumber) => nodeCall("getBlockByNumber", { blockNumber }, BLOCK_ANSWER_BYTES),
    });
    return Object.freeze(record === undefined ? { observation } : { observation, record: record.value });
  }

  return Object.freeze({ assertNetwork, readBalance, observeTransfer });
}
