import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { storedWorld, PATHS, bodyFor, errorCode } from './helpers/stored-request-fixture.mjs';
import { setPurchaseAdmission, T0 } from './helpers/wire-client-fixture.mjs';
beforeEach(t => t.mock.method(Date, 'now', () => T0));
const { createPurchaseService } = await import('../src/purchases.mjs');
const { createSqlitePurchaseStore } = await import('../src/seams/purchase-store-not-wired.mjs');
const { STAGE_HELP, protocolStageHelp } = await import('../src/dacs/protocol-purchases.mjs');
const P = PATHS.proposals;
const suspension = s => s.p.get().state.protocol.sellerSuspension;
const stopped = s => s.client({ respond: init => s.reply(init, 503, { error: 'seller_stopped' }) });
const isSuspended = error => error.answerClass === 'suspended';
// Another flow's suspension: a request-only write, so it advances the revision and keeps the progress generation.
let stops = 0;
function stop(s) {
  const row = s.p.get(), protocol = row.state.protocol;
  const sellerSuspension = { id: `TEST-suspension-${++stops}`, cause: 'seller_stopped', path: P, at: new Date(s.w.state.time).toISOString() };
  return s.p.ops.transition(row.id, row.status, row.status, { state: { protocol: { ...protocol, sellerSuspension, revision: (protocol.revision ?? 0) + 1 } }, event: 'test_suspension', data: {} });
}

// The purchase service over the real public protocol object, which supplies admission and the request guards.
function reader(s, protocol = s.p.service) {
  s.p.db.prepare('UPDATE operations SET handoff_expires_at = expires_at WHERE id = ?').run(s.p.op.id);
  const counters = { broadcasts: 0 };
  const service = createPurchaseService({ db: s.p.db, ops: s.p.ops, coordinates: { get: () => null }, protocol,
    chain: { broadcastTransaction() { counters.broadcasts++; } }, config: {}, store: createSqlitePurchaseStore(), now: () => s.w.state.time, purposes: { APPROVE_PURCHASE: 'TEST-approve' } });
  return { service, counters, request: { accountId: s.p.op.accountId, operationId: s.p.op.id, token: s.p.ops.handoffTokenFor(s.p.op.id), resumeSuspensionId: suspension(s)?.id } };
}

test('a signed seller_stopped answering a dispatched payment leaves the outcome unknown, never failed, records the suspension and suspends automatic retries (K8-G11)', async t => {
  const s = await storedWorld(t, { status: 'settled_verified', stage: 'payment-observed' });
  await assert.rejects(stopped(s).request(PATHS.payments, bodyFor(PATHS.payments)), isSuspended);
  assert.equal(s.p.get().status, 'settled_verified');
  assert.equal(s.p.get().state.protocol.stage, 'payment-observed');
  assert.deepEqual({ ...suspension(s), id: 'TEST-id' }, { id: 'TEST-id', cause: 'seller_stopped', path: PATHS.payments, at: new Date(s.w.state.time).toISOString() });
  assert.ok(suspension(s).id);
  assert.equal(s.record(PATHS.payments).lastClass, 'suspended');
  assert.equal(s.record(PATHS.payments).attempts, 1);
  assert.equal(s.record(PATHS.payments).clearAttempts, 0);
  assert.equal(s.fetches.length, 1); assert.equal(s.delays.length, 0);
});

test('the suspension survives restart, readback works, and only a new explicit request resumes, with fresh admission (K8-G10)', async t => {
  const s = await storedWorld(t, { paid: true });
  await assert.rejects(stopped(s).propose(bodyFor(P)), isSuspended);
  const held = suspension(s), record = s.record(P); s.restart();
  const { service, request } = reader(s);
  assert.equal((await service.verifyDeal(request)).operation.id, s.p.op.id);
  await s.p.service.recheck(s.p.get());
  assert.deepEqual(suspension(s), held); assert.equal(s.fetches.length, 1);
  s.w.state.failure = new Error('TEST-authority-refused');
  await assert.rejects(service.protocolRecheck(request), errorCode('profile_not_admitted'));
  assert.deepEqual(suspension(s), held);
  s.w.state.failure = null;
  await service.protocolRecheck(request);
  assert.equal(suspension(s), undefined); assert.deepEqual(s.record(P), record);
  await s.client().propose(bodyFor(P));
  assert.equal(s.fetches[1].body, s.fetches[0].body);
});

test('a re-hold observed with queued work suspends it, and re-admission alone resumes nothing (K8-G14 client half)', async t => {
  const s = await storedWorld(t); const sleep = s.clock.sleep;
  s.clock.sleep = async ms => { await sleep(ms); setPurchaseAdmission('held'); };
  await assert.rejects(s.client({ respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) }).propose(bodyFor(P)), errorCode('profile_not_admitted'));
  assert.equal(suspension(s).cause, 'profile_not_admitted');
  const held = suspension(s); setPurchaseAdmission('testnet-tp1'); s.restart();
  await assert.rejects(s.client().propose(bodyFor(P)), errorCode('invalid_state'));
  assert.deepEqual(suspension(s), held); assert.equal(s.fetches.length, 1);
});

