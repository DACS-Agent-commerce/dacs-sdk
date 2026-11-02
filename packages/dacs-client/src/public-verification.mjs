import { createListingVerifier as internalVerifier } from './dacs/verification.mjs';
import { assertPurchaseActionsAdmitted } from './dacs/action-admission.mjs';
export { NotConfiguredError } from './dacs/verification.mjs';

// CORE §11.1.2(3): current-profile resolution/comparison requires trusted
// session and participant admission. This candidate has no such mechanism.
export function createListingVerifier(options) {
  const verifier = internalVerifier(options);
  return Object.freeze({ async verify(request) {
    assertPurchaseActionsAdmitted();
    return verifier.verify(request);
  } });
}
