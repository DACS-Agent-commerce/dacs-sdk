// The challenge and context routes on the composed host (`startSellerHost`): the mount, its order against the startup sweep, and the host's
// drain of provider work that outlives its answer. The provider is a counting stand-in behind the registered capability; the requests are
// real signed HTTP exchanges over loopback, on fake timers where a deadline matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { Server } from 'node:http';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DACS_SELLER_DISCOVERY_PATH, DACS_SELLER_HTTP_PATHS } from '@kynesyslabs/dacs/wire';
import { provenUnsignedAbsence } from '../src/dacs/native-dem-delivery-consumer.mjs';
import * as guard from '../src/kit-operation-guard.mjs';
import { HOST_CONTEXT_CALLBACKS } from './helpers/host-context-callbacks.mjs';
import { contextCapability, contextHostFixture, hostBuyer, presentContextAnswer } from './helpers/host-context-client.mjs';
import { JOB, NOW, buyer, seller } from './helpers/protocol-fixture.mjs';
import { FIXTURE_ENDPOINT, wireBuyer } from './helpers/wire-buyer.mjs';

const OTHER_JOB = '01J8N4YV7YVYQ4DB7M8T4C7W0B';
const THIRD_JOB = '01J8N4YV7YVYQ4DB7M8T4C7W0C';
const ABANDONED_PURCHASE_MS = 3_600_000;
// One purchase allocation holds 68 units. After its context step 52 stay held (51 unspent, 1 charged), so 100 leaves too little for a second purchase.
const ONE_PURCHASE_BUDGET = 100;
const CONTEXT_DEADLINE_MS = 240_000;
const SWEEP_INTERVAL_MS = 60_000;
const LEASE_WAIT_MS = 10_000;
// Room for one new purchase allocation (68 units) beside a purchase whose context step completed (its 51 unspent units and its
// charged unit), with a few general units for the requests' own charges. A step left open keeps its whole 68 instead, and the next
// purchase does not fit.
const SMALL_BUDGET = 128;
const SWEEP_SQL = /state IN \('intent', 'compensating', 'admitted', 'running'\)/;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
// Waits for `entered`, and fails at once when the request ends first, so a host that never reaches the work fails the test instead of hanging it.
const reached = (entered, request) => Promise.race([entered.promise, request.then((answer) => { throw new Error(`TEST the request ended before the work was reached: ${answer.status} ${answer.text}`); })]);
const flush = async () => { for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve)); };
const lockPath = (directory) => join(directory, 'seller-state.lock');
const admissionState = (directory, jobId = JOB) => {
  const db = new Database(join(directory, 'transport', 'transport.sqlite'), { readonly: true });
  try { return db.prepare('SELECT state FROM kit_context_admissions WHERE jobId = ?').get(jobId)?.state ?? null; } finally { db.close(); }
};
// A context row's state and hold release, and the state of the purchase allocation that holds its slot.
const contextRowOf = (directory, jobId = JOB) => {
  const db = new Database(join(directory, 'transport', 'transport.sqlite'), { readonly: true });
  try {
    const row = db.prepare('SELECT state, record FROM kit_context_admissions WHERE jobId = ?').get(jobId);
    const { releasePending, cause } = JSON.parse(row.record).cleanup;
    return { state: row.state, releasePending, cause, allocation: db.prepare('SELECT state FROM kit_allocations WHERE jobId = ?').get(jobId)?.state ?? null };
  } finally { db.close(); }
};
const NO_CONTEXT = () => ({ disposition: 'absent', reason: 'TEST no context', code: 'context_absent' });
// The fixture's artifact anchor with the devnet anchor's no-intent proof: an address with no retained CREATE is proven unsigned.
const provingNoIntent = (anchor) => ({ ...anchor, readRetained: async (query, options) => {
  const read = await anchor.readRetained(query, options);
  return query.proofOfNoIntent === true && read.status === 'absent' ? provenUnsignedAbsence('TEST no CREATE intent') : read;
} });

const allocationState = (directory, jobId = JOB) => {
  const db = new Database(join(directory, 'transport', 'transport.sqlite'), { readonly: true });
  try { return db.prepare('SELECT state FROM kit_allocations WHERE jobId = ?').get(jobId)?.state ?? null; } finally { db.close(); }
};