test('an older resumption request racing a newer suspension loses its compare-and-set and leaves the newer suspension recorded', async t => {
  const s = await storedWorld(t, { paid: true }); stop(s);
  const older = s.p.get(), id = suspension(s).id;
  const { service, request } = reader(s);
  let newer;
  s.w.state.gate = async () => { s.w.state.gate = null; stop(s); newer = suspension(s); };
  await service.protocolRecheck(request);
  assert.notEqual(newer.id, id); assert.deepEqual(suspension(s), newer);
  await s.p.service.recheck(older, null, { resumeSuspensionId: id });
  assert.deepEqual(suspension(s), newer); assert.equal(s.fetches.length, 0);
});

test('verifyDeal on a durably suspended purchase returns its readback, with continueProtocol and seller, signer and broadcast counters at 0', async t => {
  const s = await storedWorld(t, { paid: true }); stop(s);
  let continuations = 0;
  const protocol = { ...s.p.service, recheck() { continuations++; throw Error('TEST-unexpected-continuation'); } };
  const { service, request, counters } = reader(s, protocol);
  const before = s.p.get();
  assert.equal((await service.verifyDeal(request)).operation.id, before.id);
  assert.equal(continuations, 0); assert.equal(s.fetches.length, 0); assert.equal(s.w.state.signs.length, 0);
  assert.equal(counters.broadcasts, 0);
  assert.deepEqual(s.p.get(), before); assert.equal(s.p.journalReads(), 0);
  assert.match(protocolStageHelp(s.p.get()), /suspend/i); assert.match(STAGE_HELP.suspended, /protocolRecheck/);
});

test('every save path keeps the suspension record and the stored request records', async t => {
  const { sellerFlow } = await import('./helpers/stored-request-flows.mjs');
  for (const kind of ['agreement', 'commit', 'replay', 'payment', 'signature']) {
    const { s, service, result, commitmentAddress } = await sellerFlow(t, kind, (s, state) => {
      state.fetch = async (_url, init) => { s.fetches.push(init); const reply = await s.reply(init); stop(s); return reply; };
    });
    const held = suspension(s), requests = s.p.get().state.protocol.sellerRequests;
    assert.ok(held, kind); assert.ok(Object.keys(requests).length, kind);
    assert.equal(result.state.protocol.revision, s.p.get().state.protocol.revision, kind);
    if (kind === 'replay') assert.ok(s.p.get().state.protocol.chainReadback[commitmentAddress]);
    await service.holdChainReadback(s.p.get(), 'TEST-retired');
    assert.deepEqual(suspension(s), held, kind); assert.deepEqual(s.p.get().state.protocol.sellerRequests, requests, kind);
  }
  const s = await storedWorld(t); await assert.rejects(stopped(s).propose(bodyFor(P)), isSuspended);
  const held = suspension(s), records = s.p.get().state.protocol.sellerRequests;
  await s.p.service.identityRequest(s.p.get(), s.w.buyer.address);
  assert.deepEqual(suspension(s), held); assert.deepEqual(s.p.get().state.protocol.sellerRequests, records);
  s.patch({ stage: 'delivered', delivery: { status: 'delivered' } }, 'settled_verified');
  await s.p.service.holdChainReadback(s.p.get(), 'TEST-key-retired');
  assert.ok(s.p.get().state.protocol.chainReadbackHeld);
  assert.deepEqual(suspension(s), held); assert.deepEqual(s.p.get().state.protocol.sellerRequests, records);
});

test('no retry is sent until the suspension write is durable, and a failed write stops retries with its cause', async t => {
  for (const fail of [false, true]) {
    const s = await storedWorld(t); const failure = new Error('TEST-store-write-failed');
    const { transaction } = createSqlitePurchaseStore(); let observed = false;
    const records = s.records(s.holder, (db, work) => transaction(db, () => {
      const result = work();
      if (suspension(s)) { observed = true; assert.equal(s.fetches.length, 1); if (fail) throw failure; }
      return result;
    }));
    await assert.rejects(s.client({ requestRecords: records, respond: init => s.reply(init, 503, { error: 'seller_stopped' }) }).propose(bodyFor(P)), error => isSuspended(error) && (!fail || error.cause === failure));
    assert.equal(observed, true); assert.equal(Boolean(suspension(s)), !fail);
    assert.equal(s.fetches.length, 1); assert.deepEqual(s.delays, []);
  }
});

