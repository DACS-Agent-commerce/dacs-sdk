import { NotWiredError } from '../client-errors.mjs';
/** D11 WalletActions: the host's wallet-challenge purposes. The purchase
 * service issues and consumes approval challenges under the host's own
 * APPROVE_PURCHASE purpose and refuses to build without it.
 * Returns a frozen `{ APPROVE_PURCHASE }`; other purposes are dropped.
 * @throws {NotWiredError} when APPROVE_PURCHASE is missing, not a string or blank.
 */
export function walletPurposes(purposes) {
  if (typeof purposes?.APPROVE_PURCHASE !== 'string' || !purposes.APPROVE_PURCHASE.trim()) throw new NotWiredError('wallet-actions-not-wired');
  return Object.freeze({ APPROVE_PURCHASE: purposes.APPROVE_PURCHASE });
}
