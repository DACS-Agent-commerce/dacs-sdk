// Buyer authentication uses the wire's profile, proof and byte admission.
import { canonicalize } from '@kynesyslabs/dacs';
import { signWireRequest, verifyWireResponse, WireError, isPublicEndpoint, isReadRoute } from '@kynesyslabs/dacs/wire';
import { assertPurchaseActionsAdmitted } from './action-admission.mjs';
import { OperationError } from '../client-errors.mjs';
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;

/** Returns a wire request signer and async response verifier using the kept job and current admission. Rejects with wire errors or profile_not_admitted; malformed configuration throws TypeError, and a missing delegation throws OperationError(seller_delegation_unavailable). No transport is invoked. */
export function createSellerWireAuthentication({ admission, sessionSigner, delegation, seller, publicEndpoint, endpointProof, job, now = () => Date.now() }) {
  if (!admission?.binding || typeof admission.currentLocal !== 'function') throw new TypeError('admission_required');
  if (!CLAIM.test(sessionSigner?.claim) || typeof sessionSigner?.sign !== 'function' || !CLAIM.test(seller)
    || !isPublicEndpoint(publicEndpoint) || !job?.jobId || !job.listingPin || !job.agreementHash || !job.profile || typeof now !== 'function') throw new TypeError('seller_wire_configuration_invalid');
  if (!delegation?.payload || typeof delegation.signature !== 'string') throw new OperationError('seller_delegation_unavailable', 'a retained wallet-signed session delegation is required');
  const { binding, currentLocal } = admission;
  return Object.freeze({
    async request(path, body, text) {
      assertPurchaseActionsAdmitted();
      const jobId = body.transportIdentity?.jobId ?? body.jobId;
      if (jobId !== job.jobId) throw new OperationError('peer_job_mismatch', 'request differs from the retained purchase');
      const local = currentLocal(), localDigest = canonicalize(local);
      const retainedDelegation = JSON.parse(JSON.stringify(delegation));
      // The wire awaits its binding and proof checks before it calls sign, so admission, the connection
      // and the delegation's expiry (readback routes excepted) are read again in the same step as the signature.
      const signer = { claim: sessionSigner.claim, sign(bytes) {
        assertPurchaseActionsAdmitted();
        if (canonicalize(currentLocal()) !== localDigest) throw new OperationError('tp1_local_binding_changed', 'the actor connection changed before signing');
        if (!isReadRoute(path) && now() >= retainedDelegation.payload.expiresAt) throw new WireError('peer_delegation_expired', 500);
        return sessionSigner.sign(bytes);
      } };
      return signWireRequest({ binding, local, signer, delegation: retainedDelegation, endpointProof, publicEndpoint, path, jobId, text, seller,
        job: { listingPin: job.listingPin, agreementHash: job.agreementHash, profile: job.profile, ...(job.deadline === undefined ? {} : { deadline: job.deadline }) }, now: now() });
    },
    async verifyResponse(payload, { header, status, body }) {
      return verifyWireResponse(payload, { binding, local: currentLocal(), header, status, body, now: now() });
    },
  });
}
