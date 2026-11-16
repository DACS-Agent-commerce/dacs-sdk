// The registered context provider handoff (capability callbacks, host accessor, one-shot retained-scope binding)
// and the context attempt's closed and deadline state. The admission transaction is a stand-in that answers
// runningCheck from one mutable row; its own fence is covered by context-admission-transaction.test.mjs.
// The last section serves a first context admission over HTTP on the wire, through the real admission transaction,
// purchase capacity, reservation coordinator and wire journal; its provider is a counting stand-in behind the
// registered capability (helpers/context-wire-world.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, identityBundleHash, sha256Hex } from '@kynesyslabs/dacs';
import { AGREEMENT_CONTEXT_SOURCE } from '../src/dacs/agreement-context-consumer.mjs';
import { createDemDeliveryContext, demDeliveryContextHost, resolveDemDeliverySellerContext } from '../src/dacs/dem-delivery-context-consumer.mjs';
import { DEM_RAIL, purchaseSupport } from '../src/dacs/listing.mjs';
import { createContextAttempt } from '../src/dacs/seller-context-attempt.mjs';
import { createSellerContextRecords } from '../src/dacs/seller-context-route.mjs';
import { SellerTransportError, sellerContextScopeHash } from '../src/dacs/seller-transport-auth.mjs';
import { createDevnetDemoAgreementContextProvider } from '../src/devnet-demo/agreement-context.mjs';
import * as guard from '../src/kit-operation-guard.mjs';
import { SellerAgentError } from '../src/dacs/seller-agent.mjs';
import { fixture, JOBS } from './helpers/bilateral-vet-fixture.mjs';
import { watchSql } from './helpers/challenge-route-fixture.mjs';
import { JOB as WIRE_JOB, JOB2 as WIRE_JOB2, T0, contextWireWorld } from './helpers/context-wire-world.mjs';
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

// ---- the context route on the wire: a first admission --------------------------------------------------------------------

const summary = (answer) => [answer.status, answer.body.error];
const REQUEST_BODY_LIMIT = 64 * 1024;
const DEADLINE_MS = 240_000;
const POLICY_DEADLINE_MS = 10_000;
const SKEW_MS = 600_000;

/** Nothing was started: no hold, no start, no Vet write, no journal file and no admission row. */
function assertNothingStarted(w) {
  assert.equal(w.counts.holds.length, 0, 'no hold');
  assert.equal(w.internals.admissionCounts().starts, 0, 'no start');
  assert.equal(w.counts.vetWrites, 0, 'no Vet write');
  assert.equal(w.journalFiles(), 0, 'no journal file');
  assert.equal(w.rowOf(), null, 'no admission row');
}
/** A refusal before the attempt: the challenge is still issued, and nothing was started. */
function assertConsumedNothing(w, nonce) {
  assert.equal(w.challengeOf(nonce).state, 'issued');
  assertNothingStarted(w);
}
const refusedWith = async (w, options, expected) => {
  const request = await w.startContext(options), answer = await w.post(request);
  assert.deepEqual(summary(answer), expected);
  return { request, answer };
};

test('one first admission makes exactly one validation, one hold, one counted start, two Vet writes and one completed outcome, and leaves no open hold', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext();
  const answer = await w.post(request);
  await w.settleJob();
  assert.equal(answer.status, 200);
  await request.verify(answer);
  assert.deepEqual([w.counts.validations, w.counts.holds.length, w.internals.admissionCounts().starts, w.counts.vetWrites], [1, 1, 1, 2]);
  assert.equal(w.operationOf(WIRE_JOB).state, 'completed');
  assert.equal(w.challengeOf(request.nonce).state, 'accepted');
  assert.deepEqual([w.rowOf().state, w.rowOf().contextOutcome], ['settled', 'success']);
  assert.deepEqual(w.openHolds(), []);
  assert.equal(w.journalFiles(), 4);
});

test('the context answer is present with its input and the request\'s scope', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext(), answer = await w.post(request);
  await w.settleJob();
  assert.deepEqual(Object.keys(answer.body).sort(), ['disposition', 'value']);
  assert.equal(answer.body.disposition, 'present');
  assert.deepEqual(Object.keys(answer.body.value).sort(), ['input', 'scope']);
  assert.deepEqual(answer.body.value.scope, request.scope);
  assert.equal(answer.body.value.input.jobId, WIRE_JOB);
});

test('a missing, expired, other-job or other-buyer delegation is refused with its own code before the attempt, leaving the nonce issued and nothing written', async (t) => {
  // The buyer refuses to sign under a delegation that does not fit, so the hostile envelopes are built by hand.
  const under = (delegationFor) => (w, request) => ({ ...request, ...w.envelope(request.payload, w.session, delegationFor(w)) });
  const cases = [
    ['missing', { requireDelegation: true, signOptions: { delegated: false } }, (w, request) => request, 'peer_delegation_required'],
    ['expired', {}, under((w) => w.delegationFor({ at: T0 - 120_000, lifetimeMs: 60_000 })), 'peer_delegation_expired'],
    ['other job', {}, under((w) => w.delegationFor({ jobId: WIRE_JOB2 })), 'peer_delegation_mismatch'],
    ['other buyer', {}, under((w) => w.delegationFor({ actor: w.other })), 'peer_delegation_mismatch'],
  ];
  for (const [name, { requireDelegation = false, signOptions }, hostile, code] of cases) {
    await t.test(name, async (t) => {
      const w = await contextWireWorld(t, { requireDelegation });
      const request = await w.startContext({ signOptions });
      const answer = await w.post(hostile(w, request));
      assert.equal(answer.body.error, code);
      assertConsumedNothing(w, request.nonce);
    });
  }
});

