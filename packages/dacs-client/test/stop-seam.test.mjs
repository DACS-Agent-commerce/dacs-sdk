// The client's stop seam: `stopped` on both purchase factories, the suspension a stop records on the purchase, and
// the read-only `passiveOnly` composition. The hold is flipped through the test resolve hook; timers use mock.timers.
import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { storedWorld, PATHS, bodyFor, errorCode } from './helpers/stored-request-fixture.mjs';
import { setPurchaseAdmission, T0, PUBLIC_ENDPOINT } from './helpers/wire-client-fixture.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
import { spawnJournalChild } from './helpers/journal-child-process.mjs';

beforeEach((t) => t.mock.method(Date, 'now', () => T0));
const { compositionWorld, ACCOUNT_ID, NOW } = await import('./helpers/public-composition-world.mjs');
const { passiveNativeWorld, HASH } = await import('./helpers/passive-native-world.mjs');
const { admitPublicFactory, AUTHORITY_READ_DEADLINE_MS } = await import('../src/public-admission.mjs');
const { openDurableWalletJournal } = await import('../src/wallet/durable-journal.mjs');
const { StaleProtocolCheck } = await import('../src/dacs/protocol-purchases.mjs');
const { OperationError } = await import('../src/client-errors.mjs');
const client = await import('../src/index.mjs');
const { createSqlitePurchaseStore } = await import('../src/seams/purchase-store-not-wired.mjs');
const { createSellerHttpsClient } = await import('../src/dacs/seller-http.mjs');
const { createSellerHttpsConnector } = await import('../src/dacs/seller-https-connector.mjs');

const P = PATHS.proposals;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const stopRefusal = (code = 'writes_stopped', cause) => new OperationError(code, `TEST ${code}`, undefined, cause === undefined ? undefined : { cause });
const suspension = (s) => s.p.get().state.protocol.sellerSuspension;
const pending = (s) => s.client({ respond: (init) => s.reply(init, 503, { error: 'seller_effect_pending' }) });
const stoppedAnswer = (s) => s.client({ respond: (init) => s.reply(init, 503, { error: 'seller_stopped' }) });
const refuses = (code) => (error) => error.code === code;

// A stored purchase whose first attempt got an unknown answer, then the stop check says stopped before the retry.
async function retryThenStop(t, code = 'writes_stopped') {
  const s = await storedWorld(t);
  const sleep = s.clock.sleep;
  s.clock.sleep = async (ms) => { await sleep(ms); s.stop.check = async () => { throw stopRefusal(code); }; };
  await assert.rejects(pending(s).propose(bodyFor(P)), (error) => error.answerClass === 'unknown' && error.cause?.code === code);
  s.stop.check = async () => {};
  return s;
}

// A stored purchase whose request is signed and then stopped before its first byte.
async function signedThenStopped(t) {
  const s = await storedWorld(t);
  const { control } = s.w.requests;
  control.onStop = () => { if (s.w.state.signs.length > 0) control.stopped = true; };
  await assert.rejects(s.client().propose(bodyFor(P)), (error) => error.answerCode === 'writes_stopped');
  return s;
}

// A recording factory behind the real wrapper, admitted through a real binding.
async function admittedWrapper(t, stopped, events = []) {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const world = { events, ...await bindFixture() };
  const factory = () => ({ available: true, act: () => { events.push('act'); return 1; }, other: async () => { events.push('other'); return 2; }, read: () => { events.push('read'); return 3; } });
  world.admission = { binding: world.binding, currentLocal: world.currentLocal };
  world.wrapped = admitPublicFactory(factory, { stopSeam: true, passive: ['read'] })({ admission: world.admission, stopped });
  return world;
}

