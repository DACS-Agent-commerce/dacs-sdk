// Offline domain fixtures using the shipped transaction and coordinate stores.
import { openDatabase } from './purchase-integrity-database.mjs';
import { createOperationStore } from './purchase-integrity-operations.mjs';
import { createCoordinateStore } from '../../src/dacs/wallet-transactions.mjs';
import { createSqlitePurchaseStore } from '../../src/seams/purchase-store-not-wired.mjs';
import { createPurchaseService } from '../../src/purchases.mjs';
import { createDeliveryDeadlineWatch } from '../../src/dacs/delivery-deadline-watch.mjs';

export const ACCOUNT = 'TEST-buyer', HASH = '1'.repeat(64), CHAIN = 'f'.repeat(64);
export const WALLET = '0x' + 'a'.repeat(64), PAYEE = '0x' + '7'.repeat(64), AMOUNT = '2500000000';
const now = () => 1700000000000;
export const ABSENT = { notPresent: true, delivery: { status: 'absent' }, checkedAt: now() };

export function openWorld(path, { failResolution = false } = {}) {
  const db = openDatabase(path), store = createSqlitePurchaseStore();
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8), now });
  const coordinates = createCoordinateStore({ db, now });
  const terms = { buyer: { wallet: WALLET }, seller: { payee: PAYEE, claim: 'TEST-seller' },
    price: { amountOs: AMOUNT, amount: '2.5' }, network: 'testnet', rail: 'demos-native:DEM',
    listing: { listingId: 'TEST-listing', version: 1, contentHash: CHAIN },
    domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN } };
  const chain = { network: 'testnet', pinnedIdentity: CHAIN, rpcOrigin: 'https://rpc.invalid', evidenceMode: 'TEST-offline',
    networkIdentity: async () => ({ identity: CHAIN, mode: 'public-chain-read' }),
    observeTransfer: async hash => ({ status: 'included', txHash: hash, payer: WALLET, payee: PAYEE, amountOs: AMOUNT, blockNumber: 10 }),
    getTransaction: async hash => ({ hash, status: 'confirmed', blockNumber: 10, content: { from: WALLET, nonce: 7 } }) };
  const resolutionCalls = [];
  const protocol = { nativePaymentSuperseded: async op => {
    resolutionCalls.push(op.id);
    if (failResolution) throw new Error('TEST-source-reconciliation-pending');
    return true;
  } };
  const purchases = createPurchaseService({ db, ops, coordinates, config: {}, chain, store, now, protocol,
    purposes: { APPROVE_PURCHASE: 'TEST-approve-purchase' } });
  const watch = createDeliveryDeadlineWatch({ db, ops, coordinates, store, enabled: true, now });
  const operation = key => ops.findByKey(ACCOUNT, 'purchase', key);
  const create = (key, status, extra = {}) => ops.createIdempotent({ accountId: ACCOUNT, kind: 'purchase',
    idempotencyKey: key, request: { key }, status, terms, termsHash: CHAIN,
    expiresAt: new Date(now() + 3600000).toISOString(), ...extra }).operation;
  const reserve = op => coordinates.save({ operationId: op.id, kind: 'native-dem-transfer', network: 'testnet',
    from: WALLET, nonceFence: 6, expectedNonce: 7, target: PAYEE, amountOs: AMOUNT, payload: { content: { nonce: 7 } } });
  return { db, ops, coordinates, operation, resolutionCalls,
    seed(kind) {
      db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)')
        .run(ACCOUNT, 'TEST', ACCOUNT, new Date(now()).toISOString());
      if (kind !== 'delivery') {
        const extra = kind.startsWith('native-') ? { terms: { ...terms, protocol: {
          profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',
          nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment',
          sellerAgreementProjection: 'public-signed-create',
        } } } : {};
        const op = create('payment', 'broadcast_reported', extra);
        reserve(op);
        coordinates.reportHash(op.id, HASH);
        reserve(create('replacement', 'payment_handoff', extra));
      } else {
        const deadline = now() - 120001;
        const op = create('delivery', 'settled_verified', { terms: { ...terms, protocol: {} }, state: { protocol: {
          stage: 'payment-evidenced', commitment: { verifiedAt: new Date(now()).toISOString() },
          agreement: { hash: CHAIN, ref: { contentHash: CHAIN }, terms: { seller: 'TEST-seller', deadline },
            artifact: { terms: { deadline }, parties: [{ role: 'seller', primaryClaim: 'TEST-seller' }] } },
        } } });
        reserve(op);
        coordinates.reportHash(op.id, HASH);
        coordinates.recordObservation(op.id, { txHash: HASH, status: 'included' }, true);
      }
    },
    verify: () => purchases.verifyDeal({ accountId: ACCOUNT, operationId: operation('payment').id }),
    observe: () => watch.observe(operation('delivery'), ABSENT),
    snapshot(kind) {
      const op = operation(kind === 'delivery' ? 'delivery' : 'payment');
      const replacement = operation('replacement');
      return { operation: op, coordinate: coordinates.get(op.id), events: ops.history(op.id),
        consumptions: db.prepare('SELECT * FROM wallet_nonce_consumptions ORDER BY operation_id').all(),
        ...(replacement ? { replacement, replacementCoordinate: coordinates.get(replacement.id), replacementEvents: ops.history(replacement.id) } : {}) };
    },
  };
}

// Target each post-settlement transaction, including its pending-event sibling.
export function nativeMarker(kind) {
  if (!kind.startsWith('native-') || kind === 'native-settlement') return null;
  const supersession = kind.startsWith('native-supersession');
  return { events: supersession ? 'replacementEvents' : 'events',
    type: `native_${supersession ? 'supersession' : 'nonce'}_${kind.endsWith('-pending') ? 'pending' : 'resolved'}` };
}
