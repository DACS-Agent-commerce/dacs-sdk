// The challenge and context routes on the composed host (`startSellerHost`): the mount, its order against the startup sweep, and the host's
// drain of provider work that outlives its answer. The provider is a counting stand-in behind the registered capability; the requests are
// real signed HTTP exchanges over loopback, on fake timers where a deadline matters.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { Server } from 'node:http';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { HOST_CONTEXT_CALLBACKS } from './helpers/host-context-callbacks.mjs';
import { contextCapability, contextHostFixture, presentContextAnswer } from './helpers/host-context-client.mjs';
import { JOB } from './helpers/protocol-fixture.mjs';

const OTHER_JOB = '01J8N4YV7YVYQ4DB7M8T4C7W0B';
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
        const stateAtAnswer = admissionState(f.dataDirectory);

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
        assert.equal(admissionState(f.dataDirectory), stateAtAnswer, 'the settled work completed nothing');
        await (await f.start()).close();
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
