// The client's stop seam: where a host stop or a re-hold is recorded as the purchase's suspension, and what clears it.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { storedWorld, PATHS, bodyFor, errorCode } from './helpers/stored-request-fixture.mjs';
import { setPurchaseAdmission, T0, FIXTURE_RECEIPT_LIMITS } from './helpers/wire-client-fixture.mjs';
import { spawnJournalChild } from './helpers/journal-child-process.mjs';
import { controlledClock, settleUntil } from './helpers/effect-boundary-fixture.mjs';
import { passiveNativeWorld, HASH as NATIVE_HASH, PAYER } from './helpers/passive-native-world.mjs';
import { bindFixture } from './fixtures/tp1-authority-reader.mjs';
beforeEach(t => t.mock.method(Date, 'now', () => T0));
const { createPurchaseService } = await import('../src/purchases.mjs');
const { createProtocolPurchases, createPurchaseService: createAdmittedPurchaseService } = await import('../src/index.mjs');
const { createSqlitePurchaseStore } = await import('../src/seams/purchase-store-not-wired.mjs');
const { StaleProtocolCheck, OFFLINE_AGREEMENT_PROFILE } = await import('../src/dacs/protocol-purchases.mjs');
const { createHostStop, bindHostStop, isHostStopRefusal } = await import('../src/host-stop.mjs');
const { OperationError } = await import('../src/client-errors.mjs');
const { SellerUnavailableError } = await import('../src/dacs/seller-http.mjs');
const { createSellerHttpsConnector } = await import('../src/dacs/seller-https-connector.mjs');
const { AUTHORITY_READ_DEADLINE_MS } = await import('../src/public-admission.mjs');
const { openDurableWalletJournal } = await import('../src/wallet/durable-journal.mjs');
const P = PATHS.proposals;
const suspension = s => s.p.get().state.protocol.sellerSuspension;
const events = (s, type) => s.p.ops.history(s.p.op.id).filter(event => event.type === type);
const hostStopRefusal = code => error => error.code === code && error.message === `host stop refused: ${code}`;
const queueWork = s => s.patch({ signatures: { agreement: 'TEST-queued-contribution' } });

// The purchase service over the public protocol factory, both built with `stopped`; seller lookups are counted.
// `ops` is the service's own operation store.
function stoppedService(s, stopped, ops = s.p.ops) {
  const counters = { sellerLookups: 0 };
  const dacsProtocol = { ...s.p.config, sellerEndpoint: (...args) => { counters.sellerLookups++; return s.p.config.sellerEndpoint(...args); } };
  const protocol = createProtocolPurchases({ db: s.p.db, ops: s.p.ops, coordinates: { unresolvedForSender: () => [] }, dacsProtocol, admission: s.w.admission,
    store: createSqlitePurchaseStore(), now: () => s.w.state.time, buyerAccess: { assertWallet() {} }, stopped,
    feeCeilingOs: '50000000000', chain: { getTransactionFees: async () => 1n }, ...FIXTURE_RECEIPT_LIMITS });
  s.p.db.prepare('UPDATE operations SET handoff_expires_at = expires_at WHERE id = ?').run(s.p.op.id);
  const service = createPurchaseService({ db: s.p.db, ops, coordinates: { get: () => null }, protocol, chain: { broadcastTransaction() { throw new Error('TEST-unexpected-broadcast'); } },
    config: {}, store: createSqlitePurchaseStore(), now: () => s.w.state.time, purposes: { APPROVE_PURCHASE: 'TEST-approve' }, stopped });
  const request = { accountId: s.p.op.accountId, operationId: s.p.op.id, token: s.p.ops.handoffTokenFor(s.p.op.id) };
  return { service, request, counters };
}