/** Runs the host's periodic sweep once and waits until `done()` holds, in turns of the event loop and never in wall-clock time. */
async function sweepUntil(sweep, done) {
  sweep.callback();
  for (let turn = 0; turn < 200 && !done(); turn++) await flush();
  assert.equal(done(), true, 'the sweep did not finish its work');
}

/**
 * A provider that makes its two Vet writes, each after asking the attempt's predicate, and waits on `gate` at `stall`: `first` (before the
 * first write), `between` (after it) or `answer` (before the answer). `seen` counts writes, and the writes made after `seen.late` was set.
 */
function stalledProvider(stall) {
  const gate = deferred(), seen = { entered: deferred(), resolves: 0, writes: 0, lateWrites: 0, late: false, options: null };
  const write = (options) => {
    if (options.writable() !== true) throw Object.assign(new Error('the purchase is no longer pending'), { code: 'not-pending' });
    seen.writes++;
    if (seen.late) seen.lateWrites++;
  };
  const wait = async (position) => { if (position === stall) { seen.entered.resolve(); await gate.promise; } };
  const resolveBuyer = async (input, options) => {
    seen.resolves++;
    seen.options = options;
    await wait('first');
    write(options);
    await wait('between');
    write(options);
    await wait('answer');
    return presentContextAnswer(input);
  };
  return { gate, seen, capability: contextCapability({ resolveBuyer }) };
}

test('the host mounts both routes only after the sweep and reconciliation, and refuses a forged or incomplete demDeliveryContext before taking the lock', async (t) => {
  const f = await contextHostFixture(t);
  const providerCalls = [];
  const counting = { resolveBuyer: async () => { providerCalls.push('resolveBuyer'); return null; }, bindRetainedScope: () => { providerCalls.push('bindRetainedScope'); return HOST_CONTEXT_CALLBACKS.bindRetainedScope(); } };
  const refused = {
    'a plain object shaped like the capability': { ...contextCapability() },
    'a capability without recoverBuyer': contextCapability({ ...counting, recoverBuyer: null }),
    'a capability without resumableBuyer': contextCapability({ ...counting, resumableBuyer: null }),
    'a capability without bindRetainedScope': contextCapability({ ...counting, bindRetainedScope: null }),
  };
  for (const [name, demDeliveryContext] of Object.entries(refused)) {
    await assert.rejects(f.start({ demDeliveryContext }), TypeError, name);
    assert.deepEqual(readdirSync(f.dataDirectory), [], `${name}: no lock, store or journal file`);
  }
  assert.deepEqual(providerCalls, []);

  const events = [];
  const listen = Server.prototype.listen, prepare = Database.prototype.prepare;
  t.mock.method(Server.prototype, 'listen', function (...args) { events.push('listen'); return listen.apply(this, args); });
  t.mock.method(Database.prototype, 'prepare', function (sql) { if (SWEEP_SQL.test(sql)) events.push('sweep'); return prepare.call(this, sql); });
  await f.start({ demDeliveryContext: contextCapability({ bindRetainedScope: () => { events.push('bind'); return HOST_CONTEXT_CALLBACKS.bindRetainedScope(); } }) });
  assert.deepEqual([...new Set(events)], ['bind', 'sweep', 'listen']);
});

