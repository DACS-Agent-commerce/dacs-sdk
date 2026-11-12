// One saved purchase read back through a given chain reader by the client's
// purchase service, and an in-process node holding that purchase's payment.
import { openDatabase, transaction, isUniqueViolation } from './purchase-integrity-database.mjs';
import { createOperationStore } from './purchase-integrity-operations.mjs';
import { createPurchaseService } from '../../src/purchases.mjs';
import { createCoordinateStore } from '../../src/dacs/wallet-transactions.mjs';

export const WALLET = '0x' + 'a'.repeat(64), PAYEE = '0x' + '7'.repeat(64), HASH = '1'.repeat(64), AMOUNT = '2500000000';
const ACCOUNT_ID = 'TEST-buyer';
const BLOCK = 10, NONCE = 7, BLOCK_SECONDS = 1_900_000_000;
const NATIVE_TERMS = { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment',
  sellerAgreementProjection: 'public-signed-create' };

/** The confirmed transaction body a node serves for this purchase's payment `hash`, as node2 shapes it. */
export const paymentBody = (hash = HASH, { payer = WALLET, payee = PAYEE, amountOs = AMOUNT, nonce = NONCE, blockNumber = BLOCK } = {}) => ({ hash, status: 'confirmed', blockNumber,
  content: { type: 'native', from: payer, from_ed25519_address: payer, to: payee, amount: Number(amountOs), nonce: String(nonce), timestamp: String(BLOCK_SECONDS * 1000),
    data: ['native', { nativeOperation: 'send', args: [payee, amountOs] }] } });

/** A fakeNode `answer` for a node on which `body` is included and executed, the payer's nonce is `nonce` and its history holds `history`. */
export function paymentAnswers({ body = paymentBody(), state = 'included', nonce = NONCE, history = [] } = {}) {
  return ({ message, data }) => {
    if (message === 'getTransactionStatus') return { state, blockNumber: body.blockNumber };
    if (message === 'getTxByHash') return body;
    if (message === 'getBlockByNumber' && data.blockNumber === body.blockNumber) {
      return { number: body.blockNumber, status: 'confirmed', content: { ordered_transactions: [body.hash], timestamp: BLOCK_SECONDS } };
    }
    if (message === 'getAddressNonce') return nonce;
    if (message === 'getTransactionHistory') return history;
    return undefined;
  };
}

/**
 * A purchase service over `chain` with one saved purchase. `status` is its
 * saved status; `reportedTxHash` (null for none) the hash reported for it;
 * `native` gives it the native Agreement payment terms. The other options
 * override the payer, payee, amount, chain identity and nonce slot.
 */
export function purchaseWorld(t, { chain, chainIdentity, native = false, status = 'broadcast_reported', reportedTxHash = HASH, protocol,
  wallet = WALLET, payee = PAYEE, amountOs = AMOUNT, expectedNonce = NONCE }) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8) }), coordinates = createCoordinateStore({ db });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run(ACCOUNT_ID, 'TEST', ACCOUNT_ID, new Date().toISOString());
  const domain = { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity };
  const terms = { buyer: { wallet }, seller: { payee, claim: 'TEST-seller' }, price: { amountOs, amount: '2.5' }, listing: { listingId: 'TEST-listing', version: 1, contentHash: chainIdentity },
    network: 'testnet', rail: 'demos-native:DEM', domain, ...(native ? { protocol: NATIVE_TERMS } : {}) };
  const { operation } = ops.createIdempotent({ accountId: ACCOUNT_ID, kind: 'purchase', idempotencyKey: 'TEST-once', request: {}, status, terms, termsHash: chainIdentity,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  coordinates.save({ operationId: operation.id, kind: 'native-dem-transfer', network: 'testnet', from: wallet, nonceFence: expectedNonce - 1, expectedNonce, target: payee, amountOs,
    payload: { content: { nonce: expectedNonce } } });
  if (reportedTxHash) coordinates.reportHash(operation.id, reportedTxHash);
  const service = createPurchaseService({ db, ops, coordinates, config: {}, chain, protocol, store: { transaction, isUniqueViolation }, purposes: { APPROVE_PURCHASE: 'approve-purchase' } });
  return {
    service,
    verify: () => service.verifyDeal({ accountId: ACCOUNT_ID, operationId: operation.id }),
    cancel: () => service.cancel({ accountId: ACCOUNT_ID, operationId: operation.id }),
    state: () => ({ operation: ops.get(ACCOUNT_ID, operation.id), coordinate: coordinates.get(operation.id),
      consumed: db.prepare('SELECT count(*) AS n FROM wallet_nonce_consumptions').get().n }),
  };
}
