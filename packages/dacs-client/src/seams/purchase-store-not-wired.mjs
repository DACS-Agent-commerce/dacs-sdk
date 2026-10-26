import { NotWiredError } from '../client-errors.mjs';
// D1 cut only. D11 owns the integration contract; no runtime adapter here.
export const isUniqueViolation = (..._args) => { throw new NotWiredError('purchase-store-not-wired'); };
export const transaction = (..._args) => { throw new NotWiredError('purchase-store-not-wired'); };
