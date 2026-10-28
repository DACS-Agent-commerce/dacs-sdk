// Run-time port of http-mcp/src/util/immutable-readbacks.mjs at DACS-Agent-commerce/frontend
// 15fdf23: the whole file.
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';

// Short-lived, bounded, in-memory reuse of verified immutable readbacks.
// Keys are the purchase (or job), the locator, the verified content hash and a
// digest of the whole verification scope, so different bytes never share an
// entry. Entries expire after `ttlMs`; callers on the payment path read fresh
// instead and evict an entry whose fresh read no longer verifies. Nothing is
// persisted, and a cached proof never authorizes a write or a resend.
export const IMMUTABLE_READBACK_TTL_MS = 60000;

export function createImmutableReadbacks({ limit = 256, ttlMs = IMMUTABLE_READBACK_TTL_MS, now = () => Date.now() } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('immutable readback reuse needs a positive TTL');
  const entries = new Map();
  const key = ({ purchaseId, locator, contentHash, scope }) => canonicalize([purchaseId ?? null, locator, contentHash, sha256Hex(canonicalize(scope))]);
  return {
    get(input) {
      const id = key(input), entry = entries.get(id);
      if (!entry) return null;
      if (now() - entry.at >= ttlMs) { entries.delete(id); return null; }
      return structuredClone(entry.value);
    },
    put(input, value) {
      const id = key(input);
      entries.delete(id);
      if (entries.size >= limit) entries.delete(entries.keys().next().value);
      entries.set(id, { value: structuredClone(value), at: now() });
    },
    delete(input) { entries.delete(key(input)); },
  };
}
