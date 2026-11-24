// The Demos node endpoint rule, kept free of imports so a caller that only
// judges an endpoint loads nothing else.

/** The chain identity of the approved Demos testnet identity record. */
export const TP1_APPROVED_CHAIN_IDENTITY = "d59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc";

/**
 * The one rule for a Demos node endpoint: returns `endpoint` when it is a
 * canonical root URL, exactly its origin followed by `/` (so path exactly `/`,
 * no username, password, query or fragment, not even an empty `?` or `#`, and
 * the spelling the URL parser gives), otherwise null. The scheme is
 * `https:`, or `http:` only when `chainIdentity` is exactly the chain identity
 * of the approved testnet identity record: public Demos testnet nodes serve
 * their RPC over plain http. Any other or missing chain identity means https
 * only. The chain identity is the caller's pinned one, never one a node
 * reported, and no hostname, port or label changes the rule.
 */
export function canonicalNodeEndpoint(endpoint: unknown, { chainIdentity }: { chainIdentity?: unknown } = {}): string | null {
  if (typeof endpoint !== "string") return null;
  let url: URL;
  try { url = new URL(endpoint); } catch { return null; }
  const scheme = url.protocol === "https:" || (url.protocol === "http:" && chainIdentity === TP1_APPROVED_CHAIN_IDENTITY);
  return scheme && endpoint === `${url.origin}/` ? endpoint : null;
}