for (const [stall, where] of [['first', 'before the first Vet write'], ['between', 'between the Vet writes'], ['answer', 'before the answer']]) {
  test(`host close after a timeout answer keeps the stores and the seller state lock until the stalled provider work settles, stalled ${where}`, async (t) => {
    for (const end of ['resolves', 'rejects']) {
      await t.test(`the stalled work ${end}`, async (t) => {
        const unhandled = [], onUnhandled = (reason) => unhandled.push(reason);
        process.on('unhandledRejection', onUnhandled);
        t.after(() => process.off('unhandledRejection', onUnhandled));
        const clock = { monotonic: 0 };
        t.mock.method(performance, 'now', () => clock.monotonic);
        const provider = stalledProvider(stall), f = await contextHostFixture(t);
        const host = await f.start({ demDeliveryContext: provider.capability }), buyer = await f.buyerFor(host);
        const issued = await buyer.challenge();
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const pending = buyer.context(JOB, issued.body.sessionNonce);
        await reached(provider.seen.entered, pending);
        clock.monotonic = CONTEXT_DEADLINE_MS;
        t.mock.timers.tick(CONTEXT_DEADLINE_MS);
        const answer = await pending;
        t.mock.timers.reset();
        assert.deepEqual([answer.status, answer.signed, answer.body.error], [503, true, 'operation_uncertain'], answer.text);
        provider.seen.late = true;
        assert.equal(admissionState(f.dataDirectory), 'running', 'the row stays open at the timeout answer');

        let closed = false;
        const closing = host.close().then(() => { closed = true; });
        await flush();
        assert.equal(closed, false, 'close waits for the stalled provider work');
        assert.equal(existsSync(lockPath(f.dataDirectory)), true);
        await assert.rejects(f.start(), { code: 'seller_state_locked', reason: 'held' });

        if (end === 'resolves') provider.gate.resolve(); else provider.gate.reject(new Error('TEST the stalled work failed'));
        await closing;
        assert.equal(existsSync(lockPath(f.dataDirectory)), false);
        await flush();
        assert.equal(provider.seen.lateWrites, 0, 'no Vet write after the deadline');
        assert.deepEqual(unhandled, []);
        assert.equal(admissionState(f.dataDirectory), 'running', 'the settled work completed nothing, and its row stays running for the buyer\'s retry');
        await (await f.start()).close();
        assert.equal(admissionState(f.dataDirectory), 'compensating', 'the startup sweep ends the row for cleanup');
        assert.notEqual(admissionState(f.dataDirectory), null, 'the retained admission survives the restart');
      });
    }
  });
}
test('host close without context work in flight finishes at once and releases the lock', async (t) => {
  const f = await contextHostFixture(t), host = await f.start();
  await host.close();
  assert.equal(existsSync(lockPath(f.dataDirectory)), false);
});

test('a startup that fails after the provider was bound leaves no listener and no state lock', async (t) => {
  const f = await contextHostFixture(t);
  const listened = [];
  const listen = Server.prototype.listen;
  t.mock.method(Server.prototype, 'listen', function (...args) { listened.push(args); return listen.apply(this, args); });
  const failure = new Error('TEST the provider cannot bind');
  await assert.rejects(f.start({ demDeliveryContext: contextCapability({ bindRetainedScope: () => { throw failure; } }) }), (error) => error === failure || error.cause === failure);
  assert.deepEqual(listened, []);
  assert.equal(existsSync(lockPath(f.dataDirectory)), false);
  const host = await f.start();
  assert.equal(listened.length, 1, 'a later start listens once');
  await host.close();
});

test('a context request still being admitted when close begins is refused and never starts the provider', async (t) => {
  const gate = deferred(), entered = deferred(), seen = { resolves: 0 };
  const f = await contextHostFixture(t);
  const { sessionAdmission } = f.config;
  const held = { ...sessionAdmission, admit: async (query) => { entered.resolve(); await gate.promise; return sessionAdmission.admit(query); } };
  const host = await f.start({ sessionAdmission: held, demDeliveryContext: contextCapability({ resolveBuyer: async () => { seen.resolves++; return null; } }) });
  const pending = (await f.buyerFor(host)).requestContext();
  await reached(entered, pending);
  const closing = host.close();
  gate.resolve();
  const answer = await pending;
  await closing;
  assert.deepEqual([answer.status, answer.body.error], [503, 'seller_not_ready']);
  assert.equal(seen.resolves, 0);
  assert.equal(existsSync(lockPath(f.dataDirectory)), false);
});

for (const [stall, where] of [['first', 'before its first Vet write'], ['between', 'between its Vet writes'], ['answer', 'before its answer']]) {
  test(`host close while a context step runs, stalled ${where}, lets the step end with its real outcome and frees its slot for the next buyer`, async (t) => {
    const provider = stalledProvider(stall);
    t.after(() => provider.gate.resolve());
    const f = await contextHostFixture(t);
    const host = await f.start({ demDeliveryContext: provider.capability, maxReservationUnits: SMALL_BUDGET });
    const pending = (await f.buyerFor(host)).requestContext();
    await reached(provider.seen.entered, pending);
    let closed = false;
    const closing = host.close().then(() => { closed = true; });
    await flush();
    assert.equal(provider.seen.options.signal.aborted, false, 'stopping does not abort the running step');
    assert.equal(closed, false, 'close waits for the running step');
    assert.equal(existsSync(lockPath(f.dataDirectory)), true);
    provider.gate.resolve();
    const answer = await pending;
    await closing;
    assert.deepEqual([answer.status, answer.signed, answer.body.disposition], [200, true, 'present'], answer.text);
    assert.equal(provider.seen.writes, 2, 'both Vet writes were made');
    assert.equal(existsSync(lockPath(f.dataDirectory)), false);
    assert.equal(admissionState(f.dataDirectory), 'settled', 'the step completed');

    const restarted = await f.start({ maxReservationUnits: SMALL_BUDGET });
    assert.equal(admissionState(f.dataDirectory), 'settled', 'the completed step survives the restart');
    const next = await (await f.buyerFor(restarted)).requestContext(OTHER_JOB);
    assert.equal(next.status, 200, `the context slot was returned, so the next purchase is admitted: ${next.text}`);
  });
}

