import type { ListingDraft } from "../../src/artifacts/types.js";

/** Refusal shared with the live assertion and the real-adapter offline guard. */
export const VERSIONING_OVERWRITE_REFUSAL = /canonically confirmed create with different exact content or metadata/;

/** Build the shared versioning draft without payment or payload-verification capabilities. */
export function buildVersioningListing(
  listingId: string,
  sellerDid: string,
  nowMs: number,
): Omit<ListingDraft, "listingVersion"> {
  return {
    dacsVersion: "1" as const,
    listingId,
    seller: {
      identity: {
        bundleVersion: "1" as const,
        presentedBy: sellerDid,
        presentedAt: nowMs,
        claims: [{ ref: sellerDid }],
        presentation: {
          kind: "per-claim" as const,
          signatures: [{ ref: sellerDid, signature: "live-wallet-presentation" }],
        },
      },
      displayName: "SDK #46 live gate",
    },
    offering: {
      title: "SDK #46 live gate",
      description: "v1",
      category: "sdk.conformance",
      tags: ["versioning"],
      deliverable: { kind: "storage-program" },
    },
    buyerRequirement: { requirementVersion: "1" as const, required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" as const },
      { kind: "commit-agreement" as const },
      { kind: "deliver-storage-program" },
    ],
    pricing: {
      kind: "fixed" as const,
      price: { amount: "1", currency: "USDC" },
    },
    terms: { deadlineSecAfterCommit: 3_600 },
    validity: { notBefore: nowMs - 1_000 },
  };
}