// The composed public objects with a stop check that counts its calls.
async function composed(t, { passiveOnly = false, native } = {}) {
  const stop = { answer: false, calls: 0 };
  const world = await compositionWorld(t, { passiveOnly, ...(native ? { native } : {}), stopped: () => { stop.calls++; return stop.answer; } });
  return { world, stop };
}
const transitionsAndTokens = (world) => {
  const counts = { transition: 0, handoffTokenFor: 0 };
  for (const name of Object.keys(counts)) {
    const original = world.ops[name];
    world.ops[name] = (...args) => { counts[name]++; return original.apply(world.ops, args); };
  }
  return counts;
};
// Seller lookups, chain broadcasts and every native-source signature, fetch, journal write and fence.
const effects = (world) => [world.counters.sellerLookups, world.chain.broadcasts, world.native.calls.length, world.native.writes.length, world.native.fences.acquired];
const AGREEMENT = { artifact: { jobId: '01HZY3K8V9Q2W4E6R7T8Y9X0AB', signatures: [{ value: 'TEST-signature-text' }] }, hash: 'a'.repeat(64) };
const NATIVE_TERMS = { profile: 'dacs-chatgpt-plugin/sr2-wallet-agreement/v1', jobId: AGREEMENT.artifact.jobId, nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment', sellerAgreementProjection: 'public-signed-create' };
const seedPending = (world, key = 'TEST-pending') => world.seed({ status: 'agreement_pending', key, protocolTerms: NATIVE_TERMS, state: { protocol: { stage: 'agreement-signing', agreement: AGREEMENT } } });

const PROTOCOL_PASSIVE = ['assertBuyerAccess', 'supportsMode', 'readIssued', 'readIssuedPayment', 'observeReportedPayment'];
const PROTOCOL_ACTIVE = ['holdChainReadback', 'prepareTerms', 'assertSellerAdmission', 'identityRequest', 'planRequest', 'runningPlan', 'planRunning', 'planFlightsRunning', 'signRequest',
  'submitAgreement', 'recheckCommitment', 'nativePaymentClaimed', 'nativePaymentTermsCancelled', 'nativePaymentRefused', 'cancelNativePayment', 'nativePaymentFailed', 'nativePaymentSuperseded',
  'nativeIntentsSupersededBy', 'withNativePaymentLane', 'readNativePaymentLane', 'checkDelivery', 'recheck', 'countersignRequest', 'countersign'];
const PROTOCOL_DATA = ['actionsAdmitted', 'available', 'chainReadback', 'nativePaymentReadbackAvailable'];
const SERVICE_PASSIVE = ['status', 'portalOperation', 'portalEvidence', 'verifyDeal', 'planRunning'];
const SERVICE_ACTIVE = ['prepare', 'issueApprovalChallenge', 'approve', 'prepareHandoff', 'nativePaymentLane', 'reportWalletResult', 'cancel', 'agreementIdentity', 'agreementPlan',
  'agreementSubmit', 'completionRequest', 'completionCountersign', 'protocolRecheck'];
const SERVICE_DATA = ['actionsAdmitted'];
const sorted = (names) => [...names].sort();

test('each purchase factory throws TypeError when stopped is absent', async () => {
  const { binding, currentLocal } = await bindFixture();
  let opens = 0;
  const touched = () => new Proxy({}, { get() { opens++; return () => {}; } });
  const options = { db: touched(), store: touched(), ops: touched(), coordinates: touched(), admission: { binding, currentLocal } };
  for (const factory of [client.createProtocolPurchases, client.createPurchaseService]) {
    assert.throws(() => factory(options), (error) => error instanceof TypeError && error.message === 'stopped_required', factory.name);
    for (const stopped of [undefined, null, false, 'false', {}]) {
      assert.throws(() => factory({ ...options, stopped }), (error) => error instanceof TypeError && error.message === 'stopped_required', factory.name);
    }
  }
  assert.equal(opens, 0);
});

test('passiveOnly accepts exactly true or nothing: any other value throws TypeError at construction', async () => {
  const { binding, currentLocal } = await bindFixture();
  const options = { store: client.createSqlitePurchaseStore(), admission: { binding, currentLocal }, stopped: () => false };
  for (const passiveOnly of [false, null, 1, 'true', {}]) {
    assert.throws(() => client.createProtocolPurchases({ ...options, passiveOnly }), (error) => error instanceof TypeError && error.message === 'passive_only_invalid');
  }
});

test('a stop seam that throws, rejects, stalls past 10,000 ms or answers a non-boolean counts as stopped with its cause', async (t) => {
  const failure = new Error('TEST-seam-failure');
  const cases = [['throws', () => { throw failure; }, 'stop_check_failed', failure], ['rejects', async () => { throw failure; }, 'stop_check_failed', failure],
    ['answers a string', () => 'false', 'stop_check_invalid'], ['resolves a number', async () => 0, 'stop_check_invalid'], ['answers true', () => true, 'writes_stopped']];
  for (const [name, seam, code, cause] of cases) {
    const world = await admittedWrapper(t, seam);
    await assert.rejects(world.wrapped.act(), (error) => error.code === code && (cause === undefined || error.cause === cause), name);
    assert.deepEqual(world.events, [], name);
  }
  const world = await admittedWrapper(t, () => new Promise(() => {}));
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  let settled = false;
  const outcome = assert.rejects(world.wrapped.act().finally(() => { settled = true; }), refuses('stop_check_timeout'));
  mock.timers.tick(AUTHORITY_READ_DEADLINE_MS - 1);
  await flush();
  assert.equal(settled, false);
  mock.timers.tick(1);
  await outcome;
  assert.deepEqual(world.events, []);
});

test('the seam is called beside the hold before every active public action, before dequeuing retries and before wallet-action handoffs', async (t) => {
  const events = [];
  const world = await admittedWrapper(t, () => { events.push('stop'); return false; }, events);
  world.authority.state.gate = async () => { events.push('binding'); };
  await world.wrapped.act();
  await world.wrapped.other();
  world.wrapped.read();
  assert.deepEqual(events, ['stop', 'binding', 'act', 'stop', 'binding', 'other', 'read']);
  events.length = 0;
  setPurchaseAdmission('held');
  await assert.rejects(world.wrapped.act(), refuses('profile_not_admitted'));
  assert.deepEqual(events, [], 'the hold is checked before the seam');

  const s = await storedWorld(t);
  let checks = 0;
  s.stop.check = async () => { checks++; };
  await assert.rejects(pending(s).propose(bodyFor(P)));
  assert.equal(s.fetches.length, 3);
  assert.equal(checks, 3, 'the seam is awaited before each attempt is taken off the queue');

  const { world: composedWorld, stop } = await composed(t);
  setPurchaseAdmission('testnet-tp1');
  await composedWorld.service.prepareHandoff({ accountId: ACCOUNT_ID }).catch(() => {});
  assert.equal(stop.calls, 1, 'a wallet-action handoff awaits the seam once');
});

test('stopped before approval: zero signatures and transmissions, writes_stopped', async (t) => {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const { world, stop } = await composed(t);
  const purchase = seedPending(world);
  stop.answer = true;
  const before = world.rows();
  for (const call of [() => world.service.approve({ accountId: ACCOUNT_ID, operationId: purchase.operation.id, token: purchase.token }), () => world.protocol.signRequest({})]) {
    await assert.rejects(call(), refuses('writes_stopped'));
  }
  assert.deepEqual(effects(world), [0, 0, 0, 0, 0]);
  assert.equal(world.rows(), before);
});

test('stopped after approval and before signing: zero signatures', async (t) => {
  const s = await storedWorld(t);
  s.w.requests.control.stopped = true;
  await assert.rejects(s.client().propose(bodyFor(P)), (error) => error.answerCode === 'writes_stopped' && error.cause?.code === 'writes_stopped');
  assert.equal(s.w.state.signs.length, 0);
  assert.equal(s.fetches.length, 0);
  assert.equal(suspension(s).cause, 'writes_stopped');
});

test('stopped after signing and before broadcast: signed-held, zero transmissions', async (t) => {
  const s = await signedThenStopped(t);
  assert.equal(s.w.state.signs.length, 1);
  assert.equal(s.fetches.length, 0);
  assert.ok((await s.w.requests.records()).some((record) => /held|withheld/.test(record.state)), 'the signature is retained as held');
  assert.equal(suspension(s).cause, 'writes_stopped');
});

test('stopped during recovery: readback only', async (t) => {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const { world, stop } = await composed(t);
  const purchase = seedPending(world);
  stop.answer = true;
  const request = { accountId: ACCOUNT_ID, operationId: purchase.operation.id, token: purchase.token };
  assert.ok((await world.service.verifyDeal(request)).verification, 'readback runs while stopped');
  assert.equal(world.ops.get(ACCOUNT_ID, purchase.operation.id).state.protocol.sellerSuspension.cause, 'writes_stopped', 'the continuation it refused is suspended');
  await assert.rejects(world.service.protocolRecheck(request), refuses('writes_stopped'));
  assert.deepEqual(effects(world), [0, 0, 0, 0, 0]);
});

test('a retry pending when the seam reports stopped stays suspended through seam recovery and restart until a new explicit request', async (t) => {
  const s = await retryThenStop(t);
  const held = suspension(s);
  assert.equal(held.cause, 'writes_stopped');
  assert.equal(s.fetches.length, 1);
  s.restart();
  await assert.rejects(s.client().propose(bodyFor(P)), errorCode('invalid_state'));
  assert.deepEqual(suspension(s), held);
  assert.equal(s.fetches.length, 1);
  s.records().resume(held.id);
  await s.client().propose(bodyFor(P));
  assert.equal(s.fetches.length, 2);
  assert.equal(s.fetches[1].body, s.fetches[0].body, 'the resumed request carries the stored bytes');
});

test('a signature returning after a stop is retained and never sent by automatic work or after restart', async (t) => {
  const s = await signedThenStopped(t);
  const { control } = s.w.requests;
  control.stopped = false;
  control.onStop = null;
  await assert.rejects(s.client().propose(bodyFor(P)), errorCode('invalid_state'));
  s.restart();
  s.w.requests.reopen();
  await assert.rejects(s.client().propose(bodyFor(P)), errorCode('invalid_state'));
  assert.equal(s.w.state.signs.length, 1, 'no second signature');
  assert.equal(s.fetches.length, 0);
  assert.ok((await s.w.requests.records()).length > 0, 'the retained signature survives the restart');
});

// The real connector over a request that completes its TLS handshake and writes nothing else; `change` runs once the request is opened, which is after signing.
function handshakeOnlyConnector(change) {
  const writes = [];
  const request = () => {
    const req = Object.assign(new EventEmitter(), { destroy() {}, end(body) { writes.push(body); setImmediate(() => req.emit('error', new Error('TEST nothing answers'))); } });
    const socket = Object.assign(new EventEmitter(), { destroy() {} });
    change();
    setImmediate(() => { req.emit('socket', socket); socket.emit('connect'); socket.emit('secureConnect'); });
    return req;
  };
  return { writes, connector: createSellerHttpsConnector({ resolveHost: async () => ['8.8.8.8'], request }) };
}

test('a stop caught by the connector before the first byte suspends the purchase, and nothing is sent after the stop lifts', async (t) => {
  const s = await storedWorld(t);
  const { control } = s.w.requests;
  const { writes, connector } = handshakeOnlyConnector(() => { control.stopped = true; });
  const client = () => createSellerHttpsClient({ publicEndpoint: PUBLIC_ENDPOINT, connector, authentication: s.auth, requestRecords: s.records(), clock: s.clock, commitOnSignature: true });
  await assert.rejects(client().propose(bodyFor(P)), (error) => error.answerClass === 'not-sent' && error.answerCode === 'writes_stopped' && error.cause?.code === 'writes_stopped');
  assert.equal(s.w.state.signs.length, 1);
  assert.equal(writes.length, 0);
  assert.equal(suspension(s).cause, 'writes_stopped');
  control.stopped = false;
  await assert.rejects(client().propose(bodyFor(P)), errorCode('invalid_state'));
  assert.equal(s.w.state.signs.length, 1, 'no second signature');
  assert.equal(writes.length, 0);
});

test('a re-hold caught while signing or by the connector before the first byte suspends the purchase, and nothing is sent after the hold lifts', async (t) => {
  t.after(() => setPurchaseAdmission('held'));
  const hold = () => setPurchaseAdmission('held');
  const holds = [['while signing', (s) => { s.w.requests.control.onStop = () => { if (s.w.state.signs.length > 0) hold(); }; return () => {}; }],
    ['in the connector', () => hold]];
  for (const [name, arrange] of holds) {
    setPurchaseAdmission('testnet-tp1');
    const s = await storedWorld(t);
    const { control } = s.w.requests;
    const { writes, connector } = handshakeOnlyConnector(arrange(s));
    const client = () => createSellerHttpsClient({ publicEndpoint: PUBLIC_ENDPOINT, connector, authentication: s.auth, requestRecords: s.records(), clock: s.clock, commitOnSignature: true });
    await assert.rejects(client().propose(bodyFor(P)), (error) => error.answerClass === 'not-sent' && error.answerCode === 'profile_not_admitted' && error.cause?.code === 'profile_not_admitted', name);
    assert.equal(suspension(s).cause, 'profile_not_admitted', name);
    control.onStop = null;
    setPurchaseAdmission('testnet-tp1');
    await assert.rejects(client().propose(bodyFor(P)), errorCode('invalid_state'), name);
    assert.equal(s.w.state.signs.length, 1, `${name}: no second signature`);
    assert.equal(writes.length, 0, name);
  }
});

test('a signed seller_stopped answer to a dispatched payment keeps the outcome unknown and suspends', async (t) => {
  const s = await storedWorld(t, { status: 'settled_verified', stage: 'payment-observed' });
  await assert.rejects(stoppedAnswer(s).request(PATHS.payments, bodyFor(PATHS.payments)), (error) => error.answerClass === 'suspended');
  assert.equal(s.p.get().status, 'settled_verified');
  assert.equal(suspension(s).cause, 'seller_stopped');
  assert.equal(s.record(PATHS.payments).lastClass, 'suspended');
  assert.equal(s.record(PATHS.payments).clearAttempts, 0);
});

test('a re-hold observed with queued work suspends it, and re-enabling resumes nothing', async (t) => {
  const s = await storedWorld(t);
  const sleep = s.clock.sleep;
  s.clock.sleep = async (ms) => { await sleep(ms); setPurchaseAdmission('held'); };
  await assert.rejects(pending(s).propose(bodyFor(P)), errorCode('profile_not_admitted'));
  const held = suspension(s);
  assert.equal(held.cause, 'profile_not_admitted');
  setPurchaseAdmission('testnet-tp1');
  s.restart();
  await assert.rejects(s.client().propose(bodyFor(P)), errorCode('invalid_state'));
  assert.deepEqual(suspension(s), held);
  assert.equal(s.fetches.length, 1);
});

test('an unobserved stop pulse records no suspension', async (t) => {
  const s = await storedWorld(t);
  const { control } = s.w.requests;
  s.w.state.signs = { push() { control.stopped = true; control.stopped = false; } };
  await s.client().propose(bodyFor(P));
  assert.equal(s.fetches.length, 1, 'the pass continues under its other checks');
  assert.equal(suspension(s), undefined);
});

test('a plugin-supplied lstat KILL check filling the seam is called at every boundary', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-kill-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const killPresent = () => {
    calls++;
    try { lstatSync(join(directory, 'KILL')); return true; } catch (error) { return error.code !== 'ENOENT'; }
  };
  const world = await admittedWrapper(t, killPresent);
  await world.wrapped.act();
  await world.wrapped.other();
  assert.equal(calls, 2);
  writeFileSync(join(directory, 'KILL'), '');
  await assert.rejects(world.wrapped.act(), refuses('writes_stopped'));
  assert.equal(calls, 3);
  assert.deepEqual(world.events, ['act', 'other']);
});

