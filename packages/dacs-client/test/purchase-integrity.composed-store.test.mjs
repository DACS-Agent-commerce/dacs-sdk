// The purchase integrity regressions, on the purchase store an SDK buyer composes.
import { runOnComposedStore } from './helpers/composed-store-entry.mjs';

await runOnComposedStore(new URL('./purchase-integrity.test.mjs', import.meta.url));