test('a first admission while not ready is refused seller_not_ready 503 and consumes nothing', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext();
  w.state.ready = () => false;
  const answer = await w.post(request);
  assert.deepEqual(summary(answer), [503, 'seller_not_ready']);
  await request.verify(answer);
  assertConsumedNothing(w, request.nonce);
});

test('a context request whose agreementHash is the challenge scope hash is peer_agreement_mismatch 409 and consumes nothing', async (t) => {
  const w = await contextWireWorld(t);
  const { request } = await refusedWith(w, { signOptions: { hash: sellerContextScopeHash(w.scopeFor()) } }, [409, 'peer_agreement_mismatch']);
  assertConsumedNothing(w, request.nonce);
});

test('a bundle that names another presenter under an issued nonce fails the challenge as an owning validation failure; the nonce cannot be reused', async (t) => {
  const w = await contextWireWorld(t);
  const { request } = await refusedWith(w, { presenter: w.other }, [409, 'peer_context_mismatch']);
  assert.deepEqual([w.challengeOf(request.nonce).state, w.challengeOf(request.nonce).failure.code], ['failed', 'peer_context_mismatch']);
  assert.equal(w.counts.validations, 0, 'the presenter is checked before the profile admission');
  assertNothingStarted(w);
  const again = await w.post(request);
  assert.deepEqual([...summary(again), again.body.cause], [409, 'context_challenge_failed', 'peer_context_mismatch']);
  const corrected = await w.startContext({ nonce: request.nonce });
  assert.deepEqual(summary(await w.post(corrected)), [409, 'context_challenge_consumed']);
  assertNothingStarted(w);
});

test('a refusal before the attempt leaves the challenge issued: another scope job, a scope job that is not canonical and a scope without all its members', async (t) => {
  const cases = [['peer_job_mismatch', (scope) => { scope.jobId = WIRE_JOB2; }], ['peer_job_invalid', (scope) => { scope.jobId = WIRE_JOB.toLowerCase(); }],
    ['peer_context_mismatch', (scope) => { delete scope.payee; }]];
  for (const [code, scopeChange] of cases) {
    const w = await contextWireWorld(t);
    const { request } = await refusedWith(w, { scopeChange }, [409, code]);
    assertConsumedNothing(w, request.nonce);
  }
});

test('duplicate members or lossy numbers in the context body are refused bad_json before any nonce consumption; an oversized body is 413', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext();
  const lossy = request.text.replace(`"generatedAt":${request.scope.generatedAt}`, '"generatedAt":9007199254740993');
  assert.notEqual(lossy, request.text);
  const cases = [['{"scope":{},"scope":{}}', 400, 'bad_json'], [lossy, 400, 'bad_json'], [`{"a":"${'x'.repeat(REQUEST_BODY_LIMIT)}"}`, 413, 'body_too_large']];
  for (const [text, status, code] of cases) {
    const answer = await w.post({ ...request, text });
    assert.deepEqual(summary(answer), [status, code]);
    assert.equal(answer.signature, undefined, 'refused before the envelope opened');
  }
  assertConsumedNothing(w, request.nonce);
});

test('a context request whose payload job is not canonical is peer_envelope_invalid 401 at opening, unsigned', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext({ signOptions: { delegated: false } });
  const answer = await w.post({ ...request, ...w.envelope({ ...request.payload, jobId: WIRE_JOB.toLowerCase() }, w.buyer) });
  assert.deepEqual(summary(answer), [401, 'peer_envelope_invalid']);
  assert.equal(answer.signature, undefined);
  assertConsumedNothing(w, request.nonce);
});

test('a context request while stopped is refused seller_stopped 503 before the attempt; a throwing predicate keeps its cause', async (t) => {
  const cases = [[() => true, undefined], [() => { throw new Error('TEST stop predicate failed'); }, 'stop_check_failed'], [() => 'yes', 'stop_check_invalid']];
  for (const [stop, cause] of cases) {
    const w = await contextWireWorld(t), request = await w.startContext();
    w.state.stop = stop;
    const answer = await w.post(request);
    assert.deepEqual([...summary(answer), answer.body.cause], [503, 'seller_stopped', cause]);
    assertConsumedNothing(w, request.nonce);
  }
});

