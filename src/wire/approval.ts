// Approved on 2026-10-20.
// SHA-256 of the canonical TP1_APPROVED_IDENTITY_RECORD in profile.ts:
// recordId and pinVersion dacs-demos-testnet-identity/2026-10-21;
// sourceKind confirmed-block-one-predecessor, including its documented fallback.
// The 2026-10-15 record (chain 83082fbb…) is no longer listed, so it is refused.
// Approval is held only in SDK source. No caller can extend this frozen list.
// Synthetic tests replace this module (test/wire/testApproval.ts).
export const TP1_APPROVED_IDENTITY_RECORD_DIGESTS: readonly string[] = Object.freeze([
  "4118a9181f5d6e475c446d44eebeb9fde703eba3fe4fde37ddfee40369f48066",
]);

/**
 * Chain identities refused even if a record naming them were approved, for
 * example a known mainnet identity. Empty until a dated approval names any; a caller may
 * add refusals (BindTp1Options.refusedChainIdentities) but never remove these.
 */
export const TP1_REFUSED_CHAIN_IDENTITIES: readonly string[] = Object.freeze([]);