// A plugin's KILL check: a synchronous lstat of a stop file, counting its calls.
function killFile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stop-seam-kill-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const kill = { path: join(directory, 'KILL'), calls: 0 };
  kill.stopped = () => {
    kill.calls++;
    try { lstatSync(kill.path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  };
  kill.create = () => writeFileSync(kill.path, '');
  return kill;
}

// The public composition admitted through a real binding, with the hold lifted.
async function admittedComposition(t, stopped) {
  setPurchaseAdmission('testnet-tp1'); t.after(() => setPurchaseAdmission('held'));
  const { compositionWorld } = await import('./helpers/public-composition-world.mjs');
  return compositionWorld(t, { stopped });
}

// A composition admitted through a real binding, with one seeded agreement_pending protocol purchase and nothing queued.
async function composedPurchase(t, stopped, key) {
  const { ACCOUNT_ID } = await import('./helpers/public-composition-world.mjs');
  const w = await admittedComposition(t, stopped);
  const p = w.seed({ status: 'agreement_pending', key, protocolTerms: { profile: OFFLINE_AGREEMENT_PROFILE }, state: { protocol: { stage: 'agreement-signing' } } });
  w.db.prepare('UPDATE operations SET handoff_expires_at = expires_at WHERE id = ?').run(p.operation.id);
  const portal = { operationId: p.operation.id, token: p.token };
  return { w, portal, account: { accountId: ACCOUNT_ID, ...portal },
    row: () => w.ops.get(ACCOUNT_ID, p.operation.id), events: type => w.ops.history(p.operation.id).filter(event => event.type === type) };
}

// The real seller connector over a stand-in TLS request: the handshake completes with no network, `onHandshake` runs
// just before the connector's transmit step (the signed request's last checks), and each body it writes is kept.
function handshakeConnector(onHandshake = () => {}) {
  const written = [];
  const request = () => {
    const req = new EventEmitter(), socket = new EventEmitter();
    req.destroy = () => {}; socket.destroy = () => {};
    req.end = body => { written.push(body); req.emit('error', new Error('TEST-no-answer')); };
    queueMicrotask(() => { req.emit('socket', socket); onHandshake(); socket.emit('secureConnect'); });
    return req;
  };
  return { written, connector: createSellerHttpsConnector({ resolveHost: async () => ['8.8.8.8'], request }) };
}
const effectStates = async s => (await s.w.requests.records()).map(record => record.state);
const storedText = s => Buffer.from(s.record(P).bodyB64, 'base64url').toString();

// A restart with the stop or hold lifted: a retry of the stored request and verifyDeal sign and send nothing, and the
// purchase keeps the suspension `held`. Returns the service and a wire authentication over the reopened journal.
async function staysSuspendedAfterRestart(s, held) {
  s.restart(); s.w.requests.reopen();
  const signs = s.w.state.signs.length, fetches = s.fetches.length;
  const authentication = s.w.createSellerWireAuthentication({ ...s.w.options, effectBoundary: s.w.requests.boundary });
  await assert.rejects(s.client({ authentication }).propose(bodyFor(P)), errorCode('invalid_state'));
  const { service, request, counters } = stoppedService(s, () => false);
  await service.verifyDeal(request);
  assert.deepEqual(suspension(s), held); assert.equal(counters.sellerLookups, 0);
  assert.equal(s.w.state.signs.length, signs); assert.equal(s.fetches.length, fetches);
  assert.equal(events(s, 'seller_resumed').length, 0);
  return { service, request, authentication };
}

test('a stop observed before the first signature, and separately before dequeue, is durably suspended with no signature or dispatch record; after the seam clears and the process restarts, timers and retries make zero signatures and transmissions until a new explicit request. A real child killed while it holds the operation\'s wallet lane, after the suspension was recorded: on reopen the journal reclaims the provably dead lock, and the suspension still holds with zero signatures and transmissions', async t => {
  const stop = { now: true }, stopped = () => stop.now;
  // Before the first signature: a seller request on a purchase with nothing queued.
  const first = await storedWorld(t, { paid: true });
  await assert.rejects(first.client({ stopped }).propose(bodyFor(P)), hostStopRefusal('writes_stopped'));
  // Before dequeue: a queued contribution that verifyDeal's continuation would send.
  const second = await storedWorld(t, { paid: true }); queueWork(second);
  const { service: secondService, request: secondRequest } = stoppedService(second, stopped);
  await secondService.verifyDeal(secondRequest);
  const worlds = [first, second], held = worlds.map(suspension);
  for (const s of worlds) {
    assert.equal(suspension(s).cause, 'writes_stopped');
    assert.deepEqual(s.p.get().state.protocol.sellerRequests ?? {}, {});
    assert.deepEqual(await s.w.requests.records(), []);
    assert.equal(s.w.state.signs.length, 0); assert.equal(s.fetches.length, 0);
  }
  // A real child holds the operation's wallet lane in the request journal and is killed there.
  const lane = `plugin/agreement/${first.p.op.id}`;
  const child = await spawnJournalChild(t, { path: first.w.requests.path });
  child.request('hold', { key: lane });
  await child.event('locked');
  child.kill();
  assert.equal(await child.exited, 'SIGKILL');
  stop.now = false;
  for (const s of worlds) { s.restart(); s.w.requests.reopen(); }
  // The journal proves the holder dead against the real clock.
  Date.now.mock.restore();
  assert.deepEqual(first.w.requests.journal.inspectLocks().map(row => [row.key, row.instance, row.holder]), [[lane, child.instance, 'exited']]);
  await first.w.requests.journal.withWalletLock(lane, async () => {});
  assert.deepEqual(first.w.requests.journal.inspectLocks(), []);
  t.mock.method(Date, 'now', () => T0);
  for (const [index, s] of worlds.entries()) {
    const { service, request, counters } = stoppedService(s, stopped);
    await assert.rejects(s.client({ stopped }).propose(bodyFor(P)), errorCode('invalid_state'));
    const result = await service.verifyDeal(request);
    assert.deepEqual(result.operation.state.protocol.sellerSuspension, held[index]);
    assert.deepEqual(suspension(s), held[index]); assert.equal(counters.sellerLookups, 0);
    assert.equal(s.w.state.signs.length, 0); assert.equal(s.fetches.length, 0);
    assert.deepEqual(await s.w.requests.records(), []);
    assert.equal(events(s, 'seller_resumed').length, 0);
  }
  // Only a new explicit request naming the suspension resumes it, and the next request goes out.
  const { service, request } = stoppedService(first, stopped);
  await service.protocolRecheck({ ...request, resumeSuspensionId: held[0].id });
  assert.equal(suspension(first), undefined); assert.equal(events(first, 'seller_resumed').length, 1);
  // The request is signed through the effect boundary over the reopened journal.
  const authentication = first.w.createSellerWireAuthentication({ ...first.w.options, effectBoundary: first.w.requests.boundary });
  await first.client({ authentication }).propose(bodyFor(P));
  assert.equal(first.fetches.length, 1);
});

test('a plugin-supplied lstat KILL check filling the seam is called at every boundary', async t => {
  // The public gate, verifyDeal's entry and the continuation.
  const gateKill = killFile(t);
  const c = await composedPurchase(t, gateKill.stopped, 'TEST-kill-gate');
  let before = gateKill.calls;
  await assert.rejects(c.w.service.protocolRecheck({ operationId: '', token: '' }), error => error.code !== 'writes_stopped');
  assert.equal(gateKill.calls - before, 2, 'the gate reads the check before and after the binding read');
  before = gateKill.calls;
  let continuationCalls;
  c.w.authority.state.gate = async () => { c.w.authority.state.gate = null; continuationCalls = gateKill.calls - before; };
  await c.w.service.verifyDeal(c.account).catch(() => {});
  assert.equal(continuationCalls, 3, "verifyDeal's entry, the continuation, then the protocol gate before its binding read");
  gateKill.create();
  before = gateKill.calls;
  await assert.rejects(c.w.service.protocolRecheck(c.portal), hostStopRefusal('writes_stopped'));
  assert.equal(gateKill.calls - before, 1);
  assert.equal(c.row().state.protocol.sellerSuspension?.cause, 'writes_stopped');
  assert.equal(c.row().state.protocol.signatures, undefined);
  // The request records and the wire signer.
  const wireKill = killFile(t), s = await storedWorld(t), client = s.client({ stopped: wireKill.stopped });
  await client.propose(bodyFor(P));
  assert.equal(wireKill.calls, 4, 'start, the wire request, the session signature step and the pre-send check');
  assert.equal(s.fetches.length, 1);
  const sent = s.record(P);
  wireKill.create();
  before = wireKill.calls;
  await assert.rejects(client.propose(bodyFor(P)), hostStopRefusal('writes_stopped'));
  assert.equal(wireKill.calls - before, 1, 'start refuses before anything is stored');
  assert.deepEqual(s.record(P), sent); assert.equal(s.fetches.length, 1);
  assert.equal(suspension(s).cause, 'writes_stopped');
});

test('a second stop seen on a purchase that is already suspended keeps the first suspension and its id, and a resume naming that id clears it', async t => {
  const s = await storedWorld(t);
  await assert.rejects(s.client({ stopped: () => true }).propose(bodyFor(P)), hostStopRefusal('writes_stopped'));
  const first = suspension(s);
  s.holder.set(queueWork(s));
  await assert.rejects(s.client({ stopped: () => true }).propose(bodyFor(P)), hostStopRefusal('writes_stopped'));
  s.records().suspend('profile_not_admitted');
  assert.deepEqual(suspension(s), first);
  assert.equal(events(s, 'seller_suspended').length, 1);
  s.records().resume(first.id);
  assert.equal(suspension(s), undefined); assert.equal(events(s, 'seller_resumed').length, 1);
});

test('a stop seen by the continuation on a purchase with no queued work records the suspension, and lifting the stop starts nothing until protocolRecheck names it', async t => {
  const s = await storedWorld(t, { paid: true }), stop = { now: false };
  const { service, request, counters } = stoppedService(s, () => stop.now);
  // The barrier is the authority read inside the continuation's protocol.recheck, after verifyDeal's entry.
  s.w.state.gate = async () => { s.w.state.gate = null; stop.now = true; };
  await assert.rejects(service.verifyDeal(request), hostStopRefusal('writes_stopped'));
  const held = suspension(s);
  assert.equal(held.cause, 'writes_stopped');
  assert.equal(s.p.get().state.protocol.signatures, undefined);
  stop.now = false;
  await service.verifyDeal(request);
  await service.protocolRecheck(request);
  assert.deepEqual(suspension(s), held); assert.equal(counters.sellerLookups, 0);
  assert.equal(s.w.state.signs.length, 0); assert.equal(s.fetches.length, 0);
  await service.protocolRecheck({ ...request, resumeSuspensionId: held.id });
  assert.equal(suspension(s), undefined); assert.equal(events(s, 'seller_resumed').length, 1);
});

test('a stopped public protocolRecheck on an agreement_pending purchase with no queued work records the suspension, and lifting the stop continues nothing until protocolRecheck names it', async t => {
  const stop = { now: true }, c = await composedPurchase(t, () => stop.now, 'TEST-unqueued-gate');
  await assert.rejects(c.w.service.protocolRecheck(c.portal), hostStopRefusal('writes_stopped'));
  const held = c.row().state.protocol.sellerSuspension;
  assert.equal(held?.cause, 'writes_stopped');
  stop.now = false;
  await c.w.service.protocolRecheck(c.portal);
  await c.w.service.verifyDeal(c.account);
  assert.deepEqual(c.row().state.protocol.sellerSuspension, held);
  assert.equal(c.w.counters.sellerLookups, 0); assert.equal(c.events('seller_resumed').length, 0);
  // The named call's own later outcome rests on the fixture's stand-in session signer, so only the resume is asserted.
  await c.w.service.protocolRecheck({ ...c.portal, resumeSuspensionId: held.id }).catch(() => {});
  assert.equal(c.row().state.protocol.sellerSuspension, undefined); assert.equal(c.events('seller_resumed').length, 1);
});

test('a host stop or a re-hold seen when a durable seller request starts records the suspension with no queued work, and the same refusal on a read route records none', async t => {
  const refusals = [
    ['writes_stopped', s => s.client({ stopped: () => true })],
    ['profile_not_admitted', s => { setPurchaseAdmission('held'); return s.client(); }],
  ];
  for (const [cause, clientOf] of refusals) {
    const durable = await storedWorld(t), before = durable.p.get().state.protocol.revision ?? 0;
    await assert.rejects(clientOf(durable).propose(bodyFor(P)), errorCode(cause));
    assert.equal(suspension(durable)?.cause, cause, cause);
    assert.equal(suspension(durable).path, P, cause);
    assert.equal(durable.record(P), undefined, cause);
    assert.equal(durable.p.get().state.protocol.revision, before + 1, cause);
    const read = await storedWorld(t), unchanged = read.p.get();
    await assert.rejects(clientOf(read).request(PATHS.state, bodyFor(PATHS.state)), errorCode(cause));
    assert.deepEqual(read.p.get(), unchanged, cause);
    assert.equal(read.fetches.length + durable.fetches.length, 0, cause);
  }
});

test('a stop at a first request whose suspension write fails rejects with the stop itself, carries the write failure as details.suspensionWriteError, records nothing, and the next stopped request records it', async t => {
  const s = await storedWorld(t), failure = new Error('TEST-store-write-failed'), before = s.p.get();
  const { transaction } = createSqlitePurchaseStore(), write = { fails: true };
  const records = s.records(s.holder, (db, work) => transaction(db, () => {
    const result = work();
    if (write.fails && suspension(s)) throw failure;
    return result;
  }), createHostStop(() => true));
  await assert.rejects(s.client({ requestRecords: records, stopped: () => true }).propose(bodyFor(P)),
    error => hostStopRefusal('writes_stopped')(error) && error.cause === undefined && error.details?.suspensionWriteError === failure);
  assert.deepEqual(s.p.get(), before);
  assert.equal(s.w.state.signs.length, 0); assert.equal(s.fetches.length, 0);
  write.fails = false;
  await assert.rejects(s.client({ requestRecords: records, stopped: () => true }).propose(bodyFor(P)),
    error => hostStopRefusal('writes_stopped')(error) && error.details === undefined);
  assert.equal(suspension(s).cause, 'writes_stopped'); assert.equal(s.record(P), undefined);
});

test('a signed seller_stopped answer whose suspension write fails keeps the dispatched payment unknown, never failed, and a repeat sends the stored bytes', async t => {
  const s = await storedWorld(t, { status: 'settled_verified', stage: 'payment-observed' }), failure = new Error('TEST-store-write-failed');
  const { transaction } = createSqlitePurchaseStore();
  const records = s.records(s.holder, (db, work) => transaction(db, () => {
    const result = work();
    if (suspension(s)) throw failure;
    return result;
  }));
  const client = s.client({ requestRecords: records, respond: init => s.reply(init, 503, { error: 'seller_stopped' }) });
  await assert.rejects(client.request(PATHS.payments, bodyFor(PATHS.payments)), error => error.answerClass === 'suspended' && error.cause === failure);
  assert.equal(s.p.get().status, 'settled_verified'); assert.equal(suspension(s), undefined);
  assert.equal(s.record(PATHS.payments).lastClass, 'unknown');
  assert.equal(s.record(PATHS.payments).attempts, 1); assert.equal(s.record(PATHS.payments).clearAttempts, 0);
  s.restart();
  await s.client().request(PATHS.payments, bodyFor(PATHS.payments));
  assert.equal(s.fetches.length, 2); assert.equal(s.fetches[1].body, s.fetches[0].body);
});

test('two explicit resume requests for one suspension have one winner by compare-and-set, and the resumed send reuses the stored bytes after a restart', async t => {
  const s = await storedWorld(t, { paid: true });
  await assert.rejects(s.client({ respond: init => s.reply(init, 503, { error: 'seller_stopped' }) }).propose(bodyFor(P)), error => error.answerClass === 'suspended');
  const held = suspension(s), seen = s.p.get();
  s.restart();
  const resumeFrom = () => s.records({ get: () => seen, set() {} }).resume(held.id);
  resumeFrom();
  assert.throws(resumeFrom, error => error instanceof StaleProtocolCheck);
  assert.equal(suspension(s), undefined); assert.equal(events(s, 'seller_resumed').length, 1);
  s.restart();
  await s.client().propose(bodyFor(P));
  assert.equal(s.fetches.length, 2); assert.equal(s.fetches[1].body, s.fetches[0].body);
});

test('stopped after approval and before signing: zero signatures', async t => {
  const s = await storedWorld(t, { paid: true }), control = s.w.requests.control;
  // The records' reads at start and at the wire's request entry answer not stopped; the stop turns on at the effect boundary's own check.
  control.onStop = () => { control.stopped = true; };
  await assert.rejects(s.client({ stopped: () => false }).propose(bodyFor(P)),
    error => error instanceof OperationError && error.code === 'writes_stopped' && error.answerClass === undefined);
  assert.equal(s.w.state.signs.length, 0); assert.equal(s.fetches.length, 0);
  const held = suspension(s);
  assert.equal(held.cause, 'writes_stopped'); assert.equal(held.path, P);
  assert.equal(s.record(P).lastClass, 'unknown');
  control.onStop = null; control.stopped = false;
  const { service, request } = await staysSuspendedAfterRestart(s, held);
  await service.protocolRecheck({ ...request, resumeSuspensionId: held.id });
  assert.equal(suspension(s), undefined); assert.equal(events(s, 'seller_resumed').length, 1);
});

test('stopped after signing and before broadcast: signed-held, zero transmissions', async t => {
  const s = await storedWorld(t), control = s.w.requests.control;
  const { connector, written } = handshakeConnector(() => { control.stopped = true; });
  await assert.rejects(s.client({ connector }).propose(bodyFor(P)),
    error => error instanceof OperationError && error.code === 'writes_stopped' && !(error instanceof SellerUnavailableError));
  assert.equal(written.length, 0); assert.equal(s.w.state.signs.length, 1);
  assert.deepEqual(await effectStates(s), ['signed', 'signed-held']);
  assert.equal(s.record(P).lastClass, 'unknown'); assert.equal(s.record(P).attempts, 1);
  assert.equal(suspension(s).cause, 'writes_stopped');
});

test('a signature returning after a stop is retained and never sent by automatic work or after restart', async t => {
  const s = await storedWorld(t, { paid: true }), control = s.w.requests.control;
  const signer = s.w.options.sessionSigner;
  const sessionSigner = { claim: signer.claim, sign: bytes => { control.stopped = true; return signer.sign(bytes); } };
  const authentication = s.w.createSellerWireAuthentication({ ...s.w.options, sessionSigner });
  await assert.rejects(s.client({ authentication }).propose(bodyFor(P)), error => error instanceof OperationError && error.code === 'writes_stopped');
  assert.equal(s.w.state.signs.length, 1); assert.equal(s.fetches.length, 0);
  assert.deepEqual(await effectStates(s), ['signed', 'signed-held']);
  const held = suspension(s), stored = storedText(s);
  assert.equal(held.cause, 'writes_stopped');
  control.stopped = false;
  const { service, request, authentication: reopened } = await staysSuspendedAfterRestart(s, held);
  assert.deepEqual(await effectStates(s), ['signed', 'signed-held'], 'the signature stays retained and unreleased');
  // Only a new explicit request naming the suspension continues, and the next send carries the stored request bytes.
  await service.protocolRecheck({ ...request, resumeSuspensionId: held.id });
  assert.equal(suspension(s), undefined);
  await s.client({ authentication: reopened }).propose(bodyFor(P));
  assert.equal(s.fetches.length, 1); assert.equal(s.fetches[0].body, stored);
});

test("a stop caught by the connector before the first byte suspends the purchase, rejects with the stop's own OperationError, and nothing is sent after the stop lifts", async t => {
  const s = await storedWorld(t, { paid: true }), control = s.w.requests.control;
  const { connector, written } = handshakeConnector(() => { control.stopped = true; });
  const client = s.client({ connector });
  await assert.rejects(client.propose(bodyFor(P)), error => error instanceof OperationError && error.code === 'writes_stopped' && error.message === 'effect refused: writes_stopped');
  const held = suspension(s);
  assert.equal(held.cause, 'writes_stopped');
  control.stopped = false;
  await assert.rejects(client.propose(bodyFor(P)), errorCode('invalid_state'));
  await staysSuspendedAfterRestart(s, held);
  assert.equal(written.length, 0); assert.equal(s.fetches.length, 0);
});

test('a re-hold caught while signing or by the connector before the first byte suspends the purchase, still reaches the caller as SellerUnavailableError not-sent, and nothing is sent after the hold lifts, also after a restart', async t => {
  const legs = [
    // The hold turns on at the effect boundary's first stop check, before the session signer.
    ['client-sign', 0, s => { s.w.requests.control.onStop = () => setPurchaseAdmission('held'); return { client: s.client(), written: [] }; }],
    // The hold turns on after signing, just before the connector's transmit step.
    ['other', 1, s => { const { connector, written } = handshakeConnector(() => setPurchaseAdmission('held')); return { client: s.client({ connector }), written }; }],
  ];
  for (const [causeCode, signs, clientOf] of legs) {
    const s = await storedWorld(t, { paid: true }), { client, written } = clientOf(s);
    await assert.rejects(client.propose(bodyFor(P)),
      error => error instanceof SellerUnavailableError && error.answerClass === 'not-sent' && error.causeCode === causeCode);
    const held = suspension(s);
    assert.equal(held?.cause, 'profile_not_admitted', causeCode);
    assert.equal(s.record(P).lastClass, 'not-sent', causeCode);
    assert.equal(s.w.state.signs.length, signs, causeCode); assert.equal(written.length + s.fetches.length, 0, causeCode);
    s.w.requests.control.onStop = null;
    setPurchaseAdmission('testnet-tp1');
    await assert.rejects(client.propose(bodyFor(P)), errorCode('invalid_state'));
    await staysSuspendedAfterRestart(s, held);
    assert.equal(written.length, 0, causeCode);
  }
});

test("a re-hold observed before signing, and a stop seam that fails, times out or answers invalid, suspend through the purchase's suspension record with their causes; the unobserved-pulse control records nothing", async t => {
  // The effect boundary's stop check stalls until its bounded read times out on a controlled clock.
  const stalledBoundaryStop = async s => {
    const control = s.w.requests.control, clock = controlledClock();
    control.clock = clock; s.w.requests.reopen();
    control.onStop = () => new Promise(() => {});
    const authentication = s.w.createSellerWireAuthentication({ ...s.w.options, effectBoundary: s.w.requests.boundary });
    const sending = s.client({ authentication }).propose(bodyFor(P));
    await settleUntil(() => control.stopCalls === 1);
    clock.advance(AUTHORITY_READ_DEADLINE_MS);
    return sending;
  };
  const legs = [
    // The hold turns on after the records' start read it, so the wire's own hold check sees the re-hold before signing.
    ['profile_not_admitted', s => {
      let seen = false;
      return s.client({ stopped: () => { if (!seen) { seen = true; setPurchaseAdmission('held'); } return false; } }).propose(bodyFor(P));
    }],
    ['stop_check_failed', s => s.client({ stopped: () => { throw new Error('TEST-stop-check-broken'); } }).propose(bodyFor(P))],
    ['stop_check_timeout', stalledBoundaryStop],
    ['stop_check_invalid', s => s.client({ stopped: () => 'yes' }).propose(bodyFor(P))],
  ];
  for (const [cause, run] of legs) {
    const s = await storedWorld(t);
    await assert.rejects(run(s), error => error.code === cause || (cause === 'profile_not_admitted' && error.answerClass === 'not-sent'));
    assert.equal(suspension(s)?.cause, cause, cause);
    assert.equal(s.w.state.signs.length, 0, cause); assert.equal(s.fetches.length, 0, cause);
  }
  const control = await storedWorld(t), stop = { now: true };
  stop.now = false;
  await control.client({ stopped: () => stop.now }).propose(bodyFor(P));
  assert.equal(suspension(control), undefined); assert.equal(control.fetches.length, 1);
});

test('an unobserved stop pulse records no suspension', async t => {
  const s = await storedWorld(t), stop = { now: false }, control = s.w.requests.control;
  // Both the client's seam and the effect boundary's stop turn on and off with no check reading them in between.
  stop.now = true; control.stopped = true;
  stop.now = false; control.stopped = false;
  await s.client({ stopped: () => stop.now }).propose(bodyFor(P));
  assert.equal(suspension(s), undefined); assert.equal(events(s, 'seller_suspended').length, 0);
  assert.equal(s.fetches.length, 1); assert.equal(s.record(P).lastClass, 'result');
});

test("a signed seller answer whose error is writes_stopped or profile_not_admitted is the seller's code: no local suspension, the outcome stays unknown and answerCode is the seller's code", async t => {
  for (const code of ['writes_stopped', 'profile_not_admitted']) {
    const s = await storedWorld(t);
    await assert.rejects(s.client({ respond: init => s.reply(init, 503, { error: code }) }).propose(bodyFor(P)),
      error => error instanceof SellerUnavailableError && error.answerClass === 'unknown' && error.answerCode === code);
    assert.equal(suspension(s), undefined, code); assert.equal(events(s, 'seller_suspended').length, 0, code);
    assert.equal(s.record(P).lastClass, 'unknown', code);
  }
});

test('a stop raised while signing whose suspension write fails rejects with the stop itself, carries the write failure as details.suspensionWriteError, records no suspension and leaves the attempt unknown', async t => {
  const s = await storedWorld(t), failure = new Error('TEST-store-write-failed');
  const { transaction } = createSqlitePurchaseStore();
  const records = s.records(s.holder, (db, work) => transaction(db, () => {
    const result = work();
    if (suspension(s)) throw failure;
    return result;
  }));
  s.w.requests.control.stopped = true;
  await assert.rejects(s.client({ requestRecords: records }).propose(bodyFor(P)),
    error => error.code === 'writes_stopped' && error.answerClass === undefined && error.cause === undefined && error.details?.suspensionWriteError === failure);
  assert.equal(suspension(s), undefined);
  assert.equal(s.record(P).lastClass, 'unknown'); assert.equal(s.record(P).attempts, 1);
  assert.equal(s.w.state.signs.length, 0); assert.equal(s.fetches.length, 0);
});

// Readback while stopped: portalOperation and verifyDeal save nothing but the stop's own suspension.
const HASH = '1'.repeat(64);
const STOPPED_READBACK = { outcome: 'readback_only', reason: 'writes_stopped' };
const NATIVE_TERMS = { profile: OFFLINE_AGREEMENT_PROFILE, nativePayment: 'native-dem-once-after-public-agreement-and-fixture-commitment', sellerAgreementProjection: 'public-signed-create' };
// Seller lookups, chain broadcasts, and the native source's signatures, fetches and journal writes.
const compositionEffects = w => [w.counters.sellerLookups, w.chain.broadcasts, w.native.calls.length, w.native.writes.length];
// A purchase row without the members a suspension write changes.
const withoutSuspension = row => {
  const protocol = { ...row.state.protocol };
  for (const member of ['sellerSuspension', 'revision', 'progressGeneration']) delete protocol[member];
  return { ...row, state: { ...row.state, protocol } };
};

test('while the host is stopped after the hold lifts, portalOperation and verifyDeal project an elapsed approval as expired without ops.transition, and verifyDeal attaches no hash, saves no settlement and starts no continuation', async t => {
  const { ACCOUNT_ID, NOW } = await import('./helpers/public-composition-world.mjs');
  const w = await admittedComposition(t, () => true);
  const elapsed = w.seed({ status: 'agreement_pending', key: 'TEST-stopped-elapsed', expiresAt: new Date(NOW - 1).toISOString(),
    protocolTerms: { profile: OFFLINE_AGREEMENT_PROFILE }, state: { protocol: { stage: 'agreement-signing' } } });
  const handoff = w.seed({ status: 'payment_handoff', key: 'TEST-stopped-handoff', handoff: true });
  const reported = w.seed({ status: 'broadcast_reported', key: 'TEST-stopped-reported', reportedTxHash: HASH });
  const observed = { count: 0 };
  w.chain.observeTransfer = async () => { observed.count++; return { status: 'not-found' }; };
  const transitions = t.mock.method(w.ops, 'transition'), before = w.rows();
  assert.equal(w.service.portalOperation(elapsed.operation.id, elapsed.token).status, 'expired');
  const verify = ({ operation }, txHash) => w.service.verifyDeal({ accountId: ACCOUNT_ID, operationId: operation.id, ...(txHash ? { txHash } : {}) });
  // A malformed hash is still refused while stopped.
  await assert.rejects(verify(handoff, 'TEST-not-a-hash'), errorCode('invalid_tx_hash'));
  const expired = await verify(elapsed, HASH);
  assert.equal(expired.operation.status, 'expired'); assert.deepEqual(expired.verification, STOPPED_READBACK);
  const unattached = await verify(handoff, HASH);
  assert.equal(unattached.operation.status, 'payment_handoff'); assert.deepEqual(unattached.verification, STOPPED_READBACK);
  const unsettled = await verify(reported);
  assert.equal(unsettled.operation.status, 'broadcast_reported'); assert.deepEqual(unsettled.verification, STOPPED_READBACK);
  assert.equal(transitions.mock.callCount(), 0);
  assert.equal(w.rows(), before);
  assert.equal(w.coordinates.get(handoff.operation.id).reportedTxHash ?? null, null);
  assert.equal(observed.count, 0);
  assert.deepEqual(compositionEffects(w), [0, 0, 0, 0]);
});

test('stopped during recovery: readback only', async t => {
  const c = await composedPurchase(t, () => true, 'TEST-stopped-recovery');
  const first = await c.w.service.verifyDeal(c.account);
  assert.deepEqual(first.verification, STOPPED_READBACK);
  const held = c.row().state.protocol.sellerSuspension;
  assert.equal(held.cause, 'writes_stopped');
  assert.deepEqual(first.operation.state.protocol.sellerSuspension, held);
  // A repeated recovery read answers the same readback and keeps the first suspension.
  const again = await c.w.service.verifyDeal(c.account);
  assert.deepEqual(again.verification, STOPPED_READBACK);
  assert.deepEqual(c.row().state.protocol.sellerSuspension, held);
  assert.equal(c.events('seller_suspended').length, 1);
  assert.equal(c.row().status, 'agreement_pending'); assert.equal(c.row().state.protocol.signatures, undefined);
  assert.deepEqual(compositionEffects(c.w), [0, 0, 0, 0]);
});

test('readback and read-only diagnostics run while stopped', async t => {
  const { ACCOUNT_ID } = await import('./helpers/public-composition-world.mjs');
  const stop = { calls: 0 }, c = await composedPurchase(t, () => { stop.calls++; return true; }, 'TEST-stopped-readers');
  const { service, protocol } = c.w, { operationId, token } = c.portal, operation = c.row();
  const passive = {
    status: () => service.status(ACCOUNT_ID, operationId, token),
    portalOperation: () => service.portalOperation(operationId, token),
    portalEvidence: () => service.portalEvidence(operationId, token),
    verifyDeal: () => service.verifyDeal(c.account),
    planRunning: () => service.planRunning(operation),
    assertBuyerAccess: () => protocol.assertBuyerAccess(operation.terms.buyer.wallet, operation),
    supportsMode: () => protocol.supportsMode('TEST-mode'),
    readIssued: () => protocol.readIssued(operation),
    readIssuedPayment: () => protocol.readIssuedPayment(operation, HASH),
    observeReportedPayment: () => protocol.observeReportedPayment(HASH),
  };
  const otherTables = () => JSON.parse(c.w.rows()).filter(([name]) => !['operations', 'operation_events'].includes(name));
  const tablesBefore = otherTables(), eventsBefore = c.w.ops.history(operationId).length;
  const reads = {};
  for (const [name, read] of Object.entries(passive)) {
    const before = stop.calls;
    // A source reader may answer with its own error; none is refused by the stop.
    try { await read(); } catch (error) { assert.ok(!isHostStopRefusal(error), `${name} is not refused by the stop`); }
    reads[name] = stop.calls - before;
  }
  assert.deepEqual(reads, { status: 0, portalOperation: 1, portalEvidence: 0, verifyDeal: 1, planRunning: 0,
    assertBuyerAccess: 0, supportsMode: 0, readIssued: 0, readIssuedPayment: 0, observeReportedPayment: 0 });
  const after = c.row();
  assert.equal(after.state.protocol.sellerSuspension.cause, 'writes_stopped');
  assert.deepEqual(withoutSuspension(after), withoutSuspension(operation));
  assert.deepEqual(c.w.ops.history(operationId).slice(eventsBefore).map(event => event.type), ['seller_suspended']);
  assert.deepEqual(otherTables(), tablesBefore);
  assert.equal(c.w.counters.sellerLookups, 0); assert.equal(c.w.chain.broadcasts, 0); assert.equal(c.w.native.writes.length, 0);
});

test('a stopped verifyDeal of a native-payment purchase in payment_handoff whose buyer nonce moved returns readback_only instead of rejecting writes_stopped, and moves nothing to payment_uncertain', async t => {
  const { ACCOUNT_ID } = await import('./helpers/public-composition-world.mjs');
  const w = await admittedComposition(t, () => true);
  // The seeded handoff's nonce fence is 6; the buyer's nonce has moved past it.
  w.chain.getAddressNonce = async () => 7;
  for (const [key, protocolTerms] of [['TEST-stopped-native-handoff', NATIVE_TERMS], ['TEST-stopped-ordinary-handoff', undefined]]) {
    const { operation } = w.seed({ status: 'payment_handoff', key, protocolTerms, handoff: true });
    const before = w.rows();
    const result = await w.service.verifyDeal({ accountId: ACCOUNT_ID, operationId: operation.id });
    assert.deepEqual(result.verification, STOPPED_READBACK, key);
    assert.equal(result.operation.status, 'payment_handoff', key);
    assert.equal(w.rows(), before, key);
  }
  assert.deepEqual(compositionEffects(w), [0, 0, 0, 0]);
});

// A service whose protocol refuses the buyer's wallet as closed (not missing) and answers its two source reads as given,
// over a purchase with a reported hash. Both share one stop check, which counts its calls and answers stopped.
async function closedBuyerReader(t, { protocolTerms, issued = null, observation = null }) {
  const { ACCOUNT_ID, NOW } = await import('./helpers/public-composition-world.mjs');
  const w = await admittedComposition(t);
  const stop = { calls: 0 }, stopped = () => { stop.calls++; return true; }, sourceReads = [];
  const closed = new OperationError('buyer_access_closed', 'TEST buyer access closed');
  const protocol = bindHostStop({ available: true, assertBuyerAccess() { throw closed; },
    async readIssuedPayment() { sourceReads.push('readIssuedPayment'); return issued; },
    async observeReportedPayment() { sourceReads.push('observeReportedPayment'); return observation; } }, stopped);
  const service = createPurchaseService({ db: w.db, ops: w.ops, coordinates: w.coordinates, chain: w.chain, protocol, config: {}, store: w.store,
    now: () => NOW, purposes: { APPROVE_PURCHASE: 'TEST-approve' }, stopped });
  const { operation } = w.seed({ status: 'broadcast_reported', key: 'TEST-closed-buyer', protocolTerms, reportedTxHash: HASH });
  return { w, stop, closed, sourceReads, transitions: t.mock.method(w.ops, 'transition'), before: w.rows(),
    verify: () => service.verifyDeal({ accountId: ACCOUNT_ID, operationId: operation.id }) };
}

test('a stopped verifyDeal of a purchase whose buyer access closed after a reported payment reads the stop once at entry, answers its source readback with the stop code and saves nothing', async t => {
  const legs = [
    { name: 'native readback', options: { protocolTerms: NATIVE_TERMS, issued: { status: 'readback-only', noResend: true, hash: HASH } }, reads: ['readIssuedPayment'] },
    { name: 'transfer observation', options: { observation: { status: 'not-found' } }, reads: ['readIssuedPayment', 'observeReportedPayment'] },
  ];
  for (const { name, options, reads } of legs) {
    const r = await closedBuyerReader(t, options);
    const { verification } = await r.verify();
    assert.equal(verification.outcome, 'readback_only', name); assert.equal(verification.reason, 'writes_stopped', name);
    assert.equal(r.stop.calls, 1, name); assert.deepEqual(r.sourceReads, reads, name);
    assert.equal(r.transitions.mock.callCount(), 0, name); assert.equal(r.w.rows(), r.before, name);
  }
  // A native-payment purchase whose source read finds nothing keeps the buyer-access refusal.
  const r = await closedBuyerReader(t, { protocolTerms: NATIVE_TERMS });
  await assert.rejects(r.verify(), error => error === r.closed);
  assert.equal(r.stop.calls, 1); assert.deepEqual(r.sourceReads, ['readIssuedPayment']);
  assert.equal(r.transitions.mock.callCount(), 0); assert.equal(r.w.rows(), r.before);
});

test('a stopped verifyDeal whose suspension write fails rejects with the stop itself, carries the write failure as details.suspensionWriteError, saves nothing and starts no continuation', async t => {
  const s = await storedWorld(t, { paid: true }), failure = new Error('TEST-store-write-failed');
  const ops = { ...s.p.ops, transition: (id, from, to, change) => {
    if (change?.event === 'seller_suspended') throw failure;
    return s.p.ops.transition(id, from, to, change);
  } };
  const { service, request, counters } = stoppedService(s, () => true, ops), before = s.p.get();
  await assert.rejects(service.verifyDeal(request),
    error => hostStopRefusal('writes_stopped')(error) && error.cause === undefined && error.details?.suspensionWriteError === failure);
  assert.deepEqual(s.p.get(), before); assert.equal(suspension(s), undefined);
  assert.equal(events(s, 'seller_suspended').length, 0);
  assert.equal(counters.sellerLookups, 0); assert.equal(s.w.state.signs.length, 0); assert.equal(s.fetches.length, 0);
});

// The read-only passiveOnly composition of both purchase factories.
const { compositionWorld, ACCOUNT_ID, NOW } = await import('./helpers/public-composition-world.mjs');
const { deliverableAddress, deliveryEvidenceAddress, listingPin } = await import('../src/dacs/purchase-protocol.mjs');
const { finalityCommitmentAddress } = await import('@kynesyslabs/dacs');
const PURCHASE_FACTORIES = { createProtocolPurchases, createPurchaseService: createAdmittedPurchaseService };
const ILL_FORMED = { accountId: '', operationId: '', token: '' };
const typeErrorOf = message => error => error instanceof TypeError && error.message === message;

// Every member of the real objects the two purchase factories return, by kind. A member the table does not name fails.
const MEMBER_TABLE = {
  protocol: {
    passive: ['assertBuyerAccess', 'assertSellerReceiptReservation', 'observeReportedPayment', 'readIssued', 'readIssuedPayment', 'readRetainedNativePaymentLane', 'supportsMode'],
    active: ['agreementDelegation', 'assertSellerAdmission', 'cancelNativePayment', 'checkDelivery', 'countersign', 'countersignRequest', 'holdChainReadback', 'identityRequest',
      'nativeIntentsSupersededBy', 'nativePaymentClaimed', 'nativePaymentFailed', 'nativePaymentRefused', 'nativePaymentSuperseded', 'nativePaymentTermsCancelled',
      'planFlightsRunning', 'planRequest', 'planRunning', 'prepareTerms', 'readNativePaymentLane', 'recheck', 'recheckCommitment', 'runningPlan', 'sessionRenewal',
      'sessionRenewalAccept', 'signRequest', 'submitAgreement', 'withNativePaymentLane'],
    value: ['actionsAdmitted', 'available', 'chainReadback', 'nativePaymentReadbackAvailable'],
  },
  service: {
    passive: ['nativePaymentLaneRead', 'planRunning', 'portalEvidence', 'portalOperation', 'status', 'verifyDeal'],
    active: ['agreementDelegation', 'agreementIdentity', 'agreementPlan', 'agreementSubmit', 'approve', 'cancel', 'completionCountersign', 'completionRequest', 'issueApprovalChallenge',
      'nativePaymentLane', 'prepare', 'prepareHandoff', 'protocolRecheck', 'reportWalletResult', 'sessionRenewal', 'sessionRenewalAccept'],
    value: ['actionsAdmitted'],
  },
};
// Each member's kind as the admission wrapper built it: every function it wraps is named admittedAction.
const memberKinds = object => Object.fromEntries(Object.entries(object).map(([name, value]) =>
  [name, typeof value !== 'function' ? 'value' : value.name === 'admittedAction' ? 'active' : 'passive']));
const tableKinds = (kind, kinds = ['passive', 'active', 'value']) => Object.fromEntries(kinds.flatMap(member => MEMBER_TABLE[kind][member].map(name => [name, member])));

// Stand-in options that count every property read: each read is one construction step.
function countingOptions() {
  const count = { reads: 0 };
  const standIn = () => new Proxy({}, { get() { count.reads++; return () => {}; } });
  return { count, options: { db: standIn(), store: standIn(), ops: standIn(), coordinates: standIn(), journal: standIn(), custody: standIn() } };
}

// Counts every SQLite statement read and write, on any connection, from here to the end of the test.
function statementCounts(t) {
  const reads = ['get', 'all', 'iterate'].map(name => t.mock.method(StatementSync.prototype, name)), writes = t.mock.method(StatementSync.prototype, 'run');
  return () => ({ reads: reads.reduce((sum, read) => sum + read.mock.callCount(), 0), writes: writes.mock.callCount() });
}

// A seeded agreement_pending protocol purchase with nothing queued and a portal lifetime.
function pendingPurchase(w, key) {
  const purchase = w.seed({ status: 'agreement_pending', key, protocolTerms: { profile: OFFLINE_AGREEMENT_PROFILE, jobId: '01HZY3K8V9Q2W4E6R7T8Y9X0AB' },
    state: { protocol: { stage: 'agreement-signing' } } });
  w.db.prepare('UPDATE operations SET handoff_expires_at = expires_at WHERE id = ?').run(purchase.operation.id);
  return purchase;
}

// The thirteen passive members, each called on one purchase.
const passiveCalls = (w, { operation, token }) => ({
  status: () => w.service.status(ACCOUNT_ID, operation.id, token),
  portalOperation: () => w.service.portalOperation(operation.id, token),
  portalEvidence: () => w.service.portalEvidence(operation.id, token),
  verifyDeal: () => w.service.verifyDeal({ accountId: ACCOUNT_ID, operationId: operation.id, token }),
  planRunning: () => w.service.planRunning(operation),
  nativePaymentLaneRead: () => w.service.nativePaymentLaneRead({ operationId: operation.id, token, key: 'TEST-lane' }),
  readRetainedNativePaymentLane: () => w.protocol.readRetainedNativePaymentLane(operation, 'TEST-lane'),
  assertBuyerAccess: () => w.protocol.assertBuyerAccess(operation.terms.buyer.wallet, operation),
  supportsMode: () => w.protocol.supportsMode('TEST-mode'),
  readIssued: () => w.protocol.readIssued(operation),
  readIssuedPayment: () => w.protocol.readIssuedPayment(operation, HASH),
  observeReportedPayment: () => w.protocol.observeReportedPayment(HASH),
  assertSellerReceiptReservation: () => w.protocol.assertSellerReceiptReservation(operation),
});
// A source reader may answer with its own error; none is refused by the hold or the stop.
async function runsEachPassive(calls) {
  for (const [name, call] of Object.entries(calls)) {
    try { await call(); } catch (error) { assert.ok(!isHostStopRefusal(error) && error?.code !== 'profile_not_admitted', `${name} refused: ${error?.code}`); }
  }
}
// Seller lookups, chain broadcasts, the native source's journal writes and wallet challenges.
const passiveEffects = w => [w.counters.sellerLookups, w.chain.broadcasts, w.native.writes.length, w.counters.challengesIssued];

// A passiveOnly composition admitted through a real binding, with the hold lifted.
async function admittedPassiveComposition(t, options = {}) {
  setPurchaseAdmission('testnet-tp1'); t.after(() => setPurchaseAdmission('held'));
  return compositionWorld(t, { passiveOnly: true, ...options });
}

test('passiveOnly accepts exactly true or nothing: any other value throws TypeError at construction', async t => {
  const { binding, currentLocal } = await bindFixture(), admission = { binding, currentLocal };
  const version = Object.getOwnPropertyDescriptor(process, 'version');
  t.after(() => Object.defineProperty(process, 'version', version));
  const runningOn = value => Object.defineProperty(process, 'version', { value, configurable: true });
  // Construction order: each check refuses before the next runs and before the factory, though passiveOnly is also wrong.
  const order = [
    ['no admission', {}, 'v22.22.2', typeErrorOf('admission_required')],
    ['refused runtime', { admission }, 'v20.19.0', error => error.code === 'runtime_unsupported'],
    ['async stop check', { admission, stopped: async () => false }, 'v22.22.2', typeErrorOf('stop_seam_invalid')],
    ['synchronous stop check', { admission, stopped: () => false }, 'v22.22.2', typeErrorOf('passive_only_invalid')],
    ['no stop check', { admission }, 'v22.22.2', typeErrorOf('passive_only_invalid')],
  ];
  for (const [name, factory] of Object.entries(PURCHASE_FACTORIES)) {
    for (const [leg, given, nodeVersion, refused] of order) {
      runningOn(nodeVersion);
      const { count, options } = countingOptions();
      assert.throws(() => factory({ ...options, ...given, passiveOnly: 'yes' }), refused, `${name}: ${leg}`);
      assert.equal(count.reads, 0, `${name}: ${leg}`);
    }
    runningOn('v22.22.2');
    for (const passiveOnly of [false, null, 'yes', 'true', 1]) {
      const { count, options } = countingOptions();
      assert.throws(() => factory({ ...options, admission, passiveOnly }), typeErrorOf('passive_only_invalid'), `${name}: ${String(passiveOnly)}`);
      assert.equal(count.reads, 0, `${name}: ${String(passiveOnly)}`);
    }
  }
  Object.defineProperty(process, 'version', version);
  const readOnly = await compositionWorld(t, { passiveOnly: true }), ordinary = await compositionWorld(t);
  assert.deepEqual(memberKinds(readOnly.service), tableKinds('service', ['passive', 'value']));
  assert.deepEqual(memberKinds(ordinary.service), tableKinds('service'));
});

test('one table enumerates every method on the real objects returned by both purchase factories as active or passive; an unclassified method fails; each active method calls the stop seam beside the purchase hold before any read or write: reportWalletResult, protocolRecheck, cancel and holdChainReadback given an ill-formed request each refuse writes_stopped with zero ops.transition calls, reads, writes, signer calls and wallet requests, and given a request that authenticates for a protocol purchase record only its suspension; passive methods run; independently holding admission refuses active calls before effects', async t => {
  const stop = { now: false, calls: 0 };
  const w = await admittedComposition(t, () => { stop.calls++; return stop.now; });
  assert.deepEqual(memberKinds(w.protocol), tableKinds('protocol'));
  assert.deepEqual(memberKinds(w.service), tableKinds('service'));
  const seeded = ['protocolRecheck', 'reportWalletResult', 'cancel'].map(action => [action, pendingPurchase(w, `TEST-stopped-${action}`)]);
  const active = [...MEMBER_TABLE.protocol.active.map(name => [w.protocol, name]), ...MEMBER_TABLE.service.active.map(name => [w.service, name])];
  const transitions = t.mock.method(w.ops, 'transition'), before = w.rows(), statements = statementCounts(t);
  stop.now = true;
  // An ill-formed request is refused before any read, so it records nothing.
  for (const [object, name] of active) await assert.rejects(object[name](ILL_FORMED), hostStopRefusal('writes_stopped'), name);
  assert.deepEqual(statements(), { reads: 0, writes: 0 });
  assert.equal(transitions.mock.callCount(), 0); assert.equal(w.rows(), before);
  // A request that authenticates for a protocol purchase records that purchase's suspension and nothing else.
  for (const [action, { operation, token }] of seeded) {
    const request = action === 'cancel' ? { accountId: ACCOUNT_ID, operationId: operation.id } : { operationId: operation.id, token };
    const saved = transitions.mock.callCount();
    await assert.rejects(w.service[action](request), hostStopRefusal('writes_stopped'), action);
    assert.deepEqual(transitions.mock.calls.slice(saved).map(call => call.arguments[3]?.event), ['seller_suspended'], action);
    assert.equal(w.ops.get(ACCOUNT_ID, operation.id).state.protocol.sellerSuspension.cause, 'writes_stopped', action);
  }
  await runsEachPassive(passiveCalls(w, seeded[0][1]));
  assert.deepEqual(passiveEffects(w), [0, 0, 0, 0]);
  // Holding admission refuses every active method before the stop is read.
  setPurchaseAdmission('held');
  const stopCalls = stop.calls, saved = transitions.mock.callCount();
  for (const [object, name] of active) await assert.rejects(object[name](ILL_FORMED), errorCode('profile_not_admitted'), name);
  assert.equal(stop.calls, stopCalls); assert.equal(transitions.mock.callCount(), saved);
  assert.deepEqual(passiveEffects(w), [0, 0, 0, 0]);
});

test('a passiveOnly purchase composition keeps all thirteen passive members callable while held, stopped and with a failing binding; every active name is absent and calling it throws TypeError before any read or write; without admission both factories still throw admission_required with zero SQLite, journal and custody opens', async t => {
  const stop = { calls: 0 };
  const w = await compositionWorld(t, { passiveOnly: true, stopped: () => { stop.calls++; return true; } });
  t.after(() => setPurchaseAdmission('held'));
  w.authority.state.failure = new Error('TEST-binding-refused');
  const bindingReads = w.authority.state.calls, purchase = pendingPurchase(w, 'TEST-passive-only');
  const objects = { protocol: w.protocol, service: w.service };
  for (const [kind, object] of Object.entries(objects)) assert.deepEqual(memberKinds(object), tableKinds(kind, ['passive', 'value']), kind);
  const transitions = t.mock.method(w.ops, 'transition'), before = w.rows();
  for (const hold of ['held', 'testnet-tp1']) {
    setPurchaseAdmission(hold);
    await runsEachPassive(passiveCalls(w, purchase));
    for (const [kind, object] of Object.entries(objects)) {
      for (const name of MEMBER_TABLE[kind].active) {
        assert.equal(Object.hasOwn(object, name), false, `${kind}.${name}`);
        assert.throws(() => object[name](ILL_FORMED), TypeError, `${kind}.${name}`);
      }
    }
  }
  assert.equal(stop.calls, 0); assert.equal(w.authority.state.calls, bindingReads);
  assert.equal(transitions.mock.callCount(), 0); assert.equal(w.rows(), before);
  assert.deepEqual(passiveEffects(w), [0, 0, 0, 0]);
  const { count, options } = countingOptions();
  for (const [name, factory] of Object.entries(PURCHASE_FACTORIES)) {
    assert.throws(() => factory({ ...options, passiveOnly: true }), typeErrorOf('admission_required'), name);
    assert.throws(() => factory({ ...options, passiveOnly: true, admission: { binding: {} } }), typeErrorOf('admission_required'), name);
  }
  assert.equal(count.reads, 0);
});

test('passiveOnly portalOperation projects an elapsed approval as expired without ops.transition, signatures, seller requests or wallet actions after the hold lifts; status and portalEvidence in the same composition return approvalUrl null and actionable false without calling ops.handoffTokenFor', async t => {
  const w = await admittedPassiveComposition(t);
  const elapsed = w.seed({ status: 'awaiting_approval', key: 'TEST-passive-elapsed', expiresAt: new Date(NOW - 1).toISOString() });
  const open = w.seed({ status: 'awaiting_approval', key: 'TEST-passive-open' });
  const tokens = t.mock.method(w.ops, 'handoffTokenFor'), transitions = t.mock.method(w.ops, 'transition'), before = w.rows();
  assert.equal((await w.service.portalOperation(elapsed.operation.id, elapsed.token)).status, 'expired');
  for (const { operation, token } of [elapsed, open]) {
    assert.equal((await w.service.status(ACCOUNT_ID, operation.id, token)).approvalUrl, null);
    assert.equal((await w.service.portalEvidence(operation.id, token)).actionable, false);
  }
  assert.equal(tokens.mock.callCount(), 0); assert.equal(transitions.mock.callCount(), 0);
  assert.equal(w.rows(), before);
  assert.deepEqual(passiveEffects(w), [0, 0, 0, 0]); assert.equal(w.native.calls.length, 0);
});

test('passiveOnly verifyDeal returns diagnostic readback after the hold lifts and never attaches a hash, settles, rechecks, continues, signs or sends', async t => {
  const w = await admittedPassiveComposition(t);
  const passiveReads = { count: 0 };
  w.chain.observePassiveTransfer = async () => { passiveReads.count++; return { status: 'not-found' }; };
  w.chain.observeTransfer = async () => { throw new Error('TEST-settlement-read'); };
  const pending = pendingPurchase(w, 'TEST-passive-pending');
  const handoff = w.seed({ status: 'payment_handoff', key: 'TEST-passive-handoff', handoff: true });
  const reported = w.seed({ status: 'broadcast_reported', key: 'TEST-passive-reported', reportedTxHash: HASH });
  const transitions = t.mock.method(w.ops, 'transition'), before = w.rows();
  const verify = ({ operation, token }, txHash) => w.service.verifyDeal({ accountId: ACCOUNT_ID, operationId: operation.id, token, ...(txHash ? { txHash } : {}) });
  // Readback only accepts the hash already recorded, so a new one is never attached.
  await assert.rejects(verify(handoff, HASH), errorCode('invalid_state'));
  for (const purchase of [pending, handoff, reported]) {
    const { operation, verification } = await verify(purchase);
    assert.equal(verification.outcome, 'readback_only', purchase.operation.status);
    assert.equal(verification.authority, 'unqualified_host', purchase.operation.status);
    assert.equal(operation.status, purchase.operation.status);
  }
  assert.equal(passiveReads.count, 1);
  assert.equal(transitions.mock.callCount(), 0); assert.equal(w.rows(), before);
  assert.equal(w.coordinates.get(handoff.operation.id).reportedTxHash ?? null, null);
  assert.equal(w.contextReads.count, 0);
  assert.deepEqual(passiveEffects(w), [0, 0, 0, 0]); assert.equal(w.native.calls.length, 0);
});

// The node calls the source transport admits as read-only.
const READ_ONLY_NODE_CALLS = new Set(['getBlockByNumber', 'getTxByHash', 'getTransactionStatus', 'getAddressNonce', 'getAddressInfo', 'searchStoragePrograms',
  'getNetworkInfo', 'getNetworkParameters']);

// A durable journal on a temporary file that lists each lock call by method and key; `fence()` reads meta.fence from the file.
function lockListingJournal(t) {
  const directory = mkdtempSync(join(tmpdir(), 'stop-seam-passive-')), path = join(directory, 'journal.sqlite');
  const durable = openDurableWalletJournal({ path, mode: 'create' }), locks = [];
  t.after(() => { durable.close(); rmSync(directory, { recursive: true, force: true }); });
  const listed = method => (key, ...rest) => { locks.push(`${method} ${key}`); return durable[method](key, ...rest); };
  const journal = { ...durable, withWalletLock: listed('withWalletLock'), withOwnedOrAcquiredLane: listed('withOwnedOrAcquiredLane'), appendUnderLock: listed('appendUnderLock') };
  const fence = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try { return Number(db.prepare("SELECT value FROM meta WHERE key = 'fence'").get().value); } finally { db.close(); }
  };
  return { durable, journal, locks, fence };
}

