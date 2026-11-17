// The registered context provider handoff (capability callbacks, host accessor, one-shot retained-scope binding)
// and the context attempt's closed and deadline state. The admission transaction is a stand-in that answers
// runningCheck from one mutable row; its own fence is covered by context-admission-transaction.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { AGREEMENT_CONTEXT_SOURCE } from '../src/dacs/agreement-context-consumer.mjs';
import { createDemDeliveryContext, demDeliveryContextHost, resolveDemDeliverySellerContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { DEM_RAIL, purchaseSupport } from '../src/dacs/listing.mjs';
import { createContextAttempt, createSellerContextRecords } from '../src/dacs/seller-context-route.mjs';
import { SellerTransportError, sellerContextScopeHash } from '../src/dacs/seller-transport-auth.mjs';
import { createDevnetDemoAgreementContextProvider } from '../src/devnet-demo/agreement-context.mjs';
import { fixture, JOBS } from './helpers/bilateral-vet-fixture.mjs';
import { NOW, buyer, seller } from './helpers/protocol-fixture.mjs';

const [JOB] = JOBS;
const LEASE_UNTIL = NOW + 300_000;
const ATTEMPT = 1, REV = 3;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const options = (writable = () => true) => ({ writable, signal: new AbortController().signal });

// ---- the context attempt ------------------------------------------------------------------------------------------

// One attempt on fake wall and monotonic clocks; `row` is the admission row runningCheck reads.
function attemptWorld(t, { jobId = JOB, row = { attempt: ATTEMPT, rev: REV }, fakeTimers = true } = {}) {
  if (fakeTimers) t.mock.timers.enable({ apis: ['setTimeout'] });
  const clocks = { wall: NOW, monotonic: 0 }, checks = [];
  const admissionTransaction = { runningCheck: (...args) => { checks.push(args); return args[1] === row.attempt && args[2] === row.rev; } };
  const make = (over = {}) => createContextAttempt({ jobId, effect: { leaseUntil: LEASE_UNTIL }, capability: { attempt: ATTEMPT, rev: REV },
    admissionTransaction, now: () => clocks.wall, monotonicNow: () => clocks.monotonic, ...over });
  return { clocks, checks, row, make, tick: (ms) => t.mock.timers.tick(ms) };
}
const pending = () => { const work = deferred(); return { work, run: (attempt) => attempt.run(() => work.promise) }; };
const rejection = (promise) => promise.then(() => assert.fail('expected a rejection'), (error) => error);

test('creating an attempt requires the job id, and its predicate hands exactly that job id to the admission check', (t) => {
  const world = attemptWorld(t);
  for (const jobId of [undefined, null, 7, {}]) assert.throws(() => world.make({ jobId }), TypeError);
  const attempt = world.make();
  attempt.run(() => new Promise(() => {}));
  assert.equal(attempt.writable(), true);
  assert.deepEqual(world.checks, [[JOB, ATTEMPT, REV]]);
});

test('the attempt allows writes at 239999 ms and refuses them at 240000 ms before its timer has run', async (t) => {
  const world = attemptWorld(t), { work, run } = pending(), attempt = world.make();
  assert.equal(attempt.writable(), false, 'nothing may be written before the work has started');
  const { result } = run(attempt);
  world.clocks.monotonic = 239_999;
  assert.equal(attempt.writable(), true);
  assert.equal(world.checks.length, 1);
  world.clocks.monotonic = 240_000;
  assert.equal(attempt.writable(), false);
  assert.equal(world.checks.length, 1, 'a closed attempt asks the admission check nothing');
  const error = await rejection(result);
  assert.equal(error instanceof SellerTransportError && error.code, 'operation_uncertain');
  assert.equal(error.status, 503);
  assert.equal(error.cause.code, 'context_deadline');
  work.resolve('late');
});

test('the attempt refuses writes once the wire lease has passed, even inside its own deadline', async (t) => {
  const world = attemptWorld(t), { run } = pending(), attempt = world.make(), { result } = run(attempt);
  world.clocks.monotonic = 10;
  world.clocks.wall = LEASE_UNTIL;
  assert.equal(attempt.writable(), false);
  assert.equal((await rejection(result)).cause.code, 'context_deadline');
});

test('the attempt timer closes write authority at 240000 ms and the work keeps running until it settles', async (t) => {
  const world = attemptWorld(t), { work, run } = pending(), attempt = world.make(), { result, settled } = run(attempt);
  world.tick(239_999);
  assert.equal(attempt.writable(), true);
  world.clocks.monotonic = 240_000;
  world.tick(1);
  assert.equal((await rejection(result)).cause.code, 'context_deadline');
  assert.equal(attempt.writable(), false);
  let done = false;
  settled.then(() => { done = true; });
  await flush();
  assert.equal(done, false, 'settled waits for the actual work');
  work.resolve('finished');
  assert.deepEqual(await settled, { status: 'fulfilled', value: 'finished' });
});

test('after the deadline a late provider continuation finds the attempt closed and its old predicate stays false', async (t) => {
  const world = attemptWorld(t), work = deferred(), attempt = world.make(), seen = [];
  const { result, settled } = attempt.run(async (callOptions) => { await work.promise; seen.push(callOptions.writable(), callOptions.signal.aborted); return 'late'; });
  world.clocks.monotonic = 240_000;
  world.tick(240_000);
  await rejection(result);
  work.resolve();
  assert.deepEqual(await settled, { status: 'fulfilled', value: 'late' });
  assert.deepEqual(seen, [false, true]);
  assert.equal(world.checks.length, 0, 'the late continuation never reached the admission check');
  assert.equal(attempt.writable(), false);
  assert.equal(await rejection(result).then((error) => error.code), 'operation_uncertain', 'the late value does not replace the outcome');
  const successor = world.make({ capability: { attempt: ATTEMPT, rev: REV } });
  world.clocks.monotonic = 0;
  successor.run(() => new Promise(() => {}));
  assert.equal(successor.writable(), true, 'authority comes only from a new attempt');
});

test('closing an attempt keeps the first cause, aborts the signal and leaves a successor untouched', async (t) => {
  const world = attemptWorld(t), first = world.make(), second = world.make({ capability: { attempt: ATTEMPT + 1, rev: REV + 1 } });
  const stopped = new SellerTransportError('seller_stopped', 503), other = new Error('another cause');
  let signal;
  const { result } = first.run((callOptions) => { signal = callOptions.signal; return new Promise(() => {}); });
  second.run(() => new Promise(() => {}));
  first.close(stopped);
  first.close(other);
  assert.equal(await rejection(result), stopped);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, stopped);
  assert.equal(first.writable(), false);
  world.row.attempt = ATTEMPT + 1;
  world.row.rev = REV + 1;
  assert.equal(second.writable(), true);
  world.tick(239_999);
  assert.equal(second.writable(), true, 'closing the first attempt did not close the second');
  assert.deepEqual(world.checks, [[JOB, ATTEMPT + 1, REV + 1], [JOB, ATTEMPT + 1, REV + 1]]);
  assert.throws(() => first.run(() => 1), TypeError, 'an attempt runs once');
});

