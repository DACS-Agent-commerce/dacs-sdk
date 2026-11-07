// Preload for the kit-client harness only (never shipped, never a package option or environment switch).
// It admits the client's one purchase hold and the kit's operation guard for this process by serving their own sources with the
// one constant changed; it replaces no action and no assertion, and fails if either declaration has moved.
// module.register works at the client's 22.13 floor; registerHooks only exists from 22.15.
import { register } from 'node:module';
import '../../packages/dacs-seller/test/helpers/kit-guard-fixture.mjs';

const ADMISSION_STATE_URL = new URL('../../packages/dacs-client/src/dacs/purchase-admission-state.mjs', import.meta.url).href;

register('./purchase-admission-hook.mjs', import.meta.url, { data: { url: ADMISSION_STATE_URL } });
