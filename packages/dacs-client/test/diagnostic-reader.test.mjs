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
  return { status: () => purchases.status(op.accountId,op.id,ops.handoffTokenFor(op.id)),
    saveObservation: value => coordinates.recordObservation(op.id,value,false,HASH),
    verify: options => purchases.verifyDeal({ accountId: op.accountId, operationId: op.id, token: ops.handoffTokenFor(op.id), ...options }),
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
const responseCases = [
  ['included', { status: 'included', txHash: HASH, payer: PAYER, payee: PAYEE, amountOs: '1000000000', blockNumber: 7 }, 'included'],
  ...['pending', 'not-found', 'failed', 'invalid', 'unavailable'].map(status => [status, { status, reason: 'TEST-' + status }, status]),
  ...[undefined, null, true, 1, 'included', [], { status: 'unknown' }].map(value => [JSON.stringify(value), value, 'malformed']),
];
for (const [reader, native] of [['observePassiveTransfer', false], ['observePassiveTransfer', true]]) {
  for (const [label, response, status] of responseCases) test(`public ${reader} validates ${label}, native=${native}`, async t => {
    const w = diagnostic(t, { network: 'testnet', pinnedIdentity: IDENTITY,
      networkIdentity: async () => ({ identity: IDENTITY, mode: 'public-chain-read' }),
      [reader]: async () => response }, { native });
    const before = w.snapshot();
    const result = await w.verify();
    assert.equal(result.verification.observation.status, status, JSON.stringify(result.verification.observation));
    if (response?.reason) assert.equal(result.verification.observation.reason, response.reason);
    assert.equal(result.verification.outcome, 'readback_only');
    assert.deepEqual(w.snapshot(), before);
  });
}

for (const marked of [false,true]) test(`public factory uses the actual passive native reader across included repeats, native=${marked}`, async t => {
  const native = passiveNativeWorld(); t.after(() => native.source.close()); await native.seed();
  const w = diagnostic(t,native.source.chainReader(),{ native: marked });
  const journal = await native.journal.entries(), state = w.snapshot();
  for (let repeat = 0; repeat < 2; repeat++) {
    const result = await w.verify();
    assert.equal(result.verification.observation.status,'included'); assert.equal(result.verification.termsMatch,true);
    assert.deepEqual(await native.journal.entries(),journal); assert.deepEqual(native.writes,[]); assert.deepEqual(w.snapshot(),state);
  }
});
for (const marked of [false,true]) test(`public passive diagnostic without a retained intent, native=${marked}`, async t => {
  const native = passiveNativeWorld(); t.after(() => native.source.close());
  const chain = native.source.chainReader();
  assert.equal((await chain.observeTransfer(HASH)).status, 'included');
  chain.observeTransfer = async () => { throw new Error('TEST-active-reader-called'); };
  const w = diagnostic(t, chain, { native: marked }), state = w.snapshot();
  const journal = await native.journal.entries();
  for (let repeat = 0; repeat < 2; repeat++) {
    const results = await Promise.all([w.verify(), w.verify()]);
    for (const result of results) {
      assert.equal(result.verification.outcome, 'readback_only');
      assert.equal(result.verification.authority, 'unqualified_host');
      assert.equal(result.verification.observation.status, marked ? 'unavailable' : 'included');
      assert.equal(result.verification.termsMatch, marked ? null : true);
      if (marked) assert.equal(result.verification.observation.code, 'readback_unverified');
      else assert.equal(Object.hasOwn(result.verification.observation, 'sourceDisposition'), false);
    }
    assert.deepEqual(await native.journal.entries(), journal);
    assert.deepEqual(native.writes, []); assert.deepEqual(w.snapshot(), state);
  }
});
for (const [field, edit] of [
  ['payer', c => { c.from = '0x' + 'e'.repeat(64); c.from_ed25519_address = c.from; }],
  ['payee', c => { c.to = '0x' + 'e'.repeat(64); c.data[1].args[0] = c.to; }],
  ['amount', c => { c.amount = '1000000001'; c.data[1].args[1] = c.amount; }],
]) test(`unretained non-native diagnostic compares the saved ${field}`, async t => {
  const native = passiveNativeWorld(); t.after(() => native.source.close()); edit(native.transaction.content);
  const w = diagnostic(t, native.source.chainReader()), state = w.snapshot();
  const result = await w.verify();
  assert.equal(result.verification.observation.status, 'included');
  assert.equal(result.verification.termsMatch, false);
  assert.deepEqual(await native.journal.entries(), []);
  assert.deepEqual(native.writes, []); assert.deepEqual(w.snapshot(), state);
});
for (const marked of [false,true]) test(`passive diagnostic still compares retained signed content, native=${marked}`, async t => {
  const native = passiveNativeWorld(); t.after(() => native.source.close()); await native.seed();
  native.transaction.content.nonce++;
  const chain = native.source.chainReader();
  chain.observeTransfer = async () => { throw new Error('TEST-active-reader-called'); };
  const w = diagnostic(t, chain, { native: marked }), state = w.snapshot();
  const journal = await native.journal.entries(), result = await w.verify();
  assert.equal(result.verification.observation.status, 'unavailable');
  assert.equal(result.verification.observation.code, 'readback_unverified');
  assert.equal(result.verification.termsMatch, null);
  assert.deepEqual(await native.journal.entries(), journal);
  assert.deepEqual(native.writes, []); assert.deepEqual(w.snapshot(), state);
});
for (const [options, status] of [[{ state: 'pending' }, 'pending'], [{ state: 'unknown' }, 'not-found'],
  [{ state: 'failed' }, 'failed'], [{ status: 'failed' }, 'invalid']]) {
  test(`unretained non-native passive diagnostic preserves ${status}`, async t => {
    const native = passiveNativeWorld(options); t.after(() => native.source.close());
    const w = diagnostic(t, native.source.chainReader()), state = w.snapshot();
    const result = await w.verify();
    assert.equal(result.verification.observation.status, status);
    assert.equal(result.verification.termsMatch, null);
    assert.deepEqual(await native.journal.entries(), []);
    assert.deepEqual(native.writes, []); assert.deepEqual(w.snapshot(), state);
  });
}
for (const marked of [false,true]) test(`caller abort leaves actual native reader journals unchanged, native=${marked}`, async t => {
  const controller = new AbortController(); let abort = false, forwarded;
  const native = passiveNativeWorld({ onFetch: (_message, signal) => { if (abort) { forwarded = signal; controller.abort(); signal.throwIfAborted(); } } });
  t.after(() => native.source.close()); await native.seed(); abort = true;
  const w = diagnostic(t,native.source.chainReader(),{ native: marked });
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

for (const marked of [false, true]) {
  for (const retained of [false, true]) {
    for (const delayed of [false, true]) test(`diagnostics refuse active recovery, native=${marked}, retained=${retained}, delayed=${delayed}`, async t => {
      const native = passiveNativeWorld(); t.after(() => native.source.close());
      if (retained) await native.seed();
      const chain = native.source.chainReader(), active = chain.observeTransfer;
      delete chain.observePassiveTransfer;
      let release, calls = 0;
      const gate = new Promise(resolve => { release = resolve; });
      chain.observeTransfer = async (...args) => {
        calls++;
        if (delayed) await gate;
        return active(...args);
      };
      const w = diagnostic(t, chain, { native: marked, chainReadTimeoutMs: 20 });
      const journal = await native.journal.entries(), state = w.snapshot();
      // Drain late recovery before asserting, so post-deadline writes count too.
      const first = await w.verify();
      release();
      const repeats = await Promise.all([w.verify(), w.verify()]);
      await native.source.close();
      assert.equal(first.verification.observation.code, 'passive_reader_unavailable');
      for (const result of repeats) {
        assert.equal(result.verification.observation.code, 'passive_reader_unavailable');
        assert.equal(result.verification.termsMatch, null);
      }
      assert.equal(calls, 0);
      assert.deepEqual(await native.journal.entries(), journal);
      assert.deepEqual(native.writes, []); assert.deepEqual(w.snapshot(), state);
    });
  }
  for (const passive of [null, false, 0, {}, 'TEST-reader']) test(`diagnostics refuse a noncallable passive reader ${JSON.stringify(passive)}, native=${marked}`, async t => {
    let calls = 0;
    const w = diagnostic(t, { network: 'testnet', pinnedIdentity: IDENTITY,
      networkIdentity: async () => ({ identity: IDENTITY, mode: 'public-chain-read' }),
      observePassiveTransfer: passive, observeTransfer: async () => { calls++; } }, { native: marked });
    const state = w.snapshot(), result = await w.verify();
    assert.equal(result.verification.observation.code, 'passive_reader_unavailable');
    assert.equal(calls, 0); assert.deepEqual(w.snapshot(), state);
  });
}
test('status projects saved coordinate and nested observation extensions', t=>{
  const w=diagnostic(t,{});
  w.saveObservation({status:'pending',payload:{signThis:'TEST-unsigned-payment'},extra:{payload:'TEST-secret'},
    observation:{status:'pending',payload:{signThis:'TEST-nested-payment'}}});
  const result=w.status();
  assert.equal(result.coordinates.observation.status,'pending');
  assert.equal(result.coordinates.observation.observation.status,'pending');
  assert.doesNotMatch(JSON.stringify(result.coordinates),/payload"|signThis|TEST-unsigned-payment|TEST-nested-payment|TEST-secret/);
});
