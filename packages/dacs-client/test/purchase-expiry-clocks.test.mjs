// Approve, cancel and the unpaid-purchase limits judge approval expiry with the
// same two clocks as reads: the host's now() and the wall clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installPurchaseAdmissionHook, loadAdmissionDouble } from './helpers/purchase-admission-hook.mjs';

installPurchaseAdmissionHook();
const { setPurchaseAdmission } = await loadAdmissionDouble();
const { createPurchaseService } = await import('../src/purchases.mjs');
const { OFFLINE_AGREEMENT_MODE } = await import('../src/dacs/protocol-purchases.mjs');
const { createCoordinateStore } = await import('../src/dacs/wallet-transactions.mjs');
const { createOperationStore } = await import('./helpers/purchase-integrity-operations.mjs');
const { openDatabase, transaction, isUniqueViolation } = await import('./helpers/purchase-integrity-database.mjs');

const MINUTE = 60_000;
const CHAIN = 'c'.repeat(64), WALLET = '0x' + 'a'.repeat(64), PAYEE = '0x' + 'b'.repeat(64);

// The host clock runs ten minutes behind real time.
function world(t, purchaseLimits = { maxUnpaidPerAccount: 1, maxUnpaidPerWallet: 1, maxStartsPerHour: 10 }) {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', new Date().toISOString());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8) });
  const price = { amount: '1', amountOs: '1000000000' };
  const chain = { network: 'testnet', pinnedIdentity: CHAIN,
    networkIdentity: async () => ({ identity: CHAIN, mode: 'public-chain-read' }),
    getAddressBalance: async () => 10n ** 15n, getTransactionFees: async () => 1n };
  const verifier = { verify: async () => ({ transactable: true, anchor: { kind: 'storage-program', locator: 'TEST-locator' }, checks: [], contentHash: CHAIN, price, payee: PAYEE, evidence: {}, listing: { seller: {} } }) };
  const protocol = { supportsMode: () => true, assertSellerAdmission: async () => {},
    prepareTerms: () => ({ terms: { profile: 'TEST-profile' }, state: { stage: 'identity', attempts: [] } }) };
  const purchases = createPurchaseService({ db, ops, coordinates: createCoordinateStore({ db }), store: { transaction, isUniqueViolation },
    purposes: { APPROVE_PURCHASE: 'TEST-host-approval-purpose' }, challenges: {}, chain, verifier, protocol,
    accounts: { listWallets: () => [{ address: WALLET }] }, now: () => Date.now() - 10 * MINUTE,
    config: { demAmountEncoding: 'os-string', publicOrigin: 'https://portal.invalid', purchaseLimits } });
  const open = (key, expiresAt) => ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: key, request: {}, status: 'awaiting_approval',
    terms: { buyer: { wallet: WALLET }, price }, termsHash: CHAIN, expiresAt: new Date(expiresAt).toISOString() });
  return { db, ops, purchases, open };
}

test('approve refuses an approval that is past its expiry on the wall clock, and approves nothing', async t => {
  const w = world(t);
  const { operation, handoffToken } = w.open('TEST-approval', Date.now() - MINUTE);
  await assert.rejects(w.purchases.approve({ operationId: operation.id, token: handoffToken, challengeId: 'TEST-challenge', signature: 'TEST-signature' }),
    { code: 'invalid_state', message: 'purchase is expired' });
  assert.equal(w.db.prepare('SELECT count(*) n FROM approvals').get().n, 0);
  assert.equal(w.ops.get('TEST-buyer', operation.id).status, 'expired');
  assert.ok(!w.ops.history(operation.id).some(event => event.to === 'approved'));
});

test('cancel and a read agree that an approval past its expiry on the wall clock is expired', async t => {
  const w = world(t);
  const { operation } = w.open('TEST-approval', Date.now() - MINUTE);
  assert.equal(w.purchases.status('TEST-buyer', operation.id).operation.status, 'expired');
  await assert.rejects(w.purchases.cancel({ accountId: 'TEST-buyer', operationId: operation.id }), { code: 'invalid_state', message: /purchase is expired/ });
});

test('the unpaid-purchase limit counts an approval only while it is unexpired on both clocks', async t => {
  const prepare = (w, key) => w.purchases.prepare({ accountId: 'TEST-buyer', listingId: 'TEST-listing', version: 1, seller: 'TEST-seller',
    idempotencyKey: key, walletAddress: WALLET, protocol: OFFLINE_AGREEMENT_MODE });
  const live = world(t);
  live.open('TEST-open', Date.now() + 30 * MINUTE);
  await assert.rejects(prepare(live, 'TEST-next'), { code: 'unpaid_purchase_account_limit' });
  const elapsed = world(t);
  elapsed.open('TEST-open', Date.now() - MINUTE);
  assert.equal((await prepare(elapsed, 'TEST-next')).created, true);
});
