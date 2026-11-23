// The client's stop seam: where a host stop or a re-hold is recorded as the purchase's suspension, and what clears it.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storedWorld, PATHS, bodyFor, errorCode } from './helpers/stored-request-fixture.mjs';
import { setPurchaseAdmission, T0 } from './helpers/wire-client-fixture.mjs';
import { spawnJournalChild } from './helpers/journal-child-process.mjs';
import { controlledClock, settleUntil } from './helpers/effect-boundary-fixture.mjs';
beforeEach(t => t.mock.method(Date, 'now', () => T0));
const { createPurchaseService } = await import('../src/purchases.mjs');
const { createProtocolPurchases } = await import('../src/index.mjs');
const { createSqlitePurchaseStore } = await import('../src/seams/purchase-store-not-wired.mjs');
const { StaleProtocolCheck, OFFLINE_AGREEMENT_PROFILE } = await import('../src/dacs/protocol-purchases.mjs');
const { createHostStop } = await import('../src/host-stop.mjs');
const { OperationError } = await import('../src/client-errors.mjs');
const { SellerUnavailableError } = await import('../src/dacs/seller-http.mjs');
const { createSellerHttpsConnector } = await import('../src/dacs/seller-https-connector.mjs');
const { AUTHORITY_READ_DEADLINE_MS } = await import('../src/public-admission.mjs');
const P = PATHS.proposals;
const suspension = s => s.p.get().state.protocol.sellerSuspension;
const events = (s, type) => s.p.ops.history(s.p.op.id).filter(event => event.type === type);
const hostStopRefusal = code => error => error.code === code && error.message === `host stop refused: ${code}`;
const queueWork = s => s.patch({ signatures: { agreement: 'TEST-queued-contribution' } });

// The purchase service over the public protocol factory, both built with `stopped`; seller lookups are counted.
function stoppedService(s, stopped) {
  const counters = { sellerLookups: 0 };
  const dacsProtocol = { ...s.p.config, sellerEndpoint: (...args) => { counters.sellerLookups++; return s.p.config.sellerEndpoint(...args); } };
  const protocol = createProtocolPurchases({ db: s.p.db, ops: s.p.ops, coordinates: { unresolvedForSender: () => [] }, dacsProtocol, admission: s.w.admission,
    store: createSqlitePurchaseStore(), now: () => s.w.state.time, buyerAccess: { assertWallet() {} }, stopped });
  s.p.db.prepare('UPDATE operations SET handoff_expires_at = expires_at WHERE id = ?').run(s.p.op.id);
  const service = createPurchaseService({ db: s.p.db, ops: s.p.ops, coordinates: { get: () => null }, protocol, chain: { broadcastTransaction() { throw new Error('TEST-unexpected-broadcast'); } },
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

// A composition admitted through a real binding, with one seeded agreement_pending protocol purchase and nothing queued.
async function composedPurchase(t, stopped, key) {
  setPurchaseAdmission('testnet-tp1'); t.after(() => setPurchaseAdmission('held'));
  const { compositionWorld, ACCOUNT_ID } = await import('./helpers/public-composition-world.mjs');
  const w = await compositionWorld(t, { stopped });
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
  // The public gate and the continuation.
  const gateKill = killFile(t);
  const c = await composedPurchase(t, gateKill.stopped, 'TEST-kill-gate');
  let before = gateKill.calls;
  await assert.rejects(c.w.service.protocolRecheck({ operationId: '', token: '' }), error => error.code !== 'writes_stopped');
  assert.equal(gateKill.calls - before, 2, 'the gate reads the check before and after the binding read');
  before = gateKill.calls;
  let continuationCalls;
  c.w.authority.state.gate = async () => { c.w.authority.state.gate = null; continuationCalls = gateKill.calls - before; };
  await c.w.service.verifyDeal(c.account).catch(() => {});
  assert.equal(continuationCalls, 2, 'the continuation, then the protocol gate before its binding read');
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