test('a rejected unit of work is observed on both the result and the settled status', async (t) => {
  const world = attemptWorld(t), attempt = world.make(), failure = new Error('provider failed');
  const { result, settled } = attempt.run(async () => { throw failure; });
  assert.equal(await rejection(result), failure);
  assert.deepEqual(await settled, { status: 'rejected', reason: failure });
});

test('a malformed wall or monotonic clock closes the attempt with a peer_clock_invalid refusal', async (t) => {
  const world = attemptWorld(t);
  for (const [clock, bad] of [['wall', Number.NaN], ['wall', -1], ['wall', 1.5], ['monotonic', Number.NaN], ['monotonic', -1]]) {
    world.clocks.wall = NOW;
    world.clocks.monotonic = 0;
    world.checks.length = 0;
    const attempt = world.make();
    let signal;
    const { result } = attempt.run((callOptions) => { signal = callOptions.signal; return new Promise(() => {}); });
    world.clocks[clock] = bad;
    assert.equal(attempt.writable(), false, `${clock} ${bad}`);
    const error = await rejection(result);
    assert.equal(error instanceof SellerTransportError && error.code, 'peer_clock_invalid');
    assert.equal(error.status, 503);
    assert.equal(signal.aborted, true);
    assert.equal(world.checks.length, 0);
  }
  const unreadable = world.make({ now: () => { throw new Error('clock unreadable'); } });
  assert.equal((await rejection(unreadable.run(() => new Promise(() => {})).result)).code, 'peer_clock_invalid');
});

