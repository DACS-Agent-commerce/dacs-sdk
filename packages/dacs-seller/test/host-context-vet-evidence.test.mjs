// The seller host's Vet evidence for a fenced context row, on the composed host (`startSellerHost`). Compensation reads the row's two Vet
// addresses through the operator's artifact anchor: an address with no write, a Vet that landed (a present readback whose receipt is
// finalized and verifies) and a Vet the node refused that can never land end the row and release its slot; any other answer keeps the row
// compensating with its slot. Each way a row is fenced is covered: the startup sweep, a delegated request's fence at its expiry plus the
// 30,000 ms grace, a direct request's fence 300,000 ms after its admission, and a provider that fails by itself after a Vet write. The
// anchor is the fixture's local anchor answering the Vet addresses as the stock anchor does; the requests are signed HTTP exchanges over loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { compositeVerificationAddress, contentHash } from '@kynesyslabs/dacs';
import { deadRefusedCreate, provenUnsignedAbsence } from '../src/dacs/native-dem-delivery-consumer.mjs';
import { contextCapability, contextHostFixture } from './helpers/host-context-client.mjs';
import { signAnchorWrite } from './helpers/local-anchor-fixture.mjs';
import { JOB, NOW, buyer, seller } from './helpers/protocol-fixture.mjs';

const VET = 'CompositeVerificationRecord';
const SWEEP_INTERVAL_MS = 60_000, CONTEXT_DEADLINE_MS = 240_000;
const DELEGATION_LIFETIME_MS = 3_600_000, DELEGATION_GRACE_MS = 30_000, DIRECT_LIFETIME_MS = 300_000;
const ADDRESS = Object.freeze({ buyer: compositeVerificationAddress(JOB, buyer.claim), seller: compositeVerificationAddress(JOB, seller.claim) });
// The last statement of a sweep pass: its slot retirement read.
const SWEEP_END_SQL = /SELECT job FROM \(SELECT jobId AS job FROM kit_context_admissions WHERE state = 'settled'/;

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve)); };
// Waits for `entered`, and fails at once when the request ends first.
const reached = (entered, request) => Promise.race([entered.promise, request.then((answer) => { throw new Error(`TEST the request ended before the work was reached: ${answer.status} ${answer.text}`); })]);
async function until(predicate, what) {
  for (let waited = 0; waited < 20_000; waited += 5) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`TEST timed out waiting for ${what}`);
}

/** The job's admission row state, its private record and its allocation state, as the host's store holds them. */
function storeState(directory) {
  const db = new Database(join(directory, 'transport', 'transport.sqlite'), { readonly: true });
  try {
    const row = db.prepare('SELECT state, record FROM kit_context_admissions WHERE jobId = ?').get(JOB);
    const allocation = db.prepare('SELECT state FROM kit_allocations WHERE jobId = ?').get(JOB);
    return { row: row?.state ?? null, record: row ? JSON.parse(row.record) : null, allocation: allocation?.state ?? null };
  } finally { db.close(); }
}
const held = (directory) => { const { row, allocation } = storeState(directory); return [row, allocation]; };

/** Keeps the host's 60 s sweep timer; `sweep()` runs one periodic sweep and resolves once its pass has ended. */
function sweepDriver(t) {
  const callbacks = [], ends = { count: 0 };
  const setInterval = globalThis.setInterval, prepare = Database.prototype.prepare;
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...rest) => { if (ms === SWEEP_INTERVAL_MS) callbacks.push(callback); return setInterval(callback, ms, ...rest); });
  t.mock.method(Database.prototype, 'prepare', function (sql) { if (SWEEP_END_SQL.test(sql)) ends.count++; return prepare.call(this, sql); });
  return {
    async sweep() {
      const before = ends.count;
      callbacks.at(-1)();
      await until(() => ends.count > before, 'the end of the sweep pass');
      await flush();
    },
  };
}

