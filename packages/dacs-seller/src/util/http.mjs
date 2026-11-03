// Run-time port of http-mcp/src/util/http.mjs at DACS-Agent-commerce/frontend 15fdf23: the whole
// file.
import { admitRawJson } from '@kynesyslabs/dacs';
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
  const chunks = [];
  let total = 0;

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
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    if (error instanceof OutboundError) throw error;
    throw new OutboundError('invalid', 'response body is not valid UTF-8');
  }
}

export async function fetchBoundedJson(url, { fetchImpl = globalThis.fetch, method = 'GET', body, timeoutMs, maxBytes, expectedOrigin, headers = {} }) {
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
  const text = await readCapped(response, maxBytes);
  try {
    return admitRawJson(text, { maxBytes });
  } catch {
    throw new OutboundError('invalid', 'upstream returned malformed JSON');
  }
}