test('attempt codes through the route: unknown, mismatched, expired, malformed, consumed and failed-again presentations', async (t) => {
  const refused = async (name, options, expected) => {
    const w = await contextWireWorld(t), request = await w.startContext(options);
    assert.deepEqual([name, ...summary(await w.post(request))], [name, ...expected]);
    assertNothingStarted(w);
  };
  await refused('unknown', { nonce: 'ab'.repeat(32) }, [409, 'context_challenge_mismatch']);
  await refused('malformed', { nonce: 'not a nonce' }, [409, 'context_challenge_mismatch']);
  await refused('mismatched', { scopeChange: (scope) => { scope.generatedAt += 1; } }, [409, 'context_challenge_mismatch']);
  const stale = await contextWireWorld(t), nonce = await stale.issue();
  stale.advance(SKEW_MS + 1);
  assert.deepEqual(summary(await stale.post(await stale.startContext({ nonce, scopeChange: (scope) => { scope.generatedAt = T0; } }))), [409, 'context_challenge_expired']);
  const failed = await contextWireWorld(t), bad = await failed.startContext({ presenter: failed.other });
  assert.deepEqual(summary(await failed.post(bad)), [409, 'peer_context_mismatch']);
  assert.deepEqual(summary(await failed.post(bad)), [409, 'context_challenge_failed']);
  assert.deepEqual(summary(await failed.post(await failed.startContext({ nonce: bad.nonce }))), [409, 'context_challenge_consumed']);
  for (const world of [stale, failed]) assertNothingStarted(world);
});

test('identical attempts in parallel, or a retry while the first validates, answer context_attempt_pending 503 and validate once', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext(), entered = deferred(), release = deferred();
  w.behaviour.admit = async () => { entered.resolve(); await release.promise; };
  const first = w.post(request);
  await entered.promise;
  assert.deepEqual(summary(await w.post(request)), [503, 'context_attempt_pending']);
  release.resolve();
  assert.equal((await first).status, 200);
  await w.settleJob();
  assert.deepEqual([w.counts.validations, w.counts.holds.length, w.internals.admissionCounts().starts], [1, 1, 1]);
});

test('a policy refusal while taking the hold aborts the intent and answers seller_budget_refused 409 with no journal file', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext();
  w.behaviour.policyReserve = async () => 'TEST over budget';
  const answer = await w.post(request);
  await w.settleJob();
  assert.deepEqual(summary(answer), [409, 'seller_budget_refused']);
  assert.equal(w.journalFiles(), 0);
  assert.deepEqual([w.rowOf().state, w.counts.vetWrites, w.openHolds().length], ['aborted', 0, 0]);
  assert.equal(w.challengeOf(request.nonce).failure.code, 'seller_budget_refused');
});

test('a Vet non-pass completes with its non-pass outcome and signs no Agreement', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext();
  const nonPass = { disposition: 'rejected', reason: 'buyer Vet decision: fail', code: 'party_vet_non_pass', errorClass: 'permanent' };
  w.behaviour.answer = async () => nonPass;
  const answer = await w.post(request);
  await w.settleJob();
  assert.deepEqual([answer.status, answer.body], [200, nonPass]);
  assert.deepEqual([w.rowOf().state, w.rowOf().contextOutcome], ['settled', 'vet-non-pass']);
  assert.equal(w.operationOf(WIRE_JOB).state, 'completed');
  assert.equal(w.counts.agreementSignatures, 0);
  assert.deepEqual(w.openHolds(), []);
});

test('a provider error after the reservation answers 503 operation_uncertain, writes no end record and completes nothing', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext();
  w.behaviour.provider = async () => { throw Object.assign(new Error('TEST provider failed'), { code: 'provider_failed' }); };
  const answer = await w.post(request);
  await w.settleJob();
  assert.deepEqual([...summary(answer), answer.body.cause], [503, 'operation_uncertain', 'provider_failed']);
  await request.verify(answer);
  assert.equal(w.operationOf(WIRE_JOB).state, 'pending', 'no end record');
  assert.equal(w.completions.length, 0);
});

test('a failed start after an accepted admission ends its row, releases its hold and slot, and a retry is admitted', async (t) => {
  // Room for one purchase: a second one is admitted only once the first one's slot is free.
  const oneSlot = { storeOptions: { maxRecords: 100 } };
  const allocationState = (w) => w.internals.db.prepare('SELECT state FROM kit_allocations WHERE jobId = ?').get(WIRE_JOB).state;
  const retryAdmitted = async (w) => assert.equal((await w.post(await w.startContext({ jobId: WIRE_JOB2 }))).status, 200);
  await t.test('a direct request that expires between its acceptance and the reservation', async (t) => {
    const monotonicBase = performance.now();
    let elapsedMs = 0;
    t.mock.method(performance, 'now', () => monotonicBase + elapsedMs);
    const w = await contextWireWorld(t, oneSlot), request = await w.startContext({ signOptions: { delegated: false, lifetimeMs: 20_000 } });
    const entered = deferred(), release = deferred();
    w.behaviour.policyReserve = async () => { entered.resolve(); await release.promise; return null; };
    const pending = w.post(request);
    await entered.promise;
    w.advance(20_000);
    elapsedMs = 20_000;
    release.resolve();
    assert.deepEqual(summary(await pending), [408, 'peer_expired']);
    await w.settleJob();
    assert.deepEqual([w.rowOf().state, w.openHolds().length, allocationState(w), w.counts.vetWrites, w.journalFiles()], ['aborted', 0, 'released', 0, 0]);
    await retryAdmitted(w);
  });
  await t.test('a reservation that fails with an uncoded error', async (t) => {
    const w = await contextWireWorld(t, oneSlot), request = await w.startContext();
    w.behaviour.beforeReserve = async () => { throw new Error('TEST the reservation failed'); };
    assert.deepEqual(summary(await w.post(request)), [503, 'operation_uncertain']);
    await w.settleJob();
    assert.deepEqual([w.rowOf().state, w.openHolds().length, allocationState(w), w.counts.vetWrites], ['aborted', 0, 'released', 0]);
    w.behaviour.beforeReserve = null;
    await retryAdmitted(w);
  });
  await t.test('a provider that fails before it signs anything', async (t) => {
    const w = await contextWireWorld(t, oneSlot), request = await w.startContext();
    w.behaviour.provider = async () => { throw Object.assign(new Error('TEST provider failed'), { code: 'provider_failed' }); };
    assert.deepEqual([...summary(await w.post(request))], [503, 'operation_uncertain']);
    await w.settleJob();
    assert.deepEqual([w.rowOf().state, w.openHolds().length, allocationState(w), w.completions.length], ['aborted', 0, 'released', 0]);
    w.behaviour.provider = null;
    await retryAdmitted(w);
  });
  await t.test('a provider that fails after its first Vet write keeps the hold and slot of a job whose effect is not ruled out', async (t) => {
    const w = await contextWireWorld(t, oneSlot), request = await w.startContext();
    w.behaviour.evidenceKind = 'signed';
    w.behaviour.afterFirstWrite = async () => { throw Object.assign(new Error('TEST provider failed'), { code: 'provider_failed' }); };
    assert.deepEqual([...summary(await w.post(request))], [503, 'operation_uncertain']);
    await w.settleJob();
    assert.deepEqual([w.rowOf().state, w.openHolds().length, allocationState(w), w.counts.vetWrites], ['compensating', 1, 'live', 1]);
  });
});

