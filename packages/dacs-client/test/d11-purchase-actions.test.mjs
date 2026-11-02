// Host-supplied store and approval challenges exercise the actual service.
// Public actions must refuse before approvals or native payloads can be produced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseService } from '../src/purchases.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { openDatabase, transaction, isUniqueViolation } from './helpers/purchase-integrity-database.mjs';
import { OFFLINE_AGREEMENT_MODE, createProtocolPurchases } from '../src/dacs/protocol-purchases.mjs';
import { deliveryDeadlineView } from '../src/dacs/delivery-deadline-watch.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';

// Every public service action is classified. Held actions refuse first; open
// actions only read, record observations or reach protocol steps through the
// held protocol recheck.
const SERVICE_HELD = ['prepare', 'issueApprovalChallenge', 'approve', 'prepareHandoff', 'nativePaymentLane',
  'agreementIdentity', 'agreementPlan', 'agreementSubmit', 'completionRequest', 'completionCountersign'];
const SERVICE_OPEN = ['status', 'reportWalletResult', 'verifyDeal', 'cancel', 'portalOperation', 'portalEvidence', 'planRunning', 'protocolRecheck'];
const PROTOCOL_HELD = ['prepareTerms', 'identityRequest', 'planRequest', 'signRequest', 'submitAgreement',
  'recheckCommitment', 'recheck', 'withNativePaymentLane', 'readNativePaymentLane'];
const PROTOCOL_COMPLETION_HELD = ['checkDelivery', 'countersignRequest', 'countersign'];
const TABLES = ['operations', 'operation_events', 'challenges', 'approvals', 'write_coordinates', 'wallet_nonce_consumptions'];
const snapshot = db => Object.fromEntries(TABLES.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));

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

test('every public service action is classified as held or open', t => {
  assert.deepEqual(Object.keys(world(t).service).sort(), [...SERVICE_HELD, ...SERVICE_OPEN].sort());
});

for (const method of SERVICE_HELD) {
  test(`held service action ${method} leaves purchase, challenge and approval state untouched`, async t => {
    const w = world(t, { protocolMode: OFFLINE_AGREEMENT_MODE }), before = snapshot(w.db);
    await assert.rejects(async () => w.service[method]({ ...w.args, accountId: 'TEST-buyer', listingId: 'TEST-listing', version: 1,
      seller: 'TEST-seller', idempotencyKey: 'TEST-held', walletAddress: w.wallet, address: w.wallet, challengeId: 'TEST-challenge',
      signature: 'TEST-approval-answer', key: 'TEST-key', protocol: OFFLINE_AGREEMENT_MODE }), { code: 'profile_not_admitted' });
    assert.deepEqual(snapshot(w.db), before);
    assert.deepEqual(w.calls, []);
  });
}

test('every held protocol action refuses with a capability and leaves state and transport untouched', async t => {
  const w = world(t), effects = [], operation = w.ops.get('TEST-buyer', w.args.operationId), before = snapshot(w.db);
  const protocol = createProtocolPurchases({ db: w.db, ops: w.ops, coordinates: w.coordinates, store: w.store,
    buyerAccess: { assertWallet() {} }, fetchImpl: async (...args) => { effects.push(args); throw new Error('TEST-no-network'); } });
  await assert.rejects(async () => protocol.prepareTerms({ verification: {}, domain: {}, sellerClaim: 'TEST-seller' }), { code: 'profile_not_admitted' });
  for (const method of PROTOCOL_HELD.filter(name => name !== 'prepareTerms')) {
    await assert.rejects(async () => protocol[method](operation, {}), { code: 'profile_not_admitted' }, method);
  }
  for (const method of PROTOCOL_COMPLETION_HELD) {
    await assert.rejects(async () => protocol[method](operation, {}), { code: 'native_completion_held' }, method);
  }
  assert.deepEqual(snapshot(w.db), before);
  assert.deepEqual(effects, []);
});

// verify_deal with a configured protocol: the settlement is recorded once, and
// the protocol continuation is answered by the held recheck.
function settledWorld(t) {
  const w = world(t), chainIdentity = 'c'.repeat(64), hash = '1'.repeat(64), payee = '0x' + 'b'.repeat(64), effects = [];
  const op = w.ops.get('TEST-buyer', w.args.operationId);
  w.db.prepare('UPDATE operations SET status=?, terms=? WHERE id=?').run('broadcast_reported', JSON.stringify({ ...op.terms, protocol: {} }), op.id);
  w.coordinates.save({ operationId: op.id, kind: 'native-dem-transfer', network: 'testnet', from: w.wallet, nonceFence: 6, expectedNonce: 7,
    target: payee, amountOs: '1000000000', payload: { content: { nonce: 7 } } });
  assert.equal(w.coordinates.reportHash(op.id, hash), true);
  const chain = { network: 'testnet', pinnedIdentity: chainIdentity, rpcOrigin: 'https://rpc.invalid', evidenceMode: 'TEST-stub',
    networkIdentity: async () => ({ identity: chainIdentity, mode: 'public-chain-read' }),
    observeTransfer: async txHash => ({ status: 'included', payer: w.wallet, payee, amountOs: '1000000000', blockNumber: 10, txHash }),
    getTransaction: async txHash => ({ hash: txHash, status: 'confirmed', blockNumber: 10, content: { from: w.wallet, nonce: 7 } }) };
  const protocol = { ...createProtocolPurchases({ db: w.db, ops: w.ops, coordinates: w.coordinates, store: w.store,
    fetchImpl: async (...args) => { effects.push(args); throw new Error('TEST-no-network'); } }), available: true };
  const service = createPurchaseService({ db: w.db, ops: w.ops, coordinates: w.coordinates, store: w.store, chain, protocol,
    purposes: { APPROVE_PURCHASE: 'TEST-host-approval-purpose' }, config: { demAmountEncoding: 'os-string' } });
  return { ...w, effects, verify: () => service.verifyDeal({ accountId: 'TEST-buyer', operationId: op.id }),
    state: () => ({ status: w.ops.get('TEST-buyer', op.id).status, verifiedAt: w.coordinates.get(op.id).verifiedAt,
      consumed: w.db.prepare('SELECT count(*) AS n FROM wallet_nonce_consumptions').get().n }) };
}

test('verify_deal records the settlement once, then answers profile_not_admitted as its guidance says', async t => {
  const w = settledWorld(t);
  const refused = await w.verify().then(() => assert.fail('verify_deal must answer the action hold'), error => error);
  assert.equal(refused.code, 'profile_not_admitted');
  const settled = w.state();
  assert.equal(settled.status, 'settled_verified');
  assert.ok(settled.verifiedAt);
  assert.equal(settled.consumed, 1);
  await assert.rejects(w.verify(), { code: 'profile_not_admitted' });
  assert.deepEqual(w.state(), settled);
  assert.deepEqual(w.effects, []);
  const guidance = deliveryDeadlineView({ state: { protocol: { agreement: { artifact: { terms: { deadline: 0 } } } } } }, { now: () => 1000, enabled: true });
  assert.ok(guidance.message.includes(`answers ${refused.code}`));
});
