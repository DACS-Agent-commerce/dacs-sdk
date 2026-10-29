import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicPurchaseService } from '../src/purchases.mjs';
import { diagnosticProtocolView } from '../src/dacs/protocol-purchases.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';
import { DIAGNOSTIC_LIMITS, DIAGNOSTIC_OMITTED } from '../src/diagnostic-projection.mjs';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';
import { HASH, IDENTITY, PAYER, PAYEE } from './helpers/passive-native-world.mjs';

const REPLAY = 'TEST-replay-material';
const HUGE = 'x'.repeat(2 * 1024 * 1024);
const HISTORY_EVENTS = 3 * DIAGNOSTIC_LIMITS.collectionItems;
const INCLUDED = { status: 'included', txHash: HASH, payer: PAYER, payee: PAYEE, amountOs: '1000000000', blockNumber: 10 };

function savedState() {
  return {
    preparedVerification: { evidence: { chainMode: 'TEST-mode', directoryMode: HUGE }, replay: { payload: REPLAY } },
    unlisted: { payload: REPLAY },
    protocol: {
      stage: 'payment-evidenced',
      claim: { id: 'TEST-claim', nested: { payload: REPLAY, signature: REPLAY } },
      paymentEvidence: { note: HUGE, reference: 'TEST-reference' },
      commitment: { verifiedAt: 'TEST' },
      planned: { agreementMessage: REPLAY },
      buyerBundle: { payload: REPLAY },
      identity: { message: REPLAY },
      sessionDelegation: { payload: { jobId: REPLAY }, signature: REPLAY },
    },
  };
}

function publicWorld(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8) }), coordinates = createCoordinateStore({ db });
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date().toISOString());
  const operation = ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: 'TEST', request: {}, status: 'broadcast_reported',
    terms: { buyer: { wallet: PAYER }, seller: { payee: PAYEE }, price: { amountOs: INCLUDED.amountOs, amount: '1' }, network: 'testnet', rail: 'demos-native:DEM',
      listing: { listingId: 'TEST-listing', version: 1, contentHash: IDENTITY },
      domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: IDENTITY },
      protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment', sellerAgreementProjection: 'public-signed-create' } },
    termsHash: IDENTITY, expiresAt: new Date(Date.now() + 3600000).toISOString(), state: savedState() }).operation;
  coordinates.save({ operationId: operation.id, kind: 'native-dem-transfer', network: 'testnet', from: PAYER, nonceFence: 6, expectedNonce: 7, target: PAYEE, amountOs: INCLUDED.amountOs, payload: {} });
  coordinates.reportHash(operation.id, HASH);
  const insertEvent = db.prepare('INSERT INTO operation_events (operation_id, seq, at, type, data) VALUES (?, ?, ?, ?, ?)');
  for (let seq = 10; seq < 10 + HISTORY_EVENTS; seq++) {
    insertEvent.run(operation.id, seq, new Date(seq).toISOString(), 'TEST-event', JSON.stringify({ payload: REPLAY, signature: REPLAY, note: HUGE, seq }));
  }
  const chain = { networkIdentity: async () => ({ identity: IDENTITY, mode: 'public-chain-read' }), observePassiveTransfer: async () => ({ ...INCLUDED }) };
  const purchases = createPublicPurchaseService({ db, ops, coordinates, chain, config: {}, store: createSqlitePurchaseStore(), purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  const token = ops.handoffTokenFor(operation.id);
  return { operation, purchases, token, accountId: operation.accountId };
}

async function everyDiagnostic(t) {
  const w = publicWorld(t);
  return {
    status: w.purchases.status(w.accountId, w.operation.id, w.token),
    portalOperation: w.purchases.portalOperation(w.operation.id, w.token),
    portalEvidence: w.purchases.portalEvidence(w.operation.id, w.token),
    diagnosticProtocolView: diagnosticProtocolView(w.operation),
  };
}

test('no public diagnostic returns nested signing or replay material from saved state', async t => {
  for (const [name, result] of Object.entries(await everyDiagnostic(t))) {
    assert.doesNotMatch(JSON.stringify(result), new RegExp(REPLAY), name);
  }
});

test('every public diagnostic stays within the total output budget despite oversized saved values', async t => {
  for (const [name, result] of Object.entries(await everyDiagnostic(t))) {
    assert.ok(JSON.stringify(result).length <= DIAGNOSTIC_LIMITS.outputChars, name);
  }
});

test('oversized saved strings are replaced by an explicit marker and identifiers are kept', async t => {
  const { status, portalOperation, diagnosticProtocolView: view } = await everyDiagnostic(t);
  assert.equal(status.operation.state.protocol.paymentEvidence.note, DIAGNOSTIC_OMITTED);
  assert.equal(status.operation.state.protocol.paymentEvidence.reference, 'TEST-reference');
  assert.equal(view.paymentEvidence.note, DIAGNOSTIC_OMITTED);
  assert.equal(status.operation.id, portalOperation.id);
  assert.equal(status.coordinates.reportedTxHash, HASH);
});

test('saved history is limited to its newest events and carries no signing fields', async t => {
  const { status } = await everyDiagnostic(t);
  assert.equal(status.history.length <= DIAGNOSTIC_LIMITS.collectionItems, true);
  assert.equal(status.history.at(-1).data.seq, 10 + HISTORY_EVENTS - 1);
  assert.equal(Object.hasOwn(status.history[0].data, 'payload'), false);
});

test('operation state keeps only listed fields', async t => {
  const { portalOperation } = await everyDiagnostic(t);
  assert.deepEqual(Object.keys(portalOperation.state).sort(), ['preparedVerification', 'protocol']);
  assert.deepEqual(Object.keys(portalOperation.state.protocol).sort(), ['claim', 'commitment', 'paymentEvidence', 'stage']);
});