// ---- the capability, its host accessor and the wrappers -------------------------------------------------------------

const callbacks = () => ({ resolveBuyer: async () => 'resolved', recoverBuyer: async () => 'recovered', resumableBuyer: async () => ({ writes: 1 }),
  bindRetainedScope: () => ({ sellerBundlePresentedBy: seller.claim }) });
const capabilityOf = (over = {}) => createDemDeliveryContext({ authority: 'TEST-handoff', resolveSeller: async () => null, ...callbacks(), ...over });

test('the capability refuses a callback that is not a function before it registers, and its descriptor shape is unchanged', () => {
  for (const key of ['recoverBuyer', 'resumableBuyer', 'bindRetainedScope']) {
    assert.throws(() => capabilityOf({ [key]: 'not a function' }), TypeError, key);
    assert.doesNotThrow(() => capabilityOf({ [key]: null }), key);
  }
  assert.deepEqual(Object.keys(capabilityOf()).sort(), ['authority', 'source']);
});

test('the host accessor refuses a copied descriptor, a null and a capability without the recovery callbacks', () => {
  const capability = capabilityOf();
  for (const value of [{ ...capability }, null, undefined, {}]) assert.throws(() => demDeliveryContextHost(value), TypeError);
  for (const key of ['recoverBuyer', 'resumableBuyer', 'bindRetainedScope']) {
    assert.throws(() => demDeliveryContextHost(capabilityOf({ [key]: null })), TypeError, key);
  }
  assert.deepEqual(Object.keys(demDeliveryContextHost(capability)).sort(), ['bindRetainedScope', 'recoverBuyer', 'resolveBuyer', 'resumableBuyer']);
});

test('the resolve, recover and resumable wrappers forward both argument objects untouched and refuse a missing predicate', async () => {
  const seen = [], failure = new Error('provider refused');
  const spy = (name, answer) => (...args) => { seen.push([name, args]); return typeof answer === 'function' ? answer() : answer; };
  const host = demDeliveryContextHost(capabilityOf({ resolveBuyer: spy('resolveBuyer', 'resolved'), recoverBuyer: spy('recoverBuyer', null),
    resumableBuyer: spy('resumableBuyer', () => { throw failure; }) }));
  const input = { scope: {} }, call = options();
  assert.equal(await host.resolveBuyer(input, call), 'resolved');
  assert.equal(await host.recoverBuyer(input, call), null);
  assert.equal(await rejection(host.resumableBuyer(input, call)), failure, 'the provider\'s own error comes back');
  assert.equal(seen.length, 3);
  for (const [, args] of seen) {
    assert.equal(args.length, 2);
    assert.equal(args[0], input);
    assert.equal(args[1], call);
  }
  seen.length = 0;
  const refused = [[input], [input, {}], [input, { writable: () => true }], [input, { writable: true, signal: call.signal }], [input, { writable: () => true, signal: {} }], [null, call], ['text', call]];
  for (const method of ['resolveBuyer', 'recoverBuyer', 'resumableBuyer']) {
    for (const args of refused) assert.ok(await rejection(host[method](...args)) instanceof TypeError, `${method} ${args.length}`);
  }
  assert.equal(seen.length, 0, 'no callback ran for a refused call');
});

test('the recover and resumable wrappers pass the attempt\'s writable predicate to the provider\'s callbacks', async () => {
  let open = true;
  const predicate = () => open, got = [];
  const host = demDeliveryContextHost(capabilityOf({ recoverBuyer: async (_input, call) => { got.push(call.writable); return call.writable(); },
    resumableBuyer: async (_input, call) => { got.push(call.writable); return call.writable() ? { writes: 2 } : null; } }));
  assert.equal(await host.recoverBuyer({}, options(predicate)), true);
  assert.deepEqual(await host.resumableBuyer({}, options(predicate)), { writes: 2 });
  open = false;
  assert.equal(await host.recoverBuyer({}, options(predicate)), false);
  assert.equal(await host.resumableBuyer({}, options(predicate)), null);
  assert.ok(got.every((value) => value === predicate));
});

