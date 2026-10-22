import { NotWiredError } from '../client-errors.mjs';
// D11 PurchaseStore. The host passes its synchronous, serializing, re-entrant
// transaction(db, fn) and its unique-constraint classifier; the factories
// that write purchase state refuse to build without both.
export function purchaseStore(store) {
  if (typeof store?.transaction !== 'function' || typeof store?.isUniqueViolation !== 'function') throw new NotWiredError('purchase-store-not-wired');
  return Object.freeze({ transaction: store.transaction.bind(store), isUniqueViolation: store.isUniqueViolation.bind(store) });
}