test('a context request whose step is reserved but not yet started when close begins still runs it to its real outcome', async (t) => {
  const seen = { resolves: 0 };
  const f = await contextHostFixture(t);
  const host = await f.start({ demDeliveryContext: contextCapability({ resolveBuyer: async (input) => { seen.resolves++; return presentContextAnswer(input); } }) });
  // Close begins as the admission row turns running, after the reservation and before the provider's work is registered.
  let closing = null;
  const prepare = Database.prototype.prepare;
  t.mock.method(Database.prototype, 'prepare', function (sql) {
    const statement = prepare.call(this, sql);
    if (!sql.startsWith('UPDATE kit_context_admissions SET state = ?')) return statement;
    const run = statement.run;
    statement.run = function (...args) {
      const result = run.apply(this, args);
      if (args[0] === 'running') closing ??= host.close();
      return result;
    };
    return statement;
  });
  const answer = await (await f.buyerFor(host)).requestContext();
  assert.notEqual(closing, null, 'close began while the step was being reserved');
  await closing;
  assert.deepEqual([answer.status, answer.body.disposition], [200, 'present'], answer.text);
  assert.equal(seen.resolves, 1);
  assert.equal(admissionState(f.dataDirectory), 'settled');
});

test('a context row whose cleanup is unfinished keeps its own job refused and does not make the host refuse another buyer\'s challenge', async (t) => {
  const f = await contextHostFixture(t);
  const host = await f.start({ demDeliveryContext: contextCapability({ resolveBuyer: async (input, options) => { options.writable(); throw new Error('TEST the Vet readback failed'); } }) });
  const buyer = await f.buyerFor(host);
  const failed = await buyer.requestContext();
  assert.equal(failed.status >= 500, true, failed.text);
  assert.equal(admissionState(f.dataDirectory), 'compensating', 'the row keeps its cleanup open');
  const other = await buyer.challenge(OTHER_JOB);
  assert.equal(other.status, 200, other.text);
  assert.equal((await buyer.challenge(JOB)).status === 200, false, 'the unfinished job itself is not served again');
});

test('a fresh host on a stopped host\'s store ends the direct request\'s running context row before it listens, so its hold and slot take a new job', async (t) => {
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  const f = await contextHostFixture(t), options = { maxReservationUnits: SMALL_BUDGET, artifactAnchor: provingNoIntent(f.native) };
  // The provider answers while the kit guard is off, so nothing ends the accepted row, as when the process stops before the row ends.
  const stopped = await f.start({ ...options, demDeliveryContext: contextCapability({ resolveBuyer: async () => { guard.setKitOperationGuardForTest('off'); return NO_CONTEXT(); } }) });
  const answer = await (await f.buyerFor(stopped)).requestContext(JOB, { delegated: false });
  guard.setKitOperationGuardForTest('testnet-tp1');
  await stopped.close();
  assert.equal(answer.status >= 500, true, answer.text);
  assert.deepEqual(contextRowOf(f.dataDirectory), { state: 'running', releasePending: false, cause: null, allocation: 'live' }, 'the row was left running with its slot');

  const atListen = [], listen = Server.prototype.listen;
  t.mock.method(Server.prototype, 'listen', function (...args) { atListen.push(contextRowOf(f.dataDirectory)); return listen.apply(this, args); });
  const restarted = await f.start(options);
  assert.deepEqual(atListen, [{ state: 'aborted', releasePending: false, cause: null, allocation: 'released' }], 'the row is ended, its hold released and its slot free before the host listens');
  const next = await (await f.buyerFor(restarted)).requestContext(OTHER_JOB, { delegated: false });
  assert.deepEqual([next.status, next.body.disposition], [200, 'present'], `the freed slot takes a new job: ${next.text}`);
});