test('the binder returns the provider\'s pinned seller presenter as frozen metadata and refuses anything else', () => {
  const f = fixture(), provider = createDevnetDemoAgreementContextProvider(f.config);
  const host = demDeliveryContextHost(createDemDeliveryContext({ authority: 'TEST-provenance', vetMode: provider.vetMode, resolveSeller: provider.resolveSeller,
    resolveBuyer: provider.resolveBuyer, recoverBuyer: provider.recoverBuyer, resumableBuyer: provider.resumableBuyer, bindRetainedScope: provider.bindRetainedScope }));
  const bound = host.bindRetainedScope(() => null);
  assert.deepEqual(bound, { sellerBundlePresentedBy: seller.claim });
  assert.equal(Object.isFrozen(bound), true);
  for (const answer of [null, undefined, {}, { sellerBundlePresentedBy: 7 }, { sellerBundlePresentedBy: '' }, 'text']) {
    const refusing = demDeliveryContextHost(capabilityOf({ bindRetainedScope: () => answer }));
    assert.throws(() => refusing.bindRetainedScope(() => null), TypeError, String(answer));
  }
  f.store.close();
});

// ---- the real provider composed through the registered capability ------------------------------------------------

// The scope the route admits, the admission row and completed outcome the records read, and the seller party row's key.
function contextWorld() {
  const f = fixture(), support = purchaseSupport(f.listing), { buyerIdentityBundle } = f.input(JOB);
  const scope = { source: AGREEMENT_CONTEXT_SOURCE, wallet: buyer.address, jobId: JOB, buyer: buyer.claim, buyerBundleHash: identityBundleHash(buyerIdentityBundle),
    seller: seller.claim, listingPin: f.pin, rail: { railId: DEM_RAIL.railId, railVersion: DEM_RAIL.railVersion }, payee: support.payee, price: support.price, generatedAt: NOW };
  const rows = new Map([[JOB, { jobId: JOB, buyer: buyer.claim, seller: seller.claim, listingPin: f.pin, contextScopeHash: sellerContextScopeHash(scope), state: 'admitted' }]]);
  const outcomes = new Map([[JOB, { status: 200, text: JSON.stringify({ disposition: 'present', value: { scope, input: { jobId: JOB } } }) }]]);
  const records = createSellerContextRecords({ listing: f.listing, admission: (jobId) => rows.get(jobId) ?? null, contextOutcome: (jobId) => outcomes.get(jobId) ?? null });
  const rowKey = `party-vet/${sha256Hex(canonicalize([seller.claim, JOB]))}`;
  const compose = (extra = {}) => {
    const provider = createDevnetDemoAgreementContextProvider({ ...f.config, ...extra });
    const capability = createDemDeliveryContext({ authority: 'TEST-composed', vetMode: provider.vetMode, resolveSeller: provider.resolveSeller, release: provider.release,
      resolveBuyer: provider.resolveBuyer, recoverBuyer: provider.recoverBuyer, resumableBuyer: provider.resumableBuyer, bindRetainedScope: provider.bindRetainedScope });
    return { provider, capability, host: demDeliveryContextHost(capability) };
  };
  return { f, scope, records, rowKey, compose, bundle: buyerIdentityBundle, request: { scope, buyerIdentityBundle },
    sellerRequest: { jobId: JOB, listing: f.listing, buyerBundle: buyerIdentityBundle, generatedAt: NOW },
    // A cut after both Vets were written and before the seller's answer was retained: only the records can name the scope.
    forgetSellerAnswer: () => f.store.update(rowKey, (row) => ({ ...row, seller: null })) };
}

