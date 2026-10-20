import { NotWiredError } from '../client-errors.mjs';
// D1 cut only. D11 owns the integration contract; no runtime adapter here.
export const PURPOSES = new Proxy({}, {get(){throw new NotWiredError('WalletActions');}});
export const nativePayloadDigest = (..._args) => { throw new NotWiredError('wallet-actions-not-wired'); };
export const storageConfirmationShapeMatches = (..._args) => { throw new NotWiredError('wallet-actions-not-wired'); };
