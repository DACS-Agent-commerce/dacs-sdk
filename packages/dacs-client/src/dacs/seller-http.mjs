// Buyer-side HTTP transport the plugin uses to reach the seller agent.
//
// Requests stay loopback-only. Existing unauthenticated fixture callers
// remain supported. Supplying an authentication adapter enables signed peer
// requests, independently signed seller responses and a durable intent journal.
// In that mode every answer is verified on its exact received bytes and then
// classified (seller-response-class.mjs). Only an authenticated definite
// refusal or failed bootstrap becomes SellerRefusedError; unsigned, malformed,
// interrupted, ambiguous, held, suspended or readback-only answers are
// unavailable, with their class and cause kept.
import { DACS_SELLER_HTTP_HEADER, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { cancelResponseBody, settleOnAbort } from '../util/http.mjs';
import { admitRawJson, RawJsonAdmissionError } from '@kynesyslabs/dacs';
import { classifySellerAnswer, SELLER_ANSWER_CLASS, SELLER_EFFECT_UNRESOLVED } from './seller-response-class.mjs';

const MAX_BODY = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// The third argument is the classifier's {answerClass, code}: the class of the seller's answer and its error code.
export class SellerUnavailableError extends Error {
  constructor(message, causeCode = 'other', { answerClass = SELLER_ANSWER_CLASS.UNKNOWN, code } = {}) {
    super(message);
    this.name = 'SellerUnavailableError';
    this.code = 'seller_unavailable';
    this.causeCode = sellerFailureCause(causeCode) ?? 'other';
    this.answerClass = answerClass;
    this.answerCode = code;
  }
}

// A local certificate guard runs before dispatch. It cannot establish the
// outcome of an earlier seller effect, so it stays unavailable, not refused.
const preDispatchFailures = new WeakSet();
export function sellerFailureAttempt(error) {
  return { causeCode: sellerFailureCause(error?.causeCode), ...(preDispatchFailures.has(error) ? { dispatched: false } : {}) };
}

export class SellerTlsUnusableError extends SellerUnavailableError {
  constructor(message) {
    super(message, 'tls', { answerClass: SELLER_ANSWER_CLASS.NOT_SENT });
    this.code = 'seller_tls_unusable';
    Object.defineProperty(this, 'dispatched', { value: false, enumerable: true });
    preDispatchFailures.add(this);
  }
}

const FAILURE_CAUSES = new Set(['tls', 'network', 'response-auth', 'status-4xx', 'status-5xx', 'client-sign', 'timeout', 'other']);
export const sellerFailureCause = (value) => FAILURE_CAUSES.has(value) ? value : undefined;
const TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_CHAIN_TOO_LONG', 'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD', 'UNHANDLED_CRITICAL_EXTENSION', 'INVALID_CA']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
function failureCause(error, phase, signal) {
  if (signal?.aborted || error?.name === 'TimeoutError') return 'timeout';
  if (phase === 'client-sign') return 'client-sign';
  // Node fetch wraps TLS/socket errors in `cause`. Inspect only bounded
  // machine codes, never error messages, peer metadata or certificate bytes.
  for (let depth = 0, current = error; current && depth < 4; depth++, current = current.cause) {
    const code = current.code;
    if (TIMEOUT_CODES.has(code) || ['TimeoutError', 'AbortError'].includes(current.name)) return 'timeout';
    if (TLS_CODES.has(code) || (typeof code === 'string' && /^(?:ERR_TLS_|ERR_SSL_)/.test(code))) return 'tls';
    if (NETWORK_CODES.has(code)) return 'network';
  }
  return phase;
}

export class SellerRefusedError extends Error {
  constructor(code, message, status, answerClass = SELLER_ANSWER_CLASS.DEFINITE) {
    super(message);
    this.name = 'SellerRefusedError';
    this.code = code;
    this.status = status;
    this.answerClass = answerClass;
  }
}

// Closed route policy: durable effects, bootstrap provenance, retained replay and default time budget.
/** Policy for the ten admitted seller routes; unknown routes have no durable identity. */
export const SELLER_REQUEST_POLICY = Object.freeze(Object.fromEntries([
  [DACS_SELLER_HTTP_PATHS.context, true, true, false, 240000],
  [DACS_SELLER_HTTP_PATHS.contextChallenge, true, true, false, 15000],
  [DACS_SELLER_HTTP_PATHS.proposals, true, false, false, 15000],
  [DACS_SELLER_HTTP_PATHS.commitments, true, false, true, 15000],
  [DACS_SELLER_HTTP_PATHS.commitmentSignature, true, false, true, 15000],
  [DACS_SELLER_HTTP_PATHS.payments, true, false, true, 15000],
  [DACS_SELLER_HTTP_PATHS.bundleRequest, true, false, true, 15000],
  [DACS_SELLER_HTTP_PATHS.bundleCountersignature, true, false, true, 15000],
  [DACS_SELLER_HTTP_PATHS.state, false, false, false, 15000],
  [DACS_SELLER_HTTP_PATHS.bundleBuyerCopy, false, false, false, 15000],
].map(([path, durable, bootstrap, retained, timeoutMs]) => [path, Object.freeze({ durable, bootstrap, retained, timeoutMs })])));
const SELLER_MAX_TIMEOUT_MS = 300000;
/** Extra sends allowed after an authenticated unknown dispatch (DC-CW6). */
export const SELLER_UNKNOWN_RETRIES = 2;
/** Milliseconds between sends within one request deadline (DC-CW6). */
export const SELLER_RETRY_DELAY_MS = 5000;
const SELLER_CLOCK = Object.freeze({ now: () => performance.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) });
// A refusal raised by the request records (stale row, purchase no longer authorizing): not a seller answer.
const recordRefusals = new WeakSet();
const SELLER_OPERATOR_MESSAGE = 'the seller reports this operation is unresolved and needs the seller operator; it is not retried automatically';
const UNAVAILABLE_ANSWER_MESSAGE = 'seller agent response is unavailable or unauthenticated; the operation outcome may be unknown';
const { RESULT, PROGRESS, DEFINITE, FAILED_BOOTSTRAP } = SELLER_ANSWER_CLASS;
const statusCause = (status) => (status >= 500 && status <= 599 ? 'status-5xx' : status >= 400 && status < 500 ? 'status-4xx' : 'other');

