import { NotWiredError } from '../client-errors.mjs';
// D1 cut only. D11 owns the integration contract; no runtime adapter here.
export const anchorWriteMessage = (..._args) => { throw new NotWiredError('seller-integration-not-wired'); };
export const signAnchorWrite = (..._args) => { throw new NotWiredError('seller-integration-not-wired'); };
export const verifyFixtureReceipt = (..._args) => { throw new NotWiredError('seller-integration-not-wired'); };
export const verifyFixtureRecord = (..._args) => { throw new NotWiredError('seller-integration-not-wired'); };
