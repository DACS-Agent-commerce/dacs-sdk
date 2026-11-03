import { registerSourceFinalityVerifier } from "./liquidityTankCapabilities.js";
import type { LiquidityTankVerifier } from "./liquidityTank.js";

/**
 * Ethereum Execution APIs v1.0.0-beta.7 at
 * 5aebdfdd45cadeb723be4bd45b4611b71c8b1c85, JSON-RPC 2.0, finalized tag.
 */
export const LIQUIDITY_TANK_EVM_FINALITY_VERSION = "ethereum-finalized-receipt-v1" as const;

export interface LiquidityTankEvmFinalityOptions {
  /**
   * Trusted bridge authentication and signed-submission decoding. Authentication
   * must bind the lock transaction to the exact operation, amount and tank pair.
   * This wrapper adds source-chain finality; it cannot authenticate bridge state.
   */
  verifier: LiquidityTankVerifier;
  /** Host-pinned, trusted Sepolia execution RPC over authenticated HTTPS. */
  sourceRpcUrl: string;
  /** Total deadline for the four read-only RPC requests. Default 10 seconds. */
  timeoutMs?: number;
  /** Trusted transport; defaults to the native fetch, including TLS validation. */
  fetch?: typeof globalThis.fetch;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const SEPOLIA = 11_155_111;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !QUANTITY.test(value) || value.trim() !== value || value.length > 66) {
    throw new TypeError("Invalid Ethereum quantity");
  }
  return BigInt(value);
}

function hash(value: unknown): string {
  if (typeof value !== "string" || value.length !== 66 || !HASH.test(value)) throw new TypeError("Invalid Ethereum hash");
  return value.toLowerCase();
}

/**
 * Adds an executable ST-8 source-finality gate to a bridge verifier. Every
 * lock-bearing observation, including a retained checkpoint or completion, is
 * checked against the configured trusted execution node. A successful receipt
 * must belong to the canonical block at or below that node's finalized head.
 * Inclusion, confirmations, `safe` and `latest` never substitute for finality.
 * No signed bytes, wallet operations or transaction submissions go to this RPC.
 *
 * This is an RPC trust model, not a light client: the host must trust the pinned
 * HTTPS node's chain view and the underlying bridge verifier independently.
 */
export function createLiquidityTankEvmFinalityVerifier(
  options: LiquidityTankEvmFinalityOptions,
): LiquidityTankVerifier {
  const url = new URL(options.sourceRpcUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new TypeError("Liquidity-tank finality RPC must use a pinned HTTPS URL without userinfo or fragment");
  }
  const endpoint = url.href;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("Liquidity-tank finality timeout must be 1-30000 milliseconds");
  }
  const fetchRpc = options.fetch ?? globalThis.fetch;
  if (typeof fetchRpc !== "function") throw new TypeError("Liquidity-tank finality requires fetch");
  const authenticate = options.verifier.authenticateObservation.bind(options.verifier);
  const verifySubmission = options.verifier.verifySignedSubmission.bind(options.verifier);

  return registerSourceFinalityVerifier(Object.freeze({
    verifySignedSubmission: verifySubmission,
    async authenticateObservation(input: Parameters<LiquidityTankVerifier["authenticateObservation"]>[0]) {
      try {
        const answer = await authenticate(input);
        if (answer !== true) return answer;
        if (!("lockTxHash" in input.observation) || input.observation.lockTxHash === undefined) return true;
        if (input.intent.sourceChainId !== SEPOLIA || input.intent.sourceChainType !== "EVM") return false;
        // Bad bridge data is a refusal, not a retryable RPC outage.
        if (typeof input.observation.lockTxHash !== "string" ||
            input.observation.lockTxHash.length !== 66 || !HASH.test(input.observation.lockTxHash)) return false;
        const lockHash = hash(input.observation.lockTxHash);
        const signal = AbortSignal.timeout(timeoutMs);
        let nextId = 0;
        const rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
          const id = ++nextId;
          signal.throwIfAborted();
          const response = await withinDeadline(fetchRpc(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            redirect: "error",
            credentials: "omit",
            signal,
            body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          }), signal);
          if (!response.ok) throw new Error("Ethereum RPC unavailable");
          const body = await readBoundedRpcJson(response, signal);
          if (!record(body) || body.jsonrpc !== "2.0" || body.id !== id ||
              "error" in body || !("result" in body)) {
            throw new Error("Invalid Ethereum RPC response");
          }
          return body.result;
        };
        if (quantity(await rpc("eth_chainId", [])) !== BigInt(SEPOLIA)) return "unavailable";
        const receipt = await rpc("eth_getTransactionReceipt", [lockHash]);
        if (!record(receipt)) return "unavailable";
        if (hash(receipt.transactionHash) !== lockHash || quantity(receipt.status) !== 1n) return false;
        const height = quantity(receipt.blockNumber);
        const blockHash = hash(receipt.blockHash);
        const finalized = await rpc("eth_getBlockByNumber", ["finalized", false]);
        if (!record(finalized)) return "unavailable";
        if (quantity(finalized.number) < height) return "pending-finality";
        const finalizedHash = hash(finalized.hash);
        if (quantity(finalized.number) === height && finalizedHash !== blockHash) return "unavailable";
        const canonical = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
        if (!record(canonical) || quantity(canonical.number) !== height || hash(canonical.hash) !== blockHash ||
            !Array.isArray(canonical.transactions) || canonical.transactions.length > 20_000 || !canonical.transactions.some((tx: unknown) => hash(tx) === lockHash)) {
          return "unavailable";
        }
        return true;
      } catch {
        // Missing/unsupported finalized data, pre-final inclusion, reorgs and
        // outages cannot authorize ST-8 entry, expiry or a settlement write.
        return "unavailable";
      }
    },
  }));
}

/** Hard byte and time bounds before JSON decoding, including injected streams. */
async function readBoundedRpcJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 2 * 1024 * 1024;
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || length.length > 10 || Number(length) > limit)) {
    void response.body?.cancel().catch(() => {});
    throw new Error("Ethereum RPC response exceeds byte limit");
  }
  if (!response.body) throw new Error("Ethereum RPC empty response");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    signal.throwIfAborted();
    while (true) {
      const item = await withinDeadline(reader.read(), signal);
      signal.throwIfAborted();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) throw new Error("Ethereum RPC response exceeds byte limit");
      body += decoder.decode(item.value, { stream: true });
    }
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch (cause) {
    void reader.cancel(cause).catch(() => {});
    throw cause;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) { void operation.catch(() => {}); reject(signal.reason); return; }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
