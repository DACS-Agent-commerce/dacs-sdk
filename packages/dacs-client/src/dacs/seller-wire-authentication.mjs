// Buyer authentication uses the wire's profile, proof and byte admission.
import { canonicalize } from '@kynesyslabs/dacs';
import { signWireRequest, verifyWireResponse, WireError, isPublicEndpoint, isReadRoute, DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { assertPurchaseActionsAdmitted } from './action-admission.mjs';
import { OperationError } from '../client-errors.mjs';
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
// The wire's CONTINUING_PATHS (discovery.ts) is not a public export; the wire-continuation-evidence test compares this set with it.
const CONTINUING_PATHS = new Set([DACS_SELLER_HTTP_PATHS.payments, DACS_SELLER_HTTP_PATHS.bundleRequest, DACS_SELLER_HTTP_PATHS.bundleCountersignature]);
const EVIDENCE_MEMBERS = ['commitment', 'agreement', 'signedListing'];
const evidenceMembers = (kept) => Object.fromEntries(EVIDENCE_MEMBERS.filter((member) => kept?.[member] !== undefined).map((member) => [member, kept[member]]));

/**
 * Returns a wire request signer and async response verifier using the kept job and current admission. Rejects with wire errors or profile_not_admitted; malformed configuration throws TypeError, and a missing delegation throws OperationError(seller_delegation_unavailable). No transport is invoked. `request` takes an optional `{ signal }` deadline: once it aborts, the session signer is not called and a late signature is dropped.
 * `evidence` (optional) is an async function returning `{commitment, agreement, signedListing}` bytes for a committed purchase, or undefined before commitment.
 * It is asked only for the continuing routes and the two ordinary read routes; every other route is signed with none, and the wire refuses a continuing route without it.
 * Without `evidence` it signs only the routes up to the commitment (proposals, state, context, context challenge, commitments and commitment signature); the payment routes, the bundle routes and the buyer's bundle copy are refused with continuation_commitment_invalid before the signer is called, and a read of an already committed purchase is signed as a read of a new one.
 */
export function createSellerWireAuthentication({ admission, sessionSigner, delegation, seller, publicEndpoint, endpointProof, job, evidence, now = () => Date.now() }) {
  if (!admission?.binding || typeof admission.currentLocal !== 'function') throw new TypeError('admission_required');
  if (!CLAIM.test(sessionSigner?.claim) || typeof sessionSigner?.sign !== 'function' || !CLAIM.test(seller)
    || !isPublicEndpoint(publicEndpoint) || !job?.jobId || !job.listingPin || !job.agreementHash || !job.profile || typeof now !== 'function') throw new TypeError('seller_wire_configuration_invalid');
  if (!delegation?.payload || typeof delegation.signature !== 'string') throw new OperationError('seller_delegation_unavailable', 'a retained wallet-signed session delegation is required');
  const { binding, currentLocal } = admission;
  return Object.freeze({
    async request(path, body, text, { signal } = {}) {
      signal?.throwIfAborted();
      assertPurchaseActionsAdmitted();
      const jobId = body.transportIdentity?.jobId ?? body.jobId;
      if (jobId !== job.jobId) throw new OperationError('peer_job_mismatch', 'request differs from the retained purchase');
      const kept = CONTINUING_PATHS.has(path) || isReadRoute(path) ? await evidence?.() : undefined;
      // The wire treats a read with no commitment as a new purchase; evidence that is supplied but lacks its commitment never drops to that branch.
      if (kept && kept.commitment === undefined) throw new WireError('continuation_commitment_invalid', 500, 'CONTINUATION-EVIDENCE-REQUIRED');
      signal?.throwIfAborted();
      const local = currentLocal(), localDigest = canonicalize(local);
      const retainedDelegation = JSON.parse(JSON.stringify(delegation));
      // The wire awaits its binding and proof checks before it calls sign, so admission, the connection
      // and the delegation's expiry (readback routes excepted) are read again in the same step as the signature.
      // A caller's deadline stops the signer from being called, and a signature that arrives after it is dropped.
      const signer = { claim: sessionSigner.claim, async sign(bytes) {
        signal?.throwIfAborted();
        assertPurchaseActionsAdmitted();
        if (canonicalize(currentLocal()) !== localDigest) throw new OperationError('tp1_local_binding_changed', 'the actor connection changed before signing');
        if (!isReadRoute(path) && now() >= retainedDelegation.payload.expiresAt) throw new WireError('peer_delegation_expired', 500);
        const signature = await sessionSigner.sign(bytes);
        signal?.throwIfAborted();
        return signature;
      } };
      return signWireRequest({ binding, local, signer, delegation: retainedDelegation, endpointProof, publicEndpoint, path, jobId, text, seller, ...evidenceMembers(kept),
        job: { listingPin: job.listingPin, agreementHash: job.agreementHash, profile: job.profile, ...(job.deadline === undefined ? {} : { deadline: job.deadline }) }, now: now() });
    },
    async verifyResponse(payload, { header, status, body }) {
      return verifyWireResponse(payload, { binding, local: currentLocal(), header, status, body, now: now() });
    },
  });
}