test('a sweep that cannot take the lease of a running context step records its cause there and does not make the host refuse another buyer', async (t) => {
  const provider = stalledProvider('between'), f = await contextHostFixture(t);
  const timers = [], setInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...rest) => { const timer = setInterval(callback, ms, ...rest); timers.push({ callback, ms }); return timer; });
  const host = await f.start({ demDeliveryContext: provider.capability }), buyer = await f.buyerFor(host);
  const sweep = timers.find(({ ms }) => ms === SWEEP_INTERVAL_MS);
  const pending = buyer.requestContext();
  await reached(provider.seen.entered, pending);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  sweep.callback();
  await flush();
  t.mock.timers.tick(LEASE_WAIT_MS);
  await flush();
  t.mock.timers.reset();
  const cleanup = new Database(join(f.dataDirectory, 'transport', 'transport.sqlite'), { readonly: true });
  try { assert.notEqual(cleanup.prepare("SELECT json_extract(record, '$.cleanup.cause') AS cause FROM kit_context_admissions WHERE jobId = ?").get(JOB).cause, null, 'the sweep recorded its cause on the row'); } finally { cleanup.close(); }
  const other = await buyer.challenge(OTHER_JOB);
  assert.equal(other.status, 200, other.text);
  provider.gate.resolve();
  await pending;
});

test('the host runs one unref\'d 60 second sweep at a time, and close stops the timer and waits for a sweep in flight', async (t) => {
  const provider = stalledProvider('between'), f = await contextHostFixture(t);
  const timers = [], cleared = [], sweeps = [];
  const setInterval = globalThis.setInterval, clearInterval = globalThis.clearInterval, prepare = Database.prototype.prepare;
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...rest) => { const timer = setInterval(callback, ms, ...rest); timers.push({ callback, ms, timer }); return timer; });
  t.mock.method(globalThis, 'clearInterval', (timer) => { cleared.push(timer); return clearInterval(timer); });
  t.mock.method(Database.prototype, 'prepare', function (sql) { if (SWEEP_SQL.test(sql)) sweeps.push(sql); return prepare.call(this, sql); });
  const host = await f.start({ demDeliveryContext: provider.capability });
  const periodic = timers.filter(({ ms }) => ms === SWEEP_INTERVAL_MS);
  assert.equal(periodic.length, 1, 'one 60 second timer');
  assert.equal(periodic[0].timer.hasRef(), false, 'the timer does not keep the process alive');
  const afterStartup = sweeps.length;
  const pending = (await f.buyerFor(host)).requestContext();
  await reached(provider.seen.entered, pending);
  periodic[0].callback();
  periodic[0].callback();
  await flush();
  assert.equal(sweeps.length - afterStartup, 1, 'a tick during a sweep in flight starts no second sweep');
  const closing = host.close();
  assert.deepEqual(cleared, [periodic[0].timer], 'close clears the timer before it waits');
  provider.gate.resolve();
  await pending;
  await closing;
  assert.equal(existsSync(lockPath(f.dataDirectory)), false);
});

/** A started host on a clock the test moves, with its periodic sweep captured and the buyers that talk to it. */
async function hostOnMovingClock(t, f, options = {}) {
  const clock = { elapsed: 0, now: () => NOW + clock.elapsed };
  const timers = [], setInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...rest) => { const timer = setInterval(callback, ms, ...rest); timers.push({ callback, ms }); return timer; });
  const host = await f.start({ maxReservationUnits: ONE_PURCHASE_BUDGET, now: clock.now, ...options });
  const sweep = timers.find(({ ms }) => ms === SWEEP_INTERVAL_MS);
  const buyerFor = (jobId) => hostBuyer(host, f.config.listing, { jobId, clock: clock.now });
  return { clock, sweep, buyerFor, host };
}

