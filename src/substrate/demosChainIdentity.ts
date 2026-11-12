import { DacsError } from "../errors.js";
import { readBoundedDemosJson } from "../rails/demosRpc.js";

/** Resolved network identity; genesis reads cannot report genesis data or id. */
export interface DemosChainIdentity {
  chainId: string | null;
  genesisHash: string;
  genesisDataHash: string | null;
  source: "node-call" | "genesis-read";
}

/** A network identity refusal, with a stable code and retry category. */
export class DemosChainIdentityError extends DacsError {
  constructor(readonly code: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(code + (options?.cause instanceof Error ? `: ${options.cause.message}` : ""), { cause: options?.cause, category: options?.retryable ? "transient" : "permanent" });
    this.name = "DemosChainIdentityError";
  }
}

const MAX_RESPONSE_BYTES = 64 * 1024;
const READ_TIMEOUT_MS = 15_000;

/** @internal Bounded RPC; undefined means an unsupported identity call or unqueryable block zero. */
export async function readDemosChainCall(
  rpc: string, message: string, data: Record<string, unknown> = {},
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(rpc, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "nodeCall", params: [{ message, data }] }),
          signal: controller.signal,
        });
        if (response.status === 404 && message === "getChainIdentity") {
          void response.body?.cancel().catch(() => undefined);
          return undefined;
        }
        const payload = await readBoundedDemosJson(response, MAX_RESPONSE_BYTES, controller.signal);
        if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
          throw new DemosChainIdentityError("chain_identity_invalid");
        }
        const reply = payload as Record<string, unknown>;
        if (response.ok && (!Number.isInteger(reply.result) ||
            (reply.result === 200 && !Object.hasOwn(reply, "response")))) throw new DemosChainIdentityError("chain_identity_invalid");
        const status = response.ok ? reply.result : response.status;
        if (status === 503 || status === 500) {
          throw new DemosChainIdentityError(status === 503 ? "state_not_ready" : "lookup_failed", { cause: payload, retryable: true });
        }
        if (message === "getChainIdentity" && (status === 404 ||
            (status === 400 && typeof reply.response === "string" && /^Unknown message\b/i.test(reply.response)))) return undefined;
        if (message === "getBlockByNumber" && data.blockNumber === 0 && status === 400) return undefined;
        if (status !== 200) throw new DemosChainIdentityError("chain_identity_unavailable", { cause: payload, retryable: true });
        return reply.response;
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DemosChainIdentityError("chain_identity_unavailable", { retryable: true }));
        }, READ_TIMEOUT_MS);
      }),
    ]);
  } catch (cause) {
    if (cause instanceof DemosChainIdentityError) throw cause;
    throw new DemosChainIdentityError("chain_identity_unavailable", { cause, retryable: true });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
