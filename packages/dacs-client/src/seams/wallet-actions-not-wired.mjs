import { NotWiredError } from '../client-errors.mjs';
// D11 WalletActions: the host's wallet-challenge purposes. The purchase
// service issues and consumes approval challenges under the host's own
// APPROVE_PURCHASE purpose and refuses to build without it.
export function walletPurposes(purposes) {
  if (typeof purposes?.APPROVE_PURCHASE !== 'string' || !purposes.APPROVE_PURCHASE.trim()) throw new NotWiredError('wallet-actions-not-wired');
  return Object.freeze({ APPROVE_PURCHASE: purposes.APPROVE_PURCHASE });
}
