// A transport store built the way the host builds it: with its purchase capacity, which binds the cleanup the store's terminal-state
// adapter needs (a store without one refuses every terminal observation, so challenge issuance and the old reserve path would throw).
// For tests that exercise the store alone; tests that build their own capacity use the store from the source module.
import { createPurchaseCapacity } from '../../src/dacs/seller-purchase-capacity.mjs';
import { createSellerTransportStore as createUnboundStore, sellerStoreInternals } from '../../src/dacs/seller-transport-auth.mjs';

/** Binds a purchase capacity to `store` on the clock `now`, kept as `store.boundCapacity` beside `store.boundStore`, and returns the store. */
export function bindPurchaseCapacity(store, now = () => Date.now()) {
  const capacity = createPurchaseCapacity({ store, now, sessionState: sellerStoreInternals(store).sessionState });
  return Object.defineProperties(store, { boundCapacity: { value: capacity }, boundStore: { value: store } });
}

/** The `{ store, capacity }` pair `bindPurchaseCapacity` bound, also through a proxy of the store: the capacity is built on the raw store. */
export const boundPurchaseOf = (store) => ({ store: store.boundStore, capacity: store.boundCapacity });

/** `createSellerTransportStore(options)` with the purchase capacity bound; the options are the store's own. */
export function createSellerTransportStore(options) {
  return bindPurchaseCapacity(createUnboundStore(options), options.now);
}

/** Returns the purchase capacity bound by this fixture. */
export const purchaseCapacityOf = store => boundPurchaseOf(store).capacity;
