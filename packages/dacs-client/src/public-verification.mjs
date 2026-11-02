import { createListingVerifier as internalVerifier } from './dacs/verification.mjs';
import { admitPublicFactory } from './public-admission.mjs';
export { NotConfiguredError } from './dacs/verification.mjs';

// CORE §11.1.2(3): current-profile resolution/comparison requires trusted
// session and participant admission. verify is an active method: it rejects
// while the hold is held and otherwise passes the wrapper's per-call checks.
export const createListingVerifier = admitPublicFactory(internalVerifier, { purchase: true });