/**
 * The fixture's native anchor, answering the two Vet addresses as the stock anchor does. `publish` makes the Vet write with the fate
 * `writes` gives its party: `landed` (anchored, its receipt finalized), `included` (anchored, its receipt not finalized but authentic, so
 * `verifyReceipt` answers valid), `refused` (the node refused the CREATE and its nonce has passed, so it can never land) or `unreadable` (the
 * readback has no answer). An address with no write reads as the proven unsigned absence when the read asks for that proof. `published`
 * lists the address of every Vet publish.
 */
function vetAnchor(f, writes) {
  const fates = new Map(Object.entries(writes).map(([party, fate]) => [ADDRESS[party], fate])), written = new Map(), published = [];
  const readVet = async (input) => {
    const fate = written.get(input.logicalAddress);
    if (fate === undefined) return input.proofOfNoIntent === true ? provenUnsignedAbsence('TEST no CREATE intent is kept for this address') : { status: 'absent', reason: 'TEST no CREATE intent' };
    if (fate === 'refused') return deadRefusedCreate('TEST the node refused the CREATE, its nonce has passed and it can no longer be included');
    if (fate === 'unreadable') return { status: 'indeterminate', reason: 'TEST the readback has no answer', noResend: true };
    return f.native.readRetained(input);
  };
  const publish = async (input) => {
    if (input?.artifactKind !== VET) return f.native.publish(input);
    const { logicalAddress, artifact } = input, fate = fates.get(logicalAddress);
    published.push(logicalAddress);
    if (fate === 'landed' || fate === 'included') {
      f.local.controls.state = fate === 'landed' ? 'finalized' : 'included';
      try { await f.local.write({ logicalAddress, artifact, writer: seller.claim, writerSignature: signAnchorWrite(seller.signBytes, logicalAddress, contentHash(artifact)) }); } finally { f.local.controls.state = 'finalized'; }
    }
    written.set(logicalAddress, fate);
    return readVet({ logicalAddress, artifactKind: VET });
  };
  const readRetained = (input, options) => (input?.artifactKind === VET ? readVet(input) : f.native.readRetained(input, options));
  const verifyReceipt = async (input) => (written.get(input?.logicalAddress) === 'included' && input.receipt?.state === 'included' ? 'valid' : f.native.verifyReceipt(input));
  return { anchor: { ...f.native, readRetained, publish, verifyReceipt }, published };
}

/**
 * A context provider that publishes the Vet records `writes` names through `anchor`, each after asking the attempt's predicate, and then
 * fails by itself; with `stall` it first waits on `gate`, so that the host's deadline or close ends the attempt. `seen` counts the host's calls.
 */
function vetProvider(anchor, writes, { stall }) {
  const gate = deferred(), entered = deferred(), seen = { resolves: 0, recovers: 0, resumes: 0 };
  const resolveBuyer = async (input, options) => {
    seen.resolves++;
    for (const party of Object.keys(writes)) {
      if (options.writable() !== true) throw Object.assign(new Error('TEST the purchase is no longer pending'), { code: 'not-pending' });
      await anchor.publish({ logicalAddress: ADDRESS[party], artifact: { TEST: 'vet-record', jobId: input.scope.jobId, party }, artifactKind: VET });
    }
    if (stall) { entered.resolve(); await gate.promise; }
    throw new Error('TEST the provider failed after its Vet write');
  };
  const recoverBuyer = async () => { seen.recovers++; return null; };
  const resumableBuyer = async () => { seen.resumes++; return null; };
  return { gate, entered, seen, capability: contextCapability({ resolveBuyer, recoverBuyer, resumableBuyer }) };
}

/** A started host over the stand-in anchor and provider, and its buyer; `direct` makes the buyer sign its own requests. */
async function vetHost(t, writes, { stall, direct = false }) {
  const f = await contextHostFixture(t), sweeps = sweepDriver(t);
  const vet = vetAnchor(f, writes), provider = vetProvider(vet.anchor, writes, { stall });
  const start = () => f.start({ artifactAnchor: vet.anchor, demDeliveryContext: provider.capability });
  const host = await start();
  return { f, sweeps, vet, provider, start, host, buyer: await f.buyerFor(host, { direct }) };
}

