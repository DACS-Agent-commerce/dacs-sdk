// Narrow HTTP transport for the seller agent (seller-agent.mjs) and the
// buyer-side client the plugin uses to reach it.
//
// Server/client stay loopback-only. Existing unauthenticated fixture callers
// remain supported. Supplying an authentication adapter enables signed peer
// requests, independently signed seller responses and a durable intent journal.
// Only an authenticated definite refusal becomes SellerRefusedError in that
// mode; unsigned, malformed, interrupted or ambiguous answers are unavailable.
import { SellerAgentError } from './seller-agent-error.mjs';
import { canonicalize, admitRawJson, RawJsonAdmissionError } from '@kynesyslabs/dacs';
import { SELLER_TRANSPORT_HEADER, SELLER_TRANSPORT_MAX_RESPONSE, SellerTransportError } from './seller-transport-auth.mjs';

const MAX_BODY = 64 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const loopbackSocket = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
// These seller-agent errors occur before an external effect. In particular,
// commitment_failed is deliberately absent: a write may have happened.
const NO_EFFECT_ERRORS = new Set(['buyer_access_closed', 'signature_commitment_disabled', 'signature_buyer_not_admitted', 'signature_connection_unavailable', 'seller_signature_buyer_unresolved', 'unknown_job', 'not_agreed', 'agreement_not_anchored', 'agreement_anchor_invalid', 'agreement_substituted', 'not_committed', 'payment_already_recorded', 'buyer_bundle_invalid', 'buyer_bundle_unauthenticated', 'self_dealing', 'job_invalid', 'buyer_mismatch', 'job_taken', 'not_delivered', 'no_bundle_request', 'bundle_invalid', 'no_seller_copy']);

const ROUTES = {
  '/dacs/v1/agreements/proposals': (agent, body) => agent.receiveProposal(body),
  '/dacs/v1/agreements/state': (agent, body) => agent.agreementState(body.transportIdentity),
  '/dacs/v1/commitments': (agent, body) => agent.commit(body),
  '/dacs/v1/payments': (agent, body) => agent.submitPayment(body),
  '/dacs/v1/bundles/request': (agent, body) => agent.bundleRequest(body),
  '/dacs/v1/bundles/countersignature': (agent, body) => agent.countersign(body),
  '/dacs/v1/bundles/buyer-copy': (agent, body) => agent.confirmBuyerCopy(body),
};
// The routes whose successful answers carry publicSignedCreates (chain readback on).
// The buyer takes pointers only from these answers. It never reads the answer to
// /dacs/v1/commitments/signature (DACS_COMMIT_ON_SIGNATURE=on sends it without
// waiting); its commitment pointer comes with the ordinary commit answer that
// follows its own Agreement readback, so the early route is not pointed.
const POINTED_ROUTES = new Set(['/dacs/v1/commitments', '/dacs/v1/payments']);
// Registered only with DACS_COMMIT_ON_SIGNATURE=on; off keeps main's route table.
const SIGNATURE_ROUTES = { ...ROUTES, '/dacs/v1/commitments/signature': (agent, body) => agent.commitOnSignature(body) };

function readRequest(req, timeoutMs) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted);
    };
    const error = (cause) => { cleanup(); reject(cause); };
    const aborted = () => error(new SellerTransportError('body_interrupted', 408));
    const data = (chunk) => {
      total += chunk.byteLength;
      if (total > MAX_BODY) { req.pause(); return error(new SellerTransportError('body_too_large', 413)); }
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const timer = setTimeout(() => { req.pause(); error(new SellerTransportError('body_timeout', 408)); }, timeoutMs);
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted);
  });
}

