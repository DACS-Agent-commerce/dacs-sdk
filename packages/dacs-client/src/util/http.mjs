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

/** Cancel a response body that will not be read. Never throws; returns nothing. */
export function cancelResponseBody(response) {
  response?.body?.cancel().catch(() => {});
}

/** Wait for `pending`, but stop waiting when `signal` aborts, even if the
 * operation behind `pending` ignores the signal. Returns the settled value, or
 * rejects with the signal's reason. A value that arrives after the abort is
 * passed to `discardLate` (to release it); a late failure is dropped.
 */
export function settleOnAbort(pending, signal, discardLate = () => {}) {
  return new Promise((resolve, reject) => {
    let abandoned = false;
    const abandon = () => { abandoned = true; reject(signal.reason); };
    Promise.resolve(pending).then(
      (value) => { signal.removeEventListener('abort', abandon); if (abandoned) discardLate(value); else resolve(value); },
      (error) => { signal.removeEventListener('abort', abandon); if (!abandoned) reject(error); },
    );
    // A result that is already available when an aborted signal is seen still
    // wins, so the caller can report its own abort reason on it.
    if (signal.aborted) queueMicrotask(abandon); else signal.addEventListener('abort', abandon, { once: true });
  });
}

async function readCapped(response, maxBytes, signal) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    cancelResponseBody(response);
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
      const { done, value } = await settleOnAbort(reader.read(), signal);
      signal.throwIfAborted();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
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
    response = await settleOnAbort(fetchImpl(target, {
      method,
      headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store',
      signal: cancellation,
    }), cancellation, cancelResponseBody);
  } catch (error) {
    throw new OutboundError('unavailable', error?.name === 'TimeoutError' ? 'request timed out' : 'request failed');
  }
  if (cancellation.aborted) {
    cancelResponseBody(response);
    cancellation.throwIfAborted();
  }
  if (response.status >= 300 && response.status < 400) {
    cancelResponseBody(response);
    throw new OutboundError('invalid', 'unexpected redirect', { status: response.status });
  }
  if (response.status === 404) {
    cancelResponseBody(response);
    throw new OutboundError('not-found', 'not found', { status: 404 });
  }
  if (!response.ok) {
    cancelResponseBody(response);
    throw new OutboundError('unavailable', `upstream returned HTTP ${response.status}`, { status: response.status });
  }
  const type = response.headers.get('content-type') ?? '';
  if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(type)) {
    cancelResponseBody(response);
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
