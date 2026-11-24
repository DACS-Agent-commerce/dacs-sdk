import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { storedWorld, PATHS, bodyFor, errorCode } from './helpers/stored-request-fixture.mjs';
import { setPurchaseAdmission, T0, FIXTURE_RECEIPT_LIMITS } from './helpers/wire-client-fixture.mjs';
beforeEach(t => t.mock.method(Date, 'now', () => T0));
const { createPurchaseService } = await import('../src/purchases.mjs');
const { createSqlitePurchaseStore } = await import('../src/seams/purchase-store-not-wired.mjs');
const { STAGE_HELP, protocolStageHelp } = await import('../src/dacs/protocol-purchases.mjs');
const { OperationError } = await import('../src/client-errors.mjs');
const { createHostStop } = await import('../src/host-stop.mjs');
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

test('a signed seller_stopped is recorded on the latest row when another flow moved the stage during the request', async t => {
  const s = await storedWorld(t);
  const respond = init => { s.patch({ stage: 'agreement-anchored' }); return s.reply(init, 503, { error: 'seller_stopped' }); };
  await assert.rejects(s.client({ respond }).propose(bodyFor(P)), error => isSuspended(error) && error.cause === undefined);
  assert.equal(s.p.get().state.protocol.stage, 'agreement-anchored');
  assert.deepEqual({ ...suspension(s), id: 'TEST-id' }, { id: 'TEST-id', cause: 'seller_stopped', path: P, at: new Date(s.w.state.time).toISOString() });
  assert.equal(s.record(P).lastClass, 'suspended'); assert.equal(s.record(P).attempts, 1); assert.equal(s.fetches.length, 1);
});

test('a signed seller_stopped for an attempt that a newer attempt on the route has replaced records no suspension and leaves the newer record alone', async t => {
  for (const newerClass of ['result', 'unknown']) {
    const s = await storedWorld(t); let newer;
    const respond = init => {
      const row = s.p.get().state.protocol, older = row.sellerRequests[P];
      newer = { ...older, attemptId: `TEST-newer-${newerClass}`, attempts: older.attempts + 1, lastClass: newerClass };
      s.patch({ stage: 'payment-evidenced', sellerRequests: { ...row.sellerRequests, [P]: newer } });
      return s.reply(init, 503, { error: 'seller_stopped' });
    };
    await assert.rejects(s.client({ respond }).propose(bodyFor(P)), error => isSuspended(error) && error.cause === undefined);
    assert.equal(suspension(s), undefined);
    assert.deepEqual(s.record(P), newer);
    assert.equal(s.p.get().state.protocol.stage, 'payment-evidenced'); assert.equal(s.fetches.length, 1);
  }
});

test('a signed seller_stopped for a purchase that ended during the request records nothing and still suspends the call', async t => {
  const s = await storedWorld(t);
  const respond = init => { s.patch({}, 'cancelled'); return s.reply(init, 503, { error: 'seller_stopped' }); };
  await assert.rejects(s.client({ respond }).propose(bodyFor(P)), error => isSuspended(error) && error.cause === undefined);
  assert.equal(s.p.get().status, 'cancelled'); assert.equal(suspension(s), undefined); assert.equal(s.fetches.length, 1);
});

test('a re-hold seen from an older snapshot is recorded on the latest row, with or without queued work, and keeps its stage', async t => {
  for (const queued of [true, false]) {
    const s = await storedWorld(t), older = s.p.get();
    s.patch({ stage: 'agreement-anchored', ...(queued ? { signatures: { agreement: 'TEST-queued-contribution' } } : {}) });
    s.records({ get: () => older, set() {} }).suspend('profile_not_admitted');
    const protocol = s.p.get().state.protocol;
    assert.equal(protocol.stage, 'agreement-anchored', `${queued}`);
    assert.equal(protocol.sellerSuspension?.cause, 'profile_not_admitted', `${queued}`);
    assert.equal(protocol.signatures?.agreement, queued ? 'TEST-queued-contribution' : undefined, `${queued}`);
  }
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
    feeCeilingOs: '50000000000', chain: { getTransactionFees: async () => 1n },
    store: createSqlitePurchaseStore(), now: () => s.w.state.time, buyerAccess: { assertWallet() { throw failure; } }, ...FIXTURE_RECEIPT_LIMITS });
  await assert.rejects(protocol.recheck(s.p.get(), null, { resumeSuspensionId: held.id }), error => error === failure);
  assert.deepEqual(suspension(s), held);
});