export function createSellerHttpHandler(agent, { authentication, bodyTimeoutMs = 5000, maxRequestsPerWindow = 120, rateWindowMs = 60000, maxConcurrent = 8, commitOnSignature = false, publicSignedCreates = null } = {}) {
  if (![bodyTimeoutMs, maxRequestsPerWindow, rateWindowMs, maxConcurrent].every((n) => Number.isSafeInteger(n) && n > 0)) throw new Error('seller transport limits must be positive integers');
  if (typeof commitOnSignature !== 'boolean') throw new TypeError('commitOnSignature must be boolean');
  const routes = commitOnSignature ? SIGNATURE_ROUTES : ROUTES;
  if (authentication && (authentication.seller !== agent.claim || canonicalize(authentication.listingPin) !== canonicalize(agent.listingPin))) throw new Error('seller transport identity must match the independently configured agent');
  if (authentication?.requireDelegation && typeof agent.transportAgreementOf !== 'function') throw new Error('delegated seller transport needs retained Agreement scope');
  if (publicSignedCreates !== null && typeof publicSignedCreates !== 'function') throw new Error('publicSignedCreates must be the seller\'s signed CREATE pointer function');
  // Chain readback: a successful commit or payment answer (the
  // only answers the buyer takes pointers from) also names the seller's
  // current verified signed CREATEs for its job, including an answer replayed
  // from the effect cache. The retained effect and its bytes are unchanged; a
  // pointer that cannot be looked up, or that would make the answer too large
  // to send, is left out, never an error. Other routes are sent as they are,
  // and never run the seller's in-answer readback.
  const pointed = async (status, text, jobId, path) => {
    if (!publicSignedCreates || status !== 200 || !POINTED_ROUTES.has(path)) return text;
    try {
      const answer = JSON.parse(text), decorated = await publicSignedCreates(jobId, answer);
      if (decorated === answer) return text;
      const pointedText = JSON.stringify(decorated);
      return Buffer.byteLength(pointedText) > SELLER_TRANSPORT_MAX_RESPONSE ? text : pointedText;
    } catch { return text; }
  };
  let windowStart = Date.now();
  let requests = 0;
  let active = 0;
  const send = async (res, status, body, request, { close = false, text = JSON.stringify(body) } = {}) => {
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', ...(close ? { connection: 'close' } : {}) };
    if (Buffer.byteLength(text) > SELLER_TRANSPORT_MAX_RESPONSE) throw new SellerTransportError('seller_response_too_large', 503);
    if (authentication && request) headers[SELLER_TRANSPORT_HEADER] = await authentication.responseHeader(request, status, text);
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, headers);
    res.end(text);
  };
  return async (req, res) => {
    let request;
    let reservation;
    let counted = false;
    try {
      if (!loopbackSocket(req.socket.remoteAddress) || !loopbackSocket(req.socket.localAddress)) return await send(res, 403, { error: 'loopback_only' }, null, { close: true });
      if (Date.now() - windowStart >= rateWindowMs) { windowStart = Date.now(); requests = 0; }
      if (++requests > maxRequestsPerWindow || active >= maxConcurrent) return await send(res, 429, { error: 'seller_rate_limited' }, null, { close: true });
      active++; counted = true;
      // Match the raw request target exactly: query strings, alternate paths
      // and encoded aliases cannot skip the path authenticated by the peer.
      const route = routes[req.url];
      if (!route) return await send(res, 404, { error: 'not_found' }, null, { close: true });
      if (req.method !== 'POST') return await send(res, 405, { error: 'method_not_allowed' }, null, { close: true });
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) return await send(res, 415, { error: 'json_required' }, null, { close: true });
      if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return await send(res, 415, { error: 'encoded_body_unsupported' }, null, { close: true });
      if (req.headers['content-length'] && Number(req.headers['content-length']) > MAX_BODY) return await send(res, 413, { error: 'body_too_large' }, null, { close: true });
      const rawBody = await readRequest(req, bodyTimeoutMs);
      let body;
      try { body = admitRawJson(rawBody, { maxBytes: MAX_BODY }); } catch (error) { return await send(res, 400, { error: 'bad_json', ...(error instanceof RawJsonAdmissionError ? { admissionCode: error.code, admissionStage: error.stage } : {}) }, null); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return await send(res, 400, { error: 'bad_request' }, null);
      if (authentication) {
        request = authentication.readRequest(req.headers[SELLER_TRANSPORT_HEADER]);
        authentication.validate(request, { method: req.method, path: req.url, rawBody, body, agreement: agent.transportAgreementOf?.(request.jobId) });
        reservation = authentication.store.reserve(request, body);
        if (reservation.disposition === 'cached') return await send(res, reservation.status, null, request, { text: await pointed(reservation.status, reservation.text, request.jobId, req.url) });
        if (reservation.disposition === 'uncertain') {
          // Never call the route or resume work here. This seller-owned seam
          // can only reduce trusted retained state plus fresh authenticated
          // native records to a response; absent/unknown facts remain fenced.
          const proof = typeof agent.reconcileTransport === 'function' && typeof authentication.store.reconcile === 'function'
            ? await agent.reconcileTransport({ request, body, rawBody }) : null;
          if (proof?.disposition === 'present') {
            const text = JSON.stringify(proof.value);
            authentication.store.reconcile(reservation, request, 200, text);
            return await send(res, 200, proof.value, request, { text: await pointed(200, text, request.jobId, req.url) });
          }
          return await send(res, 503, { error: 'operation_uncertain', message: 'A retained operation needs authenticated reconciliation; it was not performed again.' }, request);
        }
      }
      const answer = await route(agent, body);
      const text = JSON.stringify(answer);
      if (authentication) authentication.store.finish(reservation, 200, text, { noEffect: answer?.status === 'rejected' || answer?.disposition === 'rejected' });
      return await send(res, 200, answer, request, { text: await pointed(200, text, request?.jobId ?? body.jobId, req.url) });
    } catch (error) {
      const beforeEffect = !reservation || reservation.disposition !== 'perform';
      const refusal = error instanceof SellerTransportError && beforeEffect;
      const agentRefusal = error instanceof SellerAgentError && NO_EFFECT_ERRORS.has(error.code);
      const status = refusal ? error.status : agentRefusal ? error.status : 503;
      const answer = refusal || agentRefusal ? { error: error.code, message: error.message } : { error: 'operation_uncertain', message: 'The seller operation outcome is unavailable; no completion or finality is established.' };
      if (authentication && reservation?.disposition === 'perform') {
        try { authentication.store.finish(reservation, status, JSON.stringify(answer), { noEffect: agentRefusal }); } catch { /* durable intent remains uncertain */ }
      }
      try { return await send(res, status, answer, request, { close: status === 408 || status === 413 }); } catch {
        // A failed seller signer or journal cannot turn into a definite refusal.
        if (!res.headersSent && !res.destroyed) { res.writeHead(503, { 'content-type': 'application/json', connection: 'close' }); res.end('{"error":"operation_uncertain"}'); }
      }
    } finally {
      if (counted) active--;
    }
  };
}

