// Run-time port of http-mcp/public/portal/seller-session-limits.mjs at
// DACS-Agent-commerce/frontend 15fdf23: the whole file.
export const SELLER_SESSION_MAX_LIFETIME_MS=24*60*60*1000;
export function assertSellerSessionLifetime(lifetimeMs){
  if(!Number.isSafeInteger(lifetimeMs)||lifetimeMs<=0||lifetimeMs>SELLER_SESSION_MAX_LIFETIME_MS)throw new RangeError('seller session lifetime must be positive and at most 24 hours');
}
