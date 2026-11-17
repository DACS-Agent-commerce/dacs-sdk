// The kit's buyer-side wire signer: the `authentication` adapter `createSellerAgentClient` takes for a host that answers
// through `./wire`. It signs each request with `signWireRequest` (the binding's TP-1 profile in every request) and verifies
// each answer with `verifyWireResponse` over the exact received bytes. This covers every route the host serves, the context
// challenge and the context step included.
import { WireError, isPublicEndpoint, signWireRequest, verifyWireResponse } from '@kynesyslabs/dacs/wire';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { boundedCall, isBoundedCallTimeout } from './bounded-call.mjs';
import { SELLER_CONTEXT_CHALLENGE_PATH, SELLER_CONTEXT_PATH, sellerContextScopeHash } from './seller-transport-auth.mjs';
import { WIRE_ROUTE_PATHS } from './seller-wire-requests.mjs';

// What `evidenceFor` may add to a request; any other member it returns is dropped, so it cannot replace the signer or the binding.
const EVIDENCE_MEMBERS = Object.freeze(['commitment', 'agreement', 'signedListing', 'continuation']);
// The routes taken before any Agreement exists: their job and Agreement hash come from the body's scope.
const CONTEXT_PATHS = Object.freeze([SELLER_CONTEXT_PATH, SELLER_CONTEXT_CHALLENGE_PATH]);
// The client's own deadline starts only once signing returns, so signing (the caller's lookups, the buyer's authority read and
// the signer) has this one, the same as the host's authority reader. `boundedCall` takes at most Node's timer limit.
const SIGNING_TIMEOUT_MS = 10000;
const MAX_SIGNING_TIMEOUT_MS = 2 ** 31 - 1;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unsupportedRoute = (path) => new WireError('wire_client_route_unsupported', 500, `no signer for ${String(path).slice(0, 64)}`);

/**
 * Create the buyer's request signer and response verifier for a host on the wire. `binding`, `connection`, `endpointProof` and
 * `publicEndpoint` are what the buyer got from `bindTp1Profile` and `verifyEndpointProof` over the seller's signed discovery
 * document; `signer` is the buyer's `{ claim, sign }`, or a session signer with the buyer wallet's `delegation`. `resolveJob(jobId)`
 * gives the approved job's `{ listingPin, agreementHash, deadline? }`, never taken from a response; on the context challenge and
 * the context step only its `listingPin` and `deadline` are used, and the Agreement hash is the hash of the request's own scope.
 * `evidenceFor(path, jobId)` gives the commitment, Agreement and signed Listing a continuing route needs. Returns
 * `{ request(path, body, text), verifyResponse(request, received) }`; `request` rejects with a `WireError`
 * (`wire_client_route_unsupported`) for a route it has no signer for, with `peer_job_invalid` (409) for a context request whose
 * scope has no canonical job, and with the wire's own refusal when the connection or authority changed after binding, or with
 * `wire_client_signing_timeout` (500) when signing, the caller's lookups included, takes longer than `signingTimeoutMs`
 * (default 10,000 ms): nothing is dispatched then. Throws on an invalid configuration, and while the kit guard is off.
 */
export function createSellerWireClientAuth({ signer, delegation = null, binding, connection, endpointProof, publicEndpoint, seller, resolveJob, evidenceFor = async () => ({}), now = () => Date.now(), lifetimeMs, signingTimeoutMs = SIGNING_TIMEOUT_MS }) {
  assertKitOperationAdmitted('createSellerWireClientAuth');
  if (typeof signer?.claim !== 'string' || typeof signer.sign !== 'function' || !record(binding) || typeof connection !== 'function' || !record(endpointProof) || !isPublicEndpoint(publicEndpoint) ||
      typeof seller !== 'string' || typeof resolveJob !== 'function' || typeof evidenceFor !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(signingTimeoutMs) || signingTimeoutMs <= 0 || signingTimeoutMs > MAX_SIGNING_TIMEOUT_MS) throw new Error('seller wire client configuration is invalid');
  const withinSigningDeadline = (work) => boundedCall(work, { timeoutMs: signingTimeoutMs }).catch((error) => {
    if (isBoundedCallTimeout(error)) throw new WireError('wire_client_signing_timeout', 500, `signing did not finish within ${signingTimeoutMs} ms`, error);
    throw error;
  });

  // The job a request is for and the Agreement hash it carries: a context request has no Agreement, so both come from its scope.
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
