// The one local purchase account of a single-wallet host, named after the wallet.
import { OperationError } from '../client-errors.mjs';
import { purchaseStore } from '../seams/purchase-store-not-wired.mjs';
import { normalizeDemosAddress } from '../signatures.mjs';

const LOCAL_ISSUER = 'local-wallet';
const localAccounts = new WeakSet();

/** createLocalPurchaseAccount({db,store,wallet,now}) returns a frozen {accountId, listWallets} for the purchase service's `accounts`.
 * accountId is `local:` and the normalized wallet address; listWallets(accountId) returns [{address}] for that id and [] for any other.
 * At construction it writes one `accounts` row (issuer local-wallet, subject the address) unless that row already exists.
 * @throws {WalletFormatError} for a malformed wallet address, before any write.
 * @throws {OperationError} local_account_mismatch when a row with that id or that issuer and subject differs; nothing is written.
 * @throws {NotWiredError} when `store` is not the package's SQLite store.
 */
export function createLocalPurchaseAccount({ db, store, wallet, now = () => Date.now() }) {
  const address = normalizeDemosAddress(wallet);
  const accountId = `local:${address}`;
  const { transaction } = purchaseStore(store);
  const byId = db.prepare('SELECT id, auth_issuer, auth_subject FROM accounts WHERE id = ?');
  const bySubject = db.prepare('SELECT id FROM accounts WHERE auth_issuer = ? AND auth_subject = ?');
  const insert = db.prepare('INSERT INTO accounts (id, auth_issuer, auth_subject, display_name, created_at) VALUES (?, ?, ?, NULL, ?)');
  transaction(db, () => {
    const named = byId.get(accountId), claimed = bySubject.get(LOCAL_ISSUER, address);
    if ((named && (named.auth_issuer !== LOCAL_ISSUER || named.auth_subject !== address)) || (claimed && claimed.id !== accountId)) {
      throw new OperationError('local_account_mismatch', 'a saved account for this wallet does not match the local account');
    }
    if (!named) insert.run(accountId, LOCAL_ISSUER, address, new Date(now()).toISOString());
  });
  const account = Object.freeze({ accountId, listWallets: (id) => (id === accountId ? [{ address }] : []) });
  localAccounts.add(account);
  return account;
}

/** isLocalPurchaseAccount(candidate) returns whether `candidate` is an account createLocalPurchaseAccount returned in this copy of the package. It never throws. */
export const isLocalPurchaseAccount = (candidate) => localAccounts.has(candidate);