test('a held or malformed provider answer is never a final outcome: it stays open as operation_uncertain with the answer as its cause', async (t) => {
  const answers = [['absent', { disposition: 'absent', reason: 'TEST no context', code: 'context_absent' }], ['malformed', { disposition: 'present' }],
    ['another scope', (input) => ({ ...w0.presentAnswer(input), value: { ...w0.presentAnswer(input).value, scope: { ...input.scope, price: { ...input.scope.price, amount: '9' } } } })]];
  let w0;
  for (const [name, answer] of answers) {
    w0 = await contextWireWorld(t);
    const request = await w0.startContext();
    w0.behaviour.answer = async (input) => (typeof answer === 'function' ? answer(input) : answer);
    const reply = await w0.post(request);
    await w0.settleJob();
    assert.deepEqual([name, ...summary(reply)], [name, 503, 'operation_uncertain']);
    assert.deepEqual([w0.rowOf().state, w0.operationOf(WIRE_JOB).state, w0.completions.length], ['running', 'pending', 0], name);
  }
});

test('a barrier in one job\'s policy hold call does not delay another job\'s admission', async (t) => {
  const w = await contextWireWorld(t), first = await w.startContext(), second = await w.startContext({ jobId: WIRE_JOB2 });
  const entered = deferred(), release = deferred();
  w.behaviour.policyReserve = async (request) => { if (request.jobId === WIRE_JOB) { entered.resolve(); await release.promise; } return null; };
  const stalled = w.post(first);
  await entered.promise;
  assert.equal((await w.post(second)).status, 200);
  let done = false;
  void stalled.then(() => { done = true; });
  await flush();
  assert.equal(done, false);
  release.resolve();
  assert.equal((await stalled).status, 200);
});

test('the reservation takes the job\'s effect mutex once and the reservation coordinator reuses it', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext();
  let queued = null;
  w.behaviour.beforeReserve = async () => {
    // Another taker of the job's mutex queues behind the reservation's lease for as long as the coordinator runs.
    queued = false;
    void w.admission.jobEffectMutex(WIRE_JOB).run(() => { queued = true; });
    await flush();
  };
  assert.equal((await w.post(request)).status, 200);
  await w.settleJob();
  assert.equal(w.reserved.calls, 1);
  assert.equal(typeof w.reserved.ownerships[0].jobLease.release, 'function', 'the coordinator was handed the reservation\'s own lease');
  assert.equal(queued, true, 'the queued taker ran once the reservation released its lease');
  assert.equal(w.acquisitions.length, 1, 'the provider step takes its own, once');
});

test('with the guard off the context route answers kit_operation_guard_off before the attempt', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext();
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  guard.setKitOperationGuardForTest('off');
  const answer = await w.post(request);
  guard.setKitOperationGuardForTest('testnet-tp1');
  assert.deepEqual(summary(answer), [503, 'kit_operation_guard_off']);
  assertConsumedNothing(w, request.nonce);
});

// ---- the provider's deadline ---------------------------------------------------------------------------------------------