/** A provider that fails by itself after its Vet writes: the route ends the accepted row (trigger a) before it answers. */
async function failedStart(t, writes) {
  const w = await vetHost(t, writes, { stall: false });
  w.issued = await w.buyer.challenge();
  assert.equal(w.issued.status, 200, w.issued.text);
  const answer = await w.buyer.context(JOB, w.issued.body.sessionNonce);
  assert.equal(answer.status, 503, answer.text);
  assert.deepEqual(storeState(w.f.dataDirectory).record.vetAddresses, ADDRESS, 'the stand-in answers the row\'s own Vet addresses');
  assert.deepEqual(w.vet.published, Object.keys(writes).map((party) => ADDRESS[party]));
  return w;
}

/** A host stopped while its provider worked after its Vet writes leaves the row running; the next start's startup sweep fences it. */
async function stoppedHost(t, writes) {
  const w = await vetHost(t, writes, { stall: true });
  w.issued = await w.buyer.challenge();
  assert.equal(w.issued.status, 200, w.issued.text);
  const pending = w.buyer.context(JOB, w.issued.body.sessionNonce);
  await reached(w.provider.entered, pending);
  const closing = w.host.close();
  w.provider.gate.resolve();
  const answer = await pending;
  await closing;
  assert.equal(answer.status, 503, answer.text);
  assert.deepEqual(held(w.f.dataDirectory), ['running', 'live'], 'the stopped host leaves the row running with its slot');
  w.host = await w.start();
  w.buyer = await w.f.buyerFor(w.host);
  return w;
}

/** An attempt ended by the 240,000 ms context deadline after its Vet writes: the row stays running with its slot for the buyer's retry. */
async function deadlineLeftover(t, writes, direct) {
  const clock = { monotonic: 0 };
  t.mock.method(performance, 'now', () => clock.monotonic);
  const w = await vetHost(t, writes, { stall: true, direct });
  const issued = await w.buyer.challenge();
  assert.equal(issued.status, 200, issued.text);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = w.buyer.context(JOB, issued.body.sessionNonce);
  await reached(w.provider.entered, pending);
  clock.monotonic = CONTEXT_DEADLINE_MS;
  t.mock.timers.tick(CONTEXT_DEADLINE_MS);
  const answer = await pending;
  t.mock.timers.reset();
  assert.equal(answer.status, 503, answer.text);
  w.provider.gate.resolve();
  await flush();
  const { record } = storeState(w.f.dataDirectory);
  assert.deepEqual([record.state, record.admittedAt, record.delegationExpiresAt], ['running', NOW, direct ? null : NOW + DELEGATION_LIFETIME_MS]);
  assert.deepEqual(held(w.f.dataDirectory), ['running', 'live']);
  return w;
}

/** A periodic sweep 1 ms before the row's fence keeps it running with its slot; the sweep at the fence fences it. */
async function sweepAcrossFence(w, direct) {
  const fence = direct ? NOW + DIRECT_LIFETIME_MS : NOW + DELEGATION_LIFETIME_MS + DELEGATION_GRACE_MS;
  w.f.advance(fence - 1 - NOW);
  await w.sweeps.sweep();
  assert.deepEqual(held(w.f.dataDirectory), ['running', 'live'], 'a sweep 1 ms before the fence keeps the row running with its slot');
  w.f.advance(1);
  await w.sweeps.sweep();
}

// The Vet writes of each case, by party, with each write's fate, and the state a released row ends in: a landed Vet settles the row with
// no context outcome, and a Vet that can never land aborts it, as no write at all does.
const RELEASED = [
  { name: 'the seller Vet landed', writes: { seller: 'landed' }, ends: 'settled' },
  { name: 'the buyer Vet landed', writes: { buyer: 'landed' }, ends: 'settled' },
  { name: 'the node refused the seller Vet and it can never land', writes: { seller: 'refused' }, ends: 'aborted' },
];
const KEPT = [
  { name: 'the seller Vet reads back present with a receipt that is not finalized', writes: { seller: 'included' } },
  { name: 'the seller Vet readback has no answer', writes: { seller: 'unreadable' } },
];