// Result and progress answers are returned; a definite answer is a refusal; every other class leaves the outcome unknown.
function answerOrError(verdict, answer, status) {
  const { answerClass, code } = verdict;
  if (answerClass === RESULT || answerClass === PROGRESS) return answer;
  if (answerClass === DEFINITE || answerClass === FAILED_BOOTSTRAP) {
    const refusalCode = code ?? `http_${status}`;
    throw new SellerRefusedError(refusalCode, typeof answer.message === 'string' ? answer.message.slice(0, 200) : refusalCode, status, answerClass);
  }
  throw new SellerUnavailableError(code === SELLER_EFFECT_UNRESOLVED ? SELLER_OPERATOR_MESSAGE : UNAVAILABLE_ANSWER_MESSAGE, statusCause(status), verdict);
}

/**
 * Creates the bounded seller transport. Every call returns a verified answer or throws a classified seller error.
 * classifyAnswer is the injectable K5 classifier; the default is the real one. requestRecords is the adapter's durable
 * record store (`start(path, body)` returns `{text, stored, continuation, newPurchase, check(), finish(answerClass, answerCode)}`;
 * `stored: true` identifies a durably recorded effect attempt, while reads use false,
 * and `failure(error)` records a refusal). Authenticated calls with stored attempts retry unknown dispatches twice; all other calls send once. A suspended answer is recorded and never retried.
 * clock supplies `now()` and `sleep(ms)` so a test injects time.
 */