/** Runs one request whose provider stalls at `stallAt` ('start', 'after-first-write' or 'before-answer') until `release()`; returns the world, the pending post and the gate. */
async function stalledProvider(t, stallAt) {
  const w = await contextWireWorld(t), request = await w.startContext(), reached = deferred(), release = deferred();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stall = async () => { reached.resolve(); await release.promise; };
  if (stallAt === 'start') w.behaviour.provider = stall;
  if (stallAt === 'after-first-write') w.behaviour.afterFirstWrite = stall;
  if (stallAt === 'before-answer') w.behaviour.answer = async (input) => { await stall(); return w.presentAnswer(input); };
  const pending = w.post(request);
  await reached.promise;
  return { w, request, pending, release };
}
/** The deadline passes: the answer is a signed 503 operation_uncertain with its cause, and the hold and the open attempt are kept. */
async function passDeadline(t, { w, request, pending }, atMs = DEADLINE_MS) {
  w.tick(atMs);
  t.mock.timers.tick(atMs);
  const answer = await pending;
  assert.deepEqual([...summary(answer), answer.body.cause], [503, 'operation_uncertain', 'context_deadline']);
  await request.verify(answer);
  assert.equal(w.openHolds().length, 1, 'the hold is kept');
  assert.equal(w.operationOf(WIRE_JOB).state, 'pending', 'the attempt stays open');
}
/** After the late work ran out: no outcome, no end record, and the row still running. */
function assertNoOutcome(w) {
  assert.equal(w.completions.length, 0, 'nothing completed it');
  assert.notEqual(w.operationOf(WIRE_JOB).state, 'completed');
  assert.deepEqual([w.rowOf().state, w.rowOf().contextOutcome], ['running', null]);
}

test('a provider stalled before the first Vet signature: at 240,000 ms the attempt closes and answers 503 operation_uncertain with cause context_deadline; released later it signs nothing', async (t) => {
  const stalled = await stalledProvider(t, 'start'), { w, release } = stalled;
  await passDeadline(t, stalled);
  let freed = false;
  const probe = w.admission.jobEffectMutex(WIRE_JOB).run(() => { freed = true; });
  w.advance(300_000);
  await flush();
  assert.equal(freed, false, 'the mutex stays until the provider settles');
  release.resolve();
  await probe;
  await w.settleJob();
  assert.equal(w.counts.vetWrites, 0, 'released later it signs nothing');
  assertNoOutcome(w);
});

test('a provider stalled after a Vet record signature, before its transmission: the timeout closes the attempt and the late work transmits nothing', async (t) => {
  const stalled = await stalledProvider(t, 'after-first-write'), { w, release } = stalled;
  await passDeadline(t, stalled);
  assert.equal(w.counts.vetWrites, 1);
  release.resolve();
  await w.settleJob();
  assert.equal(w.counts.vetWrites, 1, 'the closed predicate refuses the second write');
  assertNoOutcome(w);
});

test('a provider stalled after dispatch with its answer lost: the timeout answers 503 and the late result neither completes nor overwrites the outcome', async (t) => {
  const stalled = await stalledProvider(t, 'before-answer'), { w, release } = stalled;
  await passDeadline(t, stalled);
  release.resolve();
  await w.settleJob();
  assert.equal(w.counts.vetWrites, 2, 'what was dispatched stays dispatched');
  assertNoOutcome(w);
});

test('a provider result at 239,999 ms completes normally', async (t) => {
  const { w, request, pending, release } = await stalledProvider(t, 'start');
  w.tick(DEADLINE_MS - 1);
  release.resolve();
  const answer = await pending;
  await w.settleJob();
  assert.equal(answer.status, 200);
  await request.verify(answer);
  assert.deepEqual([w.counts.vetWrites, w.completions.length, w.rowOf().state, w.rowOf().contextOutcome], [2, 1, 'settled', 'success']);
});

test('closing the attempts while a provider runs answers with the given cause, keeps the hold and the open attempt, and lets the late work sign nothing', async (t) => {
  const { w, request, pending, release } = await stalledProvider(t, 'start');
  w.route.closeAttempts(new SellerTransportError('seller_stopped', 503));
  const answer = await pending;
  assert.deepEqual(summary(answer), [503, 'seller_stopped']);
  await request.verify(answer);
  assert.deepEqual([w.openHolds().length, w.operationOf(WIRE_JOB).state], [1, 'pending']);
  release.resolve();
  await w.settleJob();
  assert.equal(w.counts.vetWrites, 0);
  assertNoOutcome(w);
});

// ---- the first validation ------------------------------------------------------------------------------------------------

const refusal = (code, status) => () => { throw new SellerAgentError(code, 'TEST refusal', status); };
const scopeCases = [
  ['source', (s) => { s.source = 'TEST other source'; }], ['wallet', (s, w) => { s.wallet = w.other.address; }], ['seller', (s, w) => { s.seller = w.other.claim; }],
  ['listingPin', (s) => { s.listingPin = { ...s.listingPin, version: 2 }; }], ['payee', (s, w) => { s.payee = w.other.address; }],
  ['price', (s) => { s.price = { ...s.price, amount: '2' }; }], ['rail', (s) => { s.rail = { ...s.rail, railVersion: 2 }; }], ['buyerBundleHash', (s) => { s.buyerBundleHash = '0'.repeat(64); }],
];

