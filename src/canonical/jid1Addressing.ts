import { requireCanonicalJobId } from "../negotiate/jobId.js";
import { attestationAddress, paymentEvidenceAddress, ratingAddress, bundleAddress } from "./addressing.js";

/** CORE §B.1 JID-3 current-profile helper; legacy address helpers remain unchanged. */
export function jid1AttestationAddress(jobId: string, scheme: string, identifier: string, recipeVersion: number): string {
  requireCanonicalJobId(jobId, "attestation address jobId");
  return attestationAddress(jobId, scheme, identifier, recipeVersion);
}

/** CORE §B.1 JID-3: validate before assembling the PC-2 address. */
export function jid1PaymentEvidenceAddress(jobId: string, railId: string, phaseIndex: number, resolved = false): string {
  requireCanonicalJobId(jobId, "payment evidence address jobId");
  return paymentEvidenceAddress(jobId, railId, phaseIndex, resolved);
}

/** CORE §B.1 JID-3: validate before assembling a rating address. */
export function jid1RatingAddress(jobId: string, rater: string): string {
  requireCanonicalJobId(jobId, "rating address jobId");
  return ratingAddress(jobId, rater);
}

/** CORE §B.1 JID-3: validate before hashing the role-specific bundle preimage. */
export function jid1BundleAddress(jobId: string, role: "buyer" | "seller" | "orchestrator"): string {
  requireCanonicalJobId(jobId, "bundle address jobId");
  return bundleAddress(jobId, role);
}