// Host stop: the purchase service and the protocol it drives are built with one stop check.
const hostStopRefusal = code => error => error.code === code && error.message === `host stop refused: ${code}`;
const queueWork = s => s.patch({ signatures: { agreement: 'TEST-queued-contribution' } });
const events = (s, type) => s.p.ops.history(s.p.op.id).filter(event => event.type === type);

// `publicService` builds the service through the public factory, whose admission wrapper reads the stop before each action.
async function stoppedReader(s, stopped, { publicService = false } = {}) {
  const { createProtocolPurchases, createPurchaseService: createPublicService } = await import('../src/index.mjs');
  const createService = publicService ? options => createPublicService({ ...options, admission: s.w.admission }) : createPurchaseService;
  const counters = { sellerLookups: 0 };
  const dacsProtocol = { ...s.p.config, sellerEndpoint: (...args) => { counters.sellerLookups++; return s.p.config.sellerEndpoint(...args); } };
  const feeCeilingOs = '50000000000', getTransactionFees = async () => 1n;
  const protocol = createProtocolPurchases({ db: s.p.db, ops: s.p.ops, coordinates: { unresolvedForSender: () => [] }, dacsProtocol, admission: s.w.admission,
    store: createSqlitePurchaseStore(), now: () => s.w.state.time, buyerAccess: { assertWallet() {} }, stopped, feeCeilingOs, chain: { getTransactionFees }, ...FIXTURE_RECEIPT_LIMITS });
  s.p.db.prepare('UPDATE operations SET handoff_expires_at = expires_at WHERE id = ?').run(s.p.op.id);
  const service = createService({ db: s.p.db, ops: s.p.ops, coordinates: { get: () => null }, protocol, chain: { getTransactionFees, broadcastTransaction() { counters.broadcasts = (counters.broadcasts ?? 0) + 1; } },
    config: {}, store: createSqlitePurchaseStore(), now: () => s.w.state.time, purposes: { APPROVE_PURCHASE: 'TEST-approve' }, stopped, feeCeilingOs });
  const request = { accountId: s.p.op.accountId, operationId: s.p.op.id, token: s.p.ops.handoffTokenFor(s.p.op.id) };
  return { service, request, counters, protocol };
}

test('a host stop observed with queued work suspends it with cause writes_stopped, and lifting the stop alone resumes nothing', async t => {
  const s = await storedWorld(t); const sleep = s.clock.sleep; let stopped = false;
  s.clock.sleep = async ms => { await sleep(ms); stopped = true; };
  await assert.rejects(s.client({ stopped: () => stopped, respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) }).propose(bodyFor(P)), hostStopRefusal('writes_stopped'));
  assert.equal(suspension(s).cause, 'writes_stopped');
  const held = suspension(s); stopped = false; s.restart();
  await assert.rejects(s.client({ stopped: () => stopped }).propose(bodyFor(P)), errorCode('invalid_state'));
  assert.deepEqual(suspension(s), held); assert.equal(s.fetches.length, 1);
});

test('a host stop seen when a request starts on a purchase with no queued work records the suspension and stores no bytes, and a stop no check observed records none', async t => {
  const s = await storedWorld(t);
  await assert.rejects(s.client({ stopped: () => true }).propose(bodyFor(P)), hostStopRefusal('writes_stopped'));
  assert.equal(suspension(s).cause, 'writes_stopped'); assert.equal(s.record(P), undefined); assert.equal(s.fetches.length, 0);
  const unobserved = await storedWorld(t);
  let stopped = true; stopped = false;
  await unobserved.client({ stopped: () => stopped }).propose(bodyFor(P));
  assert.equal(suspension(unobserved), undefined); assert.equal(unobserved.fetches.length, 1);
});

test('restart under a host stop with the client admitted: verifyDeal returns its readback with seller, session-signer and fetch counters at 0 and suspends queued work', async t => {
  const s = await storedWorld(t, { paid: true }); queueWork(s); s.restart();
  const { service, request, counters } = await stoppedReader(s, () => true);
  const result = await service.verifyDeal(request);
  assert.equal(result.operation.id, s.p.op.id);
  assert.equal(counters.sellerLookups, 0); assert.equal(s.w.state.signs.length, 0); assert.equal(s.fetches.length, 0);
  assert.equal(suspension(s).cause, 'writes_stopped'); assert.deepEqual(result.operation.state.protocol.sellerSuspension, suspension(s));
});

