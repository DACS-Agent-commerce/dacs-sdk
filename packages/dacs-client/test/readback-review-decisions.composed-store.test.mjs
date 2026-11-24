// The readback review decisions, on the purchase store an SDK buyer composes.
import { runOnComposedStore } from './helpers/composed-store-entry.mjs';

await runOnComposedStore(new URL('./readback-review-decisions.test.mjs', import.meta.url));
