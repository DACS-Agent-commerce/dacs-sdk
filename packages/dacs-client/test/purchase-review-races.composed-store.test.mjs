// The purchase review races, on the purchase store an SDK buyer composes.
import { runOnComposedStore } from './helpers/composed-store-entry.mjs';

await runOnComposedStore(new URL('./purchase-review-races.test.mjs', import.meta.url));
