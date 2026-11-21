// Buyer authentication uses the wire's profile, proof and byte admission.
import { randomBytes } from 'node:crypto';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';
import { signWireRequest, signExplicitCreateResume, verifyWireResponse, wireRequestHash, WireError, isPublicEndpoint, isReadRoute, DACS_SELLER_HTTP_LIMITS, DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { assertPurchaseActionsAdmitted } from './action-admission.mjs';
import { OperationError } from '../client-errors.mjs';
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
// The wire's CONTINUING_PATHS (discovery.ts) is not a public export; the wire-continuation-evidence test compares this set with it.
const CONTINUING_PATHS = new Set([DACS_SELLER_HTTP_PATHS.payments, DACS_SELLER_HTTP_PATHS.bundleRequest, DACS_SELLER_HTTP_PATHS.bundleCountersignature]);
// The pre-Agreement routes: their body is `{scope, …}`, and they are signed for the scope's job under the scope's own hash.
const BOOTSTRAP_PATHS = new Set([DACS_SELLER_HTTP_PATHS.contextChallenge, DACS_SELLER_HTTP_PATHS.context]);
// 32 random bytes name one proof in the seller's one-use ledger.
const PROOF_NONCE_BYTES = 32;
const EVIDENCE_MEMBERS = ['commitment', 'agreement', 'signedListing'];
const evidenceMembers = (kept) => Object.fromEntries(EVIDENCE_MEMBERS.filter((member) => kept?.[member] !== undefined).map((member) => [member, kept[member]]));

/**
 * Returns a wire request signer and async response verifier using the kept job and current admission.
 * `evidence` (optional) is an async function returning `{commitment, agreement, signedListing}` bytes for a committed purchase, or undefined before commitment.
 * It is asked only for the continuing routes and the two ordinary read routes; every other route is signed with none, and the wire refuses a continuing route without it.
 * Without `evidence` it signs only the routes up to the commitment (proposals, state, context, context challenge, commitments and commitment signature); the payment routes, the bundle routes and the buyer's bundle copy are refused with continuation_commitment_invalid before the signer is called, and a read of an already committed purchase is signed as a read of a new one.
 * The challenge and context routes are signed for `body.scope.jobId` with `agreementHash = sha256(JCS(body.scope))`; every other route needs `job.agreementHash`
 * (the retained plan's) and is refused with OperationError(seller_plan_required) without it.
 * Rejects with wire errors or profile_not_admitted; malformed configuration throws TypeError, and a missing delegation throws OperationError(seller_delegation_unavailable). No transport is invoked.
 * `request` takes optional `{ signal, checkDeadline }` guards for one absolute deadline: once it aborts, the session signer is not called and a late signature is dropped.
 */
export function createSellerWireAuthentication({ admission, sessionSigner, delegation, seller, publicEndpoint, endpointProof, job, evidence, now = () => Date.now() }) {
  if (!admission?.binding || typeof admission.currentLocal !== 'function') throw new TypeError('admission_required');
  if (!CLAIM.test(sessionSigner?.claim) || typeof sessionSigner?.sign !== 'function' || !CLAIM.test(seller)
    || !isPublicEndpoint(publicEndpoint) || !job?.jobId || !job.listingPin || !job.profile || typeof now !== 'function') throw new TypeError('seller_wire_configuration_invalid');
  if (!delegation?.payload || typeof delegation.signature !== 'string') throw new OperationError('seller_delegation_unavailable', 'a retained wallet-signed session delegation is required');
  const { binding, currentLocal } = admission;
  // The session signer for one route. The wire awaits its binding and proof checks before it calls sign, so admission, the connection
  // and the delegation's expiry (readback routes excepted) are read again in the same step as the signature.
  // A caller's deadline stops the signer from being called, and a signature that arrives after it is dropped.
  const signerFor = (path, localDigest, retainedDelegation, { signal, checkDeadline }) => ({ claim: sessionSigner.claim, async sign(bytes) {
    signal?.throwIfAborted(); checkDeadline();
    assertPurchaseActionsAdmitted();
    if (canonicalize(currentLocal()) !== localDigest) throw new OperationError('tp1_local_binding_changed', 'the actor connection changed before signing');
    if (!isReadRoute(path) && now() >= retainedDelegation.payload.expiresAt) throw new WireError('peer_delegation_expired', 500);
    signal?.throwIfAborted(); checkDeadline();
    const signature = await sessionSigner.sign(bytes);
    signal?.throwIfAborted(); checkDeadline();
    return signature;
  } });
  return Object.freeze({
    async request(path, body, text, { signal, checkDeadline = () => {} } = {}) {
      signal?.throwIfAborted(); checkDeadline();
      assertPurchaseActionsAdmitted();
      const bootstrap = BOOTSTRAP_PATHS.has(path);
      const jobId = bootstrap ? body.scope?.jobId : body.transportIdentity?.jobId ?? body.jobId;
      if (jobId !== job.jobId) throw new OperationError('peer_job_mismatch', 'request differs from the retained purchase');
      const agreementHash = bootstrap ? sha256Hex(canonicalize(body.scope)) : job.agreementHash;
      if (!agreementHash) throw new OperationError('seller_plan_required', 'a retained Agreement plan is required');
      const kept = CONTINUING_PATHS.has(path) || isReadRoute(path) ? await evidence?.() : undefined;
      // The wire treats a read with no commitment as a new purchase; evidence that is supplied but lacks its commitment never drops to that branch.
      if (kept && kept.commitment === undefined) throw new WireError('continuation_commitment_invalid', 500, 'CONTINUATION-EVIDENCE-REQUIRED');
      signal?.throwIfAborted(); checkDeadline();
      const local = currentLocal(), retainedDelegation = JSON.parse(JSON.stringify(delegation));
      const signed = await signWireRequest({ binding, local, signer: signerFor(path, canonicalize(local), retainedDelegation, { signal, checkDeadline }), delegation: retainedDelegation, endpointProof, publicEndpoint, path, jobId, text, seller, ...evidenceMembers(kept),
        job: { listingPin: job.listingPin, agreementHash, profile: job.profile, ...(bootstrap || job.deadline === undefined ? {} : { deadline: job.deadline }) }, now: now() });
      // The wire builds the expiry from the clock read above, before its awaited authority reads; a slow read can leave the request already expired.
      if (signed.payload.expiresAt <= now()) throw new WireError('peer_expired', 500);
      return signed;
    },
    /**
     * Signs the one-use proof of an explicit resume for `signed`, the request `request` just returned, and returns its
     * `x-dacs-seller-resume` header. The proof names that request's hash and lives no longer than the request or the wire's
     * signed lifetime. Rejects with the wire's `explicit_resume_invalid` for a route that is not an effect route, with
     * `profile_not_admitted` while purchases are held, and with the signer's own refusals. It takes the same deadline guards as `request`.
     */
    async resumeProof({ payload }, { signal, checkDeadline = () => {} } = {}) {
      signal?.throwIfAborted(); checkDeadline();
      assertPurchaseActionsAdmitted();
      const local = currentLocal(), time = now(), retainedDelegation = JSON.parse(JSON.stringify(delegation));
      return signExplicitCreateResume({ version: '1', kind: 'explicit-create-resume', buyer: payload.buyer, seller: payload.seller, listingPin: payload.listingPin,
        jobId: payload.jobId, path: payload.path, agreementHash: payload.agreementHash, requestHash: wireRequestHash(payload), nonce: randomBytes(PROOF_NONCE_BYTES).toString('base64url'),
        expiresAt: Math.min(payload.expiresAt, time + DACS_SELLER_HTTP_LIMITS.maxSignedLifetimeMs), profile: payload.profile },
      // The session key signs for the buyer the request names; the wire checks the proof's signer is that buyer.
      { signer: { ...signerFor(payload.path, canonicalize(local), retainedDelegation, { signal, checkDeadline }), claim: payload.buyer }, binding, local, now: time });
    },
    async verifyResponse(payload, { header, status, body }) {
      return verifyWireResponse(payload, { binding, local: currentLocal(), header, status, body, now: now() });
    },
  });
}