export class SellerUnavailableError extends Error {
  constructor(message, causeCode = 'other') {
    super(message);
    this.name = 'SellerUnavailableError';
    this.code = 'seller_unavailable';
    this.causeCode = sellerFailureCause(causeCode) ?? 'other';
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
    super(message, 'tls');
    this.code = 'seller_tls_unusable';
    Object.defineProperty(this, 'dispatched', { value: false, enumerable: true });
    preDispatchFailures.add(this);
  }
}

const FAILURE_CAUSES = new Set(['tls', 'network', 'response-auth', 'status-5xx', 'client-sign', 'timeout', 'other']);
export const sellerFailureCause = (value) => FAILURE_CAUSES.has(value) ? value : undefined;
const TLS_CODES = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_REVOKED', 'CERT_SIGNATURE_FAILURE', 'CERT_UNTRUSTED', 'CERT_REJECTED', 'CERT_CHAIN_TOO_LONG', 'PATH_LENGTH_EXCEEDED', 'INVALID_PURPOSE', 'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY', 'ERROR_IN_CERT_NOT_BEFORE_FIELD', 'ERROR_IN_CERT_NOT_AFTER_FIELD', 'UNHANDLED_CRITICAL_EXTENSION', 'INVALID_CA']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_SOCKET']);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
function failureCause(error, phase, signal) {
  if (phase === 'client-sign') return 'client-sign';
  if (signal?.aborted) return 'timeout';
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
  constructor(code, message, status) {
    super(message);
    this.name = 'SellerRefusedError';
    this.code = code;
    this.status = status;
  }
}