test('readback and read-only diagnostics run while stopped', async (t) => {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const { world, stop } = await composed(t);
  const { operation, token } = world.seed({ status: 'awaiting_approval', key: 'TEST-readback' });
  stop.answer = true;
  const before = world.rows();
  assert.ok((await world.service.verifyDeal({ accountId: ACCOUNT_ID, operationId: operation.id, token })).verification);
  assert.equal(world.service.status(ACCOUNT_ID, operation.id, token).operation.id, operation.id);
  assert.equal(world.service.portalOperation(operation.id, token).id, operation.id);
  assert.equal(typeof world.service.portalEvidence(operation.id, token).actionable, 'boolean');
  assert.doesNotThrow(() => world.protocol.supportsMode(operation));
  assert.equal(stop.calls, 0, 'no passive member calls the seam');
  assert.equal(world.rows(), before);
});

test('a stop observed before the first signature, and separately before dequeue, is durably suspended with no signature or dispatch record, and stays suspended with zero signatures and transmissions after the seam clears and the process restarts, even when a killed lane holder is reclaimed on reopen', async (t) => {
  const first = await storedWorld(t);
  first.stop.check = async () => { throw stopRefusal(); };
  await assert.rejects(first.client().propose(bodyFor(P)), refuses('writes_stopped'));
  const held = suspension(first);
  assert.equal(held.cause, 'writes_stopped');
  assert.deepEqual(await first.w.requests.records(), [], 'no signature or dispatch record exists');
  first.stop.check = async () => {};
  first.restart();
  await assert.rejects(first.client().propose(bodyFor(P)), errorCode('invalid_state'));
  assert.deepEqual([first.w.state.signs.length, first.fetches.length], [0, 0]);

  const second = await retryThenStop(t);
  const queued = suspension(second);
  assert.equal(queued.cause, 'writes_stopped');
  second.restart();
  await assert.rejects(second.client().propose(bodyFor(P)), errorCode('invalid_state'));
  assert.equal(second.fetches.length, 1);

  const lane = 'devnet/native-wallet/TEST-lane';
  t.mock.restoreAll(); // the child stamps its lock with the real clock
  const child = await spawnJournalChild(t, { path: first.w.requests.path });
  child.request('crashAfterRecord', { key: lane, record: { stage: 'broadcast-started', hash: 'TEST-hash' } });
  await child.event('recorded');
  assert.equal(await child.exited, 'SIGKILL');
  first.w.requests.reopen();
  await first.w.requests.journal.withWalletLock(lane, async () => {});
  assert.deepEqual(first.w.requests.journal.inspectLocks(), [], 'the dead holder\'s lock was reclaimed');
  first.restart();
  await assert.rejects(first.client().propose(bodyFor(P)), errorCode('invalid_state'));
  assert.deepEqual(suspension(first), held);
  assert.deepEqual([first.w.state.signs.length, first.fetches.length], [0, 0]);
});