test('a suspension write racing a save of the same stage reloads and records', async t => {
  const s = await storedWorld(t); const { transaction } = createSqlitePurchaseStore(); let raced = false;
  const records = s.records(s.holder, (db, work) => {
    if (s.fetches.length && !raced) { raced = true; s.patch({ sameStageSave: 'TEST-retained' }); }
    return transaction(db, work);
  });
  await assert.rejects(s.client({ requestRecords: records, respond: init => s.reply(init, 503, { error: 'seller_stopped' }) }).propose(bodyFor(P)), isSuspended);
  assert.equal(s.p.get().state.protocol.sameStageSave, 'TEST-retained'); assert.ok(suspension(s));
  assert.equal(s.record(P).lastClass, 'suspended'); assert.equal(s.fetches.length, 1);
});

test("a suspension recorded after verifyDeal's entry check stops the continuation before any request is signed (signer counter 0)", async t => {
  const { sellerFlow } = await import('./helpers/stored-request-flows.mjs'); let flow;
  await assert.rejects(sellerFlow(t, 'agreement', (s, state) => {
    flow = s; const exchange = state.exchange;
    state.exchange = args => { stop(s); return exchange(args); };
  }), errorCode('invalid_state'));
  assert.equal(flow.w.state.signs.length, 0); assert.equal(flow.fetches.length, 0);
  const s = await storedWorld(t, { paid: true }); const { service, request } = reader(s);
  s.w.state.gate = async () => { s.w.state.gate = null; stop(s); };
  const result = await service.verifyDeal(request);
  assert.deepEqual(result.operation.state.protocol.sellerSuspension, suspension(s));
  assert.equal(s.w.state.signs.length, 0); assert.equal(s.fetches.length, 0);
});

test('a cut between clearing the suspension and the resumed send sends nothing until the next explicit call; a re-hold in the gap records a new suspension', async t => {
  const s = await storedWorld(t); await assert.rejects(stopped(s).propose(bodyFor(P)), isSuspended);
  const id = suspension(s).id; s.records().resume(id); s.restart();
  assert.equal(suspension(s), undefined); assert.equal(s.fetches.length, 1);
  setPurchaseAdmission('held');
  await assert.rejects(s.client().propose(bodyFor(P)), errorCode('profile_not_admitted'));
  const held = suspension(s); assert.ok(held); assert.notEqual(held.id, id);
  setPurchaseAdmission('testnet-tp1'); s.restart();
  await assert.rejects(s.client().propose(bodyFor(P)), errorCode('invalid_state'));
  assert.equal(s.fetches.length, 1); assert.deepEqual(suspension(s), held);
  await s.p.service.recheck(s.p.get(), null, { resumeSuspensionId: held.id });
  await s.client().propose(bodyFor(P)); assert.equal(s.fetches.length, 2);
  assert.equal(s.fetches[1].body, s.fetches[0].body);
});

test('a re-hold during verifyDeal admission records queued work and re-admission leaves it suspended', async t => {
  setPurchaseAdmission('testnet-tp1'); t.after(() => setPurchaseAdmission('held'));
  const { compositionWorld, ACCOUNT_ID } = await import('./helpers/public-composition-world.mjs');
  const { OFFLINE_AGREEMENT_PROFILE } = await import('../src/dacs/protocol-purchases.mjs');
  const w = await compositionWorld(t);
  const p = w.seed({ status: 'agreement_pending', key: 'TEST-queued-rehold', protocolTerms: { profile: OFFLINE_AGREEMENT_PROFILE },
    state: { protocol: { stage: 'agreement-signing', signatures: { agreement: 'TEST-queued-contribution' } } } });
  const request = { accountId: ACCOUNT_ID, operationId: p.operation.id, token: p.token };
  w.authority.state.gate = async () => { setPurchaseAdmission('held'); };
  await w.service.verifyDeal(request);
  const held = w.ops.get(ACCOUNT_ID, p.operation.id).state.protocol.sellerSuspension;
  assert.equal(held.cause, 'profile_not_admitted');
  setPurchaseAdmission('testnet-tp1'); w.authority.state.gate = null;
  await w.service.verifyDeal(request);
  assert.deepEqual(w.ops.get(ACCOUNT_ID, p.operation.id).state.protocol.sellerSuspension, held);
  assert.equal(w.counters.sellerLookups, 0); assert.equal(w.native.calls.length, 0); assert.equal(w.chain.broadcasts, 0);
});

test('resumption validates retained buyer access before clearing the suspension', async t => {
  const s = await storedWorld(t, { paid: true }); stop(s); const held = suspension(s);
  const { createProtocolPurchases } = await import('../src/index.mjs');
  const failure = Object.assign(new Error('TEST-buyer-access-closed'), { code: 'buyer_access_closed', details: { buyerAccessMissing: true } });
  const protocol = createProtocolPurchases({ db: s.p.db, ops: s.p.ops, coordinates: {}, dacsProtocol: s.p.config, admission: s.w.admission,
    store: createSqlitePurchaseStore(), now: () => s.w.state.time, buyerAccess: { assertWallet() { throw failure; } } });
  await assert.rejects(protocol.recheck(s.p.get(), null, { resumeSuspensionId: held.id }), error => error === failure);
  assert.deepEqual(suspension(s), held);
});
