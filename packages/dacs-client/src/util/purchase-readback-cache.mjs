import { canonicalize, isAnchorReceipt, sha256Hex } from '@kynesyslabs/dacs';

const included = (receipt) => isAnchorReceipt(receipt) && receipt.observationDisposition === 'established'
  && ['included', 'finalized'].includes(receipt.state) && /^[0-9a-f]{64}$/.test(receipt.transactionRef.value)
  && /^[0-9a-f]{64}$/.test(receipt.blockRef?.id);
export const sameIncludedFact = (left, right) => included(left) && included(right)
  && left.transactionRef.value === right.transactionRef.value && left.contentHash === right.contentHash
  && canonicalize(left.blockRef) === canonicalize(right.blockRef) && left.nativeAddress === right.nativeAddress
  && left.logicalAddress === right.logicalAddress && left.writer === right.writer;
const ended = (status, stage) => ['cancelled', 'expired', 'failed', 'completed', 'agreement_rejected', 'payment_failed', 'payment_mismatch', 'terms_changed', 'superseded'].includes(status)
  || ['delivery-ready', 'delivered', 'completed', 'claim-rejected', 'evidence-rejected', 'delivery-rejected', 'bundle-rejected'].includes(stage);

// Only the existing verified Agreement reader supplies values. The full
// caller scope and receipt join the exact inclusion coordinates in the key.
// Demos signs JSON.stringify bytes, so the scope's exact bytes are keyed too:
// canonicalize alone would merge byte-distinct signed projections.
export function createPurchaseReadbackCache({ loadPurchase, limit = 256 } = {}) {
  if (typeof loadPurchase !== 'function' || !Number.isSafeInteger(limit) || limit < 1) throw new TypeError('purchase readbacks require a lifecycle reader and positive bound');
  const purchases = new Map();
  let closed = false, ends = 0;
  function active(id) {
    const operation = loadPurchase(id);
    if (!operation || operation.kind !== 'purchase' || ended(operation.status, operation.state?.protocol?.stage)) { purchases.delete(id); return false; }
    return true;
  }
  return {
    // `checkCurrent(hit)` runs on every hit. It returns nothing when the hit
    // is still current, or a non-present answer that evicts it and is returned.
    async read({ purchaseId, receipt, scope }, readVerified, checkCurrent = async () => {}) {
      if (closed || typeof purchaseId !== 'string' || !purchaseId || !included(receipt) || !active(purchaseId)) return readVerified();
      const expected = structuredClone(receipt);
      const key = sha256Hex(canonicalize({ receipt: expected, scope, scopeBytes: sha256Hex(JSON.stringify(scope)) }));
      const cached = purchases.get(purchaseId)?.get(key);
      if (cached) {
        const current = await checkCurrent(structuredClone(cached));
        const still = purchases.get(purchaseId)?.get(key) === cached;
        if (current !== undefined) { if (still) purchases.get(purchaseId).delete(key); return current; }
        // Eviction, shutdown or a purchase end during the check: read fresh.
        if (!still || !active(purchaseId)) return readVerified();
        return structuredClone(cached);
      }
      const seen = ends;
      const result = await readVerified();
      // A purchase ending or cache closing during this read cannot repopulate it.
      if (!closed && ends === seen && active(purchaseId)
          && result?.disposition === 'present' && sameIncludedFact(expected, result.native?.receipt)
          && result.native?.txRef?.writeTxHash === expected.transactionRef.value) {
        let bucket = purchases.get(purchaseId);
        if (!bucket) {
          if (purchases.size >= limit) purchases.delete(purchases.keys().next().value);
          bucket = new Map(); purchases.set(purchaseId, bucket);
        }
        if (bucket.size >= 16) bucket.delete(bucket.keys().next().value);
        bucket.set(key, structuredClone(result));
      }
      return result;
    },
    stageChange({ purchaseId, status, stage }) { if (ended(status, stage)) { ends += 1; purchases.delete(purchaseId); } },
    close() { closed = true; purchases.clear(); },
  };
}