export function createSellerAgentClient({ url, fetchImpl = globalThis.fetch, timeoutMs, authentication, commitOnSignature = false, classifyAnswer = classifySellerAnswer, requestRecords, clock = SELLER_CLOCK }) {
  const base = new URL(String(url).replace(/\/$/, ''));
  if (!LOOPBACK_HOSTS.has(base.hostname) || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('seller agent endpoint must be loopback without credentials, query or fragment');
  }
  const origin = base.origin;
  const prefix = base.pathname.replace(/\/$/, '');

  if (authentication && prefix) throw new Error('authenticated seller transport uses the exact /dacs/v1 paths');
  let lastFailureCause, lastFailureDispatched, hasDispatched = false;

  const routeDeadlineMs = (path) => {
    const policy = SELLER_REQUEST_POLICY[path];
    return Math.min(SELLER_MAX_TIMEOUT_MS, Math.max(policy?.timeoutMs === 240000 ? policy.timeoutMs : 0, timeoutMs ?? policy?.timeoutMs ?? 15000));
  };

  // One absolute deadline includes storage, authority reads, signing, delays and transport.
  async function post(path, body) {
    const deadline = clock.now() + routeDeadlineMs(path);
    let unknown, unknownCause;
    for (let retry = 0; ; retry++) {
      if (clock.now() >= deadline) {
        if (unknown) throw unknown;
        lastFailureCause = 'timeout'; lastFailureDispatched = false;
        const unsent = new SellerUnavailableError(UNAVAILABLE_ANSWER_MESSAGE, 'timeout', { answerClass: SELLER_ANSWER_CLASS.NOT_SENT });
        preDispatchFailures.add(unsent);
        throw unsent;
      }
      const attempt = requestRecords?.start(path, body);
      try {
        const answer = await send(path, body, attempt, deadline);
        attempt?.finish(answer.answerClass);
        return answer.body;
      } catch (error) {
        if (!(error instanceof SellerUnavailableError) && !(error instanceof SellerRefusedError)) throw error;
        // A suspended answer stops retries even when its suspension write fails; the write failure is kept as its cause.
        try { attempt?.finish(error.answerClass, error.answerCode); } catch (writeFailure) {
          if (error.answerClass !== SELLER_ANSWER_CLASS.SUSPENDED) throw writeFailure;
          error.cause = writeFailure;
        }
        // A retry that fails before dispatch is recorded as unsent, but the call still owes the earlier send's unknown outcome.
        if (unknown && error.answerClass === SELLER_ANSWER_CLASS.NOT_SENT) { lastFailureCause = unknownCause; lastFailureDispatched = undefined; throw unknown; }
        if (!authentication || !attempt?.stored || error.answerClass !== SELLER_ANSWER_CLASS.UNKNOWN || retry === SELLER_UNKNOWN_RETRIES || clock.now() + SELLER_RETRY_DELAY_MS >= deadline) throw error;
        unknown = error; unknownCause = lastFailureCause;
      }
      await clock.sleep(SELLER_RETRY_DELAY_MS);
    }
  }

  async function send(path, requestBody, attempt, deadline) {
    lastFailureCause = undefined;
    lastFailureDispatched = undefined;
    let phase = 'other', signal, dispatched = false;
    const checkDeadline = () => {
      signal?.throwIfAborted();
      if (clock.now() >= deadline) throw new DOMException('seller request deadline elapsed', 'TimeoutError');
    };
    try {
      const text = attempt?.text ?? JSON.stringify(requestBody);
      const body = attempt ? JSON.parse(text) : requestBody;
      if (Buffer.byteLength(text) > MAX_BODY) throw new Error('request exceeds byte limit');
      // One deadline covers signing too: the wire's authority and proof reads and the host's signer have none of their own.
      checkDeadline();
      signal = AbortSignal.timeout(Math.ceil(deadline - clock.now()));
      phase = 'client-sign';
      const signed = authentication ? await settleOnAbort(authentication.request(path, body, text, { signal, checkDeadline }), signal) : null;
      checkDeadline();
      try { attempt?.check(); } catch (refusal) { recordRefusals.add(refusal); throw refusal; }
      checkDeadline();
      phase = 'other';
      hasDispatched = true; dispatched = true;
      const response = await settleOnAbort(fetchImpl(`${origin}${prefix}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...(signed ? { [DACS_SELLER_HTTP_HEADER]: signed.header } : {}) }, body: text, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal }), signal, cancelResponseBody);
      phase = 'response-auth';
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes) { cancelResponseBody(response); throw new Error('response exceeds byte limit'); }
      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        signal.addEventListener('abort', () => { reader.cancel().catch(() => {}); }, { once: true });
        for (;;) {
          const { done, value } = await settleOnAbort(reader.read(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes) { reader.cancel().catch(() => {}); throw new Error('response exceeds byte limit'); }
          chunks.push(value);
        }
      }
      const answerBytes = Buffer.concat(chunks);
      // Unsigned 429/404/415/503 answers cannot authenticate their status.
      // Verify first: these failures stay response-auth, including signer fallback 503.
      const receipt = authentication
        ? await settleOnAbort(authentication.verifyResponse(signed.payload, { header: response.headers.get(DACS_SELLER_HTTP_HEADER), status: response.status, body: answerBytes }), signal)
        : null;
      const answer = receipt ? receipt.body : admitRawJson(answerBytes, { maxBytes: DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes });
      if (response.status >= 500 && response.status <= 599) phase = 'status-5xx';
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) throw new Error('response did not return JSON');
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('response JSON is not an object');
      // The record exists only here, after the wire verified the exact bytes: the HTTP status it checked and the body it admitted.
      if (receipt) {
        phase = 'classified';
        // Provenance and request kind come only from the adapter's own record of this request, never from the answer or a caller.
        const verdict = classifyAnswer({ status: response.status, signed: true, body: receipt.body }, { path, dispatched: true, continuation: attempt?.continuation ?? false, newPurchase: attempt?.newPurchase ?? false });
        return { body: answerOrError(verdict, receipt.body, response.status), answerClass: verdict.answerClass };
      }
      if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status) && typeof answer.error === 'string') throw new SellerRefusedError(answer.error, typeof answer.message === 'string' ? answer.message.slice(0, 200) : answer.error, response.status);
      if (!response.ok) throw new Error('seller did not return success');
      return { body: answer, answerClass: RESULT };
    } catch (error) {
      if (recordRefusals.has(error)) throw error;
      if (phase === 'client-sign' && preDispatchFailures.has(error)) { lastFailureCause = 'tls'; lastFailureDispatched = false; throw error; }
      if (error instanceof SellerRefusedError) throw error;
      if (phase === 'classified' && error instanceof SellerUnavailableError) { lastFailureCause = error.causeCode; throw error; }
      lastFailureCause = failureCause(error, phase, signal);
      const unavailable = new SellerUnavailableError(UNAVAILABLE_ANSWER_MESSAGE, lastFailureCause, { answerClass: dispatched ? SELLER_ANSWER_CLASS.UNKNOWN : SELLER_ANSWER_CLASS.NOT_SENT });
      if (!dispatched) { preDispatchFailures.add(unavailable); lastFailureDispatched = false; }
      if (error instanceof RawJsonAdmissionError) { unavailable.admissionCode = error.code; unavailable.admissionStage = error.stage; }
      throw unavailable;
    }
  }

  return {
    origin,
    // The route adapter for callers without a named method yet (the context and challenge routes belong to the bootstrap callers).
    request: post,
    // Records the bounded outcome of a failure that the caller otherwise swallows.
    recordFailure: (error) => requestRecords?.failure(error),
    // The durable Agreement coordinator retains only disposition/reason.
    // Its caller records the last failed HTTP call's bounded cause separately.
    get failureCause() { return lastFailureCause; },
    // An Agreement coordinator can make several calls with this client. A
    // refusal of its last call cannot hide an earlier dispatched proposal.
    get failureDispatched() { return lastFailureDispatched === false && !hasDispatched ? false : undefined; },
    propose: (body) => post('/dacs/v1/agreements/proposals', body),
    agreementState: (transportIdentity) => post('/dacs/v1/agreements/state', { transportIdentity }),
    // The existing authentication signs the complete serialized body, including
    // this optional public CREATE. Omission preserves legacy fixture requests.
    commit: (jobId, { signedProjection } = {}) => post('/dacs/v1/commitments', { jobId, ...(signedProjection === undefined ? {} : { signedProjection }) }),
    ...(commitOnSignature ? { commitOnSignature: (jobId, agreement, signedProjection) => post('/dacs/v1/commitments/signature', { jobId, agreement, signedProjection }) } : {}),
    submitPayment: (body) => post('/dacs/v1/payments', body),
    bundleRequest: (jobId) => post('/dacs/v1/bundles/request', { jobId }),
    countersign: (jobId, buyerSignature) => post('/dacs/v1/bundles/countersignature', { jobId, buyerSignature }),
    confirmBuyerCopy: (jobId) => post('/dacs/v1/bundles/buyer-copy', { jobId }),
  };
}
