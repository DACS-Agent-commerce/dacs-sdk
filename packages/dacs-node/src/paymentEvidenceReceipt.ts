import type { SellerPaymentEvidenceHandshakeOptions } from "@kynesyslabs/dacs/commerce";
import { sameCanonicalClaimIdentity } from "@kynesyslabs/dacs/identity";
import type { DacsLiveRoleOperationContextV1 } from "./roleRuntime.js";

/** Default host receipt check, also exercised independently of the handshake. */
export function createSellerPaymentEvidenceReceiptVerifier(
  context: Readonly<DacsLiveRoleOperationContextV1>,
): SellerPaymentEvidenceHandshakeOptions["verifyAnchorReceipt"] {
  return async ({ request, completion }) => {
    // The core handshake already requires any reference signer to be the
    // evidence signer (DACS-2 §7.5.2(3)); this repeats it for direct callers.
    if (completion.evidenceRef.signer !== undefined &&
        !sameCanonicalClaimIdentity(
          completion.evidenceRef.signer, request.evidence.signature.signer,
        )) {
      return { disposition: "invalid" as const,
        reason: "seller payment-evidence issuer is unsupported" };
    }
    try {
      return await context.demos.adapter.verifyDemosAnchorReceipt(
        completion.anchorReceipt,
      ) === true
        ? { disposition: "valid" as const }
        : {
            disposition: "indeterminate" as const,
            reason: "seller payment-evidence receipt is unverified",
          };
    } catch {
      return {
        disposition: "indeterminate" as const,
        reason: "seller payment-evidence receipt verification failed",
      };
    }
  };
}