export function createSellerAgentClient({ url, fetchImpl = globalThis.fetch, timeoutMs = 15000, authentication, commitOnSignature = false }) {
  const base = new URL(String(url).replace(/\/$/, ''));
  if (!LOOPBACK_HOSTS.has(base.hostname) || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('seller agent endpoint must be loopback without credentials, query or fragment');
  }
  const origin = base.origin;
  const prefix = base.pathname.replace(/\/$/, '');

  if (authentication && prefix) throw new Error('authenticated seller transport uses the exact /dacs/v1 paths');
  let lastFailureCause, lastFailureDispatched, hasDispatched = false;

  async function post(path, body) {
    lastFailureCause = undefined;
    lastFailureDispatched = undefined;
    let phase = 'other', signal;
    try {
      const text = JSON.stringify(body);
      if (Buffer.byteLength(text) > MAX_BODY) throw new Error('request exceeds byte limit');
      phase = 'client-sign';
      const signed = authentication ? await authentication.request(path, body, text) : null;
      phase = 'other';
      signal = AbortSignal.timeout(timeoutMs);
      hasDispatched = true;
      const response = await fetchImpl(`${origin}${prefix}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', ...(signed ? { [SELLER_TRANSPORT_HEADER]: signed.header } : {}) }, body: text, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal });
      phase = 'response-auth';
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > SELLER_TRANSPORT_MAX_RESPONSE) { await response.body?.cancel().catch(() => {}); throw new Error('response exceeds byte limit'); }
      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > SELLER_TRANSPORT_MAX_RESPONSE) { await reader.cancel().catch(() => {}); throw new Error('response exceeds byte limit'); }
          chunks.push(value);
        }
      }
      const answer = admitRawJson(Buffer.concat(chunks), { maxBytes: SELLER_TRANSPORT_MAX_RESPONSE });
      const answerText = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      // Unsigned 429/404/415/503 answers cannot authenticate their status.
      // Verify first: these failures stay response-auth, including signer fallback 503.
      if (authentication) authentication.verifyResponse(signed.payload, { header: response.headers.get(SELLER_TRANSPORT_HEADER), status: response.status, text: answerText });
      if (response.status >= 500 && response.status <= 599) phase = 'status-5xx';
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) throw new Error('response did not return JSON');
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) throw new Error('response JSON is not an object');
      if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status) && typeof answer.error === 'string') throw new SellerRefusedError(answer.error, typeof answer.message === 'string' ? answer.message.slice(0, 200) : answer.error, response.status);
      if (!response.ok) throw new Error('seller did not return success');
      return answer;
    } catch (error) {
      if (phase === 'client-sign' && preDispatchFailures.has(error)) { lastFailureCause = 'tls'; lastFailureDispatched = false; throw error; }
      if (error instanceof SellerRefusedError) throw error;
      lastFailureCause = failureCause(error, phase, signal);
      const unavailable = new SellerUnavailableError('seller agent response is unavailable or unauthenticated; the operation outcome may be unknown', lastFailureCause);
      if (error instanceof RawJsonAdmissionError) { unavailable.admissionCode = error.code; unavailable.admissionStage = error.stage; }
      throw unavailable;
    }
  }

  return {
    origin,
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
