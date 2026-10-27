import { admitRawJson, RawJsonAdmissionError } from '@kynesyslabs/dacs';
// Bounded outbound JSON requests: fixed origin, no redirects, hard timeout,
// post-decompression byte cap, no ambient credentials. Failures are typed so
// callers can distinguish "unavailable" from "invalid".
export class OutboundError extends Error {
  constructor(kind, message, { status } = {}) {
    super(message);
    this.kind = kind; // 'unavailable' | 'invalid' | 'not-found'
    this.status = status;
  }
}

async function readCapped(response, maxBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new OutboundError('invalid', 'response exceeds byte limit');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
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
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof OutboundError) throw error;
    throw new OutboundError('unavailable', 'response body was interrupted');
  }
}

export async function fetchBoundedJson(url, { fetchImpl = globalThis.fetch, method = 'GET', body, timeoutMs, maxBytes, expectedOrigin, headers = {} }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 10_000_000) {
    throw new OutboundError('invalid', 'request byte limit must be an integer from 1 to 10000000');
  }
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
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new OutboundError('unavailable', error?.name === 'TimeoutError' ? 'request timed out' : 'request failed');
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
  const bytes = await readCapped(response, maxBytes);
  try {
    // Use the same budget for the stream and exact-byte CF-5 admission:
    // Directory permits 10,000,000 bytes; RPC and other reads use less.
    return admitRawJson(bytes, { maxBytes });
  } catch (cause) {
    if (cause instanceof RawJsonAdmissionError) {
      const error = new OutboundError('invalid', cause.message);
      error.code = cause.code; error.stage = cause.stage; error.cause = cause;
      throw error;
    }
    throw cause;
  }
}
