/**
 * Current-profile (JID-1) address helpers.
 *
 * Spec: DACS-Standard `next` at df7bc202ebdc179a59d61a8221072f33f482b933, spec/CORE.md §B.1,
 * "Canonical job identifier (rules JID-1..JID-4)". JID-1 defines the canonical `jobId` wire
 * grammar (hence the `jid1*` names); JID-3 requires validating a JID-1 `jobId` before any
 * logical address is assembled or job-specific hash is computed. These are format helpers only:
 * they validate and then delegate to the existing builders. They do not parse addresses.
 */
import { DacsError } from "../errors.js";
import { requireCanonicalJobId } from "../negotiate/jobId.js";
import { attestationAddress, paymentEvidenceAddress, ratingAddress, bundleAddress } from "./addressing.js";

/** JID-3 (CORE §B.1, Standard next): validate the JID-1 jobId, then assemble the attestation address. Legacy helpers are unchanged. */
export function jid1AttestationAddress(jobId: string, scheme: string, identifier: string, recipeVersion: number): string {
  requireCanonicalJobId(jobId, "attestation address jobId");
  return attestationAddress(jobId, scheme, identifier, recipeVersion);
}

/** JID-3 (CORE §B.1, Standard next): validate the JID-1 jobId, then assemble the PC-2 address. */
export function jid1PaymentEvidenceAddress(jobId: string, railId: string, phaseIndex: number, resolved = false): string {
  requireCanonicalJobId(jobId, "payment evidence address jobId");
  return paymentEvidenceAddress(jobId, railId, phaseIndex, resolved);
}

/** JID-3 (CORE §B.1, Standard next): validate the JID-1 jobId, then assemble the rating address. */
export function jid1RatingAddress(jobId: string, rater: string): string {
  requireCanonicalJobId(jobId, "rating address jobId");
  return ratingAddress(jobId, rater);
}

/** JID-3 (CORE §B.1, Standard next): validate the JID-1 jobId, then hash the role-specific bundle preimage. */
export function jid1BundleAddress(jobId: string, role: "buyer" | "seller" | "orchestrator"): string {
  requireCanonicalJobId(jobId, "bundle address jobId");
  if (role !== "buyer" && role !== "seller" && role !== "orchestrator") {
    throw new DacsError("bundle address role must be buyer, seller, or orchestrator");
  }
  return bundleAddress(jobId, role);
}
