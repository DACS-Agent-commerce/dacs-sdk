import { Buffer } from "node:buffer";
import { DacsError } from "../errors.js";

// Recovery reads only individual records and inclusion blocks. Bound the
// decompressed bytes before JSON decoding, including replies with no length.
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Read-only Demos RPC transport: no wallet, SDK connect, retries or effects. */
export function payDemRecoveryRpc(rpc: string, timeoutMs: number) {
  const fetchRpc = fetch;
  return async (message: string, data: Record<string, unknown>): Promise<unknown> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new DacsError(`pay-dem recovery ${message} read timed out`);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    const read = async () => {
      // demosdk's Axios transport accepts URL userinfo; Fetch rejects it.
      // Keep primary and archive recovery compatible without passing credentials
      // to Fetch's URL parser (or its URL-bearing diagnostics).
      const url = new URL(rpc);
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let endpoint = rpc;
      if (url.username !== "" || url.password !== "") {
        headers.Authorization = `Basic ${Buffer.from(
          `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`, "utf8",
        ).toString("base64")}`;
        url.username = "";
        url.password = "";
        endpoint = url.href;
      }
      const response = await fetchRpc(endpoint, {
        method: "POST", redirect: "error",
        headers,
        body: JSON.stringify({ method: "nodeCall", params: [{ message, data }] }),
        signal: controller.signal,
      });
      // A non-cooperative transport can deliver a response after the deadline.
      if (controller.signal.aborted || !response.ok || response.body === null) {
        void response.body?.cancel().catch(() => undefined);
        controller.signal.throwIfAborted();
        throw new DacsError(`pay-dem recovery ${message} read returned HTTP ${response.status} or an empty body`);
      }
      const length = response.headers.get("content-length");
      if (length !== null && (!/^[0-9]+$/.test(length) || BigInt(length) > BigInt(MAX_RESPONSE_BYTES))) {
        void response.body.cancel().catch(() => undefined);
        throw new DacsError("pay-dem recovery RPC response exceeds the byte limit");
      }
      const reader = response.body.getReader();
      const cancel = () => { void reader.cancel(controller.signal.reason).catch(() => undefined); };
      controller.signal.addEventListener("abort", cancel, { once: true });
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let bytes = 0;
      let json = "";
      try {
        while (true) {
          controller.signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) throw new DacsError("pay-dem recovery RPC response exceeds the byte limit");
          json += decoder.decode(chunk.value, { stream: true });
        }
        controller.signal.throwIfAborted();
        json += decoder.decode();
        const payload: unknown = JSON.parse(json);
        if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
            !("result" in payload) || typeof payload.result !== "number" || !("response" in payload)) {
          throw new DacsError(`pay-dem recovery ${message} read returned an invalid RPC envelope`);
        }
        if (payload.result !== 200) {
          throw new DacsError(`pay-dem recovery ${message} RPC refused with result ${payload.result}`, {
            cause: payload.response,
          });
        }
        return payload.response;
      } catch (cause) {
        void reader.cancel(cause).catch(() => undefined);
        throw cause;
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        reader.releaseLock();
      }
    };
    try {
      return await Promise.race([read(), timeout]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
