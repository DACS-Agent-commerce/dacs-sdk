import { notAdmittedError, purchaseActionsAdmitted } from '../public-admission.mjs';

// CORE §11.1.2: purchase actions are admitted only while the one hold constant
// (purchase-admission-state.mjs) says so. No caller-provided profile record can
// change it; the public wrapper additionally binds every call to the testnet profile.
export function assertPurchaseActionsAdmitted() {
  if (!purchaseActionsAdmitted()) throw notAdmittedError();
}