// Seller CREATE pointers for the chain readers: signed by the Listing seller's key, at each artifact's own address.
const SELLER_CLAIM = 'did:demos:agent:' + 'a'.repeat(64);
const sellerPointer = (logicalAddress, artifactKind) => ({ hash: 'b'.repeat(64), signature: { type: 'ed25519', data: '00' },
  content: { from: '0x' + 'a'.repeat(64), to: 'stor-' + 'c'.repeat(40), data: ['storageProgram', { metadata: { logicalAddress, artifactKind } }] } });
function chainReads(chainReadback, jobId) {
  const listing = { listingId: 'TEST', listingVersion: 1, seller: { identity: { presentedBy: SELLER_CLAIM } } };
  const party = (role, primaryClaim) => ({ role, primaryClaim, bundleHash: 'd'.repeat(64), vetRecordRef: {} });
  const agreement = { jobId, listingRef: {}, parties: [party('seller', SELLER_CLAIM), party('buyer', 'did:demos:agent:' + 'e'.repeat(64))] };
  const delivery = { jobId, agreementHash: 'd'.repeat(64), listing: listingPin(listing), payloadHash: 'e'.repeat(64) };
  return {
    readCommitment: () => chainReadback.readCommitment({ agreement, listing, seller: SELLER_CLAIM, fresh: true,
      signedProjection: sellerPointer(finalityCommitmentAddress(jobId), 'FinalityCommitmentRecord') }),
    readDeliverable: () => chainReadback.readDeliverable({ jobId, agreementHash: delivery.agreementHash, listing, seller: SELLER_CLAIM, deliveryBinding: delivery,
      receiptContentHash: delivery.payloadHash, signedProjection: sellerPointer(deliverableAddress(jobId), 'Deliverable') }),
    readDeliveryEvidence: () => chainReadback.readDeliveryEvidence({ agreement, listing, seller: SELLER_CLAIM,
      signedProjection: sellerPointer(deliveryEvidenceAddress(jobId), 'SettlementEvidence') }),
  };
}

