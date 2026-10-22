// Host-supplied store and approval challenges exercise the actual service.
// Public actions must refuse before approvals or native payloads can be produced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseService, createCoordinateStore } from '@kynesyslabs/dacs-client';
import { openDatabase, transaction, isUniqueViolation } from './helpers/purchase-integrity-database.mjs';
import { OFFLINE_AGREEMENT_MODE } from '../src/dacs/protocol-purchases.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';

function world(t, { protocolMode } = {}) {
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
  const store = { transaction, isUniqueViolation };
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
    networkIdentity: async () => { calls.push(['network']); return { identity: chainIdentity, mode: 'public-chain-read' }; },
    getAddressNonce: async () => { calls.push(['nonce']); return 6; } };
  const verifier = { verify: async () => { calls.push(['listing']); return { transactable: true, anchor: { kind: 'storage-program', locator: 'TEST-locator' }, checks: [], contentHash: chainIdentity, price: terms.price, payee, evidence: { chainMode: 'TEST' } }; } };
  const accounts = { listWallets: () => [{ address: wallet }] };
  const protocol = protocolMode ? { supportsMode: () => true, prepareTerms() { calls.push(['protocol']); throw Object.assign(new Error('TEST-profile-held'), { code: 'profile_not_admitted' }); } } : null;
  const service = createPurchaseService({ db, ops, coordinates, store, purposes, challenges, chain, verifier, accounts, protocol, config: { demAmountEncoding: 'os-string' } });
  return { db, ops, coordinates, store, calls, service, args: { operationId: operation.id, token: handoffToken }, wallet };
}

for (const status of ['awaiting_approval', 'approved', 'payment_handoff']) {
  for (const withProtocol of [false, true]) {
    test(`public purchase actions are held for ${status}, protocol=${withProtocol}`, async t => {
      const w = world(t);
      // Simulate a persisted operation from an older host, including a saved
      // handoff. A caller-provided protocol object cannot lift admission.
      w.db.prepare('UPDATE operations SET status=? WHERE id=?').run(status, w.args.operationId);
      if (withProtocol) {
        const op = w.ops.get('TEST-buyer', w.args.operationId);
        w.db.prepare('UPDATE operations SET terms=? WHERE id=?').run(JSON.stringify({ ...op.terms, protocol: {} }), op.id);
      }
      for (const method of ['issueApprovalChallenge', 'approve', 'prepareHandoff']) {
        await assert.rejects(w.service[method]({ ...w.args, address: w.wallet,
          challengeId: 'TEST-challenge', signature: 'TEST-approval-answer' }), { code: 'profile_not_admitted' });
      }
      assert.deepEqual(w.calls, [], 'no challenge, chain or listing request');
      assert.equal(w.db.prepare('SELECT count(*) n FROM approvals').get().n, 0);
      assert.equal(w.db.prepare('SELECT count(*) n FROM write_coordinates').get().n, 0);
      assert.equal(w.ops.get('TEST-buyer', w.args.operationId).status, status);
    });
  }
}

test('nested serializing store calls use savepoints and roll back with the outer transaction', t => {
  const w = world(t), cause = new Error('TEST-rollback');
  assert.throws(() => w.store.transaction(w.db, () => {
    w.db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('TEST-outer', 'TEST');
    w.store.transaction(w.db, () => w.db.prepare('INSERT INTO meta (key,value) VALUES (?,?)').run('TEST-inner', 'TEST'));
    throw cause;
  }), error => error === cause);
  assert.equal(w.db.prepare("SELECT count(*) n FROM meta WHERE key LIKE 'TEST-%'").get().n, 0);
  assert.equal(w.store.transaction(w.db, () => 'TEST-retry'), 'TEST-retry');
});

for (const mode of [undefined, OFFLINE_AGREEMENT_MODE]) {
  test(`prepare refuses before Listing resolution or durable state, mode=${mode}`, async t => {
    const w = world(t, { protocolMode: mode });
    w.db.prepare('DELETE FROM operation_events').run();
    w.db.prepare('DELETE FROM operations').run();
    await assert.rejects(w.service.prepare({ accountId: 'TEST-buyer', listingId: 'TEST-listing', version: 1,
      seller: 'TEST-seller', idempotencyKey: 'TEST-prepare', walletAddress: w.wallet, protocol: mode }), { code: 'profile_not_admitted' });
    assert.deepEqual(w.calls, []);
    assert.equal(w.db.prepare('SELECT count(*) n FROM operations').get().n, 0);
  });
}
for (const method of ['nativePaymentLane', 'agreementIdentity', 'agreementPlan', 'agreementSubmit', 'completionRequest', 'completionCountersign']) {
  test(`${method} refuses before state, network and protocol calls`, async t => {
    const w = world(t);
    await assert.rejects(async () => w.service[method]({}), { code: 'profile_not_admitted' });
    assert.deepEqual(w.calls, []);
  });
}
