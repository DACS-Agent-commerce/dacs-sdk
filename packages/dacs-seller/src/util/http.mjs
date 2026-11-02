// Run-time port of http-mcp/src/util/http.mjs at DACS-Agent-commerce/frontend 15fdf23: the whole
// file.
import { admitRawJson, RawJsonAdmissionError } from '@kynesyslabs/dacs';
// Bounded outbound JSON requests: fixed origin, no redirects, hard timeout,
// post-decompression byte cap, no ambient credentials. Failures are typed so
// callers can distinguish "unavailable" from "invalid".
const MAX_OUTBOUND_BYTES = 10_000_000;
const MAX_OUTBOUND_TIMEOUT_MS = 120_000;
export class OutboundError extends Error {
  constructor(kind, message, { status, cause } = {}) {
    super(message, { cause });
    this.kind = kind; // 'unavailable' | 'invalid' | 'not-found'
    this.status = status;
  }
}

async function readCapped(response, maxBytes, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new OutboundError('invalid', 'response exceeds byte limit');
  }
  if (!response.body) return new Uint8Array();
  let reader;
  const chunks = [];
  let total = 0;

  try {
    reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new OutboundError('invalid', 'response exceeds byte limit');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    if (error instanceof OutboundError) throw error;
    throw new OutboundError('unavailable', error?.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError' ? 'response body timed out' : 'response body was interrupted', { status: response.status, cause: error });
  } finally { reader?.releaseLock(); }
}

export async function fetchBoundedJson(url, { fetchImpl = globalThis.fetch, method = 'GET', body, timeoutMs, maxBytes, expectedOrigin, headers = {} }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_OUTBOUND_BYTES) throw new OutboundError('invalid', 'request byte limit must be an integer from 1 to 10000000');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_OUTBOUND_TIMEOUT_MS) throw new OutboundError('invalid', 'request timeout must be a positive bounded integer');
  const signal = AbortSignal.timeout(timeoutMs);
  const target = new URL(url);
  if (expectedOrigin && target.origin !== expectedOrigin) throw new OutboundError('invalid', 'request left the configured origin');
  let response;
  try {
    response = await fetchImpl(target, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    throw new OutboundError('unavailable', error?.name === 'TimeoutError' || signal.reason?.name === 'TimeoutError' ? 'request timed out' : 'request failed', { cause: error });
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new OutboundError('invalid', 'unexpected redirect', { status: response.status });
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    throw new OutboundError('not-found', 'not found', { status: 404 });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new OutboundError('unavailable', `upstream returned HTTP ${response.status}`, { status: response.status });
  }
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) {
    await response.body?.cancel().catch(() => {});
    throw new OutboundError('invalid', 'upstream did not return JSON');
  }
  const text = await readCapped(response, maxBytes, signal);
  try {
    return admitRawJson(text, { maxBytes });
  } catch (cause) {
    if (!(cause instanceof RawJsonAdmissionError)) throw cause;
    const error = new OutboundError('invalid', cause.message, { cause });
    error.code = cause.code; error.stage = cause.stage;
    throw error;
  }
}
