// A buyer that signs, for tests only (the kit client refuses `authentication`; real buyers use the client package):
// - `createSellerWireClientAuth`: the buyer's wire request signer and answer verifier for a host that answers through `./wire`;
// - `signedBuyerClient`: a POST client with the kit client's methods that sends each request with an `authentication`
//   adapter's header and verifies each answer over its exact bytes.
// Every import goes through a package name, so the installed-package smoke can copy this file next to its own helpers.
import { admitRawJson } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_HEADER, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_PATHS, WireError, isPublicEndpoint, signWireRequest, verifyWireResponse } from '@kynesyslabs/dacs/wire';
import { boundedCall, isBoundedCallTimeout } from '@kynesyslabs/dacs-seller/src/dacs/bounded-call.mjs';
import { SellerRefusedError, SellerUnavailableError } from '@kynesyslabs/dacs-seller/src/dacs/seller-http.mjs';
import { sellerContextScopeHash } from '@kynesyslabs/dacs-seller/src/dacs/seller-transport-auth.mjs';
import { WIRE_ROUTE_PATHS } from '@kynesyslabs/dacs-seller/src/dacs/seller-wire-requests.mjs';

// What `evidenceFor` may add to a request; any other member it returns is dropped, so it cannot replace the signer or the binding.
const EVIDENCE_MEMBERS = Object.freeze(['commitment', 'agreement', 'signedListing', 'continuation']);
// The routes taken before any Agreement exists: their job and Agreement hash come from the body's scope.
const CONTEXT_PATHS = Object.freeze([DACS_SELLER_HTTP_PATHS.context, DACS_SELLER_HTTP_PATHS.contextChallenge]);
const SIGNING_TIMEOUT_MS = 10000;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_BODY = 64 * 1024;
const MAX_RESPONSE_LIST = 256;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unsupportedRoute = (path) => new WireError('wire_client_route_unsupported', 500, `no signer for ${String(path).slice(0, 64)}`);

/**
 * The buyer's request signer and response verifier. `binding`, `connection`, `endpointProof` and `publicEndpoint` come from
 * `bindTp1Profile` and `verifyEndpointProof` over the seller's signed discovery document; `signer` is the buyer's
 * `{ claim, sign }`, or a session signer with the buyer wallet's `delegation`. `resolveJob(jobId)` gives the approved job's
 * `{ listingPin, agreementHash, deadline? }`; on the context routes the Agreement hash is the hash of the request's own scope.
 * `evidenceFor(path, jobId)` gives the commitment, Agreement and signed Listing a continuing route needs. `request` rejects with
 * `wire_client_route_unsupported` for a route it has no signer for, and with `wire_client_signing_timeout` when signing (the
 * lookups included) takes longer than `signingTimeoutMs`. Throws on an invalid configuration.
 */
export function createSellerWireClientAuth({ signer, delegation = null, binding, connection, endpointProof, publicEndpoint, seller, resolveJob, evidenceFor = async () => ({}), now = () => Date.now(), lifetimeMs, signingTimeoutMs = SIGNING_TIMEOUT_MS }) {
  if (typeof signer?.claim !== 'string' || typeof signer.sign !== 'function' || !record(binding) || typeof connection !== 'function' || !record(endpointProof) || !isPublicEndpoint(publicEndpoint) ||
      typeof seller !== 'string' || typeof resolveJob !== 'function' || typeof evidenceFor !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(signingTimeoutMs) || signingTimeoutMs <= 0 || signingTimeoutMs > MAX_TIMER_MS) throw new Error('seller wire client configuration is invalid');
  const withinSigningDeadline = (work) => boundedCall(work, { timeoutMs: signingTimeoutMs }).catch((error) => {
    if (isBoundedCallTimeout(error)) throw new WireError('wire_client_signing_timeout', 500, `signing did not finish within ${signingTimeoutMs} ms`, error);
    throw error;
  });
  const jobOf = (path, body) => {
    if (!CONTEXT_PATHS.includes(path)) return { jobId: body.transportIdentity?.jobId ?? body.jobId };
    return { jobId: body.scope?.jobId, scopeHash: sellerContextScopeHash(body.scope) };
  };
  const signOnWire = async (path, body, text) => {
    const { jobId, scopeHash } = jobOf(path, body);
    const { listingPin, agreementHash, deadline } = await resolveJob(jobId);
    const evidence = Object.entries(await evidenceFor(path, jobId)).filter(([name]) => EVIDENCE_MEMBERS.includes(name));
    return signWireRequest({ signer, binding, local: connection(), endpointProof, publicEndpoint, path, jobId, text, seller, delegation, now: now(),
      job: { listingPin, agreementHash: scopeHash ?? agreementHash, profile: binding.profile, ...(deadline === undefined ? {} : { deadline }) }, ...Object.fromEntries(evidence), ...(lifetimeMs === undefined ? {} : { lifetimeMs }) });
  };
  return {
    async request(path, body, text) {
      if (!WIRE_ROUTE_PATHS.includes(path) && !CONTEXT_PATHS.includes(path)) throw unsupportedRoute(path);
      if (!record(body)) throw new WireError('peer_body_invalid', 500, 'the request body is not an object');
      return withinSigningDeadline(() => signOnWire(path, body, text));
    },
    verifyResponse(request, { header, status, responseBytes }) {
      return verifyWireResponse(request, { header, status, body: responseBytes, now: now(), binding, local: connection() });
    },
  };
}

