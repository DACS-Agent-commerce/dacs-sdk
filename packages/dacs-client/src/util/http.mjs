import { admitRawJson, RawJsonAdmissionError } from '@kynesyslabs/dacs';
// Bounded outbound JSON requests: fixed origin, no redirects, hard timeout,
// post-decompression byte cap, no ambient credentials. Failures are typed so
// callers can distinguish "unavailable" from "invalid". A caller's abort
// rejects with the caller's own reason, unchanged.
export class OutboundError extends Error {
  constructor(kind, message, { status } = {}) {
    super(message);
    this.kind = kind; // 'unavailable' | 'invalid' | 'not-found' | 'timeout' (observeWithDeadline)
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

const unavailable = (message, cause) => Object.assign(new OutboundError('unavailable', message), { cause });

// Every exit reports one shape: the caller's abort reason first, then this
// request's own timeout, else the failure found at that exit.
function settled({ signal, timeout }, error) {
  if (signal?.aborted) return signal.reason;
  if (timeout.aborted) return new OutboundError('unavailable', 'request timed out');
  return error;
}

// Body cancellation is started, never awaited: a stalled cancel() cannot hold
// the request open.
async function readCapped(response, maxBytes, stop, cancellation) {
  const declared = response.headers.get('content-length');
  if (declared !== null && Number(declared) > maxBytes) {
    cancelResponseBody(response);
    throw new OutboundError('invalid', 'response exceeds byte limit');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel(cancellation.reason).catch(() => {}); };
  cancellation.addEventListener('abort', abort, { once: true });
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await settleOnAbort(reader.read(), cancellation);
      // A cancelled reader ends with done; that is an abort, not a full body.
      if (cancellation.aborted) throw settled(stop);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new OutboundError('invalid', 'response exceeds byte limit');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    throw settled(stop, error instanceof OutboundError ? error : unavailable('response body was interrupted', error));
  } finally { cancellation.removeEventListener('abort', abort); }
}

export async function fetchBoundedJson(url, { fetchImpl = globalThis.fetch, method = 'GET', body, timeoutMs, maxBytes, expectedOrigin, headers = {}, signal }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 10_000_000) {
    throw new OutboundError('invalid', 'request byte limit must be an integer from 1 to 10000000');
  }
  const target = new URL(url);
  if (expectedOrigin && target.origin !== expectedOrigin) throw new OutboundError('invalid', 'request left the configured origin');
  signal?.throwIfAborted();
  const stop = { signal, timeout: AbortSignal.timeout(timeoutMs) };
  const cancellation = signal ? AbortSignal.any([stop.timeout, signal]) : stop.timeout;
  let response;
  try {
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
    throw settled(stop, unavailable(error?.name === 'TimeoutError' ? 'request timed out' : 'request failed', error));
  }
  if (cancellation.aborted) {
    cancelResponseBody(response);
    throw settled(stop);
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
  const bytes = await readCapped(response, maxBytes, stop, cancellation);
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

/** Run read({ signal }) under one deadline and an optional caller signal.
 * The signal aborts on the caller's abort, on the deadline (reason
 * OutboundError 'timeout') and when the call settles. Resolves the read's
 * result; once aborted rejects with the abort reason, else with the read's own
 * error. Nothing is raced: the read must honour its signal and settle, so the
 * deadline aborts requests and stops new steps but abandons no running work.
 */
export async function observeWithDeadline(read, { timeoutMs, signal } = {}) {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new OutboundError('timeout', 'host chain read timed out')), timeoutMs);
  const cancellation = signal ? AbortSignal.any([deadline.signal, signal]) : deadline.signal;
  try {
    cancellation.throwIfAborted();
    const result = await read({ signal: cancellation });
    cancellation.throwIfAborted();
    return result;
  } catch (error) {
    throw cancellation.aborted ? cancellation.reason : error;
  } finally {
    clearTimeout(timer);
    deadline.abort();
  }
}
