import {
  bundleAddress,
  DacsError,
  type SellerBundleFinalizationReadProvider,
} from "@kynesyslabs/dacs";

import {
  DacsDemosBundlePublicationError,
  type DacsDemosBundlePublicationV1,
} from "./demosBundlePublication.js";

// Binding lookups that Demos could not answer, as opposed to a binding that
// was read and failed authentication.
export const TRANSIENT_BINDING_RESOLUTION_REASONS: ReadonlySet<string> = new Set([
  "bundle-binding-resolution-indeterminate",
  "bundle-binding-resolution-unavailable",
]);

/**
 * The reason code of a Demos bundle read that retry cannot repair (invalid
 * anchored content, receipt or authority), or undefined for an unanswered read.
 */
export function permanentDemosBundleReadReason(error: unknown): string | undefined {
  return error instanceof DacsDemosBundlePublicationError &&
      error.reasonCode !== "bundle-resolution-indeterminate"
    ? error.reasonCode : undefined;
}

/**
 * Seller-bundle and BundleBinding reads for the core verifier. Permanent Demos
 * failures become a DacsError, which the verifier reports as permanent; an
 * unanswered read stays `indeterminate` or a thrown read error, and is retried.
 */
export function createClassifiedDemosSellerBundleReads(
  publication: Readonly<DacsDemosBundlePublicationV1>,
  jobId: string,
): Pick<SellerBundleFinalizationReadProvider, "resolveSellerBundle" | "resolveBundleBinding"> {
  return {
    async resolveSellerBundle(logicalAddress: string) {
      if (logicalAddress !== bundleAddress(jobId, "seller")) {
        return { disposition: "absent" as const };
      }
      let anchored: Awaited<ReturnType<typeof publication.resolveRoleBundle>>;
      try {
        anchored = await publication.resolveRoleBundle("seller");
      } catch (error) {
        const reason = permanentDemosBundleReadReason(error);
        if (reason !== undefined) {
          throw new DacsError(`seller bundle readback is invalid: ${reason}`, { cause: error });
        }
        throw error;
      }
      return anchored === null ? { disposition: "absent" as const }
        : { disposition: "present" as const, anchored };
    },
    async resolveBundleBinding(logicalAddress: string, signer: string) {
      const resolved = await publication.resolveBundleBinding(logicalAddress, signer);
      if (resolved.disposition === "indeterminate" &&
          !TRANSIENT_BINDING_RESOLUTION_REASONS.has(resolved.reason)) {
        throw new DacsError(`BundleBinding readback is invalid: ${resolved.reason}`);
      }
      return resolved;
    },
  };
}
