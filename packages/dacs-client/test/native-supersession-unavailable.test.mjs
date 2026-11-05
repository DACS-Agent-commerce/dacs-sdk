import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';

const ACCOUNT = 'TEST-buyer', HASH = '1'.repeat(64), CHAIN = 'f'.repeat(64);
const WALLET = '0x' + 'a'.repeat(64), PAYEE = '0x' + '7'.repeat(64);
const now = () => 1700000000000;
const terms = { buyer: { wallet: WALLET }, seller: { payee: PAYEE }, price: { amountOs: '2500000000', amount: '2.5' },
  network: 'testnet', rail: 'demos-native:DEM', listing: { listingId: 'TEST-listing', version: 1, contentHash: CHAIN },
  domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN },
  protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1',
    nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment', sellerAgreementProjection: 'public-signed-create' } };

function openFixture(path) {
  const db = openDatabase(path);
  db.exec('PRAGMA synchronous = EXTRA');
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8), now });
  const coordinates = createCoordinateStore({ db, now });
  return { db, ops, coordinates, snapshot: () => JSON.stringify(['operations', 'operation_events', 'write_coordinates', 'wallet_nonce_consumptions']
    .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())) };
}

for (const kind of ['supersession', 'nonce']) {
  test(`unavailable native ${kind} has no source calls, writes or pending events after repeat and reopen`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'dacs-native-unavailable-')), path = join(dir, 'state.sqlite');
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let w = openFixture(path), calls = 0;
    try {
      w.db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)')
        .run(ACCOUNT, 'TEST', ACCOUNT, new Date(now()).toISOString());
      const create = (key, status) => {
        const operation = w.ops.createIdempotent({ accountId: ACCOUNT, kind: 'purchase', idempotencyKey: key,
          request: { key }, status, terms, termsHash: CHAIN, expiresAt: new Date(now() + 3600000).toISOString() }).operation;
        w.coordinates.save({ operationId: operation.id, kind: 'native-dem-transfer', network: 'testnet', from: WALLET,
          nonceFence: 6, expectedNonce: 7, target: PAYEE, amountOs: terms.price.amountOs, payload: {} });
        return operation;
      };
      const owner = create('owner', 'settled_verified');
      w.coordinates.reportHash(owner.id, HASH);
      w.coordinates.recordObservation(owner.id, { txHash: HASH, slotConsumed: true }, true);
      const target = kind === 'supersession' ? create('replacement', 'superseded') : owner;
      if (kind === 'supersession') w.coordinates.recordObservation(target.id, { txHash: HASH, supersededBy: owner.id }, false, null);
      const before = w.snapshot();
      for (const reopen of [false, false, true]) {
        if (reopen) { w.db.close(); w = openFixture(path); }
        const purchases = createPurchaseService({ ...w, store: createSqlitePurchaseStore(), config: {}, now,
          purposes: { APPROVE_PURCHASE: 'TEST' },
          chain: { networkIdentity: async () => { assert.fail('unexpected chain read'); } },
          protocol: { nativePaymentReadbackAvailable: false, nativePaymentSuperseded: async () => { calls++; return true; } } });
        const result = await purchases.verifyDeal({ accountId: ACCOUNT, operationId: target.id });
        assert.equal(result.verification.nativeReadback, 'unavailable');
        assert.equal(result.verification[kind === 'supersession' ? 'nativeLaneResolved' : 'nativeNonceResolved'], false);
        assert.doesNotMatch(result.verification.nextStep, /retry|verify_deal/i);
        assert.equal(calls, 0);
        assert.equal(w.snapshot(), before);
        assert.deepEqual(w.ops.history(target.id).filter(event => event.type === `native_${kind}_pending`), []);
      }
    } finally { w.db.close(); }
  });
}
