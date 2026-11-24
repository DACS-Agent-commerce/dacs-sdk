// Purchase verification on the store an SDK buyer composes, with the state file
// closed between steps and reopened with new adapters, as after a process exit.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase, transaction, isUniqueViolation, createOperationStore } from './helpers/composed-purchase-store.mjs';
import { createLocalPurchaseAccount } from '../src/host/local-account.mjs';
import { createPurchaseService } from '../src/purchases.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';

const store = { transaction, isUniqueViolation }, purposes = { APPROVE_PURCHASE: 'approve-purchase' };
const CHAIN = 'f'.repeat(64), WALLET = '0x' + 'a'.repeat(64), PAYEE = '0x' + '7'.repeat(64), A = '1'.repeat(64), B = '2'.repeat(64), AMOUNT = '2500000000';
const HANDOFF_SECRET = 'TEST-'.repeat(8);
const NATIVE_PROTOCOL = { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment', sellerAgreementProjection: 'public-signed-create' };
const included = (hash) => ({ status: 'included', txHash: hash, payer: WALLET, payee: PAYEE, amountOs: AMOUNT, blockNumber: 10 });

// `chainSays` maps a hash to what the chain reports for it; a hash not in it is pending.
function world(t, { native = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dacs-composed-reopen-')), file = join(dir, 'state.sqlite');
  const chainSays = new Map(), resolutions = [];
  let active = null;
  t.after(() => { active?.db.close(); rmSync(dir, { recursive: true, force: true }); });
  const chain = { network: 'testnet', pinnedIdentity: CHAIN, rpcOrigin: 'https://rpc.invalid', evidenceMode: 'TEST-stub',
    networkIdentity: async () => ({ identity: CHAIN, mode: 'public-chain-read' }),
    observeTransfer: async (hash) => chainSays.get(hash) ?? { status: 'pending' },
    getTransaction: async (hash) => ({ hash, status: 'confirmed', blockNumber: 10, content: { from: WALLET, nonce: 7 } }) };
  const protocol = { nativePaymentSuperseded: async (op) => { resolutions.push(op.id); return true; }, nativeIntentsSupersededBy: async () => [] };
  const open = () => {
    const db = openDatabase(file);
    const { accountId } = createLocalPurchaseAccount({ db, store, wallet: WALLET });
    const ops = createOperationStore({ db, handoffSecret: HANDOFF_SECRET }), coordinates = createCoordinateStore({ db });
    const purchases = createPurchaseService({ db, ops, coordinates, chain, store, purposes, config: native ? { nonceSlotProof: 'account' } : {}, ...(native ? { protocol } : {}) });
    active = { db, accountId, ops, coordinates, purchases };
  };
  open();
  const terms = { buyer: { wallet: WALLET }, seller: { payee: PAYEE, claim: 'TEST-seller' }, price: { amountOs: AMOUNT, amount: '2.5' },
    listing: { listingId: 'TEST-listing', version: 1, contentHash: CHAIN }, network: 'testnet', rail: 'demos-native:DEM',
    domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: CHAIN }, ...(native ? { protocol: NATIVE_PROTOCOL } : {}) };
  const make = (key, hash = null) => {
    const { ops, coordinates, accountId } = active;
    const op = ops.createIdempotent({ accountId, kind: 'purchase', idempotencyKey: key, request: { key }, status: hash ? 'broadcast_reported' : 'payment_handoff',
      terms, termsHash: CHAIN, expiresAt: new Date(Date.now() + 3600000).toISOString() }).operation;
    coordinates.save({ operationId: op.id, kind: 'native-dem-transfer', network: 'testnet', from: WALLET, nonceFence: 6, expectedNonce: 7, target: PAYEE, amountOs: AMOUNT, payload: { content: { nonce: 7 } } });
    if (hash) assert.equal(coordinates.reportHash(op.id, hash), true);
    return op;
  };
  return {
    chainSays, resolutions, make,
    reopen: () => { active.db.close(); open(); },
    current: () => active,
    verify: (op) => active.purchases.verifyDeal({ accountId: active.accountId, operationId: op.id }),
    snapshot: (op) => ({ operation: active.ops.get(active.accountId, op.id), coordinate: active.coordinates.get(op.id), events: active.ops.history(op.id),
      consumptions: active.db.prepare('SELECT * FROM wallet_nonce_consumptions ORDER BY tx_hash').all() }),
  };
}

test('a payment read as pending before the state file closes settles once after it reopens', async (t) => {
  const w = world(t), op = w.make('reopen-settle', A);
  const pending = await w.verify(op);
  assert.equal(pending.verification.outcome, 'awaiting_inclusion');
  assert.equal(pending.operation.status, 'broadcast_reported');
  w.reopen();
  w.chainSays.set(A, included(A));
  const settled = await w.verify(op);
  assert.equal(settled.verification.outcome, 'verified');
  assert.equal(settled.operation.status, 'settled_verified');
  const saved = w.snapshot(op);
  assert.deepEqual(saved.consumptions.map((row) => row.tx_hash), [A], 'the settled payment consumes its nonce once');
  w.reopen();
  assert.equal((await w.verify(op)).verification.outcome, 'verified');
  assert.deepEqual(w.snapshot(op), saved, 'a repeated verify after reopening writes no state, observation, event or consumption');
});

test('a settled purchase keeps its saved state when the same hash reads as failed after the state file reopens', async (t) => {
  const w = world(t), op = w.make('reopen-terminal', A);
  w.chainSays.set(A, included(A));
  assert.equal((await w.verify(op)).verification.outcome, 'verified');
  const saved = w.snapshot(op);
  w.reopen();
  w.chainSays.set(A, { status: 'failed', txHash: A });
  await w.verify(op);
  assert.deepEqual(w.snapshot(op), saved);
});

test('a replacement hash saved before the state file closes is the one verified after it reopens', async (t) => {
  const w = world(t), op = w.make('reopen-replaced', A);
  assert.equal(w.current().coordinates.replaceUnobservedHash(op.id, B), true);
  w.reopen();
  w.chainSays.set(A, included(A));
  w.chainSays.set(B, included(B));
  const answer = await w.verify(op);
  assert.equal(answer.verification.outcome, 'verified');
  assert.equal(answer.verification.txHash, B);
  const saved = w.snapshot(op);
  assert.equal(saved.coordinate.reportedTxHash, B);
  w.reopen();
  w.current().coordinates.recordObservation(op.id, included(A), true);
  assert.deepEqual(w.snapshot(op), saved, 'the earlier hash cannot replace the settled one after reopening');
});

test('a native lane superseded before the state file closes is not resolved again after it reopens', async (t) => {
  const w = world(t, { native: true }), settler = w.make('reopen-settler', A), other = w.make('reopen-other');
  w.chainSays.set(A, included(A));
  assert.equal((await w.verify(settler)).verification.outcome, 'verified');
  const saved = w.snapshot(other);
  assert.equal(saved.operation.status, 'superseded');
  assert.equal(saved.coordinate.observation.nativeLaneResolved, true);
  const resolved = w.resolutions.length;
  w.reopen();
  await w.verify(settler);
  assert.equal((await w.verify(other)).verification.outcome, 'superseded');
  assert.equal(w.resolutions.length, resolved, 'the resolved lane is not resolved again');
  assert.deepEqual(w.snapshot(other), saved, 'reopening and retrying append no resolution event');
});
