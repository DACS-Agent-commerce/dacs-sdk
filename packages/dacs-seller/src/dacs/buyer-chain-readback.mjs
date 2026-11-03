// Run-time port of http-mcp/src/dacs/buyer-chain-readback.mjs at DACS-Agent-commerce/frontend
// 15fdf23: lines 197-199.
// Left out: the buyer readback; only the answer field the seller writes.
// Seller answers offer original signed CREATE bytes under this field, keyed by
// logical address. The buyer prefers bytes it has already authenticated.
export const PUBLIC_SIGNED_CREATES = 'publicSignedCreates';
