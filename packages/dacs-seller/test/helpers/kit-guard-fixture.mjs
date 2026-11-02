// The unshipped fixture loader for the kit's operation guard (K11). The seller
// test runner preloads it into every test process (`--import`); importing it
// registers the hook for the checkout's guard module. A test that loads another
// copy of the guard (for example the installed package's) calls
// registerKitGuardFixture with that copy's URL.
import { register } from 'node:module';

/** URL of the checkout's guard module, the one the hook admits by default. */
export const CHECKOUT_GUARD_URL = new URL('../../src/kit-operation-guard.mjs', import.meta.url).href;

/** Registers the hook for the checkout's guard module and for each URL in `extraGuardUrls`. */
export function registerKitGuardFixture(extraGuardUrls = []) {
  register('./kit-guard-fixture-hook.mjs', import.meta.url, { data: { guardUrls: [CHECKOUT_GUARD_URL, ...extraGuardUrls] } });
}

registerKitGuardFixture();