test('a re-hold observed before signing, and a stop seam that fails, times out or answers invalid, suspend through the purchase record with their causes; the unobserved-pulse control records nothing', async (t) => {
  for (const code of ['stop_check_failed', 'stop_check_timeout', 'stop_check_invalid']) {
    const s = await retryThenStop(t, code);
    assert.equal(suspension(s).cause, code);
  }
  const rehold = await storedWorld(t);
  const sleep = rehold.clock.sleep;
  rehold.clock.sleep = async (ms) => { await sleep(ms); setPurchaseAdmission('held'); };
  await assert.rejects(pending(rehold).propose(bodyFor(P)), errorCode('profile_not_admitted'));
  assert.equal(suspension(rehold).cause, 'profile_not_admitted');
  setPurchaseAdmission('testnet-tp1');
  const control = await storedWorld(t);
  control.w.state.signs = { push() { control.w.requests.control.stopped = true; control.w.requests.control.stopped = false; } };
  await control.client().propose(bodyFor(P));
  assert.equal(suspension(control), undefined);
});

test('one table enumerates every method on the real objects returned by both purchase factories as active or passive; an unclassified method fails; each active method calls the stop seam beside the hold before any read or write and refuses writes_stopped; passive methods run; independently holding admission refuses active calls before effects', async (t) => {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const { world, stop } = await composed(t);
  const tables = [[world.protocol, PROTOCOL_ACTIVE, PROTOCOL_PASSIVE, PROTOCOL_DATA], [world.service, SERVICE_ACTIVE, SERVICE_PASSIVE, SERVICE_DATA]];
  for (const [object, active, passive, data] of tables) {
    assert.deepEqual(sorted(Object.keys(object)), sorted([...active, ...passive, ...data]), 'every member is classified');
    for (const name of active) assert.equal(object[name].name, 'admittedAction', `${name} is wrapped`);
    for (const name of passive) assert.notEqual(object[name].name, 'admittedAction', `${name} is not wrapped`);
  }
  const counts = transitionsAndTokens(world);
  const before = world.rows();
  stop.answer = true;
  for (const [object, active] of tables) {
    for (const name of active) await assert.rejects(object[name]({}), refuses('writes_stopped'), name);
  }
  assert.equal(stop.calls, PROTOCOL_ACTIVE.length + SERVICE_ACTIVE.length, 'one seam call per active call');
  assert.deepEqual([counts.transition, counts.handoffTokenFor, ...effects(world), world.contextReads.count], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(world.rows(), before);
  stop.answer = false;
  stop.calls = 0;
  setPurchaseAdmission('held');
  for (const [object, active] of tables) {
    for (const name of active) await assert.rejects(object[name]({}), refuses('profile_not_admitted'), name);
  }
  assert.equal(stop.calls, 0, 'the hold refuses before the seam is asked');
  assert.equal(world.rows(), before);
});

test('a passiveOnly purchase composition keeps all ten passive members callable while held, stopped and with a failing binding; every active name is absent and calling it throws TypeError before any read or write; without admission both factories still throw admission_required with zero SQLite, journal and custody opens', async (t) => {
  const { world, stop } = await composed(t, { passiveOnly: true });
  const purchase = seedPending(world);
  stop.answer = true;
  world.authority.state.failure = new Error('TEST-binding-failure');
  assert.deepEqual(sorted(Object.keys(world.protocol)), sorted([...PROTOCOL_PASSIVE, ...PROTOCOL_DATA]));
  assert.deepEqual(sorted(Object.keys(world.service)), sorted([...SERVICE_PASSIVE, ...SERVICE_DATA]));
  const before = world.rows();
  for (const [object, active] of [[world.protocol, PROTOCOL_ACTIVE], [world.service, SERVICE_ACTIVE]]) {
    for (const name of active) {
      assert.equal(object[name], undefined, name);
      assert.throws(() => object[name]({}), TypeError, name);
    }
  }
  for (const state of ['held', 'testnet-tp1']) {
    setPurchaseAdmission(state);
    const { operation, token } = purchase;
    assert.equal(world.service.status(ACCOUNT_ID, operation.id, token).operation.id, operation.id);
    assert.equal(world.service.portalOperation(operation.id, token).id, operation.id);
    assert.equal(typeof world.service.portalEvidence(operation.id, token).actionable, 'boolean');
    assert.equal(typeof world.service.planRunning, 'function');
    assert.ok((await world.service.verifyDeal({ accountId: ACCOUNT_ID, operationId: operation.id, token })).verification);
    assert.doesNotThrow(() => world.protocol.supportsMode(operation));
    world.protocol.assertBuyerAccess(operation.terms.buyer.wallet, operation);
    for (const name of ['readIssued', 'readIssuedPayment', 'observeReportedPayment']) assert.equal(typeof world.protocol[name], 'function', name);
  }
  assert.equal(stop.calls, 0);
  assert.equal(world.rows(), before);

  let opens = 0;
  const touched = () => new Proxy({}, { get() { opens++; return () => {}; } });
  const options = { db: touched(), store: touched(), ops: touched(), coordinates: touched(), journal: touched(), custody: touched(), passiveOnly: true, stopped: () => false };
  for (const factory of [client.createProtocolPurchases, client.createPurchaseService]) {
    assert.throws(() => factory(options), (error) => error instanceof TypeError && error.message === 'admission_required', factory.name);
  }
  assert.equal(opens, 0);
});

test('passiveOnly portalOperation projects an elapsed approval as expired without ops.transition, signatures, seller requests or wallet actions after the hold lifts; status and portalEvidence in the same composition return approvalUrl null and actionable false without calling ops.handoffTokenFor', async (t) => {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const { world } = await composed(t, { passiveOnly: true });
  const purchase = world.seed({ status: 'awaiting_approval', key: 'TEST-elapsed', expiresAt: new Date(NOW - 1000).toISOString() });
  const counts = transitionsAndTokens(world);
  const before = world.rows();
  const { operation, token } = purchase;
  assert.equal(world.service.portalOperation(operation.id, token).status, 'expired');
  const status = world.service.status(ACCOUNT_ID, operation.id, token);
  assert.equal(status.approvalUrl, null);
  assert.equal(world.service.portalEvidence(operation.id, token).actionable, false);
  assert.deepEqual([counts.transition, counts.handoffTokenFor, ...effects(world)], [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(world.rows(), before);
});

test('passiveOnly verifyDeal returns diagnostic readback after the hold lifts and never attaches a hash, settles, rechecks, continues, signs or sends', async (t) => {
  setPurchaseAdmission('testnet-tp1');
  t.after(() => setPurchaseAdmission('held'));
  const { world } = await composed(t, { passiveOnly: true });
  const purchase = seedPending(world);
  const counts = transitionsAndTokens(world);
  const before = world.rows();
  const request = { accountId: ACCOUNT_ID, operationId: purchase.operation.id, token: purchase.token };
  assert.ok((await world.service.verifyDeal(request)).verification, 'a readback is returned');
  await assert.rejects(world.service.verifyDeal({ ...request, txHash: HASH }), refuses('invalid_state'), 'a hash is never attached');
  assert.equal(world.counters.buyerAccess, 2, 'only each readback\'s own access check ran; no continuation');
  assert.deepEqual([counts.transition, ...effects(world)], [0, 0, 0, 0, 0, 0]);
  assert.equal(world.rows(), before);
});

test('with a supplied source capability, passiveOnly readIssued, readIssuedPayment, observeReportedPayment and chainReadback readers, held and after the hold lifts, change no journal record, send only read-only node calls, and take only the source-read lock; its row is gone after each return or throw, though meta.fence advances', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'TEST-source-read-'));
  const journal = openDurableWalletJournal({ path: join(directory, 'journal.sqlite'), mode: 'create' });
  const native = passiveNativeWorld({ journal });
  t.after(async () => { await native.source.close(); journal.close(); rmSync(directory, { recursive: true, force: true }); });
  await native.seed();
  const fenceOf = () => {
    const db = new DatabaseSync(join(directory, 'journal.sqlite'), { readOnly: true });
    try { return Number(db.prepare("SELECT value FROM meta WHERE key = 'fence'").get().value); } finally { db.close(); }
  };
  const { world } = await composed(t, { passiveOnly: true, native });
  const purchase = world.seed({ status: 'settled_verified', key: 'TEST-source', protocolTerms: NATIVE_TERMS, reportedTxHash: HASH, state: { protocol: { stage: 'seller-committed', agreement: AGREEMENT } } });
  const recordsBefore = await journal.entries();
  const reads = [() => world.protocol.readIssued(purchase.operation), () => world.protocol.readIssuedPayment(purchase.operation, HASH), () => world.protocol.observeReportedPayment(HASH),
    () => world.protocol.chainReadback.readCommitment({}), () => world.protocol.chainReadback.readDeliverable({}), () => world.protocol.chainReadback.readDeliveryEvidence({})];
  const fenceStart = fenceOf();
  for (const state of ['held', 'testnet-tp1']) {
    setPurchaseAdmission(state);
    for (const read of reads) {
      await Promise.resolve().then(read).catch(() => {});
      assert.deepEqual(journal.inspectLocks(), [], 'no lock row outlives a read');
    }
  }
  t.after(() => setPurchaseAdmission('held'));
  assert.deepEqual(await journal.entries(), recordsBefore, 'no journal record changed');
  assert.deepEqual(native.writes, []);
  assert.ok(native.calls.length > 0, 'the node was read');
  assert.ok(native.calls.every((message) => !/broadcast|confirm|execute|submit|send/i.test(message)), `only read-only node calls: ${native.calls.join(',')}`);
  assert.ok(fenceOf() > fenceStart, 'the journal fence advanced');
});

