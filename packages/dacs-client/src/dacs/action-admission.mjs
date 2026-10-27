import { OperationError } from '../client-errors.mjs';

// CORE §11.1.2: the corrective candidate has no coordinated live release or
// authenticated session/participant tuple. No caller-provided profile record
// can lift this hold. A future reviewed release must implement that authority
// before replacing this refusal.
export function assertPurchaseActionsAdmitted() {
  throw new OperationError('profile_not_admitted', 'Purchase actions are held: no coordinated Standard release and authenticated session/participant profile tuple is admitted.');
}
