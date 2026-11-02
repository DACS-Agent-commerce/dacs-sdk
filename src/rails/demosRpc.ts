const INTEGER_RE = /^(0|[1-9][0-9]*)$/;

/** @internal Maximum wire bytes for one native transfer record, including its RPC envelope. */
export const DEMOS_TRANSACTION_RECORD_MAX_BYTES = 64 * 1024;

/** @internal Decode bounded Demos JSON; reject and cancel oversized, invalid or aborted bodies. */
export async function readBoundedDemosJson(
  response: Response,
  maxResponseBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  if (signal.aborted) {
    void response.body?.cancel(signal.reason).catch(() => undefined);
    signal.throwIfAborted();
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!INTEGER_RE.test(contentLength) ||
        BigInt(contentLength) > BigInt(maxResponseBytes)) {
      const error = new Error("Demos RPC response exceeds maxResponseBytes");
      // A response can already be available even when an injected fetch does
      // not associate its body with the request AbortSignal. Cancel it here,
      // before a reader is acquired, so a rejected declaration cannot leave
      // an unbounded producer running in the background.
      if (response.body !== null) {
        void response.body.cancel(error).catch(() => undefined);
      }
      throw error;
    }
  }
  if (response.body === null) {
    throw new Error("Demos RPC returned an empty response body");
  }

  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let decoded = "";
  let bytesRead = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      bytesRead += item.value.byteLength;
      if (bytesRead > maxResponseBytes) {
        throw new Error("Demos RPC response exceeds maxResponseBytes");
      }
      decoded += decoder.decode(item.value, { stream: true });
    }
    decoded += decoder.decode();
    return JSON.parse(decoded) as unknown;
  } catch (cause) {
    // Do not rely on nodeCall's later controller.abort(): this reader removes
    // its abort listener and releases its lock in finally. Cancel while the
    // reader still owns the stream so size, UTF-8, and JSON failures cannot
    // leak a late body producer.
    void reader.cancel(cause).catch(() => undefined);
    throw cause;
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

/** @internal Read one record without SDK retries; reject on HTTP/RPC failure, byte excess or deadline. */
export async function readDemosTransactionRecord(
  rpc: string,
  hash: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const cause = new Error("Demos transaction record read timed out");
      controller.abort(cause);
      reject(cause);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(rpc, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ method: "nodeCall", params: [{ message: "getTxByHash", data: { hash } }] }),
          signal: controller.signal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new Error(`Demos transaction record returned HTTP ${response.status}`);
        }
        const payload = await readBoundedDemosJson(response, DEMOS_TRANSACTION_RECORD_MAX_BYTES, controller.signal);
        if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
            !("result" in payload) || typeof payload.result !== "number" ||
            !Number.isInteger(payload.result) || !("response" in payload)) {
          throw new Error("Demos transaction record RPC envelope is malformed", { cause: payload });
        }
        if (payload.result !== 200) {
          throw new Error(`Demos transaction record RPC returned ${payload.result}`, {
            cause: { result: payload.result, response: payload.response },
          });
        }
        return payload.response;
      })(),
      timedOut,
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
