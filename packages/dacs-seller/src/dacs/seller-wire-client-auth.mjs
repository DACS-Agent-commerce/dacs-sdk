// The kit's buyer-side wire signer: the `authentication` adapter `createSellerAgentClient` takes for a host that answers
// through `./wire`. It signs each request with `signWireRequest` (the binding's TP-1 profile in every request) and verifies
// each answer with `verifyWireResponse` over the exact received bytes. The challenge and the context step still use the old
// server auth (seller-http.mjs), so they go to a `fallback` adapter, `createSellerTransportClientAuth`, and nothing else does.
import { WireError, isPublicEndpoint, signWireRequest, verifyWireResponse } from '@kynesyslabs/dacs/wire';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { boundedCall, isBoundedCallTimeout } from './bounded-call.mjs';
import { SELLER_CONTEXT_CHALLENGE_PATH, SELLER_CONTEXT_PATH } from './seller-transport-auth.mjs';
import { WIRE_ROUTE_PATHS } from './seller-wire-requests.mjs';

// What `evidenceFor` may add to a request; any other member it returns is dropped, so it cannot replace the signer or the binding.
const EVIDENCE_MEMBERS = Object.freeze(['commitment', 'agreement', 'signedListing', 'continuation']);
const FALLBACK_PATHS =Object.freeze([SELLER_CONTEXT_PATH, SELLER_CONTEXT_CHALLENGE_PATH]);
// The client's own deadline starts only once signing returns, so signing (the caller's lookups, the buyer's authority read and
// the signer) has this one, the same as the host's authority reader. `boundedCall` takes at most Node's timer limit.
const SIGNING_TIMEOUT_MS = 10000;
const MAX_SIGNING_TIMEOUT_MS = 2 ** 31 - 1;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isAdapter = (value) => record(value) && typeof value.request === 'function' && typeof value.verifyResponse === 'function';
const unsupportedRoute = (path) => new WireError('wire_client_route_unsupported', 500, `no signer for ${String(path).slice(0, 64)}`);

/**
 * Create the buyer's request signer and response verifier for a host on the wire. `binding`, `connection`, `endpointProof` and
 * `publicEndpoint` are what the buyer got from `bindTp1Profile` and `verifyEndpointProof` over the seller's signed discovery
 * document; `signer` is the buyer's `{ claim, sign }`, or a session signer with the buyer wallet's `delegation`. `resolveJob(jobId)`
 * gives the approved job's `{ listingPin, agreementHash, deadline? }`, never taken from a response. `evidenceFor(path, jobId)`
 * gives the commitment, Agreement and signed Listing a continuing route needs. `fallback` is an adapter for the challenge and the
 * context step only. Returns `{ request(path, body, text), verifyResponse(request, received) }`; `request` rejects with a
 * `WireError` (`wire_client_route_unsupported`) for a route it has no signer for, and with the wire's own refusal when the
 * connection or authority changed after binding, or with `wire_client_signing_timeout` (500) when signing, the caller's lookups
 * included, takes longer than `signingTimeoutMs` (default 10,000 ms): nothing is dispatched then. Throws on an invalid
 * configuration, and while the kit guard is off.
 */
export function createSellerWireClientAuth({ signer, delegation = null, binding, connection, endpointProof, publicEndpoint, seller, resolveJob, evidenceFor = async () => ({}), fallback = null, now = () => Date.now(), lifetimeMs, signingTimeoutMs = SIGNING_TIMEOUT_MS }) {
  assertKitOperationAdmitted('createSellerWireClientAuth');
  if (typeof signer?.claim !== 'string' || typeof signer.sign !== 'function' || !record(binding) || typeof connection !== 'function' || !record(endpointProof) || !isPublicEndpoint(publicEndpoint) ||
      typeof seller !== 'string' || typeof resolveJob !== 'function' || typeof evidenceFor !== 'function' || (fallback !== null && !isAdapter(fallback)) || typeof now !== 'function' ||
      !Number.isSafeInteger(signingTimeoutMs) || signingTimeoutMs <= 0 || signingTimeoutMs > MAX_SIGNING_TIMEOUT_MS) throw new Error('seller wire client configuration is invalid');
  // Which adapter signed each request, so its answer is verified by the same one.
  const signedBy = new WeakMap();
  const withinSigningDeadline = (work) => boundedCall(work, { timeoutMs: signingTimeoutMs }).catch((error) => {
    if (isBoundedCallTimeout(error)) throw new WireError('wire_client_signing_timeout', 500, `signing did not finish within ${signingTimeoutMs} ms`, error);
    throw error;
  });

  const signOnWire = async (path, body, text) => {
    const jobId = body.transportIdentity?.jobId ?? body.jobId;
    const { listingPin, agreementHash, deadline } = await resolveJob(jobId);
    const evidence = Object.entries(await evidenceFor(path, jobId)).filter(([name]) => EVIDENCE_MEMBERS.includes(name));
    return signWireRequest({ signer, binding, local: connection(), endpointProof, publicEndpoint, path, jobId, text, seller, delegation, now: now(),
      job: { listingPin, agreementHash, profile: binding.profile, ...(deadline === undefined ? {} : { deadline }) }, ...Object.fromEntries(evidence), ...(lifetimeMs === undefined ? {} : { lifetimeMs }) });
  };
  const requestOnWire = async (path, body, text) => {
    if (!record(body)) throw new WireError('peer_body_invalid', 500, 'the request body is not an object');
    const signed = await withinSigningDeadline(() => signOnWire(path, body, text));
    signedBy.set(signed.payload, 'wire');
    return signed;
  };

  return {
    async request(path, body, text) {
      if (WIRE_ROUTE_PATHS.includes(path)) return requestOnWire(path, body, text);
      if (!FALLBACK_PATHS.includes(path) || fallback === null) throw unsupportedRoute(path);
      const signed = await withinSigningDeadline(() => fallback.request(path, body, text));
      signedBy.set(signed.payload, 'fallback');
      return signed;
    },
    verifyResponse(request, { header, status, text, responseBytes }) {
      const adapter = signedBy.get(request);
      if (adapter === 'wire') return verifyWireResponse(request, { header, status, body: responseBytes, now: now(), binding, local: connection() });
      if (adapter === 'fallback') return fallback.verifyResponse(request, { header, status, text, responseBytes });
      throw unsupportedRoute(request?.path);
    },
  };
}
