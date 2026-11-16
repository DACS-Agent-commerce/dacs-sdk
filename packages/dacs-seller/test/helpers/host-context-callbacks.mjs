// Unshipped fixture: the callbacks the seller host takes from a context capability besides `resolveBuyer`, as no-ops pinned to the fixture seller.
import { seller } from './protocol-fixture.mjs';

export const HOST_CONTEXT_CALLBACKS = Object.freeze({ recoverBuyer: async () => null, resumableBuyer: async () => null, bindRetainedScope: () => ({ sellerBundlePresentedBy: seller.claim }) });