test('after the stop is lifted only protocolRecheck naming the suspension continues, once; the same request while still stopped is refused writes_stopped and keeps the suspension', async t => {
  const s = await storedWorld(t, { paid: true }); const sleep = s.clock.sleep, stop = { now: false };
  s.clock.sleep = async ms => { await sleep(ms); stop.now = true; };
  await assert.rejects(s.client({ stopped: () => stop.now, respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) }).propose(bodyFor(P)), hostStopRefusal('writes_stopped'));
  const held = suspension(s), record = s.record(P); s.restart();
  const { service, request } = await stoppedReader(s, () => stop.now), named = { ...request, resumeSuspensionId: held.id };
  await assert.rejects(service.protocolRecheck(named), hostStopRefusal('writes_stopped'));
  assert.deepEqual(suspension(s), held);
  stop.now = false;
  await service.verifyDeal(request);
  assert.deepEqual(suspension(s), held); assert.equal(events(s, 'seller_resumed').length, 0);
  await service.protocolRecheck(named);
  assert.equal(suspension(s), undefined); assert.equal(events(s, 'seller_resumed').length, 1);
  assert.deepEqual(s.record(P), record); assert.equal(s.fetches.length, 1);
});

test('a stop check that throws or returns a non-boolean suspends queued work with cause stop_check_failed or stop_check_invalid', async t => {
  for (const [stopped, cause] of [[() => { throw new Error('TEST-stop-check-failure'); }, 'stop_check_failed'], [() => 'yes', 'stop_check_invalid']]) {
    const s = await storedWorld(t, { paid: true }); queueWork(s);
    const { service, request } = await stoppedReader(s, stopped);
    await service.verifyDeal(request);
    assert.equal(suspension(s).cause, cause);
  }
});

test('a stop check that throws mid-request while its suspension write fails keeps the stop error as cause and the write failure as details.suspensionWriteError', async t => {
  const s = await storedWorld(t); const sleep = s.clock.sleep, stopError = new Error('TEST-stop-check-failure'), failure = new Error('TEST-store-write-failed');
  let stopping = false; s.clock.sleep = async ms => { await sleep(ms); stopping = true; };
  const { transaction } = createSqlitePurchaseStore(), stopped = () => { if (stopping) throw stopError; return false; };
  const records = s.records(s.holder, (db, work) => transaction(db, () => { const result = work(); if (suspension(s)) throw failure; return result; }), createHostStop(stopped));
  await assert.rejects(s.client({ requestRecords: records, stopped, respond: init => s.reply(init, 503, { error: 'seller_effect_pending' }) }).propose(bodyFor(P)),
    error => hostStopRefusal('stop_check_failed')(error) && error.cause === stopError && error.details?.suspensionWriteError === failure);
  assert.equal(suspension(s), undefined);
});

test('a stop refusal from the effect boundary of the wallet that reaches the continuation suspends queued work and is rethrown unchanged', async t => {
  for (const code of ['writes_stopped', 'stop_check_failed', 'stop_check_invalid', 'stop_check_timeout']) {
    const s = await storedWorld(t, { paid: true }); queueWork(s);
    const failure = new OperationError(code, `effect refused: ${code}`);
    const { service, request } = reader(s, { ...s.p.service, recheck() { throw failure; } });
    await assert.rejects(service.verifyDeal(request), error => error === failure);
    assert.equal(suspension(s).cause, code);
  }
});

test('a stopped public protocolRecheck or agreementSubmit given {operationId, token} records the suspension before it refuses, with or without queued work, and lifting the stop alone starts none of it', async t => {
  for (const [method, queued] of [['protocolRecheck', true], ['agreementSubmit', true], ['protocolRecheck', false], ['agreementSubmit', false]]) {
    const s = await storedWorld(t, { paid: true }); if (queued) queueWork(s);
    // The queued agreement submit takes this lane first; without the suspension, verifyDeal would continue into it.
    const journal = s.p.config.walletAgreement.journal, lock = journal.withWalletLock, agreementLanes = [];
    journal.withWalletLock = (key, work) => { if (key.startsWith('plugin/agreement/')) agreementLanes.push(key); return lock(key, work); };
    const stop = { now: true }, { service, request } = await stoppedReader(s, () => stop.now, { publicService: true });
    const portal = { operationId: request.operationId, token: request.token };
    await assert.rejects(service[method](portal), hostStopRefusal('writes_stopped'));
    const held = suspension(s);
    assert.equal(held?.cause, 'writes_stopped', method);
    await assert.rejects(service.protocolRecheck({ ...portal, resumeSuspensionId: held.id }), hostStopRefusal('writes_stopped'));
    assert.deepEqual(suspension(s), held, method);
    stop.now = false;
    const outcome = await service.verifyDeal(request).then(() => 'resolved', error => error);
    assert.deepEqual(agreementLanes, [], method); assert.equal(outcome, 'resolved', method);
    assert.deepEqual(suspension(s), held, method); assert.equal(s.fetches.length, 0, method);
  }
});

