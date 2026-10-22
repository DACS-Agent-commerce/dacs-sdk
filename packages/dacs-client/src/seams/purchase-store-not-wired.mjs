import { NotWiredError } from '../client-errors.mjs';
// D11 PurchaseStore. The host passes its synchronous, serializing, re-entrant
// transaction(db, fn) and its unique-constraint classifier; the factories
// that write purchase state refuse to build without both.
export function purchaseStore(store) {
  const transaction = store?.transaction;
  if (typeof transaction !== 'function' || typeof store?.isUniqueViolation !== 'function'
    || ['[object AsyncFunction]', '[object GeneratorFunction]', '[object AsyncGeneratorFunction]'].includes(Object.prototype.toString.call(transaction))) {
    throw new NotWiredError('purchase-store-not-wired');
  }
  const bound = transaction.bind(store);
  return Object.freeze({
    transaction(db, fn) {
      const result = bound(db, fn);
      if (result && typeof result.then === 'function') {
        // A synchronous-looking host wrapper may still return a Promise.
        // Drain its refusal before reporting the broken seam synchronously.
        Promise.resolve(result).catch(() => {});
        throw new NotWiredError('purchase-store-not-wired');
      }
      return result;
    },
    isUniqueViolation: store.isUniqueViolation.bind(store),
  });
}