test('the default host frees the units of a purchase that stopped after its context step once an hour has passed, and then admits the next buyer', async (t) => {
  const f = await contextHostFixture(t), { clock, sweep, buyerFor } = await hostOnMovingClock(t, f);
  const first = await (await buyerFor(JOB)).requestContext();
  assert.equal(first.status, 200, first.text);
  assert.equal(allocationState(f.dataDirectory), 'live', 'the context step keeps the rest of the purchase\'s units');
  const refused = await (await buyerFor(OTHER_JOB)).challenge();
  assert.deepEqual([refused.status, refused.body.error], [503, 'seller_not_ready']);

  clock.elapsed = ABANDONED_PURCHASE_MS - 1;
  sweep.callback();
  await flush();
  assert.equal(allocationState(f.dataDirectory), 'live', 'a purchase younger than an hour keeps its units');

  clock.elapsed = ABANDONED_PURCHASE_MS;
  await sweepUntil(sweep, () => allocationState(f.dataDirectory) === 'released');
  const next = await (await buyerFor(THIRD_JOB)).requestContext();
  assert.equal(next.status, 200, next.text);
});

test('the default host frees the units of a purchase that was abandoned before it restarted', async (t) => {
  const f = await contextHostFixture(t), { buyerFor, host } = await hostOnMovingClock(t, f);
  assert.equal((await (await buyerFor(JOB)).requestContext()).status, 200);
  await host.close();
  assert.equal(allocationState(f.dataDirectory), 'live');
  await f.start({ maxReservationUnits: ONE_PURCHASE_BUDGET, now: () => NOW + 2 * ABANDONED_PURCHASE_MS });
  assert.equal(allocationState(f.dataDirectory), 'released');
});

test('the host publishes ready: false and refuses a new challenge while a new purchase\'s whole allotment does not fit, and ready again once the units are given back', async (t) => {
  const f = await contextHostFixture(t, { publicEndpoint: FIXTURE_ENDPOINT }), { clock, sweep, buyerFor, host } = await hostOnMovingClock(t, f);
  const signer = (wallet) => ({ claim: wallet.claim, sign: wallet.signBytes });
  const published = async () => {
    const response = await fetch(host.url + DACS_SELLER_DISCOVERY_PATH);
    assert.equal(response.status, 200);
    const wire = await wireBuyer({ buyer: signer(buyer), seller: signer(seller), listingPin: host.listingPin, clock: clock.now });
    return (await wire.verifyDiscovery(Buffer.from(await response.arrayBuffer()))).ready;
  };
  assert.equal(await published(), true);
  assert.equal((await (await buyerFor(JOB)).requestContext()).status, 200);
  assert.equal(await published(), false, 'the first purchase\'s units leave too few for a second');
  const refused = await (await buyerFor(OTHER_JOB)).challenge();
  assert.deepEqual([refused.status, refused.body.error], [503, 'seller_not_ready']);
  clock.elapsed = ABANDONED_PURCHASE_MS;
  await sweepUntil(sweep, () => allocationState(f.dataDirectory) === 'released');
  assert.equal(await published(), true);
});

test('a host given its own contextSessionState reads no purchase as abandoned', async (t) => {
  const f = await contextHostFixture(t), { clock, sweep, buyerFor } = await hostOnMovingClock(t, f, { contextSessionState: () => null });
  assert.equal((await (await buyerFor(JOB)).requestContext()).status, 200);
  clock.elapsed = 2 * ABANDONED_PURCHASE_MS;
  sweep.callback();
  await flush();
  assert.equal(allocationState(f.dataDirectory), 'live');
  const refused = await (await buyerFor(OTHER_JOB)).challenge();
  assert.deepEqual([refused.status, refused.body.error], [503, 'seller_not_ready']);
});

// ---- a retry while the attempt that a deadline answer left is still inside its lease ---------------------------------------

const JOURNAL_LEASE_MS = 300_000;
// What a request that is charged, or whose nonce the wire journal publishes, changes: the reservation rows and the journal's files.
const charged = (directory) => {
  const db = new Database(join(directory, 'transport', 'transport.sqlite'), { readonly: true });
  try {
    return { reservations: db.prepare('SELECT key, state, code FROM kit_reservations ORDER BY rowid').all().map((row) => ({ ...row })),
      journal: readdirSync(join(directory, 'wire-journal')).sort() };
  } finally { db.close(); }
};

/**
 * A context step answered operation_uncertain at its 240 s deadline, whose provider work then settled with no Vet write: the job is free
 * again and the journal's attempt is still pending inside its lease, which runs on the host's wall clock. `replay()` posts the first
 * request's exact bytes again; `resend(at)` signs its body again under a new envelope, as a buyer whose clock reads `at`.
 */