test('context first-validation gate × one failing check under an issued nonce', async (t) => {
  /** One failing check: the first answer, the challenge failed with its code, the same presentation refused again, and nothing started. */
  const failsWith = async (name, setup, expected, { options, stall = false } = {}) => {
    await t.test(name, async (t) => {
      const w = await contextWireWorld(t), request = await w.startContext({ candidate: true, ...options?.(w) });
      setup?.(w);
      let first;
      if (stall) {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const pending = w.post(request);
        await flush();
        t.mock.timers.tick(POLICY_DEADLINE_MS);
        first = await pending;
      } else first = await w.post(request);
      assert.deepEqual(summary(first), expected);
      assert.equal(w.challengeOf(request.nonce).state, 'failed');
      assert.equal(w.challengeOf(request.nonce).failure.code, expected[1]);
      const again = await w.post(request);
      assert.deepEqual([...summary(again), again.body.cause], [409, 'context_challenge_failed', expected[1]]);
      await w.settleJob();
      assertNothingStarted(w);
    });
  };
  for (const [field, change] of scopeCases) {
    await failsWith(`${field} alone`, null, [409, 'context_scope_invalid'], { options: (w) => ({ scopeChange: (scope) => change(scope, w) }) });
  }
  await failsWith('generatedAt outside the window', null, [409, 'context_generated_at'], { options: () => ({ scopeChange: (scope) => { scope.generatedAt = T0 - SKEW_MS - 1; } }) });
  await failsWith('Listing window', (w) => { w.behaviour.admit = refusal('listing_window_closed', 409); }, [409, 'listing_window_closed']);
  await failsWith('revocation', (w) => { w.behaviour.admit = refusal('listing_revoked', 409); }, [409, 'listing_revoked']);
  await failsWith('profile admission', (w) => { w.behaviour.admit = refusal('session_not_admitted', 409); }, [409, 'session_not_admitted']);
  await failsWith('buyer access closed', (w) => { w.policy.access = refusal('buyer_access_closed', 409); }, [409, 'buyer_access_closed']);
  await failsWith('buyer access refused asynchronously', (w) => { w.policy.access = async () => { throw Object.assign(new Error('TEST'), { code: 'buyer_access_closed' }); }; }, [409, 'buyer_access_closed']);
  await failsWith('buyer access rejected', (w) => { w.policy.access = async () => { throw new Error('TEST access read failed'); }; }, [503, 'session_admission_unavailable']);
  await failsWith('buyer access stalled for 10 s', (w) => { w.policy.access = () => new Promise(() => {}); }, [503, 'session_admission_unavailable'], { stall: true });
  await failsWith('known job false', (w) => { w.policy.known = async () => false; }, [409, 'context_job_unknown']);
  const control = await contextWireWorld(t), request = await control.startContext({ candidate: true });
  assert.equal((await control.post(request)).status, 200, 'the all-valid control succeeds');
});

test('a context request admitted live but expired when the reservation runs is refused peer_expired, starts no Vet work and ends its row', async (t) => {
  // The wire counts the time since its admission on the monotonic clock, which this test moves with the seller clock.
  const monotonicBase = performance.now();
  let elapsedMs = 0;
  t.mock.method(performance, 'now', () => monotonicBase + elapsedMs);
  const run = async (atMs) => {
    elapsedMs = 0;
    const w = await contextWireWorld(t), delegation = w.delegationFor({ lifetimeMs: 20_000 });
    const request = await w.startContext({ delegation, signOptions: { lifetimeMs: 20_000 } }), entered = deferred(), release = deferred();
    w.behaviour.policyReserve = async () => { entered.resolve(); await release.promise; return null; };
    const pending = w.post(request);
    await entered.promise;
    w.advance(atMs);
    elapsedMs = atMs;
    release.resolve();
    return { w, request, answer: await pending };
  };
  const { w, request, answer } = await run(20_000);
  assert.deepEqual(summary(answer), [408, 'peer_expired']);
  await request.verify(answer);
  await w.settleJob();
  assert.deepEqual([w.journalFiles(), w.counts.vetWrites, w.rowOf().state, w.counts.holds.length, w.openHolds().length, w.internals.admissionCounts().starts], [0, 0, 'aborted', 1, 0, 1]);
  const control = await run(19_999);
  assert.equal(control.answer.status, 200, 'the same barrier released a millisecond earlier completes');
});

test('every failure after the attempt fails the challenge it owns with its own code and status, and a validation lost with the process is closed at startup', async (t) => {
  await t.test('a coded refusal keeps its code and status', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    w.behaviour.admit = refusal('session_admission_unavailable', 503);
    assert.deepEqual(summary(await w.post(request)), [503, 'session_admission_unavailable']);
    assert.deepEqual({ ...w.challengeOf(request.nonce).failure, at: undefined }, { code: 'session_admission_unavailable', status: 503, at: undefined });
  });
  await t.test('an uncoded error is recorded and answered as operation_uncertain', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    w.behaviour.admit = async () => { throw new Error('TEST the admission read failed'); };
    assert.deepEqual(summary(await w.post(request)), [503, 'operation_uncertain']);
    assert.deepEqual([w.challengeOf(request.nonce).state, w.challengeOf(request.nonce).failure.code, w.challengeOf(request.nonce).failure.status], ['failed', 'operation_uncertain', 503]);
    assertNothingStarted(w);
  });
  await t.test('a validation lost with the process is closed as validator_lost by the next start, and its presentation cannot be tried again', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext(), entered = deferred();
    w.behaviour.admit = () => { entered.resolve(); return new Promise(() => {}); };
    void w.post(request);
    await entered.promise;
    assert.equal(w.challengeOf(request.nonce).state, 'attempted');
    w.restart();
    assert.equal(w.challenges().closeLostValidations(), 1);
    assert.deepEqual([w.challengeOf(request.nonce).state, w.challengeOf(request.nonce).failure.code], ['failed', 'validator_lost']);
  });
});