test('a stopped public sessionRenewal or sessionRenewalAccept given {operationId, token} suspends queued work before it refuses, and lifting the stop alone starts none of it', async t => {
  for (const method of ['sessionRenewal', 'sessionRenewalAccept']) {
    const s = await storedWorld(t, { paid: true }); queueWork(s);
    const journal = s.p.config.walletAgreement.journal, lock = journal.withWalletLock, agreementLanes = [];
    journal.withWalletLock = (key, work) => { if (key.startsWith('plugin/agreement/')) agreementLanes.push(key); return lock(key, work); };
    const stop = { now: true }, { service, request } = await stoppedReader(s, () => stop.now, { publicService: true });
    const portal = { operationId: request.operationId, token: request.token };
    await assert.rejects(service[method](portal), hostStopRefusal('writes_stopped'));
    const held = suspension(s);
    assert.equal(held?.cause, 'writes_stopped', method);
    stop.now = false;
    const outcome = await service.verifyDeal(request).then(() => 'resolved', error => error);
    assert.deepEqual(agreementLanes, [], method); assert.equal(outcome, 'resolved', method);
    assert.deepEqual(suspension(s), held, method); assert.equal(s.fetches.length, 0, method);
  }
});

test('a stopped token action whose token does not authenticate records nothing, even with the purchase\'s accountId; a stopped cancel suspends by account', async t => {
  for (const method of ['protocolRecheck', 'agreementSubmit', 'cancel']) {
    const s = await storedWorld(t, { paid: true }); queueWork(s);
    const { service, request } = await stoppedReader(s, () => true, { publicService: true });
    const before = s.p.get(), history = s.p.ops.history(s.p.op.id).length;
    const call = method === 'cancel' ? { accountId: request.accountId, operationId: request.operationId } : { ...request, token: 'TEST-wrong-token' };
    await assert.rejects(service[method](call), hostStopRefusal('writes_stopped'));
    if (method === 'cancel') { assert.equal(suspension(s).cause, 'writes_stopped'); continue; }
    assert.deepEqual(s.p.get(), before, method); assert.equal(s.p.ops.history(s.p.op.id).length, history, method);
  }
});

test('a stop that turns on while agreementSubmit waits on its network check suspends queued work before the call rejects', async t => {
  setPurchaseAdmission('testnet-tp1'); t.after(() => setPurchaseAdmission('held'));
  const { compositionWorld, ACCOUNT_ID } = await import('./helpers/public-composition-world.mjs');
  const { OFFLINE_AGREEMENT_PROFILE } = await import('../src/dacs/protocol-purchases.mjs');
  const stop = { now: false }, w = await compositionWorld(t, { stopped: () => stop.now });
  const p = w.seed({ status: 'agreement_pending', key: 'TEST-queued-mid-call', protocolTerms: { profile: OFFLINE_AGREEMENT_PROFILE },
    state: { protocol: { stage: 'agreement-signing', signatures: { agreement: 'TEST-queued-contribution' } } } });
  w.db.prepare('UPDATE operations SET handoff_expires_at = expires_at WHERE id = ?').run(p.operation.id);
  const networkIdentity = w.chain.networkIdentity;
  w.chain.networkIdentity = async (...args) => { stop.now = true; return networkIdentity(...args); };
  await assert.rejects(w.service.agreementSubmit({ operationId: p.operation.id, token: p.token }), hostStopRefusal('writes_stopped'));
  assert.equal(stop.now, true);
  assert.equal(w.ops.get(ACCOUNT_ID, p.operation.id).state.protocol.sellerSuspension?.cause, 'writes_stopped');
  assert.equal(w.counters.sellerLookups, 0);
});
