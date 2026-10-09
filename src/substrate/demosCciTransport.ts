import { DacsError, SubstrateError } from "../errors.js";
import { DEMOS_CCI_RESPONSE_LIMITS } from "../identity/cci.js";

/** Default and hard maximum for one raw GCR identity response (2 MiB). */
export const DEMOS_CCI_MAX_RESPONSE_BYTES = DEMOS_CCI_RESPONSE_LIMITS.maxEncodedBytes;
// Match x402Outbound's default whole-request deadline.
const DEFAULT_TIMEOUT_MS = 5_000;

function responseTooLarge(): DacsError {
  return new DacsError("Demos GCR identity response exceeds maxResponseBytes");
}

// Follow x402Outbound's bounded-read pattern: check declared length, then
// count and own each streamed chunk before retaining it. Never call json().
async function consumeBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^[0-9]+$/.test(contentLength) &&
      BigInt(contentLength) > BigInt(maxBytes)) {
    void response.body?.cancel().catch(() => undefined);
    throw responseTooLarge();
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      const prospectiveTotal = total + next.value.byteLength;
      if (prospectiveTotal > maxBytes) throw responseTooLarge();
      chunks.push(Uint8Array.from(next.value));
      total = prospectiveTotal;
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    chunks.length = 0;
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** Equivalent to demosdk's Identities.getIdentities request, with raw admission. */
export async function readDemosCciResponse(
  rpc: string,
  address: string,
  headers: Record<string, string>,
  transport: typeof fetch,
  maxBytes: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutError = new DacsError("Demos GCR identity read timed out");
  let rejectDeadline: ((reason: DacsError) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
    rejectDeadline?.(timeoutError);
  }, DEFAULT_TIMEOUT_MS);
  try {
    const operation = async (): Promise<unknown> => {
      const response = await transport(rpc, {
        method: "POST",
        headers,
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({
          method: "gcr_routine",
          params: [{ method: "getIdentities", params: [address] }],
        }),
      });
      if (controller.signal.aborted) {
        // An injected transport may resolve after ignoring abort. Dispose of
        // that late body without reading or decoding it.
        void response.body?.cancel(timeoutError).catch(() => undefined);
        throw timeoutError;
      }
      if (response.redirected || response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => undefined);
        throw new DacsError("Demos GCR identity response redirect refused");
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new SubstrateError(`Demos GCR identity read failed with HTTP ${response.status}`);
      }
      const bytes = await consumeBoundedBody(response, maxBytes, controller.signal);
      controller.signal.throwIfAborted();
      try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
      } catch {
        // Do not attach a decoder error that may include response text.
        throw new DacsError("Demos GCR identity response is not valid UTF-8 JSON");
      }
    };
    return await Promise.race([operation(), deadline]);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    rejectDeadline = undefined;
  }
}
