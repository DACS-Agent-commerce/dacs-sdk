import {
  bundleAddress,
  DacsError,
  type BundleBinding,
  type SellerBundleFinalizationReadProvider,
} from "@kynesyslabs/dacs";

import {
  DacsDemosBundlePublicationError,
  type DacsDemosBundlePublicationV1,
} from "./demosBundlePublication.js";

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
 * Seller-bundle and BundleBinding reads for the core verifier, run by a
 * consumer of the seller's copy. The copy is found only through the seller's
 * discovered signed BundleBindings and read at its exact native address
 * (DACS-5 BB-5..BB-7); its storage-program name is never a resolution key. A
 * side that no binding resolves, whose candidates fail validation or that
 * equivocates is `indeterminate`, never `absent` (BB-7, BB-8).
 */
export function createClassifiedDemosSellerBundleReads(
  publication: Readonly<DacsDemosBundlePublicationV1>,
  jobId: string,
): Pick<SellerBundleFinalizationReadProvider, "resolveSellerBundle" | "resolveBundleBinding"> {
  return {
    async resolveSellerBundle(logicalAddress: string, carried?: Readonly<BundleBinding>) {
      if (logicalAddress !== bundleAddress(jobId, "seller")) {
        throw new DacsError("seller bundle reads serve only this job's seller bundle");
      }
      const bound = await publication.resolveBoundRoleBundle("seller", carried === undefined ? [] : [carried]);
      return bound.disposition === "present"
        ? { disposition: "present" as const, anchored: bound.anchored }
        : { disposition: "indeterminate" as const, reason: bound.reason };
    },
    resolveBundleBinding: (logicalAddress: string, signer: string,
      carried?: Readonly<BundleBinding>) =>
      publication.resolveBundleBinding(logicalAddress, signer, carried),
  };
}