test('a hold that fails or is granted after its deadline leaves one holdId, starts nothing and releases the late hold once', async (t) => {
  await t.test('the policy call fails', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    w.behaviour.policyReserve = async () => { throw new Error('TEST policy down'); };
    assert.deepEqual(summary(await w.post(request)), [503, 'seller_budget_unavailable']);
    await w.settleJob();
    assert.deepEqual([w.counts.holds.length, w.rowOf().state, w.counts.vetWrites, w.journalFiles(), w.reserved.calls], [1, 'aborted', 0, 0, 0]);
  });
  await t.test('the policy call is granted after its 10 s deadline', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext(), entered = deferred(), release = deferred();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    w.behaviour.policyReserve = async () => { entered.resolve(); await release.promise; return null; };
    const pending = w.post(request);
    await entered.promise;
    t.mock.timers.tick(POLICY_DEADLINE_MS);
    assert.deepEqual(summary(await pending), [503, 'seller_budget_unavailable']);
    release.resolve();
    await w.settleJob();
    assert.deepEqual(w.counts.releases.map((release) => release.hold), [w.counts.holds[0].hold], 'the late hold is released by its own id, once');
    assert.deepEqual([w.rowOf().state, w.openHolds().length, w.counts.vetWrites, w.journalFiles(), w.reserved.calls], ['aborted', 0, 0, 0, 0]);
  });
});

test('a reservation that loses to compensation ends only its just-issued attempt and starts no work, and an unexpected recovery is ended null and answered session_admission_unavailable', async (t) => {
  await t.test('compensation fences the row before the reservation commits', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    let compensation;
    w.behaviour.beforeReserve = async () => { compensation = w.admission.compensate(WIRE_JOB, 'd'); await flush(); };
    assert.deepEqual(summary(await w.post(request)), [409, 'context_admission_closed']);
    await compensation;
    await w.settleJob();
    assert.deepEqual([w.counts.resolves, w.counts.vetWrites, w.operationOf(WIRE_JOB).state, w.completions.map((entry) => entry.outcome)], [0, 0, 'ended', [null]]);
    assert.deepEqual([w.rowOf().state, w.openHolds().length], ['aborted', 0]);
  });
  await t.test('an unexpected recovery is ended null under the lease and the row never goes back to admitted', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    w.behaviour.recover = true;
    const answer = await w.post(request);
    await w.settleJob();
    assert.deepEqual(summary(answer), [503, 'session_admission_unavailable']);
    assert.deepEqual(w.completions.map((entry) => entry.outcome), [null]);
    assert.deepEqual([w.rowOf().state, w.privateRow().attemptFence, w.openHolds().length, w.counts.resolves, w.counts.vetWrites], ['running', 'null-ended', 1, 0, 0]);
  });
  await t.test('a null end that cannot be published stays open as operation_uncertain', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    Object.assign(w.behaviour, { recover: true, nullEndFails: true });
    const answer = await w.post(request);
    await w.settleJob();
    assert.deepEqual(summary(answer), [503, 'operation_uncertain']);
    assert.deepEqual([w.rowOf().state, w.openHolds().length, w.counts.resolves], ['running', 1, 0]);
  });
});

test('the outcome is durable in the journal before the row settles or the hold is released, and a later pass settles from the journal and releases the original hold once without running the provider again', async (t) => {
  const w = await contextWireWorld(t), request = await w.startContext();
  w.behaviour.cutAfterPublish = true;
  const answer = await w.post(request);
  await w.settleJob();
  assert.deepEqual(summary(answer), [503, 'operation_uncertain']);
  assert.equal(w.operationOf(WIRE_JOB).state, 'completed', 'published first');
  assert.deepEqual([w.rowOf().state, w.counts.releases.length], ['running', 0], 'not settled and not released yet');
  w.behaviour.cutAfterPublish = false;
  await w.admission.sweep({ startup: false });
  assert.deepEqual([w.rowOf().state, w.rowOf().contextOutcome], ['settled', 'success']);
  assert.deepEqual(w.counts.releases.map((release) => release.hold), [w.counts.holds[0].hold]);
  assert.equal(w.counts.resolves, 1, 'the provider is not run again');
});

test('a first admission keeps the purchase tuple with its acceptance, a failed acceptance keeps none, and a job without its tuple is refused before new work', async (t) => {
  await t.test('the tuple is kept with the acceptance', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    assert.equal(w.wire.tuple(WIRE_JOB), null);
    assert.equal((await w.post(request)).status, 200);
    assert.deepEqual(w.wire.tuple(WIRE_JOB), w.wire.binding.profile);
  });
  await t.test('a failed acceptance rolls the tuple back', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    w.behaviour.failAcceptance = true;
    assert.deepEqual(summary(await w.post(request)), [503, 'operation_uncertain']);
    await w.settleJob();
    assert.deepEqual([w.wire.tuple(WIRE_JOB), w.rowOf().state, w.counts.vetWrites], [null, 'aborted', 0]);
  });
  await t.test('an existing job without its tuple is refused tp1_purchase_profile_mismatch 500 with cause missing before any new work', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    assert.equal((await w.post(request)).status, 200);
    await w.settleJob();
    w.internals.db.prepare('DELETE FROM kit_purchase_profiles WHERE job = ?').run(WIRE_JOB);
    const before = { holds: w.counts.holds.length, files: w.journalFiles(), reserves: w.reserved.calls, challenge: w.challengeOf(request.nonce) };
    const sql = watchSql(t);
    const answer = await w.post(request);
    assert.deepEqual([...summary(answer), answer.body.cause], [500, 'tp1_purchase_profile_mismatch', 'missing']);
    assert.equal(sql.writes(), 0);
    assert.deepEqual({ holds: w.counts.holds.length, files: w.journalFiles(), reserves: w.reserved.calls, challenge: w.challengeOf(request.nonce) }, before);
  });
});