async function pendingAfterDeadline(t) {
  const clock = { monotonic: 0 };
  t.mock.method(performance, 'now', () => clock.monotonic);
  const posted = [], post = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) => { posted.push({ url, init }); return post(url, init); });
  const provider = stalledProvider('first'), f = await contextHostFixture(t);
  const host = await f.start({ demDeliveryContext: provider.capability }), buyer = await f.buyerFor(host);
  const issued = await buyer.challenge();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = buyer.context(JOB, issued.body.sessionNonce);
  await reached(provider.seen.entered, pending);
  const first = posted.at(-1);
  clock.monotonic = CONTEXT_DEADLINE_MS;
  t.mock.timers.tick(CONTEXT_DEADLINE_MS);
  const answer = await pending;
  t.mock.timers.reset();
  assert.deepEqual([answer.status, answer.body.error, answer.body.cause], [503, 'operation_uncertain', 'context_deadline'], answer.text);
  provider.gate.resolve();
  await flush();
  const before = charged(f.dataDirectory);
  assert.deepEqual([before.reservations.map(({ state }) => state), before.journal.filter((name) => name.startsWith('k-')).length], [['new'], 1]);
  const replay = async () => {
    const response = await post(first.url, first.init);
    return { status: response.status, body: JSON.parse(await response.text()) };
  };
  const resend = async (at) => (await hostBuyer(host, f.config.listing, { jobId: JOB, clock: () => at })).send(DACS_SELLER_HTTP_PATHS.context, JOB, JSON.parse(first.init.body));
  return { f, host, buyer, provider, issued, before, replay, resend };
}

test('a fresh-nonce retry while the attempt a deadline answer left is still inside its lease is refused seller_effect_pending before any reservation row or nonce key', async (t) => {
  const w = await pendingAfterDeadline(t);
  const retry = await w.buyer.context(JOB, w.issued.body.sessionNonce);
  assert.deepEqual([retry.status, retry.body.error], [503, 'seller_effect_pending'], retry.text);
  assert.deepEqual(charged(w.f.dataDirectory), w.before, 'no reservation row, nonce key or attempt');
  w.f.advance(JOURNAL_LEASE_MS - 1);
  const last = await w.resend(NOW + JOURNAL_LEASE_MS - 1);
  assert.deepEqual([last.status, last.body.error], [503, 'seller_effect_pending'], last.text);
  assert.deepEqual(charged(w.f.dataDirectory), w.before, 'one millisecond before the lease runs out');
  assert.deepEqual([w.provider.seen.resolves, w.provider.seen.writes], [1, 0], 'no second provider run and no Vet write');
});

test('the first request sent again byte for byte while its attempt is pending is still answered peer_request_replayed', async (t) => {
  const w = await pendingAfterDeadline(t);
  const again = await w.replay();
  assert.deepEqual([again.status, again.body.error], [409, 'peer_request_replayed']);
  assert.deepEqual(charged(w.f.dataDirectory), w.before);
});

test('a context request for the job under another scope while its attempt is pending is still refused peer_agreement_mismatch', async (t) => {
  const w = await pendingAfterDeadline(t);
  const other = await (await hostBuyer(w.host, w.f.config.listing, { jobId: JOB, clock: () => NOW - 1 })).context(JOB, w.issued.body.sessionNonce);
  assert.deepEqual([other.status, other.body.error], [409, 'peer_agreement_mismatch'], other.text);
  assert.deepEqual(charged(w.f.dataDirectory), w.before);
});

test('once the attempt\'s lease has run out, the same body under a new envelope still reaches recovery', async (t) => {
  const w = await pendingAfterDeadline(t);
  w.f.advance(JOURNAL_LEASE_MS);
  const recovered = await w.resend(NOW + JOURNAL_LEASE_MS);
  assert.deepEqual([recovered.status, recovered.body.error, recovered.body.cause], [503, 'operation_uncertain', 'context_recovery_held'], recovered.text);
  const after = charged(w.f.dataDirectory);
  assert.deepEqual(after.reservations.map(({ state }) => state), ['new', 'recover']);
  assert.deepEqual(after.journal.filter((name) => name.startsWith('o-')).map((name) => name.slice(name.lastIndexOf('-'))), ['-0', '-0.end', '-1'],
    'the lapsed attempt is ended and a recovery attempt is issued');
});