// The cause an unavailable answer reports: where the request failed, or a timeout or network code found in its causes.
function failureCause(error, phase, signal) {
  if (phase === 'client-sign') return 'client-sign';
  if (signal?.aborted) return 'timeout';
  for (let depth = 0, current = error; current && depth < 4; depth++, current = current.cause) {
    const code = typeof current.code === 'string' ? current.code : '';
    if (['TimeoutError', 'AbortError'].includes(current.name) || /^(?:ETIMEDOUT|UND_ERR_\w*TIMEOUT)$/.test(code)) return 'timeout';
    if (/^(?:ERR_TLS_|ERR_SSL_)/.test(code)) return 'tls';
    if (/^(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|UND_ERR_SOCKET)$/.test(code)) return 'network';
  }
  return phase;
}

// Waits for the answer's verification for what is left of the deadline; with none left it fails without verifying.
function verifiedWithin(verify, timeLeftMs) {
  if (timeLeftMs <= 0) return Promise.reject(new DOMException('the response arrived after the client deadline', 'TimeoutError'));
  return boundedCall(verify, { timeoutMs: Math.ceil(timeLeftMs) });
}

/**
 * A client with the kit client's methods whose every request is signed by `authentication.request(path, body, text)` and whose
 * every answer is verified by `authentication.verifyResponse(payload, { header, status, text, responseBytes })` within the
 * deadline. Only a verified definite refusal (a 4xx other than 408 and 429, or `peer_job_capacity` at 503) is a
 * `SellerRefusedError`; anything else that fails is a `SellerUnavailableError`, its cause in `failureCause`.
 */
export function signedBuyerClient({ url, fetchImpl = globalThis.fetch, timeoutMs = 15000, authentication, commitOnSignature = false }) {
  const origin = new URL(String(url)).origin;
  let lastFailureCause;
  async function post(path, body) {
    lastFailureCause = undefined;
    let phase = 'other', signal;
    try {
      const text = JSON.stringify(body);
      if (Buffer.byteLength(text) > MAX_BODY) throw new Error('request exceeds byte limit');
      phase = 'client-sign';
      const signed = await authentication.request(path, body, text);
      phase = 'other';
      signal = AbortSignal.timeout(timeoutMs);
      const deadline = performance.now() + timeoutMs;
      const response = await fetchImpl(`${origin}${path}`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', [DACS_SELLER_HTTP_HEADER]: signed.header }, body: text, redirect: 'manual', credentials: 'omit', cache: 'no-store', signal });
      phase = 'response-auth';
      const responseBytes = Buffer.from(await response.arrayBuffer());
      if (responseBytes.length > DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes) throw new Error('response exceeds byte limit');
      const answer = admitRawJson(responseBytes);
      for (const pending = [answer]; pending.length;) {
        const member = pending.pop();
        if (Array.isArray(member) && member.length > MAX_RESPONSE_LIST) throw new Error('response collection exceeds item limit');
        if (member && typeof member === 'object') pending.push(...Object.values(member));
      }
      const answerText = new TextDecoder('utf-8', { fatal: true }).decode(responseBytes);
      await verifiedWithin(() => authentication.verifyResponse(signed.payload, { header: response.headers.get(DACS_SELLER_HTTP_HEADER), status: response.status, text: answerText, responseBytes }), deadline - performance.now());
      if (response.status >= 500 && response.status <= 599) phase = 'status-5xx';
      if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) throw new Error('response did not return JSON');
      if (!record(answer)) throw new Error('response JSON is not an object');
      const refused = (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) || (response.status === 503 && answer.error === 'peer_job_capacity');
      if (refused && typeof answer.error === 'string') throw new SellerRefusedError(answer.error, typeof answer.message === 'string' ? answer.message.slice(0, 200) : answer.error, response.status);
      if (!response.ok) throw new Error('seller did not return success');
      return answer;
    } catch (error) {
      if (error instanceof SellerRefusedError) throw error;
      lastFailureCause = failureCause(error, phase, signal);
      throw new SellerUnavailableError('seller agent response is unavailable or unauthenticated; the operation outcome may be unknown', lastFailureCause);
    }
  }
  return {
    origin,
    get failureCause() { return lastFailureCause; },
    propose: (body) => post('/dacs/v1/agreements/proposals', body),
    agreementState: (transportIdentity) => post('/dacs/v1/agreements/state', { transportIdentity }),
    commit: (jobId, { signedProjection } = {}) => post('/dacs/v1/commitments', { jobId, ...(signedProjection === undefined ? {} : { signedProjection }) }),
    ...(commitOnSignature ? { commitOnSignature: (jobId, agreement, signedProjection) => post('/dacs/v1/commitments/signature', { jobId, agreement, signedProjection }) } : {}),
    submitPayment: (body) => post('/dacs/v1/payments', body),
    bundleRequest: (jobId) => post('/dacs/v1/bundles/request', { jobId }),
    countersign: (jobId, buyerSignature) => post('/dacs/v1/bundles/countersignature', { jobId, buyerSignature }),
    confirmBuyerCopy: (jobId) => post('/dacs/v1/bundles/buyer-copy', { jobId }),
    agreementContext: (body) => post(DACS_SELLER_HTTP_PATHS.context, body),
    contextChallenge: (body) => post(DACS_SELLER_HTTP_PATHS.contextChallenge, body),
  };
}