test('a stop whose suspension write fails is refused with the write failure as its cause, records no suspension, and lets the next request through', async (t) => {
  const s = await storedWorld(t);
  const writeFailure = new Error('TEST-suspension-write-failed');
  s.stop.check = async () => { throw stopRefusal(); };
  const failing = s.records(s.holder, () => { throw writeFailure; });
  await assert.rejects(s.client({ requestRecords: failing }).propose(bodyFor(P)), (error) => error.code === 'writes_stopped' && error.cause === writeFailure);
  assert.equal(suspension(s), undefined, 'nothing was acknowledged');
  assert.equal(s.fetches.length, 0);
  s.stop.check = async () => {};
  s.restart();
  await s.client().propose(bodyFor(P));
  assert.equal(s.fetches.length, 1);
});

test('a signed seller_stopped answer whose suspension write fails keeps the dispatched payment unknown, never failed, and a repeat sends the stored bytes', async (t) => {
  const s = await storedWorld(t, { status: 'settled_verified', stage: 'payment-observed' });
  const writeFailure = new Error('TEST-suspension-write-failed');
  const { transaction } = createSqlitePurchaseStore();
  let writes = 0;
  const failingSecondWrite = s.records(s.holder, (db, work) => { if (++writes === 2) throw writeFailure; return transaction(db, work); });
  await assert.rejects(s.client({ requestRecords: failingSecondWrite, respond: (init) => s.reply(init, 503, { error: 'seller_stopped' }) }).request(PATHS.payments, bodyFor(PATHS.payments)), (error) => error.answerClass === 'suspended' && error.cause === writeFailure);
  s.restart();
  assert.equal(s.p.get().status, 'settled_verified');
  assert.equal(s.record(PATHS.payments).lastClass, 'unknown');
  assert.equal(s.record(PATHS.payments).attempts, 1);
  assert.equal(suspension(s), undefined);
  await s.client().request(PATHS.payments, bodyFor(PATHS.payments));
  assert.equal(s.fetches[1].body, s.fetches[0].body, 'the repeat carries the stored bytes');
  assert.equal(s.record(PATHS.payments).attempts, 2);
});

test('two explicit resume requests for one suspension have one winner by compare-and-set, and the resumed send reuses the stored bytes after a restart', async (t) => {
  const s = await storedWorld(t, { paid: true });
  await assert.rejects(stoppedAnswer(s).propose(bodyFor(P)), (error) => error.answerClass === 'suspended');
  const { id } = suspension(s);
  const history = s.record(P);
  s.records().resume(id);
  assert.throws(() => s.records().resume(id), (error) => error instanceof StaleProtocolCheck);
  s.restart();
  assert.equal(suspension(s), undefined);
  assert.deepEqual(s.record(P), history, 'the earlier dispatch history is kept');
  assert.equal(s.fetches.length, 1, 'nothing resumes by itself');
  await s.client().propose(bodyFor(P));
  assert.equal(s.fetches.length, 2);
  assert.equal(s.fetches[1].body, s.fetches[0].body);
});