for (const { name, writes, ends } of RELEASED) {
  test(`startup sweep, ${name}: the running row a stopped host left ends at the next start and its slot is released`, async (t) => {
    const w = await stoppedHost(t, writes);
    assert.deepEqual(held(w.f.dataDirectory), [ends, 'released']);
  });
  for (const [kind, direct] of [['delegated', false], ['direct', true]]) {
    test(`${kind} fence, ${name}: a row the context deadline left running ends at the sweep at its fence, not 1 ms before, and its slot is released`, async (t) => {
      const w = await deadlineLeftover(t, writes, direct);
      await sweepAcrossFence(w, direct);
      assert.deepEqual(held(w.f.dataDirectory), [ends, 'released']);
    });
  }
  test(`provider failure, ${name}: the provider's own failure after the Vet write ends the row and releases its slot`, async (t) => {
    const w = await failedStart(t, writes);
    assert.deepEqual(held(w.f.dataDirectory), [ends, 'released']);
  });
}

for (const { name, writes } of KEPT) {
  test(`startup sweep, ${name}: the fenced row stays compensating with its slot across the startup sweep and a periodic sweep`, async (t) => {
    const w = await stoppedHost(t, writes);
    assert.deepEqual(held(w.f.dataDirectory), ['compensating', 'live'], 'after the startup sweep');
    await w.sweeps.sweep();
    assert.deepEqual(held(w.f.dataDirectory), ['compensating', 'live'], 'after a periodic sweep');
  });
  for (const [kind, direct] of [['delegated', false], ['direct', true]]) {
    test(`${kind} fence, ${name}: the row fenced at its fence stays compensating with its slot across two sweeps`, async (t) => {
      const w = await deadlineLeftover(t, writes, direct);
      await sweepAcrossFence(w, direct);
      assert.deepEqual(held(w.f.dataDirectory), ['compensating', 'live'], 'after the sweep at the fence');
      w.f.advance(SWEEP_INTERVAL_MS);
      await w.sweeps.sweep();
      assert.deepEqual(held(w.f.dataDirectory), ['compensating', 'live'], 'after the next sweep');
    });
  }
  test(`provider failure, ${name}: the row the provider's own failure fenced stays compensating with its slot across two sweeps`, async (t) => {
    const w = await failedStart(t, writes);
    assert.deepEqual(held(w.f.dataDirectory), ['compensating', 'live'], 'after the failed start');
    await w.sweeps.sweep();
    await w.sweeps.sweep();
    assert.deepEqual(held(w.f.dataDirectory), ['compensating', 'live'], 'after two sweeps');
  });
}

// A Vet CREATE the node refused may be published again (`mayPublishAgain`), so a row ended on one must leave nothing on the host that could
// publish a replacement: no retry of the buyer's presentation (the request that resumes an unfinished context step), no new challenge, no
// later sweep and no restart may reach the provider or the anchor for that job again.
for (const [path, ended] of [['the provider\'s own failure', failedStart], ['the startup sweep', stoppedHost]]) {
  test(`a row ${path} ended on a Vet the node refused for good gets no replacement Vet from a retry, a new challenge, later sweeps or a restart`, async (t) => {
    const w = await ended(t, { seller: 'refused' });
    assert.deepEqual(held(w.f.dataDirectory), ['aborted', 'released'], 'the row ended on the refused Vet');
    const calls = () => ({ ...w.provider.seen, published: [...w.vet.published] });
    const before = calls();
    assert.deepEqual(before, { resolves: 1, recovers: 0, resumes: 0, published: [ADDRESS.seller] });
    const retry = async () => {
      const same = await w.buyer.context(JOB, w.issued.body.sessionNonce);
      assert.deepEqual([same.status, same.body.error], [409, 'context_admission_closed'], same.text);
      const again = await w.buyer.challenge();
      assert.deepEqual([again.status, again.body.error], [409, 'context_job_closed'], again.text);
    };
    await retry();
    await w.sweeps.sweep();
    await w.sweeps.sweep();
    await w.host.close();
    w.host = await w.start();
    w.buyer = await w.f.buyerFor(w.host);
    await retry();
    await w.sweeps.sweep();
    assert.deepEqual(calls(), before, 'the provider and the anchor were not reached for this job again');
    assert.deepEqual(held(w.f.dataDirectory), ['aborted', 'released']);
  });
}