test('the actual registered capability and provider compose the records: the agent and provider read the admitted request and the completed scope; the binding is one-shot', async () => {
  const world = contextWorld(), { f, records } = world, { host, capability } = world.compose();
  const exact = { jobId: JOB, buyerBundle: world.bundle, generatedAt: NOW };
  assert.equal(records.exactRequest(exact), true);
  assert.equal(records.exactRequest({ ...exact, generatedAt: NOW + 1 }), false);
  let reads = 0;
  const reader = (input) => { reads++; return records.completedScope(input); };
  host.bindRetainedScope(reader);
  const answer = await host.resolveBuyer(world.request, options());
  assert.equal(answer.disposition, 'present');
  await world.forgetSellerAnswer();
  const sellerContext = await resolveDemDeliverySellerContext(capability, world.sellerRequest);
  assert.equal(sellerContext.disposition, 'present');
  assert.equal(reads, 1, 'the provider\'s retained scope comes from the bound records');
  assert.throws(() => host.bindRetainedScope(() => null), TypeError, 'a second binding after the first request');
  await world.forgetSellerAnswer();
  assert.equal((await resolveDemDeliverySellerContext(capability, world.sellerRequest)).disposition, 'present');
  assert.equal(reads, 2, 'the first reader stays');
  f.store.close();
});

test('after a restart with empty provider caches, the seller\'s Agreement step recovers the completed context through the bound records', async () => {
  const world = contextWorld(), { f, records } = world;
  const first = world.compose();
  first.host.bindRetainedScope(records.completedScope);
  assert.equal((await first.host.resolveBuyer(world.request, options())).disposition, 'present');
  await world.forgetSellerAnswer();
  const signsBefore = f.controls.signs, writesBefore = f.local.writes.length;
  const restarted = world.compose();
  assert.equal(restarted.provider.contexts.size, 0);
  restarted.host.bindRetainedScope(records.completedScope);
  const recovered = await resolveDemDeliverySellerContext(restarted.capability, world.sellerRequest);
  assert.equal(recovered.disposition, 'present');
  assert.equal(recovered.vetRequirements.length > 0, true);
  assert.equal(f.controls.signs, signsBefore, 'no Vet signature');
  assert.equal(f.local.writes.length, writesBefore, 'no Vet write');
  f.store.close();
});

test('the retained scope reader is refused when set twice, after a request, or beside a constructor reader, and the reader in use stays', async () => {
  const world = contextWorld(), { f, records } = world;
  const bound = world.compose();
  bound.provider.bindRetainedScope(records.completedScope);
  assert.throws(() => bound.provider.bindRetainedScope(() => null), TypeError);
  assert.throws(() => bound.provider.bindRetainedScope('not a reader'), TypeError);
  const late = world.compose();
  await late.provider.resolveSeller({ jobId: JOB, listingPin: f.pin, buyerIdentityBundle: world.bundle, generatedAt: NOW });
  assert.throws(() => late.provider.bindRetainedScope(records.completedScope), TypeError, 'after the first request');
  const constructed = createDevnetDemoAgreementContextProvider({ ...f.config, retainedScope: () => null });
  assert.throws(() => constructed.bindRetainedScope(records.completedScope), TypeError, 'a reader was given at construction');
  f.store.close();
});

test('the resolve wrapper forwards the attempt\'s writable predicate: a fenced admission revision stops the next Vet signature and transmission', async (t) => {
  const world = contextWorld(), { f } = world, gate = deferred(), reached = deferred();
  const issueChallenge = async (input) => { reached.resolve(); await gate.promise; return f.counterparty.issueChallenge(input); };
  const { host } = world.compose({ counterparty: { ...f.counterparty, issueChallenge } });
  const attemptWorldState = attemptWorld(t, { fakeTimers: false }), attempt = attemptWorldState.make();
  const { result } = attempt.run((callOptions) => host.resolveBuyer(world.request, callOptions));
  await reached.promise;
  // The first Vet record is already signed and sent when the provider waits for the counterparty's challenge.
  const checksBeforeFence = attemptWorldState.checks.length, signsAtPause = f.controls.signs, intentsAtPause = f.local.rows.size, writesAtPause = f.local.writes.length;
  assert.ok(checksBeforeFence >= 1, 'the provider asked the predicate before it paused');
  assert.equal(signsAtPause, 1);
  attemptWorldState.row.rev = REV + 1;
  gate.resolve();
  await result.then(() => assert.fail('the fenced attempt must not answer'), () => {});
  assert.ok(attemptWorldState.checks.length > checksBeforeFence, 'the predicate was asked again after the pause');
  assert.equal(f.controls.signs, signsAtPause, 'no further Vet signature');
  assert.equal(f.local.rows.size, intentsAtPause, 'no further anchor intent');
  assert.equal(f.local.writes.length, writesAtPause, 'no further transmission');
  f.store.close();
});
