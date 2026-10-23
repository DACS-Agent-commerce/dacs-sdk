import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicPurchaseService } from '../src/purchases.mjs';
import { OperationError } from '../src/client-errors.mjs';
import { createCoordinateStore } from '../src/dacs/wallet-transactions.mjs';
import { createSqlitePurchaseStore } from '../src/seams/purchase-store-not-wired.mjs';
import { openDatabase } from './helpers/purchase-integrity-database.mjs';
import { createOperationStore } from './helpers/purchase-integrity-operations.mjs';
import { passiveNativeWorld, HASH, NOW, IDENTITY, PAYER, PAYEE } from './helpers/passive-native-world.mjs';

function diagnostic(t, chain, { native = false, chainReadTimeoutMs = 8000 } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const ops = createOperationStore({ db, handoffSecret: 'TEST-'.repeat(8), now: () => NOW }), coordinates = createCoordinateStore({ db });
  db.prepare('INSERT INTO accounts(id,auth_issuer,auth_subject,created_at) VALUES (?,?,?,?)').run('TEST-buyer','TEST','TEST-buyer',new Date(NOW).toISOString());
  const op = ops.createIdempotent({ accountId: 'TEST-buyer', kind: 'purchase', idempotencyKey: 'TEST', request: {}, status: 'broadcast_reported',
    terms: { buyer: { wallet: PAYER }, seller: { payee: PAYEE }, price: { amountOs: '1000000000' }, network: 'testnet', rail: 'demos-native:DEM',
      domain: { network: 'testnet', rail: 'demos-native:DEM', mode: 'public-chain-read', chainIdentity: IDENTITY },
      ...(native ? { protocol: { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment', sellerAgreementProjection: 'public-signed-create' } } : {}) },
    termsHash: IDENTITY, expiresAt: new Date(NOW + 3600000).toISOString() }).operation;
  coordinates.save({ operationId: op.id, kind: 'native-dem-transfer', network: 'testnet', from: PAYER, nonceFence: 6, expectedNonce: 7, target: PAYEE, amountOs: '1000000000', payload: {} });
  coordinates.reportHash(op.id,HASH);
  const purchases = createPublicPurchaseService({ db, ops, coordinates, chain, chainReadTimeoutMs, now: () => NOW, config: {}, store: createSqlitePurchaseStore(), purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  return { verify: options => purchases.verifyDeal({ accountId: op.accountId, operationId: op.id, token: ops.handoffTokenFor(op.id), ...options }),
    snapshot: () => ({ operation: ops.get(op.accountId,op.id), events: ops.history(op.id), coordinates: coordinates.get(op.id) }) };
}
for (const code of ['network_identity_mismatch', 'not_found', 'refused', 'timeout']) {
  test(`public diagnostic preserves OperationError code ${code}`, async t => {
    const chain = { networkIdentity: async () => { throw new OperationError(code,'TEST refused'); } };
    const w = diagnostic(t,chain);
    const result = await w.verify();
    assert.equal(result.verification.observation.code, code);
    assert.equal(result.verification.observation.reason, 'TEST refused');
  });
}
test('public factory uses the actual passive native reader across included repeats', async t => {
  const native = passiveNativeWorld(); t.after(() => native.source.close()); await native.seed();
  const w = diagnostic(t,native.source.chainReader(),{ native: true });
  const journal = await native.journal.entries(), state = w.snapshot();
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await w.verify();
    assert.equal(result.verification.observation.status,'included'); assert.equal(result.verification.termsMatch,true);
    assert.deepEqual(await native.journal.entries(),journal); assert.deepEqual(native.writes,[]); assert.deepEqual(w.snapshot(),state);
  }
});
test('caller abort through the public factory stops a real native reader and leaves journals unchanged', async t => {
  const controller = new AbortController(); let abort = false, forwarded;
  const native = passiveNativeWorld({ onFetch: (_message, signal) => { if (abort) { forwarded = signal; controller.abort(); signal.throwIfAborted(); } } });
  t.after(() => native.source.close()); await native.seed(); abort = true;
  const w = diagnostic(t,native.source.chainReader(),{ native: true });
  const journal = await native.journal.entries(), state = w.snapshot(), calls = native.calls.length;
  const result = await w.verify({ signal: controller.signal });
  assert.equal(result.verification.observation.status,'unavailable'); assert.equal(forwarded.aborted,true);
  assert.equal(native.calls.length,calls + 1);
  await native.source.close(); // Drain the actual aborted reader before checking for late effects.
  assert.deepEqual(await native.journal.entries(),journal);
  assert.deepEqual(native.writes,[]); assert.deepEqual(w.snapshot(),state); assert.equal(native.held(),false);
});
test('pre-aborted public diagnostic invokes no host reader', async t => {
  let calls = 0;
  const w = diagnostic(t,{ networkIdentity: async () => { calls++; throw new Error('TEST-unexpected'); } });
  assert.equal((await w.verify({ signal: AbortSignal.abort() })).verification.observation.status,'unavailable');
  assert.equal(calls,0);
});