test("with a supplied source capability, passiveOnly readIssued, readIssuedPayment, observeReportedPayment and chainReadback's readCommitment, readDeliverable and readDeliveryEvidence, held and after the hold lifts, change no journal record, send only read-only node calls, and take only the devnet/source-read lock; its row is gone after each return or throw, though meta.fence advances", async t => {
  const j = lockListingJournal(t), native = passiveNativeWorld({ journal: j.journal });
  await native.seed();
  const w = await compositionWorld(t, { passiveOnly: true, native });
  t.after(() => setPurchaseAdmission('held'));
  // The purchase's buyer is the payer of the transfer the source journal retains.
  const seeded = pendingPurchase(w, 'TEST-passive-source').operation;
  const operation = { ...seeded, terms: { ...seeded.terms, buyer: { ...seeded.terms.buyer, wallet: PAYER } } };
  const readers = { readIssued: () => w.protocol.readIssued(operation), readIssuedPayment: () => w.protocol.readIssuedPayment(operation, NATIVE_HASH),
    observeReportedPayment: () => w.protocol.observeReportedPayment(NATIVE_HASH), ...chainReads(w.protocol.chainReadback, operation.terms.protocol.jobId) };
  const records = await j.durable.entries(), fenceBefore = j.fence();
  j.locks.length = 0; native.calls.length = 0;
  for (const hold of ['held', 'testnet-tp1']) {
    setPurchaseAdmission(hold);
    for (const [name, read] of Object.entries(readers)) {
      // A reader may answer with its own error; either way it leaves no lock row.
      await read().catch(() => {});
      assert.deepEqual(j.durable.inspectLocks(), [], `${name} ${hold}`);
    }
  }
  assert.deepEqual(await j.durable.entries(), records);
  assert.deepEqual(native.writes, []);
  assert.ok(native.calls.length > 0);
  for (const call of native.calls) assert.ok(READ_ONLY_NODE_CALLS.has(call), call);
  assert.ok(j.locks.length > 0);
  for (const lock of j.locks) assert.match(lock, /^withWalletLock devnet\/source-read\//);
  assert.ok(j.fence() > fenceBefore);
});