test('a job that keeps no purchase tuple because it is pending its hold, aborted or retired is answered with a signed refusal and writes nothing', async (t) => {
  const answeredWithoutWrite = async (t, w, request, expected) => {
    const sql = watchSql(t), answer = await w.post(request);
    assert.deepEqual(summary(answer), expected);
    await request.verify(answer);
    assert.equal(sql.writes(), 0, 'no write statement');
    assert.equal(w.wire.tuple(WIRE_JOB), null);
  };
  await t.test('its policy hold is still pending', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext(), entered = deferred(), release = deferred();
    w.behaviour.policyReserve = async () => { entered.resolve(); await release.promise; return null; };
    const first = w.post(request);
    await entered.promise;
    assert.equal(w.rowOf().state, 'intent');
    await answeredWithoutWrite(t, w, request, [503, 'context_attempt_pending']);
    release.resolve();
    assert.equal((await first).status, 200);
  });
  await t.test('it was aborted before its acceptance', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    w.behaviour.policyReserve = async () => 'TEST over budget';
    assert.deepEqual(summary(await w.post(request)), [409, 'seller_budget_refused']);
    await w.settleJob();
    assert.equal(w.rowOf().state, 'aborted');
    await answeredWithoutWrite(t, w, request, [409, 'context_job_closed']);
  });
  await t.test('it was fenced before its acceptance and its cleanup is still open', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    w.behaviour.evidenceKind = 'signed';
    w.behaviour.policyReserve = async () => 'TEST over budget';
    assert.deepEqual(summary(await w.post(request)), [409, 'seller_budget_refused']);
    await w.settleJob();
    assert.deepEqual([w.rowOf().state, w.rowOf().admittedAt], ['compensating', null]);
    await answeredWithoutWrite(t, w, request, [409, 'context_job_closed']);
  });
  await t.test('it was retired after it settled', async (t) => {
    const w = await contextWireWorld(t), request = await w.startContext();
    assert.equal((await w.post(request)).status, 200);
    await w.settleJob();
    w.internals.db.prepare('DELETE FROM kit_purchase_profiles WHERE job = ?').run(WIRE_JOB);
    w.internals.db.prepare('INSERT INTO kit_slot_retirements(job, job_retired, context_retired) VALUES (?, 1, 1)').run(WIRE_JOB);
    await answeredWithoutWrite(t, w, request, [409, 'context_job_closed']);
  });
});

test('a first admission over the hourly start limit is refused unpaid_start_limit 429 and takes no hold', async (t) => {
  const w = await contextWireWorld(t, { storeOptions: { contextStartLimits: { maxStartsPerHour: 1, maxStartsPerBuyerPerHour: 1 } } });
  const request = await w.startContext();
  w.seedContextRecord();
  assert.deepEqual(summary(await w.post(request)), [429, 'unpaid_start_limit']);
  assert.equal(w.challengeOf(request.nonce).failure.code, 'unpaid_start_limit');
  assert.deepEqual([w.counts.holds.length, w.rowOf(), w.journalFiles(), w.counts.vetWrites], [0, null, 0, 0]);
});

const admittedForms = [
  ['plain', {}],
  ['top-level extension members signature and signatures on the presented bundle', { bundleChange: (bundle) => { bundle.signature = 'extension'; bundle.signatures = ['extension']; } }],
  ['scope and bundle members in a non-canonical key order', { bodyChange: (body) => { for (const key of ['scope', 'buyerIdentityBundle']) body[key] = Object.fromEntries(Object.entries(body[key]).reverse()); } }],
  ['generatedAt exactly 600,000 ms before the seller clock', { scopeChange: (scope) => { scope.generatedAt = T0 - SKEW_MS; } }],
  ['generatedAt exactly 600,000 ms after the seller clock', { scopeChange: (scope) => { scope.generatedAt = T0 + SKEW_MS; } }],
];

test('first admission accepts every form the admission admits: extension members, key order and generatedAt exactly 600,000 ms away', async (t) => {
  for (const [name, options] of admittedForms) {
    await t.test(name, async (t) => {
      const w = await contextWireWorld(t), request = await w.startContext({ candidate: true, ...options }), answer = await w.post(request);
      await w.settleJob();
      assert.equal(answer.status, 200, answer.text);
      assert.deepEqual([w.counts.vetWrites, w.completions.length, w.rowOf().state, w.openHolds().length], [2, 1, 'settled', 0]);
    });
  }
  const w = await contextWireWorld(t), request = await w.startContext({ candidate: true, scopeChange: (scope) => { scope.generatedAt = T0 + SKEW_MS + 1; } });
  assert.deepEqual(summary(await w.post(request)), [409, 'context_generated_at']);
  assertNothingStarted(w);
});
