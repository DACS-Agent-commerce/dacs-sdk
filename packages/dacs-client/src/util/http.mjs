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

async function readCapped(response, maxBytes, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new OutboundError('invalid', 'response exceeds byte limit');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
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
  } finally { signal.removeEventListener('abort', abort); }
}

export async function fetchBoundedJson(url, { fetchImpl = globalThis.fetch, method = 'GET', body, timeoutMs, maxBytes, expectedOrigin, headers = {}, signal }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 10_000_000) {
    throw new OutboundError('invalid', 'request byte limit must be an integer from 1 to 10000000');
  }
  const target = new URL(url);
  if (expectedOrigin && target.origin !== expectedOrigin) throw new OutboundError('invalid', 'request left the configured origin');
  const cancellation = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  let response;
  try {
    cancellation.throwIfAborted();
    response = await fetchImpl(target, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: cancellation,
    });
  } catch (error) {
    throw new OutboundError('unavailable', error?.name === 'TimeoutError' ? 'request timed out' : 'request failed');
  }
  if (cancellation.aborted) {
    response.body?.cancel().catch(() => {});
    cancellation.throwIfAborted();
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
  const bytes = await readCapped(response, maxBytes, cancellation);
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

/** Run a passive observation with one deadline and an optional caller signal.
 * Returns the reader result; preserves reader errors and throws OutboundError
 * on deadline. The supplied reader signal is aborted when the call finishes.
 */
export async function observeWithDeadline(read, { timeoutMs, signal } = {}) {
  const controller = new AbortController();
  const cancellation = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  let timer, abort;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        abort = () => reject(cancellation.reason);
        cancellation.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => controller.abort(new OutboundError('timeout', 'host chain read timed out')), timeoutMs);
        if (cancellation.aborted) abort();
      }),
      Promise.resolve().then(() => { cancellation.throwIfAborted(); return read({ signal: cancellation }); }),
    ]);
  } finally {
    clearTimeout(timer);
    cancellation.removeEventListener('abort', abort);
    controller.abort();
  }
}
