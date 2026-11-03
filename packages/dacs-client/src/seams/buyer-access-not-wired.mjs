import { NotWiredError } from '../client-errors.mjs';
// D1 cut only. D11 owns the integration contract; no runtime adapter here.
export const operatorBuyerAccessConfig = (..._args) => { throw new NotWiredError('buyer-access-not-wired'); };
