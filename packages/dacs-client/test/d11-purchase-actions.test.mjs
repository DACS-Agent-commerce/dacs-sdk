// Host-supplied store and approval challenges exercise the actual service.
// No signature or transfer is produced; wallet answers are TEST-only strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseService } from '../src/purchases.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { openDatabase, transaction, isUniqueViolation } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';

function world(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const at = new Date().toISOString(), chainIdentity = 'c'.repeat(64);
  const wallet = '0x' + 'a'.repeat(64), payee = '0x' + 'b'.repeat(64);
  db.prepare('INSERT INTO accounts (id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer', 'TEST', 'TEST-buyer', at);
  const ops = createOperationStore({ db, handoffSecret: 'TEST-' + 'offline-approval-'.repeat(3) });
  const coordinates = createCoordinateStore({ db });
  const terms = { buyer: { wallet }, seller: { claim: 'TEST-seller', payee },
    price: { amount: '1', amountOs: '1000000000' }, listing: { listingId: 'TEST-listing', version: 1, contentHash: chainIdentity },
    network: 'testnet', rail: 'demos-native:DEM', domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity } };
  const { operation, handoffToken } = ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: 'TEST-approval',
    request: {}, status: 'awaiting_approval', terms, termsHash: chainIdentity, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  const calls = [];
  const purposes = { APPROVE_PURCHASE: 'TEST-host-approval-purpose' };
  const store = { transactions: 0, transaction(db, fn) { this.transactions++; return transaction(db, fn); }, isUniqueViolation };
  const challenges = {
    issue({ purpose, binding }) {
      assert.equal(this, challenges);
      calls.push(['issue', purpose]);
      db.prepare('INSERT INTO challenges (id,nonce,purpose,binding,message,issued_at,expires_at) VALUES (?,?,?,?,?,?,?)')
        .run('TEST-challenge', 'TEST-nonce', purpose, JSON.stringify(binding), 'TEST-message', at, operation.expiresAt);
      return { id: 'TEST-challenge' };
    },
    verifyAndConsume({ challengeId, purpose, signature, consumedBy }) {
      calls.push(['consume', purpose]);
      assert.equal(signature, 'TEST-approval-answer');
      const changed = db.prepare('UPDATE challenges SET consumed_at=?,consumed_by=? WHERE id=? AND purpose=? AND consumed_at IS NULL')
        .run(at, consumedBy, challengeId, purpose);
      assert.equal(changed.changes, 1, 'challenge consumed exactly once');
      return { challengeId, address: wallet };
    },
  };
  const chain = { network: 'testnet', pinnedIdentity: chainIdentity,
    networkIdentity: async () => ({ identity: chainIdentity, mode: 'public-chain-read' }), getAddressNonce: async () => 6 };
  const verifier = { verify: async () => ({ transactable: true, contentHash: chainIdentity, price: terms.price, payee, evidence: { chainMode: 'TEST' } }) };
  const service = createPurchaseService({ db, ops, coordinates, store, purposes, challenges, chain, verifier, config: { demAmountEncoding: 'os-string' } });
  return { db, ops, coordinates, store, calls, service, args: { operationId: operation.id, token: handoffToken }, wallet };
}

test('host approval purpose is issued and consumed, and coordinates persist before wallet handoff', async t => {
  const w = world(t);
  const challenge = await w.service.issueApprovalChallenge({ ...w.args, address: w.wallet });
  const handoff = await w.service.approve({ ...w.args, challengeId: challenge.id, signature: 'TEST-approval-answer' });
  assert.deepEqual(w.calls, [['issue', 'TEST-host-approval-purpose'], ['consume', 'TEST-host-approval-purpose']]);
  assert.equal(handoff.operation.status, 'payment_handoff');
  assert.deepEqual(handoff.payload, w.coordinates.get(w.args.operationId).payload);
  assert.equal(handoff.payload.signature, null);
  assert.equal(w.store.transactions, 2);
  await assert.rejects(w.service.approve({ ...w.args, challengeId: challenge.id, signature: 'TEST-approval-answer' }), { code: 'invalid_state' });
  assert.equal(w.db.prepare('SELECT count(*) n FROM approvals').get().n, 1);
  assert.equal(w.db.prepare('SELECT count(*) n FROM write_coordinates').get().n, 1);
  assert.equal(w.calls.length, 2);
});

test('failed approval rolls back challenge consumption and approval, preserving the original error', async t => {
  const w = world(t), cause = new Error('TEST-state-refused');
  const challenge = await w.service.issueApprovalChallenge({ ...w.args, address: w.wallet });
  const original = w.ops.transition;
  w.ops.transition = () => { throw cause; };
  await assert.rejects(w.service.approve({ ...w.args, challengeId: challenge.id, signature: 'TEST-approval-answer' }), error => error === cause);
  assert.equal(w.db.prepare('SELECT consumed_at FROM challenges').get().consumed_at, null);
  assert.equal(w.db.prepare('SELECT count(*) n FROM approvals').get().n, 0);
  assert.equal(w.db.prepare('SELECT count(*) n FROM write_coordinates').get().n, 0);
  w.ops.transition = original;
  assert.equal((await w.service.approve({ ...w.args, challengeId: challenge.id, signature: 'TEST-approval-answer' })).operation.status, 'payment_handoff');
});

test('nested serializing store calls join the outer transaction and roll back together', t => {
  const w = world(t), cause = new Error('TEST-rollback');
  assert.throws(() => w.store.transaction(w.db, () => {
    w.db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('TEST-outer', 'TEST');
    w.store.transaction(w.db, () => w.db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('TEST-inner', 'TEST'));
    throw cause;
  }), error => error === cause);
  assert.equal(w.db.prepare("SELECT count(*) n FROM meta WHERE key LIKE 'TEST-%'").get().n, 0);
  assert.equal(w.store.transaction(w.db, () => 'TEST-retry'), 'TEST-retry');
});
